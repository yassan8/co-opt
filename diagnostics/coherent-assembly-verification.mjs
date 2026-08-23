import assert from 'node:assert/strict';
import {
  calculateLensVolumeMm3,
  calculatePathOpticalLengthMm,
  createPatentFig2AssemblyDesign,
  evaluateCoherentAssembly,
  parseTargetProfileCsv,
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

const comb = structuredClone(design);
comb.source.kind = 'frequency-comb';
comb.source.repetitionRateGHz = 100;
comb.source.lineCount = 65;
const combSimulation = simulatePatentFig2(comb);
assert.ok(combSimulation.integratedPowerW > 0, 'frequency-comb assembly reaches the detector');
assert.ok(combSimulation.propagatingFraction > 0.99, 'frequency-comb lines propagate in the configured grating order');

console.log(JSON.stringify({
  ok: true,
  checks: 38,
  componentCount: design.components.length,
  envelopeMm: assembly.mechanicalBounds.size,
  envelopeVolumeMm3: assembly.mechanicalBounds.volumeMm3,
  opticalVolumeMm3: assembly.opticalVolumeMm3,
  stepRmsHeightErrorUm: simulation.rmsHeightErrorUm,
  flatRmsHeightErrorUm: flatSimulation.rmsHeightErrorUm,
  detectorPowerW: simulation.integratedPowerW,
  combDetectorPowerW: combSimulation.integratedPowerW,
}, null, 2));
