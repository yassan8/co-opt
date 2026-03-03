# Optimize Algorithm Rust Migration Plan

**Date:** 2026-03-01  
**Status:** Planning Phase  
**Target:** 1.5x speedup over current baseline  
**Current Speedup:** 0.966x (3.37% slower - requires optimization)

## Executive Summary

This document outlines the migration plan for porting the core optimization numerical solvers (KKT/SQP algorithms) from TypeScript to Rust/WASM. This migration explicitly **excludes** the Requirements subsystem (Req*), keeping objective/residual evaluation in TypeScript while accelerating the numerical solver kernels.

### Key Objectives
- ✅ Migrate KKT/SQP numerical solver cores to Rust
- ✅ Expand linear algebra kernel support in WASM
- ✅ Achieve 1.5x speedup (from current 0.966x baseline)
- ❌ **Explicitly exclude:** Requirements UI/Editor/data models evaluation

### Success Pattern Reference
This migration follows the proven pattern from ray-tracing Rust migration, which achieved zero-mismatch parity with automated requirement gates.

---

## Current State Analysis

### Performance Baseline
- **Current OPD Full-Batch Speedup:** 0.966x (slower than pure TypeScript)
- **Strict Gate Threshold:** 1.05x minimum (currently FAILING)
- **Target Goal:** 1.5x speedup
- **Gap to Close:** ~55% performance improvement needed

### Existing Rust/WASM Infrastructure

**Available Kernels (rust-wasm/src/lib.rs):**
- ✅ `solve_linear_system()` - Direct linear solver
- ✅ `build_normal_equations()` - Normal equation construction
- ✅ FFT operations
- ✅ Ray tracing kernels (intersect/normal/refract)
- ⚠️ **Missing:** Full SQP iteration, trust region logic, BFGS updates

**TypeScript Bridge (wasm/optimization/optimizer-wasm-bridge.ts):**
- Partial LA kernel usage exists
- Needs expansion for full SQP solver

### Hot Loop Analysis (from investigation)

**Primary Hot Loop:** `optimizer-mvp.ts` line ~3070
```typescript
function evalResidualsNow(): number[] {
  // Requirement-driven residual computation
  // KEEP IN TYPESCRIPT - tightly coupled to Req* system
}
```

**SQP Helper Layer:** `kkt-optimizer.ts` lines 295-370
```typescript
// Trust region solver
// BFGS update helpers  
// KKT condition evaluation
// → TARGET FOR RUST MIGRATION
```

### Requirements Subsystem Boundary (Req* - EXCLUDED)

**Files to KEEP in TypeScript:**
- `ui/editors/system-requirements-editor.ts` - Requirements UI editor
- `data/table-system-requirements.ts` - Requirements data models
- `data/table-configuration.ts` - Configuration with requirements
- `optimizer-mvp.ts::evalResidualsNow()` - Objective evaluation (Req-coupled)

**Rationale:** Requirements subsystem is business-logic heavy, UI-coupled, and frequently changed. Numerical solver cores are stable, compute-intensive, and isolated.

---

## Migration Scope

### Phase 1: Linear Algebra Kernel Expansion (2-3 days)

**Goal:** Complete LA foundation for SQP algorithms

**Rust Additions (rust-wasm/src/lib.rs):**
```rust
// Vector operations
pub fn vector_add_scaled(x: &[f64], y: &[f64], alpha: f64) -> Vec<f64>;
pub fn vector_dot(x: &[f64], y: &[f64]) -> f64;
pub fn vector_norm(x: &[f64]) -> f64;

// Matrix operations  
pub fn matrix_vector_multiply(A: &[f64], x: &[f64], rows: usize, cols: usize) -> Vec<f64>;
pub fn cholesky_factorization(A: &[f64], n: usize) -> Option<Vec<f64>>;
pub fn bfgs_update(H: &mut [f64], s: &[f64], y: &[f64], n: usize);

// QR factorization for constraint handling
pub fn qr_factorization(A: &[f64], rows: usize, cols: usize) -> (Vec<f64>, Vec<f64>);
```

**Bridge Updates (wasm/optimization/optimizer-wasm-bridge.ts):**
```typescript
export async function loadOptimizerWasm(): Promise<OptimizerWasmModule> {
  const rustWasm = await loadWasmModule();
  return {
    vectorAddScaled: rustWasm.vector_add_scaled,
    vectorDot: rustWasm.vector_dot,
    matrixVectorMultiply: rustWasm.matrix_vector_multiply,
    choleskyFactorization: rustWasm.cholesky_factorization,
    bfgsUpdate: rustWasm.bfgs_update,
    qrFactorization: rustWasm.qr_factorization,
    // ... existing kernels
  };
}
```

**Verification:**
- Unit tests for each kernel (math accuracy)
- Benchmark against nalgebra reference implementation

