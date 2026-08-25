import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { PSFPlotter } from '../../evaluation/psf/psf-plot.ts';
import {
  ANALYSIS_PUPIL_SAMPLING_OPTIONS,
  AnalysisGridSamplingField,
} from './AnalysisGridSamplingField';
import {
  buildWavelengthEntries,
  buildWavelengthOptions,
  createCancelToken,
  derivePsfScale,
  getBestHost,
  getPrimaryWavelength,
  getRows,
  ProgressBar,
  raceWithCancel,
  sampleBilinear,
  throwIfCancelled,
  waitForFunction,
  type CancelToken,
  type SelectOption,
  type WavelengthEntry,
} from './PsfAnalysisPage';
import {
  MULTI_FIELD_PSF_GRID_PRESETS,
  buildMultiFieldPsfGrid,
  buildMultiFieldPsfObjectRow,
  calculateMultiFieldPsfOpdRmsUm,
  deriveMultiFieldPsfFieldDefinition,
  getMultiFieldPsfFieldAzimuthDeg,
  getMultiFieldPsfLocalToGlobalRotationDeg,
  prepareMultiFieldPsfImage,
  readMultiFieldPsfCoordinates,
  rotateMultiFieldPsfImageCartesian,
  type MultiFieldPsfFieldDefinition,
  type MultiFieldPsfGridPoint,
  type MultiFieldPsfImage,
  type MultiFieldPsfPositionMode,
  type MultiFieldPsfShape,
} from './multi-field-psf-model';

export type ColorMode = 'pseudo' | 'true' | 'false';
export type OpdMode = 'raw' | 'pistonTiltRemoved' | 'pistonTiltDefocusRemoved';
export type ZeroPadMode = 'none' | 'auto' | '128' | '256' | '512' | '1024';

type MultiFieldPsfTile = MultiFieldPsfGridPoint & {
  status: 'outside' | 'pending' | 'computing' | 'done' | 'error';
  image?: MultiFieldPsfImage | null;
  metrics?: any;
  backend?: string;
  fieldAzimuthDeg?: number;
  imageRotationDeg?: number;
  error?: string;
};

export type FieldPsfComputeOptions = {
  host: any;
  opticalRows: any[];
  sourceRows: any[];
  fieldObjectRow: any;
  wavelengthValue: string;
  samplingSize: number;
  zeroPad: ZeroPadMode;
  colorMode: ColorMode;
  opdMode: OpdMode;
  logScale: boolean;
  token: CancelToken;
  onProgress: (percent: number, message: string) => void;
  includeComplexField?: boolean;
  defocusMm?: number;
};

export type FieldPsfComputeResult = {
  image: MultiFieldPsfImage;
  metrics: any;
  backend: string;
  method: 'coherent-fft' | 'hybrid-geometric';
  diagnostic?: string;
  geometricSampling?: {
    mode: 'line' | 'area';
    rayCount: number;
    effectiveSpacingUm: number;
    axis: { x: number; y: number };
  };
  psfData: number[][];
  trueColorData: null | { red: Float32Array[]; green: Float32Array[]; blue: Float32Array[] };
  pixelSizeUm: number;
  wavelengthCount: number;
  spectralComponents: Array<{
    wavelengthUm: number;
    weight: number;
    psfData: number[][];
    pixelSizeUm: number;
    method: 'coherent-fft' | 'hybrid-geometric';
    geometricSpanUm?: { x: number; y: number };
    geometricSampling?: {
      mode: 'line' | 'area';
      rayCount: number;
      effectiveSpacingUm: number;
      axis: { x: number; y: number };
    };
    fieldReal?: number[][];
    fieldImag?: number[][];
  }>;
};

export function applyImagePlaneDefocus(opticalRows: any[], defocusMm: number): any[] {
  const cloned = (Array.isArray(opticalRows) ? opticalRows : [])
    .map((row) => row && typeof row === 'object' ? { ...row } : row);
  const shift = Number(defocusMm);
  if (!Number.isFinite(shift) || Math.abs(shift) < 1e-15) return cloned;
  let imageIndex = -1;
  for (let index = cloned.length - 1; index >= 0; index -= 1) {
    const row = cloned[index] || {};
    const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
    if (objectType === 'image') {
      imageIndex = index;
      break;
    }
  }
  const precedingIndex = imageIndex > 0 ? imageIndex - 1 : Math.max(0, cloned.length - 2);
  if (precedingIndex < 0 || precedingIndex >= cloned.length) return cloned;
  const preceding = cloned[precedingIndex] && typeof cloned[precedingIndex] === 'object'
    ? { ...cloned[precedingIndex] }
    : {};
  const thickness = Number(preceding.thickness);
  preceding.thickness = (Number.isFinite(thickness) ? thickness : 0) + shift;
  cloned[precedingIndex] = preceding;
  return cloned;
}

