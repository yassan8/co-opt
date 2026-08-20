#![recursion_limit = "256"]

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;
use js_sys::{Float64Array, Function};
use std::cell::RefCell;
use std::f64::consts::PI;

#[cfg(feature = "wasm-threads")]
use rayon::prelude::*;

#[cfg(feature = "wasm-threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

const EPS_R: f64 = 1e-10;
const OPT_STATUS_OK: u32 = 0;
const OPT_STATUS_INVALID_INPUT: u32 = 1;
const OPT_STATUS_NON_FINITE_INPUT: u32 = 2;
const OPT_STATUS_JACOBIAN_FAILURE: u32 = 3;
const OPT_STATUS_NORMAL_EQ_FAILURE: u32 = 4;
const OPT_STATUS_LINEAR_SOLVE_FAILURE: u32 = 5;
const OPT_STATUS_INTERNAL_ERROR: u32 = 6;

#[derive(Clone)]
struct ChiefRayOriginSeedEntryNative {
    direction: [f64; 3],
    origin: [f64; 3],
}

#[derive(Clone)]
struct ChiefRayOriginSeedFamilyNative {
    key: String,
    entries: Vec<ChiefRayOriginSeedEntryNative>,
}

#[derive(Clone)]
struct TraceSystemMetadataCacheEntry {
    handle: u32,
    row_meta: Vec<i32>,
    row_params: Vec<f64>,
    row_origins: Vec<f64>,
    row_inv_rots: Vec<f64>,
    row_rots: Vec<f64>,
    row_count: usize,
}

thread_local! {
    static CHIEF_RAY_ORIGIN_SEED_CACHE_NATIVE: RefCell<Vec<ChiefRayOriginSeedFamilyNative>> = RefCell::new(Vec::new());
    static TRACE_SYSTEM_METADATA_CACHE: RefCell<Vec<TraceSystemMetadataCacheEntry>> = RefCell::new(Vec::new());
    static TRACE_SYSTEM_METADATA_NEXT_HANDLE: RefCell<u32> = RefCell::new(1);
}

fn build_chief_ray_origin_seed_family_key_native(
    stop_center: [f64; 3],
    stop_surface_index: usize,
    row_count: usize,
    wavelength_um: f64,
) -> String {
    format!(
        "{}#{:.10}#{:.10}#{:.10}#{}#{:.10}",
        row_count,
        stop_center[0],
        stop_center[1],
        stop_center[2],
        stop_surface_index,
        wavelength_um,
    )
}

fn get_nearby_chief_ray_origin_seed_native(
    family_key: &str,
    direction: [f64; 3],
) -> Option<[f64; 3]> {
    CHIEF_RAY_ORIGIN_SEED_CACHE_NATIVE.with(|cache| {
        let families = cache.borrow();
        let family = families.iter().find(|entry| entry.key == family_key)?;
        let mut best_origin: Option<[f64; 3]> = None;
        let mut best_distance = f64::INFINITY;
        for entry in &family.entries {
            let di = entry.direction[0] - direction[0];
            let dj = entry.direction[1] - direction[1];
            let dk = entry.direction[2] - direction[2];
            let distance = (di * di + dj * dj + dk * dk).sqrt();
            if distance < best_distance {
                best_distance = distance;
                best_origin = Some(entry.origin);
            }
        }
        if best_distance <= 0.15 {
            best_origin
        } else {
            None
        }
    })
}

fn store_chief_ray_origin_seed_native(
    family_key: &str,
    direction: [f64; 3],
    origin: [f64; 3],
) {
    CHIEF_RAY_ORIGIN_SEED_CACHE_NATIVE.with(|cache| {
        let mut families = cache.borrow_mut();
        let family_index = families.iter().position(|entry| entry.key == family_key);
        let next_entry = ChiefRayOriginSeedEntryNative { direction, origin };
        if let Some(index) = family_index {
            let family = &mut families[index];
            family.entries.retain(|entry| {
                let di = entry.direction[0] - direction[0];
                let dj = entry.direction[1] - direction[1];
                let dk = entry.direction[2] - direction[2];
                (di * di + dj * dj + dk * dk).sqrt() > 1.0e-6
            });
            family.entries.insert(0, next_entry);
            if family.entries.len() > 16 {
                family.entries.truncate(16);
            }
            if index != 0 {
                let family = families.remove(index);
                families.insert(0, family);
            }
        } else {
            families.insert(
                0,
                ChiefRayOriginSeedFamilyNative {
                    key: family_key.to_string(),
                    entries: vec![next_entry],
                },
            );
            if families.len() > 128 {
                families.truncate(128);
            }
        }
    });
}

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

fn parse_numeric_json(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim();
            if t.eq_ignore_ascii_case("inf") || t.eq_ignore_ascii_case("infinity") {
                Some(f64::INFINITY)
            } else {
                t.parse::<f64>().ok()
            }
        }
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct WasmParaxialTraceResult {
    focal_length_mm: f64,
    back_focal_length_mm: f64,
    image_distance_mm: f64,
    final_alpha: f64,
    object_distance_mm: Option<f64>,
    total_system_length_mm: f64,
}

#[derive(Debug, Clone)]
struct WasmStopRayTraceResult {
    image_distance_mm: f64,
    final_alpha: f64,
    initial_alpha: f64,
}

#[derive(Debug, Clone)]
struct WasmPupilEstimate {
    position_mm: f64,
    diameter_mm: f64,
    magnification: f64,
}

#[derive(Debug, Clone, Serialize)]
struct WasmParaxialMetrics {
    #[serde(rename = "FL")]
    fl: f64,
    #[serde(rename = "EFL")]
    efl: f64,
    #[serde(rename = "BFL")]
    bfl: f64,
    #[serde(rename = "IMD")]
    imd: f64,
    #[serde(rename = "OBJD")]
    objd: f64,
    #[serde(rename = "TSL")]
    tsl: f64,
    #[serde(rename = "BEXP")]
    bexp: f64,
    #[serde(rename = "EXPD")]
    expd: f64,
    #[serde(rename = "EXPP")]
    expp: f64,
    #[serde(rename = "ENPD")]
    enpd: f64,
    #[serde(rename = "ENPP")]
    enpp: f64,
    #[serde(rename = "ENPM")]
    enpm: f64,
    #[serde(rename = "PMAG")]
    pmag: f64,
    #[serde(rename = "FNO_OBJ")]
    fno_obj: f64,
    #[serde(rename = "FNO_IMG")]
    fno_img: f64,
    #[serde(rename = "FNO_WRK")]
    fno_wrk: f64,
    #[serde(rename = "NA_OBJ")]
    na_obj: f64,
    #[serde(rename = "NA_IMG")]
    na_img: f64,
}

fn value_to_lower_json(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_lowercase(),
        Value::Bool(b) => if *b { "true".to_string() } else { "false".to_string() },
        Value::Number(n) => n.to_string().to_lowercase(),
        _ => String::new(),
    }
}

fn is_image_surface_json(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let object_type = obj
        .get("object type")
        .or_else(|| obj.get("object"))
        .or_else(|| obj.get("Object"))
        .map(value_to_lower_json)
        .unwrap_or_default();
    let comment = obj
        .get("comment")
        .or_else(|| obj.get("Comment"))
        .map(value_to_lower_json)
        .unwrap_or_default();
    object_type == "image" || comment == "image"
}

fn is_coord_trans_surface_json(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let st = obj
        .get("surfType")
        .or_else(|| obj.get("surface_type"))
        .or_else(|| obj.get("type"))
        .map(value_to_lower_json)
        .unwrap_or_default();
    st == "coord trans" || st == "coordinate break" || st == "ct" || st == "coordtrans"
}

fn detect_stop_surface_index_json(rows: &[Value]) -> Option<usize> {
    for (i, row) in rows.iter().enumerate() {
        let obj = match row.as_object() {
            Some(v) => v,
            None => continue,
        };
        let object_type = obj
            .get("object type")
            .or_else(|| obj.get("object"))
            .or_else(|| obj.get("Object"))
            .map(value_to_lower_json)
            .unwrap_or_default();
        if object_type.contains("stop") || object_type == "sto" {
            return Some(i);
        }
    }

    let mut valid = Vec::<usize>::new();
    for (i, row) in rows.iter().enumerate().skip(1).take(rows.len().saturating_sub(2)) {
        if is_image_surface_json(row) || is_coord_trans_surface_json(row) {
            continue;
        }
        valid.push(i);
    }

    if valid.is_empty() {
        None
    } else {
        Some(valid[valid.len() / 2])
    }
}

fn parse_finite_numeric_json(v: Option<&Value>) -> Option<f64> {
    v.and_then(parse_numeric_json).filter(|n| n.is_finite())
}

fn get_safe_radius_json(row: &Value) -> f64 {
    let Some(obj) = row.as_object() else {
        return f64::INFINITY;
    };
    let r = parse_numeric_json(
        obj.get("radius")
            .or_else(|| obj.get("Radius"))
            .or_else(|| obj.get("curvature"))
            .unwrap_or(&Value::Null),
    );
    match r {
        Some(v) if v.is_finite() && v.abs() >= 1e-10 => v,
        _ => f64::INFINITY,
    }
}

fn get_safe_thickness_json(row: &Value) -> f64 {
    let Some(obj) = row.as_object() else {
        return 0.0;
    };

    if is_coord_trans_surface_json(row) {
        let gap = parse_numeric_json(obj.get("__cooptGapThickness").unwrap_or(&Value::Null));
        return match gap {
            Some(v) if v.is_finite() => v,
            Some(v) if v.is_infinite() => f64::INFINITY,
            _ => 0.0,
        };
    }

    let t = parse_numeric_json(
        obj.get("thickness")
            .or_else(|| obj.get("Thickness"))
            .unwrap_or(&Value::Null),
    );
    match t {
        Some(v) if v.is_finite() => v,
        Some(v) if v.is_infinite() => f64::INFINITY,
        _ => 0.0,
    }
}

fn get_refractive_index_json(row: &Value) -> f64 {
    let Some(obj) = row.as_object() else {
        return 1.0;
    };

    if let Some(v) = parse_finite_numeric_json(obj.get("__cooptResolvedRindex")) {
        if v > 0.0 {
            return v;
        }
    }

    if let Some(v) = parse_finite_numeric_json(
        obj.get("__cooptGapRindex")
            .or_else(|| obj.get("__cooptActualRindex"))
            .or_else(|| obj.get("rindex"))
            .or_else(|| obj.get("ref index"))
            .or_else(|| obj.get("refIndex"))
            .or_else(|| obj.get("Ref Index")),
    ) {
        if v > 0.0 {
            return v;
        }
    }

    let material = obj
        .get("__cooptGapMaterial")
        .or_else(|| obj.get("__cooptActualMaterial"))
        .or_else(|| obj.get("material"))
        .map(value_to_lower_json)
        .unwrap_or_default();

    if material.is_empty() || material == "air" || material == "empty" || material == "0" {
        return 1.0;
    }

    if let Ok(v) = material.parse::<f64>() {
        if v > 1.0 {
            return v;
        }
    }

    1.0
}

fn is_stop_surface_json(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let object = obj
        .get("object")
        .or_else(|| obj.get("object type"))
        .or_else(|| obj.get("Object"))
        .map(value_to_lower_json)
        .unwrap_or_default();
    object == "stop" || object == "sto" || object.contains("stop")
}

fn is_mirror_surface_json(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let material = obj
        .get("material")
        .map(value_to_lower_json)
        .unwrap_or_default();
    material == "mirror"
}

fn calculate_marginal_alpha_at_stop_json(rows: &[Value], stop_index: usize) -> f64 {
    let stop_row = match rows.get(stop_index) {
        Some(v) => v,
        None => return 0.0,
    };
    let stop_thickness = get_safe_thickness_json(stop_row);
    let stop_n = get_refractive_index_json(stop_row);
    let effective_thickness = if stop_thickness.abs() <= 1e-15 { 1e-18 } else { stop_thickness };
    if !stop_n.is_finite() || stop_n.abs() <= 1e-12 {
        return 0.0;
    }
    1.0 / (-effective_thickness * stop_n)
}

fn trace_paraxial_ray_from_stop_json(rows: &[Value], stop_index: usize) -> Option<WasmStopRayTraceResult> {
    if rows.is_empty() || stop_index >= rows.len() {
        return None;
    }

    let mut h = 1.0_f64;
    let mut alpha = calculate_marginal_alpha_at_stop_json(rows, stop_index);
    let initial_alpha = alpha;

    for i in (stop_index + 1)..rows.len() {
        let surface = &rows[i];
        if is_image_surface_json(surface) {
            break;
        }
        if is_coord_trans_surface_json(surface) {
            continue;
        }

        let prev_surface = rows.get(i.saturating_sub(1));
        let current_n = prev_surface.map(get_refractive_index_json).unwrap_or(1.0);
        let next_n = get_refractive_index_json(surface);
        let radius = get_safe_radius_json(surface);
        let thickness = get_safe_thickness_json(surface);

        if radius.is_finite() && radius.abs() > 1e-12 {
            let phi = (next_n - current_n) / radius;
            alpha += phi * h;
        }

        if i < rows.len().saturating_sub(2) {
            let effective_thickness = if thickness.abs() <= 1e-15 { 1e-18 } else { thickness };
            if effective_thickness > 0.0 && next_n.abs() > 1e-12 {
                h -= effective_thickness * alpha / next_n;
            }
        }
    }

    let image_distance_mm = if alpha.abs() > 1e-10 { h / alpha } else { f64::INFINITY };

    Some(WasmStopRayTraceResult {
        image_distance_mm,
        final_alpha: alpha,
        initial_alpha,
    })
}

fn build_reversed_system_for_entrance_json(rows: &[Value], stop_index: usize) -> Vec<Value> {
    let mut reversed = Vec::<Value>::new();

    for i in (0..=stop_index).rev() {
        let Some(src_obj) = rows.get(i).and_then(Value::as_object) else {
            continue;
        };
        if is_coord_trans_surface_json(rows.get(i).unwrap_or(&Value::Null)) {
            continue;
        }

        let mut map = src_obj.clone();

        if let Some(r) = parse_numeric_json(map.get("radius").unwrap_or(&Value::Null)) {
            if r.is_finite() && r.abs() > 1e-12 {
                map.insert("radius".to_string(), Value::from(-r));
            }
        }

        if i > 0 {
            if let Some(prev) = rows.get(i - 1).and_then(Value::as_object) {
                if let Some(v) = prev.get("thickness") {
                    map.insert("thickness".to_string(), v.clone());
                }
                if let Some(v) = prev.get("material") {
                    map.insert("material".to_string(), v.clone());
                }
                let prev_row = Value::Object(prev.clone());
                map.insert("rindex".to_string(), Value::from(get_refractive_index_json(&prev_row)));
            }
        } else {
            map.insert("thickness".to_string(), Value::from(0.0));
            map.insert("material".to_string(), Value::from(""));
            map.insert("rindex".to_string(), Value::from(1.0));
        }

        reversed.push(Value::Object(map));
    }

    reversed
}

fn estimate_entrance_pupil_json(rows: &[Value], stop_index: usize, stop_diameter: f64) -> Option<WasmPupilEstimate> {
    if stop_diameter <= 0.0 {
        return None;
    }

    if stop_index == 1 {
        return Some(WasmPupilEstimate {
            position_mm: 0.0,
            diameter_mm: stop_diameter,
            magnification: 1.0,
        });
    }

    let reversed = build_reversed_system_for_entrance_json(rows, stop_index);
    if reversed.is_empty() {
        return None;
    }

    let trace = trace_paraxial_ray_from_stop_json(&reversed, 0)?;
    let beta = if trace.final_alpha.abs() > 1e-10 {
        trace.initial_alpha / trace.final_alpha
    } else {
        0.0
    };

    let position_mm = if trace.final_alpha.abs() > 1e-10 {
        -(1.0 / trace.final_alpha)
    } else {
        0.0
    };

    Some(WasmPupilEstimate {
        position_mm,
        diameter_mm: beta.abs() * stop_diameter,
        magnification: beta,
    })
}

fn calculate_paraxial_trace_core_json(rows: &[Value], initial_alpha: f64) -> Option<(f64, f64)> {
    if rows.len() < 2 {
        return None;
    }

    let mut h = 1.0_f64;
    let mut alpha = initial_alpha;
    let mut prev_n = 1.0_f64;

    for j in 1..rows.len().saturating_sub(1) {
        let row = &rows[j];
        if is_image_surface_json(row) {
            break;
        }
        if is_coord_trans_surface_json(row) {
            continue;
        }

        let radius = get_safe_radius_json(row);
        let thickness = get_safe_thickness_json(row);
        let is_stop = is_stop_surface_json(row);
        let is_mirror = is_mirror_surface_json(row);

        let next_n = if is_mirror {
            -prev_n
        } else if is_stop {
            prev_n
        } else {
            get_refractive_index_json(row)
        };

        let phi = if radius.is_finite() && radius.abs() > 1e-12 {
            (next_n - prev_n) / radius
        } else {
            0.0
        };
        alpha += phi * h;

        if j < rows.len().saturating_sub(2) && thickness.is_finite() && thickness > 0.0 && next_n.abs() > 1e-12 {
            h -= thickness * alpha / next_n;
        }

        prev_n = next_n;
    }

    Some((h, alpha))
}

fn calculate_full_system_paraxial_trace_json(rows: &[Value]) -> Option<WasmParaxialTraceResult> {
    if rows.is_empty() {
        return None;
    }

    let object_thickness = rows
        .first()
        .and_then(Value::as_object)
        .and_then(|o| o.get("thickness"));
    let object_distance_mm = parse_numeric_json(object_thickness.unwrap_or(&Value::Null))
        .filter(|v| v.is_finite() && *v != 0.0);

    let initial_alpha = if let Some(d0) = object_distance_mm {
        -1.0 / d0
    } else {
        0.0
    };

    let (h, alpha) = calculate_paraxial_trace_core_json(rows, initial_alpha)?;
    let (efl_h, efl_alpha) = if object_distance_mm.is_some() {
        calculate_paraxial_trace_core_json(rows, 0.0).unwrap_or((h, alpha))
    } else {
        (h, alpha)
    };

    let focal_length_mm = if efl_alpha.abs() > 1e-10 {
        1.0 / efl_alpha
    } else {
        f64::INFINITY
    };

    let back_focal_length_mm = if efl_alpha.abs() > 1e-10 {
        efl_h / efl_alpha
    } else {
        f64::INFINITY
    };

    let image_distance_mm = if alpha.abs() > 1e-10 {
        h / alpha
    } else {
        f64::INFINITY
    };

    let total_system_length_mm = rows
        .iter()
        .map(get_safe_thickness_json)
        .filter(|t| t.is_finite())
        .sum::<f64>();

    Some(WasmParaxialTraceResult {
        focal_length_mm,
        back_focal_length_mm,
        image_distance_mm,
        final_alpha: alpha,
        object_distance_mm,
        total_system_length_mm,
    })
}

fn safe0_json(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

fn compute_native_paraxial_metrics_wasm(rows: &[Value], source_rows: &[Value], object_rows: &[Value]) -> WasmParaxialMetrics {
    let zero = WasmParaxialMetrics {
        fl: 0.0, efl: 0.0, bfl: 0.0, imd: 0.0, objd: 0.0, tsl: 0.0,
        bexp: 0.0, expd: 0.0, expp: 0.0, enpd: 0.0, enpp: 0.0, enpm: 0.0,
        pmag: 0.0, fno_obj: 0.0, fno_img: 0.0, fno_wrk: 0.0, na_obj: 0.0, na_img: 0.0,
    };
    if rows.is_empty() {
        return zero;
    }

    let trace = calculate_full_system_paraxial_trace_json(rows);
    let stop_index = detect_stop_surface_index_json(rows).unwrap_or(1);
    let stop_diameter = rows
        .get(stop_index)
        .and_then(Value::as_object)
        .and_then(|o| parse_numeric_json(o.get("semidia").unwrap_or(&Value::Null)))
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|r| r * 2.0)
        .unwrap_or(0.0);
    let stop_trace = trace_paraxial_ray_from_stop_json(rows, stop_index);
    let entrance = estimate_entrance_pupil_json(rows, stop_index, stop_diameter);

    let (exit_pupil_mag, exit_pupil_diameter) = if let Some(st) = stop_trace.as_ref() {
        let beta = if st.final_alpha.abs() > 1e-10 {
            st.initial_alpha / st.final_alpha
        } else {
            0.0
        };
        let ex_pd = (beta.abs() * stop_diameter).max(0.0);
        (beta, ex_pd)
    } else {
        (1.0_f64, stop_diameter)
    };

    let Some(t) = trace else {
        return zero;
    };

    let fl = safe0_json(t.focal_length_mm);
    let bfl = safe0_json(t.back_focal_length_mm);
    let imd = safe0_json(t.image_distance_mm);
    let tsl = safe0_json(t.total_system_length_mm);
    let objd = safe0_json(t.object_distance_mm.unwrap_or(0.0));
    let efl = fl;

    let bexp = safe0_json(exit_pupil_mag);
    let expd = safe0_json(exit_pupil_diameter);

    let exit_pos_from_image = stop_trace
        .as_ref()
        .map(|st| st.image_distance_mm - t.image_distance_mm)
        .filter(|v| v.is_finite())
        .unwrap_or(0.0);
    let expp = safe0_json(exit_pos_from_image);

    let entrance_diameter = entrance
        .as_ref()
        .map(|v| v.diameter_mm)
        .filter(|v| v.is_finite() && *v > 1e-12)
        .unwrap_or(stop_diameter);

    let enpd = safe0_json(entrance.as_ref().map(|v| v.diameter_mm).unwrap_or(stop_diameter));
    let enpp = safe0_json(entrance.as_ref().map(|v| v.position_mm).unwrap_or(0.0));
    let enpm = safe0_json(entrance.as_ref().map(|v| v.magnification).unwrap_or(1.0));

    let beta = if let Some(d0) = t.object_distance_mm {
        if t.final_alpha.abs() > 1e-10 { (-1.0 / d0) / t.final_alpha } else { 0.0 }
    } else {
        0.0
    };
    let pmag = safe0_json(beta);

    let fno_wrk = if expd > 0.0 && t.image_distance_mm.is_finite() {
        safe0_json(t.image_distance_mm.abs() / expd)
    } else {
        0.0
    };

    let fno_obj = if beta.abs() > 1e-10 && fno_wrk.is_finite() {
        safe0_json((fno_wrk / beta).abs())
    } else {
        0.0
    };

    let fno_img = if fl > 0.0 && entrance_diameter > 0.0 {
        safe0_json(fl / entrance_diameter)
    } else {
        0.0
    };

    let na_img = if fno_wrk.is_finite() && fno_wrk.abs() > 1e-12 {
        safe0_json(1.0 / (2.0 * fno_wrk))
    } else {
        0.0
    };

    let na_obj = if na_img.is_finite() && beta.is_finite() {
        safe0_json((na_img * beta).abs())
    } else {
        0.0
    };

    let _ = source_rows;
    let _ = object_rows;

    WasmParaxialMetrics {
        fl, efl, bfl, imd, objd, tsl,
        bexp, expd, expp, enpd, enpp, enpm, pmag,
        fno_obj, fno_img, fno_wrk, na_obj, na_img,
    }
}

#[derive(Debug, Clone, Serialize)]
struct WasmSeidelSurfaceCoeff {
    #[serde(rename = "surfaceIndex")]
    surface_index: usize,
    #[serde(rename = "objectLabel")]
    object_label: String,
    #[serde(rename = "I")]
    i: f64,
    #[serde(rename = "II")]
    ii: f64,
    #[serde(rename = "III")]
    iii: f64,
    #[serde(rename = "P")]
    p: f64,
    #[serde(rename = "IV")]
    iv: f64,
    #[serde(rename = "V")]
    v: f64,
    #[serde(rename = "LCA")]
    lca: f64,
    #[serde(rename = "TCA")]
    tca: f64,
}

#[derive(Debug, Clone, Serialize)]
struct WasmSeidelTotals {
    #[serde(rename = "I")]
    i: f64,
    #[serde(rename = "II")]
    ii: f64,
    #[serde(rename = "III")]
    iii: f64,
    #[serde(rename = "P")]
    p: f64,
    #[serde(rename = "IV")]
    iv: f64,
    #[serde(rename = "V")]
    v: f64,
    #[serde(rename = "LCA")]
    lca: f64,
    #[serde(rename = "TCA")]
    tca: f64,
}

#[derive(Debug, Clone)]
struct WasmRaySurfaceState {
    surface_index: usize,
    height: f64,
    alpha_before: f64,
    alpha_after: f64,
    n_before: f64,
    n_after: f64,
}

fn initial_alpha_for_marginal_json(rows: &[Value]) -> f64 {
    rows.first()
        .and_then(Value::as_object)
        .and_then(|o| o.get("thickness"))
        .and_then(parse_numeric_json)
        .filter(|v| v.is_finite() && *v != 0.0)
        .map(|d0| -1.0 / d0)
        .unwrap_or(0.0)
}

fn initial_alpha_for_chief_json(rows: &[Value], stop_index: usize) -> f64 {
    let stop_radius = rows
        .get(stop_index)
        .and_then(Value::as_object)
        .and_then(|o| parse_numeric_json(o.get("semidia").unwrap_or(&Value::Null)))
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);

    let object_distance = rows
        .first()
        .and_then(Value::as_object)
        .and_then(|o| o.get("thickness"))
        .and_then(parse_numeric_json)
        .filter(|v| v.is_finite() && *v != 0.0)
        .map(f64::abs)
        .unwrap_or(1000.0);

    (stop_radius / object_distance).clamp(0.0001, 0.2)
}

fn trace_ray_surface_states_with_wavelength_json(rows: &[Value], mut alpha: f64, wavelength_um: f64) -> Vec<WasmRaySurfaceState> {
    let mut states = Vec::new();
    if rows.is_empty() {
        return states;
    }

    let mut prev_n = 1.0_f64;
    let mut h = 1.0_f64;

    for j in 1..rows.len() {
        let row = &rows[j];
        if is_coord_trans_surface_json(row) {
            continue;
        }

        let radius = get_safe_radius_json(row);
        let thickness = get_safe_thickness_json(row);
        let is_stop = is_stop_surface_json(row);
        let is_mirror = is_mirror_surface_json(row);

        let next_n = if is_mirror {
            -prev_n
        } else if is_stop {
            prev_n
        } else {
            get_refractive_index_for_wavelength_json(row, wavelength_um)
        };

        let phi = if radius.is_finite() && radius.abs() > 1e-12 {
            (next_n - prev_n) / radius
        } else {
            0.0
        };

        let alpha_before = alpha;
        alpha += phi * h;
        let alpha_after = alpha;

        states.push(WasmRaySurfaceState {
            surface_index: j,
            height: h,
            alpha_before,
            alpha_after,
            n_before: prev_n,
            n_after: next_n,
        });

        if j < rows.len().saturating_sub(1) && thickness.is_finite() && thickness > 0.0 && next_n.abs() > 1e-12 {
            h -= thickness * alpha / next_n;
        }

        prev_n = next_n;
    }

    states
}

fn estimate_refractive_index_from_nd_vd_json(nd: f64, vd: f64, wavelength_um: f64) -> f64 {
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

fn calculate_refractive_index_sellmeier_json(coeffs: &Map<String, Value>, wavelength_um: f64) -> Option<f64> {
    if wavelength_um <= 0.0 {
        return None;
    }
    let a1 = parse_finite_numeric_json(coeffs.get("A1"))?;
    let a2 = parse_finite_numeric_json(coeffs.get("A2"))?;
    let a3 = parse_finite_numeric_json(coeffs.get("A3"))?;
    let b1 = parse_finite_numeric_json(coeffs.get("B1"))?;
    let b2 = parse_finite_numeric_json(coeffs.get("B2"))?;
    let b3 = parse_finite_numeric_json(coeffs.get("B3"))?;

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

fn calculate_refractive_index_schott_json(coeffs: &Map<String, Value>, wavelength_um: f64) -> Option<f64> {
    if wavelength_um <= 0.0 {
        return None;
    }
    let a0 = parse_finite_numeric_json(coeffs.get("A0"))?;
    let a1 = parse_finite_numeric_json(coeffs.get("A1"))?;
    let a2 = parse_finite_numeric_json(coeffs.get("A2"))?;
    let a3 = parse_finite_numeric_json(coeffs.get("A3"))?;
    let a4 = parse_finite_numeric_json(coeffs.get("A4"))?;
    let a5 = parse_finite_numeric_json(coeffs.get("A5"))?;

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

fn get_refractive_index_for_wavelength_json(row: &Value, wavelength_um: f64) -> f64 {
    let Some(obj) = row.as_object() else {
        return 1.0;
    };

    if let Some(v) = parse_finite_numeric_json(obj.get("__cooptResolvedRindex")) {
        if v > 0.0 {
            return v;
        }
    }

    if let Some(gap_material) = obj.get("__cooptGapMaterial") {
        let m = value_to_lower_json(gap_material);
        if m.is_empty() || m == "air" || m == "empty" || m == "0" {
            return 1.0;
        }
        if let Ok(num) = m.parse::<f64>() {
            if num > 1.0 {
                let vd = parse_finite_numeric_json(obj.get("__cooptGapAbbe"));
                if let Some(vd_val) = vd {
                    if vd_val > 0.0 {
                        return estimate_refractive_index_from_nd_vd_json(num, vd_val, wavelength_um);
                    }
                }
                return num;
            }
        }
    }

    let gap_nd = parse_finite_numeric_json(obj.get("__cooptGapRindex"));
    if let Some(nd_val) = gap_nd {
        if nd_val > 0.0 {
            let gap_vd = parse_finite_numeric_json(obj.get("__cooptGapAbbe"));
            if let Some(vd_val) = gap_vd {
                if vd_val > 0.0 {
                    return estimate_refractive_index_from_nd_vd_json(nd_val, vd_val, wavelength_um);
                }
            }
            return nd_val;
        }
    }

    if let Some(sell) = obj
        .get("sellmeier")
        .or_else(|| obj.get("__cooptSellmeier"))
        .and_then(Value::as_object)
    {
        if let Some(n) = calculate_refractive_index_sellmeier_json(sell, wavelength_um) {
            return n;
        }
    }
    if let Some(schott) = obj
        .get("schott")
        .or_else(|| obj.get("__cooptSchott"))
        .and_then(Value::as_object)
    {
        if let Some(n) = calculate_refractive_index_schott_json(schott, wavelength_um) {
            return n;
        }
    }

    let effective_material = obj
        .get("__cooptGapMaterial")
        .or_else(|| obj.get("__cooptActualMaterial"))
        .or_else(|| obj.get("material"));

    if let Some(v) = effective_material.and_then(Value::as_str) {
        let m = v.trim().to_lowercase();
        if !m.is_empty() && m != "air" && m != "empty" {
            if let Ok(num) = m.parse::<f64>() {
                if num > 1.0 {
                    return num;
                }
            }
        }
    }

    let nd = parse_finite_numeric_json(
        obj.get("__cooptActualRindex")
            .or_else(|| obj.get("rindex"))
            .or_else(|| obj.get("ref index"))
            .or_else(|| obj.get("refIndex"))
            .or_else(|| obj.get("Ref Index")),
    );

    let vd = parse_finite_numeric_json(
        obj.get("__cooptActualAbbe")
            .or_else(|| obj.get("abbe"))
            .or_else(|| obj.get("Abbe"))
            .or_else(|| obj.get("vd"))
            .or_else(|| obj.get("Vd")),
    );

    if let Some(nd_val) = nd {
        if let Some(vd_val) = vd {
            if vd_val > 0.0 {
                return estimate_refractive_index_from_nd_vd_json(nd_val, vd_val, wavelength_um);
            }
        }
        if nd_val > 0.0 {
            return nd_val;
        }
    }

    get_refractive_index_json(row)
}

fn detect_wavelength_range_json(source_rows: &[Value]) -> Option<(f64, f64)> {
    if source_rows.is_empty() {
        return None;
    }

    let mut min_w = f64::INFINITY;
    let mut max_w = -f64::INFINITY;

    for row in source_rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let w = parse_numeric_json(
            obj.get("wavelength")
                .or_else(|| obj.get("Wavelength"))
                .unwrap_or(&Value::Null),
        );
        if let Some(v) = w.filter(|x| x.is_finite()) {
            if v < min_w {
                min_w = v;
            }
            if v > max_w {
                max_w = v;
            }
        }
    }

    if min_w.is_finite() && max_w.is_finite() {
        Some((min_w, max_w))
    } else {
        None
    }
}

fn get_nd_abbe_from_row_json(row: Option<&Map<String, Value>>) -> (Option<f64>, Option<f64>) {
    let Some(obj) = row else {
        return (None, None);
    };

    let mut nd = parse_finite_numeric_json(
        obj.get("__cooptGapRindex")
            .or_else(|| obj.get("__cooptActualRindex"))
            .or_else(|| obj.get("Ref Index"))
            .or_else(|| obj.get("refIndex"))
            .or_else(|| obj.get("ref index"))
            .or_else(|| obj.get("rindex"))
            .or_else(|| obj.get("n"))
            .or_else(|| obj.get("nd")),
    );

    if nd.is_none() {
        nd = obj
            .get("Material")
            .or_else(|| obj.get("material"))
            .and_then(|v| parse_finite_numeric_json(Some(v)));
    }

    let abbe = parse_finite_numeric_json(
        obj.get("__cooptGapAbbe")
            .or_else(|| obj.get("__cooptActualAbbe"))
            .or_else(|| obj.get("Abbe"))
            .or_else(|| obj.get("abbe"))
            .or_else(|| obj.get("Vd"))
            .or_else(|| obj.get("vd"))
            .or_else(|| obj.get("abbeNumber"))
            .or_else(|| obj.get("abbe_number")),
    );

    (nd, abbe)
}

fn get_dispersion_fallback_json(row: Option<&Map<String, Value>>) -> Option<f64> {
    let (nd, abbe) = get_nd_abbe_from_row_json(row);
    match (nd, abbe) {
        (Some(n), Some(v)) if v.abs() > 1e-12 => Some((n - 1.0) / v),
        _ => None,
    }
}

fn compute_chromatic_lca_tca_for_surface_json(
    rows: &[Value],
    surface_index: usize,
    h_marginal: f64,
    hq_marginal: f64,
    j_factor: f64,
    ref_state: &WasmRaySurfaceState,
    short_state: Option<&WasmRaySurfaceState>,
    long_state: Option<&WasmRaySurfaceState>,
) -> (f64, f64) {
    let row = rows.get(surface_index).and_then(Value::as_object);
    let prev_row = surface_index
        .checked_sub(1)
        .and_then(|idx| rows.get(idx))
        .and_then(Value::as_object);

    let mut n_d = ref_state.n_after;
    let mut n_d_prev = ref_state.n_before;

    let mut delta_n_prime = match (short_state, long_state) {
        (Some(s), Some(l)) => s.n_after - l.n_after,
        _ => 0.0,
    };
    let mut delta_n = match (short_state, long_state) {
        (Some(s), Some(l)) => s.n_before - l.n_before,
        _ => 0.0,
    };

    let (nd_prime, _) = get_nd_abbe_from_row_json(row);
    let (nd_prev_val, _) = get_nd_abbe_from_row_json(prev_row);

    if (delta_n_prime.abs() < 1e-12 || !delta_n_prime.is_finite()) && nd_prime.is_some() {
        delta_n_prime = get_dispersion_fallback_json(row).unwrap_or(0.0);
        if (n_d - 1.0).abs() < 1e-6 {
            n_d = nd_prime.unwrap_or(n_d);
        }
    }
    if (delta_n.abs() < 1e-12 || !delta_n.is_finite()) && nd_prev_val.is_some() {
        delta_n = get_dispersion_fallback_json(prev_row).unwrap_or(0.0);
        if (n_d_prev - 1.0).abs() < 1e-6 {
            n_d_prev = nd_prev_val.unwrap_or(n_d_prev);
        }
    }

    let mut delta_dn_over_n = 0.0;
    if n_d.abs() > 1e-12 {
        delta_dn_over_n += delta_n_prime / n_d;
    }
    if n_d_prev.abs() > 1e-12 {
        delta_dn_over_n -= delta_n / n_d_prev;
    }

    let lca = h_marginal * hq_marginal * delta_dn_over_n;
    let tca = j_factor * lca;
    (lca, tca)
}

fn compute_seidel_surface_coefficients_json(
    rows: &[Value],
    stop_index: usize,
    afocal: bool,
    reference_wavelength_um: f64,
    wavelength_range: Option<(f64, f64)>,
) -> (Vec<WasmSeidelSurfaceCoeff>, WasmSeidelTotals) {
    let marginal = trace_ray_surface_states_with_wavelength_json(rows, initial_alpha_for_marginal_json(rows), reference_wavelength_um);
    let chief = trace_ray_surface_states_with_wavelength_json(rows, initial_alpha_for_chief_json(rows, stop_index), reference_wavelength_um);
    let (short_wl, long_wl) = wavelength_range.unwrap_or((0.486_132_7, 0.656_272_5));
    let marginal_short = trace_ray_surface_states_with_wavelength_json(rows, initial_alpha_for_marginal_json(rows), short_wl);
    let marginal_long = trace_ray_surface_states_with_wavelength_json(rows, initial_alpha_for_marginal_json(rows), long_wl);

    let mut totals = WasmSeidelTotals {
        i: 0.0,
        ii: 0.0,
        iii: 0.0,
        p: 0.0,
        iv: 0.0,
        v: 0.0,
        lca: 0.0,
        tca: 0.0,
    };
    let mut out = Vec::<WasmSeidelSurfaceCoeff>::new();
    let scale = if afocal { 1.0 } else { 1.0 };

    for m in &marginal {
        let row = rows.get(m.surface_index).and_then(Value::as_object);
        let is_image = rows
            .get(m.surface_index)
            .map(is_image_surface_json)
            .unwrap_or(false);
        if is_image {
            break;
        }

        let is_gap = row
            .and_then(|o| o.get("_blockType").or_else(|| o.get("blockType")))
            .map(value_to_lower_json)
            .map(|s| s == "gap")
            .unwrap_or(false);
        let is_mirror = rows.get(m.surface_index).map(is_mirror_surface_json).unwrap_or(false);
        if is_gap && !is_mirror {
            continue;
        }

        let Some(c) = chief.iter().find(|x| x.surface_index == m.surface_index) else {
            continue;
        };

        let radius = rows
            .get(m.surface_index)
            .map(get_safe_radius_json)
            .unwrap_or(f64::INFINITY);

        let h = m.height;
        let h_chief = c.height;
        let n_before = m.n_before;
        let n_after = m.n_after;

        let hq = if radius.is_finite() && radius.abs() > 1e-12 {
            h * n_before / radius - m.alpha_before
        } else {
            -m.alpha_before
        };
        let hq_chief = if radius.is_finite() && radius.abs() > 1e-12 {
            h_chief * n_before / radius - c.alpha_before
        } else {
            -c.alpha_before
        };
        let j = if hq.abs() > 1e-12 { hq_chief / hq } else { 0.0 };

        let h_delta_1_ns = if n_before.abs() > 1e-12 && n_after.abs() > 1e-12 {
            m.alpha_after / (n_after * n_after) - m.alpha_before / (n_before * n_before)
        } else {
            0.0
        };
        let h_delta_1_ns_chief = if n_before.abs() > 1e-12 && n_after.abs() > 1e-12 {
            c.alpha_after / (n_after * n_after) - c.alpha_before / (n_before * n_before)
        } else {
            0.0
        };

        let phi = if radius.is_finite() && radius.abs() > 1e-12 {
            (n_after - n_before) / radius
        } else {
            0.0
        };
        let p = if n_before.abs() > 1e-12 && n_after.abs() > 1e-12 {
            phi / (n_before * n_after)
        } else {
            0.0
        };

        let i = scale * h * hq * hq * h_delta_1_ns;
        let ii = scale * i * j;
        let iii = scale * h * hq_chief * hq_chief * h_delta_1_ns;
        let iv = scale * (iii + p);
        let v = if hq.abs() < 1e-12 {
            scale * h_delta_1_ns_chief
        } else {
            scale * j * iv
        };

        let short_state = marginal_short.iter().find(|x| x.surface_index == m.surface_index);
        let long_state = marginal_long.iter().find(|x| x.surface_index == m.surface_index);
        let (lca, tca) = compute_chromatic_lca_tca_for_surface_json(
            rows,
            m.surface_index,
            h,
            hq,
            j,
            m,
            short_state,
            long_state,
        );

        let object_label = if m.surface_index == 1 {
            "OBJ".to_string()
        } else if m.surface_index == stop_index {
            "STOP".to_string()
        } else if is_mirror {
            "MIRROR".to_string()
        } else {
            row
                .and_then(|o| {
                    o.get("object type")
                        .or_else(|| o.get("object"))
                        .or_else(|| o.get("surf type"))
                })
                .and_then(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_default()
        };

        totals.i += i;
        totals.ii += ii;
        totals.iii += iii;
        totals.p += p;
        totals.iv += iv;
        totals.v += v;
        totals.lca += lca;
        totals.tca += tca;

        out.push(WasmSeidelSurfaceCoeff {
            surface_index: m.surface_index,
            object_label,
            i,
            ii,
            iii,
            p,
            iv,
            v,
            lca,
            tca,
        });
    }

    (out, totals)
}

fn solve_augmented_3x3(mut a: [[f64; 4]; 3]) -> Option<(f64, f64, f64)> {
    for col in 0..3 {
        let mut pivot_row = col;
        let mut pivot_abs = a[col][col].abs();
        for r in (col + 1)..3 {
            let v = a[r][col].abs();
            if v > pivot_abs {
                pivot_abs = v;
                pivot_row = r;
            }
        }
        if !pivot_abs.is_finite() || pivot_abs < 1.0e-18 {
            return None;
        }
        if pivot_row != col {
            a.swap(col, pivot_row);
        }

        let piv = a[col][col];
        for c in col..4 {
            a[col][c] /= piv;
        }
        for r in 0..3 {
            if r == col {
                continue;
            }
            let f = a[r][col];
            if !f.is_finite() || f.abs() < 1.0e-18 {
                continue;
            }
            for c in col..4 {
                a[r][c] -= f * a[col][c];
            }
        }
    }

    let a0 = a[0][3];
    let b0 = a[1][3];
    let c0 = a[2][3];
    if a0.is_finite() && b0.is_finite() && c0.is_finite() {
        Some((a0, b0, c0))
    } else {
        None
    }
}

fn compute_finite_opd_grid_rms_waves(grid: &[Vec<Option<f64>>]) -> Option<f64> {
    let height = grid.len();
    if height == 0 {
        return None;
    }
    let width = grid.iter().map(|row| row.len()).max().unwrap_or(0);
    if width == 0 {
        return None;
    }
    let mut count = 0usize;
    let mut sum_sq = 0.0_f64;
    for row in grid.iter() {
        for value in row.iter() {
            let Some(v) = *value else { continue; };
            if !v.is_finite() { continue; }
            count += 1;
            sum_sq += v * v;
        }
    }
    if count == 0 { return None; }
    Some((sum_sq / count as f64).sqrt())
}

fn distance3(a: [f64; 3], b: [f64; 3]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

fn reference_sphere_geometry_from_chief(
    chief_image_point: [f64; 3],
    exit_pupil_point: [f64; 3],
) -> Option<([f64; 3], f64, [f64; 3])> {
    let center = chief_image_point;
    let radius = distance3(center, exit_pupil_point);
    if !radius.is_finite() || radius <= 1.0e-9 {
        return None;
    }
    let image_side_direction = [
        exit_pupil_point[0] - center[0],
        exit_pupil_point[1] - center[1],
        exit_pupil_point[2] - center[2],
    ];
    Some((center, radius, image_side_direction))
}

fn optical_path_to_reference_sphere(
    ray_state: &[f64; 8],
    sphere_center: [f64; 3],
    sphere_radius: f64,
    object_side_direction: [f64; 3],
    image_space_n: f64,
    sphere_intersection: &str,
    optical_path_sign: &str,
) -> Option<f64> {
    if (ray_state[0] - 1.0).abs() > f64::EPSILON
        || !ray_state[1].is_finite()
        || !sphere_radius.is_finite()
        || sphere_radius <= 0.0
        || !image_space_n.is_finite()
        || image_space_n <= 0.0
    {
        return None;
    }
    let direction = normalize3(ray_state[5], ray_state[6], ray_state[7]);
    let offset = [
        ray_state[2] - sphere_center[0],
        ray_state[3] - sphere_center[1],
        ray_state[4] - sphere_center[2],
    ];
    let projection = offset[0] * direction[0]
        + offset[1] * direction[1]
        + offset[2] * direction[2];
    let discriminant = projection * projection
        - (offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2]
            - sphere_radius * sphere_radius);
    if !discriminant.is_finite() || discriminant < 0.0 {
        return None;
    }
    let root = discriminant.sqrt();
    let mut selected_t = f64::NAN;
    let mut selected_score = if sphere_intersection == "opposite-side" {
        f64::INFINITY
    } else {
        f64::NEG_INFINITY
    };
    for t in [-projection - root, -projection + root] {
        if !t.is_finite() || t < -1.0e-9 {
            continue;
        }
        let radial = [
            offset[0] + t * direction[0],
            offset[1] + t * direction[1],
            offset[2] + t * direction[2],
        ];
        let score = radial[0] * object_side_direction[0]
            + radial[1] * object_side_direction[1]
            + radial[2] * object_side_direction[2];
        let is_better = if sphere_intersection == "opposite-side" {
            score < selected_score
        } else {
            score > selected_score
        };
        if is_better {
            selected_score = score;
            selected_t = t;
        }
    }
    if !selected_t.is_finite() {
        return None;
    }
    let sphere_path_um = selected_t * image_space_n * 1000.0;
    let optical_path_um = if optical_path_sign == "negative" {
        ray_state[1] - sphere_path_um
    } else {
        ray_state[1] + sphere_path_um
    };
    optical_path_um.is_finite().then_some(optical_path_um)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeOpdMapWasmResponseForScalar {
    backend: String,
    #[serde(default)]
    chief_reference_mode: Option<String>,
    #[serde(default)]
    transmitted_pupil_center_uv: Option<[f64; 2]>,
    target_surface: usize,
    stop_surface: usize,
    #[serde(default)]
    requested_object_index: Option<usize>,
    used_object_index: usize,
    used_object_position: String,
    used_object_x: f64,
    used_object_y: f64,
    wavelength_um: f64,
    grid_size: usize,
    sample_count: usize,
    hit_count: usize,
    #[serde(default)]
    reference_corrected_sample_count: Option<usize>,
    #[serde(default)]
    reference_opd_rms_um: Option<f64>,
    #[serde(default)]
    tracked_opd_rms_um: Option<f64>,
    #[serde(default)]
    before_target_tracked_opd_rms_um: Option<f64>,
    #[serde(default)]
    target_segment_opd_rms_um: Option<f64>,
    #[serde(default)]
    first_surface_opd_rms_um: Option<f64>,
    #[serde(default)]
    current_reference_opd_rms_um: Option<f64>,
    #[serde(default)]
    alternate_reference_opd_rms_um: Option<f64>,
    #[serde(default)]
    target_origin_reference_opd_rms_um: Option<f64>,
    #[serde(default)]
    air_reference_opd_rms_um: Option<f64>,
    #[serde(default)]
    alternate_sign_reference_opd_rms_um: Option<f64>,
    #[serde(default)]
    axis_reference_sphere_rms_um: Option<f64>,
    pupil_sampling_mode: String,
    #[serde(default)]
    reference_sphere_center: Option<[f64; 3]>,
    #[serde(default)]
    reference_sphere_radius_mm: Option<f64>,
    #[serde(default)]
    reference_sphere_direction: Option<[f64; 3]>,
    #[serde(default)]
    exit_pupil_center: Option<[f64; 3]>,
    #[serde(default)]
    reference_sphere_opd_grid: Option<Vec<Vec<Option<f64>>>>,
    #[serde(default)]
    unreferenced_opd_grid: Option<Vec<Vec<Option<f64>>>>,
    #[serde(default)]
    chief_ray_launch_origin: Option<[f64; 3]>,
    #[serde(default)]
    sample_ray_launch_origin_applied: Option<bool>,
    #[serde(default)]
    pupil_mask_grid: Option<Vec<Vec<Option<bool>>>>,
    #[serde(default)]
    display_fit: Option<Value>,
    display_opd_grid: Vec<Vec<Option<f64>>>,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeOpdGridScalarRmsRequest {
    display_opd_grid: Vec<Vec<Option<f64>>>,
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
    // Highest priority: explicit resolved index injected by the JS client
    // (glass-catalog value at the exact wavelength). Guarantees JS parity.
    if let Some(n) = get_field(row, "__cooptResolvedRindex")
        .and_then(value_to_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
    {
        return n;
    }

    if let Some(m) = get_field(row, "material").and_then(value_to_string) {
        let n = parse_refractive_index_from_material(&m);
        if n > 0.0 {
            return n;
        }
    }

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

    1.0
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

fn jacobi_recurrence_coefficients(n: usize, alpha: f64, beta: f64) -> (f64, f64, f64) {
    if n == 0 {
        return (1.0 + 0.5 * (alpha + beta), 0.5 * (alpha - beta), 1.0);
    }

    let n1 = (n + 1) as f64;
    let sum = alpha + beta;
    let a_num = (2.0 * n as f64 + sum + 1.0) * (2.0 * n as f64 + sum + 2.0);
    let a_den = 2.0 * n1 * (n as f64 + sum + 1.0);
    let a = a_num / a_den;
    let b = ((alpha * alpha) - (beta * beta)) * (2.0 * n as f64 + sum + 1.0)
        / (2.0 * n1 * (n as f64 + sum + 1.0) * (2.0 * n as f64 + sum));
    let c = (n as f64 + alpha) * (n as f64 + beta) * (2.0 * n as f64 + sum + 2.0)
        / (n1 * (n as f64 + sum + 1.0) * (2.0 * n as f64 + sum));
    (a, b, c)
}

fn jacobi_polynomial_with_derivative(n: usize, alpha: f64, beta: f64, x: f64) -> (f64, f64) {
    if !x.is_finite() {
        return (f64::NAN, f64::NAN);
    }
    if n == 0 {
        return (1.0, 0.0);
    }

    let p1 = alpha + 1.0 + (alpha + beta + 2.0) * ((x - 1.0) * 0.5);
    let dp1 = 0.5 * (alpha + beta + 2.0);
    if n == 1 {
        return (p1, dp1);
    }

    let mut pnm2 = 1.0;
    let mut dpnm2 = 0.0;
    let mut pnm1 = p1;
    let mut dpnm1 = dp1;
    let mut pn = p1;
    let mut dpn = dp1;

    for i in 2..=n {
        let (a, b, c) = jacobi_recurrence_coefficients(i - 1, alpha, beta);
        let lin = a * x + b;
        pn = lin * pnm1 - c * pnm2;
        dpn = a * pnm1 + lin * dpnm1 - c * dpnm2;
        pnm2 = pnm1;
        dpnm2 = dpnm1;
        pnm1 = pn;
        dpnm1 = dpn;
    }

    (pn, dpn)
}

fn parse_qcon_params(params: &[f64]) -> (f64, f64, f64, f64, f64, [f64; 10]) {
    let semidia = get_param(params, 0, 0.0);
    let radius = get_param(params, 1, 0.0);
    let conic = get_param(params, 2, 0.0);
    let qcon_nrad = get_param(params, 3, 0.0);
    let qcon_offset = get_param(params, 4, 0.0);
    let mut coefs = [0.0_f64; 10];
    for i in 0..10 {
        coefs[i] = get_param(params, 5 + i, 0.0);
    }
    (semidia, radius, conic, qcon_nrad, qcon_offset, coefs)
}

fn resolve_qcon_scale(semidia: f64, radius: f64, qcon_nrad: f64) -> f64 {
    if qcon_nrad.is_finite() && qcon_nrad > 0.0 {
        return if semidia.is_finite() && semidia > 0.0 {
            qcon_nrad.abs().max(semidia.abs())
        } else {
            qcon_nrad.abs()
        };
    }
    if semidia.is_finite() && semidia > 0.0 {
        return semidia.abs();
    }
    if radius.is_finite() && radius != 0.0 {
        return radius.abs();
    }
    1.0
}

fn get_effective_qcon_term_count(coefs: &[f64; 10]) -> usize {
    for i in (0..coefs.len()).rev() {
        if coefs[i] != 0.0 {
            return i + 1;
        }
    }
    0
}

fn qcon_sag_deviation(r: f64, semidia: f64, radius: f64, qcon_nrad: f64, coefs: &[f64; 10]) -> f64 {
    if !r.is_finite() {
        return f64::NAN;
    }
    let scale = resolve_qcon_scale(semidia, radius, qcon_nrad);
    if !scale.is_finite() || scale <= 0.0 {
        return f64::NAN;
    }

    let u = r / scale;
    let u2 = u * u;
    let x = 2.0 * u2 - 1.0;
    let u4 = u2 * u2;
    let terms = get_effective_qcon_term_count(coefs);
    let mut sag = 0.0_f64;

    for i in 0..terms {
        let coef = coefs[i];
        if coef == 0.0 {
            continue;
        }
        let (pn, _) = jacobi_polynomial_with_derivative(i, 0.0, 4.0, x);
        sag += coef * (u4 * pn);
    }

    sag
}

fn qcon_sag_derivative(r: f64, semidia: f64, radius: f64, qcon_nrad: f64, coefs: &[f64; 10]) -> f64 {
    if !r.is_finite() {
        return f64::NAN;
    }
    if r == 0.0 {
        return 0.0;
    }

    let scale = resolve_qcon_scale(semidia, radius, qcon_nrad);
    if !scale.is_finite() || scale <= 0.0 {
        return f64::NAN;
    }

    let u = r / scale;
    let u2 = u * u;
    let x = 2.0 * u2 - 1.0;
    let terms = get_effective_qcon_term_count(coefs);
    let mut derivative = 0.0_f64;

    for i in 0..terms {
        let coef = coefs[i];
        if coef == 0.0 {
            continue;
        }
        let (pn, d_pn_dx) = jacobi_polynomial_with_derivative(i, 0.0, 4.0, x);
        derivative += coef * ((4.0 * u * u2 * pn) + (4.0 * u * u2 * u2 * d_pn_dx)) / scale;
    }

    derivative
}

fn qcon_total_sag(r: f64, semidia: f64, radius: f64, conic: f64, qcon_nrad: f64, qcon_offset: f64, coefs: &[f64; 10]) -> f64 {
    let base = aspheric_sag(r, radius, conic, &[0.0_f64; 10], false);
    let deviation = qcon_sag_deviation(r, semidia, radius, qcon_nrad, coefs);
    base + deviation + qcon_offset
}

fn qcon_total_sag_derivative(r: f64, semidia: f64, radius: f64, conic: f64, qcon_nrad: f64, coefs: &[f64; 10]) -> f64 {
    let base = aspheric_sag_derivative(r, radius, conic, &[0.0_f64; 10], false);
    let deviation = qcon_sag_derivative(r, semidia, radius, qcon_nrad, coefs);
    base + deviation
}

fn intersect_qcon_internal(
    ray: &[f64],
    params: &[f64],
    _mode_odd: bool,
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

    let (semidia_raw, radius, conic, qcon_nrad, qcon_offset, coefs) = parse_qcon_params(params);
    let semidia = if semidia_raw.is_finite() && semidia_raw > 0.0 { semidia_raw } else { f64::INFINITY };
    let mut guesses: Vec<f64> = Vec::new();

    // Keep the initial guess strategy aligned with intersect_aspheric_internal.
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
            let sag = qcon_total_sag(r, semidia, radius, conic, qcon_nrad, qcon_offset, &coefs);
            let f = pz - sag;

            if r <= semidia && f.abs() < last_valid_f.abs() {
                last_valid_t = t;
                last_valid_f = f;
            }

            if f.abs() < tol {
                return t;
            }

            let dzdr = qcon_total_sag_derivative(r, semidia, radius, conic, qcon_nrad, &coefs);
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
        let sag = qcon_total_sag(r, semidia, radius, conic, qcon_nrad, qcon_offset, &coefs);
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
pub fn intersect_qcon_surface(
    ray: &[f64],
    params: &[f64],
    _mode_odd: i32,
    max_iter: i32,
    tol: f64,
) -> f64 {
    intersect_qcon_internal(ray, params, false, max_iter, tol)
}

#[wasm_bindgen]
pub fn intersect_qcon_surface_batch(
    rays: &[f64],
    ray_count: usize,
    params: &[f64],
    _mode_odd: i32,
    max_iter: i32,
    tol: f64,
) -> Vec<f64> {
    let mut out = vec![f64::NAN; ray_count];
    if rays.len() < ray_count * 6 {
        return out;
    }

    for i in 0..ray_count {
        let offset = i * 6;
        let t = intersect_qcon_internal(&rays[offset..offset + 6], params, false, max_iter, tol);
        out[i] = t;
    }

    out
}

#[wasm_bindgen]
pub fn surface_normal_qcon_surface(
    pt: &[f64],
    params: &[f64],
    _mode_odd: i32,
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

    let (semidia_raw, radius, conic, qcon_nrad, _qcon_offset, coefs) = parse_qcon_params(params);
    let semidia = if semidia_raw.is_finite() && semidia_raw > 0.0 { semidia_raw } else { f64::INFINITY };
    let dzdr = qcon_total_sag_derivative(r, semidia, radius, conic, qcon_nrad, &coefs);
    let dzdx = dzdr * (x / r);
    let dzdy = dzdr * (y / r);
    let n = normalize3(-dzdx, -dzdy, 1.0);
    vec![n[0], n[1], n[2]]
}

#[wasm_bindgen]
pub fn surface_normal_qcon_surface_batch(
    points: &[f64],
    count: usize,
    params: &[f64],
    _mode_odd: i32,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; count * 3];
    if points.len() < count * 3 {
        return out;
    }

    let (semidia_raw, radius, conic, qcon_nrad, _qcon_offset, coefs) = parse_qcon_params(params);
    let semidia = if semidia_raw.is_finite() && semidia_raw > 0.0 { semidia_raw } else { f64::INFINITY };
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

        let dzdr = qcon_total_sag_derivative(r, semidia, radius, conic, qcon_nrad, &coefs);
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
        let mut nx = normals[j];
        let mut ny = normals[j + 1];
        let mut nz = normals[j + 2];
        let n1v = n1[i];
        let n2v = n2[i];
        if !dx.is_finite() || !dy.is_finite() || !dz.is_finite() ||
           !nx.is_finite() || !ny.is_finite() || !nz.is_finite() ||
           !n1v.is_finite() || !n2v.is_finite() || n2v == 0.0 {
            continue;
        }

        let d_dot_n = dx * nx + dy * ny + dz * nz;
        if d_dot_n > 0.0 {
            nx = -nx;
            ny = -ny;
            nz = -nz;
        }

        let mut cos_i = -(nx * dx + ny * dy + nz * dz);
        if cos_i < 0.0 { cos_i = 0.0; }
        if cos_i > 1.0 { cos_i = 1.0; }
        let eta = n1v / n2v;
        let mut k = 1.0 - eta * eta * (1.0 - cos_i * cos_i);
        if k < 0.0 && k > -1.0e-10 {
            k = 0.0;
        }
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

            let mut nx = normal[0];
            let mut ny = normal[1];
            let mut nz = normal[2];

            let d_dot_n = dx * nx + dy * ny + dz * nz;
            if d_dot_n > 0.0 {
                nx = -nx;
                ny = -ny;
                nz = -nz;
            }

            // Refract or reflect based on surface properties
            let (new_dx, new_dy, new_dz) = if next_n.is_finite() && next_n > 0.0 && (current_n - next_n).abs() > EPS_R {
                // Refraction
                let mut cos_i = -(nx * dx + ny * dy + nz * dz);
                if cos_i < 0.0 { cos_i = 0.0; }
                if cos_i > 1.0 { cos_i = 1.0; }
                let eta = current_n / next_n;
                let mut k = 1.0 - eta * eta * (1.0 - cos_i * cos_i);
                if k < 0.0 && k > -1.0e-10 {
                    k = 0.0;
                }
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
        let qcon_nrad = row_params[p + 21];
        let qcon_offset = row_params[p + 22];
        let is_qcon = (flags & 64) != 0;

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
        } else if is_qcon {
            let mut ip = vec![0.0_f64; 15];
            ip[0] = semidia;
            ip[1] = radius;
            ip[2] = conic;
            ip[3] = qcon_nrad;
            ip[4] = qcon_offset;
            for k in 0..10 {
                ip[5 + k] = coefs[k];
            }
            intersect_qcon_internal(&[lpx, lpy, lpz, ldx, ldy, ldz], &ip, false, 20, 1e-7)
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
        } else if is_qcon {
            let r = (hx * hx + hy * hy).sqrt();
            if r < EPS_R {
                (0.0, 0.0, 1.0)
            } else {
                let semidia_eff = if semidia.is_finite() && semidia > 0.0 { semidia } else { f64::INFINITY };
                let dzdr = qcon_total_sag_derivative(r, semidia_eff, radius, conic, qcon_nrad, &coefs);
                let nvec = normalize3(-dzdr * (hx / r), -dzdr * (hy / r), 1.0);
                (nvec[0], nvec[1], nvec[2])
            }
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
            let mut cos_i = -(nx * ldx + ny * ldy + nz * ldz);
            if cos_i < 0.0 { cos_i = 0.0; }
            if cos_i > 1.0 { cos_i = 1.0; }
            let eta = n_cur / n2;
            let mut k = 1.0 - eta * eta * (1.0 - cos_i * cos_i);
            if k < 0.0 {
                if k > -1.0e-10 {
                    k = 0.0;
                } else {
                    out[0] = 5.0; // TIR
                    out[1] = opl;
                    return out;
                }
            }
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

fn trace_single_ray_hit_state_with_meta_core(
    ray: &[f64],
    target_surface_index: usize,
    n_start: f64,
    row_meta: &[i32],
    row_params: &[f64],
    row_origins: &[f64],
    row_inv_rots: &[f64],
    row_rots: &[f64],
    row_count: usize,
) -> [f64; 8] {
    let mut out = [0.0_f64; 8];
    if ray.len() < 6 || row_count == 0 || target_surface_index >= row_count {
        out[0] = 2.0;
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
        let aperture_limit = row_params[p + 17];
        let rect_half_w = row_params[p + 18];
        let rect_half_h = row_params[p + 19];
        let n2 = row_params[p + 20];
        let qcon_nrad = row_params[p + 21];
        let qcon_offset = row_params[p + 22];
        let is_qcon = (flags & 64) != 0;

        if kind == 1 || kind == 2 || kind == 3 {
            if i == target_surface_index {
                out[0] = 1.0;
                out[1] = opl;
                out[2] = px;
                out[3] = py;
                out[4] = pz;
                out[5] = dx;
                out[6] = dy;
                out[7] = dz;
                return out;
            }
            if (kind == 2 || kind == 3) && n2.is_finite() && n2 > 0.0 {
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
        } else if is_qcon {
            let mut ip = vec![0.0_f64; 15];
            ip[0] = semidia;
            ip[1] = radius;
            ip[2] = conic;
            ip[3] = qcon_nrad;
            ip[4] = qcon_offset;
            for k in 0..10 {
                ip[5 + k] = coefs[k];
            }
            intersect_qcon_internal(&[lpx, lpy, lpz, ldx, ldy, ldz], &ip, false, 20, 1e-7)
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
            out[0] = 3.0;
            out[1] = opl;
            return out;
        }

        let hx = lpx + ldx * t;
        let hy = lpy + ldy * t;
        let hz = lpz + ldz * t;
        opl += t.abs() * 1000.0 * n_cur;

        if is_rect_ap && rect_half_w.is_finite() && rect_half_h.is_finite() {
            if hx.abs() > rect_half_w || hy.abs() > rect_half_h {
                out[0] = 4.0;
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

        let (mut nx, mut ny, mut nz) = if is_plane {
            if ldz > 0.0 { (0.0, 0.0, -1.0) } else { (0.0, 0.0, 1.0) }
        } else if is_toric {
            let (dz_dx, dz_dy) = toric_sag_derivatives(hx, hy, radius_x, radius_y, conic, toric_axis);
            let nvec = normalize3(-dz_dx, -dz_dy, 1.0);
            (nvec[0], nvec[1], nvec[2])
        } else if is_qcon {
            let r = (hx * hx + hy * hy).sqrt();
            if r < EPS_R {
                (0.0, 0.0, 1.0)
            } else {
                let semidia_eff = if semidia.is_finite() && semidia > 0.0 { semidia } else { f64::INFINITY };
                let dzdr = qcon_total_sag_derivative(r, semidia_eff, radius, conic, qcon_nrad, &coefs);
                let nvec = normalize3(-dzdr * (hx / r), -dzdr * (hy / r), 1.0);
                (nvec[0], nvec[1], nvec[2])
            }
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
            let mut cos_i = -(nx * ldx + ny * ldy + nz * ldz);
            if cos_i < 0.0 { cos_i = 0.0; }
            if cos_i > 1.0 { cos_i = 1.0; }
            let eta = n_cur / n2;
            let mut k = 1.0 - eta * eta * (1.0 - cos_i * cos_i);
            if k < 0.0 {
                if k > -1.0e-10 {
                    k = 0.0;
                } else {
                    out[0] = 5.0;
                    out[1] = opl;
                    return out;
                }
            }
            if k < 0.0 {
                out[0] = 5.0;
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

        let gdx = rm00 * ndx + rm01 * ndy + rm02 * ndz;
        let gdy = rm10 * ndx + rm11 * ndy + rm12 * ndz;
        let gdz = rm20 * ndx + rm21 * ndy + rm22 * ndz;
        let gnorm = normalize3(gdx, gdy, gdz);

        if i == target_surface_index {
            out[0] = 1.0;
            out[1] = opl;
            out[2] = ghx;
            out[3] = ghy;
            out[4] = ghz;
            out[5] = gnorm[0];
            out[6] = gnorm[1];
            out[7] = gnorm[2];
            return out;
        }

        px = ghx;
        py = ghy;
        pz = ghz;
        dx = gnorm[0];
        dy = gnorm[1];
        dz = gnorm[2];
        n_cur = n_next;
    }

    out[0] = 6.0;
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
pub fn trace_ray_batch_spot_metrics_with_meta(
    rays: &[f64],
    ray_count: usize,
    target_surface_index: usize,
    n_start: f64,
    reference_x: f64,
    reference_y: f64,
    row_meta: &[i32],
    row_params: &[f64],
    row_origins: &[f64],
    row_inv_rots: &[f64],
    row_rots: &[f64],
    row_count: usize,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; 8];
    let has_global_invalid = ray_count == 0
        || !reference_x.is_finite()
        || !reference_y.is_finite()
        || row_count == 0
        || target_surface_index >= row_count
        || row_meta.len() < row_count * 4
        || row_params.len() < row_count * 24
        || row_origins.len() < row_count * 3
        || row_inv_rots.len() < row_count * 9
        || row_rots.len() < row_count * 9
        || rays.len() < ray_count * 6;
    if has_global_invalid {
        return out;
    }

    let mut count = 0usize;
    let mut sum_x = 0.0_f64;
    let mut sum_y = 0.0_f64;
    let mut sum_dx2 = 0.0_f64;
    let mut sum_dy2 = 0.0_f64;
    let mut max_r2 = 0.0_f64;

    for i in 0..ray_count {
        let rbase = i * 6;
        let result = trace_single_ray_hit_point_with_meta_core(
            &rays[rbase..(rbase + 6)],
            target_surface_index,
            n_start,
            row_meta,
            row_params,
            row_origins,
            row_inv_rots,
            row_rots,
            row_count,
        );
        let x = result[2];
        let y = result[3];
        if result[0] != 1.0 || !x.is_finite() || !y.is_finite() {
            continue;
        }

        let dx = x - reference_x;
        let dy = y - reference_y;
        let r2 = dx * dx + dy * dy;
        count += 1;
        sum_x += x;
        sum_y += y;
        sum_dx2 += dx * dx;
        sum_dy2 += dy * dy;
        max_r2 = max_r2.max(r2);
    }

    if count == 0 {
        return out;
    }

    let count_f64 = count as f64;
    let rms_x = (sum_dx2 / count_f64).sqrt();
    let rms_y = (sum_dy2 / count_f64).sqrt();
    out[0] = count_f64;
    out[1] = sum_x / count_f64;
    out[2] = sum_y / count_f64;
    out[3] = rms_x;
    out[4] = rms_y;
    out[5] = (rms_x * rms_x + rms_y * rms_y).sqrt();
    out[6] = 2.0 * max_r2.sqrt();
    out[7] = 1.0;
    out
}

#[wasm_bindgen]
pub fn register_trace_system_metadata(
    row_meta: &[i32],
    row_params: &[f64],
    row_origins: &[f64],
    row_inv_rots: &[f64],
    row_rots: &[f64],
    row_count: usize,
) -> u32 {
    if row_count == 0
        || row_meta.len() < row_count * 4
        || row_params.len() < row_count * 24
        || row_origins.len() < row_count * 3
        || row_inv_rots.len() < row_count * 9
        || row_rots.len() < row_count * 9
    {
        return 0;
    }

    let handle = TRACE_SYSTEM_METADATA_NEXT_HANDLE.with(|next| {
        let mut value = next.borrow_mut();
        let handle = *value;
        *value = value.wrapping_add(1).max(1);
        handle
    });
    let entry = TraceSystemMetadataCacheEntry {
        handle,
        row_meta: row_meta[..row_count * 4].to_vec(),
        row_params: row_params[..row_count * 24].to_vec(),
        row_origins: row_origins[..row_count * 3].to_vec(),
        row_inv_rots: row_inv_rots[..row_count * 9].to_vec(),
        row_rots: row_rots[..row_count * 9].to_vec(),
        row_count,
    };
    TRACE_SYSTEM_METADATA_CACHE.with(|cache| {
        let mut entries = cache.borrow_mut();
        entries.push(entry);
        if entries.len() > 8 {
            entries.remove(0);
        }
    });
    handle
}

#[wasm_bindgen]
pub fn clear_trace_system_metadata_cache() {
    TRACE_SYSTEM_METADATA_CACHE.with(|cache| cache.borrow_mut().clear());
}

#[wasm_bindgen]
pub fn trace_ray_batch_spot_metrics_cached(
    rays: &[f64],
    ray_count: usize,
    target_surface_index: usize,
    n_start: f64,
    reference_x: f64,
    reference_y: f64,
    metadata_handle: u32,
) -> Vec<f64> {
    let cached = TRACE_SYSTEM_METADATA_CACHE.with(|cache| {
        cache
            .borrow()
            .iter()
            .find(|entry| entry.handle == metadata_handle)
            .cloned()
    });
    let Some(entry) = cached else {
        return vec![0.0_f64; 8];
    };
    trace_ray_batch_spot_metrics_with_meta(
        rays,
        ray_count,
        target_surface_index,
        n_start,
        reference_x,
        reference_y,
        &entry.row_meta,
        &entry.row_params,
        &entry.row_origins,
        &entry.row_inv_rots,
        &entry.row_rots,
        entry.row_count,
    )
}

#[wasm_bindgen]
pub fn trace_spot_metric_jobs_cached(
    rays: &[f64],
    ray_offsets: &[u32],
    ray_counts: &[u32],
    target_surface_indices: &[u32],
    n_starts: &[f64],
    reference_xs: &[f64],
    reference_ys: &[f64],
    metadata_handles: &[u32],
    job_count: usize,
) -> Vec<f64> {
    if job_count == 0
        || ray_offsets.len() < job_count
        || ray_counts.len() < job_count
        || target_surface_indices.len() < job_count
        || n_starts.len() < job_count
        || reference_xs.len() < job_count
        || reference_ys.len() < job_count
        || metadata_handles.len() < job_count
    {
        return Vec::new();
    }

    let mut out = vec![0.0_f64; job_count * 8];
    for job_index in 0..job_count {
        let ray_offset = ray_offsets[job_index] as usize;
        let ray_count = ray_counts[job_index] as usize;
        let ray_start = match ray_offset.checked_mul(6) {
            Some(value) => value,
            None => continue,
        };
        let ray_end = match ray_count.checked_mul(6).and_then(|len| ray_start.checked_add(len)) {
            Some(value) if value <= rays.len() => value,
            _ => continue,
        };
        let metrics = trace_ray_batch_spot_metrics_cached(
            &rays[ray_start..ray_end],
            ray_count,
            target_surface_indices[job_index] as usize,
            n_starts[job_index],
            reference_xs[job_index],
            reference_ys[job_index],
            metadata_handles[job_index],
        );
        out[job_index * 8..(job_index + 1) * 8].copy_from_slice(&metrics);
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

fn compute_native_chief_ray_angle_deg_wasm(
    optical_system_rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
) -> Option<f64> {
    if optical_system_rows.is_empty() || object_rows.is_empty() {
        return None;
    }

    let rows: Vec<Value> = optical_system_rows
        .iter()
        .map(normalize_coord_trans_row)
        .collect();
    if rows.is_empty() {
        return None;
    }

    let source_rows_effective: Vec<Value> = if source_rows.is_empty() {
        vec![serde_json::json!({
            "id": "NativeCraSource",
            "name": "NativeCraSource",
            "wavelength": 0.5875618,
            "color": "#2563eb",
            "isPrimary": true,
            "primary": "Primary",
            "intensity": 1,
        })]
    } else {
        source_rows.to_vec()
    };

    let target_surface_index = find_eval_surface_index(&rows).min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index(&rows).min(rows.len().saturating_sub(1));
    let wavelength = get_primary_wavelength_um_native(&source_rows_effective, 0.5876);
    let (packed_stop, n_start) = build_trace_packed_meta_for_wavelength(&rows, wavelength, stop_surface_index);
    let (packed_target, _) = build_trace_packed_meta_for_wavelength(&rows, wavelength, target_surface_index);

    let stop_base = stop_surface_index.saturating_mul(3);
    if stop_base + 2 >= packed_stop.row_origins.len() {
        return None;
    }
    let stop_center = [
        packed_stop.row_origins[stop_base],
        packed_stop.row_origins[stop_base + 1],
        packed_stop.row_origins[stop_base + 2],
    ];

    let object_map = object_rows.first()?.as_object()?;
    let object_position = object_map
        .get("__cooptOriginalPosition")
        .or_else(|| object_map.get("position"))
        .or_else(|| object_map.get("object"))
        .or_else(|| object_map.get("objectType"))
        .or_else(|| object_map.get("type"))
        .and_then(value_to_string)
        .unwrap_or_else(|| if is_infinite_conjugate_native(&rows) { "Angle".to_string() } else { "Rectangle".to_string() })
        .trim()
        .to_ascii_lowercase();

    let pick_first_finite = |values: &[Option<f64>], fallback: f64| -> f64 {
        for value in values {
            if let Some(v) = value {
                if v.is_finite() {
                    return *v;
                }
            }
        }
        fallback
    };

    let ray_state = if is_infinite_conjugate_native(&rows) || object_position.contains("angle") || object_position == "point" {
        let angle_x = pick_first_finite(&[
            object_map.get("xHeightAngle").and_then(value_to_f64),
            object_map.get("xFieldAngle").and_then(value_to_f64),
            object_map.get("x").and_then(value_to_f64),
            object_map.get("xHeight").and_then(value_to_f64),
        ], 0.0);
        let angle_y = pick_first_finite(&[
            object_map.get("yHeightAngle").and_then(value_to_f64),
            object_map.get("yFieldAngle").and_then(value_to_f64),
            object_map.get("fieldAngle").and_then(value_to_f64),
            object_map.get("y").and_then(value_to_f64),
            object_map.get("yHeight").and_then(value_to_f64),
        ], 0.0);
        let (origin, direction, _) = trace_image_height_infinite_chief_ray_exact_native(
            &rows,
            &packed_stop,
            &packed_target,
            n_start,
            wavelength,
            stop_surface_index,
            target_surface_index,
            stop_center,
            angle_x,
            angle_y,
        )?;
        trace_single_ray_hit_state_with_meta_core(
            &[origin[0], origin[1], origin[2], direction[0], direction[1], direction[2]],
            target_surface_index,
            n_start,
            &packed_target.row_meta,
            &packed_target.row_params,
            &packed_target.row_origins,
            &packed_target.row_inv_rots,
            &packed_target.row_rots,
            packed_target.row_count,
        )
    } else {
        let object_x = pick_first_finite(&[
            object_map.get("xHeight").and_then(value_to_f64),
            object_map.get("x").and_then(value_to_f64),
        ], 0.0);
        let object_y = pick_first_finite(&[
            object_map.get("yHeight").and_then(value_to_f64),
            object_map.get("y").and_then(value_to_f64),
            object_map.get("height").and_then(value_to_f64),
        ], 0.0);
        let first_surface_z = packed_target.row_origins.get(2).copied().unwrap_or(0.0);
        let object_sag = compute_object_surface_sag_native(&rows, object_x, object_y);
        let object_point = [object_x, object_y, first_surface_z + object_sag];
        let initial_direction = normalize3(
            stop_center[0] - object_point[0],
            stop_center[1] - object_point[1],
            stop_center[2] - object_point[2],
        );
        let direction = solve_ray_direction_to_stop_point_fast_native(
            object_point,
            stop_center,
            stop_surface_index,
            &packed_stop,
            n_start,
            initial_direction,
        )?;
        trace_single_ray_hit_state_with_meta_core(
            &[object_point[0], object_point[1], object_point[2], direction[0], direction[1], direction[2]],
            target_surface_index,
            n_start,
            &packed_target.row_meta,
            &packed_target.row_params,
            &packed_target.row_origins,
            &packed_target.row_inv_rots,
            &packed_target.row_rots,
            packed_target.row_count,
        )
    };

    if (ray_state[0] - 1.0).abs() > f64::EPSILON {
        return None;
    }
    let dir = normalize3(ray_state[5], ray_state[6], ray_state[7]);
    let transverse = (dir[0] * dir[0] + dir[1] * dir[1]).sqrt();
    let angle_deg = transverse.atan2(dir[2].abs()) * 180.0 / PI;
    if angle_deg.is_finite() {
        Some(angle_deg.abs())
    } else {
        None
    }
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

fn apply_display_mode_grid(
    raw: &[Vec<Option<f64>>],
    entrance_x: &[Vec<Option<f64>>],
    entrance_y: &[Vec<Option<f64>>],
    pupil_mask: &[Vec<Option<bool>>],
    mode: &str,
) -> (Vec<Vec<Option<f64>>>, Value) {
    let n = raw.len();
    if n == 0 {
        return (Vec::new(), Value::Null);
    }
    let mode_text = mode.trim();
    let scaled_defocus = mode_text
        .strip_prefix("pistonDefocusScaled:")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0));
    let remove_tilt = mode.eq_ignore_ascii_case("pistonTiltRemoved")
        || mode.eq_ignore_ascii_case("pistonTiltDefocusRemoved");
    let remove_defocus = scaled_defocus.map(|value| value > 1e-12).unwrap_or(false)
        || mode.eq_ignore_ascii_case("pistonDefocusRemoved")
        || mode.eq_ignore_ascii_case("pistonTiltDefocusRemoved");
    let defocus_scale = scaled_defocus.unwrap_or(1.0);
    let remove_piston = scaled_defocus.is_some()
        || mode.eq_ignore_ascii_case("pistonRemoved")
        || remove_tilt
        || remove_defocus;
    if !remove_piston {
        return (raw.to_vec(), Value::Null);
    }

    let sample_coordinates = |iy: usize, ix: usize| {
        let physical_x = entrance_x.get(iy).and_then(|row| row.get(ix)).and_then(|value| *value);
        let physical_y = entrance_y.get(iy).and_then(|row| row.get(ix)).and_then(|value| *value);
        match (physical_x, physical_y) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() => (x, y, true),
            _ => {
                let x = if n > 1 { (2.0 * ix as f64) / ((n - 1) as f64) - 1.0 } else { 0.0 };
                let y = if n > 1 { (2.0 * iy as f64) / ((n - 1) as f64) - 1.0 } else { 0.0 };
                (x, y, false)
            },
        }
    };
    let mut samples = Vec::<(usize, usize, f64, f64, f64, bool)>::new();
    for iy in 0..n {
        for ix in 0..n {
            let Some(z) = raw[iy][ix] else { continue; };
            if pupil_mask.get(iy).and_then(|row| row.get(ix)).and_then(|value| *value) == Some(false) {
                continue;
            }
            let (x, y, physical) = sample_coordinates(iy, ix);
            samples.push((iy, ix, z, x, y, physical));
        }
    }
    let defocus_mean_radius_squared = if remove_defocus && !samples.is_empty() {
        samples.iter().map(|sample| sample.3 * sample.3 + sample.4 * sample.4).sum::<f64>() / samples.len() as f64
    } else {
        0.0
    };
    let physical_coordinate_sample_count = samples.iter().filter(|sample| sample.5).count();
    let k = if remove_tilt && remove_defocus { 4 } else if remove_tilt { 3 } else if remove_defocus { 2 } else { 1 };
    let mut normal = vec![vec![0.0_f64; k]; k];
    let mut rhs = vec![0.0_f64; k];
    let count = samples.len();

    for (_, _, z, x, y, _) in samples.iter().copied() {
            let orthogonal_defocus = x * x + y * y - defocus_mean_radius_squared;
            let basis = if remove_tilt && remove_defocus {
                [1.0, x, y, orthogonal_defocus]
            } else if remove_tilt {
                [1.0, x, y, 0.0]
            } else if remove_defocus {
                [1.0, orthogonal_defocus, 0.0, 0.0]
            } else {
                [1.0, 0.0, 0.0, 0.0]
            };
            for r in 0..k {
                rhs[r] += basis[r] * z;
                for c in 0..k {
                    normal[r][c] += basis[r] * basis[c];
                }
            }
    }

    if count <= k {
        return (raw.to_vec(), Value::Null);
    }
    let Some(coeff) = solve_linear(normal, rhs) else {
        return (raw.to_vec(), Value::Null);
    };

    let fit_diagnostic = serde_json::json!({
        "sampleCount": count,
        "basis": if remove_tilt && remove_defocus { "pistonTiltDefocus" } else if remove_tilt { "pistonTilt" } else if remove_defocus { "pistonDefocus" } else { "piston" },
        "piston": coeff.first().copied().unwrap_or(0.0),
        "tiltX": if remove_tilt { coeff.get(1).copied().unwrap_or(0.0) } else { 0.0 },
        "tiltY": if remove_tilt { coeff.get(2).copied().unwrap_or(0.0) } else { 0.0 },
        "defocus": if remove_tilt && remove_defocus { coeff.get(3).copied().unwrap_or(0.0) } else if remove_defocus { coeff.get(1).copied().unwrap_or(0.0) } else { 0.0 },
        "defocusScale": if remove_defocus { defocus_scale } else { 0.0 },
        "defocusMeanRadiusSquared": if remove_defocus { Some(defocus_mean_radius_squared) } else { None },
        "coordinateSource": if physical_coordinate_sample_count == count { "entrance-pupil" } else { "grid-index-fallback" },
        "physicalCoordinateSampleCount": physical_coordinate_sample_count
    });

    let mut out = vec![vec![None; n]; n];
    for (iy, ix, z, x, y, _) in samples {
            let orthogonal_defocus = x * x + y * y - defocus_mean_radius_squared;
            let fit = if remove_tilt && remove_defocus {
                coeff[0] + coeff[1] * x + coeff[2] * y + defocus_scale * coeff[3] * orthogonal_defocus
            } else if remove_tilt {
                coeff[0] + coeff[1] * x + coeff[2] * y
            } else if remove_defocus {
                coeff[0] + defocus_scale * coeff[1] * orthogonal_defocus
            } else {
                coeff[0]
            };
            out[iy][ix] = Some(z - fit);
    }
    (out, fit_diagnostic)
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

fn compute_packed_surface_origins_for_opd(
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
        row_origins[o] = surface_origin[0];
        row_origins[o + 1] = surface_origin[1];
        row_origins[o + 2] = surface_origin[2];

        let r = s * 9;
        for rr in 0..3 {
            for cc in 0..3 {
                row_rots[r + rr * 3 + cc] = surface_rot[rr][cc];
                row_inv_rots[r + rr * 3 + cc] = surface_rot[cc][rr];
            }
        }

        current_origin = surface_origin;
        current_rot = surface_rot;
    }
}

fn build_packed_meta_for_opd(rows: &[Value], wavelength_um: f64, target_surface_index: usize) -> PackedMeta {
    let mut row_meta = vec![0_i32; rows.len() * 4];
    let mut row_params = vec![0.0_f64; rows.len() * 24];
    let mut row_origins = vec![0.0_f64; rows.len() * 3];
    let mut row_inv_rots = vec![0.0_f64; rows.len() * 9];
    let mut row_rots = vec![0.0_f64; rows.len() * 9];
    compute_packed_surface_origins_for_opd(rows, &mut row_origins, &mut row_rots, &mut row_inv_rots);
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
        row_params[p + 17] = if i == target_surface_index || is_image_surface { f64::INFINITY } else { ap_lim };
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

        if surf_type.contains("qcon") {
            row_meta[m + 1] |= 64;
        }
        row_params[p + 21] = get_field(row, "qconNrad")
            .or_else(|| get_field(row, "qconNRadius"))
            .or_else(|| get_field(row, "nrad"))
            .or_else(|| get_field(row, "NRAD"))
            .and_then(value_to_f64)
            .filter(|v| v.is_finite() && *v > 0.0)
            .map(|v| v.abs())
            .unwrap_or(0.0);
        row_params[p + 22] = get_field(row, "qconOffset")
            .or_else(|| get_field(row, "qcon_offset"))
            .or_else(|| get_field(row, "offset"))
            .and_then(value_to_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);
    }

    PackedMeta { row_meta, row_params, row_origins, row_inv_rots, row_rots, row_count: rows.len() }
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

fn distortion_is_mirror_row(row: &Value) -> bool {
    let material = get_field(row, "material")
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();
    let row_type = get_field(row, "type")
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();
    let block_type = get_field(row, "_blockType")
        .or_else(|| get_field(row, "blockType"))
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();
    let surf_type = get_field(row, "surfType")
        .or_else(|| get_field(row, "surfaceType"))
        .or_else(|| get_field(row, "type"))
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();

    material == "mirror" || row_type == "mirror" || block_type == "mirror" || surf_type == "mirror"
}

fn distortion_mirror_sign(rows: &[Value]) -> f64 {
    let mirror_count = rows.iter().filter(|row| distortion_is_mirror_row(row)).count();
    if mirror_count % 2 == 1 { -1.0 } else { 1.0 }
}

fn get_primary_wavelength_um_native(source_rows: &[Value], default_wavelength: f64) -> f64 {
    let primary = source_rows.iter().find_map(|row| {
        let is_primary = get_field(row, "isPrimary")
            .and_then(|v| match v {
                Value::Bool(b) => Some(*b),
                Value::Number(n) => Some(n.as_i64().unwrap_or(0) != 0),
                Value::String(s) => {
                    let t = s.trim().to_ascii_lowercase();
                    Some(t == "true" || t == "1" || t == "yes")
                }
                _ => None,
            })
            .unwrap_or(false);
        let primary_marker = get_field(row, "primary")
            .or_else(|| get_field(row, "Primary"))
            .or_else(|| get_field(row, "Primary Wavelength"))
            .and_then(value_to_string)
            .map(|value| {
                let text = value.trim().to_ascii_lowercase();
                text == "true" || text == "1" || text == "yes" || text.contains("primary")
            })
            .unwrap_or(false);
        if !is_primary && !primary_marker {
            return None;
        }
        get_field(row, "wavelength")
            .or_else(|| get_field(row, "wavelengthUm"))
            .and_then(value_to_f64)
            .filter(|w| w.is_finite() && *w > 0.0)
    });
    if let Some(wl) = primary {
        return wl;
    }

    source_rows
        .iter()
        .filter_map(|row| {
            get_field(row, "wavelength")
                .or_else(|| get_field(row, "wavelengthUm"))
                .and_then(value_to_f64)
        })
        .find(|w| w.is_finite() && *w > 0.0)
        .unwrap_or(default_wavelength)
}

fn distortion_source_rows_for_wavelength_native(source_rows: &[Value], wavelength: f64) -> Vec<Value> {
    let wl = if wavelength.is_finite() && wavelength > 0.0 {
        wavelength
    } else {
        0.5876
    };

    let mut picked: Option<Value> = None;
    let mut best_delta = f64::INFINITY;
    for row in source_rows {
        let row_wl = get_field(row, "wavelength")
            .or_else(|| get_field(row, "Wavelength"))
            .or_else(|| get_field(row, "wavelengthUm"))
            .and_then(value_to_f64);
        if let Some(v) = row_wl {
            if v.is_finite() && v > 0.0 {
                let d = (v - wl).abs();
                if d < best_delta {
                    best_delta = d;
                    picked = Some(row.clone());
                }
            }
        }
    }

    let mut src = picked
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_else(Map::new);
    src.insert("wavelength".to_string(), Value::from(wl));
    src.insert("Wavelength".to_string(), Value::from(wl));
    src.insert("wavelengthUm".to_string(), Value::from(wl));
    src.insert("primary".to_string(), Value::from("Primary Wavelength"));
    src.insert("isPrimary".to_string(), Value::from(true));
    if !src.contains_key("id") {
        src.insert("id".to_string(), Value::from("NativeDistortionSource"));
    }
    if !src.contains_key("name") {
        src.insert("name".to_string(), Value::from("NativeDistortionSource"));
    }
    vec![Value::Object(src)]
}

fn compute_packed_surface_origins_native(
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
            if !thickness.is_finite() {
                thickness = 0.0;
            }
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
            if !thickness.is_finite() {
                thickness = 0.0;
            }
            let tz_term = vec3_scale(apply_matrix_to_vec3(current_rot, ez), thickness);
            (vec3_add(current_origin, tz_term), current_rot)
        };

        let o = s * 3;
        row_origins[o] = surface_origin[0];
        row_origins[o + 1] = surface_origin[1];
        row_origins[o + 2] = surface_origin[2];

        let r = s * 9;
        for rr in 0..3 {
            for cc in 0..3 {
                row_rots[r + rr * 3 + cc] = surface_rot[rr][cc];
                row_inv_rots[r + rr * 3 + cc] = surface_rot[cc][rr];
            }
        }

        current_origin = surface_origin;
        current_rot = surface_rot;
    }
}

fn build_trace_packed_meta_for_wavelength(
    rows: &[Value],
    wavelength_um: f64,
    target_surface_index: usize,
) -> (PackedMeta, f64) {
    let mut row_meta = vec![0_i32; rows.len() * 4];
    let mut row_params = vec![0.0_f64; rows.len() * 24];
    let mut row_origins = vec![0.0_f64; rows.len() * 3];
    let mut row_inv_rots = vec![0.0_f64; rows.len() * 9];
    let mut row_rots = vec![0.0_f64; rows.len() * 9];
    compute_packed_surface_origins_native(rows, &mut row_origins, &mut row_rots, &mut row_inv_rots);

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

        if surf_type.contains("qcon") {
            row_meta[m + 1] |= 64;
        }
        row_params[p + 21] = get_field(row, "qconNrad")
            .or_else(|| get_field(row, "qconNRadius"))
            .or_else(|| get_field(row, "nrad"))
            .or_else(|| get_field(row, "NRAD"))
            .and_then(value_to_f64)
            .filter(|v| v.is_finite() && *v > 0.0)
            .map(|v| v.abs())
            .unwrap_or(0.0);
        row_params[p + 22] = get_field(row, "qconOffset")
            .or_else(|| get_field(row, "qcon_offset"))
            .or_else(|| get_field(row, "offset"))
            .and_then(value_to_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);
    }

    let object_space_n = rows
        .first()
        .map(|r| get_correct_refractive_index(r, wavelength_um))
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(1.0);

    (
        PackedMeta {
            row_meta,
            row_params,
            row_origins,
            row_inv_rots,
            row_rots,
            row_count: rows.len(),
        },
        object_space_n,
    )
}

fn trace_distortion_chief_y_mm(
    rows: &[Value],
    packed: &PackedMeta,
    n_start: f64,
    wavelength_um: f64,
    stop_surface_index: usize,
    target_surface_index: usize,
    field_value: f64,
    height_mode: bool,
    finite: bool,
    object_distance: f64,
) -> Option<f64> {
    let stop_base = stop_surface_index * 3;
    if stop_base + 2 >= packed.row_origins.len() {
        return None;
    }
    let stop_center = [
        packed.row_origins[stop_base],
        packed.row_origins[stop_base + 1],
        packed.row_origins[stop_base + 2],
    ];

    if finite {
        let h_obj = if height_mode {
            field_value
        } else {
            object_distance * field_value.to_radians().tan()
        };
        let start = [0.0_f64, h_obj, -object_distance.abs().max(1e-6)];
        let dir = normalize3(
            stop_center[0] - start[0],
            stop_center[1] - start[1],
            stop_center[2] - start[2],
        );
        let ray = [start[0], start[1], start[2], dir[0], dir[1], dir[2]];
        let hit = trace_single_ray_hit_point_with_meta_core(
            &ray,
            target_surface_index,
            n_start,
            &packed.row_meta,
            &packed.row_params,
            &packed.row_origins,
            &packed.row_inv_rots,
            &packed.row_rots,
            packed.row_count,
        );
        if (hit[0] - 1.0).abs() > f64::EPSILON || !hit[3].is_finite() {
            return None;
        }
        return Some(hit[3]);
    }

    // Infinite-conjugate angle mode.
    // Try multiple origin initializations, then refine each candidate toward stop center.
    let object_plane_z = packed.row_origins.get(2).copied().unwrap_or(0.0);
    let dir = build_direction_from_field_angles_native(0.0, field_value);
    let dummy_obj = Map::<String, Value>::new();
    let object_z = resolve_infinite_object_z_native(rows, &dummy_obj, object_plane_z, stop_center[2]);

    let trace_target_y = |origin: [f64; 3]| -> Option<f64> {
        let ray = [origin[0], origin[1], origin[2], dir[0], dir[1], dir[2]];
        let hit = trace_single_ray_hit_point_with_meta_core(
            &ray,
            target_surface_index,
            n_start,
            &packed.row_meta,
            &packed.row_params,
            &packed.row_origins,
            &packed.row_inv_rots,
            &packed.row_rots,
            packed.row_count,
        );
        if (hit[0] - 1.0).abs() > f64::EPSILON || !hit[3].is_finite() {
            return None;
        }
        Some(hit[3])
    };

    // Use the same continuity-aware chief-ray origin solver as the image-height
    // path before trying the legacy independent candidates below. Wide-angle
    // retrofocus systems have a strongly displaced entrance pupil; the legacy
    // seeds can lose the physical stop-center branch and then force the caller
    // to mix in render-ray fallbacks, which appears as a kink in distortion.
    if let Some(exact_origin) = find_infinite_system_chief_ray_origin_exact_native(
        rows,
        packed,
        n_start,
        wavelength_um,
        stop_surface_index,
        stop_center,
        dir,
    ) {
        if let Some(y) = trace_target_y(exact_origin) {
            return Some(y);
        }
    }

    let mut candidate_origins: Vec<[f64; 3]> = Vec::new();

    // Candidate A: tiny nominal tan-offset (legacy behavior).
    let init_y = field_value.to_radians().tan() * 1.0;
    let init_sag = compute_object_surface_sag_native(rows, 0.0, init_y);
    candidate_origins.push([0.0_f64, init_y, object_z + init_sag]);

    // Candidate B: geometric angle optimization toward stop center.
    let opt_xy = optimize_angle_object_position_native(0.0, field_value, stop_center, object_z);
    let opt_sag = compute_object_surface_sag_native(rows, opt_xy[0], opt_xy[1]);
    candidate_origins.push([opt_xy[0], opt_xy[1], object_z + opt_sag]);

    // Candidate C: entrance-center estimate.
    let entrance_origin = estimate_entrance_center_origin_native(rows, &packed.row_origins, stop_center, dir);
    if entrance_origin[0].is_finite() && entrance_origin[1].is_finite() && entrance_origin[2].is_finite() {
        candidate_origins.push(entrance_origin);
    }

    for initial_origin in candidate_origins {
        let refined_origin = solve_ray_origin_to_stop_point_fast_native(
            initial_origin,
            dir,
            stop_center,
            stop_surface_index,
            packed,
            n_start,
        ).unwrap_or(initial_origin);

        if let Some(y) = trace_target_y(refined_origin) {
            return Some(y);
        }
        if let Some(y) = trace_target_y(initial_origin) {
            return Some(y);
        }
    }

    // Final rescue: grid+brent search used by OPD path for difficult high-angle fields.
    let entrance_radius = estimate_entrance_radius_from_rows(rows).clamp(0.01, 500.0);
    if let Some(grid_origin) = search_entrance_origin_grid_brent_native(
        rows,
        &packed.row_origins,
        stop_center,
        dir,
        stop_surface_index,
        packed,
        n_start,
        entrance_radius,
    ) {
        let refined_origin = solve_ray_origin_to_stop_point_fast_native(
            grid_origin,
            dir,
            stop_center,
            stop_surface_index,
            packed,
            n_start,
        ).unwrap_or(grid_origin);
        if let Some(y) = trace_target_y(refined_origin) {
            return Some(y);
        }
        if let Some(y) = trace_target_y(grid_origin) {
            return Some(y);
        }
    }

    None
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

fn resolve_infinite_object_z_native(rows: &[Value], obj: &Map<String, Value>, object_plane_z: f64, stop_center_z: f64) -> f64 {
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
        let mut system_length = 0.0_f64;
        for row in rows {
            let thickness = get_safe_thickness(row);
            if thickness.is_finite() && thickness.abs() < 1.0e6 {
                system_length += thickness.abs();
            }
        }

        let stop_z = if stop_center_z.is_finite() { stop_center_z.abs() } else { object_plane_z.abs() };

        -100.0_f64.max(system_length * 2.0).max(stop_z + 100.0)
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

    // Match the JS OPD entrance-pupil path: it first tries a launch plane only 10 mm
    // in front of the first physical surface, then falls back to farther planes.
    // Starting 50 mm away here over-expands the effective pupil for fast lenses and
    // drives large OPD errors even on-axis for ImageHeight-derived fields.
    let plane_z = if first_surface_z.is_finite() {
        first_surface_z - 10.0
    } else {
        stop_center[2] - 10.0
    };
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
    let tol_mm = 1e-9;
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
        None
    }
}

fn solve_chief_ray_origin_by_newton2d_native(
    initial_origin: [f64; 3],
    direction: [f64; 3],
    stop_target: [f64; 3],
    stop_surface_index: usize,
    packed: &PackedMeta,
    n_start: f64,
    dynamic_half_range: f64,
) -> Option<[f64; 3]> {
    let dir = normalize3(direction[0], direction[1], direction[2]);
    if !dir[0].is_finite() || !dir[1].is_finite() || !dir[2].is_finite() {
        return None;
    }

    let mut x = initial_origin[0];
    let mut y = initial_origin[1];
    let z = initial_origin[2];
    if !x.is_finite() || !y.is_finite() || !z.is_finite() {
        return None;
    }

    let mut best = [x, y, z];
    let mut best_error = f64::INFINITY;
    let tol = 1.0e-6;

    for _ in 0..40 {
        let Some(hit0) = trace_hit_xy_with_packed([x, y, z, dir[0], dir[1], dir[2]], stop_surface_index, n_start, packed) else {
            return None;
        };

        let fx = hit0[0] - stop_target[0];
        let fy = hit0[1] - stop_target[1];
        let center_error = (fx * fx + fy * fy).sqrt();
        if center_error < best_error {
            best_error = center_error;
            best = [x, y, z];
        }
        if center_error <= tol {
            return Some(best);
        }

        let eps = (1.0e-3 * (1.0 + center_error)).max(1.0e-4);
        let Some(hit_x) = trace_hit_xy_with_packed([x + eps, y, z, dir[0], dir[1], dir[2]], stop_surface_index, n_start, packed) else {
            return if best_error < 1.0e-3 { Some(best) } else { None };
        };
        let Some(hit_y) = trace_hit_xy_with_packed([x, y + eps, z, dir[0], dir[1], dir[2]], stop_surface_index, n_start, packed) else {
            return if best_error < 1.0e-3 { Some(best) } else { None };
        };

        let j11 = (hit_x[0] - hit0[0]) / eps;
        let j21 = (hit_x[1] - hit0[1]) / eps;
        let j12 = (hit_y[0] - hit0[0]) / eps;
        let j22 = (hit_y[1] - hit0[1]) / eps;
        let det = j11 * j22 - j12 * j21;

        let (mut dx, mut dy) = if !det.is_finite() || det.abs() < 1.0e-14 {
            (-0.25 * fx, -0.25 * fy)
        } else {
            ((-j22 * fx + j12 * fy) / det, (j21 * fx - j11 * fy) / det)
        };

        if !dx.is_finite() || !dy.is_finite() {
            return if best_error < 1.0e-3 { Some(best) } else { None };
        }

        let max_step = 0.5_f64.max(dynamic_half_range * 0.05);
        let step_norm = (dx * dx + dy * dy).sqrt();
        if step_norm > max_step {
            let scale = max_step / step_norm;
            dx *= scale;
            dy *= scale;
        }

        let mut accepted = false;
        let mut alpha = 1.0;
        for _ in 0..10 {
            let nx = x + alpha * dx;
            let ny = y + alpha * dy;
            if let Some(next_hit) = trace_hit_xy_with_packed([nx, ny, z, dir[0], dir[1], dir[2]], stop_surface_index, n_start, packed) {
                let ex = next_hit[0] - stop_target[0];
                let ey = next_hit[1] - stop_target[1];
                let next_error = (ex * ex + ey * ey).sqrt();
                if next_error < center_error {
                    x = nx;
                    y = ny;
                    accepted = true;
                    break;
                }
            }
            alpha *= 0.5;
        }

        if !accepted {
            return if best_error < 1.0e-3 { Some(best) } else { None };
        }
    }

    if best_error < 1.0e-3 {
        Some(best)
    } else {
        None
    }
}

fn trace_surface_local_with_packed(
    ray: [f64; 6],
    target_surface_index: usize,
    n_start: f64,
    packed: &PackedMeta,
) -> Option<[f64; 3]> {
    let hit = trace_single_ray_hit_point_with_meta_core(
        &ray,
        target_surface_index,
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
    if !hit[2].is_finite() || !hit[3].is_finite() || !hit[4].is_finite() {
        return None;
    }

    let base = target_surface_index.saturating_mul(3);
    let rot_base = target_surface_index.saturating_mul(9);
    if base + 2 >= packed.row_origins.len() || rot_base + 8 >= packed.row_inv_rots.len() {
        return None;
    }

    let rel = [
        hit[2] - packed.row_origins[base],
        hit[3] - packed.row_origins[base + 1],
        hit[4] - packed.row_origins[base + 2],
    ];
    let inv = [
        packed.row_inv_rots[rot_base],
        packed.row_inv_rots[rot_base + 1],
        packed.row_inv_rots[rot_base + 2],
        packed.row_inv_rots[rot_base + 3],
        packed.row_inv_rots[rot_base + 4],
        packed.row_inv_rots[rot_base + 5],
        packed.row_inv_rots[rot_base + 6],
        packed.row_inv_rots[rot_base + 7],
        packed.row_inv_rots[rot_base + 8],
    ];
    Some(mul_mat3_vec3(&inv, rel))
}

fn solve_ray_direction_to_stop_point_fast_native(
    center_point: [f64; 3],
    stop_target: [f64; 3],
    stop_surface_index: usize,
    packed: &PackedMeta,
    n_start: f64,
    initial_direction: [f64; 3],
) -> Option<[f64; 3]> {
    let dx0 = stop_target[0] - center_point[0];
    let dy0 = stop_target[1] - center_point[1];
    let dz0 = stop_target[2] - center_point[2];
    if !dx0.is_finite() || !dy0.is_finite() || !dz0.is_finite() || dz0.abs() < 1e-9 {
        return None;
    }

    let z_sign = if dz0 >= 0.0 { 1.0 } else { -1.0 };
    let build_dir_from_slopes = |u: f64, v: f64| normalize3(u, v, z_sign);

    let initial = normalize3(initial_direction[0], initial_direction[1], initial_direction[2]);
    let mut u = if initial[2].abs() > 1e-9 { initial[0] / initial[2] } else { 0.0 };
    let mut v = if initial[2].abs() > 1e-9 { initial[1] / initial[2] } else { 0.0 };
    let slope_guess = (dx0 / dz0).abs().max((dy0 / dz0).abs()).max(0.0);
    let max_slope = 3.0_f64.max((slope_guess * 4.0 + 1.5).min(10.0));
    let tol_mm = 1e-3;
    let eps = 1e-4;
    let max_newton_step = 0.5_f64.max((0.25 * max_slope).min(2.0));
    let mut best_dir = build_dir_from_slopes(u, v);
    let mut best_err = f64::INFINITY;

    for _ in 0..14 {
        u = u.clamp(-max_slope, max_slope);
        v = v.clamp(-max_slope, max_slope);

        let dir = build_dir_from_slopes(u, v);
        let hit = trace_hit_xy_with_packed(
            [center_point[0], center_point[1], center_point[2], dir[0], dir[1], dir[2]],
            stop_surface_index,
            n_start,
            packed,
        );
        let Some(hit0) = hit else {
            u *= 0.8;
            v *= 0.8;
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
            best_dir = dir;
        }
        if err < tol_mm {
            return Some(dir);
        }

        let dir_u = build_dir_from_slopes(u + eps, v);
        let dir_v = build_dir_from_slopes(u, v + eps);
        let hit_u = trace_hit_xy_with_packed(
            [center_point[0], center_point[1], center_point[2], dir_u[0], dir_u[1], dir_u[2]],
            stop_surface_index,
            n_start,
            packed,
        );
        let hit_v = trace_hit_xy_with_packed(
            [center_point[0], center_point[1], center_point[2], dir_v[0], dir_v[1], dir_v[2]],
            stop_surface_index,
            n_start,
            packed,
        );

        if hit_u.is_none() || hit_v.is_none() {
            u -= 0.03 * ex;
            v -= 0.03 * ey;
            continue;
        }

        let hu = hit_u.unwrap_or(hit0);
        let hv = hit_v.unwrap_or(hit0);
        let j11 = (hu[0] - hit0[0]) / eps;
        let j21 = (hu[1] - hit0[1]) / eps;
        let j12 = (hv[0] - hit0[0]) / eps;
        let j22 = (hv[1] - hit0[1]) / eps;
        if !j11.is_finite() || !j12.is_finite() || !j21.is_finite() || !j22.is_finite() {
            u -= 0.03 * ex;
            v -= 0.03 * ey;
            continue;
        }

        let det = j11 * j22 - j12 * j21;
        if !det.is_finite() || det.abs() < 1e-14 {
            u -= 0.05 * ex;
            v -= 0.05 * ey;
            continue;
        }

        let mut du = (-j22 * ex + j12 * ey) / det;
        let mut dv = (j21 * ex - j11 * ey) / det;
        let step_norm = (du * du + dv * dv).sqrt();
        if step_norm > max_newton_step {
            let scale = max_newton_step / step_norm;
            du *= scale;
            dv *= scale;
        }
        u += du;
        v += dv;
    }

    if best_err.is_finite() {
        Some(best_dir)
    } else {
        None
    }
}

fn find_infinite_system_chief_ray_origin_exact_native(
    rows: &[Value],
    packed_stop: &PackedMeta,
    n_start: f64,
    wavelength_um: f64,
    stop_surface_index: usize,
    stop_center: [f64; 3],
    direction: [f64; 3],
) -> Option<[f64; 3]> {
    let family_key = build_chief_ray_origin_seed_family_key_native(
        stop_center,
        stop_surface_index,
        packed_stop.row_count,
        wavelength_um,
    );
    let object_plane_z = packed_stop.row_origins.get(2).copied().unwrap_or(0.0);
    let dummy_obj = Map::<String, Value>::new();
    let object_z = resolve_infinite_object_z_native(rows, &dummy_obj, object_plane_z, stop_center[2]);
    let safe_k = if direction[2].abs() > 1e-12 {
        direction[2]
    } else if direction[2].is_sign_negative() {
        -1e-12
    } else {
        1e-12
    };
    let dz_to_stop = stop_center[2] - object_z;
    let guess_x = stop_center[0] - (direction[0] / safe_k) * dz_to_stop;
    let guess_y = stop_center[1] - (direction[1] / safe_k) * dz_to_stop;
    let guess_origin = [
        guess_x,
        guess_y,
        object_z + compute_object_surface_sag_native(rows, guess_x, guess_y),
    ];
    let angle_x_deg = direction[0].atan2(direction[2].abs().max(1e-12)) * 180.0 / std::f64::consts::PI;
    let angle_y_deg = direction[1].atan2(direction[2].abs().max(1e-12)) * 180.0 / std::f64::consts::PI;
    let stop_radius_guess = estimate_stop_radius_from_row(&rows[stop_surface_index]).max(10.0);
    let guess_abs = guess_x.abs().max(guess_y.abs());
    let dynamic_half_range = 50.0_f64.max(guess_abs + 2.0 * stop_radius_guess + 10.0);
    let optimized_xy = optimize_angle_object_position_native(angle_x_deg, angle_y_deg, stop_center, object_z);
    let entrance_origin = estimate_entrance_center_origin_native(rows, &packed_stop.row_origins, stop_center, direction);
    let nearby_seed = get_nearby_chief_ray_origin_seed_native(&family_key, direction);
    let mut candidate_origins = Vec::with_capacity(4);
    if let Some(seed) = nearby_seed {
        candidate_origins.push(seed);
    }
    candidate_origins.push(guess_origin);
    candidate_origins.push([
        optimized_xy[0],
        optimized_xy[1],
        object_z + compute_object_surface_sag_native(rows, optimized_xy[0], optimized_xy[1]),
    ]);
    candidate_origins.push(entrance_origin);

    let mut best_origin: Option<[f64; 3]> = None;
    let mut best_error = f64::INFINITY;

    let mut batch_initial_origins = Vec::with_capacity(candidate_origins.len() * 3);
    let mut batch_dirs = Vec::with_capacity(candidate_origins.len() * 3);
    let mut batch_targets = Vec::with_capacity(candidate_origins.len() * 3);
    let mut batch_count = 0usize;

    for &candidate_origin in &candidate_origins {
        if !candidate_origin[0].is_finite() || !candidate_origin[1].is_finite() || !candidate_origin[2].is_finite() {
            continue;
        }
        batch_initial_origins.extend_from_slice(&candidate_origin);
        batch_dirs.extend_from_slice(&direction);
        batch_targets.extend_from_slice(&stop_center);
        batch_count += 1;
    }

    if batch_count > 0 {
        let solved_batch = solve_ray_origins_to_stop_points_with_meta_batch(
            &batch_initial_origins,
            &batch_dirs,
            &batch_targets,
            batch_count,
            stop_surface_index,
            wavelength_um,
            n_start,
            &packed_stop.row_meta,
            &packed_stop.row_params,
            &packed_stop.row_origins,
            &packed_stop.row_inv_rots,
            &packed_stop.row_rots,
            packed_stop.row_count,
            24,
            1.0e-6,
            1.0e-3,
            10.0,
        );

        for i in 0..batch_count {
            let b = i * 4;
            if solved_batch.len() < b + 4 || (solved_batch[b + 3] - 1.0).abs() > f64::EPSILON {
                continue;
            }
            let solved_origin = [solved_batch[b], solved_batch[b + 1], solved_batch[b + 2]];
            let Some(hit_xy) = trace_hit_xy_with_packed(
                [
                    solved_origin[0], solved_origin[1], solved_origin[2],
                    direction[0], direction[1], direction[2],
                ],
                stop_surface_index,
                n_start,
                packed_stop,
            ) else {
                continue;
            };
            let error = ((hit_xy[0] - stop_center[0]).powi(2) + (hit_xy[1] - stop_center[1]).powi(2)).sqrt();
            if error < best_error {
                best_error = error;
                best_origin = Some(solved_origin);
            }
            if error <= 1.0e-3 {
                store_chief_ray_origin_seed_native(&family_key, direction, solved_origin);
                return Some(solved_origin);
            }
        }
    }

    if let Some(seed) = nearby_seed {
        if let Some(newton_origin) = solve_chief_ray_origin_by_newton2d_native(
            seed,
            direction,
            stop_center,
            stop_surface_index,
            packed_stop,
            n_start,
            dynamic_half_range,
        ) {
            store_chief_ray_origin_seed_native(&family_key, direction, newton_origin);
            return Some(newton_origin);
        }
    }
    if let Some(newton_origin) = solve_chief_ray_origin_by_newton2d_native(
        guess_origin,
        direction,
        stop_center,
        stop_surface_index,
        packed_stop,
        n_start,
        dynamic_half_range,
    ) {
        store_chief_ray_origin_seed_native(&family_key, direction, newton_origin);
        return Some(newton_origin);
    }
    if let Some(grid_origin) = search_entrance_origin_grid_brent_native(
        rows,
        &packed_stop.row_origins,
        stop_center,
        direction,
        stop_surface_index,
        packed_stop,
        n_start,
        stop_radius_guess,
    ) {
        if let Some(refined_grid_origin) = solve_chief_ray_origin_by_newton2d_native(
            grid_origin,
            direction,
            stop_center,
            stop_surface_index,
            packed_stop,
            n_start,
            dynamic_half_range,
        ).or(Some(grid_origin)) {
            store_chief_ray_origin_seed_native(&family_key, direction, refined_grid_origin);
            return Some(refined_grid_origin);
        }
    }

    for &candidate_origin in &candidate_origins {
        if !candidate_origin[0].is_finite() || !candidate_origin[1].is_finite() || !candidate_origin[2].is_finite() {
            continue;
        }
        let Some(refined_origin) = solve_ray_origin_to_stop_point_fast_native(
            candidate_origin,
            direction,
            stop_center,
            stop_surface_index,
            packed_stop,
            n_start,
        ) else {
            continue;
        };

        let Some(hit_xy) = trace_hit_xy_with_packed(
            [
                refined_origin[0], refined_origin[1], refined_origin[2],
                direction[0], direction[1], direction[2],
            ],
            stop_surface_index,
            n_start,
            packed_stop,
        ) else {
            continue;
        };

        let error = ((hit_xy[0] - stop_center[0]).powi(2) + (hit_xy[1] - stop_center[1]).powi(2)).sqrt();
        if error < best_error {
            best_error = error;
            best_origin = Some(refined_origin);
        }
        if error <= 1e-3 {
            store_chief_ray_origin_seed_native(&family_key, direction, refined_origin);
            return Some(refined_origin);
        }
    }

    if best_error <= 5e-3 {
        if let Some(origin) = best_origin {
            store_chief_ray_origin_seed_native(&family_key, direction, origin);
        }
        best_origin
    } else {
        None
    }
}

fn trace_image_height_infinite_candidate_local_exact_native(
    rows: &[Value],
    packed_stop: &PackedMeta,
    packed_target: &PackedMeta,
    n_start: f64,
    wavelength_um: f64,
    stop_surface_index: usize,
    target_surface_index: usize,
    stop_center: [f64; 3],
    angle_x_deg: f64,
    angle_y_deg: f64,
) -> Option<[f64; 3]> {
    let nominal_direction = build_direction_from_field_angles_native(angle_x_deg, angle_y_deg);
    let origin = find_infinite_system_chief_ray_origin_exact_native(
        rows,
        packed_stop,
        n_start,
        wavelength_um,
        stop_surface_index,
        stop_center,
        nominal_direction,
    )?;

    let refined_direction = solve_ray_direction_to_stop_point_fast_native(
        origin,
        stop_center,
        stop_surface_index,
        packed_stop,
        n_start,
        nominal_direction,
    ).unwrap_or(nominal_direction);

    let mut trace_origin = find_infinite_system_chief_ray_origin_exact_native(
        rows,
        packed_stop,
        n_start,
        wavelength_um,
        stop_surface_index,
        stop_center,
        refined_direction,
    ).unwrap_or(origin);

    if let Some(polished_origin) = solve_ray_origin_to_stop_point_fast_native(
        trace_origin,
        refined_direction,
        stop_center,
        stop_surface_index,
        packed_stop,
        n_start,
    ) {
        trace_origin = polished_origin;
    }

    trace_surface_local_with_packed(
        [
            trace_origin[0], trace_origin[1], trace_origin[2],
            refined_direction[0], refined_direction[1], refined_direction[2],
        ],
        target_surface_index,
        n_start,
        packed_target,
    )
}

fn trace_image_height_infinite_chief_ray_exact_native(
    rows: &[Value],
    packed_stop: &PackedMeta,
    packed_target: &PackedMeta,
    n_start: f64,
    wavelength_um: f64,
    stop_surface_index: usize,
    target_surface_index: usize,
    stop_center: [f64; 3],
    angle_x_deg: f64,
    angle_y_deg: f64,
) -> Option<([f64; 3], [f64; 3], [f64; 3])> {
    let nominal_direction = build_direction_from_field_angles_native(angle_x_deg, angle_y_deg);
    let origin = find_infinite_system_chief_ray_origin_exact_native(
        rows,
        packed_stop,
        n_start,
        wavelength_um,
        stop_surface_index,
        stop_center,
        nominal_direction,
    )?;

    let refined_direction = solve_ray_direction_to_stop_point_fast_native(
        origin,
        stop_center,
        stop_surface_index,
        packed_stop,
        n_start,
        nominal_direction,
    ).unwrap_or(nominal_direction);

    let mut trace_origin = find_infinite_system_chief_ray_origin_exact_native(
        rows,
        packed_stop,
        n_start,
        wavelength_um,
        stop_surface_index,
        stop_center,
        refined_direction,
    ).unwrap_or(origin);

    if let Some(polished_origin) = solve_ray_origin_to_stop_point_fast_native(
        trace_origin,
        refined_direction,
        stop_center,
        stop_surface_index,
        packed_stop,
        n_start,
    ) {
        trace_origin = polished_origin;
    }

    let local_hit = trace_surface_local_with_packed(
        [
            trace_origin[0], trace_origin[1], trace_origin[2],
            refined_direction[0], refined_direction[1], refined_direction[2],
        ],
        target_surface_index,
        n_start,
        packed_target,
    )?;

    Some((trace_origin, refined_direction, local_hit))
}

fn trace_image_height_infinite_candidate_local_native(
    rows: &[Value],
    packed_stop: &PackedMeta,
    packed_target: &PackedMeta,
    n_start: f64,
    stop_surface_index: usize,
    target_surface_index: usize,
    stop_center: [f64; 3],
    angle_x_deg: f64,
    angle_y_deg: f64,
) -> Option<[f64; 3]> {
    let object_plane_z = packed_target.row_origins.get(2).copied().unwrap_or(0.0);
    let dummy_obj = Map::<String, Value>::new();
    let object_z = resolve_infinite_object_z_native(rows, &dummy_obj, object_plane_z, stop_center[2]);
    let direction = build_direction_from_field_angles_native(angle_x_deg, angle_y_deg);

    let nominal_x = angle_x_deg.to_radians().tan();
    let nominal_y = angle_y_deg.to_radians().tan();
    let nominal_sag = compute_object_surface_sag_native(rows, nominal_x, nominal_y);
    let optimized_xy = optimize_angle_object_position_native(angle_x_deg, angle_y_deg, stop_center, object_z);
    let optimized_sag = compute_object_surface_sag_native(rows, optimized_xy[0], optimized_xy[1]);
    let entrance_origin = estimate_entrance_center_origin_native(rows, &packed_target.row_origins, stop_center, direction);

    let mut candidate_origins = vec![
        [nominal_x, nominal_y, object_z + nominal_sag],
        [optimized_xy[0], optimized_xy[1], object_z + optimized_sag],
    ];
    if entrance_origin[0].is_finite() && entrance_origin[1].is_finite() && entrance_origin[2].is_finite() {
        candidate_origins.push(entrance_origin);
    }

    for initial_origin in candidate_origins {
        let Some(refined_origin) = solve_ray_origin_to_stop_point_fast_native(
            initial_origin,
            direction,
            stop_center,
            stop_surface_index,
            packed_stop,
            n_start,
        ) else {
            continue;
        };
        let Some(refined_direction) = solve_ray_direction_to_stop_point_fast_native(
            refined_origin,
            stop_center,
            stop_surface_index,
            packed_stop,
            n_start,
            direction,
        ) else {
            continue;
        };

        if let Some(local_hit) = trace_surface_local_with_packed(
            [
                refined_origin[0], refined_origin[1], refined_origin[2],
                refined_direction[0], refined_direction[1], refined_direction[2],
            ],
            target_surface_index,
            n_start,
            packed_target,
        ) {
            return Some(local_hit);
        }

    }

    let entrance_radius = estimate_entrance_radius_from_rows(rows).clamp(0.01, 500.0);
    if let Some(grid_origin) = search_entrance_origin_grid_brent_native(
        rows,
        &packed_target.row_origins,
        stop_center,
        direction,
        stop_surface_index,
        packed_stop,
        n_start,
        entrance_radius,
    ) {
        let Some(refined_origin) = solve_ray_origin_to_stop_point_fast_native(
            grid_origin,
            direction,
            stop_center,
            stop_surface_index,
            packed_stop,
            n_start,
        ) else {
            return None;
        };
        let Some(refined_direction) = solve_ray_direction_to_stop_point_fast_native(
            refined_origin,
            stop_center,
            stop_surface_index,
            packed_stop,
            n_start,
            direction,
        ) else {
            return None;
        };

        if let Some(local_hit) = trace_surface_local_with_packed(
            [
                refined_origin[0], refined_origin[1], refined_origin[2],
                refined_direction[0], refined_direction[1], refined_direction[2],
            ],
            target_surface_index,
            n_start,
            packed_target,
        ) {
            return Some(local_hit);
        }
    }

    None
}

fn trace_image_height_finite_candidate_local_native(
    rows: &[Value],
    packed_stop: &PackedMeta,
    packed_target: &PackedMeta,
    n_start: f64,
    stop_surface_index: usize,
    target_surface_index: usize,
    stop_center: [f64; 3],
    object_x: f64,
    object_y: f64,
) -> Option<[f64; 3]> {
    let first_surface_z = packed_target.row_origins.get(2).copied().unwrap_or(0.0);
    let object_sag = compute_object_surface_sag_native(rows, object_x, object_y);
    let object_point = [object_x, object_y, first_surface_z + object_sag];
    let initial_direction = normalize3(
        stop_center[0] - object_point[0],
        stop_center[1] - object_point[1],
        stop_center[2] - object_point[2],
    );
    let direction = solve_ray_direction_to_stop_point_fast_native(
        object_point,
        stop_center,
        stop_surface_index,
        packed_stop,
        n_start,
        initial_direction,
    )?;

    trace_surface_local_with_packed(
        [
            object_point[0], object_point[1], object_point[2],
            direction[0], direction[1], direction[2],
        ],
        target_surface_index,
        n_start,
        packed_target,
    )
}

fn solve_image_height_component_native<F>(
    target_value: f64,
    initial_guess: f64,
    component_index: usize,
    initial_step: f64,
    max_step: f64,
    mut evaluate_candidate: F,
) -> Option<(f64, [f64; 3])>
where
    F: FnMut(f64) -> Option<[f64; 3]>,
{
    let target = if target_value.is_finite() { target_value } else { 0.0 };
    if target.abs() < 1e-12 {
        let hit = evaluate_candidate(0.0)?;
        return Some((0.0, hit));
    }

    let finite_initial = if initial_guess.is_finite() { initial_guess } else { 0.0 };
    let mut best_candidate = finite_initial;
    let mut best_hit: Option<[f64; 3]> = None;
    let mut best_error = f64::INFINITY;

    let mut sample = |candidate: f64| -> Option<(f64, f64, [f64; 3])> {
        let hit = evaluate_candidate(candidate)?;
        let value = if component_index == 0 { hit[0] } else { hit[1] };
        if !value.is_finite() {
            return None;
        }
        let error = value - target;
        let abs_error = error.abs();
        if abs_error < best_error {
            best_error = abs_error;
            best_candidate = candidate;
            best_hit = Some(hit);
        }
        Some((candidate, error, hit))
    };

    let center = sample(finite_initial).or_else(|| sample(0.0));
    if let Some((candidate, error, hit)) = center {
        if error.abs() < 1e-6 {
            return Some((candidate, hit));
        }
    }

    let base_step = if initial_step.is_finite() && initial_step > 0.0 {
        initial_step
    } else {
        (finite_initial.abs() * 0.05).max(target.abs() * 0.02).max(0.1)
    };
    let max_step_value = if max_step.is_finite() && max_step > base_step {
        max_step
    } else {
        (base_step * 32.0).max(finite_initial.abs() * 2.0).max(target.abs() * 0.5).max(1.0)
    };

    let mut bracket_low: Option<(f64, f64, [f64; 3])> = None;
    let mut bracket_high: Option<(f64, f64, [f64; 3])> = None;
    let mut prev_neg = sample(finite_initial - base_step);
    let mut prev_pos = sample(finite_initial + base_step);

    if let (Some(neg), Some(c)) = (prev_neg, center) {
        if neg.1 * c.1 <= 0.0 {
            bracket_low = Some(neg);
            bracket_high = Some(c);
        }
    }
    if bracket_low.is_none() {
        if let (Some(c), Some(pos)) = (center, prev_pos) {
            if c.1 * pos.1 <= 0.0 {
                bracket_low = Some(c);
                bracket_high = Some(pos);
            }
        }
    }

    let mut step_index = 2usize;
    while (bracket_low.is_none() || bracket_high.is_none()) && step_index <= 32 {
        let span = max_step_value.min(base_step * step_index as f64);
        let neg = sample(finite_initial - span);
        if let (Some(n), Some(prev)) = (neg, prev_neg) {
            if n.1 * prev.1 <= 0.0 {
                bracket_low = Some(n);
                bracket_high = Some(prev);
                break;
            }
            prev_neg = Some(n);
        }

        let pos = sample(finite_initial + span);
        if let (Some(p), Some(prev)) = (pos, prev_pos) {
            if prev.1 * p.1 <= 0.0 {
                bracket_low = Some(prev);
                bracket_high = Some(p);
                break;
            }
            prev_pos = Some(p);
        }
        step_index += 1;
    }

    if let (Some(mut low), Some(mut high)) = (bracket_low, bracket_high) {
        if low.0 > high.0 {
            std::mem::swap(&mut low, &mut high);
        }
        let mut low_candidate = low.0;
        let mut high_candidate = high.0;
        let mut low_error = low.1;
        let mut high_error = high.1;

        for _ in 0..32 {
            let mid = 0.5 * (low_candidate + high_candidate);
            let sample_mid = sample(mid);
            let Some(mid_sample) = sample_mid else {
                break;
            };
            if mid_sample.1.abs() < 1e-6 {
                return Some((mid_sample.0, mid_sample.2));
            }
            if low_error * mid_sample.1 <= 0.0 {
                high_candidate = mid_sample.0;
                high_error = mid_sample.1;
            } else {
                low_candidate = mid_sample.0;
                low_error = mid_sample.1;
            }
        }
    }

    best_hit.map(|hit| (best_candidate, hit))
}

fn solve_image_height_pair_component_x_native<F>(
    target_x: f64,
    initial_x: f64,
    fixed_y: f64,
    initial_step: f64,
    max_step: f64,
    evaluate_pair: &mut F,
) -> Option<(f64, [f64; 3])>
where
    F: FnMut(f64, f64) -> Option<[f64; 3]>,
{
    solve_image_height_component_native(
        target_x,
        initial_x,
        0,
        initial_step,
        max_step,
        |candidate_x| evaluate_pair(candidate_x, fixed_y),
    )
}

fn solve_image_height_pair_component_y_native<F>(
    target_y: f64,
    fixed_x: f64,
    initial_y: f64,
    initial_step: f64,
    max_step: f64,
    evaluate_pair: &mut F,
) -> Option<(f64, [f64; 3])>
where
    F: FnMut(f64, f64) -> Option<[f64; 3]>,
{
    solve_image_height_component_native(
        target_y,
        initial_y,
        1,
        initial_step,
        max_step,
        |candidate_y| evaluate_pair(fixed_x, candidate_y),
    )
}

fn refine_image_height_pair_native<F>(
    initial_x: f64,
    initial_y: f64,
    target_x: f64,
    target_y: f64,
    tolerance: f64,
    max_iterations: usize,
    finite_diff_step: f64,
    max_step: f64,
    evaluate_pair: &mut F,
) -> Option<(f64, f64, [f64; 3])>
where
    F: FnMut(f64, f64) -> Option<[f64; 3]>,
{
    #[derive(Clone, Copy)]
    struct PairSample {
        x: f64,
        y: f64,
        hit: [f64; 3],
        err_x: f64,
        err_y: f64,
        error: f64,
    }

    let mut x = if initial_x.is_finite() { initial_x } else { 0.0 };
    let mut y = if initial_y.is_finite() { initial_y } else { 0.0 };
    let tol = if tolerance.is_finite() { tolerance.max(1e-8) } else { 1e-6 };
    let max_iters = max_iterations.max(1);
    let base_finite_diff_step = if finite_diff_step.is_finite() { finite_diff_step.max(1e-8) } else { 1e-4 };
    let max_step_norm = if max_step.is_finite() { max_step.max(1e-6) } else { 0.25 };
    let target_x_value = if target_x.is_finite() { target_x } else { 0.0 };
    let target_y_value = if target_y.is_finite() { target_y } else { 0.0 };
    let mut best: Option<PairSample> = None;

    let mut sample = |candidate_x: f64, candidate_y: f64| -> Option<PairSample> {
        let hit = evaluate_pair(candidate_x, candidate_y)?;
        let hit_x = hit[0];
        let hit_y = hit[1];
        if !hit_x.is_finite() || !hit_y.is_finite() {
            return None;
        }
        let err_x = hit_x - target_x_value;
        let err_y = hit_y - target_y_value;
        let error = (err_x * err_x + err_y * err_y).sqrt();
        let sample = PairSample {
            x: candidate_x,
            y: candidate_y,
            hit,
            err_x,
            err_y,
            error,
        };
        if best.map(|current| sample.error < current.error).unwrap_or(true) {
            best = Some(sample);
        }
        Some(sample)
    };

    if sample(x, y).is_none() {
        sample(0.0, 0.0);
    }

    for _ in 0..max_iters {
        let Some(center) = sample(x, y) else {
            break;
        };
        if center.error <= tol {
            return Some((center.x, center.y, center.hit));
        }

        let step_x = base_finite_diff_step.max(x.abs() * 1e-3);
        let step_y = base_finite_diff_step.max(y.abs() * 1e-3);
        let Some(sample_dx) = sample(x + step_x, y) else {
            break;
        };
        let Some(sample_dy) = sample(x, y + step_y) else {
            break;
        };

        let j11 = (sample_dx.hit[0] - center.hit[0]) / step_x;
        let j21 = (sample_dx.hit[1] - center.hit[1]) / step_x;
        let j12 = (sample_dy.hit[0] - center.hit[0]) / step_y;
        let j22 = (sample_dy.hit[1] - center.hit[1]) / step_y;
        if !j11.is_finite() || !j12.is_finite() || !j21.is_finite() || !j22.is_finite() {
            break;
        }

        let det = j11 * j22 - j12 * j21;
        if !det.is_finite() || det.abs() < 1e-14 {
            break;
        }

        let mut delta_x = (-j22 * center.err_x + j12 * center.err_y) / det;
        let mut delta_y = (j21 * center.err_x - j11 * center.err_y) / det;
        if !delta_x.is_finite() || !delta_y.is_finite() {
            break;
        }

        let delta_norm = (delta_x * delta_x + delta_y * delta_y).sqrt();
        if delta_norm > max_step_norm {
            let scale = max_step_norm / delta_norm;
            delta_x *= scale;
            delta_y *= scale;
        }

        let mut accepted = false;
        let mut alpha = 1.0;
        for _ in 0..8 {
            let Some(next) = sample(x + alpha * delta_x, y + alpha * delta_y) else {
                alpha *= 0.5;
                continue;
            };
            if next.error < center.error {
                x = next.x;
                y = next.y;
                accepted = true;
                break;
            }
            alpha *= 0.5;
        }
        if !accepted {
            break;
        }
    }

    best.map(|sample| (sample.x, sample.y, sample.hit))
}

fn solve_image_height_pair_native<F>(
    target_x: f64,
    target_y: f64,
    initial_x: f64,
    initial_y: f64,
    conjugate_mode: i32,
    evaluate_pair: &mut F,
) -> Option<(f64, f64, [f64; 3])>
where
    F: FnMut(f64, f64) -> Option<[f64; 3]>,
{
    let is_infinite = conjugate_mode == 0;
    let mut solved_x = if initial_x.is_finite() { initial_x } else { 0.0 };
    let mut solved_y = if initial_y.is_finite() { initial_y } else { 0.0 };

    let initial_step_x = if is_infinite {
        0.05_f64.max(initial_x.abs() * 0.05).max(target_x.abs() * 0.005)
    } else {
        0.01_f64.max(initial_x.abs() * 0.05).max(target_x.abs() * 0.01)
    };
    let max_step_x = if is_infinite {
        2.0_f64.max(initial_x.abs() * 0.5).max(target_x.abs() * 0.05)
    } else {
        1.0_f64.max(initial_x.abs() * 0.5).max(target_x.abs() * 0.25)
    };
    let initial_step_y = if is_infinite {
        0.05_f64.max(initial_y.abs() * 0.05).max(target_y.abs() * 0.005)
    } else {
        0.01_f64.max(initial_y.abs() * 0.05).max(target_y.abs() * 0.01)
    };
    let max_step_y = if is_infinite {
        2.0_f64.max(initial_y.abs() * 0.5).max(target_y.abs() * 0.05)
    } else {
        1.0_f64.max(initial_y.abs() * 0.5).max(target_y.abs() * 0.25)
    };

    for iter in 0..4 {
        if let Some((next_x, _)) = solve_image_height_pair_component_x_native(
            target_x,
            solved_x,
            solved_y,
            initial_step_x,
            max_step_x,
            evaluate_pair,
        ) {
            solved_x = next_x;
        }
        if let Some((next_y, _)) = solve_image_height_pair_component_y_native(
            target_y,
            solved_x,
            solved_y,
            initial_step_y,
            max_step_y,
            evaluate_pair,
        ) {
            solved_y = next_y;
        }

        let Some(local_hit) = evaluate_pair(solved_x, solved_y) else {
            continue;
        };
        let err_x = (local_hit[0] - target_x).abs();
        let err_y = (local_hit[1] - target_y).abs();
        if (err_x < 1e-6 && err_y < 1e-6) || (iter > 1 && err_x < 1e-5 && err_y < 1e-5) {
            break;
        }
    }

    refine_image_height_pair_native(
        solved_x,
        solved_y,
        target_x,
        target_y,
        1e-6,
        10,
        1e-4,
        0.1,
        evaluate_pair,
    ).or_else(|| evaluate_pair(solved_x, solved_y).map(|hit| (solved_x, solved_y, hit)))
}

#[wasm_bindgen]
pub fn solve_image_height_component_with_rows(
    optical_system_rows: JsValue,
    image_surface_index: usize,
    wavelength_um: f64,
    conjugate_mode: i32,
    component_index: i32,
    target_value: f64,
    initial_guess: f64,
    fixed_value: f64,
    initial_step: f64,
    max_step: f64,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; 5]; // [status, candidate, hit_x, hit_y, hit_z]
    let Ok(rows_raw) = serde_wasm_bindgen::from_value::<Vec<Value>>(optical_system_rows) else {
        out[0] = 2.0;
        return out;
    };
    if rows_raw.is_empty() {
        out[0] = 2.0;
        return out;
    }

    let rows: Vec<Value> = rows_raw.iter().map(normalize_coord_trans_row).collect();
    let target_surface_index = image_surface_index.min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index(&rows).min(rows.len().saturating_sub(1));
    let wavelength = if wavelength_um.is_finite() && wavelength_um > 0.0 { wavelength_um } else { 0.5876 };
    let (packed_stop, n_start) = build_trace_packed_meta_for_wavelength(&rows, wavelength, stop_surface_index);
    let (packed_target, _) = build_trace_packed_meta_for_wavelength(&rows, wavelength, target_surface_index);

    let stop_base = stop_surface_index.saturating_mul(3);
    if stop_base + 2 >= packed_stop.row_origins.len() {
        out[0] = 2.0;
        return out;
    }
    let stop_center = [
        packed_stop.row_origins[stop_base],
        packed_stop.row_origins[stop_base + 1],
        packed_stop.row_origins[stop_base + 2],
    ];
    if !stop_center[0].is_finite() || !stop_center[1].is_finite() || !stop_center[2].is_finite() {
        out[0] = 2.0;
        return out;
    }

    let component = if component_index == 0 { 0usize } else { 1usize };
    let use_infinite_mode = conjugate_mode == 0;
    let solved = solve_image_height_component_native(
        target_value,
        initial_guess,
        component,
        initial_step,
        max_step,
        |candidate| {
            if use_infinite_mode {
                let angle_x = if component == 0 { candidate } else { fixed_value };
                let angle_y = if component == 1 { candidate } else { fixed_value };
                trace_image_height_infinite_candidate_local_native(
                    &rows,
                    &packed_stop,
                    &packed_target,
                    n_start,
                    stop_surface_index,
                    target_surface_index,
                    stop_center,
                    angle_x,
                    angle_y,
                )
            } else {
                let object_x = if component == 0 { candidate } else { fixed_value };
                let object_y = if component == 1 { candidate } else { fixed_value };
                trace_image_height_finite_candidate_local_native(
                    &rows,
                    &packed_stop,
                    &packed_target,
                    n_start,
                    stop_surface_index,
                    target_surface_index,
                    stop_center,
                    object_x,
                    object_y,
                )
            }
        },
    );

    if let Some((candidate, hit)) = solved {
        out[0] = 1.0;
        out[1] = candidate;
        out[2] = hit[0];
        out[3] = hit[1];
        out[4] = hit[2];
    } else {
        out[0] = 3.0;
    }
    out
}

#[wasm_bindgen]
pub fn solve_image_height_pair_with_rows(
    optical_system_rows: JsValue,
    image_surface_index: usize,
    wavelength_um: f64,
    conjugate_mode: i32,
    target_x: f64,
    target_y: f64,
    initial_x: f64,
    initial_y: f64,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; 6]; // [status, solved_x, solved_y, hit_x, hit_y, hit_z]
    let Ok(rows_raw) = serde_wasm_bindgen::from_value::<Vec<Value>>(optical_system_rows) else {
        out[0] = 2.0;
        return out;
    };
    if rows_raw.is_empty() {
        out[0] = 2.0;
        return out;
    }

    let rows: Vec<Value> = rows_raw.iter().map(normalize_coord_trans_row).collect();
    let target_surface_index = image_surface_index.min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index(&rows).min(rows.len().saturating_sub(1));
    let wavelength = if wavelength_um.is_finite() && wavelength_um > 0.0 { wavelength_um } else { 0.5876 };
    let (packed_stop, n_start) = build_trace_packed_meta_for_wavelength(&rows, wavelength, stop_surface_index);
    let (packed_target, _) = build_trace_packed_meta_for_wavelength(&rows, wavelength, target_surface_index);

    let stop_base = stop_surface_index.saturating_mul(3);
    if stop_base + 2 >= packed_stop.row_origins.len() {
        out[0] = 2.0;
        return out;
    }

    let stop_center = [
        packed_stop.row_origins[stop_base],
        packed_stop.row_origins[stop_base + 1],
        packed_stop.row_origins[stop_base + 2],
    ];
    if !stop_center[0].is_finite() || !stop_center[1].is_finite() || !stop_center[2].is_finite() {
        out[0] = 2.0;
        return out;
    }

    let solved = solve_image_height_pair_native(
        target_x,
        target_y,
        initial_x,
        initial_y,
        conjugate_mode,
        &mut |candidate_x, candidate_y| {
            if conjugate_mode == 0 {
                trace_image_height_infinite_candidate_local_native(
                    &rows,
                    &packed_stop,
                    &packed_target,
                    n_start,
                    stop_surface_index,
                    target_surface_index,
                    stop_center,
                    candidate_x,
                    candidate_y,
                )
            } else {
                trace_image_height_finite_candidate_local_native(
                    &rows,
                    &packed_stop,
                    &packed_target,
                    n_start,
                    stop_surface_index,
                    target_surface_index,
                    stop_center,
                    candidate_x,
                    candidate_y,
                )
            }
        },
    );

    let Some((solved_x, solved_y, hit)) = solved else {
        out[0] = 2.0;
        return out;
    };

    out[0] = 1.0;
    out[1] = solved_x;
    out[2] = solved_y;
    out[3] = hit[0];
    out[4] = hit[1];
    out[5] = hit[2];
    out
}

#[wasm_bindgen]
pub fn solve_image_height_pair_exact_with_rows(
    optical_system_rows: JsValue,
    image_surface_index: usize,
    wavelength_um: f64,
    conjugate_mode: i32,
    target_x: f64,
    target_y: f64,
    initial_x: f64,
    initial_y: f64,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; 6];
    let Ok(rows_raw) = serde_wasm_bindgen::from_value::<Vec<Value>>(optical_system_rows) else {
        out[0] = 2.0;
        return out;
    };
    if rows_raw.is_empty() {
        out[0] = 2.0;
        return out;
    }

    let rows: Vec<Value> = rows_raw.iter().map(normalize_coord_trans_row).collect();
    let target_surface_index = image_surface_index.min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index(&rows).min(rows.len().saturating_sub(1));
    let wavelength = if wavelength_um.is_finite() && wavelength_um > 0.0 { wavelength_um } else { 0.5876 };
    let (packed_stop, n_start) = build_trace_packed_meta_for_wavelength(&rows, wavelength, stop_surface_index);
    let (packed_target, _) = build_trace_packed_meta_for_wavelength(&rows, wavelength, target_surface_index);

    let stop_base = stop_surface_index.saturating_mul(3);
    if stop_base + 2 >= packed_stop.row_origins.len() {
        out[0] = 2.0;
        return out;
    }
    let stop_center = [
        packed_stop.row_origins[stop_base],
        packed_stop.row_origins[stop_base + 1],
        packed_stop.row_origins[stop_base + 2],
    ];
    if !stop_center[0].is_finite() || !stop_center[1].is_finite() || !stop_center[2].is_finite() {
        out[0] = 2.0;
        return out;
    }

    let solved = solve_image_height_pair_native(
        target_x,
        target_y,
        initial_x,
        initial_y,
        conjugate_mode,
        &mut |candidate_x, candidate_y| {
            if conjugate_mode == 0 {
                trace_image_height_infinite_candidate_local_exact_native(
                    &rows,
                    &packed_stop,
                    &packed_target,
                    n_start,
                    wavelength_um,
                    stop_surface_index,
                    target_surface_index,
                    stop_center,
                    candidate_x,
                    candidate_y,
                )
            } else {
                trace_image_height_finite_candidate_local_native(
                    &rows,
                    &packed_stop,
                    &packed_target,
                    n_start,
                    stop_surface_index,
                    target_surface_index,
                    stop_center,
                    candidate_x,
                    candidate_y,
                )
            }
        },
    );

    let Some((solved_x, solved_y, hit)) = solved else {
        out[0] = 2.0;
        return out;
    };

    out[0] = 1.0;
    out[1] = solved_x;
    out[2] = solved_y;
    out[3] = hit[0];
    out[4] = hit[1];
    out[5] = hit[2];
    out
}

#[wasm_bindgen]
pub fn trace_image_height_infinite_candidate_with_rows(
    optical_system_rows: JsValue,
    image_surface_index: usize,
    wavelength_um: f64,
    angle_x_deg: f64,
    angle_y_deg: f64,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; 4]; // [status, hit_x, hit_y, hit_z]
    let Ok(rows_raw) = serde_wasm_bindgen::from_value::<Vec<Value>>(optical_system_rows) else {
        return out;
    };
    if rows_raw.is_empty() {
        return out;
    }

    let rows: Vec<Value> = rows_raw.iter().map(normalize_coord_trans_row).collect();
    let target_surface_index = image_surface_index.min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index(&rows).min(rows.len().saturating_sub(1));
    let wavelength = if wavelength_um.is_finite() && wavelength_um > 0.0 { wavelength_um } else { 0.5876 };
    let (packed_stop, n_start) = build_trace_packed_meta_for_wavelength(&rows, wavelength, stop_surface_index);
    let (packed_target, _) = build_trace_packed_meta_for_wavelength(&rows, wavelength, target_surface_index);

    let stop_base = stop_surface_index.saturating_mul(3);
    if stop_base + 2 >= packed_stop.row_origins.len() {
        return out;
    }
    let stop_center = [
        packed_stop.row_origins[stop_base],
        packed_stop.row_origins[stop_base + 1],
        packed_stop.row_origins[stop_base + 2],
    ];
    if !stop_center[0].is_finite() || !stop_center[1].is_finite() || !stop_center[2].is_finite() {
        return out;
    }

    if let Some(hit) = trace_image_height_infinite_candidate_local_native(
        &rows,
        &packed_stop,
        &packed_target,
        n_start,
        stop_surface_index,
        target_surface_index,
        stop_center,
        angle_x_deg,
        angle_y_deg,
    ) {
        out[0] = 1.0;
        out[1] = hit[0];
        out[2] = hit[1];
        out[3] = hit[2];
    }
    out
}

#[wasm_bindgen]
pub fn trace_image_height_infinite_candidate_exact_with_rows(
    optical_system_rows: JsValue,
    image_surface_index: usize,
    wavelength_um: f64,
    angle_x_deg: f64,
    angle_y_deg: f64,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; 4];
    let Ok(rows_raw) = serde_wasm_bindgen::from_value::<Vec<Value>>(optical_system_rows) else {
        out[0] = 2.0;
        return out;
    };
    if rows_raw.is_empty() {
        out[0] = 2.0;
        return out;
    }

    let rows: Vec<Value> = rows_raw.iter().map(normalize_coord_trans_row).collect();
    let target_surface_index = image_surface_index.min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index(&rows).min(rows.len().saturating_sub(1));
    let wavelength = if wavelength_um.is_finite() && wavelength_um > 0.0 { wavelength_um } else { 0.5876 };
    let (packed_stop, n_start) = build_trace_packed_meta_for_wavelength(&rows, wavelength, stop_surface_index);
    let (packed_target, _) = build_trace_packed_meta_for_wavelength(&rows, wavelength, target_surface_index);

    let stop_base = stop_surface_index.saturating_mul(3);
    if stop_base + 2 >= packed_stop.row_origins.len() {
        out[0] = 2.0;
        return out;
    }
    let stop_center = [
        packed_stop.row_origins[stop_base],
        packed_stop.row_origins[stop_base + 1],
        packed_stop.row_origins[stop_base + 2],
    ];

    if let Some(hit) = trace_image_height_infinite_candidate_local_exact_native(
        &rows,
        &packed_stop,
        &packed_target,
        n_start,
        wavelength_um,
        stop_surface_index,
        target_surface_index,
        stop_center,
        angle_x_deg,
        angle_y_deg,
    ) {
        out[0] = 1.0;
        out[1] = hit[0];
        out[2] = hit[1];
        out[3] = hit[2];
    } else {
        out[0] = 3.0;
    }
    out
}

#[wasm_bindgen]
pub fn trace_image_height_infinite_chief_ray_exact_with_rows(
    optical_system_rows: JsValue,
    image_surface_index: usize,
    wavelength_um: f64,
    angle_x_deg: f64,
    angle_y_deg: f64,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; 10];
    let Ok(rows_raw) = serde_wasm_bindgen::from_value::<Vec<Value>>(optical_system_rows) else {
        out[0] = 2.0;
        return out;
    };
    if rows_raw.is_empty() {
        out[0] = 2.0;
        return out;
    }

    let rows: Vec<Value> = rows_raw.iter().map(normalize_coord_trans_row).collect();
    let target_surface_index = image_surface_index.min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index(&rows).min(rows.len().saturating_sub(1));
    let wavelength = if wavelength_um.is_finite() && wavelength_um > 0.0 { wavelength_um } else { 0.5876 };
    let (packed_stop, n_start) = build_trace_packed_meta_for_wavelength(&rows, wavelength, stop_surface_index);
    let (packed_target, _) = build_trace_packed_meta_for_wavelength(&rows, wavelength, target_surface_index);

    let stop_base = stop_surface_index.saturating_mul(3);
    if stop_base + 2 >= packed_stop.row_origins.len() {
        out[0] = 2.0;
        return out;
    }
    let stop_center = [
        packed_stop.row_origins[stop_base],
        packed_stop.row_origins[stop_base + 1],
        packed_stop.row_origins[stop_base + 2],
    ];

    if let Some((origin, direction, hit)) = trace_image_height_infinite_chief_ray_exact_native(
        &rows,
        &packed_stop,
        &packed_target,
        n_start,
        wavelength,
        stop_surface_index,
        target_surface_index,
        stop_center,
        angle_x_deg,
        angle_y_deg,
    ) {
        out[0] = 1.0;
        out[1] = origin[0];
        out[2] = origin[1];
        out[3] = origin[2];
        out[4] = direction[0];
        out[5] = direction[1];
        out[6] = direction[2];
        out[7] = hit[0];
        out[8] = hit[1];
        out[9] = hit[2];
    } else {
        out[0] = 3.0;
    }
    out
}

#[wasm_bindgen]
pub fn trace_image_height_finite_candidate_with_rows(
    optical_system_rows: JsValue,
    image_surface_index: usize,
    wavelength_um: f64,
    object_x: f64,
    object_y: f64,
) -> Vec<f64> {
    let mut out = vec![0.0_f64; 4]; // [status, hit_x, hit_y, hit_z]
    let Ok(rows_raw) = serde_wasm_bindgen::from_value::<Vec<Value>>(optical_system_rows) else {
        return out;
    };
    if rows_raw.is_empty() {
        return out;
    }

    let rows: Vec<Value> = rows_raw.iter().map(normalize_coord_trans_row).collect();
    let target_surface_index = image_surface_index.min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index(&rows).min(rows.len().saturating_sub(1));
    let wavelength = if wavelength_um.is_finite() && wavelength_um > 0.0 { wavelength_um } else { 0.5876 };
    let (packed_stop, n_start) = build_trace_packed_meta_for_wavelength(&rows, wavelength, stop_surface_index);
    let (packed_target, _) = build_trace_packed_meta_for_wavelength(&rows, wavelength, target_surface_index);

    let stop_base = stop_surface_index.saturating_mul(3);
    if stop_base + 2 >= packed_stop.row_origins.len() {
        return out;
    }
    let stop_center = [
        packed_stop.row_origins[stop_base],
        packed_stop.row_origins[stop_base + 1],
        packed_stop.row_origins[stop_base + 2],
    ];
    if !stop_center[0].is_finite() || !stop_center[1].is_finite() || !stop_center[2].is_finite() {
        return out;
    }

    if let Some(hit) = trace_image_height_finite_candidate_local_native(
        &rows,
        &packed_stop,
        &packed_target,
        n_start,
        stop_surface_index,
        target_surface_index,
        stop_center,
        object_x,
        object_y,
    ) {
        out[0] = 1.0;
        out[1] = hit[0];
        out[2] = hit[1];
        out[3] = hit[2];
    }
    out
}

fn run_native_opd_map_value_with_rows(
    req: &Value,
    normalized_optical_rows: Option<&[Value]>,
    shared_packed_meta: Option<&PackedMeta>,
) -> Result<Value, JsValue> {
    let req_obj = req.as_object().ok_or_else(|| JsValue::from_str("request must be an object"))?;

    let rows_owned;
    let rows: &[Value] = if let Some(rows) = normalized_optical_rows {
        if rows.is_empty() {
            return Err(JsValue::from_str("opticalSystemRows is empty"));
        }
        rows
    } else {
        let rows_raw = req_obj
            .get("opticalSystemRows")
            .and_then(|v| v.as_array())
            .cloned()
            .ok_or_else(|| JsValue::from_str("opticalSystemRows is required"))?;
        if rows_raw.is_empty() {
            return Err(JsValue::from_str("opticalSystemRows is empty"));
        }
        rows_owned = rows_raw.iter().map(normalize_coord_trans_row).collect::<Vec<Value>>();
        &rows_owned
    };

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
    let source_rows_for_metrics = req_obj
        .get("sourceRows")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let opd_reference_wavelength_um = req_obj
        .get("opdReferenceWavelengthUm")
        .and_then(value_to_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(wavelength_um);
    let opd_wave_normalization = req_obj
        .get("opdWaveNormalization")
        .and_then(value_to_string)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "reference".to_string());
    let opd_display_mode = req_obj
        .get("opdDisplayMode")
        .and_then(value_to_string)
        .unwrap_or_else(|| "pistonTiltRemoved".to_string());
    let mut reference_mode = req_obj
        .get("referenceMode")
        .and_then(value_to_string)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "exit-pupil".to_string());
    if reference_mode == "reference-sphere" {
        reference_mode = "exit-pupil".to_string();
    }
    let exit_pupil_reference_point_mode = req_obj
        .get("exitPupilReferencePointMode")
        .and_then(value_to_string)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value == "exit-pupil-center")
        .unwrap_or_else(|| "chief-ray-intersection".to_string());
    let reference_sphere_options = req_obj.get("referenceSphereOptions");
    let reference_option = |name: &str, default_value: &str| -> String {
        reference_sphere_options
            .and_then(|value| value.get(name))
            .and_then(value_to_string)
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default_value.to_string())
    };
    let exit_pupil_position_sign = reference_option("exitPupilPositionSign", "as-is");
    let exit_pupil_plane_definition = reference_option("exitPupilPlaneDefinition", "global-z");
    let reference_sphere_wavelength_mode = reference_option("referenceSphereWavelengthMode", "primary-wavelength");
    let primary_reference_wavelength = get_primary_wavelength_um_native(&source_rows_for_metrics, wavelength_um);
    let reference_sphere_wavelength_used = if reference_sphere_wavelength_mode == "per-wavelength" {
        wavelength_um
    } else {
        primary_reference_wavelength
    };
    let mut primary_reference_geometry_applied = false;
    let chief_image_point_mode = reference_option("chiefImagePoint", "chief-ray-image-point");
    let reference_sphere_evaluation_surface = reference_option("evaluationSurface", "pre-target");
    let sphere_intersection = reference_option("sphereIntersection", "exit-pupil-side");
    let optical_path_sign = reference_option("opticalPathSign", "positive");
    let exit_pupil_direction_mode = reference_option("exitPupilDirection", "image-to-exit-pupil");
    let reference_sphere_radius_scale = reference_option("referenceSphereRadiusScale", "1")
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0);
    let requested_chief_ray_mode = req_obj
        .get("chiefRayMode")
        .and_then(value_to_string)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value == "entrance-pupil-center" || value == "transmitted-pupil-center")
        .unwrap_or_else(|| "stop-center".to_string());
    let pupil_grid_sampling = req_obj
        .get("pupilGridSampling")
        .and_then(value_to_string)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value == "cell-centered")
        .unwrap_or_else(|| "edge-inclusive".to_string());
    let reference_ray_pupil_coordinate = req_obj
        .get("referenceRayPupilCoordinate")
        .and_then(|value| value.as_object())
        .and_then(|value| Some([
            value.get("x").and_then(value_to_f64)?,
            value.get("y").and_then(value_to_f64)?,
        ]))
        .filter(|coordinate| coordinate.iter().all(|value| value.is_finite()))
        .unwrap_or([0.0, 0.0]);
    let sample_ray_launch_origin = req_obj
        .get("sampleRayLaunchOrigin")
        .and_then(|value| value.as_object())
        .and_then(|value| Some([
            value.get("x").and_then(value_to_f64)?,
            value.get("y").and_then(value_to_f64)?,
            value.get("z").and_then(value_to_f64)?,
        ]))
        .filter(|origin| origin.iter().all(|value| value.is_finite()));
    let requested_chief_ray_launch_origin = req_obj
        .get("chiefRayLaunchOrigin")
        .and_then(|value| value.as_object())
        .and_then(|value| Some([
            value.get("x").and_then(value_to_f64)?,
            value.get("y").and_then(value_to_f64)?,
            value.get("z").and_then(value_to_f64)?,
        ]))
        .filter(|origin| origin.iter().all(|value| value.is_finite()));
    let requested_chief_ray_launch_direction = req_obj
        .get("chiefRayLaunchDirection")
        .and_then(|value| value.as_object())
        .and_then(|value| Some(normalize3(
            value.get("x").and_then(value_to_f64)?,
            value.get("y").and_then(value_to_f64)?,
            value.get("z").and_then(value_to_f64)?,
        )))
        .filter(|direction| direction.iter().all(|value| value.is_finite()));
    let preserve_image_height_chief_ray = req_obj
        .get("preserveImageHeightChiefRay")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let resolve_image_height_chief_ray_in_runtime = req_obj
        .get("resolveImageHeightChiefRayInRuntime")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let aim_pupil_samples_to_stop = req_obj
        .get("aimPupilSamplesToStop")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let aim_pupil_samples_at_reference_wavelength = req_obj
        .get("aimPupilSamplesAtReferenceWavelength")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let pupil_normalization_mode = req_obj
        .get("pupilNormalizationMode")
        .and_then(value_to_string)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value == "effective-transmitted-pupil")
        .unwrap_or_else(|| "fixed-entrance-pupil".to_string());
    let omit_reference_sphere_opd_grid = req_obj
        .get("omitReferenceSphereOpdGrid")
        .or_else(|| req_obj.get("omitReferenceGrid"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

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
    let stop_clear_radius = rows
        .get(stop_surface_index)
        .and_then(|row| get_field(row, "semidia"))
        .and_then(value_to_f64)
        .filter(|radius| radius.is_finite() && *radius > 0.0);

    let object_space_n = rows
        .first()
        .map(|r| get_correct_refractive_index(r, wavelength_um))
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(1.0);

    let packed_meta_owned;
    let packed_meta = if let Some(shared) = shared_packed_meta {
        shared
    } else {
        packed_meta_owned = build_packed_meta_for_opd(rows, wavelength_um, target_surface_index);
        &packed_meta_owned
    };
    let stop_center = [
        packed_meta.row_origins[stop_surface_index * 3],
        packed_meta.row_origins[stop_surface_index * 3 + 1],
        packed_meta.row_origins[stop_surface_index * 3 + 2],
    ];
    let stop_rot_base = stop_surface_index * 9;
    let stop_plane_u = normalize3(
        packed_meta.row_rots[stop_rot_base],
        packed_meta.row_rots[stop_rot_base + 3],
        packed_meta.row_rots[stop_rot_base + 6],
    );
    let stop_plane_v = normalize3(
        packed_meta.row_rots[stop_rot_base + 1],
        packed_meta.row_rots[stop_rot_base + 4],
        packed_meta.row_rots[stop_rot_base + 7],
    );
    let packed_target = packed_meta;
    let packed_stop = packed_meta;
    let reference_aim_rows_owned = if aim_pupil_samples_at_reference_wavelength {
        req_obj
            .get("referenceOpticalSystemRows")
            .and_then(Value::as_array)
            .map(|reference_rows| {
                reference_rows
                    .iter()
                    .map(normalize_coord_trans_row)
                    .collect::<Vec<Value>>()
            })
            .filter(|reference_rows| !reference_rows.is_empty())
    } else {
        None
    };
    let aim_rows = reference_aim_rows_owned.as_deref().unwrap_or(rows);
    let packed_reference_aim_owned;
    let packed_aim = if aim_pupil_samples_at_reference_wavelength
        && (primary_reference_wavelength - wavelength_um).abs() > 1.0e-12
    {
        packed_reference_aim_owned = build_packed_meta_for_opd(
            aim_rows,
            primary_reference_wavelength,
            stop_surface_index,
        );
        &packed_reference_aim_owned
    } else {
        packed_stop
    };
    let aim_object_space_n = if aim_pupil_samples_at_reference_wavelength {
        aim_rows.first()
            .map(|row| get_correct_refractive_index(row, primary_reference_wavelength))
            .filter(|index| index.is_finite() && *index > 0.0)
            .unwrap_or(object_space_n)
    } else {
        object_space_n
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

    let original_object_position = selected_object_map
        .get("__cooptOriginalPosition")
        .or_else(|| selected_object_map.get("position"))
        .or_else(|| selected_object_map.get("object"))
        .or_else(|| selected_object_map.get("objectType"))
        .or_else(|| selected_object_map.get("type"))
        .and_then(value_to_string)
        .unwrap_or_else(|| "Point".to_string());
    let used_object_position = selected_object_map
        .get("position")
        .or_else(|| selected_object_map.get("object"))
        .or_else(|| selected_object_map.get("objectType"))
        .or_else(|| selected_object_map.get("type"))
        .and_then(value_to_string)
        .unwrap_or_else(|| "Point".to_string());
    let original_pos_lower = original_object_position.trim().to_lowercase();
    let pos_lower = used_object_position.trim().to_lowercase();
    let is_original_image_height = original_pos_lower == "imageheight";
    let use_infinite_mode = is_infinite_conjugate_native(&rows);
    let is_angle_object = if use_infinite_mode {
        true
    } else {
        pos_lower.contains("angle") || pos_lower == "point"
    };

    let angle_object_x = get_object_numeric(selected_object_map, &["xHeightAngle", "xFieldAngle", "xAngle", "x", "X", "xHeight"]).unwrap_or(0.0);
    let angle_object_y = get_object_numeric(selected_object_map, &["yHeightAngle", "yFieldAngle", "fieldAngle", "yAngle", "angle", "y", "Y", "yHeight"]).unwrap_or(0.0);
    let height_object_x = get_object_numeric(selected_object_map, &["xHeight", "x", "X"]).unwrap_or(0.0);
    let height_object_y = get_object_numeric(selected_object_map, &["yHeight", "y", "Y", "height"]).unwrap_or(0.0);

    let (used_object_x, used_object_y) = if use_infinite_mode {
        if is_angle_object { (angle_object_x, angle_object_y) } else { (0.0, 0.0) }
    } else {
        (height_object_x, height_object_y)
    };
    let reported_object_position = if use_infinite_mode {
        "Angle".to_string()
    } else {
        used_object_position.clone()
    };
    let reported_object_x = used_object_x;
    let reported_object_y = used_object_y;

    let stop_radius = estimate_stop_radius_from_row(&rows[stop_surface_index]).max(0.01);
    let requested_pupil_radius = req_obj
        .get("pupilRadiusMm")
        .and_then(value_to_f64)
        .filter(|value| value.is_finite() && *value > 0.0);
    let requested_pupil_radius = if pupil_normalization_mode == "effective-transmitted-pupil" {
        None
    } else {
        requested_pupil_radius
    };
    let requested_entrance_pupil_position = req_obj
        .get("entrancePupilPositionFromFirstSurfaceMm")
        .and_then(value_to_f64)
        .filter(|value| value.is_finite());
    let entrance_radius = requested_pupil_radius
        .unwrap_or_else(|| estimate_entrance_radius_from_rows(&rows))
        .clamp(0.01, 500.0);
    let sampling_radius = stop_radius.min(entrance_radius).max(0.01);

    let finite_object_distance = {
        let t0 = rows.first().map(get_safe_thickness).unwrap_or(f64::NAN).abs();
        if t0.is_finite() && t0 > 1e-9 {
            t0
        } else {
            let z0 = packed_meta.row_origins.get(2).copied().unwrap_or(0.0).abs();
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

    let image_height_chief_ray = selected_object_map
        .get("__cooptImageHeightSolve")
        .and_then(|v| v.get("chiefRay"))
        .and_then(|v| v.as_object());
    let mut image_height_chief_origin = image_height_chief_ray
        .and_then(|v| v.get("origin"))
        .and_then(|v| v.as_object())
        .and_then(|origin| {
            let x = origin.get("x").and_then(value_to_f64)?;
            let y = origin.get("y").and_then(value_to_f64)?;
            let z = origin.get("z").and_then(value_to_f64)?;
            if x.is_finite() && y.is_finite() && z.is_finite() {
                Some([x, y, z])
            } else {
                None
            }
        });
    let mut image_height_chief_dir = image_height_chief_ray
        .and_then(|v| v.get("dir"))
        .and_then(|v| v.as_object())
        .and_then(|dir| {
            let x = dir.get("x").and_then(value_to_f64)?;
            let y = dir.get("y").and_then(value_to_f64)?;
            let z = dir.get("z").and_then(value_to_f64)?;
            let norm = normalize3(x, y, z);
            if norm[0].is_finite() && norm[1].is_finite() && norm[2].is_finite() {
                Some(norm)
            } else {
                None
            }
        });
    let image_height_solver_hit = selected_object_map
        .get("__cooptImageHeightSolve")
        .and_then(|value| value.get("hit"))
        .and_then(|value| value.as_object())
        .and_then(|hit| {
            let x = hit.get("x").and_then(value_to_f64)?;
            let y = hit.get("y").and_then(value_to_f64)?;
            if x.is_finite() && y.is_finite() {
                Some([x, y, hit.get("z").and_then(value_to_f64).filter(|z| z.is_finite()).unwrap_or(0.0)])
            } else {
                None
            }
        });
    let image_height_solver_surface_index = selected_object_map
        .get("__cooptImageHeightSolve")
        .and_then(|value| value.get("imageSurfaceIndex"))
        .and_then(value_to_f64)
        .filter(|index| index.is_finite() && *index >= 0.0)
        .map(|index| index as usize);
    let has_image_height_chief_override = use_infinite_mode
        && is_original_image_height
        && image_height_chief_origin.is_some()
        && image_height_chief_dir.is_some();
    let mut image_height_runtime_solved_angle: Option<[f64; 3]> = None;
    let mut image_height_chief_runtime_resolved = false;
    if has_image_height_chief_override {
        let solve_wavelength_um = if resolve_image_height_chief_ray_in_runtime {
            wavelength_um
        } else {
            primary_reference_wavelength
        };
        let solve_rows_owned = if resolve_image_height_chief_ray_in_runtime {
            None
        } else {
            req_obj
                .get("referenceOpticalSystemRows")
                .and_then(Value::as_array)
                .map(|reference_rows| reference_rows.iter().map(normalize_coord_trans_row).collect::<Vec<Value>>())
                .filter(|reference_rows| !reference_rows.is_empty())
        };
        let solve_rows = solve_rows_owned.as_deref().unwrap_or(rows);
        let solve_packed = build_packed_meta_for_opd(solve_rows, solve_wavelength_um, target_surface_index);
        let solve_stop_center = [
            solve_packed.row_origins[stop_surface_index * 3],
            solve_packed.row_origins[stop_surface_index * 3 + 1],
            solve_packed.row_origins[stop_surface_index * 3 + 2],
        ];
        let solve_object_space_n = solve_rows
            .first()
            .map(|row| get_correct_refractive_index(row, solve_wavelength_um))
            .filter(|index| index.is_finite() && *index > 0.0)
            .unwrap_or(1.0);
        let target_x = selected_object_map
            .get("__cooptImageHeightTarget")
            .and_then(|value| value.get("x"))
            .and_then(value_to_f64)
            .unwrap_or(0.0);
        let target_y = selected_object_map
            .get("__cooptImageHeightTarget")
            .and_then(|value| value.get("y"))
            .and_then(value_to_f64)
            .unwrap_or(0.0);
        if target_x.is_finite() && target_y.is_finite() {
            let initial_x = angle_object_x;
            let initial_y = angle_object_y;
            if let Some((solved_x, solved_y, _)) = solve_image_height_pair_native(
                target_x,
                target_y,
                initial_x,
                initial_y,
                0,
                &mut |candidate_x, candidate_y| trace_image_height_infinite_candidate_local_exact_native(
                    solve_rows,
                    &solve_packed,
                    &solve_packed,
                    solve_object_space_n,
                    solve_wavelength_um,
                    stop_surface_index,
                    target_surface_index,
                    solve_stop_center,
                    candidate_x,
                    candidate_y,
                ),
            ) {
                if let Some((origin, direction, _)) = trace_image_height_infinite_chief_ray_exact_native(
                    solve_rows,
                    &solve_packed,
                    &solve_packed,
                    solve_object_space_n,
                    solve_wavelength_um,
                    stop_surface_index,
                    target_surface_index,
                    solve_stop_center,
                    solved_x,
                    solved_y,
                ) {
                    image_height_chief_origin = Some(origin);
                    image_height_chief_dir = Some(direction);
                    image_height_runtime_solved_angle = Some([solved_x, solved_y, 0.0]);
                    image_height_chief_runtime_resolved = true;
                }
            }
        }
    }
    let preserve_image_height_chief_ray = (preserve_image_height_chief_ray
        || (image_height_chief_runtime_resolved && resolve_image_height_chief_ray_in_runtime))
        && has_image_height_chief_override;

    let object_plane_z = packed_meta.row_origins.get(2).copied().unwrap_or(0.0);
    let mut infinite_direction = build_direction_from_field_angles_native(used_object_x, used_object_y);
    if let Some(dir) = image_height_chief_dir {
        if has_image_height_chief_override {
            infinite_direction = dir;
        }
    }
    let (infinite_u_axis, infinite_v_axis) = build_perpendicular_basis_native(infinite_direction);
    let mut infinite_object_z = resolve_infinite_object_z_native(&rows, selected_object_map, object_plane_z, stop_center[2]);
    if let Some(origin) = image_height_chief_origin {
        if has_image_height_chief_override {
            infinite_object_z = origin[2];
        }
    }
    let infinite_origin_xy = if used_object_x.abs() < 1e-10 && used_object_y.abs() < 1e-10 {
        [0.0, 0.0]
    } else if let Some(origin) = image_height_chief_origin {
        if has_image_height_chief_override {
            [origin[0], origin[1]]
        } else {
            optimize_angle_object_position_native(used_object_x, used_object_y, stop_center, infinite_object_z)
        }
    } else {
        optimize_angle_object_position_native(used_object_x, used_object_y, stop_center, infinite_object_z)
    };
    let infinite_origin_sag = compute_object_surface_sag_native(&rows, infinite_origin_xy[0], infinite_origin_xy[1]);
    let mut infinite_emission_origin = if let Some(origin) = image_height_chief_origin {
        if has_image_height_chief_override {
            origin
        } else {
            [
                infinite_origin_xy[0],
                infinite_origin_xy[1],
                infinite_object_z + infinite_origin_sag,
            ]
        }
    } else {
        [
            infinite_origin_xy[0],
            infinite_origin_xy[1],
            infinite_object_z + infinite_origin_sag,
        ]
    };
    let lock_emission_x_for_symmetry = use_infinite_mode
        && !has_image_height_chief_override
        && used_object_x.abs() <= 1.0e-12
        && used_object_y.abs() > 1.0e-12;
    let lock_emission_y_for_symmetry = use_infinite_mode
        && !has_image_height_chief_override
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
    let stop_center_for_sampling = if aim_pupil_samples_to_stop || prefer_entrance_sampling {
        stop_center
    } else if use_infinite_mode {
        effective_stop_center
    } else {
        stop_center
    };

    let stop_inv = [
        packed_meta.row_inv_rots[stop_rot_base],
        packed_meta.row_inv_rots[stop_rot_base + 1],
        packed_meta.row_inv_rots[stop_rot_base + 2],
        packed_meta.row_inv_rots[stop_rot_base + 3],
        packed_meta.row_inv_rots[stop_rot_base + 4],
        packed_meta.row_inv_rots[stop_rot_base + 5],
        packed_meta.row_inv_rots[stop_rot_base + 6],
        packed_meta.row_inv_rots[stop_rot_base + 7],
        packed_meta.row_inv_rots[stop_rot_base + 8],
    ];

    let build_marginal_ray = |u: f64, v: f64, sample_radius: f64, launch_origin: [f64; 3]| -> Option<[f64; 6]> {
        if !u.is_finite() || !v.is_finite() {
            return None;
        }
        let target_radius = if aim_pupil_samples_to_stop {
            stop_clear_radius.unwrap_or(sample_radius)
        } else {
            sample_radius
        };
        let desired_local_x = u * target_radius;
        let desired_local_y = v * target_radius;
        let stop_local_x = if aim_pupil_samples_to_stop {
            desired_local_x * (
                infinite_u_axis[0] * stop_plane_u[0]
                    + infinite_u_axis[1] * stop_plane_u[1]
                    + infinite_u_axis[2] * stop_plane_u[2]
            ).signum()
        } else {
            desired_local_x
        };
        let stop_local_y = if aim_pupil_samples_to_stop {
            desired_local_y * (
                infinite_v_axis[0] * stop_plane_v[0]
                    + infinite_v_axis[1] * stop_plane_v[1]
                    + infinite_v_axis[2] * stop_plane_v[2]
            ).signum()
        } else {
            desired_local_y
        };
        let stop_target = [
            stop_center_for_sampling[0] + stop_plane_u[0] * stop_local_x + stop_plane_v[0] * stop_local_y,
            stop_center_for_sampling[1] + stop_plane_u[1] * stop_local_x + stop_plane_v[1] * stop_local_y,
            stop_center_for_sampling[2] + stop_plane_u[2] * stop_local_x + stop_plane_v[2] * stop_local_y,
        ];

        if use_infinite_mode {
            let start = [
                launch_origin[0] + infinite_u_axis[0] * desired_local_x + infinite_v_axis[0] * desired_local_y,
                launch_origin[1] + infinite_u_axis[1] * desired_local_x + infinite_v_axis[1] * desired_local_y,
                launch_origin[2] + infinite_u_axis[2] * desired_local_x + infinite_v_axis[2] * desired_local_y,
            ];
            let start = if aim_pupil_samples_to_stop {
                let solved = solve_ray_origin_to_stop_point_fast_native(
                    start,
                    infinite_direction,
                    stop_target,
                    stop_surface_index,
                    packed_aim,
                    aim_object_space_n,
                )?;
                let plane_offset =
                    (solved[0] - launch_origin[0]) * infinite_direction[0]
                        + (solved[1] - launch_origin[1]) * infinite_direction[1]
                        + (solved[2] - launch_origin[2]) * infinite_direction[2];
                [
                    solved[0] - plane_offset * infinite_direction[0],
                    solved[1] - plane_offset * infinite_direction[1],
                    solved[2] - plane_offset * infinite_direction[2],
                ]
            } else {
                start
            };
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

    let estimate_effective_entrance_radius = |center_origin: [f64; 3], max_radius: f64| -> f64 {
        if !use_infinite_mode || !max_radius.is_finite() || max_radius <= 1.0e-9 {
            return max_radius.max(0.01);
        }

        let trace_ok = |origin: [f64; 3]| -> bool {
            let ray = [
                origin[0],
                origin[1],
                origin[2],
                infinite_direction[0],
                infinite_direction[1],
                infinite_direction[2],
            ];
            let hit = trace_single_ray_hit_point_with_meta_core(
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
            (hit[0] - 1.0).abs() <= f64::EPSILON
        };

        let add_scaled = |base: [f64; 3], axis: [f64; 3], scale: f64| -> [f64; 3] {
            [
                base[0] + axis[0] * scale,
                base[1] + axis[1] * scale,
                base[2] + axis[2] * scale,
            ]
        };

        let find_max_along = |axis: [f64; 3]| -> f64 {
            let mut lo = 0.0_f64;
            let mut hi = max_radius.max(0.0);
            if hi <= 0.0 {
                return 0.0;
            }
            if trace_ok(add_scaled(center_origin, axis, hi)) {
                return hi;
            }
            for _ in 0..12 {
                let mid = 0.5 * (lo + hi);
                if trace_ok(add_scaled(center_origin, axis, mid)) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            lo
        };

        if !trace_ok(center_origin) {
            return max_radius.max(0.01);
        }

        let r_pos_u = find_max_along(infinite_u_axis);
        let r_neg_u = find_max_along([-infinite_u_axis[0], -infinite_u_axis[1], -infinite_u_axis[2]]);
        let r_pos_v = find_max_along(infinite_v_axis);
        let r_neg_v = find_max_along([-infinite_v_axis[0], -infinite_v_axis[1], -infinite_v_axis[2]]);
        let r_min = r_pos_u.min(r_neg_u).min(r_pos_v).min(r_neg_v);
        let r_max = r_pos_u.max(r_neg_u).max(r_pos_v).max(r_neg_v);
        let eps = 1.0e-9;
        if r_min > eps {
            r_min
        } else if r_max > eps {
            r_max
        } else {
            max_radius.max(0.01)
        }
    };

    let use_real_entrance_pupil_chief = use_infinite_mode
        && requested_chief_ray_mode == "entrance-pupil-center"
        && requested_entrance_pupil_position.is_some();
    let use_transmitted_pupil_chief = use_infinite_mode
        && requested_chief_ray_mode == "transmitted-pupil-center";
    if use_real_entrance_pupil_chief {
        // The real entrance-pupil center is the back-projection of the chief ray
        // through the stop center, not the geometric center of the entrance plane.
        // The latter is wrong for off-axis fields and decentered/tilted systems.
        if let Some(center) = solve_ray_origin_to_stop_point_fast_native(
            effective_emission_origin,
            infinite_direction,
            stop_center_for_sampling,
            stop_surface_index,
            &packed_stop,
            object_space_n,
        ) {
            effective_emission_origin = apply_symmetry_axis_lock(center);
        }
    }

    let mut chief_start_dir = build_marginal_ray(reference_ray_pupil_coordinate[0], reference_ray_pupil_coordinate[1], sampling_radius, effective_emission_origin)
        .ok_or_else(|| JsValue::from_str("run_native_opd_map_wasm_json: chief ray not found"))?;
    let mut chief_reference_mode = if use_real_entrance_pupil_chief {
        "entrance-pupil-center-chief".to_string()
    } else {
        "center-chief".to_string()
    };
    let mut validated_requested_chief = false;
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
        if let (Some(origin), Some(direction)) = (
            requested_chief_ray_launch_origin,
            requested_chief_ray_launch_direction,
        ) {
            let requested_chief_ray = [
                origin[0], origin[1], origin[2],
                direction[0], direction[1], direction[2],
            ];
            let requested_target_hit = trace_single_ray_hit_point_with_meta_core(
                &requested_chief_ray,
                target_surface_index,
                object_space_n,
                &packed_target.row_meta,
                &packed_target.row_params,
                &packed_target.row_origins,
                &packed_target.row_inv_rots,
                &packed_target.row_rots,
                packed_target.row_count,
            );
            if (requested_target_hit[0] - 1.0).abs() <= f64::EPSILON {
                chief_start_dir = requested_chief_ray;
                chief_target_hit = requested_target_hit;
                effective_emission_origin = apply_symmetry_axis_lock(origin);
                chief_reference_mode = "validated-angle-chief".to_string();
                validated_requested_chief = true;
            }
        }
    }

    if (chief_target_hit[0] - 1.0).abs() > f64::EPSILON && use_infinite_mode {
        if let Some((exact_origin, exact_direction, _)) = trace_image_height_infinite_chief_ray_exact_native(
            &rows,
            &packed_stop,
            &packed_target,
            object_space_n,
            wavelength_um,
            stop_surface_index,
            target_surface_index,
            stop_center_for_sampling,
            used_object_x,
            used_object_y,
        ) {
            let exact_chief_ray = [
                exact_origin[0],
                exact_origin[1],
                exact_origin[2],
                exact_direction[0],
                exact_direction[1],
                exact_direction[2],
            ];
            let exact_target_hit = trace_single_ray_hit_point_with_meta_core(
                &exact_chief_ray,
                target_surface_index,
                object_space_n,
                &packed_target.row_meta,
                &packed_target.row_params,
                &packed_target.row_origins,
                &packed_target.row_inv_rots,
                &packed_target.row_rots,
                packed_target.row_count,
            );
            if (exact_target_hit[0] - 1.0).abs() <= f64::EPSILON {
                chief_start_dir = exact_chief_ray;
                chief_target_hit = exact_target_hit;
                effective_emission_origin = apply_symmetry_axis_lock(exact_origin);
                chief_reference_mode = "exact-angle-stop-chief".to_string();
            }
        }
    }

    if (chief_target_hit[0] - 1.0).abs() > f64::EPSILON && use_infinite_mode {
        let estimated_entrance_origin = estimate_entrance_center_origin_native(
            &rows,
            &packed_meta.row_origins,
            stop_center_for_sampling,
            infinite_direction,
        );
        let brent_entrance_origin = search_entrance_origin_grid_brent_native(
            &rows,
            &packed_meta.row_origins,
            stop_center_for_sampling,
            infinite_direction,
            stop_surface_index,
            &packed_stop,
            object_space_n,
            entrance_radius,
        );

        let mut candidate_origins: Vec<([f64; 3], &'static str)> = Vec::new();
        if estimated_entrance_origin[0].is_finite()
            && estimated_entrance_origin[1].is_finite()
            && estimated_entrance_origin[2].is_finite()
        {
            candidate_origins.push((estimated_entrance_origin, "estimate"));
        }
        if let Some(brent_origin) = brent_entrance_origin {
            let is_duplicate = candidate_origins.iter().any(|(origin, _)| {
                (origin[0] - brent_origin[0]).abs() <= 1.0e-9
                    && (origin[1] - brent_origin[1]).abs() <= 1.0e-9
                    && (origin[2] - brent_origin[2]).abs() <= 1.0e-9
            });
            if !is_duplicate {
                candidate_origins.push((brent_origin, "brent"));
            }
        }

        let chief_search_radius = estimate_entrance_radius_from_rows(&rows)
            .max(stop_radius)
            .max(entrance_radius)
            .max(0.01);

        for (entrance_origin, mode_tag) in candidate_origins {
            let chief_fallback_radius = estimate_effective_entrance_radius(
                entrance_origin,
                chief_search_radius,
            );
            if let Some(entrance_chief_ray) = build_marginal_ray(
                reference_ray_pupil_coordinate[0],
                reference_ray_pupil_coordinate[1],
                chief_fallback_radius,
                entrance_origin,
            ) {
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
                    chief_reference_mode = format!("entrance-chief-target({})", mode_tag);
                    break;
                }
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
    let mut transmitted_pupil_center_uv: Option<(f64, f64)> = None;

    if (chief_stop_hit[0] - 1.0).abs() > f64::EPSILON && !prefer_entrance_sampling && use_infinite_mode {
        if let Some(grid_brent_origin) = search_entrance_origin_grid_brent_native(
            &rows,
            &packed_meta.row_origins,
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
                    chief_start_dir = candidate_chief;
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
        effective_sampling_radius = entrance_radius.max(0.01);

        if use_infinite_mode && !preserve_image_height_chief_ray && !validated_requested_chief {
            let estimated_entrance_origin = estimate_entrance_center_origin_native(
                &rows,
                &packed_meta.row_origins,
                stop_center_for_sampling,
                infinite_direction,
            );
            if use_real_entrance_pupil_chief {
                if let Some(center) = solve_ray_origin_to_stop_point_fast_native(
                    if estimated_entrance_origin[0].is_finite()
                        && estimated_entrance_origin[1].is_finite()
                        && estimated_entrance_origin[2].is_finite()
                    {
                        estimated_entrance_origin
                    } else {
                        infinite_emission_origin
                    },
                    infinite_direction,
                    stop_center_for_sampling,
                    stop_surface_index,
                    &packed_stop,
                    object_space_n,
                ) {
                    effective_emission_origin = apply_symmetry_axis_lock(center);
                }
            } else {
                // JS parity: the JS entrance pupil center is the launch point of the
                // chief ray that passes through the effective stop center (exact
                // Newton solve), matching findInfiniteSystemChiefRayOrigin usage.
                let newton_entrance_origin = solve_ray_origin_to_stop_point_fast_native(
                    if estimated_entrance_origin[0].is_finite()
                        && estimated_entrance_origin[1].is_finite()
                        && estimated_entrance_origin[2].is_finite()
                    {
                        estimated_entrance_origin
                    } else {
                        infinite_emission_origin
                    },
                    infinite_direction,
                    stop_center_for_sampling,
                    stop_surface_index,
                    &packed_stop,
                    object_space_n,
                );
                effective_emission_origin = apply_symmetry_axis_lock(
                    if let Some(origin) = newton_entrance_origin {
                        origin
                    } else if estimated_entrance_origin[0].is_finite()
                        && estimated_entrance_origin[1].is_finite()
                        && estimated_entrance_origin[2].is_finite()
                    {
                        estimated_entrance_origin
                    } else {
                        search_entrance_origin_grid_brent_native(
                            &rows,
                            &packed_meta.row_origins,
                            stop_center_for_sampling,
                            infinite_direction,
                            stop_surface_index,
                            &packed_stop,
                            object_space_n,
                            entrance_radius,
                        )
                        .unwrap_or(estimated_entrance_origin)
                    }
                );
            }
            effective_sampling_radius = if requested_pupil_radius.is_some() {
                entrance_radius.max(0.01)
            } else {
                estimate_effective_entrance_radius(
                    effective_emission_origin,
                    entrance_radius.max(0.01),
                )
            };

            if use_transmitted_pupil_chief {
                let probe_grid = 17usize;
                let mut sum_u = 0.0;
                let mut sum_v = 0.0;
                let mut valid_count = 0usize;
                for probe_y in 0..probe_grid {
                    for probe_x in 0..probe_grid {
                        let probe_u = -1.0 + 2.0 * (probe_x as f64) / ((probe_grid - 1) as f64);
                        let probe_v = -1.0 + 2.0 * (probe_y as f64) / ((probe_grid - 1) as f64);
                        if probe_u * probe_u + probe_v * probe_v > 1.0 + 1.0e-9 {
                            continue;
                        }
                        let Some(probe_ray) = build_marginal_ray(
                            probe_u,
                            probe_v,
                            effective_sampling_radius,
                            effective_emission_origin,
                        ) else {
                            continue;
                        };
                        let probe_hit = trace_single_ray_hit_point_with_meta_core(
                            &probe_ray,
                            target_surface_index,
                            object_space_n,
                            &packed_target.row_meta,
                            &packed_target.row_params,
                            &packed_target.row_origins,
                            &packed_target.row_inv_rots,
                            &packed_target.row_rots,
                            packed_target.row_count,
                        );
                        if (probe_hit[0] - 1.0).abs() <= f64::EPSILON {
                            sum_u += probe_u;
                            sum_v += probe_v;
                            valid_count += 1;
                        }
                    }
                }
                if valid_count > 0 {
                    transmitted_pupil_center_uv = Some((
                        sum_u / valid_count as f64,
                        sum_v / valid_count as f64,
                    ));
                }
            }

            if let Some(entrance_chief_ray) =
                build_marginal_ray(
                    transmitted_pupil_center_uv.map(|(u, _)| u).unwrap_or(0.0),
                    transmitted_pupil_center_uv.map(|(_, v)| v).unwrap_or(0.0),
                    effective_sampling_radius,
                    effective_emission_origin,
                )
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
                    chief_start_dir = entrance_chief_ray;
                    chief_target_hit = entrance_target_hit;
                }
            }
        }

        chief_reference_mode = if validated_requested_chief {
            "validated-angle-chief".to_string()
        } else if use_real_entrance_pupil_chief {
            format!("entrance-pupil-center-chief-requested(r={:.3})", effective_sampling_radius)
        } else if use_transmitted_pupil_chief {
            let (u, v) = transmitted_pupil_center_uv.unwrap_or((0.0, 0.0));
            format!("transmitted-pupil-center-chief-requested(u={:.4},v={:.4},r={:.3})", u, v, effective_sampling_radius)
        } else if prefer_entrance_sampling {
            format!("entrance-chief-requested(estimate-first,r={:.3})", effective_sampling_radius)
        } else {
            format!("entrance-chief-fallback(estimate-first,r={:.3})", effective_sampling_radius)
        };
    }

    if reference_ray_pupil_coordinate[0].abs() > 1.0e-12
        || reference_ray_pupil_coordinate[1].abs() > 1.0e-12
    {
        chief_reference_mode.push_str("-reference-ray");
    }

    let chief_stop_state = trace_single_ray_hit_state_with_meta_core(
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
    let chief_stop_state = ((chief_stop_state[0] - 1.0).abs() <= f64::EPSILON
        && chief_stop_state[2..8].iter().all(|value| value.is_finite()))
        .then_some(chief_stop_state);
    let mut chief_surface_trace: Vec<Value> = (0..packed_target.row_count).filter_map(|surface_index| {
        let state = trace_single_ray_hit_state_with_meta_core(
            &chief_start_dir, surface_index, object_space_n,
            &packed_target.row_meta, &packed_target.row_params, &packed_target.row_origins,
            &packed_target.row_inv_rots, &packed_target.row_rots, packed_target.row_count,
        );
        if (state[0] - 1.0).abs() > f64::EPSILON || !state[2..8].iter().all(|value| value.is_finite()) {
            return None;
        }
        let point_base = surface_index * 3;
        let rotation_base = surface_index * 9;
        if point_base + 2 >= packed_target.row_origins.len() || rotation_base + 8 >= packed_target.row_inv_rots.len() {
            return None;
        }
        let inv = &packed_target.row_inv_rots[rotation_base..rotation_base + 9];
        let local_point = mul_mat3_vec3(&[inv[0], inv[1], inv[2], inv[3], inv[4], inv[5], inv[6], inv[7], inv[8]], [
            state[2] - packed_target.row_origins[point_base],
            state[3] - packed_target.row_origins[point_base + 1],
            state[4] - packed_target.row_origins[point_base + 2],
        ]);
        let local_direction = mul_mat3_vec3(&[inv[0], inv[1], inv[2], inv[3], inv[4], inv[5], inv[6], inv[7], inv[8]], [state[5], state[6], state[7]]);
        Some(serde_json::json!({
            "surfaceIndex": surface_index,
            "oplUm": state[1],
            "globalPoint": [state[2], state[3], state[4]],
            "point": local_point,
            "direction": local_direction,
        }))
    }).collect();

    let chief_opl = chief_target_hit[1];
    if !chief_opl.is_finite() {
        return Err(JsValue::from_str("run_native_opd_map_wasm_json: chief OPL is invalid"));
    }
    let first_optical_surface_index = rows.iter().enumerate().find_map(|(surface_index, row)| {
        if is_object_row(row) || is_gap_row(row) || is_coord_trans_row(row) {
            return None;
        }
        let state = trace_single_ray_hit_state_with_meta_core(
            &chief_start_dir,
            surface_index,
            object_space_n,
            &packed_target.row_meta,
            &packed_target.row_params,
            &packed_target.row_origins,
            &packed_target.row_inv_rots,
            &packed_target.row_rots,
            packed_target.row_count,
        );
        ((state[0] - 1.0).abs() <= f64::EPSILON
            && state[1].is_finite()
            && state[1].abs() > 1.0e-9)
            .then_some(surface_index)
    });
    let chief_first_surface_opl = first_optical_surface_index.and_then(|surface_index| {
        trace_single_ray_hit_point_with_meta_core(
            &chief_start_dir,
            surface_index,
            object_space_n,
            &packed_target.row_meta,
            &packed_target.row_params,
            &packed_target.row_origins,
            &packed_target.row_inv_rots,
            &packed_target.row_rots,
            packed_target.row_count,
        ).get(1).copied()
    });

    let chief_image_point = [chief_target_hit[2], chief_target_hit[3], chief_target_hit[4]];
    let chief_image_local_point = trace_surface_local_with_packed(
        chief_start_dir,
        target_surface_index,
        object_space_n,
        &packed_target,
    );
    let target_surface_origin = [
        packed_target.row_origins.get(target_surface_index * 3).copied().unwrap_or(chief_image_point[0]),
        packed_target.row_origins.get(target_surface_index * 3 + 1).copied().unwrap_or(chief_image_point[1]),
        packed_target.row_origins.get(target_surface_index * 3 + 2).copied().unwrap_or(chief_image_point[2]),
    ];
    // The paraxial point is the chief-ray transverse image height projected onto
    // the nominal image surface plane. The sagittal best-focus point is obtained
    // by intersecting the two symmetric sagittal marginal rays in image space.
    let paraxial_image_point = [
        chief_image_point[0],
        chief_image_point[1],
        target_surface_origin[2],
    ];
    let chief_prev_state = if target_surface_index > 0 {
        let prev_hit = trace_single_ray_hit_state_with_meta_core(
            &chief_start_dir,
            target_surface_index - 1,
            object_space_n,
            &packed_target.row_meta,
            &packed_target.row_params,
            &packed_target.row_origins,
            &packed_target.row_inv_rots,
            &packed_target.row_rots,
            packed_target.row_count,
        );
        if (prev_hit[0] - 1.0).abs() <= f64::EPSILON
            && prev_hit[2].is_finite()
            && prev_hit[3].is_finite()
            && prev_hit[4].is_finite()
        {
            Some(prev_hit)
        } else {
            None
        }
    } else {
        None
    };
    let chief_target_state = chief_prev_state.as_ref().and_then(|previous_state| {
        ((chief_target_hit[0] - 1.0).abs() <= f64::EPSILON).then_some([
            1.0,
            chief_target_hit[1],
            chief_target_hit[2],
            chief_target_hit[3],
            chief_target_hit[4],
            previous_state[5],
            previous_state[6],
            previous_state[7],
        ])
    });
    let focus_point_for_axis = |axis: usize| -> Option<[f64; 3]> {
        let chief_state = chief_prev_state.as_ref()?;
        if target_surface_index == 0 {
            return None;
        }
        let mut focus_states: Vec<[f64; 8]> = Vec::new();
        for pupil_u in [-0.7_f64, 0.7_f64] {
            let (u, v) = if axis == 0 { (pupil_u, 0.0) } else { (0.0, pupil_u) };
            let Some(ray) = build_marginal_ray(u, v, effective_sampling_radius, effective_emission_origin) else {
                continue;
            };
            let state = trace_single_ray_hit_state_with_meta_core(
                &ray,
                target_surface_index - 1,
                object_space_n,
                &packed_target.row_meta,
                &packed_target.row_params,
                &packed_target.row_origins,
                &packed_target.row_inv_rots,
                &packed_target.row_rots,
                packed_target.row_count,
            );
            if (state[0] - 1.0).abs() <= f64::EPSILON
                && state[4].is_finite()
                && state[2 + axis].is_finite()
                && state[5 + axis].is_finite()
                && state[7].is_finite()
                && state[7].abs() > 1.0e-12
            {
                focus_states.push(state);
            }
        }
        if focus_states.len() != 2 {
            return None;
        }
        let first = focus_states[0];
        let second = focus_states[1];
        let first_slope = first[5 + axis] / first[7];
        let second_slope = second[5 + axis] / second[7];
        let denominator = first_slope - second_slope;
        if denominator.abs() <= 1.0e-12 {
            return None;
        }
        let focus_z = (second[2] - first[2] + first_slope * first[4] - second_slope * second[4]) / denominator;
        if !focus_z.is_finite() {
            return None;
        }
        let chief_slope_x = chief_state[5] / chief_state[7];
        let chief_slope_y = chief_state[6] / chief_state[7];
        Some([
            chief_state[2] + chief_slope_x * (focus_z - chief_state[4]),
            chief_state[3] + chief_slope_y * (focus_z - chief_state[4]),
            focus_z,
        ])
    };
    let sagittal_best_focus_point = focus_point_for_axis(0);
    let tangential_best_focus_point = focus_point_for_axis(1);
    let tan_sag_mid_focus_point = match (tangential_best_focus_point, sagittal_best_focus_point) {
        (Some(tangential), Some(sagittal)) => {
            let mid_z = 0.5 * (tangential[2] + sagittal[2]);
            let chief_state = chief_prev_state.as_ref();
            chief_state.map(|state| {
                let chief_slope_x = state[5] / state[7];
                let chief_slope_y = state[6] / state[7];
                [
                    state[2] + chief_slope_x * (mid_z - state[4]),
                    state[3] + chief_slope_y * (mid_z - state[4]),
                    mid_z,
                ]
            })
        }
        _ => None,
    };
    let (rms_best_focus_point, rms_best_focus_diagnostics) = {
        let chief_state = chief_prev_state.as_ref();
        if target_surface_index == 0 || chief_state.is_none() {
            (None, None)
        } else {
            let base_z = paraxial_image_point[2];
            let mut focus_candidate_zs = Vec::new();
            for candidate in [
                sagittal_best_focus_point,
                tangential_best_focus_point,
                tan_sag_mid_focus_point,
            ].into_iter().flatten() {
                if candidate[2].is_finite() {
                    focus_candidate_zs.push(candidate[2]);
                }
            }
            let (mut search_min_z, mut search_max_z, mut search_range_mode) = if focus_candidate_zs.is_empty() {
                (base_z - 10.0, base_z + 10.0, "fallback")
            } else {
                let candidate_min_z = focus_candidate_zs.iter().copied().fold(base_z, f64::min);
                let candidate_max_z = focus_candidate_zs.iter().copied().fold(base_z, f64::max);
                let candidate_span = (candidate_max_z - candidate_min_z)
                    .max((base_z - candidate_min_z).abs())
                    .max((candidate_max_z - base_z).abs());
                let expansion = candidate_span.max(f64::EPSILON);
                (
                    candidate_min_z.min(base_z) - expansion,
                    candidate_max_z.max(base_z) + expansion,
                    "derived",
                )
            };
            let mut rays: Vec<[f64; 6]> = Vec::new();
            for grid_y in 0..=12 {
                for grid_x in 0..=12 {
                    let pupil_u = -1.0 + 2.0 * (grid_x as f64) / 12.0;
                    let pupil_v = -1.0 + 2.0 * (grid_y as f64) / 12.0;
                    if pupil_u * pupil_u + pupil_v * pupil_v > 1.0 {
                        continue;
                    }
                    let Some(ray) = build_marginal_ray(
                        pupil_u,
                        pupil_v,
                        effective_sampling_radius,
                        effective_emission_origin,
                    ) else {
                        continue;
                    };
                    let state = trace_single_ray_hit_state_with_meta_core(
                        &ray,
                        target_surface_index - 1,
                        object_space_n,
                        &packed_target.row_meta,
                        &packed_target.row_params,
                        &packed_target.row_origins,
                        &packed_target.row_inv_rots,
                        &packed_target.row_rots,
                        packed_target.row_count,
                    );
                    if (state[0] - 1.0).abs() <= f64::EPSILON
                        && state[2].is_finite()
                        && state[3].is_finite()
                        && state[4].is_finite()
                        && state[5].is_finite()
                        && state[6].is_finite()
                        && state[7].is_finite()
                        && state[7].abs() > 1.0e-12
                    {
                        rays.push([state[2], state[3], state[4], state[5], state[6], state[7]]);
                    }
                }
            }
            if focus_candidate_zs.is_empty() && rays.len() >= 3 {
                let chief = chief_state.unwrap();
                let chief_slope_x = chief[5] / chief[7];
                let chief_slope_y = chief[6] / chief[7];
                let mut ray_focus_zs = Vec::new();
                for ray in &rays {
                    let ray_slope_x = ray[3] / ray[5];
                    let ray_slope_y = ray[4] / ray[5];
                    let chief_x_at_ray_z = chief[2] + chief_slope_x * (ray[2] - chief[4]);
                    let chief_y_at_ray_z = chief[3] + chief_slope_y * (ray[2] - chief[4]);
                    let relative_slope_x = ray_slope_x - chief_slope_x;
                    let relative_slope_y = ray_slope_y - chief_slope_y;
                    if relative_slope_x.abs() > 1.0e-12 {
                        let z = ray[2] - (ray[0] - chief_x_at_ray_z) / relative_slope_x;
                        if z.is_finite() { ray_focus_zs.push(z); }
                    }
                    if relative_slope_y.abs() > 1.0e-12 {
                        let z = ray[2] - (ray[1] - chief_y_at_ray_z) / relative_slope_y;
                        if z.is_finite() { ray_focus_zs.push(z); }
                    }
                }
                if ray_focus_zs.len() >= 3 {
                    ray_focus_zs.sort_by(|first, second| first.total_cmp(second));
                    let low = ray_focus_zs[ray_focus_zs.len() / 10];
                    let high = ray_focus_zs[(ray_focus_zs.len() * 9 / 10).min(ray_focus_zs.len() - 1)];
                    let span = (high - low).abs().max((base_z - low).abs()).max((high - base_z).abs());
                    let expansion = span.max(f64::EPSILON);
                    search_min_z = low.min(base_z) - expansion;
                    search_max_z = high.max(base_z) + expansion;
                    search_range_mode = "derived-ray-bundle";
                }
            }
            if rays.len() < 3 {
                (None, None)
            } else {
                let search_half_width = 0.5 * (search_max_z - search_min_z);
                let search_center_z = 0.5 * (search_min_z + search_max_z);
                let rms_at = |z: f64| -> f64 {
                    let mut sum_x = 0.0;
                    let mut sum_y = 0.0;
                    let mut points: Vec<[f64; 2]> = Vec::with_capacity(rays.len());
                    for ray in &rays {
                        let dz = z - ray[2];
                        let x = ray[0] + ray[3] / ray[5] * dz;
                        let y = ray[1] + ray[4] / ray[5] * dz;
                        if x.is_finite() && y.is_finite() {
                            sum_x += x;
                            sum_y += y;
                            points.push([x, y]);
                        }
                    }
                    if points.len() < 3 {
                        return f64::INFINITY;
                    }
                    let mean_x = sum_x / points.len() as f64;
                    let mean_y = sum_y / points.len() as f64;
                    (points.iter().map(|point| {
                        (point[0] - mean_x).powi(2) + (point[1] - mean_y).powi(2)
                    }).sum::<f64>() / points.len() as f64).sqrt()
                };
                let mut best_z = base_z;
                let mut best_rms = f64::INFINITY;
                let coarse_steps = 40;
                for step in 0..=coarse_steps {
                    let z = search_center_z - search_half_width
                        + 2.0 * search_half_width * (step as f64) / coarse_steps as f64;
                    let rms = rms_at(z);
                    if rms < best_rms {
                        best_rms = rms;
                        best_z = z;
                    }
                }
                let mut refine_half_width = (2.0 * search_half_width) / coarse_steps as f64;
                for _ in 0..4 {
                    let center_z = best_z;
                    let refine_steps = 20;
                    for step in 0..=refine_steps {
                        let z = center_z - refine_half_width
                            + 2.0 * refine_half_width * (step as f64) / refine_steps as f64;
                        let rms = rms_at(z);
                        if rms < best_rms {
                            best_rms = rms;
                            best_z = z;
                        }
                    }
                    refine_half_width /= refine_steps as f64;
                }
                let state = chief_state.unwrap();
                let chief_slope_x = state[5] / state[7];
                let chief_slope_y = state[6] / state[7];
                let point = Some([
                    state[2] + chief_slope_x * (best_z - state[4]),
                    state[3] + chief_slope_y * (best_z - state[4]),
                    best_z,
                ]);
                let paraxial_rms_mm = rms_at(base_z);
                let diagnostics = Some(serde_json::json!({
                    "baseZ": base_z,
                    "searchMinZ": search_min_z,
                    "searchMaxZ": search_max_z,
                    "searchRangeMode": search_range_mode,
                    "rayCount": rays.len(),
                    "paraxialRmsMm": paraxial_rms_mm,
                    "bestFocusRmsMm": best_rms,
                    "improvementMm": paraxial_rms_mm - best_rms,
                    "bestFocusDeltaZ": best_z - base_z,
                }));
                (point, diagnostics)
            }
        }
    };
    let weighted_tan_sag_focus_point = match (tangential_best_focus_point, sagittal_best_focus_point) {
        (Some(tangential), Some(sagittal)) => {
            let field_magnitude = used_object_x.abs() + used_object_y.abs();
            let tangential_weight = if field_magnitude <= 1.0e-12 {
                0.5
            } else {
                used_object_y.abs() / field_magnitude
            };
            let sagittal_weight = 1.0 - tangential_weight;
            let focus_z = tangential_weight * tangential[2] + sagittal_weight * sagittal[2];
            chief_prev_state.as_ref().map(|state| {
                let chief_slope_x = state[5] / state[7];
                let chief_slope_y = state[6] / state[7];
                [
                    state[2] + chief_slope_x * (focus_z - state[4]),
                    state[3] + chief_slope_y * (focus_z - state[4]),
                    focus_z,
                ]
            })
        }
        _ => None,
    };
    let image_space_n = if target_surface_index > 0 {
        let n = get_correct_refractive_index(&rows[target_surface_index - 1], wavelength_um);
        if n.is_finite() && n > 0.0 { n } else { 1.0 }
    } else {
        1.0
    };
    let reference_image_space_n = image_space_n;
    let configured_exit_pupil_position = req_obj
        .get("exitPupilPositionFromLastSurfaceMm")
        .and_then(value_to_f64)
        .filter(|position| position.is_finite());
    let derived_exit_pupil_position = configured_exit_pupil_position.or_else(|| {
        let metrics = compute_native_paraxial_metrics_wasm(&rows, &source_rows_for_metrics, &object_rows);
        if metrics.expp.is_finite() { Some(metrics.expp) } else { None }
    });
    let exit_pupil_reference = derived_exit_pupil_position
        .and_then(|position| {
            if target_surface_index == 0 {
                return None;
            }
            let last_surface_base = (target_surface_index - 1) * 3;
            let last_surface_rot_base = (target_surface_index - 1) * 9;
            let last_surface_z = packed_target.row_origins.get(last_surface_base + 2).copied()?;
            let signed_position = if exit_pupil_position_sign == "negated" { -position } else { position };
            let exit_pupil_z = last_surface_z + signed_position;
            let chief_state = chief_prev_state.as_ref()?;
            let chief_direction = normalize3(chief_state[5], chief_state[6], chief_state[7]);
            if !chief_direction.iter().all(|value| value.is_finite()) || chief_direction[2].abs() <= 1.0e-12 {
                return None;
            }
            let distance_to_exit_pupil = (exit_pupil_z - chief_state[4]) / chief_direction[2];
            let mut chief_ray_exit_pupil_point = [
                chief_state[2] + chief_direction[0] * distance_to_exit_pupil,
                chief_state[3] + chief_direction[1] * distance_to_exit_pupil,
                exit_pupil_z,
            ];
            let surface_axis_exit_pupil = if last_surface_base + 2 < packed_target.row_origins.len()
                && last_surface_rot_base + 8 < packed_target.row_rots.len()
            {
                let origin = [
                    packed_target.row_origins[last_surface_base],
                    packed_target.row_origins[last_surface_base + 1],
                    packed_target.row_origins[last_surface_base + 2],
                ];
                let axis_w = normalize3(
                    packed_target.row_rots[last_surface_rot_base + 2],
                    packed_target.row_rots[last_surface_rot_base + 5],
                    packed_target.row_rots[last_surface_rot_base + 8],
                );
                let point = [
                    origin[0] + axis_w[0] * signed_position,
                    origin[1] + axis_w[1] * signed_position,
                    origin[2] + axis_w[2] * signed_position,
                ];
                Some((point, axis_w))
            } else {
                None
            };
            if exit_pupil_plane_definition == "surface-local-axis" {
                if let Some((plane_point, plane_normal)) = surface_axis_exit_pupil {
                    let denominator = chief_direction[0] * plane_normal[0]
                        + chief_direction[1] * plane_normal[1]
                        + chief_direction[2] * plane_normal[2];
                    if denominator.abs() > 1.0e-12 {
                        let plane_distance = (plane_point[0] - chief_state[2]) * plane_normal[0]
                            + (plane_point[1] - chief_state[3]) * plane_normal[1]
                            + (plane_point[2] - chief_state[4]) * plane_normal[2];
                        let distance = plane_distance / denominator;
                        chief_ray_exit_pupil_point = [
                            chief_state[2] + chief_direction[0] * distance,
                            chief_state[3] + chief_direction[1] * distance,
                            chief_state[4] + chief_direction[2] * distance,
                        ];
                    }
                }
            }
            let exit_pupil_point = if exit_pupil_reference_point_mode == "exit-pupil-center" {
                if exit_pupil_plane_definition == "surface-local-axis" {
                    surface_axis_exit_pupil.map(|(point, _)| point).unwrap_or(chief_ray_exit_pupil_point)
                } else {
                    [
                        packed_target.row_origins[last_surface_base],
                        packed_target.row_origins[last_surface_base + 1],
                        exit_pupil_z,
                    ]
                }
            } else {
                chief_ray_exit_pupil_point
            };
            let reference_center = match chief_image_point_mode.as_str() {
                "paraxial-image-point" => paraxial_image_point,
                "sagittal-best-focus-point" => sagittal_best_focus_point.unwrap_or(paraxial_image_point),
                "tangential-best-focus-point" => tangential_best_focus_point.unwrap_or(paraxial_image_point),
                "tan-sag-mid-focus-point" => tan_sag_mid_focus_point.unwrap_or(paraxial_image_point),
                "rms-wavefront-best-focus-point" => rms_best_focus_point.unwrap_or(paraxial_image_point),
                "circle-of-least-confusion-point" => tan_sag_mid_focus_point.unwrap_or(paraxial_image_point),
                "defocus-zero-reference-point" => rms_best_focus_point.unwrap_or(paraxial_image_point),
                "weighted-tan-sag-focus-point" => weighted_tan_sag_focus_point.unwrap_or(paraxial_image_point),
                "per-wavelength-best-focus-point" => rms_best_focus_point.unwrap_or(paraxial_image_point),
                "target-surface-center" => target_surface_origin,
                _ => chief_image_point,
            };
            let radius = distance3(reference_center, exit_pupil_point);
            if !radius.is_finite() || radius <= 1.0e-9 {
                return None;
            }
            let mut exit_pupil_direction = [
                exit_pupil_point[0] - reference_center[0],
                exit_pupil_point[1] - reference_center[1],
                exit_pupil_point[2] - reference_center[2],
            ];
            if exit_pupil_direction_mode == "exit-pupil-to-image" {
                exit_pupil_direction = [
                    -exit_pupil_direction[0],
                    -exit_pupil_direction[1],
                    -exit_pupil_direction[2],
                ];
            }
            let exit_pupil_direction = normalize3(
                exit_pupil_direction[0],
                exit_pupil_direction[1],
                exit_pupil_direction[2],
            );
            Some((reference_center, radius, exit_pupil_direction, exit_pupil_point))
        });
    let reference_sphere_geometry = exit_pupil_reference
        .as_ref()
        .and_then(|(center, _, _, exit_pupil_point)| reference_sphere_geometry_from_chief(*center, *exit_pupil_point));
    let primary_reference_geometry = if (reference_sphere_wavelength_mode == "primary-wavelength"
        || reference_sphere_wavelength_mode == "fixed-primary"
        || reference_sphere_wavelength_mode == "fixed-midpoint")
        && req_obj.get("__cooptReferenceGeometryOnly").and_then(|value| value.as_bool()) != Some(true)
        && req_obj.get("referenceSphereGeometry").is_none()
    {
        let primary_wavelength = primary_reference_wavelength;
        if primary_wavelength.is_finite() && primary_wavelength > 0.0
            && ((primary_wavelength - wavelength_um).abs() > 1.0e-12
                || reference_sphere_wavelength_mode == "fixed-midpoint")
        {
            let mut reference_request = req.clone();
            if let Some(reference_object) = reference_request.as_object_mut() {
                reference_object.insert("wavelengthUm".to_string(), Value::from(primary_wavelength));
                reference_object.insert("gridSize".to_string(), Value::from(17_u64));
                reference_object.insert("__cooptReferenceGeometryOnly".to_string(), Value::Bool(true));
                if let Some(reference_rows) = req_obj.get("referenceOpticalSystemRows") {
                    reference_object.insert("opticalSystemRows".to_string(), reference_rows.clone());
                }
            }
            let primary_geometry = run_native_opd_map_value(&reference_request).ok().and_then(|value| {
                let center = value.get("referenceSphereCenter").and_then(|value| value.as_array()).and_then(|values| Some([
                    values.get(0).and_then(value_to_f64)?,
                    values.get(1).and_then(value_to_f64)?,
                    values.get(2).and_then(value_to_f64)?,
                ]));
                let direction = value.get("referenceSphereDirection").and_then(|value| value.as_array()).and_then(|values| Some([
                    values.get(0).and_then(value_to_f64)?,
                    values.get(1).and_then(value_to_f64)?,
                    values.get(2).and_then(value_to_f64)?,
                ]));
                let radius = value.get("referenceSphereRadiusMm").and_then(value_to_f64);
                match (center, radius, direction) {
                    (Some(center), Some(radius), Some(direction))
                        if center.iter().all(|value| value.is_finite())
                            && direction.iter().all(|value| value.is_finite())
                            && radius.is_finite()
                            && radius > 0.0 => {
                                primary_reference_geometry_applied = true;
                                Some((center, radius, normalize3(direction[0], direction[1], direction[2])))
                            },
                    _ => None,
                }
            });
            if reference_sphere_wavelength_mode != "fixed-midpoint" {
                primary_geometry
            } else {
                let mut short_request = reference_request.clone();
                let mut long_request = reference_request;
                if let Some(object) = short_request.as_object_mut() {
                    object.insert("wavelengthUm".to_string(), Value::from(0.475_f64));
                }
                if let Some(object) = long_request.as_object_mut() {
                    object.insert("wavelengthUm".to_string(), Value::from(0.625_f64));
                }
                let short = run_native_opd_map_value(&short_request).ok();
                let long = run_native_opd_map_value(&long_request).ok();
                let geometry = |value: &Value| {
                    let center = value.get("referenceSphereCenter").and_then(|value| value.as_array()).and_then(|values| Some([
                        values.get(0).and_then(value_to_f64)?,
                        values.get(1).and_then(value_to_f64)?,
                        values.get(2).and_then(value_to_f64)?,
                    ]));
                    let direction = value.get("referenceSphereDirection").and_then(|value| value.as_array()).and_then(|values| Some([
                        values.get(0).and_then(value_to_f64)?,
                        values.get(1).and_then(value_to_f64)?,
                        values.get(2).and_then(value_to_f64)?,
                    ]));
                    let radius = value.get("referenceSphereRadiusMm").and_then(value_to_f64);
                    match (center, radius, direction) {
                        (Some(center), Some(radius), Some(direction)) if center.iter().all(|value| value.is_finite())
                            && direction.iter().all(|value| value.is_finite()) && radius.is_finite() && radius > 0.0 =>
                            Some((center, radius, normalize3(direction[0], direction[1], direction[2]))),
                        _ => None,
                    }
                };
                match (short.as_ref().and_then(geometry), long.as_ref().and_then(geometry)) {
                    (Some((short_center, short_radius, short_direction)), Some((long_center, long_radius, long_direction))) => {
                        let center = [
                            0.5 * (short_center[0] + long_center[0]),
                            0.5 * (short_center[1] + long_center[1]),
                            0.5 * (short_center[2] + long_center[2]),
                        ];
                        let direction = normalize3(
                            short_direction[0] + long_direction[0],
                            short_direction[1] + long_direction[1],
                            short_direction[2] + long_direction[2],
                        );
                        Some((center, 0.5 * (short_radius + long_radius), direction))
                    },
                    _ => primary_geometry,
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    let axis_reference_geometry = if req_obj.get("referenceSphereGeometry").is_none()
        && req_obj.get("__cooptReferenceGeometryOnly").and_then(|value| value.as_bool()) != Some(true)
        && primary_reference_wavelength.is_finite()
        && primary_reference_wavelength > 0.0
    {
        let mut reference_request = req.clone();
        if let Some(reference_object) = reference_request.as_object_mut() {
            reference_object.insert("wavelengthUm".to_string(), Value::from(primary_reference_wavelength));
            reference_object.insert("gridSize".to_string(), Value::from(17_u64));
            reference_object.insert("__cooptReferenceGeometryOnly".to_string(), Value::Bool(true));
            reference_object.insert("exitPupilReferencePointMode".to_string(), Value::from("exit-pupil-center"));
            if let Some(reference_rows) = req_obj.get("referenceOpticalSystemRows") {
                reference_object.insert("opticalSystemRows".to_string(), reference_rows.clone());
            }
        }
        run_native_opd_map_value(&reference_request).ok().and_then(|value| {
            let center = value.get("referenceSphereCenter").and_then(|value| value.as_array()).and_then(|values| Some([
                values.get(0).and_then(value_to_f64)?,
                values.get(1).and_then(value_to_f64)?,
                values.get(2).and_then(value_to_f64)?,
            ]));
            let direction = value.get("referenceSphereDirection").and_then(|value| value.as_array()).and_then(|values| Some([
                values.get(0).and_then(value_to_f64)?,
                values.get(1).and_then(value_to_f64)?,
                values.get(2).and_then(value_to_f64)?,
            ]));
            let radius = value.get("referenceSphereRadiusMm").and_then(value_to_f64);
            match (center, radius, direction) {
                (Some(center), Some(radius), Some(direction))
                    if center.iter().all(|value| value.is_finite())
                        && direction.iter().all(|value| value.is_finite())
                        && radius.is_finite()
                        && radius > 0.0 =>
                    Some((center, radius, normalize3(direction[0], direction[1], direction[2]))),
                _ => None,
            }
        })
    } else {
        None
    };
    let axis_image_reference_geometry = if reference_mode == "image-sphere" {
        let image = match chief_image_point_mode.as_str() {
            "paraxial-image-point" => paraxial_image_point,
            "sagittal-best-focus-point" => sagittal_best_focus_point.unwrap_or(paraxial_image_point),
            "tangential-best-focus-point" => tangential_best_focus_point.unwrap_or(paraxial_image_point),
            "tan-sag-mid-focus-point" => tan_sag_mid_focus_point.unwrap_or(paraxial_image_point),
            "rms-wavefront-best-focus-point" => rms_best_focus_point.unwrap_or(paraxial_image_point),
            "circle-of-least-confusion-point" => tan_sag_mid_focus_point.unwrap_or(paraxial_image_point),
            "defocus-zero-reference-point" => rms_best_focus_point.unwrap_or(paraxial_image_point),
            "weighted-tan-sag-focus-point" => weighted_tan_sag_focus_point.unwrap_or(paraxial_image_point),
            "per-wavelength-best-focus-point" => rms_best_focus_point.unwrap_or(paraxial_image_point),
            _ => [chief_target_hit[2], chief_target_hit[3], chief_target_hit[4]],
        };
        chief_prev_state.as_ref().and_then(|state| {
            let direction = normalize3(state[5], state[6], state[7]);
            let transverse_norm = direction[0] * direction[0] + direction[1] * direction[1];
            if !transverse_norm.is_finite() || transverse_norm <= 1.0e-20 {
                return None;
            }
            let t = -(image[0] * direction[0] + image[1] * direction[1]) / transverse_norm;
            let center = [0.0, 0.0, image[2] + t * direction[2]];
            let radius = distance3(image, center);
            (radius.is_finite() && radius > 1.0e-9).then_some((
                center,
                radius,
                [image[0] - center[0], image[1] - center[1], image[2] - center[2]],
            ))
        })
    } else {
        None
    };
    let mut selected_reference_geometry = if reference_mode == "optalix-direct" {
        reference_sphere_geometry
    } else if reference_mode == "image-sphere" {
        axis_image_reference_geometry
    } else if reference_mode == "reference-sphere" {
        reference_sphere_geometry
    } else if reference_mode == "exit-pupil" {
        exit_pupil_reference.as_ref().map(|(center, radius, direction, _)| (*center, *radius, *direction))
    } else {
        None
    };
    if let Some((_, radius, _)) = selected_reference_geometry.as_mut() {
        *radius *= reference_sphere_radius_scale;
    }
    let current_reference_geometry = selected_reference_geometry;
    let current_reference_sphere_radius_mm = selected_reference_geometry.as_ref().map(|(_, radius, _)| *radius);
    let mut primary_reference_sphere_radius_mm = if reference_sphere_wavelength_mode == "primary-wavelength"
        && (primary_reference_wavelength - wavelength_um).abs() <= 1.0e-12
    {
        current_reference_sphere_radius_mm
    } else {
        None
    };
    if let Some(geometry) = primary_reference_geometry {
        primary_reference_sphere_radius_mm = Some(geometry.1);
        selected_reference_geometry = if reference_sphere_wavelength_mode == "fixed-primary"
            || reference_sphere_wavelength_mode == "fixed-midpoint" {
            Some(geometry)
        } else {
            // Keep the image point selected for the traced wavelength. The primary
            // wavelength controls the reference sphere radius, not the evaluated
            // wavelength's chief-ray image point.
            current_reference_geometry
                .map(|(center, _, direction)| (center, geometry.1, direction))
                .or(Some(geometry))
        };
    }
    if let Some(geometry) = req_obj.get("referenceSphereGeometry").and_then(|value| value.as_object()) {
        let center = geometry.get("center").and_then(|value| value.as_object());
        let direction = geometry.get("direction").and_then(|value| value.as_object());
        let radius = geometry.get("radiusMm").and_then(value_to_f64);
        let center_values = center.and_then(|value| Some([
            value.get("x").and_then(value_to_f64)?,
            value.get("y").and_then(value_to_f64)?,
            value.get("z").and_then(value_to_f64)?,
        ]));
        let direction_values = direction.and_then(|value| Some([
            value.get("x").and_then(value_to_f64)?,
            value.get("y").and_then(value_to_f64)?,
            value.get("z").and_then(value_to_f64)?,
        ]));
        if let (Some(center), Some(direction), Some(radius)) = (center_values, direction_values, radius) {
            let direction = normalize3(direction[0], direction[1], direction[2]);
            if center.iter().all(|value| value.is_finite())
                && direction.iter().all(|value| value.is_finite())
                && radius.is_finite()
                && radius > 0.0
            {
                selected_reference_geometry = Some((center, radius, direction));
            }
        }
    }
    let chief_reference_state = if reference_sphere_evaluation_surface == "target" {
        chief_target_state.as_ref()
    } else {
        chief_prev_state.as_ref()
    };
    let chief_reference_sphere_opl = match (chief_reference_state, selected_reference_geometry.as_ref()) {
        (Some(state), Some((center, radius, image_side_direction))) => optical_path_to_reference_sphere(
            state,
            *center,
            *radius,
            *image_side_direction,
            reference_image_space_n,
            &sphere_intersection,
            &optical_path_sign,
        ),
        _ => None,
    };
    let alternate_sphere_intersection = if sphere_intersection == "opposite-side" {
        "exit-pupil-side"
    } else {
        "opposite-side"
    };
    let chief_alternate_reference_sphere_opl = match (chief_reference_state, selected_reference_geometry.as_ref()) {
        (Some(state), Some((center, radius, image_side_direction))) => optical_path_to_reference_sphere(
            state,
            *center,
            *radius,
            *image_side_direction,
            reference_image_space_n,
            alternate_sphere_intersection,
            &optical_path_sign,
        ),
        _ => None,
    };
    let chief_current_reference_opl = match (chief_reference_state, current_reference_geometry.as_ref()) {
        (Some(state), Some((center, radius, image_side_direction))) => optical_path_to_reference_sphere(
            state,
            *center,
            *radius,
            *image_side_direction,
            image_space_n,
            &sphere_intersection,
            &optical_path_sign,
        ),
        _ => None,
    };
    let chief_air_reference_sphere_opl = match (chief_reference_state, selected_reference_geometry.as_ref()) {
        (Some(state), Some((center, radius, image_side_direction))) => optical_path_to_reference_sphere(
            state,
            *center,
            *radius,
            *image_side_direction,
            1.0,
            &sphere_intersection,
            &optical_path_sign,
        ),
        _ => None,
    };
    let alternate_optical_path_sign = if optical_path_sign == "negative" {
        "positive"
    } else {
        "negative"
    };
    let chief_alternate_sign_reference_sphere_opl = match (chief_reference_state, selected_reference_geometry.as_ref()) {
        (Some(state), Some((center, radius, image_side_direction))) => optical_path_to_reference_sphere(
            state,
            *center,
            *radius,
            *image_side_direction,
            reference_image_space_n,
            &sphere_intersection,
            alternate_optical_path_sign,
        ),
        _ => None,
    };
    let chief_axis_reference_sphere_opl = match (chief_reference_state, axis_reference_geometry.as_ref()) {
        (Some(state), Some((center, radius, image_side_direction))) => optical_path_to_reference_sphere(
            state,
            *center,
            *radius,
            *image_side_direction,
            reference_image_space_n,
            &sphere_intersection,
            &optical_path_sign,
        ),
        _ => None,
    };
    let radius_probe_scales = [0.50_f64, 0.65, 0.80, 0.90, 1.0, 1.10, 1.25, 1.50, 2.0];
    let chief_radius_probe_opls: Vec<Option<f64>> = radius_probe_scales.iter().map(|scale| {
        match (chief_reference_state, selected_reference_geometry.as_ref()) {
            (Some(state), Some((center, radius, image_side_direction))) => optical_path_to_reference_sphere(
                state,
                *center,
                *radius * *scale,
                *image_side_direction,
                reference_image_space_n,
                &sphere_intersection,
                &optical_path_sign,
            ),
            _ => None,
        }
    }).collect();
    let chief_reference_sphere_opd_um = chief_reference_sphere_opl.map(|reference_opl| chief_opl - reference_opl);
    let mut sample_count = 0usize;
    let mut hit_count = 0usize;
    let mut reference_corrected_sample_count = 0usize;
    let mut reference_opd_sum_sq_um = 0.0_f64;
    let mut tracked_opd_sum_sq_um = 0.0_f64;
    let mut tracked_opd_sample_count = 0usize;
    let mut sphere_path_delta_sum_sq_um = 0.0_f64;
    let mut tracked_sphere_delta_sum_um2 = 0.0_f64;
    let mut sphere_path_delta_sample_count = 0usize;
    let mut current_reference_opd_sum_sq_um = 0.0_f64;
    let mut current_reference_sample_count = 0usize;
    let mut alternate_reference_opd_sum_sq_um = 0.0_f64;
    let mut alternate_reference_sample_count = 0usize;
    let mut target_origin_reference_opd_sum_sq_um = 0.0_f64;
    let mut target_origin_reference_sample_count = 0usize;
    let mut air_reference_opd_sum_sq_um = 0.0_f64;
    let mut air_reference_sample_count = 0usize;
    let mut image_plane_reference_opd_sum_sq_um = 0.0_f64;
    let mut image_plane_reference_sample_count = 0usize;
    let mut stop_image_reference_opd_sum_sq_um = 0.0_f64;
    let mut stop_image_reference_sample_count = 0usize;
    let mut stop_reference_opd_sum_sq_um = 0.0_f64;
    let mut stop_reference_sample_count = 0usize;
    let mut alternate_sign_reference_opd_sum_sq_um = 0.0_f64;
    let mut alternate_sign_reference_sample_count = 0usize;
    let mut axis_reference_opd_sum_sq_um = 0.0_f64;
    let mut axis_reference_sample_count = 0usize;
    let mut radius_probe_sums: Vec<f64> = vec![0.0; radius_probe_scales.len()];
    let mut radius_probe_counts: Vec<usize> = vec![0; radius_probe_scales.len()];
    let mut before_target_tracked_opd_sum_sq_um = 0.0_f64;
    let mut before_target_tracked_opd_sample_count = 0usize;
    let mut target_segment_opd_sum_sq_um = 0.0_f64;
    let mut target_segment_opd_sample_count = 0usize;
    let mut first_surface_opd_sum_sq_um = 0.0_f64;
    let mut first_surface_opd_sample_count = 0usize;
    let mut first_surface_excluded_opd_sum_sq_um = 0.0_f64;
    let mut first_surface_excluded_opd_sample_count = 0usize;
    let mut first_surface_trace_status_3_count = 0usize;
    let mut first_surface_trace_status_4_count = 0usize;
    let mut first_surface_trace_status_other_count = 0usize;
    let mut raw_grid = vec![vec![None::<f64>; grid_size]; grid_size];
    let mut unreferenced_grid = vec![vec![None::<f64>; grid_size]; grid_size];
    let mut reference_sphere_grid = vec![vec![None::<f64>; grid_size]; grid_size];
    let mut pupil_mask_grid = vec![vec![None::<bool>; grid_size]; grid_size];
    let grid_index_for_pupil_coordinate = |coordinate: f64| -> usize {
        (((coordinate + 1.0) * (grid_size.saturating_sub(1)) as f64 / 2.0).round() as isize)
            .clamp(0, grid_size.saturating_sub(1) as isize) as usize
    };
    let mut opd_term_sample_targets: Vec<(String, f64, f64)> = vec![
        ("near-axis".to_string(), 0.0, 0.0),
        ("upper".to_string(), 0.0, 0.75),
        ("lower".to_string(), 0.0, -0.75),
        ("right".to_string(), 0.75, 0.0),
        ("left".to_string(), -0.75, 0.0),
    ];
    if req_obj
        .get("includeMeridionalTermSamples")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        for step in -10_i32..=10_i32 {
            let pupil_v = step as f64 / 10.0;
            if !opd_term_sample_targets
                .iter()
                .any(|(_, pupil_u, existing_v)| (*pupil_u).abs() <= 1.0e-12 && (*existing_v - pupil_v).abs() <= 1.0e-12)
            {
                opd_term_sample_targets.push((format!("meridional-{step}"), 0.0, pupil_v));
            }
        }
    }
    let mut opd_term_samples = Vec::new();
    let entrance_pupil_geometry = requested_entrance_pupil_position.and_then(|position| {
        let first_surface_index = rows.iter().position(|row| {
            !is_coord_trans_row(row) && !is_object_row(row) && !is_gap_row(row)
        })?;
        let origin_base = first_surface_index * 3;
        let rotation_base = first_surface_index * 9;
        if origin_base + 2 >= packed_meta.row_origins.len()
            || rotation_base + 8 >= packed_meta.row_rots.len()
        {
            return None;
        }
        let origin = [
            packed_meta.row_origins[origin_base],
            packed_meta.row_origins[origin_base + 1],
            packed_meta.row_origins[origin_base + 2],
        ];
        let axis_u = normalize3(
            packed_meta.row_rots[rotation_base],
            packed_meta.row_rots[rotation_base + 3],
            packed_meta.row_rots[rotation_base + 6],
        );
        let axis_v = normalize3(
            packed_meta.row_rots[rotation_base + 1],
            packed_meta.row_rots[rotation_base + 4],
            packed_meta.row_rots[rotation_base + 7],
        );
        let axis_w = normalize3(
            packed_meta.row_rots[rotation_base + 2],
            packed_meta.row_rots[rotation_base + 5],
            packed_meta.row_rots[rotation_base + 8],
        );
        let center = [
            origin[0] + axis_w[0] * position,
            origin[1] + axis_w[1] * position,
            origin[2] + axis_w[2] * position,
        ];
        Some((center, axis_u, axis_v, axis_w))
    });
    let mut entrance_coordinate_x_grid = vec![vec![None::<f64>; grid_size]; grid_size];
    let mut entrance_coordinate_y_grid = vec![vec![None::<f64>; grid_size]; grid_size];

    for y in 0..grid_size {
        for x in 0..grid_size {
            let u = if pupil_grid_sampling == "cell-centered" {
                -1.0 + (2.0 * x as f64 + 1.0) / grid_size as f64
            } else if grid_size > 1 {
                -1.0 + 2.0 * (x as f64) / ((grid_size - 1) as f64)
            } else {
                0.0
            };
            let v = if pupil_grid_sampling == "cell-centered" {
                -1.0 + (2.0 * y as f64 + 1.0) / grid_size as f64
            } else if grid_size > 1 {
                -1.0 + 2.0 * (y as f64) / ((grid_size - 1) as f64)
            } else {
                0.0
            };
            let r2 = u * u + v * v;
            if !r2.is_finite() || r2 > 1.0 + 1e-9 {
                continue;
            }
            sample_count += 1;
            pupil_mask_grid[y][x] = Some(false);

            let Some(ray) = build_marginal_ray(
                u,
                v,
                effective_sampling_radius,
                sample_ray_launch_origin.unwrap_or(effective_emission_origin),
            ) else {
                continue;
            };
            if let Some((center, axis_u, axis_v, axis_w)) = entrance_pupil_geometry.as_ref() {
                let denominator = ray[3] * axis_w[0] + ray[4] * axis_w[1] + ray[5] * axis_w[2];
                if denominator.abs() > 1.0e-12 {
                    let distance = ((center[0] - ray[0]) * axis_w[0]
                        + (center[1] - ray[1]) * axis_w[1]
                        + (center[2] - ray[2]) * axis_w[2])
                        / denominator;
                    let pupil_point = [
                        ray[0] + ray[3] * distance,
                        ray[1] + ray[4] * distance,
                        ray[2] + ray[5] * distance,
                    ];
                    let relative = [
                        pupil_point[0] - center[0],
                        pupil_point[1] - center[1],
                        pupil_point[2] - center[2],
                    ];
                    let (center_u, center_v) = transmitted_pupil_center_uv.unwrap_or((0.0, 0.0));
                    let normalization_radius = if requested_pupil_radius.is_some() {
                        entrance_radius
                    } else {
                        effective_sampling_radius
                    };
                    let effective_relative_x = relative[0] * axis_u[0]
                        + relative[1] * axis_u[1]
                        + relative[2] * axis_u[2]
                        - center_u * effective_sampling_radius;
                    let effective_relative_y = relative[0] * axis_v[0]
                        + relative[1] * axis_v[1]
                        + relative[2] * axis_v[2]
                        - center_v * effective_sampling_radius;
                    let coordinate_x = effective_relative_x
                        / normalization_radius;
                    let coordinate_y = effective_relative_y / normalization_radius;
                    if coordinate_x.is_finite() && coordinate_y.is_finite() {
                        entrance_coordinate_x_grid[y][x] = Some(coordinate_x);
                        entrance_coordinate_y_grid[y][x] = Some(coordinate_y);
                    }
                }
            }
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
            if let (Some(first_surface_index), Some(chief_first_opl)) =
                (first_optical_surface_index, chief_first_surface_opl)
            {
                let marginal_first_state = trace_single_ray_hit_point_with_meta_core(
                    &ray,
                    first_surface_index,
                    object_space_n,
                    &packed_target.row_meta,
                    &packed_target.row_params,
                    &packed_target.row_origins,
                    &packed_target.row_inv_rots,
                    &packed_target.row_rots,
                    packed_target.row_count,
                );
                if (marginal_first_state[0] - 1.0).abs() <= f64::EPSILON {
                    let first_surface_opd_um = chief_first_opl - marginal_first_state[1];
                    if first_surface_opd_um.is_finite() {
                        first_surface_opd_sum_sq_um += first_surface_opd_um * first_surface_opd_um;
                        first_surface_opd_sample_count += 1;
                        let first_surface_excluded_opd_um = (chief_opl - chief_first_opl)
                            - (ray_opl - marginal_first_state[1]);
                        if first_surface_excluded_opd_um.is_finite() {
                            first_surface_excluded_opd_sum_sq_um +=
                                first_surface_excluded_opd_um * first_surface_excluded_opd_um;
                            first_surface_excluded_opd_sample_count += 1;
                        }
                    }
                } else if (marginal_first_state[0] - 3.0).abs() <= f64::EPSILON {
                    first_surface_trace_status_3_count += 1;
                } else if (marginal_first_state[0] - 4.0).abs() <= f64::EPSILON {
                    first_surface_trace_status_4_count += 1;
                } else {
                    first_surface_trace_status_other_count += 1;
                }
            }
            pupil_mask_grid[y][x] = Some(true);
            let marginal_prev_state = if target_surface_index > 0 {
                let state = trace_single_ray_hit_state_with_meta_core(
                    &ray,
                    target_surface_index - 1,
                    object_space_n,
                    &packed_target.row_meta,
                    &packed_target.row_params,
                    &packed_target.row_origins,
                    &packed_target.row_inv_rots,
                    &packed_target.row_rots,
                    packed_target.row_count,
                );
                ((state[0] - 1.0).abs() <= f64::EPSILON).then_some(state)
            } else {
                None
            };
            let marginal_target_state = marginal_prev_state.as_ref().and_then(|previous_state| {
                ((target_hit[0] - 1.0).abs() <= f64::EPSILON).then_some([
                    1.0,
                    target_hit[1],
                    target_hit[2],
                    target_hit[3],
                    target_hit[4],
                    previous_state[5],
                    previous_state[6],
                    previous_state[7],
                ])
            });
            let marginal_reference_state = if reference_sphere_evaluation_surface == "target" {
                marginal_target_state.as_ref()
            } else {
                marginal_prev_state.as_ref()
            };
            let marginal_stop_state = trace_single_ray_hit_state_with_meta_core(
                &ray,
                stop_surface_index,
                object_space_n,
                &packed_target.row_meta,
                &packed_target.row_params,
                &packed_target.row_origins,
                &packed_target.row_inv_rots,
                &packed_target.row_rots,
                packed_target.row_count,
            );
            if (marginal_stop_state[0] - 1.0).abs() <= f64::EPSILON {
                if let (Some(chief_stop), Some(first_surface_index), Some(chief_first_opl)) =
                    (chief_stop_state, first_optical_surface_index, chief_first_surface_opl)
                {
                    let marginal_first_state = trace_single_ray_hit_point_with_meta_core(
                        &ray,
                        first_surface_index,
                        object_space_n,
                        &packed_target.row_meta,
                        &packed_target.row_params,
                        &packed_target.row_origins,
                        &packed_target.row_inv_rots,
                        &packed_target.row_rots,
                        packed_target.row_count,
                    );
                    if (marginal_first_state[0] - 1.0).abs() <= f64::EPSILON {
                        let chief_stop_segment_um = chief_stop[1] - chief_first_opl;
                        let marginal_stop_segment_um = marginal_stop_state[1] - marginal_first_state[1];
                        let stop_reference_opd_um = chief_stop_segment_um - marginal_stop_segment_um;
                        if stop_reference_opd_um.is_finite() {
                            stop_reference_opd_sum_sq_um += stop_reference_opd_um * stop_reference_opd_um;
                            stop_reference_sample_count += 1;
                        }
                    }
                }
            }
            if let Some(chief_stop) = chief_stop_state {
                if (marginal_stop_state[0] - 1.0).abs() <= f64::EPSILON {
                    let chief_stop_image_path_um = distance3(
                        [chief_stop[2], chief_stop[3], chief_stop[4]],
                        chief_image_point,
                    ) * image_space_n * 1000.0;
                    let marginal_stop_image_path_um = distance3(
                        [marginal_stop_state[2], marginal_stop_state[3], marginal_stop_state[4]],
                        chief_image_point,
                    ) * image_space_n * 1000.0;
                    let stop_image_reference_opd_um =
                        (chief_stop[1] + chief_stop_image_path_um)
                            - (marginal_stop_state[1] + marginal_stop_image_path_um);
                    if stop_image_reference_opd_um.is_finite() {
                        stop_image_reference_opd_sum_sq_um +=
                            stop_image_reference_opd_um * stop_image_reference_opd_um;
                        stop_image_reference_sample_count += 1;
                    }
                }
            }
            if let (Some(chief_state), Some(marginal_state)) = (chief_prev_state.as_ref(), marginal_prev_state.as_ref()) {
                let chief_image_path_um = distance3(
                    [chief_state[2], chief_state[3], chief_state[4]],
                    chief_image_point,
                ) * image_space_n * 1000.0;
                let marginal_image_path_um = distance3(
                    [marginal_state[2], marginal_state[3], marginal_state[4]],
                    chief_image_point,
                ) * image_space_n * 1000.0;
                let image_plane_reference_opd_um =
                    (chief_state[1] + chief_image_path_um) - (marginal_state[1] + marginal_image_path_um);
                if image_plane_reference_opd_um.is_finite() {
                    image_plane_reference_opd_sum_sq_um +=
                        image_plane_reference_opd_um * image_plane_reference_opd_um;
                    image_plane_reference_sample_count += 1;
                }
            }
            let corrected_opl_pair = match (
                marginal_reference_state.as_ref(),
                selected_reference_geometry.as_ref(),
                chief_reference_sphere_opl,
            ) {
                (Some(state), Some((center, radius, image_side_direction)), Some(chief_reference_opl)) => optical_path_to_reference_sphere(
                    state,
                    *center,
                    *radius,
                    *image_side_direction,
                    reference_image_space_n,
                    &sphere_intersection,
                    &optical_path_sign,
                ).map(|marginal_reference_opl| (chief_reference_opl, marginal_reference_opl)),
                _ => None,
            };
            let has_reference_sphere_opd = corrected_opl_pair.is_some();
            if has_reference_sphere_opd {
                reference_corrected_sample_count += 1;
            }
            let (opd_first, opd_second) = corrected_opl_pair.unwrap_or_else(|| {
                (chief_opl, ray_opl)
            });
            let opd_wave_denominator = if opd_wave_normalization == "trace" {
                wavelength_um
            } else {
                opd_reference_wavelength_um
            };
            let unreferenced_opd_waves = (chief_opl - ray_opl) / opd_wave_denominator;
            if unreferenced_opd_waves.is_finite() {
                unreferenced_grid[y][x] = Some(unreferenced_opd_waves);
            }
            let tracked_opd_um = chief_opl - ray_opl;
            if tracked_opd_um.is_finite() {
                tracked_opd_sum_sq_um += tracked_opd_um * tracked_opd_um;
                tracked_opd_sample_count += 1;
            }
            if let (Some(chief_state), Some(marginal_state)) = (chief_prev_state.as_ref(), marginal_prev_state.as_ref()) {
                let before_target_tracked_opd_um = chief_state[1] - marginal_state[1];
                let target_segment_opd_um = tracked_opd_um - before_target_tracked_opd_um;
                if before_target_tracked_opd_um.is_finite() {
                    before_target_tracked_opd_sum_sq_um += before_target_tracked_opd_um * before_target_tracked_opd_um;
                    before_target_tracked_opd_sample_count += 1;
                }
                if target_segment_opd_um.is_finite() {
                    target_segment_opd_sum_sq_um += target_segment_opd_um * target_segment_opd_um;
                    target_segment_opd_sample_count += 1;
                }
            }
            if has_reference_sphere_opd {
                let reference_opd_waves = (opd_first - opd_second) / opd_wave_denominator;
                if reference_opd_waves.is_finite() {
                    reference_sphere_grid[y][x] = Some(reference_opd_waves);
                }
            }
            let opd_waves = (opd_first - opd_second) / opd_wave_denominator;
            if !opd_waves.is_finite() {
                continue;
            }
            if has_reference_sphere_opd {
                let reference_opd_um = opd_first - opd_second;
                if reference_opd_um.is_finite() {
                    reference_opd_sum_sq_um += reference_opd_um * reference_opd_um;
                    let sphere_path_delta_um = reference_opd_um - tracked_opd_um;
                    if sphere_path_delta_um.is_finite() {
                        sphere_path_delta_sum_sq_um += sphere_path_delta_um * sphere_path_delta_um;
                        tracked_sphere_delta_sum_um2 += tracked_opd_um * sphere_path_delta_um;
                        sphere_path_delta_sample_count += 1;
                    }
                }
            }
            if let Some((label, _, _)) = opd_term_sample_targets.iter().find(|(_, sample_u, sample_v)| {
                x == grid_index_for_pupil_coordinate(*sample_u)
                    && y == grid_index_for_pupil_coordinate(*sample_v)
            }) {
                let surface_trace: Vec<Value> = (0..packed_target.row_count).filter_map(|surface_index| {
                    let state = trace_single_ray_hit_state_with_meta_core(
                        &ray, surface_index, object_space_n,
                        &packed_target.row_meta, &packed_target.row_params, &packed_target.row_origins,
                        &packed_target.row_inv_rots, &packed_target.row_rots, packed_target.row_count,
                    );
                    if (state[0] - 1.0).abs() > f64::EPSILON || !state[1..8].iter().all(|value| value.is_finite()) {
                        return None;
                    }
                    let point_base = surface_index * 3;
                    let rotation_base = surface_index * 9;
                    let inv = &packed_target.row_inv_rots[rotation_base..rotation_base + 9];
                    let local_point = mul_mat3_vec3(&[inv[0], inv[1], inv[2], inv[3], inv[4], inv[5], inv[6], inv[7], inv[8]], [
                        state[2] - packed_target.row_origins[point_base],
                        state[3] - packed_target.row_origins[point_base + 1],
                        state[4] - packed_target.row_origins[point_base + 2],
                    ]);
                    let local_direction = mul_mat3_vec3(&[inv[0], inv[1], inv[2], inv[3], inv[4], inv[5], inv[6], inv[7], inv[8]], [state[5], state[6], state[7]]);
                    Some(serde_json::json!({
                        "surfaceIndex": surface_index,
                        "oplUm": state[1],
                        "globalPoint": [state[2], state[3], state[4]],
                        "point": local_point,
                        "direction": local_direction,
                    }))
                }).collect();
                let chief_pre_target_opl_um = chief_prev_state.as_ref().map(|state| state[1]);
                let marginal_pre_target_opl_um = marginal_prev_state.as_ref().map(|state| state[1]);
                let chief_pre_target_point = chief_prev_state.as_ref().map(|state| [state[2], state[3], state[4]]);
                let marginal_pre_target_point = marginal_prev_state.as_ref().map(|state| [state[2], state[3], state[4]]);
                let chief_pre_target_direction = chief_prev_state.as_ref().map(|state| [state[5], state[6], state[7]]);
                let marginal_pre_target_direction = marginal_prev_state.as_ref().map(|state| [state[5], state[6], state[7]]);
                let marginal_target_point = marginal_target_state.as_ref().map(|state| [state[2], state[3], state[4]]);
                let marginal_target_direction = marginal_target_state.as_ref().map(|state| [state[5], state[6], state[7]]);
                let before_target_opd_um = chief_pre_target_opl_um.zip(marginal_pre_target_opl_um)
                    .map(|(chief, marginal)| chief - marginal);
                let target_segment_opd_um = before_target_opd_um.map(|before| tracked_opd_um - before);
                let chief_sphere_opl_um = corrected_opl_pair.map(|(chief, _)| chief);
                let marginal_sphere_opl_um = corrected_opl_pair.map(|(_, marginal)| marginal);
                let reference_opd_um = chief_sphere_opl_um.zip(marginal_sphere_opl_um)
                    .map(|(chief, marginal)| chief - marginal);
                opd_term_samples.push(serde_json::json!({
                    "label": label,
                    "pupilU": u,
                    "pupilV": v,
                    "chiefOplUm": chief_opl,
                    "marginalOplUm": ray_opl,
                    "chiefPreTargetOplUm": chief_pre_target_opl_um,
                    "marginalPreTargetOplUm": marginal_pre_target_opl_um,
                    "chiefPreTargetPoint": chief_pre_target_point,
                    "marginalPreTargetPoint": marginal_pre_target_point,
                    "chiefPreTargetDirection": chief_pre_target_direction,
                    "marginalPreTargetDirection": marginal_pre_target_direction,
                    "marginalTargetPoint": marginal_target_point,
                    "marginalTargetDirection": marginal_target_direction,
                    "beforeTargetOpdUm": before_target_opd_um,
                    "targetSegmentOpdUm": target_segment_opd_um,
                    "chiefSphereOplUm": chief_sphere_opl_um,
                    "marginalSphereOplUm": marginal_sphere_opl_um,
                    "referenceOpdUm": reference_opd_um,
                    "spherePathDeltaUm": reference_opd_um.map(|reference| reference - tracked_opd_um),
                    "surfaceTrace": surface_trace,
                }));
            }
            if let (Some(state), Some((center, radius, image_side_direction)), Some(chief_alternate_opl)) = (
                marginal_prev_state.as_ref(),
                selected_reference_geometry.as_ref(),
                chief_alternate_reference_sphere_opl,
            ) {
                if let Some(alternate_marginal_opl) = optical_path_to_reference_sphere(
                    state,
                    *center,
                    *radius,
                    *image_side_direction,
                    reference_image_space_n,
                    alternate_sphere_intersection,
                    &optical_path_sign,
                ) {
                    let alternate_reference_opd_um = chief_alternate_opl - alternate_marginal_opl;
                    if alternate_reference_opd_um.is_finite() {
                        alternate_reference_sample_count += 1;
                        alternate_reference_opd_sum_sq_um += alternate_reference_opd_um * alternate_reference_opd_um;
                    }
                }
            }
            if let (Some(chief_state), Some(marginal_state), Some((center, radius, image_side_direction))) = (
                chief_target_state.as_ref(),
                marginal_target_state.as_ref(),
                selected_reference_geometry.as_ref(),
            ) {
                let chief_target_reference_opl = optical_path_to_reference_sphere(
                    chief_state,
                    *center,
                    *radius,
                    *image_side_direction,
                    reference_image_space_n,
                    &sphere_intersection,
                    &optical_path_sign,
                );
                let marginal_target_reference_opl = optical_path_to_reference_sphere(
                    marginal_state,
                    *center,
                    *radius,
                    *image_side_direction,
                    reference_image_space_n,
                    &sphere_intersection,
                    &optical_path_sign,
                );
                if let (Some(chief_reference_opl), Some(marginal_reference_opl)) =
                    (chief_target_reference_opl, marginal_target_reference_opl)
                {
                    let target_origin_reference_opd_um = chief_reference_opl - marginal_reference_opl;
                    if target_origin_reference_opd_um.is_finite() {
                        target_origin_reference_sample_count += 1;
                        target_origin_reference_opd_sum_sq_um += target_origin_reference_opd_um * target_origin_reference_opd_um;
                    }
                }
            }
            if let (Some(state), Some((center, radius, image_side_direction)), Some(chief_air_opl)) = (
                marginal_prev_state.as_ref(),
                selected_reference_geometry.as_ref(),
                chief_air_reference_sphere_opl,
            ) {
                if let Some(air_marginal_reference_opl) = optical_path_to_reference_sphere(
                    state,
                    *center,
                    *radius,
                    *image_side_direction,
                    1.0,
                    &sphere_intersection,
                    &optical_path_sign,
                ) {
                    let air_reference_opd_um = chief_air_opl - air_marginal_reference_opl;
                    if air_reference_opd_um.is_finite() {
                        air_reference_sample_count += 1;
                        air_reference_opd_sum_sq_um += air_reference_opd_um * air_reference_opd_um;
                    }
                }
            }
            if let (Some(state), Some((center, radius, image_side_direction)), Some(chief_alternate_sign_opl)) = (
                marginal_prev_state.as_ref(),
                selected_reference_geometry.as_ref(),
                chief_alternate_sign_reference_sphere_opl,
            ) {
                if let Some(alternate_sign_marginal_opl) = optical_path_to_reference_sphere(
                    state,
                    *center,
                    *radius,
                    *image_side_direction,
                    reference_image_space_n,
                    &sphere_intersection,
                    alternate_optical_path_sign,
                ) {
                    let alternate_sign_reference_opd_um = chief_alternate_sign_opl - alternate_sign_marginal_opl;
                    if alternate_sign_reference_opd_um.is_finite() {
                        alternate_sign_reference_sample_count += 1;
                        alternate_sign_reference_opd_sum_sq_um += alternate_sign_reference_opd_um * alternate_sign_reference_opd_um;
                    }
                }
            }
            if let (Some(state), Some((center, radius, image_side_direction)), Some(chief_axis_opl)) = (
                marginal_prev_state.as_ref(),
                axis_reference_geometry.as_ref(),
                chief_axis_reference_sphere_opl,
            ) {
                if let Some(axis_marginal_reference_opl) = optical_path_to_reference_sphere(
                    state,
                    *center,
                    *radius,
                    *image_side_direction,
                    reference_image_space_n,
                    &sphere_intersection,
                    &optical_path_sign,
                ) {
                    let axis_reference_opd_um = chief_axis_opl - axis_marginal_reference_opl;
                    if axis_reference_opd_um.is_finite() {
                        axis_reference_sample_count += 1;
                        axis_reference_opd_sum_sq_um += axis_reference_opd_um * axis_reference_opd_um;
                    }
                }
            }
            if let (Some(state), Some((center, radius, image_side_direction))) = (
                marginal_prev_state.as_ref(),
                selected_reference_geometry.as_ref(),
            ) {
                for (index, scale) in radius_probe_scales.iter().enumerate() {
                    let Some(chief_probe_opl) = chief_radius_probe_opls.get(index).and_then(|value| *value) else {
                        continue;
                    };
                    let Some(marginal_probe_opl) = optical_path_to_reference_sphere(
                        state,
                        *center,
                        *radius * *scale,
                        *image_side_direction,
                        reference_image_space_n,
                        &sphere_intersection,
                        &optical_path_sign,
                    ) else {
                        continue;
                    };
                    let radius_probe_opd_um = chief_probe_opl - marginal_probe_opl;
                    if radius_probe_opd_um.is_finite() {
                        radius_probe_sums[index] += radius_probe_opd_um * radius_probe_opd_um;
                        radius_probe_counts[index] += 1;
                    }
                }
            }
            if let (Some(state), Some((center, radius, image_side_direction)), Some(chief_current_opl)) = (
                marginal_prev_state.as_ref(),
                current_reference_geometry.as_ref(),
                chief_current_reference_opl,
            ) {
                if let Some(current_marginal_opl) = optical_path_to_reference_sphere(
                    state,
                    *center,
                    *radius,
                    *image_side_direction,
                    image_space_n,
                    &sphere_intersection,
                    &optical_path_sign,
                ) {
                    let current_reference_opd_um = chief_current_opl - current_marginal_opl;
                    if current_reference_opd_um.is_finite() {
                        current_reference_sample_count += 1;
                        current_reference_opd_sum_sq_um += current_reference_opd_um * current_reference_opd_um;
                    }
                }
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
    let mut sparse_entrance_warning: Option<String> = None;
    if use_infinite_mode && effective_pupil_sampling_mode == "entrance" && hit_rate < 0.35 {
        if hit_count == 0 {
            return Err(JsValue::from_str(&format!(
                "No valid OPD samples for entrance mode (hit-rate={:.3}, hits={}, samples={})",
                hit_rate,
                hit_count,
                sample_count
            )));
        }
        sparse_entrance_warning = Some(format!(
            "sparse entrance OPD samples (hit-rate={:.3}, hits={}, samples={})",
            hit_rate,
            hit_count,
            sample_count
        ));
    }

    let (display_grid, display_fit) = apply_display_mode_grid(
        &raw_grid,
        &entrance_coordinate_x_grid,
        &entrance_coordinate_y_grid,
        &pupil_mask_grid,
        &opd_display_mode,
    );
    let wavefront_fit = display_fit.clone();
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
    let to_json_bool_grid = |src: &[Vec<Option<bool>>]| -> Value {
        Value::Array(
            src.iter().map(|row| {
                Value::Array(
                    row.iter().map(|v| match v {
                        Some(value) => Value::from(*value),
                        None => Value::Null,
                    }).collect()
                )
            }).collect()
        )
    };

    chief_surface_trace.push(serde_json::json!({
        "diagnostic": "firstSurfaceTraceStatusCounts",
        "status3Count": first_surface_trace_status_3_count,
        "status4Count": first_surface_trace_status_4_count,
        "statusOtherCount": first_surface_trace_status_other_count,
        "validCount": first_surface_opd_sample_count,
    }));
    let mut response = serde_json::json!({
        "backend": "web-rust-wasm-native-api",
        "targetSurface": target_surface_index,
        "stopSurface": stop_surface_index,
        "requestedObjectIndex": requested_object_index,
        "usedObjectIndex": used_object_index,
        "usedObjectPosition": reported_object_position,
        "usedObjectX": reported_object_x,
        "usedObjectY": reported_object_y,
        "gridSize": grid_size,
        "sampleCount": sample_count,
        "hitCount": hit_count,
        "referenceCorrectedSampleCount": reference_corrected_sample_count,
        "referenceOpdRmsUm": if reference_corrected_sample_count > 0 {
            Some((reference_opd_sum_sq_um / reference_corrected_sample_count as f64).sqrt())
        } else {
            None
        },
        "trackedOpdRmsUm": if tracked_opd_sample_count > 0 {
            Some((tracked_opd_sum_sq_um / tracked_opd_sample_count as f64).sqrt())
        } else {
            None
        },
        "beforeTargetTrackedOpdRmsUm": if before_target_tracked_opd_sample_count > 0 {
            Some((before_target_tracked_opd_sum_sq_um / before_target_tracked_opd_sample_count as f64).sqrt())
        } else {
            None
        },
        "targetSegmentOpdRmsUm": if target_segment_opd_sample_count > 0 {
            Some((target_segment_opd_sum_sq_um / target_segment_opd_sample_count as f64).sqrt())
        } else {
            None
        },
        "firstSurfaceOpdRmsUm": if first_surface_opd_sample_count > 0 {
            Some((first_surface_opd_sum_sq_um / first_surface_opd_sample_count as f64).sqrt())
        } else {
            None
        },
        "spherePathDeltaRmsUm": if sphere_path_delta_sample_count > 0 {
            Some((sphere_path_delta_sum_sq_um / sphere_path_delta_sample_count as f64).sqrt())
        } else {
            None
        },
        "spherePathOptimalScale": if sphere_path_delta_sum_sq_um > 1.0e-18 {
            Some((-tracked_sphere_delta_sum_um2 / sphere_path_delta_sum_sq_um).clamp(-4.0, 4.0))
        } else {
            None
        },
        "spherePathOptimalRmsUm": if sphere_path_delta_sample_count > 0 && sphere_path_delta_sum_sq_um > 1.0e-18 {
            let alpha = -tracked_sphere_delta_sum_um2 / sphere_path_delta_sum_sq_um;
            let min_sum_sq = (tracked_opd_sum_sq_um
                + 2.0 * alpha * tracked_sphere_delta_sum_um2
                + alpha * alpha * sphere_path_delta_sum_sq_um).max(0.0);
            Some((min_sum_sq / sphere_path_delta_sample_count as f64).sqrt())
        } else {
            None
        },
        "currentReferenceOpdRmsUm": if current_reference_sample_count > 0 {
            Some((current_reference_opd_sum_sq_um / current_reference_sample_count as f64).sqrt())
        } else {
            None
        },
        "alternateSphereIntersection": alternate_sphere_intersection,
        "alternateReferenceOpdRmsUm": if alternate_reference_sample_count > 0 {
            Some((alternate_reference_opd_sum_sq_um / alternate_reference_sample_count as f64).sqrt())
        } else {
            None
        },
        "targetOriginReferenceOpdRmsUm": if target_origin_reference_sample_count > 0 {
            Some((target_origin_reference_opd_sum_sq_um / target_origin_reference_sample_count as f64).sqrt())
        } else {
            None
        },
        "imageSpaceN": image_space_n,
        "airReferenceOpdRmsUm": if air_reference_sample_count > 0 {
            Some((air_reference_opd_sum_sq_um / air_reference_sample_count as f64).sqrt())
        } else {
            None
        },
        "alternateOpticalPathSign": alternate_optical_path_sign,
        "alternateSignReferenceOpdRmsUm": if alternate_sign_reference_sample_count > 0 {
            Some((alternate_sign_reference_opd_sum_sq_um / alternate_sign_reference_sample_count as f64).sqrt())
        } else {
            None
        },
        "axisReferenceSphereRmsUm": if axis_reference_sample_count > 0 {
            Some((axis_reference_opd_sum_sq_um / axis_reference_sample_count as f64).sqrt())
        } else {
            None
        },
        "sphereRadiusOptimalScale": radius_probe_sums.iter().zip(radius_probe_counts.iter()).enumerate()
            .filter_map(|(index, (sum_sq, count))| (*count > 0).then_some((radius_probe_scales[index], (*sum_sq / *count as f64).sqrt())))
            .min_by(|left, right| left.1.partial_cmp(&right.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|value| value.0),
        "sphereRadiusOptimalRmsUm": radius_probe_sums.iter().zip(radius_probe_counts.iter())
            .filter_map(|(sum_sq, count)| (*count > 0).then_some((*sum_sq / *count as f64).sqrt()))
            .min_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)),
        "wavelengthUm": wavelength_um,
        "referenceSphereWavelengthUsed": reference_sphere_wavelength_used,
        "primaryReferenceGeometryApplied": primary_reference_geometry_applied,
        "currentReferenceSphereRadiusMm": current_reference_sphere_radius_mm,
        "primaryReferenceSphereRadiusMm": primary_reference_sphere_radius_mm,
        "opdReferenceWavelengthUm": opd_reference_wavelength_um,
        "chiefOplUm": chief_opl,
        "chiefRayLaunchOrigin": [chief_start_dir[0], chief_start_dir[1], chief_start_dir[2]],
        "imageHeightChiefRayApplied": has_image_height_chief_override,
        "imageHeightChiefRayPreserved": preserve_image_height_chief_ray,
        "imageHeightChiefRayRuntimeResolved": image_height_chief_runtime_resolved,
        "imageHeightChiefDirection": image_height_chief_dir,
        "imageHeightRuntimeSolvedAngle": image_height_runtime_solved_angle,
        "imageHeightSolverHit": image_height_solver_hit,
        "imageHeightSolverSurfaceIndex": image_height_solver_surface_index,
        "chiefStopPoint": chief_stop_state.map(|state| [state[2], state[3], state[4]]),
        "chiefStopDirection": chief_stop_state.map(|state| [state[5], state[6], state[7]]),
        "chiefSurfaceTrace": chief_surface_trace,
        "sampleRayLaunchOriginApplied": sample_ray_launch_origin.is_some(),
        "chiefReferenceSphereOpdUm": chief_reference_sphere_opd_um,
        "opdTermSamples": opd_term_samples,
        "effectivePupilRadiusMm": effective_sampling_radius,
        "pupilMaskGrid": to_json_bool_grid(&pupil_mask_grid),
        "entrancePupilCoordinateXGrid": to_json_grid(&entrance_coordinate_x_grid),
        "entrancePupilCoordinateYGrid": to_json_grid(&entrance_coordinate_y_grid),
        "pupilSamplingMode": effective_pupil_sampling_mode,
        "chiefRayMode": requested_chief_ray_mode,
        "pupilNormalizationMode": pupil_normalization_mode,
        "exitPupilReferencePointMode": exit_pupil_reference_point_mode,
        "referenceMode": reference_mode,
        "referenceSphereCenter": selected_reference_geometry.as_ref().map(|(center, _, _)| *center),
        "referenceSphereRadiusMm": selected_reference_geometry.as_ref().map(|(_, radius, _)| *radius),
        "referenceSphereDirection": selected_reference_geometry.as_ref().map(|(_, _, direction)| *direction),
        "chiefImagePoint": chief_image_point,
        "chiefImageLocalPoint": chief_image_local_point,
        "paraxialImagePoint": paraxial_image_point,
        "sagittalBestFocusPoint": sagittal_best_focus_point,
        "tangentialBestFocusPoint": tangential_best_focus_point,
        "rmsBestFocusPoint": rms_best_focus_point,
        "rmsBestFocusDiagnostics": rms_best_focus_diagnostics,
        "selectedImagePoint": match chief_image_point_mode.as_str() {
            "paraxial-image-point" => Some(paraxial_image_point),
            "sagittal-best-focus-point" => sagittal_best_focus_point.or(Some(paraxial_image_point)),
            "tangential-best-focus-point" => tangential_best_focus_point.or(Some(paraxial_image_point)),
            "tan-sag-mid-focus-point" => tan_sag_mid_focus_point.or(Some(paraxial_image_point)),
            "rms-wavefront-best-focus-point" => rms_best_focus_point.or(Some(paraxial_image_point)),
            "circle-of-least-confusion-point" => tan_sag_mid_focus_point.or(Some(paraxial_image_point)),
            "defocus-zero-reference-point" => rms_best_focus_point.or(Some(paraxial_image_point)),
            "weighted-tan-sag-focus-point" => weighted_tan_sag_focus_point.or(Some(paraxial_image_point)),
            "per-wavelength-best-focus-point" => rms_best_focus_point.or(Some(paraxial_image_point)),
            "target-surface-center" => Some(target_surface_origin),
            _ => Some(chief_image_point),
        },
        "selectedImagePointMode": chief_image_point_mode,
        "displayFit": display_fit,
        "wavefrontFit": wavefront_fit,
        "exitPupilCenter": exit_pupil_reference.as_ref().map(|(_, _, _, point)| *point),
        "chiefReferenceMode": chief_reference_mode,
        "transmittedPupilCenterUv": transmitted_pupil_center_uv.map(|(u, v)| [u, v]),
        "rawOpdGrid": to_json_grid(&raw_grid),
        "unreferencedOpdGrid": to_json_grid(&unreferenced_grid),
        "referenceSphereOpdGrid": if omit_reference_sphere_opd_grid { Value::Null } else { to_json_grid(&reference_sphere_grid) },
        "displayOpdGrid": to_json_grid(&display_grid),
        "message": if let Some(warn) = sparse_entrance_warning.as_deref() {
            if prefer_entrance_sampling {
                format!("Computed via Rust-WASM native OPD API (entrance requested; {})", warn)
            } else if stop_sampling_fallback_to_entrance {
                format!("Computed via Rust-WASM native OPD API (stop to entrance fallback; {})", warn)
            } else {
                format!("Computed via Rust-WASM native OPD API ({})", warn)
            }
        } else if prefer_entrance_sampling {
            "Computed via Rust-WASM native OPD API (entrance requested)".to_string()
        } else if stop_sampling_fallback_to_entrance {
            "Computed via Rust-WASM native OPD API (stop to entrance fallback)".to_string()
        } else {
            "Computed via Rust-WASM native OPD API".to_string()
        }
    });
    if let Some(response_object) = response.as_object_mut() {
        response_object.insert(
            "firstSurfaceExcludedOpdRmsUm".to_string(),
            serde_json::json!(if first_surface_excluded_opd_sample_count > 0 {
                Some((first_surface_excluded_opd_sum_sq_um
                    / first_surface_excluded_opd_sample_count as f64)
                    .sqrt())
            } else {
                None::<f64>
            }),
        );
        response_object.insert(
            "imagePlaneReferenceOpdRmsUm".to_string(),
            serde_json::json!(if image_plane_reference_sample_count > 0 {
                Some((image_plane_reference_opd_sum_sq_um
                    / image_plane_reference_sample_count as f64)
                    .sqrt())
            } else {
                None::<f64>
            }),
        );
        response_object.insert(
            "stopReferenceOpdRmsUm".to_string(),
            serde_json::json!(if stop_reference_sample_count > 0 {
                Some((stop_reference_opd_sum_sq_um
                    / stop_reference_sample_count as f64)
                    .sqrt())
            } else {
                None::<f64>
            }),
        );
        response_object.insert(
            "stopImageReferenceOpdRmsUm".to_string(),
            serde_json::json!(if stop_image_reference_sample_count > 0 {
                Some((stop_image_reference_opd_sum_sq_um
                    / stop_image_reference_sample_count as f64)
                    .sqrt())
            } else {
                None::<f64>
            }),
        );
    }
    Ok(response)
}

fn run_native_opd_map_value(req: &Value) -> Result<Value, JsValue> {
    run_native_opd_map_value_with_rows(req, None, None)
}

#[wasm_bindgen]
pub fn run_native_opd_map_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("invalid request json: {}", e)))?;
    let response = run_native_opd_map_value(&req)?;
    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    response
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("serialize error: {}", e)))
}

#[wasm_bindgen]
pub fn run_native_opd_rms_waves_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let map_value = run_native_opd_map_wasm_json(req_json)?;
    let map_response: NativeOpdMapWasmResponseForScalar = serde_wasm_bindgen::from_value(map_value)
        .map_err(|e| JsValue::from_str(&format!("run_native_opd_rms_waves_wasm_json: decode error: {}", e)))?;
    let rms_waves = compute_finite_opd_grid_rms_waves(&map_response.display_opd_grid)
        .ok_or_else(|| JsValue::from_str("run_native_opd_rms_waves_wasm_json: no finite OPD samples"))?;

    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    serde_json::json!({
        "backend": format!("{}+scalar-rms", map_response.backend),
        "chiefReferenceMode": map_response.chief_reference_mode,
        "transmittedPupilCenterUv": map_response.transmitted_pupil_center_uv,
        "chiefRayLaunchOrigin": map_response.chief_ray_launch_origin,
        "sampleRayLaunchOriginApplied": map_response.sample_ray_launch_origin_applied,
        "targetSurface": map_response.target_surface,
        "stopSurface": map_response.stop_surface,
        "requestedObjectIndex": map_response.requested_object_index,
        "usedObjectIndex": map_response.used_object_index,
        "usedObjectPosition": map_response.used_object_position,
        "usedObjectX": map_response.used_object_x,
        "usedObjectY": map_response.used_object_y,
        "wavelengthUm": map_response.wavelength_um,
        "gridSize": map_response.grid_size,
        "sampleCount": map_response.sample_count,
        "hitCount": map_response.hit_count,
        "referenceCorrectedSampleCount": map_response.reference_corrected_sample_count,
        "referenceOpdRmsUm": map_response.reference_opd_rms_um,
        "trackedOpdRmsUm": map_response.tracked_opd_rms_um,
        "beforeTargetTrackedOpdRmsUm": map_response.before_target_tracked_opd_rms_um,
        "targetSegmentOpdRmsUm": map_response.target_segment_opd_rms_um,
        "firstSurfaceOpdRmsUm": map_response.first_surface_opd_rms_um,
        "currentReferenceOpdRmsUm": map_response.current_reference_opd_rms_um,
        "alternateReferenceOpdRmsUm": map_response.alternate_reference_opd_rms_um,
        "targetOriginReferenceOpdRmsUm": map_response.target_origin_reference_opd_rms_um,
        "airReferenceOpdRmsUm": map_response.air_reference_opd_rms_um,
        "alternateSignReferenceOpdRmsUm": map_response.alternate_sign_reference_opd_rms_um,
        "axisReferenceSphereRmsUm": map_response.axis_reference_sphere_rms_um,
        "pupilSamplingMode": map_response.pupil_sampling_mode,
        "pupilMaskGrid": map_response.pupil_mask_grid,
        "referenceSphereOpdGrid": map_response.reference_sphere_opd_grid,
        "unreferencedOpdGrid": map_response.unreferenced_opd_grid,
        "displayFit": map_response.display_fit,
        "referenceSphereCenter": map_response.reference_sphere_center,
        "referenceSphereRadiusMm": map_response.reference_sphere_radius_mm,
        "referenceSphereDirection": map_response.reference_sphere_direction,
        "exitPupilCenter": map_response.exit_pupil_center,
        "rmsWaves": rms_waves,
        "message": format!("{} [native scalar RMS]", map_response.message),
    })
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("run_native_opd_rms_waves_wasm_json: serialize error: {}", e)))
}

#[wasm_bindgen]
pub fn run_native_chief_ray_angle_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("run_native_chief_ray_angle_wasm_json: invalid request json: {}", e)))?;
    let req_obj = req.as_object().ok_or_else(|| JsValue::from_str("run_native_chief_ray_angle_wasm_json: request must be an object"))?;

    let optical_system_rows = req_obj
        .get("opticalSystemRows")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| JsValue::from_str("run_native_chief_ray_angle_wasm_json: opticalSystemRows is required"))?;
    if optical_system_rows.is_empty() {
        return Err(JsValue::from_str("run_native_chief_ray_angle_wasm_json: opticalSystemRows is empty"));
    }

    let source_rows_raw = req_obj
        .get("sourceRows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let object_rows = req_obj
        .get("objectRows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if object_rows.is_empty() {
        return Err(JsValue::from_str("run_native_chief_ray_angle_wasm_json: objectRows is empty"));
    }

    let angle_deg = compute_native_chief_ray_angle_deg_wasm(&optical_system_rows, &source_rows_raw, &object_rows)
        .ok_or_else(|| JsValue::from_str("run_native_chief_ray_angle_wasm_json: chief ray angle calculation failed"))?;

    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    serde_json::json!({
        "backend": "web-rust-wasm",
        "chiefRayAngleDeg": angle_deg,
        "message": "Computed via Web Rust/WASM chief ray angle API",
    })
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("run_native_chief_ray_angle_wasm_json: serialize error: {}", e)))
}

#[wasm_bindgen]
pub fn run_native_paraxial_metrics_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("run_native_paraxial_metrics_wasm_json: invalid request json: {}", e)))?;
    let req_obj = req.as_object().ok_or_else(|| JsValue::from_str("run_native_paraxial_metrics_wasm_json: request must be an object"))?;

    let optical_system_rows = req_obj
        .get("opticalSystemRows")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| JsValue::from_str("run_native_paraxial_metrics_wasm_json: opticalSystemRows is required"))?;
    if optical_system_rows.is_empty() {
        return Err(JsValue::from_str("run_native_paraxial_metrics_wasm_json: opticalSystemRows is empty"));
    }

    let source_rows = req_obj
        .get("sourceRows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let object_rows = req_obj
        .get("objectRows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let metrics = compute_native_paraxial_metrics_wasm(&optical_system_rows, &source_rows, &object_rows);

    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    serde_json::json!({
        "backend": "web-rust-wasm",
        "metrics": metrics,
        "message": "Computed via Web Rust/WASM paraxial metrics API",
    })
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("run_native_paraxial_metrics_wasm_json: serialize error: {}", e)))
}

#[wasm_bindgen]
pub fn run_native_seidel_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("run_native_seidel_wasm_json: invalid request json: {}", e)))?;
    let req_obj = req.as_object().ok_or_else(|| JsValue::from_str("run_native_seidel_wasm_json: request must be an object"))?;

    let optical_system_rows = req_obj
        .get("opticalSystemRows")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| JsValue::from_str("run_native_seidel_wasm_json: opticalSystemRows is required"))?;
    if optical_system_rows.is_empty() {
        return Err(JsValue::from_str("run_native_seidel_wasm_json: opticalSystemRows is empty"));
    }

    let source_rows = req_obj
        .get("sourceRows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let object_rows = req_obj
        .get("objectRows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let afocal = req_obj
        .get("afocal")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let wavelength_um = req_obj
        .get("referenceWavelengthUm")
        .and_then(parse_numeric_json)
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or_else(|| {
            source_rows
                .iter()
                .filter_map(|row| row.as_object())
                .find_map(|obj| {
                    parse_numeric_json(
                        obj.get("wavelength")
                            .or_else(|| obj.get("Wavelength"))
                            .unwrap_or(&Value::Null),
                    )
                    .filter(|v| v.is_finite() && *v > 0.0)
                })
                .unwrap_or(0.587_561_8)
        });

    let stop_surface_index = detect_stop_surface_index_json(&optical_system_rows).unwrap_or(1);
    let wavelength_range = detect_wavelength_range_json(&source_rows);
    let (surface_coefficients, totals) = compute_seidel_surface_coefficients_json(
        &optical_system_rows,
        stop_surface_index,
        afocal,
        wavelength_um,
        wavelength_range,
    );
    let _ = object_rows;

    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    serde_json::json!({
        "backend": "web-rust-wasm",
        "totals": totals,
        "surfaceCoefficients": surface_coefficients,
        "stopSurfaceIndex": stop_surface_index,
        "wavelengthUm": wavelength_um,
        "message": "Computed via Web Rust/WASM Seidel API",
    })
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("run_native_seidel_wasm_json: serialize error: {}", e)))
}

#[wasm_bindgen]
pub fn compute_native_opd_grid_rms_waves_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: NativeOpdGridScalarRmsRequest = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("compute_native_opd_grid_rms_waves_wasm_json: JSON parse: {}", e)))?;
    let rms_waves = compute_finite_opd_grid_rms_waves(&req.display_opd_grid)
        .ok_or_else(|| JsValue::from_str("compute_native_opd_grid_rms_waves_wasm_json: no finite OPD samples"))?;

    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    serde_json::json!({
        "backend": "rust-wasm-grid-scalar-rms",
        "rmsWaves": rms_waves,
    })
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("compute_native_opd_grid_rms_waves_wasm_json: serialize error: {}", e)))
}

#[wasm_bindgen]
pub fn run_native_distortion_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("run_native_distortion_wasm_json: JSON parse: {}", e)))?;
    let req_obj = req
        .as_object()
        .ok_or_else(|| JsValue::from_str("run_native_distortion_wasm_json: request must be an object"))?;

    let rows_raw = req_obj
        .get("opticalSystemRows")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| JsValue::from_str("run_native_distortion_wasm_json: opticalSystemRows is required"))?;
    if rows_raw.is_empty() {
        return Err(JsValue::from_str("run_native_distortion_wasm_json: opticalSystemRows is empty"));
    }
    let rows: Vec<Value> = rows_raw.iter().map(normalize_coord_trans_row).collect();

    let field_samples: Vec<f64> = req_obj
        .get("fieldSamples")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(value_to_f64).filter(|v| v.is_finite()).collect())
        .unwrap_or_default();
    if field_samples.is_empty() {
        return Err(JsValue::from_str("run_native_distortion_wasm_json: fieldSamples is empty"));
    }

    let source_rows = req_obj
        .get("sourceRows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let object_rows = req_obj
        .get("objectRows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let wavelength = req_obj
        .get("wavelength")
        .or_else(|| req_obj.get("wavelengthUm"))
        .and_then(value_to_f64)
        .filter(|w| w.is_finite() && *w > 0.0)
        .unwrap_or_else(|| get_primary_wavelength_um_native(&source_rows, 0.5876));
    let imageheight_mode = object_rows.iter().any(|row| {
        let tag = get_field(row, "position")
            .or_else(|| get_field(row, "objectType"))
            .or_else(|| get_field(row, "type"))
            .and_then(value_to_string)
            .unwrap_or_default()
            .to_ascii_lowercase();
        tag.contains("imageheight")
    });
    let height_mode = req_obj
        .get("heightMode")
        .and_then(|v| match v {
            Value::Bool(b) => Some(*b),
            Value::Number(n) => Some(n.as_i64().unwrap_or(0) != 0),
            Value::String(s) => {
                let t = s.trim().to_ascii_lowercase();
                Some(t == "true" || t == "1" || t == "yes")
            }
            _ => None,
        })
        .unwrap_or(false);
    let distortion_metric = req_obj
        .get("distortionMetric")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s == "chief-ray" || s == "spot-gravity")
        .unwrap_or_else(|| "chief-ray".to_string());
    if distortion_metric == "spot-gravity" {
        return Err(JsValue::from_str(
            "run_native_distortion_wasm_json: spot-gravity is not supported in direct API; use spot fallback",
        ));
    }

    let surface_index = req_obj
        .get("surfaceIndex")
        .and_then(value_to_f64)
        .map(|v| v.max(0.0) as usize)
        .unwrap_or_else(|| find_eval_surface_index(&rows))
        .min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index(&rows).min(rows.len().saturating_sub(1));

    let finite = !is_infinite_conjugate_native(&rows);
    let object_distance = rows
        .first()
        .and_then(|row| get_field(row, "thickness").or_else(|| get_field(row, "distance")))
        .and_then(value_to_f64)
        .unwrap_or(0.0)
        .abs()
        .max(1e-6);

    let mirror_sign = distortion_mirror_sign(&rows);
    let (packed, object_space_n) = build_trace_packed_meta_for_wavelength(&rows, wavelength, surface_index);

    let paraxial_trace = calculate_full_system_paraxial_trace_json(&rows);
    let paraxial_focal_length = paraxial_trace
        .as_ref()
        .map(|t| t.focal_length_mm)
        .filter(|v| v.is_finite() && v.abs() > 1e-12);
    let focal_length = paraxial_focal_length
        .ok_or_else(|| JsValue::from_str("run_native_distortion_wasm_json: failed to resolve paraxial focal length"))?;

    let magnification = -1.0_f64;

    let mut real_heights = Vec::with_capacity(field_samples.len());
    let mut ideal_heights = Vec::with_capacity(field_samples.len());
    let mut distortion = Vec::with_capacity(field_samples.len());
    let mut distortion_percent = Vec::with_capacity(field_samples.len());

    for field in &field_samples {
        let trace_as_height_mode = height_mode && finite && !imageheight_mode;
        let trace_field_value = if height_mode && (!finite || imageheight_mode) {
            (field / focal_length).atan().to_degrees()
        } else {
            *field
        };
        let y_real = trace_distortion_chief_y_mm(
            &rows,
            &packed,
            object_space_n,
            wavelength,
            stop_surface_index,
            surface_index,
            trace_field_value,
            trace_as_height_mode,
            finite,
            object_distance,
        )
        .map(|y| (y * mirror_sign).abs());
        real_heights.push(y_real);

        let w_paraxial_rad = if height_mode {
            if !finite || imageheight_mode {
                (field / focal_length).atan()
            } else {
                let object_distance_abs = object_distance.abs();
                if object_distance_abs > 1e-12 {
                    (field / object_distance_abs).atan()
                } else {
                    0.0
                }
            }
        } else {
            field.to_radians()
        };
        let h_ideal = focal_length * w_paraxial_rad.tan();
        ideal_heights.push(h_ideal);

        let d = if h_ideal.abs() < 1e-12 {
            Some(0.0)
        } else if let Some(h_real) = y_real {
            Some((h_real - h_ideal) / h_ideal)
        } else {
            None
        };
        distortion.push(d);
        distortion_percent.push(d.map(|v| v * 100.0));
    }

    let response = serde_json::json!({
        "backend": "web-rust-wasm-native-distortion-api",
        "fieldValues": field_samples,
        "idealHeights": ideal_heights,
        "realHeights": real_heights,
        "distortion": distortion,
        "distortionPercent": distortion_percent,
        "meta": {
            "wavelength": wavelength,
            "focalLength": focal_length,
            "paraxialFocalLength": paraxial_focal_length,
            "finiteSystem": finite,
            "heightMode": height_mode,
            "imageHeightMode": imageheight_mode,
            "magnification": magnification,
            "paraxialReferenceMode": "strict-paraxial-trace",
            "paraxialAngleUnit": "radian",
            "idealHeightFormula": "tan(w_paraxial_rad) * EFL",
            "distortionDefinition": distortion_metric,
            "mirrorSign": mirror_sign,
            "surfaceIndex": surface_index,
            "stopSurfaceIndex": stop_surface_index,
        },
        "message": "Computed via Rust-WASM native distortion API"
    });

    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    response
        .serialize(&serializer)
        .map_err(|e| JsValue::from_str(&format!("run_native_distortion_wasm_json: serialize error: {}", e)))
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

// ─────────────────────────────────────────────────────────────────────────────
// PSF / MTF WASM helpers (mirrors src-tauri/src/commands/optics.rs logic)
// ─────────────────────────────────────────────────────────────────────────────

/// Internal 2D forward FFT on Vec<Vec<f64>> (in-place style via clone).
fn fft2d_forward_internal(
    real: &[Vec<f64>],
    imag: &[Vec<f64>],
) -> Result<(Vec<Vec<f64>>, Vec<Vec<f64>>), String> {
    use num_complex::Complex;
    use rustfft::FftPlanner;

    let n = real.len();
    if n == 0 {
        return Err("fft2d_forward_internal: empty input".to_string());
    }
    let m = real[0].len();
    if imag.len() != n {
        return Err("fft2d_forward_internal: real/imag height mismatch".to_string());
    }

    let mut data: Vec<Complex<f64>> = Vec::with_capacity(n * m);
    for y in 0..n {
        if real[y].len() != m || imag[y].len() != m {
            return Err("fft2d_forward_internal: non-rectangular input".to_string());
        }
        for x in 0..m {
            data.push(Complex::new(real[y][x], imag[y][x]));
        }
    }

    let mut planner = FftPlanner::new();

    // Row-wise FFT
    let row_fft = planner.plan_fft_forward(m);
    for row in 0..n {
        let start = row * m;
        row_fft.process(&mut data[start..start + m]);
    }

    // Transpose
    let mut transposed = vec![Complex::new(0.0, 0.0); n * m];
    for i in 0..n {
        for j in 0..m {
            transposed[j * n + i] = data[i * m + j];
        }
    }
    data = transposed;

    // Column-wise FFT (on transposed data)
    let col_fft = planner.plan_fft_forward(n);
    for col in 0..m {
        let start = col * n;
        col_fft.process(&mut data[start..start + n]);
    }

    // Transpose back
    let mut result = vec![Complex::new(0.0, 0.0); n * m];
    for i in 0..m {
        for j in 0..n {
            result[j * m + i] = data[i * n + j];
        }
    }

    let mut out_real = vec![vec![0.0_f64; m]; n];
    let mut out_imag = vec![vec![0.0_f64; m]; n];
    for y in 0..n {
        for x in 0..m {
            out_real[y][x] = result[y * m + x].re;
            out_imag[y][x] = result[y * m + x].im;
        }
    }
    Ok((out_real, out_imag))
}

/// Zero-pad a complex (real, imag) pair to target_size × target_size.
fn zero_pad_complex_internal(
    real: &[Vec<f64>],
    imag: &[Vec<f64>],
    target: usize,
) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
    let n = real.len();
    let m = if n > 0 { real[0].len() } else { 0 };
    let out_n = target.max(n);
    let out_m = target.max(m);

    let mut out_real = vec![vec![0.0_f64; out_m]; out_n];
    let mut out_imag = vec![vec![0.0_f64; out_m]; out_n];

    for y in 0..n.min(out_n) {
        for x in 0..m.min(out_m) {
            out_real[y][x] = real[y][x];
            out_imag[y][x] = imag[y][x];
        }
    }
    (out_real, out_imag)
}

/// FFT-shift: move DC from [0,0] to the centre of the grid.
fn fft_shift_2d_internal(data: Vec<Vec<f64>>) -> Vec<Vec<f64>> {
    let n = data.len();
    if n == 0 {
        return data;
    }
    let m = data[0].len();
    let shift_y = n / 2;
    let shift_x = m / 2;

    let mut out = vec![vec![0.0_f64; m]; n];
    for y in 0..n {
        for x in 0..m {
            let ny = (y + shift_y) % n;
            let nx = (x + shift_x) % m;
            out[ny][nx] = data[y][x];
        }
    }
    out
}

/// Linearly interpolate a sorted (freq, val) curve at target_x.
fn interp_linear_internal(freq: &[f64], vals: &[f64], x: f64) -> f64 {
    if freq.is_empty() {
        return 0.0;
    }
    if x <= freq[0] {
        return vals[0];
    }
    let last = freq.len() - 1;
    if x >= freq[last] {
        return vals[last];
    }
    for i in 1..freq.len() {
        let x0 = freq[i - 1];
        let x1 = freq[i];
        if x <= x1 && x1 > x0 {
            let t = (x - x0) / (x1 - x0);
            return vals[i - 1] + t * (vals[i] - vals[i - 1]);
        }
    }
    vals[last]
}

fn dft_magnitude_at_integer_index_internal(samples: &[f64], k: usize) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let n = samples.len() as f64;
    let kk = k as f64;
    let mut re = 0.0_f64;
    let mut im = 0.0_f64;
    for (i, v) in samples.iter().copied().enumerate() {
        let vv = if v.is_finite() { v } else { 0.0 };
        let phase = -2.0 * std::f64::consts::PI * kk * (i as f64) / n;
        re += vv * phase.cos();
        im += vv * phase.sin();
    }
    re.hypot(im)
}

fn sample_lsf_mtf_like_fft_bins_internal(lsf: &[f64], freq_lpmm: f64, df_lpmm: f64, nyquist_lpmm: f64, dc: f64) -> f64 {
    if lsf.is_empty() || !(dc.is_finite() && dc > 0.0) {
        return 0.0;
    }
    let f = freq_lpmm.max(0.0).min(nyquist_lpmm);
    if f <= 1e-12 {
        return 1.0;
    }
    let idx = f / df_lpmm.max(1e-12);
    let max_k = lsf.len() / 2;
    let k0 = (idx.floor() as usize).min(max_k);
    let k1 = (k0 + 1).min(max_k);
    let v0 = (dft_magnitude_at_integer_index_internal(lsf, k0) / dc).clamp(0.0, 1.0);
    if k1 == k0 {
        return v0;
    }
    let v1 = (dft_magnitude_at_integer_index_internal(lsf, k1) / dc).clamp(0.0, 1.0);
    let t = (idx - k0 as f64).clamp(0.0, 1.0);
    (v0 + (v1 - v0) * t).clamp(0.0, 1.0)
}

/// Compute PSF from an OPD map grid (grids are in *waves*, nulls = outside pupil).
/// Matches the Tauri-native `run_native_psf_map` logic.
///
/// Input JSON:
/// ```json
/// {
///   "rawOpdGrid":     (number|null)[][],  // OPD in waves; null = outside pupil
///   "displayOpdGrid": (number|null)[][],  // preferred display OPD (same units)
///   "wavelengthUm":   number,
///   "pixelSizeUm":    number,
///   "zeroPadTo":      number,             // 0 = use grid size
///   "removeTilt":     bool               // default false
/// }
/// ```
/// Output JSON: `{ backend, gridSize, fftSize, psfData: number[][], message }`
fn run_native_psf_from_opd_value(req: &Value) -> Result<Value, JsValue> {
    use std::f64::consts::PI;

    // ── Extract inputs ────────────────────────────────────────────────────────
    let raw_opd_arr = req
        .get("rawOpdGrid")
        .and_then(|v| v.as_array())
        .ok_or_else(|| JsValue::from_str("run_native_psf_from_opd_wasm_json: rawOpdGrid missing"))?;

    let display_opd_arr = req
        .get("displayOpdGrid")
        .and_then(|v| v.as_array())
        .or_else(|| req.get("rawOpdGrid").and_then(|v| v.as_array()));

    let wavelength_um = req
        .get("wavelengthUm")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or_else(|| JsValue::from_str("run_native_psf_from_opd_wasm_json: wavelengthUm must be > 0"))?;

    let pixel_size_um = req
        .get("pixelSizeUm")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);

    let zero_pad_to = req
        .get("zeroPadTo")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;

    let _remove_tilt = req
        .get("removeTilt")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let grid_n = raw_opd_arr.len();
    if grid_n == 0 {
        return Err(JsValue::from_str(
            "run_native_psf_from_opd_wasm_json: rawOpdGrid is empty",
        ));
    }

    // ── Build complex pupil ───────────────────────────────────────────────────
    // phase = −2π × opd_um / λ_um  =  −2π × opd_waves
    let phase_scale = -2.0 * PI / wavelength_um;

    let mut real_grid = vec![vec![0.0_f64; grid_n]; grid_n];
    let mut imag_grid = vec![vec![0.0_f64; grid_n]; grid_n];
    let mut n_pupil: usize = 0;

    for iy in 0..grid_n {
        let row_raw = raw_opd_arr.get(iy).and_then(|r| r.as_array());
        let row_display = display_opd_arr.and_then(|d| d.get(iy)).and_then(|r| r.as_array());
        let row_len = row_raw.map(|r| r.len()).unwrap_or(0);

        for ix in 0..row_len.min(grid_n) {
            // null / missing → outside pupil → skip (correct null handling)
            let v_raw = match row_raw.and_then(|r| r.get(ix)).and_then(|v| v.as_f64()) {
                Some(v) if v.is_finite() => v,
                _ => continue,
            };

            // Prefer display value (piston/tilt removed)
            let v_waves = row_display
                .and_then(|r| r.get(ix))
                .and_then(|v| v.as_f64())
                .filter(|v| v.is_finite())
                .unwrap_or(v_raw);

            // OPD in waves → phase  (amplitude = 1 for all valid pupil points)
            let opd_um = v_waves * wavelength_um;
            let phase = phase_scale * opd_um;
            real_grid[iy][ix] = phase.cos();
            imag_grid[iy][ix] = phase.sin();
            n_pupil += 1;
        }
    }

    // ── Zero-pad and FFT ──────────────────────────────────────────────────────
    let fft_size = zero_pad_to.max(grid_n);
    let (pad_real, pad_imag) = if fft_size > grid_n {
        zero_pad_complex_internal(&real_grid, &imag_grid, fft_size)
    } else {
        (real_grid, imag_grid)
    };

    let (fft_real, fft_imag) =
        fft2d_forward_internal(&pad_real, &pad_imag).map_err(|e| JsValue::from_str(&e))?;

    // ── Intensity, normalise, fftShift ────────────────────────────────────────
    let mut intensity = vec![vec![0.0_f64; fft_size]; fft_size];
    let mut peak = 0.0_f64;
    let mut total_energy = 0.0_f64;
    for y in 0..fft_size {
        for x in 0..fft_size {
            let re = fft_real[y][x];
            let im = fft_imag[y][x];
            let v = re * re + im * im;
            intensity[y][x] = v;
            total_energy += v;
            if v > peak {
                peak = v;
            }
        }
    }

    // Strehl = actual_peak / ideal_peak where ideal_peak = n_pupil² (unnormalized FFT)
    let ideal_peak = (n_pupil as f64) * (n_pupil as f64);
    let strehl_ratio = if ideal_peak > 0.0 {
        (peak / ideal_peak).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let total_energy_norm = if peak > 0.0 { total_energy / peak } else { 0.0 };

    if peak > 0.0 {
        for row in &mut intensity {
            for v in row.iter_mut() {
                *v /= peak;
            }
        }
    }

    let psf = fft_shift_2d_internal(intensity);

    // ── Metrics: FWHM from shifted PSF profiles ───────────────────────────────
    let (psf_peak_y, psf_peak_x) = {
        let mut py = fft_size / 2;
        let mut px = fft_size / 2;
        let mut pv = 0.0_f64;
        for y in 0..fft_size {
            for x in 0..fft_size {
                if psf[y][x] > pv {
                    pv = psf[y][x];
                    py = y;
                    px = x;
                }
            }
        }
        (py, px)
    };

    let half_max = 0.5_f64; // PSF is normalized to 1.0 at peak
    let fwhm_pixels = |profile: &[f64], center: usize| -> f64 {
        if profile.is_empty() {
            return 0.0;
        }
        let mut left = center;
        let mut right = center;
        for i in (0..=center.min(profile.len().saturating_sub(1))).rev() {
            if profile[i] < half_max {
                left = i;
                break;
            }
        }
        for i in center..profile.len() {
            if profile[i] < half_max {
                right = i;
                break;
            }
        }
        right.saturating_sub(left) as f64
    };

    let x_profile: &[f64] = if psf_peak_y < fft_size { &psf[psf_peak_y] } else { &[] };
    let y_profile: Vec<f64> = (0..fft_size).map(|yy| if yy < psf.len() && psf_peak_x < psf[yy].len() { psf[yy][psf_peak_x] } else { 0.0 }).collect();
    let fwhm_x = fwhm_pixels(x_profile, psf_peak_x) * pixel_size_um;
    let fwhm_y = fwhm_pixels(&y_profile, psf_peak_y) * pixel_size_um;
    let fwhm_avg = (fwhm_x + fwhm_y) * 0.5;

    Ok(serde_json::json!({
        "backend": "web-rust-wasm-psf",
        "gridSize": grid_n,
        "fftSize": fft_size,
        "pixelSizeUm": pixel_size_um,
        "psfData": psf,
        "metrics": {
            "strehlRatio": strehl_ratio,
            "fwhm": {
                "x": fwhm_x,
                "y": fwhm_y,
                "average": fwhm_avg
            },
            "peakIntensity": 1.0,
            "totalEnergy": total_energy_norm
        },
        "strehlRatio": strehl_ratio,
        "message": "Computed via WASM PSF (run_native_psf_from_opd_wasm_json)"
    }))
}

#[wasm_bindgen]
pub fn run_native_psf_from_opd_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("run_native_psf_from_opd_wasm_json: JSON parse: {}", e)))?;
    let response = run_native_psf_from_opd_value(&req)?;
    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    response
    .serialize(&serializer)
    .map_err(|e| JsValue::from_str(&format!("serialize error: {}", e)))
}

/// Compute sagittal & tangential MTF from a (fft-shifted) PSF grid.
/// Matches the Tauri-native `run_native_mtf_map` logic.
///
/// Input JSON:
/// ```json
/// {
///   "psfData":             number[][],
///   "pixelSizeUm":         number,
///   "maxFrequencyLpmm":    number,    // optional; default = Nyquist
///   "targetFrequencyLpmm": number,    // optional; if given, interpolated values are included
///   "points":              number     // default 121
/// }
/// ```
/// Output JSON:
/// ```json
/// {
///   "frequencyAxis": number[], "mtfTangential": number[], "mtfSagittal": number[],
///   "nyquistLpmm": number,
///   "targetMtfTangential": number|null, "targetMtfSagittal": number|null
/// }
/// ```
fn run_native_mtf_from_psf_value(req: &Value) -> Result<Value, JsValue> {
    let psf_data = req
        .get("psfData")
        .and_then(|v| v.as_array())
        .ok_or_else(|| JsValue::from_str("run_native_mtf_from_psf_wasm_json: psfData missing"))?;

    let pixel_size_um = req
        .get("pixelSizeUm")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or_else(|| JsValue::from_str("run_native_mtf_from_psf_wasm_json: pixelSizeUm must be > 0"))?;

    let n = psf_data.len();
    if n == 0 {
        return Err(JsValue::from_str(
            "run_native_mtf_from_psf_wasm_json: psfData is empty",
        ));
    }

    let out_points = req
        .get("points")
        .and_then(|v| v.as_u64())
        .unwrap_or(121)
        .clamp(2, 1024) as usize;

    let nyquist_lpmm = (0.5 / pixel_size_um) * 1000.0;
    let max_freq_lpmm = req
        .get("maxFrequencyLpmm")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(nyquist_lpmm);

    let target_freq = req
        .get("targetFrequencyLpmm")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v >= 0.0);
    let sample_frequencies_lpmm = req
        .get("sampleFrequenciesLpmm")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_f64())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .map(|v| v.min(nyquist_lpmm))
                .collect::<Vec<f64>>()
        })
        .unwrap_or_default();
    let direct_eval_only = req
        .get("directEvalOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        && !sample_frequencies_lpmm.is_empty();

    // ── Build PSF grid ────────────────────────────────────────────────────────
    let mut psf_real = vec![vec![0.0_f64; n]; n];
    for y in 0..n {
        let row = psf_data.get(y).and_then(|r| r.as_array());
        for x in 0..n {
            let v = row
                .and_then(|r| r.get(x))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            psf_real[y][x] = if v.is_finite() { v } else { 0.0 };
        }
    }

    if direct_eval_only && !sample_frequencies_lpmm.is_empty() {
        let mut lsf_x = vec![0.0_f64; n];
        let mut lsf_y = vec![0.0_f64; n];
        for y in 0..n {
            for x in 0..n {
                let v = psf_real[y][x];
                lsf_x[x] += v;
                lsf_y[y] += v;
            }
        }
        let dc = lsf_x.iter().copied().sum::<f64>().abs().max(1e-12);
        let df_lpmm = (1.0 / (n as f64 * pixel_size_um)) * 1000.0;

        let mut sampled_tan = sample_frequencies_lpmm
            .iter()
            .map(|f| sample_lsf_mtf_like_fft_bins_internal(&lsf_y, *f, df_lpmm, nyquist_lpmm, dc))
            .collect::<Vec<f64>>();
        let mut sampled_sag = sample_frequencies_lpmm
            .iter()
            .map(|f| sample_lsf_mtf_like_fft_bins_internal(&lsf_x, *f, df_lpmm, nyquist_lpmm, dc))
            .collect::<Vec<f64>>();
        for (idx, f) in sample_frequencies_lpmm.iter().enumerate() {
            if *f <= 1e-12 {
                if let Some(v) = sampled_tan.get_mut(idx) { *v = 1.0; }
                if let Some(v) = sampled_sag.get_mut(idx) { *v = 1.0; }
            }
        }

        let (target_tan, target_sag) = target_freq
            .map(|tf| {
                (
                    sample_lsf_mtf_like_fft_bins_internal(&lsf_y, tf, df_lpmm, nyquist_lpmm, dc),
                    sample_lsf_mtf_like_fft_bins_internal(&lsf_x, tf, df_lpmm, nyquist_lpmm, dc),
                )
            })
            .map(|(t, s)| (Value::from(t), Value::from(s)))
            .unwrap_or((Value::Null, Value::Null));

        return Ok(serde_json::json!({
            "backend": "web-rust-wasm-mtf-direct-lsf",
            "frequencyAxis": Vec::<f64>::new(),
            "mtfTangential": Vec::<f64>::new(),
            "mtfSagittal": Vec::<f64>::new(),
            "sampledFrequenciesLpmm": Value::from(sample_frequencies_lpmm),
            "sampledMtfTangential": Value::from(sampled_tan),
            "sampledMtfSagittal": Value::from(sampled_sag),
            "nyquistLpmm": nyquist_lpmm,
            "targetMtfTangential": target_tan,
            "targetMtfSagittal": target_sag,
            "message": "Computed via WASM direct sampled MTF (LSF DFT)",
        }));
    }

    let psf_imag = vec![vec![0.0_f64; n]; n];

    // ── OTF = FFT(PSF) ────────────────────────────────────────────────────────
    let (otf_real, otf_imag) =
        fft2d_forward_internal(&psf_real, &psf_imag).map_err(|e| JsValue::from_str(&e))?;

    let dc_re = otf_real[0][0];
    let dc_im = otf_imag[0][0];
    let dc = dc_re.hypot(dc_im).max(1e-12);

    // ── Sample axes ───────────────────────────────────────────────────────────
    let df_lpmm = (1.0 / (n as f64 * pixel_size_um)) * 1000.0;
    let max_sample_freq_lpmm = sample_frequencies_lpmm
        .iter()
        .copied()
        .fold(0.0_f64, f64::max);
    let required_freq_lpmm = max_freq_lpmm.max(max_sample_freq_lpmm + df_lpmm);
    let k_max = ((required_freq_lpmm / df_lpmm.max(1e-12)).ceil() as usize).min(n / 2);

    let mut freq_raw: Vec<f64> = Vec::with_capacity(k_max + 1);
    let mut tan_raw: Vec<f64> = Vec::with_capacity(k_max + 1);
    let mut sag_raw: Vec<f64> = Vec::with_capacity(k_max + 1);

    for k in 0..=k_max {
        let f = k as f64 * df_lpmm;
        let re_x = otf_real[0][k];
        let im_x = otf_imag[0][k];
        let re_y = otf_real[k][0];
        let im_y = otf_imag[k][0];
        freq_raw.push(f);
        sag_raw.push((re_x.hypot(im_x) / dc).clamp(0.0, 1.0));
        tan_raw.push((re_y.hypot(im_y) / dc).clamp(0.0, 1.0));
    }
    if !tan_raw.is_empty() {
        tan_raw[0] = 1.0;
    }
    if !sag_raw.is_empty() {
        sag_raw[0] = 1.0;
    }

    // ── Resample to output axis ───────────────────────────────────────────────
    let mut freq_axis: Vec<f64> = Vec::with_capacity(out_points);
    let mut tan_out: Vec<f64> = Vec::with_capacity(out_points);
    let mut sag_out: Vec<f64> = Vec::with_capacity(out_points);
    if !direct_eval_only {
        for i in 0..out_points {
            let f = max_freq_lpmm * (i as f64) / ((out_points - 1) as f64);
            freq_axis.push(f);
            tan_out.push(interp_linear_internal(&freq_raw, &tan_raw, f));
            sag_out.push(interp_linear_internal(&freq_raw, &sag_raw, f));
        }
        if !tan_out.is_empty() {
            tan_out[0] = 1.0;
        }
        if !sag_out.is_empty() {
            sag_out[0] = 1.0;
        }
    }

    let mut sampled_tan = if sample_frequencies_lpmm.is_empty() {
        Vec::<f64>::new()
    } else {
        sample_frequencies_lpmm
            .iter()
            .map(|f| interp_linear_internal(&freq_raw, &tan_raw, *f).clamp(0.0, 1.0))
            .collect::<Vec<f64>>()
    };
    let mut sampled_sag = if sample_frequencies_lpmm.is_empty() {
        Vec::<f64>::new()
    } else {
        sample_frequencies_lpmm
            .iter()
            .map(|f| interp_linear_internal(&freq_raw, &sag_raw, *f).clamp(0.0, 1.0))
            .collect::<Vec<f64>>()
    };
    for (idx, f) in sample_frequencies_lpmm.iter().enumerate() {
        if *f <= 1e-12 {
            if let Some(v) = sampled_tan.get_mut(idx) { *v = 1.0; }
            if let Some(v) = sampled_sag.get_mut(idx) { *v = 1.0; }
        }
    }

    // Optional single-point extraction at targetFrequencyLpmm
    let (target_tan, target_sag) = target_freq
        .map(|tf| {
            (
                interp_linear_internal(&freq_raw, &tan_raw, tf),
                interp_linear_internal(&freq_raw, &sag_raw, tf),
            )
        })
        .map(|(t, s)| (Value::from(t), Value::from(s)))
        .unwrap_or((Value::Null, Value::Null));

    Ok(serde_json::json!({
        "backend": "web-rust-wasm-mtf",
        "frequencyAxis": freq_axis,
        "mtfTangential": tan_out,
        "mtfSagittal":   sag_out,
        "sampledFrequenciesLpmm": if sample_frequencies_lpmm.is_empty() { Value::Null } else { Value::from(sample_frequencies_lpmm) },
        "sampledMtfTangential": if sampled_tan.is_empty() { Value::Null } else { Value::from(sampled_tan) },
        "sampledMtfSagittal": if sampled_sag.is_empty() { Value::Null } else { Value::from(sampled_sag) },
        "nyquistLpmm":   nyquist_lpmm,
        "targetMtfTangential": target_tan,
        "targetMtfSagittal":   target_sag,
        "message": "Computed via WASM MTF (run_native_mtf_from_psf_wasm_json)"
    }))
}

#[wasm_bindgen]
pub fn run_native_mtf_from_psf_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("run_native_mtf_from_psf_wasm_json: JSON parse: {}", e)))?;
    let response = run_native_mtf_from_psf_value(&req)?;
    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    response
    .serialize(&serializer)
    .map_err(|e| JsValue::from_str(&format!("serialize error: {}", e)))
}

/// Compute MTF with Malacara/Hopkins-style pupil autocorrelation directly from OPD grid.
/// This is intended for strict Rust/WASM-only MTF in web runtime (no JS fallback).
fn run_native_mtf_malacara_from_opd_value(req: &Value) -> Result<Value, JsValue> {
    let display_opd = req
        .get("displayOpdGrid")
        .and_then(|v| v.as_array())
        .or_else(|| req.get("rawOpdGrid").and_then(|v| v.as_array()))
        .ok_or_else(|| JsValue::from_str("run_native_mtf_malacara_from_opd_wasm_json: displayOpdGrid/rawOpdGrid missing"))?;

    let n = display_opd.len();
    if n < 2 {
        return Err(JsValue::from_str(
            "run_native_mtf_malacara_from_opd_wasm_json: OPD grid must be at least 2x2",
        ));
    }

    let wavelength_um = req
        .get("wavelengthUm")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or_else(|| JsValue::from_str("run_native_mtf_malacara_from_opd_wasm_json: wavelengthUm must be > 0"))?;

    let f_number = req
        .get("fNumber")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v > 0.0)
        .ok_or_else(|| JsValue::from_str("run_native_mtf_malacara_from_opd_wasm_json: fNumber must be > 0"))?;

    let pupil_range = req
        .get("pupilRange")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);

    let max_freq_lpmm = req
        .get("maxFrequencyLpmm")
        .and_then(|v| v.as_f64())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(0.0);

    let out_points = req
        .get("points")
        .and_then(|v| v.as_u64())
        .unwrap_or(121)
        .clamp(2, 2048) as usize;
    let sampled_frequencies_lpmm = req
        .get("sampleFrequenciesLpmm")
        .and_then(|v| v.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_f64())
                .filter(|value| value.is_finite() && *value >= 0.0)
                .collect::<Vec<f64>>()
        })
        .unwrap_or_default();
    let direct_eval_only = req
        .get("directEvalOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        && !sampled_frequencies_lpmm.is_empty();

    let dir_from_req = |name: &str, default_x: f64, default_y: f64| -> (f64, f64) {
        if let Some(obj) = req.get(name).and_then(|v| v.as_object()) {
            let x = obj.get("x").and_then(|v| v.as_f64()).unwrap_or(default_x);
            let y = obj.get("y").and_then(|v| v.as_f64()).unwrap_or(default_y);
            let norm = x.hypot(y);
            if norm > 1e-12 {
                return (x / norm, y / norm);
            }
        }
        (default_x, default_y)
    };

    let (tan_x, tan_y) = dir_from_req("tangentialDir", 1.0, 0.0);
    let (sag_x, sag_y) = dir_from_req("sagittalDir", -tan_y, tan_x);

    let amp_opt = req.get("amplitudeGrid").and_then(|v| v.as_array());

    let mut re_grid = vec![vec![0.0_f64; n]; n];
    let mut im_grid = vec![vec![0.0_f64; n]; n];
    let mut denom = 0.0_f64;

    for iy in 0..n {
        let opd_row = display_opd.get(iy).and_then(|r| r.as_array());
        let amp_row = amp_opt.and_then(|rows| rows.get(iy)).and_then(|r| r.as_array());
        for ix in 0..n {
            let opd_val = opd_row
                .and_then(|r| r.get(ix))
                .and_then(|v| v.as_f64());
            let Some(opd_um) = opd_val else {
                continue;
            };
            if !opd_um.is_finite() {
                continue;
            }
            let amp = amp_row
                .and_then(|r| r.get(ix))
                .and_then(|v| v.as_f64())
                .filter(|v| v.is_finite())
                .unwrap_or(1.0)
                .max(0.0);
            if amp <= 0.0 {
                continue;
            }
            let phase = (2.0 * std::f64::consts::PI * opd_um) / wavelength_um;
            let re = amp * phase.cos();
            let im = amp * phase.sin();
            re_grid[iy][ix] = re;
            im_grid[iy][ix] = im;
            denom += re * re + im * im;
        }
    }

    if !(denom.is_finite() && denom > 0.0) {
        return Err(JsValue::from_str(
            "run_native_mtf_malacara_from_opd_wasm_json: no valid pupil samples",
        ));
    }

    let cutoff_lpmm = 1000.0 / (wavelength_um * f_number);
    if !(cutoff_lpmm.is_finite() && cutoff_lpmm > 0.0) {
        return Err(JsValue::from_str(
            "run_native_mtf_malacara_from_opd_wasm_json: invalid diffraction cutoff",
        ));
    }
    let axis_max_lpmm = if max_freq_lpmm > 0.0 {
        max_freq_lpmm.min(cutoff_lpmm)
    } else {
        cutoff_lpmm
    };

    let x_min = -pupil_range;
    let x_max = pupil_range;
    let y_min = -pupil_range;
    let y_max = pupil_range;
    let inv_dx = (n - 1) as f64 / (x_max - x_min).max(1e-12);
    let inv_dy = (n - 1) as f64 / (y_max - y_min).max(1e-12);

    let sample_complex_bilinear = |x: f64, y: f64, re_src: &Vec<Vec<f64>>, im_src: &Vec<Vec<f64>>| -> (f64, f64) {
        if x < x_min || x > x_max || y < y_min || y > y_max {
            return (0.0, 0.0);
        }
        let u = (x - x_min) * inv_dx;
        let v = (y - y_min) * inv_dy;
        let x0 = u.floor().clamp(0.0, (n - 1) as f64) as usize;
        let y0 = v.floor().clamp(0.0, (n - 1) as f64) as usize;
        let x1 = (x0 + 1).min(n - 1);
        let y1 = (y0 + 1).min(n - 1);
        let tx = (u - x0 as f64).clamp(0.0, 1.0);
        let ty = (v - y0 as f64).clamp(0.0, 1.0);

        let re00 = re_src[y0][x0];
        let re10 = re_src[y0][x1];
        let re01 = re_src[y1][x0];
        let re11 = re_src[y1][x1];
        let im00 = im_src[y0][x0];
        let im10 = im_src[y0][x1];
        let im01 = im_src[y1][x0];
        let im11 = im_src[y1][x1];

        let re0 = re00 + (re10 - re00) * tx;
        let re1 = re01 + (re11 - re01) * tx;
        let im0 = im00 + (im10 - im00) * tx;
        let im1 = im01 + (im11 - im01) * tx;

        (re0 + (re1 - re0) * ty, im0 + (im1 - im0) * ty)
    };

    let pixel_step_x = (x_max - x_min) / (n.saturating_sub(1) as f64).max(1.0);
    let pixel_step_y = (y_max - y_min) / (n.saturating_sub(1) as f64).max(1.0);

    let compute_curve = |dxn: f64, dyn_: f64, frequencies: &[f64]| -> Vec<f64> {
        let mut out = Vec::with_capacity(frequencies.len());
        for f in frequencies.iter().copied() {
            if f <= 1e-12 {
                out.push(1.0);
                continue;
            }
            let nu = f / cutoff_lpmm;
            if !nu.is_finite() || nu >= 1.0 {
                out.push(0.0);
                continue;
            }
            let shift = 2.0 * nu.max(0.0) * pupil_range;
            let sx = dxn * shift;
            let sy = dyn_ * shift;
            // Near cutoff, the discrete pupil correlation is sensitive to subpixel aliasing.
            // Blend in a 4-tap quarter-pixel sample to suppress high-frequency elbows.
            let tail_blend = ((nu - 0.7) / 0.3).clamp(0.0, 1.0);
            let jitter_x = 0.25 * pixel_step_x;
            let jitter_y = 0.25 * pixel_step_y;

            let mut sum_re = 0.0_f64;
            let mut sum_im = 0.0_f64;
            for iy in 0..n {
                let py = y_min + (iy as f64 / (n.saturating_sub(1) as f64).max(1.0)) * (y_max - y_min);
                for ix in 0..n {
                    let a = re_grid[iy][ix];
                    let b = im_grid[iy][ix];
                    if a == 0.0 && b == 0.0 {
                        continue;
                    }
                    let px = x_min + (ix as f64 / (n.saturating_sub(1) as f64).max(1.0)) * (x_max - x_min);
                    let (mut c, mut d) = sample_complex_bilinear(px + sx, py + sy, &re_grid, &im_grid);
                    if tail_blend > 0.0 {
                        let (c1, d1) = sample_complex_bilinear(px + sx + jitter_x, py + sy + jitter_y, &re_grid, &im_grid);
                        let (c2, d2) = sample_complex_bilinear(px + sx + jitter_x, py + sy - jitter_y, &re_grid, &im_grid);
                        let (c3, d3) = sample_complex_bilinear(px + sx - jitter_x, py + sy + jitter_y, &re_grid, &im_grid);
                        let (c4, d4) = sample_complex_bilinear(px + sx - jitter_x, py + sy - jitter_y, &re_grid, &im_grid);
                        let c_lp = 0.25 * (c1 + c2 + c3 + c4);
                        let d_lp = 0.25 * (d1 + d2 + d3 + d4);
                        c = c * (1.0 - tail_blend) + c_lp * tail_blend;
                        d = d * (1.0 - tail_blend) + d_lp * tail_blend;
                    }
                    // p * conj(q)
                    sum_re += a * c + b * d;
                    sum_im += b * c - a * d;
                }
            }
            let mtf = (sum_re.hypot(sum_im) / denom).clamp(0.0, 1.0);
            out.push(if mtf.is_finite() { mtf } else { 0.0 });
        }
        if frequencies.first().is_some_and(|frequency| *frequency <= 1e-12) {
            out[0] = 1.0;
        }
        out
    };

    let evaluation_frequencies = if direct_eval_only {
        sampled_frequencies_lpmm
            .iter()
            .map(|frequency| frequency.min(cutoff_lpmm))
            .collect::<Vec<f64>>()
    } else {
        (0..out_points)
            .map(|i| {
                let t = i as f64 / (out_points.saturating_sub(1) as f64).max(1.0);
                axis_max_lpmm * t
            })
            .collect::<Vec<f64>>()
    };
    let evaluated_tangential = compute_curve(tan_x, tan_y, &evaluation_frequencies);
    let evaluated_sagittal = compute_curve(sag_x, sag_y, &evaluation_frequencies);
    let frequency_axis = if direct_eval_only { Vec::new() } else { evaluation_frequencies.clone() };
    let mtf_tangential = if direct_eval_only { Vec::new() } else { evaluated_tangential.clone() };
    let mtf_sagittal = if direct_eval_only { Vec::new() } else { evaluated_sagittal.clone() };

    Ok(serde_json::json!({
        "backend": "web-rust-wasm-mtf-malacara",
        "frequencyAxis": frequency_axis,
        "mtfTangential": mtf_tangential,
        "mtfSagittal": mtf_sagittal,
        "sampledFrequenciesLpmm": if direct_eval_only { Value::from(evaluation_frequencies) } else { Value::Null },
        "sampledMtfTangential": if direct_eval_only { Value::from(evaluated_tangential) } else { Value::Null },
        "sampledMtfSagittal": if direct_eval_only { Value::from(evaluated_sagittal) } else { Value::Null },
        "nyquistLpmm": cutoff_lpmm,
        "message": "Computed via WASM Malacara MTF (run_native_mtf_malacara_from_opd_wasm_json)"
    }))
}

/// Compute MTF with Malacara/Hopkins-style pupil autocorrelation directly from OPD grid.
/// This is intended for strict Rust/WASM-only MTF in web runtime (no JS fallback).
#[wasm_bindgen]
pub fn run_native_mtf_malacara_from_opd_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("run_native_mtf_malacara_from_opd_wasm_json: JSON parse: {}", e)))?;
    let response = run_native_mtf_malacara_from_opd_value(&req)?;
    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    response
    .serialize(&serializer)
    .map_err(|e| JsValue::from_str(&format!("serialize error: {}", e)))
}

/// Batched one-shot pipeline: OPD -> PSF -> MTF in a single WASM call.
/// This reduces JS<->WASM boundary crossings for TF/Object MTF sweeps.
///
/// Input JSON:
/// {
///   "opdRequest": { ... run_native_opd_map_wasm_json request ... },
///   "pixelSizeUm": number,
///   "maxFrequencyLpmm": number,
///   "points": number,
///   "method": "rust-wasm" | "hopkins-tcc" | ...,
///   "sampleFrequenciesLpmm": number[],
///   "directEvalOnly": bool
/// }
fn run_native_opd_psf_mtf_value_with_rows(
    req: &Value,
    normalized_optical_rows: Option<&[Value]>,
    shared_packed_meta: Option<&PackedMeta>,
) -> Result<Value, JsValue> {
    let slim_results = req
        .get("slimResults")
        .or_else(|| req.get("compactResults"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let opd_only = req
        .get("opdOnly")
        .or_else(|| req.get("skipPsfMtf"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut opd_req = req
        .get("opdRequest")
        .ok_or_else(|| JsValue::from_str("run_native_opd_psf_mtf_wasm_json: opdRequest missing"))?;
    let owned_opd_req;
    if let Some(mut obj) = opd_req.as_object().cloned() {
        obj.insert("omitReferenceSphereOpdGrid".to_string(), Value::Bool(true));
        owned_opd_req = Value::Object(obj);
        opd_req = &owned_opd_req;
    }

    let opd_json = run_native_opd_map_value_with_rows(opd_req, normalized_optical_rows, shared_packed_meta)?;

    let wavelength_um = req
        .get("wavelengthUm")
        .and_then(|v| v.as_f64())
        .or_else(|| opd_json.get("wavelengthUm").and_then(|v| v.as_f64()))
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(0.5876);

    let method = req
        .get("method")
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if method == "malacara-wasm-required" {
        let mtf_req = serde_json::json!({
            "displayOpdGrid": opd_json.get("displayOpdGrid"),
            "rawOpdGrid": opd_json.get("rawOpdGrid"),
            "amplitudeGrid": req.get("amplitudeGrid"),
            "wavelengthUm": wavelength_um,
            "fNumber": req.get("fNumber"),
            "pupilRange": req.get("pupilRange").and_then(|value| value.as_f64()).unwrap_or(1.0),
            "maxFrequencyLpmm": req.get("maxFrequencyLpmm"),
            "points": req.get("points"),
            "sampleFrequenciesLpmm": req.get("sampleFrequenciesLpmm").cloned().unwrap_or(Value::Null),
            "directEvalOnly": req.get("directEvalOnly").and_then(|value| value.as_bool()).unwrap_or(false),
            "tangentialDir": req.get("tangentialDir"),
            "sagittalDir": req.get("sagittalDir"),
        });
        let mtf_json = run_native_mtf_malacara_from_opd_value(&mtf_req)?;
        let opd_out = if slim_results {
            serde_json::json!({
                "backend": opd_json.get("backend").cloned().unwrap_or(Value::Null),
                "targetSurface": opd_json.get("targetSurface").cloned().unwrap_or(Value::Null),
                "stopSurface": opd_json.get("stopSurface").cloned().unwrap_or(Value::Null),
                "wavelengthUm": opd_json.get("wavelengthUm").cloned().unwrap_or(Value::Null),
                "sampleCount": opd_json.get("sampleCount").cloned().unwrap_or(Value::Null),
                "hitCount": opd_json.get("hitCount").cloned().unwrap_or(Value::Null),
                "pupilSamplingMode": opd_json.get("pupilSamplingMode").cloned().unwrap_or(Value::Null),
                "effectivePupilRadiusMm": opd_json.get("effectivePupilRadiusMm").cloned().unwrap_or(Value::Null),
            })
        } else {
            opd_json
        };
        return Ok(serde_json::json!({
            "backend": "web-rust-wasm-opd-mtf-malacara-batch",
            "opd": opd_out,
            "psf": Value::Null,
            "mtf": mtf_json,
            "message": "Computed via batched WASM OPD+Malacara MTF",
        }));
    }

    if opd_only {
        return Ok(serde_json::json!({
            "backend": "web-rust-wasm-opd-batch-opd-only",
            "opd": opd_json,
            "psf": Value::Null,
            "mtf": Value::Null,
            "message": "Computed via batched WASM OPD only",
        }));
    }

    let psf_req = serde_json::json!({
        "rawOpdGrid": opd_json.get("rawOpdGrid"),
        "displayOpdGrid": opd_json.get("displayOpdGrid"),
        "wavelengthUm": wavelength_um,
        "pixelSizeUm": req.get("pixelSizeUm").and_then(|v| v.as_f64()).unwrap_or(1.0),
        "zeroPadTo": req.get("zeroPadTo").and_then(|v| v.as_u64()).unwrap_or(0),
        "removeTilt": req.get("removeTilt").and_then(|v| v.as_bool()).unwrap_or(false),
    });

    let psf_json = run_native_psf_from_opd_value(&psf_req)?;

    let mtf_req = serde_json::json!({
        "psfData": psf_json.get("psfData"),
        "pixelSizeUm": psf_json.get("pixelSizeUm").and_then(|v| v.as_f64()).unwrap_or(1.0),
        "maxFrequencyLpmm": req.get("maxFrequencyLpmm").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "targetFrequencyLpmm": req.get("targetFrequencyLpmm").and_then(|v| v.as_f64()),
        "sampleFrequenciesLpmm": req.get("sampleFrequenciesLpmm").cloned().unwrap_or(Value::Null),
        "directEvalOnly": req.get("directEvalOnly").and_then(|v| v.as_bool()).unwrap_or(false),
        "points": req.get("points").and_then(|v| v.as_u64()).unwrap_or(121),
    });

    let mtf_json = run_native_mtf_from_psf_value(&mtf_req)?;

    let opd_out = if slim_results {
        serde_json::json!({
            "backend": opd_json.get("backend").cloned().unwrap_or(Value::Null),
            "chiefReferenceMode": opd_json.get("chiefReferenceMode").cloned().unwrap_or(Value::Null),
            "targetSurface": opd_json.get("targetSurface").cloned().unwrap_or(Value::Null),
            "stopSurface": opd_json.get("stopSurface").cloned().unwrap_or(Value::Null),
            "requestedObjectIndex": opd_json.get("requestedObjectIndex").cloned().unwrap_or(Value::Null),
            "usedObjectIndex": opd_json.get("usedObjectIndex").cloned().unwrap_or(Value::Null),
            "usedObjectPosition": opd_json.get("usedObjectPosition").cloned().unwrap_or(Value::Null),
            "usedObjectX": opd_json.get("usedObjectX").cloned().unwrap_or(Value::Null),
            "usedObjectY": opd_json.get("usedObjectY").cloned().unwrap_or(Value::Null),
            "wavelengthUm": opd_json.get("wavelengthUm").cloned().unwrap_or(Value::Null),
            "gridSize": opd_json.get("gridSize").cloned().unwrap_or(Value::Null),
            "sampleCount": opd_json.get("sampleCount").cloned().unwrap_or(Value::Null),
            "hitCount": opd_json.get("hitCount").cloned().unwrap_or(Value::Null),
            "pupilSamplingMode": opd_json.get("pupilSamplingMode").cloned().unwrap_or(Value::Null),
            "effectivePupilRadiusMm": opd_json.get("effectivePupilRadiusMm").cloned().unwrap_or(Value::Null),
            "message": opd_json.get("message").cloned().unwrap_or(Value::Null),
        })
    } else {
        opd_json
    };
    let psf_out = if slim_results { Value::Null } else { psf_json };

    Ok(serde_json::json!({
        "backend": "web-rust-wasm-opd-psf-mtf-batch",
        "opd": opd_out,
        "psf": psf_out,
        "mtf": mtf_json,
        "message": if slim_results { "Computed via compact WASM OPD+PSF+MTF" } else { "Computed via batched WASM OPD+PSF+MTF" },
    }))
}

fn run_native_opd_psf_mtf_value(req: &Value) -> Result<Value, JsValue> {
    run_native_opd_psf_mtf_value_with_rows(req, None, None)
}

fn clone_optical_rows_with_defocus(rows: &[Value], defocus_mm: f64) -> Vec<Value> {
    let mut cloned = rows.to_vec();
    if !defocus_mm.is_finite() || defocus_mm.abs() < 1e-15 {
        return cloned;
    }

    let image_index = cloned.iter().position(|row| {
        let object_type = row
            .get("object type")
            .or_else(|| row.get("object"))
            .and_then(value_to_string)
            .unwrap_or_default();
        object_type.eq_ignore_ascii_case("image")
    });
    let target_index = match image_index {
        Some(index) if index > 0 => index - 1,
        _ if cloned.len() >= 2 => cloned.len() - 2,
        _ => 0,
    };
    if let Some(target) = cloned.get_mut(target_index).and_then(Value::as_object_mut) {
        let thickness = target
            .get("thickness")
            .or_else(|| target.get("Thickness"))
            .and_then(value_to_f64)
            .unwrap_or(0.0);
        target.insert("thickness".to_string(), Value::from(thickness + defocus_mm));
    }
    cloned
}

#[wasm_bindgen]
pub fn run_native_opd_psf_mtf_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("run_native_opd_psf_mtf_wasm_json: JSON parse: {}", e)))?;
    let response = run_native_opd_psf_mtf_value(&req)?;
    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    response
    .serialize(&serializer)
    .map_err(|e| JsValue::from_str(&format!("run_native_opd_psf_mtf_wasm_json: serialize error: {}", e)))
}

/// Batch multiple OPD+PSF+MTF jobs in a single JS→WASM call.
///
/// Input JSON:
/// ```json
/// {
///   "jobs": [ { ... run_native_opd_psf_mtf_wasm_json request ... } ]
/// }
/// ```
#[wasm_bindgen]
pub fn run_native_opd_psf_mtf_batch_wasm_json(req_json: String) -> Result<JsValue, JsValue> {
    let req: Value = serde_json::from_str(&req_json)
        .map_err(|e| JsValue::from_str(&format!("run_native_opd_psf_mtf_batch_wasm_json: JSON parse: {}", e)))?;

    let jobs = req
        .get("jobs")
        .or_else(|| req.get("requests"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| JsValue::from_str("run_native_opd_psf_mtf_batch_wasm_json: jobs missing"))?;
    let shared = req.get("shared").and_then(|v| v.as_object());
    let shared_normalized_rows = shared
        .and_then(|obj| obj.get("opdRequest"))
        .and_then(|opd| opd.get("opticalSystemRows"))
        .and_then(|rows| rows.as_array())
        .map(|rows| rows.iter().map(normalize_coord_trans_row).collect::<Vec<Value>>());
    let shared_packed_meta = if let (Some(shared_obj), Some(rows)) = (shared, shared_normalized_rows.as_deref()) {
        let shared_opd = shared_obj.get("opdRequest").and_then(|v| v.as_object());
        let wavelength_um = shared_opd
            .and_then(|opd| opd.get("wavelengthUm"))
            .and_then(value_to_f64)
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(0.5876);
        let target_surface_index = shared_opd
            .and_then(|opd| opd.get("surfaceIndex"))
            .and_then(value_to_f64)
            .map(|v| v.max(0.0) as usize)
            .unwrap_or_else(|| find_eval_surface_index(rows))
            .min(rows.len().saturating_sub(1));
        Some(build_packed_meta_for_opd(rows, wavelength_um, target_surface_index))
    } else {
        None
    };

    let compute_job = |(job_index, job): (usize, &Value)| -> Result<Value, String> {
        let job_overrides_optical_rows = job
            .get("opdRequest")
            .and_then(|opd| opd.get("opticalSystemRows"))
            .is_some();
        let defocus_mm = job.get("defocusMm").and_then(value_to_f64);
        let can_use_shared_rows = shared_normalized_rows.is_some()
            && !job_overrides_optical_rows
            && defocus_mm.is_none();
        let merged_job;
        let merged_effective_job = if let Some(shared_obj) = shared {
            let mut merged = Map::<String, Value>::new();
            for (key, value) in shared_obj {
                if key != "opdRequest" {
                    merged.insert(key.clone(), value.clone());
                }
            }
            if let Some(shared_opd) = shared_obj.get("opdRequest").and_then(|v| v.as_object()) {
                let mut merged_opd = Map::<String, Value>::new();
                for (key, value) in shared_opd {
                    if can_use_shared_rows && key == "opticalSystemRows" {
                        continue;
                    }
                    merged_opd.insert(key.clone(), value.clone());
                }
                if let Some(job_opd) = job.get("opdRequest").and_then(|v| v.as_object()) {
                    for (key, value) in job_opd {
                        merged_opd.insert(key.clone(), value.clone());
                    }
                }
                merged.insert("opdRequest".to_string(), Value::Object(merged_opd));
            }
            if let Some(job_obj) = job.as_object() {
                for (key, value) in job_obj {
                    if key != "opdRequest" {
                        merged.insert(key.clone(), value.clone());
                    }
                }
            }
            merged_job = Value::Object(merged);
            &merged_job
        } else {
            job
        };
        let defocus_job = defocus_mm.map(|defocus| {
            let mut owned = merged_effective_job.clone();
            let base_rows = shared
                .and_then(|obj| obj.get("opdRequest"))
                .and_then(|opd| opd.get("opticalSystemRows"))
                .and_then(Value::as_array)
                .map(|rows| clone_optical_rows_with_defocus(rows, defocus));
            if let Some(rows) = base_rows {
                if let Some(opd) = owned.get_mut("opdRequest").and_then(Value::as_object_mut) {
                    opd.insert("opticalSystemRows".to_string(), Value::Array(rows));
                }
            }
            owned
        });
        let effective_job = defocus_job.as_ref().unwrap_or(merged_effective_job);
        let mut job_result = run_native_opd_psf_mtf_value_with_rows(
            effective_job,
            if can_use_shared_rows { shared_normalized_rows.as_deref() } else { None },
            if can_use_shared_rows { shared_packed_meta.as_ref() } else { None },
        ).map_err(|error| format!("{error:?}"))?;
        if let Some(obj) = job_result.as_object_mut() {
            obj.insert("jobIndex".to_string(), Value::from(job_index as u64));
            if let Some(meta) = job.get("meta") {
                obj.insert("meta".to_string(), meta.clone());
            }
        }
        Ok(job_result)
    };

    #[cfg(feature = "wasm-threads")]
    let use_rayon = req.get("parallel").and_then(Value::as_bool).unwrap_or(false)
        && jobs.len() > 1;

    #[cfg(feature = "wasm-threads")]
    let results: Vec<Value> = if use_rayon {
        jobs.par_iter()
            .enumerate()
            .map(compute_job)
            .collect::<Result<Vec<_>, _>>()
    } else {
        jobs.iter()
            .enumerate()
            .map(compute_job)
            .collect::<Result<Vec<_>, _>>()
    }
    .map_err(|error| JsValue::from_str(&error))?;

    #[cfg(not(feature = "wasm-threads"))]
    let (results, packed_meta_cache_entries, packed_meta_cache_hits): (Vec<Value>, usize, usize) = {
        // The optimizer submits one OPD/MTF job for each field and wavelength.
        // For a finite-difference candidate the packed optical system is the
        // same across all fields at the same wavelength, yet the old batch path
        // rebuilt its surface metadata for every job.  Keep it local to this
        // request so changed candidates can never leak into a later evaluation.
        let mut packed_meta_cache: Vec<(Vec<Value>, f64, usize, PackedMeta)> = Vec::new();
        let mut cache_hits = 0usize;
        let mut results = Vec::with_capacity(jobs.len());

        for (job_index, job) in jobs.iter().enumerate() {
            // Shared batches already own their normalized rows and metadata in
            // `compute_job`.  Optimizer batches carry their own rows so that
            // each finite-difference candidate remains independent.
            let job_rows = if shared.is_none() {
                job.get("opdRequest")
                    .and_then(|opd| opd.get("opticalSystemRows"))
                    .and_then(Value::as_array)
            } else {
                None
            };

            let Some(job_rows) = job_rows else {
                results.push(compute_job((job_index, job)).map_err(|error| JsValue::from_str(&error))?);
                continue;
            };

            let normalized_rows = job_rows
                .iter()
                .map(normalize_coord_trans_row)
                .collect::<Vec<Value>>();
            let wavelength_um = job
                .get("opdRequest")
                .and_then(|opd| opd.get("wavelengthUm"))
                .and_then(value_to_f64)
                .filter(|value| value.is_finite() && *value > 0.0)
                .unwrap_or(0.5876);
            let target_surface_index = job
                .get("opdRequest")
                .and_then(|opd| opd.get("surfaceIndex"))
                .and_then(value_to_f64)
                .map(|value| value.max(0.0) as usize)
                .unwrap_or_else(|| find_eval_surface_index(&normalized_rows))
                .min(normalized_rows.len().saturating_sub(1));

            let cache_index = if let Some(index) = packed_meta_cache.iter().position(|(rows, wavelength, target, _)| {
                *target == target_surface_index
                    && (*wavelength - wavelength_um).abs() <= 1.0e-12
                    && *rows == normalized_rows
            }) {
                cache_hits += 1;
                index
            } else {
                let packed = build_packed_meta_for_opd(&normalized_rows, wavelength_um, target_surface_index);
                packed_meta_cache.push((normalized_rows, wavelength_um, target_surface_index, packed));
                packed_meta_cache.len().saturating_sub(1)
            };
            let cached = &packed_meta_cache[cache_index];
            let mut job_result = run_native_opd_psf_mtf_value_with_rows(
                job,
                Some(cached.0.as_slice()),
                Some(&cached.3),
            )?;
            if let Some(obj) = job_result.as_object_mut() {
                obj.insert("jobIndex".to_string(), Value::from(job_index as u64));
                if let Some(meta) = job.get("meta") {
                    obj.insert("meta".to_string(), meta.clone());
                }
            }
            results.push(job_result);
        }

        (results, packed_meta_cache.len(), cache_hits)
    };

    #[cfg(feature = "wasm-threads")]
    let packed_meta_cache_entries = 0usize;
    #[cfg(feature = "wasm-threads")]
    let packed_meta_cache_hits = 0usize;

    let serializer = serde_wasm_bindgen::Serializer::json_compatible();
    #[cfg(feature = "wasm-threads")]
    let backend = if use_rayon {
        "web-rust-wasm-opd-psf-mtf-rayon"
    } else {
        "web-rust-wasm-opd-psf-mtf-multi-batch"
    };
    #[cfg(not(feature = "wasm-threads"))]
    let backend = "web-rust-wasm-opd-psf-mtf-multi-batch";

    serde_json::json!({
        "backend": backend,
        "results": results,
        "packedMetaCacheEntries": packed_meta_cache_entries,
        "packedMetaCacheHits": packed_meta_cache_hits,
        "message": "Computed multiple OPD+PSF+MTF jobs via one WASM batch call",
    })
    .serialize(&serializer)
    .map_err(|e| JsValue::from_str(&format!("run_native_opd_psf_mtf_batch_wasm_json: serialize error: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_display_mode_grid,
        clear_trace_system_metadata_cache,
        register_trace_system_metadata,
        run_native_mtf_malacara_from_opd_value,
        trace_ray_batch_hit_point_with_meta,
        trace_ray_batch_spot_metrics_cached,
        trace_spot_metric_jobs_cached,
        trace_ray_batch_spot_metrics_with_meta,
    };

    fn test_grid() -> (Vec<Vec<Option<f64>>>, Vec<Vec<Option<f64>>>, Vec<Vec<Option<f64>>>, Vec<Vec<Option<bool>>>) {
        (
            vec![
                vec![Some(1.0), Some(2.0), Some(3.0)],
                vec![Some(4.0), Some(5.0), Some(6.0)],
                vec![Some(7.0), Some(8.0), Some(9.0)],
            ],
            vec![
                vec![Some(-1.0), Some(0.0), Some(1.0)],
                vec![Some(-1.0), Some(0.0), Some(1.0)],
                vec![Some(-1.0), Some(0.0), Some(1.0)],
            ],
            vec![
                vec![Some(-1.0), Some(-1.0), Some(-1.0)],
                vec![Some(0.0), Some(0.0), Some(0.0)],
                vec![Some(1.0), Some(1.0), Some(1.0)],
            ],
            vec![vec![Some(true); 3]; 3],
        )
    }

    #[test]
    fn malacara_direct_sample_matches_full_curve_endpoint() {
        let grid = (0..17)
            .map(|iy| {
                (0..17)
                    .map(|ix| {
                        let x = (ix as f64 - 8.0) / 8.0;
                        let y = (iy as f64 - 8.0) / 8.0;
                        if x * x + y * y <= 1.0 {
                            Some(0.08 * x * x + 0.03 * x * y)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<Option<f64>>>()
            })
            .collect::<Vec<Vec<Option<f64>>>>();
        let common = serde_json::json!({
            "displayOpdGrid": grid,
            "wavelengthUm": 0.55,
            "fNumber": 4.0,
            "pupilRange": 1.0,
            "maxFrequencyLpmm": 20.0,
            "points": 11,
            "tangentialDir": { "x": 1.0, "y": 0.0 },
            "sagittalDir": { "x": 0.0, "y": 1.0 },
        });
        let full = run_native_mtf_malacara_from_opd_value(&common).expect("full Malacara curve");
        let mut direct_request = common;
        direct_request["sampleFrequenciesLpmm"] = serde_json::json!([20.0]);
        direct_request["directEvalOnly"] = serde_json::json!(true);
        let direct = run_native_mtf_malacara_from_opd_value(&direct_request).expect("direct Malacara sample");

        let full_tan = full["mtfTangential"].as_array().unwrap().last().unwrap().as_f64().unwrap();
        let full_sag = full["mtfSagittal"].as_array().unwrap().last().unwrap().as_f64().unwrap();
        let direct_tan = direct["sampledMtfTangential"][0].as_f64().unwrap();
        let direct_sag = direct["sampledMtfSagittal"][0].as_f64().unwrap();
        assert!((full_tan - direct_tan).abs() <= 1e-12);
        assert!((full_sag - direct_sag).abs() <= 1e-12);
    }

    #[test]
    fn display_fit_reports_requested_piston_mode() {
        let (raw, entrance_x, entrance_y, pupil_mask) = test_grid();
        let (_, piston_fit) = apply_display_mode_grid(
            &raw,
            &entrance_x,
            &entrance_y,
            &pupil_mask,
            "pistonRemoved",
        );
        let (_, defocus_fit) = apply_display_mode_grid(
            &raw,
            &entrance_x,
            &entrance_y,
            &pupil_mask,
            "pistonDefocusRemoved",
        );

        assert_eq!(piston_fit["basis"], "piston");
        assert_eq!(defocus_fit["basis"], "pistonDefocus");
    }

    #[test]
    fn spot_metrics_match_batch_hits() {
        let rays = vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            0.0, 2.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let row_meta = vec![0, 2, 0, 0];
        let mut row_params = vec![0.0; 24];
        row_params[0] = f64::INFINITY;
        row_params[12] = f64::INFINITY;
        row_params[17] = f64::INFINITY;
        row_params[20] = 1.0;
        let row_origins = vec![0.0, 0.0, 10.0];
        let identity = vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

        let hits = trace_ray_batch_hit_point_with_meta(
            &rays, 3, 0, 1.0, &row_meta, &row_params, &row_origins, &identity, &identity, 1,
        );
        let metrics = trace_ray_batch_spot_metrics_with_meta(
            &rays, 3, 0, 1.0, 0.0, 0.0, &row_meta, &row_params, &row_origins, &identity, &identity, 1,
        );

        let valid_hits: Vec<(f64, f64)> = hits
            .chunks_exact(6)
            .filter(|hit| hit[0] == 1.0)
            .map(|hit| (hit[2], hit[3]))
            .collect();
        let count = valid_hits.len() as f64;
        let centroid_x = valid_hits.iter().map(|point| point.0).sum::<f64>() / count;
        let centroid_y = valid_hits.iter().map(|point| point.1).sum::<f64>() / count;
        let mean_r2 = valid_hits
            .iter()
            .map(|point| point.0 * point.0 + point.1 * point.1)
            .sum::<f64>() / count;
        let max_r2 = valid_hits
            .iter()
            .map(|point| point.0 * point.0 + point.1 * point.1)
            .fold(0.0_f64, f64::max);

        assert_eq!(metrics[0], count);
        assert!((metrics[1] - centroid_x).abs() < 1e-12);
        assert!((metrics[2] - centroid_y).abs() < 1e-12);
        assert!((metrics[5] - mean_r2.sqrt()).abs() < 1e-12);
        assert!((metrics[6] - 2.0 * max_r2.sqrt()).abs() < 1e-12);
    }

    #[test]
    fn cached_spot_metrics_match_direct_metadata_path() {
        clear_trace_system_metadata_cache();
        let rays = vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let row_meta = vec![0, 2, 0, 0];
        let mut row_params = vec![0.0; 24];
        row_params[0] = f64::INFINITY;
        row_params[12] = f64::INFINITY;
        row_params[17] = f64::INFINITY;
        row_params[20] = 1.0;
        let row_origins = vec![0.0, 0.0, 10.0];
        let identity = vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let direct = trace_ray_batch_spot_metrics_with_meta(
            &rays, 2, 0, 1.0, 0.0, 0.0, &row_meta, &row_params, &row_origins, &identity, &identity, 1,
        );
        let handle = register_trace_system_metadata(
            &row_meta, &row_params, &row_origins, &identity, &identity, 1,
        );
        assert!(handle > 0);
        let cached = trace_ray_batch_spot_metrics_cached(&rays, 2, 0, 1.0, 0.0, 0.0, handle);
        assert_eq!(cached, direct);

        clear_trace_system_metadata_cache();
        assert_eq!(trace_ray_batch_spot_metrics_cached(&rays, 2, 0, 1.0, 0.0, 0.0, handle)[0], 0.0);
    }

    #[test]
    fn cached_spot_job_batch_matches_individual_jobs() {
        clear_trace_system_metadata_cache();
        let row_meta = vec![0, 2, 0, 0];
        let mut row_params = vec![0.0; 24];
        row_params[0] = f64::INFINITY;
        row_params[12] = f64::INFINITY;
        row_params[17] = f64::INFINITY;
        row_params[20] = 1.0;
        let row_origins = vec![0.0, 0.0, 10.0];
        let identity = vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let handle = register_trace_system_metadata(
            &row_meta, &row_params, &row_origins, &identity, &identity, 1,
        );
        let rays = vec![
            0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
            1.0, 0.0, 0.0, 0.0, 1.0,
            0.0, 2.0, 0.0, 0.0, 0.0, 1.0,
        ];
        let first = trace_ray_batch_spot_metrics_cached(&rays[..12], 2, 0, 1.0, 0.0, 0.0, handle);
        let second = trace_ray_batch_spot_metrics_cached(&rays[12..], 1, 0, 1.0, 0.0, 0.0, handle);
        let batched = trace_spot_metric_jobs_cached(
            &rays,
            &[0, 2],
            &[2, 1],
            &[0, 0],
            &[1.0, 1.0],
            &[0.0, 0.0],
            &[0.0, 0.0],
            &[handle, handle],
            2,
        );
        assert_eq!(&batched[..8], first.as_slice());
        assert_eq!(&batched[8..], second.as_slice());
    }
}
