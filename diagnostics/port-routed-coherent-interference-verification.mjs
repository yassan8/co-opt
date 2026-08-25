import assert from 'node:assert/strict';
import { sampleTargetHeightUm } from '../analysis/coherent-assembly.ts';
import { convolveDetectorFieldsWithCoherentPsf } from '../analysis/detector-signal.ts';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';
import { readOptionalExampleFixtureOrExit } from './optional-example-fixture.mjs';

const detector = {
  kind: 'area',
  pixelCountX: 32,
  pixelCountY: 32,
  pixelPitchUm: 5,
  fillFactor: 1,
  exposureTimeS: 1e-6,
  saturationElectrons: 1e30,
  bitDepth: 16,
  responsivity: 1,
};
const spectralPsf = [{
  wavelengthUm: 0.65,
  weight: 1,
  psfData: [[1]],
  pixelSizeUm: 5,
  fieldReal: [[1]],
  fieldImag: [[0]],
}];

function calculate(secondPhaseRad) {
  return convolveDetectorFieldsWithCoherentPsf({
    width: 32,
    height: 32,
    detector,
    spectralPsf,
    spectralFields: [
      { routeId: 'measurement', pixelX: 15.25, pixelY: 15.5, coherenceGroupId: 'source', frequencyHz: 4.612e14, wavelengthNm: 650, fieldRe: 1, fieldIm: 0 },
      { routeId: 'reference', pixelX: 15.25, pixelY: 15.5, coherenceGroupId: 'source', frequencyHz: 4.612e14, wavelengthNm: 650, fieldRe: Math.cos(secondPhaseRad), fieldIm: Math.sin(secondPhaseRad) },
    ],
  });
}

const constructive = calculate(0);
const destructive = calculate(Math.PI);
assert.ok(constructive && destructive, 'complex Detector result is available');
assert.equal(constructive.interferingModeCount, 1, 'two routes sharing a mode are recognized as interfering');
assert.ok(constructive.signal.integratedPowerW > destructive.signal.integratedPowerW * 1e12, 'relative route phase produces constructive and destructive interference');
assert.ok(constructive.signal.powerWPerPixel.reduce((count, value) => count + Number(value > 0), 0) >= 4, 'fractional Detector coordinates are distributed continuously across neighboring pixels');

const collapsedRoutes = convolveDetectorFieldsWithCoherentPsf({
  width: 32,
  height: 32,
  detector,
  spectralPsf,
  collapseSpatialSamplesPerMode: true,
  spectralFields: Array.from({ length: 200 }, (_, index) => {
    const referenceRoute = index >= 100;
    const routeIndex = index % 100;
    return {
      routeId: referenceRoute ? 'reference' : 'measurement',
      pixelX: 10 + (routeIndex % 10),
      pixelY: 10 + Math.floor(routeIndex / 10),
      coherenceGroupId: 'source',
      frequencyHz: 4.612e14,
      wavelengthNm: 650,
      fieldRe: 0.1,
      fieldIm: 0,
    };
  }),
});
assert.ok(collapsedRoutes, 'routed pupil samples produce a Detector signal');
assert.equal(collapsedRoutes.interferingModeCount, 1, 'collapsed measurement and reference routes still interfere');
assert.ok(
  collapsedRoutes.signal.powerWPerPixel.reduce((count, value) => count + Number(value > 0), 0) <= 8,
  'pupil samples are collapsed to routed complex images instead of a sparse point cloud',
);

const oversampledDetector = { ...detector, pixelCountX: 100, pixelCountY: 100, pixelPitchUm: 1 };
const coarseComplexPsf = [{
  wavelengthUm: 0.65,
  weight: 1,
  pixelSizeUm: 10,
  psfData: Array.from({ length: 8 }, () => Array(8).fill(1)),
  fieldReal: Array.from({ length: 8 }, () => Array(8).fill(1)),
  fieldImag: Array.from({ length: 8 }, () => Array(8).fill(0)),
}];
const oversampledSignal = convolveDetectorFieldsWithCoherentPsf({
  width: 100,
  height: 100,
  detector: oversampledDetector,
  spectralPsf: coarseComplexPsf,
  collapseSpatialSamplesPerMode: true,
  spectralFields: [{
    routeId: 'measurement', pixelX: 49.5, pixelY: 49.5,
    coherenceGroupId: 'source', frequencyHz: 4.612e14, wavelengthNm: 650,
    fieldRe: 1, fieldIm: 0,
  }],
});
assert.ok(oversampledSignal, 'an oversampled Detector receives the reconstructed complex PSF');
assert.ok(
  oversampledSignal.signal.powerWPerPixel.reduce((count, value) => count + Number(value > 0), 0) >= 6000,
  'a coarse PSF cell is area-integrated over the finer Detector pixels without a dotted lattice',
);
assert.ok(
  Math.abs(oversampledSignal.signal.integratedPowerW - 1) < 1e-12,
  'PSF-grid reconstruction conserves routed optical power',
);

