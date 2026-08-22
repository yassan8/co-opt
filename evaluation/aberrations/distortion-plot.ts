// eva-distortion-plot.js
// Plotting utilities for distortion using Plotly.
// Automatically derives field sweep from Object table (angles or object heights).
// Supports multi-wavelength plotting from Source table.

import { calculateDistortionData, calculateGridDistortion } from './distortion.ts';
import { getObjectRows, getOpticalSystemRows, getSourceRows } from '../../utils/data-utils.ts';
import { getPrimaryWavelength } from '../../data/glass.ts';

function inferObjectFieldMode(objects) {
  const rows = Array.isArray(objects) ? objects : [];
  const pickTag = (o) => {
    const raw = o?.__cooptOriginalPosition ?? o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type;
    return (raw ?? '').toString().toLowerCase();
  };
  const tags = rows.map(pickTag).filter(Boolean);

  // Explicit Rectangle/Height wins
  const hasRect = tags.some(t => t.includes('rect') || t.includes('rectangle'));
  const hasHeight = tags.some(t => t.includes('height'));
  if (hasRect || hasHeight) return { mode: 'height' };

  // Explicit Angle
  const hasAngle = tags.some(t => t.includes('angle'));
  if (hasAngle) return { mode: 'angle' };

  // Fallback: infer from data columns (but do NOT treat yHeightAngle as height)
  const hasNumericHeight = rows.some(o => {
    const h = parseFloat(o?.yHeight ?? o?.y ?? o?.height ?? o?.y_height ?? NaN);
    return Number.isFinite(h) && Math.abs(h) > 0;
  });
  return { mode: hasNumericHeight ? 'height' : 'angle' };
}

function resolveFieldAxisLabel(objects) {
  const mode = inferObjectFieldMode(objects)?.mode;
  const rows = Array.isArray(objects) ? objects : [];
  const tags = rows
    .map((o) => String(o?.__cooptOriginalPosition ?? o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type ?? '').toLowerCase())
    .filter(Boolean);

  if (tags.some((tag) => tag.includes('imageheight'))) {
    return {
      mode: 'image-height',
      title: 'Distortion vs Image Height',
      axisTitle: 'Image Height (mm)',
      traceLabel: 'img'
    };
  }

  if (mode === 'height') {
    return {
      mode: 'height',
      title: 'Distortion vs Object Height',
      axisTitle: 'Object Height (mm)',
      traceLabel: 'h'
    };
  }

  return {
    mode: 'angle',
    title: 'Distortion vs Object Angle',
    axisTitle: 'Object Angle θ (deg)',
    traceLabel: 'θ'
  };
}

export function deriveMaxFieldAngleFromObjects() {
  let objects = [];
  try { objects = getObjectRows(); } catch (_) { objects = []; }
  if (!objects || objects.length === 0) return 20; // fallback

  // ObjectテーブルがRectangle/Heightの場合は角度スイープをしない
  const mode = inferObjectFieldMode(objects);
  if (mode.mode === 'height') return 0;

  let maxAngle = 0;
  for (const o of objects) {
    // Accept various property names
    // 注意: Heightモード判定の誤爆を避けるため、ここでは height 系(y)を角度として扱わない
    const candidates = [o.yFieldAngle, o.yAngle, o.fieldAngle, o.xFieldAngle, o.xAngle, o.xHeightAngle, o.yHeightAngle];
    for (const c of candidates) {
      if (typeof c === 'number' && isFinite(c)) {
        maxAngle = Math.max(maxAngle, Math.abs(c));
      }
    }
  }
  return maxAngle > 0 ? maxAngle : 20;
}

function deriveHeightSweepFromObjects(interpolationPoints = 10) {
  let objects = [];
  try { objects = getObjectRows(); } catch (_) { objects = []; }
  if (!objects || objects.length === 0) return null;

  // ObjectテーブルがAngleの場合はheightスイープを生成しない
  const mode = inferObjectFieldMode(objects);
  if (mode.mode === 'angle') return null;

  const heights = objects
    // Heightモードでは yHeight / y / height を優先。Angle系(yHeightAngle等)は混ぜない。
    .map(o => parseFloat(o.yHeight ?? o.y ?? o.height ?? o.y_height ?? NaN))
    .filter(v => Number.isFinite(v));

  if (heights.length === 0) return null;

  let minH = Math.min(...heights);
  let maxH = Math.max(...heights);
  if (minH <= 0) {
    minH = 0.001;
    if (maxH < minH) maxH = minH;
  }
  if (minH === maxH) return [minH];

  const pts = interpolationPoints && interpolationPoints > 1 ? interpolationPoints : heights.length;
  const result = [];
  for (let i = 0; i < pts; i++) {
    const h = minH + (maxH - minH) * i / (pts - 1);
    result.push(parseFloat(h.toFixed(6)));
  }
  return result;
}

