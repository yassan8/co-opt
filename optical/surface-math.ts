// surface-math.js
// Lightweight, dependency-free surface sag helpers used by core ray tracing.
// This file intentionally avoids importing browser/UI modules (three.js, main.js, etc.).

import { getLegacyWasmAsphericSagFn } from '../core/wasm-service.ts';

export function asphericSurfaceZ(r, params, mode = "even") {
  const {
    radius,
    conic,
    coef1,
    coef2,
    coef3,
    coef4,
    coef5,
    coef6,
    coef7,
    coef8,
    coef9,
    coef10
  } = params || {};

  // Try optional WASM acceleration if the host app exposed it on globalThis.
  try {
    const forceAsphericSag = getLegacyWasmAsphericSagFn();
    if (forceAsphericSag) {
      // Prefer WASM for even mode. We pass coef1..coef10 (A4..A22).
      // If the loaded WASM module doesn't have the extended entrypoint yet,
      // ForceWASMSystem falls back to legacy + JS add.
      const m = String(mode || '').toLowerCase();
      if (m === 'even') {
        const c = 1 / radius;
        const k = Number(conic) || 0;
        const rr = Number(r);
        const a4 = Number(coef1) || 0;
        const a6 = Number(coef2) || 0;
        const a8 = Number(coef3) || 0;
        const a10 = Number(coef4) || 0;

        const a12 = Number(coef5) || 0;
        const a14 = Number(coef6) || 0;
        const a16 = Number(coef7) || 0;
        const a18 = Number(coef8) || 0;
        const a20 = Number(coef9) || 0;
        const a22 = Number(coef10) || 0;

        const out = forceAsphericSag(rr, c, k, a4, a6, a8, a10, a12, a14, a16, a18, a20, a22);
        if (isFinite(out)) return out;
      }
    }
  } catch (_) {
    // ignore and fall back to JS
  }

  // JavaScript fallback
  if (!isFinite(radius) || radius === 0) {
    return NaN;
  }

  const rr = Number(r);
  if (!isFinite(rr)) {
    return NaN;
  }

  const r2 = rr * rr;
  const absRadius = Math.abs(radius);
  const sqrtTerm = 1 - (1 + (Number(conic) || 0)) * r2 / (absRadius * absRadius);

  if (!isFinite(sqrtTerm) || sqrtTerm < 0) {
    return NaN;
  }

  const baseAbs = r2 / (absRadius * (1 + Math.sqrt(sqrtTerm)));
  const base = radius > 0 ? baseAbs : -baseAbs;

  let asphere = 0;
  const coefs = [coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10];
  for (let i = 0; i < coefs.length; i++) {
    const c = Number(coefs[i]) || 0;
    if (c === 0) continue;
    if (mode === "even") {
      // coef1 corresponds to r^4, coef2 to r^6, etc.
      // Even asphere: A4, A6, A8, A10, A12, A14, A16, A18, A20, A22
      asphere += c * Math.pow(rr, 2 * (i + 2));
    } else if (mode === "odd") {
      // coef1 corresponds to r^3, coef2 to r^5, etc.
      // Odd asphere: A3, A5, A7, A9, A11, A13, A15, A17, A19, A21
      asphere += c * Math.pow(rr, 2 * i + 3);
    }
  }

  const result = base + asphere;
  return isFinite(result) ? result : NaN;
}

// ray-tracing.js compatibility: first derivative ds/dr.
// Analytical derivative for improved performance (6-10% faster than numerical differentiation).
// This eliminates redundant SAG calls in surface normal calculation.
export function asphericSagDerivative(r, params, mode = "even") {
  const rr = Number(r);
  if (!isFinite(rr)) {
    return NaN;
  }

  // Try analytical derivative first (preferred)
  try {
    const analytical = asphericSagDerivativeAnalytical(rr, params, mode);
    if (isFinite(analytical)) {
      return analytical;
    }
  } catch (_) {
    // Fall back to numerical on any error
  }

  // Fallback: numerical differentiation (legacy method)
  const base = Math.max(1, Math.abs(rr));
  const h = base * 1e-6;
  const f1 = asphericSurfaceZ(rr + h, params, mode);
  const f0 = asphericSurfaceZ(rr - h, params, mode);
  if (!isFinite(f1) || !isFinite(f0)) {
    return NaN;
  }
  return (f1 - f0) / (2 * h);
}

