if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => { store.clear(); }
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const key = `--${name}`;
  const idx = args.indexOf(key);
  if (idx < 0) return fallback;
  const val = args[idx + 1];
  if (val === undefined || String(val).startsWith('--')) return 'true';
  return val;
};

const toNum = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const parseFieldList = (raw) => {
  const text = String(raw ?? '0,5,10,15').trim();
  const out = text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((v) => Number.isFinite(v));
  return out.length > 0 ? out : [0, 5, 10, 15];
};

const summarizeFinite = (arr) => {
  const vals = Array.isArray(arr) ? arr.filter((v) => Number.isFinite(v)) : [];
  if (!vals.length) {
    return { count: 0, max: null, mean: null, rms: null };
  }
  let sum = 0;
  let sumSq = 0;
  let max = 0;
  for (const v of vals) {
    const a = Math.abs(v);
    sum += a;
    sumSq += a * a;
    if (a > max) max = a;
  }
  return {
    count: vals.length,
    max,
    mean: sum / vals.length,
    rms: Math.sqrt(sumSq / vals.length)
  };
};

const compareMaps = (jsMap, rustMap, wavelengthUm, topK = 10) => {
  const buildCellMap = (map) => {
    const out = new Map();
    const coords = Array.isArray(map?.pupilCoordinates) ? map.pupilCoordinates : [];
    const opds = Array.isArray(map?.opds) ? map.opds : [];
    const n = Math.min(coords.length, opds.length);
    for (let i = 0; i < n; i++) {
      const c = coords[i] || {};
      if (!Number.isInteger(c.ix) || !Number.isInteger(c.iy)) continue;
      const key = `${c.ix}:${c.iy}`;
      out.set(key, {
        ix: c.ix,
        iy: c.iy,
        x: Number(c.x),
        y: Number(c.y),
        opdUm: Number(opds[i])
      });
    }
    return out;
  };

  const jsCells = buildCellMap(jsMap);
  const rustCells = buildCellMap(rustMap);

  let bothFinite = 0;
  let jsOnlyFinite = 0;
  let rustOnlyFinite = 0;
  const absDiffUm = [];
  const top = [];

  const allKeys = new Set([...jsCells.keys(), ...rustCells.keys()]);
  for (const key of allKeys) {
    const a = jsCells.get(key);
    const b = rustCells.get(key);
    const av = Number(a?.opdUm);
    const bv = Number(b?.opdUm);
    const af = Number.isFinite(av);
    const bf = Number.isFinite(bv);

    if (af && bf) {
      bothFinite += 1;
      const d = Math.abs(av - bv);
      absDiffUm.push(d);
      top.push({ key, ix: a.ix, iy: a.iy, x: a.x, y: a.y, jsOpdUm: av, rustOpdUm: bv, absDiffUm: d });
    } else if (af && !bf) {
      jsOnlyFinite += 1;
    } else if (!af && bf) {
      rustOnlyFinite += 1;
    }
  }

  top.sort((l, r) => r.absDiffUm - l.absDiffUm);
  const topDiffs = top.slice(0, Math.max(1, Math.floor(topK)));

  const um = summarizeFinite(absDiffUm);
  const waves = summarizeFinite(absDiffUm.map((v) => v / wavelengthUm));

  return {
    overlap: {
      bothFinite,
      jsOnlyFinite,
      rustOnlyFinite,
      totalComparedCells: allKeys.size
    },
    delta: {
      opdUm: um,
      opdWaves: waves
    },
    aggregateRaw: {
      comparedCount: absDiffUm.length,
      sumAbsUm: absDiffUm.reduce((s, v) => s + Math.abs(v), 0),
      sumSqUm: absDiffUm.reduce((s, v) => s + (v * v), 0),
      maxAbsUm: um.max
    },
    topDiffs
  };
};

