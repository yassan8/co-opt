use serde::Serialize;
use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;
use js_sys::{Float64Array, Function};

const EPS_R: f64 = 1e-10;
const OPT_STATUS_OK: u32 = 0;
const OPT_STATUS_INVALID_INPUT: u32 = 1;
const OPT_STATUS_NON_FINITE_INPUT: u32 = 2;
const OPT_STATUS_JACOBIAN_FAILURE: u32 = 3;
const OPT_STATUS_NORMAL_EQ_FAILURE: u32 = 4;
const OPT_STATUS_LINEAR_SOLVE_FAILURE: u32 = 5;
const OPT_STATUS_INTERNAL_ERROR: u32 = 6;

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

fn norm_string(row: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = get_field(row, key).and_then(value_to_string) {
            let s = v.trim().to_lowercase();
            if !s.is_empty() {
                return s;
            }
        }
    }
    String::new()
}

fn compact(s: &str) -> String {
    s.chars()
        .filter(|c| *c != ' ' && *c != '_' && *c != '-')
        .collect::<String>()
        .to_lowercase()
}

fn is_object_row(row: &Value) -> bool {
    let s = norm_string(row, &["object type", "objectType", "object", "Object"]);
    let c = compact(&s);
    c == "object" || c == "objectsurface" || s.starts_with("object")
}

