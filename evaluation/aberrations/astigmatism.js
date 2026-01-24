/**
 * Astigmatism Diagram Calculator (Refactored with Draw Cross Rays)
 * 非点収差図計算システム - Draw Cross光線を直接使用する簡潔な実装
 * 
 * 定義:
 * - 像高または画角を縦軸に取り、主光線近傍の微小光束による横線（子午断面光束による結像で
 *   Meridional像面と呼び、Mと表記）及び縦線（球欠断面光束による結像でSagittal像面と呼び
 *   Sと表記）の結像点の、近軸像点からの差分量を横軸にプロットしたものをつないだ曲線
 * 
 * 計算方法（実光線追跡による数値計算）:
 * 1. 各画角で主光線と十字光線（Draw Cross）を追跡
 * 2. Draw Crossの上下左右マージナル光線を直接使用
 * 3. 各z位置で横収差RMSを評価
 * 4. RMSが最小となるz位置を最良焦点位置として採用
 * 5. パラキシャル像面からの差分をプロット
 * 
 * 機能:
 * - メリディオナル（Meridional, M）像面位置の計算 - YZ面（上下マージナル光線）
 * - サジタル（Sagittal, S）像面位置の計算 - XZ面（左右マージナル光線）
 * - RMSベースの最良焦点探索
 * - 画角に対する非点収差の評価
 * - 無限系対応
 * 
 * 作成日: 2025/01/XX
 * 更新日: 2025/11/14 - Draw Cross光線を直接使用する簡潔な実装に変更
 */

import { calculateChiefRayNewton } from './transverse-aberration.js';
import { getObjectRows, getSourceRows } from '../../utils/data-utils.js';
import { traceRay, traceRayHitPoint, calculateSurfaceOrigins } from '../../raytracing/core/ray-tracing.js';

function __pickPrimaryWavelengthMicrons(sourceRows, fallback = 0.5876) {
    try {
        if (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function') {
            const w = Number(window.getPrimaryWavelength());
            if (Number.isFinite(w) && w > 0) return w;
        }
    } catch (_) {
        // ignore
    }

    if (Array.isArray(sourceRows)) {
        const primaryRow = sourceRows.find(r => {
            const p = String(r?.primary ?? r?.Primary ?? r?.['Primary Wavelength'] ?? '').trim();
            return p === 'Primary Wavelength' || p.toLowerCase() === 'primary';
        });
        const wl = Number(primaryRow?.wavelength ?? primaryRow?.Wavelength);
        if (Number.isFinite(wl) && wl > 0) return wl;
    }
    return fallback;
}

function isCoordTransRow(row) {
    const st = String(row?.surfType ?? row?.['surf type'] ?? row?.surface_type ?? '').toLowerCase();
    return st === 'coord break' || st === 'coordinate break' || st === 'ct';
}

function isObjectRow(row) {
    const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? row?.surface_type ?? '').toLowerCase();
    return t === 'object';
}

// traceRay の rayPath は Object 行 / Coord Break 行を交点として記録しない。
// surfaceIndex(テーブル行) -> rayPath の point index への変換を行う。
function surfaceIndexToRayPathPointIndex(opticalSystemRows, surfaceIndex) {
    if (!Array.isArray(opticalSystemRows) || surfaceIndex === null || surfaceIndex === undefined) return null;
    const sIdx = Math.max(0, Math.min(surfaceIndex, opticalSystemRows.length - 1));
    let count = 0;
    for (let i = 0; i <= sIdx; i++) {
        const row = opticalSystemRows[i];
        if (isCoordTransRow(row)) continue;
        if (isObjectRow(row)) continue;
        count++;
    }
    return count > 0 ? count : null;
}

function normalize3(v) {
    const mag = Math.hypot(v?.x ?? 0, v?.y ?? 0, v?.z ?? 0);
    if (!Number.isFinite(mag) || mag <= 0) return null;
    return { x: v.x / mag, y: v.y / mag, z: v.z / mag };
}

function traceRayPathWrapped(opticalSystemRows, ray0, targetSurfaceIndex) {
    try {
        const rayPath = traceRay(opticalSystemRows, ray0, 1.0, null, targetSurfaceIndex);
        return { success: Array.isArray(rayPath) && rayPath.length > 1, rayPath };
    } catch (error) {
        return { success: false, rayPath: null, error };
    }
}

function solveRayDirectionToStopPointFast(origin, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength) {
    const baseDir = normalize3({
        x: stopTarget.x - origin.x,
        y: stopTarget.y - origin.y,
        z: stopTarget.z - origin.z
    });
    if (!baseDir) return null;

    const eps = 1e-4;
    let dir = { ...baseDir };

    for (let iter = 0; iter < 18; iter++) {
        const p = traceRayHitPoint(
            opticalSystemRows,
            { pos: origin, dir, wavelength },
            1.0,
            null,
            stopSurfaceIndex,
            stopTarget
        );
        if (!p) return null;
        const err = {
            x: stopTarget.x - p.x,
            y: stopTarget.y - p.y,
            z: stopTarget.z - p.z
        };
        const errNorm = Math.hypot(err.x, err.y, err.z);
        if (!Number.isFinite(errNorm)) return null;
        if (errNorm < 1e-6) return dir;

        const px = traceRayHitPoint(
            opticalSystemRows,
            { pos: origin, dir: normalize3({ x: dir.x + eps, y: dir.y, z: dir.z }) || dir, wavelength },
            1.0,
            null,
            stopSurfaceIndex,
            stopTarget
        );
        const py = traceRayHitPoint(
            opticalSystemRows,
            { pos: origin, dir: normalize3({ x: dir.x, y: dir.y + eps, z: dir.z }) || dir, wavelength },
            1.0,
            null,
            stopSurfaceIndex,
            stopTarget
        );
        if (!px || !py) return null;

        const dx = {
            x: (px.x - p.x) / eps,
            y: (px.y - p.y) / eps,
            z: (px.z - p.z) / eps
        };
        const dy = {
            x: (py.x - p.x) / eps,
            y: (py.y - p.y) / eps,
            z: (py.z - p.z) / eps
        };

        const a11 = dx.x;
        const a12 = dy.x;
        const a21 = dx.y;
        const a22 = dy.y;
        const b1 = err.x;
        const b2 = err.y;
        const det = a11 * a22 - a12 * a21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
            dir = normalize3({ x: dir.x + err.x * 0.02, y: dir.y + err.y * 0.02, z: dir.z }) || dir;
            continue;
        }
        const inv11 = a22 / det;
        const inv12 = -a12 / det;
        const inv21 = -a21 / det;
        const inv22 = a11 / det;
        const stepX = inv11 * b1 + inv12 * b2;
        const stepY = inv21 * b1 + inv22 * b2;

        const stepScale = (errNorm > 1e-2) ? 0.5 : 0.9;
        dir = normalize3({ x: dir.x + stepX * stepScale, y: dir.y + stepY * stepScale, z: dir.z }) || dir;
    }
    return null;
}

function solveRayOriginToStopPointFast(originGuess, direction, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength) {
    const dir = normalize3(direction);
    if (!dir) return null;
    let origin = { ...originGuess };
    const eps = 1e-4;

    for (let iter = 0; iter < 18; iter++) {
        const p = traceRayHitPoint(
            opticalSystemRows,
            { pos: origin, dir, wavelength },
            1.0,
            null,
            stopSurfaceIndex,
            stopTarget
        );
        if (!p) return null;
        const err = { x: stopTarget.x - p.x, y: stopTarget.y - p.y, z: stopTarget.z - p.z };
        const errNorm = Math.hypot(err.x, err.y, err.z);
        if (!Number.isFinite(errNorm)) return null;
        if (errNorm < 1e-6) return origin;

        const px = traceRayHitPoint(
            opticalSystemRows,
            { pos: { x: origin.x + eps, y: origin.y, z: origin.z }, dir, wavelength },
            1.0,
            null,
            stopSurfaceIndex,
            stopTarget
        );
        const py = traceRayHitPoint(
            opticalSystemRows,
            { pos: { x: origin.x, y: origin.y + eps, z: origin.z }, dir, wavelength },
            1.0,
            null,
            stopSurfaceIndex,
            stopTarget
        );
        if (!px || !py) return null;

        const dx = { x: (px.x - p.x) / eps, y: (px.y - p.y) / eps };
        const dy = { x: (py.x - p.x) / eps, y: (py.y - p.y) / eps };

        const a11 = dx.x;
        const a12 = dy.x;
        const a21 = dx.y;
        const a22 = dy.y;
        const b1 = err.x;
        const b2 = err.y;
        const det = a11 * a22 - a12 * a21;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
            origin = { x: origin.x + err.x * 0.05, y: origin.y + err.y * 0.05, z: origin.z };
            continue;
        }

        const inv11 = a22 / det;
        const inv12 = -a12 / det;
        const inv21 = -a21 / det;
        const inv22 = a11 / det;
        const stepX = inv11 * b1 + inv12 * b2;
        const stepY = inv21 * b1 + inv22 * b2;

        const stepScale = (errNorm > 1e-2) ? 0.5 : 0.9;
        origin = { x: origin.x + stepX * stepScale, y: origin.y + stepY * stepScale, z: origin.z };
    }
    return null;
}

