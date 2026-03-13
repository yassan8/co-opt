import {
  REQUIRED_RUST_RAYTRACING_WASM_FUNCTIONS,
  type RequiredRustRayTracingWasmFunction
} from '../../../src/shared/contracts/wasm.ts';

export type RustRayTracingWasm = {
  intersect_aspheric_rt10: (ray: Float64Array, params: Float64Array, modeOdd: number, maxIter: number, tol: number) => number;
  intersect_aspheric_rt10_batch: (rays: Float64Array, rayCount: number, params: Float64Array, modeOdd: number, maxIter: number, tol: number) => Float64Array;
  surface_normal_aspheric_rt10: (pt: Float64Array, params: Float64Array, modeOdd: number) => Float64Array;
  surface_normal_aspheric_rt10_batch: (points: Float64Array, count: number, params: Float64Array, modeOdd: number) => Float64Array;
  batch_mat3_mul_vec3: (mat: Float64Array, vecs: Float64Array, count: number) => Float64Array;
  transform_ray_to_local_batch: (pos: Float64Array, dir: Float64Array, origin: Float64Array, invMat: Float64Array, count: number) => Float64Array;
  transform_point_to_global_batch: (points: Float64Array, origin: Float64Array, rotMat: Float64Array, count: number) => Float64Array;
  refract_ray_batch: (dirs: Float64Array, normals: Float64Array, n1: Float64Array, n2: Float64Array, count: number) => Float64Array;
  reflect_ray_batch: (dirs: Float64Array, normals: Float64Array, count: number) => Float64Array;
  advance_ray_batch: (pos: Float64Array, dirs: Float64Array, thickness: number, count: number) => Float64Array;
  calculate_surface_origins: (rows: any[]) => any;
  generate_annular_offsets_flat?: (rayCount: number, maxRadius: number, ringCount: number) => Float64Array | number[];
  generate_centered_grid_offsets_flat?: (rayCount: number, halfExtent: number) => Float64Array | number[];
  generate_parallel_start_points_flat?: (
    origin: Float64Array | number[],
    uAxis: Float64Array | number[],
    vAxis: Float64Array | number[],
    offsets: Float64Array | number[],
    count: number
  ) => Float64Array | number[];
  trace_ray_batch_with_system_json: (rayArrayPtr: number, systemMetaJSON: string, rowCount: number, nStart: number) => any;
  run_native_opd_map_wasm_json?: (reqJson: string) => any;
  trace_single_ray_hit_point_with_meta?: (
    ray: Float64Array,
    targetSurfaceIndex: number,
    nStart: number,
    rowMeta: Int32Array,
    rowParams: Float64Array,
    rowOrigins: Float64Array,
    rowInvRots: Float64Array,
    rowRots: Float64Array,
    rowCount: number
  ) => Float64Array | number[];
  trace_ray_batch_hit_point_with_meta?: (
    rays: Float64Array,
    rayCount: number,
    targetSurfaceIndex: number,
    nStart: number,
    rowMeta: Int32Array,
    rowParams: Float64Array,
    rowOrigins: Float64Array,
    rowInvRots: Float64Array,
    rowRots: Float64Array,
    rowCount: number
  ) => Float64Array | number[];
  solve_ray_origins_to_stop_points_with_meta_batch?: (
    initialOrigins: Float64Array,
    dirs: Float64Array,
    stopTargets: Float64Array,
    rayCount: number,
    stopSurfaceIndex: number,
    wavelengthUm: number,
    nStart: number,
    rowMeta: Int32Array,
    rowParams: Float64Array,
    rowOrigins: Float64Array,
    rowInvRots: Float64Array,
    rowRots: Float64Array,
    rowCount: number,
    maxIter: number,
    tolMm: number,
    eps: number,
    maxStep: number
  ) => Float64Array | number[];
  fft_2d_forward: (realPtr: number, imagPtr: number, rows: number, cols: number, realOutPtr: number, imagOutPtr: number) => any;
  fft_2d_inverse: (realPtr: number, imagPtr: number, rows: number, cols: number, realOutPtr: number, imagOutPtr: number) => any;
  fft_2d_forward_arrays?: (real: Float64Array, imag: Float64Array, rows: number, cols: number) => { real: Float64Array; imag: Float64Array; meta?: any };
  fft_2d_inverse_arrays?: (real: Float64Array, imag: Float64Array, rows: number, cols: number) => { real: Float64Array; imag: Float64Array; meta?: any };
  solve_spd_linear_system?: (aFlat: Float64Array, n: number, b: Float64Array) => Float64Array;
  solve_linear_system?: (aFlat: Float64Array, n: number, b: Float64Array) => Float64Array;
  build_normal_equations?: (jFlat: Float64Array, m: number, n: number, r: Float64Array) => Float64Array;
  generate_fd_perturbation_points?: (x: Float64Array, steps: Float64Array, n: number) => Float64Array;
  assemble_fd_jacobian?: (r0: Float64Array, rBatches: Float64Array, m: number, n: number, steps: Float64Array) => Float64Array;
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
  // Phase 1: Linear Algebra Kernels
  vector_add_scaled?: (x: Float64Array, y: Float64Array, alpha: number) => Float64Array;
  vector_dot?: (x: Float64Array, y: Float64Array) => number;
  vector_norm?: (x: Float64Array) => number;
  matrix_vector_multiply?: (aFlat: Float64Array, x: Float64Array, rows: number, cols: number) => Float64Array;
  normal_eq_matvec?: (jFlat: Float64Array, m: number, n: number, v: Float64Array, damping: number) => Float64Array;
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
  compute_lca_series_from_image_heights?: (
    fieldValues: Float64Array | number[],
    wavelengths: Float64Array | number[],
    referenceWavelength: number,
    imageHeightsFlat: Float64Array | number[]
  ) => any;
  malloc?: (size: number) => number;
  free?: (ptr: number) => void;
  memory?: { buffer: ArrayBuffer };
};

