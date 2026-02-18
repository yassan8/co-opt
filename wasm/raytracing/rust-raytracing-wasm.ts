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
};

let rustWasmApi: RustRayTracingWasm | null = null;
let rustWasmInitPromise: Promise<RustRayTracingWasm | null> | null = null;
let rustWasmInitError: string | null = null;
const isNodeRuntime = typeof process !== 'undefined' && !!(process as any)?.versions?.node;

async function initRustRayTracingModule(mod: any): Promise<void> {
  if (typeof mod?.default !== 'function') return;
  if (!isNodeRuntime) {
    await mod.default();
    return;
  }

  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const wasmUrl = new URL('../../rust-wasm/pkg/surface_origins_bg.wasm', import.meta.url);
  const wasmPath = fileURLToPath(wasmUrl);
  const bytes = await readFile(wasmPath);
  await mod.default({ module_or_path: bytes });
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
        const mod = await import('../../rust-wasm/pkg/surface_origins.js');
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
          trace_ray_batch_with_system_json: mod.trace_ray_batch_with_system_json
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
          typeof api.trace_ray_batch_with_system_json !== 'function'
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
