import { useCallback, useEffect, useRef, useState } from 'react';
import { plotDistortionPercent, plotGridDistortion } from '../../evaluation/aberrations/distortion-plot.ts';
import { runNativeDistortion, runNativeGridDistortion } from '../../src/desktop/ipc/client.ts';
import { isTauriRuntime } from '../../src/desktop/runtime.ts';

export type DistortionAnalysisType = 'distortion' | 'distortion-grid';

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (_) { return fallback; }
}

function formatRuntimeInfo(runtimeLabel: 'tauri' | 'web', backendLabel?: string): string {
  const backend = String(backendLabel || '').toLowerCase();
  const effectiveRuntime = backend.includes('rust-wasm')
    ? 'rust/wasm'
    : runtimeLabel;
  const base = backendLabel
    ? `runtime=${effectiveRuntime}, backend=${backendLabel}`
    : `runtime=${effectiveRuntime}`;
  return base;
}

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

function getPrimaryWavelength(): number {
  const candidates = [window as any, (() => { try { return (window as any).opener as any; } catch (_) { return null; } })()];
  for (const w of candidates) {
    if (!w) continue;
    if (typeof w.getPrimaryWavelength === 'function') {
      const v = Number(safeCall(() => w.getPrimaryWavelength(), 0.5876));
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  return 0.5876;
}

function normalizeDistortionObjectRows(objectRows: any[], opticalSystemRows: any[], sourceRows: any[]): any[] {
  const rows = Array.isArray(objectRows) ? objectRows : [];
  const wavelength = (() => {
    const source = Array.isArray(sourceRows) ? sourceRows : [];
    let fallback = getPrimaryWavelength();
    for (const row of source) {
      const wl = Number(row?.wavelength ?? row?.Wavelength);
      if (!Number.isFinite(wl) || wl <= 0) continue;
      fallback = wl;
      const primaryFlag = row?.primary ?? row?.Primary ?? row?.['Primary Wavelength'] ?? row?.isPrimary;
      const isPrimary = typeof primaryFlag === 'boolean'
        ? primaryFlag
        : String(primaryFlag ?? '').trim().toLowerCase();
      if (isPrimary === true || isPrimary === 'true' || isPrimary === '1' || isPrimary === 'yes' || (typeof isPrimary === 'string' && isPrimary.includes('primary'))) {
        return wl;
      }
    }
    return fallback;
  })();
  const thickness = Number(opticalSystemRows?.[0]?.thickness);
  const conjugateType = Number.isFinite(thickness) && thickness < 1e9 ? 'finite' : 'infinite';

  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const normalized = { ...row } as any;
    if (normalized.xHeightAngle == null && normalized.x != null) normalized.xHeightAngle = normalized.x;
    if (normalized.yHeightAngle == null && normalized.y != null) normalized.yHeightAngle = normalized.y;
    if (normalized.position == null && normalized.objectType != null) normalized.position = normalized.objectType;
    const pos = String(normalized.position ?? '').trim().toLowerCase();
    if (pos !== 'imageheight') return normalized;
    try {
      const candidates = [window as any, (() => { try { return (window as any).opener as any; } catch (_) { return null; } })()];
      for (const w of candidates) {
        if (w && typeof w.convertImageHeightToEffectiveObject === 'function') {
          const effective = w.convertImageHeightToEffectiveObject(normalized, opticalSystemRows, wavelength, conjugateType);
          if (effective && typeof effective === 'object') {
            return {
              ...normalized,
              ...effective,
              position: normalized.position,
              __cooptOriginalPosition: normalized.position,
            };
          }
        }
      }
    } catch (_) {}
    return normalized;
  });
}

function getRows() {
  const candidates = [window as any, (() => { try { return (window as any).opener as any; } catch (_) { return null; } })()];
  for (const w of candidates) {
    if (!w) continue;
    const opticalSystemRows = typeof w.getOpticalSystemRows === 'function'
      ? safeCall(() => w.getOpticalSystemRows(w.tableOpticalSystem), [])
      : [];
    const sourceRows = typeof w.getSourceRows === 'function'
      ? safeCall(() => w.getSourceRows(w.tableSource), [])
      : [];
    const objectRows = typeof w.getObjectRows === 'function'
      ? safeCall(() => w.getObjectRows(w.tableObject), [])
      : [];
    if ((Array.isArray(opticalSystemRows) && opticalSystemRows.length > 0) || (Array.isArray(objectRows) && objectRows.length > 0)) {
      return {
        opticalSystemRows: Array.isArray(opticalSystemRows) ? opticalSystemRows : [],
        sourceRows: Array.isArray(sourceRows) ? sourceRows : [],
        objectRows: Array.isArray(objectRows) ? objectRows : [],
      };
    }
  }
  return {
    opticalSystemRows: [],
    sourceRows: [],
    objectRows: [],
  };
}

