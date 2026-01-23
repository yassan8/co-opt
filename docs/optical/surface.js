import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';
import { getWASMSystem } from '../main.js';

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
  const ctor = attribute.array.constructor;
  const ctorName = ctor && ctor.name;
  if (!ctorName || typeof globalScope[ctorName] !== 'function') {
    return;
  }
  const TargetCtor = globalScope[ctorName];
  if (attribute.array instanceof TargetCtor) {
    return;
  }
  attribute.array = new TargetCtor(attribute.array);
  attribute.needsUpdate = true;
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
      cloneAttributeArrayToScope(attributes[key], globalScope);
    });
    if (geometry.index) {
      cloneAttributeArrayToScope(geometry.index, globalScope);
    }
  });
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
  
  // 負の半径に対応した球面計算
  const baseAbs = r2 / (absRadius * (1 + Math.sqrt(sqrtTerm)));
  const base = radius > 0 ? baseAbs : -baseAbs;

  let asphere = 0;
  const coefs = [coef1, coef2, coef3, coef4, coef5, coef6, coef7, coef8, coef9, coef10];
  for (let i = 0; i < coefs.length; i++) {
    if (mode === "even") {
      // Align with ray-tracing.js: coef1 corresponds to r^4.
      asphere += (coefs[i] || 0) * Math.pow(r, 2 * (i + 2));
    } else if (mode === "odd") {
      // Align with ray-tracing.js: coef1 corresponds to r^3.
      asphere += (coefs[i] || 0) * Math.pow(r, 2 * (i + 1) + 1);
    }
  }
  
  const result = base + asphere;
  
  // 結果が無効な場合のデバッグ
  if (!isFinite(result) && !asphericSurfaceZ._resultWarned) {
    // console.warn(`asphericSurfaceZ: result=${result} is invalid (base=${base}, asphere=${asphere})`);
    asphericSurfaceZ._resultWarned = true;
  }
  
  return result;
}

// ray-tracing.js 互換: 非球面サグの1階微分 ds/dr
// 解析式は条件分岐や符号(負半径)が絡むため、ここでは堅牢な数値微分を採用
export function asphericSagDerivative(r, params, mode = "even") {
  const rr = Number(r);
  if (!isFinite(rr)) {
    return NaN;
  }
  // スケールに応じて刻み幅を調整
  const base = Math.max(1, Math.abs(rr));
  const h = base * 1e-6;
  const f1 = asphericSurfaceZ(rr + h, params, mode);
  const f0 = asphericSurfaceZ(rr - h, params, mode);
  if (!isFinite(f1) || !isFinite(f0)) {
    return NaN;
  }
  return (f1 - f0) / (2 * h);
}

// Y-Z平面（高さ方向: -semidia～+semidia, 厚み方向: zOffset+z）で描画
export function drawAsphericProfile(scene, params, mode = "even", segments = 100, colorY = 0x000000, zOffset = 0, colorX = 0xff0000) {
  debugLog('🔸 drawAsphericProfile called:', { params, mode, segments, zOffset, colorY, colorX });
  
  const semidia = __coopt_getSemidiaMm(params);
  if (semidia === null) {
    debugLog('❌ Invalid semidia in drawAsphericProfile:', semidia);
    return;
  }
  
  // Y-Z平面（黒）
  const pointsYZ = [];
  for (let i = 0; i <= segments; i++) {
    const y = -semidia + (2 * semidia * i / segments);
    const z = asphericSurfaceZ(y, params, mode);
    if (!isFinite(z)) continue;
    pointsYZ.push(new THREE.Vector3(0, y, zOffset + z));
  }
  if (pointsYZ.length >= 2) {
    const geometry = new THREE.BufferGeometry().setFromPoints(pointsYZ);
    const material = new THREE.LineBasicMaterial({ color: colorY });
    const line = new THREE.Line(geometry, material);
    scene.add(line);
    debugLog('✅ Added Y-Z aspherical profile to scene, points:', pointsYZ.length);
  }
  
  // X-Z平面（赤）
  const pointsXZ = [];
  for (let i = 0; i <= segments; i++) {
    const x = -semidia + (2 * semidia * i / segments);
    const z = asphericSurfaceZ(x, params, mode);
    if (!isFinite(z)) continue;
    pointsXZ.push(new THREE.Vector3(x, 0, zOffset + z));
  }
  if (pointsXZ.length >= 2) {
    const geometry = new THREE.BufferGeometry().setFromPoints(pointsXZ);
    const material = new THREE.LineBasicMaterial({ color: colorX }); // ← 赤色(0xff0000)で描画
    const line = new THREE.Line(geometry, material);
    scene.add(line);
    debugLog('✅ Added X-Z aspherical profile to scene, points:', pointsXZ.length);
  }
  
  debugLog('✅ drawAsphericProfile completed, scene children:', scene.children.length);
}

// Y-Z平面・X-Z平面の平面プロファイル
export function drawPlaneProfile(scene, semidia = 20, segments = 100, colorY = 0x000000, zOffset = 0, colorX = 0xff0000) {
  debugLog('🔸 drawPlaneProfile called:', { semidia, segments, zOffset, colorY, colorX });
  
  semidia = Number(semidia);
  if (!isFinite(semidia) || semidia <= 0) {
    debugLog('❌ Invalid semidia:', semidia);
    return;
  }
  
  // Y-Z平面（黒）
  const pointsYZ = [];
  for (let i = 0; i <= segments; i++) {
    const y = -semidia + (2 * semidia * i / segments);
    pointsYZ.push(new THREE.Vector3(0, y, zOffset));
  }
  if (pointsYZ.length >= 2) {
    const geometry = new THREE.BufferGeometry().setFromPoints(pointsYZ);
    const material = new THREE.LineBasicMaterial({ color: colorY });
    const line = new THREE.Line(geometry, material);
    scene.add(line);
    debugLog('✅ Added Y-Z plane line to scene, points:', pointsYZ.length);
  }
  
  // X-Z平面（赤）
  const pointsXZ = [];
  for (let i = 0; i <= segments; i++) {
    const x = -semidia + (2 * semidia * i / segments);
    pointsXZ.push(new THREE.Vector3(x, 0, zOffset));
  }
  if (pointsXZ.length >= 2) {
    const geometry = new THREE.BufferGeometry().setFromPoints(pointsXZ);
    const material = new THREE.LineBasicMaterial({ color: colorX }); // ← 赤色(0xff0000)で描画
    const line = new THREE.Line(geometry, material);
    scene.add(line);
    debugLog('✅ Added X-Z plane line to scene, points:', pointsXZ.length);
  }
  
  debugLog('✅ drawPlaneProfile completed, scene children:', scene.children.length);
}

