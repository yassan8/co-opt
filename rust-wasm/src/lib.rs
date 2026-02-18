use serde_json::Value;
use wasm_bindgen::prelude::*;

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
    
    let start = std::time::Instant::now();
    
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
    
    let elapsed = start.elapsed();
    
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
        "timeMs": elapsed.as_secs_f64() * 1000.0,
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
    
    let start = std::time::Instant::now();
    
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
    
    let elapsed = start.elapsed();
    
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
        "timeMs": elapsed.as_secs_f64() * 1000.0,
        "method": "rustfft"
    }))
    .map_err(|err| JsValue::from_str(&format!("serialize error: {}", err)))
}