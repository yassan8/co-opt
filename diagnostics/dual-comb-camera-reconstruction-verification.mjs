import assert from 'node:assert/strict';
import { reconstructDualCombSurfaceFromCamera } from '../analysis/dual-comb-camera-reconstruction.ts';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';
import { readOptionalExampleFixtureOrExit } from './optional-example-fixture.mjs';

const LIGHT_M_S = 299_792_458;
const TWO_PI = Math.PI * 2;
const width = 64;
const height = 16;
const lineCount = 33;
const targetSpanMm = 10;
const fields = [];

const complexField = (phaseRad) => ({ fieldRe: Math.cos(phaseRad), fieldIm: Math.sin(phaseRad) });
for (let pixelX = 0; pixelX < width; pixelX += 1) {
  const xMm = (pixelX / (width - 1) - 0.5) * targetSpanMm;
  const heightUm = 100 * Math.sin(TWO_PI * xMm / 5);
  const reflectedOpdM = heightUm * 2e-6;
  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const probeFrequencyHz = 193.4e12 + (lineIndex - (lineCount - 1) / 2) * 100e6;
    const loFrequencyHz = probeFrequencyHz + 10e3 + lineIndex * 1e3;
    const commonProbePhase = 0.17 * pixelX + 0.013 * lineIndex;
    const loPhase = -0.11 * pixelX + 0.021 * lineIndex;
    fields.push({
      routeId: 'measurement', sourceId: 'probe-comb', lineIndex, pixelX, pixelY: 7,
      coherenceGroupId: 'dual-comb', frequencyHz: probeFrequencyHz,
      wavelengthNm: LIGHT_M_S / probeFrequencyHz * 1e9,
      ...complexField(commonProbePhase + TWO_PI * probeFrequencyHz * reflectedOpdM / LIGHT_M_S),
    });
    fields.push({
      routeId: 'reference', sourceId: 'probe-comb', lineIndex, pixelX, pixelY: 7,
      coherenceGroupId: 'dual-comb', frequencyHz: probeFrequencyHz,
      wavelengthNm: LIGHT_M_S / probeFrequencyHz * 1e9,
      ...complexField(commonProbePhase),
    });
    fields.push({
      routeId: 'lo', sourceId: 'lo-comb', lineIndex, pixelX, pixelY: 7,
      coherenceGroupId: 'dual-comb', frequencyHz: loFrequencyHz,
      wavelengthNm: LIGHT_M_S / loFrequencyHz * 1e9,
      ...complexField(loPhase),
    });
  }
}

const reconstruct = (comparisonTarget, exposureTimeS = 1e-7) => reconstructDualCombSurfaceFromCamera({
  spectralFields: fields,
  detectorWidth: width,
  detectorHeight: height,
  targetSpanMm,
  measurementRouteId: 'measurement',
  referenceRouteId: 'reference',
  localOscillatorRouteId: 'lo',
  maximumProfilePoints: 256,
  exposureTimeS,
  comparisonTarget,
});

const sineTarget = {
  kind: 'sine', spanMm: targetSpanMm, offsetUm: 0, amplitudeUm: 100,
  periodMm: 5, stepPositionMm: 0,
};
const result = reconstruct(sineTarget);
assert.equal(result.width, width, 'one reconstructed sample per illuminated Camera-X pixel');
assert.equal(result.coverageFraction, 1, 'all Camera-X pixels have dual-comb phase');
assert.equal(result.meanLineCount, lineCount, 'all comb lines contribute to every Camera-X pixel');
assert.ok(result.rmsHeightErrorUm < 1e-6, `dual-comb height RMS error ${result.rmsHeightErrorUm} um`);
assert.ok(result.maxAbsHeightErrorUm < 1e-5, `dual-comb height maximum error ${result.maxAbsHeightErrorUm} um`);
assert.ok(result.meanPhaseFitRmsRad < 1e-9, `dual-comb phase fit RMS ${result.meanPhaseFitRmsRad} rad`);
assert.equal(result.timeIntegratedCamera, false, 'short Camera exposure preserves RF phase');

