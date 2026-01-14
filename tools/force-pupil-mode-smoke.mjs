import { OpticalPathDifferenceCalculator } from '../eva-wavefront.js';

function makeMinimalOpticalSystemRows() {
  // Minimal, non-empty rows array to satisfy constructor invariants.
  // Keep fields permissive; we are only testing forced-mode plumbing.
  return [
    { 'object type': 'object', thickness: 'INF', comment: 'Object' },
    { 'object type': 'surface', semidia: 10, thickness: 0, material: 'air', radius: 100, comment: 'Surf1' },
    { 'object type': 'surface', semidia: 8, thickness: 0, material: 'air', radius: 100, comment: 'Surf2 (stop-ish)' }
  ];
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`[FAIL] ${label}: expected=${expected}, actual=${actual}`);
  }
  console.log(`[OK] ${label}: ${actual}`);
}

const rows = makeMinimalOpticalSystemRows();
const calc = new OpticalPathDifferenceCalculator(rows, 0.5876);

// Default: no forced mode -> stop (cache default)
delete globalThis.__COOPT_FORCE_INFINITE_PUPIL_MODE;
delete globalThis.COOPT_FORCE_INFINITE_PUPIL_MODE;
assertEq(calc._getForcedInfinitePupilMode(), null, 'forced mode is null by default');
assertEq(calc._getInfinitePupilMode({ fieldAngle: { x: 0, y: 0 }, xHeight: 0, yHeight: 0, type: 'angle' }), 'stop', 'default infinite pupil mode is stop');

// Force stop
globalThis.__COOPT_FORCE_INFINITE_PUPIL_MODE = 'stop';
assertEq(calc._getForcedInfinitePupilMode(), 'stop', 'forced mode = stop');
assertEq(calc._getInfinitePupilMode({ fieldAngle: { x: 0, y: 0 }, xHeight: 0, yHeight: 0, type: 'angle' }), 'stop', 'forced stop pins mode');

// Force entrance
globalThis.__COOPT_FORCE_INFINITE_PUPIL_MODE = 'entrance';
assertEq(calc._getForcedInfinitePupilMode(), 'entrance', 'forced mode = entrance');
assertEq(calc._getInfinitePupilMode({ fieldAngle: { x: 0, y: 0 }, xHeight: 0, yHeight: 0, type: 'angle' }), 'entrance', 'forced entrance pins mode');

// Clear force
delete globalThis.__COOPT_FORCE_INFINITE_PUPIL_MODE;
assertEq(calc._getForcedInfinitePupilMode(), null, 'forced mode cleared');
assertEq(calc._getInfinitePupilMode({ fieldAngle: { x: 0, y: 0 }, xHeight: 0, yHeight: 0, type: 'angle' }), 'stop', 'mode returns to default stop');

console.log('DONE');
