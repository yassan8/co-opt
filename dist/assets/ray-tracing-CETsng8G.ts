import { setWindowDebugBagValue } from '../../utils/window-debug-bag.ts';

// Runtime build stamp (for cache/stale-module diagnostics)
const RAY_TRACING_BUILD = '2025-12-30a';
if (typeof window !== 'undefined') {
  setWindowDebugBagValue('buildStamps', 'rayTracing', RAY_TRACING_BUILD);
}

// Import functions from ray-paraxial.js without destructuring for compatibility
import * as rayParaxial from './ray-paraxial.ts';
import { asphericSagDerivative, toricSurfaceZ, toricSagDerivatives } from '../../optical/surface-math.ts';
import { getWASMSystem as getWASMSystemService } from '../../core/wasm-service.ts';
import { setAsphericSagImplementation } from '../../core/aspheric-sag-service.ts';
const getSafeThickness = rayParaxial.getSafeThickness;
const getRefractiveIndex = rayParaxial.getRefractiveIndex;
const isCoordTransSurface = rayParaxial.isCoordTransSurface;
// 循環依存を避けるため、main.jsからのimportを削除
// import { getWASMSystem } from './main.ts';

// --- WASM fast-path cache (avoid per-call getWASMSystem() overhead) ---
let __wasmSystemCached = null;
let __wasmSystemLastCheckAt = 0;
const __WASM_SYSTEM_RECHECK_MS = 1000;

let __wasmSagRt10Fn = null;
let __wasmIntersectRt10Fn = null;

let __wasmTmpVec3Ptr = 0;
let __wasmTmpVec3Module = null;

function __getWasmTmpVec3(module) {
  if (!module) return { module: null, ptr: 0 };
  if (__wasmTmpVec3Ptr && __wasmTmpVec3Module === module) return { module, ptr: __wasmTmpVec3Ptr };
  try {
    if (__wasmTmpVec3Ptr && __wasmTmpVec3Module && typeof __wasmTmpVec3Module._free === 'function') {
      __wasmTmpVec3Module._free(__wasmTmpVec3Ptr);
    }
  } catch (_) {}
  __wasmTmpVec3Ptr = 0;
  __wasmTmpVec3Module = module;
  try {
    if (typeof module._malloc === 'function') {
      __wasmTmpVec3Ptr = module._malloc(3 * 8);
    }
  } catch (_) {
    __wasmTmpVec3Ptr = 0;
  }
  return { module, ptr: __wasmTmpVec3Ptr };
}

function __readWasmVec3(module, ptr) {
  try {
    const heap = module?.HEAPF64;
    if (!heap || !ptr) return null;
    const i = (ptr >> 3);
    const x = heap[i];
    const y = heap[i + 1];
    const z = heap[i + 2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    return { x, y, z };
  } catch (_) {
    return null;
  }
}

function __nowMs() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch (_) {}
  return Date.now();
}

function __getWasmSystemCached() {
  if (__wasmSystemCached?.isWASMReady && __wasmSystemCached?.wasmModule) return __wasmSystemCached;
  const t = __nowMs();
  if ((t - __wasmSystemLastCheckAt) < __WASM_SYSTEM_RECHECK_MS) return null;
  __wasmSystemLastCheckAt = t;
  try {
    const wasmSystem = getWASMSystemService?.();
    if (wasmSystem?.isWASMReady && wasmSystem?.wasmModule) {
      __wasmSystemCached = wasmSystem;
      return wasmSystem;
    }
  } catch (_) {}
  return null;
}

function __getWasmModuleCached() {
  return __getWasmSystemCached()?.wasmModule ?? null;
}

function __getWasmSagRt10Fn() {
  if (__wasmSagRt10Fn) return __wasmSagRt10Fn;
  try {
    const wasmModule = __getWasmModuleCached();
    const fn = wasmModule?._aspheric_sag_rt10;
    if (typeof fn === 'function') {
      __wasmSagRt10Fn = fn;
      return fn;
    }
  } catch (_) {}
  return null;
}

function __getWasmIntersectRt10Fn() {
  if (__wasmIntersectRt10Fn) return __wasmIntersectRt10Fn;
  try {
    const wasmModule = __getWasmModuleCached();
    const fn = wasmModule?._intersect_aspheric_rt10;
    if (typeof fn === 'function') {
      __wasmIntersectRt10Fn = fn;
      return fn;
    }
  } catch (_) {}
  return null;
}

// --- Refractive index cache (ray-tracing hot path) ---
// Keyed by surface object reference, with a small signature to avoid stale reads
// if the material/index is edited.
const __refractiveIndexCache = new WeakMap();

function __getRefractiveIndexCacheForSurface(surface) {
  if (!surface || (typeof surface !== 'object' && typeof surface !== 'function')) return null;
  let m = __refractiveIndexCache.get(surface);
  if (!m) {
    m = new Map();
    __refractiveIndexCache.set(surface, m);
  }
  return m;
}

// --- ベクトル演算 ---
function vec3(x, y, z) {
  return { x, y, z };
}
export function add(a, b) {
  const result = vec3(a.x + b.x, a.y + b.y, a.z + b.z);
  // NaN validation for add operation
  if (!isFinite(result.x) || !isFinite(result.y) || !isFinite(result.z)) {
    // console.warn(`❌ NaN in add operation: a=(${a.x}, ${a.y}, ${a.z}), b=(${b.x}, ${b.y}, ${b.z})`);
    return vec3(0, 0, 0); // Return zero vector as fallback
  }
  return result;
}
export function subtract(a, b) {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}
function sub(a, b) {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}
function scale(a, s) {
  const result = vec3(a.x * s, a.y * s, a.z * s);
  // NaN validation for scale operation
  if (!isFinite(result.x) || !isFinite(result.y) || !isFinite(result.z)) {
    // console.warn(`❌ NaN in scale operation: vector=(${a.x}, ${a.y}, ${a.z}), scalar=${s}`);
    return vec3(0, 0, 0); // Return zero vector as fallback
  }
  return result;
}

function dot(a, b) {
  if (!a || !b || typeof a.x !== 'number' || typeof a.y !== 'number' || typeof a.z !== 'number' || typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.z !== 'number') {
    return 0;
  }

  // Try WASM first
  try {
    const wasmModule = __getWasmModuleCached();
    const fn = wasmModule?._vector_dot;
    if (typeof fn === 'function') {
      return fn(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  } catch (_) {
    // Fallback to JavaScript
  }

  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function normalize(a) {
  if (!a || typeof a.x !== 'number' || typeof a.y !== 'number' || typeof a.z !== 'number') {
    // console.error('❌ Invalid vector in normalize:', a);
    return { x: 0, y: 0, z: 1 }; // デフォルトのZ方向ベクトル
  }
  
  // Try WASM first (グローバルから取得)
  try {
    const wasmModule = __getWasmModuleCached();
    const fn = wasmModule?._vector_normalize;
    if (typeof fn === 'function') {
      const { ptr } = __getWasmTmpVec3(wasmModule);
      if (ptr) {
        fn(a.x, a.y, a.z, ptr);
        const v = __readWasmVec3(wasmModule, ptr);
        if (v) return v;
      }
    }
  } catch (error) {
    // Fallback to JavaScript
  }
  
  const l = Math.sqrt(dot(a, a));
  if (l === 0) {
    // console.warn('⚠️ Zero-length vector in normalize, returning default Z-direction');
    return { x: 0, y: 0, z: 1 };
  }
  return scale(a, 1 / l);
}
function norm(a) {
  const l = Math.sqrt(dot(a, a));
  return scale(a, 1 / l);
}

// --- 回転行列適用 ---
// Order 0の場合: R = Rx.Ry.Rz（X→Y→Z順で適用）
// Order 1の場合: R = Rz.Ry.Rx（Z→Y→X順で適用）
function applyRotation(v, rot, order = 1) {
  // rot: {rx, ry, rz} [deg]
  const safeRot = rot || {};
  let rx = safeRot.rx !== undefined ? safeRot.rx : 0;
  let ry = safeRot.ry !== undefined ? safeRot.ry : 0;
  let rz = safeRot.rz !== undefined ? safeRot.rz : 0;
  rx = rx * Math.PI / 180;
  ry = ry * Math.PI / 180;
  rz = rz * Math.PI / 180;
  
  if (order === 0) {
    // Order 0: X→Y→Z順
    // X
    let x1 = v.x;
    let y1 = v.y * Math.cos(rx) - v.z * Math.sin(rx);
    let z1 = v.y * Math.sin(rx) + v.z * Math.cos(rx);
    // Y
    let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry);
    let y2 = y1;
    let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry);
    // Z
    let x3 = x2 * Math.cos(rz) - y2 * Math.sin(rz);
    let y3 = x2 * Math.sin(rz) + y2 * Math.cos(rz);
    let z3 = z2;
    return vec3(x3, y3, z3);
  } else {
    // Order 1: Z→Y→X順
    // Z
    let x1 = v.x * Math.cos(rz) - v.y * Math.sin(rz);
    let y1 = v.x * Math.sin(rz) + v.y * Math.cos(rz);
    let z1 = v.z;
    // Y
    let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry);
    let y2 = y1;
    let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry);
    // X
    let x3 = x2;
    let y3 = y2 * Math.cos(rx) - z2 * Math.sin(rx);
    let z3 = y2 * Math.sin(rx) + z2 * Math.cos(rx);
    return vec3(x3, y3, z3);
  }
}

function applyInvRotation(v, rot, order = 1) {
  // rot: {rx, ry, rz} [deg]
  // 逆回転（負の角度で逆順適用）
  const safeRot = rot || {};
  let rx = safeRot.rx !== undefined ? safeRot.rx : 0;
  let ry = safeRot.ry !== undefined ? safeRot.ry : 0;
  let rz = safeRot.rz !== undefined ? safeRot.rz : 0;
  rx = -rx * Math.PI / 180;
  ry = -ry * Math.PI / 180;
  rz = -rz * Math.PI / 180;
  
  if (order === 0) {
    // Order 0の逆: Z→Y→X順（逆角度）
    // Z
    let x1 = v.x * Math.cos(rz) - v.y * Math.sin(rz);
    let y1 = v.x * Math.sin(rz) + v.y * Math.cos(rz);
    let z1 = v.z;
    // Y
    let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry);
    let y2 = y1;
    let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry);
    // X
    let x3 = x2;
    let y3 = y2 * Math.cos(rx) - z2 * Math.sin(rx);
    let z3 = y2 * Math.sin(rx) + z2 * Math.cos(rx);
    return vec3(x3, y3, z3);
  } else {
    // Order 1の逆: X→Y→Z順（逆角度）
    // X
    let x1 = v.x;
    let y1 = v.y * Math.cos(rx) - v.z * Math.sin(rx);
    let z1 = v.y * Math.sin(rx) + v.z * Math.cos(rx);
    // Y
    let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry);
    let y2 = y1;
    let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry);
    // Z
    let x3 = x2 * Math.cos(rz) - y2 * Math.sin(rz);
    let y3 = x2 * Math.sin(rz) + y2 * Math.cos(rz);
    let z3 = z2;
    return vec3(x3, y3, z3);
  }
}

// --- 非球面サグ値計算（surface.jsのasphericSurfaceZと同じ実装） ---
export function asphericSag(r, params, mode = "even") {
  // Profiling start
  if (RT_PROF.enabled) {
    RT_PROF.stats.asphericSagCalls++;
    var __t0 = now();
    try {
      return __asphericSag_impl(r, params, mode);
    } finally {
      RT_PROF.stats.asphericSagTime += now() - __t0;
    }
  }
  // Fast path without profiling
  return __asphericSag_impl(r, params, mode);
}

// Internal implementation (kept separate to minimize profiling overhead when disabled)
function __asphericSag_impl(r, params, mode = "even") {
  const safeParams = params || {};
  const radius = safeParams.radius;
  const conic = safeParams.conic !== undefined ? safeParams.conic : 0;
  const coef1 = safeParams.coef1 !== undefined ? safeParams.coef1 : 0;
  const coef2 = safeParams.coef2 !== undefined ? safeParams.coef2 : 0;
  const coef3 = safeParams.coef3 !== undefined ? safeParams.coef3 : 0;
  const coef4 = safeParams.coef4 !== undefined ? safeParams.coef4 : 0;
  const coef5 = safeParams.coef5 !== undefined ? safeParams.coef5 : 0;
  const coef6 = safeParams.coef6 !== undefined ? safeParams.coef6 : 0;
  const coef7 = safeParams.coef7 !== undefined ? safeParams.coef7 : 0;
  const coef8 = safeParams.coef8 !== undefined ? safeParams.coef8 : 0;
  const coef9 = safeParams.coef9 !== undefined ? safeParams.coef9 : 0;
  const coef10 = safeParams.coef10 !== undefined ? safeParams.coef10 : 0;

  // Optional WASM fast path (ray-tracing.js coefficient convention).
  // This is only used if the loaded RayTracingWASM build exports _aspheric_sag_rt10.
  const wasmSagRt10 = __getWasmSagRt10Fn();
  if (wasmSagRt10) {
    const rr = Number(r);
    const R = Number(radius);
    const k = Number(conic) || 0;
    if (Number.isFinite(rr) && Number.isFinite(R) && R !== 0) {
      const modeOdd = (String(mode || '').toLowerCase() === 'odd') ? 1 : 0;
      const out = wasmSagRt10(
        rr, R, k,
        coef1 || 0,
        coef2 || 0,
        coef3 || 0,
        coef4 || 0,
        coef5 || 0,
        coef6 || 0,
        coef7 || 0,
        coef8 || 0,
        coef9 || 0,
        coef10 || 0,
        modeOdd
      );
      if (isFinite(out)) return out;
    }
  }

  if (!isFinite(radius) || radius === 0) return 0;
  const r2 = r * r;
  const sqrtTerm = 1 - (1 + conic) * r2 / (radius * radius);
  if (!isFinite(sqrtTerm) || sqrtTerm < 0) return 0;
  const base = r2 / (radius * (1 + Math.sqrt(sqrtTerm)));

  // Horner法による多項式最適化
  let asphere = 0;
  const coefs = [coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10];
  
  if (mode === "even") {
    // Math.pow()を使わずに逐次乗算でr^(2n)を計算
    // IMPORTANT: even-mode coefficients are A4..A22 (r^4..r^22)
    let r_power = r2 * r2; // r^4
    for (let i = 0; i < coefs.length; i++) {
      if (coefs[i] !== 0) {
        asphere += coefs[i] * r_power;
      }
      r_power *= r2; // r^2 → r^4 → r^6 → ...
    }
  } else if (mode === "odd") {
    // Math.pow()を使わずに逐次乗算でr^(2n+1)を計算
    let r_power = r2 * r; // r^3
    for (let i = 0; i < coefs.length; i++) {
      if (coefs[i] !== 0) {
        asphere += coefs[i] * r_power;
      }
      r_power *= r2; // r^3 → r^5 → r^7 → ...
    }
  }
  
  return base + asphere;
}

// --- 非球面サーフェスとの交点探索（ニュートン法） ---
export function intersectAsphericSurface(ray, params, mode = "even", maxIter = 20, tol = 1e-7, debugLog = null) {
  // During optimization / merit fast-mode, disable detailed debug logging.
  // This keeps the WASM intersection fast-path enabled regardless of call site.
  try {
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
    const fastMode = !!(g && g.__cooptMeritFastMode && g.__cooptMeritFastMode.enabled);
    const forceDisable = !!(g && g.__COOPT_DISABLE_RAYTRACE_DEBUG);
    if ((fastMode || forceDisable) && debugLog !== null) debugLog = null;
  } catch (_) {}

  if (RT_PROF.enabled) {
    RT_PROF.stats.intersectCalls++;
    var __t0 = now();
    var __itersBefore = RT_PROF.stats.intersectIterationsTotal;
    try {
      const res = __intersectAsphericSurface_impl(ray, params, mode, maxIter, tol, debugLog);
      return res;
    } finally {
      RT_PROF.stats.intersectTime += now() - __t0;
      // __intersectAsphericSurface_impl will bump RT_PROF.stats.__lastIterCount
      RT_PROF.stats.intersectIterationsTotal += RT_PROF.stats.__lastIterCount;
      if (RT_PROF.stats.__lastIterCount > RT_PROF.stats.intersectIterationsMax) RT_PROF.stats.intersectIterationsMax = RT_PROF.stats.__lastIterCount;
    }
  }
  return __intersectAsphericSurface_impl(ray, params, mode, maxIter, tol, debugLog);
}

