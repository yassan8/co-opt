use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use rayon::prelude::*;
use rustfft::{FftPlanner, num_complex::Complex};
use std::collections::HashMap;
use std::f64::consts::PI;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::commands::analysis::SpotPoint;
use crate::commands::gpu_fft;

const EPS_R: f64 = 1e-10;
const MAX_NATIVE_PSF_FFT_SIZE: usize = 4096;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeAnalysisProgressEvent {
    job_id: String,
    kind: String,
    phase: String,
    message: String,
    percent: Option<f64>,
    indeterminate: bool,
    done: bool,
    error: bool,
}

fn emit_native_analysis_progress(
    app: &AppHandle,
    job_id: &str,
    kind: &str,
    phase: &str,
    message: &str,
    percent: Option<f64>,
) {
    let payload = NativeAnalysisProgressEvent {
        job_id: job_id.to_string(),
        kind: kind.to_string(),
        phase: phase.to_string(),
        message: message.to_string(),
        percent,
        indeterminate: percent.is_none(),
        done: false,
        error: false,
    };
    if let Err(err) = app.emit("analysis-progress", payload) {
        eprintln!("[analysis-progress] native emit failed: {err}");
    }
}

fn emit_native_analysis_done(app: &AppHandle, job_id: &str, kind: &str, message: &str) {
    let payload = NativeAnalysisProgressEvent {
        job_id: job_id.to_string(),
        kind: kind.to_string(),
        phase: "done".to_string(),
        message: message.to_string(),
        percent: Some(100.0),
        indeterminate: false,
        done: true,
        error: false,
    };
    if let Err(err) = app.emit("analysis-progress", payload) {
        eprintln!("[analysis-progress] native done emit failed: {err}");
    }
}

fn emit_native_analysis_error(app: &AppHandle, job_id: &str, kind: &str, message: &str) {
    let payload = NativeAnalysisProgressEvent {
        job_id: job_id.to_string(),
        kind: kind.to_string(),
        phase: "error".to_string(),
        message: message.to_string(),
        percent: Some(100.0),
        indeterminate: false,
        done: true,
        error: true,
    };
    if let Err(err) = app.emit("analysis-progress", payload) {
        eprintln!("[analysis-progress] native error emit failed: {err}");
    }
}

