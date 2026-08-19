import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.self = new EventTarget();

const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
const { runNativeGridDistortion } = await import('../src/desktop/ipc/client.ts');
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const input = JSON.parse(fs.readFileSync(new URL('../Examples/default-load.json', import.meta.url), 'utf8'));
const tele = input.configurations.configurations.find((configuration) => configuration.name === 'Tele');
assert.ok(tele, 'Tele configuration is missing');

const gridSize = 16;
const result = await runNativeGridDistortion({
  opticalSystemRows: tele.opticalSystem,
  sourceRows: input.source,
  objectRows: tele.object,
  gridSize,
  wavelength: 0.5875618,
});

const pointCount = gridSize * gridSize;
assert.equal(result.meta.gridFieldMode, 'imageheight');
assert.equal(result.realX.length, pointCount);
assert.equal(result.realY.length, pointCount);
assert.ok(Math.abs(result.meta.objectMaxHeight - 21.6) < 1e-12, 'Tele image height was not read from the object table');
assert.ok(result.meta.directChiefRayCount >= pointCount - 4, 'more than the four extreme corners were lost');
assert.ok(result.meta.missingFieldFallbackCount <= 4, 'unexpected missing Grid Distortion fields');
assert.ok(result.meta.spotFallbackChiefRayError, 'the rejected Spot fallback should be diagnosed');

const missingIndices = [];
for (let index = 0; index < pointCount; index += 1) {
  const x = result.realX[index];
  const y = result.realY[index];
  if (x === null || y === null) {
    missingIndices.push(index);
  } else {
    assert.ok(Number.isFinite(x), `invalid X at ${index}`);
    assert.ok(Number.isFinite(y), `invalid Y at ${index}`);
  }
}
assert.deepEqual(missingIndices, [0, gridSize - 1, pointCount - gridSize, pointCount - 1]);

console.log(JSON.stringify({
  ok: true,
  backend: result.backend,
  points: pointCount,
  missingIndices,
  meta: result.meta,
}, null, 2));
