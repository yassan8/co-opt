import { useCallback, useEffect, useRef, useState } from 'react';
import { PSFPlotter } from '../../evaluation/psf/psf-plot.ts';
import { calculateImageSpaceDiffractionParams } from '../../raytracing/core/ray-paraxial.ts';
import { detectConjugateType } from '../../utils/conjugate-detection.ts';
import { runNativeGridDistortion } from '../desktop/ipc/client.ts';
import {
  ANALYSIS_PUPIL_SAMPLING_OPTIONS,
  AnalysisGridSamplingField,
} from './AnalysisGridSamplingField';
import { normalizeDistortionObjectRows } from './DistortionAnalysisPage';
import {
  computeFieldPsf,
  type ZeroPadMode,
} from './MultiFieldPsfPage';
import {
  buildWavelengthEntries,
  buildWavelengthOptions,
  createCancelToken,
  getBestHost,
  getPrimaryWavelength,
  getRows,
  raceWithCancel,
  throwIfCancelled,
  type CancelToken,
  type SelectOption,
} from './PsfAnalysisPage';
import {
  buildMultiFieldPsfGrid,
  buildMultiFieldPsfObjectRow,
  deriveMultiFieldPsfFieldDefinition,
  getMultiFieldPsfLocalToGlobalRotationDeg,
} from './multi-field-psf-model';
import {
  calculateImageSimulationDifferencePercent,
  calculateMaxLateralChromaticDisplacementUm,
  combineImageSimulationSpectralLayers,
  getImageSimulationTargetNominalMaxFrequencyLpmm,
  convolveImageSpatiallyVarying,
  createImageSimulationDifference,
  generateImageSimulationTargetSvg,
  rasterizeImageSimulationTargetSvg,
  resolveImageSimulationRasterExtent,
  getImageSimulationPhysicalExtent,
  resamplePsfToImageKernel,
  warpImageWithDistortion,
  type ImageSimulationDistortionMap,
  type ImageSimulationFieldKernel,
  type ImageSimulationImage,
  type ImageSimulationTargetKind,
  type ImageSimulationScaleMode,
} from './image-simulation-model';

type SimulationMode = 'full' | 'distortion' | 'psf';
type ComparisonMode = 'wipe' | 'side-by-side' | 'difference';

type SimulationSummary = {
  backend: string;
  conjugateType: 'finite' | 'infinite';
  psfFields: number;
  failedFields: number;
  distortionPoints: number;
  unreachedDistortionPoints: number;
  distortionMapsWithUnreached: number;
  imagePixelPitchXUm: number;
  imagePixelPitchYUm: number;
  maxDistortionPercent: number;
  differencePercent: number;
  elapsedMs: number;
  spectralLayers: number;
  distortionMaps: number;
  maxLateralChromaticUm: number;
  scaleMode: ImageSimulationScaleMode;
  fieldWidthMm: number;
  fieldHeightMm: number;
  rasterWidthMm: number;
  rasterHeightMm: number;
  primaryWavelengthUm: number;
  focalLengthMm: number;
  workingFNumber: number;
  airyDiameterUm: number;
  airyDiameterPixels: number;
  nyquistLpmm: number;
  cutoffLpmm: number;
  diffractionMtfAtNyquist: number;
  chartFrequencyLpmm: number | null;
  diffractionMtfAtChart: number;
};

function CanvasImage({
  image,
  className = '',
  label,
}: {
  image: ImageSimulationImage | null;
  className?: string;
  label: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0);
  }, [image]);
  return <canvas ref={ref} className={className} role="img" aria-label={label} />;
}

function ComparisonViewer({
  original,
  simulated,
  difference,
  mode,
  split,
  onSplitChange,
}: {
  original: ImageSimulationImage | null;
  simulated: ImageSimulationImage | null;
  difference: ImageSimulationImage | null;
  mode: ComparisonMode;
  split: number;
  onSplitChange: (value: number) => void;
}) {
  if (!original) {
    return <div className="image-simulation-empty"><strong>Image Simulation</strong><span>Select a source and run the simulation.</span></div>;
  }
  if (mode === 'side-by-side') {
    return (
      <div className="image-simulation-side-by-side">
        <figure><figcaption>Original</figcaption><CanvasImage image={original} label="Original source image" /></figure>
        <figure><figcaption>Simulated</figcaption><CanvasImage image={simulated || original} label="Simulated optical image" /></figure>
      </div>
    );
  }
  if (mode === 'difference') {
    return (
      <div className="image-simulation-single">
        <span className="image-simulation-canvas-label">Difference ×3</span>
        <CanvasImage image={difference || original} label="Difference between original and simulated image" />
      </div>
    );
  }
  return (
    <div className="image-simulation-wipe" style={{ '--image-simulation-split': split + '%' } as React.CSSProperties}>
      <CanvasImage image={simulated || original} className="image-simulation-wipe__canvas" label="Simulated optical image" />
      <div className="image-simulation-wipe__result">
        <CanvasImage image={original} className="image-simulation-wipe__canvas" label="Original source image" />
      </div>
      <span className="image-simulation-wipe__divider" aria-hidden="true" />
      <input
        className="image-simulation-wipe__slider"
        type="range"
        min={0}
        max={100}
        value={split}
        aria-label="Reveal original image over simulated image"
        onChange={(event) => onSplitChange(Number(event.currentTarget.value))}
      />
    </div>
  );
}

