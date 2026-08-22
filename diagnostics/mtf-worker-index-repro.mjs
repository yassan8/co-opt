import assert from 'node:assert/strict';

globalThis.self = new EventTarget();
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };

const {
  remapMtfWorkerChunkResults,
  splitMtfJobsAcrossWorkers,
} = await import('../src/desktop/ipc/client.ts');

const jobs = Array.from({ length: 6 }, (_, jobIndex) => ({
  meta: { jobIndex, fieldIndex: jobIndex, label: `global-${jobIndex}` },
}));
const roundRobin = splitMtfJobsAcrossWorkers(jobs, 3);
assert.equal(roundRobin.strategy, 'round-robin');
assert.deepEqual(roundRobin.chunkJobIndexes, [[0, 3], [1, 4], [2, 5]]);

const workerResponses = roundRobin.chunks.map((chunk, workerIndex) => ({
  results: chunk.map((_, localIndex) => ({
    jobIndex: localIndex,
    value: `worker-${workerIndex}-local-${localIndex}`,
    meta: { workerIndex },
  })),
}));
const restored = workerResponses
  .flatMap((response, workerIndex) => remapMtfWorkerChunkResults(
    response,
    roundRobin.chunkJobIndexes[workerIndex],
    jobs,
  ))
  .sort((left, right) => left.jobIndex - right.jobIndex);

assert.deepEqual(restored.map((result) => result.jobIndex), [0, 1, 2, 3, 4, 5]);
assert.deepEqual(restored.map((result) => result.meta.jobIndex), [0, 1, 2, 3, 4, 5]);
assert.deepEqual(restored.map((result) => result.meta.fieldIndex), [0, 1, 2, 3, 4, 5]);
assert.deepEqual(restored.map((result) => result.meta.label), jobs.map((job) => job.meta.label));
assert.equal(new Set(restored.map((result) => result.jobIndex)).size, jobs.length);

const candidateJobs = [
  { meta: { candidateIndex: 0, label: 'c0-a' } },
  { meta: { candidateIndex: 1, label: 'c1-a' } },
  { meta: { candidateIndex: 0, label: 'c0-b' } },
  { meta: { candidateIndex: 1, label: 'c1-b' } },
];
const candidateAffinity = splitMtfJobsAcrossWorkers(candidateJobs, 2);
assert.equal(candidateAffinity.strategy, 'candidate-affinity');
assert.deepEqual(
  candidateAffinity.chunkJobIndexes.map((indexes) => indexes.slice().sort((a, b) => a - b)),
  [[0, 2], [1, 3]],
);

assert.throws(
  () => remapMtfWorkerChunkResults({ results: [{ jobIndex: 2 }] }, [], jobs),
  /unmappable local result index/,
);

console.log(JSON.stringify({
  ok: true,
  roundRobinIndexes: roundRobin.chunkJobIndexes,
  restoredIndexes: restored.map((result) => result.jobIndex),
  candidateAffinityIndexes: candidateAffinity.chunkJobIndexes,
}, null, 2));