function generateAngleSweep(maxAngle, step) {
  const angles = [];
  const minAngle = maxAngle * 0.001;  // 軸上色収差の観点から0を避ける
  for (let a = minAngle; a <= maxAngle + 1e-9; a += step) angles.push(parseFloat(a.toFixed(6)));
  if (angles[angles.length - 1] !== maxAngle) angles.push(maxAngle); // ensure exact max
  return angles;
}

function chooseStep(maxAngle) {
  if (maxAngle <= 5) return 0.5;
  if (maxAngle <= 15) return 1;
  if (maxAngle <= 40) return 2;
  return Math.ceil(maxAngle / 25); // coarse fallback
}

// Wavelength to color mapping (standard spectral colors)
function getWavelengthColor(wavelength) {
  if (wavelength < 0.45) return '#8B00FF';      // 青紫（g線）
  if (wavelength < 0.495) return '#0000FF';     // 青（F線）
  if (wavelength < 0.57) return '#00FF00';      // 緑
  if (wavelength < 0.59) return '#9ACD32';      // 濃い黄緑（d線）
  if (wavelength < 0.62) return '#FF8800';      // オレンジ
  return '#FF0000';                              // 赤（C線）
}

function resolvePlotTarget(target) {
  if (!target) return { element: null, plotly: null, isElement: false };
  if (typeof target === 'string') {
    const el = document.getElementById(target);
    const plotly = el?.ownerDocument?.defaultView?.Plotly || (typeof Plotly !== 'undefined' ? Plotly : null);
    return { element: el, plotly, isElement: false };
  }
  const el = target;
  const plotly = el?.ownerDocument?.defaultView?.Plotly || (typeof Plotly !== 'undefined' ? Plotly : null);
  return { element: el, plotly, isElement: true };
}

function resolveEnlargementFactor(options = {}) {
  const explicit = Number(options?.enlargementFactor);
  if (Number.isFinite(explicit)) return explicit;
  try {
    const candidates = [
      document.getElementById('enlargement-factor-input'),
      document.getElementById('grid-enlargement-factor-input'),
      document.getElementById('popup-enlargement-factor-input'),
      document.getElementById('popup-grid-enlargement-factor-input'),
    ];
    for (const el of candidates) {
      const raw = el && 'value' in el ? Number(el.value) : Number.NaN;
      if (Number.isFinite(raw)) return raw;
    }
  } catch (_) {
    // ignore DOM lookup failures
  }
  return 1;
}

function estimateGridHorizontalOffset(idealGrid, realGrid) {
  const idealX = Array.isArray(idealGrid?.x) ? idealGrid.x : [];
  const idealY = Array.isArray(idealGrid?.y) ? idealGrid.y : [];
  const realX = Array.isArray(realGrid?.x) ? realGrid.x : [];
  const n = Math.min(idealX.length, idealY.length, realX.length);
  if (n <= 0) return null;

  let minAbsY = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const y = Number(idealY[i]);
    if (Number.isFinite(y)) minAbsY = Math.min(minAbsY, Math.abs(y));
  }
  if (!Number.isFinite(minAbsY)) return null;

  const tol = Math.max(1e-9, minAbsY * 1e-6);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const xIdeal = Number(idealX[i]);
    const yIdeal = Number(idealY[i]);
    const xReal = Number(realX[i]);
    if (!Number.isFinite(xIdeal) || !Number.isFinite(yIdeal) || !Number.isFinite(xReal)) continue;
    if (Math.abs(Math.abs(yIdeal) - minAbsY) > tol) continue;
    pairs.push({ xIdeal, absX: Math.abs(xIdeal), dx: xIdeal - xReal });
  }

  if (pairs.length === 0) return null;
  pairs.sort((a, b) => a.absX - b.absX);

  // Use center-near samples first to avoid unstable extrapolation at large EF.
  const nearCenter = pairs.filter((p) => p.absX <= (pairs[0]?.absX ?? 0) + 1e-9);
  if (nearCenter.length > 0) {
    const mean = nearCenter.reduce((s, p) => s + p.dx, 0) / nearCenter.length;
    return Number.isFinite(mean) ? mean : null;
  }

  // Fallback: median of the nearest 3 points by |X|.
  const nearest = pairs.slice(0, Math.min(3, pairs.length)).map((p) => p.dx).filter((v) => Number.isFinite(v));
  if (nearest.length === 0) return null;
  nearest.sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)];
}

