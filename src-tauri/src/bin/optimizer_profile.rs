use std::env;
use std::fs;
use std::time::Instant;

use co_opt_pro_lib::commands::optimizer::run_optimizer_step;
use co_opt_pro_lib::commands::optimizer::OptimizeStepRequest;
use serde_json::Value;

fn load_project(path: &str) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|err| format!("failed to read {}: {}", path, err))?;
    serde_json::from_str::<Value>(&text).map_err(|err| format!("failed to parse {} as JSON: {}", path, err))
}

fn build_request(project: &Value, max_iterations: u32) -> OptimizeStepRequest {
    let active_config_id = project
        .get("configurations")
        .and_then(|cfg| cfg.get("activeConfigId"))
        .cloned()
        .or_else(|| project.get("activeConfigId").cloned());
    let system_config_snapshot = project.get("configurations").cloned();

    OptimizeStepRequest {
        optical_system_rows: project
            .get("opticalSystem")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        source_rows: Some(
            project
                .get("source")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        ),
        object_rows: Some(
            project
                .get("object")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        ),
        active_config_id,
        system_config_snapshot,
        system_requirements_rows: Some(
            project
                .get("systemRequirements")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        ),
        session_id: None,
        reset_session: Some(true),
        max_iterations: Some(max_iterations),
        method: Some("kkt".to_string()),
        emit_progress: Some(false),
        profile: Some(true),
        penalty_parameter: None,
        penalty_increase_factor: None,
        line_search_c: None,
        line_search_rho: None,
        line_search_max_backtrack: None,
        dry_run: Some(false),
    }
}

fn parse_args() -> Result<(String, u32, u32), String> {
    let mut args = env::args().skip(1);
    let input = args
        .next()
        .ok_or_else(|| "usage: cargo run --bin optimizer_profile -- <project.json> [iterations] [repeat]".to_string())?;
    let iterations = args
        .next()
        .map(|value| value.parse::<u32>().map_err(|err| format!("invalid iterations '{}': {}", value, err)))
        .transpose()?
        .unwrap_or(1)
        .max(1);
    let repeat = args
        .next()
        .map(|value| value.parse::<u32>().map_err(|err| format!("invalid repeat '{}': {}", value, err)))
        .transpose()?
        .unwrap_or(1)
        .max(1);
    Ok((input, iterations, repeat))
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[mid - 1] + values[mid]) * 0.5
    } else {
        values[mid]
    }
}

fn main() {
    let exit_code = match run() {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("optimizer-profile error: {}", err);
            1
        }
    };
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

fn run() -> Result<(), String> {
    let (input_path, iterations, repeat) = parse_args()?;
    let project = load_project(&input_path)?;
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .build(tauri::generate_context!())
        .map_err(|err| format!("failed to build tauri app: {}", err))?;

    let mut elapsed_runs = Vec::with_capacity(repeat as usize);
    let mut operand_totals = Vec::with_capacity(repeat as usize);
    let mut final_response = None;
    let mut final_profile = None;

    for run_index in 0..repeat {
        let req = build_request(&project, iterations);
        let started_at = Instant::now();
        let mut resp = run_optimizer_step(app.handle().clone(), req)?;
        let elapsed_ms = started_at.elapsed().as_secs_f64() * 1000.0;
        let profile = resp.profile.take().ok_or_else(|| "missing optimizer profile report".to_string())?;
        let total_operand_ms: f64 = profile.operand_entries.iter().map(|entry| entry.total_ms).sum();
        println!(
            "optimizer-profile run={} vars={} iter={} merit_before={:.6} merit_after={:.6} eval_calls={} req_passes={} elapsed_ms={:.3} operand_total_ms={:.3}",
            run_index + 1,
            resp.variable_count,
            resp.iterations,
            resp.merit_before,
            resp.merit_after,
            profile.evaluate_state_calls,
            profile.requirement_passes,
            elapsed_ms,
            total_operand_ms,
        );
        elapsed_runs.push(elapsed_ms);
        operand_totals.push(total_operand_ms);
        final_response = Some(resp);
        final_profile = Some(profile);
    }

    let resp = final_response.ok_or_else(|| "optimizer profile produced no runs".to_string())?;
    let profile = final_profile.ok_or_else(|| "optimizer profile produced no report".to_string())?;
    let elapsed_min = elapsed_runs.iter().copied().fold(f64::INFINITY, f64::min);
    let elapsed_median = median(&mut elapsed_runs);
    let operand_min = operand_totals.iter().copied().fold(f64::INFINITY, f64::min);
    let operand_median = median(&mut operand_totals);

    println!(
        "optimizer-profile summary runs={} vars={} iter={} merit_before={:.6} merit_after={:.6} elapsed_min_ms={:.3} elapsed_median_ms={:.3} operand_min_ms={:.3} operand_median_ms={:.3}",
        repeat,
        resp.variable_count,
        resp.iterations,
        resp.merit_before,
        resp.merit_after,
        elapsed_min,
        elapsed_median,
        operand_min,
        operand_median,
    );
    for entry in profile.operand_entries.iter().take(16) {
        println!(
            "operand-profile operand={} key={} total_ms={:.3} avg_ms={:.3} count={} hits={} misses={}",
            entry.operand,
            entry.key,
            entry.total_ms,
            entry.avg_ms,
            entry.count,
            entry.cache_hits,
            entry.cache_misses,
        );
    }

    Ok(())
}