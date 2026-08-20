import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.self = new EventTarget();
const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
const { runNativeMagnificationChromaticAberration } = await import('../src/desktop/ipc/client.ts');
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };

const input = JSON.parse(fs.readFileSync(new URL('../Examples/default-load.json', import.meta.url), 'utf8'));
const configuration = input.configurations.configurations.find((entry) => entry.name === 'Wide');
assert.ok(configuration, 'Wide configuration was not found');

const pointCount = 41;
const maxImageHeight = Math.max(...configuration.object.map((row) => Math.abs(Number(row.yHeightAngle) || 0)));
const fieldSamples = Array.from({ length: pointCount }, (_, index) => maxImageHeight * index / (pointCount - 1));
const wavelengths = input.source.map((row) => Number(row.wavelength)).filter(Number.isFinite);
const referenceWavelength = Number(input.source.find((row) => String(row.primary || '').includes('Primary'))?.wavelength);

const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => {};
console.warn = () => {};
const result = await runNativeMagnificationChromaticAberration({
  opticalSystemRows: configuration.opticalSystem,
  sourceRows: input.source,
  fieldSamples,
  wavelengths,
  referenceWavelength,
  heightMode: true,
  imageHeightMode: true,
  rayCount: 101,
  ringCount: 30,
  chiefRayDefinition: 'stop-center',
});
console.log = originalLog;
console.warn = originalWarn;

assert.ok(result, 'Wide LCA calculation failed');
assert.equal(result.fieldValues.length, pointCount);

const summaries = [];
for (const series of result.dataByWavelength) {
  assert.equal(series.displacements.length, pointCount);
  assert.ok(series.displacements.every(Number.isFinite), `non-finite LCA value at ${series.wavelength}`);

  const steps = series.displacements.slice(1).map((value, index) => value - series.displacements[index]);
  const maxAdjacentJump = Math.max(...steps.map(Math.abs));
  assert.ok(maxAdjacentJump < 0.001, `${series.wavelength}: discontinuous LCA jump ${maxAdjacentJump} mm`);

  if (Math.abs(Number(series.wavelength) - referenceWavelength) < 1e-9) {
    const maxReferenceHeightError = Math.max(...series.imageHeights.map((height, index) => Math.abs(height - fieldSamples[index])));
    assert.ok(maxReferenceHeightError < 1e-4, `ImageHeight inverse solve error ${maxReferenceHeightError} mm`);
  } else if (Number(series.wavelength) < referenceWavelength) {
    assert.ok(steps.every((step) => step <= 1e-8), `${series.wavelength}: blue LCA is not monotonic`);
  } else {
    assert.ok(steps.every((step) => step >= -1e-8), `${series.wavelength}: red LCA is not monotonic`);
  }

  summaries.push({
    wavelength: series.wavelength,
    pointCount: series.displacements.length,
    minMm: Math.min(...series.displacements),
    maxMm: Math.max(...series.displacements),
    maxAdjacentJumpMm: maxAdjacentJump,
  });
}

originalLog(JSON.stringify({ ok: true, configuration: 'Wide', maxImageHeight, summaries }, null, 2));
