import { useCallback, useEffect, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import { PSFPlotter } from '../../evaluation/psf/psf-plot.ts';
import { derivePupilAndFocalLengthMmFromParaxial } from '../../evaluation/spot-diagram.ts';
import { calculateImageSpaceDiffractionParams, findStopSurfaceIndex } from '../../raytracing/core/ray-paraxial.ts';
import { calculatePsfImagePixelSizeUm } from './psf-scale-model';
import {
  ANALYSIS_PUPIL_SAMPLING_OPTIONS,
  AnalysisGridSamplingField,
} from './AnalysisGridSamplingField';

export type SelectOption = { value: string; label: string };
export type WavelengthEntry = { wavelength: number; weight: number };
export type CancelToken = {
  readonly aborted: boolean;
  readonly reason: unknown;
  abort: (reason?: unknown) => void;
  onAbort: (listener: (reason?: unknown) => void) => void;
};

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (_) { return fallback; }
}

function getWindowCandidates(): any[] {
  const out: any[] = [];
  try {
    const explicitHost = (window as any).__analysisHostWindow;
    if (explicitHost && !explicitHost.closed) out.push(explicitHost);
  } catch (_) {}
  try {
    const parent = (window as any).parent;
    if (parent && parent !== window) out.push(parent);
  } catch (_) {}
  try {
    const opener = (window as any).opener;
    if (opener && !opener.closed) out.push(opener);
  } catch (_) {}
  out.push(window as any);
  return out.filter((value, index, all) => value && all.indexOf(value) === index);
}

function findFunction(name: string): { host: any; fn: (...args: any[]) => any } | null {
  for (const host of getWindowCandidates()) {
    try {
      if (typeof host?.[name] === 'function') return { host, fn: host[name].bind(host) };
    } catch (_) {}
  }
  return null;
}

export async function waitForFunction(name: string, timeoutMs = 12000): Promise<{ host: any; fn: (...args: any[]) => any }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = findFunction(name);
    if (match) return match;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
  }
  throw new Error(`${name} is not available`);
}

export function getRows(host: any, kind: 'optical' | 'object' | 'source'): any[] {
  if (!host) return [];
  const functionName = kind === 'optical' ? 'getOpticalSystemRows' : kind === 'object' ? 'getObjectRows' : 'getSourceRows';
  const tableName = kind === 'optical' ? 'tableOpticalSystem' : kind === 'object' ? 'tableObject' : 'tableSource';
  let rows: any[] = [];
  if (typeof host[functionName] === 'function') {
    rows = safeCall(() => host[functionName](host[tableName]), [] as any[]);
    if (!Array.isArray(rows) || rows.length === 0) rows = safeCall(() => host[functionName](), [] as any[]);
  }
  if ((!Array.isArray(rows) || rows.length === 0) && host?.[tableName] && typeof host[tableName].getData === 'function') {
    rows = safeCall(() => host[tableName].getData(), [] as any[]);
  }

  try {
    let activeConfig: any = null;
    if (typeof host.getActiveConfiguration === 'function') activeConfig = safeCall(() => host.getActiveConfiguration(), null);
    if (!activeConfig && typeof host.loadSystemConfigurations === 'function') {
      const systemConfig = safeCall(() => host.loadSystemConfigurations(), null as any);
      const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
      activeConfig = configs.find((config: any) => String(config?.id) === String(systemConfig?.activeConfigId)) || configs[0] || null;
    }
    if (activeConfig) {
      let snapshot = kind === 'optical'
        ? (Array.isArray(activeConfig.opticalSystem) ? activeConfig.opticalSystem : [])
        : kind === 'object'
          ? (Array.isArray(activeConfig.object) ? activeConfig.object : [])
          : (Array.isArray(activeConfig.source) ? activeConfig.source : []);
      if (kind === 'optical' && Array.isArray(activeConfig.blocks) && activeConfig.blocks.length > 0 && typeof host.expandBlocksToOpticalSystemRows === 'function') {
        const metadata = activeConfig?.metadata && typeof activeConfig.metadata === 'object' ? activeConfig.metadata : null;
        const preferImportedRows = snapshot.length > 0 && !!(metadata?.importRowsPreferred || metadata?.importAnalyzeMode);
        if (!preferImportedRows) {
          const expanded = safeCall(() => host.expandBlocksToOpticalSystemRows(activeConfig.blocks), null as any);
          if (Array.isArray(expanded?.rows) && expanded.rows.length > 0) snapshot = expanded.rows;
        }
      }
      if (snapshot.length > 0) rows = snapshot;
    }
  } catch (_) {}

  return Array.isArray(rows)
    ? rows.map((row) => row && typeof row === 'object' ? { ...row } : row)
    : [];
}