fn is_gap_row(row: &Value) -> bool {
    let candidates = [
        norm_string(row, &["surfType", "type", "surfaceType", "object type"]),
        norm_string(row, &["blockType", "block_type", "_blockType"]),
        norm_string(row, &["surfaceRole", "_surfaceRole"]),
    ];
    candidates.iter().any(|s| {
        let c = compact(s);
        c == "gap" || c == "airgap" || s == "gap" || s == "air gap"
    })
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

fn infer_refractive_index_from_material(material_raw: &str) -> Option<f64> {
    let n = parse_refractive_index_from_material(material_raw);
    if n > 0.0 { Some(n) } else { None }
}

fn parse_refractive_index_from_material(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    let upper = t.to_uppercase().replace(' ', "");
    if upper == "AIR" {
        return 1.0;
    }
    if let Ok(v) = t.parse::<f64>() {
        if v.is_finite() && v > 0.0 {
            return v;
        }
    }
    0.0
}

fn estimate_refractive_index_from_nd_vd(nd: f64, vd: f64, wavelength_um: f64) -> f64 {
    if !(nd.is_finite() && vd.is_finite()) || vd.abs() <= 1e-12 || nd <= 0.0 {
        return nd.max(1.0);
    }

    let lambda_d = 0.587_561_8_f64;
    let lambda_f = 0.486_132_7_f64;
    let lambda_c = 0.656_272_5_f64;

    let dispersion = (nd - 1.0) / vd;
    let n_f = nd + dispersion / 2.0;
    let n_c = nd - dispersion / 2.0;

    if wavelength_um >= lambda_f && wavelength_um <= lambda_c {
        if wavelength_um <= lambda_d {
            let t = (wavelength_um - lambda_f) / (lambda_d - lambda_f);
            return n_f + t * (nd - n_f);
        }
        let t = (wavelength_um - lambda_d) / (lambda_c - lambda_d);
        return nd + t * (n_c - nd);
    }

    let lambda_d_sq = lambda_d * lambda_d;
    let lambda_f_sq = lambda_f * lambda_f;
    let b = (n_f - nd) / (1.0 / lambda_f_sq - 1.0 / lambda_d_sq);
    let a = nd - b / lambda_d_sq;
    let n_est = a + b / (wavelength_um * wavelength_um);
    if n_est < 1.0 || n_est > 3.0 || !n_est.is_finite() {
        nd
    } else {
        n_est
    }
}

fn calculate_refractive_index_sellmeier(coeffs: &Map<String, Value>, wavelength_um: f64) -> Option<f64> {
    if wavelength_um <= 0.0 {
        return None;
    }
    let a1 = coeffs.get("A1").and_then(value_to_f64)?;
    let a2 = coeffs.get("A2").and_then(value_to_f64)?;
    let a3 = coeffs.get("A3").and_then(value_to_f64)?;
    let b1 = coeffs.get("B1").and_then(value_to_f64)?;
    let b2 = coeffs.get("B2").and_then(value_to_f64)?;
    let b3 = coeffs.get("B3").and_then(value_to_f64)?;

    let lambda2 = wavelength_um * wavelength_um;
    let n2 = 1.0
        + (a1 * lambda2) / (lambda2 - b1)
        + (a2 * lambda2) / (lambda2 - b2)
        + (a3 * lambda2) / (lambda2 - b3);
    let n = n2.sqrt();
    if n.is_finite() && (1.0..=3.0).contains(&n) {
        Some(n)
    } else {
        None
    }
}

fn calculate_refractive_index_schott(coeffs: &Map<String, Value>, wavelength_um: f64) -> Option<f64> {
    if wavelength_um <= 0.0 {
        return None;
    }
    let a0 = coeffs.get("A0").and_then(value_to_f64)?;
    let a1 = coeffs.get("A1").and_then(value_to_f64)?;
    let a2 = coeffs.get("A2").and_then(value_to_f64)?;
    let a3 = coeffs.get("A3").and_then(value_to_f64)?;
    let a4 = coeffs.get("A4").and_then(value_to_f64)?;
    let a5 = coeffs.get("A5").and_then(value_to_f64)?;

    let lambda2 = wavelength_um * wavelength_um;
    if lambda2.abs() <= 1e-18 {
        return None;
    }
    let lambda_minus2 = 1.0 / lambda2;
    let lambda_minus4 = lambda_minus2 * lambda_minus2;
    let lambda_minus6 = lambda_minus4 * lambda_minus2;
    let lambda_minus8 = lambda_minus4 * lambda_minus4;

    let n2 = a0
        + a1 * lambda2
        + a2 * lambda_minus2
        + a3 * lambda_minus4
        + a4 * lambda_minus6
        + a5 * lambda_minus8;
    let n = n2.sqrt();
    if n.is_finite() && (1.0..=3.0).contains(&n) {
        Some(n)
    } else {
        None
    }
}

fn get_correct_refractive_index(row: &Value, wavelength_um: f64) -> f64 {
    if let Some(obj) = row.as_object() {
        if let Some(sell) = obj
            .get("sellmeier")
            .or_else(|| obj.get("__cooptSellmeier"))
            .and_then(Value::as_object)
        {
            if let Some(n) = calculate_refractive_index_sellmeier(sell, wavelength_um) {
                return n;
            }
        }
        if let Some(schott) = obj
            .get("schott")
            .or_else(|| obj.get("__cooptSchott"))
            .and_then(Value::as_object)
        {
            if let Some(n) = calculate_refractive_index_schott(schott, wavelength_um) {
                return n;
            }
        }

        let nd = obj
            .get("__cooptActualRindex")
            .or_else(|| obj.get("rindex"))
            .or_else(|| obj.get("ref index"))
            .or_else(|| obj.get("refIndex"))
            .or_else(|| obj.get("Ref Index"))
            .or_else(|| obj.get("refractiveIndex"))
            .or_else(|| obj.get("index"))
            .or_else(|| obj.get("n"))
            .or_else(|| obj.get("nd"))
            .and_then(value_to_f64)
            .filter(|v| v.is_finite() && *v > 0.0);

        let vd = obj
            .get("__cooptActualAbbe")
            .or_else(|| obj.get("abbe"))
            .or_else(|| obj.get("Abbe"))
            .or_else(|| obj.get("vd"))
            .or_else(|| obj.get("Vd"))
            .and_then(value_to_f64)
            .filter(|v| v.is_finite() && *v > 0.0);

        if let Some(nd_val) = nd {
            if let Some(vd_val) = vd {
                return estimate_refractive_index_from_nd_vd(nd_val, vd_val, wavelength_um);
            }
            return nd_val;
        }
    }

    if let Some(m) = get_field(row, "material").and_then(value_to_string) {
        let n = parse_refractive_index_from_material(&m);
        if n > 0.0 {
            return n;
        }
    }

    0.0
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

fn toric_rotate_to_local_xy(x: f64, y: f64, axis_deg: f64) -> (f64, f64, f64, f64) {
    let axis_rad = axis_deg.to_radians();
    let cos_a = axis_rad.cos();
    let sin_a = axis_rad.sin();
    let x_rot = x * cos_a + y * sin_a;
    let y_rot = -x * sin_a + y * cos_a;
    (x_rot, y_rot, cos_a, sin_a)
}

fn toric_surface_sag(x: f64, y: f64, radius_x: f64, radius_y: f64, conic: f64, axis_deg: f64) -> f64 {
    if !x.is_finite() || !y.is_finite() {
        return f64::NAN;
    }

    let (x_rot, y_rot, _cos_a, _sin_a) = toric_rotate_to_local_xy(x, y, axis_deg);
    let x2 = x_rot * x_rot;
    let y2 = y_rot * y_rot;
    let k = if conic.is_finite() { conic } else { 0.0 };

    let mut sag_x = 0.0_f64;
    if radius_x.is_finite() && radius_x != 0.0 {
        let abs_rx = radius_x.abs();
        let sqrt_term_x = 1.0 - (1.0 + k) * x2 / (abs_rx * abs_rx);
        if !sqrt_term_x.is_finite() || sqrt_term_x < 0.0 {
            return f64::NAN;
        }
        let sag_x_abs = x2 / (abs_rx * (1.0 + sqrt_term_x.sqrt()));
        sag_x = if radius_x > 0.0 { sag_x_abs } else { -sag_x_abs };
    }

    let mut sag_y = 0.0_f64;
    if radius_y.is_finite() && radius_y != 0.0 {
        let abs_ry = radius_y.abs();
        let sqrt_term_y = 1.0 - (1.0 + k) * y2 / (abs_ry * abs_ry);
        if !sqrt_term_y.is_finite() || sqrt_term_y < 0.0 {
            return f64::NAN;
        }
        let sag_y_abs = y2 / (abs_ry * (1.0 + sqrt_term_y.sqrt()));
        sag_y = if radius_y > 0.0 { sag_y_abs } else { -sag_y_abs };
    }

    let out = sag_x + sag_y;
    if out.is_finite() { out } else { f64::NAN }
}

fn toric_sag_derivatives(x: f64, y: f64, radius_x: f64, radius_y: f64, conic: f64, axis_deg: f64) -> (f64, f64) {
    if !x.is_finite() || !y.is_finite() {
        return (f64::NAN, f64::NAN);
    }

    let (x_rot, y_rot, cos_a, sin_a) = toric_rotate_to_local_xy(x, y, axis_deg);
    let k = if conic.is_finite() { conic } else { 0.0 };

    let mut dz_dx_rot = 0.0_f64;
    if radius_x.is_finite() && radius_x != 0.0 {
        let abs_rx = radius_x.abs();
        let discr = 1.0 - (1.0 + k) * (x_rot * x_rot) / (abs_rx * abs_rx);
        if discr.is_finite() && discr > 0.0 {
            let sqrt_term = discr.sqrt();
            dz_dx_rot = x_rot / (abs_rx * sqrt_term);
            if radius_x < 0.0 {
                dz_dx_rot = -dz_dx_rot;
            }
        }
    }

    let mut dz_dy_rot = 0.0_f64;
    if radius_y.is_finite() && radius_y != 0.0 {
        let abs_ry = radius_y.abs();
        let discr = 1.0 - (1.0 + k) * (y_rot * y_rot) / (abs_ry * abs_ry);
        if discr.is_finite() && discr > 0.0 {
            let sqrt_term = discr.sqrt();
            dz_dy_rot = y_rot / (abs_ry * sqrt_term);
            if radius_y < 0.0 {
                dz_dy_rot = -dz_dy_rot;
            }
        }
    }

    let dz_dx = dz_dx_rot * cos_a - dz_dy_rot * sin_a;
    let dz_dy = dz_dx_rot * sin_a + dz_dy_rot * cos_a;
    (
        if dz_dx.is_finite() { dz_dx } else { 0.0 },
        if dz_dy.is_finite() { dz_dy } else { 0.0 },
    )
}

fn intersect_toric_internal(
    ray: &[f64],
    radius_x: f64,
    radius_y: f64,
    conic: f64,
    axis_deg: f64,
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

    // If both meridians are flat-like, reduce to plane z=0 intersection.
    let x_flat = !radius_x.is_finite() || radius_x == 0.0;
    let y_flat = !radius_y.is_finite() || radius_y == 0.0;
    if x_flat && y_flat {
        return if dz.abs() < EPS_R { f64::NAN } else { -oz / dz };
    }

    let mut guesses: Vec<f64> = Vec::new();
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

            let sag = toric_surface_sag(px, py, radius_x, radius_y, conic, axis_deg);
            if !sag.is_finite() {
                break;
            }
            let f = pz - sag;
            if f.abs() < last_valid_f.abs() {
                last_valid_t = t;
                last_valid_f = f;
            }

            if f.abs() < tol {
                return t;
            }

            let (dz_dx, dz_dy) = toric_sag_derivatives(px, py, radius_x, radius_y, conic, axis_deg);
            let d_fdt = dz - (dz_dx * dx + dz_dy * dy);
            if d_fdt.abs() < 1e-12 || !d_fdt.is_finite() {
                break;
            }

            let delta_t = f / d_fdt;
            let max_delta = t.abs() * 0.5 + 1.0;
            if delta_t.abs() > max_delta {
                t -= delta_t.signum() * max_delta;
            } else {
                t -= delta_t;
            }

            if t < -10000.0 || t > 10000.0 || !t.is_finite() {
                break;
            }
        }

        let px = ox + dx * t;
        let py = oy + dy * t;
        let pz = oz + dz * t;
        let sag = toric_surface_sag(px, py, radius_x, radius_y, conic, axis_deg);
        if sag.is_finite() {
            let f = pz - sag;
            if f.abs() < tol * 10.0 {
                return t;
            }
        }

        if last_valid_t.is_finite() && last_valid_f.abs() < tol * 50.0 {
            return last_valid_t;
        }
    }

    f64::NAN
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

    // Force JSON-compatible output so JS consumers receive plain objects/arrays
    // instead of Map/Set wrappers, which can fail re-decoding paths.
    surface_data
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
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
        let radius_x = row_params[p + 13];
        let radius_y = row_params[p + 14];
        let toric_axis = row_params[p + 15];
        let thickness = row_params[p + 16];
        let aperture_limit = row_params[p + 17];
        let rect_half_w = row_params[p + 18];
        let rect_half_h = row_params[p + 19];
        let n2 = row_params[p + 20];

        // Object row: skip entirely (kind == 1)
        if kind == 1 {
            if i == target_surface_index {
                out[0] = 1.0;
                out[1] = opl;
                out[2] = px;
                out[3] = py;
                out[4] = pz;
                return out;
            }
            continue;
        }

        // Gap row: medium update only, no OPL addition from thickness (kind == 2)
        if kind == 2 {
            if i == target_surface_index {
                out[0] = 1.0;
                out[1] = opl;
                out[2] = px;
                out[3] = py;
                out[4] = pz;
                return out;
            }
            if n2.is_finite() && n2 > 0.0 {
                n_cur = n2;
            }
            continue;
        }

        // CoordTrans row: medium update only (kind == 3)
        if kind == 3 {
            if i == target_surface_index {
                out[0] = 1.0;
                out[1] = opl;
                out[2] = px;
                out[3] = py;
                out[4] = pz;
                return out;
            }
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
            intersect_toric_internal(&[lpx, lpy, lpz, ldx, ldy, ldz], radius_x, radius_y, conic, toric_axis, 20, 1e-7)
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
        } else if is_toric {
            let (dz_dx, dz_dy) = toric_sag_derivatives(hx, hy, radius_x, radius_y, conic, toric_axis);
            let nvec = normalize3(-dz_dx, -dz_dy, 1.0);
            (nvec[0], nvec[1], nvec[2])
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

        // Native parity: do not advance by thickness here.
        // Surface origins already include previous thickness/coord transforms.
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

fn parse_matrix3(value: &Value) -> [[f64; 3]; 3] {
    let mut out = [[0.0_f64; 3]; 3];
    if let Value::Array(rows) = value {
        for r in 0..3 {
            if let Some(Value::Array(cols)) = rows.get(r) {
                for c in 0..3 {
                    out[r][c] = cols.get(c).and_then(value_to_f64).unwrap_or(if r == c { 1.0 } else { 0.0 });
                }
            } else {
                out[r][r] = 1.0;
            }
        }
    } else {
        out[0][0] = 1.0;
        out[1][1] = 1.0;
        out[2][2] = 1.0;
    }
    out
}

fn get_surface_kind(row: &Value) -> i32 {
    if is_object_row(row) {
        1
    } else if is_gap_row(row) {
        2
    } else if is_coord_trans_row(row) {
        3
    } else {
        0
    }
}

fn estimate_stop_radius_from_row(row: &Value) -> f64 {
    let ap = get_field(row, "aperture")
        .or_else(|| get_field(row, "Aperture"))
        .and_then(value_to_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v * 0.5);
    let sd = get_field(row, "__cooptActualSemidia")
        .or_else(|| get_field(row, "semidia"))
        .and_then(value_to_f64)
        .filter(|v| v.is_finite() && *v > 0.0);
    match (ap, sd) {
        (Some(a), Some(s)) => a.min(s),
        (Some(a), None) => a,
        (None, Some(s)) => s,
        _ => 1.0,
    }
}

fn estimate_entrance_radius_from_rows(rows: &[Value]) -> f64 {
    for row in rows {
        if is_object_row(row) || is_gap_row(row) || is_coord_trans_row(row) {
            continue;
        }
        let semidia = get_field(row, "__cooptActualSemidia")
            .or_else(|| get_field(row, "semidia"))
            .and_then(value_to_f64)
            .filter(|v| v.is_finite() && *v > 0.0);
        if let Some(v) = semidia {
            return v;
        }
        let ap = get_field(row, "aperture")
            .and_then(value_to_f64)
            .filter(|v| v.is_finite() && *v > 0.0);
        if let Some(v) = ap {
            return v * 0.5;
        }
    }
    1.0
}

fn find_stop_surface_index(rows: &[Value]) -> usize {
    for (i, row) in rows.iter().enumerate() {
        let s = get_field(row, "object type")
            .or_else(|| get_field(row, "object"))
            .or_else(|| get_field(row, "Object"))
            .and_then(value_to_string)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if s == "sto" || s == "stop" {
            return i;
        }
    }
    rows.len().saturating_sub(1)
}

fn find_eval_surface_index(rows: &[Value]) -> usize {
    for (i, row) in rows.iter().enumerate().rev() {
        let s = get_field(row, "object type")
            .or_else(|| get_field(row, "object"))
            .or_else(|| get_field(row, "Object"))
            .and_then(value_to_string)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if s == "image" {
            return i;
        }
    }
    rows.len().saturating_sub(1)
}

fn solve_linear(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    if n == 0 || a.len() != n {
        return None;
    }
    for i in 0..n {
        let mut pivot = i;
        let mut best = a[i][i].abs();
        for r in (i + 1)..n {
            let v = a[r][i].abs();
            if v > best {
                best = v;
                pivot = r;
            }
        }
        if !best.is_finite() || best < 1e-15 {
            return None;
        }
        if pivot != i {
            a.swap(i, pivot);
            b.swap(i, pivot);
        }
        let piv = a[i][i];
        for c in i..n {
            a[i][c] /= piv;
        }
        b[i] /= piv;
        for r in 0..n {
            if r == i {
                continue;
            }
            let f = a[r][i];
            if !f.is_finite() || f.abs() < 1e-15 {
                continue;
            }
            for c in i..n {
                a[r][c] -= f * a[i][c];
            }
            b[r] -= f * b[i];
        }
    }
    Some(b)
}

fn apply_display_mode_grid(raw: &[Vec<Option<f64>>], mode: &str) -> Vec<Vec<Option<f64>>> {
    let n = raw.len();
    if n == 0 {
        return Vec::new();
    }
    let remove_defocus = mode.eq_ignore_ascii_case("pistonTiltDefocusRemoved");
    let remove_plane = mode.eq_ignore_ascii_case("pistonTiltRemoved") || remove_defocus;
    if !remove_plane {
        return raw.to_vec();
    }

    let k = if remove_defocus { 4 } else { 3 };
    let mut normal = vec![vec![0.0_f64; k]; k];
    let mut rhs = vec![0.0_f64; k];
    let mut count = 0usize;

    for iy in 0..n {
        for ix in 0..n {
            let Some(z) = raw[iy][ix] else { continue; };
            let x = if n > 1 { (2.0 * ix as f64) / ((n - 1) as f64) - 1.0 } else { 0.0 };
            let y = if n > 1 { (2.0 * iy as f64) / ((n - 1) as f64) - 1.0 } else { 0.0 };
            let basis = if remove_defocus {
                [1.0, x, y, x * x + y * y]
            } else {
                [1.0, x, y, 0.0]
            };
            count += 1;
            for r in 0..k {
                rhs[r] += basis[r] * z;
                for c in 0..k {
                    normal[r][c] += basis[r] * basis[c];
                }
            }
        }
    }

    if count <= k {
        return raw.to_vec();
    }
    let Some(coeff) = solve_linear(normal, rhs) else {
        return raw.to_vec();
    };

    let mut out = vec![vec![None; n]; n];
    for iy in 0..n {
        for ix in 0..n {
            let Some(z) = raw[iy][ix] else { continue; };
            let x = if n > 1 { (2.0 * ix as f64) / ((n - 1) as f64) - 1.0 } else { 0.0 };
            let y = if n > 1 { (2.0 * iy as f64) / ((n - 1) as f64) - 1.0 } else { 0.0 };
            let fit = if remove_defocus {
                coeff[0] + coeff[1] * x + coeff[2] * y + coeff[3] * (x * x + y * y)
            } else {
                coeff[0] + coeff[1] * x + coeff[2] * y
            };
            out[iy][ix] = Some(z - fit);
        }
    }
    out
}

#[derive(Clone)]
struct PackedMeta {
    row_meta: Vec<i32>,
    row_params: Vec<f64>,
    row_origins: Vec<f64>,
    row_inv_rots: Vec<f64>,
    row_rots: Vec<f64>,
    row_count: usize,
}

fn parse_angle_like_input(s: &str) -> Option<f64> {
    let t = s.trim().replace(',', ".");
    if t.is_empty() {
        return None;
    }
    let mut started = false;
    let mut token = String::new();
    for ch in t.chars() {
        let valid = ch.is_ascii_digit() || ch == '+' || ch == '-' || ch == '.' || ch == 'e' || ch == 'E';
        if valid {
            started = true;
            token.push(ch);
        } else if started {
            break;
        }
    }
    if token.is_empty() {
        return None;
    }
    token.parse::<f64>().ok()
}

fn get_object_numeric(obj: &Map<String, Value>, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(v) = obj.get(*key) {
            if let Some(n) = value_to_f64(v) {
                if n.is_finite() {
                    return Some(n);
                }
            }
            if let Some(s) = value_to_string(v) {
                if let Some(n) = parse_angle_like_input(&s) {
                    if n.is_finite() {
                        return Some(n);
                    }
                }
            }
        }
    }
    None
}

fn is_infinite_conjugate_native(rows: &[Value]) -> bool {
    let Some(first) = rows.first() else {
        return false;
    };
    let t = get_safe_thickness(first);
    if t.is_infinite() {
        return true;
    }
    t.is_finite() && t.abs() > 1.0e6
}

fn build_direction_from_field_angles_native(angle_x_deg: f64, angle_y_deg: f64) -> [f64; 3] {
    let rad_x = angle_x_deg.to_radians();
    let rad_y = angle_y_deg.to_radians();
    let cos_x = rad_x.cos();
    let cos_y = rad_y.cos();
    let sin_x = rad_x.sin();
    let sin_y = rad_y.sin();
    normalize3(sin_x * cos_y, sin_y * cos_x, cos_x * cos_y)
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn mul_mat3_vec3(m: &[f64; 9], v: [f64; 3]) -> [f64; 3] {
    [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ]
}

fn build_perpendicular_basis_native(dir: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let direction = normalize3(dir[0], dir[1], dir[2]);
    let mut reference = if direction[2].abs() < 0.99 {
        [0.0, 0.0, 1.0]
    } else {
        [0.0, 1.0, 0.0]
    };

    let mut u_axis = cross3(reference, direction);
    let u_len = (u_axis[0] * u_axis[0] + u_axis[1] * u_axis[1] + u_axis[2] * u_axis[2]).sqrt();
    if u_len < 1e-12 {
        reference = [1.0, 0.0, 0.0];
        u_axis = cross3(reference, direction);
    }

    let u = normalize3(u_axis[0], u_axis[1], u_axis[2]);
    let v_axis = cross3(direction, u);
    let v = normalize3(v_axis[0], v_axis[1], v_axis[2]);
    (u, v)
}

fn resolve_infinite_object_z_native(rows: &[Value], obj: &Map<String, Value>, object_plane_z: f64) -> f64 {
    let render_dist_from_rows = rows
        .first()
        .and_then(|row| get_field(row, "objectRenderDistance"))
        .and_then(value_to_f64)
        .unwrap_or(0.0);

    let render_dist = if render_dist_from_rows.is_finite() && render_dist_from_rows.abs() > 1e-12 {
        render_dist_from_rows
    } else {
        get_object_numeric(obj, &["objectRenderDistance", "renderDistance", "distance", "z"])
            .unwrap_or(0.0)
    };

    if render_dist.is_finite() && render_dist.abs() > 1e-12 {
        -render_dist.abs()
    } else {
        object_plane_z - 25.0
    }
}

fn parse_radius_from_row_native(row: &Value) -> Option<f64> {
    if let Some(v) = get_field(row, "radius") {
        if let Some(s) = value_to_string(v) {
            let t = s.trim().to_uppercase();
            if t == "INF" || t == "INFINITY" || t == "∞" {
                return None;
            }
        }
        if let Some(r) = value_to_f64(v) {
            if r.is_finite() && r.abs() > 1e-12 {
                return Some(r);
            }
        }
    }
    None
}

fn compute_object_surface_sag_native(rows: &[Value], x: f64, y: f64) -> f64 {
    let Some(first) = rows.first() else {
        return 0.0;
    };

    let Some(radius) = parse_radius_from_row_native(first) else {
        return 0.0;
    };

    let conic = get_field(first, "conic").and_then(value_to_f64).unwrap_or(0.0);
    let mut coefs = [0.0_f64; 10];
    for i in 0..10 {
        let key = format!("coef{}", i + 1);
        coefs[i] = get_field(first, &key).and_then(value_to_f64).unwrap_or(0.0);
    }

    let surf_type = get_field(first, "surfType")
        .or_else(|| get_field(first, "type"))
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();
    let mode_odd = surf_type.contains("odd");

    let r = (x * x + y * y).sqrt();
    let sag = aspheric_sag(r, radius, conic, &coefs, mode_odd);
    if sag.is_finite() { sag } else { 0.0 }
}

fn optimize_angle_object_position_native(
    angle_x_deg: f64,
    angle_y_deg: f64,
    stop_origin: [f64; 3],
    object_z: f64,
) -> [f64; 2] {
    let dir = build_direction_from_field_angles_native(angle_x_deg, angle_y_deg);
    let safe_k = if dir[2].abs() > 1e-12 {
        dir[2]
    } else if dir[2] >= 0.0 {
        1e-12
    } else {
        -1e-12
    };

    let dz = stop_origin[2] - object_z;
    let x0 = stop_origin[0] - (dir[0] / safe_k) * dz;
    let y0 = stop_origin[1] - (dir[1] / safe_k) * dz;

    if !x0.is_finite() || !y0.is_finite() || x0.abs() > 1e8 || y0.abs() > 1e8 {
        [0.0, 0.0]
    } else {
        [x0, y0]
    }
}

fn estimate_entrance_center_origin_native(
    rows: &[Value],
    row_origins: &[f64],
    stop_center: [f64; 3],
    dir_vector: [f64; 3],
) -> [f64; 3] {
    let mut first_surface_z = stop_center[2] - 20.0;
    for (i, row) in rows.iter().enumerate() {
        if is_coord_trans_row(row) || is_object_row(row) || is_gap_row(row) {
            continue;
        }
        let z_idx = i * 3 + 2;
        if z_idx < row_origins.len() {
            let z = row_origins[z_idx];
            if z.is_finite() {
                first_surface_z = z;
                break;
            }
        }
    }

    let plane_z = (first_surface_z - 50.0).min(stop_center[2] - 10.0);
    let dir = normalize3(dir_vector[0], dir_vector[1], dir_vector[2]);
    let safe_k = if dir[2].abs() > 1e-12 {
        dir[2]
    } else if dir[2] >= 0.0 {
        1e-12
    } else {
        -1e-12
    };

    let dz = stop_center[2] - plane_z;
    let x = stop_center[0] - (dir[0] / safe_k) * dz;
    let y = stop_center[1] - (dir[1] / safe_k) * dz;

    if x.is_finite() && y.is_finite() && plane_z.is_finite() {
        [x, y, plane_z]
    } else {
        [0.0, 0.0, plane_z]
    }
}

fn trace_hit_xy_with_packed(
    ray: [f64; 6],
    stop_surface_index: usize,
    n_start: f64,
    packed: &PackedMeta,
) -> Option<[f64; 2]> {
    let hit = trace_single_ray_hit_point_with_meta_core(
        &ray,
        stop_surface_index,
        n_start,
        &packed.row_meta,
        &packed.row_params,
        &packed.row_origins,
        &packed.row_inv_rots,
        &packed.row_rots,
        packed.row_count,
    );
    if (hit[0] - 1.0).abs() > f64::EPSILON {
        return None;
    }
    if !hit[2].is_finite() || !hit[3].is_finite() {
        return None;
    }
    Some([hit[2], hit[3]])
}

fn brent_minimize_1d_native<F>(f: F, ax: f64, bx: f64, tol: f64, max_iter: usize) -> f64
where
    F: Fn(f64) -> f64,
{
    let golden_ratio = (3.0 - 5.0_f64.sqrt()) / 2.0;
    let mut a = ax.min(bx);
    let mut b = ax.max(bx);
    let mut x = a + golden_ratio * (b - a);
    let mut w = x;
    let mut v = x;
    let mut fx = f(x);
    let mut fw = fx;
    let mut fv = fx;
    let mut d = 0.0_f64;
    let mut e = 0.0_f64;

    for _ in 0..max_iter {
        let m = 0.5 * (a + b);
        let tol1 = tol * x.abs() + 1e-10;
        let tol2 = 2.0 * tol1;
        if (x - m).abs() <= tol2 - 0.5 * (b - a) {
            return x;
        }

        if e.abs() > tol1 {
            let mut p;
            let mut q;
            let r = (x - w) * (fx - fv);
            q = (x - v) * (fx - fw);
            p = (x - v) * q - (x - w) * r;
            q = 2.0 * (q - r);
            if q > 0.0 {
                p = -p;
            }
            q = q.abs();
            let temp = e;
            e = d;
            if p.abs() < (0.5 * q * temp).abs() && p > q * (a - x) && p < q * (b - x) {
                d = p / q;
                let u = x + d;
                if (u - a) < tol2 || (b - u) < tol2 {
                    d = if x < m { tol1 } else { -tol1 };
                }
            } else {
                e = if x >= m { a - x } else { b - x };
                d = golden_ratio * e;
            }
        } else {
            e = if x >= m { a - x } else { b - x };
            d = golden_ratio * e;
        }

        let u = if d.abs() >= tol1 { x + d } else { x + if d > 0.0 { tol1 } else { -tol1 } };
        let fu = f(u);

        if fu <= fx {
            if u >= x {
                a = x;
            } else {
                b = x;
            }
            v = w;
            w = x;
            x = u;
            fv = fw;
            fw = fx;
            fx = fu;
        } else {
            if u < x {
                a = u;
            } else {
                b = u;
            }
            if fu <= fw || (w - x).abs() <= f64::EPSILON {
                v = w;
                w = u;
                fv = fw;
                fw = fu;
            } else if fu <= fv || (v - x).abs() <= f64::EPSILON || (v - w).abs() <= f64::EPSILON {
                v = u;
                fv = fu;
            }
        }
    }

    x
}

fn search_entrance_origin_grid_brent_native(
    rows: &[Value],
    row_origins: &[f64],
    stop_center: [f64; 3],
    dir_vector: [f64; 3],
    stop_surface_index: usize,
    stop_packed: &PackedMeta,
    n_start: f64,
    entrance_radius: f64,
) -> Option<[f64; 3]> {
    let dir = normalize3(dir_vector[0], dir_vector[1], dir_vector[2]);
    if !dir[0].is_finite() || !dir[1].is_finite() || !dir[2].is_finite() {
        return None;
    }

    let mut first_surface_z = stop_center[2] - 20.0;
    for (i, row) in rows.iter().enumerate() {
        if is_coord_trans_row(row) || is_object_row(row) || is_gap_row(row) {
            continue;
        }
        let z_idx = i * 3 + 2;
        if z_idx < row_origins.len() {
            let z = row_origins[z_idx];
            if z.is_finite() {
                first_surface_z = z;
                break;
            }
        }
    }

    let mut plane_candidates = vec![
        first_surface_z - 10.0,
        first_surface_z - 50.0,
        -25.0,
        -50.0,
        -100.0,
        -200.0,
        first_surface_z - 500.0,
        first_surface_z - 1000.0,
        first_surface_z - 2000.0,
    ];
    plane_candidates.retain(|z| z.is_finite());
    plane_candidates.sort_by(|a, b| a.abs().partial_cmp(&b.abs()).unwrap_or(std::cmp::Ordering::Equal));
    plane_candidates.dedup_by(|a, b| (*a - *b).abs() < 1e-9);

    let safe_dir_z = if dir[2].abs() > 1e-12 {
        dir[2]
    } else if dir[2] >= 0.0 {
        1e-12
    } else {
        -1e-12
    };

    let evaluate = |x: f64, y: f64, plane_z: f64| -> Option<f64> {
        let ray = [x, y, plane_z, dir[0], dir[1], dir[2]];
        let hit = trace_hit_xy_with_packed(ray, stop_surface_index, n_start, stop_packed)?;
        let ex = hit[0] - stop_center[0];
        let ey = hit[1] - stop_center[1];
        let err = (ex * ex + ey * ey).sqrt();
        if err.is_finite() { Some(err) } else { None }
    };

    for plane_z in plane_candidates {
        let dz = stop_center[2] - plane_z;
        let guess_x = stop_center[0] - (dir[0] / safe_dir_z) * dz;
        let guess_y = stop_center[1] - (dir[1] / safe_dir_z) * dz;
        if !guess_x.is_finite() || !guess_y.is_finite() {
            continue;
        }

        let dynamic_half_range = (guess_x.abs())
            .max(guess_y.abs())
            .max(50.0)
            .max((guess_x.abs()).max(guess_y.abs()) + 2.0 * entrance_radius.max(1.0) + 10.0);

        let grid_size = 31usize;
        let grid_step = (2.0 * dynamic_half_range) / ((grid_size - 1) as f64);
        let mut best_x = guess_x;
        let mut best_y = guess_y;
        let mut best_err = f64::INFINITY;
        let mut found_any = false;

        for i in 0..grid_size {
            let x = (guess_x - dynamic_half_range) + (i as f64) * grid_step;
            for j in 0..grid_size {
                let y = (guess_y - dynamic_half_range) + (j as f64) * grid_step;
                if let Some(err) = evaluate(x, y, plane_z) {
                    if err < best_err {
                        best_err = err;
                        best_x = x;
                        best_y = y;
                        found_any = true;
                    }
                }
            }
        }

        if !found_any {
            continue;
        }

        let brent_range = (grid_step * 2.0).max(0.5);
        let refined_x = brent_minimize_1d_native(
            |x| evaluate(x, best_y, plane_z).unwrap_or(1.0e9),
            best_x - brent_range,
            best_x + brent_range,
            1e-6,
            50,
        );
        let refined_y = brent_minimize_1d_native(
            |y| evaluate(refined_x, y, plane_z).unwrap_or(1.0e9),
            best_y - brent_range,
            best_y + brent_range,
            1e-6,
            50,
        );

        if evaluate(refined_x, refined_y, plane_z).is_some() {
            return Some([refined_x, refined_y, plane_z]);
        }
        if best_err.is_finite() {
            return Some([best_x, best_y, plane_z]);
        }
    }

    None
}

fn solve_ray_origin_to_stop_point_fast_native(
    initial_origin: [f64; 3],
    dir_vector: [f64; 3],
    stop_target: [f64; 3],
    stop_surface_index: usize,
    packed: &PackedMeta,
    n_start: f64,
) -> Option<[f64; 3]> {
    let base_dir = normalize3(dir_vector[0], dir_vector[1], dir_vector[2]);
    if !base_dir[0].is_finite() || !base_dir[1].is_finite() || !base_dir[2].is_finite() {
        return None;
    }

    let mut origin = initial_origin;
    if !origin[0].is_finite() || !origin[1].is_finite() || !origin[2].is_finite() {
        return None;
    }

    let eps = 1e-3;
    let tol_mm = 1e-3;
    let max_iter = 20;
    let max_step = 10.0;
    let mut best_origin = origin;
    let mut best_err = f64::INFINITY;

    for _ in 0..max_iter {
        let hit = trace_hit_xy_with_packed(
            [origin[0], origin[1], origin[2], base_dir[0], base_dir[1], base_dir[2]],
            stop_surface_index,
            n_start,
            packed,
        );

        let Some(hit0) = hit else {
            origin = [
                0.5 * (origin[0] + best_origin[0]),
                0.5 * (origin[1] + best_origin[1]),
                origin[2],
            ];
            continue;
        };

        let ex = hit0[0] - stop_target[0];
        let ey = hit0[1] - stop_target[1];
        if !ex.is_finite() || !ey.is_finite() {
            return None;
        }
        let err = (ex * ex + ey * ey).sqrt();
        if err < best_err {
            best_err = err;
            best_origin = origin;
        }
        if err < tol_mm {
            return Some(origin);
        }

        let hit_x = trace_hit_xy_with_packed(
            [origin[0] + eps, origin[1], origin[2], base_dir[0], base_dir[1], base_dir[2]],
            stop_surface_index,
            n_start,
            packed,
        );
        let hit_y = trace_hit_xy_with_packed(
            [origin[0], origin[1] + eps, origin[2], base_dir[0], base_dir[1], base_dir[2]],
            stop_surface_index,
            n_start,
            packed,
        );

        if hit_x.is_none() || hit_y.is_none() {
            let gain = 0.3;
            let mut dx = -gain * ex;
            let mut dy = -gain * ey;
            let step_norm = (dx * dx + dy * dy).sqrt();
            if step_norm > max_step {
                let s = max_step / step_norm;
                dx *= s;
                dy *= s;
            }
            origin = [origin[0] + dx, origin[1] + dy, origin[2]];
            continue;
        }

        let hx = hit_x.unwrap_or(hit0);
        let hy = hit_y.unwrap_or(hit0);
        let j11 = (hx[0] - hit0[0]) / eps;
        let j21 = (hx[1] - hit0[1]) / eps;
        let j12 = (hy[0] - hit0[0]) / eps;
        let j22 = (hy[1] - hit0[1]) / eps;
        if !j11.is_finite() || !j12.is_finite() || !j21.is_finite() || !j22.is_finite() {
            origin = [origin[0] - 0.2 * ex, origin[1] - 0.2 * ey, origin[2]];
            continue;
        }

        let det = j11 * j22 - j12 * j21;
        if !det.is_finite() || det.abs() < 1e-14 {
            origin = [origin[0] - 0.2 * ex, origin[1] - 0.2 * ey, origin[2]];
            continue;
        }

        let mut dx = (-j22 * ex + j12 * ey) / det;
        let mut dy = (j21 * ex - j11 * ey) / det;
        let step_norm = (dx * dx + dy * dy).sqrt();
        if step_norm > max_step {
            let s = max_step / step_norm;
            dx *= s;
            dy *= s;
        }
        origin = [origin[0] + dx, origin[1] + dy, origin[2]];
    }

    if best_err.is_finite() {
        Some(best_origin)
    } else {
        Some(origin)
    }
}

#[wasm_bindgen]
pub fn run_native_opd_map_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    // Direct Rust computation of surface origins/rotations without JsValue round-trip
    fn compute_packed_surface_origins(
        rows: &[Value],
        row_origins: &mut Vec<f64>,
        row_rots: &mut Vec<f64>,
        row_inv_rots: &mut Vec<f64>,
    ) {
        let ex = [1.0_f64, 0.0, 0.0];
        let ey = [0.0_f64, 1.0, 0.0];
        let ez = [0.0_f64, 0.0, 1.0];
        let mut current_origin = [0.0_f64; 3];
        let mut current_rot = create_identity_matrix();

        for s in 0..rows.len() {
            let surface = &rows[s];
            let previous = if s > 0 { Some(&rows[s - 1]) } else { None };

            let (surface_origin, surface_rot) = if is_coord_trans_row(surface) {
                let (dx, dy, dz, tx, ty, tz, order) = parse_coord_trans_params(surface);
                let mut thickness = previous.map(get_safe_thickness).unwrap_or(0.0);
                if !thickness.is_finite() { thickness = 0.0; }
                let prev_rot = current_rot;
                let single_rot = create_rotation_matrix(tx, ty, tz, order);
                let new_rot = multiply_matrices(single_rot, current_rot);
                let o = if order == 0 {
                    let tz_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ez), thickness);
                    let dx_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ex), dx);
                    let dy_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ey), dy);
                    let dz_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ez), dz);
                    vec3_add(vec3_add(vec3_add(vec3_add(current_origin, tz_term), dx_term), dy_term), dz_term)
                } else {
                    let tz_term = vec3_scale(apply_matrix_to_vec3(prev_rot, ez), thickness);
                    let dx_term = vec3_scale(apply_matrix_to_vec3(new_rot, ex), dx);
                    let dy_term = vec3_scale(apply_matrix_to_vec3(new_rot, ey), dy);
                    let dz_term = vec3_scale(apply_matrix_to_vec3(new_rot, ez), dz);
                    vec3_add(vec3_add(vec3_add(vec3_add(current_origin, tz_term), dx_term), dy_term), dz_term)
                };
                (o, new_rot)
            } else {
                let mut thickness = previous.map(get_safe_thickness).unwrap_or(0.0);
                if !thickness.is_finite() { thickness = 0.0; }
                let tz_term = vec3_scale(apply_matrix_to_vec3(current_rot, ez), thickness);
                (vec3_add(current_origin, tz_term), current_rot)
            };

            let o = s * 3;
            row_origins[o]     = surface_origin[0];
            row_origins[o + 1] = surface_origin[1];
            row_origins[o + 2] = surface_origin[2];

            // Store 3×3 as row-major. Transpose = inverse for orthonormal rotation.
            let r = s * 9;
            for rr in 0..3 {
                for cc in 0..3 {
                    row_rots[r + rr * 3 + cc]     = surface_rot[rr][cc];
                    row_inv_rots[r + rr * 3 + cc] = surface_rot[cc][rr];
                }
            }

            current_origin = surface_origin;
            current_rot = surface_rot;
        }
    }

    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("invalid request json: {}", e)))?;
    let req_obj = req.as_object().ok_or_else(|| JsValue::from_str("request must be an object"))?;

    let rows_raw = req_obj
        .get("opticalSystemRows")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| JsValue::from_str("opticalSystemRows is required"))?;
    if rows_raw.is_empty() {
        return Err(JsValue::from_str("opticalSystemRows is empty"));
    }
    let rows: Vec<Value> = rows_raw.iter().map(normalize_coord_trans_row).collect();

    let grid_size = req_obj
        .get("gridSize")
        .and_then(value_to_f64)
        .map(|v| v.floor() as usize)
        .unwrap_or(129)
        .max(17);
    let wavelength_um = req_obj
        .get("wavelengthUm")
        .and_then(value_to_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(0.5876);
    let opd_display_mode = req_obj
        .get("opdDisplayMode")
        .and_then(value_to_string)
        .unwrap_or_else(|| "pistonTiltRemoved".to_string());

    let stop_surface_index = req_obj
        .get("stopSurfaceIndex")
        .and_then(value_to_f64)
        .map(|v| v.max(0.0) as usize)
        .unwrap_or_else(|| find_stop_surface_index(&rows))
        .min(rows.len().saturating_sub(1));
    let target_surface_index = req_obj
        .get("surfaceIndex")
        .and_then(value_to_f64)
        .map(|v| v.max(0.0) as usize)
        .unwrap_or_else(|| find_eval_surface_index(&rows))
        .min(rows.len().saturating_sub(1));

    let object_space_n = rows
        .first()
        .map(|r| get_correct_refractive_index(r, wavelength_um))
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(1.0);

    let mut row_meta = vec![0_i32; rows.len() * 4];
    let mut row_params = vec![0.0_f64; rows.len() * 24];
    let mut row_origins = vec![0.0_f64; rows.len() * 3];
    let mut row_inv_rots = vec![0.0_f64; rows.len() * 9];
    let mut row_rots = vec![0.0_f64; rows.len() * 9];
    // Compute origins/rotations directly (no JsValue round-trip)
    compute_packed_surface_origins(&rows, &mut row_origins, &mut row_rots, &mut row_inv_rots);
    for i in 0..rows.len() {
        let row = &rows[i];

        let m = i * 4;
        let p = i * 24;

        let kind = get_surface_kind(row);
        row_meta[m] = kind;
        row_meta[m + 2] = i as i32;
        row_meta[m + 3] = 0;

        let material = get_field(row, "material")
            .and_then(value_to_string)
            .unwrap_or_default()
            .trim()
            .to_ascii_uppercase();
        let is_mirror = material == "MIRROR";
        let surf_type = get_field(row, "surfType")
            .or_else(|| get_field(row, "type"))
            .and_then(value_to_string)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let image_type_raw = get_field(row, "object type")
            .or_else(|| get_field(row, "object"))
            .or_else(|| get_field(row, "Object"))
            .or_else(|| get_field(row, "type"))
            .and_then(value_to_string)
            .unwrap_or_default();
        let image_norm = compact(&image_type_raw);
        let is_image_surface = image_norm == "image" || image_norm.starts_with("image");
        let aperture_shape = get_field(row, "_apertureShape")
            .or_else(|| get_field(row, "apertureShape"))
            .or_else(|| get_field(row, "ApertureShape"))
            .and_then(value_to_string)
            .unwrap_or_default();
        let shape_key = compact(&aperture_shape);
        let is_square_shape = shape_key == "square" || shape_key == "sq";
        let is_rect_shape = is_square_shape || shape_key == "rect" || shape_key == "rectangle" || shape_key == "rectangular";

        let mut rect_half_w = f64::NAN;
        let mut rect_half_h = f64::NAN;
        if is_rect_shape {
            let w_num = get_field(row, "_apertureWidth")
                .or_else(|| get_field(row, "apertureWidth"))
                .or_else(|| get_field(row, "apertureX"))
                .or_else(|| get_field(row, "apertureWidthMm"))
                .and_then(value_to_f64)
                .unwrap_or(f64::NAN);
            let h_num = get_field(row, "_apertureHeight")
                .or_else(|| get_field(row, "apertureHeight"))
                .or_else(|| get_field(row, "apertureY"))
                .or_else(|| get_field(row, "apertureHeightMm"))
                .and_then(value_to_f64)
                .unwrap_or(f64::NAN);

            if is_square_shape {
                let side = if w_num.is_finite() { w_num } else { h_num };
                if side.is_finite() && side > 0.0 {
                    rect_half_w = side * 0.5;
                    rect_half_h = side * 0.5;
                }
            } else {
                if w_num.is_finite() && w_num > 0.0 {
                    rect_half_w = w_num * 0.5;
                }
                if h_num.is_finite() && h_num > 0.0 {
                    rect_half_h = h_num * 0.5;
                }
            }
        }

        let is_toric = surf_type.contains("toric");
        let is_odd = surf_type.contains("odd");
        let radius = get_field(row, "radius").and_then(value_to_f64).unwrap_or(f64::NAN);
        let is_plane = !radius.is_finite() || radius.abs() < 1e-12 || surf_type.contains("plane");

        let mut flags = 0_i32;
        if is_mirror { flags |= 1; }
        if is_plane { flags |= 2; }
        if is_toric { flags |= 4; }
        if is_image_surface { flags |= 8; }
        if rect_half_w.is_finite() && rect_half_h.is_finite() { flags |= 16; }
        if is_odd { flags |= 32; }
        row_meta[m + 1] = flags;

        row_params[p] = radius;
        row_params[p + 1] = get_field(row, "conic").and_then(value_to_f64).unwrap_or(0.0);
        for k in 0..10 {
            let key = format!("coef{}", k + 1);
            row_params[p + 2 + k] = get_field(row, &key).and_then(value_to_f64).unwrap_or(0.0);
        }
        let semidia = match get_field(row, "__cooptActualSemidia").or_else(|| get_field(row, "semidia")) {
            Some(Value::String(s)) if s.trim().eq_ignore_ascii_case("auto") || s.trim().is_empty() => f64::INFINITY,
            Some(v) => {
                let n = value_to_f64(v).unwrap_or(f64::NAN);
                if n.is_finite() && n > 0.0 { n } else { f64::INFINITY }
            }
            None => f64::INFINITY,
        };
        row_params[p + 12] = semidia;
        row_params[p + 13] = get_field(row, "radiusX").and_then(value_to_f64).unwrap_or(f64::NAN);
        row_params[p + 14] = get_field(row, "radiusY").and_then(value_to_f64).unwrap_or(f64::NAN);
        row_params[p + 15] = get_field(row, "axis").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 16] = get_safe_thickness(row);
        let mut ap_lim = get_field(row, "aperture")
            .and_then(value_to_f64)
            .filter(|v| v.is_finite() && *v > 0.0)
            .map(|v| v * 0.5)
            .unwrap_or(f64::INFINITY);
        if semidia.is_finite() {
            ap_lim = ap_lim.min(semidia);
        }
        row_params[p + 17] = if i == target_surface_index || is_image_surface {
            f64::INFINITY
        } else {
            ap_lim
        };
        row_params[p + 18] = rect_half_w;
        row_params[p + 19] = rect_half_h;

        let n2 = if kind == 0 {
            if is_mirror {
                0.0
            } else {
                let n = get_correct_refractive_index(row, wavelength_um);
                if n.is_finite() && n > 0.0 { n } else { 0.0 }
            }
        } else if kind == 2 {
            let material = get_field(row, "material").and_then(value_to_string).unwrap_or_default();
            let n = parse_refractive_index_from_material(&material);
            if n > 0.0 { n } else { 0.0 }
        } else if kind == 3 {
            let material = get_field(row, "__cooptGapMaterial").and_then(value_to_string).unwrap_or_default();
            let n = parse_refractive_index_from_material(&material);
            if n > 0.0 { n } else { 0.0 }
        } else {
            0.0
        };
        row_params[p + 20] = n2;

    }
    let stop_center = [
        row_origins[stop_surface_index * 3],
        row_origins[stop_surface_index * 3 + 1],
        row_origins[stop_surface_index * 3 + 2],
    ];
    let stop_rot_base = stop_surface_index * 9;
    let stop_plane_u = normalize3(
        row_rots[stop_rot_base],
        row_rots[stop_rot_base + 3],
        row_rots[stop_rot_base + 6],
    );
    let stop_plane_v = normalize3(
        row_rots[stop_rot_base + 1],
        row_rots[stop_rot_base + 4],
        row_rots[stop_rot_base + 7],
    );

    let packed_target = PackedMeta {
        row_meta: row_meta.clone(),
        row_params: row_params.clone(),
        row_origins: row_origins.clone(),
        row_inv_rots: row_inv_rots.clone(),
        row_rots: row_rots.clone(),
        row_count: rows.len(),
    };
    let packed_stop = PackedMeta {
        row_meta: row_meta.clone(),
        row_params: row_params.clone(),
        row_origins: row_origins.clone(),
        row_inv_rots: row_inv_rots.clone(),
        row_rots: row_rots.clone(),
        row_count: rows.len(),
    };

    let mut object_rows = req_obj
        .get("objectRows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if object_rows.is_empty() {
        object_rows.push(serde_json::json!({
            "position": "Point",
            "xHeightAngle": 0.0,
            "yHeightAngle": 0.0
        }));
    }
    let requested_object_index = req_obj
        .get("objectIndex")
        .and_then(value_to_f64)
        .map(|v| v.max(0.0) as usize)
        .unwrap_or(0);
    let used_object_index = requested_object_index.min(object_rows.len().saturating_sub(1));
    let selected_object_map = object_rows
        .get(used_object_index)
        .and_then(|v| v.as_object())
        .ok_or_else(|| JsValue::from_str("invalid objectRows entry"))?;

    let used_object_position = selected_object_map
        .get("position")
        .or_else(|| selected_object_map.get("object"))
        .or_else(|| selected_object_map.get("objectType"))
        .or_else(|| selected_object_map.get("type"))
        .and_then(value_to_string)
        .unwrap_or_else(|| "Point".to_string());
    let pos_lower = used_object_position.trim().to_lowercase();
    let is_angle_object = pos_lower.contains("angle") || pos_lower == "point";

    let angle_object_x = get_object_numeric(selected_object_map, &["xHeightAngle", "xFieldAngle", "xAngle", "x", "X", "xHeight"]).unwrap_or(0.0);
    let angle_object_y = get_object_numeric(selected_object_map, &["yHeightAngle", "yFieldAngle", "fieldAngle", "yAngle", "angle", "y", "Y", "yHeight"]).unwrap_or(0.0);
    let height_object_x = get_object_numeric(selected_object_map, &["xHeight", "x", "X"]).unwrap_or(0.0);
    let height_object_y = get_object_numeric(selected_object_map, &["yHeight", "y", "Y", "height"]).unwrap_or(0.0);

    let use_infinite_mode = is_infinite_conjugate_native(&rows);
    let (used_object_x, used_object_y) = if use_infinite_mode {
        if is_angle_object { (angle_object_x, angle_object_y) } else { (0.0, 0.0) }
    } else {
        (height_object_x, height_object_y)
    };

    let stop_radius = estimate_stop_radius_from_row(&rows[stop_surface_index]).max(0.01);
    let entrance_radius = estimate_entrance_radius_from_rows(&rows).clamp(0.01, 500.0);
    let sampling_radius = stop_radius.min(entrance_radius).max(0.01);

    let finite_object_distance = {
        let t0 = rows.first().map(get_safe_thickness).unwrap_or(f64::NAN).abs();
        if t0.is_finite() && t0 > 1e-9 {
            t0
        } else {
            let z0 = row_origins.get(2).copied().unwrap_or(0.0).abs();
            if z0.is_finite() && z0 > 1e-9 {
                z0.max(1.0)
            } else {
                let stop_z = stop_center[2].abs();
                if stop_z.is_finite() { (stop_z + 25.0).max(25.0) } else { 100.0 }
            }
        }
    };

    let requested_pupil_sampling_mode = req_obj
        .get("pupilSamplingMode")
        .and_then(value_to_string)
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s == "stop" || s == "entrance");
    let prefer_entrance_sampling = use_infinite_mode
        && matches!(requested_pupil_sampling_mode.as_deref(), Some("entrance"));
    let mut effective_pupil_sampling_mode = if prefer_entrance_sampling { "entrance" } else { "stop" };

    let object_plane_z = row_origins.get(2).copied().unwrap_or(0.0);
    let infinite_direction = build_direction_from_field_angles_native(used_object_x, used_object_y);
    let (infinite_u_axis, infinite_v_axis) = build_perpendicular_basis_native(infinite_direction);
    let infinite_object_z = resolve_infinite_object_z_native(&rows, selected_object_map, object_plane_z);
    let infinite_origin_xy = if used_object_x.abs() < 1e-10 && used_object_y.abs() < 1e-10 {
        [0.0, 0.0]
    } else {
        optimize_angle_object_position_native(used_object_x, used_object_y, stop_center, infinite_object_z)
    };
    let infinite_origin_sag = compute_object_surface_sag_native(&rows, infinite_origin_xy[0], infinite_origin_xy[1]);
    let mut infinite_emission_origin = [
        infinite_origin_xy[0],
        infinite_origin_xy[1],
        infinite_object_z + infinite_origin_sag,
    ];
    let lock_emission_x_for_symmetry = use_infinite_mode
        && used_object_x.abs() <= 1.0e-12
        && used_object_y.abs() > 1.0e-12;
    let lock_emission_y_for_symmetry = use_infinite_mode
        && used_object_y.abs() <= 1.0e-12
        && used_object_x.abs() > 1.0e-12;
    let apply_symmetry_axis_lock = |origin: [f64; 3]| -> [f64; 3] {
        let mut out = origin;
        if lock_emission_x_for_symmetry {
            out[0] = infinite_origin_xy[0];
        }
        if lock_emission_y_for_symmetry {
            out[1] = infinite_origin_xy[1];
        }
        out
    };
    infinite_emission_origin = apply_symmetry_axis_lock(infinite_emission_origin);
    let mut effective_emission_origin = infinite_emission_origin;

    let mut effective_stop_center = stop_center;
    if use_infinite_mode {
        let chief_probe = [
            infinite_emission_origin[0],
            infinite_emission_origin[1],
            infinite_emission_origin[2],
            infinite_direction[0],
            infinite_direction[1],
            infinite_direction[2],
        ];
        let chief_stop_hit = trace_single_ray_hit_point_with_meta_core(
            &chief_probe,
            stop_surface_index,
            object_space_n,
            &packed_stop.row_meta,
            &packed_stop.row_params,
            &packed_stop.row_origins,
            &packed_stop.row_inv_rots,
            &packed_stop.row_rots,
            packed_stop.row_count,
        );
        if (chief_stop_hit[0] - 1.0).abs() <= f64::EPSILON
            && chief_stop_hit[2].is_finite()
            && chief_stop_hit[3].is_finite()
            && chief_stop_hit[4].is_finite()
        {
            effective_stop_center = [chief_stop_hit[2], chief_stop_hit[3], chief_stop_hit[4]];
        }
    }
    let stop_center_for_sampling = if use_infinite_mode { effective_stop_center } else { stop_center };

    let stop_inv = [
        row_inv_rots[stop_rot_base],
        row_inv_rots[stop_rot_base + 1],
        row_inv_rots[stop_rot_base + 2],
        row_inv_rots[stop_rot_base + 3],
        row_inv_rots[stop_rot_base + 4],
        row_inv_rots[stop_rot_base + 5],
        row_inv_rots[stop_rot_base + 6],
        row_inv_rots[stop_rot_base + 7],
        row_inv_rots[stop_rot_base + 8],
    ];

    let build_marginal_ray = |u: f64, v: f64, sample_radius: f64, launch_origin: [f64; 3]| -> Option<[f64; 6]> {
        if !u.is_finite() || !v.is_finite() {
            return None;
        }
        let desired_local_x = u * sample_radius;
        let desired_local_y = v * sample_radius;
        let stop_target = [
            stop_center_for_sampling[0] + stop_plane_u[0] * desired_local_x + stop_plane_v[0] * desired_local_y,
            stop_center_for_sampling[1] + stop_plane_u[1] * desired_local_x + stop_plane_v[1] * desired_local_y,
            stop_center_for_sampling[2] + stop_plane_u[2] * desired_local_x + stop_plane_v[2] * desired_local_y,
        ];

        if use_infinite_mode {
            let start = [
                launch_origin[0] + infinite_u_axis[0] * desired_local_x + infinite_v_axis[0] * desired_local_y,
                launch_origin[1] + infinite_u_axis[1] * desired_local_x + infinite_v_axis[1] * desired_local_y,
                launch_origin[2] + infinite_u_axis[2] * desired_local_x + infinite_v_axis[2] * desired_local_y,
            ];
            return Some([
                start[0],
                start[1],
                start[2],
                infinite_direction[0],
                infinite_direction[1],
                infinite_direction[2],
            ]);
        }

        let object_pos = [used_object_x, used_object_y, -finite_object_distance];
        let mut aimed_stop = stop_target;
        let mut ray_dir = normalize3(
            aimed_stop[0] - object_pos[0],
            aimed_stop[1] - object_pos[1],
            aimed_stop[2] - object_pos[2],
        );
        if !ray_dir[0].is_finite() || !ray_dir[1].is_finite() || !ray_dir[2].is_finite() {
            return None;
        }

        let stop_tol = 0.03;
        let max_stop_iters = 8;
        let gain = 0.7;
        let max_step = (sample_radius * 0.12).max(0.5);

        for _ in 0..max_stop_iters {
            let trial_ray = [
                object_pos[0],
                object_pos[1],
                object_pos[2],
                ray_dir[0],
                ray_dir[1],
                ray_dir[2],
            ];
            let stop_hit = trace_single_ray_hit_point_with_meta_core(
                &trial_ray,
                stop_surface_index,
                object_space_n,
                &packed_stop.row_meta,
                &packed_stop.row_params,
                &packed_stop.row_origins,
                &packed_stop.row_inv_rots,
                &packed_stop.row_rots,
                packed_stop.row_count,
            );
            if (stop_hit[0] - 1.0).abs() > f64::EPSILON {
                break;
            }

            let rel = [
                stop_hit[2] - stop_center[0],
                stop_hit[3] - stop_center[1],
                stop_hit[4] - stop_center[2],
            ];
            let local = mul_mat3_vec3(&stop_inv, rel);
            let err_lx = local[0] - desired_local_x;
            let err_ly = local[1] - desired_local_y;
            let err_mag = (err_lx * err_lx + err_ly * err_ly).sqrt();
            if !err_mag.is_finite() || err_mag <= stop_tol {
                break;
            }

            let err_vec = [
                stop_plane_u[0] * err_lx + stop_plane_v[0] * err_ly,
                stop_plane_u[1] * err_lx + stop_plane_v[1] * err_ly,
                stop_plane_u[2] * err_lx + stop_plane_v[2] * err_ly,
            ];
            let step_mag = (err_vec[0] * err_vec[0] + err_vec[1] * err_vec[1] + err_vec[2] * err_vec[2]).sqrt();
            let step_scale = if step_mag.is_finite() && step_mag > max_step { max_step / step_mag } else { 1.0 };
            let step = [
                err_vec[0] * gain * step_scale,
                err_vec[1] * gain * step_scale,
                err_vec[2] * gain * step_scale,
            ];

            aimed_stop = [
                aimed_stop[0] - step[0],
                aimed_stop[1] - step[1],
                aimed_stop[2] - step[2],
            ];
            ray_dir = normalize3(
                aimed_stop[0] - object_pos[0],
                aimed_stop[1] - object_pos[1],
                aimed_stop[2] - object_pos[2],
            );
        }

        Some([
            object_pos[0],
            object_pos[1],
            object_pos[2],
            ray_dir[0],
            ray_dir[1],
            ray_dir[2],
        ])
    };

    let mut chief_start_dir = build_marginal_ray(0.0, 0.0, sampling_radius, effective_emission_origin)
        .ok_or_else(|| JsValue::from_str("run_native_opd_map_wasm_json: chief ray not found"))?;
    let mut chief_reference_mode = "center-chief".to_string();
    let mut chief_target_hit = trace_single_ray_hit_point_with_meta_core(
        &chief_start_dir,
        target_surface_index,
        object_space_n,
        &packed_target.row_meta,
        &packed_target.row_params,
        &packed_target.row_origins,
        &packed_target.row_inv_rots,
        &packed_target.row_rots,
        packed_target.row_count,
    );

    if (chief_target_hit[0] - 1.0).abs() > f64::EPSILON && use_infinite_mode {
        let entrance_origin = search_entrance_origin_grid_brent_native(
            &rows,
            &row_origins,
            stop_center_for_sampling,
            infinite_direction,
            stop_surface_index,
            &packed_stop,
            object_space_n,
            entrance_radius,
        )
        .unwrap_or_else(|| {
            estimate_entrance_center_origin_native(
                &rows,
                &row_origins,
                stop_center_for_sampling,
                infinite_direction,
            )
        });
        if let Some(entrance_chief_ray) = build_marginal_ray(0.0, 0.0, entrance_radius.max(0.01), entrance_origin) {
            let entrance_target_hit = trace_single_ray_hit_point_with_meta_core(
                &entrance_chief_ray,
                target_surface_index,
                object_space_n,
                &packed_target.row_meta,
                &packed_target.row_params,
                &packed_target.row_origins,
                &packed_target.row_inv_rots,
                &packed_target.row_rots,
                packed_target.row_count,
            );
            if (entrance_target_hit[0] - 1.0).abs() <= f64::EPSILON {
                chief_start_dir = entrance_chief_ray;
                chief_target_hit = entrance_target_hit;
                effective_emission_origin = apply_symmetry_axis_lock(entrance_origin);
                chief_reference_mode = "entrance-chief-target(grid-brent)".to_string();
            }
        }
    }

    if (chief_target_hit[0] - 1.0).abs() > f64::EPSILON {
        return Err(JsValue::from_str("run_native_opd_map_wasm_json: chief ray did not reach target surface"));
    }

    let mut chief_stop_hit = trace_single_ray_hit_point_with_meta_core(
        &chief_start_dir,
        stop_surface_index,
        object_space_n,
        &packed_stop.row_meta,
        &packed_stop.row_params,
        &packed_stop.row_origins,
        &packed_stop.row_inv_rots,
        &packed_stop.row_rots,
        packed_stop.row_count,
    );
    let mut stop_sampling_fallback_to_entrance = false;
    let mut effective_sampling_radius = sampling_radius;

    if (chief_stop_hit[0] - 1.0).abs() > f64::EPSILON && !prefer_entrance_sampling && use_infinite_mode {
        if let Some(grid_brent_origin) = search_entrance_origin_grid_brent_native(
            &rows,
            &row_origins,
            stop_center_for_sampling,
            infinite_direction,
            stop_surface_index,
            &packed_stop,
            object_space_n,
            entrance_radius,
        ) {
            let candidate_chief = [
                grid_brent_origin[0],
                grid_brent_origin[1],
                grid_brent_origin[2],
                infinite_direction[0],
                infinite_direction[1],
                infinite_direction[2],
            ];
            let candidate_target_hit = trace_single_ray_hit_point_with_meta_core(
                &candidate_chief,
                target_surface_index,
                object_space_n,
                &packed_target.row_meta,
                &packed_target.row_params,
                &packed_target.row_origins,
                &packed_target.row_inv_rots,
                &packed_target.row_rots,
                packed_target.row_count,
            );
            let candidate_stop_hit = trace_single_ray_hit_point_with_meta_core(
                &candidate_chief,
                stop_surface_index,
                object_space_n,
                &packed_stop.row_meta,
                &packed_stop.row_params,
                &packed_stop.row_origins,
                &packed_stop.row_inv_rots,
                &packed_stop.row_rots,
                packed_stop.row_count,
            );
            if (candidate_target_hit[0] - 1.0).abs() <= f64::EPSILON
                && (candidate_stop_hit[0] - 1.0).abs() <= f64::EPSILON
            {
                chief_target_hit = candidate_target_hit;
                chief_stop_hit = candidate_stop_hit;
                effective_emission_origin = grid_brent_origin;
                chief_reference_mode = "grid-brent-stop-chief".to_string();
            }
        }

        if (chief_stop_hit[0] - 1.0).abs() > f64::EPSILON {
            if let Some(newton_origin) = solve_ray_origin_to_stop_point_fast_native(
                infinite_emission_origin,
                infinite_direction,
                stop_center_for_sampling,
                stop_surface_index,
                &packed_stop,
                object_space_n,
            ) {
                let candidate_chief = [
                    newton_origin[0],
                    newton_origin[1],
                    newton_origin[2],
                    infinite_direction[0],
                    infinite_direction[1],
                    infinite_direction[2],
                ];
                let candidate_target_hit = trace_single_ray_hit_point_with_meta_core(
                    &candidate_chief,
                    target_surface_index,
                    object_space_n,
                    &packed_target.row_meta,
                    &packed_target.row_params,
                    &packed_target.row_origins,
                    &packed_target.row_inv_rots,
                    &packed_target.row_rots,
                    packed_target.row_count,
                );
                let candidate_stop_hit = trace_single_ray_hit_point_with_meta_core(
                    &candidate_chief,
                    stop_surface_index,
                    object_space_n,
                    &packed_stop.row_meta,
                    &packed_stop.row_params,
                    &packed_stop.row_origins,
                    &packed_stop.row_inv_rots,
                    &packed_stop.row_rots,
                    packed_stop.row_count,
                );
                if (candidate_target_hit[0] - 1.0).abs() <= f64::EPSILON
                    && (candidate_stop_hit[0] - 1.0).abs() <= f64::EPSILON
                {
                    chief_target_hit = candidate_target_hit;
                    chief_stop_hit = candidate_stop_hit;
                    chief_reference_mode = "newton-stop-chief".to_string();
                }
            }
        }
    }

    if prefer_entrance_sampling || (chief_stop_hit[0] - 1.0).abs() > f64::EPSILON {
        if !prefer_entrance_sampling {
            stop_sampling_fallback_to_entrance = true;
        }
        effective_pupil_sampling_mode = "entrance";
        let field_mag = (used_object_x * used_object_x + used_object_y * used_object_y).sqrt();
        let entrance_radius_scale = (0.92_f64 - 0.012_f64 * field_mag).clamp(0.76, 0.92);
        effective_sampling_radius = (entrance_radius * entrance_radius_scale).max(0.01);

        if use_infinite_mode {
            effective_emission_origin = apply_symmetry_axis_lock(
                search_entrance_origin_grid_brent_native(
                    &rows,
                    &row_origins,
                    stop_center_for_sampling,
                    infinite_direction,
                    stop_surface_index,
                    &packed_stop,
                    object_space_n,
                    entrance_radius,
                )
                .unwrap_or_else(|| {
                    estimate_entrance_center_origin_native(
                        &rows,
                        &row_origins,
                        stop_center_for_sampling,
                        infinite_direction,
                    )
                }),
            );

            if let Some(entrance_chief_ray) =
                build_marginal_ray(0.0, 0.0, effective_sampling_radius, effective_emission_origin)
            {
                let entrance_target_hit = trace_single_ray_hit_point_with_meta_core(
                    &entrance_chief_ray,
                    target_surface_index,
                    object_space_n,
                    &packed_target.row_meta,
                    &packed_target.row_params,
                    &packed_target.row_origins,
                    &packed_target.row_inv_rots,
                    &packed_target.row_rots,
                    packed_target.row_count,
                );
                if (entrance_target_hit[0] - 1.0).abs() <= f64::EPSILON {
                    chief_target_hit = entrance_target_hit;
                }
            }
        }

        chief_reference_mode = if prefer_entrance_sampling {
            format!("entrance-chief-requested(grid-brent,r={:.3})", entrance_radius_scale)
        } else {
            format!("entrance-chief-fallback(grid-brent,r={:.3})", entrance_radius_scale)
        };
    }

    let chief_opl = chief_target_hit[1];
    if !chief_opl.is_finite() {
        return Err(JsValue::from_str("run_native_opd_map_wasm_json: chief OPL is invalid"));
    }

    let mut sample_count = 0usize;
    let mut hit_count = 0usize;
    let mut raw_grid = vec![vec![None::<f64>; grid_size]; grid_size];

    for y in 0..grid_size {
        for x in 0..grid_size {
            let u = if grid_size > 1 {
                -1.0 + 2.0 * (x as f64) / ((grid_size - 1) as f64)
            } else {
                0.0
            };
            let v = if grid_size > 1 {
                -1.0 + 2.0 * (y as f64) / ((grid_size - 1) as f64)
            } else {
                0.0
            };
            let r2 = u * u + v * v;
            if !r2.is_finite() || r2 > 1.0 + 1e-9 {
                continue;
            }
            sample_count += 1;

            let Some(ray) = build_marginal_ray(u, v, effective_sampling_radius, effective_emission_origin) else {
                continue;
            };
            let target_hit = trace_single_ray_hit_point_with_meta_core(
                &ray,
                target_surface_index,
                object_space_n,
                &packed_target.row_meta,
                &packed_target.row_params,
                &packed_target.row_origins,
                &packed_target.row_inv_rots,
                &packed_target.row_rots,
                packed_target.row_count,
            );
            if (target_hit[0] - 1.0).abs() > f64::EPSILON {
                continue;
            }

            let ray_opl = target_hit[1];
            if !ray_opl.is_finite() {
                continue;
            }
            let opd_waves = (ray_opl - chief_opl) / wavelength_um;
            if !opd_waves.is_finite() {
                continue;
            }
            raw_grid[y][x] = Some(opd_waves);
            hit_count += 1;
        }
    }

    let hit_rate = if sample_count > 0 {
        hit_count as f64 / sample_count as f64
    } else {
        0.0
    };
    if use_infinite_mode && effective_pupil_sampling_mode == "entrance" && hit_rate < 0.35 {
        return Err(JsValue::from_str(&format!(
            "No valid OPD samples for entrance mode (hit-rate={:.3}, hits={}, samples={})",
            hit_rate,
            hit_count,
            sample_count
        )));
    }

    let display_grid = apply_display_mode_grid(&raw_grid, &opd_display_mode);
    let to_json_grid = |src: &[Vec<Option<f64>>]| -> Value {
        Value::Array(
            src.iter().map(|row| {
                Value::Array(
                    row.iter().map(|v| {
                        match v {
                            Some(x) if x.is_finite() => Value::from(*x),
                            _ => Value::Null,
                        }
                    }).collect()
                )
            }).collect()
        )
    };

    let response = serde_json::json!({
        "backend": "web-rust-wasm-native-api",
        "targetSurface": target_surface_index,
        "stopSurface": stop_surface_index,
        "requestedObjectIndex": requested_object_index,
        "usedObjectIndex": used_object_index,
        "usedObjectPosition": used_object_position,
        "usedObjectX": used_object_x,
        "usedObjectY": used_object_y,
        "gridSize": grid_size,
        "sampleCount": sample_count,
        "hitCount": hit_count,
        "wavelengthUm": wavelength_um,
        "chiefOplUm": chief_opl,
        "pupilSamplingMode": effective_pupil_sampling_mode,
        "chiefReferenceMode": chief_reference_mode,
        "rawOpdGrid": to_json_grid(&raw_grid),
        "displayOpdGrid": to_json_grid(&display_grid),
        "message": if prefer_entrance_sampling {
            "Computed via Rust-WASM native OPD API (entrance requested)"
        } else if stop_sampling_fallback_to_entrance {
            "Computed via Rust-WASM native OPD API (stop to entrance fallback)"
        } else {
            "Computed via Rust-WASM native OPD API"
        }
    });

    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    response
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("serialize error: {}", e)))
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
pub fn normal_eq_matvec(j_flat: &[f64], m: usize, n: usize, v: &[f64], damping: f64) -> Vec<f64> {
    if n == 0 {
        return vec![];
    }
    if m == 0 || j_flat.len() != m * n || v.len() != n || !damping.is_finite() {
        return vec![f64::NAN; n];
    }
    if j_flat.iter().any(|x| !x.is_finite()) || v.iter().any(|x| !x.is_finite()) {
        return vec![f64::NAN; n];
    }

    let mut jv = vec![0.0_f64; m];
    for i in 0..m {
        let row_base = i * n;
        let row = &j_flat[row_base..(row_base + n)];
        let mut s = 0.0_f64;
        let mut j = 0usize;
        while j + 3 < n {
            s += row[j] * v[j]
                + row[j + 1] * v[j + 1]
                + row[j + 2] * v[j + 2]
                + row[j + 3] * v[j + 3];
            j += 4;
        }
        while j < n {
            s += row[j] * v[j];
            j += 1;
        }
        if !s.is_finite() {
            return vec![f64::NAN; n];
        }
        jv[i] = s;
    }

    let mut out = vec![0.0_f64; n];
    for i in 0..m {
        let ji = jv[i];
        let row_base = i * n;
        let row = &j_flat[row_base..(row_base + n)];
        let mut j = 0usize;
        while j + 3 < n {
            out[j] += row[j] * ji;
            out[j + 1] += row[j + 1] * ji;
            out[j + 2] += row[j + 2] * ji;
            out[j + 3] += row[j + 3] * ji;
            j += 4;
        }
        while j < n {
            out[j] += row[j] * ji;
            j += 1;
        }
    }

    for j in 0..n {
        let value = out[j] + damping * v[j];
        if !value.is_finite() {
            return vec![f64::NAN; n];
        }
        out[j] = value;
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
pub fn assemble_fd_jacobian_grouped(
    r0: &[f64],
    r_batches: &[f64],
    m: usize,
    n: usize,
    col_indices: &[u32],
    steps: &[f64],
) -> Vec<f64> {
    if m == 0 || n == 0 {
        return vec![];
    }
    let k = col_indices.len();
    if r0.len() != m || steps.len() != n || r_batches.len() != m * k {
        return vec![f64::NAN; m * n];
    }

    let mut jac = vec![0.0_f64; m * n];

    for grouped_col in 0..k {
        let col = col_indices[grouped_col] as usize;
        if col >= n {
            return vec![f64::NAN; m * n];
        }

        let h = steps[col];
        if !h.is_finite() || h.abs() < 1e-30 {
            continue;
        }

        let base = grouped_col * m;
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

fn optimize_one_iteration_core(
    x: &[f64],
    steps: &[f64],
    r0: &[f64],
    r_batches: &[f64],
    damping_in: f64,
    trust_radius_in: f64,
    var_scales_in: Option<&[f64]>,
) -> Result<(Vec<f64>, Vec<f64>, f64, f64, f64, usize, usize), &'static str> {
    let n = x.len();
    let m = r0.len();

    if n == 0 || m == 0 {
        return Err("invalid-input");
    }
    if steps.len() != n || r_batches.len() != m * n {
        return Err("invalid-input");
    }
    if x.iter().any(|v| !v.is_finite())
        || steps.iter().any(|v| !v.is_finite() || *v == 0.0)
        || r0.iter().any(|v| !v.is_finite())
        || r_batches.iter().any(|v| !v.is_finite())
    {
        return Err("non-finite-input");
    }

    let damping = if damping_in.is_finite() && damping_in >= 0.0 { damping_in } else { 1e-6 };
    let trust_radius = if trust_radius_in.is_finite() && trust_radius_in > 0.0 { trust_radius_in } else { 1.0 };

    let mut var_scales = vec![1.0_f64; n];
    if let Some(scales) = var_scales_in {
        if scales.len() == n {
            for i in 0..n {
                let s = scales[i].abs();
                var_scales[i] = if s.is_finite() && s > 1e-18 { s } else { 1.0 };
            }
        }
    }

    let j_flat = assemble_fd_jacobian(r0, r_batches, m, n, steps);
    if j_flat.len() != m * n || j_flat.iter().any(|v| !v.is_finite()) {
        return Err("jacobian-failure");
    }

    let packed_ne = build_normal_equations(&j_flat, m, n, r0);
    if packed_ne.len() != n * n + n || packed_ne.iter().any(|v| !v.is_finite()) {
        return Err("normal-eq-failure");
    }

    let mut a = packed_ne[0..(n * n)].to_vec();
    let g = &packed_ne[(n * n)..];
    for i in 0..n {
        a[i * n + i] += damping;
    }
    let rhs: Vec<f64> = g.iter().map(|v| -(*v)).collect();

    let dx = solve_spd_linear_system_internal(&a, n, &rhs)
        .or_else(|| solve_linear_system_internal(&a, n, &rhs))
        .ok_or("linear-solve-failure")?;

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

    Ok((
        dx_limited,
        x_next,
        if predicted_reduction.is_finite() { predicted_reduction } else { 0.0 },
        damping,
        trust_radius,
        m,
        n,
    ))
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
    let (dx_limited, x_next, predicted_reduction, _, _, m_shape, n_shape) =
        optimize_one_iteration_core(&x, &steps, &r0, &r_batches, damping, trust_radius, Some(&var_scales))
            .map_err(|err| JsValue::from_str(err))?;

    Ok(serde_json::to_string(&serde_json::json!({
        "ok": true,
        "status": "pilot-one-iteration",
        "xNext": x_next,
        "dx": dx_limited,
        "predictedReduction": predicted_reduction,
        "jacobianShape": [m_shape, n_shape],
        "usedDamping": damping,
        "usedTrustRegionRadius": trust_radius
    }))
    .map_err(|err| JsValue::from_str(&format!("serialize error: {}", err)))?)
}

#[wasm_bindgen]
pub fn optimize_one_iter_from_buffers(
    x_ptr: u32,
    steps_ptr: u32,
    r0_ptr: u32,
    r_batches_ptr: u32,
    var_scales_ptr: u32,
    out_dx_ptr: u32,
    out_x_next_ptr: u32,
    out_meta_ptr: u32,
    n: u32,
    m: u32,
    damping: f64,
    trust_radius: f64,
) -> u32 {
    let n_usize = n as usize;
    let m_usize = m as usize;
    if n_usize == 0 || m_usize == 0 {
        return OPT_STATUS_INVALID_INPUT;
    }

    let batch_len = match n_usize.checked_mul(m_usize) {
        Some(v) => v,
        None => return OPT_STATUS_INVALID_INPUT,
    };

    if x_ptr == 0
        || steps_ptr == 0
        || r0_ptr == 0
        || r_batches_ptr == 0
        || out_dx_ptr == 0
        || out_x_next_ptr == 0
        || out_meta_ptr == 0
    {
        return OPT_STATUS_INVALID_INPUT;
    }

    let result = std::panic::catch_unwind(|| {
        unsafe {
            let x = std::slice::from_raw_parts(x_ptr as *const f64, n_usize);
            let steps = std::slice::from_raw_parts(steps_ptr as *const f64, n_usize);
            let r0 = std::slice::from_raw_parts(r0_ptr as *const f64, m_usize);
            let r_batches = std::slice::from_raw_parts(r_batches_ptr as *const f64, batch_len);
            let scales_opt = if var_scales_ptr == 0 {
                None
            } else {
                Some(std::slice::from_raw_parts(var_scales_ptr as *const f64, n_usize))
            };

            let (dx, x_next, predicted_reduction, used_damping, used_trust_radius, jac_m, jac_n) =
                optimize_one_iteration_core(x, steps, r0, r_batches, damping, trust_radius, scales_opt)?;

            let out_dx = std::slice::from_raw_parts_mut(out_dx_ptr as *mut f64, n_usize);
            let out_x_next = std::slice::from_raw_parts_mut(out_x_next_ptr as *mut f64, n_usize);
            let out_meta = std::slice::from_raw_parts_mut(out_meta_ptr as *mut f64, 8);

            out_dx.copy_from_slice(&dx);
            out_x_next.copy_from_slice(&x_next);

            out_meta[0] = predicted_reduction;
            out_meta[1] = used_damping;
            out_meta[2] = used_trust_radius;
            out_meta[3] = jac_m as f64;
            out_meta[4] = jac_n as f64;
            out_meta[5] = 0.0;
            out_meta[6] = 0.0;
            out_meta[7] = 0.0;

            Ok::<(), &'static str>(())
        }
    });

    match result {
        Ok(Ok(())) => OPT_STATUS_OK,
        Ok(Err("invalid-input")) => OPT_STATUS_INVALID_INPUT,
        Ok(Err("non-finite-input")) => OPT_STATUS_NON_FINITE_INPUT,
        Ok(Err("jacobian-failure")) => OPT_STATUS_JACOBIAN_FAILURE,
        Ok(Err("normal-eq-failure")) => OPT_STATUS_NORMAL_EQ_FAILURE,
        Ok(Err("linear-solve-failure")) => OPT_STATUS_LINEAR_SOLVE_FAILURE,
        Ok(Err(_)) => OPT_STATUS_INTERNAL_ERROR,
        Err(_) => OPT_STATUS_INTERNAL_ERROR,
    }
}

#[wasm_bindgen]
pub fn malloc(size: usize) -> usize {
    let mut buffer = Vec::<u8>::with_capacity(size);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr as usize
}

#[wasm_bindgen]
pub fn free(ptr: usize, size: usize) {
    if ptr == 0 || size == 0 {
        return;
    }
    unsafe {
        let _ = Vec::<u8>::from_raw_parts(ptr as *mut u8, 0, size);
    }
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
        let row_base = i * cols;
        let row = &a_flat[row_base..(row_base + cols)];
        let mut sum = 0.0;
        let mut j = 0usize;
        while j + 3 < cols {
            sum += row[j] * x[j]
                + row[j + 1] * x[j + 1]
                + row[j + 2] * x[j + 2]
                + row[j + 3] * x[j + 3];
            j += 4;
        }
        while j < cols {
            sum += row[j] * x[j];
            j += 1;
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

fn lca_fill_missing_linear_rust(field_values: &[f64], values: &mut [Option<f64>]) {
    if field_values.len() != values.len() || values.len() < 3 {
        return;
    }

    let known_indices: Vec<usize> = values
        .iter()
        .enumerate()
        .filter_map(|(idx, v)| if v.is_some() { Some(idx) } else { None })
        .collect();

    if known_indices.len() < 2 {
        return;
    }

    let first_known = known_indices[0];
    let last_known = *known_indices.last().unwrap_or(&first_known);

    for i in first_known..=last_known {
        if values[i].is_some() {
            continue;
        }

        let mut left = i as isize - 1;
        while left >= first_known as isize && values[left as usize].is_none() {
            left -= 1;
        }
        if left < first_known as isize {
            continue;
        }

        let mut right = i + 1;
        while right <= last_known && values[right].is_none() {
            right += 1;
        }
        if right > last_known {
            continue;
        }

        let li = left as usize;
        let ri = right;
        let (Some(y_left), Some(y_right)) = (values[li], values[ri]) else {
            continue;
        };

        let x_left = field_values[li];
        let x_right = field_values[ri];
        let x_now = field_values[i];
        let dx = x_right - x_left;
        if !dx.is_finite() || dx.abs() <= 1e-15 {
            continue;
        }
        let t = (x_now - x_left) / dx;
        values[i] = Some(y_left + (y_right - y_left) * t);
    }
}

#[wasm_bindgen]
pub fn compute_lca_series_from_image_heights(
    field_values: &[f64],
    wavelengths: &[f64],
    reference_wavelength: f64,
    image_heights_flat: &[f64],
) -> Result<JsValue, JsValue> {
    let field_len = field_values.len();
    let wl_len = wavelengths.len();
    if field_len == 0 || wl_len == 0 {
        return Err(JsValue::from_str("compute_lca_series_from_image_heights: empty fields or wavelengths"));
    }
    if image_heights_flat.len() != field_len * wl_len {
        return Err(JsValue::from_str("compute_lca_series_from_image_heights: image_heights_flat length mismatch"));
    }

    let reference_index = wavelengths
        .iter()
        .position(|w| (*w - reference_wavelength).abs() < 1e-9)
        .ok_or_else(|| JsValue::from_str("compute_lca_series_from_image_heights: reference wavelength not found"))?;

    let mut reference_heights = vec![None; field_len];
    for fi in 0..field_len {
        let raw = image_heights_flat[reference_index * field_len + fi];
        if raw.is_finite() {
            reference_heights[fi] = Some(raw);
        }
    }

    let mut data_by_wavelength = Vec::with_capacity(wl_len);
    for wi in 0..wl_len {
        let wl = wavelengths[wi];

        let mut image_heights_opt = vec![None; field_len];
        for fi in 0..field_len {
            let raw = image_heights_flat[wi * field_len + fi];
            if raw.is_finite() {
                image_heights_opt[fi] = Some(raw);
            }
        }

        let mut displacements = vec![None; field_len];
        for fi in 0..field_len {
            displacements[fi] = match (image_heights_opt[fi], reference_heights[fi]) {
                (Some(h), Some(r)) => Some(h - r),
                _ => None,
            };
        }

        lca_fill_missing_linear_rust(field_values, &mut displacements);

        let image_heights_json: Vec<Value> = image_heights_opt
            .iter()
            .map(|v| match v {
                Some(x) => Value::from(*x),
                None => Value::Null,
            })
            .collect();
        let displacements_json: Vec<Value> = displacements
            .iter()
            .map(|v| match v {
                Some(x) => Value::from(*x),
                None => Value::Null,
            })
            .collect();

        data_by_wavelength.push(serde_json::json!({
            "wavelength": wl,
            "imageHeights": image_heights_json,
            "displacements": displacements_json,
        }));
    }

    serde_wasm_bindgen::to_value(&serde_json::json!({
        "referenceWavelength": reference_wavelength,
        "dataByWavelength": data_by_wavelength,
    }))
    .map_err(|err| JsValue::from_str(&format!("serialize error: {}", err)))
}