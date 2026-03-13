use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::commands::analysis::{
    run_system_data_report,
    RunSystemDataReportRequest,
    compute_paraxial_metrics,
};
use crate::commands::optics::{
    run_native_spot_raytrace,
    run_native_transverse_aberration,
    NativeTransverseAberrationSeries,
    NativeSpotRaytraceRequest,
    NativeTransverseAberrationRequest,
    aspheric_sag,
};

const STEP_FRACTION: f64 = 0.02;
const MIN_STEP: f64 = 1e-6;
const STEP_DECAY: f64 = 0.7;
const STALL_LIMIT: u32 = 10;
const INVALID_OPERAND_ABS_LIMIT: f64 = 1e8;
const INVALID_OPERAND_PENALTY_AMOUNT: f64 = 1e3;
const MAX_SQP_ACTIVE_CONSTRAINTS: usize = 6;
const ACTIVE_INEQ_MARGIN_ABS: f64 = 1e-6;
const ACTIVE_INEQ_MARGIN_TOL_SCALE: f64 = 0.5;
const SQP_DIRECTION_LIMIT_SCALE: f64 = 0.02;
const SQP_DIRECTION_LIMIT_STEP_MULT: f64 = 20.0;
// TS parity defaults from optimization/kkt-optimizer.ts
const KKT_LINESEARCH_C: f64 = 0.1;
const KKT_LINESEARCH_RHO: f64 = 0.5;
const KKT_LINESEARCH_MAX_BACKTRACK: usize = 20;
const KKT_INITIAL_PENALTY: f64 = 1.0;
const KKT_PENALTY_INCREASE_FACTOR: f64 = 1.5;

static OPTIMIZER_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static OPTIMIZER_SESSIONS: LazyLock<Mutex<HashMap<String, OptimizerSessionState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Default)]
struct KktRuntimeState {
    rho: f64,
    stall_count: u32,
    mu_total: f64,
    penalty: f64,
    hdiag: Vec<f64>,
    prev_x: Vec<f64>,
    prev_grad: Vec<f64>,
}

#[derive(Clone, Default)]
struct OptimizerSessionState {
    kkt: KktRuntimeState,
    step_by_var_id: HashMap<String, f64>,
}

