if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;

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
  const value = args[idx + 1];
  if (value === undefined || String(value).startsWith('--')) return 'true';
  return String(value);
};

const toNum = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const loadDefaultData = async () => {
  const fileRel = getArg('input', 'Examples/default-load.json');
  const fileAbs = path.resolve(projectRoot, fileRel);
  const data = JSON.parse(await fs.readFile(fileAbs, 'utf8'));
  return { fileRel, data };
};

const jToNM = (j) => {
  const n = Math.floor((-1 + Math.sqrt(1 + 8 * j)) / 2);
  const j0 = n * (n + 1) / 2;
  const offset = j - j0;
  return { n, m: -n + 2 * offset };
};

const factorialCache = [1];
const factorial = (n) => {
  if (n <= 1) return 1;
  if (factorialCache[n]) return factorialCache[n];
  for (let i = factorialCache.length; i <= n; i++) factorialCache[i] = factorialCache[i - 1] * i;
  return factorialCache[n];
};

const zernikeRadial = (n, mAbs, rho) => {
  if ((n - mAbs) % 2 !== 0 || mAbs > n) return 0;
  let radial = 0;
  for (let k = 0; k <= (n - mAbs) / 2; k++) {
    const sign = k % 2 === 0 ? 1 : -1;
    const coeff = sign * factorial(n - k)
      / (factorial(k) * factorial((n + mAbs) / 2 - k) * factorial((n - mAbs) / 2 - k));
    radial += coeff * Math.pow(rho, n - 2 * k);
  }
  return radial;
};

const zernikePolynomial = (n, m, rho, theta) => {
  if (!(rho >= 0 && rho <= 1)) return 0;
  const radial = zernikeRadial(n, Math.abs(m), rho);
  const norm = Math.sqrt(2 * (n + 1) / (1 + (m === 0 ? 1 : 0)));
  return m >= 0
    ? norm * radial * Math.cos(m * theta)
    : norm * radial * Math.sin(Math.abs(m) * theta);
};

const solveWeightedLeastSquares = (A, b, weights) => {
  const m = A.length;
  const n = A[0]?.length || 0;
  const ATWA = new Float64Array(n * n);
  const ATWb = new Float64Array(n);

  for (let k = 0; k < m; k++) {
    const row = A[k];
    const wk = Number(weights[k]) || 0;
    const bk = Number(b[k]) || 0;
    if (!Number.isFinite(wk) || wk === 0) continue;
    for (let i = 0; i < n; i++) {
      const ai = Number(row[i]) || 0;
      if (!Number.isFinite(ai) || ai === 0) continue;
      const wai = wk * ai;
      ATWb[i] += wai * bk;
      const iBase = i * n;
      for (let j = 0; j <= i; j++) {
        const aj = Number(row[j]) || 0;
        if (!Number.isFinite(aj) || aj === 0) continue;
        ATWA[iBase + j] += wai * aj;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      ATWA[i * n + j] = ATWA[j * n + i];
    }
  }

  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i * n + k] * L[j * n + k];
      if (i === j) {
        L[i * n + j] = Math.sqrt(Math.max(0, ATWA[i * n + i] - sum));
      } else if (L[j * n + j] !== 0) {
        L[i * n + j] = (ATWA[i * n + j] - sum) / L[j * n + j];
      }
    }
  }

  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < i; j++) sum += L[i * n + j] * y[j];
    y[i] = L[i * n + i] !== 0 ? (ATWb[i] - sum) / L[i * n + i] : 0;
  }

  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let j = i + 1; j < n; j++) sum += L[j * n + i] * x[j];
    x[i] = L[i * n + i] !== 0 ? (y[i] - sum) / L[i * n + i] : 0;
  }
  return Array.from(x);
};

const medianFinite = (values) => {
  const finite = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!finite.length) return NaN;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 0 ? (finite[mid - 1] + finite[mid]) / 2 : finite[mid];
};

