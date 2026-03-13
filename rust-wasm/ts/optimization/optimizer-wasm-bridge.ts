import { getRustRayTracingWasmSync, preloadRustRayTracingWasm, getRustRayTracingWasmInitError } from '../raytracing/rust-raytracing-wasm.ts';

type OptimizerWasmApi = {
  solve_spd_linear_system?: (aFlat: Float64Array, n: number, b: Float64Array) => Float64Array;
  solve_linear_system?: (aFlat: Float64Array, n: number, b: Float64Array) => Float64Array;
  build_normal_equations?: (jFlat: Float64Array, m: number, n: number, r: Float64Array) => Float64Array;
  normal_eq_matvec?: (jFlat: Float64Array, m: number, n: number, v: Float64Array, damping: number) => Float64Array;
  generate_fd_perturbation_points?: (x: Float64Array, steps: Float64Array, n: number) => Float64Array;
  assemble_fd_jacobian?: (r0: Float64Array, rBatches: Float64Array, m: number, n: number, steps: Float64Array) => Float64Array;
  assemble_fd_jacobian_grouped?: (
    r0: Float64Array,
    rBatches: Float64Array,
    m: number,
    n: number,
    colIndices: Uint32Array,
    steps: Float64Array
  ) => Float64Array;
  optimize_system_in_wasm?: (payloadJson: string) => any;
  optimize_one_iter_from_buffers?: (
    xPtr: number,
    stepsPtr: number,
    r0Ptr: number,
    rBatchesPtr: number,
    varScalesPtr: number,
    outDxPtr: number,
    outXNextPtr: number,
    outMetaPtr: number,
    n: number,
    m: number,
    damping: number,
    trustRadius: number
  ) => number;
  malloc?: (size: number) => number;
  free?: (ptr: number, size?: number) => void;
  memory?: { buffer: ArrayBuffer };
  // Phase 1: Linear Algebra Kernels
  vector_add_scaled?: (x: Float64Array, y: Float64Array, alpha: number) => Float64Array;
  vector_dot?: (x: Float64Array, y: Float64Array) => number;
  vector_norm?: (x: Float64Array) => number;
  matrix_vector_multiply?: (aFlat: Float64Array, x: Float64Array, rows: number, cols: number) => Float64Array;
  cholesky_factorization?: (aFlat: Float64Array, n: number) => Float64Array;
  bfgs_update?: (hFlat: Float64Array, s: Float64Array, y: Float64Array, n: number) => boolean;
  qr_factorization?: (aFlat: Float64Array, rows: number, cols: number) => Float64Array;
  solve_qp_subproblem_unconstrained?: (hFlat: Float64Array, n: number, g: Float64Array, damping: number) => Float64Array;
  solve_qp_subproblem_kkt_equality?: (hFlat: Float64Array, n: number, g: Float64Array, aFlat: Float64Array, m: number, c: Float64Array, damping: number) => Float64Array;
  backtracking_line_search_armijo?: (
    x: Float64Array,
    p: Float64Array,
    f0: number,
    grad0: Float64Array,
    alphaInit: number,
    rho: number,
    c1: number,
    maxIter: number,
    meritEvalCallback: (trialX: Float64Array) => number
  ) => number;
  update_trust_region_radius?: (
    predictedReduction: number,
    actualReduction: number,
    currentRadius: number,
    eta1: number,
    eta2: number,
    gammaDec: number,
    gammaInc: number,
    minRadius: number,
    maxRadius: number
  ) => number;
};

let optimizerBridgeReady = false;
let optimizerDirectApi: OptimizerWasmApi | null = null;
let optimizerDirectInitPromise: Promise<OptimizerWasmApi | null> | null = null;
const optimizerWasmBridgeDebugState: Record<string, any> = {
  ready: false,
  hasSolveSpd: false,
  hasSolveLinear: false,
  hasBuildNormalEq: false,
  hasFdBatchPoints: false,
  hasFdBatchJacobian: false,
  hasFdBatchJacobianGrouped: false,
  hasPilotBufferAbi: false,
  hasVectorOps: false,
  hasMatrixOps: false,
  hasCholesky: false,
  hasBfgs: false,
  hasQr: false,
  hasQpSubproblem: false,
  hasQpKktEqSubproblem: false,
  hasLineSearchArmijo: false,
  hasTrustRegionUpdate: false,
  initSource: 'none',
  initError: null,
  lastSolveReason: 'not-run',
  lastNormalEqReason: 'not-run',
  lastPilotReason: 'not-run',
  lastPilotErrorDetail: null,
  lastPilotPath: 'none',
  lastPilotBufferAttempted: false,
  lastPilotBufferStatus: null,
  kktWasmBufferCalls: 0,
  kktWasmBufferHits: 0,
  kktWasmBufferFallbacks: 0,
  kktWasmBufferStatusHistogram: {}
};

type OptimizerWasmWorkspace = {
  capN: number;
  capM: number;
  ptrX: number;
  ptrSteps: number;
  ptrR0: number;
  ptrRBatches: number;
  ptrScales: number;
  ptrDx: number;
  ptrXNext: number;
  ptrMeta: number;
};

let optimizerWasmWorkspace: OptimizerWasmWorkspace | null = null;

function allocBytes(api: OptimizerWasmApi, bytes: number): number {
  const allocFn = (typeof api.malloc === 'function')
    ? api.malloc.bind(api)
    : (typeof (api as any).__wbindgen_malloc === 'function' ? (api as any).__wbindgen_malloc.bind(api) : null);
  if (typeof allocFn !== 'function') throw new Error('allocator-missing');
  const ptr = Number(allocFn(bytes));
  if (!Number.isFinite(ptr) || ptr <= 0) throw new Error('allocator-returned-invalid-pointer');
  return ptr;
}

