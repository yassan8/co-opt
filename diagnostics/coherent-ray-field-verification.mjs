import assert from 'node:assert/strict';
import { convolveDetectorFieldsWithCoherentPsf } from '../analysis/detector-signal.ts';
import { reconstructCoherentRayField } from '../analysis/coherent-ray-field.ts';
const width = 96, height = 96, lambdaMm = 632.8e-6;
const k = 2 * Math.PI / lambdaMm;
const detector = { pixelCountX: width, pixelCountY: height, pixelPitchUm: 40, quantumEfficiency: 0.8, exposureTimeS: 1e-9, saturationElectrons: 30000 };
const psf = [{ wavelengthUm: 0.6328, weight: 1, psfData: [[1]], fieldReal: [[Math.cos(0.7)]], fieldImag: [[Math.sin(0.7)]], pixelSizeUm: 40 }];
function samples(count, routeId, extraPhase = 0) {
  return Array.from({ length: count }, (_, i) => {
    const r = 38 * Math.sqrt((i + 0.5) / count), theta = i * Math.PI * (3 - Math.sqrt(5));
    const x = r * Math.cos(theta), y = r * Math.sin(theta);
    // A rapidly wrapped common curved wavefront plus a known relative tilt.
    const phase = 0.04 * (x * x + y * y) + (routeId === 'b' ? 2 * Math.PI * 0.08 * y : 0);
    const opl = 100 + phase / k;
    const amplitude = 1 / Math.sqrt(count);
    return { routeId, pixelX: x + 47.5, pixelY: y + 47.5, pupilXmm: x, pupilYmm: y, opticalPathLengthMm: opl, frequencyHz: 299792458 / 632.8e-9, wavelengthNm: 632.8, coherenceGroupId: 'source', fieldRe: amplitude * Math.cos(k * opl + extraPhase), fieldIm: amplitude * Math.sin(k * opl + extraPhase) };
  });
}
const convert = s => convolveDetectorFieldsWithCoherentPsf({ spectralFields: s, width, height, detector, spectralPsf: psf });
const report = [];
for (const count of [512, 4096]) {
  const a = samples(count, 'a'), b = samples(count, 'b');
  const result = convert(a.concat(b));
  assert.equal(result.warning, '');
  // Detector-plane fields must be independent of any standalone PSF, even
  // when that optional PSF has an unrelated conjugate or lacks complex phase.
  const direct = convolveDetectorFieldsWithCoherentPsf({ spectralFields: a.concat(b), width, height, detector,
    spectralPsf: [], inputPlane: 'detector' });
  const unrelatedPsf = convolveDetectorFieldsWithCoherentPsf({ spectralFields: a.concat(b), width, height, detector,
    spectralPsf: [{ wavelengthUm: 0.5, psfData: [[0,1],[1,0]], weight: 1, pixelSizeUm: 500 }], inputPlane: 'detector' });
  assert.equal(direct.complexKernelCount, 0);
  assert.equal(unrelatedPsf.warning, '');
  assert.deepEqual(direct.signal.powerWPerPixel, unrelatedPsf.signal.powerWPerPixel);
  const ia = convert(a).signal.powerWPerPixel, ib = convert(b).signal.powerWPerPixel;
  let error = 0, pixels = 0, holes = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (Math.hypot(x - 47.5, y - 47.5) > 32) continue;
    const index = y * width + x, dc = ia[index] + ib[index];
    if (!(dc > 0)) holes++;
    const expected = 1 + Math.cos(2 * Math.PI * 0.08 * (y - 47.5));
    error += (result.signal.powerWPerPixel[index] / dc - expected) ** 2;
    pixels++;
  }
  const rms = Math.sqrt(error / pixels);
  assert.equal(holes, 0, 'A sampled plane wave must not leave ray-grid holes');
  assert.ok(rms < 1e-5, `Incorrect fringe phase: RMS ${rms}`);
  const dark = convert(a.concat(a.map(s => ({ ...s, routeId: 'b', fieldRe: -s.fieldRe, fieldIm: -s.fieldIm }))));
  assert.ok(dark.signal.integratedPowerW < 1e-20, 'Destructive interference must remain dark');
  const incoherent = convert(a.concat(b.map(s => ({ ...s, coherenceGroupId: 'other' }))));
  assert.equal(incoherent.interferingModeCount, 0);
  assert.ok(Math.abs(incoherent.signal.integratedPowerW - 2) < 1e-8);
  const permuted = convert(a.concat(b).reverse());
  const difference = result.signal.powerWPerPixel.reduce((sum, p, i) => sum + Math.abs(p - permuted.signal.powerWPerPixel[i]), 0);
  assert.ok(difference < 1e-8, 'Input ray ordering must not imprint a spiral');
  report.push({ raysPerArm: count, interiorPixels: pixels, holes, relativeFringeRms: rms, orderingDifference: difference });
}
const step = samples(512, 'a').map(s => ({ ...s, opticalPathLengthMm: s.opticalPathLengthMm + (s.pixelX > 48 ? 0.1 : 0) }));
assert.equal(reconstructCoherentRayField(step, width, height, width, height), null, 'Do not fit over a surface step');
const randomPhase = samples(512, 'a').map((s, i) => ({ ...s, fieldRe: Math.cos(i), fieldIm: Math.sin(i) }));
assert.equal(reconstructCoherentRayField(randomPhase, width, height, width, height), null, 'Do not smooth arbitrary physical phase');
console.log(JSON.stringify({ ok: true, report }, null, 2));