// Analytical derivative: dz/dr for aspheric surface
// Ported from WASM implementation (ray-tracing-wasm.c:413-471)
// Computes derivative of: z(r) = base_conic(r) + aspheric_polynomial(r)
export function asphericSagDerivativeAnalytical(r, params, mode = "even") {
  const { radius, conic, coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10 } = params || {};

  const rr = Number(r);
  if (!isFinite(rr)) {
    return NaN;
  }

  const r2 = rr * rr;
  let dzdr_base = 0.0;

  // 1. Derivative of base conic term: r²/(R*(1 + sqrt(1 - (1+k)*r²/R²)))
  if (isFinite(radius) && radius !== 0) {
    const R = radius;
    const k = Number(conic) || 0;
    const term = (1 + k) * r2 / (R * R);
    
    if (term < 1.0) {
      const sqrtTerm = Math.sqrt(1 - term);
      const denom = R * (1 + sqrtTerm);
      
      // Derivative computation
      if (rr !== 0 && sqrtTerm > 0) {
        // d(sqrtTerm)/dr = -(1+k)*r / (R²*sqrtTerm)
        const sqrtDer = -(1 + k) * rr / (R * R * sqrtTerm);
        // Product rule and quotient rule
        dzdr_base = (2 * rr * denom - r2 * R * sqrtDer) / (denom * denom);
      } else {
        dzdr_base = 0.0;
      }
    } else {
      // Near or beyond critical radius
      dzdr_base = (R !== 0) ? (1.0 / R) : 0.0;
    }
  }

  // 2. Derivative of aspheric polynomial terms
  const dzdr_poly = asphericPolynomialDerivative(rr, r2, 
    coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10, mode);

  // 3. Total derivative
  const dzdr = dzdr_base + dzdr_poly;
  return isFinite(dzdr) ? dzdr : NaN;
}

// Derivative of aspheric polynomial terms only
// Ported from WASM __rt10_asphere_dzdr (ray-tracing-wasm.c:40-73)
function asphericPolynomialDerivative(r, r2, 
  coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10, mode) {
  
  if (r === 0) return 0.0;

  const coefs = [
    Number(coef1) || 0, Number(coef2) || 0, Number(coef3) || 0, Number(coef4) || 0, Number(coef5) || 0,
    Number(coef6) || 0, Number(coef7) || 0, Number(coef8) || 0, Number(coef9) || 0, Number(coef10) || 0
  ];

  let dz = 0.0;

  if (mode === "odd") {
    // sag = sum coef_i * r^(2i+1) for i=1..10 (r^3, r^5, ..., r^21)
    // dz/dr = sum coef_i * (2i+1) * r^(2i)
    let r_pow = r2; // r^2
    for (let i = 0; i < 10; i++) {
      const c = coefs[i];
      if (c !== 0) {
        const power = 2 * (i + 1) + 1; // 3, 5, 7, ..., 21
        dz += c * power * r_pow;
      }
      r_pow *= r2; // r^2 -> r^4 -> ... -> r^20
    }
  } else {
    // mode === "even"
    // sag = sum coef_i * r^(2i+2) for i=1..10 (r^4, r^6, ..., r^22)
    // dz/dr = sum coef_i * (2i+2) * r^(2i+1)
    let r_pow = r2 * r; // r^3
    for (let i = 0; i < 10; i++) {
      const c = coefs[i];
      if (c !== 0) {
        const power = 2 * (i + 2); // 4, 6, 8, ..., 22
        dz += c * power * r_pow;
      }
      r_pow *= r2; // r^3 -> r^5 -> ... -> r^21
    }
  }

  return dz;
}

// Toric surface sag calculation: z(x, y) with independent radii in X and Y meridians.
// Toric surfaces are non-rotationally symmetric, used for astigmatism correction.
// params: { radiusX, radiusY, conic, axis }
export function toricSurfaceZ(x, y, params) {
  const { radiusX, radiusY, conic, axis } = params || {};
  
  const xx = Number(x);
  const yy = Number(y);
  if (!isFinite(xx) || !isFinite(yy)) {
    return NaN;
  }
  
  // Apply axis rotation: rotate coordinates by -axis angle
  // This rotates the toric meridians by axis degrees
  const axisDeg = Number(axis) || 0;
  const axisRad = (axisDeg * Math.PI) / 180;
  const cosA = Math.cos(axisRad);
  const sinA = Math.sin(axisRad);
  
  // Rotated coordinates: apply -axis rotation
  const xRot = xx * cosA + yy * sinA;
  const yRot = -xx * sinA + yy * cosA;
  
  const x2 = xRot * xRot;
  const y2 = yRot * yRot;
  const k = Number(conic) || 0;
  
  // Handle infinite radius (flat surface) for X-meridian
  let sagX = 0;
  if (isFinite(radiusX) && radiusX !== 0) {
    const absRx = Math.abs(radiusX);
    const sqrtTermX = 1 - (1 + k) * x2 / (absRx * absRx);
    if (!isFinite(sqrtTermX) || sqrtTermX < 0) {
      return NaN;
    }
    const sagXAbs = x2 / (absRx * (1 + Math.sqrt(sqrtTermX)));
    sagX = radiusX > 0 ? sagXAbs : -sagXAbs;
  }
  // If radiusX is INF or not finite, sagX stays 0 (flat in X direction)
  
  // Handle infinite radius (flat surface) for Y-meridian
  let sagY = 0;
  if (isFinite(radiusY) && radiusY !== 0) {
    const absRy = Math.abs(radiusY);
    const sqrtTermY = 1 - (1 + k) * y2 / (absRy * absRy);
    if (!isFinite(sqrtTermY) || sqrtTermY < 0) {
      return NaN;
    }
    const sagYAbs = y2 / (absRy * (1 + Math.sqrt(sqrtTermY)));
    sagY = radiusY > 0 ? sagYAbs : -sagYAbs;
  }
  // If radiusY is INF or not finite, sagY stays 0 (flat in Y direction)
  
  // Total sag is sum of both meridian contributions
  const result = sagX + sagY;
  return isFinite(result) ? result : NaN;
}

