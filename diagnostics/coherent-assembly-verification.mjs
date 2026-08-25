import assert from 'node:assert/strict';
import {
  calculateLensVolumeMm3,
  calculatePathOpticalLengthMm,
  createPatentFig2AssemblyDesign,
  evaluateCoherentAssembly,
  parseTargetProfileCsv,
  reconstructPatentFig2FromDetectorSignal,
  simulatePatentFig2,
} from '../analysis/coherent-assembly.ts';

const closeTo = (actual, expected, tolerance, label) => {
  assert.ok(Number.isFinite(actual), `${label}: expected finite, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected} within ${tolerance}`);
};

const design = createPatentFig2AssemblyDesign();
const references = new Set(design.components.map((item) => item.reference));
for (const required of ['11', '21', '22', '23a', '23b', '24', '25', '26', '27', '28', '70', '80', '100']) {
  assert.ok(references.has(required), `Patent Fig. 2 component ${required} is explicit`);
}
assert.equal(design.paths.length, 4, 'all four physical paths are stored in one configuration');

const assembly = evaluateCoherentAssembly(design);
assert.equal(assembly.missingDimensionComponentIds.length, 0, 'preset has no missing dimensions');
assert.equal(assembly.collisions.length, 0, 'preset mechanical envelopes do not overlap');
assert.ok(assembly.mechanicalBounds?.volumeMm3 > 0, 'assembly envelope volume is positive');
assert.ok(assembly.opticalVolumeMm3 > 0, 'optical solid volume is positive');
assert.equal(assembly.confidence, 'Estimated', 'preset dimensions are not presented as exact catalogue data');
closeTo(assembly.opticalPathDifferenceMm, 0, 1e-12, 'balanced preset OPD');
closeTo(calculatePathOpticalLengthMm(design, 'object', 486.1327) - calculatePathOpticalLengthMm(design, 'reference', 486.1327), 0, 1e-12, 'balanced blue-wavelength OPL');
const chromaticFixture = structuredClone(design);
chromaticFixture.components.find((item) => item.id === 'focus-lens-26').abbeNumber = 20;
const chromaticBlueOpd = calculatePathOpticalLengthMm(chromaticFixture, 'object', 486.1327) - calculatePathOpticalLengthMm(chromaticFixture, 'reference', 486.1327);
const chromaticRedOpd = calculatePathOpticalLengthMm(chromaticFixture, 'object', 656.2725) - calculatePathOpticalLengthMm(chromaticFixture, 'reference', 656.2725);
assert.ok(
  Math.abs(chromaticBlueOpd - chromaticRedOpd) > 1e-3,
  'unequal arm glass dispersion creates wavelength-resolved OPD',
);

const planoCylinder = calculateLensVolumeMm3({
  widthMm: 20,
  heightMm: 20,
  depthMm: 4,
  apertureDiameterMm: 20,
  centerThicknessMm: 4,
  frontRadiusMm: null,
  backRadiusMm: null,
});
closeTo(planoCylinder, Math.PI * 10 * 10 * 4, 0.02, 'plano lens cylinder volume');

const moved = structuredClone(design);
const target = moved.components.find((item) => item.id === 'target-100');
target.manualOffset.positionMm.x = 10;
const movedAssembly = evaluateCoherentAssembly(moved);
closeTo(movedAssembly.opticalPathDifferenceMm, 20, 1e-12, '10 mm target move creates 20 mm round-trip OPD');
closeTo(movedAssembly.opticalVolumeMm3, assembly.opticalVolumeMm3, 1e-9, 'placement does not change solid volume');
assert.ok(movedAssembly.mechanicalBounds.volumeMm3 > assembly.mechanicalBounds.volumeMm3, 'placement expands assembly envelope');

const collisionFixture = structuredClone(design);
const detector = collisionFixture.components.find((item) => item.id === 'detector-80');
detector.autoTransform.positionMm = { ...collisionFixture.components.find((item) => item.id === 'beam-splitter-24').autoTransform.positionMm };
assert.ok(evaluateCoherentAssembly(collisionFixture).collisions.length > 0, 'mechanical overlap is detected');

const csv = parseTargetProfileCsv('# x(mm), z(um)\n-1, 4\n0, 5\n1, 7');
assert.deepEqual(csv, [{ xMm: -1, zUm: 4 }, { xMm: 0, zUm: 5 }, { xMm: 1, zUm: 7 }]);

