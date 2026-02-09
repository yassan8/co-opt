import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';
import { getWASMSystem } from '../main.ts';
import { toricSurfaceZ, toricSagDerivatives } from './surface-math.ts';

// Debug control: Set to true to enable all 🔸 debug logs
const ENABLE_DEBUG_LOGS = true;

// Debug logger function
function debugLog(...args) {
  if (ENABLE_DEBUG_LOGS) {
    console.log(...args);
  }
}

function __coopt_parseNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function __coopt_getSemidiaMm(params) {
  if (!params || typeof params !== 'object') return null;

  // CB rows propagate the prior surface's semidia in a dedicated field
  // to avoid confusing it with decenterX (which reuses the semidia column).
  const cbActual = __coopt_parseNumberOrNull(params.__cooptActualSemidia);
  if (cbActual !== null && cbActual > 0) return cbActual;

  const candidates = [
    params.semidia,
    params.SemiDia,
    params['Semi Dia'],
    params['semi dia'],
    params['Semi Diameter'],
    params['semi diameter'],
    params.semiDia,
    params.semiDiameter,
    params.semidiameter,
    params['semi_diameter'],
    params['semi-diameter'],
  ];

  for (const c of candidates) {
    const n = __coopt_parseNumberOrNull(c);
    if (n !== null && n > 0) return n;
  }

  // Stop surfaces sometimes provide diameter-like aperture. Use half as a last resort.
  try {
    const objType = String(params?.['object type'] ?? params?.object ?? params?.type ?? '').trim().toLowerCase();
    const isStop = objType === 'stop' || objType === 'sto';
    if (isStop) {
      const ap = __coopt_parseNumberOrNull(params.aperture ?? params.Aperture ?? params.diameter);
      if (ap !== null && ap > 0) return ap / 2;
    }
  } catch (_) {}

  return null;
}

function __coopt_getApertureShape(params) {
  const raw = params?._apertureShape ?? params?.apertureShape ?? params?.ApertureShape;
  const s = String(raw ?? '').trim();
  if (!s) return 'Circular';
  const key = s.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
  if (key === 'circle' || key === 'circular') return 'Circular';
  if (key === 'square' || key === 'sq') return 'Square';
  if (key === 'rect' || key === 'rectangle' || key === 'rectangular') return 'Rectangular';
  return 'Circular';
}

function __coopt_getApertureDims(params) {
  const wRaw = params?._apertureWidth ?? params?.apertureWidth ?? params?.apertureX ?? params?.apertureWidthMm;
  const hRaw = params?._apertureHeight ?? params?.apertureHeight ?? params?.apertureY ?? params?.apertureHeightMm;
  const w = __coopt_parseNumberOrNull(wRaw);
  const h = __coopt_parseNumberOrNull(hRaw);
  return { width: w, height: h };
}

function __coopt_getProfileHalfExtents(params, fallbackSemidia) {
  const shape = __coopt_getApertureShape(params);
  const { width, height } = __coopt_getApertureDims(params);
  const fallback = (Number.isFinite(fallbackSemidia) && fallbackSemidia > 0) ? fallbackSemidia : 0;

  if (shape === 'Square') {
    const side = (width !== null && width > 0) ? width : ((height !== null && height > 0) ? height : (fallback > 0 ? fallback * 2 : 0));
    const half = side > 0 ? side / 2 : fallback;
    return { halfX: half, halfY: half };
  }

  if (shape === 'Rectangular') {
    const w = (width !== null && width > 0) ? width : ((height !== null && height > 0) ? height : (fallback > 0 ? fallback * 2 : 0));
    const h = (height !== null && height > 0) ? height : ((width !== null && width > 0) ? width : (fallback > 0 ? fallback * 2 : 0));
    return { halfX: w > 0 ? w / 2 : fallback, halfY: h > 0 ? h / 2 : fallback };
  }

  return { halfX: fallback, halfY: fallback };
}

const GLOBAL_FALLBACK = typeof window !== 'undefined' ? window : globalThis;

function getSceneThreeContext(scene) {
  const context = scene?.userData?.renderContext || {};
  const globalScope = context.global || GLOBAL_FALLBACK;
  const threeInstance = context.three || THREE;
  return { THREE: threeInstance, globalScope };
}

