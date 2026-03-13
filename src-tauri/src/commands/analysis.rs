use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use chrono::Local;
use rustfft::{FftPlanner, num_complex::Complex};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendWavefrontGridRequest {
    pub purpose: String,
    pub field_angle_deg: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendWavefrontGridForTimeRequest {
    pub target_time_ms: f64,
    pub field_angle_deg: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridRecommendation {
    pub grid_size: u32,
    pub estimated_time_ms: u32,
    pub quality: String,
    pub point_count: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAnalysisPreviewRequest {
    pub kind: String,
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAnalysisPreviewResponse {
    pub kind: String,
    pub sample_count: usize,
    pub score: f64,
    pub message: String,
    pub summary: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAnalysisComputeRequest {
    pub kind: String,
    pub job_id: Option<String>,
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub grid_size: Option<u32>,
    pub defocus_min_mm: Option<f64>,
    pub defocus_max_mm: Option<f64>,
    pub steps: Option<u32>,
    pub surface_index: Option<usize>,
    pub ray_count: Option<u32>,
    pub ring_count: Option<u32>,
    pub scale_um: Option<f64>,
    pub wavelength_mode: Option<String>,
    pub pattern: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotPoint {
    pub x_um: f64,
    pub y_um: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotSeries {
    pub defocus_mm: f64,
    pub wavelength_label: String,
    pub color: String,
    pub points: Vec<SpotPoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotDiagramSeries {
    pub label: String,
    pub color: String,
    pub points: Vec<SpotPoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAnalysisComputeResponse {
    pub kind: String,
    pub grid_size: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opd_grid: Option<Vec<Vec<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub psf_grid: Option<Vec<Vec<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_axis: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_axis: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtf_tangential: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtf_sagittal: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtf_first_tangential: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtf_first_sagittal: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtf_second_tangential: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtf_second_sagittal: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spot_series: Option<Vec<SpotSeries>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spot_diagram_series: Option<Vec<SpotDiagramSeries>>,
    pub message: String,
    pub summary: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisProgressEvent {
    job_id: String,
    kind: String,
    phase: String,
    message: String,
    percent: Option<f64>,
    indeterminate: bool,
    done: bool,
    error: bool,
}

fn emit_analysis_progress(
    app: &AppHandle,
    job_id: &str,
    kind: &str,
    phase: &str,
    message: &str,
    percent: Option<f64>,
) {
    let payload = AnalysisProgressEvent {
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
        eprintln!("[analysis-progress] emit failed: {err}");
    }
}

fn emit_analysis_done(app: &AppHandle, job_id: &str, kind: &str, message: &str) {
    let payload = AnalysisProgressEvent {
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
        eprintln!("[analysis-progress] done emit failed: {err}");
    }
}

fn emit_analysis_error(app: &AppHandle, job_id: &str, kind: &str, message: &str) {
    let payload = AnalysisProgressEvent {
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
        eprintln!("[analysis-progress] error emit failed: {err}");
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSystemDataReportRequest {
    pub kind: String,
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub reference_focal_length: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSystemDataReportResponse {
    pub kind: String,
    pub text: String,
    pub summary: Value,
}

#[tauri::command]
pub fn recommend_wavefront_grid(req: RecommendWavefrontGridRequest) -> Result<GridRecommendation, String> {
    let field_angle = req.field_angle_deg.unwrap_or(0.0);
    let factor = field_factor(field_angle);

    let rec = match req.purpose.trim() {
        "realtime-preview" => build_recommendation(32, 150.0 * factor, "preview"),
        "interactive" => build_recommendation(64, 650.0 * factor, "interactive"),
        "high-quality" => build_recommendation(96, 1500.0 * factor, "high"),
        "export" => build_recommendation(128, 2672.0 * factor, "final"),
        other => {
            return Err(format!(
                "unsupported purpose '{other}'. expected one of: realtime-preview, interactive, high-quality, export"
            ))
        }
    };

    Ok(rec)
}

#[tauri::command]
pub fn recommend_wavefront_grid_for_time(
    req: RecommendWavefrontGridForTimeRequest,
) -> Result<GridRecommendation, String> {
    if !req.target_time_ms.is_finite() || req.target_time_ms <= 0.0 {
        return Err("targetTimeMs must be a positive finite number".to_string());
    }

    let factor = field_factor(req.field_angle_deg.unwrap_or(0.0));
    let baseline_ms = 2672.0;
    let baseline_grid = 128.0;

    let adjusted_target = req.target_time_ms / factor;
    let scale_factor = (adjusted_target / baseline_ms).sqrt();
    let mut grid = (baseline_grid * scale_factor / 16.0).round() * 16.0;
    grid = grid.clamp(16.0, 256.0);
    let grid_u = grid as u32;

    let quality = if grid_u <= 32 {
        "preview"
    } else if grid_u <= 64 {
        "interactive"
    } else if grid_u <= 96 {
        "high"
    } else {
        "final"
    };

    let estimated = baseline_ms * (grid / baseline_grid).powi(2) * factor;
    Ok(build_recommendation(grid_u, estimated, quality))
}

#[tauri::command]
pub fn run_analysis_preview(req: RunAnalysisPreviewRequest) -> Result<RunAnalysisPreviewResponse, String> {
    let kind = req.kind.trim().to_lowercase();
    if kind != "opd"
        && kind != "through-focus-spot"
        && kind != "spot-diagram"
        && kind != "spherical-aberration"
    {
        return Err(format!(
            "unsupported analysis kind '{}': expected opd|through-focus-spot|spot-diagram|spherical-aberration",
            req.kind
        ));
    }
    if req.optical_system_rows.is_empty() {
        return Err("analysis preview: opticalSystemRows is empty".to_string());
    }

    let sample_count = req.optical_system_rows.len();
    let curvature_energy = req
        .optical_system_rows
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|r| r.get("radius").or_else(|| r.get("curvature")))
        .filter_map(parse_numeric)
        .filter(|v| v.is_finite())
        .map(f64::abs)
        .sum::<f64>();

    let thickness_energy = req
        .optical_system_rows
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|r| r.get("thickness"))
        .filter_map(parse_numeric)
        .filter(|v| v.is_finite())
        .map(f64::abs)
        .sum::<f64>();

    let base = (curvature_energy + thickness_energy) / (sample_count.max(1) as f64);
    let score = match kind.as_str() {
        "opd" => (base * 0.011).max(0.0),
        _ => 0.0,
    };

    let summary = json!({
        "surfaceCount": sample_count,
        "sourceCount": req.source_rows.len(),
        "objectCount": req.object_rows.len(),
        "curvatureEnergy": curvature_energy,
        "thicknessEnergy": thickness_energy
    });

    let message = format!(
        "Rust {} preview completed: surfaces={}, score={:.6}",
        kind.to_uppercase(),
        sample_count,
        score
    );

    Ok(RunAnalysisPreviewResponse {
        kind,
        sample_count,
        score,
        message,
        summary,
    })
}

#[tauri::command]
pub async fn run_analysis_compute(
    req: RunAnalysisComputeRequest,
    app: AppHandle,
) -> Result<RunAnalysisComputeResponse, String> {
    let requested_kind = req.kind.trim().to_string();
    let kind = requested_kind.to_lowercase();
    let job_id = req
        .job_id
        .clone()
        .unwrap_or_else(|| format!("analysis-{}-{}", kind, Local::now().timestamp_millis()));

    emit_analysis_progress(
        &app,
        &job_id,
        &kind,
        "init",
        "Initializing analysis compute...",
        Some(0.0),
    );

    if kind != "opd"
        && kind != "through-focus-spot"
        && kind != "spot-diagram"
        && kind != "spherical-aberration"
    {
        let err = format!(
            "unsupported analysis kind '{}': expected opd|through-focus-spot|spot-diagram|spherical-aberration",
            requested_kind
        );
        emit_analysis_error(&app, &job_id, &kind, &err);
        return Err(err);
    }
    if req.optical_system_rows.is_empty() {
        let err = "analysis compute: opticalSystemRows is empty".to_string();
        emit_analysis_error(&app, &job_id, &kind, &err);
        return Err(err);
    }

    emit_analysis_progress(
        &app,
        &job_id,
        &kind,
        "preprocess",
        "Collecting input metrics...",
        Some(8.0),
    );

    let grid_size = req.grid_size.unwrap_or(128).clamp(32, 512);
    let metrics = collect_metrics(&req.optical_system_rows);

    let summary = json!({
        "surfaceCount": req.optical_system_rows.len(),
        "sourceCount": req.source_rows.len(),
        "objectCount": req.object_rows.len(),
        "curvatureEnergy": metrics.curvature_energy,
        "thicknessEnergy": metrics.thickness_energy,
        "aberrationScale": metrics.aberration_scale
    });

    let result = match kind.as_str() {
        "opd" => {
            emit_analysis_progress(&app, &job_id, &kind, "compute", "Building OPD grid...", Some(22.0));
            let opd_grid = build_opd_grid(grid_size as usize, &metrics);
            Ok(RunAnalysisComputeResponse {
                kind: kind.clone(),
                grid_size,
                opd_grid: Some(opd_grid),
                psf_grid: None,
                frequency_axis: None,
                x_axis: None,
                mtf_tangential: None,
                mtf_sagittal: None,
                mtf_first_tangential: None,
                mtf_first_sagittal: None,
                mtf_second_tangential: None,
                mtf_second_sagittal: None,
                spot_series: None,
                spot_diagram_series: None,
                message: format!("Rust OPD compute completed: {}x{}", grid_size, grid_size),
                summary,
            })
        }
        "through-focus-spot" => {
            let min_defocus = req.defocus_min_mm.unwrap_or(-0.1);
            let max_defocus = req.defocus_max_mm.unwrap_or(0.1);
            let steps = req.steps.unwrap_or(5).clamp(3, 61) as usize;
            let ray_count = req.ray_count.unwrap_or(501).clamp(9, 20001);
            let ring_count = req.ring_count.unwrap_or(10).clamp(1, 32);
            let scale_um = req.scale_um.unwrap_or(100.0).clamp(1.0, 5000.0);
            let pattern = req.pattern.unwrap_or_else(|| "annular".to_string());
            let wavelength_mode = req.wavelength_mode.unwrap_or_else(|| "all".to_string());
            let surface_index = req.surface_index.unwrap_or(0);

            emit_analysis_progress(
                &app,
                &job_id,
                &kind,
                "compute",
                &format!("Computing through-focus spot ({} steps)...", steps),
                Some(24.0),
            );
            let spot_series = build_through_focus_spot(
                min_defocus,
                max_defocus,
                steps,
                ray_count as usize,
                ring_count as usize,
                scale_um,
                &pattern,
                &wavelength_mode,
                &req.source_rows,
                grid_size as usize,
                &metrics,
            );

            let summary = merge_summary(
                summary,
                json!({
                    "surfaceIndex": surface_index,
                    "rayCount": ray_count,
                    "ringCount": ring_count,
                    "scaleUm": scale_um,
                    "pattern": pattern,
                    "wavelengthMode": wavelength_mode,
                    "spotSeriesCount": spot_series.len()
                }),
            );

            Ok(RunAnalysisComputeResponse {
                kind: kind.clone(),
                grid_size,
                opd_grid: None,
                psf_grid: None,
                frequency_axis: None,
                x_axis: None,
                mtf_tangential: None,
                mtf_sagittal: None,
                mtf_first_tangential: None,
                mtf_first_sagittal: None,
                mtf_second_tangential: None,
                mtf_second_sagittal: None,
                spot_series: Some(spot_series),
                spot_diagram_series: None,
                message: "Rust Through-Focus Spot compute completed".to_string(),
                summary,
            })
        }
        "spot-diagram" => {
            let ray_count = req.ray_count.unwrap_or(501).clamp(9, 20001);
            let ring_count = req.ring_count.unwrap_or(10).clamp(1, 32);
            let pattern = req.pattern.unwrap_or_else(|| "annular".to_string());
            let wavelength_mode = req.wavelength_mode.unwrap_or_else(|| "all".to_string());
            let surface_index = req.surface_index.unwrap_or(0);
            emit_analysis_progress(&app, &job_id, &kind, "compute", "Computing spot diagram...", Some(24.0));
            let spot_diagram_series = build_spot_diagram(
                ray_count as usize,
                ring_count as usize,
                &pattern,
                &wavelength_mode,
                &req.source_rows,
                grid_size as usize,
                &metrics,
            );
            let summary = merge_summary(
                summary,
                json!({
                    "surfaceIndex": surface_index,
                    "rayCount": ray_count,
                    "ringCount": ring_count,
                    "pattern": pattern,
                    "wavelengthMode": wavelength_mode,
                    "seriesCount": spot_diagram_series.len()
                }),
            );

            Ok(RunAnalysisComputeResponse {
                kind: kind.clone(),
                grid_size,
                opd_grid: None,
                psf_grid: None,
                frequency_axis: None,
                x_axis: None,
                mtf_tangential: None,
                mtf_sagittal: None,
                mtf_first_tangential: None,
                mtf_first_sagittal: None,
                mtf_second_tangential: None,
                mtf_second_sagittal: None,
                spot_series: None,
                spot_diagram_series: Some(spot_diagram_series),
                message: "Rust Spot Diagram compute completed".to_string(),
                summary,
            })
        }
        "spherical-aberration" => Err(
            "spherical-aberration rust compute is temporarily disabled until TS parity is implemented".to_string(),
        ),
        _ => Err("unsupported analysis kind".to_string()),
    };

    match result {
        Ok(response) => {
            emit_analysis_done(&app, &job_id, &kind, &response.message);
            Ok(response)
        }
        Err(err) => {
            emit_analysis_error(&app, &job_id, &kind, &err);
            Err(err)
        }
    }
}

#[tauri::command]
pub fn run_system_data_report(
    req: RunSystemDataReportRequest,
) -> Result<RunSystemDataReportResponse, String> {
    if req.optical_system_rows.is_empty() {
        return Err("system data report: opticalSystemRows is empty".to_string());
    }

    let kind = req.kind.trim().to_lowercase();
    if kind != "paraxial" && kind != "seidel" && kind != "seidel-afocal" {
        return Err(format!(
            "unsupported system-data kind '{}': expected paraxial|seidel|seidel-afocal",
            req.kind
        ));
    }

    let metrics = collect_metrics(&req.optical_system_rows);
    let wl = detect_primary_wavelength(&req.source_rows).unwrap_or(0.587_561_8);
    let stop_index = detect_stop_surface_index(&req.optical_system_rows).unwrap_or(1);
    let surface_count = req.optical_system_rows.len();
    let object_count = req.object_rows.len();

    let paraxial_trace = calculate_full_system_paraxial_trace(&req.optical_system_rows);
    let paraxial_focal = paraxial_trace
        .as_ref()
        .map(|r| r.focal_length_mm)
        .filter(|v| v.is_finite() && *v != 0.0)
        .unwrap_or_else(|| estimate_focal_length_mm(&req.optical_system_rows, &metrics));
    let ref_fl = req
        .reference_focal_length
        .filter(|v| v.is_finite() && *v != 0.0)
        .unwrap_or(paraxial_focal);

    let text = if kind == "paraxial" {
        format_paraxial_report(
            wl,
            &req.optical_system_rows,
            paraxial_trace.as_ref(),
        )
    } else if kind == "seidel" {
        format_seidel_report(
            "Seidel Coefficients (Imaging)",
            wl,
            stop_index,
            ref_fl,
            &req.optical_system_rows,
            &req.source_rows,
            false,
        )
    } else {
        format_seidel_report(
            "Seidel Coefficients (Afocal)",
            wl,
            stop_index,
            ref_fl,
            &req.optical_system_rows,
            &req.source_rows,
            true,
        )
    };

    let summary = json!({
        "kind": kind,
        "surfaceCount": surface_count,
        "objectCount": object_count,
        "sourceCount": req.source_rows.len(),
        "wavelength": wl,
        "stopSurfaceIndex": stop_index,
        "referenceFocalLength": ref_fl,
        "focalLength": paraxial_focal,
        "traceAvailable": paraxial_trace.is_some(),
        "curvatureEnergy": metrics.curvature_energy,
        "thicknessEnergy": metrics.thickness_energy,
        "aberrationScale": metrics.aberration_scale,
    });

    Ok(RunSystemDataReportResponse { kind, text, summary })
}

fn field_factor(field_angle_deg: f64) -> f64 {
    (1.0 + field_angle_deg.abs() / 30.0).max(1.0)
}

fn build_recommendation(grid_size: u32, estimated_ms: f64, quality: &str) -> GridRecommendation {
    GridRecommendation {
        grid_size,
        estimated_time_ms: estimated_ms.round().max(0.0) as u32,
        quality: quality.to_string(),
        point_count: estimate_point_count(grid_size),
    }
}

fn estimate_point_count(grid_size: u32) -> u32 {
    let total = (grid_size as f64) * (grid_size as f64);
    (total * 0.77).round() as u32
}

fn parse_numeric(v: &Value) -> Option<f64> {
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

#[derive(Debug)]
struct AnalysisMetrics {
    curvature_energy: f64,
    thickness_energy: f64,
    aberration_scale: f64,
}

#[derive(Debug, Clone)]
struct ParaxialTraceResult {
    focal_length_mm: f64,
    back_focal_length_mm: f64,
    image_distance_mm: f64,
    final_alpha: f64,
    object_distance_mm: Option<f64>,
    total_system_length_mm: f64,
}

#[derive(Debug, Clone)]
struct StopRayTraceResult {
    image_distance_mm: f64,
    final_alpha: f64,
    initial_alpha: f64,
}

#[derive(Debug, Clone)]
struct PupilEstimate {
    position_mm: f64,
    diameter_mm: f64,
    magnification: f64,
}

#[derive(Debug, Clone)]
struct SeidelSurfaceCoeff {
    surface_index: usize,
    object_label: String,
    i: f64,
    ii: f64,
    iii: f64,
    p: f64,
    iv: f64,
    v: f64,
    lca: f64,
    tca: f64,
}

#[derive(Debug, Clone)]
struct SeidelTotals {
    i: f64,
    ii: f64,
    iii: f64,
    p: f64,
    iv: f64,
    v: f64,
    lca: f64,
    tca: f64,
}

#[derive(Debug, Clone)]
struct RaySurfaceState {
    surface_index: usize,
    height: f64,
    alpha_before: f64,
    alpha_after: f64,
    n_before: f64,
    n_after: f64,
}

fn collect_metrics(rows: &[Value]) -> AnalysisMetrics {
    let curvature_energy = rows
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|r| r.get("radius").or_else(|| r.get("curvature")).or_else(|| r.get("Radius")))
        .filter_map(parse_numeric)
        .filter(|v| v.is_finite())
        .map(f64::abs)
        .sum::<f64>();

    let thickness_energy = rows
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|r| r.get("thickness").or_else(|| r.get("Thickness")))
        .filter_map(parse_numeric)
        .filter(|v| v.is_finite())
        .map(f64::abs)
        .sum::<f64>();

    let n = rows.len().max(1) as f64;
    let normalized = (curvature_energy / (1.0 + n * 100.0)) + (thickness_energy / (1.0 + n * 10.0));
    let aberration_scale = (normalized * 0.015).clamp(0.02, 1.5);

    AnalysisMetrics {
        curvature_energy,
        thickness_energy,
        aberration_scale,
    }
}

fn build_opd_grid(size: usize, metrics: &AnalysisMetrics) -> Vec<Vec<f64>> {
    let mut grid = vec![vec![0.0; size]; size];
    if size < 2 {
        return grid;
    }

    let center = (size as f64 - 1.0) * 0.5;
    for (iy, row) in grid.iter_mut().enumerate() {
        let y = (iy as f64 - center) / center;
        for (ix, v) in row.iter_mut().enumerate() {
            let x = (ix as f64 - center) / center;
            let r2 = x * x + y * y;
            if r2 > 1.0 {
                *v = 0.0;
                continue;
            }

            let astig = x * x - y * y;
            let coma = x * (x * x + y * y - 0.5);
            let spherical = r2 * r2 - r2 * 0.5;
            *v = metrics.aberration_scale * (0.42 * astig + 0.28 * coma + 0.30 * spherical);
        }
    }
    grid
}

fn fft2d_in_place(data: &mut [Vec<Complex<f64>>], inverse: bool) {
    let n = data.len();
    if n == 0 {
        return;
    }
    let mut planner = FftPlanner::<f64>::new();
    let fft_row = if inverse {
        planner.plan_fft_inverse(n)
    } else {
        planner.plan_fft_forward(n)
    };

    for row in data.iter_mut() {
        fft_row.process(row);
    }

    let fft_col = if inverse {
        planner.plan_fft_inverse(n)
    } else {
        planner.plan_fft_forward(n)
    };

    let mut col = vec![Complex::new(0.0, 0.0); n];
    for x in 0..n {
        for y in 0..n {
            col[y] = data[y][x];
        }
        fft_col.process(&mut col);
        for y in 0..n {
            data[y][x] = col[y];
        }
    }

    if inverse {
        let scale = (n * n) as f64;
        if scale > 0.0 {
            for row in data.iter_mut() {
                for v in row.iter_mut() {
                    *v /= scale;
                }
            }
        }
    }
}

fn fftshift_real(input: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let n = input.len();
    if n == 0 {
        return vec![];
    }
    let mut out = vec![vec![0.0; n]; n];
    let half = n / 2;
    for y in 0..n {
        for x in 0..n {
            let yy = (y + half) % n;
            let xx = (x + half) % n;
            out[yy][xx] = input[y][x];
        }
    }
    out
}

fn build_psf_grid_from_opd_with_phase_scale(opd: &[Vec<f64>], phase_scale: f64) -> Vec<Vec<f64>> {
    let n = opd.len();
    if n == 0 || opd[0].len() != n {
        return vec![];
    }

    let center = (n as f64 - 1.0) * 0.5;
    let mut pupil = vec![vec![Complex::new(0.0, 0.0); n]; n];

    for y in 0..n {
        let yn = if center > 0.0 { (y as f64 - center) / center } else { 0.0 };
        for x in 0..n {
            let xn = if center > 0.0 { (x as f64 - center) / center } else { 0.0 };
            let r2 = xn * xn + yn * yn;
            if r2 <= 1.0 {
                let phase = std::f64::consts::TAU * opd[y][x] * phase_scale;
                pupil[y][x] = Complex::from_polar(1.0, phase);
            }
        }
    }

    fft2d_in_place(&mut pupil, false);

    let mut psf = vec![vec![0.0; n]; n];
    let mut sum = 0.0;
    for y in 0..n {
        for x in 0..n {
            let intensity = pupil[y][x].norm_sqr();
            psf[y][x] = intensity;
            sum += intensity;
        }
    }

    if sum > 0.0 {
        for row in psf.iter_mut() {
            for v in row.iter_mut() {
                *v /= sum;
            }
        }
    }

    fftshift_real(&psf)
}

fn build_opd_variant(
    base_opd: &[Vec<f64>],
    defocus_mm: f64,
    defocus_scale_mm: f64,
    field_norm: f64,
    metrics: &AnalysisMetrics,
) -> Vec<Vec<f64>> {
    let n = base_opd.len();
    if n == 0 || base_opd[0].len() != n {
        return vec![];
    }

    let center = (n as f64 - 1.0) * 0.5;
    let mut out = base_opd.to_vec();

    let defocus_gain = (0.5 + metrics.aberration_scale * 0.8).clamp(0.2, 1.8);
    let coma_gain = (0.08 + metrics.aberration_scale * 0.22).clamp(0.04, 0.45);
    let astig_gain = (0.06 + metrics.aberration_scale * 0.18).clamp(0.03, 0.35);
    let df = if defocus_scale_mm.abs() > 1e-12 {
        defocus_mm / defocus_scale_mm
    } else {
        0.0
    };

    for y in 0..n {
        let yn = if center > 0.0 { (y as f64 - center) / center } else { 0.0 };
        for x in 0..n {
            let xn = if center > 0.0 { (x as f64 - center) / center } else { 0.0 };
            let r2 = xn * xn + yn * yn;
            if r2 > 1.0 {
                out[y][x] = 0.0;
                continue;
            }

            let defocus_term = (r2 - 0.5) * df * defocus_gain;
            let coma_term = (xn * (r2 - 0.5)) * field_norm * coma_gain;
            let astig_term = (xn * xn - yn * yn) * field_norm * astig_gain;
            out[y][x] += defocus_term + coma_term + astig_term;
        }
    }

    out
}

fn merge_summary(base: Value, extra: Value) -> Value {
    let mut merged = base;
    if let (Some(base_obj), Some(extra_obj)) = (merged.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_obj {
            base_obj.insert(k.to_string(), v.clone());
        }
    }
    merged
}

fn build_through_focus_spot(
    min_defocus: f64,
    max_defocus: f64,
    steps: usize,
    ray_count: usize,
    ring_count: usize,
    scale_um: f64,
    pattern: &str,
    wavelength_mode: &str,
    source_rows: &[Value],
    grid_size: usize,
    metrics: &AnalysisMetrics,
) -> Vec<SpotSeries> {
    let mut out = Vec::<SpotSeries>::new();
    let wavelengths = collect_spot_wavelengths(source_rows, wavelength_mode);
    let center = (min_defocus + max_defocus) * 0.5;
    let span = (max_defocus - min_defocus).abs().max(1e-9);
    let rays = ray_count.clamp(9, 20001);
    let sample_size = if steps > 41 {
        grid_size.clamp(48, 96)
    } else {
        grid_size.clamp(64, 192)
    };
    let base_opd = build_opd_grid(sample_size, metrics);
    let base_pattern = build_spot_pattern_points(rays, ring_count, pattern);
    let base_scale_um = scale_um.clamp(1.0, 5000.0);
    let anisotropy_gain = (0.20 + 0.55 * metrics.aberration_scale).clamp(0.15, 1.25);

    for step in 0..steps {
        let defocus = if steps > 1 {
            min_defocus + (step as f64) * (max_defocus - min_defocus) / ((steps - 1) as f64)
        } else {
            center
        };
        let d_norm = ((defocus - center).abs() / span).clamp(0.0, 1.0);
        let df = (defocus - center) / span;
        let defocus_scale = span.max(0.02);

        for wavelength in &wavelengths {
            let wl_scale = if wavelength.wavelength_um > 0.0 {
                (wavelength.wavelength_um / wavelength.primary_wavelength_um).clamp(0.65, 1.45)
            } else {
                1.0
            };
            let opd = build_opd_variant(&base_opd, defocus - center, defocus_scale, 0.15 * df, metrics);
            let phase_scale = if wl_scale.abs() > 1e-12 { 1.0 / wl_scale } else { 1.0 };
            let psf = build_psf_grid_from_opd_with_phase_scale(&opd, phase_scale);
            let (sigma_x, sigma_y) = estimate_spot_sigma_um_from_psf(
                &psf,
                base_scale_um,
                wl_scale,
                1.0 + d_norm * (0.35 + 0.45 * metrics.aberration_scale),
                anisotropy_gain,
            );

            let coma_shift_x = base_scale_um
                * (0.01 + 0.06 * metrics.aberration_scale)
                * df
                * (wl_scale - 1.0);
            let coma_shift_y = base_scale_um
                * (0.008 + 0.04 * metrics.aberration_scale)
                * df
                * (1.0 - wl_scale);

            let points = build_spot_points_from_pattern(
                &base_pattern,
                sigma_x,
                sigma_y,
                coma_shift_x,
                coma_shift_y,
            );

            out.push(SpotSeries {
                defocus_mm: defocus,
                wavelength_label: wavelength.label.clone(),
                color: wavelength.color.clone(),
                points,
            });
        }
    }

    out
}

fn build_spot_diagram(
    ray_count: usize,
    ring_count: usize,
    pattern: &str,
    wavelength_mode: &str,
    source_rows: &[Value],
    grid_size: usize,
    metrics: &AnalysisMetrics,
) -> Vec<SpotDiagramSeries> {
    let rays = ray_count.clamp(9, 2201);
    let sample_size = grid_size.clamp(64, 192);
    let wavelengths = collect_spot_wavelengths(source_rows, wavelength_mode);
    let base_opd = build_opd_grid(sample_size, metrics);
    let base_pattern = build_spot_pattern_points(rays, ring_count, pattern);
    let spot_scale = (14.0 + metrics.aberration_scale * 54.0).clamp(4.0, 160.0);
    let anisotropy_gain = (0.18 + 0.48 * metrics.aberration_scale).clamp(0.12, 1.15);

    let mut out = Vec::<SpotDiagramSeries>::new();
    for wavelength in wavelengths {
        let wl_scale = if wavelength.wavelength_um > 0.0 {
            (wavelength.wavelength_um / wavelength.primary_wavelength_um).clamp(0.65, 1.45)
        } else {
            1.0
        };
        let phase_scale = if wl_scale.abs() > 1e-12 { 1.0 / wl_scale } else { 1.0 };
        let psf = build_psf_grid_from_opd_with_phase_scale(&base_opd, phase_scale);
        let (sigma_x, sigma_y) = estimate_spot_sigma_um_from_psf(
            &psf,
            spot_scale,
            wl_scale,
            1.0,
            anisotropy_gain,
        );
        let chroma_shift = spot_scale * 0.04 * (wl_scale - 1.0);
        let points = build_spot_points_from_pattern(&base_pattern, sigma_x, sigma_y, chroma_shift, -0.65 * chroma_shift);

        out.push(SpotDiagramSeries {
            label: wavelength.label,
            color: wavelength.color,
            points,
        });
    }

    out
}

#[derive(Debug, Clone)]
struct SpotWavelength {
    label: String,
    color: String,
    wavelength_um: f64,
    primary_wavelength_um: f64,
}

fn collect_spot_wavelengths(source_rows: &[Value], wavelength_mode: &str) -> Vec<SpotWavelength> {
    let mut all = Vec::<f64>::new();
    let mut primary = detect_primary_wavelength(source_rows).unwrap_or(0.587_561_8);

    for row in source_rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let wl = obj
            .get("wavelength")
            .or_else(|| obj.get("Wavelength"))
            .and_then(parse_numeric);
        if let Some(v) = wl {
            if v.is_finite() && v > 0.0 {
                all.push(v);
                let primary_flag = obj
                    .get("primary")
                    .or_else(|| obj.get("Primary"))
                    .or_else(|| obj.get("Primary Wavelength"));
                if let Some(flag) = primary_flag {
                    let s = value_to_lower(flag);
                    if s.contains("primary") || s == "true" || s == "1" || s == "yes" {
                        primary = v;
                    }
                }
            }
        }
    }

    if all.is_empty() {
        all = vec![0.486_132_7, primary, 0.656_272_5];
    }
    all.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    all.dedup_by(|a, b| (*a - *b).abs() < 1e-9);

    let mut result = Vec::<SpotWavelength>::new();
    if wavelength_mode.eq_ignore_ascii_case("primary") {
        result.push(SpotWavelength {
            label: "Primary".to_string(),
            color: "#2563eb".to_string(),
            wavelength_um: primary,
            primary_wavelength_um: primary,
        });
        return result;
    }

    let palette = [
        "#2563eb", "#16a34a", "#dc2626", "#7c3aed", "#ea580c", "#0891b2", "#4f46e5",
        "#0f766e", "#b91c1c", "#1d4ed8",
    ];
    for (idx, wl) in all.iter().enumerate() {
        let name = if (*wl - primary).abs() < 1e-6 {
            format!("Primary ({:.1}nm)", wl * 1000.0)
        } else {
            format!("{:.1}nm", wl * 1000.0)
        };
        result.push(SpotWavelength {
            label: name,
            color: palette[idx % palette.len()].to_string(),
            wavelength_um: *wl,
            primary_wavelength_um: primary,
        });
    }
    result
}

fn build_spot_pattern_points(ray_count: usize, ring_count: usize, pattern: &str) -> Vec<(f64, f64)> {
    let rays = ray_count.clamp(9, 20001);
    let mut points = Vec::<(f64, f64)>::with_capacity(rays);

    if pattern.eq_ignore_ascii_case("grid") {
        let side = (rays as f64).sqrt().round().max(3.0) as usize;
        for iy in 0..side {
            for ix in 0..side {
                if points.len() >= rays {
                    break;
                }
                let x = if side > 1 {
                    (ix as f64 / (side - 1) as f64) * 2.0 - 1.0
                } else {
                    0.0
                };
                let y = if side > 1 {
                    (iy as f64 / (side - 1) as f64) * 2.0 - 1.0
                } else {
                    0.0
                };
                points.push((x, y));
            }
        }
    } else {
        let rings = ring_count.max(1);
        points.push((0.0, 0.0));
        for i in 1..rays {
            let t = i as f64 / (rays as f64);
            let rho = t.sqrt();
            let ring = 1 + ((i * rings) / rays.max(1));
            let theta = std::f64::consts::TAU * t * (1.0 + ring as f64 * 0.25);
            points.push((rho * theta.cos(), rho * theta.sin()));
        }
    }

    let (mx, my) = spot_points_mean(&points);
    if mx.abs() > 1e-12 || my.abs() > 1e-12 {
        for (x, y) in points.iter_mut() {
            *x -= mx;
            *y -= my;
        }
    }
    points
}

fn build_spot_points_from_pattern(
    pattern_points: &[(f64, f64)],
    sigma_x_um: f64,
    sigma_y_um: f64,
    shift_x_um: f64,
    shift_y_um: f64,
) -> Vec<SpotPoint> {
    let mut out = Vec::<SpotPoint>::with_capacity(pattern_points.len());
    let sx = sigma_x_um.max(1e-6);
    let sy = sigma_y_um.max(1e-6);
    for (x, y) in pattern_points {
        out.push(SpotPoint {
            x_um: x * sx + shift_x_um,
            y_um: y * sy + shift_y_um,
        });
    }
    out
}

fn spot_points_mean(points: &[(f64, f64)]) -> (f64, f64) {
    if points.is_empty() {
        return (0.0, 0.0);
    }
    let mut sx = 0.0;
    let mut sy = 0.0;
    for (x, y) in points {
        sx += *x;
        sy += *y;
    }
    let n = points.len() as f64;
    (sx / n, sy / n)
}

fn estimate_spot_sigma_um_from_psf(
    psf: &[Vec<f64>],
    base_scale_um: f64,
    wavelength_scale: f64,
    defocus_scale: f64,
    anisotropy_gain: f64,
) -> (f64, f64) {
    if psf.is_empty() || psf[0].is_empty() {
        let s = (base_scale_um * wavelength_scale * defocus_scale).max(1e-6);
        return (s, s);
    }

    let n = psf.len();
    let center = (n as f64 - 1.0) * 0.5;
    let mut sum = 0.0;
    let mut mxx = 0.0;
    let mut myy = 0.0;

    for (iy, row) in psf.iter().enumerate() {
        let y = if center > 0.0 { (iy as f64 - center) / center } else { 0.0 };
        for (ix, v) in row.iter().enumerate() {
            let x = if center > 0.0 { (ix as f64 - center) / center } else { 0.0 };
            let w = (*v).max(0.0);
            sum += w;
            mxx += w * x * x;
            myy += w * y * y;
        }
    }

    if sum <= 1e-20 {
        let s = (base_scale_um * wavelength_scale * defocus_scale).max(1e-6);
        return (s, s);
    }

    let sx_norm = (mxx / sum).sqrt().clamp(1e-4, 1.0);
    let sy_norm = (myy / sum).sqrt().clamp(1e-4, 1.0);
    let spot_base = base_scale_um * wavelength_scale * defocus_scale;

    let sigma_x = (spot_base * sx_norm * (1.0 + 0.15 * anisotropy_gain)).max(1e-6);
    let sigma_y = (spot_base * sy_norm * (1.0 - 0.15 * anisotropy_gain)).max(1e-6);
    (sigma_x, sigma_y)
}

fn detect_primary_wavelength(source_rows: &[Value]) -> Option<f64> {
    let mut first_valid = None;

    for row in source_rows {
        let obj = match row.as_object() {
            Some(v) => v,
            None => continue,
        };
        let wl = obj
            .get("wavelength")
            .or_else(|| obj.get("Wavelength"))
            .and_then(parse_numeric);

        if let Some(v) = wl {
            if v.is_finite() && v > 0.0 {
                if first_valid.is_none() {
                    first_valid = Some(v);
                }

                let primary = obj
                    .get("primary")
                    .or_else(|| obj.get("Primary"))
                    .or_else(|| obj.get("Primary Wavelength"));
                if let Some(flag) = primary {
                    let s = value_to_lower(flag);
                    if s.contains("primary") || s == "true" || s == "1" || s == "yes" {
                        return Some(v);
                    }
                }
            }
        }
    }

    first_valid
}

fn detect_stop_surface_index(rows: &[Value]) -> Option<usize> {
    for (i, row) in rows.iter().enumerate() {
        let obj = match row.as_object() {
            Some(v) => v,
            None => continue,
        };
        let object_type = obj
            .get("object type")
            .or_else(|| obj.get("object"))
            .or_else(|| obj.get("Object"))
            .map(value_to_lower)
            .unwrap_or_default();
        if object_type.contains("stop") || object_type == "sto" {
            return Some(i);
        }
    }

    let mut valid = Vec::<usize>::new();
    for (i, row) in rows.iter().enumerate().skip(1).take(rows.len().saturating_sub(2)) {
        if is_image_surface(row) || is_coord_trans_surface(row) {
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

fn is_image_surface(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let object_type = obj
        .get("object type")
        .or_else(|| obj.get("object"))
        .or_else(|| obj.get("Object"))
        .map(value_to_lower)
        .unwrap_or_default();
    let comment = obj
        .get("comment")
        .or_else(|| obj.get("Comment"))
        .map(value_to_lower)
        .unwrap_or_default();
    object_type == "image" || comment == "image"
}

fn is_coord_trans_surface(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let st = obj
        .get("surfType")
        .or_else(|| obj.get("surface_type"))
        .or_else(|| obj.get("type"))
        .map(value_to_lower)
        .unwrap_or_default();
    st == "coord trans" || st == "coordinate break" || st == "ct" || st == "coordtrans"
}

fn parse_finite_numeric(v: Option<&Value>) -> Option<f64> {
    v.and_then(parse_numeric).filter(|n| n.is_finite())
}

fn get_safe_radius(row: &Value) -> f64 {
    let Some(obj) = row.as_object() else {
        return f64::INFINITY;
    };
    let r = parse_numeric(
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

fn get_safe_thickness(row: &Value) -> f64 {
    let Some(obj) = row.as_object() else {
        return 0.0;
    };

    if is_coord_trans_surface(row) {
        let gap = parse_numeric(obj.get("__cooptGapThickness").unwrap_or(&Value::Null));
        return match gap {
            Some(v) if v.is_finite() => v,
            Some(v) if v.is_infinite() => f64::INFINITY,
            _ => 0.0,
        };
    }

    let t = parse_numeric(
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

fn get_refractive_index(row: &Value) -> f64 {
    let Some(obj) = row.as_object() else {
        return 1.0;
    };

    if let Some(v) = parse_finite_numeric(
        obj.get("__cooptActualRindex")
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
        .map(value_to_lower)
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

fn is_stop_surface(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let object = obj
        .get("object")
        .or_else(|| obj.get("object type"))
        .or_else(|| obj.get("Object"))
        .map(value_to_lower)
        .unwrap_or_default();
    object == "stop" || object == "sto" || object.contains("stop")
}

fn is_mirror_surface(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let material = obj
        .get("material")
        .map(value_to_lower)
        .unwrap_or_default();
    material == "mirror"
}

fn calculate_marginal_alpha_at_stop(rows: &[Value], stop_index: usize) -> f64 {
    let stop_row = match rows.get(stop_index) {
        Some(v) => v,
        None => return 0.0,
    };
    let stop_thickness = get_safe_thickness(stop_row);
    let stop_n = get_refractive_index(stop_row);
    let effective_thickness = if stop_thickness.abs() <= 1e-15 { 1e-18 } else { stop_thickness };
    if !stop_n.is_finite() || stop_n.abs() <= 1e-12 {
        return 0.0;
    }
    1.0 / (-effective_thickness * stop_n)
}

fn trace_paraxial_ray_from_stop(rows: &[Value], stop_index: usize) -> Option<StopRayTraceResult> {
    if rows.is_empty() || stop_index >= rows.len() {
        return None;
    }

    let mut h = 1.0_f64;
    let mut alpha = calculate_marginal_alpha_at_stop(rows, stop_index);
    let initial_alpha = alpha;

    for i in (stop_index + 1)..rows.len() {
        let surface = &rows[i];
        if is_image_surface(surface) {
            break;
        }
        if is_coord_trans_surface(surface) {
            continue;
        }

        let prev_surface = rows.get(i.saturating_sub(1));
        let current_n = prev_surface.map(get_refractive_index).unwrap_or(1.0);
        let next_n = get_refractive_index(surface);
        let radius = get_safe_radius(surface);
        let thickness = get_safe_thickness(surface);

        if radius.is_finite() && radius.abs() > 1e-12 {
            let phi = (next_n - current_n) / radius;
            alpha += phi * h;
        }

        if i < rows.len().saturating_sub(2) {
            let effective_thickness = if thickness.abs() <= 1e-15 { 1e-18 } else { thickness };
            if effective_thickness > 0.0 && next_n.abs() > 1e-12 {
                h = h - effective_thickness * alpha / next_n;
            }
        }
    }

    let image_distance_mm = if alpha.abs() > 1e-10 { h / alpha } else { f64::INFINITY };

    Some(StopRayTraceResult {
        image_distance_mm,
        final_alpha: alpha,
        initial_alpha,
    })
}

fn build_reversed_system_for_entrance(rows: &[Value], stop_index: usize) -> Vec<Value> {
    let mut reversed = Vec::<Value>::new();

    for i in (0..=stop_index).rev() {
        let Some(src_obj) = rows.get(i).and_then(Value::as_object) else {
            continue;
        };
        if is_coord_trans_surface(rows.get(i).unwrap_or(&Value::Null)) {
            continue;
        }

        let mut map = src_obj.clone();

        if let Some(r) = parse_numeric(map.get("radius").unwrap_or(&Value::Null)) {
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
                map.insert("rindex".to_string(), Value::from(get_refractive_index(&prev_row)));
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

fn estimate_entrance_pupil(rows: &[Value], stop_index: usize, stop_diameter: f64) -> Option<PupilEstimate> {
    if stop_diameter <= 0.0 {
        return None;
    }

    // TS special case: stop at first optical surface => unit magnification
    if stop_index == 1 {
        return Some(PupilEstimate {
            position_mm: 0.0,
            diameter_mm: stop_diameter,
            magnification: 1.0,
        });
    }

    let reversed = build_reversed_system_for_entrance(rows, stop_index);
    if reversed.is_empty() {
        return None;
    }

    let trace = trace_paraxial_ray_from_stop(&reversed, 0)?;
    let beta = if trace.final_alpha.abs() > 1e-10 {
        trace.initial_alpha / trace.final_alpha
    } else {
        0.0
    };

    // TS equivalent sign convention: entrance position is negative of image distance-like quantity.
    // In this reduced model we reconstruct using the same alpha ratio formulation.
    let position_mm = if trace.final_alpha.abs() > 1e-10 {
        -(1.0 / trace.final_alpha)
    } else {
        0.0
    };

    Some(PupilEstimate {
        position_mm,
        diameter_mm: beta.abs() * stop_diameter,
        magnification: beta,
    })
}

fn calculate_paraxial_trace_core(rows: &[Value], initial_alpha: f64) -> Option<(f64, f64)> {
    if rows.len() < 2 {
        return None;
    }

    let mut h = 1.0_f64;
    let mut alpha = initial_alpha;
    let mut prev_n = 1.0_f64;

    for j in 1..rows.len().saturating_sub(1) {
        let row = &rows[j];
        if is_image_surface(row) {
            break;
        }
        if is_coord_trans_surface(row) {
            continue;
        }

        let radius = get_safe_radius(row);
        let thickness = get_safe_thickness(row);
        let is_stop = is_stop_surface(row);
        let is_mirror = is_mirror_surface(row);

        let next_n = if is_mirror {
            -prev_n
        } else if is_stop {
            prev_n
        } else {
            get_refractive_index(row)
        };

        let phi = if radius.is_finite() && radius.abs() > 1e-12 {
            (next_n - prev_n) / radius
        } else {
            0.0
        };
        alpha += phi * h;

        if j < rows.len().saturating_sub(2) && thickness.is_finite() && thickness > 0.0 && next_n.abs() > 1e-12 {
            h = h - thickness * alpha / next_n;
        }

        prev_n = next_n;
    }

    Some((h, alpha))
}

fn calculate_full_system_paraxial_trace(rows: &[Value]) -> Option<ParaxialTraceResult> {
    if rows.is_empty() {
        return None;
    }

    let object_thickness = rows
        .first()
        .and_then(Value::as_object)
        .and_then(|o| o.get("thickness"));
    let object_distance_mm = parse_numeric(object_thickness.unwrap_or(&Value::Null))
        .filter(|v| v.is_finite() && *v != 0.0);

    let initial_alpha = if let Some(d0) = object_distance_mm {
        -1.0 / d0
    } else {
        0.0
    };

    let (h, alpha) = calculate_paraxial_trace_core(rows, initial_alpha)?;
    let (efl_h, efl_alpha) = if object_distance_mm.is_some() {
        calculate_paraxial_trace_core(rows, 0.0).unwrap_or((h, alpha))
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
        .map(get_safe_thickness)
        .filter(|t| t.is_finite())
        .sum::<f64>();

    Some(ParaxialTraceResult {
        focal_length_mm,
        back_focal_length_mm,
        image_distance_mm,
        final_alpha: alpha,
        object_distance_mm,
        total_system_length_mm,
    })
}

fn estimate_focal_length_mm(rows: &[Value], metrics: &AnalysisMetrics) -> f64 {
    let mut signed_curvature = 0.0;
    for row in rows {
        if let Some(obj) = row.as_object() {
            if let Some(r) = obj
                .get("radius")
                .or_else(|| obj.get("Radius"))
                .or_else(|| obj.get("curvature"))
                .and_then(parse_numeric)
            {
                if r.is_finite() && r.abs() > 1e-9 {
                    signed_curvature += 1.0 / r;
                }
            }
        }
    }

    if signed_curvature.abs() > 1e-9 {
        (1.0 / signed_curvature).abs().clamp(0.5, 1.0e6)
    } else {
        (50.0 + metrics.thickness_energy * 0.1).clamp(0.5, 1.0e6)
    }
}

fn value_to_lower(v: &Value) -> String {
    match v {
        Value::String(s) => s.trim().to_lowercase(),
        Value::Bool(b) => if *b { "true".to_string() } else { "false".to_string() },
        Value::Number(n) => n.to_string().to_lowercase(),
        _ => String::new(),
    }
}

fn format_paraxial_report(
    wavelength_um: f64,
    rows: &[Value],
    trace: Option<&ParaxialTraceResult>,
) -> String {
    let now = Local::now();
    let calc_time = now.format("%Y/%-m/%-d %-H:%M:%S").to_string();

    let stop_index = detect_stop_surface_index(rows).unwrap_or(0);
    let stop_trace = trace_paraxial_ray_from_stop(rows, stop_index);
    let stop_diameter = rows
        .get(stop_index)
        .and_then(Value::as_object)
        .and_then(|o| parse_numeric(o.get("semidia").unwrap_or(&Value::Null)))
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|r| r * 2.0)
        .unwrap_or(0.0);
    let entrance = estimate_entrance_pupil(rows, stop_index, stop_diameter);

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

    let (focal_length, back_focal_length, image_distance, object_distance, total_length, beta, fno_work, fno_img, na_img, exit_pos_from_image) = if let Some(t) = trace {
        let object_distance = t
            .object_distance_mm
            .map(|v| format!("{:.6} mm", v))
            .unwrap_or_else(|| "Infinity (infinite object)".to_string());
        let beta = if let Some(d0) = t.object_distance_mm {
            if t.final_alpha.abs() > 1e-10 { (-1.0 / d0) / t.final_alpha } else { 0.0 }
        } else {
            0.0
        };
        let fno_work = if exit_pupil_diameter > 0.0 && t.image_distance_mm.is_finite() {
            t.image_distance_mm.abs() / exit_pupil_diameter
        } else {
            f64::NAN
        };
        let entrance_diameter = entrance
            .as_ref()
            .map(|v| v.diameter_mm)
            .filter(|v| v.is_finite() && *v > 1e-12)
            .unwrap_or(stop_diameter);

        let fno_img = if entrance_diameter > 0.0 && t.focal_length_mm.is_finite() {
            t.focal_length_mm.abs() / entrance_diameter
        } else {
            f64::NAN
        };
        let na_img = if fno_work.is_finite() && fno_work.abs() > 1e-12 {
            1.0 / (2.0 * fno_work)
        } else {
            f64::NAN
        };
        let exit_pos_from_image = stop_trace
            .as_ref()
            .map(|st| st.image_distance_mm - t.image_distance_mm)
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);

        (
            format!("{:.6}", t.focal_length_mm),
            format!("{:.6}", t.back_focal_length_mm),
            format!("{:.6}", t.image_distance_mm),
            object_distance,
            format!("{:.6}", t.total_system_length_mm),
            beta,
            fno_work,
            fno_img,
            na_img,
            exit_pos_from_image,
        )
    } else {
        (
            "N/A".to_string(),
            "N/A".to_string(),
            "N/A".to_string(),
            "N/A".to_string(),
            "N/A".to_string(),
            f64::NAN,
            f64::NAN,
            f64::NAN,
            f64::NAN,
            0.0_f64,
        )
    };

    [
        "=== System Data ===",
        &format!("Calculation Time: {}", calc_time),
        "",
        "=== Primary Optical System Data ===",
        &format!("Primary Wavelength:               {:.7} μm", wavelength_um),
        &format!("Focal Length (FL):                {} mm", focal_length),
        &format!("Effective Focal Length (EFL):     {} mm", focal_length),
        &format!("Back Focal Length (BFL):          {} mm", back_focal_length),
        &format!("Image Distance:                   {} mm", image_distance),
        &format!("Object Distance:                  {}", object_distance),
        &format!("Total System Length:              {} mm", total_length),
        &format!("Exit Pupil Magnification (βexp): {:.6}", exit_pupil_mag),
        &format!("Exit Pupil Diameter (ExPD):     {:.6} mm", exit_pupil_diameter),
        &format!("Paraxial Magnification:           {:.6}", if beta.is_finite() { beta } else { 0.0 }),
        &format!("Object Space F#:                  {:.6}", if fno_work.is_finite() && beta.abs() > 1e-10 { (fno_work / beta).abs() } else { 0.0_f64 }),
        &format!("Image Space F#:                   {:.6}", if fno_img.is_finite() { fno_img } else { 0.0 }),
        &format!("Paraxial Working F#:              {:.6}", if fno_work.is_finite() { fno_work } else { 0.0 }),
        &format!("Object Space NA:                  {:.6}", if na_img.is_finite() && beta.is_finite() { (na_img * beta).abs() } else { 0.0 }),
        &format!("Image Space NA:                   {:.6}", if na_img.is_finite() { na_img } else { 0.0 }),
        "",
        "=== Pupil Calculation ===",
        &format!("Exit Pupil Diameter:              {:.6} mm", exit_pupil_diameter),
        &format!("Exit Pupil Position:              {:.6} mm (from Image)", exit_pos_from_image),
        &format!("Exit Pupil Magnification:         {:.6}", exit_pupil_mag),
        &format!(
            "Entrance Pupil Position:          {:.6} mm",
            entrance.as_ref().map(|v| v.position_mm).unwrap_or(0.0)
        ),
        &format!(
            "Entrance Pupil Diameter:          {:.6} mm",
            entrance.as_ref().map(|v| v.diameter_mm).unwrap_or(stop_diameter)
        ),
        &format!(
            "Entrance Pupil Magnification:     {:.6}",
            entrance.as_ref().map(|v| v.magnification).unwrap_or(1.0)
        ),
    ]
    .join("\n")
}

fn format_seidel_report(
    title: &str,
    wavelength_um: f64,
    stop_index: usize,
    reference_focal_length: f64,
    rows: &[Value],
    source_rows: &[Value],
    afocal: bool,
) -> String {
    let wavelength_range = detect_wavelength_range(source_rows);
    let (surface_coeffs, totals) = compute_seidel_surface_coefficients(
        rows,
        stop_index,
        afocal,
        wavelength_um,
        wavelength_range,
    );

    let mut lines = Vec::<String>::new();
    lines.push(format!("{}", title));
    lines.push("=== Third-Order Aberration Coefficients ===".to_string());
    lines.push(format!("Reference Focal Length: {:.6} mm", reference_focal_length));
    lines.push(format!("Wavelength: {:.7} μm", wavelength_um));
    if let Some((w_short, w_long)) = wavelength_range {
        lines.push(format!(
            "Chromatic Aberration Wavelength Range: {:.7} μm - {:.7} μm",
            w_short, w_long
        ));
    }
    lines.push(format!("Stop Surface Index: {}", stop_index));
    lines.push(String::new());
    lines.push(format!(
        "{:>7}\t{:<6}\t{:>15}\t{:>15}\t{:>14}\t{:>14}\t{:>14}\t{:>14}\t{:>14}\t{:>14}",
        "Surface", "Object", "LCA", "TCA", "Ⅰ(SA)", "Ⅱ(COMA)", "Ⅲ(AS)", "P", "Ⅳ(Field)", "Ⅴ(DIST)"
    ));

    for coeff in surface_coeffs {
        lines.push(format!(
            "{:>7}\t{:<6}\t{:>15}\t{:>15}\t{:>14}\t{:>14}\t{:>14}\t{:>14}\t{:>14}\t{:>14}",
            coeff.surface_index,
            coeff.object_label,
            format!("{:.8}", coeff.lca),
            format!("{:.8}", coeff.tca),
            format!("{:.8}", coeff.i),
            format!("{:.8}", coeff.ii),
            format!("{:.8}", coeff.iii),
            format!("{:.8}", coeff.p),
            format!("{:.8}", coeff.iv),
            format!("{:.8}", coeff.v),
        ));
    }

    lines.push(format!(
        "{:>7}\t{:<6}\t{:>15}\t{:>15}\t{:>14}\t{:>14}\t{:>14}\t{:>14}\t{:>14}\t{:>14}",
        "TOTAL",
        "",
        format!("{:.8}", totals.lca),
        format!("{:.8}", totals.tca),
        format!("{:.8}", totals.i),
        format!("{:.8}", totals.ii),
        format!("{:.8}", totals.iii),
        format!("{:.8}", totals.p),
        format!("{:.8}", totals.iv),
        format!("{:.8}", totals.v),
    ));

    if afocal {
        let marginal = trace_ray_surface_states_with_wavelength(rows, initial_alpha_for_marginal(rows), wavelength_um);
        lines.push(String::new());
        lines.push("=== Paraxial Marginal Ray Trace Data (Normalized by Reference Focal Length) ===".to_string());
        lines.push(format!(
            "{:>7}\t{:<8}\t{:>13}\t{:>13}\t{:>13}\t{:>15}\t{:>15}",
            "Surface", "Object", "Radius", "Thickness", "Index", "Angle", "Height"
        ));
        for st in marginal {
            let row = rows.get(st.surface_index);
            let Some(r) = row else {
                continue;
            };
            if is_image_surface(r) {
                break;
            }
            if is_coord_trans_surface(r) {
                continue;
            }

            let radius = get_safe_radius(r);
            let thickness = get_safe_thickness(r);
            let index = st.n_after;
            let object_name = if st.surface_index == stop_index {
                "STOP".to_string()
            } else if is_mirror_surface(r) {
                "MIRROR".to_string()
            } else {
                r.as_object()
                    .and_then(|o| {
                        o.get("object type")
                            .or_else(|| o.get("object"))
                            .or_else(|| o.get("surf type"))
                    })
                    .and_then(Value::as_str)
                    .map(|s| s.trim().to_uppercase())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_default()
            };

            let radius_str = if radius.is_finite() {
                format!("{:.6}", radius)
            } else {
                "INF".to_string()
            };
            let thickness_str = if thickness.is_finite() {
                format!("{:.6}", thickness)
            } else {
                "INF".to_string()
            };

            lines.push(format!(
                "{:>7}\t{:<8}\t{:>13}\t{:>13}\t{:>13}\t{:>15}\t{:>15}",
                st.surface_index,
                object_name,
                radius_str,
                thickness_str,
                format!("{:.6}", index),
                format!("{:.8}", st.alpha_after),
                format!("{:.8}", st.height),
            ));
        }
    }

    if let Some((w_short, w_long)) = wavelength_range {
        let marginal_short = trace_ray_surface_states_with_wavelength(rows, initial_alpha_for_marginal(rows), w_short);
        let marginal_long = trace_ray_surface_states_with_wavelength(rows, initial_alpha_for_marginal(rows), w_long);
        append_marginal_trace_table(&mut lines, rows, stop_index, w_short, &marginal_short);
        append_marginal_trace_table(&mut lines, rows, stop_index, w_long, &marginal_long);
    }

    lines.join("\n")
}

fn append_marginal_trace_table(
    lines: &mut Vec<String>,
    rows: &[Value],
    stop_index: usize,
    wavelength_um: f64,
    states: &[RaySurfaceState],
) {
    lines.push(String::new());
    lines.push(format!(
        "=== Paraxial Marginal Ray Trace Data (Wavelength: {:.7} μm) ===",
        wavelength_um
    ));
    lines.push(format!(
        "{:>7}\t{:<8}\t{:>13}\t{:>13}\t{:>13}\t{:>15}\t{:>15}",
        "Surface", "Object", "Radius", "Thickness", "Index", "Angle", "Height"
    ));

    for st in states {
        let Some(r) = rows.get(st.surface_index) else {
            continue;
        };
        if is_image_surface(r) {
            break;
        }
        if is_coord_trans_surface(r) {
            continue;
        }

        let radius = get_safe_radius(r);
        let thickness = get_safe_thickness(r);
        let object_name = if st.surface_index == stop_index {
            "STOP".to_string()
        } else if is_mirror_surface(r) {
            "MIRROR".to_string()
        } else {
            r.as_object()
                .and_then(|o| {
                    o.get("object type")
                        .or_else(|| o.get("object"))
                        .or_else(|| o.get("surf type"))
                })
                .and_then(Value::as_str)
                .map(|s| s.trim().to_uppercase())
                .filter(|s| !s.is_empty())
                .unwrap_or_default()
        };

        let radius_str = if radius.is_finite() {
            format!("{:.6}", radius)
        } else {
            "INF".to_string()
        };
        let thickness_str = if thickness.is_finite() {
            format!("{:.6}", thickness)
        } else {
            "INF".to_string()
        };

        lines.push(format!(
            "{:>7}\t{:<8}\t{:>13}\t{:>13}\t{:>13}\t{:>15}\t{:>15}",
            st.surface_index,
            object_name,
            radius_str,
            thickness_str,
            format!("{:.6}", st.n_after),
            format!("{:.8}", st.alpha_after),
            format!("{:.8}", st.height),
        ));
    }
}

fn initial_alpha_for_marginal(rows: &[Value]) -> f64 {
    rows.first()
        .and_then(Value::as_object)
        .and_then(|o| o.get("thickness"))
        .and_then(parse_numeric)
        .filter(|v| v.is_finite() && *v != 0.0)
        .map(|d0| -1.0 / d0)
        .unwrap_or(0.0)
}

fn initial_alpha_for_chief(rows: &[Value], stop_index: usize) -> f64 {
    let stop_radius = rows
        .get(stop_index)
        .and_then(Value::as_object)
        .and_then(|o| parse_numeric(o.get("semidia").unwrap_or(&Value::Null)))
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(1.0);

    let object_distance = rows
        .first()
        .and_then(Value::as_object)
        .and_then(|o| o.get("thickness"))
        .and_then(parse_numeric)
        .filter(|v| v.is_finite() && *v != 0.0)
        .map(f64::abs)
        .unwrap_or(1000.0);

    (stop_radius / object_distance).clamp(0.0001, 0.2)
}

fn trace_ray_surface_states_with_wavelength(rows: &[Value], mut alpha: f64, wavelength_um: f64) -> Vec<RaySurfaceState> {
    let mut states = Vec::new();
    if rows.is_empty() {
        return states;
    }

    let mut prev_n = 1.0_f64;
    let mut h = 1.0_f64;

    for j in 1..rows.len() {
        let row = &rows[j];
        if is_coord_trans_surface(row) {
            continue;
        }

        let radius = get_safe_radius(row);
        let thickness = get_safe_thickness(row);
        let is_stop = is_stop_surface(row);
        let is_mirror = is_mirror_surface(row);

        let next_n = if is_mirror {
            -prev_n
        } else if is_stop {
            prev_n
        } else {
            get_refractive_index_for_wavelength(row, wavelength_um)
        };

        let phi = if radius.is_finite() && radius.abs() > 1e-12 {
            (next_n - prev_n) / radius
        } else {
            0.0
        };

        let alpha_before = alpha;
        alpha += phi * h;
        let alpha_after = alpha;

        states.push(RaySurfaceState {
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

fn compute_seidel_surface_coefficients(
    rows: &[Value],
    stop_index: usize,
    afocal: bool,
    reference_wavelength_um: f64,
    wavelength_range: Option<(f64, f64)>,
) -> (Vec<SeidelSurfaceCoeff>, SeidelTotals) {
    let marginal = trace_ray_surface_states_with_wavelength(rows, initial_alpha_for_marginal(rows), reference_wavelength_um);
    let chief = trace_ray_surface_states_with_wavelength(rows, initial_alpha_for_chief(rows, stop_index), reference_wavelength_um);
    let (short_wl, long_wl) = wavelength_range.unwrap_or((0.486_132_7, 0.656_272_5));
    let marginal_short = trace_ray_surface_states_with_wavelength(rows, initial_alpha_for_marginal(rows), short_wl);
    let marginal_long = trace_ray_surface_states_with_wavelength(rows, initial_alpha_for_marginal(rows), long_wl);

    let mut totals = SeidelTotals {
        i: 0.0,
        ii: 0.0,
        iii: 0.0,
        p: 0.0,
        iv: 0.0,
        v: 0.0,
        lca: 0.0,
        tca: 0.0,
    };
    let mut out = Vec::<SeidelSurfaceCoeff>::new();
    let scale = if afocal { 1.0 } else { 1.0 };

    for m in &marginal {
        let row = rows.get(m.surface_index).and_then(Value::as_object);
        let is_image = rows
            .get(m.surface_index)
            .map(is_image_surface)
            .unwrap_or(false);
        if is_image {
            break;
        }

        let is_gap = row
            .and_then(|o| o.get("_blockType").or_else(|| o.get("blockType")))
            .map(value_to_lower)
            .map(|s| s == "gap")
            .unwrap_or(false);
        let is_mirror = rows.get(m.surface_index).map(is_mirror_surface).unwrap_or(false);
        if is_gap && !is_mirror {
            continue;
        }

        let Some(c) = chief.iter().find(|x| x.surface_index == m.surface_index) else {
            continue;
        };

        let radius = rows
            .get(m.surface_index)
            .map(get_safe_radius)
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
        let (lca, tca) = compute_chromatic_lca_tca_for_surface(
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

        out.push(SeidelSurfaceCoeff {
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
    let a1 = parse_finite_numeric(coeffs.get("A1"))?;
    let a2 = parse_finite_numeric(coeffs.get("A2"))?;
    let a3 = parse_finite_numeric(coeffs.get("A3"))?;
    let b1 = parse_finite_numeric(coeffs.get("B1"))?;
    let b2 = parse_finite_numeric(coeffs.get("B2"))?;
    let b3 = parse_finite_numeric(coeffs.get("B3"))?;

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
    let a0 = parse_finite_numeric(coeffs.get("A0"))?;
    let a1 = parse_finite_numeric(coeffs.get("A1"))?;
    let a2 = parse_finite_numeric(coeffs.get("A2"))?;
    let a3 = parse_finite_numeric(coeffs.get("A3"))?;
    let a4 = parse_finite_numeric(coeffs.get("A4"))?;
    let a5 = parse_finite_numeric(coeffs.get("A5"))?;

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

fn get_refractive_index_for_wavelength(row: &Value, wavelength_um: f64) -> f64 {
    let Some(obj) = row.as_object() else {
        return 1.0;
    };

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

    let nd = parse_finite_numeric(
        obj.get("__cooptActualRindex")
            .or_else(|| obj.get("rindex"))
            .or_else(|| obj.get("ref index"))
            .or_else(|| obj.get("refIndex"))
            .or_else(|| obj.get("Ref Index")),
    );

    let vd = parse_finite_numeric(
        obj.get("__cooptActualAbbe")
            .or_else(|| obj.get("abbe"))
            .or_else(|| obj.get("Abbe"))
            .or_else(|| obj.get("vd"))
            .or_else(|| obj.get("Vd")),
    );

    if let Some(nd_val) = nd {
        if let Some(vd_val) = vd {
            if vd_val > 0.0 {
                return estimate_refractive_index_from_nd_vd(nd_val, vd_val, wavelength_um);
            }
        }
        if nd_val > 0.0 {
            return nd_val;
        }
    }

    get_refractive_index(row)
}

fn detect_wavelength_range(source_rows: &[Value]) -> Option<(f64, f64)> {
    if source_rows.is_empty() {
        return None;
    }

    let mut min_w = f64::INFINITY;
    let mut max_w = -f64::INFINITY;

    for row in source_rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let w = parse_numeric(
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

fn get_nd_abbe_from_row(row: Option<&Map<String, Value>>) -> (Option<f64>, Option<f64>) {
    let Some(obj) = row else {
        return (None, None);
    };

    let mut nd = parse_finite_numeric(
        obj.get("__cooptActualRindex")
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
            .and_then(|v| parse_finite_numeric(Some(v)));
    }

    let abbe = parse_finite_numeric(
        obj.get("__cooptActualAbbe")
            .or_else(|| obj.get("Abbe"))
            .or_else(|| obj.get("abbe"))
            .or_else(|| obj.get("Vd"))
            .or_else(|| obj.get("vd"))
            .or_else(|| obj.get("abbeNumber"))
            .or_else(|| obj.get("abbe_number")),
    );

    (nd, abbe)
}

fn get_dispersion_fallback(row: Option<&Map<String, Value>>) -> Option<f64> {
    let (nd, abbe) = get_nd_abbe_from_row(row);
    match (nd, abbe) {
        (Some(n), Some(v)) if v.abs() > 1e-12 => Some((n - 1.0) / v),
        _ => None,
    }
}

fn compute_chromatic_lca_tca_for_surface(
    rows: &[Value],
    surface_index: usize,
    h_marginal: f64,
    hq_marginal: f64,
    j_factor: f64,
    ref_state: &RaySurfaceState,
    short_state: Option<&RaySurfaceState>,
    long_state: Option<&RaySurfaceState>,
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

    let (nd_prime, _) = get_nd_abbe_from_row(row);
    let (nd_prev_val, _) = get_nd_abbe_from_row(prev_row);

    if (delta_n_prime.abs() < 1e-12 || !delta_n_prime.is_finite()) && nd_prime.is_some() {
        delta_n_prime = get_dispersion_fallback(row).unwrap_or(0.0);
        if (n_d - 1.0).abs() < 1e-6 {
            n_d = nd_prime.unwrap_or(n_d);
        }
    }
    if (delta_n.abs() < 1e-12 || !delta_n.is_finite()) && nd_prev_val.is_some() {
        delta_n = get_dispersion_fallback(prev_row).unwrap_or(0.0);
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

// ── Structured paraxial metrics for optimizer parity ──────────────────────

/// All paraxial metrics needed by the optimizer, mirroring the TS
/// `getPrimarySystemMetricsCached` output.
#[derive(Debug, Clone)]
pub(crate) struct ParaxialMetrics {
    pub fl: f64,
    pub efl: f64,
    pub bfl: f64,
    pub imd: f64,
    pub objd: f64,
    pub tsl: f64,
    pub bexp: f64,
    pub expd: f64,
    pub expp: f64,
    pub enpd: f64,
    pub enpp: f64,
    pub enpm: f64,
    pub pmag: f64,
    pub fno_obj: f64,
    pub fno_img: f64,
    pub fno_wrk: f64,
    pub na_obj: f64,
    pub na_img: f64,
}

/// Compute structured paraxial metrics from optical system rows,
/// using the same paraxial ray tracing as `format_paraxial_report`.
pub(crate) fn compute_paraxial_metrics(
    rows: &[Value],
    source_rows: &[Value],
    _object_rows: &[Value],
) -> ParaxialMetrics {
    let zero = ParaxialMetrics {
        fl: 0.0, efl: 0.0, bfl: 0.0, imd: 0.0, objd: 0.0, tsl: 0.0,
        bexp: 0.0, expd: 0.0, expp: 0.0, enpd: 0.0, enpp: 0.0, enpm: 0.0,
        pmag: 0.0, fno_obj: 0.0, fno_img: 0.0, fno_wrk: 0.0, na_obj: 0.0, na_img: 0.0,
    };
    if rows.is_empty() {
        return zero;
    }

    let trace = calculate_full_system_paraxial_trace(rows);
    let stop_index = detect_stop_surface_index(rows).unwrap_or(1);
    let stop_diameter = rows
        .get(stop_index)
        .and_then(Value::as_object)
        .and_then(|o| parse_numeric(o.get("semidia").unwrap_or(&Value::Null)))
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|r| r * 2.0)
        .unwrap_or(0.0);
    let stop_trace = trace_paraxial_ray_from_stop(rows, stop_index);
    let entrance = estimate_entrance_pupil(rows, stop_index, stop_diameter);

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

    let fl = safe0(t.focal_length_mm);
    let bfl = safe0(t.back_focal_length_mm);
    let imd = safe0(t.image_distance_mm);
    let tsl = safe0(t.total_system_length_mm);
    let objd = safe0(t.object_distance_mm.unwrap_or(0.0));

    // EFL via separate infinite-object trace (same as format_paraxial_report)
    let efl = fl; // In format_paraxial_report, EFL = FL from the same trace

    let bexp = safe0(exit_pupil_mag);
    let expd = safe0(exit_pupil_diameter);

    let exit_pos_from_image = stop_trace
        .as_ref()
        .map(|st| st.image_distance_mm - t.image_distance_mm)
        .filter(|v| v.is_finite())
        .unwrap_or(0.0);
    let expp = safe0(exit_pos_from_image);

    let entrance_diameter = entrance
        .as_ref()
        .map(|v| v.diameter_mm)
        .filter(|v| v.is_finite() && *v > 1e-12)
        .unwrap_or(stop_diameter);

    let enpd = safe0(entrance.as_ref().map(|v| v.diameter_mm).unwrap_or(stop_diameter));
    let enpp = safe0(entrance.as_ref().map(|v| v.position_mm).unwrap_or(0.0));
    let enpm = safe0(entrance.as_ref().map(|v| v.magnification).unwrap_or(1.0));

    let beta = if let Some(d0) = t.object_distance_mm {
        if t.final_alpha.abs() > 1e-10 { (-1.0 / d0) / t.final_alpha } else { 0.0 }
    } else {
        0.0
    };
    let pmag = safe0(beta);

    let fno_wrk = if expd > 0.0 && t.image_distance_mm.is_finite() {
        safe0(t.image_distance_mm.abs() / expd)
    } else {
        0.0
    };

    let fno_obj = if beta.abs() > 1e-10 && fno_wrk.is_finite() {
        safe0((fno_wrk / beta).abs())
    } else {
        0.0
    };

    let fno_img = if fl > 0.0 && entrance_diameter > 0.0 {
        safe0(fl / entrance_diameter)
    } else {
        0.0
    };

    let na_img = if fno_wrk.is_finite() && fno_wrk.abs() > 1e-12 {
        safe0(1.0 / (2.0 * fno_wrk))
    } else {
        0.0
    };

    let na_obj = if na_img.is_finite() && beta.is_finite() {
        safe0((na_img * beta).abs())
    } else {
        0.0
    };

    let _ = source_rows; // consumed indirectly via detect_primary_wavelength if needed

    ParaxialMetrics {
        fl, efl, bfl, imd, objd, tsl,
        bexp, expd, expp, enpd, enpp, enpm, pmag,
        fno_obj, fno_img, fno_wrk, na_obj, na_img,
    }
}

fn safe0(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}
