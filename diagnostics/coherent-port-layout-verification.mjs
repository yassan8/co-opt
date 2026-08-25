import assert from 'node:assert/strict';
import {
  createPatentFig2AssemblyDesign,
  evaluateCoherentAssembly,
  resolveComponentTransform,
} from '../analysis/coherent-assembly.ts';
import {
  getConnectionLayoutParameters,
  initializeCoherentPortConnections,
  patchConnectionLayout,
  reflowCoherentAssembly,
  worldPortDirection,
  worldPortPosition,
} from '../analysis/coherent-port-layout.ts';
import { evaluateOpticalPathClearance } from '../analysis/coherent-clearance.ts';

const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
const position = (design, id) => resolveComponentTransform(design.components.find((component) => component.id === id)).positionMm;

const original = createPatentFig2AssemblyDesign();
const initialized = initializeCoherentPortConnections(original);
assert.ok(initialized.connections.every((connection) => Number.isFinite(connection.distanceMm)), 'all connections have port distance metadata');
assert.ok(initialized.connections.every((connection) => connection.fromPortId && connection.toPortId), 'all connections name both optical ports');

const firstReflow = reflowCoherentAssembly(initialized);
for (const component of original.components) {
  const before = position(original, component.id);
  const after = position(firstReflow, component.id);
  close(after.x, before.x, 1e-9, `${component.id} initial reflow X`);
  close(after.y, before.y, 1e-9, `${component.id} initial reflow Y`);
  close(after.z, before.z, 1e-9, `${component.id} initial reflow Z`);
}

const sourceMoved = structuredClone(initialized);
sourceMoved.components.find((component) => component.id === 'source-11').manualOffset.positionMm.x = 5;
const followed = reflowCoherentAssembly(sourceMoved);
for (const id of ['beam-splitter-24', 'target-100', 'grating-70', 'detector-80']) {
  close(position(followed, id).x, position(initialized, id).x + 5, 1e-9, `${id} follows upstream source move`);
}

const objectConnection = initialized.connections.find((connection) => connection.pathId === 'object');
const objectParameters = getConnectionLayoutParameters(initialized, objectConnection);
const longerObject = patchConnectionLayout(initialized, objectConnection.id, { distanceMm: objectParameters.distanceMm + 10 });
close(evaluateCoherentAssembly(longerObject).opticalPathDifferenceMm - evaluateCoherentAssembly(initialized).opticalPathDifferenceMm, 20, 1e-8, '10 mm object-arm extension creates 20 mm round-trip OPD change');
close(position(longerObject, 'target-100').x, position(initialized, 'target-100').x + 10, 1e-8, 'object arm downstream target follows distance extension');

const rotatedObject = patchConnectionLayout(initialized, objectConnection.id, { azimuthDeg: 35 });
const baseVolume = evaluateCoherentAssembly(initialized).opticalVolumeMm3;
const rotatedVolume = evaluateCoherentAssembly(rotatedObject).opticalVolumeMm3;
close(rotatedVolume, baseVolume, 1e-6, 'fold angle changes placement but not component solid volume');
assert.ok(Math.abs(position(rotatedObject, 'target-100').z - position(initialized, 'target-100').z) > 5, 'fold angle moves downstream arm in world Z');
const rotatedFrom = rotatedObject.components.find((component) => component.id === objectConnection.fromComponentId);
const rotatedTo = rotatedObject.components.find((component) => component.id === objectConnection.toComponentId);
const fromPort = worldPortPosition(rotatedFrom, objectConnection.fromPortId, 'from');
const toPort = worldPortPosition(rotatedTo, objectConnection.toPortId, 'to');
const distance = Math.hypot(toPort.x - fromPort.x, toPort.y - fromPort.y, toPort.z - fromPort.z) || 1;
const travel = { x: (toPort.x - fromPort.x) / distance, y: (toPort.y - fromPort.y) / distance, z: (toPort.z - fromPort.z) / distance };
const inputNormal = worldPortDirection(rotatedTo, objectConnection.toPortId, 'to');
close(travel.x * inputNormal.x + travel.y * inputNormal.y + travel.z * inputNormal.z, -1, 1e-9, 'auto-placed input face opposes the incoming optical path');

assert.equal(evaluateOpticalPathClearance(initialized).length, 0, 'preset beam segments clear non-endpoint mechanical envelopes');
const obstructed = structuredClone(initialized);
obstructed.components.find((component) => component.id === 'detector-80').autoTransform.positionMm = { x: 210, y: 0, z: -250 };
assert.ok(
  evaluateOpticalPathClearance(obstructed).some((item) => item.pathId === 'object' && item.componentId === 'detector-80'),
  'beam segment crossing a foreign mechanical envelope is reported',
);
console.log(JSON.stringify({
  ok: true,
  connectionCount: initialized.connections.length,
  objectConnection: objectParameters,
  sourceMoveFollowedMm: 5,
  objectRoundTripOpdChangeMm: evaluateCoherentAssembly(longerObject).opticalPathDifferenceMm - evaluateCoherentAssembly(initialized).opticalPathDifferenceMm,
}, null, 2));
