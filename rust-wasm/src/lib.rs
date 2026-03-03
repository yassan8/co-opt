use serde_json::Value;
use wasm_bindgen::prelude::*;
use js_sys::{Float64Array, Function};

const EPS_R: f64 = 1e-10;

fn get_param(params: &[f64], idx: usize, default: f64) -> f64 {
    if idx < params.len() {
        params[idx]
    } else {
        default
    }
}

fn value_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn get_field<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    match row {
        Value::Object(map) => map.get(key),
        _ => None,
    }
}

fn get_field_from_params<'a>(row: &'a Value, key: &str) -> Option<&'a Value> {
    if let Some(v) = get_field(row, key) {
        return Some(v);
    }
    if let Some(params) = get_field(row, "parameters") {
        return get_field(params, key);
    }
    None
}

fn has_explicit_coord_params(row: &Value) -> bool {
    let keys = ["decenterX", "decenterY", "tiltX", "tiltY", "tiltZ"];
    for k in keys.iter() {
        if get_field_from_params(row, k).is_some() {
            return true;
        }
    }
    false
}

fn is_coord_trans_row(row: &Value) -> bool {
    let keys = [
        "surfType", "type", "surfaceType", "surface_type", "surfTypeName",
        "object type", "object", "Object",
        "comment", "Comment",
        "blockType", "block_type", "blockTypeName",
    ];
    for key in keys.iter() {
        if let Some(v) = get_field(row, key) {
            if let Some(s) = value_to_string(v) {
                let s = s.trim().to_lowercase();
                if s.is_empty() {
                    continue;
                }
                if s == "ct" || s == "coordtrans" || s == "coordinatebreak" || s == "coord trans" || s == "coordinate break" {
                    return true;
                }
                if s.contains("coord trans") || s.contains("coordinate break") {
                    return true;
                }
            }
        }
    }
    false
}

fn get_safe_thickness(row: &Value) -> f64 {
    if is_coord_trans_row(row) {
        if let Some(gap) = get_field(row, "__cooptGapThickness") {
            if let Some(s) = value_to_string(gap) {
                let upper = s.trim().to_uppercase();
                if upper == "INF" || upper == "INFINITY" {
                    return f64::INFINITY;
                }
                if let Ok(v) = s.trim().parse::<f64>() {
                    return if v.is_finite() { v } else { 0.0 };
                }
            }
        }
        return 0.0;
    }

    let thickness = get_field(row, "thickness");
    if thickness.is_none() {
        return 0.0;
    }
    if let Some(s) = thickness.and_then(value_to_string) {
        let upper = s.trim().to_uppercase();
        if upper == "INF" || upper == "INFINITY" {
            return f64::INFINITY;
        }
        if let Ok(v) = s.trim().parse::<f64>() {
            return if v.is_finite() { v } else { 0.0 };
        }
        return 0.0;
    }
    thickness.and_then(value_to_f64).filter(|v| v.is_finite()).unwrap_or(0.0)
}

fn parse_coord_trans_params(row: &Value) -> (f64, f64, f64, f64, f64, f64, i32) {
    if !has_explicit_coord_params(row) {
        return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1);
    }

    let decenter_x = get_field_from_params(row, "decenterX").and_then(value_to_f64).unwrap_or(0.0);
    let decenter_y = get_field_from_params(row, "decenterY").and_then(value_to_f64).unwrap_or(0.0);
    let decenter_z = get_field_from_params(row, "decenterZ").and_then(value_to_f64).unwrap_or(0.0);
    let tilt_x = get_field_from_params(row, "tiltX").and_then(value_to_f64).unwrap_or(0.0);
    let tilt_y = get_field_from_params(row, "tiltY").and_then(value_to_f64).unwrap_or(0.0);
    let tilt_z = get_field_from_params(row, "tiltZ").and_then(value_to_f64).unwrap_or(0.0);

    let order_candidate = get_field(row, "order").or_else(|| get_field(row, "coef1"));
    let order_raw = order_candidate.and_then(value_to_string).and_then(|s| s.trim().parse::<i32>().ok()).unwrap_or(1);
    let transform_order = if order_raw == 0 || order_raw == 1 { order_raw } else { 1 };

    (
        decenter_x,
        decenter_y,
        decenter_z,
        tilt_x,
        tilt_y,
        tilt_z,
        transform_order,
    )
}

fn normalize_coord_trans_row(row: &Value) -> Value {
    if !is_coord_trans_row(row) {
        return row.clone();
    }

    if has_explicit_coord_params(row) {
        return row.clone();
    }

    let mut out = row.clone();
    let decenter_x = get_field(row, "semidia").and_then(value_to_f64).unwrap_or(0.0);
    let decenter_y = get_field(row, "material").and_then(value_to_f64).unwrap_or(0.0);
    let decenter_z = 0.0;
    let tilt_x = get_field(row, "rindex").and_then(value_to_f64).unwrap_or(0.0);
    let tilt_y = get_field(row, "abbe").and_then(value_to_f64).unwrap_or(0.0);
    let tilt_z = get_field(row, "conic").and_then(value_to_f64).unwrap_or(0.0);
    let order_candidate = get_field(row, "order").or_else(|| get_field(row, "coef1"));
    let order_raw = order_candidate.and_then(value_to_string).and_then(|s| s.trim().parse::<i32>().ok()).unwrap_or(1);
    let order = if order_raw == 0 || order_raw == 1 { order_raw } else { 1 };

    if let Value::Object(map) = &mut out {
        map.insert("decenterX".to_string(), Value::from(decenter_x));
        map.insert("decenterY".to_string(), Value::from(decenter_y));
        map.insert("decenterZ".to_string(), Value::from(decenter_z));
        map.insert("tiltX".to_string(), Value::from(tilt_x));
        map.insert("tiltY".to_string(), Value::from(tilt_y));
        map.insert("tiltZ".to_string(), Value::from(tilt_z));
        map.insert("order".to_string(), Value::from(order));
    }

    out
}

