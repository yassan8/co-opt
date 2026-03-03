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

const toBool = (v, fallback = false) => {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

const runNode = (scriptRel, args = []) => {
  const scriptAbs = path.resolve(projectRoot, scriptRel);
  const r = spawnSync(process.execPath, ['--import', 'tsx', scriptAbs, ...args], {
    cwd: projectRoot,
    stdio: 'inherit'
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
};

const listLatest = async (pattern) => {
  const names = await fs.readdir(resultsDir);
  const candidates = names.filter((n) => pattern.test(n));
  if (!candidates.length) return null;
  const withStat = await Promise.all(candidates.map(async (name) => {
    const full = path.resolve(resultsDir, name);
    const st = await fs.stat(full);
    return { full, mtimeMs: st.mtimeMs, name };
  }));
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return withStat[0].full;
};

const cleanupArtifacts = async (keepResult, keepAnalysis) => {
  const names = await fs.readdir(resultsDir);
  const files = names.map((n) => path.resolve(resultsDir, n));

  const isResult = (base) => /^opd-full-batch-.*\.json$/i.test(base) && !/^opd-full-batch-analysis-.*\.json$/i.test(base);
  const isAnalysis = (base) => /^opd-full-batch-analysis-.*\.json$/i.test(base);

  await Promise.all(files.map(async (p) => {
    const base = path.basename(p);
    if (isResult(base) && p !== keepResult) {
      await fs.unlink(p).catch(() => {});
      return;
    }
    if (isAnalysis(base) && p !== keepAnalysis) {
      await fs.unlink(p).catch(() => {});
    }
  }));
};

const run = async () => {
  const cleanup = toBool(getArg('cleanup', 'true'), true);

  const benchmarkArgs = [];
  const passToBenchmark = ['out'];
  for (const key of passToBenchmark) {
    const v = getArg(key, null);
    if (v !== null) benchmarkArgs.push(`--${key}`, String(v));
  }

  runNode('diagnostics/opd-full-batch-benchmark.mjs', benchmarkArgs);

  const latestResult = await listLatest(/^opd-full-batch-.*\.json$/i);
  if (!latestResult) {
    throw new Error('opd full-batch result not found after benchmark');
  }

  const analyzeArgs = ['--input', path.relative(projectRoot, latestResult), '--require', 'true'];
  const passToAnalyze = ['min-speedup', 'max-valid-diff', 'out'];
  for (const key of passToAnalyze) {
    const v = getArg(key, null);
    if (v !== null) analyzeArgs.push(`--${key}`, String(v));
  }

  runNode('diagnostics/opd-full-batch-analyze.mjs', analyzeArgs);

  const latestAnalysis = await listLatest(/^opd-full-batch-analysis-.*\.json$/i);
  if (!latestAnalysis) {
    throw new Error('opd full-batch analysis not found after analyze');
  }

  if (cleanup) {
    await cleanupArtifacts(latestResult, latestAnalysis);
  }

  console.log('✅ OPD full-batch auto pipeline complete');
  console.log(JSON.stringify({
    result: path.relative(projectRoot, latestResult),
    analysis: path.relative(projectRoot, latestAnalysis),
    cleanup
  }, null, 2));
};

await run();