function freeBytes(api: OptimizerWasmApi, ptr: number, bytes: number): void {
  if (!Number.isFinite(ptr) || ptr <= 0 || !Number.isFinite(bytes) || bytes <= 0) return;
  const freeFn = (typeof api.free === 'function')
    ? api.free.bind(api)
    : (typeof (api as any).__wbindgen_free === 'function' ? (api as any).__wbindgen_free.bind(api) : null);
  if (typeof freeFn !== 'function') return;
  try {
    if (freeFn.length >= 3) {
      (freeFn as any)(ptr, bytes, 8);
    } else if (freeFn.length >= 2) {
      (freeFn as any)(ptr, bytes);
    } else {
      (freeFn as any)(ptr);
    }
  } catch {
    // ignore free failures for best-effort cleanup
  }
}

function releaseOptimizerWorkspace(api: OptimizerWasmApi): void {
  const ws = optimizerWasmWorkspace;
  if (!ws) return;
  freeBytes(api, ws.ptrX, ws.capN * 8);
  freeBytes(api, ws.ptrSteps, ws.capN * 8);
  freeBytes(api, ws.ptrR0, ws.capM * 8);
  freeBytes(api, ws.ptrRBatches, ws.capN * ws.capM * 8);
  freeBytes(api, ws.ptrScales, ws.capN * 8);
  freeBytes(api, ws.ptrDx, ws.capN * 8);
  freeBytes(api, ws.ptrXNext, ws.capN * 8);
  freeBytes(api, ws.ptrMeta, 8 * 8);
  optimizerWasmWorkspace = null;
}

function ensureOptimizerWorkspace(api: OptimizerWasmApi, n: number, m: number): OptimizerWasmWorkspace | null {
  if (!api?.memory?.buffer || typeof api.optimize_one_iter_from_buffers !== 'function') return null;
  const targetN = Math.max(1, Math.floor(Number(n) || 0));
  const targetM = Math.max(1, Math.floor(Number(m) || 0));
  if (targetN <= 0 || targetM <= 0) return null;

  const current = optimizerWasmWorkspace;
  if (current && current.capN >= targetN && current.capM >= targetM) return current;

  const nextN = current ? Math.max(targetN, Math.ceil(current.capN * 1.5)) : targetN;
  const nextM = current ? Math.max(targetM, Math.ceil(current.capM * 1.5)) : targetM;

  if (current) releaseOptimizerWorkspace(api);

  try {
    const ws: OptimizerWasmWorkspace = {
      capN: nextN,
      capM: nextM,
      ptrX: allocBytes(api, nextN * 8),
      ptrSteps: allocBytes(api, nextN * 8),
      ptrR0: allocBytes(api, nextM * 8),
      ptrRBatches: allocBytes(api, nextN * nextM * 8),
      ptrScales: allocBytes(api, nextN * 8),
      ptrDx: allocBytes(api, nextN * 8),
      ptrXNext: allocBytes(api, nextN * 8),
      ptrMeta: allocBytes(api, 8 * 8)
    };
    optimizerWasmWorkspace = ws;
    return ws;
  } catch {
    optimizerWasmWorkspace = null;
    return null;
  }
}

function asFiniteFloat64Vector(input: any, expectedLen: number): Float64Array | null {
  if (!(expectedLen > 0)) return null;
  const arr = new Float64Array(expectedLen);
  if (Array.isArray(input)) {
    if (input.length < expectedLen) return null;
    for (let i = 0; i < expectedLen; i++) {
      const v = Number(input[i]);
      if (!Number.isFinite(v)) return null;
      arr[i] = v;
    }
    return arr;
  }
  if (ArrayBuffer.isView(input) && typeof (input as any).length === 'number') {
    if ((input as any).length < expectedLen) return null;
    for (let i = 0; i < expectedLen; i++) {
      const v = Number((input as any)[i]);
      if (!Number.isFinite(v)) return null;
      arr[i] = v;
    }
    return arr;
  }
  return null;
}

function asFiniteColMajorResidualBatch(input: any, m: number, n: number): Float64Array | null {
  if (ArrayBuffer.isView(input) && typeof (input as any).length === 'number') {
    if ((input as any).length !== m * n) return null;
    const out = new Float64Array(m * n);
    for (let i = 0; i < m * n; i++) {
      const v = Number((input as any)[i]);
      if (!Number.isFinite(v)) return null;
      out[i] = v;
    }
    return out;
  }
  if (!Array.isArray(input) || input.length !== n) return null;
  const out = new Float64Array(m * n);
  for (let col = 0; col < n; col++) {
    const row = input[col];
    if (!Array.isArray(row) && !(ArrayBuffer.isView(row) && typeof (row as any).length === 'number')) return null;
    if ((row as any).length < m) return null;
    const base = col * m;
    for (let i = 0; i < m; i++) {
      const v = Number((row as any)[i]);
      if (!Number.isFinite(v)) return null;
      out[base + i] = v;
    }
  }
  return out;
}

function setBridgeReason(kind: 'solve' | 'normalEq', reason: string): void {
  if (kind === 'solve') optimizerWasmBridgeDebugState.lastSolveReason = String(reason || 'unknown');
  else optimizerWasmBridgeDebugState.lastNormalEqReason = String(reason || 'unknown');
}

function setPilotReason(reason: string, detail: any = null): void {
  optimizerWasmBridgeDebugState.lastPilotReason = String(reason || 'unknown');
  optimizerWasmBridgeDebugState.lastPilotErrorDetail = detail == null ? null : String(detail);
}