### Phase 2: SQP Solver Core (3-4 days)

**Goal:** Port SQP iteration and subproblem solver to Rust

**Rust Additions:**
```rust
#[wasm_bindgen]
pub struct SQPSolver {
    hessian_approx: Vec<f64>,  // BFGS approximation
    dimension: usize,
}

#[wasm_bindgen]
impl SQPSolver {
    #[wasm_bindgen(constructor)]
    pub fn new(dim: usize) -> SQPSolver;
    
    // Solve QP subproblem: min 0.5*p'*H*p + g'*p  s.t. A*p + c = 0
    pub fn solve_qp_subproblem(
        &self,
        gradient: &[f64],
        eq_constraints_jacobian: &[f64],
        eq_constraints_residual: &[f64],
    ) -> SQPStepResult;
    
    // Update BFGS Hessian approximation
    pub fn update_hessian(&mut self, step: &[f64], grad_diff: &[f64]);
    
    // Trust region logic
    pub fn compute_trust_region_step(
        &self,
        gradient: &[f64],
        radius: f64,
    ) -> Vec<f64>;
}

#[wasm_bindgen]
pub struct SQPStepResult {
    pub step: Vec<f64>,
    pub lagrange_multipliers: Vec<f64>,
    pub predicted_reduction: f64,
}
```

**TypeScript Integration (kkt-optimizer.ts):**
```typescript
import { loadOptimizerWasm } from '../wasm/optimization/optimizer-wasm-bridge';

export async function solveKKTSystem(
  hessian: number[][],
  gradient: number[],
  jacobian: number[][],
  residuals: number[]
): Promise<{ step: number[], lambda: number[] }> {
  const wasm = await loadOptimizerWasm();
  const solver = new wasm.SQPSolver(gradient.length);
  
  // Call Rust SQP solver
  const result = solver.solve_qp_subproblem(
    new Float64Array(gradient),
    new Float64Array(flattenMatrix(jacobian)),
    new Float64Array(residuals)
  );
  
  return {
    step: Array.from(result.step),
    lambda: Array.from(result.lagrange_multipliers)
  };
}
```

**Verification:**
- Compare step solutions against TypeScript implementation (tolerance: 1e-10)
- Validate convergence rates on standard test problems

### Phase 3: Iteration Control and Line Search (2 days)

**Goal:** Migrate iteration control and backtracking line search

**Rust Additions:**
```rust
// Armijo line search with merit function
pub fn backtracking_line_search(
    x0: &[f64],
    p: &[f64],  // search direction
    f0: f64,    // current objective
    grad0: &[f64],
    merit_eval_callback: &js_sys::Function,  // JS callback for merit evaluation
    alpha_init: f64,
    rho: f64,
    c1: f64,
) -> f64;  // Returns step size alpha

// Trust region radius update
pub fn update_trust_region_radius(
    predicted_reduction: f64,
    actual_reduction: f64,
    current_radius: f64,
) -> f64;
```

**TypeScript Bridge:**
```typescript
export function createMeritEvaluator(
  designVars: DesignVariableRegistry,
  requirements: SystemRequirement[]
): js_sys::Function {
  return (x: Float64Array) => {
    // Requirements evaluation stays in TypeScript
    const residuals = evalResidualsNow(x, designVars, requirements);
    return computeMeritFunction(residuals);
  };
}
```

**Verification:**
- Line search converges to same objective value
- Trust region updates match reference behavior

### Phase 4: Full Integration and Default Switch (4-5 days)

**Goal:** Make Rust optimizer the default path with TypeScript fallback

**Feature Flag (optimization/optimizer-mvp.ts):**
```typescript
export interface OptimizerConfig {
  useRustSQP: boolean;  // Default: true
  rustFallbackOnError: boolean;  // Default: true
}

async function optimizeDesign(config: OptimizerConfig): Promise<OptimizationResult> {
  if (config.useRustSQP) {
    try {
      return await optimizeWithRustSQP(/* ... */);
    } catch (err) {
      if (config.rustFallbackOnError) {
        console.warn('Rust SQP failed, falling back to TypeScript', err);
        return await optimizeWithTypeScriptSQP(/* ... */);
      }
      throw err;
    }
  }
  return await optimizeWithTypeScriptSQP(/* ... */);
}
```

**Verification:**
- Run full optimization suite on sample problems
- Verify final design values match within tolerance (1e-8)
- Measure end-to-end speedup

---

## Verification Strategy

### Automated Diagnostic Gates

**Extend Existing Infrastructure:**
```bash
# New diagnostic script: diagnostics/optimize-algorithm-benchmark.mjs
# Measures SQP iteration performance (not just OPD tracing)

npm run diag:optimize-algo-bench        # Baseline benchmark
npm run diag:optimize-algo-analyze      # Analysis with gates
npm run diag:optimize-algo-auto         # Full pipeline
npm run diag:optimize-algo-auto:strict  # With 1.5x threshold
```