fn create_identity_matrix() -> [[f64; 4]; 4] {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

fn multiply_matrices(a: [[f64; 4]; 4], b: [[f64; 4]; 4]) -> [[f64; 4]; 4] {
    let mut result = [[0.0_f64; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            let mut sum = 0.0;
            for k in 0..4 {
                sum += a[i][k] * b[k][j];
            }
            result[i][j] = sum;
        }
    }
    result
}

fn create_rotation_matrix(tilt_x: f64, tilt_y: f64, tilt_z: f64, order: i32) -> [[f64; 4]; 4] {
    let rx = tilt_x.to_radians();
    let ry = tilt_y.to_radians();
    let rz = tilt_z.to_radians();

    let rxm = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, rx.cos(), -rx.sin(), 0.0],
        [0.0, rx.sin(), rx.cos(), 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let rym = [
        [ry.cos(), 0.0, ry.sin(), 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [-ry.sin(), 0.0, ry.cos(), 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];
    let rzm = [
        [rz.cos(), -rz.sin(), 0.0, 0.0],
        [rz.sin(), rz.cos(), 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];

    if order == 0 {
        multiply_matrices(multiply_matrices(rxm, rym), rzm)
    } else {
        multiply_matrices(multiply_matrices(rzm, rym), rxm)
    }
}

fn apply_matrix_to_vec3(matrix: [[f64; 4]; 4], vec: [f64; 3]) -> [f64; 3] {
    let x = matrix[0][0] * vec[0] + matrix[0][1] * vec[1] + matrix[0][2] * vec[2];
    let y = matrix[1][0] * vec[0] + matrix[1][1] * vec[1] + matrix[1][2] * vec[2];
    let z = matrix[2][0] * vec[0] + matrix[2][1] * vec[1] + matrix[2][2] * vec[2];
    [x, y, z]
}

fn vec3_add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn vec3_scale(v: [f64; 3], s: f64) -> [f64; 3] {
    [v[0] * s, v[1] * s, v[2] * s]
}

fn aspheric_sag(r: f64, radius: f64, conic: f64, coefs: &[f64; 10], mode_odd: bool) -> f64 {
    if !radius.is_finite() || radius == 0.0 {
        return 0.0;
    }

    let r2 = r * r;
    let sqrt_term = 1.0 - (1.0 + conic) * r2 / (radius * radius);
    if !sqrt_term.is_finite() || sqrt_term < 0.0 {
        return 0.0;
    }
    let base = r2 / (radius * (1.0 + sqrt_term.sqrt()));

    let mut asphere = 0.0;
    if mode_odd {
        let mut r_power = r2 * r; // r^3
        for coef in coefs.iter() {
            if *coef != 0.0 {
                asphere += coef * r_power;
            }
            r_power *= r2;
        }
    } else {
        let mut r_power = r2 * r2; // r^4
        for coef in coefs.iter() {
            if *coef != 0.0 {
                asphere += coef * r_power;
            }
            r_power *= r2;
        }
    }

    base + asphere
}

fn aspheric_sag_derivative(r: f64, radius: f64, conic: f64, coefs: &[f64; 10], mode_odd: bool) -> f64 {
    if !radius.is_finite() || radius == 0.0 || r < EPS_R {
        return 0.0;
    }

    let r2 = r * r;
    let r2_over_r2 = r2 / (radius * radius);
    let term = (1.0 + conic) * r2_over_r2;

    let mut dzdr = 0.0;
    if term < 1.0 {
        let sqrt_term = (1.0 - term).sqrt();
        let denominator = radius * (1.0 + sqrt_term);
        let d_numerator = 2.0 * r;
        let d_denominator = -radius * (1.0 + conic) * r / (radius * radius * sqrt_term);
        dzdr = (d_numerator * denominator - r2 * d_denominator) / (denominator * denominator);
    }

    if mode_odd {
        let mut r_power = r2; // r^2
        for (i, coef) in coefs.iter().enumerate() {
            if *coef != 0.0 {
                let power = 2.0 * (i as f64 + 1.0) + 1.0; // r^3, r^5, ...
                dzdr += coef * power * r_power;
            }
            r_power *= r2;
        }
    } else {
        let mut r_power = r2 * r; // r^3
        for (i, coef) in coefs.iter().enumerate() {
            if *coef != 0.0 {
                let power = 2.0 * (i as f64 + 2.0); // r^4, r^6, ...
                dzdr += coef * power * r_power;
            }
            r_power *= r2;
        }
    }

    dzdr
}

fn normalize3(x: f64, y: f64, z: f64) -> [f64; 3] {
    let len = (x * x + y * y + z * z).sqrt();
    if len.is_finite() && len > 0.0 {
        [x / len, y / len, z / len]
    } else {
        [0.0, 0.0, 1.0]
    }
}

fn parse_params(params: &[f64]) -> (f64, f64, f64, [f64; 10]) {
    let semidia = get_param(params, 0, 0.0);
    let radius = get_param(params, 1, 0.0);
    let conic = get_param(params, 2, 0.0);
    let mut coefs = [0.0_f64; 10];
    for i in 0..10 {
        coefs[i] = get_param(params, 3 + i, 0.0);
    }
    (semidia, radius, conic, coefs)
}

fn intersect_aspheric_internal(
    ray: &[f64],
    params: &[f64],
    mode_odd: bool,
    max_iter: i32,
    tol: f64,
) -> f64 {
    if ray.len() < 6 {
        return f64::NAN;
    }

    let ox = ray[0];
    let oy = ray[1];
    let oz = ray[2];
    let dx = ray[3];
    let dy = ray[4];
    let dz = ray[5];

    if !ox.is_finite() || !oy.is_finite() || !oz.is_finite() || !dx.is_finite() || !dy.is_finite() || !dz.is_finite() {
        return f64::NAN;
    }

    let (semidia_raw, radius, conic, coefs) = parse_params(params);
    let semidia = if semidia_raw.is_finite() && semidia_raw > 0.0 { semidia_raw } else { f64::INFINITY };
    let mut guesses: Vec<f64> = Vec::new();
    if radius.is_finite() && radius != 0.0 {
        let cz = radius;
        let a = dx * dx + dy * dy + dz * dz;
        let b = 2.0 * (ox * dx + oy * dy + (oz - cz) * dz);
        let c = ox * ox + oy * oy + (oz - cz) * (oz - cz) - radius * radius;
        let d = b * b - 4.0 * a * c;
        if d >= 0.0 {
            let sqrt_d = d.sqrt();
            let t1 = (-b - sqrt_d) / (2.0 * a);
            let t2 = (-b + sqrt_d) / (2.0 * a);
            if t1 > 1e-10 {
                guesses.push(t1);
            }
            if t2 > 1e-10 {
                guesses.push(t2);
            }
        }
    }

    if dz.abs() > 1e-10 {
        let t_plane = -oz / dz;
        if t_plane > 1e-10 {
            guesses.push(t_plane);
        }
    }

    if guesses.is_empty() {
        guesses.push(0.01);
        guesses.push(1.0);
        guesses.push(10.0);
    } else if guesses.len() == 1 {
        guesses.push(1.0);
    }

    guesses.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    guesses.dedup_by(|a, b| (*a - *b).abs() < 1e-9);

    let max_iter = if max_iter <= 0 { 20 } else { max_iter } as usize;
    let tol = if tol.is_finite() && tol > 0.0 { tol } else { 1e-7 };

    for guess in guesses.iter() {
        let mut t = *guess;
        let mut last_valid_t = f64::NAN;
        let mut last_valid_f = f64::INFINITY;

        for _ in 0..max_iter {
            let px = ox + dx * t;
            let py = oy + dy * t;
            let pz = oz + dz * t;
            let r = (px * px + py * py).sqrt();
            let sag = aspheric_sag(r, radius, conic, &coefs, mode_odd);
            let f = pz - sag;

            if r <= semidia && f.abs() < last_valid_f.abs() {
                last_valid_t = t;
                last_valid_f = f;
            }

            if f.abs() < tol {
                return t;
            }

            let dzdr = aspheric_sag_derivative(r, radius, conic, &coefs, mode_odd);
            let r_safe = if r > EPS_R { r } else { EPS_R };
            let d_fdt = dz - dzdr * (px * dx + py * dy) / r_safe;

            if d_fdt.abs() < 1e-12 {
                break;
            }

            let delta_t = f / d_fdt;
            let max_delta = t.abs() * 0.5 + 1.0;
            if delta_t.abs() > max_delta {
                t -= delta_t.signum() * max_delta;
            } else {
                t -= delta_t;
            }

            if t < -10000.0 || t > 10000.0 {
                break;
            }
        }

        let px = ox + dx * t;
        let py = oy + dy * t;
        let pz = oz + dz * t;
        let r = (px * px + py * py).sqrt();
        let sag = aspheric_sag(r, radius, conic, &coefs, mode_odd);
        let f = pz - sag;
        if f.abs() < tol * 10.0 && r <= semidia * 1.1 {
            return t;
        }

        if last_valid_t.is_finite() && last_valid_f.abs() < tol * 50.0 {
            return last_valid_t;
        }
    }

    f64::NAN
}

#[wasm_bindgen]
pub fn intersect_aspheric_rt10(
    ray: &[f64],
    params: &[f64],
    mode_odd: i32,
    max_iter: i32,
    tol: f64,
) -> f64 {
    intersect_aspheric_internal(ray, params, mode_odd != 0, max_iter, tol)
}

#[wasm_bindgen]
pub fn intersect_aspheric_rt10_batch(
    rays: &[f64],
    ray_count: usize,
    params: &[f64],
    mode_odd: i32,
    max_iter: i32,
    tol: f64,
) -> Vec<f64> {
    let mut out = vec![f64::NAN; ray_count];
    if rays.len() < ray_count * 6 {
        return out;
    }

    for i in 0..ray_count {
        let offset = i * 6;
        let t = intersect_aspheric_internal(&rays[offset..offset + 6], params, mode_odd != 0, max_iter, tol);
        out[i] = t;
    }

    out
}

#[wasm_bindgen]
pub fn surface_normal_aspheric_rt10(
    pt: &[f64],
    params: &[f64],
    mode_odd: i32,
) -> Vec<f64> {
    if pt.len() < 3 {
        return vec![0.0, 0.0, 1.0];
    }

    let x = pt[0];
    let y = pt[1];
    let r = (x * x + y * y).sqrt();
    if r < EPS_R {
        return vec![0.0, 0.0, 1.0];
    }

    let (_, radius, conic, coefs) = parse_params(params);
    let dzdr = aspheric_sag_derivative(r, radius, conic, &coefs, mode_odd != 0);
    let dzdx = dzdr * (x / r);
    let dzdy = dzdr * (y / r);
    let n = normalize3(-dzdx, -dzdy, 1.0);
    vec![n[0], n[1], n[2]]
}

#[wasm_bindgen]
pub fn surface_normal_aspheric_rt10_batch(
    points: &[f64],
    count: usize,
    params: &[f64],
    mode_odd: i32,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; count * 3];
    if points.len() < count * 3 {
        return out;
    }

    let (_, radius, conic, coefs) = parse_params(params);
    let use_odd = mode_odd != 0;

    for i in 0..count {
        let base = i * 3;
        let x = points[base];
        let y = points[base + 1];
        let r = (x * x + y * y).sqrt();
        if r < EPS_R {
            out[base] = 0.0;
            out[base + 1] = 0.0;
            out[base + 2] = 1.0;
            continue;
        }

        let dzdr = aspheric_sag_derivative(r, radius, conic, &coefs, use_odd);
        let dzdx = dzdr * (x / r);
        let dzdy = dzdr * (y / r);
        let n = normalize3(-dzdx, -dzdy, 1.0);
        out[base] = n[0];
        out[base + 1] = n[1];
        out[base + 2] = n[2];
    }

    out
}

#[wasm_bindgen]
pub fn batch_mat3_mul_vec3(
    mat: &[f64],
    vecs: &[f64],
    count: usize,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; count * 3];
    if mat.len() < 9 || vecs.len() < count * 3 {
        return out;
    }

    let m00 = mat[0];
    let m01 = mat[1];
    let m02 = mat[2];
    let m10 = mat[3];
    let m11 = mat[4];
    let m12 = mat[5];
    let m20 = mat[6];
    let m21 = mat[7];
    let m22 = mat[8];

    for i in 0..count {
        let base = i * 3;
        let x = vecs[base];
        let y = vecs[base + 1];
        let z = vecs[base + 2];
        out[base] = m00 * x + m01 * y + m02 * z;
        out[base + 1] = m10 * x + m11 * y + m12 * z;
        out[base + 2] = m20 * x + m21 * y + m22 * z;
    }

    out
}

#[wasm_bindgen]
pub fn transform_ray_to_local_batch(
    pos: &[f64],
    dir: &[f64],
    origin: &[f64],
    inv_mat: &[f64],
    count: usize,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; count * 6];
    if pos.len() < count * 3 || dir.len() < count * 3 || origin.len() < 3 || inv_mat.len() < 9 {
        return out;
    }

    let ox = origin[0];
    let oy = origin[1];
    let oz = origin[2];

    let m00 = inv_mat[0];
    let m01 = inv_mat[1];
    let m02 = inv_mat[2];
    let m10 = inv_mat[3];
    let m11 = inv_mat[4];
    let m12 = inv_mat[5];
    let m20 = inv_mat[6];
    let m21 = inv_mat[7];
    let m22 = inv_mat[8];

    for i in 0..count {
        let j = i * 3;
        let px = pos[j] - ox;
        let py = pos[j + 1] - oy;
        let pz = pos[j + 2] - oz;
        let dx = dir[j];
        let dy = dir[j + 1];
        let dz = dir[j + 2];

        let out_base = i * 6;
        out[out_base] = m00 * px + m01 * py + m02 * pz;
        out[out_base + 1] = m10 * px + m11 * py + m12 * pz;
        out[out_base + 2] = m20 * px + m21 * py + m22 * pz;
        out[out_base + 3] = m00 * dx + m01 * dy + m02 * dz;
        out[out_base + 4] = m10 * dx + m11 * dy + m12 * dz;
        out[out_base + 5] = m20 * dx + m21 * dy + m22 * dz;
    }

    out
}

#[wasm_bindgen]
pub fn transform_point_to_global_batch(
    points: &[f64],
    origin: &[f64],
    rot_mat: &[f64],
    count: usize,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; count * 3];
    if points.len() < count * 3 || origin.len() < 3 || rot_mat.len() < 9 {
        return out;
    }

    let ox = origin[0];
    let oy = origin[1];
    let oz = origin[2];

    let m00 = rot_mat[0];
    let m01 = rot_mat[1];
    let m02 = rot_mat[2];
    let m10 = rot_mat[3];
    let m11 = rot_mat[4];
    let m12 = rot_mat[5];
    let m20 = rot_mat[6];
    let m21 = rot_mat[7];
    let m22 = rot_mat[8];

    for i in 0..count {
        let j = i * 3;
        let x = points[j];
        let y = points[j + 1];
        let z = points[j + 2];
        out[j] = m00 * x + m01 * y + m02 * z + ox;
        out[j + 1] = m10 * x + m11 * y + m12 * z + oy;
        out[j + 2] = m20 * x + m21 * y + m22 * z + oz;
    }

    out
}

#[wasm_bindgen]
pub fn refract_ray_batch(
    dirs: &[f64],
    normals: &[f64],
    n1: &[f64],
    n2: &[f64],
    count: usize,
) -> Vec<f64> {
    let mut out = vec![f64::NAN; count * 3];
    if dirs.len() < count * 3 || normals.len() < count * 3 || n1.len() < count || n2.len() < count {
        return out;
    }

    for i in 0..count {
        let j = i * 3;
        let dx = dirs[j];
        let dy = dirs[j + 1];
        let dz = dirs[j + 2];
        let nx = normals[j];
        let ny = normals[j + 1];
        let nz = normals[j + 2];
        let n1v = n1[i];
        let n2v = n2[i];
        if !dx.is_finite() || !dy.is_finite() || !dz.is_finite() ||
           !nx.is_finite() || !ny.is_finite() || !nz.is_finite() ||
           !n1v.is_finite() || !n2v.is_finite() || n2v == 0.0 {
            continue;
        }

        let cos_i = -(nx * dx + ny * dy + nz * dz);
        let eta = n1v / n2v;
        let k = 1.0 - eta * eta * (1.0 - cos_i * cos_i);
        if k < 0.0 {
            continue;
        }
        let sqrt_k = k.sqrt();
        let rx = eta * dx + (eta * cos_i - sqrt_k) * nx;
        let ry = eta * dy + (eta * cos_i - sqrt_k) * ny;
        let rz = eta * dz + (eta * cos_i - sqrt_k) * nz;
        let n = normalize3(rx, ry, rz);
        out[j] = n[0];
        out[j + 1] = n[1];
        out[j + 2] = n[2];
    }

    out
}

#[wasm_bindgen]
pub fn reflect_ray_batch(
    dirs: &[f64],
    normals: &[f64],
    count: usize,
) -> Vec<f64> {
    let mut out = vec![f64::NAN; count * 3];
    if dirs.len() < count * 3 || normals.len() < count * 3 {
        return out;
    }

    for i in 0..count {
        let j = i * 3;
        let dx = dirs[j];
        let dy = dirs[j + 1];
        let dz = dirs[j + 2];
        let nx = normals[j];
        let ny = normals[j + 1];
        let nz = normals[j + 2];
        if !dx.is_finite() || !dy.is_finite() || !dz.is_finite() ||
           !nx.is_finite() || !ny.is_finite() || !nz.is_finite() {
            continue;
        }

        let dot = dx * nx + dy * ny + dz * nz;
        let rx = dx - 2.0 * dot * nx;
        let ry = dy - 2.0 * dot * ny;
        let rz = dz - 2.0 * dot * nz;
        let n = normalize3(rx, ry, rz);
        out[j] = n[0];
        out[j + 1] = n[1];
        out[j + 2] = n[2];
    }

    out
}

