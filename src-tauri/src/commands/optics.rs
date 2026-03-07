use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::f64::consts::PI;
use std::time::Instant;

use crate::commands::analysis::SpotPoint;

const EPS_R: f64 = 1e-10;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpticsEchoRequest {
    pub job_id: String,
    pub payload: Vec<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpticsEchoResponse {
    pub job_id: String,
    pub count: usize,
    pub payload_sum: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RaytracePreviewRequest {
    pub lens_id: String,
    pub field_index: u32,
    pub ray_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RaytracePreviewResponse {
    pub lens_id: String,
    pub field_index: u32,
    pub traced_rays: u32,
    pub rms_spot_um: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpotRaytraceRequest {
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    #[allow(dead_code)]
    pub object_rows: Vec<Value>,
    pub surface_index: Option<usize>,
    pub ray_count: Option<u32>,
    pub ring_count: Option<u32>,
    pub pattern: Option<String>,
    pub wavelength_mode: Option<String>,
    #[serde(default)]
    pub ray_series: Vec<NativeSpotInputSeries>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpotInputSeries {
    pub label: String,
    pub color: Option<String>,
    #[serde(default)]
    pub has_field_angle: bool,
    #[serde(default)]
    pub rays: Vec<NativeSpotInputRay>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpotInputRay {
    pub start_p: NativeSpotVec3,
    pub dir: NativeSpotVec3,
    pub wavelength_um: Option<f64>,
    #[serde(default)]
    pub is_chief: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpotVec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpotRaytraceResponse {
    pub backend: String,
    pub surface_index: usize,
    pub traced_rays: u32,
    pub requested_rays: u32,
    pub generated_rays: u32,
    pub wavelength_count: u32,
    pub total_attempted_rays: u32,
    pub total_hit_rays: u32,
    pub max_hit_rays: u32,
    pub mean_hit_rate_percent: f64,
    pub ray_generation_ms: f64,
    pub trace_ms: f64,
    pub series_stats: Vec<NativeSpotSeriesStats>,
    pub series: Vec<NativeSpotSeries>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpotSeriesStats {
    pub label: String,
    pub attempted_rays: u32,
    pub hit_rays: u32,
    pub hit_rate_percent: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSpotSeries {
    pub label: String,
    pub color: String,
    pub wavelength_um: Option<f64>,
    pub points: Vec<SpotPoint>,
    pub chief_point_um: Option<SpotPoint>,
    pub has_field_angle: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSphericalAberrationRequest {
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    #[allow(dead_code)]
    pub object_rows: Vec<Value>,
    pub surface_index: Option<usize>,
    pub ray_count: Option<u32>,
    pub reference_focus_mode: Option<String>,
    pub wavelength_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAstigmatismDebugRequest {
    #[serde(default)]
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub target_surface_index: Option<usize>,
    pub ray_count: Option<u32>,
    pub ring_count: Option<u32>,
    pub pattern: Option<String>,
    pub chief_ray_mode: Option<String>,
    pub require_rust: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAstigmatismDebugResponse {
    pub ok: bool,
    pub message: String,
    pub optical_count: usize,
    pub source_count: usize,
    pub object_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAstigmatismRequest {
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub surface_index: Option<usize>,
    pub ray_count: Option<u32>,
    pub ring_count: Option<u32>,
    pub pattern: Option<String>,
    pub chief_ray_mode: Option<String>,
    pub wavelength_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAstigmatismFieldSetting {
    pub display_name: String,
    pub y: f64,
    pub position: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAstigmatismFieldData {
    pub wavelength: f64,
    pub field_angle: f64,
    pub field_name: String,
    pub paraxial_image_z: Option<f64>,
    pub meridional_deviation: Option<f64>,
    pub sagittal_deviation: Option<f64>,
    pub astigmatic_difference: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAstigmatismResponse {
    pub backend: String,
    pub target_surface: usize,
    pub stop_surface: usize,
    pub primary_wavelength: f64,
    pub primary_reference_z: Option<f64>,
    pub field_mode: String,
    pub is_angle_field: bool,
    pub field_settings: Vec<NativeAstigmatismFieldSetting>,
    pub wavelengths: Vec<f64>,
    pub data: Vec<NativeAstigmatismFieldData>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSphericalAberrationPoint {
    pub pupil_coordinate: f64,
    pub longitudinal_aberration: f64,
    pub focus_position: f64,
    pub stop_height: f64,
    pub transverse_aberration: f64,
    pub sine_condition_violation: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSphericalAberrationSeries {
    pub wavelength: f64,
    pub ray_type: String,
    pub points: Vec<NativeSphericalAberrationPoint>,
    pub paraxial_aberration: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSphericalAberrationResponse {
    pub backend: String,
    pub meridional_data: Vec<NativeSphericalAberrationSeries>,
    pub sagittal_data: Vec<NativeSphericalAberrationSeries>,
    pub message: String,
    pub summary: Map<String, Value>,
}

#[tauri::command]
pub fn optics_echo(req: OpticsEchoRequest) -> Result<OpticsEchoResponse, String> {
    let payload_sum = req.payload.iter().copied().sum::<f64>();
    Ok(OpticsEchoResponse {
        job_id: req.job_id,
        count: req.payload.len(),
        payload_sum,
    })
}

#[tauri::command]
pub fn run_raytrace_preview(req: RaytracePreviewRequest) -> Result<RaytracePreviewResponse, String> {
    let traced_rays = req.ray_count.min(50_000);
    let rms_spot_um = 0.95 + (req.field_index as f64) * 0.02 + (traced_rays as f64 / 1_000_000.0);

    Ok(RaytracePreviewResponse {
        lens_id: req.lens_id,
        field_index: req.field_index,
        traced_rays,
        rms_spot_um,
    })
}

#[tauri::command]
pub fn run_native_spot_raytrace(req: NativeSpotRaytraceRequest) -> Result<NativeSpotRaytraceResponse, String> {
    let cmd_start = Instant::now();
    if req.optical_system_rows.is_empty() {
        return Err("run_native_spot_raytrace: opticalSystemRows is empty".to_string());
    }

    let rows: Vec<Value> = req
        .optical_system_rows
        .iter()
        .map(normalize_coord_trans_row)
        .collect();

    if rows.is_empty() {
        return Err("run_native_spot_raytrace: normalized rows are empty".to_string());
    }

    let traced_rays_req = req.ray_count.unwrap_or(501).max(1) as usize;
    let ring_count = req.ring_count.unwrap_or(10).clamp(1, 64) as usize;
    let surface_index = req.surface_index.unwrap_or(0).min(rows.len().saturating_sub(1));
    let pattern = req
        .pattern
        .unwrap_or_else(|| "annular".to_string())
        .trim()
        .to_lowercase();
    let wavelength_mode = req
        .wavelength_mode
        .unwrap_or_else(|| "all".to_string())
        .trim()
        .to_lowercase();

    let surface_data = calculate_surface_data(&rows);
    if surface_data.len() != rows.len() {
        return Err("run_native_spot_raytrace: failed to calculate surface origins".to_string());
    }

    let target_surface = &surface_data[surface_index];
    let stop_radius = estimate_stop_radius_mm(&rows);
    let entrance_radius = estimate_entrance_radius_mm(&rows).clamp(0.01, 500.0);
    let sampling_radius = if stop_radius.is_finite() && stop_radius > 0.0 {
        stop_radius.min(entrance_radius).max(0.01)
    } else {
        entrance_radius
    };
    let fallback_offsets = if pattern == "grid" {
        generate_centered_grid_offsets_flat(traced_rays_req, sampling_radius)
    } else {
        generate_annular_offsets_flat(traced_rays_req, sampling_radius, ring_count)
    };
    if fallback_offsets.len() < 2 && req.ray_series.is_empty() {
        return Err("run_native_spot_raytrace: failed to generate rays".to_string());
    }

    let fallback_ray_count = fallback_offsets.len() / 2;
    let start_z = surface_data.first().map(|s| s.origin[2] - 1.0).unwrap_or(-1.0);
    let mut fallback_rays = vec![0.0_f64; fallback_ray_count * 6];
    for i in 0..fallback_ray_count {
        let o = i * 2;
        let b = i * 6;
        fallback_rays[b] = fallback_offsets[o];
        fallback_rays[b + 1] = fallback_offsets[o + 1];
        fallback_rays[b + 2] = start_z;
        fallback_rays[b + 3] = 0.0;
        fallback_rays[b + 4] = 0.0;
        fallback_rays[b + 5] = 1.0;
    }

    let mut input_series: Vec<(String, String, bool, Vec<NativeSpotInputRay>, f64)> = Vec::new();
    if !req.ray_series.is_empty() {
        for (series_index, s) in req.ray_series.iter().enumerate() {
            if s.rays.is_empty() {
                continue;
            }
            let mut rays = Vec::<NativeSpotInputRay>::with_capacity(s.rays.len());
            let mut wl_sum = 0.0_f64;
            let mut wl_count = 0usize;
            for r in &s.rays {
                let sx = r.start_p.x;
                let sy = r.start_p.y;
                let sz = r.start_p.z;
                let dx = r.dir.x;
                let dy = r.dir.y;
                let dz = r.dir.z;
                if !(sx.is_finite() && sy.is_finite() && sz.is_finite() && dx.is_finite() && dy.is_finite() && dz.is_finite()) {
                    continue;
                }
                rays.push(NativeSpotInputRay {
                    start_p: NativeSpotVec3 { x: sx, y: sy, z: sz },
                    dir: NativeSpotVec3 { x: dx, y: dy, z: dz },
                    wavelength_um: r.wavelength_um,
                    is_chief: r.is_chief,
                });
                if let Some(wl) = r.wavelength_um {
                    if wl.is_finite() && wl > 0.0 {
                        wl_sum += wl;
                        wl_count += 1;
                    }
                }
            }
            if rays.is_empty() {
                continue;
            }
            let wl_avg = if wl_count > 0 { wl_sum / wl_count as f64 } else { 0.5876 };
            let label = if s.label.trim().is_empty() {
                format!("Object {}", series_index + 1)
            } else {
                s.label.clone()
            };
            let color = s.color.clone().unwrap_or_else(|| "#2563eb".to_string());
            input_series.push((label, color, s.has_field_angle, rays, wl_avg));
        }
    }

    if input_series.is_empty() && !req.object_rows.is_empty() {
        input_series = build_native_object_ray_series(
            &rows,
            &surface_data,
            &req.object_rows,
            surface_index,
            traced_rays_req,
            &pattern,
            ring_count,
            &req.source_rows,
            &wavelength_mode,
        );
    }

    if input_series.is_empty() {
        let wavelengths = collect_spot_wavelengths(&req.source_rows, &wavelength_mode);
        for wl in wavelengths {
            let mut fallback_input_rays = Vec::<NativeSpotInputRay>::with_capacity(fallback_ray_count);
            for i in 0..fallback_ray_count {
                let b = i * 6;
                fallback_input_rays.push(NativeSpotInputRay {
                    start_p: NativeSpotVec3 { x: fallback_rays[b], y: fallback_rays[b + 1], z: fallback_rays[b + 2] },
                    dir: NativeSpotVec3 { x: fallback_rays[b + 3], y: fallback_rays[b + 4], z: fallback_rays[b + 5] },
                    wavelength_um: Some(wl.wavelength_um),
                    is_chief: i == 0,
                });
            }
            input_series.push((wl.label, wl.color, false, fallback_input_rays, wl.wavelength_um));
        }
    }

    let generated_rays_total = input_series
        .iter()
        .map(|(_, _, _, rays, _)| rays.len())
        .sum::<usize>();
    let ray_generation_ms = cmd_start.elapsed().as_secs_f64() * 1000.0;
    let mut unique_wavelengths = Vec::<f64>::new();
    for (_, _, _, _, wl) in &input_series {
        if !wl.is_finite() || *wl <= 0.0 {
            continue;
        }
        let exists = unique_wavelengths.iter().any(|v| (v - wl).abs() < 1e-9);
        if !exists {
            unique_wavelengths.push(*wl);
        }
    }
    let wavelength_count = unique_wavelengths.len();
    let mut series = Vec::<NativeSpotSeries>::new();
    let mut max_hit_rays = 0usize;
    let mut total_hit_rays = 0usize;
    let mut series_stats = Vec::<NativeSpotSeriesStats>::new();

    let trace_start = Instant::now();
    for (series_label, series_color, has_field_angle, rays, wl_um) in input_series {
        let packed = build_packed_meta(&rows, &surface_data, surface_index, wl_um)?;
        let mut points = Vec::<SpotPoint>::new();
        let mut chief_point_um: Option<SpotPoint> = None;
        let mut fallback_center_point_um: Option<SpotPoint> = None;
        let ray_count = rays.len();

        for i in 0..ray_count {
            let r = &rays[i];
            let start_dir = [
                r.start_p.x,
                r.start_p.y,
                r.start_p.z,
                r.dir.x,
                r.dir.y,
                r.dir.z,
            ];
            let hit = trace_single_ray_hit_point_with_meta_core(
                &start_dir,
                surface_index,
                1.0,
                &packed.row_meta,
                &packed.row_params,
                &packed.row_origins,
                &packed.row_inv_rots,
                &packed.row_rots,
                packed.row_count,
            );
            if (hit[0] - 1.0).abs() > f64::EPSILON {
                continue;
            }

            let relx = hit[2] - target_surface.origin[0];
            let rely = hit[3] - target_surface.origin[1];
            let relz = hit[4] - target_surface.origin[2];
            let local = mul_mat3_vec3(&target_surface.inv_rot, [relx, rely, relz]);

            if local[0].is_finite() && local[1].is_finite() {
                let point = SpotPoint {
                    x_um: local[0] * 1000.0,
                    y_um: local[1] * 1000.0,
                };
                if r.is_chief {
                    chief_point_um = Some(SpotPoint { x_um: point.x_um, y_um: point.y_um });
                }
                if fallback_center_point_um.is_none() {
                    fallback_center_point_um = Some(SpotPoint { x_um: point.x_um, y_um: point.y_um });
                }
                points.push(point);
            }
        }

        if chief_point_um.is_none() {
            chief_point_um = fallback_center_point_um;
        }

        let hit_rays = points.len();
        total_hit_rays += hit_rays;
        max_hit_rays = max_hit_rays.max(hit_rays);
        let hit_rate_percent = if ray_count > 0 {
            (hit_rays as f64 * 100.0) / (ray_count as f64)
        } else {
            0.0
        };
        series_stats.push(NativeSpotSeriesStats {
            label: series_label.clone(),
            attempted_rays: ray_count as u32,
            hit_rays: hit_rays as u32,
            hit_rate_percent,
        });
        series.push(NativeSpotSeries {
            label: series_label,
            color: series_color,
            wavelength_um: if wl_um.is_finite() && wl_um > 0.0 { Some(wl_um) } else { None },
            points,
            chief_point_um,
            has_field_angle,
        });
    }

    if series.is_empty() {
        return Err("run_native_spot_raytrace: no output series generated".to_string());
    }

    let total_attempted_rays = series_stats
        .iter()
        .map(|s| s.attempted_rays as usize)
        .sum::<usize>();
    let mean_hit_rate_percent = if total_attempted_rays > 0 {
        (total_hit_rays as f64 * 100.0) / (total_attempted_rays as f64)
    } else {
        0.0
    };
    let trace_ms = trace_start.elapsed().as_secs_f64() * 1000.0;

    Ok(NativeSpotRaytraceResponse {
        backend: "native-rust-raytrace".to_string(),
        surface_index,
        traced_rays: total_attempted_rays as u32,
        requested_rays: traced_rays_req as u32,
        generated_rays: generated_rays_total as u32,
        wavelength_count: wavelength_count as u32,
        total_attempted_rays: total_attempted_rays as u32,
        total_hit_rays: total_hit_rays as u32,
        max_hit_rays: max_hit_rays as u32,
        mean_hit_rate_percent,
        ray_generation_ms,
        trace_ms,
        series_stats,
        series,
        message: "Native Rust Spot raytrace completed".to_string(),
    })
}

fn build_sa_normalized_pupil_samples(ray_count: usize) -> Vec<f64> {
    let n = ray_count.max(2);
    let min_pupil = 0.001_f64;
    let mut out = Vec::<f64>::with_capacity(n);
    for i in 0..n {
        let t = if n > 1 { i as f64 / (n - 1) as f64 } else { 0.0 };
        let v = min_pupil + t * (1.0 - min_pupil);
        out.push((v * 1_000_000_000_000.0).round() / 1_000_000_000_000.0);
    }
    out.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    out.dedup_by(|a, b| (*a - *b).abs() < 1e-12);
    out
}

fn renormalize_sa_pupil_points(points: &mut [NativeSphericalAberrationPoint], scale: f64) {
    if !scale.is_finite() || scale <= 0.0 {
        return;
    }
    for point in points.iter_mut() {
        let p = point.pupil_coordinate / scale;
        point.pupil_coordinate = p.clamp(0.0, 1.0);
    }
}

fn is_mirror_row_native(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let material = obj
        .get("material")
        .or_else(|| obj.get("Material"))
        .and_then(value_to_string)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if material == "mirror" {
        return true;
    }
    let surf_type = obj
        .get("surfType")
        .or_else(|| obj.get("surfaceType"))
        .or_else(|| obj.get("type"))
        .and_then(value_to_string)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    surf_type == "mirror"
}

fn get_primary_wavelength_um_native(source_rows: &[Value], fallback: f64) -> f64 {
    let mut fallback_wl = fallback;
    for row in source_rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let wl = obj
            .get("wavelength")
            .or_else(|| obj.get("Wavelength"))
            .and_then(value_to_f64)
            .unwrap_or(f64::NAN);
        if wl.is_finite() && wl > 0.0 {
            fallback_wl = wl;
        }
        let primary_raw = obj
            .get("primary")
            .or_else(|| obj.get("Primary"))
            .or_else(|| obj.get("Primary Wavelength"))
            .and_then(value_to_string)
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if wl.is_finite() && wl > 0.0 && (primary_raw.contains("primary") || primary_raw == "true" || primary_raw == "1" || primary_raw == "yes") {
            return wl;
        }
    }
    fallback_wl
}

fn build_sa_axis_ray_native(
    pupil_norm: f64,
    meridional: bool,
    infinite_conjugate: bool,
    object_center: [f64; 3],
    stop_origin: [f64; 3],
    stop_u: [f64; 3],
    stop_v: [f64; 3],
    stop_radius: f64,
) -> [f64; 6] {
    let p = pupil_norm.clamp(0.0, 1.0);
    let stop_offset = p * stop_radius.max(1e-6);
    let off_u = if meridional { 0.0 } else { stop_offset };
    let off_v = if meridional { stop_offset } else { 0.0 };
    let chief_dir = [0.0_f64, 0.0_f64, 1.0_f64];

    if infinite_conjugate {
        let start = [
            object_center[0] + off_u * stop_u[0] + off_v * stop_v[0],
            object_center[1] + off_u * stop_u[1] + off_v * stop_v[1],
            object_center[2] + off_u * stop_u[2] + off_v * stop_v[2],
        ];
        return [start[0], start[1], start[2], chief_dir[0], chief_dir[1], chief_dir[2]];
    }

    let stop_target = [
        stop_origin[0] + off_u * stop_u[0] + off_v * stop_v[0],
        stop_origin[1] + off_u * stop_u[1] + off_v * stop_v[1],
        stop_origin[2] + off_u * stop_u[2] + off_v * stop_v[2],
    ];
    let dir = normalize3(
        stop_target[0] - object_center[0],
        stop_target[1] - object_center[1],
        stop_target[2] - object_center[2],
    );

    [object_center[0], object_center[1], object_center[2], dir[0], dir[1], dir[2]]
}

fn trace_focus_with_packed_native(
    ray: [f64; 6],
    target_surface_index: usize,
    target_surface_origin: [f64; 3],
    packed: &PackedMeta,
) -> Option<(f64, f64, f64)> {
    let hit = trace_single_ray_hit_point_with_meta_core(
        &ray,
        target_surface_index,
        1.0,
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
    let hx = hit[2];
    let hy = hit[3];
    let hz = hit[4];
    let dx = hit[5];
    let dy = hit[6];
    let dz = hit[7];
    if !hx.is_finite() || !hy.is_finite() || !hz.is_finite() || !dx.is_finite() || !dy.is_finite() || !dz.is_finite() {
        return None;
    }

    let denom = dx * dx + dy * dy;
    if denom.abs() < 1e-18 {
        return None;
    }
    let t = -((hx * dx) + (hy * dy)) / denom;
    let z_intersection = hz + t * dz;
    let focus_result = z_intersection - target_surface_origin[2];
    if !focus_result.is_finite() {
        return None;
    }
    Some((focus_result, hx, hy))
}

fn trace_target_with_packed_native(
    ray: [f64; 6],
    target_surface_index: usize,
    packed: &PackedMeta,
) -> Option<(f64, f64, f64, f64, f64, f64)> {
    let hit = trace_single_ray_hit_point_with_meta_core(
        &ray,
        target_surface_index,
        1.0,
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

    let hx = hit[2];
    let hy = hit[3];
    let hz = hit[4];
    let dx = hit[5];
    let dy = hit[6];
    let dz = hit[7];
    if !hx.is_finite() || !hy.is_finite() || !hz.is_finite() || !dx.is_finite() || !dy.is_finite() || !dz.is_finite() {
        return None;
    }
    Some((hx, hy, hz, dx, dy, dz))
}

fn project_hit_to_z_native(
    hit: (f64, f64, f64, f64, f64, f64),
    target_z: f64,
) -> Option<(f64, f64)> {
    let (hx, hy, hz, dx, dy, dz) = hit;
    if dz.abs() < 1e-12 {
        return None;
    }
    let t = (target_z - hz) / dz;
    let px = hx + t * dx;
    let py = hy + t * dy;
    if !px.is_finite() || !py.is_finite() {
        return None;
    }
    Some((px, py))
}

fn calculate_rms_at_z_native(
    fan_hits: &[(f64, f64, f64, f64, f64, f64)],
    chief_hit: (f64, f64, f64, f64, f64, f64),
    target_z: f64,
    meridional: bool,
) -> Option<f64> {
    let chief_at_z = project_hit_to_z_native(chief_hit, target_z)?;
    let mut deviations = Vec::<f64>::new();

    for hit in fan_hits {
        if let Some((x, y)) = project_hit_to_z_native(*hit, target_z) {
            let dev = if meridional {
                y - chief_at_z.1
            } else {
                x - chief_at_z.0
            };
            if dev.is_finite() {
                deviations.push(dev);
            }
        }
    }

    if deviations.is_empty() {
        return None;
    }

    let sum_sq: f64 = deviations.iter().map(|v| v * v).sum();
    Some((sum_sq / deviations.len() as f64).sqrt())
}

fn find_best_focus_z_native(
    fan_hits: &[(f64, f64, f64, f64, f64, f64)],
    chief_hit: (f64, f64, f64, f64, f64, f64),
    reference_z: f64,
    meridional: bool,
) -> Option<f64> {
    if fan_hits.len() < 3 {
        return None;
    }

    let search_range = 10.0_f64;
    let mut z_min = reference_z - search_range;
    let mut z_max = reference_z + search_range;

    let mut coarse_samples = Vec::<(f64, f64)>::new();
    let coarse_n = 41usize;
    let mut best_z = reference_z;
    let mut best_rms = f64::INFINITY;

    for i in 0..coarse_n {
        let z = z_min + (z_max - z_min) * (i as f64) / ((coarse_n - 1) as f64);
        if let Some(rms) = calculate_rms_at_z_native(fan_hits, chief_hit, z, meridional) {
            coarse_samples.push((z, rms));
            if rms < best_rms {
                best_rms = rms;
                best_z = z;
            }
        }
    }

    if !best_rms.is_finite() || coarse_samples.len() < 3 {
        return None;
    }

    coarse_samples.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let best_idx = coarse_samples
        .iter()
        .position(|(z, _)| (*z - best_z).abs() < 1e-12)
        .unwrap_or(0);
    let left_idx = best_idx.saturating_sub(2);
    let right_idx = (best_idx + 2).min(coarse_samples.len().saturating_sub(1));
    z_min = coarse_samples[left_idx].0;
    z_max = coarse_samples[right_idx].0;

    let tol = 1e-3_f64;
    let max_iter = 30usize;
    let phi = (1.0 + 5.0_f64.sqrt()) * 0.5;
    let resphi = 2.0 - phi;

    let mut a = z_min;
    let mut b = z_max;
    let mut x1 = a + resphi * (b - a);
    let mut x2 = b - resphi * (b - a);
    let mut f1 = calculate_rms_at_z_native(fan_hits, chief_hit, x1, meridional)?;
    let mut f2 = calculate_rms_at_z_native(fan_hits, chief_hit, x2, meridional)?;

    let mut iter = 0usize;
    while iter < max_iter && (b - a) > tol {
        if f1 < f2 {
            b = x2;
            x2 = x1;
            f2 = f1;
            x1 = a + resphi * (b - a);
            f1 = match calculate_rms_at_z_native(fan_hits, chief_hit, x1, meridional) {
                Some(v) => v,
                None => break,
            };
        } else {
            a = x1;
            x1 = x2;
            f1 = f2;
            x2 = b - resphi * (b - a);
            f2 = match calculate_rms_at_z_native(fan_hits, chief_hit, x2, meridional) {
                Some(v) => v,
                None => break,
            };
        }
        iter += 1;
    }

    Some((a + b) * 0.5)
}

fn select_axis_fan_rays_native(
    rays: &[NativeSpotInputRay],
    chief: &NativeSpotInputRay,
    meridional: bool,
    desired_count: usize,
) -> Vec<[f64; 6]> {
    let mut candidates = Vec::<(f64, [f64; 6])>::new();

    for ray in rays {
        if ray.is_chief {
            continue;
        }

        let off_x = ray.start_p.x - chief.start_p.x;
        let off_y = ray.start_p.y - chief.start_p.y;
        let primary = if meridional { off_y.abs() } else { off_x.abs() };
        let secondary = if meridional { off_x.abs() } else { off_y.abs() };
        if !primary.is_finite() || primary < 1e-8 {
            continue;
        }

        let ratio = secondary / primary;
        if !ratio.is_finite() || ratio > 0.35 {
            continue;
        }

        candidates.push((
            primary,
            [
                ray.start_p.x,
                ray.start_p.y,
                ray.start_p.z,
                ray.dir.x,
                ray.dir.y,
                ray.dir.z,
            ],
        ));
    }

    if candidates.len() < 5 {
        let mut loose = Vec::<(f64, [f64; 6])>::new();
        for ray in rays {
            if ray.is_chief {
                continue;
            }
            let off_x = ray.start_p.x - chief.start_p.x;
            let off_y = ray.start_p.y - chief.start_p.y;
            let primary = if meridional { off_y.abs() } else { off_x.abs() };
            let secondary = if meridional { off_x.abs() } else { off_y.abs() };
            if !primary.is_finite() || primary < 1e-8 {
                continue;
            }
            if secondary <= primary {
                loose.push((
                    primary,
                    [
                        ray.start_p.x,
                        ray.start_p.y,
                        ray.start_p.z,
                        ray.dir.x,
                        ray.dir.y,
                        ray.dir.z,
                    ],
                ));
            }
        }
        candidates = loose;
    }

    candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    if candidates.is_empty() {
        return Vec::new();
    }

    let take_count = desired_count.max(3).min(candidates.len());
    if take_count == candidates.len() {
        return candidates.into_iter().map(|(_, ray)| ray).collect();
    }

    let mut out = Vec::<[f64; 6]>::new();
    for i in 0..take_count {
        let idx = ((i as f64) * ((candidates.len() - 1) as f64) / ((take_count - 1) as f64)).round() as usize;
        out.push(candidates[idx].1);
    }
    out
}

fn intersect_ray_with_plane_native(
    start: [f64; 3],
    dir: [f64; 3],
    plane_center: [f64; 3],
    plane_normal: [f64; 3],
) -> Option<[f64; 3]> {
    let denom = dir[0] * plane_normal[0] + dir[1] * plane_normal[1] + dir[2] * plane_normal[2];
    if !denom.is_finite() || denom.abs() < 1e-12 {
        return None;
    }
    let vx = plane_center[0] - start[0];
    let vy = plane_center[1] - start[1];
    let vz = plane_center[2] - start[2];
    let t = (vx * plane_normal[0] + vy * plane_normal[1] + vz * plane_normal[2]) / denom;
    if !t.is_finite() {
        return None;
    }
    Some([start[0] + t * dir[0], start[1] + t * dir[1], start[2] + t * dir[2]])
}

fn select_axis_fan_rays_by_stop_plane_native(
    rays: &[NativeSpotInputRay],
    chief: &NativeSpotInputRay,
    meridional: bool,
    desired_count: usize,
    stop_center: [f64; 3],
    stop_u: [f64; 3],
    stop_v: [f64; 3],
) -> Vec<[f64; 6]> {
    let stop_n = normalize3(
        stop_u[1] * stop_v[2] - stop_u[2] * stop_v[1],
        stop_u[2] * stop_v[0] - stop_u[0] * stop_v[2],
        stop_u[0] * stop_v[1] - stop_u[1] * stop_v[0],
    );

    let chief_start = [chief.start_p.x, chief.start_p.y, chief.start_p.z];
    let chief_dir = [chief.dir.x, chief.dir.y, chief.dir.z];
    let chief_p = match intersect_ray_with_plane_native(chief_start, chief_dir, stop_center, stop_n) {
        Some(p) => p,
        None => {
            return select_axis_fan_rays_native(rays, chief, meridional, desired_count);
        }
    };

    let extract_candidates = |strict_ratio: f64| -> Vec<(f64, [f64; 6])> {
        let mut out = Vec::<(f64, [f64; 6])>::new();
        for ray in rays {
            if ray.is_chief {
                continue;
            }

            let start = [ray.start_p.x, ray.start_p.y, ray.start_p.z];
            let dir = [ray.dir.x, ray.dir.y, ray.dir.z];
            let Some(p) = intersect_ray_with_plane_native(start, dir, stop_center, stop_n) else {
                continue;
            };

            let rel = [p[0] - chief_p[0], p[1] - chief_p[1], p[2] - chief_p[2]];
            let du = rel[0] * stop_u[0] + rel[1] * stop_u[1] + rel[2] * stop_u[2];
            let dv = rel[0] * stop_v[0] + rel[1] * stop_v[1] + rel[2] * stop_v[2];
            let primary = if meridional { dv } else { du };
            let secondary = if meridional { du.abs() } else { dv.abs() };
            let primary_abs = primary.abs();
            if !primary_abs.is_finite() || primary_abs < 1e-8 {
                continue;
            }
            let ratio = secondary / primary_abs;
            if !ratio.is_finite() || ratio > strict_ratio {
                continue;
            }

            out.push((
                primary,
                [
                    ray.start_p.x,
                    ray.start_p.y,
                    ray.start_p.z,
                    ray.dir.x,
                    ray.dir.y,
                    ray.dir.z,
                ],
            ));
        }
        out
    };

    let mut candidates = extract_candidates(0.35);
    if candidates.len() < 5 {
        candidates = extract_candidates(0.8);
    }
    if candidates.len() < 5 {
        return select_axis_fan_rays_native(rays, chief, meridional, desired_count);
    }

    candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let take_count = desired_count.max(3).min(candidates.len());
    if take_count >= candidates.len() {
        return candidates.into_iter().map(|(_, ray)| ray).collect();
    }

    let mut out = Vec::<[f64; 6]>::with_capacity(take_count);
    for i in 0..take_count {
        let idx = ((i as f64) * ((candidates.len() - 1) as f64) / ((take_count - 1) as f64)).round() as usize;
        out.push(candidates[idx].1);
    }
    out
}

fn select_axis_hits_from_successful_rays_by_stop_plane_native(
    successful: &[([f64; 6], (f64, f64, f64, f64, f64, f64))],
    chief: &NativeSpotInputRay,
    meridional: bool,
    desired_count: usize,
    stop_center: [f64; 3],
    stop_u: [f64; 3],
    stop_v: [f64; 3],
) -> Vec<(f64, f64, f64, f64, f64, f64)> {
    if successful.is_empty() {
        return Vec::new();
    }

    let stop_n = normalize3(
        stop_u[1] * stop_v[2] - stop_u[2] * stop_v[1],
        stop_u[2] * stop_v[0] - stop_u[0] * stop_v[2],
        stop_u[0] * stop_v[1] - stop_u[1] * stop_v[0],
    );

    let chief_start = [chief.start_p.x, chief.start_p.y, chief.start_p.z];
    let chief_dir = [chief.dir.x, chief.dir.y, chief.dir.z];
    let Some(chief_p) = intersect_ray_with_plane_native(chief_start, chief_dir, stop_center, stop_n) else {
        return Vec::new();
    };

    let mut axis_candidates = Vec::<(f64, f64, (f64, f64, f64, f64, f64, f64))>::new();
    let mut relaxed_candidates = Vec::<(f64, f64, (f64, f64, f64, f64, f64, f64))>::new();

    for (ray, hit) in successful {
        let start = [ray[0], ray[1], ray[2]];
        let dir = [ray[3], ray[4], ray[5]];
        let Some(p) = intersect_ray_with_plane_native(start, dir, stop_center, stop_n) else {
            continue;
        };

        let rel = [p[0] - chief_p[0], p[1] - chief_p[1], p[2] - chief_p[2]];
        let du = rel[0] * stop_u[0] + rel[1] * stop_u[1] + rel[2] * stop_u[2];
        let dv = rel[0] * stop_v[0] + rel[1] * stop_v[1] + rel[2] * stop_v[2];
        let primary = if meridional { dv } else { du };
        let secondary = if meridional { du.abs() } else { dv.abs() };
        let primary_abs = primary.abs();
        if !primary_abs.is_finite() || primary_abs < 1e-8 {
            continue;
        }
        let ratio = secondary / primary_abs;
        if !ratio.is_finite() {
            continue;
        }

        let item = (primary, ratio, *hit);
        if ratio <= 0.8 {
            axis_candidates.push(item);
        }
        relaxed_candidates.push(item);
    }

    let mut candidates = if axis_candidates.len() >= 3 {
        axis_candidates
    } else {
        relaxed_candidates
    };

    if candidates.is_empty() {
        return Vec::new();
    }

    candidates.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let take_count = desired_count.max(3).min(candidates.len());
    if take_count >= candidates.len() {
        return candidates.into_iter().map(|(_, _, hit)| hit).collect();
    }

    let mut out = Vec::<(f64, f64, f64, f64, f64, f64)>::with_capacity(take_count);
    for i in 0..take_count {
        let idx = ((i as f64) * ((candidates.len() - 1) as f64) / ((take_count - 1) as f64)).round() as usize;
        out.push(candidates[idx].2);
    }
    out
}

#[tauri::command]
pub fn run_native_spherical_aberration(req: NativeSphericalAberrationRequest) -> Result<NativeSphericalAberrationResponse, String> {
    if req.optical_system_rows.is_empty() {
        return Err("run_native_spherical_aberration: opticalSystemRows is empty".to_string());
    }

    let rows: Vec<Value> = req
        .optical_system_rows
        .iter()
        .map(normalize_coord_trans_row)
        .collect();
    if rows.is_empty() {
        return Err("run_native_spherical_aberration: normalized rows are empty".to_string());
    }

    let surface_data = calculate_surface_data(&rows);
    if surface_data.len() != rows.len() {
        return Err("run_native_spherical_aberration: failed to calculate surface origins".to_string());
    }

    let surface_index = req
        .surface_index
        .unwrap_or_else(|| rows.len().saturating_sub(1))
        .min(rows.len().saturating_sub(1));
    let target_surface = surface_data[surface_index];

    let stop_index = find_stop_surface_index_native(&rows)
        .unwrap_or_else(|| rows.len().saturating_sub(1));
    let stop_surface = surface_data
        .get(stop_index)
        .copied()
        .unwrap_or(target_surface);

    let stop_rot = stop_surface.rot;
    let stop_u = normalize3(stop_rot[0], stop_rot[3], stop_rot[6]);
    let stop_v = normalize3(stop_rot[1], stop_rot[4], stop_rot[7]);

    let stop_radius = {
        let est = estimate_stop_radius_mm(&rows);
        if est.is_finite() && est > 1e-6 {
            est
        } else {
            estimate_entrance_radius_mm(&rows).clamp(0.1, 500.0)
        }
    };
    let ray_count = req.ray_count.unwrap_or(51).clamp(2, 2001) as usize;
    let normalized_samples = build_sa_normalized_pupil_samples(ray_count);

    let wavelength_mode = req
        .wavelength_mode
        .unwrap_or_else(|| "all".to_string())
        .trim()
        .to_lowercase();
    let wavelengths = collect_spot_wavelengths(&req.source_rows, &wavelength_mode);
    if wavelengths.is_empty() {
        return Err("run_native_spherical_aberration: no wavelength candidates".to_string());
    }

    let infinite_conjugate = is_infinite_conjugate_native(&rows);
    let object_plane_z = surface_data.first().map(|s| s.origin[2]).unwrap_or(0.0);
    let object_z = if infinite_conjugate { object_plane_z - 25.0 } else { object_plane_z };
    let object_sag = compute_object_surface_sag_native(&rows, 0.0, 0.0);
    let object_center = [0.0_f64, 0.0_f64, object_z + object_sag];

    let mirror_count = rows.iter().filter(|row| is_mirror_row_native(row)).count();
    let mirror_sign = if (mirror_count % 2) == 1 { -1.0 } else { 1.0 };

    let reference_mode = req
        .reference_focus_mode
        .unwrap_or_else(|| "current-paraxial".to_string())
        .trim()
        .to_lowercase();

    let mut meridional_data = Vec::<NativeSphericalAberrationSeries>::new();
    let mut sagittal_data = Vec::<NativeSphericalAberrationSeries>::new();

    struct WlTemp {
        wavelength: f64,
        meridional: Vec<(f64, f64, f64, f64)>,
        sagittal: Vec<(f64, f64, f64, f64)>,
        current_reference: Option<f64>,
        chief_reference: Option<f64>,
    }

    let mut all_temp = Vec::<WlTemp>::new();
    for wl in &wavelengths {
        let wavelength_um = wl.wavelength_um;
        let packed = match build_packed_meta(&rows, &surface_data, surface_index, wavelength_um) {
            Ok(p) => p,
            Err(_) => continue,
        };

        let chief_ray = build_sa_axis_ray_native(
            0.0,
            true,
            infinite_conjugate,
            object_center,
            stop_surface.origin,
            stop_u,
            stop_v,
            stop_radius,
        );
        let chief_reference = trace_focus_with_packed_native(chief_ray, surface_index, target_surface.origin, &packed)
            .map(|(focus, _, _)| focus);

        let mut meridional = Vec::<(f64, f64, f64, f64)>::new();
        let mut sagittal = Vec::<(f64, f64, f64, f64)>::new();
        let mut best_ref: Option<(f64, f64)> = None;

        for p in &normalized_samples {
            let mr = build_sa_axis_ray_native(
                *p,
                true,
                infinite_conjugate,
                object_center,
                stop_surface.origin,
                stop_u,
                stop_v,
                stop_radius,
            );
            if let Some((focus, hit_x, hit_y)) = trace_focus_with_packed_native(mr, surface_index, target_surface.origin, &packed) {
                meridional.push((*p, focus, hit_x, hit_y));
                let score = p * p;
                match best_ref {
                    None => best_ref = Some((score, focus)),
                    Some((best_score, _)) if score < best_score => best_ref = Some((score, focus)),
                    _ => {}
                }
            }

            let sr = build_sa_axis_ray_native(
                *p,
                false,
                infinite_conjugate,
                object_center,
                stop_surface.origin,
                stop_u,
                stop_v,
                stop_radius,
            );
            if let Some((focus, hit_x, hit_y)) = trace_focus_with_packed_native(sr, surface_index, target_surface.origin, &packed) {
                sagittal.push((*p, focus, hit_x, hit_y));
            }
        }

        all_temp.push(WlTemp {
            wavelength: wavelength_um,
            meridional,
            sagittal,
            current_reference: best_ref.map(|(_, f)| f),
            chief_reference,
        });
    }

    if all_temp.is_empty() {
        return Err("run_native_spherical_aberration: failed to trace rays".to_string());
    }

    let primary_wl = get_primary_wavelength_um_native(&req.source_rows, all_temp[0].wavelength);
    let primary_entry = all_temp
        .iter()
        .min_by(|a, b| {
            (a.wavelength - primary_wl)
                .abs()
                .partial_cmp(&(b.wavelength - primary_wl).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    let primary_reference = primary_entry
        .and_then(|v| v.current_reference.or(v.chief_reference));

    let mut pupil_renormalized = false;
    let mut max_observed_pupil_global = 0.0_f64;

    for entry in all_temp {
        let ref_focus = if reference_mode == "chief-ray" {
            entry.chief_reference.or(entry.current_reference).unwrap_or(0.0)
        } else if reference_mode == "primary-paraxial" {
            primary_reference
                .or(entry.current_reference)
                .or(entry.chief_reference)
                .unwrap_or(0.0)
        } else {
            entry.current_reference.or(entry.chief_reference).unwrap_or(0.0)
        };

        let mut mer_points = entry
            .meridional
            .iter()
            .map(|(p, focus, _hit_x, hit_y)| NativeSphericalAberrationPoint {
                pupil_coordinate: *p,
                longitudinal_aberration: mirror_sign * (focus - ref_focus),
                focus_position: mirror_sign * (*focus),
                stop_height: p * stop_radius,
                transverse_aberration: *hit_y - target_surface.origin[1],
                sine_condition_violation: None,
            })
            .collect::<Vec<_>>();
        mer_points.sort_by(|a, b| a.pupil_coordinate.partial_cmp(&b.pupil_coordinate).unwrap_or(std::cmp::Ordering::Equal));

        let mut sag_points = entry
            .sagittal
            .iter()
            .map(|(p, focus, hit_x, _hit_y)| NativeSphericalAberrationPoint {
                pupil_coordinate: *p,
                longitudinal_aberration: mirror_sign * (focus - ref_focus),
                focus_position: mirror_sign * (*focus),
                stop_height: p * stop_radius,
                transverse_aberration: *hit_x - target_surface.origin[0],
                sine_condition_violation: None,
            })
            .collect::<Vec<_>>();

        let mer_max = mer_points
            .iter()
            .map(|p| p.pupil_coordinate)
            .filter(|v| v.is_finite())
            .fold(0.0_f64, f64::max);
        let sag_max = sag_points
            .iter()
            .map(|p| p.pupil_coordinate)
            .filter(|v| v.is_finite())
            .fold(0.0_f64, f64::max);
        let observed_max = mer_max.max(sag_max);
        max_observed_pupil_global = max_observed_pupil_global.max(observed_max);
        if observed_max.is_finite() && observed_max > 1e-9 && observed_max < 0.95 {
            renormalize_sa_pupil_points(&mut mer_points, observed_max);
            renormalize_sa_pupil_points(&mut sag_points, observed_max);
            pupil_renormalized = true;
        }

        sag_points.sort_by(|a, b| a.pupil_coordinate.partial_cmp(&b.pupil_coordinate).unwrap_or(std::cmp::Ordering::Equal));

        meridional_data.push(NativeSphericalAberrationSeries {
            wavelength: entry.wavelength,
            ray_type: "meridional".to_string(),
            points: mer_points,
            paraxial_aberration: None,
        });
        sagittal_data.push(NativeSphericalAberrationSeries {
            wavelength: entry.wavelength,
            ray_type: "sagittal".to_string(),
            points: sag_points,
            paraxial_aberration: None,
        });
    }

    let mut summary = Map::new();
    summary.insert("surfaceIndex".to_string(), Value::from(surface_index as i64));
    summary.insert("rayCount".to_string(), Value::from(ray_count as i64));
    summary.insert("wavelengthCount".to_string(), Value::from(meridional_data.len() as i64));
    summary.insert("referenceFocusMode".to_string(), Value::from(reference_mode));
    summary.insert("stopRadiusMm".to_string(), Value::from(stop_radius));
    summary.insert("infiniteConjugate".to_string(), Value::from(infinite_conjugate));
    summary.insert("pupilRenormalized".to_string(), Value::from(pupil_renormalized));
    summary.insert("maxObservedPupilCoordinate".to_string(), Value::from(max_observed_pupil_global));

    Ok(NativeSphericalAberrationResponse {
        backend: "native-rust-spherical-aberration".to_string(),
        meridional_data,
        sagittal_data,
        message: "Native Rust spherical aberration completed".to_string(),
        summary,
    })
}

#[tauri::command]
pub fn log_native_astigmatism_debug(
    req: NativeAstigmatismDebugRequest,
) -> Result<NativeAstigmatismDebugResponse, String> {
    let _ = (
        req.target_surface_index,
        req.ray_count,
        req.ring_count,
        req.pattern.as_deref(),
        req.chief_ray_mode.as_deref(),
        req.require_rust,
    );
    let optical_count = req.optical_system_rows.len();
    let source_count = req.source_rows.len();
    let object_count = req.object_rows.len();

    Ok(NativeAstigmatismDebugResponse {
        ok: true,
        message: "native astigmatism debug logged".to_string(),
        optical_count,
        source_count,
        object_count,
    })
}

#[tauri::command]
pub fn run_native_astigmatism(
    req: NativeAstigmatismRequest,
) -> Result<NativeAstigmatismResponse, String> {
    if req.optical_system_rows.is_empty() {
        return Err("run_native_astigmatism: opticalSystemRows is empty".to_string());
    }

    let rows: Vec<Value> = req
        .optical_system_rows
        .iter()
        .map(normalize_coord_trans_row)
        .collect();
    if rows.is_empty() {
        return Err("run_native_astigmatism: normalized rows are empty".to_string());
    }

    let surface_data = calculate_surface_data(&rows);
    if surface_data.len() != rows.len() {
        return Err("run_native_astigmatism: failed to calculate surface origins".to_string());
    }

    let target_surface_index = req
        .surface_index
        .unwrap_or_else(|| rows.len().saturating_sub(1))
        .min(rows.len().saturating_sub(1));
    let stop_surface_index = find_stop_surface_index_native(&rows)
        .unwrap_or_else(|| rows.len().saturating_sub(1))
        .min(rows.len().saturating_sub(1));
    let stop_surface = surface_data[stop_surface_index];
    let stop_rot = stop_surface.rot;
    let stop_plane_u = normalize3(stop_rot[0], stop_rot[3], stop_rot[6]);
    let stop_plane_v = normalize3(stop_rot[1], stop_rot[4], stop_rot[7]);

    let infinite_conjugate = is_infinite_conjugate_native(&rows);
    let field_mode = if infinite_conjugate { "angle" } else { "height" }.to_string();
    let is_angle_field = infinite_conjugate;

    let traced_rays_req = req.ray_count.unwrap_or(71).clamp(9, 2001) as usize;
    let ring_count = req.ring_count.unwrap_or(10).clamp(1, 64) as usize;
    let pattern_owned = req
        .pattern
        .unwrap_or_else(|| "annular".to_string())
        .trim()
        .to_lowercase();
    let pattern = if pattern_owned == "grid" {
        "grid"
    } else if pattern_owned == "cross" {
        "cross"
    } else {
        "annular"
    };
    let wavelength_mode = req
        .wavelength_mode
        .unwrap_or_else(|| "all".to_string());
    let _chief_ray_mode = req
        .chief_ray_mode
        .unwrap_or_else(|| "stopCenter".to_string());

    let primary_wavelength = get_primary_wavelength_um_native(&req.source_rows, 0.5876);
    let mut object_rows = req.object_rows.clone();
    if object_rows.is_empty() {
        let fallback = if infinite_conjugate {
            serde_json::json!({"name":"AutoField0","position":"Angle","xHeightAngle":0.0,"yHeightAngle":0.0})
        } else {
            serde_json::json!({"name":"AutoField0","position":"Rectangle","xHeight":0.0,"yHeight":0.0})
        };
        object_rows.push(fallback);
    }

    object_rows = maybe_interpolate_angle_object_rows_for_astig(&object_rows, infinite_conjugate);

    let wavelengths = collect_spot_wavelengths(&req.source_rows, &wavelength_mode);
    if wavelengths.is_empty() {
        return Err("run_native_astigmatism: no wavelength candidates".to_string());
    }

    let generated_series = build_native_object_ray_series(
        &rows,
        &surface_data,
        &object_rows,
        target_surface_index,
        traced_rays_req,
        pattern,
        ring_count,
        &req.source_rows,
        &wavelength_mode,
    );
    if generated_series.is_empty() {
        return Err("run_native_astigmatism: failed to generate native rays".to_string());
    }

    let mut object_field_map = HashMap::<String, (f64, String, String)>::new();
    for (obj_idx, obj) in object_rows.iter().enumerate() {
        let Some(o) = obj.as_object() else {
            continue;
        };
        let label = resolve_native_object_label(o, obj_idx);
        let display_name = resolve_native_object_display_name(o, &label);
        let has_field_angle = is_angle_object_native(o, infinite_conjugate);
        let field_axis = extract_object_field_axis_native(o, has_field_angle);
        let position = if has_field_angle { "Angle" } else { "Rectangle" }.to_string();
        object_field_map.insert(label, (field_axis, display_name, position));
    }

    let mut field_settings: Vec<NativeAstigmatismFieldSetting> = Vec::new();
    let mut temp_rows: Vec<(f64, f64, String, Option<f64>, Option<f64>, Option<f64>)> = Vec::new();
    let mut previous_focus_by_wavelength = HashMap::<i64, (Option<f64>, Option<f64>)>::new();

    for (series_label, _series_color, has_field_angle, rays, wavelength_um) in generated_series {
        if rays.is_empty() {
            continue;
        }

        let packed = match build_packed_meta(&rows, &surface_data, target_surface_index, wavelength_um) {
            Ok(p) => p,
            Err(_) => continue,
        };

        let chief = rays.iter().find(|r| r.is_chief).unwrap_or(&rays[0]);
        let chief_ray_vec = [
            chief.start_p.x,
            chief.start_p.y,
            chief.start_p.z,
            chief.dir.x,
            chief.dir.y,
            chief.dir.z,
        ];
        let chief_hit = trace_target_with_packed_native(
            chief_ray_vec,
            target_surface_index,
            &packed,
        );

        let mut chief_for_axis = chief;
        let mut chief_hit_effective = chief_hit;
        let mut _chief_hit_fallback_used = false;

        if chief_hit_effective.is_none() {
            let chief_start_xy = [chief.start_p.x, chief.start_p.y];
            let mut best_dist2 = f64::INFINITY;
            let mut best_hit: Option<(f64, f64, f64, f64, f64, f64)> = None;
            let mut best_ray: Option<&NativeSpotInputRay> = None;
            for r in &rays {
                let ray_vec = [
                    r.start_p.x,
                    r.start_p.y,
                    r.start_p.z,
                    r.dir.x,
                    r.dir.y,
                    r.dir.z,
                ];
                if let Some(hit) = trace_target_with_packed_native(ray_vec, target_surface_index, &packed) {
                    let dx = r.start_p.x - chief_start_xy[0];
                    let dy = r.start_p.y - chief_start_xy[1];
                    let d2 = dx * dx + dy * dy;
                    if d2.is_finite() && d2 < best_dist2 {
                        best_dist2 = d2;
                        best_hit = Some(hit);
                        best_ray = Some(r);
                    }
                }
            }
            if let Some(hit) = best_hit {
                chief_hit_effective = Some(hit);
                _chief_hit_fallback_used = true;
            }
            if let Some(ray) = best_ray {
                chief_for_axis = ray;
            }
        }

        let chief_start = [
            chief_for_axis.start_p.x,
            chief_for_axis.start_p.y,
            chief_for_axis.start_p.z,
        ];
        let chief_trace = trace_focus_with_packed_native(
            [
                chief_for_axis.start_p.x,
                chief_for_axis.start_p.y,
                chief_for_axis.start_p.z,
                chief_for_axis.dir.x,
                chief_for_axis.dir.y,
                chief_for_axis.dir.z,
            ],
            target_surface_index,
            surface_data[target_surface_index].origin,
            &packed,
        );
        let paraxial = chief_trace.map(|(f, _, _)| f);

        let axis_fan_target = if pattern == "cross" {
            traced_rays_req.saturating_sub(1).clamp(25, 401)
        } else {
            ((traced_rays_req as f64).sqrt() * 3.0).round() as usize
        };
        let axis_fan_target = axis_fan_target.clamp(25, 401);
        let min_axis_hits_for_rms = 5usize;

        let mer_fan = select_axis_fan_rays_by_stop_plane_native(
            &rays,
            chief_for_axis,
            true,
            axis_fan_target,
            stop_surface.origin,
            stop_plane_u,
            stop_plane_v,
        );
        let sag_fan = select_axis_fan_rays_by_stop_plane_native(
            &rays,
            chief_for_axis,
            false,
            axis_fan_target,
            stop_surface.origin,
            stop_plane_u,
            stop_plane_v,
        );

        let mut mer_hits = Vec::<(f64, f64, f64, f64, f64, f64)>::new();
        for ray in &mer_fan {
            if let Some(hit) = trace_target_with_packed_native(*ray, target_surface_index, &packed) {
                mer_hits.push(hit);
            }
        }

        let mut sag_hits = Vec::<(f64, f64, f64, f64, f64, f64)>::new();
        for ray in &sag_fan {
            if let Some(hit) = trace_target_with_packed_native(*ray, target_surface_index, &packed) {
                sag_hits.push(hit);
            }
        }

        let need_axis_fallback = mer_hits.len() < min_axis_hits_for_rms || sag_hits.len() < min_axis_hits_for_rms;
        if need_axis_fallback {
            let mut successful_non_chief = Vec::<([f64; 6], (f64, f64, f64, f64, f64, f64))>::new();
            for ray in &rays {
                if ray.is_chief {
                    continue;
                }
                let ray_vec = [
                    ray.start_p.x,
                    ray.start_p.y,
                    ray.start_p.z,
                    ray.dir.x,
                    ray.dir.y,
                    ray.dir.z,
                ];
                if let Some(hit) = trace_target_with_packed_native(ray_vec, target_surface_index, &packed) {
                    successful_non_chief.push((ray_vec, hit));
                }
            }

            if mer_hits.len() < min_axis_hits_for_rms {
                let recovered = select_axis_hits_from_successful_rays_by_stop_plane_native(
                    &successful_non_chief,
                    chief_for_axis,
                    true,
                    axis_fan_target,
                    stop_surface.origin,
                    stop_plane_u,
                    stop_plane_v,
                );
                if recovered.len() > mer_hits.len() {
                    mer_hits = recovered;
                }
            }

            if sag_hits.len() < min_axis_hits_for_rms {
                let recovered = select_axis_hits_from_successful_rays_by_stop_plane_native(
                    &successful_non_chief,
                    chief_for_axis,
                    false,
                    axis_fan_target,
                    stop_surface.origin,
                    stop_plane_u,
                    stop_plane_v,
                );
                if recovered.len() > sag_hits.len() {
                    sag_hits = recovered;
                }
            }
        }

        let mut mer_focuses: Vec<f64> = Vec::new();
        let mut sag_focuses: Vec<f64> = Vec::new();

        for ray in &rays {
            let result = trace_focus_with_packed_native(
                [
                    ray.start_p.x,
                    ray.start_p.y,
                    ray.start_p.z,
                    ray.dir.x,
                    ray.dir.y,
                    ray.dir.z,
                ],
                target_surface_index,
                surface_data[target_surface_index].origin,
                &packed,
            );
            let Some((focus, _hx, _hy)) = result else {
                continue;
            };

            if let Some(chief_focus) = paraxial {
                if (focus - chief_focus).abs() > 50.0 {
                    continue;
                }
            }

            let dx = ray.start_p.x - chief_start[0];
            let dy = ray.start_p.y - chief_start[1];
            if dx.abs() <= dy.abs() {
                mer_focuses.push(focus);
            } else {
                sag_focuses.push(focus);
            }
        }

        let median_or = |values: &[f64], fallback: Option<f64>| -> Option<f64> {
            if !values.is_empty() {
                let mut sorted = values.to_vec();
                sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                let n = sorted.len();
                if n % 2 == 1 {
                    Some(sorted[n / 2])
                } else {
                    Some((sorted[(n / 2) - 1] + sorted[n / 2]) * 0.5)
                }
            } else {
                fallback
            }
        };

        let chief_image_surface_z_rel = chief_hit_effective
            .map(|(_, _, hz, _, _, _)| hz - surface_data[target_surface_index].origin[2]);

        let mer_focus_rms = match (chief_hit_effective, chief_image_surface_z_rel) {
            (Some(ch), Some(z_rel)) if mer_hits.len() >= min_axis_hits_for_rms => {
                let best_global_z = find_best_focus_z_native(
                    &mer_hits,
                    ch,
                    z_rel + surface_data[target_surface_index].origin[2],
                    true,
                );
                best_global_z.map(|z| z - surface_data[target_surface_index].origin[2])
            }
            _ => None,
        };

        let sag_focus_rms = match (chief_hit_effective, chief_image_surface_z_rel) {
            (Some(ch), Some(z_rel)) if sag_hits.len() >= min_axis_hits_for_rms => {
                let best_global_z = find_best_focus_z_native(
                    &sag_hits,
                    ch,
                    z_rel + surface_data[target_surface_index].origin[2],
                    false,
                );
                best_global_z.map(|z| z - surface_data[target_surface_index].origin[2])
            }
            _ => None,
        };

        let wavelength_key = (wavelength_um * 1_000_000.0).round() as i64;
        let (prev_mer_focus, prev_sag_focus) = previous_focus_by_wavelength
            .get(&wavelength_key)
            .copied()
            .unwrap_or((None, None));

        let mer_focus = mer_focus_rms
            .or(prev_mer_focus)
            .or_else(|| median_or(&mer_focuses, paraxial));
        let sag_focus = sag_focus_rms
            .or(prev_sag_focus)
            .or_else(|| median_or(&sag_focuses, paraxial));

        previous_focus_by_wavelength.insert(wavelength_key, (mer_focus, sag_focus));

        let base_label = extract_series_base_label(&series_label);
        let (field_axis, display_name, position) = object_field_map
            .get(&base_label)
            .cloned()
            .unwrap_or_else(|| {
                (
                    parse_field_axis_from_label(&series_label).unwrap_or(0.0),
                    base_label.clone(),
                    if has_field_angle { "Angle" } else { "Rectangle" }.to_string(),
                )
            });
        field_settings.push(NativeAstigmatismFieldSetting {
            display_name: display_name.clone(),
            y: field_axis,
            position: position.clone(),
        });

        temp_rows.push((
            wavelength_um,
            field_axis,
            display_name,
            paraxial,
            mer_focus,
            sag_focus,
        ));
    }

    if temp_rows.is_empty() {
        return Err("run_native_astigmatism: no valid field rows".to_string());
    }

    field_settings.sort_by(|a, b| {
        let ay = a.y.abs();
        let by = b.y.abs();
        ay.partial_cmp(&by)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.display_name.cmp(&b.display_name))
    });
    field_settings.dedup_by(|a, b| {
        a.display_name == b.display_name
            && a.position == b.position
            && (a.y - b.y).abs() < 1e-9
    });

    let mut primary_reference: Option<f64> = None;
    let mut best_axis = f64::INFINITY;
    for (wl, axis, _name, paraxial, _mer, _sag) in &temp_rows {
        if (wl - primary_wavelength).abs() > 1e-6 {
            continue;
        }
        let a = axis.abs();
        if a < best_axis {
            best_axis = a;
            primary_reference = *paraxial;
        }
    }
    if primary_reference.is_none() {
        primary_reference = temp_rows
            .iter()
            .find(|(wl, _, _, _, _, _)| (*wl - primary_wavelength).abs() <= 1e-6)
            .and_then(|(_, _, _, paraxial, _, _)| *paraxial);
    }

    let primary_ref = primary_reference.unwrap_or(0.0);
    let mut out_data = Vec::<NativeAstigmatismFieldData>::new();
    for (wl, axis, name, paraxial, mer_focus, sag_focus) in temp_rows {
        let mer = mer_focus.map(|v| v - primary_ref);
        let sag = sag_focus.map(|v| v - primary_ref);
        let ast = match (mer, sag) {
            (Some(m), Some(s)) => Some(m - s),
            _ => None,
        };

        out_data.push(NativeAstigmatismFieldData {
            wavelength: wl,
            field_angle: axis,
            field_name: name,
            paraxial_image_z: paraxial,
            meridional_deviation: mer,
            sagittal_deviation: sag,
            astigmatic_difference: ast,
        });
    }

    out_data.sort_by(|a, b| {
        let wl_cmp = a
            .wavelength
            .partial_cmp(&b.wavelength)
            .unwrap_or(std::cmp::Ordering::Equal);
        if wl_cmp != std::cmp::Ordering::Equal {
            return wl_cmp;
        }
        a.field_angle
            .partial_cmp(&b.field_angle)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut wl_values: Vec<f64> = wavelengths.iter().map(|w| w.wavelength_um).collect();
    wl_values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    wl_values.dedup_by(|a, b| (*a - *b).abs() < 1e-9);

    Ok(NativeAstigmatismResponse {
        backend: "native-rust-astigmatism".to_string(),
        target_surface: target_surface_index,
        stop_surface: stop_surface_index,
        primary_wavelength,
        primary_reference_z: Some(primary_ref),
        field_mode,
        is_angle_field,
        field_settings,
        wavelengths: wl_values,
        data: out_data,
        message: "Native Rust Astigmatism compute completed".to_string(),
    })
}

fn build_native_object_ray_series(
    rows: &[Value],
    surface_data: &[SurfaceInfo],
    object_rows: &[Value],
    target_surface_index: usize,
    traced_rays_req: usize,
    pattern: &str,
    ring_count: usize,
    source_rows: &[Value],
    wavelength_mode: &str,
) -> Vec<(String, String, bool, Vec<NativeSpotInputRay>, f64)> {
    let mut out = Vec::<(String, String, bool, Vec<NativeSpotInputRay>, f64)>::new();
    if object_rows.is_empty() || surface_data.is_empty() {
        return out;
    }

    let infinite_conjugate = is_infinite_conjugate_native(rows);
    let stop_radius = estimate_stop_radius_mm(rows);
    let entrance_radius = estimate_entrance_radius_mm(rows).clamp(0.01, 500.0);
    let sampling_radius = if stop_radius.is_finite() && stop_radius > 0.0 {
        stop_radius.min(entrance_radius).max(0.01)
    } else {
        entrance_radius
    };
    let stop_index = find_stop_surface_index_native(rows)
        .unwrap_or_else(|| rows.len().saturating_sub(1));
    let stop_surface = surface_data
        .get(stop_index)
        .copied()
        .unwrap_or(surface_data[surface_data.len().saturating_sub(1)]);
    let stop_origin = stop_surface.origin;
    let stop_rot = stop_surface.rot;
    let stop_plane_u = normalize3(stop_rot[0], stop_rot[3], stop_rot[6]);
    let stop_plane_v = normalize3(stop_rot[1], stop_rot[4], stop_rot[7]);
    let object_plane_z = surface_data
        .first()
        .map(|s| s.origin[2])
        .unwrap_or(0.0);
    let target_surface_origin = surface_data
        .get(target_surface_index)
        .map(|s| s.origin)
        .unwrap_or(stop_origin);
    let wavelengths = collect_spot_wavelengths(source_rows, wavelength_mode);
    if wavelengths.is_empty() {
        return out;
    }
    let mut previous_angle_origin_by_wl = vec![None::<[f64; 3]>; wavelengths.len()];
    let palette = ["#2563eb", "#dc2626", "#16a34a", "#7c3aed", "#ea580c", "#0891b2", "#4f46e5", "#0f766e"];
    let use_primary_only = wavelength_mode.eq_ignore_ascii_case("primary");

    for (obj_idx, obj) in object_rows.iter().enumerate() {
        let Some(o) = obj.as_object() else {
            continue;
        };
        let has_field_angle = is_angle_object_native(o, infinite_conjugate);

        let label = resolve_native_object_label(o, obj_idx);
        let object_color = palette[obj_idx % palette.len()].to_string();

        for (wl_idx, wl) in wavelengths.iter().enumerate() {
            let wavelength_um = wl.wavelength_um;
            let stop_packed = build_packed_meta(rows, surface_data, stop_index, wavelength_um).ok();
            let target_packed = build_packed_meta(rows, surface_data, target_surface_index, wavelength_um).ok();
            let (render_style_has_field_angle, rays, refined_emission_origin) = generate_ray_start_points_for_object_native(
                rows,
                o,
                &label,
                traced_rays_req,
                pattern,
                ring_count,
                wavelength_um,
                infinite_conjugate,
                object_plane_z,
                stop_index,
                target_surface_index,
                target_surface_origin,
                stop_origin,
                stop_plane_u,
                stop_plane_v,
                sampling_radius,
                stop_packed.as_ref(),
                target_packed.as_ref(),
                previous_angle_origin_by_wl[wl_idx],
            );

            if let Some(origin) = refined_emission_origin {
                previous_angle_origin_by_wl[wl_idx] = Some(origin);
            }

            if !rays.is_empty() {
                let series_label = if use_primary_only {
                    label.clone()
                } else {
                    format!("{} | {}", label, wl.label)
                };
                let series_color = if use_primary_only {
                    object_color.clone()
                } else {
                    wl.color.clone()
                };
                out.push((series_label, series_color, render_style_has_field_angle || has_field_angle, rays, wavelength_um));
            }
        }
    }

    out
}

fn resolve_native_object_label(obj: &Map<String, Value>, obj_idx: usize) -> String {
    obj.get("id")
        .and_then(value_to_string)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("Object {}", obj_idx + 1))
}

fn resolve_native_object_display_name(obj: &Map<String, Value>, fallback: &str) -> String {
    obj.get("name")
        .and_then(value_to_string)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            obj.get("comment")
                .and_then(value_to_string)
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| fallback.to_string())
}

fn extract_object_field_axis_native(obj: &Map<String, Value>, is_angle_field: bool) -> f64 {
    let candidates: [&str; 5] = if is_angle_field {
        ["yFieldAngle", "fieldAngle", "yAngle", "yHeightAngle", "y"]
    } else {
        ["yHeight", "y", "yHeightAngle", "yFieldAngle", "fieldAngle"]
    };

    for key in candidates {
        if let Some(value) = obj.get(key) {
            if let Some(parsed) = value_to_f64(value) {
                if parsed.is_finite() {
                    return parsed;
                }
            }
        }
    }
    0.0
}

fn extract_series_base_label(series_label: &str) -> String {
    series_label
        .split(" | ")
        .next()
        .unwrap_or(series_label)
        .trim()
        .to_string()
}

fn maybe_interpolate_angle_object_rows_for_astig(object_rows: &[Value], infinite_conjugate: bool) -> Vec<Value> {
    if !infinite_conjugate || object_rows.is_empty() {
        return object_rows.to_vec();
    }

    let has_height_rect = object_rows.iter().any(|row| {
        let Some(obj) = row.as_object() else {
            return false;
        };
        let pos = obj
            .get("position")
            .or_else(|| obj.get("fieldType"))
            .or_else(|| obj.get("type"))
            .and_then(value_to_string)
            .unwrap_or_default()
            .to_lowercase();
        pos.contains("height") || pos.contains("rect")
    });

    if has_height_rect {
        return object_rows.to_vec();
    }

    let mut max_y_angle = 0.0_f64;
    for row in object_rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let y = obj
            .get("yHeightAngle")
            .or_else(|| obj.get("yFieldAngle"))
            .or_else(|| obj.get("fieldAngle"))
            .or_else(|| obj.get("y"))
            .and_then(value_to_f64)
            .unwrap_or(0.0)
            .abs();
        if y.is_finite() {
            max_y_angle = max_y_angle.max(y);
        }
    }

    if !max_y_angle.is_finite() || max_y_angle <= 0.0 {
        return object_rows.to_vec();
    }

    let subdivisions = 50usize;
    let mut out = Vec::<Value>::with_capacity(subdivisions + 1);
    for i in 0..=subdivisions {
        let angle = max_y_angle * (i as f64) / (subdivisions as f64);
        out.push(serde_json::json!({
            "name": format!("Field{}", i),
            "position": "Angle",
            "xHeightAngle": 0.0,
            "yHeightAngle": angle
        }));
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NativeObjectPositionType {
    Point,
    Angle,
    Rectangle,
}

fn detect_object_position_type_native(obj: &serde_json::Map<String, Value>) -> NativeObjectPositionType {
    let raw_position = obj
        .get("position")
        .or_else(|| obj.get("object"))
        .or_else(|| obj.get("objectType"))
        .or_else(|| obj.get("type"))
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();

    if raw_position.contains("rectangle") || raw_position.contains("rect") {
        return NativeObjectPositionType::Rectangle;
    }
    if raw_position.contains("angle") {
        return NativeObjectPositionType::Angle;
    }
    if raw_position.contains("point") {
        return NativeObjectPositionType::Point;
    }

    let has_explicit_angle = get_object_numeric(obj, &["xAngle", "objectAngleX", "angleX"]).is_some()
        || get_object_numeric(obj, &["yAngle", "objectAngleY", "angle", "angleY"]).is_some();
    if has_explicit_angle {
        NativeObjectPositionType::Angle
    } else {
        NativeObjectPositionType::Point
    }
}

fn resolve_infinite_object_z_native(rows: &[Value], obj: &serde_json::Map<String, Value>, object_plane_z: f64) -> f64 {
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

fn generate_offsets_for_pattern_native(
    pattern: &str,
    traced_rays_req: usize,
    radius: f64,
    ring_count: usize,
) -> Vec<f64> {
    let safe_radius = if radius.is_finite() && radius > 1e-6 { radius } else { 1e-6 };
    if pattern.eq_ignore_ascii_case("grid") {
        generate_centered_grid_offsets_flat(traced_rays_req, safe_radius)
    } else if pattern.eq_ignore_ascii_case("cross") {
        generate_cross_offsets_flat(traced_rays_req, safe_radius)
    } else {
        generate_annular_offsets_flat(traced_rays_req, safe_radius, ring_count)
    }
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

fn generate_ray_start_points_for_object_native(
    rows: &[Value],
    obj: &serde_json::Map<String, Value>,
    _object_label: &str,
    traced_rays_req: usize,
    pattern: &str,
    ring_count: usize,
    wavelength_um: f64,
    infinite_conjugate: bool,
    object_plane_z: f64,
    stop_surface_index: usize,
    target_surface_index: usize,
    target_surface_origin: [f64; 3],
    stop_origin: [f64; 3],
    stop_plane_u: [f64; 3],
    stop_plane_v: [f64; 3],
    sampling_radius: f64,
    stop_packed: Option<&PackedMeta>,
    target_packed: Option<&PackedMeta>,
    previous_emission_origin_hint: Option<[f64; 3]>,
) -> (bool, Vec<NativeSpotInputRay>, Option<[f64; 3]>) {
    let mut rays = Vec::<NativeSpotInputRay>::new();
    if traced_rays_req == 0 {
        return (false, rays, None);
    }

    let position_type = detect_object_position_type_native(obj);
    let has_field_angle = matches!(position_type, NativeObjectPositionType::Angle);

    let object_z = if infinite_conjugate {
        resolve_infinite_object_z_native(rows, obj, object_plane_z)
    } else {
        object_plane_z
    };
    let stop_delta_z = stop_origin[2] - object_z;
    let can_aim_at_stop = stop_delta_z.is_finite() && stop_delta_z > 1e-6;

    let annular_inside_scale = if pattern.eq_ignore_ascii_case("annular") {
        let rc = ring_count.max(1) as f64;
        rc / (rc + 1.0)
    } else {
        1.0
    };
    let effective_radius = (sampling_radius * annular_inside_scale).clamp(1e-6, sampling_radius.max(1e-6));
    let offsets = generate_offsets_for_pattern_native(pattern, traced_rays_req, effective_radius, ring_count);
    let pair_count = offsets.len() / 2;
    if pair_count == 0 {
        return (has_field_angle, rays, None);
    }

    let mut refined_origin_to_return: Option<[f64; 3]> = None;

    match position_type {
        NativeObjectPositionType::Angle => {
            let angle_x = get_object_numeric(obj, &["xAngle", "objectAngleX", "xHeightAngle", "x", "angleX"]).unwrap_or(0.0);
            let angle_y = get_object_numeric(obj, &["yAngle", "objectAngleY", "yHeightAngle", "y", "angle", "angleY"]).unwrap_or(0.0);
            let chief_dir = build_direction_from_field_angles_native(angle_x, angle_y);
            let is_on_axis = angle_x.abs() < 1e-10 && angle_y.abs() < 1e-10;
            let origin_xy = if is_on_axis {
                [0.0, 0.0]
            } else if infinite_conjugate {
                [angle_x.to_radians().tan() * 1.0, angle_y.to_radians().tan() * 1.0]
            } else {
                optimize_angle_object_position_native(angle_x, angle_y, stop_origin, object_z)
            };
            let center_sag = compute_object_surface_sag_native(rows, origin_xy[0], origin_xy[1]);
            let mut emission_origin = [origin_xy[0], origin_xy[1], object_z + center_sag];
            if !is_on_axis {
                if let Some(hint) = previous_emission_origin_hint {
                    if hint[0].is_finite() && hint[1].is_finite() && hint[2].is_finite() {
                        emission_origin = hint;
                    }
                }
            }
            let (u_axis, v_axis) = build_perpendicular_basis_native(chief_dir);

            let should_search = infinite_conjugate && !is_on_axis && target_packed.is_some();

            if should_search {
                if let Some(tp) = target_packed {
                    if let Some(refined) = search_high_field_origin_for_target_native(
                        emission_origin,
                        chief_dir,
                        target_surface_index,
                        target_surface_origin,
                        tp,
                        sampling_radius,
                    ) {
                        emission_origin = refined;
                    } else {
                        if let Some((bundle_refined, _bundle_hits)) = search_high_field_origin_by_bundle_native(
                            emission_origin,
                            chief_dir,
                            u_axis,
                            v_axis,
                            target_surface_index,
                            tp,
                            sampling_radius,
                        ) {
                            emission_origin = bundle_refined;
                        }
                    }
                }
            }

            let build_candidate_rays = |pupil_scale: f64, allow_origin_solve: bool, candidate_ray_count: usize| -> Vec<NativeSpotInputRay> {
                let sample_count = candidate_ray_count.max(1);
                let candidate_radius = (effective_radius * pupil_scale).clamp(0.005, sampling_radius.max(0.005));
                let candidate_offsets = generate_offsets_for_pattern_native(pattern, sample_count, candidate_radius, ring_count);
                let candidate_pairs = candidate_offsets.len() / 2;
                let mut candidate_rays = Vec::<NativeSpotInputRay>::with_capacity(candidate_pairs.max(1));

                let solved_chief_origin = if allow_origin_solve && infinite_conjugate {
                    if let Some(packed) = stop_packed {
                        solve_ray_origin_to_stop_point_fast_native(
                            emission_origin,
                            chief_dir,
                            stop_origin,
                            stop_surface_index,
                            packed,
                        )
                    } else {
                        None
                    }
                } else {
                    None
                };
                let base_origin = solved_chief_origin.unwrap_or(emission_origin);

                for i in 0..candidate_pairs {
                    let b = i * 2;
                    let ou = candidate_offsets[b];
                    let ov = candidate_offsets[b + 1];

                    let start = [
                        base_origin[0] + ou * u_axis[0] + ov * v_axis[0],
                        base_origin[1] + ou * u_axis[1] + ov * v_axis[1],
                        base_origin[2] + ou * u_axis[2] + ov * v_axis[2],
                    ];

                    let stop_target = [
                        stop_origin[0] + ou * stop_plane_u[0] + ov * stop_plane_v[0],
                        stop_origin[1] + ou * stop_plane_u[1] + ov * stop_plane_v[1],
                        stop_origin[2] + ou * stop_plane_u[2] + ov * stop_plane_v[2],
                    ];

                    let dir = if !infinite_conjugate && can_aim_at_stop {
                        normalize3(stop_target[0] - start[0], stop_target[1] - start[1], stop_target[2] - start[2])
                    } else {
                        chief_dir
                    };

                    candidate_rays.push(NativeSpotInputRay {
                        start_p: NativeSpotVec3 { x: start[0], y: start[1], z: start[2] },
                        dir: NativeSpotVec3 { x: dir[0], y: dir[1], z: dir[2] },
                        wavelength_um: Some(wavelength_um),
                        is_chief: i == 0,
                    });
                }

                candidate_rays
            };

            if should_search {
                let pupil_scales = [1.0, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.085, 0.06, 0.04, 0.03, 0.02, 0.015, 0.01];
                let origin_solve_modes = [true, false];
                let mut best_rays = Vec::<NativeSpotInputRay>::new();
                let mut best_hits = 0usize;
                let probe_ray_count = traced_rays_req.clamp(25, 121);
                let mut best_mode: Option<(f64, bool)> = None;
                let mut _evaluated_modes = 0usize;

                for allow_origin_solve in origin_solve_modes {
                    for scale in pupil_scales {
                        _evaluated_modes += 1;
                        let candidate = build_candidate_rays(scale, allow_origin_solve, probe_ray_count);
                        if candidate.is_empty() {
                            continue;
                        }

                        let hits = if let Some(packed) = target_packed {
                            count_rays_hitting_surface_native(&candidate, target_surface_index, packed)
                        } else {
                            0
                        };

                        if hits > best_hits || best_rays.is_empty() {
                            best_hits = hits;
                            best_rays = candidate.clone();
                            best_mode = Some((scale, allow_origin_solve));
                        }
                    }
                }

                if let Some((selected_scale, selected_solve)) = best_mode {
                    rays = build_candidate_rays(selected_scale, selected_solve, traced_rays_req);
                } else {
                    rays = build_candidate_rays(1.0, infinite_conjugate && !is_on_axis, traced_rays_req);
                }
            } else {
                rays = build_candidate_rays(1.0, infinite_conjugate && !is_on_axis, traced_rays_req);
            }
            refined_origin_to_return = Some(emission_origin);
        }
        NativeObjectPositionType::Point | NativeObjectPositionType::Rectangle => {
            let object_x = get_object_numeric(obj, &["xHeightAngle", "x", "xHeight", "objectX"]).unwrap_or(0.0);
            let object_y = get_object_numeric(obj, &["yHeightAngle", "y", "yHeight", "objectY"]).unwrap_or(0.0);
            let center_sag = compute_object_surface_sag_native(rows, object_x, object_y);
            let center = [object_x, object_y, object_z + center_sag];
            let chief_dir = if can_aim_at_stop {
                normalize3(stop_origin[0] - center[0], stop_origin[1] - center[1], stop_origin[2] - center[2])
            } else {
                [0.0, 0.0, 1.0]
            };
            let (u_axis, v_axis) = build_perpendicular_basis_native(chief_dir);

            for i in 0..pair_count {
                let b = i * 2;
                let ou = offsets[b];
                let ov = offsets[b + 1];

                let start = if infinite_conjugate {
                    [
                        center[0] + ou * u_axis[0] + ov * v_axis[0],
                        center[1] + ou * u_axis[1] + ov * v_axis[1],
                        center[2] + ou * u_axis[2] + ov * v_axis[2],
                    ]
                } else {
                    center
                };

                let dir = if !infinite_conjugate && can_aim_at_stop {
                    let target = [
                        stop_origin[0] + ou * stop_plane_u[0] + ov * stop_plane_v[0],
                        stop_origin[1] + ou * stop_plane_u[1] + ov * stop_plane_v[1],
                        stop_origin[2] + ou * stop_plane_u[2] + ov * stop_plane_v[2],
                    ];
                    normalize3(target[0] - start[0], target[1] - start[1], target[2] - start[2])
                } else {
                    chief_dir
                };

                rays.push(NativeSpotInputRay {
                    start_p: NativeSpotVec3 { x: start[0], y: start[1], z: start[2] },
                    dir: NativeSpotVec3 { x: dir[0], y: dir[1], z: dir[2] },
                    wavelength_um: Some(wavelength_um),
                    is_chief: i == 0,
                });
            }
        }
    }

    (has_field_angle, rays, refined_origin_to_return)
}

fn find_stop_surface_index_native(rows: &[Value]) -> Option<usize> {
    let normalize = |s: String| s.trim().to_lowercase();
    let compact = |s: &str| {
        s.chars()
            .filter(|c| *c != ' ' && *c != '_' && *c != '-')
            .collect::<String>()
            .to_lowercase()
    };

    for (i, surface) in rows.iter().enumerate() {
        if is_coord_trans_row(surface) {
            continue;
        }
        let stop_flag = get_field(surface, "stop")
            .or_else(|| get_field(surface, "Stop"))
            .or_else(|| get_field(surface, "isStop"));
        if let Some(flag) = stop_flag {
            let raw = value_to_string(flag).unwrap_or_default();
            let n = normalize(raw.clone());
            if n == "yes" || n == "true" || n == "1" {
                return Some(i);
            }
            if let Some(v) = value_to_f64(flag) {
                if v.is_finite() && v.abs() > 0.5 {
                    return Some(i);
                }
            }
        }
    }

    for (i, surface) in rows.iter().enumerate() {
        if is_coord_trans_row(surface) {
            continue;
        }
        let object_raw = get_field(surface, "object")
            .or_else(|| get_field(surface, "object type"))
            .or_else(|| get_field(surface, "objectType"))
            .and_then(value_to_string)
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let surf_type_raw = get_field(surface, "surfType")
            .or_else(|| get_field(surface, "surfaceType"))
            .or_else(|| get_field(surface, "type"))
            .and_then(value_to_string)
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let comment_raw = get_field(surface, "comment")
            .and_then(value_to_string)
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        let object_compact = compact(&object_raw);
        let surf_compact = compact(&surf_type_raw);
        if object_raw == "sto"
            || object_raw == "stop"
            || object_raw.contains("stop")
            || object_compact == "sto"
            || object_compact == "stop"
            || surf_type_raw == "sto"
            || surf_type_raw == "stop"
            || surf_type_raw.contains("stop")
            || surf_compact == "sto"
            || surf_compact == "stop"
            || comment_raw == "stop"
            || comment_raw == "aperture stop"
            || comment_raw.contains("stop")
        {
            return Some(i);
        }
    }

    if rows.is_empty() {
        None
    } else {
        Some(rows.len() / 2)
    }
}

fn trace_hit_xy_with_packed(ray: [f64; 6], stop_surface_index: usize, packed: &PackedMeta) -> Option<[f64; 2]> {
    let hit = trace_single_ray_hit_point_with_meta_core(
        &ray,
        stop_surface_index,
        1.0,
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

fn search_high_field_origin_for_target_native(
    initial_origin: [f64; 3],
    dir_vector: [f64; 3],
    target_surface_index: usize,
    target_surface_origin: [f64; 3],
    packed: &PackedMeta,
    sampling_radius: f64,
) -> Option<[f64; 3]> {
    let base_dir = normalize3(dir_vector[0], dir_vector[1], dir_vector[2]);
    if !base_dir[0].is_finite() || !base_dir[1].is_finite() || !base_dir[2].is_finite() {
        return None;
    }

    let base_span = sampling_radius.max(0.5);
    let spans = [1.0_f64, 2.0, 4.0, 8.0, 16.0, 32.0];
    let grid = [-1.0_f64, -0.5, 0.0, 0.5, 1.0];

    let mut best_origin: Option<[f64; 3]> = None;
    let mut best_score = f64::INFINITY;

    for span_mul in spans {
        let span = base_span * span_mul;
        for gx in grid {
            for gy in grid {
                let cand = [
                    initial_origin[0] + gx * span,
                    initial_origin[1] + gy * span,
                    initial_origin[2],
                ];

                let ray = [cand[0], cand[1], cand[2], base_dir[0], base_dir[1], base_dir[2]];
                let Some(hit) = trace_hit_xy_with_packed(ray, target_surface_index, packed) else {
                    continue;
                };

                let dx = hit[0] - target_surface_origin[0];
                let dy = hit[1] - target_surface_origin[1];
                let score = (dx * dx + dy * dy).sqrt();
                if score < best_score {
                    best_score = score;
                    best_origin = Some(cand);
                }
            }
        }
        if best_origin.is_some() {
            break;
        }
    }

    best_origin
}

fn search_high_field_origin_by_bundle_native(
    initial_origin: [f64; 3],
    dir_vector: [f64; 3],
    u_axis: [f64; 3],
    v_axis: [f64; 3],
    target_surface_index: usize,
    packed: &PackedMeta,
    sampling_radius: f64,
) -> Option<([f64; 3], usize)> {
    let base_dir = normalize3(dir_vector[0], dir_vector[1], dir_vector[2]);
    if !base_dir[0].is_finite() || !base_dir[1].is_finite() || !base_dir[2].is_finite() {
        return None;
    }

    let base_span = sampling_radius.max(0.5);
    let spans = [1.0_f64, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 256.0, 512.0, 1024.0, 2048.0];
    let grid = [-1.0_f64, -0.5, 0.0, 0.5, 1.0];
    let probe_r = (sampling_radius * 0.2).clamp(0.2, 5.0);
    let probes = [
        (0.0_f64, 0.0_f64),
        (probe_r, 0.0),
        (-probe_r, 0.0),
        (0.0, probe_r),
        (0.0, -probe_r),
        (0.707 * probe_r, 0.707 * probe_r),
        (-0.707 * probe_r, 0.707 * probe_r),
        (0.707 * probe_r, -0.707 * probe_r),
        (-0.707 * probe_r, -0.707 * probe_r),
    ];

    let mut best_origin: Option<[f64; 3]> = None;
    let mut best_hits = 0usize;

    for span_mul in spans {
        let span = base_span * span_mul;
        for gx in grid {
            for gy in grid {
                let cand = [
                    initial_origin[0] + gx * span * u_axis[0] + gy * span * v_axis[0],
                    initial_origin[1] + gx * span * u_axis[1] + gy * span * v_axis[1],
                    initial_origin[2] + gx * span * u_axis[2] + gy * span * v_axis[2],
                ];

                let mut hits = 0usize;
                for (pu, pv) in probes {
                    let sx = cand[0] + pu * u_axis[0] + pv * v_axis[0];
                    let sy = cand[1] + pu * u_axis[1] + pv * v_axis[1];
                    let sz = cand[2] + pu * u_axis[2] + pv * v_axis[2];
                    let ray = [sx, sy, sz, base_dir[0], base_dir[1], base_dir[2]];
                    if trace_hit_xy_with_packed(ray, target_surface_index, packed).is_some() {
                        hits += 1;
                    }
                }

                if hits > best_hits {
                    best_hits = hits;
                    best_origin = Some(cand);
                }
            }
        }
        if best_hits >= 3 {
            break;
        }
    }

    best_origin.map(|o| (o, best_hits))
}

fn solve_ray_origin_to_stop_point_fast_native(
    initial_origin: [f64; 3],
    dir_vector: [f64; 3],
    stop_target: [f64; 3],
    stop_surface_index: usize,
    packed: &PackedMeta,
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
            packed,
        );
        let hit_y = trace_hit_xy_with_packed(
            [origin[0], origin[1] + eps, origin[2], base_dir[0], base_dir[1], base_dir[2]],
            stop_surface_index,
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
            let gain = 0.2;
            origin = [origin[0] - gain * ex, origin[1] - gain * ey, origin[2]];
            continue;
        }

        let det = j11 * j22 - j12 * j21;
        if !det.is_finite() || det.abs() < 1e-14 {
            let gain = 0.2;
            origin = [origin[0] - gain * ex, origin[1] - gain * ey, origin[2]];
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

fn count_rays_hitting_surface_native(
    rays: &[NativeSpotInputRay],
    target_surface_index: usize,
    packed: &PackedMeta,
) -> usize {
    let mut hits = 0usize;
    for r in rays {
        let start_dir = [
            r.start_p.x,
            r.start_p.y,
            r.start_p.z,
            r.dir.x,
            r.dir.y,
            r.dir.z,
        ];
        let hit = trace_single_ray_hit_point_with_meta_core(
            &start_dir,
            target_surface_index,
            1.0,
            &packed.row_meta,
            &packed.row_params,
            &packed.row_origins,
            &packed.row_inv_rots,
            &packed.row_rots,
            packed.row_count,
        );
        if (hit[0] - 1.0).abs() <= f64::EPSILON {
            hits += 1;
        }
    }
    hits
}

fn is_angle_object_native(obj: &serde_json::Map<String, Value>, infinite_conjugate: bool) -> bool {
    if infinite_conjugate {
        return true;
    }

    let raw_position = obj
        .get("position")
        .or_else(|| obj.get("object"))
        .or_else(|| obj.get("objectType"))
        .or_else(|| obj.get("type"))
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();

    let is_rectangle_like = raw_position.contains("rectangle")
        || raw_position.contains("rect")
        || raw_position.contains("height");
    let is_angle_like = raw_position.contains("angle") || raw_position == "point";

    if is_angle_like && !is_rectangle_like {
        return true;
    }

    let has_explicit_angle = get_object_numeric(obj, &["xAngle", "objectAngleX", "angleX"]).is_some()
        || get_object_numeric(obj, &["yAngle", "objectAngleY", "angle", "angleY"]).is_some();
    let has_height_angle = get_object_numeric(obj, &["xHeightAngle", "yHeightAngle"]).is_some();
    has_explicit_angle && has_height_angle
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

fn get_object_numeric(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<f64> {
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

fn parse_field_axis_from_label(label: &str) -> Option<f64> {
    let trimmed = label.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut token = String::new();
    let mut started = false;
    for ch in trimmed.chars() {
        let valid = ch.is_ascii_digit() || ch == '+' || ch == '-' || ch == '.';
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

#[derive(Clone, Copy)]
struct SurfaceInfo {
    origin: [f64; 3],
    rot: [f64; 9],
    inv_rot: [f64; 9],
}

struct PackedMeta {
    row_meta: Vec<i32>,
    row_params: Vec<f64>,
    row_origins: Vec<f64>,
    row_inv_rots: Vec<f64>,
    row_rots: Vec<f64>,
    row_count: usize,
}

#[derive(Clone)]
struct SpotWavelength {
    label: String,
    color: String,
    wavelength_um: f64,
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

fn is_coord_trans_row(row: &Value) -> bool {
    let s = norm_string(
        row,
        &[
            "surfType",
            "type",
            "surfaceType",
            "surface_type",
            "object type",
            "object",
            "Object",
            "blockType",
            "block_type",
            "comment",
        ],
    );
    let c = compact(&s);
    c == "ct"
        || c == "coordtrans"
        || c == "coordinatebreak"
        || s.contains("coord trans")
        || s.contains("coordinate break")
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

fn has_explicit_coord_params(row: &Value) -> bool {
    ["decenterX", "decenterY", "tiltX", "tiltY", "tiltZ"]
        .iter()
        .any(|k| get_field_from_params(row, k).is_some())
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
    let order_raw = get_field(row, "order")
        .or_else(|| get_field(row, "coef1"))
        .and_then(value_to_string)
        .and_then(|s| s.trim().parse::<i32>().ok())
        .unwrap_or(1);
    let order = if order_raw == 0 || order_raw == 1 { order_raw } else { 1 };

    (decenter_x, decenter_y, decenter_z, tilt_x, tilt_y, tilt_z, order)
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
    let tilt_x = get_field(row, "rindex").and_then(value_to_f64).unwrap_or(0.0);
    let tilt_y = get_field(row, "abbe").and_then(value_to_f64).unwrap_or(0.0);
    let tilt_z = get_field(row, "conic").and_then(value_to_f64).unwrap_or(0.0);
    let order = get_field(row, "order")
        .or_else(|| get_field(row, "coef1"))
        .and_then(value_to_string)
        .and_then(|s| s.trim().parse::<i32>().ok())
        .filter(|v| *v == 0 || *v == 1)
        .unwrap_or(1);

    if let Value::Object(map) = &mut out {
        map.insert("decenterX".to_string(), Value::from(decenter_x));
        map.insert("decenterY".to_string(), Value::from(decenter_y));
        map.insert("decenterZ".to_string(), Value::from(0.0));
        map.insert("tiltX".to_string(), Value::from(tilt_x));
        map.insert("tiltY".to_string(), Value::from(tilt_y));
        map.insert("tiltZ".to_string(), Value::from(tilt_z));
        map.insert("order".to_string(), Value::from(order));
    }
    out
}

fn get_safe_thickness(row: &Value) -> f64 {
    if is_coord_trans_row(row) {
        if let Some(gap) = get_field(row, "__cooptGapThickness").and_then(value_to_string) {
            let s = gap.trim();
            if s.eq_ignore_ascii_case("inf") || s.eq_ignore_ascii_case("infinity") {
                return f64::INFINITY;
            }
            if let Ok(v) = s.parse::<f64>() {
                return if v.is_finite() { v } else { 0.0 };
            }
        }
        return 0.0;
    }

    if let Some(v) = get_field(row, "thickness") {
        if let Some(s) = value_to_string(v) {
            let t = s.trim();
            if t.eq_ignore_ascii_case("inf") || t.eq_ignore_ascii_case("infinity") {
                return f64::INFINITY;
            }
            if let Ok(n) = t.parse::<f64>() {
                return if n.is_finite() { n } else { 0.0 };
            }
        }
        return value_to_f64(v).filter(|n| n.is_finite()).unwrap_or(0.0);
    }

    0.0
}

fn identity3() -> [f64; 9] {
    [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
}

fn mul_mat3(a: &[f64; 9], b: &[f64; 9]) -> [f64; 9] {
    let mut out = [0.0_f64; 9];
    for i in 0..3 {
        for j in 0..3 {
            out[i * 3 + j] =
                a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
        }
    }
    out
}

fn mul_mat3_vec3(m: &[f64; 9], v: [f64; 3]) -> [f64; 3] {
    [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ]
}

fn transpose3(m: &[f64; 9]) -> [f64; 9] {
    [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

fn add3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale3(v: [f64; 3], s: f64) -> [f64; 3] {
    [v[0] * s, v[1] * s, v[2] * s]
}

fn create_rotation_matrix3(tilt_x: f64, tilt_y: f64, tilt_z: f64, order: i32) -> [f64; 9] {
    let rx = tilt_x.to_radians();
    let ry = tilt_y.to_radians();
    let rz = tilt_z.to_radians();

    let rxm = [1.0, 0.0, 0.0, 0.0, rx.cos(), -rx.sin(), 0.0, rx.sin(), rx.cos()];
    let rym = [ry.cos(), 0.0, ry.sin(), 0.0, 1.0, 0.0, -ry.sin(), 0.0, ry.cos()];
    let rzm = [rz.cos(), -rz.sin(), 0.0, rz.sin(), rz.cos(), 0.0, 0.0, 0.0, 1.0];

    if order == 0 {
        mul_mat3(&mul_mat3(&rxm, &rym), &rzm)
    } else {
        mul_mat3(&mul_mat3(&rzm, &rym), &rxm)
    }
}

fn calculate_surface_data(rows: &[Value]) -> Vec<SurfaceInfo> {
    let mut out = Vec::<SurfaceInfo>::with_capacity(rows.len());
    let mut current_origin = [0.0_f64, 0.0_f64, 0.0_f64];
    let mut current_rot = identity3();
    let ex = [1.0_f64, 0.0_f64, 0.0_f64];
    let ey = [0.0_f64, 1.0_f64, 0.0_f64];
    let ez = [0.0_f64, 0.0_f64, 1.0_f64];

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
            let single_rot = create_rotation_matrix3(tx, ty, tz, order);
            let new_rot = mul_mat3(&single_rot, &current_rot);

            let o = if order == 0 {
                let tz_term = scale3(mul_mat3_vec3(&prev_rot, ez), thickness);
                let dx_term = scale3(mul_mat3_vec3(&prev_rot, ex), dx);
                let dy_term = scale3(mul_mat3_vec3(&prev_rot, ey), dy);
                let dz_term = scale3(mul_mat3_vec3(&prev_rot, ez), dz);
                add3(add3(add3(add3(current_origin, tz_term), dx_term), dy_term), dz_term)
            } else {
                let tz_term = scale3(mul_mat3_vec3(&prev_rot, ez), thickness);
                let dx_term = scale3(mul_mat3_vec3(&new_rot, ex), dx);
                let dy_term = scale3(mul_mat3_vec3(&new_rot, ey), dy);
                let dz_term = scale3(mul_mat3_vec3(&new_rot, ez), dz);
                add3(add3(add3(add3(current_origin, tz_term), dx_term), dy_term), dz_term)
            };
            (o, new_rot)
        } else {
            let mut thickness = previous.map(get_safe_thickness).unwrap_or(0.0);
            if !thickness.is_finite() {
                thickness = 0.0;
            }
            let tz_term = scale3(mul_mat3_vec3(&current_rot, ez), thickness);
            (add3(current_origin, tz_term), current_rot)
        };

        let inv = transpose3(&surface_rot);
        out.push(SurfaceInfo {
            origin: surface_origin,
            rot: surface_rot,
            inv_rot: inv,
        });
        current_origin = surface_origin;
        current_rot = surface_rot;
    }

    out
}

fn estimate_entrance_radius_mm(rows: &[Value]) -> f64 {
    for row in rows {
        if is_object_row(row) || is_gap_row(row) || is_coord_trans_row(row) {
            continue;
        }
        let semidia_raw = get_field(row, "__cooptActualSemidia")
            .or_else(|| get_field(row, "semidia"))
            .and_then(value_to_f64);
        if let Some(sd) = semidia_raw {
            if sd.is_finite() && sd > 0.0 {
                return sd;
            }
        }
        let ap = get_field(row, "aperture").and_then(value_to_f64).unwrap_or(0.0);
        if ap.is_finite() && ap > 0.0 {
            return ap * 0.5;
        }
    }
    1.0
}

fn estimate_stop_radius_mm(rows: &[Value]) -> f64 {
    let stop_index = find_stop_surface_index_native(rows);
    let Some(idx) = stop_index else {
        return f64::NAN;
    };
    let Some(row) = rows.get(idx) else {
        return f64::NAN;
    };

    let semidia = get_field(row, "__cooptActualSemidia")
        .or_else(|| get_field(row, "semidia"))
        .or_else(|| get_field(row, "Semi Diameter"))
        .and_then(value_to_f64)
        .map(f64::abs)
        .filter(|v| v.is_finite() && *v > 0.0);
    if let Some(sd) = semidia {
        return sd;
    }

    let aperture = get_field(row, "aperture")
        .or_else(|| get_field(row, "Aperture"))
        .and_then(value_to_f64)
        .map(f64::abs)
        .filter(|v| v.is_finite() && *v > 0.0);
    if let Some(ap) = aperture {
        return ap * 0.5;
    }

    f64::NAN
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

fn build_packed_meta(
    rows: &[Value],
    surface_data: &[SurfaceInfo],
    target_surface_index: usize,
    wavelength_um: f64,
) -> Result<PackedMeta, String> {
    if rows.len() != surface_data.len() {
        return Err("build_packed_meta: rows/surface_data size mismatch".to_string());
    }
    if target_surface_index >= rows.len() {
        return Err("build_packed_meta: target surface out of range".to_string());
    }

    let row_count = rows.len();
    let mut row_meta = vec![0_i32; row_count * 4];
    let mut row_params = vec![0.0_f64; row_count * 24];
    let mut row_origins = vec![0.0_f64; row_count * 3];
    let mut row_rots = vec![0.0_f64; row_count * 9];
    let mut row_inv_rots = vec![0.0_f64; row_count * 9];

    for i in 0..row_count {
        let row = &rows[i];
        let s_info = &surface_data[i];

        let mut kind = 0;
        if is_object_row(row) {
            kind = 1;
        } else if is_gap_row(row) {
            kind = 2;
        } else if is_coord_trans_row(row) {
            kind = 3;
        }

        let surf_type = norm_string(row, &["surfType", "type"]);
        let radius = get_field(row, "radius").and_then(value_to_f64).unwrap_or(f64::NAN);
        let is_plane_surface = !radius.is_finite() || radius == 0.0;
        let is_toric_surface = compact(&surf_type) == "toric";
        let is_odd_asphere = !is_toric_surface && surf_type.contains("odd");
        if is_toric_surface {
            return Err("build_packed_meta: toric surface is not supported in native path".to_string());
        }

        let is_mirror = get_field(row, "material")
            .and_then(value_to_string)
            .map(|s| s.trim().eq_ignore_ascii_case("MIRROR"))
            .unwrap_or(false);

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

        let mut aperture_limit = f64::INFINITY;
        let aperture_num = get_field(row, "aperture").and_then(value_to_f64).unwrap_or(f64::NAN);
        if aperture_num.is_finite() && aperture_num > 0.0 {
            aperture_limit = aperture_num * 0.5;
        }

        let semi_dia_value = get_field(row, "__cooptActualSemidia")
            .or_else(|| get_field(row, "semidia"));
        let semi_dia = match semi_dia_value {
            Some(Value::String(s)) if s.trim().eq_ignore_ascii_case("auto") || s.trim().is_empty() => f64::INFINITY,
            Some(v) => {
                let n = value_to_f64(v).unwrap_or(f64::NAN);
                if n.is_finite() && n > 0.0 { n } else { f64::INFINITY }
            }
            None => f64::INFINITY,
        };
        if semi_dia.is_finite() {
            aperture_limit = aperture_limit.min(semi_dia);
        }
        if i == target_surface_index || is_image_surface {
            aperture_limit = f64::INFINITY;
        }

        let mut flags = 0_i32;
        if is_mirror {
            flags |= 1;
        }
        if is_plane_surface {
            flags |= 2;
        }
        if is_toric_surface {
            flags |= 4;
        }
        if is_image_surface {
            flags |= 8;
        }
        if rect_half_w.is_finite() && rect_half_h.is_finite() {
            flags |= 16;
        }
        if is_odd_asphere {
            flags |= 32;
        }

        let mut n2 = 0.0;
        if kind == 0 {
            if !is_mirror {
                let n = get_correct_refractive_index(row, wavelength_um);
                n2 = if n.is_finite() && n > 0.0 { n } else { 0.0 };
            }
        } else if kind == 2 {
            let material = get_field(row, "material").and_then(value_to_string).unwrap_or_default();
            let n = parse_refractive_index_from_material(&material);
            n2 = if n > 0.0 { n } else { 0.0 };
        } else if kind == 3 {
            let material = get_field(row, "__cooptGapMaterial")
                .and_then(value_to_string)
                .unwrap_or_default();
            let n = parse_refractive_index_from_material(&material);
            n2 = if n > 0.0 { n } else { 0.0 };
        }

        let m = i * 4;
        row_meta[m] = kind;
        row_meta[m + 1] = flags;

        let p = i * 24;
        row_params[p] = get_field(row, "radius").and_then(value_to_f64).unwrap_or(f64::NAN);
        row_params[p + 1] = get_field(row, "conic").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 2] = get_field(row, "coef1").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 3] = get_field(row, "coef2").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 4] = get_field(row, "coef3").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 5] = get_field(row, "coef4").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 6] = get_field(row, "coef5").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 7] = get_field(row, "coef6").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 8] = get_field(row, "coef7").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 9] = get_field(row, "coef8").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 10] = get_field(row, "coef9").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 11] = get_field(row, "coef10").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 12] = semi_dia;
        row_params[p + 13] = get_field(row, "radiusX").and_then(value_to_f64).unwrap_or(f64::NAN);
        row_params[p + 14] = get_field(row, "radiusY").and_then(value_to_f64).unwrap_or(f64::NAN);
        row_params[p + 15] = get_field(row, "axis").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 16] = get_field(row, "thickness").and_then(value_to_f64).unwrap_or(0.0);
        row_params[p + 17] = aperture_limit;
        row_params[p + 18] = rect_half_w;
        row_params[p + 19] = rect_half_h;
        row_params[p + 20] = n2;

        let o = i * 3;
        row_origins[o] = s_info.origin[0];
        row_origins[o + 1] = s_info.origin[1];
        row_origins[o + 2] = s_info.origin[2];

        let r = i * 9;
        row_rots[r..(r + 9)].copy_from_slice(&s_info.rot);
        row_inv_rots[r..(r + 9)].copy_from_slice(&s_info.inv_rot);
    }

    Ok(PackedMeta {
        row_meta,
        row_params,
        row_origins,
        row_inv_rots,
        row_rots,
        row_count,
    })
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
        let mut r_power = r2 * r;
        for coef in coefs {
            if *coef != 0.0 {
                asphere += coef * r_power;
            }
            r_power *= r2;
        }
    } else {
        let mut r_power = r2 * r2;
        for coef in coefs {
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
    let term = (1.0 + conic) * r2 / (radius * radius);

    let mut dzdr = 0.0;
    if term < 1.0 {
        let sqrt_term = (1.0 - term).sqrt();
        let denominator = radius * (1.0 + sqrt_term);
        let d_numerator = 2.0 * r;
        let d_denominator = -radius * (1.0 + conic) * r / (radius * radius * sqrt_term);
        dzdr = (d_numerator * denominator - r2 * d_denominator) / (denominator * denominator);
    }

    if mode_odd {
        let mut r_power = r2;
        for (i, coef) in coefs.iter().enumerate() {
            if *coef != 0.0 {
                let power = 2.0 * (i as f64 + 1.0) + 1.0;
                dzdr += coef * power * r_power;
            }
            r_power *= r2;
        }
    } else {
        let mut r_power = r2 * r;
        for (i, coef) in coefs.iter().enumerate() {
            if *coef != 0.0 {
                let power = 2.0 * (i as f64 + 2.0);
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

fn intersect_aspheric_internal(ray: &[f64], params: &[f64], mode_odd: bool, max_iter: usize, tol: f64) -> f64 {
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

    let semidia_raw = params.first().copied().unwrap_or(0.0);
    let radius = params.get(1).copied().unwrap_or(0.0);
    let conic = params.get(2).copied().unwrap_or(0.0);
    let mut coefs = [0.0_f64; 10];
    for (i, c) in coefs.iter_mut().enumerate() {
        *c = params.get(3 + i).copied().unwrap_or(0.0);
    }
    let semidia = if semidia_raw.is_finite() && semidia_raw > 0.0 { semidia_raw } else { f64::INFINITY };

    let mut guesses = Vec::<f64>::new();
    if radius.is_finite() && radius != 0.0 {
        let cz = radius;
        let a = dx * dx + dy * dy + dz * dz;
        let b = 2.0 * (ox * dx + oy * dy + (oz - cz) * dz);
        let c = ox * ox + oy * oy + (oz - cz) * (oz - cz) - radius * radius;
        let d = b * b - 4.0 * a * c;
        if d >= 0.0 {
            let sd = d.sqrt();
            let t1 = (-b - sd) / (2.0 * a);
            let t2 = (-b + sd) / (2.0 * a);
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
        guesses.extend_from_slice(&[0.01, 1.0, 10.0]);
    } else if guesses.len() == 1 {
        guesses.push(1.0);
    }

    guesses.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    guesses.dedup_by(|a, b| (*a - *b).abs() < 1e-9);

    let tol_local = if tol.is_finite() && tol > 0.0 { tol } else { 1e-7 };
    let iter_max = max_iter.max(1);

    for guess in guesses {
        let mut t = guess;
        let mut last_valid_t = f64::NAN;
        let mut last_valid_f = f64::INFINITY;

        for _ in 0..iter_max {
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
            if f.abs() < tol_local {
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

            if t < -10_000.0 || t > 10_000.0 {
                break;
            }
        }

        let px = ox + dx * t;
        let py = oy + dy * t;
        let pz = oz + dz * t;
        let r = (px * px + py * py).sqrt();
        let sag = aspheric_sag(r, radius, conic, &coefs, mode_odd);
        let f = pz - sag;
        if f.abs() < tol_local * 10.0 && r <= semidia * 1.1 {
            return t;
        }
        if last_valid_t.is_finite() && last_valid_f.abs() < tol_local * 50.0 {
            return last_valid_t;
        }
    }

    f64::NAN
}

fn surface_normal_aspheric_local(hx: f64, hy: f64, radius: f64, conic: f64, coefs: &[f64; 10], mode_odd: bool) -> [f64; 3] {
    let r = (hx * hx + hy * hy).sqrt();
    if r < EPS_R {
        return [0.0, 0.0, 1.0];
    }
    let dzdr = aspheric_sag_derivative(r, radius, conic, coefs, mode_odd);
    let dzdx = dzdr * (hx / r);
    let dzdy = dzdr * (hy / r);
    normalize3(-dzdx, -dzdy, 1.0)
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

    let d0 = normalize3(dx, dy, dz);
    dx = d0[0];
    dy = d0[1];
    dz = d0[2];

    let mut n_cur = if n_start.is_finite() && n_start > 0.0 { n_start } else { 1.0 };
    let mut opl = 0.0_f64;

    for i in 0..=target_surface_index {
        let m = i * 4;
        let kind = row_meta[m];
        let flags = row_meta[m + 1];
        let is_mirror = (flags & 1) != 0;
        let is_plane = (flags & 2) != 0;
        let is_toric = (flags & 4) != 0;
        let is_rect_ap = (flags & 16) != 0;
        let is_odd_asphere = (flags & 32) != 0;

        let p = i * 24;
        let radius = row_params[p];
        let conic = row_params[p + 1];
        let mut coefs = [0.0_f64; 10];
        for k in 0..10 {
            coefs[k] = row_params[p + 2 + k];
        }
        let semidia = row_params[p + 12];
        let thickness = row_params[p + 16];
        let aperture_limit = row_params[p + 17];
        let rect_half_w = row_params[p + 18];
        let rect_half_h = row_params[p + 19];
        let n2 = row_params[p + 20];

        if kind == 1 || kind == 2 {
            if thickness.is_finite() && thickness != 0.0 {
                px += dx * thickness;
                py += dy * thickness;
                pz += dz * thickness;
                opl += thickness.abs() * 1000.0 * n_cur;
            }
            continue;
        }
        if kind == 3 {
            if n2.is_finite() && n2 > 0.0 {
                n_cur = n2;
            }
            continue;
        }

        let o = i * 3;
        let ox = row_origins[o];
        let oy = row_origins[o + 1];
        let oz = row_origins[o + 2];

        let ir = i * 9;
        let im00 = row_inv_rots[ir];
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
            let mut ip = [0.0_f64; 13];
            ip[0] = semidia;
            ip[1] = radius;
            ip[2] = conic;
            ip[3..(3 + 10)].copy_from_slice(&coefs);
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
        let rm00 = row_rots[rr];
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

        let is_target_surface = i == target_surface_index;

        let mut nloc = if is_plane {
            if ldz > 0.0 { [0.0, 0.0, -1.0] } else { [0.0, 0.0, 1.0] }
        } else {
            surface_normal_aspheric_local(hx, hy, radius, conic, &coefs, is_odd_asphere)
        };

        let d_dot_n = ldx * nloc[0] + ldy * nloc[1] + ldz * nloc[2];
        if d_dot_n > 0.0 {
            nloc = [-nloc[0], -nloc[1], -nloc[2]];
        }

        let (ndx, ndy, ndz, n_next) = if is_mirror {
            let dotn = ldx * nloc[0] + ldy * nloc[1] + ldz * nloc[2];
            let nn = normalize3(
                ldx - 2.0 * dotn * nloc[0],
                ldy - 2.0 * dotn * nloc[1],
                ldz - 2.0 * dotn * nloc[2],
            );
            (nn[0], nn[1], nn[2], n_cur)
        } else if n2.is_finite() && n2 > 0.0 && (n_cur - n2).abs() > EPS_R {
            let cos_i = -(nloc[0] * ldx + nloc[1] * ldy + nloc[2] * ldz);
            let eta = n_cur / n2;
            let k = 1.0 - eta * eta * (1.0 - cos_i * cos_i);
            if k < 0.0 {
                if is_target_surface {
                    let gdx_inc = rm00 * ldx + rm01 * ldy + rm02 * ldz;
                    let gdy_inc = rm10 * ldx + rm11 * ldy + rm12 * ldz;
                    let gdz_inc = rm20 * ldx + rm21 * ldy + rm22 * ldz;
                    let inc = normalize3(gdx_inc, gdy_inc, gdz_inc);
                    out[0] = 1.0;
                    out[1] = opl;
                    out[2] = ghx;
                    out[3] = ghy;
                    out[4] = ghz;
                    out[5] = inc[0];
                    out[6] = inc[1];
                    out[7] = inc[2];
                    return out;
                }
                out[0] = 5.0;
                out[1] = opl;
                return out;
            }
            let sqrt_k = k.sqrt();
            let nn = normalize3(
                eta * ldx + (eta * cos_i - sqrt_k) * nloc[0],
                eta * ldy + (eta * cos_i - sqrt_k) * nloc[1],
                eta * ldz + (eta * cos_i - sqrt_k) * nloc[2],
            );
            (nn[0], nn[1], nn[2], n2)
        } else {
            (ldx, ldy, ldz, n_cur)
        };

        let gdx = rm00 * ndx + rm01 * ndy + rm02 * ndz;
        let gdy = rm10 * ndx + rm11 * ndy + rm12 * ndz;
        let gdz = rm20 * ndx + rm21 * ndy + rm22 * ndz;
        let gnorm = normalize3(gdx, gdy, gdz);

        if is_target_surface {
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

        if thickness.is_finite() && thickness != 0.0 {
            px += dx * thickness;
            py += dy * thickness;
            pz += dz * thickness;
            opl += thickness.abs() * 1000.0 * n_cur;
        }
    }

    out[0] = 6.0;
    out[1] = opl;
    out
}

fn generate_annular_offsets_flat(ray_count: usize, max_radius: f64, ring_count: usize) -> Vec<f64> {
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

    let step = if rings > 0 { max_radius / rings as f64 } else { max_radius };

    for idx in 0..rings {
        if remaining_rays == 0 {
            break;
        }
        let radius = step * (idx + 1) as f64;
        let rings_remaining = rings - idx;
        let rays_for_ring = (remaining_rays / rings_remaining).max(4);
        let angle_step = (2.0 * PI) / rays_for_ring as f64;
        let start_angle = if (idx % 2) == 0 { 0.0 } else { angle_step * 0.5 };
        for i in 0..rays_for_ring {
            if remaining_rays == 0 {
                break;
            }
            let angle = start_angle + i as f64 * angle_step;
            out.push(radius * angle.cos());
            out.push(radius * angle.sin());
            remaining_rays = remaining_rays.saturating_sub(1);
        }
    }

    out
}

fn generate_centered_grid_offsets_flat(ray_count: usize, half_extent: f64) -> Vec<f64> {
    let mut out = Vec::<f64>::new();
    if ray_count == 0 {
        return out;
    }

    let mut grid_size = (ray_count as f64).sqrt().ceil() as usize;
    if grid_size == 0 {
        grid_size = 1;
    }
    if grid_size % 2 == 0 {
        grid_size += 1;
    }

    let spacing = if grid_size > 1 {
        (2.0 * half_extent) / (grid_size.saturating_sub(1) as f64)
    } else {
        0.0
    };
    let center = (grid_size.saturating_sub(1) as f64) * 0.5;

    let mut selected = 0usize;
    let max_layer = grid_size / 2;
    for layer in 0..=max_layer {
        if selected >= ray_count {
            break;
        }
        let mut layer_points = Vec::<(f64, f64)>::new();
        for i in 0..grid_size {
            for j in 0..grid_size {
                let li = ((i as f64) - center).abs() as usize;
                let lj = ((j as f64) - center).abs() as usize;
                if li.max(lj) != layer {
                    continue;
                }
                let u = if grid_size > 1 { (i as f64 - center) * spacing } else { 0.0 };
                let v = if grid_size > 1 { (j as f64 - center) * spacing } else { 0.0 };
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

fn generate_cross_offsets_flat(ray_count: usize, max_radius: f64) -> Vec<f64> {
    let mut out = Vec::<f64>::new();
    if ray_count == 0 {
        return out;
    }

    out.push(0.0);
    out.push(0.0);
    if ray_count == 1 {
        return out;
    }

    let mut remaining = ray_count - 1;
    let requested_per_arm = ((remaining + 3) / 4).max(1);
    let arm_steps = requested_per_arm.min(100);
    for i in 0..arm_steps {
        if remaining == 0 {
            break;
        }
        let t = ((i + 1) as f64) / (arm_steps as f64);
        let r = max_radius * t;
        let candidates = [(r, 0.0), (-r, 0.0), (0.0, r), (0.0, -r)];
        for (x, y) in candidates {
            if remaining == 0 {
                break;
            }
            out.push(x);
            out.push(y);
            remaining -= 1;
        }
    }

    out
}

fn collect_spot_wavelengths(source_rows: &[Value], wavelength_mode: &str) -> Vec<SpotWavelength> {
    let mut all = Vec::<f64>::new();
    let mut primary = 0.587_561_8_f64;

    for row in source_rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let wl = obj
            .get("wavelength")
            .or_else(|| obj.get("Wavelength"))
            .and_then(value_to_f64);
        if let Some(v) = wl {
            if v.is_finite() && v > 0.0 {
                all.push(v);
                let primary_flag = obj
                    .get("primary")
                    .or_else(|| obj.get("Primary"))
                    .or_else(|| obj.get("Primary Wavelength"));
                if let Some(flag) = primary_flag {
                    let s = value_to_string(flag).unwrap_or_default().trim().to_lowercase();
                    if s.contains("primary") || s == "true" || s == "1" || s == "yes" {
                        primary = v;
                    }
                }
            }
        }
    }

    if all.is_empty() {
        all = vec![primary];
    }
    all.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    all.dedup_by(|a, b| (*a - *b).abs() < 1e-9);

    if wavelength_mode.eq_ignore_ascii_case("primary") {
        return vec![SpotWavelength {
            label: "Primary".to_string(),
            color: "#2563eb".to_string(),
            wavelength_um: primary,
        }];
    }

    let palette = [
        "#2563eb", "#16a34a", "#dc2626", "#7c3aed", "#ea580c", "#0891b2", "#4f46e5", "#0f766e",
        "#b91c1c", "#1d4ed8",
    ];

    all.iter()
        .enumerate()
        .map(|(idx, wl)| SpotWavelength {
            label: if (*wl - primary).abs() < 1e-6 {
                format!("Primary ({:.1}nm)", wl * 1000.0)
            } else {
                format!("{:.1}nm", wl * 1000.0)
            },
            color: palette[idx % palette.len()].to_string(),
            wavelength_um: *wl,
        })
        .collect()
}
