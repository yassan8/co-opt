import fs from 'node:fs';

// Minimal browser-like globals needed by eva-spot-diagram.js under Node.
// (We only stub what generateSpotDiagram touches in practice.)
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
// localStorage is used by table modules at import-time.
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
if (typeof globalThis.window.rayColorMode === 'undefined') globalThis.window.rayColorMode = 'object';
if (typeof globalThis.window.getRayColorMode !== 'function') globalThis.window.getRayColorMode = () => 'object';

if (typeof globalThis.window.rayEmissionPattern === 'undefined') globalThis.window.rayEmissionPattern = 'annular';
if (typeof globalThis.window.getRayEmissionPattern !== 'function') {
  globalThis.window.getRayEmissionPattern = () => String(globalThis.window.rayEmissionPattern || 'annular');
}
if (typeof globalThis.window.setRayEmissionPattern !== 'function') {
  globalThis.window.setRayEmissionPattern = (p) => {
    globalThis.window.rayEmissionPattern = String(p || 'annular');
  };
}

const { generateSpotDiagram } = await import('./eva-spot-diagram.js');

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
    // Explicit CB schema (so parseCoordBreakParams never falls back to legacy reused columns)
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
  // Re-number ids to match 0..N-1 pattern.
  out.forEach((r, i) => {
    try { r.id = i; } catch (_) {}
  });
  return out;
}

function summarizeFailure(sd) {
  if (!sd || typeof sd !== 'object') return null;
  const o0 = Array.isArray(sd.objects) ? sd.objects[0] : null;
  return {
    surfaceNumber: sd.surfaceNumber,
    totalRays: sd.totalRays,
    totalSuccessfulRays: sd.totalSuccessfulRays,
    topKinds: o0?.topKinds ?? null,
    topSurfaces: o0?.topSurfaces ?? null,
    example: o0?.example ?? null,
    coordBreakSummaries: sd.coordBreakSummaries ?? null,
    retryTried: o0?.retry?.pupilScaleTried ? o0.retry.pupilScaleTried.length : null,
  };
}

function runOne(label, opticalRows, sourceRows, objectRow, surfaceNumber) {
  try {
    globalThis.__cooptLastSpotDiagramFailure = null;
  } catch (_) {}

  try {
    const res = generateSpotDiagram(
      opticalRows,
      sourceRows,
      [objectRow],
      surfaceNumber,
      501,
      10,
      { physicalVignetting: true }
    );
    const obj0 = res?.spotData?.[0];
    console.log(`\n[${label}] OK`);
    console.log({
      successfulRays: obj0?.successfulRays,
      totalRays: obj0?.totalRays,
      successRate: obj0?.successRate,
      pupilScaleUsed: obj0?.pupilScaleUsed,
      aimThroughStopUsed: obj0?.aimThroughStopUsed,
    });
    return { ok: true, res };
  } catch (e) {
    console.log(`\n[${label}] FAIL: ${String(e?.message ?? e)}`);
    const sd = globalThis.__cooptLastSpotDiagramFailure;
    console.log('lastSpotDiagramFailureSummary:', summarizeFailure(sd));

    try {
      const tried = sd?.objects?.[0]?.retry?.pupilScaleTried;
      if (Array.isArray(tried) && tried.length) {
        const pickFields = (t) => ({
          pupilScale: t?.pupilScale,
          aimThroughStop: t?.aimThroughStop,
          allowOriginSolve: t?.allowStopBasedOriginSolveRequested,
          disableAngleOpt: t?.disableAngleObjectPositionOptimizationRequested,
          ok: t?.ok,
          raysGenerated: t?.raysGenerated,
          topKind: t?.topKind,
          topSurface: t?.topSurface,
          example: t?.example,
          emissionOrigin: t?.emissionOrigin,
          stopIndex: t?.stopIndex,
          stopZ: t?.stopZ,
          stopRadius: t?.stopRadius,
        });

        const samples = tried
          .filter(t => t && typeof t === 'object')
          .slice(0, 10)
          .map(pickFields);

        const aimSolveSamples = tried
          .filter(t => t && t.aimThroughStop === true && t.allowStopBasedOriginSolveRequested === true)
          .slice(0, 10)
          .map(pickFields);

        console.log('retry attempt samples (first 10):', samples);
        console.log('retry attempt samples (aimThroughStop + originSolve):', aimSolveSamples);
      }
    } catch (_) {}

    return { ok: false, err: e, failure: sd };
  }
}

const cfg = JSON.parse(fs.readFileSync('defaults/default-load.json', 'utf8'));
const sourceRows = cfg.source;
const objectRows = cfg.object;
const opticalRows0 = cfg.opticalSystem;

const imgIdx = opticalRows0.findIndex(r => String(r?.['object type'] ?? r?.object ?? '') === 'Image');
if (imgIdx < 0) throw new Error('Image surface not found in defaults/default-load.json');
const surfaceNumber = imgIdx + 1;

// Pick the off-axis Angle object (id=2) if present.
const offAxisObj = objectRows.find(o => Number(o?.id) === 2) || objectRows[0];

console.log('surfaceCount', opticalRows0.length, 'imageSurfaceNumber', surfaceNumber);
console.log('object', { id: offAxisObj?.id, position: offAxisObj?.position, xHeightAngle: offAxisObj?.xHeightAngle, yHeightAngle: offAxisObj?.yHeightAngle });

// Baseline
runOne('baseline (no CB)', cloneJson(opticalRows0), cloneJson(sourceRows), cloneJson(offAxisObj), surfaceNumber);

// Insert a zero CB between surfaces 12 and 13 (this matches the historical failure reports around surf 13).
const opticalRowsCB = insertZeroCBBetween(cloneJson(opticalRows0), 12);
runOne('with zero CB after Surf 12', opticalRowsCB, cloneJson(sourceRows), cloneJson(offAxisObj), surfaceNumber);
