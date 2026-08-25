import assert from 'node:assert/strict';
import { createPatentFig2AssemblyDesign } from '../analysis/coherent-assembly.ts';
import { buildCoherentRenderConnectionOverlay } from '../analysis/coherent-render-connections.ts';

const sourceDesign = createPatentFig2AssemblyDesign();
const source = sourceDesign.components.find((component) => component.kind === 'source');
const splitter = sourceDesign.components.find((component) => component.kind === 'beam-splitter');
const detector = sourceDesign.components.find((component) => component.kind === 'detector');
const target = sourceDesign.components.find((component) => component.kind === 'target');
assert.ok(source && splitter && detector && target, 'fixture components are available');
const splitterWithUnusedPort = {
  ...splitter,
  ports: [
    { id: 'common', label: 'Common', localPositionMm: { x: 0, y: 0, z: -1 }, localDirection: { x: 0, y: 0, z: -1 } },
    { id: 'transmit', label: 'Transmit', localPositionMm: { x: 0, y: 0, z: 1 }, localDirection: { x: 0, y: 0, z: 1 } },
    { id: 'reflect', label: 'Reflect', localPositionMm: { x: 1, y: 0, z: 0 }, localDirection: { x: 1, y: 0, z: 0 } },
    { id: 'recombine', label: 'Recombine', localPositionMm: { x: -1, y: 0, z: 0 }, localDirection: { x: -1, y: 0, z: 0 } },
  ],
};

const design = {
  ...sourceDesign,
  components: [source, splitterWithUnusedPort, target, detector],
  connections: [
    {
      id: 'source-to-splitter', fromComponentId: source.id, fromPortId: 'out',
      toComponentId: splitter.id, toPortId: 'common', pathId: 'common',
    },
    {
      id: 'splitter-transmit', fromComponentId: splitter.id, fromPortId: 'transmit',
      toComponentId: detector.id, toPortId: 'detect', pathId: 'transmit',
    },
    {
      id: 'splitter-reflect', fromComponentId: splitter.id, fromPortId: 'reflect',
      toComponentId: target.id, toPortId: 'in', pathId: 'reflect',
    },
  ],
};

const overlay = buildCoherentRenderConnectionOverlay(design);
assert.equal(overlay.connections.length, 3, 'all valid connections are rendered');
assert.equal(overlay.connections.find((item) => item.id === 'splitter-transmit')?.tone, 'transmit');
assert.equal(overlay.connections.find((item) => item.id === 'splitter-reflect')?.tone, 'reflect');
assert.equal(overlay.connections.find((item) => item.id === 'source-to-splitter')?.reachesDetector, true, 'upstream detector path is highlighted');
assert.equal(overlay.connections.find((item) => item.id === 'splitter-transmit')?.toPortLabel, 'DET');
assert.ok(overlay.connections.every((item) => Number.isFinite(item.distanceMm)), 'all displayed distances are finite');
assert.ok(overlay.ports.some((port) => port.componentId === splitter.id && port.portId === 'recombine' && !port.connected), 'unused splitter ports remain visible as unconnected');

console.log(JSON.stringify({
  connections: overlay.connections.map(({ id, tone, distanceMm, reachesDetector }) => ({ id, tone, distanceMm, reachesDetector })),
  unconnectedPorts: overlay.ports.filter((port) => !port.connected).map((port) => port.id),
}, null, 2));
