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
    const raw = o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type;
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

export function plotDistortionPercent(dataArray, targetDivId = 'distortion-percent') {
  // Handle both single data object and array of data objects
  const dataList = Array.isArray(dataArray) ? dataArray : [dataArray];
  
  if (dataList.length === 0 || !dataList[0]) {
    console.warn('No valid data provided for distortion percent plot');
    return;
  }

  // Create a trace for each wavelength
  const traces = dataList.map((data, index) => {
    if (!data || !data.distortionPercent || !data.fieldValues) {
      console.warn(`Invalid data at index ${index}`);
      return null;
    }

    const wavelength = data.meta?.wavelength || 0.5876;
    const wavelengthNm = (wavelength * 1000).toFixed(1);
    const color = getWavelengthColor(wavelength);
    const isHeightMode = data.meta?.heightMode;
    const label = isHeightMode ? 'h' : 'θ';

    return {
      x: data.distortionPercent,  // Horizontal axis
      y: data.fieldValues,        // Vertical axis
      name: `DIST ${wavelengthNm}nm (${label})`,
      mode: 'lines',
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

  const heightMode = dataList.some(d => d?.meta?.heightMode);

  const layout = {
    title: heightMode ? 'Distortion vs Object Height' : 'Distortion vs Object Angle',
    xaxis: { 
      title: 'Distortion (%)',
      range: [-5, 5],  // 基本±5%
      dtick: 1  // 1%刻みの目盛り
    },
    yaxis: { title: heightMode ? 'Object Height (mm)' : 'Object Angle θ (deg)' },
    width: 800,
    height: 600,
    showlegend: true,
    legend: { orientation: 'v', x: 1.02, y: 1 },
    shapes: [
      { 
        type: 'line', 
        x0: 0, x1: 0, 
        y0: minFieldValue, y1: maxFieldValue, 
        line: { color: 'black', width: 1, dash: 'dot' } 
      }
    ]
  };

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
  plotDistortionPercent(allData, targetElement || 'distortion-percent');
  
  return allData;
}

/**
 * Plot grid distortion diagram showing ideal grid (lines) and real grid (markers).
 * @param {Object} data - grid distortion data from calculateGridDistortion.
 * @param {string} targetDivId - target div ID for Plotly.
 */
export async function plotGridDistortion(data, targetDivId = 'distortion-grid', onProgress = null) {
  if (!data || !data.idealGrid || !data.realGrid) {
    console.warn('Invalid data for grid distortion plot');
    return;
  }

  const progress = (typeof onProgress === 'function') ? onProgress : null;
  const reportProgress = (percent, message) => {
    try {
      progress?.({ percent, message });
    } catch (_) {}
  };

  const { idealGrid, realGrid, gridSize, maxFieldAngle, meta } = data;
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
      line: { color: '#888888', width: 1 },
      showlegend: i === 0,
      name: i === 0 ? 'Ideal Grid' : undefined,
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
      line: { color: '#888888', width: 1 },
      showlegend: false,
      hoverinfo: 'skip'
    });

    if ((j + 1) % 10 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // Collect real positions (points only)
  let validPointCount = 0;
  const realX = [];
  const realY = [];
  const totalPoints = Math.max(1, realGrid.x.length);
  
  for (let i = 0; i < realGrid.x.length; i++) {
    const x = realGrid.x[i];
    const y = realGrid.y[i];
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
    }

    const pct = ((i + 1) / totalPoints) * 100;
    reportProgress(pct, `Grid distortion: ${i + 1}/${totalPoints}`);

    if ((i + 1) % 50 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  console.log(`📊 Grid distortion: ${validPointCount} valid points (${realGrid.x.length - validPointCount} failed)`);

  // Add real grid points
  traces.push({
    x: realX,
    y: realY,
    mode: 'markers',
    marker: { 
      color: getWavelengthColor(meta.wavelength),
      size: 4,
      symbol: 'circle',
      opacity: 0.8
    },
    name: `Real Positions (λ=${meta.wavelength.toFixed(4)} μm)`,
    hovertemplate: 'Real: (%{x:.3f}, %{y:.3f}) mm<extra></extra>'
  });

  const maxAbsIdealX = idealGrid.x.reduce((m, v) => (isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
  const maxAbsIdealY = idealGrid.y.reduce((m, v) => (isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
  const equalRangeHalf = Math.max(maxAbsIdealX, maxAbsIdealY, 1e-9);

  const layout = {
    title: `Grid Distortion (${gridSize}×${gridSize}, λ=${meta.wavelength.toFixed(4)} μm)`,
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