async function loadUploadedImage(file: File, maxDimension: number): Promise<ImageSimulationImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas is unavailable.');
    context.fillStyle = '#020617';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const imageData = context.getImageData(0, 0, width, height);
    return { width, height, rgba: new Uint8ClampedArray(imageData.data) };
  } finally {
    bitmap.close();
  }
}

function calculateMaxDistortionPercent(map: ImageSimulationDistortionMap): number {
  const extent = getImageSimulationPhysicalExtent(map);
  const halfDiagonal = Math.max(1e-12, Math.hypot(extent.widthMm, extent.heightMm) / 2);
  let maxDisplacement = 0;
  const count = Math.min(map.idealX.length, map.idealY.length, map.realX.length, map.realY.length);
  for (let index = 0; index < count; index += 1) {
    const idealX = Number(map.idealX[index]);
    const idealY = Number(map.idealY[index]);
    const realXValue = map.realX[index];
    const realYValue = map.realY[index];
    const realX = typeof realXValue === 'number' ? realXValue : Number.NaN;
    const realY = typeof realYValue === 'number' ? realYValue : Number.NaN;
    if (![idealX, idealY, realX, realY].every(Number.isFinite)) continue;
    maxDisplacement = Math.max(maxDisplacement, Math.hypot(realX - idealX, realY - idealY));
  }
  return maxDisplacement / halfDiagonal * 100;
}
function summarizeDistortionReachability(maps: ImageSimulationDistortionMap[]) {
  let total = 0;
  let unreached = 0;
  let mapsWithUnreached = 0;
  for (const map of maps) {
    const count = Math.min(map.idealX.length, map.idealY.length, map.realX.length, map.realY.length);
    let mapUnreached = 0;
    for (let index = 0; index < count; index += 1) {
      const realX = map.realX[index];
      const realY = map.realY[index];
      if (
        typeof realX !== 'number' || !Number.isFinite(realX)
        || typeof realY !== 'number' || !Number.isFinite(realY)
      ) mapUnreached += 1;
    }
    total += count;
    unreached += mapUnreached;
    if (mapUnreached > 0) mapsWithUnreached += 1;
  }
  return { total, unreached, mapsWithUnreached };
}

function scaleFieldExtentForDistortionGrid(value: number, mode: string): number {
  const magnitude = Math.abs(Number(value) || 0);
  if (!(magnitude > 0)) return 0;
  if (mode === 'angle') {
    return Math.atan(Math.tan(magnitude * Math.PI / 180) * Math.SQRT2 / 2) * 180 / Math.PI;
  }
  return magnitude * Math.SQRT2 / 2;
}

function normalizeFieldCoordinateForImage(value: number, maximum: number, mode: string): number {
  if (!(maximum > 0)) return 0;
  if (mode === 'angle') {
    const denominator = Math.tan(maximum * Math.PI / 180);
    return Math.abs(denominator) > 1e-12
      ? Math.tan(Number(value) * Math.PI / 180) / denominator
      : 0;
  }
  return Number(value) / maximum;
}

function calculateCircularDiffractionMtf(normalizedFrequency: number): number {
  const rawFrequency = Number(normalizedFrequency);
  const frequency = Number.isFinite(rawFrequency) ? Math.max(0, rawFrequency) : Number.NaN;
  if (frequency >= 1) return 0;
  if (frequency <= 0) return 1;
  return 2 / Math.PI * (Math.acos(frequency) - frequency * Math.sqrt(1 - frequency * frequency));
}