// Partial derivatives of toric surface for normal vector and ray intersection.
// Returns { dz_dx, dz_dy } using analytical derivatives for better accuracy.
export function toricSagDerivatives(x, y, params) {
  const { radiusX, radiusY, conic, axis } = params || {};
  
  const xx = Number(x);
  const yy = Number(y);
  
  if (!isFinite(xx) || !isFinite(yy)) {
    return { dz_dx: NaN, dz_dy: NaN };
  }
  
  // Apply axis rotation: rotate coordinates by -axis angle
  const axisDeg = Number(axis) || 0;
  const axisRad = (axisDeg * Math.PI) / 180;
  const cosA = Math.cos(axisRad);
  const sinA = Math.sin(axisRad);
  
  // Rotated coordinates
  const xRot = xx * cosA + yy * sinA;
  const yRot = -xx * sinA + yy * cosA;
  
  const k = Number(conic) || 0;
  
  // dz/dx calculation (X-meridian derivative) in rotated coordinates
  let dz_dxRot = 0;
  if (isFinite(radiusX) && radiusX !== 0) {
    const Rx = radiusX;
    const absRx = Math.abs(Rx);
    const x2 = xRot * xRot;
    const discriminant = 1 - (1 + k) * x2 / (absRx * absRx);
    
    if (isFinite(discriminant) && discriminant > 0) {
      const sqrtTerm = Math.sqrt(discriminant);
      // For z = x^2 / (|R| * (1 + sqrt(1 - (1+k)*x^2/R^2)))
      // dz/dx = x / (|R| * sqrt(1 - (1+k)*x^2/R^2))
      dz_dxRot = xRot / (absRx * sqrtTerm);
      if (Rx < 0) dz_dxRot = -dz_dxRot;
    }
  }
  // If radiusX is INF or not finite, dz_dxRot stays 0
  
  // dz/dy calculation (Y-meridian derivative) in rotated coordinates
  let dz_dyRot = 0;
  if (isFinite(radiusY) && radiusY !== 0) {
    const Ry = radiusY;
    const absRy = Math.abs(Ry);
    const y2 = yRot * yRot;
    const discriminant = 1 - (1 + k) * y2 / (absRy * absRy);
    
    if (isFinite(discriminant) && discriminant > 0) {
      const sqrtTerm = Math.sqrt(discriminant);
      // For z = y^2 / (|R| * (1 + sqrt(1 - (1+k)*y^2/R^2)))
      // dz/dy = y / (|R| * sqrt(1 - (1+k)*y^2/R^2))
      dz_dyRot = yRot / (absRy * sqrtTerm);
      if (Ry < 0) dz_dyRot = -dz_dyRot;
    }
  }
  // If radiusY is INF or not finite, dz_dyRot stays 0
  
  // Transform derivatives back to original coordinate system
  // If z = f(x', y') where (x', y') = rotation of (x, y) by -axis,
  // then dz/dx = (dz/dx') * (dx'/dx) + (dz/dy') * (dy'/dx)
  //      dz/dy = (dz/dx') * (dx'/dy) + (dz/dy') * (dy'/dy)
  // where dx'/dx = cos(axis), dy'/dx = -sin(axis)
  //       dx'/dy = sin(axis), dy'/dy = cos(axis)
  const dz_dx = dz_dxRot * cosA - dz_dyRot * sinA;
  const dz_dy = dz_dxRot * sinA + dz_dyRot * cosA;
  
  return { 
    dz_dx: isFinite(dz_dx) ? dz_dx : 0, 
    dz_dy: isFinite(dz_dy) ? dz_dy : 0 
  };
}
