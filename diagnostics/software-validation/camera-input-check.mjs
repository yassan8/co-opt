import assert from 'node:assert/strict';
import { createGenericCoherentAssemblyDesign, reconstructSurfaceFromDetectorSignal } from '../../analysis/coherent-assembly.ts';

// Generate the measurement independently; never call the application's Target
// or Camera forward simulator to generate the reference answer.
const width = 64, height = 128;
const flat = new Float64Array(width * height), measured = new Float64Array(width * height);
const shifts = Array.from({ length: width }, (_, x) => 3 * Math.sin(2 * Math.PI * x / (width - 1)));
const fringe = displacement => 1 + 0.8 * Math.exp(-0.5 * (displacement / 7) ** 2) * Math.cos(2 * Math.PI * 0.45 * displacement);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  flat[y * width + x] = fringe(y - height / 2);
  measured[y * width + x] = fringe(y - height / 2 - shifts[x]);
}
const generic = createGenericCoherentAssemblyDesign();
const options = {
  powerWPerPixel: measured, flatReferencePowerWPerPixel: flat, width, height,
  detector: { ...generic.detector, pixelCountX: width, pixelCountY: height, pixelPitchUm: 10 },
  grating: { ...generic.grating, grooveDensityLinesPerMm: 600, order: 1, allowedOrders: [1], detectorMagnification: 12.5 },
  sourceCenterWavelengthNm: 650, sourceBandwidthFwhmNm: 300, baseOpdMm: 10,
  targetSpanMm: 25, calibrationMinUm: -15, calibrationMaxUm: 15,
  maximumDetectorPixelsX: width, maximumDetectorPixelsY: height,
  spectralSampleCount: 129, measurementSampleCount: width * 128,
  targetXMinMm: -12.5, targetXMaxMm: 12.5,
};
const baseline = reconstructSurfaceFromDetectorSignal(options);
assert.equal(baseline.width, width);
assert.ok(baseline.flatReferenceApplied && baseline.signalCoverageFraction > 0.8);
assert.ok(baseline.recoveredHeightUm.every(Number.isFinite));
const variants = [
  { ...generic.target, kind: 'flat', offsetUm: 1234 },
  { ...generic.target, kind: 'sine', amplitudeUm: 200, periodMm: 0.13 },
  { ...generic.target, kind: 'tilt', tiltXDeg: 12 },
];
for (const comparisonTarget of variants) {
  const result = reconstructSurfaceFromDetectorSignal({ ...options, comparisonTarget });
  assert.deepEqual(result.recoveredHeightUm, baseline.recoveredHeightUm, 'Comparison-only Target leaked into recovered height');
  assert.deepEqual(result.detectedRidgeY, baseline.detectedRidgeY, 'Comparison Target changed the measured ridge');
}
const otherOpd = reconstructSurfaceFromDetectorSignal({ ...options, baseOpdMm: 20 });
assert.deepEqual(otherOpd.recoveredHeightUm, baseline.recoveredHeightUm, 'Absolute route OPL leaked into flat-referenced height');
const flatResult = reconstructSurfaceFromDetectorSignal({ ...options, powerWPerPixel: flat });
assert.ok(Math.max(...flatResult.recoveredHeightUm.map(Math.abs)) < 1e-8, 'Identical Camera captures must give zero differential height');
const inverted = new Float64Array(measured.length);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) inverted[y * width + x] = measured[y * width + width - 1 - x];
const invertedResult = reconstructSurfaceFromDetectorSignal({ ...options, powerWPerPixel: inverted });
assert.notDeepEqual(invertedResult.recoveredHeightUm, baseline.recoveredHeightUm, 'Reconstruction ignored the Camera measurement');
const dark = reconstructSurfaceFromDetectorSignal({ ...options, powerWPerPixel: new Float64Array(width * height) });
assert.equal(dark.signalCoverageFraction, 0, 'Zero Camera signal cannot count as measured coverage');
console.log(JSON.stringify({ ok: true, scope: 'Synthetic Camera input boundary, not end-to-end instrument reconstruction',
  profilePoints: baseline.width, coverage: baseline.signalCoverageFraction,
  independentOfComparisonTargets: variants.length, independentOfAbsoluteOpdWithFlatReference: true,
  identicalCaptureMaxHeightUm: Math.max(...flatResult.recoveredHeightUm.map(Math.abs)),
  darkCoverage: dark.signalCoverageFraction,
}, null, 2));
