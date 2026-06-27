import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const resultsDir = path.resolve(projectRoot, 'diagnostics/results');

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const key = `--${name}`;
  const idx = args.indexOf(key);
  if (idx < 0) return fallback;
  const val = args[idx + 1];
  if (val === undefined || String(val).startsWith('--')) return 'true';
  return val;
};

const toBool = (v, fallback = false) => {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

const toNum = (v, fallback = NaN) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const pickFirstFinite = (...values) => {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
};

const pickFirstObject = (...values) => {
  for (const v of values) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  }
  return null;
};

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const pickLatest = async () => {
  const names = await fs.readdir(resultsDir);
  const candidates = names.filter((n) => /^kkt-e2e-.*\.json$/i.test(n) && !/^kkt-e2e-analysis-.*\.json$/i.test(n));
  if (!candidates.length) return null;
  const withStat = await Promise.all(candidates.map(async (name) => {
    const full = path.resolve(resultsDir, name);
    const st = await fs.stat(full);
    return { full, mtimeMs: st.mtimeMs, name };
  }));
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return withStat[0].full;
};

const run = async () => {
  const inputArg = getArg('input', null);
  const outputArg = getArg('out', null);
  const requireGate = toBool(getArg('require', 'false'), false);

  const inputPath = inputArg ? path.resolve(projectRoot, inputArg) : await pickLatest();
  if (!inputPath || !(await exists(inputPath))) {
    throw new Error('No KKT E2E result JSON found. Run diag:kkt-e2e first or pass --input.');
  }

  const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));

  const totalSpeedup = toNum(raw?.speedups?.total, NaN);
  const solverSpeedup = toNum(raw?.speedups?.solverAndOther, NaN);

  const wasmRuns = toNum(raw?.wasm?.runs, NaN);
  const tsRuns = toNum(raw?.ts?.runs, NaN);
  const runCount = Number.isFinite(wasmRuns) ? wasmRuns : tsRuns;

  const wasmOkRate = Number.isFinite(wasmRuns) && wasmRuns > 0
    ? toNum(raw?.wasm?.okCount, 0) / wasmRuns
    : NaN;
  const tsOkRate = Number.isFinite(tsRuns) && tsRuns > 0
    ? toNum(raw?.ts?.okCount, 0) / tsRuns
    : NaN;
  const wasmFeasibleRate = Number.isFinite(wasmRuns) && wasmRuns > 0
    ? toNum(raw?.wasm?.feasibleCount, 0) / wasmRuns
    : NaN;
  const tsFeasibleRate = Number.isFinite(tsRuns) && tsRuns > 0
    ? toNum(raw?.ts?.feasibleCount, 0) / tsRuns
    : NaN;

  const report = {
    timestamp: new Date().toISOString(),
    inputPath: path.relative(projectRoot, inputPath),
    metrics: {
      runCount,
      totalSpeedup,
      solverSpeedup,
      wasmOkRate,
      tsOkRate,
      wasmFeasibleRate,
      tsFeasibleRate,
      wasmAvgTotalMs: toNum(raw?.wasm?.avgTotalMs, NaN),
      tsAvgTotalMs: toNum(raw?.ts?.avgTotalMs, NaN),
      wasmAvgIterations: toNum(raw?.wasm?.avgIterations, NaN),
      tsAvgIterations: toNum(raw?.ts?.avgIterations, NaN)
    }
  };

  const matrixFreeCalls = pickFirstFinite(
    raw?.phaseC?.matrixFreeCalls,
    raw?.phaseCMetrics?.matrixFreeCalls,
    raw?.wasm?.matrixFreeCalls,
    raw?.metrics?.matrixFreeCalls
  );
  const matrixFreeFallbacks = pickFirstFinite(
    raw?.phaseC?.matrixFreeFallbacks,
    raw?.phaseCMetrics?.matrixFreeFallbacks,
    raw?.wasm?.matrixFreeFallbacks,
    raw?.metrics?.matrixFreeFallbacks
  );
  const matrixFreeFallbackReasons = pickFirstObject(
    raw?.phaseC?.matrixFreeFallbackReasons,
    raw?.phaseCMetrics?.matrixFreeFallbackReasons,
    raw?.wasm?.matrixFreeFallbackReasons,
    raw?.metrics?.matrixFreeFallbackReasons
  ) || {};

  const unknownFallbackCount = Number(matrixFreeFallbackReasons.unknown) || 0;
  const matrixFreeFallbackRate = (Number.isFinite(matrixFreeCalls) && matrixFreeCalls > 0 && Number.isFinite(matrixFreeFallbacks))
    ? (matrixFreeFallbacks / matrixFreeCalls)
    : NaN;
  const matrixFreeUnknownFallbackRate = (Number.isFinite(matrixFreeFallbacks) && matrixFreeFallbacks > 0)
    ? (unknownFallbackCount / matrixFreeFallbacks)
    : NaN;

  report.phaseC = {
    matrixFreeCalls: Number.isFinite(matrixFreeCalls) ? matrixFreeCalls : null,
    matrixFreeFallbacks: Number.isFinite(matrixFreeFallbacks) ? matrixFreeFallbacks : null,
    matrixFreeFallbackRate: Number.isFinite(matrixFreeFallbackRate) ? matrixFreeFallbackRate : null,
    matrixFreeUnknownFallbackRate: Number.isFinite(matrixFreeUnknownFallbackRate) ? matrixFreeUnknownFallbackRate : null,
    matrixFreeFallbackReasons
  };

  if (requireGate) {
    const thresholds = {
      minTotalSpeedup: toNum(getArg('min-total-speedup', '1.0'), 1.0),
      minSolverSpeedup: toNum(getArg('min-solver-speedup', '1.0'), 1.0),
      minWasmOkRate: toNum(getArg('min-wasm-ok-rate', '1.0'), 1.0),
      minWasmFeasibleRate: toNum(getArg('min-wasm-feasible-rate', '1.0'), 1.0),
      requirePhaseC: toBool(getArg('require-phase-c', 'false'), false),
      maxMatrixFreeFallbackRate: toNum(getArg('max-matrixfree-fallback-rate', '0.05'), 0.05),
      maxMatrixFreeUnknownFallbackRate: toNum(getArg('max-matrixfree-unknown-fallback-rate', '0.01'), 0.01)
    };

    const checks = [
      {
        name: 'totalSpeedup',
        actual: totalSpeedup,
        limit: thresholds.minTotalSpeedup,
        pass: Number.isFinite(totalSpeedup) && totalSpeedup >= thresholds.minTotalSpeedup
      },
      {
        name: 'solverSpeedup',
        actual: solverSpeedup,
        limit: thresholds.minSolverSpeedup,
        pass: Number.isFinite(solverSpeedup) && solverSpeedup >= thresholds.minSolverSpeedup
      },
      {
        name: 'wasmOkRate',
        actual: wasmOkRate,
        limit: thresholds.minWasmOkRate,
        pass: Number.isFinite(wasmOkRate) && wasmOkRate >= thresholds.minWasmOkRate
      },
      {
        name: 'wasmFeasibleRate',
        actual: wasmFeasibleRate,
        limit: thresholds.minWasmFeasibleRate,
        pass: Number.isFinite(wasmFeasibleRate) && wasmFeasibleRate >= thresholds.minWasmFeasibleRate
      }
    ];

    if (thresholds.requirePhaseC) {
      checks.push(
        {
          name: 'phaseC.matrixFreeFallbackRate',
          actual: matrixFreeFallbackRate,
          limit: thresholds.maxMatrixFreeFallbackRate,
          pass: Number.isFinite(matrixFreeFallbackRate) && matrixFreeFallbackRate <= thresholds.maxMatrixFreeFallbackRate
        },
        {
          name: 'phaseC.matrixFreeUnknownFallbackRate',
          actual: matrixFreeUnknownFallbackRate,
          limit: thresholds.maxMatrixFreeUnknownFallbackRate,
          pass: Number.isFinite(matrixFreeUnknownFallbackRate)
            && matrixFreeUnknownFallbackRate <= thresholds.maxMatrixFreeUnknownFallbackRate
        }
      );
    }

    const failedChecks = checks.filter((c) => !c.pass);
    report.requirementGate = {
      enabled: true,
      thresholds,
      checks,
      failedChecks,
      passed: failedChecks.length === 0
    };
  }

  const outputPath = outputArg
    ? path.resolve(projectRoot, outputArg)
    : path.resolve(resultsDir, `kkt-e2e-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('✅ KKT E2E analysis complete');
  console.log(JSON.stringify({
    input: path.relative(projectRoot, inputPath),
    output: path.relative(projectRoot, outputPath),
    metrics: report.metrics,
    requirementGate: report.requirementGate || null
  }, null, 2));

  if (requireGate && report.requirementGate && !report.requirementGate.passed) {
    console.error('❌ KKT E2E requirement gate failed');
    process.exitCode = 2;
  }
};

await run();