const fitRustParity = (points, requestedMaxOrder = 8) => {
  let validPoints = points
    .filter((pt) => Number.isFinite(pt?.x) && Number.isFinite(pt?.y) && Number.isFinite(pt?.opd))
    .map((pt) => ({ x: Number(pt.x), y: Number(pt.y), opd: Number(pt.opd) }))
    .filter((pt) => Math.hypot(pt.x, pt.y) <= 1 + 1e-9);

  if (validPoints.length < 6) return null;

  const opdMean = validPoints.reduce((sum, pt) => sum + pt.opd, 0) / validPoints.length;
  validPoints = validPoints.map((pt) => ({ ...pt, opd: pt.opd - opdMean }));

  let opdMin = Infinity;
  let opdMax = -Infinity;
  for (const pt of validPoints) {
    if (pt.opd < opdMin) opdMin = pt.opd;
    if (pt.opd > opdMax) opdMax = pt.opd;
  }
  const scaleFactor = Math.max(1, opdMax - opdMin);
  validPoints = validPoints.map((pt) => ({ ...pt, opd: pt.opd / scaleFactor }));

  let sumX2 = 0;
  let sumY2 = 0;
  let sumXY = 0;
  let sumOpdX = 0;
  let sumOpdY = 0;
  for (const pt of validPoints) {
    sumX2 += pt.x * pt.x;
    sumY2 += pt.y * pt.y;
    sumXY += pt.x * pt.y;
    sumOpdX += pt.opd * pt.x;
    sumOpdY += pt.opd * pt.y;
  }

  let tiltYScaled = 0;
  let tiltXScaled = 0;
  const det = sumX2 * sumY2 - sumXY * sumXY;
  if (Math.abs(det) > 1e-10) {
    const twoC2 = (sumOpdX * sumY2 - sumOpdY * sumXY) / det;
    const twoC1 = (sumX2 * sumOpdY - sumXY * sumOpdX) / det;
    tiltYScaled = twoC1 / 2;
    tiltXScaled = twoC2 / 2;
  }

  validPoints = validPoints.map((pt) => ({
    ...pt,
    opd: pt.opd - tiltYScaled * 2 * pt.y - tiltXScaled * 2 * pt.x
  }));

  let filteredPoints = validPoints;
  if (validPoints.length >= 20) {
    const med = medianFinite(validPoints.map((pt) => pt.opd));
    const mad = medianFinite(validPoints.map((pt) => Math.abs(pt.opd - med)));
    const robustSigma = Number.isFinite(mad) ? 1.4826 * mad : NaN;
    const threshold = Number.isFinite(robustSigma) && robustSigma > 0 ? 6 * robustSigma : NaN;
    if (Number.isFinite(threshold) && threshold > 0) {
      const candidate = validPoints.filter((pt) => Math.abs(pt.opd - med) <= threshold);
      if (candidate.length >= 10) filteredPoints = candidate;
    }
  }

  const maxOrderFromPoints = Math.floor(Math.sqrt(filteredPoints.length / 3));
  const maxOrderForFit = Math.min(8, requestedMaxOrder, Math.max(1, maxOrderFromPoints));
  const numTerms = (maxOrderForFit + 1) * (maxOrderForFit + 2) / 2;

  if (numTerms <= 3) {
    const coeffs = new Array(Math.max(3, numTerms)).fill(0);
    coeffs[0] = opdMean;
    coeffs[1] = tiltYScaled * scaleFactor;
    coeffs[2] = tiltXScaled * scaleFactor;
    return coeffs;
  }

  const A = [];
  const b = [];
  const weights = [];
  for (const pt of filteredPoints) {
    const rho = Math.hypot(pt.x, pt.y);
    const theta = Math.atan2(pt.y, pt.x);
    const row = [];
    for (let j = 3; j < numTerms; j++) {
      const { n, m } = jToNM(j);
      row.push(zernikePolynomial(n, m, rho, theta));
    }
    A.push(row);
    b.push(pt.opd);
    weights.push(1);
  }

  const solved = solveWeightedLeastSquares(A, b, weights);
  const coeffs = new Array(Math.max(3, numTerms)).fill(0);
  coeffs[0] = opdMean;
  coeffs[1] = tiltYScaled * scaleFactor;
  coeffs[2] = tiltXScaled * scaleFactor;
  for (let i = 0; i < solved.length; i++) coeffs[i + 3] = solved[i] * scaleFactor;
  return coeffs;
};