function computeStopPlaneFrame(opticalSystemRows, stopSurfaceIndex) {
    const stopRow = opticalSystemRows?.[stopSurfaceIndex] || {};
    const stopRadius = parseFloat(
        stopRow.semidia ??
        stopRow.semiDiameter ??
        stopRow['Semi-Diameter'] ??
        stopRow.semidiameter ??
        stopRow['semi-diameter'] ??
        stopRow.aperture ??
        stopRow.Aperture ??
        10
    );
    const stopSolveMax = (Number.isFinite(stopRadius) && stopRadius > 0) ? stopRadius : 10;

    let stopPlaneCenter3d = null;
    let stopPlaneU = { x: 1, y: 0, z: 0 };
    let stopPlaneV = { x: 0, y: 1, z: 0 };

    try {
        const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows, 1.0);
        const stopOrigin = surfaceOrigins?.[stopSurfaceIndex] || null;
        if (stopOrigin?.origin) {
            stopPlaneCenter3d = { x: stopOrigin.origin.x, y: stopOrigin.origin.y, z: stopOrigin.origin.z };
        }
        const rot = stopOrigin?.rotation;
        if (Array.isArray(rot) && Array.isArray(rot[0]) && rot.length >= 3 && rot[0].length >= 3) {
            stopPlaneU = { x: rot[0][0], y: rot[1][0], z: rot[2][0] };
            stopPlaneV = { x: rot[0][1], y: rot[1][1], z: rot[2][1] };
        }
    } catch (_) {
        // ignore; keep defaults
    }

    return { stopPlaneCenter3d, stopPlaneU, stopPlaneV, stopSolveMax };
}

function buildStopSolveRayFan(opticalSystemRows, chiefRayResult, wavelength, stopSurfaceIndex, targetSurfaceIndex, targetPointIndex, axis /* 'meridional'|'sagittal' */, isAngleField = false) {
    const { stopPlaneCenter3d, stopPlaneU, stopPlaneV, stopSolveMax } = computeStopPlaneFrame(opticalSystemRows, stopSurfaceIndex);
    if (!stopPlaneCenter3d) return [];

    const rayGroup = chiefRayResult?.rayGroups?.[0] || null;
    const chiefRayEntry = rayGroup?.rays?.find(r => (r?.rayType || '').toLowerCase() === 'chief') || null;
    const original = chiefRayEntry?.originalRay || {};

    const originBase = original.pos || original.position || chiefRayResult?.rayData?.startP || chiefRayResult?.startP;
    const dirBase = original.dir || original.direction || chiefRayResult?.rayData?.dir || chiefRayResult?.dir;

    if (!originBase || !Number.isFinite(originBase.x) || !Number.isFinite(originBase.y) || !Number.isFinite(originBase.z)) return [];
    const axisVec = (axis === 'meridional') ? stopPlaneV : stopPlaneU;

    // CBの有無で crossBeamData の有無/内容が揺れることがあるので、フィールド種別で判定する。
    const isInfinite = !!isAngleField;

    const n = 21;
    const fan = [];

    if (isInfinite) {
        const dir = normalize3({ x: dirBase?.x ?? 0, y: dirBase?.y ?? 0, z: dirBase?.z ?? 1 }) || { x: 0, y: 0, z: 1 };
        for (let i = 0; i < n; i++) {
            const pNorm = -1 + (2 * i) / (n - 1);
            const offset = pNorm * stopSolveMax;
            const stopTarget = {
                x: stopPlaneCenter3d.x + axisVec.x * offset,
                y: stopPlaneCenter3d.y + axisVec.y * offset,
                z: stopPlaneCenter3d.z + axisVec.z * offset
            };
            const guess = {
                x: originBase.x + axisVec.x * offset,
                y: originBase.y + axisVec.y * offset,
                z: originBase.z
            };
            const refined = solveRayOriginToStopPointFast(guess, dir, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength);
            const origin = refined || guess;
            const traced = traceRayPathWrapped(opticalSystemRows, { pos: origin, dir, wavelength }, targetSurfaceIndex);
            if (!traced.success || !traced.rayPath || traced.rayPath.length <= targetPointIndex) continue;
            fan.push({ segments: traced.rayPath, type: `${axis}_stop_solve` });
        }
        return fan;
    }

    for (let i = 0; i < n; i++) {
        const pNorm = -1 + (2 * i) / (n - 1);
        const offset = pNorm * stopSolveMax;
        const stopTarget = {
            x: stopPlaneCenter3d.x + axisVec.x * offset,
            y: stopPlaneCenter3d.y + axisVec.y * offset,
            z: stopPlaneCenter3d.z + axisVec.z * offset
        };
        const solvedDir = solveRayDirectionToStopPointFast(originBase, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength);
        if (!solvedDir) continue;
        const traced = traceRayPathWrapped(opticalSystemRows, { pos: originBase, dir: solvedDir, wavelength }, targetSurfaceIndex);
        if (!traced.success || !traced.rayPath || traced.rayPath.length <= targetPointIndex) continue;
        fan.push({ segments: traced.rayPath, type: `${axis}_stop_solve` });
    }
    return fan;
}

/**
 * 絞り面を検出
 * @param {Array} opticalSystemRows - 光学系データ
 * @returns {number} 絞り面のインデックス
 */
function findStopSurfaceIndex(opticalSystemRows) {
    // 明示ストップフラグ or Stop/STO ラベルを優先
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const row = opticalSystemRows[i] || {};
        const stopFlagRaw = row.stop ?? row.isStop ?? row['is stop'] ?? row['Stop'] ?? row['stop'];
        const stopFlag = (stopFlagRaw === true) || String(stopFlagRaw ?? '').trim().toLowerCase() === 'true' || String(stopFlagRaw ?? '').trim() === '1';
        if (stopFlag) return i;

        const objType = String(row?.['object type'] ?? row?.objectType ?? row?.object ?? '').trim().toLowerCase();
        const surfType = String(row?.surfType ?? row?.surface_type ?? row?.['surf type'] ?? row?.type ?? '').trim().toLowerCase();
        const compact = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
        const isStopLabel = objType === 'sto' || surfType === 'sto' || compact(objType) === 'sto' || compact(surfType) === 'sto' ||
            objType.includes('stop') || surfType.includes('stop');
        if (isStopLabel) return i;
    }
    
    // 最小開口面を探す
    let minApertureIndex = -1;
    let minAperture = Infinity;
    
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const row = opticalSystemRows[i];
        if (isCoordTransRow(row) || isObjectRow(row)) {
            continue;
        }
        const surfType = String(row?.surfType ?? row?.surface_type ?? row?.['surf type'] ?? '').toLowerCase();
        if (surfType === 'image') {
            continue;
        }
        
        const aperture = parseFloat(row.aperture || row.Aperture || row.semidia);
        
        if (!isNaN(aperture) && aperture > 0 && aperture < minAperture) {
            minAperture = aperture;
            minApertureIndex = i;
        }
    }
    
    if (minApertureIndex === -1) {
        return 6; // デフォルト
    }
    
    return minApertureIndex;
}

/**
 * 近軸像点（理想像点）の位置を計算
 * 主光線が評価面と交わる点を近軸像点とする
 * @param {Object} chiefRay - 主光線データ（第0面から開始）
 * @param {number} targetSurfaceIndex - 評価面のインデックス（絶対インデックス）
 * @returns {number|null} Z座標（近軸像点位置）
 */
