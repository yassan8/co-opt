// eva-distortion.js
// Distortion (歪曲収差) core calculation module
// Definition (angle): D(θ) = (h_real' - h_ideal') / h_ideal'
// h_ideal' = f' * tan(θ)  (infinite object assumption) or approx for small θ: f' * θ(rad)
// Height mode: use object height h_obj and paraxial倍率 m ≈ imageDistance / objectDistance (fallback: -1) to set h_ideal' = m * h_obj
// This module sweeps either field angles (deg) or object heights (mm, Y) and traces the chief ray.
// Returns both absolute heights and distortion ratio (percentage).

import { calculateParaxialData } from '../../raytracing/core/ray-paraxial.ts';
import { calculateChiefRayNewton } from './transverse-aberration.ts';
import { calculateSurfaceOrigins } from '../../raytracing/core/ray-tracing.ts';

function withWebRustWasmTraceOverride<T>(callback: () => Promise<T> | T, requireRustWasm = true): Promise<T> | T {
  const g: any = (typeof globalThis !== 'undefined') ? globalThis : null;
  if (!g) return callback();

  const key = '__cooptTraceOptionsOverride';
  const prev = g[key];
  const prevObj = (prev && typeof prev === 'object' && !Array.isArray(prev)) ? prev : null;
  g[key] = {
    ...(prevObj || {}),
    useRustWasm: true,
    requireRustWasm: !!requireRustWasm,
    // Keep Rust/WASM path, but avoid over-strict forward-hit filtering on web.
    requireForwardHit: false,
    allowNonStrict: true,
  };

  const restore = () => {
    if (prev === undefined) delete g[key];
    else g[key] = prev;
  };

  try {
    const out = callback();
    if (out && typeof (out as any).then === 'function') {
      return (out as Promise<T>).finally(() => {
        try { restore(); } catch (_) {}
      });
    }
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

// Helper function to detect mirror surfaces
function isMirrorRow(row) {
  if (!row) return false;
  if (row.material === 'MIRROR') return true;
  if (row.type === 'Mirror') return true;
  if (row._blockType === 'Mirror') return true;
  const surfType = String(row.surfType ?? row.type ?? row.surfaceType ?? '').trim().toLowerCase();
  return surfType === 'mirror';
}

// Helper function to apply rotation matrix to vector
function applyRotationMatrixToVector(matrix, v) {
  if (!matrix) return { x: v.x, y: v.y, z: v.z };
  const x = matrix[0][0] * v.x + matrix[0][1] * v.y + matrix[0][2] * v.z;
  const y = matrix[1][0] * v.x + matrix[1][1] * v.y + matrix[1][2] * v.z;
  const z = matrix[2][0] * v.x + matrix[2][1] * v.y + matrix[2][2] * v.z;
  return { x, y, z };
}

// Helper to get object rows (avoid circular dependency)
function getObjectRowsLocal() {
  if (typeof window !== 'undefined' && typeof window.getObjectRows === 'function') {
    return window.getObjectRows();
  }
  return [];
}

function deriveMaxFieldAngleLocal() {
  let objects = [];
  try { objects = getObjectRowsLocal(); } catch (_) { objects = []; }
  if (!objects || objects.length === 0) return 20; // fallback
  let maxAngle = 0;
  for (const o of objects) {
    const candidates = [o.yHeightAngle, o.yFieldAngle, o.y, o.yAngle, o.fieldAngle, o.xHeightAngle, o.xFieldAngle];
    for (const c of candidates) {
      if (typeof c === 'number' && isFinite(c)) {
        maxAngle = Math.max(maxAngle, Math.abs(c));
      }
    }
  }
  return maxAngle > 0 ? maxAngle : 20;
}

function deriveHeightSamplesLocal(interpolationPoints = 10) {
  let objects = [];
  try { objects = getObjectRowsLocal(); } catch (_) { objects = []; }
  if (!objects || objects.length === 0) return null;

  const heights = objects
    .map(o => parseFloat(o.yHeight ?? o.y ?? o.yHeightAngle ?? 0))
    .filter(v => Number.isFinite(v));

  if (heights.length === 0) return null;

  let minH = Math.min(...heights);
  let maxH = Math.max(...heights);
  // skip 0mm: start from 0.001mm when non-positive
  if (minH <= 0) {
    minH = 0.001;
    if (maxH < minH) maxH = minH;
  }
  if (minH === maxH) return [minH];

  const pts = interpolationPoints && interpolationPoints > 1 ? interpolationPoints : heights.length;
  const result = [];
  for (let i = 0; i < pts; i++) {
    const h = minH + (maxH - minH) * i / (pts - 1);
    result.push(h);
  }
  return result;
}

function isFiniteSystem(opticalSystemRows) {
  if (!opticalSystemRows || opticalSystemRows.length === 0) return false;
  // Heuristic: if first surface has ObjectDistance or thickness negative large? Simplify: check first surface type
  // Existing modules reimplement; for distortion we assume infinite unless an 'OBJ' surface with finite distance exists.
  const first = opticalSystemRows[0];
  if (!first) return false;
  // If first surface thickness is finite and not zero and there is 'Object' indicator
  return !!first.isObjectSpace && typeof first.thickness === 'number' && isFinite(first.thickness) && first.thickness > 0;
}

async function tryCalculateDistortionDataNative(opticalSystemRows, fieldSamples, wavelength, heightMode, imageSurfaceIndex, onProgress = null) {
  try {
    const runtime = await import('../../src/desktop/runtime.ts');
    if (!runtime?.isTauriRuntime || !runtime.isTauriRuntime()) {
      return null;
    }

    const { runNativeSpotRaytrace } = await import('../../src/desktop/ipc/client.ts');
    if (typeof runNativeSpotRaytrace !== 'function') {
      return null;
    }

    const objectRows = fieldSamples.map((sample, index) => {
      if (heightMode) {
        return {
          id: `Field-${index}`,
          name: `h=${sample}`,
          position: 'Rectangle',
          xHeight: 0,
          yHeight: sample,
          x: 0,
          y: sample,
        };
      }
      return {
        id: `Field-${index}`,
        name: `θ=${sample}`,
        position: 'Angle',
        xHeightAngle: 0,
        yHeightAngle: sample,
        x: 0,
        y: sample,
      };
    });

    const sourceRows = [{
      id: 'DistortionNativeSource',
      name: 'DistortionNativeSource',
      wavelength,
      color: '#22c55e',
      isPrimary: true,
      intensity: 1,
    }];

    try {
      onProgress?.({ percent: 2, message: 'Distortion native raytrace...' });
    } catch (_) {}

    const response = await runNativeSpotRaytrace({
      opticalSystemRows,
      sourceRows,
      objectRows,
      surfaceIndex: imageSurfaceIndex,
      rayCount: 11,
      ringCount: 1,
      pattern: 'cross',
      wavelengthMode: 'primary',
    });

    const heights = new Array(fieldSamples.length).fill(null);
    const parseIndex = (label) => {
      const m = String(label || '').match(/Field-(\d+)/);
      if (!m) return null;
      const idx = Number(m[1]);
      return Number.isInteger(idx) ? idx : null;
    };

    const series = Array.isArray(response?.series) ? response.series : [];
    for (const row of series) {
      const idx = parseIndex(row?.label);
      if (idx === null || idx < 0 || idx >= heights.length) continue;
      const chiefYum = Number(row?.chiefPointUm?.yUm);
      if (Number.isFinite(chiefYum)) {
        heights[idx] = Math.abs(chiefYum) / 1000.0;
      }
    }

    return heights;
  } catch (_) {
    return null;
  }
}

async function tryCalculateGridDistortionNative(opticalSystemRows, objectRows, wavelength, imageSurfaceIndex, onProgress = null) {
  try {
    const runtime = await import('../../src/desktop/runtime.ts');
    if (!runtime?.isTauriRuntime || !runtime.isTauriRuntime()) {
      return null;
    }

    const { runNativeSpotRaytrace } = await import('../../src/desktop/ipc/client.ts');
    if (typeof runNativeSpotRaytrace !== 'function') {
      return null;
    }

    const sourceRows = [{
      id: 'GridDistortionNativeSource',
      name: 'GridDistortionNativeSource',
      wavelength,
      color: '#22c55e',
      isPrimary: true,
      intensity: 1,
    }];

    try {
      onProgress?.({ percent: 2, message: 'Grid distortion native raytrace...' });
    } catch (_) {}

    const response = await runNativeSpotRaytrace({
      opticalSystemRows,
      sourceRows,
      objectRows,
      surfaceIndex: imageSurfaceIndex,
      rayCount: 11,
      ringCount: 1,
      pattern: 'cross',
      wavelengthMode: 'primary',
    });

    const parseIndex = (label) => {
      const m = String(label || '').match(/Field-(\d+)/);
      if (!m) return null;
      const idx = Number(m[1]);
      return Number.isInteger(idx) ? idx : null;
    };

    const out = new Array(Array.isArray(objectRows) ? objectRows.length : 0).fill(null);
    const series = Array.isArray(response?.series) ? response.series : [];
    for (const row of series) {
      const idx = parseIndex(row?.label);
      if (idx === null || idx < 0 || idx >= out.length) continue;
      const xUm = Number(row?.chiefPointUm?.xUm);
      const yUm = Number(row?.chiefPointUm?.yUm);
      if (!Number.isFinite(xUm) || !Number.isFinite(yUm)) continue;
      out[idx] = { x: xUm / 1000.0, y: yUm / 1000.0 };
    }

    return out;
  } catch (_) {
    return null;
  }
}

/**
 * Calculate distortion data for a list of field angles (degrees, Y-direction) or object heights (mm).
 * @param {Array} opticalSystemRows - optical system definition rows.
 * @param {number[]} fieldSamples - array of field angles (deg) OR heights (mm)
 * @param {number} wavelength - wavelength (μm) for chief ray & paraxial calculation (default primary 0.5876 μm).
 * @param {Object} options - { heightMode?: boolean, objectDistance?: number }
 * @returns {Object} { fieldValues, idealHeights, realHeights, distortion, distortionPercent, meta }
 */
export async function calculateDistortionData(opticalSystemRows, fieldSamples, wavelength = 0.5876, options = {}) {
  const { heightMode = false } = options;
  const requireRustWasm = options?.requireRustWasm !== false;
  const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
    ? options.onProgress
    : null;
  if (!opticalSystemRows || !Array.isArray(opticalSystemRows)) {
    console.error('❌ calculateDistortionData: opticalSystemRows invalid');
    return null;
  }
  if (!fieldSamples || fieldSamples.length === 0) {
    console.error('❌ calculateDistortionData: field values empty');
    return null;
  }

  const pickImageSurfaceIndex = () => {
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return 0;
    let imageIdx = -1;
    for (let i = 0; i < opticalSystemRows.length; i++) {
      const row = opticalSystemRows[i] || {};
      const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();
      if (objectType === 'image') imageIdx = i;
    }
    return imageIdx >= 0 ? imageIdx : Math.max(0, opticalSystemRows.length - 1);
  };

  const imageSurfaceIndex = pickImageSurfaceIndex();

  const calcChiefImageHeight = (sample) => {
    const fieldSetting = heightMode
      ? {
          position: 'height',
          fieldType: 'height',
          xHeight: 0,
          yHeight: Number(sample),
          x: 0,
          y: Number(sample),
          displayName: `h=${Number(sample).toFixed(6)}mm`
        }
      : {
          position: 'angle',
          fieldType: 'angle',
          xFieldAngle: 0,
          yFieldAngle: Number(sample),
          xHeightAngle: 0,
          yHeightAngle: Number(sample),
          x: 0,
          y: Number(sample),
          displayName: `θ=${Number(sample).toFixed(6)}deg`
        };

    const chief = calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelength, 'unified', {
      targetSurfaceIndex: imageSurfaceIndex,
      chiefRayDefinition: 'stop-center',
      requireRustWasm,
    });

    const segs = Array.isArray(chief?.segments) ? chief.segments : [];
    if (!segs.length) return null;
    const idx = Math.max(0, Math.min(imageSurfaceIndex, segs.length - 1));
    const p = segs[idx] || segs[segs.length - 1] || null;
    const y = Number(p?.y);
    return Number.isFinite(y) ? Math.abs(y) : null;
  };

  try {
    const runtime = await import('../../src/desktop/runtime.ts');
    const useNative = runtime?.isTauriRuntime && runtime.isTauriRuntime();

    if (useNative) {
      const { runNativeDistortion } = await import('../../src/desktop/ipc/client.ts');
      try { onProgress?.({ percent: 0, message: 'Running native distortion...' }); } catch (_) {}
      const response = await runNativeDistortion({
        opticalSystemRows,
        fieldSamples,
        heightMode,
        wavelength,
      });

      return {
        fieldValues: Array.isArray(response?.fieldValues) ? response.fieldValues : fieldSamples,
        idealHeights: Array.isArray(response?.idealHeights) ? response.idealHeights : [],
        realHeights: Array.isArray(response?.realHeights) ? response.realHeights : [],
        distortion: Array.isArray(response?.distortion) ? response.distortion : [],
        distortionPercent: Array.isArray(response?.distortionPercent) ? response.distortionPercent : [],
        meta: response?.meta || {}
      };
    }

    try { onProgress?.({ percent: 0, message: 'Running Web distortion...' }); } catch (_) {}

    const fieldValues = fieldSamples
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));
    if (!fieldValues.length) return null;

    const paraxial = calculateParaxialData(opticalSystemRows, wavelength);
    const focalLength = Number(paraxial?.focalLength);
    const imageDistance = Number(paraxial?.imageDistance);
    const objectDistanceGuess = Math.abs(Number(opticalSystemRows?.[0]?.thickness));
    const magnification = (Number.isFinite(imageDistance) && Number.isFinite(objectDistanceGuess) && objectDistanceGuess > 1e-12)
      ? (imageDistance / objectDistanceGuess)
      : -1;

    const idealHeights = fieldValues.map((fv) => {
      if (heightMode) {
        return magnification * fv;
      }
      const thetaRad = fv * Math.PI / 180;
      if (Number.isFinite(focalLength)) return focalLength * Math.tan(thetaRad);
      return Math.tan(thetaRad);
    });

    const realHeights = await withWebRustWasmTraceOverride(async () => {
      const heights = [];
      for (let i = 0; i < fieldValues.length; i++) {
        const progress = 5 + (85 * i) / Math.max(1, fieldValues.length);
        try { onProgress?.({ percent: progress, message: `Tracing field ${i + 1}/${fieldValues.length} (Rust/WASM)...` }); } catch (_) {}
        heights.push(calcChiefImageHeight(fieldValues[i]));
      }
      return heights;
    }, requireRustWasm) as Array<number | null>;

    const distortion = realHeights.map((h, i) => {
      const ideal = Number(idealHeights[i]);
      if (!Number.isFinite(ideal) || Math.abs(ideal) < 1e-15 || !Number.isFinite(h)) return null;
      return h - ideal;
    });
    const distortionPercent = distortion.map((d, i) => {
      const ideal = Number(idealHeights[i]);
      if (!Number.isFinite(ideal) || Math.abs(ideal) < 1e-15 || !Number.isFinite(d)) return null;
      return (d / ideal) * 100;
    });

    try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
    return {
      fieldValues,
      idealHeights,
      realHeights,
      distortion,
      distortionPercent,
      meta: {
        backend: 'web-rust-wasm',
        imageSurfaceIndex,
        wavelength,
        heightMode,
        requireRustWasm,
      }
    };
  } catch (error) {
    console.error('❌ calculateDistortionData failed:', error);
    return null;
  }
}

