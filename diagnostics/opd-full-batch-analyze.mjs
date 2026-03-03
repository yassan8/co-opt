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
  const candidates = names.filter((n) => /^opd-full-batch-.*\.json$/i.test(n) && !/^opd-full-batch-analysis-.*\.json$/i.test(n));
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
    throw new Error('No OPD full-batch result JSON found. Run diag:opd-full-batch first or pass --input.');
  }

  const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));

  const offAvg = toNum(raw?.off?.avgMs, NaN);
  const onAvg = toNum(raw?.on?.avgMs, NaN);
  const speedup = Number.isFinite(offAvg) && Number.isFinite(onAvg) && onAvg > 0 ? offAvg / onAvg : NaN;
  const speedupPercent = Number.isFinite(speedup) ? (speedup - 1) * 100 : NaN;
  const validOff = toNum(raw?.off?.validAvg, NaN);
  const validOn = toNum(raw?.on?.validAvg, NaN);
  const validDiff = Number.isFinite(validOff) && Number.isFinite(validOn) ? Math.abs(validOff - validOn) : NaN;

  const report = {
    timestamp: new Date().toISOString(),
    inputPath: path.relative(projectRoot, inputPath),
    metrics: {
      offAvgMs: offAvg,
      onAvgMs: onAvg,
      speedup,
      speedupPercent,
      validOff,
      validOn,
      validDiff
    }
  };

  if (requireGate) {
    const thresholds = {
      minSpeedup: toNum(getArg('min-speedup', '1.0'), 1.0),
      maxValidDiff: toNum(getArg('max-valid-diff', '0'), 0)
    };

    const checks = [
      {
        name: 'speedup',
        actual: speedup,
        limit: thresholds.minSpeedup,
        pass: Number.isFinite(speedup) && speedup >= thresholds.minSpeedup
      },
      {
        name: 'validDiff',
        actual: validDiff,
        limit: thresholds.maxValidDiff,
        pass: Number.isFinite(validDiff) && validDiff <= thresholds.maxValidDiff
      }
    ];
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
    : path.resolve(resultsDir, `opd-full-batch-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('✅ OPD full-batch analysis complete');
  console.log(JSON.stringify({
    input: path.relative(projectRoot, inputPath),
    output: path.relative(projectRoot, outputPath),
    metrics: report.metrics,
    requirementGate: report.requirementGate || null
  }, null, 2));

  if (requireGate && report.requirementGate && !report.requirementGate.passed) {
    console.error('❌ OPD full-batch requirement gate failed');
    process.exitCode = 2;
  }
};

await run();