#[wasm_bindgen]
pub fn advance_ray_batch(
    pos: &[f64],
    dirs: &[f64],
    thickness: f64,
    count: usize,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; count * 3];
    if pos.len() < count * 3 || dirs.len() < count * 3 {
        return out;
    }
    if !thickness.is_finite() || thickness == 0.0 {
        out.copy_from_slice(&pos[0..(count * 3)]);
        return out;
    }

    for i in 0..count {
        let j = i * 3;
        out[j] = pos[j] + dirs[j] * thickness;
        out[j + 1] = pos[j + 1] + dirs[j + 1] * thickness;
        out[j + 2] = pos[j + 2] + dirs[j + 2] * thickness;
    }

    out
}

#[wasm_bindgen]
pub fn calculate_surface_origins(
    optical_system_rows: Vec<JsValue>,
) -> Result<JsValue, JsValue> {
    let mut rows: Vec<Value> = Vec::new();
    for row in optical_system_rows {
        match serde_wasm_bindgen::from_value::<Value>(row) {
            Ok(v) => rows.push(v),
            Err(_) => rows.push(Value::Null),
        }
    }

    let normalized: Vec<Value> = rows.iter().map(normalize_coord_trans_row).collect();

    let mut surface_data: Vec<Value> = Vec::new();
    let mut current_origin = [0.0_f64, 0.0_f64, 0.0_f64];
    let mut current_rot = create_identity_matrix();

    let ex = [1.0_f64, 0.0_f64, 0.0_f64];
    let ey = [0.0_f64, 1.0_f64, 0.0_f64];
    let ez = [0.0_f64, 0.0_f64, 1.0_f64];

    for s in 0..normalized.len() {
        let surface = &normalized[s];
        let previous = if s > 0 { Some(&normalized[s - 1]) } else { None };
        let mut surface_origin;
        let mut surface_rot;

        if is_coord_trans_row(surface) {
            let (decenter_x, decenter_y, decenter_z, tilt_x, tilt_y, tilt_z, transform_order) = parse_coord_trans_params(surface);
            let mut thickness = previous.map(get_safe_thickness).unwrap_or(0.0);
            if !thickness.is_finite() {
                thickness = 0.0;
            }

            let prev_rot = current_rot;
            let single_rot = create_rotation_matrix(tilt_x, tilt_y, tilt_z, transform_order);
            let new_rot = multiply_matrices(single_rot, current_rot);
            surface_rot = new_rot;

            if transform_order == 0 {
                let tz_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ez), thickness);
                let dx_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ex), decenter_x);
                let dy_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ey), decenter_y);
                let dz_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ez), decenter_z);
                surface_origin = vec3_add(vec3_add(vec3_add(vec3_add(current_origin, tz_term), dx_term), dy_term), dz_term);
            } else {
                let tz_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ez), thickness);
                let dx_term = vec3_scale(apply_matrix_to_vec3(new_rot, ex), decenter_x);
                let dy_term = vec3_scale(apply_matrix_to_vec3(new_rot, ey), decenter_y);
                let dz_term = vec3_scale(apply_matrix_to_vec3(new_rot, ez), decenter_z);
                surface_origin = vec3_add(vec3_add(vec3_add(vec3_add(current_origin, tz_term), dx_term), dy_term), dz_term);
            }
        } else {
            let mut thickness = previous.map(get_safe_thickness).unwrap_or(0.0);
            if !thickness.is_finite() {
                thickness = 0.0;
            }
            let tz_term = vec3_scale(apply_matrix_to_vec3(current_rot, ez), thickness);
            surface_origin = vec3_add(current_origin, tz_term);
            surface_rot = current_rot;
        }

        if !surface_origin[0].is_finite() || !surface_origin[1].is_finite() || !surface_origin[2].is_finite() {
            if !(current_origin[0].is_finite() && current_origin[1].is_finite() && current_origin[2].is_finite()) {
                surface_origin = [0.0, 0.0, 0.0];
            }
        }

        let inverse_rot = [
            [surface_rot[0][0], surface_rot[1][0], surface_rot[2][0], 0.0],
            [surface_rot[0][1], surface_rot[1][1], surface_rot[2][1], 0.0],
            [surface_rot[0][2], surface_rot[1][2], surface_rot[2][2], 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ];

        let surface_type = get_field(surface, "surfType").and_then(value_to_string).unwrap_or_default();
        let mut debug = serde_json::json!({
            "surfaceIndex": s + 1,
            "surfaceType": surface_type,
            "origin": { "x": surface_origin[0], "y": surface_origin[1], "z": surface_origin[2] },
            "rotationMatrix": surface_rot,
            "inverseRotationMatrix": inverse_rot,
            "surface": surface
        });

        if is_coord_trans_row(surface) {
            let (decenter_x, decenter_y, decenter_z, tilt_x, tilt_y, tilt_z, transform_order) = parse_coord_trans_params(surface);
            if let Value::Object(map) = &mut debug {
                map.insert("cbParams".to_string(), serde_json::json!({
                    "decenterX": decenter_x,
                    "decenterY": decenter_y,
                    "decenterZ": decenter_z,
                    "tiltX": tilt_x,
                    "tiltY": tilt_y,
                    "tiltZ": tilt_z,
                    "transformOrder": transform_order
                }));
                map.insert("previousOrigin".to_string(), serde_json::json!({
                    "x": current_origin[0],
                    "y": current_origin[1],
                    "z": current_origin[2]
                }));
                map.insert("thickness".to_string(), serde_json::json!(previous.map(get_safe_thickness).unwrap_or(0.0)));
            }
        }

        surface_data.push(debug);
        current_origin = surface_origin;
        current_rot = surface_rot;
    }

    serde_wasm_bindgen::to_value(&surface_data)
        .map_err(|err| JsValue::from_str(&format!("serialize error: {err}")))
}

/// Phase 3: High-performance batch tracing with system metadata embedded in JSON
/// Full ray-tracing loop implemented in Rust with direct WASM memory access
/// Input: rayArrayPtr (pointer to rays in WASM heap), systemMetaJSON (metadata as JSON), rowCount, nStart
/// Output: JsValue containing result metadata with traced ray count
#[wasm_bindgen]
pub fn trace_ray_batch_with_system_json(
    ray_array_ptr: u32,
    system_meta_json: String,
    row_count: u32,
    n_start: f64,
) -> Result<JsValue, JsValue> {
    let row_count = row_count as usize;
    if row_count == 0 {
        return Err(JsValue::from_str("row_count must be positive"));
    }

    // Parse system metadata JSON
    let system_meta: Value = match serde_json::from_str(&system_meta_json) {
        Ok(v) => v,
        Err(e) => return Err(JsValue::from_str(&format!("Invalid JSON: {}", e)))
    };

    // Extract ray count from metadata
    let ray_count = match system_meta.get("rayCount") {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0) as usize,
        _ => return Err(JsValue::from_str("Missing rayCount in metadata"))
    };

    if ray_count == 0 {
        return Err(JsValue::from_str("rayCount must be positive"));
    }

    // Ray buffer layout: [ox, oy, oz, dx, dy, dz] = 6 f64 per ray
    // ray_array_ptr is a byte offset; convert to f64 index (divide by 8)
    let _ray_f64_offset = (ray_array_ptr >> 3) as usize;

    // Get rows from system metadata
    let rows = match system_meta.get("rows") {
        Some(Value::Array(r)) => r.clone(),
        _ => return Err(JsValue::from_str("Missing rows array in metadata"))
    };

    if rows.len() < row_count {
        return Err(JsValue::from_str(&format!("Expected {} rows, got {}", row_count, rows.len())));
    }

    // Current refractive index for all rays
    let mut current_n = n_start;
    let mut rows_traced = 0;
    let mut rays_valid = 0;

    // Trace each ray through each surface
    for row_idx in 0..row_count {
        let row = &rows[row_idx];

        // Extract surface parameters from row metadata
        let params_vec = match row.get("params") {
            Some(Value::Array(p)) => {
                p.iter().filter_map(|v| value_to_f64(v)).collect::<Vec<_>>()
            },
            _ => vec![0.0; 13],
        };
        let mut params = [0.0_f64; 13];
        for i in 0..params.len().min(params_vec.len()) {
            params[i] = params_vec[i];
        }

        // Extract thickness for next propagation
        let thickness = match row.get("thickness") {
            Some(v) => value_to_f64(v).unwrap_or(0.0),
            None => 0.0,
        };

        // Extract next refractive index
        let next_n = match row.get("nextN") {
            Some(v) => value_to_f64(v).unwrap_or(1.0),
            None => 1.0,
        };

        // Extract surface type for intersection method selection
        let surf_type = match row.get("surfType") {
            Some(v) => value_to_string(v).unwrap_or_default(),
            None => String::new(),
        };

        // Trace all rays through this surface
        for ray_idx in 0..ray_count {

            // Read ray from WASM memory safely
            let (ox, oy, oz, dx, dy, dz): (f64, f64, f64, f64, f64, f64) = unsafe {
                let ray_ptr = ray_array_ptr as *const f64;
                (
                    *ray_ptr.add(ray_idx * 6),
                    *ray_ptr.add(ray_idx * 6 + 1),
                    *ray_ptr.add(ray_idx * 6 + 2),
                    *ray_ptr.add(ray_idx * 6 + 3),
                    *ray_ptr.add(ray_idx * 6 + 4),
                    *ray_ptr.add(ray_idx * 6 + 5),
                )
            };

            // Skip invalid rays
            if !ox.is_finite() || !oy.is_finite() || !oz.is_finite() ||
               !dx.is_finite() || !dy.is_finite() || !dz.is_finite() {
                continue;
            }

            // Perform intersection with surface
            let ray_data = vec![ox, oy, oz, dx, dy, dz];
            let t_intersect = if surf_type.to_lowercase().contains("coord") || surf_type.is_empty() {
                // Coordinate break: propagate at dz distance
                if dz.abs() > EPS_R { -oz / dz } else { 0.0 }
            } else {
                // Aspheric/spheric surface intersection
                intersect_aspheric_internal(&ray_data, &params, false, 20, 1e-7)
            };

            if !t_intersect.is_finite() || t_intersect < EPS_R {
                continue;
            }

            // Compute intersection point
            let int_x = ox + dx * t_intersect;
            let int_y = oy + dy * t_intersect;
            let int_z = oz + dz * t_intersect;

            // Compute surface normal
            let normal_data = vec![int_x, int_y, int_z];
            let normal = surface_normal_aspheric_rt10(&normal_data, &params, 0);
            if normal.len() < 3 {
                continue;
            }

            let nx = normal[0];
            let ny = normal[1];
            let nz = normal[2];

            // Refract or reflect based on surface properties
            let (new_dx, new_dy, new_dz) = if next_n.is_finite() && next_n > 0.0 && (current_n - next_n).abs() > EPS_R {
                // Refraction
                let cos_i = -(nx * dx + ny * dy + nz * dz);
                let eta = current_n / next_n;
                let k = 1.0 - eta * eta * (1.0 - cos_i * cos_i);
                if k >= 0.0 {
                    let sqrt_k = k.sqrt();
                    let rx = eta * dx + (eta * cos_i - sqrt_k) * nx;
                    let ry = eta * dy + (eta * cos_i - sqrt_k) * ny;
                    let rz = eta * dz + (eta * cos_i - sqrt_k) * nz;
                    let n = normalize3(rx, ry, rz);
                    (n[0], n[1], n[2])
                } else {
                    // Total internal reflection
                    let dot = dx * nx + dy * ny + dz * nz;
                    let rx = dx - 2.0 * dot * nx;
                    let ry = dy - 2.0 * dot * ny;
                    let rz = dz - 2.0 * dot * nz;
                    let n = normalize3(rx, ry, rz);
                    (n[0], n[1], n[2])
                }
            } else {
                // Reflection (mirror or no refraction data)
                let dot = dx * nx + dy * ny + dz * nz;
                let rx = dx - 2.0 * dot * nx;
                let ry = dy - 2.0 * dot * ny;
                let rz = dz - 2.0 * dot * nz;
                let n = normalize3(rx, ry, rz);
                (n[0], n[1], n[2])
            };

            // Propagate to next surface (advance by thickness)
            let final_x = int_x + new_dx * thickness;
            let final_y = int_y + new_dy * thickness;
            let final_z = int_z + new_dz * thickness;

            // Write updated ray back to WASM memory
            unsafe {
                let ray_ptr = ray_array_ptr as *mut f64;
                *ray_ptr.add(ray_idx * 6) = final_x;
                *ray_ptr.add(ray_idx * 6 + 1) = final_y;
                *ray_ptr.add(ray_idx * 6 + 2) = final_z;
                *ray_ptr.add(ray_idx * 6 + 3) = new_dx;
                *ray_ptr.add(ray_idx * 6 + 4) = new_dy;
                *ray_ptr.add(ray_idx * 6 + 5) = new_dz;
                rays_valid += 1;
            }
        }

        // Update refractive index for next surface
        current_n = if next_n.is_finite() && next_n > 0.0 { next_n } else { current_n };
        rows_traced += 1;
    }

    // Return result metadata
    serde_wasm_bindgen::to_value(&serde_json::json!({
        "status": "trace_complete",
        "rayCount": ray_count,
        "rowCount": row_count,
        "rowsTraced": rows_traced,
        "raysUpdated": rays_valid,
        "nFinal": current_n,
        "phase": 3,
        "note": "Full ray tracing completed in Rust with single WASM boundary crossing"
    }))
    .map_err(|err| JsValue::from_str(&format!("serialize error: {}", err)))
}

