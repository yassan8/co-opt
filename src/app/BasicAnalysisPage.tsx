import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Plotly from 'plotly.js-dist-min';
import { generateSurfaceOptions } from '../../evaluation/spot-diagram.ts';
import { AnalysisGridSamplingField } from './AnalysisGridSamplingField';
import { AnalysisRayCountField } from './AnalysisRayCountField';

export type BasicAnalysisType =
  | 'spot-diagram'
  | 'spherical-aberration'
  | 'magnification-chromatic-aberration'
  | 'integrated-aberration'
  | 'transverse-aberration'
  | 'opd-fan'
  | 'through-focus-spot';

type AnalysisProgressEvent = {
  percent?: number;
  message?: string;
  phase?: string;
};

type SurfaceOption = {
  value: number;
  surfaceId: number;
  label: string;
  rowId?: string | null;
  rowSig?: string | null;
  rowIndex?: number;
};

const RING_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 20, 24, 32];

function safeCall<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (_) { return fallback; }
}

function getWindowCandidates(): any[] {
  const candidates: any[] = [];
  try {
    const explicitHost = (window as any).__analysisHostWindow;
    if (explicitHost && !explicitHost.closed) candidates.push(explicitHost);
  } catch (_) {}
  try {
    const parent = (window as any).parent;
    if (parent && parent !== window) candidates.push(parent);
  } catch (_) {}
  try {
    const opener = (window as any).opener;
    if (opener && !opener.closed) candidates.push(opener);
  } catch (_) {}
  candidates.push(window as any);
  return candidates.filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
}

function findAnalysisFunction(name: string): { host: any; fn: (...args: any[]) => any } | null {
  for (const host of getWindowCandidates()) {
    try {
      if (typeof host?.[name] === 'function') {
        return { host, fn: host[name].bind(host) };
      }
    } catch (_) {}
  }
  return null;
}

async function waitForAnalysisFunction(name: string, timeoutMs = 12000): Promise<{ host: any; fn: (...args: any[]) => any }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = findAnalysisFunction(name);
    if (match) return match;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
  }
  throw new Error(`${name} is not available`);
}

function getOpticalRowsFromHost(host: any): any[] {
  if (!host) return [];
  let rows: any[] = [];
  try {
    if (typeof host.getOpticalSystemRows === 'function') {
      rows = safeCall(() => host.getOpticalSystemRows(host.tableOpticalSystem), [] as any[]);
      if (!Array.isArray(rows) || rows.length === 0) {
        rows = safeCall(() => host.getOpticalSystemRows(), [] as any[]);
      }
    }
  } catch (_) {}
  if ((!Array.isArray(rows) || rows.length === 0) && host?.tableOpticalSystem && typeof host.tableOpticalSystem.getData === 'function') {
    rows = safeCall(() => host.tableOpticalSystem.getData(), [] as any[]);
  }

  try {
    let activeConfig: any = null;
    if (typeof host.getActiveConfiguration === 'function') {
      activeConfig = safeCall(() => host.getActiveConfiguration(), null);
    }
    if (!activeConfig && typeof host.loadSystemConfigurations === 'function') {
      const systemConfig = safeCall(() => host.loadSystemConfigurations(), null as any);
      const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
      activeConfig = configs.find((config: any) => String(config?.id) === String(systemConfig?.activeConfigId)) || configs[0] || null;
    }
    if (activeConfig) {
      let snapshotRows = Array.isArray(activeConfig?.opticalSystem)
        ? activeConfig.opticalSystem.map((row: any) => row && typeof row === 'object' ? { ...row } : row)
        : [];
      const metadata = activeConfig?.metadata && typeof activeConfig.metadata === 'object' ? activeConfig.metadata : null;
      const preferImportedRows = snapshotRows.length > 0 && !!(metadata?.importRowsPreferred || metadata?.importAnalyzeMode);
      if (!preferImportedRows && Array.isArray(activeConfig?.blocks) && activeConfig.blocks.length > 0 && typeof host.expandBlocksToOpticalSystemRows === 'function') {
        const expanded = safeCall(() => host.expandBlocksToOpticalSystemRows(activeConfig.blocks), null as any);
        if (Array.isArray(expanded?.rows) && expanded.rows.length > 0) snapshotRows = expanded.rows;
      }
      if (snapshotRows.length > 0) rows = snapshotRows;
    }
  } catch (_) {}

  return Array.isArray(rows) ? rows : [];
}

function getBestRowsHost(): any {
  let bestHost: any = window as any;
  let bestCount = -1;
  for (const host of getWindowCandidates()) {
    const count = getOpticalRowsFromHost(host).length;
    if (count > bestCount) {
      bestHost = host;
      bestCount = count;
    }
  }
  return bestHost;
}

function getObjectRowsFromHost(host: any): any[] {
  if (!host) return [];
  let rows: any[] = [];
  try {
    if (host.tableObject && typeof host.tableObject.getData === 'function') {
      rows = safeCall(() => host.tableObject.getData(), [] as any[]);
    }
  } catch (_) {}
  if ((!Array.isArray(rows) || rows.length === 0) && typeof host.getObjectRows === 'function') {
    rows = safeCall(() => host.getObjectRows(host.tableObject), [] as any[]);
  }
  try {
    let activeConfig: any = null;
    if (typeof host.getActiveConfiguration === 'function') {
      activeConfig = safeCall(() => host.getActiveConfiguration(), null);
    }
    if (!activeConfig && typeof host.loadSystemConfigurations === 'function') {
      const systemConfig = safeCall(() => host.loadSystemConfigurations(), null as any);
      const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
      activeConfig = configs.find((config: any) => String(config?.id) === String(systemConfig?.activeConfigId)) || configs[0] || null;
    }
    if (Array.isArray(activeConfig?.object) && activeConfig.object.length > 0) rows = activeConfig.object;
  } catch (_) {}
  return Array.isArray(rows) ? rows.filter((row) => row && row.enabled !== false) : [];
}