// --- レンズ表面（回転体）を描画（Z軸回転） ---
export function drawLensSurface(scene, params, mode = "even", segments = 100, zOffset = 0, color = 0x00ccff, opacity = 0.5, coordinateTransforms = []) {
  const { THREE: THREE_CTX, globalScope } = getSceneThreeContext(scene);
  const semidia = __coopt_getSemidiaMm(params);
  if (semidia === null) return;

  const positions = [];
  const indices = [];

  // radiusがINFや0や空文字なら超巨大値に置き換え
  let radiusRaw = params.radius;
  let radiusNum = Number(radiusRaw);
  if (
    String(radiusRaw).toUpperCase() === "INF" ||
    radiusRaw === "" ||
    radiusRaw === null ||
    !isFinite(radiusNum) ||
    radiusNum === 0
  ) {
    radiusNum = 1e18;
  }

  // すべてのパラメータを数値型で渡す（ここが重要！）
  const paramsForZ = {
    ...params,
    radius: radiusNum,
    conic: Number(params.conic) || 0,
    coef1: Number(params.coef1) || 0,
    coef2: Number(params.coef2) || 0,
    coef3: Number(params.coef3) || 0,
    coef4: Number(params.coef4) || 0,
    coef5: Number(params.coef5) || 0,
    coef6: Number(params.coef6) || 0,
    coef7: Number(params.coef7) || 0,
    coef8: Number(params.coef8) || 0,
    coef9: Number(params.coef9) || 0,
    coef10: Number(params.coef10) || 0,
  };
  // 各パラメータが数値かどうかチェック
  Object.entries(paramsForZ).forEach(([k, v]) => {
    if (["radius","conic","coef1","coef2","coef3","coef4","coef5","coef6","coef7","coef8","coef9","coef10"].includes(k)) {
      // if (typeof v !== "number") console.warn(`${k} is not a number:`, v, typeof v);
    }
  });

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * 2 * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const r = (semidia * j) / segments;
      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);
      let z = asphericSurfaceZ(r, paramsForZ, mode);
      if (!isFinite(z)) z = 0;
      
      // 座標ブレーク変換を適用（{0,0,0}中心で回転）
      let vertex = new THREE_CTX.Vector3(x, y, z);
      if (coordinateTransforms.length > 0) {
        const originalVertex = vertex.clone();
        vertex = applyCoordinateTransform(vertex, coordinateTransforms);
        // デバッグ: 最初の頂点のみログ出力
        // if (i === 0 && j === 0) {
        //   console.log(`Surface vertex transform: (${originalVertex.x.toFixed(3)}, ${originalVertex.y.toFixed(3)}, ${originalVertex.z.toFixed(3)}) → (${vertex.x.toFixed(3)}, ${vertex.y.toFixed(3)}, ${vertex.z.toFixed(3)})`);
        //   console.log(`Applied ${coordinateTransforms.length} coordinate transforms`);
        // }
      }
      
      // 座標変換後にzOffsetを加算（面の絶対位置に移動）
      vertex.z += zOffset;
      
      // NaN validation before adding to positions array
      if (isFinite(vertex.x) && isFinite(vertex.y) && isFinite(vertex.z)) {
        positions.push(vertex.x, vertex.y, vertex.z);
      } else {
        // console.warn(`❌ NaN vertex detected in drawLensSurface at (${i}, ${j}):`, 
        //            `(${vertex.x}, ${vertex.y}, ${vertex.z}), skipping`);
        // Use a fallback position (origin)
        positions.push(0, 0, zOffset);
      }
    }
  }

  if (positions.length === 0) {
    // console.warn("⚠ サーフェースの頂点が0。描画をスキップします。");
    return;
  }

  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j;
      const b = a + segments + 1;
      const c = a + 1;
      const d = b + 1;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  const geometry = new THREE_CTX.BufferGeometry();
  geometry.setAttribute("position", new THREE_CTX.Float32BufferAttribute(positions, 3));
  // WebGL1 fallback: prefer Uint16 when vertex count fits, otherwise rely on Uint32 w/ extension
  const vertexCount = positions.length / 3;
  const Uint16Ctor = globalScope?.Uint16Array || Uint16Array;
  const Uint32Ctor = globalScope?.Uint32Array || Uint32Array;
  const IndexArrayType = vertexCount <= 65535 ? Uint16Ctor : Uint32Ctor;
  const indexArray = new IndexArrayType(indices);
  geometry.setIndex(new THREE_CTX.BufferAttribute(indexArray, 1));
  // geometry.computeVertexNormals(); // ← この行をコメントアウトまたは削除

  const material = new THREE_CTX.MeshBasicMaterial({
    color: 0x00ccff,     // 水色に変更
    transparent: true, 
    opacity: 0.5,        // 透明度0.5に設定
    side: THREE_CTX.DoubleSide,
    depthWrite: false
  });

  const mesh = new THREE_CTX.Mesh(geometry, material);
  // mesh.position.z = zOffset; // 不要 - 頂点ですでにzOffsetが適用済み
  mesh.userData = { type: 'lensSurface', isLensSurface: true, surfaceType: '3DSurface' };
  scene.add(mesh);
  
  debugLog(`✅ drawLensSurface: Added 3D lens surface to scene, vertices: ${positions.length/3}, faces: ${indices.length/3}`);
  debugLog(`✅ Scene children after adding surface: ${scene.children.length}`);
}

// 座標変換1.5.md仕様準拠: 原点O(s)・回転行列R(s)を使用した3Dレンズサーフェス描画
export function drawLensSurfaceWithOrigin(scene, params, origin = {x: 0, y: 0, z: 0}, rotationMatrix = null, mode = "even", segments = 100, color = 0x00ccff, opacity = 0.5, surfaceType = 'Spherical') {
  const { THREE: THREE_CTX, globalScope } = getSceneThreeContext(scene);
  // originが undefined の場合は デフォルト値を設定
  if (!origin || typeof origin !== 'object') {
    origin = {x: 0, y: 0, z: 0};
  }
  
  // originの各プロパティが存在しない場合もデフォルト値を設定
  if (typeof origin.x !== 'number') origin.x = 0;
  if (typeof origin.y !== 'number') origin.y = 0;
  if (typeof origin.z !== 'number') origin.z = 0;
  
  debugLog(`🔸 drawLensSurfaceWithOrigin: Drawing 3D surface at origin O(s)=(${origin.x.toFixed(3)}, ${origin.y.toFixed(3)}, ${origin.z.toFixed(3)})`);
  debugLog(`🔸 Rotation matrix available: ${rotationMatrix ? 'YES' : 'NO'}`);
  if (rotationMatrix) {
    debugLog(`🔸 Rotation matrix:`, rotationMatrix);
  }
  
  const semidia = __coopt_getSemidiaMm(params);
  if (semidia === null) return;

  const apertureShape = __coopt_getApertureShape(params);
  const { width: apertureWidth, height: apertureHeight } = __coopt_getApertureDims(params);

  const positions = [];
  const indices = [];

  // radiusがINFや0や空文字なら超巨大値に置き換え
  let radiusRaw = params.radius;
  let radiusNum = Number(radiusRaw);
  if (
    String(radiusRaw).toUpperCase() === "INF" ||
    radiusRaw === "" ||
    radiusRaw === null ||
    !isFinite(radiusNum) ||
    radiusNum === 0
  ) {
    radiusNum = 1e18;
  }

  // すべてのパラメータを数値型で渡す
  const paramsForZ = {
    ...params,
    radius: radiusNum,
    conic: Number(params.conic) || 0,
    coef1: Number(params.coef1) || 0,
    coef2: Number(params.coef2) || 0,
    coef3: Number(params.coef3) || 0,
    coef4: Number(params.coef4) || 0,
    coef5: Number(params.coef5) || 0,
    coef6: Number(params.coef6) || 0,
    coef7: Number(params.coef7) || 0,
    coef8: Number(params.coef8) || 0,
    coef9: Number(params.coef9) || 0,
    coef10: Number(params.coef10) || 0,
  };

  const shouldUseRect = apertureShape === 'Square' || apertureShape === 'Rectangular';
  let rectWidth = apertureWidth;
  let rectHeight = apertureHeight;
  if (apertureShape === 'Square') {
    const side = rectWidth ?? rectHeight ?? (semidia > 0 ? semidia * 2 : null);
    rectWidth = side;
    rectHeight = side;
  } else if (apertureShape === 'Rectangular') {
    const fallback = (semidia > 0 ? semidia * 2 : null);
    rectWidth = rectWidth ?? rectHeight ?? fallback;
    rectHeight = rectHeight ?? rectWidth ?? fallback;
  }

  const useRectMesh = shouldUseRect && rectWidth !== null && rectHeight !== null && rectWidth > 0 && rectHeight > 0;

  if (useRectMesh) {
    const halfW = rectWidth / 2;
    const halfH = rectHeight / 2;
    for (let iy = 0; iy <= segments; iy++) {
      const y = -halfH + (2 * halfH * iy / segments);
      for (let ix = 0; ix <= segments; ix++) {
        const x = -halfW + (2 * halfW * ix / segments);
        const r = Math.sqrt(x * x + y * y);
        let z = asphericSurfaceZ(r, paramsForZ, mode);
        if (!isFinite(z)) z = 0;

        let vertex = new THREE_CTX.Vector3(x, y, z);
        if (rotationMatrix) {
          const R = rotationMatrix;
          const newX = R[0][0] * vertex.x + R[0][1] * vertex.y + R[0][2] * vertex.z;
          const newY = R[1][0] * vertex.x + R[1][1] * vertex.y + R[1][2] * vertex.z;
          const newZ = R[2][0] * vertex.x + R[2][1] * vertex.y + R[2][2] * vertex.z;
          if (isFinite(newX) && isFinite(newY) && isFinite(newZ)) {
            vertex = new THREE_CTX.Vector3(newX, newY, newZ);
          }
        }

        vertex.x += origin.x;
        vertex.y += origin.y;
        vertex.z += origin.z;

        if (isFinite(vertex.x) && isFinite(vertex.y) && isFinite(vertex.z)) {
          positions.push(vertex.x, vertex.y, vertex.z);
        } else {
          positions.push(origin.x, origin.y, origin.z);
        }
      }
    }
  } else {
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * 2 * Math.PI;
      for (let j = 0; j <= segments; j++) {
        const r = (semidia * j) / segments;
        const x = r * Math.cos(theta);
        const y = r * Math.sin(theta);
        let z = asphericSurfaceZ(r, paramsForZ, mode);
        if (!isFinite(z)) z = 0;
        
        // 座標変換を適用（回転行列と原点オフセット）
        let vertex = new THREE_CTX.Vector3(x, y, z);
        
        // 回転行列が指定されている場合は適用 with NaN validation
        if (rotationMatrix) {
          const R = rotationMatrix;
          const newX = R[0][0] * vertex.x + R[0][1] * vertex.y + R[0][2] * vertex.z;
          const newY = R[1][0] * vertex.x + R[1][1] * vertex.y + R[1][2] * vertex.z;
          const newZ = R[2][0] * vertex.x + R[2][1] * vertex.y + R[2][2] * vertex.z;
          
          if (isFinite(newX) && isFinite(newY) && isFinite(newZ)) {
            vertex = new THREE_CTX.Vector3(newX, newY, newZ);
          } else {
            // console.warn(`❌ NaN in rotation for surface vertex at (${i}, ${j}):`, 
            //            `(${newX}, ${newY}, ${newZ}), using original vertex`);
          }
        }
        
        // 原点オフセットを適用 with NaN validation
        vertex.x += origin.x;
        vertex.y += origin.y;
        vertex.z += origin.z;
        
        // NaN validation before adding to positions array
        if (isFinite(vertex.x) && isFinite(vertex.y) && isFinite(vertex.z)) {
          positions.push(vertex.x, vertex.y, vertex.z);
        } else {
          // console.warn(`❌ NaN vertex in drawLensSurfaceWithOrigin at (${i}, ${j}):`, 
          //            `(${vertex.x}, ${vertex.y}, ${vertex.z}), using fallback`);
          // Use a fallback position (origin)
          positions.push(origin.x, origin.y, origin.z);
        }
      }
    }
  }

  if (positions.length === 0) {
    // console.warn("⚠ サーフェースの頂点が0。描画をスキップします。");
    return;
  }

  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * (segments + 1) + j;
      const b = a + segments + 1;
      const c = a + 1;
      const d = b + 1;
      indices.push(a, b, c);
      indices.push(b, d, c);
    }
  }

  const geometry = new THREE_CTX.BufferGeometry();
  geometry.setAttribute("position", new THREE_CTX.Float32BufferAttribute(positions, 3));
  
  // SafariなどWebGL1コンテキストではUint32インデックスが使えないため頂点数で型を切り替える
  const vertexCount = positions.length / 3;
  const Uint16Ctor = globalScope?.Uint16Array || Uint16Array;
  const Uint32Ctor = globalScope?.Uint32Array || Uint32Array;
  const IndexArrayType = vertexCount <= 65535 ? Uint16Ctor : Uint32Ctor;
  const indexArray = new IndexArrayType(indices);
  geometry.setIndex(new THREE_CTX.BufferAttribute(indexArray, 1));

  const material = new THREE_CTX.MeshBasicMaterial({
    color: color,
    transparent: true,
    opacity: opacity,
    side: THREE_CTX.DoubleSide,
    depthWrite: false
  });

  const mesh = new THREE_CTX.Mesh(geometry, material);
  mesh.userData = { type: 'lensSurface', isLensSurface: true, surfaceType: '3DSurface' };
  scene.add(mesh);
  
  debugLog(`✅ drawLensSurfaceWithOrigin: Added 3D lens surface to scene, vertices: ${positions.length/3}, faces: ${indices.length/3}`);
  debugLog(`✅ Scene children after adding surface: ${scene.children.length}`);
}

