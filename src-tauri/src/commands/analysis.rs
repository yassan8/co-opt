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
    if kind != "opd" && kind != "psf" && kind != "mtf" {
        return Err(format!("unsupported analysis kind '{}': expected opd|psf|mtf", req.kind));
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
