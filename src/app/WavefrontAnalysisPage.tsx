import { useCallback, useEffect, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import {
  loadOptimizeRayGridSize,
  OPTIMIZE_RAY_GRID_SIZES,
  saveOptimizeRayGridSize,
} from '../../ui/optimization-settings-storage.ts';

type ObjectOption = { value: string; label: string };
type CancelToken = {
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

async function waitForFunction(name: string, timeoutMs = 12000): Promise<{ host: any; fn: (...args: any[]) => any }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = findFunction(name);
    if (match) return match;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
  }
  throw new Error(`${name} is not available`);
}

function getRows(host: any, kind: 'object' | 'optical'): any[] {
  if (!host) return [];
  const functionName = kind === 'object' ? 'getObjectRows' : 'getOpticalSystemRows';
  const tableName = kind === 'object' ? 'tableObject' : 'tableOpticalSystem';
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
      let snapshot = kind === 'object'
        ? (Array.isArray(activeConfig.object) ? activeConfig.object : [])
        : (Array.isArray(activeConfig.opticalSystem) ? activeConfig.opticalSystem : []);
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
  return Array.isArray(rows) ? rows : [];
}

function getBestHost(): any {
  let best = window as any;
  let bestScore = -1;
  for (const host of getWindowCandidates()) {
    const score = getRows(host, 'optical').length * 100 + getRows(host, 'object').length;
    if (score > bestScore) {
      best = host;
      bestScore = score;
    }
  }
  return best;
}

function createCancelToken(): CancelToken {
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
    onAbort(listener) { if (typeof listener === 'function') listeners.push(listener); },
  };
}

function buildObjectOptions(host: any): ObjectOption[] {
  const rows = getRows(host, 'object');
  if (!rows.length) return [{ value: '0', label: '1' }];
  return rows.map((object, index) => {
    const type = String(object?.position ?? object?.object ?? object?.Object ?? object?.objectType ?? 'Point');
    const x = object?.x ?? object?.xHeightAngle ?? 0;
    const y = object?.y ?? object?.yHeightAngle ?? 0;
    return { value: String(index), label: `${index + 1}: ${type} (${x}, ${y})` };
  });
}

function ProgressBar({ value, text }: { value: number; text: string }) {
  return (
    <div className="analysis-window-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <div className="analysis-window-progress__label"><span>{Math.round(value)}%</span><span>{text}</span></div>
      <div className="analysis-window-progress__track"><div className="analysis-window-progress__value" style={{ width: `${value}%` }} /></div>
    </div>
  );
}