fn is_stop_requested() -> bool {
    OPTIMIZER_STOP_REQUESTED.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn optimizer_request_stop() -> bool {
    OPTIMIZER_STOP_REQUESTED.store(true, Ordering::SeqCst);
    true
}

#[tauri::command]
pub fn optimizer_clear_stop() -> bool {
    OPTIMIZER_STOP_REQUESTED.store(false, Ordering::SeqCst);
    true
}

#[tauri::command]
pub fn optimizer_drop_session(req: OptimizerDropSessionRequest) -> bool {
    let session_id = req.session_id;
    if let Ok(mut m) = OPTIMIZER_SESSIONS.lock() {
        m.remove(session_id.trim());
    }
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizerDropSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeStepRequest {
    pub optical_system_rows: Vec<Value>,
    pub source_rows: Option<Vec<Value>>,
    pub object_rows: Option<Vec<Value>>,
    pub active_config_id: Option<Value>,
    pub system_requirements_rows: Option<Vec<Value>>,
    pub session_id: Option<String>,
    pub reset_session: Option<bool>,
    pub max_iterations: Option<u32>,
    pub method: Option<String>,
    pub emit_progress: Option<bool>,
    pub penalty_parameter: Option<f64>,
    pub penalty_increase_factor: Option<f64>,
    pub line_search_c: Option<f64>,
    pub line_search_rho: Option<f64>,
    pub line_search_max_backtrack: Option<u32>,
    pub dry_run: Option<bool>,
}

#[derive(Clone, Copy)]
struct KktTuning {
    penalty_parameter: f64,
    penalty_increase_factor: f64,
    line_search_c: f64,
    line_search_rho: f64,
    line_search_max_backtrack: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeProgressEvent {
    pub phase: String,
    pub iter: u32,
    pub current: f64,
    pub best: f64,
    pub accepted: bool,
    pub message: Option<String>,
    pub variable_id: Option<String>,
    pub method: Option<String>,
    pub violation_score: Option<f64>,
    pub soft_penalty: Option<f64>,
    pub requirement_count: Option<usize>,
    pub residual_count: Option<usize>,
    pub rho: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeStepResponse {
    pub iterations: u32,
    pub variable_count: usize,
    pub merit_before: f64,
    pub merit_after: f64,
    pub converged: bool,
    pub mode_used: String,
    pub requirement_score_before: f64,
    pub requirement_score_after: f64,
    pub optimized_rows: Vec<Value>,
    pub progress_events: Vec<OptimizeProgressEvent>,
    pub message: String,
}

#[derive(Clone)]
struct VariableSpec {
    row_index: usize,
    field_key: String,
    id: String,
    baseline: f64,
    scale: f64,
    step: f64,
}

#[derive(Clone)]
struct RequirementSpec {
    id: String,
    config_id: String,
    enabled: bool,
    operand: String,
    op: String,
    target: f64,
    tol: f64,
    weight: f64,
    param1: String,
    param2: String,
    param3: String,
    param4: String,
    param5: String,
}

#[derive(Clone, Copy)]
struct EvalState {
    geometry_merit: f64,
    requirement_score: f64,
    violation_score: f64,
    score: f64,
}

#[tauri::command]
pub fn run_optimizer_step(req: OptimizeStepRequest) -> Result<OptimizeStepResponse, String> {
    if req.optical_system_rows.is_empty() {
        return Err("optimizer: opticalSystemRows is empty".to_string());
    }

    let iterations_max = req.max_iterations.unwrap_or(24).clamp(1, 5000);
    let emit_progress = req.emit_progress.unwrap_or(false);
    let dry_run = req.dry_run.unwrap_or(false);
    let session_id = req
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string);
    let reset_session = req.reset_session.unwrap_or(false);

    let method = normalize_method(req.method.as_deref());
    let kkt_tuning = KktTuning {
        penalty_parameter: req
            .penalty_parameter
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(KKT_INITIAL_PENALTY),
        penalty_increase_factor: req
            .penalty_increase_factor
            .filter(|v| v.is_finite() && *v > 1.0)
            .unwrap_or(KKT_PENALTY_INCREASE_FACTOR),
        line_search_c: req
            .line_search_c
            .filter(|v| v.is_finite() && *v > 0.0 && *v < 1.0)
            .unwrap_or(KKT_LINESEARCH_C),
        line_search_rho: req
            .line_search_rho
            .filter(|v| v.is_finite() && *v > 0.0 && *v < 1.0)
            .unwrap_or(KKT_LINESEARCH_RHO),
        line_search_max_backtrack: req
            .line_search_max_backtrack
            .map(|v| v.max(1) as usize)
            .unwrap_or(KKT_LINESEARCH_MAX_BACKTRACK),
    };
    let mut rows = req.optical_system_rows.clone();
    let source_rows = req.source_rows.clone().unwrap_or_default();
    let object_rows = req.object_rows.clone().unwrap_or_default();
    let active_config_id = value_to_string(req.active_config_id.as_ref());
    let mut vars = collect_optimizable_variables(&rows);
    let variable_count = vars.len();
        if let Some(sid) = session_id.as_ref() {
            if reset_session {
                if let Ok(mut map) = OPTIMIZER_SESSIONS.lock() {
                    map.remove(sid);
                }
            }
            if let Ok(map) = OPTIMIZER_SESSIONS.lock() {
                if let Some(sess) = map.get(sid) {
                    for v in &mut vars {
                        if let Some(step) = sess.step_by_var_id.get(&v.id) {
                            if step.is_finite() {
                                v.step = step.abs().max(MIN_STEP);
                            }
                        }
                    }
                }
            }
        }

    let requirements = collect_requirements(
        req.system_requirements_rows.as_deref().unwrap_or(&[]),
        &active_config_id,
    );

    if requirements.is_empty() {
        return Err("No active System Requirements (check enabled/weight/operand).".to_string());
    }

    let invalid_requirements = collect_invalid_requirements(&rows, &source_rows, &object_rows, &requirements);
    if invalid_requirements.len() == requirements.len() {
        let ops = invalid_requirements
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "All active requirements are invalid/unsupported in Rust optimizer: {}",
            ops
        ));
    }

    let before_eval = evaluate_state(&rows, &source_rows, &object_rows, &vars, &requirements);
    let mut events: Vec<OptimizeProgressEvent> = Vec::new();
    if emit_progress {
        events.push(OptimizeProgressEvent {
            phase: "start".to_string(),
            iter: 0,
            current: before_eval.score,
            best: before_eval.score,
            accepted: false,
            message: Some("optimizer start".to_string()),
            variable_id: None,
            method: Some(method.clone()),
            violation_score: Some(before_eval.violation_score),
            soft_penalty: Some(0.0),
            requirement_count: Some(requirements.len()),
            residual_count: Some(requirements.len()),
            rho: None,
        });
    }

    if dry_run {
        if emit_progress {
            events.push(OptimizeProgressEvent {
                phase: "done".to_string(),
                iter: 0,
                current: before_eval.score,
                best: before_eval.score,
                accepted: false,
                message: Some("optimizer dry-run".to_string()),
                variable_id: None,
                method: Some(method.clone()),
                violation_score: Some(before_eval.violation_score),
                soft_penalty: Some(0.0),
                requirement_count: Some(requirements.len()),
                residual_count: Some(requirements.len()),
                rho: None,
            });
        }
        return Ok(OptimizeStepResponse {
            iterations: 0,
            variable_count,
            merit_before: before_eval.score,
            merit_after: before_eval.score,
            converged: true,
            mode_used: method,
            requirement_score_before: before_eval.requirement_score,
            requirement_score_after: before_eval.requirement_score,
            optimized_rows: rows,
            progress_events: events,
            message: "optimizer dry-run".to_string(),
        });
    }

    if is_stop_requested() {
        return Ok(OptimizeStepResponse {
            iterations: 0,
            variable_count,
            merit_before: before_eval.score,
            merit_after: before_eval.score,
            converged: false,
            mode_used: method,
            requirement_score_before: before_eval.requirement_score,
            requirement_score_after: before_eval.requirement_score,
            optimized_rows: rows,
            progress_events: events,
            message: "optimizer stopped by user".to_string(),
        });
    }

    let mut next_kkt_state = KktRuntimeState {
        rho: kkt_tuning.penalty_parameter,
        stall_count: 0,
        mu_total: 0.0,
        penalty: kkt_tuning.penalty_parameter,
        hdiag: Vec::new(),
        prev_x: Vec::new(),
        prev_grad: Vec::new(),
    };
    if let Some(sid) = session_id.as_ref() {
        if let Ok(map) = OPTIMIZER_SESSIONS.lock() {
            if let Some(sess) = map.get(sid) {
                if sess.kkt.rho.is_finite() && sess.kkt.rho > 0.0 {
                    next_kkt_state.rho = sess.kkt.rho;
                }
                next_kkt_state.stall_count = sess.kkt.stall_count;
                if sess.kkt.mu_total.is_finite() {
                    next_kkt_state.mu_total = sess.kkt.mu_total;
                }
                if sess.kkt.penalty.is_finite() && sess.kkt.penalty > 0.0 {
                    next_kkt_state.penalty = sess.kkt.penalty;
                }
                next_kkt_state.hdiag = sess.kkt.hdiag.clone();
                next_kkt_state.prev_x = sess.kkt.prev_x.clone();
                next_kkt_state.prev_grad = sess.kkt.prev_grad.clone();
            }
        }
    }

    let (mode_used, completed_iterations, best_eval, kkt_final_state) = match method.as_str() {
        "lm" => run_lm(
            &mut rows,
            &source_rows,
            &object_rows,
            &mut vars,
            &requirements,
            iterations_max,
            emit_progress,
            &mut events,
        ),
        "kkt" => run_kkt(
            &mut rows,
            &source_rows,
            &object_rows,
            &mut vars,
            &requirements,
            next_kkt_state,
            kkt_tuning,
            iterations_max,
            emit_progress,
            &mut events,
        ),
        _ => run_cd(
            &mut rows,
            &source_rows,
            &object_rows,
            &mut vars,
            &requirements,
            iterations_max,
            emit_progress,
            &mut events,
        ),
    };

    if let Some(sid) = session_id.as_ref() {
        if let Ok(mut map) = OPTIMIZER_SESSIONS.lock() {
            let mut step_by_var_id = HashMap::new();
            for v in &vars {
                step_by_var_id.insert(v.id.clone(), v.step);
            }
            let mut st = map.get(sid).cloned().unwrap_or_default();
            st.step_by_var_id = step_by_var_id;
            if let Some(kkt_state) = kkt_final_state {
                st.kkt = kkt_state;
            }
            map.insert(sid.clone(), st);
            if map.len() > 64 {
                if let Some(k) = map.keys().next().cloned() {
                    map.remove(&k);
                }
            }
        }
    }

    if emit_progress {
        events.push(OptimizeProgressEvent {
            phase: "done".to_string(),
            iter: completed_iterations,
            current: best_eval.score,
            best: best_eval.score,
            accepted: true,
            message: Some("optimizer done".to_string()),
            variable_id: None,
            method: Some(mode_used.clone()),
            violation_score: Some(best_eval.violation_score),
            soft_penalty: Some(0.0),
            requirement_count: Some(requirements.len()),
            residual_count: Some(requirements.len()),
            rho: None,
        });
    }

    // Keep convergence conservative; UI drives stop by iteration budget / no-improve streak.
    let converged = variable_count == 0;
    let invalid_ops_preview = invalid_requirements
        .iter()
        .take(6)
        .cloned()
        .collect::<Vec<_>>()
        .join(",");
    let message = format!(
        "Rust optimizer ({}) completed: vars={}, iter={}, merit {:.6} -> {:.6}, invalidReq={} [{}]",
        mode_used,
        variable_count,
        completed_iterations,
        before_eval.score,
        best_eval.score,
        invalid_requirements.len(),
        invalid_ops_preview
    );

    Ok(OptimizeStepResponse {
        iterations: completed_iterations,
        variable_count,
        merit_before: before_eval.score,
        merit_after: best_eval.score,
        converged,
        mode_used,
        requirement_score_before: before_eval.requirement_score,
        requirement_score_after: best_eval.requirement_score,
        optimized_rows: rows,
        progress_events: events,
        message,
    })
}

fn normalize_method(raw: Option<&str>) -> String {
    let m = raw.unwrap_or("kkt").trim().to_lowercase();
    if m == "cd" || m == "lm" || m == "kkt" {
        m
    } else {
        "kkt".to_string()
    }
}

fn run_cd(
    rows: &mut [Value],
    source_rows: &[Value],
    object_rows: &[Value],
    vars: &mut [VariableSpec],
    requirements: &[RequirementSpec],
    iterations_max: u32,
    emit_progress: bool,
    events: &mut Vec<OptimizeProgressEvent>,
) -> (String, u32, EvalState, Option<KktRuntimeState>) {
    let mut best_eval = evaluate_state(rows, source_rows, object_rows, vars, requirements);
    let mut completed_iterations = 0;
    let mut stall_count: u32 = 0;

    if vars.is_empty() {
        return ("cd".to_string(), 0, best_eval, None);
    }

    'iter_loop: for iter in 1..=iterations_max {
        if is_stop_requested() {
            break;
        }
        completed_iterations = iter;
        let mut improved_this_iter = false;

        for vi in 0..vars.len() {
            if is_stop_requested() {
                break 'iter_loop;
            }
            let row_index = vars[vi].row_index;
            let field_key = vars[vi].field_key.clone();
            let variable_id = vars[vi].id.clone();
            let step = vars[vi].step.max(MIN_STEP);

            let base_value = match get_numeric_field(rows, row_index, &field_key) {
                Some(x) if x.is_finite() => x,
                _ => continue,
            };

            let mut best_local_value = base_value;
            let mut best_local_eval = best_eval;

            for candidate in [base_value + step, base_value - step] {
                if is_stop_requested() {
                    break 'iter_loop;
                }
                if !candidate.is_finite() {
                    continue;
                }
                set_numeric_field(rows, row_index, &field_key, candidate);
                let cand_eval = evaluate_state(rows, source_rows, object_rows, vars, requirements);
                if is_better_eval(cand_eval, best_local_eval) {
                    best_local_eval = cand_eval;
                    best_local_value = candidate;
                }
            }

            if is_better_eval(best_local_eval, best_eval) {
                set_numeric_field(rows, row_index, &field_key, best_local_value);
                best_eval = best_local_eval;
                improved_this_iter = true;
                if emit_progress {
                    events.push(OptimizeProgressEvent {
                        phase: "accept".to_string(),
                        iter,
                        current: best_eval.score,
                        best: best_eval.score,
                        accepted: true,
                        message: Some("candidate accepted".to_string()),
                        variable_id: Some(variable_id),
                        method: Some("cd".to_string()),
                        violation_score: Some(best_eval.violation_score),
                        soft_penalty: Some(0.0),
                        requirement_count: Some(requirements.len()),
                        residual_count: Some(requirements.len()),
                        rho: None,
                    });
                }
            } else {
                set_numeric_field(rows, row_index, &field_key, base_value);
                vars[vi].step = (vars[vi].step * STEP_DECAY).max(MIN_STEP);
                if emit_progress {
                    events.push(OptimizeProgressEvent {
                        phase: "reject".to_string(),
                        iter,
                        current: best_eval.score,
                        best: best_eval.score,
                        accepted: false,
                        message: Some("candidate rejected".to_string()),
                        variable_id: Some(variable_id),
                        method: Some("cd".to_string()),
                        violation_score: Some(best_eval.violation_score),
                        soft_penalty: Some(0.0),
                        requirement_count: Some(requirements.len()),
                        residual_count: Some(requirements.len()),
                        rho: None,
                    });
                }
            }
        }

        if improved_this_iter {
            stall_count = 0;
        } else {
            stall_count += 1;
            if stall_count >= STALL_LIMIT || vars.iter().all(|v| v.step <= MIN_STEP * 1.01) {
                break;
            }
        }
    }

    ("cd".to_string(), completed_iterations, best_eval, None)
}

fn run_lm(
    rows: &mut [Value],
    source_rows: &[Value],
    object_rows: &[Value],
    vars: &mut [VariableSpec],
    requirements: &[RequirementSpec],
    iterations_max: u32,
    emit_progress: bool,
    events: &mut Vec<OptimizeProgressEvent>,
) -> (String, u32, EvalState, Option<KktRuntimeState>) {
    let mut best_eval = evaluate_state(rows, source_rows, object_rows, vars, requirements);
    let mut completed_iterations = 0;
    let mut lambda = 1e-2;
    let mut stall_count = 0_u32;

    if vars.is_empty() {
        return ("lm".to_string(), 0, best_eval, None);
    }

    for iter in 1..=iterations_max {
        if is_stop_requested() {
            break;
        }
        completed_iterations = iter;
        let base_values = current_values(rows, vars);
        let grad = approximate_gradient(rows, source_rows, object_rows, vars, requirements);

        let mut accepted = false;
        let mut trial_eval = best_eval;

        for alpha in [1.0, 0.5, 0.25, 0.125, 0.0625] {
            if is_stop_requested() {
                break;
            }
            apply_trial_step(rows, vars, &base_values, &grad, alpha / (1.0 + lambda));
            let e = evaluate_state(rows, source_rows, object_rows, vars, requirements);
            if is_better_eval(e, best_eval) {
                trial_eval = e;
                accepted = true;
                break;
            }
        }

        if accepted {
            best_eval = trial_eval;
            lambda = (lambda * 0.7).max(1e-8);
            stall_count = 0;
            if emit_progress {
                events.push(OptimizeProgressEvent {
                    phase: "accept".to_string(),
                    iter,
                    current: best_eval.score,
                    best: best_eval.score,
                    accepted: true,
                    message: Some("lm step accepted".to_string()),
                    variable_id: None,
                    method: Some("lm".to_string()),
                    violation_score: Some(best_eval.violation_score),
                    soft_penalty: Some(0.0),
                    requirement_count: Some(requirements.len()),
                    residual_count: Some(requirements.len()),
                    rho: None,
                });
            }
        } else {
            restore_values(rows, vars, &base_values);
            lambda = (lambda * 2.0).min(1e6);
            stall_count += 1;
            if emit_progress {
                events.push(OptimizeProgressEvent {
                    phase: "reject".to_string(),
                    iter,
                    current: best_eval.score,
                    best: best_eval.score,
                    accepted: false,
                    message: Some("lm step rejected".to_string()),
                    variable_id: None,
                    method: Some("lm".to_string()),
                    violation_score: Some(best_eval.violation_score),
                    soft_penalty: Some(0.0),
                    requirement_count: Some(requirements.len()),
                    residual_count: Some(requirements.len()),
                    rho: None,
                });
            }
            if stall_count >= STALL_LIMIT {
                break;
            }
        }
    }

    ("lm".to_string(), completed_iterations, best_eval, None)
}

