// opd-profiler.js
// OPD用の光線追跡プロファイラ（ブラウザ実行用ハーネス）
// 使い方（DevToolsコンソール）:
//   await runOPDProfiling({ gridSizes: [64,128], fields: [{ fieldAngle: {x:0,y:0} }, { fieldAngle: {x:10,y:0} }] })
// 結果はオブジェクトで返り、詳細はコンソールに整形出力されます。

import { enableRayTracingProfiler, getRayTracingProfile } from '../../raytracing/core/ray-tracing.js';
import { OpticalPathDifferenceCalculator } from './wavefront.js';
import { getOpticalSystemRows } from '../../utils/data-utils.js';

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
    'traceTime','intersectTime','asphericSagTime','asphericSagDerivTime','surfaceNormalTime',
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
      asphericSagCalls: stats.asphericSagCalls || 0,
      asphericSagDerivCalls: stats.asphericSagDerivCalls || 0,
      surfaceNormalCalls: stats.surfaceNormalCalls || 0,
      refractCalls: stats.refractCalls || 0,
      applyMatCalls: stats.applyMatCalls || 0,
      invertMatCalls: stats.invertMatCalls || 0,
      refractiveIndexCalls: stats.refractiveIndexCalls || 0
    }
  };
}

async function runOneCase({ gridSize, fieldSetting, wavelength = 0.5876, warmup = true }) {
  const opticalSystemRows = getOpticalSystemRows();
  const calc = new OpticalPathDifferenceCalculator(opticalSystemRows, wavelength);

  // 基準光線を準備
  calc.setReferenceRay(fieldSetting);

  const points = genUnitDiskGrid(gridSize);

  // ウォームアップ（JIT/キャッシュ用）
  if (warmup) {
    for (let i = 0; i < Math.min(200, points.length); i++) {
      const [u, v] = points[i];
      calc.calculateOPD(u, v, fieldSetting);
    }
  }

  // プロファイル計測
  enableRayTracingProfiler(true, true);
  const t0 = now();
  let validCount = 0;
  for (let i = 0; i < points.length; i++) {
    const [u, v] = points[i];
    const opd = calc.calculateOPD(u, v, fieldSetting);
    if (Number.isFinite(opd)) validCount++;
  }
  const totalMs = now() - t0;
  const stats = getRayTracingProfile({ reset: true });
  const summary = summarizeProfile(stats, totalMs);
  return { gridSize, totalPoints: points.length, validCount, fieldSetting, summary, raw: stats };
}

export async function runOPDProfiling(options = {}) {
  const {
    gridSizes = [64, 128],
    fields = [ { fieldAngle: { x: 0, y: 0 } }, { fieldAngle: { x: 10, y: 0 } } ],
    wavelength = 0.5876,
    warmup = true
  } = options;

  const results = [];
  for (const gs of gridSizes) {
    for (const field of fields) {
      try {
        const r = await runOneCase({ gridSize: gs, fieldSetting: field, wavelength, warmup });
        results.push(r);
        // 簡潔に出力
        console.log(`\n===== OPD Profiling: grid ${gs} x ${gs}, field=(${field.fieldAngle?.x||0}, ${field.fieldAngle?.y||0}) deg =====`);
        console.table(r.summary.byFunction.map(x => ({ name: x.name, ms: x.ms.toFixed(2), '%total': x.pctOfTotal.toFixed(1), '%profiled': x.pctOfProfiled.toFixed(1) })));
        console.log('iter:', r.summary.iter, 'counts:', r.summary.counts);
        console.log(`Total elapsed: ${r.summary.totalMs.toFixed(1)} ms, Profiled: ${r.summary.totalProfiledMs.toFixed(1)} ms (coverage ${(r.summary.coverage*100).toFixed(1)}%)`);
      } catch (e) {
        console.warn('Profiling case failed:', { gridSize: gs, field, error: e?.message });
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
  const out = { timestamp: new Date().toISOString(), results, priorities };
  console.log('\n===== Suggested WASM priorities (aggregated) =====');
  console.table(priorities.groupTotals.map(g => ({ group: g.label, ms: g.ms.toFixed(1) })));
  console.table(priorities.ranked.slice(0, 10).map(x => ({ rank: x.rank, name: x.name, ms: x.ms.toFixed(1) })));
  // 使いやすいようにwindowに保存
  if (typeof window !== 'undefined') window.lastOPDProfile = out;
  return out;
}

// 便利関数をグローバルに公開
if (typeof window !== 'undefined') {
  window.runOPDProfiling = runOPDProfiling;
}
