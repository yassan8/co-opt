import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const inputPath = path.join(root, 'Examples', 'default-load.json');
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
globalThis.self = new EventTarget();
const { default: init, run_native_distortion_wasm_json } = await import('../rust-wasm/pkg/surface_origins.js');
await init({ module_or_path: fs.readFileSync(path.join(root, 'rust-wasm', 'pkg', 'surface_origins_bg.wasm')) });

const maxHeight = Math.max(...input.object.map((row) => Math.abs(Number(row.yHeightAngle) || 0)));
const fields = Array.from({ length: 21 }, (_, index) => maxHeight * index / 20);
const summaries = [];
for (const source of input.source) {
  const result = run_native_distortion_wasm_json(JSON.stringify({
    opticalSystemRows: input.opticalSystem,
    sourceRows: input.source,
    objectRows: input.object,
    fieldSamples: fields,
    heightMode: true,
    wavelength: source.wavelength,
    distortionMetric: 'chief-ray',
  }));
  assert.equal(result.fieldValues.length, fields.length, `field count at ${source.wavelength} um`);
  assert.equal(result.realHeights.length, fields.length, `real-height count at ${source.wavelength} um`);
  assert.equal(result.distortionPercent.length, fields.length, `distortion count at ${source.wavelength} um`);
  for (let index = 0; index < fields.length; index += 1) {
    const ideal = result.idealHeights[index];
    const real = result.realHeights[index];
    const distortion = result.distortionPercent[index];
    assert.ok(Number.isFinite(real), `missing chief ray at ${fields[index]} mm, ${source.wavelength} um`);
    assert.ok(Number.isFinite(distortion), `missing distortion at ${fields[index]} mm, ${source.wavelength} um`);
    assert.ok(Math.abs(ideal - fields[index]) < 1e-9, `wrong ideal image height at ${fields[index]} mm`);
    if (index > 0) {
      assert.ok(real > result.realHeights[index - 1], `non-monotonic image height at ${fields[index]} mm, ${source.wavelength} um`);
      assert.ok(
        Math.abs(distortion - result.distortionPercent[index - 1]) < 0.5,
        `distortion discontinuity at ${fields[index]} mm, ${source.wavelength} um`,
      );
    }
  }
  summaries.push({
    wavelengthUm: source.wavelength,
    points: fields.length,
    minImageHeightMm: fields[0],
    maxImageHeightMm: fields.at(-1),
    firstDistortionPercent: result.distortionPercent[0],
    lastDistortionPercent: result.distortionPercent.at(-1),
    backend: result.backend,
  });
}

console.log(JSON.stringify({ ok: true, case: path.basename(inputPath), summaries }, null, 2));