function calculateParaxialImagePosition(opticalSystemRows, chiefRay, targetSurfaceIndex) {
    if (!chiefRay || !chiefRay.segments || chiefRay.segments.length === 0) {
        console.warn('      ⚠️ calculateParaxialImagePosition: 主光線データが不正です');
        return null;
    }

    const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (targetPointIndex === null) {
        console.warn(`      ⚠️ calculateParaxialImagePosition: targetSurfaceIndex=${targetSurfaceIndex}の変換に失敗しました`);
        return null;
    }
    
    console.log(`      🔍 主光線セグメント数: ${chiefRay.segments.length}, 評価面インデックス: ${targetSurfaceIndex}`);
    
    // 評価面での主光線位置を取得（絶対インデックスを使用）
    if (targetPointIndex >= chiefRay.segments.length) {
        console.warn(`      ⚠️ calculateParaxialImagePosition: targetPointIndex=${targetPointIndex}が範囲外です（最大: ${chiefRay.segments.length - 1}）`);
        return null;
    }
    
    const targetSegment = chiefRay.segments[targetPointIndex];
    if (!targetSegment) {
        console.warn(`      ⚠️ calculateParaxialImagePosition: targetSegmentが取得できません`);
        return null;
    }
    
    // 近軸像点は主光線の光軸との交点
    // findAxisIntersection を使用して主光線の焦点位置を計算
    const paraxialZ = findAxisIntersection(opticalSystemRows, chiefRay, targetSurfaceIndex);
    
    if (paraxialZ === null) {
        console.warn('      ⚠️ calculateParaxialImagePosition: 主光線の焦点計算に失敗 → 評価面Zで代用');
        const fallbackZ = chiefRay.segments[targetPointIndex]?.z;
        if (fallbackZ === undefined || fallbackZ === null) return null;
        console.log(`      📍 近軸像点位置(代用): Z = ${fallbackZ.toFixed(4)}mm`);
        return fallbackZ;
    }

    console.log(`      📍 近軸像点位置: Z = ${paraxialZ.toFixed(4)}mm`);
    return paraxialZ;
}

/**
 * 光線と光軸の交点を計算（Z軸との交点）
 * @param {Object} rayData - 光線データ
 * @param {number} targetSurfaceIndex - 評価面のインデックス
 * @returns {number|null} Z座標（像面位置）
 */
function findAxisIntersection(opticalSystemRows, rayData, targetSurfaceIndex) {
    if (!rayData || !rayData.segments || rayData.segments.length === 0) {
        console.warn('      ⚠️ findAxisIntersection: rayDataが不正です');
        return null;
    }

    const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (targetPointIndex === null) {
        console.warn(`      ⚠️ findAxisIntersection: targetSurfaceIndex=${targetSurfaceIndex}の変換に失敗しました`);
        return null;
    }
    
    // 評価面での光線位置を取得
    const targetSegment = rayData.segments[targetPointIndex];
    if (!targetSegment) {
        console.warn(`      ⚠️ findAxisIntersection: targetPointIndex=${targetPointIndex}のデータがありません`);
        return null;
    }
    
    // 方向ベクトルを計算（次の点、または前の点との差分）
    let dx, dy, dz;
    const nextIndex = targetPointIndex + 1;
    const prevIndex = targetPointIndex - 1;
    
    if (nextIndex < rayData.segments.length) {
        // 次の点が存在する場合（通常ケース）
        const nextSegment = rayData.segments[nextIndex];
        dx = nextSegment.x - targetSegment.x;
        dy = nextSegment.y - targetSegment.y;
        dz = nextSegment.z - targetSegment.z;
        console.log(`      🔍 方向計算: 評価面 → 次の面`);
    } else if (prevIndex >= 0) {
        // 評価面が最終面の場合、前の点との差分を使用
        const prevSegment = rayData.segments[prevIndex];
        dx = targetSegment.x - prevSegment.x;
        dy = targetSegment.y - prevSegment.y;
        dz = targetSegment.z - prevSegment.z;
        console.log(`      🔍 方向計算: 前の面 → 評価面（最終面）`);
    } else {
        console.warn(`      ⚠️ findAxisIntersection: 方向ベクトル計算不可（セグメントが1つのみ）`);
        return null;
    }
    
    // 正規化
    const length = Math.sqrt(dx*dx + dy*dy + dz*dz);
    if (length < 1e-10) {
        console.warn('      ⚠️ findAxisIntersection: 方向ベクトルが計算できません');
        return null;
    }
    
    const L = dx / length;
    const M = dy / length;
    const N = dz / length;
    
    const { x, y, z } = targetSegment;
    
    console.log(`      🔍 評価面での光線: (${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)})`);
    console.log(`      🔍 方向: (L=${L.toFixed(6)}, M=${M.toFixed(6)}, N=${N.toFixed(6)})`);
    
    // 光線が光軸とほぼ平行（N≈0）の場合は計算不可
    if (Math.abs(N) < 1e-10) {
        console.warn('      ⚠️ 光線が光軸とほぼ平行です');
        return null;
    }
    
    // 光軸との交点を計算
    // X = 0, Y = 0 となる位置を求める
    // X(t) = x + L*t = 0 → t_x = -x/L
    // Y(t) = y + M*t = 0 → t_y = -y/M
    
    let t;
    if (Math.abs(L) > Math.abs(M)) {
        // Lが大きい場合、X=0の条件を使用
        t = -x / L;
        console.log(`      🔍 X=0条件でt=${t.toFixed(4)}`);
    } else if (Math.abs(M) > 1e-10) {
        // Mが大きい場合、Y=0の条件を使用
        t = -y / M;
        console.log(`      🔍 Y=0条件でt=${t.toFixed(4)}`);
    } else {
        // L, M両方が小さい場合、すでに光軸上にある
        console.log(`      ℹ️ 光軸上にあります: Z=${z.toFixed(4)}`);
        return z;
    }
    
    // 妥当性チェック: tが異常に大きい場合は焦点がない（発散光線）
    const MAX_REASONABLE_DISTANCE = 1e6; // 緩和: 実焦点が遠い場合でもプロットを継続
    if (Math.abs(t) > MAX_REASONABLE_DISTANCE) {
        console.warn(`      ⚠️ 焦点距離が異常 (t=${t.toFixed(1)}mm): 光線が発散しています → 評価面Zを返します`);
        return targetSegment.z;
    }
    
    // Z座標を計算
    const z_intersection = z + N * t;
    
    console.log(`      ✅ 光軸交点: Z=${z_intersection.toFixed(4)}mm`);
    
    return z_intersection;
}

/**
 * 光線を指定のZ平面に投影して、その平面での交点を計算
 * @param {Object} segment - 光線セグメント（始点）
 * @param {Object} nextSegment - 次のセグメント（方向を決定）
 * @param {number} targetZ - 目標のZ座標
 * @returns {Object|null} {x, y, z} 交点座標
 */
function projectRayToZ(segment, nextSegment, targetZ) {
    const dx = nextSegment.x - segment.x;
    const dy = nextSegment.y - segment.y;
    const dz = nextSegment.z - segment.z;
    
    // Z方向の変化がほぼゼロの場合は投影不可
    if (Math.abs(dz) < 1e-10) {
        return null;
    }
    
    // パラメータtを計算: segment.z + t * dz = targetZ
    const t = (targetZ - segment.z) / dz;
    
    // 交点を計算
    return {
        x: segment.x + t * dx,
        y: segment.y + t * dy,
        z: targetZ
    };
}

/**
 * 指定のZ平面での横収差RMSを計算
 * @param {Array} rayFan - 光線ファンの配列 [{segments: [...], ...}, ...]
 * @param {Object} chiefRay - 主光線データ
 * @param {number} targetSurfaceIndex - 評価面のインデックス
 * @param {number} targetZ - 評価するZ平面の座標
 * @param {string} direction - 'meridional' または 'sagittal'
 * @returns {number|null} RMS値
 */
function calculateRMSAtZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, targetZ, direction) {
    const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (targetPointIndex === null) return null;

    // 主光線の評価面での位置と方向
    const chiefSegment = chiefRay.segments[targetPointIndex];
    const chiefNextIndex = targetPointIndex + 1;
    const chiefPrevIndex = targetPointIndex - 1;
    
    if (!chiefSegment) {
        return null;
    }
    
    // 主光線の方向ベクトルを計算（次の点、または前の点）
    let chiefNextSegment;
    if (chiefNextIndex < chiefRay.segments.length) {
        chiefNextSegment = chiefRay.segments[chiefNextIndex];
    } else if (chiefPrevIndex >= 0) {
        // 最終面の場合、前の点を使用して方向を逆算
        const chiefPrevSegment = chiefRay.segments[chiefPrevIndex];
        // 前の点から現在点への方向を使用
        chiefNextSegment = {
            x: chiefSegment.x + (chiefSegment.x - chiefPrevSegment.x),
            y: chiefSegment.y + (chiefSegment.y - chiefPrevSegment.y),
            z: chiefSegment.z + (chiefSegment.z - chiefPrevSegment.z)
        };
    } else {
        return null;
    }
    
    // 主光線のtargetZでの位置を計算
    const chiefAtZ = projectRayToZ(chiefSegment, chiefNextSegment, targetZ);
    if (!chiefAtZ) {
        return null;
    }
    
    // 各光線のtargetZでの位置を計算し、主光線との偏差を求める
    const deviations = [];
    
    for (const ray of rayFan) {
        if (!ray || !ray.segments || ray.segments.length <= targetPointIndex) {
            continue; // ケラレなどで到達していない光線はスキップ
        }
        
        const segment = ray.segments[targetPointIndex];
        
        // 光線の方向ベクトルを計算
        let nextSegment;
        if (targetPointIndex + 1 < ray.segments.length) {
            nextSegment = ray.segments[targetPointIndex + 1];
        } else if (targetPointIndex - 1 >= 0) {
            // 最終面の場合
            const prevSegment = ray.segments[targetPointIndex - 1];
            nextSegment = {
                x: segment.x + (segment.x - prevSegment.x),
                y: segment.y + (segment.y - prevSegment.y),
                z: segment.z + (segment.z - prevSegment.z)
            };
        } else {
            continue;
        }
        
        const rayAtZ = projectRayToZ(segment, nextSegment, targetZ);
        if (!rayAtZ) {
            continue;
        }
        
        // メリディオナル（YZ面）ではY方向の偏差、サジタル（XZ面）ではX方向の偏差
        const deviation = direction === 'meridional' 
            ? (rayAtZ.y - chiefAtZ.y)
            : (rayAtZ.x - chiefAtZ.x);
        
        deviations.push(deviation);
    }
    
    if (deviations.length === 0) {
        return null;
    }
    
    // RMS計算
    const sumSq = deviations.reduce((sum, dev) => sum + dev * dev, 0);
    const rms = Math.sqrt(sumSq / deviations.length);
    
    return rms;
}

