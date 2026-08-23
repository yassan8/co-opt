import assert from 'node:assert/strict';
import fs from 'node:fs';

if (typeof globalThis.self === 'undefined') globalThis.self = new EventTarget();

const { findStopSurface } = await import('../optical/system-renderer.ts');
const { calculateSurfaceOrigins } = await import('../raytracing/core/ray-tracing.ts');
const { generateSpotDiagramAsync } = await import('../evaluation/spot-diagram.ts');
const { expandBlocksToOpticalSystemRows } = await import('../data/block-schema.ts');
const { generateRayStartPointsForObject } = await import('../optical/ray-renderer.ts');
const { runNativeSpotRaytrace } = await import('../src/desktop/ipc/client.ts');

const input = JSON.parse(fs.readFileSync(
  new URL('../Examples/20260823_bug_02.json', import.meta.url),
  'utf8',
));
const activeConfig = input?.configurations?.configurations?.[0];
const expanded = expandBlocksToOpticalSystemRows(activeConfig?.blocks || []);
assert.equal(
  (expanded?.issues || []).filter((issue) => issue?.severity === 'fatal').length,
  0,
  'Design Intent blocks could not be expanded',
);
const opticalSystem = expanded.rows;
const sourceRows = input.source.filter((row) => row.enabled !== false);
const objectRows = input.object.filter((row) => row.enabled !== false);
const surfaceOrigins = calculateSurfaceOrigins(opticalSystem);
const stop = findStopSurface(opticalSystem, surfaceOrigins);

assert.equal(stop?.index, 1, 'The explicit Stop surface was not selected');
assert.equal(Number(stop?.radius), 10, 'The Stop semi-diameter was not preserved');
const secondParaxialFront = opticalSystem.find((row) => row?._blockId === 'Paraxial-2' && row?._surfaceRole === 'front');
assert.equal(Number(secondParaxialFront?._thinLensFocalLengthX), 100, 'Paraxial-2 X focal length was lost during block expansion');
assert.equal(Number(secondParaxialFront?._thinLensFocalLengthY), 0, 'Paraxial-2 unpowered Y axis was lost during block expansion');

const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => {};
console.warn = () => {};

let result;
try {
  result = await generateSpotDiagramAsync(
    opticalSystem,
    sourceRows,
    objectRows,
    opticalSystem.length,
    101,
    5,
    {
      physicalVignetting: true,
      traceOptions: { useRustWasm: false },
    },
  );
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
}

assert.equal(result?.spotData?.length, 1, 'The enabled field is missing from Spot Diagram');
const entry = result.spotData[0];
const points = Array.isArray(entry?.spotPoints) ? entry.spotPoints : [];
assert.ok(points.length >= 90, `Too many rays were lost: ${points.length}/101`);

const xs = points.map((point) => Number(point.x));
const ys = points.map((point) => Number(point.y));
assert.ok(xs.every(Number.isFinite) && ys.every(Number.isFinite), 'Spot contains non-finite coordinates');

const xSpanMm = Math.max(...xs) - Math.min(...xs);
const ySpanMm = Math.max(...ys) - Math.min(...ys);
assert.ok(xSpanMm < 1e-6, `Powered X axis did not focus: span=${xSpanMm} mm`);
assert.ok(ySpanMm > 15, `Unpowered Y axis collapsed instead of forming a vertical beam: span=${ySpanMm} mm`);

const raySeries = sourceRows.map((source, sourceIndex) => {
  const wavelengthUm = Number(source.wavelength);
  const starts = generateRayStartPointsForObject(
    objectRows[0],
    opticalSystem,
    101,
    null,
    {
      annularRingCount: 5,
      wavelengthUm,
      pattern: 'annular',
      targetSurfaceIndex: opticalSystem.length - 1,
      precomputedSurfaceOrigins: surfaceOrigins,
      disableCrossExtent: true,
    },
  );
  return {
    label: `Object 1 ${sourceIndex + 1}`,
    color: '#2563eb',
    rays: starts.map((start) => ({
      startP: start.startP,
      dir: start.dir,
      wavelengthUm,
      isChief: start.isChief === true,
    })),
  };
});

const nativeResult = await runNativeSpotRaytrace({
  opticalSystemRows: opticalSystem,
  sourceRows,
  objectRows,
  surfaceIndex: opticalSystem.length - 1,
  rayCount: 101,
  ringCount: 5,
  pattern: 'annular',
  wavelengthMode: 'all',
  raySeries,
});
const nativeSpans = nativeResult.series.map((series) => {
  const nativeXs = series.points.map((point) => Number(point.xUm));
  const nativeYs = series.points.map((point) => Number(point.yUm));
  const nativeXSpanUm = Math.max(...nativeXs) - Math.min(...nativeXs);
  const nativeYSpanUm = Math.max(...nativeYs) - Math.min(...nativeYs);
  assert.ok(nativeXs.length >= 90, `Native Spot lost too many rays: ${nativeXs.length}/101`);
  assert.ok(nativeXSpanUm < 1e-3, `Native powered X axis did not focus: span=${nativeXSpanUm} um`);
  assert.ok(nativeYSpanUm > 15000, `Native unpowered Y axis collapsed: span=${nativeYSpanUm} um`);
  return { wavelengthUm: Number(series.wavelengthUm), xSpanUm: nativeXSpanUm, ySpanUm: nativeYSpanUm };
});

originalLog(JSON.stringify({
  ok: true,
  fixture: '20260823_bug_02.json',
  stopRadiusMm: Number(stop.radius),
  successfulRays: points.length,
  requestedRays: Number(entry.totalRays ?? 101),
  xSpanMm,
  ySpanMm,
  nativeBackend: nativeResult.backend,
  nativeSpans,
}, null, 2));
