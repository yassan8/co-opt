#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import init, {
  malloc,
  free,
  optimize_one_iter_from_buffers,
} from './rust-wasm/pkg/surface_origins.js';

const wasmBinaryPath = path.join(__dirname, 'rust-wasm', 'pkg', 'surface_origins_bg.wasm');
const wasmBuffer = fs.readFileSync(wasmBinaryPath);
const wasmExports = await init({ module_or_path: wasmBuffer });
const wasmMemory = wasmExports?.memory;
if (!wasmMemory?.buffer) {
  throw new Error('WASM memory export is unavailable');
}

const n = 12;
const m = 10;

const x = new Float64Array(Array.from({ length: n }, (_, i) => 0.1 * (i + 1)));
const steps = new Float64Array(Array.from({ length: n }, () => 0.01));
const r0 = new Float64Array(Array.from({ length: m }, () => 0.1));
const rBatches = new Float64Array(n * m);
for (let col = 0; col < n; col++) {
  const base = col * m;
  for (let row = 0; row < m; row++) {
    rBatches[base + row] = 0.12 + 1e-4 * col;
  }
}
const scales = new Float64Array(Array.from({ length: n }, () => 1));

function allocF64(input) {
  const ptr = malloc(input.length * 8);
  const view = new Float64Array(wasmMemory.buffer, ptr, input.length);
  view.set(input);
  return ptr;
}

const xPtr = allocF64(x);
const stepsPtr = allocF64(steps);
const r0Ptr = allocF64(r0);
const rBatchesPtr = allocF64(rBatches);
const scalesPtr = allocF64(scales);

const dxPtr = malloc(n * 8);
const xNextPtr = malloc(n * 8);
const metaPtr = malloc(8 * 8);

const status = optimize_one_iter_from_buffers(
  xPtr,
  stepsPtr,
  r0Ptr,
  rBatchesPtr,
  scalesPtr,
  dxPtr,
  xNextPtr,
  metaPtr,
  n,
  m,
  0.01,
  100,
);

const dx = Array.from(new Float64Array(wasmMemory.buffer, dxPtr, n));
const xNext = Array.from(new Float64Array(wasmMemory.buffer, xNextPtr, n));
const meta = Array.from(new Float64Array(wasmMemory.buffer, metaPtr, 8));

console.log('status:', status);
console.log('dx.length:', dx.length, 'xNext.length:', xNext.length);
console.log('predictedReduction(meta[0]):', meta[0]);
console.log('jacobianShape(meta[3],meta[4]):', meta[3], meta[4]);

const ok = status === 0
  && dx.length === n
  && xNext.length === n
  && Number.isFinite(meta[0])
  && Number(meta[3]) === m
  && Number(meta[4]) === n;

free(xPtr, x.length * 8);
free(stepsPtr, steps.length * 8);
free(r0Ptr, r0.length * 8);
free(rBatchesPtr, rBatches.length * 8);
free(scalesPtr, scales.length * 8);
free(dxPtr, n * 8);
free(xNextPtr, n * 8);
free(metaPtr, 8 * 8);

if (!ok) {
  console.error('❌ buffer ABI smoke test failed');
  process.exit(1);
}

console.log('✅ buffer ABI smoke test passed');
