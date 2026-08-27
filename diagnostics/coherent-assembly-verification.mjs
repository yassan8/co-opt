import assert from 'node:assert/strict';
import {
  createGenericCoherentAssemblyDesign,
  normalizeCoherentAssemblyDesign,
  simulateCoherentSurfaceSignal,
} from '../analysis/coherent-assembly.ts';
import { reflowCoherentAssembly } from '../analysis/coherent-port-layout.ts';

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

const placementFixture = normalizeCoherentAssemblyDesign({
  ...empty,
  components: [
    {
      id: 'source', label: 'Source', kind: 'source', shape: 'box',
      autoTransform: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
      manualOffset: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
      dimensions: { widthMm: 1, heightMm: 1, depthMm: 1 }, dimensionConfidence: 'Exact', pathIds: ['path'],
      ports: [{ id: 'out', label: 'Out', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: 1, y: 0, z: 0 } }],
    },
    {
      id: 'detector', label: 'Detector', kind: 'detector', shape: 'box',
      autoTransform: { positionMm: { x: 2, y: 3, z: 4 }, rotationDeg: { x: 0, y: 0, z: 0 } },
      manualOffset: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
      dimensions: { widthMm: 1, heightMm: 1, depthMm: 1 }, dimensionConfidence: 'Exact', pathIds: ['path'],
      ports: [{ id: 'in', label: 'In', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: -1, y: 0, z: 0 } }],
    },
  ],
  connections: [{
    id: 'link', fromComponentId: 'source', toComponentId: 'detector', pathId: 'path',
    fromPortId: 'out', toPortId: 'in', distanceMm: 10, azimuthDeg: 90, elevationDeg: 0, autoPlace: true,
  }],
});
const autoPlaced = reflowCoherentAssembly(placementFixture);
const autoDetector = autoPlaced.components.find((component) => component.id === 'detector');
assert.ok(autoDetector, 'auto-place detector exists');
assert.ok(Math.abs(autoDetector.autoTransform.positionMm.x) < 1e-9, '90 degree azimuth removes X displacement');
assert.ok(Math.abs(autoDetector.autoTransform.positionMm.z - 10) < 1e-9, '90 degree azimuth moves the detector along Z');

const fixedPlacement = reflowCoherentAssembly({
  ...placementFixture,
  connections: placementFixture.connections.map((connection) => ({ ...connection, autoPlace: false, azimuthDeg: 0 })),
});
const fixedDetector = fixedPlacement.components.find((component) => component.id === 'detector');
assert.deepEqual(fixedDetector?.autoTransform.positionMm, { x: 2, y: 3, z: 4 }, 'fixed placement ignores connection geometry');

console.log(JSON.stringify({
  preset: empty.preset,
  embeddedComponents: empty.components.length,
  detector: [result.width, result.height],
  propagatingFraction: result.propagatingFraction,
  autoPlacement: autoDetector.autoTransform.positionMm,
}, null, 2));