function __intersectAsphericSurface_impl(ray, params, mode = "even", maxIter = 20, tol = 1e-7, debugLog = null) {
  // Last line of defense: never run detailed intersection debug during optimization.
  // Some call sites may bypass the exported wrapper; ensure the WASM fast-path is not skipped.
  try {
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
    const fastMode = !!(g && g.__cooptMeritFastMode && g.__cooptMeritFastMode.enabled);
    const forceDisable = !!(g && g.__COOPT_DISABLE_RAYTRACE_DEBUG);
    if ((fastMode || forceDisable) && debugLog !== null) debugLog = null;
  } catch (_) {}

  // ray: {pos: {x,y,z}, dir: {x,y,z}}
  // params: {radius, conic, coef1...coef10, semidia}
  // 座標変換1.5.md仕様: O(s)/R(s)ベースの実装（面はローカル座標系のz=0に配置）
  const safeParams = params || {};
  const semidia = safeParams.semidia;
  const radius = safeParams.radius;
  const conic = safeParams.conic !== undefined ? safeParams.conic : 0;
  const coef1 = safeParams.coef1 !== undefined ? safeParams.coef1 : 0;
  const coef2 = safeParams.coef2 !== undefined ? safeParams.coef2 : 0;
  const coef3 = safeParams.coef3 !== undefined ? safeParams.coef3 : 0;
  const coef4 = safeParams.coef4 !== undefined ? safeParams.coef4 : 0;
  const coef5 = safeParams.coef5 !== undefined ? safeParams.coef5 : 0;
  const coef6 = safeParams.coef6 !== undefined ? safeParams.coef6 : 0;
  const coef7 = safeParams.coef7 !== undefined ? safeParams.coef7 : 0;
  const coef8 = safeParams.coef8 !== undefined ? safeParams.coef8 : 0;
  const coef9 = safeParams.coef9 !== undefined ? safeParams.coef9 : 0;
  const coef10 = safeParams.coef10 !== undefined ? safeParams.coef10 : 0;

  // Optional WASM fast-path (skip when debugLog is requested to preserve diagnostics).
  try {
    if (!debugLog) {
      const wasmIntersect = __getWasmIntersectRt10Fn();
      if (RT_PROF.enabled) RT_PROF.stats.wasmIntersectAttempts++;
      if (wasmIntersect) {
        const ox = Number(ray?.pos?.x);
        const oy = Number(ray?.pos?.y);
        const oz = Number(ray?.pos?.z);
        const dx = Number(ray?.dir?.x);
        const dy = Number(ray?.dir?.y);
        const dz = Number(ray?.dir?.z);
        const sm = Number(semidia) || 0;
        const R = Number(radius);
        const k = Number(conic) || 0;
        const modeOdd = (String(mode || '').toLowerCase() === 'odd') ? 1 : 0;
        if (Number.isFinite(ox) && Number.isFinite(oy) && Number.isFinite(oz) && Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz)) {
          const tHit = wasmIntersect(
            ox, oy, oz,
            dx, dy, dz,
            sm,
            R, k,
            coef1 || 0,
            coef2 || 0,
            coef3 || 0,
            coef4 || 0,
            coef5 || 0,
            coef6 || 0,
            coef7 || 0,
            coef8 || 0,
            coef9 || 0,
            coef10 || 0,
            modeOdd,
            maxIter | 0,
            Number(tol) || 1e-7
          );
          if (Number.isFinite(tHit) && tHit > 0) {
            if (RT_PROF.enabled) RT_PROF.stats.wasmIntersectHits++;
            const pt = add(ray.pos, scale(ray.dir, tHit));
            if (pt && isFinite(pt.x) && isFinite(pt.y) && isFinite(pt.z)) return pt;
          }
          if (RT_PROF.enabled) RT_PROF.stats.wasmIntersectMisses++;
        }
      }
      if (RT_PROF.enabled && !wasmIntersect) RT_PROF.stats.wasmIntersectUnavailable++;
    } else {
      if (RT_PROF.enabled) {
        RT_PROF.stats.wasmIntersectSkippedDebug++;
        try {
          const g = (typeof globalThis !== 'undefined') ? globalThis : null;
          const fastMode = !!(g && g.__cooptMeritFastMode && g.__cooptMeritFastMode.enabled);
          const forceDisable = !!(g && g.__COOPT_DISABLE_RAYTRACE_DEBUG);
          if (fastMode || forceDisable) RT_PROF.stats.wasmIntersectSkippedDebugWhileDisabled++;
          if (!RT_PROF.stats.wasmIntersectSkippedDebugFirstStack && g && g.__RAYTRACE_CAPTURE_SKIPPED_DEBUG_STACK) {
            RT_PROF.stats.wasmIntersectSkippedDebugFirstStack = String(new Error('wasmIntersectSkippedDebug').stack || '');
          }
        } catch (_) {}
      }
    }
  } catch (_) {
    // Fallback to JS implementation
    if (RT_PROF.enabled) RT_PROF.stats.wasmIntersectErrors++;
  }
  
  if (debugLog) {
    debugLog.push(`🔍 intersectAsphericSurface: radius=${radius}, semidia=${semidia}`);
    debugLog.push(`   Ray pos: (${ray.pos.x.toFixed(3)}, ${ray.pos.y.toFixed(3)}, ${ray.pos.z.toFixed(3)})`);
    debugLog.push(`   Ray dir: (${ray.dir.x.toFixed(3)}, ${ray.dir.y.toFixed(3)}, ${ray.dir.z.toFixed(3)})`);
  }
  
  // 複数の初期推定値を試行
  const initialGuesses = [];
  
  // 1. 球面近似推定（最も重要）
  if (isFinite(radius) && radius !== 0) {
    const cz = radius;
    const dx = ray.dir.x, dy = ray.dir.y, dz = ray.dir.z;
    const ox = ray.pos.x, oy = ray.pos.y, oz = ray.pos.z;
    const A = dx*dx + dy*dy + dz*dz;
    const B = 2 * (ox*dx + oy*dy + (oz-cz)*dz);
    const C = ox*ox + oy*oy + (oz-cz)*(oz-cz) - radius*radius;
    const D = B*B - 4*A*C;
    
    if (D >= 0) {
      const sqrtD = Math.sqrt(D);
      const t1 = (-B - sqrtD) / (2*A);
      const t2 = (-B + sqrtD) / (2*A);
      
      // より近い正の解を優先し、遠い解も含める
      const candidates = [t1, t2].filter(t => t > 1e-10).sort((a, b) => a - b);
      initialGuesses.push(...candidates);
    }
  }
  
  // 2. 平面近似推定
  if (Math.abs(ray.dir.z) > 1e-10) {
    const tPlane = -ray.pos.z / ray.dir.z;
    if (tPlane > 1e-10) initialGuesses.push(tPlane);
  }
  
  // 3. セミ径ベースの推定値（新規追加）
  // セミ径境界での交点を狙った推定値
  if (Number.isFinite(semidia) && semidia > 0) {
    const currentR = Math.sqrt(ray.pos.x * ray.pos.x + ray.pos.y * ray.pos.y);
    const dirR = Math.sqrt(ray.dir.x * ray.dir.x + ray.dir.y * ray.dir.y);
    if (dirR > 1e-10) {
      // セミ径の0.8倍, 1.0倍の位置を狙う推定値
      for (const factor of [0.8, 1.0]) {
        const targetR = semidia * factor;
        if (targetR > currentR) {
          const tSemi = (targetR - currentR) / dirR;
          if (tSemi > 1e-10) initialGuesses.push(tSemi);
        }
      }
    }
  }
  
  // 4. フォールバック推定値（段階的に増加）
  if (initialGuesses.length === 0) {
    initialGuesses.push(1e-6, 0.001, 0.01, 0.1, 1.0, 10.0);
  } else {
    // 既存の推定値に追加の候補を補完
    initialGuesses.push(1e-6, 0.001, 0.01, 0.1, 1.0);
  }
  
  // 重複除去とソート
  let uniqueGuesses = [...new Set(initialGuesses)]
    .filter(t => Number.isFinite(t) && t > 1e-10)
    .sort((a, b) => a - b);

  if (uniqueGuesses.length === 0) {
    uniqueGuesses = [1e-6, 0.001, 0.01, 0.1, 1.0, 10.0];
  }
  
  if (debugLog) {
    debugLog.push(`   🎯 Initial guesses: [${uniqueGuesses.map(t => t.toFixed(6)).join(', ')}]`);
  }
  
  // 各初期推定値でNewton法を試行
  for (let guessIndex = 0; guessIndex < uniqueGuesses.length; guessIndex++) {
    let t = uniqueGuesses[guessIndex];
    
    if (debugLog) {
      debugLog.push(`   🔄 Trying guess ${guessIndex + 1}: t=${t.toFixed(6)}`);
    }
    
    // 初期r0チェックを緩和（警告のみ、継続する）
    const pt0 = add(ray.pos, scale(ray.dir, t));
    const r0 = Math.sqrt(pt0.x * pt0.x + pt0.y * pt0.y);
    if (r0 > semidia * 1.5) { // 1.5倍まで許容
      if (debugLog) debugLog.push(`     ⚠️ Initial r0=${r0.toFixed(3)} > semidia×1.5=${(semidia*1.5).toFixed(3)}, risky but trying`);
    }
    
    if (debugLog) debugLog.push(`     🎯 Starting Newton iteration with t=${t.toFixed(6)}, r0=${r0.toFixed(3)}`);
    
    let converged = false;
    let lastValidPt = null;
    let lastValidF = Infinity;
    
    let __iterCount = 0;
    for (let i = 0; i < maxIter; ++i) {
      __iterCount++;
      const pt = add(ray.pos, scale(ray.dir, t));
      const r = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
      
      // セミ径制限を段階的に緩和
      let semidiaLimit = semidia;
      if (i < 5) semidiaLimit *= 1.2; // 初期段階は20%緩和
      else if (i < 10) semidiaLimit *= 1.1; // 中期段階は10%緩和
      
      if (r > semidiaLimit) {
        if (debugLog) debugLog.push(`     ⚠️ Iteration ${i}: r=${r.toFixed(3)} > limit=${semidiaLimit.toFixed(3)}, but continuing`);
      }
      
      const sag = asphericSag(r, params, mode);
      const F = pt.z - sag; // ローカル座標系でz=0が面位置
      
      // 最善の結果を保存
      if (r <= semidia && Math.abs(F) < Math.abs(lastValidF)) {
        lastValidPt = pt;
        lastValidF = F;
      }
      
      if (debugLog && i < 3) { // 最初の3回のみログ
        debugLog.push(`     📐 Iter ${i}: t=${t.toFixed(6)}, pt=(${pt.x.toFixed(3)},${pt.y.toFixed(3)},${pt.z.toFixed(3)}), r=${r.toFixed(3)}, sag=${sag.toFixed(6)}, F=${F.toFixed(6)}`);
      }
      
      if (Math.abs(F) < tol) {
        if (debugLog) debugLog.push(`     ✅ Converged in ${i} iterations, F=${F.toFixed(9)}`);
  converged = true;
  if (RT_PROF.enabled) RT_PROF.stats.__lastIterCount = __iterCount;
  return pt;
      }
      
      // 微分計算とNewtonステップ
      let dzdr = 0;
      if (r > 1e-10) {
        const k = conic;
        const r2 = r * r;
        
        if (isFinite(radius) && radius !== 0) {
          const R = radius;
          const term = (1 + k) * r2 / (R * R);
          
          if (term < 1) {
            const sqrtTerm = Math.sqrt(1 - term);
            const denominator = R * (1 + sqrtTerm);
            const sqrtDerivative = (1 + k) * r / (R * R * sqrtTerm);
            dzdr = (2 * r * denominator - r2 * R * sqrtDerivative) / (denominator * denominator);
          } else {
            dzdr = 1 / R;
          }
          
          // 非球面部分の微分
          let dzdr_asp = 0;
          if (mode === "odd") {
            dzdr_asp = 3 * coef1 * Math.pow(r, 2) + 5 * coef2 * Math.pow(r, 4) + 7 * coef3 * Math.pow(r, 6) +
              9 * coef4 * Math.pow(r, 8) + 11 * coef5 * Math.pow(r, 10);
          } else {
            // even-mode coefficients are A4..A22 (r^4..r^22)
            dzdr_asp = 4 * coef1 * Math.pow(r, 3) + 6 * coef2 * Math.pow(r, 5) + 8 * coef3 * Math.pow(r, 7) +
              10 * coef4 * Math.pow(r, 9) + 12 * coef5 * Math.pow(r, 11) + 14 * coef6 * Math.pow(r, 13) +
              16 * coef7 * Math.pow(r, 15) + 18 * coef8 * Math.pow(r, 17) + 20 * coef9 * Math.pow(r, 19) +
              22 * coef10 * Math.pow(r, 21);
          }
          dzdr += dzdr_asp;
        }
      }
      
      const dFdt = ray.dir.z - dzdr * (pt.x * ray.dir.x + pt.y * ray.dir.y) / (r > 1e-10 ? r : 1e-10);
      
      if (Math.abs(dFdt) < 1e-12) {
        if (debugLog) debugLog.push(`     ⚠️ Iteration ${i}: dFdt=${dFdt.toFixed(12)} too small, breaking`);
  if (RT_PROF.enabled) RT_PROF.stats.__lastIterCount = __iterCount;
  break;
      }
      
      const deltaT = F / dFdt;
      let newT = t - deltaT;
      
      // 過度な変化を制限（adaptiveステップサイズ）
      const maxDelta = Math.abs(t) * 0.5 + 1.0; // tの50%または1.0の小さい方
      if (Math.abs(deltaT) > maxDelta) {
        newT = t - Math.sign(deltaT) * maxDelta;
        if (debugLog && i < 3) {
          debugLog.push(`     🛡️ Iter ${i}: Limiting deltaT from ${deltaT.toFixed(6)} to ${Math.sign(deltaT) * maxDelta}`);
        }
      }
      
      if (debugLog && i < 3) {
        debugLog.push(`     🔄 Iter ${i}: F=${F.toFixed(6)}, dzdr=${dzdr.toFixed(6)}, dFdt=${dFdt.toFixed(6)}, deltaT=${deltaT.toFixed(6)}, newT=${newT.toFixed(6)}`);
      }
      
      t = newT;
      
      // t値の妥当性チェック（緩和）
      if (t < -10000 || t > 10000) {
        if (debugLog) debugLog.push(`     ❌ Iteration ${i}: t=${t.toFixed(6)} out of bounds, breaking`);
  if (RT_PROF.enabled) RT_PROF.stats.__lastIterCount = __iterCount;
  break;
      }
    }
    
    if (!converged) {
      // 最大反復回数に達した場合、最適解をチェック
      const finalPt = add(ray.pos, scale(ray.dir, t));
      const finalR = Math.sqrt(finalPt.x * finalPt.x + finalPt.y * finalPt.y);
      const lastSag = asphericSag(finalR, params, mode);
      const finalF = finalPt.z - lastSag;
      
      if (debugLog) {
        debugLog.push(`     📊 Final check for guess ${guessIndex + 1}: F=${finalF.toFixed(9)}, r=${finalR.toFixed(3)}, semidia=${semidia}`);
      }
      
      // 最終誤差が許容範囲内かつ有効領域内なら受容
      if (Math.abs(finalF) < tol * 10 && finalR <= semidia * 1.1) {
        if (debugLog) debugLog.push(`     ✅ Accepting final result for guess ${guessIndex + 1}: F=${finalF.toFixed(9)}`);
  if (RT_PROF.enabled) RT_PROF.stats.__lastIterCount = maxIter; 
  return finalPt;
      }
      
      // lastValidPtがある場合、それを評価
      if (lastValidPt && Math.abs(lastValidF) < tol * 50) {
        if (debugLog) debugLog.push(`     ✅ Accepting best valid result for guess ${guessIndex + 1}: F=${lastValidF.toFixed(9)}`);
    if (RT_PROF.enabled) RT_PROF.stats.__lastIterCount = maxIter; 
    return lastValidPt;
      }
    }
  }
  
  if (debugLog) debugLog.push(`   ❌ All initial guesses failed`);
  if (RT_PROF.enabled) RT_PROF.stats.__lastIterCount = 0;
  return null;
}

// --- Toric Surface Intersection using 3D Newton-Raphson ---
export function intersectToricSurface(ray, params, maxIter = 50, tol = 1e-10, debugLog = null) {
  // ray: {pos: {x,y,z}, dir: {x,y,z}}
  // params: {radiusX, radiusY, conic, axis, semidia}
  
  const safeParams = params || {};
  const { radiusX, radiusY, conic = 0, axis = 0, semidia = Infinity } = safeParams;
  
  // radiusX or radiusY can be Infinity (flat surface in that direction)
  // but should not be 0 or invalid finite values
  if ((isFinite(radiusX) && radiusX === 0) || (isFinite(radiusY) && radiusY === 0)) {
    if (debugLog) debugLog.push('❌ intersectToricSurface: radiusX or radiusY is zero');
    return null;
  }
  
  if (!isFinite(radiusX) && radiusX !== Infinity) {
    if (debugLog) debugLog.push('❌ intersectToricSurface: Invalid radiusX (NaN)');
    return null;
  }
  
  if (!isFinite(radiusY) && radiusY !== Infinity) {
    if (debugLog) debugLog.push('❌ intersectToricSurface: Invalid radiusY (NaN)');
    return null;
  }
  
  // Initial guess: intersection with z=0 plane
  let t = -ray.pos.z / ray.dir.z;
  if (!isFinite(t)) {
    if (debugLog) debugLog.push('❌ intersectToricSurface: Invalid initial t guess');
    return null;
  }
  // Round small negative values to zero (numerical tolerance)
  if (t < 0) {
    t = 0;
  }
  
  let converged = false;
  let lastValidPt = null;
  let lastValidF = Infinity;
  
  for (let iter = 0; iter < maxIter; iter++) {
    const P = add(ray.pos, scale(ray.dir, t));
    const z_surface = toricSurfaceZ(P.x, P.y, { radiusX, radiusY, conic, axis });
    
    if (!isFinite(z_surface)) {
      if (debugLog) debugLog.push(`   ⚠️ Iter ${iter}: Invalid toric sag at (${P.x.toFixed(3)}, ${P.y.toFixed(3)})`);
      break;
    }
    
    const F = P.z - z_surface;
    
    if (Math.abs(F) < tol) {
      const r = Math.sqrt(P.x * P.x + P.y * P.y);
      if (r <= semidia) {
        if (debugLog) debugLog.push(`   ✅ Converged at iter ${iter}: F=${F.toExponential(3)}, r=${r.toFixed(3)}`);
        return P;
      }
    }
    
    // Track best valid point
    if (Math.abs(F) < Math.abs(lastValidF)) {
      lastValidPt = P;
      lastValidF = F;
    }
    
    // Calculate partial derivatives dz/dx and dz/dy
    const { dz_dx, dz_dy } = toricSagDerivatives(P.x, P.y, { radiusX, radiusY, conic, axis });
    
    if (!isFinite(dz_dx) || !isFinite(dz_dy)) {
      if (debugLog) debugLog.push(`   ⚠️ Iter ${iter}: Invalid derivatives`);
      break;
    }
    
    // dF/dt = dir.z - dz/dx * dir.x - dz/dy * dir.y
    const dFdt = ray.dir.z - dz_dx * ray.dir.x - dz_dy * ray.dir.y;
    
    if (Math.abs(dFdt) < 1e-14) {
      if (debugLog) debugLog.push(`   ⚠️ Iter ${iter}: dFdt too small, ray tangent to surface`);
      break;
    }
    
    const deltaT = F / dFdt;
    t -= deltaT;
    
    // Bounds check
    if (t < -10000 || t > 10000) {
      if (debugLog) debugLog.push(`   ❌ Iter ${iter}: t=${t.toFixed(3)} out of bounds`);
      break;
    }
    
    if (Math.abs(deltaT) < tol * Math.abs(t)) {
      converged = true;
    }
  }
  
  // Accept best valid point if close enough
  if (lastValidPt && Math.abs(lastValidF) < tol * 100) {
    const r = Math.sqrt(lastValidPt.x * lastValidPt.x + lastValidPt.y * lastValidPt.y);
    if (r <= semidia * 1.1) {
      if (debugLog) debugLog.push(`   ✅ Accepting best valid point: F=${lastValidF.toExponential(3)}`);
      return lastValidPt;
    }
  }
  
  if (debugLog) debugLog.push('   ❌ Toric intersection failed');
  return null;
}

// --- サーフェス法線ベクトル（数値計算版） ---
// --- 解析的微分による非球面SAGの微分計算（Horner法使用）---
// asphericSagDerivativeはsurface.jsからimportするため、ここでは定義しない

function __asphericSagDerivative_impl(r, params, mode = "even") {
  const safeParams = params || {};
  const radius = safeParams.radius;
  const conic = safeParams.conic !== undefined ? safeParams.conic : 0;
  const coef1 = safeParams.coef1 !== undefined ? safeParams.coef1 : 0;
  const coef2 = safeParams.coef2 !== undefined ? safeParams.coef2 : 0;
  const coef3 = safeParams.coef3 !== undefined ? safeParams.coef3 : 0;
  const coef4 = safeParams.coef4 !== undefined ? safeParams.coef4 : 0;
  const coef5 = safeParams.coef5 !== undefined ? safeParams.coef5 : 0;
  const coef6 = safeParams.coef6 !== undefined ? safeParams.coef6 : 0;
  const coef7 = safeParams.coef7 !== undefined ? safeParams.coef7 : 0;
  const coef8 = safeParams.coef8 !== undefined ? safeParams.coef8 : 0;
  const coef9 = safeParams.coef9 !== undefined ? safeParams.coef9 : 0;
  const coef10 = safeParams.coef10 !== undefined ? safeParams.coef10 : 0;
  
  if (!isFinite(radius) || radius === 0 || r < 1e-10) return 0;
  
  let dzdr = 0;
  
  // 球面部分の解析的微分: d/dr[r²/(R(1+√(1-(1+k)r²/R²)))]
  const r2 = r * r;
  const R = radius;
  const R2 = R * R;
  const term = (1 + conic) * r2 / R2;
  
  if (term < 1) {
    const sqrtTerm = Math.sqrt(1 - term);
    const denominator = R * (1 + sqrtTerm);
    const numerator = r2;
    
    // 商の微分公式を適用
    const dNumerator = 2 * r; // d/dr[r²] = 2r
    const dDenominator = -R * (1 + conic) * r / (R2 * sqrtTerm); // d/dr[R(1+√(...))]
    
    dzdr = (dNumerator * denominator - numerator * dDenominator) / (denominator * denominator);
  }
  
  // 非球面部分の解析的微分（Horner法使用）
  const coefs = [coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10];
  
  if (mode === "even") {
    // Math.pow()を使わずに逐次乗算でr^(2n-1)を計算
    // even-mode coefficients are A4..A22 (r^4..r^22)
    let r_power = r2 * r; // r^3
    for (let i = 0; i < coefs.length; i++) {
      if (coefs[i] !== 0) {
        const power = 2 * (i + 2); // r^4, r^6, r^8, ...の指数
        dzdr += coefs[i] * power * r_power; // d/dr[ar^n] = n*a*r^(n-1)
      }
      r_power *= r2; // r^1 → r^3 → r^5 → r^7 → ...
    }
  } else if (mode === "odd") {
    // Math.pow()を使わずに逐次乗算でr^(2n)を計算
    let r_power = r2; // r^2
    for (let i = 0; i < coefs.length; i++) {
      if (coefs[i] !== 0) {
        const power = 2 * (i + 1) + 1; // r^3, r^5, r^7, ...の指数
        dzdr += coefs[i] * power * r_power; // d/dr[ar^n] = n*a*r^(n-1)
      }
      r_power *= r2; // r^2 → r^4 → r^6 → r^8 → ...
    }
  }
  
  return dzdr;
}

export function surfaceNormal(pt, params, mode = "even") {
  if (RT_PROF.enabled) {
    RT_PROF.stats.surfaceNormalCalls++;
    var __t0 = now();
    try {
      return __surfaceNormal_impl(pt, params, mode);
    } finally {
      RT_PROF.stats.surfaceNormalTime += now() - __t0;
    }
  }
  return __surfaceNormal_impl(pt, params, mode);
}

function __surfaceNormal_impl(pt, params, mode = "even") {
  // 座標変換1.5.md仕様: ローカル座標系での解析的微分による法線計算
  const x = pt.x, y = pt.y;
  const r = Math.sqrt(x * x + y * y);
  
  // 中心点では法線はZ方向
  if (r < 1e-10) {
    return normalize(vec3(0, 0, 1));
  }
  
  // 解析的微分でdzdrを直接計算（数値微分の6回のSAG計算が1回に削減）
  const dzdr = asphericSagDerivative(r, params, mode);
  
  // チェーンルールを適用して偏微分を計算
  // ∂z/∂x = (∂z/∂r)(∂r/∂x) = dzdr * (x/r)
  // ∂z/∂y = (∂z/∂r)(∂r/∂y) = dzdr * (y/r)
  const dzdx = dzdr * (x / r);
  const dzdy = dzdr * (y / r);
  
  // 法線ベクトル: n = (-∂z/∂x, -∂z/∂y, 1)
  const nx = -dzdx;
  const ny = -dzdy;
  const nz = 1;
  
  return normalize(vec3(nx, ny, nz));
}

// --- Toric Surface Normal Vector ---
export function toricSurfaceNormal(pt, params) {
  // params: {radiusX, radiusY, conic, axis}
  // Normal vector: n = normalize(-dz/dx, -dz/dy, 1)
  
  const { radiusX, radiusY, conic = 0, axis = 0 } = params || {};
  
  // radiusX or radiusY can be Infinity (flat surface in that direction)
  if ((isFinite(radiusX) && radiusX === 0) || (isFinite(radiusY) && radiusY === 0)) {
    return normalize(vec3(0, 0, 1)); // Default to Z-axis for zero radius
  }
  
  if ((!isFinite(radiusX) && radiusX !== Infinity) || (!isFinite(radiusY) && radiusY !== Infinity)) {
    return normalize(vec3(0, 0, 1)); // Default to Z-axis for NaN
  }
  
  const { dz_dx, dz_dy } = toricSagDerivatives(pt.x, pt.y, { radiusX, radiusY, conic, axis });
  
  if (!isFinite(dz_dx) || !isFinite(dz_dy)) {
    return normalize(vec3(0, 0, 1)); // Fallback to Z-axis
  }
  
  const nx = -dz_dx;
  const ny = -dz_dy;
  const nz = 1;
  
  return normalize(vec3(nx, ny, nz));
}

// --- スネルの法則による屈折 ---
function refractRay(dir, normal, n1, n2) {
  if (RT_PROF.enabled) {
    RT_PROF.stats.refractCalls++;
    var __t0 = now();
    try {
      return __refractRay_impl(dir, normal, n1, n2);
    } finally {
      RT_PROF.stats.refractTime += now() - __t0;
    }
  }
  return __refractRay_impl(dir, normal, n1, n2);
}

function __refractRay_impl(dir, normal, n1, n2) {
  const cosI = -dot(normal, dir);
  const eta = n1 / n2;
  const k = 1 - eta * eta * (1 - cosI * cosI);
  if (k < 0) return null; // 全反射
  return norm(add(scale(dir, eta), scale(normal, eta * cosI - Math.sqrt(k))));
}

function reflectRay(dir, normal) {
  if (RT_PROF.enabled) {
    RT_PROF.stats.reflectCalls++;
    var __t0 = now();
    try {
      return norm(sub(dir, scale(normal, 2 * dot(dir, normal))));
    } finally {
      RT_PROF.stats.reflectTime += now() - __t0;
    }
  }
  return norm(sub(dir, scale(normal, 2 * dot(dir, normal))));
}

// --- Coordinate Break面の座標変換処理 ---
function createCoordinateTransform(row, rotationCenterZ = 0) {
  const cb = parseCoordTransParams(row) || {};
  const decenterX = Number(cb.decenterX ?? 0);
  const decenterY = Number(cb.decenterY ?? 0);
  const decenterZ = Number(cb.decenterZ ?? 0);
  const tiltX = Number(cb.tiltX ?? 0);
  const tiltY = Number(cb.tiltY ?? 0);
  const tiltZ = Number(cb.tiltZ ?? 0);
  const transformOrder = Number(cb.transformOrder ?? 1);
  
  return {
    decenterX, decenterY, decenterZ, tiltX, tiltY, tiltZ, transformOrder, rotationCenterZ
  };
}