function cloneAttributeArrayToScope(attribute, globalScope) {
  if (!attribute || !attribute.array || !globalScope) {
    return;
  }
  const array = attribute.array;
  if (Array.isArray(array)) {
    const Float32Ctor = globalScope.Float32Array || Float32Array;
    attribute.array = new Float32Ctor(array);
    attribute.needsUpdate = true;
    return;
  }
  if (!ArrayBuffer.isView(array)) {
    return;
  }
  const ctor = array.constructor;
  const ctorName = ctor && ctor.name;
  const allowed = new Set([
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array'
  ]);
  if (!ctorName) {
    return;
  }
  if (!allowed.has(ctorName)) {
    const Float32Ctor = globalScope.Float32Array || Float32Array;
    attribute.array = new Float32Ctor(array);
    attribute.needsUpdate = true;
    return;
  }
  if (typeof globalScope[ctorName] !== 'function') {
    return;
  }
  const TargetCtor = globalScope[ctorName];
  if (array instanceof TargetCtor) {
    return;
  }
  attribute.array = new TargetCtor(array);
  attribute.needsUpdate = true;
}

function normalizeAttributeArray(attribute, globalScope, options = {}) {
  if (!attribute || !globalScope) {
    return;
  }
  const isIndex = options.isIndex === true;
  const targetArray = attribute.isInterleavedBufferAttribute ? attribute.data?.array : attribute.array;
  if (!targetArray) {
    return;
  }
  if (Array.isArray(targetArray)) {
    if (isIndex) {
      let maxIndex = 0;
      for (let i = 0; i < targetArray.length; i++) {
        const value = targetArray[i];
        if (Number.isFinite(value) && value > maxIndex) {
          maxIndex = value;
        }
      }
      const IndexCtor = maxIndex <= 65535 ?
        (globalScope.Uint16Array || Uint16Array) :
        (globalScope.Uint32Array || Uint32Array);
      const converted = new IndexCtor(targetArray);
      if (attribute.isInterleavedBufferAttribute && attribute.data) {
        attribute.data.array = converted;
        attribute.data.needsUpdate = true;
      } else {
        attribute.array = converted;
        attribute.needsUpdate = true;
      }
      return;
    }
    const Float32Ctor = globalScope.Float32Array || Float32Array;
    const converted = new Float32Ctor(targetArray);
    if (attribute.isInterleavedBufferAttribute && attribute.data) {
      attribute.data.array = converted;
      attribute.data.needsUpdate = true;
    } else {
      attribute.array = converted;
      attribute.needsUpdate = true;
    }
    return;
  }
  if (!ArrayBuffer.isView(targetArray)) {
    return;
  }
  const ctorName = targetArray.constructor?.name;
  if (!ctorName) {
    return;
  }
  if (isIndex) {
    if (ctorName !== 'Uint16Array' && ctorName !== 'Uint32Array') {
      const Float32Ctor = globalScope.Float32Array || Float32Array;
      const converted = new Float32Ctor(targetArray);
      if (attribute.isInterleavedBufferAttribute && attribute.data) {
        attribute.data.array = converted;
        attribute.data.needsUpdate = true;
      } else {
        attribute.array = converted;
        attribute.needsUpdate = true;
      }
      return;
    }
  }
  const allowed = new Set([
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array'
  ]);
  if (!allowed.has(ctorName)) {
    const Float32Ctor = globalScope.Float32Array || Float32Array;
    const converted = new Float32Ctor(targetArray);
    if (attribute.isInterleavedBufferAttribute && attribute.data) {
      attribute.data.array = converted;
      attribute.data.needsUpdate = true;
    } else {
      attribute.array = converted;
      attribute.needsUpdate = true;
    }
    return;
  }
  const TargetCtor = globalScope[ctorName];
  if (typeof TargetCtor !== 'function') {
    return;
  }
  if (targetArray instanceof TargetCtor) {
    return;
  }
  const converted = new TargetCtor(targetArray);
  if (attribute.isInterleavedBufferAttribute && attribute.data) {
    attribute.data.array = converted;
    attribute.data.needsUpdate = true;
  } else {
    attribute.array = converted;
    attribute.needsUpdate = true;
  }
}

export function harmonizeSceneGeometry(scene) {
  if (!scene) {
    return;
  }
  const context = scene.userData?.renderContext || {};
  const globalScope = context.global || GLOBAL_FALLBACK;
  if (!globalScope) {
    return;
  }
  scene.traverse((object) => {
    const geometry = object.geometry;
    if (!geometry) {
      return;
    }
    const attributes = geometry.attributes || {};
    Object.keys(attributes).forEach((key) => {
      normalizeAttributeArray(attributes[key], globalScope, { isIndex: false });
    });
    const morphAttributes = geometry.morphAttributes || {};
    Object.keys(morphAttributes).forEach((key) => {
      const morphList = morphAttributes[key] || [];
      morphList.forEach((attr) => {
        normalizeAttributeArray(attr, globalScope, { isIndex: false });
      });
    });
    if (geometry.index) {
      normalizeAttributeArray(geometry.index, globalScope, { isIndex: true });
    }
  });
}

