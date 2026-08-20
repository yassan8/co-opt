import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  initSync,
  register_trace_system_metadata,
  clear_trace_system_metadata_cache,
  trace_ray_batch_hit_point_with_meta,
  trace_ray_batch_hit_point_cached,
  trace_ray_batch_hit_point_with_rows_json,
  run_native_mtf_malacara_from_opd_wasm_json,
} from '../rust-wasm/pkg/surface_origins.js';

const wasmBytes = await readFile(new URL('../rust-wasm/pkg/surface_origins_bg.wasm', import.meta.url));
initSync({ module: wasmBytes });

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const timed = (rounds, fn) => {
  const elapsed = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    fn();
    elapsed.push(performance.now() - started);
  }
  return median(elapsed);
};

const rowCount = 24;
const rowMeta = new Int32Array(rowCount * 4);
const rowParams = new Float64Array(rowCount * 24);
const rowOrigins = new Float64Array(rowCount * 3);
const rowRotations = new Float64Array(rowCount * 9);
for (let surface = 0; surface < rowCount; surface += 1) {
  rowMeta[surface * 4 + 1] = 0;
  rowParams[surface * 24] = surface % 2 === 0 ? 350 : -350;
  rowParams[surface * 24 + 12] = Number.POSITIVE_INFINITY;
  rowParams[surface * 24 + 17] = Number.POSITIVE_INFINITY;
  rowParams[surface * 24 + 20] = 1;
  rowOrigins[surface * 3 + 2] = 10 * (surface + 1);
  rowRotations[surface * 9] = 1;
  rowRotations[surface * 9 + 4] = 1;
  rowRotations[surface * 9 + 8] = 1;
}

const seriesCount = 12;
const raysPerSeries = 501;
const spotSeries = Array.from({ length: seriesCount }, (_, seriesIndex) => {
  const rays = new Float64Array(raysPerSeries * 6);
  for (let rayIndex = 0; rayIndex < raysPerSeries; rayIndex += 1) {
    const angle = (2 * Math.PI * rayIndex) / raysPerSeries;
    const radius = 0.3 + 0.7 * ((rayIndex % 31) / 30);
    const base = rayIndex * 6;
    rays[base] = radius * Math.cos(angle);
    rays[base + 1] = radius * Math.sin(angle);
    rays[base + 2] = 0;
    rays[base + 3] = 0.0005 * (seriesIndex - seriesCount / 2);
    rays[base + 4] = 0.001 * Math.sin(seriesIndex);
    rays[base + 5] = 1;
  }
  return rays;
});

const runLegacySpot = () => spotSeries.map((rays) => trace_ray_batch_hit_point_with_meta(
  rays,
  raysPerSeries,
  rowCount - 1,
  1,
  rowMeta,
  rowParams,
  rowOrigins,
  rowRotations,
  rowRotations,
  rowCount,
));

clear_trace_system_metadata_cache();
const metadataHandle = register_trace_system_metadata(
  rowMeta,
  rowParams,
  rowOrigins,
  rowRotations,
  rowRotations,
  rowCount,
);
const runBatchedSpot = () => {
  const output = new Array(seriesCount);
  for (let wavelengthGroup = 0; wavelengthGroup < 3; wavelengthGroup += 1) {
    const indexes = [];
    for (let index = wavelengthGroup; index < seriesCount; index += 3) indexes.push(index);
    const flat = new Float64Array(indexes.length * raysPerSeries * 6);
    indexes.forEach((seriesIndex, offset) => flat.set(spotSeries[seriesIndex], offset * raysPerSeries * 6));
    const hits = trace_ray_batch_hit_point_cached(
      flat,
      indexes.length * raysPerSeries,
      rowCount - 1,
      1,
      metadataHandle,
    );
    indexes.forEach((seriesIndex, offset) => {
      output[seriesIndex] = hits.slice(offset * raysPerSeries * 6, (offset + 1) * raysPerSeries * 6);
    });
  }
  return output;
};