function inferObjectFieldMode(objects: any[]): 'angle' | 'height' {
  const rows = Array.isArray(objects) ? objects : [];
  const tags = rows
    .map((o) => String(o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type ?? '').toLowerCase())
    .filter(Boolean);
  if (tags.some((t) => t.includes('rect') || t.includes('rectangle') || t.includes('height'))) return 'height';
  if (tags.some((t) => t.includes('angle'))) return 'angle';
  const hasNumericHeight = rows.some((o) => {
    const h = parseFloat(o?.yHeight ?? o?.y ?? o?.height ?? o?.y_height ?? Number.NaN);
    return Number.isFinite(h) && Math.abs(h) > 0;
  });
  return hasNumericHeight ? 'height' : 'angle';
}

function deriveFieldValues(objectRows: any[], requestedSamplePoints?: number): { fieldValues: number[]; heightMode: boolean } {
  const mode = inferObjectFieldMode(objectRows);
  const parsedPoints = Number.isFinite(Number(requestedSamplePoints))
    ? Math.floor(Number(requestedSamplePoints))
    : 101;
  const samplePoints = Math.max(3, Math.min(1001, parsedPoints));
  if (mode === 'height') {
    const heights = objectRows
      .map((o) => {
        const pos = String(o?.__cooptOriginalPosition ?? o?.position ?? '').toLowerCase();
        if (pos.includes('imageheight')) {
          const targetY = Number(o?.__cooptImageHeightTarget?.y);
          if (Number.isFinite(targetY)) return targetY;
        }
        return parseFloat(o?.yHeight ?? o?.y ?? o?.height ?? o?.y_height ?? Number.NaN);
      })
      .filter((v) => Number.isFinite(v));
    if (!heights.length) return { fieldValues: [0], heightMode: true };
    const minH = 0;
    const maxH = Math.max(0, ...heights.map((v) => Math.abs(v)));
    if (minH === maxH) return { fieldValues: [minH], heightMode: true };
    const fieldValues = Array.from({ length: samplePoints }, (_, i) => {
      const t = i / (samplePoints - 1);
      return parseFloat((minH + (maxH - minH) * t).toFixed(6));
    });

    return { fieldValues, heightMode: true };
  }

  let maxAngle = 0;
  for (const o of objectRows) {
    const candidates = [o?.yFieldAngle, o?.yAngle, o?.fieldAngle, o?.xFieldAngle, o?.xAngle, o?.xHeightAngle, o?.yHeightAngle];
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c)) {
        maxAngle = Math.max(maxAngle, Math.abs(c));
      }
    }
  }
  if (!(maxAngle > 0)) maxAngle = 20;
  let step = 1;
  if (maxAngle <= 5) step = 0.5;
  else if (maxAngle <= 15) step = 1;
  else if (maxAngle <= 40) step = 2;
  else step = Math.ceil(maxAngle / 25);
  const minAngle = maxAngle * 0.001;
  const fieldValues: number[] = [];
  for (let a = minAngle; a <= maxAngle + 1e-9; a += step) fieldValues.push(parseFloat(a.toFixed(6)));
  if (fieldValues[fieldValues.length - 1] !== maxAngle) fieldValues.push(maxAngle);
  return { fieldValues, heightMode: false };
}