/**
 * RMSが最小となるZ位置を黄金分割法とニュートン法のハイブリッドで探索
 * @param {Array} rayFan - 光線ファンの配列
 * @param {Object} chiefRay - 主光線データ
 * @param {number} targetSurfaceIndex - 評価面のインデックス
 * @param {number} referenceZ - Image面のZ座標（基準位置）
 * @param {string} direction - 'meridional' または 'sagittal'
 * @returns {number|null} 最良焦点のZ座標
 */
function findBestFocusZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, referenceZ, direction) {
    console.log(`      🔍 最良焦点探索（ハイブリッド法）: 光線ファン=${rayFan.length}本, 基準位置=${referenceZ.toFixed(4)}mm`);
    
    // 探索範囲：Image面（基準位置） ± 10mm
    const searchRange = 10; // mm
    let zMin = referenceZ - searchRange;
    let zMax = referenceZ + searchRange;
    
    // ステップ1: 粗探索で初期範囲を絞る（41点サンプリング）
    const numCoarseSamples = 41;
    let bestZ = referenceZ;
    let minRMS = Infinity;
    let validSamples = 0;
    
    console.log(`      🔍 粗探索: ${zMin.toFixed(2)}mm ~ ${zMax.toFixed(2)}mm (${numCoarseSamples}点)`);
    
    const coarseSamples = [];
    for (let i = 0; i < numCoarseSamples; i++) {
        const z = zMin + (zMax - zMin) * i / (numCoarseSamples - 1);
        const rms = calculateRMSAtZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, z, direction);
        
        if (rms !== null) {
            validSamples++;
            coarseSamples.push({ z, rms });
            if (rms < minRMS) {
                minRMS = rms;
                bestZ = z;
            }
        }
    }
    
    console.log(`      📊 粗探索結果: 有効サンプル=${validSamples}/${numCoarseSamples}, 初期最良Z=${bestZ.toFixed(4)}mm, RMS=${minRMS.toFixed(6)}mm`);
    
    if (minRMS === Infinity || coarseSamples.length < 3) {
        console.warn(`      ⚠️ 有効なサンプルが不足`);
        return null;
    }
    
    // 最小値周辺の範囲を特定（3点法：左、中央、右）
    coarseSamples.sort((a, b) => a.z - b.z);
    let bestIndex = coarseSamples.findIndex(s => s.z === bestZ);
    
    // 最小値の左右の点を見つける
    let leftIndex = Math.max(0, bestIndex - 2);
    let rightIndex = Math.min(coarseSamples.length - 1, bestIndex + 2);
    
    zMin = coarseSamples[leftIndex].z;
    zMax = coarseSamples[rightIndex].z;
    
    console.log(`      🔍 範囲絞り込み: ${zMin.toFixed(4)}mm ~ ${zMax.toFixed(4)}mm (幅=${(zMax - zMin).toFixed(4)}mm)`);
    
    // ステップ2: 黄金分割法で高精度探索
    const tolerance = 0.001; // 収束判定：0.001mm以下
    const maxIterations = 30;
    const phi = (1 + Math.sqrt(5)) / 2; // 黄金比
    const resphi = 2 - phi;
    
    let a = zMin;
    let b = zMax;
    let x1 = a + resphi * (b - a);
    let x2 = b - resphi * (b - a);
    
    let f1 = calculateRMSAtZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, x1, direction);
    let f2 = calculateRMSAtZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, x2, direction);
    
    if (f1 === null || f2 === null) {
        console.warn(`      ⚠️ 黄金分割法の初期評価失敗`);
        return bestZ;
    }
    
    console.log(`      🔍 黄金分割法開始: [${a.toFixed(6)}, ${b.toFixed(6)}]mm, 収束判定=${tolerance}mm`);
    
    let iteration = 0;
    while (iteration < maxIterations && (b - a) > tolerance) {
        if (f1 < f2) {
            b = x2;
            x2 = x1;
            f2 = f1;
            x1 = a + resphi * (b - a);
            f1 = calculateRMSAtZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, x1, direction);
        } else {
            a = x1;
            x1 = x2;
            f1 = f2;
            x2 = b - resphi * (b - a);
            f2 = calculateRMSAtZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, x2, direction);
        }
        
        if (f1 === null || f2 === null) break;
        
        iteration++;
        
        if (iteration <= 5 || iteration % 5 === 0) {
            console.log(`      📊 反復${iteration}: [${a.toFixed(6)}, ${b.toFixed(6)}]mm, 幅=${(b - a).toFixed(6)}mm, RMS1=${f1.toFixed(6)}mm, RMS2=${f2.toFixed(6)}mm`);
        }
        
        if ((b - a) <= tolerance) {
            console.log(`      ✅ 収束: 範囲幅=${(b - a).toFixed(6)}mm <= ${tolerance}mm`);
            break;
        }
    }
    
    // 最終的な最良Z位置（区間の中点）
    const finalZ = (a + b) / 2;
    const finalRMS = calculateRMSAtZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, finalZ, direction);
    
    console.log(`      📊 ${direction} 最良焦点: Z=${finalZ.toFixed(6)}mm, RMS=${finalRMS?.toFixed(6)}mm (反復${iteration}回)`);
    
    return finalZ;
}

/**
 * メリディオナル（子午断面）のマージナル光線を追跡して最良焦点を求める
 * Draw Crossシステムで既に追跡済みの上下マージナル光線を直接使用
 * YZ面の扇形光線ファン（タンジェンシャル方向）をRMSベースで評価
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} chiefRay - 主光線データ（第0面から開始）
 * @param {Object} chiefRayResult - calculateChiefRayNewtonの完全な返り値（rayGroupsを含む）
 * @param {number} wavelength - 波長（μm）
 * @param {number} stopSurfaceIndex - 絞り面のインデックス（絶対インデックス）
 * @param {number} targetSurfaceIndex - 評価面のインデックス（絶対インデックス）
 * @param {number} imageSurfaceZ - Image面のZ座標（基準位置）
 * @returns {number|null} メリディオナル最良焦点のZ座標
 */
function traceMeridionalMarginalRay(
    opticalSystemRows,
    chiefRay,
    chiefRayResult,
    wavelength,
    stopSurfaceIndex,
    targetSurfaceIndex,
    imageSurfaceZ,
    isAngleField = false
) {
    try {
        console.log('      📊 Stop-solve 光線ファンを使用（メリディオナル）');
        
        // Draw Crossの光線グループを取得
        if (!chiefRayResult || !chiefRayResult.rayGroups || !chiefRayResult.rayGroups[0]) {
            console.warn('      ⚠️ メリディオナル: rayGroupsが不正です');
            return null;
        }

        const rayGroup = chiefRayResult.rayGroups[0];
        if (!rayGroup.rays) {
            console.warn('      ⚠️ メリディオナル: rayGroup.raysが不正です');
            return null;
        }

        console.log(`      🔍 光線グループ内の光線数: ${rayGroup.rays.length}`);

        // CBの有無で Draw Cross の分類/到達が揺れるため、常に stop-solve でファンを構築して一貫性を確保する。
        const rayFan = [];

        const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
        if (targetPointIndex === null) {
            console.warn('      ⚠️ メリディオナル: targetSurfaceIndex変換失敗');
            return null;
        }
        
        const solvedFan = buildStopSolveRayFan(
            opticalSystemRows,
            chiefRayResult,
            wavelength,
            stopSurfaceIndex,
            targetSurfaceIndex,
            targetPointIndex,
            'meridional',
            isAngleField
        );
        if (solvedFan.length > 0) {
            rayFan.push(...solvedFan);
        }

        console.log(`      📊 メリディオナル光線ファン(stop-solve): ${rayFan.length}本使用`);
        if (rayFan.length < 3) {
            console.warn('      ⚠️ メリディオナル: stop-solveでも光線が不足しています');
            return null;
        }
        
        // RMSベースの最良焦点探索（Image面Z位置を基準）
        const bestZ = findBestFocusZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, imageSurfaceZ, 'meridional');
        
        if (bestZ === null) {
            console.warn('      ⚠️ メリディオナル: 最良焦点が見つかりませんでした');
            return null;
        }
        
        return bestZ;
        
    } catch (error) {
        console.error('      ❌ メリディオナル光線追跡エラー:', error);
        return null;
    }
}

