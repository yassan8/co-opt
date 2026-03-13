/**
 * Cross Beam Generation for Infinite Object System
 * 無限系でクロスビームの生成
 * 
 * 仕様に基づいた実装:
 * 1. Object角度から方向ベクトル計算
 * 2. Stop面中心を通る主光線射出座標をニュートン法で探索
 * 3. 主光線に垂直な面内での絞り周辺光線探索
 * 4. クロスビーム生成とDraw Cross描画
 * 
 * 作成日: 2025/07/15
 */

import { traceRay, traceRayHitPoint, calculateSurfaceOrigins } from '../core/ray-tracing.ts';
import { getRustRayTracingWasmSync } from '../../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';
import { setWindowDebugBagValue } from '../../utils/window-debug-bag.ts';

const RENDER_RUST_TRACE_OPTIONS = {
    allowNonStrict: true,
    requireWasmRayTracing: false,
    useRustWasm: true,
    requireRustWasm: false,
    disableWasmRayTracing: false,
    __renderRayTracingRustPreferred: true
};

const REQUIRE_RUST_CROSS_BEAM = (() => {
    try {
        const v = String((globalThis as any)?.process?.env?.COOPT_REQUIRE_RUST_CROSS_BEAM ?? '').trim().toLowerCase();
        return v === '1' || v === 'true' || v === 'yes' || v === 'on';
    } catch (_) {
        return false;
    }
})();

function assertRustRenderTracingAvailable() {
    if (!REQUIRE_RUST_CROSS_BEAM) return;
    try {
        const rustReady = !!getRustRayTracingWasmSync();
        if (rustReady) return;
    } catch (_) {}
    throw new Error('Rust ray tracing WASM is unavailable for infinite cross-beam generation.');
}

function traceRayForRenderTs(opticalSystemRows, ray0, n0 = 1.0, debugLog = null, maxSurfaceIndex = null) {
    assertRustRenderTracingAvailable();
    return traceRay(opticalSystemRows, ray0, n0, debugLog, maxSurfaceIndex, RENDER_RUST_TRACE_OPTIONS);
}

function traceRayHitPointForRenderTs(opticalSystemRows, ray0, n0 = 1.0, targetSurfaceIndex = null) {
    assertRustRenderTracingAvailable();
    return traceRayHitPoint(opticalSystemRows, ray0, n0, targetSurfaceIndex, RENDER_RUST_TRACE_OPTIONS);
}

const CHIEF_RUST_TRACE_OPTIONS = {
    allowNonStrict: true,
    useRustWasm: true,
    requireRustWasm: false
};

function traceRayHitPointForChiefSearch(opticalSystemRows, ray0, n0 = 1.0, targetSurfaceIndex = null) {
    assertRustRenderTracingAvailable();
    return traceRayHitPoint(opticalSystemRows, ray0, n0, targetSurfaceIndex, CHIEF_RUST_TRACE_OPTIONS as any);
}

// Runtime build stamp (for cache/stale-module diagnostics)
const GEN_RAY_CROSS_INFINITE_BUILD = '2025-12-31a';
if (typeof window !== 'undefined') {
    setWindowDebugBagValue('buildStamps', 'genRayCrossInfinite', GEN_RAY_CROSS_INFINITE_BUILD);
}

function isCoordTransRow(row) {
    const stRaw = String(row?.surfType ?? row?.['surf type'] ?? row?.surface_type ?? '').toLowerCase();
    const st = stRaw.trim();
    return st === 'coord trans' || st === 'coordinate transform' || st === 'coordtrans' || st === 'coordinatebreak' || st === 'ct';
}

function isObjectRow(row) {
    const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();
    return t === 'object';
}

function isGapRow(row) {
    const fields = [
        row?.blockType, row?._blockType, row?.block_type, row?.blockTypeName,
        row?.['object type'], row?.object, row?.Object,
        row?.type, row?.Type,
        row?.comment, row?.Comment
    ];
    const isGap = (v) => {
        const s = String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        if (!s) return false;
        if (s === 'gap' || s === 'airgap') return true;
        return s.includes('airgap');
    };
    return fields.some(isGap);
}

function isStopRow(row) {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? row?.Type ?? '';
    const t = String(raw ?? '').trim().toLowerCase();
    return t === 'stop' || t === 'sto';
}

function isImageRow(row) {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? row?.Type ?? '';
    const normalized = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
    return normalized === 'image' || normalized.startsWith('image');
}

function setLastChiefRayResult(result) {
    try {
        if (typeof window === 'undefined') return;
        (window as any)['lastChiefRayResult'] = result;
    } catch (_) {
        // ignore
    }
}

// traceRay の rayPath は Object 行 / Coord Trans 行を交点として記録しない。
// surfaceIndex(テーブル行) -> rayPath の point index への変換を行う。
function getRayPathPointIndexForSurfaceIndex(opticalSystemRows, surfaceIndex) {
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

function getRayPointAtSurfaceIndex(rayPath, opticalSystemRows, surfaceIndex) {
    if (!Array.isArray(rayPath)) return null;
    const pIdx = getRayPathPointIndexForSurfaceIndex(opticalSystemRows, surfaceIndex);
    if (pIdx === null) return null;
    if (pIdx >= 0 && pIdx < rayPath.length) return rayPath[pIdx];
    return null;
}

function fnv1a32(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

const chiefRayOriginSearchCache = new Map<string, { x: number; y: number; z: number } | null>();

function buildChiefRayOriginSearchCacheKey(direction, stopCenter, stopSurfaceIndex, targetSurfaceIndex, opticalSystemRows, wavelength) {
    try {
        const rowsSig = fnv1a32(JSON.stringify((opticalSystemRows || []).map((row) => ({
            t: row?.surfType ?? row?.['object type'] ?? row?.object ?? row?.type,
            r: row?.radius,
            th: row?.thickness,
            k: row?.conic,
            s: row?.semidia,
            od: row?.objectRenderDistance
        }))));
        return [
            rowsSig,
            Number(direction?.i || 0).toFixed(10),
            Number(direction?.j || 0).toFixed(10),
            Number(direction?.k || 0).toFixed(10),
            Number(stopCenter?.x || 0).toFixed(10),
            Number(stopCenter?.y || 0).toFixed(10),
            Number(stopCenter?.z || 0).toFixed(10),
            Number(stopSurfaceIndex || 0),
            Number(targetSurfaceIndex || 0),
            Number(wavelength || 0).toFixed(10)
        ].join('#');
    } catch (_) {
        return null;
    }
}

function cooptParseNumberOrInfinity(value: any, fallback: number): number {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const s = String(value).trim();
    if (s === '') return fallback;
    if (/^inf(inity)?$/i.test(s)) return Infinity;
    const n = Number(s);
    return Number.isFinite(n) ? n : fallback;
}

function cooptNormalizeOpticalSystemRows(rows: any[]): any[] {
    if (!Array.isArray(rows)) return rows;
    return rows.map((row) => {
        if (!row || typeof row !== 'object') return row;
        const out = { ...row };
        out.radius = cooptParseNumberOrInfinity(row.radius ?? row.Radius, Infinity);
        out.thickness = cooptParseNumberOrInfinity(row.thickness ?? row.Thickness, 0);
        return out;
    });
}

function cooptResolveInfiniteObjectInitialZ(opticalSystemRows, renderDist, stopCenter) {
    if (typeof renderDist === 'number' && Number.isFinite(renderDist) && renderDist > 0) {
        return -Math.abs(renderDist);
    }

    let systemLength = 0;
    if (Array.isArray(opticalSystemRows)) {
        for (let i = 0; i < opticalSystemRows.length; i++) {
            const tRaw = opticalSystemRows[i]?.thickness ?? opticalSystemRows[i]?.Thickness;
            const t = (typeof tRaw === 'number') ? tRaw : parseFloat(String(tRaw ?? ''));
            if (Number.isFinite(t) && Math.abs(t) < 1e6) {
                systemLength += Math.abs(t);
            }
        }
    }

    const stopZ = Number.isFinite(stopCenter?.z) ? Math.abs(stopCenter.z) : 0;
    const fallbackDist = Math.max(100, systemLength * 2, stopZ + 100);
    return -fallbackDist;
}

function fingerprintOpticalSystemRows(opticalSystemRows) {
    try {
        if (!Array.isArray(opticalSystemRows)) return { len: 0, hash: '00000000' };
        let acc = '';
        for (let i = 0; i < opticalSystemRows.length; i++) {
            const row = opticalSystemRows[i] || {};
            const objectType = String(row['object type'] ?? row.object ?? row.Object ?? row.type ?? '').trim();
            const surfType = String(row.surfType ?? row['surf type'] ?? '').trim();
            const thickness = String(row.thickness ?? '').trim();
            const semidia = String(row.semidia ?? row.semiDia ?? row.semiDiameter ?? row['semi-diameter'] ?? '').trim();
            const radius = String(row.radius ?? row.aperture ?? row.diameter ?? '').trim();
            const curvature = String(row.curvature ?? '').trim();
            const material = String(row.material ?? row.glass ?? row['glass name'] ?? '').trim();
            acc += `${i}|${objectType}|${surfType}|t=${thickness}|sd=${semidia}|r=${radius}|c=${curvature}|m=${material};`;
        }
        return { len: opticalSystemRows.length, hash: fnv1a32(acc) };
    } catch (_) {
        return { len: Array.isArray(opticalSystemRows) ? opticalSystemRows.length : 0, hash: '????????' };
    }
}

function _extractFirstApertureBlockFromDebugLog(debugLog) {
    try {
        if (!Array.isArray(debugLog) || debugLog.length === 0) return null;
        // Look for the explicit marker; both PLANE and general surface branches use this text.
        const idx = debugLog.findIndex(l => typeof l === 'string' && l.includes('PHYSICAL APERTURE BLOCK'));
        if (idx < 0) return null;
        const windowLines = debugLog.slice(Math.max(0, idx - 2), Math.min(debugLog.length, idx + 8));

        // Try to parse surface number from the marker line.
        let surfaceNumber = null;
        const mSurf = String(debugLog[idx]).match(/Surface\s+(\d+)/i);
        if (mSurf) surfaceNumber = Number(mSurf[1]);

        // Try to parse hit/aperture line.
        let hitRadiusMm = null;
        let apertureLimitMm = null;
        for (const line of windowLines) {
            const m = String(line).match(/Hit radius:\s*([0-9.+\-eE]+)mm\s*>\s*Aperture limit:\s*([0-9.+\-eE]+)mm/i);
            if (m) {
                hitRadiusMm = Number(m[1]);
                apertureLimitMm = Number(m[2]);
                break;
            }
        }

        return { surfaceNumber, hitRadiusMm, apertureLimitMm, lines: windowLines };
    } catch {
        return null;
    }
}

/**
 * Local implementation of findStopSurface to avoid Three.js dependency
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Array} surfaceOrigins - 面原点データ（オプション）
 * @returns {Object|null} 絞り面情報
 */
function findStopSurface(opticalSystemRows, surfaceOrigins = null) {
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        return null; // No optical system rows provided
    }
    
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];

        if (isStopRow(surface) || (String(surface?.comment ?? surface?.Comment ?? '').toLowerCase().includes('stop'))) {
            const oRaw = (surfaceOrigins && surfaceOrigins[i]) ? surfaceOrigins[i] : null;
            const o = (oRaw && oRaw.origin) ? oRaw.origin : oRaw;
            const stopCenter = {
                x: (o && Number.isFinite(o.x)) ? o.x : 0,
                y: (o && Number.isFinite(o.y)) ? o.y : 0,
                z: (o && Number.isFinite(o.z)) ? o.z : 0
            };
            
            // Stop面の半径を取得
            let stopRadius = 10; // デフォルト値
            const radiusFields = [
                'semidia', 'semiDiameter', 'semi-diameter', 'semi_diameter',
                'radius', 'aperture', 'diameter', 'semi-dia',
                'semiDia', 'aper', 'halfDiameter', 'half-diameter',
                'Clear_Aperture', 'clearAperture', 'clear_aperture'
            ];
            
            for (const field of radiusFields) {
                const value = surface[field];
                if (value !== undefined && value !== null && value !== '') {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue)) {
                        stopRadius = numValue;
                        break;
                    }
                }
            }
            
            if (isNaN(stopRadius)) {
                stopRadius = 10;
            }
            
            return {
                surface: surface,
                index: i,
                center: stopCenter,
                position: stopCenter,
                radius: stopRadius,
                origin: o
            };
        }
    }
    
    return null;
}

function refineChiefDirectionToStopCenter(
    chiefOrigin,
    initialDirection,
    stopCenter,
    stopSurfaceIndex,
    opticalSystemRows,
    wavelength,
    maxIter = 20,
    tol = 1e-4
) {
    if (!chiefOrigin || !initialDirection || !stopCenter || !Number.isInteger(stopSurfaceIndex)) return null;

    const origin = {
        x: Number(chiefOrigin.x),
        y: Number(chiefOrigin.y),
        z: Number(chiefOrigin.z)
    };
    if (![origin.x, origin.y, origin.z].every(Number.isFinite)) return null;

    const stopX = Number(stopCenter.x);
    const stopY = Number(stopCenter.y);
    if (!Number.isFinite(stopX) || !Number.isFinite(stopY)) return null;

    const i0 = Number(initialDirection.i) || 0;
    const j0 = Number(initialDirection.j) || 0;
    const k0 = Number(initialDirection.k) || 1;
    if (!Number.isFinite(k0) || Math.abs(k0) < 1e-12) return null;

    let sx = i0 / k0;
    let sy = j0 / k0;

    const normalizeDir = (ux, uy) => {
        const inv = 1 / Math.sqrt(1 + ux * ux + uy * uy);
        return { i: ux * inv, j: uy * inv, k: 1 * inv };
    };

    const evaluate = (ux, uy) => {
        const d = normalizeDir(ux, uy);
        const ray = {
            pos: { ...origin },
            dir: { x: d.i, y: d.j, z: d.k },
            wavelength
        };
        const hit = traceRayHitPointForChiefSearch(opticalSystemRows, ray, 1.0, stopSurfaceIndex);
        if (!hit) return { valid: false, error: Infinity, hit: null, dir: d };
        const ex = hit.x - stopX;
        const ey = hit.y - stopY;
        return { valid: true, error: Math.hypot(ex, ey), ex, ey, hit, dir: d };
    };

    let best = evaluate(sx, sy);
    if (!best.valid) return null;
    if (best.error <= tol) return best.dir;

    for (let iter = 0; iter < maxIter; iter++) {
        const center = evaluate(sx, sy);
        if (!center.valid) break;
        if (center.error < best.error) best = center;
        if (center.error <= tol) return center.dir;

        const eps = Math.max(1e-5, 1e-4 * (1 + center.error));
        const ex = evaluate(sx + eps, sy);
        const ey = evaluate(sx, sy + eps);
        if (!ex.valid || !ey.valid) break;

        const j11 = (ex.hit.x - center.hit.x) / eps;
        const j21 = (ex.hit.y - center.hit.y) / eps;
        const j12 = (ey.hit.x - center.hit.x) / eps;
        const j22 = (ey.hit.y - center.hit.y) / eps;

        const det = j11 * j22 - j12 * j21;
        let dsx;
        let dsy;

        if (!Number.isFinite(det) || Math.abs(det) < 1e-14) {
            dsx = -0.2 * center.ex;
            dsy = -0.2 * center.ey;
        } else {
            dsx = (-j22 * center.ex + j12 * center.ey) / det;
            dsy = (j21 * center.ex - j11 * center.ey) / det;
        }

        if (!Number.isFinite(dsx) || !Number.isFinite(dsy)) break;

        const maxStep = 0.05;
        const norm = Math.hypot(dsx, dsy);
        if (norm > maxStep) {
            const scale = maxStep / norm;
            dsx *= scale;
            dsy *= scale;
        }

        let accepted = false;
        let alpha = 1;
        for (let ls = 0; ls < 10; ls++) {
            const nsx = sx + alpha * dsx;
            const nsy = sy + alpha * dsy;
            const next = evaluate(nsx, nsy);
            if (next.valid && next.error < center.error) {
                sx = nsx;
                sy = nsy;
                accepted = true;
                if (next.error < best.error) best = next;
                break;
            }
            alpha *= 0.5;
        }
        if (!accepted) break;
    }

    return best && best.valid && best.error <= Math.max(tol, 5e-4) ? best.dir : null;
}

// 色分けシステム（有限系と同じ仕様）
const RayColorSystem = {
    // Object色分け（オブジェクトポイント別）
    OBJECT_COLORS: [
        0xff0000, // Red - Object 1
        0x00ff00, // Green - Object 2  
        0x0000ff, // Blue - Object 3
        0xffff00, // Yellow - Object 4
        0xff00ff, // Magenta - Object 5
        0x00ffff, // Cyan - Object 6
        0xffa500, // Orange - Object 7
        0x800080, // Purple - Object 8
        0xffc0cb, // Pink - Object 9
        0xa52a2a  // Brown - Object 10
    ],
    
    // Segment色分け（光線タイプ別）
    SEGMENT_COLORS: {
        chief: 0xff0000,          // 主光線 - Red
        upper_marginal: 0x00ff00, // 上マージナル光線 - Green
        lower_marginal: 0x0000ff, // 下マージナル光線 - Blue
        left_marginal: 0xffff00,  // 左マージナル光線 - Yellow
        right_marginal: 0xff00ff, // 右マージナル光線 - Magenta
        aperture_up: 0x00ffff,    // 絞り上端 - Cyan
        aperture_down: 0xffa500,  // 絞り下端 - Orange
        aperture_left: 0x800080   // 絞り左端 - Purple
    },
    
    // 色分けモード
    MODE: {
        OBJECT: 'object',
        SEGMENT: 'segment'
    },
    
    // 色を取得する関数
    getColor(mode, objectIndex, segmentType) {
        if (mode === this.MODE.OBJECT) {
            return this.OBJECT_COLORS[objectIndex % this.OBJECT_COLORS.length];
        } else if (mode === this.MODE.SEGMENT) {
            return this.SEGMENT_COLORS[segmentType] || 0xffffff; // デフォルト白
        }
        return 0xffffff; // デフォルト白
    }
};

/**
 * 主光線に垂直な面内での絞り周辺光線検索（新実装）
 * 二分法により絞り境界に最も近い光線を検索
 * @param {Object} chiefOrigin - 主光線出発点 {x, y, z}
 * @param {Object} direction - 主光線方向ベクトル {x, y, z}
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} stopInfo - 絞り面情報
 * @param {Object} options - オプション
 * @returns {Array} 4方向の周辺光線情報
 */
export function findApertureBoundaryRays(chiefOrigin, direction, opticalSystemRows, stopInfo, options: any = {}) {
    const { debugMode = false, wavelength = 0.5876, targetSurfaceIndex = null } = options;
    const tolerance = 0.001; // 0.001mm精度
    
    // 主光線方向に垂直な基底ベクトルを生成
    const basis = makeBasis(direction);
    
    // 絞り半径の2倍を検索範囲とする
    const searchRadius = (stopInfo.radius || 10) * 2;
    
    if (debugMode) {
        console.log(`🔍 [ApertureBoundary] 絞り周辺光線検索開始`);
        console.log(`   検索範囲: ±${searchRadius.toFixed(2)}mm`);
        console.log(`   許容誤差: ${tolerance}mm`);
    }
    
    const boundaryRays = [];
    const directions = [
        { name: 'upper', vector: { x: 0, y: 1 } },      // +y'方向
        { name: 'lower', vector: { x: 0, y: -1 } },   // -y'方向
        { name: 'right', vector: { x: 1, y: 0 } },   // +x'方向
        { name: 'left', vector: { x: -1, y: 0 } }    // -x'方向
    ];
    
    for (const dir of directions) {
        if (debugMode) {
            console.log(`  🎯 [${dir.name}] 方向検索開始`);
        }
        
        // 二分法で絞り境界を検索
        const boundaryDistance = binarySearchApertureBoundary(
            chiefOrigin, direction, basis, dir.vector, 
            searchRadius, opticalSystemRows, tolerance, debugMode, wavelength, targetSurfaceIndex
        );
        
        if (boundaryDistance !== null) {
            // 境界点の3D座標を計算
            const boundaryPoint = {
                x: chiefOrigin.x + boundaryDistance * (basis.x.x * dir.vector.x + basis.y.x * dir.vector.y),
                y: chiefOrigin.y + boundaryDistance * (basis.x.y * dir.vector.x + basis.y.y * dir.vector.y),
                z: chiefOrigin.z + boundaryDistance * (basis.x.z * dir.vector.x + basis.y.z * dir.vector.y)
            };
            
            boundaryRays.push({
                direction: dir.name,
                origin: boundaryPoint,
                rayDirection: direction,
                distance: boundaryDistance,
                type: ['upper', 'lower'].includes(dir.name) ? 'vertical_cross' : 'horizontal_cross'
            });
            
            if (debugMode) {
                console.log(`    ✅ 境界発見: distance=${boundaryDistance.toFixed(3)}mm`);
            }
        } else {
            if (debugMode) {
                console.log(`    ❌ 境界未発見`);
            }
        }
    }
    
    return boundaryRays;
}

/**
 * 二分法による絞り境界検索
 * @param {Object} chiefOrigin - 主光線出発点
 * @param {Object} direction - 主光線方向
 * @param {Object} basis - 垂直面の基底ベクトル
 * @param {Object} searchVector - 検索方向ベクトル（2D）
 * @param {number} maxDistance - 最大検索距離
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} tolerance - 許容誤差
 * @param {boolean} debugMode - デバッグモード
 * @param {number} wavelength - 波長（デフォルト0.5876μm）
 * @returns {number|null} 境界距離（見つからない場合はnull）
 */