const spatialSpectralPsf = [{
  wavelengthUm: 0.65, weight: 1, pixelSizeUm: 5,
  psfData: [[1, 1, 1]], fieldReal: [[1, 1, 1]], fieldImag: [[0, 0, 0]],
}];
const spatialPhaseSignal = convolveDetectorFieldsWithCoherentPsf({
  width: 32, height: 32, detector, spectralPsf: spatialSpectralPsf,
  spectralFields: [
    { routeId: 'measurement', pixelX: 14, pixelY: 16, coherenceGroupId: 'source', frequencyHz: 4.612e14, wavelengthNm: 650, fieldRe: 1, fieldIm: 0 },
    { routeId: 'measurement', pixelX: 16, pixelY: 16, coherenceGroupId: 'source', frequencyHz: 4.612e14, wavelengthNm: 650, fieldRe: 0, fieldIm: 1 },
  ],
});
const uniformPhaseSignal = convolveDetectorFieldsWithCoherentPsf({
  width: 32, height: 32, detector, spectralPsf: spatialSpectralPsf,
  spectralFields: [
    { routeId: 'measurement', pixelX: 14, pixelY: 16, coherenceGroupId: 'source', frequencyHz: 4.612e14, wavelengthNm: 650, fieldRe: 1, fieldIm: 0 },
    { routeId: 'measurement', pixelX: 16, pixelY: 16, coherenceGroupId: 'source', frequencyHz: 4.612e14, wavelengthNm: 650, fieldRe: 1, fieldIm: 0 },
  ],
});
assert.ok(spatialPhaseSignal && uniformPhaseSignal, 'spatially sampled routed fields produce signals');
assert.notDeepEqual(
  Array.from(spatialPhaseSignal.signal.powerWPerPixel),
  Array.from(uniformPhaseSignal.signal.powerWPerPixel),
  'Detector reconstruction retains the spatial phase differences produced by a shaped Target',
);

const targetSpec = { spanMm: 50, offsetUm: 3, amplitudeUm: 20, periodMm: 10, stepPositionMm: 0 };
assert.equal(sampleTargetHeightUm({ ...targetSpec, kind: 'tilt' }, -25), -17, 'Tilt reaches offset-amplitude at the negative edge');
assert.equal(sampleTargetHeightUm({ ...targetSpec, kind: 'tilt' }, 25), 23, 'Tilt reaches offset+amplitude at the positive edge');
assert.ok(Math.abs(sampleTargetHeightUm({ ...targetSpec, kind: 'sine' }, 2.5) - 23) < 1e-12, 'Sine reaches its positive amplitude at one quarter period');
assert.ok(Math.abs(sampleTargetHeightUm({ ...targetSpec, kind: 'sine' }, 7.5) + 17) < 1e-12, 'Sine reaches its negative amplitude at three quarters period');

const fixture = await readOptionalExampleFixtureOrExit('JPA_2026126953_Figure2_fiber_NA0p1.json');
const figure2 = fixture.configurations.configurations[0];
const routed = await runPortRoutedTrace(figure2, { samplePurpose: 'detector', renderRayLimit: 0 });
const measurement = routed.routeMetrics.find((route) => route.routeId === 'route-sc-measurement');
const reference = routed.routeMetrics.find((route) => route.routeId === 'route-sc-reference');
const routeSet = figure2.routeSets.find((set) => set.id === 'route-set-camera-80');
assert.ok(measurement?.valid && reference?.valid, 'both Figure 2 arms reach Camera 80');
const physicalSignedOpdMm = measurement.oplMm - reference.oplMm;
const calibratedOpdMm = physicalSignedOpdMm + Number(routeSet?.opdCalibrationMm ?? 0);
assert.ok(Math.abs(calibratedOpdMm) < 1e-9, 'Figure 2 explicit Route Set calibration matches the traced physical OPD');
assert.ok((routed.detectors[0]?.coherentModeCount ?? 0) > 0, 'Figure 2 contains wavelength modes shared by both routes');
assert.ok((routed.detectors[0]?.spectralFields.length ?? 0) > 0, 'Figure 2 preserves routed complex field samples');

