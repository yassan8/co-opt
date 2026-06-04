use std::env;
use std::fs;

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

fn parse_args() -> Result<(String, u32), String> {
    let mut args = env::args().skip(1);
    let input = args
        .next()
        .ok_or_else(|| "usage: cargo run --bin optimizer_profile -- <project.json> [iterations]".to_string())?;
    let iterations = args
        .next()
        .map(|value| value.parse::<u32>().map_err(|err| format!("invalid iterations '{}': {}", value, err)))
        .transpose()?
        .unwrap_or(1)
        .max(1);
    Ok((input, iterations))
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
    let (input_path, iterations) = parse_args()?;
    let project = load_project(&input_path)?;
    let req = build_request(&project, iterations);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .build(tauri::generate_context!())
        .map_err(|err| format!("failed to build tauri app: {}", err))?;

    let resp = run_optimizer_step(app.handle().clone(), req)?;
    let profile = resp.profile.ok_or_else(|| "missing optimizer profile report".to_string())?;

    println!(
        "optimizer-profile summary vars={} iter={} merit_before={:.6} merit_after={:.6} eval_calls={} req_passes={}",
        resp.variable_count,
        resp.iterations,
        resp.merit_before,
        resp.merit_after,
        profile.evaluate_state_calls,
        profile.requirement_passes,
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