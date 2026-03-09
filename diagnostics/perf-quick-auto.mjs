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

const toBool = (v, fallback = false) => {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

const toNumber = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const runNode = async (scriptRel, args = [], envPatch = {}, options = {}) => {
  const scriptAbs = path.resolve(projectRoot, scriptRel);
  const timeoutMs = Math.max(0, Number(options?.timeoutMs) || 0);
  const idleTimeoutMs = Math.max(0, Number(options?.idleTimeoutMs) || 0);
  const heartbeatMs = Math.max(1000, Number(options?.heartbeatMs) || 30000);
  const label = String(options?.label || scriptRel);
  const successMarker = options?.successMarker ? String(options.successMarker) : '';
  const successOnMarkerIdle = options?.successOnMarkerIdle === true;

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', scriptAbs, ...args], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...envPatch }
    });

    const startedAt = Date.now();
    let lastOutputAt = Date.now();
    let markerSeen = false;
    let settled = false;
    const finish = (err = null) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (err) reject(err);
      else resolve(undefined);
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

    child.on('error', (e) => finish(e));

    child.on('close', (code, signal) => {
      if (signal) {
        finish(new Error(`${scriptRel} failed with signal ${String(signal)}`));
        return;
      }
      if (code !== 0) {
        finish(new Error(`${scriptRel} failed with code ${code ?? 1}`));
        return;
      }
      finish(null);
    });

    const heartbeatTimer = setInterval(() => {
      const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      console.log(`⏱️ [perf-quick] ${label} running... ${elapsedSec}s elapsed`);

      if (idleTimeoutMs > 0) {
        const idleMs = Date.now() - lastOutputAt;
        if (idleMs >= idleTimeoutMs) {
          try { child.kill('SIGTERM'); } catch (_) {}
          if (successOnMarkerIdle && markerSeen) {
            console.warn(`⚠️ [perf-quick] ${label} idle timeout (${idleTimeoutMs}ms) after success marker; treating as completed`);
            finish(null);
          } else {
            finish(new Error(`${scriptRel} idle timed out after ${idleTimeoutMs}ms with no output`));
          }
        }
      }
    }, heartbeatMs);

    let timeoutTimer = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch (_) {}
        finish(new Error(`${scriptRel} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
};

const readJson = async (absPath) => {
  const text = await fs.readFile(absPath, 'utf8');
  return JSON.parse(text);
};

const run = async () => {
  await fs.mkdir(resultsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const opdOutRel = getArg('opd-out', `diagnostics/results/opd-full-batch-quick-${stamp}.json`);
  const rayOutRel = getArg('ray-out', `diagnostics/results/raytrace-golden-quick-${stamp}.json`);
  const opdOutAbs = path.resolve(projectRoot, opdOutRel);
  const rayOutAbs = path.resolve(projectRoot, rayOutRel);

  const opdGrid = String(getArg('opd-grid-size', process.env.OPD_GRID_SIZE ?? '64'));
  const opdFieldX = String(getArg('opd-field-x', process.env.OPD_FIELD_X ?? '10'));
  const opdRuns = String(getArg('opd-runs', process.env.OPD_RUNS ?? '3'));
  const rayCount = String(getArg('ray-rays', process.env.RAY_RAYS ?? '25'));

  const minOpdSpeedup = toNumber(getArg('min-opd-speedup', '1.0'), 1.0);
  const maxRayStatusMismatch = toNumber(getArg('max-ray-status-mismatch', '0'), 0);
  const maxRaySuccessMismatch = toNumber(getArg('max-ray-success-mismatch', '0'), 0);
  const maxRayMaxOplUm = toNumber(getArg('max-ray-max-opl-um', '0'), 0);
  const requirePass = toBool(getArg('require', 'false'), false);

  await runNode('diagnostics/opd-full-batch-benchmark.mjs', ['--out', opdOutRel], {
    OPD_GRID_SIZE: opdGrid,
    OPD_FIELD_X: opdFieldX,
    OPD_RUNS: opdRuns
  }, {
    label: 'opd-benchmark',
    heartbeatMs: 5000,
    timeoutMs: 300000,
    idleTimeoutMs: 20000,
    successMarker: '✅ OPD full-batch A/B benchmark summary',
    successOnMarkerIdle: true
  });

  await runNode('diagnostics/raytrace-golden-capture.mjs', ['--engine', 'both', '--rays', rayCount, '--out', rayOutRel], {}, {
    label: 'raytrace-capture',
    heartbeatMs: 5000,
    timeoutMs: 300000,
    idleTimeoutMs: 0
  });

  const opd = await readJson(opdOutAbs);
  const ray = await readJson(rayOutAbs);

  const opdSpeedup = Number(opd?.speedup);
  const rayStatusMismatch = Number(ray?.comparison?.statusMismatch ?? NaN);
  const raySuccessMismatch = Number(ray?.comparison?.successMismatch ?? NaN);
  const rayMaxOplUm = Number(ray?.comparison?.maxOplDeltaUm ?? NaN);

  const checks = {
    opdSpeedup: Number.isFinite(opdSpeedup) && opdSpeedup >= minOpdSpeedup,
    rayStatusMismatch: Number.isFinite(rayStatusMismatch) && rayStatusMismatch <= maxRayStatusMismatch,
    raySuccessMismatch: Number.isFinite(raySuccessMismatch) && raySuccessMismatch <= maxRaySuccessMismatch,
    rayMaxOplUm: Number.isFinite(rayMaxOplUm) && rayMaxOplUm <= maxRayMaxOplUm
  };

  const passed = Object.values(checks).every(Boolean);

  const summary = {
    timestamp: new Date().toISOString(),
    settings: {
      opdGrid,
      opdFieldX,
      opdRuns,
      rayCount,
      requirePass,
      minOpdSpeedup,
      maxRayStatusMismatch,
      maxRaySuccessMismatch,
      maxRayMaxOplUm
    },
    metrics: {
      opdSpeedup,
      rayStatusMismatch,
      raySuccessMismatch,
      rayMaxOplUm
    },
    checks,
    passed,
    outputs: {
      opd: opdOutRel,
      raytrace: rayOutRel,
      aperture: `${rayOutRel.replace(/\.json$/i, '')}-aperture.json`
    }
  };

  console.log('✅ perf quick auto summary');
  console.log(JSON.stringify(summary, null, 2));

  if (requirePass && !passed) {
    process.exit(2);
  }
};

await run();