function binarySearchApertureBoundary(chiefOrigin, direction, basis, searchVector, maxDistance, opticalSystemRows, tolerance, debugMode, wavelength = 0.5876, targetSurfaceIndex = null) {
    let minDistance = 0; // 絞り内側（光線追跡成功）
    let maxDistance_current = maxDistance; // 絞り外側（光線追跡失敗）
    
    // 初期状態確認：0点（主光線位置）は成功するはず
    const testOriginAtZero = chiefOrigin;
    const traceSuccessAtZero = canTraceToFinalSurface(testOriginAtZero, direction, opticalSystemRows, wavelength, targetSurfaceIndex);
    
    if (!traceSuccessAtZero) {
        if (debugMode) {
            console.log(`    ⚠️ 主光線位置で光線追跡失敗`);
        }
        return null;
    }
    
    // 最大距離で失敗することを確認
    const testOriginAtMax = {
        x: chiefOrigin.x + maxDistance * (basis.x.x * searchVector.x + basis.y.x * searchVector.y),
        y: chiefOrigin.y + maxDistance * (basis.x.y * searchVector.x + basis.y.y * searchVector.y),
        z: chiefOrigin.z + maxDistance * (basis.x.z * searchVector.x + basis.y.z * searchVector.y)
    };
    const traceSuccessAtMax = canTraceToFinalSurface(testOriginAtMax, direction, opticalSystemRows, wavelength, targetSurfaceIndex);
    
    if (traceSuccessAtMax) {
        if (debugMode) {
            console.log(`    ⚠️ 最大距離でも光線追跡成功 - 検索範囲拡大が必要`);
        }
        return maxDistance; // 境界がより遠くにある
    }
    
    // 二分法実行
    let iterations = 0;
    const maxIterations = 50;
    
    while ((maxDistance_current - minDistance) > tolerance && iterations < maxIterations) {
        const midDistance = (minDistance + maxDistance_current) / 2;
        
        // 中点での光線追跡テスト
        const testOrigin = {
            x: chiefOrigin.x + midDistance * (basis.x.x * searchVector.x + basis.y.x * searchVector.y),
            y: chiefOrigin.y + midDistance * (basis.x.y * searchVector.x + basis.y.y * searchVector.y),
            z: chiefOrigin.z + midDistance * (basis.x.z * searchVector.x + basis.y.z * searchVector.y)
        };
        
        const traceSuccess = canTraceToFinalSurface(testOrigin, direction, opticalSystemRows, wavelength, targetSurfaceIndex);
        
        if (traceSuccess) {
            // 成功 → より遠くに境界がある
            minDistance = midDistance;
        } else {
            // 失敗 → より近くに境界がある
            maxDistance_current = midDistance;
        }
        
        iterations++;
        
        if (debugMode && iterations % 10 === 0) {
        }
    }
    
    // 境界距離を返す（成功する最大距離）
    return minDistance;
}

/**
 * 光学系最終面まで光線追跡可能かテスト
 * @param {Object} origin - 光線出発点
 * @param {Object} direction - 光線方向
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} wavelength - 波長（デフォルト0.5876μm）
 * @returns {boolean} 追跡成功/失敗
 */
function canTraceToFinalSurface(origin, direction, opticalSystemRows, wavelength = 0.5876, targetSurfaceIndex = null) {
    try {
        const effectiveTargetIndex = Number.isInteger(targetSurfaceIndex)
            ? targetSurfaceIndex
            : Math.max(0, (opticalSystemRows?.length ?? 1) - 1);
        const effectiveTargetPointIndex = getRayPathPointIndexForSurfaceIndex(opticalSystemRows, effectiveTargetIndex);
        if (effectiveTargetPointIndex === null) return false;

        const rayPath = traceRayForRenderTs(
            opticalSystemRows,
            { pos: origin, dir: direction, wavelength: wavelength },
            1.0,
            null,
            effectiveTargetIndex
        );

        return Array.isArray(rayPath) && rayPath.length > effectiveTargetPointIndex;
    } catch (error) {
        return false;
    }
}

/**
 * 主光線方向に垂直な基底ベクトルを生成
 * @param {Object} direction - 主光線方向ベクトル
 * @returns {Object} 基底ベクトル {x: {x,y,z}, y: {x,y,z}}
 */
function makeBasis(direction) {
    // 正規化
    const len = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
    const d = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
    
    // 第一基底ベクトル（x軸方向）
    const ref = Math.abs(d.z) < 0.95 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    let ex = {
        x: d.y * ref.z - d.z * ref.y,
        y: d.z * ref.x - d.x * ref.z,
        z: d.x * ref.y - d.y * ref.x
    };
    
    // 正規化
    const exLen = Math.sqrt(ex.x * ex.x + ex.y * ex.y + ex.z * ex.z);
    ex = { x: ex.x / exLen, y: ex.y / exLen, z: ex.z / exLen };
    
    // 第二基底ベクトル（y軸方向）
    let ey = {
        x: d.y * ex.z - d.z * ex.y,
        y: d.z * ex.x - d.x * ex.z,
        z: d.x * ex.y - d.y * ex.x
    };
    
    // 正規化
    const eyLen = Math.sqrt(ey.x * ey.x + ey.y * ey.y + ey.z * ey.z);
    ey = { x: ey.x / eyLen, y: ey.y / eyLen, z: ey.z / eyLen };
    
    return { x: ex, y: ey };
}

/**
 * 境界光線データからクロスビーム光線を生成
 * @param {Object} chiefOrigin - 主光線出発点
 * @param {Object} direction - 主光線方向ベクトル
 * @param {Array} boundaryRays - 境界光線配列
 * @param {number} rayCount - 生成する光線数
 * @param {string} crossType - クロスタイプ
 * @param {boolean} debugMode - デバッグモード
 * @param {number} objectIndex - オブジェクトインデックス
 * @returns {Array} クロスビーム光線配列
 */
function generateCrossBeamFromBoundaryRays(chiefOrigin, direction, boundaryRays, rayCount, crossType, debugMode, objectIndex, wavelength = 0.5876) {
    const rays = [];
    
    // 1. 主光線を追加
    rays.push({
        origin: chiefOrigin,
        direction: direction,
        type: 'chief',
        role: 'chief',
        objectIndex: objectIndex,
        wavelength
    });

    if (rayCount <= 1) {
        if (debugMode) {
            console.log(`🔧 [CrossBeam] Object${objectIndex}: rayCount=${rayCount}, chief only`);
        }
        return rays;
    }
    
    if (debugMode) {
        console.log(`🔧 [CrossBeam] Object${objectIndex}: 主光線追加`);
    }
    
    // 2. 境界光線を分類（方向名を正しくマッピング）
    const verticalRays = boundaryRays.filter(r => ['upper', 'lower'].includes(r.direction));
    const horizontalRays = boundaryRays.filter(r => ['left', 'right'].includes(r.direction));
    
    // rayCount を厳守するため、chief 以外の本数を配分
    let remainingCount = Math.max(0, rayCount - 1);
    const useVertical = (crossType === 'both' || crossType === 'vertical') && verticalRays.length >= 2;
    const useHorizontal = (crossType === 'both' || crossType === 'horizontal') && horizontalRays.length >= 2;
    const verticalTargetCount = useVertical
        ? (useHorizontal ? Math.floor(remainingCount / 2) : remainingCount)
        : 0;
    const horizontalTargetCount = useHorizontal
        ? (useVertical ? (remainingCount - verticalTargetCount) : remainingCount)
        : 0;

    // 3. 垂直クロスビーム生成
    if (verticalTargetCount > 0 && useVertical) {
        const upRay = verticalRays.find(r => r.direction === 'upper');
        const downRay = verticalRays.find(r => r.direction === 'lower');
        
        if (upRay && downRay) {
            const verticalCrossRays = generateRaysBetweenBoundaries(
                upRay, downRay, direction, verticalTargetCount, 'vertical_cross', objectIndex, wavelength
            );
            rays.push(...verticalCrossRays);
            
            if (debugMode) {
                console.log(`🔧 [CrossBeam] Object${objectIndex}: 垂直光線 ${verticalCrossRays.length}本生成`);
            }
        }
    }
    
    // 4. 水平クロスビーム生成
    if (horizontalTargetCount > 0 && useHorizontal) {
        const leftRay = horizontalRays.find(r => r.direction === 'left');
        const rightRay = horizontalRays.find(r => r.direction === 'right');
        
        if (leftRay && rightRay) {
            const horizontalCrossRays = generateRaysBetweenBoundaries(
                leftRay, rightRay, direction, horizontalTargetCount, 'horizontal_cross', objectIndex, wavelength
            );
            rays.push(...horizontalCrossRays);
            
            if (debugMode) {
                console.log(`🔧 [CrossBeam] Object${objectIndex}: 水平光線 ${horizontalCrossRays.length}本生成`);
            }
        }
    }
    
    if (debugMode) {
        console.log(`✅ [CrossBeam] Object${objectIndex}: 総光線数 ${rays.length}本生成完了`);
    }
    
    return rays;
}

function generateParallelPointsFromOffsetsViaRust(origin, uAxis, vAxis, offsets) {
    try {
        const rust = getRustRayTracingWasmSync();
        const rustFn = rust?.generate_parallel_start_points_flat;
        if (typeof rustFn !== 'function') return null;
        const count = Array.isArray(offsets) ? offsets.length : 0;
        if (count <= 0) return [];

        const flatOffsets = new Float64Array(count * 2);
        for (let i = 0; i < count; i++) {
            flatOffsets[i * 2] = Number(offsets[i]?.u) || 0;
            flatOffsets[i * 2 + 1] = Number(offsets[i]?.v) || 0;
        }

        const flat = rustFn(
            new Float64Array([Number(origin?.x) || 0, Number(origin?.y) || 0, Number(origin?.z) || 0]),
            new Float64Array([Number(uAxis?.x) || 0, Number(uAxis?.y) || 0, Number(uAxis?.z) || 0]),
            new Float64Array([Number(vAxis?.x) || 0, Number(vAxis?.y) || 0, Number(vAxis?.z) || 0]),
            flatOffsets,
            count
        );

        if (!flat || typeof (flat as any).length !== 'number') return null;
        const out = [];
        for (let i = 0; i + 4 < (flat as any).length; i += 5) {
            out.push({
                x: Number((flat as any)[i]) || 0,
                y: Number((flat as any)[i + 1]) || 0,
                z: Number((flat as any)[i + 2]) || 0,
                u: Number((flat as any)[i + 3]) || 0,
                v: Number((flat as any)[i + 4]) || 0
            });
        }
        return out;
    } catch (_) {
        return null;
    }
}

function generateCrossBeamFromEntrancePupil(centerOrigin, direction, planeU, planeV, radius, rayCount, crossType, objectIndex, wavelength, extents = null) {
    const rays = [];

    const uPos = (extents && Number.isFinite(extents.uPos)) ? extents.uPos : radius;
    const uNeg = (extents && Number.isFinite(extents.uNeg)) ? extents.uNeg : radius;
    const vPos = (extents && Number.isFinite(extents.vPos)) ? extents.vPos : radius;
    const vNeg = (extents && Number.isFinite(extents.vNeg)) ? extents.vNeg : radius;

    // 1. Chief ray (center)
    rays.push({
        origin: centerOrigin,
        direction,
        type: 'chief',
        role: 'chief',
        objectIndex,
        wavelength
    });

    if (rayCount <= 1) {
        return rays;
    }

    const mk = (base, axis, s) => ({
        x: base.x + axis.x * s,
        y: base.y + axis.y * s,
        z: base.z + axis.z * s
    });

    const addLineFromOffsets = (lineOffsets, type, roleStart, roleEnd) => {
        if (!Array.isArray(lineOffsets) || lineOffsets.length < 1) return;

        const rustPoints = generateParallelPointsFromOffsetsViaRust(centerOrigin, planeU, planeV, lineOffsets);
        const points = (Array.isArray(rustPoints) && rustPoints.length === lineOffsets.length)
            ? rustPoints
            : lineOffsets.map(ofs => ({
                x: centerOrigin.x + planeU.x * ofs.u + planeV.x * ofs.v,
                y: centerOrigin.y + planeU.y * ofs.u + planeV.y * ofs.v,
                z: centerOrigin.z + planeU.z * ofs.u + planeV.z * ofs.v
            }));

        for (let i = 0; i < points.length; i++) {
            const role = (points.length === 1)
                ? `${type}_center`
                : ((i === 0)
                    ? roleStart
                    : ((i === points.length - 1) ? roleEnd : `${type}_${i}`));
            rays.push({
                origin: points[i],
                direction,
                type,
                role,
                objectIndex,
                wavelength
            });
        }
    };

    let remainingCount = Math.max(0, rayCount - 1);
    const useVertical = (crossType === 'both' || crossType === 'vertical');
    const useHorizontal = (crossType === 'both' || crossType === 'horizontal');
    const verticalTargetCount = useVertical
        ? (useHorizontal ? Math.floor(remainingCount / 2) : remainingCount)
        : 0;
    const horizontalTargetCount = useHorizontal
        ? (useVertical ? (remainingCount - verticalTargetCount) : remainingCount)
        : 0;

    // Use planeV as "vertical" and planeU as "horizontal" to match Draw Cross conventions.
    if (verticalTargetCount > 0) {
        const verticalOffsets = [];
        if (verticalTargetCount === 1) {
            verticalOffsets.push({ u: 0, v: vPos });
        } else {
            const den = Math.max(1, verticalTargetCount - 1);
            for (let i = 0; i < verticalTargetCount; i++) {
                const t = i / den;
                const v = vPos + t * (-vNeg - vPos);
                verticalOffsets.push({ u: 0, v });
            }
        }
        addLineFromOffsets(verticalOffsets, 'vertical_cross', 'upper', 'lower');
    }

    if (horizontalTargetCount > 0) {
        const horizontalOffsets = [];
        if (horizontalTargetCount === 1) {
            horizontalOffsets.push({ u: uPos, v: 0 });
        } else {
            const den = Math.max(1, horizontalTargetCount - 1);
            for (let i = 0; i < horizontalTargetCount; i++) {
                const t = i / den;
                const u = -uNeg + t * (uPos + uNeg);
                horizontalOffsets.push({ u, v: 0 });
            }
        }
        addLineFromOffsets(horizontalOffsets, 'horizontal_cross', 'left', 'right');
    }

    return rays;
}

function estimateEffectiveEntrancePupilExtents(opticalSystemRows, centerOrigin, directionXYZ, planeU, planeV, radiusGuess, targetSurfaceIndex, wavelength, iterations = 12, fallbackSurfaceIndex = null) {
    try {
        const systemRowsForTrace = Array.isArray(opticalSystemRows) ? opticalSystemRows.slice() : opticalSystemRows;
        let usedFallbackTarget = false;
        let effectiveTargetIndex = Number.isInteger(targetSurfaceIndex)
            ? targetSurfaceIndex
            : Math.max(0, (systemRowsForTrace?.length ?? 1) - 1);
        let effectiveTargetPointIndex = getRayPathPointIndexForSurfaceIndex(systemRowsForTrace, effectiveTargetIndex);
        if (effectiveTargetPointIndex === null) {
            return { uPos: radiusGuess, uNeg: radiusGuess, vPos: radiusGuess, vNeg: radiusGuess };
        }

        const traceOk = (origin) => {
            const rayPathToTarget = traceRayForRenderTs(systemRowsForTrace, {
                pos: origin,
                dir: directionXYZ,
                wavelength
            }, 1.0, null, effectiveTargetIndex);
            return Array.isArray(rayPathToTarget) && rayPathToTarget.length > effectiveTargetPointIndex;
        };

        const mk = (base, axis, s) => ({
            x: base.x + axis.x * s,
            y: base.y + axis.y * s,
            z: base.z + axis.z * s
        });

        const findMaxAlong = (axis) => {
            let lo = 0;
            let hi = Math.max(0, Number(radiusGuess) || 0);
            if (!(hi > 0)) return 0;
            if (traceOk(mk(centerOrigin, axis, hi))) return hi;
            for (let i = 0; i < iterations; i++) {
                const mid = 0.5 * (lo + hi);
                if (traceOk(mk(centerOrigin, axis, mid))) lo = mid;
                else hi = mid;
            }
            return lo;
        };

        // Check if chief ray from centerOrigin can reach target surface
        const centerTraceResult = traceOk(centerOrigin);
        
        if (!centerTraceResult) {
            const hasFallbackTarget = Number.isInteger(fallbackSurfaceIndex) && fallbackSurfaceIndex !== effectiveTargetIndex;
            if (hasFallbackTarget) {
                const fallbackPointIndex = getRayPathPointIndexForSurfaceIndex(systemRowsForTrace, fallbackSurfaceIndex);
                if (fallbackPointIndex !== null) {
                    const fallbackPath = traceRayForRenderTs(systemRowsForTrace, {
                        pos: centerOrigin,
                        dir: directionXYZ,
                        wavelength
                    }, 1.0, null, fallbackSurfaceIndex);
                    const fallbackReachable = Array.isArray(fallbackPath) && fallbackPath.length > fallbackPointIndex;
                    if (fallbackReachable) {
                        usedFallbackTarget = true;
                        effectiveTargetIndex = fallbackSurfaceIndex;
                        effectiveTargetPointIndex = fallbackPointIndex;
                    }
                }
            }
        }

        const centerTraceAfterFallback = traceOk(centerOrigin);
        if (!centerTraceAfterFallback) {
            // Try to get actual ray path for debugging with detailed logging
            const debugLog = [];
            const debugPath = traceRayForRenderTs(systemRowsForTrace, {
                pos: centerOrigin,
                dir: directionXYZ,
                wavelength
            }, 1.0, debugLog, effectiveTargetIndex);
            
            // Output debug log
            if (debugLog.length > 0) {
                console.error(`📋 [RayTrace Debug Log]:`);
                debugLog.forEach(line => console.error(`   ${line}`));
            }
            
            // Check first few surfaces to see where it fails
            const firstSurfaces = systemRowsForTrace.slice(0, 5).map((s, i) => ({
                index: i,
                type: s?.['object type'] || s?.object || s?.surfType || 'unknown',
                semidia: s?.semidia || s?.SemiDia || 'N/A',
                thickness: s?.thickness || 'N/A'
            }));
            
            console.error(`❌ [EntrancePupilExtents] Chief ray cannot reach target surface!`);
            console.error(`   Origin: (${centerOrigin.x.toFixed(3)}, ${centerOrigin.y.toFixed(3)}, ${centerOrigin.z.toFixed(3)})`);
            console.error(`   Direction: (${directionXYZ.x.toFixed(6)}, ${directionXYZ.y.toFixed(6)}, ${directionXYZ.z.toFixed(6)})`);
            console.error(`   Target surface: ${effectiveTargetIndex}, Path length: ${debugPath?.length || 0}/${effectiveTargetPointIndex + 1}`);
            console.error(`   First 5 surfaces:`, firstSurfaces);
            firstSurfaces.forEach((s, idx) => {
                console.error(`     [${idx}] ${s.type}: semidia=${s.semidia}, thickness=${s.thickness}`);
            });
            
            return {
                uPos: radiusGuess,
                uNeg: radiusGuess,
                vPos: radiusGuess,
                vNeg: radiusGuess,
                __usedFallbackTarget: usedFallbackTarget,
                __targetSurfaceIndexUsed: effectiveTargetIndex
            };
        }

        const uPos = findMaxAlong(planeU);
        const uNeg = findMaxAlong({ x: -planeU.x, y: -planeU.y, z: -planeU.z });
        const vPos = findMaxAlong(planeV);
        const vNeg = findMaxAlong({ x: -planeV.x, y: -planeV.y, z: -planeV.z });

        return {
            uPos: Number.isFinite(uPos) ? uPos : 0,
            uNeg: Number.isFinite(uNeg) ? uNeg : 0,
            vPos: Number.isFinite(vPos) ? vPos : 0,
            vNeg: Number.isFinite(vNeg) ? vNeg : 0,
            __usedFallbackTarget: usedFallbackTarget,
            __targetSurfaceIndexUsed: effectiveTargetIndex
        };
    } catch (_) {
        return { uPos: radiusGuess, uNeg: radiusGuess, vPos: radiusGuess, vNeg: radiusGuess };
    }
}

function estimateEffectiveEntrancePupilRadius(opticalSystemRows, centerOrigin, directionXYZ, planeU, planeV, radiusGuess, targetSurfaceIndex, wavelength, iterations = 12) {
    try {
        const e = estimateEffectiveEntrancePupilExtents(
            opticalSystemRows,
            centerOrigin,
            directionXYZ,
            planeU,
            planeV,
            radiusGuess,
            targetSurfaceIndex,
            wavelength,
            iterations
        );
        const rMin = Math.min(e.uPos, e.uNeg, e.vPos, e.vNeg);
        return Number.isFinite(rMin) ? rMin : radiusGuess;
    } catch (_) {
        return radiusGuess;
    }
}

