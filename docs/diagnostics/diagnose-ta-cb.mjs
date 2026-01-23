
import fs from 'node:fs';

// Minimal browser-like globals needed by eva-transverse-aberration.js under Node.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function') {
  const store = new Map();
  const ls = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => { store.clear(); },
  };
  globalThis.localStorage = ls;
  try { globalThis.window.localStorage = ls; } catch (_) {}
}

// Load Transverse Aberration module
const { calculateTransverseAberration, findStopSurfaceIndex } = await import('../evaluation/aberrations/transverse-aberration.js');

function cloneJson(x) {
  return JSON.parse(JSON.stringify(x));
}

function insertZeroCBBetween(opticalRows, insertAfterSurfaceNumber1Based) {
  const idxAfter = insertAfterSurfaceNumber1Based - 1;
  if (!(idxAfter >= 0 && idxAfter < opticalRows.length)) throw new Error('bad insertAfterSurfaceNumber');
  const cb = {
    id: -999,
    'object type': '',
    surfType: 'Coord Break',
    comment: 'diagnose inserted CB',
    radius: 'INF',
    thickness: 0,
    semidia: '',
    material: '',
    rindex: '',
    abbe: '',
    conic: '',
    coef1: '',
    coef2: '',
    coef3: '',
    coef4: '',
    coef5: '',
    coef6: '',
    coef7: '',
    coef8: '',
    coef9: '',
    coef10: '',
    // Explicit CB schema
    decenterX: 0,
    decenterY: 0,
    decenterZ: 0,
    tiltX: 0,
    tiltY: 0,
    tiltZ: 0,
    order: 1,
  };

  const out = opticalRows.slice();
  out.splice(idxAfter + 1, 0, cb);
  // Re-number ids
  out.forEach((r, i) => {
    try { r.id = i; } catch (_) {}
  });
  return out;
}

function countValidPoints(result) {
    if (!result || !result.meridionalData || result.meridionalData.length === 0) return 0;
    // Count successful rays in the first field (assuming 1 field for diagnose)
    return result.meridionalData[0].points.filter(p => p.isFullSuccess).length;
}

function runOneTA(label, opticalRows, objectRow, surfaceNumber) {
    console.log(`\n--- ${label} ---`);
    const stopIdx = findStopSurfaceIndex(opticalRows);
    console.log(`Stop Surface Index: ${stopIdx}, Target Surface Number (1-based): ${surfaceNumber}`);
    
    // Dump all CB rows to inspect their properties
    const cbRows = opticalRows.filter((r, i) => {
        const st = String(r?.surfType ?? '').toLowerCase();
        const isCB = st.includes('coord break') || st === 'cb' || st === 'coordbreak';
        if (isCB) {
            console.log(`  CB Row at index ${i}:`, {
                surfType: r.surfType,
                semidia: r.semidia,
                material: r.material,
                thickness: r.thickness,
                decenterX: r.decenterX,
                decenterY: r.decenterY,
                decenterZ: r.decenterZ,
                tiltX: r.tiltX,
                tiltY: r.tiltY,
                tiltZ: r.tiltZ,
                order: r.order
            });
        }
        return isCB;
    });
    
    try {
        // Prepare field setting from objectRow
        const fieldSetting = {
             displayName: 'Diagnose Field',
             objectIndex: objectRow.id + 1, // 1-based
             fieldType: objectRow.position || 'Angle', // Default to Angle if missing
             // Map from objectRow properties to what TA expects
             xFieldAngle: objectRow.xHeightAngle || 0,
             yFieldAngle: objectRow.yHeightAngle || 0,
             xHeight: objectRow.xHeight || 0, 
             yHeight: objectRow.yHeight || 0,
             x: objectRow.x || 0,
             y: objectRow.y || 0
        };
        // Normalize for finite/infinite
        if (fieldSetting.fieldType === 'Angle') {
             fieldSetting.x = fieldSetting.xFieldAngle;
             fieldSetting.y = fieldSetting.yFieldAngle;
        } else {
             fieldSetting.x = fieldSetting.xHeight;
             fieldSetting.y = fieldSetting.yHeight;
        }

        const res = calculateTransverseAberration(
            opticalRows,
            Math.max(0, surfaceNumber - 1), // 0-based target index
            [fieldSetting],
            0.5876, // d-line
            51 // ray count
        );
        
        const validCount = countValidPoints(res);
        console.log(`[${label}] Points: ${validCount} / 51`);
        
        if (res.meridionalData && res.meridionalData[0]) {
             const mData = res.meridionalData[0];
             const firstPoint = mData.points[0];
             const lastPoint = mData.points[mData.points.length - 1];
             console.log(`  Pupil Range: ${firstPoint ? firstPoint.pupilCoordinate.toFixed(3) : 'N/A'} ~ ${lastPoint ? lastPoint.pupilCoordinate.toFixed(3) : 'N/A'}`);
             console.log(`  Max Aberration: ${Math.max(...mData.points.map(p => Math.abs(p.transverseAberration))).toFixed(4)} mm`);
        } else {
             console.log(`  No meridional data returned.`);
        }
        
        return { ok: true, res };
    } catch (e) {
        console.error(`[${label}] FAIL:`, e);
        return { ok: false, err: e };
    }
}


const cfg = JSON.parse(fs.readFileSync('defaults/default-load.json', 'utf8'));
const objectRows = cfg.object;
const opticalRows0 = cfg.opticalSystem;

const imgIdx = opticalRows0.findIndex(r => String(r?.['object type'] ?? r?.object ?? '') === 'Image');
if (imgIdx < 0) throw new Error('Image surface not found');
// Note: TA function expects 0-based index in some places, but UI passes 1-based to some.
// calculateTransverseAberration takes 0-based targetSurfaceIndex.
// runOneTA wrapper handles conversion if we pass 1-based surfaceNumber like Spot Diagram.
const surfaceNumber = imgIdx + 1; 

// Pick an object (Evaluated object)
const offAxisObj = objectRows.find(o => Number(o?.id) === 2) || objectRows[0];

console.log('Testing Transverse Aberration with:', { surfaceCount: opticalRows0.length, targetSurface: surfaceNumber });

// Baseline
runOneTA('Baseline (No CB)', cloneJson(opticalRows0), cloneJson(offAxisObj), surfaceNumber);

// Insert CB
const opticalRowsCB = insertZeroCBBetween(cloneJson(opticalRows0), 12);
// Note: Inserting CB increases surface count, so Image index shifts by +1
const surfaceNumberCB = surfaceNumber + 1;
runOneTA('With Zero CB', opticalRowsCB, cloneJson(offAxisObj), surfaceNumberCB);
