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

/**
 * Calculate distortion data for a list of field angles (degrees, Y-direction) or object heights (mm).
 * @param {Array} opticalSystemRows - optical system definition rows.
 * @param {number[]} fieldSamples - array of field angles (deg) OR heights (mm)
 * @param {number} wavelength - wavelength (μm) for chief ray & paraxial calculation (default primary 0.5876 μm).
 * @param {Object} options - { heightMode?: boolean, objectDistance?: number }
 * @returns {Object} { fieldValues, idealHeights, realHeights, distortion, distortionPercent, meta }
 */
export async function calculateDistortionData(opticalSystemRows, fieldSamples, wavelength = 0.5876, options = {}) {
  const { heightMode = false, objectDistance: objDistOverride } = options;
  const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
    ? options.onProgress
    : null;

  const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
  let lastYield = now();
  const maybeYield = async () => {
    const t = now();
    if (t - lastYield >= 16) {
      await new Promise(r => setTimeout(r, 0));
      lastYield = now();
    }
  };

  if (!opticalSystemRows || !Array.isArray(opticalSystemRows)) {
    console.error('❌ calculateDistortionData: opticalSystemRows invalid');
    return null;
  }
  if (!fieldSamples || fieldSamples.length === 0) {
    console.error('❌ calculateDistortionData: field values empty');
    return null;
  }

  // Detect mirrors and calculate sign flip for odd mirror count
  const mirrorCount = Array.isArray(opticalSystemRows)
    ? opticalSystemRows.filter(isMirrorRow).length
    : 0;
  const mirrorSign = (mirrorCount % 2 === 1) ? -1 : 1;
  console.log(`🔍 Distortion: Detected ${mirrorCount} mirror(s), mirrorSign=${mirrorSign}`);

  // Calculate surface origins (for coordinate transformation support)
  const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);

  // Find image surface index (last non-CT surface)
  let imageSurfaceIndex = opticalSystemRows.length - 1;
  for (let i = opticalSystemRows.length - 1; i >= 0; i--) {
    const row = opticalSystemRows[i];
    const surfType = String(row?.surfType ?? row?.type ?? '').toLowerCase();
    if (surfType === 'image') {
      imageSurfaceIndex = i;
      break;
    }
  }
  const imageSurfaceInfo = surfaceOrigins?.[imageSurfaceIndex] || null;

  const paraxial = calculateParaxialData(opticalSystemRows, wavelength);