const wrongComparison = reconstruct({ ...sineTarget, kind: 'flat', offsetUm: 37, amplitudeUm: 0 });
assert.deepEqual(
  wrongComparison.recoveredHeightUm,
  result.recoveredHeightUm,
  'configured Target is comparison-only and cannot alter Camera-derived reconstruction',
);

const integrated = reconstruct(sineTarget, 1e-3);
assert.equal(integrated.timeIntegratedCamera, true, 'long Camera exposure is identified as RF phase-integrating');
assert.ok(
  integrated.warningMessages.some((warning) => warning.includes('single Camera frame loses their phase')),
  'UI warning explains that a time-integrated Camera image cannot recover dual-comb phase',
);

// A dense comb may contain a few wavelength/ray pairs whose micro-tilt
// calibration shift is almost zero. Those pairs must not dominate the
// Camera-shift slope inversion.
const robustCurrent = [];
const robustFlat = [];
const robustSlopeReference = [];
const robustWidth = 31;
const robustLineCount = 101;
const robustSpanMm = 20;
const robustSlopeGradient = 0.001;
for (let xIndex = 0; xIndex < robustWidth; xIndex += 1) {
  const xMm = (xIndex / (robustWidth - 1) - 0.5) * robustSpanMm;
  const surfaceGradient = 20 * TWO_PI / 20 * Math.cos(TWO_PI * xMm / 20) / 1000;
  const basePixelX = 600 + xIndex * 6;
  for (let lineIndex = 0; lineIndex < robustLineCount; lineIndex += 1) {
    const frequencyHz = 193.4e12 + (lineIndex - 50) * 100e6;
    const blindPosition = xIndex === Math.floor(robustWidth / 2);
    const nearlyStationary = lineIndex < 5 || blindPosition;
    const calibrationShiftPx = nearlyStationary ? 1e-4 : 4 + 0.05 * Math.sin(lineIndex);
    const cameraShiftPx = surfaceGradient / robustSlopeGradient * calibrationShiftPx
      + (lineIndex < 5 || blindPosition ? 50 : 0);
    const common = {
      lineIndex, targetXmm: xMm, pupilXmm: xMm, pupilYmm: 0,
      coherenceGroupId: 'robust-dual-comb', frequencyHz,
      wavelengthNm: LIGHT_M_S / frequencyHz * 1e9,
      fieldRe: 1, fieldIm: 0, pixelY: 8,
    };
    robustCurrent.push({ ...common, routeId: 'measurement', pixelX: basePixelX + cameraShiftPx });
    robustCurrent.push({ ...common, routeId: 'reference', pixelX: basePixelX });
    robustCurrent.push({ ...common, routeId: 'lo', pixelX: basePixelX });
    robustFlat.push({ ...common, routeId: 'measurement', pixelX: basePixelX });
    robustSlopeReference.push({ ...common, routeId: 'measurement', pixelX: basePixelX + calibrationShiftPx });
  }
}
const robustSlopeResult = reconstructDualCombSurfaceFromCamera({
  spectralFields: robustCurrent,
  flatReferenceSpectralFields: robustFlat,
  slopeReferenceSpectralFields: robustSlopeReference,
  slopeReferenceGradient: robustSlopeGradient,
  detectorWidth: 2048,
  detectorHeight: 32,
  targetSpanMm: robustSpanMm,
  measurementRouteId: 'measurement',
  referenceRouteId: 'reference',
  localOscillatorRouteId: 'lo',
  maximumProfilePoints: 64,
  exposureTimeS: 0,
  comparisonTarget: { kind: 'sine', spanMm: robustSpanMm, offsetUm: 0, amplitudeUm: 20, periodMm: 20, stepPositionMm: 0 },
});
assert.equal(robustSlopeResult.reconstructionMethod, 'camera-slope', 'dense-comb Sine uses Camera slope calibration');
assert.ok(robustSlopeResult.rmsHeightErrorUm < 0.3, `dense-comb slope RMS error ${robustSlopeResult.rmsHeightErrorUm} um`);
assert.ok(robustSlopeResult.maxAbsHeightErrorUm < 0.6, `dense-comb slope maximum error ${robustSlopeResult.maxAbsHeightErrorUm} um`);