let rustWasmApi: RustRayTracingWasm | null = null;
let rustWasmInitPromise: Promise<RustRayTracingWasm | null> | null = null;
let rustWasmInitError: string | null = null;
let rustWasmLastInitAttemptMs = 0;
const RUST_WASM_RETRY_COOLDOWN_MS = 1000;
const isNodeRuntime = typeof process !== 'undefined' && !!(process as any)?.versions?.node;

export function getMissingRequiredRustRayTracingWasmFunctions(api: unknown): RequiredRustRayTracingWasmFunction[] {
  return REQUIRED_RUST_RAYTRACING_WASM_FUNCTIONS.filter((name) => {
    const fn = (api as any)?.[name];
    return typeof fn !== 'function';
  });
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

function buildBrowserModuleCandidates(): string[] {
  const baseUrl = normalizeBaseUrl();
  const candidates = [
    `${baseUrl}rust-wasm/pkg/surface_origins.js`
  ];
  return Array.from(new Set(candidates));
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
  const candidates = buildBrowserModuleCandidates();
  for (const candidate of candidates) {
    if (await browserPathExists(candidate)) return candidate;
  }
  throw new Error(`surface_origins module not found in candidates: ${candidates.join(', ')}`);
}

async function importSurfaceOriginsModule(): Promise<any> {
  try {
    if (isNodeRuntime) {
      const moduleUrl = new URL('../../pkg/surface_origins.js', import.meta.url).href;
      const mod = await import(/* @vite-ignore */ moduleUrl);
      return mod;
    }

    const modulePath = await resolveBrowserModulePath();
    const mod = await import(/* @vite-ignore */ modulePath);
    try {
      console.log(`✅ [Rust-WASM] Loaded module from: ${modulePath}`);
    } catch (_) {}
    return mod;
  } catch (e) {
    throw new Error(`surface_origins module import failed (${String((e as any)?.message || e || 'failed')})`);
  }
}

async function initRustRayTracingModule(mod: any): Promise<any> {
  if (typeof mod?.default !== 'function') return null;
  if (!isNodeRuntime) {
    const exportsObj = await mod.default();
    return exportsObj || null;
  }

  // Node.js only - load WASM from filesystem
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    
    const wasmUrl = new URL('../../pkg/surface_origins_bg.wasm', import.meta.url);
    const wasmPath = fileURLToPath(wasmUrl);
    const bytes = await readFile(wasmPath);
    const exportsObj = await mod.default({ module_or_path: bytes });
    return exportsObj || null;
  } catch {
    // Fail silently in browser context
    return null;
  }
}

export function getRustRayTracingWasmSync(): RustRayTracingWasm | null {
  return rustWasmApi;
}

export function getRustRayTracingWasmInitError(): string | null {
  return rustWasmInitError;
}