export function validateSceneGeometry(scene, label = '') {
  if (!scene) {
    return true;
  }
  const issues = [];
  const allowedAttributeTypes = new Set([
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array'
  ]);
  scene.traverse((object) => {
    const geometry = object.geometry;
    if (!geometry) {
      return;
    }
    const attributes = geometry.attributes || {};
    Object.keys(attributes).forEach((key) => {
      const attr = attributes[key];
      const array = attr?.array;
      if (!array) {
        issues.push({ type: 'attribute-missing-array', key, object: object.name || object.uuid });
        return;
      }
      if (Array.isArray(array)) {
        issues.push({ type: 'attribute-plain-array', key, object: object.name || object.uuid });
        return;
      }
      const ctorName = array.constructor?.name;
      if (!allowedAttributeTypes.has(ctorName)) {
        issues.push({ type: 'attribute-unsupported-type', key, ctorName, object: object.name || object.uuid });
      }
      if (!Number.isInteger(attr.itemSize) || attr.itemSize <= 0) {
        issues.push({ type: 'attribute-invalid-itemSize', key, itemSize: attr.itemSize, object: object.name || object.uuid });
      }
    });
    if (geometry.index) {
      const indexArray = geometry.index.array;
      if (Array.isArray(indexArray)) {
        issues.push({ type: 'index-plain-array', object: object.name || object.uuid });
      } else {
        const ctorName = indexArray?.constructor?.name;
        if (ctorName && ctorName !== 'Uint16Array' && ctorName !== 'Uint32Array') {
          issues.push({ type: 'index-unsupported-type', ctorName, object: object.name || object.uuid });
        }
      }
    }
  });
  if (issues.length > 0) {
    console.error('❌ Geometry validation issues', { label, count: issues.length, issues: issues.slice(0, 20) });
    issues.slice(0, 20).forEach((issue, idx) => {
      console.error(`❌ [${label}] issue ${idx + 1}`, issue);
    });
    return false;
  }
  console.log('✅ Geometry validation passed', { label });
  return true;
}

export function asphericSurfaceZ(r, params, mode = "even") {
  const { radius, conic, coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10 } = params;
  
  // Try WASM first for performance
  try {
    const wasmSystem = getWASMSystem();
    if (wasmSystem && wasmSystem.isWASMReady) {
      // Prefer WASM for even mode. Pass coef1..coef10 (A4..A22).
      // If the loaded WASM module doesn't have the extended entrypoint yet,
      // ForceWASMSystem falls back to legacy + JS add.
      const m = String(mode || '').toLowerCase();
      if (m === 'even') {
        const c = 1 / radius;
        const k = Number(conic) || 0;
        // IMPORTANT: align coefficient convention with ray-tracing.js
        // even: coef1..10 => A4..A22 (r^4..r^22)
        // The WASM entrypoint takes A4..A22, so this is a direct mapping.
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
        const out = wasmSystem.forceAsphericSag(Number(r), c, k, a4, a6, a8, a10, a12, a14, a16, a18, a20, a22);
        if (isFinite(out)) {
          return out;
        }
      }
    }
  } catch (error) {
    // Fallback to JavaScript
  }
  
  // JavaScript fallback
  if (!isFinite(radius) || radius === 0) {
    if (!asphericSurfaceZ._radiusWarned) {
      // console.warn(`asphericSurfaceZ: radius=${radius} is invalid, returning NaN`);
      asphericSurfaceZ._radiusWarned = true;
    return NaN;}
  }
  
  const r2 = r * r;
  const absRadius = Math.abs(radius);
  const sqrtTerm = 1 - (1 + conic) * r2 / (absRadius * absRadius);
  
  if (!isFinite(sqrtTerm) || sqrtTerm < 0) {
    if (!asphericSurfaceZ._sqrtWarned) {
      // console.warn(`asphericSurfaceZ: sqrtTerm=${sqrtTerm} is invalid (r=${r}, conic=${conic}, radius=${radius}), returning NaN`);
      asphericSurfaceZ._sqrtWarned = true;
    }
    return NaN;
  }
  