**Requirement Gate Configuration:**
```json
{
  "requirementGate": {
    "enabled": true,
    "checks": [
      {
        "metric": "speedup",
        "condition": ">=",
        "threshold": 1.5,
        "actual": 1.52,
        "passed": true
      },
      {
        "metric": "solutionDelta",
        "condition": "<=",
        "threshold": 1e-8,
        "actual": 3.2e-10,
        "passed": true
      },
      {
        "metric": "convergenceRateDelta",
        "condition": "<=",
        "threshold": 0.05,
        "actual": 0.02,
        "passed": true
      }
    ],
    "passed": true,
    "failedChecks": []
  }
}
```

### Numerical Regression Tests

**Test Suite (testing/optimization/rust-sqp-parity.test.ts):**
```typescript
describe('Rust SQP Parity', () => {
  test('Double Gauss optimization - final merit function', async () => {
    const rustResult = await optimizeWithRustSQP(doubleGaussSystem);
    const tsResult = await optimizeWithTypeScriptSQP(doubleGaussSystem);
    
    expect(rustResult.finalMerit).toBeCloseTo(tsResult.finalMerit, 8);
  });
  
  test('Step direction accuracy', async () => {
    const { rustStep, tsStep } = await compareSingleSQPStep(testSystem);
    expect(vectorNorm(subtract(rustStep, tsStep))).toBeLessThan(1e-10);
  });
});
```

### Performance Profiling

**Before Migration (Baseline):**
```bash
npm run diag:opd-full-batch-auto:strict
# Current: 0.966x speedup (FAILING)
```

**After Each Phase:**
- Phase 1: Expected ~0.95x (LA overhead still present)
- Phase 2: Expected ~1.2x (SQP solver accelerated)
- Phase 3: Expected ~1.4x (iteration control optimized)
- Phase 4: **Target ~1.5x** (full integration optimized)

---

## Risk Assessment and Mitigation

### Risk 1: WASM Overhead May Negate Gains

**Symptoms:**
- Frequent JS ↔ WASM boundary crossings
- Small array allocations on every call

**Mitigation:**
- **Batch Operations:** Pass entire iteration data in single call
- **Preallocated Buffers:** Reuse TypedArray buffers across iterations
- **Profiling:** Use Chrome DevTools to identify bottlenecks

**Example Batching:**
```rust
// Instead of: multiple small calls per iteration
// Do: single large call with all iteration data
pub fn run_sqp_iterations(
    x0: &[f64],
    max_iterations: usize,
    objective_callback: &js_sys::Function,  // JS evaluates objectives only
) -> SQPFullResult;
```

### Risk 2: Numerical Instability in Rust Implementation

**Symptoms:**
- Different rounding behavior vs TypeScript
- Cholesky factorization failures
- Non-convergence on edge cases

**Mitigation:**
- **IEEE 754 Compliance:** Verify Rust math matches JS `Math.*` functions
- **Condition Number Checks:** Add numerical stability diagnostics
- **Regression Tests:** 100+ test problems with known solutions

**Stability Checks:**
```rust
fn is_hessian_positive_definite(H: &[f64], n: usize) -> bool {
    // Check condition number before Cholesky
    let cond = estimate_condition_number(H, n);
    if cond > 1e12 {
        warn!("Ill-conditioned Hessian: cond={}", cond);
        return false;
    }
    true
}
```

### Risk 3: Requirements Subsystem Interference

**Symptoms:**
- Rust solver receives incorrect gradient/Jacobian from TypeScript
- Objective evaluation changes during migration break assumptions

**Mitigation:**
- **Boundary Verification:** Add debug mode that logs all JS→Rust inputs
- **Non-Interference Test:** Run full Requirements UI workflow with Rust optimizer
- **Integration Tests:** Verify end-to-end optimization with complex Requirements

**Debug Mode:**
```typescript
if (DEBUG_RUST_OPTIMIZER) {
  console.log('[Rust SQP Input Validation]', {
    gradientNorm: vectorNorm(gradient),
    jacobianRank: matrixRank(jacobian),
    residualNorm: vectorNorm(residuals),
  });
}
```

---

## Implementation Timeline

