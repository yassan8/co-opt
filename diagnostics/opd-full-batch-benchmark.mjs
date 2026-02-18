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

const { createOPDCalculator, createWavefrontAnalyzer } = await import('../evaluation/wavefront/wavefront.ts');
const { getOpticalSystemRows } = await import('../utils/data-utils.ts');

const gridSize = Number.isFinite(Number(process.env.OPD_GRID_SIZE)) ? Number(process.env.OPD_GRID_SIZE) : 64;
const fieldX = Number.isFinite(Number(process.env.OPD_FIELD_X)) ? Number(process.env.OPD_FIELD_X) : 10;
const wavelength = Number.isFinite(Number(process.env.OPD_WAVELENGTH)) ? Number(process.env.OPD_WAVELENGTH) : 0.5876;
const runs = Number.isFinite(Number(process.env.OPD_RUNS)) ? Number(process.env.OPD_RUNS) : 4;
const opdMode = (process.env.OPD_MODE || 'referenceSphere').trim();

const fieldSetting = { fieldAngle: { x: fieldX, y: 0 } };
const opticalSystemRows = getOpticalSystemRows();
const calc = createOPDCalculator(opticalSystemRows, wavelength);
const analyzer = createWavefrontAnalyzer(calc);

const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();

async function runOne(fullBatchTraceExperimental) {
  const options = {
    recordRays: false,
    progressEvery: 0,
    opdMode,
    zernikeMaxNoll: 37,
    skipZernikeFit: true,
    renderFromZernike: false,
    opdDisplayMode: 'pistonTiltRemoved',
    fullBatchTraceExperimental
  };

  const t0 = now();
  const map = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', options);
  const t1 = now();
  if (map?.error) {
    throw new Error(`wavefront failed: ${map.error?.message || map.error}`);
  }

  const valid = Array.isArray(map?.opds) ? map.opds.filter(Number.isFinite).length : 0;
  return { ms: t1 - t0, valid };
}

function summarize(samples) {
  const msArr = samples.map((s) => s.ms);
  return {
    avgMs: msArr.reduce((a, b) => a + b, 0) / Math.max(1, msArr.length),
    minMs: Math.min(...msArr),
    maxMs: Math.max(...msArr),
    validAvg: samples.reduce((a, b) => a + b.valid, 0) / Math.max(1, samples.length),
    samples
  };
}

console.log('▶ OPD full-batch A/B benchmark start', { gridSize, fieldX, wavelength, runs, opdMode });

await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', {
  recordRays: false,
  progressEvery: 0,
  skipZernikeFit: true,
  renderFromZernike: false,
  opdMode,
  opdDisplayMode: 'pistonTiltRemoved',
  fullBatchTraceExperimental: false
});

const offSamples = [];
const onSamples = [];

for (let i = 0; i < runs; i++) {
  const firstOn = (i % 2) === 0;
  const first = await runOne(firstOn);
  if (firstOn) onSamples.push(first); else offSamples.push(first);

  const second = await runOne(!firstOn);
  if (!firstOn) onSamples.push(second); else offSamples.push(second);
}

const off = summarize(offSamples);
const on = summarize(onSamples);
const speedup = off.avgMs > 0 ? off.avgMs / on.avgMs : NaN;

console.log('✅ OPD full-batch A/B benchmark summary');
console.log(JSON.stringify({
  gridSize,
  fieldX,
  wavelength,
  runs,
  off: {
    avgMs: off.avgMs,
    minMs: off.minMs,
    maxMs: off.maxMs,
    validAvg: off.validAvg
  },
  on: {
    avgMs: on.avgMs,
    minMs: on.minMs,
    maxMs: on.maxMs,
    validAvg: on.validAvg
  },
  speedup,
  speedupPercent: Number.isFinite(speedup) ? (speedup - 1) * 100 : null,
  samples: { off: off.samples, on: on.samples }
}, null, 2));