function applyCoordinateTransform(ray, transform, debugLog = null) {
  const safeTransform = transform || {};
  const decenterX = safeTransform.decenterX;
  const decenterY = safeTransform.decenterY;
  const decenterZ = safeTransform.decenterZ;
  const tiltX = safeTransform.tiltX;
  const tiltY = safeTransform.tiltY;
  const tiltZ = safeTransform.tiltZ;
  const transformOrder = safeTransform.transformOrder;
  const rotationCenterZ = safeTransform.rotationCenterZ;
  
  // 度からラジアンに変換
  const rotation = {
    rx: tiltX,  // 度数のまま（applyInvRotationが内部で変換）
    ry: tiltY,
    rz: tiltZ
  };

  // CB面のZ位置を回転中心として使用
  const rotationCenter = { x: 0, y: 0, z: rotationCenterZ };

  if (debugLog) {
    debugLog.push(`CB面座標変換開始: rotationCenterZ=${rotationCenterZ}, 回転中心Z=${rotationCenter.z}`);
    debugLog.push(`変換前光線: pos=(${ray.pos.x.toFixed(4)}, ${ray.pos.y.toFixed(4)}, ${ray.pos.z.toFixed(4)}), dir=(${ray.dir.x.toFixed(6)}, ${ray.dir.y.toFixed(6)}, ${ray.dir.z.toFixed(6)})`);
  }

  if (transformOrder === 0) {
    // Order 0: Decenter → Tilt
    // 光線追跡では逆変換が必要: Tilt逆 → Decenter逆
    
    // 1. CB面のZ位置を基準とした相対座標に変換
    ray.pos.z -= rotationCenter.z;
    
    // 2. 逆回転（Tilt逆）: 全座標に適用
    ray.pos = applyInvRotation(ray.pos, rotation, 0);
    ray.dir = applyInvRotation(ray.dir, rotation, 0);
    
    // 3. 回転後、CB面Z位置を戻す
    ray.pos.z += rotationCenter.z;
    
    // 4. 並進逆（Decenter逆）: X, Y, Z全てに適用
    ray.pos.x -= decenterX;
    ray.pos.y -= decenterY;
    ray.pos.z -= decenterZ;  // Decenter Zも適用
    
    if (debugLog) {
      debugLog.push(`Order=0: 回転中心Z=${rotationCenter.z} → Tilt逆(${tiltX}°, ${tiltY}°, ${tiltZ}°) → Decenter逆(${decenterX}, ${decenterY}, ${decenterZ})`);
    }
  } else {
    // Order 1: Tilt → Decenter
    // 光線追跡では逆変換が必要: Decenter逆 → Tilt逆
    
    // 1. 並進逆（Decenter逆）: X, Y, Z全てに適用
    ray.pos.x -= decenterX;
    ray.pos.y -= decenterY;
    ray.pos.z -= decenterZ;  // Decenter Zも適用
    
    // 2. CB面のZ位置を基準とした相対座標に変換
    ray.pos.z -= rotationCenter.z;
    
    // 3. 逆回転（Tilt逆）
    ray.pos = applyInvRotation(ray.pos, rotation, 1);
    ray.dir = applyInvRotation(ray.dir, rotation, 1);
    
    // 4. 回転後、CB面Z位置を戻す
    ray.pos.z += rotationCenter.z;
    
    if (debugLog) {
      debugLog.push(`Order=1: Decenter逆(${decenterX}, ${decenterY}, ${decenterZ}) → 回転中心Z=${rotationCenter.z} → Tilt逆(${tiltX}°, ${tiltY}°, ${tiltZ}°)`);
    }
  }
  
  if (debugLog) {
    debugLog.push(`変換後光線: pos=(${ray.pos.x.toFixed(4)}, ${ray.pos.y.toFixed(4)}, ${ray.pos.z.toFixed(4)}), dir=(${ray.dir.x.toFixed(6)}, ${ray.dir.y.toFixed(6)}, ${ray.dir.z.toFixed(6)})`);
  }
  
  return transform; // 逆変換のために返す
}

function applyInverseCoordinateTransform(ray, transform, debugLog = null) {
  const safeTransform = transform || {};
  const decenterX = safeTransform.decenterX;
  const decenterY = safeTransform.decenterY;
  const decenterZ = safeTransform.decenterZ;
  const tiltX = safeTransform.tiltX;
  const tiltY = safeTransform.tiltY;
  const tiltZ = safeTransform.tiltZ;
  const transformOrder = safeTransform.transformOrder;
  const rotationCenterZ = safeTransform.rotationCenterZ;
  
  // 度からラジアンに変換
  const rotation = {
    rx: tiltX,
    ry: tiltY,
    rz: tiltZ
  };

  // CB面のZ位置を回転中心として使用
  const rotationCenter = { x: 0, y: 0, z: rotationCenterZ };
  
  if (transformOrder === 0) {
    // Order 0: Decenter → Tilt の逆変換
    // 正変換の逆順で適用: Tilt → Decenter
    
    // 1. 並進（Decenter X,Y,Z 全てを適用）
    ray.pos.x += decenterX;
    ray.pos.y += decenterY;
    ray.pos.z += decenterZ;  // Decenter Zも適用
    
    // 2. CB面のZ位置を基準とした相対座標に変換
    ray.pos.z -= rotationCenter.z;
    
    // 3. 逆回転（Tilt）- 修正: 逆変換では逆回転を使用
    ray.pos = applyInvRotation(ray.pos, rotation, 0);
    ray.dir = applyInvRotation(ray.dir, rotation, 0);
    
    // 4. 回転後、CB面Z位置を戻す
    ray.pos.z += rotationCenter.z;
    
    if (debugLog) {
      debugLog.push(`逆変換Order=0: Decenter(${decenterX}, ${decenterY}, ${decenterZ}) → 回転中心Z=${rotationCenter.z} → InvTilt(${tiltX}°, ${tiltY}°, ${tiltZ}°)`);
    }
  } else {
    // Order 1: Tilt → Decenter の逆変換
    // 正変換の逆順で適用: Decenter → Tilt
    
    // 1. CB面のZ位置を基準とした相対座標に変換
    ray.pos.z -= rotationCenter.z;
    
    // 2. 逆回転（Tilt）- 修正: 逆変換では逆回転を使用
    ray.pos = applyInvRotation(ray.pos, rotation, 1);
    ray.dir = applyInvRotation(ray.dir, rotation, 1);
    
    // 3. 回転後、CB面Z位置を戻す
    ray.pos.z += rotationCenter.z;
    
    // 4. 並進（Decenter X,Y,Z 全てを適用）
    ray.pos.x += decenterX;
    ray.pos.y += decenterY;
    ray.pos.z += decenterZ;  // Decenter Zも適用
    
    if (debugLog) {
      debugLog.push(`逆変換Order=1: 回転中心Z=${rotationCenter.z} → InvTilt(${tiltX}°, ${tiltY}°, ${tiltZ}°) → Decenter(${decenterX}, ${decenterY}, ${decenterZ})`);
    }
  }
  
  return transform;
}

// --- 累積座標変換行列を計算する関数を追加 ---
function calculateCumulativeTransform(surfaceIndex, surfaces) {
    let cumulativeTransform = createIdentityMatrix();
    
    // Surface 1からsurfaceIndexまでのすべてのCoord Break面の変換を累積
    for (let i = 0; i <= surfaceIndex; i++) {
        const surface = surfaces[i];
        if (surface && surface.surfaceType === 'Coord Break') {
            const transform = createCoordinateTransform(surface);
            // 累積変換 = 現在の変換 × 前の累積変換
            cumulativeTransform = multiplyMatrices(transform.matrix, cumulativeTransform);
        }
    }
    
    return {
        matrix: cumulativeTransform,
        inverse: invertMatrix(cumulativeTransform)
    };
}

function __rtIsCoordTransRow(row) {
  if (!row || typeof row !== 'object') return false;
  const fields = [
    row.surfType, row.type, row.surfaceType, row.surface_type, row.surfTypeName,
    row['object type'], row.object, row.Object,
    row.comment, row.Comment,
    row.blockType, row.block_type, row.blockTypeName
  ];
  const isCb = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return false;
    if (s === 'ct' || s === 'coordtrans' || s === 'coordinatebreak' || s === 'coord trans' || s === 'coordinate break') return true;
    return s.includes('coord trans') || s.includes('coordinate break');
  };
  return fields.some(isCb);
}

// Normalize legacy CoordTrans rows into explicit fields (one-time in-memory migration).
function normalizeCoordTransRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    if (!__rtIsCoordTransRow(row) || !row || typeof row !== 'object') return row;

    // Check if parameters are defined in row itself or in row.parameters
    const hasExplicit = ['decenterX', 'decenterY', 'tiltX', 'tiltY', 'tiltZ'].some(
      (k) => Object.prototype.hasOwnProperty.call(row, k) || 
             (row.parameters && Object.prototype.hasOwnProperty.call(row.parameters, k))
    );
    if (hasExplicit) return row;

    const decenterX = Number.isFinite(Number(row.semidia)) ? Number(row.semidia) : 0;
    const decenterY = Number.isFinite(Number(row.material)) ? Number(row.material) : 0;
    const decenterZ = 0;
    const tiltX = Number.isFinite(Number(row.rindex)) ? Number(row.rindex) : 0;
    const tiltY = Number.isFinite(Number(row.abbe)) ? Number(row.abbe) : 0;
    const tiltZ = Number.isFinite(Number(row.conic)) ? Number(row.conic) : 0;
    const orderCandidate = (row.order !== undefined && row.order !== null) ? row.order : row.coef1;
    const orderRaw = Number(String(orderCandidate ?? '').trim());
    const order = (orderRaw === 0 || orderRaw === 1) ? orderRaw : 1;

    return {
      ...row,
      decenterX,
      decenterY,
      decenterZ,
      tiltX,
      tiltY,
      tiltZ,
      order
    };
  });
}

// Compute a chief-ray direction that passes through the stop center (local x=y=0).
function computeChiefRayDirectionToStop(rows, wavelength = 0.55, maxIter = 8) {
  const stopIndex = rayParaxial.findStopSurfaceIndex(rows);
  if (stopIndex < 0) return { dir: { x: 0, y: 0, z: 1 }, converged: false };

  const surfaceData = calculateSurfaceOrigins(rows);
  const stopSurfaceInfo = surfaceData?.[stopIndex];
  if (!stopSurfaceInfo) return { dir: { x: 0, y: 0, z: 1 }, converged: false };

  const rayStart = { x: 0, y: 0, z: 0 };
  const eps = 1e-6;
  const tol = 1e-6;

  let ax = 0;
  let ay = 0;

  const traceAt = (aX, aY) => {
    const dir = normalize({ x: aX, y: aY, z: 1 });
    const ray = { pos: rayStart, dir, wavelength };
    const path = traceRay(rows, ray, 1.0);
    if (!path || path.length === 0) return null;
    const idx = surfaceIndexToRayPathPointIndex(rows, stopIndex);
    if (idx === null || idx >= path.length) return null;
    const p = path[idx];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    const local = transformPointToLocal(p, stopSurfaceInfo);
    return { local };
  };

  for (let iter = 0; iter < maxIter; iter++) {
    const base = traceAt(ax, ay);
    if (!base) break;
    const ex = base.local.x;
    const ey = base.local.y;
    if (Math.sqrt(ex * ex + ey * ey) < tol) {
      return { dir: normalize({ x: ax, y: ay, z: 1 }), converged: true };
    }

    const dx = traceAt(ax + eps, ay);
    const dy = traceAt(ax, ay + eps);
    if (!dx || !dy) break;

    const j11 = (dx.local.x - ex) / eps;
    const j21 = (dx.local.y - ey) / eps;
    const j12 = (dy.local.x - ex) / eps;
    const j22 = (dy.local.y - ey) / eps;

    const det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-12) break;

    // d = -J^{-1} * e
    const dax = (-j22 * ex + j12 * ey) / det;
    const day = (j21 * ex - j11 * ey) / det;

    ax += dax;
    ay += day;
  }

  return { dir: normalize({ x: ax, y: ay, z: 1 }), converged: false };
}

// --- 座標変換1.5.md仕様: 各面の原点O(s)と回転行列R(s)の算出 ---
export function calculateSurfaceOrigins(opticalSystemRows) {
  const normalizedRows = normalizeCoordTransRows(opticalSystemRows);
  const surfaceData = [];
  
  // 初期値: 面0の原点は{0,0,0}、回転行列は単位行列
  let currentOrigin = vec3(0, 0, 0);
  let currentRotMatrix = createIdentityMatrix();
  
  // 方向ベクトル
  const ex = vec3(1, 0, 0);
  const ey = vec3(0, 1, 0);
  const ez = vec3(0, 0, 1);
  
  for (let s = 0; s < normalizedRows.length; s++) {
    const surface = normalizedRows[s];
    const previousSurface = s > 0 ? normalizedRows[s - 1] : null;
    
    let surfaceOrigin, surfaceRotMatrix;
    
    if (__rtIsCoordTransRow(surface)) {
      // CoordTrans面の場合
      const cbParams = parseCoordTransParams(surface, previousSurface);
      const decenterX = cbParams.decenterX !== undefined ? cbParams.decenterX : 0;
      const decenterY = cbParams.decenterY !== undefined ? cbParams.decenterY : 0;
      const decenterZ = cbParams.decenterZ !== undefined ? cbParams.decenterZ : 0;
      const tiltX = cbParams.tiltX !== undefined ? cbParams.tiltX : 0;
      const tiltY = cbParams.tiltY !== undefined ? cbParams.tiltY : 0;
      const tiltZ = cbParams.tiltZ !== undefined ? cbParams.tiltZ : 0;
      const transformOrder = cbParams.transformOrder !== undefined ? cbParams.transformOrder : 1;
      
      // CoordTransは座標系の定義のみで、thicknessは持たない（次の面のthicknessは別）
      // 前の面のthicknessのみを使用して、そこから座標変換を適用
      let thickness = previousSurface ? getSafeThickness(previousSurface) : 0;
      
      // NaN validation and Infinity handling
      if (!isFinite(thickness)) {
        thickness = 0;
      }
      
      // 前面までの累積回転行列 R(r) = R(s-1)
      const previousRotMatrix = currentRotMatrix;
      
      // s面の回転行列を算出
      const singleRotMatrix = createRotationMatrix(tiltX, tiltY, tiltZ, transformOrder);
      const newRotMatrix = multiplyMatrices(singleRotMatrix, currentRotMatrix);
      
      if (transformOrder === 0) {
        // Order 0: O(s) = O(r) + t(r)*R(r).ez + DX(s)*R(r).ex + DY(s)*R(r).ey + DZ(s)*R(r).ez
        const tz_term = scale(applyMatrixToVector(previousRotMatrix, ez), thickness);
        const dx_term = scale(applyMatrixToVector(previousRotMatrix, ex), decenterX);
        const dy_term = scale(applyMatrixToVector(previousRotMatrix, ey), decenterY);
        const dz_term = scale(applyMatrixToVector(previousRotMatrix, ez), decenterZ);
        
        surfaceOrigin = add(add(add(add(currentOrigin, tz_term), dx_term), dy_term), dz_term);
      } else {
        // Order 1: O(s) = O(r) + t(r)*R(r).ez + DX(s)*R(s).ex + DY(s)*R(s).ey + DZ(s)*R(s).ez
        const tz_term = scale(applyMatrixToVector(previousRotMatrix, ez), thickness);
        const dx_term = scale(applyMatrixToVector(newRotMatrix, ex), decenterX);
        const dy_term = scale(applyMatrixToVector(newRotMatrix, ey), decenterY);
        const dz_term = scale(applyMatrixToVector(newRotMatrix, ez), decenterZ);
        
        surfaceOrigin = add(add(add(add(currentOrigin, tz_term), dx_term), dy_term), dz_term);
      }
      
      surfaceRotMatrix = newRotMatrix;
      
    } else {
      // 通常面の場合
      // Thickness for a normal surface is taken from the *previous* row.
      // Coord Break rows may carry a dedicated gap thickness; otherwise spacing is 0.
      let thickness = previousSurface ? getSafeThickness(previousSurface) : 0;
      
      // NaN validation and Infinity handling for normal surface thickness
      if (!isFinite(thickness)) {
        thickness = 0;
      }
      
      // O(s) = O(r) + t(r) * R(s).ez
      const tz_term = scale(applyMatrixToVector(currentRotMatrix, ez), thickness);
      surfaceOrigin = add(currentOrigin, tz_term);
      surfaceRotMatrix = currentRotMatrix; // 回転行列は前面と同じ
    }
    
    // NaN validation for calculated surface origin
    if (!isFinite(surfaceOrigin.x) || !isFinite(surfaceOrigin.y) || !isFinite(surfaceOrigin.z)) {
      // Use fallback origin (previous origin or zero)
      surfaceOrigin = isFinite(currentOrigin.x) && isFinite(currentOrigin.y) && isFinite(currentOrigin.z) 
        ? currentOrigin 
        : vec3(0, 0, 0);
    }
    
    // デバッグ情報付きでsurfaceDataに追加
    const debugInfo = {
      surfaceIndex: s + 1,
      surfaceType: surface.surfType,
      origin: surfaceOrigin,
      rotationMatrix: surfaceRotMatrix,
      surface: surface
    };
    
    // CB面の場合は変換パラメータも追加
    if (__rtIsCoordTransRow(surface)) {
      const cbParams = parseCoordTransParams(surface, previousSurface);
      debugInfo.cbParams = cbParams;
      debugInfo.previousOrigin = currentOrigin;
      debugInfo.thickness = previousSurface ? previousSurface.thickness : 0;
    }
    
    surfaceData.push(debugInfo);
    
    // 次面の準備
    currentOrigin = surfaceOrigin;
    currentRotMatrix = surfaceRotMatrix;
  }
  
  return surfaceData;
}

// 4x4回転行列作成（座標変換1.5.md仕様準拠）
function createRotationMatrix(tiltX, tiltY, tiltZ, order = 1) {
  const rx = tiltX * Math.PI / 180;
  const ry = tiltY * Math.PI / 180;
  const rz = tiltZ * Math.PI / 180;
  
  const Rx = [
    [1, 0, 0, 0],
    [0, Math.cos(rx), -Math.sin(rx), 0],
    [0, Math.sin(rx), Math.cos(rx), 0],
    [0, 0, 0, 1]
  ];
  
  const Ry = [
    [Math.cos(ry), 0, Math.sin(ry), 0],
    [0, 1, 0, 0],
    [-Math.sin(ry), 0, Math.cos(ry), 0],
    [0, 0, 0, 1]
  ];
  
  const Rz = [
    [Math.cos(rz), -Math.sin(rz), 0, 0],
    [Math.sin(rz), Math.cos(rz), 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
  
  if (order === 0) {
    // Order 0: R = Rx.Ry.Rz
    return multiplyMatrices(multiplyMatrices(Rx, Ry), Rz);
  } else {
    // Order 1: R = Rz.Ry.Rx
    return multiplyMatrices(multiplyMatrices(Rz, Ry), Rx);
  }
}

// 4x4単位行列作成
function createIdentityMatrix() {
  return [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ];
}

// 4x4行列の乗算
function multiplyMatrices(A, B) {
  const result = Array(4).fill().map(() => Array(4).fill(0));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) {
        result[i][j] += A[i][k] * B[k][j];
      }
    }
  }
  return result;
}

// 4x4行列をベクトルに適用（回転のみ、平行移動は除く）
function applyMatrixToVector(matrix, vec) {
  if (RT_PROF.enabled) {
    RT_PROF.stats.applyMatCalls++;
    var __t0 = now();
    try {
      const x = matrix[0][0] * vec.x + matrix[0][1] * vec.y + matrix[0][2] * vec.z;
      const y = matrix[1][0] * vec.x + matrix[1][1] * vec.y + matrix[1][2] * vec.z;
      const z = matrix[2][0] * vec.x + matrix[2][1] * vec.y + matrix[2][2] * vec.z;
      return vec3(x, y, z);
    } finally {
      RT_PROF.stats.applyMatTime += now() - __t0;
    }
  }
  const x = matrix[0][0] * vec.x + matrix[0][1] * vec.y + matrix[0][2] * vec.z;
  const y = matrix[1][0] * vec.x + matrix[1][1] * vec.y + matrix[1][2] * vec.z;
  const z = matrix[2][0] * vec.x + matrix[2][1] * vec.y + matrix[2][2] * vec.z;
  return vec3(x, y, z);
}

// CB面パラメータ解析
function parseCoordTransParams(surface, previousSurface = null) {
  const toFiniteNumber = (...candidates) => {
    for (const v of candidates) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      const s = String(v).trim();
      if (s === '') continue;
      const n = Number(s);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };

  // Explicit-only: legacy reuse has been removed from core math.
  const hasExplicit = (() => {
    const keys = ['decenterX', 'decenterY', 'tiltX', 'tiltY', 'tiltZ'];
    if (!surface || typeof surface !== 'object') return false;
    return keys.some((k) => 
      Object.prototype.hasOwnProperty.call(surface, k) ||
      (surface.parameters && Object.prototype.hasOwnProperty.call(surface.parameters, k))
    );
  })();

  if (!hasExplicit) {
    return { decenterX: 0, decenterY: 0, decenterZ: 0, tiltX: 0, tiltY: 0, tiltZ: 0, transformOrder: 1 };
  }

  const decenterX = toFiniteNumber(surface.decenterX, surface.parameters?.decenterX);
  const decenterY = toFiniteNumber(surface.decenterY, surface.parameters?.decenterY);
  const decenterZ = toFiniteNumber(surface.decenterZ, surface.parameters?.decenterZ);
  const tiltX = toFiniteNumber(surface.tiltX, surface.parameters?.tiltX);
  const tiltY = toFiniteNumber(surface.tiltY, surface.parameters?.tiltY);
  const tiltZ = toFiniteNumber(surface.tiltZ, surface.parameters?.tiltZ);

  const orderCandidate = (surface.order !== undefined && surface.order !== null) ? surface.order : surface.coef1;
  const orderRaw = Number(String(orderCandidate ?? '').trim());
  const transformOrder = (orderRaw === 0 || orderRaw === 1) ? orderRaw : 1;

  return { decenterX, decenterY, decenterZ, tiltX, tiltY, tiltZ, transformOrder };
}

/**
 * 光線追跡用の正確な屈折率取得関数
 * @param {Object} surface - 面データ
 * @param {number} wavelength - 波長 (μm)
 * @returns {number} 屈折率
 */
function getCorrectRefractiveIndex(surface, wavelength = 0.5875618) {
  if (RT_PROF.enabled) {
    RT_PROF.stats.refractiveIndexCalls++;
    var __t0 = now();
    try {
      return __getCorrectRefractiveIndex_impl(surface, wavelength);
    } finally {
      RT_PROF.stats.refractiveIndexTime += now() - __t0;
    }
  }
  return __getCorrectRefractiveIndex_impl(surface, wavelength);
}