function recordBufferStatus(key: any): void {
  const histogram = (optimizerWasmBridgeDebugState.kktWasmBufferStatusHistogram && typeof optimizerWasmBridgeDebugState.kktWasmBufferStatusHistogram === 'object')
    ? optimizerWasmBridgeDebugState.kktWasmBufferStatusHistogram
    : (optimizerWasmBridgeDebugState.kktWasmBufferStatusHistogram = {});
  const k = String(key == null ? 'unknown' : key);
  histogram[k] = (Number(histogram[k]) || 0) + 1;
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

function normalizeBaseUrl(): string {
  const fromLocation = (() => {
    try {
      const path = String((globalThis as any)?.location?.pathname || '/');
      if (path.startsWith('/co-opt/')) return '/co-opt/';
      return '/';
    } catch {
      return '/';
    }
  })();

  try {
    const raw = (import.meta as any)?.env?.BASE_URL;
    const sRaw = typeof raw === 'string' && raw.length > 0 ? raw : fromLocation;
    const withLeadingSlash = sRaw.startsWith('/') ? sRaw : `/${sRaw}`;
    const normalized = withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
    if (normalized === '/' && fromLocation !== '/') return fromLocation;
    return normalized;
  } catch {
    return fromLocation;
  }
}

async function browserPathExists(path: string): Promise<boolean> {
  try {
    const head = await fetch(path, { method: 'HEAD', cache: 'no-store' });
    if (head.ok) return true;
    if (head.status !== 405) return false;
  } catch {
    return false;
  }

  try {
    const getRes = await fetch(path, { method: 'GET', cache: 'no-store' });
    return getRes.ok;
  } catch {
    return false;
  }
}

async function resolveBrowserModulePath(): Promise<string> {
  const baseUrl = normalizeBaseUrl();
  const candidates = Array.from(new Set([
    `${baseUrl}rust-wasm/pkg/surface_origins.js`
  ]));
  for (const candidate of candidates) {
    if (await browserPathExists(candidate)) return candidate;
  }
  throw new Error(`surface_origins module not found in candidates: ${candidates.join(', ')}`);
}

async function preloadOptimizerDirectWasmModule(): Promise<OptimizerWasmApi | null> {
  if (optimizerDirectApi) return optimizerDirectApi;
  if (!optimizerDirectInitPromise) {
    optimizerDirectInitPromise = (async () => {
      try {
        const modulePath = await resolveBrowserModulePath();
        const mod: any = await import(/* @vite-ignore */ modulePath);

        if (typeof mod?.default === 'function') {
          await mod.default();
        }

        const api: OptimizerWasmApi = {
          solve_spd_linear_system: (typeof mod.solve_spd_linear_system === 'function') ? mod.solve_spd_linear_system : undefined,
          solve_linear_system: (typeof mod.solve_linear_system === 'function') ? mod.solve_linear_system : undefined,
          build_normal_equations: (typeof mod.build_normal_equations === 'function') ? mod.build_normal_equations : undefined,
          normal_eq_matvec: (typeof mod.normal_eq_matvec === 'function') ? mod.normal_eq_matvec : undefined,
          generate_fd_perturbation_points: (typeof mod.generate_fd_perturbation_points === 'function') ? mod.generate_fd_perturbation_points : undefined,
          assemble_fd_jacobian: (typeof mod.assemble_fd_jacobian === 'function') ? mod.assemble_fd_jacobian : undefined,
          assemble_fd_jacobian_grouped: (typeof mod.assemble_fd_jacobian_grouped === 'function') ? mod.assemble_fd_jacobian_grouped : undefined,
          optimize_system_in_wasm: (typeof mod.optimize_system_in_wasm === 'function') ? mod.optimize_system_in_wasm : undefined,
          optimize_one_iter_from_buffers: (typeof mod.optimize_one_iter_from_buffers === 'function') ? mod.optimize_one_iter_from_buffers : undefined,
          malloc: (typeof mod.malloc === 'function') ? mod.malloc : undefined,
          free: (typeof mod.free === 'function') ? mod.free : undefined,
          memory: mod.memory,
          // Phase 1: Linear Algebra Kernels
          vector_add_scaled: (typeof mod.vector_add_scaled === 'function') ? mod.vector_add_scaled : undefined,
          vector_dot: (typeof mod.vector_dot === 'function') ? mod.vector_dot : undefined,
          vector_norm: (typeof mod.vector_norm === 'function') ? mod.vector_norm : undefined,
          matrix_vector_multiply: (typeof mod.matrix_vector_multiply === 'function') ? mod.matrix_vector_multiply : undefined,
          cholesky_factorization: (typeof mod.cholesky_factorization === 'function') ? mod.cholesky_factorization : undefined,
          bfgs_update: (typeof mod.bfgs_update === 'function') ? mod.bfgs_update : undefined,
          qr_factorization: (typeof mod.qr_factorization === 'function') ? mod.qr_factorization : undefined,
          solve_qp_subproblem_unconstrained: (typeof mod.solve_qp_subproblem_unconstrained === 'function') ? mod.solve_qp_subproblem_unconstrained : undefined,
          solve_qp_subproblem_kkt_equality: (typeof mod.solve_qp_subproblem_kkt_equality === 'function') ? mod.solve_qp_subproblem_kkt_equality : undefined,
          backtracking_line_search_armijo: (typeof mod.backtracking_line_search_armijo === 'function') ? mod.backtracking_line_search_armijo : undefined,
          update_trust_region_radius: (typeof mod.update_trust_region_radius === 'function') ? mod.update_trust_region_radius : undefined
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
  const sharedInitError = getRustRayTracingWasmInitError();
  const sharedImportFailed = typeof sharedInitError === 'string'
    && sharedInitError.includes('surface_origins module import failed');
  if (!api && !sharedImportFailed) {
    await preloadOptimizerDirectWasmModule();
    api = getOptimizerApiSync();
  }
  if (!api && sharedImportFailed) {
    optimizerWasmBridgeDebugState.initError = sharedInitError;
  }

  optimizerWasmBridgeDebugState.hasSolveSpd = !!(api && typeof api.solve_spd_linear_system === 'function');
  optimizerWasmBridgeDebugState.hasSolveLinear = !!(api && typeof api.solve_linear_system === 'function');
  optimizerWasmBridgeDebugState.hasBuildNormalEq = !!(api && typeof api.build_normal_equations === 'function');
  optimizerWasmBridgeDebugState.hasFdBatchPoints = !!(api && typeof api.generate_fd_perturbation_points === 'function');
  optimizerWasmBridgeDebugState.hasFdBatchJacobian = !!(api && typeof api.assemble_fd_jacobian === 'function');
  optimizerWasmBridgeDebugState.hasFdBatchJacobianGrouped = !!(api && typeof api.assemble_fd_jacobian_grouped === 'function');
  optimizerWasmBridgeDebugState.hasPilotBufferAbi = !!(
    api
    && typeof api.optimize_one_iter_from_buffers === 'function'
    && typeof api.malloc === 'function'
    && typeof api.free === 'function'
    && !!api.memory?.buffer
  );
  optimizerWasmBridgeDebugState.hasVectorOps = !!(api && typeof api.vector_add_scaled === 'function' && typeof api.vector_dot === 'function' && typeof api.vector_norm === 'function');
  optimizerWasmBridgeDebugState.hasMatrixOps = !!(api && typeof api.matrix_vector_multiply === 'function');
  optimizerWasmBridgeDebugState.hasCholesky = !!(api && typeof api.cholesky_factorization === 'function');
  optimizerWasmBridgeDebugState.hasBfgs = !!(api && typeof api.bfgs_update === 'function');
  optimizerWasmBridgeDebugState.hasQr = !!(api && typeof api.qr_factorization === 'function');
  optimizerWasmBridgeDebugState.hasQpSubproblem = !!(api && typeof api.solve_qp_subproblem_unconstrained === 'function');
  optimizerWasmBridgeDebugState.hasQpKktEqSubproblem = !!(api && typeof api.solve_qp_subproblem_kkt_equality === 'function');
  optimizerWasmBridgeDebugState.hasLineSearchArmijo = !!(api && typeof api.backtracking_line_search_armijo === 'function');
  optimizerWasmBridgeDebugState.hasTrustRegionUpdate = !!(api && typeof api.update_trust_region_radius === 'function');
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

export function generateFiniteDifferencePerturbationPointsWasm(
  x: number[],
  steps: number[]
): number[][] | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.generate_fd_perturbation_points !== 'function') return null;
  if (!Array.isArray(x) || !Array.isArray(steps) || x.length === 0 || x.length !== steps.length) return null;

  const n = x.length;
  const xVec = toFloat64Vector(x, n);
  const hVec = toFloat64Vector(steps, n);
  if (!xVec || !hVec) return null;

  try {
    const out = api.generate_fd_perturbation_points(xVec, hVec, n);
    if (!out || out.length !== n * n) return null;

    const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    for (let row = 0; row < n; row++) {
      const base = row * n;
      for (let col = 0; col < n; col++) {
        const v = Number(out[base + col]);
        if (!Number.isFinite(v)) return null;
        matrix[row][col] = v;
      }
    }
    return matrix;
  } catch {
    return null;
  }
}

export function assembleFiniteDifferenceJacobianWasm(
  baseResiduals: number[],
  perturbedResidualsByColumn: number[][],
  steps: number[]
): number[][] | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.assemble_fd_jacobian !== 'function') return null;
  if (!Array.isArray(baseResiduals) || !Array.isArray(steps)) return null;

  const m = baseResiduals.length;
  const n = steps.length;
  if (m <= 0 || n <= 0) return null;
  if (!Array.isArray(perturbedResidualsByColumn) || perturbedResidualsByColumn.length !== n) return null;

  const r0 = toFloat64Vector(baseResiduals, m);
  const hVec = toFloat64Vector(steps, n);
  if (!r0 || !hVec) return null;

  const rBatchFlat = new Float64Array(m * n);
  for (let col = 0; col < n; col++) {
    const row = perturbedResidualsByColumn[col];
    if (!Array.isArray(row) || row.length < m) return null;
    const base = col * m;
    for (let i = 0; i < m; i++) {
      const v = Number(row[i]);
      if (!Number.isFinite(v)) return null;
      rBatchFlat[base + i] = v;
    }
  }

  try {
    const out = api.assemble_fd_jacobian(r0, rBatchFlat, m, n, hVec);
    if (!out || out.length !== m * n) return null;

    const J: number[][] = Array.from({ length: m }, () => Array(n).fill(0));
    for (let i = 0; i < m; i++) {
      const rowBase = i * n;
      for (let j = 0; j < n; j++) {
        const v = Number(out[rowBase + j]);
        J[i][j] = Number.isFinite(v) ? v : 0;
      }
    }
    return J;
  } catch {
    return null;
  }
}

export function assembleFiniteDifferenceJacobianGroupedWasm(
  baseResiduals: number[],
  perturbedResidualsByActiveColumn: number[][],
  steps: number[],
  activeCols: number[]
): number[][] | null {
  const api = getOptimizerApiSync();
  if (!api) return null;
  if (!Array.isArray(baseResiduals) || !Array.isArray(steps) || !Array.isArray(activeCols)) return null;

  const m = baseResiduals.length;
  const n = steps.length;
  const k = activeCols.length;
  if (m <= 0 || n <= 0) return null;
  if (!Array.isArray(perturbedResidualsByActiveColumn) || perturbedResidualsByActiveColumn.length !== k) return null;

  const r0 = toFloat64Vector(baseResiduals, m);
  const hVec = toFloat64Vector(steps, n);
  if (!r0 || !hVec) return null;

  const colVec = new Uint32Array(k);
  const groupedBatchFlat = new Float64Array(m * k);
  for (let groupedIndex = 0; groupedIndex < k; groupedIndex++) {
    const col = Number(activeCols[groupedIndex]);
    if (!Number.isInteger(col) || col < 0 || col >= n) return null;
    colVec[groupedIndex] = col >>> 0;

    const residuals = perturbedResidualsByActiveColumn[groupedIndex];
    if (!Array.isArray(residuals) || residuals.length < m) return null;
    const base = groupedIndex * m;
    for (let row = 0; row < m; row++) {
      const v = Number(residuals[row]);
      if (!Number.isFinite(v)) return null;
      groupedBatchFlat[base + row] = v;
    }
  }

  const decodeFlatJacobian = (flat: ArrayLike<number>): number[][] | null => {
    if (!flat || (flat as any).length !== m * n) return null;
    const J: number[][] = Array.from({ length: m }, () => Array(n).fill(0));
    for (let row = 0; row < m; row++) {
      const rowBase = row * n;
      for (let col = 0; col < n; col++) {
        const v = Number((flat as any)[rowBase + col]);
        J[row][col] = Number.isFinite(v) ? v : 0;
      }
    }
    return J;
  };

  try {
    if (typeof api.assemble_fd_jacobian_grouped === 'function') {
      const out = api.assemble_fd_jacobian_grouped(r0, groupedBatchFlat, m, n, colVec, hVec);
      return decodeFlatJacobian(out);
    }

    if (typeof api.assemble_fd_jacobian !== 'function') return null;

    // Legacy fallback: expand grouped payload to full n columns.
    const fullBatchFlat = new Float64Array(m * n);
    for (let col = 0; col < n; col++) {
      const base = col * m;
      for (let row = 0; row < m; row++) {
        fullBatchFlat[base + row] = r0[row];
      }
    }
    for (let groupedIndex = 0; groupedIndex < k; groupedIndex++) {
      const col = colVec[groupedIndex];
      const srcBase = groupedIndex * m;
      const dstBase = col * m;
      for (let row = 0; row < m; row++) {
        fullBatchFlat[dstBase + row] = groupedBatchFlat[srcBase + row];
      }
    }
    const out = api.assemble_fd_jacobian(r0, fullBatchFlat, m, n, hVec);
    return decodeFlatJacobian(out);
  } catch {
    return null;
  }
}

export function optimizeSystemOneIterationWasm(payload: {
  x: number[] | ArrayBufferView;
  steps: number[] | ArrayBufferView;
  residual0: number[] | ArrayBufferView;
  residualsPerturbed: number[][] | ArrayBufferView;
  damping?: number;
  trustRegionRadius?: number;
  varScales?: number[] | ArrayBufferView;
}): {
  ok: boolean;
  status: string;
  xNext: number[];
  dx: number[];
  predictedReduction: number;
  jacobianShape?: [number, number];
  usedDamping?: number;
  usedTrustRegionRadius?: number;
} | null {
  const api = getOptimizerApiSync();
  optimizerWasmBridgeDebugState.lastPilotPath = 'none';
  optimizerWasmBridgeDebugState.lastPilotBufferAttempted = false;
  optimizerWasmBridgeDebugState.lastPilotBufferStatus = null;
  if (!api) {
    setPilotReason('api-missing');
    return null;
  }
  if (typeof api.optimize_system_in_wasm !== 'function') {
    if (typeof api.optimize_one_iter_from_buffers !== 'function') {
      setPilotReason('pilot-kernel-missing');
      return null;
    }
  }

  try {
    const getVectorLen = (v: any): number => {
      if (Array.isArray(v)) return v.length;
      if (ArrayBuffer.isView(v) && typeof (v as any).length === 'number') return Number((v as any).length) || 0;
      return 0;
    };

    const n = getVectorLen(payload?.x);
    const m = getVectorLen(payload?.residual0);

    if (
      n > 0
      && m > 0
      && typeof api.optimize_one_iter_from_buffers === 'function'
      && typeof api.malloc === 'function'
      && typeof api.free === 'function'
      && !!api.memory?.buffer
    ) {
      optimizerWasmBridgeDebugState.lastPilotBufferAttempted = true;
      optimizerWasmBridgeDebugState.kktWasmBufferCalls = (Number(optimizerWasmBridgeDebugState.kktWasmBufferCalls) || 0) + 1;
      try {
        const xVec = asFiniteFloat64Vector(payload.x, n);
        const hVec = asFiniteFloat64Vector(payload.steps, n);
        const r0Vec = asFiniteFloat64Vector(payload.residual0, m);
        const rbVec = asFiniteColMajorResidualBatch(payload.residualsPerturbed, m, n);
        const scalesVec = asFiniteFloat64Vector(
          Array.isArray(payload.varScales) && payload.varScales.length === n ? payload.varScales : new Float64Array(n).fill(1),
          n
        );

        if (xVec && hVec && r0Vec && rbVec && scalesVec) {
          const ws = ensureOptimizerWorkspace(api, n, m);
          if (ws && api.memory?.buffer) {
            const xView = new Float64Array(api.memory.buffer, ws.ptrX, n);
            const hView = new Float64Array(api.memory.buffer, ws.ptrSteps, n);
            const r0View = new Float64Array(api.memory.buffer, ws.ptrR0, m);
            const rbView = new Float64Array(api.memory.buffer, ws.ptrRBatches, n * m);
            const scalesView = new Float64Array(api.memory.buffer, ws.ptrScales, n);

            xView.set(xVec);
            hView.set(hVec);
            r0View.set(r0Vec);
            rbView.set(rbVec);
            scalesView.set(scalesVec);

            const statusCode = Number(api.optimize_one_iter_from_buffers(
              ws.ptrX,
              ws.ptrSteps,
              ws.ptrR0,
              ws.ptrRBatches,
              ws.ptrScales,
              ws.ptrDx,
              ws.ptrXNext,
              ws.ptrMeta,
              n,
              m,
              Number(payload?.damping),
              Number(payload?.trustRegionRadius)
            ));

            if (statusCode === 0) {
              const dxView = new Float64Array(api.memory.buffer, ws.ptrDx, n);
              const xNextView = new Float64Array(api.memory.buffer, ws.ptrXNext, n);
              const metaView = new Float64Array(api.memory.buffer, ws.ptrMeta, 8);

              const dx = Array.from(dxView);
              const xNext = Array.from(xNextView);
              const predictedReduction = Number(metaView[0]) || 0;
              const jacM = Number(metaView[3]) || m;
              const jacN = Number(metaView[4]) || n;

              optimizerWasmBridgeDebugState.lastPilotPath = 'buffer';
              optimizerWasmBridgeDebugState.lastPilotBufferStatus = '0';
              optimizerWasmBridgeDebugState.kktWasmBufferHits = (Number(optimizerWasmBridgeDebugState.kktWasmBufferHits) || 0) + 1;
              recordBufferStatus('0');
              setPilotReason('ok', 'buffer-abi');
              return {
                ok: true,
                status: 'pilot-one-iteration-buffer',
                xNext,
                dx,
                predictedReduction,
                jacobianShape: [jacM, jacN],
                usedDamping: Number(metaView[1]),
                usedTrustRegionRadius: Number(metaView[2])
              };
            }

            optimizerWasmBridgeDebugState.lastPilotBufferStatus = String(statusCode);
            optimizerWasmBridgeDebugState.kktWasmBufferFallbacks = (Number(optimizerWasmBridgeDebugState.kktWasmBufferFallbacks) || 0) + 1;
            recordBufferStatus(String(statusCode));
            setPilotReason('buffer-status', String(statusCode));
          }
        } else {
          optimizerWasmBridgeDebugState.lastPilotBufferStatus = 'input-invalid';
          optimizerWasmBridgeDebugState.kktWasmBufferFallbacks = (Number(optimizerWasmBridgeDebugState.kktWasmBufferFallbacks) || 0) + 1;
          recordBufferStatus('input-invalid');
          setPilotReason('buffer-input-invalid');
        }
      } catch (bufferErr) {
        optimizerWasmBridgeDebugState.lastPilotBufferStatus = 'exception';
        optimizerWasmBridgeDebugState.kktWasmBufferFallbacks = (Number(optimizerWasmBridgeDebugState.kktWasmBufferFallbacks) || 0) + 1;
        recordBufferStatus('exception');
        setPilotReason('buffer-exception', (bufferErr as any)?.message || bufferErr);
      }
    }

    const isNumericTypedArray = (value: any): value is
      Int8Array |
      Uint8Array |
      Uint8ClampedArray |
      Int16Array |
      Uint16Array |
      Int32Array |
      Uint32Array |
      Float32Array |
      Float64Array => {
      return value instanceof Int8Array ||
        value instanceof Uint8Array ||
        value instanceof Uint8ClampedArray ||
        value instanceof Int16Array ||
        value instanceof Uint16Array ||
        value instanceof Int32Array ||
        value instanceof Uint32Array ||
        value instanceof Float32Array ||
        value instanceof Float64Array;
    };

    const normalizeNumericVector = (v: any): number[] => {
      if (Array.isArray(v)) {
        return v.map((item) => Number(item)).filter((item) => Number.isFinite(item));
      }
      if (isNumericTypedArray(v)) {
        return Array.from(v).map((item) => Number(item)).filter((item) => Number.isFinite(item));
      }
      if (v && typeof v === 'object' && typeof (v as any)[Symbol.iterator] === 'function') {
        try {
          return Array.from(v as Iterable<any>).map((item) => Number(item)).filter((item) => Number.isFinite(item));
        } catch {
          return [];
        }
      }
      return [];
    };

    if (typeof api.optimize_system_in_wasm !== 'function') {
      return null;
    }
    optimizerWasmBridgeDebugState.lastPilotPath = 'json';
    const raw = api.optimize_system_in_wasm(JSON.stringify(payload));
    if (!raw) {
      setPilotReason('result-null-or-empty');
      return null;
    }
    
    let parsed: any;
    try {
      // The Rust function now returns a JSON string, not an object
      if (typeof raw === 'string') {
        parsed = JSON.parse(raw);
      } else if (typeof raw === 'object') {
        parsed = raw;
      } else {
        setPilotReason('result-invalid-type', `expected string or object, got ${typeof raw}`);
        return null;
      }
    } catch (err) {
      setPilotReason('result-parse-error', `${err}`);
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      setPilotReason('result-invalid-object');
      return null;
    }

    const xNext = normalizeNumericVector((parsed as any).xNext);
    const dx = normalizeNumericVector((parsed as any).dx);

    if (xNext.length > 0 && xNext.length !== n) {
      setPilotReason('result-xNext-size-mismatch', `expected=${n}, actual=${xNext.length}`);
      return null;
    }
    if (dx.length !== n) {
      setPilotReason('result-dx-size-mismatch', `expected=${n}, actual=${dx.length}`);
      return null;
    }

    const ok = !!(parsed as any).ok;
    setPilotReason(ok ? 'ok' : 'result-not-ok', (parsed as any).status);

    return {
      ok,
      status: String((parsed as any).status || ''),
      xNext,
      dx,
      predictedReduction: Number((parsed as any).predictedReduction) || 0,
      jacobianShape: Array.isArray((parsed as any).jacobianShape) && (parsed as any).jacobianShape.length === 2
        ? [Number((parsed as any).jacobianShape[0]) || 0, Number((parsed as any).jacobianShape[1]) || 0]
        : undefined,
      usedDamping: Number((parsed as any).usedDamping),
      usedTrustRegionRadius: Number((parsed as any).usedTrustRegionRadius)
    };
  } catch (e) {
    setPilotReason('exception', (e as any)?.message || e);
    return null;
  }
}

// ============================================================================
// Phase 1: Linear Algebra Kernel Wrappers
// ============================================================================

/**
 * Vector addition with scaling: result = x + alpha * y
 */
export function vectorAddScaledWasm(x: number[], y: number[], alpha: number): number[] | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.vector_add_scaled !== 'function') {
    return null;
  }
  if (x.length !== y.length) {
    return null;
  }
  
  try {
    const xVec = new Float64Array(x);
    const yVec = new Float64Array(y);
    const result = api.vector_add_scaled(xVec, yVec, alpha);
    return Array.from(result).map(v => Number(v));
  } catch {
    return null;
  }
}

/**
 * Vector dot product: result = x · y
 */
export function vectorDotWasm(x: number[], y: number[]): number | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.vector_dot !== 'function') {
    return null;
  }
  if (x.length !== y.length) {
    return null;
  }
  
  try {
    const xVec = new Float64Array(x);
    const yVec = new Float64Array(y);
    const result = api.vector_dot(xVec, yVec);
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Vector L2 norm: result = ||x||₂
 */
export function vectorNormWasm(x: number[]): number | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.vector_norm !== 'function') {
    return null;
  }
  
  try {
    const xVec = new Float64Array(x);
    const result = api.vector_norm(xVec);
    return Number.isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Matrix-vector multiplication: result = A * x
 */
export function matrixVectorMultiplyWasm(matrix: number[][], x: number[]): number[] | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.matrix_vector_multiply !== 'function') {
    return null;
  }
  
  const rows = matrix.length;
  if (rows === 0) return null;
  const cols = matrix[0].length;
  if (cols !== x.length) return null;
  
  const aFlat = flattenRectMatrix(matrix, rows, cols);
  if (!aFlat) return null;
  
  try {
    const xVec = new Float64Array(x);
    const result = api.matrix_vector_multiply(aFlat, xVec, rows, cols);
    const out = Array.from(result).map(v => Number(v));
    if (out.length !== rows) return null;
    for (const v of out) {
      if (!Number.isFinite(v)) return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Matrix-free normal equation matvec: result = (J^T J + damping * I) * v
 */
export function normalEqMatvecWasm(jacobian: number[][], v: number[], damping: number): number[] | null {
  const m = jacobian.length;
  if (m <= 0) return null;
  const n = Array.isArray(jacobian[0]) ? jacobian[0].length : 0;
  if (n <= 0 || v.length !== n) return null;

  const jFlat = flattenRectMatrix(jacobian, m, n);
  if (!jFlat) return null;

  return normalEqMatvecFlatWasm(jFlat, m, n, v, damping);
}

/**
 * Matrix-free normal equation matvec: result = (J^T J + damping * I) * v
 * Accepts pre-flattened row-major Jacobian to avoid repeated flatten overhead.
 */
export function normalEqMatvecFlatWasm(
  jFlatInput: Float64Array | number[],
  m: number,
  n: number,
  v: number[],
  damping: number
): number[] | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.normal_eq_matvec !== 'function') {
    return null;
  }

  const mm = Math.max(0, Math.floor(Number(m)));
  const nn = Math.max(0, Math.floor(Number(n)));
  if (mm <= 0 || nn <= 0 || !Array.isArray(v) || v.length !== nn) return null;

  let jFlat: Float64Array | null = null;
  if (jFlatInput instanceof Float64Array) {
    if (jFlatInput.length !== mm * nn) return null;
    jFlat = jFlatInput;
  } else if (Array.isArray(jFlatInput)) {
    if (jFlatInput.length !== mm * nn) return null;
    jFlat = toFloat64Vector(jFlatInput, mm * nn);
  }
  if (!jFlat) return null;

  for (let i = 0; i < jFlat.length; i++) {
    if (!Number.isFinite(Number(jFlat[i]))) return null;
  }

  const vVec = toFloat64Vector(v, nn);
  if (!vVec) return null;

  const lambda = Number(damping);
  if (!Number.isFinite(lambda)) return null;

  try {
    const result = api.normal_eq_matvec(jFlat, mm, nn, vVec, lambda);
    const out = Array.from(result).map((value) => Number(value));
    if (out.length !== nn) return null;
    for (const value of out) {
      if (!Number.isFinite(value)) return null;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Cholesky factorization: A = L * L^T
 * Returns lower triangular matrix L
 */
export function choleskyFactorizationWasm(matrix: number[][]): number[][] | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.cholesky_factorization !== 'function') {
    return null;
  }
  
  const packed = flattenSquareMatrix(matrix);
  if (!packed) return null;
  
  try {
    const result = api.cholesky_factorization(packed.flat, packed.n);
    if (!result || result.length === 0) return null; // Not positive definite
    if (result.length !== packed.n * packed.n) return null;
    
    const L: number[][] = Array.from({ length: packed.n }, () => Array(packed.n).fill(0));
    for (let i = 0; i < packed.n; i++) {
      for (let j = 0; j < packed.n; j++) {
        L[i][j] = result[i * packed.n + j];
        if (!Number.isFinite(L[i][j])) return null;
      }
    }
    return L;
  } catch {
    return null;
  }
}

/**
 * BFGS Hessian approximation update (in-place)
 * Updates H using: H_new = H + (y*y^T)/(y^T*s) - (H*s*(H*s)^T)/(s^T*H*s)
 * Returns true if update succeeded
 */
export function bfgsUpdateWasm(H: number[][], step: number[], gradDiff: number[]): boolean {
  const api = getOptimizerApiSync();
  if (!api || typeof api.bfgs_update !== 'function') {
    return false;
  }
  
  const packed = flattenSquareMatrix(H);
  if (!packed) return false;
  if (step.length !== packed.n || gradDiff.length !== packed.n) return false;
  
  try {
    const hFlat = packed.flat; // This is a Float64Array which is mutable
    const sVec = new Float64Array(step);
    const yVec = new Float64Array(gradDiff);
    
    const success = api.bfgs_update(hFlat, sVec, yVec, packed.n);
    if (!success) return false;
    
    // Copy updated values back to H
    for (let i = 0; i < packed.n; i++) {
      for (let j = 0; j < packed.n; j++) {
        H[i][j] = hFlat[i * packed.n + j];
      }
    }
    
    return true;
  } catch {
    return false;
  }
}

/**
 * QR factorization using Householder reflections
 * Returns { Q, R } where Q is orthogonal and R is upper triangular
 */
export function qrFactorizationWasm(matrix: number[][]): { Q: number[][]; R: number[][] } | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.qr_factorization !== 'function') {
    return null;
  }
  
  const rows = matrix.length;
  if (rows === 0) return null;
  const cols = matrix[0].length;
  if (rows < cols) return null; // Underdetermined
  
  const aFlat = flattenRectMatrix(matrix, rows, cols);
  if (!aFlat) return null;
  
  try {
    const result = api.qr_factorization(aFlat, rows, cols);
    if (!result || result.length === 0) return null;
    
    // Result format: [n_rows, n_cols, Q_data..., R_data...]
    const expectedLen = 2 + rows * rows + rows * cols;
    if (result.length !== expectedLen) return null;
    
    const resRows = Math.round(result[0]);
    const resCols = Math.round(result[1]);
    if (resRows !== rows || resCols !== cols) return null;
    
    const Q: number[][] = Array.from({ length: rows }, () => Array(rows).fill(0));
    const R: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
    
    let offset = 2;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < rows; j++) {
        Q[i][j] = result[offset++];
        if (!Number.isFinite(Q[i][j])) return null;
      }
    }
    
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        R[i][j] = result[offset++];
        if (!Number.isFinite(R[i][j])) return null;
      }
    }
    
    return { Q, R };
  } catch {
    return null;
  }
}