#[wasm_bindgen]
pub fn trace_single_ray_hit_point_with_meta(
    ray: &[f64],
    target_surface_index: usize,
    n_start: f64,
    row_meta: &[i32],
    row_params: &[f64],
    row_origins: &[f64],
    row_inv_rots: &[f64],
    row_rots: &[f64],
    row_count: usize,
) -> Vec<f64> {
    trace_single_ray_hit_point_with_meta_core(
        ray,
        target_surface_index,
        n_start,
        row_meta,
        row_params,
        row_origins,
        row_inv_rots,
        row_rots,
        row_count,
    )
    .to_vec()
}

fn trace_single_ray_hit_point_with_meta_core(
    ray: &[f64],
    target_surface_index: usize,
    n_start: f64,
    row_meta: &[i32],
    row_params: &[f64],
    row_origins: &[f64],
    row_inv_rots: &[f64],
    row_rots: &[f64],
    row_count: usize,
) -> [f64; 5] {
    let mut out = [0.0_f64; 5]; // [status, opl, x, y, z]
    if ray.len() < 6 || row_count == 0 || target_surface_index >= row_count {
        out[0] = 2.0; // invalid input
        return out;
    }
    if row_meta.len() < row_count * 4
        || row_params.len() < row_count * 24
        || row_origins.len() < row_count * 3
        || row_inv_rots.len() < row_count * 9
        || row_rots.len() < row_count * 9
    {
        out[0] = 2.0;
        return out;
    }

    let mut px = ray[0];
    let mut py = ray[1];
    let mut pz = ray[2];
    let mut dx = ray[3];
    let mut dy = ray[4];
    let mut dz = ray[5];
    if !px.is_finite() || !py.is_finite() || !pz.is_finite() || !dx.is_finite() || !dy.is_finite() || !dz.is_finite() {
        out[0] = 2.0;
        return out;
    }

    let dn = normalize3(dx, dy, dz);
    dx = dn[0];
    dy = dn[1];
    dz = dn[2];

    let mut n_cur = if n_start.is_finite() && n_start > 0.0 { n_start } else { 1.0 };
    let mut opl = 0.0_f64;

    for i in 0..=target_surface_index {
        let m = i * 4;
        let kind = row_meta[m + 0];
        let flags = row_meta[m + 1];
        let is_mirror = (flags & 1) != 0;
        let is_plane = (flags & 2) != 0;
        let is_toric = (flags & 4) != 0;
        let is_rect_ap = (flags & 16) != 0;
        let is_odd_asphere = (flags & 32) != 0;

        let p = i * 24;
        let radius = row_params[p + 0];
        let conic = row_params[p + 1];
        let coefs = [
            row_params[p + 2], row_params[p + 3], row_params[p + 4], row_params[p + 5], row_params[p + 6],
            row_params[p + 7], row_params[p + 8], row_params[p + 9], row_params[p + 10], row_params[p + 11],
        ];
        let semidia = row_params[p + 12];
        let thickness = row_params[p + 16];
        let aperture_limit = row_params[p + 17];
        let rect_half_w = row_params[p + 18];
        let rect_half_h = row_params[p + 19];
        let n2 = row_params[p + 20];

        // Object / Gap rows: no physical intersection but may advance by thickness.
        if kind == 1 || kind == 2 {
            if thickness.is_finite() && thickness != 0.0 {
                px += dx * thickness;
                py += dy * thickness;
                pz += dz * thickness;
                opl += thickness.abs() * 1000.0 * n_cur;
            }
            continue;
        }

        // CoordTrans row: medium update only (no physical advancement).
        if kind == 3 {
            if n2.is_finite() && n2 > 0.0 {
                n_cur = n2;
            }
            continue;
        }

        let o = i * 3;
        let ox = row_origins[o + 0];
        let oy = row_origins[o + 1];
        let oz = row_origins[o + 2];

        let ir = i * 9;
        let im00 = row_inv_rots[ir + 0];
        let im01 = row_inv_rots[ir + 1];
        let im02 = row_inv_rots[ir + 2];
        let im10 = row_inv_rots[ir + 3];
        let im11 = row_inv_rots[ir + 4];
        let im12 = row_inv_rots[ir + 5];
        let im20 = row_inv_rots[ir + 6];
        let im21 = row_inv_rots[ir + 7];
        let im22 = row_inv_rots[ir + 8];

        let relx = px - ox;
        let rely = py - oy;
        let relz = pz - oz;

        let lpx = im00 * relx + im01 * rely + im02 * relz;
        let lpy = im10 * relx + im11 * rely + im12 * relz;
        let lpz = im20 * relx + im21 * rely + im22 * relz;

        let ldx = im00 * dx + im01 * dy + im02 * dz;
        let ldy = im10 * dx + im11 * dy + im12 * dz;
        let ldz = im20 * dx + im21 * dy + im22 * dz;

        let t = if is_toric {
            f64::NAN
        } else if is_plane {
            if ldz.abs() < EPS_R { f64::NAN } else { -lpz / ldz }
        } else {
            let mut ip = vec![0.0_f64; 13];
            ip[0] = semidia;
            ip[1] = radius;
            ip[2] = conic;
            for k in 0..10 {
                ip[3 + k] = coefs[k];
            }
            intersect_aspheric_internal(&[lpx, lpy, lpz, ldx, ldy, ldz], &ip, is_odd_asphere, 20, 1e-7)
        };

        if !t.is_finite() {
            out[0] = 3.0; // no intersection
            out[1] = opl;
            return out;
        }

        let hx = lpx + ldx * t;
        let hy = lpy + ldy * t;
        let hz = lpz + ldz * t;

        // JS lockstep semantics: OPL includes traveled segment up to this intersection
        // even when this surface subsequently rejects by aperture.
        opl += t.abs() * 1000.0 * n_cur;

        // Aperture checks
        if is_rect_ap && rect_half_w.is_finite() && rect_half_h.is_finite() {
            if hx.abs() > rect_half_w || hy.abs() > rect_half_h {
                out[0] = 4.0; // aperture block
                out[1] = opl;
                return out;
            }
        } else if aperture_limit.is_finite() {
            let hr = (hx * hx + hy * hy).sqrt();
            if hr > aperture_limit {
                out[0] = 4.0;
                out[1] = opl;
                return out;
            }
        }

        // Transform hit to global
        let rr = i * 9;
        let rm00 = row_rots[rr + 0];
        let rm01 = row_rots[rr + 1];
        let rm02 = row_rots[rr + 2];
        let rm10 = row_rots[rr + 3];
        let rm11 = row_rots[rr + 4];
        let rm12 = row_rots[rr + 5];
        let rm20 = row_rots[rr + 6];
        let rm21 = row_rots[rr + 7];
        let rm22 = row_rots[rr + 8];

        let ghx = rm00 * hx + rm01 * hy + rm02 * hz + ox;
        let ghy = rm10 * hx + rm11 * hy + rm12 * hz + oy;
        let ghz = rm20 * hx + rm21 * hy + rm22 * hz + oz;

        if i == target_surface_index {
            out[0] = 1.0;
            out[1] = opl;
            out[2] = ghx;
            out[3] = ghy;
            out[4] = ghz;
            return out;
        }

        // Compute local normal
        let (mut nx, mut ny, mut nz) = if is_plane {
            if ldz > 0.0 { (0.0, 0.0, -1.0) } else { (0.0, 0.0, 1.0) }
        } else {
            let mut np = vec![0.0_f64; 13];
            np[0] = semidia;
            np[1] = radius;
            np[2] = conic;
            for k in 0..10 {
                np[3 + k] = coefs[k];
            }
            let nvec = surface_normal_aspheric_rt10(&[hx, hy, hz], &np, 0);
            if nvec.len() >= 3 { (nvec[0], nvec[1], nvec[2]) } else { (0.0, 0.0, 1.0) }
        };

        let d_dot_n = ldx * nx + ldy * ny + ldz * nz;
        if d_dot_n > 0.0 {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }

        let (ndx, ndy, ndz, n_next) = if is_mirror {
            let dotn = ldx * nx + ldy * ny + ldz * nz;
            let rx = ldx - 2.0 * dotn * nx;
            let ry = ldy - 2.0 * dotn * ny;
            let rz = ldz - 2.0 * dotn * nz;
            let nn = normalize3(rx, ry, rz);
            (nn[0], nn[1], nn[2], n_cur)
        } else if n2.is_finite() && n2 > 0.0 && (n_cur - n2).abs() > EPS_R {
            let cos_i = -(nx * ldx + ny * ldy + nz * ldz);
            let eta = n_cur / n2;
            let k = 1.0 - eta * eta * (1.0 - cos_i * cos_i);
            if k < 0.0 {
                out[0] = 5.0; // TIR
                out[1] = opl;
                return out;
            }
            let sqrt_k = k.sqrt();
            let rx = eta * ldx + (eta * cos_i - sqrt_k) * nx;
            let ry = eta * ldy + (eta * cos_i - sqrt_k) * ny;
            let rz = eta * ldz + (eta * cos_i - sqrt_k) * nz;
            let nn = normalize3(rx, ry, rz);
            (nn[0], nn[1], nn[2], n2)
        } else {
            (ldx, ldy, ldz, n_cur)
        };

        // Transform direction back to global
        let gdx = rm00 * ndx + rm01 * ndy + rm02 * ndz;
        let gdy = rm10 * ndx + rm11 * ndy + rm12 * ndz;
        let gdz = rm20 * ndx + rm21 * ndy + rm22 * ndz;
        let gnorm = normalize3(gdx, gdy, gdz);

        px = ghx;
        py = ghy;
        pz = ghz;
        dx = gnorm[0];
        dy = gnorm[1];
        dz = gnorm[2];
        n_cur = n_next;

        if thickness.is_finite() && thickness != 0.0 {
            px += dx * thickness;
            py += dy * thickness;
            pz += dz * thickness;
            opl += thickness.abs() * 1000.0 * n_cur;
        }
    }

    out[0] = 6.0; // not reached
    out[1] = opl;
    out
}

