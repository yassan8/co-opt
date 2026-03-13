import { useCallback, useEffect, useRef, useState } from 'react';
import { plotDistortionPercent, plotGridDistortion } from '../../evaluation/aberrations/distortion-plot.ts';
import { runNativeDistortion, runNativeGridDistortion } from '../../src/desktop/ipc/client.ts';

export type DistortionAnalysisType = 'distortion' | 'distortion-grid';

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (_) { return fallback; }
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

function deriveFieldValues(objectRows: any[]): { fieldValues: number[]; heightMode: boolean } {
  const mode = inferObjectFieldMode(objectRows);
  if (mode === 'height') {
    const heights = objectRows
      .map((o) => parseFloat(o?.yHeight ?? o?.y ?? o?.height ?? o?.y_height ?? Number.NaN))
      .filter((v) => Number.isFinite(v));
    if (!heights.length) return { fieldValues: [0.001], heightMode: true };
    let minH = Math.min(...heights);
    let maxH = Math.max(...heights);
    if (minH <= 0) {
      minH = 0.001;
      if (maxH < minH) maxH = minH;
    }
    if (minH === maxH) return { fieldValues: [minH], heightMode: true };
    const pts = 10;
    const fieldValues = Array.from({ length: pts }, (_, i) => {
      const t = i / (pts - 1);
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
    const filteredX: number[] = [];
    const filteredY: number[] = [];
    const n = Math.min(xs.length, ys.length);
    for (let i = 0; i < n; i++) {
      const x = Number(xs[i]);
      const y = Number(ys[i]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      filteredX.push(x);
      filteredY.push(y);
    }
    return {
      ...data,
      distortionPercent: filteredX,
      fieldValues: filteredY,
    };
  }).filter((d) => Array.isArray(d?.fieldValues) && d.fieldValues.length > 0);
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
      const { fieldValues, heightMode } = deriveFieldValues(objectRows);
      const wavelengths = deriveDistortionWavelengths(sourceRows);
      const scales = [1.0, 0.7, 0.5, 0.35, 0.2];
      let bestData: any[] = [];
      let bestFinite = 0;
      for (let si = 0; si < scales.length; si++) {
        const scale = scales[si];
        const scaledFields = scaleFieldValues(fieldValues, scale);
        const allData = [];
        for (let i = 0; i < wavelengths.length; i++) {
          const wl = wavelengths[i];
          const base = (i / Math.max(1, wavelengths.length)) * 100;
          const span = 100 / Math.max(1, wavelengths.length);
          const resp = await runNativeDistortion({
            opticalSystemRows,
            sourceRows,
            objectRows,
            fieldSamples: scaledFields,
            heightMode,
            wavelength: wl,
          });
          allData.push({
            fieldValues: Array.isArray(resp?.fieldValues) ? resp.fieldValues : scaledFields,
            idealHeights: Array.isArray(resp?.idealHeights) ? resp.idealHeights : [],
            realHeights: Array.isArray(resp?.realHeights) ? resp.realHeights : [],
            distortion: Array.isArray(resp?.distortion) ? resp.distortion : [],
            distortionPercent: Array.isArray(resp?.distortionPercent) ? resp.distortionPercent : [],
            meta: { ...(resp?.meta || {}), wavelength: wl, heightMode },
          });
          setProgress(base + span, `Distortion (λ=${wl.toFixed(4)} μm, scale=${scale.toFixed(2)})`);
        }
        const sanitized = sanitizeDistortionData(allData);
        const finiteCount = countFiniteDistortionPoints(sanitized);
        if (finiteCount > bestFinite) {
          bestFinite = finiteCount;
          bestData = sanitized;
        }
        if (finiteCount > 0) break;
      }
      if (!bestData.length) {
        throw new Error('Distortion returned no plottable points (all chief rays failed).');
      }
      await plotDistortionPercent(bestData, chartRef.current as any);
      hideProgress();
    } catch (err: any) {
      setProgress(100, 'Failed');
      setErrorMsg(String(err?.message ?? err ?? 'Unknown error'));
    }
  }, [plotlyReady, setProgress, hideProgress]);

  const handleRenderGrid = useCallback(async () => {
    if (!chartRef.current) return;
    chartRef.current.innerHTML = '';
    setErrorMsg('');
    try {
      if (!plotlyReady) throw new Error('Plotly is not loaded yet');
      const { opticalSystemRows, sourceRows, objectRows } = getRows();
      const wavelength = getPrimaryWavelength();
      const scales = [1.0, 0.7, 0.5, 0.35, 0.2];
      let data: any = null;
      let bestValid = -1;
      for (let si = 0; si < scales.length; si++) {
        const scale = scales[si];
        const scaledObjects = scaleObjectRowsForGrid(objectRows, scale);
        const resp = await runNativeGridDistortion({
          opticalSystemRows,
          sourceRows,
          objectRows: scaledObjects,
          gridSize: Number(gridSize) || 20,
          wavelength,
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
        const valid = countFiniteGridPoints(candidate);
        if (valid > bestValid) {
          bestValid = valid;
          data = candidate;
        }
        setProgress(20 + Math.floor((si / Math.max(1, scales.length)) * 20), `Grid distortion retry scale=${scale.toFixed(2)} (valid=${valid})`);
        if (valid > 0) break;
      }
      if (!data) throw new Error('Grid distortion returned no data');
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
    if (type === 'distortion') {
      handleRenderDistortion();
    } else {
      handleRenderGrid();
    }
  }, [type, handleRenderDistortion, handleRenderGrid]);

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
        <button type="button" onClick={type === 'distortion' ? handleRenderDistortion : handleRenderGrid}>
          {type === 'distortion' ? 'Show distortion diagram' : 'Show distortion grid'}
        </button>
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