/**
 * Phase 2: Solve unconstrained SQP QP subproblem in Rust
 *   min 0.5 * dx^T * H * dx + g^T * dx
 * returns { dx, predictedReduction }
 */
export function solveQpSubproblemUnconstrainedWasm(
  hessian: number[][],
  gradient: number[],
  damping: number = 1e-10
): { dx: number[]; predictedReduction: number } | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.solve_qp_subproblem_unconstrained !== 'function') {
    return null;
  }

  const packed = flattenSquareMatrix(hessian);
  if (!packed) return null;
  const gVec = toFloat64Vector(gradient, packed.n);
  if (!gVec) return null;

  try {
    const out = api.solve_qp_subproblem_unconstrained(packed.flat, packed.n, gVec, damping);
    if (!out || typeof (out as any).length !== 'number') return null;
    const arr = Array.from(out as Float64Array).map((v) => Number(v));
    if (arr.length !== packed.n + 1) return null;

    const dx = arr.slice(0, packed.n);
    const predictedReduction = arr[packed.n];
    if (!Number.isFinite(predictedReduction)) return null;
    for (const v of dx) {
      if (!Number.isFinite(v)) return null;
    }

    return { dx, predictedReduction };
  } catch {
    return null;
  }
}

/**
 * Phase 2: Solve equality-constrained SQP QP subproblem in Rust
 *   min 0.5 * dx^T * H * dx + g^T * dx
 *   s.t. A * dx + c = 0
 * returns { dx, predictedReduction }
 */