/**
 * サジタル（球欠断面）のマージナル光線を追跡して最良焦点を求める
 * Draw Crossシステムで既に追跡済みの左右マージナル光線を直接使用
 * XZ面の扇形光線ファン（サジタル方向）をRMSベースで評価
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} chiefRay - 主光線データ（第0面から開始）
 * @param {Object} chiefRayResult - calculateChiefRayNewtonの完全な返り値（rayGroupsを含む）
 * @param {number} wavelength - 波長（μm）
 * @param {number} stopSurfaceIndex - 絞り面のインデックス（絶対インデックス）
 * @param {number} targetSurfaceIndex - 評価面のインデックス（絶対インデックス）
 * @param {number} imageSurfaceZ - Image面のZ座標（基準位置）
 * @returns {number|null} サジタル最良焦点のZ座標
 */
function traceSagittalMarginalRay(
    opticalSystemRows,
    chiefRay,
    chiefRayResult,
    wavelength,
    stopSurfaceIndex,
    targetSurfaceIndex,
    imageSurfaceZ,
    isAngleField = false
) {
    try {
        console.log('      📊 Stop-solve 光線ファンを使用（サジタル）');
        
        // Draw Crossの光線グループを取得
        if (!chiefRayResult || !chiefRayResult.rayGroups || !chiefRayResult.rayGroups[0]) {
            console.warn('      ⚠️ サジタル: rayGroupsが不正です');
            return null;
        }

        const rayGroup = chiefRayResult.rayGroups[0];
        if (!rayGroup.rays) {
            console.warn('      ⚠️ サジタル: rayGroup.raysが不正です');
            return null;
        }

        console.log(`      🔍 光線グループ内の光線数: ${rayGroup.rays.length}`);

        // CBの有無で Draw Cross の分類/到達が揺れるため、常に stop-solve でファンを構築して一貫性を確保する。
        const rayFan = [];

        const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
        if (targetPointIndex === null) {
            console.warn('      ⚠️ サジタル: targetSurfaceIndex変換失敗');
            return null;
        }
        
        const solvedFan = buildStopSolveRayFan(
            opticalSystemRows,
            chiefRayResult,
            wavelength,
            stopSurfaceIndex,
            targetSurfaceIndex,
            targetPointIndex,
            'sagittal',
            isAngleField
        );
        if (solvedFan.length > 0) {
            rayFan.push(...solvedFan);
        }

        console.log(`      📊 サジタル光線ファン(stop-solve): ${rayFan.length}本使用`);
        if (rayFan.length < 3) {
            console.warn('      ⚠️ サジタル: stop-solveでも光線が不足しています');
            return null;
        }
        
        // RMSベースの最良焦点探索（Image面Z位置を基準）
        const bestZ = findBestFocusZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, imageSurfaceZ, 'sagittal');
        
        if (bestZ === null) {
            console.warn('      ⚠️ サジタル: 最良焦点が見つかりませんでした');
            return null;
        }
        
        return bestZ;
        
    } catch (error) {
        console.error('      ❌ サジタル光線追跡エラー:', error);
        return null;
    }
}

/**
 * フィールド設定を取得
 * @returns {Array} フィールド設定の配列
 */
function getFieldSettingsFromObject(objectRowsParam) {
    try {
        // 可能なら引数のObject行を優先し、未指定の場合のみテーブルから取得
        const objectRows = (objectRowsParam && objectRowsParam.length > 0)
            ? objectRowsParam
            : getObjectRows();
        if (!objectRows || objectRows.length === 0) {
            console.warn('⚠️ Object データが見つかりません');
            return [];
        }
        
        console.log(`   Object行数: ${objectRows.length}`);
        console.log(`   🔍 Object生データ:`, objectRows);
        
        const fieldSettings = [];
        
        for (let i = 0; i < objectRows.length; i++) {
            const obj = objectRows[i];
            const name = obj.name || obj.Name || `Object${i + 1}`;
            
            // 位置タイプを判定（"rectangle" に含まれる "angle" を誤検出しない）
                const positionType = (obj.position || obj.fieldType || obj.type || '').toLowerCase();
                const isAngle = positionType === 'angle' || positionType.includes(' angle') || positionType.startsWith('angle ');
            
            console.log(`   Object ${i + 1}: name="${name}", position="${positionType}", isAngle=${isAngle}`);
            console.log(`      生データ:`, obj);
            
            // X座標を取得
            let xValue = 0;
            if (isAngle) {
                xValue = parseFloat(obj.xFieldAngle || obj.xAngle || obj.xHeightAngle || obj.x || 0);
            } else {
                // Heightフィールドでも xHeightAngle に値が入ることがあるためフォールバックに含める
                xValue = parseFloat(obj.xHeight || obj.x || obj.xHeightAngle || obj.xFieldAngle || obj.xAngle || 0);
            }
            
            // Y座標を取得
            let yValue = 0;
            if (isAngle) {
                yValue = parseFloat(obj.yFieldAngle || obj.fieldAngle || obj.yAngle || obj.yHeightAngle || obj.y || 0);
            } else {
                // Heightフィールドでも yHeightAngle に値が入ることがあるためフォールバックに含める
                yValue = parseFloat(obj.yHeight || obj.y || obj.yHeightAngle || obj.yFieldAngle || obj.yAngle || 0);
            }
            
            console.log(`      解析結果: x=${xValue}, y=${yValue}`);
            
            fieldSettings.push({
                name: name,
                displayName: name,
                x: xValue,
                y: yValue,
                xHeight: isAngle ? undefined : xValue,
                yHeight: isAngle ? undefined : yValue,
                xHeightAngle: isAngle ? undefined : xValue, // mirror for downstream consumers expecting ...HeightAngle
                yHeightAngle: isAngle ? undefined : yValue, // mirror for downstream consumers expecting ...HeightAngle
                fieldType: isAngle ? 'angle' : 'height',
                objectIndex: i,
                position: positionType
            });
        }
        
        console.log(`   ✅ フィールド設定取得完了: ${fieldSettings.length}件`);
        return fieldSettings;
        
    } catch (error) {
        console.error('❌ フィールド設定取得エラー:', error);
        return [];
    }
}

/**
 * フィールド設定を補間して点数を増やす
 * @param {Array} originalFields - 元のフィールド設定
 * @param {number} totalPoints - 目標点数（デフォルト: 9）
 * @returns {Array} 補間されたフィールド設定
 */
function interpolateFieldSettings(originalFields, totalPoints = 9) {
    if (!originalFields || originalFields.length === 0) {
        return [];
    }
    
    // Y角度でソート
    const sortedFields = [...originalFields].sort((a, b) => a.y - b.y);
    
    const minAngle = sortedFields[0].y;
    const maxAngle = sortedFields[sortedFields.length - 1].y;
    
    console.log(`   📊 補間: ${originalFields.length}点 → ${totalPoints}点 (${minAngle}° ~ ${maxAngle}°)`);
    
    const interpolatedFields = [];
    
    for (let i = 0; i < totalPoints; i++) {
        const targetAngle = minAngle + (maxAngle - minAngle) * i / (totalPoints - 1);
        
        interpolatedFields.push({
            name: `Field${i + 1}`,
            displayName: `${targetAngle.toFixed(1)}°`,
            x: 0,
            y: targetAngle,
            fieldType: 'angle',
            objectIndex: -1, // 補間された点
            position: 'angle',
            isInterpolated: true
        });
    }
    
    return interpolatedFields;
}

