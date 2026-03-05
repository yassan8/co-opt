import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const resultsDir = path.resolve(projectRoot, 'diagnostics/results');

const rawArgs = process.argv.slice(2);

const getArg = (name, fallback = null) => {
  const key = `--${name}`;
  const idx = rawArgs.indexOf(key);
  if (idx < 0) return fallback;
  const val = rawArgs[idx + 1];
  if (val === undefined || String(val).startsWith('--')) return 'true';
  return val;
};

const listLatest = async (pattern, excludePattern = null) => {
  const names = await fs.readdir(resultsDir);
  let candidates = names.filter((n) => pattern.test(n));
  if (excludePattern) candidates = candidates.filter((n) => !excludePattern.test(n));
  if (!candidates.length) return null;
  const withStat = await Promise.all(candidates.map(async (name) => {
    const full = path.resolve(resultsDir, name);
    const st = await fs.stat(full);
    return { full, mtimeMs: st.mtimeMs, name };
  }));
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return withStat[0].full;
};

const runNode = (scriptRel, args = [], envPatch = null) => {
  const scriptAbs = path.resolve(projectRoot, scriptRel);
  const r = spawnSync(process.execPath, ['--import', 'tsx', scriptAbs, ...args], {
    cwd: projectRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(envPatch && typeof envPatch === 'object' ? envPatch : null)
    }
  });
  if (r.stdout && String(r.stdout).trim()) {
    console.log(String(r.stdout).trim());
  }
  if (r.stderr && String(r.stderr).trim()) {
    console.error(String(r.stderr).trim());
  }
  if (r.signal) {
    throw new Error(`${scriptRel} failed with signal ${String(r.signal)}`);
  }
  if (r.status !== 0) {
    throw new Error(`${scriptRel} failed with code ${r.status ?? 1}`);
  }
};

