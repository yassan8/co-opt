import { useCallback, useEffect, useRef, useState } from 'react';
import { runNativeFieldMtfMap } from '../../src/desktop/ipc/client.ts';
import { isTauriRuntime } from '../../src/desktop/runtime.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MtfAnalysisType = 'mtf' | 'through-focus-mtf' | 'field-mtf';

interface WlOption { value: string; label: string; }
interface ObjOption { value: string; label: string; }
type MtfMethodOption = 'hopkins-tcc' | 'legacy-otf-axis';

// ─── Utility helpers (mirror the popup inline scripts) ────────────────────────

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (_) { return fallback; }
}

function getWindowCandidates(): any[] {
  const candidates: any[] = [window as any];
  try {
    const opener = (window as any).opener as any;
    if (opener && !opener.closed && opener !== window) candidates.push(opener);
  } catch (_) {}
  return candidates;
}

function getRowsFromWindow(w: any): { opticalSystemRows: any[]; sourceRows: any[]; objectRows: any[] } {
  if (!w) return { opticalSystemRows: [], sourceRows: [], objectRows: [] };
  let opticalSystemRows = typeof w.getOpticalSystemRows === 'function'
    ? safeCall(() => w.getOpticalSystemRows(w.tableOpticalSystem), [])
    : [];
  const sourceRows = typeof w.getSourceRows === 'function'
    ? safeCall(() => w.getSourceRows(w.tableSource), [])
    : [];
  let objectRows = typeof w.getObjectRows === 'function'
    ? safeCall(() => w.getObjectRows(w.tableObject), [])
    : [];

  try {
    let activeConfig: any = null;
    if (typeof w.getActiveConfiguration === 'function') {
      activeConfig = safeCall(() => w.getActiveConfiguration(), null);
    }
    if (!activeConfig && typeof w.loadSystemConfigurations === 'function') {
      const all = safeCall(() => w.loadSystemConfigurations(), null as any);
      const activeId = Number(all?.activeConfigId);
      const list = Array.isArray(all?.configurations) ? all.configurations : [];
      if (Number.isFinite(activeId)) {
        activeConfig = list.find((cfg: any) => Number(cfg?.id) === activeId) || null;
      }
      if (!activeConfig && list.length > 0) {
        activeConfig = list[0];
      }
    }

    if (activeConfig) {
      let snapshotOpticalRows = Array.isArray(activeConfig?.opticalSystem)
        ? activeConfig.opticalSystem.map((row: any) => (row && typeof row === 'object') ? { ...row } : row)
        : [];
      const metadata = activeConfig?.metadata && typeof activeConfig.metadata === 'object' ? activeConfig.metadata : null;
      const preferImportedRows = snapshotOpticalRows.length > 0 && !!(metadata?.importRowsPreferred || metadata?.importAnalyzeMode);
      if (!preferImportedRows && Array.isArray(activeConfig?.blocks) && activeConfig.blocks.length > 0 && typeof w.expandBlocksToOpticalSystemRows === 'function') {
        const expanded = safeCall(() => w.expandBlocksToOpticalSystemRows(activeConfig.blocks), null as any);
        if (Array.isArray(expanded?.rows) && expanded.rows.length > 0) {
          snapshotOpticalRows = expanded.rows.map((row: any) => (row && typeof row === 'object') ? { ...row } : row);
        }
      }
      const snapshotObjectRows = Array.isArray(activeConfig?.object)
        ? activeConfig.object.map((row: any) => (row && typeof row === 'object') ? { ...row } : row)
        : [];
      if (snapshotOpticalRows.length > 0) opticalSystemRows = snapshotOpticalRows;
      if (snapshotObjectRows.length > 0 && (!Array.isArray(objectRows) || objectRows.length === 0)) {
        objectRows = snapshotObjectRows;
      }
    }
  } catch (_) {}

  if ((!Array.isArray(objectRows) || objectRows.length === 0) && w?.tableObject && Array.isArray(w.tableObject.data) && w.tableObject.data.length > 0) {
    objectRows = w.tableObject.data;
  }

  if (!Array.isArray(objectRows) || objectRows.length === 0) {
    try {
      const raw = w?.localStorage?.getItem?.('objectTableData');
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length > 0) objectRows = parsed;
    } catch (_) {}
  }

  return {
    opticalSystemRows: Array.isArray(opticalSystemRows) ? opticalSystemRows : [],
    sourceRows: Array.isArray(sourceRows) ? sourceRows : [],
    objectRows: Array.isArray(objectRows) ? objectRows : [],
  };
}

function getBestAnalysisWindow(): any {
  let bestWindow: any = window as any;
  let bestScore = -1;
  for (const candidate of getWindowCandidates()) {
    const rows = getRowsFromWindow(candidate);
    const score = rows.opticalSystemRows.length * 1000 + rows.objectRows.length * 100 + rows.sourceRows.length;
    if (score > bestScore) {
      bestWindow = candidate;
      bestScore = score;
    }
  }
  return bestWindow;
}

function sanitizeForceInfinitePupilMode(value: unknown): 'stop' | 'entrance' | '' {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return mode === 'stop' || mode === 'entrance' ? mode : '';
}

function getForcedInfinitePupilMode(): 'stop' | 'entrance' | '' {
  for (const candidate of getWindowCandidates()) {
    try {
      if (typeof candidate?.__cooptGetForceInfinitePupilMode === 'function') {
        const mode = sanitizeForceInfinitePupilMode(candidate.__cooptGetForceInfinitePupilMode());
        if (mode) return mode;
      }
    } catch (_) {}
    try {
      const mode = sanitizeForceInfinitePupilMode(candidate?.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? candidate?.COOPT_FORCE_INFINITE_PUPIL_MODE);
      if (mode) return mode;
    } catch (_) {}
  }
  try {
    return sanitizeForceInfinitePupilMode(localStorage.getItem('coopt.forceInfinitePupilMode'));
  } catch (_) {
    return '';
  }
}

// Dynamically inject the Plotly CDN script if not already loaded.
let plotlyLoadPromise: Promise<void> | null = null;
function loadPlotly(): Promise<void> {
  if ((window as any).Plotly) return Promise.resolve();
  if (plotlyLoadPromise) return plotlyLoadPromise;
  plotlyLoadPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plot.ly/plotly-2.32.0.min.js';
    s.onload = () => resolve();
    s.onerror = () => {
      plotlyLoadPromise = null;
      reject(new Error('Failed to load Plotly from CDN'));
    };
    document.head.appendChild(s);
  });
  return plotlyLoadPromise;
}