// Sag計算を含むリング描画関数
export function drawSemidiaRingWithOriginAndSurface(scene, semidia = 20, segments = 100, color = 0x000000, origin = {x: 0, y: 0, z: 0}, rotationMatrix = null, surf = null) {
  const { THREE: THREE_CTX } = getSceneThreeContext(scene);
  // originが undefined の場合は デフォルト値を設定
  if (!origin || typeof origin !== 'object') {
    origin = {x: 0, y: 0, z: 0};
  }
  
  // originの各プロパティが存在しない場合もデフォルト値を設定
  if (typeof origin.x !== 'number') origin.x = 0;
  if (typeof origin.y !== 'number') origin.y = 0;
  if (typeof origin.z !== 'number') origin.z = 0;
  
  debugLog('🔸 drawSemidiaRingWithOriginAndSurface called:', { semidia, origin, surf: surf?.surfType });
  
  // Check if semidia is valid
  if (!isFinite(semidia) || semidia <= 0) {
    // console.warn('❌ Invalid semidia value:', semidia, 'skipping ring drawing');
    return;
  }

  // 非球面パラメータを準備
  let asphericParams = null;
  if (surf && surf.radius && surf.radius !== "INF") {
    const radius = parseFloat(surf.radius);
    if (isFinite(radius) && Math.abs(radius) > 0.001) {
      asphericParams = {
        radius: radius,
        conic: Number(surf.conic) || 0,
        coef1: Number(surf.coef1) || 0,
        coef2: Number(surf.coef2) || 0,
        coef3: Number(surf.coef3) || 0,
        coef4: Number(surf.coef4) || 0,
        coef5: Number(surf.coef5) || 0,
        coef6: Number(surf.coef6) || 0,
        coef7: Number(surf.coef7) || 0,
        coef8: Number(surf.coef8) || 0,
        coef9: Number(surf.coef9) || 0,
        coef10: Number(surf.coef10) || 0
      };
    }
  }

  // Create ring geometry
  const positions = [];
  
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * 2 * Math.PI;
    const x = semidia * Math.cos(theta);
    const y = semidia * Math.sin(theta);
    
    // 各点でsagを計算（円周上の各点での半径を使用）
    let sagZ = 0;
    if (asphericParams) {
      const r = Math.sqrt(x * x + y * y); // 各点での半径
      sagZ = asphericSurfaceZ(r, asphericParams, "even");
      if (!isFinite(sagZ)) {
        sagZ = 0; // 計算エラーの場合は0にフォールバック
      }
    }
    
    // Local座標系でのポイント
    let localPoint = new THREE_CTX.Vector3(x, y, sagZ);
    
    // 回転行列を適用（存在する場合）
    if (rotationMatrix && Array.isArray(rotationMatrix) && rotationMatrix.length >= 3) {
      const R = rotationMatrix;
      const newX = R[0][0] * localPoint.x + R[0][1] * localPoint.y + R[0][2] * localPoint.z;
      const newY = R[1][0] * localPoint.x + R[1][1] * localPoint.y + R[1][2] * localPoint.z;
      const newZ = R[2][0] * localPoint.x + R[2][1] * localPoint.y + R[2][2] * localPoint.z;
      localPoint = new THREE_CTX.Vector3(newX, newY, newZ);
    }
    
    // 原点座標を加算してグローバル座標に変換
    positions.push(
      origin.x + localPoint.x,
      origin.y + localPoint.y,
      origin.z + localPoint.z
    );
  }

  const geometry = new THREE_CTX.BufferGeometry();
  geometry.setAttribute('position', new THREE_CTX.Float32BufferAttribute(positions, 3));

  const material = new THREE_CTX.LineBasicMaterial({ 
    color: color,
    linewidth: 3,
    transparent: true,
    opacity: 1.0          // 完全に不透明に
  });

  const line = new THREE_CTX.LineLoop(geometry, material);
  line.userData = { 
    type: 'semidiaRing',
    semidia: semidia,
    isOpticalElement: true 
  };
  
  scene.add(line);
  
  debugLog(`🔸 ✅ Added semidia ring to scene, positions: ${positions.length/3}, scene children: ${scene.children.length}`);
  debugLog(`🔸 Ring at origin: (${origin.x.toFixed(3)}, ${origin.y.toFixed(3)}, ${origin.z.toFixed(3)}), semidia: ${semidia}`);
  
  // Debug: Log some sample positions to verify sag calculation (only for test scenarios)
  if (positions.length >= 6 && scene.children.length <= 10) { // Only show debug for simple test scenes
    console.log(`🔸 Ring debug - First point: (${positions[0].toFixed(3)}, ${positions[1].toFixed(3)}, ${positions[2].toFixed(3)})`);
    if (positions.length >= 12) {
      console.log(`🔸 Ring debug - Second point: (${positions[3].toFixed(3)}, ${positions[4].toFixed(3)}, ${positions[5].toFixed(3)})`);
    }
    
    // Debug: Check if sag calculation is working
    if (asphericParams) {
      const testSag = asphericSurfaceZ(semidia, asphericParams, "even");
      console.log(`🔸 Ring debug - Expected sag at semidia ${semidia}: ${testSag.toFixed(3)}`);
    }
  }
}

