import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const inputPath = path.join(root, 'Examples', 'US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json');
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
globalThis.self = new EventTarget();
const { default: init, run_native_distortion_wasm_json } = await import('../rust-wasm/pkg/surface_origins.js');
await init({ module_or_path: fs.readFileSync(path.join(root, 'rust-wasm', 'pkg', 'surface_origins_bg.wasm')) });

const maxAngle = Math.max(...input.object.map((row) => Math.abs(Number(row.yHeightAngle) || 0)));
const step = Math.ceil(maxAngle / 25);
const fields = [];
for (let angle = maxAngle * 0.001; angle <= maxAngle + 1e-9; angle += step) {
  fields.push(Number(angle.toFixed(6)));
}
if (fields.at(-1) !== maxAngle) fields.push(maxAngle);

const summaries = [];
for (const source of input.source) {
  const request = {
    opticalSystemRows: input.opticalSystem,
    sourceRows: input.source,
    objectRows: input.object,
    fieldSamples: fields,
    heightMode: false,
    wavelength: source.wavelength,
    distortionMetric: 'chief-ray',
  };
  const result = run_native_distortion_wasm_json(JSON.stringify(request));
  assert.equal(result.fieldValues.length, fields.length, `field count at ${source.wavelength} um`);
  assert.equal(result.realHeights.length, fields.length, `real-height count at ${source.wavelength} um`);
  assert.equal(result.distortionPercent.length, fields.length, `distortion count at ${source.wavelength} um`);
  for (let index = 0; index < fields.length; index += 1) {
    assert.ok(Number.isFinite(result.realHeights[index]), `missing chief ray at ${fields[index]} deg, ${source.wavelength} um`);
    assert.ok(Number.isFinite(result.distortionPercent[index]), `missing distortion at ${fields[index]} deg, ${source.wavelength} um`);
    if (index > 0) {
      assert.ok(
        result.realHeights[index] > result.realHeights[index - 1],
        `non-monotonic image height at ${fields[index]} deg, ${source.wavelength} um`,
      );
      assert.ok(
        result.distortionPercent[index] < result.distortionPercent[index - 1],
        `distortion branch reversal at ${fields[index]} deg, ${source.wavelength} um`,
      );
    }
  }
  summaries.push({
    wavelengthUm: source.wavelength,
    points: fields.length,
    minFieldDeg: fields[0],
    maxFieldDeg: fields.at(-1),
    firstDistortionPercent: result.distortionPercent[0],
    lastDistortionPercent: result.distortionPercent.at(-1),
    backend: result.backend,
  });
}

console.log(JSON.stringify({ ok: true, case: path.basename(inputPath), summaries }, null, 2));