function deriveDisplayFieldValues(originalObjectRows: any[], fallbackFieldValues: number[]): number[] {
  const rows = Array.isArray(originalObjectRows) ? originalObjectRows : [];
  const tags = rows
    .map((o) => String(o?.__cooptOriginalPosition ?? o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type ?? '').toLowerCase())
    .filter(Boolean);
  if (!tags.some((tag) => tag.includes('imageheight'))) return fallbackFieldValues;

  const sampleCount = Math.max(1, Array.isArray(fallbackFieldValues) ? fallbackFieldValues.length : 0);
  if (sampleCount <= 1) return fallbackFieldValues;
  const heights = rows
    .map((o) => parseFloat(o?.yHeightAngle ?? o?.y ?? o?.height ?? o?.yHeight ?? o?.y_height ?? Number.NaN))
    .filter((v) => Number.isFinite(v));
  if (!heights.length) return fallbackFieldValues;

  const minH = 0;
  const maxH = Math.max(0, ...heights.map((v) => Math.abs(v)));
  if (minH === maxH) return fallbackFieldValues;

  return Array.from({ length: sampleCount }, (_, i) => {
    const t = i / (sampleCount - 1);
    return parseFloat((minH + (maxH - minH) * t).toFixed(6));
  });
}

function deriveDistortionWavelengths(sourceRows: any[]): number[] {
  const wavelengths = Array.isArray(sourceRows)
    ? sourceRows
        .filter((s) => s && Number.isFinite(Number(s.wavelength)) && Number(s.wavelength) > 0)
        .map((s) => Number(s.wavelength))
    : [];
  return wavelengths.length ? wavelengths : [getPrimaryWavelength()];
}

function countFiniteDistortionPoints(dataList: any[]): number {
  let count = 0;
  for (const data of Array.isArray(dataList) ? dataList : []) {
    const xs = Array.isArray(data?.distortionPercent) ? data.distortionPercent : [];
    const ys = Array.isArray(data?.fieldValues) ? data.fieldValues : [];
    const n = Math.min(xs.length, ys.length);
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(Number(xs[i])) && Number.isFinite(Number(ys[i]))) count += 1;
    }
  }
  return count;
}

function sanitizeDistortionData(dataList: any[]): any[] {
  return (Array.isArray(dataList) ? dataList : []).map((data) => {
    const xs = Array.isArray(data?.distortionPercent) ? data.distortionPercent : [];
    const ys = Array.isArray(data?.fieldValues) ? data.fieldValues : [];
    const n = Math.min(xs.length, ys.length);
    const outX: Array<number | null> = [];
    const outY: Array<number | null> = [];
    for (let i = 0; i < n; i++) {
      const y = Number(ys[i]);
      const xRaw = xs[i];
      let x = (typeof xRaw === 'number' && Number.isFinite(xRaw))
        ? xRaw
        : null;
      if (!Number.isFinite(y)) continue;
      outX.push(x);
      outY.push(y);
    }

    return {
      ...data,
      distortionPercent: outX,
      fieldValues: outY,
    };
  }).filter((d) => {
    const ys = Array.isArray(d?.fieldValues) ? d.fieldValues : [];
    const xs = Array.isArray(d?.distortionPercent) ? d.distortionPercent : [];
    if (ys.length === 0 || xs.length === 0) return false;
    return xs.some((v: any) => typeof v === 'number' && Number.isFinite(v));
  });
}

function applyDistortionHorizontalOffset(dataList: any[]): any[] {
  return (Array.isArray(dataList) ? dataList : []).map((data) => {
    const xs = Array.isArray(data?.distortionPercent) ? data.distortionPercent : [];
    const ys = Array.isArray(data?.fieldValues) ? data.fieldValues : [];
    const n = Math.min(xs.length, ys.length);
    if (n <= 0) return data;

    // Offset basis: smallest positive IH point with finite distortion.
    const finitePairs: Array<{ y: number; x: number }> = [];
    for (let i = 0; i < n; i++) {
      const y = Number(ys[i]);
      const x = Number(xs[i]);
      if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
      finitePairs.push({ y, x });
    }
    if (finitePairs.length === 0) return data;

    finitePairs.sort((a, b) => a.y - b.y);

    const positivePairs = finitePairs.filter((p) => p.y > 1e-12);
    const p1 = positivePairs.length > 0 ? positivePairs[0] : null;
    const p2 = positivePairs.length > 1 ? positivePairs[1] : null;

    let offset: number | null = null;
    if (p1 && p2) {
      const dy = p2.y - p1.y;
      if (Math.abs(dy) > 1e-15) {
        offset = p1.x + ((0 - p1.y) * (p2.x - p1.x)) / dy;
      } else {
        offset = p1.x;
      }
    } else if (p1) {
      offset = p1.x;
    }
    if (!(typeof offset === 'number' && Number.isFinite(offset))) return data;

    const shiftedX = xs.map((x: any) => {
      const value = Number(x);
      return Number.isFinite(value) ? (value - offset) : null;
    });

    const shiftedWithZeroAtIH0 = shiftedX.map((x: any, i: number) => {
      const y = Number(ys[i]);
      if (Number.isFinite(y) && Math.abs(y) <= 1e-12) return 0;
      const xv = Number(x);
      return Number.isFinite(xv) ? xv : null;
    });

    return {
      ...data,
      distortionPercent: shiftedWithZeroAtIH0,
      fieldValues: ys,
      meta: {
        ...(data?.meta || {}),
        distortionHorizontalOffsetPercent: offset,
        distortionOffsetBasis: 'line-through-two-smallest-positive-ih-to-ih0',
        distortionOffsetPoint1IH: p1 ? p1.y : null,
        distortionOffsetPoint1DistPercent: p1 ? p1.x : null,
        distortionOffsetPoint2IH: p2 ? p2.y : null,
        distortionOffsetPoint2DistPercent: p2 ? p2.x : null,
        ih0ForcedZeroAfterOffset: true,
      },
    };
  });
}

