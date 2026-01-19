/**
 * Longitudinal Aberration Calculator (Spherical Aberration Diagram)
 * 球面収差計算モジュール
 * 
 * 球面収差 (Spherical Aberration) は光軸方向の焦点位置のずれを表す。
 * 異なる瞳座標から入射した光線が光軸と交差する位置（焦点）の違いを計算する。
 * 
 * 計算方法:
 * 1. 各瞳座標の光線を追跡
 * 2. 像面付近で光軸との交点を求める
 * 3. 主波長の近軸像点（BFL）を基準として、各光線の焦点位置のずれを計算
 * 
 * プロット形式:
 * - X軸: 縦収差（Longitudinal Aberration）[mm] - Z軸方向の焦点位置のずれ
 * - Y軸: 正規化瞳座標（Normalized Pupil Coordinate）- 絞り面での高さを半径で正規化
 */

import { generateFiniteSystemCrossBeam } from './gen-ray-cross-finite.js';
import { generateInfiniteSystemCrossBeam } from './gen-ray-cross-infinite.js';
import { traceRay, traceRayHitPoint, calculateSurfaceOrigins } from './ray-tracing.js';
import { getObjectRows } from './utils/data-utils.js';
import { calculateBackFocalLength, getRefractiveIndex } from './ray-paraxial.js';

function applyRotationMatrixToVector(matrix, v) {
    if (!matrix) return { x: v.x, y: v.y, z: v.z };
    const x = matrix[0][0] * v.x + matrix[0][1] * v.y + matrix[0][2] * v.z;
    const y = matrix[1][0] * v.x + matrix[1][1] * v.y + matrix[1][2] * v.z;
    const z = matrix[2][0] * v.x + matrix[2][1] * v.y + matrix[2][2] * v.z;
    return { x, y, z };
}

function normalizeVector3(v, fallback = { x: 1, y: 0, z: 0 }) {
    const L = Math.hypot(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0);
    if (!(L > 0)) return { ...fallback };
    return { x: v.x / L, y: v.y / L, z: v.z / L };
}

function dot3(a, b) {
    return (a.x * b.x) + (a.y * b.y) + (a.z * b.z);
}

function getStopLocalOffsets(stopPoint3d, stopPlaneCenter3d, stopPlaneU, stopPlaneV) {
    if (!stopPoint3d || !stopPlaneCenter3d || !stopPlaneU || !stopPlaneV) return null;
    const d = {
        x: stopPoint3d.x - stopPlaneCenter3d.x,
        y: stopPoint3d.y - stopPlaneCenter3d.y,
        z: stopPoint3d.z - stopPlaneCenter3d.z
    };
    return {
        u: dot3(d, stopPlaneU),
        v: dot3(d, stopPlaneV)
    };
}

function solveRayDirectionToStopPointFast(centerPoint, stopTarget3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm) {
    const stopIdx = Number(stopSurfaceIndex);
    if (!Number.isInteger(stopIdx) || stopIdx < 0) return null;
    if (!centerPoint || !stopTarget3d) return null;

    const dx0 = Number(stopTarget3d.x) - Number(centerPoint.x);
    const dy0 = Number(stopTarget3d.y) - Number(centerPoint.y);
    const dz0 = Number(stopTarget3d.z) - Number(centerPoint.z);
    if (!Number.isFinite(dx0) || !Number.isFinite(dy0) || !Number.isFinite(dz0)) return null;
    if (Math.abs(dz0) < 1e-9) return null;

    const buildDirFromSlopes = (u, v) => {
        const zSign = dz0 >= 0 ? 1 : -1;
        return normalizeVector3({ x: u, y: v, z: zSign }, { x: 0, y: 0, z: zSign });
    };

    const initial = normalizeVector3({ x: dx0, y: dy0, z: dz0 }, { x: 0, y: 0, z: 1 });
    let u = (Math.abs(initial.z) > 1e-9) ? (initial.x / initial.z) : 0;
    let v = (Math.abs(initial.z) > 1e-9) ? (initial.y / initial.z) : 0;

    const maxIter = 6;
    const tolMm = 1e-3;
    const eps = 1e-4;
    const maxSlope = 2.5;

    for (let iter = 0; iter < maxIter; iter++) {
        u = Math.max(-maxSlope, Math.min(maxSlope, u));
        v = Math.max(-maxSlope, Math.min(maxSlope, v));

        const dir = buildDirFromSlopes(u, v);
        const ray = { wavelength: wavelengthUm, pos: { ...centerPoint }, dir };
        const hit = traceRayHitPoint(opticalSystemRows, ray, 1.0, stopIdx);
        if (!hit) return null;

        const ex = Number(hit.x) - Number(stopTarget3d.x);
        const ey = Number(hit.y) - Number(stopTarget3d.y);
        if (!Number.isFinite(ex) || !Number.isFinite(ey)) return null;
        const err = Math.hypot(ex, ey);
        if (err < tolMm) return dir;

        const hitU = traceRayHitPoint(
            opticalSystemRows,
            { wavelength: wavelengthUm, pos: { ...centerPoint }, dir: buildDirFromSlopes(u + eps, v) },
            1.0,
            stopIdx
        );
        const hitV = traceRayHitPoint(
            opticalSystemRows,
            { wavelength: wavelengthUm, pos: { ...centerPoint }, dir: buildDirFromSlopes(u, v + eps) },
            1.0,
            stopIdx
        );
        if (!hitU || !hitV) return null;

        const j11 = (Number(hitU.x) - Number(hit.x)) / eps;
        const j21 = (Number(hitU.y) - Number(hit.y)) / eps;
        const j12 = (Number(hitV.x) - Number(hit.x)) / eps;
        const j22 = (Number(hitV.y) - Number(hit.y)) / eps;
        if (![j11, j12, j21, j22].every(Number.isFinite)) return null;

        const det = j11 * j22 - j12 * j21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
            u -= 0.05 * ex;
            v -= 0.05 * ey;
            continue;
        }

        let du = (-j22 * ex + j12 * ey) / det;
        let dv = (j21 * ex - j11 * ey) / det;
        const stepNorm = Math.hypot(du, dv);
        if (stepNorm > 0.5) {
            const scale = 0.5 / stepNorm;
            du *= scale;
            dv *= scale;
        }
        u += du;
        v += dv;
    }

    return buildDirFromSlopes(u, v);
}

function solveChiefRayDirectionToStopCenterFast(centerPoint, stopCenter3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm) {
    return solveRayDirectionToStopPointFast(centerPoint, stopCenter3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm);
}

function solveRayOriginToStopPointFast(initialOrigin, dirVector, stopTarget3d, stopSurfaceIndex, opticalSystemRows, wavelengthUm) {
    const stopIdx = Number(stopSurfaceIndex);
    if (!Number.isInteger(stopIdx) || stopIdx < 0) return null;
    if (!initialOrigin || !dirVector || !stopTarget3d) return null;

    const baseDir = normalizeVector3(dirVector, { x: 0, y: 0, z: 1 });
    if (!Number.isFinite(baseDir.x) || !Number.isFinite(baseDir.y) || !Number.isFinite(baseDir.z)) return null;

    let origin = { x: Number(initialOrigin.x), y: Number(initialOrigin.y), z: Number(initialOrigin.z) };
    if (![origin.x, origin.y, origin.z].every(Number.isFinite)) return null;

    const eps = 1e-3;
    const tolMm = 1e-3;
    const maxIter = 10;

    const hitAt = (o) => traceRayHitPoint(
        opticalSystemRows,
        { wavelength: wavelengthUm, pos: { ...o }, dir: { ...baseDir } },
        1.0,
        stopIdx
    );

    for (let iter = 0; iter < maxIter; iter++) {
        const hit = hitAt(origin);
        if (!hit) return null;
        const ex = Number(hit.x) - Number(stopTarget3d.x);
        const ey = Number(hit.y) - Number(stopTarget3d.y);
        if (!Number.isFinite(ex) || !Number.isFinite(ey)) return null;
        const err = Math.hypot(ex, ey);
        if (err < tolMm) return origin;

        const hitX = hitAt({ x: origin.x + eps, y: origin.y, z: origin.z });
        const hitY = hitAt({ x: origin.x, y: origin.y + eps, z: origin.z });
        if (!hitX || !hitY) return null;

        const j11 = (Number(hitX.x) - Number(hit.x)) / eps;
        const j21 = (Number(hitX.y) - Number(hit.y)) / eps;
        const j12 = (Number(hitY.x) - Number(hit.x)) / eps;
        const j22 = (Number(hitY.y) - Number(hit.y)) / eps;
        if (![j11, j12, j21, j22].every(Number.isFinite)) return null;

        const det = j11 * j22 - j12 * j21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;

        let dx = (-j22 * ex + j12 * ey) / det;
        let dy = (j21 * ex - j11 * ey) / det;
        const stepNorm = Math.hypot(dx, dy);
        if (stepNorm > 5.0) {
            const scale = 5.0 / stepNorm;
            dx *= scale;
            dy *= scale;
        }
        origin = { x: origin.x + dx, y: origin.y + dy, z: origin.z };
    }

    return origin;
}

/**
 * 指定した正規化瞳座標に補間点を追加する
 * 実測データのみで計算し、外挿は行わない
 */
