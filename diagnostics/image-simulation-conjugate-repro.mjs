import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calculateImageSpaceDiffractionParams } from '../raytracing/core/ray-paraxial.ts';
import { calculatePsfImagePixelSizeUm } from '../src/app/psf-scale-model.ts';
import {
  buildMultiFieldPsfObjectRow,
  deriveMultiFieldPsfFieldDefinition,
} from '../src/app/multi-field-psf-model.ts';
import { detectConjugateType } from '../utils/conjugate-detection.ts';

const fixture = JSON.parse(fs.readFileSync(
  new URL('./results/optimizer-profile-input-qcon-radiusV.json', import.meta.url),
  'utf8',
));
const infiniteRows = fixture.opticalSystem;
const finiteRows = infiniteRows.map((row, index) => (
  index === 0 ? { ...row, thickness: 200 } : { ...row }
));

assert.equal(detectConjugateType(infiniteRows), 'infinite');
assert.equal(detectConjugateType(finiteRows), 'finite');

const wavelengthUm = 0.55;
const samplingSize = 32;
const fftSize = 64;
const infinite = calculateImageSpaceDiffractionParams(infiniteRows, wavelengthUm);
const finite = calculateImageSpaceDiffractionParams(finiteRows, wavelengthUm);
assert.ok(infinite && finite, 'both conjugates must produce image-space diffraction parameters');
assert.equal(infinite.conjugateType, 'infinite');
assert.equal(finite.conjugateType, 'finite');
assert.ok(infinite.fNumberWorking > 0 && finite.fNumberWorking > 0);
assert.notEqual(infinite.fNumberWorking, finite.fNumberWorking, 'finite conjugate must use its image-space working F-number');

const infinitePixelSizeUm = calculatePsfImagePixelSizeUm(
  wavelengthUm, infinite.fNumberWorking, samplingSize, fftSize,
);
const finitePixelSizeUm = calculatePsfImagePixelSizeUm(
  wavelengthUm, finite.fNumberWorking, samplingSize, fftSize,
);
assert.ok(infinitePixelSizeUm > 0 && finitePixelSizeUm > 0);
assert.ok(finitePixelSizeUm > infinitePixelSizeUm, 'this finite-conjugate fixture must produce the expected larger diffraction pitch');

const infiniteDefinition = deriveMultiFieldPsfFieldDefinition([
  { position: 'Angle', xHeightAngle: 0, yHeightAngle: 12 },
]);
const finiteDefinition = deriveMultiFieldPsfFieldDefinition([
  { position: 'Rectangle', xHeight: 0, yHeight: 20 },
]);
assert.equal(buildMultiFieldPsfObjectRow([], { x: 3, y: 4 }, infiniteDefinition.mode).position, 'Angle');
assert.equal(buildMultiFieldPsfObjectRow([], { x: 3, y: 4 }, finiteDefinition.mode).position, 'Rectangle');

console.log(JSON.stringify({
  ok: true,
  infinite: { fNumberWorking: infinite.fNumberWorking, pixelSizeUm: infinitePixelSizeUm },
  finite: { objectDistanceMm: 200, fNumberWorking: finite.fNumberWorking, pixelSizeUm: finitePixelSizeUm },
}, null, 2));