| Phase | Duration | Deliverables | Gates |
|-------|----------|--------------|-------|
| **Phase 0: Setup** | 1 day | Baseline benchmark, test infrastructure | N/A |
| **Phase 1: LA Kernels** | 2-3 days | Vector/matrix operations in Rust, unit tests | Math accuracy: all tests pass |
| **Phase 2: SQP Core** | 3-4 days | QP solver, BFGS update, trust region | Step accuracy: ≤1e-10 delta |
| **Phase 3: Iteration Control** | 2 days | Line search, radius update | Convergence parity verified |
| **Phase 4: Integration** | 4-5 days | Default switch, fallback, profiling | **Speedup ≥1.5x**, solution delta ≤1e-8 |
| **Phase 5: Validation** | 2-3 days | Full regression suite, CI integration | All gates pass, zero regressions |

**Total Estimated Duration:** 14-18 days

---

## Acceptance Criteria (Go/No-Go Decision)

### ✅ Go Criteria (Enable Rust Optimizer by Default)

1. **Performance:**
   - Speedup ≥ 1.5x on `diag:optimize-algo-auto:strict`
   - No slowdown on any test problem vs TypeScript baseline

2. **Accuracy:**
   - Solution delta ≤ 1e-8 on all 100+ regression tests
   - Merit function convergence matches TypeScript within 0.1%

3. **Stability:**
   - Zero crashes/panics in 1000+ iteration test marathon
   - Graceful fallback to TypeScript on numerical failures

4. **Requirements Non-Interference:**
   - All Requirements UI workflows function identically
   - No changes required to `system-requirements-editor.ts`
   - Objective evaluation (`evalResidualsNow`) remains in TypeScript

### ❌ No-Go Criteria (Keep TypeScript as Default)

1. **Performance:** Speedup < 1.2x (insufficient gain for complexity)
2. **Accuracy:** Solution delta > 1e-6 (unacceptable numerical error)
3. **Instability:** ≥2 crashes in validation suite
4. **Interference:** Requirements subsystem requires any modifications

---

## Rollback Plan

If Rust optimizer fails acceptance criteria:

1. **Immediate Rollback:**
   ```typescript
   export const DEFAULT_OPTIMIZER_CONFIG: OptimizerConfig = {
     useRustSQP: false,  // Revert to TypeScript default
     rustFallbackOnError: true,
   };
   ```

2. **Preserve Rust Code:**
   - Keep all Rust implementations for future optimization
   - Maintain as opt-in feature flag

3. **Root Cause Analysis:**
   - Profile WASM boundary overhead
   - Investigate numerical stability issues
   - Consider alternative architectures (e.g., WebAssembly SIMD)

---

## Future Enhancements (Post-Launch)

### Phase 6: Second-Order Methods (Optional)
- Exact Hessian computation in Rust (if BFGS insufficient)
- Automatic differentiation integration

### Phase 7: Parallel Optimization (Optional)
- Multi-start optimization with Web Workers
- Gradient parallelization using WASM threads

### Phase 8: Advanced Algorithms (Optional)
- Interior-point methods for inequality constraints
- Augmented Lagrangian with adaptive penalty

---

## Appendix: Key Files and Dependencies

### Rust/WASM
- **Core Implementation:** `rust-wasm/src/lib.rs`
- **Cargo Config:** `rust-wasm/Cargo.toml`
- **Build Output:** `public/rust-wasm/pkg/`

### TypeScript Integration
- **Optimizer Core:** `optimization/optimizer-mvp.ts` (lines ~3000-3500)
- **SQP Helpers:** `optimization/kkt-optimizer.ts` (lines 295-370)
- **WASM Bridge:** `wasm/optimization/optimizer-wasm-bridge.ts`
- **Design Variables:** `optimization/design-variables.ts`

### Requirements Subsystem (EXCLUDED)
- **UI Editor:** `ui/editors/system-requirements-editor.ts`
- **Data Models:** `data/table-system-requirements.ts`, `data/table-configuration.ts`
- **Evaluation:** `optimizer-mvp.ts::evalResidualsNow()`

### Diagnostics
- **New Script:** `diagnostics/optimize-algorithm-benchmark.mjs`
- **Analysis:** `diagnostics/optimize-algorithm-analyze.mjs`
- **Automation:** `diagnostics/optimize-algorithm-auto.mjs`
- **Results:** `diagnostics/results/optimize-algo-*.json`

### Testing
- **Regression Suite:** `testing/optimization/rust-sqp-parity.test.ts`
- **Numerical Stability:** `testing/optimization/stability-tests.ts`

---

## References

1. **Ray Tracing Rust Migration:** Achieved zero-mismatch parity, serves as architectural template
2. **Current Benchmark Results:** `diagnostics/results/opd-full-batch-2026-02-28T21-20-46-725Z.json`
3. **SQP Algorithm Reference:** Nocedal & Wright, "Numerical Optimization" (2006), Chapter 18
4. **WASM Performance Guide:** WebAssembly documentation on boundary optimization

---

**Document Owner:** AI Assistant (GitHub Copilot)  
**Last Updated:** 2026-03-01  
**Next Review:** After Phase 2 completion