const fixture = await readOptionalExampleFixtureOrExit('JPA_2026126953_Figure2_fiber_NA0p1.json');
const configuredCameraConfig = fixture.configurations.configurations[1];
const flatCameraConfig = structuredClone(configuredCameraConfig);
Object.assign(flatCameraConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'flat', offsetUm: 0, amplitudeUm: 0,
});
const detectorBlock = configuredCameraConfig.blocks.find((block) => block.blockId === 'AreaDetector-80');
assert.equal(detectorBlock?.blockType, 'AreaDetector', 'Dual-comb Figure 2 uses a spatial phase Camera');
const configuredLineCount = configuredCameraConfig.blocks.find((block) => block.blockId === 'FrequencyCombSource-Probe')?.parameters?.lineCount;
const configuredLineTrace = await runPortRoutedTrace(configuredCameraConfig, {
  samplePurpose: 'detector', spatialSamples: 1, renderRayLimit: 0, spectralFieldsOnly: true,
});
const configuredLineDetector = configuredLineTrace.detectors.find((detector) => detector.detectorId === 'AreaDetector-80');
assert.equal(configuredLineDetector?.intensityW.length, 0, 'Flat-reference tracing can omit dense Camera image buffers');
const configuredMeasurementRouteId = flatCameraConfig.routeSets.find((entry) => entry.id === 'route-set-dual-comb-80')?.measurementRouteId;
const tracedConfiguredLines = new Set((configuredLineDetector?.spectralFields ?? [])
  .filter((field) => field.routeId === configuredMeasurementRouteId)
  .map((field) => field.lineIndex));