export async function preloadRustRayTracingWasm(): Promise<RustRayTracingWasm | null> {
  if (rustWasmApi) return rustWasmApi;
  const now = Date.now();
  if (
    rustWasmInitError
    && (now - rustWasmLastInitAttemptMs) < RUST_WASM_RETRY_COOLDOWN_MS
  ) {
    return null;
  }
  if (!rustWasmInitPromise) {
    rustWasmInitPromise = (async () => {
      try {
        rustWasmLastInitAttemptMs = Date.now();
        const mod = await importSurfaceOriginsModule();
        const initExports = await initRustRayTracingModule(mod);
        const api: RustRayTracingWasm = {
          intersect_aspheric_rt10: mod.intersect_aspheric_rt10,
          intersect_aspheric_rt10_batch: mod.intersect_aspheric_rt10_batch,
          surface_normal_aspheric_rt10: mod.surface_normal_aspheric_rt10,
          surface_normal_aspheric_rt10_batch: mod.surface_normal_aspheric_rt10_batch,
          batch_mat3_mul_vec3: mod.batch_mat3_mul_vec3,
          transform_ray_to_local_batch: mod.transform_ray_to_local_batch,
          transform_point_to_global_batch: mod.transform_point_to_global_batch,
          refract_ray_batch: mod.refract_ray_batch,
          reflect_ray_batch: mod.reflect_ray_batch,
          advance_ray_batch: mod.advance_ray_batch,
          calculate_surface_origins: mod.calculate_surface_origins,
          generate_annular_offsets_flat: mod.generate_annular_offsets_flat,
          generate_centered_grid_offsets_flat: mod.generate_centered_grid_offsets_flat,
          generate_parallel_start_points_flat: mod.generate_parallel_start_points_flat,
          trace_ray_batch_with_system_json: mod.trace_ray_batch_with_system_json,
          run_native_opd_map_wasm_json: mod.run_native_opd_map_wasm_json,
          trace_single_ray_hit_point_with_meta: mod.trace_single_ray_hit_point_with_meta,
          trace_ray_batch_hit_point_with_meta: mod.trace_ray_batch_hit_point_with_meta,
          solve_ray_origins_to_stop_points_with_meta_batch: mod.solve_ray_origins_to_stop_points_with_meta_batch,
          fft_2d_forward: mod.fft_2d_forward,
          fft_2d_inverse: mod.fft_2d_inverse,
          fft_2d_forward_arrays: mod.fft_2d_forward_arrays,
          fft_2d_inverse_arrays: mod.fft_2d_inverse_arrays,
          solve_spd_linear_system: mod.solve_spd_linear_system,
          solve_linear_system: mod.solve_linear_system,
          build_normal_equations: mod.build_normal_equations,
          generate_fd_perturbation_points: mod.generate_fd_perturbation_points,
          assemble_fd_jacobian: mod.assemble_fd_jacobian,
          optimize_system_in_wasm: mod.optimize_system_in_wasm,
          optimize_one_iter_from_buffers: mod.optimize_one_iter_from_buffers,
          vector_add_scaled: mod.vector_add_scaled,
          vector_dot: mod.vector_dot,
          vector_norm: mod.vector_norm,
          matrix_vector_multiply: mod.matrix_vector_multiply,
          normal_eq_matvec: mod.normal_eq_matvec,
          cholesky_factorization: mod.cholesky_factorization,
          bfgs_update: mod.bfgs_update,
          qr_factorization: mod.qr_factorization,
          solve_qp_subproblem_unconstrained: mod.solve_qp_subproblem_unconstrained,
          solve_qp_subproblem_kkt_equality: mod.solve_qp_subproblem_kkt_equality,
          backtracking_line_search_armijo: mod.backtracking_line_search_armijo,
          update_trust_region_radius: mod.update_trust_region_radius,
          compute_lca_series_from_image_heights: mod.compute_lca_series_from_image_heights,
          malloc: mod.malloc,
          free: mod.free,
          memory: mod.memory || initExports?.memory
        };
        if (
          typeof api.intersect_aspheric_rt10 !== 'function' ||
          typeof api.intersect_aspheric_rt10_batch !== 'function' ||
          typeof api.surface_normal_aspheric_rt10 !== 'function' ||
          typeof api.surface_normal_aspheric_rt10_batch !== 'function' ||
          typeof api.batch_mat3_mul_vec3 !== 'function' ||
          typeof api.transform_ray_to_local_batch !== 'function' ||
          typeof api.transform_point_to_global_batch !== 'function' ||
          typeof api.refract_ray_batch !== 'function' ||
          typeof api.reflect_ray_batch !== 'function' ||
          typeof api.advance_ray_batch !== 'function' ||
          typeof api.calculate_surface_origins !== 'function' ||
          typeof api.trace_ray_batch_with_system_json !== 'function' ||
          typeof api.fft_2d_forward !== 'function' ||
          typeof api.fft_2d_inverse !== 'function'
        ) {
          rustWasmInitError = 'Rust WASM exports are missing required functions.';
          rustWasmApi = null;
          return null;
        }
        rustWasmApi = api;
        rustWasmInitError = null;
        return api;
      } catch (error) {
        rustWasmInitError = String((error as any)?.message || error || 'Rust WASM init failed');
        rustWasmApi = null;
        return null;
      }
    })();
  }

  try {
    return await rustWasmInitPromise;
  } finally {
    rustWasmInitPromise = null;
  }
}
