import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { calculateTransverseAberration } from '../evaluation/aberrations/transverse-aberration.ts';

function getArg(name, fallback) {
  const key = `--${name}`;
  const index = process.argv.indexOf(key);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function getArgString(name, fallback = '') {
  const key = `--${name}`;
  const index = process.argv.indexOf(key);
  if (index < 0 || index + 1 >= process.argv.length) return fallback;
  const value = String(process.argv[index + 1] ?? '').trim();
  return value.length > 0 ? value : fallback;
}

function parseRayCountsArg(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((token) => Number(token.trim()))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.max(3, Math.floor(v)))
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

function median(values) {
  const nums = Array.isArray(values)
    ? values.map((v) => Number(v)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
    : [];
  if (nums.length === 0) return NaN;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return 0.5 * (nums[mid - 1] + nums[mid]);
}

const cfg = JSON.parse(fs.readFileSync(new URL('../defaults/default-load.json', import.meta.url), 'utf8'));
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

const loops = Math.max(1, Math.floor(getArg('loops', 30)));
const rayCount = Math.max(3, Math.floor(getArg('rayCount', 51)));
const repeat = Math.max(1, Math.floor(getArg('repeat', 3)));
const rayCounts = parseRayCountsArg(getArgString('rayCounts', ''));
const wavelength = 0.5876;

const run = (lightweight, currentRayCount) => {
  for (let i = 0; i < 5; i++) {
    calculateTransverseAberration(optical, targetSurfaceIndex, [field], wavelength, currentRayCount, lightweight ? { lightweight: true } : null);
  }

  const t0 = performance.now();
  let points = 0;
  for (let i = 0; i < loops; i++) {
    const out = calculateTransverseAberration(optical, targetSurfaceIndex, [field], wavelength, currentRayCount, lightweight ? { lightweight: true } : null);
    points += Number(out?.meridionalData?.[0]?.points?.length || 0);
    points += Number(out?.sagittalData?.[0]?.points?.length || 0);
  }
  const ms = performance.now() - t0;
  return { ms, perCall: ms / loops, pointsAvg: points / loops };
};

const base = run(false, rayCount);
const lite = run(true, rayCount);
const speedup = base.perCall / Math.max(1e-9, lite.perCall);

if (rayCounts.length === 0) {
  const result = {
    timestamp: new Date().toISOString(),
    loops,
    repeat,
    rayCount,
    targetSurfaceIndex,
    base,
    lightweight: lite,
    speedup
  };

  console.log(JSON.stringify(result, null, 2));
} else {
  const sweep = [];
  for (const rc of rayCounts) {
    const runs = [];
    for (let k = 0; k < repeat; k++) {
      const b = run(false, rc);
      const l = run(true, rc);
      runs.push({
        basePerCall: b.perCall,
        lightweightPerCall: l.perCall,
        speedup: b.perCall / Math.max(1e-9, l.perCall),
        baseMs: b.ms,
        lightweightMs: l.ms,
        basePointsAvg: b.pointsAvg,
        lightweightPointsAvg: l.pointsAvg
      });
    }
    const medBasePerCall = median(runs.map((r) => r.basePerCall));
    const medLitePerCall = median(runs.map((r) => r.lightweightPerCall));
    const medSpeedup = medBasePerCall / Math.max(1e-9, medLitePerCall);
    sweep.push({
      rayCount: rc,
      repeat,
      loops,
      medianBasePerCallMs: medBasePerCall,
      medianLightweightPerCallMs: medLitePerCall,
      medianSpeedup: medSpeedup,
      runs
    });
  }

  const summary = {
    timestamp: new Date().toISOString(),
    targetSurfaceIndex,
    loops,
    repeat,
    rayCounts,
    sweep,
    medianOfMedianSpeedup: median(sweep.map((s) => s.medianSpeedup))
  };
  console.log(JSON.stringify(summary, null, 2));
}
