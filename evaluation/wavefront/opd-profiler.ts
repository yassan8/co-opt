// opd-profiler.js
// OPD用の光線追跡プロファイラ（ブラウザ実行用ハーネス）
// 使い方（DevToolsコンソール）:
//   await runOPDProfiling({ gridSizes: [64,128], fields: [{ fieldAngle: {x:0,y:0} }, { fieldAngle: {x:10,y:0} }] })
// 結果はオブジェクトで返り、詳細はコンソールに整形出力されます。

import { enableRayTracingProfiler, getRayTracingProfile } from '../../raytracing/core/ray-tracing.ts';
import { OpticalPathDifferenceCalculator } from './wavefront.ts';
import { preloadRustRayTracingWasm } from '../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';
import { getOpticalSystemRows } from '../../utils/data-utils.ts';

function now() {
  if (typeof performance !== 'undefined' && performance?.now) return performance.now();
  return Date.now();
}

function genUnitDiskGrid(n) {
  const pts = [];
  if (!Number.isFinite(n) || n <= 0) return pts;
  for (let j = 0; j < n; j++) {
    const v = -1 + (2 * j) / (n - 1);
    for (let i = 0; i < n; i++) {
      const u = -1 + (2 * i) / (n - 1);
      if (u * u + v * v <= 1.0) pts.push([u, v]);
    }
  }
  return pts;
}

function summarizeProfile(stats, totalMs) {
  const timeKeys = [
    'traceTime','traceSetupTime','traceLoopTime','intersectTime','asphericSagTime','asphericSagDerivTime','surfaceNormalTime',
    'refractTime','reflectTime','applyMatTime','invertMatTime','refractiveIndexTime',
    'calculateSurfaceOriginsTime','transformRayToLocalTime','transformRayToLocalInnerTime','transformPointToGlobalTime'
  ];
  const rows = timeKeys
    .map(k => ({ key: k, ms: stats[k] || 0 }))
    .filter(r => r.ms > 0.01)
    .sort((a,b) => b.ms - a.ms);
  const totalProfiled = rows.reduce((s,r) => s + r.ms, 0);
  return {
    totalMs,
    totalProfiledMs: totalProfiled,
    coverage: totalProfiled / Math.max(1, totalMs),
    byFunction: rows.map(r => ({ name: r.key, ms: r.ms, pctOfTotal: (r.ms/Math.max(1,totalMs)) * 100, pctOfProfiled: (r.ms/Math.max(1,totalProfiled)) * 100 })),
    iter: {
      intersectCalls: stats.intersectCalls || 0,
      intersectIterationsTotal: stats.intersectIterationsTotal || 0,
      intersectIterationsMax: stats.intersectIterationsMax || 0,
      avgIterPerCall: (stats.intersectIterationsTotal||0) / Math.max(1, (stats.intersectCalls||0))
    },
    counts: {
      traceCalls: stats.traceCalls || 0,
      traceBatchLockstepCalls: stats.traceBatchLockstepCalls || 0,
      traceBatchLockstepRays: stats.traceBatchLockstepRays || 0,
      traceBatchFallbackCalls: stats.traceBatchFallbackCalls || 0,
      traceBatchFallbackRays: stats.traceBatchFallbackRays || 0,
      traceBatchFallbackToric: stats.traceBatchFallbackToric || 0,
      traceBatchFallbackRadius: stats.traceBatchFallbackRadius || 0,
      traceBatchFallbackPrecompute: stats.traceBatchFallbackPrecompute || 0,
      traceBatchFallbackOther: stats.traceBatchFallbackOther || 0,
      asphericSagCalls: stats.asphericSagCalls || 0,
      asphericSagDerivCalls: stats.asphericSagDerivCalls || 0,
      surfaceNormalCalls: stats.surfaceNormalCalls || 0,
      refractCalls: stats.refractCalls || 0,
      applyMatCalls: stats.applyMatCalls || 0,
      invertMatCalls: stats.invertMatCalls || 0,
      refractiveIndexCalls: stats.refractiveIndexCalls || 0,
      transformLocalMissingInverse: stats.transformLocalMissingInverse || 0,
      transformLocalInverseSynthesized: stats.transformLocalInverseSynthesized || 0,
      transformLocalInverseUnavailable: stats.transformLocalInverseUnavailable || 0
    }
  };
}

