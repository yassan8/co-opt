if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

const { fitZernikeWeighted } = await import('../evaluation/wavefront/zernike-fitting.ts');

const pointGrid = Number.isFinite(Number(process.env.ZERNIKE_GRID)) ? Math.max(17, Number(process.env.ZERNIKE_GRID)) : 129;
const maxOrder = Number.isFinite(Number(process.env.ZERNIKE_MAX_ORDER)) ? Math.max(4, Number(process.env.ZERNIKE_MAX_ORDER)) : 10;
const rounds = Number.isFinite(Number(process.env.ZERNIKE_ROUNDS)) ? Math.max(1, Number(process.env.ZERNIKE_ROUNDS)) : 10;

function now() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function buildPoints(grid) {
  const points = [];
  for (let j = 0; j < grid; j++) {
    const y = -1 + (2 * j) / (grid - 1);
    for (let i = 0; i < grid; i++) {
      const x = -1 + (2 * i) / (grid - 1);
      const r2 = x * x + y * y;
      if (r2 > 1) continue;

      const rho = Math.sqrt(r2);
      const theta = Math.atan2(y, x);
      const opd =
        0.12 * Math.cos(theta) * rho +
        0.08 * Math.sin(2 * theta) * rho * rho +
        0.03 * (6 * Math.pow(rho, 4) - 6 * r2 + 1);

      points.push({ x, y, opd, weight: 1.0 });
    }
  }
  return points;
}

const points = buildPoints(pointGrid);
console.log('▶ Zernike fit benchmark start', {
  pointGrid,
  points: points.length,
  maxOrder,
  rounds
});

const samples = [];
for (let r = 0; r < rounds; r++) {
  const t0 = now();
  const out = fitZernikeWeighted(points, maxOrder, {
    removePiston: false,
    removeTilt: false
  });
  const t1 = now();
  samples.push({
    ms: t1 - t0,
    coeffs: Array.isArray(out?.coefficients) ? out.coefficients.length : 0,
    rms: Number(out?.rms) || 0,
    pv: Number(out?.pv) || 0,
    numPoints: Number(out?.numPoints) || 0
  });
}

const avgMs = samples.reduce((a, b) => a + b.ms, 0) / Math.max(1, samples.length);
const minMs = Math.min(...samples.map(s => s.ms));
const maxMs = Math.max(...samples.map(s => s.ms));

console.log('✅ Zernike fit benchmark summary');
console.log(JSON.stringify({
  pointGrid,
  points: points.length,
  maxOrder,
  rounds,
  avgMs,
  minMs,
  maxMs,
  coeffCount: samples[0]?.coeffs || 0,
  lastRms: samples[samples.length - 1]?.rms || 0,
  lastPv: samples[samples.length - 1]?.pv || 0,
  samples
}, null, 2));
