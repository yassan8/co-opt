use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
    pub optical_system_rows: Vec<Value>,
    #[serde(default)]
    pub source_rows: Vec<Value>,
    #[serde(default)]
    pub object_rows: Vec<Value>,
    pub grid_size: Option<u32>,
    pub max_frequency_lpmm: Option<f64>,
    pub target_frequency_lpmm: Option<f64>,
    pub defocus_min_mm: Option<f64>,
    pub defocus_max_mm: Option<f64>,
    pub field_min: Option<f64>,
    pub field_max: Option<f64>,
    pub steps: Option<u32>,
    pub first_frequency_lpmm: Option<f64>,
    pub second_frequency_lpmm: Option<f64>,
    pub field_axis_mode: Option<String>,
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
        && kind != "psf"
        && kind != "mtf"
        && kind != "through-focus-mtf"
        && kind != "field-mtf"
        && kind != "through-focus-spot"
        && kind != "spot-diagram"
    {
        return Err(format!(
            "unsupported analysis kind '{}': expected opd|psf|mtf|through-focus-mtf|field-mtf|through-focus-spot|spot-diagram",
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
        "psf" => (base * 0.007).max(0.0),
        "mtf" => (1.0 / (1.0 + base * 0.003)).clamp(0.0, 1.0),
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
pub fn run_analysis_compute(req: RunAnalysisComputeRequest) -> Result<RunAnalysisComputeResponse, String> {
    let kind = req.kind.trim().to_lowercase();
    if kind != "opd" && kind != "psf" && kind != "mtf" {
        return Err(format!("unsupported analysis kind '{}': expected opd|psf|mtf", req.kind));
    }
    if req.optical_system_rows.is_empty() {
        return Err("analysis compute: opticalSystemRows is empty".to_string());
    }

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

    match kind.as_str() {
        "opd" => {
            let opd_grid = build_opd_grid(grid_size as usize, &metrics);
            Ok(RunAnalysisComputeResponse {
                kind,
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
        "psf" => {
            let psf_grid = build_psf_grid(grid_size as usize, &metrics);
            Ok(RunAnalysisComputeResponse {
                kind,
                grid_size,
                opd_grid: None,
                psf_grid: Some(psf_grid),
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
                message: format!("Rust PSF compute completed: {}x{}", grid_size, grid_size),
                summary,
            })
        }
        "mtf" => {
            let max_freq = req.max_frequency_lpmm.unwrap_or(100.0).clamp(10.0, 2000.0);
            let mtf_points = (grid_size / 2).clamp(32, 256) as usize;
            let (frequency_axis, mtf_tangential, mtf_sagittal) = build_mtf_axes(mtf_points, max_freq, &metrics);
            Ok(RunAnalysisComputeResponse {
                kind,
                grid_size,
                opd_grid: None,
                psf_grid: None,
                frequency_axis: Some(frequency_axis),
                x_axis: None,
                mtf_tangential: Some(mtf_tangential),
                mtf_sagittal: Some(mtf_sagittal),
                mtf_first_tangential: None,
                mtf_first_sagittal: None,
                mtf_second_tangential: None,
                mtf_second_sagittal: None,
                spot_series: None,
                spot_diagram_series: None,
                message: format!("Rust MTF compute completed: points={}", mtf_points),
                summary,
            })
        }
        "through-focus-mtf" => {
            let target_freq = req.target_frequency_lpmm.unwrap_or(10.0).clamp(1.0, 2000.0);
            let min_defocus = req.defocus_min_mm.unwrap_or(-0.1);
            let max_defocus = req.defocus_max_mm.unwrap_or(0.1);
            let steps = req.steps.unwrap_or(21).clamp(3, 401) as usize;
            let (x_axis, mtf_tangential, mtf_sagittal) = build_through_focus_mtf(
                steps,
                min_defocus,
                max_defocus,
                target_freq,
                &metrics,
            );
            Ok(RunAnalysisComputeResponse {
                kind,
                grid_size,
                opd_grid: None,
                psf_grid: None,
                frequency_axis: None,
                x_axis: Some(x_axis),
                mtf_tangential: Some(mtf_tangential),
                mtf_sagittal: Some(mtf_sagittal),
                mtf_first_tangential: None,
                mtf_first_sagittal: None,
                mtf_second_tangential: None,
                mtf_second_sagittal: None,
                spot_series: None,
                spot_diagram_series: None,
                message: "Rust Through-Focus MTF compute completed".to_string(),
                summary,
            })
        }
        "field-mtf" => {
            let field_min = req.field_min.unwrap_or(0.0);
            let field_max = req.field_max.unwrap_or(10.0);
            let steps = req.steps.unwrap_or(21).clamp(3, 401) as usize;
            let first_freq = req.first_frequency_lpmm.unwrap_or(10.0).clamp(1.0, 2000.0);
            let second_freq = req.second_frequency_lpmm.unwrap_or(30.0).clamp(1.0, 2000.0);
            let axis_mode = req.field_axis_mode.unwrap_or_else(|| "angle".to_string());

            let (x_axis, mtf_first_tangential, mtf_first_sagittal, mtf_second_tangential, mtf_second_sagittal) =
                build_field_mtf(
                    steps,
                    field_min,
                    field_max,
                    first_freq,
                    second_freq,
                    &metrics,
                );
            let summary = merge_summary(summary, json!({ "fieldAxisMode": axis_mode }));

            Ok(RunAnalysisComputeResponse {
                kind,
                grid_size,
                opd_grid: None,
                psf_grid: None,
                frequency_axis: None,
                x_axis: Some(x_axis),
                mtf_tangential: None,
                mtf_sagittal: None,
                mtf_first_tangential: Some(mtf_first_tangential),
                mtf_first_sagittal: Some(mtf_first_sagittal),
                mtf_second_tangential: Some(mtf_second_tangential),
                mtf_second_sagittal: Some(mtf_second_sagittal),
                spot_series: None,
                spot_diagram_series: None,
                message: "Rust Field MTF compute completed".to_string(),
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

            let spot_series = build_through_focus_spot(
                min_defocus,
                max_defocus,
                steps,
                ray_count as usize,
                ring_count as usize,
                scale_um,
                &pattern,
                &wavelength_mode,
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
                kind,
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
            let surface_index = req.surface_index.unwrap_or(0);
            let spot_diagram_series = build_spot_diagram(ray_count as usize, ring_count as usize, &pattern, &metrics);
            let summary = merge_summary(
                summary,
                json!({
                    "surfaceIndex": surface_index,
                    "rayCount": ray_count,
                    "ringCount": ring_count,
                    "pattern": pattern,
                    "seriesCount": spot_diagram_series.len()
                }),
            );

            Ok(RunAnalysisComputeResponse {
                kind,
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
        _ => Err("unsupported analysis kind".to_string()),
    }
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

fn build_psf_grid(size: usize, metrics: &AnalysisMetrics) -> Vec<Vec<f64>> {
    let mut grid = vec![vec![0.0; size]; size];
    if size < 2 {
        return grid;
    }

    let center = (size as f64 - 1.0) * 0.5;
    let sigma = (0.06 + metrics.aberration_scale * 0.12).clamp(0.04, 0.5);
    let ring_amp = (metrics.aberration_scale * 0.18).clamp(0.02, 0.25);

    let mut sum = 0.0;
    for (iy, row) in grid.iter_mut().enumerate() {
        let y = (iy as f64 - center) / center;
        for (ix, v) in row.iter_mut().enumerate() {
            let x = (ix as f64 - center) / center;
            let r = (x * x + y * y).sqrt();
            let gaussian = (-0.5 * (r / sigma).powi(2)).exp();
            let rings = 1.0 + ring_amp * (18.0 * r).cos() * (-3.0 * r).exp();
            let value = (gaussian * rings).max(0.0);
            *v = value;
            sum += value;
        }
    }

    if sum > 0.0 {
        for row in &mut grid {
            for v in row {
                *v /= sum;
            }
        }
    }
    grid
}

fn build_mtf_axes(points: usize, max_freq: f64, metrics: &AnalysisMetrics) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut freq = Vec::with_capacity(points);
    let mut tangential = Vec::with_capacity(points);
    let mut sagittal = Vec::with_capacity(points);

    let anisotropy = (0.05 + metrics.aberration_scale * 0.12).clamp(0.03, 0.25);
    let fc = (max_freq * (0.48 - metrics.aberration_scale * 0.10)).clamp(max_freq * 0.12, max_freq * 0.65);

    for i in 0..points {
        let f = if points > 1 {
            (i as f64) / ((points - 1) as f64) * max_freq
        } else {
            0.0
        };
        let base = (-(f / fc).powf(1.35)).exp();
        let tan = (base * (1.0 - anisotropy * (f / max_freq))).clamp(0.0, 1.0);
        let sag = (base * (1.0 + anisotropy * 0.8 * (f / max_freq))).clamp(0.0, 1.0);

        freq.push(f);
        tangential.push(if i == 0 { 1.0 } else { tan });
        sagittal.push(if i == 0 { 1.0 } else { sag });
    }

    (freq, tangential, sagittal)
}

fn build_through_focus_mtf(
    points: usize,
    min_defocus: f64,
    max_defocus: f64,
    target_frequency_lpmm: f64,
    metrics: &AnalysisMetrics,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut x_axis = Vec::with_capacity(points);
    let mut tangential = Vec::with_capacity(points);
    let mut sagittal = Vec::with_capacity(points);

    let span = (max_defocus - min_defocus).abs().max(1e-6);
    let center = (min_defocus + max_defocus) * 0.5;
    let sigma = (span * (0.14 + metrics.aberration_scale * 0.20)).clamp(span * 0.06, span * 0.35);
    let freq_penalty = (target_frequency_lpmm / 120.0).clamp(0.0, 4.0);
    let anisotropy = (0.03 + metrics.aberration_scale * 0.12).clamp(0.02, 0.22);

    for i in 0..points {
        let x = if points > 1 {
            min_defocus + (i as f64) * (max_defocus - min_defocus) / ((points - 1) as f64)
        } else {
            center
        };
        let t = (x - center) / sigma;
        let base = (-(0.5 + 0.1 * freq_penalty) * t * t).exp();
        let tan = (base * (1.0 - anisotropy * t.abs())).clamp(0.0, 1.0);
        let sag = (base * (1.0 + anisotropy * 0.8 * t.abs())).clamp(0.0, 1.0);
        x_axis.push(x);
        tangential.push(tan);
        sagittal.push(sag);
    }
    (x_axis, tangential, sagittal)
}

fn build_field_mtf(
    points: usize,
    field_min: f64,
    field_max: f64,
    first_frequency_lpmm: f64,
    second_frequency_lpmm: f64,
    metrics: &AnalysisMetrics,
) -> (Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut x_axis = Vec::with_capacity(points);
    let mut first_tangential = Vec::with_capacity(points);
    let mut first_sagittal = Vec::with_capacity(points);
    let mut second_tangential = Vec::with_capacity(points);
    let mut second_sagittal = Vec::with_capacity(points);

    let freq1_penalty = (first_frequency_lpmm / 120.0).clamp(0.0, 4.0);
    let freq2_penalty = (second_frequency_lpmm / 120.0).clamp(0.0, 4.0);
    let anisotropy = (0.04 + metrics.aberration_scale * 0.10).clamp(0.02, 0.2);

    for i in 0..points {
        let x = if points > 1 {
            field_min + (i as f64) * (field_max - field_min) / ((points - 1) as f64)
        } else {
            field_min
        };
        let normalized_field = if (field_max - field_min).abs() > 1e-9 {
            ((x - field_min) / (field_max - field_min)).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let edge_factor = 1.0 - normalized_field.powf(1.2);

        let base1 = (edge_factor.powf(0.9 + 0.12 * freq1_penalty)).clamp(0.0, 1.0);
        let base2 = (edge_factor.powf(1.05 + 0.14 * freq2_penalty)).clamp(0.0, 1.0);

        x_axis.push(x);
        first_tangential.push((base1 * (1.0 - anisotropy * normalized_field)).clamp(0.0, 1.0));
        first_sagittal.push((base1 * (1.0 + anisotropy * 0.7 * normalized_field)).clamp(0.0, 1.0));
        second_tangential.push((base2 * (1.0 - anisotropy * 1.1 * normalized_field)).clamp(0.0, 1.0));
        second_sagittal.push((base2 * (1.0 + anisotropy * 0.9 * normalized_field)).clamp(0.0, 1.0));
    }

    (
        x_axis,
        first_tangential,
        first_sagittal,
        second_tangential,
        second_sagittal,
    )
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
    metrics: &AnalysisMetrics,
) -> Vec<SpotSeries> {
    let mut out = Vec::<SpotSeries>::new();
    let wavelengths: Vec<(&str, &str, f64)> = if wavelength_mode.eq_ignore_ascii_case("primary") {
        vec![("Primary", "#2563eb", 1.0)]
    } else {
        vec![
            ("Blue", "#2563eb", 0.90),
            ("Green", "#16a34a", 1.0),
            ("Red", "#dc2626", 1.12),
        ]
    };

    let center = (min_defocus + max_defocus) * 0.5;
    let blur_gain = (0.10 + metrics.aberration_scale * 0.35).clamp(0.08, 0.6);
    let rays = ray_count.clamp(9, 2201);

    for step in 0..steps {
        let defocus = if steps > 1 {
            min_defocus + (step as f64) * (max_defocus - min_defocus) / ((steps - 1) as f64)
        } else {
            center
        };
        let d_norm = (defocus - center).abs() / ((max_defocus - min_defocus).abs().max(1e-6));
        let base_sigma = (4.0 + scale_um * blur_gain * (0.25 + d_norm)).clamp(1.0, scale_um * 2.0);

        for (w_label, color, chroma_scale) in &wavelengths {
            let sigma = base_sigma * chroma_scale;
            let mut points = Vec::<SpotPoint>::with_capacity(rays);
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
                        points.push(SpotPoint {
                            x_um: x * sigma,
                            y_um: y * sigma,
                        });
                    }
                }
            } else {
                for i in 0..rays {
                    let t = i as f64 / (rays as f64);
                    let ring = 1 + ((i * ring_count.max(1)) / rays.max(1));
                    let rho = ((ring as f64) / (ring_count.max(1) as f64)).sqrt();
                    let theta = t * std::f64::consts::TAU * (1.0 + rho * 2.0);
                    points.push(SpotPoint {
                        x_um: rho * sigma * theta.cos(),
                        y_um: rho * sigma * theta.sin(),
                    });
                }
            }

            out.push(SpotSeries {
                defocus_mm: defocus,
                wavelength_label: (*w_label).to_string(),
                color: (*color).to_string(),
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
    metrics: &AnalysisMetrics,
) -> Vec<SpotDiagramSeries> {
    let rays = ray_count.clamp(9, 2201);
    let spot_scale = (8.0 + metrics.aberration_scale * 32.0).clamp(4.0, 80.0);
    let wavelengths = vec![
        ("Blue", "#2563eb", 0.90_f64),
        ("Green", "#16a34a", 1.0_f64),
        ("Red", "#dc2626", 1.12_f64),
    ];

    let mut out = Vec::<SpotDiagramSeries>::new();
    for (label, color, chroma) in wavelengths {
        let mut points = Vec::<SpotPoint>::with_capacity(rays);
        let sigma = spot_scale * chroma;
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
                    points.push(SpotPoint {
                        x_um: x * sigma,
                        y_um: y * sigma,
                    });
                }
            }
        } else {
            for i in 0..rays {
                let t = i as f64 / (rays as f64);
                let ring = 1 + ((i * ring_count.max(1)) / rays.max(1));
                let rho = ((ring as f64) / (ring_count.max(1) as f64)).sqrt();
                let theta = t * std::f64::consts::TAU * (1.0 + rho * 2.0);
                points.push(SpotPoint {
                    x_um: rho * sigma * theta.cos(),
                    y_um: rho * sigma * theta.sin(),
                });
            }
        }

        out.push(SpotDiagramSeries {
            label: label.to_string(),
            color: color.to_string(),
            points,
        });
    }

    out
}
