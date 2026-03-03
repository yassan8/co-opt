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

const isGoldenBaseFile = (name) => {
  if (!/^raytrace-golden-.*\.json$/i.test(name)) return false;
  if (/^raytrace-golden-analysis-.*\.json$/i.test(name)) return false;
  if (/^raytrace-golden-.*-aperture\.json$/i.test(name)) return false;
  return true;
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

const cleanupArtifacts = async (keepGolden, keepAnalysis) => {
  const names = await fs.readdir(resultsDir);
  const files = names.map((n) => path.resolve(resultsDir, n));
  const shouldDelete = (p) => {
    const base = path.basename(p);
    const isAnalysis = /^raytrace-golden-analysis-.*\.json$/i.test(base);
    const isGolden = isGoldenBaseFile(base);
    if (isGolden) return p !== keepGolden;
    if (isAnalysis) return p !== keepAnalysis;
    return false;
  };

  await Promise.all(files.filter(shouldDelete).map(async (p) => {
    await fs.unlink(p).catch(() => {});
  }));
};

const run = async () => {
  const cleanup = toBool(getArg('cleanup', 'true'), true);

  const captureArgs = [];
  const analyzeArgs = ['--require', 'true'];

  const passThroughCapture = ['input', 'engine', 'rays', 'target', 'probe-surface', 'wavelength', 'forward-only', 'out'];
  for (const key of passThroughCapture) {
    const v = getArg(key, null);
    if (v !== null) captureArgs.push(`--${key}`, String(v));
  }

  const passThroughRequire = [
    'max-mismatch-rate',
    'max-success-mismatch-rate',
    'max-mean-opl-um',
    'max-opl-um'
  ];
  for (const key of passThroughRequire) {
    const v = getArg(key, null);
    if (v !== null) analyzeArgs.push(`--${key}`, String(v));
  }

  runNode('diagnostics/raytrace-golden-capture.mjs', captureArgs);

  const namesAfterCapture = await fs.readdir(resultsDir);
  const goldenCandidates = namesAfterCapture.filter(isGoldenBaseFile);
  const latestGolden = goldenCandidates.length
    ? (await Promise.all(goldenCandidates.map(async (name) => {
        const full = path.resolve(resultsDir, name);
        const st = await fs.stat(full);
        return { full, mtimeMs: st.mtimeMs, name };
      }))).sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0]?.full
    : null;
  if (!latestGolden) {
    throw new Error('golden result not found after capture');
  }

  analyzeArgs.push('--input', path.relative(projectRoot, latestGolden));
  runNode('diagnostics/raytrace-golden-analyze.mjs', analyzeArgs);

  const latestAnalysis = await listLatest(/^raytrace-golden-analysis-.*\.json$/i);
  if (!latestAnalysis) {
    throw new Error('analysis result not found after analyze');
  }

  if (cleanup) {
    await cleanupArtifacts(latestGolden, latestAnalysis);
  }

  console.log('✅ raytrace auto pipeline complete');
  console.log(JSON.stringify({
    golden: path.relative(projectRoot, latestGolden),
    analysis: path.relative(projectRoot, latestAnalysis),
    cleanup
  }, null, 2));
};

await run();
