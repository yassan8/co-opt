/* @ts-self-types="./surface_origins.d.ts" */

/**
 * @param {Float64Array} pos
 * @param {Float64Array} dirs
 * @param {number} thickness
 * @param {number} count
 * @returns {Float64Array}
 */
export function advance_ray_batch(pos, dirs, thickness, count) {
    const ptr0 = passArrayF64ToWasm0(pos, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(dirs, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.advance_ray_batch(ptr0, len0, ptr1, len1, thickness, count);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {Float64Array} r0
 * @param {Float64Array} r_batches
 * @param {number} m
 * @param {number} n
 * @param {Float64Array} steps
 * @returns {Float64Array}
 */
export function assemble_fd_jacobian(r0, r_batches, m, n, steps) {
    const ptr0 = passArrayF64ToWasm0(r0, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(r_batches, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(steps, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.assemble_fd_jacobian(ptr0, len0, ptr1, len1, m, n, ptr2, len2);
    var v4 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v4;
}

/**
 * @param {Float64Array} r0
 * @param {Float64Array} r_batches
 * @param {number} m
 * @param {number} n
 * @param {Uint32Array} col_indices
 * @param {Float64Array} steps
 * @returns {Float64Array}
 */
export function assemble_fd_jacobian_grouped(r0, r_batches, m, n, col_indices, steps) {
    const ptr0 = passArrayF64ToWasm0(r0, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(r_batches, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArray32ToWasm0(col_indices, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(steps, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.assemble_fd_jacobian_grouped(ptr0, len0, ptr1, len1, m, n, ptr2, len2, ptr3, len3);
    var v5 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}

/**
 * Phase 3: Armijo backtracking line search with JS merit callback
 *
 * Finds alpha in {alpha_init, alpha_init*rho, ...} satisfying:
 *   f(x + alpha * p) <= f0 + c1 * alpha * (grad0^T p)
 *
 * Returns accepted alpha, or 0.0 on failure.
 * @param {Float64Array} x
 * @param {Float64Array} p
 * @param {number} f0
 * @param {Float64Array} grad0
 * @param {number} alpha_init
 * @param {number} rho
 * @param {number} c1
 * @param {number} max_iter
 * @param {Function} merit_eval_callback
 * @returns {number}
 */
export function backtracking_line_search_armijo(x, p, f0, grad0, alpha_init, rho, c1, max_iter, merit_eval_callback) {
    const ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(p, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(grad0, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.backtracking_line_search_armijo(ptr0, len0, ptr1, len1, f0, ptr2, len2, alpha_init, rho, c1, max_iter, merit_eval_callback);
    return ret;
}

/**
 * @param {Float64Array} mat
 * @param {Float64Array} vecs
 * @param {number} count
 * @returns {Float64Array}
 */
export function batch_mat3_mul_vec3(mat, vecs, count) {
    const ptr0 = passArrayF64ToWasm0(mat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(vecs, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.batch_mat3_mul_vec3(ptr0, len0, ptr1, len1, count);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * BFGS Hessian approximation update
 * Updates H in-place using: H_new = H + (y*y^T)/(y^T*s) - (H*s*(H*s)^T)/(s^T*H*s)
 * where s = step, y = gradient_difference
 * H is stored in row-major flat format
 * @param {Float64Array} h_flat
 * @param {Float64Array} s
 * @param {Float64Array} y
 * @param {number} n
 * @returns {boolean}
 */
export function bfgs_update(h_flat, s, y, n) {
    var ptr0 = passArrayF64ToWasm0(h_flat, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(s, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(y, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.bfgs_update(ptr0, len0, h_flat, ptr1, len1, ptr2, len2, n);
    return ret !== 0;
}

/**
 * @param {Float64Array} j_flat
 * @param {number} m
 * @param {number} n
 * @param {Float64Array} r
 * @returns {Float64Array}
 */
export function build_normal_equations(j_flat, m, n, r) {
    const ptr0 = passArrayF64ToWasm0(j_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(r, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.build_normal_equations(ptr0, len0, m, n, ptr1, len1);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {any[]} optical_system_rows
 * @returns {any}
 */
export function calculate_surface_origins(optical_system_rows) {
    const ptr0 = passArrayJsValueToWasm0(optical_system_rows, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.calculate_surface_origins(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Cholesky factorization: A = L * L^T
 * Returns lower triangular matrix L in row-major flat format
 * Returns empty vector on failure (not positive definite)
 * @param {Float64Array} a_flat
 * @param {number} n
 * @returns {Float64Array}
 */
export function cholesky_factorization(a_flat, n) {
    const ptr0 = passArrayF64ToWasm0(a_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.cholesky_factorization(ptr0, len0, n);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {Float64Array} field_values
 * @param {Float64Array} wavelengths
 * @param {number} reference_wavelength
 * @param {Float64Array} image_heights_flat
 * @returns {any}
 */
export function compute_lca_series_from_image_heights(field_values, wavelengths, reference_wavelength, image_heights_flat) {
    const ptr0 = passArrayF64ToWasm0(field_values, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(wavelengths, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(image_heights_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.compute_lca_series_from_image_heights(ptr0, len0, ptr1, len1, reference_wavelength, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 *
 * * High-performance 2D FFT for PSF calculation
 * * Input: real[rows*cols], imag[rows*cols] (WASM memory pointers)
 * * Output: real_out[rows*cols], imag_out[rows*cols]
 * * Returns: metadata JSON with timing info
 *
 * @param {number} real_ptr
 * @param {number} imag_ptr
 * @param {number} rows
 * @param {number} cols
 * @param {number} real_out_ptr
 * @param {number} imag_out_ptr
 * @returns {any}
 */
export function fft_2d_forward(real_ptr, imag_ptr, rows, cols, real_out_ptr, imag_out_ptr) {
    const ret = wasm.fft_2d_forward(real_ptr, imag_ptr, rows, cols, real_out_ptr, imag_out_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 *
 * * 2D Inverse FFT (IFFT)
 *
 * @param {number} real_ptr
 * @param {number} imag_ptr
 * @param {number} rows
 * @param {number} cols
 * @param {number} real_out_ptr
 * @param {number} imag_out_ptr
 * @returns {any}
 */
export function fft_2d_inverse(real_ptr, imag_ptr, rows, cols, real_out_ptr, imag_out_ptr) {
    const ret = wasm.fft_2d_inverse(real_ptr, imag_ptr, rows, cols, real_out_ptr, imag_out_ptr);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} ptr
 * @param {number} size
 */
export function free(ptr, size) {
    wasm.free(ptr, size);
}

/**
 * @param {number} ray_count
 * @param {number} max_radius
 * @param {number} ring_count
 * @returns {Float64Array}
 */
export function generate_annular_offsets_flat(ray_count, max_radius, ring_count) {
    const ret = wasm.generate_annular_offsets_flat(ray_count, max_radius, ring_count);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {number} ray_count
 * @param {number} half_extent
 * @returns {Float64Array}
 */
export function generate_centered_grid_offsets_flat(ray_count, half_extent) {
    const ret = wasm.generate_centered_grid_offsets_flat(ray_count, half_extent);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {number} ray_count
 * @param {number} max_radius
 * @returns {Float64Array}
 */
export function generate_cross_offsets_flat(ray_count, max_radius) {
    const ret = wasm.generate_cross_offsets_flat(ray_count, max_radius);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * @param {Float64Array} x
 * @param {Float64Array} steps
 * @param {number} n
 * @returns {Float64Array}
 */
export function generate_fd_perturbation_points(x, steps, n) {
    const ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(steps, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.generate_fd_perturbation_points(ptr0, len0, ptr1, len1, n);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {Float64Array} origin
 * @param {Float64Array} u_axis
 * @param {Float64Array} v_axis
 * @param {Float64Array} offsets
 * @param {number} count
 * @returns {Float64Array}
 */
export function generate_parallel_start_points_flat(origin, u_axis, v_axis, offsets, count) {
    const ptr0 = passArrayF64ToWasm0(origin, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(u_axis, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(v_axis, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(offsets, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.generate_parallel_start_points_flat(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, count);
    var v5 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}

/**
 * @param {Float64Array} ray
 * @param {Float64Array} params
 * @param {number} mode_odd
 * @param {number} max_iter
 * @param {number} tol
 * @returns {number}
 */
export function intersect_aspheric_rt10(ray, params, mode_odd, max_iter, tol) {
    const ptr0 = passArrayF64ToWasm0(ray, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(params, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.intersect_aspheric_rt10(ptr0, len0, ptr1, len1, mode_odd, max_iter, tol);
    return ret;
}

/**
 * @param {Float64Array} rays
 * @param {number} ray_count
 * @param {Float64Array} params
 * @param {number} mode_odd
 * @param {number} max_iter
 * @param {number} tol
 * @returns {Float64Array}
 */
export function intersect_aspheric_rt10_batch(rays, ray_count, params, mode_odd, max_iter, tol) {
    const ptr0 = passArrayF64ToWasm0(rays, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(params, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.intersect_aspheric_rt10_batch(ptr0, len0, ray_count, ptr1, len1, mode_odd, max_iter, tol);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {number} size
 * @returns {number}
 */
export function malloc(size) {
    const ret = wasm.malloc(size);
    return ret >>> 0;
}

/**
 * Matrix-vector multiplication: result = A * x
 * A is stored in row-major order (flat array)
 * @param {Float64Array} a_flat
 * @param {Float64Array} x
 * @param {number} rows
 * @param {number} cols
 * @returns {Float64Array}
 */
export function matrix_vector_multiply(a_flat, x, rows, cols) {
    const ptr0 = passArrayF64ToWasm0(a_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.matrix_vector_multiply(ptr0, len0, ptr1, len1, rows, cols);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {Float64Array} j_flat
 * @param {number} m
 * @param {number} n
 * @param {Float64Array} v
 * @param {number} damping
 * @returns {Float64Array}
 */
export function normal_eq_matvec(j_flat, m, n, v, damping) {
    const ptr0 = passArrayF64ToWasm0(j_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(v, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.normal_eq_matvec(ptr0, len0, m, n, ptr1, len1, damping);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {number} x_ptr
 * @param {number} steps_ptr
 * @param {number} r0_ptr
 * @param {number} r_batches_ptr
 * @param {number} var_scales_ptr
 * @param {number} out_dx_ptr
 * @param {number} out_x_next_ptr
 * @param {number} out_meta_ptr
 * @param {number} n
 * @param {number} m
 * @param {number} damping
 * @param {number} trust_radius
 * @returns {number}
 */
export function optimize_one_iter_from_buffers(x_ptr, steps_ptr, r0_ptr, r_batches_ptr, var_scales_ptr, out_dx_ptr, out_x_next_ptr, out_meta_ptr, n, m, damping, trust_radius) {
    const ret = wasm.optimize_one_iter_from_buffers(x_ptr, steps_ptr, r0_ptr, r_batches_ptr, var_scales_ptr, out_dx_ptr, out_x_next_ptr, out_meta_ptr, n, m, damping, trust_radius);
    return ret >>> 0;
}

/**
 * @param {string} payload_json
 * @returns {string}
 */
export function optimize_system_in_wasm(payload_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(payload_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.optimize_system_in_wasm(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * QR factorization using Householder reflections
 * Returns (Q, R) where Q is orthogonal and R is upper triangular
 * Both stored in row-major flat format
 * Returns empty vectors on failure
 * @param {Float64Array} a_flat
 * @param {number} rows
 * @param {number} cols
 * @returns {Float64Array}
 */
export function qr_factorization(a_flat, rows, cols) {
    const ptr0 = passArrayF64ToWasm0(a_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.qr_factorization(ptr0, len0, rows, cols);
    var v2 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v2;
}

/**
 * @param {Float64Array} dirs
 * @param {Float64Array} normals
 * @param {number} count
 * @returns {Float64Array}
 */
export function reflect_ray_batch(dirs, normals, count) {
    const ptr0 = passArrayF64ToWasm0(dirs, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(normals, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.reflect_ray_batch(ptr0, len0, ptr1, len1, count);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {Float64Array} dirs
 * @param {Float64Array} normals
 * @param {Float64Array} n1
 * @param {Float64Array} n2
 * @param {number} count
 * @returns {Float64Array}
 */
export function refract_ray_batch(dirs, normals, n1, n2, count) {
    const ptr0 = passArrayF64ToWasm0(dirs, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(normals, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(n1, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(n2, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.refract_ray_batch(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, count);
    var v5 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}

/**
 * @param {string} req_json
 * @returns {any}
 */
export function run_native_distortion_wasm_json(req_json) {
    const ptr0 = passStringToWasm0(req_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.run_native_distortion_wasm_json(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} req_json
 * @returns {any}
 */
export function run_native_magnification_chromatic_aberration_wasm_json(req_json) {
    const ptr0 = passStringToWasm0(req_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.run_native_magnification_chromatic_aberration_wasm_json(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} req_json
 * @returns {any}
 */
export function run_native_opd_map_wasm_json(req_json) {
    const ptr0 = passStringToWasm0(req_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.run_native_opd_map_wasm_json(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Float64Array} a_flat
 * @param {number} n
 * @param {Float64Array} b
 * @returns {Float64Array}
 */
export function solve_linear_system(a_flat, n, b) {
    const ptr0 = passArrayF64ToWasm0(a_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.solve_linear_system(ptr0, len0, n, ptr1, len1);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

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
 * @param {Float64Array} h_flat
 * @param {number} n
 * @param {Float64Array} g
 * @param {Float64Array} a_flat
 * @param {number} m
 * @param {Float64Array} c
 * @param {number} damping
 * @returns {Float64Array}
 */
export function solve_qp_subproblem_kkt_equality(h_flat, n, g, a_flat, m, c, damping) {
    const ptr0 = passArrayF64ToWasm0(h_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(g, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(a_flat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(c, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.solve_qp_subproblem_kkt_equality(ptr0, len0, n, ptr1, len1, ptr2, len2, m, ptr3, len3, damping);
    var v5 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}

/**
 * Phase 2: Solve unconstrained QP subproblem for SQP
 *   min 0.5 * dx^T * H * dx + g^T * dx
 * by solving linear system:
 *   H * dx = -g
 *
 * Returns packed vector of length (n + 1):
 *   [dx_0, ..., dx_{n-1}, predicted_reduction]
 * On failure returns [NaN; n + 1].
 * @param {Float64Array} h_flat
 * @param {number} n
 * @param {Float64Array} g
 * @param {number} damping
 * @returns {Float64Array}
 */
export function solve_qp_subproblem_unconstrained(h_flat, n, g, damping) {
    const ptr0 = passArrayF64ToWasm0(h_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(g, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.solve_qp_subproblem_unconstrained(ptr0, len0, n, ptr1, len1, damping);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {Float64Array} initial_origins
 * @param {Float64Array} dirs
 * @param {Float64Array} stop_targets
 * @param {number} ray_count
 * @param {number} stop_surface_index
 * @param {number} wavelength_um
 * @param {number} n_start
 * @param {Int32Array} row_meta
 * @param {Float64Array} row_params
 * @param {Float64Array} row_origins
 * @param {Float64Array} row_inv_rots
 * @param {Float64Array} row_rots
 * @param {number} row_count
 * @param {number} max_iter
 * @param {number} tol_mm
 * @param {number} eps
 * @param {number} max_step
 * @returns {Float64Array}
 */
export function solve_ray_origins_to_stop_points_with_meta_batch(initial_origins, dirs, stop_targets, ray_count, stop_surface_index, wavelength_um, n_start, row_meta, row_params, row_origins, row_inv_rots, row_rots, row_count, max_iter, tol_mm, eps, max_step) {
    const ptr0 = passArrayF64ToWasm0(initial_origins, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(dirs, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(stop_targets, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(row_meta, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(row_params, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayF64ToWasm0(row_origins, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ptr6 = passArrayF64ToWasm0(row_inv_rots, wasm.__wbindgen_malloc);
    const len6 = WASM_VECTOR_LEN;
    const ptr7 = passArrayF64ToWasm0(row_rots, wasm.__wbindgen_malloc);
    const len7 = WASM_VECTOR_LEN;
    const ret = wasm.solve_ray_origins_to_stop_points_with_meta_batch(ptr0, len0, ptr1, len1, ptr2, len2, ray_count, stop_surface_index, wavelength_um, n_start, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, row_count, max_iter, tol_mm, eps, max_step);
    var v9 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v9;
}

/**
 * @param {Float64Array} a_flat
 * @param {number} n
 * @param {Float64Array} b
 * @returns {Float64Array}
 */
export function solve_spd_linear_system(a_flat, n, b) {
    const ptr0 = passArrayF64ToWasm0(a_flat, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(b, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.solve_spd_linear_system(ptr0, len0, n, ptr1, len1);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {Float64Array} pt
 * @param {Float64Array} params
 * @param {number} mode_odd
 * @returns {Float64Array}
 */
export function surface_normal_aspheric_rt10(pt, params, mode_odd) {
    const ptr0 = passArrayF64ToWasm0(pt, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(params, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.surface_normal_aspheric_rt10(ptr0, len0, ptr1, len1, mode_odd);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {Float64Array} points
 * @param {number} count
 * @param {Float64Array} params
 * @param {number} mode_odd
 * @returns {Float64Array}
 */
export function surface_normal_aspheric_rt10_batch(points, count, params, mode_odd) {
    const ptr0 = passArrayF64ToWasm0(points, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(params, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.surface_normal_aspheric_rt10_batch(ptr0, len0, count, ptr1, len1, mode_odd);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * @param {Float64Array} rays
 * @param {number} ray_count
 * @param {number} target_surface_index
 * @param {number} n_start
 * @param {Int32Array} row_meta
 * @param {Float64Array} row_params
 * @param {Float64Array} row_origins
 * @param {Float64Array} row_inv_rots
 * @param {Float64Array} row_rots
 * @param {number} row_count
 * @returns {Float64Array}
 */
export function trace_ray_batch_hit_point_with_meta(rays, ray_count, target_surface_index, n_start, row_meta, row_params, row_origins, row_inv_rots, row_rots, row_count) {
    const ptr0 = passArrayF64ToWasm0(rays, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(row_meta, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(row_params, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(row_origins, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(row_inv_rots, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayF64ToWasm0(row_rots, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ret = wasm.trace_ray_batch_hit_point_with_meta(ptr0, len0, ray_count, target_surface_index, n_start, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, row_count);
    var v7 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v7;
}

/**
 * Phase 3: High-performance batch tracing with system metadata embedded in JSON
 * Full ray-tracing loop implemented in Rust with direct WASM memory access
 * Input: rayArrayPtr (pointer to rays in WASM heap), systemMetaJSON (metadata as JSON), rowCount, nStart
 * Output: JsValue containing result metadata with traced ray count
 * @param {number} ray_array_ptr
 * @param {string} system_meta_json
 * @param {number} row_count
 * @param {number} n_start
 * @returns {any}
 */
export function trace_ray_batch_with_system_json(ray_array_ptr, system_meta_json, row_count, n_start) {
    const ptr0 = passStringToWasm0(system_meta_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.trace_ray_batch_with_system_json(ray_array_ptr, ptr0, len0, row_count, n_start);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {Float64Array} ray
 * @param {number} target_surface_index
 * @param {number} n_start
 * @param {Int32Array} row_meta
 * @param {Float64Array} row_params
 * @param {Float64Array} row_origins
 * @param {Float64Array} row_inv_rots
 * @param {Float64Array} row_rots
 * @param {number} row_count
 * @returns {Float64Array}
 */
export function trace_single_ray_hit_point_with_meta(ray, target_surface_index, n_start, row_meta, row_params, row_origins, row_inv_rots, row_rots, row_count) {
    const ptr0 = passArrayF64ToWasm0(ray, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(row_meta, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(row_params, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(row_origins, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF64ToWasm0(row_inv_rots, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    const ptr5 = passArrayF64ToWasm0(row_rots, wasm.__wbindgen_malloc);
    const len5 = WASM_VECTOR_LEN;
    const ret = wasm.trace_single_ray_hit_point_with_meta(ptr0, len0, target_surface_index, n_start, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, row_count);
    var v7 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v7;
}

/**
 * @param {Float64Array} points
 * @param {Float64Array} origin
 * @param {Float64Array} rot_mat
 * @param {number} count
 * @returns {Float64Array}
 */
export function transform_point_to_global_batch(points, origin, rot_mat, count) {
    const ptr0 = passArrayF64ToWasm0(points, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(origin, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(rot_mat, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.transform_point_to_global_batch(ptr0, len0, ptr1, len1, ptr2, len2, count);
    var v4 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v4;
}

/**
 * @param {Float64Array} pos
 * @param {Float64Array} dir
 * @param {Float64Array} origin
 * @param {Float64Array} inv_mat
 * @param {number} count
 * @returns {Float64Array}
 */
export function transform_ray_to_local_batch(pos, dir, origin, inv_mat, count) {
    const ptr0 = passArrayF64ToWasm0(pos, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(dir, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(origin, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF64ToWasm0(inv_mat, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.transform_ray_to_local_batch(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, count);
    var v5 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v5;
}

/**
 * Phase 3: Trust-region radius update helper
 *
 * ratio = actual_reduction / predicted_reduction
 * - ratio < eta1: shrink radius by gamma_dec
 * - ratio > eta2: expand radius by gamma_inc
 * - otherwise keep radius
 * @param {number} predicted_reduction
 * @param {number} actual_reduction
 * @param {number} current_radius
 * @param {number} eta1
 * @param {number} eta2
 * @param {number} gamma_dec
 * @param {number} gamma_inc
 * @param {number} min_radius
 * @param {number} max_radius
 * @returns {number}
 */
export function update_trust_region_radius(predicted_reduction, actual_reduction, current_radius, eta1, eta2, gamma_dec, gamma_inc, min_radius, max_radius) {
    const ret = wasm.update_trust_region_radius(predicted_reduction, actual_reduction, current_radius, eta1, eta2, gamma_dec, gamma_inc, min_radius, max_radius);
    return ret;
}

/**
 * Vector addition with scaling: result = x + alpha * y
 * @param {Float64Array} x
 * @param {Float64Array} y
 * @param {number} alpha
 * @returns {Float64Array}
 */
export function vector_add_scaled(x, y, alpha) {
    const ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(y, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.vector_add_scaled(ptr0, len0, ptr1, len1, alpha);
    var v3 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v3;
}

/**
 * Vector dot product: result = x · y
 * @param {Float64Array} x
 * @param {Float64Array} y
 * @returns {number}
 */
export function vector_dot(x, y) {
    const ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF64ToWasm0(y, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.vector_dot(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Vector L2 norm: result = ||x||₂
 * @param {Float64Array} x
 * @returns {number}
 */
export function vector_norm(x) {
    const ptr0 = passArrayF64ToWasm0(x, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.vector_norm(ptr0, len0);
    return ret;
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_8c4e43fe74559d73: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_String_eecc4a11987127d6: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_8fcf4ce7f1ca72a2: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_bbbb1c18aa2f5e25: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_copy_to_typed_array_fc0809a4dec43528: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_debug_string_0bc8482c6e3508ae: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_47fa6863be6f2f25: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_31b12575b56f32fc: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_function_0095a73b8b156f76: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_ac34f5003991759a: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_5ae8e5880f2c1fbd: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_cd444516edc5b180: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_9e4d92534c42d778: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_11888390b0186270: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_9dd77d8cd6671811: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_8ff4255516ccad3e: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_72fb696202c56729: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_be289d5034ed271b: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_389efe28435a9388: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_call_4708e0c13bdc8e95: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_done_57b39ecd9addfe81: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_entries_58c7934c745daac7: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_from_bddd64e7d5ff6941: function(arg0) {
            const ret = Array.from(arg0);
            return ret;
        },
        __wbg_get_9b94d73e6221f75c: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_b3ed3ad4be2bc8ac: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_c60162cf03da5a6e: function(arg0, arg1) {
            const ret = arg0.get(arg1);
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_c367199e2fa2aa04: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Map_53af74335dec57f4: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Map;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_9b9075935c74707c: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_d314bb98fcf08331: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_bfbc7332a9768d2a: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_6ff6560ca1568e55: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_32ed9a279acd054c: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_35a7bace40f36eac: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_361308b2356cecd0: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_3eb36ae241fe6f44: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_dca287b076112a51: function() {
            const ret = new Map();
            return ret;
        },
        __wbg_new_dd2b680c8bf6ae29: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_from_slice_38c66b2d6c31f4b7: function(arg0, arg1) {
            const ret = new Float64Array(getArrayF64FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_next_3482f54c49e8af19: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_next_418f80d8f5303233: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_now_a3af9a2f4bbaa4d1: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_prototypesetcall_bdcdcc5842e4d77d: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_set_1eb0999cf5d27fc8: function(arg0, arg1, arg2) {
            const ret = arg0.set(arg1, arg2);
            return ret;
        },
        __wbg_set_3807d5f0bfc24aa7: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_f43e577aea94465b: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_value_0546255b415e96c1: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000004: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./surface_origins_bg.js": import0,
    };
}

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('surface_origins_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