function buildEntrancePlaneAxesLikeOPD(directionXYZ) {
    const norm = (v) => {
        const m = Math.hypot(v.x, v.y, v.z) || 1;
        return { x: v.x / m, y: v.y / m, z: v.z / m };
    };
    const cross = (a, b) => ({
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x
    });

    const d = norm(directionXYZ);
    const helper = (Math.abs(d.z) < 0.9) ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
    let ex = cross(helper, d);
    const exMag = Math.hypot(ex.x, ex.y, ex.z);
    if (!(exMag > 1e-12)) {
        ex = cross({ x: 1, y: 0, z: 0 }, d);
    }
    ex = norm(ex);
    const ey = norm(cross(d, ex));
    return { ex, ey };
}

/**
 * 2つの境界光線間に中間光線を生成
 * @param {Object} ray1 - 境界光線1
 * @param {Object} ray2 - 境界光線2
 * @param {Object} direction - 光線方向ベクトル
 * @param {number} count - 生成する光線数
 * @param {string} type - 光線タイプ
 * @param {number} objectIndex - オブジェクトインデックス
 * @returns {Array} 中間光線配列
 */
function generateRaysBetweenBoundaries(ray1, ray2, direction, count, type, objectIndex, wavelength = 0.5876) {
    const rays = [];

    const targetCount = Math.max(0, Math.floor(Number(count) || 0));
    if (targetCount <= 0) {
        return rays;
    }

    if (targetCount === 1) {
        rays.push({
            origin: {
                x: (ray1.origin.x + ray2.origin.x) * 0.5,
                y: (ray1.origin.y + ray2.origin.y) * 0.5,
                z: (ray1.origin.z + ray2.origin.z) * 0.5
            },
            direction: direction,
            type: type,
            role: `${type}_center`,
            objectIndex: objectIndex,
            wavelength
        });
        return rays;
    }
    
    // 境界光線自体を追加
    rays.push({
        origin: ray1.origin,
        direction: direction,
        type: type,
        role: ray1.direction,
        objectIndex: objectIndex,
        wavelength
    });
    
    rays.push({
        origin: ray2.origin,
        direction: direction,
        type: type,
        role: ray2.direction,
        objectIndex: objectIndex,
        wavelength
    });
    
    // 中間光線を生成
    const intermediateCount = Math.max(0, targetCount - 2); // 境界光線2本を除く
    for (let i = 1; i <= intermediateCount; i++) {
        const t = i / (intermediateCount + 1); // 0から1の間で等間隔
        
        const intermediateOrigin = {
            x: ray1.origin.x + t * (ray2.origin.x - ray1.origin.x),
            y: ray1.origin.y + t * (ray2.origin.y - ray1.origin.y),
            z: ray1.origin.z + t * (ray2.origin.z - ray1.origin.z)
        };
        
        rays.push({
            origin: intermediateOrigin,
            direction: direction,
            type: type,
            role: `${type}_${i}`,
            objectIndex: objectIndex,
            wavelength
        });
    }
    
    return rays;
}

/**
 * Brent法による根探索アルゴリズム
 * ニュートン法より安定で、二分法より高速
 * @param {Function} f - 目的関数
 * @param {number} a - 探索区間の左端
 * @param {number} b - 探索区間の右端
 * @param {number} tol - 許容誤差
 * @param {number} maxIter - 最大反復回数
 * @returns {number} 根の近似値
 */
function brent(f, a, b, tol = 1e-8, maxIter = 100) {
    let fa = f(a), fb = f(b);
    
    // 初期区間で符号が変わっていることを確認
    if (fa * fb >= 0) {
        throw new Error("Brent法: 初期区間で符号が変わっていません");
    }

    let c = a, fc = fa;
    let d = b - a, e = d;

    for (let iter = 0; iter < maxIter; iter++) {
        // |f(c)| < |f(b)| になるように交換
        if (Math.abs(fc) < Math.abs(fb)) {
            a = b; b = c; c = a;
            fa = fb; fb = fc; fc = fa;
        }

        let tol1 = 2 * Number.EPSILON * Math.abs(b) + tol / 2;
        let m = 0.5 * (c - b);

        // 収束判定
        if (Math.abs(m) <= tol1 || Math.abs(fb) <= tol) {
            return b;
        }

        // 補間法を試行
        if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
            let s = fb / fa;
            let p, q;

            if (a === c) {
                // 線形補間（secant法）
                p = 2 * m * s;
                q = 1 - s;
            } else {
                // 逆二次補間
                let r = fc / fa;
                let t = fb / fc;
                p = s * (2 * m * r * (r - t) - (b - a) * (t - 1));
                q = (r - 1) * (t - 1) * (s - 1);
            }

            if (p > 0) q = -q;
            p = Math.abs(p);

            // 補間ステップが有効かチェック
            if (2 * p < Math.min(3 * m * q - Math.abs(tol1 * q), Math.abs(e * q))) {
                e = d; 
                d = p / q;
            } else {
                // 二分法にフォールバック
                d = m; 
                e = m;
            }
        } else {
            // 二分法
            d = m; 
            e = m;
        }

        a = b; 
        fa = fb;
        
        // 次の点を計算
        if (Math.abs(d) > tol1) {
            b += d;
        } else {
            b += (m > 0 ? tol1 : -tol1);
        }
        
        fb = f(b);

        // 新しい区間を設定（符号が変わる区間を維持）
        if ((fb > 0 && fc > 0) || (fb < 0 && fc < 0)) {
            c = a; 
            fc = fa; 
            e = d = b - a;
        }
    }

    throw new Error(`Brent法: ${maxIter}回の反復で収束しませんでした`);
}

/**
 * 無限系でのクロスビーム生成（メイン関数）
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Array} objectAngles - Object角度配列
 * @param {Object} options - オプション
 * @returns {Object} 生成結果
 */
export function generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, options: any = {}) {
    opticalSystemRows = cooptNormalizeOpticalSystemRows(opticalSystemRows);
    
    const {
        rayCount = 51,  // 31 → 51 に増加（絞り周辺により密な光線配置）
        debugMode = false,
        wavelength = 0.5876,
        crossType = 'both',
        targetSurfaceIndex = null,  // 評価面インデックス
        pupilSamplingMode = 'stop',
        logEntrancePupilConfig = false
    } = options;

    const resolvedTargetSurfaceIndex = (() => {
        const rows = Array.isArray(opticalSystemRows) ? opticalSystemRows : [];
        const imageSurfaceIndex = rows.findIndex((row: any) => row && isImageRow(row));

        if (Number.isInteger(targetSurfaceIndex)) {
            const requested = Math.max(0, Math.min(Number(targetSurfaceIndex), Math.max(0, rows.length - 1)));
            if (rows[requested] && isImageRow(rows[requested])) return requested;
            if (imageSurfaceIndex >= 0) {
                console.warn(`⚠️ [InfiniteSystem] targetSurfaceIndex=${requested} is not an Image row. Using detected Image index=${imageSurfaceIndex}.`);
                return imageSurfaceIndex;
            }
            return requested;
        }

        if (imageSurfaceIndex >= 0) return imageSurfaceIndex;
        return Math.max(0, rows.length - 1);
    })();

    if (debugMode) {
    }

    const angles = Array.isArray(objectAngles) ? objectAngles : [objectAngles];
    const allResults = [];

    for (let objectIndex = 0; objectIndex < angles.length; objectIndex++) {
        const objectAngle = angles[objectIndex];

        // 1. 角度から方向ベクトル計算
        const direction = calculateInfiniteSystemDirection(objectAngle);
        
        if (!direction) {
            console.warn(`⚠️ [InfiniteSystem] Object${objectIndex + 1}の方向ベクトル計算失敗: 角度(${objectAngle.x}°, ${objectAngle.y}°)`);
            continue;
        }
        
        // 高画角での方向ベクトルの妥当性チェック
        if (Math.abs(direction.k) < 1e-10) {
            console.warn(`⚠️ [InfiniteSystem] Object${objectIndex + 1}: 方向ベクトルのk成分が小さすぎます: ${direction.k}`);
            console.warn(`   角度(${objectAngle.x}°, ${objectAngle.y}°)でほぼ水平な光線のため、処理をスキップ`);
            continue;
        }
        
        if (direction.k <= 0) {
            console.warn(`⚠️ [InfiniteSystem] Object${objectIndex + 1}: 後方を向く方向ベクトル: k=${direction.k}`);
            console.warn(`   角度(${objectAngle.x}°, ${objectAngle.y}°)で90度以上の画角のため、処理をスキップ`);
            continue;
        }
        
        if (debugMode) {
        }

        // 2. Stop面情報の取得
        let surfaceOrigins = null;
        try {
            const sd = calculateSurfaceOrigins(opticalSystemRows);
            if (Array.isArray(sd) && sd.length === opticalSystemRows.length) {
                surfaceOrigins = sd.map(d => d?.origin ?? { x: 0, y: 0, z: 0 });
            }
        } catch (_) {
            surfaceOrigins = null;
        }
        
        const stopSurfaceInfo = findStopSurface(opticalSystemRows, surfaceOrigins);
        
        if (!stopSurfaceInfo) {
            console.warn(`⚠️ [InfiniteSystem] Object${objectIndex + 1}のStop面が見つかりません`);
            continue;
        }
        
        if (!stopSurfaceInfo.center) {
            console.warn(`⚠️ [InfiniteSystem] Object${objectIndex + 1}のStop面中心が未定義です`);
            console.warn(`   stopSurfaceInfo:`, stopSurfaceInfo);
            continue;
        }

        // 3. 主光線射出座標の探索
        const dirX = direction?.i;
        const dirY = direction?.j;
        const dirZ = direction?.k;
        const dirStr = (Number.isFinite(dirX) && Number.isFinite(dirY) && Number.isFinite(dirZ))
            ? `(${dirX.toFixed(6)}, ${dirY.toFixed(6)}, ${dirZ.toFixed(6)})`
            : '(invalid)';
        let chiefRayOrigin = findInfiniteSystemChiefRayOrigin(
            direction,
            stopSurfaceInfo.center,
            stopSurfaceInfo.index,
            opticalSystemRows,
            debugMode,
            resolvedTargetSurfaceIndex,
            wavelength
        );
        if (!chiefRayOrigin) {
            console.warn(`❌ [Chief Ray Failed] Object ${objectIndex + 1}: Could not find origin that reaches stop center`);
        }

        if (debugMode) {
        }

        // Stop中心に到達できる主光線が存在しない場合（強いビネッティング等）
        // → 以降の境界探索は前提（chiefがtrace可能）を満たさないため、このobjectはスキップ。
        if (!chiefRayOrigin) {
            console.warn(`⚠️ [InfiniteSystem] Object${objectIndex + 1}: Stop中心へ到達可能な主光線が見つかりません（stop unreachable）`);
            
            // Diagnose optical system validity
            diagnoseOpticalSystem(opticalSystemRows);

            // Fallback: 幾何学的推定で主光線発射点を生成し、以降の解析を継続する。
            try {
                const objectRow = opticalSystemRows && opticalSystemRows[0];
                const renderDist = (objectRow && typeof objectRow.objectRenderDistance === 'number') ? objectRow.objectRenderDistance : 0;
                const initialZ = cooptResolveInfiniteObjectInitialZ(opticalSystemRows, renderDist, stopSurfaceInfo?.center);
                const dzToStop = (stopSurfaceInfo?.center?.z ?? 0) - initialZ;
                const dx = direction?.i ?? 0;
                const dy = direction?.j ?? 0;
                const dk = direction?.k ?? 0;
                
                console.warn(`🔍 [Fallback Debug] renderDist=${renderDist}, initialZ=${initialZ}, dzToStop=${dzToStop}`);
                console.warn(`🔍 [Fallback Debug] direction=(${dx.toFixed(6)}, ${dy.toFixed(6)}, ${dk.toFixed(6)})`);
                console.warn(`🔍 [Fallback Debug] stopCenter=(${stopSurfaceInfo?.center?.x ?? 0}, ${stopSurfaceInfo?.center?.y ?? 0}, ${stopSurfaceInfo?.center?.z ?? 0})`);
                
                const safeK = (Math.abs(dk) > 1e-12) ? dk : 1.0;
                const guessX = (stopSurfaceInfo?.center?.x ?? 0) - (dx / safeK) * dzToStop;
                const guessY = (stopSurfaceInfo?.center?.y ?? 0) - (dy / safeK) * dzToStop;

                console.warn(`🔍 [Fallback Debug] Calculated guess=(${guessX.toFixed(3)}, ${guessY.toFixed(3)}, ${initialZ.toFixed(3)})`);

                if (Number.isFinite(guessX) && Number.isFinite(guessY) && Number.isFinite(initialZ)) {
                    chiefRayOrigin = { x: guessX, y: guessY, z: initialZ };
                    console.warn(`⚠️ [InfiniteSystem] Object${objectIndex + 1}: Fallback chief ray origin=(${guessX.toFixed(3)}, ${guessY.toFixed(3)}, ${initialZ.toFixed(3)})`);
                    
                    // Test if fallback ray can actually trace
                    const testRay = {
                        pos: { x: guessX, y: guessY, z: initialZ },
                        dir: { x: direction.i, y: direction.j, z: direction.k },
                        wavelength: wavelength
                    };
                    
                    try {
                        const prevSuppressFlag = (typeof globalThis !== 'undefined') ? globalThis.__COOPT_SUPPRESS_RAY_ERRORS : undefined;
                        try {
                            if (typeof globalThis !== 'undefined') globalThis.__COOPT_SUPPRESS_RAY_ERRORS = true;
                            const testPath = traceRayForRenderTs(opticalSystemRows, testRay, 1.0, null, resolvedTargetSurfaceIndex);
                            if (!testPath || testPath.length === 0) {
                                console.error(`❌ [Fallback Test] Ray tracing returned empty path - optical system may have invalid surfaces`);
                                console.error(`❌ [Fallback Test] Check for: zero radius, negative thickness, invalid glass indices, TIR, vignetting`);
                            } else {
                                console.warn(`✅ [Fallback Test] Ray traced through ${testPath.length} surfaces successfully`);
                            }
                        } finally {
                            if (typeof globalThis !== 'undefined') globalThis.__COOPT_SUPPRESS_RAY_ERRORS = prevSuppressFlag;
                        }
                    } catch (err) {
                        console.error(`❌ [Fallback Test] Ray tracing exception: ${err.message}`);
                    }
                    if (typeof window !== 'undefined') {
                        setLastChiefRayResult({
                            direction: direction,
                            optimalX: guessX,
                            optimalY: guessY,
                            error: 999.999,
                            method: 'fallback-guess'
                        });
                        outputChiefRayConvergenceToSystemData(
                            objectIndex + 1,
                            objectAngle.x || 0,
                            objectAngle.y || 0,
                            999.999,
                            'fallback-guess'
                        );
                    }
                } else {
                    if (typeof window !== 'undefined') {
                        setLastChiefRayResult({
                            direction: direction,
                            optimalX: NaN,
                            optimalY: NaN,
                            error: 999.999,
                            method: 'failed-stop-unreachable'
                        });
                        outputChiefRayConvergenceToSystemData(
                            objectIndex + 1,
                            objectAngle.x || 0,
                            objectAngle.y || 0,
                            999.999,
                            'failed-stop-unreachable'
                        );
                    }
                    continue;
                }
            } catch (_) {
                if (typeof window !== 'undefined') {
                    setLastChiefRayResult({
                        direction: direction,
                        optimalX: NaN,
                        optimalY: NaN,
                        error: 999.999,
                        method: 'failed-stop-unreachable'
                    });
                    outputChiefRayConvergenceToSystemData(
                        objectIndex + 1,
                        objectAngle.x || 0,
                        objectAngle.y || 0,
                        999.999,
                        'failed-stop-unreachable'
                    );
                }
                continue;
            }
        }

        // System Data出力: 主光線最適化結果（成功時またはフォールバック時）
        if (typeof window !== 'undefined') {
            // window.lastChiefRayResultが設定されていない場合の安全措置
            if (!window.lastChiefRayResult && chiefRayOrigin && stopSurfaceInfo) {
                console.warn(`⚠️ [SystemData] window.lastChiefRayResult が未設定。幾何学的推定値を使用します`);
                // 主光線がStop面中心からどれだけ離れているかを推定
                const estimatedError = Math.sqrt(
                    Math.pow(chiefRayOrigin.x - stopSurfaceInfo.center.x, 2) +
                    Math.pow(chiefRayOrigin.y - stopSurfaceInfo.center.y, 2)
                );
                setLastChiefRayResult({
                    direction: direction,
                    optimalX: chiefRayOrigin.x,
                    optimalY: chiefRayOrigin.y,
                    error: estimatedError,
                    method: 'geometric-approximation'
                });
            }
            
            if (window.lastChiefRayResult) {
                // 最適化結果あり（Brent法またはフォールバック）
                outputChiefRayConvergenceToSystemData(
                    objectIndex + 1,
                    objectAngle.x || 0,
                    objectAngle.y || 0,
                    window.lastChiefRayResult.error,
                    window.lastChiefRayResult.method
                );
                
                if (debugMode) {
                }
            } else {
                // 最適化結果も主光線もない（深刻なエラー）
                console.error(`❌ [SystemData] chiefRayOrigin も window.lastChiefRayResult も設定されていません`);
                
                outputChiefRayConvergenceToSystemData(
                    objectIndex + 1,
                    objectAngle.x || 0,
                    objectAngle.y || 0,
                    999.999,  // 誤差不明（大きな値）
                    'failed-no-data'
                );
            }
        } else {
        }

        // chiefRayOrigin は上で null チェック済み

        const refinedChiefDirection = refineChiefDirectionToStopCenter(
            chiefRayOrigin,
            direction,
            stopSurfaceInfo.center,
            stopSurfaceInfo.index,
            opticalSystemRows,
            wavelength
        );
        const chiefDirection = refinedChiefDirection || direction;

        // 4. 各objectの主光線に垂直な面を計算
        const perpendicularPlane = calculatePerpendicularPlane(chiefRayOrigin, chiefDirection, debugMode);
        
        if (!perpendicularPlane) {
            console.warn(`⚠️ [InfiniteSystem] Object${objectIndex + 1}の垂直面計算失敗`);
            continue;
        }

        // 5. Cross beam generation
        // - stop: boundary rays on the stop (legacy)
        // - entrance: rays sampled on the entrance pupil plane (aligned with OPD's entrance mode)

        const dirXYZ = { x: chiefDirection.i, y: chiefDirection.j, z: chiefDirection.k };
        let apertureBoundaryRays = [];
        let entrancePupil = null;
        let crossBeamRays = [];

        if (pupilSamplingMode === 'entrance') {
            const entranceAxes = buildEntrancePlaneAxesLikeOPD(dirXYZ);
            const entranceRadiusGuess = (() => {
                try {
                    const rows = Array.isArray(opticalSystemRows) ? opticalSystemRows : [];
                    for (let i = 0; i < rows.length; i++) {
                        const r = rows[i];
                        if (!r) continue;
                        if (String(r.surfType || '') === 'Coord Trans') continue;
                        if ((r['object type'] === 'Object') || (r.object === 'Object')) continue;
                        const semidia = parseFloat(r.semidia ?? r.SemiDia ?? r['semi dia'] ?? r['Semi Dia'] ?? '');
                        const aperture = parseFloat(r.aperture ?? r.Aperture ?? '');
                        if (Number.isFinite(semidia) && semidia > 0) return semidia;
                        if (Number.isFinite(aperture) && aperture > 0) return aperture / 2;
                    }
                } catch (_) {}
                return 20;
            })();

            const entranceExtents = estimateEffectiveEntrancePupilExtents(
                opticalSystemRows,
                chiefRayOrigin,
                dirXYZ,
                entranceAxes.ex,
                entranceAxes.ey,
                entranceRadiusGuess,
                resolvedTargetSurfaceIndex,
                wavelength,
                12,
                stopSurfaceInfo?.index
            );

            const effectiveRadius = Math.min(
                entranceExtents.uPos,
                entranceExtents.uNeg,
                entranceExtents.vPos,
                entranceExtents.vNeg
            );

            entrancePupil = {
                planeZ: chiefRayOrigin.z,
                centerOrigin: { x: chiefRayOrigin.x, y: chiefRayOrigin.y, z: chiefRayOrigin.z },
                u: entranceAxes.ex,
                v: entranceAxes.ey,
                radius: Number.isFinite(effectiveRadius) ? effectiveRadius : 0,
                extents: entranceExtents
            };

            const usedFallbackTarget = entranceExtents?.__usedFallbackTarget === true;
            if (usedFallbackTarget) {
                const boundaryTargetSurfaceIndex = Number.isInteger(stopSurfaceInfo?.index)
                    ? stopSurfaceInfo.index
                    : resolvedTargetSurfaceIndex;
                apertureBoundaryRays = findApertureBoundaryRays(
                    chiefRayOrigin,
                    dirXYZ,
                    opticalSystemRows,
                    stopSurfaceInfo,
                    { debugMode, wavelength, targetSurfaceIndex: boundaryTargetSurfaceIndex }
                );
                crossBeamRays = generateCrossBeamFromBoundaryRays(
                    chiefRayOrigin,
                    dirXYZ,
                    apertureBoundaryRays,
                    rayCount,
                    crossType,
                    debugMode,
                    objectIndex,
                    wavelength
                );
            } else {
                crossBeamRays = generateCrossBeamFromEntrancePupil(
                    entrancePupil.centerOrigin,
                    dirXYZ,
                    entrancePupil.u,
                    entrancePupil.v,
                    entrancePupil.radius,
                    rayCount,
                    crossType,
                    objectIndex,
                    wavelength,
                    entrancePupil.extents
                );
            }
        } else {
            // stop-based boundary search
            if (debugMode) {
            }

            apertureBoundaryRays = findApertureBoundaryRays(
                chiefRayOrigin,
                dirXYZ,
                opticalSystemRows,
                stopSurfaceInfo,
                { debugMode, wavelength, targetSurfaceIndex: resolvedTargetSurfaceIndex }
            );

            // デバッグ: 絞り周辺光線の探索結果を表示
            if (debugMode) {
                console.log(`   発見数: ${apertureBoundaryRays.length} / 4 (期待値)`);

                if (apertureBoundaryRays.length < 4) {
                    console.warn(`   ⚠️ 一部の絞り周辺光線の探索に失敗しました`);
                }

                apertureBoundaryRays.forEach((ray, index) => {
                    console.log(`   ${index + 1}. ${ray.direction}: 座標(${ray.origin.x.toFixed(3)}, ${ray.origin.y.toFixed(3)}, ${ray.origin.z.toFixed(3)}), 距離=${ray.distance.toFixed(3)}mm`);
                });
            }

            crossBeamRays = generateCrossBeamFromBoundaryRays(
                chiefRayOrigin,
                dirXYZ,
                apertureBoundaryRays,
                rayCount,
                crossType,
                debugMode,
                objectIndex,
                wavelength
            );
        }

        // 7. 光線追跡の実行
        const tracedRays = traceCrossBeamRays(
            opticalSystemRows,
            crossBeamRays,
            wavelength,
            debugMode,
            resolvedTargetSurfaceIndex
        );

        // --- Diagnostics
        const successCount = tracedRays.filter(r => r && r.success).length;

        // If nothing reaches, do a detailed trace on the chief ray to identify where it is blocked.
        if (successCount === 0 && chiefRayOrigin && direction) {
            const dbg = [];
            const ray0 = {
                pos: { x: chiefRayOrigin.x, y: chiefRayOrigin.y, z: chiefRayOrigin.z },
                dir: { x: direction.i, y: direction.j, z: direction.k },
                wavelength
            };
            traceRayForRenderTs(Array.isArray(opticalSystemRows) ? opticalSystemRows.slice() : opticalSystemRows, ray0, 1.0, dbg);
            const block = _extractFirstApertureBlockFromDebugLog(dbg);
            if (block) {
                console.warn(`🚫 [DrawCrossDiag] Object${objectIndex}: PHYSICAL_APERTURE_BLOCK at Surface ${block.surfaceNumber ?? '?'} (hitRadius=${block.hitRadiusMm ?? '?'}mm > limit=${block.apertureLimitMm ?? '?'}mm)`);
            } else {
                console.warn(`🚫 [DrawCrossDiag] Object${objectIndex}: no rays reached target, but no PHYSICAL_APERTURE_BLOCK found in debugLog`);
            }
        }

        // Object毎の結果を保存
        const objectResult = {
            objectIndex: objectIndex,
            objectAngle: objectAngle,
            objectPosition: objectAngle,  // 互換性のために角度を位置としても保存
            direction: chiefDirection,
            chiefRayOrigin: chiefRayOrigin,
            stopSurfaceInfo: stopSurfaceInfo,
            pupilSamplingMode: pupilSamplingMode,
            entrancePupil: entrancePupil,
            apertureBoundaryRays: apertureBoundaryRays,
            crossBeamRays: crossBeamRays,
            tracedRays: tracedRays,
            rayCount: rayCount,
            crossType: crossType,
            wavelength: wavelength
        };
        
        allResults.push(objectResult);
        
        if (debugMode) {
            console.log(`   Object角度: (${objectAngle.x}°, ${objectAngle.y}°)`);
            console.log(`   生成光線数: ${crossBeamRays.length}`);
            console.log(`   追跡成功: ${tracedRays.filter(r => r.success).length}/${tracedRays.length}`);
        }
    }

    // 結果を集約
    const allTracedRays = [];
    const allCrossBeamRays = [];
    
    allResults.forEach((result, idx) => {
        result.tracedRays.forEach(ray => {
            ray.objectIndex = result.objectIndex;
            ray.objectAngle = result.objectAngle;
            allTracedRays.push(ray);
        });
        
        result.crossBeamRays.forEach(ray => {
            ray.objectIndex = result.objectIndex;
            ray.objectAngle = result.objectAngle;
            allCrossBeamRays.push(ray);
        });
    });

    const result = {
        success: true,
        systemType: 'infinite',
        objectCount: angles.length,
        processedObjectCount: allResults.length,
        objectResults: allResults,
        allTracedRays: allTracedRays,
        allCrossBeamRays: allCrossBeamRays,
        rayCount: rayCount,
        crossType: crossType,
        wavelength: wavelength
    };

    return result;
}