export function solveQpSubproblemKktEqualityWasm(
  hessian: number[][],
  gradient: number[],
  aEq: number[][],
  cEq: number[],
  damping: number = 1e-10
): { dx: number[]; predictedReduction: number } | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.solve_qp_subproblem_kkt_equality !== 'function') {
    return null;
  }

  const packedH = flattenSquareMatrix(hessian);
  if (!packedH) return null;
  const gVec = toFloat64Vector(gradient, packedH.n);
  if (!gVec) return null;

  const m = Math.max(0, Math.floor(Number(aEq.length)));
  if (m <= 0) {
    return solveQpSubproblemUnconstrainedWasm(hessian, gradient, damping);
  }
  const aFlat = flattenRectMatrix(aEq, m, packedH.n);
  if (!aFlat) return null;
  const cVec = toFloat64Vector(cEq, m);
  if (!cVec) return null;

  try {
    const out = api.solve_qp_subproblem_kkt_equality(packedH.flat, packedH.n, gVec, aFlat, m, cVec, damping);
    if (!out || typeof (out as any).length !== 'number') return null;
    const arr = Array.from(out as Float64Array).map((v) => Number(v));
    if (arr.length !== packedH.n + 1) return null;

    const dx = arr.slice(0, packedH.n);
    const predictedReduction = arr[packedH.n];
    if (!Number.isFinite(predictedReduction)) return null;
    for (const v of dx) {
      if (!Number.isFinite(v)) return null;
    }

    return { dx, predictedReduction };
  } catch {
    return null;
  }
}