const toNumArg = (name, fallback) => {
  const v = getArg(name, null);
  if (v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const toStrArg = (name, fallback) => {
  const v = getArg(name, null);
  if (v === null || v === undefined || String(v).trim() === '') return fallback;
  return String(v);
};

const toBoolArg = (name, fallback) => {
  const v = getArg(name, null);
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

const normalizeStartStep = (v) => {
  const s = String(v ?? 'perfquick').trim().toLowerCase();
  if (s === 'perfquick' || s === 'perf-quick' || s === 'quick' || s === '0') return 'perfquick';
  if (s === 'raytrace' || s === 'ray' || s === '1') return 'raytrace';
  if (s === 'opd' || s === '2') return 'opd';
  if (s === 'ta' || s === 'ta-mode' || s === 'tamode' || s === '3') return 'ta';
  if (s === 'kkt' || s === '4') return 'kkt';
  return 'perfquick';
};

const stepOrder = ['perfquick', 'raytrace', 'opd', 'ta', 'kkt'];

const run = async () => {
  const startedAt = new Date().toISOString();
  const startFrom = normalizeStartStep(getArg('start-from', 'perfquick'));
  const startIdx = stepOrder.indexOf(startFrom);
  const endAt = normalizeStartStep(getArg('end-at', 'kkt'));
  const endIdx = stepOrder.indexOf(endAt);
  const enablePerfQuick = toBoolArg('enable-perf-quick', true);

  const outDefault = `release-gate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outRel = toStrArg('out', path.join('diagnostics/results', outDefault));
  const outAbs = path.resolve(projectRoot, outRel);
  const checkpointRel = toStrArg('checkpoint-out', path.join('diagnostics/results', 'release-gate-checkpoint.json'));
  const checkpointAbs = path.resolve(projectRoot, checkpointRel);

  const persistSummary = async (summaryObj) => {
    summaryObj.timestamp = new Date().toISOString();
    await fs.mkdir(path.dirname(outAbs), { recursive: true });
    await fs.writeFile(outAbs, `${JSON.stringify(summaryObj, null, 2)}\n`, 'utf8');
    await fs.mkdir(path.dirname(checkpointAbs), { recursive: true });
    await fs.writeFile(checkpointAbs, `${JSON.stringify(summaryObj, null, 2)}\n`, 'utf8');
  };

  const thresholds = {
    raytraceMaxMismatchRate: toNumArg('ray-max-mismatch-rate', 0),
    raytraceMaxSuccessMismatchRate: toNumArg('ray-max-success-mismatch-rate', 0),
    raytraceMaxMeanOplUm: toNumArg('ray-max-mean-opl-um', 0),
    raytraceMaxOplUm: toNumArg('ray-max-opl-um', 0),
    opdMinSpeedup: toNumArg('opd-min-speedup', 1.05),
    opdMaxValidDiff: toNumArg('opd-max-valid-diff', 0),
    taMinMedianOfMedianSpeedup: toNumArg('ta-min-median-of-median-speedup', 0.99),
    taMinPerRaycountSpeedup: toNumArg('ta-min-per-raycount-speedup', 0.97),
    taRayCounts: toStrArg('ta-rayCounts', '21,31,51,81,101,151'),
    taLoops: toNumArg('ta-loops', 20),
    taRepeat: toNumArg('ta-repeat', 11),
    kktMinTotalSpeedup: toNumArg('kkt-min-total-speedup', 1.5),
    kktMinSolverSpeedup: toNumArg('kkt-min-solver-speedup', 1.0),
    kktMinWasmOkRate: toNumArg('kkt-min-wasm-ok-rate', 1.0),
    kktMinWasmFeasibleRate: toNumArg('kkt-min-wasm-feasible-rate', 1.0)
  };

  const perfQuickConfig = {
    opdGridSize: toNumArg('perf-opd-grid-size', 64),
    opdFieldX: toNumArg('perf-opd-field-x', 10),
    opdRuns: toNumArg('perf-opd-runs', 3),
    rayRays: toNumArg('perf-ray-rays', 25)
  };

  const kktRounds = toNumArg('kkt-rounds', 6);
  const kktN = toNumArg('kkt-n', 24);
  const kktMeq = toNumArg('kkt-meq', 6);
  const kktMineq = toNumArg('kkt-mineq', 6);
  const kktMaxIter = toNumArg('kkt-maxIter', 20);

  const summary = {
    timestamp: new Date().toISOString(),
    startedAt,
    thresholds,
    kktConfig: {
      rounds: kktRounds,
      n: kktN,
      meq: kktMeq,
      mineq: kktMineq,
      maxIter: kktMaxIter
    },
    controls: {
      startFrom,
      endAt,
      enablePerfQuick,
      output: path.relative(projectRoot, outAbs),
      checkpoint: path.relative(projectRoot, checkpointAbs)
    },
    steps: {
      perfquick: { passed: false, skipped: false, result: null, raytrace: null, aperture: null },
      raytrace: { passed: false, skipped: false, golden: null, analysis: null },
      opd: { passed: false, skipped: false, result: null, analysis: null },
      ta: { passed: false, skipped: false, result: null, analysis: null },
      kkt: { passed: false, skipped: false, result: null, analysis: null }
    },
    passed: false,
    failedStep: null,
    error: null
  };

  const shouldRunStep = (step) => {
    const idx = stepOrder.indexOf(step);
    return idx >= 0 && idx >= startIdx && idx <= endIdx;
  };

  try {
    if (enablePerfQuick && shouldRunStep('perfquick')) {
      const perfStamp = new Date().toISOString().replace(/[:.]/g, '-');
      const perfOpdRel = path.join('diagnostics/results', `opd-full-batch-quick-release-gate-${perfStamp}.json`);
      const perfRayRel = path.join('diagnostics/results', `raytrace-golden-quick-release-gate-${perfStamp}.json`);

      runNode('diagnostics/perf-quick-auto.mjs', [
        '--require', 'true',
        '--opd-out', perfOpdRel,
        '--ray-out', perfRayRel,
        '--opd-grid-size', String(perfQuickConfig.opdGridSize),
        '--opd-field-x', String(perfQuickConfig.opdFieldX),
        '--opd-runs', String(perfQuickConfig.opdRuns),
        '--ray-rays', String(perfQuickConfig.rayRays),
        '--min-opd-speedup', String(thresholds.opdMinSpeedup),
        '--max-ray-status-mismatch', String(thresholds.raytraceMaxMismatchRate),
        '--max-ray-success-mismatch', String(thresholds.raytraceMaxSuccessMismatchRate),
        '--max-ray-max-opl-um', String(thresholds.raytraceMaxOplUm)
      ]);

      const perfOpdAbs = path.resolve(projectRoot, perfOpdRel);
      const perfRayAbs = path.resolve(projectRoot, perfRayRel);
      const perfApertureAbs = path.resolve(projectRoot, perfRayRel.replace(/\.json$/i, '-aperture.json'));
      summary.steps.perfquick = {
        passed: true,
        skipped: false,
        result: path.relative(projectRoot, perfOpdAbs),
        raytrace: path.relative(projectRoot, perfRayAbs),
        aperture: path.relative(projectRoot, perfApertureAbs)
      };
    } else {
      summary.steps.perfquick = { ...summary.steps.perfquick, skipped: true };
    }
    await persistSummary(summary);

    if (shouldRunStep('raytrace')) {
      runNode('diagnostics/raytrace-golden-auto.mjs', [
        '--max-mismatch-rate', String(thresholds.raytraceMaxMismatchRate),
        '--max-success-mismatch-rate', String(thresholds.raytraceMaxSuccessMismatchRate),
        '--max-mean-opl-um', String(thresholds.raytraceMaxMeanOplUm),
        '--max-opl-um', String(thresholds.raytraceMaxOplUm)
      ]);

      const rayGolden = await listLatest(/^raytrace-golden-.*\.json$/i, /^raytrace-golden-analysis-.*\.json$/i);
      const rayAnalysis = await listLatest(/^raytrace-golden-analysis-.*\.json$/i);
      summary.steps.raytrace = {
        passed: !!(rayGolden && rayAnalysis),
        skipped: false,
        golden: rayGolden ? path.relative(projectRoot, rayGolden) : null,
        analysis: rayAnalysis ? path.relative(projectRoot, rayAnalysis) : null
      };
    } else {
      summary.steps.raytrace = { ...summary.steps.raytrace, skipped: true };
    }
    await persistSummary(summary);

    const opdStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const opdResultRel = path.join('diagnostics/results', `opd-full-batch-release-gate-${opdStamp}.json`);
    const opdAnalysisRel = path.join('diagnostics/results', `opd-full-batch-analysis-release-gate-${opdStamp}.json`);

    if (shouldRunStep('opd')) {
      runNode(
        'diagnostics/opd-full-batch-benchmark.mjs',
        ['--out', opdResultRel],
        {
          OPD_FORCE_FINITE: '1',
          OPD_FIELD_X: '0'
        }
      );

      runNode('diagnostics/opd-full-batch-analyze.mjs', [
        '--input', opdResultRel,
        '--out', opdAnalysisRel,
        '--require', 'true',
        '--min-speedup', String(thresholds.opdMinSpeedup),
        '--max-valid-diff', String(thresholds.opdMaxValidDiff)
      ]);

      const opdResult = path.resolve(projectRoot, opdResultRel);
      const opdAnalysis = path.resolve(projectRoot, opdAnalysisRel);
      summary.steps.opd = {
        passed: !!(opdResult && opdAnalysis),
        skipped: false,
        result: opdResult ? path.relative(projectRoot, opdResult) : null,
        analysis: opdAnalysis ? path.relative(projectRoot, opdAnalysis) : null
      };
    } else {
      summary.steps.opd = { ...summary.steps.opd, skipped: true };
    }
    await persistSummary(summary);

    if (shouldRunStep('ta')) {
      runNode('diagnostics/ta-rms-lightweight-mode-auto.mjs', [
        '--rayCounts', String(thresholds.taRayCounts),
        '--loops', String(thresholds.taLoops),
        '--repeat', String(thresholds.taRepeat),
        '--min-median-of-median-speedup', String(thresholds.taMinMedianOfMedianSpeedup),
        '--min-per-raycount-speedup', String(thresholds.taMinPerRaycountSpeedup)
      ]);

      const taResult = await listLatest(/^ta-rms-lightweight-vs-statsonly-.*\.json$/i, /^ta-rms-lightweight-vs-statsonly-analysis-.*\.json$/i);
      const taAnalysis = await listLatest(/^ta-rms-lightweight-vs-statsonly-analysis-.*\.json$/i);
      summary.steps.ta = {
        passed: !!(taResult && taAnalysis),
        skipped: false,
        result: taResult ? path.relative(projectRoot, taResult) : null,
        analysis: taAnalysis ? path.relative(projectRoot, taAnalysis) : null
      };
    } else {
      summary.steps.ta = { ...summary.steps.ta, skipped: true };
    }
    await persistSummary(summary);

    if (shouldRunStep('kkt')) {
      runNode('diagnostics/kkt-e2e-auto.mjs', [
        '--min-total-speedup', String(thresholds.kktMinTotalSpeedup),
        '--min-solver-speedup', String(thresholds.kktMinSolverSpeedup),
        '--min-wasm-ok-rate', String(thresholds.kktMinWasmOkRate),
        '--min-wasm-feasible-rate', String(thresholds.kktMinWasmFeasibleRate),
        '--rounds', String(kktRounds),
        '--n', String(kktN),
        '--meq', String(kktMeq),
        '--mineq', String(kktMineq),
        '--maxIter', String(kktMaxIter)
      ]);

      const kktResult = await listLatest(/^kkt-e2e-.*\.json$/i, /^kkt-e2e-analysis-.*\.json$/i);
      const kktAnalysis = await listLatest(/^kkt-e2e-analysis-.*\.json$/i);
      summary.steps.kkt = {
        passed: !!(kktResult && kktAnalysis),
        skipped: false,
        result: kktResult ? path.relative(projectRoot, kktResult) : null,
        analysis: kktAnalysis ? path.relative(projectRoot, kktAnalysis) : null
      };
    } else {
      summary.steps.kkt = { ...summary.steps.kkt, skipped: true };
    }
    await persistSummary(summary);

    summary.passed = ['perfquick', 'raytrace', 'opd', 'ta', 'kkt'].every((step) => {
      const s = summary.steps[step];
      return s.skipped || s.passed;
    });
  } catch (e) {
    const msg = String((e && e.message) ? e.message : e || 'release gate failed');
    summary.error = msg;
    if (msg.includes('perf-quick-auto')) summary.failedStep = 'perfquick';
    else if (msg.includes('raytrace-golden-auto')) summary.failedStep = 'raytrace';
    else if (msg.includes('opd-full-batch-benchmark') || msg.includes('opd-full-batch-analyze') || msg.includes('opd-full-batch-auto')) summary.failedStep = 'opd';
    else if (msg.includes('ta-rms-lightweight-mode-auto') || msg.includes('ta-rms-lightweight-mode-analyze') || msg.includes('ta-rms-micro-benchmark')) summary.failedStep = 'ta';
    else if (msg.includes('kkt-e2e-auto')) summary.failedStep = 'kkt';
    else if (msg.includes('failed with signal')) summary.failedStep = 'interrupted';
    else summary.failedStep = 'unknown';

    // Best-effort artifact discovery for debugging failed step.
    if (enablePerfQuick && shouldRunStep('perfquick')) {
      const perfOpd = await listLatest(/^opd-full-batch-quick-.*\.json$/i);
      const perfRay = await listLatest(/^raytrace-golden-quick-.*\.json$/i, /^raytrace-golden-analysis-.*\.json$/i);
      const perfAperture = perfRay ? path.resolve(path.dirname(perfRay), `${path.basename(perfRay, '.json')}-aperture.json`) : null;
      if (perfOpd || perfRay) {
        summary.steps.perfquick = {
          passed: false,
          skipped: false,
          result: perfOpd ? path.relative(projectRoot, perfOpd) : null,
          raytrace: perfRay ? path.relative(projectRoot, perfRay) : null,
          aperture: perfAperture ? path.relative(projectRoot, perfAperture) : null
        };
      }
    }

    if (shouldRunStep('raytrace')) {
      const rayGolden = await listLatest(/^raytrace-golden-.*\.json$/i, /^raytrace-golden-analysis-.*\.json$/i);
      const rayAnalysis = await listLatest(/^raytrace-golden-analysis-.*\.json$/i);
      if (rayGolden || rayAnalysis) {
        summary.steps.raytrace = {
          passed: false,
          skipped: false,
          golden: rayGolden ? path.relative(projectRoot, rayGolden) : null,
          analysis: rayAnalysis ? path.relative(projectRoot, rayAnalysis) : null
        };
      }
    }

    if (shouldRunStep('opd')) {
      const opdResult = await listLatest(/^opd-full-batch-.*\.json$/i, /^opd-full-batch-analysis-.*\.json$/i);
      const opdAnalysis = await listLatest(/^opd-full-batch-analysis-.*\.json$/i);
      if (opdResult || opdAnalysis) {
        summary.steps.opd = {
          passed: false,
          skipped: false,
          result: opdResult ? path.relative(projectRoot, opdResult) : null,
          analysis: opdAnalysis ? path.relative(projectRoot, opdAnalysis) : null
        };
      }
    }

    if (shouldRunStep('ta')) {
      const taResult = await listLatest(/^ta-rms-lightweight-vs-statsonly-.*\.json$/i, /^ta-rms-lightweight-vs-statsonly-analysis-.*\.json$/i);
      const taAnalysis = await listLatest(/^ta-rms-lightweight-vs-statsonly-analysis-.*\.json$/i);
      if (taResult || taAnalysis) {
        summary.steps.ta = {
          passed: false,
          skipped: false,
          result: taResult ? path.relative(projectRoot, taResult) : null,
          analysis: taAnalysis ? path.relative(projectRoot, taAnalysis) : null
        };
      }
    }

    if (shouldRunStep('kkt')) {
      const kktResult = await listLatest(/^kkt-e2e-.*\.json$/i, /^kkt-e2e-analysis-.*\.json$/i);
      const kktAnalysis = await listLatest(/^kkt-e2e-analysis-.*\.json$/i);
      if (kktResult || kktAnalysis) {
        summary.steps.kkt = {
          passed: false,
          skipped: false,
          result: kktResult ? path.relative(projectRoot, kktResult) : null,
          analysis: kktAnalysis ? path.relative(projectRoot, kktAnalysis) : null
        };
      }
    }

    await persistSummary(summary);
  }

  await persistSummary(summary);

  console.log('✅ Release gate summary');
  console.log(JSON.stringify({
    output: path.relative(projectRoot, outAbs),
    checkpoint: path.relative(projectRoot, checkpointAbs),
    passed: summary.passed,
    failedStep: summary.failedStep,
    perfQuickEnabled: enablePerfQuick,
    steps: summary.steps
  }, null, 2));

  if (!summary.passed) {
    process.exitCode = 2;
  }
};

await run();
