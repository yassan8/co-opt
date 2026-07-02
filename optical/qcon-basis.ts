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
  const candidates = [
    params?.semidia,
    params?.SemiDia,
    params?.semiDia,
    params?.semiDiameter,
    params?.semidiameter,
    params?.['Semi Diameter'],
    params?.['semi diameter'],
    params?.aperture,
    params?.Aperture,
    params?.diameter,
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

  for (let i = 0; i < coefficients.length; i += 1) {
    const coefficient = Number(coefficients[i]) || 0;
    if (coefficient === 0) continue;
    sag += coefficient * (u4 * jacobiPolynomial(i, 0, 4, x));
  }

  return sag;
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

  for (let i = 0; i < coefficients.length; i += 1) {
    const coefficient = Number(coefficients[i]) || 0;
    if (coefficient === 0) continue;
    const [pn, dPnDx] = i === 0 ? [base, dBaseDx] : jacobiPolynomialWithDerivative(i, 0, 4, x);
    derivative += coefficient * ((4 * u * u2 * pn) + (4 * u * u2 * u2 * dPnDx)) / scale;
  }

  return derivative;
}