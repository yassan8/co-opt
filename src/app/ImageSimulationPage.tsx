import { useCallback, useEffect, useRef, useState } from 'react';
import { PSFPlotter } from '../../evaluation/psf/psf-plot.ts';
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
  convolveImageSpatiallyVarying,
  createImageSimulationDifference,
  generateImageSimulationTargetSvg,
  rasterizeImageSimulationTargetSvg,
  getImageSimulationPhysicalExtent,
  resamplePsfToImageKernel,
  warpImageWithDistortion,
  type ImageSimulationDistortionMap,
  type ImageSimulationFieldKernel,
  type ImageSimulationImage,
  type ImageSimulationTargetKind,
} from './image-simulation-model';

type SimulationMode = 'full' | 'distortion' | 'psf';
type ComparisonMode = 'wipe' | 'side-by-side' | 'difference';

type SimulationSummary = {
  backend: string;
  conjugateType: 'finite' | 'infinite';
  psfFields: number;
  failedFields: number;
  imagePixelPitchXUm: number;
  imagePixelPitchYUm: number;
  maxDistortionPercent: number;
  differencePercent: number;
  elapsedMs: number;
  spectralLayers: number;
  distortionMaps: number;
  maxLateralChromaticUm: number;
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
    const realX = Number(map.realX[index]);
    const realY = Number(map.realY[index]);
    if (![idealX, idealY, realX, realY].every(Number.isFinite)) continue;
    maxDisplacement = Math.max(maxDisplacement, Math.hypot(realX - idealX, realY - idealY));
  }
  return maxDisplacement / halfDiagonal * 100;
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

export function ImageSimulationPage() {
  const cancelRef = useRef<CancelToken | null>(null);
  const [sourceKind, setSourceKind] = useState<ImageSimulationTargetKind | 'upload'>('field-chart');
  const [simulationMode, setSimulationMode] = useState<SimulationMode>('full');
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('wipe');
  const [outputSize, setOutputSize] = useState(1536);
  const [fieldGridSize, setFieldGridSize] = useState(5);
  const [samplingSize, setSamplingSize] = useState(32);
  const [zeroPad, setZeroPad] = useState<ZeroPadMode>('none');
  const [kernelSize, setKernelSize] = useState(21);
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
    const fileName = sourceKind === 'field-chart'
      ? 'co-opt-vector-field-target.svg'
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
      const extent = getImageSimulationPhysicalExtent(referenceDistortion.map);
      const imagePixelPitchXUm = extent.widthMm * 1000 / Math.max(1, sourceImage.width);
      const imagePixelPitchYUm = extent.heightMm * 1000 / Math.max(1, sourceImage.height);
      const fieldKernelsByWavelength = new Map<string, ImageSimulationFieldKernel[]>();
      wavelengthEntries.forEach((entry) => fieldKernelsByWavelength.set(wavelengthKey(entry.wavelength), []));

      let psfFields = 0;
      let failedFields = 0;
      if (simulationMode !== 'distortion') {
        const definition = deriveMultiFieldPsfFieldDefinition(objectRows);
        const simulationMaxX = scaleFieldExtentForDistortionGrid(definition.maxX, definition.mode);
        const simulationMaxY = scaleFieldExtentForDistortionGrid(definition.maxY, definition.mode);
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
                xNorm: normalizeFieldCoordinateForImage(point.x, simulationMaxX, definition.mode),
                yNorm: normalizeFieldCoordinateForImage(point.y, simulationMaxY, definition.mode),
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
          layerImage = warpImageWithDistortion(layerImage, distortionLayer.map);
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
      setDifferenceImage(difference);
      setSummary({
        backend: Array.from(new Set(distortionLayers.map((layer) => layer.backend))).join(' + '),
        conjugateType,
        psfFields,
        failedFields,
        imagePixelPitchXUm,
        imagePixelPitchYUm,
        maxDistortionPercent: appliedDistortionMaps.length
          ? Math.max(...appliedDistortionMaps.map((map) => calculateMaxDistortionPercent(map)))
          : 0,
        differencePercent,
        elapsedMs: performance.now() - startedAt,
        spectralLayers: spectralImages.length,
        distortionMaps: appliedDistortionMaps.length,
        maxLateralChromaticUm: calculateMaxLateralChromaticDisplacementUm(appliedDistortionMaps),
      });
      setProgress(100);
      setProgressText(failedFields > 0 ? 'Done · ' + failedFields + ' field PSF sets unavailable' : 'Done');
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
  }, [busy, fieldGridSize, kernelSize, samplingSize, simulationMode, sourceImage, wavelength, zeroPad]);

  return (
    <div className="analysis-window-page image-simulation-page" data-analysis-kind="image-simulation">
      <div className="analysis-window-commandbar image-simulation-commandbar">
        <label className="analysis-window-field"><span>Source</span>
          <select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as ImageSimulationTargetKind | 'upload')}>
            <option value="field-chart">Co-opt Field Chart</option>
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
          <label className="analysis-window-field"><span>Field PSFs</span><select value={fieldGridSize} onChange={(event) => setFieldGridSize(Number(event.target.value))}><option value={3}>3×3</option><option value={5}>5×5</option><option value={7}>7×7</option><option value={9}>9×9</option></select></label>
          <AnalysisGridSamplingField value={samplingSize} options={ANALYSIS_PUPIL_SAMPLING_OPTIONS} onValueChange={(value) => setSamplingSize(Number(value))} title="Pupil sampling used for every field PSF" />
          <label className="analysis-window-field"><span>Wavelength</span><select value={wavelength} onChange={(event) => setWavelength(event.target.value)}>{wavelengthOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="analysis-window-field"><span>Zero pad</span><select value={zeroPad} onChange={(event) => setZeroPad(event.target.value as ZeroPadMode)}><option value="none">None</option><option value="auto">Auto 2×</option><option value="128">128</option><option value="256">256</option><option value="512">512</option></select></label>
          <label className="analysis-window-field"><span>Kernel support</span><select value={kernelSize} onChange={(event) => setKernelSize(Number(event.target.value))}><option value={15}>15×15</option><option value={21}>21×21</option><option value={31}>31×31</option><option value={41}>41×41</option></select></label>
          <p className="image-simulation-options__note">Built-in targets are native SVG vectors and are rasterized only at the selected output size. USAF bars follow the MIL-STD-150A element proportions; their scale is normalized because this simulation source has no fixed object-plane millimetre size. Large outputs preserve fine patterns but increase PSF convolution time. Every Source wavelength uses its own distortion map and monochromatic Remove P/T PSF.</p>
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
        <span><small>Distortion map</small>{summary.backend}</span>
        <span><small>Conjugate</small>{summary.conjugateType === 'infinite' ? 'Infinite' : 'Finite'}</span>
        <span><small>Max displacement</small>{summary.maxDistortionPercent.toFixed(3)}% field diagonal</span>
        <span><small>Lateral chromatic</small>{summary.maxLateralChromaticUm.toFixed(3)} µm max separation</span>
        <span><small>Image pitch</small>{summary.imagePixelPitchXUm.toFixed(2)} × {summary.imagePixelPitchYUm.toFixed(2)} µm/px</span>
        <span><small>PSF fields</small>{summary.psfFields}{summary.failedFields > 0 ? ' · ' + summary.failedFields + ' unavailable' : ''}</span>
        <span><small>Elapsed</small>{(summary.elapsedMs / 1000).toFixed(2)} s</span>
      </footer>}
    </div>
  );
}
