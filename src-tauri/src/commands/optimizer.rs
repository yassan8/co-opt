use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;
use tauri::AppHandle;

use crate::commands::analysis::{compute_paraxial_metrics, run_native_seidel, NativeSeidelRequest};
use crate::commands::optics::{
    aspheric_sag, compute_finite_opd_grid_rms_waves, compute_native_chief_ray_angle_deg,
    compute_native_transverse_rms_batch, reduce_native_transverse_rms_stats, run_native_opd_map,
    run_native_spherical_aberration, run_native_spot_raytrace, run_native_transverse_rms_um,
    NativeOpdMapRequest, NativeSphericalAberrationPoint, NativeSphericalAberrationRequest,
    NativeSphericalAberrationSeries, NativeSpotRaytraceRequest, NativeTransverseAberrationSeries,
    NativeTransverseRmsRequest,
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
const KKT_LINESEARCH_C: f64 = 1e-4;
const KKT_LINESEARCH_RHO: f64 = 0.5;
const KKT_LINESEARCH_MAX_BACKTRACK: usize = 20;
const KKT_FILTER_ACCEPTANCE_C: f64 = 0.05;
const KKT_INITIAL_PENALTY: f64 = 1.0;
const KKT_PENALTY_INCREASE_FACTOR: f64 = 1.5;

static OPTIMIZER_STOP_REQUESTED: AtomicBool = AtomicBool::new(false);
static OPTIMIZER_SESSIONS: LazyLock<Mutex<HashMap<String, OptimizerSessionState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static OPTIMIZER_PROFILE: LazyLock<Mutex<Option<OptimizerProfileAccumulator>>> =
    LazyLock::new(|| Mutex::new(None));
static OPTIMIZER_APP_HANDLE: LazyLock<Mutex<Option<AppHandle>>> =
    LazyLock::new(|| Mutex::new(None));
static OPTIMIZER_SYSTEM_CONFIG: LazyLock<Mutex<Option<Value>>> = LazyLock::new(|| Mutex::new(None));

struct OptimizerAppHandleGuard;
struct OptimizerSystemConfigGuard;

impl OptimizerAppHandleGuard {
    fn install(app: AppHandle) -> Self {
        if let Ok(mut slot) = OPTIMIZER_APP_HANDLE.lock() {
            *slot = Some(app);
        }
        Self
    }
}

impl Drop for OptimizerAppHandleGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = OPTIMIZER_APP_HANDLE.lock() {
            *slot = None;
        }
    }
}

impl OptimizerSystemConfigGuard {
    fn install(system_config: Option<Value>) -> Self {
        if let Ok(mut slot) = OPTIMIZER_SYSTEM_CONFIG.lock() {
            *slot = system_config;
        }
        Self
    }
}

impl Drop for OptimizerSystemConfigGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = OPTIMIZER_SYSTEM_CONFIG.lock() {
            *slot = None;
        }
    }
}

fn with_optimizer_app_handle<R>(f: impl FnOnce(&AppHandle) -> R) -> Option<R> {
    OPTIMIZER_APP_HANDLE
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(f))
}

