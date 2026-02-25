/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const advance_ray_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
export const batch_mat3_mul_vec3: (a: number, b: number, c: number, d: number, e: number) => [number, number];
export const build_normal_equations: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
export const calculate_surface_origins: (a: number, b: number) => [number, number, number];
export const fft_2d_forward: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const fft_2d_inverse: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
export const intersect_aspheric_rt10: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
export const intersect_aspheric_rt10_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
export const reflect_ray_batch: (a: number, b: number, c: number, d: number, e: number) => [number, number];
export const refract_ray_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
export const solve_linear_system: (a: number, b: number, c: number, d: number, e: number) => [number, number];
export const solve_spd_linear_system: (a: number, b: number, c: number, d: number, e: number) => [number, number];
export const surface_normal_aspheric_rt10: (a: number, b: number, c: number, d: number, e: number) => [number, number];
export const surface_normal_aspheric_rt10_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
export const trace_ray_batch_with_system_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
export const transform_point_to_global_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
export const transform_ray_to_local_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