export function plotDistortionPercent(dataArray, targetDivId = 'distortion-percent', options = {}) {
  // Handle both single data object and array of data objects
  const dataList = Array.isArray(dataArray) ? dataArray : [dataArray];
  const enlargementFactor = resolveEnlargementFactor(options);
  
  if (dataList.length === 0 || !dataList[0]) {
    console.warn('No valid data provided for distortion percent plot');
    return;
  }

  const fieldAxisLabel = resolveFieldAxisLabel(options?.objectRows);

  // Create a trace for each wavelength
  const traces = dataList.map((data, index) => {
    if (!data || !data.distortionPercent || !data.fieldValues) {
      console.warn(`Invalid data at index ${index}`);
      return null;
    }

    const wavelength = data.meta?.wavelength || 0.5876;
    const wavelengthNm = (wavelength * 1000).toFixed(1);
    const color = getWavelengthColor(wavelength);
  const label = fieldAxisLabel.traceLabel;
    const scaledDistortionPercent = data.distortionPercent.map((value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n * enlargementFactor : null;
    });

    return {
      x: scaledDistortionPercent,  // Horizontal axis
      y: data.fieldValues,        // Vertical axis
      name: `DIST ${wavelengthNm}nm (${label})`,
      mode: 'lines',
      connectgaps: false,
      line: { color, width: 2 }
    };
  }).filter(trace => trace !== null);

  // Find min/max field value across all datasets for reference line
  const maxFieldValue = Math.max(...dataList.map(data => 
    data.fieldValues ? Math.max(...data.fieldValues) : 0
  ));
  const minFieldValue = Math.min(...dataList.map(data => 
    data.fieldValues ? Math.min(...data.fieldValues) : 0
  ));

  const layout = {
    title: fieldAxisLabel.title,
    xaxis: { 
      title: 'Distortion (%)'
    },
    yaxis: { title: fieldAxisLabel.axisTitle },
    width: 800,
    height: 600,
    showlegend: true,
    legend: { orientation: 'v', x: 1.02, y: 1 }
  };

  const rangeAbs = Number(options?.distortionRangeAbs);
  if (Number.isFinite(rangeAbs) && rangeAbs > 0) {
    layout.xaxis.range = [-rangeAbs, rangeAbs];
  }

  const { element, plotly, isElement } = resolvePlotTarget(targetDivId);
  if (!plotly) {
    console.warn('Plotly not available; cannot plot distortion percent');
    return;
  }

  const config = { responsive: true, displayModeBar: true, displaylogo: false };
  if (isElement && element) {
    layout.autosize = true;
    delete layout.width;
    delete layout.height;
    plotly.newPlot(element, traces, layout, config);
  } else {
    plotly.newPlot(targetDivId, traces, layout, config);
  }
}

