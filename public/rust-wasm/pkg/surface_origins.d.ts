/* tslint:disable */
/* eslint-disable */

export function advance_ray_batch(pos: Float64Array, dirs: Float64Array, thickness: number, count: number): Float64Array;

export function batch_mat3_mul_vec3(mat: Float64Array, vecs: Float64Array, count: number): Float64Array;

export function build_normal_equations(j_flat: Float64Array, m: number, n: number, r: Float64Array): Float64Array;

export function calculate_surface_origins(optical_system_rows: any[]): any;

/**
 *
 * * High-performance 2D FFT for PSF calculation
 * * Input: real[rows*cols], imag[rows*cols] (WASM memory pointers)
 * * Output: real_out[rows*cols], imag_out[rows*cols]
 * * Returns: metadata JSON with timing info
 *
 */
export function fft_2d_forward(real_ptr: number, imag_ptr: number, rows: number, cols: number, real_out_ptr: number, imag_out_ptr: number): any;

/**
 *
 * * 2D Inverse FFT (IFFT)
 *
 */
export function fft_2d_inverse(real_ptr: number, imag_ptr: number, rows: number, cols: number, real_out_ptr: number, imag_out_ptr: number): any;

export function intersect_aspheric_rt10(ray: Float64Array, params: Float64Array, mode_odd: number, max_iter: number, tol: number): number;

export function intersect_aspheric_rt10_batch(rays: Float64Array, ray_count: number, params: Float64Array, mode_odd: number, max_iter: number, tol: number): Float64Array;

export function reflect_ray_batch(dirs: Float64Array, normals: Float64Array, count: number): Float64Array;

export function refract_ray_batch(dirs: Float64Array, normals: Float64Array, n1: Float64Array, n2: Float64Array, count: number): Float64Array;

export function solve_linear_system(a_flat: Float64Array, n: number, b: Float64Array): Float64Array;

export function solve_spd_linear_system(a_flat: Float64Array, n: number, b: Float64Array): Float64Array;

export function surface_normal_aspheric_rt10(pt: Float64Array, params: Float64Array, mode_odd: number): Float64Array;

export function surface_normal_aspheric_rt10_batch(points: Float64Array, count: number, params: Float64Array, mode_odd: number): Float64Array;

/**
 * Phase 3: High-performance batch tracing with system metadata embedded in JSON
 * Full ray-tracing loop implemented in Rust with direct WASM memory access
 * Input: rayArrayPtr (pointer to rays in WASM heap), systemMetaJSON (metadata as JSON), rowCount, nStart
 * Output: JsValue containing result metadata with traced ray count
 */
export function trace_ray_batch_with_system_json(ray_array_ptr: number, system_meta_json: string, row_count: number, n_start: number): any;

export function transform_point_to_global_batch(points: Float64Array, origin: Float64Array, rot_mat: Float64Array, count: number): Float64Array;

export function transform_ray_to_local_batch(pos: Float64Array, dir: Float64Array, origin: Float64Array, inv_mat: Float64Array, count: number): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly advance_ray_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly batch_mat3_mul_vec3: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly build_normal_equations: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly calculate_surface_origins: (a: number, b: number) => [number, number, number];
    readonly fft_2d_forward: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly fft_2d_inverse: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly intersect_aspheric_rt10: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly intersect_aspheric_rt10_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly reflect_ray_batch: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly refract_ray_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly solve_linear_system: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly solve_spd_linear_system: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly surface_normal_aspheric_rt10: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly surface_normal_aspheric_rt10_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly trace_ray_batch_with_system_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly transform_point_to_global_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly transform_ray_to_local_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
