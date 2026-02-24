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

import { generateFiniteSystemCrossBeam } from '../../raytracing/generation/gen-ray-cross-finite.ts';
import { generateInfiniteSystemCrossBeam } from '../../raytracing/generation/gen-ray-cross-infinite.ts';
import { traceRay, traceRayHitPoint, calculateSurfaceOrigins } from '../../raytracing/core/ray-tracing.ts';
import { getObjectRows } from '../../utils/data-utils.ts';
import { calculateBackFocalLength, getRefractiveIndex } from '../../raytracing/core/ray-paraxial.ts';
import { setWindowDebugBagValue } from '../../utils/window-debug-bag.ts';

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
    if (dz0 > -1e-9 && dz0 < 1e-9) return null;

    const buildDirFromSlopes = (u, v) => {
        const zSign = dz0 >= 0 ? 1 : -1;
        return normalizeVector3({ x: u, y: v, z: zSign }, { x: 0, y: 0, z: zSign });
    };

    const initial = normalizeVector3({ x: dx0, y: dy0, z: dz0 }, { x: 0, y: 0, z: 1 });
    let u = ((initial.z > 1e-9) || (initial.z < -1e-9)) ? (initial.x / initial.z) : 0;
    let v = ((initial.z > 1e-9) || (initial.z < -1e-9)) ? (initial.y / initial.z) : 0;

    const maxIter = 15;
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
        if (!Number.isFinite(det) || (det > -1e-12 && det < 1e-12)) {
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
    const maxIter = 20;

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
        if (!Number.isFinite(det) || (det > -1e-12 && det < 1e-12)) return null;

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
    const exists = points.some(p => {
        const diff = p.pupilCoordinate - targetNormalized;
        return diff >= -1e-5 && diff <= 1e-5;
    });
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

function interpolateAberrationPoint(lower, upper, targetPupilCoordinate) {
    const lowP = Number(lower?.pupilCoordinate);
    const upP = Number(upper?.pupilCoordinate);
    if (!Number.isFinite(lowP) || !Number.isFinite(upP) || ((upP - lowP) > -1e-12 && (upP - lowP) < 1e-12)) {
        return {
            ...lower,
            pupilCoordinate: targetPupilCoordinate
        };
    }
    const ratio = (targetPupilCoordinate - lowP) / (upP - lowP);
    const lerp = (a, b) => a + (b - a) * ratio;
    const lerpNullable = (a, b) => (Number.isFinite(a) && Number.isFinite(b)) ? lerp(a, b) : null;
    return {
        pupilCoordinate: targetPupilCoordinate,
        longitudinalAberration: lerp(lower.longitudinalAberration, upper.longitudinalAberration),
        focusPosition: lerp(lower.focusPosition, upper.focusPosition),
        stopHeight: lerp(lower.stopHeight, upper.stopHeight),
        transverseAberration: lerp(lower.transverseAberration, upper.transverseAberration),
        sineConditionViolation: lerpNullable(lower.sineConditionViolation, upper.sineConditionViolation)
    };
}

function findDistinctNeighborPair(sortedPoints, fromStart = true) {
    if (!Array.isArray(sortedPoints) || sortedPoints.length < 2) return null;
    if (fromStart) {
        const first = sortedPoints[0];
        for (let i = 1; i < sortedPoints.length; i++) {
            const candidate = sortedPoints[i];
            if ((candidate.pupilCoordinate - first.pupilCoordinate) > 1e-12 || (candidate.pupilCoordinate - first.pupilCoordinate) < -1e-12) {
                return [first, candidate];
            }
        }
    } else {
        const last = sortedPoints[sortedPoints.length - 1];
        for (let i = sortedPoints.length - 2; i >= 0; i--) {
            const candidate = sortedPoints[i];
            if ((last.pupilCoordinate - candidate.pupilCoordinate) > 1e-12 || (last.pupilCoordinate - candidate.pupilCoordinate) < -1e-12) {
                return [candidate, last];
            }
        }
    }
    return null;
}

function resamplePointsToRequestedPupilCoordinates(points, requestedSamples) {
    if (!Array.isArray(requestedSamples) || requestedSamples.length === 0) return Array.isArray(points) ? points : [];
    const targets = requestedSamples
        .filter(v => Number.isFinite(v))
        .map(v => Math.max(0, Math.min(1, Number(v))));
    if (targets.length === 0) return Array.isArray(points) ? points : [];

    const sorted = (Array.isArray(points) ? points : [])
        .filter(p => Number.isFinite(p?.pupilCoordinate) && Number.isFinite(p?.longitudinalAberration))
        .sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);

    if (sorted.length === 0) return [];
    if (sorted.length === 1) {
        const base = sorted[0];
        return targets.map(t => ({ ...base, pupilCoordinate: t }));
    }

    const leftPair = findDistinctNeighborPair(sorted, true);
    const rightPair = findDistinctNeighborPair(sorted, false);

    // 外挿限界: データ範囲の20%まで、またはデータカバレッジが50%未満の場合は外挿しない
    const dataMin = sorted[0].pupilCoordinate;
    const dataMax = sorted[sorted.length - 1].pupilCoordinate;
    const dataRange = dataMax - dataMin;
    const coverageRatio = dataMax; // 0〜1の範囲でのカバレッジ
    const extrapolationMargin = coverageRatio < 0.5 ? 0 : dataRange * 0.2;
    const extrapolationMax = dataMax + extrapolationMargin;
    const extrapolationMin = Math.max(0, dataMin - extrapolationMargin);
    
    if (coverageRatio < 0.8) {
        console.warn(`⚠️ [SA resample] データカバレッジ不足: ${(coverageRatio * 100).toFixed(1)}% (最大瞳座標=${dataMax.toFixed(4)}, ${sorted.length}点). 外挿限界=${extrapolationMax.toFixed(4)}`);
    }

    const out = [];
    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        
        // 外挿限界を超える場合はスキップ
        if (target > extrapolationMax || target < extrapolationMin) {
            continue;
        }
        
        if (target <= sorted[0].pupilCoordinate) {
            if (leftPair) {
                out.push(interpolateAberrationPoint(leftPair[0], leftPair[1], target));
            } else {
                out.push({ ...sorted[0], pupilCoordinate: target });
            }
            continue;
        }
        if (target >= sorted[sorted.length - 1].pupilCoordinate) {
            if (rightPair) {
                out.push(interpolateAberrationPoint(rightPair[0], rightPair[1], target));
            } else {
                out.push({ ...sorted[sorted.length - 1], pupilCoordinate: target });
            }
            continue;
        }

        let lower = sorted[0];
        let upper = sorted[sorted.length - 1];
        for (let j = 1; j < sorted.length; j++) {
            if (sorted[j].pupilCoordinate >= target) {
                upper = sorted[j];
                lower = sorted[j - 1];
                break;
            }
        }
        out.push(interpolateAberrationPoint(lower, upper, target));
    }

    return out;
}

