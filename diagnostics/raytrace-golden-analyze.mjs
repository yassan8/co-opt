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

const num = (v, fallback = NaN) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const toBool = (v, fallback = false) => {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
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

const pickLatestGolden = async () => {
  const names = await fs.readdir(resultsDir);
  const candidates = names.filter((n) => {
    if (!/^raytrace-golden-.*\.json$/i.test(n)) return false;
    if (/^raytrace-golden-analysis-.*\.json$/i.test(n)) return false;
    if (/^raytrace-golden-.*-aperture\.json$/i.test(n)) return false;
    return true;
  });
  if (!candidates.length) return null;

  const withStat = await Promise.all(candidates.map(async (name) => {
    const full = path.resolve(resultsDir, name);
    const st = await fs.stat(full);
    return { name, full, mtimeMs: st.mtimeMs };
  }));

  withStat.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return withStat[0].full;
};

const radiusBin = (r) => {
  if (!Number.isFinite(r)) return 'invalid';
  if (r < 2) return '[0,2)';
  if (r < 5) return '[2,5)';
  if (r < 8) return '[5,8)';
  if (r < 12) return '[8,12)';
  return '[12,+)';
};

const run = async () => {
  const inputArg = getArg('input', null);
  const outputArg = getArg('out', null);
  const requireGate = toBool(getArg('require', 'false'), false);
  const oplEpsilonUm = num(getArg('opl-epsilon-um', '0.001'), 0.001);
  const thresholds = {
    maxMismatchRate: num(getArg('max-mismatch-rate', '0'), 0),
    maxSuccessMismatchRate: num(getArg('max-success-mismatch-rate', '0'), 0),
    maxMeanOplAbsDeltaUm: num(getArg('max-mean-opl-um', '0'), 0),
    maxOplAbsDeltaUm: num(getArg('max-opl-um', '0'), 0)
  };

  const inputPath = inputArg
    ? path.resolve(projectRoot, inputArg)
    : await pickLatestGolden();

  if (!inputPath || !(await exists(inputPath))) {
    throw new Error('No golden result JSON found. Run diag:raytrace-golden first or pass --input.');
  }

  const raw = JSON.parse(await fs.readFile(inputPath, 'utf8'));

  const rays = Array.isArray(raw?.rays) ? raw.rays : [];
  const jsOut = Array.isArray(raw?.outputs?.js) ? raw.outputs.js : [];
  const rustOut = Array.isArray(raw?.outputs?.rust) ? raw.outputs.rust : [];
  const n = Math.min(rays.length, jsOut.length, rustOut.length);

  if (n === 0) {
    throw new Error('No comparable rays found in golden result.');
  }

  const pairCounts = {};
  const radiusBins = {};
  const mismatchSamples = [];

  let mismatchCount = 0;
  let successMismatch = 0;
  let oplMismatchCount = 0;
  let oplAbsSum = 0;
  let oplAbsMax = 0;

  for (let i = 0; i < n; i++) {
    const ray = rays[i] || {};
    const j = jsOut[i] || {};
    const r = rustOut[i] || {};

    const jsStatus = String(j.status || 'unknown');
    const rustStatus = String(r.status || 'unknown');
    const pairKey = `${jsStatus} -> ${rustStatus}`;
    pairCounts[pairKey] = (pairCounts[pairKey] || 0) + 1;

    const px = num(ray?.pos?.x, NaN);
    const py = num(ray?.pos?.y, NaN);
    const pr = Math.hypot(px, py);
    const rb = radiusBin(pr);
    if (!radiusBins[rb]) {
      radiusBins[rb] = {
        count: 0,
        mismatch: 0,
        successMismatch: 0,
        jsOk: 0,
        rustOk: 0
      };
    }
    radiusBins[rb].count += 1;

    const jsSuccess = !!j.success;
    const rustSuccess = !!r.success;
    if (jsSuccess) radiusBins[rb].jsOk += 1;
    if (rustSuccess) radiusBins[rb].rustOk += 1;

    const isMismatch = jsStatus !== rustStatus;
    if (isMismatch) {
      mismatchCount += 1;
      radiusBins[rb].mismatch += 1;
    }

    if (jsSuccess !== rustSuccess) {
      successMismatch += 1;
      radiusBins[rb].successMismatch += 1;
    }

    const jo = num(j.oplMicrons, NaN);
    const ro = num(r.oplMicrons, NaN);
    if (Number.isFinite(jo) && Number.isFinite(ro)) {
      const rawDelta = Math.abs(jo - ro);
      const d = rawDelta <= oplEpsilonUm ? 0 : rawDelta;
      oplAbsMax = Math.max(oplAbsMax, d);
      oplAbsSum += d;
      oplMismatchCount += 1;
    }

    if (mismatchSamples.length < 12 && (isMismatch || jsSuccess !== rustSuccess)) {
      mismatchSamples.push({
        index: i,
        rayPos: { x: round(px, 4), y: round(py, 4) },
        radius: round(pr, 4),
        js: { status: jsStatus, success: jsSuccess, oplMicrons: round(jo, 6) },
        rust: { status: rustStatus, success: rustSuccess, oplMicrons: round(ro, 6) }
      });
    }
  }

  const pairRanking = Object.entries(pairCounts)
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count || a.pair.localeCompare(b.pair));

  const radiusRanking = Object.entries(radiusBins)
    .map(([bin, data]) => ({
      bin,
      ...data,
      mismatchRate: data.count > 0 ? data.mismatch / data.count : 0,
      successMismatchRate: data.count > 0 ? data.successMismatch / data.count : 0
    }))
    .sort((a, b) => a.bin.localeCompare(b.bin));

  const topEntries = (obj, labelKey, valueKey, limit = 10) => {
    const src = obj && typeof obj === 'object' ? obj : {};
    return Object.entries(src)
      .map(([k, v]) => ({ [labelKey]: k, [valueKey]: Number(v) || 0 }))
      .sort((a, b) => b[valueKey] - a[valueKey] || String(a[labelKey]).localeCompare(String(b[labelKey])))
      .slice(0, limit);
  };

  const jsDiag = raw?.diagnostics?.js?.summary || null;
  const rustDiag = raw?.diagnostics?.rust?.summary || null;

  const report = {
    timestamp: new Date().toISOString(),
    inputPath: path.relative(projectRoot, inputPath),
    normalization: {
      oplEpsilonUm
    },
    totals: {
      comparedRays: n,
      mismatchCount,
      mismatchRate: mismatchCount / n,
      successMismatch,
      successMismatchRate: successMismatch / n,
      oplCompared: oplMismatchCount,
      meanOplAbsDeltaUm: oplMismatchCount > 0 ? oplAbsSum / oplMismatchCount : NaN,
      maxOplAbsDeltaUm: oplAbsMax
    },
    statusPairs: pairRanking,
    failureDiagnostics: {
      js: jsDiag ? {
        capturedFailure: Number(jsDiag.capturedFailure) || 0,
        topKinds: topEntries(jsDiag.kinds, 'kind', 'count', 10),
        topSurfaces: topEntries(jsDiag.surfaces, 'surfaceIndex', 'count', 10)
      } : null,
      rust: rustDiag ? {
        capturedFailure: Number(rustDiag.capturedFailure) || 0,
        topKinds: topEntries(rustDiag.kinds, 'kind', 'count', 10),
        topSurfaces: topEntries(rustDiag.surfaces, 'surfaceIndex', 'count', 10)
      } : null
    },
    radiusBins: radiusRanking,
    mismatchSamples,
    note: (jsDiag || rustDiag)
      ? 'Includes failure kind/surface aggregates from diagnostics captured via traceRayHitPoint.'
      : 'This report does not include failing surface index. Current golden artifact stores only per-ray final status/hit/opl.'
  };

  if (requireGate) {
    const checks = [
      {
        name: 'mismatchRate',
        actual: Number(report.totals.mismatchRate),
        limit: thresholds.maxMismatchRate
      },
      {
        name: 'successMismatchRate',
        actual: Number(report.totals.successMismatchRate),
        limit: thresholds.maxSuccessMismatchRate
      },
      {
        name: 'meanOplAbsDeltaUm',
        actual: Number(report.totals.meanOplAbsDeltaUm),
        limit: thresholds.maxMeanOplAbsDeltaUm
      },
      {
        name: 'maxOplAbsDeltaUm',
        actual: Number(report.totals.maxOplAbsDeltaUm),
        limit: thresholds.maxOplAbsDeltaUm
      }
    ].map((c) => ({
      ...c,
      pass: Number.isFinite(c.actual) && Number.isFinite(c.limit) && c.actual <= c.limit
    }));

    const failedChecks = checks.filter((c) => !c.pass);
    const passed = failedChecks.length === 0;
    report.requirementGate = {
      enabled: true,
      passed,
      thresholds,
      checks,
      failedChecks
    };
  }

  const outputPath = outputArg
    ? path.resolve(projectRoot, outputArg)
    : path.resolve(
      resultsDir,
      `raytrace-golden-analysis-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    );

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('✅ raytrace golden analysis complete');
  console.log(JSON.stringify({
    input: path.relative(projectRoot, inputPath),
    output: path.relative(projectRoot, outputPath),
    totals: report.totals,
    topStatusPairs: pairRanking.slice(0, 5),
    rustTopFailureSurfaces: report.failureDiagnostics?.rust?.topSurfaces?.slice(0, 5) || [],
    requirementGate: report.requirementGate || null
  }, null, 2));

  if (requireGate && report.requirementGate && !report.requirementGate.passed) {
    console.error('❌ requirement gate failed');
    process.exitCode = 2;
  }
};

await run();
