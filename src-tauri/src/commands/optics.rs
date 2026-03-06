use serde::{Deserialize, Serialize};

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
