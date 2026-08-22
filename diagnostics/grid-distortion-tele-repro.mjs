import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.self = new EventTarget();

const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
const { runNativeGridDistortion } = await import('../src/desktop/ipc/client.ts');
const { warpImageWithDistortion } = await import('../src/app/image-simulation-model.ts');
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
const sensorResult = await runNativeGridDistortion({
  opticalSystemRows: tele.opticalSystem,
  sourceRows: input.source,
  objectRows: tele.object,
  gridSize,
  wavelength: 0.5875618,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
});
const sensorPreviewResult = await runNativeGridDistortion({
  opticalSystemRows: tele.opticalSystem,
  sourceRows: input.source,
  objectRows: tele.object,
  gridSize: 7,
  wavelength: 0.5875618,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
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
assert.equal(sensorResult.meta.sensorOverrideUsed, true);
assert.equal(sensorResult.meta.sensorWidthMm, 36);
assert.equal(sensorResult.meta.sensorHeightMm, 24);
assert.ok(Math.abs(sensorResult.meta.fieldMaxX - 18) < 1e-12, 'sensor half width must drive ImageHeight X');
assert.ok(Math.abs(sensorResult.meta.fieldMaxY - 12) < 1e-12, 'sensor half height must drive ImageHeight Y');
assert.ok(Math.abs(Math.min(...sensorResult.idealX) + 18) < 1e-12, 'sensor grid X minimum');
assert.ok(Math.abs(Math.max(...sensorResult.idealX) - 18) < 1e-12, 'sensor grid X maximum');
assert.ok(Math.abs(Math.min(...sensorResult.idealY) + 12) < 1e-12, 'sensor grid Y minimum');
assert.ok(Math.abs(Math.max(...sensorResult.idealY) - 12) < 1e-12, 'sensor grid Y maximum');

const sensorMissingIndices = sensorResult.realX
  .map((value, index) => (value === null || sensorResult.realY[index] === null ? index : -1))
  .filter((index) => index >= 0);
assert.deepEqual(sensorMissingIndices, [0, gridSize - 1, pointCount - gridSize, pointCount - 1]);

const estimateMissingDisplacement = (map, index) => {
  const size = map.gridSize;
  const row = Math.floor(index / size);
  const column = index % size;
  let sumWeights = 0;
  let sumX = 0;
  let sumY = 0;
  for (let candidate = 0; candidate < map.realX.length; candidate += 1) {
    const realXValue = map.realX[candidate];
    const realYValue = map.realY[candidate];
    const realX = typeof realXValue === 'number' ? realXValue : Number.NaN;
    const realY = typeof realYValue === 'number' ? realYValue : Number.NaN;
    if (!(Number.isFinite(realX) && Number.isFinite(realY))) continue;
    const candidateRow = Math.floor(candidate / size);
    const candidateColumn = candidate % size;
    const distance2 = (candidateRow - row) ** 2 + (candidateColumn - column) ** 2;
    const weight = 1 / Math.max(0.25, distance2);
    sumWeights += weight;
    sumX += (realX - map.idealX[candidate]) * weight;
    sumY += (realY - map.idealY[candidate]) * weight;
  }
  return {
    dx: sumX / sumWeights,
    dy: sumY / sumWeights,
    magnitude: Math.hypot(sumX / sumWeights, sumY / sumWeights),
  };
};
const previewCornerDisplacement = estimateMissingDisplacement(sensorPreviewResult, 0);
const whitePreview = {
  width: 256,
  height: 256,
  rgba: new Uint8ClampedArray(256 * 256 * 4).fill(255),
};
const warpedPreview = warpImageWithDistortion(whitePreview, sensorPreviewResult, {
  minXmm: -18,
  maxXmm: 18,
  minYmm: -12,
  maxYmm: 12,
  widthMm: 36,
  heightMm: 24,
});
const transparentPreviewPixels = Array.from({ length: 256 * 256 }, (_, index) => warpedPreview.rgba[index * 4 + 3])
  .filter((alpha) => alpha === 0).length;
let darkPreviewPixels = 0;
for (let index = 0; index < 256 * 256; index += 1) {
  const offset = index * 4;
  if (warpedPreview.rgba[offset] < 32 && warpedPreview.rgba[offset + 1] < 32 && warpedPreview.rgba[offset + 2] < 32) {
    darkPreviewPixels += 1;
  }
}
assert.equal(darkPreviewPixels, 0, '36x24 preview must not add dark corners');
assert.ok(previewCornerDisplacement.magnitude < 1,
  'missing full-frame corners must use a local-sized extrapolated displacement');
assert.equal(transparentPreviewPixels, 0, '36x24 preview must not leave transparent corners');

console.log(JSON.stringify({
  ok: true,
  backend: result.backend,
  points: pointCount,
  missingIndices,
  meta: result.meta,
  sensor: {
    widthMm: sensorResult.meta.sensorWidthMm,
    heightMm: sensorResult.meta.sensorHeightMm,
    fieldMax: [sensorResult.meta.fieldMaxX, sensorResult.meta.fieldMaxY],
    missingIndices: sensorMissingIndices,
    previewMissingFields: sensorPreviewResult.meta.missingFieldFallbackCount,
    transparentPreviewPixels,
    darkPreviewPixels,
    previewCornerDisplacement,
  },
}, null, 2));