// 物体高指定フィールドを補間して点数を増やす
function interpolateHeightFieldSettings(originalFields, totalPoints = 9) {
    if (!originalFields || originalFields.length === 0) {
        return [];
    }

    // Y高さでソート
    const sortedFields = [...originalFields].sort((a, b) => a.y - b.y);

    const minH = sortedFields[0].y;
    const maxH = sortedFields[sortedFields.length - 1].y;

    console.log(`   📊 補間(高さ): ${originalFields.length}点 → ${totalPoints}点 (${minH}mm ~ ${maxH}mm)`);

    const interpolatedFields = [];

    for (let i = 0; i < totalPoints; i++) {
        const targetH = minH + (maxH - minH) * i / (totalPoints - 1);
        interpolatedFields.push({
            name: `Field${i + 1}`,
            displayName: `${targetH.toFixed(2)}mm`,
            x: 0,
            y: targetH,
            xHeight: 0,
            yHeight: targetH,
            xHeightAngle: 0,
            yHeightAngle: targetH,
            fieldType: 'height',
            objectIndex: -1, // 補間点
            position: 'height',
            isInterpolated: true
        });
    }

    return interpolatedFields;
}

/**
 * 非点収差データを計算
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Array} sourceRows - Sourceテーブルデータ（波長情報）
 * @param {Array} objectRows - Objectテーブルデータ（画角情報）
 * @param {number} targetSurfaceIndex - 評価面のインデックス
 * @param {Object} options - オプション
 * @param {boolean} options.spotDiagramMode - スポット表示モード
 * @param {number} options.rayCount - クロスビームの光線本数
 * @param {number} options.interpolationPoints - 補間する点数
 * @returns {Object} 非点収差データ
 */
export async function calculateAstigmatismData(opticalSystemRows, sourceRows, objectRows, targetSurfaceIndex, options = {}) {
    const {
        spotDiagramMode = false,
        rayCount = 51,
        interpolationPoints = 9,
        verbose = false,  // 詳細ログを制御
        onProgress = null,
        yieldEvery = 1
    } = options;

    const progressCb = (typeof onProgress === 'function') ? onProgress : null;
    const safeProgress = (percent, message) => {
        try { progressCb?.({ percent, message }); } catch (_) {}
    };
    const yieldToUI = async () => new Promise(resolve => setTimeout(resolve, 0));
    
    if (verbose) {
        console.log('🎯🎯🎯 非点収差計算開始（新バージョン） 🎯🎯🎯');
        console.log(`   評価面: Surface ${targetSurfaceIndex + 1}`);
        console.log(`   光線本数: ${rayCount}本`);
        console.log(`   モード: ${spotDiagramMode ? 'スポットダイアグラム（全画角表示）' : '非点収差図'}`);
        console.log(`   🔍 spotDiagramMode = ${spotDiagramMode}`);
    }
    
    try {
        safeProgress(0, 'Preparing astigmatism...');
        await yieldToUI();

        // Sourceテーブルから波長を取得
        const wavelengths = sourceRows
            .map(row => parseFloat(row.wavelength || row.Wavelength || 0.5876))
            .filter(w => Number.isFinite(w) && w > 0);
        if (verbose) console.log(`   波長数: ${wavelengths.length}`);
        
        // Objectテーブルからフィールド設定を取得
        // 角度指定ならangle、矩形指定なら高さとして扱う（Rectangleは物体高）
        let fieldSettings = getFieldSettingsFromObject(objectRows);
        if (!fieldSettings || fieldSettings.length === 0) {
            // フォールバック（従来の簡易パス）
            fieldSettings = objectRows.map((obj, index) => {
                const positionType = (obj.position || obj.fieldType || obj.type || '').toLowerCase();
                const isAngle = positionType.includes('angle');
                const xVal = isAngle
                    ? parseFloat(obj.xFieldAngle || obj.xHeightAngle || obj.xAngle || obj.x || 0)
                    : parseFloat(obj.xHeight || obj.x || obj.xHeightAngle || obj.xFieldAngle || obj.xAngle || 0);
                const yVal = isAngle
                    ? parseFloat(obj.yFieldAngle || obj.yHeightAngle || obj.yAngle || obj.y || 0)
                    : parseFloat(obj.yHeight || obj.y || obj.yHeightAngle || obj.yFieldAngle || obj.yAngle || 0);

                return {
                    name: obj.name || `Object${index + 1}`,
                    displayName: isAngle ? `${yVal.toFixed(1)}°` : `${yVal.toFixed(2)}mm`,
                    x: xVal,
                    y: yVal,
                    xHeightAngle: isAngle ? undefined : xVal,
                    yHeightAngle: isAngle ? undefined : yVal,
                    fieldType: isAngle ? 'angle' : 'height',
                    objectIndex: index,
                    position: positionType || (isAngle ? 'angle' : 'height')
                };
            });
        }
        
        if (!fieldSettings || fieldSettings.length === 0) {
            console.error('❌ フィールド設定が取得できませんでした');
            return {
                targetSurface: targetSurfaceIndex,
                wavelengths: wavelengths,
                fieldSettings: [],
                data: []
            };
        }
        
        console.log(`   元のフィールド数: ${fieldSettings.length}`);
        console.log(`   元のフィールド設定:`, fieldSettings.map(f => `${f.displayName} (y=${f.y}°)`));
        
        // スポット表示モードでは補間を行わない。補間は角度フィールドのときのみ実行（Rectangle/heightの場合はそのまま）。
        if (!spotDiagramMode && interpolationPoints > 0) {
            const allAngle = fieldSettings.every(f => (f.fieldType || '').toLowerCase() === 'angle');
            const allHeight = fieldSettings.every(f => (f.fieldType || '').toLowerCase() === 'height');
            if (allAngle) {
                fieldSettings = interpolateFieldSettings(fieldSettings, interpolationPoints);
            } else if (allHeight && fieldSettings.length >= 2) {
                fieldSettings = interpolateHeightFieldSettings(fieldSettings, interpolationPoints);
            } else {
                console.log('   ℹ️ 異種フィールド混在のため補間をスキップ');
            }
        }
        
        console.log(`   計算するフィールド数: ${fieldSettings.length}`);
        console.log(`   最終フィールド設定:`, fieldSettings.map(f => `${f.displayName} (y=${f.y}°)`));

        safeProgress(5, 'Computing reference focus...');
        await yieldToUI();

        // スポット表示モードでは、既存のスポットダイアグラム計算ロジックをそのまま使用し、
        // 結果を非点データ形式に詰め替えて返す
        if (spotDiagramMode) {
            const { generateSpotDiagram } = await import('./eva-spot-diagram.js');

            // eva-spot-diagram は面番号を1始まりで受け取る
            const surfaceNumber = targetSurfaceIndex + 1;
            let spotResult = null;
            try {
                spotResult = generateSpotDiagram(opticalSystemRows, sourceRows, objectRows, surfaceNumber, rayCount);
            } catch (e) {
                console.error('❌ スポットダイアグラム生成エラー:', e);
                return {
                    targetSurface: targetSurfaceIndex,
                    stopSurface: null,
                    relativeTargetIndex: null,
                    wavelengths: wavelengths,
                    fieldSettings: fieldSettings,
                    primaryWavelength: null,
                    primaryReferenceZ: null,
                    data: []
                };
            }

            const spotArray = spotResult?.spotData || [];
            const primaryWl = spotResult?.primaryWavelength?.wavelength || spotResult?.primaryWavelength || wavelengths[0] || 0.5876;

            const hasHeight = (fieldSettings || []).some(f => (f.fieldType || '').toLowerCase() === 'height');
            const hasAngle = (fieldSettings || []).some(f => (f.fieldType || '').toLowerCase() === 'angle');
            const isAngleField = hasHeight ? false : hasAngle;

            const data = spotArray.map((sd, idx) => {
                const obj = objectRows[sd.objectIndex] || fieldSettings[sd.objectIndex] || {};
                const fieldAngle = parseFloat(obj.yHeightAngle || obj.yFieldAngle || obj.fieldAngle || obj.y || fieldSettings[idx]?.y || 0);
                const fieldName = obj.name || obj.displayName || `Field${idx + 1}`;
                const spots = (sd.spotPoints || []).map(p => ({
                    x: p.x,
                    y: p.y,
                    rayType: p.rayType || (p.isChiefRay ? 'chief' : ''),
                    originalType: p.originalType || ''
                }));
                return {
                    wavelength: primaryWl,
                    fieldAngle,
                    fieldName,
                    paraxialImageZ: null,
                    meridionalDeviation: null,
                    sagittalDeviation: null,
                    astigmaticDifference: null,
                    crossBeamIntersections: { spots }
                };
            });

            return {
                targetSurface: targetSurfaceIndex,
                stopSurface: null,
                relativeTargetIndex: null,
                wavelengths: wavelengths,
                fieldSettings: fieldSettings,
                isAngleField,
                primaryWavelength: primaryWl,
                primaryReferenceZ: null,
                data: data
            };
        }
        
        // 絞り面を検出
        const stopSurfaceIndex = findStopSurfaceIndex(opticalSystemRows);
        console.log(`   絞り面: Surface ${stopSurfaceIndex + 1}`);
        
        // Calculate relative index from stop surface
        // Ray tracing starts at stop surface, so segment index 0 = stop surface
        // targetSurfaceIndex is absolute, so we need to subtract stopSurfaceIndex
        const relativeTargetIndex = targetSurfaceIndex - stopSurfaceIndex;
        console.log(`   評価面の相対インデックス: ${relativeTargetIndex} (絞り面から${relativeTargetIndex}面後)`);
        
        const astigmatismData = {
            targetSurface: targetSurfaceIndex,
            stopSurface: stopSurfaceIndex,
            relativeTargetIndex: relativeTargetIndex,
            wavelengths: wavelengths,
            fieldSettings: fieldSettings,
            // 角度フィールドのみかどうかのフラグ（プロット側の単位切替に使用）
            isAngleField: fieldSettings.every(f => (f.fieldType || '').toLowerCase() === 'angle'),
            primaryWavelength: null, // 主波長
            primaryReferenceZ: null, // 主波長の軸上（0°）近軸像点位置（すべての基準0点）
            data: [] // { wavelength, fieldAngle, paraxialImageZ, meridionalDeviation, sagittalDeviation }
        };
        
        // 主波長を特定（Sourceテーブルの Primary Wavelength を優先）
        const primaryWavelength = __pickPrimaryWavelengthMicrons(sourceRows, wavelengths[0] || 0.5876);
        astigmatismData.primaryWavelength = primaryWavelength;
        if (verbose) console.log(`\n🎯🎯🎯 主波長設定: ${primaryWavelength}μm 🎯🎯🎯`);

        // 表示用/下流互換のため、wavelengths が空なら primary を入れておく
        if (wavelengths.length === 0) {
            wavelengths.push(primaryWavelength);
        }
        
        // 軸上（0°）フィールドを検索
        const axialField = fieldSettings.find(f => {
            const fieldType = (f.fieldType || '').toLowerCase();
            if (fieldType === 'angle') {
                const angle = Math.abs(f.y || 0);  // yフィールドを直接使用
                return angle < 0.001; // ほぼ0°
            } else {
                const height = Math.abs(f.y || 0);
                return height < 0.001;
            }
        });
        
        if (verbose) {
            console.log(`   🔍 フィールド設定一覧:`, fieldSettings.map(f => `${f.displayName} (y=${f.y})`));
            console.log(`   🔍 軸上フィールド検索結果: ${axialField ? axialField.displayName + ' (y=' + axialField.y + ')' : '見つからず'}`);
        }
        
        // 主波長の基準位置を計算（すべての基準0点）
        let referenceField = axialField;
        
        // 軸上フィールドが見つからない場合は、最小画角のフィールドを使用
        if (!referenceField && fieldSettings.length > 0) {
            // Y角度でソートして最小のものを取得
            const sortedFields = [...fieldSettings].sort((a, b) => Math.abs(a.y) - Math.abs(b.y));
            referenceField = sortedFields[0];
            console.warn(`   ⚠️ 軸上フィールドが見つからないため、最小画角を基準とします: ${referenceField.displayName} (y=${referenceField.y})`);
        }
        
        if (referenceField) {
            console.log(`   🎯 主波長の基準フィールドで基準像面を計算: ${referenceField.displayName}`);
            const referenceChiefResult = calculateChiefRayNewton(
                opticalSystemRows,
                referenceField,
                primaryWavelength,
                'unified',
                { 
                    targetSurfaceIndex,
                    rayCount: rayCount  // クロスビーム光線本数を指定
                }
            );
            
            console.log(`   🔍 calculateChiefRayNewton結果: convergence=${referenceChiefResult?.convergence}, ray存在=${!!referenceChiefResult?.ray}, rayData存在=${!!referenceChiefResult?.rayData}`);
            
            if (referenceChiefResult && referenceChiefResult.convergence) {
                // rayData または ray を使用
                const referenceChiefRay = referenceChiefResult.rayData || referenceChiefResult.ray;
                console.log(`   🔍 ray.segments数=${referenceChiefRay?.segments?.length}, targetSurfaceIndex=${targetSurfaceIndex}`);

                const referenceTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
                if (referenceTargetPointIndex === null) {
                    console.error(`   ❌ targetSurfaceIndex変換失敗: targetSurfaceIndex=${targetSurfaceIndex}`);
                }

                if (referenceChiefRay && referenceChiefRay.segments && referenceTargetPointIndex !== null && referenceTargetPointIndex < referenceChiefRay.segments.length) {
                    const referenceIntersection = findAxisIntersection(opticalSystemRows, { segments: referenceChiefRay.segments }, targetSurfaceIndex);
                    console.log(`   🔍 findAxisIntersection結果: ${referenceIntersection}`);
                    
                    if (referenceIntersection !== null) {
                        astigmatismData.primaryReferenceZ = referenceIntersection;
                        console.log(`   ✅✅✅ 主波長の基準像面位置: Z = ${referenceIntersection.toFixed(4)}mm（この位置を0とする） ✅✅✅`);
                    } else {
                        console.error(`   ❌ findAxisIntersection が null を返しました`);
                    }
                } else {
                    console.error(`   ❌ 主光線セグメントが不正: segments=${referenceChiefRay?.segments?.length}, required>${referenceTargetPointIndex}`);
                }
            } else {
                console.error(`   ❌ calculateChiefRayNewton が収束しませんでした: convergence=${referenceChiefResult?.convergence}`);
            }
        } else {
            console.error(`   ❌ 基準フィールドが見つかりません`);
        }
        
        if (astigmatismData.primaryReferenceZ === null) {
            console.warn(`   ⚠️⚠️⚠️ 主波長の軸上フィールドで基準像面取得失敗 ⚠️⚠️⚠️`);
        }
        
        // 各波長×各フィールドについて計算
        // NOTE: Promise.microtasks won't allow UI repaint during long sync work.
        // We intentionally run in small chunks and yield to the event loop.
        const startTime = performance.now();
        const totalTasks = Math.max(1, wavelengths.length * fieldSettings.length);
        let completed = 0;

        for (let w = 0; w < wavelengths.length; w++) {
            const wavelength = wavelengths[w];
            if (verbose) console.log(`\n📊 波長 ${wavelength}μm の計算中...`);

            for (let i = 0; i < fieldSettings.length; i++) {
                const fieldSetting = fieldSettings[i];

                const result = calculateFieldData(
                    opticalSystemRows,
                    fieldSetting,
                    wavelength,
                    i,
                    fieldSettings.length,
                    spotDiagramMode,
                    rayCount,
                    targetSurfaceIndex,
                    stopSurfaceIndex,
                    astigmatismData.primaryReferenceZ,
                    verbose
                );

                if (result) {
                    astigmatismData.data.push(result);
                }

                completed++;
                const pct = 10 + (85 * (completed / totalTasks));
                safeProgress(Math.min(95, Math.max(0, pct)), `Calculating (${completed}/${totalTasks})...`);

                if (yieldEvery > 0 && (completed % yieldEvery) === 0) {
                    await yieldToUI();
                }
            }
        }

        safeProgress(95, 'Finalizing...');
        await yieldToUI();
        
        const endTime = performance.now();
        console.log(`✅ 非点収差計算完了 (${(endTime - startTime).toFixed(0)}ms, ${astigmatismData.data.length}点)`);

        safeProgress(100, 'Done');
        
        return astigmatismData;
        
    } catch (error) {
        console.error('❌ 非点収差計算エラー:', error);
        return null;
    }
}

