type RustRayTracingWasm = {
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
  trace_ray_batch_with_system_json: (rayArrayPtr: number, systemMetaJSON: string, rowCount: number, nStart: number) => any;
  fft_2d_forward: (realPtr: number, imagPtr: number, rows: number, cols: number, realOutPtr: number, imagOutPtr: number) => any;
  fft_2d_inverse: (realPtr: number, imagPtr: number, rows: number, cols: number, realOutPtr: number, imagOutPtr: number) => any;
  solve_spd_linear_system?: (aFlat: Float64Array, n: number, b: Float64Array) => Float64Array;
  solve_linear_system?: (aFlat: Float64Array, n: number, b: Float64Array) => Float64Array;
  build_normal_equations?: (jFlat: Float64Array, m: number, n: number, r: Float64Array) => Float64Array;
  malloc: (size: number) => number;
  free: (ptr: number) => void;
  memory: { buffer: ArrayBuffer };
};

let rustWasmApi: RustRayTracingWasm | null = null;
let rustWasmInitPromise: Promise<RustRayTracingWasm | null> | null = null;
let rustWasmInitError: string | null = null;
const isNodeRuntime = typeof process !== 'undefined' && !!(process as any)?.versions?.node;

async function importSurfaceOriginsModule(): Promise<any> {
  const errors: string[] = [];

  const baseUrl = (() => {
    try {
      const raw = (import.meta as any)?.env?.BASE_URL;
      const s = typeof raw === 'string' && raw.length > 0 ? raw : '/';
      return s.endsWith('/') ? s : `${s}/`;
    } catch {
      return '/';
    }
  })();

  const publicPath = `${baseUrl}rust-wasm/pkg/surface_origins.js`;

  try {
    return await import(/* @vite-ignore */ publicPath);
  } catch (e) {
    errors.push(`public:${String((e as any)?.message || e || 'failed')}`);
  }

  throw new Error(`surface_origins module import failed (${errors.join(' | ')})`);
}

async function initRustRayTracingModule(mod: any): Promise<void> {
  if (typeof mod?.default !== 'function') return;
  if (!isNodeRuntime) {
    await mod.default();
    return;
  }

  // Node.js only - load WASM from filesystem
  try {
    // @ts-ignore - These imports only exist in Node.js
    const { readFile } = await (globalThis as any).__vite_ssr_import?.('node:fs/promises') || { readFile: null };
    // @ts-ignore
    const { fileURLToPath } = await (globalThis as any).__vite_ssr_import?.('node:url') || { fileURLToPath: null };
    
    if (!readFile || !fileURLToPath) return;
    
    const wasmUrl = new URL('../../rust-wasm/pkg/surface_origins_bg.wasm', import.meta.url);
    const wasmPath = fileURLToPath(wasmUrl);
    const bytes = await readFile(wasmPath);
    await mod.default({ module_or_path: bytes });
  } catch {
    // Fail silently in browser context
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
  if (!rustWasmInitPromise) {
    rustWasmInitPromise = (async () => {
      try {
        const mod = await importSurfaceOriginsModule();
        await initRustRayTracingModule(mod);
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
          trace_ray_batch_with_system_json: mod.trace_ray_batch_with_system_json,
          fft_2d_forward: mod.fft_2d_forward,
          fft_2d_inverse: mod.fft_2d_inverse,
          solve_spd_linear_system: mod.solve_spd_linear_system,
          solve_linear_system: mod.solve_linear_system,
          build_normal_equations: mod.build_normal_equations,
          malloc: mod.malloc,
          free: mod.free,
          memory: mod.memory
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
          typeof api.fft_2d_inverse !== 'function' ||
          typeof api.malloc !== 'function' ||
          typeof api.free !== 'function' ||
          !api.memory?.buffer
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