let mtfRuntimeWarmupPromise: Promise<void> | null = null;
function warmupMtfRuntime(): Promise<void> {
  if (mtfRuntimeWarmupPromise) return mtfRuntimeWarmupPromise;
  mtfRuntimeWarmupPromise = (async () => {
    try {
      const { preloadRustRayTracingWasm } = await import('../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
      await preloadRustRayTracingWasm();
    } catch (_) {
      // Keep first compute path functional even if warmup fails.
    }
  })();
  return mtfRuntimeWarmupPromise;
}

function getPrimaryWavelength(): number | null {
  for (const w of getWindowCandidates()) {
    if (typeof w?.getPrimaryWavelength !== 'function') continue;
    const v = safeCall(() => Number(w.getPrimaryWavelength()), 0);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function buildWavelengthOptions(): WlOption[] {
  const sources = getRowsFromWindow(getBestAnalysisWindow()).sourceRows;
  const primary = getPrimaryWavelength();
  const out: WlOption[] = [{ value: 'all', label: 'All' }];
  if (Array.isArray(sources) && sources.length > 0) {
    for (const src of sources) {
      const wl = Number(src?.wavelength);
      if (!Number.isFinite(wl) || wl <= 0) continue;
      const nm = wl * 1000;
      const isPrimary = primary !== null && Math.abs(wl - primary) < 1e-9;
      out.push({ value: String(wl), label: isPrimary ? `${nm.toFixed(1)} nm (primary)` : `${nm.toFixed(1)} nm` });
    }
  }
  if (out.length === 1 && primary !== null && primary > 0) {
    out.push({ value: String(primary), label: `${(primary * 1000).toFixed(1)} nm` });
  }
  return out;
}

function buildObjectOptions(): ObjOption[] {
  const objects = getRowsFromWindow(getBestAnalysisWindow()).objectRows;
  if (!Array.isArray(objects) || objects.length === 0) return [{ value: '0', label: '0' }];
  return objects.map((obj, i) => {
    const typeRaw = String(obj?.position ?? obj?.object ?? obj?.Object ?? obj?.objectType ?? 'Point');
    const posNorm = typeRaw.trim().toLowerCase();
    const x = posNorm.includes('imageheight')
      ? (obj?.__cooptImageHeightTarget?.x ?? obj?.xHeight ?? obj?.x ?? obj?.xHeightAngle ?? 0)
      : (obj?.x ?? obj?.xHeightAngle ?? 0);
    const y = posNorm.includes('imageheight')
      ? (obj?.__cooptImageHeightTarget?.y ?? obj?.yHeight ?? obj?.y ?? obj?.yHeightAngle ?? 0)
      : (obj?.y ?? obj?.yHeightAngle ?? 0);
    return { value: String(i), label: `${i + 1}: ${typeRaw} (${x}, ${y})` };
  });
}

function getColorForWavelength(wl: number): string {
  const w = window as any;
  if (typeof w.getColorForWavelength === 'function') {
    const c = safeCall(() => w.getColorForWavelength(wl), '');
    if (typeof c === 'string' && c) return c;
  }
  const nm = wl * 1000;
  if (nm < 470) return '#2563eb';
  if (nm < 530) return '#16a34a';
  if (nm < 600) return '#f59e0b';
  return '#dc2626';
}

interface AxisInfo { mode: 'angle' | 'height'; label: string; unit: string; max: number; }
function getObjectFieldMagnitude(obj: any): number {
  const values = [
    obj?.__cooptImageHeightTarget?.y,
    obj?.__cooptImageHeightTarget?.x,
    obj?.yHeightAngle,
    obj?.y,
    obj?.yHeight,
    obj?.xHeightAngle,
    obj?.x,
    obj?.xHeight,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return 10;
  return Math.max(1e-6, ...values.map((value) => Math.abs(value)));
}

function getObjectAxisMax(objects: any[], axisMode: 'angle' | 'height'): number {
  if (!Array.isArray(objects) || objects.length === 0) return 10;
  const values = objects
    .map((obj) => {
      if (axisMode === 'angle') {
        return Number(obj?.yHeightAngle ?? obj?.yFieldAngle ?? obj?.fieldAngle ?? obj?.y ?? 0);
      }
      return Number(obj?.__cooptImageHeightTarget?.y ?? obj?.yHeight ?? obj?.y ?? obj?.yHeightAngle ?? 0);
    })
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) return 10;
  return Math.max(1e-6, ...values.map((value) => Math.abs(value)));
}

function getAxisInfo(): AxisInfo {
  const host = getBestAnalysisWindow();
  let detectedMode: 'angle' | 'height' | null = null;
  try {
    if (typeof host.getOpticalSystemRows === 'function') {
      const optRows = safeCall(() => host.getOpticalSystemRows(host.tableOpticalSystem), [] as any[]);
      const firstSurf = Array.isArray(optRows) && optRows.length > 0 ? optRows[0] : null;
      if (firstSurf) {
        const thickness = firstSurf.thickness ?? firstSurf.Thickness;
        const isInf = thickness === 'INF' || thickness === Infinity || String(thickness).trim().toUpperCase() === 'INF';
        if (isInf) detectedMode = 'angle';
        else {
          const n = parseFloat(String(thickness));
          if (Number.isFinite(n) && n > 0) detectedMode = 'height';
        }
      }
    }
  } catch (_) {}
  const objects = getRowsFromWindow(host).objectRows;
  const tags = (Array.isArray(objects) ? objects : [])
    .map((obj: any) => String(obj?.position ?? obj?.object ?? obj?.objectType ?? ''))
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  const hasImageHeight = tags.some((tag) => tag.includes('imageheight'));
  const hasAngle = tags.some((tag) => /\bangle\b/.test(tag));
  const hasHeight = tags.some((tag) => tag.includes('rect') || tag.includes('rectangle') || tag.includes('height'));
  let isAngle: boolean;
  if (hasImageHeight) isAngle = false;
  else if (detectedMode === 'angle' && !hasHeight) isAngle = true;
  else if (detectedMode === 'height') isAngle = false;
  else isAngle = hasAngle && !hasHeight;
  let maxVal = 10;
  if (Array.isArray(objects) && objects.length > 0) {
    maxVal = getObjectAxisMax(objects, isAngle ? 'angle' : 'height');
  }
  const axisLabel = isAngle
    ? 'Object Angle (deg)'
    : (hasImageHeight ? 'Image Height (mm)' : 'Object Height (mm)');
  return {
    mode: isAngle ? 'angle' : 'height',
    label: axisLabel,
    unit: isAngle ? 'deg' : 'mm',
    max: maxVal,
  };
}

function defaultWavelength(options: WlOption[]): string {
  const allOpt = options.find(o => o.value === 'all');
  if (allOpt) return allOpt.value;
  const primary = getPrimaryWavelength();
  if (primary !== null) {
    const match = options.find(o => o.value === String(primary));
    if (match) return match.value;
  }
  return options.find(o => o.value !== 'all')?.value ?? options[0]?.value ?? '';
}

function buildWavelengthList(wlValue: string, sourceRows: any[], primary: number | null): number[] {
  const out: number[] = [];
  if (wlValue === 'all') {
    if (Array.isArray(sourceRows) && sourceRows.length > 0) {
      for (const src of sourceRows) {
        const wl = Number(src?.wavelength);
        if (!Number.isFinite(wl) || wl <= 0) continue;
        if (out.some(v => Math.abs(v - wl) < 1e-9)) continue;
        out.push(wl);
      }
    }
    if (out.length === 0 && primary !== null && primary > 0) out.push(primary);
  } else {
    const wl = Number.isFinite(Number(wlValue)) && Number(wlValue) > 0
      ? Number(wlValue)
      : (primary !== null && primary > 0 ? primary : 0.5876);
    out.push(wl);
  }
  if (out.length === 0) out.push(0.5876);
  return out;
}

function buildWeightedWavelengthEntries(
  wlValue: string,
  sourceRows: any[],
  primary: number | null,
): Array<{ wavelength: number; weight: number; label: string }> {
  if (wlValue !== 'all') {
    const wl = Number.isFinite(Number(wlValue)) && Number(wlValue) > 0
      ? Number(wlValue)
      : (primary !== null && primary > 0 ? primary : 0.5876);
    return [{ wavelength: wl, weight: 1, label: `${(wl * 1000).toFixed(1)}nm` }];
  }

  const rows = Array.isArray(sourceRows) ? sourceRows : [];
  const entries = rows
    .map((row: any) => {
      const wl = Number(row?.wavelength);
      if (!Number.isFinite(wl) || wl <= 0) return null;
      const rawWeight = Number(row?.weight);
      const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 1;
      return { wavelength: wl, weight, label: `${(wl * 1000).toFixed(1)}nm` };
    })
    .filter(Boolean) as Array<{ wavelength: number; weight: number; label: string }>;

  if (entries.length === 0) {
    const wl = (primary !== null && primary > 0) ? primary : 0.5876;
    return [{ wavelength: wl, weight: 1, label: `${(wl * 1000).toFixed(1)}nm` }];
  }

  const weightSum = entries.reduce((acc, v) => acc + (Number(v.weight) || 0), 0);
  if (weightSum > 0) {
    return entries.map((v) => ({ ...v, weight: v.weight / weightSum }));
  }
  const uniform = 1 / entries.length;
  return entries.map((v) => ({ ...v, weight: uniform }));
}

function getCompositeWeightForWavelength(
  entries: Array<{ wavelength: number; weight: number }>,
  wavelengthUm: number,
): number {
  if (!Number.isFinite(wavelengthUm) || wavelengthUm <= 0) return 0;
  let sum = 0;
  for (const e of entries) {
    const wl = Number(e?.wavelength);
    if (!Number.isFinite(wl) || wl <= 0) continue;
    if (Math.abs(wl - wavelengthUm) < 1e-9) {
      const w = Number(e?.weight);
      if (Number.isFinite(w) && w > 0) sum += w;
    }
  }
  return sum;
}

function isIdealParaxialOnlySystem(opticalSystemRows: any[] = []): boolean {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return false;
  let hasIdealParaxial = false;
  for (const row of opticalSystemRows) {
    if (!row || typeof row !== 'object') continue;
    const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
    const surfType = String(row?.surfType ?? row?.type ?? row?.surfaceType ?? '').trim().toLowerCase();
    const blockType = String(row?._blockType ?? row?.blockType ?? '').trim().toLowerCase();
    const isIdealParaxial = (
      blockType === 'paraxial'
      || blockType === 'thinlens'
      || surfType === 'thinlens'
      || Number.isFinite(Number(row?._thinLensFocalLengthX))
      || Number.isFinite(Number(row?._thinLensFocalLengthY))
    );
    if (isIdealParaxial) {
      hasIdealParaxial = true;
      continue;
    }
    const isPassiveRow = (
      objectType === ''
      || objectType === 'object'
      || objectType === 'image'
      || objectType === 'stop'
      || surfType === 'gap'
      || surfType === 'air gap'
      || blockType === 'gap'
      || blockType === 'air gap'
      || surfType === 'coordinate break'
      || surfType === 'coordbrk'
      || blockType === 'coordinate break'
      || blockType === 'coordbrk'
    );
    if (isPassiveRow) continue;
    return false;
  }
  return hasIdealParaxial;
}

// ─── Shared style constants ───────────────────────────────────────────────────

const CSS = `
.mtf-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f4f4f4;
  font-family: Arial, sans-serif;
  margin: 0;
}
.mtf-controls {
  padding: 10px 12px;
  background: #f8f8f8;
  border-bottom: 1px solid #ddd;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
  align-items: center;
  flex-shrink: 0;
}
.mtf-controls label { font-size: 12px; color: #333; white-space: nowrap; }
.mtf-controls select, .mtf-controls input[type="number"] {
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid #bbb;
  border-radius: 4px;
  background: white;
}
.mtf-controls input[type="number"] { width: 100px; }
.mtf-controls input[type="checkbox"] { width: auto; }
.mtf-controls button {
  padding: 6px 10px;
  border: 1px solid #bbb;
  background: #f8f8f8;
  cursor: pointer;
  border-radius: 4px;
  font-size: 12px;
  color: #333;
}
.mtf-controls button:hover { background: #e9e9e9; }
.mtf-progress {
  padding: 8px 12px;
  font-size: 12px;
  color: #333;
  border-bottom: 1px solid #eee;
  background: #fff;
  flex-shrink: 0;
}
.mtf-progress progress {
  display: block;
  width: 100%;
  margin-top: 6px;
}
.mtf-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: white;
  display: flex;
  flex-direction: column;
}
.mtf-chart { flex: 1 1 auto; min-height: 0; width: 100%; height: 100%; }
.mtf-error { padding: 20px; color: red; font-size: 13px; }
.mtf-debug {
  padding: 8px 12px;
  border-top: 1px solid #eee;
  background: #fafafa;
  color: #444;
  font-size: 11px;
  white-space: pre-wrap;
  flex-shrink: 0;
 }
`;

const SAMPLING_OPTIONS = ['16', '32', '64', '128', '256', '512', '1024', '2048', '4096'];

// ─── Main component ───────────────────────────────────────────────────────────

export function MtfAnalysisPage({ type }: { type: MtfAnalysisType }) {
  const w = window as any;

  // ── Option state ──
  const [wlOptions, setWlOptions] = useState<WlOption[]>([]);
  const [wavelength, setWavelength] = useState<string>('');
  const [objOptions, setObjOptions] = useState<ObjOption[]>([]);
  const [objectIdx, setObjectIdx] = useState<string>('0');

  // ── Shared computation params ──
  const [sampling, setSampling] = useState(type === 'field-mtf' ? '32' : '256');
  const [removePtd, setRemovePtd] = useState(false);

  // ── MTF-specific ──
    const [maxFreq, setMaxFreq] = useState('100');
    const [plotPoints, setPlotPoints] = useState('21');
    const [showDiffLimit, setShowDiffLimit] = useState(true);
    const [mtfMethod, setMtfMethod] = useState<MtfMethodOption>('hopkins-tcc');

  // ── Through-Focus specific ──
  const [targetFreq, setTargetFreq] = useState('10');
  const [defocusMin, setDefocusMin] = useState('-0.5');
  const [defocusMax, setDefocusMax] = useState('0.5');
  const [tfSteps, setTfSteps] = useState('21');

  // ── Field MTF specific ──
  const [freq1, setFreq1] = useState('10');
  const [freq2, setFreq2] = useState('20');
  const [freq3, setFreq3] = useState('40');
  const [fieldMin, setFieldMin] = useState('0');
  const [fieldMax, setFieldMax] = useState('10');
  const [fieldSteps, setFieldSteps] = useState('21');
  const fieldMaxInitialized = useRef(false);

  // ── Progress / error ──
  const [progressVisible, setProgressVisible] = useState(false);
  const [progressValue, setProgressValue] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  // ── Plotly ──
  const chartRef = useRef<HTMLDivElement>(null);
  const [plotlyReady, setPlotlyReady] = useState(!!(window as any).Plotly);

  useEffect(() => {
    const titleMap: Record<string, string> = {
      'mtf': 'Modulation Transfer Function',
      'through-focus-mtf': 'Through-Focus MTF',
      'field-mtf': 'Object MTF',
    };
    document.title = titleMap[type] ?? 'Analysis';
  }, [type]);

  useEffect(() => {
    loadPlotly().then(() => setPlotlyReady(true)).catch(e => console.error(e));
    void warmupMtfRuntime();
  }, []);

  // ── Sync wavelength/object options ──
  const syncOptions = useCallback(() => {
    const opts = buildWavelengthOptions();
    if (opts.length < 2) return; // tables not ready yet
    setWlOptions(opts);
    setWavelength(prev => prev && opts.some(o => o.value === prev) ? prev : defaultWavelength(opts));
    const objs = buildObjectOptions();
    setObjOptions(objs);
    setObjectIdx(prev => objs.some(o => o.value === prev) ? prev : '0');
    if (type === 'field-mtf' && !fieldMaxInitialized.current) {
      fieldMaxInitialized.current = true;
      const objects = getRowsFromWindow(getBestAnalysisWindow()).objectRows;
      const axisInfo = getAxisInfo();
      setFieldMax(String(getObjectAxisMax(Array.isArray(objects) ? objects : [], axisInfo.mode) || (axisInfo.max || 10)));
    }
  }, [type, objectIdx]);

  useEffect(() => {
    // Initialize tables in the analysis window context  
    if (typeof w.initializeAllTables === 'function') {
      try { w.initializeAllTables(); } catch (_) {}
    }
    syncOptions();
    let tries = 0;
    const interval = setInterval(() => {
      tries++;
      const opts = buildWavelengthOptions();
      if (opts.length > 1) { syncOptions(); clearInterval(interval); return; }
      if (tries > 100) clearInterval(interval);
    }, 100);
    window.addEventListener('coopt:main-ready', syncOptions);
    window.addEventListener('focus', syncOptions);
    return () => {
      clearInterval(interval);
      window.removeEventListener('coopt:main-ready', syncOptions);
      window.removeEventListener('focus', syncOptions);
    };
  }, [syncOptions, w]);

  // ── Progress helpers ──
  const setProgress = useCallback((value: number, text: string) => {
    setProgressVisible(true);
    setProgressValue(Math.max(0, Math.min(100, value)));
    setProgressText(text);
  }, []);
  const hideProgress = useCallback(() => setProgressVisible(false), []);

  // ─── Compute MTF ───────────────────────────────────────────────────────────
  const handleComputeMtf = useCallback(async () => {
    const container = chartRef.current;
    if (!container) return;
    container.innerHTML = '';
    setErrorMsg('');
    const host = getBestAnalysisWindow();
    const primary = getPrimaryWavelength();
    const wlValue = wavelength;
    if (wlValue !== 'all' && !Number.isFinite(Number(wlValue)) && primary === null) {
      setErrorMsg('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
      return;
    }
    const samplingN = Number(sampling) || 256;
    const maxFreqN = Number(maxFreq) || 100;
    const parsedPlotPoints = Math.floor(Number(plotPoints));
    const resolvedPlotPoints = Number.isFinite(parsedPlotPoints)
      ? Math.max(2, Math.min(2048, parsedPlotPoints))
      : 21;
    const maxFreqForSampling = Number.isFinite(maxFreqN) && maxFreqN >= 0 ? maxFreqN : 100;
    const sampleFrequenciesLpmm = Array.from({ length: resolvedPlotPoints }, (_, i) => {
      const t = resolvedPlotPoints > 1 ? (i / (resolvedPlotPoints - 1)) : 0;
      return maxFreqForSampling * t;
    });
    const requestedFftSize = samplingN;
    const opdDisplayMode = removePtd ? 'pistonTiltDefocusRemoved' : 'pistonTiltRemoved';
    const objIdxN = parseInt(objectIdx, 10) || 0;
    const sourceRows: any[] = typeof host?.getSourceRows === 'function'
      ? safeCall(() => host.getSourceRows(host.tableSource), []) : [];
    const wavelengthEntries = buildWeightedWavelengthEntries(wlValue, sourceRows, primary);
    const wavelengthList = wavelengthEntries.map((e) => e.wavelength);
    const useWeightedComposite = wlValue === 'all' && wavelengthEntries.length > 1;
    try {
      if (!plotlyReady) throw new Error('Plotly is not loaded yet');
      if (typeof host?.runDesktopNativeOpdMapForPopup !== 'function') throw new Error('runDesktopNativeOpdMapForPopup unavailable');
      if (typeof host?.runDesktopNativePsfMapForPopup !== 'function') throw new Error('runDesktopNativePsfMapForPopup unavailable');
      if (typeof host?.runDesktopNativeMtfMapForPopup !== 'function') throw new Error('runDesktopNativeMtfMapForPopup unavailable');
      const traces: any[] = [];
      let nyquistGlobal = 0;
      let compositeFreq: number[] | null = null;
      let compositeTan: number[] | null = null;
      let compositeSag: number[] | null = null;
      let compositeDiff: Array<number | null> | null = null;
      const estimateFiniteGridRms = (grid: any): number => {
        if (!Array.isArray(grid) || grid.length === 0) return Number.NaN;
        let sum = 0;
        let sumSq = 0;
        let min = Infinity;
        let max = -Infinity;
        let count = 0;
        for (const row of grid) {
          if (!Array.isArray(row)) continue;
          for (const value of row) {
            const n = Number(value);
            if (n === 0) continue;
            if (!Number.isFinite(n)) continue;
            sum += n;
            sumSq += n * n;
            if (n < min) min = n;
            if (n > max) max = n;
            count += 1;
          }
        }
        if (count === 0) return Number.NaN;
        const mean = sum / count;
        const variance = Math.max(0, (sumSq / count) - (mean * mean));
        return Math.sqrt(variance);
      };
      for (let wli = 0; wli < wavelengthList.length; wli++) {
        const wl = wavelengthList[wli];
        const wlWeight = Number.isFinite(Number(wavelengthEntries[wli]?.weight))
          ? Number(wavelengthEntries[wli]?.weight)
          : (1 / Math.max(1, wavelengthList.length));
        const titleNm = (wl * 1000).toFixed(1);
        const baseProgress = (wli / Math.max(1, wavelengthList.length)) * 80;
        setProgress(10 + baseProgress, `λ=${titleNm}nm: OPD...`);
        const nativeOpdResp = await host.runDesktopNativeOpdMapForPopup({ objectIndex: objIdxN, gridSize: samplingN, wavelengthUm: wl, opdDisplayMode });
        const s = samplingN;
        const opdGrid: Float32Array[] = Array.from({ length: s }, () => new Float32Array(s));
        const ampGrid: Float32Array[] = Array.from({ length: s }, () => new Float32Array(s));
        const maskGrid: boolean[][] = Array.from({ length: s }, () => Array(s).fill(false));
        const displayOpdGrid: any[] = Array.isArray(nativeOpdResp?.displayOpdGrid) ? nativeOpdResp.displayOpdGrid : [];
        const rawOpdGrid: any[] = Array.isArray(nativeOpdResp?.rawOpdGrid) ? nativeOpdResp.rawOpdGrid : [];
        for (let iy = 0; iy < s; iy++) {
          const rowDisplay = displayOpdGrid[iy] || [];
          const rowRaw = rawOpdGrid[iy] || [];
          for (let ix = 0; ix < s; ix++) {
            const rawCell = rowRaw[ix];
            if (rawCell === null || rawCell === undefined || rawCell === '') continue;
            const vRawWaves = Number(rawCell);
            if (!Number.isFinite(vRawWaves)) continue;
            const displayCell = rowDisplay[ix];
            const vDisplayWaves = (displayCell === null || displayCell === undefined || displayCell === '') ? NaN : Number(displayCell);
            const vWaves = Number.isFinite(vDisplayWaves) ? vDisplayWaves : vRawWaves;
            maskGrid[iy][ix] = true;
            opdGrid[iy][ix] = vWaves * wl;
            ampGrid[iy][ix] = 1.0;
          }
        }
        const opticalRows: any[] = typeof host?.getOpticalSystemRows === 'function'
          ? safeCall(() => host.getOpticalSystemRows(host.tableOpticalSystem), []) : [];
        let pupilDiameterMm = 10.0;
        let focalLengthMm = NaN;
        try {
          const diffParams = typeof host?.calculateImageSpaceDiffractionParams === 'function'
            ? host.calculateImageSpaceDiffractionParams(opticalRows, wl) : null;
          const fWork = Number(diffParams?.fNumberWorking);
          const fl = Number(diffParams?.focalLengthMm);
          if (Number.isFinite(fl) && fl > 0 && Number.isFinite(fWork) && fWork > 0) {
            focalLengthMm = Math.abs(fl);
            pupilDiameterMm = focalLengthMm / fWork;
          }
        } catch (_) {}
        if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) {
          try {
            const si = Number(typeof host?.findStopSurfaceIndex === 'function' ? host.findStopSurfaceIndex(opticalRows) : -1);
            const stopRow = (Number.isFinite(si) && si >= 0) ? opticalRows?.[si] : null;
            const sdRaw = stopRow?.semidia ?? stopRow?.Semidia ?? stopRow?.['Semi Diameter'] ?? stopRow?.aperture ?? stopRow?.Aperture ?? NaN;
            const sd = Math.abs(parseFloat(sdRaw));
            if (Number.isFinite(sd) && sd > 0) {
              const isApertureField = !!(stopRow && (stopRow.aperture !== undefined || stopRow.Aperture !== undefined));
              const stopRadiusMm = isApertureField ? sd * 0.5 : sd;
              if (Number.isFinite(stopRadiusMm) && stopRadiusMm > 0) pupilDiameterMm = stopRadiusMm * 2;
            }
          } catch (_) {}
        }
        if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
          try {
            const fl = Number(typeof host?.calculateFocalLength === 'function' ? host.calculateFocalLength(opticalRows, wl) : NaN);
            if (Number.isFinite(fl) && Math.abs(fl) > 1e-9 && fl !== Infinity) focalLengthMm = Math.abs(fl);
          } catch (_) {}
        }
        if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) focalLengthMm = 100.0;
        const basePixelPitchUm = (wl * Math.abs(focalLengthMm)) / Math.max(1e-12, Math.abs(pupilDiameterMm));
        const pixelSizeUm = basePixelPitchUm * (samplingN / requestedFftSize);
        setProgress(20 + baseProgress, `λ=${titleNm}nm: PSF...`);
        const nativePsfResp = await host.runDesktopNativePsfMapForPopup({
          gridOpd: Array.from({ length: s }, (_, iy) => Array.from(opdGrid[iy] || [])),
          gridAmplitude: Array.from({ length: s }, (_, iy) => Array.from(ampGrid[iy] || [])),
          pupilMask: Array.from({ length: s }, (_, iy) => Array.from(maskGrid[iy] || [])),
          wavelengthUm: wl, pixelSizeUm, removeTilt: false, zeroPadTo: requestedFftSize, recenterIfWrapped: false,
        });
        setProgress(30 + baseProgress, `λ=${titleNm}nm: MTF...`);
        const mtfResp = await host.runDesktopNativeMtfMapForPopup({
          psfData: nativePsfResp?.psfData, pixelSizeUm,
          maxFrequencyLpmm: Number.isFinite(maxFreqN) ? maxFreqN : undefined,
          points: resolvedPlotPoints,
          sampleFrequenciesLpmm,
          directEvalOnly: true,
          method: mtfMethod,
        });
        const freq: number[] = Array.isArray(mtfResp?.sampledFrequenciesLpmm) && mtfResp.sampledFrequenciesLpmm.length > 0
          ? mtfResp.sampledFrequenciesLpmm
          : (Array.isArray(mtfResp?.frequencyAxis) ? mtfResp.frequencyAxis : []);
        let tan: number[] = Array.isArray(mtfResp?.sampledMtfTangential) && mtfResp.sampledMtfTangential.length === freq.length
          ? mtfResp.sampledMtfTangential
          : (Array.isArray(mtfResp?.mtfTangential) ? mtfResp.mtfTangential : []);
        let sag: number[] = Array.isArray(mtfResp?.sampledMtfSagittal) && mtfResp.sampledMtfSagittal.length === freq.length
          ? mtfResp.sampledMtfSagittal
          : (Array.isArray(mtfResp?.mtfSagittal) ? mtfResp.mtfSagittal : []);
        if (!freq.length || !tan.length || !sag.length) throw new Error('MTF result does not contain valid curves');

        const currentWavefrontRms = estimateFiniteGridRms(displayOpdGrid);
        const forceIdealParaxialMtf = isIdealParaxialOnlySystem(opticalRows)
          && opdDisplayMode !== 'pistonTiltDefocusRemoved'
          && Number.isFinite(currentWavefrontRms)
          && currentWavefrontRms <= 2e-2;
        let idealDiffCurve: Array<number | null> | null = null;
        if (showDiffLimit || forceIdealParaxialMtf) {
          try {
            const zeroOpdGrid = Array.from({ length: s }, () => Array(s).fill(0));
            const idealNativePsfResp = await host.runDesktopNativePsfMapForPopup({
              gridOpd: zeroOpdGrid,
              gridAmplitude: Array.from({ length: s }, (_, iy) => Array.from(ampGrid[iy] || [])),
              pupilMask: Array.from({ length: s }, (_, iy) => Array.from(maskGrid[iy] || [])),
              wavelengthUm: wl,
              pixelSizeUm,
              removeTilt: false,
              zeroPadTo: requestedFftSize,
              recenterIfWrapped: false,
            });
            const idealMtfResp = await host.runDesktopNativeMtfMapForPopup({
              psfData: idealNativePsfResp?.psfData,
              pixelSizeUm,
              maxFrequencyLpmm: Number.isFinite(maxFreqN) ? maxFreqN : undefined,
              points: resolvedPlotPoints,
              sampleFrequenciesLpmm,
              directEvalOnly: true,
              method: mtfMethod,
            });
            const idealTan = Array.isArray(idealMtfResp?.sampledMtfTangential)
              ? idealMtfResp.sampledMtfTangential
              : (Array.isArray(idealMtfResp?.mtfTangential) ? idealMtfResp.mtfTangential : []);
            const idealSag = Array.isArray(idealMtfResp?.sampledMtfSagittal)
              ? idealMtfResp.sampledMtfSagittal
              : (Array.isArray(idealMtfResp?.mtfSagittal) ? idealMtfResp.mtfSagittal : []);
            if ((idealTan.length === freq.length) || (idealSag.length === freq.length)) {
              idealDiffCurve = freq.map((_, i) => {
                const tv = Number(idealTan[i]);
                const sv = Number(idealSag[i]);
                if (Number.isFinite(tv) && Number.isFinite(sv)) return Math.max(0, Math.min(1, 0.5 * (tv + sv)));
                if (Number.isFinite(tv)) return Math.max(0, Math.min(1, tv));
                if (Number.isFinite(sv)) return Math.max(0, Math.min(1, sv));
                return null;
              });
              if (idealDiffCurve.length > 0 && idealDiffCurve[0] !== null) idealDiffCurve[0] = 1.0;
            }
          } catch (_) {
            idealDiffCurve = null;
          }
        }

        const clampToEnvelope = (vals: number[]) => vals.map((v, i) => {
          const raw = Number(v);
          if (!Number.isFinite(raw)) return null;
          let clamped = Math.max(0, Math.min(1, raw));
          const env = Number(idealDiffCurve?.[i]);
          if (Number.isFinite(env)) clamped = Math.min(clamped, Math.max(0, Math.min(1, env)));
          return clamped;
        });

        if (Array.isArray(idealDiffCurve) && idealDiffCurve.length === freq.length) {
          tan = clampToEnvelope(tan) as number[];
          sag = clampToEnvelope(sag) as number[];
        }
        if (forceIdealParaxialMtf && Array.isArray(idealDiffCurve) && idealDiffCurve.length === freq.length) {
          tan = idealDiffCurve.slice() as number[];
          sag = idealDiffCurve.slice() as number[];
        }

        if (useWeightedComposite) {
          if (!compositeFreq || !compositeTan || !compositeSag) {
            compositeFreq = freq.slice();
            compositeTan = new Array(freq.length).fill(0);
            compositeSag = new Array(freq.length).fill(0);
          }
          const n = Math.min(compositeFreq.length, freq.length, compositeTan.length, compositeSag.length, tan.length, sag.length);
          for (let i = 0; i < n; i++) {
            const tv = Number(tan[i]);
            const sv = Number(sag[i]);
            if (Number.isFinite(tv)) compositeTan[i] += wlWeight * tv;
            if (Number.isFinite(sv)) compositeSag[i] += wlWeight * sv;
          }
        } else {
          const color = getColorForWavelength(wl);
          traces.push({ x: freq, y: tan, type: 'scatter', mode: 'lines', name: `Tangential (${titleNm}nm)`, line: { color, width: 2, dash: 'solid' } });
          traces.push({ x: freq, y: sag, type: 'scatter', mode: 'lines', name: `Sagittal (${titleNm}nm)`, line: { color, width: 2, dash: 'dot' } });
        }
        const nyquist = Number(mtfResp?.nyquistLpmm);
        if (Number.isFinite(nyquist) && nyquist > 0) nyquistGlobal = Math.max(nyquistGlobal, nyquist);
        if (showDiffLimit) {
          try {
            let diffY: Array<number | null> | null = null;
            if (Array.isArray(idealDiffCurve) && idealDiffCurve.length === freq.length) {
              diffY = idealDiffCurve.slice();
            } else {
              const fNumber = Math.abs(focalLengthMm) / Math.max(1e-12, Math.abs(pupilDiameterMm));
              if (Number.isFinite(fNumber) && fNumber > 0) {
                const cutoff = 1000.0 / (Math.max(1e-12, wl) * fNumber);
                diffY = freq.map(f => {
                  const nu = f / Math.max(1e-12, cutoff);
                  if (nu <= 0) return 1;
                  if (nu >= 1) return 0;
                  const c = Math.max(-1, Math.min(1, nu));
                  const val = (2 / Math.PI) * (Math.acos(c) - c * Math.sqrt(Math.max(0, 1 - c * c)));
                  return Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0;
                });
              }
            }
            if (Array.isArray(diffY)) {
              if (useWeightedComposite) {
                if (!compositeDiff || !compositeFreq) {
                  compositeDiff = freq.map(() => 0);
                }
                const n = Math.min(compositeDiff.length, diffY.length);
                for (let i = 0; i < n; i++) {
                  const dv = Number(diffY[i]);
                  if (Number.isFinite(dv) && compositeDiff[i] !== null) {
                    compositeDiff[i] = Number(compositeDiff[i] || 0) + wlWeight * dv;
                  }
                }
              } else {
                const color = getColorForWavelength(wl);
                traces.push({ x: freq, y: diffY, type: 'scatter', mode: 'lines', name: `Diff. Limit (${titleNm}nm)`, line: { color, width: 1.5, dash: 'dash' } });
              }
            }
          } catch (_) {}
        }
      }
      if (useWeightedComposite && compositeFreq && compositeTan && compositeSag) {
        if (compositeTan.length > 0) compositeTan[0] = 1;
        if (compositeSag.length > 0) compositeSag[0] = 1;
        traces.push({
          x: compositeFreq,
          y: compositeTan,
          type: 'scatter',
          mode: 'lines',
          name: 'Tangential (Weighted Composite)',
          line: { color: '#1f4ed8', width: 2, dash: 'solid' }
        });
        traces.push({
          x: compositeFreq,
          y: compositeSag,
          type: 'scatter',
          mode: 'lines',
          name: 'Sagittal (Weighted Composite)',
          line: { color: '#1f4ed8', width: 2, dash: 'dot' }
        });
        if (showDiffLimit && Array.isArray(compositeDiff) && compositeDiff.length === compositeFreq.length) {
          if (compositeDiff.length > 0 && compositeDiff[0] !== null) compositeDiff[0] = 1;
          traces.push({
            x: compositeFreq,
            y: compositeDiff,
            type: 'scatter',
            mode: 'lines',
            name: 'Diff. Limit (Weighted Composite)',
            line: { color: '#1f4ed8', width: 1.5, dash: 'dash' }
          });
        }
      }
      if (!traces.length) throw new Error('MTF did not produce any traces');
      setProgress(80, 'Rendering MTF...');
      const xMax = Number.isFinite(maxFreqN) && maxFreqN > 0 ? maxFreqN : (nyquistGlobal > 0 ? nyquistGlobal : undefined);
      await (window as any).Plotly.newPlot(container, traces, {
        margin: { l: 50, r: 20, t: 28, b: 42 },
        xaxis: { title: 'Spatial frequency (lp/mm)', ...(Number.isFinite(xMax) ? { range: [0, xMax] } : {}) },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        showlegend: true,
      }, { responsive: true });
      hideProgress();
    } catch (err: any) {
      setProgress(100, 'Failed');
      setErrorMsg(String(err?.message ?? err ?? 'Unknown error'));
    }
  }, [w, wavelength, objectIdx, sampling, removePtd, maxFreq, plotPoints, showDiffLimit, mtfMethod, plotlyReady, setProgress, hideProgress]);

  // ─── Compute Through-Focus MTF ─────────────────────────────────────────────
  const handleComputeThroughFocusMtf = useCallback(async () => {
    const container = chartRef.current;
    if (!container) return;
    container.innerHTML = '';
    setErrorMsg('');
    const primary = getPrimaryWavelength();
    const wlValue = wavelength;
    if (wlValue !== 'all' && !Number.isFinite(Number(wlValue)) && primary === null) {
      setErrorMsg('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
      return;
    }
    const samplingN = Number(sampling) || 256;
    const zeroPadTo = samplingN;
    const opdDisplayMode = removePtd ? 'pistonTiltDefocusRemoved' : 'pistonTiltRemoved';
    const sourceRows: any[] = typeof w.getSourceRows === 'function'
      ? safeCall(() => w.getSourceRows(w.tableSource), []) : [];
    const wavelengthEntries = buildWeightedWavelengthEntries(wlValue, sourceRows, primary);
    const wavelengthList = wavelengthEntries.map((e) => e.wavelength);
    const useWeightedComposite = wlValue === 'all' && wavelengthEntries.length > 1;
    const targetFreqN = Number(targetFreq) || 10;
    const defocusMinN = Number(defocusMin);
    const defocusMaxN = Number(defocusMax);
    const stepsN = Number(tfSteps) || 21;
    const objIdxN = parseInt(objectIdx, 10) || 0;
    try {
      if (!plotlyReady) throw new Error('Plotly is not loaded yet');
      const throughFocusRunner = (!isTauriRuntime() && typeof w.runPortableThroughFocusMtfForPopup === 'function')
        ? w.runPortableThroughFocusMtfForPopup
        : (typeof w.runDesktopNativeThroughFocusMtfForPopup === 'function'
          ? w.runDesktopNativeThroughFocusMtfForPopup
          : (typeof w.runPortableThroughFocusMtfForPopup === 'function' ? w.runPortableThroughFocusMtfForPopup : null));
      if (typeof throughFocusRunner !== 'function') throw new Error('Through-Focus MTF runner unavailable');
      setProgress(0, 'Starting...');
      await new Promise(r => setTimeout(r, 0));
      let lastProgress = 20;
      setProgress(lastProgress, 'Computing Through-Focus MTF...');
      const nativeResp = await throughFocusRunner({
        objectIndex: objIdxN, wavelengths: wavelengthList,
        targetFrequencyLpmm: targetFreqN, defocusMinMm: defocusMinN, defocusMaxMm: defocusMaxN,
        steps: stepsN, samplingSize: samplingN, zeroPadTo, opdDisplayMode,
        method: mtfMethod,
        onProgress: (evt: any) => {
          const p = Number(evt?.percent);
          const msg = String(evt?.message || 'Computing Through-Focus MTF...');
          if (Number.isFinite(p)) { lastProgress = Math.max(lastProgress, p); setProgress(lastProgress, msg); }
          else setProgress(lastProgress, msg);
        },
      });
      const xAxis: number[] = Array.isArray(nativeResp?.xAxis) ? nativeResp.xAxis : [];
      const series: any[] = Array.isArray(nativeResp?.series) ? nativeResp.series : [];
      if (!xAxis.length || !series.length) throw new Error('Through-Focus MTF did not produce valid data');
      const traces: any[] = [];
      if (useWeightedComposite) {
        const tanComposite = new Array(xAxis.length).fill(0);
        const sagComposite = new Array(xAxis.length).fill(0);
        for (const s of series) {
          const wl = Number(s?.wavelengthUm);
          const ww = getCompositeWeightForWavelength(wavelengthEntries, wl);
          if (!(ww > 0)) continue;
          const tan: number[] = Array.isArray(s?.mtfTangential) ? s.mtfTangential : [];
          const sag: number[] = Array.isArray(s?.mtfSagittal) ? s.mtfSagittal : [];
          const n = Math.min(xAxis.length, tanComposite.length, sagComposite.length, tan.length, sag.length);
          for (let i = 0; i < n; i++) {
            const tv = Number(tan[i]);
            const sv = Number(sag[i]);
            if (Number.isFinite(tv)) tanComposite[i] += ww * tv;
            if (Number.isFinite(sv)) sagComposite[i] += ww * sv;
          }
        }
        // NOTE: Do NOT force [0] = 1 for defocus-axis TF-MTF. The [0] position
        // represents defocusMinMm, not the DC (0 frequency) component.
        // Only frequency-axis MTF should have [0] = 1 (representing 0 lp/mm).
        traces.push({
          x: xAxis,
          y: tanComposite,
          type: 'scatter',
          mode: 'lines',
          name: 'Meridional (Weighted Composite)',
          line: { color: '#1f4ed8', width: 2, dash: 'solid' }
        });
        traces.push({
          x: xAxis,
          y: sagComposite,
          type: 'scatter',
          mode: 'lines',
          name: 'Sagittal (Weighted Composite)',
          line: { color: '#1f4ed8', width: 2, dash: 'dot' }
        });
      } else {
        for (const s of series) {
          const wl = Number(s.wavelengthUm);
          const nm = Number.isFinite(wl) ? (wl * 1000).toFixed(1) : 'N/A';
          const color = getColorForWavelength(wl);
          const tan: number[] = Array.isArray(s.mtfTangential) ? s.mtfTangential : [];
          const sag: number[] = Array.isArray(s.mtfSagittal) ? s.mtfSagittal : [];
          traces.push({ x: xAxis, y: tan, type: 'scatter', mode: 'lines', name: `Meridional (${nm}nm)`, line: { color, width: 2, dash: 'solid' } });
          traces.push({ x: xAxis, y: sag, type: 'scatter', mode: 'lines', name: `Sagittal (${nm}nm)`, line: { color, width: 2, dash: 'dot' } });
        }
      }
      setProgress(85, 'Rendering...');
      await (window as any).Plotly.newPlot(container, traces, {
        title: `${Number.isFinite(targetFreqN) ? targetFreqN.toFixed(1) : 10} lp/mm`,
        xaxis: { title: 'Defocus shift (mm)' },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        margin: { l: 60, r: 20, t: 50, b: 50 },
        showlegend: true,
      }, { responsive: true, displaylogo: false });
      hideProgress();
    } catch (err: any) {
      setProgress(100, 'Failed');
      setErrorMsg(String(err?.message ?? err ?? 'Unknown error'));
    }
  }, [w, wavelength, objectIdx, sampling, removePtd, targetFreq, defocusMin, defocusMax, tfSteps, mtfMethod, plotlyReady, setProgress, hideProgress]);

  // ─── Compute Field MTF ─────────────────────────────────────────────────────
  // Rust+WASM native path (runNativeFieldMtfMap). Both Tauri and Web go through
  // the same OPD → PSF → MTF native pipeline for field sweep.
  const handleComputeFieldMtf = useCallback(async () => {
    const container = chartRef.current;
    if (!container) return;
    container.innerHTML = '';
    setErrorMsg('');
    const primary = getPrimaryWavelength();
    const wlValue = wavelength;
    if (wlValue !== 'all' && !Number.isFinite(Number(wlValue)) && primary === null) {
      setErrorMsg('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
      return;
    }
    const samplingN = Number(sampling) || 256;
    const zeroPadTo = samplingN;
    const opdDisplayMode = removePtd ? 'pistonTiltDefocusRemoved' : 'pistonTiltRemoved';
    const host = getBestAnalysisWindow();
    const { opticalSystemRows, sourceRows, objectRows } = getRowsFromWindow(host);
    const wavelengthEntries = buildWeightedWavelengthEntries(wlValue, sourceRows, primary);
    const wavelengthList = wavelengthEntries.map((e) => e.wavelength);
    const useWeightedComposite = wlValue === 'all' && wavelengthEntries.length > 1;
    const axisInfo = getAxisInfo();
    const forcedPupilSamplingMode = getForcedInfinitePupilMode();
    const fieldMinN = Number(fieldMin);
    const fieldMaxN = Number(fieldMax) || 10;
    const stepsN = Number(fieldSteps) || 21;
    const freq1N = Number(freq1) || 10;
    const freq2N = Number(freq2) || 20;
    const freq3N = Number(freq3) || 40;
    try {
      if (!plotlyReady) throw new Error('Plotly is not loaded yet');
      setProgress(0, 'Starting...');
      await new Promise(r => setTimeout(r, 0));
      setProgress(20, 'Computing Object MTF via Rust...');
      const commonPayload = {
        sampleFromObjectRows: false,
        wavelengths: wavelengthList,
        method: mtfMethod,
        firstFrequencyLpmm: freq1N,
        secondFrequencyLpmm: freq2N,
        thirdFrequencyLpmm: freq3N,
        fieldMin: fieldMinN,
        fieldMax: fieldMaxN,
        steps: stepsN,
        samplingSize: samplingN,
        zeroPadTo,
        opdDisplayMode,
        pupilSamplingMode: forcedPupilSamplingMode || undefined,
        fieldAxisMode: axisInfo.mode,
        onProgress: (evt: any) => {
          const p = Number(evt?.percent);
          const msg = String(evt?.message || 'Computing Object MTF via Rust...');
          if (Number.isFinite(p)) setProgress(p, msg);
          else setProgress(20, msg);
        },
      };
      let nativeResp: any;
      try {
        nativeResp = await runNativeFieldMtfMap({
          opticalSystemRows,
          sourceRows,
          objectRows,
          ...commonPayload,
        } as any);
      } catch (localErr) {
        const portableFieldMtf = typeof host?.runPortableFieldMtfForPopup === 'function'
          ? host.runPortableFieldMtfForPopup.bind(host)
          : null;
        if (!portableFieldMtf) {
          throw localErr;
        }
        nativeResp = await portableFieldMtf(commonPayload);
      }
      const xAxis: number[] = Array.isArray((nativeResp as any)?.xAxis) ? (nativeResp as any).xAxis : [];
      const series: any[] = Array.isArray((nativeResp as any)?.series) ? (nativeResp as any).series : [];
      if (!xAxis.length || !series.length) throw new Error('Object MTF did not produce valid data');
      const firstFreqText = String(Number.isFinite(freq1N) ? freq1N.toFixed(1) : '10.0');
      const secondFreqText = String(Number.isFinite(freq2N) ? freq2N.toFixed(1) : '20.0');
      const thirdFreqText = String(Number.isFinite(freq3N) ? freq3N.toFixed(1) : '40.0');
      const freq1Color = '#1d4ed8';
      const freq2Color = '#d97706';
      const freq3Color = '#059669';
      const traces: any[] = [];
      if (useWeightedComposite) {
        const meridionalFirstComposite = new Array(xAxis.length).fill(0);
        const sagittalFirstComposite = new Array(xAxis.length).fill(0);
        const meridionalSecondComposite = new Array(xAxis.length).fill(0);
        const sagittalSecondComposite = new Array(xAxis.length).fill(0);
        const meridionalThirdComposite = new Array(xAxis.length).fill(0);
        const sagittalThirdComposite = new Array(xAxis.length).fill(0);
        for (let si = 0; si < series.length; si++) {
          const s = series[si];
          const wl = Number(s?.wavelengthUm);
          const ww = getCompositeWeightForWavelength(wavelengthEntries, wl);
          if (!(ww > 0)) continue;
          const m1 = Array.isArray(s?.meridionalFirst) ? s.meridionalFirst : [];
          const s1 = Array.isArray(s?.sagittalFirst) ? s.sagittalFirst : [];
          const m2 = Array.isArray(s?.meridionalSecond) ? s.meridionalSecond : [];
          const s2 = Array.isArray(s?.sagittalSecond) ? s.sagittalSecond : [];
          const m3 = Array.isArray(s?.meridionalThird) ? s.meridionalThird : [];
          const s3v = Array.isArray(s?.sagittalThird) ? s.sagittalThird : [];
          const n = Math.min(xAxis.length, m1.length, s1.length, m2.length, s2.length, m3.length, s3v.length);
          for (let i = 0; i < n; i++) {
            const vM1 = Number(m1[i]);
            const vS1 = Number(s1[i]);
            const vM2 = Number(m2[i]);
            const vS2 = Number(s2[i]);
            const vM3 = Number(m3[i]);
            const vS3 = Number(s3v[i]);
            if (Number.isFinite(vM1)) meridionalFirstComposite[i] += ww * vM1;
            if (Number.isFinite(vS1)) sagittalFirstComposite[i] += ww * vS1;
            if (Number.isFinite(vM2)) meridionalSecondComposite[i] += ww * vM2;
            if (Number.isFinite(vS2)) sagittalSecondComposite[i] += ww * vS2;
            if (Number.isFinite(vM3)) meridionalThirdComposite[i] += ww * vM3;
            if (Number.isFinite(vS3)) sagittalThirdComposite[i] += ww * vS3;
          }
        }
        traces.push({
          x: xAxis,
          y: meridionalFirstComposite,
          type: 'scatter', mode: 'lines',
          name: `Meridional ${firstFreqText} lp/mm (Weighted Composite)`,
          line: { color: freq1Color, width: 2, dash: 'dot' },
        });
        traces.push({
          x: xAxis,
          y: sagittalFirstComposite,
          type: 'scatter', mode: 'lines',
          name: `Sagittal ${firstFreqText} lp/mm (Weighted Composite)`,
          line: { color: freq1Color, width: 2, dash: 'solid' },
        });
        traces.push({
          x: xAxis,
          y: meridionalSecondComposite,
          type: 'scatter', mode: 'lines',
          name: `Meridional ${secondFreqText} lp/mm (Weighted Composite)`,
          line: { color: freq2Color, width: 2, dash: 'dot' },
        });
        traces.push({
          x: xAxis,
          y: sagittalSecondComposite,
          type: 'scatter', mode: 'lines',
          name: `Sagittal ${secondFreqText} lp/mm (Weighted Composite)`,
          line: { color: freq2Color, width: 2, dash: 'solid' },
        });
        traces.push({
          x: xAxis,
          y: meridionalThirdComposite,
          type: 'scatter', mode: 'lines',
          name: `Meridional ${thirdFreqText} lp/mm (Weighted Composite)`,
          line: { color: freq3Color, width: 2, dash: 'dot' },
        });
        traces.push({
          x: xAxis,
          y: sagittalThirdComposite,
          type: 'scatter', mode: 'lines',
          name: `Sagittal ${thirdFreqText} lp/mm (Weighted Composite)`,
          line: { color: freq3Color, width: 2, dash: 'solid' },
        });
      } else {
        for (let si = 0; si < series.length; si++) {
          const s = series[si];
          const wl = Number(s.wavelengthUm);
          const nm = Number.isFinite(wl) ? (wl * 1000).toFixed(1) : 'N/A';
          traces.push({
            x: xAxis,
            y: Array.isArray(s.meridionalFirst) ? s.meridionalFirst : [],
            type: 'scatter', mode: 'lines',
            name: `Meridional ${firstFreqText} lp/mm (${nm}nm)`,
            line: { color: freq1Color, width: 2, dash: 'dot' },
          });
          traces.push({
            x: xAxis,
            y: Array.isArray(s.sagittalFirst) ? s.sagittalFirst : [],
            type: 'scatter', mode: 'lines',
            name: `Sagittal ${firstFreqText} lp/mm (${nm}nm)`,
            line: { color: freq1Color, width: 2, dash: 'solid' },
          });
          traces.push({
            x: xAxis,
            y: Array.isArray(s.meridionalSecond) ? s.meridionalSecond : [],
            type: 'scatter', mode: 'lines',
            name: `Meridional ${secondFreqText} lp/mm (${nm}nm)`,
            line: { color: freq2Color, width: 2, dash: 'dot' },
          });
          traces.push({
            x: xAxis,
            y: Array.isArray(s.sagittalSecond) ? s.sagittalSecond : [],
            type: 'scatter', mode: 'lines',
            name: `Sagittal ${secondFreqText} lp/mm (${nm}nm)`,
            line: { color: freq2Color, width: 2, dash: 'solid' },
          });
          traces.push({
            x: xAxis,
            y: Array.isArray(s?.meridionalThird) ? s.meridionalThird : [],
            type: 'scatter', mode: 'lines',
            name: `Meridional ${thirdFreqText} lp/mm (${nm}nm)`,
            line: { color: freq3Color, width: 2, dash: 'dot' },
          });
          traces.push({
            x: xAxis,
            y: Array.isArray(s?.sagittalThird) ? s.sagittalThird : [],
            type: 'scatter', mode: 'lines',
            name: `Sagittal ${thirdFreqText} lp/mm (${nm}nm)`,
            line: { color: freq3Color, width: 2, dash: 'solid' },
          });
        }
      }
      const nonEmptyTraces = traces.filter(t => Array.isArray(t.y) && t.y.length > 0);
      if (!nonEmptyTraces.length) throw new Error('Object MTF did not produce plottable traces');
      setProgress(90, 'Rendering...');
      await (window as any).Plotly.newPlot(container, nonEmptyTraces, {
        title: `${firstFreqText} / ${secondFreqText} / ${thirdFreqText} lp/mm`,
        xaxis: { title: axisInfo.label },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        margin: { l: 60, r: 20, t: 40, b: 50 },
        showlegend: true,
      }, { responsive: true, displaylogo: false });
      hideProgress();
      window.requestAnimationFrame(() => {
        try { (window as any).Plotly?.Plots?.resize?.(container); } catch (_) {}
      });
    } catch (err: any) {
      setProgress(100, 'Failed');
      setErrorMsg(String(err?.message ?? err ?? 'Unknown error'));
    }
  }, [w, wavelength, objectIdx, sampling, removePtd, freq1, freq2, freq3, fieldMin, fieldMax, fieldSteps, mtfMethod, plotlyReady, setProgress, hideProgress]);

  const handleCompute = type === 'mtf' ? handleComputeMtf
    : type === 'through-focus-mtf' ? handleComputeThroughFocusMtf
      : handleComputeFieldMtf;

  // ─── Render ────────────────────────────────────────────────────────────────

  const wlSelect = (
    <><label>Wavelength:</label>
      <select value={wavelength} onChange={e => setWavelength(e.target.value)}>
        {wlOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select></>
  );
  const samplingSelect = (
    <><label>Sampling:</label>
      <select value={sampling} onChange={e => setSampling(e.target.value)}>
        {SAMPLING_OPTIONS.map(v => <option key={v} value={v}>{v}×{v}</option>)}
      </select></>
  );
  const removePtdChk = (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input type="checkbox" checked={removePtd} onChange={e => setRemovePtd(e.target.checked)} />
      Remove P/T/D
    </label>
  );

  return (
    <div className="mtf-page">
      <style>{CSS}</style>
      <div className="mtf-controls">
        {wlSelect}
        {type !== 'field-mtf' && (
          <><label>Object:</label>
            <select value={objectIdx} onChange={e => setObjectIdx(e.target.value)}>
              {objOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select></>
        )}
        {type === 'mtf' && (<>
          <input type="number" min="0" step="1" value={maxFreq} onChange={e => setMaxFreq(e.target.value)} />
          <label>Points:</label>
          <input type="text" value={plotPoints} onChange={e => setPlotPoints(e.target.value)} />
        </>)}
        {type === 'through-focus-mtf' && (<>
          <label>Freq (lp/mm):</label>
          <input type="number" min="0" step="1" value={targetFreq} onChange={e => setTargetFreq(e.target.value)} />
          <label>Defocus min (mm):</label>
          <input type="number" step="0.001" value={defocusMin} onChange={e => setDefocusMin(e.target.value)} />
          <label>Defocus max (mm):</label>
          <input type="number" step="0.001" value={defocusMax} onChange={e => setDefocusMax(e.target.value)} />
          <label>Steps:</label>
          <input type="number" min="3" max="201" step="1" value={tfSteps} onChange={e => setTfSteps(e.target.value)} />
        </>)}
        {type === 'field-mtf' && (<>
          <label>1st Freq (lp/mm):</label>
          <input type="number" min="0" step="1" value={freq1} onChange={e => setFreq1(e.target.value)} />
          <label>2nd Freq (lp/mm):</label>
          <input type="number" min="0" step="1" value={freq2} onChange={e => setFreq2(e.target.value)} />
          <label>3rd Freq (lp/mm):</label>
          <input type="number" min="0" step="1" value={freq3} onChange={e => setFreq3(e.target.value)} />
          <label>Object min:</label>
          <input type="number" step="0.001" value={fieldMin} onChange={e => setFieldMin(e.target.value)} />
          <label>Object max:</label>
          <input type="number" step="0.001" value={fieldMax} onChange={e => setFieldMax(e.target.value)} />
          <label>Steps:</label>
          <input type="number" min="3" max="201" step="1" value={fieldSteps} onChange={e => setFieldSteps(e.target.value)} />
        </>)}
        {samplingSelect}
        {removePtdChk}
        <>
          <label>Method:</label>
          <select value={mtfMethod} onChange={e => setMtfMethod(e.target.value as MtfMethodOption)}>
            <option value="hopkins-tcc">Hopkins-TCC</option>
            <option value="legacy-otf-axis">Legacy OTF Axis</option>
          </select>
        </>
        {type === 'mtf' && (<>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={showDiffLimit} onChange={e => setShowDiffLimit(e.target.checked)} />
            Diffraction Limit
          </label>
        </>)}
        <button type="button" onClick={handleCompute}>Show {type === 'mtf' ? 'MTF' : 'Plot'}</button>
      </div>
      {progressVisible && (
        <div className="mtf-progress">
          <div>{progressText}</div>
          <progress max={100} value={progressValue} />
        </div>
      )}
      <div className="mtf-content">
        {errorMsg ? <div className="mtf-error">{errorMsg}</div> : null}
        <div className="mtf-chart" ref={chartRef} />
      </div>
    </div>
  );
}