fn run_kkt(
    rows: &mut [Value],
    source_rows: &[Value],
    object_rows: &[Value],
    vars: &mut [VariableSpec],
    requirements: &[RequirementSpec],
    state: KktRuntimeState,
    tuning: KktTuning,
    iterations_max: u32,
    emit_progress: bool,
    events: &mut Vec<OptimizeProgressEvent>,
) -> (String, u32, EvalState, Option<KktRuntimeState>) {
    let mut best_eval = evaluate_state(rows, source_rows, object_rows, vars, requirements);
    let mut completed_iterations = 0;
    let mut rho = if state.rho.is_finite() && state.rho > 0.0 { state.rho } else { tuning.penalty_parameter };
    let mut stall_count = state.stall_count;
    let mut mu_total = if state.mu_total.is_finite() && state.mu_total >= 0.0 { state.mu_total } else { 0.0 };
    let mut penalty = if state.penalty.is_finite() && state.penalty > 0.0 { state.penalty } else { rho };
    let mut hdiag = state.hdiag;
    let mut prev_x = state.prev_x;
    let mut prev_grad = state.prev_grad;

    if vars.is_empty() {
        return (
            "kkt".to_string(),
            0,
            best_eval,
            Some(KktRuntimeState { rho, stall_count, mu_total, penalty, hdiag, prev_x, prev_grad }),
        );
    }

    for iter in 1..=iterations_max {
        if is_stop_requested() {
            break;
        }
        completed_iterations = iter;
        let base_values = current_values(rows, vars);
        let grad = approximate_augmented_gradient(rows, source_rows, object_rows, vars, requirements, penalty);
        if hdiag.len() != vars.len() {
            hdiag = initial_hdiag_from_grad(&grad, penalty, vars.len());
        }
        update_hdiag_from_secant(&mut hdiag, &base_values, &grad, &prev_x, &prev_grad);
        let sqp_direction = compute_sqp_like_direction(
            rows,
            source_rows,
            object_rows,
            vars,
            requirements,
            &base_values,
            &grad,
            penalty,
            &hdiag,
        );
        let (mut direction, mut direction_reason, mut used_sqp_direction, mut predicted_reduction) = match sqp_direction {
            Ok(d) => (d.direction, "sqp-ok".to_string(), true, d.predicted_reduction),
            Err(reason) => (grad.iter().map(|g| -g).collect(), reason.to_string(), false, f64::NAN),
        };
        let grad_dot_dir = grad
            .iter()
            .zip(direction.iter())
            .map(|(g, d)| g * d)
            .sum::<f64>();
        if !grad_dot_dir.is_finite() || grad_dot_dir >= 0.0 {
            // Try a minimal projection toward descent before giving up SQP direction.
            let gg = grad.iter().map(|g| g * g).sum::<f64>();
            if grad_dot_dir.is_finite() && gg.is_finite() && gg > 1e-24 {
                let lambda = (grad_dot_dir / gg) + 1e-6;
                for i in 0..direction.len() {
                    direction[i] -= lambda * grad.get(i).copied().unwrap_or(0.0);
                }
                direction_reason = "sqp-projected-descent".to_string();
                predicted_reduction = f64::NAN;
            } else {
                direction = grad.iter().map(|g| -g).collect();
                used_sqp_direction = false;
                direction_reason = "sqp-non-descent".to_string();
                predicted_reduction = f64::NAN;
            }
        }
        let grad_dot_dir = grad
            .iter()
            .zip(direction.iter())
            .map(|(g, d)| g * d)
            .sum::<f64>();
        if !grad_dot_dir.is_finite() || grad_dot_dir >= 0.0 {
            direction = grad.iter().map(|g| -g).collect();
            used_sqp_direction = false;
            direction_reason = "sqp-non-descent".to_string();
            predicted_reduction = f64::NAN;
        }
        let aug_base = best_eval.score
            + mu_total * best_eval.violation_score
            + 0.5 * penalty * best_eval.violation_score * best_eval.violation_score;
        let filter_c = tuning.line_search_c;

        let mut accepted = false;
        let mut best_trial = best_eval;

        let ls_reason: String;
        match armijo_line_search_kkt(
            rows,
            source_rows,
            object_rows,
            vars,
            requirements,
            &base_values,
            &direction,
            best_eval,
            aug_base,
            grad_dot_dir,
            predicted_reduction,
            mu_total,
            penalty,
            tuning,
            filter_c,
        ) {
            LineSearchResult::Accepted { eval: trial_eval, alpha } => {
                ls_reason = format!("armijo-alpha={:.3e}", alpha);
                best_trial = trial_eval;
                accepted = true;
            }
            LineSearchResult::Rejected(reason) => {
                ls_reason = reason.to_string();
            }
        }

        if accepted {
            let prev_violation = best_eval.violation_score;
            best_eval = best_trial;
            stall_count = 0;
            // ALM-style multiplier and penalty updates.
            mu_total = (mu_total + penalty * best_eval.violation_score).max(0.0).min(1e12);
            if best_eval.violation_score > (0.9 * prev_violation) {
                penalty = (penalty * tuning.penalty_increase_factor).min(1e6);
            } else if best_eval.violation_score < (0.5 * prev_violation) {
                penalty = (penalty * 0.9).max(1e-6);
            }
            rho = penalty;
            let penalty_tag = if rho >= 999_999.0 { " [penalty-capped]" } else { "" };
            prev_x = base_values;
            prev_grad = grad;
            if emit_progress {
                events.push(OptimizeProgressEvent {
                    phase: "accept".to_string(),
                    iter,
                    current: best_eval.score,
                    best: best_eval.score,
                    accepted: true,
                    message: Some(if used_sqp_direction {
                        format!("kkt sqp-armijo accepted ({}, {}){}", direction_reason, ls_reason, penalty_tag)
                    } else {
                        format!("kkt grad-armijo accepted ({}, {}){}", direction_reason, ls_reason, penalty_tag)
                    }),
                    variable_id: None,
                    method: Some("kkt".to_string()),
                    violation_score: Some(best_eval.violation_score),
                    soft_penalty: Some(0.0),
                    requirement_count: Some(requirements.len()),
                    residual_count: Some(requirements.len()),
                    rho: Some(rho),
                });
            }
        } else {
            restore_values(rows, vars, &base_values);
            let nudged = try_coordinate_nudge(
                rows,
                source_rows,
                object_rows,
                vars,
                requirements,
                best_eval,
            );
            if let Some(next_eval) = nudged {
                best_eval = next_eval;
                stall_count = 0;
                let penalty_tag = if rho >= 999_999.0 { " [penalty-capped]" } else { "" };
                prev_x = base_values;
                prev_grad = grad;
                if emit_progress {
                    events.push(OptimizeProgressEvent {
                        phase: "accept".to_string(),
                        iter,
                        current: best_eval.score,
                        best: best_eval.score,
                        accepted: true,
                        message: Some(format!("kkt fallback-cd accepted ({}, {}){}", direction_reason, ls_reason, penalty_tag)),
                        variable_id: None,
                        method: Some("kkt".to_string()),
                        violation_score: Some(best_eval.violation_score),
                        soft_penalty: Some(0.0),
                        requirement_count: Some(requirements.len()),
                        residual_count: Some(requirements.len()),
                        rho: Some(rho),
                    });
                }
            } else {
                stall_count += 1;
                penalty = (penalty * tuning.penalty_increase_factor).min(1e6);
                rho = penalty;
                let penalty_tag = if rho >= 999_999.0 { " [penalty-capped]" } else { "" };
                if emit_progress {
                    events.push(OptimizeProgressEvent {
                        phase: "reject".to_string(),
                        iter,
                        current: best_eval.score,
                        best: best_eval.score,
                        accepted: false,
                        message: Some(format!("kkt step rejected ({}, {}){}", direction_reason, ls_reason, penalty_tag)),
                        variable_id: None,
                        method: Some("kkt".to_string()),
                        violation_score: Some(best_eval.violation_score),
                        soft_penalty: Some(0.0),
                        requirement_count: Some(requirements.len()),
                        residual_count: Some(requirements.len()),
                        rho: Some(rho),
                    });
                }
                if stall_count >= STALL_LIMIT {
                    break;
                }
            }
        }
    }

    (
        "kkt".to_string(),
        completed_iterations,
        best_eval,
        Some(KktRuntimeState { rho, stall_count, mu_total, penalty, hdiag, prev_x, prev_grad }),
    )
}

fn try_coordinate_nudge(
    rows: &mut [Value],
    source_rows: &[Value],
    object_rows: &[Value],
    vars: &mut [VariableSpec],
    requirements: &[RequirementSpec],
    current_eval: EvalState,
) -> Option<EvalState> {
    if vars.is_empty() {
        return None;
    }

    if is_stop_requested() {
        return None;
    }

    let limit = vars.len().min(8);
    let mut best_eval = current_eval;
    let mut accepted = false;

    for vi in 0..limit {
        if is_stop_requested() {
            break;
        }
        let row_index = vars[vi].row_index;
        let field_key = vars[vi].field_key.clone();
        let base_value = match get_numeric_field(rows, row_index, &field_key) {
            Some(x) if x.is_finite() => x,
            _ => continue,
        };
        let step = (vars[vi].step * 0.5).max(MIN_STEP);
        let mut best_local_eval = best_eval;
        let mut best_local_value = base_value;

        for cand in [base_value + step, base_value - step] {
            if is_stop_requested() {
                break;
            }
            if !cand.is_finite() {
                continue;
            }
            set_numeric_field(rows, row_index, &field_key, cand);
            let e = evaluate_state(rows, source_rows, object_rows, vars, requirements);
            if is_better_eval(e, best_local_eval) {
                best_local_eval = e;
                best_local_value = cand;
            }
        }

        if is_better_eval(best_local_eval, best_eval) {
            set_numeric_field(rows, row_index, &field_key, best_local_value);
            vars[vi].step = (vars[vi].step * 1.05).max(MIN_STEP);
            best_eval = best_local_eval;
            accepted = true;
        } else {
            set_numeric_field(rows, row_index, &field_key, base_value);
            vars[vi].step = (vars[vi].step * STEP_DECAY).max(MIN_STEP);
        }
    }

    if accepted { Some(best_eval) } else { None }
}

