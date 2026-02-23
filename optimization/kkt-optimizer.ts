/**
 * KKT-based Optimizer: Sequential Quadratic Programming (SQP) with Augmented Lagrangian
 * 
 * Implements KKT (Karush-Kuhn-Tucker) conditions for constrained nonlinear optimization.
 * Uses a hybrid approach combining:
 *   - SQP (Quadratic subproblem solve)
 *   - Augmented Lagrangian for constraint handling
 *   - Filter method for merit function updates
 * 
 * This is a general-purpose constrained optimizer suitable for optical design.
 */

export interface KKTOptimizerOptions {
  /**
   * Equality constraints: g(x) = 0
   * Array of { name, evaluate: (x: number[]) => number }
   */
  equalityConstraints?: Array<{ name: string; evaluate: (x: number[]) => number }>;

  /**
   * Inequality constraints: h(x) <= 0
   * Array of { name, evaluate: (x: number[]) => number, weight? }
   */
  inequalityConstraints?: Array<{ name: string; evaluate: (x: number[]) => number; weight?: number }>;

  /**
   * Initial Lagrange multiplier for constraints
   */
  initialLambda?: number;

  /**
   * Initial Lagrangian penalty parameter
   */
  penaltyParameter?: number;

  /**
   * Penalty parameter increase factor when constraints worsen
   */
  penaltyIncreaseFactor?: number;

  /**
   * Constraint violation tolerance
   */
  constraintTolerance?: number;

  /**
   * Feasibility restoration phase duration
   */
  feasibilityRestorationMaxIter?: number;

  /**
   * Max SQP iterations
   */
  maxIterations?: number;

  /**
   * Line search backtracking parameter (0 < c < 0.5)
   */
  lineSearchC?: number;

  /**
   * Line search efficiency parameter (0 < c < 1)
   */
  lineSearchRho?: number;
}

export interface KKTOptimizerState {
  x: number[]; // current point
  lambda: number[]; // Lagrange multipliers for equality
  mu: number[]; // Lagrange multipliers for inequality
  penalty: number; // augmented Lagrangian penalty parameter
  feasible: boolean;
  violations: number[]; // constraint violation amounts
  violationScore: number; // sum of violations
}

export interface KKTStepResult {
  ok: boolean;
  reason?: string;
  dx?: number[]; // step direction
  stepSize?: number;
  predictor?: number;
  actualReduction?: number;
  predictedReduction?: number;
}

/**
 * Evaluate augmented Lagrangian objective:
 * L(x, λ, μ, σ) = f(x) + λ^T g(x) + μ^T h(x)⁺ + (σ/2) ||g(x)||² + (σ/2) Σ(h(x)⁺)²
 */
function evaluateAugmentedLagrangian(
  x: number[],
  objective: (x: number[]) => number,
  constraints: KKTOptimizerOptions,
  state: KKTOptimizerState
): number {
  const f = objective(x);
  if (!Number.isFinite(f)) return Infinity;

  let L = f;
  const sigma = state.penalty;

  // Process equality constraints
  const gEq = constraints.equalityConstraints || [];
  for (let i = 0; i < gEq.length; i++) {
    const gi = gEq[i].evaluate(x);
    if (!Number.isFinite(gi)) return Infinity;
    const lambda_i = state.lambda[i] || 0;
    L += lambda_i * gi + (sigma / 2) * gi * gi;
  }

  // Process inequality constraints
  const hIneq = constraints.inequalityConstraints || [];
  for (let j = 0; j < hIneq.length; j++) {
    const hj = hIneq[j].evaluate(x);
    if (!Number.isFinite(hj)) return Infinity;
    const hj_plus = Math.max(0, hj);
    const mu_j = state.mu[j] || 0;
    L += mu_j * hj_plus + (sigma / 2) * hj_plus * hj_plus;
  }

  return Number.isFinite(L) ? L : Infinity;
}

/**
 * Compute numerical gradient of augmented Lagrangian
 */
function computeGradient(
  x: number[],
  objective: (x: number[]) => number,
  constraints: KKTOptimizerOptions,
  state: KKTOptimizerState,
  eps: number = 1e-8
): number[] {
  const n = x.length;
  const grad = new Array(n);
  const f0 = evaluateAugmentedLagrangian(x, objective, constraints, state);

  for (let i = 0; i < n; i++) {
    const xp = x.slice();
    xp[i] += eps;
    const fp = evaluateAugmentedLagrangian(xp, objective, constraints, state);
    grad[i] = (fp - f0) / eps;
  }
  return grad;
}

/**
 * Numerical Hessian approximation (finite differences)
 */