/**
 * 光学系の有効性を診断（デバッグ用）
 */
function diagnoseOpticalSystem(opticalSystemRows) {
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        console.error(`❌ [System Diagnosis] No optical system rows`);
        return;
    }
    
    console.warn(`🔍 [System Diagnosis] Checking ${opticalSystemRows.length} surfaces...`);
    let invalidCount = 0;
    
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surf = opticalSystemRows[i];
        const surfId = surf?.id ?? i;
        const objectType = surf?.['object type'] ?? surf?.objectType ?? 'Unknown';
        const radius = cooptParseNumberOrInfinity(surf?.radius ?? surf?.Radius, Infinity);
        const thickness = cooptParseNumberOrInfinity(surf?.thickness ?? surf?.Thickness, 0);
        const glass = surf?.glass ?? surf?.Glass ?? 'AIR';
        
        const issues = [];
        
        // Check for invalid radius on refracting surfaces
        if (objectType !== 'Object' && objectType !== 'Image' && objectType !== 'Stop') {
            if (Math.abs(radius) < 0.01 && Math.abs(radius) > 0) {
                issues.push(`radius too small: ${radius}`);
            }
            if (!Number.isFinite(radius) && radius !== Infinity) {
                issues.push(`radius is NaN`);
            }
        }
        
        // Check for invalid thickness
        if (thickness < 0 && objectType !== 'Object') {
            issues.push(`negative thickness: ${thickness}`);
        }
        if (!Number.isFinite(thickness) && thickness !== Infinity) {
            issues.push(`thickness is NaN`);
        }
        
        if (issues.length > 0) {
            console.error(`❌ [Surface ${surfId}] ${objectType}: ${issues.join(', ')}`);
            invalidCount++;
        }
    }
    
    if (invalidCount > 0) {
        console.error(`❌ [System Diagnosis] Found ${invalidCount} invalid surfaces - optimization may have driven parameters out of valid range`);
        console.error(`💡 [Suggestion] Check VAR bounds, add constraints, or reset to valid starting configuration`);
    } else {
        console.warn(`✅ [System Diagnosis] All surfaces have valid basic parameters`);
    }
}

/**
 * 無限系での主光線方向ベクトルを角度から計算
 * @param {Object} objectAngle - Object角度 {x, y} (度)
 * @returns {Object} 正規化された方向ベクトル {i, j, k}
 */
function calculateInfiniteSystemDirection(objectAngle) {
    // 角度を度からラジアンに変換
    const angleX = (objectAngle.x || 0) * Math.PI / 180;
    const angleY = (objectAngle.y || 0) * Math.PI / 180;
    
    // 方向ベクトルを計算（改良版）
    // 大きな角度に対応するために、tanの代わりにsinとcosを使用
    const cosX = Math.cos(angleX);
    const cosY = Math.cos(angleY);
    const sinX = Math.sin(angleX);
    const sinY = Math.sin(angleY);
    
    // 方向ベクトルの各成分を計算
    const i = sinX * cosY;
    const j = sinY * cosX;
    const k = cosX * cosY;
    
    // 正規化のための内積チェック
    const magnitude = Math.sqrt(i*i + j*j + k*k);
    
    if (magnitude < 1e-10) {
        console.warn(`⚠️ [InfiniteSystem] 方向ベクトルの大きさが0: x=${objectAngle.x}°, y=${objectAngle.y}°`);
        return null;
    }
    
    // 正規化
    const normalizedI = i / magnitude;
    const normalizedJ = j / magnitude;
    const normalizedK = k / magnitude;
    
    // 大きな角度のデバッグ情報
    // 物理的に有効な方向ベクトルかチェック
    if (normalizedK <= 0) {
        console.warn(`⚠️ [InfiniteSystem] 後方を向く方向ベクトル: k=${normalizedK.toFixed(6)}`);
        // 90度以上の角度でも処理を続行
    }
    
    return { i: normalizedI, j: normalizedJ, k: normalizedK };
}

/**
 * 無限系での主光線射出座標をBrent法で探索
 * @param {Object} direction - 方向ベクトル {i, j, k}
 * @param {Object} stopCenter - Stop面中心座標
 * @param {number} stopSurfaceIndex - Stop面インデックス
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {boolean} debugMode - デバッグモード
 * @param {number} targetSurfaceIndex - 評価面インデックス
 * @returns {Object|null} 射出座標 {x, y, z}
 */
export function findInfiniteSystemChiefRayOrigin(direction, stopCenter, stopSurfaceIndex, opticalSystemRows, debugMode, targetSurfaceIndex, wavelength) {
    const cacheKey = buildChiefRayOriginSearchCacheKey(direction, stopCenter, stopSurfaceIndex, targetSurfaceIndex, opticalSystemRows, wavelength);
    if (cacheKey && chiefRayOriginSearchCache.has(cacheKey)) {
        const cached = chiefRayOriginSearchCache.get(cacheKey);
        return cached ? { ...cached } : null;
    }

    // Use objectRenderDistance from Object row for INF objects (positive value converted to negative Z)
    const objectRow = opticalSystemRows && opticalSystemRows[0];
    const renderDist = (objectRow && typeof objectRow.objectRenderDistance === 'number') ? objectRow.objectRenderDistance : 0;
    const initialZ = cooptResolveInfiniteObjectInitialZ(opticalSystemRows, renderDist, stopCenter);

    const stopX = Number.isFinite(stopCenter?.x) ? stopCenter.x : 0;
    const stopY = Number.isFinite(stopCenter?.y) ? stopCenter.y : 0;
    const dirI = Number(direction?.i) || 0;
    const dirJ = Number(direction?.j) || 0;
    const dirK = Number(direction?.k) || 0;
    const angleXDeg = Math.atan2(dirI, Math.max(1e-12, Math.abs(dirK))) * 180 / Math.PI;
    const angleYDeg = Math.atan2(dirJ, Math.max(1e-12, Math.abs(dirK))) * 180 / Math.PI;
    const maxFieldDeg = Math.max(Math.abs(angleXDeg), Math.abs(angleYDeg));
    const mirrorChiefRayDiagToOpener = (label, payload) => {
        try {
            if (typeof window === 'undefined') return;
            const openerRef = (window as any).opener;
            if (!openerRef || openerRef.closed) return;
            const mirrored = {
                at: new Date().toISOString(),
                source: 'findInfiniteSystemChiefRayOrigin',
                label,
                ...payload
            };
            try { openerRef.__LAST_CHIEF_RAY_DIAG = mirrored; } catch (_) {}
            try { openerRef.postMessage?.({ type: 'COOPT_CHIEF_RAY_DIAG', payload: mirrored }, '*'); } catch (_) {}
        } catch (_) {}
    };
    const logHighFieldChiefOriginFailure = (reason, details = {}) => {
        try {
            const key = `${reason}:${angleXDeg.toFixed(2)}:${angleYDeg.toFixed(2)}:${stopSurfaceIndex}`;
            if (typeof globalThis !== 'undefined') {
                if (!(globalThis as any).__COOPT_HIGH_FIELD_CHIEF_FAIL_KEYS) {
                    (globalThis as any).__COOPT_HIGH_FIELD_CHIEF_FAIL_KEYS = new Set();
                }
                const keys = (globalThis as any).__COOPT_HIGH_FIELD_CHIEF_FAIL_KEYS as Set<string>;
                if (keys.has(key)) return;
                keys.add(key);
            }
        } catch (_) {}
        const payload = {
            reason,
            angleX: Number(angleXDeg.toFixed(3)),
            angleY: Number(angleYDeg.toFixed(3)),
            maxFieldDeg: Number(maxFieldDeg.toFixed(3)),
            highField: maxFieldDeg >= 15,
            stopSurfaceIndex,
            targetSurfaceIndex,
            ...details
        };
        mirrorChiefRayDiagToOpener('Chief origin solve issue', payload);
    };

    // 幾何学的な初期推定：屈折を無視した直進なら、この射出点で stopCenter を通る。
    // 実光学系ではズレるが、探索中心/探索範囲の見積りとして有効。
    const dzToStop = (stopCenter?.z ?? 0) - initialZ;
    const safeK = (Math.abs(direction?.k ?? 0) > 1e-12) ? direction.k : 1e-12;
    const guessX = (stopCenter?.x ?? 0) - (direction.i / safeK) * dzToStop;
    const guessY = (stopCenter?.y ?? 0) - (direction.j / safeK) * dzToStop;

    // 古い固定 ±50mm だと、stop が遠い/角度が大きい場合に探索外になり得る。
    // 予測射出点の大きさ + stop 半径のスケールを見て探索範囲を拡張する。
    const stopRadiusGuess = (() => {
        try {
            const s = opticalSystemRows?.[stopSurfaceIndex];
            const semidia = parseFloat(s?.semidia ?? s?.semiDiameter ?? s?.['semi-diameter'] ?? '');
            const aperture = parseFloat(s?.aperture ?? s?.Aperture ?? '');
            if (Number.isFinite(semidia) && semidia > 0) return semidia;
            if (Number.isFinite(aperture) && aperture > 0) return aperture / 2;
        } catch (_) {}
        return 10;
    })();

    const guessAbs = Math.max(Math.abs(guessX), Math.abs(guessY), 0);
    const dynamicHalfRange = Math.max(50, guessAbs + 2 * stopRadiusGuess + 10);
    
    if (debugMode) {
        console.log(`   方向ベクトル: (${direction.i.toFixed(6)}, ${direction.j.toFixed(6)}, ${direction.k.toFixed(6)})`);
        console.log(`   Stop面中心: (${stopCenter.x.toFixed(3)}, ${stopCenter.y.toFixed(3)}, ${stopCenter.z.toFixed(3)})`);
        console.log(`   目標精度: 優秀レベル (< 10μm)`);
    }
    
    try {
        const highPrecisionSearch = !!(typeof globalThis !== 'undefined' && (globalThis as any).__COOPT_HIGH_PRECISION_CHIEF_SEARCH === true);
        const useUltraPrecision = !!debugMode || highPrecisionSearch;
        const evaluateRayToStop = (x, y) => {
            const ray = {
                pos: { x: x, y: y, z: initialZ },
                dir: { x: direction.i, y: direction.j, z: direction.k },
                wavelength: wavelength
            };

            try {
                // Suppress NO INTERSECTION errors during grid search (expected for many trial points)
                const prevSuppressFlag = (typeof globalThis !== 'undefined') ? globalThis.__COOPT_SUPPRESS_RAY_ERRORS : undefined;
                let actualStopPoint = null;
                try {
                    if (typeof globalThis !== 'undefined') globalThis.__COOPT_SUPPRESS_RAY_ERRORS = true;
                    actualStopPoint = traceRayHitPointForChiefSearch(opticalSystemRows, ray, 1.0, stopSurfaceIndex);
                } finally {
                    if (typeof globalThis !== 'undefined') globalThis.__COOPT_SUPPRESS_RAY_ERRORS = prevSuppressFlag;
                }
                if (!actualStopPoint) return { valid: false, error: Infinity, stopPoint: null };

                const errorX = actualStopPoint.x - stopX;
                const errorY = actualStopPoint.y - stopY;
                return { valid: true, error: Math.hypot(errorX, errorY), stopPoint: actualStopPoint };
            } catch (_) {
                return { valid: false, error: Infinity, stopPoint: null };
            }
        };

        const solveChiefOriginByNewton2D = (x0, y0) => {
            let x = x0;
            let y = y0;
            let best = { x, y, error: Infinity };
            const tol = 1e-6;

            for (let iter = 0; iter < 40; iter++) {
                const centerEval = evaluateRayToStop(x, y);
                if (!centerEval.valid || !centerEval.stopPoint) {
                    return null;
                }

                const fx = centerEval.stopPoint.x - stopX;
                const fy = centerEval.stopPoint.y - stopY;
                const centerError = Math.hypot(fx, fy);
                if (centerError < best.error) {
                    best = { x, y, error: centerError };
                }
                if (centerError <= tol) {
                    return best;
                }

                const eps = Math.max(1e-4, 1e-3 * (1 + centerError));
                const evalX = evaluateRayToStop(x + eps, y);
                const evalY = evaluateRayToStop(x, y + eps);
                if (!evalX.valid || !evalX.stopPoint || !evalY.valid || !evalY.stopPoint) {
                    return best.error < 1e-3 ? best : null;
                }

                const j11 = (evalX.stopPoint.x - centerEval.stopPoint.x) / eps;
                const j21 = (evalX.stopPoint.y - centerEval.stopPoint.y) / eps;
                const j12 = (evalY.stopPoint.x - centerEval.stopPoint.x) / eps;
                const j22 = (evalY.stopPoint.y - centerEval.stopPoint.y) / eps;

                const det = j11 * j22 - j12 * j21;
                let dx;
                let dy;

                if (!Number.isFinite(det) || Math.abs(det) < 1e-14) {
                    dx = -0.25 * fx;
                    dy = -0.25 * fy;
                } else {
                    dx = (-j22 * fx + j12 * fy) / det;
                    dy = (j21 * fx - j11 * fy) / det;
                }

                if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
                    return best.error < 1e-3 ? best : null;
                }

                const maxStep = Math.max(0.5, dynamicHalfRange * 0.05);
                const stepNorm = Math.hypot(dx, dy);
                if (stepNorm > maxStep) {
                    const scale = maxStep / stepNorm;
                    dx *= scale;
                    dy *= scale;
                }

                let accepted = false;
                let alpha = 1.0;
                for (let ls = 0; ls < 10; ls++) {
                    const nx = x + alpha * dx;
                    const ny = y + alpha * dy;
                    const nEval = evaluateRayToStop(nx, ny);
                    if (nEval.valid && nEval.error < centerError) {
                        x = nx;
                        y = ny;
                        accepted = true;
                        break;
                    }
                    alpha *= 0.5;
                }

                if (!accepted) {
                    return best.error < 1e-3 ? best : null;
                }
            }

            return best.error < 1e-3 ? best : null;
        };

        const newtonResult = solveChiefOriginByNewton2D(guessX, guessY);
        if (newtonResult) {
            const result = {
                x: newtonResult.x,
                y: newtonResult.y,
                z: initialZ
            };

            if (typeof window !== 'undefined') {
                setLastChiefRayResult({
                    direction: direction,
                    optimalX: result.x,
                    optimalY: result.y,
                    error: newtonResult.error,
                    method: 'newton-2d-stop-center'
                });
            }

            if (cacheKey) {
                chiefRayOriginSearchCache.set(cacheKey, { ...result });
                if (chiefRayOriginSearchCache.size > 256) {
                    const firstKey = chiefRayOriginSearchCache.keys().next().value;
                    if (firstKey !== undefined) chiefRayOriginSearchCache.delete(firstKey);
                }
            }

            return result;
        }

        // 同時最適化のための目的関数（XとYを同時に最適化）
        const objectiveFunction2D = (x, y) => {
            const result = evaluateRayToStop(x, y);
            return result.valid ? result.error : 1e9;
        };
        
        // 単軸の目的関数（フォールバック用）
        const objectiveFunctionX = (x) => {
            const result = evaluateRayToStop(x, 0);
            return result.valid ? (result.stopPoint.x - stopX) : 1e9;
        };
        
        const objectiveFunctionY = (y) => {
            const result = evaluateRayToStop(0, y);
            return result.valid ? (result.stopPoint.y - stopY) : 1e9;
        };
        
        // 探索範囲を設定（動的）
        const searchRange = dynamicHalfRange;
        let optimalX = 0;
        let optimalY = 0;
        
        // Phase 1: Grid法による粗探索
        if (debugMode) {
            console.log(`🔍 [Phase1] Grid法による粗探索開始`);
        }
        
        // Grid探索の設定（中密度グリッド - バランス設定）
        const gridRange = dynamicHalfRange;
        const gridSize = useUltraPrecision ? 51 : 29;
        const gridStep = (2 * gridRange) / (gridSize - 1);
        
        let bestX = 0, bestY = 0, bestError = Infinity;
        let foundAnyValid = false;
        let gridEvaluations = 0;
        
        if (debugMode) {
            console.log(`🔍 [Phase0] 幾何学初期推定: guess=(${guessX.toFixed(3)}, ${guessY.toFixed(3)})mm, dz=${dzToStop.toFixed(3)}mm`);
            console.log(`🔍 [Phase1] Grid設定: 範囲±${gridRange}mm, サイズ${gridSize}x${gridSize}, ステップ${gridStep.toFixed(4)}mm`);
            console.log(`🔍 [Phase1] 総評価点数: ${gridSize * gridSize} (約2600点)`);
        }
        
        // Grid探索実行（guess を中心に探索）
        for (let i = 0; i < gridSize; i++) {
            const x = (guessX - gridRange) + i * gridStep;
            for (let j = 0; j < gridSize; j++) {
                const y = (guessY - gridRange) + j * gridStep;
                const evalResult = evaluateRayToStop(x, y);
                const error = evalResult.valid ? evalResult.error : 1e9;
                gridEvaluations++;
                
                if (evalResult.valid && error < bestError) {
                    foundAnyValid = true;
                    bestError = error;
                    bestX = x;
                    bestY = y;
                }
            }
        }

        if (!foundAnyValid) {
            if (debugMode) {
                console.warn(`❌ [InfiniteSystem] Stop中心に到達できる光線が見つかりません（全候補が遮光/TIR/失敗）`);
            }
            logHighFieldChiefOriginFailure('grid-no-valid-ray', {
                guessX,
                guessY,
                dynamicHalfRange,
                gridEvaluations
            });
            return null;
        }
        
        if (debugMode) {
            console.log(`✅ [Phase1] 中密度Grid探索完了: 評価数=${gridEvaluations}, 最良解=(${bestX.toFixed(8)}, ${bestY.toFixed(8)}), 誤差=${bestError.toFixed(10)}mm`);
        }

        // Phase 2: Brent法による精密最適化
        if (debugMode) {
            console.log(`🔍 [Phase2] Brent法による精密最適化開始`);
        }
        
        optimalX = bestX;
        optimalY = bestY;

        if (useUltraPrecision) {
            // X方向の目的関数（Y座標を現在の最良値に固定）
            const objectiveFunctionX_fixed = (x) => objectiveFunction2D(x, optimalY);
            
            // X方向の精密最適化（厳しい収束条件）
            try {
                // Grid探索結果を中心とした狭い範囲でBrent法を実行
                const brentRange = Math.max(gridStep * 2, 0.5); // 最低0.5mm範囲を確保
                let aX = bestX - brentRange;
                let bX = bestX + brentRange;
                
                // 差分関数を使用してBrent法の符号変化条件を満たす
                const baseFunctionX = objectiveFunctionX_fixed(bestX);
                const diffFunctionX = (x) => objectiveFunctionX_fixed(x) - baseFunctionX;
                
                let faX = diffFunctionX(aX);
                let fbX = diffFunctionX(bX);
                
                if (faX * fbX >= 0) {
                    // 符号変化がない場合、範囲を段階的に拡大
                    for (let mult = 2; mult <= 10 && faX * fbX >= 0; mult++) {
                        aX = bestX - mult * brentRange;
                        bX = bestX + mult * brentRange;
                        faX = diffFunctionX(aX);
                        fbX = diffFunctionX(bX);
                    }
                }
                
                if (faX * fbX < 0) {
                    // 収束条件を緩和（高速化）: 1e-12 → 1e-8
                    const deltaX = brent(diffFunctionX, aX, bX, 1e-8, 100);
                    optimalX = bestX + deltaX;
                    
                    if (debugMode) {
                        console.log(`✅ [Phase2] X方向高精度最適化完了: ${bestX.toFixed(8)} → ${optimalX.toFixed(8)}mm`);
                    }
                } else {
                    if (debugMode) {
                        console.log(`⚠️ [Phase2] X方向Brent法：符号変化区間なし、Grid結果を使用`);
                    }
                }
            } catch (errorX) {
                if (debugMode) {
                    console.warn(`⚠️ [Phase2] X方向精密最適化失敗: ${errorX.message}`);
                }
            }
            
            // Y方向の目的関数（X座標を最適化済み値に固定）
            const objectiveFunctionY_fixed = (y) => objectiveFunction2D(optimalX, y);
            
            // Y方向の精密最適化（厳しい収束条件）
            try {
                const brentRange = Math.max(gridStep * 2, 0.5); // 最低0.5mm範囲を確保
                let aY = bestY - brentRange;
                let bY = bestY + brentRange;
                
                const baseFunctionY = objectiveFunctionY_fixed(bestY);
                const diffFunctionY = (y) => objectiveFunctionY_fixed(y) - baseFunctionY;
                
                let faY = diffFunctionY(aY);
                let fbY = diffFunctionY(bY);
                
                if (faY * fbY >= 0) {
                    // 符号変化がない場合、範囲を段階的に拡大
                    for (let mult = 2; mult <= 10 && faY * fbY >= 0; mult++) {
                        aY = bestY - mult * brentRange;
                        bY = bestY + mult * brentRange;
                        faY = diffFunctionY(aY);
                        fbY = diffFunctionY(bY);
                    }
                }
                
                if (faY * fbY < 0) {
                    // 収束条件を緩和（高速化）: 1e-12 → 1e-8
                    const deltaY = brent(diffFunctionY, aY, bY, 1e-8, 100);
                    optimalY = bestY + deltaY;
                    
                    if (debugMode) {
                        console.log(`✅ [Phase2] Y方向高精度最適化完了: ${bestY.toFixed(8)} → ${optimalY.toFixed(8)}mm`);
                    }
                } else {
                    if (debugMode) {
                        console.log(`⚠️ [Phase2] Y方向Brent法：符号変化区間なし、Grid結果を使用`);
                    }
                }
            } catch (errorY) {
                if (debugMode) {
                    console.warn(`⚠️ [Phase2] Y方向精密最適化失敗: ${errorY.message}`);
                }
            }
        }

        // Phase 3: 超高精度反復最適化（優秀レベル対応）
        if (useUltraPrecision) {
            if (debugMode) {
                console.log(`🔍 [Phase3] 超高精度反復最適化開始（優秀レベル対応）`);
            }
            
            // 現在の誤差を確認
            const currentError = objectiveFunction2D(optimalX, optimalY);
            if (debugMode) {
                console.log(`   Phase2後の誤差: ${currentError.toFixed(8)}mm`);
            }
            
            // 反復最適化（最大100回、究極の精度向上）
            for (let iter = 0; iter < 100; iter++) {
            const prevX = optimalX;
            const prevY = optimalY;
            const prevError = objectiveFunction2D(optimalX, optimalY);
            
            // X方向の微調整（適応的範囲調整）
            try {
                // 現在の誤差に応じて探索範囲を調整（優秀レベル対応）
                const currentError = objectiveFunction2D(optimalX, optimalY);
                let microRange;
                if (currentError > 0.1) {
                    microRange = Math.min(gridStep * 0.1, 0.05); // 誤差が大きい場合
                } else if (currentError > 0.05) {
                    microRange = Math.min(gridStep * 0.05, 0.025); // 中程度の誤差
                } else if (currentError > 0.01) {
                    microRange = Math.min(gridStep * 0.025, 0.01); // 小さい誤差
                } else {
                    microRange = Math.min(gridStep * 0.01, 0.005); // 極小誤差（優秀レベル対応）
                }
                
                const centerError = objectiveFunction2D(optimalX, optimalY);
                
                // より細かなステップで局所探索（25ステップ - 優秀レベル対応）
                let bestLocalX = optimalX;
                let bestLocalError = centerError;
                
                for (let step = -microRange; step <= microRange; step += microRange / 25) {
                    if (Math.abs(step) < 1e-8) continue; // ゼロステップをスキップ
                    
                    const testX = optimalX + step;
                    const testError = objectiveFunction2D(testX, optimalY);
                    
                    if (testError < bestLocalError && testError < 1000) { // 有効な解のみ受け入れ
                        bestLocalError = testError;
                        bestLocalX = testX;
                    }
                }
                
                optimalX = bestLocalX;
                
            } catch (e) {
                if (debugMode) {
                    console.warn(`   X方向微調整でエラー: ${e.message}`);
                }
            }
            
            // Y方向の微調整（適応的範囲調整）
            try {
                const currentError = objectiveFunction2D(optimalX, optimalY);
                let microRange;
                if (currentError > 0.1) {
                    microRange = Math.min(gridStep * 0.1, 0.05); // 誤差が大きい場合
                } else if (currentError > 0.05) {
                    microRange = Math.min(gridStep * 0.05, 0.025); // 中程度の誤差
                } else if (currentError > 0.01) {
                    microRange = Math.min(gridStep * 0.025, 0.01); // 小さい誤差
                } else {
                    microRange = Math.min(gridStep * 0.01, 0.005); // 極小誤差（優秀レベル対応）
                }
                
                const centerError = objectiveFunction2D(optimalX, optimalY);
                
                let bestLocalY = optimalY;
                let bestLocalError = centerError;
                
                for (let step = -microRange; step <= microRange; step += microRange / 25) {
                    if (Math.abs(step) < 1e-8) continue;
                    
                    const testY = optimalY + step;
                    const testError = objectiveFunction2D(optimalX, testY);
                    
                    if (testError < bestLocalError && testError < 1000) {
                        bestLocalError = testError;
                        bestLocalY = testY;
                    }
                }
                
                optimalY = bestLocalY;
                
            } catch (e) {
                if (debugMode) {
                    console.warn(`   Y方向微調整でエラー: ${e.message}`);
                }
            }
            
            // 改善度の確認
            const newError = objectiveFunction2D(optimalX, optimalY);
            const deltaX = Math.abs(optimalX - prevX);
            const deltaY = Math.abs(optimalY - prevY);
            const errorImprovement = prevError - newError;
            
            if (debugMode) {
                console.log(`   反復${iter + 1}: ΔX=${deltaX.toFixed(8)}mm, ΔY=${deltaY.toFixed(8)}mm`);
                console.log(`   誤差改善: ${prevError.toFixed(8)} → ${newError.toFixed(8)}mm (改善度: ${errorImprovement.toFixed(8)}mm)`);
            }
            
            // 収束判定（優秀レベル対応のより厳しい条件）
            if (errorImprovement < 1e-12 || (deltaX < 1e-12 && deltaY < 1e-12)) {
                if (debugMode) {
                    console.log(`✅ [Phase3] 超高精度収束: ${iter + 1}回目で収束`);
                }
                break;
            }
            
            // 悪化した場合は前の値に戻す（安全措置）
            if (newError > prevError) {
                optimalX = prevX;
                optimalY = prevY;
                if (debugMode) {
                    console.log(`   ⚠️ 誤差悪化のため前の値に復元`);
                }
                break;
            }
            }
        }
        
        const result = {
            x: optimalX,
            y: optimalY,
            z: initialZ
        };
        
        // 結果を検証
        const verificationRay = {
            pos: result,
            dir: { x: direction.i, y: direction.j, z: direction.k },
            wavelength: wavelength
        };
        
        const actualPoint = traceRayHitPointForChiefSearch(opticalSystemRows, verificationRay, 1.0, stopSurfaceIndex);
        if (actualPoint) {
            const errorX = actualPoint.x - stopX;
            const errorY = actualPoint.y - stopY;
            const totalError = Math.hypot(errorX, errorY);
            
            if (debugMode) {
                console.log(`   射出座標: (${result.x.toFixed(6)}, ${result.y.toFixed(6)}, ${result.z.toFixed(3)})`);
                console.log(`   Stop面実際位置: (${actualPoint.x.toFixed(6)}, ${actualPoint.y.toFixed(6)})`);
                console.log(`   Stop面目標位置: (${stopCenter.x.toFixed(6)}, ${stopCenter.y.toFixed(6)})`);
                console.log(`   誤差: X=${errorX.toFixed(8)}mm, Y=${errorY.toFixed(8)}mm, 総合=${totalError.toFixed(8)}mm`);
                console.log(`   Grid誤差: ${bestError.toFixed(8)}mm → 最終誤差: ${totalError.toFixed(8)}mm (改善率: ${((bestError - totalError) / bestError * 100).toFixed(1)}%)`);
            }
            
            // System Data出力用の情報を保存（グローバル変数として保存）
            if (typeof window !== 'undefined') {
                setLastChiefRayResult({
                    direction: direction,
                    optimalX: result.x,
                    optimalY: result.y,
                    error: totalError,
                    method: 'grid-brent-hybrid'
                });
            }
        }
        
        if (cacheKey) {
            chiefRayOriginSearchCache.set(cacheKey, { ...result });
            if (chiefRayOriginSearchCache.size > 256) {
                const firstKey = chiefRayOriginSearchCache.keys().next().value;
                if (firstKey !== undefined) chiefRayOriginSearchCache.delete(firstKey);
            }
        }
        return result;
        
    } catch (error) {
        if (debugMode) {
            console.error(`❌ [Grid+Brent] 主光線探索エラー: ${error.message}`);
        }
        logHighFieldChiefOriginFailure('solver-exception', {
            error: (error && typeof error === 'object' && 'message' in error)
                ? error.message
                : String(error)
        });

        // NOTE: traceRay が null を返すケース（遮光など）を「成功」に見せないため、
        // 幾何学フォールバックではなく null を返す。
        if (cacheKey) {
            chiefRayOriginSearchCache.set(cacheKey, null);
        }
        return null;
    }
}