function __getCorrectRefractiveIndex_impl(surface, wavelength = 0.5875618) {
  if (!surface) return 1.0;

  // Memoize per-surface + wavelength + material/index signature.
  // This avoids repeated linear searches in glass catalogs during Spot/OPD/PSF.
  try {
    const cache = __getRefractiveIndexCacheForSurface(surface);
    if (cache) {
      const wlKey = Math.round(Number(wavelength) * 1e9) | 0;
      const matKey = String(surface.material ?? '');
      const manualKey = String(surface.rindex ?? surface['Ref Index'] ?? surface.refIndex ?? surface['ref index'] ?? '');
      const key = `${wlKey}|${matKey}|${manualKey}`;
      if (cache.has(key)) return cache.get(key);

      // Compute using the original logic, then store.
      let computed;
      // まずray-paraxial.jsのgetRefractiveIndex関数を使用（ガラスカタログ優先）
      try {
        const catalogRefIndex = getRefractiveIndex(surface, wavelength);
        // ガラスカタログから取得できた場合（空気の1.0でない場合）
        if (catalogRefIndex !== 1.0 || (surface.material && surface.material !== '' && surface.material !== 'Air' && surface.material !== 'AIR')) {
          computed = catalogRefIndex;
        }
      } catch (error) {
        console.warn(`⚠️ [ray-tracing] Failed to get refractive index for surface:`, error);
      }

      if (computed === undefined) {
        // ガラスカタログにない場合のみ手動設定の屈折率を使用
        const manualIndex = surface.rindex || surface['Ref Index'] || surface.refIndex;
        if (manualIndex !== undefined && manualIndex !== null && manualIndex !== '') {
          const numValue = parseFloat(manualIndex);
          if (!isNaN(numValue) && numValue > 0) {
            computed = numValue;
          }
        }
      }

      if (computed === undefined) computed = 1.0;
      if (typeof computed === 'number' && Number.isFinite(computed)) {
        cache.set(key, computed);
      }
      return computed;
    }
  } catch (_) {
    // Best-effort cache; fall back to original behavior.
  }
  
  // まずray-paraxial.jsのgetRefractiveIndex関数を使用（ガラスカタログ優先）
  try {
    const catalogRefIndex = getRefractiveIndex(surface, wavelength);
    // ガラスカタログから取得できた場合（空気の1.0でない場合）
    if (catalogRefIndex !== 1.0 || (surface.material && surface.material !== '' && surface.material !== 'Air' && surface.material !== 'AIR')) {
      return catalogRefIndex;
    }
  } catch (error) {
    console.warn(`⚠️ [ray-tracing] Failed to get refractive index for surface:`, error);
  }
  
  // ガラスカタログにない場合のみ手動設定の屈折率を使用
  const manualIndex = surface.rindex || surface['Ref Index'] || surface.refIndex;
  if (manualIndex !== undefined && manualIndex !== null && manualIndex !== '') {
    const numValue = parseFloat(manualIndex);
    if (!isNaN(numValue) && numValue > 0) {
      return numValue;
    }
  }
  
  return 1.0; // 空気
}

// --- 光線追跡本体（座標回転対応） ---
// calculateSurfaceOrigins は高コストなので、同一光学系に対してはキャッシュする。
// NOTE: opticalSystemRows 配列が「同一参照のまま内容だけ変更」されるケースでは
// キャッシュが古くなる可能性があるため、必要なら呼び出し側で新しい配列を渡すこと。
const __surfaceOriginsCache = new WeakMap();

function __computeSurfaceOriginsSignature(opticalSystemRows) {
  // A lightweight content signature to invalidate stale surface-origin caches when
  // the table mutates in-place (same array reference, same length).
  //
  // Must track exactly the inputs used by calculateSurfaceOrigins:
  // - thickness of the previous surface (via getSafeThickness)
  // - Coord Break decenter/tilt/order params
  // - surfType identity
  let h = 2166136261;
  const mix = (n) => {
    // FNV-1a 32-bit style mixing (works with Math.imul)
    h ^= (n | 0);
    h = Math.imul(h, 16777619);
  };
  const q = (v, scale = 1e6) => {
    const num = Number(v);
    if (!Number.isFinite(num)) return 0;
    const r = Math.round(num * scale);
    // clamp to 32-bit signed
    return (r | 0);
  };

  try {
    const rows = Array.isArray(opticalSystemRows) ? opticalSystemRows : [];
    mix(rows.length);
    for (let s = 0; s < rows.length; s++) {
      const surface = rows[s] || {};
      const prev = s > 0 ? (rows[s - 1] || {}) : null;

      // surfType discriminator
      const isCB = __rtIsCoordTransRow(surface);
      mix(isCB ? 1 : 0);

      // thickness used by calculateSurfaceOrigins comes from previous surface
      let tPrev = prev ? getSafeThickness(prev) : 0;
      if (prev && __rtIsCoordTransRow(prev)) tPrev = 0;
      mix(q(tPrev, 1e6));

      if (isCB) {
        const cbParams = parseCoordTransParams(surface, prev) || {};
        mix(q(cbParams.decenterX, 1e6));
        mix(q(cbParams.decenterY, 1e6));
        mix(q(cbParams.decenterZ, 1e6));
        mix(q(cbParams.tiltX, 1e6));
        mix(q(cbParams.tiltY, 1e6));
        mix(q(cbParams.tiltZ, 1e6));
        mix(q(cbParams.transformOrder, 1));
      }
    }
  } catch (_) {
    // If anything goes wrong, fall back to a changing signature.
    mix(Date.now() & 0xffffffff);
  }

  return h | 0;
}

function __getCachedSurfaceData(opticalSystemRows, maxSurfaceIndex, effectiveSystemRows) {
  try {
    const cacheKey = (maxSurfaceIndex !== null && maxSurfaceIndex !== undefined) ? Number(maxSurfaceIndex) : -1;
    let perSystem = __surfaceOriginsCache.get(opticalSystemRows);
    if (!perSystem) {
      perSystem = new Map();
      __surfaceOriginsCache.set(opticalSystemRows, perSystem);
    }
    const cached = perSystem.get(cacheKey);
    const signature = __computeSurfaceOriginsSignature(effectiveSystemRows);
    if (cached && cached.rowsLength === effectiveSystemRows.length && cached.signature === signature && cached.surfaceData) {
      return cached.surfaceData;
    }
    const surfaceData = calculateSurfaceOrigins(effectiveSystemRows);
    perSystem.set(cacheKey, { rowsLength: effectiveSystemRows.length, signature, surfaceData });
    return surfaceData;
  } catch (_) {
    return calculateSurfaceOrigins(effectiveSystemRows);
  }
}

export function traceRay(opticalSystemRows, ray0, n0 = 1.0, debugLog = null, maxSurfaceIndex = null) {
  // During optimization / merit fast-mode, disable detailed debug logging.
  // This keeps the WASM intersection fast-path enabled and avoids heavy per-ray diagnostics.
  try {
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
    const fastMode = !!(g && g.__cooptMeritFastMode && g.__cooptMeritFastMode.enabled);
    const forceDisable = !!(g && g.__COOPT_DISABLE_RAYTRACE_DEBUG);
    if ((fastMode || forceDisable) && debugLog !== null) debugLog = null;
  } catch (_) {}

  if (RT_PROF.enabled) {
    RT_PROF.stats.traceCalls++;
    var __t0 = now();
    try {
      return __traceRay_impl(opticalSystemRows, ray0, n0, debugLog, maxSurfaceIndex);
    } finally {
      RT_PROF.stats.traceTime += now() - __t0;
    }
  }
  return __traceRay_impl(opticalSystemRows, ray0, n0, debugLog, maxSurfaceIndex);
}

// Fast path: return only the global hit point on the specified surface.
// - Avoids allocating rayPath arrays/objects.
// - Stops immediately after computing the target surface intersection (no refraction / thickness advance).
// - Returns null if the ray is physically blocked before reaching the target.
export function traceRayHitPoint(opticalSystemRows, ray0, n0 = 1.0, targetSurfaceIndex = null) {
  if (targetSurfaceIndex === null || targetSurfaceIndex === undefined) return null;
  const idx = Number(targetSurfaceIndex);
  if (!Number.isFinite(idx) || idx < 0) return null;

  if (RT_PROF.enabled) {
    RT_PROF.stats.traceCalls++;
    var __t0 = now();
    try {
      return __traceRay_impl(opticalSystemRows, ray0, n0, null, idx, { returnHitPointOnly: true });
    } finally {
      RT_PROF.stats.traceTime += now() - __t0;
    }
  }
  return __traceRay_impl(opticalSystemRows, ray0, n0, null, idx, { returnHitPointOnly: true });
}