const outputPath = path.resolve(
  projectRoot,
  getArg('out', `diagnostics/results/opd-js-rust-parity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
);
const gridSize = Math.max(17, Math.floor(toNum(getArg('grid', '65'), 65)));
const wavelength = toNum(getArg('wavelength', '0.5876'), 0.5876);
const forceFinite = String(getArg('force-finite', '1')).trim().toLowerCase() !== '0';
const fields = parseFieldList(getArg('fields', '0,5,10,15'));
const topK = Math.max(1, Math.floor(toNum(getArg('topk', '10'), 10)));
const failMaxWaves = toNum(getArg('fail-max-diff-waves', ''), NaN);
const failRmsWaves = toNum(getArg('fail-rms-diff-waves', ''), NaN);
const failMeanWaves = toNum(getArg('fail-mean-diff-waves', ''), NaN);

const { createOPDCalculator, createWavefrontAnalyzer } = await import('../evaluation/wavefront/wavefront.ts');
const { getOpticalSystemRows } = await import('../utils/data-utils.ts');

const opticalSystemRows = getOpticalSystemRows();
const calc = createOPDCalculator(opticalSystemRows, wavelength);
const analyzer = createWavefrontAnalyzer(calc);

const runOne = async (fieldAngleX, forceRustWasm) => {
  const fieldSetting = { fieldAngle: { x: fieldAngleX, y: 0 }, forceFinite };
  const map = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', {
    opdMode: 'referenceSphere',
    opdDisplayMode: 'pistonTiltRemoved',
    skipZernikeFit: true,
    renderFromZernike: false,
    recordRays: false,
    progressEvery: 0,
    forceRustWasm,
    traceOptions: forceRustWasm
      ? { useRustWasm: true, requireRustWasm: true, requireWasmRayTracing: true, allowNonStrict: false }
      : { useRustWasm: false, requireRustWasm: false, disableWasmRayTracing: true }
  });

  return {
    map,
    stats: {
      sampleCount: Number(map?.statistics?.opdMicrons?.count) || 0,
      rmsWaves: Number(map?.statistics?.opdWavelengths?.rms),
      p2pWaves: Number(map?.statistics?.opdWavelengths?.peakToPeak),
      invalidReasons: map?.invalidReasonCounts || {}
    }
  };
};

const perField = [];
for (const f of fields) {
  const js = await runOne(f, false);
  const rust = await runOne(f, true);
  const cmp = compareMaps(js.map, rust.map, wavelength, topK);
  perField.push({
    fieldAngleXDeg: f,
    js: js.stats,
    rustWasm: rust.stats,
    comparison: cmp
  });
}

const fieldMaxWaves = [];
let totalCompared = 0;
let sumAbsUm = 0;
let sumSqUm = 0;
let globalMaxAbsUm = 0;
for (const pf of perField) {
  const localMaxW = Number(pf?.comparison?.delta?.opdWaves?.max);
  if (Number.isFinite(localMaxW)) fieldMaxWaves.push(localMaxW);

  const raw = pf?.comparison?.aggregateRaw;
  const cnt = Number(raw?.comparedCount);
  const sa = Number(raw?.sumAbsUm);
  const ss = Number(raw?.sumSqUm);
  const mx = Number(raw?.maxAbsUm);
  if (Number.isFinite(cnt) && cnt > 0 && Number.isFinite(sa) && Number.isFinite(ss)) {
    totalCompared += cnt;
    sumAbsUm += sa;
    sumSqUm += ss;
  }
  if (Number.isFinite(mx)) {
    globalMaxAbsUm = Math.max(globalMaxAbsUm, Math.abs(mx));
  }
}

const aggregate = (() => {
  if (!(Number.isFinite(totalCompared) && totalCompared > 0)) {
    return {
      opdUm: { count: 0, max: null, mean: null, rms: null },
      opdWaves: { count: 0, max: null, mean: null, rms: null }
    };
  }

  const meanAbsUm = sumAbsUm / totalCompared;
  const rmsUm = Math.sqrt(sumSqUm / totalCompared);
  const maxAbsUm = globalMaxAbsUm;

  return {
    opdUm: {
      count: totalCompared,
      max: maxAbsUm,
      mean: meanAbsUm,
      rms: rmsUm
    },
    opdWaves: {
      count: totalCompared,
      max: maxAbsUm / wavelength,
      mean: meanAbsUm / wavelength,
      rms: rmsUm / wavelength
    }
  };
})();

const requirementGate = (() => {
  const checks = [];
  const maxW = Number(aggregate?.opdWaves?.max);
  const rmsW = Number(aggregate?.opdWaves?.rms);
  const meanW = Number(aggregate?.opdWaves?.mean);

  if (Number.isFinite(failMaxWaves)) {
    checks.push({
      metric: 'maxDiffWaves',
      value: maxW,
      limit: failMaxWaves,
      pass: Number.isFinite(maxW) && maxW <= failMaxWaves
    });
  }
  if (Number.isFinite(failRmsWaves)) {
    checks.push({
      metric: 'rmsDiffWaves',
      value: rmsW,
      limit: failRmsWaves,
      pass: Number.isFinite(rmsW) && rmsW <= failRmsWaves
    });
  }
  if (Number.isFinite(failMeanWaves)) {
    checks.push({
      metric: 'meanDiffWaves',
      value: meanW,
      limit: failMeanWaves,
      pass: Number.isFinite(meanW) && meanW <= failMeanWaves
    });
  }

  const failedChecks = checks.filter((c) => !c.pass);
  return {
    enabled: checks.length > 0,
    thresholds: {
      maxDiffWaves: Number.isFinite(failMaxWaves) ? failMaxWaves : null,
      rmsDiffWaves: Number.isFinite(failRmsWaves) ? failRmsWaves : null,
      meanDiffWaves: Number.isFinite(failMeanWaves) ? failMeanWaves : null
    },
    checks,
    failedChecks,
    passed: failedChecks.length === 0
  };
})();

const report = {
  timestamp: new Date().toISOString(),
  config: { gridSize, wavelengthUm: wavelength, forceFinite, fields, topK },
  aggregate,
  requirementGate,
  perField
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const outSummary = {
  output: path.relative(projectRoot, outputPath),
  aggregate,
  maxFieldDeltaWaves: fieldMaxWaves.length ? Math.max(...fieldMaxWaves) : null,
  requirementGate
};

console.log('✅ OPD JS↔Rust parity summary');
console.log(JSON.stringify(outSummary, null, 2));

if (requirementGate.enabled && !requirementGate.passed) {
  console.error('❌ parity threshold failed');
  console.error(JSON.stringify(requirementGate, null, 2));
  process.exitCode = 1;
}

process.exit(process.exitCode || 0);