assert.equal(tracedConfiguredLines.size, configuredLineCount, 'Full Detector trace uses configured comb lineCount instead of the generic spectral sample fallback');
const stepCameraConfig = structuredClone(flatCameraConfig);
Object.assign(stepCameraConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'step', offsetUm: 0, amplitudeUm: 100, stepPositionMm: 0,
});
const tiltCameraConfig = structuredClone(flatCameraConfig);
Object.assign(tiltCameraConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'tilt', offsetUm: 0, amplitudeUm: 20,
});
const sineCameraConfig = structuredClone(flatCameraConfig);
Object.assign(sineCameraConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'sine', offsetUm: 0, amplitudeUm: 10, periodMm: 20,
});
const slopeReferenceGradient = 0.001;
const slopeReferenceCameraConfig = structuredClone(flatCameraConfig);
Object.assign(slopeReferenceCameraConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'tilt', offsetUm: 0, amplitudeUm: slopeReferenceGradient * 50 * 0.5 * 1000,
});
const physicalTraceOptions = {
  samplePurpose: 'detector', spatialSamples: 49, spectralSamples: 21, renderRayLimit: 0, spectralFieldsOnly: true,
};
const [flatCameraTrace, stepCameraTrace, tiltCameraTrace, sineCameraTrace, slopeReferenceCameraTrace] = await Promise.all([
  runPortRoutedTrace(flatCameraConfig, physicalTraceOptions),
  runPortRoutedTrace(stepCameraConfig, physicalTraceOptions),
  runPortRoutedTrace(tiltCameraConfig, physicalTraceOptions),
  runPortRoutedTrace(sineCameraConfig, physicalTraceOptions),
  runPortRoutedTrace(slopeReferenceCameraConfig, physicalTraceOptions),
]);
assert.ok(stepCameraTrace.routeMetrics.every((route) => route.valid), 'Probe measurement, Probe reference and LO all reach Camera 80');
const physicalDetector = stepCameraTrace.detectors.find((detector) => detector.detectorId === 'AreaDetector-80');
const flatPhysicalDetector = flatCameraTrace.detectors.find((detector) => detector.detectorId === 'AreaDetector-80');
assert.ok(physicalDetector && flatPhysicalDetector, 'current and flat-reference Camera RF fields are available');
const routeSet = stepCameraConfig.routeSets.find((entry) => entry.id === 'route-set-dual-comb-80');
const reconstructPhysicalProfile = (trace, comparisonTarget) => {
  const detector = trace.detectors.find((entry) => entry.detectorId === 'AreaDetector-80');
  assert.ok(detector, `Camera trace is available for ${comparisonTarget.kind}`);
  return reconstructDualCombSurfaceFromCamera({
  spectralFields: detector.spectralFields,
  flatReferenceSpectralFields: flatPhysicalDetector.spectralFields,
  slopeReferenceSpectralFields: slopeReferenceCameraTrace.detectors.find((entry) => entry.detectorId === 'AreaDetector-80').spectralFields,
  slopeReferenceGradient,
  detectorWidth: detector.width,
  detectorHeight: detector.height,
  targetSpanMm: 50,
  measurementRouteId: routeSet.measurementRouteId,
  referenceRouteId: routeSet.referenceRouteId,
  localOscillatorRouteId: 'route-dual-local-oscillator',
  maximumProfilePoints: 128,
  exposureTimeS: 0,
  comparisonTarget,
});
};
const physicalStep = reconstructPhysicalProfile(stepCameraTrace, { kind: 'step', spanMm: 50, offsetUm: 0, amplitudeUm: 100, periodMm: 20, stepPositionMm: 0 });
const physicalTilt = reconstructPhysicalProfile(tiltCameraTrace, { kind: 'tilt', spanMm: 50, offsetUm: 0, amplitudeUm: 20, periodMm: 20, stepPositionMm: 0 });
const physicalSine = reconstructPhysicalProfile(sineCameraTrace, { kind: 'sine', spanMm: 50, offsetUm: 0, amplitudeUm: 10, periodMm: 20, stepPositionMm: 0 });
assert.equal(physicalStep.flatReferenceApplied, true, 'flat Camera RF acquisition removes fixed system phase');
assert.equal(physicalStep.reconstructionMethod, 'rf-opd', 'discontinuous Step remains an RF-OPD reconstruction');
assert.equal(physicalStep.coverageFraction, 1, 'all illuminated Target-X samples recover a dual-comb delay');
assert.equal(physicalStep.meanLineCount, 21, 'all traced comb lines contribute to the physical Camera profile');
assert.ok(physicalStep.rmsHeightErrorUm < 0.5, `physical Camera step RMS error ${physicalStep.rmsHeightErrorUm} um`);
assert.ok(physicalStep.maxAbsHeightErrorUm < 1, `physical Camera step maximum error ${physicalStep.maxAbsHeightErrorUm} um`);
assert.equal(physicalTilt.reconstructionMethod, 'camera-slope', 'Tilt uses the micro-tilt Camera calibration');
assert.ok(physicalTilt.rmsHeightErrorUm < 0.01, `physical Camera tilt RMS error ${physicalTilt.rmsHeightErrorUm} um`);
assert.ok(physicalTilt.maxAbsHeightErrorUm < 0.02, `physical Camera tilt maximum error ${physicalTilt.maxAbsHeightErrorUm} um`);
assert.equal(physicalSine.reconstructionMethod, 'camera-slope', 'Sine uses the micro-tilt Camera calibration');
assert.ok(physicalSine.rmsHeightErrorUm < 0.05, `physical Camera sine RMS error ${physicalSine.rmsHeightErrorUm} um`);
assert.ok(physicalSine.maxAbsHeightErrorUm < 0.1, `physical Camera sine maximum error ${physicalSine.maxAbsHeightErrorUm} um`);