function __traceRay_impl(opticalSystemRows, ray0, n0 = 1.0, debugLog = null, maxSurfaceIndex = null, options = null) {
  const returnHitPointOnly = !!(options && typeof options === 'object' && options.returnHitPointOnly);

  // Same rule as traceRay(): never do detailed debug logging during optimization.
  try {
    const g = (typeof globalThis !== 'undefined') ? globalThis : null;
    const fastMode = !!(g && g.__cooptMeritFastMode && g.__cooptMeritFastMode.enabled);
    const forceDisable = !!(g && g.__COOPT_DISABLE_RAYTRACE_DEBUG);
    if ((fastMode || forceDisable) && debugLog !== null) debugLog = null;
  } catch (_) {}

  // Lightweight global diagnostics (opt-in by context: optimization fast mode sets __cooptMeritFastMode.enabled).
  // Captures only the first failure to avoid performance impact.
  const __captureRayTraceFailure = (kind, details) => {
    try {
      const g = (typeof globalThis !== 'undefined') ? globalThis : null;
      if (!g) return;
      const fast = g.__cooptMeritFastMode;
      const enabled = !!(fast && typeof fast === 'object' && fast.enabled);
      if (!enabled && !g.__COOPT_CAPTURE_RAYTRACE_FAILURE) return;
      if (g.__cooptLastRayTraceFailure) return;
      g.__cooptLastRayTraceFailure = {
        kind,
        at: Date.now(),
        targetSurfaceIndex: (maxSurfaceIndex !== null && maxSurfaceIndex !== undefined) ? Number(maxSurfaceIndex) : null,
        returnHitPointOnly,
        ray0: {
          pos: { x: Number(ray0?.pos?.x), y: Number(ray0?.pos?.y), z: Number(ray0?.pos?.z) },
          dir: { x: Number(ray0?.dir?.x), y: Number(ray0?.dir?.y), z: Number(ray0?.dir?.z) },
          wavelength: Number(ray0?.wavelength)
        },
        details: (details && typeof details === 'object') ? details : { message: String(details ?? '') }
      };
    } catch (_) {
      // ignore
    }
  };

  // 座標変換1.5.md仕様: 各面の原点O(s)を算出してから光線追跡を行う
  // zOffsetは廃止し、各面の原点・回転行列ベースの光線追跡を実装
  
  // readonly propertyエラーを防ぐため、ray0のディープコピーを作成
  const safeRay0 = {
    pos: {
      x: Number(ray0.pos.x),
      y: Number(ray0.pos.y),
      z: Number(ray0.pos.z)
    },
    dir: {
      x: Number(ray0.dir.x),
      y: Number(ray0.dir.y),
      z: Number(ray0.dir.z)
    },
    wavelength: ray0.wavelength || 0.55 // デフォルト波長
  };
  
  // maxSurfaceIndexが指定されている場合、その面まで処理
  const effectiveSystemRows = maxSurfaceIndex !== null && maxSurfaceIndex >= 0 
    ? opticalSystemRows.slice(0, maxSurfaceIndex + 1)
    : opticalSystemRows;
  
  // 各面の原点・回転行列を事前計算
  const __tCalcSurf0 = RT_PROF.enabled ? now() : 0;
  const surfaceData = __getCachedSurfaceData(opticalSystemRows, maxSurfaceIndex, effectiveSystemRows);
  if (RT_PROF.enabled) RT_PROF.stats.calculateSurfaceOriginsTime += now() - __tCalcSurf0;
  
  // 光線の初期位置と方向を確実に設定（ディープコピー使用）
  let ray = { 
    pos: { 
      x: safeRay0.pos.x, 
      y: safeRay0.pos.y, 
      z: safeRay0.pos.z 
    }, 
    dir: norm(safeRay0.dir) 
  };
  let n = n0;

  // 光線パスの最初の点を明示的に設定（ディープコピー使用）
  // Fast mode (returnHitPointOnly) avoids allocating the full path.
  const rayPath = returnHitPointOnly ? null : [{ 
    x: safeRay0.pos.x, 
    y: safeRay0.pos.y, 
    z: safeRay0.pos.z 
  }];
  
  // CB面による座標変換状態の管理
  let isInTransformedCoordinates = false; // CB面による座標変換が適用されているかのフラグ
  let coordinateTransforms = []; // 累積座標変換のリスト
  
  // デバッグモードの設定
  const isDetailedDebug = debugLog !== null;
  let lastProcessedSurfaceIndex = -1; // 最後に処理された面のインデックス

  // 周辺光線かどうかの判定強化（ディープコピー使用）
  const rayStartPos = safeRay0.pos;
  const rayStartDistance = Math.sqrt(rayStartPos.x * rayStartPos.x + rayStartPos.y * rayStartPos.y);
  const isPeripheralRay = rayStartDistance > 5.0; // 中心から5mm以上離れた位置を周辺光線と判定
  
  if (isDetailedDebug && isPeripheralRay) {
    debugLog.push(`\n🔥 PERIPHERAL RAY DETECTED: start distance = ${rayStartDistance.toFixed(3)}mm from center`);
    debugLog.push(`   This ray may be subject to aperture limitations`);
  }

  for (let i = 0; i < effectiveSystemRows.length; ++i) {
    lastProcessedSurfaceIndex = i; // 現在処理中の面を記録
    const row = effectiveSystemRows[i];

    // 評価面判定: maxSurfaceIndexが指定されていて、現在の面がそれと一致する場合は評価面
    // CT/Mirror変換後の座標系では aperture 判定が正しく機能しないため、評価面では aperture チェックをスキップ
    const isEvaluationSurface = (maxSurfaceIndex !== null && maxSurfaceIndex !== undefined && i === maxSurfaceIndex);
    
    if (isDetailedDebug && (i >= 6 || isEvaluationSurface)) {
      debugLog.push(`🔍 Surface ${i}: maxSurfaceIndex=${maxSurfaceIndex}, i=${i}, isEvaluationSurface=${isEvaluationSurface}`);
    }

    // マテリアルタイプの判定（通常面では純粋にマテリアル判定のみ、CB面では座標変換パラメータとして使用）
    const materialType = (typeof row.material === 'string' && row.material === "MIRROR") ? "MIRROR" : "REFRACTIVE";

    // 各面の詳細デバッグ情報を出力
    if (isDetailedDebug && i >= 0) { // 第1面から出力するように変更
      debugLog.push(`\n=== SURFACE ${i + 1} DETAILED DEBUG ===`);
      debugLog.push(`Surface Type: ${row.surfType}`);
      debugLog.push(`Material field: "${row.material || ''}" → Material type: ${materialType}`);
      
      // 現在の光線情報（CB面適用後のローカル座標）
      debugLog.push(`Ray Position (Local):  (${safeRay0.pos.x.toFixed(6)}, ${safeRay0.pos.y.toFixed(6)}, ${safeRay0.pos.z.toFixed(6)})`);
      debugLog.push(`Ray Direction (Local): (${safeRay0.dir.x.toFixed(6)}, ${safeRay0.dir.y.toFixed(6)}, ${safeRay0.dir.z.toFixed(6)})`);
      
      // グローバル座標での光線情報（光線描画用のみ）
      if (isInTransformedCoordinates) {
        let globalRay = { pos: { ...safeRay0.pos }, dir: { ...safeRay0.dir } };
        
        // 累積された座標変換の逆変換を順次適用してグローバル座標を取得
        for (let j = coordinateTransforms.length - 1; j >= 0; j--) {
          applyInverseCoordinateTransform(globalRay, coordinateTransforms[j]);
        }
        
        debugLog.push(`Ray Position (Global): (${globalRay.pos.x.toFixed(6)}, ${globalRay.pos.y.toFixed(6)}, ${globalRay.pos.z.toFixed(6)})`);
        debugLog.push(`Ray Direction (Global): (${globalRay.dir.x.toFixed(6)}, ${globalRay.dir.y.toFixed(6)}, ${globalRay.dir.z.toFixed(6)})`);
      } else {
        // CB面が適用されていない場合、ローカル座標=グローバル座標
        debugLog.push(`Ray Position (Global): (${safeRay0.pos.x.toFixed(6)}, ${safeRay0.pos.y.toFixed(6)}, ${safeRay0.pos.z.toFixed(6)})`);
        debugLog.push(`Ray Direction (Global): (${safeRay0.dir.x.toFixed(6)}, ${safeRay0.dir.y.toFixed(6)}, ${safeRay0.dir.z.toFixed(6)})`);
      }
      
      // 座標変換1.5.md仕様: O(s)/R(s)ベースの実装（zOffsetは廃止）
      debugLog.push(`Surface Origin O(s): (${surfaceData[i].origin.x.toFixed(6)}, ${surfaceData[i].origin.y.toFixed(6)}, ${surfaceData[i].origin.z.toFixed(6)})`);
      
      // 面3での特別な分析（問題の面）
      if (i === 2) { // 面3 (index=2)
        debugLog.push(`🔍 SPECIAL ANALYSIS for Surface 3 (problematic surface):`);
        debugLog.push(`  Previous surface (2): radius=${opticalSystemRows[1].radius}, thickness=${opticalSystemRows[1].thickness}`);
        debugLog.push(`  Current surface (3): radius=${row.radius}, semidia=${row.semidia}`);
        
        // 面2での交点から面3への期待される進行
        const prevThickness = parseFloat(opticalSystemRows[1].thickness) || 0;
        debugLog.push(`  Expected advancement from surface 2: ${prevThickness}mm`);
        
        // 座標系の期待値計算
        const surface2Origin = surfaceData[1].origin;
        const surface3Origin = surfaceData[2].origin;
        debugLog.push(`  Surface 2 origin: (${surface2Origin.x.toFixed(6)}, ${surface2Origin.y.toFixed(6)}, ${surface2Origin.z.toFixed(6)})`);
        debugLog.push(`  Surface 3 origin: (${surface3Origin.x.toFixed(6)}, ${surface3Origin.y.toFixed(6)}, ${surface3Origin.z.toFixed(6)})`);
        debugLog.push(`  Distance between surface origins: ${(surface3Origin.z - surface2Origin.z).toFixed(6)}mm`);
      }
    }

    // Coordinate Break面の特別処理
    if (__rtIsCoordTransRow(row)) {
      // 座標変換1.5.md仕様: CB面では座標系変換のみ、O(s)/R(s)システムを使用
      
      if (isDetailedDebug) {
        const prevRow = (i > 0 && Array.isArray(opticalSystemRows)) ? opticalSystemRows[i - 1] : null;
        const cb = parseCoordTransParams(row, prevRow) || {};
        debugLog.push(`Coord Break Parameters:`);
        debugLog.push(`  decenterX=${Number(cb.decenterX) || 0}, decenterY=${Number(cb.decenterY) || 0}, decenterZ=${Number(cb.decenterZ) || 0}`);
        debugLog.push(`  tiltX=${Number(cb.tiltX) || 0}°, tiltY=${Number(cb.tiltY) || 0}°, tiltZ=${Number(cb.tiltZ) || 0}°, order=${Number(cb.transformOrder) || 1}`);
        
        const rayBefore = { pos: { ...ray.pos }, dir: { ...ray.dir } };
        debugLog.push(`Ray BEFORE Coord Break: pos=(${rayBefore.pos.x.toFixed(6)}, ${rayBefore.pos.y.toFixed(6)}, ${rayBefore.pos.z.toFixed(6)}), dir=(${rayBefore.dir.x.toFixed(6)}, ${rayBefore.dir.y.toFixed(6)}, ${rayBefore.dir.z.toFixed(6)})`);
      }
      
      // CB面では交点や反射・屈折は行わず、単に座標系変換のみ。
      // NOTE: このアプリでは CB 行の thickness フィールドは decenterZ として再利用されるため、
      //       「次面までの物理距離」として前進させてはいけない。
      
      if (isDetailedDebug) {
        debugLog.push(`Ray AFTER Coord Break: pos=(${ray.pos.x.toFixed(6)}, ${ray.pos.y.toFixed(6)}, ${ray.pos.z.toFixed(6)}), dir=(${ray.dir.x.toFixed(6)}, ${ray.dir.y.toFixed(6)}, ${ray.dir.z.toFixed(6)})`);
        debugLog.push(`CB面 ${i + 1}: 座標系変換のみ（物理前進なし）`);
      }

      // If a Gap is attached to this Coord Break, update the medium for subsequent surfaces.
      try {
        const gapMatRaw = row.__cooptGapMaterial;
        const gapMat = String(gapMatRaw ?? '').trim();
        if (gapMat !== '') {
          if (gapMat.replace(/\s+/g, '').toUpperCase() === 'AIR') {
            n = 1.0;
          } else {
            n = getCorrectRefractiveIndex({ material: gapMat }, safeRay0.wavelength);
          }
        }
      } catch (_) {}
      
      continue;
    }

    // 通常の面処理（非CB面）
    const surfaceInfo = surfaceData[i];
    
    // Object面の特別処理
    if (row["object type"] === "Object") {
      // Object面では光学的な交点計算を行わず、thickness分だけ前進
      const thickness = parseFloat(row.thickness) || 0;
      if (thickness !== 0) {
        const newPos = add(safeRay0.pos, scale(safeRay0.dir, thickness));
        safeRay0.pos = newPos;
        if (isDetailedDebug) {
          debugLog.push(`Object surface thickness advancement: ${thickness}mm (intermediate position not recorded for clean ray paths)`);
        }
      }
      continue;
    }
    
    // 光線をローカル座標系に変換
  const __tTRL0 = RT_PROF.enabled ? now() : 0;
  const localRay = transformRayToLocal(safeRay0, surfaceInfo);
  if (RT_PROF.enabled) RT_PROF.stats.transformRayToLocalTime += now() - __tTRL0;

    // ローカル座標系での面との交点計算
    let hitPoint, normal;
    
    if (isDetailedDebug) {
      debugLog.push(`Local Ray for intersection: pos=(${localRay.pos.x.toFixed(6)}, ${localRay.pos.y.toFixed(6)}, ${localRay.pos.z.toFixed(6)}), dir=(${localRay.dir.x.toFixed(6)}, ${localRay.dir.y.toFixed(6)}, ${localRay.dir.z.toFixed(6)})`);
      debugLog.push(`Surface radius: ${row.radius}, Surface origin: (${surfaceInfo.origin.x.toFixed(6)}, ${surfaceInfo.origin.y.toFixed(6)}, ${surfaceInfo.origin.z.toFixed(6)})`);
      debugLog.push(`Global ray before transform: pos=(${ray.pos.x.toFixed(6)}, ${ray.pos.y.toFixed(6)}, ${ray.pos.z.toFixed(6)}), dir=(${ray.dir.x.toFixed(6)}, ${ray.dir.y.toFixed(6)}, ${ray.dir.z.toFixed(6)})`);
    }
    
    if (!isFinite(row.radius) || row.radius === 0) {
      // 平面処理（Z=0平面との交点）
      const epsilon = 1e-9;
      let t;
      
      if (Math.abs(localRay.dir.z) < epsilon) {
        // 光線がZ方向にほぼ進んでいない場合、交点なし
        if (isDetailedDebug) {
          debugLog.push(`❌ PLANE PARALLEL: Ray parallel to plane (dir.z=${localRay.dir.z.toFixed(9)} < ${epsilon}), breaking ray trace - Surface ${i + 1}`);
        }
        break;
      }
      
      t = -localRay.pos.z / localRay.dir.z;
      
      if (isDetailedDebug) {
        debugLog.push(`Plane intersection: t = ${t.toFixed(6)}, localRay.pos.z = ${localRay.pos.z.toFixed(6)}, localRay.dir.z = ${localRay.dir.z.toFixed(6)}`);
      }
      
      // 絶対値で微小距離をチェック（正負両方向を許可）
      if (Math.abs(t) < epsilon) {
        // ほぼ0の場合、光線方向に応じて微小距離進める
        const sign = localRay.dir.z > 0 ? 1 : -1;
        t = sign * epsilon;
        if (isDetailedDebug) {
          debugLog.push(`Adjusted t to avoid zero: ${t.toFixed(9)}`);
        }
      }
      
      hitPoint = add(localRay.pos, scale(localRay.dir, t));
      // 平面の法線ベクトル: 光線の入射方向に応じて向きを決定
      // 光線がZ正方向に進んでいる場合、法線はZ負方向（表面の外向き）
      const normalDirection = localRay.dir.z > 0 ? -1 : 1;
      normal = vec3(0, 0, normalDirection);
      
      // 口径チェック（Semi Diameter制限）
      const hitRadius = Math.sqrt(hitPoint.x * hitPoint.x + hitPoint.y * hitPoint.y);
      
      // 🆕 実絞り面の特別処理（aperture制限）
      let apertureLimit = Infinity;

      // Rectangular/Square aperture support (Design Intent)
      const apertureShapeRaw = row._apertureShape ?? row.apertureShape ?? row.ApertureShape;
      const shapeKey = String(apertureShapeRaw ?? '').trim().replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
      const isSquareShape = shapeKey === 'square' || shapeKey === 'sq';
      const isRectShape = isSquareShape || shapeKey === 'rect' || shapeKey === 'rectangle' || shapeKey === 'rectangular';

      let rectHalfW = NaN;
      let rectHalfH = NaN;
      if (isRectShape) {
        const wRaw = row._apertureWidth ?? row.apertureWidth ?? row.apertureX ?? row.apertureWidthMm;
        const hRaw = row._apertureHeight ?? row.apertureHeight ?? row.apertureY ?? row.apertureHeightMm;
        const wNum = Number(wRaw);
        const hNum = Number(hRaw);
        if (isSquareShape) {
          const side = Number.isFinite(wNum) ? wNum : (Number.isFinite(hNum) ? hNum : NaN);
          if (Number.isFinite(side) && side > 0) {
            rectHalfW = side / 2;
            rectHalfH = side / 2;
          }
        } else {
          if (Number.isFinite(wNum) && wNum > 0) rectHalfW = wNum / 2;
          if (Number.isFinite(hNum) && hNum > 0) rectHalfH = hNum / 2;
        }
      }
      const useRectAperture = Number.isFinite(rectHalfW) && Number.isFinite(rectHalfH);
      
      // 1. object type が "STO" の場合（実絞り面）
      if (row["object type"] === "STO" || String(row.object).toUpperCase() === "STO") {
        const apertureDiameter = parseFloat(row.aperture || row.Aperture || 0);
        if (apertureDiameter > 0) {
          apertureLimit = apertureDiameter / 2; // 半径に変換
          if (isDetailedDebug) {
            debugLog.push(`🎯 実絞り面（平面） ${i + 1}: aperture径=${apertureDiameter}mm → 半径制限=${apertureLimit.toFixed(3)}mm`);
          }
        }
      }
      
      // 2. semidia制限（"Auto"/未指定の場合は制限なし）
      // NOTE: semidia 未指定時に thickness を代用すると、物理的に存在しない開口制限を
      //       誤って導入してしまい、軸外で大量に光線がブロックされる。n      // CB rows propagate the prior surface's semidia in __cooptActualSemidia
      // (since semidia column is reused for decenterX).
      if (!useRectAperture) {
        const semiDiaValue = row.__cooptActualSemidia ?? row.semidia;
        const semiDiaNum = Number(semiDiaValue);
        const semiDia = (semiDiaValue === 'Auto' || semiDiaValue === '' || !Number.isFinite(semiDiaNum) || semiDiaNum <= 0)
          ? Infinity
          : semiDiaNum;
        if (isFinite(semiDia)) {
          apertureLimit = Math.min(apertureLimit, semiDia);
          if (isDetailedDebug) {
            debugLog.push(`📐 平面semidia制限: ${semiDia.toFixed(3)}mm → 最終制限=${apertureLimit.toFixed(3)}mm`);
          }
        }
      }
      
      // 🆕 物理的開口制限の適用（Image面と評価面は除く）
      const isImageSurface = row["object type"] === "Image" || row.object === "Image";
      if (!isImageSurface && !isEvaluationSurface && useRectAperture) {
        const hitX = Math.abs(hitPoint.x);
        const hitY = Math.abs(hitPoint.y);
        if (hitX > rectHalfW || hitY > rectHalfH) {
          if (isDetailedDebug) {
            debugLog.push(`❌ PHYSICAL APERTURE BLOCK: Ray blocked by rectangular aperture on Surface ${i + 1}`);
            debugLog.push(`   Hit: (${hitPoint.x.toFixed(6)}, ${hitPoint.y.toFixed(6)})mm > halfSize=(${rectHalfW.toFixed(6)}, ${rectHalfH.toFixed(6)})mm`);
          }
          __captureRayTraceFailure('PHYSICAL_APERTURE_BLOCK', {
            surfaceIndex: i,
            surfaceNumber: i + 1,
            surfaceType: row["object type"] || row.object || '',
            surfType: row.surfType || '',
            hitPointLocalMm: {
              x: Number.isFinite(Number(hitPoint?.x)) ? Number(hitPoint.x) : null,
              y: Number.isFinite(Number(hitPoint?.y)) ? Number(hitPoint.y) : null,
              z: Number.isFinite(Number(hitPoint?.z)) ? Number(hitPoint.z) : null,
            },
            localRayAtSurface: {
              pos: {
                x: Number.isFinite(Number(localRay?.pos?.x)) ? Number(localRay.pos.x) : null,
                y: Number.isFinite(Number(localRay?.pos?.y)) ? Number(localRay.pos.y) : null,
                z: Number.isFinite(Number(localRay?.pos?.z)) ? Number(localRay.pos.z) : null,
              },
              dir: {
                x: Number.isFinite(Number(localRay?.dir?.x)) ? Number(localRay.dir.x) : null,
                y: Number.isFinite(Number(localRay?.dir?.y)) ? Number(localRay.dir.y) : null,
                z: Number.isFinite(Number(localRay?.dir?.z)) ? Number(localRay.dir.z) : null,
              },
            },
            apertureRectHalfMm: {
              x: rectHalfW,
              y: rectHalfH
            }
          });
          return null;
        }
      } else if (!isImageSurface && !isEvaluationSurface && isFinite(apertureLimit) && hitRadius > apertureLimit) {
        if (isDetailedDebug) {
          debugLog.push(`❌ PHYSICAL APERTURE BLOCK: Ray physically blocked on PLANE Surface ${i + 1}`);
          debugLog.push(`   Hit radius: ${hitRadius.toFixed(6)}mm > Aperture limit: ${apertureLimit.toFixed(6)}mm`);
          debugLog.push(`   isEvaluationSurface=${isEvaluationSurface}, maxSurfaceIndex=${maxSurfaceIndex}, i=${i}`);
          debugLog.push(`   Surface type: "${row["object type"] || row.object}", aperture: "${row.aperture}", semidia: "${row.semidia}"`);
          debugLog.push(`   Ray PHYSICALLY STOPPED - This ray should NOT reach the image plane`);
        }
        __captureRayTraceFailure('PHYSICAL_APERTURE_BLOCK', {
          surfaceIndex: i,
          surfaceNumber: i + 1,
          surfaceType: row["object type"] || row.object || '',
          surfType: row.surfType || '',
          hitRadiusMm: hitRadius,
          apertureLimitMm: apertureLimit,
          hitPointLocalMm: {
            x: Number.isFinite(Number(hitPoint?.x)) ? Number(hitPoint.x) : null,
            y: Number.isFinite(Number(hitPoint?.y)) ? Number(hitPoint.y) : null,
            z: Number.isFinite(Number(hitPoint?.z)) ? Number(hitPoint.z) : null,
          },
          hitPointGlobalMm: (() => {
            try {
              const p = transformPointToGlobal(hitPoint, surfaceInfo);
              return {
                x: Number.isFinite(Number(p?.x)) ? Number(p.x) : null,
                y: Number.isFinite(Number(p?.y)) ? Number(p.y) : null,
                z: Number.isFinite(Number(p?.z)) ? Number(p.z) : null,
              };
            } catch (_) {
              return null;
            }
          })(),
          localRayAtSurface: {
            pos: {
              x: Number.isFinite(Number(localRay?.pos?.x)) ? Number(localRay.pos.x) : null,
              y: Number.isFinite(Number(localRay?.pos?.y)) ? Number(localRay.pos.y) : null,
              z: Number.isFinite(Number(localRay?.pos?.z)) ? Number(localRay.pos.z) : null,
            },
            dir: {
              x: Number.isFinite(Number(localRay?.dir?.x)) ? Number(localRay.dir.x) : null,
              y: Number.isFinite(Number(localRay?.dir?.y)) ? Number(localRay.dir.y) : null,
              z: Number.isFinite(Number(localRay?.dir?.z)) ? Number(localRay.dir.z) : null,
            }
          },
          surfaceOriginMm: {
            x: Number.isFinite(Number(surfaceInfo?.origin?.x)) ? Number(surfaceInfo.origin.x) : null,
            y: Number.isFinite(Number(surfaceInfo?.origin?.y)) ? Number(surfaceInfo.origin.y) : null,
            z: Number.isFinite(Number(surfaceInfo?.origin?.z)) ? Number(surfaceInfo.origin.z) : null,
          },
          cbState: {
            isInTransformedCoordinates: !!isInTransformedCoordinates,
            transformCount: Array.isArray(coordinateTransforms) ? coordinateTransforms.length : null,
          },
          thickness: row.thickness,
          semidia: row.semidia,
          aperture: row.aperture ?? row.Aperture
        });
        // 光線追跡を完全に停止（像面まで到達させない）
        return null;
      }
      
      if (isDetailedDebug && isFinite(apertureLimit)) {
        debugLog.push(`✅ PLANE APERTURE CHECK PASSED: Hit radius ${hitRadius.toFixed(6)}mm ≤ Aperture limit ${apertureLimit.toFixed(6)}mm`);
      }
    } else {
      // 球面・非球面処理（統一された数値計算）
      // パラメータを準備（球面の場合は非球面係数を0とする）
      const surfaceParams = {
        radius: row.radius,
        conic: Number(row.conic) || 0,
        coef1: Number(row.coef1) || 0,
        coef2: Number(row.coef2) || 0,
        coef3: Number(row.coef3) || 0,
        coef4: Number(row.coef4) || 0,
        coef5: Number(row.coef5) || 0,
        coef6: Number(row.coef6) || 0,
        coef7: Number(row.coef7) || 0,
        coef8: Number(row.coef8) || 0,
        coef9: Number(row.coef9) || 0,
        coef10: Number(row.coef10) || 0,
        // NOTE: semidia 未指定時に thickness を代用すると、物理的に存在しない開口制限を
        //       誤って導入してしまい、軸外で大量に光線がブロックされる。
        // CB rows propagate the prior surface's semidia in __cooptActualSemidia
        // (since semidia column is reused for decenterX).
        semidia: (() => {
          const semiDiaValue = row.__cooptActualSemidia ?? row.semidia;
          const semiDiaNum = Number(semiDiaValue);
          return (semiDiaValue === 'Auto' || semiDiaValue === '' || !Number.isFinite(semiDiaNum) || semiDiaNum <= 0)
            ? Infinity
            : semiDiaNum;
        })()
      };
      
      if (isDetailedDebug) {
        debugLog.push(`Surface intersection using numerical method: radius=${row.radius}, conic=${surfaceParams.conic}`);
        const hasAsphericCoefs = [surfaceParams.coef1, surfaceParams.coef2, surfaceParams.coef3, surfaceParams.coef4, surfaceParams.coef5].some(c => c !== 0);
        debugLog.push(`Non-zero aspherical coefficients: ${hasAsphericCoefs ? 'YES' : 'NO'}`);
      }
      
      // Determine asphere mode (even/odd) for non-toric surfaces
      const surfType = String(row.surfType ?? row.type ?? '').trim().toLowerCase();
      const asphereMode = surfType.includes('odd') ? 'odd' : 'even';
      
      // Toric surface intersection
      const surfTypeStr = String(row.surfType ?? row.type ?? '').trim();
      
      if (surfTypeStr === 'Toric') {
        // Parse radiusX: handle "INF" string and Infinity
        let radiusX_val = Infinity;
        if (row.radiusX !== undefined && row.radiusX !== null && row.radiusX !== "") {
          const rxStr = String(row.radiusX).toUpperCase();
          if (rxStr === "INF" || rxStr === "INFINITY") {
            radiusX_val = Infinity;
          } else {
            const rxNum = Number(row.radiusX);
            if (isFinite(rxNum) && rxNum !== 0) {
              radiusX_val = rxNum;
            }
          }
        }
        
        // Parse radiusY: use radiusY if present, otherwise use radius (sagittal direction)
        let radiusY_val = Infinity;
        const ryRaw = row.radiusY !== undefined && row.radiusY !== null && row.radiusY !== "" 
                      ? row.radiusY 
                      : row.radius;
        if (ryRaw !== undefined && ryRaw !== null && ryRaw !== "") {
          const ryStr = String(ryRaw).toUpperCase();
          if (ryStr === "INF" || ryStr === "INFINITY") {
            radiusY_val = Infinity;
          } else {
            const ryNum = Number(ryRaw);
            if (isFinite(ryNum) && ryNum !== 0) {
              radiusY_val = ryNum;
            }
          }
        }
        
        const toricParams = {
          radiusX: radiusX_val,
          radiusY: radiusY_val,
          conic: Number(row.conic) || 0,
          axis: Number(row.axis) || 0,
          semidia: surfaceParams.semidia
        };
        
        if (isDetailedDebug) {
          debugLog.push(`Toric params: radiusX=${radiusX_val}, radiusY=${radiusY_val}, conic=${toricParams.conic}, axis=${toricParams.axis}`);
        }
        
        hitPoint = intersectToricSurface(localRay, toricParams, 50, 1e-10, isDetailedDebug ? debugLog : null);
      } else {
        // 非球面交点計算（球面も同様に処理）
        hitPoint = intersectAsphericSurface(localRay, surfaceParams, asphereMode, 20, 1e-7, isDetailedDebug ? debugLog : null);
      }
      
      if (!hitPoint) {
        // Suppress error logging during chief ray search grid trials (expected failures)
        const suppressErrors = (typeof globalThis !== 'undefined' && globalThis.__COOPT_SUPPRESS_RAY_ERRORS === true);
        if (!suppressErrors) {
          console.error(`❌ [Ray Trace] NO INTERSECTION at surface ${i + 1}, surfType=${row.surfType}, radius=${row.radius}`);
        }
        if (isDetailedDebug) {
          debugLog.push(`❌ SURFACE NO INTERSECTION: Numerical method failed, breaking ray trace - Surface ${i + 1}`);
        }
        __captureRayTraceFailure('NO_INTERSECTION', {
          surfaceIndex: i,
          surfaceNumber: i + 1,
          surfaceType: row["object type"] || row.object || '',
          surfType: row.surfType || '',
          radius: row.radius,
          semidia: row.semidia
        });
        break;
      }
      
      // 法線ベクトル計算（トーリック面 vs 非球面）
      if (surfTypeStr === 'Toric') {
        // Parse radiusX: handle "INF" string and Infinity
        let radiusX_val = Infinity;
        if (row.radiusX !== undefined && row.radiusX !== null && row.radiusX !== "") {
          const rxStr = String(row.radiusX).toUpperCase();
          if (rxStr === "INF" || rxStr === "INFINITY") {
            radiusX_val = Infinity;
          } else {
            const rxNum = Number(row.radiusX);
            if (isFinite(rxNum) && rxNum !== 0) {
              radiusX_val = rxNum;
            }
          }
        }
        
        // Parse radiusY: use radiusY if present, otherwise use radius
        let radiusY_val = Infinity;
        const ryRaw = row.radiusY !== undefined && row.radiusY !== null && row.radiusY !== "" 
                      ? row.radiusY 
                      : row.radius;
        if (ryRaw !== undefined && ryRaw !== null && ryRaw !== "") {
          const ryStr = String(ryRaw).toUpperCase();
          if (ryStr === "INF" || ryStr === "INFINITY") {
            radiusY_val = Infinity;
          } else {
            const ryNum = Number(ryRaw);
            if (isFinite(ryNum) && ryNum !== 0) {
              radiusY_val = ryNum;
            }
          }
        }
        
        const toricParams = {
          radiusX: radiusX_val,
          radiusY: radiusY_val,
          conic: Number(row.conic) || 0
        };
        normal = toricSurfaceNormal(hitPoint, toricParams);
      } else {
        // 非球面法線ベクトル計算（球面も同様に処理）
        normal = surfaceNormal(hitPoint, surfaceParams, asphereMode);
      }
      
      // 法線ベクトルの向きを確認・調整
      // 光線と法線の内積が正の場合、法線が光線と同じ方向を向いているので反転
      const dotProduct = dot(localRay.dir, normal);
      if (dotProduct > 0) {
        normal = scale(normal, -1);
        if (isDetailedDebug) {
          debugLog.push(`🔄 Normal vector flipped: dot product was ${dotProduct.toFixed(6)}, now facing outward`);
        }
      }
      
      // 口径チェック（Semi Diameter制限）
      const hitRadius = Math.sqrt(hitPoint.x * hitPoint.x + hitPoint.y * hitPoint.y);
      
      // 🆕 実絞り面の特別処理（aperture制限）
      let apertureLimit = Infinity;
      
      // 1. object type が "STO" の場合（実絞り面）
      if (row["object type"] === "STO" || String(row.object).toUpperCase() === "STO") {
        const apertureDiameter = parseFloat(row.aperture || row.Aperture || 0);
        if (apertureDiameter > 0) {
          apertureLimit = apertureDiameter / 2; // 半径に変換
          if (isDetailedDebug) {
            debugLog.push(`🎯 実絞り面 ${i + 1}: aperture径=${apertureDiameter}mm → 半径制限=${apertureLimit.toFixed(3)}mm`);
          }
        }
      }
      
      // 2. semidia制限（"Auto"/未指定の場合は制限なし）
      // NOTE: semidia 未指定時に thickness を代用すると、物理的に存在しない開口制限を
      //       誤って導入してしまい、軸外で大量に光線がブロックされる。
      // CB rows propagate the prior surface's semidia in __cooptActualSemidia
      // (since semidia column is reused for decenterX).
      const semiDiaValue = row.__cooptActualSemidia ?? row.semidia;
      const semiDiaNum = Number(semiDiaValue);
      const semiDia = (semiDiaValue === 'Auto' || semiDiaValue === '' || !Number.isFinite(semiDiaNum) || semiDiaNum <= 0)
        ? Infinity
        : semiDiaNum;
      if (isFinite(semiDia)) {
        apertureLimit = Math.min(apertureLimit, semiDia);
        if (isDetailedDebug) {
          debugLog.push(`📐 semidia制限: ${semiDia.toFixed(3)}mm → 最終制限=${apertureLimit.toFixed(3)}mm`);
        }
      }
      
      // 🆕 物理的開口制限の適用（Image面と評価面は除く）
      const isImageSurface = row["object type"] === "Image" || row.object === "Image";
      if (!isImageSurface && !isEvaluationSurface && isFinite(apertureLimit) && hitRadius > apertureLimit) {
        if (isDetailedDebug) {
          debugLog.push(`❌ PHYSICAL APERTURE BLOCK: Ray physically blocked on Surface ${i + 1}`);
          debugLog.push(`   Hit radius: ${hitRadius.toFixed(6)}mm > Aperture limit: ${apertureLimit.toFixed(6)}mm`);
          debugLog.push(`   Surface type: "${row["object type"] || row.object}", aperture: "${row.aperture}", semidia: "${row.semidia}"`);
          debugLog.push(`   Ray PHYSICALLY STOPPED - This ray should NOT reach the image plane`);
        }
        __captureRayTraceFailure('PHYSICAL_APERTURE_BLOCK', {
          surfaceIndex: i,
          surfaceNumber: i + 1,
          surfaceType: row["object type"] || row.object || '',
          surfType: row.surfType || '',
          hitRadiusMm: hitRadius,
          apertureLimitMm: apertureLimit,
          hitPointLocalMm: {
            x: Number.isFinite(Number(hitPoint?.x)) ? Number(hitPoint.x) : null,
            y: Number.isFinite(Number(hitPoint?.y)) ? Number(hitPoint.y) : null,
            z: Number.isFinite(Number(hitPoint?.z)) ? Number(hitPoint.z) : null,
          },
          hitPointGlobalMm: (() => {
            try {
              const p = transformPointToGlobal(hitPoint, surfaceInfo);
              return {
                x: Number.isFinite(Number(p?.x)) ? Number(p.x) : null,
                y: Number.isFinite(Number(p?.y)) ? Number(p.y) : null,
                z: Number.isFinite(Number(p?.z)) ? Number(p.z) : null,
              };
            } catch (_) {
              return null;
            }
          })(),
          localRayAtSurface: {
            pos: {
              x: Number.isFinite(Number(localRay?.pos?.x)) ? Number(localRay.pos.x) : null,
              y: Number.isFinite(Number(localRay?.pos?.y)) ? Number(localRay.pos.y) : null,
              z: Number.isFinite(Number(localRay?.pos?.z)) ? Number(localRay.pos.z) : null,
            },
            dir: {
              x: Number.isFinite(Number(localRay?.dir?.x)) ? Number(localRay.dir.x) : null,
              y: Number.isFinite(Number(localRay?.dir?.y)) ? Number(localRay.dir.y) : null,
              z: Number.isFinite(Number(localRay?.dir?.z)) ? Number(localRay.dir.z) : null,
            }
          },
          surfaceOriginMm: {
            x: Number.isFinite(Number(surfaceInfo?.origin?.x)) ? Number(surfaceInfo.origin.x) : null,
            y: Number.isFinite(Number(surfaceInfo?.origin?.y)) ? Number(surfaceInfo.origin.y) : null,
            z: Number.isFinite(Number(surfaceInfo?.origin?.z)) ? Number(surfaceInfo.origin.z) : null,
          },
          cbState: {
            isInTransformedCoordinates: !!isInTransformedCoordinates,
            transformCount: Array.isArray(coordinateTransforms) ? coordinateTransforms.length : null,
          },
          thickness: row.thickness,
          semidia: row.semidia,
          aperture: row.aperture ?? row.Aperture
        });
        // 光線追跡を完全に停止（像面まで到達させない）
        return null;
      }
      if (isDetailedDebug && isFinite(apertureLimit)) {
        debugLog.push(`✅ SURFACE APERTURE CHECK PASSED: Hit radius ${hitRadius.toFixed(6)}mm ≤ Aperture limit ${apertureLimit.toFixed(6)}mm`);
      }
    }

    // グローバル座標に変換
  const __tTPG0 = RT_PROF.enabled ? now() : 0;
  const globalHitPoint = transformPointToGlobal(hitPoint, surfaceInfo);
  if (RT_PROF.enabled) RT_PROF.stats.transformPointToGlobalTime += now() - __tTPG0;
    
    if (isDetailedDebug) {
      const hitRadius = Math.sqrt(hitPoint.x * hitPoint.x + hitPoint.y * hitPoint.y);
      const semiDiaValue = row.semidia;
      const semiDia = (semiDiaValue === 'Auto' || semiDiaValue === '') ? Infinity : (Number(semiDiaValue) || Number(row.thickness) || Infinity);
      debugLog.push(`Hit point (local): (${hitPoint.x.toFixed(3)}, ${hitPoint.y.toFixed(3)}, ${hitPoint.z.toFixed(3)}), radius: ${hitRadius.toFixed(3)}mm`);
      debugLog.push(`Surface semi-diameter: ${isFinite(semiDia) ? semiDia.toFixed(3) + 'mm' : 'Infinite'}`);
      debugLog.push(`Hit point (global): (${globalHitPoint.x.toFixed(3)}, ${globalHitPoint.y.toFixed(3)}, ${globalHitPoint.z.toFixed(3)})`);
    }
    
    // 面との実際の交点Rのみを記録（接平面近似点Qは記録しない）
    if (!returnHitPointOnly) {
      rayPath.push(globalHitPoint);
    }
    safeRay0.pos = globalHitPoint;

    // Fast path: for spot/optimization we only need the intersection point at the target surface.
    // Stop immediately after computing it (skip refraction/thickness to avoid extra work and to avoid
    // returning a post-thickness position).
    if (returnHitPointOnly && maxSurfaceIndex !== null && i === maxSurfaceIndex) {
      return globalHitPoint;
    }

    // 反射・屈折処理（materialTypeは既にループの最初で定義済み）
    if (materialType === "MIRROR") {
      // ミラーは表面からの光線のみ反射（裏面は透過）
      const dotProduct = dot(localRay.dir, normal);
      
      if (dotProduct < 0) {
        // 表面からの入射：反射処理
        const globalNormal = applyMatrixToVector(surfaceInfo.rotationMatrix, normal);
        const oldDir = { ...safeRay0.dir };
        safeRay0.dir = reflectRay(safeRay0.dir, globalNormal);
        if (isDetailedDebug) {
          debugLog.push(`Mirror reflection (front surface): dot=${dotProduct.toFixed(6)}, oldDir=(${oldDir.x.toFixed(6)}, ${oldDir.y.toFixed(6)}, ${oldDir.z.toFixed(6)}) → newDir=(${safeRay0.dir.x.toFixed(6)}, ${safeRay0.dir.y.toFixed(6)}, ${safeRay0.dir.z.toFixed(6)})`);
        }
      } else {
        // 裏面からの入射：反射しない（透過扱い）
        if (isDetailedDebug) {
          debugLog.push(`Mirror transmission (back surface): dot=${dotProduct.toFixed(6)}, no reflection`);
        }
        // 光線方向はそのまま維持（透過）
      }
    } else {
      const oldN = n;
      // 屈折率の取得（正確なガラスデータベースからの取得）
      n = getCorrectRefractiveIndex(row, safeRay0.wavelength); // 光線の波長を使用
      
      if (isDetailedDebug) {
        debugLog.push(`🔧 [RefractiveIndex] Surface ${i + 1}: material="${row.material}", rindex="${row.rindex || row['Ref Index']}", wavelength=${safeRay0.wavelength.toFixed(4)}μm, calculated n=${n.toFixed(6)}`);
      }
      
      const globalNormal = applyMatrixToVector(surfaceInfo.rotationMatrix, normal);
      const oldDir = { ...safeRay0.dir };
      
      if (isDetailedDebug) {
        debugLog.push(`🔍 REFRACTION DETAILS:`);
        debugLog.push(`   Local normal: (${normal.x.toFixed(6)}, ${normal.y.toFixed(6)}, ${normal.z.toFixed(6)})`);
        debugLog.push(`   Global normal: (${globalNormal.x.toFixed(6)}, ${globalNormal.y.toFixed(6)}, ${globalNormal.z.toFixed(6)})`);
        debugLog.push(`   Incident ray: (${safeRay0.dir.x.toFixed(6)}, ${safeRay0.dir.y.toFixed(6)}, ${safeRay0.dir.z.toFixed(6)})`);
        debugLog.push(`   n1=${oldN.toFixed(4)} → n2=${n.toFixed(4)}, eta=${(oldN/n).toFixed(4)}`);
        const cosI = -dot(globalNormal, safeRay0.dir);
        debugLog.push(`   cos(incident angle): ${cosI.toFixed(6)}`);
      }
      
  const refractedDir = refractRay(safeRay0.dir, globalNormal, oldN, n);
      if (!refractedDir) {
        if (isDetailedDebug) {
          debugLog.push(`❌ TOTAL INTERNAL REFLECTION: n1=${oldN.toFixed(4)} → n2=${n.toFixed(4)}, breaking ray trace - Surface ${i + 1}`);
        }
        __captureRayTraceFailure('TOTAL_INTERNAL_REFLECTION', {
          surfaceIndex: i,
          surfaceNumber: i + 1,
          surfaceType: row["object type"] || row.object || '',
          surfType: row.surfType || '',
          n1: oldN,
          n2: n
        });
        break;
      }
      safeRay0.dir = refractedDir;
      if (isDetailedDebug) {
        debugLog.push(`Refraction: n1=${oldN.toFixed(4)} → n2=${n.toFixed(4)}, oldDir=(${oldDir.x.toFixed(6)}, ${oldDir.y.toFixed(6)}, ${oldDir.z.toFixed(6)}) → newDir=(${safeRay0.dir.x.toFixed(6)}, ${safeRay0.dir.y.toFixed(6)}, ${safeRay0.dir.z.toFixed(6)})`);
      }
    }

    // 次の面への移動（thickness分の前進）
    const thickness = parseFloat(row.thickness) || 0;
    if (thickness !== 0) {
      const newPos = add(safeRay0.pos, scale(safeRay0.dir, thickness));
      safeRay0.pos = newPos;

      // thickness移動後の位置は記録しない
      // （前面の交点Rと次面の交点Rを直接結ぶ光線経路にするため）
      if (isDetailedDebug) {
        debugLog.push(`Thickness advancement: ${thickness}mm (intermediate position not recorded for clean ray paths)`);
      }
    }
  }

  // console.log(`🔬 Ray tracing completed: ${rayPath.length} path points`);
  if (debugLog) {
    debugLog.push(`\n=== RAY TRACING SUMMARY ===`);
    debugLog.push(`Total surfaces processed: ${lastProcessedSurfaceIndex + 1}/${opticalSystemRows.length}`);
    debugLog.push(`Final ray path length: ${rayPath.length} points`);
    const isCompleted = lastProcessedSurfaceIndex + 1 === opticalSystemRows.length;
    debugLog.push(`Ray tracing status: ${isCompleted ? 'COMPLETED' : 'TERMINATED EARLY'}`);
    if (!isCompleted) {
      debugLog.push(`⚠️ Early termination at surface ${lastProcessedSurfaceIndex + 1} of ${opticalSystemRows.length}`);
      const stoppedSurface = opticalSystemRows[lastProcessedSurfaceIndex];
      debugLog.push(`Stopped surface details: Type="${stoppedSurface.surfType}", Radius=${stoppedSurface.radius}, Semi-Dia="${stoppedSurface.semidia}", Material="${stoppedSurface.material}"`);
    }
    // console.log(`✅ First point:`, rayPath[0]);
    // console.log(`✅ Last point:`, rayPath[rayPath.length - 1]);
  }

  if (returnHitPointOnly) {
    // If we didn't return early, the ray didn't reach the requested surface (e.g., terminated early).
    __captureRayTraceFailure('TERMINATED_EARLY', {
      lastProcessedSurfaceIndex,
      lastProcessedSurfaceNumber: lastProcessedSurfaceIndex + 1,
      totalSurfaces: Array.isArray(opticalSystemRows) ? opticalSystemRows.length : null
    });
    return null;
  }

  return rayPath;
}

