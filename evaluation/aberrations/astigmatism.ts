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

import { calculateChiefRayNewton } from './transverse-aberration.ts';
import { getObjectRows, getSourceRows } from '../../utils/data-utils.ts';
import { traceRay, traceRayHitPoint, calculateSurfaceOrigins, solveRayOriginsToStopPointsWithRustMeta } from '../../raytracing/core/ray-tracing.ts';
import { asphericSurfaceZ } from '../../optical/surface.ts';

const RUST_RT_OPTIONS = Object.freeze({
    useRustWasm: true,
    requireRustWasm: true,
    allowNonStrict: true,
    requireForwardHit: false
});

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

function isGapRow(row) {
    if (!row || typeof row !== 'object') return false;
    const norm = (v) => String(v ?? '').trim().toLowerCase();
    const compact = (v) => norm(v).replace(/[\s_-]+/g, '');
    const surfType = norm(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const surfTypeCompact = compact(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
    const blockType = norm(row?._blockType ?? row?.blockType ?? '');
    const blockTypeCompact = compact(row?._blockType ?? row?.blockType ?? '');
    const kind = norm(row?.kind ?? '');
    const kindCompact = compact(row?.kind ?? '');
    return (
        surfType === 'gap' || surfType === 'air gap' || surfTypeCompact === 'gap' || surfTypeCompact === 'airgap' ||
        blockType === 'gap' || blockType === 'air gap' || blockTypeCompact === 'gap' || blockTypeCompact === 'airgap' ||
        kind === 'gap' || kind === 'air gap' || kindCompact === 'gap' || kindCompact === 'airgap'
    );
}

// traceRay の rayPath は Object 行 / Coord Break 行 / Gap 行を交点として記録しない。
// surfaceIndex(テーブル行) -> rayPath の point index への変換を行う。
function surfaceIndexToRayPathPointIndex(opticalSystemRows, surfaceIndex) {
    if (!Array.isArray(opticalSystemRows) || surfaceIndex === null || surfaceIndex === undefined) return null;
    const sIdx = Math.max(0, Math.min(surfaceIndex, opticalSystemRows.length - 1));
    let count = 0;
    for (let i = 0; i <= sIdx; i++) {
        const row = opticalSystemRows[i];
        if (isCoordTransRow(row)) continue;
        if (isObjectRow(row)) continue;
        if (isGapRow(row)) continue;
        count++;
    }
    return count > 0 ? count : null;
}

function normalize3(v) {
    if (!v) return null;
    const x = (v.x !== undefined) ? v.x : v.i;
    const y = (v.y !== undefined) ? v.y : v.j;
    const z = (v.z !== undefined) ? v.z : v.k;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    const mag = Math.hypot(x, y, z);
    if (!Number.isFinite(mag) || mag <= 1e-12) return null;
    return { x: x / mag, y: y / mag, z: z / mag };
}

function parseAngleInput(value) {
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().replace(',', '.');
        if (!normalized) return 0;
        const parsed = parseFloat(normalized);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

function crossProduct(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}

function buildDirectionFromFieldAngles(angleXDeg, angleYDeg) {
    const radX = parseAngleInput(angleXDeg) * Math.PI / 180;
    const radY = parseAngleInput(angleYDeg) * Math.PI / 180;
    const cosX = Math.cos(radX);
    const cosY = Math.cos(radY);
    const sinX = Math.sin(radX);
    const sinY = Math.sin(radY);
    return normalize3({
        x: sinX * cosY,
        y: sinY * cosX,
        z: cosX * cosY,
    });
}

function buildPerpendicularBasis(direction) {
    const dir = normalize3(direction);
    let reference = Math.abs(dir.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    let uAxis = crossProduct(reference, dir);
    if (Math.hypot(uAxis.x, uAxis.y, uAxis.z) < 1e-12) {
        reference = { x: 1, y: 0, z: 0 };
        uAxis = crossProduct(reference, dir);
    }
    const u = normalize3(uAxis);
    const v = normalize3(crossProduct(dir, u));
    return { dir, u, v };
}

/**
 * 主光線モードに応じて主光線を調整
 * @param {Object} chiefRay - 絞り中心を通る主光線データ
 * @param {Object} rayGroup - 光線グループ（全光線データ）
 * @param {number} targetSurfaceIndex - 評価面インデックス
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {string} mode - 'stopCenter' | 'beamCenter' | 'centroid' | '*Image'
 * @param {boolean} verbose - 詳細ログ
 * @returns {Object|null} 調整後の主光線データ
 */
function adjustChiefRayByMode(chiefRay, rayGroup, targetSurfaceIndex, opticalSystemRows, mode, verbose = false, imageSurfaceInfo = null) {
    const useImagePlane = typeof mode === 'string' && mode.endsWith('Image');
    const baseMode = useImagePlane ? mode.slice(0, -'Image'.length) : mode;
    if (baseMode === 'stopCenter') return chiefRay; // 変更なし
    
    const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (rawTargetPointIndex === null) return chiefRay;
    
    const targetPointIndex = Math.min(rawTargetPointIndex, chiefRay.segments.length - 1);
    
    const toLocal = (point) => {
        if (!useImagePlane || !imageSurfaceInfo?.origin || !imageSurfaceInfo?.rotationMatrix) return point;
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

    const toGlobalDelta = (delta) => {
        if (!useImagePlane || !imageSurfaceInfo?.rotationMatrix) return delta;
        const R = imageSurfaceInfo.rotationMatrix;
        return {
            x: R[0][0] * delta.x + R[0][1] * delta.y + R[0][2] * delta.z,
            y: R[1][0] * delta.x + R[1][1] * delta.y + R[1][2] * delta.z,
            z: R[2][0] * delta.x + R[2][1] * delta.y + R[2][2] * delta.z
        };
    };

    // 像面上での全光線の位置を収集
    const rays = rayGroup.rays || [];
    const positions = [];
    
    for (const ray of rays) {
        if (!ray.path || ray.path.length <= targetPointIndex) continue;
        const point = ray.path[targetPointIndex];
        if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) {
            const localPoint = toLocal(point);
            positions.push({ x: localPoint.x, y: localPoint.y, z: localPoint.z });
        }
    }
    
    if (positions.length === 0) {
        if (verbose) console.warn('      ⚠️ 像面上の光線位置データなし');
        return chiefRay;
    }
    
    let referenceX = 0;
    let referenceY = 0;
    
    if (baseMode === 'beamCenter') {
        // 光束巾の真ん中：X, Y方向の最小～最大の中点
        const xValues = positions.map(p => p.x);
        const yValues = positions.map(p => p.y);
        const xMin = Math.min(...xValues);
        const xMax = Math.max(...xValues);
        const yMin = Math.min(...yValues);
        const yMax = Math.max(...yValues);
        
        referenceX = (xMin + xMax) / 2;
        referenceY = (yMin + yMax) / 2;
        
    } else if (baseMode === 'centroid') {
        // 光束の重心：全光線の平均位置
        referenceX = positions.reduce((sum, p) => sum + p.x, 0) / positions.length;
        referenceY = positions.reduce((sum, p) => sum + p.y, 0) / positions.length;
        
    }
    
    // 元の主光線の像面上位置
    const originalPoint = chiefRay.segments[targetPointIndex];
    const localOriginal = toLocal(originalPoint);
    const offsetX = referenceX - localOriginal.x;
    const offsetY = referenceY - localOriginal.y;
    
    // 主光線の全セグメントをオフセット（像面上の位置を基準位置に合わせる）
    const deltaGlobal = toGlobalDelta({ x: offsetX, y: offsetY, z: 0 });
    const adjustedSegments = chiefRay.segments.map(seg => ({
        ...seg,
        x: seg.x + deltaGlobal.x,
        y: seg.y + deltaGlobal.y,
        z: seg.z + deltaGlobal.z
    }));
    
    return {
        ...chiefRay,
        segments: adjustedSegments
    };
}

function traceRayPathWrapped(opticalSystemRows, ray0, targetSurfaceIndex, options = RUST_RT_OPTIONS) {
    try {
        const rayPath = traceRay(opticalSystemRows, ray0, 1.0, null, targetSurfaceIndex, options || RUST_RT_OPTIONS);
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
            stopSurfaceIndex,
            RUST_RT_OPTIONS
        );
        if (!p || Array.isArray(p)) return null;
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
            stopSurfaceIndex,
            RUST_RT_OPTIONS
        );
        const py = traceRayHitPoint(
            opticalSystemRows,
            { pos: origin, dir: normalize3({ x: dir.x, y: dir.y + eps, z: dir.z }) || dir, wavelength },
            1.0,
            stopSurfaceIndex,
            RUST_RT_OPTIONS
        );
        if (!px || Array.isArray(px) || !py || Array.isArray(py)) return null;

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
            stopSurfaceIndex,
            RUST_RT_OPTIONS
        );
        if (!p || Array.isArray(p)) return null;
        const err = { x: stopTarget.x - p.x, y: stopTarget.y - p.y, z: stopTarget.z - p.z };
        const errNorm = Math.hypot(err.x, err.y, err.z);
        if (!Number.isFinite(errNorm)) return null;
        if (errNorm < 1e-6) return origin;

        const px = traceRayHitPoint(
            opticalSystemRows,
            { pos: { x: origin.x + eps, y: origin.y, z: origin.z }, dir, wavelength },
            1.0,
            stopSurfaceIndex,
            RUST_RT_OPTIONS
        );
        const py = traceRayHitPoint(
            opticalSystemRows,
            { pos: { x: origin.x, y: origin.y + eps, z: origin.z }, dir, wavelength },
            1.0,
            stopSurfaceIndex,
            RUST_RT_OPTIONS
        );
        if (!px || Array.isArray(px) || !py || Array.isArray(py)) return null;

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
        const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
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

function cross3(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}

function extractRayStartAndDirection(ray) {
    const original = ray?.originalRay || {};
    const start = original.pos || original.position || ray?.startP || ray?.start_p || ray?.path?.[0] || null;
    let dir = original.dir || original.direction || ray?.dir || ray?.direction || null;

    if ((!dir || !Number.isFinite(dir.x) || !Number.isFinite(dir.y) || !Number.isFinite(dir.z)) && Array.isArray(ray?.path) && ray.path.length >= 2) {
        const p0 = ray.path[0];
        const p1 = ray.path[1];
        dir = {
            x: p1.x - p0.x,
            y: p1.y - p0.y,
            z: p1.z - p0.z,
        };
    }

    if (!start || !dir) return null;
    if (!Number.isFinite(start.x) || !Number.isFinite(start.y) || !Number.isFinite(start.z)) return null;
    const normalizedDir = normalize3(dir);
    if (!normalizedDir) return null;

    return {
        start: { x: start.x, y: start.y, z: start.z },
        dir: normalizedDir,
    };
}

function intersectRayWithPlane(start, dir, planeCenter, planeNormal) {
    const denom = dir.x * planeNormal.x + dir.y * planeNormal.y + dir.z * planeNormal.z;
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return null;

    const vx = planeCenter.x - start.x;
    const vy = planeCenter.y - start.y;
    const vz = planeCenter.z - start.z;
    const t = (vx * planeNormal.x + vy * planeNormal.y + vz * planeNormal.z) / denom;
    if (!Number.isFinite(t)) return null;

    return {
        x: start.x + t * dir.x,
        y: start.y + t * dir.y,
        z: start.z + t * dir.z,
    };
}

function selectAxisFanRaysFromExistingRays(rays, chiefRayEntry, meridional, desiredCount) {
    const chief = extractRayStartAndDirection(chiefRayEntry);
    if (!chief) return [];

    const collect = (strictRatio) => {
        const out = [];
        for (const ray of rays || []) {
            if (!ray || ray === chiefRayEntry || String(ray?.rayType || '').toLowerCase() === 'chief') continue;
            const current = extractRayStartAndDirection(ray);
            if (!current) continue;

            const offX = current.start.x - chief.start.x;
            const offY = current.start.y - chief.start.y;
            const primary = meridional ? Math.abs(offY) : Math.abs(offX);
            const secondary = meridional ? Math.abs(offX) : Math.abs(offY);
            if (!Number.isFinite(primary) || primary < 1e-8) continue;

            const ratio = secondary / primary;
            if (!Number.isFinite(ratio) || ratio > strictRatio) continue;
            out.push({ metric: primary, ray });
        }
        return out;
    };

    let candidates = collect(0.35);
    if (candidates.length < 5) {
        candidates = collect(1.0);
    }
    if (candidates.length === 0) return [];

    candidates.sort((a, b) => a.metric - b.metric);
    const takeCount = Math.max(3, Math.min(desiredCount, candidates.length));
    if (takeCount >= candidates.length) return candidates.map(item => item.ray);

    const out = [];
    for (let i = 0; i < takeCount; i++) {
        const idx = Math.round(i * (candidates.length - 1) / (takeCount - 1));
        out.push(candidates[idx].ray);
    }
    return out;
}

function selectAxisFanRaysByStopPlane(rays, chiefRayEntry, meridional, desiredCount, stopCenter, stopPlaneU, stopPlaneV) {
    const stopNormal = normalize3(cross3(stopPlaneU, stopPlaneV));
    if (!stopNormal) {
        return selectAxisFanRaysFromExistingRays(rays, chiefRayEntry, meridional, desiredCount);
    }

    const chief = extractRayStartAndDirection(chiefRayEntry);
    if (!chief) {
        return selectAxisFanRaysFromExistingRays(rays, chiefRayEntry, meridional, desiredCount);
    }

    const chiefPoint = intersectRayWithPlane(chief.start, chief.dir, stopCenter, stopNormal);
    if (!chiefPoint) {
        return selectAxisFanRaysFromExistingRays(rays, chiefRayEntry, meridional, desiredCount);
    }

    const extractCandidates = (strictRatio) => {
        const out = [];
        for (const ray of rays || []) {
            if (!ray || ray === chiefRayEntry || String(ray?.rayType || '').toLowerCase() === 'chief') continue;
            const current = extractRayStartAndDirection(ray);
            if (!current) continue;

            const point = intersectRayWithPlane(current.start, current.dir, stopCenter, stopNormal);
            if (!point) continue;

            const rel = {
                x: point.x - chiefPoint.x,
                y: point.y - chiefPoint.y,
                z: point.z - chiefPoint.z,
            };
            const du = rel.x * stopPlaneU.x + rel.y * stopPlaneU.y + rel.z * stopPlaneU.z;
            const dv = rel.x * stopPlaneV.x + rel.y * stopPlaneV.y + rel.z * stopPlaneV.z;
            const primary = meridional ? dv : du;
            const secondary = meridional ? Math.abs(du) : Math.abs(dv);
            const primaryAbs = Math.abs(primary);
            if (!Number.isFinite(primaryAbs) || primaryAbs < 1e-8) continue;

            const ratio = secondary / primaryAbs;
            if (!Number.isFinite(ratio) || ratio > strictRatio) continue;
            out.push({ metric: primary, ray });
        }
        return out;
    };

    let candidates = extractCandidates(0.35);
    if (candidates.length < 5) {
        candidates = extractCandidates(0.8);
    }
    if (candidates.length < 5) {
        return selectAxisFanRaysFromExistingRays(rays, chiefRayEntry, meridional, desiredCount);
    }

    candidates.sort((a, b) => a.metric - b.metric);
    const takeCount = Math.max(3, Math.min(desiredCount, candidates.length));
    if (takeCount >= candidates.length) return candidates.map(item => item.ray);

    const out = [];
    for (let i = 0; i < takeCount; i++) {
        const idx = Math.round(i * (candidates.length - 1) / (takeCount - 1));
        out.push(candidates[idx].ray);
    }
    return out;
}

function selectAxisRaysFromSuccessfulByStopPlane(successfulRays, chiefRayEntry, meridional, desiredCount, stopCenter, stopPlaneU, stopPlaneV) {
    if (!Array.isArray(successfulRays) || successfulRays.length === 0) return [];

    const stopNormal = normalize3(cross3(stopPlaneU, stopPlaneV));
    if (!stopNormal) return [];

    const chief = extractRayStartAndDirection(chiefRayEntry);
    if (!chief) return [];
    const chiefPoint = intersectRayWithPlane(chief.start, chief.dir, stopCenter, stopNormal);
    if (!chiefPoint) return [];

    const strict = [];
    const relaxed = [];

    for (const ray of successfulRays) {
        const current = extractRayStartAndDirection(ray);
        if (!current) continue;

        const point = intersectRayWithPlane(current.start, current.dir, stopCenter, stopNormal);
        if (!point) continue;

        const rel = {
            x: point.x - chiefPoint.x,
            y: point.y - chiefPoint.y,
            z: point.z - chiefPoint.z,
        };
        const du = rel.x * stopPlaneU.x + rel.y * stopPlaneU.y + rel.z * stopPlaneU.z;
        const dv = rel.x * stopPlaneV.x + rel.y * stopPlaneV.y + rel.z * stopPlaneV.z;
        const primary = meridional ? dv : du;
        const secondaryAbs = meridional ? Math.abs(du) : Math.abs(dv);
        const primaryAbs = Math.abs(primary);
        if (!Number.isFinite(primaryAbs) || primaryAbs < 1e-8) continue;

        const ratio = secondaryAbs / primaryAbs;
        if (!Number.isFinite(ratio)) continue;

        const item = { metric: primary, ray };
        if (ratio <= 0.8) strict.push(item);
        relaxed.push(item);
    }

    const candidates = (strict.length >= 3) ? strict : relaxed;
    if (candidates.length === 0) return [];

    candidates.sort((a, b) => a.metric - b.metric);
    const takeCount = Math.max(3, Math.min(desiredCount, candidates.length));
    if (takeCount >= candidates.length) return candidates.map(item => item.ray);

    const out = [];
    for (let i = 0; i < takeCount; i++) {
        const idx = Math.round(i * (candidates.length - 1) / (takeCount - 1));
        out.push(candidates[idx].ray);
    }
    return out;
}

function buildStopSolveRayFan(
    opticalSystemRows,
    chiefRayResult,
    wavelength,
    stopSurfaceIndex,
    targetSurfaceIndex,
    targetPointIndex,
    axis /* 'meridional'|'sagittal' */,
    isAngleField = false,
    samplingPattern = 'annular',
    ringCount = 10,
    rayCount = 30
) {
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

    const normalizedPattern = (() => {
        const p = String(samplingPattern || '').trim().toLowerCase();
        return (p === 'cross' || p === 'grid' || p === 'annular') ? p : 'annular';
    })();
    const normalizedRingCount = Number.isFinite(Number(ringCount))
        ? Math.max(1, Math.min(64, Math.round(Number(ringCount))))
        : 10;
    const normalizedRayCount = Number.isFinite(Number(rayCount))
        ? Math.max(9, Math.min(2001, Math.round(Number(rayCount))))
        : 30;

    const sampleOffsets = (() => {
        if (normalizedPattern === 'cross') {
            return [-1, -0.5, 0, 0.5, 1];
        }
        if (normalizedPattern === 'grid') {
            const n = Math.max(9, Math.min(101, (normalizedRayCount % 2 === 0) ? (normalizedRayCount + 1) : normalizedRayCount));
            const out = [];
            for (let i = 0; i < n; i++) {
                out.push(-1 + (2 * i) / (n - 1));
            }
            return out;
        }
        const rings = Math.max(1, normalizedRingCount);
        const out = [];
        for (let r = 1; r <= rings; r++) {
            const radius = r / rings;
            out.push(-radius);
            out.push(radius);
        }
        return out;
    })();

    const fan = [];

    if (isInfinite) {
        const dir = normalize3(dirBase) || { x: 0, y: 0, z: 1 };
        const initialOrigins = [];
        const dirVectors = [];
        const stopTargets = [];
        const guessOrigins = [];

        for (let i = 0; i < sampleOffsets.length; i++) {
            const pNorm = sampleOffsets[i];
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
            initialOrigins.push(guess);
            dirVectors.push(dir);
            stopTargets.push(stopTarget);
            guessOrigins.push(guess);
        }

        const rustSolvedOrigins = solveRayOriginsToStopPointsWithRustMeta(
            opticalSystemRows,
            initialOrigins,
            dirVectors,
            stopTargets,
            stopSurfaceIndex,
            wavelength,
            {
                ...RUST_RT_OPTIONS,
                maxIter: 18,
                tolMm: 1e-6,
                eps: 1e-4,
                maxStep: 5.0
            }
        );

        for (let i = 0; i < sampleOffsets.length; i++) {
            const stopTarget = stopTargets[i];
            const guess = guessOrigins[i];

            let origin = guess;
            const rustOrigin = Array.isArray(rustSolvedOrigins) ? rustSolvedOrigins[i] : null;
            if (rustOrigin && Number.isFinite(rustOrigin.x) && Number.isFinite(rustOrigin.y) && Number.isFinite(rustOrigin.z)) {
                origin = { x: rustOrigin.x, y: rustOrigin.y, z: rustOrigin.z };
            } else {
                const refined = solveRayOriginToStopPointFast(guess, dir, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength);
                origin = refined || guess;
            }

            const traced = traceRayPathWrapped(opticalSystemRows, { pos: origin, dir, wavelength }, targetSurfaceIndex, RUST_RT_OPTIONS);
            if (!traced.success || !traced.rayPath || traced.rayPath.length <= targetPointIndex) continue;
            fan.push({ segments: traced.rayPath, type: `${axis}_stop_solve`, dir,
                originalRay: { pos: { ...origin }, dir: { ...dir }, wavelength } });
        }
        return fan;
    }

    for (let i = 0; i < sampleOffsets.length; i++) {
        const pNorm = sampleOffsets[i];
        const offset = pNorm * stopSolveMax;
        const stopTarget = {
            x: stopPlaneCenter3d.x + axisVec.x * offset,
            y: stopPlaneCenter3d.y + axisVec.y * offset,
            z: stopPlaneCenter3d.z + axisVec.z * offset
        };
        const solvedDir = solveRayDirectionToStopPointFast(originBase, stopTarget, stopSurfaceIndex, opticalSystemRows, wavelength);
        if (!solvedDir) continue;
        const traced = traceRayPathWrapped(opticalSystemRows, { pos: originBase, dir: solvedDir, wavelength }, targetSurfaceIndex, RUST_RT_OPTIONS);
        if (!traced.success || !traced.rayPath || traced.rayPath.length <= targetPointIndex) continue;
        fan.push({ segments: traced.rayPath, type: `${axis}_stop_solve`, dir: solvedDir,
            originalRay: { pos: { ...originBase }, dir: { ...solvedDir }, wavelength } });
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
function calculateParaxialImagePosition(opticalSystemRows, chiefRay, targetSurfaceIndex, imageSurfaceInfo) {
    if (!chiefRay || !chiefRay.segments || chiefRay.segments.length === 0) {
        console.warn('      ⚠️ calculateParaxialImagePosition: 主光線データが不正です');
        return null;
    }

    const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (rawTargetPointIndex === null) {
        console.warn(`      ⚠️ calculateParaxialImagePosition: targetSurfaceIndex=${targetSurfaceIndex}の変換に失敗しました`);
        return null;
    }
    const targetPointIndex = Math.min(rawTargetPointIndex, chiefRay.segments.length - 1);
    
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
    const paraxialZ = findAxisIntersection(opticalSystemRows, chiefRay, targetSurfaceIndex, imageSurfaceInfo, chiefRay?.dir || null);
    
    if (paraxialZ === null) {
        console.warn('      ⚠️ calculateParaxialImagePosition: 主光線の焦点計算に失敗 → 評価面Zで代用');
        const fallbackZ = chiefRay.segments[targetPointIndex]?.z;
        if (fallbackZ === undefined || fallbackZ === null) return null;
        return fallbackZ;
    }

    return paraxialZ;
}

/**
 * 光線と光軸の交点を計算（Z軸との交点）
 * @param {Object} rayData - 光線データ
 * @param {number} targetSurfaceIndex - 評価面のインデックス
 * @returns {number|null} Z座標（像面位置）
 */
function findAxisIntersection(opticalSystemRows, rayData, targetSurfaceIndex, imageSurfaceInfo, rayDirection = null) {
    if (!rayData || !rayData.segments || rayData.segments.length === 0) {
        console.warn('      ⚠️ findAxisIntersection: rayDataが不正です');
        return null;
    }

    const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (rawTargetPointIndex === null) {
        console.warn(`      ⚠️ findAxisIntersection: targetSurfaceIndex=${targetSurfaceIndex}の変換に失敗しました`);
        return null;
    }

    const targetPointIndex = Math.min(rawTargetPointIndex, rayData.segments.length - 1);
    const targetSegment = rayData.segments[targetPointIndex];
    if (!targetSegment) {
        console.warn(`      ⚠️ findAxisIntersection: targetPointIndex=${targetPointIndex}のデータがありません`);
        return null;
    }
    
    // 方向ベクトルを計算（次の点、または前の点との差分）
    let nextSegment;
    const nextIndex = targetPointIndex + 1;
    if (nextIndex < rayData.segments.length) {
        nextSegment = rayData.segments[nextIndex];
    } else if (rayDirection && Number.isFinite(rayDirection.x) && Number.isFinite(rayDirection.y) && Number.isFinite(rayDirection.z)) {
        nextSegment = {
            x: targetSegment.x + rayDirection.x,
            y: targetSegment.y + rayDirection.y,
            z: targetSegment.z + rayDirection.z
        };
    } else {
        console.warn(`      ⚠️ findAxisIntersection: 次セグメントがないため方向ベクトル計算不可`);
        return null;
    }

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

    const segLocal = toLocal(targetSegment);
    const nextLocal = toLocal(nextSegment);
    const dx = nextLocal.x - segLocal.x;
    const dy = nextLocal.y - segLocal.y;
    const dz = nextLocal.z - segLocal.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-12) {
        console.warn('      ⚠️ findAxisIntersection: 方向ベクトルが計算できません');
        return null;
    }

    const numerator = -(segLocal.x * dx + segLocal.y * dy);
    const denominator = dx * dx + dy * dy;
    if (Math.abs(denominator) < 1e-12) {
        return segLocal.z;
    }
    const t = numerator / denominator;
    const intersectionZ = segLocal.z + dz * t;

    return intersectionZ;
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

function buildTargetHitForFocusSearch(rayData, opticalSystemRows, targetSurfaceIndex, imageSurfaceInfo, rayDirection = null) {
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

    const toLocalDelta = (vector) => {
        if (!imageSurfaceInfo || !imageSurfaceInfo.rotationMatrix) return vector;
        const R = imageSurfaceInfo.rotationMatrix;
        return {
            x: R[0][0] * vector.x + R[1][0] * vector.y + R[2][0] * vector.z,
            y: R[0][1] * vector.x + R[1][1] * vector.y + R[2][1] * vector.z,
            z: R[0][2] * vector.x + R[1][2] * vector.y + R[2][2] * vector.z
        };
    };

    const originalRay = rayData?.originalRay && rayData?.originalRay?.pos && rayData?.originalRay?.dir
        ? {
            pos: { ...rayData.originalRay.pos },
            dir: { ...rayData.originalRay.dir },
            wavelength: Number(rayData?.originalRay?.wavelength ?? rayData?.wavelength)
        }
        : null;

    if (originalRay && Number.isFinite(originalRay.wavelength)) {
        const directHit = traceRayHitPoint(
            opticalSystemRows,
            originalRay,
            1.0,
            targetSurfaceIndex,
            { ...RUST_RT_OPTIONS, __returnHitDirection: true }
        );
        if (directHit && Number.isFinite(directHit.x) && Number.isFinite(directHit.y) && Number.isFinite(directHit.z) &&
            Number.isFinite(directHit.dx) && Number.isFinite(directHit.dy) && Number.isFinite(directHit.dz)) {
            const targetLocal = toLocal({ x: directHit.x, y: directHit.y, z: directHit.z });
            const dirLocal = toLocalDelta({ x: directHit.dx, y: directHit.dy, z: directHit.dz });
            if (Number.isFinite(targetLocal.x) && Number.isFinite(targetLocal.y) && Number.isFinite(targetLocal.z) &&
                Number.isFinite(dirLocal.x) && Number.isFinite(dirLocal.y) && Number.isFinite(dirLocal.z)) {
                return {
                    hx: targetLocal.x,
                    hy: targetLocal.y,
                    hz: targetLocal.z,
                    dx: dirLocal.x,
                    dy: dirLocal.y,
                    dz: dirLocal.z,
                };
            }
        }
    }

    if (!rayData || !Array.isArray(rayData.segments) || rayData.segments.length === 0) {
        return null;
    }

    const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (rawTargetPointIndex === null) {
        return null;
    }

    const targetPointIndex = Math.min(rawTargetPointIndex, rayData.segments.length - 1);
    const targetSegment = rayData.segments[targetPointIndex];
    if (!targetSegment) {
        return null;
    }

    let nextSegment;
    if (targetPointIndex + 1 < rayData.segments.length) {
        nextSegment = rayData.segments[targetPointIndex + 1];
    } else if (targetPointIndex >= 1) {
        const prevSegment = rayData.segments[targetPointIndex - 1];
        const ddx = targetSegment.x - prevSegment.x;
        const ddy = targetSegment.y - prevSegment.y;
        const ddz = targetSegment.z - prevSegment.z;
        const len = Math.hypot(ddx, ddy, ddz);
        if (len < 1e-12) return null;
        nextSegment = {
            x: targetSegment.x + ddx / len,
            y: targetSegment.y + ddy / len,
            z: targetSegment.z + ddz / len
        };
    } else if (rayDirection && Number.isFinite(rayDirection.x) && Number.isFinite(rayDirection.y) && Number.isFinite(rayDirection.z)) {
        nextSegment = {
            x: targetSegment.x + rayDirection.x,
            y: targetSegment.y + rayDirection.y,
            z: targetSegment.z + rayDirection.z
        };
    } else {
        return null;
    }

    const targetLocal = toLocal(targetSegment);
    const nextLocal = toLocal(nextSegment);
    const dx = nextLocal.x - targetLocal.x;
    const dy = nextLocal.y - targetLocal.y;
    const dz = nextLocal.z - targetLocal.z;

    if (!Number.isFinite(targetLocal.x) || !Number.isFinite(targetLocal.y) || !Number.isFinite(targetLocal.z) ||
        !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) {
        return null;
    }

    return {
        hx: targetLocal.x,
        hy: targetLocal.y,
        hz: targetLocal.z,
        dx,
        dy,
        dz,
    };
}

function projectHitToZForFocusSearch(hit, targetZ) {
    if (!hit || !Number.isFinite(hit.dz) || Math.abs(hit.dz) < 1e-12) {
        return null;
    }
    const t = (targetZ - hit.hz) / hit.dz;
    const x = hit.hx + t * hit.dx;
    const y = hit.hy + t * hit.dy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    return { x, y };
}

function calculateRMSAtZFromHitsNativeLike(fanHits, chiefHit, targetZ, meridional) {
    const chiefAtZ = projectHitToZForFocusSearch(chiefHit, targetZ);
    if (!chiefAtZ) return null;

    const deviations = [];
    for (const hit of fanHits) {
        const pointAtZ = projectHitToZForFocusSearch(hit, targetZ);
        if (!pointAtZ) continue;
        const dev = meridional ? (pointAtZ.y - chiefAtZ.y) : (pointAtZ.x - chiefAtZ.x);
        if (Number.isFinite(dev)) deviations.push(dev);
    }

    if (deviations.length === 0) {
        return null;
    }

    const sumSq = deviations.reduce((sum, value) => sum + value * value, 0);
    return Math.sqrt(sumSq / deviations.length);
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
function calculateRMSAtZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, targetZ, direction, imageSurfaceInfo, chiefRayDirection = null) {
    const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (rawTargetPointIndex === null) return null;

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

    // 主光線の評価面での位置と方向
    const chiefTargetIndex = Math.min(rawTargetPointIndex, chiefRay.segments.length - 1);
    const chiefSegment = chiefRay.segments[chiefTargetIndex];
    const chiefNextIndex = chiefTargetIndex + 1;
    
    if (!chiefSegment) {
        return null;
    }
    
    // 主光線の方向ベクトルを計算
    // NOTE: native Rust uses the outgoing direction AT the target surface (stored by
    // trace_target_with_packed_native as hit[5..7]).  For a flat image-surface det,
    // that equals the incoming direction, i.e. segments[targetIdx] - segments[targetIdx-1].
    // Using the *initial* ray.dir (entrance direction) here produces wrong extrapolation
    // at high field angles and is the main cause of discontinuous M/S curves.
    let chiefNextSegment;
    if (chiefNextIndex < chiefRay.segments.length) {
        chiefNextSegment = chiefRay.segments[chiefNextIndex];
    } else if (chiefTargetIndex >= 1) {
        // Use the direction the chief ray was traveling just before the image surface.
        const prev = chiefRay.segments[chiefTargetIndex - 1];
        const ddx = chiefSegment.x - prev.x;
        const ddy = chiefSegment.y - prev.y;
        const ddz = chiefSegment.z - prev.z;
        const len = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (len < 1e-12) return null;
        chiefNextSegment = {
            x: chiefSegment.x + ddx / len,
            y: chiefSegment.y + ddy / len,
            z: chiefSegment.z + ddz / len
        };
    } else if (chiefRayDirection && Number.isFinite(chiefRayDirection.x) && Number.isFinite(chiefRayDirection.y) && Number.isFinite(chiefRayDirection.z)) {
        chiefNextSegment = {
            x: chiefSegment.x + chiefRayDirection.x,
            y: chiefSegment.y + chiefRayDirection.y,
            z: chiefSegment.z + chiefRayDirection.z
        };
    } else {
        return null;
    }
    
    // 主光線のtargetZでの位置を計算
    const chiefAtZ = projectRayToZ(toLocal(chiefSegment), toLocal(chiefNextSegment), targetZ);
    if (!chiefAtZ) {
        return null;
    }
    
    // 各光線のtargetZでの位置を計算し、主光線との偏差を求める
    const deviations = [];
    
    for (const ray of rayFan) {
        if (!ray || !ray.segments || ray.segments.length === 0) {
            continue; // ケラレなどで到達していない光線はスキップ
        }
        const rayTargetIndex = Math.min(rawTargetPointIndex, ray.segments.length - 1);
        const segment = ray.segments[rayTargetIndex];
        
        // 光線の方向ベクトルを計算
        // Prefer segments[i+1] (outgoing), then segments[i]-segments[i-1] (incoming ≈ outgoing
        // for flat image surface), finally ray.dir as last resort.  Never use initial-direction
        // ray.dir as a substitute for the exit direction at the image surface.
        let nextSegment;
        if (rayTargetIndex + 1 < ray.segments.length) {
            nextSegment = ray.segments[rayTargetIndex + 1];
        } else if (rayTargetIndex >= 1) {
            const prevSeg = ray.segments[rayTargetIndex - 1];
            const ddx = segment.x - prevSeg.x;
            const ddy = segment.y - prevSeg.y;
            const ddz = segment.z - prevSeg.z;
            const len = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
            if (len < 1e-12) continue;
            nextSegment = {
                x: segment.x + ddx / len,
                y: segment.y + ddy / len,
                z: segment.z + ddz / len
            };
        } else if (ray.dir && Number.isFinite(ray.dir.x) && Number.isFinite(ray.dir.y) && Number.isFinite(ray.dir.z)) {
            nextSegment = {
                x: segment.x + ray.dir.x,
                y: segment.y + ray.dir.y,
                z: segment.z + ray.dir.z
            };
        } else {
            continue;
        }
        
        const rayAtZ = projectRayToZ(toLocal(segment), toLocal(nextSegment), targetZ);
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
function findBestFocusZ(rayFan, chiefRay, opticalSystemRows, targetSurfaceIndex, referenceZ, direction, imageSurfaceInfo, chiefRayDirection = null) {
    if (!Array.isArray(rayFan) || rayFan.length < 3) {
        return null;
    }

    const meridional = direction === 'meridional';
    const chiefHit = buildTargetHitForFocusSearch(
        chiefRay,
        opticalSystemRows,
        targetSurfaceIndex,
        imageSurfaceInfo,
        chiefRayDirection
    );
    if (!chiefHit) {
        return null;
    }

    const fanHits = [];
    for (const ray of rayFan) {
        const hit = buildTargetHitForFocusSearch(
            ray,
            opticalSystemRows,
            targetSurfaceIndex,
            imageSurfaceInfo,
            ray?.dir || null
        );
        if (hit) fanHits.push(hit);
    }
    if (fanHits.length < 3) {
        return null;
    }

    const searchRange = 10.0;
    let zMin = referenceZ - searchRange;
    let zMax = referenceZ + searchRange;

    const coarseSamples = [];
    const coarseSampleCount = 41;
    let bestZ = referenceZ;
    let bestRms = Infinity;

    for (let index = 0; index < coarseSampleCount; index++) {
        const z = zMin + (zMax - zMin) * index / (coarseSampleCount - 1);
        const rms = calculateRMSAtZFromHitsNativeLike(fanHits, chiefHit, z, meridional);
        if (rms !== null) {
            coarseSamples.push([z, rms]);
            if (rms < bestRms) {
                bestRms = rms;
                bestZ = z;
            }
        }
    }

    if (!Number.isFinite(bestRms) || coarseSamples.length < 3) {
        return null;
    }

    coarseSamples.sort((left, right) => left[0] - right[0]);
    const bestIndex = coarseSamples.findIndex(([z]) => Math.abs(z - bestZ) < 1e-12);
    const leftIndex = Math.max(0, bestIndex >= 0 ? bestIndex - 2 : 0);
    const rightIndex = Math.min(coarseSamples.length - 1, (bestIndex >= 0 ? bestIndex + 2 : 0));
    zMin = coarseSamples[leftIndex][0];
    zMax = coarseSamples[rightIndex][0];

    const tolerance = 1e-3;
    const maxIterations = 30;
    const phi = (1 + Math.sqrt(5)) * 0.5;
    const resphi = 2 - phi;

    let a = zMin;
    let b = zMax;
    let x1 = a + resphi * (b - a);
    let x2 = b - resphi * (b - a);
    let f1 = calculateRMSAtZFromHitsNativeLike(fanHits, chiefHit, x1, meridional);
    let f2 = calculateRMSAtZFromHitsNativeLike(fanHits, chiefHit, x2, meridional);
    if (f1 === null || f2 === null) {
        return null;
    }

    let iteration = 0;
    while (iteration < maxIterations && (b - a) > tolerance) {
        if (f1 < f2) {
            b = x2;
            x2 = x1;
            f2 = f1;
            x1 = a + resphi * (b - a);
            f1 = calculateRMSAtZFromHitsNativeLike(fanHits, chiefHit, x1, meridional);
            if (f1 === null) break;
        } else {
            a = x1;
            x1 = x2;
            f1 = f2;
            x2 = b - resphi * (b - a);
            f2 = calculateRMSAtZFromHitsNativeLike(fanHits, chiefHit, x2, meridional);
            if (f2 === null) break;
        }
        iteration += 1;
    }

    return (a + b) * 0.5;
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
    imageSurfaceInfo,
    isAngleField = false,
    samplingPattern = 'annular',
    ringCount = 10,
    rayCount = 30
) {
    try {
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
        const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
        if (rawTargetPointIndex === null) {
            console.warn('      ⚠️ メリディオナル: targetSurfaceIndex変換失敗');
            return null;
        }
        
        // CTがあると実際の光線セグメント数より大きい値になるのでクランプ
        const targetPointIndex = Math.min(rawTargetPointIndex, chiefRay.segments.length - 1);

        const rayFan = [];
        const chiefRayEntry = rayGroup.rays.find(r => (r?.rayType || '').toLowerCase() === 'chief') || null;
        const axisFanTarget = samplingPattern === 'cross'
            ? Math.max(25, Math.min(401, rayCount - 1))
            : Math.max(25, Math.min(401, Math.round(Math.sqrt(rayCount) * 3)));

        if (chiefRayEntry) {
            const { stopPlaneCenter3d, stopPlaneU, stopPlaneV } = computeStopPlaneFrame(opticalSystemRows, stopSurfaceIndex);
            if (stopPlaneCenter3d) {
                const selectedRays = selectAxisFanRaysByStopPlane(
                    rayGroup.rays,
                    chiefRayEntry,
                    true,
                    axisFanTarget,
                    stopPlaneCenter3d,
                    stopPlaneU,
                    stopPlaneV
                );
                for (const ray of selectedRays) {
                    if (ray?.path && ray.path.length > targetPointIndex) {
                        rayFan.push({
                            segments: ray.path,
                            dir: extractRayStartAndDirection(ray)?.dir || ray.dir || null,
                            type: ray.rayType || 'meridional_selected',
                            originalRay: ray.originalRay || null,
                            wavelength: ray.wavelength
                        });
                    }
                }
            }
        }
        
        const minAxisHitsForRms = 5;
        if (rayFan.length < minAxisHitsForRms && chiefRayEntry) {
            const successful = (rayGroup.rays || []).filter((ray: any) => {
                if (!ray || ray === chiefRayEntry || String(ray?.rayType || '').toLowerCase() === 'chief') return false;
                return Array.isArray(ray.path) && ray.path.length > targetPointIndex;
            });
            const { stopPlaneCenter3d, stopPlaneU, stopPlaneV } = computeStopPlaneFrame(opticalSystemRows, stopSurfaceIndex);
            if (stopPlaneCenter3d && successful.length > 0) {
                const recovered = selectAxisRaysFromSuccessfulByStopPlane(
                    successful,
                    chiefRayEntry,
                    true,
                    axisFanTarget,
                    stopPlaneCenter3d,
                    stopPlaneU,
                    stopPlaneV
                );
                if (recovered.length > rayFan.length) {
                    rayFan.length = 0;
                    for (const ray of recovered) {
                        rayFan.push({
                            segments: ray.path,
                            dir: extractRayStartAndDirection(ray)?.dir || ray.dir || null,
                            type: ray.rayType || 'meridional_recovered',
                            originalRay: ray.originalRay || null,
                            wavelength: ray.wavelength
                        });
                    }
                }
            }
        }

        if (rayFan.length < minAxisHitsForRms) {
            const solvedFan = buildStopSolveRayFan(
                opticalSystemRows,
                chiefRayResult,
                wavelength,
                stopSurfaceIndex,
                targetSurfaceIndex,
                targetPointIndex,
                'meridional',
                isAngleField,
                samplingPattern,
                ringCount,
                rayCount
            );
            if (solvedFan.length > 0) {
                rayFan.push(...solvedFan);
            }
        }
        if (rayFan.length < 3) {
            console.warn('      ⚠️ メリディオナル: stop-solveでも光線が不足しています');
            return null;
        }
        
        // RMSベースの最良焦点探索（Image面Z位置を基準）
        const bestZ = findBestFocusZ(
            rayFan,
            chiefRay,
            opticalSystemRows,
            targetSurfaceIndex,
            imageSurfaceZ,
            'meridional',
            imageSurfaceInfo,
            chiefRay?.dir || null
        );
        
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
    imageSurfaceInfo,
    isAngleField = false,
    samplingPattern = 'annular',
    ringCount = 10,
    rayCount = 30
) {
    try {
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
        const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
        if (rawTargetPointIndex === null) {
            console.warn('      ⚠️ サジタル: targetSurfaceIndex変換失敗');
            return null;
        }
        
        // CTがあると実際の光線セグメント数より大きい値になるのでクランプ
        const targetPointIndex = Math.min(rawTargetPointIndex, chiefRay.segments.length - 1);

        const rayFan = [];
        const chiefRayEntry = rayGroup.rays.find(r => (r?.rayType || '').toLowerCase() === 'chief') || null;
        const axisFanTarget = samplingPattern === 'cross'
            ? Math.max(25, Math.min(401, rayCount - 1))
            : Math.max(25, Math.min(401, Math.round(Math.sqrt(rayCount) * 3)));

        if (chiefRayEntry) {
            const { stopPlaneCenter3d, stopPlaneU, stopPlaneV } = computeStopPlaneFrame(opticalSystemRows, stopSurfaceIndex);
            if (stopPlaneCenter3d) {
                const selectedRays = selectAxisFanRaysByStopPlane(
                    rayGroup.rays,
                    chiefRayEntry,
                    false,
                    axisFanTarget,
                    stopPlaneCenter3d,
                    stopPlaneU,
                    stopPlaneV
                );
                for (const ray of selectedRays) {
                    if (ray?.path && ray.path.length > targetPointIndex) {
                        rayFan.push({
                            segments: ray.path,
                            dir: extractRayStartAndDirection(ray)?.dir || ray.dir || null,
                            type: ray.rayType || 'sagittal_selected',
                            originalRay: ray.originalRay || null,
                            wavelength: ray.wavelength
                        });
                    }
                }
            }
        }
        
        const minAxisHitsForRms = 5;
        if (rayFan.length < minAxisHitsForRms && chiefRayEntry) {
            const successful = (rayGroup.rays || []).filter((ray: any) => {
                if (!ray || ray === chiefRayEntry || String(ray?.rayType || '').toLowerCase() === 'chief') return false;
                return Array.isArray(ray.path) && ray.path.length > targetPointIndex;
            });
            const { stopPlaneCenter3d, stopPlaneU, stopPlaneV } = computeStopPlaneFrame(opticalSystemRows, stopSurfaceIndex);
            if (stopPlaneCenter3d && successful.length > 0) {
                const recovered = selectAxisRaysFromSuccessfulByStopPlane(
                    successful,
                    chiefRayEntry,
                    false,
                    axisFanTarget,
                    stopPlaneCenter3d,
                    stopPlaneU,
                    stopPlaneV
                );
                if (recovered.length > rayFan.length) {
                    rayFan.length = 0;
                    for (const ray of recovered) {
                        rayFan.push({
                            segments: ray.path,
                            dir: extractRayStartAndDirection(ray)?.dir || ray.dir || null,
                            type: ray.rayType || 'sagittal_recovered',
                            originalRay: ray.originalRay || null,
                            wavelength: ray.wavelength
                        });
                    }
                }
            }
        }

        if (rayFan.length < minAxisHitsForRms) {
            const solvedFan = buildStopSolveRayFan(
                opticalSystemRows,
                chiefRayResult,
                wavelength,
                stopSurfaceIndex,
                targetSurfaceIndex,
                targetPointIndex,
                'sagittal',
                isAngleField,
                samplingPattern,
                ringCount,
                rayCount
            );
            if (solvedFan.length > 0) {
                rayFan.push(...solvedFan);
            }
        }
        if (rayFan.length < 3) {
            console.warn('      ⚠️ サジタル: stop-solveでも光線が不足しています');
            return null;
        }
        
        // RMSベースの最良焦点探索（Image面Z位置を基準）
        const bestZ = findBestFocusZ(
            rayFan,
            chiefRay,
            opticalSystemRows,
            targetSurfaceIndex,
            imageSurfaceZ,
            'sagittal',
            imageSurfaceInfo,
            chiefRay?.dir || null
        );
        
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
/**
 * システムの共役モード（無限遠 vs 有限）を判定
 * @param {Array} opticalSystemRows
 * @returns {'angle' | 'height'}
 */
function detectSystemConjugateMode(opticalSystemRows) {
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) return 'height';

    const objRow = opticalSystemRows[0] || {};
    const thickness = parseFloat(objRow.thickness ?? objRow.Thickness ?? 0);

    if (!Number.isFinite(thickness) || thickness > 1e9) {
        return 'angle';
    }

    return 'height';
}

function getFieldSettingsFromObject(objectRowsParam, systemMode = 'height') {
    try {
        // 可能なら引数のObject行を優先し、未指定の場合のみテーブルから取得
        const objectRows = (objectRowsParam && objectRowsParam.length > 0)
            ? objectRowsParam
            : getObjectRows();
        if (!objectRows || objectRows.length === 0) {
            console.warn('⚠️ Object データが見つかりません');
            return [];
        }
        
        const fieldSettings = [];
        
        for (let i = 0; i < objectRows.length; i++) {
            const obj = objectRows[i];
            const name = obj.name || obj.Name || `Object${i + 1}`;

            const isAngle = (systemMode === 'angle');
            
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

            const normalizedPosition = isAngle ? 'angle' : 'height';
            
            fieldSettings.push({
                name: name,
                displayName: name,
                x: xValue,
                y: yValue,
                xHeight: isAngle ? 0 : xValue,
                yHeight: isAngle ? 0 : yValue,
                xHeightAngle: xValue,
                yHeightAngle: yValue,
                fieldType: isAngle ? 'angle' : 'height',
                objectIndex: i,
                position: normalizedPosition
            });
        }
        
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

    // 範囲が0°を跨ぐ場合は、補間点数が偶数でも必ず0°を含める
    if (minAngle < 0 && maxAngle > 0 && interpolatedFields.length > 0) {
        const hasZero = interpolatedFields.some(f => Math.abs(Number(f?.y ?? 0)) < 1e-9);
        if (!hasZero) {
            let nearestIndex = 0;
            let nearestAbs = Infinity;
            for (let i = 0; i < interpolatedFields.length; i++) {
                const ay = Math.abs(Number(interpolatedFields[i]?.y ?? 0));
                if (ay < nearestAbs) {
                    nearestAbs = ay;
                    nearestIndex = i;
                }
            }
            interpolatedFields[nearestIndex] = {
                ...interpolatedFields[nearestIndex],
                displayName: '0.0°',
                y: 0,
                yHeightAngle: 0
            };
        }
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

    // 範囲が0mmを跨ぐ場合は、補間点数が偶数でも必ず0mmを含める
    if (minH < 0 && maxH > 0 && interpolatedFields.length > 0) {
        const hasZero = interpolatedFields.some(f => Math.abs(Number(f?.y ?? 0)) < 1e-9);
        if (!hasZero) {
            let nearestIndex = 0;
            let nearestAbs = Infinity;
            for (let i = 0; i < interpolatedFields.length; i++) {
                const ah = Math.abs(Number(interpolatedFields[i]?.y ?? 0));
                if (ah < nearestAbs) {
                    nearestAbs = ah;
                    nearestIndex = i;
                }
            }
            interpolatedFields[nearestIndex] = {
                ...interpolatedFields[nearestIndex],
                displayName: '0.00mm',
                y: 0,
                yHeight: 0,
                yHeightAngle: 0
            };
        }
    }

    return interpolatedFields;
}

function maybeInterpolateAngleFieldSettingsForAstig(originalFields, totalPoints = 51) {
    if (!Array.isArray(originalFields) || originalFields.length === 0) {
        return [];
    }

    const angleFields = originalFields.filter(field => {
        const position = String(field?.position || field?.fieldType || '').toLowerCase();
        return position.includes('angle') && !position.includes('rectangle') && !position.includes('height');
    });
    if (angleFields.length !== originalFields.length) {
        return originalFields;
    }

    let maxAngle = 0;
    for (const field of originalFields) {
        const angle = Math.abs(Number(field?.yFieldAngle ?? field?.fieldAngle ?? field?.yHeightAngle ?? field?.y ?? 0));
        if (Number.isFinite(angle)) {
            maxAngle = Math.max(maxAngle, angle);
        }
    }
    if (!Number.isFinite(maxAngle) || maxAngle <= 0) {
        return originalFields;
    }

    const sampleCount = Math.max(3, Math.round(Number(totalPoints) || 51));
    const out = [];
    for (let i = 0; i < sampleCount; i++) {
        const angle = maxAngle * i / (sampleCount - 1);
        out.push({
            name: `Field${i}`,
            displayName: `${angle.toFixed(1)}°`,
            x: 0,
            y: angle,
            xHeight: 0,
            yHeight: 0,
            xHeightAngle: 0,
            yHeightAngle: angle,
            yFieldAngle: angle,
            fieldAngle: angle,
            fieldType: 'angle',
            position: 'angle',
            objectIndex: -1,
            isInterpolated: true
        });
    }
    return out;
}

function collectSpotWavelengthsForAstigWeb(sourceRows, wavelengthMode = 'all') {
    const all = [];
    let primary = 0.5875618;
    let hasExplicitPrimary = false;

    for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
        const wl = Number(row?.wavelength ?? row?.Wavelength);
        if (!Number.isFinite(wl) || wl <= 0) continue;
        all.push(wl);

        if (!hasExplicitPrimary && all.length === 1) {
            primary = wl;
        }

        const primaryFlag = row?.primary ?? row?.Primary ?? row?.['Primary Wavelength'] ?? row?.isPrimary;
        const isPrimary = typeof primaryFlag === 'boolean'
            ? primaryFlag
            : String(primaryFlag ?? '').trim().toLowerCase();
        if (isPrimary === true || isPrimary === 'true' || isPrimary === '1' || isPrimary === 'yes' || (typeof isPrimary === 'string' && isPrimary.includes('primary'))) {
            primary = wl;
            hasExplicitPrimary = true;
        }
    }

    if (all.length === 0) {
        all.push(primary);
    }

    const unique = [...all]
        .filter((wl, idx, arr) => arr.findIndex(v => Math.abs(v - wl) < 1e-9) === idx)
        .sort((a, b) => a - b);

    if (String(wavelengthMode || '').toLowerCase() === 'primary') {
        return [{ wavelengthUm: primary, label: 'Primary', color: '#2563eb' }];
    }

    const palette = [
        '#2563eb', '#16a34a', '#dc2626', '#7c3aed', '#ea580c', '#0891b2', '#4f46e5', '#0f766e', '#b91c1c', '#1d4ed8'
    ];

    return unique.map((wl, idx) => ({
        wavelengthUm: wl,
        label: Math.abs(wl - primary) < 1e-6 ? `Primary (${(wl * 1000).toFixed(1)}nm)` : `${(wl * 1000).toFixed(1)}nm`,
        color: palette[idx % palette.length]
    }));
}

function maybeInterpolateAngleObjectRowsForAstigWeb(objectRows, infiniteConjugate) {
    if (!infiniteConjugate || !Array.isArray(objectRows) || objectRows.length === 0) {
        return Array.isArray(objectRows) ? objectRows : [];
    }

    const hasHeightRect = objectRows.some((row) => {
        const pos = String(row?.position ?? row?.fieldType ?? row?.type ?? '').toLowerCase();
        return pos.includes('height') || pos.includes('rect');
    });
    if (hasHeightRect) return objectRows;

    let maxYAngle = 0;
    for (const row of objectRows) {
        const y = Math.abs(Number(row?.yHeightAngle ?? row?.yFieldAngle ?? row?.fieldAngle ?? row?.y ?? 0));
        if (Number.isFinite(y)) {
            maxYAngle = Math.max(maxYAngle, y);
        }
    }

    if (!Number.isFinite(maxYAngle) || maxYAngle <= 0) {
        return objectRows;
    }

    const subdivisions = 50;
    const out = [];
    for (let i = 0; i <= subdivisions; i++) {
        const angle = maxYAngle * i / subdivisions;
        out.push({
            name: `Field${i}`,
            position: 'Angle',
            xHeightAngle: 0,
            yHeightAngle: angle
        });
    }
    return out;
}

function generateCrossOffsetsNativeLike(rayCount, maxRadius) {
    const offsets = [];
    if (rayCount <= 0) return offsets;
    offsets.push({ offsetU: 0, offsetV: 0 });
    if (rayCount === 1) return offsets;

    let remaining = rayCount - 1;
    const armSteps = Math.max(1, Math.floor((remaining + 3) / 4));
    for (let index = 0; index < armSteps && remaining > 0; index++) {
        const t = (index + 1) / armSteps;
        const r = maxRadius * t;
        const candidates = [
            { offsetU: r, offsetV: 0 },
            { offsetU: -r, offsetV: 0 },
            { offsetU: 0, offsetV: r },
            { offsetU: 0, offsetV: -r }
        ];
        for (const candidate of candidates) {
            if (remaining <= 0) break;
            offsets.push(candidate);
            remaining -= 1;
        }
    }
    return offsets;
}

function generateAnnularOffsetsNativeLike(rayCount, maxRadius, ringCount) {
    const offsets = [];
    if (rayCount <= 0) return offsets;
    offsets.push({ offsetU: 0, offsetV: 0 });
    if (rayCount === 1) return offsets;

    const safeRingCount = Math.max(1, Math.floor(ringCount || 1));
    const rings = Math.min(safeRingCount, rayCount);
    let raysLeft = rayCount - 1;
    for (let ringIndex = 1; ringIndex <= rings && raysLeft > 0; ringIndex++) {
        const ringsRemaining = rings - ringIndex + 1;
        let raysForThisRing = Math.max(4, Math.floor(raysLeft / ringsRemaining));
        if (ringIndex === rings) raysForThisRing = raysLeft;
        const radius = (ringIndex / rings) * maxRadius;
        const angleStep = (2 * Math.PI) / Math.max(1, raysForThisRing);
        const startAngle = (ringIndex % 2 === 0) ? angleStep / 2 : 0;
        for (let i = 0; i < raysForThisRing && raysLeft > 0; i++) {
            const angle = startAngle + angleStep * i;
            offsets.push({
                offsetU: radius * Math.cos(angle),
                offsetV: radius * Math.sin(angle)
            });
            raysLeft -= 1;
        }
    }
    return offsets;
}

function generateCenteredGridOffsetsNativeLike(rayCount, halfExtent) {
    if (rayCount <= 0) return [];
    let gridSize = Math.max(1, Math.ceil(Math.sqrt(rayCount)));
    if (gridSize % 2 === 0) gridSize += 1;
    const spacing = gridSize > 1 ? (2 * halfExtent) / (gridSize - 1) : 0;
    const center = (gridSize - 1) / 2;
    const out = [];
    for (let i = 0; i < gridSize; i++) {
        for (let j = 0; j < gridSize; j++) {
            if (out.length >= rayCount) break;
            out.push({
                offsetU: gridSize > 1 ? (i - center) * spacing : 0,
                offsetV: gridSize > 1 ? (j - center) * spacing : 0
            });
        }
        if (out.length >= rayCount) break;
    }
    return out;
}

function generateOffsetsForPatternNativeLike(pattern, rayCount, radius, ringCount) {
    const safeRadius = Number.isFinite(radius) && radius > 1e-6 ? radius : 1e-6;
    if (pattern === 'grid') {
        return generateCenteredGridOffsetsNativeLike(rayCount, safeRadius);
    }
    if (pattern === 'cross') {
        return generateCrossOffsetsNativeLike(rayCount, safeRadius);
    }
    return generateAnnularOffsetsNativeLike(rayCount, safeRadius, ringCount);
}

function resolveInfiniteObjectZNativeLike(opticalSystemRows, objectRow, objectPlaneZ) {
    const renderDistFromRows = Number(opticalSystemRows?.[0]?.objectRenderDistance ?? 0);
    const renderDist = (Number.isFinite(renderDistFromRows) && Math.abs(renderDistFromRows) > 1e-12)
        ? renderDistFromRows
        : Number(
            objectRow?.objectRenderDistance ?? objectRow?.renderDistance ?? objectRow?.distance ?? objectRow?.z ?? 0
        );
    if (Number.isFinite(renderDist) && Math.abs(renderDist) > 1e-12) {
        return -Math.abs(renderDist);
    }
    return objectPlaneZ - 25;
}

function computeObjectSurfaceSagNativeLike(opticalSystemRows, x, y) {
    const first = Array.isArray(opticalSystemRows) ? opticalSystemRows[0] : null;
    if (!first) return 0;

    const radiusRaw = first.radius;
    if (radiusRaw === undefined || radiusRaw === null) return 0;
    const radiusText = String(radiusRaw).trim().toUpperCase();
    if (radiusText === 'INF' || radiusText === 'INFINITY' || radiusText === '∞') return 0;
    const radius = Number(radiusRaw);
    if (!Number.isFinite(radius) || Math.abs(radius) <= 1e-12) return 0;

    const conic = Number(first.conic) || 0;
    const coeffs = Array.from({ length: 10 }, (_, index) => Number(first[`coef${index + 1}`]) || 0);
    const surfType = String(first.surfType ?? first.type ?? '').toLowerCase();
    const mode = surfType.includes('odd') ? 'odd' : 'even';
    const r = Math.hypot(x, y);
    const sag = asphericSurfaceZ(r, {
        radius,
        conic,
        coef1: coeffs[0],
        coef2: coeffs[1],
        coef3: coeffs[2],
        coef4: coeffs[3],
        coef5: coeffs[4],
        coef6: coeffs[5],
        coef7: coeffs[6],
        coef8: coeffs[7],
        coef9: coeffs[8],
        coef10: coeffs[9]
    }, mode);
    return Number.isFinite(sag) ? sag : 0;
}

function optimizeAngleObjectPositionNativeLike(angleXDeg, angleYDeg, stopOrigin, objectZ) {
    const dir = buildDirectionFromFieldAngles(angleXDeg, angleYDeg);
    const safeK = Math.abs(dir.z) > 1e-12 ? dir.z : (dir.z >= 0 ? 1e-12 : -1e-12);
    const dz = Number(stopOrigin?.z) - objectZ;
    const x0 = Number(stopOrigin?.x) - (dir.x / safeK) * dz;
    const y0 = Number(stopOrigin?.y) - (dir.y / safeK) * dz;
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || Math.abs(x0) > 1e8 || Math.abs(y0) > 1e8) {
        return { x: 0, y: 0 };
    }
    return { x: x0, y: y0 };
}

function traceRayHitPointWrapped(opticalSystemRows, ray0, targetSurfaceIndex, options = RUST_RT_OPTIONS) {
    try {
        const hit = traceRayHitPoint(opticalSystemRows, ray0, 1.0, targetSurfaceIndex, options || RUST_RT_OPTIONS);
        return hit && !Array.isArray(hit) ? hit : null;
    } catch (_) {
        return null;
    }
}

function countRaysHittingSurfaceWeb(starts, opticalSystemRows, targetSurfaceIndex, wavelengthUm) {
    let hits = 0;
    for (const start of starts) {
        const hit = traceRayHitPointWrapped(opticalSystemRows, {
            pos: start.startP,
            dir: start.dir,
            wavelength: wavelengthUm
        }, targetSurfaceIndex, RUST_RT_OPTIONS);
        if (hit) hits += 1;
    }
    return hits;
}

function searchHighFieldOriginForTargetWeb(initialOrigin, chiefDir, opticalSystemRows, targetSurfaceIndex, targetSurfaceOrigin, samplingRadius, wavelengthUm) {
    const baseSpan = Math.max(samplingRadius, 0.5);
    const spans = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
    const grid = [-1, -0.5, 0, 0.5, 1];
    let bestOrigin = null;
    let bestScore = Infinity;

    for (const spanMul of spans) {
        const span = baseSpan * spanMul;
        for (const gx of grid) {
            for (const gy of grid) {
                const candidate = {
                    x: initialOrigin.x + gx * span,
                    y: initialOrigin.y + gy * span,
                    z: initialOrigin.z
                };
                const hit = traceRayHitPointWrapped(opticalSystemRows, {
                    pos: candidate,
                    dir: chiefDir,
                    wavelength: wavelengthUm
                }, targetSurfaceIndex, RUST_RT_OPTIONS);
                if (!hit) continue;
                const dx = Number(hit.x) - Number(targetSurfaceOrigin?.x ?? 0);
                const dy = Number(hit.y) - Number(targetSurfaceOrigin?.y ?? 0);
                const score = Math.hypot(dx, dy);
                if (Number.isFinite(score) && score < bestScore) {
                    bestScore = score;
                    bestOrigin = candidate;
                }
            }
        }
        if (bestOrigin) break;
    }

    return bestOrigin;
}

function searchHighFieldOriginByBundleWeb(initialOrigin, chiefDir, uAxis, vAxis, opticalSystemRows, targetSurfaceIndex, samplingRadius, wavelengthUm) {
    const baseSpan = Math.max(samplingRadius, 0.5);
    const spans = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
    const grid = [-1, -0.5, 0, 0.5, 1];
    const probeR = Math.min(5, Math.max(0.2, samplingRadius * 0.2));
    const probes = [
        [0, 0], [probeR, 0], [-probeR, 0], [0, probeR], [0, -probeR],
        [0.707 * probeR, 0.707 * probeR], [-0.707 * probeR, 0.707 * probeR],
        [0.707 * probeR, -0.707 * probeR], [-0.707 * probeR, -0.707 * probeR]
    ];

    let bestOrigin = null;
    let bestHits = 0;
    for (const spanMul of spans) {
        const span = baseSpan * spanMul;
        for (const gx of grid) {
            for (const gy of grid) {
                const candidate = {
                    x: initialOrigin.x + gx * span * uAxis.x + gy * span * vAxis.x,
                    y: initialOrigin.y + gx * span * uAxis.y + gy * span * vAxis.y,
                    z: initialOrigin.z + gx * span * uAxis.z + gy * span * vAxis.z
                };
                let hits = 0;
                for (const [pu, pv] of probes) {
                    const hit = traceRayHitPointWrapped(opticalSystemRows, {
                        pos: {
                            x: candidate.x + pu * uAxis.x + pv * vAxis.x,
                            y: candidate.y + pu * uAxis.y + pv * vAxis.y,
                            z: candidate.z + pu * uAxis.z + pv * vAxis.z
                        },
                        dir: chiefDir,
                        wavelength: wavelengthUm
                    }, targetSurfaceIndex, RUST_RT_OPTIONS);
                    if (hit) hits += 1;
                }
                if (hits > bestHits) {
                    bestHits = hits;
                    bestOrigin = candidate;
                }
            }
        }
        if (bestHits >= 3) break;
    }
    return bestOrigin;
}

function buildNativeLikeRayStartsForAstig(
    opticalSystemRows,
    objectRow,
    wavelengthUm,
    targetSurfaceIndex,
    rayCount,
    pattern,
    ringCount,
    surfaceOrigins,
    stopSurfaceIndex,
    previousEmissionOriginHint = null,
    previousModeHint = null,
    currentFieldMagnitude = 0,
    maxFieldMagnitude = 0
) {
    const firstSurfaceOrigin = surfaceOrigins?.[0]?.origin || { x: 0, y: 0, z: 0 };
    const objectPlaneZ = Number.isFinite(firstSurfaceOrigin?.z) ? firstSurfaceOrigin.z : 0;
    const stopFrame = computeStopPlaneFrame(opticalSystemRows, stopSurfaceIndex);
    const stopOrigin = stopFrame?.stopPlaneCenter3d || { x: 0, y: 0, z: objectPlaneZ + 10 };
    const stopPlaneU = stopFrame?.stopPlaneU || { x: 1, y: 0, z: 0 };
    const stopPlaneV = stopFrame?.stopPlaneV || { x: 0, y: 1, z: 0 };
    const stopRow = opticalSystemRows?.[stopSurfaceIndex] || {};
    const stopRadius = Number(stopRow?.semidia ?? stopRow?.semiDiameter ?? stopRow?.['Semi-Diameter'] ?? stopRow?.aperture ?? stopRow?.Aperture ?? stopFrame?.stopSolveMax ?? 10);
    const samplingRadius = Math.max(0.01, Number.isFinite(stopRadius) && stopRadius > 0 ? stopRadius : (stopFrame?.stopSolveMax || 10));

    const systemMode = detectSystemConjugateMode(opticalSystemRows);
    const infiniteConjugate = systemMode === 'angle';
    const pos = String(objectRow?.position ?? objectRow?.fieldType ?? objectRow?.type ?? '').toLowerCase();
    const positionType = pos.includes('angle') ? 'angle' : (pos.includes('point') ? 'point' : 'rectangle');

    const annularInsideScale = pattern === 'annular' ? (Math.max(1, ringCount) / (Math.max(1, ringCount) + 1)) : 1;
    const effectiveRadius = Math.min(samplingRadius, samplingRadius * annularInsideScale);
    const offsets = generateOffsetsForPatternNativeLike(pattern, rayCount, effectiveRadius, ringCount);

    if (positionType === 'angle') {
        const angleX = parseAngleInput(objectRow?.xAngle ?? objectRow?.objectAngleX ?? objectRow?.xHeightAngle ?? objectRow?.x ?? objectRow?.angleX);
        const angleY = parseAngleInput(objectRow?.yAngle ?? objectRow?.objectAngleY ?? objectRow?.yHeightAngle ?? objectRow?.y ?? objectRow?.angle ?? objectRow?.angleY);
        const chiefDir = buildDirectionFromFieldAngles(angleX, angleY);
        const isOnAxis = Math.abs(angleX) < 1e-10 && Math.abs(angleY) < 1e-10;
        const objectZ = infiniteConjugate
            ? resolveInfiniteObjectZNativeLike(opticalSystemRows, objectRow, objectPlaneZ)
            : objectPlaneZ;
        const originXY = isOnAxis
            ? { x: 0, y: 0 }
            : (infiniteConjugate
                ? { x: Math.tan(angleX * Math.PI / 180), y: Math.tan(angleY * Math.PI / 180) }
                : optimizeAngleObjectPositionNativeLike(angleX, angleY, stopOrigin, objectZ));
        const centerSag = computeObjectSurfaceSagNativeLike(opticalSystemRows, originXY.x, originXY.y);
        let emissionOrigin = { x: originXY.x, y: originXY.y, z: objectZ + centerSag };
        const basis = buildPerpendicularBasis(chiefDir);

        // Match native behavior: previous emission origin is a seed for search, not a post-search override.
        if (!isOnAxis && previousEmissionOriginHint && Number.isFinite(previousEmissionOriginHint.x) && Number.isFinite(previousEmissionOriginHint.y) && Number.isFinite(previousEmissionOriginHint.z)) {
            emissionOrigin = {
                x: previousEmissionOriginHint.x,
                y: previousEmissionOriginHint.y,
                z: previousEmissionOriginHint.z
            };
        }

        if (infiniteConjugate && !isOnAxis) {
            const targetSurfaceOrigin = surfaceOrigins?.[targetSurfaceIndex]?.origin || stopOrigin;
            emissionOrigin = searchHighFieldOriginForTargetWeb(
                emissionOrigin,
                chiefDir,
                opticalSystemRows,
                targetSurfaceIndex,
                targetSurfaceOrigin,
                samplingRadius,
                wavelengthUm
            ) || searchHighFieldOriginByBundleWeb(
                emissionOrigin,
                chiefDir,
                basis.u,
                basis.v,
                opticalSystemRows,
                targetSurfaceIndex,
                samplingRadius,
                wavelengthUm
            ) || emissionOrigin;
        }

        const buildCandidateRays = (pupilScale, allowOriginSolve, candidateRayCount = rayCount) => {
            const count = Math.max(1, Math.round(Number(candidateRayCount) || rayCount));
            const candidateRadius = Math.max(0.005, Math.min(samplingRadius, effectiveRadius * pupilScale));
            const candidateOffsets = generateOffsetsForPatternNativeLike(pattern, count, candidateRadius, ringCount);
            let baseOrigin = { ...emissionOrigin };
            if (allowOriginSolve && infiniteConjugate) {
                const solved = solveRayOriginsToStopPointsWithRustMeta(
                    opticalSystemRows,
                    [{ ...baseOrigin }],
                    [{ ...chiefDir }],
                    [{ ...stopOrigin }],
                    stopSurfaceIndex,
                    wavelengthUm,
                    {
                        ...RUST_RT_OPTIONS,
                        maxIter: 18,
                        tolMm: 1e-6,
                        eps: 1e-4,
                        maxStep: 5.0
                    }
                );
                const solvedChief = Array.isArray(solved) ? solved[0] : null;
                if (solvedChief && Number.isFinite(solvedChief.x) && Number.isFinite(solvedChief.y) && Number.isFinite(solvedChief.z)) {
                    baseOrigin = { x: solvedChief.x, y: solvedChief.y, z: solvedChief.z };
                }
            }

            return candidateOffsets.map(({ offsetU, offsetV }, index) => {
                const startP = {
                    x: baseOrigin.x + offsetU * basis.u.x + offsetV * basis.v.x,
                    y: baseOrigin.y + offsetU * basis.u.y + offsetV * basis.v.y,
                    z: baseOrigin.z + offsetU * basis.u.z + offsetV * basis.v.z,
                };
                return {
                    startP,
                    dir: { ...chiefDir },
                    description: index === 0 ? 'chief' : 'native-like-angle',
                    isChief: index === 0
                };
            });
        };

        if (infiniteConjugate && !isOnAxis) {
            const effectiveCurrentField = Math.abs(Number(currentFieldMagnitude) || 0);
            const effectiveMaxField = Math.abs(Number(maxFieldMagnitude) || 0);
            const continuityBiasThreshold = Math.max(12, effectiveMaxField * 0.75);
            const useContinuityModeHint = effectiveMaxField > 0 && effectiveCurrentField >= continuityBiasThreshold;
            const modes: Array<[number, boolean]> = [
                [1.0, true], [0.7, true], [0.5, true], [0.35, true], [0.25, true], [0.18, true], [0.12, true], [0.085, true], [0.06, true], [0.04, true], [0.03, true], [0.02, true], [0.015, true], [0.01, true],
                [1.0, false], [0.7, false], [0.5, false], [0.35, false], [0.25, false]
            ];
            let best = null;
            let bestHits = -1;
            const probeRayCount = Math.max(25, Math.min(121, rayCount));
            let bestMode = null;
            for (const [scale, allowOriginSolve] of modes) {
                const starts = buildCandidateRays(scale, allowOriginSolve, probeRayCount);
                const hits = countRaysHittingSurfaceWeb(starts, opticalSystemRows, targetSurfaceIndex, wavelengthUm);
                const continuityPenalty = (() => {
                    if (!useContinuityModeHint || !previousModeHint) return 0;
                    let penalty = 0;
                    if (previousModeHint.allowOriginSolve !== allowOriginSolve) penalty += 0.25;
                    const prevScale = Number(previousModeHint.scale);
                    if (Number.isFinite(prevScale)) {
                        penalty += Math.abs(prevScale - Number(scale)) * 0.5;
                    }
                    return penalty;
                })();
                const score = hits - continuityPenalty;
                const bestScore = bestHits - (bestMode ? 0 : 0);
                if (score > bestScore || (Math.abs(score - bestScore) < 1e-9 && hits > bestHits)) {
                    bestHits = hits;
                    best = buildCandidateRays(scale, allowOriginSolve, rayCount);
                    bestMode = { scale, allowOriginSolve };
                }
            }
            return {
                starts: Array.isArray(best) ? best : buildCandidateRays(1.0, true),
                refinedOrigin: { ...emissionOrigin },
                mode: bestMode || { scale: 1.0, allowOriginSolve: true }
            };
        }

        return {
            starts: buildCandidateRays(1.0, infiniteConjugate && !isOnAxis),
            refinedOrigin: { ...emissionOrigin },
            mode: { scale: 1.0, allowOriginSolve: !!(infiniteConjugate && !isOnAxis) }
        };
    }

    const objectX = Number(objectRow?.xHeightAngle ?? objectRow?.x ?? objectRow?.xHeight ?? objectRow?.objectX ?? 0);
    const objectY = Number(objectRow?.yHeightAngle ?? objectRow?.y ?? objectRow?.yHeight ?? objectRow?.objectY ?? 0);
    const objectZ = infiniteConjugate
        ? resolveInfiniteObjectZNativeLike(opticalSystemRows, objectRow, objectPlaneZ)
        : objectPlaneZ;
    const centerSag = computeObjectSurfaceSagNativeLike(opticalSystemRows, objectX, objectY);
    const center = { x: objectX, y: objectY, z: objectZ + centerSag };
    const chiefDir = (Number(stopOrigin.z) - center.z > 1e-6)
        ? normalize3({ x: stopOrigin.x - center.x, y: stopOrigin.y - center.y, z: stopOrigin.z - center.z })
        : { x: 0, y: 0, z: 1 };
    const basis = buildPerpendicularBasis(chiefDir);

    return {
        starts: offsets.map(({ offsetU, offsetV }, index) => {
        const startP = infiniteConjugate
            ? {
                x: center.x + offsetU * basis.u.x + offsetV * basis.v.x,
                y: center.y + offsetU * basis.u.y + offsetV * basis.v.y,
                z: center.z + offsetU * basis.u.z + offsetV * basis.v.z,
            }
            : { ...center };
        const dir = !infiniteConjugate && Number(stopOrigin.z) - center.z > 1e-6
            ? normalize3({
                x: (stopOrigin.x + offsetU * stopPlaneU.x + offsetV * stopPlaneV.x) - startP.x,
                y: (stopOrigin.y + offsetU * stopPlaneU.y + offsetV * stopPlaneV.y) - startP.y,
                z: (stopOrigin.z + offsetU * stopPlaneU.z + offsetV * stopPlaneV.z) - startP.z,
            })
            : { ...chiefDir };
        return {
            startP,
            dir,
            description: index === 0 ? 'chief' : 'native-like-object',
            isChief: index === 0
        };
        }),
        refinedOrigin: null,
        mode: { scale: 1.0, allowOriginSolve: false }
    };
}

function resolveNativeLikeFieldSetting(objectRow, objectIndex, infiniteConjugate) {
    const label = String(objectRow?.id ?? `Object ${objectIndex + 1}`);
    const displayName = String(objectRow?.name ?? objectRow?.comment ?? label);
    const pos = String(objectRow?.position ?? objectRow?.fieldType ?? objectRow?.type ?? '').toLowerCase();
    const isAngleField = pos.includes('angle') && !pos.includes('rect') && !pos.includes('height')
        ? true
        : !!infiniteConjugate && !pos.includes('rect') && !pos.includes('height');
    const y = isAngleField
        ? Number(objectRow?.yFieldAngle ?? objectRow?.fieldAngle ?? objectRow?.yAngle ?? objectRow?.yHeightAngle ?? objectRow?.y ?? 0)
        : Number(objectRow?.yHeight ?? objectRow?.y ?? objectRow?.yHeightAngle ?? objectRow?.yFieldAngle ?? objectRow?.fieldAngle ?? 0);

    return {
        label,
        displayName,
        y: Number.isFinite(y) ? y : 0,
        position: isAngleField ? 'Angle' : 'Rectangle',
        isAngleField
    };
}

function pickChiefLikeRayEntry(rays, opticalSystemRows, targetSurfaceIndex) {
    const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (rawTargetPointIndex === null) return null;

    const chiefEntry = rays.find(ray => ray?.isChief) || rays[0] || null;
    const rayHitsTarget = (ray) => Array.isArray(ray?.path) && ray.path.length > rawTargetPointIndex;
    if (chiefEntry && rayHitsTarget(chiefEntry)) return chiefEntry;

    const chiefStart = chiefEntry?.originalRay?.pos || chiefEntry?.startP || null;
    let bestEntry = null;
    let bestDist2 = Infinity;
    for (const ray of rays) {
        if (!rayHitsTarget(ray)) continue;
        if (!chiefStart) return ray;
        const start = ray?.originalRay?.pos || ray?.startP || null;
        if (!start) continue;
        const dx = Number(start.x) - Number(chiefStart.x);
        const dy = Number(start.y) - Number(chiefStart.y);
        const dist2 = dx * dx + dy * dy;
        if (Number.isFinite(dist2) && dist2 < bestDist2) {
            bestDist2 = dist2;
            bestEntry = ray;
        }
    }
    return bestEntry;
}

function buildNativeLikeChiefResult(rayEntries, chiefEntry) {
    if (!chiefEntry || !Array.isArray(chiefEntry?.path) || chiefEntry.path.length === 0) {
        return null;
    }

    const chiefDirection = extractRayStartAndDirection(chiefEntry)?.dir || chiefEntry?.dir || chiefEntry?.originalRay?.dir || null;
    return {
        success: true,
        convergence: true,
        rayData: {
            segments: chiefEntry.path,
            dir: chiefDirection,
            originalRay: chiefEntry.originalRay || null,
            wavelength: chiefEntry.wavelength
        },
        rayGroups: [{ rays: rayEntries }]
    };
}

export async function calculateAstigmatismDataNativeLike(
    opticalSystemRows,
    sourceRows,
    objectRows,
    targetSurfaceIndex,
    options: {
        rayCount?: number;
        ringCount?: number;
        pattern?: 'grid' | 'cross' | 'annular';
        requireRustWasm?: boolean;
        verbose?: boolean;
        onProgress?: any;
        wavelengthMode?: 'all' | 'primary';
    } = {}
) {
    const {
        rayCount = 100,
        ringCount = 10,
        pattern = 'annular',
        requireRustWasm = true,
        verbose = false,
        onProgress = null,
        wavelengthMode = 'all'
    } = options;

    const progressCb = (typeof onProgress === 'function') ? onProgress : null;
    const safeProgress = (percent, message) => {
        try { progressCb?.({ percent, message }); } catch (_) {}
    };
    const yieldToUI = async () => new Promise(resolve => setTimeout(resolve, 0));

    const systemMode = detectSystemConjugateMode(opticalSystemRows);
    const infiniteConjugate = systemMode === 'angle';
    const isAngleField = infiniteConjugate;
    const mirrorCount = Array.isArray(opticalSystemRows)
        ? opticalSystemRows.filter(row => {
            if (!row) return false;
            if (row.material === 'MIRROR') return true;
            if (row.type === 'Mirror') return true;
            if (row._blockType === 'Mirror') return true;
            const surfType = String(row.surfType ?? row.type ?? row.surfaceType ?? '').trim().toLowerCase();
            return surfType === 'mirror';
        }).length
        : 0;
    const mirrorSign = (mirrorCount % 2 === 1) ? -1 : 1;
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    const imageSurfaceInfo = surfaceOrigins?.[targetSurfaceIndex] || null;
    const stopSurfaceIndex = findStopSurfaceIndex(opticalSystemRows);

    let effectiveObjectRows = Array.isArray(objectRows) ? [...objectRows] : [];
    if (effectiveObjectRows.length === 0) {
        effectiveObjectRows = [
            infiniteConjugate
                ? { name: 'AutoField0', position: 'Angle', xHeightAngle: 0, yHeightAngle: 0 }
                : { name: 'AutoField0', position: 'Rectangle', xHeight: 0, yHeight: 0 }
        ];
    }
    effectiveObjectRows = maybeInterpolateAngleObjectRowsForAstigWeb(effectiveObjectRows, infiniteConjugate);

    const wavelengths = collectSpotWavelengthsForAstigWeb(sourceRows, wavelengthMode);
    const primaryWavelength = __pickPrimaryWavelengthMicrons(sourceRows, wavelengths[0]?.wavelengthUm || 0.5876);
    const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
    if (rawTargetPointIndex === null) {
        throw new Error('Astigmatism(native-like web): target surface conversion failed');
    }

    const tracedSeries = [];
    const fieldSettings = [];
    const previousAngleOriginByWl = Array.from({ length: wavelengths.length }, () => null);
    const previousModeByWl = Array.from({ length: wavelengths.length }, () => null);
    const resolvedFieldSettings = effectiveObjectRows.map((objectRow, objectIndex) =>
        resolveNativeLikeFieldSetting(objectRow, objectIndex, infiniteConjugate)
    );
    const maxFieldMagnitude = resolvedFieldSettings.reduce((maxValue, field) => {
        const y = Math.abs(Number(field?.y) || 0);
        return Number.isFinite(y) ? Math.max(maxValue, y) : maxValue;
    }, 0);
    let seriesCounter = 0;
    const totalSeries = Math.max(1, effectiveObjectRows.length * wavelengths.length);

    safeProgress(5, 'Generating native-like ray series...');
    await yieldToUI();

    for (let objectIndex = 0; objectIndex < effectiveObjectRows.length; objectIndex++) {
        const objectRow = effectiveObjectRows[objectIndex];
        const fieldSetting = resolvedFieldSettings[objectIndex] || resolveNativeLikeFieldSetting(objectRow, objectIndex, infiniteConjugate);
        fieldSettings.push({
            displayName: fieldSetting.displayName,
            y: fieldSetting.y,
            position: fieldSetting.position
        });

        for (let wlIndex = 0; wlIndex < wavelengths.length; wlIndex++) {
            const wavelength = wavelengths[wlIndex];
            const generation = buildNativeLikeRayStartsForAstig(
                opticalSystemRows,
                objectRow,
                wavelength.wavelengthUm,
                targetSurfaceIndex,
                rayCount,
                pattern,
                ringCount,
                surfaceOrigins,
                stopSurfaceIndex,
                previousAngleOriginByWl[wlIndex],
                previousModeByWl[wlIndex],
                fieldSetting.y,
                maxFieldMagnitude
            ) || { starts: [], refinedOrigin: null, mode: null };
            const starts = Array.isArray(generation?.starts) ? generation.starts : [];
            if (generation?.refinedOrigin && Number.isFinite(generation.refinedOrigin.x) && Number.isFinite(generation.refinedOrigin.y) && Number.isFinite(generation.refinedOrigin.z)) {
                previousAngleOriginByWl[wlIndex] = {
                    x: generation.refinedOrigin.x,
                    y: generation.refinedOrigin.y,
                    z: generation.refinedOrigin.z
                };
            }
            const generationMode: any = (generation as any)?.mode;
            if (generationMode && Number.isFinite(Number(generationMode.scale))) {
                previousModeByWl[wlIndex] = {
                    scale: Number(generationMode.scale),
                    allowOriginSolve: generationMode.allowOriginSolve === true
                };
            }

            const rayEntries = starts.map((start, index) => {
                const ray0 = {
                    pos: { ...start.startP },
                    dir: { ...start.dir },
                    wavelength: wavelength.wavelengthUm
                };
                const traced = traceRayPathWrapped(opticalSystemRows, ray0, targetSurfaceIndex, RUST_RT_OPTIONS);
                return {
                    path: Array.isArray(traced?.rayPath) ? traced.rayPath : [],
                    dir: { ...start.dir },
                    wavelength: wavelength.wavelengthUm,
                    rayType: index === 0 ? 'chief' : 'generated',
                    isChief: index === 0,
                    originalRay: {
                        pos: { ...start.startP },
                        dir: { ...start.dir },
                        wavelength: wavelength.wavelengthUm
                    },
                    description: start?.description || ''
                };
            });

            tracedSeries.push({
                fieldSetting,
                wavelengthUm: wavelength.wavelengthUm,
                rays: rayEntries,
                hasFieldAngle: fieldSetting.isAngleField
            });

            seriesCounter++;
            const percent = 5 + (25 * (seriesCounter / totalSeries));
            safeProgress(percent, `Generating rays (${seriesCounter}/${totalSeries})...`);
            await yieldToUI();
        }
    }

    fieldSettings.sort((a, b) => Math.abs(a.y) - Math.abs(b.y) || String(a.displayName).localeCompare(String(b.displayName)));
    const dedupedFieldSettings = fieldSettings.filter((item, index, arr) => {
        return arr.findIndex(other => other.displayName === item.displayName && other.position === item.position && Math.abs(other.y - item.y) < 1e-9) === index;
    });

    safeProgress(35, 'Computing field curves from traced rays...');
    await yieldToUI();

    let primaryReferenceZ = null;
    let bestAxis = Infinity;
    const computedRows = [];
    const previousFocusByWavelength = new Map();

    const medianOr = (values, fallbackValue) => {
        if (Array.isArray(values) && values.length > 0) {
            const sorted = [...values].filter(v => Number.isFinite(v)).sort((a, b) => a - b);
            if (sorted.length > 0) {
                const n = sorted.length;
                if ((n % 2) === 1) return sorted[Math.floor(n / 2)];
                return 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
            }
        }
        return Number.isFinite(fallbackValue) ? fallbackValue : null;
    };

    for (let index = 0; index < tracedSeries.length; index++) {
        const series = tracedSeries[index];
        const chiefEntry = pickChiefLikeRayEntry(series.rays, opticalSystemRows, targetSurfaceIndex);
        const chiefResult = buildNativeLikeChiefResult(series.rays, chiefEntry);
        if (!chiefResult) continue;

        const chiefRay = chiefResult.rayData;
        const paraxialImageZ = calculateParaxialImagePosition(opticalSystemRows, chiefRay, targetSurfaceIndex, imageSurfaceInfo);
        if (paraxialImageZ === null || !Number.isFinite(paraxialImageZ)) {
            continue;
        }

        const chiefSegment = chiefRay?.segments?.[Math.min(rawTargetPointIndex, chiefRay.segments.length - 1)] || null;
        const imageSurfaceZ = (() => {
            if (!chiefSegment) return null;
            if (!imageSurfaceInfo?.origin || !imageSurfaceInfo?.rotationMatrix) return chiefSegment.z;
            const dx = chiefSegment.x - imageSurfaceInfo.origin.x;
            const dy = chiefSegment.y - imageSurfaceInfo.origin.y;
            const dz = chiefSegment.z - imageSurfaceInfo.origin.z;
            const R = imageSurfaceInfo.rotationMatrix;
            return R[0][2] * dx + R[1][2] * dy + R[2][2] * dz;
        })();
        if (!Number.isFinite(imageSurfaceZ)) {
            continue;
        }

        if (Math.abs(series.wavelengthUm - primaryWavelength) < 1e-6) {
            const axisAbs = Math.abs(series.fieldSetting.y);
            if (axisAbs < bestAxis) {
                bestAxis = axisAbs;
                primaryReferenceZ = paraxialImageZ;
            }
        }

        const meridionalFocusRms = traceMeridionalMarginalRay(
            opticalSystemRows,
            chiefRay,
            chiefResult,
            series.wavelengthUm,
            stopSurfaceIndex,
            targetSurfaceIndex,
            imageSurfaceZ,
            imageSurfaceInfo,
            series.hasFieldAngle,
            pattern,
            ringCount,
            rayCount
        );

        const sagittalFocusRms = traceSagittalMarginalRay(
            opticalSystemRows,
            chiefRay,
            chiefResult,
            series.wavelengthUm,
            stopSurfaceIndex,
            targetSurfaceIndex,
            imageSurfaceZ,
            imageSurfaceInfo,
            series.hasFieldAngle,
            pattern,
            ringCount,
            rayCount
        );

        // Native-compatible fallback path: if RMS-based focus is unstable/missing,
        // reuse previous wavelength focus or fall back to median focus from all rays.
        const merFocuses = [];
        const sagFocuses = [];
        const chiefStart = extractRayStartAndDirection(chiefEntry)?.start || null;
        for (const ray of (series.rays || [])) {
            if (!Array.isArray(ray?.path) || ray.path.length === 0) continue;
            const rayDir = extractRayStartAndDirection(ray)?.dir || ray?.dir || null;
            const focus = findAxisIntersection(
                opticalSystemRows,
                { segments: ray.path },
                targetSurfaceIndex,
                imageSurfaceInfo,
                rayDir
            );
            if (!Number.isFinite(focus)) continue;
            if (Number.isFinite(paraxialImageZ) && Math.abs(focus - paraxialImageZ) > 50) continue;

            const rayStart = extractRayStartAndDirection(ray)?.start || null;
            if (!chiefStart || !rayStart) continue;
            const dx = Number(rayStart.x) - Number(chiefStart.x);
            const dy = Number(rayStart.y) - Number(chiefStart.y);
            if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;

            if (Math.abs(dx) <= Math.abs(dy)) {
                merFocuses.push(focus);
            } else {
                sagFocuses.push(focus);
            }
        }

        const wlKey = Math.round(series.wavelengthUm * 1_000_000);
        const prevFocus = previousFocusByWavelength.get(wlKey) || { mer: null, sag: null };

        const meridionalFocusZ = Number.isFinite(meridionalFocusRms)
            ? meridionalFocusRms
            : (Number.isFinite(prevFocus.mer) ? prevFocus.mer : medianOr(merFocuses, paraxialImageZ));
        const sagittalFocusZ = Number.isFinite(sagittalFocusRms)
            ? sagittalFocusRms
            : (Number.isFinite(prevFocus.sag) ? prevFocus.sag : medianOr(sagFocuses, paraxialImageZ));

        previousFocusByWavelength.set(wlKey, {
            mer: Number.isFinite(meridionalFocusZ) ? meridionalFocusZ : prevFocus.mer,
            sag: Number.isFinite(sagittalFocusZ) ? sagittalFocusZ : prevFocus.sag,
        });

        computedRows.push({
            wavelength: series.wavelengthUm,
            fieldAngle: Math.abs(series.fieldSetting.y),
            fieldName: series.fieldSetting.displayName,
            paraxialImageZ,
            meridionalFocusZ,
            sagittalFocusZ
        });

        const percent = 35 + (55 * ((index + 1) / tracedSeries.length));
        safeProgress(percent, `Computing curves (${index + 1}/${tracedSeries.length})...`);
        await yieldToUI();
    }

    if (primaryReferenceZ === null) {
        primaryReferenceZ = computedRows.find(row => Math.abs(row.wavelength - primaryWavelength) < 1e-6)?.paraxialImageZ ?? null;
    }

    const data = computedRows.map((row) => {
        const meridionalDeviation = Number.isFinite(row.meridionalFocusZ) && Number.isFinite(primaryReferenceZ)
            ? (row.meridionalFocusZ - primaryReferenceZ) * mirrorSign
            : null;
        const sagittalDeviation = Number.isFinite(row.sagittalFocusZ) && Number.isFinite(primaryReferenceZ)
            ? (row.sagittalFocusZ - primaryReferenceZ) * mirrorSign
            : null;
        return {
            wavelength: row.wavelength,
            fieldAngle: row.fieldAngle,
            fieldName: row.fieldName,
            paraxialImageZ: row.paraxialImageZ,
            meridionalDeviation,
            sagittalDeviation,
            astigmaticDifference: (meridionalDeviation !== null && sagittalDeviation !== null)
                ? (meridionalDeviation - sagittalDeviation)
                : null,
            crossBeamIntersections: null
        };
    }).sort((a, b) => a.wavelength - b.wavelength || a.fieldAngle - b.fieldAngle);

    safeProgress(100, '');

    return {
        targetSurface: targetSurfaceIndex,
        stopSurface: stopSurfaceIndex,
        relativeTargetIndex: targetSurfaceIndex - stopSurfaceIndex,
        wavelengths: wavelengths.map(item => item.wavelengthUm),
        fieldSettings: dedupedFieldSettings,
        fieldMode: systemMode,
        isAngleField,
        primaryWavelength,
        primaryReferenceZ,
        data
    };
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
export async function calculateAstigmatismData(
    opticalSystemRows: any,
    sourceRows: any,
    objectRows: any,
    targetSurfaceIndex: any,
    options: {
        spotDiagramMode?: boolean;
        rayCount?: number;
        ringCount?: number;
        pattern?: 'grid' | 'cross' | 'annular';
        interpolationPoints?: number;
        verbose?: boolean;
        onProgress?: any;
        yieldEvery?: number;
        requireRustWasm?: boolean;
        chiefRayMode?: 'stopCenter' | 'beamCenter' | 'centroid';
    } = {}
) {
    const {
        spotDiagramMode = false,
        rayCount = 100,
        ringCount = 10,
        pattern = 'annular',
        interpolationPoints = 20,  // プロット点数を20点に増加
        verbose = false,  // 詳細ログを制御
        onProgress = null,
        yieldEvery = 1,
        requireRustWasm = true,
        chiefRayMode = 'stopCenter'  // 'stopCenter' | 'beamCenter' | 'centroid' | '*Image'
    } = options;
    const samplingPattern: 'grid' | 'cross' | 'annular' =
        (pattern === 'grid' || pattern === 'cross' || pattern === 'annular')
            ? pattern
            : 'annular';
    const samplingRingCount = Number.isFinite(Number(ringCount))
        ? Math.max(1, Math.min(64, Math.round(Number(ringCount))))
        : 10;

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
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    const imageSurfaceInfo = surfaceOrigins?.[targetSurfaceIndex] || null;

    const progressCb = (typeof onProgress === 'function') ? onProgress : null;
    const safeProgress = (percent, message) => {
        try { progressCb?.({ percent, message }); } catch (_) {}
    };
    const yieldToUI = async () => new Promise(resolve => setTimeout(resolve, 0));

    try {
        safeProgress(0, 'Preparing...');
        await yieldToUI();

        // Sourceテーブルから波長を取得
        const wavelengths = sourceRows
            .map(row => parseFloat(row.wavelength || row.Wavelength || 0.5876))
            .filter(w => Number.isFinite(w) && w > 0);
        const systemConjugateMode = detectSystemConjugateMode(opticalSystemRows);

        let fieldSettings = getFieldSettingsFromObject(objectRows, systemConjugateMode);
        if (!fieldSettings || fieldSettings.length === 0) {
            // フォールバック（従来の簡易パス）
            fieldSettings = objectRows.map((obj, index) => {
                const isAngle = systemConjugateMode === 'angle';
                const normalizedPosition = isAngle ? 'angle' : 'height';
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
                    position: normalizedPosition
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
        
        // スポット表示モードでは補間を行わない。補間は角度フィールドのときのみ実行（Rectangle/heightの場合はそのまま）。
        if (!spotDiagramMode && interpolationPoints > 0) {
            if (systemConjugateMode === 'angle') {
                fieldSettings = maybeInterpolateAngleFieldSettingsForAstig(
                    fieldSettings,
                    Math.max(interpolationPoints, 51)
                );
            } else if (fieldSettings.length >= 2) {
                fieldSettings = interpolateHeightFieldSettings(fieldSettings, interpolationPoints);
            }
        }
        
        safeProgress(5, 'Computing reference focus...');
        await yieldToUI();

        // スポット表示モードでは、既存のスポットダイアグラム計算ロジックをそのまま使用し、
        // 結果を非点データ形式に詰め替えて返す
        if (spotDiagramMode) {
            const { generateSpotDiagram } = await import('../spot-diagram.js');

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

            // Object Position Angleは無限系、Rectangle/Heightは有限系
            const isAngleField = systemConjugateMode === 'angle';

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
                fieldMode: systemConjugateMode,
                isAngleField,
                primaryWavelength: primaryWl,
                primaryReferenceZ: null,
                data: data
            };
        }
        
        // 絞り面を検出
        const stopSurfaceIndex = findStopSurfaceIndex(opticalSystemRows);
        // Calculate relative index from stop surface
        // Ray tracing starts at stop surface, so segment index 0 = stop surface
        // targetSurfaceIndex is absolute, so we need to subtract stopSurfaceIndex
        const relativeTargetIndex = targetSurfaceIndex - stopSurfaceIndex;
        const astigmatismData = {
            targetSurface: targetSurfaceIndex,
            stopSurface: stopSurfaceIndex,
            relativeTargetIndex: relativeTargetIndex,
            wavelengths: wavelengths,
            fieldSettings: fieldSettings,
            // Object Position Angleは無限系（角度）、Rectangle/Heightは有限系（物体高）
            isAngleField: systemConjugateMode === 'angle',
            fieldMode: systemConjugateMode,
            primaryWavelength: null, // 主波長
            primaryReferenceZ: null, // 主波長の軸上（0°）近軸像点位置（すべての基準0点）
            data: [] // { wavelength, fieldAngle, paraxialImageZ, meridionalDeviation, sagittalDeviation }
        };
        
        // 主波長を特定（Sourceテーブルの Primary Wavelength を優先）
        const primaryWavelength = __pickPrimaryWavelengthMicrons(sourceRows, wavelengths[0] || 0.5876);
        astigmatismData.primaryWavelength = primaryWavelength;

        // 表示用/下流互換のため、wavelengths が空なら primary を入れておく
        if (wavelengths.length === 0) {
            wavelengths.push(primaryWavelength);
        }
        
        const getFieldAxisValue = (field) => {
            if (!field) return 0;
            if (astigmatismData.isAngleField) {
                const angle = Number(field.yFieldAngle ?? field.fieldAngle ?? field.yHeightAngle ?? field.y ?? 0);
                return Number.isFinite(angle) ? angle : 0;
            }
            const height = Number(field.yHeight ?? field.y ?? field.yFieldAngle ?? field.fieldAngle ?? 0);
            return Number.isFinite(height) ? height : 0;
        };

        // 軸上（0°または0mm）フィールドを検索
        const axialField = fieldSettings.find(f => {
            const axisValue = Math.abs(getFieldAxisValue(f));
            return axisValue < 0.001; // ほぼ0
        });
        
        // 主波長の基準位置を計算（すべての基準0点）
        let referenceField = axialField;
        
        // 軸上フィールドが見つからない場合は、最小角度/高さのフィールドを使用
        if (!referenceField && fieldSettings.length > 0) {
            const sortedFields = [...fieldSettings].sort((a, b) => Math.abs(getFieldAxisValue(a)) - Math.abs(getFieldAxisValue(b)));
            referenceField = sortedFields[0];
            console.warn(`   ⚠️ 軸上フィールドが見つからないため、最小角度/高さを基準とします: ${referenceField.displayName} (axis=${getFieldAxisValue(referenceField)})`);
        }

        if (referenceField) {
            const referenceChiefResult = calculateChiefRayNewton(
                opticalSystemRows,
                referenceField,
                primaryWavelength,
                'unified',
                { 
                    targetSurfaceIndex,
                    rayCount: rayCount,  // クロスビーム光線本数を指定
                    requireRustWasm: requireRustWasm
                }
            );
            
            if (referenceChiefResult && referenceChiefResult.convergence) {
                // rayData または ray を使用
                const referenceChiefRay = referenceChiefResult.rayData || referenceChiefResult.ray;

                const referenceTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
                if (referenceTargetPointIndex === null) {
                    console.error(`   ❌ targetSurfaceIndex変換失敗: targetSurfaceIndex=${targetSurfaceIndex}`);
                }

                if (referenceChiefRay && referenceChiefRay.segments && referenceTargetPointIndex !== null) {
                    const referenceParaxialZ = calculateParaxialImagePosition(
                        opticalSystemRows,
                        referenceChiefRay,
                        targetSurfaceIndex,
                        imageSurfaceInfo
                    );

                    if (referenceParaxialZ !== null && Number.isFinite(referenceParaxialZ)) {
                        astigmatismData.primaryReferenceZ = referenceParaxialZ;
                    } else {
                        console.error(`   ❌ calculateParaxialImagePosition が null を返しました`);
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
                    verbose,
                    imageSurfaceInfo,
                    mirrorSign,
                    requireRustWasm,
                    chiefRayMode,
                    samplingPattern,
                    samplingRingCount
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

        // NOTE: rezeroOffset post-processing removed.
        // Native Rust does NOT apply any secondary re-zeroing pass — it uses
        // (mer_focus - primary_ref) directly where primary_ref is the paraxial Z of
        // the on-axis field at the primary wavelength.  Adding a second shift here
        // caused a systematic Image Position offset vs native output.
        safeProgress(95, 'Finalizing...');
        await yieldToUI();
        
        const endTime = performance.now();
        void endTime;

        safeProgress(100, '');
        
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
    verbose,
    imageSurfaceInfo,
    mirrorSign,
    requireRustWasm,
    chiefRayMode = 'stopCenter',
    samplingPattern = 'annular',
    ringCount = 10
) {
    // フィールド角を取得
    // Object Position Angle: 無限系として画角を使用
    // Rectangle/Height: 有限系として物体高さを使用
    let fieldAngle;
    const positionType = (fieldSetting.position || fieldSetting.fieldType || '').toLowerCase();
    const isAngleField = positionType.includes('angle') && !positionType.includes('rectangle');
    const fieldType = isAngleField ? 'angle' : 'height';
    
    if (isAngleField) {
        // 無限系: Y方向の角度を使用（複数のフィールド名に対応）
        fieldAngle = Math.abs(
            fieldSetting.yFieldAngle || 
            fieldSetting.fieldAngle || 
            fieldSetting.y || 
            fieldSetting.yHeightAngle || 
            0
        );
    } else {
        // 有限系: 高さの場合はyHeight値を使用、または0
        fieldAngle = Math.abs(fieldSetting.yHeight || fieldSetting.y || 0);
    }
    
    const mirrorSignValue = (mirrorSign === -1 || mirrorSign === 1) ? mirrorSign : 1;
    
    try {
        // 主光線を計算（近軸像点計算に必要）
        // rayCount オプションでクロスビームの光線本数を指定
        const chiefRayResult = calculateChiefRayNewton(
            opticalSystemRows, 
            fieldSetting, 
            wavelength, 
            'unified',
            {
                rayCount: rayCount,
                chiefRayMode: chiefRayMode,
                requireRustWasm: requireRustWasm
            }  // クロスビームの光線本数と主光線モードを渡す
        );
        const chiefSucceeded = !!(
            chiefRayResult && (
                chiefRayResult.success === true ||
                chiefRayResult.convergence === true ||
                !!chiefRayResult.rayData ||
                !!chiefRayResult.ray
            )
        );
        if (!chiefSucceeded) {
            return null;
        }
        
        let chiefRay = chiefRayResult.rayData || chiefRayResult.ray;
        if (!chiefRay || !chiefRay.segments) {
            return null;
        }
        
        // 主光線モードに応じて像面上の基準位置を調整
        const chiefRayModeBase = (typeof chiefRayMode === 'string' && chiefRayMode.endsWith('Image'))
            ? chiefRayMode.slice(0, -'Image'.length)
            : chiefRayMode;

        if (chiefRayModeBase !== 'stopCenter' && chiefRayResult.rayGroups && chiefRayResult.rayGroups[0]) {
            const adjustedChief = adjustChiefRayByMode(
                chiefRay, 
                chiefRayResult.rayGroups[0], 
                targetSurfaceIndex, 
                opticalSystemRows, 
                chiefRayMode,
                verbose,
                imageSurfaceInfo
            );
            if (adjustedChief) {
                chiefRay = adjustedChief;
            }
        }
        
        // 主光線の評価面（Image面）での交点Z位置を基準として使用
        const rawTargetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);
        const targetPointIndex = (rawTargetPointIndex === null)
            ? null
            : Math.min(rawTargetPointIndex, chiefRay.segments.length - 1);
        if (targetPointIndex === null) {
            return null;
        }

        const chiefSegment = chiefRay.segments[targetPointIndex];
        if (!chiefSegment) {
            return null;
        }
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
        const imageSurfaceZ = toLocal(chiefSegment).z;
        
        // 近軸像点（理想像点）を計算（絶対インデックスを使用）
        const paraxialImageZ = calculateParaxialImagePosition(opticalSystemRows, chiefRay, targetSurfaceIndex, imageSurfaceInfo);
        if (paraxialImageZ === null) {
            return null;
        }
        
        // スポット表示モードでは非点収差計算をスキップ、通常モードでは計算
        let meridionalFocusZ = null;
        let sagittalFocusZ = null;
        let meridionalDeviation = null;
        let sagittalDeviation = null;
        
        if (!spotDiagramMode) {
            // 非点収差図モード: メリディオナル・サジタル焦点を計算
            const isAngleField = (fieldType === 'angle');

            meridionalFocusZ = traceMeridionalMarginalRay(
                opticalSystemRows,
                chiefRay,
                chiefRayResult,
                wavelength,
                stopSurfaceIndex,
                targetSurfaceIndex,
                imageSurfaceZ,  // Image面Z位置を基準として使用
                imageSurfaceInfo,
                isAngleField,
                samplingPattern,
                ringCount,
                rayCount
            );
            
            sagittalFocusZ = traceSagittalMarginalRay(
                opticalSystemRows,
                chiefRay,
                chiefRayResult,
                wavelength,
                stopSurfaceIndex,
                targetSurfaceIndex,
                imageSurfaceZ,  // Image面Z位置を基準として使用
                imageSurfaceInfo,
                isAngleField,
                samplingPattern,
                ringCount,
                rayCount
            );
            
            if (meridionalFocusZ !== null) {
                meridionalDeviation = meridionalFocusZ - paraxialImageZ;
            }
            
            if (sagittalFocusZ !== null) {
                sagittalDeviation = sagittalFocusZ - paraxialImageZ;
            }
        }
        
        // 主波長の軸上像面位置を基準とした相対値に変換
        let meridionalDeviationRelative = meridionalDeviation;
        let sagittalDeviationRelative = sagittalDeviation;
        
        if (primaryReferenceZ !== null) {
            // メリディオナル・サジタル焦点位置を主波長軸上位置からの相対値に変換
            if (meridionalFocusZ !== null) {
                meridionalDeviationRelative = meridionalFocusZ - primaryReferenceZ;
            }
            if (sagittalFocusZ !== null) {
                sagittalDeviationRelative = sagittalFocusZ - primaryReferenceZ;
            }
        } else {
            if (verbose) console.warn(`      ⚠️⚠️⚠️ primaryReferenceZがnullのため相対値変換をスキップ ⚠️⚠️⚠️`);
        }

        if (meridionalDeviation !== null) meridionalDeviation *= mirrorSignValue;
        if (sagittalDeviation !== null) sagittalDeviation *= mirrorSignValue;
        if (meridionalDeviationRelative !== null && meridionalDeviationRelative !== undefined) {
            meridionalDeviationRelative *= mirrorSignValue;
        }
        if (sagittalDeviationRelative !== null && sagittalDeviationRelative !== undefined) {
            sagittalDeviationRelative *= mirrorSignValue;
        }
        
        // Draw Cross十字線データを取得（像面上のX, Y座標）
        let crossBeamIntersections = null;
        
        // 評価面（最終面）での実際のX, Y座標を使用（投影不要）
        // chiefRayResult.rayGroupsから直接取得し、評価面での座標を取得
        if (chiefRayResult.rayGroups && chiefRayResult.rayGroups[0]) {
            const rayGroup = chiefRayResult.rayGroups[0];
            
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