// Sag計算を含む矩形アパーチャ描画関数（サグ追従）
export function drawRectApertureWithOriginAndSurface(scene, width = 20, height = 20, segmentsPerEdge = 128, color = 0x000000, origin = {x: 0, y: 0, z: 0}, rotationMatrix = null, surf = null) {
  const { THREE: THREE_CTX } = getSceneThreeContext(scene);
  if (!origin || typeof origin !== 'object') origin = { x: 0, y: 0, z: 0 };
  if (typeof origin.x !== 'number') origin.x = 0;
  if (typeof origin.y !== 'number') origin.y = 0;
  if (typeof origin.z !== 'number') origin.z = 0;

  if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) return;

  const halfW = width / 2;
  const halfH = height / 2;
  const seg = Math.max(4, Math.floor(segmentsPerEdge || 0));

  // 非球面パラメータを準備
  let asphericParams = null;
  let asphereMode = 'even';
  if (surf && surf.radius && surf.radius !== 'INF') {
    const radius = parseFloat(surf.radius);
    if (isFinite(radius) && Math.abs(radius) > 0.001) {
      asphericParams = {
        radius: radius,
        conic: Number(surf.conic) || 0,
        coef1: Number(surf.coef1) || 0,
        coef2: Number(surf.coef2) || 0,
        coef3: Number(surf.coef3) || 0,
        coef4: Number(surf.coef4) || 0,
        coef5: Number(surf.coef5) || 0,
        coef6: Number(surf.coef6) || 0,
        coef7: Number(surf.coef7) || 0,
        coef8: Number(surf.coef8) || 0,
        coef9: Number(surf.coef9) || 0,
        coef10: Number(surf.coef10) || 0
      };
      try {
        const st = String(surf.surfType ?? '').toLowerCase();
        if (st.includes('odd')) asphereMode = 'odd';
      } catch (_) {}
    }
  }

  const positions = [];
  const pushPoint = (x, y) => {
    let sagZ = 0;
    if (asphericParams) {
      const r = Math.sqrt(x * x + y * y);
      sagZ = asphericSurfaceZ(r, asphericParams, asphereMode);
      if (!isFinite(sagZ)) sagZ = 0;
    }

    let localPoint = new THREE_CTX.Vector3(x, y, sagZ);
    if (rotationMatrix && Array.isArray(rotationMatrix) && rotationMatrix.length >= 3) {
      const R = rotationMatrix;
      const newX = R[0][0] * localPoint.x + R[0][1] * localPoint.y + R[0][2] * localPoint.z;
      const newY = R[1][0] * localPoint.x + R[1][1] * localPoint.y + R[1][2] * localPoint.z;
      const newZ = R[2][0] * localPoint.x + R[2][1] * localPoint.y + R[2][2] * localPoint.z;
      localPoint = new THREE_CTX.Vector3(newX, newY, newZ);
    }

    positions.push(
      origin.x + localPoint.x,
      origin.y + localPoint.y,
      origin.z + localPoint.z
    );
  };

  // Top edge
  for (let i = 0; i < seg; i++) {
    const t = i / seg;
    const x = -halfW + (2 * halfW) * t;
    pushPoint(x, halfH);
  }
  // Right edge
  for (let i = 0; i < seg; i++) {
    const t = i / seg;
    const y = halfH - (2 * halfH) * t;
    pushPoint(halfW, y);
  }
  // Bottom edge
  for (let i = 0; i < seg; i++) {
    const t = i / seg;
    const x = halfW - (2 * halfW) * t;
    pushPoint(x, -halfH);
  }
  // Left edge
  for (let i = 0; i < seg; i++) {
    const t = i / seg;
    const y = -halfH + (2 * halfH) * t;
    pushPoint(-halfW, y);
  }

  const geometry = new THREE_CTX.BufferGeometry();
  geometry.setAttribute('position', new THREE_CTX.Float32BufferAttribute(positions, 3));

  const material = new THREE_CTX.LineBasicMaterial({
    color: color,
    linewidth: 3,
    transparent: true,
    opacity: 1.0
  });

  const line = new THREE_CTX.LineLoop(geometry, material);
  line.userData = {
    type: 'apertureRect',
    width,
    height,
    isOpticalElement: true
  };

  scene.add(line);
}

// --- 座標変換ヘルパー関数（ray-tracing.jsと同様） ---
function applyRotation3D(vector, rotationRad) {
  // 回転順: Z→Y→X
  let { rx = 0, ry = 0, rz = 0 } = rotationRad || {};
  
  // Z軸回転
  let x1 = vector.x * Math.cos(rz) - vector.y * Math.sin(rz);
  let y1 = vector.x * Math.sin(rz) + vector.y * Math.cos(rz);
  let z1 = vector.z;
  
  // Y軸回転
  let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry);
  let y2 = y1;
  let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry);
  
  // X軸回転
  let x3 = x2;
  let y3 = y2 * Math.cos(rx) - z2 * Math.sin(rx);
  let z3 = y2 * Math.sin(rx) + z2 * Math.cos(rx);
  
  return new THREE.Vector3(x3, y3, z3);
}

// 逆回転（光線追跡と同じ処理）
function applyInvRotation3D(vector, rotationRad) {
  // 逆回転（X→Y→Zの逆順）
  let { rx = 0, ry = 0, rz = 0 } = rotationRad || {};
  rx = -rx;
  ry = -ry;
  rz = -rz;
  
  // X軸回転
  let x1 = vector.x;
  let y1 = vector.y * Math.cos(rx) - vector.z * Math.sin(rx);
  let z1 = vector.y * Math.sin(rx) + vector.z * Math.cos(rx);
  
  // Y軸回転
  let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry);
  let y2 = y1;
  let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry);
  
  // Z軸回転
  let x3 = x2 * Math.cos(rz) - y2 * Math.sin(rz);
  let y3 = x2 * Math.sin(rz) + y2 * Math.cos(rz);
  let z3 = z2;
  
  return new THREE.Vector3(x3, y3, z3);
}

// --- Coordinate Break情報を蓄積する構造体 ---
export function createCoordinateTransform(decenterX, decenterY, decenterZ, tiltX, tiltY, tiltZ, order, zOffset) {
  const nx = Number(decenterX);
  const ny = Number(decenterY);
  const nz = Number(decenterZ);
  const tx = Number(tiltX);
  const ty = Number(tiltY);
  const tz = Number(tiltZ);
  const o = Number(order);
  const zo = Number(zOffset);
  return {
    decenterX: Number.isFinite(nx) ? nx : 0,
    decenterY: Number.isFinite(ny) ? ny : 0,
    decenterZ: Number.isFinite(nz) ? nz : 0,
    tiltX: (Number.isFinite(tx) ? tx : 0) * Math.PI / 180, // ラジアンに変換
    tiltY: (Number.isFinite(ty) ? ty : 0) * Math.PI / 180,
    tiltZ: (Number.isFinite(tz) ? tz : 0) * Math.PI / 180,
    order: (o === 1) ? 1 : 0, // 0: Tilt→Decenter, 1: Decenter→Tilt
    zOffset: Number.isFinite(zo) ? zo : 0
  };
}

function applyCoordinateTransform(point, transforms) {
  if (transforms.length === 0) {
    return point.clone();
  }
  
  let result = point.clone();
  
  // 各変換を順番に適用
  for (const transform of transforms) {
    if (transform.order === 0) {
      // Order 0: Decenter → Tilt
      // 1. Decenter（並進）: X, Y, Z すべて適用（座標変換 1.0.md準拠）
      result.x += transform.decenterX;
      result.y += transform.decenterY;
      result.z += transform.decenterZ; // Decenter Z も累積適用
      
      // 2. Tilt（回転）：原点中心で回転 R = Rx.Ry.Rz
      const rotationMatrix = createRotationMatrix(transform.tiltX, transform.tiltY, transform.tiltZ, 0);
      const rotatedPoint = applyMatrixToVector(rotationMatrix, {
        x: result.x,
        y: result.y,
        z: result.z
      });
      result.x = rotatedPoint.x;
      result.y = rotatedPoint.y;
      result.z = rotatedPoint.z;
      
    } else {
      // Order 1: Tilt → Decenter  
      // 1. Tilt（回転）：原点中心で回転 R = Rz.Ry.Rx
      const rotationMatrix = createRotationMatrix(transform.tiltX, transform.tiltY, transform.tiltZ, 1);
      const rotatedPoint = applyMatrixToVector(rotationMatrix, {
        x: result.x,
        y: result.y,
        z: result.z
      });
      result.x = rotatedPoint.x;
      result.y = rotatedPoint.y;
      result.z = rotatedPoint.z;
      
      // 2. Decenter（並進）: X, Y, Z すべて適用（座標変換 1.0.md準拠）
      result.x += transform.decenterX;
      result.y += transform.decenterY;
      result.z += transform.decenterZ; // Decenter Z も累積適用
    }
  }
  
  return result;
}

// 3x3行列の乗算
function multiplyMatrices(a, b) {
  const result = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        result[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return result;
}

// Order 0/1に基づく回転行列作成
function createRotationMatrix(tiltX, tiltY, tiltZ, order) {
  const rx = createRotationMatrixX(tiltX);
  const ry = createRotationMatrixY(tiltY);
  const rz = createRotationMatrixZ(tiltZ);
  
  if (order === 0) {
    // Order 0: Decenter → Tilt: R = Rx.Ry.Rz
    return multiplyMatrices(multiplyMatrices(rx, ry), rz);
  } else {
    // Order 1: Tilt → Decenter: R = Rz.Ry.Rx
    return multiplyMatrices(multiplyMatrices(rz, ry), rx);
  }
}

// X軸回転行列
function createRotationMatrixX(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [1, 0, 0],
    [0, c, -s],
    [0, s, c]
  ];
}

// Y軸回転行列
function createRotationMatrixY(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c]
  ];
}

// Z軸回転行列
function createRotationMatrixZ(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1]
  ];
}

// 行列-ベクトル乗算
function applyMatrixToVector(matrix, vector) {
  return new THREE.Vector3(
    matrix[0][0] * vector.x + matrix[0][1] * vector.y + matrix[0][2] * vector.z,
    matrix[1][0] * vector.x + matrix[1][1] * vector.y + matrix[1][2] * vector.z,
    matrix[2][0] * vector.x + matrix[2][1] * vector.y + matrix[2][2] * vector.z
  );
}

