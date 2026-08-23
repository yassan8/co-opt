import assert from 'node:assert/strict';
import {
  buildDualCombBeatNotes,
  evaluateBeamSplitter,
  evaluateReflectionGrating,
  fabryPerotFreeSpectralRangeGHz,
  generateCombLines,
  simulateBroadbandGrating,
  simulateDualComb,
  SPEED_OF_LIGHT_M_PER_S,
} from '../analysis/coherent-interferometer.ts';

const closeTo = (actual, expected, tolerance, label) => {
  assert.ok(Number.isFinite(actual), `${label}: expected a finite value, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected} within ${tolerance}`);
};

const splitter = evaluateBeamSplitter({ reflectance: 0.5, transmittance: 0.5 });
closeTo(splitter.reflected.amplitude, Math.SQRT1_2, 1e-14, '50/50 reflected amplitude');
closeTo(splitter.transmitted.amplitude, Math.SQRT1_2, 1e-14, '50/50 transmitted amplitude');
closeTo(splitter.loss, 0, 1e-14, 'lossless splitter energy');

const wavelengthNm = 632.8;
const density = 1200;
const spacingMm = 1 / density;
const littrowAngleDeg = Math.asin((wavelengthNm * 1e-6) / (2 * spacingMm)) * 180 / Math.PI;
const littrow = evaluateReflectionGrating({
  wavelengthNm,
  grooveDensityLinesPerMm: density,
  incidenceAngleDeg: littrowAngleDeg,
  order: 1,
});
assert.equal(littrow.propagating, true);
closeTo(littrow.diffractionAngleDeg, littrowAngleDeg, 1e-12, 'Littrow diffraction angle');

const evanescent = evaluateReflectionGrating({
  wavelengthNm: 1550,
  grooveDensityLinesPerMm: 2400,
  incidenceAngleDeg: 0,
  order: 1,
});
assert.equal(evanescent.propagating, false, 'non-propagating order is rejected');

const comb1 = generateCombLines({
  centerWavelengthNm: 1550,
  repetitionRateGHz: 10,
  offsetFrequencyMHz: 0,
  lineCount: 9,
  bandwidthNm: 3,
});
const comb2 = generateCombLines({
  centerWavelengthNm: 1550,
  repetitionRateGHz: 10.0001,
  offsetFrequencyMHz: 2,
  lineCount: 9,
  bandwidthNm: 3,
});
closeTo(comb1.reduce((sum, line) => sum + line.power, 0), 1, 1e-14, 'comb 1 normalization');
closeTo(comb2.reduce((sum, line) => sum + line.power, 0), 1, 1e-14, 'comb 2 normalization');
const notes = buildDualCombBeatNotes(comb1, comb2, 0);
assert.equal(notes.length, 9);
for (let index = 1; index < notes.length; index += 1) {
  closeTo(Math.abs(notes[index].frequencyHz - notes[index - 1].frequencyHz), 100_000, 0.1, 'RF tooth spacing');
}

const dual = simulateDualComb({
  signal: {
    centerWavelengthNm: 1550,
    repetitionRateGHz: 10,
    offsetFrequencyMHz: 0,
    lineCount: 41,
    bandwidthNm: 4,
  },
  localOscillator: {
    centerWavelengthNm: 1550,
    repetitionRateGHz: 10.0001,
    offsetFrequencyMHz: 2,
    lineCount: 41,
    bandwidthNm: 4,
  },
  opticalPathDifferenceMm: 12.5,
  beamSplitter: { reflectance: 0.5, transmittance: 0.5 },
  visibility: 0.95,
  durationUs: 10,
  sampleCount: 2049,
});
closeTo(dual.interferogramPeriodUs, 10, 1e-9, 'dual-comb interferogram period');
assert.equal(dual.aliased, false, 'default dual-comb acquisition is not aliased');
assert.ok(dual.detectorSignal.every(Number.isFinite), 'interferogram is finite');

const expectedFsrGHz = SPEED_OF_LIGHT_M_PER_S / (2 * 15e-3) / 1e9;
closeTo(fabryPerotFreeSpectralRangeGHz(15), expectedFsrGHz, 1e-12, 'Fabry-Perot FSR');

const broadband = simulateBroadbandGrating({
  centerWavelengthNm: 600,
  bandwidthNm: 160,
  sampleCount: 257,
  opticalPathDifferenceMm: 0.03,
  beamSplitter: { reflectance: 0.5, transmittance: 0.5 },
  visibility: 0.9,
  grating: {
    grooveDensityLinesPerMm: 600,
    incidenceAngleDeg: 10,
    order: 1,
    efficiency: 0.75,
  },
});
assert.equal(broadband.wavelengthNm.length, 257);
assert.ok(broadband.propagatingFraction > 0.99, 'default broadband grating order propagates');
assert.ok(broadband.integratedDetectorPower > 0, 'broadband detector receives power');

const phaseFixture = {
  centerWavelengthNm: 600,
  bandwidthNm: 20,
  sampleCount: 33,
  opticalPathDifferenceMm: 0,
  beamSplitter: { reflectance: 0.5, transmittance: 0.5, reflectedPhaseDeg: 37 },
  visibility: 1,
  grating: { grooveDensityLinesPerMm: 600, incidenceAngleDeg: 0, order: 0, efficiency: 1 },
};
const brightFringe = simulateBroadbandGrating({ ...phaseFixture, relativePhaseDeg: 0 });
const darkFringe = simulateBroadbandGrating({ ...phaseFixture, relativePhaseDeg: 180 });
closeTo(brightFringe.integratedDetectorPower, 1, 1e-12, 'balanced interferometer bright fringe');
assert.ok(darkFringe.integratedDetectorPower < 1e-12, 'balanced interferometer dark fringe');

console.log(JSON.stringify({
  ok: true,
  checks: 16,
  littrowAngleDeg,
  dualCombPeriodUs: dual.interferogramPeriodUs,
  dualCombMaxBeatMHz: dual.maxBeatFrequencyMHz,
  broadbandDetectorPower: broadband.integratedDetectorPower,
}, null, 2));
