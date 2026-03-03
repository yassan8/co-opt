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

const toNum = (v, fallback = NaN) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const round = (v, digits = 6) => {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

const percentile = (sorted, p) => {
  if (!Array.isArray(sorted) || sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const t = rank - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
};

const pickLatestBoth = async () => {
  const names = await fs.readdir(resultsDir);
  const candidates = names.filter((n) => /^raytrace-both-.*\.json$/i.test(n));
  if (!candidates.length) return null;
  const withStat = await Promise.all(candidates.map(async (name) => {
    const full = path.resolve(resultsDir, name);
    const st = await fs.stat(full);
    return { full, mtimeMs: st.mtimeMs, name };
  }));
  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return withStat[0].full;
};

const main = async () => {
  const inputArg = getArg('input', 'diagnostics/results/raytrace-both-single-meta.json');
  const marginNearMm = toNum(getArg('near-mm', '0.05'), 0.05);
  const outputArg = getArg('out', null);

  const inputPath = inputArg
    ? path.resolve(projectRoot, inputArg)
    : await pickLatestBoth();

  if (!inputPath || !(await exists(inputPath))) {
    throw new Error('Input JSON not found. Pass --input diagnostics/results/raytrace-both-*.json');
  }

  const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));
  const jsPerRay = Array.isArray(raw?.diagnostics?.js?.perRay) ? raw.diagnostics.js.perRay : [];
  const rustSummary = raw?.diagnostics?.rust?.summary || null;

  const blocks = [];
  for (const row of jsPerRay) {
    const failure = row?.failure;
    if (!failure || String(failure?.kind) !== 'PHYSICAL_APERTURE_BLOCK') continue;
    const d = failure?.details || {};
    const hitRadius = toNum(d.hitRadiusMm, NaN);
    const apertureLimit = toNum(d.apertureLimitMm, NaN);
    const margin = (Number.isFinite(hitRadius) && Number.isFinite(apertureLimit))
      ? hitRadius - apertureLimit
      : NaN;

    blocks.push({
      index: toNum(row?.index, NaN),
      surfaceIndex: toNum(failure?.surfaceIndex, NaN),
      surfaceNumber: toNum(failure?.surfaceNumber, NaN),
      surfType: String(d.surfType || ''),
      hitRadiusMm: hitRadius,
      apertureLimitMm: apertureLimit,
      marginMm: margin,
      semidiaMm: toNum(d.semidia, NaN),
      thicknessMm: toNum(d.thickness, NaN),
      localHit: d?.hitPointLocalMm || null
    });
  }

  const bySurfaceMap = new Map();
  for (const b of blocks) {
    const key = Number.isFinite(b.surfaceIndex) ? String(b.surfaceIndex) : 'unknown';
    if (!bySurfaceMap.has(key)) {
      bySurfaceMap.set(key, {
        surfaceIndex: b.surfaceIndex,
        surfaceNumber: b.surfaceNumber,
        surfType: b.surfType,
        count: 0,
        margins: [],
        hitRadius: [],
        apertureLimit: []
      });
    }
    const bucket = bySurfaceMap.get(key);
    bucket.count += 1;
    if (Number.isFinite(b.marginMm)) bucket.margins.push(b.marginMm);
    if (Number.isFinite(b.hitRadiusMm)) bucket.hitRadius.push(b.hitRadiusMm);
    if (Number.isFinite(b.apertureLimitMm)) bucket.apertureLimit.push(b.apertureLimitMm);
  }

  const bySurface = Array.from(bySurfaceMap.values()).map((s) => {
    const margins = [...s.margins].sort((a, b) => a - b);
    const hit = [...s.hitRadius].sort((a, b) => a - b);
    const lim = [...s.apertureLimit].sort((a, b) => a - b);
    const marginMean = margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : NaN;
    return {
      surfaceIndex: s.surfaceIndex,
      surfaceNumber: s.surfaceNumber,
      surfType: s.surfType,
      count: s.count,
      marginMm: {
        min: round(margins[0], 9),
        p50: round(percentile(margins, 0.5), 9),
        p90: round(percentile(margins, 0.9), 9),
        max: round(margins[margins.length - 1], 9),
        mean: round(marginMean, 9)
      },
      hitRadiusMm: {
        min: round(hit[0], 9),
        max: round(hit[hit.length - 1], 9)
      },
      apertureLimitMm: {
        min: round(lim[0], 9),
        max: round(lim[lim.length - 1], 9)
      }
    };
  }).sort((a, b) => b.count - a.count || a.surfaceIndex - b.surfaceIndex);

  const nearEdge = blocks
    .filter((b) => Number.isFinite(b.marginMm) && b.marginMm >= 0 && b.marginMm <= marginNearMm)
    .sort((a, b) => a.marginMm - b.marginMm)
    .slice(0, 30)
    .map((b) => ({
      index: b.index,
      surfaceIndex: b.surfaceIndex,
      surfaceNumber: b.surfaceNumber,
      marginMm: round(b.marginMm, 9),
      hitRadiusMm: round(b.hitRadiusMm, 9),
      apertureLimitMm: round(b.apertureLimitMm, 9),
      localHit: b.localHit
    }));

  const out = {
    timestamp: new Date().toISOString(),
    inputPath: path.relative(projectRoot, inputPath),
    settings: {
      marginNearMm
    },
    totals: {
      apertureBlockCount: blocks.length,
      distinctSurfaces: bySurface.length
    },
    bySurface,
    nearEdge,
    crossChecks: {
      rustSingleHitMetaStatus: rustSummary?.rustSingleHitMetaStatus || {},
      rustCapturedFailure: toNum(rustSummary?.capturedFailure, 0)
    }
  };

  const defaultOut = `diagnostics/results/aperture-threshold-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outputPath = path.resolve(projectRoot, outputArg || defaultOut);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

  console.log('✅ aperture threshold analysis complete');
  console.log(JSON.stringify({
    output: path.relative(projectRoot, outputPath),
    totals: out.totals,
    bySurface: out.bySurface,
    nearEdgeCount: out.nearEdge.length,
    rustSingleHitMetaStatus: out.crossChecks.rustSingleHitMetaStatus
  }, null, 2));
};

await main();
