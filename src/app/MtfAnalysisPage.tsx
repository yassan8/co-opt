import { useCallback, useEffect, useRef, useState } from 'react';
import { runNativeFieldMtfMap } from '../../src/desktop/ipc/client.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type MtfAnalysisType = 'mtf' | 'through-focus-mtf' | 'field-mtf';

interface WlOption { value: string; label: string; }
interface ObjOption { value: string; label: string; }

// ─── Utility helpers (mirror the popup inline scripts) ────────────────────────

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (_) { return fallback; }
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

function getPrimaryWavelength(): number | null {
  const w = window as any;
  if (typeof w.getPrimaryWavelength !== 'function') return null;
  const v = safeCall(() => Number(w.getPrimaryWavelength()), 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function buildWavelengthOptions(): WlOption[] {
  const w = window as any;
  const sources: any[] = typeof w.getSourceRows === 'function'
    ? safeCall(() => w.getSourceRows(w.tableSource), [])
    : [];
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
  const w = window as any;
  const objects: any[] = typeof w.getObjectRows === 'function'
    ? safeCall(() => w.getObjectRows(w.tableObject), [])
    : [];
  if (!Array.isArray(objects) || objects.length === 0) return [{ value: '0', label: '0' }];
  return objects.map((obj, i) => {
    const typeRaw = String(obj?.position ?? obj?.object ?? obj?.Object ?? obj?.objectType ?? 'Point');
    const x = obj?.x ?? obj?.xHeightAngle ?? 0;
    const y = obj?.y ?? obj?.yHeightAngle ?? 0;
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
function getAxisInfo(): AxisInfo {
  const w = window as any;
  let detectedMode: 'angle' | 'height' | null = null;
  try {
    if (typeof w.getOpticalSystemRows === 'function') {
      const optRows = safeCall(() => w.getOpticalSystemRows(w.tableOpticalSystem), [] as any[]);
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
  const objects: any[] = typeof w.getObjectRows === 'function'
    ? safeCall(() => w.getObjectRows(w.tableObject), [])
    : [];
  const first = Array.isArray(objects) && objects.length > 0 ? objects[0] : null;
  let isAngle: boolean;
  if (detectedMode === 'angle') isAngle = true;
  else if (detectedMode === 'height') isAngle = false;
  else {
    const posRaw = String(first?.position ?? first?.object ?? first?.objectType ?? 'Angle');
    isAngle = /\bangle\b/i.test(posRaw);
  }
  let maxVal = 10;
  if (Array.isArray(objects) && objects.length > 0) {
    const vals = objects.map((o: any) => Number(o?.yHeightAngle)).filter((v) => Number.isFinite(v));
    if (vals.length > 0) maxVal = Math.max(1e-6, Math.max(...vals.map(Math.abs)));
  }
  return {
    mode: isAngle ? 'angle' : 'height',
    label: isAngle ? 'Object Angle (deg)' : 'Object Height (mm)',
    unit: isAngle ? 'deg' : 'mm',
    max: maxVal,
  };
}

function defaultWavelength(options: WlOption[]): string {
  const primary = getPrimaryWavelength();
  if (primary !== null) {
    const match = options.find(o => o.value === String(primary));
    if (match) return match.value;
  }
  return options.find(o => o.value !== 'all')?.value ?? options[0]?.value ?? '';
}

function computeZeroPadTo(zeroPad: string, sampling: number): number {
  if (zeroPad === 'none') return Number.isFinite(sampling) ? sampling : 256;
  if (zeroPad === 'auto') return 0;
  const n = parseInt(zeroPad, 10);
  return Number.isFinite(n) ? n : 0;
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
.mtf-chart { flex: 1 1 auto; min-height: 0; }
.mtf-error { padding: 20px; color: red; font-size: 13px; }
`;

const SAMPLING_OPTIONS = ['32', '64', '128', '256', '512', '1024', '2048', '4096'];
const ZERO_PAD_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'auto', label: 'Auto' },
  { value: '512', label: '512' },
  { value: '1024', label: '1024' },
  { value: '2048', label: '2048' },
  { value: '4096', label: '4096' },
];

// ─── Main component ───────────────────────────────────────────────────────────

export function MtfAnalysisPage({ type }: { type: MtfAnalysisType }) {
  const w = window as any;

  // ── Option state ──
  const [wlOptions, setWlOptions] = useState<WlOption[]>([]);
  const [wavelength, setWavelength] = useState<string>('');
  const [objOptions, setObjOptions] = useState<ObjOption[]>([]);
  const [objectIdx, setObjectIdx] = useState<string>('0');

  // ── Shared computation params ──
  const [sampling, setSampling] = useState('256');
  const [zeroPad, setZeroPad] = useState('auto');
  const [removePtd, setRemovePtd] = useState(false);

  // ── MTF-specific ──
  const [maxFreq, setMaxFreq] = useState('100');
  const [showDiffLimit, setShowDiffLimit] = useState(true);

  // ── Through-Focus specific ──
  const [targetFreq, setTargetFreq] = useState('10');
  const [defocusMin, setDefocusMin] = useState('-0.5');
  const [defocusMax, setDefocusMax] = useState('0.5');
  const [tfSteps, setTfSteps] = useState('21');

  // ── Field MTF specific ──
  const [freq1, setFreq1] = useState('10');
  const [freq2, setFreq2] = useState('30');
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
  }, []);

  // ── Sync wavelength/object options ──
  const syncOptions = useCallback(() => {
    const opts = buildWavelengthOptions();
    if (opts.length < 2) return; // tables not ready yet
    setWlOptions(opts);
    setWavelength(prev => prev && opts.some(o => o.value === prev) ? prev : defaultWavelength(opts));
    if (type !== 'field-mtf') {
      const objs = buildObjectOptions();
      setObjOptions(objs);
      setObjectIdx(prev => objs.some(o => o.value === prev) ? prev : '0');
    }
    if (type === 'field-mtf' && !fieldMaxInitialized.current) {
      fieldMaxInitialized.current = true;
      const axisInfo = getAxisInfo();
      setFieldMax(String(axisInfo.max || 10));
    }
  }, [type]);

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
    const primary = getPrimaryWavelength();
    const wlValue = wavelength;
    if (wlValue !== 'all' && !Number.isFinite(Number(wlValue)) && primary === null) {
      setErrorMsg('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
      return;
    }
    const samplingN = Number(sampling) || 256;
    const maxFreqN = Number(maxFreq) || 100;
    const zeroPadTo = computeZeroPadTo(zeroPad, samplingN);
    const opdDisplayMode = removePtd ? 'pistonTiltDefocusRemoved' : 'pistonTiltRemoved';
    const objIdxN = parseInt(objectIdx, 10) || 0;
    const sourceRows: any[] = typeof w.getSourceRows === 'function'
      ? safeCall(() => w.getSourceRows(w.tableSource), []) : [];
    const wavelengthList = buildWavelengthList(wlValue, sourceRows, primary);
    try {
      if (!plotlyReady) throw new Error('Plotly is not loaded yet');
      if (typeof w.runDesktopNativeOpdMapForPopup !== 'function') throw new Error('runDesktopNativeOpdMapForPopup unavailable');
      if (typeof w.runDesktopNativePsfMapForPopup !== 'function') throw new Error('runDesktopNativePsfMapForPopup unavailable');
      if (typeof w.runDesktopNativeMtfMapForPopup !== 'function') throw new Error('runDesktopNativeMtfMapForPopup unavailable');
      const traces: any[] = [];
      let nyquistGlobal = 0;
      for (let wli = 0; wli < wavelengthList.length; wli++) {
        const wl = wavelengthList[wli];
        const titleNm = (wl * 1000).toFixed(1);
        const baseProgress = (wli / Math.max(1, wavelengthList.length)) * 80;
        setProgress(10 + baseProgress, `λ=${titleNm}nm: OPD...`);
        const nativeOpdResp = await w.runDesktopNativeOpdMapForPopup({ objectIndex: objIdxN, gridSize: samplingN, wavelengthUm: wl, opdDisplayMode });
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
        const opticalRows: any[] = typeof w.getOpticalSystemRows === 'function'
          ? safeCall(() => w.getOpticalSystemRows(w.tableOpticalSystem), []) : [];
        let pupilDiameterMm = 10.0;
        let focalLengthMm = NaN;
        try {
          const diffParams = typeof w.calculateImageSpaceDiffractionParams === 'function'
            ? w.calculateImageSpaceDiffractionParams(opticalRows, wl) : null;
          const fWork = Number(diffParams?.fNumberWorking);
          const fl = Number(diffParams?.focalLengthMm);
          if (Number.isFinite(fl) && fl > 0 && Number.isFinite(fWork) && fWork > 0) {
            focalLengthMm = Math.abs(fl);
            pupilDiameterMm = focalLengthMm / fWork;
          }
        } catch (_) {}
        if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) {
          try {
            const si = Number(typeof w.findStopSurfaceIndex === 'function' ? w.findStopSurfaceIndex(opticalRows) : -1);
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
            const fl = Number(typeof w.calculateFocalLength === 'function' ? w.calculateFocalLength(opticalRows, wl) : NaN);
            if (Number.isFinite(fl) && Math.abs(fl) > 1e-9 && fl !== Infinity) focalLengthMm = Math.abs(fl);
          } catch (_) {}
        }
        if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) focalLengthMm = 100.0;
        const minRecommendedFftSize = 512;
        const requestedFftSize = (!zeroPadTo || zeroPadTo === 0)
          ? Math.max(samplingN, minRecommendedFftSize) : Math.max(samplingN, zeroPadTo);
        const basePixelPitchUm = (wl * Math.abs(focalLengthMm)) / Math.max(1e-12, Math.abs(pupilDiameterMm));
        const pixelSizeUm = basePixelPitchUm * (samplingN / requestedFftSize);
        setProgress(20 + baseProgress, `λ=${titleNm}nm: PSF...`);
        const nativePsfResp = await w.runDesktopNativePsfMapForPopup({
          gridOpd: Array.from({ length: s }, (_, iy) => Array.from(opdGrid[iy] || [])),
          gridAmplitude: Array.from({ length: s }, (_, iy) => Array.from(ampGrid[iy] || [])),
          pupilMask: Array.from({ length: s }, (_, iy) => Array.from(maskGrid[iy] || [])),
          wavelengthUm: wl, pixelSizeUm, removeTilt: false, zeroPadTo: requestedFftSize, recenterIfWrapped: false,
        });
        setProgress(30 + baseProgress, `λ=${titleNm}nm: MTF...`);
        const mtfResp = await w.runDesktopNativeMtfMapForPopup({
          psfData: nativePsfResp?.psfData, pixelSizeUm,
          maxFrequencyLpmm: Number.isFinite(maxFreqN) ? maxFreqN : undefined, points: 121,
        });
        const freq: number[] = Array.isArray(mtfResp?.frequencyAxis) ? mtfResp.frequencyAxis : [];
        const tan: number[] = Array.isArray(mtfResp?.mtfTangential) ? mtfResp.mtfTangential : [];
        const sag: number[] = Array.isArray(mtfResp?.mtfSagittal) ? mtfResp.mtfSagittal : [];
        if (!freq.length || !tan.length || !sag.length) throw new Error('MTF result does not contain valid curves');
        const color = getColorForWavelength(wl);
        traces.push({ x: freq, y: tan, type: 'scatter', mode: 'lines', name: `Tangential (${titleNm}nm)`, line: { color, width: 2, dash: 'solid' } });
        traces.push({ x: freq, y: sag, type: 'scatter', mode: 'lines', name: `Sagittal (${titleNm}nm)`, line: { color, width: 2, dash: 'dot' } });
        const nyquist = Number(mtfResp?.nyquistLpmm);
        if (Number.isFinite(nyquist) && nyquist > 0) nyquistGlobal = Math.max(nyquistGlobal, nyquist);
        if (showDiffLimit) {
          try {
            const fNumber = Math.abs(focalLengthMm) / Math.max(1e-12, Math.abs(pupilDiameterMm));
            if (Number.isFinite(fNumber) && fNumber > 0) {
              const cutoff = 1000.0 / (Math.max(1e-12, wl) * fNumber);
              const diffY = freq.map(f => {
                const nu = f / Math.max(1e-12, cutoff);
                if (nu <= 0) return 1;
                if (nu >= 1) return 0;
                const c = Math.max(-1, Math.min(1, nu));
                const val = (2 / Math.PI) * (Math.acos(c) - c * Math.sqrt(Math.max(0, 1 - c * c)));
                return Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0;
              });
              traces.push({ x: freq, y: diffY, type: 'scatter', mode: 'lines', name: `Diff. Limit (${titleNm}nm)`, line: { color, width: 1.5, dash: 'dash' } });
            }
          } catch (_) {}
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
  }, [w, wavelength, objectIdx, sampling, zeroPad, removePtd, maxFreq, showDiffLimit, plotlyReady, setProgress, hideProgress]);

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
    const zeroPadTo = computeZeroPadTo(zeroPad, samplingN);
    const opdDisplayMode = removePtd ? 'pistonTiltDefocusRemoved' : 'pistonTiltRemoved';
    const sourceRows: any[] = typeof w.getSourceRows === 'function'
      ? safeCall(() => w.getSourceRows(w.tableSource), []) : [];
    const wavelengthList = buildWavelengthList(wlValue, sourceRows, primary);
    const targetFreqN = Number(targetFreq) || 10;
    const defocusMinN = Number(defocusMin);
    const defocusMaxN = Number(defocusMax);
    const stepsN = Number(tfSteps) || 21;
    const objIdxN = parseInt(objectIdx, 10) || 0;
    try {
      if (!plotlyReady) throw new Error('Plotly is not loaded yet');
      if (typeof w.runDesktopNativeThroughFocusMtfForPopup !== 'function') throw new Error('runDesktopNativeThroughFocusMtfForPopup unavailable');
      setProgress(0, 'Starting...');
      await new Promise(r => setTimeout(r, 0));
      let lastProgress = 20;
      setProgress(lastProgress, 'Computing Through-Focus MTF...');
      const nativeResp = await w.runDesktopNativeThroughFocusMtfForPopup({
        objectIndex: objIdxN, wavelengths: wavelengthList,
        targetFrequencyLpmm: targetFreqN, defocusMinMm: defocusMinN, defocusMaxMm: defocusMaxN,
        steps: stepsN, samplingSize: samplingN, zeroPadTo, opdDisplayMode,
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
      for (const s of series) {
        const wl = Number(s.wavelengthUm);
        const nm = Number.isFinite(wl) ? (wl * 1000).toFixed(1) : 'N/A';
        const color = getColorForWavelength(wl);
        const tan: number[] = Array.isArray(s.mtfTangential) ? s.mtfTangential : [];
        const sag: number[] = Array.isArray(s.mtfSagittal) ? s.mtfSagittal : [];
        traces.push({ x: xAxis, y: tan, type: 'scatter', mode: 'lines', name: `Meridional (${nm}nm)`, line: { color, width: 2, dash: 'solid' } });
        traces.push({ x: xAxis, y: sag, type: 'scatter', mode: 'lines', name: `Sagittal (${nm}nm)`, line: { color, width: 2, dash: 'dot' } });
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
  }, [w, wavelength, objectIdx, sampling, zeroPad, removePtd, targetFreq, defocusMin, defocusMax, tfSteps, plotlyReady, setProgress, hideProgress]);

  // ─── Compute Field MTF ─────────────────────────────────────────────────────
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
    const zeroPadTo = computeZeroPadTo(zeroPad, samplingN);
    const opdDisplayMode = removePtd ? 'pistonTiltDefocusRemoved' : 'pistonTiltRemoved';
    const sourceRows: any[] = typeof w.getSourceRows === 'function'
      ? safeCall(() => w.getSourceRows(w.tableSource), []) : [];
    const wavelengthList = buildWavelengthList(wlValue, sourceRows, primary);
    const axisInfo = getAxisInfo();
    const fieldMinN = Number(fieldMin);
    const fieldMaxN = Number(fieldMax) || 10;
    const stepsN = Number(fieldSteps) || 21;
    const freq1N = Number(freq1) || 10;
    const freq2N = Number(freq2) || 30;
    try {
      if (!plotlyReady) throw new Error('Plotly is not loaded yet');
      const { opticalSystemRows, sourceRows, objectRows } = {
        opticalSystemRows: typeof w.getOpticalSystemRows === 'function' ? safeCall(() => w.getOpticalSystemRows(w.tableOpticalSystem), []) : [],
        sourceRows: typeof w.getSourceRows === 'function' ? safeCall(() => w.getSourceRows(w.tableSource), []) : [],
        objectRows: typeof w.getObjectRows === 'function' ? safeCall(() => w.getObjectRows(w.tableObject), []) : [],
      };
      setProgress(0, 'Starting...');
      await new Promise(r => setTimeout(r, 0));
      setProgress(20, 'Computing Object MTF...');
      const portableFieldMtf = typeof w.runPortableFieldMtfForPopup === 'function'
        ? w.runPortableFieldMtfForPopup.bind(w)
        : null;
      const nativeResp = portableFieldMtf
        ? await portableFieldMtf({
            objectIndex: 0,
            wavelengths: wavelengthList,
            firstFrequencyLpmm: freq1N,
            secondFrequencyLpmm: freq2N,
            fieldMin: fieldMinN,
            fieldMax: fieldMaxN,
            steps: stepsN,
            samplingSize: samplingN,
            zeroPadTo,
            opdDisplayMode,
            fieldAxisMode: axisInfo.mode,
            onProgress: (evt: any) => {
              const p = Number(evt?.percent);
              const msg = String(evt?.message || 'Computing Object MTF...');
              if (Number.isFinite(p)) setProgress(p, msg);
              else setProgress(20, msg);
            },
          })
        : await runNativeFieldMtfMap({
            opticalSystemRows,
            sourceRows,
            objectRows,
            objectIndex: 0,
            wavelengths: wavelengthList,
            firstFrequencyLpmm: freq1N,
            secondFrequencyLpmm: freq2N,
            fieldMin: fieldMinN,
            fieldMax: fieldMaxN,
            steps: stepsN,
            samplingSize: samplingN,
            zeroPadTo,
            opdDisplayMode,
            fieldAxisMode: axisInfo.mode,
            onProgress: (evt: any) => {
              const p = Number(evt?.percent);
              const msg = String(evt?.message || 'Computing Object MTF...');
              if (Number.isFinite(p)) setProgress(p, msg);
              else setProgress(20, msg);
            },
          } as any);
      const xAxis: number[] = Array.isArray(nativeResp?.xAxis) ? nativeResp.xAxis : [];
      const series: any[] = Array.isArray(nativeResp?.series) ? nativeResp.series : [];
      if (!xAxis.length || !series.length) throw new Error('Object MTF did not produce valid data');
      const firstFreqText = String(Number.isFinite(freq1N) ? freq1N.toFixed(1) : '10.0');
      const secondFreqText = String(Number.isFinite(freq2N) ? freq2N.toFixed(1) : '30.0');
      const traces: any[] = [];
      for (const s of series) {
        const wl = Number(s.wavelengthUm);
        const nm = Number.isFinite(wl) ? (wl * 1000).toFixed(1) : 'N/A';
        const color = getColorForWavelength(wl);

        traces.push({
          x: xAxis,
          y: Array.isArray(s.meridionalFirst) ? s.meridionalFirst : [],
          type: 'scatter',
          mode: 'lines',
          name: `Meridional ${firstFreqText} lp/mm (${nm}nm)`,
          line: { color, width: 2, dash: 'solid' },
        });
        traces.push({
          x: xAxis,
          y: Array.isArray(s.sagittalFirst) ? s.sagittalFirst : [],
          type: 'scatter',
          mode: 'lines',
          name: `Sagittal ${firstFreqText} lp/mm (${nm}nm)`,
          line: { color, width: 2, dash: 'dot' },
        });
        traces.push({
          x: xAxis,
          y: Array.isArray(s.meridionalSecond) ? s.meridionalSecond : [],
          type: 'scatter',
          mode: 'lines',
          name: `Meridional ${secondFreqText} lp/mm (${nm}nm)`,
          line: { color, width: 2, dash: 'dash' },
        });
        traces.push({
          x: xAxis,
          y: Array.isArray(s.sagittalSecond) ? s.sagittalSecond : [],
          type: 'scatter',
          mode: 'lines',
          name: `Sagittal ${secondFreqText} lp/mm (${nm}nm)`,
          line: { color, width: 2, dash: 'dashdot' },
        });
      }
      const nonEmptyTraces = traces.filter(t => Array.isArray(t.y) && t.y.length > 0);
      if (!nonEmptyTraces.length) {
        throw new Error('Object MTF returned no plottable series');
      }
      setProgress(85, 'Rendering...');
      await (window as any).Plotly.newPlot(container, nonEmptyTraces, {
        title: `${firstFreqText} / ${secondFreqText} lp/mm`,
        xaxis: { title: axisInfo.label },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        margin: { l: 60, r: 20, t: 40, b: 50 },
        showlegend: true,
      }, { responsive: true, displaylogo: false });
      hideProgress();
    } catch (err: any) {
      setProgress(100, 'Failed');
      setErrorMsg(String(err?.message ?? err ?? 'Unknown error'));
    }
  }, [w, wavelength, sampling, zeroPad, removePtd, freq1, freq2, fieldMin, fieldMax, fieldSteps, plotlyReady, setProgress, hideProgress]);

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
  const zeroPadSelect = (
    <><label title="Zero-padding increases FFT size without increasing OPD ray grid.">Zero pad:</label>
      <select value={zeroPad} onChange={e => setZeroPad(e.target.value)}>
        {ZERO_PAD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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
          <label>Max (lp/mm):</label>
          <input type="number" min="0" step="1" value={maxFreq} onChange={e => setMaxFreq(e.target.value)} />
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
          <label>Object min:</label>
          <input type="number" step="0.001" value={fieldMin} onChange={e => setFieldMin(e.target.value)} />
          <label>Object max:</label>
          <input type="number" step="0.001" value={fieldMax} onChange={e => setFieldMax(e.target.value)} />
          <label>Steps:</label>
          <input type="number" min="3" max="201" step="1" value={fieldSteps} onChange={e => setFieldSteps(e.target.value)} />
        </>)}
        {samplingSelect}
        {zeroPadSelect}
        {removePtdChk}
        {type === 'mtf' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={showDiffLimit} onChange={e => setShowDiffLimit(e.target.checked)} />
            Diffraction Limit
          </label>
        )}
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
