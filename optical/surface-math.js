// surface-math.js
// Lightweight, dependency-free surface sag helpers used by core ray tracing.
// This file intentionally avoids importing browser/UI modules (three.js, main.js, etc.).

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
  // (In the browser build, main.js sets window.getWASMSystem = getWASMSystem.)
  try {
    const getWASMSystem = (typeof globalThis !== 'undefined') ? globalThis.getWASMSystem : null;
    if (typeof getWASMSystem === 'function') {
      const wasmSystem = getWASMSystem();
      if (wasmSystem && wasmSystem.isWASMReady && typeof wasmSystem.forceAsphericSag === 'function') {
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

          const out = wasmSystem.forceAsphericSag(rr, c, k, a4, a6, a8, a10, a12, a14, a16, a18, a20, a22);
          if (isFinite(out)) return out;
        }
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
      // coef1 corresponds to r^4.
      asphere += c * Math.pow(rr, 2 * (i + 2));
    } else if (mode === "odd") {
      // coef1 corresponds to r^5.
      asphere += c * Math.pow(rr, 2 * (i + 2) + 1);
    }
  }

  const result = base + asphere;
  return isFinite(result) ? result : NaN;
}

// ray-tracing.js compatibility: first derivative ds/dr.
// We use robust numerical differentiation (the same approach as surface.js).
export function asphericSagDerivative(r, params, mode = "even") {
  const rr = Number(r);
  if (!isFinite(rr)) {
    return NaN;
  }
  const base = Math.max(1, Math.abs(rr));
  const h = base * 1e-6;
  const f1 = asphericSurfaceZ(rr + h, params, mode);
  const f0 = asphericSurfaceZ(rr - h, params, mode);
  if (!isFinite(f1) || !isFinite(f0)) {
    return NaN;
  }
  return (f1 - f0) / (2 * h);
}