export async function generateDistortionPlots({
  opticalSystemRows = null,
  fieldAnglesDeg = null,
  wavelength = null,
  step = null,
  targetElement = null,
  onProgress = null
} = {}) {
  const rows = opticalSystemRows || getOpticalSystemRows();
  let objects = [];
  try { objects = getObjectRows(); } catch (_) { objects = []; }

  // Determine whether to use angles or object heights from Object table field type (Angle/Rectangle)
  const fieldMode = inferObjectFieldMode(objects);
  const heightMode = fieldMode.mode === 'height';
  const heightSweep = heightMode ? deriveHeightSweepFromObjects() : null;

  // Determine field samples
  let fieldValues = fieldAnglesDeg;
  if (!fieldValues) {
    if (heightMode) {
      fieldValues = Array.isArray(heightSweep) && heightSweep.length > 0 ? heightSweep : [0.001];
    } else {
      const maxAngle = deriveMaxFieldAngleFromObjects();
      const chosenStep = step || chooseStep(maxAngle);
      fieldValues = generateAngleSweep(maxAngle, chosenStep);
    }
  }

  // Get wavelengths from Source table
  const sources = getSourceRows();
  let wavelengths = [];
  
  // Use all wavelengths from Source table
  if (sources && sources.length > 0) {
    wavelengths = sources
      .filter(s => s && typeof s.wavelength === 'number' && s.wavelength > 0)
      .map(s => s.wavelength);
  }
  
  // Fallback to primary wavelength if no sources
  if (wavelengths.length === 0) {
    const primaryWavelength = getPrimaryWavelength();
    wavelengths = [primaryWavelength];
    console.log('Using primary wavelength for distortion:', primaryWavelength);
  } else {
    console.log('Using wavelengths from Source table:', wavelengths);
  }

  // Calculate distortion for all wavelengths
  const progress = (typeof onProgress === 'function') ? onProgress : null;
  const allData = [];
  for (let wlIndex = 0; wlIndex < wavelengths.length; wlIndex++) {
    const wl = wavelengths[wlIndex];
    const base = (wlIndex / Math.max(1, wavelengths.length)) * 100;
    const span = 100 / Math.max(1, wavelengths.length);
    const dist = await calculateDistortionData(rows, fieldValues, wl, {
      heightMode,
      onProgress: progress
        ? (evt) => {
            try {
              const p = Number(evt?.percent);
              const msg = evt?.message || evt?.phase || 'Working...';
              const mapped = Number.isFinite(p) ? (base + (span * p) / 100) : base;
              progress({ percent: mapped, message: `Distortion (λ=${wl.toFixed(4)} μm): ${msg}` });
            } catch (_) {}
          }
        : null
    });
    if (dist) allData.push(dist);
  }

  if (allData.length === 0) {
    console.warn('Failed to calculate distortion data for any wavelength');
    return null;
  }

  // Plot all wavelengths
  plotDistortionPercent(allData, targetElement || 'distortion-percent', { objectRows: objects });
  
  return allData;
}

/**
 * Plot grid distortion diagram showing ideal and real grids as lines.
 * @param {Object} data - grid distortion data from calculateGridDistortion.
 * @param {string} targetDivId - target div ID for Plotly.
 */