export function ImageSimulationPage() {
  const cancelRef = useRef<CancelToken | null>(null);
  const [sourceKind, setSourceKind] = useState<ImageSimulationTargetKind | 'upload'>('optical-showcase');
  const [simulationMode, setSimulationMode] = useState<SimulationMode>('full');
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('wipe');
  const [outputSize, setOutputSize] = useState(1536);
  const [fieldGridSize, setFieldGridSize] = useState(5);
  const [samplingSize, setSamplingSize] = useState(32);
  const [zeroPad, setZeroPad] = useState<ZeroPadMode>('none');
  const [kernelSize, setKernelSize] = useState(21);
  const [scaleMode, setScaleMode] = useState<ImageSimulationScaleMode>('field-fit');
  const [sensorWidthMm, setSensorWidthMm] = useState('36');
  const [sensorHeightMm, setSensorHeightMm] = useState('24');
  const [pixelPitchUm, setPixelPitchUm] = useState('2.0');
  const [wavelengthOptions, setWavelengthOptions] = useState<SelectOption[]>([{ value: 'all', label: 'All wavelengths' }]);
  const [wavelength, setWavelength] = useState('all');
  const [sourceImage, setSourceImage] = useState<ImageSimulationImage | null>(null);
  const [sourceSvg, setSourceSvg] = useState<string | null>(null);
  const [simulatedImage, setSimulatedImage] = useState<ImageSimulationImage | null>(null);
  const [differenceImage, setDifferenceImage] = useState<ImageSimulationImage | null>(null);
  const [split, setSplit] = useState(50);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<SimulationSummary | null>(null);


  const refreshWavelengths = useCallback(() => {
    const host = getBestHost();
    const sourceRows = getRows(host, 'source');
    const options = buildWavelengthOptions(host, sourceRows);
    setWavelengthOptions(options);
    setWavelength((current) => options.some((option) => option.value === current) ? current : 'all');
  }, []);

  useEffect(() => {
    document.title = 'Image Simulation';
    refreshWavelengths();
    const refresh = () => refreshWavelengths();
    window.addEventListener('coopt:source-data-updated', refresh);
    window.addEventListener('coopt:configuration-changed', refresh);
    return () => {
      cancelRef.current?.abort('Image Simulation closed');
      window.removeEventListener('coopt:source-data-updated', refresh);
      window.removeEventListener('coopt:configuration-changed', refresh);
    };
  }, [refreshWavelengths]);

  useEffect(() => {
    if (sourceKind === 'upload') {
      setSourceSvg(null);
      return;
    }
    let disposed = false;
    const svg = generateImageSimulationTargetSvg(sourceKind);
    setSourceSvg(svg);
    setSourceImage(null);
    setSimulatedImage(null);
    setDifferenceImage(null);
    setSummary(null);
    setError('');
    void rasterizeImageSimulationTargetSvg(svg, outputSize).then((generated) => {
      if (disposed) return;
      setSourceImage(generated);
    }).catch((caught: any) => {
      if (disposed) return;
      setError(String(caught?.message || caught || 'Vector target rasterization failed'));
    });
    return () => { disposed = true; };
  }, [outputSize, sourceKind]);

  const handleUpload = useCallback(async (file: File | null) => {
    if (!file) return;
    try {
      setError('');
      const image = await loadUploadedImage(file, outputSize);
      setSourceSvg(null);
      setSourceImage(image);
      setSimulatedImage(null);
      setDifferenceImage(null);
      setSummary(null);
    } catch (caught: any) {
      setError(String(caught?.message || caught || 'Image load failed'));
    }
  }, [outputSize]);

  const downloadSourceSvg = useCallback(() => {
    if (!sourceSvg || sourceKind === 'upload') return;
    const fileName = sourceKind === 'optical-showcase'
      ? 'co-opt-usaf-1951-radial-grid.svg'
      : sourceKind === 'field-chart'
        ? 'co-opt-calibrated-camera-resolution-target.svg'
      : sourceKind === 'usaf-array'
        ? 'co-opt-usaf-field-array.svg'
        : 'co-opt-grid-point-field.svg';
    const blob = new Blob([sourceSvg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }, [sourceKind, sourceSvg]);
  const downloadSimulatedPng = useCallback(async () => {
    if (!simulatedImage || busy) return;
    try {
      setError('');
      const canvas = document.createElement('canvas');
      canvas.width = simulatedImage.width;
      canvas.height = simulatedImage.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas is unavailable.');
      context.putImageData(
        new ImageData(simulatedImage.rgba, simulatedImage.width, simulatedImage.height),
        0,
        0,
      );
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => {
          if (value) resolve(value);
          else reject(new Error('PNG encoding failed.'));
        }, 'image/png');
      });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'co-opt-simulated-' + simulatedImage.width + 'x' + simulatedImage.height + '.png';
        anchor.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (caught: any) {
      setError(String(caught?.message || caught || 'Simulated image save failed'));
    }
  }, [busy, simulatedImage]);
  const run = useCallback(async () => {
    if (busy || !sourceImage) return;
    cancelRef.current?.abort('Replaced by a new simulation');
    const token = createCancelToken();
    cancelRef.current = token;
    setBusy(true);
    setError('');
    setProgress(1);
    setProgressText('Preparing wavelength-resolved image simulation...');
    const startedAt = performance.now();

    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const host = getBestHost();
      const opticalRows = getRows(host, 'optical');
      const objectRows = getRows(host, 'object');
      const sourceRows = getRows(host, 'source');
      if (!opticalRows.length) throw new Error('No optical system data.');
      const conjugateType = detectConjugateType(opticalRows);
      if (!objectRows.length) throw new Error('No field data.');

      const normalizedObjectRows = normalizeDistortionObjectRows(objectRows, opticalRows, sourceRows);
      const requestedSensorWidthMm: number | undefined = scaleMode === 'sensor-width'
        ? Math.abs(Number(sensorWidthMm))
        : scaleMode === 'pixel-pitch' ? Math.abs(Number(pixelPitchUm)) * sourceImage.width / 1000 : undefined;
      const requestedSensorHeightMm: number | undefined = scaleMode === 'sensor-width'
        ? Math.abs(Number(sensorHeightMm))
        : scaleMode === 'pixel-pitch' ? Math.abs(Number(pixelPitchUm)) * sourceImage.height / 1000 : undefined;
      if (scaleMode !== 'field-fit' && (!(Number.isFinite(requestedSensorWidthMm) && requestedSensorWidthMm! > 1e-9) || !(Number.isFinite(requestedSensorHeightMm) && requestedSensorHeightMm! > 1e-9))) {
        throw new Error(scaleMode === 'sensor-width' ? 'Sensor width and height must be greater than zero.' : 'Pixel pitch must be greater than zero.');
      }
      const primaryWavelength = getPrimaryWavelength(host, sourceRows);
      const wavelengthEntries = buildWavelengthEntries(wavelength, sourceRows, primaryWavelength);
      const wavelengthKey = (value: number) => Number(value).toFixed(9);
      const referenceEntry = wavelengthEntries.find((entry) => Math.abs(entry.wavelength - primaryWavelength) < 1e-9)
        || wavelengthEntries[0];
      const distortionEntries = simulationMode === 'psf' ? [referenceEntry] : wavelengthEntries;
      const distortionLayers: Array<{
        wavelengthUm: number;
        weight: number;
        map: ImageSimulationDistortionMap;
        backend: string;
        meta: Record<string, unknown>;
      }> = [];

      for (let index = 0; index < distortionEntries.length; index += 1) {
        throwIfCancelled(token);
        const entry = distortionEntries[index];
        const response = await raceWithCancel(runNativeGridDistortion({
          jobId: 'image-simulation-' + Date.now() + '-' + index,
          opticalSystemRows: opticalRows,
          sourceRows,
          objectRows: normalizedObjectRows,
          gridSize: Math.max(5, fieldGridSize + 2),
          wavelength: entry.wavelength,
          detailProgress: false,
          sensorWidthMm: requestedSensorWidthMm,
          sensorHeightMm: requestedSensorHeightMm,
          onProgress: (event) => {
            const nativePercent = Number(event?.percent);
            const fraction = Number.isFinite(nativePercent) ? nativePercent / 100 : 0.45;
            setProgress(2 + ((index + fraction) / Math.max(1, distortionEntries.length)) * 18);
            setProgressText('Distortion ' + (entry.wavelength * 1000).toFixed(1) + ' nm · ' + String(event?.message || 'chief-ray grid'));
          },
        }), token);
        distortionLayers.push({
          wavelengthUm: entry.wavelength,
          weight: entry.weight,
          backend: String(response?.backend || 'unknown'),
          meta: { ...(response?.meta || {}) },
          map: {
            gridSize: Math.max(2, Math.floor(Number(response?.gridSize) || fieldGridSize + 2)),
            idealX: Array.isArray(response?.idealX) ? response.idealX : [],
            idealY: Array.isArray(response?.idealY) ? response.idealY : [],
            realX: Array.isArray(response?.realX) ? response.realX : [],
            realY: Array.isArray(response?.realY) ? response.realY : [],
          },
        });
      }
      throwIfCancelled(token);

      const referenceDistortion = distortionLayers.find((layer) => Math.abs(layer.wavelengthUm - primaryWavelength) < 1e-9)
        || distortionLayers[0];
      if (!referenceDistortion) throw new Error('No wavelength-specific distortion map was available.');
      const fieldExtent = getImageSimulationPhysicalExtent(referenceDistortion.map);
      const rasterExtent = resolveImageSimulationRasterExtent(
        fieldExtent,
        scaleMode,
        sourceImage.width,
        sourceImage.height,
        Number(sensorWidthMm),
        Number(sensorHeightMm),
        Number(pixelPitchUm),
      );
      const fieldToRasterX = fieldExtent.widthMm / Math.max(1e-12, rasterExtent.widthMm);
      const fieldToRasterY = fieldExtent.heightMm / Math.max(1e-12, rasterExtent.heightMm);
      const imagePixelPitchXUm = rasterExtent.widthMm * 1000 / Math.max(1, sourceImage.width);
      const imagePixelPitchYUm = rasterExtent.heightMm * 1000 / Math.max(1, sourceImage.height);
      const diffraction = calculateImageSpaceDiffractionParams(opticalRows, primaryWavelength);
      const focalLengthMm = Math.abs(Number(diffraction?.focalLengthMm));
      const workingFNumber = Number(diffraction?.fNumberWorking);
      const airyDiameterUm = Number.isFinite(workingFNumber) && workingFNumber > 0
        ? 2.44 * primaryWavelength * workingFNumber
        : Number.NaN;
      const averagePixelPitchUm = Math.sqrt(imagePixelPitchXUm * imagePixelPitchYUm);
      const airyDiameterPixels = airyDiameterUm / Math.max(1e-12, averagePixelPitchUm);
      const nyquistLpmm = Math.min(500 / imagePixelPitchXUm, 500 / imagePixelPitchYUm);
      const cutoffLpmm = Number(diffraction?.cutoffLpmm);
      const diffractionMtfAtNyquist = calculateCircularDiffractionMtf(nyquistLpmm / cutoffLpmm);
      const chartFrequencyLpmm = getImageSimulationTargetNominalMaxFrequencyLpmm(
        sourceKind,
        rasterExtent.widthMm,
        rasterExtent.heightMm,
      );
      const diffractionMtfAtChart = chartFrequencyLpmm !== null
        ? calculateCircularDiffractionMtf(chartFrequencyLpmm / cutoffLpmm)
        : Number.NaN;
      const fieldKernelsByWavelength = new Map<string, ImageSimulationFieldKernel[]>();
      wavelengthEntries.forEach((entry) => fieldKernelsByWavelength.set(wavelengthKey(entry.wavelength), []));

      let psfFields = 0;
      let failedFields = 0;
      if (simulationMode !== 'distortion') {
        const definition = deriveMultiFieldPsfFieldDefinition(objectRows);
        const responseFieldMaxX = Math.abs(Number(referenceDistortion.meta?.fieldMaxX));
        const responseFieldMaxY = Math.abs(Number(referenceDistortion.meta?.fieldMaxY));
        const useResponseFieldBounds = requestedSensorWidthMm !== undefined && requestedSensorHeightMm !== undefined
          && Number.isFinite(responseFieldMaxX) && responseFieldMaxX > 0 && Number.isFinite(responseFieldMaxY) && responseFieldMaxY > 0;
        const simulationMaxX = useResponseFieldBounds ? responseFieldMaxX : scaleFieldExtentForDistortionGrid(definition.maxX, definition.mode);
        const simulationMaxY = useResponseFieldBounds ? responseFieldMaxY : scaleFieldExtentForDistortionGrid(definition.maxY, definition.mode);
        const gridPoints = buildMultiFieldPsfGrid({
          rows: fieldGridSize,
          columns: fieldGridSize,
          maxX: simulationMaxX,
          maxY: simulationMaxY,
          shape: 'rectangle',
        }).filter((point) => point.inside);
        for (let index = 0; index < gridPoints.length; index += 1) {
          throwIfCancelled(token);
          const point = gridPoints[index];
          const objectRow = buildMultiFieldPsfObjectRow(objectRows, point, definition.mode);
          try {
            const result = await computeFieldPsf({
              host,
              opticalRows,
              sourceRows,
              fieldObjectRow: objectRow,
              wavelengthValue: wavelength,
              samplingSize,
              zeroPad,
              colorMode: 'true',
              opdMode: 'pistonTiltRemoved',
              logScale: false,
              token,
              onProgress: (fieldPercent, message) => {
                const overall = 20 + ((index + fieldPercent / 100) / Math.max(1, gridPoints.length)) * 55;
                setProgress(overall);
                setProgressText('Spectral field PSF ' + (index + 1) + '/' + gridPoints.length + ' · ' + message);
              },
            });
            const rotation = getMultiFieldPsfLocalToGlobalRotationDeg(point, definition.mode);
            result.spectralComponents.forEach((component) => {
              const key = wavelengthKey(component.wavelengthUm);
              const kernels = fieldKernelsByWavelength.get(key);
              if (!kernels || !Array.isArray(component.psfData) || !component.psfData.length) return;
              kernels.push({
                xNorm: normalizeFieldCoordinateForImage(point.x, simulationMaxX, definition.mode) * fieldToRasterX,
                yNorm: normalizeFieldCoordinateForImage(point.y, simulationMaxY, definition.mode) * fieldToRasterY,
                kernel: resamplePsfToImageKernel(
                  component.psfData,
                  component.pixelSizeUm,
                  imagePixelPitchXUm,
                  imagePixelPitchYUm,
                  kernelSize,
                  rotation,
                ),
                fieldLabel: point.key,
              });
              psfFields += 1;
            });
          } catch (caught: any) {
            if (token.aborted || caught?.code === 'CANCELLED') throw caught;
            failedFields += 1;
          }
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        const missingWavelengths = wavelengthEntries.filter((entry) => !(fieldKernelsByWavelength.get(wavelengthKey(entry.wavelength))?.length));
        if (missingWavelengths.length) {
          throw new Error('No field PSF was available at ' + missingWavelengths.map((entry) => (entry.wavelength * 1000).toFixed(1) + ' nm').join(', ') + '.');
        }
      }

      const spectralImages = [];
      for (let index = 0; index < wavelengthEntries.length; index += 1) {
        throwIfCancelled(token);
        const entry = wavelengthEntries[index];
        let layerImage = sourceImage;
        if (simulationMode !== 'psf') {
          const distortionLayer = distortionLayers.find((candidate) => wavelengthKey(candidate.wavelengthUm) === wavelengthKey(entry.wavelength));
          if (!distortionLayer) throw new Error('Missing distortion map at ' + (entry.wavelength * 1000).toFixed(1) + ' nm.');
          setProgressText('Warping ' + (entry.wavelength * 1000).toFixed(1) + ' nm image coordinates...');
          layerImage = warpImageWithDistortion(layerImage, distortionLayer.map, rasterExtent);
          await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        if (simulationMode !== 'distortion') {
          const kernels = fieldKernelsByWavelength.get(wavelengthKey(entry.wavelength)) || [];
          const stageBase = 76 + index / Math.max(1, wavelengthEntries.length) * 23;
          const stageSpan = 23 / Math.max(1, wavelengthEntries.length);
          layerImage = await raceWithCancel(convolveImageSpatiallyVarying(layerImage, kernels, {
            tileSize: 32,
            onProgress: (percent, message) => {
              setProgress(stageBase + stageSpan * percent / 100);
              setProgressText((entry.wavelength * 1000).toFixed(1) + ' nm · ' + message);
            },
          }), token);
        }
        spectralImages.push({
          image: layerImage,
          wavelengthUm: entry.wavelength,
          weight: entry.weight,
          linearRgb: PSFPlotter.wavelengthToLinearRGB(entry.wavelength) as [number, number, number],
        });
      }

      throwIfCancelled(token);
      const workingImage = combineImageSimulationSpectralLayers(spectralImages);
      const difference = createImageSimulationDifference(sourceImage, workingImage, 3);
      const differencePercent = calculateImageSimulationDifferencePercent(sourceImage, workingImage);
      const appliedDistortionMaps = simulationMode === 'psf' ? [] : distortionLayers.map((layer) => layer.map);
      setSimulatedImage(workingImage);
      const distortionReachability = summarizeDistortionReachability(appliedDistortionMaps);
      setDifferenceImage(difference);
      setSummary({
        backend: Array.from(new Set(distortionLayers.map((layer) => layer.backend))).join(' + '),
        conjugateType,
        psfFields,
        failedFields,
        imagePixelPitchXUm,
        distortionPoints: distortionReachability.total,
        unreachedDistortionPoints: distortionReachability.unreached,
        distortionMapsWithUnreached: distortionReachability.mapsWithUnreached,
        imagePixelPitchYUm,
        maxDistortionPercent: appliedDistortionMaps.length
          ? Math.max(...appliedDistortionMaps.map((map) => calculateMaxDistortionPercent(map)))
          : 0,
        differencePercent,
        elapsedMs: performance.now() - startedAt,
        spectralLayers: spectralImages.length,
        distortionMaps: appliedDistortionMaps.length,
        maxLateralChromaticUm: calculateMaxLateralChromaticDisplacementUm(appliedDistortionMaps),
        scaleMode,
        fieldWidthMm: fieldExtent.widthMm,
        fieldHeightMm: fieldExtent.heightMm,
        rasterWidthMm: rasterExtent.widthMm,
        rasterHeightMm: rasterExtent.heightMm,
        primaryWavelengthUm: primaryWavelength,
        focalLengthMm,
        workingFNumber,
        airyDiameterUm,
        airyDiameterPixels,
        nyquistLpmm,
        cutoffLpmm,
        diffractionMtfAtNyquist,
        chartFrequencyLpmm,
        diffractionMtfAtChart,
      });
      setProgress(100);
      const completionNotices: string[] = [];
      if (distortionReachability.unreached > 0) completionNotices.push(distortionReachability.unreached + '/' + distortionReachability.total + ' distortion nodes extrapolated');
      if (failedFields > 0) completionNotices.push(failedFields + ' field PSF sets unavailable');
      setProgressText(completionNotices.length ? 'Done · ' + completionNotices.join(' · ') : 'Done');
    } catch (caught: any) {
      const message = String(caught?.message || caught || 'Image simulation failed');
      if (token.aborted || caught?.code === 'CANCELLED' || message.toLowerCase().includes('cancel')) {
        setProgressText('Cancelled');
      } else {
        setError(message);
        setProgressText('Failed');
      }
    } finally {
      if (cancelRef.current === token) cancelRef.current = null;
      setBusy(false);
    }
  }, [busy, fieldGridSize, kernelSize, pixelPitchUm, samplingSize, scaleMode, sensorHeightMm, sensorWidthMm, simulationMode, sourceImage, sourceKind, wavelength, zeroPad]);

  const guidePixelsX = Math.max(1, sourceImage?.width || outputSize);
  const guidePixelsY = Math.max(1, sourceImage?.height || outputSize);
  const guideSensorWidthMm = Math.abs(Number(sensorWidthMm));
  const guideSensorHeightMm = Math.abs(Number(sensorHeightMm));
  const guideDetectorPitchUm = Math.abs(Number(pixelPitchUm));
  const guideWidthMm = scaleMode === 'field-fit'
    ? Number(summary?.fieldWidthMm)
    : scaleMode === 'sensor-width'
      ? guideSensorWidthMm
      : guideDetectorPitchUm * guidePixelsX / 1000;
  const guideHeightMm = scaleMode === 'field-fit'
    ? Number(summary?.fieldHeightMm)
    : scaleMode === 'sensor-width'
      ? guideSensorHeightMm
      : guideDetectorPitchUm * guidePixelsY / 1000;
  const guidePitchXUm = guideWidthMm * 1000 / guidePixelsX;
  const guidePitchYUm = guideHeightMm * 1000 / guidePixelsY;
  const guidePitchUm = Math.max(guidePitchXUm, guidePitchYUm);
  const guideCoverageWidthPercent = summary && Number.isFinite(guideWidthMm)
    ? guideWidthMm / Math.max(1e-12, summary.fieldWidthMm) * 100
    : Number.NaN;
  const guideCoverageHeightPercent = summary && Number.isFinite(guideHeightMm)
    ? guideHeightMm / Math.max(1e-12, summary.fieldHeightMm) * 100
    : Number.NaN;
  const diffractionPitchLimitUm = summary && Number.isFinite(summary.cutoffLpmm) && summary.cutoffLpmm > 0
    ? 500 / summary.cutoffLpmm
    : Number.NaN;
  const requiredHorizontalSamples = Number.isFinite(guideWidthMm) && Number.isFinite(diffractionPitchLimitUm)
    ? Math.ceil(guideWidthMm * 1000 / diffractionPitchLimitUm)
    : Number.NaN;
  const rasterChoices = [1024, 1536, 2048, 3072, 4096];
  const requiredVerticalSamples = Number.isFinite(guideHeightMm) && Number.isFinite(diffractionPitchLimitUm)
    ? Math.ceil(guideHeightMm * 1000 / diffractionPitchLimitUm)
    : Number.NaN;
  const recommendedRaster = rasterChoices.find((candidate) => candidate >= Math.max(requiredHorizontalSamples, requiredVerticalSamples));

  const scaleGuidePrimary = scaleMode === 'field-fit'
    ? (summary
      ? 'Whole traced field: ' + summary.fieldWidthMm.toFixed(3) + ' × ' + summary.fieldHeightMm.toFixed(3) + ' mm.'
      : 'Whole traced field. Run once to calculate its physical size.')
    : Number.isFinite(guideWidthMm) && guideWidthMm > 0 && Number.isFinite(guideHeightMm) && guideHeightMm > 0
      ? (scaleMode === 'sensor-width' ? 'Actual sensor/crop' : 'Derived image area') + ': '
        + guideWidthMm.toFixed(3) + ' × ' + guideHeightMm.toFixed(3) + ' mm · '
        + guidePitchXUm.toFixed(3) + ' × ' + guidePitchYUm.toFixed(3) + ' µm per output pixel'
        + (Number.isFinite(guideCoverageWidthPercent) && Number.isFinite(guideCoverageHeightPercent) ? ' · ' + guideCoverageWidthPercent.toFixed(0) + '% × ' + guideCoverageHeightPercent.toFixed(0) + '% of traced field.' : '.')
      : 'Enter a value greater than zero.';
  const scaleGuideSampling = !Number.isFinite(diffractionPitchLimitUm) || !Number.isFinite(guidePitchUm)
    ? 'Run once to calculate the diffraction sampling recommendation.'
    : 'Full-band Nyquist: ≤ ' + diffractionPitchLimitUm.toFixed(3) + ' µm/px · '
      + (guidePitchUm <= diffractionPitchLimitUm * 1.05
        ? 'current sampling covers the optical cutoff.'
        : 'current sampling is a preview; use at least '
          + (recommendedRaster ? recommendedRaster + ' samples on the limiting axis.' : Math.ceil(Math.max(requiredHorizontalSamples, requiredVerticalSamples)) + ' samples on the limiting axis.'));

  return (
    <div className="analysis-window-page image-simulation-page" data-analysis-kind="image-simulation">
      <div className="analysis-window-commandbar image-simulation-commandbar">
        <label className="analysis-window-field"><span>Source</span>
          <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as ImageSimulationTargetKind | 'upload')}>
            <option value="optical-showcase">USAF 1951 Radial Grid</option>
            <option value="field-chart">Calibrated Camera Resolution Chart</option>
            <option value="usaf-array">USAF 1951 Field Array</option>
            <option value="grid-points">Grid & Point Sources</option>
            <option value="upload">Upload image…</option>
          </select>
        </label>
        {sourceKind === 'upload' && <label className="analysis-window-field image-simulation-upload"><span>Image</span><input type="file" accept="image/*" onChange={(event) => void handleUpload(event.currentTarget.files?.[0] || null)} /></label>}
        {sourceSvg && <button className="analysis-window-primary-action" type="button" title="Save the resolution-independent source target" onClick={downloadSourceSvg}>Save SVG</button>}
        <label className="analysis-window-field"><span>Simulation</span>
          <select value={simulationMode} onChange={(event) => setSimulationMode(event.target.value as SimulationMode)}>
            <option value="full">Full: Distortion + PSF</option>
            <option value="distortion">Distortion only</option>
            <option value="psf">PSF only</option>
          </select>
        </label>
        <label className="analysis-window-field"><span>Compare</span>
          <select value={comparisonMode} onChange={(event) => setComparisonMode(event.target.value as ComparisonMode)}>
            <option value="wipe">Wipe slider</option>
            <option value="side-by-side">Side by side</option>
            <option value="difference">Difference</option>
          </select>
        </label>
        <details className="analysis-window-options image-simulation-options"><summary>Options</summary><div className="analysis-window-options__panel">
          <label className="analysis-window-field"><span>Raster output</span><select value={outputSize} onChange={(event) => setOutputSize(Number(event.target.value))}><option value={1024}>1024×1024</option><option value={1536}>1536×1536</option><option value={2048}>2048×2048</option><option value={3072}>3072×3072 · slow</option><option value={4096}>4096×4096 · very slow</option></select></label>
          <label className="analysis-window-field"><span>Image scale</span><select value={scaleMode} onChange={(event) => setScaleMode(event.target.value as ImageSimulationScaleMode)}>
            <option value="field-fit">Field fit</option>
            <option value="sensor-width">Sensor size</option>
            <option value="pixel-pitch">Pixel pitch</option>
          </select></label>
          {scaleMode === 'sensor-width' ? <>
            <label className="analysis-window-field"><span>Sensor width (mm)</span><input id="image-simulation-sensor-width-input" type="number" min="0.001" step="0.1" value={sensorWidthMm} onChange={(event) => setSensorWidthMm(event.target.value)} /></label>
            <label className="analysis-window-field"><span>Sensor height (mm)</span><input id="image-simulation-sensor-height-input" type="number" min="0.001" step="0.1" value={sensorHeightMm} onChange={(event) => setSensorHeightMm(event.target.value)} /></label>
          </> : null}
          {scaleMode === 'pixel-pitch' && <label className="analysis-window-field"><span>Pixel pitch (µm)</span><input type="number" min="0.001" step="0.1" value={pixelPitchUm} onChange={(event) => setPixelPitchUm(event.target.value)} /></label>}
          <div className="image-simulation-scale-guide" role="note" aria-live="polite">
            <strong>Scale guide</strong>
            <span>{scaleGuidePrimary}</span>
            <span>{scaleGuideSampling}</span>
            <small>{scaleMode === 'pixel-pitch' ? 'Use the real detector pitch only when Raster output matches the sensor/crop pixel count. Otherwise use Sensor size.' : 'Use the real active sensor/crop width and height for camera simulation. Raster output changes numerical sampling, not the physical Airy diameter.'}</small>
          </div>
          <label className="analysis-window-field"><span>Field PSFs</span><select value={fieldGridSize} onChange={(event) => setFieldGridSize(Number(event.target.value))}><option value={3}>3×3</option><option value={5}>5×5</option><option value={7}>7×7</option><option value={9}>9×9</option></select></label>
          <AnalysisGridSamplingField value={samplingSize} options={ANALYSIS_PUPIL_SAMPLING_OPTIONS} onValueChange={(value) => setSamplingSize(Number(value))} title="Pupil sampling used for every field PSF" />
          <label className="analysis-window-field"><span>Wavelength</span><select value={wavelength} onChange={(event) => setWavelength(event.target.value)}>{wavelengthOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="analysis-window-field"><span>Zero pad</span><select value={zeroPad} onChange={(event) => setZeroPad(event.target.value as ZeroPadMode)}><option value="none">None</option><option value="auto">Auto 2×</option><option value="128">128</option><option value="256">256</option><option value="512">512</option></select></label>
          <label className="analysis-window-field"><span>Kernel support</span><select value={kernelSize} onChange={(event) => setKernelSize(Number(event.target.value))}><option value={15}>15×15</option><option value={21}>21×21</option><option value={31}>31×31</option><option value={41}>41×41</option></select></label>
          <p className="image-simulation-options__note">Field fit maps the source across the full traced field. Sensor size and Pixel pitch define a centered physical sensor area, and the same width and height are used for distortion coordinates, field-PSF placement, and convolution. USAF 1951 Radial Grid is a 240 × 240 mm native SVG: a central Group −2/−1 pair is surrounded by eight radial and sixteen orthogonal Group 0/1 pairs. Each pair follows the classic imaginary-square layout: the horizontal bars of primary Elements 2–6 share its left edge, the secondary elements share its right edge, and primary Element 1 closes the lower-right corner with its bottom aligned to Element 6. Four binary radial charts sample the field corners; an sRGB color bar and an eleven-step grayscale bar span the upper and lower edges. Frequencies follow 2^(group + (element−1)/6); every tri-bar occupies a 5w × 5w square, with equal bar and space widths. Within each pair, both group headings are 3.75× the coarser Element 1 bar width; primary and secondary element numbers are 2.70× and 1.65×. The calibrated chart remains available for eSFR, USAF and Siemens-star evaluation. Every Source wavelength uses its own distortion map and monochromatic Remove P/T PSF.</p>
        </div></details>
        <button className="analysis-window-primary-action" type="button" disabled={busy || !sourceImage} onClick={() => void run()}>{busy ? 'Simulating…' : 'Simulate'}</button>
        <button className="analysis-window-primary-action" type="button" title="Save the latest simulated image as PNG" disabled={busy || !simulatedImage} onClick={() => void downloadSimulatedPng()}>Save PNG</button>
      </div>
      {(busy || progressText) && (
        <div
          className="image-simulation-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div className="image-simulation-progress__track">
            <div className="image-simulation-progress__value" style={{ width: progress + '%' }} />
          </div>
          <span className="image-simulation-progress__status">
            {busy ? Math.round(progress) + '% · ' + progressText : progressText}
          </span>
        </div>
      )}
      {error && <div className="analysis-window-error">{error}</div>}

      <main className="image-simulation-content">
        <ComparisonViewer original={sourceImage} simulated={simulatedImage} difference={differenceImage} mode={comparisonMode} split={split} onSplitChange={setSplit} />
      </main>

      {summary && <footer className="image-simulation-metrics">
        {summary.unreachedDistortionPoints > 0 && <div className="image-simulation-reachability-warning" role="status">
          <strong>Distortion extrapolated</strong>
          <span>{summary.unreachedDistortionPoints} of {summary.distortionPoints} distortion grid nodes were unreached across {summary.distortionMapsWithUnreached} wavelength {summary.distortionMapsWithUnreached === 1 ? 'map' : 'maps'}.
            Neighboring reached nodes were used for the simulated image.</span>
        </div>}
        <span><small>Distortion map</small>{summary.backend}</span>
        <span><small>Conjugate</small>{summary.conjugateType === 'infinite' ? 'Infinite' : 'Finite'}</span>
        <span><small>Max displacement</small>{summary.maxDistortionPercent.toFixed(3)}% field diagonal</span>
        <span><small>Lateral chromatic</small>{summary.maxLateralChromaticUm.toFixed(3)} µm max separation</span>
        <span><small>Image pitch</small>{summary.imagePixelPitchXUm.toFixed(2)} × {summary.imagePixelPitchYUm.toFixed(2)} µm/px</span>
        <span><small>Distortion fields</small>{summary.distortionPoints - summary.unreachedDistortionPoints}/{summary.distortionPoints} reached{summary.unreachedDistortionPoints > 0 ? ' · ' + summary.unreachedDistortionPoints + ' extrapolated' : ''}</span>
        <span><small>Image scale</small>{summary.scaleMode === 'field-fit' ? 'Field fit' : summary.scaleMode === 'sensor-width' ? 'Sensor size' : 'Pixel pitch'} · {summary.rasterWidthMm.toFixed(3)} × {summary.rasterHeightMm.toFixed(3)} mm</span>
        <span><small>EFL · F/# · Airy diameter</small>{Number.isFinite(summary.focalLengthMm) && Number.isFinite(summary.workingFNumber) && Number.isFinite(summary.airyDiameterUm) ? summary.focalLengthMm.toFixed(3) + ' mm · F/' + summary.workingFNumber.toFixed(2) + ' · ' + summary.airyDiameterUm.toFixed(2) + ' µm · ' + summary.airyDiameterPixels.toFixed(2) + ' px' : 'Unavailable'}</span>
        <span><small>Nyquist · cutoff</small>{summary.nyquistLpmm.toFixed(1)} lp/mm · {Number.isFinite(summary.cutoffLpmm) ? summary.cutoffLpmm.toFixed(1) + ' lp/mm · MTF ' + summary.diffractionMtfAtNyquist.toFixed(3) : 'cutoff unavailable'}</span>
        <span><small>Chart frequency</small>{summary.chartFrequencyLpmm !== null ? summary.chartFrequencyLpmm.toFixed(1) + ' lp/mm · diffraction MTF ' + (Number.isFinite(summary.diffractionMtfAtChart) ? summary.diffractionMtfAtChart.toFixed(3) : '—') + (sourceKind === 'field-chart' ? ' · calibrated target maximum' : sourceKind === 'optical-showcase' ? ' · USAF G1 E6 maximum' : ' · USAF E3 nominal') : 'Broadband ≤ ' + summary.nyquistLpmm.toFixed(1) + ' lp/mm'}</span>
        <span><small>PSF fields</small>{summary.psfFields}{summary.failedFields > 0 ? ' · ' + summary.failedFields + ' unavailable' : ''}</span>
        <span><small>Elapsed</small>{(summary.elapsedMs / 1000).toFixed(2)} s</span>
      </footer>}
    </div>
  );
}