/**
 * Calculate grid distortion data for a rectangular grid of field angles.
 * @param {Array} opticalSystemRows - optical system definition rows.
 * @param {number} gridSize - number of grid lines (e.g., 20 means 20×20 grid).
 * @param {number} wavelength - wavelength (μm) for chief ray tracing.
 * @returns {Object} { idealGrid, realGrid, gridSize, maxFieldAngle, meta }
 */
export async function calculateGridDistortion(opticalSystemRows, gridSize = 20, wavelength = 0.5876, options = {}) {
  const requireRustWasm = options?.requireRustWasm !== false;
  const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
    ? options.onProgress
    : null;
  if (!opticalSystemRows || !Array.isArray(opticalSystemRows)) {
    console.error('❌ calculateGridDistortion: opticalSystemRows invalid');
    return null;
  }

  const pickImageSurfaceIndex = () => {
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return 0;
    let imageIdx = -1;
    for (let i = 0; i < opticalSystemRows.length; i++) {
      const row = opticalSystemRows[i] || {};
      const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();
      if (objectType === 'image') imageIdx = i;
    }
    return imageIdx >= 0 ? imageIdx : Math.max(0, opticalSystemRows.length - 1);
  };

  const imageSurfaceIndex = pickImageSurfaceIndex();

  const calcChiefPoint = (xFieldAngle, yFieldAngle) => {
    const chief = calculateChiefRayNewton(opticalSystemRows, {
      position: 'angle',
      fieldType: 'angle',
      xFieldAngle,
      yFieldAngle,
      xHeightAngle: xFieldAngle,
      yHeightAngle: yFieldAngle,
      x: xFieldAngle,
      y: yFieldAngle,
      displayName: `Field(${xFieldAngle.toFixed(6)},${yFieldAngle.toFixed(6)})`
    }, wavelength, 'unified', {
      targetSurfaceIndex: imageSurfaceIndex,
      chiefRayDefinition: 'stop-center'
      , requireRustWasm
    });

    const segs = Array.isArray(chief?.segments) ? chief.segments : [];
    if (!segs.length) return null;
    const idx = Math.max(0, Math.min(imageSurfaceIndex, segs.length - 1));
    const p = segs[idx] || segs[segs.length - 1] || null;
    const x = Number(p?.x);
    const y = Number(p?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  };

  try {
    const runtime = await import('../../src/desktop/runtime.ts');
    const useNative = runtime?.isTauriRuntime && runtime.isTauriRuntime();

    if (useNative) {
      const { runNativeGridDistortion } = await import('../../src/desktop/ipc/client.ts');
      let objectRows = [];
      try { objectRows = getObjectRowsLocal(); } catch (_) { objectRows = []; }
      try { onProgress?.({ percent: 0, message: 'Running native grid distortion...' }); } catch (_) {}
      const response = await runNativeGridDistortion({
        opticalSystemRows,
        objectRows: Array.isArray(objectRows) ? objectRows : [],
        gridSize,
        wavelength,
      });

      return {
        idealGrid: {
          x: Array.isArray(response?.idealX) ? response.idealX : [],
          y: Array.isArray(response?.idealY) ? response.idealY : [],
        },
        realGrid: {
          x: Array.isArray(response?.realX) ? response.realX : [],
          y: Array.isArray(response?.realY) ? response.realY : [],
        },
        gridSize: Number.isFinite(Number(response?.gridSize)) ? Number(response.gridSize) : gridSize,
        maxFieldAngle: Number.isFinite(Number(response?.maxFieldAngle)) ? Number(response.maxFieldAngle) : deriveMaxFieldAngleLocal(),
        meta: response?.meta || {}
      };
    }

    const n = Math.max(2, Math.min(100, Math.round(Number(gridSize) || 20)));
    const maxFieldAngle = deriveMaxFieldAngleLocal();
    const axis = [];
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0 : (i / (n - 1));
      axis.push(-maxFieldAngle + 2 * maxFieldAngle * t);
    }

    const idealX = [];
    const idealY = [];
    const realX = [];
    const realY = [];
    const total = n * n;
    let k = 0;
    await withWebRustWasmTraceOverride(async () => {
      for (let yi = 0; yi < n; yi++) {
        for (let xi = 0; xi < n; xi++) {
          const xfa = axis[xi];
          const yfa = axis[yi];
          idealX.push(xfa);
          idealY.push(yfa);
          const p = calcChiefPoint(xfa, yfa);
          realX.push(Number.isFinite(Number(p?.x)) ? Number(p.x) : null);
          realY.push(Number.isFinite(Number(p?.y)) ? Number(p.y) : null);

          k += 1;
          const progress = 5 + (90 * k) / Math.max(1, total);
          try { onProgress?.({ percent: progress, message: `Tracing grid ${k}/${total} (Rust/WASM)...` }); } catch (_) {}
        }
      }
    }, requireRustWasm);

    try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
    return {
      idealGrid: { x: idealX, y: idealY },
      realGrid: { x: realX, y: realY },
      gridSize: n,
      maxFieldAngle,
      meta: {
        backend: 'web-rust-wasm',
        imageSurfaceIndex,
        wavelength,
        requireRustWasm,
      }
    };
  } catch (error) {
    console.error('❌ calculateGridDistortion failed:', error);
    return null;
  }
}

// Minimal global exposure of calculation only (plotting moved to eva-distortion-plot.js)
if (typeof window !== 'undefined') {
  window['calculateDistortionData'] = calculateDistortionData;
  window['calculateGridDistortion'] = calculateGridDistortion;
}