function findImageSurfaceIndex(rows: any[]): number | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index] || {};
    const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
    if (objectType === 'image') return index;
  }
  return rows.length > 0 ? rows.length - 1 : undefined;
}

type ThroughFocusSpotOptions = {
  containerElement: HTMLDivElement;
  host: any;
  defocusMagnitudeMm: number;
  steps: number;
  scaleUm: number;
  rayCount: number;
  ringCount: number;
  pattern: 'annular' | 'grid';
  wavelengthMode: 'all' | 'primary';
  onProgress: (event: AnalysisProgressEvent) => void;
};

async function renderThroughFocusSpot(options: ThroughFocusSpotOptions): Promise<void> {
  const {
    containerElement,
    host,
    defocusMagnitudeMm,
    steps,
    scaleUm,
    rayCount,
    ringCount,
    pattern,
    wavelengthMode,
    onProgress,
  } = options;
  const nativeRunner = await waitForAnalysisFunction('runDesktopNativeSpotRaytraceForPopup');
  const opticalRows = getOpticalRowsFromHost(host);
  const objectRows = getObjectRowsFromHost(host);
  const surfaceIndex = findImageSurfaceIndex(opticalRows);
  const defocusValues = Array.from({ length: steps }, (_, index) => (
    -defocusMagnitudeMm + (index / Math.max(1, steps - 1)) * defocusMagnitudeMm * 2
  ));
  const objectLabels: string[] = [];
  const focusGrid: any[][] = [];
  const traceStats: any[] = [];

  const getObjectLabel = (index: number) => {
    const row = objectRows[index] || {};
    const id = String(row?.id ?? '').trim();
    if (id) return id;
    const objectName = String(row?.object ?? '').trim();
    if (objectName) return objectName;
    const position = String(row?.position ?? '').trim();
    return position ? `Object ${index + 1} (${position})` : `Object ${index + 1}`;
  };
  const ensureObjectRow = (preferredIndex: unknown, label?: string) => {
    let index = Number(preferredIndex);
    if (!Number.isInteger(index) || index < 0) index = objectLabels.length;
    while (objectLabels.length <= index) {
      const next = objectLabels.length;
      objectLabels.push(getObjectLabel(next));
      focusGrid.push([]);
    }
    if (String(label || '').trim()) objectLabels[index] = String(label).trim();
    return index;
  };
  const wavelengthLabel = (series: any) => {
    const wavelength = Number(series?.wavelengthUm);
    if (Number.isFinite(wavelength) && wavelength > 0) return `Wavelength ${(wavelength * 1000).toFixed(1)}nm`;
    const raw = String(series?.label || '').trim();
    const nm = raw.match(/(\d+(?:\.\d+)?)\s*nm/i);
    if (nm?.[1]) return `Wavelength ${nm[1]}nm`;
    return raw.toLowerCase().includes('primary') ? 'Wavelength Primary' : `Wavelength ${raw || 'Primary'}`;
  };

  for (let defocusIndex = 0; defocusIndex < defocusValues.length; defocusIndex++) {
    const shiftMm = defocusValues[defocusIndex];
    onProgress({
      percent: Math.floor((defocusIndex / Math.max(1, defocusValues.length)) * 85),
      message: `Computing defocus ${shiftMm.toFixed(4)} mm (${defocusIndex + 1}/${defocusValues.length})...`,
    });
    const result = await Promise.resolve(nativeRunner.fn({
      surfaceIndex,
      rayCount,
      ringCount,
      pattern,
      wavelengthMode,
      objectRows,
      defocusMm: shiftMm,
    }));
    const stats = Array.isArray(result?.seriesStats) ? result.seriesStats : [];
    stats.forEach((stat: any) => traceStats.push({
      backend: String(result?.backend || 'native-rust-raytrace'),
      defocusMm: shiftMm,
      label: String(stat?.label || ''),
      attemptedRays: Number(stat?.attemptedRays || 0),
      hitRays: Number(stat?.hitRays || 0),
      missRays: Number(stat?.missRays || 0),
      apertureBlockRays: Number(stat?.apertureBlockRays || 0),
      noIntersectionRays: Number(stat?.noIntersectionRays || 0),
      tirRays: Number(stat?.tirRays || 0),
      unknownFailRays: Number(stat?.unknownFailRays || 0),
      statusCounts: stat?.statusCounts && typeof stat.statusCounts === 'object' ? stat.statusCounts : {},
      hitRatePercent: Number(stat?.hitRatePercent || 0),
    }));

    const series = Array.isArray(result?.series) ? result.series : [];
    const wavelengthCountRaw = Number(result?.wavelengthCount);
    const wavelengthCount = Number.isInteger(wavelengthCountRaw) && wavelengthCountRaw > 0
      ? wavelengthCountRaw
      : Math.max(1, new Set(series.map((item: any) => wavelengthLabel(item))).size);
    const groupedByObject = new Map<number, any[]>();
    series.forEach((item: any, seriesIndex: number) => {
      const objectIndex = Math.floor(seriesIndex / wavelengthCount);
      const rowIndex = ensureObjectRow(objectIndex, getObjectLabel(objectIndex));
      const points = Array.isArray(item?.points) ? item.points : [];
      const chiefXUm = Number(item?.chiefPointUm?.xUm);
      const chiefYUm = Number(item?.chiefPointUm?.yUm);
      const centerOnChief = !!item?.hasFieldAngle && Number.isFinite(chiefXUm) && Number.isFinite(chiefYUm);
      const centered = points.map((point: any) => ({
        xUm: (Number(point?.xUm) || 0) - (centerOnChief ? chiefXUm : 0),
        yUm: (Number(point?.yUm) || 0) - (centerOnChief ? chiefYUm : 0),
      }));
      const label = wavelengthLabel(item);
      const group = groupedByObject.get(rowIndex) || [];
      group.push({ key: label, label, color: String(item?.color || '#2563eb'), points: centered });
      groupedByObject.set(rowIndex, group);
    });

    const airyRadiusUm = Number(result?.airyRadiusUm);
    for (let rowIndex = 0; rowIndex < focusGrid.length; rowIndex++) {
      const groups = groupedByObject.get(rowIndex) || [];
      const merged = groups.flatMap((group) => group.points || []);
      const centerX = merged.length ? merged.reduce((sum, point) => sum + point.xUm, 0) / merged.length : 0;
      const centerY = merged.length ? merged.reduce((sum, point) => sum + point.yUm, 0) / merged.length : 0;
      focusGrid[rowIndex].push({
        airyRadiusUm: Number.isFinite(airyRadiusUm) && airyRadiusUm > 0 ? airyRadiusUm : Number.NaN,
        pointsByWavelength: groups.map((group) => ({
          ...group,
          points: group.points.map((point: any) => ({ xUm: point.xUm - centerX, yUm: point.yUm - centerY })),
        })),
      });
    }
  }

  safeCall(() => { (window as any).__cooptTfSpotLastTraceStats = traceStats; }, undefined);
  safeCall(() => { host.__cooptTfSpotLastTraceStats = traceStats; }, undefined);

  const rows = Math.max(1, focusGrid.length);
  const columns = Math.max(1, defocusValues.length);
  const coordinateMagnitudes = focusGrid
    .flatMap((row) => row || [])
    .flatMap((cell) => cell?.pointsByWavelength || [])
    .flatMap((group) => group?.points || [])
    .flatMap((point) => [Math.abs(Number(point?.xUm)), Math.abs(Number(point?.yUm))])
    .filter((value) => Number.isFinite(value));
  // Keep the requested scale as the minimum, but never crop an entire line
  // focus out of view. This matters for an ideal lens with one unpowered axis:
  // the focused-axis defocus can be tens of microns while the orthogonal beam
  // remains many millimetres tall.
  const contentHalfScaleUm = coordinateMagnitudes.length > 0
    ? Math.max(...coordinateMagnitudes) * 1.05
    : 0;
  const halfScaleUm = Math.max(scaleUm / 2, contentHalfScaleUm, 0.5);
  const traces: any[] = [];
  const layout: any = {
    showlegend: true,
    grid: { rows, columns, pattern: 'independent' },
    margin: { l: 60, r: 20, t: 56, b: 60 },
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    height: Math.max(420, rows * 145 + 90),
    legend: { orientation: 'h', yanchor: 'bottom', y: 1.06, xanchor: 'center', x: 0.5 },
    legendgroupclick: 'togglegroup',
    shapes: [],
  };
  const legendEntries = new Map<string, { label: string; color: string }>();
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    for (let columnIndex = 0; columnIndex < columns; columnIndex++) {
      const subplotIndex = rowIndex * columns + columnIndex + 1;
      const xRef = subplotIndex === 1 ? 'x' : `x${subplotIndex}`;
      const yRef = subplotIndex === 1 ? 'y' : `y${subplotIndex}`;
      const xKey = subplotIndex === 1 ? 'xaxis' : `xaxis${subplotIndex}`;
      const yKey = subplotIndex === 1 ? 'yaxis' : `yaxis${subplotIndex}`;
      const cell = focusGrid[rowIndex]?.[columnIndex] || { pointsByWavelength: [] };
      (cell.pointsByWavelength || []).forEach((group: any) => {
        legendEntries.set(group.key, { label: group.label, color: group.color });
        traces.push({
          x: group.points.map((point: any) => point.xUm),
          y: group.points.map((point: any) => point.yUm),
          mode: 'markers',
          type: 'scattergl',
          name: group.label,
          legendgroup: group.key,
          showlegend: false,
          marker: { size: 4, color: group.color, opacity: 0.75 },
          xaxis: xRef,
          yaxis: yRef,
          hovertemplate: 'x=%{x:.2f} µm<br>y=%{y:.2f} µm<extra></extra>',
        });
      });
      layout[xKey] = {
        range: [-halfScaleUm, halfScaleUm],
        showgrid: true,
        zeroline: true,
        showticklabels: rowIndex === rows - 1,
        title: rowIndex === rows - 1 ? `${defocusValues[columnIndex].toFixed(3)} mm` : '',
      };
      layout[yKey] = {
        range: [-halfScaleUm, halfScaleUm],
        showgrid: true,
        zeroline: true,
        showticklabels: columnIndex === 0,
        title: columnIndex === 0 ? (objectLabels[rowIndex] || `Object ${rowIndex + 1}`) : '',
        scaleanchor: xRef,
        scaleratio: 1,
      };
      const airyRadiusUm = Number(cell?.airyRadiusUm);
      if (Number.isFinite(airyRadiusUm) && airyRadiusUm > 0) {
        layout.shapes.push({
          type: 'circle', xref: xRef, yref: yRef,
          x0: -airyRadiusUm, y0: -airyRadiusUm, x1: airyRadiusUm, y1: airyRadiusUm,
          line: { color: '#111827', width: 1 }, fillcolor: 'rgba(0,0,0,0)',
        });
      }
    }
  }
  const renderablePointCount = traces.reduce((sum, trace) => sum + trace.x.filter((value: unknown) => Number.isFinite(Number(value))).length, 0);
  if (renderablePointCount <= 0) throw new Error('Through-Focus Spot produced no plottable spot points on the image surface.');
  legendEntries.forEach((entry, key) => traces.push({
    x: [null], y: [null], mode: 'markers', type: 'scatter', name: entry.label,
    legendgroup: key, showlegend: true,
    marker: { size: 8, color: entry.color, symbol: 'circle' }, hoverinfo: 'skip',
  }));
  onProgress({ percent: 92, message: 'Rendering Through-Focus Spot...' });
  await (window as any).Plotly.newPlot(containerElement, traces, layout, { responsive: true, displaylogo: false });
}