function buildNormalizedPupilSamples(rayCount) {
    const n = Math.max(2, Math.floor(rayCount));
    const minPupil = 0.001;
    const samples = [];
    for (let i = 0; i < n; i++) {
        const t = (n > 1) ? (i / (n - 1)) : 0;
        samples.push(minPupil + t * (1 - minPupil));
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
// NOTE: Object rows, Coord Break rows, and Gap rows do not create intersection points in rayPath.
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
        const isCoordTrans =
            nObj === 'coord break' || nObj === 'coordinate break' || nObj === 'cb' ||
            compact(nObj) === 'coordtrans' || compact(nObj) === 'coordinatebreak' ||
            nSurf === 'coord break' || nSurf === 'coordinate break' || nSurf === 'cb' ||
            compact(nSurf) === 'coordtrans' || compact(nSurf) === 'coordinatebreak';
        const blockTypeRaw = r?._blockType ?? r?.blockType ?? '';
        const kindRaw = r?.kind ?? '';
        const nBlock = String(blockTypeRaw ?? '').trim().toLowerCase();
        const nKind = String(kindRaw ?? '').trim().toLowerCase();
        const isGap =
            nObj === 'gap' || nObj === 'air gap' || compact(nObj) === 'gap' || compact(nObj) === 'airgap' ||
            nSurf === 'gap' || nSurf === 'air gap' || compact(nSurf) === 'gap' || compact(nSurf) === 'airgap' ||
            nBlock === 'gap' || nBlock === 'air gap' || compact(nBlock) === 'gap' || compact(nBlock) === 'airgap' ||
            nKind === 'gap' || nKind === 'air gap' || compact(nKind) === 'gap' || compact(nKind) === 'airgap';

        if (isObject || isCoordTrans || isGap) continue;
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
        if (err >= -tol && err <= tol) return mid;
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
                return wavelength;
            }
        }
    } catch (error) {
        console.warn('主波長の取得に失敗しました:', error);
    }
    
    // デフォルト波長（d線）
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
function calculateTransverseAberration(tracedRay, imagePlaneZ, imageSurfaceInfo = null) {
    if (!tracedRay || !tracedRay.rayPath || tracedRay.rayPath.length < 2) {
        return null;
    }
    
    const path = tracedRay.rayPath;
    const toLocal = (point) => {
        if (!imageSurfaceInfo || !imageSurfaceInfo.origin || !imageSurfaceInfo.rotationMatrix) return point;
        const dx = point.x - imageSurfaceInfo.origin.x;
        const dy = point.y - imageSurfaceInfo.origin.y;
        const dz = point.z - imageSurfaceInfo.origin.z;
        const R = imageSurfaceInfo.rotationMatrix;
        return {
            x: R[0][0] * dx + R[1][0] * dy + R[2][0] * dz,
            y: R[0][1] * dx + R[1][1] * dy + R[2][1] * dz,
            z: R[0][2] * dx + R[1][2] * dy + R[2][2] * dz
        };
    };
    const toGlobal = (point) => {
        if (!imageSurfaceInfo || !imageSurfaceInfo.origin || !imageSurfaceInfo.rotationMatrix) return point;
        const R = imageSurfaceInfo.rotationMatrix;
        return {
            x: R[0][0] * point.x + R[0][1] * point.y + R[0][2] * point.z + imageSurfaceInfo.origin.x,
            y: R[1][0] * point.x + R[1][1] * point.y + R[1][2] * point.z + imageSurfaceInfo.origin.y,
            z: R[2][0] * point.x + R[2][1] * point.y + R[2][2] * point.z + imageSurfaceInfo.origin.z
        };
    };
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
    if (dz > -1e-10 && dz < 1e-10) {
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
 * @param {Object|null} imageSurfaceInfo - 像面の座標変換情報 {origin, rotationMatrix}
 * @returns {number} 光軸上の交点Z座標（焦点位置）
 */
function findRayAxisIntersection(tracedRay, lastSurfaceZ) {
    if (!tracedRay || !tracedRay.rayPath || tracedRay.rayPath.length < 2) {
        console.warn('⚠️ 光線パスが不正:', tracedRay);
        return null;
    }

    const path = tracedRay.rayPath;

    // 常に像空間の最終セグメント（射出光線方向）を使用する。
    // 以前の「収束チェック」ロジックでは、周辺光線が焦点を通過して発散している場合に
    // レンズ内部のセグメントを誤選択してしまい、屈折後の射出方向ではなく
    // ガラス内部の方向で交点を計算するバグがあった。
    let lastPoint = path[path.length - 1];
    let secondLastPoint = null;
    let usedIdx = path.length - 1;
    let usedPrevIdx = -1;

    const minZ = 1e-4;
    for (let i = path.length - 2; i >= 0; i--) {
        const deltaZ = path[i].z - lastPoint.z;
        if (deltaZ > minZ || deltaZ < -minZ) {
            secondLastPoint = path[i];
            usedPrevIdx = i;
            break;
        }
    }

    if (!secondLastPoint) {
        console.warn('⚠️ 有効な前の点が見つかりません（光線パスが短すぎる可能性）');
        return null;
    }

    // direction: secondLastPoint → lastPoint（像空間での射出光線方向）
    const dx = lastPoint.x - secondLastPoint.x;
    const dy = lastPoint.y - secondLastPoint.y;
    const dz = lastPoint.z - secondLastPoint.z;

    // 光軸（x=0, y=0）への最近接点の t パラメータを求める
    // P(t) = lastPoint + t * dir  の |P.x² + P.y²| を最小化
    // ただし dir = (dx, dy, dz) 方向
    const denom = dx * dx + dy * dy;
    if (denom > -1e-12 && denom < 1e-12) return null;

    const numerator = -(lastPoint.x * dx + lastPoint.y * dy);
    const t = numerator / denom;
    const zIntersection = lastPoint.z + t * dz;

    return zIntersection - lastSurfaceZ;
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
    const isMirrorRow = (row) => {
        if (!row) return false;
        if (row.material === 'MIRROR') return true;
        if (row.type === 'Mirror') return true;
        if (row._blockType === 'Mirror') return true;
        const surfType = String(row.surfType ?? row.type ?? row.surfaceType ?? '').trim().toLowerCase();
        return surfType === 'mirror';
    };
    const mirrorCount = Array.isArray(opticalSystemRows)
        ? opticalSystemRows.filter(isMirrorRow).length
        : 0;
    const mirrorSign = (mirrorCount % 2 === 1) ? -1 : 1;

    const silent = !!(options && typeof options === 'object' && options.silent === true);
    const console = (silent
        ? ({ ...globalThis.console, log: () => {} } as Console)
        : globalThis.console);
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
    setWindowDebugBagValue('longitudinalAberration', 'sphericalAberDebugCount', 0);
    
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

    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    const lastSurfaceOriginZ = surfaceOrigins?.[targetSurfaceIndex]?.origin?.z;
    const lastSurfaceZ = Number.isFinite(lastSurfaceOriginZ) ? lastSurfaceOriginZ : imagePlaneZ;
    
    // 主波長を取得
    const primaryWavelength = getPrimaryWavelength();
    
    const resolveBflScalar = (value) => {
        if (Number.isFinite(value)) return value;
        if (value && Number.isFinite(value.average)) return value.average;
        if (value && Number.isFinite(value.tangential)) return value.tangential;
        return null;
    };

    // 主波長のBFL（近軸像点位置）を計算
    // 最終面のZ座標（CoordTransを考慮）
    const primaryBFLRaw = calculateBackFocalLength(opticalSystemRows, primaryWavelength);
    const primaryBFL = resolveBflScalar(primaryBFLRaw);
    const primaryImageZ = Number.isFinite(primaryBFL) ? (lastSurfaceZ + primaryBFL) : lastSurfaceZ;
    if (!Number.isFinite(primaryBFL)) {
        console.warn('⚠️ 主波長BFLが不正のため、像点位置は最終面基準で処理します');
    }
    
    // 物体空間と像空間の屈折率を取得
    const nObj = 1.0; // 通常は空気（物体空間）
    
    // 像空間の屈折率（最終面の後の媒質）
    let nImg = 1.0; // デフォルトは空気
    if (targetSurfaceIndex < opticalSystemRows.length - 1) {
        const lastSurface = opticalSystemRows[targetSurfaceIndex];
        if (lastSurface) {
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
    const stageCounts = [];
    const dedupePupilCoordinate = false;
    
    for (let wlIndex = 0; wlIndex < wavelengths.length; wlIndex++) {
        const wavelength = wavelengths[wlIndex];
        const requestedSampleCount = buildNormalizedPupilSamples(rayCount).length;
        const stageCount = {
            wavelength,
            requestedRayCount: rayCount,
            requestedSampleCount,
            tracedRayCount: 0,
            successfulTraceCount: 0,
            meridional: {
                aimedRayCount: 0,
                fallbackRayCount: 0,
                selectedRayCount: 0,
                preFilterPointCount: 0,
                postFilterPointCount: 0,
                postDedupePointCount: 0,
                plottedPointCount: 0
            },
            sagittal: {
                aimedRayCount: 0,
                fallbackRayCount: 0,
                selectedRayCount: 0,
                preFilterPointCount: 0,
                postFilterPointCount: 0,
                postDedupePointCount: 0,
                plottedPointCount: 0
            },
            status: 'ok'
        };
        console.log(`\n📊 ========== 波長 ${wlIndex + 1}/${wavelengths.length}: ${wavelength.toFixed(4)} μm ==========`);
            dbg('🐞 [SA] wavelength start', { wlIndex, wavelength });
        
        // この波長のBFLを計算
        const currentBFLRaw = calculateBackFocalLength(opticalSystemRows, wavelength);
        const currentBFL = resolveBflScalar(currentBFLRaw);
        const currentImageZ = Number.isFinite(currentBFL) ? (lastSurfaceZ + currentBFL) : lastSurfaceZ;
        wavelengthBFLs[wavelength] = currentBFL;
        if (Number.isFinite(currentBFL)) {
            console.log(`  この波長の近軸像点位置: ${currentImageZ.toFixed(6)} mm (BFL: ${currentBFL.toFixed(6)} mm)`);
        } else {
            console.warn(`⚠️ 波長 ${wavelength.toFixed(4)} μm: BFLが不正のため最終面基準で処理します`);
        }
        
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
            stageCount.status = 'cross-beam-failed';
            stageCounts.push(stageCount);
            continue;
        }
        
        // 追跡済み光線データを取得（フォールバック用に保持）
        const tracedRays = crossBeamResult.allTracedRays || [];
        const successfulRays = tracedRays.filter(r => r.success && r.rayPath && r.rayPath.length > 1);
        stageCount.tracedRayCount = tracedRays.length;
        stageCount.successfulTraceCount = successfulRays.length;
        
        console.log(`  追跡光線: ${tracedRays.length}本, 成功: ${successfulRays.length}本`);
        
        if (successfulRays.length === 0) {
            console.warn(`⚠️ 波長 ${wavelength.toFixed(4)} μm: 成功した光線がありません`);
            stageCount.status = 'no-successful-rays';
            stageCounts.push(stageCount);
                if (debugSA && typeof globalThis !== 'undefined' && globalThis.__cooptLastRayTraceFailure) {
                    const f = globalThis.__cooptLastRayTraceFailure;
                    dbg('🐞 [SA] last raytrace failure snapshot', { kind: f.kind, targetSurfaceIndex: f.targetSurfaceIndex, details: f.details });
                }
            continue;
        }
        
        // SA図の基準は「同一波長の近軸像点」を使用
        // 縦収差 = 実際の焦点位置 - 同一波長の近軸像点位置
        const referenceImageZ = currentImageZ;
        let referenceFocusOffset = Number.isFinite(currentBFL) ? currentBFL : 0;
        if (Number.isFinite(currentBFL)) {
            console.log(`  基準像点位置（同一波長のBFL）: ${referenceImageZ.toFixed(6)} mm`);
        }
        
        // 主光線の焦点位置を求める（瞳位置0のデータ用）
        const chiefRay = successfulRays.find(r => 
            r.originalRay && (r.originalRay.type === 'chief' || r.originalRay.role === 'chief')
        );
        let chiefFocusZ = null;
        
        // 絞り面のインデックスを取得
        const stopSurfaceIndex = findStopSurface(opticalSystemRows);
        const stopPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, stopSurfaceIndex);
        const stopSurface = opticalSystemRows[stopSurfaceIndex];
        if (chiefRay && chiefRay.rayPath) {
            const chiefIntersection = findRayAxisIntersection(chiefRay, lastSurfaceZ);
            if (chiefIntersection !== null) {
                chiefFocusZ = chiefIntersection;
            }
        }
        if (Number.isFinite(chiefFocusZ)) {
            referenceFocusOffset = chiefFocusZ;
            console.log(`  基準像点位置（chief ray）: ${chiefFocusZ.toFixed(6)} mm`);
        }
        
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
            const diag = {
                axis,
                mode: isFinite ? 'finite' : 'infinite',
                stopSolveAttempt: 0,
                stopSolveSolved: 0,
                stopSolveNull: 0,
                stopSolveTraceFail: 0,
                stopSolveTraceOk: 0,
                firstNull: null,
                firstTraceFail: null
            };
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
                    diag.mode = 'finite-fallback';

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
                        console.log('🐞 [SA] stop-solve summary (finite-fallback)', diag);
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
                const maxStop = axis === 'meridional'
                    ? (bStopLocal ? bStopLocal.v : bStop.y)
                    : (bStopLocal ? bStopLocal.u : bStop.x);
                if (!(Number.isFinite(maxStop) && maxStop !== 0)) return null;

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
                        return axis === 'meridional'
                            ? (local ? local.v : s.y)
                            : (local ? local.u : s.x);
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

                // NOTE:
                // Normalized pupil = 0 は計算/描画しない方針のため、chiefTrace の追加は行わない。

                if (diag && diag.stopSolveAttempt > 0) {
                    console.log('🐞 [SA] stop-solve summary (finite)', diag);
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
                        console.log('🐞 [SA] stop-solve summary (infinite-stop-solve)', diag);
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
                const maxStop = axis === 'meridional'
                    ? (bStopLocal ? bStopLocal.v : bStop.y)
                    : (bStopLocal ? bStopLocal.u : bStop.x);
                if (!(Number.isFinite(maxStop) && maxStop !== 0)) return null;

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
                        return axis === 'meridional'
                            ? (local ? local.v : s.y)
                            : (local ? local.u : s.x);
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
                    console.log('🐞 [SA] stop-solve summary (infinite)', diag);
                }
                return aimed;
            }
        };

        const aimedMeridionalRays = buildAimedRaysForDirection('meridional');
        const aimedSagittalRays = buildAimedRaysForDirection('sagittal');
        stageCount.meridional.aimedRayCount = aimedMeridionalRays ? aimedMeridionalRays.length : 0;
        stageCount.sagittal.aimedRayCount = aimedSagittalRays ? aimedSagittalRays.length : 0;

        dbg('🐞 [SA] aimed rays counts', {
            wavelength,
            meridional: aimedMeridionalRays ? aimedMeridionalRays.length : null,
            sagittal: aimedSagittalRays ? aimedSagittalRays.length : null
        });

        // メリジオナル光線の縦収差を計算（垂直クロス光線）
        // Aimed rays と cross-beam rays を統合してフルアパーチャのカバレッジを確保する。
        // stop-solve が高瞳座標で失敗した場合でも、cross-beam rays がデータを補完する。
        const crossBeamMeridional = successfulRays.filter(r => r.originalRay && r.originalRay.type === 'vertical_cross');
        const meridionalRays = (aimedMeridionalRays && aimedMeridionalRays.length > 0)
            ? [...aimedMeridionalRays, ...crossBeamMeridional]
            : crossBeamMeridional;
        const meridionalUsingFallback = !(aimedMeridionalRays && aimedMeridionalRays.length > 0);
        stageCount.meridional.fallbackRayCount = meridionalUsingFallback ? meridionalRays.length : 0;
        stageCount.meridional.selectedRayCount = meridionalRays.length;

        const selectReferenceRay = (rays) => {
            if (!Array.isArray(rays) || rays.length === 0) return null;
            let best = null;
            let bestScore = Infinity;
            for (let i = 0; i < rays.length; i++) {
                const ray = rays[i];
                const p = Number(ray?.originalRay?.pupilCoordinateRequested);
                const score = Number.isFinite(p) ? (p * p) : Infinity;
                if (score < bestScore) {
                    bestScore = score;
                    best = ray;
                }
            }
            return best;
        };

        const referenceRay = selectReferenceRay(meridionalRays) || selectReferenceRay(successfulRays);
        if (referenceRay) {
            const refFocus = findRayAxisIntersection(referenceRay, lastSurfaceZ);
            if (Number.isFinite(refFocus)) {
                referenceFocusOffset = refFocus;
                console.log(`  基準像点位置（reference ray）: ${refFocus.toFixed(6)} mm`);
            }
        }
        
        // stopSurfaceIndex/stopRadius は上で算出済み
        
        // 像面での評価（同一波長の近軸像点位置を使用）
        const evaluationPlaneZ = referenceImageZ;
        
        // まず全ての光線の絞り面での高さを収集
        const tempMeridionalPoints = [];
        for (let i = 0; i < meridionalRays.length; i++) {
            const tracedRay = meridionalRays[i];
            const focusResult = findRayAxisIntersection(tracedRay, lastSurfaceZ);
            
            // 像面での横収差を計算
            const transverseAb = calculateTransverseAberration(tracedRay, evaluationPlaneZ);
            
            // 軸上光線のため、SC計算はスキップ（物理的に意味がない）
            // const sc = calculateSineConditionViolation(tracedRay, mParax, nObj, nImg);
            const sc = null;
            
            if (focusResult !== null && transverseAb !== null && tracedRay.rayPath && tracedRay.rayPath.length > stopPointIndex) {
                // 縦収差 = ローカルZ方向の距離（像面中心を基準, local Z=0）
                // Mirrorが奇数枚の場合は符号反転
                const longitudinalAberration = mirrorSign * (focusResult - referenceFocusOffset);
                const focusPosition = mirrorSign * focusResult;
                const stopPoint = tracedRay.rayPath[stopPointIndex];
                const stopLocal = getStopLocalOffsets(stopPoint, stopPlaneCenter3d, stopPlaneU, stopPlaneV);
                const pupilHeight = stopLocal ? stopLocal.v : stopPoint.y;
                
                // 横収差（メリジオナルなのでY方向）
                const transverseAberration = transverseAb.y;
                
                tempMeridionalPoints.push({
                    requestedPupilCoordinate: tracedRay?.originalRay?.pupilCoordinateRequested,
                    pupilHeight: pupilHeight,
                    rawFocusResult: focusResult,
                    referenceFocusOffset: referenceFocusOffset,
                    longitudinalAberration: longitudinalAberration,
                    focusPosition: focusPosition,
                    transverseAberration: transverseAberration,
                    sineConditionViolation: sc  // null も許容
                });
            }
        }
        stageCount.meridional.preFilterPointCount = tempMeridionalPoints.length;

        try {
            console.log('🐞 [SA_RAY] meridional temp', tempMeridionalPoints.map(p => ({ requested: p.requestedPupilCoordinate, pupilHeight: p.pupilHeight, rawFocusResult: p.rawFocusResult, referenceFocusOffset: p.referenceFocusOffset, longitudinalAberration: p.longitudinalAberration })));
        } catch (e) { console.warn('🐞 [SA] meridional dump failed', e); }
        
        // 瞳座標は「要求した正規化瞳座標」を優先して使用（波長ごとの実測最大値で再正規化しない）
        const meridionalPoints = tempMeridionalPoints
            .map(p => {
                const requested = Number(p.requestedPupilCoordinate);
                const fallbackNormalized = (Number.isFinite(stopRadius) && stopRadius > 0)
                    ? (p.pupilHeight / stopRadius)
                    : 0;
                const normalizedPupil = Number.isFinite(requested)
                    ? requested
                    : fallbackNormalized;
                
                return {
                    pupilCoordinate: Math.max(0, Math.min(1, normalizedPupil)),
                    longitudinalAberration: p.longitudinalAberration,
                    focusPosition: p.focusPosition,
                    stopHeight: p.pupilHeight,
                    transverseAberration: p.transverseAberration,
                    sineConditionViolation: p.sineConditionViolation
                };
            });
        stageCount.meridional.postFilterPointCount = meridionalPoints.length;
        
        if (tempMeridionalPoints.length > 0) {
            const maxNormalizedCoord = Math.max(...meridionalPoints.map(p => p.pupilCoordinate));
            console.log(`  メリジオナル最大正規化座標: ${maxNormalizedCoord.toFixed(6)}`);
        }
        if (debugSA && tempMeridionalPoints.length === 0) {
            dbg('🐞 [SA] meridional: no usable points', { wavelength, stopPointIndex, stopSurfaceIndex });
            if (typeof globalThis !== 'undefined' && globalThis.__cooptLastRayTraceFailure) {
                const f = globalThis.__cooptLastRayTraceFailure;
                dbg('🐞 [SA] last raytrace failure snapshot', { kind: f.kind, targetSurfaceIndex: f.targetSurfaceIndex, details: f.details });
            }
        }
        
        meridionalPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        // SA表示では点数減少要因を減らすため、瞳座標の重複統合は既定で無効化
        const uniqueMeridionalPoints = dedupePupilCoordinate
            ? (() => {
                const uniquePoints = [];
                const threshold = 1e-6;
                let i = 0;
                while (i < meridionalPoints.length) {
                    const currentPoint = meridionalPoints[i];
                    const groupPoints = [currentPoint];
                    let j = i + 1;
                    while (j < meridionalPoints.length) {
                        const diff = meridionalPoints[j].pupilCoordinate - currentPoint.pupilCoordinate;
                        if (diff < -threshold || diff > threshold) break;
                        groupPoints.push(meridionalPoints[j]);
                        j++;
                    }
                    if (groupPoints.length === 1) {
                        uniquePoints.push(currentPoint);
                    } else {
                        const avgAberration = groupPoints.reduce((sum, p) => sum + p.longitudinalAberration, 0) / groupPoints.length;
                        const avgFocusZ = groupPoints.reduce((sum, p) => sum + p.focusPosition, 0) / groupPoints.length;
                        const avgTransverse = groupPoints.reduce((sum, p) => sum + p.transverseAberration, 0) / groupPoints.length;
                        const validSC = groupPoints.filter(p => p.sineConditionViolation !== null);
                        const avgSC = validSC.length > 0
                            ? validSC.reduce((sum, p) => sum + p.sineConditionViolation, 0) / validSC.length
                            : null;
                        uniquePoints.push({
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
                return uniquePoints;
            })()
            : meridionalPoints.slice();
        stageCount.meridional.postDedupePointCount = uniqueMeridionalPoints.length;

        const plottedMeridionalPoints = resamplePointsToRequestedPupilCoordinates(uniqueMeridionalPoints, normalizedSamples);
        stageCount.meridional.plottedPointCount = plottedMeridionalPoints.length;
        
        meridionalData.push({
            wavelength: wavelength,
            rayType: 'meridional',
            points: plottedMeridionalPoints,
            paraxialAberration: (Number.isFinite(currentBFL) && Number.isFinite(primaryBFL))
                ? (currentBFL - primaryBFL)
                : null
        });
        
        // サジタル光線の縦収差を計算
        // Aimed rays と cross-beam rays を統合してフルアパーチャのカバレッジを確保する。
        const crossBeamSagittal = successfulRays.filter(r => r.originalRay && r.originalRay.type === 'horizontal_cross');
        const sagittalRays = (aimedSagittalRays && aimedSagittalRays.length > 0)
            ? [...aimedSagittalRays, ...crossBeamSagittal]
            : crossBeamSagittal;
        const sagittalUsingFallback = !(aimedSagittalRays && aimedSagittalRays.length > 0);
        stageCount.sagittal.fallbackRayCount = sagittalUsingFallback ? sagittalRays.length : 0;
        stageCount.sagittal.selectedRayCount = sagittalRays.length;
        
        // まず全ての光線の絞り面での高さを収集
        const tempSagittalPoints = [];
        for (let i = 0; i < sagittalRays.length; i++) {
            const tracedRay = sagittalRays[i];
            const focusResult = findRayAxisIntersection(tracedRay, lastSurfaceZ);
            
            // 像面での横収差を計算
            const transverseAb = calculateTransverseAberration(tracedRay, evaluationPlaneZ);
            
            // 軸上光線のため、SC計算はスキップ（物理的に意味がない）
            // const sc = calculateSineConditionViolation(tracedRay, mParax, nObj, nImg);
            const sc = null;
            
            if (focusResult !== null && transverseAb !== null && tracedRay.rayPath && tracedRay.rayPath.length > stopPointIndex) {
                // 縦収差 = ローカルZ方向の距離（像面中心を基準, local Z=0）
                // Mirrorが奇数枚の場合は符号反転
                const longitudinalAberration = mirrorSign * (focusResult - referenceFocusOffset);
                const stopPoint = tracedRay.rayPath[stopPointIndex];
                const stopLocal = getStopLocalOffsets(stopPoint, stopPlaneCenter3d, stopPlaneU, stopPlaneV);
                const pupilHeight = stopLocal ? stopLocal.u : stopPoint.x;
                
                // 横収差（サジタルなのでX方向）
                const transverseAberration = transverseAb.x;
                
                tempSagittalPoints.push({
                    requestedPupilCoordinate: tracedRay?.originalRay?.pupilCoordinateRequested,
                    pupilHeight: pupilHeight,
                    rawFocusResult: focusResult,
                    referenceFocusOffset: referenceFocusOffset,
                    longitudinalAberration: longitudinalAberration,
                    focusPosition: mirrorSign * focusResult,
                    transverseAberration: transverseAberration,
                    sineConditionViolation: sc  // null も許容
                });
            }
        }
        stageCount.sagittal.preFilterPointCount = tempSagittalPoints.length;

        try {
            console.log('🐞 [SA_RAY] sagittal temp', tempSagittalPoints.map(p => ({ requested: p.requestedPupilCoordinate, pupilHeight: p.pupilHeight, rawFocusResult: p.rawFocusResult, referenceFocusOffset: p.referenceFocusOffset, longitudinalAberration: p.longitudinalAberration })));
        } catch (e) { console.warn('🐞 [SA] sagittal dump failed', e); }
        
        // 瞳座標は「要求した正規化瞳座標」を優先して使用（波長ごとの実測最大値で再正規化しない）
        const sagittalPoints = tempSagittalPoints
            .map(p => {
                const requested = Number(p.requestedPupilCoordinate);
                const fallbackNormalized = (Number.isFinite(stopRadius) && stopRadius > 0)
                    ? (p.pupilHeight / stopRadius)
                    : 0;
                const normalizedPupil = Number.isFinite(requested)
                    ? requested
                    : fallbackNormalized;
                
                return {
                    pupilCoordinate: Math.max(0, Math.min(1, normalizedPupil)),
                    longitudinalAberration: p.longitudinalAberration,
                    focusPosition: p.focusPosition,
                    stopHeight: p.pupilHeight,
                    transverseAberration: p.transverseAberration,
                    sineConditionViolation: p.sineConditionViolation
                };
            });
        stageCount.sagittal.postFilterPointCount = sagittalPoints.length;
        
        if (tempSagittalPoints.length > 0) {
            const maxNormalizedCoord = Math.max(...sagittalPoints.map(p => p.pupilCoordinate));
            console.log(`  サジタル最大正規化座標: ${maxNormalizedCoord.toFixed(6)}`);
        }
        if (debugSA && tempSagittalPoints.length === 0) {
            dbg('🐞 [SA] sagittal: no usable points', { wavelength, stopPointIndex, stopSurfaceIndex });
            if (typeof globalThis !== 'undefined' && globalThis.__cooptLastRayTraceFailure) {
                const f = globalThis.__cooptLastRayTraceFailure;
                dbg('🐞 [SA] last raytrace failure snapshot', { kind: f.kind, targetSurfaceIndex: f.targetSurfaceIndex, details: f.details });
            }
        }
        
        sagittalPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        const uniqueSagittalPoints = dedupePupilCoordinate
            ? (() => {
                const uniquePoints = [];
                const threshold = 1e-6;
                let k = 0;
                while (k < sagittalPoints.length) {
                    const currentPoint = sagittalPoints[k];
                    const groupPoints = [currentPoint];
                    let m = k + 1;
                    while (m < sagittalPoints.length) {
                        const diff = sagittalPoints[m].pupilCoordinate - currentPoint.pupilCoordinate;
                        if (diff < -threshold || diff > threshold) break;
                        groupPoints.push(sagittalPoints[m]);
                        m++;
                    }
                    if (groupPoints.length === 1) {
                        uniquePoints.push(currentPoint);
                    } else {
                        const avgAberration = groupPoints.reduce((sum, p) => sum + p.longitudinalAberration, 0) / groupPoints.length;
                        const avgFocusZ = groupPoints.reduce((sum, p) => sum + p.focusPosition, 0) / groupPoints.length;
                        const avgTransverse = groupPoints.reduce((sum, p) => sum + p.transverseAberration, 0) / groupPoints.length;
                        const validSC = groupPoints.filter(p => p.sineConditionViolation !== null);
                        const avgSC = validSC.length > 0
                            ? validSC.reduce((sum, p) => sum + p.sineConditionViolation, 0) / validSC.length
                            : null;
                        uniquePoints.push({
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
                return uniquePoints;
            })()
            : sagittalPoints.slice();
        stageCount.sagittal.postDedupePointCount = uniqueSagittalPoints.length;

        const plottedSagittalPoints = resamplePointsToRequestedPupilCoordinates(uniqueSagittalPoints, normalizedSamples);
        stageCount.sagittal.plottedPointCount = plottedSagittalPoints.length;
        
        sagittalData.push({
            wavelength: wavelength,
            rayType: 'sagittal',
            points: plottedSagittalPoints,
            paraxialAberration: currentBFL - primaryBFL  // 近軸の縦収差（色収差成分）
        });

        stageCounts.push(stageCount);
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
            calculationType: 'spherical-aberration',
            dedupePupilCoordinate,
            wavelengthBFLs,
            stageCounts
        }
    };
    
    console.log('✅ 球面収差計算完了');
    return result;
    } finally {
        // No global console mutation; nothing to restore.
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
    const stageCounts = [];
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
            if (partial.metadata && Array.isArray(partial.metadata.stageCounts)) {
                stageCounts.push(...partial.metadata.stageCounts);
            }
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
    out.metadata = {
        ...(out.metadata || {}),
        rayCount,
        calculationType: 'spherical-aberration',
        dedupePupilCoordinate: false,
        stageCounts
    };

    safeProgress(100, 'Done');
    return out;
}
