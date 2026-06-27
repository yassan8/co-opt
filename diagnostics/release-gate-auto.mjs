import { spawn } from 'node:child_process';
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runNode = async (scriptRel, args = [], envPatch = null, options = null) => {
  const scriptAbs = path.resolve(projectRoot, scriptRel);
  const retries = Math.max(1, Number(options?.retries) || 1);
  const timeoutMs = Math.max(0, Number(options?.timeoutMs) || 0);
  const idleTimeoutMs = Math.max(0, Number(options?.idleTimeoutMs) || 0);
  const heartbeatMs = Math.max(1000, Number(options?.heartbeatMs) || 30000);
  const label = String(options?.label || scriptRel);
  const successMarker = options?.successMarker ? String(options.successMarker) : '';
  const successOnMarkerIdle = options?.successOnMarkerIdle === true;

  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const startedAt = Date.now();
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', scriptAbs, ...args], {
        cwd: projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(envPatch && typeof envPatch === 'object' ? envPatch : null)
        }
      });

      let settled = false;
      let lastOutputAt = Date.now();
      let markerSeen = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeatTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve(payload);
      };

      child.stdout?.on('data', (chunk) => {
        const text = String(chunk ?? '');
        lastOutputAt = Date.now();
        if (successMarker && text.includes(successMarker)) markerSeen = true;
        try { process.stdout.write(chunk); } catch (_) {}
      });
      child.stderr?.on('data', (chunk) => {
        const text = String(chunk ?? '');
        lastOutputAt = Date.now();
        if (successMarker && text.includes(successMarker)) markerSeen = true;
        try { process.stderr.write(chunk); } catch (_) {}
      });

      child.on('error', (e) => {
        finish({ ok: false, error: e, code: null, signal: null, timedOut: false });
      });

      child.on('close', (code, signal) => {
        if (signal) {
          finish({ ok: false, error: new Error(`${scriptRel} failed with signal ${String(signal)}`), code, signal, timedOut: false });
          return;
        }
        if (code !== 0) {
          finish({ ok: false, error: new Error(`${scriptRel} failed with code ${code ?? 1}`), code, signal, timedOut: false });
          return;
        }
        finish({ ok: true, error: null, code, signal, timedOut: false });
      });

      const heartbeatTimer = setInterval(() => {
        const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        console.log(`⏱️ [release-gate] ${label} running... ${elapsedSec}s elapsed (attempt ${attempt}/${retries})`);

        if (idleTimeoutMs > 0) {
          const idleMs = Date.now() - lastOutputAt;
          if (idleMs >= idleTimeoutMs) {
            try { child.kill('SIGTERM'); } catch (_) {}
            if (successOnMarkerIdle && markerSeen) {
              console.warn(`⚠️ [release-gate] ${label} idle timeout (${idleTimeoutMs}ms) after success marker; treating as completed`);
              finish({ ok: true, error: null, code: 0, signal: 'SIGTERM', timedOut: false, forcedByMarker: true });
            } else {
              finish({
                ok: false,
                error: new Error(`${scriptRel} idle timed out after ${idleTimeoutMs}ms with no output`),
                code: null,
                signal: 'SIGTERM',
                timedOut: true
              });
            }
          }
        }
      }, heartbeatMs);

      let timeoutTimer = null;
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch (_) {}
          finish({
            ok: false,
            error: new Error(`${scriptRel} timed out after ${timeoutMs}ms`),
            code: null,
            signal: 'SIGTERM',
            timedOut: true
          });
        }, timeoutMs);
      }
    });

    if (result.ok) {
      return;
    }

    lastErr = result.error;
    if (attempt < retries) {
      const backoffMs = Math.min(30000, 2000 * attempt);
      console.warn(`⚠️ [release-gate] ${label} failed (attempt ${attempt}/${retries}): ${String(result.error?.message || result.error)}; retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
      continue;
    }
  }

  throw (lastErr || new Error(`${scriptRel} failed`));
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
  if (s === 'opdparity' || s === 'opd-parity' || s === 'opd-js-rust' || s === '2') return 'opdparity';
  if (s === 'nativeoperands' || s === 'native-operands' || s === 'native' || s === '3') return 'nativeoperands';
  if (s === 'opd' || s === '4') return 'opd';
  if (s === 'ta' || s === 'ta-mode' || s === 'tamode' || s === '5') return 'ta';
  if (s === 'kkt' || s === '6') return 'kkt';
  if (s === 'phasec' || s === 'phase-c' || s === 'matrixfree' || s === 'matrix-free' || s === '7') return 'phasec';
  return 'perfquick';
};

const stepOrder = ['perfquick', 'raytrace', 'opdparity', 'nativeoperands', 'opd', 'ta', 'kkt', 'phasec'];

const run = async () => {
  const startedAt = new Date().toISOString();
  const startFrom = normalizeStartStep(getArg('start-from', 'perfquick'));
  const startIdx = stepOrder.indexOf(startFrom);
  const endAt = normalizeStartStep(getArg('end-at', 'kkt'));
  const endIdx = stepOrder.indexOf(endAt);
  const enablePerfQuick = toBoolArg('enable-perf-quick', true);
  const enablePhaseC = toBoolArg('phasec-enable', false);
  const phaseCInput = toStrArg('phasec-input', '');

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
    opdParityMaxDiffWaves: toNumArg('opd-parity-max-diff-waves', 1e-3),
    opdParityRmsDiffWaves: toNumArg('opd-parity-rms-diff-waves', 5e-4),
    opdParityMeanDiffWaves: toNumArg('opd-parity-mean-diff-waves', 5e-4),
    opdParityGrid: toNumArg('opd-parity-grid', 65),
    opdParityFields: toStrArg('opd-parity-fields', '0,5,10,15'),
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
    kktMinWasmFeasibleRate: toNumArg('kkt-min-wasm-feasible-rate', 1.0),
    kktRequirePhaseC: toBoolArg('kkt-require-phase-c', false),
    kktMaxMatrixFreeFallbackRate: toNumArg('kkt-max-matrixfree-fallback-rate', 0.05),
    kktMaxMatrixFreeUnknownFallbackRate: toNumArg('kkt-max-matrixfree-unknown-fallback-rate', 0.01),
    phaseCMinElapsedSpeedup: toNumArg('phasec-min-elapsed-speedup', 1.5),
    phaseCMinOkRateDeltaPct: toNumArg('phasec-min-ok-rate-delta-pct', 0),
    phaseCMaxMatrixFreeFallbackRate: toNumArg('phasec-max-matrixfree-fallback-rate', 0.05),
    phaseCMaxMatrixFreeUnknownFallbackRate: toNumArg('phasec-max-matrixfree-unknown-fallback-rate', 0.01)
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
  const stepTimeoutMs = toNumArg('step-timeout-ms', 0);
  // Default to no idle timeout to avoid false "stuck" detection on long silent steps.
  // Use --step-idle-timeout-ms N to re-enable watchdog behavior when needed.
  const stepIdleTimeoutMs = toNumArg('step-idle-timeout-ms', 0);
  const stepRetries = Math.max(1, toNumArg('step-retries', 1));
  const stepHeartbeatMs = Math.max(1000, toNumArg('step-heartbeat-ms', 30000));

  const runnerOptions = {
    timeoutMs: stepTimeoutMs,
    idleTimeoutMs: stepIdleTimeoutMs,
    retries: stepRetries,
    heartbeatMs: stepHeartbeatMs
  };

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
      enablePhaseC,
      phaseCInput: phaseCInput ? path.relative(projectRoot, path.resolve(projectRoot, phaseCInput)) : null,
      stepTimeoutMs,
      stepIdleTimeoutMs,
      stepRetries,
      stepHeartbeatMs,
      output: path.relative(projectRoot, outAbs),
      checkpoint: path.relative(projectRoot, checkpointAbs)
    },
    steps: {
      perfquick: { passed: false, skipped: false, result: null, raytrace: null, aperture: null },
      raytrace: { passed: false, skipped: false, golden: null, analysis: null },
      opdparity: { passed: false, skipped: false, result: null },
      nativeoperands: { passed: false, skipped: false, result: null },
      opd: { passed: false, skipped: false, result: null, analysis: null },
      ta: { passed: false, skipped: false, result: null, analysis: null },
      kkt: { passed: false, skipped: false, result: null, analysis: null },
      phasec: { passed: false, skipped: false, result: null, analysis: null }
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

      await runNode('diagnostics/perf-quick-auto.mjs', [
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
      ], null, { ...runnerOptions, label: 'perfquick', idleTimeoutMs: 0 });

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
      await runNode('diagnostics/raytrace-golden-auto.mjs', [
        '--max-mismatch-rate', String(thresholds.raytraceMaxMismatchRate),
        '--max-success-mismatch-rate', String(thresholds.raytraceMaxSuccessMismatchRate),
        '--max-mean-opl-um', String(thresholds.raytraceMaxMeanOplUm),
        '--max-opl-um', String(thresholds.raytraceMaxOplUm)
      ], null, { ...runnerOptions, label: 'raytrace' });

      const rayGolden = await listLatest(/^raytrace-golden-.*\.json$/i, /^raytrace-golden-analysis-.*\.json$/i);
      const rayGoldenFixed = (rayGolden && /-aperture\.json$/i.test(rayGolden))
        ? await listLatest(/^raytrace-golden-.*\.json$/i, /(^raytrace-golden-analysis-.*\.json$)|(-aperture\.json$)/i)
        : rayGolden;
      const rayAnalysis = await listLatest(/^raytrace-golden-analysis-.*\.json$/i);
      summary.steps.raytrace = {
        passed: !!(rayGoldenFixed && rayAnalysis),
        skipped: false,
        golden: rayGoldenFixed ? path.relative(projectRoot, rayGoldenFixed) : null,
        analysis: rayAnalysis ? path.relative(projectRoot, rayAnalysis) : null
      };
    } else {
      summary.steps.raytrace = { ...summary.steps.raytrace, skipped: true };
    }
    await persistSummary(summary);

    if (shouldRunStep('opdparity')) {
      const parityStamp = new Date().toISOString().replace(/[:.]/g, '-');
      const parityRel = path.join('diagnostics/results', `opd-js-rust-parity-release-gate-${parityStamp}.json`);
      await runNode('diagnostics/opd-js-rust-parity.mjs', [
        '--out', parityRel,
        '--grid', String(thresholds.opdParityGrid),
        '--fields', String(thresholds.opdParityFields),
        '--force-finite', '1',
        '--fail-max-diff-waves', String(thresholds.opdParityMaxDiffWaves),
        '--fail-rms-diff-waves', String(thresholds.opdParityRmsDiffWaves),
        '--fail-mean-diff-waves', String(thresholds.opdParityMeanDiffWaves)
      ], null, { ...runnerOptions, label: 'opdparity' });

      const parityAbs = path.resolve(projectRoot, parityRel);
      summary.steps.opdparity = {
        passed: true,
        skipped: false,
        result: path.relative(projectRoot, parityAbs)
      };
    } else {
      summary.steps.opdparity = { ...summary.steps.opdparity, skipped: true };
    }
    await persistSummary(summary);

    if (shouldRunStep('nativeoperands')) {
      const nativeOperandStamp = new Date().toISOString().replace(/[:.]/g, '-');
      const nativeOperandRel = path.join('diagnostics/results', `native-operands-auto-release-gate-${nativeOperandStamp}.json`);
      await runNode('diagnostics/native-operands-auto.mjs', [
        '--out', nativeOperandRel,
        '--require', 'true'
      ], null, { ...runnerOptions, label: 'nativeoperands', idleTimeoutMs: 0 });

      const nativeOperandAbs = path.resolve(projectRoot, nativeOperandRel);
      summary.steps.nativeoperands = {
        passed: true,
        skipped: false,
        result: path.relative(projectRoot, nativeOperandAbs)
      };
    } else {
      summary.steps.nativeoperands = { ...summary.steps.nativeoperands, skipped: true };
    }
    await persistSummary(summary);

    const opdStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const opdResultRel = path.join('diagnostics/results', `opd-full-batch-release-gate-${opdStamp}.json`);
    const opdAnalysisRel = path.join('diagnostics/results', `opd-full-batch-analysis-release-gate-${opdStamp}.json`);

    if (shouldRunStep('opd')) {
      await runNode(
        'diagnostics/opd-full-batch-benchmark.mjs',
        ['--out', opdResultRel],
        {
          OPD_FORCE_FINITE: '1',
          OPD_FIELD_X: '0'
        },
        {
          ...runnerOptions,
          label: 'opd-benchmark',
          // This step occasionally leaves a live event loop after writing the success summary.
          // Keep a local idle watchdog so the pipeline can proceed automatically.
          idleTimeoutMs: Math.max(20000, Number(runnerOptions.idleTimeoutMs) || 0),
          successMarker: '✅ OPD full-batch A/B benchmark summary',
          successOnMarkerIdle: true
        }
      );

      await runNode('diagnostics/opd-full-batch-analyze.mjs', [
        '--input', opdResultRel,
        '--out', opdAnalysisRel,
        '--require', 'true',
        '--min-speedup', String(thresholds.opdMinSpeedup),
        '--max-valid-diff', String(thresholds.opdMaxValidDiff)
      ], null, { ...runnerOptions, label: 'opd-analyze' });

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
      await runNode('diagnostics/ta-rms-lightweight-mode-auto.mjs', [
        '--rayCounts', String(thresholds.taRayCounts),
        '--loops', String(thresholds.taLoops),
        '--repeat', String(thresholds.taRepeat),
        '--min-median-of-median-speedup', String(thresholds.taMinMedianOfMedianSpeedup),
        '--min-per-raycount-speedup', String(thresholds.taMinPerRaycountSpeedup)
      ], null, { ...runnerOptions, label: 'ta', idleTimeoutMs: 0 });

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
      await runNode('diagnostics/kkt-e2e-auto.mjs', [
        '--min-total-speedup', String(thresholds.kktMinTotalSpeedup),
        '--min-solver-speedup', String(thresholds.kktMinSolverSpeedup),
        '--min-wasm-ok-rate', String(thresholds.kktMinWasmOkRate),
        '--min-wasm-feasible-rate', String(thresholds.kktMinWasmFeasibleRate),
        '--require-phase-c', String(thresholds.kktRequirePhaseC),
        '--max-matrixfree-fallback-rate', String(thresholds.kktMaxMatrixFreeFallbackRate),
        '--max-matrixfree-unknown-fallback-rate', String(thresholds.kktMaxMatrixFreeUnknownFallbackRate),
        '--rounds', String(kktRounds),
        '--n', String(kktN),
        '--meq', String(kktMeq),
        '--mineq', String(kktMineq),
        '--maxIter', String(kktMaxIter)
      ], null, { ...runnerOptions, label: 'kkt', idleTimeoutMs: 0 });

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

    if (shouldRunStep('phasec') && enablePhaseC && phaseCInput) {
      const phaseCAnalysisRel = path.join('diagnostics/results', `phase-c-analysis-release-gate-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await runNode('diagnostics/phase-c-analyze.mjs', [
        '--input', phaseCInput,
        '--out', phaseCAnalysisRel,
        '--require', 'true',
        '--min-elapsed-speedup', String(thresholds.phaseCMinElapsedSpeedup),
        '--min-ok-rate-delta-pct', String(thresholds.phaseCMinOkRateDeltaPct),
        '--max-matrixfree-fallback-rate', String(thresholds.phaseCMaxMatrixFreeFallbackRate),
        '--max-matrixfree-unknown-fallback-rate', String(thresholds.phaseCMaxMatrixFreeUnknownFallbackRate)
      ], null, { ...runnerOptions, label: 'phasec', idleTimeoutMs: 0 });

      const phaseCResult = path.resolve(projectRoot, phaseCInput);
      const phaseCAnalysis = path.resolve(projectRoot, phaseCAnalysisRel);
      summary.steps.phasec = {
        passed: true,
        skipped: false,
        result: path.relative(projectRoot, phaseCResult),
        analysis: path.relative(projectRoot, phaseCAnalysis)
      };
    } else {
      summary.steps.phasec = { ...summary.steps.phasec, skipped: true };
    }
    await persistSummary(summary);

    summary.passed = ['perfquick', 'raytrace', 'opdparity', 'nativeoperands', 'opd', 'ta', 'kkt', 'phasec'].every((step) => {
      const s = summary.steps[step];
      return s.skipped || s.passed;
    });
  } catch (e) {
    const msg = String((e && e.message) ? e.message : e || 'release gate failed');
    summary.error = msg;
    if (msg.includes('perf-quick-auto')) summary.failedStep = 'perfquick';
    else if (msg.includes('raytrace-golden-auto')) summary.failedStep = 'raytrace';
    else if (msg.includes('opd-js-rust-parity')) summary.failedStep = 'opdparity';
    else if (msg.includes('native-operands-auto')) summary.failedStep = 'nativeoperands';
    else if (msg.includes('opd-full-batch-benchmark') || msg.includes('opd-full-batch-analyze') || msg.includes('opd-full-batch-auto')) summary.failedStep = 'opd';
    else if (msg.includes('ta-rms-lightweight-mode-auto') || msg.includes('ta-rms-lightweight-mode-analyze') || msg.includes('ta-rms-micro-benchmark')) summary.failedStep = 'ta';
    else if (msg.includes('kkt-e2e-auto')) summary.failedStep = 'kkt';
    else if (msg.includes('phase-c-analyze')) summary.failedStep = 'phasec';
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
      const rayGoldenFixed = (rayGolden && /-aperture\.json$/i.test(rayGolden))
        ? await listLatest(/^raytrace-golden-.*\.json$/i, /(^raytrace-golden-analysis-.*\.json$)|(-aperture\.json$)/i)
        : rayGolden;
      const rayAnalysis = await listLatest(/^raytrace-golden-analysis-.*\.json$/i);
      if (rayGoldenFixed || rayAnalysis) {
        summary.steps.raytrace = {
          passed: false,
          skipped: false,
          golden: rayGoldenFixed ? path.relative(projectRoot, rayGoldenFixed) : null,
          analysis: rayAnalysis ? path.relative(projectRoot, rayAnalysis) : null
        };
      }
    }

    if (shouldRunStep('opdparity')) {
      const parity = await listLatest(/^opd-js-rust-parity-.*\.json$/i);
      if (parity) {
        summary.steps.opdparity = {
          passed: false,
          skipped: false,
          result: path.relative(projectRoot, parity)
        };
      }
    }

    if (shouldRunStep('nativeoperands')) {
      const nativeOperand = await listLatest(/^native-operands-auto-.*\.json$/i);
      if (nativeOperand) {
        summary.steps.nativeoperands = {
          passed: false,
          skipped: false,
          result: path.relative(projectRoot, nativeOperand)
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

    if (shouldRunStep('phasec')) {
      const phaseCAnalysis = await listLatest(/^phase-c-analysis-.*\.json$/i);
      const phaseCResult = phaseCInput ? path.resolve(projectRoot, phaseCInput) : null;
      if (phaseCResult || phaseCAnalysis) {
        summary.steps.phasec = {
          passed: false,
          skipped: false,
          result: phaseCResult ? path.relative(projectRoot, phaseCResult) : null,
          analysis: phaseCAnalysis ? path.relative(projectRoot, phaseCAnalysis) : null
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
