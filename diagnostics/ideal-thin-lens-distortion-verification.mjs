import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.self = new EventTarget();
globalThis.addEventListener = globalThis.self.addEventListener.bind(globalThis.self);
globalThis.removeEventListener = globalThis.self.removeEventListener.bind(globalThis.self);
globalThis.dispatchEvent = globalThis.self.dispatchEvent.bind(globalThis.self);
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });

const { runNativeDistortion, runNativeGridDistortion } = await import('../src/desktop/ipc/client.ts');
const {
  normalizeDistortionMapsToReference,
  normalizeDistortionSeriesLinearReference,
} = await import('../evaluation/aberrations/distortion-normalization.ts');
const {
  calculateImageSimulationDifferencePercent,
  warpImageWithDistortion,
} = await import('../src/app/image-simulation-model.ts');
const input = JSON.parse(fs.readFileSync(
  new URL('../Examples/20260823_bug_02.json', import.meta.url),
  'utf8',
));
const result = await runNativeGridDistortion({
  opticalSystemRows: input.opticalSystem,
  sourceRows: input.source,
  objectRows: input.object,
  gridSize: 5,
  wavelength: 0.5875618,
  sensorWidthMm: 36,
  sensorHeightMm: 24,
});
const radial = await runNativeDistortion({
  opticalSystemRows: input.opticalSystem,
  sourceRows: input.source,
  objectRows: input.object,
  surfaceIndex: input.opticalSystem.length - 1,
  fieldSamples: [0, 5, 10, 15, 20],
  heightMode: true,
  distortionMetric: 'chief-ray',
  wavelength: 0.5875618,
});

const finite = (values) => values.filter((value) => Number.isFinite(Number(value))).map(Number);
const range = (values) => {
  const numbers = finite(values);
  return numbers.length ? [Math.min(...numbers), Math.max(...numbers)] : [null, null];
};
const rows = Array.from({ length: result.gridSize }, (_, row) => (
  Array.from({ length: result.gridSize }, (_, column) => {
    const index = row * result.gridSize + column;
    return {
      ideal: [result.idealX[index], result.idealY[index]],
      real: [result.realX[index], result.realY[index]],
    };
  })
));
const normalizedGrid = normalizeDistortionMapsToReference([{
  gridSize: result.gridSize,
  idealX: result.idealX,
  idealY: result.idealY,
  realX: result.realX,
  realY: result.realY,
}]);
assert.equal(normalizedGrid.reference.valid, true, 'anamorphic grid requires an invertible affine reference');
const normalizedMap = normalizedGrid.maps[0];
let maxGridResidualMm = 0;
for (let index = 0; index < normalizedMap.idealX.length; index += 1) {
  const realX = Number(normalizedMap.realX[index]);
  const realY = Number(normalizedMap.realY[index]);
  if (!(Number.isFinite(realX) && Number.isFinite(realY))) continue;
  maxGridResidualMm = Math.max(
    maxGridResidualMm,
    Math.hypot(realX - normalizedMap.idealX[index], realY - normalizedMap.idealY[index]),
  );
}
assert.ok(maxGridResidualMm < 1e-9, 'an ideal anamorphic system must have zero residual grid distortion');

const normalizedRadial = normalizeDistortionSeriesLinearReference(radial);
const maxRadialDistortionPercent = Math.max(...normalizedRadial.distortionPercent
  .filter((value) => Number.isFinite(Number(value)))
  .map((value) => Math.abs(Number(value))));
assert.ok(maxRadialDistortionPercent < 1e-9, 'an ideal anamorphic system must have zero residual 1D distortion');

const imageWidth = 64;
const imageHeight = 48;
const sourceRgba = new Uint8ClampedArray(imageWidth * imageHeight * 4);
for (let y = 0; y < imageHeight; y += 1) {
  for (let x = 0; x < imageWidth; x += 1) {
    const offset = (y * imageWidth + x) * 4;
    sourceRgba[offset] = Math.round(255 * x / Math.max(1, imageWidth - 1));
    sourceRgba[offset + 1] = Math.round(255 * y / Math.max(1, imageHeight - 1));
    sourceRgba[offset + 2] = ((x + 2 * y) % 11) < 4 ? 240 : 20;
    sourceRgba[offset + 3] = 255;
  }
}
const sourceImage = { width: imageWidth, height: imageHeight, rgba: sourceRgba };
const warpedImage = warpImageWithDistortion(sourceImage, normalizedMap, {
  minXmm: -18,
  maxXmm: 18,
  minYmm: -12,
  maxYmm: 12,
  widthMm: 36,
  heightMm: 24,
});
const warpDifferencePercent = calculateImageSimulationDifferencePercent(sourceImage, warpedImage);
assert.ok(warpDifferencePercent < 1e-6, 'affine reference removal must prevent false Image Simulation warping');

console.log(JSON.stringify({
  ok: true,
  fixture: '20260823_bug_02.json',
  backend: result.backend,
  meta: result.meta,
  idealXRange: range(result.idealX),
  idealYRange: range(result.idealY),
  realXRange: range(result.realX),
  realYRange: range(result.realY),
  rawRows: rows,
  affineReference: normalizedGrid.reference,
  maxGridResidualMm,
  warpDifferencePercent,
  radial: {
    backend: radial.backend,
    idealHeights: radial.idealHeights,
    realHeights: radial.realHeights,
    distortion: radial.distortion,
    distortionPercent: radial.distortionPercent,
    meta: radial.meta,
    normalizedDistortionPercent: normalizedRadial.distortionPercent,
    maxNormalizedDistortionPercent: maxRadialDistortionPercent,
  },
}, null, 2));