const flatTargetConfig = structuredClone(figure2);
flatTargetConfig.blocks.find((block) => block.blockId === 'BroadbandSource-11').parameters.detectorSpatialSamples = 25;
Object.assign(flatTargetConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'flat', amplitudeUm: 0, offsetUm: 0,
});
const stepTargetConfig = structuredClone(flatTargetConfig);
Object.assign(stepTargetConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'step', amplitudeUm: 100, stepPositionMm: -100,
});
const flatTargetTrace = await runPortRoutedTrace(flatTargetConfig, {
  routeIds: ['route-sc-measurement'], samplePurpose: 'detector', spectralSamples: 1, renderRayLimit: 0,
});
const stepTargetTrace = await runPortRoutedTrace(stepTargetConfig, {
  routeIds: ['route-sc-measurement'], samplePurpose: 'detector', spectralSamples: 1, renderRayLimit: 0,
});
const targetOplShiftMm = stepTargetTrace.routeMetrics[0].oplMm - flatTargetTrace.routeMetrics[0].oplMm;
assert.ok(Math.abs(targetOplShiftMm) > 0.1, 'Target Step height changes the physical reflected route OPL');
assert.notDeepEqual(
  Array.from(stepTargetTrace.detectors[0].coherentReal),
  Array.from(flatTargetTrace.detectors[0].coherentReal),
  'Target Step height changes the Detector complex field',
);

const tiltTargetConfig = structuredClone(flatTargetConfig);
Object.assign(tiltTargetConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'tilt', amplitudeUm: 20, widthMm: 50,
});
const sineTargetConfig = structuredClone(flatTargetConfig);
Object.assign(sineTargetConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'sine', amplitudeUm: 20, periodMm: 10,
});
const tiltTargetTrace = await runPortRoutedTrace(tiltTargetConfig, {
  routeIds: ['route-sc-measurement'], samplePurpose: 'detector', spectralSamples: 1, renderRayLimit: 0,
});
const sineTargetTrace = await runPortRoutedTrace(sineTargetConfig, {
  routeIds: ['route-sc-measurement'], samplePurpose: 'detector', spectralSamples: 1, renderRayLimit: 0,
});
assert.ok(tiltTargetTrace.routeMetrics[0]?.valid && sineTargetTrace.routeMetrics[0]?.valid, 'Tilt and Sine Target routes reach the Detector');
assert.notDeepEqual(
  tiltTargetTrace.detectors[0].spectralFields.map((sample) => [sample.pixelX, sample.pixelY, sample.fieldRe, sample.fieldIm]),
  sineTargetTrace.detectors[0].spectralFields.map((sample) => [sample.pixelX, sample.pixelY, sample.fieldRe, sample.fieldIm]),
  'Tilt and Sine produce distinct Detector positions and phases',
);

console.log(JSON.stringify({
  constructivePowerW: constructive.signal.integratedPowerW,
  destructivePowerW: destructive.signal.integratedPowerW,
  illuminatedPixels: constructive.signal.powerWPerPixel.reduce((count, value) => count + Number(value > 0), 0),
  collapsedIlluminatedPixels: collapsedRoutes.signal.powerWPerPixel.reduce((count, value) => count + Number(value > 0), 0),
  oversampledIlluminatedPixels: oversampledSignal.signal.powerWPerPixel.reduce((count, value) => count + Number(value > 0), 0),
  interferingModeCount: constructive.interferingModeCount,
  figure2: {
    physicalSignedOpdMm,
    calibrationMm: routeSet.opdCalibrationMm,
    calibratedOpdMm,
    detectorHits: routed.detectors[0]?.hitCount ?? 0,
    coherentModeCount: routed.detectors[0]?.coherentModeCount ?? 0,
    targetStepOplShiftMm: targetOplShiftMm,
    targetTilt: {
      detectorHits: tiltTargetTrace.detectors[0]?.hitCount ?? 0,
      centroidXmm: tiltTargetTrace.routeMetrics[0]?.centroidXmm,
      oplMm: tiltTargetTrace.routeMetrics[0]?.oplMm,
    },
    targetSine: {
      detectorHits: sineTargetTrace.detectors[0]?.hitCount ?? 0,
      centroidXmm: sineTargetTrace.routeMetrics[0]?.centroidXmm,
      oplMm: sineTargetTrace.routeMetrics[0]?.oplMm,
    },
  },
}, null, 2));