/**
 * Phase 3: Armijo backtracking line search via Rust/WASM callback loop
 */
export function backtrackingLineSearchArmijoWasm(
  x: number[],
  direction: number[],
  f0: number,
  grad0: number[],
  alphaInit: number,
  rho: number,
  c1: number,
  maxIter: number,
  meritEvaluator: (trialX: number[]) => number
): number | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.backtracking_line_search_armijo !== 'function') {
    return null;
  }
  if (!Array.isArray(x) || !Array.isArray(direction) || !Array.isArray(grad0)) {
    return null;
  }
  if (x.length !== direction.length || x.length !== grad0.length || x.length === 0) {
    return null;
  }

  const xVec = toFloat64Vector(x, x.length);
  const pVec = toFloat64Vector(direction, direction.length);
  const gVec = toFloat64Vector(grad0, grad0.length);
  if (!xVec || !pVec || !gVec) return null;

  try {
    const alpha = api.backtracking_line_search_armijo(
      xVec,
      pVec,
      f0,
      gVec,
      alphaInit,
      rho,
      c1,
      maxIter,
      (trialX: Float64Array) => {
        const val = meritEvaluator(Array.from(trialX).map((v) => Number(v)));
        return Number.isFinite(val) ? val : Number.NaN;
      }
    );
    return Number.isFinite(alpha) ? alpha : null;
  } catch {
    return null;
  }
}

/**
 * Phase 3: Trust-region radius update helper via Rust/WASM
 */
export function updateTrustRegionRadiusWasm(
  predictedReduction: number,
  actualReduction: number,
  currentRadius: number,
  eta1: number = 0.25,
  eta2: number = 0.75,
  gammaDec: number = 0.5,
  gammaInc: number = 2.0,
  minRadius: number = 1e-8,
  maxRadius: number = 1e8
): number | null {
  const api = getOptimizerApiSync();
  if (!api || typeof api.update_trust_region_radius !== 'function') {
    return null;
  }
  try {
    const r = api.update_trust_region_radius(
      predictedReduction,
      actualReduction,
      currentRadius,
      eta1,
      eta2,
      gammaDec,
      gammaInc,
      minRadius,
      maxRadius
    );
    return Number.isFinite(r) ? r : null;
  } catch {
    return null;
  }
}