const simulation = simulatePatentFig2(design);
assert.equal(simulation.width, design.detector.pixelCountX);
assert.equal(simulation.height, design.detector.pixelCountY);
assert.ok(simulation.integratedPowerW > 0, 'detector receives physical power');
assert.ok(simulation.maxIntensityWPerPixel > 0, 'W/pixel output is positive');
assert.ok(simulation.propagatingFraction > 0.99, 'default grating passes the sampled spectrum');
assert.ok(simulation.rmsHeightErrorUm < 1, `step-profile RMS recovery error ${simulation.rmsHeightErrorUm} um`);
assert.ok(simulation.maxAbsHeightErrorUm < 1, `step-profile max recovery error ${simulation.maxAbsHeightErrorUm} um`);

const flat = structuredClone(design);
flat.target.kind = 'flat';
flat.target.offsetUm = 12;
const flatSimulation = simulatePatentFig2(flat);
assert.ok(flatSimulation.rmsHeightErrorUm < 1, `flat-profile RMS recovery error ${flatSimulation.rmsHeightErrorUm} um`);

const routedStep = structuredClone(design);
routedStep.target.kind = 'step';
routedStep.target.offsetUm = 0;
routedStep.target.amplitudeUm = 100;
routedStep.target.stepPositionMm = 0;
routedStep.detector.pixelCountX = 256;
routedStep.detector.pixelCountY = 256;
routedStep.detectors[0].pixelCountX = 256;
routedStep.detectors[0].pixelCountY = 256;
const routedStepSimulation = simulatePatentFig2(routedStep, {
  baseOpdMm: 0.003,
  maximumDetectorPixels: 256,
  calibrationMinUm: -25,
  calibrationMaxUm: 125,
});
const routedStepLeft = routedStepSimulation.recoveredHeightUm.slice(0, routedStepSimulation.width / 2);
const routedStepRight = routedStepSimulation.recoveredHeightUm.slice(routedStepSimulation.width / 2);
const routedStepHeightUm = routedStepRight.reduce((sum, value) => sum + value, 0) / routedStepRight.length
  - routedStepLeft.reduce((sum, value) => sum + value, 0) / routedStepLeft.length;
assert.ok(Math.abs(routedStepHeightUm - 100) < 0.5, `100 um routed Step recovery ${routedStepHeightUm} um`);
assert.ok(routedStepSimulation.rmsHeightErrorUm < 0.5, `routed Step RMS recovery error ${routedStepSimulation.rmsHeightErrorUm} um`);
assert.equal(routedStepSimulation.opticalPathDifferenceMm, 0.003, 'port-routed zero-height OPD drives the Figure 2 calibration');

const fineSine = structuredClone(design);
fineSine.target.kind = 'sine';
fineSine.target.spanMm = 50;
fineSine.target.offsetUm = 0;
fineSine.target.amplitudeUm = 100;
fineSine.target.periodMm = 1;
fineSine.detector.pixelCountX = 2048;
fineSine.detector.pixelCountY = 2048;
fineSine.detector.pixelPitchUm = 5;
fineSine.detectors = [{ ...fineSine.detector }];
const fineSineSimulation = simulatePatentFig2(fineSine, {
  baseOpdMm: 0,
  maximumDetectorPixelsX: 1024,
  maximumDetectorPixelsY: 2048,
  minimumBroadbandSpectralSamples: 257,
  calibrationMinUm: -130,
  calibrationMaxUm: 130,
});
assert.equal(fineSineSimulation.width, 1024, 'fine Sine reconstruction uses the high-density Target-X grid');
assert.equal(fineSineSimulation.spectralSampleCount, 257, 'continuous broadband reconstruction uses 257 quadrature nodes');
assert.ok(fineSineSimulation.samplesPerTargetPeriod > 20, `fine Sine sampling ${fineSineSimulation.samplesPerTargetPeriod} points/period`);
assert.ok(fineSineSimulation.rmsHeightErrorUm < 0.1, `fine Sine RMS recovery error ${fineSineSimulation.rmsHeightErrorUm} um`);
assert.ok(fineSineSimulation.maxAbsHeightErrorUm < 0.1, `fine Sine max recovery error ${fineSineSimulation.maxAbsHeightErrorUm} um`);
assert.ok(fineSineSimulation.meanRidgeConfidence > 0.5, `fine Sine ridge confidence ${fineSineSimulation.meanRidgeConfidence}`);
assert.equal(fineSineSimulation.ridgeBreakBefore.filter(Boolean).length, 0, 'fine Sine ridge has no false vertical branch jumps');

const undersampledSineSimulation = simulatePatentFig2(fineSine, {
  baseOpdMm: 0,
  maximumDetectorPixelsX: 256,
  maximumDetectorPixelsY: 2048,
  minimumBroadbandSpectralSamples: 257,
  calibrationMinUm: -130,
  calibrationMaxUm: 130,
});
assert.ok(undersampledSineSimulation.samplesPerTargetPeriod < 8, 'coarse Target-X grid is recognized as undersampled');
assert.ok(undersampledSineSimulation.warningMessages.some((message) => message.includes('undersampled')), 'undersampled Sine warning is reported');

