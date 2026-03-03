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
import { spawnSync } from 'node:child_process';
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

const inputPath = path.resolve(projectRoot, getArg('input', 'defaults/default-load.json'));
const engine = String(getArg('engine', 'both')).toLowerCase(); // js | rust | both
const rayCount = Math.max(1, Math.floor(toNum(getArg('rays', '25'), 25)));
const targetSurfaceArg = getArg('target', 'last');
const probeSurfaceArg = getArg('probe-surface', '3');
const wavelengthArg = getArg('wavelength', null);
const forwardOnly = String(getArg('forward-only', '0')) === '1';
const rustBatchMetaFastPath = String(getArg('rust-batch-meta-fastpath', '0')) === '1';
const oplEpsilonUm = toNum(getArg('opl-epsilon-um', '0.001'), 0.001);
const autoApertureReportArg = String(getArg('auto-aperture-report', 'auto')).trim().toLowerCase();
const outputPath = path.resolve(projectRoot, getArg('out', `diagnostics/results/raytrace-golden-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));

const normDir = (x, y, z) => {
  const d = Math.hypot(x, y, z);
  if (!(d > 0) || !Number.isFinite(d)) return { x: 0, y: 0, z: 1 };
  return { x: x / d, y: y / d, z: z / d };
};

const roundNum = (v, digits = 12) => {
  if (!Number.isFinite(v)) return v;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

const cloneJsonSafe = (v) => {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
};

const summarize = (arr) => {
  const out = {
    total: 0,
    success: 0,
    failed: 0,
    statuses: {}
  };
  const list = Array.isArray(arr) ? arr : [];
  for (const r of list) {
    out.total += 1;
    const status = String(r?.status || 'unknown');
    out.statuses[status] = (out.statuses[status] || 0) + 1;
    if (r?.success) out.success += 1;
  }
  out.failed = out.total - out.success;
  return out;
};

const compareResults = (jsOut, rustOut, options = null) => {
  const oplEpsilon = Number.isFinite(Number(options?.oplEpsilonUm)) && Number(options?.oplEpsilonUm) >= 0
    ? Number(options.oplEpsilonUm)
    : 1e-3;
  const n = Math.min(Array.isArray(jsOut) ? jsOut.length : 0, Array.isArray(rustOut) ? rustOut.length : 0);
  const cmp = {
    compared: n,
    statusMismatch: 0,
    successMismatch: 0,
    maxHitDeltaMm: 0,
    maxOplDeltaUm: 0,
    meanHitDeltaMm: 0,
    meanOplDeltaUm: 0
  };

  if (n === 0) return cmp;

  let sumHit = 0;
  let sumOpl = 0;
  let cntHit = 0;
  let cntOpl = 0;

  for (let i = 0; i < n; i++) {
    const a = jsOut[i] || {};
    const b = rustOut[i] || {};

    if (String(a.status) !== String(b.status)) cmp.statusMismatch += 1;
    if (!!a.success !== !!b.success) cmp.successMismatch += 1;

    const ah = a.hitPoint;
    const bh = b.hitPoint;
    if (ah && bh) {
      const dx = Number(ah.x) - Number(bh.x);
      const dy = Number(ah.y) - Number(bh.y);
      const dz = Number(ah.z) - Number(bh.z);
      if (Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz)) {
        const d = Math.hypot(dx, dy, dz);
        cmp.maxHitDeltaMm = Math.max(cmp.maxHitDeltaMm, d);
        sumHit += d;
        cntHit += 1;
      }
    }

    const ao = Number(a.oplMicrons);
    const bo = Number(b.oplMicrons);
    if (Number.isFinite(ao) && Number.isFinite(bo)) {
      const rawDelta = Math.abs(ao - bo);
      const d = rawDelta <= oplEpsilon ? 0 : rawDelta;
      cmp.maxOplDeltaUm = Math.max(cmp.maxOplDeltaUm, d);
      sumOpl += d;
      cntOpl += 1;
    }
  }

  if (cntHit > 0) cmp.meanHitDeltaMm = sumHit / cntHit;
  if (cntOpl > 0) cmp.meanOplDeltaUm = sumOpl / cntOpl;
  return cmp;
};

const buildGridRays = (count, span, wavelength) => {
  const side = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rays = [];
  for (let iy = 0; iy < side; iy++) {
    for (let ix = 0; ix < side; ix++) {
      if (rays.length >= count) break;
      const nx = side === 1 ? 0 : (ix / (side - 1)) * 2 - 1;
      const ny = side === 1 ? 0 : (iy / (side - 1)) * 2 - 1;
      const x = nx * span;
      const y = ny * span;
      rays.push({
        pos: { x, y, z: 0 },
        dir: normDir(0, 0, 1),
        wavelength
      });
    }
  }
  return rays;
};

const resolveProbeSurfaceIndex = (raw) => {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'off' || s === 'false') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.floor(n);
};

const collectSurfaceProbes = (traceRayHitPoint, opticalSystemRows, rays, targetSurfaceIndex, probeSurfaceIndex, options) => {
  const g = (typeof globalThis !== 'undefined') ? globalThis : null;
  const perRay = [];
  if (!g || typeof traceRayHitPoint !== 'function' || probeSurfaceIndex === null) {
    return {
      surfaceIndex: probeSurfaceIndex,
      total: Array.isArray(rays) ? rays.length : 0,
      captured: 0,
      perRay
    };
  }

  const prevCfg = g.__COOPT_CAPTURE_SURFACE_PROBE;
  const prevLast = g.__cooptLastSurfaceProbe;

  try {
    g.__COOPT_CAPTURE_SURFACE_PROBE = { surfaceIndex: probeSurfaceIndex };

    for (let i = 0; i < rays.length; i++) {
      const ray = rays[i];
      g.__cooptLastSurfaceProbe = null;
      const hitPoint = traceRayHitPoint(opticalSystemRows, ray, 1.0, targetSurfaceIndex, options);
      const probe = cloneJsonSafe(g.__cooptLastSurfaceProbe);
      perRay.push({
        index: i,
        reachedTarget: !!hitPoint,
        probe: probe || null
      });
    }
  } finally {
    if (typeof prevCfg === 'undefined') {
      try { delete g.__COOPT_CAPTURE_SURFACE_PROBE; } catch { g.__COOPT_CAPTURE_SURFACE_PROBE = undefined; }
    } else {
      g.__COOPT_CAPTURE_SURFACE_PROBE = prevCfg;
    }
    g.__cooptLastSurfaceProbe = prevLast;
  }

  const captured = perRay.reduce((acc, r) => acc + (r?.probe ? 1 : 0), 0);
  return {
    surfaceIndex: probeSurfaceIndex,
    total: perRay.length,
    captured,
    perRay
  };
};

const collectFailureDiagnostics = (traceRayHitPoint, opticalSystemRows, rays, targetSurfaceIndex, options) => {
  const g = (typeof globalThis !== 'undefined') ? globalThis : null;
  const perRay = [];
  const kindCounts = {};
  const surfaceCounts = {};
  const rustSingleStatusCounts = {};

  if (!g || typeof traceRayHitPoint !== 'function') {
    return {
      perRay,
      summary: {
        total: Array.isArray(rays) ? rays.length : 0,
        capturedFailure: 0,
        kinds: kindCounts,
        surfaces: surfaceCounts
      }
    };
  }

  const prevCaptureFlag = g.__COOPT_CAPTURE_RAYTRACE_FAILURE;
  const prevLastFailure = g.__cooptLastRayTraceFailure;
  const prevRustCaptureFlag = g.__COOPT_CAPTURE_RUST_SINGLE_HIT_META;
  const prevRustMeta = g.__cooptLastRustSingleHitMeta;

  try {
    g.__COOPT_CAPTURE_RAYTRACE_FAILURE = true;
    g.__COOPT_CAPTURE_RUST_SINGLE_HIT_META = true;

    for (let i = 0; i < rays.length; i++) {
      const ray = rays[i];
      g.__cooptLastRayTraceFailure = null;
      g.__cooptLastRustSingleHitMeta = null;
      const hitPoint = traceRayHitPoint(opticalSystemRows, ray, 1.0, targetSurfaceIndex, options);
      const failure = cloneJsonSafe(g.__cooptLastRayTraceFailure);
      const rustSingleMeta = cloneJsonSafe(g.__cooptLastRustSingleHitMeta);

      const kind = String(failure?.kind || '');
      const surfaceIndexNum = Number(failure?.details?.surfaceIndex);
      const surfaceIndex = Number.isFinite(surfaceIndexNum) ? surfaceIndexNum : null;
      const surfaceNumberNum = Number(failure?.details?.surfaceNumber);
      const surfaceNumber = Number.isFinite(surfaceNumberNum) ? surfaceNumberNum : null;
      const rustSingleStatus = String(rustSingleMeta?.statusLabel || '');

      if (kind) {
        kindCounts[kind] = (kindCounts[kind] || 0) + 1;
      }
      if (surfaceIndex !== null) {
        const key = String(surfaceIndex);
        surfaceCounts[key] = (surfaceCounts[key] || 0) + 1;
      }
      if (rustSingleStatus) {
        rustSingleStatusCounts[rustSingleStatus] = (rustSingleStatusCounts[rustSingleStatus] || 0) + 1;
      }

      perRay.push({
        index: i,
        reachedTarget: !!hitPoint,
        hitPoint: hitPoint
          ? {
            x: roundNum(Number(hitPoint.x)),
            y: roundNum(Number(hitPoint.y)),
            z: roundNum(Number(hitPoint.z))
          }
          : null,
        failure: kind ? {
          kind,
          surfaceIndex,
          surfaceNumber,
          details: failure?.details ?? null
        } : null,
        rustSingleMeta: rustSingleMeta || null
      });
    }
  } finally {
    if (typeof prevCaptureFlag === 'undefined') {
      try { delete g.__COOPT_CAPTURE_RAYTRACE_FAILURE; } catch { g.__COOPT_CAPTURE_RAYTRACE_FAILURE = undefined; }
    } else {
      g.__COOPT_CAPTURE_RAYTRACE_FAILURE = prevCaptureFlag;
    }
    g.__cooptLastRayTraceFailure = prevLastFailure;
    if (typeof prevRustCaptureFlag === 'undefined') {
      try { delete g.__COOPT_CAPTURE_RUST_SINGLE_HIT_META; } catch { g.__COOPT_CAPTURE_RUST_SINGLE_HIT_META = undefined; }
    } else {
      g.__COOPT_CAPTURE_RUST_SINGLE_HIT_META = prevRustCaptureFlag;
    }
    g.__cooptLastRustSingleHitMeta = prevRustMeta;
  }

  const capturedFailure = perRay.reduce((acc, r) => acc + (r?.failure ? 1 : 0), 0);

  return {
    perRay,
    summary: {
      total: perRay.length,
      capturedFailure,
      kinds: kindCounts,
      surfaces: surfaceCounts,
      rustSingleHitMetaStatus: rustSingleStatusCounts
    }
  };
};

const run = async () => {
  const input = await readJson(inputPath);
  const opticalSystemRows = Array.isArray(input?.opticalSystem) ? input.opticalSystem : [];
  if (!opticalSystemRows.length) {
    throw new Error(`opticalSystem rows not found: ${inputPath}`);
  }

  const sourceRows = Array.isArray(input?.source) ? input.source : [];
  const primary = sourceRows.find((s) => String(s?.primary || '').toLowerCase().includes('primary'));
  const hasExplicitWavelengthArg = wavelengthArg !== null
    && wavelengthArg !== undefined
    && String(wavelengthArg).trim() !== '';
  const wavelength = hasExplicitWavelengthArg && Number.isFinite(Number(wavelengthArg))
    ? Number(wavelengthArg)
    : (Number(primary?.wavelength) || Number(sourceRows?.[0]?.wavelength) || 0.5875618);

  const stopRow = opticalSystemRows.find((r) => {
    const t = String(r?.['object type'] || r?.objectType || '').trim().toLowerCase();
    return t === 'stop' || t === 'sto';
  });
  const semidia = Number(stopRow?.semidia);
  const span = (Number.isFinite(semidia) && semidia > 0) ? semidia * 0.8 : 5.0;

  const targetSurfaceIndex = (() => {
    if (String(targetSurfaceArg).toLowerCase() === 'last') return opticalSystemRows.length - 1;
    const n = Number(targetSurfaceArg);
    if (!Number.isFinite(n)) return opticalSystemRows.length - 1;
    return Math.max(0, Math.min(opticalSystemRows.length - 1, Math.floor(n)));
  })();
  const probeSurfaceIndex = resolveProbeSurfaceIndex(probeSurfaceArg);

  const rays = buildGridRays(rayCount, span, wavelength);

  const { traceRayEvalBatchSummary, traceRayHitPoint } = await import('../raytracing/core/ray-tracing.ts');
  const { preloadRustRayTracingWasm, getRustRayTracingWasmInitError } = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');

  const result = {
    timestamp: new Date().toISOString(),
    inputPath: path.relative(projectRoot, inputPath),
    outputPath: path.relative(projectRoot, outputPath),
    settings: {
      engine,
      rayCount,
      wavelength,
      targetSurfaceIndex,
      probeSurfaceIndex,
      forwardOnly,
      rustBatchMetaFastPath,
      oplEpsilonUm,
      spanMm: span
    },
    rows: {
      opticalSystem: opticalSystemRows.length,
      source: sourceRows.length
    },
    rays,
    outputs: {},
    diagnostics: {},
    summaries: {},
    comparison: null,
    notes: []
  };

  const canRunJs = engine === 'js' || engine === 'both';
  const canRunRust = engine === 'rust' || engine === 'both';

  const jsTraceOptions = {
    allowNonStrict: true,
    useRustWasm: false,
    requireRustWasm: false,
    requireForwardHit: forwardOnly
  };

  const rustTraceOptions = {
    allowNonStrict: true,
    useRustWasm: true,
    requireRustWasm: true,
    requireForwardHit: forwardOnly,
    rustBatchMetaFastPath
  };

  if (canRunJs) {
    const jsOut = traceRayEvalBatchSummary(opticalSystemRows, rays, 1.0, targetSurfaceIndex, jsTraceOptions) || [];
    result.outputs.js = jsOut.map((r) => ({
      success: !!r?.success,
      status: String(r?.status || ''),
      hitPoint: r?.hitPoint
        ? { x: roundNum(Number(r.hitPoint.x)), y: roundNum(Number(r.hitPoint.y)), z: roundNum(Number(r.hitPoint.z)) }
        : null,
      oplMicrons: roundNum(Number(r?.oplMicrons))
    }));
    result.diagnostics.js = collectFailureDiagnostics(
      traceRayHitPoint,
      opticalSystemRows,
      rays,
      targetSurfaceIndex,
      jsTraceOptions
    );
    result.diagnostics.jsProbe = collectSurfaceProbes(
      traceRayHitPoint,
      opticalSystemRows,
      rays,
      targetSurfaceIndex,
      probeSurfaceIndex,
      jsTraceOptions
    );
    result.summaries.js = summarize(result.outputs.js);
  }

  if (canRunRust) {
    let rustReady = false;
    try {
      const rustApi = await preloadRustRayTracingWasm();
      rustReady = !!rustApi;
    } catch (_) {
      rustReady = false;
    }

    if (!rustReady) {
      const err = getRustRayTracingWasmInitError?.() || 'Rust WASM unavailable';
      result.notes.push(`rust_init_failed:${String(err)}`);
      if (engine === 'rust') {
        throw new Error(`Rust engine requested but unavailable: ${err}`);
      }
    } else {
      const rustOut = traceRayEvalBatchSummary(opticalSystemRows, rays, 1.0, targetSurfaceIndex, rustTraceOptions) || [];
      result.outputs.rust = rustOut.map((r) => ({
        success: !!r?.success,
        status: String(r?.status || ''),
        hitPoint: r?.hitPoint
          ? { x: roundNum(Number(r.hitPoint.x)), y: roundNum(Number(r.hitPoint.y)), z: roundNum(Number(r.hitPoint.z)) }
          : null,
        oplMicrons: roundNum(Number(r?.oplMicrons))
      }));
      result.diagnostics.rust = collectFailureDiagnostics(
        traceRayHitPoint,
        opticalSystemRows,
        rays,
        targetSurfaceIndex,
        rustTraceOptions
      );
      result.diagnostics.rustProbe = collectSurfaceProbes(
        traceRayHitPoint,
        opticalSystemRows,
        rays,
        targetSurfaceIndex,
        probeSurfaceIndex,
        rustTraceOptions
      );
      result.summaries.rust = summarize(result.outputs.rust);
    }
  }

  if (result.outputs.js && result.outputs.rust) {
    result.comparison = compareResults(result.outputs.js, result.outputs.rust, { oplEpsilonUm });
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const shouldAutoApertureReport = (() => {
    if (autoApertureReportArg === '1' || autoApertureReportArg === 'true' || autoApertureReportArg === 'yes' || autoApertureReportArg === 'on') return true;
    if (autoApertureReportArg === '0' || autoApertureReportArg === 'false' || autoApertureReportArg === 'no' || autoApertureReportArg === 'off') return false;
    return engine === 'both';
  })();

  let apertureReportPath = null;
  if (shouldAutoApertureReport && result.outputs.js && result.outputs.rust) {
    const baseName = path.basename(outputPath, '.json');
    const outPath = path.resolve(path.dirname(outputPath), `${baseName}-aperture.json`);
    const analyzeScript = path.resolve(projectRoot, 'diagnostics/aperture-threshold-analyze.mjs');
    const inputRel = path.relative(projectRoot, outputPath);
    const outRel = path.relative(projectRoot, outPath);
    const proc = spawnSync(
      process.execPath,
      ['--experimental-strip-types', analyzeScript, '--input', inputRel, '--out', outRel],
      { cwd: projectRoot, encoding: 'utf8' }
    );
    if (proc.status === 0) {
      apertureReportPath = outPath;
    } else {
      const err = String(proc.stderr || proc.stdout || `exit:${String(proc.status ?? 'unknown')}`);
      result.notes.push(`aperture_report_failed:${err.trim()}`);
    }
  }

  console.log('✅ raytrace golden capture complete');
  console.log(JSON.stringify({
    output: path.relative(projectRoot, outputPath),
    apertureReport: apertureReportPath ? path.relative(projectRoot, apertureReportPath) : null,
    summaries: result.summaries,
    comparison: result.comparison,
    notes: result.notes
  }, null, 2));
};

await run();