/**
 * 各フィールドのデータを計算（並列化用のヘルパー関数）
 */
function calculateFieldData(
    opticalSystemRows,
    fieldSetting,
    wavelength,
    fieldIndex,
    totalFields,
    spotDiagramMode,
    rayCount,
    targetSurfaceIndex,
    stopSurfaceIndex,
    primaryReferenceZ,
    verbose
) {
    // フィールド角を取得（角度の場合はそのまま、高さの場合は0とする）
    let fieldAngle;
    const fieldType = (fieldSetting.fieldType || '').toLowerCase();
    
    if (fieldType === 'angle') {
        // Y方向の角度を使用（複数のフィールド名に対応）
        fieldAngle = Math.abs(
            fieldSetting.yFieldAngle || 
            fieldSetting.fieldAngle || 
            fieldSetting.y || 
            fieldSetting.yHeightAngle || 
            0
        );
    } else {
        // 高さの場合はyHeight値を使用、または0
        fieldAngle = Math.abs(fieldSetting.yHeight || fieldSetting.y || 0);
    }
    
    if (verbose) console.log(`   フィールド ${fieldIndex + 1}/${totalFields}: ${fieldSetting.displayName} (${fieldAngle}°)`);
    
    try {
        // 主光線を計算（近軸像点計算に必要）
        // rayCount オプションでクロスビームの光線本数を指定
        const chiefRayResult = calculateChiefRayNewton(
            opticalSystemRows, 
            fieldSetting, 
            wavelength, 
            'unified',
            { rayCount: rayCount }  // クロスビームの光線本数を渡す
        );
        if (!chiefRayResult || !chiefRayResult.success) {
            if (verbose) console.warn(`      ⚠️ 主光線の計算に失敗しました`);
            return null;
        }
        
        const chiefRay = chiefRayResult.rayData;
        if (!chiefRay || !chiefRay.segments) {
            if (verbose) console.warn(`      ⚠️ 主光線データが不正です`);
            return null;
        }
        
        if (verbose) {
            console.log(`      🔍 主光線セグメント数: ${chiefRay.segments.length}`);
            console.log(`      🔍 評価面絶対インデックス: ${targetSurfaceIndex}`);
            console.log(`      🔍 絞り面インデックス: ${stopSurfaceIndex}`);
        }
        
        // 主光線の評価面（Image面）での交点Z位置を基準として使用
        const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
        if (targetPointIndex === null) {
            if (verbose) console.warn(`      ⚠️ targetSurfaceIndex変換失敗`);
            return null;
        }

        const chiefSegment = chiefRay.segments[targetPointIndex];
        if (!chiefSegment) {
            if (verbose) console.warn(`      ⚠️ 主光線が評価面に到達していません`);
            return null;
        }
        const imageSurfaceZ = chiefSegment.z;
        if (verbose) console.log(`      📍 主光線とImage面の交点Z位置: ${imageSurfaceZ.toFixed(4)}mm`);
        
        // 近軸像点（理想像点）を計算（絶対インデックスを使用）
        const paraxialImageZ = calculateParaxialImagePosition(opticalSystemRows, chiefRay, targetSurfaceIndex);
        if (paraxialImageZ === null) {
            if (verbose) console.warn(`      ⚠️ 近軸像点計算失敗`);
            return null;
        }
        
        if (verbose) console.log(`      📍 近軸像点Z位置: ${paraxialImageZ.toFixed(4)}mm`);
        
        // スポット表示モードでは非点収差計算をスキップ、通常モードでは計算
        let meridionalFocusZ = null;
        let sagittalFocusZ = null;
        let meridionalDeviation = null;
        let sagittalDeviation = null;
        
        if (!spotDiagramMode) {
            // 非点収差図モード: メリディオナル・サジタル焦点を計算
            if (verbose) console.log(`      🔄 メリディオナル・サジタル焦点計算中...`);
            
            const isAngleField = (fieldType === 'angle');

            meridionalFocusZ = traceMeridionalMarginalRay(
                opticalSystemRows,
                chiefRay,
                chiefRayResult,
                wavelength,
                stopSurfaceIndex,
                targetSurfaceIndex,
                imageSurfaceZ,  // Image面Z位置を基準として使用
                isAngleField
            );
            
            sagittalFocusZ = traceSagittalMarginalRay(
                opticalSystemRows,
                chiefRay,
                chiefRayResult,
                wavelength,
                stopSurfaceIndex,
                targetSurfaceIndex,
                imageSurfaceZ,  // Image面Z位置を基準として使用
                isAngleField
            );
            
            if (meridionalFocusZ !== null) {
                meridionalDeviation = meridionalFocusZ - paraxialImageZ;
                if (verbose) console.log(`      📍 メリディオナル焦点: Z=${meridionalFocusZ.toFixed(4)}mm (偏差=${meridionalDeviation.toFixed(4)}mm)`);
            }
            
            if (sagittalFocusZ !== null) {
                sagittalDeviation = sagittalFocusZ - paraxialImageZ;
                if (verbose) console.log(`      📍 サジタル焦点: Z=${sagittalFocusZ.toFixed(4)}mm (偏差=${sagittalDeviation.toFixed(4)}mm)`);
            }
        } else {
            if (verbose) console.log(`      ⏭️  メリディオナル・サジタル焦点計算をスキップ（スポット表示モード）`);
        }
        
        if (verbose) {
            console.log(`      📍 近軸像点: Z=${paraxialImageZ.toFixed(4)}mm`);
            console.log(`      📏 近軸像点からの差分: M=${meridionalDeviation}, S=${sagittalDeviation}`);
        }
        
        // 主波長の軸上像面位置を基準とした相対値に変換
        let meridionalDeviationRelative = meridionalDeviation;
        let sagittalDeviationRelative = sagittalDeviation;
        
        if (verbose) {
            console.log(`      🔍🔍🔍 primaryReferenceZ = ${primaryReferenceZ}`);
            console.log(`      🔍 meridionalFocusZ = ${meridionalFocusZ}, sagittalFocusZ = ${sagittalFocusZ}`);
        }
        
        if (primaryReferenceZ !== null) {
            // メリディオナル・サジタル焦点位置を主波長軸上位置からの相対値に変換
            if (meridionalFocusZ !== null) {
                meridionalDeviationRelative = meridionalFocusZ - primaryReferenceZ;
            }
            if (sagittalFocusZ !== null) {
                sagittalDeviationRelative = sagittalFocusZ - primaryReferenceZ;
            }
            if (verbose) console.log(`      📐 主波長軸上基準の相対値: M=${meridionalDeviationRelative?.toFixed(4)}mm, S=${sagittalDeviationRelative?.toFixed(4)}mm`);
        } else {
            if (verbose) console.warn(`      ⚠️⚠️⚠️ primaryReferenceZがnullのため相対値変換をスキップ ⚠️⚠️⚠️`);
        }
        
        // Draw Cross十字線データを取得（像面上のX, Y座標）
        let crossBeamIntersections = null;
        
        // 評価面（最終面）での実際のX, Y座標を使用（投影不要）
        if (verbose) console.log(`      🎯 評価面: Surface ${targetSurfaceIndex + 1} (Z=${opticalSystemRows[targetSurfaceIndex].z}mm)`);
        
        // chiefRayResult.rayGroupsから直接取得し、評価面での座標を取得
        if (chiefRayResult.rayGroups && chiefRayResult.rayGroups[0]) {
            const rayGroup = chiefRayResult.rayGroups[0];
            
            if (verbose) {
                console.log(`      🔍 rayGroup光線数: ${rayGroup.rays.length}`);
                console.log(`      🔍 rayGroup光線タイプ:`, rayGroup.rays.map(r => r.rayType));
            }
            
            const spotPositions = []; // {x, y, rayType}の配列
            
            // 評価面での実際のX, Y座標を取得
            rayGroup.rays.forEach(ray => {
                if (!ray.path || ray.path.length <= targetPointIndex) return;
                
                const segment = ray.path[targetPointIndex];
                const spotX = segment.x;
                const spotY = segment.y;
                
                if (spotX !== undefined && spotY !== undefined) {
                    const originalType = ray.originalRay?.type || '';
                    spotPositions.push({
                        x: spotX,
                        y: spotY,
                        rayType: ray.rayType,
                        originalType: originalType
                    });
                }
            });
            
            crossBeamIntersections = {
                spots: spotPositions
            };
            
            if (verbose) console.log(`      ✅ スポット位置データ取得: ${spotPositions.length}本`);
            
            if (verbose && spotPositions.length > 0) {
                const xCoords = spotPositions.map(s => s.x);
                const yCoords = spotPositions.map(s => s.y);
                const xMin = Math.min(...xCoords);
                const xMax = Math.max(...xCoords);
                const yMin = Math.min(...yCoords);
                const yMax = Math.max(...yCoords);
                console.log(`      🔍 スポット X範囲: ${xMin.toFixed(4)} ~ ${xMax.toFixed(4)}mm (幅=${(xMax - xMin).toFixed(4)}mm)`);
                console.log(`      🔍 スポット Y範囲: ${yMin.toFixed(4)} ~ ${yMax.toFixed(4)}mm (高さ=${(yMax - yMin).toFixed(4)}mm)`);
            }
        } else {
            if (verbose) console.warn(`      ⚠️ rayGroupsからのスポットデータ取得失敗`);
        }
        
        // データを返す（主波長軸上基準の相対値として保存）
        return {
            wavelength: wavelength,
            fieldAngle: fieldAngle,
            fieldName: fieldSetting.displayName,
            paraxialImageZ: paraxialImageZ,
            meridionalDeviation: meridionalDeviationRelative,  // 主波長軸上基準の相対値
            sagittalDeviation: sagittalDeviationRelative,      // 主波長軸上基準の相対値
            astigmaticDifference: null,
            crossBeamIntersections: crossBeamIntersections  // スポット位置データ
        };
        
    } catch (fieldError) {
        if (verbose) {
            console.error(`      ❌ フィールド ${fieldIndex + 1} (${fieldAngle}°) の計算エラー:`, fieldError);
            console.error(`      エラースタック:`, fieldError.stack);
        }
        return null;
    }
}