function approximateHessian(
  x: number[],
  objective: (x: number[]) => number,
  constraints: KKTOptimizerOptions,
  state: KKTOptimizerState,
  eps: number = 1e-6
): number[][] {
  const n = x.length;
  const H = Array.from({ length: n }, () => new Array(n).fill(0));
  const g0 = computeGradient(x, objective, constraints, state, eps);

  for (let j = 0; j < n; j++) {
    const xp = x.slice();
    xp[j] += eps;
    const gp = computeGradient(xp, objective, constraints, state, eps);
    for (let i = 0; i < n; i++) {
      H[i][j] = (gp[i] - g0[i]) / eps;
    }
  }

  // Symmetrize: H = (H + H^T) / 2
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const sym = (H[i][j] + H[j][i]) / 2;
      H[i][j] = sym;
      H[j][i] = sym;
    }
  }

  return H;
}

/**
 * Solve linear system Ax = b using Gaussian elimination (simple, robust)
 */
function solveLU(A: number[][], b: number[]): number[] | null {
  const n = A.length;
  if (n === 0) return [];
  if (b.length !== n) return null;

  // Create augmented matrix
  const aug = A.map((row, i) => [...row, b[i]]);

  // Forward elimination with partial pivoting
  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) {
        maxRow = row;
      }
    }
    if (Math.abs(aug[maxRow][col]) < 1e-14) {
      return null; // singular
    }
    // Swap rows
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    // Eliminate
    for (let row = col + 1; row < n; row++) {
      const factor = aug[row][col] / aug[col][col];
      for (let j = col; j <= n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  // Back substitution
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = aug[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= aug[i][j] * x[j];
    }
    x[i] = sum / aug[i][i];
  }

  return x;
}

/**
 * Update constraint violation and feasibility state
 */
function updateConstraintViolations(
  x: number[],
  constraints: KKTOptimizerOptions,
  state: KKTOptimizerState,
  tolerance: number = 1e-6
): void {
  const violations: number[] = [];
  let violated = false;

  // Equality constraints
  const gEq = constraints.equalityConstraints || [];
  for (const c of gEq) {
    const val = c.evaluate(x);
    const violation = Math.abs(val);
    violations.push(violation);
    if (violation > tolerance) violated = true;
  }

  // Inequality constraints
  const hIneq = constraints.inequalityConstraints || [];
  for (const c of hIneq) {
    const val = c.evaluate(x);
    const violation = Math.max(0, val);
    violations.push(violation);
    if (violation > tolerance) violated = true;
  }

  state.violations = violations;
  state.violationScore = violations.reduce((a, b) => a + b, 0);
  state.feasible = !violated;
}

/**
 * Update Lagrange multipliers using KKT conditions
 */
function updateMultipliers(
  x: number[],
  constraints: KKTOptimizerOptions,
  state: KKTOptimizerState
): void {
  const sigma = state.penalty;
  const gEq = constraints.equalityConstraints || [];
  const hIneq = constraints.inequalityConstraints || [];

  // Update λ for equality: λ_i ← λ_i + σ g_i(x)
  for (let i = 0; i < gEq.length; i++) {
    const gi = gEq[i].evaluate(x);
    state.lambda[i] = (state.lambda[i] || 0) + sigma * gi;
  }

  // Update μ for inequality: μ_j ← max(0, μ_j + σ h_j(x))
  for (let j = 0; j < hIneq.length; j++) {
    const hj = hIneq[j].evaluate(x);
    state.mu[j] = Math.max(0, (state.mu[j] || 0) + sigma * hj);
  }
}

/**
 * SQP step: solve QP subproblem
 *   min  (1/2) Δx^T H Δx + g^T Δx
 *   s.t. constraints linear approx
 */
export function computeSQPStep(
  x: number[],
  objective: (x: number[]) => number,
  constraints: KKTOptimizerOptions,
  state: KKTOptimizerState
): KKTStepResult {
  try {
    const n = x.length;
    const grad = computeGradient(x, objective, constraints, state);
    const H = approximateHessian(x, objective, constraints, state);

    // For simplicity, solve unconstrained QP: H * Δx = -g
    // (In a full implementation, would enforce linear constraint approximations)
    const dx = solveLU(H, grad.map((g) => -g));
    if (!dx) {
      return { ok: false, reason: 'QP solver failed (singular Hessian)' };
    }

    // Compute norms and predicted reduction
    const dxNorm = Math.sqrt(dx.reduce((a, b) => a + b * b, 0));
    if (!Number.isFinite(dxNorm) || dxNorm === 0) {
      return { ok: false, reason: 'SQP step is zero (convergence)' };
    }

    const predictedRed = -0.5 * dx.reduce((sum, dxi, i) => sum + dxi * grad[i], 0);

    return { ok: true, dx, stepSize: 1.0, predictedReduction: predictedRed };
  } catch (e) {
    return { ok: false, reason: `SQP step computation failed: ${String(e)}` };
  }
}