fn current_values(rows: &[Value], vars: &[VariableSpec]) -> Vec<f64> {
    vars.iter()
        .map(|v| get_numeric_field(rows, v.row_index, &v.field_key).unwrap_or(v.baseline))
        .collect()
}

fn restore_values(rows: &mut [Value], vars: &[VariableSpec], values: &[f64]) {
    for (i, v) in vars.iter().enumerate() {
        if let Some(x) = values.get(i) {
            set_numeric_field(rows, v.row_index, &v.field_key, *x);
        }
    }
}

fn apply_direction_step(rows: &mut [Value], vars: &[VariableSpec], base_values: &[f64], direction: &[f64], alpha: f64) {
    for i in 0..vars.len() {
        let x0 = *base_values.get(i).unwrap_or(&vars[i].baseline);
        let d = *direction.get(i).unwrap_or(&0.0);
        let x1 = x0 + alpha * d;
        set_numeric_field(rows, vars[i].row_index, &vars[i].field_key, x1);
    }
}

fn augmented_cost(eval: EvalState, mu_total: f64, penalty: f64) -> f64 {
    eval.score + mu_total * eval.violation_score + 0.5 * penalty * eval.violation_score * eval.violation_score
}

enum LineSearchResult {
    Accepted { eval: EvalState, alpha: f64 },
    Rejected(&'static str),
}

struct SqpDirectionResult {
    direction: Vec<f64>,
    predicted_reduction: f64,
}

fn armijo_line_search_kkt(
    rows: &mut [Value],
    source_rows: &[Value],
    object_rows: &[Value],
    vars: &[VariableSpec],
    requirements: &[RequirementSpec],
    base_values: &[f64],
    direction: &[f64],
    base_eval: EvalState,
    aug_base: f64,
    grad_dot_dir: f64,
    predicted_reduction: f64,
    mu_total: f64,
    penalty: f64,
    tuning: KktTuning,
    filter_c: f64,
) -> LineSearchResult {
    // Armijo + filter acceptance (merit or violation reduction).
    let c1 = tuning.line_search_c;
    let shrink = tuning.line_search_rho;
    let mut alpha = 1.0_f64;

    for _ in 0..tuning.line_search_max_backtrack {
        if is_stop_requested() {
            restore_values(rows, vars, base_values);
            return LineSearchResult::Rejected("armijo-stop-requested");
        }
        apply_direction_step(rows, vars, base_values, direction, alpha);
        let eval = evaluate_state(rows, source_rows, object_rows, vars, requirements);
        let aug = augmented_cost(eval, mu_total, penalty);
        let armijo_rhs = if predicted_reduction.is_finite() && predicted_reduction > 0.0 {
            aug_base - c1 * alpha * predicted_reduction.abs()
        } else {
            aug_base + c1 * alpha * grad_dot_dir
        };
        let armijo_ok = aug <= armijo_rhs;
        let violation_ok = eval.violation_score < ((1.0 - filter_c) * base_eval.violation_score);
        if armijo_ok || violation_ok || is_better_eval(eval, base_eval) {
            return LineSearchResult::Accepted { eval, alpha };
        }
        restore_values(rows, vars, base_values);
        alpha *= shrink;
    }

    restore_values(rows, vars, base_values);
    LineSearchResult::Rejected("armijo-max-backtrack")
}

fn apply_trial_step(rows: &mut [Value], vars: &[VariableSpec], base_values: &[f64], grad: &[f64], alpha: f64) {
    for i in 0..vars.len() {
        let x0 = *base_values.get(i).unwrap_or(&vars[i].baseline);
        let g = *grad.get(i).unwrap_or(&0.0);
        let dx = -alpha * g;
        let x1 = x0 + dx;
        set_numeric_field(rows, vars[i].row_index, &vars[i].field_key, x1);
    }
}

fn initial_hdiag_from_grad(grad: &[f64], penalty: f64, n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n];
    for i in 0..n {
        let gi = grad.get(i).copied().unwrap_or(0.0).abs();
        out[i] = (1e-6 + gi + 0.1 * penalty).max(1e-9).min(1e12);
    }
    out
}

fn update_hdiag_from_secant(
    hdiag: &mut [f64],
    x: &[f64],
    grad: &[f64],
    prev_x: &[f64],
    prev_grad: &[f64],
) {
    if hdiag.is_empty() || x.len() != hdiag.len() || grad.len() != hdiag.len() {
        return;
    }
    if prev_x.len() != hdiag.len() || prev_grad.len() != hdiag.len() {
        return;
    }

    for i in 0..hdiag.len() {
        let s = x[i] - prev_x[i];
        let y = grad[i] - prev_grad[i];
        if !s.is_finite() || !y.is_finite() || s.abs() <= 1e-15 {
            continue;
        }
        let s2 = s * s;
        let ys = y * s;
        if !s2.is_finite() || s2 <= 1e-30 {
            continue;
        }
        let old = if hdiag[i].is_finite() && hdiag[i] > 1e-12 {
            hdiag[i]
        } else {
            1.0
        };
        // Damped scalar BFGS-like secant for stable positive diagonal curvature.
        let sec_raw = y / s;
        let sec = if ys >= 0.2 * old * s2 && sec_raw.is_finite() {
            sec_raw
        } else {
            old
        };
        if !sec.is_finite() || sec <= 1e-12 {
            continue;
        }
        hdiag[i] = (0.85 * old + 0.15 * sec).clamp(1e-9, 1e12);
    }
}

fn compute_sqp_like_direction(
    rows: &mut [Value],
    source_rows: &[Value],
    object_rows: &[Value],
    vars: &[VariableSpec],
    requirements: &[RequirementSpec],
    base_values: &[f64],
    grad: &[f64],
    penalty: f64,
    hdiag_hint: &[f64],
) -> Result<SqpDirectionResult, &'static str> {
    if vars.is_empty() {
        return Err("sqp-no-variables");
    }

    restore_values(rows, vars, base_values);
    let residuals = evaluate_constraint_residuals(rows, source_rows, object_rows, requirements);
    let active = select_active_constraint_indices(requirements, &residuals, MAX_SQP_ACTIVE_CONSTRAINTS);
    if active.is_empty() {
        return Err("sqp-active-set-empty");
    }

    let n = vars.len();
    let m = active.len();
    let mut hdiag = vec![0.0; n];
    for i in 0..n {
        let hinted = hdiag_hint.get(i).copied().unwrap_or(0.0);
        let gi = grad.get(i).copied().unwrap_or(0.0).abs();
        let base = (1e-6 + gi + 0.1 * penalty).max(1e-6);
        hdiag[i] = if hinted.is_finite() && hinted > 1e-9 {
            hinted.clamp(1e-9, 1e12)
        } else {
            base
        };
    }

    let mut a = vec![vec![0.0_f64; n]; m];
    for (ri, &ci) in active.iter().enumerate() {
        if is_stop_requested() {
            restore_values(rows, vars, base_values);
            return Err("sqp-stop-requested");
        }
        for vi in 0..n {
            let v = &vars[vi];
            let x0 = base_values.get(vi).copied().unwrap_or(v.baseline);
            let h = (v.scale * 1e-3).max(MIN_STEP);
            set_numeric_field(rows, v.row_index, &v.field_key, x0 + h);
            let r1 = evaluate_constraint_residual_for_requirement(
                rows,
                source_rows,
                object_rows,
                requirements.get(ci).ok_or("sqp-active-index-invalid")?,
            );
            set_numeric_field(rows, v.row_index, &v.field_key, x0);
            let r0 = residuals.get(ci).copied().unwrap_or(f64::MAX / 8.0);
            let dr = (r1 - r0) / h;
            a[ri][vi] = if dr.is_finite() { dr } else { 0.0 };
        }
    }

    restore_values(rows, vars, base_values);

    let k = n + m;
    let mut mat = vec![vec![0.0_f64; k]; k];
    let mut rhs = vec![0.0_f64; k];

    for i in 0..n {
        mat[i][i] = hdiag[i];
        rhs[i] = -grad.get(i).copied().unwrap_or(0.0);
    }

    for j in 0..m {
        let cidx = active[j];
        let r0 = residuals.get(cidx).copied().unwrap_or(0.0);
        rhs[n + j] = -r0;
        for i in 0..n {
            let aji = a[j][i];
            mat[i][n + j] = aji;
            mat[n + j][i] = aji;
        }
    }

    let sol = match solve_dense_linear_system(mat, rhs) {
        Some(s) => s,
        None => return Err("sqp-kkt-singular"),
    };
    let mut dx = vec![0.0_f64; n];
    let mut norm_sq = 0.0_f64;
    for i in 0..n {
        // Do not over-couple SQP step radius to CD step decay; keep a scale-based trust cap.
        let lim = (vars[i].step * SQP_DIRECTION_LIMIT_STEP_MULT)
            .max(vars[i].scale * SQP_DIRECTION_LIMIT_SCALE)
            .max(MIN_STEP * 10.0);
        let mut di = sol.get(i).copied().unwrap_or(0.0);
        if !di.is_finite() {
            di = 0.0;
        }
        di = di.clamp(-lim, lim);
        dx[i] = di;
        norm_sq += di * di;
    }

    if norm_sq <= 1e-18 || !norm_sq.is_finite() {
        return Err("sqp-direction-degenerate");
    }

    let mut g_dot_dx = 0.0_f64;
    let mut d_h_d = 0.0_f64;
    for i in 0..n {
        let di = dx[i];
        let gi = grad.get(i).copied().unwrap_or(0.0);
        g_dot_dx += gi * di;
        d_h_d += hdiag[i] * di * di;
    }
    let pred = -(g_dot_dx + 0.5 * d_h_d);

    Ok(SqpDirectionResult {
        direction: dx,
        predicted_reduction: pred,
    })
}

