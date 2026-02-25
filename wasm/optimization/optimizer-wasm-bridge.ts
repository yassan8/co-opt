import { getRustRayTracingWasmSync, preloadRustRayTracingWasm } from '../raytracing/rust-raytracing-wasm.ts';

type OptimizerWasmApi = {
  solve_spd_linear_system?: (aFlat: Float64Array, n: number, b: Float64Array) => Float64Array;
  solve_linear_system?: (aFlat: Float64Array, n: number, b: Float64Array) => Float64Array;
  build_normal_equations?: (jFlat: Float64Array, m: number, n: number, r: Float64Array) => Float64Array;
};

let optimizerBridgeReady = false;
let optimizerDirectApi: OptimizerWasmApi | null = null;
let optimizerDirectInitPromise: Promise<OptimizerWasmApi | null> | null = null;
const optimizerWasmBridgeDebugState: Record<string, any> = {
  ready: false,
  hasSolveSpd: false,
  hasSolveLinear: false,
  hasBuildNormalEq: false,
  initSource: 'none',
  initError: null,
  lastSolveReason: 'not-run',
  lastNormalEqReason: 'not-run'
};

function setBridgeReason(kind: 'solve' | 'normalEq', reason: string): void {
  if (kind === 'solve') optimizerWasmBridgeDebugState.lastSolveReason = String(reason || 'unknown');
  else optimizerWasmBridgeDebugState.lastNormalEqReason = String(reason || 'unknown');
}

export function getOptimizerWasmBridgeDebugInfo(): Record<string, any> {
  return { ...optimizerWasmBridgeDebugState };
}

function getOptimizerApiSync(): OptimizerWasmApi | null {
  const sharedApi = (getRustRayTracingWasmSync() as unknown as OptimizerWasmApi | null);
  if (sharedApi) return sharedApi;
  if (optimizerDirectApi) return optimizerDirectApi;
  return null;
}

async function preloadOptimizerDirectWasmModule(): Promise<OptimizerWasmApi | null> {
  if (optimizerDirectApi) return optimizerDirectApi;
  if (!optimizerDirectInitPromise) {
    optimizerDirectInitPromise = (async () => {
      try {
        const wasmPkgPath = '../../rust-wasm/pkg/surface_origins' + '.js';
        const mod = await import(wasmPkgPath);
        if (typeof mod?.default === 'function') {
          await mod.default();
        }

        const api: OptimizerWasmApi = {
          solve_spd_linear_system: (typeof mod.solve_spd_linear_system === 'function') ? mod.solve_spd_linear_system : undefined,
          solve_linear_system: (typeof mod.solve_linear_system === 'function') ? mod.solve_linear_system : undefined,
          build_normal_equations: (typeof mod.build_normal_equations === 'function') ? mod.build_normal_equations : undefined
        };

        if (
          typeof api.solve_spd_linear_system !== 'function'
          && typeof api.solve_linear_system !== 'function'
          && typeof api.build_normal_equations !== 'function'
        ) {
          optimizerWasmBridgeDebugState.initError = 'optimizer-direct-wasm-exports-missing';
          return null;
        }

        optimizerWasmBridgeDebugState.initSource = 'optimizer-direct';
        optimizerWasmBridgeDebugState.initError = null;
        optimizerDirectApi = api;
        return api;
      } catch (e) {
        optimizerWasmBridgeDebugState.initError = String((e as any)?.message || e || 'optimizer-direct-init-failed');
        return null;
      }
    })();
  }

  try {
    return await optimizerDirectInitPromise;
  } finally {
    optimizerDirectInitPromise = null;
  }
}

function flattenSquareMatrix(matrix: number[][]): { flat: Float64Array; n: number } | null {
  if (!Array.isArray(matrix) || matrix.length === 0) return null;
  const n = matrix.length;
  for (let rowIndex = 0; rowIndex < n; rowIndex++) {
    const row = matrix[rowIndex];
    if (!Array.isArray(row) || row.length !== n) return null;
  }

  const flat = new Float64Array(n * n);
  for (let rowIndex = 0; rowIndex < n; rowIndex++) {
    const row = matrix[rowIndex];
    for (let colIndex = 0; colIndex < n; colIndex++) {
      const value = Number(row[colIndex]);
      flat[rowIndex * n + colIndex] = Number.isFinite(value) ? value : 0;
    }
  }
  return { flat, n };
}

function toFloat64Vector(values: number[], n: number): Float64Array | null {
  if (!Array.isArray(values) || values.length !== n) return null;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) return null;
    out[i] = value;
  }
  return out;
}

function flattenRectMatrix(matrix: number[][], rows: number, cols: number): Float64Array | null {
  if (!Array.isArray(matrix) || matrix.length !== rows) return null;
  if (rows <= 0 || cols <= 0) return null;
  const flat = new Float64Array(rows * cols);
  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    const row = matrix[rowIndex];
    if (!Array.isArray(row) || row.length < cols) return null;
    for (let colIndex = 0; colIndex < cols; colIndex++) {
      const value = Number(row[colIndex]);
      flat[rowIndex * cols + colIndex] = Number.isFinite(value) ? value : 0;
    }
  }
  return flat;
}