/**
 * Line search with filter method
 */
export function lineSearch(
  x: number[],
  dx: number[],
  objective: (x: number[]) => number,
  constraints: KKTOptimizerOptions,
  state: KKTOptimizerState,
  predictedReduction: number,
  c: number = 0.1,
  rho: number = 0.5
): { stepSize: number; accepted: boolean } {
  let alpha = 1.0;
  const x_new = x.slice();

  // Initial function values
  const merit0 = evaluateAugmentedLagrangian(x, objective, constraints, state);
  const viol0 = state.violationScore;

  // Backtracking
  for (let k = 0; k < 20; k++) {
    for (let i = 0; i < x.length; i++) {
      x_new[i] = x[i] + alpha * dx[i];
    }
    updateConstraintViolations(x_new, constraints, state);
    const merit_new = evaluateAugmentedLagrangian(x_new, objective, constraints, state);
    const viol_new = state.violationScore;

    // Filter acceptance: either merit decreases OR constraint violation decreases
    if (
      merit_new < merit0 - c * alpha * Math.abs(predictedReduction) ||
      viol_new < (1 - c) * viol0
    ) {
      return { stepSize: alpha, accepted: true };
    }

    alpha *= rho;
  }

  return { stepSize: alpha, accepted: false };
}

/**
 * Main KKT solver: orchestrates SQP + Augmented Lagrangian
 */
export async function runKKTOptimization(objective: (x: number[]) => number, targetX: number[], options: KKTOptimizerOptions & { maxIterations?: number; onProgress?: Function; shouldStop?: Function } = {}): Promise<{
  ok: boolean;
  x: number[];
  fval: number;
  iterations: number;
  feasible: boolean;
  reason?: string;
}> {
  const maxIter = options.maxIterations || 100;
  const constraintTol = options.constraintTolerance || 1e-6;
  let n = targetX.length;

  // Initialize state
  const state: KKTOptimizerState = {
    x: targetX.slice(),
    lambda: new Array(options.equalityConstraints?.length || 0).fill(0),
    mu: new Array(options.inequalityConstraints?.length || 0).fill(0),
    penalty: options.penaltyParameter || 1.0,
    feasible: false,
    violations: [],
    violationScore: Infinity
  };

  updateConstraintViolations(state.x, options, state, constraintTol);

  let iter = 0;
  let bestFval = objective(state.x);

  for (; iter < maxIter; iter++) {
    // Callback
    if (options.shouldStop && typeof options.shouldStop === 'function') {
      if (options.shouldStop()) {
        return { ok: false, x: state.x, fval: bestFval, iterations: iter, feasible: state.feasible, reason: 'Stopped by user' };
      }
    }
    if (options.onProgress && typeof options.onProgress === 'function') {
      try {
        await options.onProgress({
          phase: 'kkt-iter',
          iter,
          current: bestFval,
          feasible: state.feasible,
          violationScore: state.violationScore,
          method: 'kkt'
        });
      } catch (_) {}
    }

    // Check convergence
    if (state.feasible && state.violationScore < constraintTol) {
      return { ok: true, x: state.x, fval: bestFval, iterations: iter, feasible: true, reason: 'Converged (constraints satisfied)' };
    }

    // Compute SQP step
    const sqpResult = computeSQPStep(state.x, objective, options, state);
    if (!sqpResult.ok || !sqpResult.dx) {
      // Try smaller penalty for feasibility restoration
      state.penalty *= (options.penaltyIncreaseFactor || 1.5);
      if (state.penalty > 1e8) {
        return { ok: false, x: state.x, fval: bestFval, iterations: iter + 1, feasible: state.feasible, reason: 'Penalty too large' };
      }
      continue;
    }

    // Line search
    const lsResult = lineSearch(state.x, sqpResult.dx, objective, options, state, sqpResult.predictedReduction || 1.0);

    if (!lsResult.accepted) {
      // Increase penalty and continue
      state.penalty *= (options.penaltyIncreaseFactor || 1.5);
      continue;
    }

    // Update point
    for (let i = 0; i < n; i++) {
      state.x[i] += lsResult.stepSize * sqpResult.dx[i];
    }

    updateConstraintViolations(state.x, options, state, constraintTol);
    updateMultipliers(state.x, options, state);

    // Objective value
    const fval = objective(state.x);
    if (Number.isFinite(fval) && fval < bestFval) {
      bestFval = fval;
    }

    // Relaxation: increase penalty periodically
    if (iter % 5 === 4) {
      state.penalty *= (options.penaltyIncreaseFactor || 1.5);
    }
  }

  return { ok: false, x: state.x, fval: bestFval, iterations: maxIter, feasible: state.feasible, reason: 'Max iterations reached' };
}