fn evaluate_constraint_residuals(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    requirements: &[RequirementSpec],
) -> Vec<f64> {
    let mut out = Vec::with_capacity(requirements.len());
    for req in requirements {
        out.push(evaluate_constraint_residual_for_requirement(rows, source_rows, object_rows, req));
    }
    out
}

fn evaluate_constraint_residual_for_requirement(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req: &RequirementSpec,
) -> f64 {
    let raw = evaluate_operand_value(rows, source_rows, object_rows, req);
    let (ok, current) = sanitize_operand_current(raw);
    if !ok {
        return INVALID_OPERAND_PENALTY_AMOUNT;
    }
    compute_constraint_residual(&req.op, current, req.target, req.tol)
}

fn compute_constraint_residual(op: &str, current: f64, target: f64, tol: f64) -> f64 {
    let z = tol.max(0.0);
    if op == "<=" {
        current - (target + z)
    } else if op == "<" {
        current - target
    } else if op == ">=" {
        (target - z) - current
    } else if op == ">" {
        target - current
    } else {
        current - target
    }
}

fn select_active_constraint_indices(
    requirements: &[RequirementSpec],
    residuals: &[f64],
    max_count: usize,
) -> Vec<usize> {
    let mut eq = Vec::new();
    let mut ineq_violated = Vec::new();
    let mut ineq_near = Vec::new();
    for (i, req) in requirements.iter().enumerate() {
        if !req.enabled {
            continue;
        }
        let r = residuals.get(i).copied().unwrap_or(f64::MAX / 8.0);
        if req.op == "=" {
            let thr = req.tol.max(1e-9) * 0.2;
            if r.abs() > thr {
                eq.push((i, r.abs()));
            }
        } else {
            let near_margin = (req.tol * ACTIVE_INEQ_MARGIN_TOL_SCALE).max(ACTIVE_INEQ_MARGIN_ABS);
            if r > 0.0 {
                ineq_violated.push((i, r));
            } else if r >= -near_margin {
                ineq_near.push((i, r.abs()));
            }
        }
    }

    eq.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ineq_violated.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ineq_near.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut out = Vec::new();
    for (i, _) in eq.into_iter().take(max_count) {
        out.push(i);
    }
    let rem = max_count.saturating_sub(out.len());
    for (i, _) in ineq_violated.into_iter().take(rem) {
        out.push(i);
    }
    let rem2 = max_count.saturating_sub(out.len());
    for (i, _) in ineq_near.into_iter().take(rem2) {
        out.push(i);
    }
    out
}

fn solve_dense_linear_system(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    if a.len() != n {
        return None;
    }
    if a.iter().any(|row| row.len() != n) {
        return None;
    }

    for i in 0..n {
        let mut piv = i;
        let mut piv_abs = a[i][i].abs();
        for r in (i + 1)..n {
            let v = a[r][i].abs();
            if v > piv_abs {
                piv_abs = v;
                piv = r;
            }
        }
        if piv_abs <= 1e-14 || !piv_abs.is_finite() {
            return None;
        }
        if piv != i {
            a.swap(i, piv);
            b.swap(i, piv);
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
            if factor.abs() <= 1e-18 {
                continue;
            }
            for c in i..n {
                a[r][c] -= factor * a[i][c];
            }
            b[r] -= factor * b[i];
        }
    }

    if b.iter().all(|v| v.is_finite()) {
        Some(b)
    } else {
        None
    }
}

fn approximate_gradient(
    rows: &mut [Value],
    source_rows: &[Value],
    object_rows: &[Value],
    vars: &[VariableSpec],
    requirements: &[RequirementSpec],
) -> Vec<f64> {
    let mut grad = vec![0.0; vars.len()];
    let f0 = evaluate_state(rows, source_rows, object_rows, vars, requirements).score;
    for i in 0..vars.len() {
        if is_stop_requested() {
            break;
        }
        let v = &vars[i];
        let x0 = get_numeric_field(rows, v.row_index, &v.field_key).unwrap_or(v.baseline);
        let h = (v.scale * 1e-3).max(MIN_STEP);

        set_numeric_field(rows, v.row_index, &v.field_key, x0 + h);
        let f1 = evaluate_state(rows, source_rows, object_rows, vars, requirements).score;
        set_numeric_field(rows, v.row_index, &v.field_key, x0);

        let g = if f1.is_finite() && f0.is_finite() {
            (f1 - f0) / h
        } else {
            0.0
        };
        grad[i] = if g.is_finite() { g } else { 0.0 };
    }
    grad
}

fn approximate_augmented_gradient(
    rows: &mut [Value],
    source_rows: &[Value],
    object_rows: &[Value],
    vars: &[VariableSpec],
    requirements: &[RequirementSpec],
    rho: f64,
) -> Vec<f64> {
    let mut grad = vec![0.0; vars.len()];
    let e0 = evaluate_state(rows, source_rows, object_rows, vars, requirements);
    let f0 = e0.score + rho * e0.violation_score * e0.violation_score;
    for i in 0..vars.len() {
        if is_stop_requested() {
            break;
        }
        let v = &vars[i];
        let x0 = get_numeric_field(rows, v.row_index, &v.field_key).unwrap_or(v.baseline);
        let h = (v.scale * 1e-3).max(MIN_STEP);

        set_numeric_field(rows, v.row_index, &v.field_key, x0 + h);
        let e1 = evaluate_state(rows, source_rows, object_rows, vars, requirements);
        let f1 = e1.score + rho * e1.violation_score * e1.violation_score;

        set_numeric_field(rows, v.row_index, &v.field_key, x0);

        let g = if f1.is_finite() && f0.is_finite() {
            (f1 - f0) / h
        } else {
            0.0
        };
        grad[i] = if g.is_finite() { g } else { 0.0 };
    }
    grad
}

fn collect_optimizable_variables(rows: &[Value]) -> Vec<VariableSpec> {
    let mut out = Vec::new();
    for (row_index, row) in rows.iter().enumerate() {
        let obj = match row.as_object() {
            Some(o) => o,
            None => continue,
        };
        for (key, value) in obj {
            let key_norm = key.trim();
            if !(key_norm.starts_with("optimize") || key_norm.starts_with("__cooptGapOptimize")) || !is_variable_flag(value) {
                continue;
            }

            let target = optimize_key_to_target_field(key_norm);
            let baseline = match get_numeric_field(rows, row_index, &target) {
                Some(x) if x.is_finite() => x,
                _ => continue,
            };
            let scale = baseline.abs().max(1.0);
            let step = (scale * STEP_FRACTION).max(MIN_STEP);
            let row_id = obj
                .get("id")
                .and_then(|v| match v {
                    Value::Number(n) => Some(n.to_string()),
                    Value::String(s) => Some(s.clone()),
                    _ => None,
                })
                .unwrap_or_else(|| row_index.to_string());

            out.push(VariableSpec {
                row_index,
                field_key: target.clone(),
                id: format!("{}:{}", row_id, target),
                baseline,
                scale,
                step,
            });
        }
    }

    out
}

fn collect_requirements(rows: &[Value], active_config_id: &str) -> Vec<RequirementSpec> {
    let active_cfg = active_config_id.trim();
    rows.iter()
        .filter_map(Value::as_object)
        .filter_map(|r| {
            let enabled = value_to_bool_default_true(r.get("enabled"));
            let weight = to_finite_number(r.get("weight"), 1.0).max(0.0);
            let operand = normalize_operand(value_to_string(r.get("operand")));
            let req_config_raw = value_to_string(r.get("configId"));
            // TS parity: empty configId implicitly targets active config.
            let req_config_id = if req_config_raw.trim().is_empty() {
                active_cfg.to_string()
            } else {
                req_config_raw
            };
            if !active_cfg.is_empty() && req_config_id.trim() != active_cfg {
                return None;
            }
            if !enabled || weight <= 0.0 || operand.trim().is_empty() {
                return None;
            }
            Some(RequirementSpec {
                id: value_to_string(r.get("id")),
                config_id: req_config_id,
                enabled,
                operand,
                op: normalize_op(value_to_string(r.get("op"))),
                target: to_finite_number(r.get("target"), 0.0),
                tol: to_finite_number(r.get("tol"), 0.0).max(0.0),
                weight,
                param1: value_to_string(r.get("param1")),
                param2: value_to_string(r.get("param2")),
                param3: value_to_string(r.get("param3")),
                param4: value_to_string(r.get("param4")),
                param5: value_to_string(r.get("param5")),
            })
        })
        .collect()
}

fn normalize_operand(raw: String) -> String {
    let op = raw.trim().to_string();
    if op == "SPOT_SIZE" {
        "SPOT_SIZE_ANNULAR".to_string()
    } else {
        op
    }
}

fn normalize_op(raw: String) -> String {
    let t = raw.trim();
    let lower = t.to_ascii_lowercase();
    match lower.as_str() {
        "<=" | "le" | "lte" | "≤" => "<=".to_string(),
        ">=" | "ge" | "gte" | "≥" => ">=".to_string(),
        "<" | "lt" => "<".to_string(),
        ">" | "gt" => ">".to_string(),
        "=" | "==" | "eq" => "=".to_string(),
        _ => "=".to_string(),
    }
}

fn evaluate_state(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    vars: &[VariableSpec],
    requirements: &[RequirementSpec],
) -> EvalState {
    let geometry_merit = estimate_geometry_merit(rows, vars);
    if requirements.is_empty() {
        return EvalState {
            geometry_merit,
            requirement_score: 0.0,
            violation_score: 0.0,
            score: geometry_merit,
        };
    }

    // TS parity: optimize requirement score first (violation + soft; soft is currently 0 here).
    let (requirement_score, violation_score) = evaluate_requirements(rows, source_rows, object_rows, requirements);
    let score = requirement_score;
    EvalState {
        geometry_merit,
        requirement_score,
        violation_score,
        score,
    }
}

