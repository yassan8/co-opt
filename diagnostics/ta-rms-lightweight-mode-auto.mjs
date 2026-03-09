import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { calculateTransverseAberration } from '../evaluation/aberrations/transverse-aberration.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const rawArgs = process.argv.slice(2);

const getArg = (name, fallback = null) => {
  const key = `--${name}`;
  const idx = rawArgs.indexOf(key);
  if (idx < 0) return fallback;
  const val = rawArgs[idx + 1];
  if (val === undefined || String(val).startsWith('--')) return 'true';
  return val;
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

const parseRayCounts = (raw) => {
  return String(raw || '')
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.max(3, Math.floor(v)))
    .filter((v, i, arr) => arr.indexOf(v) === i);
};

const median = (values) => {
  const nums = Array.isArray(values)
    ? values.map((v) => Number(v)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
    : [];
  if (nums.length === 0) return NaN;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : 0.5 * (nums[mid - 1] + nums[mid]);
};

const run = async () => {
  const rayCounts = parseRayCounts(toStrArg('rayCounts', '21,31,51,81,101,151'));
  const loops = Math.max(1, Math.floor(toNumArg('loops', 20)));
  const repeat = Math.max(1, Math.floor(toNumArg('repeat', 11)));
  const minMedianOfMedianSpeedup = toNumArg('min-median-of-median-speedup', 0.99);
  const minPerRaycountSpeedup = toNumArg('min-per-raycount-speedup', 0.97);
  const requireGate = toBoolArg('require', true);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outRel = toStrArg('out', path.join('diagnostics/results', `ta-rms-lightweight-vs-statsonly-${stamp}.json`));
  const analysisRel = toStrArg('analysis-out', path.join('diagnostics/results', `ta-rms-lightweight-vs-statsonly-analysis-${stamp}.json`));
  const outAbs = path.resolve(projectRoot, outRel);
  const analysisAbs = path.resolve(projectRoot, analysisRel);

  const cfgText = await fs.readFile(path.resolve(projectRoot, 'defaults/default-load.json'), 'utf8');
  const cfg = JSON.parse(cfgText);
  const optical = cfg.opticalSystem;
  const objects = cfg.object;
  const obj = objects.find((row) => Number(row?.id) === 2) || objects[0];

  const imageIdx = optical.findIndex((row) => String(row?.['object type'] ?? row?.object ?? '').toLowerCase() === 'image');
  const targetSurfaceIndex = imageIdx >= 0 ? imageIdx : Math.max(0, optical.length - 1);

  const isInf = (() => {
    const t = optical?.[0]?.thickness;
    if (t === Infinity) return true;
    const s = String(t ?? '').trim().toUpperCase();
    return s === 'INF' || s === 'INFINITY';
  })();

  const fieldX = Number(obj?.xHeightAngle ?? obj?.xFieldAngle ?? obj?.xHeight ?? obj?.x ?? 0) || 0;
  const fieldY = Number(obj?.yHeightAngle ?? obj?.yFieldAngle ?? obj?.fieldAngle ?? obj?.yHeight ?? obj?.y ?? 0) || 0;

  const field = isInf
    ? { position: 'Angle', objectIndex: Number(obj?.id ?? 1), displayName: 'bench', xFieldAngle: fieldX, yFieldAngle: fieldY, x: fieldX, y: fieldY }
    : { position: 'Rectangle', objectIndex: Number(obj?.id ?? 1), displayName: 'bench', xHeight: fieldX, yHeight: fieldY, x: fieldX, y: fieldY };

  const wavelength = 0.5876;

  const runBench = (lightweight, rayCount) => {
    for (let i = 0; i < 5; i++) {
      calculateTransverseAberration(optical, targetSurfaceIndex, [field], wavelength, rayCount, lightweight ? { lightweight: true } : null);
    }

    const t0 = performance.now();
    let points = 0;
    for (let i = 0; i < loops; i++) {
      const out = calculateTransverseAberration(optical, targetSurfaceIndex, [field], wavelength, rayCount, lightweight ? { lightweight: true } : null);
      points += Number(out?.meridionalData?.[0]?.points?.length || 0);
      points += Number(out?.sagittalData?.[0]?.points?.length || 0);
    }
    const ms = performance.now() - t0;
    return { ms, perCall: ms / loops, pointsAvg: points / loops };
  };

  const sweep = [];
  for (const rc of rayCounts) {
    const runs = [];
    for (let k = 0; k < repeat; k++) {
      const base = runBench(false, rc);
      const lightweight = runBench(true, rc);
      runs.push({
        basePerCall: base.perCall,
        lightweightPerCall: lightweight.perCall,
        speedup: base.perCall / Math.max(1e-9, lightweight.perCall),
        baseMs: base.ms,
        lightweightMs: lightweight.ms,
        basePointsAvg: base.pointsAvg,
        lightweightPointsAvg: lightweight.pointsAvg
      });
    }

    const medianBasePerCallMs = median(runs.map((r) => r.basePerCall));
    const medianLightweightPerCallMs = median(runs.map((r) => r.lightweightPerCall));
    const medianSpeedup = medianBasePerCallMs / Math.max(1e-9, medianLightweightPerCallMs);

    sweep.push({
      rayCount: rc,
      repeat,
      loops,
      medianBasePerCallMs,
      medianLightweightPerCallMs,
      medianSpeedup,
      runs
    });
  }

  const result = {
    timestamp: new Date().toISOString(),
    targetSurfaceIndex,
    loops,
    repeat,
    rayCounts,
    sweep,
    medianOfMedianSpeedup: median(sweep.map((s) => s.medianSpeedup))
  };

  const failedChecks = [];
  if (!(Number(result.medianOfMedianSpeedup) >= Number(minMedianOfMedianSpeedup))) {
    failedChecks.push({
      name: 'medianOfMedianSpeedup',
      actual: Number(result.medianOfMedianSpeedup),
      limit: Number(minMedianOfMedianSpeedup),
      pass: false
    });
  }

  const perRayFailed = sweep
    .filter((s) => !(Number(s.medianSpeedup) >= Number(minPerRaycountSpeedup)))
    .map((s) => ({ rayCount: s.rayCount, medianSpeedup: Number(s.medianSpeedup) }));

  if (perRayFailed.length > 0) {
    failedChecks.push({
      name: 'perRaycountSpeedup',
      actual: perRayFailed,
      limit: Number(minPerRaycountSpeedup),
      pass: false
    });
  }

  const analysis = {
    timestamp: new Date().toISOString(),
    input: path.relative(projectRoot, outAbs),
    output: path.relative(projectRoot, analysisAbs),
    metrics: {
      medianOfMedianSpeedup: Number(result.medianOfMedianSpeedup),
      rayCountMedians: sweep.map((s) => ({ rayCount: s.rayCount, medianSpeedup: Number(s.medianSpeedup) }))
    },
    requirementGate: {
      enabled: requireGate,
      thresholds: {
        minMedianOfMedianSpeedup,
        minPerRaycountSpeedup
      },
      failedChecks,
      passed: failedChecks.length === 0
    }
  };

  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.writeFile(outAbs, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await fs.mkdir(path.dirname(analysisAbs), { recursive: true });
  await fs.writeFile(analysisAbs, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');

  console.log('✅ TA lightweight benchmark complete');
  console.log(JSON.stringify({
    result: path.relative(projectRoot, outAbs),
    analysis: path.relative(projectRoot, analysisAbs),
    requirementGate: analysis.requirementGate
  }, null, 2));

  if (requireGate && !analysis.requirementGate.passed) {
    process.exitCode = 2;
  }
};

await run();