function percentile(values: number[], quantile: number): number {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const index = Math.floor((sorted.length - 1) * Math.max(0, Math.min(1, quantile)));
  return sorted[index] || 0;
}

function centerAndCullSpotPoints(rawPoints: any[], centroid: { xUm: number; yUm: number }) {
  const points = (Array.isArray(rawPoints) ? rawPoints : [])
    .map((point) => ({ xUm: Number(point?.xUm), yUm: Number(point?.yUm) }))
    .filter((point) => Number.isFinite(point.xUm) && Number.isFinite(point.yUm))
    .map((point) => ({ xUm: point.xUm - centroid.xUm, yUm: point.yUm - centroid.yUm }));
  if (points.length < 40) return points;
  const radii = points.map((point) => Math.hypot(point.xUm, point.yUm));
  const clipRadius = Math.max(5, percentile(radii, 0.99) * 1.3, percentile(radii, 0.95) * 1.7);
  const maximumRadius = radii.reduce((maximum, value) => Math.max(maximum, value), 0);
  if (maximumRadius <= clipRadius) return points;
  const filtered = points.filter((point) => Math.hypot(point.xUm, point.yUm) <= clipRadius);
  const culled = points.length - filtered.length;
  const maxCull = Math.max(3, Math.floor(points.length * 0.02));
  return culled > 0 && culled <= maxCull && filtered.length >= 10 ? filtered : points;
}

