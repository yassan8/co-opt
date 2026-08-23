import assert from 'node:assert/strict';
import fs from 'node:fs';

if (typeof globalThis.self === 'undefined') globalThis.self = new EventTarget();
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(String(key)) ?? null,
    setItem: (key, value) => store.set(String(key), String(value)),
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear(),
  };
}
if (typeof globalThis.window.getRayColorMode !== 'function') {
  globalThis.window.getRayColorMode = () => 'object';
}
globalThis.window.rayColorMode = 'object';
globalThis.window.rayEmissionPattern = 'annular';
globalThis.window.getRayEmissionPattern = () => 'annular';
globalThis.window.setRayEmissionPattern = (pattern) => {
  globalThis.window.rayEmissionPattern = String(pattern || 'annular');
};

const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });

const [{ generateSpotDiagram }, { calculateTransverseAberration }] = await Promise.all([
  import('../evaluation/spot-diagram.ts'),
  import('../evaluation/aberrations/transverse-aberration.ts'),
]);

const input = JSON.parse(fs.readFileSync(
  new URL('../Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json', import.meta.url),
  'utf8',
));
const opticalSystem = input.opticalSystem;
const sourceRows = input.source.filter((row) => row.enabled !== false);
const objectRows = input.object.filter((row) => row.enabled !== false);
const imageSurfaceNumber = opticalSystem.length;
const targetSurfaceIndex = imageSurfaceNumber - 1;
const primaryWavelength = Number(
  sourceRows.find((row) => String(row.primary || '').includes('Primary'))?.wavelength
    ?? sourceRows[0]?.wavelength,
);
const fieldSettings = objectRows.map((row, index) => ({
  position: String(row.position || 'Angle'),
  xFieldAngle: Number(row.xHeightAngle ?? row.xAngle ?? row.x ?? 0),
  yFieldAngle: Number(row.yHeightAngle ?? row.yAngle ?? row.y ?? row.angle ?? 0),
  xHeightAngle: Number(row.xHeightAngle ?? row.xAngle ?? row.x ?? 0),
  yHeightAngle: Number(row.yHeightAngle ?? row.yAngle ?? row.y ?? row.angle ?? 0),
  objectIndex: Number(row.id ?? index + 1),
  displayName: `Object ${Number(row.id ?? index + 1)}`,
}));
const traceOptions = {
  useRustWasm: true,
  requireRustWasm: true,
  allowNonStrict: true,
};

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

let spotResult;
let transverseResult;
try {
  spotResult = generateSpotDiagram(
    opticalSystem,
    sourceRows,
    objectRows,
    imageSurfaceNumber,
    81,
    5,
    { physicalVignetting: true, traceOptions },
  );
  transverseResult = calculateTransverseAberration(
    opticalSystem,
    targetSurfaceIndex,
    fieldSettings,
    primaryWavelength,
    51,
    { lightweight: true, pupilSamplingMode: 'entrance', traceOptions },
  );
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

assert.equal(spotResult?.spotData?.length, objectRows.length, 'Spot result omitted a configured field');
const spot = spotResult.spotData.map((entry, index) => {
  const points = Array.isArray(entry.spotPoints) ? entry.spotPoints : [];
  originalLog(`Spot Object ${index + 1}: ${points.length}/${Number(entry.totalRays ?? 0)} successful`);
  assert.ok(points.length > 0, `Spot Object ${index + 1} has no successful rays`);
  assert.ok(
    points.every((point) => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))),
    `Spot Object ${index + 1} contains a non-finite coordinate`,
  );
  const cx = points.reduce((sum, point) => sum + Number(point.x), 0) / points.length;
  const cy = points.reduce((sum, point) => sum + Number(point.y), 0) / points.length;
  const rmsRadiusMm = Math.sqrt(
    points.reduce((sum, point) => sum + (Number(point.x) - cx) ** 2 + (Number(point.y) - cy) ** 2, 0)
      / points.length,
  );
  assert.ok(Number.isFinite(rmsRadiusMm), `Spot Object ${index + 1} RMS is non-finite`);
  return {
    objectId: Number(entry.objectId ?? index + 1),
    fieldDegrees: Number(entry.objectYHeightAngle ?? objectRows[index]?.yHeightAngle ?? 0),
    successfulRays: Number(entry.successfulRays ?? points.length),
    totalRays: Number(entry.totalRays ?? points.length),
    successRate: Number(entry.successRate ?? 0),
    rmsRadiusMm,
  };
});
assert.ok(spot.some((entry) => entry.objectId === 3 && entry.successfulRays > 0), 'Spot Object 3 is missing');

const summarizeFan = (entry, family, index) => {
  const points = Array.isArray(entry?.points) ? entry.points : [];
  assert.ok(points.length >= 3, `${family} Object ${index + 1} has fewer than three samples`);
  assert.ok(
    points.every((point) => Number.isFinite(Number(point.pupilCoordinate))
      && Number.isFinite(Number(point.transverseAberration))),
    `${family} Object ${index + 1} contains a non-finite value`,
  );
  const pupil = points.map((point) => Number(point.pupilCoordinate));
  const aberration = points.map((point) => Number(point.transverseAberration));
  const zeroIndex = pupil.reduce(
    (best, value, pointIndex) => (Math.abs(value) < Math.abs(pupil[best]) ? pointIndex : best),
    0,
  );
  assert.ok(Math.abs(pupil[zeroIndex]) < 1e-8, `${family} Object ${index + 1} has no chief-ray pupil sample`);
  assert.ok(Math.abs(aberration[zeroIndex]) < 1e-8, `${family} Object ${index + 1} chief-ray aberration is not zero`);
  return {
    objectId: Number(entry?.fieldSetting?.objectIndex ?? index + 1),
    fieldDegrees: Number(entry?.fieldSetting?.yFieldAngle ?? 0),
    pointCount: points.length,
    pupilMin: Math.min(...pupil),
    pupilMax: Math.max(...pupil),
    aberrationMinMm: Math.min(...aberration),
    aberrationMaxMm: Math.max(...aberration),
  };
};

assert.equal(transverseResult?.meridionalData?.length, objectRows.length, 'Meridional fan omitted a field');
assert.equal(transverseResult?.sagittalData?.length, objectRows.length, 'Sagittal fan omitted a field');
const meridional = transverseResult.meridionalData.map((entry, index) => summarizeFan(entry, 'Meridional', index));
const sagittal = transverseResult.sagittalData.map((entry, index) => summarizeFan(entry, 'Sagittal', index));
assert.ok(meridional.some((entry) => entry.objectId === 3 && entry.pointCount >= 3), 'Meridional Object 3 is missing');
assert.ok(sagittal.some((entry) => entry.objectId === 3 && entry.pointCount >= 3), 'Sagittal Object 3 is missing');

originalLog(JSON.stringify({
  ok: true,
  lens: 'US3834556 retrofocus 1/3.5',
  imageSurfaceNumber,
  primaryWavelength,
  spot,
  transverse: { meridional, sagittal },
}, null, 2));