// surfaces: 面データ配列（各要素に material, params, zOffset などがある想定）
export function drawLensCrossSection(scene, surfaces, coordinateTransforms = [], mode = "even", segments = 100) {
  // 既存のレンズグループを削除
  const existingGroups = scene.children.filter(child => child.userData?.isLensGroup);
  existingGroups.forEach(group => scene.remove(group));
    
    let group = new THREE.Group();

  // 断面プロファイルを格納
  const profilesYZ = [];
  const profilesXZ = [];
  const zOffsets = [];
  
  // 各面ごとにプロファイルを計算
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    
    // Object面の処理 - 描画から除外
    const objectType = s.params?.["object type"] || "";
    if (objectType === "Object") {
      // Object面は描画しない（プロファイルは作らない）
      profilesYZ.push(null);
      profilesXZ.push(null);
      zOffsets.push(s.zOffset);
      continue;
    }
    
    // Coordinate Break面の処理
    if (s.surfType === "Coord Break") {
      // Coordinate Break面は描画しない（プロファイルは作らない）
      profilesYZ.push(null);
      profilesXZ.push(null);
      zOffsets.push(s.zOffset);
      continue;
    }
    
    const mat = String(s.material ?? "").trim().toUpperCase();
    const pointsYZ = [];
    const pointsXZ = [];
    const semidia = Number(s.params.semidia);
    const radiusRaw = s.params.radius;
    const radiusNum = Number(radiusRaw);
    // radiusがINF文字列または数値的に無効なら平面扱い
    const isPlane = (
      !isFinite(radiusNum) ||
      radiusNum === 0 ||
      String(radiusRaw).toUpperCase() === "INF" ||
      radiusRaw === "" ||
      radiusRaw === null
    );
    
    // semidiaのチェック - Image面やStop面は特別扱い
    const surfaceObjectType = s.params?.["object type"] || "";
    const isSpecialSurface = surfaceObjectType === "Image" || surfaceObjectType === "Stop";
    
    if (!isFinite(semidia) || semidia <= 0) {
      if (isSpecialSurface) {
        // Special surface with default semidia
      } else {
        // Try to find a reasonable semidia from nearby surfaces
        let reasonableSemidia = 10; // fallback default
        for (let j = 0; j < surfaces.length; j++) {
          const nearSemidia = Number(surfaces[j]?.params?.semidia);
          if (isFinite(nearSemidia) && nearSemidia > 0) {
            reasonableSemidia = nearSemidia;
            break;
          }
        }
        // Continue processing with estimated semidia instead of skipping
      }
    }
    
    const effectiveSemidia = (() => {
      if (isSpecialSurface && (semidia <= 0)) return 10;
      if (semidia > 0) return semidia;
      
      // Find reasonable semidia from nearby surfaces
      for (let j = 0; j < surfaces.length; j++) {
        const nearSemidia = Number(surfaces[j]?.params?.semidia);
        if (isFinite(nearSemidia) && nearSemidia > 0) {
          return nearSemidia;
        }
      }
      return 10; // final fallback
    })();
    
    if (isPlane) {
      // 平面プロファイル - 正しいZ位置で作成
      for (let j = 0; j <= segments; j++) {
        const y = -effectiveSemidia + (2 * effectiveSemidia * j / segments);
        pointsYZ.push(new THREE.Vector3(0, y, s.zOffset)); // 最初からzOffsetで配置
        const x = -effectiveSemidia + (2 * effectiveSemidia * j / segments);
        pointsXZ.push(new THREE.Vector3(x, 0, s.zOffset)); // 最初からzOffsetで配置
      }
    } else {
      // 通常の非平面 - 正しいZ位置で作成
      let validYZPoints = 0;
      let validXZPoints = 0;
      
            for (let j = 0; j <= segments; j++) {
        const y = -effectiveSemidia + (2 * effectiveSemidia * j / segments);
        const z = asphericSurfaceZ(y, s.params, mode);
        if (isFinite(z)) {
          pointsYZ.push(new THREE.Vector3(0, y, s.zOffset + z)); // 最初からzOffsetで配置
          validYZPoints++;
        }
        
        const x = -effectiveSemidia + (2 * effectiveSemidia * j / segments);
        const z2 = asphericSurfaceZ(x, s.params, mode);
        if (isFinite(z2)) {
          pointsXZ.push(new THREE.Vector3(x, 0, s.zOffset + z2)); // 最初からzOffsetで配置
          validXZPoints++;
        }
      }
      
    }
    
    // Apply coordinate transforms if provided (with rotation center consideration)
    // ★ 各面固有の座標変換を適用（リング描画と同じロジック）
    if (s.coordinateTransforms && s.coordinateTransforms.length > 0) {
      // 各面に保存された座標変換配列を使用
      const applicableTransforms = s.coordinateTransforms;
      const lastTransform = applicableTransforms[applicableTransforms.length - 1];
      
      // デバッグ出力：座標変換前後の点を確認
      if (i === surfaces.length - 1) { // Image面の場合のみデバッグ出力
        // console.log(`🔍 Surface ${i} (Image面) - 座標変換デバッグ (面固有処理):`);
        // console.log(`  Transform Order: ${lastTransform.order}`);
        // console.log(`  Tilt: X=${(lastTransform.tiltX * 180 / Math.PI).toFixed(2)}° Y=${(lastTransform.tiltY * 180 / Math.PI).toFixed(2)}° Z=${(lastTransform.tiltZ * 180 / Math.PI).toFixed(2)}°`);
        // console.log(`  Rotation Center Z: ${lastTransform.zOffset}mm`);
        // console.log(`  Surface Z: ${s.zOffset}mm`);
        // console.log(`  面固有の座標変換配列サイズ: ${applicableTransforms.length}`);
        
        if (pointsYZ.length > 0) {
          const beforePoint = pointsYZ[0].clone();
          // console.log(`  変換前の最初の点: (${beforePoint.x.toFixed(3)}, ${beforePoint.y.toFixed(3)}, ${beforePoint.z.toFixed(3)})`);
        }
      }
      
      // Set rotation center to the Coordinate Break surface's Z position
      const rotationCenter = new THREE.Vector3(0, 0, lastTransform.zOffset);
      
      // Y-Z断面の座標変換（リングと同一処理）
      for (let j = 0; j < pointsYZ.length; j++) {
        const originalPoint = pointsYZ[j].clone();
        
        // 1. Move to origin relative to rotation center
        originalPoint.z -= rotationCenter.z;
        
        // 2. Apply coordinate transformation
        const transformedPoint = applyCoordinateTransform(originalPoint, [lastTransform]);
        
        // 3. Move back to correct position after transformation
        transformedPoint.z += rotationCenter.z;
        
        pointsYZ[j] = transformedPoint;
        
        // デバッグ出力：最初の点のみ
        if (i === surfaces.length - 1 && j === 0) {
          // console.log(`  変換後の最初の点: (${pointsYZ[j].x.toFixed(3)}, ${pointsYZ[j].y.toFixed(3)}, ${pointsYZ[j].z.toFixed(3)})`);
        }
      }
      
      // X-Z断面の座標変換（リングと同一処理）
      for (let j = 0; j < pointsXZ.length; j++) {
        const originalPoint = pointsXZ[j].clone();
        
        // 1. Move to origin relative to rotation center
        originalPoint.z -= rotationCenter.z;
        
        // 2. Apply coordinate transformation
        const transformedPoint = applyCoordinateTransform(originalPoint, [lastTransform]);
        
        // 3. Move back to correct position after transformation
        transformedPoint.z += rotationCenter.z;
        
        pointsXZ[j] = transformedPoint;
      }
    }
    
    // 座標変換後の最終位置確認（zOffsetは既に面生成時に適用済み）
    if (i === surfaces.length - 1 && pointsYZ.length > 0) {
      // console.log(`  最終の最初の点: (${pointsYZ[0].x.toFixed(3)}, ${pointsYZ[0].y.toFixed(3)}, ${pointsYZ[0].z.toFixed(3)})`);
    }
    
    profilesYZ.push(pointsYZ.length > 0 ? pointsYZ : null);
    profilesXZ.push(pointsXZ.length > 0 ? pointsXZ : null);
    zOffsets.push(s.zOffset);
  }

  // 個々の面のプロファイルを描画（レンズ区間に関係なく）
  let drawnYZ = 0, drawnXZ = 0;
  
  group.userData.isLensGroup = true; // グループ識別用
  
  for (let i = 0; i < surfaces.length; i++) {
    // console.log(`\n--- Processing Surface ${i} for drawing ---`);
    // console.log(`  surfType: ${surfaces[i].surfType}`);
    // console.log(`  material: ${surfaces[i].material}`);
    
    // if (surfaces[i].surfType === "Coord Break") {
    //   console.log(`  Surface ${i}: Skipping Coordinate Break surface`);
    //   continue;
    // }
    
    // YZ プロファイル描画
    if (profilesYZ[i] && profilesYZ[i].length > 0) {
      // console.log(`  Surface ${i}: Creating YZ profile with ${profilesYZ[i].length} points`);
      try {
        const geometryYZ = new THREE.BufferGeometry().setFromPoints(profilesYZ[i]);
        const materialYZ = new THREE.LineBasicMaterial({ 
          color: 0x000000,
          linewidth: 2
        });
        const lineYZ = new THREE.Line(geometryYZ, materialYZ);
        lineYZ.userData = { surfaceIndex: i, crossSection: 'YZ' };
        group.add(lineYZ);
        drawnYZ++;
        // console.log(`  ✓ Surface ${i}: YZ profile drawn successfully`);
        
        // 最初と最後の点をログ
        const first = profilesYZ[i][0];
        const last = profilesYZ[i][profilesYZ[i].length - 1];
        // console.log(`    YZ points range: (${first.x.toFixed(2)}, ${first.y.toFixed(2)}, ${first.z.toFixed(2)}) to (${last.x.toFixed(2)}, ${last.y.toFixed(2)}, ${last.z.toFixed(2)})`);
      } catch (error) {
        // console.error(`  ✗ Surface ${i}: YZ profile creation failed:`, error);
      }
    } else {
      const profileData = profilesYZ[i];
      // console.log(`  Surface ${i}: YZ profile SKIPPED - profile is ${profileData === null ? 'null' : (profileData === undefined ? 'undefined' : `array with ${profileData.length} points`)}`);
    }
    
    // XZ プロファイル描画
    if (profilesXZ[i] && profilesXZ[i].length > 0) {
      // console.log(`  Surface ${i}: Creating XZ profile with ${profilesXZ[i].length} points`);
      try {
        const geometryXZ = new THREE.BufferGeometry().setFromPoints(profilesXZ[i]);
        const materialXZ = new THREE.LineBasicMaterial({ 
          color: 0xff0000,
          linewidth: 2
        });
        const lineXZ = new THREE.Line(geometryXZ, materialXZ);
        lineXZ.userData = { surfaceIndex: i, crossSection: 'XZ' };
        group.add(lineXZ);
        drawnXZ++;
        // console.log(`  ✓ Surface ${i}: XZ profile drawn successfully`);
        
        // 最初と最後の点をログ
        const first = profilesXZ[i][0];
        const last = profilesXZ[i][profilesXZ[i].length - 1];
        // console.log(`    XZ points range: (${first.x.toFixed(2)}, ${first.y.toFixed(2)}, ${first.z.toFixed(2)}) to (${last.x.toFixed(2)}, ${last.y.toFixed(2)}, ${last.z.toFixed(2)})`);
      } catch (error) {
        // console.error(`  ✗ Surface ${i}: XZ profile creation failed:`, error);
      }
    } else {
      const profileData = profilesXZ[i];
      // console.log(`  Surface ${i}: XZ profile SKIPPED - profile is ${profileData === null ? 'null' : (profileData === undefined ? 'undefined' : `array with ${profileData.length} points`)}`);
    }
  }
  // Removed console.log statements for cleaner output

  // レンズ区間ごとに線を描画（レンズ面間の接続線）
  // console.log(`=== Drawing Lens Section Connections ===`);
  let startIdx = null;
  for (let i = 0; i < surfaces.length; i++) {
    // Coordinate Break面はスキップ
    if (surfaces[i].surfType === "Coord Break") continue;
    
    const mat = String(surfaces[i].material ?? "").trim().toUpperCase();
    const isLens = (mat !== "AIR" && mat !== "");
    if (isLens && startIdx === null) {
      startIdx = i; // レンズ区間開始
    }
    
    // 次の面を検索（Coordinate Break面をスキップ）
    let nextIdx = i + 1;
    while (nextIdx < surfaces.length && surfaces[nextIdx].surfType === "Coord Break") {
      nextIdx++;
    }
    
    const nextMat = (nextIdx < surfaces.length) ? String(surfaces[nextIdx].material ?? "").trim().toUpperCase() : "AIR";
    const isNextAir = (nextMat === "AIR" || nextMat === "");
    if (isLens && isNextAir && startIdx !== null) {
      // 区間 [startIdx, i] を描画
      for (let j = startIdx; j < i; j++) {
        // Coordinate Break面をスキップ
        if (surfaces[j].surfType === "Coord Break" || surfaces[j + 1].surfType === "Coord Break") continue;
        
        // YZ断面
        if (
          !profilesYZ[j] || !profilesYZ[j + 1] ||
          profilesYZ[j].length <= segments || profilesYZ[j + 1].length <= segments ||
          !profilesYZ[j][0] || !profilesYZ[j + 1][0] ||
          !profilesYZ[j][segments] || !profilesYZ[j + 1][segments]
        ) {
          // 端点が不正ならスキップ
          continue;
        }
        const geometryYZ = new THREE.BufferGeometry().setFromPoints(profilesYZ[j]);
        const materialYZ = new THREE.LineBasicMaterial({ color: 0x000000 });
        const lineYZ = new THREE.Line(geometryYZ, materialYZ);
        group.add(lineYZ);

        // 区間端点同士を線で繋ぐ
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            profilesYZ[j][0], profilesYZ[j + 1][0]
          ]),
          new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 })
        ));
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            profilesYZ[j][segments], profilesYZ[j + 1][segments]
          ]),
          new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 })
        ));

        // XZ断面
        if (
          !profilesXZ[j] || !profilesXZ[j + 1] ||
          profilesXZ[j].length <= segments || profilesXZ[j + 1].length <= segments ||
          !profilesXZ[j][0] || !profilesXZ[j + 1][0] ||
          !profilesXZ[j][segments] || !profilesXZ[j + 1][segments]
        ) {
          continue;
        }
        const geometryXZ = new THREE.BufferGeometry().setFromPoints(profilesXZ[j]);
        const materialXZ = new THREE.LineBasicMaterial({ color: 0xff0000 });
        const lineXZ = new THREE.Line(geometryXZ, materialXZ);
        group.add(lineXZ);

        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            profilesXZ[j][0], profilesXZ[j + 1][0]
          ]),
          new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 })
        ));
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            profilesXZ[j][segments], profilesXZ[j + 1][segments]
          ]),
          new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 })
        ));
      }

      // --- Air/空面との端点も繋ぐ ---
      const nextIdx = i + 1;
      if (
        profilesYZ[i] && profilesYZ[nextIdx] &&
        profilesYZ[i].length > segments && profilesYZ[nextIdx].length > segments &&
        profilesYZ[i][0] && profilesYZ[nextIdx][0] &&
        profilesYZ[i][segments] && profilesYZ[nextIdx][segments]
      ) {
        // YZ断面端点
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            profilesYZ[i][0], profilesYZ[nextIdx][0]
          ]),
          new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 })
        ));
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            profilesYZ[i][segments], profilesYZ[nextIdx][segments]
          ]),
          new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 })
        ));
      }
      if (
        profilesXZ[i] && profilesXZ[nextIdx] &&
        profilesXZ[i].length > segments && profilesXZ[nextIdx].length > segments &&
        profilesXZ[i][0] && profilesXZ[nextIdx][0] &&
        profilesXZ[i][segments] && profilesXZ[nextIdx][segments]
      ) {
        // XZ断面端点
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            profilesXZ[i][0], profilesXZ[nextIdx][0]
          ]),
          new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 })
        ));
        group.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            profilesXZ[i][segments], profilesXZ[nextIdx][segments]
          ]),
          new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 })
        ));
      }
      startIdx = null; // 区間終了
    }
  }

  scene.add(group);
}

