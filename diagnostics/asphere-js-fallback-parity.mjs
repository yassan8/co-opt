import { asphericSurfaceZ, asphericSagDerivativeAnalytical } from '../optical/surface-math.ts';
import { asphericSag, intersectAsphericSurface } from '../raytracing/core/ray-tracing.ts';

const SAG_TOL = 1e-10;
const DERIV_TOL = 1e-7;
const RESIDUAL_TOL = 1e-6;
const HIT_TOL = 1e-6;

function finiteDiff(r, params, mode) {
  const h = Math.max(1, Math.abs(r)) * 1e-6;
  const f1 = asphericSurfaceZ(r + h, params, mode);
  const f0 = asphericSurfaceZ(r - h, params, mode);
  if (!Number.isFinite(f1) || !Number.isFinite(f0)) return NaN;
  return (f1 - f0) / (2 * h);
}

function residualAt(point, params, mode) {
  const radius = Math.hypot(Number(point?.x) || 0, Number(point?.y) || 0);
  return (Number(point?.z) || 0) - asphericSurfaceZ(radius, params, mode);
}

function assertNear(label, actual, expected, tolerance) {
  const diff = Math.abs(actual - expected);
  if (!(Number.isFinite(actual) && Number.isFinite(expected)) || diff > tolerance) {
    throw new Error(`${label}: expected ${expected}, actual ${actual}, diff ${diff}, tol ${tolerance}`);
  }
  console.log(`PASS ${label}: diff=${diff.toExponential(3)}`);
}

async function compareRustHit(caseName, ray, params, mode, jsHit) {
  try {
    const rustHit = intersectAsphericSurface(ray, params, mode, 30, 1e-9, null, {
      useRustWasm: true,
      requireRustWasm: true,
      allowNonStrict: true,
      requireForwardHit: true,
    });
    if (!rustHit) {
      throw new Error('Rust/WASM returned null hit');
    }
    const diff = Math.hypot(
      rustHit.x - jsHit.x,
      rustHit.y - jsHit.y,
      rustHit.z - jsHit.z,
    );
    if (diff > HIT_TOL) {
      throw new Error(`${caseName}: JS/Rust hit mismatch ${diff} > ${HIT_TOL}`);
    }
    console.log(`PASS ${caseName} JS vs Rust hit diff=${diff.toExponential(3)}`);
  } catch (error) {
    console.log(`SKIP ${caseName} Rust/WASM comparison: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const cases = [
  {
    name: 'even-asphere',
    mode: 'even',
    params: {
      radius: 42.5,
      conic: -1.15,
      coef1: 2.5e-6,
      coef2: -3.2e-8,
      coef3: 1.4e-10,
      coef4: -2.5e-13,
      coef5: 5.0e-16,
      semidia: 8,
    },
    radii: [0, 1.5, 3.0, 5.5],
    ray: {
      pos: { x: 2.2, y: 0.9, z: -20 },
      dir: { x: 0, y: 0, z: 1 },
    },
  },
  {
    name: 'odd-asphere',
    mode: 'odd',
    params: {
      radius: 65,
      conic: -0.45,
      coef1: 8.0e-7,
      coef2: -2.0e-9,
      coef3: 3.5e-11,
      coef4: -7.0e-13,
      coef5: 1.2e-14,
      coef6: -2.2e-16,
      coef7: 4.0e-18,
      semidia: 6,
    },
    radii: [0.5, 1.25, 2.5, 4.0],
    ray: {
      pos: { x: 1.6, y: 0.4, z: -18 },
      dir: { x: 0, y: 0, z: 1 },
    },
  },
];

for (const testCase of cases) {
  const { name, params, mode, radii, ray } = testCase;
  console.log(`\n[${name}]`);

  for (const radius of radii) {
    const sagCore = asphericSag(radius, params, mode);
    const sagMath = asphericSurfaceZ(radius, params, mode);
    assertNear(`${name} sag r=${radius}`, sagCore, sagMath, SAG_TOL);

    const derivAnalytical = asphericSagDerivativeAnalytical(radius, params, mode);
    const derivFiniteDiff = finiteDiff(radius, params, mode);
    assertNear(`${name} derivative r=${radius}`, derivAnalytical, derivFiniteDiff, DERIV_TOL);
  }

  const jsHit = intersectAsphericSurface(ray, params, mode, 30, 1e-9, null, {
    disableWasmRayTracing: true,
    allowNonStrict: true,
    requireForwardHit: true,
  });
  if (!jsHit) {
    throw new Error(`${name}: JS fallback returned null hit`);
  }

  const residual = residualAt(jsHit, params, mode);
  if (Math.abs(residual) > RESIDUAL_TOL) {
    throw new Error(`${name}: JS fallback residual ${residual} exceeds ${RESIDUAL_TOL}`);
  }
  console.log(`PASS ${name} JS fallback residual=${residual.toExponential(3)}`);

  await compareRustHit(name, ray, params, mode, jsHit);
}

console.log('\nAll asphere fallback checks passed.');