export function WavefrontAnalysisPage() {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const cancelTokenRef = useRef<CancelToken | null>(null);
  const [objects, setObjects] = useState<ObjectOption[]>([{ value: '0', label: '1' }]);
  const [objectIndex, setObjectIndex] = useState('0');
  const [plotType, setPlotType] = useState<'surface' | 'heatmap' | 'multifield'>('surface');
  const [gridSize, setGridSize] = useState(() => loadOptimizeRayGridSize());
  const [zernikeFit, setZernikeFit] = useState(false);
  const [removePtd, setRemovePtd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState('');

  const refreshObjects = useCallback(() => {
    const host = getBestHost();
    const next = buildObjectOptions(host);
    setObjects(next);
    setObjectIndex((current) => next.some((option) => option.value === current) ? current : (next[0]?.value || '0'));
  }, []);

  useEffect(() => {
    (window as any).Plotly = (window as any).Plotly || Plotly;
    refreshObjects();
    const refresh = () => refreshObjects();
    window.addEventListener('focus', refresh);
    window.addEventListener('coopt:main-ready', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('coopt:main-ready', refresh);
    };
  }, [refreshObjects]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      try { (window as any).Plotly?.Plots?.resize?.(chart); } catch (_) {}
    });
    observer.observe(chart);
    return () => observer.disconnect();
  }, []);

  const updateProgress = useCallback((event: any) => {
    const next = Number(event?.percent);
    if (Number.isFinite(next)) setProgress(Math.max(0, Math.min(100, next)));
    const message = String(event?.message || event?.phase || 'Working...').trim();
    if (message) setProgressText(message);
  }, []);

  const runZernikeFit = useCallback(async (host: any, selectedObjectIndex: number, selectedGridSize: number) => {
    if (plotType === 'multifield') {
      setProgressText('Zernike fit is not available for Multi-field');
      return;
    }
    setProgress(98);
    setProgressText('Zernike fitting...');

    const runtimeState = host?.__cooptLastWavefrontRuntime || (window as any).__cooptLastWavefrontRuntime;
    const map = runtimeState?.map;
    const meta = runtimeState?.meta;
    if (!map || map?.error) throw new Error('No valid wavefrontMap to fit');
    const wavelength = (() => {
      const fromMeta = Number(meta?.wavelength);
      if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
      const fromHost = Number(safeCall(() => host?.getPrimaryWavelength?.(), 0));
      if (Number.isFinite(fromHost) && fromHost > 0) return fromHost;
      throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
    })();
    const opticalRows = getRows(host, 'optical');
    const objectRows = getRows(host, 'object');
    const selectedObject = objectRows[selectedObjectIndex] || null;
    const calculatorFactory = host?.createOPDCalculator || (window as any).createOPDCalculator;
    const analyzerFactory = host?.createWavefrontAnalyzer || (window as any).createWavefrontAnalyzer;
    const calculator = typeof calculatorFactory === 'function' ? calculatorFactory(opticalRows, wavelength) : null;
    const analyzer = calculator && typeof analyzerFactory === 'function' ? analyzerFactory(calculator) : null;
    if (!analyzer || typeof analyzer.generateWavefrontMap !== 'function' || typeof analyzer.formatZernikeReportText !== 'function') {
      throw new Error('Wavefront analyzer is not available for Zernike fitting');
    }

    const fieldSetting = meta?.fieldSetting && typeof meta.fieldSetting === 'object'
      ? { ...meta.fieldSetting, objectIndex: selectedObjectIndex, wavelength }
      : (() => {
          const position = String(selectedObject?.position ?? selectedObject?.Position ?? selectedObject?.type ?? '').toLowerCase();
          const x = Number(selectedObject?.xHeightAngle ?? selectedObject?.x ?? 0) || 0;
          const y = Number(selectedObject?.yHeightAngle ?? selectedObject?.y ?? 0) || 0;
          const angleMode = ['angle', 'field angle', 'angles', 'point'].includes(position);
          return {
            id: selectedObject?.id || selectedObjectIndex + 1,
            displayName: `Object ${selectedObjectIndex + 1}`,
            type: angleMode ? 'Angle' : 'Rectangle',
            fieldAngle: angleMode ? { x, y } : { x: 0, y: 0 },
            xHeight: angleMode ? 0 : x,
            yHeight: angleMode ? 0 : y,
            objectIndex: selectedObjectIndex,
            wavelength,
          };
        })();

    const maxNoll = 37;
    let reportMap = map?.referenceSphereReport || map;
    if (reportMap?.opdMode === 'native-grid' && reportMap?.fieldSetting) {
      reportMap = await analyzer.generateWavefrontMap(fieldSetting, Math.max(16, selectedGridSize), 'circular', {
        recordRays: false,
        progressEvery: 0,
        opdMode: 'referenceSphere',
        opdDisplayMode: 'pistonTiltRemoved',
        renderFromZernike: false,
        skipZernikeFit: false,
        zernikeMaxNoll: maxNoll,
      });
      if (!reportMap || reportMap?.error) throw new Error(String(reportMap?.error?.message || 'Reference-sphere Zernike wavefront generation failed'));
    }
    if (!reportMap?.zernike && Array.isArray(reportMap?.pupilCoordinates) && Array.isArray(reportMap?.raw?.opds) && typeof analyzer.fitZernikePolynomials === 'function') {
      const sampleCount = reportMap.raw.opds.length;
      if (sampleCount > 0) {
        reportMap = {
          ...reportMap,
          zernike: analyzer.fitZernikePolynomials({
            pupilCoordinates: reportMap.pupilCoordinates,
            opds: reportMap.raw.opds,
            pupilRange: reportMap?.pupilRange,
          }, Math.max(1, Math.min(maxNoll, sampleCount))),
        };
      }
    }
    if (!reportMap?.zernike?.coefficientsMicrons) throw new Error('Reference-sphere Zernike fit did not produce coefficients');

    map.zernike = reportMap.zernike;
    map.statistics = reportMap.statistics || map.statistics || {};
    map.raw = reportMap.raw || map.raw || {};
    map.statistics.skipZernikeFit = false;
    if (reportMap !== map) map.referenceSphereReport = reportMap;
    runtimeState.map = map;
    host.__cooptLastWavefrontRuntime = runtimeState;

    const reportText = analyzer.formatZernikeReportText(reportMap, { maxNoll });
    host.__cooptSystemDataText = reportText;
    try { localStorage.setItem('coopt.systemDataText', reportText); } catch (_) {}
    try { host.__cooptPushSystemDataText?.(reportText); } catch (_) {}
    try { host.__cooptOpenSystemDataWindow?.(reportText); } catch (_) {}
    setProgress(100);
    setProgressText('Zernike report pushed to System Data');
  }, [plotType]);

  const run = useCallback(async () => {
    if (busy || !chartRef.current) return;
    setBusy(true);
    setStopping(false);
    setError('');
    setProgress(0);
    setProgressText('Starting...');
    chartRef.current.innerHTML = '';
    const stats = document.getElementById('analysis-opd-chart-stats');
    if (stats) stats.innerHTML = '';
    const token = createCancelToken();
    cancelTokenRef.current = token;

    try {
      const renderer = await waitForFunction('showWavefrontDiagram');
      const selectedObjectIndex = Number.isFinite(Number(objectIndex)) ? Math.max(0, Math.floor(Number(objectIndex))) : 0;
      const selectedGridSize = saveOptimizeRayGridSize(gridSize);
      const opdDisplayMode = removePtd ? 'pistonTiltDefocusRemoved' : 'pistonTiltRemoved';
      const result = await Promise.resolve(renderer.fn(plotType, 'opd', selectedGridSize, selectedObjectIndex, {
        containerElement: chartRef.current,
        cancelToken: token,
        onProgress: updateProgress,
        opdDisplayMode,
        throwOnError: true,
        showAlert: false,
      }));
      if (result?.error) throw new Error(String(result.error?.message || result.error || 'Wavefront plot failed'));
      if (zernikeFit) await runZernikeFit(renderer.host, selectedObjectIndex, selectedGridSize);
      else {
        setProgress(100);
        setProgressText('Done');
      }
    } catch (caught: any) {
      const message = String(caught?.message || caught || 'OPD analysis failed');
      if (token.aborted || message.toLowerCase().includes('cancel')) {
        setProgress(100);
        setProgressText('Cancelled');
      } else {
        setProgress(100);
        setProgressText('Failed');
        setError(message);
      }
    } finally {
      cancelTokenRef.current = null;
      setBusy(false);
      setStopping(false);
      window.setTimeout(() => setProgressText((current) => current === 'Done' ? '' : current), 350);
    }
  }, [busy, gridSize, objectIndex, plotType, removePtd, runZernikeFit, updateProgress, zernikeFit]);

  const stop = useCallback(() => {
    const token = cancelTokenRef.current;
    if (!token || token.aborted) return;
    setStopping(true);
    setProgressText('Stopping...');
    token.abort('Stopped by user');
  }, []);

  return (
    <div className="analysis-window-page" data-analysis-kind="opd">
      <div className="analysis-window-commandbar">
        <label className="analysis-window-field"><span>Object</span><select value={objectIndex} onChange={(event) => setObjectIndex(event.target.value)}>{objects.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="analysis-window-field"><span>Plot type</span><select value={plotType} onChange={(event) => setPlotType(event.target.value as any)}><option value="surface">3D Surface</option><option value="heatmap">Heatmap</option><option value="multifield">Multi-field Comparison</option></select></label>
        <details className="analysis-window-options"><summary>Options</summary><div className="analysis-window-options__panel">
          <label className="analysis-window-field"><span>sampling</span><select value={gridSize} onChange={(event) => setGridSize(Number(event.target.value) as any)}>{OPTIMIZE_RAY_GRID_SIZES.map((size) => <option key={size} value={size}>{size}x{size}</option>)}</select></label>
          <label className="analysis-window-toggle"><input type="checkbox" checked={zernikeFit} onChange={(event) => setZernikeFit(event.target.checked)} />Zernike (calc)</label>
          <label className="analysis-window-toggle"><input type="checkbox" checked={removePtd} onChange={(event) => setRemovePtd(event.target.checked)} />Remove P/T/D</label>
        </div></details>
        <button className="analysis-window-primary-action" type="button" title="Show wavefront diagram" onClick={() => void run()} disabled={busy}>{busy ? 'Calculating…' : 'Show'}</button>
        <button className="analysis-window-secondary-action" type="button" onClick={stop} disabled={!busy || stopping}>{stopping ? 'Stopping...' : 'Stop'}</button>
      </div>
      {(busy || !!progressText) ? <ProgressBar value={progress} text={progressText || 'Working...'} /> : null}
      {error ? <div className="analysis-window-error">{error}</div> : null}
      <div className="analysis-window-opd-content">
        <div id="analysis-opd-chart-stats" className="analysis-window-opd-stats" />
        <div id="analysis-opd-chart" className="analysis-window-chart analysis-window-opd-chart" ref={chartRef} />
      </div>
    </div>
  );
}
