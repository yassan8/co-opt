import { performance } from 'node:perf_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runKKTOptimization } from '../optimization/kkt-optimizer.ts';
import { preloadOptimizerWasmBridge, getOptimizerWasmBridgeDebugInfo } from '../rust-wasm/ts/optimization/optimizer-wasm-bridge.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const resultsDir = path.resolve(projectRoot, 'diagnostics/results');

function getArg(name, fallback) {
  const key = `--${name}`;
  const index = process.argv.indexOf(key);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function getArgRaw(name, fallback = null) {
  const key = `--${name}`;
  const index = process.argv.indexOf(key);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  const value = String(process.argv[index + 1] || '').trim();
  return value.length > 0 ? value : fallback;
}

function rand(seed) {
  seed.value = (1664525 * seed.value + 1013904223) >>> 0;
  return seed.value / 0xffffffff;
}

function randn(seed) {
  const u1 = Math.max(1e-12, rand(seed));
  const u2 = Math.max(1e-12, rand(seed));
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function createProblem(variableCount, eqCount, ineqCount, seedValue = 12345) {
  const seed = { value: seedValue >>> 0 };
  const target = new Array(variableCount);
  for (let index = 0; index < variableCount; index++) {
    target[index] = 0.2 * randn(seed);
  }

  const matrix = Array.from({ length: variableCount }, () => new Array(variableCount).fill(0));
  for (let row = 0; row < variableCount; row++) {
    for (let col = 0; col < variableCount; col++) {
      matrix[row][col] = 0.2 * randn(seed);
    }
  }

  const objective = (x) => {
    let sum = 0;
    for (let i = 0; i < variableCount; i++) {
      const xi = x[i] ?? 0;
      const ti = target[i] ?? 0;
      const d = xi - ti;
      sum += d * d;
      if (i + 1 < variableCount) {
        const xnext = x[i + 1] ?? 0;
        const r = xnext - xi * xi;
        sum += 2.0 * r * r;
      }
    }
    // 軽いカップリング項
    for (let row = 0; row < variableCount; row++) {
      let acc = 0;
      for (let col = 0; col < variableCount; col++) {
        acc += matrix[row][col] * (x[col] ?? 0);
      }
      sum += 0.001 * acc * acc;
    }
    return sum;
  };

  const equalityConstraints = Array.from({ length: eqCount }, (_, idx) => ({
    name: `eq_${idx}`,
    evaluate: (x) => {
      let v = 0;
      const start = (idx * 3) % Math.max(1, variableCount - 1);
      for (let i = 0; i < 4 && (start + i) < variableCount; i++) {
        const xi = x[start + i] ?? 0;
        v += (i + 1) * xi;
      }
      return v - 0.05 * (idx + 1);
    }
  }));

  const inequalityConstraints = Array.from({ length: ineqCount }, (_, idx) => ({
    name: `ineq_${idx}`,
    evaluate: (x) => {
      const i0 = (idx * 5) % variableCount;
      const i1 = (i0 + 1) % variableCount;
      const i2 = (i0 + 2) % variableCount;
      const x0 = x[i0] ?? 0;
      const x1 = x[i1] ?? 0;
      const x2 = x[i2] ?? 0;
      return x0 * x0 + 0.5 * x1 - 0.25 * x2 - 0.35;
    }
  }));

  const x0 = new Array(variableCount);
  for (let i = 0; i < variableCount; i++) {
    x0[i] = 0.5 * randn(seed);
  }

  return { objective, equalityConstraints, inequalityConstraints, x0 };
}

function withTiming(fn, timingBucket) {
  return (...args) => {
    const t0 = performance.now();
    const out = fn(...args);
    const t1 = performance.now();
    timingBucket.calls += 1;
    timingBucket.ms += (t1 - t0);
    return out;
  };
}

async function runSingle(config) {
  const problem = createProblem(config.n, config.mEq, config.mIneq, config.seed);

  const objectiveTiming = { calls: 0, ms: 0 };
  const constraintTiming = { calls: 0, ms: 0 };

  const objectiveTimed = withTiming(problem.objective, objectiveTiming);
  const equalityConstraintsTimed = problem.equalityConstraints.map((c) => ({
    name: c.name,
    evaluate: withTiming(c.evaluate, constraintTiming)
  }));
  const inequalityConstraintsTimed = problem.inequalityConstraints.map((c) => ({
    name: c.name,
    evaluate: withTiming(c.evaluate, constraintTiming)
  }));

  const t0 = performance.now();
  const result = await runKKTOptimization(objectiveTimed, problem.x0, {
    equalityConstraints: equalityConstraintsTimed,
    inequalityConstraints: inequalityConstraintsTimed,
    maxIterations: config.maxIter,
    useWasmQp: config.useWasmQp,
    penaltyParameter: 1.0,
    penaltyIncreaseFactor: 1.5,
    constraintTolerance: 1e-6
  });
  const t1 = performance.now();

  const totalMs = t1 - t0;
  const evalMs = objectiveTiming.ms + constraintTiming.ms;
  const solverAndOtherMs = Math.max(0, totalMs - evalMs);

  return {
    mode: config.useWasmQp ? 'wasm' : 'ts',
    ok: !!result.ok,
    iterations: result.iterations,
    feasible: !!result.feasible,
    fval: result.fval,
    reason: result.reason || null,
    totalMs,
    objectiveEval: objectiveTiming,
    constraintEval: constraintTiming,
    solverAndOtherMs
  };
}

function summarizeRuns(runs) {
  const count = runs.length;
  const avg = (selector) => runs.reduce((s, r) => s + selector(r), 0) / Math.max(1, count);
  return {
    runs: count,
    avgTotalMs: avg((r) => r.totalMs),
    avgSolverAndOtherMs: avg((r) => r.solverAndOtherMs),
    avgObjectiveEvalMs: avg((r) => r.objectiveEval.ms),
    avgConstraintEvalMs: avg((r) => r.constraintEval.ms),
    avgIterations: avg((r) => r.iterations),
    okCount: runs.filter((r) => r.ok).length,
    feasibleCount: runs.filter((r) => r.feasible).length
  };
}

async function main() {
  const rounds = getArg('rounds', 5);
  const n = getArg('n', 24);
  const mEq = getArg('meq', 6);
  const mIneq = getArg('mineq', 6);
  const maxIter = getArg('maxIter', 20);
  const seed = getArg('seed', 12345);
  const outArg = getArgRaw('out', null);

  await preloadOptimizerWasmBridge();
  const bridgeInfo = getOptimizerWasmBridgeDebugInfo();

  const wasmRuns = [];
  const tsRuns = [];

  for (let i = 0; i < rounds; i++) {
    wasmRuns.push(await runSingle({ n, mEq, mIneq, maxIter, seed: seed + i, useWasmQp: true }));
    tsRuns.push(await runSingle({ n, mEq, mIneq, maxIter, seed: seed + i, useWasmQp: false }));
  }

  const wasmSummary = summarizeRuns(wasmRuns);
  const tsSummary = summarizeRuns(tsRuns);

  const summary = {
    timestamp: new Date().toISOString(),
    config: { rounds, n, mEq, mIneq, maxIter, seed },
    bridge: bridgeInfo,
    wasm: wasmSummary,
    ts: tsSummary,
    speedups: {
      total: tsSummary.avgTotalMs / wasmSummary.avgTotalMs,
      solverAndOther: tsSummary.avgSolverAndOtherMs / wasmSummary.avgSolverAndOtherMs
    },
    detail: {
      wasmRuns,
      tsRuns
    }
  };

  const timestampTag = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = outArg
    ? path.resolve(projectRoot, outArg)
    : path.resolve(resultsDir, `kkt-e2e-${timestampTag}.json`);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log('✅ KKT E2E benchmark summary');
  console.log(JSON.stringify({ output: path.relative(projectRoot, outputPath) }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

await main();