/**
 * System Data テキストエリアに主光線収束情報を出力する
 * @param {number} objectNumber - Object番号（1-based）
 * @param {number} xAngle - X軸角度（度）
 * @param {number} yAngle - Y軸角度（度）
 * @param {number} distanceFromCenter - 絞り中心からの距離（mm）
 * @param {string} optimizationMethod - 最適化手法
 */
export function outputChiefRayConvergenceToSystemData(objectNumber, xAngle, yAngle, distanceFromCenter, optimizationMethod) {
    try {
        
        // DOM要素の存在確認（複数のID候補を試す）
        let systemDataTextarea = document.getElementById('system-data');
        if (!systemDataTextarea) {
            systemDataTextarea = document.getElementById('systemData');
        }
        if (!systemDataTextarea) {
            systemDataTextarea = document.querySelector('textarea[data-system-data]');
        }
        if (!systemDataTextarea) {
            systemDataTextarea = document.querySelector('#system-data, #systemData, textarea.system-data');
        }
        
        if (!systemDataTextarea) {
            console.error('❌ [SystemData] system-data テキストエリアが見つかりません。以下のセレクタを試しました:');
            console.error('  - #system-data');
            console.error('  - #systemData');
            console.error('  - textarea[data-system-data]');
            console.error('  - .system-data');
            console.error('📝 [SystemData] 利用可能なtextarea要素:', document.querySelectorAll('textarea'));
            return;
        }
        
        // 最適化手法の日本語表示
        const methodDisplayName = {
            'grid-brent-hybrid': 'Grid+Brent法ハイブリッド高精度最適化',
            'brent-optimization': 'Brent法による高精度最適化',
            'geometric-approximation': '幾何学的近似による計算',
            'geometric-fallback': '最適化失敗時のフォールバック処理',
            'unknown': '手法不明（情報不足）'
        };
        
        const methodName = methodDisplayName[optimizationMethod] || optimizationMethod;
        
        // 収束品質の評価（1μm基準）
        let qualityAssessment;
        if (distanceFromCenter < 0.001) {
            qualityAssessment = '非常に優秀 (< 1μm)';
        } else if (distanceFromCenter < 0.01) {
            qualityAssessment = '優秀 (< 10μm)';
        } else if (distanceFromCenter < 0.1) {
            qualityAssessment = '良好 (< 100μm)';
        } else if (distanceFromCenter < 1.0) {
            qualityAssessment = '要改善 (< 1.0mm)';
        } else {
            qualityAssessment = '収束不良 (≥ 1.0mm)';
        }
        
        // System Data出力文字列の作成
        const convergenceReport = `絞り中心からの距離: ${distanceFromCenter.toFixed(6)}mm
最適化手法: ${methodName}
収束品質: ${qualityAssessment}
解析時刻: ${new Date().toLocaleTimeString()}
------------------------------------------------------------
`;
        
        // テキストエリア末尾に追加
        systemDataTextarea.value += (systemDataTextarea.value ? '\n' : '') + convergenceReport;

        // スクロールを最下部に移動
        systemDataTextarea.scrollTop = systemDataTextarea.scrollHeight;
    } catch (error) {
        console.error(`❌ [SystemData] System Data出力エラー:`, error);
    }
}

/**
 * 無限系での絞り周辺光線を探索
 * @param {Object} chiefRayOrigin - 主光線射出座標
 * @param {Object} direction - 方向ベクトル {i, j, k}
 * @param {Object} perpendicularPlane - 垂直面情報
 * @param {Object} stopCenter - Stop面中心座標
 * @param {number} stopRadius - Stop面半径
 * @param {number} stopSurfaceIndex - Stop面インデックス
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {boolean} debugMode - デバッグモード
 * @param {number} targetSurfaceIndex - 評価面インデックス
 * @returns {Array} 絞り周辺光線の射出座標配列
 */
/**
 * 高精度ニュートン法による絞り周辺光線計算（ray-marginal.js風）
 */
function calculateApertureRayNewton(chiefRayOrigin, direction, perpendicularPlane, targetStopPoint, stopSurfaceIndex, opticalSystemRows, maxIterations, tolerance, debugMode, wavelength = 0.5876) {
    // より適切な初期推定：目標点の方向により大きく射出位置を移動
    const targetOffsetX = targetStopPoint.x - chiefRayOrigin.x;
    const targetOffsetY = targetStopPoint.y - chiefRayOrigin.y;
    
    let currentOrigin = {
        x: chiefRayOrigin.x + targetOffsetX * 0.8,  // 0.5 → 0.8 により積極的に
        y: chiefRayOrigin.y + targetOffsetY * 0.8,  // 0.5 → 0.8 により積極的に
        z: chiefRayOrigin.z
    };
    
    // 垂直面制約を満たすようにZ座標調整
    const deltaX = currentOrigin.x - chiefRayOrigin.x;
    const deltaY = currentOrigin.y - chiefRayOrigin.y;
    if (Math.abs(direction.k) > 1e-10) {
        currentOrigin.z = chiefRayOrigin.z - (direction.i * deltaX + direction.j * deltaY) / direction.k;
    }
    
    if (debugMode) {
        console.log(`🔍 [Newton] 初期推定: 目標offset(${targetOffsetX.toFixed(3)}, ${targetOffsetY.toFixed(3)}) → 初期位置(${currentOrigin.x.toFixed(3)}, ${currentOrigin.y.toFixed(3)}, ${currentOrigin.z.toFixed(3)})`);
    }
    
    for (let iteration = 0; iteration < maxIterations; iteration++) {
        const ray = {
            pos: currentOrigin,
            dir: { x: direction.i, y: direction.j, z: direction.k },
            wavelength: wavelength
        };
        
        const rayPath = traceRayForRenderTs(opticalSystemRows, ray, 1.0, null, stopSurfaceIndex + 1);
        if (!rayPath || rayPath.length <= stopSurfaceIndex) {
            if (debugMode) console.log(`⚠️ [Newton] 反復${iteration}: 光線追跡失敗`);
            return { success: false };
        }
        
        const actualStopPoint = getRayPointAtSurfaceIndex(rayPath, opticalSystemRows, stopSurfaceIndex);
        const residual = {
            x: actualStopPoint.x - targetStopPoint.x,
            y: actualStopPoint.y - targetStopPoint.y
        };
        
        const residualMagnitude = Math.sqrt(residual.x * residual.x + residual.y * residual.y);
        
        if (debugMode && iteration < 3) {
        }
        
        if (residualMagnitude < tolerance) {
            return {
                success: true,
                origin: currentOrigin,
                actualStopPoint: actualStopPoint,
                error: residualMagnitude,
                iterations: iteration + 1
            };
        }
        
        // 数値ヤコビアン計算
        const jacobian = calculateNumericalJacobianForPosition(
            currentOrigin, direction, stopSurfaceIndex, opticalSystemRows, 1e-6, wavelength
        );
        
        if (!jacobian || Math.abs(jacobian.det) < 1e-15) {
            if (debugMode) console.log(`⚠️ [Newton] 反復${iteration}: ヤコビアン特異`);
            return { success: false };
        }
        
        // ニュートン法更新
        const invDet = 1.0 / jacobian.det;
        const deltaOrigin = {
            x: -invDet * (jacobian.J22 * residual.x - jacobian.J12 * residual.y) * 0.5,
            y: -invDet * (-jacobian.J21 * residual.x + jacobian.J11 * residual.y) * 0.5
        };
        
        currentOrigin.x += deltaOrigin.x;
        currentOrigin.y += deltaOrigin.y;
        
        // 垂直面制約を再適用
        const newDeltaX = currentOrigin.x - chiefRayOrigin.x;
        const newDeltaY = currentOrigin.y - chiefRayOrigin.y;
        if (Math.abs(direction.k) > 1e-10) {
            currentOrigin.z = chiefRayOrigin.z - (direction.i * newDeltaX + direction.j * newDeltaY) / direction.k;
        }
    }
    
    return { success: false };
}

/**
 * 位置に関する数値ヤコビアン計算
 */
function calculateNumericalJacobianForPosition(origin, direction, stopSurfaceIndex, opticalSystemRows, stepSize, wavelength = 0.5876) {
    // ベースライン
    const baseRay = {
        pos: origin,
        dir: { x: direction.i, y: direction.j, z: direction.k },
        wavelength: wavelength
    };
    const basePath = traceRayForRenderTs(opticalSystemRows, baseRay, 1.0, null, stopSurfaceIndex + 1);
    if (!basePath || basePath.length <= stopSurfaceIndex) return null;
    const basePos = getRayPointAtSurfaceIndex(basePath, opticalSystemRows, stopSurfaceIndex);
    
    // X方向偏微分
    const rayDx = {
        pos: { x: origin.x + stepSize, y: origin.y, z: origin.z },
        dir: { x: direction.i, y: direction.j, z: direction.k },
        wavelength: wavelength
    };
    const pathDx = traceRayForRenderTs(opticalSystemRows, rayDx, 1.0, null, stopSurfaceIndex + 1);
    if (!pathDx || pathDx.length <= stopSurfaceIndex) return null;
    const posDx = getRayPointAtSurfaceIndex(pathDx, opticalSystemRows, stopSurfaceIndex);
    
    // Y方向偏微分
    const rayDy = {
        pos: { x: origin.x, y: origin.y + stepSize, z: origin.z },
        dir: { x: direction.i, y: direction.j, z: direction.k },
        wavelength: wavelength
    };
    const pathDy = traceRayForRenderTs(opticalSystemRows, rayDy, 1.0, null, stopSurfaceIndex + 1);
    if (!pathDy || pathDy.length <= stopSurfaceIndex) return null;
    const posDy = getRayPointAtSurfaceIndex(pathDy, opticalSystemRows, stopSurfaceIndex);
    
    // ヤコビアン行列
    const J11 = (posDx.x - basePos.x) / stepSize;
    const J12 = (posDy.x - basePos.x) / stepSize;
    const J21 = (posDx.y - basePos.y) / stepSize;
    const J22 = (posDy.y - basePos.y) / stepSize;
    
    return {
        J11, J12, J21, J22,
        det: J11 * J22 - J12 * J21
    };
}