function insertInterpolatedPoint(points, targetNormalized) {
    if (!Array.isArray(points) || points.length < 2) return points;

    // 既に近傍に点がある場合は追加しない
    const exists = points.some(p => Math.abs(p.pupilCoordinate - targetNormalized) <= 1e-5);
    if (exists) return points;

    // 正規化瞳座標でソートして境界を探す
    points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);

    let lower = null;
    let upper = null;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.pupilCoordinate < targetNormalized) {
            lower = p;
        } else {
            upper = p;
            break;
        }
    }

    // 両側がない場合は最も近い点をクランプして使用（描画を欠損させないための最小限の外挿）
    let newPoint;
    if (!lower || !upper) {
        const closest = lower || upper;
        newPoint = {
            ...closest,
            pupilCoordinate: targetNormalized
        };
    } else {
        const ratio = (targetNormalized - lower.pupilCoordinate) / (upper.pupilCoordinate - lower.pupilCoordinate);
        const lerp = (a, b) => a + (b - a) * ratio;
        newPoint = {
            pupilCoordinate: targetNormalized,
            longitudinalAberration: lerp(lower.longitudinalAberration, upper.longitudinalAberration),
            focusPosition: lerp(lower.focusPosition, upper.focusPosition),
            stopHeight: lerp(lower.stopHeight, upper.stopHeight),
            transverseAberration: lerp(lower.transverseAberration, upper.transverseAberration),
            sineConditionViolation: (lower.sineConditionViolation !== null && upper.sineConditionViolation !== null)
                ? lerp(lower.sineConditionViolation, upper.sineConditionViolation)
                : null
        };
    }

    points.push(newPoint);
    points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
    return points;
}

function buildNormalizedPupilSamples(rayCount) {
    const n = Math.max(2, Math.floor(rayCount));
    const samples = [];
    for (let i = 0; i < n; i++) {
        samples.push(i / (n - 1));
    }
    // 0.001を必ず含める（rayCountを増やさずに2番目を置換）
    if (n >= 3) {
        samples[1] = 0.001;
        if (samples[1] <= samples[0]) samples[1] = Math.max(1e-6, samples[0] + 1e-6);
        if (samples[1] >= samples[2]) samples[1] = Math.max(1e-6, samples[2] * 0.5);
    } else if (n === 2) {
        // [0, 1] しか作れないので、0.001は後段の補間に任せる
    }
    // 重複排除＆昇順
    const unique = Array.from(new Set(samples.map(v => +v.toFixed(12)))).sort((a, b) => a - b);
    return unique;
}

function traceRayWrapped(opticalSystemRows, ray0, targetSurfaceIndex, originalRayMeta) {
    try {
        const rayPath = traceRay(opticalSystemRows, ray0, 1.0, null, targetSurfaceIndex);
        const success = Array.isArray(rayPath) && rayPath.length > 1;
        return {
            success,
            originalRay: originalRayMeta,
            rayPath
        };
    } catch (error) {
        return {
            success: false,
            originalRay: originalRayMeta,
            rayPath: null,
            error
        };
    }
}

// Convert an optical table surface index to a rayPath point index.
// NOTE: Object rows and Coord Break rows do not create intersection points in rayPath.
function surfaceIndexToRayPathPointIndex(rows, surfaceIndex) {
    const idx = Number(surfaceIndex);
    if (!Array.isArray(rows) || !Number.isInteger(idx) || idx < 0) return null;
    let pointIndex = 0;
    for (let s = 0; s <= idx; s++) {
        const r = rows[s] || {};
        const objTypeRaw = r?.['object type'] ?? r?.objectType ?? r?.object ?? '';
        const surfTypeRaw = r?.surfType ?? r?.surface_type ?? r?.['surf type'] ?? r?.type ?? '';
        const nObj = String(objTypeRaw ?? '').trim().toLowerCase();
        const nSurf = String(surfTypeRaw ?? '').trim().toLowerCase();
        const compact = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');

        const isObject = (nObj === 'object' || compact(nObj) === 'object') || (nSurf === 'object' || compact(nSurf) === 'object');
        const isCoordBreak =
            nObj === 'coord break' || nObj === 'coordinate break' || nObj === 'cb' ||
            compact(nObj) === 'coordbreak' || compact(nObj) === 'coordinatebreak' ||
            nSurf === 'coord break' || nSurf === 'coordinate break' || nSurf === 'cb' ||
            compact(nSurf) === 'coordbreak' || compact(nSurf) === 'coordinatebreak';

        if (isObject || isCoordBreak) continue;
        pointIndex++;
    }
    return pointIndex;
}

function bisectionSolve01(getValueAtT, targetValue, maxIter = 40, tol = 1e-6) {
    let lo = 0;
    let hi = 1;
    let vlo = getValueAtT(lo);
    let vhi = getValueAtT(hi);

    if (!Number.isFinite(vlo) || !Number.isFinite(vhi)) return null;
    if (targetValue <= vlo) return 0;
    if (targetValue >= vhi) return 1;

    for (let iter = 0; iter < maxIter; iter++) {
        const mid = (lo + hi) / 2;
        const vmid = getValueAtT(mid);
        if (!Number.isFinite(vmid)) {
            // 追跡失敗等：区間を狭める（安全側）
            hi = mid;
            continue;
        }
        const err = vmid - targetValue;
        if (Math.abs(err) <= tol) return mid;
        if (err < 0) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return (lo + hi) / 2;
}

/**
 * Source tableから主波長を取得
 */
function getPrimaryWavelength() {
    try {
        // window.tableSourceから主波長を取得
        if (window.tableSource && typeof window.tableSource.getData === 'function') {
            const sourceRows = window.tableSource.getData();
            const primaryRow = sourceRows.find(row => row.primary === 'Primary Wavelength' || row.primary === 'primary');
            if (primaryRow && primaryRow.wavelength) {
                const wavelength = parseFloat(primaryRow.wavelength);
                console.log(`  主波長: ${wavelength.toFixed(4)} μm`);
                return wavelength;
            }
        }
    } catch (error) {
        console.warn('主波長の取得に失敗しました:', error);
    }
    
    // デフォルト波長（d線）
    console.log('  主波長が設定されていないため、d線（0.5876 μm）を使用');
    return 0.5876;
}

/**
 * Source tableから全波長を取得
 * @returns {Array} 波長配列 (μm)
 */
function getAllWavelengths() {
    try {
        if (window.tableSource && typeof window.tableSource.getData === 'function') {
            const sourceRows = window.tableSource.getData();
            const wavelengths = sourceRows
                .map(row => parseFloat(row.wavelength))
                .filter(w => isFinite(w) && w > 0)
                .sort((a, b) => a - b); // 波長順にソート
            
            if (wavelengths.length > 0) {
                console.log(`  Source tableから${wavelengths.length}個の波長を取得: ${wavelengths.map(w => w.toFixed(4)).join(', ')} μm`);
                return wavelengths;
            }
        }
    } catch (error) {
        console.warn('波長リストの取得に失敗しました:', error);
    }
    
    // デフォルト波長（F, d, C線）
    console.log('  Source tableが空のため、デフォルト波長（F, d, C線）を使用');
    return [0.4861, 0.5876, 0.6563];
}

/**
 * 像面での光線の横収差を計算
 * @param {Object} tracedRay - 追跡済み光線データ
 * @param {number} imagePlaneZ - 像面のZ座標
 * @returns {Object} {x: 横収差X, y: 横収差Y} または null
 */
function calculateTransverseAberration(tracedRay, imagePlaneZ) {
    if (!tracedRay || !tracedRay.rayPath || tracedRay.rayPath.length < 2) {
        return null;
    }
    
    const path = tracedRay.rayPath;
    const lastPoint = path[path.length - 1];
    const secondLastPoint = path[path.length - 2];
    
    // 方向ベクトル
    const direction = {
        x: lastPoint.x - secondLastPoint.x,
        y: lastPoint.y - secondLastPoint.y,
        z: lastPoint.z - secondLastPoint.z
    };
    
    // 像面までのパラメータt
    const dz = direction.z;
    if (Math.abs(dz) < 1e-10) {
        return null; // 光軸に垂直な光線
    }
    
    const t = (imagePlaneZ - lastPoint.z) / dz;
    
    // 像面での交点座標
    const intersectionX = lastPoint.x + t * direction.x;
    const intersectionY = lastPoint.y + t * direction.y;
    
    return {
        x: intersectionX,
        y: intersectionY
    };
}

/**
 * 正弦条件違反量を計算
 * SC = (n' sinU')/(n sinU) - m
 * 
 * @param {Object} tracedRay - 追跡済み光線データ
 * @param {number} mParax - 近軸横倍率
 * @param {number} nObj - 物体空間の屈折率
 * @param {number} nImg - 像空間の屈折率
 * @returns {number} 正弦条件違反量 SC (null if calculation fails)
 */
function calculateSineConditionViolation(tracedRay, mParax, nObj = 1.0, nImg = 1.0) {
    if (!tracedRay || !tracedRay.rayPath || tracedRay.rayPath.length < 2) {
        return null;
    }
    
    const path = tracedRay.rayPath;
    
    // 物体側方向余弦（最初の2点から計算）
    const firstPoint = path[0];
    const secondPoint = path[1];
    const objDir = {
        x: secondPoint.x - firstPoint.x,
        y: secondPoint.y - firstPoint.y,
        z: secondPoint.z - firstPoint.z
    };
    const objLength = Math.sqrt(objDir.x ** 2 + objDir.y ** 2 + objDir.z ** 2);
    if (objLength < 1e-10) return null;
    
    // 単位方向余弦
    const L_obj = objDir.x / objLength;
    const M_obj = objDir.y / objLength;
    
    // 像側方向余弦（最後の2点から計算）
    const lastPoint = path[path.length - 1];
    const secondLastPoint = path[path.length - 2];
    const imgDir = {
        x: lastPoint.x - secondLastPoint.x,
        y: lastPoint.y - secondLastPoint.y,
        z: lastPoint.z - secondLastPoint.z
    };
    const imgLength = Math.sqrt(imgDir.x ** 2 + imgDir.y ** 2 + imgDir.z ** 2);
    if (imgLength < 1e-10) return null;
    
    // 単位方向余弦
    const L_img = imgDir.x / imgLength;
    const M_img = imgDir.y / imgLength;
    
    // sinU = sqrt(L^2 + M^2) (光軸からの傾き)
    const sinU = Math.hypot(L_obj, M_obj);
    const sinUp = Math.hypot(L_img, M_img);
    
    // 数値安定化：極小分母の保護
    if (sinU < 1e-10) {
        return null; // 軸上光線に近すぎる
    }
    
    // 正弦条件違反量: ΔS = (n' sinU')/(n sinU) - m
    const ratio = (nImg * sinUp) / (nObj * sinU);
    const SC = ratio - mParax;
    
    return SC;
}

/**
 * 絞り面を見つける
 */
function findStopSurface(opticalSystemRows) {
    const normalize = (v) => String(v ?? '').trim().toLowerCase();
    const compact = (v) => normalize(v).replace(/[\s_-]+/g, '');

    const isStopType = (v) => {
        const n = normalize(v);
        const c = compact(v);
        if (!n && !c) return false;
        return n === 'stop' || c === 'stop' || n.includes('stop');
    };

    // 1) explicit stop flag
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i] || {};
        if (surface.stop === 'Yes' || surface.Stop === 'Yes' || surface.stop === true || surface.Stop === true) {
            return i;
        }
    }

    // 2) object type / surfType contains Stop
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i] || {};
        const objTypeRaw = surface?.['object type'] ?? surface?.objectType ?? surface?.object ?? '';
        const surfTypeRaw = surface?.surfType ?? surface?.['surf type'] ?? surface?.type ?? '';
        if (isStopType(objTypeRaw) || isStopType(surfTypeRaw)) {
            return i;
        }
    }

    // fallback: middle surface (historical behavior)
    return Math.floor(opticalSystemRows.length / 2);
}

