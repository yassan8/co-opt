import assert from 'node:assert/strict';
import {
  createGenericCoherentAssemblyDesign,
  normalizeCoherentAssemblyDesign,
  simulateCoherentSurfaceSignal,
} from '../analysis/coherent-assembly.ts';

const empty = createGenericCoherentAssemblyDesign();
assert.equal(empty.preset, 'custom-hybrid', 'fallback is an authored custom assembly');
assert.deepEqual(empty.components, [], 'fallback embeds no physical instrument layout');
assert.deepEqual(empty.connections, [], 'fallback embeds no instrument connections');
assert.deepEqual(empty.paths, [], 'fallback embeds no optical routes');

const design = normalizeCoherentAssemblyDesign({
  ...empty,
  sources: [],
  detectors: [],
  source: {
    ...empty.source,
    centerWavelengthNm: 550,
    bandwidthFwhmNm: 80,
    spectralSamples: 33,
    totalPowerW: 0.001,
  },
  detector: {
    ...empty.detector,
    pixelCountX: 32,
    pixelCountY: 64,
    pixelPitchUm: 10,
    calibrationMinUm: -100,
    calibrationMaxUm: 100,
  },
  grating: {
    ...empty.grating,
    grooveDensityLinesPerMm: 600,
    order: 1,
    allowedOrders: [1],
    efficiency: 0.8,
  },
  target: {
    ...empty.target,
    kind: 'flat',
    spanMm: 10,
  },
});

const result = simulateCoherentSurfaceSignal(design, {
  baseOpdMm: 0,
  maximumDetectorPixelsX: 32,
  maximumDetectorPixelsY: 64,
  minimumBroadbandSpectralSamples: 33,
});
assert.equal(result.width, 32, 'configured detector width is used');
assert.equal(result.height, 64, 'configured detector height is used');
assert.equal(result.intensityWPerPixel.length, 32 * 64, 'detector raster is complete');
assert.ok(result.propagatingFraction > 0, 'configured grating has propagating spectral samples');
assert.ok(Number.isFinite(result.integratedPowerW), 'coherent detector power is finite');

console.log(JSON.stringify({
  preset: empty.preset,
  embeddedComponents: empty.components.length,
  detector: [result.width, result.height],
  propagatingFraction: result.propagatingFraction,
}, null, 2));
