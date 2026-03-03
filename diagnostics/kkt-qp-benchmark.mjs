import { performance } from 'node:perf_hooks';
import {
  preloadOptimizerWasmBridge,
  solveQpSubproblemUnconstrainedWasm,
  solveQpSubproblemKktEqualityWasm,
  getOptimizerWasmBridgeDebugInfo
} from '../rust-wasm/ts/optimization/optimizer-wasm-bridge.ts';

function parseArg(name, fallback) {
  const key = `--${name}`;
  const index = process.argv.indexOf(key);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function randomUniform(seedState) {
  seedState.value = (1664525 * seedState.value + 1013904223) >>> 0;
  return seedState.value / 0xffffffff;
}

function randomNormal(seedState) {
  const u1 = Math.max(1e-12, randomUniform(seedState));
  const u2 = Math.max(1e-12, randomUniform(seedState));
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function createSpdMatrix(size, seedState) {
  const matrixA = Array.from({ length: size }, () => Array(size).fill(0));
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let colIndex = 0; colIndex < size; colIndex++) {
      matrixA[rowIndex][colIndex] = randomNormal(seedState);
    }
  }

  const hessian = Array.from({ length: size }, () => Array(size).fill(0));
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    for (let colIndex = 0; colIndex < size; colIndex++) {
      let sum = 0;
      for (let k = 0; k < size; k++) {
        sum += matrixA[k][rowIndex] * matrixA[k][colIndex];
      }
      hessian[rowIndex][colIndex] = sum + (rowIndex === colIndex ? 1e-2 : 0);
    }
  }
  return hessian;
}

function createVector(length, seedState, scale = 1) {
  const out = new Array(length);
  for (let index = 0; index < length; index++) {
    out[index] = scale * randomNormal(seedState);
  }
  return out;
}

function solveLinearSystemTs(matrixInput, rhsInput) {
  const size = matrixInput.length;
  if (!size || rhsInput.length !== size) return null;

  const matrix = matrixInput.map((row) => row.slice());
  const rhs = rhsInput.slice();

  for (let col = 0; col < size; col++) {
    let pivotRow = col;
    let pivotAbs = Math.abs(matrix[col][col]);
    for (let row = col + 1; row < size; row++) {
      const candidate = Math.abs(matrix[row][col]);
      if (candidate > pivotAbs) {
        pivotAbs = candidate;
        pivotRow = row;
      }
    }

    if (!Number.isFinite(pivotAbs) || pivotAbs < 1e-14) return null;

    if (pivotRow !== col) {
      const tmpRow = matrix[col];
      matrix[col] = matrix[pivotRow];
      matrix[pivotRow] = tmpRow;
      const tmpRhs = rhs[col];
      rhs[col] = rhs[pivotRow];
      rhs[pivotRow] = tmpRhs;
    }

    const pivot = matrix[col][col];
    for (let row = col + 1; row < size; row++) {
      const factor = matrix[row][col] / pivot;
      matrix[row][col] = 0;
      for (let c = col + 1; c < size; c++) {
        matrix[row][c] -= factor * matrix[col][c];
      }
      rhs[row] -= factor * rhs[col];
    }
  }

  const x = new Array(size).fill(0);
  for (let row = size - 1; row >= 0; row--) {
    let sum = rhs[row];
    for (let col = row + 1; col < size; col++) {
      sum -= matrix[row][col] * x[col];
    }
    const diag = matrix[row][row];
    if (!Number.isFinite(diag) || Math.abs(diag) < 1e-14) return null;
    x[row] = sum / diag;
    if (!Number.isFinite(x[row])) return null;
  }

  return x;
}

function solveQpUnconstrainedTs(hessian, gradient) {
  const size = gradient.length;
  const rhs = gradient.map((value) => -value);
  const solution = solveLinearSystemTs(hessian, rhs);
  if (!solution || solution.length !== size) return null;
  return solution;
}