#[wasm_bindgen]
pub fn trace_ray_batch_hit_point_with_meta(
    rays: &[f64],
    ray_count: usize,
    target_surface_index: usize,
    n_start: f64,
    row_meta: &[i32],
    row_params: &[f64],
    row_origins: &[f64],
    row_inv_rots: &[f64],
    row_rots: &[f64],
    row_count: usize,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; ray_count.saturating_mul(6)]; // [status, opl, x, y, z, reserved] * ray_count
    if ray_count == 0 {
        return out;
    }

    let has_global_invalid = row_count == 0
        || target_surface_index >= row_count
        || row_meta.len() < row_count * 4
        || row_params.len() < row_count * 24
        || row_origins.len() < row_count * 3
        || row_inv_rots.len() < row_count * 9
        || row_rots.len() < row_count * 9
        || rays.len() < ray_count * 6;

    if has_global_invalid {
        for i in 0..ray_count {
            out[i * 6] = 2.0;
        }
        return out;
    }

    for i in 0..ray_count {
        let rbase = i * 6;
        let ray = &rays[rbase..(rbase + 6)];
        let r = trace_single_ray_hit_point_with_meta_core(
            ray,
            target_surface_index,
            n_start,
            row_meta,
            row_params,
            row_origins,
            row_inv_rots,
            row_rots,
            row_count,
        );
        let obase = i * 6;
        out[obase] = r[0];
        out[obase + 1] = r[1];
        out[obase + 2] = r[2];
        out[obase + 3] = r[3];
        out[obase + 4] = r[4];
        out[obase + 5] = 0.0;
    }

    out
}

#[wasm_bindgen]
pub fn solve_ray_origins_to_stop_points_with_meta_batch(
    initial_origins: &[f64],
    dirs: &[f64],
    stop_targets: &[f64],
    ray_count: usize,
    stop_surface_index: usize,
    wavelength_um: f64,
    n_start: f64,
    row_meta: &[i32],
    row_params: &[f64],
    row_origins: &[f64],
    row_inv_rots: &[f64],
    row_rots: &[f64],
    row_count: usize,
    max_iter: usize,
    tol_mm: f64,
    eps: f64,
    max_step: f64,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; ray_count.saturating_mul(4)]; // [x, y, z, status]
    if ray_count == 0 {
        return out;
    }

    let invalid = stop_surface_index >= row_count
        || initial_origins.len() < ray_count * 3
        || dirs.len() < ray_count * 3
        || stop_targets.len() < ray_count * 3
        || row_count == 0
        || row_meta.len() < row_count * 4
        || row_params.len() < row_count * 24
        || row_origins.len() < row_count * 3
        || row_inv_rots.len() < row_count * 9
        || row_rots.len() < row_count * 9;

    if invalid {
        for i in 0..ray_count {
            out[i * 4 + 3] = 2.0; // invalid input
        }
        return out;
    }

    let mut origins = vec![0.0_f64; ray_count * 3];
    let mut dirs_n = vec![0.0_f64; ray_count * 3];
    let mut targets = vec![0.0_f64; ray_count * 3];
    let mut best_origins = vec![0.0_f64; ray_count * 3];
    let mut best_errs = vec![f64::INFINITY; ray_count];
    let mut solved = vec![false; ray_count];

    for i in 0..ray_count {
        let b = i * 3;
        origins[b] = initial_origins[b];
        origins[b + 1] = initial_origins[b + 1];
        origins[b + 2] = initial_origins[b + 2];

        let dn = normalize3(dirs[b], dirs[b + 1], dirs[b + 2]);
        dirs_n[b] = dn[0];
        dirs_n[b + 1] = dn[1];
        dirs_n[b + 2] = dn[2];

        targets[b] = stop_targets[b];
        targets[b + 1] = stop_targets[b + 1];
        targets[b + 2] = stop_targets[b + 2];

        best_origins[b] = origins[b];
        best_origins[b + 1] = origins[b + 1];
        best_origins[b + 2] = origins[b + 2];
    }

    let iter_max = max_iter.clamp(1, 64);
    let eps_local = if eps.is_finite() && eps > 0.0 { eps } else { 1e-3 };
    let tol_local = if tol_mm.is_finite() && tol_mm > 0.0 { tol_mm } else { 1e-3 };
    let max_step_local = if max_step.is_finite() && max_step > 0.0 { max_step } else { 10.0 };

    for _iter in 0..iter_max {
        if solved.iter().all(|v| *v) {
            break;
        }

        for i in 0..ray_count {
            if solved[i] {
                continue;
            }
            let b = i * 3;

            let ox = origins[b];
            let oy = origins[b + 1];
            let oz = origins[b + 2];
            let dx = dirs_n[b];
            let dy = dirs_n[b + 1];
            let dz = dirs_n[b + 2];
            let tx = targets[b];
            let ty = targets[b + 1];

            let ray0 = [ox, oy, oz, dx, dy, dz];
            let r0 = trace_single_ray_hit_point_with_meta_core(
                &ray0,
                stop_surface_index,
                n_start,
                row_meta,
                row_params,
                row_origins,
                row_inv_rots,
                row_rots,
                row_count,
            );

            if r0[0] == 1.0 && r0[2].is_finite() && r0[3].is_finite() {
                let ex = r0[2] - tx;
                let ey = r0[3] - ty;
                let err = (ex * ex + ey * ey).sqrt();

                if err < best_errs[i] {
                    best_errs[i] = err;
                    best_origins[b] = ox;
                    best_origins[b + 1] = oy;
                    best_origins[b + 2] = oz;
                }

                if err < tol_local {
                    solved[i] = true;
                    continue;
                }

                let ray_x = [ox + eps_local, oy, oz, dx, dy, dz];
                let ray_y = [ox, oy + eps_local, oz, dx, dy, dz];

                let rx = trace_single_ray_hit_point_with_meta_core(
                    &ray_x,
                    stop_surface_index,
                    n_start,
                    row_meta,
                    row_params,
                    row_origins,
                    row_inv_rots,
                    row_rots,
                    row_count,
                );
                let ry = trace_single_ray_hit_point_with_meta_core(
                    &ray_y,
                    stop_surface_index,
                    n_start,
                    row_meta,
                    row_params,
                    row_origins,
                    row_inv_rots,
                    row_rots,
                    row_count,
                );

                if rx[0] == 1.0 && ry[0] == 1.0 && rx[2].is_finite() && rx[3].is_finite() && ry[2].is_finite() && ry[3].is_finite() {
                    let j11 = (rx[2] - r0[2]) / eps_local;
                    let j21 = (rx[3] - r0[3]) / eps_local;
                    let j12 = (ry[2] - r0[2]) / eps_local;
                    let j22 = (ry[3] - r0[3]) / eps_local;
                    let det = j11 * j22 - j12 * j21;

                    if det.is_finite() && det.abs() >= 1e-14 {
                        let mut sx = (-j22 * ex + j12 * ey) / det;
                        let mut sy = (j21 * ex - j11 * ey) / det;
                        let sn = (sx * sx + sy * sy).sqrt();
                        if sn > max_step_local {
                            let s = max_step_local / sn;
                            sx *= s;
                            sy *= s;
                        }
                        origins[b] = ox + sx;
                        origins[b + 1] = oy + sy;
                        origins[b + 2] = oz;
                    } else {
                        origins[b] = ox - 0.2 * ex;
                        origins[b + 1] = oy - 0.2 * ey;
                        origins[b + 2] = oz;
                    }
                } else {
                    let mut sx = -0.3 * ex;
                    let mut sy = -0.3 * ey;
                    let sn = (sx * sx + sy * sy).sqrt();
                    if sn > max_step_local {
                        let s = max_step_local / sn;
                        sx *= s;
                        sy *= s;
                    }
                    origins[b] = ox + sx;
                    origins[b + 1] = oy + sy;
                    origins[b + 2] = oz;
                }
            } else {
                origins[b] = 0.5 * (ox + best_origins[b]);
                origins[b + 1] = 0.5 * (oy + best_origins[b + 1]);
                origins[b + 2] = oz;
            }
        }
    }

    for i in 0..ray_count {
        let b = i * 3;
        let o = i * 4;
        if best_errs[i].is_finite() {
            out[o] = best_origins[b];
            out[o + 1] = best_origins[b + 1];
            out[o + 2] = best_origins[b + 2];
            out[o + 3] = if solved[i] { 1.0 } else { 0.0 };
        } else {
            out[o] = origins[b];
            out[o + 1] = origins[b + 1];
            out[o + 2] = origins[b + 2];
            out[o + 3] = 3.0;
        }
    }

    out
}

/**
 * High-performance 2D FFT for PSF calculation
 * Input: real[rows*cols], imag[rows*cols] (WASM memory pointers)
 * Output: real_out[rows*cols], imag_out[rows*cols]
 * Returns: metadata JSON with timing info
 */
#[wasm_bindgen]
pub fn fft_2d_forward(
    real_ptr: u32,
    imag_ptr: u32,
    rows: u32,
    cols: u32,
    real_out_ptr: u32,
    imag_out_ptr: u32,
) -> Result<JsValue, JsValue> {
    use num_complex::Complex;
    use rustfft::num_traits::Zero;
    use rustfft::FftPlanner;
    
    let rows = rows as usize;
    let cols = cols as usize;
    let size = rows * cols;
    
    let start_ms = js_sys::Date::now();
    
    // Read input from WASM memory
    let real_data: Vec<f64> = (0..size)
        .map(|i| unsafe {
            let ptr = (real_ptr as *const f64).add(i);
            std::ptr::read(ptr)
        })
        .collect();
    
    let imag_data: Vec<f64> = (0..size)
        .map(|i| unsafe {
            let ptr = (imag_ptr as *const f64).add(i);
            std::ptr::read(ptr)
        })
        .collect();
    
    let mut data: Vec<Complex<f64>> = real_data
        .iter()
        .zip(imag_data.iter())
        .map(|(r, i)| Complex::new(*r, *i))
        .collect();
    
    // Create FFT planner
    let mut planner = FftPlanner::new();
    
    // Perform row-wise FFT
    let row_fft = planner.plan_fft_forward(cols);
    for row in 0..rows {
        let start_idx = row * cols;
        row_fft.process(&mut data[start_idx..start_idx + cols]);
    }
    
    // Transpose
    let mut transposed = vec![Complex::zero(); size];
    for i in 0..rows {
        for j in 0..cols {
            transposed[j * rows + i] = data[i * cols + j];
        }
    }
    data = transposed;
    
    // Perform column-wise FFT (now rows since we transposed)
    let col_fft = planner.plan_fft_forward(rows);
    for col in 0..cols {
        let start_idx = col * rows;
        col_fft.process(&mut data[start_idx..start_idx + rows]);
    }
    
    // Transpose back
    transposed = vec![Complex::zero(); size];
    for i in 0..cols {
        for j in 0..rows {
            transposed[j * cols + i] = data[i * rows + j];
        }
    }
    data = transposed;
    
    let elapsed_ms = (js_sys::Date::now() - start_ms).max(0.0);
    
    // Write output to WASM memory
    unsafe {
        let mut out_real = real_out_ptr as *mut f64;
        let mut out_imag = imag_out_ptr as *mut f64;
        for value in data {
            std::ptr::write(out_real, value.re);
            std::ptr::write(out_imag, value.im);
            out_real = out_real.add(1);
            out_imag = out_imag.add(1);
        }
    }
    
    serde_wasm_bindgen::to_value(&serde_json::json!({
        "status": "fft_complete",
        "rows": rows,
        "cols": cols,
        "timeMs": elapsed_ms,
        "method": "rustfft"
    }))
    .map_err(|err| JsValue::from_str(&format!("serialize error: {}", err)))
}

/**
 * 2D Inverse FFT (IFFT)
 */