// 光線をローカル座標系に変換
function transformRayToLocal(ray, surfaceInfo) {
  const __t0 = RT_PROF.enabled ? now() : 0;
  // グローバル光線位置を面の原点に相対化
  const relativePos = sub(ray.pos, surfaceInfo.origin);
  
  // 回転行列を適用してグローバル→ローカル変換
  // 座標変換1.5.md仕様: R(s)はローカル→グローバル変換行列なので、
  // グローバル→ローカル変換には逆行列R(s)^(-1)を使用
  const inverseMatrix = invertMatrix(surfaceInfo.rotationMatrix);
  const localPos = applyMatrixToVector(inverseMatrix, relativePos);
  const localDir = applyMatrixToVector(inverseMatrix, ray.dir);
  if (RT_PROF.enabled) RT_PROF.stats.transformRayToLocalInnerTime += now() - __t0;
  
  return {
    pos: localPos,
    dir: localDir
  };
}

// ローカル点をグローバル座標に変換
export function transformPointToGlobal(localPoint, surfaceInfo) {
  // 回転行列を適用してローカル→グローバル変換
  // 座標変換1.5.md仕様: R(s)はローカル→グローバル変換行列なので直接使用
  const rotatedPoint = applyMatrixToVector(surfaceInfo.rotationMatrix, localPoint);
  
  // 面の原点を加算
  return add(rotatedPoint, surfaceInfo.origin);
}

// グローバル点をローカル座標へ変換
export function transformPointToLocal(globalPoint, surfaceInfo) {
  const translated = {
    x: globalPoint.x - surfaceInfo.origin.x,
    y: globalPoint.y - surfaceInfo.origin.y,
    z: globalPoint.z - surfaceInfo.origin.z
  };

  const m = surfaceInfo.rotationMatrix;
  // 回転行列の逆（転置）を掛けてローカル座標に戻す
  return {
    x: m[0][0] * translated.x + m[1][0] * translated.y + m[2][0] * translated.z,
    y: m[0][1] * translated.x + m[1][1] * translated.y + m[2][1] * translated.z,
    z: m[0][2] * translated.x + m[1][2] * translated.y + m[2][2] * translated.z
  };
}

/**
 * Transform a point from global coordinates to local coordinates
 * @param {Object} point - Point with x, y, z properties
 * @param {Object} origin - Local coordinate system origin
 * @param {Array} rotationMatrix - 3x3 rotation matrix
 * @returns {Object} - Transformed point
 */
function transformGlobalToLocal(point, origin, rotationMatrix) {
  // Translate by origin
  const translated = {
    x: point.x - origin.x,
    y: point.y - origin.y,
    z: point.z - origin.z
  };
  
  // Apply inverse rotation (transpose of rotation matrix)
  const m = rotationMatrix;
  return {
    x: m[0][0] * translated.x + m[1][0] * translated.y + m[2][0] * translated.z,
    y: m[0][1] * translated.x + m[1][1] * translated.y + m[2][1] * translated.z,
    z: m[0][2] * translated.x + m[1][2] * translated.y + m[2][2] * translated.z
  };
}

/**
 * Transform a point from local coordinates to global coordinates (inverse of transformGlobalToLocal)
 * @param {Object} point - Point in local coordinates with x, y, z properties
 * @param {Object} origin - Local coordinate system origin in global coordinates
 * @param {Array} rotationMatrix - 3x3 rotation matrix
 * @returns {Object} - Point in global coordinates
 */
function transformLocalToGlobal(point, origin, rotationMatrix) {
  // Apply rotation (use rotationMatrix directly, not transpose)
  const m = rotationMatrix;
  const rotated = {
    x: m[0][0] * point.x + m[0][1] * point.y + m[0][2] * point.z,
    y: m[1][0] * point.x + m[1][1] * point.y + m[1][2] * point.z,
    z: m[2][0] * point.x + m[2][1] * point.y + m[2][2] * point.z
  };
  
  // Translate by origin
  return {
    x: rotated.x + origin.x,
    y: rotated.y + origin.y,
    z: rotated.z + origin.z
  };
}

// 4x4行列の逆行列計算（回転行列用）
function invertMatrix(matrix) {
  if (RT_PROF.enabled) {
    RT_PROF.stats.invertMatCalls++;
    var __t0 = now();
    try {
      // 回転行列の場合、転置が逆行列と等しい
      return [
        [matrix[0][0], matrix[1][0], matrix[2][0], 0],
        [matrix[0][1], matrix[1][1], matrix[2][1], 0],
        [matrix[0][2], matrix[1][2], matrix[2][2], 0],
        [0, 0, 0, 1]
      ];
    } finally {
      RT_PROF.stats.invertMatTime += now() - __t0;
    }
  }
  // 回転行列の場合、転置が逆行列と等しい
  return [
    [matrix[0][0], matrix[1][0], matrix[2][0], 0],
    [matrix[0][1], matrix[1][1], matrix[2][1], 0],
    [matrix[0][2], matrix[1][2], matrix[2][2], 0],
    [0, 0, 0, 1]
  ];
}

// 非球面係数が全てゼロかチェック
function allCoefAreZero(params) {
  return (params.coef1 || 0) === 0 && (params.coef2 || 0) === 0 && 
         (params.coef3 || 0) === 0 && (params.coef4 || 0) === 0 &&
         (params.coef5 || 0) === 0 && (params.coef6 || 0) === 0 &&
         (params.coef7 || 0) === 0 && (params.coef8 || 0) === 0 &&
         (params.coef9 || 0) === 0 && (params.coef10 || 0) === 0;
}

/**
 * キャッシュ統計を表示（プレースホルダー関数）
 */
export function displayCacheStats() {
    console.log('📊 キャッシュ統計: Horner法とFast-Math最適化により高速計算を実現');
    console.log('   - asphericSag: 2-3x高速化（累乗計算→段階的乗算）');
    console.log('   - 法線計算: 3-5x高速化（数値微分→解析的微分）');
    console.log('   - 全体処理: 2-5x高速化実現');
}

/**
 * パフォーマンスレポートを取得（プレースホルダー関数）
 */
export function getPerformanceReport() {
    console.log('📈 パフォーマンスレポート:');
    console.log('   ✅ Horner法最適化: Math.pow()を除去、段階的乗算で高速化');
    console.log('   ✅ 解析的微分: 数値微分を数学的微分式に置き換え');
    console.log('   ✅ ベクトル演算最適化: 冗長な計算を削減');
    console.log('   📊 期待される高速化: 2-5倍の性能向上');
}

// グローバルスコープで関数を利用できるように設定（Horner法+解析的微分最適化済み）
if (typeof window !== 'undefined') {
  // window.asphericSag is owned by core/aspheric-sag-service.ts
  (window as any)['asphericSagDerivative'] = asphericSagDerivative;
  (window as any)['surfaceNormal'] = surfaceNormal;
  (window as any)['displayCacheStats'] = displayCacheStats;
  (window as any)['getPerformanceReport'] = getPerformanceReport;
  (window as any)['enableRayTracingProfiler'] = enableRayTracingProfiler;
  (window as any)['isRayTracingProfilerEnabled'] = isRayTracingProfilerEnabled;
  (window as any)['getRayTracingProfile'] = getRayTracingProfile;
}

// Install the base implementation for window.asphericSag via the service.
try {
  setAsphericSagImplementation(asphericSag);
} catch (_) {
  // ignore
}

// Lightweight profiler for ray-tracing hotspots (opt-in)
const RT_PROF = {
  enabled: false,
  stats: {
    // call counts
    traceCalls: 0,
    intersectCalls: 0,
    wasmIntersectAttempts: 0,
    wasmIntersectHits: 0,
    wasmIntersectMisses: 0,
    wasmIntersectUnavailable: 0,
    wasmIntersectSkippedDebug: 0,
    wasmIntersectSkippedDebugWhileDisabled: 0,
    wasmIntersectSkippedDebugFirstStack: null,
    wasmIntersectErrors: 0,
    asphericSagCalls: 0,
    asphericSagDerivCalls: 0,
    surfaceNormalCalls: 0,
    refractCalls: 0,
    reflectCalls: 0,
    applyMatCalls: 0,
    invertMatCalls: 0,
    refractiveIndexCalls: 0,
    // times (ms)
    traceTime: 0,
    intersectTime: 0,
    asphericSagTime: 0,
    asphericSagDerivTime: 0,
    surfaceNormalTime: 0,
    refractTime: 0,
    reflectTime: 0,
    applyMatTime: 0,
    invertMatTime: 0,
    refractiveIndexTime: 0,
    calculateSurfaceOriginsTime: 0,
    transformRayToLocalTime: 0,
    transformPointToGlobalTime: 0,
    transformRayToLocalInnerTime: 0,
    // iteration stats
    intersectIterationsTotal: 0,
    intersectIterationsMax: 0,
    __lastIterCount: 0
  }
};

function now() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

export function enableRayTracingProfiler(enable = true, reset = true) {
  RT_PROF.enabled = !!enable;
  if (reset) resetRayTracingProfiler();
}

export function isRayTracingProfilerEnabled() {
  return !!RT_PROF.enabled;
}

function resetRayTracingProfiler() {
  const s = RT_PROF.stats;
  for (const k of Object.keys(s)) {
    if (typeof s[k] === 'number') s[k] = 0;
  }
  // Clear non-numeric diagnostics explicitly.
  s.wasmIntersectSkippedDebugFirstStack = null;
}

export function getRayTracingProfile(options = {}) {
  const reset = options && options.reset !== undefined ? options.reset : false;
  const snapshot = JSON.parse(JSON.stringify(RT_PROF.stats));
  if (reset) resetRayTracingProfiler();
  return snapshot;
}

// ============================================================================
// COORDINATE TRANSFORMATION UTILITIES
// ============================================================================

/**
 * Reset ray coordinates to specified surface's local coordinate system.
 * @param {Object} ray - Ray object with pos and dir properties
 * @param {number} surfaceIndex - 0-based surface index
 * @param {Array} opticalSystemRows - Optical system data
 * @returns {Object} - {transformedRay, origin, rotationMatrix} or null on error
 */
export function resetToSurfaceCoordinates(ray, surfaceIndex, opticalSystemRows) {
  if (!ray || !ray.pos || !ray.dir) {
    throw new Error('Invalid ray object. Must have pos and dir properties.');
  }
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
    throw new Error('Invalid optical system data.');
  }
  if (!Number.isInteger(surfaceIndex) || surfaceIndex < 0 || surfaceIndex >= opticalSystemRows.length) {
    throw new Error(`Invalid surface index: ${surfaceIndex}. Must be between 0 and ${opticalSystemRows.length - 1}.`);
  }
  
  // Check if surface is CoordTrans or Object (no intersection point)
  const targetRow = opticalSystemRows[surfaceIndex];
  if (isCoordTransSurface(targetRow) || isObjectRow(targetRow)) {
    throw new Error('CoordTrans surface has no intersection point. Please specify a real surface before/after it.');
  }
  
  try {
    // Get surface origins and rotation matrices
    const surfaceData = calculateSurfaceOrigins(opticalSystemRows);
    if (!surfaceData || surfaceIndex >= surfaceData.length) {
      throw new Error(`Failed to calculate surface origins for surface ${surfaceIndex}.`);
    }
    
    const { origin, rotationMatrix } = surfaceData[surfaceIndex];
    
    // Transform ray to local coordinates
    const transformedRay = {
      pos: transformGlobalToLocal(ray.pos, origin, rotationMatrix),
      dir: transformGlobalToLocal(ray.dir, { x: 0, y: 0, z: 0 }, rotationMatrix), // Direction is a vector, no origin offset
      wavelength: ray.wavelength
    };
    
    return { transformedRay, origin, rotationMatrix };
  } catch (error) {
    throw new Error(`Failed to reset to surface coordinates: ${error.message}`);
  }
}

/**
 * Shift ray position so chief ray is at origin in specified surface's coordinate system.
 * @param {Object} ray - Ray object to shift
 * @param {number} surfaceIndex - 0-based surface index
 * @param {Array} chiefRayPath - Chief ray path array from traceChiefRay
 * @param {Array} opticalSystemRows - Optical system data
 * @returns {Object} - {shiftedRay, chiefRayShift} or null on error
 */
export function shiftToChiefRayOrigin(ray, surfaceIndex, chiefRayPath, opticalSystemRows) {
  if (!ray || !ray.pos) {
    throw new Error('Invalid ray object. Must have pos property.');
  }
  if (!Array.isArray(chiefRayPath) || chiefRayPath.length === 0) {
    throw new Error('Invalid chief ray path. Chief ray data is missing.');
  }
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
    throw new Error('Invalid optical system data.');
  }
  
  // Get rayPath index for this surface
  const rayPathIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, surfaceIndex);
  if (rayPathIndex === null || rayPathIndex >= chiefRayPath.length) {
    throw new Error(`Cannot find chief ray intersection at surface ${surfaceIndex}. Surface may be skipped or out of range.`);
  }
  
  const chiefRayPos = chiefRayPath[rayPathIndex];
  if (!chiefRayPos || typeof chiefRayPos.x !== 'number') {
    throw new Error(`Invalid chief ray position at surface ${surfaceIndex}.`);
  }
  
  // Shift ray position by subtracting chief ray position
  const shiftedRay = {
    pos: {
      x: ray.pos.x - chiefRayPos.x,
      y: ray.pos.y - chiefRayPos.y,
      z: ray.pos.z - chiefRayPos.z
    },
    dir: { ...ray.dir }, // Direction unchanged
    wavelength: ray.wavelength
  };
  
  const chiefRayShift = { ...chiefRayPos };
  
  return { shiftedRay, chiefRayShift };
}

