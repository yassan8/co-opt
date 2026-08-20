import assert from 'node:assert/strict';
import fs from 'node:fs';

// Match the minimal browser globals used by the Web/WASM batch client.
globalThis.self = new EventTarget();

const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };
const { runMtfBatchViaWasm } = await import('../src/desktop/ipc/client.ts');

const input = JSON.parse(fs.readFileSync(new URL('../Examples/20260802_optimize_qcon_surf.json', import.meta.url), 'utf8'));
const baseRows = input.opticalSystem;
const sourceRows = input.source;
const objectRows = input.object;

assert.ok(Array.isArray(baseRows) && baseRows.length > 0, 'missing opticalSystem');
assert.ok(Array.isArray(sourceRows) && sourceRows.length >= 3, 'missing wavelengths');
assert.ok(Array.isArray(objectRows) && objectRows.length >= 11, 'missing fields');

const changedRows = structuredClone(baseRows);
const changedSurface = changedRows.find((row) => Number(row?.id) === 12);
assert.ok(changedSurface, 'Surf 12 not found');
changedSurface.coef1 = String((Number(changedSurface.coef1) || 0) + 1e-6);

const candidates = [baseRows, changedRows];
const makeJob = (rows, candidateIndex, wavelength, objectIndex) => {
  const object = objectRows[objectIndex] || {};
  const fieldX = Number(object.xHeightAngle ?? object.x ?? 0) || 0;
  const fieldY = Number(object.yHeightAngle ?? object.y ?? 0) || 0;
  const fieldNorm = Math.hypot(fieldX, fieldY);
  const tangentialDir = fieldNorm > 1e-12
    ? { x: fieldX / fieldNorm, y: fieldY / fieldNorm }
    : { x: 1, y: 0 };
  return {
    opdRequest: {
      opticalSystemRows: rows,
      sourceRows,
      objectRows,
      objectIndex,
      gridSize: 16,
      wavelengthUm: wavelength,
      opdDisplayMode: 'pistonTiltRemoved',
    },
    wavelengthUm: wavelength,
    fNumber: 4,
    pupilRange: 1,
    maxFrequencyLpmm: 20,
    points: 2,
    sampleFrequenciesLpmm: [20],
    directEvalOnly: true,
    slimResults: true,
    method: 'malacara-wasm-required',
    tangentialDir,
    sagittalDir: { x: -tangentialDir.y, y: tangentialDir.x },
    meta: { candidateIndex, wavelength, objectIndex },
  };
};

const jobs = candidates.flatMap((rows, candidateIndex) => sourceRows.flatMap((source) => {
  const wavelength = Number(source.wavelength);
  return objectRows.map((_, objectIndex) => makeJob(rows, candidateIndex, wavelength, objectIndex));
}));
assert.equal(jobs.length, 66, 'expected 2 candidates × 3 wavelengths × 11 fields');

const compactGroups = new Map();
for (const job of jobs) {
  const key = `${job.meta.candidateIndex}|${Number(job.wavelengthUm).toFixed(9)}`;
  const group = compactGroups.get(key) || [];
  group.push(job);
  compactGroups.set(key, group);
}

const fullRequestChars = JSON.stringify({ jobs }).length;
const compactRequests = [...compactGroups.values()].map((group) => {
  const first = group[0];
  const shared = { opdRequest: { ...first.opdRequest } };
  const compactJobs = group.map((job) => {
    const opdRequest = { ...job.opdRequest };
    delete opdRequest.opticalSystemRows;
    delete opdRequest.sourceRows;
    delete opdRequest.objectRows;
    return { ...job, opdRequest };
  });
  return { shared, jobs: compactJobs };
});
const compactRequestChars = compactRequests.reduce((sum, request) => sum + JSON.stringify(request).length, 0);

const t0 = performance.now();
const full = await runMtfBatchViaWasm({ jobs });
const fullMs = performance.now() - t0;
assert.equal(full.results?.length, jobs.length, 'full batch result count');

const t1 = performance.now();
const compactResults = (await Promise.all(compactRequests.map((request) => runMtfBatchViaWasm(request))))
  .flatMap((response) => response.results || []);
const compactMs = performance.now() - t1;
assert.equal(compactResults.length, jobs.length, 'shared batch result count');

const keyOf = (entry) => {
  const meta = entry?.meta || {};
  return `${meta.candidateIndex}|${Number(meta.wavelength).toFixed(9)}|${meta.objectIndex}`;
};
const compactByKey = new Map(compactResults.map((entry) => [keyOf(entry), entry]));
let maxMtfDifference = 0;
for (const fullResult of full.results) {
  const compactResult = compactByKey.get(keyOf(fullResult));
  assert.ok(compactResult, `missing compact result ${keyOf(fullResult)}`);
  for (const axis of ['sampledMtfTangential', 'sampledMtfSagittal']) {
    const fullValue = Number(fullResult?.mtf?.[axis]?.[0]);
    const compactValue = Number(compactResult?.mtf?.[axis]?.[0]);
    assert.ok(Number.isFinite(fullValue) && Number.isFinite(compactValue), `invalid ${axis} for ${keyOf(fullResult)}`);
    maxMtfDifference = Math.max(maxMtfDifference, Math.abs(fullValue - compactValue));
  }
}

const c0 = full.results.find((entry) => entry?.meta?.candidateIndex === 0 && entry?.meta?.objectIndex === 10)?.mtf?.sampledMtfTangential?.[0];
const c1 = full.results.find((entry) => entry?.meta?.candidateIndex === 1 && entry?.meta?.objectIndex === 10)?.mtf?.sampledMtfTangential?.[0];
assert.ok(Math.abs(Number(c0) - Number(c1)) > 1e-12, 'candidate-specific MTF values were aliased');
// ImageHeight normalization is repeated per job in the unshared reference and
// once per shared group. Its chief-ray solver can differ at the final floating
// point digits; 1e-7 is far below a displayed MTF pixel/value precision.
assert.ok(maxMtfDifference <= 1e-7, `shared batch changed MTF result by ${maxMtfDifference}`);

console.log(JSON.stringify({
  ok: true,
  jobs: jobs.length,
  sharedBatches: compactRequests.length,
  fullRequestChars,
  compactRequestChars,
  requestReductionPct: (1 - compactRequestChars / fullRequestChars) * 100,
  fullMs,
  compactSequentialMs: compactMs,
  packedMetaCacheEntries: full.packedMetaCacheEntries,
  packedMetaCacheHits: full.packedMetaCacheHits,
  candidateEdgeMtf: { c0, c1, difference: Number(c1) - Number(c0) },
  maxMtfDifference,
}, null, 2));