fn is_better_eval(candidate: EvalState, current: EvalState) -> bool {
    if candidate.score < (current.score - 1e-12) {
        return true;
    }
    if (candidate.score - current.score).abs() <= 1e-12
        && candidate.geometry_merit < (current.geometry_merit - 1e-12)
    {
        return true;
    }
    false
}

fn estimate_geometry_merit(rows: &[Value], vars: &[VariableSpec]) -> f64 {
    let mut merit = 0.0_f64;

    let mut prev_curvature: Option<f64> = None;
    let mut prev_thickness: Option<f64> = None;

    for row in rows {
        let obj = match row.as_object() {
            Some(o) => o,
            None => continue,
        };

        if let Some(t) = obj.get("thickness").and_then(parse_number) {
            if t.is_finite() {
                if t < 0.0 {
                    merit += (t.abs() + 1.0).powi(2) * 50.0;
                }
                if let Some(prev_t) = prev_thickness {
                    merit += (t - prev_t).powi(2) * 0.002;
                }
                prev_thickness = Some(t);
            }
        }

        if let Some(s) = obj.get("semidia").and_then(parse_number) {
            if s.is_finite() && s <= 0.0 {
                merit += (s.abs() + 1.0).powi(2) * 20.0;
            }
        }

        if let Some(r) = obj.get("radius").and_then(parse_number) {
            if r.is_finite() {
                let abs_r = r.abs();
                if abs_r < 1e-5 {
                    merit += (1e-5 - abs_r) * 1e7;
                } else {
                    let curv = 1.0 / r;
                    if let Some(prev) = prev_curvature {
                        merit += (curv - prev).powi(2) * 0.05;
                    }
                    prev_curvature = Some(curv);
                }
            }
        }
    }

    for v in vars {
        if let Some(x) = get_numeric_field(rows, v.row_index, &v.field_key) {
            let d = (x - v.baseline) / v.scale;
            merit += d * d * 0.01;
        }
    }

    if !merit.is_finite() {
        return f64::MAX / 4.0;
    }
    merit
}

fn evaluate_requirements(rows: &[Value], source_rows: &[Value], object_rows: &[Value], requirements: &[RequirementSpec]) -> (f64, f64) {
    let mut score = 0.0_f64;
    let mut violation_score = 0.0_f64;
    let mut operand_cache: HashMap<String, Option<f64>> = HashMap::new();

    for req in requirements {
        if is_stop_requested() {
            break;
        }
        if !req.enabled {
            continue;
        }

        let cache_key = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            req.operand, req.param1, req.param2, req.param3, req.param4, req.param5, req.op
        );
        let raw_current = if let Some(v) = operand_cache.get(&cache_key) {
            *v
        } else {
            let v = evaluate_operand_value(rows, source_rows, object_rows, req);
            operand_cache.insert(cache_key, v);
            v
        };
        let (ok, current) = sanitize_operand_current(raw_current);
        let amount = if ok {
            compute_violation_amount(&req.op, current, req.target, req.tol)
        } else {
            INVALID_OPERAND_PENALTY_AMOUNT
        };

        let weighted = req.weight.max(0.0) * amount;
        if weighted.is_finite() {
            score += weighted;
        }
        if weighted > 0.0 && weighted.is_finite() {
            violation_score += weighted;
        }
    }

    if !score.is_finite() {
        return (f64::MAX / 4.0, f64::MAX / 4.0);
    }

    (score, violation_score)
}

fn evaluate_operand_value(rows: &[Value], source_rows: &[Value], object_rows: &[Value], req: &RequirementSpec) -> Option<f64> {
    match req.operand.as_str() {
        "OBJD" => first_row_value(rows, "thickness"),
        "TSL" => Some(sum_finite_thickness(rows)),
        "CTCT" => resolve_surface_row_by_param1(rows, &req.param1)
            .and_then(|(_, obj)| obj.get("thickness").and_then(parse_number)),

        // ── Paraxial metrics (proper ray tracing via analysis.rs) ──
        "FL" | "EFL" | "EFFL" | "BFL" | "IMD"
        | "BEXP" | "EXPD" | "EXPP" | "ENPD" | "ENPP" | "ENPM"
        | "PMAG" | "FNO_OBJ" | "FNO_IMG" | "FNO_WRK" | "NA_OBJ" | "NA_IMG" => {
            let m = compute_paraxial_metrics(rows, source_rows, object_rows);
            let v = match req.operand.as_str() {
                "FL"      => m.fl,
                "EFL"     => m.efl,
                "EFFL"    => m.efl,
                "BFL"     => m.bfl,
                "IMD"     => m.imd,
                "BEXP"    => m.bexp,
                "EXPD"    => m.expd,
                "EXPP"    => m.expp,
                "ENPD"    => m.enpd,
                "ENPP"    => m.enpp,
                "ENPM"    => m.enpm,
                "PMAG"    => m.pmag,
                "FNO_OBJ" => m.fno_obj,
                "FNO_IMG" => m.fno_img,
                "FNO_WRK" => m.fno_wrk,
                "NA_OBJ"  => m.na_obj,
                "NA_IMG"  => m.na_img,
                _ => 0.0,
            };
            Some(v)
        }

        // ── Edge thickness: thickness - sag_front - sag_back (TS parity) ──
        "EDGE" => evaluate_edge_thickness(rows, req),

        "SPOT_SIZE_ANNULAR" => native_spot_size_um(rows, source_rows, object_rows, req, "annular"),
        "SPOT_SIZE_RECT" => native_spot_size_um(rows, source_rows, object_rows, req, "grid"),
        "SPOT_SIZE_CURRENT" => native_spot_size_um(rows, source_rows, object_rows, req, "annular"),
        "TA_RMS_UM" => native_transverse_rms_um(rows, source_rows, object_rows, req),
        "TOT3_SPH" => native_seidel_operand(rows, source_rows, object_rows, req, "i"),
        "TOT3_COMA" => native_seidel_operand(rows, source_rows, object_rows, req, "ii"),
        "TOT3_ASTI" => native_seidel_operand(rows, source_rows, object_rows, req, "iii"),
        "TOT3_FCUR" => native_seidel_operand(rows, source_rows, object_rows, req, "iv"),
        "TOT3_DIST" => native_seidel_operand(rows, source_rows, object_rows, req, "v"),
        "TOT_LCA" => native_seidel_operand(rows, source_rows, object_rows, req, "lca"),
        "TOT_TCA" => native_seidel_operand(rows, source_rows, object_rows, req, "tca"),

        // Operands that TS returns 0 for
        "REAY" | "RSCE" | "TRAC" | "DIST" => Some(0.0),

        _ => None,
    }
}

/// Edge thickness = center_thickness - sag_front + sag_back
/// Mirrors the TS EDGE implementation in merit-function-editor.ts.
fn evaluate_edge_thickness(rows: &[Value], req: &RequirementSpec) -> Option<f64> {
    let (surf_idx, obj) = resolve_surface_row_by_param1(rows, &req.param1)?;

    let thickness = parse_number(obj.get("thickness")?)?;
    if !thickness.is_finite() {
        return None;
    }

    let dir = req.param3.trim().to_ascii_lowercase();

    // Height: param2 or fallback to semidia
    let mut height = parse_number_from_str(&req.param2).unwrap_or(0.0);
    if !height.is_finite() || height <= 0.0 {
        height = obj.get("semidia")
            .and_then(parse_number)
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(10.0);
    }

    let sag_front = compute_surface_sag(obj, height, &dir);

    // Sag of next surface (back side of the same lens)
    let mut sag_back = 0.0;
    let next_idx = surf_idx + 1;
    if next_idx < rows.len() {
        if let Some(next_obj) = rows[next_idx].as_object() {
            let next_material = next_obj.get("material")
                .and_then(|v| match v { Value::String(s) => Some(s.as_str()), _ => None })
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if next_material == "air" {
                sag_back = compute_surface_sag(next_obj, height, &dir);
            }
        }
    }

    let edge = thickness - sag_front + sag_back;
    if edge.is_finite() { Some(edge) } else { None }
}

/// Compute aspheric sag at given height for a surface row.
fn compute_surface_sag(obj: &serde_json::Map<String, Value>, height: f64, direction: &str) -> f64 {
    let surf_type = obj.get("surfType")
        .or_else(|| obj.get("type"))
        .and_then(|v| match v { Value::String(s) => Some(s.as_str()), _ => None })
        .unwrap_or("")
        .trim()
        .to_lowercase();

    // TS parity for EDGE on toric surfaces: respect param3 (x/y/radial)
    if surf_type == "toric" {
        let radius_x = parse_radius_allow_inf(obj.get("radiusX"));
        let radius_y = parse_radius_allow_inf(obj.get("radiusY")).or_else(|| parse_radius_allow_inf(obj.get("radius")));
        let conic = obj.get("conic").and_then(parse_number).unwrap_or(0.0);
        let axis_deg = obj.get("axis").and_then(parse_number).unwrap_or(0.0);

        if let (Some(rx), Some(ry)) = (radius_x, radius_y) {
            let (x, y) = if direction == "x" {
                (height, 0.0)
            } else if direction == "y" {
                (0.0, height)
            } else {
                (height, 0.0)
            };
            let sx = toric_surface_sag(x, y, rx, ry, conic, axis_deg);
            if direction == "x" || direction == "y" {
                return if sx.is_finite() { sx } else { 0.0 };
            }
            // Radial (blank/other): average x/y meridians, matching TS behavior.
            let sy = toric_surface_sag(0.0, height, rx, ry, conic, axis_deg);
            let avg = if sx.is_finite() && sy.is_finite() {
                0.5 * (sx + sy)
            } else if sx.is_finite() {
                sx
            } else if sy.is_finite() {
                sy
            } else {
                0.0
            };
            return avg;
        }
    }

    let radius_raw = obj.get("radius").and_then(parse_number);
    let radius = match radius_raw {
        Some(r) if r.is_finite() && r.abs() > 1e-12 => r,
        _ => return 0.0, // flat surface
    };
    let conic = obj.get("conic").and_then(parse_number).unwrap_or(0.0);
    let mut coefs = [0.0_f64; 10];
    for i in 0..10 {
        let key = format!("coef{}", i + 1);
        coefs[i] = obj.get(&key).and_then(parse_number).unwrap_or(0.0);
    }
    let mode_odd = surf_type.contains("odd");

    let sag = aspheric_sag(height, radius, conic, &coefs, mode_odd);
    if sag.is_finite() { sag } else { 0.0 }
}