#[wasm_bindgen]
pub fn fft_2d_inverse(
    real_ptr: u32,
    imag_ptr: u32,
    rows: u32,
    cols: u32,
    real_out_ptr: u32,
    imag_out_ptr: u32,
) -> Result<JsValue, JsValue> {
    use num_complex::Complex;
    use rustfft::num_traits::Zero;
    use rustfft::FftPlanner;
    
    let rows = rows as usize;
    let cols = cols as usize;
    let size = rows * cols;
    let norm = 1.0 / (size as f64);
    
    let start_ms = js_sys::Date::now();
    
    // Read input from WASM memory
    let real_data: Vec<f64> = (0..size)
        .map(|i| unsafe {
            let ptr = (real_ptr as *const f64).add(i);
            std::ptr::read(ptr)
        })
        .collect();
    
    let imag_data: Vec<f64> = (0..size)
        .map(|i| unsafe {
            let ptr = (imag_ptr as *const f64).add(i);
            std::ptr::read(ptr)
        })
        .collect();
    
    let mut data: Vec<Complex<f64>> = real_data
        .iter()
        .zip(imag_data.iter())
        .map(|(r, i)| Complex::new(*r, -i))  // Conjugate
        .collect();
    
    // Create FFT planner
    let mut planner = FftPlanner::new();
    
    // Perform row-wise FFT
    let row_fft = planner.plan_fft_forward(cols);
    for row in 0..rows {
        let start_idx = row * cols;
        row_fft.process(&mut data[start_idx..start_idx + cols]);
    }
    
    // Transpose
    let mut transposed = vec![Complex::zero(); size];
    for i in 0..rows {
        for j in 0..cols {
            transposed[j * rows + i] = data[i * cols + j];
        }
    }
    data = transposed;
    
    // Perform column-wise FFT
    let col_fft = planner.plan_fft_forward(rows);
    for col in 0..cols {
        let start_idx = col * rows;
        col_fft.process(&mut data[start_idx..start_idx + rows]);
    }
    
    // Transpose back
    transposed = vec![Complex::zero(); size];
    for i in 0..cols {
        for j in 0..rows {
            transposed[j * cols + i] = data[i * rows + j] * norm;
        }
    }
    data = transposed;
    
    let elapsed_ms = (js_sys::Date::now() - start_ms).max(0.0);
    
    // Write output to WASM memory (conjugate back)
    unsafe {
        let mut out_real = real_out_ptr as *mut f64;
        let mut out_imag = imag_out_ptr as *mut f64;
        for value in data {
            std::ptr::write(out_real, value.re);
            std::ptr::write(out_imag, -value.im);  // Conjugate back
            out_real = out_real.add(1);
            out_imag = out_imag.add(1);
        }
    }
    
    serde_wasm_bindgen::to_value(&serde_json::json!({
        "status": "ifft_complete",
        "rows": rows,
        "cols": cols,
        "timeMs": elapsed_ms,
        "method": "rustfft"
    }))
    .map_err(|err| JsValue::from_str(&format!("serialize error: {}", err)))
}

fn solve_linear_system_internal(a_flat: &[f64], n: usize, b: &[f64]) -> Option<Vec<f64>> {
    if n == 0 {
        return Some(Vec::new());
    }
    if a_flat.len() != n * n || b.len() != n {
        return None;
    }

    let mut a = a_flat.to_vec();
    let mut rhs = b.to_vec();

    for col in 0..n {
        let mut pivot_row = col;
        let mut pivot_abs = a[col * n + col].abs();
        for row in (col + 1)..n {
            let v = a[row * n + col].abs();
            if v > pivot_abs {
                pivot_abs = v;
                pivot_row = row;
            }
        }

        if !pivot_abs.is_finite() || pivot_abs < 1e-18 {
            return None;
        }

        if pivot_row != col {
            for j in col..n {
                a.swap(col * n + j, pivot_row * n + j);
            }
            rhs.swap(col, pivot_row);
        }

        let pivot = a[col * n + col];
        for row in (col + 1)..n {
            let factor = a[row * n + col] / pivot;
            a[row * n + col] = 0.0;
            for j in (col + 1)..n {
                a[row * n + j] -= factor * a[col * n + j];
            }
            rhs[row] -= factor * rhs[col];
        }
    }

    let mut x = vec![0.0_f64; n];
    for i in (0..n).rev() {
        let mut sum = rhs[i];
        for j in (i + 1)..n {
            sum -= a[i * n + j] * x[j];
        }
        let diag = a[i * n + i];
        if !diag.is_finite() || diag.abs() < 1e-18 {
            return None;
        }
        x[i] = sum / diag;
        if !x[i].is_finite() {
            return None;
        }
    }

    Some(x)
}

fn solve_spd_linear_system_internal(a_flat: &[f64], n: usize, b: &[f64]) -> Option<Vec<f64>> {
    if n == 0 {
        return Some(Vec::new());
    }
    if a_flat.len() != n * n || b.len() != n {
        return None;
    }

    // Lower-triangular Cholesky factor L such that A = L L^T
    let mut l = vec![0.0_f64; n * n];

    for i in 0..n {
        for j in 0..=i {
            let mut sum = a_flat[i * n + j];
            for k in 0..j {
                sum -= l[i * n + k] * l[j * n + k];
            }

            if i == j {
                if !sum.is_finite() || sum <= 1e-20 {
                    return None;
                }
                l[i * n + j] = sum.sqrt();
            } else {
                let diag = l[j * n + j];
                if !diag.is_finite() || diag <= 1e-20 {
                    return None;
                }
                l[i * n + j] = sum / diag;
            }
        }
    }

    // Forward solve: L y = b
    let mut y = vec![0.0_f64; n];
    for i in 0..n {
        let mut sum = b[i];
        for k in 0..i {
            sum -= l[i * n + k] * y[k];
        }
        let diag = l[i * n + i];
        if !diag.is_finite() || diag <= 1e-20 {
            return None;
        }
        y[i] = sum / diag;
    }

    // Backward solve: L^T x = y
    let mut x = vec![0.0_f64; n];
    for i in (0..n).rev() {
        let mut sum = y[i];
        for k in (i + 1)..n {
            sum -= l[k * n + i] * x[k];
        }
        let diag = l[i * n + i];
        if !diag.is_finite() || diag <= 1e-20 {
            return None;
        }
        x[i] = sum / diag;
        if !x[i].is_finite() {
            return None;
        }
    }

    Some(x)
}

#[wasm_bindgen]
pub fn solve_linear_system(a_flat: &[f64], n: usize, b: &[f64]) -> Vec<f64> {
    match solve_linear_system_internal(a_flat, n, b) {
        Some(sol) => sol,
        None => vec![f64::NAN; n],
    }
}

#[wasm_bindgen]
pub fn solve_spd_linear_system(a_flat: &[f64], n: usize, b: &[f64]) -> Vec<f64> {
    match solve_spd_linear_system_internal(a_flat, n, b) {
        Some(sol) => sol,
        None => match solve_linear_system_internal(a_flat, n, b) {
            Some(fallback) => fallback,
            None => vec![f64::NAN; n],
        },
    }
}

#[wasm_bindgen]
pub fn build_normal_equations(j_flat: &[f64], m: usize, n: usize, r: &[f64]) -> Vec<f64> {
    if m == 0 || n == 0 {
        return vec![];
    }
    if j_flat.len() != m * n || r.len() != m {
        return vec![f64::NAN; n * n + n];
    }

    let mut out = vec![0.0_f64; n * n + n];
    let (a_flat, g) = out.split_at_mut(n * n);

    // g = J^T r
    for j in 0..n {
        let mut gj = 0.0_f64;
        for i in 0..m {
            gj += j_flat[i * n + j] * r[i];
        }
        g[j] = gj;
    }

    // A = J^T J (symmetric)
    for j in 0..n {
        for k in 0..=j {
            let mut s = 0.0_f64;
            for i in 0..m {
                s += j_flat[i * n + j] * j_flat[i * n + k];
            }
            a_flat[j * n + k] = s;
            a_flat[k * n + j] = s;
        }
    }

    out
}

#[wasm_bindgen]
pub fn generate_fd_perturbation_points(x: &[f64], steps: &[f64], n: usize) -> Vec<f64> {
    if n == 0 {
        return vec![];
    }
    if x.len() != n || steps.len() != n {
        return vec![f64::NAN; n * n];
    }

    let mut out = vec![0.0_f64; n * n];
    for col in 0..n {
        let step = steps[col];
        if !step.is_finite() {
            return vec![f64::NAN; n * n];
        }

        let row_start = col * n;
        let row_end = row_start + n;
        out[row_start..row_end].copy_from_slice(x);

        let base = out[row_start + col];
        let perturbed = base + step;
        if !perturbed.is_finite() {
            return vec![f64::NAN; n * n];
        }
        out[row_start + col] = perturbed;
    }

    out
}

#[wasm_bindgen]
pub fn assemble_fd_jacobian(
    r0: &[f64],
    r_batches: &[f64],
    m: usize,
    n: usize,
    steps: &[f64],
) -> Vec<f64> {
    if m == 0 || n == 0 {
        return vec![];
    }
    if r0.len() != m || r_batches.len() != m * n || steps.len() != n {
        return vec![f64::NAN; m * n];
    }

    let mut jac = vec![0.0_f64; m * n];

    for col in 0..n {
        let h = steps[col];
        if !h.is_finite() || h.abs() < 1e-30 {
            for row in 0..m {
                jac[row * n + col] = 0.0;
            }
            continue;
        }

        let base = col * m;
        for row in 0..m {
            let r1 = r_batches[base + row];
            let r_base = r0[row];
            let deriv = (r1 - r_base) / h;
            jac[row * n + col] = if deriv.is_finite() {
                deriv.max(-1e12).min(1e12)
            } else {
                0.0
            };
        }
    }

    jac
}