function formatMetric(value: unknown, digits = 3): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '—';
}

function fieldSignature(rows: any[], definition: MultiFieldPsfFieldDefinition): string {
  return JSON.stringify({
    mode: definition.mode,
    points: rows.map((row) => readMultiFieldPsfCoordinates(row, definition.mode)),
  });
}

function PsfCanvas({
  image,
  label,
  className = '',
}: {
  image?: MultiFieldPsfImage | null;
  label: string;
  className?: string;
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
  return <canvas ref={ref} className={className} aria-label={label} role="img" />;
}

function getMosaicGeometry(width: number, height: number, rows: number, columns: number) {
  const marginX = Math.max(10, Math.min(56, width / Math.max(4, columns + 1) * 0.42));
  const marginY = Math.max(10, Math.min(56, height / Math.max(4, rows + 1) * 0.42));
  const usableWidth = Math.max(1, width - marginX * 2);
  const usableHeight = Math.max(1, height - marginY * 2);
  const spacingX = columns > 1 ? usableWidth / (columns - 1) : usableWidth;
  const spacingY = rows > 1 ? usableHeight / (rows - 1) : usableHeight;
  const spotSize = Math.max(3, Math.min(spacingX, spacingY) * 0.78);
  return { marginX, marginY, usableWidth, usableHeight, spacingX, spacingY, spotSize };
}

function PsfMosaicCanvas({
  tiles,
  rows,
  columns,
  maxX,
  maxY,
  unit,
  onSelect,
}: {
  tiles: MultiFieldPsfTile[];
  rows: number;
  columns: number;
  maxX: number;
  maxY: number;
  unit: string;
  onSelect: (key: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    let frame = 0;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = '#020617';
      context.fillRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';

      const geometry = getMosaicGeometry(width, height, rows, columns);
      tiles.forEach((tile) => {
        if (!tile.inside) return;
        const normalizedX = maxX > 0 ? (tile.x + maxX) / (2 * maxX) : 0.5;
        const normalizedY = maxY > 0 ? (maxY - tile.y) / (2 * maxY) : 0.5;
        const centerX = geometry.marginX + normalizedX * geometry.usableWidth;
        const centerY = geometry.marginY + normalizedY * geometry.usableHeight;
        if (tile.status === 'done' && tile.image) {
          const source = document.createElement('canvas');
          source.width = tile.image.width;
          source.height = tile.image.height;
          source.getContext('2d')?.putImageData(new ImageData(tile.image.rgba, tile.image.width, tile.image.height), 0, 0);
          context.drawImage(
            source,
            centerX - geometry.spotSize / 2,
            centerY - geometry.spotSize / 2,
            geometry.spotSize,
            geometry.spotSize,
          );
        } else {
          context.beginPath();
          context.arc(centerX, centerY, Math.max(1, geometry.spotSize * 0.035), 0, Math.PI * 2);
          context.fillStyle = tile.status === 'computing' ? '#60a5fa' : tile.status === 'error' ? '#fb7185' : '#334155';
          context.fill();
        }
      });
    };
    const scheduleDraw = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(draw);
    };
    scheduleDraw();
    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleDraw) : null;
    resizeObserver?.observe(canvas);
    window.addEventListener('resize', scheduleDraw);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleDraw);
    };
  }, [columns, maxX, maxY, rows, tiles]);

  const handleClick = useCallback((event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const geometry = getMosaicGeometry(rect.width, rect.height, rows, columns);
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    let nearest: MultiFieldPsfTile | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    tiles.forEach((tile) => {
      if (!tile.inside || tile.status !== 'done') return;
      const normalizedX = maxX > 0 ? (tile.x + maxX) / (2 * maxX) : 0.5;
      const normalizedY = maxY > 0 ? (maxY - tile.y) / (2 * maxY) : 0.5;
      const centerX = geometry.marginX + normalizedX * geometry.usableWidth;
      const centerY = geometry.marginY + normalizedY * geometry.usableHeight;
      const distance = Math.hypot(pointerX - centerX, pointerY - centerY);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = tile;
      }
    });
    if (nearest && nearestDistance <= Math.max(8, geometry.spotSize * 0.65)) onSelect(nearest.key);
  }, [columns, maxX, maxY, onSelect, rows, tiles]);

  return (
    <canvas
      ref={ref}
      className="multi-field-psf-mosaic"
      role="img"
      aria-label={`PSF mosaic over ${rows} by ${columns} field grid in ${unit}`}
      title="All field PSFs in global image coordinates. Click a PSF to inspect it."
      onClick={handleClick}
    />
  );
}

