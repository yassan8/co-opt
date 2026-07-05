function jacobiRecurrenceCoefficients(n: number, alpha: number, beta: number): [number, number, number] {
  if (n === 0) {
    return [1 + 0.5 * (alpha + beta), 0.5 * (alpha - beta), 1];
  }

  const n1 = n + 1;
  const sum = alpha + beta;
  const aNum = (2 * n + sum + 1) * (2 * n + sum + 2);
  const aDen = 2 * n1 * (n + sum + 1);
  const A = aNum / aDen;
  const B = ((alpha * alpha) - (beta * beta)) * (2 * n + sum + 1) / (2 * n1 * (n + sum + 1) * (2 * n + sum));
  const C = (n + alpha) * (n + beta) * (2 * n + sum + 2) / (n1 * (n + sum + 1) * (2 * n + sum));
  return [A, B, C];
}

function jacobiPolynomial(n: number, alpha: number, beta: number, x: number): number {
  if (n < 0 || !Number.isFinite(x)) return NaN;
  if (n === 0) return 1;

  const p1 = alpha + 1 + (alpha + beta + 2) * ((x - 1) / 2);
  if (n === 1) return p1;

  let pnm2 = 1;
  let pnm1 = p1;
  let pn = p1;

  for (let i = 2; i <= n; i += 1) {
    const [A, B, C] = jacobiRecurrenceCoefficients(i - 1, alpha, beta);
    pn = (A * x + B) * pnm1 - C * pnm2;
    pnm2 = pnm1;
    pnm1 = pn;
  }

  return pn;
}

function jacobiPolynomialWithDerivative(n: number, alpha: number, beta: number, x: number): [number, number] {
  if (n < 0 || !Number.isFinite(x)) return [NaN, NaN];
  if (n === 0) return [1, 0];

  const p1 = alpha + 1 + (alpha + beta + 2) * ((x - 1) / 2);
  const dp1 = 0.5 * (alpha + beta + 2);
  if (n === 1) return [p1, dp1];

  let pnm2 = 1;
  let dpnm2 = 0;
  let pnm1 = p1;
  let dpnm1 = dp1;
  let pn = p1;
  let dpn = dp1;

  for (let i = 2; i <= n; i += 1) {
    const [A, B, C] = jacobiRecurrenceCoefficients(i - 1, alpha, beta);
    const lin = A * x + B;
    pn = lin * pnm1 - C * pnm2;
    dpn = A * pnm1 + lin * dpnm1 - C * dpnm2;
    pnm2 = pnm1;
    dpnm2 = dpnm1;
    pnm1 = pn;
    dpnm1 = dpn;
  }

  return [pn, dpn];
}

export function resolveQconScale(params: any, radiusFallback: number): number {
  const nrad = Number(params?.qconNrad ?? params?.qconNRadius ?? params?.nrad ?? params?.NRAD);
  if (Number.isFinite(nrad) && nrad > 0) return Math.abs(nrad);

  const diameterLike = [
    params?.diameter,
    params?.Diameter,
    params?.aperture,
    params?.Aperture,
  ];
  for (const candidate of diameterLike) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return Math.abs(numeric) / 2;
    if (candidate !== null && candidate !== undefined && String(candidate).trim() !== '') {
      const parsed = Number(String(candidate).trim());
      if (Number.isFinite(parsed) && parsed > 0) return Math.abs(parsed) / 2;
    }
  }

  const candidates = [
    params?.semidia,
    params?.SemiDia,
    params?.semiDia,
    params?.semiDiameter,
    params?.semidiameter,
    params?.['Semi Diameter'],
    params?.['semi diameter'],
    params?.radius,
    radiusFallback,
  ];

  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return Math.abs(numeric);
    if (candidate !== null && candidate !== undefined && String(candidate).trim() !== '') {
      const parsed = Number(String(candidate).trim());
      if (Number.isFinite(parsed) && parsed > 0) return Math.abs(parsed);
    }
  }

  return 1;
}

function resolveQconOffset(params: any): number {
  const offset = Number(params?.qconOffset ?? params?.qcon_offset ?? params?.offset ?? 0);
  return Number.isFinite(offset) ? offset : 0;
}

function getEffectiveQconTermCount(params: any, coefficients: any[]): number {
  const requested = Number(params?.qconTermCount ?? params?.termCount ?? params?.qconTerms ?? 0);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.max(0, Math.min(coefficients.length, Math.trunc(requested)));
  }

  for (let i = coefficients.length - 1; i >= 0; i -= 1) {
    const c = Number(coefficients[i]) || 0;
    if (c !== 0) return i + 1;
  }
  return 0;
}

export function evaluateQconSagDeviation(r: number, params: any, coefficients: any[]): number {
  const rr = Number(r);
  if (!Number.isFinite(rr)) return NaN;

  const scale = resolveQconScale(params, Math.abs(Number(params?.radius) || 0) || Math.abs(rr) || 1);
  if (!Number.isFinite(scale) || scale <= 0) return NaN;

  const u = rr / scale;
  const u2 = u * u;
  const x = 2 * u2 - 1;
  const u4 = u2 * u2;
  let sag = 0;
  const terms = getEffectiveQconTermCount(params, coefficients);
  const offset = resolveQconOffset(params);

  for (let i = 0; i < terms; i += 1) {
    const coefficient = Number(coefficients[i]) || 0;
    if (coefficient === 0) continue;
    sag += coefficient * (u4 * jacobiPolynomial(i, 0, 4, x));
  }

  return sag + offset;
}

export function evaluateQconSagDerivative(r: number, params: any, coefficients: any[]): number {
  const rr = Number(r);
  if (!Number.isFinite(rr)) return NaN;
  if (rr === 0) return 0;

  const scale = resolveQconScale(params, Math.abs(Number(params?.radius) || 0) || Math.abs(rr) || 1);
  if (!Number.isFinite(scale) || scale <= 0) return NaN;

  const u = rr / scale;
  const u2 = u * u;
  const x = 2 * u2 - 1;
  const [base, dBaseDx] = jacobiPolynomialWithDerivative(0, 0, 4, x);
  let derivative = 0;
  const terms = getEffectiveQconTermCount(params, coefficients);

  for (let i = 0; i < terms; i += 1) {
    const coefficient = Number(coefficients[i]) || 0;
    if (coefficient === 0) continue;
    const [pn, dPnDx] = i === 0 ? [base, dBaseDx] : jacobiPolynomialWithDerivative(i, 0, 4, x);
    derivative += coefficient * ((4 * u * u2 * pn) + (4 * u * u2 * u2 * dPnDx)) / scale;
  }

  return derivative;
}

export function evaluateConicBaseSagDerivative(r: number, params: any): number {
  const rr = Number(r);
  if (!Number.isFinite(rr)) return NaN;
  if (rr === 0) return 0;

  const radius = Number(params?.radius);
  if (!Number.isFinite(radius) || radius === 0) return NaN;

  const conic = Number(params?.conic) || 0;
  const absRadius = Math.abs(radius);
  const r2 = rr * rr;
  const discriminant = 1 - ((1 + conic) * r2) / (absRadius * absRadius);
  if (!Number.isFinite(discriminant) || discriminant <= 0) return NaN;

  const sqrtTerm = Math.sqrt(discriminant);
  const derivativeAbs = rr / (absRadius * sqrtTerm);
  return radius > 0 ? derivativeAbs : -derivativeAbs;
}