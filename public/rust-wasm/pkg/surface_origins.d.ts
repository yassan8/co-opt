/* tslint:disable */
/* eslint-disable */

export function advance_ray_batch(pos: Float64Array, dirs: Float64Array, thickness: number, count: number): Float64Array;

export function assemble_fd_jacobian(r0: Float64Array, r_batches: Float64Array, m: number, n: number, steps: Float64Array): Float64Array;

export function assemble_fd_jacobian_grouped(r0: Float64Array, r_batches: Float64Array, m: number, n: number, col_indices: Uint32Array, steps: Float64Array): Float64Array;

/**
 * Phase 3: Armijo backtracking line search with JS merit callback
 *
 * Finds alpha in {alpha_init, alpha_init*rho, ...} satisfying:
 *   f(x + alpha * p) <= f0 + c1 * alpha * (grad0^T p)
 *
 * Returns accepted alpha, or 0.0 on failure.
 */
export function backtracking_line_search_armijo(x: Float64Array, p: Float64Array, f0: number, grad0: Float64Array, alpha_init: number, rho: number, c1: number, max_iter: number, merit_eval_callback: Function): number;

export function batch_mat3_mul_vec3(mat: Float64Array, vecs: Float64Array, count: number): Float64Array;

/**
 * BFGS Hessian approximation update
 * Updates H in-place using: H_new = H + (y*y^T)/(y^T*s) - (H*s*(H*s)^T)/(s^T*H*s)
 * where s = step, y = gradient_difference
 * H is stored in row-major flat format
 */
export function bfgs_update(h_flat: Float64Array, s: Float64Array, y: Float64Array, n: number): boolean;

export function build_normal_equations(j_flat: Float64Array, m: number, n: number, r: Float64Array): Float64Array;

export function calculate_surface_origins(optical_system_rows: any[]): any;

/**
 * Cholesky factorization: A = L * L^T
 * Returns lower triangular matrix L in row-major flat format
 * Returns empty vector on failure (not positive definite)
 */
export function cholesky_factorization(a_flat: Float64Array, n: number): Float64Array;

export function compute_lca_series_from_image_heights(field_values: Float64Array, wavelengths: Float64Array, reference_wavelength: number, image_heights_flat: Float64Array): any;

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

export function free(ptr: number, size: number): void;

export function generate_annular_offsets_flat(ray_count: number, max_radius: number, ring_count: number): Float64Array;

export function generate_centered_grid_offsets_flat(ray_count: number, half_extent: number): Float64Array;

export function generate_fd_perturbation_points(x: Float64Array, steps: Float64Array, n: number): Float64Array;

export function generate_parallel_start_points_flat(origin: Float64Array, u_axis: Float64Array, v_axis: Float64Array, offsets: Float64Array, count: number): Float64Array;

export function intersect_aspheric_rt10(ray: Float64Array, params: Float64Array, mode_odd: number, max_iter: number, tol: number): number;

export function intersect_aspheric_rt10_batch(rays: Float64Array, ray_count: number, params: Float64Array, mode_odd: number, max_iter: number, tol: number): Float64Array;

export function malloc(size: number): number;

/**
 * Matrix-vector multiplication: result = A * x
 * A is stored in row-major order (flat array)
 */
export function matrix_vector_multiply(a_flat: Float64Array, x: Float64Array, rows: number, cols: number): Float64Array;

export function normal_eq_matvec(j_flat: Float64Array, m: number, n: number, v: Float64Array, damping: number): Float64Array;

export function optimize_one_iter_from_buffers(x_ptr: number, steps_ptr: number, r0_ptr: number, r_batches_ptr: number, var_scales_ptr: number, out_dx_ptr: number, out_x_next_ptr: number, out_meta_ptr: number, n: number, m: number, damping: number, trust_radius: number): number;

export function optimize_system_in_wasm(payload_json: string): string;

/**
 * QR factorization using Householder reflections
 * Returns (Q, R) where Q is orthogonal and R is upper triangular
 * Both stored in row-major flat format
 * Returns empty vectors on failure
 */
export function qr_factorization(a_flat: Float64Array, rows: number, cols: number): Float64Array;

export function reflect_ray_batch(dirs: Float64Array, normals: Float64Array, count: number): Float64Array;

export function refract_ray_batch(dirs: Float64Array, normals: Float64Array, n1: Float64Array, n2: Float64Array, count: number): Float64Array;

export function run_native_opd_map_wasm_json(req_json: string): any;

export function solve_linear_system(a_flat: Float64Array, n: number, b: Float64Array): Float64Array;

/**
 * Phase 2: Solve equality-constrained QP subproblem for SQP
 *   min 0.5 * dx^T * H * dx + g^T * dx
 *   s.t. A * dx + c = 0
 *
 * KKT system:
 *   [H  A^T][dx] = [-g]
 *   [A   0 ][ν ]   [-c]
 *
 * Returns packed vector of length (n + 1):
 *   [dx_0, ..., dx_{n-1}, predicted_reduction]
 * On failure returns [NaN; n + 1].
 */
export function solve_qp_subproblem_kkt_equality(h_flat: Float64Array, n: number, g: Float64Array, a_flat: Float64Array, m: number, c: Float64Array, damping: number): Float64Array;

/**
 * Phase 2: Solve unconstrained QP subproblem for SQP
 *   min 0.5 * dx^T * H * dx + g^T * dx
 * by solving linear system:
 *   H * dx = -g
 *
 * Returns packed vector of length (n + 1):
 *   [dx_0, ..., dx_{n-1}, predicted_reduction]
 * On failure returns [NaN; n + 1].
 */