/**
 * Brent法による1次元最適化フォールバック
 */
function calculateApertureRayBrent(chiefRayOrigin, direction, perpendicularPlane, searchDir, stopCenter, stopRadius, stopSurfaceIndex, opticalSystemRows, maxIterations, tolerance, debugMode, targetStopPointOverride = null, wavelength = 0.5876) {
    // 探索方向に沿った1次元最適化
    // 垂直面のu/vを停止面XYに投影して、フィールド角がついても安定に探索
    const { u, v } = perpendicularPlane;
    const norm2 = (x, y) => Math.hypot(x, y) || 1;
    const u2d = { x: u.x / norm2(u.x, u.y), y: u.y / norm2(u.x, u.y) };
    const v2d = { x: v.x / norm2(v.x, v.y), y: v.y / norm2(v.x, v.y) };
    let searchVector;
    if (searchDir && searchDir.searchVec) {
        const sv = searchDir.searchVec;
        const mag = Math.hypot(sv.x, sv.y) || 1;
        searchVector = { x: sv.x / mag, y: sv.y / mag };
    } else {
        searchVector = searchDir.name.includes('upper') || searchDir.name.includes('lower') ?
            { x: v2d.x * (searchDir.name.includes('upper') ? 1 : -1), y: v2d.y * (searchDir.name.includes('upper') ? 1 : -1) } :
            { x: u2d.x * (searchDir.name.includes('right') ? 1 : -1), y: u2d.y * (searchDir.name.includes('right') ? 1 : -1) };
    }
    
    // 目標点（与えられたtに揃えるため、オーバーライドがあれば優先）
    const targetStopPoint = targetStopPointOverride ?? {
        x: stopCenter.x + searchVector.x * stopRadius * 0.7,
        y: stopCenter.y + searchVector.y * stopRadius * 0.7,
        z: stopCenter.z
    };
    
    // Brent法による最適化（簡単な実装）
    let bestError = Infinity;
    let bestOrigin = null;
    let bestActualPoint = null;
    
    const searchRange = 30; // ±30mm（より広く）
    const searchSteps = 25; // ステップ増加
    
    for (let i = 0; i < searchSteps; i++) {
        const t = (i / (searchSteps - 1) - 0.5) * 2; // -1 to 1
        const testOrigin = {
            x: chiefRayOrigin.x + searchVector.x * searchRange * t,
            y: chiefRayOrigin.y + searchVector.y * searchRange * t,
            z: chiefRayOrigin.z
        };
        
        // 垂直面制約
        const deltaX = testOrigin.x - chiefRayOrigin.x;
        const deltaY = testOrigin.y - chiefRayOrigin.y;
        if (Math.abs(direction.k) > 1e-10) {
            testOrigin.z = chiefRayOrigin.z - (direction.i * deltaX + direction.j * deltaY) / direction.k;
        }
        
        const testRay = {
            pos: testOrigin,
            dir: { x: direction.i, y: direction.j, z: direction.k },
            wavelength: wavelength
        };
        
        const testPath = traceRayForRenderTs(opticalSystemRows, testRay, 1.0, null, stopSurfaceIndex + 1);
        if (testPath && testPath.length > stopSurfaceIndex) {
            const actualPoint = getRayPointAtSurfaceIndex(testPath, opticalSystemRows, stopSurfaceIndex);
            const errorX = actualPoint.x - targetStopPoint.x;
            const errorY = actualPoint.y - targetStopPoint.y;
            const error = Math.sqrt(errorX * errorX + errorY * errorY);
            
            if (error < bestError) {
                bestError = error;
                bestOrigin = { ...testOrigin };
                bestActualPoint = { ...actualPoint };
            }
        }
    }
    
    if (bestOrigin && bestError < tolerance * 10) {
        return {
            success: true,
            origin: bestOrigin,
            actualStopPoint: bestActualPoint,
            error: bestError,
            targetPoint: targetStopPoint,
            iterations: searchSteps
        };
    }
    
    return { success: false };
}