function solveQpKktEqualityTs(hessian, gradient, jacobianEq, residualEq) {
  const variableCount = gradient.length;
  const eqCount = residualEq.length;
  const totalSize = variableCount + eqCount;

  const kkt = Array.from({ length: totalSize }, () => Array(totalSize).fill(0));
  const rhs = new Array(totalSize).fill(0);

  for (let row = 0; row < variableCount; row++) {
    rhs[row] = -gradient[row];
    for (let col = 0; col < variableCount; col++) {
      kkt[row][col] = hessian[row][col];
    }
    for (let eq = 0; eq < eqCount; eq++) {
      kkt[row][variableCount + eq] = jacobianEq[eq][row];
    }
  }

  for (let eq = 0; eq < eqCount; eq++) {
    rhs[variableCount + eq] = -residualEq[eq];
    for (let col = 0; col < variableCount; col++) {
      kkt[variableCount + eq][col] = jacobianEq[eq][col];
    }
  }

  const solution = solveLinearSystemTs(kkt, rhs);
  if (!solution || solution.length !== totalSize) return null;
  return solution.slice(0, variableCount);
}

function benchmark(name, rounds, callback) {
  const durations = [];
  let successCount = 0;

  for (let round = 0; round < rounds; round++) {
    const startTime = performance.now();
    const ok = callback();
    const endTime = performance.now();
    durations.push(endTime - startTime);
    if (ok) successCount += 1;
  }

  const totalMs = durations.reduce((sum, value) => sum + value, 0);
  const avgMs = totalMs / durations.length;
  const minMs = Math.min(...durations);
  const maxMs = Math.max(...durations);

  return {
    name,
    rounds,
    successCount,
    failCount: rounds - successCount,
    avgMs,
    minMs,
    maxMs
  };
}

async function main() {
  const rounds = parseArg('rounds', 200);
  const variableCount = parseArg('n', 24);
  const eqCount = parseArg('m', 6);
  const seed = parseArg('seed', 12345);

  const seedState = { value: seed >>> 0 };
  const hessian = createSpdMatrix(variableCount, seedState);
  const gradient = createVector(variableCount, seedState, 0.5);
  const jacobianEq = Array.from({ length: eqCount }, () => createVector(variableCount, seedState, 0.2));
  const residualEq = createVector(eqCount, seedState, 0.05);

  await preloadOptimizerWasmBridge();
  const debugInfo = getOptimizerWasmBridgeDebugInfo();

  const tsUnconstrained = benchmark('ts_unconstrained', rounds, () => {
    const dx = solveQpUnconstrainedTs(hessian, gradient);
    return !!dx;
  });

  const wasmUnconstrained = benchmark('wasm_unconstrained', rounds, () => {
    const result = solveQpSubproblemUnconstrainedWasm(hessian, gradient, 1e-10);
    return !!(result && result.dx && result.dx.length === variableCount);
  });

  const tsConstrained = benchmark('ts_kkt_equality', rounds, () => {
    const dx = solveQpKktEqualityTs(hessian, gradient, jacobianEq, residualEq);
    return !!dx;
  });

  const wasmConstrained = benchmark('wasm_kkt_equality', rounds, () => {
    const result = solveQpSubproblemKktEqualityWasm(hessian, gradient, jacobianEq, residualEq, 1e-10);
    return !!(result && result.dx && result.dx.length === variableCount);
  });

  const summary = {
    timestamp: new Date().toISOString(),
    config: {
      rounds,
      variableCount,
      eqCount,
      seed
    },
    bridge: debugInfo,
    results: {
      tsUnconstrained,
      wasmUnconstrained,
      tsConstrained,
      wasmConstrained
    },
    speedups: {
      unconstrained: tsUnconstrained.avgMs / wasmUnconstrained.avgMs,
      constrainedKkt: tsConstrained.avgMs / wasmConstrained.avgMs
    }
  };

  console.log('✅ KKT QP benchmark summary');
  console.log(JSON.stringify(summary, null, 2));
}

await main();