// MIRROR面の背面にテキストを表示する関数
export function addMirrorBackText(scene, origin, rotationMatrix) {
  // テキストスプライト作成
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  
  const text = 'Mirror back';
  const fontSize = 30; // 30ptフォントを使用
  
  // フォント設定
  context.font = `bold ${fontSize}px Arial, sans-serif`;
  
  // テキストサイズ測定
  const metrics = context.measureText(text);
  const textWidth = metrics.width;
  const textHeight = fontSize;
  
  // キャンバスサイズ設定
  const padding = 6;
  canvas.width = textWidth + padding * 2;
  canvas.height = textHeight + padding * 2;
  
  // 背景描画
  context.fillStyle = 'rgba(255, 255, 255, 0.8)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  
  // 境界線描画
  context.strokeStyle = '#333333';
  context.lineWidth = 1;
  context.strokeRect(0, 0, canvas.width, canvas.height);
  
  // テキスト描画
  context.font = `bold ${fontSize}px Arial, sans-serif`;
  context.fillStyle = '#333333';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  
  // スプライト作成
  const texture = new THREE.CanvasTexture(canvas);
  const spriteMaterial = new THREE.SpriteMaterial({ 
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false
  });
  const sprite = new THREE.Sprite(spriteMaterial);
  
  // スプライトサイズ設定（10ptフォントに対応）
  const scale = 8;
  sprite.scale.set(canvas.width / scale, canvas.height / scale, 1);
  
  // テキスト位置計算（ミラー面の背面側、Local座標の{0,0,0}付近）
  let textPosition = new THREE.Vector3(0, 0, 10); // Z軸負方向にオフセット（背面側）
  
  // 回転行列が存在する場合は適用
  if (rotationMatrix && Array.isArray(rotationMatrix) && rotationMatrix.length >= 3) {
    const R = rotationMatrix;
    const newX = R[0][0] * textPosition.x + R[0][1] * textPosition.y + R[0][2] * textPosition.z;
    const newY = R[1][0] * textPosition.x + R[1][1] * textPosition.y + R[1][2] * textPosition.z;
    const newZ = R[2][0] * textPosition.x + R[2][1] * textPosition.y + R[2][2] * textPosition.z;
    textPosition.set(newX, newY, newZ);
  }
  
  // 原点座標を加算してグローバル座標に変換
  sprite.position.set(
    origin.x + textPosition.x,
    origin.y + textPosition.y,
    origin.z + textPosition.z
  );
  
  // レンダー順序を高く設定して前面に表示
  sprite.renderOrder = 1001;
  
  // ユーザーデータ設定（削除時の識別用）
  sprite.userData = { 
    type: 'mirrorBackText',
    isMirrorText: true,
    isOpticalElement: true
  };
  
  scene.add(sprite);
  
  // console.log('🪞 Added MIRROR back text at position:', sprite.position);
}