fn native_seidel_operand(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
    term: &str,
) -> Option<f64> {
    let source_rows_effective = select_source_rows_for_requirement(source_rows, &req_spec.param1);
    let afocal = seidel_mode_is_afocal(&req_spec.param2);
    let kind = if afocal { "seidel-afocal" } else { "seidel" }.to_string();
    let ref_fl = parse_number_from_str(&req_spec.param4);
    let req = RunSystemDataReportRequest {
        kind,
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows_effective,
        object_rows: object_rows.to_vec(),
        reference_focal_length: ref_fl,
    };
    let resp = run_system_data_report(req).ok()?;
    let surface_target = parse_usize_str(&req_spec.param3).unwrap_or(0);
    parse_seidel_term_from_report(&resp.text, surface_target, term)
}

fn seidel_mode_is_afocal(param2: &str) -> bool {
    let t = param2.trim();
    if t.is_empty() {
        return false;
    }
    if t == "1" {
        return true;
    }
    // If list mode contains afocal (1), prefer afocal for parity with common usage.
    t.split(',').any(|v| v.trim() == "1")
}

fn parse_seidel_term_from_report(text: &str, surface_target: usize, term: &str) -> Option<f64> {
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 10 {
            continue;
        }

        let is_total_row = cols[0].trim().eq_ignore_ascii_case("TOTAL");
        let is_surface_row = cols[0].trim().parse::<usize>().ok();
        let row_match = if surface_target == 0 {
            is_total_row
        } else {
            matches!(is_surface_row, Some(v) if v == surface_target)
        };
        if !row_match {
            continue;
        }

        let col_idx = match term {
            "lca" => 2,
            "tca" => 3,
            "i" => 4,
            "ii" => 5,
            "iii" => 6,
            "iv" => 8,
            "v" => 9,
            _ => return None,
        };
        return cols.get(col_idx).and_then(|s| parse_number_from_str(s.trim()));
    }
    None
}

fn native_spot_size_um(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
    pattern: &str,
) -> Option<f64> {
    let surface_index = image_surface_index(rows);
    let metric = req_spec.param3.trim().to_lowercase();
    let ray_count = parse_spot_ray_count(&req_spec.param4);
    let source_rows_effective = source_rows_for_wavelength_param(source_rows, &req_spec.param1);
    let object_rows_effective = select_object_rows_for_requirement(object_rows, &req_spec.param2);
    let req = NativeSpotRaytraceRequest {
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows_effective,
        object_rows: object_rows_effective,
        surface_index: Some(surface_index),
        ray_count: Some(ray_count),
        ring_count: Some(10),
        pattern: Some(pattern.to_string()),
        wavelength_mode: Some("primary".to_string()),
        ray_series: Vec::new(),
    };

    let resp = run_native_spot_raytrace(req).ok()?;
    let mut sum_sq = 0.0_f64;
    let mut max_r2 = 0.0_f64;
    let mut count = 0usize;
    for s in &resp.series {
        for p in &s.points {
            let x = p.x_um;
            let y = p.y_um;
            if x.is_finite() && y.is_finite() {
                let r2 = x * x + y * y;
                sum_sq += r2;
                if r2 > max_r2 {
                    max_r2 = r2;
                }
                count += 1;
            }
        }
    }
    if count == 0 {
        return None;
    }
    if metric == "diameter" || metric == "dia" {
        return Some(2.0 * max_r2.sqrt());
    }
    Some((sum_sq / count as f64).sqrt())
}

fn native_transverse_rms_um(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
) -> Option<f64> {
    let surface_index = image_surface_index(rows);
    let ray_count = parse_ta_rms_ray_count(&req_spec.param4);
    let source_rows_effective = source_rows_for_wavelength_param(source_rows, &req_spec.param1);
    let wavelength = resolve_requirement_wavelength_um(source_rows, &req_spec.param1);
    let object_rows_effective = select_object_rows_for_requirement(object_rows, &req_spec.param2);
    let req = NativeTransverseAberrationRequest {
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows_effective,
        object_rows: object_rows_effective,
        surface_index: Some(surface_index),
        ray_count: Some(ray_count),
        ring_count: Some(10),
        pattern: Some("cross".to_string()),
        wavelength_mode: Some("primary".to_string()),
        wavelength: Some(wavelength),
    };

    let resp = run_native_transverse_aberration(req).ok()?;
    let component = normalize_ta_component(&req_spec.param3);
    let meridional_stats = collect_ta_stats(&resp.meridional_data);
    let sagittal_stats = collect_ta_stats(&resp.sagittal_data);

    let (sum_sq_mm, count) = if component == "meridional" {
        if meridional_stats.1 > 0 {
            meridional_stats
        } else {
            sagittal_stats
        }
    } else if component == "sagittal" {
        if sagittal_stats.1 > 0 {
            sagittal_stats
        } else {
            meridional_stats
        }
    } else {
        (
            meridional_stats.0 + sagittal_stats.0,
            meridional_stats.1 + sagittal_stats.1,
        )
    };

    if count == 0 {
        return None;
    }
    let rms_mm = (sum_sq_mm / count as f64).sqrt();
    Some(rms_mm * 1000.0)
}

fn normalize_ta_component(raw: &str) -> &'static str {
    let t = raw.trim().to_ascii_lowercase();
    if t.is_empty() {
        return "total";
    }
    if t == "1" || t == "m" || t.contains("meri") || t.contains("tang") {
        return "meridional";
    }
    if t == "2" || t == "s" || t.contains("sag") {
        return "sagittal";
    }
    if t == "0" || t == "t" || t.contains("total") || t.contains("both") {
        return "total";
    }
    "total"
}

fn resolve_surface_row_by_param1<'a>(rows: &'a [Value], param1: &str) -> Option<(usize, &'a serde_json::Map<String, Value>)> {
    let n = parse_usize_str(param1)?;

    // Prefer stable surface id match.
    for (idx, row) in rows.iter().enumerate() {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let id = obj.get("id").and_then(parse_usize_value);
        if id == Some(n) {
            return Some((idx, obj));
        }
    }

    // TS parity fallback: treat as 1-based row index when id lookup misses.
    if n >= 1 {
        let idx = n - 1;
        if idx < rows.len() {
            if let Some(obj) = rows[idx].as_object() {
                return Some((idx, obj));
            }
        }
    }

    None
}

fn parse_radius_allow_inf(v: Option<&Value>) -> Option<f64> {
    let val = v?;
    if let Some(n) = parse_number(val) {
        if n.is_finite() {
            if n.abs() < 1.0e-12 {
                return Some(f64::INFINITY);
            }
            return Some(n);
        }
    }
    if let Value::String(s) = val {
        let t = s.trim().to_ascii_uppercase();
        if t == "INF" || t == "INFINITY" {
            return Some(f64::INFINITY);
        }
    }
    None
}

fn toric_surface_sag(x: f64, y: f64, radius_x: f64, radius_y: f64, conic: f64, axis_deg: f64) -> f64 {
    let axis = axis_deg.to_radians();
    let cos_a = axis.cos();
    let sin_a = axis.sin();
    let x_rot = x * cos_a + y * sin_a;
    let y_rot = -x * sin_a + y * cos_a;

    let sag_axis = |u: f64, r: f64| -> Option<f64> {
        if !r.is_finite() {
            return Some(0.0);
        }
        if r.abs() < 1.0e-12 {
            return Some(0.0);
        }
        let abs_r = r.abs();
        let u2 = u * u;
        let disc = 1.0 - (1.0 + conic) * u2 / (abs_r * abs_r);
        if !disc.is_finite() || disc < 0.0 {
            return None;
        }
        let sag_abs = u2 / (abs_r * (1.0 + disc.sqrt()));
        Some(if r > 0.0 { sag_abs } else { -sag_abs })
    };

    let sx = sag_axis(x_rot, radius_x).unwrap_or(0.0);
    let sy = sag_axis(y_rot, radius_y).unwrap_or(0.0);
    let s = sx + sy;
    if s.is_finite() { s } else { 0.0 }
}

fn collect_ta_stats(series_list: &[NativeTransverseAberrationSeries]) -> (f64, usize) {
    let mut sum_sq_mm = 0.0_f64;
    let mut count = 0usize;
    for series in series_list {
        for p in &series.points {
            let ta = p.transverse_aberration;
            if ta.is_finite() {
                sum_sq_mm += ta * ta;
                count += 1;
            }
        }
    }
    (sum_sq_mm, count)
}

fn image_surface_index(rows: &[Value]) -> usize {
    for (i, row) in rows.iter().enumerate().rev() {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let object_type = value_to_string(obj.get("object type")).trim().to_lowercase();
        if object_type == "image" {
            return i;
        }
    }
    rows.len().saturating_sub(1)
}

fn select_source_rows_for_requirement(source_rows: &[Value], param1: &str) -> Vec<Value> {
    let raw = param1.trim();
    if source_rows.is_empty() {
        return Vec::new();
    }
    if raw.is_empty() {
        return source_rows.to_vec();
    }

    let Ok(parsed) = raw.parse::<f64>() else {
        return source_rows.to_vec();
    };
    if !parsed.is_finite() || parsed <= 0.0 {
        return source_rows.to_vec();
    }

    // Non-integer values are interpreted as literal wavelength on TS side.
    // Keep all rows here; wavelength selection is handled separately.
    let parsed_round = parsed.round();
    if (parsed - parsed_round).abs() > 1.0e-12 {
        return source_rows.to_vec();
    }

    let idx = parsed as usize;
    let i0 = idx.saturating_sub(1);
    if i0 < source_rows.len() {
        return vec![source_rows[i0].clone()];
    }
    source_rows.to_vec()
}

fn source_rows_for_wavelength_param(source_rows: &[Value], param1: &str) -> Vec<Value> {
    if let Some(wl) = parse_wavelength_literal_um(param1) {
        return vec![serde_json::json!({
            "id": "NativeRequirementSource",
            "name": "NativeRequirementSource",
            "wavelength": wl,
            "color": "#9ACD32",
            "isPrimary": true,
            "primary": "Primary",
            "intensity": 1,
        })];
    }
    select_source_rows_for_requirement(source_rows, param1)
}

