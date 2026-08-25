import assert from 'node:assert/strict';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';
import { readOptionalExampleFixtureOrExit } from './optional-example-fixture.mjs';

const fixture = await readOptionalExampleFixtureOrExit('JPA_2026126953_Figure2_fiber_NA0p1.json');
const config = structuredClone(fixture.configurations.configurations[0]);

const measurement = await runPortRoutedTrace(config, {
  routeIds: ['route-sc-measurement'],
  spatialSamples: 9,
  spectralSamples: 1,
  renderRayLimit: 2000,
});
const edgeRay = measurement.segments.filter((segment) => segment.rayId === 0);
const ndSegments = edgeRay.filter((segment) => segment.sequence === 2 && segment.kind === 'component');
assert.equal(ndSegments.length, 1, 'ND filter has one physical in-substrate segment');
assert.ok(
  Math.abs(ndSegments[0].toMm.y) > 0.9,
  'ND filter preserves the ray height instead of snapping every ray to the port centre',
);

const expanderSegment = edgeRay.find((segment) => segment.sequence === 3 && segment.kind === 'exact-sequential');
assert.ok(expanderSegment, 'beam-expander Exact Sequential segment is rendered');
const transverseRadius = (point) => Math.hypot(point.y, point.z - 68);
const expanderInputRadius = transverseRadius(expanderSegment.fromMm);
const expanderOutputRadius = transverseRadius(expanderSegment.toMm);
assert.ok(
  expanderOutputRadius > expanderInputRadius * 10,
  `beam expander increases the edge-ray radius (${expanderInputRadius} -> ${expanderOutputRadius})`,
);

const reference = await runPortRoutedTrace(config, {
  routeIds: ['route-sc-reference'],
  spatialSamples: 1,
  spectralSamples: 1,
  renderRayLimit: 1000,
});
const cubeSegments = reference.segments.filter((segment) => segment.sequence === 4 && segment.kind === 'component');
assert.equal(cubeSegments.length, 2, 'cube BS renders entry-to-coating and coating-to-exit separately');
const vector = (segment) => ({
  x: segment.toMm.x - segment.fromMm.x,
  y: segment.toMm.y - segment.fromMm.y,
  z: segment.toMm.z - segment.fromMm.z,
});
const dot = (left, right) => left.x * right.x + left.y * right.y + left.z * right.z;
const norm = (value) => Math.hypot(value.x, value.y, value.z);
const cubeBefore = vector(cubeSegments[0]);
const cubeAfter = vector(cubeSegments[1]);
assert.ok(
  Math.abs(dot(cubeBefore, cubeAfter)) / (norm(cubeBefore) * norm(cubeAfter)) < 1e-9,
  'cube BS diagonal coating turns the reflected ray by 90 degrees',
);

const plateConfig = structuredClone(config);
const splitter = plateConfig.blocks.find((block) => block.blockId === 'BeamSplitter-24');
Object.assign(splitter.parameters, {
  beamSplitterModel: 'plate',
  depthMm: 3,
  substrateThicknessMm: 3,
});
const plate = await runPortRoutedTrace(plateConfig, {
  routeIds: ['route-sc-measurement'],
  spatialSamples: 1,
  spectralSamples: 1,
  renderRayLimit: 1000,
});
const plateTransmission = plate.segments.find((segment) => segment.sequence === 4 && segment.kind === 'component');
assert.ok(plateTransmission, 'plate BS renders propagation through its substrate');
assert.ok(
  Math.abs(plateTransmission.toMm.z - plateTransmission.fromMm.z) > 0.5,
  'plate BS transmission includes the refractive lateral displacement',
);

console.log(JSON.stringify({
  ndFilter: ndSegments[0],
  beamExpander: { inputRadiusMm: expanderInputRadius, outputRadiusMm: expanderOutputRadius },
  cubeBeamSplitter: cubeSegments,
  plateBeamSplitter: plateTransmission,
}, null, 2));