export function solve_qp_subproblem_unconstrained(h_flat: Float64Array, n: number, g: Float64Array, damping: number): Float64Array;

export function solve_ray_origins_to_stop_points_with_meta_batch(initial_origins: Float64Array, dirs: Float64Array, stop_targets: Float64Array, ray_count: number, stop_surface_index: number, wavelength_um: number, n_start: number, row_meta: Int32Array, row_params: Float64Array, row_origins: Float64Array, row_inv_rots: Float64Array, row_rots: Float64Array, row_count: number, max_iter: number, tol_mm: number, eps: number, max_step: number): Float64Array;

export function solve_spd_linear_system(a_flat: Float64Array, n: number, b: Float64Array): Float64Array;

export function surface_normal_aspheric_rt10(pt: Float64Array, params: Float64Array, mode_odd: number): Float64Array;

export function surface_normal_aspheric_rt10_batch(points: Float64Array, count: number, params: Float64Array, mode_odd: number): Float64Array;

export function trace_ray_batch_hit_point_with_meta(rays: Float64Array, ray_count: number, target_surface_index: number, n_start: number, row_meta: Int32Array, row_params: Float64Array, row_origins: Float64Array, row_inv_rots: Float64Array, row_rots: Float64Array, row_count: number): Float64Array;

/**
 * Phase 3: High-performance batch tracing with system metadata embedded in JSON
 * Full ray-tracing loop implemented in Rust with direct WASM memory access
 * Input: rayArrayPtr (pointer to rays in WASM heap), systemMetaJSON (metadata as JSON), rowCount, nStart
 * Output: JsValue containing result metadata with traced ray count
 */
export function trace_ray_batch_with_system_json(ray_array_ptr: number, system_meta_json: string, row_count: number, n_start: number): any;

export function trace_single_ray_hit_point_with_meta(ray: Float64Array, target_surface_index: number, n_start: number, row_meta: Int32Array, row_params: Float64Array, row_origins: Float64Array, row_inv_rots: Float64Array, row_rots: Float64Array, row_count: number): Float64Array;

export function transform_point_to_global_batch(points: Float64Array, origin: Float64Array, rot_mat: Float64Array, count: number): Float64Array;

export function transform_ray_to_local_batch(pos: Float64Array, dir: Float64Array, origin: Float64Array, inv_mat: Float64Array, count: number): Float64Array;

/**
 * Phase 3: Trust-region radius update helper
 *
 * ratio = actual_reduction / predicted_reduction
 * - ratio < eta1: shrink radius by gamma_dec
 * - ratio > eta2: expand radius by gamma_inc
 * - otherwise keep radius
 */
export function update_trust_region_radius(predicted_reduction: number, actual_reduction: number, current_radius: number, eta1: number, eta2: number, gamma_dec: number, gamma_inc: number, min_radius: number, max_radius: number): number;

/**
 * Vector addition with scaling: result = x + alpha * y
 */
export function vector_add_scaled(x: Float64Array, y: Float64Array, alpha: number): Float64Array;

/**
 * Vector dot product: result = x · y
 */
export function vector_dot(x: Float64Array, y: Float64Array): number;

/**
 * Vector L2 norm: result = ||x||₂
 */
export function vector_norm(x: Float64Array): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly advance_ray_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly assemble_fd_jacobian: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly assemble_fd_jacobian_grouped: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly backtracking_line_search_armijo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: any) => number;
    readonly batch_mat3_mul_vec3: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly bfgs_update: (a: number, b: number, c: any, d: number, e: number, f: number, g: number, h: number) => number;
    readonly build_normal_equations: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly calculate_surface_origins: (a: number, b: number) => [number, number, number];
    readonly cholesky_factorization: (a: number, b: number, c: number) => [number, number];
    readonly compute_lca_series_from_image_heights: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
    readonly fft_2d_forward: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly fft_2d_inverse: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly free: (a: number, b: number) => void;
    readonly generate_annular_offsets_flat: (a: number, b: number, c: number) => [number, number];
    readonly generate_centered_grid_offsets_flat: (a: number, b: number) => [number, number];
    readonly generate_fd_perturbation_points: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly generate_parallel_start_points_flat: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly intersect_aspheric_rt10: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly intersect_aspheric_rt10_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly malloc: (a: number) => number;
    readonly matrix_vector_multiply: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly normal_eq_matvec: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly optimize_one_iter_from_buffers: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => number;
    readonly optimize_system_in_wasm: (a: number, b: number) => [number, number, number, number];
    readonly qr_factorization: (a: number, b: number, c: number, d: number) => [number, number];
    readonly reflect_ray_batch: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly refract_ray_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly run_native_opd_map_wasm_json: (a: number, b: number) => [number, number, number];
    readonly solve_linear_system: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly solve_qp_subproblem_kkt_equality: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number];
    readonly solve_qp_subproblem_unconstrained: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly solve_ray_origins_to_stop_points_with_meta_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number, x: number, y: number) => [number, number];
    readonly solve_spd_linear_system: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly surface_normal_aspheric_rt10: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly surface_normal_aspheric_rt10_batch: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly trace_ray_batch_hit_point_with_meta: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number) => [number, number];
    readonly trace_ray_batch_with_system_json: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly trace_single_ray_hit_point_with_meta: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => [number, number];
    readonly transform_point_to_global_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly transform_ray_to_local_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => [number, number];
    readonly update_trust_region_radius: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly vector_add_scaled: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly vector_dot: (a: number, b: number, c: number, d: number) => number;
    readonly vector_norm: (a: number, b: number) => number;
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