export function getBestHost(): any {
  let best = window as any;
  let bestScore = -1;
  for (const host of getWindowCandidates()) {
    const score = getRows(host, 'optical').length * 10000 + getRows(host, 'object').length * 100 + getRows(host, 'source').length;
    if (score > bestScore) {
      best = host;
      bestScore = score;
    }
  }
  return best;
}

export function createCancelToken(): CancelToken {
  let aborted = false;
  let reason: unknown = null;
  const listeners: Array<(reason?: unknown) => void> = [];
  return {
    get aborted() { return aborted; },
    get reason() { return reason; },
    abort(nextReason: unknown = 'User requested stop') {
      if (aborted) return;
      aborted = true;
      reason = nextReason;
      listeners.forEach((listener) => safeCall(() => listener(nextReason), undefined));
    },
    onAbort(listener) {
      if (typeof listener !== 'function') return;
      if (aborted) safeCall(() => listener(reason), undefined);
      else listeners.push(listener);
    },
  };
}

export function throwIfCancelled(token: CancelToken) {
  if (!token.aborted) return;
  const error: any = new Error(String(token.reason || 'Cancelled'));
  error.code = 'CANCELLED';
  throw error;
}

export async function raceWithCancel<T>(promise: Promise<T>, token: CancelToken): Promise<T> {
  throwIfCancelled(token);
  const cancelled = new Promise<T>((_, reject) => token.onAbort((reason) => {
    const error: any = new Error(String(reason || 'Cancelled'));
    error.code = 'CANCELLED';
    reject(error);
  }));
  return Promise.race([promise, cancelled]);
}

function isPrimaryRow(value: unknown): boolean {
  if (value === true || value === 1) return true;
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized.includes('primary') || ['true', 'yes', '1'].includes(normalized);
}

export function getPrimaryWavelength(host: any, sourceRows: any[]): number {
  const direct = Number(safeCall(() => host?.getPrimaryWavelength?.(), NaN));
  if (Number.isFinite(direct) && direct > 0) return direct;
  const primary = sourceRows.find((row) => isPrimaryRow(row?.primary));
  const value = Number(primary?.wavelength ?? sourceRows[0]?.wavelength);
  return Number.isFinite(value) && value > 0 ? value : NaN;
}

function buildObjectOptions(rows: any[]): SelectOption[] {
  if (!rows.length) return [{ value: '0', label: '1' }];
  return rows.map((object, index) => {
    const type = String(object?.position ?? object?.object ?? object?.Object ?? object?.objectType ?? 'Point');
    const x = object?.x ?? object?.xHeightAngle ?? 0;
    const y = object?.y ?? object?.yHeightAngle ?? 0;
    return { value: String(index), label: `${index + 1}: ${type} (${x}, ${y})` };
  });
}

export function buildWavelengthOptions(host: any, sourceRows: any[]): SelectOption[] {
  const primary = getPrimaryWavelength(host, sourceRows);
  const out: SelectOption[] = [{ value: 'all', label: 'All' }];
  const seen = new Set<string>();
  sourceRows.forEach((row) => {
    const wavelength = Number(row?.wavelength);
    if (!Number.isFinite(wavelength) || wavelength <= 0) return;
    const key = wavelength.toFixed(9);
    if (seen.has(key)) return;
    seen.add(key);
    const nm = wavelength * 1000;
    out.push({
      value: String(wavelength),
      label: Number.isFinite(primary) && Math.abs(wavelength - primary) < 1e-9
        ? `${nm.toFixed(1)} nm (primary)`
        : `${nm.toFixed(1)} nm`,
    });
  });
  if (out.length === 1 && Number.isFinite(primary) && primary > 0) {
    out.push({ value: String(primary), label: `${(primary * 1000).toFixed(1)} nm (primary)` });
  }
  return out;
}