export async function computeFieldPsf(options: FieldPsfComputeOptions): Promise<FieldPsfComputeResult> {
  const {
    host,
    opticalRows,
    sourceRows,
    fieldObjectRow,
    wavelengthValue,
    samplingSize,
    zeroPad,
    colorMode,
    opdMode,
    logScale,
    token,
    onProgress,
    includeComplexField = false,
    defocusMm = 0,
  } = options;
  const primary = getPrimaryWavelength(host, sourceRows);
  const wavelengthEntries = buildWavelengthEntries(wavelengthValue, sourceRows, primary);
  const selectedSamplingSize = Math.max(32, Math.min(4096, Math.floor(Number(samplingSize) || 32)));
  const requestedZeroPad = zeroPad === 'none'
    ? selectedSamplingSize
    : zeroPad === 'auto'
      ? 0
      : Number(zeroPad);
  const autoFftSize = Math.min(1024, Math.max(selectedSamplingSize, selectedSamplingSize * 2));
  const fftSize = !requestedZeroPad ? autoFftSize : Math.max(selectedSamplingSize, requestedZeroPad);
  const opdRunner = await waitForFunction('runDesktopNativeOpdMapForPopup');
  const psfRunner = await waitForFunction('runDesktopNativePsfMapForPopup');
  const spotRunner = await waitForFunction('runDesktopNativeSpotRaytraceForPopup');

  const computeOne = async (entry: WavelengthEntry, index: number) => {
    throwIfCancelled(token);
    const base = (index / wavelengthEntries.length) * 92;
    const span = 92 / wavelengthEntries.length;
    onProgress(base + span * 0.1, `OPD ${(entry.wavelength * 1000).toFixed(1)} nm`);
    const opd = await raceWithCancel(Promise.resolve(opdRunner.fn({
      objectIndex: 0,
      objectRowsOverride: [fieldObjectRow],
      gridSize: selectedSamplingSize,
      wavelengthUm: entry.wavelength,
      opdDisplayMode: opdMode,
      suppressProgressHud: true,
      defocusMm,
    })), token);
    onProgress(base + span * 0.48, `Detector rays ${(entry.wavelength * 1000).toFixed(1)} nm`);
    const spot = await raceWithCancel(Promise.resolve(spotRunner.fn({
      objectRows: [fieldObjectRow],
      rayCount: Math.max(257, Math.min(4096, selectedSamplingSize * selectedSamplingSize)),
      ringCount: Math.max(8, Math.round(Math.sqrt(selectedSamplingSize))),
      pattern: 'grid',
      wavelengthMode: 'primary',
      wavelengthUm: entry.wavelength,
      defocusMm,
    })), token);
    const rayHitsUm = (Array.isArray((spot as any)?.series) ? (spot as any).series : [])
      .flatMap((series: any) => Array.isArray(series?.points) ? series.points : [])
      .map((point: any) => ({ xUm: Number(point?.xUm), yUm: Number(point?.yUm), weight: 1 }))
      .filter((point: any) => Number.isFinite(point.xUm) && Number.isFinite(point.yUm));

    const gridOpd = Array.from({ length: selectedSamplingSize }, () => new Array(selectedSamplingSize).fill(0));
    const gridAmplitude = Array.from({ length: selectedSamplingSize }, () => new Array(selectedSamplingSize).fill(0));
    const pupilMask = Array.from({ length: selectedSamplingSize }, () => new Array(selectedSamplingSize).fill(false));
    const displayGrid = Array.isArray((opd as any)?.displayOpdGrid) ? (opd as any).displayOpdGrid : [];
    const rawGrid = Array.isArray((opd as any)?.rawOpdGrid) ? (opd as any).rawOpdGrid : [];
    for (let y = 0; y < selectedSamplingSize; y += 1) {
      const displayRow = displayGrid[y] || [];
      const rawRow = rawGrid[y] || [];
      for (let x = 0; x < selectedSamplingSize; x += 1) {
        const rawCell = rawRow[x];
        if (rawCell === null || rawCell === undefined || rawCell === '') continue;
        const rawWaves = Number(rawCell);
        if (!Number.isFinite(rawWaves)) continue;
        const displayCell = displayRow[x];
        const displayWaves = displayCell === null || displayCell === undefined || displayCell === '' ? NaN : Number(displayCell);
        gridOpd[y][x] = (Number.isFinite(displayWaves) ? displayWaves : rawWaves) * entry.wavelength;
        gridAmplitude[y][x] = 1;
        pupilMask[y][x] = true;
      }
    }
    const validCount = pupilMask.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    if (validCount <= 0) throw new Error(`No valid pupil samples at ${(entry.wavelength * 1000).toFixed(1)} nm.`);
    const scaleRows = applyImagePlaneDefocus(opticalRows, defocusMm);
    const scale = derivePsfScale(scaleRows, entry.wavelength, selectedSamplingSize, fftSize);
    onProgress(base + span * 0.7, `PSF ${(entry.wavelength * 1000).toFixed(1)} nm`);
    const psf = await raceWithCancel(Promise.resolve(psfRunner.fn({
      gridOpd,
      gridAmplitude,
      pupilMask,
      wavelengthUm: entry.wavelength,
      pixelSizeUm: scale.pixelSizeUm,
      removeTilt: false,
      zeroPadTo: fftSize,
      recenterIfWrapped: false,
      propagationMode: 'auto',
      targetHitXGridMm: (opd as any)?.targetHitXGridMm,
      targetHitYGridMm: (opd as any)?.targetHitYGridMm,
      rayHitsUm,
      hybridOutputSize: 512,
      diffractionFwhmXUm: 1.028 * entry.wavelength * scale.fNumberWorking,
      diffractionFwhmYUm: 1.028 * entry.wavelength * scale.fNumberWorking,
      suppressProgressHud: true,
      referenceModeHint: (opd as any)?.referenceMode,
      chiefReferenceModeHint: (opd as any)?.chiefReferenceMode,
      referenceSphereCenterHint: (opd as any)?.referenceSphereCenter,
      referenceSphereRadiusMmHint: (opd as any)?.referenceSphereRadiusMm,
      objectIndexHint: 0,
      includeComplexField,
    })), token);
    return {
      wavelength: entry.wavelength,
      weight: entry.weight,
      psfData: Array.isArray((psf as any)?.psfData) ? (psf as any).psfData : [],
      metrics: (psf as any)?.metrics || null,
      backend: String((psf as any)?.backend || 'NativeRust'),
      scale: {
        ...scale,
        pixelSizeUm: Number.isFinite(Number((psf as any)?.pixelSizeUm))
          ? Number((psf as any).pixelSizeUm)
          : scale.pixelSizeUm,
      },
      method: (psf as any)?.method === 'hybrid-geometric' ? 'hybrid-geometric' : 'coherent-fft',
      geometricSpanUm: (psf as any)?.geometricSpanUm,
      diagnostic: (psf as any)?.diagnostic,
      geometricSampling: (psf as any)?.geometricSampling,
      opdRmsUm: calculateMultiFieldPsfOpdRmsUm(gridOpd, pupilMask),
      fieldReal: Array.isArray((psf as any)?.fieldReal) ? (psf as any).fieldReal : undefined,
      fieldImag: Array.isArray((psf as any)?.fieldImag) ? (psf as any).fieldImag : undefined,
    };
  };

  const results: any[] = [];
  for (let index = 0; index < wavelengthEntries.length; index += 1) {
    results.push(await computeOne(wavelengthEntries[index], index));
  }
  throwIfCancelled(token);
  if (!results.length || !Array.isArray(results[0]?.psfData) || !results[0].psfData.length) {
    throw new Error('PSF returned no image data.');
  }

  const first = results[0];
  const trueColor = colorMode !== 'pseudo';
  const falseColor = colorMode === 'false';
  const targetPitch = Number(first.scale?.pixelSizeUm);
  const accumulator = first.psfData.map((row: any[]) => new Array(row.length).fill(0));
  const trueColorAccumulator = trueColor ? {
    red: accumulator.map((row: any[]) => new Float32Array(row.length)),
    green: accumulator.map((row: any[]) => new Float32Array(row.length)),
    blue: accumulator.map((row: any[]) => new Float32Array(row.length)),
  } : null;
  let sumWeights = 0;
  let weightedStrehl = 0;
  let strehlWeight = 0;
  let weightedFwhmX = 0;
  let weightedFwhmY = 0;
  let fwhmWeightX = 0;
  let fwhmWeightY = 0;
  let weightedOpdRmsUm = 0;
  let opdRmsWeight = 0;

  results.forEach((result) => {
    const grid = result.psfData;
    const weight = Number(result.weight);
    if (!Array.isArray(grid) || !grid.length || !(weight > 0)) return;
    const sourcePitch = Number(result.scale?.pixelSizeUm);
    const pitchRatio = Number.isFinite(sourcePitch) && sourcePitch > 0 && Number.isFinite(targetPitch) && targetPitch > 0
      ? targetPitch / sourcePitch
      : 1;
    const sourceCenterY = (grid.length - 1) / 2;
    const sourceCenterX = ((grid[0]?.length || 1) - 1) / 2;
    const targetCenterY = (accumulator.length - 1) / 2;
    const targetCenterX = ((accumulator[0]?.length || 1) - 1) / 2;
    const rgb = trueColor
      ? (falseColor ? PSFPlotter.wavelengthToFalseColorLinearRGB(result.wavelength) : PSFPlotter.wavelengthToLinearRGB(result.wavelength))
      : [0, 0, 0];
    for (let y = 0; y < accumulator.length; y += 1) {
      for (let x = 0; x < accumulator[y].length; x += 1) {
        const sourceY = sourceCenterY + (y - targetCenterY) * pitchRatio;
        const sourceX = sourceCenterX + (x - targetCenterX) * pitchRatio;
        const value = sampleBilinear(grid, sourceY, sourceX);
        accumulator[y][x] += value * weight;
        if (trueColorAccumulator) {
          trueColorAccumulator.red[y][x] += value * weight * (Number(rgb[0]) || 0);
          trueColorAccumulator.green[y][x] += value * weight * (Number(rgb[1]) || 0);
          trueColorAccumulator.blue[y][x] += value * weight * (Number(rgb[2]) || 0);
        }
      }
    }
    sumWeights += weight;
    const strehl = Number(result.metrics?.strehlRatio);
    const fwhmX = Number(result.metrics?.fwhm?.x);
    const fwhmY = Number(result.metrics?.fwhm?.y);
    const opdRmsUm = Number(result.opdRmsUm);
    if (Number.isFinite(strehl)) { weightedStrehl += strehl * weight; strehlWeight += weight; }
    if (Number.isFinite(fwhmX)) { weightedFwhmX += fwhmX * weight; fwhmWeightX += weight; }
    if (Number.isFinite(fwhmY)) { weightedFwhmY += fwhmY * weight; fwhmWeightY += weight; }
    if (Number.isFinite(opdRmsUm)) { weightedOpdRmsUm += opdRmsUm * weight; opdRmsWeight += weight; }
  });
  if (sumWeights > 0 && Math.abs(sumWeights - 1) > 1e-12) {
    accumulator.forEach((row: number[]) => row.forEach((_, index) => { row[index] /= sumWeights; }));
    if (trueColorAccumulator) {
      [trueColorAccumulator.red, trueColorAccumulator.green, trueColorAccumulator.blue].forEach((plane) => {
        plane.forEach((row) => row.forEach((_, index) => { row[index] /= sumWeights; }));
      });
    }
  }

  const metrics = {
    ...(first.metrics || {}),
    strehlRatio: strehlWeight > 0 ? weightedStrehl / strehlWeight : first.metrics?.strehlRatio,
    opdRmsUm: opdRmsWeight > 0 ? weightedOpdRmsUm / opdRmsWeight : Number.NaN,
    fwhm: {
      ...(first.metrics?.fwhm || {}),
      x: fwhmWeightX > 0 ? weightedFwhmX / fwhmWeightX : first.metrics?.fwhm?.x,
      y: fwhmWeightY > 0 ? weightedFwhmY / fwhmWeightY : first.metrics?.fwhm?.y,
    },
  };
  const image = prepareMultiFieldPsfImage(accumulator, trueColorAccumulator, colorMode, logScale);
  if (!image) throw new Error('PSF image conversion failed.');
  onProgress(100, 'Done');
  return {
    image,
    metrics,
    backend: first.backend,
    method: first.method,
    diagnostic: first.diagnostic,
    geometricSampling: first.geometricSampling,
    psfData: accumulator,
    trueColorData: trueColorAccumulator,
    pixelSizeUm: Number.isFinite(targetPitch) && targetPitch > 0 ? targetPitch : 1,
    wavelengthCount: results.length,
    spectralComponents: results.map((result) => ({
      wavelengthUm: Number(result.wavelength),
      weight: Number(result.weight),
      psfData: result.psfData,
      pixelSizeUm: Number(result.scale?.pixelSizeUm),
      method: result.method,
      geometricSpanUm: result.geometricSpanUm,
      geometricSampling: result.geometricSampling,
      fieldReal: result.fieldReal,
      fieldImag: result.fieldImag,
    })),
  };
}

