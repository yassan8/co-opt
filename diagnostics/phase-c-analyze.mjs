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

const toBool = (value, fallback = false) => {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

const toNum = (value, fallback = NaN) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const exists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const pickLatest = async () => {
  const names = await fs.readdir(resultsDir);
  const candidates = names.filter((name) => /^phase-c-benchmark-.*\.json$/i.test(name) && !/^phase-c-analysis-.*\.json$/i.test(name));
  if (!candidates.length) return null;
  const withStat = await Promise.all(candidates.map(async (name) => {
    const full = path.resolve(resultsDir, name);
    const stat = await fs.stat(full);
    return { full, mtimeMs: stat.mtimeMs, name };
  }));
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return withStat[0].full;
};

const normalizeMode = (value) => {
  const s = String(value || 'selected').trim().toLowerCase();
  if (s === 'matrixfree' || s === 'matrix-free') return 'matrixFree';
  if (s === 'matrixfreepriority' || s === 'matrix-free-priority' || s === 'priority') return 'matrixFreePriority';
  return 'selected';
};

const run = async () => {
  const inputArg = getArg('input', null);
  const outputArg = getArg('out', null);
  const requireGate = toBool(getArg('require', 'false'), false);
  const selectedMode = normalizeMode(getArg('mode', 'selected'));

  const inputPath = inputArg ? path.resolve(projectRoot, inputArg) : await pickLatest();
  if (!inputPath || !(await exists(inputPath))) {
    throw new Error('No Phase C benchmark JSON found. Export one with OptimizationMVP.exportMatrixFreeJson(...) or pass --input.');
  }

  const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const baseline = raw?.baseline || {};
  const matrixFree = raw?.matrixFree || {};
  const matrixFreePriority = raw?.matrixFreePriority || {};
  const phaseCSelectedMode = selectedMode === 'selected'
    ? String(raw?.phaseC?.selectedMode || 'matrixFree')
    : selectedMode;
  const selected = phaseCSelectedMode === 'matrixFreePriority' ? matrixFreePriority : matrixFree;
  const selectedPhaseC = selected?.phaseC || raw?.phaseC || {};

  const baselineOkRatePct = toNum(raw?.phaseC?.baselineOkRatePct ?? baseline?.okRatePct, NaN);
  const selectedOkRatePct = toNum(raw?.phaseC?.selectedMode === phaseCSelectedMode ? raw?.phaseC?.okRatePct : selectedPhaseC?.okRatePct, NaN);
  const elapsedSpeedup = toNum(
    phaseCSelectedMode === 'matrixFreePriority'
      ? raw?.speedups?.matrixFreePriorityElapsed
      : raw?.speedups?.matrixFreeElapsed,
    NaN
  );
  const matrixFreeCalls = toNum(selectedPhaseC?.matrixFreeCalls, NaN);
  const matrixFreeFallbacks = toNum(selectedPhaseC?.matrixFreeFallbacks, NaN);
  const matrixFreeFallbackRate = toNum(selectedPhaseC?.matrixFreeFallbackRate, NaN);
  const matrixFreeUnknownFallbackRate = toNum(selectedPhaseC?.matrixFreeUnknownFallbackRate, NaN);

  const report = {
    timestamp: new Date().toISOString(),
    inputPath: path.relative(projectRoot, inputPath),
    selectedMode: phaseCSelectedMode,
    metrics: {
      elapsedSpeedup,
      baselineOkRatePct,
      selectedOkRatePct,
      okRateDeltaPct: Number.isFinite(selectedOkRatePct) && Number.isFinite(baselineOkRatePct)
        ? (selectedOkRatePct - baselineOkRatePct)
        : null,
      matrixFreeCalls: Number.isFinite(matrixFreeCalls) ? matrixFreeCalls : null,
      matrixFreeFallbacks: Number.isFinite(matrixFreeFallbacks) ? matrixFreeFallbacks : null,
      matrixFreeFallbackRate: Number.isFinite(matrixFreeFallbackRate) ? matrixFreeFallbackRate : null,
      matrixFreeUnknownFallbackRate: Number.isFinite(matrixFreeUnknownFallbackRate) ? matrixFreeUnknownFallbackRate : null,
      matrixFreeHitRatePct: Number.isFinite(toNum(selectedPhaseC?.matrixFreeHitRatePct, NaN)) ? toNum(selectedPhaseC?.matrixFreeHitRatePct, NaN) : null,
      matrixFreeCgItersAvg: Number.isFinite(toNum(selectedPhaseC?.matrixFreeCgItersAvg, NaN)) ? toNum(selectedPhaseC?.matrixFreeCgItersAvg, NaN) : null,
      matrixFreeSolverItersAvg: Number.isFinite(toNum(selectedPhaseC?.matrixFreeSolverItersAvg, NaN)) ? toNum(selectedPhaseC?.matrixFreeSolverItersAvg, NaN) : null,
      matrixFreeResidualNormAvg: Number.isFinite(toNum(selectedPhaseC?.matrixFreeResidualNormAvg, NaN)) ? toNum(selectedPhaseC?.matrixFreeResidualNormAvg, NaN) : null,
      matrixFreeMsAvg: Number.isFinite(toNum(selectedPhaseC?.matrixFreeMsAvg, NaN)) ? toNum(selectedPhaseC?.matrixFreeMsAvg, NaN) : null,
      matrixFreeFallbackReasons: (selectedPhaseC?.matrixFreeFallbackReasons && typeof selectedPhaseC.matrixFreeFallbackReasons === 'object')
        ? selectedPhaseC.matrixFreeFallbackReasons
        : {}
    }
  };

  if (requireGate) {
    const thresholds = {
      minElapsedSpeedup: toNum(getArg('min-elapsed-speedup', '1.5'), 1.5),
      minOkRateDeltaPct: toNum(getArg('min-ok-rate-delta-pct', '0'), 0),
      maxMatrixFreeFallbackRate: toNum(getArg('max-matrixfree-fallback-rate', '0.05'), 0.05),
      maxMatrixFreeUnknownFallbackRate: toNum(getArg('max-matrixfree-unknown-fallback-rate', '0.01'), 0.01),
      requireMatrixFreeCalls: toBool(getArg('require-matrixfree-calls', 'true'), true)
    };

    const okRateDeltaPct = Number(report.metrics.okRateDeltaPct);
    const checks = [
      {
        name: 'elapsedSpeedup',
        actual: elapsedSpeedup,
        limit: thresholds.minElapsedSpeedup,
        pass: Number.isFinite(elapsedSpeedup) && elapsedSpeedup >= thresholds.minElapsedSpeedup
      },
      {
        name: 'okRateDeltaPct',
        actual: okRateDeltaPct,
        limit: thresholds.minOkRateDeltaPct,
        pass: Number.isFinite(okRateDeltaPct) && okRateDeltaPct >= thresholds.minOkRateDeltaPct
      },
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
        pass: Number.isFinite(matrixFreeUnknownFallbackRate) && matrixFreeUnknownFallbackRate <= thresholds.maxMatrixFreeUnknownFallbackRate
      }
    ];

    if (thresholds.requireMatrixFreeCalls) {
      checks.push({
        name: 'phaseC.matrixFreeCalls',
        actual: matrixFreeCalls,
        limit: 1,
        pass: Number.isFinite(matrixFreeCalls) && matrixFreeCalls >= 1
      });
    }

    const failedChecks = checks.filter((check) => !check.pass);
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
    : path.resolve(resultsDir, `phase-c-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('✅ Phase C analysis complete');
  console.log(JSON.stringify({
    input: path.relative(projectRoot, inputPath),
    output: path.relative(projectRoot, outputPath),
    selectedMode: report.selectedMode,
    metrics: report.metrics,
    requirementGate: report.requirementGate || null
  }, null, 2));

  if (requireGate && report.requirementGate && !report.requirementGate.passed) {
    console.error('❌ Phase C requirement gate failed');
    process.exitCode = 2;
  }
};

await run();