import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.self = new EventTarget();
const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };

const { runNativeMagnificationChromaticAberration } = await import('../src/desktop/ipc/client.ts');
const input = JSON.parse(fs.readFileSync(
  new URL('../Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json', import.meta.url),
  'utf8',
));

const pointCount = 41;
const maxField = Math.max(...input.object.map((row) => Math.abs(Number(row.yHeightAngle) || 0)));
const fieldSamples = Array.from({ length: pointCount }, (_, index) => maxField * index / (pointCount - 1));
const wavelengths = input.source.map((row) => Number(row.wavelength)).filter(Number.isFinite);
const referenceWavelength = Number(input.source.find((row) => String(row.primary || '').includes('Primary'))?.wavelength);

const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => {};
console.warn = () => {};
let result;
try {
  result = await runNativeMagnificationChromaticAberration({
    opticalSystemRows: input.opticalSystem,
    sourceRows: input.source,
    fieldSamples,
    wavelengths,
    referenceWavelength,
    heightMode: false,
    imageHeightMode: false,
    rayCount: 101,
    ringCount: 30,
    chiefRayDefinition: 'stop-center',
  });
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
}

assert.ok(result, 'Retrofocus LCA calculation failed');
assert.equal(result.fieldValues.length, pointCount);

const summaries = [];
for (const series of result.dataByWavelength) {
  assert.equal(series.displacements.length, pointCount);
  assert.equal(series.imageHeights.length, pointCount);
  assert.ok(
    series.displacements.every((value) => typeof value === 'number' && Number.isFinite(value)),
    `${series.wavelength}: missing or non-finite LCA value`,
  );
  assert.ok(
    series.imageHeights.every((value) => typeof value === 'number' && Number.isFinite(value)),
    `${series.wavelength}: missing or non-finite image height`,
  );

  const steps = series.displacements.slice(1).map((value, index) => value - series.displacements[index]);
  const maxAdjacentJump = Math.max(...steps.map(Math.abs));
  assert.ok(maxAdjacentJump < 0.0005, `${series.wavelength}: discontinuous LCA jump ${maxAdjacentJump} mm`);
  assert.ok(
    Math.abs(series.imageHeights.at(-1)) > 0.9,
    `${series.wavelength}: high-field image height collapsed at ${maxField} degrees`,
  );

  if (Math.abs(Number(series.wavelength) - referenceWavelength) < 1e-9) {
    assert.ok(
      series.displacements.every((value) => Math.abs(value) < 1e-12),
      `${series.wavelength}: reference-wavelength LCA is not zero`,
    );
  }

  summaries.push({
    wavelength: series.wavelength,
    pointCount: series.displacements.length,
    finalImageHeightMm: series.imageHeights.at(-1),
    minMm: Math.min(...series.displacements),
    maxMm: Math.max(...series.displacements),
    maxAdjacentJumpMm: maxAdjacentJump,
  });
}

originalLog(JSON.stringify({ ok: true, maxFieldDegrees: maxField, summaries }, null, 2));