const main = async () => {
  const [{ createOPDCalculator, WavefrontAberrationAnalyzer }, { fileRel, data }] = await Promise.all([
    import('../evaluation/wavefront/wavefront.ts'),
    loadDefaultData()
  ]);

  const outRel = getArg('out', path.join('diagnostics/results', `zernike-optimizer-parity-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const outAbs = path.resolve(projectRoot, outRel);
  const objectIndex1 = Math.max(1, Math.floor(toNum(getArg('object', '1'), 1)));
  const sampling = Math.max(8, Math.floor(toNum(getArg('sampling', '32'), 32)));
  const maxIndex = Math.max(4, Math.floor(toNum(getArg('max-index', '37'), 37)));
  const failMaxDiff = toNum(getArg('fail-max-diff-waves', '0.002'), 0.002);
  const failRmsDiff = toNum(getArg('fail-rms-diff-waves', '0.001'), 0.001);

  const opticalSystemRows = Array.isArray(data?.opticalSystem) ? data.opticalSystem : [];
  const sourceRows = Array.isArray(data?.source) ? data.source : [];
  const objectRows = Array.isArray(data?.object) ? data.object : [];
  const wavelengthUm = Number(sourceRows.find((row) => String(row?.primary || '').includes('Primary'))?.wavelength) || 0.5875618;

  const isInfinite = String(opticalSystemRows?.[0]?.thickness ?? '').trim().toUpperCase() === 'INF';
  const objectRow = objectRows[objectIndex1 - 1] || objectRows[0] || {};
  const fieldX = Number(objectRow?.xHeightAngle ?? objectRow?.xFieldAngle ?? objectRow?.xHeight ?? objectRow?.x ?? objectRow?.angleX ?? objectRow?.Hx ?? 0) || 0;
  const fieldY = Number(objectRow?.yHeightAngle ?? objectRow?.yFieldAngle ?? objectRow?.fieldAngle ?? objectRow?.yHeight ?? objectRow?.y ?? objectRow?.angleY ?? objectRow?.Hy ?? 0) || 0;
  const fieldSetting = isInfinite
    ? { type: 'Angle', position: 'Angle', x: fieldX, y: fieldY, fieldAngle: { x: fieldX, y: fieldY } }
    : { type: 'Rectangle', position: 'Rectangle', x: fieldX, y: fieldY, fieldX, fieldY };

  const calc = createOPDCalculator(opticalSystemRows, wavelengthUm);
  const analyzer = new WavefrontAberrationAnalyzer(calc);
  const points = [];
  for (let iy = 0; iy < sampling; iy++) {
    const y = 2 * (iy / (sampling - 1)) - 1;
    for (let ix = 0; ix < sampling; ix++) {
      const x = 2 * (ix / (sampling - 1)) - 1;
      if (Math.hypot(x, y) > 1) continue;
      const opd = calc.calculateOPD(x, y, fieldSetting);
      if (Number.isFinite(opd)) points.push({ x, y, opd });
    }
  }

  const fitTs = analyzer.fitZernikePolynomials({
    pupilCoordinates: points.map((pt) => ({ x: pt.x, y: pt.y })),
    opds: points.map((pt) => pt.opd),
    pupilRange: 1
  }, 8);
  const fitRust = fitRustParity(points, 8);

  const perIndex = [];
  let maxAbsDiffWaves = 0;
  let sumSqHighOrder = 0;
  let highOrderCount = 0;
  for (let index = 0; index <= maxIndex; index++) {
    const ts = Number(fitTs?.coefficientsMicrons?.[index] ?? 0) / wavelengthUm;
    const rust = Number(fitRust?.[index] ?? 0) / wavelengthUm;
    const absDiffWaves = Math.abs(ts - rust);
    if (absDiffWaves > maxAbsDiffWaves) maxAbsDiffWaves = absDiffWaves;
    if (index >= 4) {
      sumSqHighOrder += absDiffWaves * absDiffWaves;
      highOrderCount += 1;
    }
    perIndex.push({ index, tsWaves: ts, rustParityWaves: rust, absDiffWaves });
  }

  const rmsHighOrderDiffWaves = highOrderCount > 0 ? Math.sqrt(sumSqHighOrder / highOrderCount) : 0;
  const summary = {
    input: fileRel,
    objectIndex1,
    sampling,
    wavelengthUm,
    samplePoints: points.length,
    fieldSetting,
    maxAbsDiffWaves,
    rmsHighOrderDiffWaves,
    pass: maxAbsDiffWaves <= failMaxDiff && rmsHighOrderDiffWaves <= failRmsDiff,
    thresholds: {
      failMaxDiffWaves: failMaxDiff,
      failRmsDiffWaves: failRmsDiff
    },
    perIndex
  };

  await fs.mkdir(path.dirname(outAbs), { recursive: true });
  await fs.writeFile(outAbs, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log('✅ Zernike optimizer parity summary');
  console.log(JSON.stringify({
    output: path.relative(projectRoot, outAbs),
    pass: summary.pass,
    maxAbsDiffWaves,
    rmsHighOrderDiffWaves
  }, null, 2));

  if (!summary.pass) process.exitCode = 2;
};

await main();