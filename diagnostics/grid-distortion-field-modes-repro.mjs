import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
globalThis.self = new EventTarget();

// Initialize while the runtime is still recognizably Node, then add the small
// browser globals needed by the shared renderer helpers imported by the client.
const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
const { runNativeGridDistortion } = await import('../src/desktop/ipc/client.ts');
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const cases = [
  {
    file: 'default-load.json',
    expectedMode: 'imageheight',
  },
  {
    file: 'US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json',
    expectedMode: 'angle',
  },
];

const gridSize = 9;
const summaries = [];
for (const testCase of cases) {
  const inputPath = path.join(root, 'Examples', testCase.file);
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = await runNativeGridDistortion({
    opticalSystemRows: input.opticalSystem,
    sourceRows: input.source,
    objectRows: input.object,
    gridSize,
    wavelength: 0.5875618,
  });

  const pointCount = gridSize * gridSize;
  assert.equal(result.meta.gridFieldMode, testCase.expectedMode, `${testCase.file}: field mode`);
  assert.equal(result.realX.length, pointCount, `${testCase.file}: X point count`);
  assert.equal(result.realY.length, pointCount, `${testCase.file}: Y point count`);
  assert.equal(result.meta.missingFieldFallbackCount, 0, `${testCase.file}: missing fields`);
  assert.equal(result.meta.radialWasmChiefRayCount, pointCount, `${testCase.file}: radial chief-ray coverage`);
  result.realX.forEach((value, index) => assert.ok(Number.isFinite(value), `${testCase.file}: invalid X at ${index}`));
  result.realY.forEach((value, index) => assert.ok(Number.isFinite(value), `${testCase.file}: invalid Y at ${index}`));

  let maxSymmetryErrorMm = 0;
  for (let index = 0; index < pointCount; index += 1) {
    const opposite = pointCount - 1 - index;
    maxSymmetryErrorMm = Math.max(
      maxSymmetryErrorMm,
      Math.abs(result.realX[index] + result.realX[opposite]),
      Math.abs(result.realY[index] + result.realY[opposite]),
    );
  }
  assert.ok(maxSymmetryErrorMm < 1e-8, `${testCase.file}: broken central symmetry`);

  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 1; x < gridSize; x += 1) {
      const previous = y * gridSize + x - 1;
      const current = y * gridSize + x;
      assert.ok(result.realX[current] > result.realX[previous], `${testCase.file}: non-monotonic row ${y}`);
    }
  }
  for (let x = 0; x < gridSize; x += 1) {
    for (let y = 1; y < gridSize; y += 1) {
      const previous = (y - 1) * gridSize + x;
      const current = y * gridSize + x;
      assert.ok(result.realY[current] > result.realY[previous], `${testCase.file}: non-monotonic column ${x}`);
    }
  }

  summaries.push({
    case: testCase.file,
    mode: result.meta.gridFieldMode,
    points: pointCount,
    maxSymmetryErrorMm,
    radialChiefRays: result.meta.radialWasmChiefRayCount,
    exactFallbackChiefRays: result.meta.exactWasmChiefRayCount,
    spotFallbackChiefRays: result.meta.spotFallbackChiefRayCount,
  });
}

console.log(JSON.stringify({ ok: true, summaries }, null, 2));