fn parse_wavelength_literal_um(param1: &str) -> Option<f64> {
    let raw = param1.trim();
    if raw.is_empty() {
        return None;
    }
    let n = raw.parse::<f64>().ok()?;
    if !n.is_finite() || n <= 0.0 {
        return None;
    }
    let s = raw.to_ascii_lowercase();
    let looks_non_integer = (s.contains('.') || s.contains('e')) && (n - n.round()).abs() > 1.0e-12;
    if n < 1.0 || looks_non_integer {
        Some(n)
    } else {
        None
    }
}

fn resolve_requirement_wavelength_um(source_rows: &[Value], param1: &str) -> f64 {
    if let Some(wl) = parse_wavelength_literal_um(param1) {
        return wl;
    }

    let raw = param1.trim();
    if raw.is_empty() {
        return primary_wavelength_from_source_rows(source_rows);
    }

    let Ok(parsed) = raw.parse::<f64>() else {
        return primary_wavelength_from_source_rows(source_rows);
    };
    if !parsed.is_finite() || parsed <= 0.0 {
        return primary_wavelength_from_source_rows(source_rows);
    }

    let idx = parsed.floor() as usize;
    wavelength_from_source_rows(source_rows, idx)
        .unwrap_or_else(|| primary_wavelength_from_source_rows(source_rows))
}

fn wavelength_from_source_rows(source_rows: &[Value], idx1: usize) -> Option<f64> {
    if idx1 == 0 {
        return None;
    }
    let i0 = idx1.saturating_sub(1);
    let row = source_rows.get(i0)?;
    let obj = row.as_object()?;
    obj.get("wavelength")
        .or_else(|| obj.get("Wavelength"))
        .and_then(value_to_f64)
        .filter(|wl| wl.is_finite() && *wl > 0.0)
}

fn primary_wavelength_from_source_rows(source_rows: &[Value]) -> f64 {
    if source_rows.is_empty() {
        return 0.5875618;
    }

    for row in source_rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let wl = obj
            .get("wavelength")
            .or_else(|| obj.get("Wavelength"))
            .and_then(value_to_f64)
            .unwrap_or(f64::NAN);
        if !wl.is_finite() || wl <= 0.0 {
            continue;
        }
        let primary_flag = obj
            .get("primary")
            .or_else(|| obj.get("Primary"))
            .or_else(|| obj.get("Primary Wavelength"))
            .or_else(|| obj.get("isPrimary"))
            .or_else(|| obj.get("primaryWavelength"))
            .or_else(|| obj.get("primary_flag"))
            .map(primary_flag_truthy)
            .unwrap_or(false);
        if primary_flag {
            return wl;
        }
    }

    let d_line = 0.5875618_f64;
    source_rows
        .iter()
        .filter_map(|row| {
            row.as_object()
                .and_then(|obj| obj.get("wavelength").or_else(|| obj.get("Wavelength")))
                .and_then(value_to_f64)
                .filter(|wl| wl.is_finite() && *wl > 0.0)
        })
        .min_by(|a, b| {
            ((*a) - d_line)
                .abs()
                .partial_cmp(&(((*b) - d_line).abs()))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(d_line)
}

fn primary_flag_truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64().map(|x| x == 1).unwrap_or(false),
        _ => {
            let s = value_to_string(Some(v))
                .trim()
                .to_ascii_lowercase();
            s == "1"
                || s == "true"
                || s == "yes"
                || s == "on"
                || s == "primary"
                || s == "primary wavelength"
                || s.contains("primary")
        }
    }
}

fn parse_spot_ray_count(param4: &str) -> u32 {
    let raw = param4.trim();
    let parsed = raw.parse::<f64>().ok().map(|n| n.floor() as i64);
    let mut ray_count = parsed.unwrap_or(501);
    if ray_count < 1 {
        ray_count = 501;
    }
    if ray_count > 5000 {
        ray_count = 5000;
    }
    ray_count as u32
}

fn parse_ta_rms_ray_count(param4: &str) -> u32 {
    let raw = param4.trim();
    let parsed = raw.parse::<f64>().ok().map(|n| n.floor() as i64);
    let mut ray_count = parsed.unwrap_or(51);
    if ray_count < 3 {
        ray_count = 51;
    }
    if ray_count > 5000 {
        ray_count = 5000;
    }
    ray_count as u32
}

fn select_object_rows_for_requirement(object_rows: &[Value], param2: &str) -> Vec<Value> {
    let idx = parse_usize_str(param2).unwrap_or(1);
    if object_rows.is_empty() {
        return Vec::new();
    }
    if idx == 0 {
        return object_rows.to_vec();
    }
    let i0 = idx.saturating_sub(1);
    if i0 < object_rows.len() {
        return vec![object_rows[i0].clone()];
    }
    object_rows.to_vec()
}

fn collect_invalid_requirements(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    requirements: &[RequirementSpec],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for req in requirements {
        if !req.enabled {
            continue;
        }
        let raw = evaluate_operand_value(rows, source_rows, object_rows, req);
        let (ok, _) = sanitize_operand_current(raw);
        if !ok {
            out.push(req.operand.clone());
        }
    }
    out
}

fn first_row_value(rows: &[Value], field_key: &str) -> Option<f64> {
    rows.first()
        .and_then(Value::as_object)
        .and_then(|o| o.get(field_key))
        .and_then(parse_number)
}

fn sum_finite_thickness(rows: &[Value]) -> f64 {
    rows.iter()
        .filter_map(Value::as_object)
        .filter_map(|obj| obj.get("thickness"))
        .filter_map(parse_number)
        .filter(|v| v.is_finite())
        .map(f64::abs)
        .sum::<f64>()
}

fn sanitize_operand_current(raw: Option<f64>) -> (bool, f64) {
    let Some(v) = raw else {
        return (false, f64::NAN);
    };
    if !v.is_finite() {
        return (false, f64::NAN);
    }
    if v.abs() >= INVALID_OPERAND_ABS_LIMIT {
        return (false, f64::NAN);
    }
    (true, v)
}

fn compute_violation_amount(op: &str, current: f64, target: f64, tol: f64) -> f64 {
    let z = tol.max(0.0);
    if op == "<=" {
        (current - (target + z)).max(0.0)
    } else if op == "<" {
        (current - target).max(0.0)
    } else if op == ">=" {
        ((target - z) - current).max(0.0)
    } else if op == ">" {
        (target - current).max(0.0)
    } else {
        (current - target).abs().saturating_sub(z)
    }
}

trait SaturatingSub {
    fn saturating_sub(self, rhs: Self) -> Self;
}

impl SaturatingSub for f64 {
    fn saturating_sub(self, rhs: Self) -> Self {
        (self - rhs).max(0.0)
    }
}

fn is_variable_flag(v: &Value) -> bool {
    match v {
        Value::String(s) => {
            let t = s.trim();
            t.eq_ignore_ascii_case("v")
                || t.eq_ignore_ascii_case("true")
                || t == "1"
        }
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64().unwrap_or_default() != 0,
        _ => false,
    }
}

fn optimize_key_to_target_field(key: &str) -> String {
    let key_norm = key.trim();
    let suffix = key_norm
        .strip_prefix("optimize")
        .or_else(|| key_norm.strip_prefix("__cooptGapOptimize"))
        .unwrap_or("")
        .trim();

    if suffix.is_empty() {
        return "".to_string();
    }

    let upper = suffix.to_ascii_uppercase();
    if upper == "R" || upper == "RADIUS" {
        return "radius".to_string();
    }
    if upper == "T" || upper == "THICKNESS" {
        return "thickness".to_string();
    }
    if upper == "CONIC" {
        return "conic".to_string();
    }
    if upper == "SEMIDIA" {
        return "semidia".to_string();
    }
    if upper.starts_with("COEF") {
        let idx = upper.trim_start_matches("COEF");
        if !idx.is_empty() && idx.chars().all(|c| c.is_ascii_digit()) {
            return format!("coef{}", idx);
        }
    }

    let mut chars = suffix.chars();
    let first = chars.next().unwrap_or_default().to_ascii_lowercase();
    let mut target = String::new();
    target.push(first);
    target.push_str(chars.as_str());
    target
}

fn get_numeric_field(rows: &[Value], row_index: usize, field_key: &str) -> Option<f64> {
    let row = rows.get(row_index)?;
    let obj = row.as_object()?;
    obj.get(field_key).and_then(parse_number)
}

fn set_numeric_field(rows: &mut [Value], row_index: usize, field_key: &str, value: f64) {
    if !value.is_finite() || field_key.is_empty() {
        return;
    }
    let Some(row) = rows.get_mut(row_index) else {
        return;
    };
    let Some(obj) = row.as_object_mut() else {
        return;
    };

    let should_store_as_string = obj
        .get(field_key)
        .map(|v| matches!(v, Value::String(_)))
        .unwrap_or(false);

    if should_store_as_string {
        obj.insert(field_key.to_string(), Value::String(format_float_for_cell(value)));
    } else {
        obj.insert(field_key.to_string(), Value::from(value));
    }
}

fn format_float_for_cell(v: f64) -> String {
    let s = format!("{:.12}", v);
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-0" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
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

fn parse_usize_value(v: &Value) -> Option<usize> {
    match v {
        Value::Number(n) => n.as_u64().map(|x| x as usize),
        Value::String(s) => parse_usize_str(s),
        _ => None,
    }
}

fn parse_usize_str(s: &str) -> Option<usize> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    t.parse::<usize>().ok()
}

fn parse_number_from_str(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok()
}

fn value_to_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => parse_number_from_str(s),
        _ => None,
    }
}

fn value_to_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        _ => "".to_string(),
    }
}

fn value_to_bool_default_true(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_i64().unwrap_or(1) != 0,
        Some(Value::String(s)) => {
            let t = s.trim().to_lowercase();
            if t.is_empty() {
                true
            } else if t == "false" || t == "0" || t == "no" || t == "off" {
                false
            } else {
                true
            }
        }
        _ => true,
    }
}

fn to_finite_number(v: Option<&Value>, default: f64) -> f64 {
    let Some(x) = v.and_then(parse_number) else {
        return default;
    };
    if x.is_finite() { x } else { default }
}
