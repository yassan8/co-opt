
import fs from 'node:fs';

// Minimal browser-like globals needed by eva-longitudinal-aberration.js under Node.
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

// Load Longitudinal Aberration module
const { calculateLongitudinalAberration } = await import('./evaluation/aberrations/longitudinal-aberration.js');

function cloneJson(x) {
  return JSON.parse(JSON.stringify(x));
}

function insertCBBetween(opticalRows, insertAfterSurfaceNumber1Based, decenterY = 0) {
  const idxAfter = insertAfterSurfaceNumber1Based - 1;
  if (!(idxAfter >= 0 && idxAfter < opticalRows.length)) throw new Error('bad insertAfterSurfaceNumber');
  const cb = {
    id: -999,
    'object type': '',
    surfType: 'Coord Break',
    comment: `diagnose inserted CB with decenterY=${decenterY}`,
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
    decenterY: decenterY,
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

function runOneSA(label, opticalRows, objectRow, surfaceIndex) {
    console.log(`\n--- ${label} ---`);
    
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
    console.log(`  Number of CB surfaces: ${cbRows.length}`);

    const wavelengths = [0.5876]; // d-line
    const rayCount = 51;

    try {
        const result = calculateLongitudinalAberration(
            opticalRows,
            surfaceIndex - 1, // 0-based index
            wavelengths,
            rayCount,
            null // options
        );
        const validCount = countValidPoints(result);
        const totalCount = rayCount;
        console.log(`  ✅ Result: ${validCount} valid points / ${totalCount} samples`);
        
        // Show first few points for inspection
        if (result && result.meridionalData && result.meridionalData[0]) {
            const pts = result.meridionalData[0].points.slice(0, 5);
            console.log(`  First 5 points:`, pts.map(p => ({
                pupilCoord: p.pupilCoord?.toFixed(3),
                longitudinalAberration: p.longitudinalAberration?.toFixed(6),
                success: p.isFullSuccess
            })));
        }
        
        return result;
    } catch (err) {
        console.error(`  ❌ Error: ${err.message}`);
        console.error(err.stack);
        return null;
    }
}

// --- Test Systems ---

// Infinite conjugate system (more suitable for Spherical Aberration testing)
const infiniteSystem = [
  {
    id: 0,
    'object type': 'object',
    surfType: '',
    comment: 'Object',
    radius: 'INF',
    thickness: 'INF', // Infinite conjugate
    semidia: '',
    material: '',
    rindex: '',
    abbe: '',
  },
  {
    id: 1,
    'object type': 'stop',
    surfType: 'standard',
    comment: 'Lens (Stop)',
    radius: 50,
    thickness: 5,
    semidia: 10,
    material: 'N-BK7',
    rindex: 1.5168,
    abbe: 64.17,
    conic: 0,
  },
  {
    id: 2,
    'object type': '',
    surfType: 'standard',
    comment: 'Lens Back',
    radius: -50,
    thickness: 45,
    semidia: 10,
    material: '',
    rindex: '',
    abbe: '',
    conic: 0,
  },
  {
    id: 3,
    'object type': '',
    surfType: 'standard',
    comment: 'Image',
    radius: 'INF',
    thickness: 0,
    semidia: 5,
    material: '',
    rindex: '',
    abbe: '',
  },
];

const objectRow = infiniteSystem[0];

console.log('========================================');
console.log('Spherical Aberration CB Surface Diagnostic');
console.log('========================================');

// Test 1: Baseline (no CB)
const baseline = cloneJson(infiniteSystem);
runOneSA('Baseline (no CB)', baseline, objectRow, 4); // surface index 3 (0-based)

// Test 2: CB with decenter Y = 0 (inserted after surface 1)
const withCB_zero = insertCBBetween(cloneJson(infiniteSystem), 2, 0);
runOneSA('With CB (decenterY=0) after surface 2', withCB_zero, objectRow, 5); // surface index 4 (0-based)

// Test 3: CB with small decenter Y = 0.1
const withCB_small = insertCBBetween(cloneJson(infiniteSystem), 2, 0.1);
runOneSA('With CB (decenterY=0.1) after surface 2', withCB_small, objectRow, 5);

// Test 4: CB with larger decenter Y = 1.0
const withCB_large = insertCBBetween(cloneJson(infiniteSystem), 2, 1.0);
runOneSA('With CB (decenterY=1.0) after surface 2', withCB_large, objectRow, 5);

console.log('\n========================================');
console.log('✅ Diagnostic complete');
console.log('========================================\n');