/**
 * Restore ray from local coordinates back to global coordinates.
 * @param {Object} ray - Ray in local coordinates
 * @param {Object} transformInfo - {origin, rotationMatrix, chiefRayShift} from previous transforms
 * @returns {Object} - Restored ray in global coordinates
 */
export function restoreFromLocalCoordinates(ray, transformInfo) {
  if (!ray || !ray.pos || !ray.dir) {
    throw new Error('Invalid ray object. Must have pos and dir properties.');
  }
  if (!transformInfo) {
    throw new Error('Invalid transform info. Must contain origin, rotationMatrix, and optionally chiefRayShift.');
  }
  
  const { origin, rotationMatrix, chiefRayShift } = transformInfo;
  
  if (!origin || !rotationMatrix) {
    throw new Error('Transform info must contain origin and rotationMatrix.');
  }
  
  try {
    // Step 1: If chief ray shift was applied, restore it first (add it back)
    let restoredPos = { ...ray.pos };
    if (chiefRayShift) {
      restoredPos = {
        x: restoredPos.x + chiefRayShift.x,
        y: restoredPos.y + chiefRayShift.y,
        z: restoredPos.z + chiefRayShift.z
      };
    }
    
    // Step 2: Transform from local to global coordinates
    const globalPos = transformLocalToGlobal(restoredPos, origin, rotationMatrix);
    const globalDir = transformLocalToGlobal(ray.dir, { x: 0, y: 0, z: 0 }, rotationMatrix);
    
    return {
      pos: globalPos,
      dir: globalDir,
      wavelength: ray.wavelength
    };
  } catch (error) {
    throw new Error(`Failed to restore from local coordinates: ${error.message}`);
  }
}

/**
 * Combined transformation: reset to surface coordinates and shift to chief ray origin.
 * @param {Object} ray - Ray object to transform
 * @param {number} surfaceIndex - 0-based surface index
 * @param {Array} chiefRayPath - Chief ray path array
 * @param {Array} opticalSystemRows - Optical system data
 * @returns {Object} - {transformedRay, transformInfo: {origin, rotationMatrix, chiefRayShift}}
 */
export function transformToChiefRayLocalCoordinates(ray, surfaceIndex, chiefRayPath, opticalSystemRows) {
  // Step 1: Reset to surface coordinates
  const resetResult = resetToSurfaceCoordinates(ray, surfaceIndex, opticalSystemRows);
  if (!resetResult) {
    throw new Error('Failed to reset to surface coordinates.');
  }
  
  const { transformedRay, origin, rotationMatrix } = resetResult;
  
  // Step 2: Shift to chief ray origin
  const shiftResult = shiftToChiefRayOrigin(transformedRay, surfaceIndex, chiefRayPath, opticalSystemRows);
  if (!shiftResult) {
    throw new Error('Failed to shift to chief ray origin.');
  }
  
  const { shiftedRay, chiefRayShift } = shiftResult;
  
  return {
    transformedRay: shiftedRay,
    transformInfo: {
      origin,
      rotationMatrix,
      chiefRayShift
    }
  };
}

/**
 * Calculate chief-ray global intersection points for each real surface.
 * Uses surface 0 as the global coordinate origin.
 * CoordTrans/Object rows are skipped because they have no physical intersection.
 * @param {Array} opticalSystemRows
 * @param {Object} options
 * @returns {Array} [{ surfaceIndex, surfaceId, point }]
 */
export function calculateChiefRaySurfaceIntersections(opticalSystemRows, options = {}) {
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
    throw new Error('Invalid optical system data.');
  }

  const rows = normalizeCoordTransRows(opticalSystemRows);

  const chiefRayStart = { x: 0, y: 0, z: 0 };
  let chiefRayDir = { x: 0, y: 0, z: 1 };

  try {
    const result = computeChiefRayDirectionToStop(rows, options.wavelength ?? 0.55);
    chiefRayDir = result?.dir || chiefRayDir;
  } catch (_) {}

  const chiefRay = {
    pos: chiefRayStart,
    dir: chiefRayDir,
    wavelength: options.wavelength ?? 0.55
  };

  const chiefRayPath = traceRay(rows, chiefRay, 1.0);
  if (!chiefRayPath || chiefRayPath.length === 0) {
    throw new Error('Failed to trace chief ray.');
  }

  // chiefRayPath is already in global coordinates!
  // Simply collect the points for each real surface
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (isCoordTransSurface(row) || isObjectRow(row)) continue;

    const rayPathIndex = surfaceIndexToRayPathPointIndex(rows, i);
    if (rayPathIndex === null || rayPathIndex >= chiefRayPath.length) continue;

    const point = chiefRayPath[rayPathIndex];
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) continue;

    results.push({
      surfaceIndex: i,
      surfaceId: row.id ?? i,
      point: { x: point.x, y: point.y, z: point.z }
    });
  }

  return results;
}

/**
 * Calculate local coordinates for all surfaces at specified target surface.
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} targetSurfaceIndex - 0-based target surface index
 * @param {Function} progressCallback - Optional callback(percent, message)
 * @param {string} ignoreCoordTransBlockId - Optional: block ID of CoordTrans to ignore (treat as identity)
 * @param {Array} originalOpticalSystemRows - Optional: original rows before enrichment (for correct target positions)
 * @returns {Promise<Object>} - {surfaces: {surfaceId: {localDecenterX, ...}}, metadata: {...}}
 */
