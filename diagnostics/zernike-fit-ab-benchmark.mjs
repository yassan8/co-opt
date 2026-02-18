import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const thisDir = path.dirname(thisFile);
const wasmBinaryPath = path.resolve(thisDir, '../wasm/raytracing/ray-tracing-wasm-v3.wasm');

const { fitZernikeWeighted } = await import('../evaluation/wavefront/zernike-fitting.ts');

const pointGrid = Number.isFinite(Number(process.env.ZERNIKE_GRID)) ? Math.max(17, Number(process.env.ZERNIKE_GRID)) : 129;
const maxOrder = Number.isFinite(Number(process.env.ZERNIKE_MAX_ORDER)) ? Math.max(4, Number(process.env.ZERNIKE_MAX_ORDER)) : 10;
const rounds = Number.isFinite(Number(process.env.ZERNIKE_ROUNDS)) ? Math.max(1, Number(process.env.ZERNIKE_ROUNDS)) : 10;
const warmup = Number.isFinite(Number(process.env.ZERNIKE_WARMUP)) ? Math.max(0, Number(process.env.ZERNIKE_WARMUP)) : 2;

function createPoints(grid) {
  const pts = [];
  const half = (grid - 1) / 2;
  for (let iy = 0; iy < grid; iy++) {
    const y = (iy - half) / half;
    for (let ix = 0; ix < grid; ix++) {
      const x = (ix - half) / half;
      const r2 = x * x + y * y;
      if (r2 > 1) continue;
      const opd =
        0.18 * x * x +
        0.07 * y * y +
        0.03 * x * y +
        0.015 * x * x * y -
        0.012 * x * y * y +
        0.0025 * (r2 * r2);
      pts.push({ x, y, opd, weight: 1 });
    }
  }
  return pts;
}

function summarize(samples) {
  const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return {
    avgMs: avg,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    samples,
  };
}

function installWasmHook(wasmModule) {
  globalThis.__cooptWasmSolveSymmetricSystem = (matrix, rhs, size) => {
    if (!wasmModule || typeof wasmModule._solve_spd_cholesky !== 'function') return null;
    if (!Number.isInteger(size) || size <= 0) return null;
    if (!Array.isArray(matrix) || !Array.isArray(rhs)) return null;
    if (matrix.length !== size * size || rhs.length !== size) return null;

    const bytesA = matrix.length * Float64Array.BYTES_PER_ELEMENT;
    const bytesB = rhs.length * Float64Array.BYTES_PER_ELEMENT;
    const bytesX = rhs.length * Float64Array.BYTES_PER_ELEMENT;

    let aPtr = 0;
    let bPtr = 0;
    let xPtr = 0;

    try {
      aPtr = wasmModule._malloc(bytesA);
      bPtr = wasmModule._malloc(bytesB);
      xPtr = wasmModule._malloc(bytesX);
      if (!aPtr || !bPtr || !xPtr) return null;

      const heapF64 = wasmModule.getHeapF64();
      const aHeap = new Float64Array(heapF64.buffer, aPtr, matrix.length);
      const bHeap = new Float64Array(heapF64.buffer, bPtr, rhs.length);
      aHeap.set(matrix);
      bHeap.set(rhs);

      const ok = wasmModule._solve_spd_cholesky(aPtr, bPtr, size, xPtr);
      if (!ok) return null;

      const outHeap = wasmModule.getHeapF64();
      const out = new Float64Array(outHeap.buffer, xPtr, size);
      const result = Array.from(out);
      for (let i = 0; i < result.length; i++) {
        if (!Number.isFinite(result[i])) return null;
      }
      return result;
    } catch {
      return null;
    } finally {
      if (xPtr) wasmModule._free(xPtr);
      if (bPtr) wasmModule._free(bPtr);
      if (aPtr) wasmModule._free(aPtr);
    }
  };
}

function clearWasmHook() {
  delete globalThis.__cooptWasmSolveSymmetricSystem;
}

async function runCase(points, useWasmHook) {
  if (useWasmHook) {
    const wasmBinary = fs.readFileSync(wasmBinaryPath);
    const { instance } = await WebAssembly.instantiate(wasmBinary, {
      a: {
        a: () => 0,
      },
    });
    const exports = instance.exports;
    const memory = exports.b;
    const malloc = exports.s;
    const free = exports.t;
    const solveSpd = exports.r;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error('WASM memory export not available');
    }
    if (typeof malloc !== 'function' || typeof free !== 'function' || typeof solveSpd !== 'function') {
      throw new Error('Required WASM exports (malloc/free/solve) not available');
    }
    const wasmModule = {
      getHeapF64: () => new Float64Array(memory.buffer),
      _malloc: malloc,
      _free: free,
      _solve_spd_cholesky: solveSpd,
    };
    installWasmHook(wasmModule);
  } else {
    clearWasmHook();
  }

  for (let i = 0; i < warmup; i++) {
    fitZernikeWeighted(points, maxOrder, { intercept: true });
  }

  const samples = [];
  let last = null;
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    last = fitZernikeWeighted(points, maxOrder, { intercept: true });
    samples.push(performance.now() - start);
  }

  if (useWasmHook) clearWasmHook();

  return {
    ...summarize(samples),
    coeffCount: last?.coefficients?.length ?? 0,
    rms: Number(last?.rms ?? NaN),
    pv: Number(last?.pv ?? NaN),
  };
}

const points = createPoints(pointGrid);

console.log('▶ Zernike fit A/B benchmark start', {
  pointGrid,
  points: points.length,
  maxOrder,
  rounds,
  warmup,
});

const tsOnly = await runCase(points, false);
const wasmHook = await runCase(points, true);

const speedup = tsOnly.avgMs > 0 ? tsOnly.avgMs / wasmHook.avgMs : NaN;

console.log('✅ Zernike fit A/B benchmark summary');
console.log(JSON.stringify({
  pointGrid,
  points: points.length,
  maxOrder,
  rounds,
  warmup,
  tsOnly,
  wasmHook,
  speedup,
  speedupPercent: Number.isFinite(speedup) ? (speedup - 1) * 100 : null,
}, null, 2));
