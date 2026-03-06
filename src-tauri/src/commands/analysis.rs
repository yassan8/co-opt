use serde::{Deserialize, Serialize};

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
