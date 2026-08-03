# KKT-DLS Optimizer (Spencer/Feder-inspired)

This note documents the constrained optimization method used by `kkt-sqp` / `kkt` modes.

## Literature Basis

- Spencer, Gordon H., "A flexible automatic lens correction procedure", Applied Optics, Vol. 2, No. 12 (1963), p. 1257.
- Feder, Donald P., "Automatic optical design", Applied Optics, Vol. 2, No. 12 (1963), p. 1209.

The implementation follows the classical idea: combine damped least-squares style descent with KKT-constrained updates and line-search globalization.

## Problem Form

Minimize weighted requirement residuals under mixed constraints:

- Objective: minimize merit score built from System Requirements residuals.
- Equality constraints: target-matching terms.
- Inequality constraints: bound and one-sided requirement terms.

The runtime uses an augmented-Lagrangian merit:

- base score + multiplier term + penalty on violation
- Armijo/filter acceptance to guarantee stable progress.

## Iteration Structure

For each iteration:

1. Evaluate current state (score, equality violation, inequality violation).
2. Build augmented gradient by finite differences on active design variables.
3. Build SQP-like direction from diagonal Hessian approximation (secant-updated positive diagonal).
4. Enforce descent direction (projection/fallback to negative gradient if needed).
5. Run Armijo backtracking line search with filter acceptance:
   - accept if augmented merit decreases enough, or
   - accept if violation decreases enough.
6. Update AL multipliers and penalty parameter.
7. If step rejected, use coordinate nudge fallback; otherwise increase penalty and continue.
8. Persist best low-score state and restore it at the end.

## DLS Connection

The damped behavior appears through:

- line-search step scaling,
- diagonal Hessian regularization,
- penalty/multiplier updates that stabilize constrained progress,
- fallback descent when SQP direction is not numerically safe.

This is equivalent in spirit to a constrained extension of classical DLS for optical design.

## Code Mapping

- Native command entry: `src-tauri/src/commands/optimizer.rs`
- Method dispatch and aliases: `normalize_method`, `run_optimizer_step`
- Constrained loop: `run_kkt`
- TS orchestration and method selection: `optimization/optimizer-mvp.ts`

## Method Names

- `kkt`: constrained AL/KKT path
- `kkt-sqp`: same constrained path, exposed as SQP-labeled mode for UI/telemetry
- `sqp`, `sqp-kkt`: aliases normalized to `kkt-sqp`