const cameraStepDesign = structuredClone(design);
Object.assign(cameraStepDesign.target, {
  kind: 'step', offsetUm: 0, amplitudeUm: 100, stepPositionMm: 0, spanMm: 50,
});
Object.assign(cameraStepDesign.detector, {
  pixelCountX: 256, pixelCountY: 2048, pixelPitchUm: 5,
  calibrationMinUm: -130, calibrationMaxUm: 130,
});
cameraStepDesign.detectors = [{ ...cameraStepDesign.detector }];
const cameraStepForward = simulatePatentFig2(cameraStepDesign, {
  baseOpdMm: 0,
  maximumDetectorPixelsX: 256,
  maximumDetectorPixelsY: 2048,
  minimumBroadbandSpectralSamples: 257,
  calibrationMinUm: -130,
  calibrationMaxUm: 130,
});
const reconstructCameraStep = (comparisonTarget) => reconstructPatentFig2FromDetectorSignal({
  powerWPerPixel: cameraStepForward.intensityWPerPixel,
  width: cameraStepForward.width,
  height: cameraStepForward.height,
  detector: cameraStepDesign.detector,
  grating: cameraStepDesign.grating,
  sourceCenterWavelengthNm: cameraStepDesign.source.centerWavelengthNm,
  baseOpdMm: 0,
  targetSpanMm: cameraStepDesign.target.spanMm,
  calibrationMinUm: -130,
  calibrationMaxUm: 130,
  spectralSampleCount: 257,
  comparisonTarget,
});
const cameraStepRecovery = reconstructCameraStep(cameraStepDesign.target);
const cameraStepHalf = cameraStepRecovery.width / 2;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const cameraRecoveredStepUm = mean(cameraStepRecovery.recoveredHeightUm.slice(cameraStepHalf))
  - mean(cameraStepRecovery.recoveredHeightUm.slice(0, cameraStepHalf));
assert.ok(Math.abs(cameraRecoveredStepUm - 100) < 0.5, `Camera W/pixel recovers the 100 um Step (${cameraRecoveredStepUm} um)`);
const cameraRecoveryWithWrongComparison = reconstructCameraStep({
  kind: 'flat', spanMm: 50, offsetUm: 37, amplitudeUm: 0, stepPositionMm: 0, periodMm: 1,
});
assert.deepEqual(
  cameraRecoveryWithWrongComparison.recoveredHeightUm,
  cameraStepRecovery.recoveredHeightUm,
  'configured comparison Target cannot change Camera-derived reconstruction',
);
assert.equal(cameraStepRecovery.cameraReferenceColumn, 0, 'first signal-bearing Camera column defines relative-height zero');
assert.ok(cameraStepRecovery.carrierAliased, 'undersampled optical carrier is reported instead of hidden');

const comb = structuredClone(design);
comb.source.kind = 'frequency-comb';
comb.source.repetitionRateGHz = 100;
comb.source.lineCount = 65;
const combSimulation = simulatePatentFig2(comb);
assert.ok(combSimulation.integratedPowerW > 0, 'frequency-comb assembly reaches the detector');
assert.ok(combSimulation.propagatingFraction > 0.99, 'frequency-comb lines propagate in the configured grating order');

console.log(JSON.stringify({
  ok: true,
  checks: 54,
  componentCount: design.components.length,
  envelopeMm: assembly.mechanicalBounds.size,
  envelopeVolumeMm3: assembly.mechanicalBounds.volumeMm3,
  opticalVolumeMm3: assembly.opticalVolumeMm3,
  stepRmsHeightErrorUm: simulation.rmsHeightErrorUm,
  flatRmsHeightErrorUm: flatSimulation.rmsHeightErrorUm,
  routedStepHeightUm,
  routedStepRmsHeightErrorUm: routedStepSimulation.rmsHeightErrorUm,
  fineSineRmsHeightErrorUm: fineSineSimulation.rmsHeightErrorUm,
  fineSineMaxHeightErrorUm: fineSineSimulation.maxAbsHeightErrorUm,
  fineSineSamplesPerPeriod: fineSineSimulation.samplesPerTargetPeriod,
  fineSineRidgeConfidence: fineSineSimulation.meanRidgeConfidence,
  cameraRecoveredStepUm,
  detectorPowerW: simulation.integratedPowerW,
  combDetectorPowerW: combSimulation.integratedPowerW,
}, null, 2));