#[wasm_bindgen]
pub fn optimize_system_in_wasm(payload_json: String) -> Result<String, JsValue> {
    let payload: Value = serde_json::from_str(&payload_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid payload JSON: {e}")))?;

    let x_vals = payload
        .get("x")
        .and_then(|v| v.as_array())
        .ok_or_else(|| JsValue::from_str("payload.x must be an array"))?;
    let n = x_vals.len();
    if n == 0 {
        return Err(JsValue::from_str("payload.x must not be empty"));
    }

    let mut x = vec![0.0_f64; n];
    for i in 0..n {
        let v = value_to_f64(&x_vals[i]).ok_or_else(|| JsValue::from_str("payload.x contains non-finite values"))?;
        if !v.is_finite() {
            return Err(JsValue::from_str("payload.x contains non-finite values"));
        }
        x[i] = v;
    }

    let steps_vals = payload
        .get("steps")
        .and_then(|v| v.as_array())
        .ok_or_else(|| JsValue::from_str("payload.steps must be an array"))?;
    if steps_vals.len() != n {
        return Err(JsValue::from_str("payload.steps length must match payload.x length"));
    }
    let mut steps = vec![0.0_f64; n];
    for i in 0..n {
        let h = value_to_f64(&steps_vals[i]).ok_or_else(|| JsValue::from_str("payload.steps contains invalid values"))?;
        if !h.is_finite() || h == 0.0 {
            return Err(JsValue::from_str("payload.steps contains zero/non-finite values"));
        }
        steps[i] = h;
    }

    let r0_vals = payload
        .get("residual0")
        .and_then(|v| v.as_array())
        .ok_or_else(|| JsValue::from_str("payload.residual0 must be an array"))?;
    let m = r0_vals.len();
    if m == 0 {
        return Err(JsValue::from_str("payload.residual0 must not be empty"));
    }

    let mut r0 = vec![0.0_f64; m];
    for i in 0..m {
        let v = value_to_f64(&r0_vals[i]).ok_or_else(|| JsValue::from_str("payload.residual0 contains invalid values"))?;
        if !v.is_finite() {
            return Err(JsValue::from_str("payload.residual0 contains non-finite values"));
        }
        r0[i] = v;
    }

    let r1_cols = payload
        .get("residualsPerturbed")
        .and_then(|v| v.as_array())
        .ok_or_else(|| JsValue::from_str("payload.residualsPerturbed must be an array of arrays"))?;
    if r1_cols.len() != n {
        return Err(JsValue::from_str("payload.residualsPerturbed column count must match variable count"));
    }

    let mut r_batches = vec![0.0_f64; m * n];
    for col in 0..n {
        let col_arr = r1_cols[col]
            .as_array()
            .ok_or_else(|| JsValue::from_str("payload.residualsPerturbed contains a non-array column"))?;
        if col_arr.len() < m {
            return Err(JsValue::from_str("payload.residualsPerturbed column length is smaller than residual0 length"));
        }
        let base = col * m;
        for row in 0..m {
            let v = value_to_f64(&col_arr[row]).ok_or_else(|| JsValue::from_str("payload.residualsPerturbed contains invalid values"))?;
            if !v.is_finite() {
                return Err(JsValue::from_str("payload.residualsPerturbed contains non-finite values"));
            }
            r_batches[base + row] = v;
        }
    }

    let damping = payload
        .get("damping")
        .and_then(value_to_f64)
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(1e-6);

    let trust_radius = payload
        .get("trustRegionRadius")
        .and_then(value_to_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);

    let mut var_scales = vec![1.0_f64; n];
    if let Some(scales_arr) = payload.get("varScales").and_then(|v| v.as_array()) {
        if scales_arr.len() == n {
            for i in 0..n {
                let s = value_to_f64(&scales_arr[i]).unwrap_or(1.0).abs();
                var_scales[i] = if s.is_finite() && s > 1e-18 { s } else { 1.0 };
            }
        }
    }

    let j_flat = assemble_fd_jacobian(&r0, &r_batches, m, n, &steps);
    if j_flat.len() != m * n || j_flat.iter().any(|v| !v.is_finite()) {
        return Err(JsValue::from_str("failed to build Jacobian from perturbed residuals"));
    }

    let packed_ne = build_normal_equations(&j_flat, m, n, &r0);
    if packed_ne.len() != n * n + n || packed_ne.iter().any(|v| !v.is_finite()) {
        return Err(JsValue::from_str("failed to build normal equations"));
    }

    let mut a = packed_ne[0..(n * n)].to_vec();
    let g = &packed_ne[(n * n)..];
    for i in 0..n {
        a[i * n + i] += damping;
    }
    let rhs: Vec<f64> = g.iter().map(|v| -(*v)).collect();

    let dx = solve_spd_linear_system_internal(&a, n, &rhs)
        .or_else(|| solve_linear_system_internal(&a, n, &rhs))
        .ok_or_else(|| JsValue::from_str("failed to solve damped normal equations"))?;

    let mut dx_limited = dx;
    let mut max_scaled = 0.0_f64;
    for i in 0..n {
        let s = var_scales[i];
        let scaled = dx_limited[i] / s;
        let abs_scaled = scaled.abs();
        if abs_scaled.is_finite() && abs_scaled > max_scaled {
            max_scaled = abs_scaled;
        }
    }
    if max_scaled.is_finite() && max_scaled > trust_radius && max_scaled > 0.0 {
        let f = trust_radius / max_scaled;
        for i in 0..n {
            dx_limited[i] *= f;
        }
    }

    let mut x_next = vec![0.0_f64; n];
    for i in 0..n {
        x_next[i] = x[i] + dx_limited[i];
    }

    let mut g_dot_dx = 0.0_f64;
    for i in 0..n {
        g_dot_dx += g[i] * dx_limited[i];
    }
    let mut dx_a_dx = 0.0_f64;
    for i in 0..n {
        let mut adx_i = 0.0_f64;
        for j in 0..n {
            adx_i += a[i * n + j] * dx_limited[j];
        }
        dx_a_dx += dx_limited[i] * adx_i;
    }
    let predicted_reduction = -(g_dot_dx + 0.5 * dx_a_dx);

    Ok(serde_json::to_string(&serde_json::json!({
        "ok": true,
        "status": "pilot-one-iteration",
        "xNext": x_next,
        "dx": dx_limited,
        "predictedReduction": if predicted_reduction.is_finite() { predicted_reduction } else { 0.0 },
        "jacobianShape": [m, n],
        "usedDamping": damping,
        "usedTrustRegionRadius": trust_radius
    }))
    .map_err(|err| JsValue::from_str(&format!("serialize error: {}", err)))?)
}

/// Phase 2: Solve unconstrained QP subproblem for SQP
///   min 0.5 * dx^T * H * dx + g^T * dx
/// by solving linear system:
///   H * dx = -g
///
/// Returns packed vector of length (n + 1):
///   [dx_0, ..., dx_{n-1}, predicted_reduction]
/// On failure returns [NaN; n + 1].
#[wasm_bindgen]
pub fn solve_qp_subproblem_unconstrained(
    h_flat: &[f64],
    n: usize,
    g: &[f64],
    damping: f64,
) -> Vec<f64> {
    if n == 0 || h_flat.len() != n * n || g.len() != n {
        return vec![f64::NAN; n.saturating_add(1)];
    }

    let mut rhs = vec![0.0_f64; n];
    for i in 0..n {
        let gi = g[i];
        if !gi.is_finite() {
            return vec![f64::NAN; n + 1];
        }
        rhs[i] = -gi;
    }

    let base_damping = if damping.is_finite() && damping > 0.0 { damping } else { 1e-10 };

    // Try regularized solves with increasing diagonal damping.
    let mut sol: Option<Vec<f64>> = None;
    for k in 0..6 {
        let reg = base_damping * 10_f64.powi(k);
        let mut h_reg = h_flat.to_vec();
        for i in 0..n {
            h_reg[i * n + i] += reg;
        }

        sol = solve_spd_linear_system_internal(&h_reg, n, &rhs)
            .or_else(|| solve_linear_system_internal(&h_reg, n, &rhs));
        if sol.is_some() {
            break;
        }
    }

    let dx = match sol {
        Some(v) => v,
        None => return vec![f64::NAN; n + 1],
    };

    // Predicted reduction for quadratic model:
    // m(0) - m(dx) = -(g^T dx + 0.5 dx^T H dx)
    let mut g_dot_dx = 0.0_f64;
    for i in 0..n {
        g_dot_dx += g[i] * dx[i];
    }

    let mut dx_h_dx = 0.0_f64;
    for i in 0..n {
        let mut hdx_i = 0.0_f64;
        for j in 0..n {
            hdx_i += h_flat[i * n + j] * dx[j];
        }
        dx_h_dx += dx[i] * hdx_i;
    }
    let predicted_reduction = -(g_dot_dx + 0.5 * dx_h_dx);

    let mut out = Vec::with_capacity(n + 1);
    out.extend(dx);
    out.push(if predicted_reduction.is_finite() { predicted_reduction } else { f64::NAN });
    out
}

/// Phase 2: Solve equality-constrained QP subproblem for SQP
///   min 0.5 * dx^T * H * dx + g^T * dx
///   s.t. A * dx + c = 0
///
/// KKT system:
///   [H  A^T][dx] = [-g]
///   [A   0 ][ν ]   [-c]
///
/// Returns packed vector of length (n + 1):
///   [dx_0, ..., dx_{n-1}, predicted_reduction]
/// On failure returns [NaN; n + 1].
#[wasm_bindgen]
pub fn solve_qp_subproblem_kkt_equality(
    h_flat: &[f64],
    n: usize,
    g: &[f64],
    a_flat: &[f64],
    m: usize,
    c: &[f64],
    damping: f64,
) -> Vec<f64> {
    if n == 0 || h_flat.len() != n * n || g.len() != n {
        return vec![f64::NAN; n.saturating_add(1)];
    }
    if m == 0 || a_flat.len() != m * n || c.len() != m {
        return solve_qp_subproblem_unconstrained(h_flat, n, g, damping);
    }

    let total = n + m;
    let mut rhs = vec![0.0_f64; total];
    for i in 0..n {
        let gi = g[i];
        if !gi.is_finite() {
            return vec![f64::NAN; n + 1];
        }
        rhs[i] = -gi;
    }
    for i in 0..m {
        let ci = c[i];
        if !ci.is_finite() {
            return vec![f64::NAN; n + 1];
        }
        rhs[n + i] = -ci;
    }

    let base_damping = if damping.is_finite() && damping > 0.0 { damping } else { 1e-10 };
    let mut sol: Option<Vec<f64>> = None;

    for k in 0..6 {
        let reg = base_damping * 10_f64.powi(k);
        let mut kkt = vec![0.0_f64; total * total];

        // Top-left: H + reg I
        for i in 0..n {
            for j in 0..n {
                kkt[i * total + j] = h_flat[i * n + j];
            }
            kkt[i * total + i] += reg;
        }

        // Top-right: A^T
        for i in 0..n {
            for j in 0..m {
                kkt[i * total + (n + j)] = a_flat[j * n + i];
            }
        }

        // Bottom-left: A
        for i in 0..m {
            for j in 0..n {
                kkt[(n + i) * total + j] = a_flat[i * n + j];
            }
        }

        // Bottom-right kept zero (standard KKT).
        sol = solve_linear_system_internal(&kkt, total, &rhs);
        if sol.is_some() {
            break;
        }
    }

    let packed = match sol {
        Some(v) => v,
        None => return vec![f64::NAN; n + 1],
    };

    let dx = &packed[..n];

    // Predicted reduction (quadratic model only)
    let mut g_dot_dx = 0.0_f64;
    for i in 0..n {
        g_dot_dx += g[i] * dx[i];
    }

    let mut dx_h_dx = 0.0_f64;
    for i in 0..n {
        let mut hdx_i = 0.0_f64;
        for j in 0..n {
            hdx_i += h_flat[i * n + j] * dx[j];
        }
        dx_h_dx += dx[i] * hdx_i;
    }
    let predicted_reduction = -(g_dot_dx + 0.5 * dx_h_dx);

    let mut out = Vec::with_capacity(n + 1);
    out.extend_from_slice(dx);
    out.push(if predicted_reduction.is_finite() { predicted_reduction } else { f64::NAN });
    out
}

/// Phase 3: Armijo backtracking line search with JS merit callback
///
/// Finds alpha in {alpha_init, alpha_init*rho, ...} satisfying:
///   f(x + alpha * p) <= f0 + c1 * alpha * (grad0^T p)
///
/// Returns accepted alpha, or 0.0 on failure.
#[wasm_bindgen]
pub fn backtracking_line_search_armijo(
    x: &[f64],
    p: &[f64],
    f0: f64,
    grad0: &[f64],
    alpha_init: f64,
    rho: f64,
    c1: f64,
    max_iter: usize,
    merit_eval_callback: &Function,
) -> f64 {
    let n = x.len();
    if n == 0 || p.len() != n || grad0.len() != n {
        return 0.0;
    }
    if !f0.is_finite() {
        return 0.0;
    }

    let mut alpha = if alpha_init.is_finite() && alpha_init > 0.0 { alpha_init } else { 1.0 };
    let rho_eff = if rho.is_finite() && rho > 0.0 && rho < 1.0 { rho } else { 0.5 };
    let c1_eff = if c1.is_finite() && c1 > 0.0 && c1 < 1.0 { c1 } else { 1e-4 };
    let iter_cap = if max_iter == 0 { 20 } else { max_iter.min(128) };

    let mut directional_derivative = 0.0_f64;
    for i in 0..n {
        directional_derivative += grad0[i] * p[i];
    }
    if !directional_derivative.is_finite() {
        return 0.0;
    }

    let mut x_trial = vec![0.0_f64; n];
    for _ in 0..iter_cap {
        for i in 0..n {
            x_trial[i] = x[i] + alpha * p[i];
        }

        let trial_arr = Float64Array::from(x_trial.as_slice());
        let merit_val = match merit_eval_callback.call1(&JsValue::NULL, &trial_arr.into()) {
            Ok(v) => v.as_f64().unwrap_or(f64::NAN),
            Err(_) => return 0.0,
        };

        if merit_val.is_finite() {
            let rhs = f0 + c1_eff * alpha * directional_derivative;
            if merit_val <= rhs {
                return alpha;
            }
        }

        alpha *= rho_eff;
        if !alpha.is_finite() || alpha < 1e-16 {
            return 0.0;
        }
    }

    0.0
}

/// Phase 3: Trust-region radius update helper
///
/// ratio = actual_reduction / predicted_reduction
/// - ratio < eta1: shrink radius by gamma_dec
/// - ratio > eta2: expand radius by gamma_inc
/// - otherwise keep radius
#[wasm_bindgen]
pub fn update_trust_region_radius(
    predicted_reduction: f64,
    actual_reduction: f64,
    current_radius: f64,
    eta1: f64,
    eta2: f64,
    gamma_dec: f64,
    gamma_inc: f64,
    min_radius: f64,
    max_radius: f64,
) -> f64 {
    let cur = if current_radius.is_finite() && current_radius > 0.0 { current_radius } else { 1.0 };
    let min_r = if min_radius.is_finite() && min_radius > 0.0 { min_radius } else { 1e-8 };
    let max_r = if max_radius.is_finite() && max_radius >= min_r { max_radius } else { 1e8 };
    let e1 = if eta1.is_finite() { eta1 } else { 0.25 };
    let e2 = if eta2.is_finite() { eta2 } else { 0.75 };
    let g_dec = if gamma_dec.is_finite() && gamma_dec > 0.0 && gamma_dec < 1.0 { gamma_dec } else { 0.5 };
    let g_inc = if gamma_inc.is_finite() && gamma_inc > 1.0 { gamma_inc } else { 2.0 };

    let mut next = cur;
    if predicted_reduction.is_finite() && predicted_reduction.abs() > 1e-18 && actual_reduction.is_finite() {
        let ratio = actual_reduction / predicted_reduction;
        if ratio < e1 {
            next = cur * g_dec;
        } else if ratio > e2 {
            next = cur * g_inc;
        }
    }

    if !next.is_finite() {
        return cur.clamp(min_r, max_r);
    }
    next.clamp(min_r, max_r)
}

#[wasm_bindgen]
pub fn generate_annular_offsets_flat(ray_count: usize, max_radius: f64, ring_count: usize) -> Vec<f64> {
    let mut out = Vec::<f64>::new();
    if ray_count == 0 {
        return out;
    }

    let safe_ring_count = ring_count.max(1);
    let rings = safe_ring_count.min(ray_count);

    let center_rays = ray_count.min(1);
    let mut remaining_rays = ray_count.saturating_sub(center_rays);

    if center_rays == 1 {
        out.push(0.0);
        out.push(0.0);
    }

    if remaining_rays == 0 {
        return out;
    }

    let step = if rings > 0 {
        max_radius / (rings as f64)
    } else {
        max_radius
    };

    for idx in 0..rings {
        if remaining_rays == 0 {
            break;
        }
        let radius = step * ((idx + 1) as f64);
        let rings_remaining = rings - idx;
        let rays_for_this_ring = ((remaining_rays / rings_remaining).max(4)) as usize;
        let angles = rays_for_this_ring;
        let angle_step = (2.0 * std::f64::consts::PI) / (angles as f64);
        let start_angle = if (idx % 2) == 0 { 0.0 } else { angle_step * 0.5 };

        for i in 0..angles {
            if remaining_rays == 0 {
                break;
            }
            let angle = start_angle + (i as f64) * angle_step;
            out.push(radius * angle.cos());
            out.push(radius * angle.sin());
            remaining_rays -= 1;
        }
    }

    out
}

#[wasm_bindgen]
pub fn generate_centered_grid_offsets_flat(ray_count: usize, half_extent: f64) -> Vec<f64> {
    let mut out = Vec::<f64>::new();
    if ray_count == 0 {
        return out;
    }

    let mut grid_size = (ray_count as f64).sqrt().ceil() as usize;
    if grid_size == 0 {
        grid_size = 1;
    }
    if (grid_size % 2) == 0 {
        grid_size += 1;
    }

    let spacing = if grid_size > 1 {
        (2.0 * half_extent) / ((grid_size - 1) as f64)
    } else {
        0.0
    };
    let center = ((grid_size - 1) as f64) * 0.5;

    let mut selected = 0usize;
    let max_layer = grid_size / 2;
    for layer in 0..=max_layer {
        if selected >= ray_count {
            break;
        }

        let mut layer_points: Vec<(f64, f64)> = Vec::new();
        for i in 0..grid_size {
            for j in 0..grid_size {
                let li = ((i as f64) - center).abs() as usize;
                let lj = ((j as f64) - center).abs() as usize;
                if li.max(lj) != layer {
                    continue;
                }
                let u = if grid_size > 1 { ((i as f64) - center) * spacing } else { 0.0 };
                let v = if grid_size > 1 { ((j as f64) - center) * spacing } else { 0.0 };
                layer_points.push((u, v));
            }
        }

        layer_points.sort_by(|a, b| {
            let au = a.0.abs();
            let av = a.1.abs();
            let bu = b.0.abs();
            let bv = b.1.abs();
            au.partial_cmp(&bu)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(av.partial_cmp(&bv).unwrap_or(std::cmp::Ordering::Equal))
                .then(a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
                .then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        });

        for (u, v) in layer_points {
            if selected >= ray_count {
                break;
            }
            out.push(u);
            out.push(v);
            selected += 1;
        }
    }

    out
}

#[wasm_bindgen]
pub fn generate_parallel_start_points_flat(
    origin: &[f64],
    u_axis: &[f64],
    v_axis: &[f64],
    offsets: &[f64],
    count: usize,
) -> Vec<f64> {
    let mut out = Vec::<f64>::new();
    if origin.len() < 3 || u_axis.len() < 3 || v_axis.len() < 3 {
        return out;
    }
    if offsets.len() < count * 2 {
        return out;
    }

    out.reserve(count * 5);
    let ox = origin[0];
    let oy = origin[1];
    let oz = origin[2];
    let ux = u_axis[0];
    let uy = u_axis[1];
    let uz = u_axis[2];
    let vx = v_axis[0];
    let vy = v_axis[1];
    let vz = v_axis[2];

    for i in 0..count {
        let base = i * 2;
        let ou = offsets[base];
        let ov = offsets[base + 1];
        out.push(ox + ou * ux + ov * vx);
        out.push(oy + ou * uy + ov * vy);
        out.push(oz + ou * uz + ov * vz);
        out.push(ou);
        out.push(ov);
    }

    out
}

// ============================================================================
// Phase 1: Linear Algebra Kernel Expansion for Optimization
// ============================================================================

/// Vector addition with scaling: result = x + alpha * y
#[wasm_bindgen]
pub fn vector_add_scaled(x: &[f64], y: &[f64], alpha: f64) -> Vec<f64> {
    if x.len() != y.len() {
        return vec![f64::NAN; x.len()];
    }
    x.iter()
        .zip(y.iter())
        .map(|(xi, yi)| xi + alpha * yi)
        .collect()
}

/// Vector dot product: result = x · y
#[wasm_bindgen]
pub fn vector_dot(x: &[f64], y: &[f64]) -> f64 {
    if x.len() != y.len() {
        return f64::NAN;
    }
    x.iter().zip(y.iter()).map(|(xi, yi)| xi * yi).sum()
}

/// Vector L2 norm: result = ||x||₂
#[wasm_bindgen]
pub fn vector_norm(x: &[f64]) -> f64 {
    let sum_sq: f64 = x.iter().map(|xi| xi * xi).sum();
    sum_sq.sqrt()
}

/// Matrix-vector multiplication: result = A * x
/// A is stored in row-major order (flat array)
#[wasm_bindgen]
pub fn matrix_vector_multiply(a_flat: &[f64], x: &[f64], rows: usize, cols: usize) -> Vec<f64> {
    if a_flat.len() != rows * cols || x.len() != cols {
        return vec![f64::NAN; rows];
    }
    
    let mut result = vec![0.0; rows];
    for i in 0..rows {
        let mut sum = 0.0;
        for j in 0..cols {
            sum += a_flat[i * cols + j] * x[j];
        }
        result[i] = sum;
    }
    result
}

/// Cholesky factorization: A = L * L^T
/// Returns lower triangular matrix L in row-major flat format
/// Returns empty vector on failure (not positive definite)
#[wasm_bindgen]
pub fn cholesky_factorization(a_flat: &[f64], n: usize) -> Vec<f64> {
    if a_flat.len() != n * n {
        return Vec::new();
    }
    
    let mut l = vec![0.0_f64; n * n];
    
    for i in 0..n {
        for j in 0..=i {
            let mut sum = a_flat[i * n + j];
            for k in 0..j {
                sum -= l[i * n + k] * l[j * n + k];
            }
            
            if i == j {
                if !sum.is_finite() || sum <= 1e-20 {
                    return Vec::new(); // Not positive definite
                }
                l[i * n + j] = sum.sqrt();
            } else {
                let diag = l[j * n + j];
                if !diag.is_finite() || diag <= 1e-20 {
                    return Vec::new();
                }
                l[i * n + j] = sum / diag;
            }
        }
    }
    
    l
}

/// BFGS Hessian approximation update
/// Updates H in-place using: H_new = H + (y*y^T)/(y^T*s) - (H*s*(H*s)^T)/(s^T*H*s)
/// where s = step, y = gradient_difference
/// H is stored in row-major flat format
#[wasm_bindgen]
pub fn bfgs_update(h_flat: &mut [f64], s: &[f64], y: &[f64], n: usize) -> bool {
    if h_flat.len() != n * n || s.len() != n || y.len() != n {
        return false;
    }
    
    // Compute y^T * s
    let mut y_dot_s = 0.0;
    for i in 0..n {
        y_dot_s += y[i] * s[i];
    }
    
    // Check curvature condition
    if y_dot_s <= 1e-12 {
        return false; // Skip update if curvature condition not satisfied
    }
    
    // Compute H * s
    let mut hs = vec![0.0; n];
    for i in 0..n {
        let mut sum = 0.0;
        for j in 0..n {
            sum += h_flat[i * n + j] * s[j];
        }
        hs[i] = sum;
    }
    
    // Compute s^T * H * s
    let mut s_dot_hs = 0.0;
    for i in 0..n {
        s_dot_hs += s[i] * hs[i];
    }
    
    if s_dot_hs <= 1e-20 {
        return false;
    }
    
    // Update H: H = H + (y*y^T)/(y^T*s) - (H*s*(H*s)^T)/(s^T*H*s)
    let rho = 1.0 / y_dot_s;
    let gamma = 1.0 / s_dot_hs;
    
    for i in 0..n {
        for j in 0..n {
            let idx = i * n + j;
            h_flat[idx] = h_flat[idx] + rho * y[i] * y[j] - gamma * hs[i] * hs[j];
        }
    }
    
    true
}

/// QR factorization using Householder reflections
/// Returns (Q, R) where Q is orthogonal and R is upper triangular
/// Both stored in row-major flat format
/// Returns empty vectors on failure
#[wasm_bindgen]
pub fn qr_factorization(a_flat: &[f64], rows: usize, cols: usize) -> Vec<f64> {
    if a_flat.len() != rows * cols || rows < cols {
        return Vec::new();
    }
    
    let mut r = a_flat.to_vec();
    let mut q = vec![0.0; rows * rows];
    
    // Initialize Q as identity
    for i in 0..rows {
        q[i * rows + i] = 1.0;
    }
    
    for k in 0..cols.min(rows - 1) {
        // Extract column k from row k onwards
        let mut x = vec![0.0; rows - k];
        for i in k..rows {
            x[i - k] = r[i * cols + k];
        }
        
        // Compute norm
        let norm_x: f64 = x.iter().map(|v| v * v).sum::<f64>().sqrt();
        if norm_x < 1e-14 {
            continue; // Column is already zero
        }
        
        // Compute Householder vector
        let s = if x[0] < 0.0 { 1.0 } else { -1.0 };
        let u1 = x[0] - s * norm_x;
        let mut w = vec![0.0; rows - k];
        w[0] = 1.0;
        for i in 1..rows - k {
            w[i] = x[i] / u1;
        }
        
        let tau = -s * u1 / norm_x;
        
        // Apply Householder reflection to R
        for j in k..cols {
            let mut sum = 0.0;
            for i in 0..(rows - k) {
                sum += w[i] * r[(k + i) * cols + j];
            }
            for i in 0..(rows - k) {
                r[(k + i) * cols + j] -= tau * w[i] * sum;
            }
        }
        
        // Apply Householder reflection to Q
        for j in 0..rows {
            let mut sum = 0.0;
            for i in 0..(rows - k) {
                sum += w[i] * q[(k + i) * rows + j];
            }
            for i in 0..(rows - k) {
                q[(k + i) * rows + j] -= tau * w[i] * sum;
            }
        }
    }
    
    // Concatenate Q and R into single output vector
    // Format: [n_rows, n_cols, Q_data..., R_data...]
    let mut result = Vec::with_capacity(2 + rows * rows + rows * cols);
    result.push(rows as f64);
    result.push(cols as f64);
    result.extend(q);
    result.extend(r);
    
    result
}