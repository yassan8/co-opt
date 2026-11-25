import assert from 'node:assert/strict';
import * as THREE from 'three';

// Exercise the real Three.js overlay and its redraw listener without WebGL or
// persistent browser storage. No optical tracing or user configuration changes.
const events = new EventTarget();
const values = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
globalThis.dispatchEvent = events.dispatchEvent.bind(events);
globalThis.BroadcastChannel = undefined;
globalThis.HTMLCanvasElement = class {};
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {},
  querySelector() { return null; }, getElementById() { return null; },
  createElement(tag) {
    assert.equal(tag, 'canvas');
    return { width: 300, height: 150, getContext() { return null; } };
  },
};
const { createGenericCoherentAssemblyDesign } = await import('../analysis/coherent-assembly.ts');
const { drawNonSequentialOverlay, installNonSequentialRenderOverlay } = await import('../src/app/nonsequential-render-overlay.ts');

const makeComponent = (id, z, kind = 'sequential-group') => ({
  id, label: id, kind, shape: 'box', pathIds: ['main'],
  dimensions: { widthMm: 10, heightMm: 10, depthMm: 10 },
  transform: { positionMm: { x: 0, y: 0, z }, rotationDeg: { x: 0, y: 0, z: 0 } },
  ports: ['front', 'back'].map((port, i) => ({
    id: port, label: i ? 'Back' : 'Front',
    localPositionMm: { x: 0, y: 0, z: i * 10 },
    localDirection: { x: 0, y: 0, z: i ? 1 : -1 },
  })),
});
const design = { ...createGenericCoherentAssemblyDesign(), components: [makeComponent('lens', 0)], connections: [], portRoutes: [], blockSequences: [] };
const payload = { design, revision: 1, result: {
  segments: [{ rayId: 'ray1', startMm: { x: 0, y: 0, z: -10 }, endMm: { x: 0, y: 0, z: 40 }, wavelengthNm: 550, powerW: 1 }],
  energy: { emittedPowerW: 1 },
} };
const scene = new THREE.Scene();
globalThis.scene = scene;
const objects = (type) => {
  const found = [];
  scene.traverse((object) => { if (object.userData.type === type) found.push(object); });
  return found;
};
const labels = () => objects('designPortLabel').length + objects('opticalRoutePassLabel').length;

drawNonSequentialOverlay(scene, payload);
assert.equal(labels(), 0, 'ordinary sequential Front/Back labels default to hidden');
assert.equal(objects('nonSequentialRay').length, 1, 'rays remain drawn');
assert.equal(objects('designPortOverlay').length, 2, 'connection markers and hover targets remain available');
assert.ok(objects('designPortOverlay')[0].userData.tooltip.includes('FRONT'));
drawNonSequentialOverlay(scene, payload, { showLabels: true });
assert.equal(objects('designPortLabel').length, 2, 'explicit Labels enables unconnected Front/Back');
drawNonSequentialOverlay(scene, payload, { showLabels: false });
assert.equal(labels(), 0, 'redraw removes old labels');

design.components.push(makeComponent('next', 30));
design.connections = [{ id: 'link', fromComponentId: 'lens', fromPortId: 'back', toComponentId: 'next', toPortId: 'front', pathId: 'main', distanceMm: 20 }];
design.portRoutes = [{ id: 'route', enabled: true, steps: [{ connectionId: 'link', direction: 'forward' }, { connectionId: 'link', direction: 'reverse' }] }];
for (const zeroLength of [false, true]) {
  design.components[1] = makeComponent('next', zeroLength ? 10 : 30);
  drawNonSequentialOverlay(scene, payload, { selectedConnectionId: 'link', selectedRouteId: 'route', showLabels: false });
  assert.equal(labels(), 0, 'selected links and repeated route passes cannot bypass Labels off');
  assert.equal(objects('nonSequentialRay').length, 1);
  drawNonSequentialOverlay(scene, payload, { selectedConnectionId: 'link', selectedRouteId: 'route', showLabels: true });
  assert.equal(objects('designPortLabel').length, 4);
  assert.equal(objects('opticalRoutePassLabel').length, 1, 'route numbering follows Labels even at co-located ports');
}
drawNonSequentialOverlay(scene, payload, { showConnections: false, showLabels: true });
assert.equal(labels(), 0, 'Connections off takes precedence');
assert.equal(objects('designPortOverlay').length, 0);
assert.equal(objects('nonSequentialRay').length, 1);

// Reproduce the installed Render listener: initial load, option toggles, view
// redraw and late trace delivery must all respect the saved Labels preference.
const key = 'coopt.render.showDesignIntentLabels';
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const livePayload = { design: { ...design, components: [makeComponent('mirror', 0, 'mirror')], connections: [], portRoutes: [] }, revision: 2 };
let dispose = installNonSequentialRenderOverlay();
await tick();
const deliver = () => dispatchEvent(new CustomEvent('coopt:nonsequential-trace-updated', { detail: livePayload }));
for (const setting of [null, 'true', 'false', 'true', 'false']) {
  if (setting === null) values.delete(key); else values.set(key, setting);
  deliver();
  await tick();
  assert.equal(labels(), setting === 'true' ? 2 : 0, `late trace respects Labels=${setting}`);
  dispatchEvent(new Event('coopt:render-redraw-complete'));
  await tick();
  assert.equal(labels(), setting === 'true' ? 2 : 0, `view redraw respects Labels=${setting}`);
}
dispose();
values.set(key, 'true');
dispose = installNonSequentialRenderOverlay();
deliver();
await tick();
assert.equal(labels(), 2, 'reopening Render restores explicit Labels preference');
const readStorage = localStorage.getItem;
localStorage.getItem = () => { throw new Error('storage unavailable'); };
dispatchEvent(new Event('coopt:render-redraw-complete'));
await tick();
assert.equal(labels(), 0, 'storage failure safely hides labels');
localStorage.getItem = readStorage;
dispose();
assert.equal(scene.getObjectByName('coopt-non-sequential-assembly'), undefined, 'dispose removes overlay');
console.log('Render port-label visibility: all checks passed (default, toggles, selection, routes, redraw, reopen, storage failure).');