function getSpotAxisRange(points: Array<{ xUm: number; yUm: number }>): number {
  if (!points.length) return 5;
  const radii = points.map((point) => Math.hypot(point.xUm, point.yUm));
  const maximum = radii.reduce((current, value) => Math.max(current, value), 0);
  const p95 = percentile(radii, 0.95);
  const p99 = percentile(radii, 0.99);
  let range = Math.max(5, p99 * 1.12, p95 * 1.35);
  range = maximum > range * 1.8 ? Math.max(range, p99 * 1.22) : Math.max(range, maximum * 1.04);
  return Math.max(5, range);
}

async function renderNativeSpotDiagram(options: {
  containerElement: HTMLDivElement;
  nativeRunner: (...args: any[]) => any;
  host: any;
  surfaceIndex: number;
  rayCount: number;
  ringCount: number;
  pattern: 'annular' | 'grid';
  onProgress: (event: AnalysisProgressEvent) => void;
}): Promise<void> {
  const { containerElement, nativeRunner, host, surfaceIndex, rayCount, ringCount, pattern, onProgress } = options;
  const objectRows = getObjectRowsFromHost(host);
  onProgress({ percent: 25, message: 'Computing Spot Diagram (Native Rust)...' });
  const result = await Promise.resolve(nativeRunner({
    surfaceIndex,
    rayCount,
    ringCount,
    pattern,
    wavelengthMode: 'all',
    objectRows,
    onProgress,
  }));
  const series = Array.isArray(result?.series) ? result.series : [];
  if (!series.length) throw new Error('Native Rust Spot result is empty');

  const wavelengthLabel = (item: any) => {
    const wavelength = Number(item?.wavelengthUm);
    if (Number.isFinite(wavelength) && wavelength > 0) return `Wavelength ${(wavelength * 1000).toFixed(1)}nm`;
    const raw = String(item?.label || '').trim();
    const match = raw.match(/(Primary(?:\s*\([^)]*\))?|\d+(?:\.\d+)?\s*nm)\s*$/i);
    return match?.[1] ? `Wavelength ${String(match[1]).replace(/\s+/g, '')}` : 'Wavelength Primary';
  };
  const wavelengthCountRaw = Number(result?.wavelengthCount);
  const wavelengthCount = Number.isInteger(wavelengthCountRaw) && wavelengthCountRaw > 0
    ? wavelengthCountRaw
    : Math.max(1, new Set(series.map(wavelengthLabel)).size);
  const objectCount = Math.max(1, Math.ceil(series.length / wavelengthCount));
  const preparedObjects: any[] = [];

  for (let objectIndex = 0; objectIndex < objectCount; objectIndex++) {
    const objectSeries = series.slice(objectIndex * wavelengthCount, (objectIndex + 1) * wavelengthCount);
    const allPoints = objectSeries.flatMap((item: any) => Array.isArray(item?.points) ? item.points : [])
      .map((point: any) => ({ xUm: Number(point?.xUm), yUm: Number(point?.yUm) }))
      .filter((point: any) => Number.isFinite(point.xUm) && Number.isFinite(point.yUm));
    const centroid = allPoints.length ? {
      xUm: allPoints.reduce((sum: number, point: any) => sum + point.xUm, 0) / allPoints.length,
      yUm: allPoints.reduce((sum: number, point: any) => sum + point.yUm, 0) / allPoints.length,
    } : { xUm: 0, yUm: 0 };
    preparedObjects.push({
      label: (() => {
        const row = objectRows[objectIndex] || {};
        const id = String(row?.id ?? '').trim();
        const name = String(row?.name ?? '').trim();
        const position = String(row?.position ?? row?.object ?? '').trim();
        return id || name || (position ? `Field ${objectIndex + 1} (${position})` : `Field ${objectIndex + 1}`);
      })(),
      groups: objectSeries.map((item: any) => ({
        label: wavelengthLabel(item),
        color: String(item?.color || '#2563eb'),
        points: centerAndCullSpotPoints(item?.points, centroid),
      })),
    });
  }

  const allCenteredPoints = preparedObjects.flatMap((object) => object.groups.flatMap((group: any) => group.points));
  const range = getSpotAxisRange(allCenteredPoints);
  const count = preparedObjects.length;
  const columns = count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : count <= 16 ? 4 : 5;
  const rows = Math.max(1, Math.ceil(count / columns));
  const horizontalGap = count > 16 ? 0.02 : count > 9 ? 0.03 : 0.05;
  const verticalGap = rows > 6 ? 0.025 : rows > 4 ? 0.04 : 0.08;
  const cellWidth = (1 - (columns - 1) * horizontalGap) / columns;
  const cellHeight = (1 - (rows - 1) * verticalGap) / rows;
  const airyRadiusUm = Number(result?.airyRadiusUm);
  const traces: any[] = [];
  const layout: any = {
    margin: { l: 40, r: 16, t: 92, b: 32 },
    showlegend: true,
    paper_bgcolor: '#ffffff',
    plot_bgcolor: '#ffffff',
    annotations: [],
    shapes: [],
    legend: { orientation: 'h', yanchor: 'bottom', y: 1.12, xanchor: 'left', x: 0, traceorder: 'normal', font: { size: 11 } },
    legendgroupclick: 'togglegroup',
    height: Math.max(420, rows * 250 + 110),
  };
  const legendColors = new Map<string, string>();
  preparedObjects.forEach((object, index) => {
    const suffix = index === 0 ? '' : String(index + 1);
    const xRef = `x${suffix}`;
    const yRef = `y${suffix}`;
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x0 = column * (cellWidth + horizontalGap);
    const x1 = x0 + cellWidth;
    const y1 = 1 - row * (cellHeight + verticalGap);
    const y0 = y1 - cellHeight;
    layout[`xaxis${suffix}`] = {
      domain: [x0, x1], zeroline: false, range: [-range, range],
      title: row === rows - 1 ? 'X (µm)' : '', anchor: yRef,
    };
    layout[`yaxis${suffix}`] = {
      domain: [y0, y1], zeroline: false, range: [-range, range],
      title: column === 0 ? 'Y (µm)' : '', anchor: xRef, scaleanchor: xRef, scaleratio: 1,
    };
    layout.annotations.push({
      x: (x0 + x1) / 2, y: Math.min(1, y1 + 0.015), xref: 'paper', yref: 'paper',
      text: object.label, showarrow: false, font: { size: 12, color: '#111827' }, xanchor: 'center', yanchor: 'bottom',
    });
    if (Number.isFinite(airyRadiusUm) && airyRadiusUm > 0) {
      layout.shapes.push({
        type: 'circle', xref: xRef, yref: yRef,
        x0: -airyRadiusUm, y0: -airyRadiusUm, x1: airyRadiusUm, y1: airyRadiusUm,
        line: { color: '#111827', width: 1 }, fillcolor: 'rgba(0,0,0,0)',
      });
    }
    object.groups.forEach((group: any) => {
      traces.push({
        x: group.points.map((point: any) => point.xUm),
        y: group.points.map((point: any) => point.yUm),
        xaxis: xRef, yaxis: yRef, type: 'scattergl', mode: 'markers',
        name: group.label, legendgroup: group.label, showlegend: false,
        marker: { size: 6, color: group.color, opacity: 0.85, symbol: 'circle', line: { width: 0.8, color: '#333333' } },
        hovertemplate: 'x=%{x:.2f}µm<br>y=%{y:.2f}µm<extra></extra>',
      });
      if (!legendColors.has(group.label)) legendColors.set(group.label, group.color);
    });
  });
  legendColors.forEach((color, label) => traces.push({
    x: [null], y: [null], type: 'scatter', mode: 'markers', name: label,
    legendgroup: label, showlegend: true, marker: { size: 8, color, symbol: 'circle' }, hoverinfo: 'skip',
  }));
  const pointCount = traces.reduce((sum, trace) => sum + trace.x.filter((value: unknown) => Number.isFinite(Number(value))).length, 0);
  if (pointCount <= 0) throw new Error('Native Spot Diagram produced no plottable points.');
  onProgress({ percent: 85, message: 'Rendering Spot Diagram...' });
  await (window as any).Plotly.newPlot(containerElement, traces, layout, { responsive: true, displaylogo: false });
}