function scaleFieldValues(values: number[], scale: number): number[] {
  return (Array.isArray(values) ? values : []).map((v) => Number(v) * scale);
}

function scaleObjectRowsForGrid(objectRows: any[], scale: number): any[] {
  const rows = Array.isArray(objectRows) ? objectRows : [];
  return rows.map((row) => {
    const out = { ...(row || {}) } as any;
    const numericKeys = ['xFieldAngle', 'yFieldAngle', 'xAngle', 'yAngle', 'xHeightAngle', 'yHeightAngle', 'xHeight', 'yHeight', 'x', 'y'];
    for (const key of numericKeys) {
      const v = Number(out[key]);
      if (Number.isFinite(v)) out[key] = v * scale;
    }
    return out;
  });
}

function countFiniteGridPoints(data: any): number {
  const rx = Array.isArray(data?.realGrid?.x) ? data.realGrid.x : [];
  const ry = Array.isArray(data?.realGrid?.y) ? data.realGrid.y : [];
  const n = Math.min(rx.length, ry.length);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(Number(rx[i])) && Number.isFinite(Number(ry[i]))) count += 1;
  }
  return count;
}

const CSS = `
.dist-analysis-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #f4f4f4;
  font-family: Arial, sans-serif;
  margin: 0;
}
.dist-controls {
  padding: 10px 12px;
  background: #f8f8f8;
  border-bottom: 1px solid #ddd;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
  align-items: center;
  flex-shrink: 0;
}
.dist-controls label { font-size: 12px; color: #333; white-space: nowrap; }
.dist-controls select {
  padding: 5px 8px;
  font-size: 12px;
  border: 1px solid #bbb;
  border-radius: 4px;
  background: white;
}
.dist-controls button {
  padding: 6px 10px;
  border: 1px solid #bbb;
  background: #f8f8f8;
  cursor: pointer;
  border-radius: 4px;
  font-size: 12px;
  color: #333;
}
.dist-controls button:hover { background: #e9e9e9; }
.dist-backend {
  font-size: 12px;
  color: #444;
  margin-left: 8px;
}
.dist-progress {
  padding: 8px 12px;
  font-size: 12px;
  color: #333;
  border-bottom: 1px solid #eee;
  background: #fff;
}
.dist-progress progress {
  display: block;
  width: 100%;
  margin-top: 6px;
}
.dist-content {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: white;
}
.dist-chart { width: 100%; height: 100%; }
.dist-error { padding: 20px; color: red; font-size: 13px; }
`;