export function buildWavelengthEntries(value: string, sourceRows: any[], primary: number): WavelengthEntry[] {
  const raw: WavelengthEntry[] = [];
  if (value !== 'all') {
    const selected = Number(value);
    const wavelength = Number.isFinite(selected) && selected > 0 ? selected : primary;
    if (Number.isFinite(wavelength) && wavelength > 0) raw.push({ wavelength, weight: 1 });
  } else {
    sourceRows.forEach((row) => {
      const wavelength = Number(row?.wavelength);
      if (!Number.isFinite(wavelength) || wavelength <= 0) return;
      const weightRaw = Number(row?.weight);
      raw.push({ wavelength, weight: Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : 1 });
    });
  }
  if (!raw.length && Number.isFinite(primary) && primary > 0) raw.push({ wavelength: primary, weight: 1 });
  if (!raw.length) throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');

  const merged: WavelengthEntry[] = [];
  raw.forEach((entry) => {
    const existing = merged.find((candidate) => Math.abs(candidate.wavelength - entry.wavelength) < 1e-9);
    if (existing) existing.weight += entry.weight;
    else merged.push({ ...entry });
  });
  const total = merged.reduce((sum, entry) => sum + (Number(entry.weight) || 0), 0);
  merged.forEach((entry) => { entry.weight = total > 0 ? entry.weight / total : 1 / merged.length; });
  if (Number.isFinite(primary) && primary > 0) {
    merged.sort((left, right) => {
      const leftPrimary = Math.abs(left.wavelength - primary) < 1e-9 ? 0 : 1;
      const rightPrimary = Math.abs(right.wavelength - primary) < 1e-9 ? 0 : 1;
      return leftPrimary !== rightPrimary ? leftPrimary - rightPrimary : left.wavelength - right.wavelength;
    });
  }
  return merged;
}

export function derivePsfScale(opticalRows: any[], wavelength: number, samplingSize: number, fftSize: number) {
  let pupilDiameterMm = Number.NaN;
  let focalLengthMm = Number.NaN;
  let fNumberWorking = Number.NaN;
  let conjugateType: 'finite' | 'infinite' | 'unknown' = 'unknown';
  try {
    const diffraction = calculateImageSpaceDiffractionParams(opticalRows, wavelength) as any;
    const fNumber = Number(diffraction?.fNumberWorking);
    const focalLength = Number(diffraction?.focalLengthMm);
    if (Number.isFinite(fNumber) && fNumber > 0) fNumberWorking = fNumber;
    if (diffraction?.conjugateType === 'finite' || diffraction?.conjugateType === 'infinite') {
      conjugateType = diffraction.conjugateType;
    }
    if (Number.isFinite(fNumber) && fNumber > 0 && Number.isFinite(focalLength) && focalLength > 0) {
      focalLengthMm = Math.abs(focalLength);
      pupilDiameterMm = focalLengthMm / fNumber;
    }
  } catch (_) {}
  if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) {
    try {
      const stopIndex = Number(findStopSurfaceIndex(opticalRows));
      const stop = Number.isFinite(stopIndex) && stopIndex >= 0 ? opticalRows[stopIndex] : null;
      const raw = stop?.semidia ?? stop?.Semidia ?? stop?.['Semi Diameter'] ?? stop?.aperture ?? stop?.Aperture;
      const value = Math.abs(Number(raw));
      if (Number.isFinite(value) && value > 0) {
        const apertureIsDiameter = stop && (stop.aperture !== undefined || stop.Aperture !== undefined);
        pupilDiameterMm = apertureIsDiameter ? value : value * 2;
      }
    } catch (_) {}
  }
  if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0) || !(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
    try {
      const paraxial = derivePupilAndFocalLengthMmFromParaxial(opticalRows, wavelength, true) as any;
      if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) pupilDiameterMm = Number(paraxial?.pupilDiameterMm);
      if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) focalLengthMm = Number(paraxial?.focalLengthMm);
    } catch (_) {}
  }
  if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) pupilDiameterMm = 10;
  if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) focalLengthMm = 100;
  if (!(Number.isFinite(fNumberWorking) && fNumberWorking > 0)) {
    fNumberWorking = Math.abs(focalLengthMm) / Math.max(1e-12, Math.abs(pupilDiameterMm));
  }
  const pixelSizeUm = calculatePsfImagePixelSizeUm(wavelength, fNumberWorking, samplingSize, fftSize);
  return { pupilDiameterMm, focalLengthMm, fNumberWorking, conjugateType, pixelSizeUm };
}