fn build_native_job_id(prefix: &str) -> String {
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{}-{}", prefix, ts_ms)
}

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
    pub pupil_u: Option<f64>,
    #[serde(default)]
    pub pupil_v: Option<f64>,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTransverseAberrationRequest {
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub surface_index: Option<usize>,
    pub ray_count: Option<u32>,
    pub ring_count: Option<u32>,
    pub pattern: Option<String>,
    pub wavelength_mode: Option<String>,
    pub wavelength: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTransverseAberrationPoint {
    pub pupil_coordinate: f64,
    pub transverse_aberration: f64,
    pub is_full_success: bool,
    pub is_partial: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTransverseAberrationSeries {
    pub field_setting: NativeAstigmatismFieldSetting,
    pub points: Vec<NativeTransverseAberrationPoint>,
    pub has_offset: bool,
    pub offset_method: Option<String>,
    pub zero_aberration_position: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeTransverseAberrationResponse {
    pub backend: String,
    pub wavelength: f64,
    pub target_surface: usize,
    pub stop_surface: usize,
    pub stop_radius: f64,
    pub pupil_radius: f64,
    pub is_finite_system: bool,
    pub field_settings: Vec<NativeAstigmatismFieldSetting>,
    pub meridional_data: Vec<NativeTransverseAberrationSeries>,
    pub sagittal_data: Vec<NativeTransverseAberrationSeries>,
    pub metadata: Map<String, Value>,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOpdMapRequest {
    pub job_id: Option<String>,
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub object_index: Option<usize>,
    pub surface_index: Option<usize>,
    pub grid_size: Option<u32>,
    pub wavelength_um: Option<f64>,
    pub pupil_radius_mm: Option<f64>,
    pub pupil_sampling_mode: Option<String>,
    pub opd_display_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOpdMapResponse {
    pub backend: String,
    pub target_surface: usize,
    pub stop_surface: usize,
    pub requested_object_index: Option<usize>,
    pub used_object_index: usize,
    pub used_object_position: String,
    pub used_object_x: f64,
    pub used_object_y: f64,
    pub wavelength_um: f64,
    pub grid_size: usize,
    pub sample_count: usize,
    pub hit_count: usize,
    pub pupil_sampling_mode: String,
    pub raw_opd_grid: Vec<Vec<Option<f64>>>,
    pub display_opd_grid: Vec<Vec<Option<f64>>>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePsfMapRequest {
    pub job_id: Option<String>,
    pub grid_opd: Vec<Vec<f64>>,
    pub pupil_mask: Vec<Vec<bool>>,
    #[serde(default)]
    pub grid_amplitude: Vec<Vec<f64>>,
    pub wavelength_um: f64,
    pub pixel_size_um: Option<f64>,
    pub remove_tilt: Option<bool>,
    pub zero_pad_to: Option<u32>,
    pub recenter_if_wrapped: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePsfFwhm {
    pub x: f64,
    pub y: f64,
    pub average: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePsfEncircledEnergyPoint {
    pub radius: f64,
    pub energy: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePsfMetrics {
    pub total_energy: f64,
    pub peak_intensity: f64,
    pub strehl_ratio: f64,
    pub fwhm: NativePsfFwhm,
    pub encircled_energy: Vec<NativePsfEncircledEnergyPoint>,
    pub center_position: NativePsfCenterPosition,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePsfCenterPosition {
    pub x: usize,
    pub y: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePsfMapResponse {
    pub backend: String,
    pub grid_size: usize,
    pub fft_size: usize,
    pub psf_data: Vec<Vec<f64>>,
    pub metrics: NativePsfMetrics,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMtfMapRequest {
    pub job_id: Option<String>,
    pub psf_data: Vec<Vec<f64>>,
    pub pixel_size_um: f64,
    pub max_frequency_lpmm: Option<f64>,
    pub points: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMtfMapResponse {
    pub backend: String,
    pub frequency_axis: Vec<f64>,
    pub mtf_tangential: Vec<f64>,
    pub mtf_sagittal: Vec<f64>,
    pub nyquist_lpmm: f64,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeThroughFocusMtfMapRequest {
    pub job_id: Option<String>,
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub object_index: Option<usize>,
    pub pupil_sampling_mode: Option<String>,
    #[serde(default)]
    pub wavelengths: Vec<f64>,
    pub target_frequency_lpmm: Option<f64>,
    pub defocus_min_mm: Option<f64>,
    pub defocus_max_mm: Option<f64>,
    pub steps: Option<u32>,
    pub sampling_size: Option<u32>,
    pub zero_pad_to: Option<u32>,
    pub pixel_size_um: Option<f64>,
    pub opd_display_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeThroughFocusMtfSeries {
    pub wavelength_um: f64,
    pub label: String,
    pub mtf_tangential: Vec<f64>,
    pub mtf_sagittal: Vec<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeThroughFocusMtfMapResponse {
    pub backend: String,
    pub x_axis: Vec<f64>,
    pub series: Vec<NativeThroughFocusMtfSeries>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFieldMtfMapRequest {
    pub job_id: Option<String>,
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub object_index: Option<usize>,
    pub pupil_sampling_mode: Option<String>,
    #[serde(default)]
    pub wavelengths: Vec<f64>,
    pub first_frequency_lpmm: Option<f64>,
    pub second_frequency_lpmm: Option<f64>,
    pub field_min: Option<f64>,
    pub field_max: Option<f64>,
    pub steps: Option<u32>,
    pub sampling_size: Option<u32>,
    pub zero_pad_to: Option<u32>,
    pub pixel_size_um: Option<f64>,
    pub opd_display_mode: Option<String>,
    pub field_axis_mode: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFieldMtfSeries {
    pub wavelength_um: f64,
    pub label: String,
    pub meridional_first: Vec<f64>,
    pub sagittal_first: Vec<f64>,
    pub meridional_second: Vec<f64>,
    pub sagittal_second: Vec<f64>,
    pub field_diagnostics: Vec<NativeFieldMtfPointDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFieldMtfPointDiagnostic {
    pub field_value: f64,
    pub effective_pupil_sampling_mode: String,
    pub used_object_position: Option<String>,
    pub target_surface_index: usize,
    pub used_object_index: usize,
    pub opd_sample_count: usize,
    pub opd_hit_count: usize,
    pub opd_hit_rate: f64,
    pub first_frequency_lpmm: f64,
    pub first_bracket_low_lpmm: Option<f64>,
    pub first_bracket_high_lpmm: Option<f64>,
    pub first_value_meridional: f64,
    pub first_value_sagittal: f64,
    pub second_frequency_lpmm: f64,
    pub second_bracket_low_lpmm: Option<f64>,
    pub second_bracket_high_lpmm: Option<f64>,
    pub second_value_meridional: f64,
    pub second_value_sagittal: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFieldMtfMapResponse {
    pub backend: String,
    pub x_axis: Vec<f64>,
    pub axis_mode: String,
    pub series: Vec<NativeFieldMtfSeries>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDistortionRequest {
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    #[allow(dead_code)]
    pub object_rows: Vec<Value>,
    pub surface_index: Option<usize>,
    pub field_samples: Vec<f64>,
    pub height_mode: Option<bool>,
    pub wavelength: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDistortionResponse {
    pub backend: String,
    pub field_values: Vec<f64>,
    pub ideal_heights: Vec<f64>,
    pub real_heights: Vec<Option<f64>>,
    pub distortion: Vec<Option<f64>>,
    pub distortion_percent: Vec<Option<f64>>,
    pub meta: Map<String, Value>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGridDistortionRequest {
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub surface_index: Option<usize>,
    pub grid_size: Option<u32>,
    pub wavelength: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeGridDistortionResponse {
    pub backend: String,
    pub ideal_x: Vec<f64>,
    pub ideal_y: Vec<f64>,
    pub real_x: Vec<Option<f64>>,
    pub real_y: Vec<Option<f64>>,
    pub grid_size: usize,
    pub max_field_angle: f64,
    pub meta: Map<String, Value>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMagnificationChromaticAberrationRequest {
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    pub surface_index: Option<usize>,
    pub field_samples: Vec<f64>,
    #[serde(default)]
    pub wavelengths: Vec<f64>,
    pub reference_wavelength: Option<f64>,
    pub height_mode: Option<bool>,
    pub chief_ray_definition: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMagnificationChromaticAberrationSeries {
    pub wavelength: f64,
    pub displacements: Vec<Option<f64>>,
    pub image_heights: Vec<Option<f64>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMagnificationChromaticAberrationResponse {
    pub backend: String,
    pub field_values: Vec<f64>,
    pub height_mode: bool,
    pub reference_wavelength: f64,
    pub image_surface_index: usize,
    pub data_by_wavelength: Vec<NativeMagnificationChromaticAberrationSeries>,
    pub meta: Map<String, Value>,
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
                    pupil_u: r.pupil_u,
                    pupil_v: r.pupil_v,
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
            false,
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
                    pupil_u: None,
                    pupil_v: None,
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

fn solve_linear_system(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = a.len();
    if n == 0 || b.len() != n {
        return None;
    }
    for row in &a {
        if row.len() != n {
            return None;
        }
    }

    for i in 0..n {
        let mut pivot = i;
        let mut max_abs = a[i][i].abs();
        for r in (i + 1)..n {
            let v = a[r][i].abs();
            if v > max_abs {
                max_abs = v;
                pivot = r;
            }
        }
        if max_abs < 1e-14 {
            return None;
        }

        if pivot != i {
            a.swap(i, pivot);
            b.swap(i, pivot);
        }

        let diag = a[i][i];
        for c in i..n {
            a[i][c] /= diag;
        }
        b[i] /= diag;

        for r in 0..n {
            if r == i {
                continue;
            }
            let factor = a[r][i];
            if factor.abs() < 1e-20 {
                continue;
            }
            for c in i..n {
                a[r][c] -= factor * a[i][c];
            }
            b[r] -= factor * b[i];
        }
    }

    Some(b)
}

fn apply_opd_display_mode_grid(
    raw_grid: &[Vec<Option<f64>>],
    mode: &str,
) -> Vec<Vec<Option<f64>>> {
    if mode.eq_ignore_ascii_case("raw") {
        return raw_grid.to_vec();
    }

    let h = raw_grid.len();
    if h == 0 {
        return raw_grid.to_vec();
    }
    let w = raw_grid[0].len();
    if w == 0 {
        return raw_grid.to_vec();
    }

    let remove_defocus = mode.eq_ignore_ascii_case("pistonTiltDefocusRemoved");
    let basis_dim = if remove_defocus { 4 } else { 3 };

    let mut pupil_radius = 0.0_f64;
    for iy in 0..h {
        for ix in 0..w {
            let Some(z) = raw_grid[iy][ix] else { continue; };
            if !z.is_finite() {
                continue;
            }
            let u = if w > 1 {
                -1.0 + 2.0 * (ix as f64) / ((w - 1) as f64)
            } else {
                0.0
            };
            let v = if h > 1 {
                -1.0 + 2.0 * (iy as f64) / ((h - 1) as f64)
            } else {
                0.0
            };
            if !u.is_finite() || !v.is_finite() {
                continue;
            }
            let r = (u * u + v * v).sqrt();
            if r.is_finite() && r > pupil_radius {
                pupil_radius = r;
            }
        }
    }
    if !pupil_radius.is_finite() || pupil_radius <= 1e-12 {
        pupil_radius = 1.0;
    }

    let mut normal = vec![vec![0.0_f64; basis_dim]; basis_dim];
    let mut rhs = vec![0.0_f64; basis_dim];
    let mut sample_count = 0usize;

    for iy in 0..h {
        for ix in 0..w {
            let Some(z) = raw_grid[iy][ix] else { continue; };
            if !z.is_finite() {
                continue;
            }
            let u = if w > 1 {
                -1.0 + 2.0 * (ix as f64) / ((w - 1) as f64)
            } else {
                0.0
            };
            let v = if h > 1 {
                -1.0 + 2.0 * (iy as f64) / ((h - 1) as f64)
            } else {
                0.0
            };
            if !u.is_finite() || !v.is_finite() {
                continue;
            }
            let xn = u / pupil_radius;
            let yn = v / pupil_radius;
            let rn2 = xn * xn + yn * yn;
            if !rn2.is_finite() || rn2 > 1.0 + 1e-9 {
                continue;
            }

            let phi = if remove_defocus {
                [1.0, xn, yn, 2.0 * rn2 - 1.0]
            } else {
                [1.0, u, v, 0.0]
            };

            for i in 0..basis_dim {
                rhs[i] += phi[i] * z;
                for j in 0..basis_dim {
                    normal[i][j] += phi[i] * phi[j];
                }
            }
            sample_count += 1;
        }
    }

    if sample_count < basis_dim {
        return raw_grid.to_vec();
    }

    let Some(coeff) = solve_linear_system(normal, rhs) else {
        return raw_grid.to_vec();
    };

    let mut out = raw_grid.to_vec();
    for iy in 0..h {
        for ix in 0..w {
            let Some(z) = raw_grid[iy][ix] else {
                out[iy][ix] = None;
                continue;
            };
            let u = if w > 1 {
                -1.0 + 2.0 * (ix as f64) / ((w - 1) as f64)
            } else {
                0.0
            };
            let v = if h > 1 {
                -1.0 + 2.0 * (iy as f64) / ((h - 1) as f64)
            } else {
                0.0
            };
            let xn = u / pupil_radius;
            let yn = v / pupil_radius;
            let rn2 = xn * xn + yn * yn;
            if !rn2.is_finite() || rn2 > 1.0 + 1e-9 {
                out[iy][ix] = None;
                continue;
            }
            let mut fit = coeff[0] + coeff[1] * u + coeff[2] * v;
            if remove_defocus {
                fit = coeff[0] + coeff[1] * xn + coeff[2] * yn + coeff[3] * (2.0 * rn2 - 1.0);
            }
            out[iy][ix] = Some(z - fit);
        }
    }

    out
}

#[tauri::command]
pub fn run_native_opd_map(req: NativeOpdMapRequest, app: AppHandle) -> Result<NativeOpdMapResponse, String> {
    let job_id = req
        .job_id
        .clone()
        .unwrap_or_else(|| build_native_job_id("native-opd"));
    let kind = "opd-native";
    emit_native_analysis_progress(&app, &job_id, kind, "prepare", "Preparing native OPD inputs...", Some(5.0));

    let result: Result<NativeOpdMapResponse, String> = (|| {
    if req.optical_system_rows.is_empty() {
        return Err("run_native_opd_map: opticalSystemRows is empty".to_string());
    }

    let rows: Vec<Value> = req
        .optical_system_rows
        .iter()
        .map(normalize_coord_trans_row)
        .collect();
    if rows.is_empty() {
        return Err("run_native_opd_map: normalized rows are empty".to_string());
    }
    emit_native_analysis_progress(&app, &job_id, kind, "prepare", "Resolving pupil and field setup...", Some(18.0));

    let grid_size = req.grid_size.unwrap_or(129).max(17) as usize;
    let default_eval_surface_index = find_evaluation_surface_index_native(&rows);
    let requested_target_surface_index = req
        .surface_index
        .unwrap_or(default_eval_surface_index)
        .min(rows.len().saturating_sub(1));
    let mut target_surface_index = requested_target_surface_index;

    let surface_data = calculate_surface_data(&rows);
    if surface_data.len() != rows.len() {
        return Err("run_native_opd_map: failed to calculate surface origins".to_string());
    }

    let stop_surface_index = find_stop_surface_index_native(&rows)
        .unwrap_or_else(|| rows.len().saturating_sub(1))
        .min(rows.len().saturating_sub(1));
    let stop_surface = surface_data
        .get(stop_surface_index)
        .copied()
        .unwrap_or(surface_data[surface_data.len().saturating_sub(1)]);

    let mut stop_radius = estimate_stop_radius_mm(&rows);
    if let Some(req_r) = req.pupil_radius_mm {
        if req_r.is_finite() && req_r > 0.0 {
            stop_radius = req_r;
        }
    }
    let entrance_radius = estimate_entrance_radius_mm(&rows).clamp(0.01, 500.0);
    let sampling_radius = if stop_radius.is_finite() && stop_radius > 0.0 {
        stop_radius.min(entrance_radius).max(0.01)
    } else {
        entrance_radius
    };

    let mut source_rows = req.source_rows.clone();
    if let Some(wl) = req.wavelength_um.filter(|w| w.is_finite() && *w > 0.0) {
        source_rows = vec![serde_json::json!({
            "id": "NativeOpdSource",
            "name": "NativeOpdSource",
            "wavelength": wl,
            "isPrimary": true,
            "primary": "Primary",
            "intensity": 1,
            "color": "#2563eb"
        })];
    }

    let mut object_rows = req.object_rows.clone();
    if object_rows.is_empty() {
        object_rows.push(serde_json::json!({
            "id": "Object-0",
            "name": "Object-0",
            "position": "Angle",
            "xHeightAngle": 0.0,
            "yHeightAngle": 0.0,
            "x": 0.0,
            "y": 0.0
        }));
    }
    let requested_object_index = req.object_index;
    let mut used_object_index: usize = 0;
    if let Some(idx) = req.object_index {
        if idx < object_rows.len() {
            used_object_index = idx;
            object_rows = vec![object_rows[idx].clone()];
        }
    }

    let selected_object = object_rows
        .get(0)
        .and_then(|v| v.as_object());
    let used_object_position = selected_object
        .and_then(|o| {
            o.get("position")
                .or_else(|| o.get("object"))
                .or_else(|| o.get("objectType"))
                .or_else(|| o.get("type"))
                .and_then(value_to_string)
        })
        .unwrap_or_else(|| "Point".to_string());
    let pos_lower = used_object_position.trim().to_lowercase();
    let is_angle_object = pos_lower.contains("angle") || pos_lower == "point";

    let angle_object_x = selected_object
        .and_then(|o| {
            get_object_numeric(
                o,
                &[
                    "xHeightAngle",
                    "xFieldAngle",
                    "xAngle",
                    "x",
                    "X",
                    "xHeight",
                ],
            )
        })
        .unwrap_or(0.0);
    let angle_object_y = selected_object
        .and_then(|o| {
            get_object_numeric(
                o,
                &[
                    "yHeightAngle",
                    "yFieldAngle",
                    "fieldAngle",
                    "yAngle",
                    "angle",
                    "y",
                    "Y",
                    "yHeight",
                ],
            )
        })
        .unwrap_or(0.0);

    let height_object_x = selected_object
        .and_then(|o| get_object_numeric(o, &["xHeight", "x", "X"]))
        .unwrap_or(0.0);
    let height_object_y = selected_object
        .and_then(|o| get_object_numeric(o, &["yHeight", "y", "Y", "height"]))
        .unwrap_or(0.0);

    let wl_series = collect_spot_wavelengths(&source_rows, "primary");
    let wl_um_raw = wl_series
        .first()
        .map(|w| w.wavelength_um)
        .unwrap_or(0.5876);
    let wavelength_um = req
        .wavelength_um
        .filter(|w| w.is_finite() && *w > 0.0)
        .unwrap_or(wl_um_raw);
    if !wavelength_um.is_finite() || wavelength_um <= 0.0 {
        return Err("run_native_opd_map: invalid wavelength".to_string());
    }
    let object_space_n = rows
        .first()
        .map(|r| get_correct_refractive_index(r, wavelength_um))
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(1.0);

    let mut packed_target = build_packed_meta(&rows, &surface_data, target_surface_index, wavelength_um)?;
    let packed_stop = build_packed_meta(&rows, &surface_data, stop_surface_index, wavelength_um)?;
    let mut chief_target_fallback_from: Option<usize> = None;
    emit_native_analysis_progress(&app, &job_id, kind, "trace", "Tracing chief ray and target surface...", Some(36.0));

    let stop_plane_u = normalize3(stop_surface.rot[0], stop_surface.rot[3], stop_surface.rot[6]);
    let stop_plane_v = normalize3(stop_surface.rot[1], stop_surface.rot[4], stop_surface.rot[7]);

    let selected_object_map = selected_object;
    let object_plane_z = surface_data.first().map(|s| s.origin[2]).unwrap_or(0.0);
    let infinite_conjugate = is_infinite_conjugate_native(&rows);
    let use_infinite_mode = infinite_conjugate;
    let (used_object_x, used_object_y) = if use_infinite_mode {
        if is_angle_object {
            (angle_object_x, angle_object_y)
        } else {
            (0.0, 0.0)
        }
    } else {
        (height_object_x, height_object_y)
    };

    let finite_object_distance = {
        let t0 = rows.first().map(get_safe_thickness).unwrap_or(f64::NAN).abs();
        if t0.is_finite() && t0 > 1e-9 {
            t0
        } else {
            let z0 = surface_data
                .first()
                .map(|s| s.origin[2].abs())
                .unwrap_or(0.0);
            if z0.is_finite() && z0 > 1e-9 {
                z0.max(1.0)
            } else {
                let stop_z = stop_surface.origin[2].abs();
                if stop_z.is_finite() {
                    (stop_z + 25.0).max(25.0)
                } else {
                    100.0
                }
            }
        }
    };
    let requested_pupil_sampling_mode = req
        .pupil_sampling_mode
        .as_ref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s == "stop" || s == "entrance");
    let force_entrance_sampling = use_infinite_mode
        && matches!(requested_pupil_sampling_mode.as_deref(), Some("entrance"));
    let force_stop_sampling = use_infinite_mode
        && matches!(requested_pupil_sampling_mode.as_deref(), Some("stop"));
    let mut effective_pupil_sampling_mode = if force_entrance_sampling {
        "entrance"
    } else {
        "stop"
    };

    let infinite_direction = build_direction_from_field_angles_native(used_object_x, used_object_y);
    let (infinite_u_axis, infinite_v_axis) = build_perpendicular_basis_native(infinite_direction);
    let infinite_object_z = selected_object_map
        .map(|obj| resolve_infinite_object_z_native(&rows, obj, object_plane_z))
        .unwrap_or(object_plane_z - 1.0);
    let infinite_origin_xy = if used_object_x.abs() < 1e-10 && used_object_y.abs() < 1e-10 {
        [0.0, 0.0]
    } else {
        optimize_angle_object_position_native(used_object_x, used_object_y, stop_surface.origin, infinite_object_z)
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

    // Keep emission origin deterministic across adjacent fields.
    // High-field local-search refinements can jump between minima and introduce
    // Object MTF discontinuities even when mode/surface stays constant.
    infinite_emission_origin = apply_symmetry_axis_lock(infinite_emission_origin);
    let mut effective_emission_origin = infinite_emission_origin;

    let mut effective_stop_center = stop_surface.origin;
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
    let stop_center_for_sampling = if use_infinite_mode {
        effective_stop_center
    } else {
        stop_surface.origin
    };

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
                stop_hit[2] - stop_surface.origin[0],
                stop_hit[3] - stop_surface.origin[1],
                stop_hit[4] - stop_surface.origin[2],
            ];
            let local = mul_mat3_vec3(&stop_surface.inv_rot, rel);
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
            let step_scale = if step_mag.is_finite() && step_mag > max_step {
                max_step / step_mag
            } else {
                1.0
            };
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
        .ok_or_else(|| "run_native_opd_map: chief ray not found".to_string())?;
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
    if (chief_target_hit[0] - 1.0).abs() > f64::EPSILON {
        if use_infinite_mode {
            let entrance_origin = search_entrance_origin_grid_brent_native(
                &rows,
                &surface_data,
                stop_center_for_sampling,
                infinite_direction,
                stop_surface_index,
                &packed_stop,
                entrance_radius,
            )
            .unwrap_or_else(|| {
                estimate_entrance_center_origin_native(
                    &rows,
                    &surface_data,
                    stop_center_for_sampling,
                    infinite_direction,
                )
            });
            let entrance_radius_try = entrance_radius.max(0.01);
            if let Some(entrance_chief_ray) = build_marginal_ray(0.0, 0.0, entrance_radius_try, entrance_origin) {
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

            // NOTE: keep a safe fallback path to avoid hard failures in extreme fields.
            // We still annotate the mode so parity diagnostics can detect this branch.
            if (chief_target_hit[0] - 1.0).abs() > f64::EPSILON {
                chief_reference_mode = "entrance-chief-target-miss".to_string();
            }
        }

        let allow_target_surface_fallback = req.surface_index.is_none();
        if (chief_target_hit[0] - 1.0).abs() > f64::EPSILON && allow_target_surface_fallback {
            let mut found = false;
            let fallback_from = target_surface_index;
            for candidate_surface in (0..target_surface_index).rev() {
                let candidate_packed = build_packed_meta(&rows, &surface_data, candidate_surface, wavelength_um)?;
                let candidate_hit = trace_single_ray_hit_point_with_meta_core(
                    &chief_start_dir,
                    candidate_surface,
                    object_space_n,
                    &candidate_packed.row_meta,
                    &candidate_packed.row_params,
                    &candidate_packed.row_origins,
                    &candidate_packed.row_inv_rots,
                    &candidate_packed.row_rots,
                    candidate_packed.row_count,
                );
                if (candidate_hit[0] - 1.0).abs() <= f64::EPSILON {
                    target_surface_index = candidate_surface;
                    packed_target = candidate_packed;
                    chief_target_hit = candidate_hit;
                    chief_target_fallback_from = Some(fallback_from);
                    if use_infinite_mode {
                        chief_reference_mode = format!(
                            "{}-target-fallback",
                            chief_reference_mode
                        );
                    }
                    found = true;
                    break;
                }
            }
            if !found {
                return Err("run_native_opd_map: chief ray did not reach target surface".to_string());
            }
        }
        if (chief_target_hit[0] - 1.0).abs() > f64::EPSILON {
            return Err("run_native_opd_map: chief ray did not reach target surface".to_string());
        }
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
    if (chief_stop_hit[0] - 1.0).abs() > f64::EPSILON && !force_entrance_sampling {
        // Web parity: before switching to entrance best-effort, try a Newton-like
        // chief ray origin solve that enforces stop-center crossing.
        if use_infinite_mode {
            if let Some(grid_brent_origin) = search_entrance_origin_grid_brent_native(
                &rows,
                &surface_data,
                stop_center_for_sampling,
                infinite_direction,
                stop_surface_index,
                &packed_stop,
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
    }

    if force_entrance_sampling || ((chief_stop_hit[0] - 1.0).abs() > f64::EPSILON && !force_stop_sampling) {
        if !force_entrance_sampling {
            stop_sampling_fallback_to_entrance = true;
        }
        effective_pupil_sampling_mode = "entrance";
        // Use a smooth, deterministic scale vs field magnitude so adjacent
        // field points do not flip effective ray coverage abruptly.
        let field_mag = (used_object_x * used_object_x + used_object_y * used_object_y).sqrt();
        let entrance_radius_scale = (0.92_f64 - 0.012_f64 * field_mag).clamp(0.76, 0.92);
        effective_sampling_radius = (entrance_radius * entrance_radius_scale).max(0.01);

        if use_infinite_mode {
            effective_emission_origin = apply_symmetry_axis_lock(search_entrance_origin_grid_brent_native(
                &rows,
                &surface_data,
                stop_center_for_sampling,
                infinite_direction,
                stop_surface_index,
                &packed_stop,
                entrance_radius,
            )
            .unwrap_or_else(|| {
                estimate_entrance_center_origin_native(
                    &rows,
                    &surface_data,
                    stop_center_for_sampling,
                    infinite_direction,
                )
            }));

            if let Some(entrance_chief_ray) = build_marginal_ray(
                0.0,
                0.0,
                effective_sampling_radius,
                effective_emission_origin,
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
                    chief_target_hit = entrance_target_hit;
                }
            }
        }
        chief_reference_mode = if force_entrance_sampling {
            format!("entrance-chief-requested(grid-brent,r={:.3})", entrance_radius_scale)
        } else {
            format!("entrance-chief-fallback(grid-brent,r={:.3})", entrance_radius_scale)
        };

        // Keep a fixed entrance radius in strict mode to avoid field-by-field
        // radius changes that can introduce Object MTF discontinuities.
    }
    if force_stop_sampling && (chief_stop_hit[0] - 1.0).abs() > f64::EPSILON {
        return Err("run_native_opd_map: force stop requested, but chief ray did not reach stop surface".to_string());
    }

    let chief_opl = chief_target_hit[1];
    if !chief_opl.is_finite() {
        return Err("run_native_opd_map: chief OPL is invalid".to_string());
    }

    let row_results: Vec<(usize, usize, Vec<Option<f64>>)> = (0..grid_size)
        .into_par_iter()
        .map(|y| {
            let mut attempted_samples = 0usize;
            let mut hit_count = 0usize;
            let mut row = vec![None::<f64>; grid_size];

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
                attempted_samples += 1;

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
                row[x] = Some(opd_waves);
                hit_count += 1;
            }

            (attempted_samples, hit_count, row)
        })
        .collect();

    emit_native_analysis_progress(&app, &job_id, kind, "finalize", "Applying OPD display mode...", Some(90.0));

    let attempted_samples: usize = row_results.iter().map(|(attempted, _, _)| *attempted).sum();
    let hit_count: usize = row_results.iter().map(|(_, hits, _)| *hits).sum();
    let raw_grid: Vec<Vec<Option<f64>>> = row_results.into_iter().map(|(_, _, row)| row).collect();

    let hit_rate = if attempted_samples > 0 {
        hit_count as f64 / attempted_samples as f64
    } else {
        0.0
    };
    if use_infinite_mode
        && effective_pupil_sampling_mode == "entrance"
        && hit_rate < 0.35
    {
        return Err(format!(
            "No valid OPD samples for entrance mode (hit-rate={:.3}, hits={}, samples={})",
            hit_rate,
            hit_count,
            attempted_samples
        ));
    }

    let mode = req
        .opd_display_mode
        .unwrap_or_else(|| "pistonTiltRemoved".to_string());
    let display_grid = apply_opd_display_mode_grid(&raw_grid, &mode);

    Ok(NativeOpdMapResponse {
        backend: "native-rust-opd-map-marginal-v7".to_string(),
        target_surface: target_surface_index,
        stop_surface: stop_surface_index,
        requested_object_index,
        used_object_index,
        used_object_position,
        used_object_x,
        used_object_y,
        wavelength_um,
        grid_size,
        sample_count: attempted_samples,
        hit_count,
        pupil_sampling_mode: effective_pupil_sampling_mode.to_string(),
        raw_opd_grid: raw_grid,
        display_opd_grid: display_grid,
        message: {
            let mut notes: Vec<String> = Vec::new();
            if let Some(from_surface) = chief_target_fallback_from {
                notes.push(format!(
                    "chief-target fallback {} -> {}",
                    from_surface,
                    target_surface_index
                ));
            }
            if force_entrance_sampling {
                notes.push("pupil sampling mode=entrance(requested)".to_string());
            } else if force_stop_sampling {
                notes.push("pupil sampling mode=stop(requested)".to_string());
            } else if stop_sampling_fallback_to_entrance {
                notes.push("pupil sampling fallback stop -> entrance".to_string());
            }
            notes.push(format!("chief reference mode={}", chief_reference_mode));
            if notes.is_empty() {
                "Native Rust OPD map completed (marginal-ray core)".to_string()
            } else {
                format!(
                    "Native Rust OPD map completed (marginal-ray core, {})",
                    notes.join(", ")
                )
            }
        },
    })
    })();

    match result {
        Ok(response) => {
            emit_native_analysis_done(&app, &job_id, kind, "Native OPD map completed");
            Ok(response)
        }
        Err(err) => {
            emit_native_analysis_error(&app, &job_id, kind, &err);
            Err(err)
        }
    }
}

fn find_evaluation_surface_index_native(rows: &[Value]) -> usize {
    if rows.is_empty() {
        return 0;
    }

    let mut last_image_index: Option<usize> = None;
    for (i, row) in rows.iter().enumerate() {
        if is_coord_trans_row(row) || is_gap_row(row) {
            continue;
        }

        let surf_type = norm_string(row, &["surfType", "surf type", "surfTypeName", "type"]);
        let object_type = norm_string(row, &["object type", "object", "Object", "objectType"]);
        if surf_type.contains("image") || object_type.contains("image") {
            last_image_index = Some(i);
        }
    }

    if let Some(idx) = last_image_index {
        return idx;
    }

    for i in (0..rows.len()).rev() {
        let row = &rows[i];
        if is_coord_trans_row(row) || is_object_row(row) || is_gap_row(row) {
            continue;
        }
        return i;
    }

    rows.len().saturating_sub(1)
}

fn remove_tilt_from_opd_grid(opd: &[Vec<f64>], mask: &[Vec<bool>]) -> Vec<Vec<f64>> {
    let h = opd.len();
    if h == 0 {
        return Vec::new();
    }
    let w = opd[0].len();
    if w == 0 {
        return opd.to_vec();
    }

    let mut normal = vec![vec![0.0_f64; 3]; 3];
    let mut rhs = vec![0.0_f64; 3];
    let mut count = 0usize;

    for y in 0..h {
        for x in 0..w {
            if !mask[y][x] {
                continue;
            }
            let z = opd[y][x];
            if !z.is_finite() {
                continue;
            }
            let xn = if w > 1 {
                -1.0 + 2.0 * (x as f64) / ((w - 1) as f64)
            } else {
                0.0
            };
            let yn = if h > 1 {
                -1.0 + 2.0 * (y as f64) / ((h - 1) as f64)
            } else {
                0.0
            };
            let phi = [1.0, xn, yn];
            for i in 0..3 {
                rhs[i] += phi[i] * z;
                for j in 0..3 {
                    normal[i][j] += phi[i] * phi[j];
                }
            }
            count += 1;
        }
    }

    if count < 3 {
        return opd.to_vec();
    }

    let Some(coeff) = solve_linear_system(normal, rhs) else {
        return opd.to_vec();
    };

    let mut out = opd.to_vec();
    for y in 0..h {
        for x in 0..w {
            if !mask[y][x] {
                out[y][x] = 0.0;
                continue;
            }
            let z = opd[y][x];
            if !z.is_finite() {
                out[y][x] = 0.0;
                continue;
            }
            let xn = if w > 1 {
                -1.0 + 2.0 * (x as f64) / ((w - 1) as f64)
            } else {
                0.0
            };
            let yn = if h > 1 {
                -1.0 + 2.0 * (y as f64) / ((h - 1) as f64)
            } else {
                0.0
            };
            let fit = coeff[0] + coeff[1] * xn + coeff[2] * yn;
            out[y][x] = z - fit;
        }
    }
    out
}

fn zero_pad_complex(
    real: &[Vec<f64>],
    imag: &[Vec<f64>],
    dst_size: usize,
) -> (Vec<Vec<f64>>, Vec<Vec<f64>>) {
    let src_h = real.len();
    let src_w = if src_h > 0 { real[0].len() } else { 0 };
    if src_h == 0 || src_w == 0 || dst_size <= src_h || dst_size <= src_w {
        return (real.to_vec(), imag.to_vec());
    }

    let mut out_real = vec![vec![0.0_f64; dst_size]; dst_size];
    let mut out_imag = vec![vec![0.0_f64; dst_size]; dst_size];
    let off_y = (dst_size - src_h) / 2;
    let off_x = (dst_size - src_w) / 2;
    for y in 0..src_h {
        for x in 0..src_w {
            out_real[y + off_y][x + off_x] = real[y][x];
            out_imag[y + off_y][x + off_x] = imag[y][x];
        }
    }
    (out_real, out_imag)
}

/// CPU-based FFT implementation using rustfft
fn fft2d_forward_cpu(real: &mut [Vec<f64>], imag: &mut [Vec<f64>]) -> Result<(), String> {
    let h = real.len();
    if h == 0 || imag.len() != h {
        return Err("run_native_psf_map: invalid FFT input".to_string());
    }
    let w = real[0].len();
    if w == 0 {
        return Err("run_native_psf_map: invalid FFT width".to_string());
    }
    for y in 0..h {
        if real[y].len() != w || imag[y].len() != w {
            return Err("run_native_psf_map: FFT input is not rectangular".to_string());
        }
    }

    let mut planner = FftPlanner::<f64>::new();
    let fft_row = planner.plan_fft_forward(w);
    let fft_col = planner.plan_fft_forward(h);

    for y in 0..h {
        let mut row = Vec::<Complex<f64>>::with_capacity(w);
        for x in 0..w {
            row.push(Complex {
                re: real[y][x],
                im: imag[y][x],
            });
        }
        fft_row.process(&mut row);
        for x in 0..w {
            real[y][x] = row[x].re;
            imag[y][x] = row[x].im;
        }
    }

    for x in 0..w {
        let mut col = Vec::<Complex<f64>>::with_capacity(h);
        for y in 0..h {
            col.push(Complex {
                re: real[y][x],
                im: imag[y][x],
            });
        }
        fft_col.process(&mut col);
        for y in 0..h {
            real[y][x] = col[y].re;
            imag[y][x] = col[y].im;
        }
    }

    Ok(())
}

/// Main FFT function - tries GPU first, falls back to CPU
fn fft2d_forward(real: &mut [Vec<f64>], imag: &mut [Vec<f64>]) -> Result<(), String> {
    gpu_fft::fft2d_forward_hybrid(real, imag, fft2d_forward_cpu)
}

fn fft_shift_2d(data: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let h = data.len();
    if h == 0 {
        return Vec::new();
    }
    let w = data[0].len();
    let shift_y = h / 2;
    let shift_x = w / 2;
    let mut out = vec![vec![0.0_f64; w]; h];
    for y in 0..h {
        let src_y = (y + shift_y) % h;
        for x in 0..w {
            let src_x = (x + shift_x) % w;
            out[y][x] = data[src_y][src_x];
        }
    }
    out
}

fn circular_shift_2d(data: &[Vec<f64>], shift_y: isize, shift_x: isize) -> Vec<Vec<f64>> {
    let h = data.len();
    if h == 0 {
        return Vec::new();
    }
    let w = data[0].len();
    let mut out = vec![vec![0.0_f64; w]; h];
    for y in 0..h {
        for x in 0..w {
            let src_y = (((y as isize) - shift_y).rem_euclid(h as isize)) as usize;
            let src_x = (((x as isize) - shift_x).rem_euclid(w as isize)) as usize;
            out[y][x] = data[src_y][src_x];
        }
    }
    out
}

fn find_peak_2d(data: &[Vec<f64>]) -> Option<(usize, usize, f64)> {
    if data.is_empty() || data[0].is_empty() {
        return None;
    }
    let h = data.len();
    let w = data[0].len();
    let mut best = (0usize, 0usize, f64::NEG_INFINITY);
    for y in 0..h {
        if data[y].len() != w {
            return None;
        }
        for x in 0..w {
            let v = data[y][x];
            if v.is_finite() && v > best.2 {
                best = (y, x, v);
            }
        }
    }
    Some(best)
}

fn find_fwhm_from_profile(profile: &[f64], center: usize, half_max: f64) -> f64 {
    if profile.is_empty() || center >= profile.len() {
        return 0.0;
    }

    let mut left = center;
    let mut right = center;

    for i in (0..=center).rev() {
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

    (right.saturating_sub(left)) as f64
}

fn calculate_psf_metrics(psf: &[Vec<f64>], pixel_size_um: f64, strehl_ratio_override: Option<f64>) -> NativePsfMetrics {
    let h = psf.len();
    let w = if h > 0 { psf[0].len() } else { 0 };
    if h == 0 || w == 0 {
        return NativePsfMetrics {
            total_energy: 0.0,
            peak_intensity: 0.0,
            strehl_ratio: 0.0,
            fwhm: NativePsfFwhm {
                x: 0.0,
                y: 0.0,
                average: 0.0,
            },
            encircled_energy: Vec::new(),
            center_position: NativePsfCenterPosition { x: 0, y: 0 },
        };
    }

    let (peak_y, peak_x, peak_val) = find_peak_2d(psf).unwrap_or((h / 2, w / 2, 0.0));
    let total_energy = psf
        .iter()
        .flat_map(|row| row.iter())
        .copied()
        .filter(|v| v.is_finite())
        .sum::<f64>();

    let half_max = peak_val * 0.5;
    let x_profile = &psf[peak_y];
    let y_profile = (0..h).map(|yy| psf[yy][peak_x]).collect::<Vec<_>>();
    let fwhm_x = find_fwhm_from_profile(x_profile, peak_x, half_max) * pixel_size_um;
    let fwhm_y = find_fwhm_from_profile(&y_profile, peak_y, half_max) * pixel_size_um;

    let center_y = h / 2;
    let center_x = w / 2;
    let max_radius = (h.min(w)) / 2;
    let mut bins = vec![0.0_f64; max_radius + 1];
    let mut ee_total = 0.0_f64;
    for y in 0..h {
        for x in 0..w {
            let dy = y as isize - center_y as isize;
            let dx = x as isize - center_x as isize;
            let r = (((dy * dy + dx * dx) as f64).sqrt().floor()) as usize;
            if r <= max_radius {
                let v = psf[y][x];
                if v.is_finite() {
                    bins[r] += v;
                    ee_total += v;
                }
            }
        }
    }
    let mut encircled_energy = Vec::<NativePsfEncircledEnergyPoint>::new();
    let mut cumulative = 0.0_f64;
    for r in 1..=max_radius {
        cumulative += bins[r];
        encircled_energy.push(NativePsfEncircledEnergyPoint {
            radius: (r as f64) * pixel_size_um,
            energy: if ee_total > 0.0 {
                (cumulative / ee_total) * 100.0
            } else {
                0.0
            },
        });
    }

    NativePsfMetrics {
        total_energy,
        peak_intensity: if peak_val.is_finite() { peak_val } else { 0.0 },
        strehl_ratio: strehl_ratio_override
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(0.0, 1.0))
            .unwrap_or_else(|| if peak_val.is_finite() { peak_val.clamp(0.0, 1.0) } else { 0.0 }),
        fwhm: NativePsfFwhm {
            x: fwhm_x,
            y: fwhm_y,
            average: (fwhm_x + fwhm_y) * 0.5,
        },
        encircled_energy,
        center_position: NativePsfCenterPosition {
            x: peak_x,
            y: peak_y,
        },
    }
}

#[tauri::command]
pub fn run_native_psf_map(req: NativePsfMapRequest, app: AppHandle) -> Result<NativePsfMapResponse, String> {
    let job_id = req
        .job_id
        .clone()
        .unwrap_or_else(|| build_native_job_id("native-psf"));
    let kind = "psf-native";
    emit_native_analysis_progress(&app, &job_id, kind, "prepare", "Validating native PSF inputs...", Some(6.0));

    let result: Result<NativePsfMapResponse, String> = (|| {
    let grid_size = req.grid_opd.len();
    if grid_size == 0 {
        return Err("run_native_psf_map: gridOpd is empty".to_string());
    }
    if req.pupil_mask.len() != grid_size {
        return Err("run_native_psf_map: pupilMask height mismatch".to_string());
    }
    let width = req.grid_opd[0].len();
    if width == 0 || width != grid_size {
        return Err("run_native_psf_map: gridOpd must be square".to_string());
    }
    for y in 0..grid_size {
        if req.grid_opd[y].len() != width || req.pupil_mask[y].len() != width {
            return Err("run_native_psf_map: non-rectangular grid input".to_string());
        }
    }
    if !req.wavelength_um.is_finite() || req.wavelength_um <= 0.0 {
        return Err("run_native_psf_map: wavelengthUm must be positive".to_string());
    }
    emit_native_analysis_progress(&app, &job_id, kind, "compute", "Building complex pupil from OPD...", Some(28.0));

    let remove_tilt = req.remove_tilt.unwrap_or(true);
    let mut opd = req.grid_opd.clone();
    if remove_tilt {
        opd = remove_tilt_from_opd_grid(&opd, &req.pupil_mask);
    }

    let requested_fft = req.zero_pad_to.unwrap_or(grid_size as u32) as usize;
    let mut amplitude = vec![vec![1.0_f64; width]; grid_size];
    if !req.grid_amplitude.is_empty() {
        if req.grid_amplitude.len() != grid_size {
            return Err("run_native_psf_map: gridAmplitude height mismatch".to_string());
        }
        for y in 0..grid_size {
            if req.grid_amplitude[y].len() != width {
                return Err("run_native_psf_map: gridAmplitude width mismatch".to_string());
            }
            for x in 0..width {
                let a = req.grid_amplitude[y][x];
                amplitude[y][x] = if a.is_finite() && a >= 0.0 { a } else { 0.0 };
            }
        }
    }


    let phase_scale = -2.0 * PI / req.wavelength_um;
    let (real, imag): (Vec<Vec<f64>>, Vec<Vec<f64>>) = (0..grid_size)
        .into_par_iter()
        .map(|y| {
            let mut real_row = vec![0.0_f64; width];
            let mut imag_row = vec![0.0_f64; width];
            for x in 0..width {
                if !req.pupil_mask[y][x] {
                    continue;
                }
                let z = opd[y][x];
                if !z.is_finite() {
                    continue;
                }
                let a = amplitude[y][x];
                if !a.is_finite() || a <= 0.0 {
                    continue;
                }
                let phase = phase_scale * z;
                real_row[x] = a * phase.cos();
                imag_row[x] = a * phase.sin();
            }
            (real_row, imag_row)
        })
        .unzip();

    let required_fft_size = requested_fft.max(grid_size);
    if required_fft_size > MAX_NATIVE_PSF_FFT_SIZE {
        return Err(format!(
            "run_native_psf_map: requested FFT size {} exceeds max {}",
            required_fft_size, MAX_NATIVE_PSF_FFT_SIZE
        ));
    }
    let fft_size = required_fft_size;
    let (mut fft_real, mut fft_imag) = if fft_size > grid_size {
        zero_pad_complex(&real, &imag, fft_size)
    } else {
        (real, imag)
    };

    emit_native_analysis_progress(&app, &job_id, kind, "fft", "Running FFT for PSF map...", Some(56.0));
    fft2d_forward(&mut fft_real, &mut fft_imag)?;

    let intensity_rows: Vec<(Vec<f64>, f64)> = (0..fft_size)
        .into_par_iter()
        .map(|y| {
            let mut row = vec![0.0_f64; fft_size];
            let mut row_peak = 0.0_f64;
            for x in 0..fft_size {
                let v = fft_real[y][x] * fft_real[y][x] + fft_imag[y][x] * fft_imag[y][x];
                let vv = if v.is_finite() && v >= 0.0 { v } else { 0.0 };
                row[x] = vv;
                if vv > row_peak {
                    row_peak = vv;
                }
            }
            (row, row_peak)
        })
        .collect();
    let mut intensity = Vec::with_capacity(fft_size);
    let mut aberrated_peak = 0.0_f64;
    for (row, row_peak) in intensity_rows {
        if row_peak > aberrated_peak {
            aberrated_peak = row_peak;
        }
        intensity.push(row);
    }

    let (ideal_real, ideal_imag): (Vec<Vec<f64>>, Vec<Vec<f64>>) = (0..grid_size)
        .into_par_iter()
        .map(|y| {
            let mut real_row = vec![0.0_f64; width];
            let imag_row = vec![0.0_f64; width];
            for x in 0..width {
                if !req.pupil_mask[y][x] {
                    continue;
                }
                let a = amplitude[y][x];
                if !a.is_finite() || a <= 0.0 {
                    continue;
                }
                real_row[x] = a;
            }
            (real_row, imag_row)
        })
        .unzip();
    let (mut ideal_fft_real, mut ideal_fft_imag) = if fft_size > grid_size {
        zero_pad_complex(&ideal_real, &ideal_imag, fft_size)
    } else {
        (ideal_real, ideal_imag)
    };
    fft2d_forward(&mut ideal_fft_real, &mut ideal_fft_imag)?;
    let ideal_peak = (0..fft_size)
        .into_par_iter()
        .map(|y| {
            let mut row_peak = 0.0_f64;
            for x in 0..fft_size {
                let v = ideal_fft_real[y][x] * ideal_fft_real[y][x] + ideal_fft_imag[y][x] * ideal_fft_imag[y][x];
                let vv = if v.is_finite() && v >= 0.0 { v } else { 0.0 };
                if vv > row_peak {
                    row_peak = vv;
                }
            }
            row_peak
        })
        .reduce(|| 0.0_f64, f64::max);
    let strehl_ratio_override = if aberrated_peak > 0.0 && ideal_peak > 0.0 {
        Some((aberrated_peak / ideal_peak).clamp(0.0, 1.0))
    } else {
        Some(0.0)
    };

    if aberrated_peak > 0.0 {
        intensity
            .par_iter_mut()
            .for_each(|row| row.iter_mut().for_each(|v| *v /= aberrated_peak));
    }

    let mut psf = fft_shift_2d(&intensity);
    if req.recenter_if_wrapped.unwrap_or(false) {
        if let Some((peak_y, peak_x, _)) = find_peak_2d(&psf) {
            let c_y = fft_size / 2;
            let c_x = fft_size / 2;
            let edge = (fft_size as f64 * 0.08).floor() as usize;
            let border_th = edge.max(2);
            let near_border =
                peak_y < border_th
                    || peak_y >= fft_size.saturating_sub(border_th)
                    || peak_x < border_th
                    || peak_x >= fft_size.saturating_sub(border_th);
            if near_border {
                let shift_y = c_y as isize - peak_y as isize;
                let shift_x = c_x as isize - peak_x as isize;
                psf = circular_shift_2d(&psf, shift_y, shift_x);
            }
        }
    }

    let pixel_size_um = req.pixel_size_um.unwrap_or(1.0).abs().max(1e-12);
    emit_native_analysis_progress(&app, &job_id, kind, "finalize", "Computing PSF metrics...", Some(88.0));
    let metrics = calculate_psf_metrics(&psf, pixel_size_um, strehl_ratio_override);

    Ok(NativePsfMapResponse {
        backend: "native-rust-psf-map".to_string(),
        grid_size,
        fft_size,
        psf_data: psf,
        metrics,
        message: "Native Rust PSF map completed".to_string(),
    })
    })();

    match result {
        Ok(response) => {
            emit_native_analysis_done(&app, &job_id, kind, "Native PSF map completed");
            Ok(response)
        }
        Err(err) => {
            emit_native_analysis_error(&app, &job_id, kind, &err);
            Err(err)
        }
    }
}

#[tauri::command]
pub fn run_native_mtf_map(req: NativeMtfMapRequest, app: AppHandle) -> Result<NativeMtfMapResponse, String> {
    let job_id = req
        .job_id
        .clone()
        .unwrap_or_else(|| build_native_job_id("native-mtf"));
    let kind = "mtf-native";
    emit_native_analysis_progress(&app, &job_id, kind, "prepare", "Validating native MTF inputs...", Some(8.0));

    let result: Result<NativeMtfMapResponse, String> = (|| {
        let n = req.psf_data.len();
        if n == 0 {
            return Err("run_native_mtf_map: psfData is empty".to_string());
        }
        if req.psf_data[0].len() != n {
            return Err("run_native_mtf_map: psfData must be square".to_string());
        }
        for row in &req.psf_data {
            if row.len() != n {
                return Err("run_native_mtf_map: psfData is non-rectangular".to_string());
            }
        }
        if !req.pixel_size_um.is_finite() || req.pixel_size_um <= 0.0 {
            return Err("run_native_mtf_map: pixelSizeUm must be positive".to_string());
        }

        let out_points = req.points.unwrap_or(128).clamp(2, 1024) as usize;

        emit_native_analysis_progress(&app, &job_id, kind, "fft", "Computing OTF from PSF...", Some(42.0));

        // Match web path: compute OTF directly from PSF grid and sample [0][k]/[k][0] axes.
        let mut real = req.psf_data.clone();
        let mut imag = vec![vec![0.0_f64; n]; n];
        fft2d_forward(&mut real, &mut imag)?;

        let dc = (real[0][0] * real[0][0] + imag[0][0] * imag[0][0]).sqrt().max(1e-12);

        // Physical frequency pitch from PSF sampling pitch (um).
        let df_lpmm = (1.0 / (n as f64 * req.pixel_size_um)) * 1000.0;
        let nyquist_lpmm = (0.5 / req.pixel_size_um) * 1000.0;
        let requested_plot_lpmm = match req.max_frequency_lpmm {
            Some(v) if v.is_finite() && v > 0.0 => v,
            _ => nyquist_lpmm,
        };
        let max_bin = n / 2;
        let k_data_max = ((nyquist_lpmm / df_lpmm.max(1e-12)).floor() as usize).min(max_bin);

        emit_native_analysis_progress(&app, &job_id, kind, "sample", "Sampling MTF axes...", Some(78.0));

        let mut freq_data = Vec::with_capacity(k_data_max + 1);
        let mut tangential_raw = Vec::with_capacity(k_data_max + 1);
        let mut sagittal_raw = Vec::with_capacity(k_data_max + 1);

        for k in 0..=k_data_max {
            let f = k as f64 * df_lpmm;
            freq_data.push(f);
            let re_x = real[0][k];
            let im_x = imag[0][k];
            let re_y = real[k][0];
            let im_y = imag[k][0];
            let sag = (re_x.hypot(im_x) / dc).clamp(0.0, 1.0);
            let tan = (re_y.hypot(im_y) / dc).clamp(0.0, 1.0);
            tangential_raw.push(tan);
            sagittal_raw.push(sag);
        }
        if !tangential_raw.is_empty() {
            tangential_raw[0] = 1.0;
        }
        if !sagittal_raw.is_empty() {
            sagittal_raw[0] = 1.0;
        }

        let (frequency_axis, mut tangential) =
            resample_curve_to_range(&freq_data, &tangential_raw, requested_plot_lpmm, out_points);
        let (_, mut sagittal) =
            resample_curve_to_range(&freq_data, &sagittal_raw, requested_plot_lpmm, out_points);
        if !tangential.is_empty() {
            tangential[0] = 1.0;
        }
        if !sagittal.is_empty() {
            sagittal[0] = 1.0;
        }

        Ok(NativeMtfMapResponse {
            backend: "native-rust-mtf-map".to_string(),
            frequency_axis,
            mtf_tangential: tangential,
            mtf_sagittal: sagittal,
            nyquist_lpmm,
            message: "Native Rust MTF map completed".to_string(),
        })
    })();

    match result {
        Ok(response) => {
            emit_native_analysis_done(&app, &job_id, kind, "Native MTF map completed");
            Ok(response)
        }
        Err(err) => {
            emit_native_analysis_error(&app, &job_id, kind, &err);
            Err(err)
        }
    }
}

fn interpolate_axis_value(axis: &[f64], values: &[f64], target_x: f64) -> f64 {
    if axis.is_empty() || values.is_empty() || axis.len() != values.len() || !target_x.is_finite() {
        return 0.0;
    }

    let mut points = axis
        .iter()
        .copied()
        .zip(values.iter().copied())
        .filter(|(x, y)| x.is_finite() && y.is_finite())
        .collect::<Vec<(f64, f64)>>();
    if points.is_empty() {
        return 0.0;
    }

    points.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    if points.len() == 1 {
        return points[0].1.clamp(0.0, 1.0);
    }

    if target_x <= points[0].0 {
        return points[0].1.clamp(0.0, 1.0);
    }
    let last = points.len() - 1;
    if target_x >= points[last].0 {
        return points[last].1.clamp(0.0, 1.0);
    }

    for i in 1..points.len() {
        let (xa, ya) = points[i - 1];
        let (xb, yb) = points[i];
        if xb <= xa {
            continue;
        }
        if target_x <= xb {
            let t = (target_x - xa) / (xb - xa);
            return (ya + t * (yb - ya)).clamp(0.0, 1.0);
        }
    }

    points[last].1.clamp(0.0, 1.0)
}

fn nearest_axis_value(axis: &[f64], values: &[f64], target_x: f64) -> f64 {
    if axis.is_empty() || values.is_empty() || axis.len() != values.len() || !target_x.is_finite() {
        return 0.0;
    }
    let mut best_idx = 0usize;
    let mut best_df = f64::INFINITY;
    for (i, (&x, &y)) in axis.iter().zip(values.iter()).enumerate() {
        if !x.is_finite() || !y.is_finite() {
            continue;
        }
        let df = (x - target_x).abs();
        if df < best_df {
            best_df = df;
            best_idx = i;
        }
    }
    values
        .get(best_idx)
        .copied()
        .filter(|v| v.is_finite())
        .unwrap_or(0.0)
        .clamp(0.0, 1.0)
}

fn find_interpolation_bracket(axis: &[f64], target_x: f64) -> (Option<f64>, Option<f64>) {
    if axis.is_empty() || !target_x.is_finite() {
        return (None, None);
    }
    let mut xs = axis
        .iter()
        .copied()
        .filter(|x| x.is_finite())
        .collect::<Vec<f64>>();
    if xs.is_empty() {
        return (None, None);
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    if xs.len() == 1 {
        return (Some(xs[0]), Some(xs[0]));
    }
    if target_x <= xs[0] {
        return (Some(xs[0]), Some(xs[0]));
    }
    let last = xs.len() - 1;
    if target_x >= xs[last] {
        return (Some(xs[last]), Some(xs[last]));
    }
    for i in 1..xs.len() {
        let xa = xs[i - 1];
        let xb = xs[i];
        if xb <= xa {
            continue;
        }
        if target_x <= xb {
            return (Some(xa), Some(xb));
        }
    }
    (Some(xs[last]), Some(xs[last]))
}

fn next_power_of_two_clamped(mut n: usize, min_v: usize, max_v: usize) -> usize {
    n = n.max(1);
    let mut p = 1usize;
    while p < n && p < max_v {
        p <<= 1;
    }
    p.clamp(min_v, max_v)
}

fn resolve_mtf_fft_size(sampling_size: usize, explicit_zero_pad_to: usize, desired_plot_points: usize) -> usize {
    if explicit_zero_pad_to > 0 {
        return sampling_size.max(explicit_zero_pad_to).clamp(32, 4096);
    }
    let min_required_for_bins = 2usize.saturating_mul(desired_plot_points.saturating_sub(1));
    let target = sampling_size.max(min_required_for_bins);
    next_power_of_two_clamped(target, 32, 4096)
}

fn infer_tan_axis_from_object_rows(object_rows: &[Value], object_index: usize, axis_mode: &str) -> &'static str {
    let is_angle = axis_mode.eq_ignore_ascii_case("angle");
    let Some(obj) = object_rows.get(object_index).and_then(|v| v.as_object()) else {
        return "y";
    };
    let x = if is_angle {
        get_object_numeric(obj, &["xHeightAngle", "xFieldAngle", "xAngle", "x", "xHeight"]).unwrap_or(0.0)
    } else {
        get_object_numeric(obj, &["xHeight", "x", "xHeightAngle", "xFieldAngle", "xAngle"]).unwrap_or(0.0)
    };
    let y = if is_angle {
        get_object_numeric(obj, &["yHeightAngle", "yFieldAngle", "fieldAngle", "yAngle", "angle", "y", "yHeight"]).unwrap_or(0.0)
    } else {
        get_object_numeric(obj, &["yHeight", "y", "yHeightAngle", "yFieldAngle", "yAngle"]).unwrap_or(0.0)
    };
    if x.abs() >= y.abs() { "x" } else { "y" }
}

fn clone_optical_system_rows_with_defocus_shift_native(rows: &[Value], defocus_shift_mm: f64) -> Vec<Value> {
    let mut cloned = rows.to_vec();
    if !defocus_shift_mm.is_finite() || defocus_shift_mm.abs() < 1e-15 {
        return cloned;
    }

    let image_idx = cloned.iter().position(|row| {
        let obj = row.as_object();
        let object_type = obj
            .and_then(|o| o.get("object type"))
            .and_then(value_to_string)
            .unwrap_or_default();
        let object = obj
            .and_then(|o| o.get("object"))
            .and_then(value_to_string)
            .unwrap_or_default();
        object_type.eq_ignore_ascii_case("Image") || object.eq_ignore_ascii_case("Image")
    });

    let target_idx = match image_idx {
        Some(idx) if idx > 0 => idx - 1,
        _ if cloned.len() >= 2 => cloned.len() - 2,
        _ => 0,
    };

    if target_idx >= cloned.len() {
        return cloned;
    }

    if let Some(target_obj) = cloned[target_idx].as_object_mut() {
        let current = target_obj
            .get("thickness")
            .and_then(value_to_f64)
            .or_else(|| target_obj.get("Thickness").and_then(value_to_f64))
            .unwrap_or(0.0);
        let new_thickness = current + defocus_shift_mm;
        target_obj.insert("thickness".to_string(), Value::from(new_thickness));
    }

    cloned
}

fn infer_field_axis_mode_native(
    optical_system_rows: &[Value],
    object_rows: &[Value],
    object_index: usize,
    forced_mode: Option<&str>,
) -> String {
    if let Some(mode) = forced_mode {
        let m = mode.trim().to_ascii_lowercase();
        if m == "angle" || m == "height" {
            return m;
        }
    }

    if is_infinite_conjugate_native(optical_system_rows) {
        return "angle".to_string();
    }

    if let Some(obj) = object_rows.get(object_index).and_then(|v| v.as_object()) {
        if is_angle_object_native(obj, false) {
            return "angle".to_string();
        }
        return "height".to_string();
    }

    "angle".to_string()
}

fn clone_object_rows_with_field_axis_native(
    object_rows: &[Value],
    object_index: usize,
    axis_mode: &str,
    field_value: f64,
) -> Vec<Value> {
    let is_angle = axis_mode.eq_ignore_ascii_case("angle");
    let y = if field_value.is_finite() { field_value } else { 0.0 };

    let mut cloned = if object_rows.is_empty() {
        vec![if is_angle {
            serde_json::json!({
                "name": "AutoField0",
                "position": "Angle",
                "xHeightAngle": 0.0,
                "yHeightAngle": y,
                "x": 0.0,
                "y": y
            })
        } else {
            serde_json::json!({
                "name": "AutoField0",
                "position": "Rectangle",
                "xHeight": 0.0,
                "yHeight": y,
                "x": 0.0,
                "y": y
            })
        }]
    } else {
        object_rows.to_vec()
    };

    let idx = object_index.min(cloned.len().saturating_sub(1));
    if !cloned[idx].is_object() {
        cloned[idx] = serde_json::json!({});
    }

    // Keep x fixed for object-field sweep to match legacy TS behavior.
    let x = 0.0_f64;

    if let Some(obj) = cloned[idx].as_object_mut() {
        if is_angle {
            obj.insert("position".to_string(), Value::from("Angle"));
            obj.insert("xHeightAngle".to_string(), Value::from(x));
            obj.insert("yHeightAngle".to_string(), Value::from(y));
            obj.insert("x".to_string(), Value::from(x));
            obj.insert("y".to_string(), Value::from(y));
        } else {
            obj.insert("position".to_string(), Value::from("Rectangle"));
            obj.insert("xHeight".to_string(), Value::from(x));
            obj.insert("yHeight".to_string(), Value::from(y));
            obj.insert("x".to_string(), Value::from(x));
            obj.insert("y".to_string(), Value::from(y));
        }
    }

    cloned
}

fn run_native_opd_map_for_field_mtf_with_retry(
    app: AppHandle,
    base_req: NativeOpdMapRequest,
) -> Result<NativeOpdMapResponse, String> {
    run_native_opd_map(base_req, app)
}

fn should_retry_with_stop(error_message: &str) -> bool {
    let msg = error_message.to_ascii_lowercase();
    let strict_sampling_collapse = msg.contains("no valid opd samples") || msg.contains("trace to eval failed");
    if !msg.contains("entrance") && !strict_sampling_collapse {
        return false;
    }
    strict_sampling_collapse || msg.contains("fail") || msg.contains("unreachable") || msg.contains("pupil")
}

#[tauri::command]
pub fn run_native_through_focus_mtf_map(
    req: NativeThroughFocusMtfMapRequest,
    app: AppHandle,
) -> Result<NativeThroughFocusMtfMapResponse, String> {
    let job_id = req
        .job_id
        .clone()
        .unwrap_or_else(|| build_native_job_id("native-tfmtf"));
    let kind = "through-focus-mtf-native";

    emit_native_analysis_progress(
        &app,
        &job_id,
        kind,
        "prepare",
        "Preparing native through-focus MTF...",
        Some(5.0),
    );

    let result: Result<NativeThroughFocusMtfMapResponse, String> = (|| {
        if req.optical_system_rows.is_empty() {
            return Err("run_native_through_focus_mtf_map: opticalSystemRows is empty".to_string());
        }

        let min_mm = req.defocus_min_mm.unwrap_or(-0.1);
        let max_mm = req.defocus_max_mm.unwrap_or(0.1);
        let steps = req.steps.unwrap_or(21).clamp(3, 201) as usize;
        let target_freq_lpmm = req.target_frequency_lpmm.unwrap_or(10.0).max(0.0);
        let sampling_size = req.sampling_size.unwrap_or(256).clamp(32, 4096) as usize;
        let zero_pad_to = req.zero_pad_to.unwrap_or(0) as usize;
        let requested_fft_size = resolve_mtf_fft_size(sampling_size, zero_pad_to, 121);
        let pixel_size_um = req
            .pixel_size_um
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(1.0);
        let object_index = req.object_index.unwrap_or(0);
        let requested_pupil_sampling_mode = req
            .pupil_sampling_mode
            .as_ref()
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| s == "stop" || s == "entrance");
        let opd_display_mode = req
            .opd_display_mode
            .clone()
            .unwrap_or_else(|| "pistonTiltRemoved".to_string());

        let mut x_axis = Vec::<f64>::with_capacity(steps);
        for i in 0..steps {
            let t = if steps > 1 {
                i as f64 / (steps - 1) as f64
            } else {
                0.0
            };
            x_axis.push(min_mm + t * (max_mm - min_mm));
        }

        let mut wavelengths = req
            .wavelengths
            .iter()
            .copied()
            .filter(|w| w.is_finite() && *w > 0.0)
            .collect::<Vec<f64>>();
        wavelengths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        wavelengths.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        if wavelengths.is_empty() {
            wavelengths.push(get_primary_wavelength_um_native(&req.source_rows, 0.5876));
        }

        let total_runs = (wavelengths.len() * x_axis.len()).max(1);
        let mut completed = 0usize;

        let mut series = Vec::<NativeThroughFocusMtfSeries>::with_capacity(wavelengths.len());
        for (wi, wl) in wavelengths.iter().copied().enumerate() {
            let mut tan_vec = Vec::<f64>::with_capacity(x_axis.len());
            let mut sag_vec = Vec::<f64>::with_capacity(x_axis.len());

            for (si, defocus_mm) in x_axis.iter().enumerate() {
                let shifted_rows = clone_optical_system_rows_with_defocus_shift_native(
                    &req.optical_system_rows,
                    *defocus_mm,
                );

                let sub_job = format!("{}-w{}-s{}", job_id, (wl * 1_000_000.0).round() as i64, si);

                let opd_resp = run_native_opd_map(
                    NativeOpdMapRequest {
                        job_id: Some(sub_job.clone()),
                        optical_system_rows: shifted_rows,
                        source_rows: req.source_rows.clone(),
                        object_rows: req.object_rows.clone(),
                        object_index: Some(object_index),
                        surface_index: None,
                        grid_size: Some(sampling_size as u32),
                        wavelength_um: Some(wl),
                        pupil_radius_mm: None,
                        pupil_sampling_mode: requested_pupil_sampling_mode.clone(),
                        opd_display_mode: Some(opd_display_mode.clone()),
                    },
                    app.clone(),
                )?;

                let s = sampling_size;
                let mut grid_opd = vec![vec![0.0_f64; s]; s];
                let mut pupil_mask = vec![vec![false; s]; s];

                for iy in 0..s {
                    let row_display = opd_resp.display_opd_grid.get(iy);
                    let row_raw = opd_resp.raw_opd_grid.get(iy);
                    for ix in 0..s {
                        let raw_cell = row_raw.and_then(|r| r.get(ix)).and_then(|v| *v);
                        let Some(v_raw_waves) = raw_cell else {
                            continue;
                        };
                        if !v_raw_waves.is_finite() {
                            continue;
                        }

                        let v_display_waves = row_display
                            .and_then(|r| r.get(ix))
                            .and_then(|v| *v)
                            .filter(|v| v.is_finite());
                        let v_waves = v_display_waves.unwrap_or(v_raw_waves);

                        pupil_mask[iy][ix] = true;
                        grid_opd[iy][ix] = v_waves * wl;
                    }
                }

                let psf_resp = run_native_psf_map(
                    NativePsfMapRequest {
                        job_id: Some(sub_job.clone()),
                        grid_opd,
                        pupil_mask,
                        grid_amplitude: vec![],
                        wavelength_um: wl,
                        pixel_size_um: Some(pixel_size_um),
                        remove_tilt: Some(false),
                        zero_pad_to: Some(requested_fft_size as u32),
                        recenter_if_wrapped: Some(false),
                    },
                    app.clone(),
                )?;

                let mtf_resp = run_native_mtf_map(
                    NativeMtfMapRequest {
                        job_id: Some(sub_job),
                        psf_data: psf_resp.psf_data,
                        pixel_size_um,
                        // Compute beyond target frequency to avoid endpoint-clamp bias
                        // when extracting the value at target_freq_lpmm.
                        max_frequency_lpmm: Some((target_freq_lpmm * 2.0).max(1.0)),
                        points: Some(121),
                    },
                    app.clone(),
                )?;

                let tan = interpolate_axis_value(
                    &mtf_resp.frequency_axis,
                    &mtf_resp.mtf_tangential,
                    target_freq_lpmm,
                );
                let sag = interpolate_axis_value(
                    &mtf_resp.frequency_axis,
                    &mtf_resp.mtf_sagittal,
                    target_freq_lpmm,
                );
                tan_vec.push(tan);
                sag_vec.push(sag);

                completed += 1;
                let progress = 10.0 + (completed as f64 / total_runs as f64) * 85.0;
                emit_native_analysis_progress(
                    &app,
                    &job_id,
                    kind,
                    "compute",
                    &format!(
                        "Computing TF-MTF: λ={:.1}nm ({}/{}), step {}/{}",
                        wl * 1000.0,
                        wi + 1,
                        wavelengths.len(),
                        si + 1,
                        x_axis.len()
                    ),
                    Some(progress),
                );
            }

            series.push(NativeThroughFocusMtfSeries {
                wavelength_um: wl,
                label: format!("{:.1}nm", wl * 1000.0),
                mtf_tangential: tan_vec,
                mtf_sagittal: sag_vec,
            });
        }

        Ok(NativeThroughFocusMtfMapResponse {
            backend: "native-rust-through-focus-mtf".to_string(),
            x_axis,
            series,
            message: "Native Rust Through-Focus MTF completed".to_string(),
        })
    })();

    match result {
        Ok(response) => {
            emit_native_analysis_done(&app, &job_id, kind, "Native through-focus MTF completed");
            Ok(response)
        }
        Err(err) => {
            emit_native_analysis_error(&app, &job_id, kind, &err);
            Err(err)
        }
    }
}

#[tauri::command]
pub fn run_native_field_mtf_map(
    req: NativeFieldMtfMapRequest,
    app: AppHandle,
) -> Result<NativeFieldMtfMapResponse, String> {
    let job_id = req
        .job_id
        .clone()
        .unwrap_or_else(|| build_native_job_id("native-field-mtf"));
    let kind = "field-mtf-native";

    emit_native_analysis_progress(
        &app,
        &job_id,
        kind,
        "prepare",
        "Preparing native object MTF...",
        Some(5.0),
    );

    let result: Result<NativeFieldMtfMapResponse, String> = (|| {
        if req.optical_system_rows.is_empty() {
            return Err("run_native_field_mtf_map: opticalSystemRows is empty".to_string());
        }

        let normalized_optical_rows = req
            .optical_system_rows
            .iter()
            .map(normalize_coord_trans_row)
            .collect::<Vec<Value>>();
        let object_index = req.object_index.unwrap_or(0);
        let axis_mode = infer_field_axis_mode_native(
            &normalized_optical_rows,
            &req.object_rows,
            object_index,
            req.field_axis_mode.as_deref(),
        );
        let requested_pupil_sampling_mode = req
            .pupil_sampling_mode
            .as_ref()
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| s == "stop" || s == "entrance");
        let field_min_raw = req.field_min.unwrap_or(0.0);
        let field_max_raw = req.field_max.unwrap_or(10.0);
        let field_min = field_min_raw.min(field_max_raw);
        let field_max = field_min_raw.max(field_max_raw);
        let steps = req.steps.unwrap_or(21).clamp(3, 201) as usize;
        let first_frequency_lpmm = req.first_frequency_lpmm.unwrap_or(10.0).max(0.0);
        let second_frequency_lpmm = req.second_frequency_lpmm.unwrap_or(30.0).max(0.0);
        let sampling_size = req.sampling_size.unwrap_or(256).clamp(32, 4096) as usize;
        let zero_pad_to = req.zero_pad_to.unwrap_or(0) as usize;
        let requested_fft_size = resolve_mtf_fft_size(sampling_size, zero_pad_to, 121);
        let pixel_size_um = req
            .pixel_size_um
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(1.0);
        let opd_display_mode = req
            .opd_display_mode
            .clone()
            .unwrap_or_else(|| "pistonTiltRemoved".to_string());

        let mut x_axis = Vec::<f64>::with_capacity(steps);
        for i in 0..steps {
            let t = if steps > 1 {
                i as f64 / (steps - 1) as f64
            } else {
                0.0
            };
            x_axis.push(field_min + t * (field_max - field_min));
        }

        let mut wavelengths = req
            .wavelengths
            .iter()
            .copied()
            .filter(|w| w.is_finite() && *w > 0.0)
            .collect::<Vec<f64>>();
        wavelengths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        wavelengths.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        if wavelengths.is_empty() {
            wavelengths.push(get_primary_wavelength_um_native(&req.source_rows, 0.5876));
        }

        let total_runs = (wavelengths.len() * x_axis.len()).max(1);
        let mut completed = 0usize;

        let mut series = Vec::<NativeFieldMtfSeries>::with_capacity(wavelengths.len());
        for wl in wavelengths {
            let mut meridional_first = Vec::<f64>::with_capacity(x_axis.len());
            let mut sagittal_first = Vec::<f64>::with_capacity(x_axis.len());
            let mut meridional_second = Vec::<f64>::with_capacity(x_axis.len());
            let mut sagittal_second = Vec::<f64>::with_capacity(x_axis.len());
            let mut field_diagnostics = Vec::<NativeFieldMtfPointDiagnostic>::with_capacity(x_axis.len());

            for (si, field_axis_value) in x_axis.iter().enumerate() {
                let object_rows = clone_object_rows_with_field_axis_native(
                    &req.object_rows,
                    object_index,
                    &axis_mode,
                    *field_axis_value,
                );

                let sub_job = format!(
                    "{}-w{}-s{}",
                    job_id,
                    (wl * 1_000_000.0).round() as i64,
                    si
                );

                let primary_mode = if let Some(forced_mode) = requested_pupil_sampling_mode.as_deref() {
                    Some(forced_mode)
                } else if axis_mode.eq_ignore_ascii_case("angle") {
                    // Keep sampling mode consistent from on-axis to off-axis
                    // to avoid first-step discontinuity in Object MTF.
                    Some("entrance")
                } else {
                    None
                };
                let is_forced_mode = requested_pupil_sampling_mode.is_some();

                let base_opd_req = NativeOpdMapRequest {
                    job_id: Some(sub_job.clone()),
                    optical_system_rows: req.optical_system_rows.clone(),
                    source_rows: req.source_rows.clone(),
                    object_rows: object_rows.clone(),
                    object_index: Some(object_index),
                    surface_index: None,
                    grid_size: Some(sampling_size as u32),
                    wavelength_um: Some(wl),
                    pupil_radius_mm: None,
                    pupil_sampling_mode: primary_mode.map(|m| m.to_string()),
                    opd_display_mode: Some(opd_display_mode.clone()),
                };

                let mut opd_resp = match run_native_opd_map_for_field_mtf_with_retry(
                    app.clone(),
                    base_opd_req.clone(),
                ) {
                    Ok(resp) => resp,
                    Err(primary_err) => {
                        let mut errors = vec![format!(
                            "{}={}"
                            , primary_mode.unwrap_or("auto")
                            , primary_err
                        )];

                        let mut fallback_success: Option<NativeOpdMapResponse> = None;
                        if !is_forced_mode {
                            let fallback_modes: Vec<&str> = if primary_mode == Some("entrance") {
                                if should_retry_with_stop(&primary_err) { vec!["stop"] } else { vec![] }
                            } else if primary_mode == Some("stop") {
                                vec!["entrance"]
                            } else {
                                vec!["entrance", "stop"]
                            };

                            for fallback_mode in fallback_modes {
                                let mut fallback_req = base_opd_req.clone();
                                fallback_req.pupil_sampling_mode = Some(fallback_mode.to_string());
                                match run_native_opd_map_for_field_mtf_with_retry(app.clone(), fallback_req) {
                                    Ok(resp) => {
                                        fallback_success = Some(resp);
                                        break;
                                    }
                                    Err(err) => errors.push(format!("{}={}", fallback_mode, err)),
                                }
                            }
                        }

                        if let Some(resp) = fallback_success {
                            resp
                        } else {
                            let on_axis = axis_mode.eq_ignore_ascii_case("angle") && field_axis_value.abs() <= 1.0e-12;
                            if on_axis {
                                let finite_object_rows = clone_object_rows_with_field_axis_native(
                                    &req.object_rows,
                                    object_index,
                                    "height",
                                    0.0,
                                );
                                let finite_primary_mode = requested_pupil_sampling_mode.as_deref();
                                let mut finite_req = base_opd_req.clone();
                                finite_req.object_rows = finite_object_rows;
                                finite_req.object_index = Some(object_index);
                                finite_req.pupil_sampling_mode = finite_primary_mode.map(|m| m.to_string());

                                match run_native_opd_map_for_field_mtf_with_retry(app.clone(), finite_req.clone()) {
                                    Ok(resp) => resp,
                                    Err(finite_primary_err) => {
                                        errors.push(format!(
                                            "finite-{}={}"
                                            , finite_primary_mode.unwrap_or("auto")
                                            , finite_primary_err
                                        ));

                                        if !is_forced_mode {
                                            let finite_fallback_modes: Vec<&str> = if finite_primary_mode == Some("entrance") {
                                                vec!["stop"]
                                            } else if finite_primary_mode == Some("stop") {
                                                vec!["entrance"]
                                            } else {
                                                vec!["entrance", "stop"]
                                            };

                                            let mut finite_success: Option<NativeOpdMapResponse> = None;
                                            for fallback_mode in finite_fallback_modes {
                                                let mut finite_fallback_req = finite_req.clone();
                                                finite_fallback_req.pupil_sampling_mode = Some(fallback_mode.to_string());
                                                match run_native_opd_map_for_field_mtf_with_retry(app.clone(), finite_fallback_req) {
                                                    Ok(resp) => {
                                                        finite_success = Some(resp);
                                                        break;
                                                    }
                                                    Err(err) => errors.push(format!("finite-{}={}", fallback_mode, err)),
                                                }
                                            }
                                            if let Some(resp) = finite_success {
                                                resp
                                            } else {
                                                return Err(errors.join(" ; "));
                                            }
                                        } else {
                                            return Err(errors.join(" ; "));
                                        }
                                    }
                                }
                            } else {
                                return Err(errors.join(" ; "));
                            }
                        }
                    }
                };

                let eval_point = |opd: &NativeOpdMapResponse, job_suffix: &str| -> Result<(f64, f64, f64, f64, Option<f64>, Option<f64>, Option<f64>, Option<f64>), String> {
                    let s = sampling_size;
                    let mut grid_opd = vec![vec![0.0_f64; s]; s];
                    let mut pupil_mask = vec![vec![false; s]; s];

                    for iy in 0..s {
                        let row_display = opd.display_opd_grid.get(iy);
                        let row_raw = opd.raw_opd_grid.get(iy);
                        for ix in 0..s {
                            let raw_cell = row_raw.and_then(|r| r.get(ix)).and_then(|v| *v);
                            let Some(v_raw_waves) = raw_cell else {
                                continue;
                            };
                            if !v_raw_waves.is_finite() {
                                continue;
                            }

                            let v_display_waves = row_display
                                .and_then(|r| r.get(ix))
                                .and_then(|v| *v)
                                .filter(|v| v.is_finite());
                            let v_waves = v_display_waves.unwrap_or(v_raw_waves);

                            pupil_mask[iy][ix] = true;
                            grid_opd[iy][ix] = v_waves * wl;
                        }
                    }

                    let psf_resp = run_native_psf_map(
                        NativePsfMapRequest {
                            job_id: Some(format!("{}-{}", sub_job, job_suffix)),
                            grid_opd,
                            pupil_mask,
                            grid_amplitude: vec![],
                            wavelength_um: wl,
                            pixel_size_um: Some(pixel_size_um),
                            remove_tilt: Some(false),
                            zero_pad_to: Some(requested_fft_size as u32),
                            recenter_if_wrapped: Some(false),
                        },
                        app.clone(),
                    )?;

                    let mtf_resp = run_native_mtf_map(
                        NativeMtfMapRequest {
                            job_id: Some(format!("{}-{}", sub_job, job_suffix)),
                            psf_data: psf_resp.psf_data,
                            pixel_size_um,
                            max_frequency_lpmm: Some((first_frequency_lpmm.max(second_frequency_lpmm) * 2.0).max(1.0)),
                            points: Some(121),
                        },
                        app.clone(),
                    )?;

                    let tan_axis = infer_tan_axis_from_object_rows(&object_rows, object_index, &axis_mode);
                    let (tan_vals, sag_vals) = if tan_axis == "x" {
                        (&mtf_resp.mtf_sagittal, &mtf_resp.mtf_tangential)
                    } else {
                        (&mtf_resp.mtf_tangential, &mtf_resp.mtf_sagittal)
                    };

                    // Keep native Object MTF extraction consistent with TS field sweep,
                    // which samples the nearest frequency bin from the computed MTF trace.
                    let first_m = nearest_axis_value(&mtf_resp.frequency_axis, tan_vals, first_frequency_lpmm);
                    let first_s = nearest_axis_value(&mtf_resp.frequency_axis, sag_vals, first_frequency_lpmm);
                    let second_m = nearest_axis_value(&mtf_resp.frequency_axis, tan_vals, second_frequency_lpmm);
                    let second_s = nearest_axis_value(&mtf_resp.frequency_axis, sag_vals, second_frequency_lpmm);

                    let (first_lo, first_hi) = find_interpolation_bracket(&mtf_resp.frequency_axis, first_frequency_lpmm);
                    let (second_lo, second_hi) = find_interpolation_bracket(&mtf_resp.frequency_axis, second_frequency_lpmm);
                    Ok((first_m, first_s, second_m, second_s, first_lo, first_hi, second_lo, second_hi))
                };

                let chosen_opd = opd_resp;
                let chosen = eval_point(&chosen_opd, "a")?;

                let first_m = chosen.0;
                let first_s = chosen.1;
                let second_m = chosen.2;
                let second_s = chosen.3;
                let first_lo = chosen.4;
                let first_hi = chosen.5;
                let second_lo = chosen.6;
                let second_hi = chosen.7;

                meridional_first.push(first_m);
                sagittal_first.push(first_s);
                meridional_second.push(second_m);
                sagittal_second.push(second_s);
                field_diagnostics.push(NativeFieldMtfPointDiagnostic {
                    field_value: *field_axis_value,
                    effective_pupil_sampling_mode: chosen_opd.pupil_sampling_mode.clone(),
                    used_object_position: Some(chosen_opd.used_object_position.clone()),
                    target_surface_index: chosen_opd.target_surface,
                    used_object_index: chosen_opd.used_object_index,
                    opd_sample_count: chosen_opd.sample_count,
                    opd_hit_count: chosen_opd.hit_count,
                    opd_hit_rate: if chosen_opd.sample_count > 0 {
                        chosen_opd.hit_count as f64 / chosen_opd.sample_count as f64
                    } else {
                        0.0
                    },
                    first_frequency_lpmm,
                    first_bracket_low_lpmm: first_lo,
                    first_bracket_high_lpmm: first_hi,
                    first_value_meridional: first_m,
                    first_value_sagittal: first_s,
                    second_frequency_lpmm,
                    second_bracket_low_lpmm: second_lo,
                    second_bracket_high_lpmm: second_hi,
                    second_value_meridional: second_m,
                    second_value_sagittal: second_s,
                });
                completed += 1;
                let progress = 10.0 + (completed as f64 / total_runs as f64) * 85.0;
                emit_native_analysis_progress(
                    &app,
                    &job_id,
                    kind,
                    "compute",
                    &format!(
                        "Computing Object MTF: λ={:.1}nm, step {}/{}",
                        wl * 1000.0,
                        si + 1,
                        x_axis.len()
                    ),
                    Some(progress),
                );
            }

            series.push(NativeFieldMtfSeries {
                wavelength_um: wl,
                label: format!("{:.1}nm", wl * 1000.0),
                meridional_first,
                sagittal_first,
                meridional_second,
                sagittal_second,
                field_diagnostics,
            });
        }

        Ok(NativeFieldMtfMapResponse {
            backend: "native-rust-field-mtf".to_string(),
            x_axis,
            axis_mode,
            series,
            message: "Native Rust Object MTF completed".to_string(),
        })
    })();

    match result {
        Ok(response) => {
            emit_native_analysis_done(&app, &job_id, kind, "Native object MTF completed");
            Ok(response)
        }
        Err(err) => {
            emit_native_analysis_error(&app, &job_id, kind, &err);
            Err(err)
        }
    }
}

fn interpolate_curve_y(x_vals: &[f64], y_vals: &[f64], x: f64) -> Option<f64> {
    if x_vals.is_empty() || y_vals.len() != x_vals.len() || !x.is_finite() {
        return None;
    }
    let x0 = x_vals[0];
    let x_last = x_vals[x_vals.len() - 1];
    if !x0.is_finite() || !x_last.is_finite() {
        return None;
    }
    if x <= x0 {
        let y = y_vals[0];
        return if y.is_finite() { Some(y) } else { None };
    }
    if x >= x_last {
        let y = y_vals[y_vals.len() - 1];
        return if y.is_finite() { Some(y) } else { None };
    }

    for i in 1..x_vals.len() {
        let xa = x_vals[i - 1];
        let xb = x_vals[i];
        if !xa.is_finite() || !xb.is_finite() || xb <= xa {
            continue;
        }
        if x <= xb {
            let ya = y_vals[i - 1];
            let yb = y_vals[i];
            if !ya.is_finite() || !yb.is_finite() {
                return None;
            }
            let t = (x - xa) / (xb - xa);
            return Some(ya + t * (yb - ya));
        }
    }
    None
}

fn resample_curve_to_range(
    src_x: &[f64],
    src_y: &[f64],
    axis_max_lpmm: f64,
    point_count: usize,
) -> (Vec<f64>, Vec<f64>) {
    if src_x.is_empty()
        || src_y.len() != src_x.len()
        || !axis_max_lpmm.is_finite()
        || axis_max_lpmm <= 0.0
    {
        return (src_x.to_vec(), src_y.to_vec());
    }

    let count = point_count.max(2);
    let src_max = src_x[src_x.len() - 1];
    let mut out_x = Vec::with_capacity(count);
    let mut out_y = Vec::with_capacity(count);

    for i in 0..count {
        let t = if count > 1 {
            i as f64 / (count - 1) as f64
        } else {
            0.0
        };
        let x = axis_max_lpmm * t;
        out_x.push(x);

        if src_max.is_finite() && x > src_max + 1e-12 {
            out_y.push(0.0);
        } else {
            let y = interpolate_curve_y(src_x, src_y, x).unwrap_or(0.0);
            out_y.push(y.clamp(0.0, 1.0));
        }
    }

    if !out_y.is_empty() {
        out_y[0] = 1.0;
    }
    (out_x, out_y)
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
        false,
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

#[tauri::command]
pub fn run_native_transverse_aberration(
    req: NativeTransverseAberrationRequest,
) -> Result<NativeTransverseAberrationResponse, String> {
    if req.optical_system_rows.is_empty() {
        return Err("run_native_transverse_aberration: opticalSystemRows is empty".to_string());
    }

    let rows: Vec<Value> = req
        .optical_system_rows
        .iter()
        .map(normalize_coord_trans_row)
        .collect();
    if rows.is_empty() {
        return Err("run_native_transverse_aberration: normalized rows are empty".to_string());
    }

    let surface_data = calculate_surface_data(&rows);
    if surface_data.len() != rows.len() {
        return Err("run_native_transverse_aberration: failed to calculate surface origins".to_string());
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

    let ring_count = req.ring_count.unwrap_or(10).clamp(1, 64) as usize;
    let traced_rays_req = req.ray_count.unwrap_or(51).clamp(9, 10001) as usize;

    let pattern_owned = req
        .pattern
        .unwrap_or_else(|| "cross".to_string())
        .trim()
        .to_lowercase();
    let pattern = if pattern_owned == "grid" {
        "grid"
    } else if pattern_owned == "annular" {
        "annular"
    } else {
        "cross"
    };

    let wavelength_mode = req
        .wavelength_mode
        .unwrap_or_else(|| "primary".to_string());

    let requested_wavelength = req.wavelength.filter(|w| w.is_finite() && *w > 0.0);
    let source_rows_effective = if let Some(wl) = requested_wavelength {
        vec![serde_json::json!({
            "id": "NativeTransverseSource",
            "name": "NativeTransverseSource",
            "wavelength": wl,
            "color": "#9ACD32",
            "isPrimary": true,
            "intensity": 1
        })]
    } else {
        req.source_rows.clone()
    };

    let primary_wavelength = requested_wavelength
        .unwrap_or_else(|| get_primary_wavelength_um_native(&source_rows_effective, 0.5876));

    let infinite_conjugate = is_infinite_conjugate_native(&rows);
    let mut object_rows = req.object_rows.clone();
    if object_rows.is_empty() {
        let fallback = if infinite_conjugate {
            serde_json::json!({"name":"AutoField0","position":"Angle","xHeightAngle":0.0,"yHeightAngle":0.0})
        } else {
            serde_json::json!({"name":"AutoField0","position":"Rectangle","xHeight":0.0,"yHeight":0.0})
        };
        object_rows.push(fallback);
    }

    let generated_series = build_native_object_ray_series(
        &rows,
        &surface_data,
        &object_rows,
        target_surface_index,
        traced_rays_req,
        pattern,
        ring_count,
        &source_rows_effective,
        &wavelength_mode,
        false,
    );
    if generated_series.is_empty() {
        return Err("run_native_transverse_aberration: failed to generate native rays".to_string());
    }

    let stop_radius = estimate_stop_radius_mm(&rows).max(1.0e-6);
    let pupil_radius = estimate_entrance_radius_mm(&rows).clamp(0.01, 500.0);
    let mirror_sign = distortion_mirror_sign(&rows);

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
    let mut meridional_data = Vec::<NativeTransverseAberrationSeries>::new();
    let mut sagittal_data = Vec::<NativeTransverseAberrationSeries>::new();
    let mut processed_series_count = 0usize;

    for (series_label, _series_color, has_field_angle, rays, wavelength_um) in generated_series {
        if rays.is_empty() {
            continue;
        }

        if wavelength_mode.eq_ignore_ascii_case("primary")
            && (wavelength_um - primary_wavelength).abs() > 1.0e-6
        {
            continue;
        }

        let packed_target = match build_packed_meta(&rows, &surface_data, target_surface_index, wavelength_um) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let packed_stop = match build_packed_meta(&rows, &surface_data, stop_surface_index, wavelength_um) {
            Ok(p) => p,
            Err(_) => continue,
        };

        let chief = rays.iter().find(|r| r.is_chief).unwrap_or(&rays[0]);
        let chief_vec = [
            chief.start_p.x,
            chief.start_p.y,
            chief.start_p.z,
            chief.dir.x,
            chief.dir.y,
            chief.dir.z,
        ];

        let chief_target_hit = match trace_target_with_packed_native(chief_vec, target_surface_index, &packed_target) {
            Some(hit) => hit,
            None => continue,
        };
        let chief_stop_hit = trace_target_with_packed_native(chief_vec, stop_surface_index, &packed_stop)
            .unwrap_or(chief_target_hit);

        let chief_u =
            (chief_stop_hit.0 - stop_surface.origin[0]) * stop_plane_u[0]
            + (chief_stop_hit.1 - stop_surface.origin[1]) * stop_plane_u[1]
            + (chief_stop_hit.2 - stop_surface.origin[2]) * stop_plane_u[2];
        let chief_v =
            (chief_stop_hit.0 - stop_surface.origin[0]) * stop_plane_v[0]
            + (chief_stop_hit.1 - stop_surface.origin[1]) * stop_plane_v[1]
            + (chief_stop_hit.2 - stop_surface.origin[2]) * stop_plane_v[2];

        let mut mer_points = Vec::<NativeTransverseAberrationPoint>::new();
        let mut sag_points = Vec::<NativeTransverseAberrationPoint>::new();

        for ray in &rays {
            let ray_vec = [
                ray.start_p.x,
                ray.start_p.y,
                ray.start_p.z,
                ray.dir.x,
                ray.dir.y,
                ray.dir.z,
            ];

            let Some(target_hit) = trace_target_with_packed_native(ray_vec, target_surface_index, &packed_target) else {
                continue;
            };

            let stop_hit = trace_target_with_packed_native(ray_vec, stop_surface_index, &packed_stop)
                .unwrap_or(target_hit);

            let ru =
                (stop_hit.0 - stop_surface.origin[0]) * stop_plane_u[0]
                + (stop_hit.1 - stop_surface.origin[1]) * stop_plane_u[1]
                + (stop_hit.2 - stop_surface.origin[2]) * stop_plane_u[2];
            let rv =
                (stop_hit.0 - stop_surface.origin[0]) * stop_plane_v[0]
                + (stop_hit.1 - stop_surface.origin[1]) * stop_plane_v[1]
                + (stop_hit.2 - stop_surface.origin[2]) * stop_plane_v[2];

            let du = ru - chief_u;
            let dv = rv - chief_v;
            let is_meridional = du.abs() <= dv.abs();

            let denom = if stop_radius.is_finite() && stop_radius > 1.0e-9 {
                stop_radius
            } else {
                let local = du.abs().max(dv.abs());
                if local > 1.0e-9 { local } else { 1.0 }
            };

            let pupil_coordinate = if is_meridional { dv / denom } else { du / denom };
            let transverse_aberration = if is_meridional {
                (target_hit.1 - chief_target_hit.1) * mirror_sign
            } else {
                (target_hit.0 - chief_target_hit.0) * mirror_sign
            };

            let point = NativeTransverseAberrationPoint {
                pupil_coordinate,
                transverse_aberration,
                is_full_success: true,
                is_partial: false,
            };

            if is_meridional {
                mer_points.push(point);
            } else {
                sag_points.push(point);
            }
        }

        if mer_points.is_empty() && sag_points.is_empty() {
            continue;
        }

        mer_points.sort_by(|a, b| {
            a.pupil_coordinate
                .partial_cmp(&b.pupil_coordinate)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        sag_points.sort_by(|a, b| {
            a.pupil_coordinate
                .partial_cmp(&b.pupil_coordinate)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

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

        let field_setting = NativeAstigmatismFieldSetting {
            display_name,
            y: field_axis,
            position,
        };

        field_settings.push(NativeAstigmatismFieldSetting {
            display_name: field_setting.display_name.clone(),
            y: field_setting.y,
            position: field_setting.position.clone(),
        });

        meridional_data.push(NativeTransverseAberrationSeries {
            field_setting: NativeAstigmatismFieldSetting {
                display_name: field_setting.display_name.clone(),
                y: field_setting.y,
                position: field_setting.position.clone(),
            },
            points: mer_points,
            has_offset: false,
            offset_method: None,
            zero_aberration_position: None,
        });
        sagittal_data.push(NativeTransverseAberrationSeries {
            field_setting,
            points: sag_points,
            has_offset: false,
            offset_method: None,
            zero_aberration_position: None,
        });

        processed_series_count += 1;
    }

    if processed_series_count == 0 {
        return Err("run_native_transverse_aberration: no valid series produced".to_string());
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

    let mut metadata = Map::new();
    metadata.insert("rayCount".to_string(), Value::from(traced_rays_req as i64));
    metadata.insert("ringCount".to_string(), Value::from(ring_count as i64));
    metadata.insert("pattern".to_string(), Value::from(pattern.to_string()));
    metadata.insert("fieldCount".to_string(), Value::from(field_settings.len() as i64));
    metadata.insert("seriesCount".to_string(), Value::from(processed_series_count as i64));
    metadata.insert("wavelength".to_string(), Value::from(primary_wavelength));
    metadata.insert("infiniteConjugate".to_string(), Value::from(infinite_conjugate));

    Ok(NativeTransverseAberrationResponse {
        backend: "native-rust-transverse-aberration".to_string(),
        wavelength: primary_wavelength,
        target_surface: target_surface_index,
        stop_surface: stop_surface_index,
        stop_radius,
        pupil_radius,
        is_finite_system: !infinite_conjugate,
        field_settings,
        meridional_data,
        sagittal_data,
        metadata,
        message: "Native Rust transverse aberration compute completed".to_string(),
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
    preserve_pupil_shape: bool,
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
                preserve_pupil_shape,
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

fn distortion_is_mirror_row(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let material = obj
        .get("material")
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();
    let row_type = obj
        .get("type")
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();
    let block_type = obj
        .get("_blockType")
        .or_else(|| obj.get("blockType"))
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();
    let surf_type = obj
        .get("surfType")
        .or_else(|| obj.get("surfaceType"))
        .or_else(|| obj.get("type"))
        .and_then(value_to_string)
        .unwrap_or_default()
        .to_lowercase();

    material == "mirror" || row_type == "mirror" || block_type == "mirror" || surf_type == "mirror"
}

fn distortion_mirror_sign(rows: &[Value]) -> f64 {
    let mirror_count = rows.iter().filter(|row| distortion_is_mirror_row(row)).count();
    if mirror_count % 2 == 1 { -1.0 } else { 1.0 }
}

fn distortion_default_source_rows(wavelength: f64) -> Vec<Value> {
    vec![serde_json::json!({
        "id": "NativeDistortionSource",
        "name": "NativeDistortionSource",
        "wavelength": wavelength,
        "color": "#22c55e",
        "isPrimary": true,
        "intensity": 1
    })]
}

fn distortion_parse_field_index(label: &str) -> Option<usize> {
    let marker = "Field-";
    let pos = label.find(marker)?;
    let start = pos + marker.len();
    let digits: String = label[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<usize>().ok()
}

fn distortion_estimate_focal_length_mm(
    rows: &[Value],
    source_rows: &[Value],
    surface_index: usize,
    mirror_sign: f64,
) -> Option<f64> {
    let theta_deg = 0.1_f64;
    let theta_rad = theta_deg * PI / 180.0;
    let object_rows = vec![serde_json::json!({
        "id": "Field-0",
        "name": "Field-0",
        "position": "Angle",
        "xHeightAngle": 0.0,
        "yHeightAngle": theta_deg,
        "x": 0.0,
        "y": theta_deg
    })];
    let req = NativeSpotRaytraceRequest {
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows.to_vec(),
        object_rows,
        surface_index: Some(surface_index),
        ray_count: Some(11),
        ring_count: Some(1),
        pattern: Some("cross".to_string()),
        wavelength_mode: Some("primary".to_string()),
        ray_series: Vec::new(),
    };
    let response = run_native_spot_raytrace(req).ok()?;
    let series = response.series.iter().find(|s| distortion_parse_field_index(&s.label) == Some(0))?;
    let chief = series.chief_point_um.as_ref()?;
    let y_mm = (chief.y_um / 1000.0) * mirror_sign;
    if !y_mm.is_finite() || theta_rad.abs() < 1e-12 {
        return None;
    }
    let focal = y_mm / theta_rad.tan();
    if focal.is_finite() && focal.abs() > 1e-9 {
        Some(focal)
    } else {
        None
    }
}

fn distortion_estimate_height_magnification(
    rows: &[Value],
    source_rows: &[Value],
    surface_index: usize,
    mirror_sign: f64,
) -> Option<f64> {
    let h_obj = 1.0_f64;
    let object_rows = vec![serde_json::json!({
        "id": "Field-0",
        "name": "Field-0",
        "position": "Rectangle",
        "xHeight": 0.0,
        "yHeight": h_obj,
        "x": 0.0,
        "y": h_obj
    })];
    let req = NativeSpotRaytraceRequest {
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows.to_vec(),
        object_rows,
        surface_index: Some(surface_index),
        ray_count: Some(11),
        ring_count: Some(1),
        pattern: Some("cross".to_string()),
        wavelength_mode: Some("primary".to_string()),
        ray_series: Vec::new(),
    };
    let response = run_native_spot_raytrace(req).ok()?;
    let series = response.series.iter().find(|s| distortion_parse_field_index(&s.label) == Some(0))?;
    let chief = series.chief_point_um.as_ref()?;
    let y_mm = (chief.y_um / 1000.0) * mirror_sign;
    if !y_mm.is_finite() {
        return None;
    }
    Some(y_mm / h_obj)
}

fn run_native_distortion_impl(
    req: NativeDistortionRequest,
) -> Result<NativeDistortionResponse, String> {
    if req.optical_system_rows.is_empty() {
        return Err("run_native_distortion: opticalSystemRows is empty".to_string());
    }
    if req.field_samples.is_empty() {
        return Err("run_native_distortion: fieldSamples is empty".to_string());
    }

    let rows: Vec<Value> = req
        .optical_system_rows
        .iter()
        .map(normalize_coord_trans_row)
        .collect();
    if rows.is_empty() {
        return Err("run_native_distortion: normalized rows are empty".to_string());
    }

    let surface_index = req
        .surface_index
        .unwrap_or_else(|| rows.len().saturating_sub(1))
        .min(rows.len().saturating_sub(1));
    let height_mode = req.height_mode.unwrap_or(false);
    let wavelength = req
        .wavelength
        .filter(|w| w.is_finite() && *w > 0.0)
        .unwrap_or_else(|| get_primary_wavelength_um_native(&req.source_rows, 0.5876));

    let mut source_rows = if req.source_rows.is_empty() {
        distortion_default_source_rows(wavelength)
    } else {
        req.source_rows.clone()
    };
    if source_rows.is_empty() {
        source_rows = distortion_default_source_rows(wavelength);
    }

    let mirror_sign = distortion_mirror_sign(&rows);
    let finite = !is_infinite_conjugate_native(&rows);
    let focal_length = distortion_estimate_focal_length_mm(&rows, &source_rows, surface_index, mirror_sign)
        .ok_or_else(|| "run_native_distortion: failed to estimate focal length".to_string())?;
    let magnification = if height_mode && finite {
        distortion_estimate_height_magnification(&rows, &source_rows, surface_index, mirror_sign)
            .unwrap_or(-1.0)
    } else {
        -1.0
    };

    let object_distance = rows
        .first()
        .and_then(|row| {
            get_field(row, "thickness")
                .or_else(|| get_field(row, "distance"))
                .and_then(value_to_f64)
        })
        .unwrap_or(0.0);

    let object_rows: Vec<Value> = req
        .field_samples
        .iter()
        .enumerate()
        .map(|(idx, sample)| {
            if height_mode {
                serde_json::json!({
                    "id": format!("Field-{}", idx),
                    "name": format!("Field-{}", idx),
                    "position": "Rectangle",
                    "xHeight": 0.0,
                    "yHeight": *sample,
                    "x": 0.0,
                    "y": *sample,
                })
            } else if finite {
                let theta_rad = *sample * PI / 180.0;
                let h_object = object_distance * theta_rad.tan();
                serde_json::json!({
                    "id": format!("Field-{}", idx),
                    "name": format!("Field-{}", idx),
                    "position": "Rectangle",
                    "xHeight": 0.0,
                    "yHeight": h_object,
                    "x": 0.0,
                    "y": h_object,
                })
            } else {
                serde_json::json!({
                    "id": format!("Field-{}", idx),
                    "name": format!("Field-{}", idx),
                    "position": "Angle",
                    "xHeightAngle": 0.0,
                    "yHeightAngle": *sample,
                    "x": 0.0,
                    "y": *sample,
                })
            }
        })
        .collect();

    let spot_response = run_native_spot_raytrace(NativeSpotRaytraceRequest {
        optical_system_rows: rows.clone(),
        source_rows,
        object_rows,
        surface_index: Some(surface_index),
        ray_count: Some(11),
        ring_count: Some(1),
        pattern: Some("cross".to_string()),
        wavelength_mode: Some("primary".to_string()),
        ray_series: Vec::new(),
    })?;

    let mut real_heights: Vec<Option<f64>> = vec![None; req.field_samples.len()];
    for series in &spot_response.series {
        let Some(idx) = distortion_parse_field_index(&series.label) else {
            continue;
        };
        if idx >= real_heights.len() {
            continue;
        }
        if let Some(chief) = &series.chief_point_um {
            let y_mm = (chief.y_um / 1000.0) * mirror_sign;
            if y_mm.is_finite() {
                real_heights[idx] = Some(y_mm.abs());
            }
        }
    }

    let mut ideal_heights = Vec::<f64>::with_capacity(req.field_samples.len());
    let mut distortion = Vec::<Option<f64>>::with_capacity(req.field_samples.len());
    let mut distortion_percent = Vec::<Option<f64>>::with_capacity(req.field_samples.len());

    for (idx, sample) in req.field_samples.iter().enumerate() {
        let h_ideal = if height_mode {
            if finite {
                magnification * *sample
            } else {
                *sample
            }
        } else {
            focal_length * ((*sample) * PI / 180.0).tan()
        };
        ideal_heights.push(h_ideal);

        let d = if h_ideal.abs() < 1e-12 {
            Some(0.0)
        } else if let Some(h_real) = real_heights[idx] {
            Some((h_real - h_ideal) / h_ideal)
        } else {
            None
        };
        distortion.push(d);
        distortion_percent.push(d.map(|v| v * 100.0));
    }

    let mut meta = Map::new();
    meta.insert("wavelength".to_string(), Value::from(wavelength));
    meta.insert("focalLength".to_string(), Value::from(focal_length));
    meta.insert("finiteSystem".to_string(), Value::from(finite));
    meta.insert("heightMode".to_string(), Value::from(height_mode));
    meta.insert("magnification".to_string(), Value::from(magnification));
    meta.insert("mirrorSign".to_string(), Value::from(mirror_sign));

    Ok(NativeDistortionResponse {
        backend: "native-rust-distortion".to_string(),
        field_values: req.field_samples,
        ideal_heights,
        real_heights,
        distortion,
        distortion_percent,
        meta,
        message: "Native Rust distortion completed".to_string(),
    })
}

#[tauri::command]
pub async fn run_native_distortion(
    req: NativeDistortionRequest,
) -> Result<NativeDistortionResponse, String> {
    tauri::async_runtime::spawn_blocking(move || run_native_distortion_impl(req))
        .await
        .map_err(|e| format!("run_native_distortion: task join error: {}", e))?
}

fn distortion_derive_max_field_angle(object_rows: &[Value]) -> f64 {
    if object_rows.is_empty() {
        return 20.0;
    }
    let mut max_angle = 0.0_f64;
    for row in object_rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let candidates = [
            "yFieldAngle",
            "yAngle",
            "fieldAngle",
            "xFieldAngle",
            "xAngle",
            "xHeightAngle",
            "yHeightAngle",
        ];
        for key in candidates {
            if let Some(val) = obj.get(key).and_then(value_to_f64) {
                if val.is_finite() {
                    max_angle = max_angle.max(val.abs());
                }
            }
        }
    }
    if max_angle > 0.0 { max_angle } else { 20.0 }
}

fn run_native_grid_distortion_impl(
    req: NativeGridDistortionRequest,
) -> Result<NativeGridDistortionResponse, String> {
    if req.optical_system_rows.is_empty() {
        return Err("run_native_grid_distortion: opticalSystemRows is empty".to_string());
    }

    let rows: Vec<Value> = req
        .optical_system_rows
        .iter()
        .map(normalize_coord_trans_row)
        .collect();
    if rows.is_empty() {
        return Err("run_native_grid_distortion: normalized rows are empty".to_string());
    }

    let grid_size = req.grid_size.unwrap_or(20).clamp(2, 200) as usize;
    let surface_index = req
        .surface_index
        .unwrap_or_else(|| rows.len().saturating_sub(1))
        .min(rows.len().saturating_sub(1));
    let wavelength = req
        .wavelength
        .filter(|w| w.is_finite() && *w > 0.0)
        .unwrap_or_else(|| get_primary_wavelength_um_native(&req.source_rows, 0.5876));
    let max_field_angle = distortion_derive_max_field_angle(&req.object_rows);
    let mirror_sign = distortion_mirror_sign(&rows);
    let finite = !is_infinite_conjugate_native(&rows);

    let mut source_rows = if req.source_rows.is_empty() {
        distortion_default_source_rows(wavelength)
    } else {
        req.source_rows.clone()
    };
    if source_rows.is_empty() {
        source_rows = distortion_default_source_rows(wavelength);
    }

    let focal_length = distortion_estimate_focal_length_mm(&rows, &source_rows, surface_index, mirror_sign)
        .ok_or_else(|| "run_native_grid_distortion: failed to estimate focal length".to_string())?;
    let max_image_height = focal_length * (max_field_angle * PI / 180.0).tan();
    let step = (2.0 * max_image_height) / (grid_size as f64 - 1.0);

    let object_distance = rows
        .first()
        .and_then(|row| {
            get_field(row, "thickness")
                .or_else(|| get_field(row, "distance"))
                .and_then(value_to_f64)
        })
        .unwrap_or(0.0);

    let mut ideal_x = Vec::<f64>::with_capacity(grid_size * grid_size);
    let mut ideal_y = Vec::<f64>::with_capacity(grid_size * grid_size);
    let mut object_rows = Vec::<Value>::with_capacity(grid_size * grid_size);

    for i in 0..grid_size {
        let h_image_y = -max_image_height + i as f64 * step;
        let theta_y_rad = (h_image_y / focal_length).atan();
        let theta_y = theta_y_rad * 180.0 / PI;
        for j in 0..grid_size {
            let h_image_x = -max_image_height + j as f64 * step;
            let theta_x_rad = (h_image_x / focal_length).atan();
            let theta_x = theta_x_rad * 180.0 / PI;

            ideal_x.push(h_image_x);
            ideal_y.push(h_image_y);
            let idx = i * grid_size + j;
            if finite {
                let h_obj_x = object_distance * theta_x_rad.tan();
                let h_obj_y = object_distance * theta_y_rad.tan();
                object_rows.push(serde_json::json!({
                    "id": format!("Field-{}", idx),
                    "name": format!("Field-{}", idx),
                    "position": "Rectangle",
                    "xHeight": h_obj_x,
                    "yHeight": h_obj_y,
                    "x": h_obj_x,
                    "y": h_obj_y,
                }));
            } else {
                object_rows.push(serde_json::json!({
                    "id": format!("Field-{}", idx),
                    "name": format!("Field-{}", idx),
                    "position": "Angle",
                    "xHeightAngle": theta_x,
                    "yHeightAngle": theta_y,
                    "x": theta_x,
                    "y": theta_y,
                }));
            }
        }
    }

    let spot_response = run_native_spot_raytrace(NativeSpotRaytraceRequest {
        optical_system_rows: rows,
        source_rows,
        object_rows,
        surface_index: Some(surface_index),
        ray_count: Some(11),
        ring_count: Some(1),
        pattern: Some("cross".to_string()),
        wavelength_mode: Some("primary".to_string()),
        ray_series: Vec::new(),
    })?;

    let mut real_x = vec![None; ideal_x.len()];
    let mut real_y = vec![None; ideal_y.len()];
    for series in &spot_response.series {
        let Some(idx) = distortion_parse_field_index(&series.label) else {
            continue;
        };
        if idx >= real_x.len() {
            continue;
        }
        if let Some(chief) = &series.chief_point_um {
            let x_mm = (chief.x_um / 1000.0) * mirror_sign;
            let y_mm = (chief.y_um / 1000.0) * mirror_sign;
            if x_mm.is_finite() && y_mm.is_finite() {
                real_x[idx] = Some(x_mm);
                real_y[idx] = Some(y_mm);
            }
        }
    }

    let mut meta = Map::new();
    meta.insert("wavelength".to_string(), Value::from(wavelength));
    meta.insert("focalLength".to_string(), Value::from(focal_length));
    meta.insert("finiteSystem".to_string(), Value::from(finite));
    meta.insert("mirrorSign".to_string(), Value::from(mirror_sign));

    Ok(NativeGridDistortionResponse {
        backend: "native-rust-grid-distortion".to_string(),
        ideal_x,
        ideal_y,
        real_x,
        real_y,
        grid_size,
        max_field_angle,
        meta,
        message: "Native Rust grid distortion completed".to_string(),
    })
}

#[tauri::command]
pub async fn run_native_grid_distortion(
    req: NativeGridDistortionRequest,
) -> Result<NativeGridDistortionResponse, String> {
    tauri::async_runtime::spawn_blocking(move || run_native_grid_distortion_impl(req))
        .await
        .map_err(|e| format!("run_native_grid_distortion: task join error: {}", e))?
}

fn lca_find_image_surface_index(rows: &[Value]) -> usize {
    for i in (0..rows.len()).rev() {
        let Some(obj) = rows[i].as_object() else {
            continue;
        };
        let surf_type = obj
            .get("surfType")
            .or_else(|| obj.get("type"))
            .or_else(|| obj.get("surfaceType"))
            .and_then(value_to_string)
            .unwrap_or_default()
            .to_lowercase();
        if surf_type == "image" {
            return i;
        }
    }
    rows.len().saturating_sub(1)
}

fn lca_select_image_height_mm(
    series: &NativeSpotSeries,
    chief_ray_definition: &str,
    mirror_sign: f64,
) -> Option<f64> {
    let mode = chief_ray_definition.to_lowercase();
    if mode.starts_with("beam-midpoint") {
        if series.points.is_empty() {
            return None;
        }
        let mut min_y = f64::INFINITY;
        let mut max_y = f64::NEG_INFINITY;
        for p in &series.points {
            if !p.y_um.is_finite() {
                continue;
            }
            if p.y_um < min_y {
                min_y = p.y_um;
            }
            if p.y_um > max_y {
                max_y = p.y_um;
            }
        }
        if !min_y.is_finite() || !max_y.is_finite() {
            return None;
        }
        return Some(((min_y + max_y) * 0.5 / 1000.0) * mirror_sign);
    }

    if mode.starts_with("beam-centroid") {
        if series.points.is_empty() {
            return None;
        }
        let mut sum = 0.0_f64;
        let mut count = 0usize;
        for p in &series.points {
            if p.y_um.is_finite() {
                sum += p.y_um;
                count += 1;
            }
        }
        if count == 0 {
            return None;
        }
        return Some(((sum / count as f64) / 1000.0) * mirror_sign);
    }

    series
        .chief_point_um
        .as_ref()
        .map(|chief| (chief.y_um / 1000.0) * mirror_sign)
}

fn lca_fill_missing_linear(field_values: &[f64], values: &mut [Option<f64>]) {
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

fn run_native_magnification_chromatic_aberration_impl(
    req: NativeMagnificationChromaticAberrationRequest,
) -> Result<NativeMagnificationChromaticAberrationResponse, String> {
    if req.optical_system_rows.is_empty() {
        return Err("run_native_magnification_chromatic_aberration: opticalSystemRows is empty".to_string());
    }
    if req.field_samples.is_empty() {
        return Err("run_native_magnification_chromatic_aberration: fieldSamples is empty".to_string());
    }

    let rows: Vec<Value> = req
        .optical_system_rows
        .iter()
        .map(normalize_coord_trans_row)
        .collect();
    if rows.is_empty() {
        return Err("run_native_magnification_chromatic_aberration: normalized rows are empty".to_string());
    }

    let image_surface_index = req
        .surface_index
        .unwrap_or_else(|| lca_find_image_surface_index(&rows))
        .min(rows.len().saturating_sub(1));

    let mut field_values: Vec<f64> = req
        .field_samples
        .iter()
        .copied()
        .filter(|v| v.is_finite())
        .collect();
    field_values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    field_values.dedup_by(|a, b| (*a - *b).abs() < 1e-12);
    if field_values.is_empty() {
        return Err("run_native_magnification_chromatic_aberration: no valid field samples".to_string());
    }

    let mut wavelengths: Vec<f64> = req
        .wavelengths
        .iter()
        .copied()
        .filter(|w| w.is_finite() && *w > 0.0)
        .collect();
    if wavelengths.is_empty() {
        let collected = collect_spot_wavelengths(&req.source_rows, "all");
        wavelengths = collected
            .iter()
            .map(|w| w.wavelength_um)
            .filter(|w| w.is_finite() && *w > 0.0)
            .collect();
    }

    let reference_wavelength = req
        .reference_wavelength
        .filter(|w| w.is_finite() && *w > 0.0)
        .unwrap_or(0.5876);
    if !wavelengths.iter().any(|w| (*w - reference_wavelength).abs() < 1e-9) {
        wavelengths.push(reference_wavelength);
    }
    wavelengths.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    wavelengths.dedup_by(|a, b| (*a - *b).abs() < 1e-12);

    let chief_ray_definition = req
        .chief_ray_definition
        .unwrap_or_else(|| "stop-center".to_string());
    let height_mode = req.height_mode.unwrap_or(false);
    let mirror_sign = distortion_mirror_sign(&rows);
    let finite = !is_infinite_conjugate_native(&rows);
    let object_distance = rows
        .first()
        .and_then(|row| {
            get_field(row, "thickness")
                .or_else(|| get_field(row, "distance"))
                .and_then(value_to_f64)
        })
        .unwrap_or(0.0);

    let object_rows: Vec<Value> = field_values
        .iter()
        .enumerate()
        .map(|(idx, sample)| {
            if height_mode {
                serde_json::json!({
                    "id": format!("Field-{}", idx),
                    "name": format!("Field-{}", idx),
                    "position": "Rectangle",
                    "xHeight": 0.0,
                    "yHeight": *sample,
                    "x": 0.0,
                    "y": *sample,
                })
            } else if finite {
                let theta_rad = *sample * PI / 180.0;
                let h_obj = object_distance * theta_rad.tan();
                serde_json::json!({
                    "id": format!("Field-{}", idx),
                    "name": format!("Field-{}", idx),
                    "position": "Rectangle",
                    "xHeight": 0.0,
                    "yHeight": h_obj,
                    "x": 0.0,
                    "y": h_obj,
                })
            } else {
                serde_json::json!({
                    "id": format!("Field-{}", idx),
                    "name": format!("Field-{}", idx),
                    "position": "Angle",
                    "xHeightAngle": 0.0,
                    "yHeightAngle": *sample,
                    "x": 0.0,
                    "y": *sample,
                })
            }
        })
        .collect();

    let mut wavelength_heights = Vec::<(f64, Vec<Option<f64>>)>::new();

    for wl in &wavelengths {
        let source_rows = distortion_default_source_rows(*wl);
        let spot_response = run_native_spot_raytrace(NativeSpotRaytraceRequest {
            optical_system_rows: rows.clone(),
            source_rows,
            object_rows: object_rows.clone(),
            surface_index: Some(image_surface_index),
            ray_count: Some(101),
            ring_count: Some(1),
            pattern: Some("cross".to_string()),
            wavelength_mode: Some("primary".to_string()),
            ray_series: Vec::new(),
        })?;

        let mut image_heights = vec![None; field_values.len()];
        for series in &spot_response.series {
            let Some(idx) = distortion_parse_field_index(&series.label) else {
                continue;
            };
            if idx >= image_heights.len() {
                continue;
            }
            image_heights[idx] = lca_select_image_height_mm(series, &chief_ray_definition, mirror_sign);
        }

        wavelength_heights.push((*wl, image_heights));
    }

    let reference_heights = wavelength_heights
        .iter()
        .find(|(wl, _)| (*wl - reference_wavelength).abs() < 1e-9)
        .map(|(_, h)| h.clone())
        .ok_or_else(|| "run_native_magnification_chromatic_aberration: failed to compute reference wavelength".to_string())?;

    let mut data_by_wavelength = Vec::<NativeMagnificationChromaticAberrationSeries>::new();
    for (wl, image_heights) in wavelength_heights {
        let mut displacements = vec![None; field_values.len()];
        for i in 0..field_values.len() {
            displacements[i] = match (image_heights[i], reference_heights[i]) {
                (Some(h), Some(r)) if h.is_finite() && r.is_finite() => Some(h - r),
                _ => None,
            };
        }
        lca_fill_missing_linear(&field_values, &mut displacements);

        data_by_wavelength.push(NativeMagnificationChromaticAberrationSeries {
            wavelength: wl,
            displacements,
            image_heights,
        });
    }

    let mut meta = Map::new();
    meta.insert("finiteSystem".to_string(), Value::from(finite));
    meta.insert("heightMode".to_string(), Value::from(height_mode));
    meta.insert("chiefRayDefinition".to_string(), Value::from(chief_ray_definition));
    meta.insert("mirrorSign".to_string(), Value::from(mirror_sign));

    Ok(NativeMagnificationChromaticAberrationResponse {
        backend: "native-rust-lateral-chromatic-aberration".to_string(),
        field_values: field_values.clone(),
        height_mode,
        reference_wavelength,
        image_surface_index,
        data_by_wavelength,
        meta,
        message: "Native Rust lateral chromatic aberration completed".to_string(),
    })
}

#[tauri::command]
pub async fn run_native_magnification_chromatic_aberration(
    req: NativeMagnificationChromaticAberrationRequest,
) -> Result<NativeMagnificationChromaticAberrationResponse, String> {
    tauri::async_runtime::spawn_blocking(move || run_native_magnification_chromatic_aberration_impl(req))
        .await
        .map_err(|e| format!("run_native_magnification_chromatic_aberration: task join error: {}", e))?
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

fn estimate_entrance_center_origin_native(
    rows: &[Value],
    surface_data: &[SurfaceInfo],
    stop_center: [f64; 3],
    dir_vector: [f64; 3],
) -> [f64; 3] {
    let mut first_surface_z = stop_center[2] - 20.0;
    for (i, row) in rows.iter().enumerate() {
        if is_coord_trans_row(row) || is_object_row(row) || is_gap_row(row) {
            continue;
        }
        if let Some(s) = surface_data.get(i) {
            if s.origin[2].is_finite() {
                first_surface_z = s.origin[2];
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

        let r;
        if e.abs() > tol1 {
            let mut p;
            let mut q;
            r = (x - w) * (fx - fv);
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

        let u = if d.abs() >= tol1 {
            x + d
        } else {
            x + if d > 0.0 { tol1 } else { -tol1 }
        };
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
    surface_data: &[SurfaceInfo],
    stop_center: [f64; 3],
    dir_vector: [f64; 3],
    stop_surface_index: usize,
    stop_packed: &PackedMeta,
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
        if let Some(s) = surface_data.get(i) {
            if s.origin[2].is_finite() {
                first_surface_z = s.origin[2];
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
        let hit = trace_hit_xy_with_packed(ray, stop_surface_index, stop_packed)?;
        let ex = hit[0] - stop_center[0];
        let ey = hit[1] - stop_center[1];
        let err = (ex * ex + ey * ey).sqrt();
        if err.is_finite() {
            Some(err)
        } else {
            None
        }
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
            .max(0.0)
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
    preserve_pupil_shape: bool,
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
                        pupil_u: Some(ou / sampling_radius.max(1e-9)),
                        pupil_v: Some(ov / sampling_radius.max(1e-9)),
                        is_chief: i == 0,
                    });
                }

                candidate_rays
            };

            if should_search {
                let pupil_scales: Vec<f64> = if preserve_pupil_shape {
                    vec![1.0]
                } else {
                    vec![1.0, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.085, 0.06, 0.04, 0.03, 0.02, 0.015, 0.01]
                };
                let origin_solve_modes = [true, false];
                let mut best_rays = Vec::<NativeSpotInputRay>::new();
                let mut best_hits = 0usize;
                let probe_ray_count = traced_rays_req.clamp(25, 121);
                let mut best_mode: Option<(f64, bool)> = None;
                let mut _evaluated_modes = 0usize;

                for allow_origin_solve in origin_solve_modes {
                    for scale in &pupil_scales {
                        _evaluated_modes += 1;
                        let candidate = build_candidate_rays(*scale, allow_origin_solve, probe_ray_count);
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
                            best_mode = Some((*scale, allow_origin_solve));
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
                    pupil_u: Some(ou / sampling_radius.max(1e-9)),
                    pupil_v: Some(ov / sampling_radius.max(1e-9)),
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

pub(crate) fn aspheric_sag(r: f64, radius: f64, conic: f64, coefs: &[f64; 10], mode_odd: bool) -> f64 {
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
        let aperture_limit = row_params[p + 17];
        let rect_half_w = row_params[p + 18];
        let rect_half_h = row_params[p + 19];
        let n2 = row_params[p + 20];

        if kind == 1 {
            continue;
        }
        if kind == 2 {
            if n2.is_finite() && n2 > 0.0 {
                n_cur = n2;
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
    let arm_steps = requested_per_arm;
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
    let mut has_explicit_primary = false;

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
                if !has_explicit_primary && all.len() == 1 {
                    primary = v;
                }
                let primary_flag = obj
                    .get("primary")
                    .or_else(|| obj.get("Primary"))
                    .or_else(|| obj.get("Primary Wavelength"))
                    .or_else(|| obj.get("isPrimary"));
                if let Some(flag) = primary_flag {
                    let is_primary = if let Some(b) = flag.as_bool() {
                        b
                    } else {
                        let s = value_to_string(flag).unwrap_or_default().trim().to_lowercase();
                        s.contains("primary") || s == "true" || s == "1" || s == "yes"
                    };
                    if is_primary {
                        primary = v;
                        has_explicit_primary = true;
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