export function MultiFieldPsfPage() {
  const cancelRef = useRef<CancelToken | null>(null);
  const fieldSignatureRef = useRef('');
  const [fieldDefinition, setFieldDefinition] = useState<MultiFieldPsfFieldDefinition>({ mode: 'angle', unit: 'deg', maxX: 1, maxY: 1 });
  const [wavelengthOptions, setWavelengthOptions] = useState<SelectOption[]>([{ value: 'all', label: 'All' }]);
  const [wavelength, setWavelength] = useState('all');
  const [gridPreset, setGridPreset] = useState('5');
  const [customRows, setCustomRows] = useState(5);
  const [customColumns, setCustomColumns] = useState(5);
  const [maxX, setMaxX] = useState(1);
  const [maxY, setMaxY] = useState(1);
  const [shape, setShape] = useState<MultiFieldPsfShape>('rectangle');
  const [samplingSize, setSamplingSize] = useState(32);
  const [zeroPad, setZeroPad] = useState<ZeroPadMode>('none');
  const [colorMode, setColorMode] = useState<ColorMode>('true');
  const [opdMode, setOpdMode] = useState<OpdMode>('raw');
  const [logScale, setLogScale] = useState(false);
  const [tiles, setTiles] = useState<MultiFieldPsfTile[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState('');

  const rows = gridPreset === 'custom' ? customRows : Number(gridPreset);
  const columns = gridPreset === 'custom' ? customColumns : Number(gridPreset);
  const gridPoints = useMemo(() => buildMultiFieldPsfGrid({ rows, columns, maxX, maxY, shape }), [columns, maxX, maxY, rows, shape]);
  const activePointCount = gridPoints.filter((point) => point.inside).length;
  const sourceCount = Math.max(1, wavelengthOptions.filter((option) => option.value !== 'all').length);
  const spectralJobCount = activePointCount * (wavelength === 'all' ? sourceCount : 1);

  const refreshOptions = useCallback(() => {
    const host = getBestHost();
    const objectRows = getRows(host, 'object');
    const sourceRows = getRows(host, 'source');
    const definition = deriveMultiFieldPsfFieldDefinition(objectRows);
    const signature = fieldSignature(objectRows, definition);
    if (signature !== fieldSignatureRef.current) {
      fieldSignatureRef.current = signature;
      setFieldDefinition(definition);
      setMaxX(definition.maxX);
      setMaxY(definition.maxY);
    }
    const options = buildWavelengthOptions(host, sourceRows);
    setWavelengthOptions(options);
    setWavelength((current) => options.some((option) => option.value === current) ? current : 'all');
  }, []);

  useEffect(() => {
    refreshOptions();
    window.addEventListener('focus', refreshOptions);
    window.addEventListener('coopt:main-ready', refreshOptions);
    return () => {
      window.removeEventListener('focus', refreshOptions);
      window.removeEventListener('coopt:main-ready', refreshOptions);
    };
  }, [refreshOptions]);

  useEffect(() => () => {
    const token = cancelRef.current;
    if (token && !token.aborted) token.abort('Analysis window closed');
  }, []);

  const updateTile = useCallback((key: string, patch: Partial<MultiFieldPsfTile>) => {
    setTiles((current) => current.map((tile) => tile.key === key ? { ...tile, ...patch } : tile));
  }, []);

  const run = useCallback(async () => {
    if (busy || activePointCount <= 0) return;
    const token = createCancelToken();
    cancelRef.current = token;
    setBusy(true);
    setProgress(0);
    setProgressText('Preparing field grid...');
    setError('');
    setSelectedKey(null);
    setTiles(gridPoints.map((point) => ({ ...point, status: point.inside ? 'pending' : 'outside' })));

    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const host = getBestHost();
      const opticalRows = getRows(host, 'optical');
      const objectRows = getRows(host, 'object');
      const sourceRows = getRows(host, 'source');
      if (!opticalRows.length) throw new Error('No optical system data.');
      if (!objectRows.length) throw new Error('No object data.');
      const activePoints = gridPoints.filter((point) => point.inside);
      let failures = 0;
      for (let index = 0; index < activePoints.length; index += 1) {
        throwIfCancelled(token);
        const point = activePoints[index];
        const fieldObjectRow = buildMultiFieldPsfObjectRow(objectRows, point, fieldDefinition.mode);
        updateTile(point.key, { status: 'computing' });
        try {
          const result = await computeFieldPsf({
            host,
            opticalRows,
            sourceRows,
            fieldObjectRow,
            wavelengthValue: wavelength,
            samplingSize,
            zeroPad,
            colorMode,
            opdMode,
            logScale,
            token,
            onProgress: (fieldPercent, message) => {
              const totalPercent = ((index + fieldPercent / 100) / activePoints.length) * 100;
              setProgress(totalPercent);
              setProgressText(`Field ${index + 1}/${activePoints.length} · ${message}`);
            },
          });
          const fieldAzimuthDeg = getMultiFieldPsfFieldAzimuthDeg(point, fieldDefinition.mode);
          const imageRotationDeg = getMultiFieldPsfLocalToGlobalRotationDeg(point, fieldDefinition.mode);
          updateTile(point.key, {
            status: 'done',
            ...result,
            image: rotateMultiFieldPsfImageCartesian(result.image, imageRotationDeg),
            fieldAzimuthDeg,
            imageRotationDeg,
          });
        } catch (caught: any) {
          if (token.aborted || caught?.code === 'CANCELLED') throw caught;
          failures += 1;
          updateTile(point.key, { status: 'error', error: String(caught?.message || caught || 'PSF failed') });
        }
        setProgress(((index + 1) / activePoints.length) * 100);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
      setProgress(100);
      setProgressText(failures > 0 ? `Done · ${failures} field${failures === 1 ? '' : 's'} unavailable` : 'Done');
    } catch (caught: any) {
      const message = String(caught?.message || caught || 'Multi-Field PSF failed');
      if (token.aborted || caught?.code === 'CANCELLED' || message.toLowerCase().includes('cancel')) {
        setProgressText('Cancelled');
      } else {
        setError(message);
        setProgressText('Failed');
      }
    } finally {
      cancelRef.current = null;
      setBusy(false);
    }
  }, [activePointCount, busy, colorMode, fieldDefinition.mode, gridPoints, logScale, opdMode, samplingSize, updateTile, wavelength, zeroPad]);

  const selectedTile = selectedKey ? tiles.find((tile) => tile.key === selectedKey && tile.status === 'done') : null;
  const completedCount = tiles.filter((tile) => tile.status === 'done').length;
  const failedCount = tiles.filter((tile) => tile.status === 'error').length;

  return (
    <div className="analysis-window-page multi-field-psf-page" data-analysis-kind="multi-field-psf">
      <div className="analysis-window-commandbar multi-field-psf-commandbar">
        <label className="analysis-window-field"><span>Field Grid</span><select value={gridPreset} onChange={(event) => setGridPreset(event.target.value)}>{MULTI_FIELD_PSF_GRID_PRESETS.map((size) => <option key={size} value={size}>{size}×{size}</option>)}<option value="custom">Custom</option></select></label>
        {gridPreset === 'custom' ? <>
          <label className="analysis-window-field"><span>Rows</span><input type="number" min={1} max={31} value={customRows} onChange={(event) => setCustomRows(Math.max(1, Math.min(31, Number(event.target.value) || 1)))} /></label>
          <label className="analysis-window-field"><span>Columns</span><input type="number" min={1} max={31} value={customColumns} onChange={(event) => setCustomColumns(Math.max(1, Math.min(31, Number(event.target.value) || 1)))} /></label>
        </> : null}
        <label className="analysis-window-field"><span>Color</span><select value={colorMode} onChange={(event) => setColorMode(event.target.value as ColorMode)}><option value="true">True color</option><option value="pseudo">Pseudo color</option><option value="false">False color (UV/IR)</option></select></label>
        <details className="analysis-window-options multi-field-psf-options"><summary>Options</summary><div className="analysis-window-options__panel">
          <label className="analysis-window-field"><span>Wavelength</span><select value={wavelength} onChange={(event) => setWavelength(event.target.value)}>{wavelengthOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="analysis-window-field"><span>Field shape</span><select value={shape} onChange={(event) => setShape(event.target.value as MultiFieldPsfShape)}><option value="ellipse">Ellipse</option><option value="rectangle">Rectangle</option></select></label>
          <label className="analysis-window-field"><span>Half width X ({fieldDefinition.unit})</span><input type="number" min={0} step="any" value={maxX} onChange={(event) => setMaxX(Math.max(0, Number(event.target.value) || 0))} /></label>
          <label className="analysis-window-field"><span>Half height Y ({fieldDefinition.unit})</span><input type="number" min={0} step="any" value={maxY} onChange={(event) => setMaxY(Math.max(0, Number(event.target.value) || 0))} /></label>
          <AnalysisGridSamplingField value={samplingSize} options={ANALYSIS_PUPIL_SAMPLING_OPTIONS} onValueChange={(value) => setSamplingSize(Number(value))} title="Ray-traced OPD grid size for each field" />
          <label className="analysis-window-field"><span>Zero pad</span><select value={zeroPad} onChange={(event) => setZeroPad(event.target.value as ZeroPadMode)}><option value="none">None</option><option value="auto">Auto 2x</option><option value="128">128</option><option value="256">256</option><option value="512">512</option><option value="1024">1024</option></select></label>
          <label className="analysis-window-field"><span>Wavefront</span><select value={opdMode} onChange={(event) => setOpdMode(event.target.value as OpdMode)}><option value="raw">Preserve P/T (Raw)</option><option value="pistonTiltRemoved">Remove P/T</option><option value="pistonTiltDefocusRemoved">Remove P/T/D</option></select></label>
          <label className="analysis-window-toggle"><input type="checkbox" checked={logScale} onChange={(event) => setLogScale(event.target.checked)} />Log scale</label>
        </div></details>
        <button className="analysis-window-primary-action" type="button" title="Calculate the PSF at every field-grid point" onClick={() => void run()} disabled={busy || activePointCount <= 0}>{busy ? 'Calculating…' : 'Show'}</button>
      </div>
      <div className="multi-field-psf-summary">
        <span><strong>{rows}×{columns}</strong> grid</span>
        <span>{activePointCount} field points</span>
        <span>{spectralJobCount} spectral PSFs</span>
        <span>{fieldDefinition.mode === 'angle' ? 'Angle field' : fieldDefinition.mode === 'imageheight' ? 'Image-height field' : 'Object-height field'}</span>
        <span title="Every local field PSF is transformed into these global image coordinates">Global image: +Y ↑ · +X →</span>
        {tiles.length ? <span>{completedCount} complete{failedCount ? ` · ${failedCount} unavailable` : ''}</span> : null}
      </div>
      {(busy || !!progressText) ? <ProgressBar value={progress} text={progressText || 'Working...'} /> : null}
      {error ? <div className="analysis-window-error">{error}</div> : null}
      <div className="multi-field-psf-scroll is-mosaic">
        {tiles.length ? (
          <PsfMosaicCanvas
            tiles={tiles}
            rows={rows}
            columns={columns}
            maxX={maxX}
            maxY={maxY}
            unit={fieldDefinition.unit}
            onSelect={setSelectedKey}
          />
        ) : (
          <div className="multi-field-psf-empty"><strong>Multi-Field PSF</strong><span>Choose a Field Grid and press Show. Every PSF is placed at its global field position.</span></div>
        )}
      </div>
      {selectedTile ? (
        <div className="multi-field-psf-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedKey(null); }}>
          <section className="multi-field-psf-dialog" role="dialog" aria-modal="true" aria-label="Field PSF detail">
            <header><div><strong>Field PSF</strong><span>X {selectedTile.x.toFixed(4)}, Y {selectedTile.y.toFixed(4)} {fieldDefinition.unit}</span></div><button type="button" onClick={() => setSelectedKey(null)} aria-label="Close PSF detail">Close</button></header>
            <PsfCanvas image={selectedTile.image} label="Selected field PSF" className="multi-field-psf-dialog__canvas" />
            <div className="multi-field-psf-dialog__metrics">
              <span><small>Strehl</small>{formatMetric(selectedTile.metrics?.strehlRatio, 4)}</span>
              <span><small>OPD RMS</small>{formatMetric(selectedTile.metrics?.opdRmsUm, 4)} µm</span>
              <span><small>FWHM X</small>{formatMetric(selectedTile.metrics?.fwhm?.x, 3)} µm</span>
              <span><small>FWHM Y</small>{formatMetric(selectedTile.metrics?.fwhm?.y, 3)} µm</span>
              <span><small>Field azimuth</small>{formatMetric(selectedTile.fieldAzimuthDeg, 2)}°</span>
              <span><small>Backend</small>{selectedTile.backend || '—'}</span>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