function buildTraceOptions(traceMode = 'js', options = {}) {
  if (traceMode === 'wasm-strict') {
    return { requireWasmRayTracing: true, allowNonStrict: false };
  }
  if (traceMode === 'wasm-full-batch') {
    return { fullBatchTraceExperimental: true, allowNonStrict: true };
  }
  if (traceMode === 'rust-wasm') {
    const rustMaxIter = Number.isFinite(Number(options?.rustMaxIter)) ? Number(options.rustMaxIter) : undefined;
    const rustTol = Number.isFinite(Number(options?.rustTol)) ? Number(options.rustTol) : undefined;
    return { useRustWasm: true, requireRustWasm: true, rustMaxIter, rustTol };
  }
  return null;
}

async function runOneCase({ gridSize, fieldSetting, wavelength = 0.5876, warmup = true, traceMode = 'js', options = null }) {
  const opticalSystemRows = getOpticalSystemRows();
  const calc = new OpticalPathDifferenceCalculator(opticalSystemRows, wavelength);
  const traceOptions = buildTraceOptions(traceMode, options);
  const calcOptions = traceOptions ? { traceOptions } : undefined;

  // 基準光線を準備
  calc.setReferenceRay(fieldSetting);

  const points = genUnitDiskGrid(gridSize);

  // ウォームアップ（JIT/キャッシュ用）
  if (warmup) {
    for (let i = 0; i < Math.min(200, points.length); i++) {
      const [u, v] = points[i];
      calc.calculateOPD(u, v, fieldSetting, calcOptions);
    }
  }

  // プロファイル計測
  enableRayTracingProfiler(true, true);
  const t0 = now();
  let validCount = 0;
  for (let i = 0; i < points.length; i++) {
    const [u, v] = points[i];
    const opd = calc.calculateOPD(u, v, fieldSetting, calcOptions);
    if (Number.isFinite(opd)) validCount++;
  }
  const totalMs = now() - t0;
  const stats = getRayTracingProfile({ reset: true });
  const summary = summarizeProfile(stats, totalMs);
  return { gridSize, totalPoints: points.length, validCount, fieldSetting, traceMode, summary, raw: stats };
}