// 新規追加: O(s)/R(s) での断面描画関数
export function drawLensCrossSectionWithSurfaceOrigins(scene, rows, surfaceOrigins) {
    // console.log('🔸 drawLensCrossSectionWithSurfaceOrigins 開始');
    debugLog('🔸 Cross-section O(s)/R(s) drawing started');
    debugLog('🔸 Parameters check:', { scene: !!scene, rows: rows?.length, surfaceOrigins: surfaceOrigins?.length });
    
    // sceneの型チェック
    if (!scene) {
        // console.error('❌ scene parameter is undefined or null');
        return;
    }
    
    // rowsの型チェック
    if (!rows) {
        // console.error('❌ rows parameter is undefined or null');
        return;
    }
    
    if (!Array.isArray(rows)) {
        // console.error('❌ rows parameter is not an array:', typeof rows, rows);
        return;
    }
    
    if (!surfaceOrigins) {
        // console.error('❌ surfaceOrigins parameter is undefined or null');
        return;
    }
    
    if (!Array.isArray(surfaceOrigins)) {
        // console.error('❌ surfaceOrigins parameter is not an array:', typeof surfaceOrigins, surfaceOrigins);
        return;
    }
    
    let yzProfileCount = 0;
    let xzProfileCount = 0;
    
    // レンズ区間接続線描画
    let connectionLineCount = 0;
    
    // 接続線描画ロジック
    for (let i = 0; i < rows.length - 1; i++) {
        const currentSurf = rows[i];
        const nextSurf = rows[i + 1];
        
        // Object面をスキップ
        const currentObjectType = currentSurf["object type"] || "";
        if (currentObjectType === "Object") {
            continue;
        }
        
        // CB面はスキップ
        if (currentSurf.surfType === 'Coord Break') {
            continue;
        }
        
        // 次の面もCB面ならスキップ
        if (nextSurf.surfType === 'Coord Break') {
            continue;
        }
        
        // レンズ材料がある面から次の面への接続線を描画
        const isLens = currentSurf.material && 
                      currentSurf.material !== '' && 
                      currentSurf.material !== 'AIR' && 
                      currentSurf.material !== '0' &&
                      currentSurf.material !== 'MIRROR';
        
        if (isLens) {
            const surfaceIndex = i;
            const nextSurfaceIndex = i + 1;
            
            const startOrigin = surfaceOrigins[surfaceIndex];
            const endOrigin = surfaceOrigins[nextSurfaceIndex];
            
            if (startOrigin && endOrigin && startOrigin.origin && endOrigin.origin) {
              const startSemidia = __coopt_getSemidiaMm(currentSurf) ?? 0;
              const endSemidia = __coopt_getSemidiaMm(nextSurf) ?? 0;
                
                if (startSemidia > 0 && endSemidia > 0) {
                    // sag計算関数（非球面対応）
                    const calculateSag = (surf, r) => {
                        if (!surf.radius || surf.radius === "INF") return 0;
                        const radius = parseFloat(surf.radius);
                        if (!isFinite(radius) || Math.abs(radius) < 0.001) return 0;
                        
                        // 非球面パラメータを準備
                        const asphericParams = {
                            radius: radius,
                            conic: Number(surf.conic) || 0,
                            coef1: Number(surf.coef1) || 0,
                            coef2: Number(surf.coef2) || 0,
                            coef3: Number(surf.coef3) || 0,
                            coef4: Number(surf.coef4) || 0,
                            coef5: Number(surf.coef5) || 0,
                            coef6: Number(surf.coef6) || 0,
                            coef7: Number(surf.coef7) || 0,
                            coef8: Number(surf.coef8) || 0,
                            coef9: Number(surf.coef9) || 0,
                            coef10: Number(surf.coef10) || 0
                        };
                        
                        return asphericSurfaceZ(r, asphericParams, "even") || 0;
                    };
                    
                    // 接続線を描画する関数（4本の線: +Y, -Y, +X, -X）
                    const drawConnectionLine = (start, end, direction, sign, color) => {
                        const startSag = calculateSag(currentSurf, startSemidia);
                        const endSag = calculateSag(nextSurf, endSemidia);
                        
                        // 回転行列の適用
                        let startLocal, endLocal;
                        
                        if (direction === 'YZ') {
                            // Y軸方向（上下）
                            startLocal = new THREE.Vector3(0, sign * startSemidia, startSag);
                            endLocal = new THREE.Vector3(0, sign * endSemidia, endSag);
                        } else {
                            // X軸方向（左右）
                            startLocal = new THREE.Vector3(sign * startSemidia, 0, startSag);
                            endLocal = new THREE.Vector3(sign * endSemidia, 0, endSag);
                        }
                        
                        // 回転行列を適用 with NaN validation
                        if (startOrigin.rotationMatrix) {
                            const R = startOrigin.rotationMatrix;
                            const newX = R[0][0] * startLocal.x + R[0][1] * startLocal.y + R[0][2] * startLocal.z;
                            const newY = R[1][0] * startLocal.x + R[1][1] * startLocal.y + R[1][2] * startLocal.z;
                            const newZ = R[2][0] * startLocal.x + R[2][1] * startLocal.y + R[2][2] * startLocal.z;
                            
                            if (isFinite(newX) && isFinite(newY) && isFinite(newZ)) {
                                startLocal = new THREE.Vector3(newX, newY, newZ);
                            } else {
                                // console.warn(`❌ NaN in start rotation for connection line ${direction}:`, 
                                //            `(${newX}, ${newY}, ${newZ}), using original point`);
                            }
                        }
                        
                        if (endOrigin.rotationMatrix) {
                            const R = endOrigin.rotationMatrix;
                            const newX = R[0][0] * endLocal.x + R[0][1] * endLocal.y + R[0][2] * endLocal.z;
                            const newY = R[1][0] * endLocal.x + R[1][1] * endLocal.y + R[1][2] * endLocal.z;
                            const newZ = R[2][0] * endLocal.x + R[2][1] * endLocal.y + R[2][2] * endLocal.z;
                            
                            if (isFinite(newX) && isFinite(newY) && isFinite(newZ)) {
                                endLocal = new THREE.Vector3(newX, newY, newZ);
                            } else {
                                console.warn(`❌ NaN in end rotation for connection line ${direction}:`, 
                                           `(${newX}, ${newY}, ${newZ}), using original point`);
                            }
                        }
                        
                        // グローバル座標に変換 with NaN validation
                        const startGlobal = new THREE.Vector3(
                            startOrigin.origin.x + startLocal.x,
                            startOrigin.origin.y + startLocal.y,
                            startOrigin.origin.z + startLocal.z
                        );
                        
                        const endGlobal = new THREE.Vector3(
                            endOrigin.origin.x + endLocal.x,
                            endOrigin.origin.y + endLocal.y,
                            endOrigin.origin.z + endLocal.z
                        );
                        
                        // Additional validation for origin coordinates
                        if (!isFinite(startOrigin.origin.x) || !isFinite(startOrigin.origin.y) || !isFinite(startOrigin.origin.z)) {
                            console.warn(`❌ Invalid startOrigin:`, startOrigin.origin);
                            return;
                        }
                        if (!isFinite(endOrigin.origin.x) || !isFinite(endOrigin.origin.y) || !isFinite(endOrigin.origin.z)) {
                            console.warn(`❌ Invalid endOrigin:`, endOrigin.origin);
                            return;
                        }
                        
                        // NaN validation before creating geometry
                        if (!isFinite(startGlobal.x) || !isFinite(startGlobal.y) || !isFinite(startGlobal.z) ||
                            !isFinite(endGlobal.x) || !isFinite(endGlobal.y) || !isFinite(endGlobal.z)) {
                            console.warn(`❌ Skipping connection line due to NaN/Infinity coordinates:`, 
                                       `start=(${startGlobal.x}, ${startGlobal.y}, ${startGlobal.z})`,
                                       `end=(${endGlobal.x}, ${endGlobal.y}, ${endGlobal.z})`);
                            return;
                        }
                        
                        // 線分を描画
                        const points = [startGlobal, endGlobal];
                        const geometry = new THREE.BufferGeometry().setFromPoints(points);
                        const material = new THREE.LineBasicMaterial({ 
                            color: color,
                            linewidth: 3,
                            transparent: true,
                            opacity: 1.0,
                            depthTest: false
                        });
                        const line = new THREE.Line(geometry, material);
                        line.renderOrder = 1000;
                        line.userData = { 
                            type: 'connectionLine', 
                            direction: direction,
                            surfaceIndex: i + 1, 
                            isOpticalElement: true 
                        };
                        scene.add(line);
                    };
                    
                    // Y-Z方向（黒色）とX-Z方向（赤色）の接続線を4本描画
                    console.log(`🔗 Drawing 4 connection lines for surface ${i} to ${i+1}`);
                    drawConnectionLine(startOrigin.origin, endOrigin.origin, 'YZ', 1, 0x000000);   // +Y 黒
                    drawConnectionLine(startOrigin.origin, endOrigin.origin, 'YZ', -1, 0x000000);  // -Y 黒
                    drawConnectionLine(startOrigin.origin, endOrigin.origin, 'XZ', 1, 0xff0000);   // +X 赤
                    drawConnectionLine(startOrigin.origin, endOrigin.origin, 'XZ', -1, 0xff0000);  // -X 赤
                    
                    connectionLineCount += 4;
                }
            }
        }
    }
    
    // プロファイル描画
    console.log('🔸 プロファイル描画開始:', rows.length, '面');
    for (let i = 0; i < rows.length; i++) {
        const surf = rows[i];
        const origin = surfaceOrigins[i];
        
        // console.log(`🔸 Surface ${i}: type=${surf["object type"]}, surfType=${surf.surfType}, origin=`, origin?.origin);
        
        if (!origin || !origin.origin) {
            console.log(`🔸 Surface ${i}: origin無効、スキップ`);
            continue;
        }
        
        // Object面は描画しない（Zemax-imported systems include a bookkeeping Object plane at Surf 0).
        const objectType = surf["object type"] || "";
        if (objectType === "Object") {
          continue;
        }
        
        // CB面はスキップ
        if (surf.surfType === 'Coord Break') {
            console.log(`🔸 Surface ${i}: CB面、スキップ`);
            continue;
        }
        
        const semidia = __coopt_getSemidiaMm(surf);
        if (!semidia) {
          console.log(`🔸 Surface ${i}: semidia無効(${semidia})、スキップ`);
          continue;
        }

        const { halfX: profileHalfX, halfY: profileHalfY } = __coopt_getProfileHalfExtents(surf, semidia);
        
        // console.log(`🔸 Surface ${i}: 描画対象、semidia=${semidia}`);
        
        // Y-Z断面プロファイル（緑色）
        const yzPoints = [];
        const yzSteps = 40; // より細かい分割
        for (let i = 0; i <= yzSteps; i++) {
          const y = -profileHalfY + (2 * profileHalfY * i / yzSteps); // 均等分割
            const r = Math.abs(y);
            let z = 0;
            
            if (surf.radius && surf.radius !== "INF") {
                const asphericParams = {
                    radius: parseFloat(surf.radius),
                    conic: Number(surf.conic) || 0,
                    coef1: Number(surf.coef1) || 0,
                    coef2: Number(surf.coef2) || 0,
                    coef3: Number(surf.coef3) || 0,
                    coef4: Number(surf.coef4) || 0,
                    coef5: Number(surf.coef5) || 0,
                    coef6: Number(surf.coef6) || 0,
                    coef7: Number(surf.coef7) || 0,
                    coef8: Number(surf.coef8) || 0,
                    coef9: Number(surf.coef9) || 0,
                    coef10: Number(surf.coef10) || 0
                };
                z = asphericSurfaceZ(r, asphericParams, "even") || 0;
            }
            
            // Local座標
            let localPoint = new THREE.Vector3(0, y, z);
            
            // 回転行列を適用 with NaN validation
            if (origin.rotationMatrix) {
                const R = origin.rotationMatrix;
                const newX = R[0][0] * localPoint.x + R[0][1] * localPoint.y + R[0][2] * localPoint.z;
                const newY = R[1][0] * localPoint.x + R[1][1] * localPoint.y + R[1][2] * localPoint.z;
                const newZ = R[2][0] * localPoint.x + R[2][1] * localPoint.y + R[2][2] * localPoint.z;
                
                // Validate rotation results
                if (isFinite(newX) && isFinite(newY) && isFinite(newZ)) {
                    localPoint = new THREE.Vector3(newX, newY, newZ);
                } else {
                    console.warn(`❌ NaN in YZ rotation calculation for surface ${i}:`, 
                               `(${newX}, ${newY}, ${newZ}), using original point`);
                }
            }
            
            // グローバル座標に変換 with NaN validation
            const globalPoint = new THREE.Vector3(
                origin.origin.x + localPoint.x,
                origin.origin.y + localPoint.y,
                origin.origin.z + localPoint.z
            );
            
            // NaN validation before adding to points array
            if (isFinite(globalPoint.x) && isFinite(globalPoint.y) && isFinite(globalPoint.z)) {
                yzPoints.push(globalPoint);
            }
        }
        
        if (yzPoints.length > 1) {
            // console.log(`🔸 Surface ${i}: YZプロファイル描画、points=${yzPoints.length}`);
            const yzGeometry = new THREE.BufferGeometry();
            yzGeometry.setFromPoints(yzPoints);
            const yzMaterial = new THREE.LineBasicMaterial({ 
                color: 0x000000, // 黒色：Y軸方向のクロスセクション
                linewidth: 3,
                transparent: true,
                opacity: 1.0,
                depthTest: false
            });
            const yzLine = new THREE.Line(yzGeometry, yzMaterial);
            yzLine.renderOrder = 1000;
            yzLine.userData = { type: 'surfaceProfile', profileType: 'YZ', surfaceIndex: i + 1, isOpticalElement: true };
            scene.add(yzLine);
            yzProfileCount++;
        } else {
            console.log(`🔸 Surface ${i}: YZプロファイル点数不足、points=${yzPoints.length}`);
        }
        
        // X-Z断面プロファイル（赤色）
        const xzPoints = [];
        const xzSteps = 40; // より細かい分割
        for (let i = 0; i <= xzSteps; i++) {
          const x = -profileHalfX + (2 * profileHalfX * i / xzSteps); // 均等分割
            const r = Math.abs(x);
            let z = 0;
            
            if (surf.radius && surf.radius !== "INF") {
                const asphericParams = {
                    radius: parseFloat(surf.radius),
                    conic: Number(surf.conic) || 0,
                    coef1: Number(surf.coef1) || 0,
                    coef2: Number(surf.coef2) || 0,
                    coef3: Number(surf.coef3) || 0,
                    coef4: Number(surf.coef4) || 0,
                    coef5: Number(surf.coef5) || 0,
                    coef6: Number(surf.coef6) || 0,
                    coef7: Number(surf.coef7) || 0,
                    coef8: Number(surf.coef8) || 0,
                    coef9: Number(surf.coef9) || 0,
                    coef10: Number(surf.coef10) || 0
                };
                z = asphericSurfaceZ(r, asphericParams, "even") || 0;
            }
            
            // Local座標
            let localPoint = new THREE.Vector3(x, 0, z);
            
            // 回転行列を適用 with NaN validation
            if (origin.rotationMatrix) {
                const R = origin.rotationMatrix;
                const newX = R[0][0] * localPoint.x + R[0][1] * localPoint.y + R[0][2] * localPoint.z;
                const newY = R[1][0] * localPoint.x + R[1][1] * localPoint.y + R[1][2] * localPoint.z;
                const newZ = R[2][0] * localPoint.x + R[2][1] * localPoint.y + R[2][2] * localPoint.z;
                
                // Validate rotation results
                if (isFinite(newX) && isFinite(newY) && isFinite(newZ)) {
                    localPoint = new THREE.Vector3(newX, newY, newZ);
                } else {
                    console.warn(`❌ NaN in XZ rotation calculation for surface ${i}:`, 
                               `(${newX}, ${newY}, ${newZ}), using original point`);
                }
            }
            
            // グローバル座標に変換 with NaN validation
            const globalPoint = new THREE.Vector3(
                origin.origin.x + localPoint.x,
                origin.origin.y + localPoint.y,
                origin.origin.z + localPoint.z
            );
            
            // NaN validation before adding to points array
            if (isFinite(globalPoint.x) && isFinite(globalPoint.y) && isFinite(globalPoint.z)) {
                xzPoints.push(globalPoint);
            }
        }
        
        if (xzPoints.length > 1) {
            // console.log(`🔸 Surface ${i}: XZプロファイル描画、points=${xzPoints.length}`);
            const xzGeometry = new THREE.BufferGeometry();
            xzGeometry.setFromPoints(xzPoints);
            const xzMaterial = new THREE.LineBasicMaterial({ 
                color: 0xff0000, // 赤色：X軸方向のクロスセクション
                linewidth: 3,
                transparent: true,
                opacity: 1.0,
                depthTest: false
            });
            const xzLine = new THREE.Line(xzGeometry, xzMaterial);
            xzLine.renderOrder = 1000;
            xzLine.userData = { type: 'surfaceProfile', profileType: 'XZ', surfaceIndex: i + 1, isOpticalElement: true };
            scene.add(xzLine);
            xzProfileCount++;
        } else {
            console.log(`🔸 Surface ${i}: XZプロファイル点数不足、points=${xzPoints.length}`);
        }
    }
    
    debugLog(`🔸 Cross-section O(s)/R(s) drawing completed: ${yzProfileCount} YZ profiles, ${xzProfileCount} XZ profiles, ${connectionLineCount} connection lines`);
    // console.log(`✅ プロファイル描画完了: YZ=${yzProfileCount}, XZ=${xzProfileCount} 描画`);
    // console.log(`✅ Connection lines drawn: ${connectionLineCount} total`);
}