/**
 * 有限系・無限系の判定
 */
function isFiniteSystem(opticalSystemRows) {
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        return false;
    }
    const firstSurface = opticalSystemRows[0];
    const thickness = firstSurface.thickness || firstSurface.Thickness;
    if (thickness === 'INF' || thickness === Infinity) {
        return false;
    }
    const numThickness = parseFloat(thickness);
    return Number.isFinite(numThickness) && numThickness > 0;
}

/**
 * 光線と光軸の交点（焦点位置）を求める
 * @param {Object} ray - 光線データ
 * @param {number} approximateZ - 近似的な像面Z座標
 * @returns {number} 光軸上の交点Z座標（焦点位置）
 */
function findRayAxisIntersection(tracedRay, imagePlaneZ) {
    // tracedRay は {success, originalRay, rayPath, ...} の構造
    if (!tracedRay || !tracedRay.rayPath || tracedRay.rayPath.length < 2) {
        console.warn('⚠️ 光線パスが不正:', tracedRay);
        return null;
    }
    
    const path = tracedRay.rayPath;
    const lastPoint = path[path.length - 1];
    
    // 【改善版】複数点を使った重み付き最小二乗フィッティング
    // 像面に近い複数の点を使用することで、光軸付近の光線でも精度向上
    
    // 像面付近の有効な点を収集（最大5点、Z差が0.01mm以上）
    const fitPoints = [];
    for (let i = path.length - 1; i >= 0 && fitPoints.length < 5; i--) {
        if (fitPoints.length === 0) {
            fitPoints.push(path[i]);
        } else {
            const deltaZ = Math.abs(path[i].z - fitPoints[fitPoints.length - 1].z);
            if (deltaZ > 0.01) {  // 10μm以上の差がある点のみ追加
                fitPoints.push(path[i]);
            }
        }
    }
    
    // 最低2点必要
    if (fitPoints.length < 2) {
        // フォールバック: 最初と最後の点を使用
        fitPoints.length = 0;
        fitPoints.push(path[path.length - 1]);
        if (path.length >= 2) fitPoints.push(path[0]);
    }
    
    // デバッグ情報
    const rayId = tracedRay.originalRay ? 
        `${tracedRay.originalRay.wavelength}_${tracedRay.originalRay.py || tracedRay.originalRay.px || 0}` : 
        'unknown';
    
    if (!window._sphericalAberDebugCount) {
        window._sphericalAberDebugCount = 0;
    }
    
    const debugThis = window._sphericalAberDebugCount < 3;
    if (debugThis) {
        window._sphericalAberDebugCount++;
        console.log(`🔍 [DEBUG ${window._sphericalAberDebugCount}] Multi-point fitting (ray: ${rayId})`);
        console.log(`   Using ${fitPoints.length} points for fitting`);
        console.log(`   rayPath length: ${path.length}`);
    }
    
    // 光軸上にあるかチェック（全点が光軸から0.001mm以内）
    const allOnAxis = fitPoints.every(p => Math.sqrt(p.x * p.x + p.y * p.y) < 0.001);
    if (allOnAxis) {
        // 完全に光軸上の光線: 最終点のZ座標を返す
        if (debugThis) console.log('   → Ray is on optical axis, using last point Z');
        return lastPoint.z;
    }
    
    // 重み付き最小二乗法で光軸交点を求める
    // 各点について、光軸までの距離 r = sqrt(x^2 + y^2) をZ座標の関数として近似
    // 線形近似: r = a*z + b を最小二乗フィットし、r=0となるzを求める
    // より安定した計算のため、重み付き回帰を使用（最終点に大きな重み）
    
    let sumW = 0, sumWZ = 0, sumWR = 0, sumWZZ = 0, sumWZR = 0;
    
    for (let i = 0; i < fitPoints.length; i++) {
        const p = fitPoints[i];
        const r = Math.sqrt(p.x * p.x + p.y * p.y);
        const z = p.z;
        
        // 重み: 最終点ほど大きく（指数関数的に減衰）
        const weight = Math.exp(-i * 0.5);
        
        sumW += weight;
        sumWZ += weight * z;
        sumWR += weight * r;
        sumWZZ += weight * z * z;
        sumWZR += weight * z * r;
    }
    
    // 線形回帰の係数を計算: r = a*z + b
    const denominator = sumW * sumWZZ - sumWZ * sumWZ;
    
    if (Math.abs(denominator) < 1e-20) {
        // すべての点がほぼ同じZ座標（ありえないケース）
        if (debugThis) console.log('   → All points at same Z, using last point Z');
        return lastPoint.z;
    }
    
    const a = (sumW * sumWZR - sumWZ * sumWR) / denominator;
    const b = (sumWZZ * sumWR - sumWZ * sumWZR) / denominator;
    
    // r = 0 となるz座標を計算: 0 = a*z + b → z = -b/a
    if (Math.abs(a) < 1e-15) {
        // 光軸との交差がないか、光軸に平行（ほぼ軸上光線）
        // 光軸に最も近い点のZ座標を返す
        let minDist = Infinity;
        let bestZ = lastPoint.z;
        for (const p of fitPoints) {
            const dist = Math.sqrt(p.x * p.x + p.y * p.y);
            if (dist < minDist) {
                minDist = dist;
                bestZ = p.z;
            }
        }
        if (debugThis) console.log(`   → Nearly parallel to axis (a=${a.toExponential(3)}), using closest point Z=${bestZ.toFixed(6)}`);
        return bestZ;
    }
    
    const intersectionZ = -b / a;
    
    // 検証: フィット誤差を計算
    let maxResidual = 0;
    for (const p of fitPoints) {
        const r = Math.sqrt(p.x * p.x + p.y * p.y);
        const rFit = a * p.z + b;
        const residual = Math.abs(r - rFit);
        if (residual > maxResidual) maxResidual = residual;
    }
    
    if (debugThis) {
        console.log(`   Linear fit: r = ${a.toExponential(6)} * z + ${b.toExponential(6)}`);
        console.log(`   Intersection Z: ${intersectionZ.toFixed(6)} mm`);
        console.log(`   Max residual: ${maxResidual.toExponential(3)} mm`);
    }
    
    // 妥当性チェック1: 像面から極端に離れた位置は除外
    const maxDeviation = 1000; // mm
    if (Math.abs(intersectionZ - imagePlaneZ) > maxDeviation) {
        if (debugThis) console.warn(`⚠️ 焦点位置が像面から極端に離れています: ${intersectionZ.toFixed(3)} mm (像面: ${imagePlaneZ.toFixed(3)} mm)`);
        return null;
    }
    
    // 妥当性チェック2: フィット点の範囲外に大きく外挿していないかチェック
    const zMin = Math.min(...fitPoints.map(p => p.z));
    const zMax = Math.max(...fitPoints.map(p => p.z));
    const zRange = zMax - zMin;
    const extrapolation = Math.max(0, zMin - intersectionZ, intersectionZ - zMax);
    
    if (extrapolation > zRange * 2) {
        // 外挿が範囲の2倍を超える場合は信頼性が低い
        if (debugThis) console.warn(`⚠️ 過度な外挿: ${extrapolation.toFixed(3)} mm (範囲: ${zRange.toFixed(3)} mm)`);
        // それでも最良の推定値として返す
    }
    
    return intersectionZ;
}

