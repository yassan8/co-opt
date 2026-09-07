import type { CoherentDetectorFieldSample } from './detector-signal.ts';

type Point = { x: number; y: number };
type Field = Map<number, { re: number; im: number }>;
const basis = (x: number, y: number) => [1, x, y, x * x, x * y, y * y];
const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

function convexHull(points: Point[]): Point[] {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Point[] = [], upper: Point[] = [];
  for (const p of sorted) {
    while (lower.length > 1 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length > 1 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function solve(matrix: number[][], rhs: number[]): number[] | null {
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let c = 0; c < rhs.length; c++) {
    let pivot = c;
    for (let r = c + 1; r < rhs.length; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    if (Math.abs(a[pivot][c]) < 1e-10) return null;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    const scale = a[c][c];
    for (let j = c; j <= rhs.length; j++) a[c][j] /= scale;
    for (let r = 0; r < rhs.length; r++) if (r !== c) {
      const factor = a[r][c];
      for (let j = c; j <= rhs.length; j++) a[r][j] -= factor * a[c][j];
    }
  }
  return a.map(row => row[rhs.length]);
}

/**
 * Reconstruct a sampled smooth wavefront BEFORE applying the coherent PSF.
 * Rays are quadrature samples of a field, not isolated point emitters.
 * A verified quadratic OPL carrier removes phase wraps during interpolation;
 * the measured residual complex phase (including BS/source phase) is retained.
 * This is not a Target fit. No configured surface shape is an input.
 * Non-smooth, degenerate or very large footprints return null: the caller must
 * retain the measured samples, not extrapolate a fitted optical wavefront.
 */
export function reconstructCoherentRayField(
  samples: CoherentDetectorFieldSample[], width: number, height: number,
  sourceWidth: number, sourceHeight: number,
): Field | null {
  if (samples.length < 32 || samples.some(s => !Number.isFinite(s.opticalPathLengthMm))) return null;
  const points = samples.map(s => ({ x: (s.pixelX + 0.5) * width / sourceWidth - 0.5, y: (s.pixelY + 0.5) * height / sourceHeight - 0.5 }));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const spanX = maxX - minX, spanY = maxY - minY;
  if (spanX < 2 || spanY < 2) return null;
  const x0 = Math.max(0, Math.ceil(minX)), x1 = Math.min(width - 1, Math.floor(maxX));
  const y0 = Math.max(0, Math.ceil(minY)), y1 = Math.min(height - 1, Math.floor(maxY));
  const roiWidth = x1 - x0 + 1, roiHeight = y1 - y0 + 1;
  if (roiWidth <= 0 || roiHeight <= 0 || roiWidth * roiHeight > 131072) return null;
  const centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
  const at = (p: Point) => basis((p.x - centerX) / spanX, (p.y - centerY) / spanY);
  const baseOpl = samples[0].opticalPathLengthMm!;
  const matrix = Array.from({ length: 6 }, () => new Array(6).fill(0));
  const rhs = new Array(6).fill(0);
  for (let i = 0; i < points.length; i++) {
    const v = at(points[i]), value = samples[i].opticalPathLengthMm! - baseOpl;
    for (let r = 0; r < 6; r++) {
      rhs[r] += v[r] * value;
      for (let c = 0; c < 6; c++) matrix[r][c] += v[r] * v[c];
    }
  }
  const coefficients = solve(matrix, rhs);
  if (!coefficients) return null;
  const carrier = (p: Point) => at(p).reduce((s, v, i) => s + v * coefficients[i], 0);
  const wavelengthMm = samples[0].wavelengthNm * 1e-6;
  const k = 2 * Math.PI / wavelengthMm;
  let referenceResidual: number | undefined;
  // Fail closed when interpolation would bridge unresolved OPD discontinuities.
  for (let i = 0; i < points.length; i++) {
    if (Math.abs(samples[i].opticalPathLengthMm! - baseOpl - carrier(points[i])) > wavelengthMm / 16) return null;
    if (Math.hypot(samples[i].fieldRe, samples[i].fieldIm) > 0) {
      const residual = Math.atan2(samples[i].fieldIm, samples[i].fieldRe) - k * carrier(points[i]);
      referenceResidual ??= residual;
      if (Math.cos(residual - referenceResidual) < Math.SQRT1_2) return null;
    }
  }
  const hull = convexHull(points);
  if (hull.length < 3) return null;
  const left = new Float64Array(roiHeight).fill(Infinity), right = new Float64Array(roiHeight).fill(-Infinity);
  for (let y = y0; y <= y1; y++) {
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      if (y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y) || Math.abs(a.y - b.y) < 1e-12) continue;
      const x = a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y);
      left[y - y0] = Math.min(left[y - y0], x); right[y - y0] = Math.max(right[y - y0], x);
    }
  }
  const area = Math.abs(hull.reduce((s, p, i) => { const q = hull[(i + 1) % hull.length]; return s + p.x * q.y - p.y * q.x; }, 0)) / 2;
  const sigma = Math.max(0.7, Math.sqrt(area / samples.length));
  const radius = Math.ceil(3 * sigma), denominator = 2 * sigma * sigma;
  const intensity = new Float64Array(roiWidth * roiHeight);
  const real = new Float64Array(intensity.length), imag = new Float64Array(intensity.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i], sample = samples[i];
    const amplitude = Math.hypot(sample.fieldRe, sample.fieldIm);
    if (!(amplitude > 0)) continue;
    const phase = k * carrier(p), cs = Math.cos(phase), sn = Math.sin(phase);
    const residualRe = (sample.fieldRe * cs + sample.fieldIm * sn) / amplitude;
    const residualIm = (sample.fieldIm * cs - sample.fieldRe * sn) / amplitude;
    for (let y = Math.max(y0, Math.ceil(p.y - radius)); y <= Math.min(y1, Math.floor(p.y + radius)); y++) {
      const xa = Math.max(x0, Math.ceil(left[y - y0]), Math.ceil(p.x - radius));
      const xb = Math.min(x1, Math.floor(right[y - y0]), Math.floor(p.x + radius));
      for (let x = xa; x <= xb; x++) {
        const index = (y - y0) * roiWidth + x - x0;
        const weight = Math.exp(-((x - p.x) ** 2 + (y - p.y) ** 2) / denominator) * amplitude * amplitude;
        intensity[index] += weight;
        real[index] += weight * residualRe; imag[index] += weight * residualIm;
      }
    }
  }
  const field: Field = new Map();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y - y0) * roiWidth + x - x0, power = intensity[i];
    if (!(power > 0)) continue;
    const phase = k * carrier({ x, y }), cs = Math.cos(phase), sn = Math.sin(phase);
    const norm = Math.sqrt(power);
    field.set(y * width + x, { re: (real[i] * cs - imag[i] * sn) / norm, im: (real[i] * sn + imag[i] * cs) / norm });
  }
  return field;
}