function readStoredNumber(key: string, fallback: number, allowed?: number[]): number {
  try {
    const value = Number(localStorage.getItem(key));
    if (!Number.isFinite(value)) return fallback;
    if (allowed && !allowed.includes(value)) return fallback;
    return value;
  } catch (_) {
    return fallback;
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function ProgressBar({ value, text }: { value: number; text: string }) {
  return (
    <div className="analysis-window-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <div className="analysis-window-progress__label"><span>{Math.round(value)}%</span><span>{text}</span></div>
      <div className="analysis-window-progress__track"><div className="analysis-window-progress__value" style={{ width: `${value}%` }} /></div>
    </div>
  );
}

export function BasicAnalysisPage({ type }: { type: BasicAnalysisType }) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const autoRunDoneRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressText, setProgressText] = useState('');
  const [error, setError] = useState('');

  const [surfaceOptions, setSurfaceOptions] = useState<SurfaceOption[]>([]);
  const [surfaceId, setSurfaceId] = useState('');
  const [spotRayCount, setSpotRayCount] = useState(101);
  const [spotRingCount, setSpotRingCount] = useState(10);
  const [spotPattern, setSpotPattern] = useState<'annular' | 'grid'>('annular');

  const [sphericalRayCount, setSphericalRayCount] = useState(100);
  const [referenceFocusMode, setReferenceFocusMode] = useState<'primary-paraxial' | 'current-paraxial' | 'chief-ray'>('current-paraxial');

  const [lateralRange, setLateralRange] = useState(0.04);
  const [lateralPointCount, setLateralPointCount] = useState(41);
  const [lateralRayCount, setLateralRayCount] = useState(101);
  const [lateralRingCount, setLateralRingCount] = useState(30);
  const [lateralChiefRay, setLateralChiefRay] = useState<'stop-center' | 'beam-centroid'>('stop-center');
  const [lateralSmoothN, setLateralSmoothN] = useState(0);

  const [transverseRayCount, setTransverseRayCount] = useState(21);
  const [opdFanGridSize, setOpdFanGridSize] = useState(() => readStoredNumber('coopt.opdFan.gridSize', 129, [33, 65, 129]));
  const [opdFanScale, setOpdFanScale] = useState(() => readStoredNumber('coopt.opdFan.scaleWaves', 1));

  const [throughFocusWavelength, setThroughFocusWavelength] = useState<'all' | 'primary'>('all');
  const [throughFocusDefocus, setThroughFocusDefocus] = useState(0.5);
  const [throughFocusSteps, setThroughFocusSteps] = useState(5);
  const [throughFocusScale, setThroughFocusScale] = useState(100);
  const [throughFocusRayCount, setThroughFocusRayCount] = useState(101);
  const [throughFocusRingCount, setThroughFocusRingCount] = useState(10);
  const [throughFocusPattern, setThroughFocusPattern] = useState<'annular' | 'grid'>('annular');

  useEffect(() => {
    (window as any).Plotly = (window as any).Plotly || Plotly;
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      try { (window as any).Plotly?.Plots?.resize?.(chart); } catch (_) {}
    });
    observer.observe(chart);
    return () => observer.disconnect();
  }, [type]);

  const refreshSurfaceOptions = useCallback(() => {
    const host = getBestRowsHost();
    const rows = getOpticalRowsFromHost(host);
    const options = generateSurfaceOptions(rows) as SurfaceOption[];
    setSurfaceOptions(options);
    setSurfaceId((previous) => {
      if (previous && options.some((option) => String(option.surfaceId) === previous)) return previous;
      const image = options.find((option) => String(option.label || '').toLowerCase().includes('(image)'));
      const fallback = image || options[options.length - 1];
      return fallback ? String(fallback.surfaceId) : '';
    });
    return options;
  }, []);

  useEffect(() => {
    if (type !== 'spot-diagram') return;
    refreshSurfaceOptions();
    const onReady = () => refreshSurfaceOptions();
    const onFocus = () => refreshSurfaceOptions();
    window.addEventListener('coopt:main-ready', onReady);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('coopt:main-ready', onReady);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshSurfaceOptions, type]);

  const reportProgress = useCallback((event: AnalysisProgressEvent) => {
    const next = Number(event?.percent);
    if (Number.isFinite(next)) setProgress(Math.max(0, Math.min(100, next)));
    const message = String(event?.message || event?.phase || 'Working...').trim();
    if (message) setProgressText(message);
  }, []);

  const runAnalysis = useCallback(async () => {
    if (!chartRef.current || busy) return;
    setBusy(true);
    setProgress(0);
    setProgressText('Starting...');
    setError('');
    chartRef.current.innerHTML = '';

    try {
      (window as any).Plotly = (window as any).Plotly || Plotly;
      const containerElement = chartRef.current;

      if (type === 'spot-diagram') {
        const options = refreshSurfaceOptions();
        const selected = options.find((option) => String(option.surfaceId) === String(surfaceId))
          || surfaceOptions.find((option) => String(option.surfaceId) === String(surfaceId));
        if (!selected) throw new Error('Please select Surf before running Spot Diagram.');
        const rayCount = Math.round(clampNumber(spotRayCount, 101, 1, 20001));
        const ringCount = Math.round(clampNumber(spotRingCount, 10, 1, 64));
        const nativeRunner = findAnalysisFunction('runDesktopNativeSpotRaytraceForPopup');
        let nativeRendered = false;
        if (nativeRunner) {
          try {
            await renderNativeSpotDiagram({
              containerElement,
              nativeRunner: nativeRunner.fn,
              host: nativeRunner.host,
              surfaceIndex: Number.isInteger(selected.rowIndex) ? Number(selected.rowIndex) : Number(selected.surfaceId),
              rayCount,
              ringCount,
              pattern: spotPattern,
              onProgress: reportProgress,
            });
            nativeRendered = true;
          } catch (nativeError) {
            console.warn('[Spot Diagram] Native path failed; falling back to Rust-WASM.', nativeError);
          }
        }
        if (!nativeRendered) {
          const { fn } = await waitForAnalysisFunction('showSpotDiagram');
          await Promise.resolve(fn({
            containerElement,
            surfaceIndex: selected.surfaceId,
            surfaceRowIndex: selected.rowIndex,
            surfaceRowId: selected.rowId || undefined,
            surfaceRowSig: selected.rowSig || undefined,
            surfaceIsImage: String(selected.label || '').toLowerCase().includes('(image)'),
            rayCount,
            ringCount,
            pattern: spotPattern,
            wavelengthMode: 'all',
            forceRustWasmTrace: true,
            requireRustWasmTrace: true,
            onProgress: reportProgress,
          }));
        }
      } else if (type === 'spherical-aberration') {
        const renderer = await waitForAnalysisFunction('showLongitudinalAberrationDiagram');
        const rayCount = Math.round(clampNumber(sphericalRayCount, 100, 1, 1001));
        const nativeRunner = findAnalysisFunction('runDesktopNativeSphericalAberrationForPopup');
        if (nativeRunner) {
          setProgress(25);
          setProgressText('Computing spherical aberration (Rust)...');
          const precomputedAberrationData = await Promise.resolve(nativeRunner.fn({
            rayCount,
            referenceFocusMode,
            wavelengthMode: 'all',
          }));
          setProgress(80);
          setProgressText('Rendering...');
          await Promise.resolve(renderer.fn({ containerElement, onProgress: reportProgress, precomputedAberrationData }));
        } else {
          await Promise.resolve(renderer.fn({ containerElement, onProgress: reportProgress, rayCount, referenceFocusMode }));
        }
      } else if (type === 'magnification-chromatic-aberration') {
        const { fn } = await waitForAnalysisFunction('showMagnificationChromaticAberrationDiagram');
        await Promise.resolve(fn({
          containerElement,
          xRange: Math.max(0, Number(lateralRange) || 0.04),
          pointCount: Math.round(clampNumber(lateralPointCount, 41, 2, 201)),
          rayCount: Math.round(clampNumber(lateralRayCount, 101, 1, 5001)),
          ringCount: Math.round(clampNumber(lateralRingCount, 30, 1, 99)),
          chiefRayDefinition: lateralChiefRay,
          smoothingAdjacentPoints: Math.round(clampNumber(lateralSmoothN, 0, 0, 50)),
          onProgress: reportProgress,
        }));
      } else if (type === 'integrated-aberration') {
        const { fn } = await waitForAnalysisFunction('showIntegratedAberrationDiagram');
        await Promise.resolve(fn({ containerElement, onProgress: reportProgress, useActiveConfigSnapshot: true }));
      } else if (type === 'transverse-aberration') {
        const { fn } = await waitForAnalysisFunction('showTransverseAberrationDiagram');
        const profileTransverse = (() => {
          try {
            const query = new URLSearchParams(window.location.search);
            const raw = String(
              (window as any).__COOPT_PROFILE_TRANSVERSE === true
                ? 'true'
                : query.get('coopt_profile_transverse') ?? query.get('profileTransverse') ?? localStorage.getItem('coopt.profileTransverse') ?? '',
            ).trim().toLowerCase();
            return ['1', 'true', 'yes', 'on'].includes(raw);
          } catch (_) { return false; }
        })();
        await Promise.resolve(fn({
          rayCount: Math.round(clampNumber(transverseRayCount, 21, 9, 10001)),
          containerElement,
          onProgress: reportProgress,
          profileTransverse,
        }));
      } else if (type === 'opd-fan') {
        const { fn } = await waitForAnalysisFunction('showOpticalPathDifferenceFan');
        const gridSize = [33, 65, 129].includes(Number(opdFanGridSize)) ? Number(opdFanGridSize) : 129;
        const aberrationScaleWaves = Math.max(0.001, Number(opdFanScale) || 1);
        try {
          localStorage.setItem('coopt.opdFan.gridSize', String(gridSize));
          localStorage.setItem('coopt.opdFan.scaleWaves', String(aberrationScaleWaves));
        } catch (_) {}
        await Promise.resolve(fn({ containerElement, gridSize, aberrationScaleWaves, onProgress: reportProgress }));
      } else if (type === 'through-focus-spot') {
        const defocusMagnitude = Math.abs(Number(throughFocusDefocus) || 0.5);
        const host = getBestRowsHost();
        await renderThroughFocusSpot({
          containerElement,
          host,
          defocusMagnitudeMm: defocusMagnitude,
          steps: Math.round(clampNumber(throughFocusSteps, 5, 3, 61)),
          scaleUm: Math.max(1, Number(throughFocusScale) || 100),
          rayCount: Math.round(clampNumber(throughFocusRayCount, 101, 1, 20001)),
          ringCount: Math.round(clampNumber(throughFocusRingCount, 10, 1, 64)),
          pattern: throughFocusPattern,
          wavelengthMode: throughFocusWavelength,
          onProgress: reportProgress,
        });
      }

      setProgress(100);
      setProgressText('Done');
    } catch (caught: any) {
      setProgress(100);
      setProgressText('Failed');
      setError(String(caught?.message || caught || 'Analysis failed'));
    } finally {
      setBusy(false);
      window.setTimeout(() => {
        setProgressText((current) => current === 'Done' ? '' : current);
      }, 350);
    }
  }, [
    busy,
    lateralChiefRay,
    lateralPointCount,
    lateralRange,
    lateralRayCount,
    lateralRingCount,
    lateralSmoothN,
    opdFanGridSize,
    opdFanScale,
    referenceFocusMode,
    refreshSurfaceOptions,
    reportProgress,
    sphericalRayCount,
    spotPattern,
    spotRayCount,
    spotRingCount,
    surfaceId,
    surfaceOptions,
    throughFocusDefocus,
    throughFocusPattern,
    throughFocusRayCount,
    throughFocusRingCount,
    throughFocusScale,
    throughFocusSteps,
    throughFocusWavelength,
    transverseRayCount,
    type,
  ]);

  useEffect(() => {
    if (autoRunDoneRef.current || type === 'through-focus-spot') return;
    if (type === 'spot-diagram' && !surfaceId) return;
    autoRunDoneRef.current = true;
    const timer = window.setTimeout(() => { void runAnalysis(); }, 0);
    return () => window.clearTimeout(timer);
  }, [runAnalysis, surfaceId, type]);

  useEffect(() => {
    if (type !== 'opd-fan') return;
    const rerun = () => { void runAnalysis(); };
    for (const host of getWindowCandidates()) {
      try { host.addEventListener?.('coopt:primary-wavelength-updated', rerun); } catch (_) {}
    }
    return () => {
      for (const host of getWindowCandidates()) {
        try { host.removeEventListener?.('coopt:primary-wavelength-updated', rerun); } catch (_) {}
      }
    };
  }, [runAnalysis, type]);

  const showCommandbar = type !== 'integrated-aberration';
  const actionLabel = busy ? 'Calculating…' : 'Show';
  const actionTitle = type === 'spot-diagram'
    ? 'Show spot diagram'
    : type === 'magnification-chromatic-aberration'
      ? 'Show lateral chromatic aberration'
      : type === 'transverse-aberration'
        ? 'Show transverse aberration diagram'
        : type === 'opd-fan'
          ? 'Show OPD Fan'
          : type === 'through-focus-spot'
            ? 'Show Through-Focus Spot'
            : undefined;
  const selectedSurface = useMemo(
    () => surfaceOptions.find((option) => String(option.surfaceId) === surfaceId),
    [surfaceId, surfaceOptions],
  );

  return (
    <div className="analysis-window-page" data-analysis-kind={type}>
      {showCommandbar ? (
        <div className="analysis-window-commandbar">
          {type === 'spot-diagram' ? (
            <>
              <label className="analysis-window-field"><span>Surf</span>
                <select value={surfaceId} onChange={(event) => setSurfaceId(event.target.value)} aria-label="Surf">
                  {!surfaceOptions.length ? <option value="">Select Surf</option> : null}
                  {surfaceOptions.map((option) => <option key={`${option.surfaceId}-${option.rowIndex ?? ''}`} value={option.surfaceId}>{option.label}</option>)}
                </select>
              </label>
              <details className="analysis-window-options"><summary>Options</summary><div className="analysis-window-options__panel">
                <AnalysisRayCountField value={spotRayCount} max={20001} onValueChange={(value) => setSpotRayCount(Number(value))} />
                <label className="analysis-window-field"><span>Rings</span><select value={spotRingCount} onChange={(event) => setSpotRingCount(Number(event.target.value))}>{RING_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <label className="analysis-window-field"><span>Pupil pattern</span><select value={spotPattern} onChange={(event) => setSpotPattern(event.target.value as 'annular' | 'grid')}><option value="annular">Annular</option><option value="grid">Rectangle</option></select></label>
              </div></details>
            </>
          ) : null}

          {type === 'spherical-aberration' ? (
            <>
              <details className="analysis-window-options"><summary>Options</summary><div className="analysis-window-options__panel">
                <AnalysisRayCountField value={sphericalRayCount} max={1001} onValueChange={(value) => setSphericalRayCount(Number(value))} />
                <label className="analysis-window-field"><span>Reference focus</span><select value={referenceFocusMode} onChange={(event) => setReferenceFocusMode(event.target.value as any)}><option value="primary-paraxial">Primary paraxial</option><option value="current-paraxial">Current paraxial</option><option value="chief-ray">Chief ray</option></select></label>
                <span className="analysis-window-status">(Always normalized by stop diameter)</span>
              </div></details>
            </>
          ) : null}

          {type === 'magnification-chromatic-aberration' ? (
            <>
              <label className="analysis-window-field"><span>Lateral displacement (+/- mm)</span><input type="number" min={0} step={0.01} value={lateralRange} onChange={(event) => setLateralRange(Number(event.target.value))} /></label>
              <details className="analysis-window-options"><summary>Options</summary><div className="analysis-window-options__panel">
                <AnalysisRayCountField value={lateralRayCount} max={5001} onValueChange={(value) => setLateralRayCount(Number(value))} />
                <label className="analysis-window-field"><span>Field samples</span><input type="number" min={2} max={201} step={1} value={lateralPointCount} onChange={(event) => setLateralPointCount(Number(event.target.value))} /></label>
                <label className="analysis-window-field"><span>Rings</span><input type="number" min={1} max={99} step={1} value={lateralRingCount} onChange={(event) => setLateralRingCount(Number(event.target.value))} /></label>
                <label className="analysis-window-field"><span>Chief ray</span><select value={lateralChiefRay} onChange={(event) => setLateralChiefRay(event.target.value as any)}><option value="stop-center">Stop center</option><option value="beam-centroid">Beam centroid</option></select></label>
                <label className="analysis-window-field"><span>Smooth N</span><input type="number" min={0} max={50} step={1} value={lateralSmoothN} onChange={(event) => setLateralSmoothN(Number(event.target.value))} /></label>
              </div></details>
            </>
          ) : null}

          {type === 'transverse-aberration' ? (
            <>
              <details className="analysis-window-options"><summary>Options</summary><div className="analysis-window-options__panel">
                <AnalysisRayCountField value={transverseRayCount} min={9} max={10001} onValueChange={(value) => setTransverseRayCount(Number(value))} />
                <span className="analysis-window-status">(Always normalized by stop diameter)</span>
              </div></details>
            </>
          ) : null}

          {type === 'opd-fan' ? (
            <>
              <details className="analysis-window-options"><summary>Options</summary><div className="analysis-window-options__panel">
                <AnalysisGridSamplingField value={opdFanGridSize} options={[33, 65, 129]} onValueChange={(value) => setOpdFanGridSize(Number(value))} />
                <label className="analysis-window-field"><span>Aberration scale (± waves)</span><input type="number" min={0.001} step={0.01} value={opdFanScale} onChange={(event) => setOpdFanScale(Number(event.target.value))} /></label>
                <span className="analysis-window-status">Entrance pupil / image-point reference sphere / raw OPD</span>
              </div></details>
            </>
          ) : null}

          {type === 'through-focus-spot' ? (
            <>
              <label className="analysis-window-field"><span>Wavelength</span><select value={throughFocusWavelength} onChange={(event) => setThroughFocusWavelength(event.target.value as 'all' | 'primary')}><option value="all">All</option><option value="primary">Primary</option></select></label>
              <label className="analysis-window-field"><span>Defocus ±mm</span><input type="number" min={0} step={0.001} value={throughFocusDefocus} onChange={(event) => setThroughFocusDefocus(Number(event.target.value))} /></label>
              <details className="analysis-window-options"><summary>Options</summary><div className="analysis-window-options__panel">
                <AnalysisRayCountField value={throughFocusRayCount} max={20001} onValueChange={(value) => setThroughFocusRayCount(Number(value))} />
                <label className="analysis-window-field"><span>Rings</span><select value={throughFocusRingCount} onChange={(event) => setThroughFocusRingCount(Number(event.target.value))}>{RING_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
                <label className="analysis-window-field"><span>Pupil pattern</span><select value={throughFocusPattern} onChange={(event) => setThroughFocusPattern(event.target.value as 'annular' | 'grid')}><option value="annular">Annular</option><option value="grid">Rectangle</option></select></label>
                <label className="analysis-window-field"><span>Steps</span><input type="number" min={3} max={61} step={1} value={throughFocusSteps} onChange={(event) => setThroughFocusSteps(Number(event.target.value))} /></label>
                <label className="analysis-window-field"><span>Scale (µm)</span><input type="number" min={1} step={1} value={throughFocusScale} onChange={(event) => setThroughFocusScale(Number(event.target.value))} /></label>
              </div></details>
            </>
          ) : null}

          <button className="analysis-window-primary-action" type="button" title={actionTitle} onClick={() => void runAnalysis()} disabled={busy || (type === 'spot-diagram' && !selectedSurface)}>{actionLabel}</button>
        </div>
      ) : null}

      {(busy || !!progressText) ? <ProgressBar value={progress} text={progressText || 'Working...'} /> : null}
      <div className="analysis-window-result">
        {error ? <div className="analysis-window-error">{error}</div> : null}
        <div className="analysis-window-chart" ref={chartRef} />
      </div>
    </div>
  );
}