/**
 * 縦収差データを計算する（球面収差図用）
 * 画角0°（軸上）の光線のみを使用し、各波長ごとに計算
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} targetSurfaceIndex - 評価面のインデックス
 * @param {Array} wavelengths - 波長リスト (μm)。nullの場合はSource tableから自動取得
 * @param {number} rayCount - 光線数
 * @returns {Object} 縦収差データ
 */
export function calculateLongitudinalAberration(
    opticalSystemRows, 
    targetSurfaceIndex, 
    wavelengths = null,
    rayCount = 51,
    options = null
) {
    const silent = !!(options && typeof options === 'object' && options.silent === true);
    const prevLog = console.log;
    if (silent) {
        console.log = () => {};
    }
    const debugSA = !silent && (
        (options && typeof options === 'object' && options.debugSA === true) ||
        (typeof globalThis !== 'undefined' && globalThis && globalThis.__COOPT_DEBUG_SA)
    );
    const dbg = (...args) => {
        if (debugSA) console.log(...args);
    };
    try {
    // 波長がnullまたは未指定の場合、Source tableから取得
    if (!wavelengths || wavelengths.length === 0) {
        wavelengths = getAllWavelengths();
    }
    // デバッグカウンタをリセット
    window._sphericalAberDebugCount = 0;
    
    console.log('📊 球面収差計算開始（軸上光線、各波長）');
    console.log(`📊 波長: ${wavelengths.map(w => w.toFixed(4)).join(', ')} μm`);
    
    const isFinite = isFiniteSystem(opticalSystemRows);
    console.log(`📊 光学系タイプ: ${isFinite ? '有限系' : '無限系'}`);
        dbg('🐞 [SA] debug enabled', {
            isFinite,
            targetSurfaceIndex,
            rayCount,
            wavelengths: Array.isArray(wavelengths) ? wavelengths.slice() : wavelengths
        });
    
    // 像面のZ座標を取得（近似値）
    let imagePlaneZ = 0;
    for (let i = 0; i <= targetSurfaceIndex; i++) {
        const surface = opticalSystemRows[i];
        const thickness = parseFloat(surface.thickness || surface.Thickness || 0);
        if (Number.isFinite(thickness)) {
            imagePlaneZ += thickness;
        }
    }
    
    console.log(`📊 像面Z座標（近似）: ${imagePlaneZ.toFixed(3)} mm`);
    
    // 主波長を取得
    const primaryWavelength = getPrimaryWavelength();
    console.log(`📊 主波長: ${primaryWavelength.toFixed(4)} μm`);
    
    // 主波長のBFL（近軸像点位置）を計算
    const lastSurfaceZ = imagePlaneZ; // 最終面のZ座標
    const primaryBFL = calculateBackFocalLength(opticalSystemRows, primaryWavelength);
    const primaryImageZ = lastSurfaceZ + primaryBFL;
    console.log(`📊 主波長の近軸像点位置: ${primaryImageZ.toFixed(6)} mm (BFL: ${primaryBFL.toFixed(6)} mm)`);
    
    // 物体空間と像空間の屈折率を取得
    const nObj = 1.0; // 通常は空気（物体空間）
    
    // 像空間の屈折率（最終面の後の媒質）
    let nImg = 1.0; // デフォルトは空気
    if (targetSurfaceIndex < opticalSystemRows.length - 1) {
        const lastSurface = opticalSystemRows[targetSurfaceIndex];
        const material = lastSurface.glass || lastSurface.Glass || '';
        if (material && material !== '' && material !== 'AIR') {
            // 主波長での屈折率を計算
            nImg = getRefractiveIndex(lastSurface, primaryWavelength);
            if (!nImg || nImg === 1.0) {
                // 取得に失敗した場合はデフォルトのガラス屈折率
                nImg = 1.5;
                console.warn(`⚠️ 屈折率の取得に失敗、デフォルト値 ${nImg} を使用`);
            }
        }
    }
    console.log(`📊 物体空間屈折率: ${nObj}, 像空間屈折率: ${nImg}`);
    
    // 近軸横倍率（軸上物点の場合、倍率は定義されない）
    // 無限系の場合: m = 0 として扱う
    // 有限系の場合: m = s'/s (像距離/物体距離) で計算すべきだが、軸上光線なので0
    const mParax = isFinite ? 0 : 0; // 軸上光線なので横倍率は0
    console.log(`📊 近軸横倍率: ${mParax} (軸上光線)`);
    
    // 各波長について縦収差を計算
    const meridionalData = [];
    const sagittalData = [];
    const wavelengthBFLs = {}; // 各波長のBFLを記録
    
    for (let wlIndex = 0; wlIndex < wavelengths.length; wlIndex++) {
        const wavelength = wavelengths[wlIndex];
        console.log(`\n📊 ========== 波長 ${wlIndex + 1}/${wavelengths.length}: ${wavelength.toFixed(4)} μm ==========`);
            dbg('🐞 [SA] wavelength start', { wlIndex, wavelength });
        
        // この波長のBFLを計算
        const currentBFL = calculateBackFocalLength(opticalSystemRows, wavelength);
        const currentImageZ = lastSurfaceZ + currentBFL;
        wavelengthBFLs[wavelength] = currentBFL;
        console.log(`  この波長の近軸像点位置: ${currentImageZ.toFixed(6)} mm (BFL: ${currentBFL.toFixed(6)} mm)`);
        
        // 軸上（画角0°）の十字光線を生成
        let crossBeamResult;
        if (isFinite) {
            console.log(`  有限系: 軸上物点 (xHeight=0, yHeight=0), 波長=${wavelength.toFixed(4)} μm`);
            crossBeamResult = generateFiniteSystemCrossBeam(
                opticalSystemRows,
                [{ xHeight: 0, yHeight: 0 }],  // 配列形式で渡す
                {
                    wavelength: wavelength,
                    rayCount: rayCount,
                    crossType: 'both',
                    debugMode: false,
                    targetSurfaceIndex: targetSurfaceIndex
                }
            );
        } else {
            console.log(`  無限系: 軸上角度 (x=0, y=0), 波長=${wavelength.toFixed(4)} μm`);
            // 無限系の場合、軸上（光軸に平行）
            const objectAngle = {
                x: 0,  // 軸上
                y: 0   // 軸上
            };
            
            crossBeamResult = generateInfiniteSystemCrossBeam(
                opticalSystemRows,
                objectAngle,
                {
                    wavelength: wavelength,
                    rayCount: rayCount,
                    crossType: 'both',
                    debugMode: false,
                    targetSurfaceIndex: targetSurfaceIndex
                }
            );
        }
        
        if (!crossBeamResult || !crossBeamResult.success) {
            console.warn(`⚠️ 波長 ${wavelength.toFixed(4)} μm: 光線生成失敗`);
            continue;
        }
        
        // 追跡済み光線データを取得（フォールバック用に保持）
        const tracedRays = crossBeamResult.allTracedRays || [];
        const successfulRays = tracedRays.filter(r => r.success && r.rayPath && r.rayPath.length > 1);
        
        console.log(`  追跡光線: ${tracedRays.length}本, 成功: ${successfulRays.length}本`);
        
        if (successfulRays.length === 0) {
            console.warn(`⚠️ 波長 ${wavelength.toFixed(4)} μm: 成功した光線がありません`);
                if (debugSA && typeof globalThis !== 'undefined' && globalThis.__cooptLastRayTraceFailure) {
                    const f = globalThis.__cooptLastRayTraceFailure;
                    dbg('🐞 [SA] last raytrace failure snapshot', { kind: f.kind, targetSurfaceIndex: f.targetSurfaceIndex, details: f.details });
                }
            continue;
        }
        
        // 全波長共通の基準: 主波長の近軸像点位置
        // 縦収差 = 実際の焦点位置 - 主波長の近軸像点位置
        const referenceImageZ = primaryImageZ; // 主波長のBFLで計算した近軸像点
        console.log(`  基準像点位置（主波長のBFL）: ${referenceImageZ.toFixed(6)} mm`);
        
        // 主光線の焦点位置を求める（瞳位置0のデータ用）
        const chiefRay = successfulRays.find(r => 
            r.originalRay && (r.originalRay.type === 'chief' || r.originalRay.role === 'chief')
        );
        let chiefFocusZ = currentImageZ; // デフォルトはこの波長の近軸像点
        
        if (chiefRay && chiefRay.rayPath) {
            const chiefIntersection = findRayAxisIntersection(chiefRay, imagePlaneZ);
            if (chiefIntersection !== null) {
                chiefFocusZ = chiefIntersection;
            }
        }
        
        // 絞り面のインデックスを取得
        const stopSurfaceIndex = findStopSurface(opticalSystemRows);
        const stopPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, stopSurfaceIndex);
        const stopSurface = opticalSystemRows[stopSurfaceIndex];
        const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
        const stopPlaneCenter3d = surfaceOrigins?.[stopSurfaceIndex]?.origin || null;
        const stopPlaneRotation = surfaceOrigins?.[stopSurfaceIndex]?.rotationMatrix || null;
        const stopPlaneU = normalizeVector3(
            applyRotationMatrixToVector(stopPlaneRotation, { x: 1, y: 0, z: 0 }),
            { x: 1, y: 0, z: 0 }
        );
        const stopPlaneV = normalizeVector3(
            applyRotationMatrixToVector(stopPlaneRotation, { x: 0, y: 1, z: 0 }),
            { x: 0, y: 1, z: 0 }
        );
        const stopRadius = parseFloat(
            stopSurface.semidia ??
            stopSurface.semiDiameter ??
            stopSurface['Semi-Diameter'] ??
            stopSurface.semidiameter ??
            stopSurface['semi-diameter'] ??
            10
        );
        const stopSolveMax = (Number.isFinite(stopRadius) && stopRadius > 0) ? stopRadius : 10;
        dbg('🐞 [SA] stop config', {
            stopSurfaceIndex,
            stopPointIndex,
            stopRadius,
            stopPlaneCenter3d,
            hasStopPlaneRotation: !!stopPlaneRotation
        });
        if (stopPointIndex === null) {
            console.warn('⚠️ [Longitudinal] Stop point index mapping failed');
            return null;
        }

        // rayCount で正規化瞳座標を分割（0.001を含める）し、その正規化瞳座標を「実際の絞り面高さ」に一致させるように光線を狙い撃ち
        const normalizedSamples = buildNormalizedPupilSamples(rayCount);

        const buildAimedRaysForDirection = (axis /* 'meridional'|'sagittal' */) => {
            const diag = debugSA ? {
                axis,
                mode: isFinite ? 'finite' : 'infinite',
                stopSolveAttempt: 0,
                stopSolveSolved: 0,
                stopSolveNull: 0,
                stopSolveTraceFail: 0,
                stopSolveTraceOk: 0,
                firstNull: null,
                firstTraceFail: null
            } : null;
            // +側の境界（最大）を定義
            if (isFinite) {
                const crossBeamRays = crossBeamResult.allCrossBeamRays || [];
                const chief = crossBeamRays.find(r => r.type === 'chief');
                const upper = crossBeamRays.find(r => r.type === 'upper_marginal');
                const right = crossBeamRays.find(r => r.type === 'right_marginal');
                const boundary = axis === 'meridional' ? upper : right;
                if (!chief || !boundary) {
                    // Fallback: do not depend on cross-beam metadata; directly solve rays to the stop plane.
                    const originFallback = surfaceOrigins?.[0]?.origin
                        ? { x: surfaceOrigins[0].origin.x, y: surfaceOrigins[0].origin.y, z: surfaceOrigins[0].origin.z }
                        : { x: 0, y: 0, z: 0 };
                    const axisVec = axis === 'meridional' ? stopPlaneV : stopPlaneU;
                    const canStopSolve = !!(stopPlaneCenter3d && Number.isInteger(stopSurfaceIndex) && axisVec);
                    if (!canStopSolve) return null;

                    const aimed = [];
                    if (diag) {
                        diag.mode = 'finite-fallback';
                    }

                    for (let idx = 0; idx < normalizedSamples.length; idx++) {
                        const pNorm = normalizedSamples[idx];
                        const targetStop = pNorm * stopSolveMax;
                        if (diag) diag.stopSolveAttempt++;
                        const stopTarget = {
                            x: stopPlaneCenter3d.x + axisVec.x * targetStop,
                            y: stopPlaneCenter3d.y + axisVec.y * targetStop,
                            z: stopPlaneCenter3d.z + axisVec.z * targetStop
                        };
                        const solvedDir = solveRayDirectionToStopPointFast(originFallback, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength);
                        if (!solvedDir) {
                            if (diag) {
                                diag.stopSolveNull++;
                                if (!diag.firstNull) diag.firstNull = { pNorm, targetStop, origin: originFallback, stopTarget };
                            }
                            continue;
                        }
                        if (diag) diag.stopSolveSolved++;
                        const trSolved = traceRayWrapped(
                            opticalSystemRows,
                            { pos: originFallback, dir: solvedDir, wavelength },
                            targetSurfaceIndex,
                            {
                                type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross',
                                role: axis,
                                wavelength,
                                pupilCoordinateRequested: pNorm,
                                aimParameter: 'stop-solve'
                            }
                        );
                        if (trSolved.success) {
                            if (diag) diag.stopSolveTraceOk++;
                            aimed.push(trSolved);
                        } else {
                            if (diag) {
                                diag.stopSolveTraceFail++;
                                if (!diag.firstTraceFail) diag.firstTraceFail = { pNorm, targetStop, origin: originFallback, stopTarget };
                            }
                        }
                    }

                    if (diag && diag.stopSolveAttempt > 0) {
                        dbg('🐞 [SA] stop-solve summary (finite-fallback)', diag);
                    }
                    return aimed.length > 0 ? aimed : null;
                }

                const origin = chief.position; // object point
                const axisVec = axis === 'meridional' ? stopPlaneV : stopPlaneU;
                const canStopSolve = !!(stopPlaneCenter3d && Number.isInteger(stopSurfaceIndex) && axisVec);

                const chiefDir = canStopSolve
                    ? (solveChiefRayDirectionToStopCenterFast(origin, stopPlaneCenter3d, stopSurfaceIndex, opticalSystemRows, wavelength) || chief.direction)
                    : chief.direction;

                const boundaryTarget = (canStopSolve && Number.isFinite(stopRadius))
                    ? {
                        x: stopPlaneCenter3d.x + axisVec.x * stopRadius,
                        y: stopPlaneCenter3d.y + axisVec.y * stopRadius,
                        z: stopPlaneCenter3d.z + axisVec.z * stopRadius
                    }
                    : null;
                const boundaryDir = (canStopSolve && boundaryTarget)
                    ? (solveRayDirectionToStopPointFast(origin, boundaryTarget, stopSurfaceIndex, opticalSystemRows, wavelength) || boundary.direction)
                    : boundary.direction;

                // 最大絞り面高さ（境界光線の stop 通過高さ）を実測
                const boundaryTr = traceRayWrapped(
                    opticalSystemRows,
                    { pos: origin, dir: boundaryDir, wavelength },
                    targetSurfaceIndex,
                    { type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross', role: 'boundary', wavelength }
                );
                if (!boundaryTr.success || !boundaryTr.rayPath || boundaryTr.rayPath.length <= stopPointIndex) return null;
                const bStop = boundaryTr.rayPath[stopPointIndex];
                const bStopLocal = getStopLocalOffsets(bStop, stopPlaneCenter3d, stopPlaneU, stopPlaneV);
                const maxStop = Math.abs(
                    axis === 'meridional'
                        ? (bStopLocal ? bStopLocal.v : bStop.y)
                        : (bStopLocal ? bStopLocal.u : bStop.x)
                );
                if (!(maxStop > 0)) return null;

                // 0 側（chief）の stop 高さ
                const chiefTr = traceRayWrapped(
                    opticalSystemRows,
                    { pos: origin, dir: chiefDir, wavelength },
                    targetSurfaceIndex,
                    { type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross', role: 'chief', wavelength }
                );

                const aimed = [];
                for (let idx = 0; idx < normalizedSamples.length; idx++) {
                    const pNorm = normalizedSamples[idx];
                    const targetStop = pNorm * maxStop;

                    // OPD/Spot-style: solve direction so the ray passes through the stop target.
                    if (canStopSolve && Number.isFinite(targetStop)) {
                        if (diag) diag.stopSolveAttempt++;
                        const stopTarget = {
                            x: stopPlaneCenter3d.x + axisVec.x * targetStop,
                            y: stopPlaneCenter3d.y + axisVec.y * targetStop,
                            z: stopPlaneCenter3d.z + axisVec.z * targetStop
                        };
                        const solvedDir = solveRayDirectionToStopPointFast(origin, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength);
                        if (!solvedDir) {
                            if (diag) {
                                diag.stopSolveNull++;
                                if (!diag.firstNull) diag.firstNull = { pNorm, targetStop, origin, stopTarget };
                            }
                        } else {
                            if (diag) diag.stopSolveSolved++;
                            const trSolved = traceRayWrapped(
                                opticalSystemRows,
                                { pos: origin, dir: solvedDir, wavelength },
                                targetSurfaceIndex,
                                {
                                    type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross',
                                    role: axis,
                                    wavelength,
                                    pupilCoordinateRequested: pNorm,
                                    aimParameter: 'stop-solve'
                                }
                            );
                            if (trSolved.success) {
                                if (diag) diag.stopSolveTraceOk++;
                                aimed.push(trSolved);
                            } else {
                                if (diag) {
                                    diag.stopSolveTraceFail++;
                                    if (!diag.firstTraceFail) diag.firstTraceFail = { pNorm, targetStop, origin, stopTarget };
                                }
                            }
                            continue;
                        }
                    }

                    const getStopAtT = (t) => {
                        // chief→boundary の方向を t で補間し、stop高さが targetStop になるようにtを解く
                        const dir = {
                            x: chiefDir.x + t * (boundaryDir.x - chiefDir.x),
                            y: chiefDir.y + t * (boundaryDir.y - chiefDir.y),
                            z: chiefDir.z + t * (boundaryDir.z - chiefDir.z)
                        };
                        const tr = traceRayWrapped(
                            opticalSystemRows,
                            { pos: origin, dir, wavelength },
                            targetSurfaceIndex,
                            { type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross', role: `aim_${pNorm}`, wavelength }
                        );
                        if (!tr.success || !tr.rayPath || tr.rayPath.length <= stopPointIndex) return NaN;
                        const s = tr.rayPath[stopPointIndex];
                        const local = getStopLocalOffsets(s, stopPlaneCenter3d, stopPlaneU, stopPlaneV);
                        return Math.abs(
                            axis === 'meridional'
                                ? (local ? local.v : s.y)
                                : (local ? local.u : s.x)
                        );
                    };

                    let tSolved;
                    if (pNorm <= 0) {
                        tSolved = 0;
                    } else if (pNorm >= 1) {
                        tSolved = 1;
                    } else {
                        // 目標許容誤差（stopのスケールに合わせる）
                        const tol = Math.max(1e-6, maxStop * 1e-6);
                        tSolved = bisectionSolve01(getStopAtT, targetStop, 40, tol);
                        if (tSolved === null) tSolved = pNorm; // 最後のフォールバック
                    }

                    const dirSolved = {
                        x: chiefDir.x + tSolved * (boundaryDir.x - chiefDir.x),
                        y: chiefDir.y + tSolved * (boundaryDir.y - chiefDir.y),
                        z: chiefDir.z + tSolved * (boundaryDir.z - chiefDir.z)
                    };
                    const trSolved = traceRayWrapped(
                        opticalSystemRows,
                        { pos: origin, dir: dirSolved, wavelength },
                        targetSurfaceIndex,
                        {
                            type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross',
                            role: axis,
                            wavelength,
                            pupilCoordinateRequested: pNorm,
                            aimParameter: tSolved
                        }
                    );
                    if (trSolved.success) aimed.push(trSolved);
                }

                // chiefTrace が成功していれば先頭に保持（0の参照用）
                if (chiefTr && chiefTr.success) {
                    // 既にpNorm=0で生成されている場合は重複しない
                    const hasZero = aimed.some(r => r.originalRay && r.originalRay.pupilCoordinateRequested === 0);
                    if (!hasZero) aimed.unshift(chiefTr);
                }

                if (diag && diag.stopSolveAttempt > 0) {
                    dbg('🐞 [SA] stop-solve summary (finite)', diag);
                }
                return aimed;
            } else {
                // Infinite system: prefer OPD/Spot-style stop solve (origin solve) even if cross-beam metadata is missing.
                const obj0 = (crossBeamResult.objectResults && crossBeamResult.objectResults[0]) || null;
                const axisVec = axis === 'meridional' ? stopPlaneV : stopPlaneU;
                const canStopSolve = !!(stopPlaneCenter3d && Number.isInteger(stopSurfaceIndex) && axisVec);
                const direction = (obj0 && obj0.direction)
                    ? { x: obj0.direction.i, y: obj0.direction.j, z: obj0.direction.k }
                    : { x: 0, y: 0, z: 1 };
                const baseZ = (obj0 && obj0.chiefRayOrigin && Number.isFinite(obj0.chiefRayOrigin.z))
                    ? Number(obj0.chiefRayOrigin.z)
                    : -25;
                const chiefOrigin = (obj0 && obj0.chiefRayOrigin)
                    ? obj0.chiefRayOrigin
                    : { x: 0, y: 0, z: baseZ };

                if (canStopSolve) {
                    if (diag) {
                        diag.mode = 'infinite-stop-solve';
                    }
                    const aimed = [];
                    for (let idx = 0; idx < normalizedSamples.length; idx++) {
                        const pNorm = normalizedSamples[idx];
                        const targetStop = pNorm * stopSolveMax;
                        if (diag) diag.stopSolveAttempt++;
                        const stopTarget = {
                            x: stopPlaneCenter3d.x + axisVec.x * targetStop,
                            y: stopPlaneCenter3d.y + axisVec.y * targetStop,
                            z: stopPlaneCenter3d.z + axisVec.z * targetStop
                        };
                        const guess = {
                            x: Number(chiefOrigin.x) + axisVec.x * targetStop,
                            y: Number(chiefOrigin.y) + axisVec.y * targetStop,
                            z: baseZ
                        };
                        const refined = solveRayOriginToStopPointFast(guess, direction, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength);
                        if (!refined) {
                            if (diag) {
                                diag.stopSolveNull++;
                                if (!diag.firstNull) diag.firstNull = { pNorm, targetStop, guess, stopTarget };
                            }
                        } else {
                            if (diag) diag.stopSolveSolved++;
                        }
                        const posSolved = refined || guess;
                        const trSolved = traceRayWrapped(
                            opticalSystemRows,
                            { pos: posSolved, dir: direction, wavelength },
                            targetSurfaceIndex,
                            {
                                type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross',
                                role: axis,
                                wavelength,
                                pupilCoordinateRequested: pNorm,
                                aimParameter: 'stop-solve'
                            }
                        );
                        if (trSolved.success) {
                            if (diag) diag.stopSolveTraceOk++;
                            aimed.push(trSolved);
                        } else {
                            if (diag) {
                                diag.stopSolveTraceFail++;
                                if (!diag.firstTraceFail) diag.firstTraceFail = { pNorm, targetStop, posSolved, stopTarget };
                            }
                        }
                    }
                    if (diag && diag.stopSolveAttempt > 0) {
                        dbg('🐞 [SA] stop-solve summary (infinite-stop-solve)', diag);
                    }
                    return aimed.length > 0 ? aimed : null;
                }

                // Fallback: origin interpolation between chief and boundary (requires cross-beam metadata).
                if (!obj0 || !obj0.chiefRayOrigin || !obj0.apertureBoundaryRays || !obj0.direction) return null;
                const boundaryRay = obj0.apertureBoundaryRays.find(r => r.direction === (axis === 'meridional' ? 'upper' : 'right'));
                if (!boundaryRay || !boundaryRay.origin) return null;

                const delta = {
                    x: boundaryRay.origin.x - chiefOrigin.x,
                    y: boundaryRay.origin.y - chiefOrigin.y,
                    z: boundaryRay.origin.z - chiefOrigin.z
                };
                const deltaLen = Math.hypot(delta.x, delta.y, delta.z);
                if (!(deltaLen > 0)) return null;
                const deltaUnit = { x: delta.x / deltaLen, y: delta.y / deltaLen, z: delta.z / deltaLen };

                // 境界での最大stop高さ（実測）
                const boundaryTr = traceRayWrapped(
                    opticalSystemRows,
                    { pos: boundaryRay.origin, dir: direction, wavelength },
                    targetSurfaceIndex,
                    { type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross', role: 'boundary', wavelength }
                );
                if (!boundaryTr.success || !boundaryTr.rayPath || boundaryTr.rayPath.length <= stopPointIndex) return null;
                const bStop = boundaryTr.rayPath[stopPointIndex];
                const bStopLocal = getStopLocalOffsets(bStop, stopPlaneCenter3d, stopPlaneU, stopPlaneV);
                const maxStop = Math.abs(
                    axis === 'meridional'
                        ? (bStopLocal ? bStopLocal.v : bStop.y)
                        : (bStopLocal ? bStopLocal.u : bStop.x)
                );
                if (!(maxStop > 0)) return null;

                const aimed = [];
                for (let idx = 0; idx < normalizedSamples.length; idx++) {
                    const pNorm = normalizedSamples[idx];
                    const targetStop = pNorm * maxStop;

                    // OPD/Spot-style: solve origin so the ray hits the stop target.
                    if (canStopSolve && Number.isFinite(targetStop)) {
                        if (diag) diag.stopSolveAttempt++;
                        const stopTarget = {
                            x: stopPlaneCenter3d.x + axisVec.x * targetStop,
                            y: stopPlaneCenter3d.y + axisVec.y * targetStop,
                            z: stopPlaneCenter3d.z + axisVec.z * targetStop
                        };
                        const guess = {
                            x: chiefOrigin.x + deltaUnit.x * (pNorm * deltaLen),
                            y: chiefOrigin.y + deltaUnit.y * (pNorm * deltaLen),
                            z: chiefOrigin.z + deltaUnit.z * (pNorm * deltaLen)
                        };
                        const refined = solveRayOriginToStopPointFast(guess, direction, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength);
                        if (diag) {
                            if (!refined) {
                                diag.stopSolveNull++;
                                if (!diag.firstNull) diag.firstNull = { pNorm, targetStop, guess, stopTarget };
                            } else {
                                diag.stopSolveSolved++;
                            }
                        }
                        const posSolved = refined || guess;
                        const trSolved = traceRayWrapped(
                            opticalSystemRows,
                            { pos: posSolved, dir: direction, wavelength },
                            targetSurfaceIndex,
                            {
                                type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross',
                                role: axis,
                                wavelength,
                                pupilCoordinateRequested: pNorm,
                                aimParameter: 'stop-solve'
                            }
                        );
                        if (trSolved.success) {
                            if (diag) diag.stopSolveTraceOk++;
                            aimed.push(trSolved);
                        } else {
                            if (diag) {
                                diag.stopSolveTraceFail++;
                                if (!diag.firstTraceFail) diag.firstTraceFail = { pNorm, targetStop, posSolved, stopTarget };
                            }
                        }
                        continue;
                    }

                    const getStopAtT = (t) => {
                        const pos = {
                            x: chiefOrigin.x + deltaUnit.x * (t * deltaLen),
                            y: chiefOrigin.y + deltaUnit.y * (t * deltaLen),
                            z: chiefOrigin.z + deltaUnit.z * (t * deltaLen)
                        };
                        const tr = traceRayWrapped(
                            opticalSystemRows,
                            { pos, dir: direction, wavelength },
                            targetSurfaceIndex,
                            { type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross', role: `aim_${pNorm}`, wavelength }
                        );
                        if (!tr.success || !tr.rayPath || tr.rayPath.length <= stopPointIndex) return NaN;
                        const s = tr.rayPath[stopPointIndex];
                        const local = getStopLocalOffsets(s, stopPlaneCenter3d, stopPlaneU, stopPlaneV);
                        return Math.abs(
                            axis === 'meridional'
                                ? (local ? local.v : s.y)
                                : (local ? local.u : s.x)
                        );
                    };

                    let tSolved;
                    if (pNorm <= 0) tSolved = 0;
                    else if (pNorm >= 1) tSolved = 1;
                    else {
                        const tol = Math.max(1e-6, maxStop * 1e-6);
                        tSolved = bisectionSolve01(getStopAtT, targetStop, 40, tol);
                        if (tSolved === null) tSolved = pNorm;
                    }

                    const posSolved = {
                        x: chiefOrigin.x + deltaUnit.x * (tSolved * deltaLen),
                        y: chiefOrigin.y + deltaUnit.y * (tSolved * deltaLen),
                        z: chiefOrigin.z + deltaUnit.z * (tSolved * deltaLen)
                    };
                    const trSolved = traceRayWrapped(
                        opticalSystemRows,
                        { pos: posSolved, dir: direction, wavelength },
                        targetSurfaceIndex,
                        {
                            type: axis === 'meridional' ? 'vertical_cross' : 'horizontal_cross',
                            role: axis,
                            wavelength,
                            pupilCoordinateRequested: pNorm,
                            aimParameter: tSolved
                        }
                    );
                    if (trSolved.success) aimed.push(trSolved);
                }
                if (diag && diag.stopSolveAttempt > 0) {
                    dbg('🐞 [SA] stop-solve summary (infinite)', diag);
                }
                return aimed;
            }
        };

        const aimedMeridionalRays = buildAimedRaysForDirection('meridional');
        const aimedSagittalRays = buildAimedRaysForDirection('sagittal');

        dbg('🐞 [SA] aimed rays counts', {
            wavelength,
            meridional: aimedMeridionalRays ? aimedMeridionalRays.length : null,
            sagittal: aimedSagittalRays ? aimedSagittalRays.length : null
        });

        // メリジオナル光線の縦収差を計算（垂直クロス光線）
        const meridionalRays = (aimedMeridionalRays && aimedMeridionalRays.length > 0)
            ? aimedMeridionalRays
            : successfulRays.filter(r => r.originalRay && r.originalRay.type === 'vertical_cross');
        
        // stopSurfaceIndex/stopRadius は上で算出済み
        
        // 像面での評価（主波長の近軸像点位置を使用）
        const evaluationPlaneZ = primaryImageZ;
        
        // まず全ての光線の絞り面での高さを収集
        const tempMeridionalPoints = [];
        for (let i = 0; i < meridionalRays.length; i++) {
            const tracedRay = meridionalRays[i];
            const focusZ = findRayAxisIntersection(tracedRay, imagePlaneZ);
            
            // 像面での横収差を計算
            const transverseAb = calculateTransverseAberration(tracedRay, evaluationPlaneZ);
            
            // 軸上光線のため、SC計算はスキップ（物理的に意味がない）
            // const sc = calculateSineConditionViolation(tracedRay, mParax, nObj, nImg);
            const sc = null;
            
            if (focusZ !== null && transverseAb !== null && tracedRay.rayPath && tracedRay.rayPath.length > stopPointIndex) {
                // 縦収差 = 最終面からの距離（実際の焦点位置 - 最終面Z座標）
                const longitudinalAberration = focusZ - lastSurfaceZ;
                const stopPoint = tracedRay.rayPath[stopPointIndex];
                const stopLocal = getStopLocalOffsets(stopPoint, stopPlaneCenter3d, stopPlaneU, stopPlaneV);
                const pupilHeight = Math.abs(stopLocal ? stopLocal.v : stopPoint.y); // 絶対値（物理単位: mm）
                
                // 瞳高さ0.01mm未満の光線を除外（規格化瞳座標の始まりを0.01mm付近に設定）
                if (pupilHeight < 0.01) {
                    continue;
                }
                
                // 横収差（メリジオナルなのでY方向）
                const transverseAberration = transverseAb.y;
                
                tempMeridionalPoints.push({
                    pupilHeight: pupilHeight,
                    longitudinalAberration: longitudinalAberration,
                    focusPosition: focusZ,
                    transverseAberration: transverseAberration,
                    sineConditionViolation: sc  // null も許容
                });
            }
        }
        
        // ストップ面での実際の最大高さで正規化（0から1の範囲）
        // 注意: クロスビーム生成は物体側垂直面上で行われるため、
        // ストップ面での実際の高さはstopRadiusと異なる場合がある
        const maxMeridionalHeight = Math.max(...tempMeridionalPoints.map(p => p.pupilHeight));
        
        // 規格化瞳座標0.001の人工光線追加は異常値を生むため削除（実測データのみプロット）
        
        // 正規化してデータポイントを作成（SCは既に計算済み）
        const meridionalPoints = tempMeridionalPoints.map(p => {
            const normalizedPupil = maxMeridionalHeight > 0 ? p.pupilHeight / maxMeridionalHeight : 0;
            
            return {
                pupilCoordinate: normalizedPupil,
                longitudinalAberration: p.longitudinalAberration,
                focusPosition: p.focusPosition,
                stopHeight: p.pupilHeight,
                transverseAberration: p.transverseAberration,
                sineConditionViolation: p.sineConditionViolation
            };
        });
        
        // デバッグ: 正規化情報を確認
        if (tempMeridionalPoints.length > 0) {
            const maxNormalizedCoord = Math.max(...meridionalPoints.map(p => p.pupilCoordinate));
            
            console.log(`  メリジオナル最大pupil height: ${maxMeridionalHeight.toFixed(6)} mm`);
            console.log(`  メリジオナル最大正規化座標: ${maxNormalizedCoord.toFixed(6)}`);
            console.log(`  ストップ半径: ${stopRadius.toFixed(6)} mm`);
            console.log(`  pupilHeight/stopRadius 比: ${(maxMeridionalHeight/stopRadius).toFixed(6)}`);
        }
        if (debugSA && tempMeridionalPoints.length === 0) {
            dbg('🐞 [SA] meridional: no usable points', { wavelength, stopPointIndex, stopSurfaceIndex });
            if (typeof globalThis !== 'undefined' && globalThis.__cooptLastRayTraceFailure) {
                const f = globalThis.__cooptLastRayTraceFailure;
                dbg('🐞 [SA] last raytrace failure snapshot', { kind: f.kind, targetSurfaceIndex: f.targetSurfaceIndex, details: f.details });
            }
        }
        
        meridionalPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        // 重複する瞳座標を処理（同じ瞳座標の光線がある場合は平均値を使用）
        const uniqueMeridionalPoints = [];
        const threshold = 1e-6; // より小さい閾値を使用
        let i = 0;
        
        while (i < meridionalPoints.length) {
            const currentPoint = meridionalPoints[i];
            const groupPoints = [currentPoint];
            
            // 同じ瞳座標のグループを収集
            let j = i + 1;
            while (j < meridionalPoints.length && 
                   Math.abs(meridionalPoints[j].pupilCoordinate - currentPoint.pupilCoordinate) <= threshold) {
                groupPoints.push(meridionalPoints[j]);
                j++;
            }
            
            // グループの平均値を計算
            if (groupPoints.length === 1) {
                uniqueMeridionalPoints.push(currentPoint);
            } else {
                const avgAberration = groupPoints.reduce((sum, p) => sum + p.longitudinalAberration, 0) / groupPoints.length;
                const avgFocusZ = groupPoints.reduce((sum, p) => sum + p.focusPosition, 0) / groupPoints.length;
                const avgTransverse = groupPoints.reduce((sum, p) => sum + p.transverseAberration, 0) / groupPoints.length;
                
                // SC の平均（null を除外）
                const validSC = groupPoints.filter(p => p.sineConditionViolation !== null);
                const avgSC = validSC.length > 0 
                    ? validSC.reduce((sum, p) => sum + p.sineConditionViolation, 0) / validSC.length 
                    : null;
                
                uniqueMeridionalPoints.push({
                    pupilCoordinate: currentPoint.pupilCoordinate,
                    longitudinalAberration: avgAberration,
                    focusPosition: avgFocusZ,
                    stopHeight: currentPoint.stopHeight,
                    transverseAberration: avgTransverse,
                    sineConditionViolation: avgSC
                });
            }
            
            i = j;
        }

        // 最小瞳高さ0.01mm以上でフィルタリング済みのため、補間点追加は不要
        // insertInterpolatedPoint(uniqueMeridionalPoints, 0.0001);
        
        meridionalData.push({
            wavelength: wavelength,
            rayType: 'meridional',
            points: uniqueMeridionalPoints,
            paraxialAberration: currentBFL - primaryBFL  // 近軸の縦収差（色収差成分）
        });
        
        // サジタル光線の縦収差を計算
        const sagittalRays = (aimedSagittalRays && aimedSagittalRays.length > 0)
            ? aimedSagittalRays
            : successfulRays.filter(r => r.originalRay && r.originalRay.type === 'horizontal_cross');
        
        // まず全ての光線の絞り面での高さを収集
        const tempSagittalPoints = [];
        for (let i = 0; i < sagittalRays.length; i++) {
            const tracedRay = sagittalRays[i];
            const focusZ = findRayAxisIntersection(tracedRay, imagePlaneZ);
            
            // 像面での横収差を計算
            const transverseAb = calculateTransverseAberration(tracedRay, evaluationPlaneZ);
            
            // 軸上光線のため、SC計算はスキップ（物理的に意味がない）
            // const sc = calculateSineConditionViolation(tracedRay, mParax, nObj, nImg);
            const sc = null;
            
            if (focusZ !== null && transverseAb !== null && tracedRay.rayPath && tracedRay.rayPath.length > stopPointIndex) {
                // 縦収差 = 最終面からの距離（実際の焦点位置 - 最終面Z座標）
                const longitudinalAberration = focusZ - lastSurfaceZ;
                const stopPoint = tracedRay.rayPath[stopPointIndex];
                const stopLocal = getStopLocalOffsets(stopPoint, stopPlaneCenter3d, stopPlaneU, stopPlaneV);
                const pupilHeight = Math.abs(stopLocal ? stopLocal.u : stopPoint.x); // 絶対値（物理単位: mm）
                
                // 瞳高さ0.01mm未満の光線を除外（規格化瞳座標の始まりを0.01mm付近に設定）
                if (pupilHeight < 0.01) {
                    continue;
                }
                
                // 横収差（サジタルなのでX方向）
                const transverseAberration = transverseAb.x;
                
                tempSagittalPoints.push({
                    pupilHeight: pupilHeight,
                    longitudinalAberration: longitudinalAberration,
                    focusPosition: focusZ,
                    transverseAberration: transverseAberration,
                    sineConditionViolation: sc  // null も許容
                });
            }
        }
        
        // ストップ面での実際の最大高さで正規化（0から1の範囲）
        const maxSagittalHeight = Math.max(...tempSagittalPoints.map(p => p.pupilHeight));
        
        // 正規化してデータポイントを作成（SCは既に計算済み）
        const sagittalPoints = tempSagittalPoints.map(p => {
            const normalizedPupil = maxSagittalHeight > 0 ? p.pupilHeight / maxSagittalHeight : 0;
            
            return {
                pupilCoordinate: normalizedPupil,
                longitudinalAberration: p.longitudinalAberration,
                focusPosition: p.focusPosition,
                stopHeight: p.pupilHeight,
                transverseAberration: p.transverseAberration,
                sineConditionViolation: p.sineConditionViolation
            };
        });
        
        // デバッグ: 正規化情報を確認
        if (tempSagittalPoints.length > 0) {
            const maxNormalizedCoord = Math.max(...sagittalPoints.map(p => p.pupilCoordinate));
            console.log(`  サジタル最大pupil height: ${maxSagittalHeight.toFixed(6)} mm`);
            console.log(`  サジタル最大正規化座標: ${maxNormalizedCoord.toFixed(6)}`);
            console.log(`  ストップ半径: ${stopRadius.toFixed(6)} mm`);
            console.log(`  pupilHeight/stopRadius 比: ${(maxSagittalHeight/stopRadius).toFixed(6)}`);
        }
        if (debugSA && tempSagittalPoints.length === 0) {
            dbg('🐞 [SA] sagittal: no usable points', { wavelength, stopPointIndex, stopSurfaceIndex });
            if (typeof globalThis !== 'undefined' && globalThis.__cooptLastRayTraceFailure) {
                const f = globalThis.__cooptLastRayTraceFailure;
                dbg('🐞 [SA] last raytrace failure snapshot', { kind: f.kind, targetSurfaceIndex: f.targetSurfaceIndex, details: f.details });
            }
        }
        
        sagittalPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        // 重複する瞳座標を処理（同じ瞳座標の光線がある場合は平均値を使用）
        const uniqueSagittalPoints = [];
        let k = 0;
        
        while (k < sagittalPoints.length) {
            const currentPoint = sagittalPoints[k];
            const groupPoints = [currentPoint];
            
            // 同じ瞳座標のグループを収集
            let m = k + 1;
            while (m < sagittalPoints.length && 
                   Math.abs(sagittalPoints[m].pupilCoordinate - currentPoint.pupilCoordinate) <= threshold) {
                groupPoints.push(sagittalPoints[m]);
                m++;
            }
            
            // グループの平均値を計算
            if (groupPoints.length === 1) {
                uniqueSagittalPoints.push(currentPoint);
            } else {
                const avgAberration = groupPoints.reduce((sum, p) => sum + p.longitudinalAberration, 0) / groupPoints.length;
                const avgFocusZ = groupPoints.reduce((sum, p) => sum + p.focusPosition, 0) / groupPoints.length;
                const avgTransverse = groupPoints.reduce((sum, p) => sum + p.transverseAberration, 0) / groupPoints.length;
                
                // SC の平均（null を除外）
                const validSC = groupPoints.filter(p => p.sineConditionViolation !== null);
                const avgSC = validSC.length > 0 
                    ? validSC.reduce((sum, p) => sum + p.sineConditionViolation, 0) / validSC.length 
                    : null;
                
                uniqueSagittalPoints.push({
                    pupilCoordinate: currentPoint.pupilCoordinate,
                    longitudinalAberration: avgAberration,
                    focusPosition: avgFocusZ,
                    stopHeight: currentPoint.stopHeight,
                    transverseAberration: avgTransverse,
                    sineConditionViolation: avgSC
                });
            }
            
            k = m;
        }

        // 最小瞳高さ0.01mm以上でフィルタリング済みのため、補間点追加は不要
        // insertInterpolatedPoint(uniqueSagittalPoints, 0.0001);
        
        sagittalData.push({
            wavelength: wavelength,
            rayType: 'sagittal',
            points: uniqueSagittalPoints,
            paraxialAberration: currentBFL - primaryBFL  // 近軸の縦収差（色収差成分）
        });
    }
    
    const result = {
        wavelengths: wavelengths,
        targetSurface: targetSurfaceIndex,
        isFiniteSystem: isFinite,
        meridionalData: meridionalData,
        sagittalData: sagittalData,
        metadata: {
            rayCount: rayCount,
            imagePlaneZ: imagePlaneZ,
            calculationType: 'spherical-aberration'
        }
    };
    
    console.log('✅ 球面収差計算完了');
    return result;
    } finally {
        if (silent) {
            console.log = prevLog;
        }
    }
}

// Async wrapper for UI progress bars: runs per-wavelength chunks and yields to the event loop.
// Keeps the original synchronous API intact (used by merit-function evaluation).
export async function calculateLongitudinalAberrationAsync(
    opticalSystemRows,
    targetSurfaceIndex,
    wavelengths = null,
    rayCount = 51,
    options = null
) {
    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    const yieldToUI = async () => new Promise(resolve => setTimeout(resolve, 0));
    const safeProgress = (percent, message) => {
        try { onProgress?.({ percent, message }); } catch (_) {}
    };

    // Match sync behavior: if wavelengths is null/empty, pull from Source table.
    const wlList = (!wavelengths || wavelengths.length === 0) ? getAllWavelengths() : wavelengths;
    const wlCount = Array.isArray(wlList) ? wlList.length : 0;

    safeProgress(0, 'Starting spherical aberration...');
    await yieldToUI();

    const meridionalData = [];
    const sagittalData = [];
    let lastMeta = null;

    for (let i = 0; i < wlCount; i++) {
        const wl = wlList[i];
        const base = 5;
        const span = 85;
        const pct = base + (span * (i / Math.max(1, wlCount)));
        safeProgress(Math.min(95, Math.max(0, pct)), `Calculating wavelength ${i + 1}/${wlCount}...`);

        // Compute this wavelength using the existing synchronous implementation.
        // Run it with the same rayCount/targetSurfaceIndex, and stitch results.
        const partial = calculateLongitudinalAberration(
            opticalSystemRows,
            targetSurfaceIndex,
            [wl],
            rayCount,
            options
        );

        if (partial && typeof partial === 'object') {
            if (Array.isArray(partial.meridionalData)) meridionalData.push(...partial.meridionalData);
            if (Array.isArray(partial.sagittalData)) sagittalData.push(...partial.sagittalData);
            lastMeta = partial;
        }

        // Yield between wavelengths so progress UI can repaint.
        await yieldToUI();
    }

    safeProgress(95, 'Finalizing...');
    await yieldToUI();

    // Preserve the sync function's output shape as closely as possible.
    const out = (lastMeta && typeof lastMeta === 'object') ? { ...lastMeta } : {};
    out.wavelengths = wlList;
    out.targetSurface = targetSurfaceIndex;
    out.meridionalData = meridionalData;
    out.sagittalData = sagittalData;

    safeProgress(100, 'Done');
    return out;
}