export async function preloadOptimizerWasmBridge(): Promise<boolean> {
  if (optimizerBridgeReady) return true;
  try {
    await preloadRustRayTracingWasm();
    optimizerWasmBridgeDebugState.initSource = 'shared-raytracing';
    optimizerWasmBridgeDebugState.initError = null;
  } catch (e) {
    optimizerWasmBridgeDebugState.initError = String((e as any)?.message || e || 'shared-preload-failed');
  }

  let api = getOptimizerApiSync();
  if (!api) {
    await preloadOptimizerDirectWasmModule();
    api = getOptimizerApiSync();
  }

  optimizerWasmBridgeDebugState.hasSolveSpd = !!(api && typeof api.solve_spd_linear_system === 'function');
  optimizerWasmBridgeDebugState.hasSolveLinear = !!(api && typeof api.solve_linear_system === 'function');
  optimizerWasmBridgeDebugState.hasBuildNormalEq = !!(api && typeof api.build_normal_equations === 'function');
  optimizerBridgeReady = !!(
    api && (
      typeof api.solve_spd_linear_system === 'function'
      || typeof api.solve_linear_system === 'function'
      || typeof api.build_normal_equations === 'function'
    )
  );
  optimizerWasmBridgeDebugState.ready = optimizerBridgeReady;
  return optimizerBridgeReady;
}

export function solveLinearSystemWithOptimizerWasm(
  matrix: number[][],
  rhs: number[],
  preferSpd: boolean = true
): number[] | null {
  const api = getOptimizerApiSync();
  if (!api) {
    setBridgeReason('solve', 'api-missing');
    return null;
  }

  const packed = flattenSquareMatrix(matrix);
  if (!packed) {
    setBridgeReason('solve', 'matrix-shape-invalid');
    return null;
  }

  const rhsVec = toFloat64Vector(rhs, packed.n);
  if (!rhsVec) {
    setBridgeReason('solve', 'rhs-non-finite');
    return null;
  }

  const solver = preferSpd
    ? (typeof api.solve_spd_linear_system === 'function' ? api.solve_spd_linear_system : api.solve_linear_system)
    : (typeof api.solve_linear_system === 'function' ? api.solve_linear_system : api.solve_spd_linear_system);

  if (typeof solver !== 'function') {
    setBridgeReason('solve', 'solver-missing');
    return null;
  }

  try {
    const result = solver(packed.flat, packed.n, rhsVec);
    if (!result || typeof (result as any).length !== 'number') {
      setBridgeReason('solve', 'result-missing');
      return null;
    }
    const out = Array.from(result as Float64Array).map((value) => Number(value));
    if (out.length !== packed.n) {
      setBridgeReason('solve', 'result-size-mismatch');
      return null;
    }
    for (const value of out) {
      if (!Number.isFinite(value)) {
        setBridgeReason('solve', 'result-non-finite');
        return null;
      }
    }
    setBridgeReason('solve', 'ok');
    return out;
  } catch (_) {
    setBridgeReason('solve', 'exception');
    return null;
  }
}

export function buildNormalEquationsWithOptimizerWasm(
  jacobian: number[][],
  residuals: number[],
  m: number,
  n: number
): { A: number[][]; g: number[] } | null {
  const api = getOptimizerApiSync();
  if (!api) {
    setBridgeReason('normalEq', 'api-missing');
    return null;
  }
  if (typeof api.build_normal_equations !== 'function') {
    setBridgeReason('normalEq', 'kernel-missing');
    return null;
  }

  const mm = Math.max(0, Math.floor(Number(m)));
  const nn = Math.max(0, Math.floor(Number(n)));
  if (mm <= 0 || nn <= 0) {
    setBridgeReason('normalEq', 'invalid-dimensions');
    return null;
  }

  const jFlat = flattenRectMatrix(jacobian, mm, nn);
  if (!jFlat) {
    setBridgeReason('normalEq', 'jacobian-shape-invalid');
    return null;
  }

  const rVec = toFloat64Vector(residuals, mm);
  if (!rVec) {
    setBridgeReason('normalEq', 'residuals-non-finite');
    return null;
  }

  try {
    const packed = api.build_normal_equations(jFlat, mm, nn, rVec);
    if (!packed || typeof (packed as any).length !== 'number') {
      setBridgeReason('normalEq', 'result-missing');
      return null;
    }
    const arr = Array.from(packed as Float64Array).map((v) => Number(v));
    const expect = nn * nn + nn;
    if (arr.length !== expect) {
      setBridgeReason('normalEq', 'result-size-mismatch');
      return null;
    }
    for (const value of arr) {
      if (!Number.isFinite(value)) {
        setBridgeReason('normalEq', 'result-non-finite');
        return null;
      }
    }

    const A: number[][] = Array.from({ length: nn }, () => Array(nn).fill(0));
    for (let i = 0; i < nn; i++) {
      const rowBase = i * nn;
      for (let j = 0; j < nn; j++) {
        A[i][j] = arr[rowBase + j];
      }
    }
    const g = arr.slice(nn * nn, nn * nn + nn);
    setBridgeReason('normalEq', 'ok');
    return { A, g };
  } catch (_) {
    setBridgeReason('normalEq', 'exception');
    return null;
  }
}
