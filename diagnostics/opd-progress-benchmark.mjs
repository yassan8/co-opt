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
const runs = Number.isFinite(Number(process.env.OPD_RUNS)) ? Number(process.env.OPD_RUNS) : 5;
const opdMode = (process.env.OPD_MODE || 'referenceSphere').trim();

const fieldSetting = { fieldAngle: { x: fieldX, y: 0 } };
const opticalSystemRows = getOpticalSystemRows();
const calc = createOPDCalculator(opticalSystemRows, wavelength);
const analyzer = createWavefrontAnalyzer(calc);

const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();

async function runOne(mode) {
  let cbCalls = 0;
  const options = {
    recordRays: false,
    progressEvery: 0,
    opdMode,
    zernikeMaxNoll: 37,
    skipZernikeFit: true,
    renderFromZernike: false,
    opdDisplayMode: 'pistonTiltRemoved'
  };
  if (mode === 'withProgress') {
    options.onProgress = (evt) => {
      cbCalls++;
      const p = Number(evt?.percent);
      const msg = evt?.message || evt?.phase || 'Working...';
      if (Number.isFinite(p) && msg.length > 0) {
        const sink = `${Math.max(0, Math.min(100, p)).toFixed(2)}:${msg}`;
        void sink;
      }
    };
  }

  const t0 = now();
  const map = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', options);
  const t1 = now();
  if (map?.error) {
    throw new Error(`wavefront failed: ${map.error?.message || map.error}`);
  }

  return { ms: t1 - t0, cbCalls };
}

function summarize(mode, samples) {
  const msArr = samples.map((s) => s.ms);
  const avg = msArr.reduce((a, b) => a + b, 0) / Math.max(1, msArr.length);
  const min = Math.min(...msArr);
  const max = Math.max(...msArr);
  const cbAvg = samples.reduce((a, b) => a + b.cbCalls, 0) / Math.max(1, samples.length);
  return { mode, runs: samples.length, avgMs: avg, minMs: min, maxMs: max, cbCallsAvg: cbAvg, samples };
}

console.log('▶ OPD progress benchmark start', { gridSize, fieldX, wavelength, runs, opdMode });

await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', {
  recordRays: false,
  progressEvery: 0,
  skipZernikeFit: true,
  renderFromZernike: false,
  opdMode,
  opdDisplayMode: 'pistonTiltRemoved'
});

const noProgressSamples = [];
const withProgressSamples = [];

for (let i = 0; i < runs; i++) {
  const firstMode = (i % 2 === 0) ? 'noProgress' : 'withProgress';
  const secondMode = firstMode === 'noProgress' ? 'withProgress' : 'noProgress';

  const first = await runOne(firstMode);
  if (firstMode === 'noProgress') noProgressSamples.push(first);
  else withProgressSamples.push(first);

  const second = await runOne(secondMode);
  if (secondMode === 'noProgress') noProgressSamples.push(second);
  else withProgressSamples.push(second);
}

const noProgress = summarize('noProgress', noProgressSamples);
const withProgress = summarize('withProgress', withProgressSamples);
const deltaMs = withProgress.avgMs - noProgress.avgMs;
const deltaPct = (deltaMs / Math.max(1e-9, noProgress.avgMs)) * 100;

const out = {
  gridSize,
  fieldX,
  wavelength,
  runs,
  noProgress: {
    avgMs: noProgress.avgMs,
    minMs: noProgress.minMs,
    maxMs: noProgress.maxMs
  },
  withProgress: {
    avgMs: withProgress.avgMs,
    minMs: withProgress.minMs,
    maxMs: withProgress.maxMs,
    cbCallsAvg: withProgress.cbCallsAvg
  },
  deltaMs,
  deltaPct,
  samples: {
    noProgress: noProgress.samples,
    withProgress: withProgress.samples
  }
};

console.log('✅ OPD progress benchmark summary');
console.log(JSON.stringify(out, null, 2));
