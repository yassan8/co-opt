import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.self = new EventTarget();
const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
globalThis.addEventListener = globalThis.self.addEventListener.bind(globalThis.self);
globalThis.removeEventListener = globalThis.self.removeEventListener.bind(globalThis.self);
globalThis.dispatchEvent = globalThis.self.dispatchEvent.bind(globalThis.self);
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };

const { runNativeAstigmatism } = await import('../src/desktop/ipc/client.ts');
const input = JSON.parse(fs.readFileSync(
  new URL('../Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json', import.meta.url),
  'utf8',
));
const pointCount = 11;
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = () => {};
console.warn = () => {};
console.error = () => {};
let result;
try {
  result = await runNativeAstigmatism({
    opticalSystemRows: input.opticalSystem,
    sourceRows: input.source,
    objectRows: input.object,
    surfaceIndex: input.opticalSystem.length - 1,
    pointCount,
    rayCount: 81,
    ringCount: 8,
    pattern: 'annular',
    wavelengthMode: 'primary',
    requireRustWasm: true,
  });
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

assert.ok(result, 'Astigmatism calculation returned no result');
assert.equal(result.fieldMode, 'angle', 'Astigmatism field mode is not Angle');
assert.equal(result.backend, 'web-rust-wasm', 'Astigmatism did not use the Web Rust/WASM backend');
assert.equal(result.data.length, pointCount, 'Astigmatism field sampling is incomplete');
const rows = [...result.data].sort((a, b) => Number(a.fieldAngle) - Number(b.fieldAngle));
for (const [index, row] of rows.entries()) {
  assert.ok(Number.isFinite(Number(row.fieldAngle)), `Astigmatism row ${index} has no field angle`);
  assert.ok(Number.isFinite(Number(row.meridionalDeviation)), `Astigmatism row ${index} has no meridional focus`);
  assert.ok(Number.isFinite(Number(row.sagittalDeviation)), `Astigmatism row ${index} has no sagittal focus`);
  assert.ok(Number.isFinite(Number(row.astigmaticDifference)), `Astigmatism row ${index} has no focus separation`);
}
const fieldSteps = rows.slice(1).map((row, index) => Number(row.fieldAngle) - Number(rows[index].fieldAngle));
assert.ok(fieldSteps.every((step) => step > 0), 'Astigmatism fields are not strictly increasing');
assert.ok(Math.abs(Number(rows[0].fieldAngle)) < 1e-12, 'Astigmatism sampling does not start on axis');
assert.ok(Math.abs(Number(rows.at(-1).fieldAngle) - 46) < 1e-9, 'Astigmatism sampling does not reach Object 3');

const largestAdjacentJump = (key) => Math.max(...rows.slice(1).map((row, index) => (
  Math.abs(Number(row[key]) - Number(rows[index][key]))
)));
originalLog(JSON.stringify({
  ok: true,
  backend: result.backend,
  pointCount: rows.length,
  fieldMinDeg: Number(rows[0].fieldAngle),
  fieldMaxDeg: Number(rows.at(-1).fieldAngle),
  meridionalMinMm: Math.min(...rows.map((row) => Number(row.meridionalDeviation))),
  meridionalMaxMm: Math.max(...rows.map((row) => Number(row.meridionalDeviation))),
  sagittalMinMm: Math.min(...rows.map((row) => Number(row.sagittalDeviation))),
  sagittalMaxMm: Math.max(...rows.map((row) => Number(row.sagittalDeviation))),
  maxMeridionalAdjacentJumpMm: largestAdjacentJump('meridionalDeviation'),
  maxSagittalAdjacentJumpMm: largestAdjacentJump('sagittalDeviation'),
}, null, 2));
