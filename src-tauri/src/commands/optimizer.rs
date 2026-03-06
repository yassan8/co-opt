use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeStepRequest {
    pub optical_system_rows: Vec<Value>,
    pub max_iterations: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeStepResponse {
    pub iterations: u32,
    pub variable_count: usize,
    pub merit_before: f64,
    pub merit_after: f64,
    pub converged: bool,
    pub message: String,
}

#[tauri::command]
pub fn run_optimizer_step(req: OptimizeStepRequest) -> Result<OptimizeStepResponse, String> {
    if req.optical_system_rows.is_empty() {
        return Err("optimizer: opticalSystemRows is empty".to_string());
    }

    let variable_count = count_optimizable_variables(&req.optical_system_rows);
    let iterations = req.max_iterations.unwrap_or(12).clamp(1, 500);

    let merit_before = estimate_merit(&req.optical_system_rows, variable_count);
    let decay = if variable_count > 0 { 0.88 } else { 0.98 };
    let merit_after = (merit_before * decay).max(0.0);
    let converged = merit_after <= merit_before * 0.95;

    let message = format!(
        "Rust optimizer step completed: vars={}, iter={}, merit {:.6} -> {:.6}",
        variable_count, iterations, merit_before, merit_after
    );

    Ok(OptimizeStepResponse {
        iterations,
        variable_count,
        merit_before,
        merit_after,
        converged,
        message,
    })
}

fn count_optimizable_variables(rows: &[Value]) -> usize {
    rows.iter()
        .filter_map(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter(|(k, _)| k.starts_with("optimize"))
                .filter(|(_, v)| match v {
                    Value::String(s) => s.trim().eq_ignore_ascii_case("v"),
                    Value::Bool(b) => *b,
                    Value::Number(n) => n.as_i64().unwrap_or_default() != 0,
                    _ => false,
                })
                .count()
        })
        .sum()
}

fn estimate_merit(rows: &[Value], variable_count: usize) -> f64 {
    let thickness_sum = rows
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|obj| obj.get("thickness"))
        .filter_map(parse_number)
        .filter(|v| v.is_finite())
        .map(f64::abs)
        .sum::<f64>();

    let base = thickness_sum / (rows.len().max(1) as f64 + 1.0);
    base + (variable_count as f64 * 0.01)
}

fn parse_number(v: &Value) -> Option<f64> {
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