export async function runOPDProfiling(options = {}) {
  const {
    gridSizes = [64, 128],
    fields = [ { fieldAngle: { x: 0, y: 0 } }, { fieldAngle: { x: 10, y: 0 } } ],
    wavelength = 0.5876,
    warmup = true,
    traceMode = 'js'
  } = options;

  let rustWasmReady = null;
  if (traceMode === 'rust-wasm') {
    const rust = await preloadRustRayTracingWasm();
    rustWasmReady = !!rust;
    if (!rustWasmReady) {
      console.warn('⚠️ Rust WASM is not ready; falling back to JS paths where available.');
    }
  }
  try {
    if (typeof globalThis !== 'undefined') {
      (globalThis as any).__COOPT_USE_RUST_SURFACE_ORIGINS = (traceMode === 'rust-wasm');
    }
  } catch (_) {}

  const results = [];
  const errors = [];
  for (const gs of gridSizes) {
    for (const field of fields) {
      try {
        const r = await runOneCase({ gridSize: gs, fieldSetting: field, wavelength, warmup, traceMode, options });
        results.push(r);
        // 簡潔に出力
        console.log(`\n===== OPD Profiling: mode=${traceMode}, grid ${gs} x ${gs}, field=(${field.fieldAngle?.x||0}, ${field.fieldAngle?.y||0}) deg =====`);
        console.table(r.summary.byFunction.map(x => ({ name: x.name, ms: x.ms.toFixed(2), '%total': x.pctOfTotal.toFixed(1), '%profiled': x.pctOfProfiled.toFixed(1) })));
        console.log('iter:', r.summary.iter, 'counts:', r.summary.counts);
        console.log(`Total elapsed: ${r.summary.totalMs.toFixed(1)} ms, Profiled: ${r.summary.totalProfiledMs.toFixed(1)} ms (coverage ${(r.summary.coverage*100).toFixed(1)}%)`);
      } catch (e) {
        const entry = { gridSize: gs, field, error: e?.message };
        errors.push(entry);
        console.warn('Profiling case failed:', entry);
      }
    }
  }

  // 優先度提案（時間割合ベース）
  function proposePriorities(all) {
    // 全ケース合算
    const acc = new Map();
    for (const r of all) {
      for (const x of r.summary.byFunction) {
        acc.set(x.name, (acc.get(x.name) || 0) + x.ms);
      }
    }
    const ranked = [...acc.entries()].map(([name, ms]) => ({ name, ms })).sort((a,b) => b.ms - a.ms);
    const ordered = ranked.map((r, i) => ({ rank: i+1, name: r.name, ms: r.ms }));
    // WASM化候補のグルーピング
    const groups = [
      {
        label: 'G1: 交点ソルバ&サグ関連',
        keys: ['intersectTime','asphericSagTime','asphericSagDerivTime','surfaceNormalTime']
      },
      {
        label: 'G2: 屈折/反射',
        keys: ['refractTime','reflectTime']
      },
      {
        label: 'G3: 変換/行列',
        keys: ['transformRayToLocalTime','transformRayToLocalInnerTime','transformPointToGlobalTime','applyMatTime','invertMatTime']
      },
      {
        label: 'G4: 屈折率参照',
        keys: ['refractiveIndexTime']
      }
    ];
    const groupTotals = groups.map(g => ({
      label: g.label,
      ms: ordered.filter(o => g.keys.includes(o.name)).reduce((s,o) => s + o.ms, 0),
      keys: g.keys
    })).sort((a,b) => b.ms - a.ms);
    return { ranked: ordered, groupTotals };
  }

  const priorities = proposePriorities(results);
  const out = {
    timestamp: new Date().toISOString(),
    results,
    priorities,
    errors,
    casesPlanned: gridSizes.length * fields.length,
    casesCompleted: results.length,
    rustWasmReady
  };
  console.log('\n===== Suggested WASM priorities (aggregated) =====');
  console.table(priorities.groupTotals.map(g => ({ group: g.label, ms: g.ms.toFixed(1) })));
  console.table(priorities.ranked.slice(0, 10).map(x => ({ rank: x.rank, name: x.name, ms: x.ms.toFixed(1) })));
  // 使いやすいようにwindowに保存
  if (typeof window !== 'undefined') window['lastOPDProfile'] = out;
  return out;
}

