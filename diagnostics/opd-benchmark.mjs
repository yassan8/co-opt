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

const parseList = (raw, fallback) => {
  if (!raw || typeof raw !== 'string') return fallback;
  const vals = raw.split(',').map(s => Number(s.trim())).filter(v => Number.isFinite(v));
  return vals.length ? vals : fallback;
};

const gridSizes = parseList(process.env.OPD_GRID_SIZES, [64, 128]);
const fieldsX = parseList(process.env.OPD_FIELDS_X, [0, 10]);
const wavelength = Number.isFinite(Number(process.env.OPD_WAVELENGTH)) ? Number(process.env.OPD_WAVELENGTH) : 0.5876;
const warmup = String(process.env.OPD_WARMUP ?? '1') !== '0';
const fullBatchTraceExperimental = String(process.env.OPD_FULL_BATCH ?? '0') === '1';

const fields = fieldsX.map(x => ({ fieldAngle: { x, y: 0 } }));

const { runOPDProfiling } = await import('../evaluation/wavefront/opd-profiler.ts');

console.log('▶ OPD benchmark start', { gridSizes, fieldsX, wavelength, warmup, fullBatchTraceExperimental });
const result = await runOPDProfiling({
  gridSizes,
  fields,
  wavelength,
  warmup,
  fullBatchTraceExperimental
});

const diagnostics = (() => {
  const totals = {
    traceBatchLockstepCalls: 0,
    traceBatchLockstepRays: 0,
    traceBatchFallbackCalls: 0,
    traceBatchFallbackRays: 0,
    traceBatchFallbackToric: 0,
    traceBatchFallbackRadius: 0,
    traceBatchFallbackPrecompute: 0,
    traceBatchFallbackOther: 0,
    invertMatCalls: 0,
    transformLocalMissingInverse: 0,
    transformLocalInverseSynthesized: 0,
    transformLocalInverseUnavailable: 0
  };
  const cases = Array.isArray(result?.results) ? result.results : [];
  for (const c of cases) {
    const raw = c?.raw || {};
    for (const k of Object.keys(totals)) {
      totals[k] += Number(raw[k]) || 0;
    }
  }
  return totals;
})();

const out = {
  timestamp: result?.timestamp,
  caseCount: Array.isArray(result?.results) ? result.results.length : 0,
  topHotspots: Array.isArray(result?.priorities?.ranked) ? result.priorities.ranked.slice(0, 8) : [],
  topGroups: Array.isArray(result?.priorities?.groupTotals) ? result.priorities.groupTotals : [],
  fullBatchTraceExperimental,
  diagnostics
};

console.log('✅ OPD benchmark summary');
console.log(JSON.stringify(out, null, 2));