const verifiedSineFixture = fixture;
assert.equal(verifiedSineFixture.configurations.activeConfigId, 2, 'verified Sine example opens on the Dual-comb configuration');
const verifiedSineConfig = verifiedSineFixture.configurations.configurations
  .find((configuration) => configuration.id === verifiedSineFixture.configurations.activeConfigId);
assert.ok(verifiedSineConfig, 'verified Sine example contains its active configuration');
const verifiedTarget = verifiedSineConfig.blocks.find((block) => block.blockId === 'Target-100');
assert.equal(verifiedTarget?.parameters?.profile, 'sine', 'verified example opens with a Sine Target');
const verifiedRouteSet = verifiedSineConfig.routeSets.find((entry) => entry.id === 'route-set-dual-comb-80');
assert.ok(verifiedRouteSet, 'verified example contains its Detector route set');
const verifiedFlatConfig = structuredClone(verifiedSineConfig);
Object.assign(verifiedFlatConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'flat', offsetUm: 0, amplitudeUm: 0,
});
const verifiedCalibrationGradients = [-0.08, -0.06, -0.04, -0.02, -0.01, 0.01, 0.02, 0.04, 0.06, 0.08];
const verifiedHeightOffsetsUm = [-20, 20];
const verifiedSlopeCases = verifiedCalibrationGradients.flatMap((gradient) => (
  verifiedHeightOffsetsUm.map((offsetUm) => ({ gradient, offsetUm }))
));
const verifiedSlopeConfigs = verifiedSlopeCases.map(({ gradient, offsetUm }) => {
  const config = structuredClone(verifiedFlatConfig);
  Object.assign(config.blocks.find((block) => block.blockId === 'Target-100').parameters, {
    profile: 'tilt', offsetUm, amplitudeUm: gradient * 50 * 0.5 * 1000,
  });
  return config;
});
const verifiedHeightConfigs = verifiedHeightOffsetsUm.map((offsetUm) => {
  const config = structuredClone(verifiedFlatConfig);
  Object.assign(config.blocks.find((block) => block.blockId === 'Target-100').parameters, {
    profile: 'flat', offsetUm, amplitudeUm: 0,
  });
  return config;
});
const verifiedUiTraceOptions = {
  samplePurpose: 'detector', renderRayLimit: 0, spectralFieldsOnly: true,
};
const verifiedReferenceTraceOptions = {
  ...verifiedUiTraceOptions,
  routeIds: [verifiedRouteSet.measurementRouteId],
};
const verifiedSineTrace = await runPortRoutedTrace(verifiedSineConfig, verifiedUiTraceOptions);
const verifiedShallowTiltConfig = structuredClone(verifiedSineConfig);
Object.assign(verifiedShallowTiltConfig.blocks.find((block) => block.blockId === 'Target-100').parameters, {
  profile: 'tilt', offsetUm: 0, amplitudeUm: 10,
});
const verifiedShallowTiltTrace = await runPortRoutedTrace(verifiedShallowTiltConfig, verifiedUiTraceOptions);
const verifiedFlatTrace = await runPortRoutedTrace(verifiedFlatConfig, verifiedReferenceTraceOptions);
const verifiedSlopeTraces = [];
for (const config of verifiedSlopeConfigs) {
  verifiedSlopeTraces.push(await runPortRoutedTrace(config, verifiedReferenceTraceOptions));
}
const verifiedHeightTraces = [];
for (const config of verifiedHeightConfigs) {
  verifiedHeightTraces.push(await runPortRoutedTrace(config, verifiedReferenceTraceOptions));
}
assert.ok(verifiedSineTrace.routeMetrics.every((route) => route.valid), 'verified Sine example routes all three fields to Camera 80');
const verifiedDetector = verifiedSineTrace.detectors.find((entry) => entry.detectorId === 'AreaDetector-80');
const verifiedFlatDetector = verifiedFlatTrace.detectors.find((entry) => entry.detectorId === 'AreaDetector-80');
assert.ok(verifiedDetector && verifiedFlatDetector, 'verified Sine Camera data and routes are complete');
const verifiedExampleResult = reconstructDualCombSurfaceFromCamera({
  spectralFields: verifiedDetector.spectralFields,
  flatReferenceSpectralFields: verifiedFlatDetector.spectralFields,
  slopeCalibrationReferences: verifiedSlopeTraces.map((trace, index) => ({
    gradient: verifiedSlopeCases[index].gradient,
    offsetUm: verifiedSlopeCases[index].offsetUm,
    spectralFields: trace.detectors.find((entry) => entry.detectorId === 'AreaDetector-80')?.spectralFields ?? [],
  })),
  heightCalibrationReferences: verifiedHeightTraces.map((trace, index) => ({
    offsetUm: verifiedHeightOffsetsUm[index],
    spectralFields: trace.detectors.find((entry) => entry.detectorId === 'AreaDetector-80')?.spectralFields ?? [],
  })),
  detectorWidth: verifiedDetector.width,
  detectorHeight: verifiedDetector.height,
  targetSpanMm: 50,
  measurementRouteId: verifiedRouteSet.measurementRouteId,
  referenceRouteId: verifiedRouteSet.referenceRouteId,
  localOscillatorRouteId: 'route-dual-local-oscillator',
  maximumProfilePoints: 512,
  exposureTimeS: verifiedTarget.parameters.exposureTimeS ?? 0.000002,
  comparisonTarget: {
    kind: 'sine', spanMm: 50, offsetUm: 0,
    amplitudeUm: Number(verifiedTarget.parameters.amplitudeUm),
    periodMm: Number(verifiedTarget.parameters.periodMm),
    stepPositionMm: 0,
  },
});
const verifiedShallowTiltDetector = verifiedShallowTiltTrace.detectors.find((entry) => entry.detectorId === 'AreaDetector-80');
assert.ok(verifiedShallowTiltDetector, 'verified shallow-Tilt Camera data reaches Camera 80');
const verifiedShallowTiltResult = reconstructDualCombSurfaceFromCamera({
  spectralFields: verifiedShallowTiltDetector.spectralFields,
  flatReferenceSpectralFields: verifiedFlatDetector.spectralFields,
  slopeCalibrationReferences: verifiedSlopeTraces.map((trace, index) => ({
    gradient: verifiedSlopeCases[index].gradient,
    offsetUm: verifiedSlopeCases[index].offsetUm,
    spectralFields: trace.detectors.find((entry) => entry.detectorId === 'AreaDetector-80')?.spectralFields ?? [],
  })),
  heightCalibrationReferences: verifiedHeightTraces.map((trace, index) => ({
    offsetUm: verifiedHeightOffsetsUm[index],
    spectralFields: trace.detectors.find((entry) => entry.detectorId === 'AreaDetector-80')?.spectralFields ?? [],
  })),
  detectorWidth: verifiedShallowTiltDetector.width,
  detectorHeight: verifiedShallowTiltDetector.height,
  targetSpanMm: 50,
  measurementRouteId: verifiedRouteSet.measurementRouteId,
  referenceRouteId: verifiedRouteSet.referenceRouteId,
  localOscillatorRouteId: 'route-dual-local-oscillator',
  maximumProfilePoints: 512,
  exposureTimeS: verifiedTarget.parameters.exposureTimeS ?? 0.000002,
  comparisonTarget: {
    kind: 'tilt', spanMm: 50, offsetUm: 0, amplitudeUm: 10,
    periodMm: 1, stepPositionMm: 0,
  },
});
assert.equal(verifiedExampleResult.reconstructionMethod, 'camera-slope', 'verified example uses Camera slope reconstruction');
assert.ok(verifiedExampleResult.rmsHeightErrorUm < 0.75, `verified example Sine RMS error ${verifiedExampleResult.rmsHeightErrorUm} um`);
assert.ok(verifiedExampleResult.maxAbsHeightErrorUm < 2, `verified example Sine maximum error ${verifiedExampleResult.maxAbsHeightErrorUm} um`);
assert.equal(verifiedShallowTiltResult.reconstructionMethod, 'camera-slope', 'verified shallow Tilt uses Camera slope reconstruction');
assert.ok(verifiedShallowTiltResult.rmsHeightErrorUm < 0.1, `verified shallow Tilt RMS error ${verifiedShallowTiltResult.rmsHeightErrorUm} um`);
assert.ok(verifiedShallowTiltResult.maxAbsHeightErrorUm < 0.25, `verified shallow Tilt maximum error ${verifiedShallowTiltResult.maxAbsHeightErrorUm} um`);
const wrongPhysicalComparison = reconstructDualCombSurfaceFromCamera({
  spectralFields: physicalDetector.spectralFields,
  flatReferenceSpectralFields: flatPhysicalDetector.spectralFields,
  detectorWidth: physicalDetector.width,
  detectorHeight: physicalDetector.height,
  targetSpanMm: 50,
  measurementRouteId: routeSet.measurementRouteId,
  referenceRouteId: routeSet.referenceRouteId,
  localOscillatorRouteId: 'route-dual-local-oscillator',
  comparisonTarget: { kind: 'flat', spanMm: 50, offsetUm: 37, amplitudeUm: 0, periodMm: 20, stepPositionMm: 0 },
});
assert.deepEqual(wrongPhysicalComparison.recoveredHeightUm, physicalStep.recoveredHeightUm, 'physical recovery is independent of configured comparison Target');

