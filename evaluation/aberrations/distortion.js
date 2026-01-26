// eva-distortion.js
// Distortion (歪曲収差) core calculation module
// Definition (angle): D(θ) = (h_real' - h_ideal') / h_ideal'
// h_ideal' = f' * tan(θ)  (infinite object assumption) or approx for small θ: f' * θ(rad)
// Height mode: use object height h_obj and paraxial倍率 m ≈ imageDistance / objectDistance (fallback: -1) to set h_ideal' = m * h_obj
// This module sweeps either field angles (deg) or object heights (mm, Y) and traces the chief ray.
// Returns both absolute heights and distortion ratio (percentage).

import { calculateParaxialData } from '../../raytracing/core/ray-paraxial.js';
import { calculateChiefRayNewton } from './transverse-aberration.js';
import { calculateSurfaceOrigins } from '../../raytracing/core/ray-tracing.js';

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
  const fPrime = paraxial?.focalLength; // 有効焦点距離
  if (!fPrime || !isFinite(fPrime)) {
    console.error('❌ calculateDistortionData: focal length unavailable');
    return null;
  }

  const finite = isFiniteSystem(opticalSystemRows);

  const idealHeights = [];
  const realHeights = [];
  const distortion = [];
  const distortionPercent = [];
  const chiefRayDetails = [];

  // Object distance (for magnification in height mode)
  const objectDistance = objDistOverride ?? (opticalSystemRows[0]?.thickness || null);
  const imageDistance = paraxial?.imageDistance ?? paraxial?.backFocalLength ?? fPrime;
  const magnification = (heightMode && objectDistance && imageDistance)
    ? -(imageDistance / objectDistance)
    : -1; // fallback magnification

  for (let sampleIndex = 0; sampleIndex < fieldSamples.length; sampleIndex++) {
    const sample = fieldSamples[sampleIndex];
    let hIdeal;
    let thetaDeg = null;
    let fieldSetting;

    if (heightMode) {
      const hObj = sample;
      // For afocal/infinite systems, use object height as ideal to avoid meaningless paraxial magnification.
      hIdeal = finite ? (magnification * hObj) : hObj;
      thetaDeg = null;
      fieldSetting = { fieldType: 'Height', xHeight: 0, yHeight: hObj, displayName: `h=${hObj}mm` };
    } else {
      thetaDeg = sample;
      const thetaRad = thetaDeg * Math.PI / 180.0;
      hIdeal = fPrime * Math.tan(thetaRad);
      fieldSetting = { fieldType: 'Angle', x: 0, y: thetaDeg, displayName: `θ=${thetaDeg}°` };
    }

    idealHeights.push(hIdeal);

    // For finite system with angle input, still approximate object height from angle
    if (!heightMode && finite) {
      const s = opticalSystemRows[0]?.thickness || 0;
      const thetaRad = sample * Math.PI / 180.0;
      const hObject = s * Math.tan(thetaRad);
      fieldSetting = { fieldType: 'Height', xHeight: 0, yHeight: hObject, displayName: `θ=${sample}°` };
    }

    let hReal = null;
    try {
      const chief = calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelength, 'unified', { rayCount: 11 });
      if (chief?.success && chief?.ray?.path?.length) {
        const lastPointGlobal = chief.ray.path[chief.ray.path.length - 1];
        
        // Transform to local coordinates if CT/rotation is present
        let lastPoint = lastPointGlobal;
        if (imageSurfaceInfo?.rotationMatrix) {
          const origin = imageSurfaceInfo.origin || { x: 0, y: 0, z: 0 };
          const relative = {
            x: lastPointGlobal.x - origin.x,
            y: lastPointGlobal.y - origin.y,
            z: lastPointGlobal.z - origin.z
          };
          lastPoint = applyRotationMatrixToVector(imageSurfaceInfo.rotationMatrix, relative);
        }
        
        // Apply mirror sign to coordinates
        const localY = lastPoint.y * mirrorSign;
        
        // Use Y coordinate for height (since we varied y angle); fallback radial if x present.
        hReal = Math.abs(localY);
        // Optionally radial: const r = Math.sqrt(lastPoint.x*lastPoint.x + localY*localY);
        chiefRayDetails.push({ sample, thetaDeg, lastPoint: { ...lastPoint, y: localY } });
      } else {
        chiefRayDetails.push({ sample, thetaDeg, error: chief?.finalError || 'chief ray failure' });
      }
    } catch (e) {
        console.warn('⚠️ chief ray tracing failed for sample=', sample, e);
        chiefRayDetails.push({ sample, thetaDeg, error: e.message });
    }

    realHeights.push(hReal);

    if (hIdeal === 0) { // center
      distortion.push(0);
      distortionPercent.push(0);
    } else if (hReal == null) {
      distortion.push(null);
      distortionPercent.push(null);
    } else {
      const d = (hReal - hIdeal) / hIdeal;
      distortion.push(d);
      distortionPercent.push(d * 100.0);
    }

    if (onProgress) {
      try {
        const percent = ((sampleIndex + 1) / fieldSamples.length) * 100;
        const label = heightMode ? `h=${sample}` : `θ=${sample}°`;
        onProgress({ percent, message: `Distortion sample ${sampleIndex + 1}/${fieldSamples.length} (${label})` });
      } catch (_) {}
    }

    await maybeYield();
  }

  return {
    fieldValues: fieldSamples,
    idealHeights,
    realHeights,
    distortion,
    distortionPercent,
    meta: {
      wavelength,
      focalLength: fPrime,
      finiteSystem: finite,
      heightMode,
      magnification,
      chiefRayDetails
    }
  };
}