function findInfiniteSystemApertureRays(chiefRayOrigin, direction, perpendicularPlane, stopCenter, stopRadius, stopSurfaceIndex, opticalSystemRows, debugMode, targetSurfaceIndex, wavelength = 0.5876) {
    const apertureBoundaryRays = [];
    const { u, v } = perpendicularPlane;

    // 停止面(ここではz一定の平面とみなす)上でのU/V方向の2D成分を正規化
    const norm2 = (x, y) => Math.hypot(x, y) || 1;
    const u2dMag = norm2(u.x, u.y);
    const v2dMag = norm2(v.x, v.y);
    const u2d = { x: u.x / u2dMag, y: u.y / u2dMag };
    const v2d = { x: v.x / v2dMag, y: v.y / v2dMag };
    
    // 探索パラメータを関数の開始時に定義（適応的アプローチ）
    const maxIterations = 50;  // Newton法用
    const tolerance = 1e-6;    // 高精度収束
    const gridMaxIterations = 15; // Grid探索用
    const gridTolerance = 1.0;    // Grid探索用緩い許容誤差
    // エッジ接近用パラメータ（tは中心→絞り端の比率）
    const minEdgeT = 0.6;      // 最低でも半径の60%までは試す
    const coarseStep = 0.05;   // 粗い減衰ステップ
    const refineIters = 8;     // 成功後の二分探索反復数
    const edgeErrorTol = Math.max(1e-4, stopRadius * 1e-4); // 許容誤差（半径の0.01% or 0.1µm）
    
    if (debugMode) {
        console.log(`   主光線射出座標: (${chiefRayOrigin.x.toFixed(3)}, ${chiefRayOrigin.y.toFixed(3)}, ${chiefRayOrigin.z.toFixed(3)})`);
        console.log(`   方向ベクトル: (${direction.i.toFixed(6)}, ${direction.j.toFixed(6)}, ${direction.k.toFixed(6)})`);
        console.log(`   垂直面uベクトル: (${u.x.toFixed(6)}, ${u.y.toFixed(6)}, ${u.z.toFixed(6)})`);
        console.log(`   垂直面vベクトル: (${v.x.toFixed(6)}, ${v.y.toFixed(6)}, ${v.z.toFixed(6)})`);
        console.log(`   Stop面中心: (${stopCenter.x.toFixed(3)}, ${stopCenter.y.toFixed(3)}, ${stopCenter.z.toFixed(3)}), 半径: ${stopRadius.toFixed(3)}mm`);
        console.log(`   🎯 新しい探索設定: Newton最大反復=${maxIterations}, 許容誤差=${tolerance}mm, Grid反復=${gridMaxIterations}`);
    }
    
    // --- 新方式: Stop面上の線と円の交点から2点ずつ（垂直/水平）を得る ---
    const traceToStop = (startOrigin) => {
        const ray = { pos: startOrigin, dir: { x: direction.i, y: direction.j, z: direction.k }, wavelength: wavelength };
        const path = traceRayForRenderTs(opticalSystemRows, ray, 1.0, null, stopSurfaceIndex + 1);
        const p = getRayPointAtSurfaceIndex(path, opticalSystemRows, stopSurfaceIndex);
        if (p) return p;
        return null;
    };

    const posOnPerp = (cu, cv) => calculatePerpendicularPlanePosition(chiefRayOrigin, direction, u, v, cu, cv);

    const estimateLineDirOnStop = (axis) => {
        const p0 = traceToStop(chiefRayOrigin);
        if (!p0) return null;
        let s = Math.max(0.5, stopRadius * 0.1);
        for (let tries = 0; tries < 3; tries++) {
            const offP = axis === 'v' ? posOnPerp(0, +s) : posOnPerp(+s, 0);
            const offM = axis === 'v' ? posOnPerp(0, -s) : posOnPerp(-s, 0);
            const pPlus = traceToStop(offP);
            const pMinus = traceToStop(offM);
            if (pPlus && pMinus) {
                const dx = (pPlus.x - pMinus.x) / (2 * s);
                const dy = (pPlus.y - pMinus.y) / (2 * s);
                const mag = Math.hypot(dx, dy);
                if (mag > 1e-9) return { p0, dir: { x: dx / mag, y: dy / mag } };
            }
            s *= 0.5;
        }
        return null;
    };

    const solveLineCircle = (p0, M) => {
        const C = { x: stopCenter.x, y: stopCenter.y };
        const d = { x: p0.x - C.x, y: p0.y - C.y };
        const A = M.x * M.x + M.y * M.y;
        const B = 2 * (M.x * d.x + M.y * d.y);
        const D = d.x * d.x + d.y * d.y - stopRadius * stopRadius;
        if (A < 1e-16) return null;
        const disc = B * B - 4 * A * D;
        if (disc < 0) return null;
        const sqrtDisc = Math.sqrt(Math.max(0, disc));
        const t1 = (-B - sqrtDisc) / (2 * A);
        const t2 = (-B + sqrtDisc) / (2 * A);
        return [t1, t2].sort((a, b) => a - b);
    };

    const tryTarget = (label, targetPt) => {
        const nr = calculateApertureRayNewton(
            chiefRayOrigin, direction, perpendicularPlane,
            targetPt, stopSurfaceIndex, opticalSystemRows,
            maxIterations, tolerance, debugMode
        );
        let res = nr; let method = 'newton';
        if (!nr.success || nr.error > edgeErrorTol) {
            // 目標点に向かう停止面XY方向ベクトルを推定し、それに一致するようにBrentの探索方向を与える
            const p0 = { x: stopCenter.x, y: stopCenter.y };
            const tv = { x: targetPt.x - p0.x, y: targetPt.y - p0.y };
            const br = calculateApertureRayBrent(
                chiefRayOrigin, direction, perpendicularPlane,
                { name: label, searchVec: tv }, stopCenter, stopRadius, stopSurfaceIndex,
                opticalSystemRows, gridMaxIterations, gridTolerance, debugMode, targetPt
            );
            if (br.success && br.error <= Math.max(edgeErrorTol, gridTolerance)) { res = br; method = 'brent-fallback'; }
        }
        if (res && res.success && res.error <= Math.max(edgeErrorTol, gridTolerance)) {
            apertureBoundaryRays.push({
                direction: label,
                origin: res.origin,
                directionVector: { ...direction },
                targetPoint: targetPt,
                actualPoint: res.actualStopPoint,
                error: res.error,
                converged: true,
                method,
                iterations: res.iterations || 0,
                edgeFraction: 1.0
            });
            return true;
        }
        return false;
    };

    // 2D勾配ベースの根探索（u/vの合成方向 q で半径誤差を0に）
    const rErrorAtUV = (cu, cv) => {
        const origin = calculatePerpendicularPlanePosition(chiefRayOrigin, direction, u, v, cu, cv);
        const p = traceToStop(origin);
        if (!p) return { ok: false };
        const dx = p.x - stopCenter.x;
        const dy = p.y - stopCenter.y;
        return { ok: true, rErr: Math.hypot(dx, dy) - stopRadius, p };
    };

    const estimateRadialGrad = () => {
        const h = Math.max(0.5, stopRadius * 0.05);
        const f0 = rErrorAtUV(0, 0);
        const fu = rErrorAtUV(+h, 0);
        const fv = rErrorAtUV(0, +h);
        if (!(f0.ok && fu.ok && fv.ok)) return null;
        const drdu = (fu.rErr - f0.rErr) / h;
        const drdv = (fv.rErr - f0.rErr) / h;
        const mag = Math.hypot(drdu, drdv);
        if (mag < 1e-8) return null;
        return { qU: drdu / mag, qV: drdv / mag, f0 };
    };

    const rootAlongGrad = (sign) => {
        const g = estimateRadialGrad();
        if (!g) return null;
        const dirU = g.qU * sign;
        const dirV = g.qV * sign;
        // f(s) = rErrorAtUV(s*dirU, s*dirV)
        let s0 = 0, f0 = g.f0;
        let s = Math.max(1.0, stopRadius * 0.2);
        let f = rErrorAtUV(dirU * s, dirV * s);
        let tries = 0;
        while ((!(f && f.ok)) || f.rErr * f0.rErr > 0) {
            s *= 1.6;
            if (s > Math.max(80, stopRadius * 6)) break;
            f = rErrorAtUV(dirU * s, dirV * s);
            if (++tries > 20) break;
        }
        if (!(f && f.ok) || f.rErr * f0.rErr > 0) return null;
        // 二分探索
        let lo = s0, hi = s;
        let flo = f0, fhi = f;
        for (let it = 0; it < 40; it++) {
            const mid = 0.5 * (lo + hi);
            const fm = rErrorAtUV(dirU * mid, dirV * mid);
            if (!(fm && fm.ok)) { lo = mid; continue; }
            if (Math.abs(fm.rErr) <= edgeErrorTol) {
                const origin = calculatePerpendicularPlanePosition(chiefRayOrigin, direction, u, v, dirU * mid, dirV * mid);
                return { origin, stopPoint: fm.p };
            }
            if (flo.rErr * fm.rErr <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
        }
        const best = Math.abs(flo.rErr) < Math.abs(fhi.rErr) ? flo : fhi;
        if (Math.abs(best.rErr) <= Math.max(edgeErrorTol, stopRadius * 0.02)) {
            const sBest = Math.abs(best.rErr) === Math.abs(flo.rErr) ? lo : hi;
            const origin = calculatePerpendicularPlanePosition(chiefRayOrigin, direction, u, v, dirU * sBest, dirV * sBest);
            const p = rErrorAtUV(dirU * sBest, dirV * sBest).p;
            return { origin, stopPoint: p };
        }
        return null;
    };

    // 1D 根探索: 垂直面のu/v軸上で射出点を動かし、停止面での半径誤差 g(s)=|P(s)-C|-R=0 を解く
    const gOfS = (axis, sSigned) => {
        const cu = axis === 'u' ? sSigned : 0;
        const cv = axis === 'v' ? sSigned : 0;
        const origin = calculatePerpendicularPlanePosition(chiefRayOrigin, direction, u, v, cu, cv);
        const p = traceToStop(origin);
        if (!p) return { ok: false };
        const dx = p.x - stopCenter.x;
        const dy = p.y - stopCenter.y;
        const rErr = Math.hypot(dx, dy) - stopRadius;
        return { ok: true, val: rErr, origin, stopPoint: p };
    };

    const rootFindAxis = (axis, sign) => {
        const sMax = Math.max(40, stopRadius * 4);
        // 円周からの半径誤差をこれ以下ならエッジ近傍として採用（可視ギャップ低減）
        const nearTol = Math.max(stopRadius * 0.01, 0.05); // 半径の1% もしくは 0.05mm
        // 始点
        let sPrev = 0;
        let fPrev = gOfS(axis, sPrev);
        if (!fPrev.ok) {
            sPrev = 0.5 * sign;
            fPrev = gOfS(axis, sPrev);
            if (!fPrev.ok) return null;
        }
        let best = { s: sPrev, f: fPrev };
        let s = sPrev;
        let step = Math.max(0.5, stopRadius * 0.1) * sign;
        let lastOk = { s: sPrev, f: fPrev };
        let bracket = null;
        for (let it = 0; it < 80; it++) {
            s += step;
            if (Math.abs(s) > sMax) break;
            const f = gOfS(axis, s);
            if (!f.ok) {
                // これ以上外側はビグネット → 近傍での局所最小化に切替
                break;
            }
            // 近似最良を更新
            if (Math.abs(f.val) < Math.abs(best.f.val)) best = { s, f };
            lastOk = { s, f };
            // 符号反転で根を挟んだ → 二分探索
            if (fPrev.val * f.val <= 0) {
                let lo = sPrev, hi = s;
                let flo = fPrev, fhi = f;
                for (let j = 0; j < 40; j++) {
                    const mid = 0.5 * (lo + hi);
                    const fm = gOfS(axis, mid);
                    if (!fm.ok) {
                        // 失敗時は端点を少し詰める
                        if (sign > 0) lo = mid; else hi = mid;
                        continue;
                    }
                    if (Math.abs(fm.val) <= edgeErrorTol) {
                        return { origin: fm.origin, stopPoint: fm.stopPoint };
                    }
                    if (flo.val * fm.val <= 0) { hi = mid; fhi = fm; }
                    else { lo = mid; flo = fm; }
                }
                // 二分未収束でも端点で妥協
                const endBest = Math.abs(flo.val) < Math.abs(fhi.val) ? flo : fhi;
                if (Math.abs(endBest.val) <= nearTol) return { origin: endBest.origin, stopPoint: endBest.stopPoint };
                bracket = { lo, hi, flo, fhi };
                break;
            }
            // 次の反復へ
            sPrev = s; fPrev = f;
            // 歩幅を少し増やして探索を加速
            step *= 1.25;
        }
        // ここまでで根が挟めなかった場合、lastOk近傍で局所探索して|g|最小を詰める
        if (!bracket && lastOk) {
            let d = Math.max(2.0, Math.abs(step) * 0.5) * sign;
            let center = lastOk.s;
            let bestLocal = lastOk;
            for (let it = 0; it < 30; it++) {
                const sTry = center - d; // 内側に戻りながら探索
                const fTry = gOfS(axis, sTry);
                if (fTry.ok) {
                    if (Math.abs(fTry.val) < Math.abs(bestLocal.f.val)) {
                        bestLocal = { s: sTry, f: fTry };
                    }
                    center = sTry; // 改善方向へ移動
                }
                d *= 0.5; // 歩幅縮小
                if (Math.abs(bestLocal.f.val) <= nearTol) break;
            }
            if (Math.abs(bestLocal.f.val) <= nearTol) {
                return { origin: bestLocal.f.origin, stopPoint: bestLocal.f.stopPoint };
            }
        }
        // それでも駄目なら最良を返すかnull
        if (best && Math.abs(best.f.val) <= nearTol * 2) {
            return { origin: best.f.origin, stopPoint: best.f.stopPoint };
        }
        return null;
    };

    // chief→candidateOrigin の平面内方向で1D二分探索（円周一致へ強制）
    const rootFindAlongVector = (candidateOrigin) => {
        const dv = {
            x: candidateOrigin.x - chiefRayOrigin.x,
            y: candidateOrigin.y - chiefRayOrigin.y,
            z: candidateOrigin.z - chiefRayOrigin.z
        };
        const du0 = dv.x * u.x + dv.y * u.y + dv.z * u.z;
        const dv0 = dv.x * v.x + dv.y * v.y + dv.z * v.z;
        const gS = (s) => {
            const origin = calculatePerpendicularPlanePosition(chiefRayOrigin, direction, u, v, du0 * s, dv0 * s);
            const p = traceToStop(origin);
            if (!p) return { ok: false };
            const dx = p.x - stopCenter.x;
            const dy = p.y - stopCenter.y;
            return { ok: true, val: Math.hypot(dx, dy) - stopRadius, origin, stopPoint: p };
        };
        let lo = 0, hi = 1;
        let flo = gS(lo), fhi = gS(hi);
        if (!(flo.ok && fhi.ok)) return null;
        let expand = 0;
        while (flo.val * fhi.val > 0 && expand < 5) {
            hi *= 1.6;
            fhi = gS(hi);
            if (!fhi.ok || hi > 8) break;
            expand++;
        }
        if (flo.ok && fhi.ok && flo.val * fhi.val <= 0) {
            for (let it = 0; it < 40; it++) {
                const mid = 0.5 * (lo + hi);
                const fm = gS(mid);
                if (!fm.ok) { lo = mid; continue; }
                if (Math.abs(fm.val) <= edgeErrorTol) return { origin: fm.origin, stopPoint: fm.stopPoint, err: Math.abs(fm.val) };
                if (flo.val * fm.val <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
            }
            const best = Math.abs(flo.val) < Math.abs(fhi.val) ? flo : fhi;
            return { origin: best.origin, stopPoint: best.stopPoint, err: Math.abs(best.val) };
        }
        return null;
    };

    // 優先: 勾配ベース（半径最大増加方向）で2点取得
    const gradPlus = rootAlongGrad(+1);
    const gradMinus = rootAlongGrad(-1);
    if (gradPlus && gradMinus) {
        // 勾配ベースで得た2点を y の符号と大きさで上下に分類
        const p1 = gradPlus.stopPoint;
        const p2 = gradMinus.stopPoint;
        const dy1 = p1.y - stopCenter.y;
        const dy2 = p2.y - stopCenter.y;

        let upCandidate = null;
        let downCandidate = null;

        if (dy1 === 0 && dy2 === 0) {
            // 両方とも stopCenter と同じ → 上下は未確定。後段の rootFindAxis('v', ±1) に委ねる。
        } else if (Math.sign(dy1) !== Math.sign(dy2)) {
            // 符号が異なるので素直に割当
            upCandidate = dy1 > 0 ? p1 : p2;
            downCandidate = dy1 < 0 ? p1 : p2;
        } else {
            // 符号が同じ（両方上側または両方下側）→ 絶対値が大きい方のみその側の候補とし、反対側は未確定
            if (Math.abs(dy1) >= Math.abs(dy2)) {
                if (dy1 > 0) upCandidate = p1; else downCandidate = p1;
            } else {
                if (dy2 > 0) upCandidate = p2; else downCandidate = p2;
            }
        }

        if (upCandidate) {
            tryTarget('upper', { x: upCandidate.x, y: upCandidate.y, z: stopCenter.z });
        }
        if (downCandidate) {
            tryTarget('lower', { x: downCandidate.x, y: downCandidate.y, z: stopCenter.z });
        }

        // 右左は従来通り大きさ比較（符号分離要求は現状 y のみ）
        const dx1 = p1.x - stopCenter.x;
        const dx2 = p2.x - stopCenter.x;
        const rightCandidate = dx1 === 0 && dx2 === 0 ? null : (p1.x >= p2.x ? p1 : p2);
        const leftCandidate  = dx1 === 0 && dx2 === 0 ? null : (p1.x <  p2.x ? p1 : p2);
        if (rightCandidate) {
            tryTarget('right', { x: rightCandidate.x, y: rightCandidate.y, z: stopCenter.z });
        }
        if (leftCandidate) {
            tryTarget('left', { x: leftCandidate.x, y: leftCandidate.y, z: stopCenter.z });
        }
    }

    // 垂直方向（v軸）: 根探索で上下を直接求める（補助）
    const vUpper = rootFindAxis('v', +1);
    if (vUpper && !apertureBoundaryRays.some(r => r.direction === 'upper')) {
        const dx = vUpper.stopPoint.x - stopCenter.x;
        const dy = vUpper.stopPoint.y - stopCenter.y;
        const r = Math.hypot(dx, dy) || 1;
        const proj = { x: stopCenter.x + dx * (stopRadius / r), y: stopCenter.y + dy * (stopRadius / r) };
        // まず投影円周点を目標に高精度収束を試みる（成功すればこちらを採用）
    const refined = tryTarget('upper', { x: proj.x, y: proj.y, z: stopCenter.z });
        if (!refined) {
            const oneD = rootFindAlongVector(vUpper.origin);
            if (oneD && oneD.err <= Math.max(edgeErrorTol, stopRadius * 0.005)) {
                apertureBoundaryRays.push({ direction: 'upper', origin: oneD.origin, directionVector: { ...direction }, targetPoint: { x: proj.x, y: proj.y, z: stopCenter.z }, actualPoint: oneD.stopPoint, error: oneD.err, converged: true, method: '1d-bisection', iterations: 0, edgeFraction: 1.0 });
            } else {
            // 収束しなければ軸ベースの近似解を採用
            apertureBoundaryRays.push({
                direction: 'upper',
                origin: vUpper.origin,
                directionVector: { ...direction },
                targetPoint: { x: proj.x, y: proj.y, z: stopCenter.z },
                actualPoint: vUpper.stopPoint,
                error: Math.abs(Math.hypot(dx, dy) - stopRadius),
                converged: true,
                method: 'axis-root',
                iterations: 0,
                edgeFraction: 1.0
            });
            }
        }
    }
    const vLower = rootFindAxis('v', -1);
    if (vLower && !apertureBoundaryRays.some(r => r.direction === 'lower')) {
        const dx = vLower.stopPoint.x - stopCenter.x;
        const dy = vLower.stopPoint.y - stopCenter.y;
        const r = Math.hypot(dx, dy) || 1;
        const proj = { x: stopCenter.x + dx * (stopRadius / r), y: stopCenter.y + dy * (stopRadius / r) };
    const refined = tryTarget('lower', { x: proj.x, y: proj.y, z: stopCenter.z });
        if (!refined) {
            const oneD = rootFindAlongVector(vLower.origin);
            if (oneD && oneD.err <= Math.max(edgeErrorTol, stopRadius * 0.005)) {
                apertureBoundaryRays.push({ direction: 'lower', origin: oneD.origin, directionVector: { ...direction }, targetPoint: { x: proj.x, y: proj.y, z: stopCenter.z }, actualPoint: oneD.stopPoint, error: oneD.err, converged: true, method: '1d-bisection', iterations: 0, edgeFraction: 1.0 });
            } else {
            apertureBoundaryRays.push({
                direction: 'lower',
                origin: vLower.origin,
                directionVector: { ...direction },
                targetPoint: { x: proj.x, y: proj.y, z: stopCenter.z },
                actualPoint: vLower.stopPoint,
                error: Math.abs(Math.hypot(dx, dy) - stopRadius),
                converged: true,
                method: 'axis-root',
                iterations: 0,
                edgeFraction: 1.0
            });
            }
        }
    }

    // 水平方向（u軸）
    console.log(`🔍 [ApertureRays] 水平方向（right）の光線探索を開始...`);
    const uRight = rootFindAxis('u', +1);
    if (uRight) {
        console.log(`✅ [ApertureRays] 右側光線の初期候補が見つかりました: (${uRight.stopPoint.x.toFixed(3)}, ${uRight.stopPoint.y.toFixed(3)})`);
    } else {
        console.warn(`⚠️ [ApertureRays] 右側光線の初期候補が見つかりませんでした`);
    }
    if (uRight && !apertureBoundaryRays.some(r => r.direction === 'right')) {
        const dx = uRight.stopPoint.x - stopCenter.x;
        const dy = uRight.stopPoint.y - stopCenter.y;
        const r = Math.hypot(dx, dy) || 1;
        const proj = { x: stopCenter.x + dx * (stopRadius / r), y: stopCenter.y + dy * (stopRadius / r) };
        console.log(`🎯 [ApertureRays] 右側光線の目標点: (${proj.x.toFixed(3)}, ${proj.y.toFixed(3)})`);
    const refined = tryTarget('right', { x: proj.x, y: proj.y, z: stopCenter.z });
        if (!refined) {
            const oneD = rootFindAlongVector(uRight.origin);
            if (oneD && oneD.err <= Math.max(edgeErrorTol, stopRadius * 0.005)) {
                apertureBoundaryRays.push({ direction: 'right', origin: oneD.origin, directionVector: { ...direction }, targetPoint: { x: proj.x, y: proj.y, z: stopCenter.z }, actualPoint: oneD.stopPoint, error: oneD.err, converged: true, method: '1d-bisection', iterations: 0, edgeFraction: 1.0 });
            } else {
            apertureBoundaryRays.push({
                direction: 'right',
                origin: uRight.origin,
                directionVector: { ...direction },
                targetPoint: { x: proj.x, y: proj.y, z: stopCenter.z },
                actualPoint: uRight.stopPoint,
                error: Math.abs(Math.hypot(dx, dy) - stopRadius),
                converged: true,
                method: 'axis-root',
                iterations: 0,
                edgeFraction: 1.0
            });
            }
        }
    }
    console.log(`🔍 [ApertureRays] 水平方向（left）の光線探索を開始...`);
    const uLeft = rootFindAxis('u', -1);
    if (uLeft) {
        console.log(`✅ [ApertureRays] 左側光線の初期候補が見つかりました: (${uLeft.stopPoint.x.toFixed(3)}, ${uLeft.stopPoint.y.toFixed(3)})`);
    } else {
        console.warn(`⚠️ [ApertureRays] 左側光線の初期候補が見つかりませんでした`);
    }
    if (uLeft && !apertureBoundaryRays.some(r => r.direction === 'left')) {
        console.log(`✅ [ApertureRays] 左側光線の初期候補が見つかりました: (${uLeft.stopPoint.x.toFixed(3)}, ${uLeft.stopPoint.y.toFixed(3)})`);
    } else {
        console.warn(`⚠️ [ApertureRays] 左側光線の初期候補が見つかりませんでした`);
    }
    if (uLeft && !apertureBoundaryRays.some(r => r.direction === 'left')) {
        const dx = uLeft.stopPoint.x - stopCenter.x;
        const dy = uLeft.stopPoint.y - stopCenter.y;
        const r = Math.hypot(dx, dy) || 1;
        const proj = { x: stopCenter.x + dx * (stopRadius / r), y: stopCenter.y + dy * (stopRadius / r) };
        console.log(`🎯 [ApertureRays] 左側光線の目標点: (${proj.x.toFixed(3)}, ${proj.y.toFixed(3)})`);
    const refined = tryTarget('left', { x: proj.x, y: proj.y, z: stopCenter.z });
        if (!refined) {
            const oneD = rootFindAlongVector(uLeft.origin);
            if (oneD && oneD.err <= Math.max(edgeErrorTol, stopRadius * 0.005)) {
                apertureBoundaryRays.push({ direction: 'left', origin: oneD.origin, directionVector: { ...direction }, targetPoint: { x: proj.x, y: proj.y, z: stopCenter.z }, actualPoint: oneD.stopPoint, error: oneD.err, converged: true, method: '1d-bisection', iterations: 0, edgeFraction: 1.0 });
            } else {
            apertureBoundaryRays.push({
                direction: 'left',
                origin: uLeft.origin,
                directionVector: { ...direction },
                targetPoint: { x: proj.x, y: proj.y, z: stopCenter.z },
                actualPoint: uLeft.stopPoint,
                error: Math.abs(Math.hypot(dx, dy) - stopRadius),
                converged: true,
                method: 'axis-root',
                iterations: 0,
                edgeFraction: 1.0
            });
            }
        }
    }

    // 足りない方向は近接t(0.98→0.80)を順に試行してから幾何フォールバック
    const have = (name) => apertureBoundaryRays.some(r => r.direction === name);
    const axisTarget = (name, t) => {
        if (name === 'upper' || name === 'lower') {
            return { x: stopCenter.x, y: stopCenter.y + (name === 'upper' ? 1 : -1) * stopRadius * t, z: stopCenter.z };
        } else {
            return { x: stopCenter.x + (name === 'right' ? 1 : -1) * stopRadius * t, y: stopCenter.y, z: stopCenter.z };
        }
    };
    ['upper','lower','left','right'].forEach(name => {
        if (!have(name)) {
            let placed = false;
            for (let t = 0.98; t >= 0.80; t -= 0.02) {
                const tgt = axisTarget(name, t);
                if (tryTarget(name, tgt)) {
                    // 直近で追加された要素のedgeFractionを設定
                    const last = apertureBoundaryRays[apertureBoundaryRays.length - 1];
                    if (last && last.direction === name) last.edgeFraction = t;
                    placed = true;
                    break;
                }
            }
            if (!placed) {
                // 最終フォールバック: ほぼ円周上（t=0.98）に配置して視覚的な隙間を抑制
                const t = 0.98;
                const tgt = axisTarget(name, t);
                const origin = {
                    // 射出面上の主光線→目標方向へ寄せる（数値安定性用に控えめ）
                    x: chiefRayOrigin.x + (tgt.x - chiefRayOrigin.x) * 0.3,
                    y: chiefRayOrigin.y + (tgt.y - chiefRayOrigin.y) * 0.3,
                    z: chiefRayOrigin.z
                };
                apertureBoundaryRays.push({
                    direction: name,
                    origin,
                    directionVector: { ...direction },
                    targetPoint: tgt,
                    actualPoint: tgt,
                    error: stopRadius * (1 - t),
                    converged: false,
                    method: 'geometric-fallback',
                    iterations: 0,
                    edgeFraction: t
                });
            }
        }
    });
    
    // 絞り周辺光線探索の統計情報を出力（デバッグモードに関係なく常に出力）
    console.log(`   総探索方向: 4 (上下左右)`);
    console.log(`   成功した方向: ${apertureBoundaryRays.length}`);
    console.log(`   成功率: ${(apertureBoundaryRays.length / 4 * 100).toFixed(1)}%`);
    
    apertureBoundaryRays.forEach((ray, index) => {
        const method = ray.method || (ray.converged ? 'newton-converged' : 'newton-best');
        const errorPercent = ray.error ? (ray.error / stopRadius * 100).toFixed(1) : 'N/A';
        console.log(`   ${index + 1}. ${ray.direction}: ${method}, 誤差=${ray.error?.toFixed(3)}mm (${errorPercent}%), 反復=${ray.iterations || 'N/A'}`);
    });
    
    if (apertureBoundaryRays.length < 4) {
        const missing = ['upper', 'lower', 'left', 'right'].filter(dir => 
                !apertureBoundaryRays.some(ray => ray.direction === dir)
            );
        console.log(`   ⚠️ 未成功方向: ${missing.join(', ')}`);
        console.log(`   💡 光線範囲への影響: ${missing.length < 2 ? '軽微' : missing.length < 3 ? '中程度' : '大きい'}`);
    }
    
    return apertureBoundaryRays;
}

/**
 * 無限系用クロスビーム光線を生成
 * @param {Object} chiefRayOrigin - 主光線射出座標
 * @param {Object} direction - 方向ベクトル
 * @param {Object} perpendicularPlane - 垂直面情報
 * @param {Array} apertureBoundaryRays - 絞り周辺光線
 * @param {number} rayCount - 光線数
 * @param {string} crossType - クロスタイプ
 * @param {boolean} debugMode - デバッグモード
 * @returns {Array} 生成された光線配列
 */
function generateInfiniteSystemCrossBeamRays(chiefRayOrigin, direction, perpendicularPlane, apertureBoundaryRays, rayCount, crossType, debugMode) {
    const rays = [];
    const { u, v } = perpendicularPlane;
    
    if (debugMode) {
        console.log(`🔍 [InfiniteCrossBeam] 改良版光線生成開始: 総数${rayCount}`);
        console.log(`   主光線射出座標: (${chiefRayOrigin.x.toFixed(3)}, ${chiefRayOrigin.y.toFixed(3)}, ${chiefRayOrigin.z.toFixed(3)})`);
        console.log(`   方向ベクトル: (${direction.i.toFixed(6)}, ${direction.j.toFixed(6)}, ${direction.k.toFixed(6)})`);
        console.log(`   垂直面uベクトル: (${u.x.toFixed(6)}, ${u.y.toFixed(6)}, ${u.z.toFixed(6)})`);
        console.log(`   垂直面vベクトル: (${v.x.toFixed(6)}, ${v.y.toFixed(6)}, ${v.z.toFixed(6)})`);
    }

    // 1. 主光線を最初に追加
    rays.push({
        position: { ...chiefRayOrigin },
        direction: {
            x: direction.i,
            y: direction.j,
            z: direction.k
        },
        type: 'chief',
        objectIndex: 0,
        rayIndex: 0
    });

    // 絞り周辺光線を探索
    const leftRay = apertureBoundaryRays.find(ray => ray.direction === 'left');
    const rightRay = apertureBoundaryRays.find(ray => ray.direction === 'right');
    const topRay = apertureBoundaryRays.find(ray => ray.direction === 'upper');
    const bottomRay = apertureBoundaryRays.find(ray => ray.direction === 'lower');
    
    if (debugMode) {
        console.log(`🔍 [CrossBeam] 絞り周辺光線探索結果:`);
        console.log(`   左側光線: ${leftRay ? `見つかった (誤差${leftRay.error?.toFixed(3)}mm, 収束${leftRay.converged !== false ? 'Yes' : 'No'})` : '見つからない'}`);
        console.log(`   右側光線: ${rightRay ? `見つかった (誤差${rightRay.error?.toFixed(3)}mm, 収束${rightRay.converged !== false ? 'Yes' : 'No'})` : '見つからない'}`);
        console.log(`   上側光線: ${topRay ? `見つかった (誤差${topRay.error?.toFixed(3)}mm, 収束${topRay.converged !== false ? 'Yes' : 'No'})` : '見つからない'}`);
        console.log(`   下側光線: ${bottomRay ? `見つかった (誤差${bottomRay.error?.toFixed(3)}mm, 収束${bottomRay.converged !== false ? 'Yes' : 'No'})` : '見つからない'}`);
    }
    
    let rayIndex = 1;  // 主光線の次から開始
    
    // 2. 最周辺光線を追加（優先順位: 左、右、上、下）
    const boundaryRays = [];
    
    if (leftRay) {
        // 境界光線 origin を主光線方向ベクトルに沿って射影して chief に垂直な平面上に正規化
        const o = leftRay.origin;
        const d = { x: direction.i, y: direction.j, z: direction.k };
        const oc = { x: o.x - chiefRayOrigin.x, y: o.y - chiefRayOrigin.y, z: o.z - chiefRayOrigin.z };
        const dd = d.x*d.x + d.y*d.y + d.z*d.z;
        const t = dd > 0 ? -(d.x*oc.x + d.y*oc.y + d.z*oc.z) / dd : 0;
        const projected = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t }; // (projected - chief) · d = 0
        const position = projected; // 平面外成分を再注入しない（z固定しない）
        if (debugMode) {
            const violation = ( (position.x-chiefRayOrigin.x)*d.x + (position.y-chiefRayOrigin.y)*d.y + (position.z-chiefRayOrigin.z)*d.z );
            if (Math.abs(violation) > 1e-6) {
                console.warn(`   ⚠️ [CrossBeam] left射影後 平面直交ずれ= ${violation.toExponential(2)}`);
            }
        }

        boundaryRays.push({
            ray: leftRay,
            name: 'left',
            position,
            direction: { x: d.x, y: d.y, z: d.z },
            type: 'boundary',
            side: 'left'
        });
    }
    
    if (rightRay) {
        const o = rightRay.origin;
        const d = { x: direction.i, y: direction.j, z: direction.k };
        const oc = { x: o.x - chiefRayOrigin.x, y: o.y - chiefRayOrigin.y, z: o.z - chiefRayOrigin.z };
        const dd = d.x*d.x + d.y*d.y + d.z*d.z;
        const t = dd > 0 ? -(d.x*oc.x + d.y*oc.y + d.z*oc.z) / dd : 0;
        const projected = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
        const position = projected;
        if (debugMode) {
            const violation = ( (position.x-chiefRayOrigin.x)*d.x + (position.y-chiefRayOrigin.y)*d.y + (position.z-chiefRayOrigin.z)*d.z );
            if (Math.abs(violation) > 1e-6) {
                console.warn(`   ⚠️ [CrossBeam] right射影後 平面直交ずれ= ${violation.toExponential(2)}`);
            }
        }

        boundaryRays.push({
            ray: rightRay,
            name: 'right',
            position,
            direction: { x: d.x, y: d.y, z: d.z },
            type: 'boundary',
            side: 'right'
        });
    }
    
    if (topRay) {
        const o = topRay.origin;
        const d = { x: direction.i, y: direction.j, z: direction.k };
        const oc = { x: o.x - chiefRayOrigin.x, y: o.y - chiefRayOrigin.y, z: o.z - chiefRayOrigin.z };
        const dd = d.x*d.x + d.y*d.y + d.z*d.z;
        const t = dd > 0 ? -(d.x*oc.x + d.y*oc.y + d.z*oc.z) / dd : 0;
        const projected = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
        const position = projected;
        if (debugMode) {
            const violation = ( (position.x-chiefRayOrigin.x)*d.x + (position.y-chiefRayOrigin.y)*d.y + (position.z-chiefRayOrigin.z)*d.z );
            if (Math.abs(violation) > 1e-6) {
                console.warn(`   ⚠️ [CrossBeam] upper射影後 平面直交ずれ= ${violation.toExponential(2)}`);
            }
        }

        boundaryRays.push({
            ray: topRay,
            name: 'upper',
            position,
            direction: { x: d.x, y: d.y, z: d.z },
            type: 'boundary',
            side: 'upper'
        });
    }
    
    if (bottomRay) {
        const o = bottomRay.origin;
        const d = { x: direction.i, y: direction.j, z: direction.k };
        const oc = { x: o.x - chiefRayOrigin.x, y: o.y - chiefRayOrigin.y, z: o.z - chiefRayOrigin.z };
        const dd = d.x*d.x + d.y*d.y + d.z*d.z;
        const t = dd > 0 ? -(d.x*oc.x + d.y*oc.y + d.z*oc.z) / dd : 0;
        const projected = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
        const position = projected;
        if (debugMode) {
            const violation = ( (position.x-chiefRayOrigin.x)*d.x + (position.y-chiefRayOrigin.y)*d.y + (position.z-chiefRayOrigin.z)*d.z );
            if (Math.abs(violation) > 1e-6) {
                console.warn(`   ⚠️ [CrossBeam] lower射影後 平面直交ずれ= ${violation.toExponential(2)}`);
            }
        }

        boundaryRays.push({
            ray: bottomRay,
            name: 'lower',
            position,
            direction: { x: d.x, y: d.y, z: d.z },
            type: 'boundary',
            side: 'lower'
        });
    }
    
    // 最周辺光線を追加
    const pushedBoundarySides = new Set();
    for (const boundaryRay of boundaryRays) {
        if (rayIndex < rayCount) {
            rays.push({
                position: boundaryRay.position,
                direction: boundaryRay.direction,
                type: boundaryRay.type,
                side: boundaryRay.side,
                objectIndex: 0,
                rayIndex: rayIndex++
            });
            pushedBoundarySides.add(boundaryRay.side);
            
            if (debugMode) {
                console.log(`   追加: ${boundaryRay.name}側最周辺光線 (${boundaryRay.position.x.toFixed(3)}, ${boundaryRay.position.y.toFixed(3)}, ${boundaryRay.position.z.toFixed(3)})`);
            }
        }
    }
    
    // 3. 残りの光線を「主光線⇄各周辺光線」の区間で等分配置（広画角でも均一）
    if (rayIndex < rayCount) {
        const remainingRays = rayCount - rayIndex;
        if (debugMode) {
            console.log(`🔍 [CrossBeam] 主光線⇄周辺光線の等分配置を生成: ${remainingRays}本`);
        }

        // 利用可能な方向の収集
        const dirs = [];
        if (leftRay) dirs.push('left');
        if (rightRay) dirs.push('right');
        if (topRay) dirs.push('upper');
        if (bottomRay) dirs.push('lower');

    if (dirs.length === 0) {
            // フォールバック: 主光線周りの小さな放射
            if (debugMode) console.log(`   ⚠️ 利用可能な周辺光線がありません。放射状に配置します`);
            for (let i = 0; i < remainingRays && rayIndex < rayCount; i++) {
                const angle = (i / Math.max(1, remainingRays)) * 2 * Math.PI;
                const du = Math.cos(angle);
                const dv = Math.sin(angle);
                const pos = {
                    x: chiefRayOrigin.x + u.x * du + v.x * dv,
                    y: chiefRayOrigin.y + u.y * du + v.y * dv,
                    z: chiefRayOrigin.z + u.z * du + v.z * dv
                };
                rays.push({
                    position: pos,
                    direction: { x: direction.i, y: direction.j, z: direction.k },
                    type: 'radial_fallback',
                    side: `angle_${Math.round(angle * 180 / Math.PI)}deg`,
                    objectIndex: 0,
                    rayIndex: rayIndex++,
                    interpolationRatio: i / Math.max(1, remainingRays),
                    density: 'radial-fallback'
                });
            }
        } else {
            const base = Math.floor(remainingRays / dirs.length);
            let rem = remainingRays % dirs.length;

            // chief→boundary の真の平面内ベクトル（各方向）
            // 補間では、境界が見つかっている限りはその位置を使用する（誤差が大きくても描画の等分線は境界へ伸ばす）
            const boundaryOnPlane = {
                left: (() => { const b = boundaryRays.find(b => b.side === 'left'); return b?.position; })(),
                right: (() => { const b = boundaryRays.find(b => b.side === 'right'); return b?.position; })(),
                upper: (() => { const b = boundaryRays.find(b => b.side === 'upper') || boundaryRays.find(b => b.side === 'top'); return b?.position; })(),
                lower: (() => { const b = boundaryRays.find(b => b.side === 'lower') || boundaryRays.find(b => b.side === 'bottom'); return b?.position; })(),
            };

            const deltaVec = {};
            ['left','right','upper','lower'].forEach(key => {
                const p = boundaryOnPlane[key];
                if (p) {
                    deltaVec[key] = {
                        x: p.x - chiefRayOrigin.x,
                        y: p.y - chiefRayOrigin.y,
                        z: p.z - chiefRayOrigin.z
                    };
                }
            });

            for (let idx = 0; idx < dirs.length; idx++) {
                const dname = dirs[idx];
                const count = base + (rem > 0 ? 1 : 0);
                if (rem > 0) rem--;
                if (count <= 0) continue;

                for (let i = 0; i < count && rayIndex < rayCount; i++) {
                    const hasBoundary = !!boundaryOnPlane[dname];
                    const boundaryPushed = pushedBoundarySides.has(dname) || pushedBoundarySides.has(dname === 'upper' ? 'top' : dname === 'lower' ? 'bottom' : dname);
                    // 境界光線が無い方向では最終点をt=1（境界）に到達させる
                    const tfrac = (hasBoundary && boundaryPushed) ? (i + 1) / (count + 1) : (i + 1) / count;
                    const dv3 = deltaVec[dname];
                    let pos;
                    if (dv3) {
                        pos = {
                            x: chiefRayOrigin.x + dv3.x * tfrac,
                            y: chiefRayOrigin.y + dv3.y * tfrac,
                            z: chiefRayOrigin.z + dv3.z * tfrac
                        };
                    } else {
                        // 念のためのフォールバック（u/v軸）
                        const du = (dname === 'upper' || dname === 'lower') ? (dname === 'upper' ? +1 : -1) * tfrac : 0;
                        const dv = (dname === 'left' || dname === 'right') ? (dname === 'right' ? +1 : -1) * tfrac : 0;
                        pos = {
                            x: chiefRayOrigin.x + u.x * du + v.x * dv,
                            y: chiefRayOrigin.y + u.y * du + v.y * dv,
                            z: chiefRayOrigin.z + u.z * du + v.z * dv
                        };
                    }

                    const type = (dname === 'left' || dname === 'right') ? 'horizontal_cross' : 'vertical_cross';

                    rays.push({
                        position: pos,
                        direction: { x: direction.i, y: direction.j, z: direction.k },
                        type,
                        side: dname,
                        objectIndex: 0,
                        rayIndex: rayIndex++,
                        interpolationRatio: tfrac,
                        density: 'cross_beam'
                    });

                    if (debugMode) {
                        console.log(`   ${type} ${dname} t=${tfrac.toFixed(3)} pos=(${pos.x.toFixed(4)}, ${pos.y.toFixed(4)}, ${pos.z.toFixed(4)})`);
                    }
                }
            }
        }
    }
    
    if (debugMode) {
        console.log(`✅ [InfiniteCrossBeam] 対称光線配置完了: 総数${rays.length}`);
        console.log(`   主光線: 1本`);
        console.log(`   最周辺光線: ${boundaryRays.length}本`);
        console.log(`   対称補間光線: ${rays.length - 1 - boundaryRays.length}本`);
        console.log(`   crossType: ${crossType}`);
        
        // **重要**: 垂直面制約の検証
        console.log(`\n🔍 [PerpendicularPlane] 垂直面制約検証:`);
        console.log(`   主光線原点: (${chiefRayOrigin.x.toFixed(4)}, ${chiefRayOrigin.y.toFixed(4)}, ${chiefRayOrigin.z.toFixed(4)})`);
        console.log(`   方向ベクトル: (${direction.i.toFixed(6)}, ${direction.j.toFixed(6)}, ${direction.k.toFixed(6)})`);
        
        let violationCount = 0;
        rays.forEach((ray, index) => {
            const dx = ray.position.x - chiefRayOrigin.x;
            const dy = ray.position.y - chiefRayOrigin.y; 
            const dz = ray.position.z - chiefRayOrigin.z;
            const dotProduct = direction.i * dx + direction.j * dy + direction.k * dz;
            const violation = Math.abs(dotProduct);
            
            if (violation > 1e-8) {
                violationCount++;
                console.log(`   ❌ 光線${index} (${ray.type}): 違反=${violation.toFixed(10)} pos=(${ray.position.x.toFixed(4)}, ${ray.position.y.toFixed(4)}, ${ray.position.z.toFixed(4)})`);
            } else if (index < 10) { // 最初の10本についてOKを表示
                console.log(`   ✅ 光線${index} (${ray.type}): 制約満足 violation=${violation.toFixed(10)}`);
            }
        });
        
        if (violationCount === 0) {
            console.log(`   ✅ 全光線が垂直面制約を満たしています`);
        } else {
            console.log(`   ❌ ${violationCount}本の光線が垂直面制約に違反しています`);
        }
        
        // **重複検証**: 光線位置の重複チェック
        console.log(`\n🔍 [DuplicationCheck] 光線重複検証:`);
        const positionSet = new Set();
        const duplicates = [];
        
        rays.forEach((ray, index) => {
            const posKey = `${ray.position.x.toFixed(8)},${ray.position.y.toFixed(8)},${ray.position.z.toFixed(8)}`;
            if (positionSet.has(posKey)) {
                duplicates.push({ index, type: ray.type, position: ray.position });
            } else {
                positionSet.add(posKey);
            }
        });
        
        if (duplicates.length === 0) {
            console.log(`   ✅ 重複する光線位置なし`);
        } else {
            console.log(`   ❌ ${duplicates.length}個の重複光線を検出:`);
            duplicates.forEach(dup => {
                console.log(`     光線${dup.index} (${dup.type}): (${dup.position.x.toFixed(4)}, ${dup.position.y.toFixed(4)}, ${dup.position.z.toFixed(4)})`);
            });
        }
        
        // **XY軸検証**: 水平/垂直光線の座標配置確認
        console.log(`\n🔍 [AxisAlignment] XY軸配置検証:`);
        const horizontalRays = rays.filter(ray => ray.type === 'horizontal_cross');
        const verticalRays = rays.filter(ray => ray.type === 'vertical_cross');
        
        if (horizontalRays.length > 0) {
            const yValues = horizontalRays.map(ray => ray.position.y);
            const uniqueYs = [...new Set(yValues.map(y => y.toFixed(6)))];
            console.log(`   水平光線${horizontalRays.length}本: Y値=${uniqueYs.length}個 ${uniqueYs.length === 1 ? '✅' : '❌'}`);
            if (uniqueYs.length > 1) {
                console.log(`     Y値詳細: ${uniqueYs.join(', ')}`);
            }
        }
        
        if (verticalRays.length > 0) {
            const xValues = verticalRays.map(ray => ray.position.x);
            const uniqueXs = [...new Set(xValues.map(x => x.toFixed(6)))];
            console.log(`   垂直光線${verticalRays.length}本: X値=${uniqueXs.length}個 ${uniqueXs.length === 1 ? '✅' : '❌'}`);
            if (uniqueXs.length > 1) {
                console.log(`     X値詳細: ${uniqueXs.join(', ')}`);
            }
        }
        
        // 光線タイプ別の詳細統計
        const typeStats = rays.reduce((stats, ray) => {
            const key = ray.density ? `${ray.type}(${ray.density})` : ray.type;
            stats[key] = (stats[key] || 0) + 1;
            return stats;
        }, {});
        console.log(`   タイプ別統計:`, typeStats);
        
        // 各方向の光線数を表示（対称性の確認）
        const directionStats = rays.reduce((stats, ray) => {
            if (ray.side) {
                stats[ray.side] = (stats[ray.side] || 0) + 1;
            }
            return stats;
        }, {});
        console.log(`   方向別光線数（対称性確認）:`, directionStats);
        
        // 各方向の補間係数分布を表示
        const interpolatedRays = rays.filter(ray => ray.interpolationRatio !== undefined);
        if (interpolatedRays.length > 0) {
            console.log(`   補間係数分布（対称性確認）:`);
            ['left', 'right', 'top', 'bottom', 'center'].forEach(side => {
                const sideRays = interpolatedRays.filter(ray => ray.side === side);
                if (sideRays.length > 0) {
                    const ratios = sideRays.map(ray => ray.interpolationRatio.toFixed(3)).join(', ');
                    console.log(`     ${side} (${sideRays.length}本): [${ratios}]`);
                }
            });
        }
    }

    return rays;
}

/**
 * 光線追跡の実行
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Array} crossBeamRays - クロスビーム光線
 * @param {number} wavelength - 波長
 * @param {boolean} debugMode - デバッグモード
 * @param {number} targetSurfaceIndex - 評価面インデックス
 * @returns {Array} 追跡済み光線配列
 */
function traceCrossBeamRays(opticalSystemRows, crossBeamRays, wavelength, debugMode, targetSurfaceIndex) {
    const tracedRays = [];

    // calculateSurfaceOrigins は opticalSystemRows 参照でキャッシュされるため、
    // テーブルが「同一配列参照のまま内容だけ更新」されていると古い座標系で traceRay され得る。
    // Draw Cross は描画/診断の正確性を優先し、毎回新しい配列参照を渡してキャッシュをバストする。
    const systemRowsForTrace = Array.isArray(opticalSystemRows) ? opticalSystemRows.slice() : opticalSystemRows;

    const effectiveTargetIndex = Number.isInteger(targetSurfaceIndex)
        ? targetSurfaceIndex
        : Math.max(0, (systemRowsForTrace?.length ?? 1) - 1);

    // traceRay の rayPath は Object/Coord Trans 行を交点として記録しないため、
    // テーブル行インデックス(=surfaceIndex) → rayPath point index に変換して判定する。
    const effectiveTargetPointIndex = getRayPathPointIndexForSurfaceIndex(systemRowsForTrace, effectiveTargetIndex);
    
    for (let i = 0; i < crossBeamRays.length; i++) {
        const ray = crossBeamRays[i];
        
        try {
            // 光線位置の正規化（origin または position を position として統一）
            const rayPosition = ray.position || ray.origin;
            const rayDirection = ray.direction;
            
            if (!rayPosition || !rayDirection) {
                console.warn(`⚠️ [TraceRays] Ray ${i}: 不正な光線データ (position/direction missing)`);
                continue;
            }
            
            // 全面まで追跡（描画・評価を兼用）
            const rayPathFull = traceRayForRenderTs(systemRowsForTrace, {
                pos: rayPosition,
                dir: rayDirection,
                wavelength: wavelength  // 波長を追加
            }, 1.0);  // 全面追跡

            const rayPathToTarget = (Array.isArray(rayPathFull) && effectiveTargetPointIndex !== null)
                ? rayPathFull.slice(0, effectiveTargetPointIndex + 1)
                : rayPathFull;
            
            // NOTE: 「何か返った」ではなく「指定面まで到達」を成功とする
            const reachedTarget = Array.isArray(rayPathFull)
                && effectiveTargetPointIndex !== null
                && rayPathFull.length > effectiveTargetPointIndex;

            if (reachedTarget) {
                // メタデータ正規化（描画・集計向け）
                const origType = ray.type || '';
                const origSide = ray.side || '';
                let beamType;
                if (origType.includes('horizontal') || origSide === 'left' || origSide === 'right') {
                    beamType = 'horizontal';
                } else if (origType.includes('vertical') || origSide === 'upper' || origSide === 'lower' || origSide === 'top' || origSide === 'bottom') {
                    beamType = 'vertical';
                } else if (origType === 'chief') {
                    beamType = 'chief';
                }

                tracedRays.push({
                    success: true,
                    rayIndex: i,
                    originalRay: ray,
                    rayPath: rayPathFull || rayPathToTarget,
                    rayPathToTarget: rayPathToTarget || rayPathFull,
                    beamType,
                    side: origSide || undefined,
                    segments: Math.max(
                        (rayPathFull ? rayPathFull.length - 1 : 0),
                        (rayPathToTarget ? rayPathToTarget.length - 1 : 0)
                    )
                });
            } else {
                // 失敗時の扱い:
                // - 通常運用では「通ったように見える」合成直線パスは作らない（物理的な遮蔽を隠してしまう）
                // - debugMode のときだけ視認性目的で合成直線パスを許可する

                const needsDraw = ['boundary', 'horizontal_cross', 'vertical_cross'].includes(ray.type);
                if (needsDraw && debugMode) {
                    const fallbackLen = 120; // 視認性目的
                    const endPos = {
                        x: rayPosition.x + rayDirection.x * fallbackLen,
                        y: rayPosition.y + rayDirection.y * fallbackLen,
                        z: rayPosition.z + rayDirection.z * fallbackLen
                    };
                    const syntheticPath = [
                        { x: rayPosition.x, y: rayPosition.y, z: rayPosition.z, surfaceIndex: -1 },
                        { x: endPos.x, y: endPos.y, z: endPos.z, surfaceIndex: 'fallback' }
                    ];

                    const origType = ray.type || '';
                    const origSide = ray.side || '';
                    let beamType;
                    if (origType.includes('horizontal') || origSide === 'left' || origSide === 'right') {
                        beamType = 'horizontal';
                    } else if (origType.includes('vertical') || origSide === 'upper' || origSide === 'lower' || origSide === 'top' || origSide === 'bottom') {
                        beamType = 'vertical';
                    } else if (origType === 'chief') {
                        beamType = 'chief';
                    }

                    tracedRays.push({
                        success: false,
                        fallback: true,
                        fallbackReason: 'synthetic-straight-path(debugMode)',
                        rayIndex: i,
                        originalRay: ray,
                        rayPath: syntheticPath,
                        rayPathToTarget: syntheticPath,
                        beamType,
                        side: origSide || undefined,
                        segments: 1
                    });
                    console.warn(`⚠️ [TraceFallback] Ray ${i} (${ray.type}/${ray.side}) failed tracing → debugMode: 合成直線パスで代替描画`);
                } else {
                    tracedRays.push({
                        success: false,
                        rayIndex: i,
                        originalRay: ray,
                        rayPath: Array.isArray(rayPathFull) ? rayPathFull : null,
                        rayPathToTarget: Array.isArray(rayPathToTarget) ? rayPathToTarget : null,
                        error: 'Ray did not reach target surface'
                    });
                }
            }
        } catch (error) {
            tracedRays.push({
                success: false,
                rayIndex: i,
                originalRay: ray,
                rayPath: null,
                rayPathToTarget: null,  // 追加
                error: error.message
            });
        }
    }
    
    if (debugMode) {
        const successCount = tracedRays.filter(r => r.success).length;
    }
    
    return tracedRays;
}

/**
 * 主光線の方向ベクトルに垂直な面を計算
 * @param {Object} chiefRayOrigin - 主光線射出座標
 * @param {Object} direction - 方向ベクトル {i, j, k}
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object} 垂直面情報 {normal, origin, u, v}
 */
function calculatePerpendicularPlane(chiefRayOrigin, direction, debugMode) {
    try {
        // 垂直面の法線ベクトルは方向ベクトルそのもの
        const normal = { 
            x: direction.i, 
            y: direction.j, 
            z: direction.k 
        };
        
        // 垂直面の原点は主光線射出座標
        const origin = { 
            x: chiefRayOrigin.x, 
            y: chiefRayOrigin.y, 
            z: chiefRayOrigin.z 
        };
        
        // 垂直面内の2つの単位ベクトル u, v を生成
        let u, v;
        
        // より安定した方法で垂直面内のベクトルを計算
        // 方向ベクトルに最も垂直な軸を選択
        const absX = Math.abs(direction.i);
        const absY = Math.abs(direction.j);
        const absZ = Math.abs(direction.k);
        
        if (absX <= absY && absX <= absZ) {
            // X成分が最小の場合
            u = { x: 0, y: -direction.k, z: direction.j };
        } else if (absY <= absX && absY <= absZ) {
            // Y成分が最小の場合
            u = { x: -direction.k, y: 0, z: direction.i };
        } else {
            // Z成分が最小の場合
            u = { x: -direction.j, y: direction.i, z: 0 };
        }
        
        // uベクトルを正規化
        let uMag = Math.sqrt(u.x*u.x + u.y*u.y + u.z*u.z);
        if (uMag > 0) {
            u.x /= uMag; u.y /= uMag; u.z /= uMag;
        }
        
        // vベクトルを方向ベクトルとuベクトルの外積で計算
        v = {
            x: direction.j * u.z - direction.k * u.y,
            y: direction.k * u.x - direction.i * u.z,
            z: direction.i * u.y - direction.j * u.x
        };
        
        // vベクトルを正規化
        let vMag = Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z);
        if (vMag > 0) {
            v.x /= vMag; v.y /= vMag; v.z /= vMag;
        }
        
        if (debugMode) {
            console.log(`🔍 [PerpendicularPlane] 垂直面計算:`);
            console.log(`   原点: (${origin.x.toFixed(3)}, ${origin.y.toFixed(3)}, ${origin.z.toFixed(3)})`);
            console.log(`   法線ベクトル: (${normal.x.toFixed(6)}, ${normal.y.toFixed(6)}, ${normal.z.toFixed(6)})`);
            console.log(`   uベクトル: (${u.x.toFixed(6)}, ${u.y.toFixed(6)}, ${u.z.toFixed(6)})`);
            console.log(`   vベクトル: (${v.x.toFixed(6)}, ${v.y.toFixed(6)}, ${v.z.toFixed(6)})`);
            
            // 直交性チェック
            const uDotN = u.x*normal.x + u.y*normal.y + u.z*normal.z;
            const vDotN = v.x*normal.x + v.y*normal.y + v.z*normal.z;
            const uDotV = u.x*v.x + u.y*v.y + u.z*v.z;
            console.log(`   直交性チェック: u・n=${uDotN.toFixed(8)}, v・n=${vDotN.toFixed(8)}, u・v=${uDotV.toFixed(8)}`);
        }
        
        return {
            normal: normal,
            origin: origin,
            u: u,
            v: v
        };
    } catch (error) {
        console.error(`❌ [PerpendicularPlane] 垂直面計算エラー: ${error.message}`);
        return null;
    }
}

