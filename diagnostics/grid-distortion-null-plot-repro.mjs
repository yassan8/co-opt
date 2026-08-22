import assert from 'node:assert/strict';

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const calls = [];
const target = {
  ownerDocument: {
    defaultView: {
      Plotly: { newPlot: (...args) => calls.push(args) },
    },
  },
};

const { plotGridDistortion } = await import('../evaluation/aberrations/distortion-plot.ts');
const axis = [-1, 0, 1];
const idealX = [];
const idealY = [];
for (const y of axis) {
  for (const x of axis) {
    idealX.push(x);
    idealY.push(y);
  }
}
const realX = idealX.map((x) => x * 0.9);
const realY = idealY.map((y) => y * 0.9);
realX[0] = null;
realY[0] = null;

await plotGridDistortion({
  idealGrid: { x: idealX, y: idealY },
  realGrid: { x: realX, y: realY },
  gridSize: 3,
  maxFieldAngle: 20,
  meta: { wavelength: 0.5875618, requestedGridSize: 2 },
}, target, null, { enlargementFactor: 1 });

assert.equal(calls.length, 1, 'Plotly should render exactly once');
const traces = calls[0][1];
const distortedTraces = traces.filter((trace) => trace.line?.color === '#ff0000');
assert.equal(distortedTraces.length, 6, 'three distorted rows plus three distorted columns');
assert.equal(distortedTraces[0].x[0], null, 'missing X must remain a line break');
assert.equal(distortedTraces[0].y[0], null, 'missing Y must remain a line break');
assert.equal(distortedTraces[3].x[0], null, 'column mesh must preserve missing X');
assert.equal(distortedTraces[3].y[0], null, 'column mesh must preserve missing Y');
assert.equal(distortedTraces[0].connectgaps, false);
const unreachedTrace = traces.find((trace) => String(trace.name || '').startsWith('Unreached field'));
assert.ok(unreachedTrace, 'unreached fields must have a dedicated marker trace');
assert.deepEqual(unreachedTrace.x, [-1]);
assert.deepEqual(unreachedTrace.y, [-1]);
assert.equal(unreachedTrace.marker?.symbol, 'x');

console.log(JSON.stringify({
  ok: true,
  missingPoint: { x: distortedTraces[0].x[0], y: distortedTraces[0].y[0] },
  connectGaps: distortedTraces[0].connectgaps,
  distortedMeshTraceCount: distortedTraces.length,
  unreachedMarkers: unreachedTrace.x.length,
}, null, 2));