console.log(JSON.stringify({
  checks: 44,
  width: result.width,
  combLinesPerPixel: result.meanLineCount,
  rmsHeightErrorUm: result.rmsHeightErrorUm,
  maxAbsHeightErrorUm: result.maxAbsHeightErrorUm,
  phaseFitRmsRad: result.meanPhaseFitRmsRad,
  maximumBeatFrequencyHz: result.maximumBeatFrequencyHz,
  robustDenseCombSine: {
    rmsHeightErrorUm: robustSlopeResult.rmsHeightErrorUm,
    maxAbsHeightErrorUm: robustSlopeResult.maxAbsHeightErrorUm,
  },
  physicalCameraStep: {
    points: physicalStep.width,
    axis: physicalStep.profileAxis,
    rmsHeightErrorUm: physicalStep.rmsHeightErrorUm,
    maxAbsHeightErrorUm: physicalStep.maxAbsHeightErrorUm,
    recoveredHeightUm: physicalStep.recoveredHeightUm,
  },
  physicalCameraTilt: {
    rmsHeightErrorUm: physicalTilt.rmsHeightErrorUm,
    maxAbsHeightErrorUm: physicalTilt.maxAbsHeightErrorUm,
    method: physicalTilt.reconstructionMethod,
  },
  physicalCameraSine: {
    rmsHeightErrorUm: physicalSine.rmsHeightErrorUm,
    maxAbsHeightErrorUm: physicalSine.maxAbsHeightErrorUm,
    method: physicalSine.reconstructionMethod,
  },
  verifiedExampleSine: {
    points: verifiedExampleResult.width,
    rmsHeightErrorUm: verifiedExampleResult.rmsHeightErrorUm,
    maxAbsHeightErrorUm: verifiedExampleResult.maxAbsHeightErrorUm,
    method: verifiedExampleResult.reconstructionMethod,
  },
  verifiedExampleShallowTilt: {
    points: verifiedShallowTiltResult.width,
    recoveredPeakToValleyUm: verifiedShallowTiltResult.slopeCandidatePeakToValleyUm,
    meanCameraShiftPx: verifiedShallowTiltResult.meanCameraShiftPx,
    rmsHeightErrorUm: verifiedShallowTiltResult.rmsHeightErrorUm,
    maxAbsHeightErrorUm: verifiedShallowTiltResult.maxAbsHeightErrorUm,
    method: verifiedShallowTiltResult.reconstructionMethod,
  },
}, null, 2));