fn with_optimizer_system_config<R>(f: impl FnOnce(&Value) -> R) -> Option<R> {
    OPTIMIZER_SYSTEM_CONFIG
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(f))
}

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
    best_eval: Option<EvalState>,
    best_rows: Vec<Value>,
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
    pub system_config_snapshot: Option<Value>,
    pub system_requirements_rows: Option<Vec<Value>>,
    pub session_id: Option<String>,
    pub reset_session: Option<bool>,
    pub max_iterations: Option<u32>,
    pub method: Option<String>,
    pub emit_progress: Option<bool>,
    pub profile: Option<bool>,
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
    pub feasible: Option<bool>,
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
    pub profile: Option<OptimizeProfileReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeOperandProfileEntry {
    pub key: String,
    pub operand: String,
    pub count: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    pub total_ms: f64,
    pub avg_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeProfileReport {
    pub evaluate_state_calls: u64,
    pub requirement_passes: u64,
    pub operand_entries: Vec<OptimizeOperandProfileEntry>,
}

#[derive(Clone, Default)]
struct OptimizeOperandProfileAccum {
    operand: String,
    count: u64,
    cache_hits: u64,
    cache_misses: u64,
    total_nanos: u128,
    max_nanos: u128,
}

#[derive(Default)]
struct OptimizerProfileAccumulator {
    evaluate_state_calls: u64,
    requirement_passes: u64,
    operand_entries: HashMap<String, OptimizeOperandProfileAccum>,
}

impl OptimizerProfileAccumulator {
    fn into_report(self) -> OptimizeProfileReport {
        let mut operand_entries = self
            .operand_entries
            .into_iter()
            .map(|(key, entry)| {
                let total_ms = entry.total_nanos as f64 / 1_000_000.0;
                let avg_ms = if entry.count > 0 {
                    total_ms / entry.count as f64
                } else {
                    0.0
                };
                OptimizeOperandProfileEntry {
                    key,
                    operand: entry.operand,
                    count: entry.count,
                    cache_hits: entry.cache_hits,
                    cache_misses: entry.cache_misses,
                    total_ms,
                    avg_ms,
                    max_ms: entry.max_nanos as f64 / 1_000_000.0,
                }
            })
            .collect::<Vec<_>>();
        operand_entries.sort_by(|a, b| {
            b.total_ms
                .partial_cmp(&a.total_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        OptimizeProfileReport {
            evaluate_state_calls: self.evaluate_state_calls,
            requirement_passes: self.requirement_passes,
            operand_entries,
        }
    }
}

fn optimizer_profile_begin(enabled: bool) {
    if let Ok(mut slot) = OPTIMIZER_PROFILE.lock() {
        *slot = if enabled {
            Some(OptimizerProfileAccumulator::default())
        } else {
            None
        };
    }
}

fn optimizer_profile_finish() -> Option<OptimizeProfileReport> {
    OPTIMIZER_PROFILE
        .lock()
        .ok()
        .and_then(|mut slot| slot.take().map(OptimizerProfileAccumulator::into_report))
}

fn optimizer_profile_record_evaluate_state() {
    if let Ok(mut slot) = OPTIMIZER_PROFILE.lock() {
        if let Some(accum) = slot.as_mut() {
            accum.evaluate_state_calls += 1;
        }
    }
}

fn optimizer_profile_record_requirement_pass() {
    if let Ok(mut slot) = OPTIMIZER_PROFILE.lock() {
        if let Some(accum) = slot.as_mut() {
            accum.requirement_passes += 1;
        }
    }
}

fn optimizer_profile_record_cache_hit(cache_key: &str, operand: &str) {
    if let Ok(mut slot) = OPTIMIZER_PROFILE.lock() {
        if let Some(accum) = slot.as_mut() {
            let entry = accum
                .operand_entries
                .entry(cache_key.to_string())
                .or_default();
            if entry.operand.is_empty() {
                entry.operand = operand.to_string();
            }
            entry.cache_hits += 1;
        }
    }
}

fn optimizer_profile_record_operand_eval(cache_key: &str, operand: &str, elapsed_nanos: u128) {
    if let Ok(mut slot) = OPTIMIZER_PROFILE.lock() {
        if let Some(accum) = slot.as_mut() {
            let entry = accum
                .operand_entries
                .entry(cache_key.to_string())
                .or_default();
            if entry.operand.is_empty() {
                entry.operand = operand.to_string();
            }
            entry.count += 1;
            entry.cache_misses += 1;
            entry.total_nanos += elapsed_nanos;
            entry.max_nanos = entry.max_nanos.max(elapsed_nanos);
        }
    }
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
    cache_key: String,
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
pub fn run_optimizer_step(
    app: AppHandle,
    req: OptimizeStepRequest,
) -> Result<OptimizeStepResponse, String> {
    let _app_guard = OptimizerAppHandleGuard::install(app);
    let _system_config_guard =
        OptimizerSystemConfigGuard::install(req.system_config_snapshot.clone());
    let enable_profile = req.profile.unwrap_or(false);
    optimizer_profile_begin(enable_profile);

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

    let invalid_requirements =
        collect_invalid_requirements(&rows, &source_rows, &object_rows, &requirements);
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
            feasible: Some(
                before_eval.violation_score.is_finite() && before_eval.violation_score <= 1e-9,
            ),
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
                feasible: Some(
                    before_eval.violation_score.is_finite() && before_eval.violation_score <= 1e-9,
                ),
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
            profile: optimizer_profile_finish(),
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
            profile: optimizer_profile_finish(),
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

    let mut overall_best_eval = best_eval;
    let mut overall_best_rows = rows.clone();

    if let Some(sid) = session_id.as_ref() {
        if let Ok(mut map) = OPTIMIZER_SESSIONS.lock() {
            let mut step_by_var_id = HashMap::new();
            for v in &vars {
                step_by_var_id.insert(v.id.clone(), v.step);
            }
            let mut st = map.get(sid).cloned().unwrap_or_default();
            if let Some(previous_best_eval) = st.best_eval {
                if is_better_eval(previous_best_eval, overall_best_eval) && !st.best_rows.is_empty()
                {
                    overall_best_eval = previous_best_eval;
                    overall_best_rows = st.best_rows.clone();
                }
            }
            st.step_by_var_id = step_by_var_id;
            if let Some(kkt_state) = kkt_final_state {
                st.kkt = kkt_state;
            }
            st.best_eval = Some(overall_best_eval);
            st.best_rows = overall_best_rows.clone();
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
            current: overall_best_eval.score,
            best: overall_best_eval.score,
            accepted: true,
            message: Some("optimizer done".to_string()),
            variable_id: None,
            method: Some(mode_used.clone()),
            violation_score: Some(overall_best_eval.violation_score),
            soft_penalty: Some(0.0),
            requirement_count: Some(requirements.len()),
            residual_count: Some(requirements.len()),
            rho: None,
            feasible: Some(
                overall_best_eval.violation_score.is_finite()
                    && overall_best_eval.violation_score <= 1e-9,
            ),
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
        overall_best_eval.score,
        invalid_requirements.len(),
        invalid_ops_preview
    );

    Ok(OptimizeStepResponse {
        iterations: completed_iterations,
        variable_count,
        merit_before: before_eval.score,
        merit_after: overall_best_eval.score,
        converged,
        mode_used,
        requirement_score_before: before_eval.requirement_score,
        requirement_score_after: overall_best_eval.requirement_score,
        optimized_rows: overall_best_rows,
        progress_events: events,
        message,
        profile: optimizer_profile_finish(),
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
                        feasible: Some(
                            best_eval.violation_score.is_finite()
                                && best_eval.violation_score <= 1e-9,
                        ),
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
                        feasible: Some(
                            best_eval.violation_score.is_finite()
                                && best_eval.violation_score <= 1e-9,
                        ),
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
                    feasible: Some(
                        best_eval.violation_score.is_finite() && best_eval.violation_score <= 1e-9,
                    ),
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
                    feasible: Some(
                        best_eval.violation_score.is_finite() && best_eval.violation_score <= 1e-9,
                    ),
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
    let mut rho = if state.rho.is_finite() && state.rho > 0.0 {
        state.rho
    } else {
        tuning.penalty_parameter
    };
    let mut stall_count = state.stall_count;
    let mut mu_total = if state.mu_total.is_finite() && state.mu_total >= 0.0 {
        state.mu_total
    } else {
        0.0
    };
    let mut penalty = if state.penalty.is_finite() && state.penalty > 0.0 {
        state.penalty
    } else {
        rho
    };
    let mut hdiag = state.hdiag;
    let mut prev_x = state.prev_x;
    let mut prev_grad = state.prev_grad;

    if vars.is_empty() {
        return (
            "kkt".to_string(),
            0,
            best_eval,
            Some(KktRuntimeState {
                rho,
                stall_count,
                mu_total,
                penalty,
                hdiag,
                prev_x,
                prev_grad,
            }),
        );
    }

    // Track the minimum requirement-score state separately from the last
    // accepted iterate. The augmented-Lagrangian filter can accept a step that
    // raises the raw requirement score (to reduce constraint violation), so the
    // final accepted state is not always the best. We restore this snapshot at
    // the end so the applied optical system matches the reported best score.
    let mut best_score_eval = best_eval;
    let mut best_score_values = current_values(rows, vars);

    for iter in 1..=iterations_max {
        if is_stop_requested() {
            break;
        }
        completed_iterations = iter;
        let base_values = current_values(rows, vars);
        let grad = approximate_augmented_gradient(
            rows,
            source_rows,
            object_rows,
            vars,
            requirements,
            penalty,
        );
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
        let (mut direction, mut direction_reason, mut used_sqp_direction, mut predicted_reduction) =
            match sqp_direction {
                Ok(d) => (
                    d.direction,
                    "sqp-ok".to_string(),
                    true,
                    d.predicted_reduction,
                ),
                Err(reason) => (
                    grad.iter().map(|g| -g).collect(),
                    reason.to_string(),
                    false,
                    f64::NAN,
                ),
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
        let filter_c = KKT_FILTER_ACCEPTANCE_C;

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
            LineSearchResult::Accepted {
                eval: trial_eval,
                alpha,
            } => {
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
            if best_eval.score < best_score_eval.score - 1e-12 {
                best_score_eval = best_eval;
                best_score_values = current_values(rows, vars);
            }
            stall_count = 0;
            // ALM-style multiplier and penalty updates.
            mu_total = (mu_total + penalty * best_eval.violation_score)
                .max(0.0)
                .min(1e12);
            if best_eval.violation_score > (0.9 * prev_violation) {
                penalty = (penalty * tuning.penalty_increase_factor).min(1e6);
            } else if best_eval.violation_score < (0.5 * prev_violation) {
                penalty = (penalty * 0.9).max(1e-6);
            }
            rho = penalty;
            let penalty_tag = if rho >= 999_999.0 {
                " [penalty-capped]"
            } else {
                ""
            };
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
                        format!(
                            "kkt sqp-armijo accepted ({}, {}){}",
                            direction_reason, ls_reason, penalty_tag
                        )
                    } else {
                        format!(
                            "kkt grad-armijo accepted ({}, {}){}",
                            direction_reason, ls_reason, penalty_tag
                        )
                    }),
                    variable_id: None,
                    method: Some("kkt".to_string()),
                    violation_score: Some(best_eval.violation_score),
                    soft_penalty: Some(0.0),
                    requirement_count: Some(requirements.len()),
                    residual_count: Some(requirements.len()),
                    rho: Some(rho),
                    feasible: Some(
                        best_eval.violation_score.is_finite() && best_eval.violation_score <= 1e-9,
                    ),
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
                if best_eval.score < best_score_eval.score - 1e-12 {
                    best_score_eval = best_eval;
                    best_score_values = current_values(rows, vars);
                }
                stall_count = 0;
                let penalty_tag = if rho >= 999_999.0 {
                    " [penalty-capped]"
                } else {
                    ""
                };
                prev_x = base_values;
                prev_grad = grad;
                if emit_progress {
                    events.push(OptimizeProgressEvent {
                        phase: "accept".to_string(),
                        iter,
                        current: best_eval.score,
                        best: best_eval.score,
                        accepted: true,
                        message: Some(format!(
                            "kkt fallback-cd accepted ({}, {}){}",
                            direction_reason, ls_reason, penalty_tag
                        )),
                        variable_id: None,
                        method: Some("kkt".to_string()),
                        violation_score: Some(best_eval.violation_score),
                        soft_penalty: Some(0.0),
                        requirement_count: Some(requirements.len()),
                        residual_count: Some(requirements.len()),
                        rho: Some(rho),
                        feasible: Some(
                            best_eval.violation_score.is_finite()
                                && best_eval.violation_score <= 1e-9,
                        ),
                    });
                }
            } else {
                stall_count += 1;
                penalty = (penalty * tuning.penalty_increase_factor).min(1e6);
                rho = penalty;
                let penalty_tag = if rho >= 999_999.0 {
                    " [penalty-capped]"
                } else {
                    ""
                };
                if emit_progress {
                    events.push(OptimizeProgressEvent {
                        phase: "reject".to_string(),
                        iter,
                        current: best_eval.score,
                        best: best_eval.score,
                        accepted: false,
                        message: Some(format!(
                            "kkt step rejected ({}, {}){}",
                            direction_reason, ls_reason, penalty_tag
                        )),
                        variable_id: None,
                        method: Some("kkt".to_string()),
                        violation_score: Some(best_eval.violation_score),
                        soft_penalty: Some(0.0),
                        requirement_count: Some(requirements.len()),
                        residual_count: Some(requirements.len()),
                        rho: Some(rho),
                        feasible: Some(
                            best_eval.violation_score.is_finite()
                                && best_eval.violation_score <= 1e-9,
                        ),
                    });
                }
                if stall_count >= STALL_LIMIT {
                    break;
                }
            }
        }
    }

    // Restore the minimum requirement-score state so callers (and the table)
    // receive the true best optical system, not merely the last accepted step.
    restore_values(rows, vars, &best_score_values);
    (
        "kkt".to_string(),
        completed_iterations,
        best_score_eval,
        Some(KktRuntimeState {
            rho,
            stall_count,
            mu_total,
            penalty,
            hdiag,
            prev_x,
            prev_grad,
        }),
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

    if accepted {
        Some(best_eval)
    } else {
        None
    }
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

fn apply_direction_step(
    rows: &mut [Value],
    vars: &[VariableSpec],
    base_values: &[f64],
    direction: &[f64],
    alpha: f64,
) {
    for i in 0..vars.len() {
        let x0 = *base_values.get(i).unwrap_or(&vars[i].baseline);
        let d = *direction.get(i).unwrap_or(&0.0);
        let x1 = x0 + alpha * d;
        set_numeric_field(rows, vars[i].row_index, &vars[i].field_key, x1);
    }
}

fn augmented_cost(eval: EvalState, mu_total: f64, penalty: f64) -> f64 {
    eval.score
        + mu_total * eval.violation_score
        + 0.5 * penalty * eval.violation_score * eval.violation_score
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

fn apply_trial_step(
    rows: &mut [Value],
    vars: &[VariableSpec],
    base_values: &[f64],
    grad: &[f64],
    alpha: f64,
) {
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
    let active =
        select_active_constraint_indices(requirements, &residuals, MAX_SQP_ACTIVE_CONSTRAINTS);
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

    let active_residuals = active
        .iter()
        .map(|&idx| residuals.get(idx).copied().unwrap_or(f64::MAX / 8.0))
        .collect::<Vec<_>>();

    let columns = (0..n)
        .into_iter()
        .map(|vi| {
            if is_stop_requested() {
                return vec![0.0_f64; m];
            }
            let v = &vars[vi];
            let x0 = base_values.get(vi).copied().unwrap_or(v.baseline);
            let h = (v.scale * 1e-3).max(MIN_STEP);
            let mut trial_rows = rows.to_vec();
            set_numeric_field(&mut trial_rows, v.row_index, &v.field_key, x0 + h);
            let perturbed = evaluate_active_constraint_residuals(
                &trial_rows,
                source_rows,
                object_rows,
                requirements,
                &active,
            );
            perturbed
                .iter()
                .enumerate()
                .map(|(ri, &r1)| {
                    let r0 = active_residuals.get(ri).copied().unwrap_or(f64::MAX / 8.0);
                    let dr = (r1 - r0) / h;
                    if dr.is_finite() {
                        dr
                    } else {
                        0.0
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    restore_values(rows, vars, base_values);

    if is_stop_requested() {
        return Err("sqp-stop-requested");
    }

    let mut a = vec![vec![0.0_f64; n]; m];
    for vi in 0..n {
        let col = columns.get(vi).ok_or("sqp-jacobian-column-missing")?;
        for ri in 0..m {
            a[ri][vi] = col.get(ri).copied().unwrap_or(0.0);
        }
    }

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
        out.push(evaluate_constraint_residual_for_requirement(
            rows,
            source_rows,
            object_rows,
            req,
        ));
    }
    out
}

fn evaluate_active_constraint_residuals(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    requirements: &[RequirementSpec],
    active_indices: &[usize],
) -> Vec<f64> {
    active_indices
        .iter()
        .map(|&idx| {
            requirements
                .get(idx)
                .map(|req| {
                    evaluate_constraint_residual_for_requirement(
                        rows,
                        source_rows,
                        object_rows,
                        req,
                    )
                })
                .unwrap_or(f64::MAX / 8.0)
        })
        .collect()
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
    let e0 = evaluate_state(rows, source_rows, object_rows, vars, requirements);
    let f0 = e0.score + rho * e0.violation_score * e0.violation_score;
    let base_values = current_values(rows, vars);

    vars.iter()
        .enumerate()
        .map(|(i, v)| {
            if is_stop_requested() {
                return 0.0;
            }
            let x0 = base_values.get(i).copied().unwrap_or(v.baseline);
            let h = (v.scale * 1e-3).max(MIN_STEP);
            let mut trial_rows = rows.to_vec();
            set_numeric_field(&mut trial_rows, v.row_index, &v.field_key, x0 + h);
            let e1 = evaluate_state(&trial_rows, source_rows, object_rows, vars, requirements);
            let f1 = e1.score + rho * e1.violation_score * e1.violation_score;
            let g = if f1.is_finite() && f0.is_finite() {
                (f1 - f0) / h
            } else {
                0.0
            };
            if g.is_finite() {
                g
            } else {
                0.0
            }
        })
        .collect()
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
            if !(key_norm.starts_with("optimize") || key_norm.starts_with("__cooptGapOptimize"))
                || !is_variable_flag(value)
            {
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
            let op = normalize_op(value_to_string(r.get("op")));
            let param1 = value_to_string(r.get("param1"));
            let param2 = value_to_string(r.get("param2"));
            let param3 = value_to_string(r.get("param3"));
            let param4 = value_to_string(r.get("param4"));
            let param5 = value_to_string(r.get("param5"));
            Some(RequirementSpec {
                id: value_to_string(r.get("id")),
                config_id: req_config_id,
                enabled,
                cache_key: build_requirement_cache_key(
                    &operand, &param1, &param2, &param3, &param4, &param5, &op,
                ),
                operand,
                op,
                target: to_finite_number(r.get("target"), 0.0),
                tol: to_finite_number(r.get("tol"), 0.0).max(0.0),
                weight,
                param1,
                param2,
                param3,
                param4,
                param5,
            })
        })
        .collect()
}

fn build_requirement_cache_key(
    operand: &str,
    param1: &str,
    param2: &str,
    param3: &str,
    param4: &str,
    param5: &str,
    op: &str,
) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        operand, param1, param2, param3, param4, param5, op
    )
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
    optimizer_profile_record_evaluate_state();
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
    let (requirement_score, violation_score) =
        evaluate_requirements(rows, source_rows, object_rows, requirements);
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

fn evaluate_requirements(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    requirements: &[RequirementSpec],
) -> (f64, f64) {
    optimizer_profile_record_requirement_pass();
    let mut score = 0.0_f64;
    let mut violation_score = 0.0_f64;
    let mut operand_cache: HashMap<&str, Option<f64>> = HashMap::with_capacity(requirements.len());
    let mut prefetched_cache_keys = prefill_batched_transverse_rms_cache(
        rows,
        source_rows,
        object_rows,
        requirements,
        &mut operand_cache,
    );
    prefetched_cache_keys.extend(prefill_parallel_opd_rms_cache(
        rows,
        source_rows,
        object_rows,
        requirements,
        &mut operand_cache,
    ));

    for req in requirements {
        if is_stop_requested() {
            break;
        }
        if !req.enabled {
            continue;
        }

        let cache_key = req.cache_key.as_str();
        let raw_current = if let Some(v) = operand_cache.get(cache_key) {
            if !prefetched_cache_keys.contains(cache_key) {
                optimizer_profile_record_cache_hit(cache_key, &req.operand);
            }
            *v
        } else {
            let t0 = Instant::now();
            let v = evaluate_operand_value(rows, source_rows, object_rows, req);
            optimizer_profile_record_operand_eval(cache_key, &req.operand, t0.elapsed().as_nanos());
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

fn evaluate_operand_value(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req: &RequirementSpec,
) -> Option<f64> {
    match req.operand.as_str() {
        "OBJD" => first_row_value(rows, "thickness"),
        "TSL" => Some(sum_finite_thickness(rows)),
        "CTCT" => resolve_surface_row_by_param1(rows, &req.param1)
            .and_then(|(_, obj)| obj.get("thickness").and_then(parse_number)),

        // ── Paraxial metrics (proper ray tracing via analysis.rs) ──
        "FL" | "EFL" | "BFL" | "IMD" | "BEXP" | "EXPD" | "EXPP" | "ENPD" | "ENPP" | "ENPM"
        | "PMAG" | "FNO_OBJ" | "FNO_IMG" | "FNO_WRK" | "NA_OBJ" | "NA_IMG" => {
            let m = compute_paraxial_metrics(rows, source_rows, object_rows);
            let v = match req.operand.as_str() {
                "FL" => m.fl,
                "EFL" => m.efl,
                "BFL" => m.bfl,
                "IMD" => m.imd,
                "BEXP" => m.bexp,
                "EXPD" => m.expd,
                "EXPP" => m.expp,
                "ENPD" => m.enpd,
                "ENPP" => m.enpp,
                "ENPM" => m.enpm,
                "PMAG" => m.pmag,
                "FNO_OBJ" => m.fno_obj,
                "FNO_IMG" => m.fno_img,
                "FNO_WRK" => m.fno_wrk,
                "NA_OBJ" => m.na_obj,
                "NA_IMG" => m.na_img,
                _ => 0.0,
            };
            Some(v)
        }

        "EFFL" => native_effective_focal_length_for_range(rows, source_rows, object_rows, req),
        "PP1" => native_principal_point_for_range(rows, source_rows, object_rows, req, "pp1"),
        "PP2" => native_principal_point_for_range(rows, source_rows, object_rows, req, "pp2"),

        // ── Edge thickness: thickness - sag_front - sag_back (TS parity) ──
        "EDGE" => evaluate_edge_thickness(rows, req),

        "SPOT_SIZE_ANNULAR" => native_spot_size_um(rows, source_rows, object_rows, req, "annular"),
        "SPOT_SIZE_RECT" => native_spot_size_um(rows, source_rows, object_rows, req, "grid"),
        "SPOT_SIZE_CURRENT" => native_spot_size_um(rows, source_rows, object_rows, req, "annular"),
        "CRA_DEG" => native_chief_ray_angle_deg(rows, source_rows, object_rows, req),
        "TA_RMS_UM" => native_transverse_rms_um(rows, source_rows, object_rows, req),
        "OPD_RMS_WAVES" | "OPD_RMS_UM" => native_opd_rms_waves(rows, source_rows, object_rows, req),
        "ZERN_COEFF" => native_zernike_coeff(rows, source_rows, object_rows, req),
        "SA" => native_spherical_aberration_um(rows, source_rows, object_rows, req),
        "LA_RMS_UM" => native_longitudinal_aberration_rms_um(rows, source_rows, object_rows, req),
        "TOT3_SPH" => native_seidel_operand(rows, source_rows, object_rows, req, "i"),
        "TOT3_COMA" => native_seidel_operand(rows, source_rows, object_rows, req, "ii"),
        "TOT3_ASTI" => native_seidel_operand(rows, source_rows, object_rows, req, "iii"),
        "TOT3_FCUR" => native_seidel_operand(rows, source_rows, object_rows, req, "iv"),
        "TOT3_DIST" => native_seidel_operand(rows, source_rows, object_rows, req, "v"),
        "TOT3_PETZ" => native_seidel_operand(rows, source_rows, object_rows, req, "p"),
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
        height = obj
            .get("semidia")
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
            let next_material = next_obj
                .get("material")
                .and_then(|v| match v {
                    Value::String(s) => Some(s.as_str()),
                    _ => None,
                })
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if next_material == "air" {
                sag_back = compute_surface_sag(next_obj, height, &dir);
            }
        }
    }

    let edge = thickness - sag_front + sag_back;
    if edge.is_finite() {
        Some(edge)
    } else {
        None
    }
}

/// Compute aspheric sag at given height for a surface row.
fn compute_surface_sag(obj: &serde_json::Map<String, Value>, height: f64, direction: &str) -> f64 {
    let surf_type = obj
        .get("surfType")
        .or_else(|| obj.get("type"))
        .and_then(|v| match v {
            Value::String(s) => Some(s.as_str()),
            _ => None,
        })
        .unwrap_or("")
        .trim()
        .to_lowercase();

    // TS parity for EDGE on toric surfaces: respect param3 (x/y/radial)
    if surf_type == "toric" {
        let radius_x = parse_radius_allow_inf(obj.get("radiusX"));
        let radius_y = parse_radius_allow_inf(obj.get("radiusY"))
            .or_else(|| parse_radius_allow_inf(obj.get("radius")));
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
    if sag.is_finite() {
        sag
    } else {
        0.0
    }
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
    let reference_wavelength_um = source_rows_effective
        .iter()
        .filter_map(|row| row.as_object())
        .find_map(|obj| {
            obj.get("wavelength")
                .or_else(|| obj.get("Wavelength"))
                .and_then(parse_number)
                .filter(|v| v.is_finite() && *v > 0.0)
        });
    let req = NativeSeidelRequest {
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows_effective,
        object_rows: object_rows.to_vec(),
        afocal,
        reference_wavelength_um,
    };
    let resp = run_native_seidel(req).ok()?;
    let surface_target = parse_usize_str(&req_spec.param3).unwrap_or(0);
    if surface_target == 0 {
        return match term {
            "lca" => Some(resp.totals.lca),
            "tca" => Some(resp.totals.tca),
            "i" => Some(resp.totals.i),
            "ii" => Some(resp.totals.ii),
            "iii" => Some(resp.totals.iii),
            "p" => Some(resp.totals.p),
            "iv" => Some(resp.totals.iv),
            "v" => Some(resp.totals.v),
            _ => None,
        };
    }

    let coeff = resp
        .surface_coefficients
        .into_iter()
        .find(|entry| entry.surface_index == surface_target)?;
    match term {
        "lca" => Some(coeff.lca),
        "tca" => Some(coeff.tca),
        "i" => Some(coeff.i),
        "ii" => Some(coeff.ii),
        "iii" => Some(coeff.iii),
        "p" => Some(coeff.p),
        "iv" => Some(coeff.iv),
        "v" => Some(coeff.v),
        _ => None,
    }
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
    let req = NativeTransverseRmsRequest {
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows_for_wavelength_param(source_rows, &req_spec.param1),
        object_rows: select_object_rows_for_requirement(object_rows, &req_spec.param2),
        surface_index: Some(image_surface_index(rows)),
        ray_count: Some(parse_ta_rms_ray_count(&req_spec.param4)),
        ring_count: Some(10),
        pattern: Some("cross".to_string()),
        wavelength_mode: Some("primary".to_string()),
        wavelength: Some(resolve_requirement_wavelength_um(
            source_rows,
            &req_spec.param1,
        )),
        component: Some(normalize_ta_component(&req_spec.param3).to_string()),
    };

    Some(run_native_transverse_rms_um(req).ok()?.rms_um)
}

fn transverse_rms_um_from_series(
    meridional_series: Option<&NativeTransverseAberrationSeries>,
    sagittal_series: Option<&NativeTransverseAberrationSeries>,
    component: &str,
) -> Option<f64> {
    let meridional_stats = meridional_series
        .map(|series| collect_ta_stats(std::slice::from_ref(series)))
        .unwrap_or((0.0, 0));
    let sagittal_stats = sagittal_series
        .map(|series| collect_ta_stats(std::slice::from_ref(series)))
        .unwrap_or((0.0, 0));

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
    Some((sum_sq_mm / count as f64).sqrt() * 1000.0)
}

fn evaluate_batched_transverse_rms<'a>(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    requirements: &[&'a RequirementSpec],
) -> Option<Vec<(&'a RequirementSpec, Option<f64>)>> {
    let first = *requirements.first()?;
    let mut batched_object_rows = Vec::with_capacity(requirements.len());

    for req in requirements {
        let selected = select_object_rows_for_requirement(object_rows, &req.param2);
        if selected.len() != 1 {
            return None;
        }
        batched_object_rows.push(selected[0].clone());
    }

    let req = NativeTransverseRmsRequest {
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows_for_wavelength_param(source_rows, &first.param1),
        object_rows: batched_object_rows,
        surface_index: Some(image_surface_index(rows)),
        ray_count: Some(parse_ta_rms_ray_count(&first.param4)),
        ring_count: Some(10),
        pattern: Some("cross".to_string()),
        wavelength_mode: Some("primary".to_string()),
        wavelength: Some(resolve_requirement_wavelength_um(
            source_rows,
            &first.param1,
        )),
        component: Some("total".to_string()),
    };

    let batch = compute_native_transverse_rms_batch(req).ok()?;
    if batch.stats.len() < requirements.len() {
        return None;
    }

    Some(
        requirements
            .iter()
            .enumerate()
            .map(|(idx, req_spec)| {
                (
                    *req_spec,
                    batch.stats.get(idx).and_then(|stats| {
                        reduce_native_transverse_rms_stats(
                            stats,
                            normalize_ta_component(&req_spec.param3),
                        )
                    }),
                )
            })
            .collect(),
    )
}

fn prefill_batched_transverse_rms_cache<'a>(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    requirements: &'a [RequirementSpec],
    operand_cache: &mut HashMap<&'a str, Option<f64>>,
) -> HashSet<&'a str> {
    let mut prefetched = HashSet::new();
    let mut groups: HashMap<String, Vec<&RequirementSpec>> = HashMap::new();

    for req in requirements {
        if !req.enabled || req.operand != "TA_RMS_UM" {
            continue;
        }
        let group_key = format!("{}|{}", req.param1, req.param4);
        groups.entry(group_key).or_default().push(req);
    }

    for group in groups.into_values() {
        if group.len() < 2 {
            continue;
        }
        let t0 = Instant::now();
        let Some(results) = evaluate_batched_transverse_rms(rows, source_rows, object_rows, &group)
        else {
            continue;
        };
        let elapsed_nanos = t0.elapsed().as_nanos();
        let share_nanos = elapsed_nanos / (results.len().max(1) as u128);

        for (req, value) in results {
            let cache_key = req.cache_key.as_str();
            operand_cache.insert(cache_key, value);
            prefetched.insert(cache_key);
            optimizer_profile_record_operand_eval(cache_key, &req.operand, share_nanos);
        }
    }

    prefetched
}

fn prefill_parallel_opd_rms_cache<'a>(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    requirements: &'a [RequirementSpec],
    operand_cache: &mut HashMap<&'a str, Option<f64>>,
) -> HashSet<&'a str> {
    let mut prefetched = HashSet::new();
    let mut groups: HashMap<String, Vec<&RequirementSpec>> = HashMap::new();

    for req in requirements {
        if !req.enabled || (req.operand != "OPD_RMS_WAVES" && req.operand != "OPD_RMS_UM") {
            continue;
        }
        let group_key = format!("{}|{}", req.param1, req.param3);
        groups.entry(group_key).or_default().push(req);
    }

    for group in groups.into_values() {
        if group.len() < 2 {
            continue;
        }
        let results: Vec<(&RequirementSpec, Option<f64>, u128)> = group
            .iter()
            .map(|req| {
                let t0 = Instant::now();
                let value = native_opd_rms_waves(rows, source_rows, object_rows, req);
                (*req, value, t0.elapsed().as_nanos())
            })
            .collect();

        for (req, value, elapsed_nanos) in results {
            let cache_key = req.cache_key.as_str();
            operand_cache.insert(cache_key, value);
            prefetched.insert(cache_key);
            optimizer_profile_record_operand_eval(cache_key, &req.operand, elapsed_nanos);
        }
    }

    prefetched
}

fn native_spherical_aberration_um(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
) -> Option<f64> {
    let wavelength = resolve_requirement_wavelength_um(source_rows, &req_spec.param1);
    let series =
        run_native_spherical_aberration_for_requirement(rows, source_rows, object_rows, req_spec)?;
    let points = series_points_for_wavelength(&series, wavelength)?;
    let paraxial = points.first()?.longitudinal_aberration;
    let marginal = points.last()?.longitudinal_aberration;
    Some((marginal - paraxial).abs() * 1000.0)
}

fn native_longitudinal_aberration_rms_um(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
) -> Option<f64> {
    let wavelength = resolve_requirement_wavelength_um(source_rows, &req_spec.param1);
    let series =
        run_native_spherical_aberration_for_requirement(rows, source_rows, object_rows, req_spec)?;
    let points = series_points_for_wavelength(&series, wavelength)?;
    if points.len() < 2 {
        return None;
    }

    let mut sum_weighted_l = 0.0;
    let mut sum_weighted_l2 = 0.0;
    let mut sum_weight = 0.0;
    for i in 1..points.len() {
        let r = points[i].pupil_coordinate;
        let l = points[i].longitudinal_aberration;
        let r_prev = points[i - 1].pupil_coordinate;
        let weight = 2.0 * r * (r - r_prev);
        sum_weighted_l += weight * l;
        sum_weighted_l2 += weight * l * l;
        sum_weight += weight;
    }

    if !sum_weight.is_finite() || sum_weight.abs() <= 1e-12 {
        return Some(0.0);
    }

    let mean_l = sum_weighted_l / sum_weight;
    let variance = (sum_weighted_l2 / sum_weight) - mean_l * mean_l;
    Some(variance.max(0.0).sqrt() * 1000.0)
}

fn native_opd_rms_waves(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
) -> Option<f64> {
    let app = with_optimizer_app_handle(Clone::clone)?;
    let wavelength_um = resolve_requirement_wavelength_um(source_rows, &req_spec.param1);
    let object_index1 = parse_usize_str(&req_spec.param2).unwrap_or(1).max(1);
    let object_index0 = object_index1.saturating_sub(1);
    if object_rows.get(object_index0).is_none() {
        return None;
    }
    let grid_size = parse_usize_str(&req_spec.param3)
        .map(|v| v.max(8).min(512) as u32)
        .unwrap_or(32);
    let req = NativeOpdMapRequest {
        job_id: None,
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows_for_wavelength_param(source_rows, &req_spec.param1),
        object_rows: object_rows.to_vec(),
        object_index: Some(object_index0),
        surface_index: Some(image_surface_index(rows)),
        grid_size: Some(grid_size),
        wavelength_um: Some(wavelength_um),
        pupil_radius_mm: None,
        pupil_sampling_mode: None,
        opd_display_mode: Some("pistonTiltRemoved".to_string()),
    };
    let resp = run_native_opd_map(req, app).ok()?;
    compute_finite_opd_grid_rms_waves(&resp.display_opd_grid)
}

fn native_zernike_coeff(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
) -> Option<f64> {
    let app = with_optimizer_app_handle(Clone::clone)?;
    let wavelength_um = resolve_requirement_wavelength_um(source_rows, &req_spec.param1);
    let object_index1 = parse_usize_str(&req_spec.param2).unwrap_or(1).max(1);
    let object_index0 = object_index1.saturating_sub(1);
    if object_rows.get(object_index0).is_none() {
        return None;
    }
    let unit = parse_zernike_unit(&req_spec.param3);
    let grid_size = parse_usize_str(&req_spec.param4)
        .map(|v| v.max(8).min(512) as u32)
        .unwrap_or(32);
    let noll_index = parse_usize_str(&req_spec.param5).unwrap_or(0);
    let req = NativeOpdMapRequest {
        job_id: None,
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows.to_vec(),
        object_rows: object_rows.to_vec(),
        object_index: Some(object_index0),
        surface_index: Some(image_surface_index(rows)),
        grid_size: Some(grid_size),
        wavelength_um: Some(wavelength_um),
        pupil_radius_mm: None,
        pupil_sampling_mode: None,
        opd_display_mode: Some("raw".to_string()),
    };
    let resp = run_native_opd_map(req, app).ok()?;
    let points = zernike_points_from_opd_grid(&resp.display_opd_grid)?;
    let coeffs_waves = fit_zernike_weighted(&points, 8)?;

    if noll_index == 0 {
        let mut sum_sq = 0.0;
        for (j, coeff) in coeffs_waves.iter().enumerate() {
            if j < 4 {
                continue;
            }
            let value = if unit == "um" {
                coeff * wavelength_um
            } else {
                *coeff
            };
            sum_sq += value * value;
        }
        return Some(sum_sq.sqrt());
    }

    let (n, m) = noll_to_nm(noll_index)?;
    let osa_index = osa_index_from_nm(n, m)?;
    let coeff = *coeffs_waves.get(osa_index).unwrap_or(&0.0);
    Some(if unit == "um" {
        coeff * wavelength_um
    } else {
        coeff
    })
}

fn zernike_points_from_opd_grid(grid: &[Vec<Option<f64>>]) -> Option<Vec<(f64, f64, f64)>> {
    if grid.len() < 4 {
        return None;
    }
    let size = grid.len();
    let mut points = Vec::<(f64, f64, f64)>::new();
    for (iy, row) in grid.iter().enumerate() {
        for (ix, opd_opt) in row.iter().enumerate() {
            let Some(opd) = opd_opt.filter(|v| v.is_finite()) else {
                continue;
            };
            let nx = (2.0 * ix as f64) / ((size - 1) as f64) - 1.0;
            let ny = (2.0 * iy as f64) / ((size - 1) as f64) - 1.0;
            if (nx * nx + ny * ny).sqrt() > 1.0 + 1.0e-9 {
                continue;
            }
            points.push((nx, ny, opd));
        }
    }
    if points.is_empty() {
        None
    } else {
        Some(points)
    }
}

fn fit_zernike_weighted(points: &[(f64, f64, f64)], max_order: usize) -> Option<Vec<f64>> {
    let mut valid_points = Vec::<(f64, f64, f64)>::new();
    for (x, y, opd) in points {
        let rho = (x * x + y * y).sqrt();
        if !rho.is_finite() || rho > 1.0 + 1.0e-9 || !opd.is_finite() {
            continue;
        }
        valid_points.push((*x, *y, *opd));
    }
    if valid_points.len() < 6 {
        return None;
    }

    let opd_mean =
        valid_points.iter().map(|(_, _, opd)| *opd).sum::<f64>() / valid_points.len() as f64;
    for (_, _, opd) in &mut valid_points {
        *opd -= opd_mean;
    }

    let mut opd_min = f64::INFINITY;
    let mut opd_max = f64::NEG_INFINITY;
    for (_, _, opd) in &valid_points {
        opd_min = opd_min.min(*opd);
        opd_max = opd_max.max(*opd);
    }
    let opd_range = if opd_min.is_finite() && opd_max.is_finite() {
        opd_max - opd_min
    } else {
        0.0
    };
    let scale_factor = opd_range.max(1.0);
    for (_, _, opd) in &mut valid_points {
        *opd /= scale_factor;
    }

    let mut sum_x2 = 0.0;
    let mut sum_y2 = 0.0;
    let mut sum_xy = 0.0;
    let mut sum_opd_x = 0.0;
    let mut sum_opd_y = 0.0;
    for (x, y, opd) in &valid_points {
        sum_x2 += x * x;
        sum_y2 += y * y;
        sum_xy += x * y;
        sum_opd_x += opd * x;
        sum_opd_y += opd * y;
    }

    let det = sum_x2 * sum_y2 - sum_xy * sum_xy;
    let (mut tilt_y_scaled, mut tilt_x_scaled) = (0.0, 0.0);
    if det.abs() > 1.0e-10 {
        let two_c2 = (sum_opd_x * sum_y2 - sum_opd_y * sum_xy) / det;
        let two_c1 = (sum_x2 * sum_opd_y - sum_xy * sum_opd_x) / det;
        tilt_y_scaled = two_c1 / 2.0;
        tilt_x_scaled = two_c2 / 2.0;
    }
    for (x, y, opd) in &mut valid_points {
        *opd -= tilt_y_scaled * 2.0 * *y + tilt_x_scaled * 2.0 * *x;
    }

    let filtered_points = maybe_remove_zernike_outliers(valid_points);
    if filtered_points.len() < 10 {
        return None;
    }

    let max_order_from_points = ((filtered_points.len() as f64) / 3.0).sqrt().floor() as usize;
    let max_order_for_fit = max_order.min(8).min(max_order_from_points.max(1));
    let num_terms = (max_order_for_fit + 1) * (max_order_for_fit + 2) / 2;
    let active_terms = num_terms.saturating_sub(3);
    if active_terms == 0 {
        let mut coeffs = vec![0.0; num_terms.max(3)];
        coeffs[0] = opd_mean;
        coeffs[1] = tilt_y_scaled * scale_factor;
        coeffs[2] = tilt_x_scaled * scale_factor;
        return Some(coeffs);
    }

    let mut a = Vec::<Vec<f64>>::new();
    let mut b = Vec::<f64>::new();
    let mut weights = Vec::<f64>::new();
    for (x, y, opd) in &filtered_points {
        let rho = (x * x + y * y).sqrt();
        if rho > 1.0 {
            continue;
        }
        let theta = y.atan2(*x);
        let mut row = Vec::<f64>::with_capacity(active_terms);
        for j in 3..num_terms {
            let (n, m) = j_to_nm(j);
            row.push(zernike_polynomial(n, m, rho, theta));
        }
        a.push(row);
        b.push(*opd);
        weights.push(1.0);
    }
    if a.is_empty() {
        return None;
    }

    let solved = solve_weighted_least_squares(&a, &b, &weights);
    let mut coeffs = vec![0.0; num_terms.max(3)];
    coeffs[0] = opd_mean;
    coeffs[1] = tilt_y_scaled * scale_factor;
    coeffs[2] = tilt_x_scaled * scale_factor;
    for (offset, coeff) in solved.into_iter().enumerate() {
        let target = offset + 3;
        if target < coeffs.len() {
            coeffs[target] = coeff * scale_factor;
        }
    }
    Some(coeffs)
}

fn maybe_remove_zernike_outliers(points: Vec<(f64, f64, f64)>) -> Vec<(f64, f64, f64)> {
    if points.len() < 20 {
        return points;
    }
    let mut values = points.iter().map(|(_, _, opd)| *opd).collect::<Vec<_>>();
    let Some(median) = median_finite(&mut values) else {
        return points;
    };
    let mut abs_dev = values
        .iter()
        .map(|v| (v - median).abs())
        .collect::<Vec<_>>();
    let Some(mad) = median_finite(&mut abs_dev) else {
        return points;
    };
    let robust_sigma = 1.4826 * mad;
    if !robust_sigma.is_finite() || robust_sigma <= 0.0 {
        return points;
    }
    let threshold = 6.0 * robust_sigma;
    let filtered = points
        .clone()
        .into_iter()
        .filter(|(_, _, opd)| (*opd - median).abs() <= threshold)
        .collect::<Vec<_>>();
    if filtered.len() < 10 {
        return points;
    }
    filtered
}

fn median_finite(values: &mut Vec<f64>) -> Option<f64> {
    values.retain(|v| v.is_finite());
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = values.len() / 2;
    if values.len() % 2 == 0 {
        Some((values[mid - 1] + values[mid]) / 2.0)
    } else {
        Some(values[mid])
    }
}

fn solve_weighted_least_squares(a: &[Vec<f64>], b: &[f64], weights: &[f64]) -> Vec<f64> {
    let m = a.len();
    let n = a.first().map(Vec::len).unwrap_or(0);
    let mut atwa = vec![0.0; n * n];
    let mut atwb = vec![0.0; n];

    for k in 0..m {
        let row = &a[k];
        let wk = weights.get(k).copied().unwrap_or(0.0);
        let bk = b.get(k).copied().unwrap_or(0.0);
        if !wk.is_finite() || wk == 0.0 {
            continue;
        }
        for i in 0..n {
            let ai = row.get(i).copied().unwrap_or(0.0);
            if !ai.is_finite() || ai == 0.0 {
                continue;
            }
            let wai = wk * ai;
            atwb[i] += wai * bk;
            let i_base = i * n;
            for j in 0..=i {
                let aj = row.get(j).copied().unwrap_or(0.0);
                if !aj.is_finite() || aj == 0.0 {
                    continue;
                }
                atwa[i_base + j] += wai * aj;
            }
        }
    }

    for i in 0..n {
        for j in (i + 1)..n {
            atwa[i * n + j] = atwa[j * n + i];
        }
    }

    solve_symmetric_system_flat(&atwa, &atwb, n)
}

fn solve_symmetric_system_flat(a_flat: &[f64], b: &[f64], n: usize) -> Vec<f64> {
    let mut l = vec![0.0; n * n];
    for i in 0..n {
        let i_base = i * n;
        for j in 0..=i {
            let j_base = j * n;
            let mut sum = 0.0;
            for k in 0..j {
                sum += l[i_base + k] * l[j_base + k];
            }
            if i == j {
                l[i_base + j] = (a_flat[i_base + i] - sum).max(0.0).sqrt();
            } else {
                let ljj = l[j_base + j];
                if ljj != 0.0 {
                    l[i_base + j] = (a_flat[i_base + j] - sum) / ljj;
                }
            }
        }
    }

    let mut y = vec![0.0; n];
    for i in 0..n {
        let i_base = i * n;
        let mut sum = 0.0;
        for j in 0..i {
            sum += l[i_base + j] * y[j];
        }
        let lii = l[i_base + i];
        y[i] = if lii != 0.0 { (b[i] - sum) / lii } else { 0.0 };
    }

    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut sum = 0.0;
        for j in (i + 1)..n {
            sum += l[j * n + i] * x[j];
        }
        let lii = l[i * n + i];
        x[i] = if lii != 0.0 { (y[i] - sum) / lii } else { 0.0 };
    }
    x
}

fn zernike_polynomial(n: usize, m: isize, rho: f64, theta: f64) -> f64 {
    if !(0.0..=1.0).contains(&rho) {
        return 0.0;
    }
    let radial = zernike_radial(n, m.unsigned_abs(), rho);
    let delta_m0 = if m == 0 { 1.0 } else { 0.0 };
    let norm = (2.0 * ((n + 1) as f64) / (1.0 + delta_m0)).sqrt();
    if m >= 0 {
        norm * radial * ((m as f64) * theta).cos()
    } else {
        norm * radial * ((m.abs() as f64) * theta).sin()
    }
}

fn zernike_radial(n: usize, m_abs: usize, rho: f64) -> f64 {
    if (n as isize - m_abs as isize) % 2 != 0 || m_abs > n {
        return 0.0;
    }
    let k_max = (n - m_abs) / 2;
    let mut radial = 0.0;
    for k in 0..=k_max {
        let sign = if k % 2 == 0 { 1.0 } else { -1.0 };
        let coeff = sign * (factorial((n - k) as u64) as f64)
            / ((factorial(k as u64)
                * factorial(((n + m_abs) / 2 - k) as u64)
                * factorial(((n - m_abs) / 2 - k) as u64)) as f64);
        radial += coeff * rho.powi((n - 2 * k) as i32);
    }
    radial
}

fn factorial(n: u64) -> u64 {
    if n <= 1 {
        return 1;
    }
    (2..=n).product()
}

fn j_to_nm(j: usize) -> (usize, isize) {
    let n = (((1.0 + 8.0 * j as f64).sqrt() - 1.0) / 2.0).floor() as usize;
    let j0 = n * (n + 1) / 2;
    let offset = j.saturating_sub(j0);
    let m = -(n as isize) + 2 * offset as isize;
    (n, m)
}

fn noll_to_nm(noll: usize) -> Option<(usize, isize)> {
    let mut j = 1usize;
    for n in 0..=100usize {
        for m_abs in 0..=n {
            if (n - m_abs) % 2 != 0 {
                continue;
            }
            if m_abs == 0 {
                if j == noll {
                    return Some((n, 0));
                }
                j += 1;
                continue;
            }
            for m in [-(m_abs as isize), m_abs as isize] {
                if j == noll {
                    return Some((n, m));
                }
                j += 1;
            }
        }
    }
    None
}

fn osa_index_from_nm(n: usize, m: isize) -> Option<usize> {
    let value = (n as isize) * ((n + 2) as isize) / 2 + m;
    if value < 0 {
        None
    } else {
        Some(value as usize)
    }
}

fn parse_zernike_unit(raw: &str) -> &'static str {
    let s = raw.trim().to_ascii_lowercase();
    if s == "um" || s == "micron" || s == "microns" || s == "µm" || s == "μm" {
        "um"
    } else {
        "waves"
    }
}

fn native_effective_focal_length_for_range(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
) -> Option<f64> {
    let (start_surf, end_surf) = resolve_subsystem_surface_range(rows, req_spec, false)?;
    let subsystem = build_isolated_surface_range_system(rows, start_surf, end_surf)?;
    let metrics = compute_paraxial_metrics(&subsystem, source_rows, object_rows);
    Some(metrics.efl)
}

fn native_principal_point_for_range(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
    which: &str,
) -> Option<f64> {
    let (start_surf, end_surf) = resolve_subsystem_surface_range(rows, req_spec, true)?;
    let subsystem = build_isolated_surface_range_system(rows, start_surf, end_surf)?;

    let effective_surfaces = subsystem
        .iter()
        .skip(1)
        .take(subsystem.len().saturating_sub(2))
        .filter(|row| !is_gap_optical_row(row) && !is_coord_trans_optical_row(row))
        .collect::<Vec<_>>();
    if effective_surfaces.len() == 1
        && effective_surfaces
            .first()
            .map(|row| is_thin_lens_surface_row(row))
            .unwrap_or(false)
    {
        return Some(0.0);
    }

    let metrics = compute_paraxial_metrics(&subsystem, source_rows, object_rows);
    if which == "pp2" {
        return Some(metrics.bfl - metrics.efl);
    }

    let reverse_system = create_reversed_isolated_optical_system(&subsystem)?;
    let reverse_metrics = compute_paraxial_metrics(&reverse_system, source_rows, object_rows);
    Some(reverse_metrics.bfl - reverse_metrics.efl)
}

fn resolve_subsystem_surface_range(
    rows: &[Value],
    req_spec: &RequirementSpec,
    allow_zoom_group: bool,
) -> Option<(usize, usize)> {
    let param2_raw = req_spec.param2.trim();
    let param3_raw = req_spec.param3.trim();
    let mode_raw = req_spec.param4.trim().to_ascii_uppercase();

    if param2_raw.is_empty() || param2_raw.eq_ignore_ascii_case("ALL") || param2_raw == "0" {
        return Some((1, rows.len().saturating_sub(2)));
    }

    let wants_zoom_group = allow_zoom_group
        && (mode_raw == "ZG"
            || param2_raw.to_ascii_uppercase().starts_with("ZG:")
            || (parse_usize_str(param2_raw).is_none() && param3_raw.is_empty()));
    if wants_zoom_group {
        let zoom_label = param2_raw
            .strip_prefix("ZG:")
            .or_else(|| param2_raw.strip_prefix("zg:"))
            .unwrap_or(param2_raw)
            .trim();
        if let Some(surface_ids) = zoom_group_surface_ids(rows, req_spec, zoom_label) {
            return min_max_surface_ids(&surface_ids);
        }
    }

    if let Some(start_surf) = parse_usize_str(param2_raw) {
        let end_surf = parse_usize_str(param3_raw).unwrap_or(rows.len().saturating_sub(2));
        return Some((start_surf, end_surf));
    }

    let surface_ids = block_scope_surface_ids(rows, req_spec, param2_raw)?;
    min_max_surface_ids(&surface_ids)
}

fn min_max_surface_ids(surface_ids: &[usize]) -> Option<(usize, usize)> {
    Some((
        surface_ids.iter().copied().min()?,
        surface_ids.iter().copied().max()?,
    ))
}

fn block_scope_surface_ids(
    rows: &[Value],
    req_spec: &RequirementSpec,
    raw_scope: &str,
) -> Option<Vec<usize>> {
    let tokens = raw_scope
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    if tokens.is_empty() {
        return None;
    }

    let mut matched_block_ids = Vec::<String>::new();
    for token in tokens {
        let mut ids = block_ids_for_scope_token(req_spec, token);
        if ids.is_empty() {
            ids.push(token.to_string());
        }
        for id in ids {
            if !matched_block_ids.iter().any(|existing| existing == &id) {
                matched_block_ids.push(id);
            }
        }
    }

    collect_surface_ids_for_block_ids(rows, &matched_block_ids)
}

fn zoom_group_surface_ids(
    rows: &[Value],
    req_spec: &RequirementSpec,
    zoom_label: &str,
) -> Option<Vec<usize>> {
    let target = zoom_label.trim().to_ascii_uppercase();
    if target.is_empty() {
        return None;
    }

    let block_ids = with_optimizer_system_config(|cfg| {
        blocks_for_requirement_config(cfg, req_spec)
            .into_iter()
            .filter_map(Value::as_object)
            .filter_map(|block| {
                let block_id = value_to_string(block.get("blockId")).trim().to_string();
                if block_id.is_empty() {
                    return None;
                }
                let block_type = value_to_string(block.get("blockType"));
                let zoom_group = block
                    .get("parameters")
                    .and_then(Value::as_object)
                    .map(|params| {
                        value_to_string(params.get("zoomGroup"))
                            .trim()
                            .to_ascii_uppercase()
                    })
                    .unwrap_or_default();
                if zoom_group == target && surface_count_from_block_type(&block_type) > 0 {
                    Some(block_id)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
    })
    .unwrap_or_default();

    collect_surface_ids_for_block_ids(rows, &block_ids)
}

fn block_ids_for_scope_token(req_spec: &RequirementSpec, token: &str) -> Vec<String> {
    let target = token.trim().to_ascii_uppercase();
    if target.is_empty() {
        return Vec::new();
    }

    with_optimizer_system_config(|cfg| {
        blocks_for_requirement_config(cfg, req_spec)
            .into_iter()
            .filter_map(Value::as_object)
            .filter_map(|block| {
                let block_id = value_to_string(block.get("blockId")).trim().to_string();
                if block_id.is_empty() {
                    return None;
                }
                let name = value_to_string(block.get("name"))
                    .trim()
                    .to_ascii_uppercase();
                let block_type =
                    value_to_string(block.get("type").or_else(|| block.get("blockType")))
                        .trim()
                        .to_ascii_uppercase();
                let candidate = format!("{}-{}", block_type, block_id.to_ascii_uppercase());
                if block_id.to_ascii_uppercase() == target || name == target || candidate == target
                {
                    Some(block_id)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
    })
    .unwrap_or_default()
}

fn blocks_for_requirement_config<'a>(cfg: &'a Value, req_spec: &RequirementSpec) -> Vec<&'a Value> {
    let configs = cfg.get("configurations").and_then(Value::as_array);
    let Some(configs) = configs else {
        return Vec::new();
    };

    let req_config_id = req_spec.config_id.trim();
    let active_id = value_to_string(cfg.get("activeConfigId"));
    let config = configs
        .iter()
        .find(|entry| value_to_string(entry.get("id")).trim() == req_config_id)
        .or_else(|| {
            configs
                .iter()
                .find(|entry| value_to_string(entry.get("id")).trim() == active_id.trim())
        })
        .or_else(|| configs.first());

    config
        .and_then(|entry| entry.get("blocks"))
        .and_then(Value::as_array)
        .map(|blocks| blocks.iter().collect::<Vec<_>>())
        .unwrap_or_default()
}

fn collect_surface_ids_for_block_ids(rows: &[Value], block_ids: &[String]) -> Option<Vec<usize>> {
    if block_ids.is_empty() {
        return None;
    }

    let mut surface_ids = Vec::<usize>::new();
    for row in rows {
        if is_gap_optical_row(row) || is_coord_trans_optical_row(row) {
            continue;
        }
        let Some(obj) = row.as_object() else {
            continue;
        };
        let object_type = value_to_string(obj.get("object type").or_else(|| obj.get("object")))
            .trim()
            .to_ascii_lowercase();
        if object_type == "object" || object_type == "image" {
            continue;
        }
        let block_id = value_to_string(obj.get("_blockId")).trim().to_string();
        if block_id.is_empty() || !block_ids.iter().any(|id| id == &block_id) {
            continue;
        }
        let block_type = value_to_string(obj.get("_blockType").or_else(|| obj.get("blockType")))
            .trim()
            .to_ascii_lowercase();
        let surface_role =
            value_to_string(obj.get("_surfaceRole").or_else(|| obj.get("surfaceRole")))
                .trim()
                .to_ascii_lowercase();
        if (block_type == "paraxial" || block_type == "thinlens") && surface_role == "back" {
            continue;
        }
        let surface_id = obj.get("id").and_then(parse_usize_value)?;
        if !surface_ids.iter().any(|id| id == &surface_id) {
            surface_ids.push(surface_id);
        }
    }

    if surface_ids.is_empty() {
        None
    } else {
        surface_ids.sort_unstable();
        Some(surface_ids)
    }
}

fn surface_count_from_block_type(block_type_raw: &str) -> usize {
    match block_type_raw.trim().to_ascii_lowercase().as_str() {
        "gap" | "coordbreak" | "coordtrans" | "coordtransform" => 0,
        "objectsurface" | "objectplane" | "stop" | "imagesurface" | "planarmirror" | "surface"
        | "paraxial" | "thinlens" => 1,
        "lens" | "toriclens" | "cementedlens" => 2,
        "doublet" | "triplet" | "prismgroup" | "group3" => 3,
        _ => 1,
    }
}

fn build_isolated_surface_range_system(
    rows: &[Value],
    start_surf: usize,
    end_surf: usize,
) -> Option<Vec<Value>> {
    let (start_surf, end_surf) = expand_principal_point_surface_range(rows, start_surf, end_surf)?;
    build_subsystem_by_surface_ids(rows, start_surf, end_surf)
}

fn expand_principal_point_surface_range(
    rows: &[Value],
    start_surf: usize,
    end_surf: usize,
) -> Option<(usize, usize)> {
    if rows.is_empty() || end_surf < start_surf {
        return None;
    }
    let mut normalized_end = end_surf;
    let end_row = rows.iter().find_map(|row| {
        let obj = row.as_object()?;
        let id = obj.get("id").and_then(parse_usize_value)?;
        if id == end_surf {
            Some(obj)
        } else {
            None
        }
    });
    let end_block_id = end_row
        .map(|obj| value_to_string(obj.get("_blockId")))
        .unwrap_or_default();
    let end_block_type = end_row
        .map(|obj| {
            value_to_string(obj.get("_blockType").or_else(|| obj.get("blockType")))
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();

    if (end_block_type == "paraxial" || end_block_type == "thinlens") && !end_block_id.is_empty() {
        for row in rows {
            if is_gap_optical_row(row) || is_coord_trans_optical_row(row) {
                continue;
            }
            let Some(obj) = row.as_object() else {
                continue;
            };
            if value_to_string(obj.get("_blockId")).trim() != end_block_id {
                continue;
            }
            let block_type =
                value_to_string(obj.get("_blockType").or_else(|| obj.get("blockType")))
                    .trim()
                    .to_ascii_lowercase();
            let surface_role =
                value_to_string(obj.get("_surfaceRole").or_else(|| obj.get("surfaceRole")))
                    .trim()
                    .to_ascii_lowercase();
            if (block_type == "paraxial" || block_type == "thinlens") && surface_role == "back" {
                if let Some(back_surface_id) = obj.get("id").and_then(parse_usize_value) {
                    normalized_end = normalized_end.max(back_surface_id);
                }
                break;
            }
        }
    }
    Some((start_surf, normalized_end))
}

fn build_subsystem_by_surface_ids(
    rows: &[Value],
    start_surf: usize,
    end_surf: usize,
) -> Option<Vec<Value>> {
    if rows.is_empty() || end_surf < start_surf {
        return None;
    }

    let normalized_start = start_surf;
    let normalized_end = end_surf;
    let object_surface_id = rows
        .first()
        .and_then(Value::as_object)
        .and_then(|obj| obj.get("id"))
        .and_then(parse_usize_value)
        .unwrap_or(1);

    let mut subsystem = Vec::<Value>::new();
    if normalized_start == object_surface_id {
        subsystem.push(rows[0].clone());
    } else {
        subsystem.push(serde_json::json!({
            "surface": 0,
            "object type": "Object",
            "thickness": "Infinity",
            "radius": "Infinity",
            "comment": "Virtual Object"
        }));
    }

    for row in rows.iter().skip(1).take(rows.len().saturating_sub(2)) {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let Some(surface_id) = obj.get("id").and_then(parse_usize_value) else {
            continue;
        };
        if surface_id < normalized_start || surface_id > normalized_end {
            continue;
        }
        let mut cloned = obj.clone();
        cloned.insert("id".to_string(), Value::from(surface_id as i64));
        subsystem.push(Value::Object(cloned));
    }

    if subsystem.len() <= 1 {
        return None;
    }

    subsystem.push(serde_json::json!({
        "surface": subsystem.len(),
        "object type": "Image",
        "thickness": 0,
        "radius": "Infinity",
        "comment": "Image"
    }));
    Some(subsystem)
}

fn create_reversed_isolated_optical_system(rows: &[Value]) -> Option<Vec<Value>> {
    if rows.len() < 3 {
        return None;
    }

    let mut reversed_surfaces = Vec::<Value>::new();
    for i in (1..rows.len().saturating_sub(1)).rev() {
        let row = &rows[i];
        if is_coord_trans_optical_row(row) {
            continue;
        }
        let Some(obj) = row.as_object() else {
            continue;
        };
        let mut reversed = obj.clone();
        let combined_power = obj.get("__cooptCombinedPower").and_then(parse_number);
        if combined_power.map(|v| v.is_finite()).unwrap_or(false) {
            reversed.insert(
                "__cooptCombinedPower".to_string(),
                Value::from(combined_power.unwrap_or(0.0)),
            );
            reversed.insert("radius".to_string(), Value::String("Infinity".to_string()));
        } else if let Some(radius) = obj.get("radius").and_then(parse_number) {
            if radius.is_finite() {
                reversed.insert("radius".to_string(), Value::from(-radius));
            }
        }

        if i > 1 {
            if let Some(prev_obj) = rows[i - 1].as_object() {
                reversed.insert(
                    "thickness".to_string(),
                    prev_obj
                        .get("thickness")
                        .cloned()
                        .unwrap_or(Value::from(0.0)),
                );
                reversed.insert(
                    "material".to_string(),
                    prev_obj
                        .get("material")
                        .cloned()
                        .unwrap_or(Value::String(String::new())),
                );
                if let Some(rindex) = prev_obj.get("rindex").cloned() {
                    reversed.insert("rindex".to_string(), rindex);
                }
                if let Some(abbe) = prev_obj
                    .get("abbe")
                    .or_else(|| prev_obj.get("Abbe"))
                    .or_else(|| prev_obj.get("vd"))
                    .or_else(|| prev_obj.get("Vd"))
                    .cloned()
                {
                    reversed.insert("abbe".to_string(), abbe);
                }
            }
        } else {
            reversed.insert("thickness".to_string(), Value::from(0.0));
            reversed.insert("material".to_string(), Value::String(String::new()));
            reversed.insert("rindex".to_string(), Value::from(1.0));
            reversed.insert("abbe".to_string(), Value::String(String::new()));
        }

        reversed_surfaces.push(Value::Object(reversed));
    }

    if reversed_surfaces.is_empty() {
        return None;
    }

    let mut out = Vec::<Value>::new();
    out.push(serde_json::json!({
        "object type": "Object",
        "thickness": "Infinity",
        "radius": "Infinity",
        "comment": "Virtual Object for reverse principal-point calc"
    }));
    out.extend(reversed_surfaces);
    out.push(serde_json::json!({
        "object type": "Image",
        "thickness": 0,
        "radius": "Infinity",
        "comment": "Virtual Image for reverse principal-point calc"
    }));
    Some(out)
}

fn is_coord_trans_optical_row(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let fields = [
        obj.get("surfType"),
        obj.get("type"),
        obj.get("surfaceType"),
        obj.get("surface_type"),
        obj.get("surfTypeName"),
        obj.get("object type"),
        obj.get("object"),
        obj.get("Object"),
        obj.get("comment"),
        obj.get("Comment"),
        obj.get("blockType"),
        obj.get("block_type"),
        obj.get("blockTypeName"),
    ];
    fields.into_iter().flatten().any(|value| {
        let s = value_to_string(Some(value)).trim().to_ascii_lowercase();
        s == "ct"
            || s == "coordtrans"
            || s == "coordinatebreak"
            || s == "coord trans"
            || s == "coordinate break"
            || s.contains("coord trans")
            || s.contains("coordinate break")
    })
}

fn is_gap_optical_row(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let fields = [
        obj.get("_blockType"),
        obj.get("blockType"),
        obj.get("block_type"),
        obj.get("blockTypeName"),
        obj.get("surfType"),
        obj.get("type"),
        obj.get("surfaceType"),
        obj.get("surface_type"),
        obj.get("object type"),
        obj.get("object"),
        obj.get("Object"),
        obj.get("_surfaceRole"),
        obj.get("comment"),
        obj.get("Comment"),
    ];
    fields.into_iter().flatten().any(|value| {
        let s = value_to_string(Some(value))
            .trim()
            .to_ascii_lowercase()
            .replace([' ', '_', '-'], "");
        s == "gap" || s == "airgap"
    })
}

fn is_thin_lens_surface_row(row: &Value) -> bool {
    let Some(obj) = row.as_object() else {
        return false;
    };
    let block_type = value_to_string(
        obj.get("_blockType")
            .or_else(|| obj.get("blockType"))
            .or_else(|| obj.get("block_type"))
            .or_else(|| obj.get("blockTypeName")),
    )
    .trim()
    .to_ascii_lowercase();
    block_type == "thinlens" || block_type == "paraxial"
}

fn run_native_spherical_aberration_for_requirement(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
) -> Option<Vec<NativeSphericalAberrationSeries>> {
    let source_rows_effective = source_rows_for_wavelength_param(source_rows, &req_spec.param1);
    let req = NativeSphericalAberrationRequest {
        optical_system_rows: rows.to_vec(),
        source_rows: source_rows_effective,
        object_rows: object_rows.to_vec(),
        surface_index: Some(image_surface_index(rows)),
        ray_count: None,
        reference_focus_mode: Some("primary-paraxial".to_string()),
        wavelength_mode: Some("primary".to_string()),
    };
    let resp = run_native_spherical_aberration(req).ok()?;
    Some(resp.meridional_data)
}

fn series_points_for_wavelength<'a>(
    series_list: &'a [NativeSphericalAberrationSeries],
    wavelength: f64,
) -> Option<Vec<&'a NativeSphericalAberrationPoint>> {
    let series = series_list
        .iter()
        .find(|entry| (entry.wavelength - wavelength).abs() < 1e-9)
        .or_else(|| series_list.first())?;
    let mut points = series
        .points
        .iter()
        .filter(|point| {
            point.pupil_coordinate.is_finite() && point.longitudinal_aberration.is_finite()
        })
        .collect::<Vec<_>>();
    points.sort_by(|a, b| {
        a.pupil_coordinate
            .partial_cmp(&b.pupil_coordinate)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Some(points)
}

fn native_chief_ray_angle_deg(
    rows: &[Value],
    source_rows: &[Value],
    object_rows: &[Value],
    req_spec: &RequirementSpec,
) -> Option<f64> {
    let object_rows_effective = select_object_rows_for_requirement(object_rows, &req_spec.param1);
    if object_rows_effective.is_empty() {
        return None;
    }
    let source_rows_effective = source_rows_for_wavelength_param(source_rows, &req_spec.param2);
    compute_native_chief_ray_angle_deg(rows, &source_rows_effective, &object_rows_effective)
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

fn resolve_surface_row_by_param1<'a>(
    rows: &'a [Value],
    param1: &str,
) -> Option<(usize, &'a serde_json::Map<String, Value>)> {
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

fn toric_surface_sag(
    x: f64,
    y: f64,
    radius_x: f64,
    radius_y: f64,
    conic: f64,
    axis_deg: f64,
) -> f64 {
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
    if s.is_finite() {
        s
    } else {
        0.0
    }
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
        let object_type = value_to_string(obj.get("object type"))
            .trim()
            .to_lowercase();
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
            let s = value_to_string(Some(v)).trim().to_ascii_lowercase();
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
    if object_rows.is_empty() {
        return Vec::new();
    }
    let raw = param2.trim();
    if raw.is_empty() {
        return vec![object_rows[0].clone()];
    }
    for row in object_rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let row_id = value_to_string(obj.get("id"));
        if !row_id.is_empty() && row_id == raw {
            return vec![row.clone()];
        }
    }
    let idx = parse_usize_str(raw).unwrap_or(1);
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
            t.eq_ignore_ascii_case("v") || t.eq_ignore_ascii_case("true") || t == "1"
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
    if upper == "RI" || upper == "RINDEX" || upper == "ND" {
        return "rindex".to_string();
    }
    if upper == "ABBE" || upper == "VD" {
        return "abbe".to_string();
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
        obj.insert(
            field_key.to_string(),
            Value::String(format_float_for_cell(value)),
        );
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

#[cfg(test)]
mod tests {
    use super::*;

    fn make_requirement(param2: &str, param3: &str, param4: &str) -> RequirementSpec {
        let operand = "PP1".to_string();
        let op = "=".to_string();
        let param1 = "".to_string();
        let param2_string = param2.to_string();
        let param3_string = param3.to_string();
        let param4_string = param4.to_string();
        let param5 = "".to_string();
        RequirementSpec {
            id: "req-1".to_string(),
            config_id: "cfg-1".to_string(),
            enabled: true,
            cache_key: build_requirement_cache_key(
                &operand,
                &param1,
                &param2_string,
                &param3_string,
                &param4_string,
                &param5,
                &op,
            ),
            operand,
            op,
            target: 0.0,
            tol: 0.0,
            weight: 1.0,
            param1,
            param2: param2_string,
            param3: param3_string,
            param4: param4_string,
            param5,
        }
    }

    fn sample_rows() -> Vec<Value> {
        vec![
            serde_json::json!({ "id": 0, "object": "object" }),
            serde_json::json!({ "id": 1, "_blockId": "L1", "_blockType": "lens", "_surfaceRole": "front" }),
            serde_json::json!({ "id": 2, "_blockId": "L1", "_blockType": "lens", "_surfaceRole": "back" }),
            serde_json::json!({ "id": 3, "object": "gap", "_blockId": "G1", "_blockType": "gap" }),
            serde_json::json!({ "id": 4, "_blockId": "L2", "_blockType": "lens", "_surfaceRole": "front" }),
            serde_json::json!({ "id": 5, "_blockId": "L2", "_blockType": "lens", "_surfaceRole": "back" }),
            serde_json::json!({ "id": 6, "object": "image" }),
        ]
    }

    fn sample_system_config() -> Value {
        serde_json::json!({
            "activeConfigId": "cfg-1",
            "configurations": [
                {
                    "id": "cfg-1",
                    "blocks": [
                        { "blockId": "L1", "name": "Lens Alpha", "type": "lens", "blockType": "lens", "parameters": { "zoomGroup": "A" } },
                        { "blockId": "G1", "name": "Gap 1", "type": "gap", "blockType": "gap", "parameters": {} },
                        { "blockId": "L2", "name": "Lens Beta", "type": "lens", "blockType": "lens", "parameters": { "zoomGroup": "B" } }
                    ]
                }
            ]
        })
    }

    #[test]
    fn resolves_zoom_group_scope_to_surface_range() {
        let rows = sample_rows();
        let req = make_requirement("A", "", "ZG");
        let _guard = OptimizerSystemConfigGuard::install(Some(sample_system_config()));

        let range = resolve_subsystem_surface_range(&rows, &req, true);

        assert_eq!(range, Some((1, 2)));
    }

    #[test]
    fn resolves_block_label_scope_to_surface_range() {
        let rows = sample_rows();
        let req = make_requirement("Lens Beta", "", "");
        let _guard = OptimizerSystemConfigGuard::install(Some(sample_system_config()));

        let range = resolve_subsystem_surface_range(&rows, &req, false);

        assert_eq!(range, Some((4, 5)));
    }
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
    if x.is_finite() {
        x
    } else {
        default
    }
}