export async function runOPDProfilingCompareModes(options = {}) {
  const modes = Array.isArray(options?.traceModes) && options.traceModes.length
    ? options.traceModes
    : ['js', 'wasm-strict'];

  const modeResults = [];
  for (const mode of modes) {
    const out = await runOPDProfiling({ ...options, traceMode: mode });
    modeResults.push({ mode, out });
  }

  const compareRows = modeResults.map(({ mode, out }) => {
    const totals = Array.isArray(out?.results) ? out.results : [];
    const totalMs = totals.reduce((s, r) => s + (Number(r?.summary?.totalMs) || 0), 0);
    const traceMs = totals.reduce((s, r) => s + (Number(r?.raw?.traceTime) || 0), 0);
    const intersectMs = totals.reduce((s, r) => s + (Number(r?.raw?.intersectTime) || 0), 0);
    const surfaceNormalMs = totals.reduce((s, r) => s + (Number(r?.raw?.surfaceNormalTime) || 0), 0);
    const errors = Array.isArray(out?.errors) ? out.errors : [];
    const firstError = errors.length ? errors[0]?.error : null;
    return {
      mode,
      totalMs,
      traceMs,
      intersectMs,
      surfaceNormalMs,
      casesPlanned: Number(out?.casesPlanned) || 0,
      casesCompleted: Number(out?.casesCompleted) || 0,
      errorCount: errors.length,
      rustWasmReady: out?.rustWasmReady ?? null,
      firstError
    };
  });

  console.log('\n===== OPD Profiling mode comparison =====');
  console.table(compareRows.map(r => ({
    mode: r.mode,
    totalMs: r.totalMs.toFixed(1),
    traceMs: r.traceMs.toFixed(1),
    intersectMs: r.intersectMs.toFixed(1),
    surfaceNormalMs: r.surfaceNormalMs.toFixed(1),
    cases: `${r.casesCompleted}/${r.casesPlanned}`,
    errors: r.errorCount,
    rustWasmReady: r.rustWasmReady,
    firstError: r.firstError || ''
  })));

  const errorRows = compareRows.filter(r => r.errorCount > 0);
  if (errorRows.length) {
    console.warn('⚠️ OPD profiling errors detected:');
    for (const row of errorRows) {
      console.warn(`mode=${row.mode} errors=${row.errorCount} firstError=${row.firstError || ''}`);
    }
  }

  const maxTotal = Math.max(1, ...compareRows.map(r => r.totalMs));
  const bars = compareRows.map(r => {
    const width = Math.max(1, Math.round((r.totalMs / maxTotal) * 40));
    return {
      mode: r.mode,
      bar: '#'.repeat(width),
      totalMs: r.totalMs.toFixed(1)
    };
  });
  console.log('\n===== OPD Profiling totals (bar chart) =====');
  console.table(bars);

  const out = { timestamp: new Date().toISOString(), compareRows, modeResults };
  if (typeof window !== 'undefined') window['lastOPDProfileCompare'] = out;
  if (typeof window !== 'undefined') window['lastOPDProfileReport'] = buildOPDProfileReport(out);
  if (options && options.downloadCsv === true) {
    try {
      downloadOPDProfileReportCsv(window['lastOPDProfileReport']);
    } catch (_) {}
  }
  return out;
}

export function buildOPDProfileReport(compareOut) {
  const rows = Array.isArray(compareOut?.compareRows) ? compareOut.compareRows : [];
  const header = ['mode', 'totalMs', 'traceMs', 'intersectMs', 'surfaceNormalMs', 'casesCompleted', 'casesPlanned', 'errorCount', 'rustWasmReady', 'firstError'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push([
      row.mode,
      Number(row.totalMs).toFixed(3),
      Number(row.traceMs).toFixed(3),
      Number(row.intersectMs).toFixed(3),
      Number(row.surfaceNormalMs).toFixed(3),
      Number(row.casesCompleted) || 0,
      Number(row.casesPlanned) || 0,
      Number(row.errorCount) || 0,
      row.rustWasmReady === null || row.rustWasmReady === undefined ? '' : String(row.rustWasmReady),
      (row.firstError || '').replace(/\s+/g, ' ').replace(/,/g, ';')
    ].join(','));
  }
  return {
    timestamp: new Date().toISOString(),
    csv: lines.join('\n'),
    json: JSON.stringify(compareOut, null, 2)
  };
}

export function downloadOPDProfileReportCsv(report, filename = null) {
  const csv = report?.csv;
  if (!csv || typeof csv !== 'string') return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = filename || `opd_profile_report_${stamp}.csv`;
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

// 便利関数をグローバルに公開
if (typeof window !== 'undefined') {
  window['runOPDProfiling'] = runOPDProfiling;
  window['runOPDProfilingCompareModes'] = runOPDProfilingCompareModes;
  window['buildOPDProfileReport'] = buildOPDProfileReport;
  window['downloadOPDProfileReportCsv'] = downloadOPDProfileReportCsv;
}