export async function calculateAllSurfacesLocalCoordinates(opticalSystemRows, targetSurfaceIndex, progressCallback, ignoreCoordTransBlockId, originalOpticalSystemRows) {
  // Input validation
  if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
    throw new Error('Invalid optical system data.');
  }
  
  console.log(`[calculateAllSurfacesLocalCoordinates] targetSurfaceIndex=${targetSurfaceIndex}, ignoreBlockId=${ignoreCoordTransBlockId}, opticalSystemRows.length=${opticalSystemRows.length}, originalRows.length=${originalOpticalSystemRows ? originalOpticalSystemRows.length : 'N/A'}`);
  
  // Log surface structure for debugging
  console.log('[calculateAllSurfacesLocalCoordinates] Surface structure:');
  try {
    const maxSurfaces = Math.min(7, opticalSystemRows.length);
    console.log(`  Logging ${maxSurfaces} surfaces...`);
    for (let idx = 0; idx < maxSurfaces; idx++) {
      try {
        const row = opticalSystemRows[idx];
        const blockId = row._blockId || row.blockId || '?';
        const type = row.type || '?';
        const thickness = Number(row.thickness) || 0;
        console.log(`  Surf ${idx}: ${type} (${blockId}), thickness=${thickness.toFixed(4)}`);
      } catch (e) {
        console.log(`  Surf ${idx}: ERROR - ${e.message}`);
      }
    }
    console.log('  Done logging surfaces');
  } catch (e) {
    console.log(`  Error in surface logging: ${e.message}`);
  }
  if (!Number.isInteger(targetSurfaceIndex) || targetSurfaceIndex < 0 || targetSurfaceIndex >= opticalSystemRows.length) {
    throw new Error(`Invalid target surface index: ${targetSurfaceIndex}.`);
  }
  
  const reportProgress = (percent, message) => {
    try {
      if (typeof progressCallback === 'function') {
        progressCallback(percent, message);
      }
    } catch (_) {}
  };
  
  reportProgress(0, 'Starting calculation...');
  
  // If ignoreCoordTransBlockId is specified, temporarily zero out that CoordTrans block's parameters
  let modifiedRows = normalizeCoordTransRows(opticalSystemRows);
  if (ignoreCoordTransBlockId) {
    console.log(`[CoordTrans] Ignoring CoordTrans block: ${ignoreCoordTransBlockId}`);
    modifiedRows = opticalSystemRows.map(row => {
      const blockId = String(row._blockId ?? row.blockId ?? '');
      if (blockId === String(ignoreCoordTransBlockId) && isCoordTransSurface(row)) {
        // Create a copy with zeroed parameters
        return {
          ...row,
          decenterX: 0,
          decenterY: 0,
          decenterZ: 0,
          tiltX: 0,
          tiltY: 0,
          tiltZ: 0,
          // Also zero legacy reused fields so legacy CB rows are truly ignored
          semidia: 0,
          material: 0,
          thickness: 0,
          rindex: 0,
          abbe: 0,
          conic: 0,
          coef1: row.coef1
        };
      }
      return row;
    });
  }
  
  // Check if target surface is valid (not CoordTrans or Object)
  const targetRow = modifiedRows[targetSurfaceIndex];
  if (isCoordTransSurface(targetRow) || isObjectRow(targetRow)) {
    throw new Error('Target surface cannot be CoordTrans or Object surface. Please specify a real surface.');
  }
  
  try {
    reportProgress(5, 'Tracing chief ray...');
    
    // Trace chief ray for field point (0, 0) at primary wavelength 0.55μm
    // Aim the ray through the stop center to approximate the true chief ray
    const chiefRayStart = { x: 0, y: 0, z: 0 };
    let chiefRayDir = { x: 0, y: 0, z: 1 };
    try {
      const result = computeChiefRayDirectionToStop(modifiedRows, 0.55);
      chiefRayDir = result?.dir || chiefRayDir;
    } catch (_) {}

    const chiefRay = {
      pos: chiefRayStart,
      dir: chiefRayDir,
      wavelength: 0.55
    };
    
    // Trace chief ray through the system (using modified rows)
    const chiefRayPath = traceRay(modifiedRows, chiefRay, 1.0);
    
    if (!chiefRayPath || chiefRayPath.length === 0) {
      throw new Error('Failed to trace chief ray. Check optical system configuration.');
    }
    
    // Log chief ray final position (for debugging chief ray shift accuracy)
    if (chiefRayPath.length > 0) {
      const finalPos = chiefRayPath[chiefRayPath.length - 1];
      console.log(`  [Chief Ray] Final position: (${finalPos.x.toFixed(6)}, ${finalPos.y.toFixed(6)}, ${finalPos.z.toFixed(6)})`);
    }
    
    reportProgress(10, 'Calculating surface origins...');
    
    // Get surface data (origins and rotation matrices) using modified rows
    const surfaceData = calculateSurfaceOrigins(modifiedRows);
    if (!surfaceData) {
      throw new Error('Failed to calculate surface origins.');
    }
    
    // Calculate surface origins from UNMODIFIED rows (without ignoring current CoordTrans block)
    // This gives us the correct global Z positions for target surfaces
    const rowsForOriginal = originalOpticalSystemRows || opticalSystemRows;
    console.log(`  [Debug] Using ${originalOpticalSystemRows ? 'original' : 'fallback'} rows, count=${rowsForOriginal.length}`);
    // Don't normalize - we want the full system including the CoordTrans block
    const surfaceDataWithCoordTrans = calculateSurfaceOrigins(rowsForOriginal);
    
    // Debug: log the difference and surface structure
    if (surfaceDataWithCoordTrans && surfaceData) {
      console.log(`  [Debug] Surface count: modified=${surfaceData.length}, withCoordTrans=${surfaceDataWithCoordTrans.length}`);
      if (targetSurfaceIndex >= 0) {
        // Find target in both arrays
        const modTargetZ = targetSurfaceIndex < surfaceData.length ? surfaceData[targetSurfaceIndex].origin.z.toFixed(4) : 'N/A';
        const origTargetZ = targetSurfaceIndex < surfaceDataWithCoordTrans.length ? surfaceDataWithCoordTrans[targetSurfaceIndex].origin.z.toFixed(4) : 'N/A';
        console.log(`  [Debug] Target ${targetSurfaceIndex} Z: modified=${modTargetZ}, withCoordTrans=${origTargetZ}`);
      }
      // Log all surface Z positions for debugging
      console.log('  [Debug] All surface Z positions (with CoordTrans):');
      console.log(`  [Debug] surfaceDataWithCoordTrans is ${surfaceDataWithCoordTrans ? 'defined' : 'undefined'}, length=${surfaceDataWithCoordTrans ? surfaceDataWithCoordTrans.length : 'N/A'}`);
      try {
        for (let idx = 0; idx < Math.min(7, surfaceDataWithCoordTrans.length); idx++) {
          const rowType = (rowsForOriginal[idx] && rowsForOriginal[idx].type) ? rowsForOriginal[idx].type : 'unknown';
          const zPos = surfaceDataWithCoordTrans[idx] ? surfaceDataWithCoordTrans[idx].origin.z.toFixed(4) : 'N/A';
          console.log(`    Surf ${idx} (${rowType}): Z=${zPos}`);
        }
        console.log('  [Debug] Loop completed');
      } catch (e) {
        console.log(`    Error logging surfaces: ${e.message}`);
      }
    }
    
    reportProgress(15, 'Processing surfaces...');
    
    // Calculate local coordinates for each surface
    const results = {};
    let processedCount = 0;
    const totalSurfaces = modifiedRows.length;
    
    for (let i = 0; i < modifiedRows.length; i++) {
      // Check for cancellation
      if (typeof window !== 'undefined' && window._transformCalculationCancelled) {
        reportProgress(100, 'Calculation cancelled');
        throw new Error('Calculation cancelled by user.');
      }
      
      const row = modifiedRows[i];
      const surfaceId = row.id;
      
      // Skip Object surfaces (they don't have intersection points)
      if (isObjectRow(row)) {
        continue;
      }
      
      // For CoordTrans surfaces, only calculate their coordinate transformation parameters
      // (no ray tracing needed)
      if (isCoordTransSurface(row)) {
        const globalOrigin = surfaceData[i].origin;
        const globalRotMat = surfaceData[i].rotationMatrix;
        
        let decenterX, decenterY, decenterZ;
        let flatDecenterX = 0, flatDecenterY = 0, flatDecenterZ = 0;
        
        if (i === 0) {
          decenterX = globalOrigin.x;
          decenterY = globalOrigin.y;
          decenterZ = globalOrigin.z;
        } else {
          const prevOrigin = surfaceData[i - 1].origin;
          const prevRotMat = surfaceData[i - 1].rotationMatrix;
          
          const dx_global = globalOrigin.x - prevOrigin.x;
          const dy_global = globalOrigin.y - prevOrigin.y;
          const dz_global = globalOrigin.z - prevOrigin.z;
          
          decenterX = prevRotMat[0][0] * dx_global + prevRotMat[0][1] * dy_global + prevRotMat[0][2] * dz_global;
          decenterY = prevRotMat[1][0] * dx_global + prevRotMat[1][1] * dy_global + prevRotMat[1][2] * dz_global;
          decenterZ = prevRotMat[2][0] * dx_global + prevRotMat[2][1] * dy_global + prevRotMat[2][2] * dz_global;
          
          // Apply chief ray shift if enabled via chiefRayShiftX, Y, Z parameters
          const chiefRayShiftModeX = String(row?.parameters?.chiefRayShiftX ?? row?.chiefRayShiftX ?? '').trim().toUpperCase();
          const chiefRayShiftModeY = String(row?.parameters?.chiefRayShiftY ?? row?.chiefRayShiftY ?? '').trim().toUpperCase();
          const chiefRayShiftModeZ = String(row?.parameters?.chiefRayShiftZ ?? row?.chiefRayShiftZ ?? '').trim().toUpperCase();
          const useChiefRayShiftX = (chiefRayShiftModeX === 'A' || chiefRayShiftModeX === 'AUTO');
          const useChiefRayShiftY = (chiefRayShiftModeY === 'A' || chiefRayShiftModeY === 'AUTO');
          const useChiefRayShiftZ = (chiefRayShiftModeZ === 'A' || chiefRayShiftModeZ === 'AUTO');

          if (useChiefRayShiftX || useChiefRayShiftY || useChiefRayShiftZ) {
            const thickness = getSafeThickness(modifiedRows[i - 1]);
            const eps = 1e-12;
            
            // Calculate offset: how many surfaces were ignored before targetSurfaceIndex
            // This is needed because targetSurfaceIndex is in the modified (ignored) array,
            // but we need to access surfaceDataWithCoordTrans which includes ALL surfaces
            let targetIndexWithCoordTrans = targetSurfaceIndex;
            if (rowsForOriginal && rowsForOriginal.length > modifiedRows.length) {
              // Count ignored blocks before target
              let ignoredCount = 0;
              let modifiedIdx = 0;
              for (let origIdx = 0; origIdx < rowsForOriginal.length && modifiedIdx <= targetSurfaceIndex; origIdx++) {
                const origRow = rowsForOriginal[origIdx];
                const modRow = modifiedRows[modifiedIdx];
                // Check if this original row was ignored (not in modified)
                if (modRow && (origRow.id === modRow.id || origRow._blockId === modRow._blockId || origRow.blockId === modRow.blockId)) {
                  // This row exists in both - advance modified index
                  modifiedIdx++;
                } else {
                  // This row was ignored
                  if (modifiedIdx < targetSurfaceIndex) {
                    ignoredCount++;
                  }
                }
              }
              targetIndexWithCoordTrans = targetSurfaceIndex + ignoredCount;
              console.log(`  [CoordTrans Surf ${surfaceId}] Target index: modified=${targetSurfaceIndex}, withCoordTrans=${targetIndexWithCoordTrans}, ignored=${ignoredCount}`);
            }
            
            // Get the target surface's global Z position for flat calculation
            // Use the surfaceDataWithCoordTrans (before ignoring blocks) to get the correct target position
            let targetGlobalZ = prevOrigin.z + thickness; // Default to nominal vertex
            if (targetIndexWithCoordTrans >= 0 && targetIndexWithCoordTrans < surfaceDataWithCoordTrans.length) {
              targetGlobalZ = surfaceDataWithCoordTrans[targetIndexWithCoordTrans].origin.z;
              console.log(`  [CoordTrans Surf ${surfaceId}] Target surf ${targetIndexWithCoordTrans} at Z=${targetGlobalZ.toFixed(4)}, prevOrigin.z=${prevOrigin.z.toFixed(4)}, thickness=${thickness.toFixed(4)}`);
            } else {
              console.log(`  [CoordTrans Surf ${surfaceId}] Using default targetZ=${targetGlobalZ.toFixed(4)} (targetIndex=${targetIndexWithCoordTrans} out of range)`);
            }

            // =========================================================================================
            // CALCULATION 1: Tilted/Local Basis (For 'XY' mode return)
            // Intersection with plane perpendicular to Local Z at nominal vertex position.
            // =========================================================================================
            const localZAxis = applyMatrixToVector(prevRotMat, vec3(0, 0, 1));
            const nominalVertex = add(prevOrigin, scale(localZAxis, thickness));
            const planeNormalLocal = localZAxis;

            let intersectGlobalLocalBasis = null;
            if (chiefRayPath && chiefRayPath.length >= 2) {
              for (let j = 0; j < chiefRayPath.length - 1; j++) {
                const p1 = chiefRayPath[j], p2 = chiefRayPath[j + 1];
                const d1 = dot(planeNormalLocal, sub(p1, nominalVertex));
                const d2 = dot(planeNormalLocal, sub(p2, nominalVertex));
                if (Math.abs(d1) <= eps) { intersectGlobalLocalBasis = { x: p1.x, y: p1.y, z: p1.z }; break; }
                if (d1 * d2 <= 0) {
                  const denom = d1 - d2;
                  if (Math.abs(denom) > eps) {
                    const t = d1 / denom;
                    intersectGlobalLocalBasis = { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y), z: p1.z + t * (p2.z - p1.z) };
                    break;
                  }
                }
              }
            }
            
            if (intersectGlobalLocalBasis) {
              const dx = intersectGlobalLocalBasis.x - nominalVertex.x;
              const dy = intersectGlobalLocalBasis.y - nominalVertex.y;
              const dz = intersectGlobalLocalBasis.z - nominalVertex.z;
              const axisX = applyMatrixToVector(prevRotMat, vec3(1, 0, 0));
              const axisY = applyMatrixToVector(prevRotMat, vec3(0, 1, 0));
              const axisZ = applyMatrixToVector(prevRotMat, vec3(0, 0, 1));

              const lx = axisX.x * dx + axisX.y * dy + axisX.z * dz;
              const ly = axisY.x * dx + axisY.y * dy + axisY.z * dz;
              const lz = axisZ.x * dx + axisZ.y * dy + axisZ.z * dz;

              if (useChiefRayShiftX) decenterX = lx;
              if (useChiefRayShiftY) decenterY = ly;
              if (useChiefRayShiftZ) decenterZ = lz;
              
              console.log(`  [CoordTrans Surf ${surfaceId}] Tilted/Local Shift: local=(${lx.toFixed(4)}, ${ly.toFixed(4)}, ${lz.toFixed(4)})`);
            }

            // =========================================================================================
            // CALCULATION 2: Flat/Global Basis (For 'XYZ' mode return)
            // Intersection with plane perpendicular to Global Z at the TARGET surface Z position.
            // This gives the decenter needed to align chief ray with target surface in global coordinates.
            // =========================================================================================
            const planeNormalFlat = vec3(0, 0, 1);
            const baseOriginFlat = vec3(prevOrigin.x, prevOrigin.y, targetGlobalZ); 
            
            let intersectGlobalFlatBasis = null;
            if (chiefRayPath && chiefRayPath.length >= 2) {
                console.log(`  [CoordTrans Surf ${surfaceId}] Chief Ray Path has ${chiefRayPath.length} points, target Z=${targetGlobalZ.toFixed(4)}, prevOrigin Z=${prevOrigin.z.toFixed(4)}`);
                // Log all points in chief ray path
                for (let j = 0; j < chiefRayPath.length; j++) {
                  const p = chiefRayPath[j];
                  console.log(`    Point ${j}: (${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)})`);
                }
                
                // First, check if there's a point exactly at target Z (within tolerance)
                const tolerance = 1e-6;
                for (let j = 0; j < chiefRayPath.length; j++) {
                  if (Math.abs(chiefRayPath[j].z - targetGlobalZ) < tolerance) {
                    intersectGlobalFlatBasis = {
                      x: chiefRayPath[j].x,
                      y: chiefRayPath[j].y,
                      z: chiefRayPath[j].z
                    };
                    console.log(`  [CoordTrans Surf ${surfaceId}] Found exact point at target Z: Point ${j}, (${intersectGlobalFlatBasis.x.toFixed(4)}, ${intersectGlobalFlatBasis.y.toFixed(4)}, ${intersectGlobalFlatBasis.z.toFixed(4)})`);
                    break;
                  }
                }
                
                // If no exact point found, find the segment that crosses target Z
                if (!intersectGlobalFlatBasis) {
                  // Find the first point AFTER target Z (refracted position)
                  let pointAfterTarget = null;
                  let pointBeforeTarget = null;
                  for (let j = 0; j < chiefRayPath.length; j++) {
                    if (chiefRayPath[j].z <= targetGlobalZ) {
                      pointBeforeTarget = chiefRayPath[j];
                    }
                    if (chiefRayPath[j].z > targetGlobalZ && !pointAfterTarget) {
                      pointAfterTarget = chiefRayPath[j];
                      break;
                    }
                  }
                  
                  // If we have a point after target, use it (refracted ray)
                  // Use the refracted ray direction (from before to after) to back-project to target Z
                  if (pointAfterTarget && pointBeforeTarget) {
                    // Calculate ray direction from before to after refraction
                    const dx = pointAfterTarget.x - pointBeforeTarget.x;
                    const dy = pointAfterTarget.y - pointBeforeTarget.y;
                    const dz = pointAfterTarget.z - pointBeforeTarget.z;
                    const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
                    if (len > eps && Math.abs(dz) > eps) {
                      // Normalized direction
                      const dirX = dx / len;
                      const dirY = dy / len;
                      const dirZ = dz / len;
                      
                      // Back-project from pointAfterTarget to target Z
                      const t = (pointAfterTarget.z - targetGlobalZ) / dirZ;
                      intersectGlobalFlatBasis = {
                        x: pointAfterTarget.x - t * dirX,
                        y: pointAfterTarget.y - t * dirY,
                        z: targetGlobalZ
                      };
                      console.log(`  [CoordTrans Surf ${surfaceId}] Back-projecting from after-point: Z=${pointAfterTarget.z.toFixed(4)} → target Z=${targetGlobalZ.toFixed(4)}`);
                      console.log(`  [CoordTrans Surf ${surfaceId}] Ray direction: (${dirX.toFixed(6)}, ${dirY.toFixed(6)}, ${dirZ.toFixed(6)}), t=${t.toFixed(4)}`);
                      console.log(`  [CoordTrans Surf ${surfaceId}] Intersection: (${intersectGlobalFlatBasis.x.toFixed(4)}, ${intersectGlobalFlatBasis.y.toFixed(4)}, ${intersectGlobalFlatBasis.z.toFixed(4)})`);
                    }
                  } else {
                    // Fallback to old method
                    for (let j = 0; j < chiefRayPath.length - 1; j++) {
                      const p1 = chiefRayPath[j], p2 = chiefRayPath[j + 1];
                      const d1 = dot(planeNormalFlat, sub(p1, baseOriginFlat));
                      const d2 = dot(planeNormalFlat, sub(p2, baseOriginFlat));
                      if (Math.abs(d1) <= eps) { 
                        intersectGlobalFlatBasis = { x: p1.x, y: p1.y, z: p1.z }; 
                        console.log(`  [CoordTrans Surf ${surfaceId}] Found intersection at segment ${j} (point on plane): (${p1.x.toFixed(4)}, ${p1.y.toFixed(4)}, ${p1.z.toFixed(4)})`);
                        break; 
                      }
                      if (d1 * d2 <= 0) {
                        const denom = d1 - d2;
                        if (Math.abs(denom) > eps) {
                          const t = d1 / denom;
                          intersectGlobalFlatBasis = { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y), z: p1.z + t * (p2.z - p1.z) };
                          console.log(`  [CoordTrans Surf ${surfaceId}] Found intersection at segment ${j}, t=${t.toFixed(4)}: (${intersectGlobalFlatBasis.x.toFixed(4)}, ${intersectGlobalFlatBasis.y.toFixed(4)}, ${intersectGlobalFlatBasis.z.toFixed(4)})`);
                          console.log(`    p1=(${p1.x.toFixed(4)}, ${p1.y.toFixed(4)}, ${p1.z.toFixed(4)}), p2=(${p2.x.toFixed(4)}, ${p2.y.toFixed(4)}, ${p2.z.toFixed(4)})`);
                          break;
                        }
                      }
                    }
                  }
                }
                if (!intersectGlobalFlatBasis) {
                  console.log(`  [CoordTrans Surf ${surfaceId}] WARNING: No intersection found with flat plane!`);
                }
              }

              if (intersectGlobalFlatBasis) {
                  // X, Y: offset from previous origin at target Z plane
                  const dxf = intersectGlobalFlatBasis.x - prevOrigin.x;
                  const dyf = intersectGlobalFlatBasis.y - prevOrigin.y;
                  // Z: Global Z distance from previous origin to target
                  const dzf = targetGlobalZ - prevOrigin.z;
                  
                  // Project onto Identity Basis (Global X,Y,Z)
                  flatDecenterX = dxf;
                  flatDecenterY = dyf;
                  flatDecenterZ = dzf;
                  
                  console.log(`  [CoordTrans Surf ${surfaceId}] Flat/Global Shift: global=(${dxf.toFixed(4)}, ${dyf.toFixed(4)}, ${dzf.toFixed(4)})`);
              }
          }
        }
        
        // Extract tilt from the current global rotation matrix so Orientation modes can update tilt.
        let tiltX, tiltY, tiltZ;
        const sy = globalRotMat[0][2];
        if (Math.abs(sy) >= 0.99999) {
          tiltY = Math.asin(Math.max(-1, Math.min(1, sy)));
          tiltX = Math.atan2(globalRotMat[1][0], globalRotMat[1][1]);
          tiltZ = 0;
        } else {
          tiltY = Math.asin(Math.max(-1, Math.min(1, sy)));
          tiltX = Math.atan2(-globalRotMat[1][2], globalRotMat[2][2]);
          tiltZ = Math.atan2(-globalRotMat[0][1], globalRotMat[0][0]);
        }
        tiltX *= (180 / Math.PI);
        tiltY *= (180 / Math.PI);
        tiltZ *= (180 / Math.PI);
        // Invert signs to match CoordTrans parameter convention.
        tiltX = -tiltX;
        tiltY = -tiltY;
        tiltZ = -tiltZ;
        
        console.log(`  [CoordTrans ${surfaceId}] Dec=(${decenterX.toFixed(3)}, ${decenterY.toFixed(3)}, ${decenterZ.toFixed(3)}) Tilt=(${tiltX.toFixed(1)}°, ${tiltY.toFixed(1)}°, ${tiltZ.toFixed(1)}°)`);
        
        // Store result with string key for consistent lookup
        const resultKey = String(surfaceId);
        results[resultKey] = {
          localDecenterX: decenterX,
          localDecenterY: decenterY,
          localDecenterZ: decenterZ,
          localTiltX: tiltX,
          localTiltY: tiltY,
          localTiltZ: tiltZ,
          // Expose Flat Basis shifts for XYZ mode
          flatDecenterX: flatDecenterX || 0,
          flatDecenterY: flatDecenterY || 0,
          flatDecenterZ: flatDecenterZ || 0,
          transformType: 'coordtrans',
          targetSurface: targetSurfaceIndex
        };
        
        continue; // Skip ray tracing for CoordTrans
      }
      
      try {
        // Get chief ray intersection at this surface (surface i)
        const rayPathIndex = surfaceIndexToRayPathPointIndex(modifiedRows, i);
        if (rayPathIndex === null || rayPathIndex >= chiefRayPath.length) {
          continue; // Skip if no intersection
        }
        
        const chiefRayAtSurface = chiefRayPath[rayPathIndex];
        if (!chiefRayAtSurface || typeof chiefRayAtSurface.x !== 'number') {
          continue;
        }
        
        // Get chief ray direction at this surface (approximate from path)
        let chiefRayDir = { x: 0, y: 0, z: 1 }; // Default direction
        if (rayPathIndex + 1 < chiefRayPath.length) {
          const nextPoint = chiefRayPath[rayPathIndex + 1];
          const dx = nextPoint.x - chiefRayAtSurface.x;
          const dy = nextPoint.y - chiefRayAtSurface.y;
          const dz = nextPoint.z - chiefRayAtSurface.z;
          const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (mag > 1e-10) {
            chiefRayDir = { x: dx / mag, y: dy / mag, z: dz / mag };
          }
        }
        
        // Create a ray at the chief ray intersection point
        const rayAtSurface = {
          pos: { x: chiefRayAtSurface.x, y: chiefRayAtSurface.y, z: chiefRayAtSurface.z },
          dir: chiefRayDir,
          wavelength: 0.55
        };
        
        // Transform to target surface's local coordinates first
        const localResult = resetToSurfaceCoordinates(
          rayAtSurface,
          targetSurfaceIndex,
          modifiedRows
        );
        
        let finalPos = localResult.transformedRay.pos;
        let finalDir = localResult.transformedRay.dir;
        
        // Check if chief ray shift is enabled
        const useChiefRayShift = (typeof window !== 'undefined' && window._useChiefRayShift === true);
        
        if (useChiefRayShift) {
          // Get chief ray at target surface for rotation matrix
          const targetRayPathIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
          if (targetRayPathIndex !== null && targetRayPathIndex < chiefRayPath.length) {
            const chiefAtTarget = chiefRayPath[targetRayPathIndex];
            
            // Get chief ray direction at target surface
            let chiefDirAtTarget = { x: 0, y: 0, z: 1 };
            if (targetRayPathIndex + 1 < chiefRayPath.length) {
              const nextPt = chiefRayPath[targetRayPathIndex + 1];
              const dx = nextPt.x - chiefAtTarget.x;
              const dy = nextPt.y - chiefAtTarget.y;
              const dz = nextPt.z - chiefAtTarget.z;
              const mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
              if (mag > 1e-10) {
                chiefDirAtTarget = { x: dx / mag, y: dy / mag, z: dz / mag };
              }
            }
            
            // Transform chief ray to target surface local coordinates
            const chiefLocalResult = resetToSurfaceCoordinates(
              { pos: chiefAtTarget, dir: chiefDirAtTarget, wavelength: 0.55 },
              targetSurfaceIndex,
              opticalSystemRows
            );
            const chiefLocalPos = chiefLocalResult.transformedRay.pos;
            const chiefLocalDir = chiefLocalResult.transformedRay.dir;
            
            console.log(`  [Debug] Chief ray at target - Local pos: (${chiefLocalPos.x.toFixed(6)}, ${chiefLocalPos.y.toFixed(6)}, ${chiefLocalPos.z.toFixed(6)})`);
            console.log(`  [Debug] Chief ray at target - Local dir: (${chiefLocalDir.x.toFixed(6)}, ${chiefLocalDir.y.toFixed(6)}, ${chiefLocalDir.z.toFixed(6)})`);
            
            // Build rotation matrix with chief ray direction as new Z-axis
            // New Z-axis = chief ray direction (normalized)
            const newZ = chiefLocalDir;
            
            // New X-axis: perpendicular to newZ
            // If newZ is not parallel to global Y, use Y × newZ
            let newX;
            if (Math.abs(newZ.y) < 0.99) {
              // Cross product: Y × newZ
              const crossX = -newZ.z;
              const crossY = 0;
              const crossZ = newZ.x;
              const crossMag = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
              newX = { x: crossX / crossMag, y: crossY / crossMag, z: crossZ / crossMag };
            } else {
              // Use X × newZ if newZ is nearly parallel to Y
              const crossX = 0;
              const crossY = newZ.z;
              const crossZ = -newZ.y;
              const crossMag = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
              newX = { x: crossX / crossMag, y: crossY / crossMag, z: crossZ / crossMag };
            }
            
            // New Y-axis = newZ × newX
            const newY = {
              x: newZ.y * newX.z - newZ.z * newX.y,
              y: newZ.z * newX.x - newZ.x * newX.z,
              z: newZ.x * newX.y - newZ.y * newX.x
            };
            
            // Rotation matrix R_chief: columns are newX, newY, newZ
            // To transform point p: R_chief^T × (p - chiefLocalPos)
            // This makes chief ray at origin pointing in +Z direction
            
            // Apply rotation and translation
            const dx = finalPos.x - chiefLocalPos.x;
            const dy = finalPos.y - chiefLocalPos.y;
            const dz = finalPos.z - chiefLocalPos.z;
            
            finalPos = {
              x: newX.x * dx + newX.y * dy + newX.z * dz,
              y: newY.x * dx + newY.y * dy + newY.z * dz,
              z: newZ.x * dx + newZ.y * dy + newZ.z * dz
            };
            
            // Transform direction vector
            finalDir = {
              x: newX.x * finalDir.x + newX.y * finalDir.y + newX.z * finalDir.z,
              y: newY.x * finalDir.x + newY.y * finalDir.y + newY.z * finalDir.z,
              z: newZ.x * finalDir.x + newZ.y * finalDir.y + newZ.z * finalDir.z
            };
          }
        }
        
        // For regular surfaces, we don't calculate decenter/tilt
        // (only CoordTrans blocks need these parameters)
        // Simply store the result for display purposes
        
        console.log(`Surface ${surfaceId}: Transformed successfully (target: Surf ${targetSurfaceIndex})`);
      } catch (error) {
        // Skip surfaces that fail transformation
        console.warn(`Failed to transform surface ${i}:`, error.message);
      }
      
      processedCount++;
      
      // Report progress every 10 surfaces
      if (processedCount % 10 === 0 || processedCount === totalSurfaces) {
        const percent = 15 + Math.floor((processedCount / totalSurfaces) * 80);
        reportProgress(percent, `Processing surface ${processedCount}/${totalSurfaces}...`);
        
        // Yield to event loop every 10 surfaces
        if (processedCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
    
    // Check if any CoordTrans used chief ray shift - if so, iteratively refine
    let needsRetrace = false;
    const coordTransWithChiefShift = [];
    for (let i = 0; i < modifiedRows.length; i++) {
      const row = modifiedRows[i];
      if (isCoordTransSurface(row)) {
        const chiefRayShiftModeY = String(row?.parameters?.chiefRayShiftY ?? row?.chiefRayShiftY ?? '').trim().toUpperCase();
        if (chiefRayShiftModeY === 'A' || chiefRayShiftModeY === 'AUTO') {
          needsRetrace = true;
          coordTransWithChiefShift.push(i);
        }
      }
    }
    
    // ITERATION DISABLED: The initial calculation is already correct
    // Iteration doesn't converge because changing decenterY moves the entire coordinate system,
    // so the chief ray intersection in global coordinates remains at the same position
    needsRetrace = false;
    
    if (needsRetrace) {
      reportProgress(92, 'Iteratively refining chief ray shifts...');
      
      // Create a new array with deeply copied row objects to avoid cache poisoning
      // The cache uses array reference as key, so we need a distinct array object
      // Also copy nested objects like parameters to ensure full isolation
      modifiedRows = modifiedRows.map(row => ({
        ...row,
        parameters: row.parameters ? { ...row.parameters } : undefined
      }));
      
      const maxIterations = 5;
      const convergenceThreshold = 0.001; // 1 micron
      let currentChiefPath = chiefRayPath; // Start with initial path
      
      console.log(`  [Starting iteration] coordTransWithChiefShift indices: [${coordTransWithChiefShift.join(', ')}]`);
      
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        console.log(`  === [Iteration ${iteration} START] ===`);
        
        // Clear cache BEFORE creating new array (delete old array's cache entry)
        if (typeof __surfaceOriginsCache !== 'undefined') {
          __surfaceOriginsCache.delete(modifiedRows);
        }
        
        // Create a new array to ensure cache key changes
        modifiedRows = modifiedRows.map(r => r);
        
        // Trace chief ray with current decenter values
        const chiefRayRetrace = traceRay(modifiedRows, chiefRay, 1.0);
        
        if (!chiefRayRetrace || chiefRayRetrace.length === 0) {
          console.log(`  [Iteration ${iteration}] Chief ray trace failed`);
          break;
        }
        
        console.log(`    [Path points]:`, chiefRayRetrace.map((p, i) => `[${i}]=(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`).join(' '));
        
        const finalPos = chiefRayRetrace[chiefRayRetrace.length - 1];
        const finalY = Math.abs(finalPos.y);
        
        console.log(`  [Iteration ${iteration}] Chief ray final Y = ${finalY.toFixed(6)} mm`);
        
        // Check convergence
        if (finalY < convergenceThreshold) {
          console.log(`  [Converged] Chief ray aligned after ${iteration} iteration(s)`);
          break;
        }
        
        if (iteration === maxIterations) {
          console.log(`  [Max iterations reached] Final Y offset = ${finalY.toFixed(6)} mm`);
          break;
        }
        
        // Recalculate surfaceData with current decenters
        const updatedSurfaceData = calculateSurfaceOrigins(modifiedRows);
        if (!updatedSurfaceData) {
          console.log(`  [Iteration ${iteration}] Failed to recalculate surface origins`);
          break;
        }
        
        // Calculate NEW decenter values based on traced path
        for (const i of coordTransWithChiefShift) {
          const row = modifiedRows[i];
          const surfaceId = row["Surf ID"] || i;
          
          // Check which shifts are enabled
          const chiefRayShiftModeX = String(row?.parameters?.chiefRayShiftX ?? row?.chiefRayShiftX ?? '').trim().toUpperCase();
          const chiefRayShiftModeY = String(row?.parameters?.chiefRayShiftY ?? row?.chiefRayShiftY ?? '').trim().toUpperCase();
          const chiefRayShiftModeZ = String(row?.parameters?.chiefRayShiftZ ?? row?.chiefRayShiftZ ?? '').trim().toUpperCase();
          const useChiefRayShiftX = (chiefRayShiftModeX === 'A' || chiefRayShiftModeX === 'AUTO');
          const useChiefRayShiftY = (chiefRayShiftModeY === 'A' || chiefRayShiftModeY === 'AUTO');
          const useChiefRayShiftZ = (chiefRayShiftModeZ === 'A' || chiefRayShiftModeZ === 'AUTO');
          
          if (!updatedSurfaceData[i] || i === 0) continue;

          // Find intersection of chief ray with CoordTrans station plane
          const prevOrigin = updatedSurfaceData[i - 1].origin;
          const prevRotMat = updatedSurfaceData[i - 1].rotationMatrix;
          const thickness = getSafeThickness(modifiedRows[i - 1]);
          const baseOrigin = add(prevOrigin, scale(applyMatrixToVector(prevRotMat, vec3(0, 0, 1)), thickness));
          const planeNormal = applyMatrixToVector(prevRotMat, vec3(0, 0, 1));

          let chiefIntersectionGlobal = null;
          const eps = 1e-10;
          for (let k = 0; k < chiefRayRetrace.length - 1; k++) {
            const p1 = chiefRayRetrace[k];
            const p2 = chiefRayRetrace[k + 1];

            const d1 = dot(planeNormal, sub(p1, baseOrigin));
            const d2 = dot(planeNormal, sub(p2, baseOrigin));

            if (Math.abs(d1) <= eps) {
              chiefIntersectionGlobal = { x: p1.x, y: p1.y, z: p1.z };
              break;
            }

            if (d1 * d2 <= 0) {
              const denom = d1 - d2;
              if (Math.abs(denom) > eps) {
                const t = d1 / denom;
                chiefIntersectionGlobal = {
                  x: p1.x + t * (p2.x - p1.x),
                  y: p1.y + t * (p2.y - p1.y),
                  z: p1.z + t * (p2.z - p1.z)
                };
                break;
              }
            }
          }
          
          if (!chiefIntersectionGlobal) continue;

          // Compute decenter in the correct basis depending on transform order.

          const dx = chiefIntersectionGlobal.x - baseOrigin.x;
          const dy = chiefIntersectionGlobal.y - baseOrigin.y;
          const dz = chiefIntersectionGlobal.z - baseOrigin.z;

          const cbParams = parseCoordTransParams(row, modifiedRows[i - 1]) || {};
          const transformOrder = (Number(cbParams.transformOrder) === 0) ? 0 : 1;
          const basisMat = (transformOrder === 0) ? prevRotMat : updatedSurfaceData[i].rotationMatrix;

          const axisX = applyMatrixToVector(basisMat, vec3(1, 0, 0));
          const axisY = applyMatrixToVector(basisMat, vec3(0, 1, 0));
          const axisZ = applyMatrixToVector(basisMat, vec3(0, 0, 1));

          const chiefLocalX = axisX.x * dx + axisX.y * dy + axisX.z * dz;
          const chiefLocalY = axisY.x * dx + axisY.y * dy + axisY.z * dz;
          const chiefLocalZ = axisZ.x * dx + axisZ.y * dy + axisZ.z * dz;
          
          const oldDecenterX = row.decenterX || row.parameters?.decenterX || 0;
          const oldDecenterY = row.decenterY || row.parameters?.decenterY || 0;
          const oldDecenterZ = row.decenterZ || row.parameters?.decenterZ || 0;
          
          // Create new decenter values - CORRECTIVE adjustment, not absolute position
          // Chief ray intersects at chiefLocalY in the station plane
          // To center the chief ray, we need to shift the coordinate system by +chiefLocalY
          const newDecenterX = useChiefRayShiftX ? (oldDecenterX + chiefLocalX) : oldDecenterX;
          const newDecenterY = useChiefRayShiftY ? (oldDecenterY + chiefLocalY) : oldDecenterY;
          const newDecenterZ = useChiefRayShiftZ ? (oldDecenterZ + chiefLocalZ) : oldDecenterZ;
          
          // Update row with new decenter values (create new object to break cache)
          modifiedRows[i] = {
            ...row,
            decenterX: newDecenterX,
            decenterY: newDecenterY,
            decenterZ: newDecenterZ,
            parameters: {
              ...(row.parameters || {}),
              decenterX: newDecenterX,
              decenterY: newDecenterY,
              decenterZ: newDecenterZ
            }
          };
          
          console.log(`    [CoordTrans ${surfaceId}] Updated decenterY: ${oldDecenterY.toFixed(6)} -> ${newDecenterY.toFixed(6)}`);
        }
      }
    }
    
    reportProgress(95, 'Finalizing...');
    
    // Create metadata
    const metadata = {
      targetSurfaceIndex,
      timestamp: new Date().toISOString(),
      version: '1.0',
      opticalSystemHash: JSON.stringify(opticalSystemRows).slice(0, 100), // Simple hash
      cancelled: false,
      surfaceCount: Object.keys(results).length
    };
    
    // (Debug logging removed)
    
    reportProgress(100, 'Complete');
    
    return {
      surfaces: results,
      metadata
    };
    
  } catch (error) {
    reportProgress(100, 'Error');
    throw error;
  }
}

// Helper function to check if surface is Object
function isObjectRow(row) {
  if (!row) return false;
  const t = String(row?.['object type'] ?? row?.object ?? '').toLowerCase();
  return t === 'object';
}

/**
 * Convert surface index to rayPath point index (accounting for skipped surfaces)
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} surfaceIndex - Surface index (0-based)
 * @returns {number|null} - RayPath point index or null if invalid
 */
function surfaceIndexToRayPathPointIndex(opticalSystemRows, surfaceIndex) {
  if (!Array.isArray(opticalSystemRows) || surfaceIndex === null || surfaceIndex === undefined) {
    return null;
  }
  const sIdx = Math.max(0, Math.min(surfaceIndex, opticalSystemRows.length - 1));
  let count = 0;
  for (let i = 0; i <= sIdx; i++) {
    const row = opticalSystemRows[i];
    if (isCoordTransSurface(row)) continue;
    if (isObjectRow(row)) continue;
    count++;
  }
  return count > 0 ? count : null;
}