runLegacySpot();
runBatchedSpot();
const legacySpot = runLegacySpot();
const batchedSpot = runBatchedSpot();
let spotMaxAbsDiff = 0;
for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex += 1) {
  for (let index = 0; index < legacySpot[seriesIndex].length; index += 1) {
    spotMaxAbsDiff = Math.max(spotMaxAbsDiff, Math.abs(legacySpot[seriesIndex][index] - batchedSpot[seriesIndex][index]));
  }
}
const legacySpotMs = timed(20, runLegacySpot);
const batchedSpotMs = timed(20, runBatchedSpot);
const workerApiRows = [
  { 'object type': 'Object', thickness: 10 },
  ...Array.from({ length: 6 }, (_, index) => ({
    radius: index % 2 === 0 ? 350 : -350,
    thickness: 10,
    material: 'AIR',
    semidia: 50,
  })),
  { 'object type': 'Image', radius: Number.POSITIVE_INFINITY, thickness: 0 },
];
const workerApiHits = trace_ray_batch_hit_point_with_rows_json(
  JSON.stringify(workerApiRows),
  spotSeries[0],
  raysPerSeries,
  workerApiRows.length - 1,
  0.55,
  1,
);
const workerApiValid = workerApiHits.length === raysPerSeries * 6
  && Array.from({ length: raysPerSeries }, (_, index) => workerApiHits[index * 6])
    .some((status) => status === 1);

const gridSize = 64;
const opdGrid = Array.from({ length: gridSize }, (_, y) =>
  Array.from({ length: gridSize }, (_, x) => {
    const px = (2 * x) / (gridSize - 1) - 1;
    const py = (2 * y) / (gridSize - 1) - 1;
    if (px * px + py * py > 1) return null;
    return 0.09 * px * px + 0.025 * px * py - 0.015 * py * py + 0.01 * px * px * px;
  }),
);
const baseMtfRequest = {
  displayOpdGrid: opdGrid,
  wavelengthUm: 0.55,
  fNumber: 4,
  pupilRange: 1,
  maxFrequencyLpmm: 120,
  points: 481,
  tangentialDir: { x: 0.8, y: 0.6 },
  sagittalDir: { x: -0.6, y: 0.8 },
};
const runMtf = (mode) => run_native_mtf_malacara_from_opd_wasm_json(JSON.stringify({
  ...baseMtfRequest,
  malacaraCorrelationMode: mode,
}));
runMtf('direct');
runMtf('fft');
const directMtf = runMtf('direct');
const fftMtf = runMtf('fft');
let mtfMaxAbsDiff = 0;
for (const key of ['mtfTangential', 'mtfSagittal']) {
  for (let index = 0; index < directMtf[key].length; index += 1) {
    mtfMaxAbsDiff = Math.max(mtfMaxAbsDiff, Math.abs(directMtf[key][index] - fftMtf[key][index]));
  }
}
const directMtfMs = timed(7, () => runMtf('direct'));
const fftMtfMs = timed(12, () => runMtf('fft'));

const result = {
  spot: {
    seriesCount,
    raysPerSeries,
    totalRays: seriesCount * raysPerSeries,
    legacyCalls: seriesCount,
    optimizedCalls: 3,
    legacyMedianMs: legacySpotMs,
    optimizedMedianMs: batchedSpotMs,
    mainThreadBatchSpeedup: legacySpotMs / batchedSpotMs,
    executionMode: 'Node main-thread kernel only; browser path runs wavelength groups in persistent workers',
    workerApiValid,
    maxAbsDiff: spotMaxAbsDiff,
  },
  mtf: {
    gridSize,
    frequencyPoints: baseMtfRequest.points,
    directMedianMs: directMtfMs,
    fftMedianMs: fftMtfMs,
    speedup: directMtfMs / fftMtfMs,
    maxAbsDiff: mtfMaxAbsDiff,
  },
};
console.log(JSON.stringify(result, null, 2));

if (spotMaxAbsDiff !== 0) process.exitCode = 1;
if (!workerApiValid) process.exitCode = 1;
if (!(Number.isFinite(result.mtf.speedup) && result.mtf.speedup > 1)) process.exitCode = 1;
if (!(mtfMaxAbsDiff <= 0.03)) process.exitCode = 1;