export function sampleBilinear(grid: any[][], y: number, x: number): number {
  const height = Array.isArray(grid) ? grid.length : 0;
  const width = height > 0 && grid[0] ? grid[0].length : 0;
  if (!(height > 0 && width > 0) || x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const v00 = Number(grid[y0]?.[x0]) || 0;
  const v10 = Number(grid[y0]?.[x1]) || 0;
  const v01 = Number(grid[y1]?.[x0]) || 0;
  const v11 = Number(grid[y1]?.[x1]) || 0;
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

export function ProgressBar({ value, text }: { value: number; text: string }) {
  return (
    <div className="analysis-window-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <div className="analysis-window-progress__label"><span>{Math.round(value)}%</span><span>{text}</span></div>
      <div className="analysis-window-progress__track"><div className="analysis-window-progress__value" style={{ width: `${value}%` }} /></div>
    </div>
  );
}

export function PsfAnalysisPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const statsRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<CancelToken | null>(null);
  const [objectOptions, setObjectOptions] = useState<SelectOption[]>([{ value: '0', label: '1' }]);
  const [wavelengthOptions, setWavelengthOptions] = useState<SelectOption[]>([{ value: 'all', label: 'All' }]);
  const [objectIndex, setObjectIndex] = useState('0');
  const [wavelength, setWavelength] = useState('all');
  const [zeroPad, setZeroPad] = useState<'auto' | 'none' | '512' | '1024' | '2048' | '4096'>('auto');
  const [samplingSize, setSamplingSize] = useState(32);
  const [logScale, setLogScale] = useState(false);
  const [colorMode, setColorMode] = useState<'pseudo' | 'true' | 'false'>('true');
  const [opdMode, setOpdMode] = useState<'raw' | 'pistonTiltRemoved' | 'pistonTiltDefocusRemoved'>('raw');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [pipelineBadge, setPipelineBadge] = useState('');
  const [analysisNote, setAnalysisNote] = useState('');
  const [error, setError] = useState('');

  const refreshOptions = useCallback(() => {
    const host = getBestHost();
    const objects = buildObjectOptions(getRows(host, 'object'));
    const wavelengths = buildWavelengthOptions(host, getRows(host, 'source'));
    setObjectOptions(objects);
    setWavelengthOptions(wavelengths);
    setObjectIndex((current) => objects.some((option) => option.value === current) ? current : (objects[0]?.value || '0'));
    setWavelength((current) => wavelengths.some((option) => option.value === current) ? current : 'all');
  }, []);

  useEffect(() => {
    (window as any).Plotly = (window as any).Plotly || Plotly;
    refreshOptions();
    window.addEventListener('focus', refreshOptions);
    window.addEventListener('coopt:main-ready', refreshOptions);
    return () => {
      window.removeEventListener('focus', refreshOptions);
      window.removeEventListener('coopt:main-ready', refreshOptions);
    };
  }, [refreshOptions]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      try { (window as any).Plotly?.Plots?.resize?.(chart); } catch (_) {}
    });
    observer.observe(chart);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    const token = cancelRef.current;
    if (token && !token.aborted) token.abort('Analysis window closed');
  }, []);

  const run = useCallback(async () => {
    if (busy || !chartRef.current) return;
    const token = createCancelToken();
    cancelRef.current = token;
    setBusy(true);
    setPipelineBadge('Running');
    setProgress(0);
    setProgressText('Starting...');
    setAnalysisNote('');
    setError('');
    chartRef.current.innerHTML = '';
    if (statsRef.current) statsRef.current.innerHTML = '';

    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const host = getBestHost();
      const opticalRows = getRows(host, 'optical');
      const objectRows = getRows(host, 'object');
      const sourceRows = getRows(host, 'source');
      if (!opticalRows.length) throw new Error('No optical system data.');
      if (!objectRows.length) throw new Error('No object data.');
      const primary = getPrimaryWavelength(host, sourceRows);
      const wavelengthEntries = buildWavelengthEntries(wavelength, sourceRows, primary);
      const selectedObjectIndex = Math.max(0, Math.min(objectRows.length - 1, Math.floor(Number(objectIndex) || 0)));
      const selectedSamplingSize = Math.max(32, Math.min(4096, Math.floor(Number(samplingSize) || 32)));
      const requestedZeroPad = zeroPad === 'none'
        ? selectedSamplingSize
        : zeroPad === 'auto'
          ? 0
          : Number(zeroPad);
      const autoFftSize = Math.min(4096, Math.max(selectedSamplingSize, selectedSamplingSize * 4));
      const fftSize = !requestedZeroPad ? autoFftSize : Math.max(selectedSamplingSize, requestedZeroPad);
      const opdRunner = await waitForFunction('runDesktopNativeOpdMapForPopup');
      const psfRunner = await waitForFunction('runDesktopNativePsfMapForPopup');
      const spotRunner = await waitForFunction('runDesktopNativeSpotRaytraceForPopup');

      const computeOne = async (entry: WavelengthEntry, index: number) => {
        throwIfCancelled(token);
        const base = 4 + (index / wavelengthEntries.length) * 82;
        const span = 82 / wavelengthEntries.length;
        setProgress(base + span * 0.12);
        setProgressText(`OPD λ=${(entry.wavelength * 1000).toFixed(1)}nm...`);
        const opd = await raceWithCancel(Promise.resolve(opdRunner.fn({
          objectIndex: selectedObjectIndex,
          gridSize: selectedSamplingSize,
          wavelengthUm: entry.wavelength,
          opdDisplayMode: opdMode,
          suppressProgressHud: true,
        })), token);
        setProgress(base + span * 0.48);
        setProgressText(`Detector rays λ=${(entry.wavelength * 1000).toFixed(1)}nm...`);
        const spot = await raceWithCancel(Promise.resolve(spotRunner.fn({
          objectRows: [objectRows[selectedObjectIndex]],
          rayCount: Math.max(257, Math.min(4096, selectedSamplingSize * selectedSamplingSize)),
          ringCount: Math.max(8, Math.round(Math.sqrt(selectedSamplingSize))),
          pattern: 'grid',
          wavelengthMode: 'primary',
          wavelengthUm: entry.wavelength,
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
        for (let y = 0; y < selectedSamplingSize; y++) {
          const displayRow = displayGrid[y] || [];
          const rawRow = rawGrid[y] || [];
          for (let x = 0; x < selectedSamplingSize; x++) {
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
        if (validCount <= 0) throw new Error(`OPD λ=${(entry.wavelength * 1000).toFixed(1)}nm returned no valid pupil samples.`);
        const scale = derivePsfScale(opticalRows, entry.wavelength, selectedSamplingSize, fftSize);
        setProgress(base + span * 0.72);
        setProgressText(`PSF λ=${(entry.wavelength * 1000).toFixed(1)}nm...`);
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
          objectIndexHint: selectedObjectIndex,
        })), token);
        return {
          wavelength: entry.wavelength,
          weight: entry.weight,
          psfData: Array.isArray((psf as any)?.psfData) ? (psf as any).psfData : [],
          metrics: (psf as any)?.metrics || null,
          backend: (psf as any)?.backend,
          fftSize: (psf as any)?.fftSize,
          scale: {
            ...scale,
            pixelSizeUm: Number.isFinite(Number((psf as any)?.pixelSizeUm))
              ? Number((psf as any).pixelSizeUm)
              : scale.pixelSizeUm,
          },
          method: (psf as any)?.method || 'coherent-fft',
          fieldOfViewUm: (psf as any)?.fieldOfViewUm,
          geometricSpanUm: (psf as any)?.geometricSpanUm,
          geometricSampling: (psf as any)?.geometricSampling,
          phaseSampling: (psf as any)?.phaseSampling,
          diagnostic: (psf as any)?.diagnostic,
          gridData: { opd: gridOpd, amplitude: gridAmplitude, pupilMask },
        };
      };

      const results: any[] = [];
      for (let index = 0; index < wavelengthEntries.length; index++) {
        results.push(await computeOne(wavelengthEntries[index], index));
      }
      throwIfCancelled(token);
      if (!results.length || !Array.isArray(results[0]?.psfData) || !results[0].psfData.length) throw new Error('PSF returned no image data.');

      const first = results[0];
      const hybridResult = results.find((result) => result?.method === 'hybrid-geometric');
      const trueColor = colorMode !== 'pseudo';
      const falseColor = colorMode === 'false';
      const targetPitch = Number(first.scale?.pixelSizeUm);
      const accumulator = first.psfData.map((row: any[]) => new Array(row.length).fill(0));
      const trueColorAccumulator = trueColor ? {
        red: accumulator.map((row) => new Float32Array(row.length)),
        green: accumulator.map((row) => new Float32Array(row.length)),
        blue: accumulator.map((row) => new Float32Array(row.length)),
      } : null;
      let sumWeights = 0;
      let weightedStrehl = 0;
      let strehlWeight = 0;
      let weightedFwhmX = 0;
      let weightedFwhmY = 0;
      let fwhmWeightX = 0;
      let fwhmWeightY = 0;

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
        for (let y = 0; y < accumulator.length; y++) {
          for (let x = 0; x < accumulator[y].length; x++) {
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
        if (Number.isFinite(strehl)) { weightedStrehl += strehl * weight; strehlWeight += weight; }
        if (Number.isFinite(fwhmX)) { weightedFwhmX += fwhmX * weight; fwhmWeightX += weight; }
        if (Number.isFinite(fwhmY)) { weightedFwhmY += fwhmY * weight; fwhmWeightY += weight; }
      });
      if (sumWeights > 0) accumulator.forEach((row) => row.forEach((_, index) => { row[index] /= sumWeights; }));

      const psfResult: any = {
        psfData: accumulator,
        trueColorData: trueColorAccumulator || undefined,
        metrics: {
          ...(first.metrics || {}),
          strehlRatio: strehlWeight > 0 ? weightedStrehl / strehlWeight : first.metrics?.strehlRatio,
          fwhm: {
            ...(first.metrics?.fwhm || {}),
            x: fwhmWeightX > 0 ? weightedFwhmX / fwhmWeightX : first.metrics?.fwhm?.x,
            y: fwhmWeightY > 0 ? weightedFwhmY / fwhmWeightY : first.metrics?.fwhm?.y,
          },
        },
        samplingSize: selectedSamplingSize,
        wavelength: Number.isFinite(primary) && primary > 0 ? primary : first.wavelength,
        gridData: first.gridData,
        options: {
          pupilDiameter: first.scale.pupilDiameterMm,
          focalLength: first.scale.focalLengthMm,
          pixelSize: targetPitch,
        },
        metadata: {
          method: hybridResult ? 'hybrid-geometric-diffraction' : 'coherent-fft',
          backend: first.backend,
          samplingSize: selectedSamplingSize,
          fftSize: first.fftSize || fftSize,
          wavelengthMode: wavelength === 'all' ? 'all' : 'single',
          wavelengths: wavelengthEntries.map((entry) => entry.wavelength),
          weights: wavelengthEntries.map((entry) => entry.weight),
          opdDisplayMode: opdMode,
          pixelSize: targetPitch,
        },
        implementationUsed: 'NativeRust',
      };

      setProgress(94);
      setProgressText('Rendering PSF...');
      const plotter = new PSFPlotter(chartRef.current);
      await plotter.plot2DPSF(psfResult, {
        logScale,
        trueColor,
        spectralColorMode: colorMode,
        title: '',
        recenterToCentroid: false,
        showMetrics: false,
      });
      if (statsRef.current) plotter.displayStatistics(psfResult, statsRef.current);
      if (hybridResult) {
        const spanX = Number(hybridResult?.geometricSpanUm?.x);
        const spanY = Number(hybridResult?.geometricSpanUm?.y);
        const required = Number(hybridResult?.phaseSampling?.requiredPupilSampling);
        const spanText = Number.isFinite(spanX) && Number.isFinite(spanY)
          ? `Geometric span ${(spanX / 1000).toFixed(3)} × ${(spanY / 1000).toFixed(3)} mm.`
          : '';
        const samplingText = Number.isFinite(required)
          ? ` A coherent FFT would require about ${Math.ceil(required).toLocaleString()} pupil samples.`
          : '';
        const detectorRays = Number(hybridResult?.geometricSampling?.rayCount);
        const detectorSpacing = Number(hybridResult?.geometricSampling?.effectiveSpacingUm);
        const detectorText = Number.isFinite(detectorRays) && Number.isFinite(detectorSpacing)
          ? ` Detector density reconstructed from ${Math.round(detectorRays).toLocaleString()} rays at ${detectorSpacing.toFixed(2)} µm measured spacing.`
          : '';
        setAnalysisNote(`Hybrid geometric + diffraction PSF. ${spanText}${detectorText}${samplingText}`.trim());
      } else {
        const required = Number(first?.phaseSampling?.requiredPupilSampling);
        setAnalysisNote(Number.isFinite(required)
          ? `Coherent FFT PSF · phase sampling verified (required ≈ ${Math.ceil(required).toLocaleString()}).`
          : 'Coherent FFT PSF.');
      }
      setProgress(100);
      setProgressText('Done');
      setPipelineBadge('');
    } catch (caught: any) {
      const message = String(caught?.message || caught || 'PSF analysis failed');
      if (token.aborted || caught?.code === 'CANCELLED' || message.toLowerCase().includes('cancel')) {
        setProgress(100);
        setProgressText('Cancelled');
        setPipelineBadge('');
      } else {
        setProgress(100);
        setProgressText('Failed');
        setPipelineBadge('Error');
        setError(message);
      }
    } finally {
      cancelRef.current = null;
      setBusy(false);
      window.setTimeout(() => setProgressText((current) => current === 'Done' ? '' : current), 350);
    }
  }, [busy, colorMode, logScale, objectIndex, opdMode, samplingSize, wavelength, zeroPad]);

  return (
    <div className="analysis-window-page" data-analysis-kind="psf">
      <div className="analysis-window-commandbar">
        <label className="analysis-window-field"><span>Wavelength</span><select value={wavelength} onChange={(event) => setWavelength(event.target.value)}>{wavelengthOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="analysis-window-field"><span>Object</span><select value={objectIndex} onChange={(event) => setObjectIndex(event.target.value)}>{objectOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <details className="analysis-window-options"><summary>Options</summary><div className="analysis-window-options__panel">
          <AnalysisGridSamplingField value={samplingSize} options={ANALYSIS_PUPIL_SAMPLING_OPTIONS} onValueChange={(value) => setSamplingSize(Number(value))} title="Ray-traced OPD grid size across the pupil" />
          <label className="analysis-window-field"><span>Zero pad</span><select value={zeroPad} onChange={(event) => setZeroPad(event.target.value as any)} title="Auto 4x: FFT size = OPD grid x4. None: no padding."><option value="auto">Auto 4x</option><option value="none">None</option><option value="512">512</option><option value="1024">1024</option><option value="2048">2048</option><option value="4096">4096</option></select></label>
          <label className="analysis-window-toggle"><input type="checkbox" checked={logScale} onChange={(event) => setLogScale(event.target.checked)} />Log scale</label>
          <label className="analysis-window-field"><span>Color</span><select value={colorMode} onChange={(event) => setColorMode(event.target.value as any)} title="True color renders wavelengths outside the modeled human visual response black. False color gives UV/IR symbolic analysis colours."><option value="pseudo">Pseudo color</option><option value="true">True color</option><option value="false">False color (UV/IR)</option></select></label>
          <label className="analysis-window-field"><span>Wavefront</span><select value={opdMode} onChange={(event) => setOpdMode(event.target.value as any)} title="Raw preserves wavefront tilt and wavelength-dependent image displacement."><option value="raw">Preserve P/T (Raw)</option><option value="pistonTiltRemoved">Remove P/T</option><option value="pistonTiltDefocusRemoved">Remove P/T/D</option></select></label>
          {pipelineBadge ? <span className={`analysis-window-status${pipelineBadge === 'Error' ? ' is-error' : ''}`}>{pipelineBadge}</span> : null}
        </div></details>
        <button className="analysis-window-primary-action" type="button" title="Show PSF" onClick={() => void run()} disabled={busy}>{busy ? 'Calculating…' : 'Show'}</button>
      </div>
      {(busy || !!progressText) ? <ProgressBar value={progress} text={progressText || 'Working...'} /> : null}
      {error ? <div className="analysis-window-error">{error}</div> : null}
      {analysisNote ? <div className="analysis-window-psf-diagnostic">{analysisNote}</div> : null}
      <div className="analysis-window-psf-content">
        <div id="analysis-psf-chart-stats" className="analysis-window-psf-stats" ref={statsRef} />
        <div id="analysis-psf-chart" className="analysis-window-chart analysis-window-psf-chart" ref={chartRef} />
      </div>
    </div>
  );
}