export async function plotGridDistortion(data, targetDivId = 'distortion-grid', onProgress = null) {
  const options = arguments.length > 3 ? (arguments[3] || {}) : {};
  if (!data || !data.idealGrid || !data.realGrid) {
    console.warn('Invalid data for grid distortion plot');
    return;
  }
  const enlargementFactor = resolveEnlargementFactor(options);

  const progress = (typeof onProgress === 'function') ? onProgress : null;
  const reportProgress = (percent, message) => {
    try {
      progress?.({ percent, message });
    } catch (_) {}
  };

  const { idealGrid, realGrid, gridSize, maxFieldAngle, meta } = data;
  const horizontalOffset = estimateGridHorizontalOffset(idealGrid, realGrid);
  const offsetRealGrid = {
    x: realGrid.x.map((value) => {
      if (value === null || value === undefined) return null;
      const x = Number(value);
      if (!Number.isFinite(x)) return null;
      return Number.isFinite(Number(horizontalOffset)) ? x + Number(horizontalOffset) : x;
    }),
    y: realGrid.y.map((value) => {
      if (value === null || value === undefined) return null;
      const y = Number(value);
      return Number.isFinite(y) ? y : null;
    }),
  };
  const scaledRealGrid = {
    x: offsetRealGrid.x.map((value, index) => {
      if (value === null || value === undefined) return null;
      const realX = Number(value);
      const idealX = Number(idealGrid.x[index]);
      if (!Number.isFinite(realX) || !Number.isFinite(idealX)) return null;
      const distortionX = enlargementFactor * (idealX - realX);
      return idealX - distortionX;
    }),
    y: offsetRealGrid.y.map((value, index) => {
      if (value === null || value === undefined) return null;
      const realY = Number(value);
      const idealY = Number(idealGrid.y[index]);
      if (!Number.isFinite(realY) || !Number.isFinite(idealY)) return null;
      const distortionY = enlargementFactor * (idealY - realY);
      return idealY - distortionY;
    }),
  };
  const traces = [];

  // Create ideal grid lines (horizontal and vertical)
  // Horizontal lines
  for (let i = 0; i < gridSize; i++) {
    const startIdx = i * gridSize;
    const endIdx = startIdx + gridSize - 1;
    const xLine = idealGrid.x.slice(startIdx, endIdx + 1);
    const yLine = idealGrid.y.slice(startIdx, endIdx + 1);
    
    traces.push({
      x: xLine,
      y: yLine,
      mode: 'lines',
      line: { color: '#000000', width: 2 },
      showlegend: i === 0,
      name: i === 0 ? 'Theoretical Grid' : undefined,
      hoverinfo: 'skip'
    });

    if ((i + 1) % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // Vertical lines
  for (let j = 0; j < gridSize; j++) {
    const xLine = [];
    const yLine = [];
    for (let i = 0; i < gridSize; i++) {
      const idx = i * gridSize + j;
      xLine.push(idealGrid.x[idx]);
      yLine.push(idealGrid.y[idx]);
    }
    
    traces.push({
      x: xLine,
      y: yLine,
      mode: 'lines',
      line: { color: '#000000', width: 2 },
      showlegend: false,
      hoverinfo: 'skip'
    });

    if ((j + 1) % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const realGridColor = '#ff0000';

  // Draw real distorted grid mesh so every cell is visible.
  for (let i = 0; i < gridSize; i++) {
    const rowX = [];
    const rowY = [];
    for (let j = 0; j < gridSize; j++) {
      const idx = i * gridSize + j;
      const x = scaledRealGrid.x[idx];
      const y = scaledRealGrid.y[idx];
      rowX.push((x !== null && x !== undefined && isFinite(x)) ? x : null);
      rowY.push((y !== null && y !== undefined && isFinite(y)) ? y : null);
    }
    traces.push({
      x: rowX,
      y: rowY,
      mode: 'lines',
      line: { color: realGridColor, width: 1 },
      showlegend: i === 0,
      name: i === 0 ? `Distortion Grid (λ=${meta.wavelength.toFixed(4)} μm)` : undefined,
      hoverinfo: 'skip',
      connectgaps: false,
      type: 'scatter'
    });
  }

  for (let j = 0; j < gridSize; j++) {
    const colX = [];
    const colY = [];
    for (let i = 0; i < gridSize; i++) {
      const idx = i * gridSize + j;
      const x = scaledRealGrid.x[idx];
      const y = scaledRealGrid.y[idx];
      colX.push((x !== null && x !== undefined && isFinite(x)) ? x : null);
      colY.push((y !== null && y !== undefined && isFinite(y)) ? y : null);
    }
    traces.push({
      x: colX,
      y: colY,
      mode: 'lines',
      line: { color: realGridColor, width: 1 },
      showlegend: false,
      hoverinfo: 'skip',
      connectgaps: false,
      type: 'scatter'
    });
  }

  // Collect real positions (points only)
  let validPointCount = 0;
  const realX = [];
  const realY = [];
  const blockedX = [];
  const blockedY = [];
  const totalPoints = Math.max(1, scaledRealGrid.x.length);
  
  for (let i = 0; i < scaledRealGrid.x.length; i++) {
    const x = scaledRealGrid.x[i];
    const y = scaledRealGrid.y[i];
    const idealX = idealGrid.x[i];
    const idealY = idealGrid.y[i];
    
    // Filter out null, undefined, and non-finite values
    if (x !== null && y !== null &&
        x !== undefined && y !== undefined &&
        isFinite(x) && isFinite(y) &&
        isFinite(idealX) && isFinite(idealY)) {
      
      realX.push(x);
      realY.push(y);
      
      validPointCount++;
    } else if (isFinite(idealX) && isFinite(idealY)) {
      blockedX.push(idealX);
      blockedY.push(idealY);
    }

    const pct = ((i + 1) / totalPoints) * 100;
    reportProgress(pct, `Grid distortion: ${i + 1}/${totalPoints}`);

    if ((i + 1) % 50 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  console.log(`📊 Grid distortion: ${validPointCount} valid points (${scaledRealGrid.x.length - validPointCount} failed)`);
  if (blockedX.length > 0) {
    traces.push({
      x: blockedX,
      y: blockedY,
      mode: 'markers',
      marker: { color: '#dc2626', size: 12, symbol: 'x', line: { color: '#ffffff', width: 1 } },
      name: `Unreached field (${blockedX.length})`,
      text: blockedX.map((x, index) => `Ideal position: (${Number(x).toFixed(3)}, ${Number(blockedY[index]).toFixed(3)}) mm`),
      hovertemplate: '<b>Unreached ray</b><br>%{text}<extra></extra>',
      showlegend: true,
      type: 'scatter',
    });
  }
  const displayGridSize = Number.isFinite(Number(meta?.requestedGridSize)) && Number(meta?.requestedGridSize) > 0
    ? Number(meta.requestedGridSize)
    : Math.max(1, gridSize - 1);

  const maxAbsIdealX = idealGrid.x.reduce((m, v) => (isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
  const maxAbsIdealY = idealGrid.y.reduce((m, v) => (isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
    const maxAbsRealX = scaledRealGrid.x.reduce((m, v) => (isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
    const maxAbsRealY = scaledRealGrid.y.reduce((m, v) => (isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
  const objectMaxHeight = Number(meta?.objectMaxHeight);
    const baseRangeHalf = (Number.isFinite(objectMaxHeight) && objectMaxHeight > 0)
    ? Math.max(objectMaxHeight, 1e-9)
    : Math.max(maxAbsIdealX, maxAbsIdealY, 1e-9);
    const equalRangeHalf = Math.max(baseRangeHalf, maxAbsRealX, maxAbsRealY, 1e-9);

  const layout = {
    title: `Grid Distortion (${displayGridSize}×${displayGridSize}, λ=${meta.wavelength.toFixed(4)} μm, valid=${validPointCount}/${scaledRealGrid.x.length})`,
    xaxis: { 
      title: 'Image Height X (mm)',
      scaleanchor: 'y',
      scaleratio: 1,
      zeroline: false,
      range: [-equalRangeHalf, equalRangeHalf]
    },
    yaxis: { 
      title: 'Image Height Y (mm)',
      zeroline: false,
      range: [-equalRangeHalf, equalRangeHalf]
    },
    width: 800,
    height: 800,
    hovermode: 'closest',
    showlegend: true,
    legend: { x: 1.02, y: 1 }
  };

  const { element, plotly, isElement } = resolvePlotTarget(targetDivId);
  if (!plotly) {
    console.warn('Plotly not available; cannot plot grid distortion');
    return;
  }

  const config = { responsive: true, displayModeBar: true, displaylogo: false };
  if (isElement && element) {
    layout.autosize = true;
    delete layout.width;
    delete layout.height;
    plotly.newPlot(element, traces, layout, config);
  } else {
    plotly.newPlot(targetDivId, traces, layout, config);
  }
}

/**
 * Generate grid distortion plots with automatic max angle detection.
 * @param {Object} options - configuration options.
 * @returns {Object} grid distortion data.
 */
export async function generateGridDistortionPlot({
  opticalSystemRows = null,
  gridSize = 20,
  wavelength = 0.5876,
  targetElement = null,
  onProgress = null
} = {}) {
  const rows = opticalSystemRows || getOpticalSystemRows();
  const progress = (typeof onProgress === 'function') ? onProgress : null;
  const reportProgress = (percent, message) => {
    try {
      progress?.({ percent, message });
    } catch (_) {}
  };
  
  const data = await calculateGridDistortion(rows, gridSize, wavelength, {
    onProgress: progress
      ? (evt) => {
          const p = Number(evt?.percent);
          const msg = evt?.message || evt?.phase || 'Grid distortion raytrace...';
          const mapped = Number.isFinite(p) ? Math.max(0, Math.min(20, p * 0.2)) : 5;
          reportProgress(mapped, msg);
        }
      : null
  });
  if (!data) {
    console.error('Failed to calculate grid distortion');
    return null;
  }

  await plotGridDistortion(
    data,
    targetElement || 'distortion-grid',
    progress
      ? (evt) => {
          const p = Number(evt?.percent);
          const msg = evt?.message || evt?.phase || 'Grid distortion plotting...';
          const mapped = Number.isFinite(p) ? Math.max(20, Math.min(100, 20 + p * 0.8)) : 20;
          reportProgress(mapped, msg);
        }
      : null
  );
  return data;
}

if (typeof window !== 'undefined') {
  window['plotDistortionPercent'] = plotDistortionPercent;
  window['generateDistortionPlots'] = generateDistortionPlots;
  window['plotGridDistortion'] = plotGridDistortion;
  window['generateGridDistortionPlot'] = generateGridDistortionPlot;
}