/**
 * Calculate grid distortion data for a rectangular grid of field angles.
 * @param {Array} opticalSystemRows - optical system definition rows.
 * @param {number} gridSize - number of grid lines (e.g., 20 means 20×20 grid).
 * @param {number} wavelength - wavelength (μm) for chief ray tracing.
 * @returns {Object} { idealGrid, realGrid, gridSize, maxFieldAngle, meta }
 */
export async function calculateGridDistortion(opticalSystemRows, gridSize = 20, wavelength = 0.5876, options = {}) {
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
    console.error('❌ calculateGridDistortion: opticalSystemRows invalid');
    return null;
  }

  // Detect mirrors and calculate sign flip for odd mirror count
  const mirrorCount = Array.isArray(opticalSystemRows)
    ? opticalSystemRows.filter(isMirrorRow).length
    : 0;
  const mirrorSign = (mirrorCount % 2 === 1) ? -1 : 1;
  console.log(`🔍 Grid Distortion: Detected ${mirrorCount} mirror(s), mirrorSign=${mirrorSign}`);

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
  const fPrime = paraxial?.focalLength;
  if (!fPrime || !isFinite(fPrime)) {
    console.error('❌ calculateGridDistortion: focal length unavailable');
    return null;
  }

  const finite = isFiniteSystem(opticalSystemRows);

  // Determine max field angle from Object table
  const maxFieldAngle = deriveMaxFieldAngleLocal();
  console.log(`📐 Grid distortion: max field angle = ${maxFieldAngle}° (auto-detected from Object table)`);

  // Create grid points in angle space
  const idealGrid = { x: [], y: [] }; // ideal image positions
  const realGrid = { x: [], y: [] };  // real traced image positions

  // Generate grid lines (from -maxFieldAngle to +maxFieldAngle)
  const step = (2 * maxFieldAngle) / (gridSize - 1);

  const totalPoints = gridSize * gridSize;
  let completedPoints = 0;

  for (let i = 0; i < gridSize; i++) {
    const thetaY = -maxFieldAngle + i * step;
    const thetaYRad = thetaY * Math.PI / 180;

    for (let j = 0; j < gridSize; j++) {
      const thetaX = -maxFieldAngle + j * step;
      const thetaXRad = thetaX * Math.PI / 180;

      // Ideal image position (paraxial)
      const hIdealX = fPrime * Math.tan(thetaXRad);
      const hIdealY = fPrime * Math.tan(thetaYRad);
      idealGrid.x.push(hIdealX);
      idealGrid.y.push(hIdealY);

      // Trace chief ray to get real image position
      let fieldSetting;
      if (finite) {
        const s = opticalSystemRows[0]?.thickness || 0;
        const hObjectX = s * Math.tan(thetaXRad);
        const hObjectY = s * Math.tan(thetaYRad);
        fieldSetting = { 
          fieldType: 'Height', 
          xHeight: hObjectX, 
          yHeight: hObjectY, 
          displayName: `(${thetaX.toFixed(1)}°, ${thetaY.toFixed(1)}°)` 
        };
      } else {
        fieldSetting = { 
          fieldType: 'Angle', 
          x: thetaX, 
          y: thetaY, 
          displayName: `(${thetaX.toFixed(1)}°, ${thetaY.toFixed(1)}°)` 
        };
      }

      let hRealX = null;
      let hRealY = null;
      try {
        const chief = calculateChiefRayNewton(
          opticalSystemRows, 
          fieldSetting, 
          wavelength, 
          'unified', 
          { rayCount: 11 }
        );
        if (chief?.success && chief?.ray?.path?.length) {
          const lastPointGlobal = chief.ray.path[chief.ray.path.length - 1];
          
          // Transform to local coordinates if CT/rotation is present
          let lastPoint = lastPointGlobal;
          if (imageSurfaceInfo?.rotationMatrix) {
            const origin = imageSurfaceInfo.origin || { x: 0, y: 0, z: 0 };
            const relative = {
              x: lastPointGlobal.x - origin.x,
              y: lastPointGlobal.y - origin.y,
              z: lastPointGlobal.z - origin.z
            };
            lastPoint = applyRotationMatrixToVector(imageSurfaceInfo.rotationMatrix, relative);
          }
          
          // Apply mirror sign to coordinates
          const localX = lastPoint.x * mirrorSign;
          const localY = lastPoint.y * mirrorSign;
          
          // Validate that the coordinates are finite numbers
          // Also filter out the error sentinel value (-50, -50)
          if (lastPoint && 
              typeof localX === 'number' && isFinite(localX) &&
              typeof localY === 'number' && isFinite(localY) &&
              !(localX === -50 && localY === -50)) {
            hRealX = localX;
            hRealY = localY;
          }
        }
      } catch (e) {
        console.warn(`⚠️ chief ray tracing failed for (${thetaX.toFixed(1)}°, ${thetaY.toFixed(1)}°)`);
      }

      realGrid.x.push(hRealX);
      realGrid.y.push(hRealY);

      completedPoints++;
      if (onProgress) {
        try {
          const percent = (completedPoints / totalPoints) * 100;
          onProgress({ percent, message: `Grid distortion ${completedPoints}/${totalPoints}` });
        } catch (_) {}
      }

      await maybeYield();
    }
  }

  return {
    idealGrid,
    realGrid,
    gridSize,
    maxFieldAngle,
    meta: {
      wavelength,
      focalLength: fPrime,
      finiteSystem: finite
    }
  };
}

// Minimal global exposure of calculation only (plotting moved to eva-distortion-plot.js)
if (typeof window !== 'undefined') {
  window.calculateDistortionData = calculateDistortionData;
  window.calculateGridDistortion = calculateGridDistortion;
}