/**
 * 垂直面内での座標を計算
 * @param {Object} origin - 基準座標
 * @param {Object} direction - 方向ベクトル
 * @param {Object} u - 垂直面内のuベクトル
 * @param {Object} v - 垂直面内のvベクトル
 * @param {number} uComponent - u方向の成分
 * @param {number} vComponent - v方向の成分
 * @returns {Object} 計算された座標
 */
function calculatePerpendicularPlanePosition(origin, direction, u, v, uComponent, vComponent) {
    // 垂直面内の座標を計算
    const position = {
        x: origin.x + uComponent * u.x + vComponent * v.x,
        y: origin.y + uComponent * u.y + vComponent * v.y,
        z: origin.z + uComponent * u.z + vComponent * v.z
    };
    
    // 垂直面の制約を満たすようにZ座標を調整
    // 垂直面の方程式: direction.i*(x-origin.x) + direction.j*(y-origin.y) + direction.k*(z-origin.z) = 0
    const deltaX = position.x - origin.x;
    const deltaY = position.y - origin.y;
    
    if (Math.abs(direction.k) > 1e-10) {
        position.z = origin.z - (direction.i * deltaX + direction.j * deltaY) / direction.k;
    }
    
    return position;
}

// Export functions for use in other modules
export { RayColorSystem, brent };