export function DistortionAnalysisPage({ type }: { type: DistortionAnalysisType }) {
  const chartRef = useRef<HTMLDivElement>(null);
  const [plotlyReady, setPlotlyReady] = useState(!!(window as any).Plotly);
  const [progressVisible, setProgressVisible] = useState(false);
  const [progressValue, setProgressValue] = useState(0);
  const [progressText, setProgressText] = useState(type === 'distortion' ? 'Calculating distortion...' : 'Calculating grid distortion...');
  const [errorMsg, setErrorMsg] = useState('');
  const [gridSize, setGridSize] = useState('20');
  const [samplingPointsInput, setSamplingPointsInput] = useState('101');
  const [distRangeAbsInput, setDistRangeAbsInput] = useState('');
  const [backendInfo, setBackendInfo] = useState('');

  useEffect(() => {
    document.title = type === 'distortion' ? 'Distortion' : 'Distortion Grid';
  }, [type]);

  useEffect(() => {
    loadPlotly().then(() => setPlotlyReady(true)).catch((err) => console.error(err));
  }, []);

  const setProgress = useCallback((value: number, text: string) => {
    setProgressVisible(true);
    if (Number.isFinite(value)) setProgressValue(Math.max(0, Math.min(100, value)));
    setProgressText(text);
  }, []);

  const hideProgress = useCallback(() => setProgressVisible(false), []);

  const handleRenderDistortion = useCallback(async () => {
    if (!chartRef.current) return;
    chartRef.current.innerHTML = '';
    setErrorMsg('');
    try {
      if (!plotlyReady) throw new Error('Plotly is not loaded yet');
      const { opticalSystemRows, sourceRows, objectRows } = getRows();
      const normalizedObjectRows = normalizeDistortionObjectRows(objectRows, opticalSystemRows, sourceRows);
      const requestedSamplingPoints = (() => {
        const parsed = Math.floor(Number(samplingPointsInput));
        if (!Number.isFinite(parsed)) return 101;
        return Math.max(3, Math.min(1001, parsed));
      })();
      const distortionMetric: 'chief-ray' = 'chief-ray';
      const { fieldValues, heightMode } = deriveFieldValues(normalizedObjectRows, requestedSamplingPoints);
      const wavelengths = deriveDistortionWavelengths(sourceRows);
      const runtimeLabel = isTauriRuntime() ? 'tauri' : 'web';
      setBackendInfo(formatRuntimeInfo(runtimeLabel));
      const allData = [];
      for (let i = 0; i < wavelengths.length; i++) {
        const wl = wavelengths[i];
        const base = (i / Math.max(1, wavelengths.length)) * 100;
        const span = 100 / Math.max(1, wavelengths.length);
        setProgress(base, `Distortion (λ=${wl.toFixed(4)} um): tracing`);
        const resp = await runNativeDistortion({
          opticalSystemRows,
          sourceRows,
          objectRows: normalizedObjectRows,
          fieldSamples: fieldValues,
          heightMode,
          distortionMetric,
          wavelength: wl,
          onProgress: (evt: { percent?: number; message?: string }) => {
            const p = Number(evt?.percent);
            const msg = String(evt?.message || `Distortion (λ=${wl.toFixed(4)} um): tracing`);
            if (Number.isFinite(p)) {
              setProgress(base + (Math.max(0, Math.min(100, p)) * span) / 100, msg);
            } else {
              setProgress(base, msg);
            }
          },
        });
        const backendLabel = String(resp?.backend || "unknown");
        setBackendInfo(formatRuntimeInfo(runtimeLabel, backendLabel));
        const responseFieldValues = Array.isArray(resp?.fieldValues) ? resp.fieldValues : fieldValues;
        const displayFieldValues = heightMode
          ? responseFieldValues
          : deriveDisplayFieldValues(objectRows, responseFieldValues);
        allData.push({
          fieldValues: displayFieldValues,
          idealHeights: Array.isArray(resp?.idealHeights) ? resp.idealHeights : [],
          realHeights: Array.isArray(resp?.realHeights) ? resp.realHeights : [],
          distortion: Array.isArray(resp?.distortion) ? resp.distortion : [],
          distortionPercent: Array.isArray(resp?.distortionPercent) ? resp.distortionPercent : [],
          meta: { ...(resp?.meta || {}), wavelength: wl, heightMode },
        });
        setProgress(base + span, `Distortion (λ=${wl.toFixed(4)} um, backend=${backendLabel})`);
      }
      const enableDisplayOffset = true;
      const distortionData = enableDisplayOffset ? applyDistortionHorizontalOffset(allData) : allData;
      const bestData = sanitizeDistortionData(distortionData);
      if (!bestData.length) {
        throw new Error('Distortion returned no plottable points (all chief rays failed).');
      }
      const distortionRangeAbs = (() => {
        const parsed = Number(distRangeAbsInput);
        if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
        return parsed;
      })();
      await plotDistortionPercent(bestData, chartRef.current as any, {
        objectRows,
        distortionRangeAbs,
      });
      hideProgress();
    } catch (err: any) {
      setProgress(100, 'Failed');
      setErrorMsg(String(err?.message ?? err ?? 'Unknown error'));
    }
  }, [plotlyReady, setProgress, hideProgress, samplingPointsInput, distRangeAbsInput]);

  const handleRenderGrid = useCallback(async () => {
    if (!chartRef.current) return;
    chartRef.current.innerHTML = '';
    setErrorMsg('');
    try {
      if (!plotlyReady) throw new Error('Plotly is not loaded yet');
      const { opticalSystemRows, sourceRows, objectRows } = getRows();
      const wavelength = getPrimaryWavelength();
      const runtimeLabel = isTauriRuntime() ? 'tauri' : 'web';
      const isWebRuntime = runtimeLabel === 'web';
      const preBackendLabel = runtimeLabel === 'web' ? 'web-rust-wasm' : undefined;
      setBackendInfo(formatRuntimeInfo(runtimeLabel, preBackendLabel));
      setProgress(5, 'Grid distortion (Rust/WASM): preparing');

      // Web Rust/WASM path already computes the full grid in one call.
      // Keep retries minimal to avoid multiplying runtime.
      const scales = isWebRuntime ? [1.0, 0.7] : [1.0, 0.7, 0.5, 0.35, 0.2];
      let data: any = null;
      let bestValid = -1;
      let lastScaleError: string | null = null;
      const expectedGridPoints = (Number(gridSize) || 20) * (Number(gridSize) || 20);
      for (let si = 0; si < scales.length; si++) {
        const scale = scales[si];
        const scaledObjects = scaleObjectRowsForGrid(objectRows, scale);
        let pulseTimer: number | null = null;
        let nativeUnlisten: null | (() => void) = null;
        let receivedNativeProgress = false;
        try {
          const stageBase = 8 + Math.floor((si / Math.max(1, scales.length)) * 30);
          const stageCap = Math.min(38, stageBase + 10);
          let pulseValue = stageBase;
          setProgress(pulseValue, `Grid distortion calculating... scale=${scale.toFixed(2)} (${runtimeLabel})`);
          pulseTimer = window.setInterval(() => {
            if (receivedNativeProgress) return;
            pulseValue = Math.min(stageCap, pulseValue + 1);
            setProgress(pulseValue, `Grid distortion calculating... scale=${scale.toFixed(2)} (${runtimeLabel})`);
          }, 350);

          const jobId = `native-grid-distortion-${Date.now()}-${si}-${Math.random().toString(36).slice(2, 8)}`;
          if (isTauriRuntime()) {
            try {
              const mod = await import('@tauri-apps/api/event');
              if (mod && typeof (mod as any).listen === 'function') {
                nativeUnlisten = await (mod as any).listen('analysis-progress', (event: any) => {
                  try {
                    const data = event?.payload || {};
                    if (String(data?.jobId || '') !== jobId) return;
                    receivedNativeProgress = true;
                    const percentRaw = Number(data?.percent);
                    const percent = Number.isFinite(percentRaw)
                      ? Math.max(stageBase, Math.min(39, Math.round(percentRaw * 0.39)))
                      : null;
                    setProgress(percent ?? pulseValue, String(data?.message || 'Grid distortion running...'));
                  } catch (_) {}
                });
              }
            } catch (_) {
              nativeUnlisten = null;
            }
          }

          const resp = await runNativeGridDistortion({
            jobId,
            opticalSystemRows,
            sourceRows,
            objectRows: scaledObjects,
            gridSize: Number(gridSize) || 20,
            wavelength,
            // Per-point re-tracing is very expensive on web (N separate calls).
            // Prefer fast full-grid tracing; UI still receives stage updates.
            detailProgress: false,
            onProgress: isWebRuntime
              ? (evt: { percent?: number; message?: string }) => {
                  try {
                    const p = Number(evt?.percent);
                    const msg = String(evt?.message || `Grid distortion tracing... scale=${scale.toFixed(2)}`);
                    if (Number.isFinite(p)) {
                      const mapped = Math.max(stageBase, Math.min(95, p));
                      setProgress(mapped, msg);
                    } else {
                      setProgress(pulseValue, msg);
                    }
                    receivedNativeProgress = true;
                  } catch (_) {}
                }
              : undefined,
          });
          const candidate = {
            idealGrid: {
              x: Array.isArray(resp?.idealX) ? resp.idealX : [],
              y: Array.isArray(resp?.idealY) ? resp.idealY : [],
            },
            realGrid: {
              x: Array.isArray(resp?.realX) ? resp.realX : [],
              y: Array.isArray(resp?.realY) ? resp.realY : [],
            },
            gridSize: Number.isFinite(Number(resp?.gridSize)) ? Number(resp.gridSize) : (Number(gridSize) || 20),
            maxFieldAngle: Number.isFinite(Number(resp?.maxFieldAngle)) ? Number(resp.maxFieldAngle) : 0,
            meta: { ...(resp?.meta || {}), wavelength },
          };
          const backendLabel = String(resp?.backend || 'unknown');
          setBackendInfo(formatRuntimeInfo(runtimeLabel, backendLabel));
          const valid = countFiniteGridPoints(candidate);
          if (valid > bestValid) {
            bestValid = valid;
            data = candidate;
          }
          setProgress(20 + Math.floor((si / Math.max(1, scales.length)) * 20), `Grid distortion scale=${scale.toFixed(2)} (valid=${valid}, backend=${backendLabel})`);
          if (isWebRuntime && valid > 0) break;
          if (valid >= expectedGridPoints) break;
        } catch (err: any) {
          lastScaleError = String(err?.message ?? err ?? 'Unknown grid distortion error');
          setProgress(20 + Math.floor((si / Math.max(1, scales.length)) * 20), `Grid distortion retry scale=${scale.toFixed(2)} failed`);
          continue;
        } finally {
          if (typeof nativeUnlisten === 'function') {
            try { nativeUnlisten(); } catch (_) {}
          }
          if (pulseTimer !== null) {
            window.clearInterval(pulseTimer);
          }
        }
      }
      if (!data) {
        throw new Error(lastScaleError || 'Grid distortion returned no data');
      }
      setProgress(40, `Grid distortion ${data.gridSize}×${data.gridSize}`);
      await plotGridDistortion(data, chartRef.current as any, (evt: any) => {
        const p = Number(evt?.percent);
        const msg = String(evt?.message || 'Grid distortion plotting...');
        setProgress(Number.isFinite(p) ? Math.max(40, Math.min(100, 40 + p * 0.6)) : 60, msg);
      });
      hideProgress();
    } catch (err: any) {
      setProgress(100, 'Failed');
      setErrorMsg(String(err?.message ?? err ?? 'Unknown error'));
    }
  }, [gridSize, plotlyReady, setProgress, hideProgress]);

  useEffect(() => {
    hideProgress();
    setErrorMsg('');
    setBackendInfo('');
    if (chartRef.current) {
      chartRef.current.innerHTML = '';
    }
  }, [type, hideProgress]);

  return (
    <div className="dist-analysis-page">
      <style>{CSS}</style>
      <div className="dist-controls">
        {type === 'distortion-grid' ? (
          <>
            <label>Grid Size:</label>
            <select value={gridSize} onChange={(e) => setGridSize(e.target.value)}>
              {['10', '15', '20', '25', '30', '35', '40', '45', '50'].map((v) => (
                <option key={v} value={v}>{v}×{v}</option>
              ))}
            </select>
          </>
        ) : null}
        {type === 'distortion' ? (
          <>
            <label>Sampling Points:</label>
            <input
              type="text"
              value={samplingPointsInput}
              onChange={(e) => setSamplingPointsInput(e.target.value)}
              inputMode="numeric"
              placeholder="101"
              style={{ width: 72 }}
            />
            <label>Dist Range ±(%):</label>
            <input
              type="text"
              value={distRangeAbsInput}
              onChange={(e) => setDistRangeAbsInput(e.target.value)}
              inputMode="decimal"
              placeholder="auto"
              style={{ width: 72 }}
            />
          </>
        ) : null}
        <button type="button" onClick={type === 'distortion' ? handleRenderDistortion : handleRenderGrid}>
          {type === 'distortion' ? 'Show distortion diagram' : 'Show distortion grid'}
        </button>
        {backendInfo ? <span className="dist-backend">{backendInfo}</span> : null}
      </div>
      {progressVisible ? (
        <div className="dist-progress">
          <div>{progressText}</div>
          <progress max={100} value={progressValue} />
        </div>
      ) : null}
      <div className="dist-content">
        {errorMsg ? <div className="dist-error">{errorMsg}</div> : null}
        <div className="dist-chart" ref={chartRef} />
      </div>
    </div>
  );
}