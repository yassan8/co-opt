/**
 * このファイルは「光路差（OPD）」および「波面収差 Wλ」の**物理的な計算ロジックのみ**を担う。
 * UIや描画とは分離して、数式処理やベクトル演算をモジュール化し、他のアプリや描画スクリプトから再利用できるようにする。
 *
 * このように計算ロジックを分離することで以下のメリットが得られる：
 * - テスト容易性：計算だけをユニットテストで確認可能
 * - 再利用性：Plotly以外の描画にも使い回せる
 * - 保守性：数式やモデルの変更が描画に影響しない
 *
 * このファイルは `eva-wavefront-plot.js` などの描画スクリプトから import して使用される。
 */

import { traceRay, calculateSurfaceOrigins } from '../../raytracing/core/ray-tracing.js';
import { getRefractiveIndex as getCatalogRefractiveIndex } from '../../raytracing/core/ray-paraxial.js';
import { findFiniteSystemChiefRayDirection } from '../../raytracing/generation/gen-ray-cross-finite.js';
import { findInfiniteSystemChiefRayOrigin } from '../../raytracing/generation/gen-ray-cross-infinite.js';
import { fitZernikeWeighted, reconstructOPD, jToNM, nmToJ, getZernikeName } from './zernike-fitting.js';

// Runtime build stamp (for cache/stale-module diagnostics)
const EVA_WAVEFRONT_BUILD = '2026-01-17a';
try {
    if (typeof window !== 'undefined') window.__EVA_WAVEFRONT_BUILD = EVA_WAVEFRONT_BUILD;
} catch (_) {}

function __cooptIsOPDDebugNow() {
    try {
        const g = (typeof globalThis !== 'undefined') ? globalThis : null;
        if (g && (g.__OPD_DEBUG || g.__PSF_DEBUG)) return true;

        // Popup windows do not share globalThis with the opener.
        // If same-origin, mirror the opener's debug flags.
        const opener = g && g.opener;
        if (opener && (opener.__OPD_DEBUG || opener.__PSF_DEBUG)) return true;
    } catch (_) {}
    return false;
}

const OPD_DEBUG = __cooptIsOPDDebugNow();

function __getActiveWavefrontProfile() {
    try {
        const g = (typeof globalThis !== 'undefined') ? globalThis : null;
        const p = g ? g.__cooptActiveWavefrontProfile : null;
        return (p && p.enabled) ? p : null;
    } catch (_) {
        return null;
    }
}

let extremeOPDWarnedOnce = false;
let rayTraceFailureWarnCount = 0;

/**
 * Brent法による根探索アルゴリズム
 * gen-ray-cross-infinite.jsから移植
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
        // 符号が変わる区間を探索
        const originalA = a, originalB = b;
        let found = false;
        
        for (let i = 1; i <= 10 && !found; i++) {
            a = originalA * i;
            b = originalB * i;
            fa = f(a);
            fb = f(b);
            if (fa * fb < 0) {
                found = true;
            }
        }
        
        if (!found) {
            // 符号が変わる区間が見つからない場合は近似解を返す
            return 0;
        }
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

    // 収束しない場合は現在の最良推定値を返す
    return b;
}

/**
 * 位置に関する数値ヤコビアン計算（gen-ray-cross-infinite.jsから移植）
 * @param {Object} origin - 光線射出位置 {x, y, z}
 * @param {Object} direction - 方向ベクトル {i, j, k}
 * @param {number} stopSurfaceIndex - 絞り面インデックス
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} stepSize - 数値微分のステップサイズ
 * @param {number} wavelength - 波長 (μm)
 * @returns {Object|null} ヤコビアン行列 {J11, J12, J21, J22, det} または null
 */
function calculateNumericalJacobianForPosition(origin, direction, stopSurfaceIndex, opticalSystemRows, stepSize, wavelength) {
    const isCoordTransRow = (row) => {
        const st = String(row?.surfType ?? row?.['surf type'] ?? row?.type ?? '').trim().toLowerCase();
        return st === 'coord break' || st === 'coordinate break' || st === 'cb';
    };
    const isObjectRow = (row) => {
        const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
        return t === 'object';
    };
    const getRayPathPointIndexForSurfaceIndex = (rows, surfaceIndex) => {
        if (!Array.isArray(rows) || surfaceIndex === null || surfaceIndex === undefined) return null;
        const sIdx = Math.max(0, Math.min(Number(surfaceIndex) || 0, rows.length - 1));
        let count = 0;
        for (let i = 0; i <= sIdx; i++) {
            const row = rows[i];
            if (isCoordTransRow(row)) continue;
            if (isObjectRow(row)) continue;
            count++;
        }
        return count;
    };

    // direction may be {x,y,z} or {i,j,k} format, support both
    const dirX = direction.x !== undefined ? direction.x : direction.i;
    const dirY = direction.y !== undefined ? direction.y : direction.j;
    const dirZ = direction.z !== undefined ? direction.z : direction.k;

    const pIdx = getRayPathPointIndexForSurfaceIndex(opticalSystemRows, stopSurfaceIndex);
    if (pIdx === null) return null;
    
    // ベースライン
    const baseRay = {
        pos: origin,
        dir: { x: dirX, y: dirY, z: dirZ },
        wavelength: wavelength
    };
    const basePath = traceRay(opticalSystemRows, baseRay, 1.0, null, stopSurfaceIndex + 1);
    if (!basePath || !Array.isArray(basePath) || basePath.length <= pIdx) return null;
    
    const basePos = basePath[pIdx];
    if (!basePos || !Number.isFinite(basePos.x) || !Number.isFinite(basePos.y)) return null;
    
    // X方向偏微分
    const rayDx = {
        pos: { x: origin.x + stepSize, y: origin.y, z: origin.z },
        dir: { x: dirX, y: dirY, z: dirZ },
        wavelength: wavelength
    };
    const pathDx = traceRay(opticalSystemRows, rayDx, 1.0, null, stopSurfaceIndex + 1);
    if (!pathDx || !Array.isArray(pathDx) || pathDx.length <= pIdx) return null;
    
    const posDx = pathDx[pIdx];
    if (!posDx || !Number.isFinite(posDx.x) || !Number.isFinite(posDx.y)) return null;
    
    // Y方向偏微分
    const rayDy = {
        pos: { x: origin.x, y: origin.y + stepSize, z: origin.z },
        dir: { x: dirX, y: dirY, z: dirZ },
        wavelength: wavelength
    };
    const pathDy = traceRay(opticalSystemRows, rayDy, 1.0, null, stopSurfaceIndex + 1);
    if (!pathDy || !Array.isArray(pathDy) || pathDy.length <= pIdx) return null;
    
    const posDy = pathDy[pIdx];
    if (!posDy || !Number.isFinite(posDy.x) || !Number.isFinite(posDy.y)) return null;
    
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
 * Newton法による主光線射出座標の探索（gen-ray-cross-infinite.jsから移植）
 * @param {Object} chiefRayOrigin - 主光線の基準射出位置 {x, y, z}
 * @param {Object} direction - 方向ベクトル {i, j, k}
 * @param {Object} targetStopPoint - 絞り面での目標位置 {x, y, z}
 * @param {number} stopSurfaceIndex - 絞り面インデックス
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} maxIterations - 最大反復回数
 * @param {number} tolerance - 収束判定の許容誤差 (mm)
 * @param {number} wavelength - 波長 (μm)
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object} {success: boolean, origin?: {x,y,z}, actualStopPoint?: {x,y,z}, error?: number, iterations?: number}
 */
function calculateApertureRayNewton(chiefRayOrigin, direction, targetStopPoint, stopSurfaceIndex, opticalSystemRows, maxIterations, tolerance, wavelength, debugMode) {
    const isCoordTransRow = (row) => {
        const st = String(row?.surfType ?? row?.['surf type'] ?? row?.type ?? '').trim().toLowerCase();
        return st === 'coord break' || st === 'coordinate break' || st === 'cb';
    };
    const isObjectRow = (row) => {
        const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
        return t === 'object';
    };
    const getRayPathPointIndexForSurfaceIndex = (rows, surfaceIndex) => {
        if (!Array.isArray(rows) || surfaceIndex === null || surfaceIndex === undefined) return null;
        const sIdx = Math.max(0, Math.min(Number(surfaceIndex) || 0, rows.length - 1));
        let count = 0;
        for (let i = 0; i <= sIdx; i++) {
            const row = rows[i];
            if (isCoordTransRow(row)) continue;
            if (isObjectRow(row)) continue;
            count++;
        }
        return count;
    };

    const pIdx = getRayPathPointIndexForSurfaceIndex(opticalSystemRows, stopSurfaceIndex);
    if (pIdx === null) return { success: false };
    const __prof = __getActiveWavefrontProfile();
    if (__prof) {
        __prof.newtonChiefCalls = (__prof.newtonChiefCalls || 0) + 1;
    }
    // より適切な初期推定：目標点の方向に射出位置を移動
    // NOTE: 軸外視野では目標オフセットが大きいため、主光線位置から開始して
    // 非常に小さいステップ（0.05）で移動する
    const targetOffsetX = targetStopPoint.x - chiefRayOrigin.x;
    const targetOffsetY = targetStopPoint.y - chiefRayOrigin.y;
    
    let currentOrigin = {
        x: chiefRayOrigin.x + targetOffsetX * 0.05,  // 非常に保守的（0.2 → 0.05）
        y: chiefRayOrigin.y + targetOffsetY * 0.05,  // 非常に保守的（0.2 → 0.05）
        z: chiefRayOrigin.z
    };
    
    // 垂直面制約を満たすようにZ座標調整
    const deltaX = currentOrigin.x - chiefRayOrigin.x;
    const deltaY = currentOrigin.y - chiefRayOrigin.y;
    const dirZ = direction.z !== undefined ? direction.z : direction.k;
    const dirX = direction.x !== undefined ? direction.x : direction.i;
    const dirY = direction.y !== undefined ? direction.y : direction.j;
    
    if (Math.abs(dirZ) > 1e-10) {
        const numerator = dirX * deltaX + dirY * deltaY;
        const adjustment = numerator / dirZ;
        currentOrigin.z = chiefRayOrigin.z - adjustment;
    }
    
    if (debugMode) {
        console.log(`🔍 [Newton] 初期推定: 目標offset(${targetOffsetX.toFixed(3)}, ${targetOffsetY.toFixed(3)}) → 初期位置(${currentOrigin.x.toFixed(3)}, ${currentOrigin.y.toFixed(3)}, ${currentOrigin.z.toFixed(3)})`);
    }
    
    for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (__prof) __prof.newtonChiefIterations = (__prof.newtonChiefIterations || 0) + 1;
        const ray = {
            pos: currentOrigin,
            dir: { x: direction.x !== undefined ? direction.x : direction.i, y: direction.y !== undefined ? direction.y : direction.j, z: direction.z !== undefined ? direction.z : direction.k },
            wavelength: wavelength
        };
        
        const rayPath = traceRay(opticalSystemRows, ray, 1.0, null, stopSurfaceIndex + 1);
        
        if (!rayPath || !Array.isArray(rayPath) || rayPath.length <= pIdx) {
            if (debugMode) console.log(`⚠️ [Newton] 反復${iteration}: 光線追跡失敗 (length=${rayPath?.length || 0})`);
            return { success: false };
        }
        
        const actualStopPoint = rayPath[pIdx];
        if (!actualStopPoint || !Number.isFinite(actualStopPoint.x) || !Number.isFinite(actualStopPoint.y)) {
            if (debugMode) console.log(`⚠️ [Newton] 反復${iteration}: 絞り面交点が無効`);
            return { success: false };
        }
        
        const residual = {
            x: actualStopPoint.x - targetStopPoint.x,
            y: actualStopPoint.y - targetStopPoint.y
        };
        
        const residualMagnitude = Math.sqrt(residual.x * residual.x + residual.y * residual.y);
        
        if (debugMode && iteration < 3) {
            console.log(`🔄 [Newton] 反復${iteration}: 残差=${residualMagnitude.toFixed(8)}mm`);
        }
        
        if (residualMagnitude < tolerance) {
            if (__prof) __prof.newtonChiefSuccess = (__prof.newtonChiefSuccess || 0) + 1;
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
            currentOrigin, direction, stopSurfaceIndex, opticalSystemRows, 1e-5, wavelength
        );
        
        if (!jacobian || Math.abs(jacobian.det) < 1e-15) {
            if (debugMode) console.log(`⚠️ [Newton] 反復${iteration}: ヤコビアン特異`);
            return { success: false };
        }
        
        // ニュートン法更新（緩和ファクター0.7で収束を速める）
        const invDet = 1.0 / jacobian.det;
        const deltaOrigin = {
            x: -invDet * (jacobian.J22 * residual.x - jacobian.J12 * residual.y) * 0.7,
            y: -invDet * (-jacobian.J21 * residual.x + jacobian.J11 * residual.y) * 0.7
        };
        
        currentOrigin.x += deltaOrigin.x;
        currentOrigin.y += deltaOrigin.y;
        
        // 垂直面制約を再適用
        const newDeltaX = currentOrigin.x - chiefRayOrigin.x;
        const newDeltaY = currentOrigin.y - chiefRayOrigin.y;
        if (Math.abs(dirZ) > 1e-10) {
            currentOrigin.z = chiefRayOrigin.z - (dirX * newDeltaX + dirY * newDeltaY) / dirZ;
        }
    }
    
    if (__prof) __prof.newtonChiefFail = (__prof.newtonChiefFail || 0) + 1;
    return { success: false };
}

/**
 * 絞り面インデックスを取得（計算ロジック専用・UI非依存）
 * NOTE: `eva-transverse-aberration.js` の同名関数と同等の探索だが、
 * `eva-wavefront.js` を計算専用モジュールとして保つためここに局所定義する。
 * @param {Array} opticalSystemRows
 * @returns {number} stopSurfaceIndex（見つからない場合は-1）
 */
function findStopSurfaceIndex(opticalSystemRows) {
    const debugMode = OPD_DEBUG;

    if (!opticalSystemRows || !Array.isArray(opticalSystemRows)) {
        if (debugMode) console.warn('⚠️ 無効な光学系データです');
        return -1;
    }

    const getApertureRadius = (surface) => {
        if (!surface || typeof surface !== 'object') return Infinity;
        const semidia = parseFloat(surface.semidia || surface.SemiDia || surface['semi dia'] || surface['Semi Dia'] || 0);
        if (Number.isFinite(semidia) && semidia > 0) return Math.abs(semidia);
        const aperture = parseFloat(surface.aperture || surface.Aperture || 0);
        if (Number.isFinite(aperture) && aperture > 0) return Math.abs(aperture) / 2;
        return Infinity;
    };

    // NOTE: gen-ray-cross-*.js treats the FIRST explicit Stop surface as the stop.
    // For OPD/wavefront we match that behavior to avoid picking a different small-aperture surface
    // that can make off-axis fields incorrectly look "stop unreachable".

    // パターン1: Object列が Stop の面（最優先、最初の一致を採用）
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const objectType = surface.object || surface.Object || surface['object type'] || surface['Object Type'] || '';
        const ot = String(objectType || '').trim().toLowerCase();
        if (ot === 'stop') return i;
    }

    // パターン2: Comment列に "stop", "aperture", "絞り" を含む面（最初の一致を採用）
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const comment = (surface.comment || surface.Comment || '').toString().toLowerCase();
        if (comment.includes('stop') || comment.includes('aperture') || comment.includes('絞り')) {
            return i;
        }
    }

    // パターン3: Type列が Stop の面（最初の一致を採用）
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const type = surface.type || surface.Type || surface['surf type'] || surface.surfType || surface.surfTypeName || '';
        const tt = String(type || '').trim().toLowerCase();
        if (tt === 'stop') return i;
    }

    // パターン4: aperture が "INF" など
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const apertureRaw = (surface.aperture || surface.Aperture || '').toString().toUpperCase();
        if (apertureRaw === 'INF' || apertureRaw === 'INFINITY' || apertureRaw === '∞') {
            return i;
        }
    }

    // パターン5: 最小 aperture/semidia を持つ面
    let minAperture = Infinity;
    let stopIndex = -1;
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const semidia = parseFloat(surface.semidia || surface.SemiDia || surface['semi dia'] || surface['Semi Dia'] || 0);
        const aperture = parseFloat(surface.aperture || surface.Aperture || 0);
        const a = (Number.isFinite(semidia) && semidia > 0)
            ? semidia
            : ((Number.isFinite(aperture) && aperture > 0) ? (aperture / 2) : Infinity);
        if (Number.isFinite(a) && a > 0 && a < minAperture) {
            minAperture = a;
            stopIndex = i;
        }
    }

    return stopIndex;
}

/**
 * 光路差（OPD: Optical Path Difference）計算クラス
 * 基準光線（主光線）に対する周辺光線の光路差を計算する
 */
export class OpticalPathDifferenceCalculator {
    constructor(opticalSystemRows, wavelength = 0.5876) {
        // 🆕 初期化時の詳細検証
        if (!opticalSystemRows) {
            console.error(`❌ OpticalPathDifferenceCalculator: opticalSystemRows が null または undefined です`);
            throw new Error('opticalSystemRows が必要です');
        }
        
        if (!Array.isArray(opticalSystemRows)) {
            console.error(`❌ OpticalPathDifferenceCalculator: opticalSystemRows が配列ではありません (型: ${typeof opticalSystemRows})`);
            throw new Error('opticalSystemRows は配列である必要があります');
        }
        
        if (opticalSystemRows.length === 0) {
            console.error(`❌ OpticalPathDifferenceCalculator: opticalSystemRows が空の配列です`);
            throw new Error('opticalSystemRows が空です');
        }
        
        this.opticalSystemRows = opticalSystemRows;
        this.wavelength = wavelength; // μm
        this.stopSurfaceIndex = findStopSurfaceIndex(opticalSystemRows);
        this.referenceOpticalPath = null;
        this.referenceChiefRay = null; // 主光線データ保存用
        this.lastRayCalculation = null; // 🆕 最後の光線計算結果を記録
        this.lastFieldKey = null; // 🆕 前回の画角設定キー
        this._chiefRayCache = new Map();

        // Per-field override of the effective stop-center point (in stop plane coordinates).
        // This is used for vignetted off-axis fields where the nominal chief ray through the
        // stop center is physically blocked and cannot be traced.
        this._stopCenterOverrideCache = new Map();

        // Per-field pupil sampling mode for infinite systems.
        // - 'stop': legacy mode, enforce stop hit for each pupil sample.
        // - 'entrance': best-effort mode, launch rays from an entrance plane and accept vignetting.
        this._infinitePupilModeCache = new Map();
        this._entrancePupilConfigCache = new Map();

        // 🆕 周辺光線生成が null を返した理由（calculateOPD で参照）
        this._lastMarginalRayGenFailure = null;

        // 🆕 最後の stop-hit 診断情報（stop-local 誤差）。孤立スパイクの原因特定に使う。
        this._lastStopHitInfo = null;

        // Coord Break による decenter/tilt を含めた各面の原点（グローバル座標）
        // 主光線/周辺光線の Stop中心定義に必須。
        try {
            this._surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
        } catch (_) {
            this._surfaceOrigins = null;
        }

        // OPD/波面の評価面（Spot Diagramの評価面に近い挙動に合わせる）
        // 典型的には Image 面までで十分で、Image後のダミー面でOPLが暴れるのを防ぐ。
        this.evaluationSurfaceIndex = this.findEvaluationSurfaceIndex(opticalSystemRows);

        // traceRay の rayPath は Coord Break 面を点列に含めない（座標変換のみ）。
        // そのため、点列インデックス/セグメントインデックスと surfaceIndex は 1:1 ではない。
        // OPD/OPL 計算では、評価面までに「実交点として記録される面」のインデックス列を保持する。
        // ただし Stop が評価面より後ろに誤検出された場合でも chief/center ray の Stop 参照が必要なので、
        // tracing は max(eval, stop) まで行う。
        this.traceMaxSurfaceIndex = Math.max(
            Number.isFinite(this.evaluationSurfaceIndex) ? this.evaluationSurfaceIndex : 0,
            Number.isFinite(this.stopSurfaceIndex) ? this.stopSurfaceIndex : 0
        );
        this._recordedSurfaceIndices = this.buildRecordedSurfaceIndices();
        this._recordedPointIndexBySurfaceIndex = this.buildRecordedPointIndexMap();
        
        // 🆕 初期化後の状態検証
        const _stopBefore = this.stopSurfaceIndex;
        if (this.stopSurfaceIndex < 0 || this.stopSurfaceIndex >= opticalSystemRows.length) {
            console.error(`❌ 絞り面インデックスが無効: ${this.stopSurfaceIndex} (光学系長: ${opticalSystemRows.length})`);
            if (OPD_DEBUG) console.warn(`🔧 絞り面インデックスを中央に設定: ${Math.floor(opticalSystemRows.length / 2)}`);
            this.stopSurfaceIndex = Math.floor(opticalSystemRows.length / 2);
        }

        // If stopSurfaceIndex was corrected, refresh trace bounds + recorded-index mapping.
        if (this.stopSurfaceIndex !== _stopBefore) {
            this.traceMaxSurfaceIndex = Math.max(
                Number.isFinite(this.evaluationSurfaceIndex) ? this.evaluationSurfaceIndex : 0,
                Number.isFinite(this.stopSurfaceIndex) ? this.stopSurfaceIndex : 0
            );
            this._recordedSurfaceIndices = this.buildRecordedSurfaceIndices();
            this._recordedPointIndexBySurfaceIndex = this.buildRecordedPointIndexMap();
        }

        // Cached geometry constants (lazy). These are stable for a given opticalSystemRows.
        this._cachedStopRadiusMm = null;
        this._cachedEntranceRadiusMm = null;
        this._cachedFirstSurfaceZ = null;

        if (__cooptIsOPDDebugNow()) {
            console.log(`🔍 OPD Calculator 初期化: 波長=${wavelength}μm, 絞り面インデックス=${this.stopSurfaceIndex}`);
            console.log(`🔍 光学系行数: ${opticalSystemRows ? opticalSystemRows.length : 'null'}`);

            try {
                console.log(`🔍 評価面インデックス=${this.evaluationSurfaceIndex}, traceMaxSurfaceIndex=${this.traceMaxSurfaceIndex}`);
                const evalRow = (Array.isArray(opticalSystemRows) && Number.isFinite(this.evaluationSurfaceIndex))
                    ? opticalSystemRows[this.evaluationSurfaceIndex]
                    : null;
                if (evalRow) {
                    console.log(`🔍 評価面詳細 (面${this.evaluationSurfaceIndex + 1}):`, {
                        object: evalRow.object ?? evalRow.Object,
                        objectType: evalRow['object type'] ?? evalRow.objectType,
                        surfType: evalRow.surfType ?? evalRow['surf type'] ?? evalRow.surfTypeName,
                        thickness: evalRow.thickness ?? evalRow.Thickness,
                        material: evalRow.material ?? evalRow.Material,
                        comment: evalRow.comment ?? evalRow.Comment
                    });
                }
            } catch (_) {}

            // NOTE: 有限系/無限系の判定は fieldSetting に依存するため、ここ（コンストラクタ）では判定しない。

            if (opticalSystemRows && opticalSystemRows.length > 0) {
                const firstSurface = opticalSystemRows[0];
                console.log(`🔍 第1面情報: thickness=${firstSurface.thickness || firstSurface.Thickness}, object=${firstSurface.object || firstSurface.Object}`);
            }

            // 絞り面の詳細情報をログ出力
            if (this.stopSurfaceIndex >= 0 && this.stopSurfaceIndex < opticalSystemRows.length) {
                const stopSurface = opticalSystemRows[this.stopSurfaceIndex];
                console.log(`🔍 絞り面詳細 (面${this.stopSurfaceIndex + 1}):`, {
                    id: stopSurface.id,
                    semidia: stopSurface.semidia,
                    aperture: stopSurface.aperture || stopSurface.Aperture,
                    radius: stopSurface.radius,
                    material: stopSurface.material,
                    objectType: stopSurface['object type'] || stopSurface.object || stopSurface.Object
                });
            } else {
                console.warn('⚠️ 絞り面が見つかりません！');
            }
        }
    }

    _getStopCenterOverrideKey(fieldSetting) {
        try {
            return this.getFieldCacheKey(fieldSetting);
        } catch (_) {
            // Fallback: stable string key
            const ax = fieldSetting?.fieldAngle?.x ?? 0;
            const ay = fieldSetting?.fieldAngle?.y ?? 0;
            const xh = fieldSetting?.xHeight ?? 0;
            const yh = fieldSetting?.yHeight ?? 0;
            const t = String(fieldSetting?.type ?? '');
            return `${t}|${ax},${ay}|${xh},${yh}`;
        }
    }

    _getInfinitePupilModeKey(fieldSetting) {
        return this._getStopCenterOverrideKey(fieldSetting);
    }

    _getForcedInfinitePupilMode() {
        try {
            const v = globalThis?.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? globalThis?.COOPT_FORCE_INFINITE_PUPIL_MODE;
            const s = (typeof v === 'string') ? v.trim().toLowerCase() : null;
            if (s === 'stop' || s === 'entrance') return s;

            // Popup windows may not inherit the opener's globalThis flags.
            // Fall back to persisted storage so forced mode remains effective everywhere.
            try {
                const raw = globalThis?.localStorage?.getItem?.('coopt.forceInfinitePupilMode');
                const ss = (typeof raw === 'string') ? raw.trim().toLowerCase() : null;
                return (ss === 'stop' || ss === 'entrance') ? ss : null;
            } catch (_) {
                return null;
            }
        } catch (_) {
            return null;
        }
    }

    _getInfinitePupilMode(fieldSetting) {
        const forced = this._getForcedInfinitePupilMode();
        if (forced) return forced;
        const key = this._getInfinitePupilModeKey(fieldSetting);
        return this._infinitePupilModeCache?.get(key) || 'stop';
    }

    _setInfinitePupilMode(fieldSetting, mode) {
        // If the mode is globally forced, do not mutate per-field caches.
        // This keeps the run deterministic and prevents auto-switch logic from overriding the user.
        if (this._getForcedInfinitePupilMode()) return;
        const key = this._getInfinitePupilModeKey(fieldSetting);
        if (mode === 'entrance' || mode === 'stop') {
            this._infinitePupilModeCache.set(key, mode);
        } else {
            this._infinitePupilModeCache.delete(key);
        }
    }

    _getOrBuildEntrancePupilConfig(fieldSetting, direction, options = undefined) {
        const key = this._getInfinitePupilModeKey(fieldSetting);
        const cached = this._entrancePupilConfigCache?.get(key);
        if (cached && cached.failed) {
            return null;
        }
        if (cached && cached.centerOrigin && cached.ex && cached.ey && Number.isFinite(cached.planeZ) && Number.isFinite(cached.radius)) {
            return cached;
        }

        if (OPD_DEBUG) {
            // This can be expensive for heavily vignetted fields; emit a single log so it doesn't look hung.
            try {
                if (!this._entrancePupilBuildLogged) this._entrancePupilBuildLogged = new Set();
                if (!this._entrancePupilBuildLogged.has(key)) {
                    this._entrancePupilBuildLogged.add(key);
                    console.warn('🧩 [EntrancePupil] building entrance pupil config...', { key, fieldSetting });
                }
            } catch (_) {}
        }

        // Estimate entrance radius from the first physical surface semi-diameter.
        const entranceRadius = (() => {
            let rr = 20;
            try {
                const rows = Array.isArray(this.opticalSystemRows) ? this.opticalSystemRows : [];
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    if (this.isCoordTransRow(r)) continue;
                    if (this.isObjectRow(r)) continue;
                    const semidia = parseFloat(r.semidia || r.SemiDia || r['semi dia'] || r['Semi Dia'] || 0);
                    const aperture = parseFloat(r.aperture || r.Aperture || 0);
                    const a = (Number.isFinite(semidia) && semidia > 0)
                        ? semidia
                        : ((Number.isFinite(aperture) && aperture > 0) ? (aperture / 2) : NaN);
                    if (Number.isFinite(a) && a > 0) {
                        rr = a;
                        break;
                    }
                }
            } catch (_) {}
            return rr;
        })();

        // Choose an entrance plane safely before the first physical surface.
        let firstSurfaceZ = 0;
        try {
            const rows = Array.isArray(this.opticalSystemRows) ? this.opticalSystemRows : [];
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                if (this.isCoordTransRow(r)) continue;
                if (this.isObjectRow(r)) continue;
                const o = this.getSurfaceOrigin(i);
                if (o && Number.isFinite(o.z)) firstSurfaceZ = o.z;
                break;
            }
        } catch (_) {}

        const planeZCandidates = [];
        // Prefer a plane slightly in front of the first physical surface.
        planeZCandidates.push(firstSurfaceZ - 10);
        planeZCandidates.push(firstSurfaceZ - 50);
        // Also try classic far-object launch planes.
        planeZCandidates.push(-25);
        planeZCandidates.push(-50);
        planeZCandidates.push(-100);
        planeZCandidates.push(-200);

        const axes = this._buildPerpendicularAxes(direction);

        // Fast-path: if a traceable chief ray exists for this field, use its launch point as
        // the entrance pupil center. This avoids fragile/time-budgeted searches and aligns
        // better with Draw Cross' “chiefRayOrigin”.
        let centerOrigin = null;
        try {
            const chief = this.generateInfiniteChiefRay(fieldSetting);
            const chiefPath = this.extractPathData(chief);
            const start = Array.isArray(chiefPath) && chiefPath.length ? chiefPath[0] : null;
            if (start && Number.isFinite(start.x) && Number.isFinite(start.y) && Number.isFinite(start.z)) {
                centerOrigin = { x: Number(start.x), y: Number(start.y), z: Number(start.z) };
                if (OPD_DEBUG) {
                    console.log('✅ [EntrancePupil] using chief-ray launch as entrance center', {
                        key,
                        centerOrigin,
                        entranceRadius
                    });
                }
            }
        } catch (_) {
            // fall through to best-effort search
        }

        if (!centerOrigin) {
            centerOrigin = this._findBestReachableEntranceCenterOrigin(fieldSetting, direction, planeZCandidates, entranceRadius, axes, options);
        }
        if (!centerOrigin) {
            // Cache negative result so we don't repeatedly burn CPU on the same impossible field.
            try {
                this._entrancePupilConfigCache.set(key, { failed: true, t: Date.now?.() || 0 });
            } catch (_) {}
            return null;
        }

        // Refine the entrance pupil radius for this *field* by finding the largest offsets
        // on the entrance plane that still reach the evaluation surface.
        // This prevents the unit-pupil mapping from being wildly oversized (which would
        // make almost all samples fail for vignetted fields).
        let effectiveRadius = entranceRadius;
        try {
            const fastSolve = !!(options && (options.fastMarginalRay || options.fastSolve));
            const iters = fastSolve ? 8 : 12;
            const traceOk = (origin) => {
                const ray = { pos: origin, dir: direction, wavelength: this.wavelength };
                const toEval = this.traceRayToEval(ray, 1.0);
                const path = this.extractPathData(toEval);
                return !!(path && path.length >= 2);
            };
            const addScaled = (base, v, s) => ({
                x: base.x + v.x * s,
                y: base.y + v.y * s,
                z: base.z + v.z * s
            });
            const findMaxAlong = (v) => {
                // Assumption (typical vignetting): reachability is mostly monotonic with radius.
                let lo = 0;
                let hi = Math.max(0, Number(entranceRadius) || 0);
                if (!(hi > 0)) return 0;

                // If the full guess radius works, accept it.
                if (traceOk(addScaled(centerOrigin, v, hi))) return hi;

                // Otherwise bisection between 0 (chief) and hi.
                for (let i = 0; i < iters; i++) {
                    const mid = 0.5 * (lo + hi);
                    if (traceOk(addScaled(centerOrigin, v, mid))) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                return lo;
            };

            // Ensure the chief ray is actually traceable; otherwise radius refinement is meaningless.
            if (traceOk(centerOrigin)) {
                const rPosX = findMaxAlong(axes.ex);
                const rNegX = findMaxAlong({ x: -axes.ex.x, y: -axes.ex.y, z: -axes.ex.z });
                const rPosY = findMaxAlong(axes.ey);
                const rNegY = findMaxAlong({ x: -axes.ey.x, y: -axes.ey.y, z: -axes.ey.z });

                // Under strong asymmetric vignetting, one direction can be effectively 0 while the opposite
                // direction is still reachable. For OPD sampling, we prefer a non-zero radius so the reachable
                // region remains representable (unreachable points will be masked as invalid).
                const rMin = Math.min(rPosX, rNegX, rPosY, rNegY);
                const rMax = Math.max(rPosX, rNegX, rPosY, rNegY);
                const eps = 1e-9;

                if (Number.isFinite(rMin) && rMin > eps) {
                    effectiveRadius = rMin;
                } else if (Number.isFinite(rMax) && rMax > eps) {
                    effectiveRadius = rMax;
                }

                if (OPD_DEBUG) {
                    console.log('🧩 [EntrancePupil] effective entrance radius estimated', {
                        key,
                        entranceRadiusGuess: entranceRadius,
                        effectiveRadius,
                        rPosX,
                        rNegX,
                        rPosY,
                        rNegY,
                        rMin,
                        rMax,
                        iters
                    });
                }
            }
        } catch (_) {
            // fall back to the guess
        }

        const cfg = {
            planeZ: centerOrigin.z,
            centerOrigin,
            ex: axes.ex,
            ey: axes.ey,
            radius: effectiveRadius
        };
        this._entrancePupilConfigCache.set(key, cfg);

        if (OPD_DEBUG) {
            try {
                console.warn('🧩 [EntrancePupil] entrance pupil config ready', {
                    key,
                    planeZ: cfg.planeZ,
                    centerOrigin: cfg.centerOrigin,
                    radius: cfg.radius
                });
            } catch (_) {}
        }
        return cfg;
    }

    _buildPerpendicularAxes(direction) {
        const norm = (v) => {
            const m = Math.hypot(v.x, v.y, v.z) || 1;
            return { x: v.x / m, y: v.y / m, z: v.z / m };
        };
        const cross = (a, b) => ({
            x: a.y * b.z - a.z * b.y,
            y: a.z * b.x - a.x * b.z,
            z: a.x * b.y - a.y * b.x
        });

        const d = norm(direction);
        const helper = (Math.abs(d.z) < 0.9) ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
        let ex = cross(helper, d);
        const exMag = Math.hypot(ex.x, ex.y, ex.z);
        if (!(exMag > 1e-12)) {
            // Fallback helper
            ex = cross({ x: 1, y: 0, z: 0 }, d);
        }
        ex = norm(ex);
        const ey = norm(cross(d, ex));
        return { ex, ey };
    }

    _findBestReachableEntranceCenterOrigin(fieldSetting, direction, planeZCandidates, entranceRadius, axes, options = undefined) {
        const safeDirZ = (Math.abs(direction.z) > 1e-12) ? direction.z : (direction.z >= 0 ? 1e-12 : -1e-12);
        const stopCenter = this.getSurfaceOrigin(this.stopSurfaceIndex);

        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? () => performance.now()
            : () => Date.now();
        const tStart = now();
        const budgetMs = (options && (options.fastSolve || options.fastMarginalRay)) ? 80 : 180;
        let didTimeoutWarn = false;
        const timeExceeded = () => (now() - tStart) > budgetMs;

        // Add extra far entrance planes. For large field angles, a too-close launch plane can
        // make the ray start effectively "inside" the optical train after coord breaks.
        // These candidates are still before the first physical surface in typical layouts.
        try {
            const firstZ = (() => {
                let z = 0;
                const rows = Array.isArray(this.opticalSystemRows) ? this.opticalSystemRows : [];
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    if (this.isCoordTransRow(r)) continue;
                    if (this.isObjectRow(r)) continue;
                    const o = this.getSurfaceOrigin(i);
                    if (o && Number.isFinite(o.z)) z = o.z;
                    break;
                }
                return z;
            })();
            const extra = [firstZ - 500, firstZ - 1000, firstZ - 2000];
            for (const z of extra) {
                if (Number.isFinite(z)) planeZCandidates.push(z);
            }
        } catch (_) {}

        // Geometric guess: straight line through stop center (ignoring refraction).
        const guessXYAtPlane = (planeZ) => {
            const dz = stopCenter.z - planeZ;
            return {
                x: stopCenter.x - (direction.x / safeDirZ) * dz,
                y: stopCenter.y - (direction.y / safeDirZ) * dz
            };
        };

        const scoreRay = (origin) => {
            const ray = { pos: origin, dir: direction, wavelength: this.wavelength };
            const toEval = this.traceRayToEval(ray, 1.0);
            const pathData = this.extractPathData(toEval);
            if (!pathData || pathData.length < 2) return { ok: false, score: -Infinity };
            // Prefer rays that reach farther (more recorded intersections).
            const len = pathData.length;
            const opl = this.calculateOpticalPath(toEval);
            if (!Number.isFinite(opl) || opl <= 0) return { ok: false, score: -Infinity };
            return { ok: true, score: len, ray: toEval };
        };

        // Fast-path: try a small set of candidate origins around the geometric guess first.
        // This avoids the expensive coarse grid / spiral search in most cases.
        try {
            const uniqPlanes = Array.from(new Set(planeZCandidates.filter(z => Number.isFinite(z)).map(z => Number(z))));
            // Prefer planes closer to the first surface for stability (then farther planes).
            uniqPlanes.sort((a, b) => Math.abs(a) - Math.abs(b));

            const off = Math.max(2.0, Math.min(entranceRadius * 0.6, 80));
            const offsets = [0, -0.5 * off, 0.5 * off, -off, off];
            for (const planeZ of uniqPlanes) {
                const g = guessXYAtPlane(planeZ);
                for (const dx of offsets) {
                    for (const dy of offsets) {
                        const origin = { x: g.x + dx, y: g.y + dy, z: planeZ };
                        const s = scoreRay(origin);
                        if (!s.ok) continue;
                        if (OPD_DEBUG) {
                            console.log('✅ [EntrancePupil] fast-path origin found', { planeZ, origin, entranceRadius });
                        }
                        return origin;
                    }
                }
            }
        } catch (_) {
            // fall through to full search
        }

        // Full search (bounded): spiral sampler around the geometric guess with a hard time budget.
        // We deliberately avoid large coarse grids here because they can freeze the browser.
        let best = null;
        const goldenAngle = Math.PI * (3 - Math.sqrt(5));
        const uniqPlanes = Array.from(new Set(planeZCandidates.filter(z => Number.isFinite(z)).map(z => Number(z))));
        // Prefer planes closer to the first physical surface first (then farther).
        uniqPlanes.sort((a, b) => Math.abs(a) - Math.abs(b));

        const samplePasses = [
            { maxR: Math.max(80, entranceRadius * 4), n: 220 },
            { maxR: Math.max(160, entranceRadius * 8), n: 360 },
            { maxR: Math.max(320, entranceRadius * 12), n: 520 }
        ];

        for (const pass of samplePasses) {
            for (const planeZ of uniqPlanes) {
                const g = guessXYAtPlane(planeZ);
                const x0 = g.x;
                const y0 = g.y;
                for (let s = 0; s < pass.n; s++) {
                    if (timeExceeded()) {
                        didTimeoutWarn = true;
                        break;
                    }
                    const t = (pass.n <= 1) ? 0 : (s / (pass.n - 1));
                    const r = pass.maxR * Math.sqrt(t);
                    const th = s * goldenAngle;
                    const origin = { x: x0 + r * Math.cos(th), y: y0 + r * Math.sin(th), z: planeZ };
                    const res = scoreRay(origin);
                    if (!res.ok) continue;
                    // First success is enough to define the entrance pupil center.
                    best = { origin, planeZ };
                    break;
                }
                if (best) break;
                if (timeExceeded()) break;
            }
            if (best) break;
            if (timeExceeded()) break;
        }

        if (!best && didTimeoutWarn) {
            try {
                console.warn('⏱️ [EntrancePupil] search timeout', { budgetMs, entranceRadius });
            } catch (_) {}
        }

        if (!best) {
            if (!this._lastMarginalRayGenFailure) {
                this._lastMarginalRayGenFailure = 'infinite: entrance pupil search found no traceable rays (timeout)';
            }
            return null;
        }

        if (OPD_DEBUG) {
            console.log('✅ Best-effort entrance pupil center found', {
                field: fieldSetting,
                origin: best.origin,
                planeZ: best.planeZ,
                entranceRadius,
                budgetMs
            });
        }
        return best.origin;
    }

    _diagnoseCenterRayTermination(fieldSetting) {
        try {
            const isFinite = this.isFiniteForField(fieldSetting);
            if (isFinite) return null;

            const angleXr = (fieldSetting.fieldAngle?.x || 0) * Math.PI / 180;
            const angleYr = (fieldSetting.fieldAngle?.y || 0) * Math.PI / 180;
            const direction = {
                x: Math.sin(angleXr) * Math.cos(angleYr),
                y: Math.sin(angleYr) * Math.cos(angleXr),
                z: Math.cos(angleXr) * Math.cos(angleYr)
            };
            const mag = Math.hypot(direction.x, direction.y, direction.z) || 1;
            direction.x /= mag;
            direction.y /= mag;
            direction.z /= mag;

            // Build a deterministic launch origin (no entrance-pupil search):
            // aim at the stop center and place the origin safely before the first physical surface.
            const stopCenter = this.getSurfaceOrigin(this.stopSurfaceIndex);
            if (!stopCenter || !Number.isFinite(stopCenter.z)) return null;

            let firstSurfaceZ = 0;
            try {
                const rows = Array.isArray(this.opticalSystemRows) ? this.opticalSystemRows : [];
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    if (this.isCoordTransRow(r)) continue;
                    if (this.isObjectRow(r)) continue;
                    const o = this.getSurfaceOrigin(i);
                    if (o && Number.isFinite(o.z)) firstSurfaceZ = o.z;
                    break;
                }
            } catch (_) {}

            const safeZ = (Math.abs(direction.z) > 1e-12) ? direction.z : (direction.z >= 0 ? 1e-12 : -1e-12);
            const slope = Math.hypot(direction.x / safeZ, direction.y / safeZ);
            const maxLateralShift = 120; // mm (diagnostic-only)
            const backDistanceTarget = (slope > 1e-9) ? Math.max(50, maxLateralShift / slope) : 200;
            const backDistanceMin = Math.max(50, (stopCenter.z - (firstSurfaceZ - 20))); // ensure before first surface
            const backDistance = Math.max(backDistanceTarget, backDistanceMin);
            const origin = {
                x: stopCenter.x - (direction.x / safeZ) * backDistance,
                y: stopCenter.y - (direction.y / safeZ) * backDistance,
                z: stopCenter.z - backDistance
            };

            const ray0 = { pos: origin, dir: direction, wavelength: this.wavelength };
            const maxIdx = Number.isFinite(this.traceMaxSurfaceIndex)
                ? this.traceMaxSurfaceIndex
                : this.evaluationSurfaceIndex;

            // Find the first surface index where traceRay returns null.
            let lastOk = -1;
            for (let i = 0; i <= maxIdx; i++) {
                const r = this.traceRayToSurface(ray0, i, 1.0);
                if (!r) {
                    const failIdx = i;
                    const row = this.opticalSystemRows?.[failIdx];
                    const comment = row?.comment ?? row?.Comment ?? '';
                    const surfType = row?.surfType ?? row?.['surf type'] ?? row?.surfTypeName ?? '';
                    const material = row?.material ?? row?.Material ?? '';
                    const semidia = row?.semidia ?? row?.SemiDia ?? row?.['semi dia'] ?? row?.['Semi Dia'] ?? null;
                    const aperture = row?.aperture ?? row?.Aperture ?? null;

                    // traceRay() returns null primarily for PHYSICAL APERTURE BLOCK. Re-run once with debugLog
                    // to capture hit radius vs aperture limit and distinguish from other early-termination modes.
                    let failure = null;
                    try {
                        const debugLog = [];
                        const debugResult = traceRay(this.opticalSystemRows, ray0, 1.0, debugLog, failIdx);
                        if (debugResult === null && Array.isArray(debugLog) && debugLog.length) {
                            const joined = debugLog.join('\n');
                            const m = joined.match(/Hit radius:\s*([0-9.+\-eE]+)mm\s*>\s*Aperture limit:\s*([0-9.+\-eE]+)mm/);
                            if (m) {
                                const hitRadius = Number(m[1]);
                                const apertureLimit = Number(m[2]);
                                failure = {
                                    kind: 'PHYSICAL_APERTURE_BLOCK',
                                    hitRadius: Number.isFinite(hitRadius) ? hitRadius : null,
                                    apertureLimit: Number.isFinite(apertureLimit) ? apertureLimit : null
                                };
                            } else if (joined.includes('PHYSICAL APERTURE BLOCK')) {
                                failure = { kind: 'PHYSICAL_APERTURE_BLOCK', hitRadius: null, apertureLimit: null };
                            }
                        }
                    } catch (_) {}

                    return {
                        launch: origin,
                        direction,
                        failSurfaceIndex: failIdx,
                        lastOkSurfaceIndex: lastOk,
                        surface: {
                            surfType: String(surfType),
                            comment: String(comment),
                            material: String(material),
                            semidia: semidia !== null && semidia !== undefined ? Number(semidia) : null,
                            aperture: aperture !== null && aperture !== undefined ? Number(aperture) : null
                        },
                        failure
                    };
                }
                lastOk = i;
            }

            // If we never failed up to maxIdx, then the issue isn't a hard termination.
            return { launch: origin, direction, failSurfaceIndex: null, lastOkSurfaceIndex: lastOk, surface: null };
        } catch (_) {
            return null;
        }
    }

    getEffectiveStopCenter(fieldSetting) {
        const base = this.getSurfaceOrigin(this.stopSurfaceIndex);
        const key = this._getStopCenterOverrideKey(fieldSetting);
        const o = this._stopCenterOverrideCache?.get(key);
        if (o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z)) {
            // Keep Z on the stop plane.
            return { x: o.x, y: o.y, z: base.z };
        }
        return base;
    }

    _setStopCenterOverride(fieldSetting, stopPoint) {
        if (!stopPoint || !Number.isFinite(stopPoint.x) || !Number.isFinite(stopPoint.y) || !Number.isFinite(stopPoint.z)) {
            return;
        }
        const key = this._getStopCenterOverrideKey(fieldSetting);
        this._stopCenterOverrideCache.set(key, { x: stopPoint.x, y: stopPoint.y, z: stopPoint.z });
    }

    _tryFindReachableStopCenterForInfiniteField(fieldSetting, direction, safeZ, firstSurfaceZ, entranceRadius, baseStopCenter, axes, stopRadius, backDistance) {
        // Search a few candidates around stop center (stop-local mm) and pick the closest one
        // that yields a valid stop hit and reaches evaluation.
        const dot = (a, b) => (a.x * b.x + a.y * b.y + a.z * b.z);
        const candidates = [];
        const fracs = [0, 0.25, 0.5, 0.75, 0.9, 1.0];
        for (const fx of fracs) {
            for (const fy of fracs) {
                const sx = fx * stopRadius;
                const sy = fy * stopRadius;
                const combos = [
                    [sx, sy], [sx, -sy], [-sx, sy], [-sx, -sy]
                ];
                for (const [dx, dy] of combos) {
                    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
                    if (dx * dx + dy * dy > stopRadius * stopRadius + 1e-9) continue;
                    candidates.push({ dx, dy });
                }
            }
        }

        let best = null;
        let bestDist = Infinity;

        for (const c of candidates) {
            const desiredOffset = this.addVec(
                this.scaleVec(axes.ex, c.dx),
                this.scaleVec(axes.ey, c.dy)
            );
            const desiredStop = {
                x: baseStopCenter.x + desiredOffset.x,
                y: baseStopCenter.y + desiredOffset.y,
                z: baseStopCenter.z + desiredOffset.z
            };

            const origin = {
                x: desiredStop.x - (direction.x / safeZ) * backDistance,
                y: desiredStop.y - (direction.y / safeZ) * backDistance,
                z: desiredStop.z - backDistance
            };

            // Quick entrance-plane plausibility filter to reduce wasted traces.
            // Approximate the (x,y) at firstSurfaceZ.
            const dz = firstSurfaceZ - origin.z;
            const xAt = origin.x + (direction.x / safeZ) * dz;
            const yAt = origin.y + (direction.y / safeZ) * dz;
            const rAt = Math.hypot(xAt, yAt);
            if (Number.isFinite(entranceRadius) && entranceRadius > 0 && rAt > entranceRadius * 1.5) {
                continue;
            }

            const ray = { pos: origin, dir: direction, wavelength: this.wavelength };
            const toStop = this.traceRayToSurface(ray, this.stopSurfaceIndex, 1.0);
            const stopPoint = this.getStopPointFromRayData(toStop);
            if (!stopPoint) continue;

            // Must reach evaluation surface too.
            const toEval = this.traceRayToEval(ray, 1.0);
            const pathData = this.extractPathData(toEval);
            if (!pathData || pathData.length < 2) continue;

            const d = { x: stopPoint.x - baseStopCenter.x, y: stopPoint.y - baseStopCenter.y, z: stopPoint.z - baseStopCenter.z };
            const localX = dot(d, axes.ex);
            const localY = dot(d, axes.ey);
            const dist = Math.hypot(localX, localY);
            if (dist < bestDist) {
                bestDist = dist;
                best = stopPoint;
            }
        }

        return best;
    }

    _mulMat3Vec3(m, v) {
        // m: 4x4 rotation matrix (upper-left 3x3 used)
        if (!Array.isArray(m) || m.length < 3) return { x: v.x, y: v.y, z: v.z };
        return {
            x: (m[0]?.[0] ?? 1) * v.x + (m[0]?.[1] ?? 0) * v.y + (m[0]?.[2] ?? 0) * v.z,
            y: (m[1]?.[0] ?? 0) * v.x + (m[1]?.[1] ?? 1) * v.y + (m[1]?.[2] ?? 0) * v.z,
            z: (m[2]?.[0] ?? 0) * v.x + (m[2]?.[1] ?? 0) * v.y + (m[2]?.[2] ?? 1) * v.z
        };
    }

    getSurfaceAxes(surfaceIndex) {
        // Returns global axes of the surface local coordinates.
        // If Coord Break tilts are present, rotationMatrix encodes the local basis.
        try {
            const rot = this._surfaceOrigins?.[surfaceIndex]?.rotationMatrix;
            if (rot) {
                const ex = this._mulMat3Vec3(rot, { x: 1, y: 0, z: 0 });
                const ey = this._mulMat3Vec3(rot, { x: 0, y: 1, z: 0 });
                const ez = this._mulMat3Vec3(rot, { x: 0, y: 0, z: 1 });
                return { ex, ey, ez };
            }
        } catch (_) {}
        return { ex: { x: 1, y: 0, z: 0 }, ey: { x: 0, y: 1, z: 0 }, ez: { x: 0, y: 0, z: 1 } };
    }

    addVec(a, b) {
        return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
    }

    scaleVec(a, s) {
        return { x: a.x * s, y: a.y * s, z: a.z * s };
    }

    isCoordTransRow(row) {
        const st = String(row?.surfType ?? row?.['surf type'] ?? '').toLowerCase();
        return st === 'coord break' || st === 'coordinate break' || st === 'cb';
    }

    isObjectRow(row) {
        const objectType = row?.['object type'] ?? row?.object ?? row?.Object;
        return String(objectType ?? '').toLowerCase() === 'object';
    }

    buildRecordedSurfaceIndices() {
        const rows = Array.isArray(this.opticalSystemRows) ? this.opticalSystemRows : [];
        // Stop 交点の参照ができないと chief/center ray が連鎖的に失敗するため、
        // 評価面が誤検出で Stop より前になっても Stop までは必ず含める。
        const evalIdx = (this.evaluationSurfaceIndex ?? (rows.length - 1));
        const stopIdx = (this.stopSurfaceIndex ?? 0);
        const maxIdx = Math.max(evalIdx, stopIdx);
        const indices = [];
        for (let i = 0; i < rows.length && i <= maxIdx; i++) {
            const row = rows[i];
            if (this.isCoordTransRow(row)) continue;
            if (this.isObjectRow(row)) continue;
            indices.push(i);
        }
        return indices;
    }

    buildRecordedPointIndexMap() {
        // rayPath point indices:
        // - point 0 is the ray origin
        // - point k (k>=1) corresponds to the (k-1)th recorded surface in _recordedSurfaceIndices
        const m = new Map();
        const idxs = Array.isArray(this._recordedSurfaceIndices) ? this._recordedSurfaceIndices : [];
        for (let k = 0; k < idxs.length; k++) {
            const surfaceIndex = idxs[k];
            if (Number.isInteger(surfaceIndex) && surfaceIndex >= 0) {
                m.set(surfaceIndex, k + 1);
            }
        }
        return m;
    }

    _getCachedStopRadiusMm() {
        const v = this._cachedStopRadiusMm;
        if (Number.isFinite(v) && v > 0) return v;
        let r = 17.85;
        try {
            const rows = this.opticalSystemRows;
            const si = this.stopSurfaceIndex;
            if (Array.isArray(rows) && Number.isInteger(si) && si >= 0 && si < rows.length) {
                const s = rows[si];
                const semidia = parseFloat(s?.semidia || 0);
                const aperture = parseFloat(s?.aperture || s?.Aperture || 0);
                r = (Number.isFinite(semidia) && semidia > 0) ? semidia : ((Number.isFinite(aperture) && aperture > 0) ? (aperture / 2) : r);
            }
        } catch (_) {}
        this._cachedStopRadiusMm = r;
        return r;
    }

    _getCachedEntranceRadiusMm() {
        const v = this._cachedEntranceRadiusMm;
        if (Number.isFinite(v) && v > 0) return v;
        let rr = 20;
        try {
            const rows = Array.isArray(this.opticalSystemRows) ? this.opticalSystemRows : [];
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                if (this.isCoordTransRow(r)) continue;
                if (this.isObjectRow(r)) continue;
                const semidia = parseFloat(r.semidia || r.SemiDia || r['semi dia'] || r['Semi Dia'] || 0);
                const aperture = parseFloat(r.aperture || r.Aperture || 0);
                const a = (Number.isFinite(semidia) && semidia > 0)
                    ? semidia
                    : ((Number.isFinite(aperture) && aperture > 0) ? (aperture / 2) : NaN);
                if (Number.isFinite(a) && a > 0) {
                    rr = a;
                    break;
                }
            }
        } catch (_) {}
        this._cachedEntranceRadiusMm = rr;
        return rr;
    }

    _getCachedFirstSurfaceZ() {
        const v = this._cachedFirstSurfaceZ;
        if (Number.isFinite(v)) return v;
        let z = 0;
        try {
            const rows = Array.isArray(this.opticalSystemRows) ? this.opticalSystemRows : [];
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                if (this.isCoordTransRow(r)) continue;
                if (this.isObjectRow(r)) continue;
                const o = this.getSurfaceOrigin(i);
                if (o && Number.isFinite(o.z)) z = o.z;
                break;
            }
        } catch (_) {}
        this._cachedFirstSurfaceZ = z;
        return z;
    }

    getPointIndexForSurfaceIndex(surfaceIndex) {
        try {
            const m = this._recordedPointIndexBySurfaceIndex;
            if (m && typeof m.get === 'function') {
                const v = m.get(surfaceIndex);
                return (v === undefined) ? null : v;
            }
        } catch (_) {}
        if (!Array.isArray(this._recordedSurfaceIndices)) return null;
        const idx = this._recordedSurfaceIndices.indexOf(surfaceIndex);
        return idx >= 0 ? (idx + 1) : null;
    }

    extractPathData(rayData) {
        if (!rayData) return null;
        if (Array.isArray(rayData)) return rayData;
        const pathData = rayData.path || rayData.pathData || rayData.points;
        return Array.isArray(pathData) ? pathData : null;
    }

    getStopPointFromRayData(rayData) {
        const pathData = this.extractPathData(rayData);
        if (!pathData) return null;

        const mappedIndex = this.getPointIndexForSurfaceIndex(this.stopSurfaceIndex);
        if (mappedIndex !== null && mappedIndex >= 0 && mappedIndex < pathData.length) {
            return pathData[mappedIndex];
        }

        // Fallback: keep legacy behavior if mapping fails.
        if (this.stopSurfaceIndex >= 0 && this.stopSurfaceIndex < pathData.length) {
            return pathData[this.stopSurfaceIndex];
        }

        return null;
    }

    findEvaluationSurfaceIndex(opticalSystemRows) {
        if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
            return 0;
        }

        const isCoordTrans = (row) => {
            const st = String(row?.surfType ?? row?.['surf type'] ?? '').toLowerCase();
            return st === 'coord break' || st === 'coordinate break' || st === 'cb';
        };

        let lastImageIndex = -1;
        for (let i = 0; i < opticalSystemRows.length; i++) {
            const row = opticalSystemRows[i];
            if (isCoordTrans(row)) continue;

            const surfType = String(row?.surfType ?? row?.['surf type'] ?? row?.surfTypeName ?? '').toLowerCase();
            const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();

            // IMPORTANT:
            // Do NOT treat comment text as authoritative for Image-plane detection.
            // Block/table rows may include phrases like "before image" in AirGap comments,
            // and if we stop tracing at that surface then its thickness (distance to next
            // surface) will not affect OPD.
            if (surfType.includes('image') || objectType.includes('image')) {
                lastImageIndex = i;
            }
        }

        // Image面が無ければ最終面（coord break除外はしない：traceRay側が処理するため）
        return lastImageIndex >= 0 ? lastImageIndex : (opticalSystemRows.length - 1);
    }

    traceRayToSurface(ray0, maxSurfaceIndex, n0 = 1.0) {
        const idx = (maxSurfaceIndex === undefined || maxSurfaceIndex === null) ? null : maxSurfaceIndex;
        const prof = this._wavefrontProfile;
        const enabled = !!(prof && prof.enabled);

        if (!enabled) {
            return traceRay(this.opticalSystemRows, ray0, n0, null, idx);
        }

        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? () => performance.now()
            : () => Date.now();
        const t0 = now();
        try {
            return traceRay(this.opticalSystemRows, ray0, n0, null, idx);
        } finally {
            const dt = now() - t0;
            prof.traceRayToSurfaceCount = (prof.traceRayToSurfaceCount || 0) + 1;
            prof.traceRayToSurfaceMs = (prof.traceRayToSurfaceMs || 0) + (Number.isFinite(dt) ? dt : 0);
        }
    }

    traceRayToEval(ray0, n0 = 1.0) {
        const prof = this._wavefrontProfile;
        if (prof && prof.enabled) {
            prof.traceRayToEvalCount = (prof.traceRayToEvalCount || 0) + 1;
        }
        const maxIdx = Number.isFinite(this.traceMaxSurfaceIndex)
            ? this.traceMaxSurfaceIndex
            : this.evaluationSurfaceIndex;
        return this.traceRayToSurface(ray0, maxIdx, n0);
    }

    getFieldCacheKey(fieldSetting) {
        const ax = fieldSetting?.fieldAngle?.x ?? 0;
        const ay = fieldSetting?.fieldAngle?.y ?? 0;
        const xh = fieldSetting?.xHeight ?? 0;
        const yh = fieldSetting?.yHeight ?? 0;
        // displayName や objectIndex は視覚/UI用で、光線自体には影響しない前提
        return `${ax}_${ay}_${xh}_${yh}`;
    }

    /**
     * Object空間（traceRayの初期媒質）の屈折率を取得
     * NOTE: このコードベースでは、先頭行（Object行）の material/rindex を
     * Object空間媒質として扱う。
     */
    getObjectSpaceRefractiveIndex() {
        const first = this.opticalSystemRows?.[0];
        return this.getMaterialRefractiveIndex(first);
    }

    /**
     * material/rindex + ガラスカタログから、波長依存の屈折率 n(λ) を返す。
     * ray-tracing.js の getCorrectRefractiveIndex と同等の優先順位。
     */
    getMaterialRefractiveIndex(surface) {
        const wavelength = this.wavelength;
        if (!surface) return 1.0;

        try {
            const catalogN = getCatalogRefractiveIndex(surface, wavelength);
            const material = String(surface.material ?? surface.Material ?? '').trim();
            const materialUpper = material.toUpperCase();
            const looksNonAir = !!material && materialUpper !== 'AIR' && materialUpper !== 'AIR ' && materialUpper !== 'AIR\u0000';
            if (catalogN !== 1.0 || looksNonAir) {
                return catalogN;
            }
        } catch (_) {
            // fall through to manual
        }

        const manualIndex = surface.rindex || surface['Ref Index'] || surface.refIndex || surface.Rindex;
        if (manualIndex !== undefined && manualIndex !== null && manualIndex !== '') {
            const numValue = parseFloat(manualIndex);
            if (!isNaN(numValue) && isFinite(numValue) && numValue > 0) {
                return numValue;
            }
        }

        return 1.0;
    }

    /**
     * 基準光線（主光線）の光路長を計算・設定
     * @param {Object} fieldSetting - フィールド設定
     * @returns {number} 基準光路長
     */
    setReferenceRay(fieldSetting) {
        // 🆕 画角情報の詳細チェック（ログ簡略化）
        const hasFieldAngle = fieldSetting.fieldAngle && (fieldSetting.fieldAngle.x !== 0 || fieldSetting.fieldAngle.y !== 0);
        const hasFieldHeight = fieldSetting.xHeight !== 0 || fieldSetting.yHeight !== 0;
        
        if (OPD_DEBUG) {
            if (hasFieldAngle || hasFieldHeight) {
                console.log(`📐 画角設定: 角度(${fieldSetting.fieldAngle?.x || 0}°, ${fieldSetting.fieldAngle?.y || 0}°), 高さ(${fieldSetting.xHeight || 0}, ${fieldSetting.yHeight || 0}mm)`);
            } else {
                console.log(`📍 軸上フィールド（画角=0）`);
            }
        }
        
        // Default to stop-based pupil sampling, unless this field was explicitly forced to
        // entrance-pupil best-effort mode by the caller.
        try {
            const isFinite = this.isFiniteForField(fieldSetting);
            if (!isFinite) {
                const existing = this._getInfinitePupilMode(fieldSetting);
                if (existing !== 'entrance') {
                    this._setInfinitePupilMode(fieldSetting, 'stop');
                }
            }
        } catch (_) {}

        // OPD計算で pupil=(0,0) に用いる中心光線をまず試す。
        // IMPORTANT: For stop-based pupil sampling, the reference ray must satisfy the same
        // stop-local constraint as the marginal rays. Using relaxStopMissTol here can accept a
        // misregistered reference and make OPD explode while still looking “valid”.
        let referenceRay = null;
        let usedRelaxStopMissTol = false;
        try {
            const isFinite = this.isFiniteForField(fieldSetting);
            if (isFinite) {
                // Try strict first; relax only as a last-resort to avoid total failure.
                referenceRay = this.generateMarginalRay(0, 0, fieldSetting, { isReferenceRay: true });
                if (!referenceRay) {
                    usedRelaxStopMissTol = true;
                    referenceRay = this.generateMarginalRay(0, 0, fieldSetting, { isReferenceRay: true, relaxStopMissTol: true });
                }
            } else {
                const mode = this._getInfinitePupilMode(fieldSetting);
                const forcedMode = this._getForcedInfinitePupilMode();
                // Always try strict for the current mode.
                referenceRay = this.generateMarginalRay(0, 0, fieldSetting, { isReferenceRay: true });

                // If stop mode is physically impossible (cannot reach stop), try Newton-based chief ray first.
                if (!referenceRay && mode === 'stop') {
                    const fail = String(this._lastMarginalRayGenFailure || '');
                    const looksStopUnreachable = fail.startsWith('infinite: stop unreachable');
                    if (looksStopUnreachable) {
                        // ⚠️ CRITICAL: Try Newton-based chief ray solver before switching to entrance mode.
                        // This matches the Render's approach and can often find a valid chief ray.
                        if (OPD_DEBUG) {
                            console.log(`🔧 [Newton] stop unreachable detected, trying Newton-based chief ray solver...`);
                        }
                        referenceRay = this.generateChiefRay(fieldSetting);
                        
                        // Only switch to entrance mode if Newton method also fails.
                        if (!referenceRay) {
                            if (OPD_DEBUG) {
                                console.log(`⚠️ [Newton] Newton-based chief ray also failed, switching to entrance mode`);
                            }
                            // Respect global force switch: do not auto-switch modes when forced.
                            if (forcedMode !== 'stop') {
                                try {
                                    this._setInfinitePupilMode(fieldSetting, 'entrance');
                                    const k = this.getFieldCacheKey(fieldSetting);
                                    this._chiefRayCache?.delete(k);
                                    const ek = this._getInfinitePupilModeKey(fieldSetting);
                                    this._entrancePupilConfigCache?.delete(ek);
                                } catch (_) {}
                                referenceRay = this.generateMarginalRay(0, 0, fieldSetting, { isReferenceRay: true });
                            }
                        } else if (OPD_DEBUG) {
                            console.log(`✅ [Newton] Successfully generated chief ray with Newton method`);
                        }
                    }
                }

                // As a last resort, allow a relaxed solve (but keep it explicit).
                if (!referenceRay) {
                    usedRelaxStopMissTol = true;
                    referenceRay = this.generateMarginalRay(0, 0, fieldSetting, { isReferenceRay: true, relaxStopMissTol: true });
                }
            }
        } catch (_) {
            // fall through to chiefRay/fallback paths
        }

        // Expose reference-ray policy for diagnostics.
        try {
            this._referenceRayUsedRelaxStopMissTol = !!usedRelaxStopMissTol;
        } catch (_) {}

        const chiefRay = referenceRay ? null : this.generateChiefRay(fieldSetting);
        referenceRay = referenceRay || chiefRay;

        // ✅ デバッグ: 基準光線が実際にstopを通過しているか確認（常にログ出力）
        if (referenceRay && !this.isFiniteForField(fieldSetting)) {
            const stopPoint = this.getStopPointFromRayData(referenceRay);
            const stopCenter = this.getSurfaceOrigin(this.stopSurfaceIndex);
            if (stopPoint && stopCenter) {
                const dx = stopPoint.x - stopCenter.x;
                const dy = stopPoint.y - stopCenter.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                console.log(`✅ [RefRay] Reference ray stop hit: distance from center = ${dist.toFixed(6)} mm, stop=(${stopPoint.x.toFixed(3)}, ${stopPoint.y.toFixed(3)}), center=(${stopCenter.x.toFixed(3)}, ${stopCenter.y.toFixed(3)})`);
            } else if (!stopPoint) {
                console.warn(`⚠️ [RefRay] Reference ray does NOT pass through stop surface!`);
            }
        }

        // それでも失敗するケース（特定画角でsolverが外す/一時的に追跡が落ちる等）の保険。
        if (!referenceRay) {
            if (OPD_DEBUG) {
                const stopCenter = this.getSurfaceOrigin(this.stopSurfaceIndex);
                console.warn(`⚠️ 基準光線の通常生成に失敗。フォールバック探索を試行します`, {
                    field: fieldSetting,
                    stopSurfaceIndex: this.stopSurfaceIndex,
                    evaluationSurfaceIndex: this.evaluationSurfaceIndex,
                    stopCenter
                });
            }
            referenceRay = this.generateFallbackReferenceRay(fieldSetting);
        }

        // Best-effort vignetted pupil mode (Option 3):
        // If the stop-center based reference ray is not traceable (physically vignetted),
        // switch to entrance-plane pupil sampling and try again.
        if (!referenceRay) {
            const isFinite = this.isFiniteForField(fieldSetting);
            if (!isFinite) {
                const forcedMode = this._getForcedInfinitePupilMode();
                if (forcedMode !== 'stop') {
                    try {
                        this._setInfinitePupilMode(fieldSetting, 'entrance');
                        // Clear cached chief ray for this field to avoid mixing modes.
                        const k = this.getFieldCacheKey(fieldSetting);
                        this._chiefRayCache?.delete(k);
                    } catch (_) {}
                    referenceRay = this.generateMarginalRay(0, 0, fieldSetting, { isReferenceRay: true });
                }
            }
        }

        if (!referenceRay) {
            const ax = fieldSetting?.fieldAngle?.x ?? 0;
            const ay = fieldSetting?.fieldAngle?.y ?? 0;
            const xh = fieldSetting?.xHeight ?? 0;
            const yh = fieldSetting?.yHeight ?? 0;
            const lastFail = this._lastMarginalRayGenFailure ? `; marginal=${this._lastMarginalRayGenFailure}` : '';

            // Last-resort retry for missing-aperture imports:
            // Blocks/rows often get a default semidia=10mm which can artificially vignette off-axis fields.
            // If we failed due to PHYSICAL_APERTURE_BLOCK with limit≈10, relax ONLY those default semidias
            // (keep any user-specified apertures intact) and retry once.
            try {
                const diag0 = this._diagnoseCenterRayTermination(fieldSetting);
                const f0 = diag0?.failure;
                const al0 = Number(f0?.apertureLimit);
                const looksDefaultAperture = (String(f0?.kind ?? '') === 'PHYSICAL_APERTURE_BLOCK')
                    && Number.isFinite(al0)
                    && al0 > 0
                    && al0 <= 10.000001;

                if (looksDefaultAperture && Array.isArray(this.opticalSystemRows) && this.opticalSystemRows.length > 0) {
                    // Ensure we're not actually limited by the stop itself.
                    let stopLim = null;
                    try {
                        const stopRow = this.opticalSystemRows?.[this.stopSurfaceIndex];
                        if (stopRow) {
                            const ap = parseFloat(stopRow.aperture ?? stopRow.Aperture ?? NaN);
                            if (Number.isFinite(ap) && ap > 0) stopLim = ap * 0.5;
                            else {
                                const sd = Number(stopRow.semidia);
                                if (Number.isFinite(sd) && sd > 0) stopLim = sd;
                            }
                        }
                    } catch (_) {
                        stopLim = null;
                    }

                    if (stopLim !== null && stopLim > al0 + 1e-6) {
                        const relaxedRows = this.opticalSystemRows.map((r, idx) => {
                            if (!r || typeof r !== 'object') return r;
                            const t = String(r['object type'] ?? r.object ?? '').trim().toLowerCase();
                            if (t === 'object' || t === 'image') return r;
                            if (idx === this.stopSurfaceIndex || t === 'stop' || t === 'sto') return r;

                            const sdRaw = r.semidia;
                            const sdNum = Number(sdRaw);
                            const isDefaultSd = (sdRaw === '10') || (Number.isFinite(sdNum) && Math.abs(sdNum - 10) < 1e-6);
                            if (!isDefaultSd) return r;
                            return { ...r, semidia: '' };
                        });

                        this.opticalSystemRows = relaxedRows;
                        try {
                            const k = this.getFieldCacheKey(fieldSetting);
                            this._chiefRayCache?.delete(k);
                        } catch (_) {}
                        try {
                            const ek = this._getInfinitePupilModeKey(fieldSetting);
                            this._entrancePupilConfigCache?.delete(ek);
                        } catch (_) {}

                        try {
                            referenceRay = this.generateMarginalRay(0, 0, fieldSetting, { isReferenceRay: true });
                            if (!referenceRay) referenceRay = this.generateMarginalRay(0, 0, fieldSetting, { isReferenceRay: true, relaxStopMissTol: true });
                        } catch (_) {
                            // ignore
                        }
                        if (!referenceRay) {
                            try { referenceRay = this.generateChiefRay(fieldSetting); } catch (_) {}
                        }
                        if (!referenceRay) {
                            try { referenceRay = this.generateFallbackReferenceRay(fieldSetting); } catch (_) {}
                        }
                    }
                }
            } catch (_) {
                // ignore
            }

            // When the system/field is physically vignetted, traceRay() returns null (aperture block),
            // and we cannot define a reference ray (OPD is undefined). Provide an actionable hint.
            let hint = '';
            try {
                const isInfinite = !this.isFiniteForField(fieldSetting);
                const aMag = Math.hypot(ax, ay);
                if (isInfinite && aMag > 1e-9) {
                    // Find the largest scale s in [0,1] for which the center ray becomes traceable.
                    // This is a quick diagnostic; it runs only on failure.
                    const testScale = (s) => {
                        const fs = {
                            ...fieldSetting,
                            fieldAngle: { x: ax * s, y: ay * s },
                            xHeight: 0,
                            yHeight: 0,
                            type: 'Angle'
                        };
                        const r = this.generateMarginalRay(0, 0, fs, { isReferenceRay: true, relaxStopMissTol: true });
                        if (!r) return false;
                        const opl = this.calculateOpticalPath(r);
                        return Number.isFinite(opl) && opl > 0;
                    };

                    let lo = 0.0;
                    let hi = 1.0;
                    if (!testScale(hi)) {
                        // Ensure at least lo is valid (axis should be valid in most cases).
                        if (testScale(0.0)) {
                            // binary search
                            for (let i = 0; i < 10; i++) {
                                const mid = 0.5 * (lo + hi);
                                if (testScale(mid)) lo = mid;
                                else hi = mid;
                            }
                            const ax2 = ax * lo;
                            const ay2 = ay * lo;
                            hint = `; hint=field likely vignetted/out-of-FOV (center ray becomes traceable around angle≈(${ax2.toFixed(2)},${ay2.toFixed(2)})deg)`;
                        } else {
                            hint = `; hint=field likely vignetted/out-of-FOV (even axis center ray did not trace)`;
                        }
                    }
                }
            } catch (_) {
                // ignore
            }

            // Add a termination diagnostic to reconcile with visual renders.
            let term = '';
            try {
                const diag = this._diagnoseCenterRayTermination(fieldSetting);
                if (diag && Number.isInteger(diag.failSurfaceIndex)) {
                    const s = diag.surface || {};
                    const name = (s.comment || s.surfType || '').toString().trim();
                    term = `; termination=trace became null at surfaceIndex=${diag.failSurfaceIndex}${name ? ` (${name})` : ''}`;

                    // Surface aperture fields (helps confirm whether the limit comes from this surface or was mis-assigned).
                    try {
                        const sd = Number(s.semidia);
                        const ap = Number(s.aperture);
                        const sdStr = Number.isFinite(sd) ? sd.toFixed(6) : null;
                        const apStr = Number.isFinite(ap) ? ap.toFixed(6) : null;
                        if (sdStr !== null || apStr !== null) {
                            term += `; surfaceAperture(semiDia=${sdStr ?? 'null'}mm, aperture=${apStr ?? 'null'}mm)`;
                        }
                    } catch (_) {}

                    const f = diag.failure;
                    if (f && f.kind) {
                        if (f.kind === 'PHYSICAL_APERTURE_BLOCK') {
                            const hr = Number.isFinite(f.hitRadius) ? f.hitRadius : null;
                            const al = Number.isFinite(f.apertureLimit) ? f.apertureLimit : null;
                            term += `; cause=${f.kind}`;
                            if (hr !== null && al !== null) {
                                term += ` (hitRadius=${hr.toFixed(6)}mm > limit=${al.toFixed(6)}mm)`;
                            }
                        } else {
                            term += `; cause=${String(f.kind)}`;
                        }
                    }
                }
            } catch (_) {}

            throw new Error(`基準光線の生成に失敗しました（center/chief ray ともに失敗） field(angle=(${ax},${ay})deg height=(${xh},${yh})mm)${lastFail}${hint}${term}`);
        }

        // 主光線データを保存（参照球面計算用）
        this.referenceChiefRay = referenceRay;
        
        if (OPD_DEBUG) console.log('✅ 基準光線生成成功');
        
        // パス点の最小要件
        const pathData = Array.isArray(referenceRay) ? referenceRay : (referenceRay.path || referenceRay.pathData || referenceRay.points);
        if (!Array.isArray(pathData) || pathData.length < 2) {
            throw new Error('基準光線の光線追跡が不完全です（パス点が不足）');
        }

        // 光路長計算（μm）
        this.referenceOpticalPath = this.calculateOpticalPath(referenceRay);
        if (!isFinite(this.referenceOpticalPath) || isNaN(this.referenceOpticalPath) || this.referenceOpticalPath <= 0) {
            throw new Error(`無効な基準光路長: ${this.referenceOpticalPath}`);
        }
        
        if (OPD_DEBUG) {
            if (hasFieldAngle || hasFieldHeight) {
                console.log(`📐 画角あり基準光路長: ${this.referenceOpticalPath.toFixed(6)}μm`);
            } else {
                console.log(`📍 軸上基準光路長: ${this.referenceOpticalPath.toFixed(6)}μm`);
            }
        }
        
        if (OPD_DEBUG) console.log(`📏 基準光路長: ${this.referenceOpticalPath.toFixed(6)} μm`);

        // calculateOPD からの再呼び出しを防ぐため、ここでフィールドキーも更新する
        // （generateWavefrontMap で先に setReferenceRay 済みのケース）
        try {
            this.lastFieldKey = this.getFieldCacheKey(fieldSetting);
        } catch (_) {
            // ignore
        }
        
        return this.referenceOpticalPath;
    }

    generateFallbackReferenceRay(fieldSetting) {
        const isFinite = this.isFiniteForField(fieldSetting);

        if (isFinite) {
            try {
                const firstSurface = this.opticalSystemRows[0];
                const objectDistance = Math.abs(parseFloat(firstSurface.thickness || firstSurface.Thickness));
                const yObject = fieldSetting.yHeight || 0;
                const xObject = fieldSetting.xHeight || 0;
                const objectPosition = { x: xObject, y: yObject, z: -objectDistance };
                const stopCenter = this.getSurfaceOrigin(this.stopSurfaceIndex);

                // 主光線最適化が落ちる例外的ケース向けに、まずは直線でStop中心を狙う。
                const dir = this.calculateRayDirection(objectPosition, stopCenter);
                const initialRay = { pos: objectPosition, dir, wavelength: this.wavelength };
                const rayResult = this.traceRayToEval(initialRay, 1.0);
                const pathData = this.extractPathData(rayResult);
                if (pathData && pathData.length >= 2) return rayResult;
            } catch (_) {
                // fall through
            }
            return null;
        }

        // 無限系: 画角方向ベクトル + Stop中心からの逆投影で初期点を作り、近傍探索で通る点を探す。
        const angleX = (fieldSetting.fieldAngle?.x || 0) * Math.PI / 180;
        const angleY = (fieldSetting.fieldAngle?.y || 0) * Math.PI / 180;

        const cosX = Math.cos(angleX);
        const cosY = Math.cos(angleY);
        const sinX = Math.sin(angleX);
        const sinY = Math.sin(angleY);

        const direction = {
            x: sinX * cosY,
            y: sinY * cosX,
            z: cosX * cosY
        };

        const dirMag = Math.hypot(direction.x, direction.y, direction.z) || 1;
        direction.x /= dirMag;
        direction.y /= dirMag;
        direction.z /= dirMag;

        const stopCenter = this.getSurfaceOrigin(this.stopSurfaceIndex);
        const safeZ = Math.abs(direction.z) > 1e-12 ? direction.z : (direction.z >= 0 ? 1e-12 : -1e-12);

        // Z開始位置を複数試す（特定系で -25mm が面の内側になる等の対策）
        const startZCandidates = [-25, -50, -100, -200];
        // 近傍探索のオフセット（mm）: 小→大
        const offsetCandidates = [0, 1, 3, 7, 15, 30, 60, 120];

        for (const startZ of startZCandidates) {
            const dzToStop = stopCenter.z - startZ;
            const baseOrigin = {
                x: stopCenter.x - (direction.x / safeZ) * dzToStop,
                y: stopCenter.y - (direction.y / safeZ) * dzToStop,
                z: startZ
            };

            for (const d of offsetCandidates) {
                for (const dx of [-d, 0, d]) {
                    for (const dy of [-d, 0, d]) {
                        const origin0 = { x: baseOrigin.x + dx, y: baseOrigin.y + dy, z: startZ };
                        const ray0 = { pos: origin0, dir: direction, wavelength: this.wavelength };

                        // まずStop面まで到達できるか（到達できない場合は評価面まで行けない）
                        const toStop = this.traceRayToSurface(ray0, this.stopSurfaceIndex, 1.0);
                        const stopPoint = this.getStopPointFromRayData(toStop);
                        if (!stopPoint) continue;

                        // Stop中心へ1回だけ補正（局所線形近似）
                        const origin1 = {
                            x: origin0.x - (stopPoint.x - stopCenter.x),
                            y: origin0.y - (stopPoint.y - stopCenter.y),
                            z: startZ
                        };
                        const ray1 = { pos: origin1, dir: direction, wavelength: this.wavelength };
                        const toEval = this.traceRayToEval(ray1, 1.0);
                        const pathData = this.extractPathData(toEval);
                        if (pathData && pathData.length >= 2) {
                            if (OPD_DEBUG) {
                                const sp = this.getStopPointFromRayData(this.traceRayToSurface(ray1, this.stopSurfaceIndex, 1.0));
                                console.log(`✅ フォールバック基準光線が成功`, {
                                    startZ,
                                    origin: origin1,
                                    stopPoint: sp,
                                    stopCenter
                                });
                            }
                            return toEval;
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * 主光線を生成
     * @param {Object} fieldSetting - フィールド設定
     * @returns {Object} 主光線データ
     */
    generateChiefRay(fieldSetting) {
        const cacheKey = this.getFieldCacheKey(fieldSetting);
        if (this._chiefRayCache?.has(cacheKey)) {
            return this._chiefRayCache.get(cacheKey);
        }

        // 有限系・無限系の判定（ObjectのAngle/Height指定を優先）
        const isFinite = this.isFiniteForField(fieldSetting);
        
        const ray = isFinite
            ? this.generateFiniteChiefRay(fieldSetting)
            : this.generateInfiniteChiefRay(fieldSetting);

        // null をキャッシュすると「たまたま失敗した一回」が永続化してしまう
        if (ray) {
            this._chiefRayCache.set(cacheKey, ray);
        }
        return ray;
    }

    /**
     * 有限系の主光線生成
     * @param {Object} fieldSetting - フィールド設定
     * @returns {Object} 主光線データ
     */
    generateFiniteChiefRay(fieldSetting) {
        const firstSurface = this.opticalSystemRows[0];
        const objectDistance = Math.abs(parseFloat(firstSurface.thickness || firstSurface.Thickness));
        
        // Object面での光線位置
        const yObject = fieldSetting.yHeight || 0;
        const xObject = fieldSetting.xHeight || 0;

        // Stop中心は Coord Break のデセンタ/チルトを反映した座標を使用
        const stopCenter = this.getSurfaceOrigin(this.stopSurfaceIndex);

        // ✅ 有限系の主光線は「Object→Stop中心へ直線で狙う」だけでは成立しない（屈折でズレる）ため、
        // gen-ray-cross-finite.js と同様に Stop中心を通るように方向ベクトルを最適化する。
        const objectPosition = { x: xObject, y: yObject, z: -objectDistance };
        const debugMode = OPD_DEBUG;

        let dirIJK = findFiniteSystemChiefRayDirection(
            objectPosition,
            stopCenter,
            this.stopSurfaceIndex,
            this.opticalSystemRows,
            debugMode,
            this.wavelength
        );

        // Brent法が収束しない例外的ケース向けフォールバック（tracing誤差フィードバック）
        if (!dirIJK || !isFinite(dirIJK.i) || !isFinite(dirIJK.j) || !isFinite(dirIJK.k)) {
            dirIJK = this.findFiniteRayDirectionToHitStop(objectPosition, stopCenter, this.stopSurfaceIndex, debugMode);
        }

        if (!dirIJK || !isFinite(dirIJK.i) || !isFinite(dirIJK.j) || !isFinite(dirIJK.k)) {
            return null;
        }

        const initialRay = {
            pos: objectPosition,
            dir: { x: dirIJK.i, y: dirIJK.j, z: dirIJK.k },
            wavelength: this.wavelength
        };

        return this.traceRayToEval(initialRay, 1.0);
    }

    /**
     * 無限系の主光線生成（Brent法による射出座標探索）
     * @param {Object} fieldSetting - フィールド設定
     * @returns {Object} 主光線データ
     */
    generateInfiniteChiefRay(fieldSetting) {
        // console.log(`🔍 generateInfiniteChiefRay 開始`);  // ログ削減
        // console.log(`🔍 fieldSetting 詳細:`, JSON.stringify(fieldSetting, null, 2));  // ログ削減
        
        // 角度からの方向ベクトル（gen-ray-cross-infinite.js と同じ定義：単位ベクトル保証）
        const angleX = (fieldSetting.fieldAngle?.x || 0) * Math.PI / 180;
        const angleY = (fieldSetting.fieldAngle?.y || 0) * Math.PI / 180;

        const cosX = Math.cos(angleX);
        const cosY = Math.cos(angleY);
        const sinX = Math.sin(angleX);
        const sinY = Math.sin(angleY);

        const directionIJK = {
            i: sinX * cosY,
            j: sinY * cosX,
            k: cosX * cosY
        };

        // 念のため正規化
        const dirMag = Math.hypot(directionIJK.i, directionIJK.j, directionIJK.k) || 1;
        directionIJK.i /= dirMag;
        directionIJK.j /= dirMag;
        directionIJK.k /= dirMag;

        // console.log(`🔍 方向ベクトル: (${direction.x.toFixed(6)}, ${direction.y.toFixed(6)}, ${direction.z.toFixed(6)})`);  // ログ削減

        // NOTE: OPD の主光線生成は、draw-cross 側（gen-ray-cross-infinite.js）と同じ
        // 「Stop中心に到達する射出座標を探索する」方針に揃える。
        // draw-cross の Stop中心は x=y=0 を固定し、z は calculateSurfaceOrigins の origin.z を使う。
        // 
        // Stop center must reflect Coord Break decenter/tilt.
        // Using a forced (0,0,*) center can make chief-ray solve target the wrong point
        // when the stop coordinate frame is shifted.
        const getEffectiveStopCenter = () => {
            const sIdx = this.stopSurfaceIndex;
            const o = (this._surfaceOrigins && this._surfaceOrigins[sIdx] && this._surfaceOrigins[sIdx].origin)
                ? this._surfaceOrigins[sIdx].origin
                : this.getSurfaceOrigin(sIdx);
            return {
                x: (o && Number.isFinite(o.x)) ? o.x : 0,
                y: (o && Number.isFinite(o.y)) ? o.y : 0,
                z: (o && Number.isFinite(o.z)) ? o.z : 0
            };
        };

        const stopCenter = getEffectiveStopCenter();

        const tryMakeRay = (stopCenter) => {
            if (!stopCenter || !Number.isFinite(stopCenter.z)) return null;

            let origin = null;
            
            // ステップ1: 初期推定を取得（findInfiniteSystemChiefRayOriginまたは幾何学的逆投影）
            try {
                origin = findInfiniteSystemChiefRayOrigin(
                    directionIJK,
                    stopCenter,
                    this.stopSurfaceIndex,
                    this.opticalSystemRows,
                    OPD_DEBUG,
                    this.evaluationSurfaceIndex,
                    this.wavelength
                );
            } catch (e) {
                if (OPD_DEBUG) console.warn('⚠️ findInfiniteSystemChiefRayOrigin failed:', e);
            }

            // Fallback: geometric back-projection to the stop plane.
            if (!origin || !isFinite(origin.x) || !isFinite(origin.y) || !isFinite(origin.z)) {
                const safeK = Math.abs(directionIJK.k) > 1e-12 ? directionIJK.k : (directionIJK.k >= 0 ? 1e-12 : -1e-12);
                const initialZ = -25;
                const dzToStop = (stopCenter?.z ?? 0) - initialZ;
                origin = {
                    x: (stopCenter?.x ?? 0) - (directionIJK.i / safeK) * dzToStop,
                    y: (stopCenter?.y ?? 0) - (directionIJK.j / safeK) * dzToStop,
                    z: initialZ
                };
            }

            // ステップ2: Newton法で精密化（Renderと同じアプローチ）
            // 初期推定が得られた場合は、Newton法でstop中心を正確に通るように最適化
            const newtonResult = calculateApertureRayNewton(
                origin,
                directionIJK,
                stopCenter,
                this.stopSurfaceIndex,
                this.opticalSystemRows,
                50,  // maxIterations
                1e-6,  // tolerance (mm)
                this.wavelength,
                OPD_DEBUG
            );

            // Newton法が成功した場合は、その結果を使用
            if (newtonResult.success) {
                origin = newtonResult.origin;
                if (OPD_DEBUG) {
                    console.log(`✅ [Newton] 収束成功: 反復${newtonResult.iterations}回, 誤差=${newtonResult.error.toFixed(9)}mm`);
                }
            } else if (OPD_DEBUG) {
                console.log(`⚠️ [Newton] 収束失敗、初期推定を使用`);
            }

            const initialRay = {
                pos: origin,
                dir: { x: directionIJK.i, y: directionIJK.j, z: directionIJK.k },
                wavelength: this.wavelength
            };
            const rayResult = this.traceRayToEval(initialRay, 1.0);
            const pathData = this.extractPathData(rayResult);
            return (pathData && pathData.length >= 2) ? rayResult : null;
        };

        // Try to generate the ray with stop center (0,0,z)
        const rayResult = tryMakeRay(stopCenter);
        if (rayResult) return rayResult;

        // No chief ray traceable for this field.
        return null;
    }

    /**
     * Brent法による主光線射出座標の探索
     * @param {Object} direction - 方向ベクトル
     * @param {Object} stopCenter - 絞り面中心
     * @returns {Object} 射出座標
     */
    findChiefRayOriginWithBrent(direction, stopCenter) {
        const searchRange = 100; // ±100mm（50mm→100mmに拡張）
        
        // まず簡単な計算で光線の開始位置を推定
        const startZ = -25; // 固定位置Z=-25mm
        
        // console.log(`🔍 Brent法開始: 絞り面中心(${stopCenter.x}, ${stopCenter.y}, ${stopCenter.z}), 開始Z=${startZ}`);  // ログ削減
        
        // 簡易テスト: 直接計算による光線射出
        const simpleOrigin = {
            x: 0,
            y: 0,
            z: startZ
        };
        
        // テスト光線で光線追跡が動作するか確認
        const testRay = {
            pos: simpleOrigin,
            dir: direction,
            wavelength: this.wavelength
        };
        
        // console.log(`🔍 テスト光線実行: 位置(${simpleOrigin.x}, ${simpleOrigin.y}, ${simpleOrigin.z}), 方向(${direction.x.toFixed(4)}, ${direction.y.toFixed(4)}, ${direction.z.toFixed(4)})`);  // ログ削減
        
        try {
            const testResult = traceRay(this.opticalSystemRows, testRay);
            // console.log(`🔍 テスト光線結果:`, testResult ? `成功(${Array.isArray(testResult) ? testResult.length : 'オブジェクト'}点)` : '失敗');  // ログ削減
            
            if (testResult && Array.isArray(testResult) && testResult.length > 1) {
                // テスト光線が成功した場合、簡単な位置調整を行う
                const stopPoint = testResult[this.stopSurfaceIndex] || testResult[Math.min(this.stopSurfaceIndex, testResult.length - 1)];
                if (stopPoint) {
                    // console.log(`🔍 テスト光線の絞り面交点: (${stopPoint.x.toFixed(3)}, ${stopPoint.y.toFixed(3)}, ${stopPoint.z.toFixed(3)})`);  // ログ削減
                    
                    // 簡単な補正計算
                    const correctionX = -stopPoint.x;
                    const correctionY = -stopPoint.y;
                    
                    return {
                        x: simpleOrigin.x + correctionX,
                        y: simpleOrigin.y + correctionY,
                        z: startZ
                    };
                }
            }
        } catch (error) {
            console.error(`❌ テスト光線エラー:`, error);
        }
        
        // Brent法による最適化（テスト光線が失敗した場合のフォールバック）
        console.log(`🔍 Brent法による最適化開始`);
        
        // X方向の目的関数
        const objectiveFunctionX = (x) => {
            const testOrigin = {
                x: x,
                y: 0,
                z: -25 // 固定位置Z=-25mm
            };
            
            const testRay = {
                pos: testOrigin,
                dir: direction,
                wavelength: this.wavelength
            };
            
            try {
                const rayPath = traceRay(this.opticalSystemRows, testRay);
                if (!rayPath || !Array.isArray(rayPath) || rayPath.length <= this.stopSurfaceIndex) {
                    return 1000; // 大きな誤差値
                }
                
                const stopPoint = rayPath[this.stopSurfaceIndex];
                return stopPoint.x - stopCenter.x; // 目標は0
            } catch (error) {
                return 1000;
            }
        };
        
        // Y方向の目的関数
        const objectiveFunctionY = (y) => {
            const testOrigin = {
                x: 0,
                y: y,
                z: -25 // 固定位置Z=-25mm
            };
            
            const testRay = {
                pos: testOrigin,
                dir: direction,
                wavelength: this.wavelength
            };
            
            try {
                const rayPath = traceRay(this.opticalSystemRows, testRay);
                if (!rayPath || !Array.isArray(rayPath) || rayPath.length <= this.stopSurfaceIndex) {
                    return 1000;
                }
                
                const stopPoint = rayPath[this.stopSurfaceIndex];
                return stopPoint.y - stopCenter.y; // 目標は0
            } catch (error) {
                return 1000;
            }
        };
        
        // Brent法でX, Y座標を最適化
        let optimalX = 0;
        let optimalY = 0;
        
        try {
            optimalX = this.brent(objectiveFunctionX, -searchRange, searchRange, 1e-2, 100);
            console.log(`✅ [Brent] 主光線X座標最適化完了: ${optimalX.toFixed(6)}mm`);
        } catch (error) {
            console.warn(`⚠️ [Brent] 主光線X方向最適化失敗: ${error.message}`);
            optimalX = 0; // フォールバック
        }
        
        try {
            optimalY = this.brent(objectiveFunctionY, -searchRange, searchRange, 1e-2, 100);
            console.log(`✅ [Brent] 主光線Y座標最適化完了: ${optimalY.toFixed(6)}mm`);
        } catch (error) {
            console.warn(`⚠️ [Brent] 主光線Y方向最適化失敗: ${error.message}`);
            optimalY = 0; // フォールバック
        }
        
        return {
            x: optimalX,
            y: optimalY,
            z: stopCenter.z - 1000
        };
    }

    /**
     * Brent法による根探索（クラス内メソッド）
     * @param {Function} f - 目的関数
     * @param {number} a - 探索区間の左端
     * @param {number} b - 探索区間の右端
     * @param {number} tol - 許容誤差
     * @param {number} maxIter - 最大反復回数
     * @returns {number} 根の近似値
     */
    brent(f, a, b, tol = 1e-8, maxIter = 100) {
        let fa = f(a), fb = f(b);
        
        // 初期区間で符号が変わっていることを確認
        if (fa * fb >= 0) {
            // 符号が変わる区間を探索
            const originalA = a, originalB = b;
            let found = false;
            
            for (let i = 1; i <= 10 && !found; i++) {
                a = originalA * i;
                b = originalB * i;
                fa = f(a);
                fb = f(b);
                if (fa * fb < 0) {
                    found = true;
                }
            }
            
            if (!found) {
                // 符号が変わる区間が見つからない場合は近似解を返す
                return 0;
            }
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

        // 収束しない場合は現在の最良推定値を返す
        return b;
    }

    /**
     * 周辺光線の光路差を計算
     * @param {number} pupilX - 瞳座標X
     * @param {number} pupilY - 瞳座標Y
     * @param {Object} fieldSetting - フィールド設定
     * @returns {number} 光路差（μm）
     */
    calculateOPD(pupilX, pupilY, fieldSetting, options = undefined) {
        // 🆕 各画角に対して基準光線を確実に設定
        // 画角が変わるたびに主光線の光路長を再計算する必要がある
        const currentFieldKey = this.getFieldCacheKey(fieldSetting);
        
        // 前回と異なる画角の場合、または基準光路長が未設定の場合
        if (this.referenceOpticalPath === null || this.lastFieldKey !== currentFieldKey) {
            // Disable excessive logging during grid calculations
            // if (this.lastFieldKey !== currentFieldKey) {
            //     console.log(`📐 画角変更検出: ${this.lastFieldKey || 'undefined'} → ${currentFieldKey}`);
            // }
            
            // 基準光線を再設定
            this.setReferenceRay(fieldSetting);
            this.lastFieldKey = currentFieldKey;
        }

        try {
            const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);

            // 理論計算: unit pupil 外は無効
            if (pupilRadius > 1.0 + 1e-9) {
                return NaN;
            }
            
            // 🆕 主光線のOPD検証（瞳座標0,0の場合）のみ一回だけログ出力
            const isChiefRay = Math.abs(pupilX) < 1e-6 && Math.abs(pupilY) < 1e-6;

            // ✅ CRITICAL FIX: For pupil=(0,0), the reference ray is the chief ray by definition.
            // Return OPD=0 directly to avoid re-generating the ray (which may fail in off-axis fields).
            if (isChiefRay) {
                this.lastRayCalculation = {
                    ray: null,  // Reference ray is already set
                    success: true,
                    error: null,
                    opd: 0.0,
                    fieldKey: currentFieldKey,
                    pupilCoord: { x: pupilX, y: pupilY },
                    stopHit: null
                };
                return 0.0;  // Chief ray has zero OPD by definition
            }
            
            // Disable excessive logging during grid calculations
            // if (isChiefRay) {
            //     console.log(`🔍 主光線OPD計算: pupilX=${pupilX.toFixed(6)}, pupilY=${pupilY.toFixed(6)}`);
            //     console.log(`🔍 使用中の基準光路長: ${this.referenceOpticalPath.toFixed(6)}μm (画角: ${currentFieldKey})`);
            // }

            // 光線生成（失敗時は無効）
            // NOTE: Do NOT switch pupilSamplingMode here. Switching modes mid-grid can corrupt a
            // single wavefront map (mixed pupil definitions and reference rays). Mode selection
            // for best-effort (stop→entrance) is handled at a higher level (wavefront generation).
            let marginalRay = this.generateMarginalRay(pupilX, pupilY, fieldSetting, options);
            if (!marginalRay) {
                const reason = this._lastMarginalRayGenFailure
                    ? `ray generation failed: ${this._lastMarginalRayGenFailure}`
                    : 'ray generation failed';
                this.lastRayCalculation = {
                    ray: null,
                    success: false,
                    error: reason,
                    fieldKey: currentFieldKey,
                    pupilCoord: { x: pupilX, y: pupilY },
                    stopHit: this._lastStopHitInfo
                };
                return NaN;
            }

            // 周辺光線の光路長を計算
            const marginalOpticalPath = this.calculateOpticalPath(marginalRay);
            // Disable excessive logging during grid calculations
            // if (isChiefRay) {
            //     console.log(`🔍 周辺光線光路長: ${marginalOpticalPath}μm`);
            //     console.log(`🔍 基準光路長: ${this.referenceOpticalPath}μm`);
            // }
            
            // 光路長の有効性チェック（原因を簡易分類）
            if (!isFinite(marginalOpticalPath) || isNaN(marginalOpticalPath)) {
                const pathData = this.extractPathData(marginalRay);
                let reason = 'optical path calculation failed';
                if (!Array.isArray(pathData)) {
                    reason = 'ray path missing';
                } else if (pathData.length < 2) {
                    reason = `ray path too short (${pathData.length})`;
                } else {
                    const expectedPathPoints = 1 + (Array.isArray(this._recordedSurfaceIndices) ? this._recordedSurfaceIndices.length : 0);
                    if (pathData.length < expectedPathPoints) {
                        reason = `ray did not reach evaluation surface (${pathData.length}/${expectedPathPoints})`;
                    } else {
                        reason = 'optical path invalid (segment)';
                    }
                }

                if (OPD_DEBUG && rayTraceFailureWarnCount < 20) {
                    rayTraceFailureWarnCount++;
                    console.warn(`⚠️ 周辺光線光路長がNaN/INF: ${reason}`);
                }

                this.lastRayCalculation = { ray: marginalRay, success: false, error: reason, stopHit: this._lastStopHitInfo };
                return NaN;
            }
            
            if (!isFinite(this.referenceOpticalPath) || isNaN(this.referenceOpticalPath)) {
                if (OPD_DEBUG && rayTraceFailureWarnCount < 20) {
                    rayTraceFailureWarnCount++;
                    console.warn(`⚠️ 基準光路長がNaN/INF: ${this.referenceOpticalPath}`);
                }
                this.lastRayCalculation = { ray: marginalRay, success: false, error: 'reference optical path invalid', stopHit: this._lastStopHitInfo };
                return NaN;
            }

            // OPD = 周辺光線光路長 - 基準光路長
            const opd = marginalOpticalPath - this.referenceOpticalPath;
            
            // 🆕 主光線のOPD検証
            if (isChiefRay) {
                const chiefOPDError = Math.abs(opd);
                // Disable excessive logging during grid calculations - only show warnings for major errors
                if (OPD_DEBUG && chiefOPDError > 1e-3) { // 1nm以上の誤差のみログ出力
                    console.warn(`⚠️ 主光線のOPDが0でありません！誤差=${chiefOPDError.toFixed(6)}μm`);
                    console.warn(`🔧 基準光路長の設定に問題がある可能性があります`);
                    console.warn(`📊 [主光線詳細] 周辺光路長=${marginalOpticalPath.toFixed(6)}μm, 基準光路長=${this.referenceOpticalPath.toFixed(6)}μm`);
                }
                // Success messages disabled to prevent console spam
                // console.log(`📊 [主光線OPD検証] OPD=${opd.toFixed(6)}μm, 誤差=${chiefOPDError.toFixed(6)}μm`);
                // console.log(`✅ 主光線のOPDが正しく0に近い値です`);
            }
            
            // OPDの有効性チェック
            if (!isFinite(opd) || isNaN(opd)) {
                console.error(`❌ OPD計算結果がNaN/INF: ${opd} (marginal=${marginalOpticalPath}, reference=${this.referenceOpticalPath})`);
                this.lastRayCalculation = { ray: marginalRay, success: false, error: 'OPD calculation failed', stopHit: this._lastStopHitInfo };
                return NaN;
            }
            
            // 理論計算: 値のクリップ/閾値処理は行わない
            
            // Disable excessive success logging during grid calculations
            // if (isChiefRay) {
            //     console.log(`✅ OPD計算成功: ${opd.toFixed(6)}μm (pupilX=${pupilX.toFixed(3)}, pupilY=${pupilY.toFixed(3)})`);
            // }

            // 光線データの詳細をログ出力
            this.lastRayCalculation = {
                ray: marginalRay,
                success: true,
                opd: opd,
                opticalPath: marginalOpticalPath,
                referenceOpticalPath: this.referenceOpticalPath,
                fieldKey: currentFieldKey,
                pupilCoord: { x: pupilX, y: pupilY },
                stopHit: this._lastStopHitInfo
            };
        
            return opd;
        } catch (error) {
            console.error(`❌ OPD計算エラー（光線が蹴られた可能性）: pupilX=${pupilX}, pupilY=${pupilY}`, error);
            this.lastRayCalculation = { ray: null, success: false, error: error.message, stopHit: this._lastStopHitInfo };
            return NaN; // エラーの場合はNaNを返す
        }
    }

    /**
     * 参照球面を用いたOPD（μm）を計算する。
     * - 現行の calculateOPD は「周辺OPL - 基準OPL」のみで、軸外では参照球幾何を含まない。
     * - こちらは calculateOPDFromReferenceSphere を使い、幾何学補正を含めたOPDを返す。
     */
    calculateOPDReferenceSphere(pupilX, pupilY, fieldSetting, removeTilt = false, options = undefined) {
        const currentFieldKey = this.getFieldCacheKey(fieldSetting);
        const needResetRef = (this.referenceOpticalPath === null || this.lastFieldKey !== currentFieldKey);
        if (needResetRef) {
            this.setReferenceRay(fieldSetting);
            this.lastFieldKey = currentFieldKey;
            try {
                if (this._referenceSphereCache && typeof this._referenceSphereCache.delete === 'function') {
                    this._referenceSphereCache.delete(currentFieldKey);
                }
            } catch (_) {}
        }

        try {
            const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
            if (pupilRadius > 1.0 + 1e-9) {
                return NaN;
            }

            let marginalRay = this.generateMarginalRay(pupilX, pupilY, fieldSetting, options);
            if (!marginalRay) {
                const reason = this._lastMarginalRayGenFailure
                    ? `ray generation failed: ${this._lastMarginalRayGenFailure}`
                    : 'ray generation failed';
                this.lastRayCalculation = {
                    ray: null,
                    success: false,
                    error: reason,
                    fieldKey: currentFieldKey,
                    pupilCoord: { x: pupilX, y: pupilY }
                };
                return NaN;
            }

            const marginalOpticalPath = this.calculateOpticalPath(marginalRay);
            if (!isFinite(marginalOpticalPath) || isNaN(marginalOpticalPath)) {
                this.lastRayCalculation = {
                    ray: marginalRay,
                    success: false,
                    error: 'optical path calculation failed',
                    fieldKey: currentFieldKey,
                    pupilCoord: { x: pupilX, y: pupilY }
                };
                return NaN;
            }

            // Cache reference-sphere geometry per field to avoid recomputing (and logging) per sample.
            // This is critical for performance at large grids.
            try {
                if (!this._referenceSphereCache) this._referenceSphereCache = new Map();
            } catch (_) {
                // ignore
            }

            let cachedCenter = null;
            let cachedRadius = null;
            let cachedSphereCenter = null;
            try {
                const c = this._referenceSphereCache?.get?.(currentFieldKey);
                if (c && typeof c === 'object') {
                    cachedCenter = c.center || null;
                    cachedRadius = c.radius;
                    cachedSphereCenter = c.sphereCenter || null;
                }
            } catch (_) {}

            // Populate cache if missing.
            if (!cachedCenter) {
                cachedCenter = this.getChiefRayImagePoint();
            }
            if (cachedRadius === null || cachedRadius === undefined) {
                const geom = this.calculateImageSphereGeometry(cachedCenter);
                cachedRadius = geom?.imageSphereRadius;
                cachedSphereCenter = geom?.referenceSphereCenter;
                // On-axis fallback: if chief ray is exactly on-axis, geometry returns Infinity.
                // Use a tiny off-axis probe ray to estimate the axis intersection instead.
                if (!Number.isFinite(cachedRadius) || cachedRadius === Infinity || !cachedSphereCenter) {
                    const probe = this._estimateAxisIntersectionZFromProbe(fieldSetting, options);
                    if (probe && Number.isFinite(probe.axisIntersectionZ)) {
                        cachedSphereCenter = { x: 0, y: 0, z: probe.axisIntersectionZ };
                        const dx = (cachedCenter?.x ?? 0) - cachedSphereCenter.x;
                        const dy = (cachedCenter?.y ?? 0) - cachedSphereCenter.y;
                        const dz = (cachedCenter?.z ?? 0) - cachedSphereCenter.z;
                        cachedRadius = Math.sqrt(dx * dx + dy * dy + dz * dz);
                        if (OPD_DEBUG) {
                            console.log(`🟦 [RefSphere] on-axis probe fallback: axisZ=${cachedSphereCenter.z.toFixed(6)}mm, R=${cachedRadius.toFixed(6)}mm, probe=(${probe.probePupil.x},${probe.probePupil.y})`);
                        }
                    }
                }
                try {
                    this._referenceSphereCache?.set?.(currentFieldKey, { center: cachedCenter, radius: cachedRadius, sphereCenter: cachedSphereCenter });
                } catch (_) {}
            }

            const ref = this.calculateOPDFromReferenceSphere(marginalRay, marginalOpticalPath, fieldSetting, removeTilt, {
                imageSphereCenter: cachedCenter,
                imageSphereRadius: cachedRadius,
                _imageSphereGeometry: {
                    imageSphereRadius: cachedRadius,
                    referenceSphereCenter: cachedSphereCenter
                }
            });
            if (!ref?.success || !isFinite(ref.opd) || isNaN(ref.opd)) {
                this.lastRayCalculation = {
                    ray: marginalRay,
                    success: false,
                    error: ref?.error ? `reference sphere failed: ${ref.error}` : 'reference sphere failed',
                    fieldKey: currentFieldKey,
                    pupilCoord: { x: pupilX, y: pupilY }
                };
                return NaN;
            }

            this.lastRayCalculation = {
                ray: marginalRay,
                success: true,
                opd: ref.opd,
                opticalPath: marginalOpticalPath,
                referenceOpticalPath: this.referenceOpticalPath,
                fieldKey: currentFieldKey,
                pupilCoord: { x: pupilX, y: pupilY },
                referenceSphere: {
                    referenceMode: ref.referenceMode || 'sphere',
                    imageSphereRadius: ref.imageSphereRadius,
                    referenceSphereCenter: ref.referenceSphereCenter,
                    imageSphereCenter: ref.imageSphereCenter,
                    distanceToCenter: ref.distanceToCenter,
                    spherePathDifference: ref.spherePathDifference
                }
            };

            return ref.opd;
        } catch (e) {
            this.lastRayCalculation = { ray: null, success: false, error: e?.message || String(e), fieldKey: currentFieldKey, pupilCoord: { x: pupilX, y: pupilY } };
            return NaN;
        }
    }

    /**
     * 最後の光線計算結果を取得（描画用）
     * @returns {Object|null} 光線計算結果
     */
    getLastRayCalculation() {
        return this.lastRayCalculation;
    }

    /**
     * 主光線の像点を取得（参照球面の中心）
     * @returns {Object|null} 主光線の像点座標
     */
    getChiefRayImagePoint() {
        if (!this.referenceChiefRay) {
            console.warn('⚠️ 主光線データがありません');
            return null;
        }
        
        return this.getRayImagePoint(this.referenceChiefRay);
    }

    /**
     * 光線の像点を取得
     * @param {Array|Object} rayData - 光線データ
     * @returns {Object|null} 像点座標
     */
    getRayImagePoint(rayData) {
        if (!rayData) {
            return null;
        }
        
        let pathData = null;
        if (Array.isArray(rayData)) {
            pathData = rayData;
        } else {
            pathData = rayData.path || rayData.pathData || rayData.points;
        }
        
        if (!Array.isArray(pathData) || pathData.length === 0) {
            return null;
        }
        
        // 最後の点を像点として使用
        const imagePoint = pathData[pathData.length - 1];
        
        if (!imagePoint || 
            typeof imagePoint.x !== 'number' || 
            typeof imagePoint.y !== 'number' || 
            typeof imagePoint.z !== 'number') {
            return null;
        }
        
        return {
            x: imagePoint.x,
            y: imagePoint.y, 
            z: imagePoint.z
        };
    }

    /**
     * 光線データの有効性をチェック
     * @param {Array|Object} rayData - 光線データ
     * @returns {boolean} 有効かどうか
     */
    isValidRayData(rayData) {
        if (!rayData) return false;
        
        let pathData = null;
        if (Array.isArray(rayData)) {
            pathData = rayData;
        } else {
            pathData = rayData.path || rayData.pathData || rayData.points;
        }
        
        if (!Array.isArray(pathData) || pathData.length < 2) {
            return false;
        }
        
        // 最初と最後の点の座標をチェック
        const firstPoint = pathData[0];
        const lastPoint = pathData[pathData.length - 1];
        
        if (!firstPoint || !lastPoint ||
            !isFinite(firstPoint.x) || !isFinite(firstPoint.y) || !isFinite(firstPoint.z) ||
            !isFinite(lastPoint.x) || !isFinite(lastPoint.y) || !isFinite(lastPoint.z)) {
            return false;
        }
        
        return true;
    }

    /**
     * 正式な参照球からの光路差を計算（図面仕様準拠）
     * 
     * 【参照球定義 - 図面より】
     * ◆ 像参照球 (Rex):
     *   - 中心: 主光線が像面と交わる点（実像高 H'）
     *   - 半径: 主光線を逆延長して光軸と交わる点までの距離
     * 
     * ◆ 物参照球 (Ro(-)):  
     *   - 中心: 物体高さ H(-)
     *   - 半径: 主光線が光軸と交わる点までの距離
     */

    /**
     * 参照球面を用いた光路差（OPD）計算【理論修正版】
     * 
     * 【修正理由】
     * 前の実装では軸外でtilt成分が異常に大きくなる問題があった。
     * これは参照球面の定義と光路差計算の理論的誤りによるもの。
     * 
     * 【正しい理論】
     * 1. 軸外OPD = 周辺光線光路長 - 修正参照光路長
     * 2. 修正参照光路長 = 主光線光路長 + 幾何学的光路差補正
     * 3. 幾何学的光路差補正 = (周辺光線像点距離 - 参照球半径)
     * 4. Tilt成分の適切な処理が必要
     * 
     * @param {Object} marginalRay - 周辺光線データ
     * @param {number} marginalOpticalPath - 周辺光線の光路長
     * @param {Object} fieldSetting - フィールド設定
     * @returns {Object} 参照球計算結果
     */
    calculateOPDFromReferenceSphere(marginalRay, marginalOpticalPath, fieldSetting, removeTilt = false, precomputed = null) {
        try {
            // 1. 主光線データの取得
            if (!this.referenceChiefRay) {
                throw new Error('主光線データが設定されていません');
            }
            // Standard reference sphere definition (Zemax/CODE V convention):
            //  - Center: point where chief ray intersects optical axis (主光線が光軸と交わる点)
            //  - Radius: distance from axis intersection to chief ray image point
            //  - The sphere passes through the image point
            const imagePoint = (precomputed && precomputed.imageSphereCenter) ? precomputed.imageSphereCenter : this.getChiefRayImagePoint();
            if (!imagePoint) {
                throw new Error('主光線の像面交点を取得できません');
            }

            // Calculate reference sphere geometry (center on axis + radius)
            let referenceSphereGeometry;
            if (precomputed && precomputed._imageSphereGeometry) {
                referenceSphereGeometry = precomputed._imageSphereGeometry;
            } else {
                referenceSphereGeometry = this.calculateImageSphereGeometry(imagePoint);
            }
            
            // Check if reference sphere is degenerate (radius too small or infinite)
            const MIN_RADIUS = 1e-6; // mm - minimum acceptable radius (essentially non-zero)
            const MAX_RADIUS = 1e6; // mm - maximum acceptable radius
            
            let referenceSphereCenter;
            let referenceSphereRadius;
            let useSimplifiedMode = false;
            
            if (!referenceSphereGeometry || 
                !referenceSphereGeometry.referenceSphereCenter ||
                !Number.isFinite(referenceSphereGeometry.imageSphereRadius) ||
                referenceSphereGeometry.imageSphereRadius < MIN_RADIUS ||
                referenceSphereGeometry.imageSphereRadius > MAX_RADIUS) {
                
                // Fallback: use simplified reference at image plane
                // This happens when chief ray is nearly on-axis or parallel to axis
                console.warn(`⚠️ 参照球半径が異常 (${referenceSphereGeometry?.imageSphereRadius?.toFixed(6)} mm), 像面基準モードに切替`);
                referenceSphereCenter = imagePoint; // Reference at image point
                referenceSphereRadius = 0.001; // Nominal small radius
                useSimplifiedMode = true;
            } else {
                referenceSphereCenter = referenceSphereGeometry.referenceSphereCenter;
                referenceSphereRadius = referenceSphereGeometry.imageSphereRadius;
            }

            const getRayImagePoint = (rayData) => {
                const path = this.getPathData(rayData);
                if (!Array.isArray(path) || path.length < 1) return null;
                const last = path[path.length - 1]; // Image plane point
                return { x: last.x, y: last.y, z: last.z };
            };

            const chiefImagePoint = getRayImagePoint(this.referenceChiefRay);
            if (!chiefImagePoint) throw new Error('主光線の像面交点が不足しています');

            const marginalImagePoint = getRayImagePoint(marginalRay);
            if (!marginalImagePoint) throw new Error('周辺光線の像面交点が不足しています');

            // Calculate distances from image points to reference sphere center
            const chiefDist = Math.sqrt(
                (chiefImagePoint.x - referenceSphereCenter.x)**2 + 
                (chiefImagePoint.y - referenceSphereCenter.y)**2 + 
                (chiefImagePoint.z - referenceSphereCenter.z)**2
            );
            
            const marginalDist = Math.sqrt(
                (marginalImagePoint.x - referenceSphereCenter.x)**2 + 
                (marginalImagePoint.y - referenceSphereCenter.y)**2 + 
                (marginalImagePoint.z - referenceSphereCenter.z)**2
            );

            // DEBUG: Check sphere geometry
            console.log(`🔍 参照球チェック:
  半径: ${referenceSphereRadius.toFixed(3)} mm
  主光線像点の球中心からの距離: ${chiefDist.toFixed(3)} mm
  差: ${(chiefDist - referenceSphereRadius).toFixed(6)} mm
  周辺光線像点の球中心からの距離: ${marginalDist.toFixed(3)} mm`);

            // Refractive index in image space
            const nImg = (() => {
                try {
                    const margPath = this.getPathData(marginalRay);
                    const segIdx = Math.max(0, (margPath?.length || 2) - 2);
                    const n = this.getRefractiveIndex(segIdx);
                    return (Number.isFinite(n) && n > 0) ? n : 1.0;
                } catch (_) {
                    return 1.0;
                }
            })();

            let opd, spherePathDifference, referenceOpticalPathCorrected;
            
            if (useSimplifiedMode) {
                // Simplified mode: image plane reference with geometric correction
                // Even without a reference sphere, we need to correct for position differences
                // on the image plane. Use chief ray image point as reference.
                
                // Calculate distance from marginal image point to chief image point
                const dx = marginalImagePoint.x - chiefImagePoint.x;
                const dy = marginalImagePoint.y - chiefImagePoint.y;
                const dz = marginalImagePoint.z - chiefImagePoint.z;
                const imagePlaneDistance = Math.sqrt(dx*dx + dy*dy + dz*dz); // mm
                
                // Geometric correction: subtract the straight-line distance on image plane
                const geometricCorrection = imagePlaneDistance * nImg * 1000; // mm to μm
                
                // OPD = optical path difference - geometric distance difference
                opd = (marginalOpticalPath - this.referenceOpticalPath) - geometricCorrection;
                spherePathDifference = imagePlaneDistance; // mm
                referenceOpticalPathCorrected = this.referenceOpticalPath;
                
                console.log(`📌 像面基準モード: 
  光路差: ${(marginalOpticalPath - this.referenceOpticalPath).toFixed(3)} μm
  幾何補正: ${geometricCorrection.toFixed(3)} μm
  OPD: ${opd.toFixed(6)} μm`);
            } else {
                // Standard mode: OPD calculation based on reference sphere
                // OPD = (marginal optical path - marginal geometric distance to sphere)
                //     - (chief optical path - chief geometric distance to sphere)
                // Since chief ray defines the sphere (chiefDist ≈ radius), the second term ≈ 0
                const marginalGeometricCorrection = (marginalDist - referenceSphereRadius) * nImg * 1000; // mm to μm
                const chiefGeometricCorrection = (chiefDist - referenceSphereRadius) * nImg * 1000; // mm to μm
                
                opd = (marginalOpticalPath - marginalGeometricCorrection) - (this.referenceOpticalPath - chiefGeometricCorrection);
                spherePathDifference = marginalDist - referenceSphereRadius; // mm
                referenceOpticalPathCorrected = this.referenceOpticalPath - chiefGeometricCorrection;
            }

            return {
                success: true,
                opd: opd,
                opdWithoutTilt: opd,
                tiltComponent: 0,
                imageSphereCenter: imagePoint,
                imageSphereRadius: referenceSphereRadius,
                referenceSphereCenter: referenceSphereCenter,
                marginalImagePoint: marginalImagePoint,
                distanceToCenter: marginalDist,
                spherePathDifference,
                referenceOpticalPathCorrected: referenceOpticalPathCorrected,
                marginalOpticalPath,
                referenceChiefPath: this.referenceOpticalPath,
                referenceMode: useSimplifiedMode ? 'imagePlaneSimplified' : 'axisCenterStandardSphere'
            };
        } catch (error) {
            console.warn(`⚠️ 参照球計算に失敗: ${error.message}`);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * 像参照球の幾何を計算（球中心 + 半径）
     *
     * - 入力: 像面上の主光線像点（実像高 H'）
     * - 出力: 球中心(光軸上の交点) + 半径(Rex)
     */
    calculateImageSphereGeometry(imageSpherePoint) {
        try {
            if (!this.referenceChiefRay) {
                throw new Error('主光線データが設定されていません');
            }

            // 主光線の最後の2点から方向ベクトルを計算
            const chiefPath = this.getPathData(this.referenceChiefRay);
            if (!chiefPath || chiefPath.length < 2) {
                throw new Error('主光線のパスデータが不十分です');
            }

            const lastPoint = chiefPath[chiefPath.length - 1]; // 像面交点
            const prevPoint = chiefPath[chiefPath.length - 2];

            // 主光線の方向ベクトル（逆方向 = 主光線を逆延長）
            const dirX = prevPoint.x - lastPoint.x;
            const dirY = prevPoint.y - lastPoint.y;
            const dirZ = prevPoint.z - lastPoint.z;

            const dirLength = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
            if (dirLength === 0) {
                throw new Error('主光線の方向ベクトルが計算できません');
            }

            const normalizedDirX = dirX / dirLength;
            const normalizedDirY = dirY / dirLength;
            const normalizedDirZ = dirZ / dirLength;

            let t = null;
            if (Math.abs(normalizedDirX) > 1e-10) {
                t = -imageSpherePoint.x / normalizedDirX;
            } else if (Math.abs(normalizedDirY) > 1e-10) {
                t = -imageSpherePoint.y / normalizedDirY;
            } else {
                // Chief ray ~ parallel to axis → intersection at infinity
                return { imageSphereRadius: Infinity, referenceSphereCenter: null, axisIntersectionZ: null };
            }

            if (t === null || !isFinite(t)) {
                throw new Error('光軸との交点パラメータが計算できません');
            }

            const axisIntersectionZ = imageSpherePoint.z + t * normalizedDirZ;
            const dz = imageSpherePoint.z - axisIntersectionZ;
            const radius = Math.sqrt(imageSpherePoint.x * imageSpherePoint.x + imageSpherePoint.y * imageSpherePoint.y + dz * dz);

            return {
                imageSphereRadius: radius,
                referenceSphereCenter: { x: 0, y: 0, z: axisIntersectionZ },
                axisIntersectionZ
            };
        } catch (error) {
            console.error(`❌ 像参照球幾何計算エラー: ${error.message}`);
            return { imageSphereRadius: null, referenceSphereCenter: null, axisIntersectionZ: null };
        }
    }

    /**
     * On-axis fallback: estimate axis intersection using a tiny off-axis probe ray.
     * This avoids infinite reference sphere when the chief ray is exactly on-axis.
     */
    _estimateAxisIntersectionZFromProbe(fieldSetting, options = undefined) {
        try {
            const probePairs = [
                { x: 1e-3, y: 0 },
                { x: 0, y: 1e-3 },
                { x: 1e-2, y: 0 },
                { x: 0, y: 1e-2 }
            ];
            for (const p of probePairs) {
                let ray = null;
                try {
                    ray = this.generateMarginalRay(p.x, p.y, fieldSetting, options);
                } catch (_) {
                    ray = null;
                }
                const path = this.getPathData(ray);
                if (!Array.isArray(path) || path.length < 2) continue;
                const last = path[path.length - 1];
                const prev = path[path.length - 2];
                if (!last || !prev) continue;

                const dirX = prev.x - last.x;
                const dirY = prev.y - last.y;
                const dirZ = prev.z - last.z;

                let t = null;
                if (Math.abs(dirX) > 1e-12) {
                    t = -last.x / dirX;
                } else if (Math.abs(dirY) > 1e-12) {
                    t = -last.y / dirY;
                } else {
                    continue;
                }

                const axisIntersectionZ = last.z + t * dirZ;
                if (Number.isFinite(axisIntersectionZ)) {
                    return {
                        axisIntersectionZ,
                        probePupil: { x: p.x, y: p.y }
                    };
                }
            }
        } catch (_) {
            // ignore
        }
        return null;
    }

    /**
     * 像参照球の半径を計算（図面仕様準拠）
     * 
     * 【図面定義】像参照球 Rex:
     * - 中心: 実像高 H'（主光線と像面の交点）
     * - 半径: 主光線を逆延長して光軸と交わる点までの距離
     * 
     * @param {Object} imageSphereCenter - 像参照球中心座標（実像高 H'）
     * @returns {number|null} 像参照球半径 Rex（mm）
     */
    calculateImageSphereRadius(imageSphereCenter) {
        try {
            const geom = this.calculateImageSphereGeometry(imageSphereCenter);
            return geom?.imageSphereRadius ?? null;

        } catch (error) {
            console.error(`❌ 像参照球半径計算エラー: ${error.message}`);
            return null;
        }
    }

    /**
     * 光線データからパス情報を取得
     * @param {Array|Object} rayData - 光線データ
     * @returns {Array|null} パスデータ
     */
    getPathData(rayData) {
        if (!rayData) {
            return null;
        }
        
        if (Array.isArray(rayData)) {
            return rayData;
        } else {
            return rayData.path || rayData.pathData || rayData.points || null;
        }
    }

    /**
     * 物参照球の半径を計算（図面仕様準拠）
     * 
     * 【図面定義】物参照球 Ro(-):
     * - 中心: 物体高さ H(-)
     * - 半径: 主光線が光軸と交わる点までの距離
     * 
     * @param {Object} fieldSetting - フィールド設定
     * @returns {Object|null} 物参照球情報
     */
    calculateObjectSphereRadius(fieldSetting) {
        try {
            if (!this.referenceChiefRay) {
                throw new Error('主光線データが設定されていません');
            }

            // 1. 物参照球の中心: 物体高さ H(-) 【図面準拠】
            const objectHeight = fieldSetting.yHeight || 0; // mm
            const objectSphereCenter = {
                x: 0,
                y: objectHeight, // 物体高さ H(-)
                z: 0 // 物面のz位置（通常は0または第1面の位置）
            };

            // 2. 主光線の最初の2点から方向ベクトルを計算
            const chiefPath = this.getPathData(this.referenceChiefRay);
            if (!chiefPath || chiefPath.length < 2) {
                throw new Error('主光線のパスデータが不十分です');
            }

            const firstPoint = chiefPath[0]; // 物面上の点
            const secondPoint = chiefPath[1]; // 次の点

            // 主光線の方向ベクトル（物側から像側へ）
            const dirX = secondPoint.x - firstPoint.x;
            const dirY = secondPoint.y - firstPoint.y;
            const dirZ = secondPoint.z - firstPoint.z;

            // 方向ベクトルの正規化
            const dirLength = Math.sqrt(dirX*dirX + dirY*dirY + dirZ*dirZ);
            if (dirLength === 0) {
                throw new Error('主光線の方向ベクトルが計算できません');
            }

            const normalizedDirX = dirX / dirLength;
            const normalizedDirY = dirY / dirLength;
            const normalizedDirZ = dirZ / dirLength;

            // 3. 主光線を延長して光軸(x=0, y=0)との交点を求める【図面準拠】
            // パラメトリック方程式: P = firstPoint + t * direction
            // 光軸条件: x = 0, y = 0
            // この交点が物参照球 Ro(-) の半径を決定する基準点
            
            let t = null;
            
            if (Math.abs(normalizedDirX) > 1e-10) {
                t = -firstPoint.x / normalizedDirX;
                
                // y座標でも確認
                const yAtT = firstPoint.y + t * normalizedDirY;
                if (OPD_DEBUG && Math.abs(yAtT) > 1e-6) {
                    console.warn(`⚠️ 物側光軸交点でy座標が0になりません: y=${yAtT.toFixed(6)}`);
                }
            } else if (Math.abs(normalizedDirY) > 1e-10) {
                t = -firstPoint.y / normalizedDirY;
                
                // x座標でも確認
                const xAtT = firstPoint.x + t * normalizedDirX;
                if (OPD_DEBUG && Math.abs(xAtT) > 1e-6) {
                    console.warn(`⚠️ 物側光軸交点でx座標が0になりません: x=${xAtT.toFixed(6)}`);
                }
            } else {
                throw new Error('主光線が光軸に平行で交点を計算できません');
            }

            if (t === null || !isFinite(t)) {
                throw new Error('物側光軸との交点パラメータが計算できません');
            }

            // 光軸交点のz座標
            const axisIntersectionZ = firstPoint.z + t * normalizedDirZ;

            // 4. 物参照球半径 = 中心から光軸交点までの距離
            const radiusSquared = (objectSphereCenter.x * objectSphereCenter.x) + 
                                 ((objectSphereCenter.y - 0) * (objectSphereCenter.y - 0)) + 
                                 ((objectSphereCenter.z - axisIntersectionZ) * (objectSphereCenter.z - axisIntersectionZ));
            
            const radius = Math.sqrt(radiusSquared);

            if (OPD_DEBUG) {
                console.log(`📐 物参照球半径計算:`);
                console.log(`  物球中心: (${objectSphereCenter.x.toFixed(6)}, ${objectSphereCenter.y.toFixed(6)}, ${objectSphereCenter.z.toFixed(6)})mm`);
                console.log(`  光軸交点: (0, 0, ${axisIntersectionZ.toFixed(6)})mm`);
                console.log(`  計算半径: ${radius.toFixed(6)}mm`);
            }

            return {
                center: objectSphereCenter,
                radius: radius,
                axisIntersection: { x: 0, y: 0, z: axisIntersectionZ }
            };

        } catch (error) {
            console.error(`❌ 物参照球半径計算エラー: ${error.message}`);
            return null;
        }
    }

    /**
            console.warn('主光線の像面交点が取得できません、単純な光路差を返します');
            return marginalOpticalPath - this.referenceOpticalPath;
        }
        
        // 射出瞳中心の位置（絞り面位置を近似）
        const exitPupilCenter = this.getSurfaceOrigin(this.stopSurfaceIndex);
        
        // 参照球面の半径 = 射出瞳中心から主光線像点までの距離
        const dx = chiefRayImagePoint.x - exitPupilCenter.x;
        const dy = chiefRayImagePoint.y - exitPupilCenter.y;
        const dz = chiefRayImagePoint.z - exitPupilCenter.z;
        const referenceSphereRadius = Math.sqrt(dx*dx + dy*dy + dz*dz); // mm
        
        // 射出瞳面での周辺光線位置
        const stopSurface = this.opticalSystemRows[this.stopSurfaceIndex];
        const stopRadius = parseFloat(stopSurface.semidia || 10);
        const pupilPointX = exitPupilCenter.x + pupilX * stopRadius;
        const pupilPointY = exitPupilCenter.y + pupilY * stopRadius;
        const pupilPoint = { x: pupilPointX, y: pupilPointY, z: exitPupilCenter.z };
        
        // 周辺光線の瞳点から参照球面中心までの距離
        const pdx = chiefRayImagePoint.x - pupilPoint.x;
        const pdy = chiefRayImagePoint.y - pupilPoint.y;
        const pdz = chiefRayImagePoint.z - pupilPoint.z;
        const pupilToImageDistance = Math.sqrt(pdx*pdx + pdy*pdy + pdz*pdz); // mm
        
        // 参照球面からの理論光路長 = 瞳点から参照球面までの距離
        const theoreticalOpticalPath = pupilToImageDistance * 1000; // mm → μm
        
        // 主光線の基準光路長 = 射出瞳中心から参照球面中心までの距離
        const referenceTheoretical = referenceSphereRadius * 1000; // mm → μm
        
        // 光路差 = (実際の光路長 - 基準光路長) - (理論光路長 - 基準理論光路長)
        const opd = (marginalOpticalPath - this.referenceOpticalPath) - (theoreticalOpticalPath - referenceTheoretical);
        
        if (OPD_DEBUG) {
            console.log(`🔍 参照球面計算詳細:`, {
                参照球面半径: referenceSphereRadius.toFixed(3) + 'mm',
                理論光路長: theoreticalOpticalPath.toFixed(3) + 'μm',
                基準理論: referenceTheoretical.toFixed(3) + 'μm',
                OPD: opd.toFixed(6) + 'μm'
            });
        }
        
        return opd;
    }

    /**
     * 周辺光線の光路差を波長単位で計算
     * @param {number} pupilX - 瞳座標X
     * @param {number} pupilY - 瞳座標Y
     * @param {Object} fieldSetting - フィールド設定
     * @returns {number} 光路差（波長単位）
     */
    calculateOPDInWavelengths(pupilX, pupilY, fieldSetting) {
        // 直前に calculateOPD が呼ばれていればそれを使う（同一点・同フィールドのみ）
        try {
            const currentFieldKey = `${fieldSetting.fieldAngle?.x || 0}_${fieldSetting.fieldAngle?.y || 0}_${fieldSetting.xHeight || 0}_${fieldSetting.yHeight || 0}`;
            const last = this.lastRayCalculation;
            if (last?.success && last.fieldKey === currentFieldKey && last.pupilCoord) {
                const dx = Math.abs((last.pupilCoord.x ?? 1e9) - pupilX);
                const dy = Math.abs((last.pupilCoord.y ?? 1e9) - pupilY);
                if (dx < 1e-12 && dy < 1e-12 && isFinite(last.opd) && !isNaN(last.opd)) {
                    return last.opd / this.wavelength;
                }
            }
        } catch (_) {}

        const opdInMicrons = this.calculateOPD(pupilX, pupilY, fieldSetting);
        if (!isFinite(opdInMicrons) || isNaN(opdInMicrons)) {
            return NaN;
        }
        return opdInMicrons / this.wavelength;
    }

    /**
     * 周辺光線を生成
     * @param {number} pupilX - 瞳座標X
     * @param {number} pupilY - 瞳座標Y
     * @param {Object} fieldSetting - フィールド設定
     * @returns {Object} 周辺光線データ
     */
    generateMarginalRay(pupilX, pupilY, fieldSetting, options = undefined) {
        const prof = this._wavefrontProfile;
        const enabled = !!(prof && prof.enabled);
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? () => performance.now()
            : () => Date.now();
        const t0 = enabled ? now() : 0;

        const isFinite = this.isFiniteForField(fieldSetting);

        // calculateOPD が失敗理由を拾えるように毎回リセット
        this._lastMarginalRayGenFailure = null;
        this._lastStopHitInfo = null;
        this._lastMarginalRayOrigin = null;
        this._lastMarginalRayOriginGeom = null;
        this._lastMarginalRayOriginDelta = null;
        
        // console.log(`🔍 generateMarginalRay: pupilX=${pupilX}, pupilY=${pupilY}, isFinite=${isFinite}`);  // ログ削減
        
        if (isFinite) {
            if (enabled) {
                prof.marginalRayFiniteCalls = (prof.marginalRayFiniteCalls || 0) + 1;
            }
            const result = this.generateFiniteMarginalRay(pupilX, pupilY, fieldSetting, options);
            // Debug logging disabled to prevent console spam
            if (!result && !this._lastMarginalRayGenFailure) {
                this._lastMarginalRayGenFailure = 'finite: returned null';
            }
            if (enabled) {
                const dt = now() - t0;
                prof.marginalRayCalls = (prof.marginalRayCalls || 0) + 1;
                prof.marginalRayMs = (prof.marginalRayMs || 0) + (Number.isFinite(dt) ? dt : 0);
            }
            return result;
        } else {
            if (enabled) {
                prof.marginalRayInfiniteCalls = (prof.marginalRayInfiniteCalls || 0) + 1;
            }
            const result = this.generateInfiniteMarginalRay(pupilX, pupilY, fieldSetting, options);
            // Debug logging disabled to prevent console spam
            if (!result && !this._lastMarginalRayGenFailure) {
                this._lastMarginalRayGenFailure = 'infinite: returned null';
            }
            if (enabled) {
                const dt = now() - t0;
                prof.marginalRayCalls = (prof.marginalRayCalls || 0) + 1;
                prof.marginalRayMs = (prof.marginalRayMs || 0) + (Number.isFinite(dt) ? dt : 0);
            }
            return result;
        }
    }

    /**
     * 有限系の周辺光線生成
     * @param {number} pupilX - 瞳座標X
     * @param {number} pupilY - 瞳座標Y
     * @param {Object} fieldSetting - フィールド設定
     * @returns {Object} 周辺光線データ
     */
    generateFiniteMarginalRay(pupilX, pupilY, fieldSetting, options = undefined) {
        const fastSolve = !!(options && (options.fastMarginalRay || options.fastSolve));
        const firstSurface = this.opticalSystemRows[0];
        const objectDistance = Math.abs(parseFloat(firstSurface.thickness || firstSurface.Thickness));
        
        // Object面での光線位置
        const yObject = fieldSetting.yHeight || 0;
        const xObject = fieldSetting.xHeight || 0;
        
        // 絞り面での光線位置（瞳座標制限を解除）
        const stopCenter = this.getSurfaceOrigin(this.stopSurfaceIndex);
        const stopZ = stopCenter.z;
        const stopSurface = this.opticalSystemRows[this.stopSurfaceIndex];
        
        // 🆕 絞り半径の基準値を取得（拡張可能）
        let baseStopRadius = Math.abs(parseFloat(stopSurface.aperture || stopSurface.Aperture || stopSurface.semidia || 10));
        if (stopSurface.aperture || stopSurface.Aperture) {
            baseStopRadius = baseStopRadius / 2; // 直径の場合は半径に変換
        }
        
        // pupil<=1.0 の通常波面計算では「設計絞り半径」をそのまま使用する。
        // ここを膨らませると狙い点が物理絞り外になり、stopLocal誤差→OPD暴れの原因になる。
        const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
        const effectiveStopRadius = (pupilRadius > 1.0)
            ? (baseStopRadius * Math.max(1.0, pupilRadius * 1.1))
            : baseStopRadius;
        
        // IMPORTANT: If the stop is tilted by Coord Break, pupil offsets must be applied
        // along the stop's local axes, not the global X/Y axes.
        const axes = this.getSurfaceAxes(this.stopSurfaceIndex);
        const stopOffset = this.addVec(
            this.scaleVec(axes.ex, pupilX * effectiveStopRadius),
            this.scaleVec(axes.ey, pupilY * effectiveStopRadius)
        );
        const stopX = stopCenter.x + stopOffset.x;
        const stopY = stopCenter.y + stopOffset.y;
        const stopZp = stopCenter.z + stopOffset.z;
        
        const shouldLog = OPD_DEBUG && pupilRadius > 1.0;
        if (shouldLog) {
            console.log(`🔍 瞳座標制限解除: pupilRadius=${pupilRadius.toFixed(3)}, baseStopRadius=${baseStopRadius.toFixed(3)}mm → effectiveStopRadius=${effectiveStopRadius.toFixed(3)}mm`);
            console.log(`🔍 絞り面位置: (${stopX.toFixed(3)}, ${stopY.toFixed(3)}, ${stopZ.toFixed(3)})`);
        }
        
        const objectPosition = { x: xObject, y: yObject, z: -objectDistance };
        // For tilted stops, the target point must live on the stop plane.
        const targetStopPoint = { x: stopX, y: stopY, z: stopZp };

        // まずは高速な直線近似で試す（従来互換 & 高速）
        const dot = (a, b) => (a.x * b.x + a.y * b.y + a.z * b.z);
        let aimedStopPoint = { ...targetStopPoint };
        let rayDirection = this.calculateRayDirection(objectPosition, aimedStopPoint);
        let initialRay = {
            pos: objectPosition,
            dir: rayDirection,
            wavelength: this.wavelength
        };

        // Light-weight stop-hit correction for finite systems.
        // This reduces pupil sampling error when refraction occurs before the stop.
        // Uses stop-local coordinates so Coord Break tilt is handled correctly.
        const stopRadius = baseStopRadius;
        const desiredLocalX = pupilX * stopRadius;
        const desiredLocalY = pupilY * stopRadius;
        const stopTol = fastSolve ? 0.06 : 0.03; // mm
        const maxStopIters = fastSolve ? 5 : 8;
        const gain = fastSolve ? 0.65 : 0.7;
        const maxStep = Math.max(0.5, stopRadius * 0.12); // mm

        let lastErrMag = Infinity;
        let stopIterCount = 0;
        let hadStopHit = false;
        for (let iter = 0; iter < maxStopIters; iter++) {
            stopIterCount++;
            const toStop = this.traceRayToSurface(initialRay, this.stopSurfaceIndex, 1.0);
            const actualStop = this.getStopPointFromRayData(toStop);
            if (!actualStop) break;
            hadStopHit = true;
            const d = { x: actualStop.x - stopCenter.x, y: actualStop.y - stopCenter.y, z: actualStop.z - stopCenter.z };
            const actualLocalX = dot(d, axes.ex);
            const actualLocalY = dot(d, axes.ey);
            const errLX = actualLocalX - desiredLocalX;
            const errLY = actualLocalY - desiredLocalY;
            const errMag = Math.hypot(errLX, errLY);
            lastErrMag = errMag;
            if (!Number.isFinite(errMag) || errMag <= stopTol) break;

            // Move the geometric target opposite to the measured stop-local error.
            const errVec = this.addVec(this.scaleVec(axes.ex, errLX), this.scaleVec(axes.ey, errLY));
            const stepMag = Math.hypot(errVec.x, errVec.y, errVec.z);
            const stepScale = (Number.isFinite(stepMag) && stepMag > maxStep) ? (maxStep / stepMag) : 1.0;
            const step = { x: errVec.x * gain * stepScale, y: errVec.y * gain * stepScale, z: errVec.z * gain * stepScale };
            aimedStopPoint = {
                x: aimedStopPoint.x - step.x,
                y: aimedStopPoint.y - step.y,
                z: aimedStopPoint.z - step.z
            };
            rayDirection = this.calculateRayDirection(objectPosition, aimedStopPoint);
            initialRay = {
                pos: objectPosition,
                dir: rayDirection,
                wavelength: this.wavelength
            };
        }

        // Profile: finite stop correction iteration count
        const prof = this._wavefrontProfile;
        if (prof && prof.enabled) {
            prof.finiteStopCorrectionCalls = (prof.finiteStopCorrectionCalls || 0) + 1;
            prof.finiteStopCorrectionIters = (prof.finiteStopCorrectionIters || 0) + stopIterCount;
            if (fastSolve) prof.finiteStopCorrectionFastCalls = (prof.finiteStopCorrectionFastCalls || 0) + 1;
            if (hadStopHit) prof.finiteStopHitCount = (prof.finiteStopHitCount || 0) + 1;
        }

        // If the quick correction still misses badly near the edge, fall back to the Brent solver.
        // This is slower, so only trigger it for stubborn, near-edge points.
        const brentThreshold = fastSolve ? 0.8 : 0.3;
        if (Number.isFinite(lastErrMag) && lastErrMag > brentThreshold && pupilRadius >= 0.9 && pupilRadius <= 1.01) {
            if (prof && prof.enabled) {
                prof.finiteBrentFallbackCount = (prof.finiteBrentFallbackCount || 0) + 1;
                if (fastSolve) prof.finiteBrentFallbackFastCount = (prof.finiteBrentFallbackFastCount || 0) + 1;
            }
            let dirIJK = findFiniteSystemChiefRayDirection(
                objectPosition,
                aimedStopPoint,
                this.stopSurfaceIndex,
                this.opticalSystemRows,
                false,
                this.wavelength
            );
            if (!dirIJK || !isFinite(dirIJK.i) || !isFinite(dirIJK.j) || !isFinite(dirIJK.k)) {
                dirIJK = this.findFiniteRayDirectionToHitStop(objectPosition, aimedStopPoint, this.stopSurfaceIndex, false);
            }
            if (dirIJK && isFinite(dirIJK.i) && isFinite(dirIJK.j) && isFinite(dirIJK.k)) {
                initialRay = {
                    pos: objectPosition,
                    dir: { x: dirIJK.i, y: dirIJK.j, z: dirIJK.k },
                    wavelength: this.wavelength
                };
            }
        }

        const isChiefRay = OPD_DEBUG && Math.abs(pupilX) < 1e-6 && Math.abs(pupilY) < 1e-6;
        if (isChiefRay) {
            console.log(`🔍 主光線（有限系）: pos(${xObject.toFixed(3)}, ${yObject.toFixed(3)}, ${(-objectDistance).toFixed(3)}), dir(${rayDirection.x.toFixed(3)}, ${rayDirection.y.toFixed(3)}, ${rayDirection.z.toFixed(3)})`);
        }
        
        let result = this.traceRayToEval(initialRay, 1.0);

        // ✅ pupil中心（=chief相当）や、直線近似で失敗した場合は、Stop上の目標点に当たるように方向を最適化
        const pupilIsCenter = Math.abs(pupilX) < 1e-9 && Math.abs(pupilY) < 1e-9;
        const prof2 = this._wavefrontProfile;
        if (prof2 && prof2.enabled && !result) {
            prof2.finiteInitialTraceNullCount = (prof2.finiteInitialTraceNullCount || 0) + 1;
            if (hadStopHit) prof2.finiteEvalNullWithStopHitCount = (prof2.finiteEvalNullWithStopHitCount || 0) + 1;
        }

        // In dense wavefront grids (fastSolve), avoid spending seconds on direction solvers
        // when the ray cannot even reach the stop (likely vignetting before the stop).
        // Keep a small central region eligible for salvage.
        const directionSolvePupilRadiusMax = 0.6;
        const skipDirectionSolveDueToNoStopHit = (!result && fastSolve && !pupilIsCenter && !hadStopHit && Number.isFinite(pupilRadius) && pupilRadius > directionSolvePupilRadiusMax);

        // If holes are unacceptable, try a *cheap* stop-hit fallback first (few iterations / few starts)
        // before skipping. This recovers many points without reintroducing multi-second solver costs.
        if (skipDirectionSolveDueToNoStopHit) {
            if (prof2 && prof2.enabled) {
                prof2.finiteNoStopHitFastFallbackAttempted = (prof2.finiteNoStopHitFastFallbackAttempted || 0) + 1;
            }

            const dirIJKFast = this.findFiniteRayDirectionToHitStop(
                objectPosition,
                targetStopPoint,
                this.stopSurfaceIndex,
                false,
                { fastSolve: true }
            );
            if (dirIJKFast && isFinite(dirIJKFast.i) && isFinite(dirIJKFast.j) && isFinite(dirIJKFast.k)) {
                initialRay = {
                    pos: objectPosition,
                    dir: { x: dirIJKFast.i, y: dirIJKFast.j, z: dirIJKFast.k },
                    wavelength: this.wavelength
                };
                result = this.traceRayToEval(initialRay, 1.0);
                if (result) {
                    if (prof2 && prof2.enabled) {
                        prof2.finiteNoStopHitFastFallbackSucceeded = (prof2.finiteNoStopHitFastFallbackSucceeded || 0) + 1;
                    }
                }
            }

            if (!result) {
                if (prof2 && prof2.enabled) {
                    prof2.finiteDirectionSolveSkippedDueToNoStopHit = (prof2.finiteDirectionSolveSkippedDueToNoStopHit || 0) + 1;
                }
            }
        }
        // Expensive direction solve is only useful when we cannot even form a stop hit.
        // If we already hit the stop but the full trace fails, it's usually downstream vignetting;
        // avoid spending seconds in solvers for dense wavefront grids.
        if (!skipDirectionSolveDueToNoStopHit && (!result || pupilIsCenter) && (!hadStopHit || pupilIsCenter)) {
            let tSolve0 = 0;
            const doProfileSolve = !!(prof2 && prof2.enabled);
            const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
                ? () => performance.now()
                : () => Date.now();
            if (doProfileSolve) {
                prof2.finiteDirectionSolveCalls = (prof2.finiteDirectionSolveCalls || 0) + 1;
                if (fastSolve) prof2.finiteDirectionSolveFastCalls = (prof2.finiteDirectionSolveFastCalls || 0) + 1;
                tSolve0 = now();
            }
            const debugMode = OPD_DEBUG && pupilIsCenter;

            let dirIJK = findFiniteSystemChiefRayDirection(
                objectPosition,
                targetStopPoint,
                this.stopSurfaceIndex,
                this.opticalSystemRows,
                debugMode,
                this.wavelength
            );

            if (!dirIJK || !isFinite(dirIJK.i) || !isFinite(dirIJK.j) || !isFinite(dirIJK.k)) {
                if (doProfileSolve) {
                    prof2.finiteDirectionSolveFallbackCalls = (prof2.finiteDirectionSolveFallbackCalls || 0) + 1;
                    if (fastSolve) prof2.finiteDirectionSolveFallbackFastCalls = (prof2.finiteDirectionSolveFallbackFastCalls || 0) + 1;
                }
                dirIJK = this.findFiniteRayDirectionToHitStop(objectPosition, targetStopPoint, this.stopSurfaceIndex, debugMode, options);
            }

            if (doProfileSolve) {
                const dtSolve = now() - tSolve0;
                prof2.finiteDirectionSolveMs = (prof2.finiteDirectionSolveMs || 0) + (Number.isFinite(dtSolve) ? dtSolve : 0);
            }

            if (dirIJK && isFinite(dirIJK.i) && isFinite(dirIJK.j) && isFinite(dirIJK.k)) {
                initialRay = {
                    pos: objectPosition,
                    dir: { x: dirIJK.i, y: dirIJK.j, z: dirIJK.k },
                    wavelength: this.wavelength
                };
                result = this.traceRayToEval(initialRay, 1.0);
            }
        } else if (!result && fastSolve && hadStopHit) {
            if (prof2 && prof2.enabled) {
                prof2.finiteDirectionSolveSkippedDueToStopHit = (prof2.finiteDirectionSolveSkippedDueToStopHit || 0) + 1;
            }
        }
        if (isChiefRay) {
            console.log(`🔍 主光線traceRay結果（有限系）: 長さ=${result ? result.length : 'null'}`);
        }
        
        if (!result) {
            if (OPD_DEBUG) console.warn(`❌ 有限系光線追跡失敗: pupilX=${pupilX}, pupilY=${pupilY}`);
            if (!this._lastMarginalRayGenFailure) {
                this._lastMarginalRayGenFailure = 'finite: trace to eval failed';
            }
        }
        return result;
    }

    /**
     * 無限系の周辺光線生成（クロスビーム対応）
     * @param {number} pupilX - 瞳座標X
     * @param {number} pupilY - 瞳座標Y
     * @param {Object} fieldSetting - フィールド設定
     * @returns {Object} 周辺光線データ
     */
    generateInfiniteMarginalRay(pupilX, pupilY, fieldSetting, options = undefined) {
        const fastSolve = !!(options && (options.fastMarginalRay || options.fastSolve));
        const relaxStopMissTol = !!(options && options.relaxStopMissTol);
        const forcedMode = (this._getForcedInfinitePupilMode)
            ? this._getForcedInfinitePupilMode()
            : null;
        const isForcedStop = forcedMode === 'stop';
        const canForcedStopSlowRetry = isForcedStop && fastSolve && !(options && options._forceStopSlowRetry);
        // 🔍 端点での詳細ログ
        const inputPupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
        const isEdgePoint = inputPupilRadius > 0.95; // 端点または外縁部
        const shouldLogDetail = OPD_DEBUG && (isEdgePoint || (Math.abs(pupilX) > 0.5 || Math.abs(pupilY) > 0.5));
        
        // 🔍 DEBUG: Function entry log (only for first few calls)
        const isNearCenter = Math.abs(pupilX) < 0.1 && Math.abs(pupilY) < 0.1;
        const isEdge = inputPupilRadius > 0.9;
        
        // Limit debug output to first 5 rays only
        const debugCallCount = (this._debugMarginalCallCount || 0);
        if (debugCallCount < 5 && (isNearCenter || isEdge)) {
            console.log(`🚀 [generateInfiniteMarginalRay] ENTRY: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}), radius=${inputPupilRadius.toFixed(3)}`);
            this._debugMarginalCallCount = debugCallCount + 1;
        }
        
        if (OPD_DEBUG && isEdgePoint) {
            console.log(`🎯 [端点光線] pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}) 半径=${inputPupilRadius.toFixed(3)} - Brent法最適化開始`);
        }
        
        // 無限系の入射方向は「画角」から決める（物体空間の平行光線方向）。
        // traced chief ray から方向を推定すると屈折後方向を拾ってしまい、
        // 大画角で全点が失敗する原因になりうるため、常に画角ベースを使用する。
        const angleXr = (fieldSetting.fieldAngle?.x || 0) * Math.PI / 180;
        const angleYr = (fieldSetting.fieldAngle?.y || 0) * Math.PI / 180;
        const cosXr = Math.cos(angleXr);
        const cosYr = Math.cos(angleYr);
        const sinXr = Math.sin(angleXr);
        const sinYr = Math.sin(angleYr);

        const chiefDirection = {
            x: sinXr * cosYr,
            y: sinYr * cosXr,
            z: cosXr * cosYr
        };

        const mag = Math.hypot(chiefDirection.x, chiefDirection.y, chiefDirection.z) || 1;
        chiefDirection.x /= mag;
        chiefDirection.y /= mag;
        chiefDirection.z /= mag;

        // 周辺光線の方向は主光線方向と同じ（平行光線系）
        const direction = chiefDirection;

        // Best-effort vignetted pupil mode: sample the pupil on an entrance plane and accept that
        // many rays may be blocked (vignetting). This mode does NOT enforce a stop hit.
        const pupilMode = this._getInfinitePupilMode(fieldSetting);
        if (pupilMode === 'entrance') {
            const cfg = this._getOrBuildEntrancePupilConfig(fieldSetting, direction, options);
            if (!cfg) {
                if (!this._lastMarginalRayGenFailure) {
                    this._lastMarginalRayGenFailure = 'infinite: entrance pupil config unavailable';
                }
                return null;
            }

            // IMPORTANT (fair comparison across fields):
            // In entrance mode, the engine can estimate a small effective entrance radius (cfg.radius)
            // under strong vignetting. If we scale the unit pupil by cfg.radius, the whole unit disk
            // becomes “valid” and PSF/spot comparisons become unfair (NA effectively changes).
            // When options.pupilScaleRadiusMm is provided, we instead keep a fixed physical scaling
            // (typically the designed stop radius) and let unreachable rays be masked as invalid.
            const requestedScale = Number(options?.pupilScaleRadiusMm);
            const scaleRadiusMm = (Number.isFinite(requestedScale) && requestedScale > 0)
                ? requestedScale
                : Number(cfg.radius);

            // Degenerate entrance pupil safeguard only applies when we're using cfg.radius scaling.
            // If we intentionally use a fixed (larger) scaleRadiusMm, we must allow rays to fail
            // naturally and be masked.
            const isUsingCfgRadius = !(Number.isFinite(requestedScale) && requestedScale > 0);
            if (isUsingCfgRadius) {
                const cfgRadius = Number(cfg.radius);
                const isChief = (Math.abs(pupilX) < 1e-12 && Math.abs(pupilY) < 1e-12);
                if (!(Number.isFinite(cfgRadius) && cfgRadius > 1e-9) && !isChief) {
                    if (!this._lastMarginalRayGenFailure) {
                        this._lastMarginalRayGenFailure = `infinite: entrance pupil degenerate (radius=${Number.isFinite(cfgRadius) ? cfgRadius.toFixed(6) : String(cfgRadius)})`;
                    }
                    return null;
                }
            }

            const origin = this.addVec(
                cfg.centerOrigin,
                this.addVec(
                    this.scaleVec(cfg.ex, pupilX * scaleRadiusMm),
                    this.scaleVec(cfg.ey, pupilY * scaleRadiusMm)
                )
            );
            this._lastMarginalRayOriginGeom = { x: origin.x, y: origin.y, z: origin.z };
            const initialRay = { pos: origin, dir: direction, wavelength: this.wavelength };
            const toEval = this.traceRayToEval(initialRay, 1.0);
            if (!toEval) {
                if (!this._lastMarginalRayGenFailure) {
                    this._lastMarginalRayGenFailure = 'infinite: trace to eval failed (entrance pupil)';
                }
                return null;
            }
            return toEval;
        }

        // Stop geometry (cached)
        // stopCenterBase: nominal stop origin from calculateSurfaceOrigins() (no per-field override)
        // stopCenter: effective stop origin (may be overridden for vignetted off-axis fields)
        const stopCenterBase = this.getSurfaceOrigin(this.stopSurfaceIndex);
        // IMPORTANT: Coord Break can decenter/tilt the stop. For OPD to remain consistent with
        // rendering and other evaluators, pupil sampling must use the actual stop origin from
        // calculateSurfaceOrigins() (and a per-field override if the nominal center is vignetted).
        const stopCenter = this.getEffectiveStopCenter(fieldSetting);
        
        const stopZ = stopCenter.z;
        const stopRadius = this._getCachedStopRadiusMm();

        // 目標とする絞り面交点（Stop中心＋瞳座標×絞り半径）
        // 主光線交点の推定（pathからの抽出）は画角が大きいと誤マッピングになり得るため、
        // ここでは常に stopCenter を基準にする。
        const axes = this.getSurfaceAxes(this.stopSurfaceIndex);
        const desiredOffset = this.addVec(
            this.scaleVec(axes.ex, pupilX * stopRadius),
            this.scaleVec(axes.ey, pupilY * stopRadius)
        );
        const desiredStop = this.addVec(stopCenter, desiredOffset);
        const desiredLocalX = pupilX * stopRadius;
        const desiredLocalY = pupilY * stopRadius;
        
        // PERF NOTE:
        // Newton-Primary (Newton first for *all* rays) is extremely expensive because each Newton
        // iteration triggers multiple traceRay() calls (ray + Jacobian). This can dominate runtime.
        // Default is OFF; opt-in with globalThis.__COOPT_WAVEFRONT_NEWTON_PRIMARY = true.
        const __g = (typeof globalThis !== 'undefined') ? globalThis : null;
        const __useNewtonPrimary = !!(__g && __g.__COOPT_WAVEFRONT_NEWTON_PRIMARY) || !!(options && options._forceNewtonPrimaryForFallback);
        const referenceRay = this.referenceChiefRay;
        
        if (__useNewtonPrimary && referenceRay && referenceRay.length > 0) {
            const debugCallCount = (this._debugMarginalCallCount || 0);
            const shouldLog = debugCallCount < 5 && (isNearCenter || isEdge);
            
            if (OPD_DEBUG && shouldLog) {
                console.log(`🎯 [Newton-Primary] pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}) using Newton method...`);
            }
            
            const chiefRayOrigin = {
                x: referenceRay[0].x,
                y: referenceRay[0].y,
                z: referenceRay[0].z
            };
            const targetStopPoint = desiredStop;
            
            const newtonResult = calculateApertureRayNewton(
                chiefRayOrigin,
                direction,
                targetStopPoint,
                this.stopSurfaceIndex,
                this.opticalSystemRows,
                25,
                1e-5,
                this.wavelength,
                false
            );
            
            if (OPD_DEBUG && shouldLog) {
                console.log(`🔍 [Newton-Primary-Result] success=${newtonResult?.success || false}, iterations=${newtonResult?.iterations || 'N/A'}`);
            }
            
            if (newtonResult && newtonResult.success) {
                const optimizedOrigin = newtonResult.origin;
                const initialRay = {
                    pos: optimizedOrigin,
                    dir: direction,
                    wavelength: this.wavelength
                };
                
                const toEval = this.traceRayToEval(initialRay, 1.0);
                
                if (toEval) {
                    this._lastMarginalRayOriginGeom = { x: optimizedOrigin.x, y: optimizedOrigin.y, z: optimizedOrigin.z };
                    return toEval;
                } else if (OPD_DEBUG && shouldLog) {
                    console.warn(`⚠️ [Newton-Primary-Trace-Failed] pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)})`);
                }
            }
            // Fall through to geometric method if Newton fails
        }
        
        const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

        const evalOriginStopError = (origin) => {
            const ray = {
                pos: origin,
                dir: direction,
                wavelength: this.wavelength
            };

            const toStop = this.traceRayToSurface(ray, this.stopSurfaceIndex, 1.0);
            const actualStop = this.getStopPointFromRayData(toStop);
            if (!actualStop) return { ok: false, errMag: Infinity };

            const d = {
                x: actualStop.x - stopCenter.x,
                y: actualStop.y - stopCenter.y,
                z: actualStop.z - stopCenter.z
            };
            const actualLocalX = dot(d, axes.ex);
            const actualLocalY = dot(d, axes.ey);
            const errLX = actualLocalX - desiredLocalX;
            const errLY = actualLocalY - desiredLocalY;
            const errMag = Math.hypot(errLX, errLY);
            return { ok: true, errMag, errLX, errLY, actualLocalX, actualLocalY };
        };

        // まずは幾何学的に「絞り面の目標点」を狙う初期原点を作る（高速・連続）
        // NOTE: 無限系で backDistance が大きすぎると、原点が大きくオフ軸になり
        // 先頭面でクリップ→stop unreachable になりやすい。
        const entranceRadius = this._getCachedEntranceRadiusMm();

        const zDegenerate = Math.abs(direction.z) <= 1e-12;
        const safeZ = !zDegenerate ? direction.z : (direction.z >= 0 ? 1e-12 : -1e-12);
        const slope = Math.hypot(direction.x / safeZ, direction.y / safeZ);
        // IMPORTANT: The ray tracer assumes the ray starts in object space *before* the first
        // physical surface. If backDistance is reduced too much (auto), the origin can end up
        // inside the optical train and traceRayToSurface may terminate before reaching the stop.
        const firstSurfaceZ = this._getCachedFirstSurfaceZ();

        const maxLateralShift = Math.max(5, 0.6 * entranceRadius);
        const backDistanceTarget = (slope > 1e-9)
            ? Math.max(15, (maxLateralShift / slope))
            : 50;
        const backDistanceMin = Math.max(15, (desiredStop.z - (firstSurfaceZ - 10))); // 10mm margin
        const backDistance = Math.max(backDistanceTarget, backDistanceMin);
        const geomOrigin = {
            x: desiredStop.x - (direction.x / safeZ) * backDistance,
            y: desiredStop.y - (direction.y / safeZ) * backDistance,
            z: desiredStop.z - backDistance
        };

        // Record geometric origin for continuity diagnostics/seeding.
        this._lastMarginalRayOriginGeom = { x: geomOrigin.x, y: geomOrigin.y, z: geomOrigin.z };

        // Optional continuity delta hint(s): neighbor solutions are best transferred as a *delta* from the
        // geometric origin (geomOrigin + delta). Using absolute origins can jump across branches.
        let currentOrigin = { ...geomOrigin };
        try {
            const deltaList = [];
            const d1 = options?.originDeltaHint;
            const ds = Array.isArray(options?.originDeltaHints) ? options.originDeltaHints : null;
            if (ds) {
                for (const d of ds) deltaList.push(d);
            } else if (d1) {
                deltaList.push(d1);
            }

            if (fastSolve) {
                // In fast mode, do NOT spend extra traceRay calls to score multiple candidates.
                // Use the first plausible delta and let the main loop correct residual error.
                const d = deltaList.length ? deltaList[0] : null;
                if (d && Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.z)) {
                    const magD = Math.hypot(d.x, d.y, d.z);
                    const clamp = (Number.isFinite(magD) && magD > 50) ? (50 / magD) : 1.0;
                    currentOrigin = {
                        x: geomOrigin.x + d.x * clamp,
                        y: geomOrigin.y + d.y * clamp,
                        z: geomOrigin.z + d.z * clamp
                    };
                }
            } else {
                const eGeom = evalOriginStopError(geomOrigin);
                const threshold = (eGeom?.ok && Number.isFinite(eGeom.errMag))
                    ? Math.max(eGeom.errMag * 1.3, eGeom.errMag + 0.08)
                    : Infinity;

                let bestCand = null;
                let bestErr = Infinity;
                for (const d of deltaList) {
                    if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.y) || !Number.isFinite(d.z)) continue;
                    // Clamp absurd deltas (safety)
                    const magD = Math.hypot(d.x, d.y, d.z);
                    const clamp = (Number.isFinite(magD) && magD > 50) ? (50 / magD) : 1.0;
                    const cand = {
                        x: geomOrigin.x + d.x * clamp,
                        y: geomOrigin.y + d.y * clamp,
                        z: geomOrigin.z + d.z * clamp
                    };
                    const e = evalOriginStopError(cand);
                    if (!e?.ok || !Number.isFinite(e.errMag)) continue;
                    if (e.errMag <= threshold && e.errMag < bestErr) {
                        bestErr = e.errMag;
                        bestCand = cand;
                    }
                }
                if (bestCand) {
                    currentOrigin = bestCand;
                }
            }
        } catch (_) {}
        let currentRay = {
            pos: currentOrigin,
            dir: direction,
            wavelength: this.wavelength
        };

        // まずStop面まで到達させてから、Stop交点誤差を少数回だけ補正
        // fastSolve は dense な波面グリッド向け（traceRay 多発を抑える）。
        // 物理妥当性は最終的な stop-miss gate で担保する。
        // In fastSolve mode (used for dense wavefront grids), we aim for fewer iterations but we still
        // need to get reasonably close to the requested stop-local coordinate; otherwise everything gets
        // rejected by the stop-miss gate.
        // Fast solve is used for dense wavefront grids; keep it cheap.
        // We only need to get well within the stop-miss gate, not micro-optimize the stop hit.
        const tolerance = fastSolve ? 0.08 : 0.03; // mm
        const fieldAngleDeg = Math.hypot(fieldSetting?.fieldAngle?.x || 0, fieldSetting?.fieldAngle?.y || 0);
        // Stop-miss rejection threshold (stop-local mm).
        // Must be > tolerance; too large allows mis-registered rays (spikes), too small rejects valid rays.
        const stopMissTol = (() => {
            const base = fastSolve ? 0.12 : 0.10;
            const edgeBonus = (inputPupilRadius >= 0.9) ? 0.03 : 0.0;
            const angleBonus = (fieldAngleDeg >= 10.0) ? 0.05 : ((fieldAngleDeg >= 2.0) ? 0.02 : 0.0);
            const v = base + edgeBonus + angleBonus;
            return Math.max(0.06, Math.min(0.25, v));
        })();
        // Hard cap for the dense-grid path: each iteration is a full trace to the stop.
        // Continuity seeding (originDeltaHints) should make 1-3 iterations sufficient.
        const fastMaxItersOpt = Number(options?.fastMaxIterations);
        const maxIterations = fastSolve
            ? (() => {
                const base = ((inputPupilRadius >= 0.9 || fieldAngleDeg >= 2.0) ? 6 : 5);
                if (Number.isFinite(fastMaxItersOpt) && fastMaxItersOpt > 0) {
                    return Math.max(base, Math.min(12, Math.floor(fastMaxItersOpt)));
                }
                return base;
            })()
            : ((inputPupilRadius >= 0.9 || fieldAngleDeg >= 2.0) ? 20 : 10);
        const correctionFactor = 0.7;
        const maxStep = Math.max(0.5, stopRadius * ((inputPupilRadius >= 0.9) ? 0.18 : 0.12)); // mm, clamp to avoid overshoot into blocked regions

        const applyOriginStep = (origin, stepLocalX, stepLocalY, scale = 1.0) => {
            // stepLocalX/stepLocalY are in stop-local mm. Convert to global vector using stop axes.
            const stepVec = this.addVec(this.scaleVec(axes.ex, stepLocalX * scale), this.scaleVec(axes.ey, stepLocalY * scale));
            const stepMag = Math.hypot(stepVec.x, stepVec.y, stepVec.z);
            const clampScale = (Number.isFinite(stepMag) && stepMag > maxStep) ? (maxStep / stepMag) : 1.0;
            return {
                x: origin.x - stepVec.x * clampScale,
                y: origin.y - stepVec.y * clampScale,
                z: origin.z - stepVec.z * clampScale
            };
        };

        // evalOriginStopError is defined above (needed for origin-hint seeding)

        let bestOrigin = { ...currentOrigin };
        let bestErr = Infinity;
        let bestEval = null;
        let hadStopHit = false;
        let lastEval = null;
        let _fastUnreachableResetTried = false;
        let _fastUnreachableBackBoostTried = false;
        // In fast mode, accept a solution once it's safely inside the stop-miss gate.
        // This avoids extra traceRayToSurface calls that don't materially affect OPD quality.
        const fastAcceptErr = fastSolve ? Math.max(tolerance, stopMissTol * 0.65) : NaN;

        for (let iter = 0; iter < maxIterations; iter++) {
            const toStop = this.traceRayToSurface(currentRay, this.stopSurfaceIndex, 1.0);
            const actualStop = this.getStopPointFromRayData(toStop);
            if (!actualStop) {
                // FastSolve robustness: continuity hints can occasionally place the origin inside the
                // optical train or into a vignetted region, causing an immediate "stop unreachable".
                // Before giving up (and triggering an expensive slow retry), try falling back to the
                // geometric origin once.
                if (fastSolve && !hadStopHit) {
                    const prof2 = this._wavefrontProfile;
                    if (!_fastUnreachableResetTried) {
                        _fastUnreachableResetTried = true;
                        if (prof2 && prof2.enabled) {
                            prof2.infiniteFastUnreachableReset = (prof2.infiniteFastUnreachableReset || 0) + 1;
                        }
                        currentOrigin = { ...geomOrigin };
                        currentRay = { pos: currentOrigin, dir: direction, wavelength: this.wavelength };
                        continue;
                    }
                    if (!_fastUnreachableBackBoostTried) {
                        _fastUnreachableBackBoostTried = true;
                        if (prof2 && prof2.enabled) {
                            prof2.infiniteFastUnreachableBackBoost = (prof2.infiniteFastUnreachableBackBoost || 0) + 1;
                        }
                        const extraBack = Math.min(200, Math.max(40, backDistance * 0.5));
                        currentOrigin = {
                            x: geomOrigin.x - direction.x * extraBack,
                            y: geomOrigin.y - direction.y * extraBack,
                            z: geomOrigin.z - direction.z * extraBack
                        };
                        currentRay = { pos: currentOrigin, dir: direction, wavelength: this.wavelength };
                        continue;
                    }
                }

                // If this is the reference-ray setup at pupil center, the nominal stop center may be vignetted.
                // Try to find a reachable stop point near the center and treat it as the effective stop center.
                const inputPupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
                const canSearchStopCenter = !!(options && options.isReferenceRay) && inputPupilRadius < 1e-9 && !options._noStopCenterSearch;
                if (canSearchStopCenter) {
                    try {
                        const key = this._getStopCenterOverrideKey(fieldSetting);
                        const hasOverride = this._stopCenterOverrideCache?.has(key);
                        if (!hasOverride) {
                            const found = this._tryFindReachableStopCenterForInfiniteField(
                                fieldSetting,
                                direction,
                                safeZ,
                                firstSurfaceZ,
                                entranceRadius,
                                stopCenterBase,
                                axes,
                                stopRadius,
                                backDistance
                            );
                            if (found) {
                                this._setStopCenterOverride(fieldSetting, found);
                                this._lastMarginalRayGenFailure = null;
                                return this.generateInfiniteMarginalRay(pupilX, pupilY, fieldSetting, { ...(options || {}), _noStopCenterSearch: true });
                            }
                        }
                    } catch (_) {
                        // fall through
                    }
                }

                // If we already had a valid stop hit in an earlier iteration, keep the best ray so far.
                // Hard-failing here can create isolated missing cells and visible roughness.
                if (hadStopHit) {
                    currentOrigin = { ...bestOrigin };
                    currentRay = { pos: currentOrigin, dir: direction, wavelength: this.wavelength };
                    break;
                }

                if (OPD_DEBUG && inputPupilRadius <= 1.0 && iter === 0) {
                    console.warn(`⚠️ Stop面まで到達できません（瞳内）: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)})`);
                }
                if (!this._lastMarginalRayGenFailure) {
                    this._lastMarginalRayGenFailure = zDegenerate
                        ? 'infinite: stop unreachable (direction.z≈0)'
                        : (!actualStop ? 'infinite: stop unreachable (terminated before stop)' : 'infinite: stop unreachable');
                }
                if (canForcedStopSlowRetry) {
                    const profRetry = this._wavefrontProfile;
                    if (profRetry && profRetry.enabled) {
                        profRetry.infiniteForcedStopSlowRetry = (profRetry.infiniteForcedStopSlowRetry || 0) + 1;
                    }
                    return this.generateInfiniteMarginalRay(pupilX, pupilY, fieldSetting, {
                        ...(options || {}),
                        fastMarginalRay: false,
                        fastSolve: false,
                        _forceStopSlowRetry: true,
                        _forceNewtonPrimaryForFallback: true
                    });
                }
                return null;
            }
            hadStopHit = true;

            const d = { x: actualStop.x - stopCenter.x, y: actualStop.y - stopCenter.y, z: actualStop.z - stopCenter.z };
            const actualLocalX = dot(d, axes.ex);
            const actualLocalY = dot(d, axes.ey);
            const errLX = actualLocalX - desiredLocalX;
            const errLY = actualLocalY - desiredLocalY;
            const errMag = Math.hypot(errLX, errLY);

            lastEval = { ok: true, errMag, errLX, errLY, actualLocalX, actualLocalY };

            if (Number.isFinite(errMag) && errMag < bestErr) {
                bestErr = errMag;
                bestOrigin = { ...currentOrigin };
                bestEval = lastEval;
            }
            if (errMag <= tolerance) break;
            if (fastSolve && errMag <= fastAcceptErr) break;

            // For stubborn edge points, use a small numeric Jacobian in stop-local coordinates.
            // This significantly reduces large stopLocal errors that can cause OPD outliers.
            const useJacobian = !fastSolve && (inputPupilRadius >= 0.85 && errMag > 0.06);
            if (useJacobian) {
                const delta = Math.max(0.3, stopRadius * 0.02); // mm

                // Prefer central differences for numerical stability.
                const originExP = { x: currentOrigin.x + axes.ex.x * delta, y: currentOrigin.y + axes.ex.y * delta, z: currentOrigin.z + axes.ex.z * delta };
                const originExM = { x: currentOrigin.x - axes.ex.x * delta, y: currentOrigin.y - axes.ex.y * delta, z: currentOrigin.z - axes.ex.z * delta };
                const originEyP = { x: currentOrigin.x + axes.ey.x * delta, y: currentOrigin.y + axes.ey.y * delta, z: currentOrigin.z + axes.ey.z * delta };
                const originEyM = { x: currentOrigin.x - axes.ey.x * delta, y: currentOrigin.y - axes.ey.y * delta, z: currentOrigin.z - axes.ey.z * delta };

                const stopExP = this.getStopPointFromRayData(this.traceRayToSurface({ pos: originExP, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));
                const stopExM = this.getStopPointFromRayData(this.traceRayToSurface({ pos: originExM, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));
                const stopEyP = this.getStopPointFromRayData(this.traceRayToSurface({ pos: originEyP, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));
                const stopEyM = this.getStopPointFromRayData(this.traceRayToSurface({ pos: originEyM, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));

                const hasCentral = !!(stopExP && stopExM && stopEyP && stopEyM);

                const stopEx = hasCentral ? null : this.getStopPointFromRayData(this.traceRayToSurface({ pos: originExP, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));
                const stopEy = hasCentral ? null : this.getStopPointFromRayData(this.traceRayToSurface({ pos: originEyP, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));

                if (hasCentral || (stopEx && stopEy)) {
                    let j11, j21, j12, j22;
                    if (hasCentral) {
                        const dExP = { x: stopExP.x - stopCenter.x, y: stopExP.y - stopCenter.y, z: stopExP.z - stopCenter.z };
                        const dExM = { x: stopExM.x - stopCenter.x, y: stopExM.y - stopCenter.y, z: stopExM.z - stopCenter.z };
                        const dEyP = { x: stopEyP.x - stopCenter.x, y: stopEyP.y - stopCenter.y, z: stopEyP.z - stopCenter.z };
                        const dEyM = { x: stopEyM.x - stopCenter.x, y: stopEyM.y - stopCenter.y, z: stopEyM.z - stopCenter.z };
                        const exPLocalX = dot(dExP, axes.ex);
                        const exPLocalY = dot(dExP, axes.ey);
                        const exMLocalX = dot(dExM, axes.ex);
                        const exMLocalY = dot(dExM, axes.ey);
                        const eyPLocalX = dot(dEyP, axes.ex);
                        const eyPLocalY = dot(dEyP, axes.ey);
                        const eyMLocalX = dot(dEyM, axes.ex);
                        const eyMLocalY = dot(dEyM, axes.ey);
                        // J = d(actualLocal)/d(originLocal) approx (central)
                        j11 = (exPLocalX - exMLocalX) / (2 * delta);
                        j21 = (exPLocalY - exMLocalY) / (2 * delta);
                        j12 = (eyPLocalX - eyMLocalX) / (2 * delta);
                        j22 = (eyPLocalY - eyMLocalY) / (2 * delta);
                    } else {
                        const dEx = { x: stopEx.x - stopCenter.x, y: stopEx.y - stopCenter.y, z: stopEx.z - stopCenter.z };
                        const dEy = { x: stopEy.x - stopCenter.x, y: stopEy.y - stopCenter.y, z: stopEy.z - stopCenter.z };
                        const exLocalX = dot(dEx, axes.ex);
                        const exLocalY = dot(dEx, axes.ey);
                        const eyLocalX = dot(dEy, axes.ex);
                        const eyLocalY = dot(dEy, axes.ey);
                        // J = d(actualLocal)/d(originLocal) approx (forward)
                        j11 = (exLocalX - actualLocalX) / delta;
                        j21 = (exLocalY - actualLocalY) / delta;
                        j12 = (eyLocalX - actualLocalX) / delta;
                        j22 = (eyLocalY - actualLocalY) / delta;
                    }

                    // Damped least-squares step: step = (J^T J + λI)^{-1} J^T err
                    const lambda = 1e-3;
                    const m11 = j11 * j11 + j21 * j21 + lambda;
                    const m12 = j11 * j12 + j21 * j22;
                    const m22 = j12 * j12 + j22 * j22 + lambda;
                    const b1 = j11 * errLX + j21 * errLY;
                    const b2 = j12 * errLX + j22 * errLY;
                    const det = m11 * m22 - m12 * m12;

                    if (Number.isFinite(det) && Math.abs(det) > 1e-12) {
                        const stepLocalX = (b1 * m22 - b2 * m12) / det;
                        const stepLocalY = (b2 * m11 - b1 * m12) / det;

                        // Backtracking line search: accept any improvement (avoid stagnation near the threshold).
                        const scales = [1.0, 0.7, 0.5, 0.3, 0.15];
                        let chosenOrigin = null;
                        let chosenErr = errMag;
                        for (const s of scales) {
                            const candOrigin = applyOriginStep(currentOrigin, stepLocalX, stepLocalY, s);
                            const evalRes = evalOriginStopError(candOrigin);
                            if (evalRes.ok && Number.isFinite(evalRes.errMag) && evalRes.errMag < chosenErr) {
                                chosenErr = evalRes.errMag;
                                chosenOrigin = candOrigin;
                                break;
                            }
                        }
                        if (chosenOrigin) {
                            currentOrigin = chosenOrigin;
                        } else {
                            // fallback to simple update when Jacobian step doesn't improve
                            currentOrigin = applyOriginStep(currentOrigin, errLX, errLY, correctionFactor);
                        }
                    } else {
                        // fallback to simple update
                        currentOrigin = applyOriginStep(currentOrigin, errLX, errLY, correctionFactor);
                    }
                } else {
                    // fallback to simple update
                    currentOrigin = applyOriginStep(currentOrigin, errLX, errLY, correctionFactor);
                }
            } else {
                // Simple local-coordinate update
                currentOrigin = applyOriginStep(currentOrigin, errLX, errLY, correctionFactor);
            }
            currentRay = {
                pos: currentOrigin,
                dir: direction,
                wavelength: this.wavelength
            };
        }

        // Prefer the best (smallest stop-local error) origin if we found one.
        if (hadStopHit && Number.isFinite(bestErr) && bestErr < Infinity) {
            currentOrigin = { ...bestOrigin };
            currentRay = { pos: currentOrigin, dir: direction, wavelength: this.wavelength };
        }

        // If we ended up close to the stop-miss rejection threshold but not within the internal tight tolerance,
        // run a small "polish" phase with smaller finite-difference steps.
        // This helps remove remaining sharp edges caused by tiny pupil→stop misregistration near the rim.
        if (!fastSolve && hadStopHit && inputPupilRadius >= 0.75) {
            const initial = evalOriginStopError(currentOrigin);
            const nearThreshold = initial?.ok && Number.isFinite(initial.errMag) && initial.errMag > tolerance && initial.errMag > 0.5 * stopMissTol;
            if (nearThreshold) {
                const polishFrom = (startOrigin) => {
                    let origin = { ...startOrigin };
                    const startEval = evalOriginStopError(origin);
                    let bestO = { ...origin };
                    let bestE = (startEval?.ok && Number.isFinite(startEval.errMag)) ? startEval.errMag : Infinity;

                    let delta = Math.max(0.06, stopRadius * 0.006); // mm (smaller than main loop)
                    const polishIters = 12;
                    for (let k = 0; k < polishIters; k++) {
                        const r0 = evalOriginStopError(origin);
                        if (!r0?.ok || !Number.isFinite(r0.errMag)) break;
                        if (r0.errMag < bestE) {
                            bestE = r0.errMag;
                            bestO = { ...origin };
                        }
                        if (r0.errMag <= tolerance) break;

                        // Try a Jacobian-based step using central differences.
                        const originExP = { x: origin.x + axes.ex.x * delta, y: origin.y + axes.ex.y * delta, z: origin.z + axes.ex.z * delta };
                        const originExM = { x: origin.x - axes.ex.x * delta, y: origin.y - axes.ex.y * delta, z: origin.z - axes.ex.z * delta };
                        const originEyP = { x: origin.x + axes.ey.x * delta, y: origin.y + axes.ey.y * delta, z: origin.z + axes.ey.z * delta };
                        const originEyM = { x: origin.x - axes.ey.x * delta, y: origin.y - axes.ey.y * delta, z: origin.z - axes.ey.z * delta };

                        const stopExP = this.getStopPointFromRayData(this.traceRayToSurface({ pos: originExP, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));
                        const stopExM = this.getStopPointFromRayData(this.traceRayToSurface({ pos: originExM, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));
                        const stopEyP = this.getStopPointFromRayData(this.traceRayToSurface({ pos: originEyP, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));
                        const stopEyM = this.getStopPointFromRayData(this.traceRayToSurface({ pos: originEyM, dir: direction, wavelength: this.wavelength }, this.stopSurfaceIndex, 1.0));

                        if (!(stopExP && stopExM && stopEyP && stopEyM)) {
                            // If the neighborhood is non-smooth (vignetting/termination), shrink delta and fall back.
                            delta = Math.max(0.03, delta * 0.6);
                            origin = applyOriginStep(origin, r0.errLX, r0.errLY, 0.8);
                            continue;
                        }

                        const dExP = { x: stopExP.x - stopCenter.x, y: stopExP.y - stopCenter.y, z: stopExP.z - stopCenter.z };
                        const dExM = { x: stopExM.x - stopCenter.x, y: stopExM.y - stopCenter.y, z: stopExM.z - stopCenter.z };
                        const dEyP = { x: stopEyP.x - stopCenter.x, y: stopEyP.y - stopCenter.y, z: stopEyP.z - stopCenter.z };
                        const dEyM = { x: stopEyM.x - stopCenter.x, y: stopEyM.y - stopCenter.y, z: stopEyM.z - stopCenter.z };

                        const exPLocalX = dot(dExP, axes.ex);
                        const exPLocalY = dot(dExP, axes.ey);
                        const exMLocalX = dot(dExM, axes.ex);
                        const exMLocalY = dot(dExM, axes.ey);
                        const eyPLocalX = dot(dEyP, axes.ex);
                        const eyPLocalY = dot(dEyP, axes.ey);
                        const eyMLocalX = dot(dEyM, axes.ex);
                        const eyMLocalY = dot(dEyM, axes.ey);

                        const j11 = (exPLocalX - exMLocalX) / (2 * delta);
                        const j21 = (exPLocalY - exMLocalY) / (2 * delta);
                        const j12 = (eyPLocalX - eyMLocalX) / (2 * delta);
                        const j22 = (eyPLocalY - eyMLocalY) / (2 * delta);

                        const lambda = 1e-3;
                        const m11 = j11 * j11 + j21 * j21 + lambda;
                        const m12 = j11 * j12 + j21 * j22;
                        const m22 = j12 * j12 + j22 * j22 + lambda;
                        const b1 = j11 * r0.errLX + j21 * r0.errLY;
                        const b2 = j12 * r0.errLX + j22 * r0.errLY;
                        const det = m11 * m22 - m12 * m12;

                        if (!Number.isFinite(det) || Math.abs(det) <= 1e-12) {
                            origin = applyOriginStep(origin, r0.errLX, r0.errLY, 0.8);
                            continue;
                        }

                        const stepLocalX = (b1 * m22 - b2 * m12) / det;
                        const stepLocalY = (b2 * m11 - b1 * m12) / det;

                        const scales = [1.0, 0.8, 0.6, 0.4, 0.25, 0.15, 0.08];
                        let chosen = null;
                        let chosenErr = r0.errMag;
                        for (const s of scales) {
                            const cand = applyOriginStep(origin, stepLocalX, stepLocalY, s);
                            const rr = evalOriginStopError(cand);
                            if (rr?.ok && Number.isFinite(rr.errMag) && rr.errMag < chosenErr) {
                                chosenErr = rr.errMag;
                                chosen = cand;
                            }
                        }

                        origin = chosen ? chosen : applyOriginStep(origin, r0.errLX, r0.errLY, 0.8);
                        delta = Math.max(0.03, delta * 0.85);
                    }
                    return { origin: bestO, err: bestE };
                };

                // First try polishing from the current best.
                let best = polishFrom(currentOrigin);

                // If still far from the internal tolerance but within stopMissTol, multi-start around the best origin
                // to jump between possible stop-intersection branches.
                if (Number.isFinite(best.err) && best.err > tolerance && best.err < stopMissTol) {
                    const d = Math.min(2.0, Math.max(0.6, stopRadius * 0.035)); // mm local offset
                    const offsets = [
                        [d, 0], [-d, 0], [0, d], [0, -d],
                        [d, d], [d, -d], [-d, d], [-d, -d]
                    ];
                    for (const [ox, oy] of offsets) {
                        const cand0 = {
                            x: best.origin.x + axes.ex.x * ox + axes.ey.x * oy,
                            y: best.origin.y + axes.ex.y * ox + axes.ey.y * oy,
                            z: best.origin.z + axes.ex.z * ox + axes.ey.z * oy
                        };
                        const e0 = evalOriginStopError(cand0);
                        if (!e0?.ok || !Number.isFinite(e0.errMag)) continue;
                        const cand = polishFrom(cand0);
                        if (Number.isFinite(cand.err) && cand.err < best.err) best = cand;
                        if (best.err <= tolerance) break;
                    }
                }

                currentOrigin = { ...best.origin };
                currentRay = { pos: currentOrigin, dir: direction, wavelength: this.wavelength };
            }
        }

        // fastSolve: intentionally avoid any extra refinement passes.
        // The wavefront map uses a dense grid and relies on continuity seeding; extra 2-trace “salvage”
        // hurts performance disproportionately.

        // Stop-hit residual check (stop-local). Large residual means this ray does NOT correspond
        // to the requested pupil coordinate and can produce isolated spikes.
        // On fastSolve (dense wavefront grids), avoid an extra trace by reusing the last/best
        // evaluation from the main iteration loop.
        const prof2 = this._wavefrontProfile;
        const finalStopReuse = fastSolve ? (lastEval || bestEval) : null;
        let finalStop = finalStopReuse;
        if (finalStopReuse) {
            if (prof2 && prof2.enabled) {
                prof2.finalStopReuseCount = (prof2.finalStopReuseCount || 0) + 1;
            }
        } else {
            if (prof2 && prof2.enabled) {
                prof2.finalStopFallbackCount = (prof2.finalStopFallbackCount || 0) + 1;
            }
            finalStop = evalOriginStopError(currentOrigin);
        }
        if (finalStop && finalStop.ok && Number.isFinite(finalStop.errMag)) {
            this._lastStopHitInfo = {
                errMm: finalStop.errMag,
                desiredLocalXmm: desiredLocalX,
                desiredLocalYmm: desiredLocalY,
                actualLocalXmm: finalStop.actualLocalX,
                actualLocalYmm: finalStop.actualLocalY,
                pupilX,
                pupilY
            };
        }

        // Record the final origin used (for continuity hints in wavefront grid evaluation)
        if (Number.isFinite(currentOrigin?.x) && Number.isFinite(currentOrigin?.y) && Number.isFinite(currentOrigin?.z)) {
            this._lastMarginalRayOrigin = { x: currentOrigin.x, y: currentOrigin.y, z: currentOrigin.z };
            if (this._lastMarginalRayOriginGeom && Number.isFinite(this._lastMarginalRayOriginGeom.x)) {
                this._lastMarginalRayOriginDelta = {
                    x: currentOrigin.x - this._lastMarginalRayOriginGeom.x,
                    y: currentOrigin.y - this._lastMarginalRayOriginGeom.y,
                    z: currentOrigin.z - this._lastMarginalRayOriginGeom.z
                };
            }
        }

        if (!relaxStopMissTol && inputPupilRadius <= 1.0 + 1e-9 && finalStop && finalStop.ok && Number.isFinite(finalStop.errMag) && finalStop.errMag > stopMissTol) {
            if (!this._lastMarginalRayGenFailure) {
                this._lastMarginalRayGenFailure = `infinite: stop miss (${finalStop.errMag.toFixed(3)}mm > ${stopMissTol.toFixed(3)}mm)`;
            }
            if (canForcedStopSlowRetry) {
                const profRetry = this._wavefrontProfile;
                if (profRetry && profRetry.enabled) {
                    profRetry.infiniteForcedStopSlowRetry = (profRetry.infiniteForcedStopSlowRetry || 0) + 1;
                }
                return this.generateInfiniteMarginalRay(pupilX, pupilY, fieldSetting, {
                    ...(options || {}),
                    fastMarginalRay: false,
                    fastSolve: false,
                    _forceStopSlowRetry: true,
                    _forceNewtonPrimaryForFallback: true
                });
            }
            return null;
        }

        // 最終的に評価面まで追跡
        const rayResult = this.traceRayToEval(currentRay, 1.0);
        if (!rayResult || !Array.isArray(rayResult) || rayResult.length <= 1) {
            // Newton法を最初から使っているので、ここでのフォールバックは不要
            // 失敗した場合は単に終了
            if (OPD_DEBUG && inputPupilRadius <= 1.0) {
                console.warn(`⚠️ 光線追跡失敗（瞳内）: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)})`);
            }
            if (!this._lastMarginalRayGenFailure) {
                this._lastMarginalRayGenFailure = zDegenerate
                    ? 'infinite: eval unreachable (direction.z≈0)'
                    : 'infinite: eval unreachable';
            }
            if (canForcedStopSlowRetry) {
                const profRetry = this._wavefrontProfile;
                if (profRetry && profRetry.enabled) {
                    profRetry.infiniteForcedStopSlowRetry = (profRetry.infiniteForcedStopSlowRetry || 0) + 1;
                }
                return this.generateInfiniteMarginalRay(pupilX, pupilY, fieldSetting, {
                    ...(options || {}),
                    fastMarginalRay: false,
                    fastSolve: false,
                    _forceStopSlowRetry: true,
                    _forceNewtonPrimaryForFallback: true
                });
            }
            return null;
        }

        return rayResult;
    }

    /**
     * クロスビーム原点を生成（Brent法使用）
     * @param {number} pupilX - 瞳座標X
     * @param {number} pupilY - 瞳座標Y
     * @param {Object} fieldSetting - フィールド設定
     * @returns {Object} 光線原点座標
     */
    generateCrossBeamOrigin(pupilX, pupilY, fieldSetting) {
        // 主光線の絞り面交点を取得
        const chiefRayResult = this.generateChiefRay(fieldSetting);
        if (!chiefRayResult) {
            if (OPD_DEBUG) console.warn('❌ 主光線生成失敗');
            return null;
        }

        // 絞り面交点を取得（Object/CoordTrans を考慮したインデックス対応）
        const chiefStopPoint = this.getStopPointFromRayData(chiefRayResult);
        if (!chiefStopPoint) {
            // エラーログを削減（10回に1回のみ出力）
            if (Math.random() < 0.1) {
                console.warn(`❌ 主光線の絞り面交点が取得できません (stopSurfaceIndex=${this.stopSurfaceIndex})`);
            }
            return null;
        }
        
        // 絞り半径を取得（強化版 - 絞り端到達を保証 + エラーハンドリング）
        let stopRadius = 17.85; // デフォルト値
        
        if (this.opticalSystemRows && this.stopSurfaceIndex >= 0 && this.stopSurfaceIndex < this.opticalSystemRows.length) {
            const stopSurface = this.opticalSystemRows[this.stopSurfaceIndex];
            if (stopSurface) {
                const semidia = parseFloat(stopSurface.semidia || 0);
                const aperture = parseFloat(stopSurface.aperture || stopSurface.Aperture || 0);
                stopRadius = semidia > 0 ? semidia : (aperture > 0 ? aperture / 2 : 17.85);
            }
        }
        
        // 🆕 絞り端到達強化: 瞳座標1.0 = 絞り端に正確に到達（gen-ray-cross-infinite.js方式）
        const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
        
        // 絞り面上の目標位置（正確な絞り端到達）
        // pupilRadius = 1.0 の時に stopRadius に正確に到達
        const targetStopX = chiefStopPoint.x + pupilX * stopRadius;
        const targetStopY = chiefStopPoint.y + pupilY * stopRadius;
        
        if (OPD_DEBUG && pupilRadius > 0.95) {
            console.log(`🎯 [絞り端正確到達] pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}) radius=${pupilRadius.toFixed(3)} → target絞り位置(${targetStopX.toFixed(3)}, ${targetStopY.toFixed(3)}) 絞り端距離=${(pupilRadius * stopRadius).toFixed(3)}mm/${stopRadius.toFixed(3)}mm`);
        }

        // 主光線方向ベクトル
        const angleX = (fieldSetting.fieldAngle?.x || 0) * Math.PI / 180;
        const angleY = (fieldSetting.fieldAngle?.y || 0) * Math.PI / 180;
        
        const rayDirection = {
            x: Math.sin(angleX),
            y: Math.sin(angleY),
            z: Math.cos(angleX) * Math.cos(angleY)
        };

        // Brent法でX座標の原点を求める
        const findXOrigin = (x0) => {
            const z0 = chiefStopPoint.z - 1000; // 絞り面から1000mm手前
            const y0 = targetStopY - (rayDirection.y / rayDirection.z) * 1000;
            
            // この原点から光線を射出した時の絞り面X座標
            const stopX = x0 + rayDirection.x * 1000;
            return stopX - targetStopX;
        };

        // Brent法でY座標の原点を求める
        const findYOrigin = (y0) => {
            const z0 = chiefStopPoint.z - 1000; // 絞り面から1000mm手前
            const x0 = targetStopX - (rayDirection.x / rayDirection.z) * 1000;
            
            // この原点から光線を射出した時の絞り面Y座標
            const stopY = y0 + rayDirection.y * 1000;
            return stopY - targetStopY;
        };

        // 🆕 正確な絞り端到達のための反復最適化（gen-ray-cross-infinite.js方式を採用）
        const findOptimizedOrigin = () => {
            const tolerance = 0.1; // 0.1mm以内の精度
            const maxIterations = 30;
            
            // 初期推定値（従来方式）
            let currentX = targetStopX - (rayDirection.x / rayDirection.z) * 1000;
            let currentY = targetStopY - (rayDirection.y / rayDirection.z) * 1000;
            const currentZ = chiefStopPoint.z - 1000;
            
            // 反復最適化
            for (let iter = 0; iter < maxIterations; iter++) {
                const testRay = {
                    pos: { x: currentX, y: currentY, z: currentZ },
                    dir: rayDirection
                };
                
                const testPath = traceRay(this.opticalSystemRows, testRay);
                if (!testPath || testPath.length <= this.stopSurfaceIndex) {
                    break; // 光線追跡失敗
                }

                const actualStop = this.getStopPointFromRayData(testPath);
                if (!actualStop) {
                    break;
                }
                const errorX = actualStop.x - targetStopX;
                const errorY = actualStop.y - targetStopY;
                const errorMagnitude = Math.sqrt(errorX * errorX + errorY * errorY);
                
                if (errorMagnitude < tolerance) {
                    // 収束した
                    if (OPD_DEBUG && pupilRadius > 0.95 && iter > 0) {
                        console.log(`✅ [反復最適化] ${iter}回で収束: 誤差${errorMagnitude.toFixed(3)}mm < ${tolerance}mm`);
                        console.log(`   実際絞り位置: (${actualStop.x.toFixed(3)}, ${actualStop.y.toFixed(3)}) vs 目標: (${targetStopX.toFixed(3)}, ${targetStopY.toFixed(3)})`);
                    }
                    return { x: currentX, y: currentY, z: currentZ };
                }
                
                // Newton法による修正（簡易版）
                const correctionFactor = 0.8; // 過修正を防ぐ
                const correctionX = -errorX * correctionFactor;
                const correctionY = -errorY * correctionFactor;
                
                currentX += correctionX;
                currentY += correctionY;
                
                if (OPD_DEBUG && pupilRadius > 0.95 && iter < 3) {
                    console.log(`🔍 [反復${iter}] 誤差=${errorMagnitude.toFixed(3)}mm, 修正=(${correctionX.toFixed(3)}, ${correctionY.toFixed(3)})`);
                }
            }
            
            // 最大反復数に達した場合も結果を返す
            if (OPD_DEBUG && pupilRadius > 0.95) {
                console.warn(`⚠️ [反復最適化] 最大反復数${maxIterations}に達しました`);
            }
            return { x: currentX, y: currentY, z: currentZ };
        };
        
        const optimizedOrigin = findOptimizedOrigin();
        
        // 最適化結果の検証
        if (!optimizedOrigin || isNaN(optimizedOrigin.x) || isNaN(optimizedOrigin.y)) {
            if (OPD_DEBUG) console.warn(`❌ 反復最適化失敗: 結果=${optimizedOrigin}`);
            // フォールバック: 簡単な幾何学計算
            return {
                x: targetStopX - (rayDirection.x / rayDirection.z) * 1000,
                y: targetStopY - (rayDirection.y / rayDirection.z) * 1000,
                z: chiefStopPoint.z - 1000
            };
        }

        return optimizedOrigin;
    }

    /**
     * 光線の光路長を計算
     * @param {Object} rayData - 光線追跡結果
     * @returns {number} 光路長（μm）
     */
    calculateOpticalPath(rayData) {
        const prof = this._wavefrontProfile;
        const enabled = !!(prof && prof.enabled);
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? () => performance.now()
            : () => Date.now();
        const t0 = enabled ? now() : 0;

        const pathData = this.extractPathData(rayData);
        if (!Array.isArray(pathData)) return NaN;
        
        if (pathData.length < 2) {
            return NaN;
        }

        // traceRay は交点計算に失敗すると break しても rayPath を返す。
        // その場合、像面まで到達していない「未完了光線」になりうるため無効化する。
        const expectedPathPoints = 1 + (Array.isArray(this._recordedSurfaceIndices) ? this._recordedSurfaceIndices.length : 0);
        if (pathData.length < expectedPathPoints) {
            return NaN;
        }

        // console.log(`📏 光路長計算開始: ${pathData.length}点の光線パス`);  // ログ削減
        let totalOpticalPath = 0;

        // Hot-path cache: calculateOpticalPath is called for every OPD sample.
        // Cache system length and per-segment refractive indices (at fixed wavelength)
        // to avoid repeated O(Nsurfaces) work and recursive lookups.
        try {
            const rowsLen = Array.isArray(this.opticalSystemRows) ? this.opticalSystemRows.length : 0;
            const recLen = Array.isArray(this._recordedSurfaceIndices) ? this._recordedSurfaceIndices.length : 0;
            const cacheKey = `${this.wavelength}|${rowsLen}|${recLen}|${this.stopSurfaceIndex}|${this.evaluationSurfaceIndex}`;

            if (this._opticalPathCacheKey !== cacheKey || !this._opticalPathSegmentN || !Number.isFinite(this._opticalPathMaxSegMm)) {
                this._opticalPathCacheKey = cacheKey;
                if (enabled) {
                    prof.opticalPathCacheRebuilds = (prof.opticalPathCacheRebuilds || 0) + 1;
                }

                // System length (mm)
                let totalLength = 0;
                for (let s = 0; s < rowsLen; s++) {
                    const row = this.opticalSystemRows[s];
                    const thickness = parseFloat(row?.thickness || row?.Thickness || 0);
                    if (Number.isFinite(thickness) && thickness > 0 && thickness < 1000) {
                        totalLength += thickness;
                    }
                }
                const systemLengthMm = Math.max(totalLength, 100);
                this._opticalPathMaxSegMm = 5 * systemLengthMm;

                // Per-segment refractive index for segmentIndex (= point index).
                // segment 0: object-space medium.
                const segCount = Math.max(2, 1 + recLen);
                const segN = new Float64Array(segCount);
                const objectN = this.getObjectSpaceRefractiveIndex();
                segN[0] = (Number.isFinite(objectN) && objectN > 0) ? objectN : 1.0;
                for (let segIdx = 1; segIdx < segCount; segIdx++) {
                    const surfaceIndex = (segIdx - 1 < recLen) ? this._recordedSurfaceIndices[segIdx - 1] : null;
                    const surface = (surfaceIndex === null || surfaceIndex === undefined) ? null : this.opticalSystemRows?.[surfaceIndex];
                    if (!surface) {
                        segN[segIdx] = segN[segIdx - 1];
                        continue;
                    }
                    const materialUpper = String(surface.material ?? surface.Material ?? '').trim().toUpperCase();
                    if (materialUpper === 'MIRROR') {
                        segN[segIdx] = segN[segIdx - 1];
                        continue;
                    }
                    const n = this.getMaterialRefractiveIndex(surface);
                    segN[segIdx] = (Number.isFinite(n) && n > 0) ? n : segN[segIdx - 1];
                }
                this._opticalPathSegmentN = segN;
            }
        } catch (_) {
            // If anything goes wrong, fall back to uncached behavior below.
        }

        // 非物理的な「飛び交点」を検出して無効化するための上限（mm）
        // NOTE: クリップではなく、光線追跡が破綻した点を NaN 扱いにする。
        const maxReasonableSegmentMm = (Number.isFinite(this._opticalPathMaxSegMm) && this._opticalPathMaxSegMm > 0)
            ? this._opticalPathMaxSegMm
            : (5 * this.estimateSystemLength());
        
        // **重要**: 座標の単位チェック - 光学系はmm単位、OPDはμm単位
        // console.log('🔍 座標単位確認 - 最初の数点:');  // ログ削減
        // for (let i = 0; i < Math.min(3, pathData.length); i++) {
        //     const point = pathData[i];
        //     console.log(`  点${i}: (${point.x}, ${point.y}, ${point.z}) - 単位要確認`);
        // }
        
        // 無限系では、rayPath の先頭点は「任意の射出平面」になりやすく、
        // その区間（start→第1面）を含めると OPD が巨大化しやすい。
        // Stop 以降を OPL の基準とすることで、Spot Diagram と整合しやすい評価になる。
        let startPointIndex = 0;
        if (!this.isFiniteSystem()) {
            const stopPointIndex = this.getPointIndexForSurfaceIndex(this.stopSurfaceIndex);
            if (stopPointIndex !== null && stopPointIndex >= 0 && stopPointIndex < pathData.length - 1) {
                startPointIndex = stopPointIndex;
            }
        }

        for (let i = startPointIndex; i < pathData.length - 1; i++) {
            const point1 = pathData[i];
            const point2 = pathData[i + 1];
            
            // ポイントの座標確認
            if (!point1 || !point2 || 
                typeof point1.x !== 'number' || typeof point1.y !== 'number' || typeof point1.z !== 'number' ||
                typeof point2.x !== 'number' || typeof point2.y !== 'number' || typeof point2.z !== 'number') {
                return NaN;
            }
            
            // 物理的な距離を計算（座標の単位に注意）
            const distance = Math.sqrt(
                Math.pow(point2.x - point1.x, 2) +
                Math.pow(point2.y - point1.y, 2) +
                Math.pow(point2.z - point1.z, 2)
            );
            
            // INF値や異常な距離値のチェック
            if (!isFinite(distance)) {
                return NaN;
            }
            
            // Zero-length segments can legitimately occur (e.g., cemented surfaces with 0 thickness,
            // on-axis rays hitting coincident vertices). They contribute 0 to OPL, so skip them.
            if (distance === 0) {
                continue;
            }
            
            if (distance > maxReasonableSegmentMm) {
                return NaN;
            }
            
            // **重要**: 光学系の座標がmm単位の場合、μmに変換する必要がある
            const distanceInMicrons = distance * 1000; // mm → μm変換
            
            // 屈折率を取得（媒質の屈折率）
            const refractiveIndex = (this._opticalPathSegmentN && i >= 0 && i < this._opticalPathSegmentN.length)
                ? this._opticalPathSegmentN[i]
                : this.getRefractiveIndex(i);
            if (!isFinite(refractiveIndex) || refractiveIndex <= 0) {
                return NaN;
            }
            
            // 光路長 = 物理的距離[μm] × 屈折率
            const opticalSegment = distanceInMicrons * refractiveIndex;
            
            // 光路長の有効性チェック
            if (!isFinite(opticalSegment)) {
                return NaN;
            }
            
            totalOpticalPath += opticalSegment;
            
            // Logging disabled to prevent console spam during grid calculations
            // if ((i < 3 || i === pathData.length - 2) && !isFinite(opticalSegment)) {
            //     console.log(`  セグメント${i}: 距離=${distance.toFixed(4)}mm = ${distanceInMicrons.toFixed(4)}μm, 屈折率=${refractiveIndex.toFixed(4)}, 光路長=${opticalSegment.toFixed(4)}μm`);
            // }
        }
        
        // console.log(`📏 総光路長: ${totalOpticalPath.toFixed(4)} μm`);  // ログ削減

        const result = (totalOpticalPath > 0 && isFinite(totalOpticalPath)) ? totalOpticalPath : NaN;
        if (enabled) {
            const dt = now() - t0;
            prof.opticalPathCalls = (prof.opticalPathCalls || 0) + 1;
            prof.opticalPathMs = (prof.opticalPathMs || 0) + (Number.isFinite(dt) ? dt : 0);
        }
        return result;
    }

    /**
     * 波面収差 Wλ を計算
     * @param {number} pupilX - 瞳座標X
     * @param {number} pupilY - 瞳座標Y
     * @param {Object} fieldSetting - フィールド設定
     * @returns {number} 波面収差（波長単位）
     */
    calculateWavefrontAberration(pupilX, pupilY, fieldSetting) {
        // 波面収差 = OPD/λ。直前計算があれば再追跡しない。
        try {
            const currentFieldKey = `${fieldSetting.fieldAngle?.x || 0}_${fieldSetting.fieldAngle?.y || 0}_${fieldSetting.xHeight || 0}_${fieldSetting.yHeight || 0}`;
            const last = this.lastRayCalculation;
            if (last?.success && last.fieldKey === currentFieldKey && last.pupilCoord) {
                const dx = Math.abs((last.pupilCoord.x ?? 1e9) - pupilX);
                const dy = Math.abs((last.pupilCoord.y ?? 1e9) - pupilY);
                if (dx < 1e-12 && dy < 1e-12 && isFinite(last.opd) && !isNaN(last.opd)) {
                    return last.opd / this.wavelength;
                }
            }
        } catch (_) {}

        const opd = this.calculateOPD(pupilX, pupilY, fieldSetting);
        if (!isFinite(opd) || isNaN(opd)) {
            return NaN;
        }
        return opd / this.wavelength;
    }

    /**
     * ユーティリティ関数群
     */

    /**
     * ビネッティング判定（Draw OPD Rays専用の緩和モード）
     * @param {number} pupilX - 瞳座標X
     * @param {number} pupilY - 瞳座標Y
     * @param {Object} fieldSetting - フィールド設定
     * @returns {boolean} true: ビネッティングされている
     */
    isVignetted(pupilX, pupilY, fieldSetting) {
        // 🆕 Draw OPD Rays用の大幅緩和モード
        const isDrawOPDMode = true; // このモジュールはDraw OPD Rays専用
        
        if (isDrawOPDMode) {
            // Draw OPD Raysモードでは物理的に不可能な場合のみビネッティング判定
            const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
            
            // 極端な瞳座標（3.0以上）のみをビネッティング扱い
            if (pupilRadius > 3.0) {
                console.log(`🚫 [DrawOPD] 極端瞳座標ビネッティング: pupilRadius=${pupilRadius.toFixed(3)} > 3.0`);
                return true;
            }
            
            // 実際の光線追跡によるビネッティング判定（失敗のみ）
            try {
                const testRay = this.generateMarginalRay(pupilX, pupilY, fieldSetting);
                
                // 光線生成失敗 = ビネッティング
                if (!testRay) {
                    return true;
                }
                
                // 光線データの有効性チェック
                if (!this.isValidRayData(testRay)) {
                    return true;
                }
                
                // 🆕 Draw OPDモードでは絞り判定を大幅緩和
                // 光路長の妥当性チェックのみ実行
                const opticalPath = this.calculateOpticalPath(testRay);
                if (!isFinite(opticalPath) || opticalPath <= 0) {
                    console.log(`🚫 [DrawOPD] 無効光路長ビネッティング: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}) OPL=${opticalPath}`);
                    return true;
                }
                
                console.log(`✅ [DrawOPD] ビネッティングなし: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}), radius=${pupilRadius.toFixed(3)}`);
                return false; // ビネッティングなし
                
            } catch (error) {
                console.log(`🚫 [DrawOPD] 光線追跡エラーによるビネッティング: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}) ${error.message}`);
                return true;
            }
        }
        
        // 🆕 従来モード（現在は使用されない）
        const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
        const shouldDebug = pupilRadius > 0.8 || (Math.abs(pupilX) > 0.9) || (Math.abs(pupilY) > 0.9);
        
        if (shouldDebug) {
            console.log(`🔍 ビネッティング判定開始: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}), radius=${pupilRadius.toFixed(3)}`);
            console.log(`🔍 絞り面インデックス: ${this.stopSurfaceIndex}, 光学系面数: ${this.opticalSystemRows.length}`);
        }
        
        // 実際の光線追跡によるビネッティング判定
        try {
            const testRay = this.generateMarginalRay(pupilX, pupilY, fieldSetting);
            
            // 光線生成失敗 = ビネッティング
            if (!testRay) {
                // console.log(`🚫 光線生成失敗によるビネッティング: (${pupilX.toFixed(3)}, ${pupilY.toFixed(3)})`);
                return true;
            }
            
            // 光線データの有効性チェック
            if (!this.isValidRayData(testRay)) {
                // console.log(`🚫 無効光線データによるビネッティング: (${pupilX.toFixed(3)}, ${pupilY.toFixed(3)})`);
                return true;
            }
            
            // 3. 各面での絞り判定
            if (this.checkApertureVignetting(testRay, pupilX, pupilY)) {
                return true;
            }
            
            // 4. 光路長の妥当性チェック
            const opticalPath = this.calculateOpticalPath(testRay);
            if (!isFinite(opticalPath) || opticalPath <= 0) {
                if (shouldDebug) {
                    console.log(`🚫 無効光路長によるビネッティング: (${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}) OPL=${opticalPath}`);
                }
                return true;
            }
            
            if (shouldDebug) {
                console.log(`✅ ビネッティング判定完了: ビネッティングなし (${pupilX.toFixed(3)}, ${pupilY.toFixed(3)})`);
            }
            
            return false; // ビネッティングなし
            
        } catch (error) {
            if (shouldDebug) {
                console.log(`🚫 光線追跡エラーによるビネッティング: (${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}) ${error.message}`);
            }
            return true;
        }
    }

    /**
     * 各面での絞り（アパーチャ）によるビネッティング判定
     * @param {Array|Object} rayData - 光線データ
     * @param {number} pupilX - 瞳座標X
     * @param {number} pupilY - 瞳座標Y
     * @returns {boolean} true: ビネッティングされている
     */
    checkApertureVignetting(rayData, pupilX, pupilY) {
        const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
        const shouldDebug = pupilRadius > 0.8 || (Math.abs(pupilX) > 0.9) || (Math.abs(pupilY) > 0.9);
        
        let pathData = null;
        if (Array.isArray(rayData)) {
            pathData = rayData;
        } else {
            pathData = rayData.path || rayData.pathData || rayData.points;
        }
        
        if (!Array.isArray(pathData)) {
            return true; // データが不正
        }
        
        // **修正**: 実絞り（stop surface）のみをチェック
        if (this.stopSurfaceIndex >= 0 && this.stopSurfaceIndex < this.opticalSystemRows.length) {
            const stopPointIndex = this.getPointIndexForSurfaceIndex(this.stopSurfaceIndex);
            const rayPoint = (stopPointIndex !== null && stopPointIndex >= 0 && stopPointIndex < pathData.length)
                ? pathData[stopPointIndex]
                : (this.stopSurfaceIndex < pathData.length ? pathData[this.stopSurfaceIndex] : null);

            const stopSurface = this.opticalSystemRows[this.stopSurfaceIndex];
            
            if (shouldDebug) {
                console.log(`🔍 絞り面データ確認: rayPoint=${!!rayPoint}, stopSurface=${!!stopSurface}`);
                if (stopSurface) {
                    console.log(`🔍 絞り面内容: aperture=${stopSurface.aperture}, semidia=${stopSurface.semidia}, object=${stopSurface.object}`);
                }
                if (rayPoint) {
                    console.log(`🔍 光線位置: (${rayPoint.x.toFixed(3)}, ${rayPoint.y.toFixed(3)}, ${rayPoint.z.toFixed(3)})`);
                }
            }
            
            if (rayPoint && stopSurface) {
                // 絞り径をチェック（複数の可能性をチェック）
                let apertureDiameter = 0;
                
                // aperture フィールドから取得
                if (stopSurface.aperture || stopSurface.Aperture) {
                    apertureDiameter = parseFloat(stopSurface.aperture || stopSurface.Aperture);
                    if (shouldDebug) {
                        console.log(`🔍 絞り径取得 (aperture): ${apertureDiameter}mm`);
                    }
                }
                // semidia フィールドから取得（半径なので2倍）
                else if (stopSurface.semidia || stopSurface.Semidia) {
                    const semidiaValue = parseFloat(stopSurface.semidia || stopSurface.Semidia);
                    apertureDiameter = semidiaValue * 2;
                    if (shouldDebug) {
                        console.log(`🔍 絞り径取得 (semidia): ${semidiaValue}mm → 直径${apertureDiameter}mm`);
                    }
                }
                
                if (isFinite(apertureDiameter) && apertureDiameter > 0) {
                    const apertureRadius = apertureDiameter / 2;
                    
                    // 🆕 瞳座標に応じて絞り判定を緩和
                    const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
                    let effectiveApertureRadius = apertureRadius;
                    
                    // 瞳座標1.0を超える場合は絞り許容範囲を拡大
                    if (pupilRadius > 1.0) {
                        effectiveApertureRadius = apertureRadius * pupilRadius * 1.2; // 瞳座標比例 + 20%マージン
                        if (shouldDebug) {
                            console.log(`🔍 絞り判定緩和: pupilRadius=${pupilRadius.toFixed(3)} → 許容半径=${apertureRadius.toFixed(3)}mm → ${effectiveApertureRadius.toFixed(3)}mm`);
                        }
                    }
                    
                    // 光線の半径位置
                    const rayRadius = Math.sqrt(rayPoint.x * rayPoint.x + rayPoint.y * rayPoint.y);
                    
                    if (shouldDebug) {
                        console.log(`🔍 絞りチェック: 光線半径=${rayRadius.toFixed(3)}mm vs 有効絞り半径=${effectiveApertureRadius.toFixed(3)}mm`);
                    }
                    
                    // 🆕 緩和された絞り径チェック
                    if (rayRadius > effectiveApertureRadius) {
                        if (shouldDebug) {
                            console.log(`🚫 実絞りビネッティング: 光線半径=${rayRadius.toFixed(3)}mm > 有効絞り半径=${effectiveApertureRadius.toFixed(3)}mm (面${this.stopSurfaceIndex+1}), pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)})`);
                        }
                        return true;
                    } else {
                        if (shouldDebug) {
                            console.log(`✅ 絞り通過OK: 光線半径=${rayRadius.toFixed(3)}mm ≤ 有効絞り半径=${effectiveApertureRadius.toFixed(3)}mm`);
                        }
                    }
                } else {
                    if (shouldDebug) {
                        console.warn(`⚠️ 絞り径が取得できません: aperture=${stopSurface.aperture}, semidia=${stopSurface.semidia}`);
                        console.log(`🔍 絞り面の全プロパティ:`, Object.keys(stopSurface));
                    }
                }
            } else {
                console.warn(`⚠️ 絞り面データが不正: rayPoint=${!!rayPoint}, stopSurface=${!!stopSurface}`);
            }
        } else {
            if (shouldDebug) {
                console.warn(`⚠️ 絞り面インデックス範囲外: ${this.stopSurfaceIndex}, pathLength=${pathData.length}, surfaceCount=${this.opticalSystemRows.length}`);
            }
        }
        
        return false; // ビネッティングなし
    }

    /**
     * 光学系の概算長さを推定
     * @returns {number} 光学系長さ（mm）
     */
    estimateSystemLength() {
        let totalLength = 0;
        for (let i = 0; i < this.opticalSystemRows.length; i++) {
            const surface = this.opticalSystemRows[i];
            const thickness = parseFloat(surface.thickness || surface.Thickness || 0);
            if (isFinite(thickness) && thickness > 0 && thickness < 1000) {
                totalLength += thickness;
            }
        }
        return Math.max(totalLength, 100); // 最低100mm
    }

    /**
     * 有限系・無限系の判定
     * @returns {boolean} true: 有限系, false: 無限系
     */
    isFiniteSystem() {
        if (!this.opticalSystemRows || this.opticalSystemRows.length === 0) {
            return false;
        }
        
        const firstSurface = this.opticalSystemRows[0];
        const thickness = firstSurface.thickness || firstSurface.Thickness;

        // 'INF' / Infinity は無限系
        if (thickness === 'INF' || thickness === Infinity) {
            return false;
        }

        // 数値に変換して有限かつ正の値であれば有限系
        const numThickness = parseFloat(thickness);
        return Number.isFinite(numThickness) && numThickness > 0;
    }

    /**
     * フィールド設定に応じた有限/無限の判定
     * - UIのObjectで Angle 指定の場合は無限系として扱う（fieldAngleを有効化）
     * - Height 指定の場合は有限系として扱う（x/yHeightを有効化）
     * - typeが不明な場合は光学系のObject厚みから推定
     */
    isFiniteForField(fieldSetting) {
        // Field type is a user-level semantic:
        // - Angle: object at infinity (use infinite-ray solver)
        // - Rectangle/Point/Height: finite object height (use finite-ray solver *if* the system is finite)
        const typeLower = String(fieldSetting?.type ?? '').toLowerCase();
        // IMPORTANT: Do NOT use substring includes('angle') here.
        // 'rectangle' contains the substring 'angle', which would incorrectly route Rectangle fields
        // through the infinite-ray solver and cause widespread stop-miss failures.
        if (/\bangle\b/.test(typeLower)) {
            return false;
        }

        // Default: decide from optical system object distance.
        // If the system is infinite (Object thickness=INF), we cannot run the finite solver safely.
        return this.isFiniteSystem();
    }

    /**
     * 面の位置を計算
     * @param {number} surfaceIndex - 面インデックス
     * @returns {number} Z座標
     */
    calculateSurfacePosition(surfaceIndex) {
        // 後方互換: Zのみ必要な箇所で使用しているが、Coord Break を含む場合は
        // calculateSurfaceOrigins の値を優先する。
        try {
            const o = this._surfaceOrigins?.[surfaceIndex]?.origin;
            if (o && Number.isFinite(o.z)) return o.z;
        } catch (_) {}

        let z = 0;
        for (let i = 0; i < surfaceIndex; i++) {
            const surface = this.opticalSystemRows[i];
            const thickness = parseFloat(surface.thickness || surface.Thickness || 0);
            if (isFinite(thickness)) {
                z += thickness;
            }
        }
        return z;
    }

    getSurfaceOrigin(surfaceIndex) {
        try {
            const o = this._surfaceOrigins?.[surfaceIndex]?.origin;
            if (o && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z)) {
                return { x: o.x, y: o.y, z: o.z };
            }
        } catch (_) {}
        // Fallback: old assumption
        return { x: 0, y: 0, z: this.calculateSurfacePosition(surfaceIndex) };
    }

    /**
     * 2点間の光線方向ベクトルを計算
     * @param {Object} point1 - 始点
     * @param {Object} point2 - 終点
     * @returns {Object} 正規化された方向ベクトル
     */
    calculateRayDirection(point1, point2) {
        const dx = point2.x - point1.x;
        const dy = point2.y - point1.y;
        const dz = point2.z - point1.z;
        
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        
        return {
            x: dx / length,
            y: dy / length,
            z: dz / length
        };
    }

    /**
     * 有限系: Object点から「指定したStop面上ターゲット点」に到達する方向を、
     * tracing結果からの誤差フィードバックで反復補正して求める。
     *
     * Brent法ソルバが例外的に収束しないケース（オフ軸・強屈折・有効径境界など）で、
     * OPD/PSFが全滅するのを防ぐためのフォールバック。
     *
     * @param {{x:number,y:number,z:number}} objectPosition
     * @param {{x:number,y:number,z:number}} targetStopPoint - Stop面上の狙い点（Coord Break反映済み）
     * @param {number} stopSurfaceIndex
     * @param {boolean} debugMode
     * @returns {{i:number,j:number,k:number}|null}
     */
    findFiniteRayDirectionToHitStop(objectPosition, targetStopPoint, stopSurfaceIndex, debugMode = false, options = undefined) {
        try {
            const stopCenter = this.getSurfaceOrigin(stopSurfaceIndex);
            const axes = this.getSurfaceAxes(stopSurfaceIndex);
            const dot = (a, b) => (a.x * b.x + a.y * b.y + a.z * b.z);

            const fastSolve = !!(options && (options.fastSolve || options.fastMarginalRay));

            const dTarget = {
                x: targetStopPoint.x - stopCenter.x,
                y: targetStopPoint.y - stopCenter.y,
                z: targetStopPoint.z - stopCenter.z
            };
            const desiredLocalX = dot(dTarget, axes.ex);
            const desiredLocalY = dot(dTarget, axes.ey);

            // Stop半径の概算（ステップ上限に使う）
            const stopSurface = this.opticalSystemRows?.[stopSurfaceIndex];
            let stopRadius = Math.abs(parseFloat(stopSurface?.semidia || 0)) || 10;
            const aperture = Math.abs(parseFloat(stopSurface?.aperture || stopSurface?.Aperture || 0)) || 0;
            if (!Number.isFinite(stopRadius) || stopRadius <= 0) stopRadius = (aperture > 0 ? (aperture / 2) : 10);

            const maxIters = fastSolve ? 8 : 14;
            const tol = fastSolve ? 0.07 : 0.03; // mm (stop-local)
            const gain = fastSolve ? 0.72 : 0.75;
            const maxStep = Math.max(0.6, stopRadius * (fastSolve ? 0.16 : 0.18)); // mm
            const offsets = fastSolve ? [0, 0.9, 1.8] : [0, 0.4, 0.9, 1.6, 3.0]; // mm (stop-local)

            const evalStopError = (ray) => {
                const toStop = this.traceRayToSurface(ray, stopSurfaceIndex, 1.0);
                const actualStop = this.getStopPointFromRayData(toStop);
                if (!actualStop) return null;
                const d = {
                    x: actualStop.x - stopCenter.x,
                    y: actualStop.y - stopCenter.y,
                    z: actualStop.z - stopCenter.z
                };
                const ax = dot(d, axes.ex);
                const ay = dot(d, axes.ey);
                const errLX = ax - desiredLocalX;
                const errLY = ay - desiredLocalY;
                const errMag = Math.hypot(errLX, errLY);
                return { errLX, errLY, errMag };
            };

            // Multi-start: ターゲット点の近傍を少しだけずらして収束域を広げる
            // fastSolve では候補数を抑えてコストを上げすぎない。
            const candidates = [];
            for (const d of offsets) {
                if (d === 0) {
                    candidates.push({ ...targetStopPoint });
                    continue;
                }
                if (fastSolve) {
                    // 8-direction (cardinals + diagonals)
                    const dd = d / Math.SQRT2;
                    const dirs = [
                        { sx: d, sy: 0 },
                        { sx: -d, sy: 0 },
                        { sx: 0, sy: d },
                        { sx: 0, sy: -d },
                        { sx: dd, sy: dd },
                        { sx: -dd, sy: dd },
                        { sx: dd, sy: -dd },
                        { sx: -dd, sy: -dd }
                    ];
                    for (const dd of dirs) {
                        const off = this.addVec(this.scaleVec(axes.ex, dd.sx), this.scaleVec(axes.ey, dd.sy));
                        candidates.push({
                            x: targetStopPoint.x + off.x,
                            y: targetStopPoint.y + off.y,
                            z: targetStopPoint.z + off.z
                        });
                    }
                } else {
                    for (const sx of [-d, 0, d]) {
                        for (const sy of [-d, 0, d]) {
                            if (sx === 0 && sy === 0) continue;
                            const off = this.addVec(this.scaleVec(axes.ex, sx), this.scaleVec(axes.ey, sy));
                            candidates.push({
                                x: targetStopPoint.x + off.x,
                                y: targetStopPoint.y + off.y,
                                z: targetStopPoint.z + off.z
                            });
                        }
                    }
                }
            }

            let best = null;
            for (const startTarget of candidates) {
                let aimed = { ...startTarget };
                let lastErr = Infinity;
                let lastDir = null;

                for (let iter = 0; iter < maxIters; iter++) {
                    const dir = this.calculateRayDirection(objectPosition, aimed);
                    const ray = { pos: objectPosition, dir, wavelength: this.wavelength };
                    const e = evalStopError(ray);
                    if (!e || !Number.isFinite(e.errMag)) {
                        lastDir = null;
                        break;
                    }

                    lastErr = e.errMag;
                    lastDir = dir;
                    if (e.errMag <= tol) break;

                    const errVec = this.addVec(
                        this.scaleVec(axes.ex, e.errLX),
                        this.scaleVec(axes.ey, e.errLY)
                    );
                    const stepMag = Math.hypot(errVec.x, errVec.y, errVec.z) || 1;
                    const clamp = stepMag > maxStep ? (maxStep / stepMag) : 1.0;
                    aimed = {
                        x: aimed.x - errVec.x * gain * clamp,
                        y: aimed.y - errVec.y * gain * clamp,
                        z: aimed.z - errVec.z * gain * clamp
                    };
                }

                if (lastDir && Number.isFinite(lastErr)) {
                    if (!best || lastErr < best.errMag) {
                        best = { errMag: lastErr, dir: lastDir };
                    }
                    if (lastErr <= tol) break;
                }
            }

            if (best && best.dir && Number.isFinite(best.dir.x) && Number.isFinite(best.dir.y) && Number.isFinite(best.dir.z)) {
                const mag = Math.hypot(best.dir.x, best.dir.y, best.dir.z) || 1;
                if (debugMode || OPD_DEBUG) {
                    console.log(`🧭 finite stop-hit fallback used (err=${best.errMag.toFixed(4)}mm)`);
                }
                return { i: best.dir.x / mag, j: best.dir.y / mag, k: best.dir.z / mag };
            }
        } catch (_) {
            // ignore
        }
        return null;
    }

    /**
     * 指定された区間の屈折率を取得
     * @param {number} segmentIndex - 区間インデックス
     * @returns {number} 屈折率
     */
getRefractiveIndex(segmentIndex) {
    const objectN = this.getObjectSpaceRefractiveIndex();

    if (segmentIndex <= 0) {
        return objectN;
    }

    // segmentIndex は rayPath の点列インデックスに対応する。
    // segment k (k>=1) は「記録された交点面」(k-1番目) を通過後の媒質。
    const surfaceIndex = Array.isArray(this._recordedSurfaceIndices)
        ? this._recordedSurfaceIndices[segmentIndex - 1]
        : null;

    const surface = (surfaceIndex === null || surfaceIndex === undefined)
        ? null
        : this.opticalSystemRows?.[surfaceIndex];
    if (!surface) {
        return objectN;
    }

    const materialUpper = String(surface.material ?? surface.Material ?? '').trim().toUpperCase();
    if (materialUpper === 'MIRROR') {
        // Mirror does not define a transmission medium; keep previous medium.
        return this.getRefractiveIndex(segmentIndex - 1);
    }

    return this.getMaterialRefractiveIndex(surface);
}
}

/**
 * 波面収差解析クラス
 * Zernike多項式による波面収差の分解・解析機能を提供
 */
export class WavefrontAberrationAnalyzer {
    constructor(opdCalculator) {
        this.opdCalculator = opdCalculator;
        this.zernikeCoefficients = new Map();
    }

    _removeBestFitPlane(pupilCoordinates, opdsMicrons) {
        try {
            if (!Array.isArray(pupilCoordinates) || !Array.isArray(opdsMicrons) || pupilCoordinates.length !== opdsMicrons.length) {
                return null;
            }

            // Coordinates may be normalized to unit pupil OR scaled by pupilRange.
            // Infer the effective pupil radius from finite samples (robust for renderFromZernike grids).
            let pupilRadius = 1.0;
            try {
                let rMax = 0;
                for (let i = 0; i < pupilCoordinates.length; i++) {
                    const p = pupilCoordinates[i];
                    const z = opdsMicrons[i];
                    const x = Number(p?.x);
                    const y = Number(p?.y);
                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                    const r = Math.hypot(x, y);
                    if (r > rMax) rMax = r;
                }
                if (Number.isFinite(rMax) && rMax > 0) pupilRadius = rMax;
            } catch (_) {}

            // Fit z = a + b*x + c*y in least squares.
            // This removes piston + tilt (but not defocus).
            let n = 0;
            let sumX = 0;
            let sumY = 0;
            let sumXX = 0;
            let sumXY = 0;
            let sumYY = 0;
            let sumZ = 0;
            let sumXZ = 0;
            let sumYZ = 0;

            for (let i = 0; i < pupilCoordinates.length; i++) {
                const p = pupilCoordinates[i];
                const z = opdsMicrons[i];
                const x = Number(p?.x);
                const y = Number(p?.y);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                const r = Math.hypot(x, y);
                if (r > pupilRadius + 1e-9) continue;

                n++;
                sumX += x;
                sumY += y;
                sumXX += x * x;
                sumXY += x * y;
                sumYY += y * y;
                sumZ += z;
                sumXZ += x * z;
                sumYZ += y * z;
            }

            if (n < 6) return null;

            // Solve normal equations:
            // [ n    sumX  sumY ] [a] = [sumZ]
            // [sumX sumXX sumXY ] [b] = [sumXZ]
            // [sumY sumXY sumYY ] [c] = [sumYZ]
            const A = [
                [n, sumX, sumY, sumZ],
                [sumX, sumXX, sumXY, sumXZ],
                [sumY, sumXY, sumYY, sumYZ]
            ];

            // Gaussian elimination (3x3 augmented).
            for (let col = 0; col < 3; col++) {
                // pivot
                let pivotRow = col;
                let pivotAbs = Math.abs(A[col][col]);
                for (let r = col + 1; r < 3; r++) {
                    const v = Math.abs(A[r][col]);
                    if (v > pivotAbs) {
                        pivotAbs = v;
                        pivotRow = r;
                    }
                }
                if (!Number.isFinite(pivotAbs) || pivotAbs < 1e-18) return null;
                if (pivotRow !== col) {
                    const tmp = A[col];
                    A[col] = A[pivotRow];
                    A[pivotRow] = tmp;
                }

                const piv = A[col][col];
                for (let c = col; c < 4; c++) A[col][c] /= piv;
                for (let r = 0; r < 3; r++) {
                    if (r === col) continue;
                    const f = A[r][col];
                    if (!Number.isFinite(f) || Math.abs(f) < 1e-18) continue;
                    for (let c = col; c < 4; c++) {
                        A[r][c] -= f * A[col][c];
                    }
                }
            }

            const a = A[0][3];
            const b = A[1][3];
            const c = A[2][3];
            if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;

            const residualMicrons = new Array(opdsMicrons.length);
            const wavelength = this.opdCalculator?.wavelength;
            const residualWaves = new Array(opdsMicrons.length);

            for (let i = 0; i < pupilCoordinates.length; i++) {
                const p = pupilCoordinates[i];
                const z = opdsMicrons[i];
                const x = Number(p?.x);
                const y = Number(p?.y);
                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                    residualMicrons[i] = NaN;
                    residualWaves[i] = NaN;
                    continue;
                }
                const r = Math.hypot(x, y);
                if (r > pupilRadius + 1e-9) {
                    residualMicrons[i] = NaN;
                    residualWaves[i] = NaN;
                    continue;
                }
                const plane = a + b * x + c * y;
                const res = z - plane;
                residualMicrons[i] = res;
                residualWaves[i] = (Number.isFinite(res) && Number.isFinite(wavelength) && wavelength > 0) ? (res / wavelength) : NaN;
            }

            return {
                coefficientsMicrons: { a, b, c },
                residualMicrons,
                residualWaves
            };
        } catch (_) {
            return null;
        }
    }

    _calculateLowOrderRemovedStats(pupilCoordinates, opdsMicrons, options = {}) {
        try {
            const removeIndices = Array.isArray(options?.removeIndices)
                ? options.removeIndices.filter(v => Number.isInteger(v) && v >= 0)
                : [0, 1, 2, 4];
            const maxOrder = Number.isFinite(options?.maxOrder) ? Math.max(1, Math.floor(options.maxOrder)) : 2; // n<=2 includes defocus
            const wavelength = this.opdCalculator?.wavelength;

            if (!Array.isArray(pupilCoordinates) || !Array.isArray(opdsMicrons) || pupilCoordinates.length !== opdsMicrons.length) {
                return null;
            }

            const points = [];
            for (let i = 0; i < pupilCoordinates.length; i++) {
                const p = pupilCoordinates[i];
                const opd = opdsMicrons[i];
                if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(opd)) continue;
                const r = Math.hypot(p.x, p.y);
                if (r > 1.0 + 1e-9) continue;
                points.push({ x: p.x, y: p.y, opd, weight: 1.0 });
            }
            if (points.length < 6) return null;

            const fit = fitZernikeWeighted(points, maxOrder, {
                removePiston: false,
                removeTilt: false
            });

            const coeffs = Array.isArray(fit?.coefficients) ? fit.coefficients : null;
            if (!coeffs || coeffs.length === 0) return null;

            const removeCoeffs = new Array(coeffs.length).fill(0);
            for (const j of removeIndices) {
                if (j >= 0 && j < coeffs.length && Number.isFinite(coeffs[j])) {
                    removeCoeffs[j] = coeffs[j];
                }
            }

            const residualMicrons = [];
            const residualWaves = [];
            for (let i = 0; i < pupilCoordinates.length; i++) {
                const p = pupilCoordinates[i];
                const opd = opdsMicrons[i];
                if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(opd)) {
                    residualMicrons.push(NaN);
                    residualWaves.push(NaN);
                    continue;
                }
                const r = Math.hypot(p.x, p.y);
                if (r > 1.0 + 1e-9) {
                    residualMicrons.push(NaN);
                    residualWaves.push(NaN);
                    continue;
                }
                const model = reconstructOPD(removeCoeffs, p.x, p.y);
                const res = (Number.isFinite(model)) ? (opd - model) : NaN;
                residualMicrons.push(res);
                residualWaves.push(Number.isFinite(res) && Number.isFinite(wavelength) && wavelength > 0 ? (res / wavelength) : NaN);
            }

            return {
                removeIndices,
                maxOrder,
                coefficientsMicrons: coeffs,
                opdMicrons: this.calculateStatistics(residualMicrons, { removePiston: false }),
                opdWavelengths: this.calculateStatistics(residualWaves, { removePiston: false })
            };
        } catch (_) {
            return null;
        }
    }

    async _yieldToUI() {
        // ブラウザUIが固まるのを防ぐため、定期的にイベントループへ制御を返す。
        // requestAnimationFrame はタブ/ウインドウが非アクティブ時に停止しうるため、
        // MessageChannel を優先して "確実に進む" yield を行う。
        try {
            if (typeof MessageChannel !== 'undefined') {
                if (!this.__yieldQueue || !this.__yieldPort) {
                    this.__yieldQueue = [];
                    const channel = new MessageChannel();
                    channel.port1.onmessage = () => {
                        const resolve = this.__yieldQueue.shift();
                        if (resolve) resolve();
                    };
                    this.__yieldPort = channel.port2;
                }

                await new Promise(resolve => {
                    this.__yieldQueue.push(resolve);
                    this.__yieldPort.postMessage(0);
                });
                return;
            }
        } catch (_) {
            // ignore
        }

        await new Promise(resolve => setTimeout(resolve, 0));
    }

    /**
     * 指定されたフィールドでの波面収差マップを生成
     * @param {Object} fieldSetting - フィールド設定
     * @param {number} gridSize - グリッドサイズ（デフォルト: 16）
     * @param {string} gridPattern - グリッドパターン: 'circular' (デフォルト) または 'rectangular'
     * @param {Object} options - オプション
     * @param {boolean} options.recordRays - rayData（光線パス）を保存するか（重いので必要時のみ）
     * @param {number} options.progressEvery - 進捗ログ間隔（点数）。0/未指定で抑制
     * @returns {Object} 波面収差マップデータ
     */
    async generateWavefrontMap(fieldSetting, gridSize = 16, gridPattern = 'circular', options = {}) {
        const cancelToken = (options && options.cancelToken) ? options.cancelToken : null;
        const throwIfCancelled = () => {
            if (cancelToken && cancelToken.aborted) {
                const err = new Error(String(cancelToken.reason || 'Cancelled'));
                err.code = 'CANCELLED';
                throw err;
            }
        };

        const recordRays = options?.recordRays !== undefined ? !!options.recordRays : true;
        const progressEvery = Number.isFinite(options?.progressEvery) ? Math.max(0, Math.floor(options.progressEvery)) : 0;
        const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
        const emitProgress = (percent, phase, message) => {
            if (!onProgress) return;
            try {
                const p = Number(percent);
                onProgress({
                    percent: Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null,
                    phase: phase || null,
                    message: message || null
                });
            } catch (_) {
                // ignore
            }
        };
        const diagnoseDiscontinuities = !!options?.diagnoseDiscontinuities;
        const diagTopK = Number.isFinite(options?.diagTopK) ? Math.max(1, Math.floor(options.diagTopK)) : 5;
        const opdMode = String(options?.opdMode || 'simple'); // 'simple' | 'referenceSphere'
        const opdDisplayMode = String(options?.opdDisplayMode || 'default'); // 'default' | 'pistonTiltRemoved'
        const zernikeMaxNollOpt = Number.isFinite(options?.zernikeMaxNoll) ? Math.max(1, Math.floor(options.zernikeMaxNoll)) : 15;
        const renderFromZernike = !!options?.renderFromZernike;
        const skipZernikeFit = !!options?.skipZernikeFit; // Skip Zernike fitting if requested

        // NOTE: Historically we downsampled the ray-traced OPD grid for Zernike fitting to cap runtime.
        // The user may require the UI grid size to be reflected in the actual ray tracing, even when
        // renderFromZernike=true. Therefore, we only apply a fit-grid cap when it is explicitly provided
        // via options.fitGridSizeMax.
        const requestedGridSize = gridSize;
        const fitGridSizeMax = Number.isFinite(options?.fitGridSizeMax)
            ? Math.max(4, Math.floor(Number(options.fitGridSizeMax)))
            : null;
        if (renderFromZernike && Number.isFinite(requestedGridSize) && fitGridSizeMax && requestedGridSize > fitGridSizeMax) {
            gridSize = fitGridSizeMax;
            console.log(`⚡ Zernike描画: フィット用グリッドを ${gridSize} に縮小（要求=${requestedGridSize}、上限=${fitGridSizeMax}）`);
        }

        const g = (typeof globalThis !== 'undefined') ? globalThis : null;
        const profileEnabled = !!(options?.profile || (typeof globalThis !== 'undefined' && globalThis.__WAVEFRONT_PROFILE === true));
        const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? () => performance.now()
            : () => Date.now();
        const prof = profileEnabled ? {
            enabled: true,
            gridSize,
            gridPattern,
            recordRays,
            progressEvery,
            opdMode,
            zernikeMaxNollOpt,
            renderFromZernike,
            tStart: now(),
            marks: Object.create(null)
        } : null;

        if (prof) {
            this.opdCalculator._wavefrontProfile = prof;
            prof.marks.start = prof.tStart;

            // Enable low-overhead ray-tracing profiler only for this run.
            try {
                prof.__rtPrevEnabled = (g && typeof g.isRayTracingProfilerEnabled === 'function') ? !!g.isRayTracingProfilerEnabled() : null;
            } catch (_) {
                prof.__rtPrevEnabled = null;
            }
            try {
                if (g) g.__cooptActiveWavefrontProfile = prof;
            } catch (_) {}
            try {
                if (g && typeof g.enableRayTracingProfiler === 'function') {
                    g.enableRayTracingProfiler(true, true);
                }
            } catch (_) {}
        }

        // 通常運用ではログを最小化（Chromeのログ抑制/フリーズ対策）
        if (OPD_DEBUG) {
            console.log(`🌊 波面収差マップ生成開始: gridSize=${gridSize}, pattern=${gridPattern}, field=${JSON.stringify(fieldSetting)}`);
        }

        emitProgress(0, 'init', 'Starting wavefront generation...');

        throwIfCancelled();
        
        const wavefrontMap = {
            fieldSetting: fieldSetting,
            gridSize: gridSize,
            gridSizeRequested: requestedGridSize,
            opdMode,
            opdDisplayModeRequested: opdDisplayMode,
            skipZernikeFit,
            pupilRange: null,
            pupilCoordinates: [],
            wavefrontAberrations: [],
            opds: [],
            opdsInWavelengths: [], // 波長単位のOPD
            rayData: recordRays ? [] : null, // 光線描画用データ（必要時のみ。大量点では非常に重い）
            statistics: {}
        };

        // 基準光線を設定
        emitProgress(1, 'reference', 'Setting reference ray...');
        if (prof) prof.marks.refStart = now();
        let isInfiniteField = false;
        try {
            this.opdCalculator.setReferenceRay(fieldSetting);
            if (prof) prof.marks.refEnd = now();
            emitProgress(3, 'reference', 'Reference ray set');
            
            // Diagnostic: Check reference ray for on-axis fields
            const fieldAngleX = Math.abs(fieldSetting.fieldAngle?.x || 0);
            const fieldAngleY = Math.abs(fieldSetting.fieldAngle?.y || 0);
            console.log(`🔍 [Debug] fieldAngleX=${fieldAngleX}, fieldAngleY=${fieldAngleY}, hasRefRay=${!!this.opdCalculator.referenceRay}`);
            if (fieldAngleX < 0.01 && fieldAngleY < 0.01 && this.opdCalculator.referenceRay) {
                const refRay = this.opdCalculator.referenceRay;
                console.log(`🔍 [Reference Ray] Field: (${fieldAngleX.toFixed(4)}°, ${fieldAngleY.toFixed(4)}°)`);
                console.log(`🔍 [Debug] refRay type: ${Array.isArray(refRay) ? 'Array' : typeof refRay}, length=${refRay?.length}`);
                if (Array.isArray(refRay) && refRay.length >= 2) {
                    const p0 = refRay[0];
                    const p1 = refRay[1];
                    console.log(`🔍 [Reference Ray] Start: (${p0.x.toFixed(6)}, ${p0.y.toFixed(6)}, ${p0.z.toFixed(6)})`);
                    console.log(`🔍 [Reference Ray] Direction: (${(p1.x-p0.x).toFixed(6)}, ${(p1.y-p0.y).toFixed(6)}, ${(p1.z-p0.z).toFixed(6)})`);
                    
                    // Check if reference ray is truly on-axis (direction should be along Z)
                    const dx = p1.x - p0.x;
                    const dy = p1.y - p0.y;
                    const dz = p1.z - p0.z;
                    const transverseComponent = Math.sqrt(dx*dx + dy*dy);
                    const axialComponent = Math.abs(dz);
                    const angleOffAxis = Math.atan2(transverseComponent, axialComponent) * 180 / Math.PI;
                    console.log(`🔍 [Reference Ray] Angle off Z-axis: ${angleOffAxis.toFixed(6)}°`);
                    
                    if (angleOffAxis > 0.001) {
                        console.warn(`⚠️ Reference ray is tilted ${angleOffAxis.toFixed(6)}° off axis - this will cause OPD asymmetry!`);
                    }
                }
            }

            throwIfCancelled();

            // Record pupil sampling mode for UI/diagnostics.
            const isFinite = this.opdCalculator.isFiniteForField(fieldSetting);
            isInfiniteField = !isFinite;
            const forcedInfinitePupilMode = (!isFinite && this.opdCalculator._getForcedInfinitePupilMode)
                ? this.opdCalculator._getForcedInfinitePupilMode()
                : null;
            wavefrontMap.pupilSamplingMode = isFinite
                ? 'finite'
                : (forcedInfinitePupilMode || this.opdCalculator._getInfinitePupilMode(fieldSetting));
            wavefrontMap.bestEffortVignettedPupil = (!isFinite && wavefrontMap.pupilSamplingMode === 'entrance');

            if (OPD_DEBUG && !isFinite) {
                console.log(`🧿 [Wavefront] infinite pupilSamplingMode=${wavefrontMap.pupilSamplingMode}`);
            }
        } catch (error) {
            console.error('❌ 基準光線設定に失敗:', error);
            wavefrontMap.error = { message: error.message || String(error) };
            wavefrontMap.statistics = {
                wavefront: { count: 0, mean: 0, rms: 0, peakToPeak: 0, min: 0, max: 0 },
                opdMicrons: { count: 0, mean: 0, rms: 0, peakToPeak: 0, min: 0, max: 0 },
                opdWavelengths: { count: 0, mean: 0, rms: 0, peakToPeak: 0, min: 0, max: 0 }
            };
            return wavefrontMap;
        }

        // 基準光線設定後に一度UIへ制御を返す（ログ/描画の反映用）
        await this._yieldToUI();

        throwIfCancelled();

        // グリッド上の各点で波面収差を計算
        // 🔧 実絞り径端まで光線が届くようにpupil範囲を拡大
        let pupilRange = 1.0; // 実絞り径端まで対応（0.7→1.0に拡大）
        wavefrontMap.pupilRange = pupilRange;

        // Diagnostics: expose physical pupil radius (mm) for this field/mode.
        // This helps interpret why OPD range can differ drastically between fields
        // (e.g., entrance mode may have a much smaller effective pupil).
        const estimateInfiniteDirection = (fs) => {
            const angleXr = (fs?.fieldAngle?.x || 0) * Math.PI / 180;
            const angleYr = (fs?.fieldAngle?.y || 0) * Math.PI / 180;
            const cosXr = Math.cos(angleXr);
            const cosYr = Math.cos(angleYr);
            const sinXr = Math.sin(angleXr);
            const sinYr = Math.sin(angleYr);
            const d = {
                x: sinXr * cosYr,
                y: sinYr * cosXr,
                z: cosXr * cosYr
            };
            const m = Math.hypot(d.x, d.y, d.z) || 1;
            return { x: d.x / m, y: d.y / m, z: d.z / m };
        };

        const getStopRadiusMm = () => {
            let r = 17.85;
            try {
                const rows = this.opdCalculator.opticalSystemRows;
                const si = this.opdCalculator.stopSurfaceIndex;
                if (Array.isArray(rows) && Number.isInteger(si) && si >= 0 && si < rows.length) {
                    const s = rows[si];
                    const semidia = parseFloat(s?.semidia || 0);
                    const aperture = parseFloat(s?.aperture || s?.Aperture || 0);
                    r = (Number.isFinite(semidia) && semidia > 0) ? semidia : ((Number.isFinite(aperture) && aperture > 0) ? (aperture / 2) : r);
                }
            } catch (_) {}
            return r;
        };

        const getEntranceRadiusMm = () => {
            try {
                const dir = estimateInfiniteDirection(fieldSetting);
                const cfg = this.opdCalculator._getOrBuildEntrancePupilConfig(fieldSetting, dir, { fastSolve: true });
                const rr = Number(cfg?.radius);
                return (Number.isFinite(rr) ? rr : NaN);
            } catch (_) {
                return NaN;
            }
        };

        try {
            const isFinite = this.opdCalculator.isFiniteForField(fieldSetting);
            if (!isFinite) {
                const m = wavefrontMap.pupilSamplingMode;
                // Keep a single, comparable pupil scale across fields: use the (design) stop radius.
                // In entrance mode, we still report the estimated effective entrance pupil radius separately.
                wavefrontMap.pupilPhysicalRadiusMm = getStopRadiusMm();
                if (m === 'entrance') {
                    wavefrontMap.entranceEffectiveRadiusMm = getEntranceRadiusMm();
                } else {
                    wavefrontMap.entranceEffectiveRadiusMm = NaN;
                }
            }
        } catch (_) {}

        // ✅ すべての画角でpupil rangeを固定（動的計算を停止）
        if (OPD_DEBUG) console.log(`🔍 固定pupil範囲: ±${pupilRange.toFixed(3)} (実絞り径端まで対応)`);
        
        // 以下の画角による範囲調整計算は無効化
        // pupilRange = Math.min(1.0, 0.9 + maxFieldAngle / 100.0);
        // pupilRange = Math.min(1.0, 0.9 + maxHeight / 200.0);
        
        // ✅ 四角形グリッドパターンでの光線生成（ヒートマップ対応）
        if (OPD_DEBUG) console.log(`🔍 四角形グリッドパターン生成: 範囲±${pupilRange.toFixed(3)}, サイズ${gridSize}×${gridSize}`);
        
        let validPointCount = 0;
        let invalidPointCount = 0;
        let invalidReasonCounts = Object.create(null);
        let gridPoints = []; // 生成される座標を記録

        // Track which grid cells produced a valid ray/OPD.
        // This is critical for infinite systems with vignetting (eval unreachable):
        // we must not extrapolate the Zernike model into physically invalid pupil regions.
        let validPupilMask = Array.from({ length: Math.max(2, Math.floor(Number(gridSize))) }, () => Array.from({ length: Math.max(2, Math.floor(Number(gridSize))) }, () => false));
        
        // 絞り半径情報を取得して表示（エラーハンドリング追加）
        let stopRadius = 17.85; // デフォルト値
        
        // 光学系データと絞り面インデックスの存在確認
        if (!this.opdCalculator.opticalSystemRows || !Array.isArray(this.opdCalculator.opticalSystemRows)) {
            console.error(`❌ 光学系データが未初期化: opticalSystemRows=${typeof this.opdCalculator.opticalSystemRows}`);
            console.warn(`🔧 デフォルト絞り半径を使用: ${stopRadius}mm`);
        } else if (this.opdCalculator.stopSurfaceIndex === undefined || this.opdCalculator.stopSurfaceIndex === null) {
            console.error(`❌ 絞り面インデックスが未設定: stopSurfaceIndex=${this.opdCalculator.stopSurfaceIndex}`);
            console.warn(`🔧 デフォルト絞り半径を使用: ${stopRadius}mm`);
        } else if (this.opdCalculator.stopSurfaceIndex < 0 || this.opdCalculator.stopSurfaceIndex >= this.opdCalculator.opticalSystemRows.length) {
            console.error(`❌ 絞り面インデックスが範囲外: ${this.opdCalculator.stopSurfaceIndex} (光学系長=${this.opdCalculator.opticalSystemRows.length})`);
            console.warn(`🔧 デフォルト絞り半径を使用: ${stopRadius}mm`);
        } else {
            // 正常な場合：絞り面データから半径を取得
            const stopSurface = this.opdCalculator.opticalSystemRows[this.opdCalculator.stopSurfaceIndex];
            if (stopSurface) {
                const semidia = parseFloat(stopSurface.semidia || 0);
                const aperture = parseFloat(stopSurface.aperture || stopSurface.Aperture || 0);
                stopRadius = semidia > 0 ? semidia : (aperture > 0 ? aperture / 2 : 17.85);
                
                // 🔧 **Cross光線との比較**: 絞り半径の詳細確認
                if (OPD_DEBUG) {
                    console.log(`🔍 [絞り比較] OPD計算での絞り半径: ${stopRadius}mm (semidia=${semidia}, aperture=${aperture})`);
                    console.log(`🔍 [絞り比較] 絞り面インデックス: ${this.opdCalculator.stopSurfaceIndex}`);
                    console.log(`🔍 [絞り比較] 最大瞳座標での絞り到達範囲: ±${stopRadius * pupilRange}mm`);
                    console.log(`🔍 絞り面情報: 面番号=${this.opdCalculator.stopSurfaceIndex}, 絞り半径=${stopRadius.toFixed(3)}mm, pupilRange=${pupilRange.toFixed(3)}`);
                }
            } else {
                console.error(`❌ 絞り面データが取得できません: stopSurface=${stopSurface}`);
                console.warn(`🔧 デフォルト絞り半径を使用: ${stopRadius}mm`);
            }
        }

        // 軸上視野では物理的にm≠0項が存在しないため、Zernike fitting時に除去
        // ただし、CBシフトがある場合は実質的に軸外なので、Stop面のグローバル座標をチェック
        const fieldAngleX_grid = Math.abs(fieldSetting?.fieldAngle?.x || 0);
        const fieldAngleY_grid = Math.abs(fieldSetting?.fieldAngle?.y || 0);
        let isOnAxisField = (fieldAngleX_grid < 0.01 && fieldAngleY_grid < 0.01);
        
        // CBシフトによる実効的な軸外判定: Stop面のグローバル座標が原点から0.001mm以上ずれている場合は軸外扱い
        if (isOnAxisField) {
            try {
                console.log(`🔍 [On-axis Check] stopSurfaceIndex=${this.opdCalculator.stopSurfaceIndex}`);
                console.log(`🔍 [On-axis Check] _surfaceOrigins=`, this.opdCalculator._surfaceOrigins);
                const stopOrigin = this.opdCalculator.getSurfaceOrigin(this.opdCalculator.stopSurfaceIndex);
                console.log(`🔍 [On-axis Check] stopOrigin=`, stopOrigin);
                
                // デバッグ用：グローバルに保存
                if (typeof window !== 'undefined') {
                    window.__DEBUG_STOP_INDEX = this.opdCalculator.stopSurfaceIndex;
                    window.__DEBUG_SURFACE_ORIGINS = this.opdCalculator._surfaceOrigins;
                    window.__DEBUG_STOP_ORIGIN = stopOrigin;
                }
                
                if (stopOrigin) {
                    const stopGlobalOffset = Math.sqrt(stopOrigin.x * stopOrigin.x + stopOrigin.y * stopOrigin.y);
                    console.log(`🔍 [On-axis Check] stopGlobalOffset=${stopGlobalOffset.toFixed(6)}mm (x=${stopOrigin.x.toFixed(6)}, y=${stopOrigin.y.toFixed(6)}, z=${stopOrigin.z.toFixed(6)})`);
                    
                    // デバッグ用：グローバルに保存
                    if (typeof window !== 'undefined') {
                        window.__DEBUG_STOP_OFFSET = stopGlobalOffset;
                    }
                    
                    if (stopGlobalOffset > 0.001) {
                        isOnAxisField = false;
                        console.log(`🔍 [On-axis Check] Field angle=0° but Stop surface global offset=${stopGlobalOffset.toFixed(6)}mm → treating as OFF-AXIS (CB shift detected)`);
                    } else {
                        console.log(`🔍 [On-axis Check] Field angle=0°, Stop surface global offset=${stopGlobalOffset.toFixed(6)}mm → treating as ON-AXIS`);
                    }
                } else {
                    console.warn(`⚠️ [On-axis Check] stopOrigin is null/undefined`);
                }
            } catch (err) {
                console.warn(`⚠️ [On-axis Check] Failed to check Stop surface position:`, err);
            }
        }
        
        if (typeof globalThis !== 'undefined') {
            globalThis.__REMOVE_ASYMMETRIC_ZERNIKE_FOR_ONAXIS = isOnAxisField;
        }
        
        // 四角形グリッドを生成
        if (prof) prof.marks.gridGenStart = now();
        emitProgress(5, 'grid', 'Generating pupil grid...');
        let hasExactCenterSample = false;
        // Yielding too frequently can dominate runtime for large grids.
        // Allow override via options.gridYieldEvery; otherwise use a coarser default for large maps.
        const gridYieldEvery = (options && Number.isFinite(options.gridYieldEvery))
            ? Math.max(1, Math.floor(Number(options.gridYieldEvery)))
            : (gridSize >= 256 ? 32 : (gridSize >= 128 ? 16 : 8));
        for (let i = 0; i < gridSize; i++) {
            for (let j = 0; j < gridSize; j++) {
                const pupilX = (i / (gridSize - 1)) * 2 * pupilRange - pupilRange;
                const pupilY = (j / (gridSize - 1)) * 2 * pupilRange - pupilRange;
                
                // 円形範囲内であることを確認
                const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
                if (pupilRadius <= pupilRange) {
                    // 元グリッドへ確実に戻せるよう、整数インデックスも保持
                    gridPoints.push({ x: pupilX, y: pupilY, ix: i, iy: j });
                    if (Math.abs(pupilX) < 1e-12 && Math.abs(pupilY) < 1e-12) {
                        hasExactCenterSample = true;
                    }
                }
            }

            // グリッド生成中も適度にyieldしてUIの固まりを回避
            if (i > 0 && (i % gridYieldEvery) === 0) {
                await this._yieldToUI();
                throwIfCancelled();
            }
        }

        // For even grid sizes, the linear grid does not include an exact 0.0.
        // Under extreme vignetting, only the true center ray may be traceable.
        if (!hasExactCenterSample) {
            const mid = (gridSize - 1) / 2;
            const ix0 = Math.max(0, Math.min(gridSize - 1, Math.round(mid)));
            const iy0 = Math.max(0, Math.min(gridSize - 1, Math.round(mid)));
            gridPoints.push({ x: 0, y: 0, ix: ix0, iy: iy0, isChief: true });
            console.log(`✅ Added exact center sample at (0,0) for gridSize=${gridSize}`);
        }
        
        // 🔍 診断: 軸上視野でのサンプリング対称性チェック（常に実行）
        const fieldAngleX = Math.abs(fieldSetting?.fieldAngle?.x || 0);
        const fieldAngleY = Math.abs(fieldSetting?.fieldAngle?.y || 0);
        console.log(`🔍 [Symmetry Check] Field angles: x=${fieldAngleX.toFixed(4)}°, y=${fieldAngleY.toFixed(4)}°`);
        
        if (fieldAngleX < 0.01 && fieldAngleY < 0.01) {
            console.log(`🔍 [On-axis Symmetry] Checking ${gridPoints.length} sample points...`);
            const quadrants = [0, 0, 0, 0]; // +x+y, -x+y, -x-y, +x-y
            for (const p of gridPoints) {
                if (Math.abs(p.x) < 1e-10 && Math.abs(p.y) < 1e-10) continue;
                const q = (p.x >= 0 ? 0 : 2) + (p.y >= 0 ? 0 : 1);
                quadrants[q]++;
            }
            console.log(`🔍 [On-axis Symmetry] Quadrant distribution: Q1=${quadrants[0]}, Q2=${quadrants[1]}, Q3=${quadrants[2]}, Q4=${quadrants[3]}`);
            const avg = quadrants.reduce((a,b)=>a+b) / 4;
            const maxDev = Math.max(...quadrants.map(q => Math.abs(q - avg)));
            console.log(`🔍 [On-axis Symmetry] Average per quadrant: ${avg.toFixed(1)}, max deviation: ${maxDev.toFixed(1)}`);
            if (maxDev > avg * 0.1) {
                console.warn(`⚠️ Quadrant asymmetry detected: max deviation ${maxDev.toFixed(1)} from average ${avg.toFixed(1)}`);
                console.warn(`⚠️ This will cause non-zero m≠0 Zernike terms for on-axis field!`);
            } else {
                console.log(`✅ Quadrant distribution is symmetric (deviation ${(maxDev/avg*100).toFixed(1)}%)`);
            }
            
            // Check OPD value symmetry - will be checked after ray tracing
            window.__checkOnAxisOPDSymmetry = true;
        }
        
        if (prof) prof.marks.gridGenEnd = now();
        emitProgress(8, 'grid', 'Pupil grid ready');

        // Evaluate points in a center-out, neighbor-connected order.
        if (prof) prof.marks.orderStart = now();
        // This BFS order keeps local continuity and lets us seed each solve from a neighbor's origin.
        // IMPORTANT: Avoid string keys; they are slow at large grids.
        const key = (ix, iy) => (iy * gridSize + ix);
        const pointByCell = new Map();
        for (const p of gridPoints) {
            if (Number.isInteger(p?.ix) && Number.isInteger(p?.iy)) {
                pointByCell.set(key(p.ix, p.iy), p);
            }
        }
        const ordered = [];
        const totalCells = Math.max(1, gridSize * gridSize);
        const visited = new Uint8Array(totalCells);
        const inOrdered = new Uint8Array(totalCells);
        const qx = [];
        const qy = [];
        let qh = 0;
        const mid = (gridSize - 1) / 2;
        const c0 = Math.floor(mid);
        const c1 = Math.ceil(mid);
        const centers = [
            [c0, c0],
            [c0, c1],
            [c1, c0],
            [c1, c1]
        ];
        for (const [ix, iy] of centers) {
            if (pointByCell.has(key(ix, iy))) {
                qx.push(ix);
                qy.push(iy);
            }
        }
        // Fallback if center cells are outside the circular mask
        if (!qx.length && gridPoints.length) {
            qx.push(gridPoints[0].ix);
            qy.push(gridPoints[0].iy);
        }
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        while (qh < qx.length) {
            const ix = qx[qh];
            const iy = qy[qh];
            qh++;
            const k = key(ix, iy);
            if (visited[k]) continue;
            visited[k] = 1;
            const p = pointByCell.get(k);
            if (p) {
                ordered.push(p);
                inOrdered[k] = 1;
            }
            for (const [dx, dy] of dirs) {
                const nx = ix + dx;
                const ny = iy + dy;
                if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
                const nk = key(nx, ny);
                if (visited[nk]) continue;
                if (pointByCell.has(nk)) {
                    qx.push(nx);
                    qy.push(ny);
                }
            }
        }
        // If for any reason we didn't visit all points, append the rest deterministically.
        if (ordered.length !== gridPoints.length) {
            for (const p of gridPoints) {
                const k = key(p.ix, p.iy);
                if (!inOrdered[k]) {
                    ordered.push(p);
                    inOrdered[k] = 1;
                }
            }
        }
        gridPoints = ordered;
        if (prof) prof.marks.orderEnd = now();

        // Store per-cell origin deltas for continuity seeding (infinite system only).
        // Delta = (finalOrigin - geomOrigin) is much safer to transfer than absolute origins.
        let originDeltaByCell = new Map();

        // Yielding too frequently can dominate runtime for large grids.
        // Allow override via options.yieldEvery; otherwise use a coarser default for large maps.
        const yieldEvery = (options && Number.isFinite(options.yieldEvery))
            ? Math.max(1, Math.floor(Number(options.yieldEvery)))
            : (gridPoints.length >= 2500 ? 512 : 64);
        
        // 各点でOPD計算を実行
        // NaNが多い画角では validPointCount が増えず、ログ条件が常に真になって
        // 「無限ループ」に見えるほどログが出ることがあるため、デバッグ出力は別カウンタで制限する。
        let debugLogCount = 0;
        let edgeCheckCount = 0;
        if (prof) {
            prof.marks.opdLoopStart = now();
            prof.opdCalls = 0;
            prof.opdCallMs = 0;
        }

        // IMPORTANT: If infinite pupilSamplingMode switches stop→entrance mid-loop (best-effort),
        // we must restart the entire sampling pass so a single wavefront map never mixes pupil
        // definitions/reference rays.
        const forcedInfinitePupilMode = (isInfiniteField && this.opdCalculator._getForcedInfinitePupilMode)
            ? this.opdCalculator._getForcedInfinitePupilMode()
            : null;
        const maxSamplingPasses = (isInfiniteField && !forcedInfinitePupilMode) ? 2 : 1;
        let restartedDueToModeSwitch = false;
        let restartedDueToStopUnreachable = false;
        let restartedDueToStopMiss = false;

        for (let samplingPass = 0; samplingPass < maxSamplingPasses; samplingPass++) {
            throwIfCancelled();
            // Reset accumulators for this pass.
            validPointCount = 0;
            invalidPointCount = 0;
            invalidReasonCounts = Object.create(null);
            validPupilMask = Array.from({ length: Math.max(2, Math.floor(Number(gridSize))) }, () => Array.from({ length: Math.max(2, Math.floor(Number(gridSize))) }, () => false));
            originDeltaByCell = new Map();
            wavefrontMap.pupilCoordinates = [];
            wavefrontMap.wavefrontAberrations = [];
            wavefrontMap.opds = [];
            wavefrontMap.opdsInWavelengths = [];
            if (recordRays) wavefrontMap.rayData = [];

            // Capture the mode at the *start* of this pass.
            let passMode = wavefrontMap.pupilSamplingMode;
            if (isInfiniteField) {
                try {
                    const m0 = forcedInfinitePupilMode || this.opdCalculator._getInfinitePupilMode(fieldSetting);
                    if (m0) passMode = m0;
                } catch (_) {}
                wavefrontMap.pupilSamplingMode = passMode;
                wavefrontMap.bestEffortVignettedPupil = (passMode === 'entrance');

                // Update per-pass physical radius in case the mode changed.
                try {
                    wavefrontMap.pupilPhysicalRadiusMm = getStopRadiusMm();
                    if (passMode === 'entrance') {
                        wavefrontMap.entranceEffectiveRadiusMm = getEntranceRadiusMm();
                    } else {
                        wavefrontMap.entranceEffectiveRadiusMm = NaN;
                    }
                } catch (_) {}

                if (OPD_DEBUG) {
                    console.log(`🧿 [Wavefront] infinite pupilSamplingMode(pass${samplingPass})=${passMode}`);
                    if (Number.isFinite(wavefrontMap.pupilPhysicalRadiusMm)) {
                        console.log(`🧿 [Wavefront] pupilPhysicalRadiusMm=${wavefrontMap.pupilPhysicalRadiusMm.toFixed(6)} (mode=${passMode})`);
                    }
                }

                try {
                    const usedRelax = !!this.opdCalculator._referenceRayUsedRelaxStopMissTol;
                    if (OPD_DEBUG && usedRelax) {
                        console.warn('🟡 [Wavefront] reference ray used relaxStopMissTol=true (may indicate solver fragility)');
                    }
                } catch (_) {}
            }

            let modeSwitchedMidPass = false;
            let switchedTo = null;
            let sawStopUnreachableThisPass = false;
            let stopMissCountThisPass = 0;

            for (let pointIndex = 0; pointIndex < gridPoints.length; pointIndex++) {

            // Cancellation point for long runs.
            if ((pointIndex % 256) === 0) {
                throwIfCancelled();
            }

            // Progress callback: update about ~100 times max to keep overhead low
            if (onProgress) {
                const total = gridPoints.length;
                const step = Math.max(1, Math.floor(total / 100));
                if (pointIndex === 0 || pointIndex === total - 1 || (pointIndex % step) === 0) {
                    const frac = total > 1 ? (pointIndex / (total - 1)) : 1;
                    emitProgress(10 + 75 * frac, 'sampling', `Sampling OPD... (${pointIndex + 1}/${total})`);
                }
            }

            // 進捗ログ（NaN多発でも必ず出る位置に置く）
            if (progressEvery > 0 && (pointIndex % progressEvery) === 0) {
                if (OPD_DEBUG) console.log(`⏳ 波面計算進捗: ${pointIndex}/${gridPoints.length}点 (有効=${validPointCount}, 無効=${invalidPointCount})`);
                // ログを出した直後に一度yieldして、ブラウザが固まって見えないようにする
                await this._yieldToUI();
                throwIfCancelled();
            }

            // 計算が重いときにUIが止まらないよう、一定回数ごとに制御を返す
            // NaNが多い画角でも必ず発火するよう「全点」でカウントする
            if (pointIndex > 0 && (pointIndex % yieldEvery) === 0) {
                await this._yieldToUI();
                throwIfCancelled();
            }

            const point = gridPoints[pointIndex];
            const pupilX = point.x;
            const pupilY = point.y;
            const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
            
            // 🆕 ログ削減: 主光線と重要な点のみログ出力
            const isChiefRay = point.isChief || (Math.abs(pupilX) < 1e-6 && Math.abs(pupilY) < 1e-6);
            const isEdgePoint = point.isEdge || (pupilRadius > 0.95); // 端点または外縁部
            const isImportantPoint = isEdgePoint || (pupilRadius > 0.9 && (pointIndex % 50 === 0)); // 外縁部の50点おき
            
            const shouldLogPoint = OPD_DEBUG && (isChiefRay || isImportantPoint) && debugLogCount < 200;
            if (shouldLogPoint) {
                console.log(`🔍 円形点[${pointIndex}]: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}) 半径=${pupilRadius.toFixed(3)}${isChiefRay ? ' [主光線]' : ''}${point.isEdge ? ' [端点]' : ''}`);
            }
            
            // 🆕 端点での実際の絞り面到達位置を確認
            if (OPD_DEBUG && isEdgePoint && edgeCheckCount < 10) {
                edgeCheckCount++;
                // 端点光線を生成して絞り面での位置を確認
                const edgeRay = this.opdCalculator.generateMarginalRay(pupilX, pupilY, fieldSetting);
                const stopPoint = this.opdCalculator.getStopPointFromRayData(edgeRay);
                if (stopPoint) {
                    const actualStopRadius = Math.sqrt(stopPoint.x * stopPoint.x + stopPoint.y * stopPoint.y);
                    console.log(`🎯 [端点到達確認] pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}) → 絞り面(${stopPoint.x.toFixed(3)}, ${stopPoint.y.toFixed(3)}) 実際半径=${actualStopRadius.toFixed(3)}mm / 設計半径=${stopRadius.toFixed(3)}mm`);
                } else {
                    console.warn(`⚠️ [端点到達確認] 絞り面交点が取得できません: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)})`);
                }
            }
            
            // 1点あたりの光線追跡は1回に抑える（この関数内では1回だけ呼ぶ）
            // Continuity delta hints from already-solved neighbor cells.
            let originDeltaHints = null;
            try {
                const ix = Number.isInteger(point?.ix) ? point.ix : null;
                const iy = Number.isInteger(point?.iy) ? point.iy : null;
                if (ix !== null && iy !== null) {
                    const n1 = originDeltaByCell.get(key(ix - 1, iy));
                    const n2 = originDeltaByCell.get(key(ix + 1, iy));
                    const n3 = originDeltaByCell.get(key(ix, iy - 1));
                    const n4 = originDeltaByCell.get(key(ix, iy + 1));
                    const hs = [];
                    if (n1) hs.push(n1);
                    if (n2) hs.push(n2);
                    if (n3) hs.push(n3);
                    if (n4) hs.push(n4);
                    originDeltaHints = hs.length ? hs : null;
                }
            } catch (_) {}

            // For dense wavefront grids, prefer a fast infinite marginal-ray solve.
            // If it fails specifically due to stop-miss / stop-unreachable, retry once with the full solver
            // (Jacobian/polish enabled) to avoid ending up with 0 valid points.
            const preferFast = true;
            // For entrance-pupil mode, keep the sampling scale fixed to the (design) stop radius,
            // and mask non-traceable regions as invalid (do NOT shrink the pupil to make everything valid).
            const pupilScaleRadiusMm = (isInfiniteField && passMode === 'entrance') ? stopRadius : undefined;
            const solveOptionsFast = originDeltaHints
                ? { originDeltaHints, fastMarginalRay: true, pupilScaleRadiusMm }
                : { fastMarginalRay: true, pupilScaleRadiusMm };
            const solveOptionsSlow = originDeltaHints
                ? { originDeltaHints, pupilScaleRadiusMm }
                : (pupilScaleRadiusMm ? { pupilScaleRadiusMm } : undefined);

            const computeOPD = (opts) => {
                if (prof) {
                    const t0 = now();
                    const v = (opdMode === 'referenceSphere')
                        ? this.opdCalculator.calculateOPDReferenceSphere(pupilX, pupilY, fieldSetting, false, opts)
                        : this.opdCalculator.calculateOPD(pupilX, pupilY, fieldSetting, opts);
                    const dt = now() - t0;
                    prof.opdCalls++;
                    prof.opdCallMs += Number.isFinite(dt) ? dt : 0;
                    return v;
                }
                return (opdMode === 'referenceSphere')
                    ? this.opdCalculator.calculateOPDReferenceSphere(pupilX, pupilY, fieldSetting, false, opts)
                    : this.opdCalculator.calculateOPD(pupilX, pupilY, fieldSetting, opts);
            };

            let usedSolveOptions = preferFast ? solveOptionsFast : solveOptionsSlow;
            let opd = preferFast ? computeOPD(solveOptionsFast) : computeOPD(solveOptionsSlow);

            // Targeted retry: only for stop-miss/unreachable failures in fast mode.
            // IMPORTANT: In infinite stop-mode, edge samples are often physically vignetted.
            // Retrying the full (slow) solver there can double work with little benefit.
            // We still retry for near-center points, or when the stop-miss is modest.
            if (!(isFinite(opd) && !isNaN(opd)) && preferFast) {
                try {
                    const last = this.opdCalculator.getLastRayCalculation?.();
                    const err = (last && typeof last.error === 'string') ? last.error : '';
                    const isStopMiss = err.includes('stop miss');
                    const isStopUnreachable = err.includes('stop unreachable');
                    const isStopRelated = (isStopMiss || isStopUnreachable);

                    // Forced stop-mode safety: when the user forces stop sampling, we cannot switch
                    // to entrance mode. However, a large stop-miss population makes the pupil
                    // extremely holey and can collapse PSF rendering (“sandstorm”). As a best-effort,
                    // retry ONCE per point with relaxStopMissTol to accept near-miss rays.
                    // This does not change the sampling mode; it only relaxes the gate.
                    if (isStopMiss && forcedInfinitePupilMode === 'stop') {
                        let okToRetryRelax = true;
                        try {
                            const m = /stop miss \(([0-9.+-eE]+)mm\s*>\s*([0-9.+-eE]+)mm\)/.exec(err);
                            if (m) {
                                const errMm = Number(m[1]);
                                const thrMm = Number(m[2]);
                                if (Number.isFinite(errMm) && Number.isFinite(thrMm) && thrMm > 0) {
                                    // If the mismatch is wildly outside the stop gate, don't accept it.
                                    okToRetryRelax = (errMm <= 2.0 * thrMm) || (errMm <= 0.35);
                                }
                            }
                        } catch (_) {
                            // keep default okToRetryRelax
                        }

                        if (okToRetryRelax) {
                            if (prof) prof.forcedStopRelaxStopMissRetry = (prof.forcedStopRelaxStopMissRetry || 0) + 1;
                            const withRelax = (o) => (o ? { ...o, relaxStopMissTol: true } : { relaxStopMissTol: true });
                            const relaxOpts = withRelax(usedSolveOptions);
                            usedSolveOptions = relaxOpts;
                            opd = computeOPD(relaxOpts);
                            if (prof) {
                                if (isFinite(opd) && !isNaN(opd)) prof.forcedStopRelaxStopMissRetryOk = (prof.forcedStopRelaxStopMissRetryOk || 0) + 1;
                                else prof.forcedStopRelaxStopMissRetryNg = (prof.forcedStopRelaxStopMissRetryNg || 0) + 1;
                            }
                        }
                    }

                    // If relax retry fixed it, skip other retries.
                    if (isFinite(opd) && !isNaN(opd)) {
                        // no-op
                    } else if (isStopRelated) {

                        if (prof) {
                            prof.fastToSlowRetryStopRelated = (prof.fastToSlowRetryStopRelated || 0) + 1;
                            if (err.includes('stop miss')) {
                                prof.fastRetryStopMiss = (prof.fastRetryStopMiss || 0) + 1;
                            } else if (err.includes('stop unreachable')) {
                                prof.fastRetryStopUnreachable = (prof.fastRetryStopUnreachable || 0) + 1;
                            }
                        }

                        // Empirical result (profile): slow retry almost never fixes "stop miss"
                        // (i.e., the ray does not correspond to the requested pupil coordinate).
                        // Retrying the slow solver there just doubles work. Only retry slow for
                        // "stop unreachable" (solver/geometry issues).
                        if (isStopUnreachable) {
                            if (prof) prof.fastToSlowRetrySlow = (prof.fastToSlowRetrySlow || 0) + 1;
                            usedSolveOptions = solveOptionsSlow;
                            opd = computeOPD(solveOptionsSlow);
                            if (prof) {
                                if (isFinite(opd) && !isNaN(opd)) prof.fastToSlowRetrySlowOk = (prof.fastToSlowRetrySlowOk || 0) + 1;
                                else prof.fastToSlowRetrySlowNg = (prof.fastToSlowRetrySlowNg || 0) + 1;
                            }
                        } else {
                            // stop miss -> treat as vignetted/invalid in stop-mode; do not slow retry.
                            if (prof) prof.fastToSlowRetrySkipped = (prof.fastToSlowRetrySkipped || 0) + 1;
                        }
                    }
                } catch (_) {
                    // ignore
                }
            }

            // Detect mode switch caused by OPD engine and restart the whole pass to keep consistency.
            // If the mode is globally forced, do not allow auto-switch/restart.
            if (isInfiniteField && !forcedInfinitePupilMode) {
                try {
                    const m = this.opdCalculator._getInfinitePupilMode(fieldSetting);
                    if (m && wavefrontMap.pupilSamplingMode && m !== wavefrontMap.pupilSamplingMode) {
                        modeSwitchedMidPass = true;
                        switchedTo = m;
                    }
                } catch (_) {
                    // ignore
                }
                if (modeSwitchedMidPass) {
                    if (OPD_DEBUG) {
                        console.warn(`🟣 [Wavefront] infinite pupilSamplingMode switched ${wavefrontMap.pupilSamplingMode}→${switchedTo} during sampling; restarting pass`);
                    }
                    wavefrontMap.pupilSamplingMode = switchedTo;
                    wavefrontMap.bestEffortVignettedPupil = (switchedTo === 'entrance');
                    restartedDueToModeSwitch = true;
                    break;
                }
            }
            const opdInWavelengths = (isFinite(opd) && !isNaN(opd)) ? (opd / this.opdCalculator.wavelength) : NaN;
            const wavefrontAberration = opdInWavelengths;
                
                // 🔧 **重要修正**: NaN値の厳格な検出と除外
                const isValidOPD = isFinite(opd) && !isNaN(opd);
                const isValidOPDWaves = isFinite(opdInWavelengths) && !isNaN(opdInWavelengths);
                const isValidWaveAberr = isFinite(wavefrontAberration) && !isNaN(wavefrontAberration);
                
            if (shouldLogPoint) {
                console.log(`  計算結果: OPD=${isValidOPD ? opd.toFixed(6) : 'NaN'}, OPDλ=${isValidOPDWaves ? opdInWavelengths.toFixed(6) : 'NaN'}, Wλ=${isValidWaveAberr ? wavefrontAberration.toFixed(6) : 'NaN'}`);
                debugLogCount++;
            }

            // NaN値がある場合はデータ点をスキップ
            if (!isValidOPD || !isValidOPDWaves || !isValidWaveAberr) {
                invalidPointCount++;
                const lastCalc = this.opdCalculator.getLastRayCalculation?.();
                const reason = (lastCalc && typeof lastCalc.error === 'string' && lastCalc.error) ? lastCalc.error : 'NaN';
                invalidReasonCounts[reason] = (invalidReasonCounts[reason] || 0) + 1;

                if (isInfiniteField && passMode === 'stop' && typeof reason === 'string' && reason.includes('stop miss')) {
                    stopMissCountThisPass++;
                }

                // For infinite systems in stop mode: if the CHIEF RAY (pupil=0,0) reports stop unreachable,
                // restart the entire map in entrance mode. Peripheral rays may naturally be vignetted,
                // so we only check the reference ray at pupil origin.
                const isPupilOrigin = Math.abs(pupilX) < 1e-9 && Math.abs(pupilY) < 1e-9;
                if (isInfiniteField && passMode === 'stop' && isPupilOrigin && typeof reason === 'string' && reason.includes('stop unreachable')) {
                    sawStopUnreachableThisPass = true;
                    if (OPD_DEBUG) console.warn(`⚠️ [Wavefront] Chief ray (pupil=0,0) is stop unreachable in stop mode, reason="${reason}"`);
                } else if (isInfiniteField && passMode === 'stop' && isPupilOrigin) {
                    // pupil=(0,0)が失敗したが、stop unreachableではない理由の場合もログ
                    if (OPD_DEBUG) console.warn(`⚠️ [Wavefront] Chief ray (pupil=0,0) failed with reason="${reason}" (not stop unreachable)`);
                }
                if (OPD_DEBUG && isImportantPoint && debugLogCount < 220) {
                    console.warn(`⚠️ NaN値検出によりスキップ: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}), reason="${reason}"`);
                    debugLogCount++;
                }
                continue; // この点をスキップして次へ
            }

            // After a successful solve, record the origin delta used for this grid cell.
            try {
                if (!this.opdCalculator.isFiniteSystem?.()) {
                    const d = this.opdCalculator._lastMarginalRayOriginDelta;
                    if (d && Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.z) && Number.isInteger(point?.ix) && Number.isInteger(point?.iy)) {
                        originDeltaByCell.set(key(point.ix, point.iy), { x: d.x, y: d.y, z: d.z });
                    }
                }
            } catch (_) {}
                
                // 🆕 Draw OPD Rays専用：ビネッティング判定を緩和（NaN除外後）
                const isVignetted = false; // NaN除外後は全て有効とする
                
                // 🆕 光線データを記録（描画用）
                const rayResult = recordRays ? this.opdCalculator.getLastRayCalculation() : null;

                // Profile-only diagnostic: measure how different referenceSphere vs simple is
                // at points where the solver actually succeeds, using the same solve options.
                if (prof) {
                    try {
                        if (!prof._opdModeCompare) {
                            prof._opdModeCompare = {
                                absMic: [],
                                absW: [],
                                refModeCounts: Object.create(null),
                                exampleImageSphereRadius: null
                            };
                        }
                        const cmp = prof._opdModeCompare;
                        if (cmp.absMic.length < 5) {
                            const vSimple = this.opdCalculator.calculateOPD(pupilX, pupilY, fieldSetting, usedSolveOptions);
                            const vRef = this.opdCalculator.calculateOPDReferenceSphere(pupilX, pupilY, fieldSetting, false, usedSolveOptions);
                            if (Number.isFinite(vSimple) && Number.isFinite(vRef)) {
                                const dMic = vRef - vSimple;
                                cmp.absMic.push(Math.abs(dMic));
                                cmp.absW.push(Math.abs(dMic / this.opdCalculator.wavelength));
                                try {
                                    const last = this.opdCalculator.getLastRayCalculation?.();
                                    const rm = last?.referenceSphere?.referenceMode;
                                    if (rm) cmp.refModeCounts[String(rm)] = (cmp.refModeCounts[String(rm)] || 0) + 1;
                                    const r = last?.referenceSphere?.imageSphereRadius;
                                    if (cmp.exampleImageSphereRadius === null && r !== undefined && r !== null) {
                                        cmp.exampleImageSphereRadius = r;
                                    }
                                } catch (_) {}
                            }
                        }
                    } catch (_) {}
                }
                
                // ログ出力での詳細確認
                if (OPD_DEBUG && pupilRadius > 0.8 && debugLogCount < 240) { // ログ上限
                    console.log(`🔍 [DrawOPD] 詳細チェック: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}), radius=${pupilRadius.toFixed(3)}`);
                    console.log(`  OPD: ${opd}, OPDλ: ${opdInWavelengths}, Wλ: ${wavefrontAberration}`);
                    console.log(`  isVignetted判定: ${isVignetted} (OPD=${opd})`);
                    if (rayResult) {
                        console.log(`  光線データ: path=${rayResult.ray?.path?.length || 'なし'}点`);
                    }
                    debugLogCount++;
                }
                
            // デバッグ: 最初の数点で光線データをチェック
            if (OPD_DEBUG && debugLogCount < 260) {
                console.log(`🔍 光線データ記録: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)})`);
                console.log(`  rayResult:`, rayResult ? '存在' : 'なし');
                console.log(`  rayResult.ray:`, rayResult?.ray ? '存在' : 'なし');
                console.log(`  ray.path:`, rayResult?.ray?.path ? `${rayResult.ray.path.length}点` : 'なし');
                console.log(`  isVignetted:`, isVignetted);
                debugLogCount++;
            }
            
            // 🔍 光線データの正規化（配列かオブジェクトかを判定）
            // NOTE: normalizedRay は現状使用していないため、recordRays のときのみ必要になれば復活させる
            
            // 有効なデータを記録
            if (isValidOPD && isValidOPDWaves && isValidWaveAberr) {
                const radius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);

                // Mark this grid cell as physically valid.
                try {
                    const ix = Number.isInteger(point?.ix) ? point.ix : null;
                    const iy = Number.isInteger(point?.iy) ? point.iy : null;
                    const g = validPupilMask.length;
                    if (ix !== null && iy !== null && ix >= 0 && iy >= 0 && ix < g && iy < g) {
                        validPupilMask[iy][ix] = true;
                    }
                } catch (_) {}

                wavefrontMap.pupilCoordinates.push({
                    x: pupilX,
                    y: pupilY,
                    r: radius,
                    ix: Number.isInteger(point?.ix) ? point.ix : undefined,
                    iy: Number.isInteger(point?.iy) ? point.iy : undefined
                });
                wavefrontMap.wavefrontAberrations.push(wavefrontAberration);
                wavefrontMap.opds.push(opd);
                wavefrontMap.opdsInWavelengths.push(opdInWavelengths);

                validPointCount++;
                
                // 🆕 光線データを記録（完全なデータのみ）
                if (recordRays && wavefrontMap.rayData && rayResult && rayResult.ray) {
                    
                    // 光線パス情報を正しく取得
                    let rayPath = null;
                    if (Array.isArray(rayResult.ray)) {
                        // rayResult.ray が配列の場合
                        rayPath = rayResult.ray;
                    } else if (rayResult.ray && rayResult.ray.path && Array.isArray(rayResult.ray.path)) {
                        // rayResult.ray.path が配列の場合
                        rayPath = rayResult.ray.path;
                    } else if (rayResult.ray && Array.isArray(rayResult.ray)) {
                        // その他の配列形式
                        rayPath = rayResult.ray;
                    }
                    
                    if (rayPath && rayPath.length > 0) {
                        wavefrontMap.rayData.push({
                            pupilX: pupilX,                    // 🔧 修正: pupilCoord.x → pupilX
                            pupilY: pupilY,                    // 🔧 修正: pupilCoord.y → pupilY  
                            pupilCoord: { x: pupilX, y: pupilY }, // 互換性のため両方保持
                            ray: { path: rayPath }, // 標準化された構造
                            opd: opd,
                            opdInWavelengths: opdInWavelengths,
                            wavefrontAberration: wavefrontAberration,
                            isVignetted: isVignetted
                        });
                    } else {
                        // Ray path invalid
                    }
                }
                } else {
                    // 失敗例の詳細ログ（最初の数例のみ）
                    if (validPointCount <= 3 && pointIndex < 10) {
                        console.log(`❌ 失敗例: pupil(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}), OPD=${opd}, OPDλ=${opdInWavelengths}, Wλ=${wavefrontAberration}`);
                        console.log(`  isFinite(opd)=${isFinite(opd)}, isFinite(opdλ)=${isFinite(opdInWavelengths)}, isFinite(Wλ)=${isFinite(wavefrontAberration)}`);
                    }
                }
                
            }

            // If we broke due to mode switch, restart if we still have a pass remaining.
            if (!forcedInfinitePupilMode && modeSwitchedMidPass && samplingPass + 1 < maxSamplingPasses) {
                // Ensure the reference ray is consistent with the *new* mode before re-sampling.
                try {
                    this.opdCalculator.referenceOpticalPath = null;
                    this.opdCalculator.setReferenceRay(fieldSetting);
                } catch (e) {
                    console.warn('⚠️ [Wavefront] failed to reset reference ray after mode switch', { error: String(e?.message || e) });
                }
                await this._yieldToUI();
                continue;
            }

            // If stop-mode sampling observed any "stop unreachable" failures, restart the whole map
            // in entrance mode (no mid-map switching; we just re-run consistently).
            if (!forcedInfinitePupilMode && isInfiniteField && passMode === 'stop' && sawStopUnreachableThisPass && samplingPass + 1 < maxSamplingPasses) {
                console.warn('🟣 [Wavefront] stop unreachable observed in stop mode; restarting in entrance pupil mode', {
                    fieldSetting,
                    invalidStopUnreachable: true
                });
                restartedDueToStopUnreachable = true;
                try {
                    this.opdCalculator._setInfinitePupilMode(fieldSetting, 'entrance');
                    // Best effort: clear per-field caches so entrance config is rebuilt cleanly.
                    const k = this.opdCalculator.getFieldCacheKey?.(fieldSetting);
                    if (k) this.opdCalculator._chiefRayCache?.delete(k);
                    const ek = this.opdCalculator._getInfinitePupilModeKey?.(fieldSetting);
                    if (ek) this.opdCalculator._entrancePupilConfigCache?.delete(ek);
                } catch (_) {
                    // ignore
                }
                try {
                    this.opdCalculator.referenceOpticalPath = null;
                    this.opdCalculator.setReferenceRay(fieldSetting);
                } catch (e) {
                    console.warn('⚠️ [Wavefront] failed to reset reference ray for entrance mode', { error: String(e?.message || e) });
                }
                wavefrontMap.pupilSamplingMode = 'entrance';
                wavefrontMap.bestEffortVignettedPupil = true;
                await this._yieldToUI();
                continue;
            }

            // If stop-mode sampling produces many "stop miss" failures, prefer entrance mode.
            // Rationale: stop miss means the pupil coordinate does not correspond to the requested stop position;
            // in such cases the stop-mode mapping is often unstable and leads to a holey pupil.
            if (!forcedInfinitePupilMode && isInfiniteField && passMode === 'stop' && samplingPass + 1 < maxSamplingPasses) {
                const total = validPointCount + invalidPointCount;
                const frac = total > 0 ? (stopMissCountThisPass / total) : 0;
                const minFrac = (typeof globalThis !== 'undefined' && Number.isFinite(globalThis.__WAVEFRONT_STOPMISS_FALLBACK_FRAC))
                    ? Math.max(0, Math.min(1, Number(globalThis.__WAVEFRONT_STOPMISS_FALLBACK_FRAC)))
                    : 0.05;
                const minCount = (typeof globalThis !== 'undefined' && Number.isFinite(globalThis.__WAVEFRONT_STOPMISS_FALLBACK_MIN_COUNT))
                    ? Math.max(1, Math.floor(Number(globalThis.__WAVEFRONT_STOPMISS_FALLBACK_MIN_COUNT)))
                    : 250;

                if (stopMissCountThisPass >= minCount && frac >= minFrac) {
                    console.warn('🟣 [Wavefront] stop miss dominant in stop mode; restarting in entrance pupil mode', {
                        fieldSetting,
                        stopMissCount: stopMissCountThisPass,
                        total,
                        frac,
                        minFrac,
                        minCount
                    });
                    restartedDueToStopMiss = true;
                    try {
                        this.opdCalculator._setInfinitePupilMode(fieldSetting, 'entrance');
                        // Best effort: clear per-field caches so entrance config is rebuilt cleanly.
                        const k = this.opdCalculator.getFieldCacheKey?.(fieldSetting);
                        if (k) this.opdCalculator._chiefRayCache?.delete(k);
                        const ek = this.opdCalculator._getInfinitePupilModeKey?.(fieldSetting);
                        if (ek) this.opdCalculator._entrancePupilConfigCache?.delete(ek);
                    } catch (_) {
                        // ignore
                    }
                    try {
                        this.opdCalculator.referenceOpticalPath = null;
                        this.opdCalculator.setReferenceRay(fieldSetting);
                    } catch (e) {
                        console.warn('⚠️ [Wavefront] failed to reset reference ray for entrance mode (stop miss fallback)', { error: String(e?.message || e) });
                    }
                    wavefrontMap.pupilSamplingMode = 'entrance';
                    wavefrontMap.bestEffortVignettedPupil = true;
                    await this._yieldToUI();
                    continue;
                }
            }

            // Completed a full pass without switching.
            break;
        }

        emitProgress(86, 'sampling', 'Sampling complete');

            // Update the mode to reflect what was actually used by the OPD engine.
            if (isInfiniteField) {
                try {
                    const finalMode = forcedInfinitePupilMode || this.opdCalculator._getInfinitePupilMode(fieldSetting);
                    if (finalMode && finalMode !== wavefrontMap.pupilSamplingMode) wavefrontMap.pupilSamplingMode = finalMode;
                    wavefrontMap.bestEffortVignettedPupil = (wavefrontMap.pupilSamplingMode === 'entrance');
                    console.log(`🧿 [Wavefront] infinite pupilSamplingMode(final)=${wavefrontMap.pupilSamplingMode}`);
                } catch (_) {
                    // ignore
                }
            }

            // Expose the validity mask so downstream rendering (OPD/PSF) can respect vignetting.
            wavefrontMap.validPupilMask = validPupilMask;
            wavefrontMap.validPupilMaskGridSize = validPupilMask.length;

        if (prof) {
            prof.marks.opdLoopEnd = now();
        }

        wavefrontMap.invalidReasonCounts = invalidReasonCounts;
        wavefrontMap.restartedDueToModeSwitch = restartedDueToModeSwitch;
        wavefrontMap.restartedDueToStopUnreachable = restartedDueToStopUnreachable;
        wavefrontMap.restartedDueToStopMiss = restartedDueToStopMiss;
        try {
            const top = Object.entries(invalidReasonCounts)
                .sort((a, b) => (b[1] || 0) - (a[1] || 0))
                .slice(0, 5);
            if (top.length) {
                console.log(`📉 無効理由(上位): ${top.map(([k, v]) => `${k}:${v}`).join(', ')}`);
            }
        } catch (_) {
            // ignore
        }
        if (OPD_DEBUG) {
            if (recordRays && wavefrontMap.rayData) {
                console.log(`📊 光線データ: ${wavefrontMap.rayData.length}本記録`);
            }
            console.log(`🔍 統計計算開始`);
        }

        // If nothing is valid, emit a tiny probe to clarify whether this is a strict-stop issue
        // (stop mode) or a true "no ray reaches eval" condition.
        if (validPointCount === 0) {
            try {
                const isFinite = this.opdCalculator.isFiniteForField(fieldSetting);
                const mode = !isFinite ? this.opdCalculator._getInfinitePupilMode(fieldSetting) : 'finite';

                // Additionally, trace the chief ray once (same policy as Draw Cross) to help
                // reconcile “stop unreachable / 0 valid” vs Draw Cross “rays pass”.
                let chiefRayOk = null;
                let chiefRaySummary = null;
                if (!isFinite) {
                    try {
                        const chief = this.opdCalculator.generateInfiniteChiefRay(fieldSetting);
                        chiefRayOk = !!chief;
                        if (chief && Array.isArray(chief) && chief.length >= 2) {
                            const p0 = chief[0];
                            const p1 = chief[Math.min(chief.length - 1, 1)];
                            chiefRaySummary = {
                                start: {
                                    x: Number(p0?.x),
                                    y: Number(p0?.y),
                                    z: Number(p0?.z)
                                },
                                second: {
                                    x: Number(p1?.x),
                                    y: Number(p1?.y),
                                    z: Number(p1?.z)
                                },
                                points: chief.length
                            };
                        }
                    } catch (e) {
                        chiefRayOk = false;
                        chiefRaySummary = { error: String(e?.message || e) };
                    }
                }

                const probePts = [
                    { x: 0, y: 0 },
                    { x: 0.05, y: 0 },
                    { x: 0, y: 0.05 }
                ];
                const results = [];
                for (const p of probePts) {
                    const opdFast = this.opdCalculator.calculateOPD(p.x, p.y, fieldSetting, { fastMarginalRay: true });
                    const errFast = this.opdCalculator.getLastRayCalculation?.()?.error || null;
                    const opdSlow = this.opdCalculator.calculateOPD(p.x, p.y, fieldSetting, undefined);
                    const errSlow = this.opdCalculator.getLastRayCalculation?.()?.error || null;
                    results.push({ p, opdFast: Number.isFinite(opdFast) ? opdFast : null, errFast, opdSlow: Number.isFinite(opdSlow) ? opdSlow : null, errSlow });
                }
                const shorten = (s) => {
                    try {
                        if (s == null) return null;
                        const str = String(s);
                        return str.length > 220 ? (str.slice(0, 217) + '...') : str;
                    } catch (_) {
                        return null;
                    }
                };
                const summary = results.map((r) => ({
                    p: `(${Number(r?.p?.x).toFixed(3)},${Number(r?.p?.y).toFixed(3)})`,
                    opdFast: r?.opdFast,
                    errFast: shorten(r?.errFast),
                    opdSlow: r?.opdSlow,
                    errSlow: shorten(r?.errSlow)
                }));
                console.warn('🧪 [Wavefront] 0 valid samples probe', { mode, chiefRayOk, chiefRaySummary, results });
                // Also print as a single JSON string so the console doesn't hide nested fields.
                console.warn('🧪 [Wavefront] 0 valid samples probe (summaryJSON)', JSON.stringify({ mode, chiefRayOk, chiefRaySummary, summary }));
            } catch (_) {
                // ignore
            }
        }

        // ✅ 瞳マスクが「本当に分断」されているかを診断（連結成分数）
        try {
            const g = Math.max(2, Math.floor(Number(gridSize)));
            const mask = Array.from({ length: g }, () => Array.from({ length: g }, () => 0));
            const coords = wavefrontMap.pupilCoordinates || [];
            for (const c of coords) {
                const ix = Number.isInteger(c?.ix) ? c.ix : null;
                const iy = Number.isInteger(c?.iy) ? c.iy : null;
                if (ix === null || iy === null) continue;
                if (ix < 0 || ix >= g || iy < 0 || iy >= g) continue;
                mask[iy][ix] = 1;
            }

            const visited = Array.from({ length: g }, () => Array.from({ length: g }, () => false));
            const dirs = [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1]
            ];

            let components = 0;
            let largest = 0;
            let total = 0;

            for (let y = 0; y < g; y++) {
                for (let x = 0; x < g; x++) {
                    if (mask[y][x] !== 1) continue;
                    total++;
                    if (visited[y][x]) continue;
                    components++;
                    let size = 0;
                    const q = [[x, y]];
                    visited[y][x] = true;
                    while (q.length) {
                        const [cx, cy] = q.pop();
                        size++;
                        for (const [dx, dy] of dirs) {
                            const nx = cx + dx;
                            const ny = cy + dy;
                            if (nx < 0 || nx >= g || ny < 0 || ny >= g) continue;
                            if (visited[ny][nx]) continue;
                            if (mask[ny][nx] !== 1) continue;
                            visited[ny][nx] = true;
                            q.push([nx, ny]);
                        }
                    }
                    if (size > largest) largest = size;
                }
            }

            wavefrontMap.pupilMaskStats = { gridSize: g, occupiedCells: total, components, largestComponent: largest };
        } catch (_) {
            // ignore
        }

        // raw を退避
        wavefrontMap.raw = {
            wavefrontAberrations: [...wavefrontMap.wavefrontAberrations],
            opds: [...wavefrontMap.opds],
            opdsInWavelengths: [...wavefrontMap.opdsInWavelengths]
        };
        
        // Check OPD value symmetry for on-axis fields
        if (window.__checkOnAxisOPDSymmetry && wavefrontMap.pupilCoordinates && wavefrontMap.opds) {
            window.__checkOnAxisOPDSymmetry = false; // Clear flag
            console.log(`🔍 [OPD Symmetry] Checking ${wavefrontMap.opds.length} OPD values...`);
            
            // Build map of OPD values by mirrored pupil positions
            const tolerance = 1e-6; // Tolerance for coordinate matching
            const opdPairs = new Map(); // Key: "x,y" -> OPD value
            
            for (let i = 0; i < wavefrontMap.pupilCoordinates.length; i++) {
                const coord = wavefrontMap.pupilCoordinates[i];
                const opd = wavefrontMap.opds[i];
                const x = coord.x;
                const y = coord.y;
                const key = `${x.toFixed(6)},${y.toFixed(6)}`;
                opdPairs.set(key, opd);
            }
            
            // Check symmetry across X and Y axes
            let asymmetryCount = 0;
            let maxAsymmetry = 0;
            let exampleAsymmetry = null;
            
            for (let i = 0; i < wavefrontMap.pupilCoordinates.length; i++) {
                const coord = wavefrontMap.pupilCoordinates[i];
                const opd = wavefrontMap.opds[i];
                const x = coord.x;
                const y = coord.y;
                
                // Check mirror across Y-axis (should have same OPD for rotationally symmetric aberration)
                const mirrorXKey = `${(-x).toFixed(6)},${y.toFixed(6)}`;
                const mirrorYKey = `${x.toFixed(6)},${(-y).toFixed(6)}`;
                
                const opdMirrorX = opdPairs.get(mirrorXKey);
                const opdMirrorY = opdPairs.get(mirrorYKey);
                
                if (opdMirrorX !== undefined && Math.abs(opd - opdMirrorX) > tolerance) {
                    asymmetryCount++;
                    const diff = Math.abs(opd - opdMirrorX);
                    if (diff > maxAsymmetry) {
                        maxAsymmetry = diff;
                        exampleAsymmetry = {
                            coord: {x, y},
                            opd,
                            mirror: {x: -x, y},
                            opdMirror: opdMirrorX,
                            diff
                        };
                    }
                }
                
                if (opdMirrorY !== undefined && Math.abs(opd - opdMirrorY) > tolerance) {
                    asymmetryCount++;
                    const diff = Math.abs(opd - opdMirrorY);
                    if (diff > maxAsymmetry) {
                        maxAsymmetry = diff;
                        exampleAsymmetry = {
                            coord: {x, y},
                            opd,
                            mirror: {x, y: -y},
                            opdMirror: opdMirrorY,
                            diff
                        };
                    }
                }
            }
            
            console.log(`🔍 [OPD Symmetry] Asymmetric pairs: ${asymmetryCount}, max difference: ${maxAsymmetry.toExponential(3)} μm`);
            if (exampleAsymmetry) {
                console.log(`🔍 [OPD Symmetry] Example:`, exampleAsymmetry);
                console.log(`  Point (${exampleAsymmetry.coord.x.toFixed(3)}, ${exampleAsymmetry.coord.y.toFixed(3)}): OPD = ${exampleAsymmetry.opd.toFixed(6)} μm`);
                console.log(`  Mirror (${exampleAsymmetry.mirror.x.toFixed(3)}, ${exampleAsymmetry.mirror.y.toFixed(3)}): OPD = ${exampleAsymmetry.opdMirror.toFixed(6)} μm`);
                console.log(`  Difference: ${exampleAsymmetry.diff.toExponential(3)} μm (${(exampleAsymmetry.diff/this.opdCalculator.wavelength).toExponential(3)} waves)`);
            }
            
            if (asymmetryCount === 0) {
                console.log(`✅ OPD values are perfectly symmetric`);
            } else {
                console.warn(`⚠️ OPD asymmetry detected! This explains non-zero m≠0 Zernike terms.`);
            }
        }

        // If nothing is valid, do not proceed to Zernike/model rendering (it would yield all-zeros).
        if (!Array.isArray(wavefrontMap.raw.opds) || wavefrontMap.raw.opds.length === 0) {
            // Best-effort fallback: if stop-based sampling yields nothing (extreme vignetting),
            // retry once using entrance-pupil mode.
            try {
                const isFinite = this.opdCalculator.isFiniteForField(fieldSetting);
                const mode = !isFinite ? this.opdCalculator._getInfinitePupilMode(fieldSetting) : null;
                const forced = (!isFinite && this.opdCalculator._getForcedInfinitePupilMode)
                    ? this.opdCalculator._getForcedInfinitePupilMode()
                    : null;
                const alreadyRetried = !!options?._bestEffortEntranceRetry;
                if (!alreadyRetried && !isFinite && !forced && mode === 'stop') {
                    console.warn('⚠️ 有効OPDサンプルが0点: entrance瞳ベストエフォートで再試行します');
                    this.opdCalculator._setInfinitePupilMode(fieldSetting, 'entrance');
                    return await this.generateWavefrontMap(fieldSetting, requestedGridSize, gridPattern, {
                        ...(options || {}),
                        _bestEffortEntranceRetry: true
                    });
                }
            } catch (_) {
                // ignore
            }

            // If we're here, even best-effort entrance mode didn't yield any traceable rays.
            // Emit a deterministic center-ray termination diagnosis so we know which surface kills the trace.
            try {
                const isFinite = this.opdCalculator.isFiniteForField(fieldSetting);
                const mode = !isFinite ? this.opdCalculator._getInfinitePupilMode(fieldSetting) : 'finite';
                if (!isFinite) {
                    const diag = this.opdCalculator._diagnoseCenterRayTermination?.(fieldSetting);
                    if (diag) {
                        console.warn('🧭 [Wavefront] center-ray termination diagnosis', { mode, diag });
                        console.warn('🧭 [Wavefront] center-ray termination diagnosis (JSON)', JSON.stringify({ mode, diag }));

                        // Provide a compact hint for the UI failure panel.
                        try {
                            if (diag?.failure?.kind === 'PHYSICAL_APERTURE_BLOCK') {
                                const sidx = Number.isFinite(diag.failSurfaceIndex) ? diag.failSurfaceIndex : null;
                                const cmt = diag?.surface?.comment ? String(diag.surface.comment).trim() : '';
                                const st = diag?.surface?.surfType ? String(diag.surface.surfType).trim() : '';
                                const hit = Number.isFinite(diag?.failure?.hitRadius) ? diag.failure.hitRadius : null;
                                const lim = Number.isFinite(diag?.failure?.apertureLimit) ? diag.failure.apertureLimit : null;
                                const hint = `hint=Blocked at surfaceIndex=${sidx}${cmt ? ` (${cmt})` : ''}${st ? ` [${st}]` : ''}: hitRadius=${hit}mm > apertureLimit=${lim}mm`;
                                wavefrontMap._unavailableHint = hint;
                            }
                        } catch (_) {}
                    }
                }
            } catch (_) {
                // ignore
            }

            wavefrontMap.error = {
                message: `No valid OPD samples (all rays failed)${wavefrontMap._unavailableHint ? `; ${wavefrontMap._unavailableHint}` : ''}`
            };
            if (prof) {
                prof.tEnd = now();
                prof.marks.end = prof.tEnd;
                if (OPD_DEBUG) {
                    console.log('⏱️ [WavefrontProfile] summary:', {
                        profileVersion: '2025-12-31-breakdown-v1',
                        gridSize,
                        points: gridPoints?.length || 0,
                        recordRays,
                        opdMode,
                        renderFromZernike,
                        zernikeMaxNollOpt,
                        totalMs: Number.isFinite(prof.tEnd - prof.tStart) ? (prof.tEnd - prof.tStart).toFixed(1) : (prof.tEnd - prof.tStart),
                        refMs: null,
                        gridMs: null,
                        orderMs: null,
                        opdLoopMs: null,
                        avgOpdCallMs: (prof.opdCalls > 0) ? (prof.opdCallMs / prof.opdCalls).toFixed(3) : null,
                        zernikeFitMs: null,
                        zernikeModelMs: null,
                        applyRemovedMs: null,
                        traceRayToSurfaceCount: prof.traceRayToSurfaceCount || 0,
                        traceRayToSurfaceMs: Number.isFinite(prof.traceRayToSurfaceMs) ? prof.traceRayToSurfaceMs.toFixed(1) : (prof.traceRayToSurfaceMs || 0),
                        traceRayToEvalCount: prof.traceRayToEvalCount || 0,
                        finalStopReuseCount: (typeof prof.finalStopReuseCount === 'number') ? prof.finalStopReuseCount : null,
                        finalStopFallbackCount: (typeof prof.finalStopFallbackCount === 'number') ? prof.finalStopFallbackCount : null,
                        marginalRayFiniteCalls: prof.marginalRayFiniteCalls || 0,
                        marginalRayInfiniteCalls: prof.marginalRayInfiniteCalls || 0,
                        finiteStopCorrectionCalls: prof.finiteStopCorrectionCalls || 0,
                        finiteStopCorrectionIters: prof.finiteStopCorrectionIters || 0,
                        finiteStopCorrectionFastCalls: prof.finiteStopCorrectionFastCalls || 0,
                        finiteStopHitCount: prof.finiteStopHitCount || 0,
                        finiteBrentFallbackCount: prof.finiteBrentFallbackCount || 0,
                        finiteBrentFallbackFastCount: prof.finiteBrentFallbackFastCount || 0,
                        finiteInitialTraceNullCount: prof.finiteInitialTraceNullCount || 0,
                        finiteEvalNullWithStopHitCount: prof.finiteEvalNullWithStopHitCount || 0,
                        finiteDirectionSolveSkippedDueToStopHit: prof.finiteDirectionSolveSkippedDueToStopHit || 0,
                        finiteDirectionSolveSkippedDueToNoStopHit: prof.finiteDirectionSolveSkippedDueToNoStopHit || 0,
                        finiteNoStopHitFastFallbackAttempted: prof.finiteNoStopHitFastFallbackAttempted || 0,
                        finiteNoStopHitFastFallbackSucceeded: prof.finiteNoStopHitFastFallbackSucceeded || 0,
                        finiteDirectionSolveCalls: prof.finiteDirectionSolveCalls || 0,
                        finiteDirectionSolveFastCalls: prof.finiteDirectionSolveFastCalls || 0,
                        finiteDirectionSolveFallbackCalls: prof.finiteDirectionSolveFallbackCalls || 0,
                        finiteDirectionSolveFallbackFastCalls: prof.finiteDirectionSolveFallbackFastCalls || 0,
                        finiteDirectionSolveMs: Number.isFinite(prof.finiteDirectionSolveMs) ? prof.finiteDirectionSolveMs.toFixed(1) : (prof.finiteDirectionSolveMs || 0),
                        marginalRayCalls: prof.marginalRayCalls || 0,
                        marginalRayMs: Number.isFinite(prof.marginalRayMs) ? prof.marginalRayMs.toFixed(1) : (prof.marginalRayMs || 0),
                        opticalPathCalls: prof.opticalPathCalls || 0,
                        opticalPathMs: Number.isFinite(prof.opticalPathMs) ? prof.opticalPathMs.toFixed(1) : (prof.opticalPathMs || 0),
                        opticalPathCacheRebuilds: prof.opticalPathCacheRebuilds || 0
                    });
                    this.opdCalculator._wavefrontProfile = null;
                }
            }
            console.error('❌ 有効なOPDサンプルが0点のため、Zernike/描画用モデル生成をスキップします');
            return wavefrontMap;
        }

        // Zernike/統計は一括処理で重くなり得るため、ここで一度yield
        await this._yieldToUI();

        // Zernike fit（OPD[μm]）
        emitProgress(90, 'zernike-fit', 'Fitting Zernike model...');
        if (prof) prof.marks.zernikeFitStart = now();

        const sampleCount = Array.isArray(wavefrontMap.raw.opds) ? wavefrontMap.raw.opds.length : 0;
        
        // Skip Zernike fitting if requested
        if (skipZernikeFit) {
            if (OPD_DEBUG) console.log('⚡ Zernike fitting skipped (skipZernikeFit=true)');
            wavefrontMap.zernike = null;
            emitProgress(95, 'zernike-fit', 'Zernike fit skipped');
        } else {
            const zernikeMaxNollForFit = Math.max(1, Math.min(zernikeMaxNollOpt, sampleCount));
            if (zernikeMaxNollForFit < zernikeMaxNollOpt) {
                console.warn(`⚠️ 有効サンプル数が少ないため、Zernike項数を ${zernikeMaxNollForFit} に制限します（要求=${zernikeMaxNollOpt}, 有効点=${sampleCount}）`);
            }
            const zernikeFit = this.fitZernikePolynomials({
                pupilCoordinates: wavefrontMap.pupilCoordinates,
                opds: wavefrontMap.raw.opds
            }, zernikeMaxNollForFit);
            
            // 軸上視野では物理的にm≠0項は存在しないため強制除去
            const fieldAngleX_zernike = Math.abs(fieldSetting?.fieldAngle?.x || 0);
            const fieldAngleY_zernike = Math.abs(fieldSetting?.fieldAngle?.y || 0);
            
            if (fieldAngleX_zernike < 0.01 && fieldAngleY_zernike < 0.01) {
                console.log(`🔧 [On-axis Correction] Removing m≠0 Zernike terms (physically impossible for on-axis field)`);
                
                // OSA/ANSI indexでm≠0の項を特定して除去
                let removedCount = 0;
                const maxJ = Math.max(0, ...Object.keys(zernikeFit.coefficientsMicrons || {}).map(Number).filter(Number.isFinite));
                
                for (let j = 0; j <= maxJ; j++) {
                    // OSA index j から (n, m) を計算
                    const n = Math.floor((-1 + Math.sqrt(1 + 8 * j)) / 2);
                    const m = 2 * j - n * (n + 2);
                    
                    // m ≠ 0 の項を除去
                    if (m !== 0) {
                        const beforeValue = zernikeFit.coefficientsMicrons[j];
                        if (beforeValue !== undefined && beforeValue !== 0) {
                            zernikeFit.coefficientsMicrons[j] = 0;
                            if (zernikeFit.coefficientsWaves && zernikeFit.coefficientsWaves[j] !== undefined) {
                                zernikeFit.coefficientsWaves[j] = 0;
                            }
                            if (removedCount < 5) {
                                console.log(`  Removed j=${j} (n=${n}, m=${m}): ${beforeValue.toExponential(3)} μm → 0`);
                            }
                            removedCount++;
                        }
                    }
                }
                
                console.log(`🔧 [On-axis Correction] Removed ${removedCount} asymmetric terms`);
            }
            
            wavefrontMap.zernike = zernikeFit;
            emitProgress(95, 'zernike-fit', 'Zernike fit done');
        }
        if (prof) prof.marks.zernikeFitEnd = now();

        // Requested rendering mode: draw the Zernike-fitted function itself (no removal / no smoothing of data).
        // We keep raw samples in wavefrontMap.raw for diagnostics.
        if (renderFromZernike && wavefrontMap.zernike?.coefficientsMicrons) {
            emitProgress(97, 'zernike-render', 'Rendering from Zernike model...');
            if (prof) prof.marks.zernikeModelStart = now();
            const zernikeFit = wavefrontMap.zernike;
            const maxNollUsed = Math.max(1, Math.min(zernikeFit.maxNoll || zernikeMaxNollOpt, zernikeMaxNollOpt));
            const wavelength = this.opdCalculator.wavelength;

            // Coefficients used for rendering.
            // IMPORTANT: fitZernikePolynomials() produces OSA/ANSI-indexed coefficients (j=0..).
            // NOTE: OPD display mode (piston/tilt removal) is a *view transform* handled separately.
            // Keep the underlying Zernike model intact here so that toggling OPD display actually changes the plot.
            const displayRemovedOSA = [];
            const fitCoefficientsMicrons = { ...zernikeFit.coefficientsMicrons };
            const usedCoefficientsMicrons = { ...fitCoefficientsMicrons };

            const maxJUsed = Number.isFinite(maxNollUsed) ? Math.max(1, Math.floor(maxNollUsed))
                : (Math.max(0, ...Object.keys(usedCoefficientsMicrons).map(Number).filter(Number.isFinite)) + 1);
            const usedCoeffsArray = new Array(maxJUsed).fill(0);
            for (let j = 0; j < maxJUsed; j++) {
                const c = Number(usedCoefficientsMicrons?.[j] ?? 0);
                usedCoeffsArray[j] = Number.isFinite(c) ? c : 0;
            }

            const evalAt = (x, y, ix = null, iy = null) => {
                if (!Number.isFinite(x) || !Number.isFinite(y)) return NaN;
                const rho = Math.hypot(x, y) / (Number.isFinite(wavefrontMap.pupilRange) && wavefrontMap.pupilRange > 0 ? wavefrontMap.pupilRange : 1.0);
                if (rho > 1.0 + 1e-9) return NaN;

                // Respect physical validity: do not fill regions where rays failed (eval unreachable / vignetting).
                try {
                    const mask = wavefrontMap?.validPupilMask;
                    if (Array.isArray(mask) && Number.isInteger(ix) && Number.isInteger(iy)) {
                        if (!mask?.[iy]?.[ix]) return NaN;
                    }
                } catch (_) {
                    // ignore
                }

                const pr = (Number.isFinite(wavefrontMap.pupilRange) && wavefrontMap.pupilRange > 0) ? wavefrontMap.pupilRange : 1.0;
                const xn = x / pr;
                const yn = y / pr;
                return reconstructOPD(usedCoeffsArray, xn, yn);
            };

            // If we are not recording rays, it's safe to render on the full grid mask (fills holes deterministically).
            const canExpand = !recordRays;
            const srcPoints = canExpand && Array.isArray(gridPoints) && gridPoints.length ? gridPoints : (wavefrontMap.pupilCoordinates || []);
            const coords = [];
            const modelMicrons = [];
            const modelWaves = [];
            for (const p of srcPoints) {
                const x = Number(p?.x);
                const y = Number(p?.y);
                const ix = Number.isInteger(p?.ix) ? p.ix : null;
                const iy = Number.isInteger(p?.iy) ? p.iy : null;
                const m = evalAt(x, y, ix, iy);
                coords.push({
                    x,
                    y,
                    r: Math.hypot(x, y),
                    ix: Number.isInteger(p?.ix) ? p.ix : undefined,
                    iy: Number.isInteger(p?.iy) ? p.iy : undefined
                });
                modelMicrons.push(m);
                modelWaves.push(Number.isFinite(m) && Number.isFinite(wavelength) && wavelength > 0 ? (m / wavelength) : NaN);
            }

            wavefrontMap.zernikeModel = {
                // Backward-compat: keep the existing field name, but it now means
                // "max OSA/ANSI term count" (j=0..max-1).
                maxNollUsed: maxJUsed,
                fitCoefficientsMicrons,
                // Backward-compat: keep old name (now contains OSA indices).
                displayRemovedNoll: displayRemovedOSA,
                displayRemovedOSA,
                usedCoefficientsMicrons,
                opds: modelMicrons,
                opdsInWavelengths: modelWaves
            };

            wavefrontMap.renderFromZernike = true;

            wavefrontMap.pupilCoordinates = coords;
            wavefrontMap.opds = modelMicrons;
            wavefrontMap.opdsInWavelengths = modelWaves;
            wavefrontMap.wavefrontAberrations = modelWaves;
            if (prof) prof.marks.zernikeModelEnd = now();
            emitProgress(99, 'zernike-render', 'Zernike render grid ready');
        }

        // NOTE: removedModel の適用は「表示上の参照面」を変える操作であり、
        // 必ずしも常に適用したいとは限らない（例: 生OPDを見たい、tiltを残したい等）。
        // UI追加なしで切替できるよう globalThis フラグを用意する。
        const applyRemovedModel = !renderFromZernike && !(typeof globalThis !== 'undefined' && globalThis.__WAVEFRONT_APPLY_REMOVED_MODEL === false);

        if (applyRemovedModel && wavefrontMap.zernike?.removedModelMicrons?.length === wavefrontMap.opds.length) {
            if (prof) prof.marks.applyRemovedStart = now();
            const zernikeFit = wavefrontMap.zernike;
            for (let k = 0; k < wavefrontMap.opds.length; k++) {
                const rawOpd = wavefrontMap.raw.opds[k];
                const model = zernikeFit.removedModelMicrons[k];
                const corrected = (isFinite(rawOpd) && isFinite(model)) ? (rawOpd - model) : NaN;
                wavefrontMap.opds[k] = corrected;
                wavefrontMap.opdsInWavelengths[k] = corrected / this.opdCalculator.wavelength;
                wavefrontMap.wavefrontAberrations[k] = corrected / this.opdCalculator.wavelength;
            }

            if (prof) prof.marks.applyRemovedEnd = now();

            // rayData は pupilCoordinates と同順で push しているためインデックス対応
            if (recordRays && wavefrontMap.rayData) {
                for (let k = 0; k < wavefrontMap.rayData.length; k++) {
                    const rawOpd = wavefrontMap.rayData[k].opd;
                    const model = zernikeFit.removedModelMicrons[k];
                    const corrected = (isFinite(rawOpd) && isFinite(model)) ? (rawOpd - model) : NaN;
                    wavefrontMap.rayData[k].opd = corrected;
                    wavefrontMap.rayData[k].opdInWavelengths = corrected / this.opdCalculator.wavelength;
                    wavefrontMap.rayData[k].wavefrontAberration = corrected / this.opdCalculator.wavelength;
                }
            }
        }

        if (prof) {
            prof.tEnd = now();
            prof.marks.end = prof.tEnd;

            const ms = (a, b) => {
                const t1 = prof.marks?.[a];
                const t2 = prof.marks?.[b];
                if (!Number.isFinite(t1) || !Number.isFinite(t2)) return null;
                return t2 - t1;
            };

            const totalMs = prof.tEnd - prof.tStart;
            const refMs = ms('refStart', 'refEnd');
            const gridMs = ms('gridGenStart', 'gridGenEnd');
            const orderMs = ms('orderStart', 'orderEnd');
            const opdLoopMs = ms('opdLoopStart', 'opdLoopEnd');
            const fitMs = ms('zernikeFitStart', 'zernikeFitEnd');
            const modelMs = ms('zernikeModelStart', 'zernikeModelEnd');
            const applyRemovedMs = ms('applyRemovedStart', 'applyRemovedEnd');

            const points = gridPoints?.length || 0;
            const avgOpdMs = (prof.opdCalls > 0) ? (prof.opdCallMs / prof.opdCalls) : null;

            // Correctness diagnostic: compare a few sample points between OPD modes.
            // This helps confirm whether toggling opdMode should change results for the current field.
            let opdModeCompare = null;
            try {
                const fromValid = prof._opdModeCompare;
                if (fromValid && Array.isArray(fromValid.absMic) && fromValid.absMic.length > 0 && Array.isArray(fromValid.absW) && fromValid.absW.length > 0) {
                    const rms = (arr) => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length);
                    opdModeCompare = {
                        sampleCount: fromValid.absMic.length,
                        exampleImageSphereRadius: fromValid.exampleImageSphereRadius,
                        referenceModeCounts: fromValid.refModeCounts,
                        maxAbsDeltaMicrons: Math.max(...fromValid.absMic),
                        rmsAbsDeltaMicrons: rms(fromValid.absMic),
                        maxAbsDeltaWaves: Math.max(...fromValid.absW),
                        rmsAbsDeltaWaves: rms(fromValid.absW)
                    };
                } else {
                    // Fallback: naive sampling without solver hints (may produce NaNs in fragile infinite solves).
                    const samplePoints = [
                        { x: 0, y: 0 },
                        { x: 0.5, y: 0 },
                        { x: 0, y: 0.5 },
                        { x: 0.7, y: 0 },
                        { x: 0, y: 0.7 },
                        { x: 0.5, y: 0.5 },
                        { x: 0.7, y: 0.7 }
                    ].filter(p => (p.x * p.x + p.y * p.y) <= 1.0 + 1e-12);

                    const absMic = [];
                    const absW = [];
                    const refModeCounts = Object.create(null);
                    let exampleImageSphereRadius = null;
                    let sampleCount = 0;
                    for (const p of samplePoints) {
                        const vSimple = this.opdCalculator.calculateOPD(p.x, p.y, fieldSetting);
                        const vRef = this.opdCalculator.calculateOPDReferenceSphere(p.x, p.y, fieldSetting, false);
                        try {
                            const last = this.opdCalculator.getLastRayCalculation?.();
                            const rm = last?.referenceSphere?.referenceMode;
                            if (rm) refModeCounts[String(rm)] = (refModeCounts[String(rm)] || 0) + 1;
                            const r = last?.referenceSphere?.imageSphereRadius;
                            if (exampleImageSphereRadius === null && r !== undefined && r !== null) {
                                exampleImageSphereRadius = r;
                            }
                        } catch (_) {}
                        if (!Number.isFinite(vSimple) || !Number.isFinite(vRef)) continue;
                        const dMic = vRef - vSimple;
                        absMic.push(Math.abs(dMic));
                        absW.push(Math.abs(dMic / this.opdCalculator.wavelength));
                        sampleCount++;
                        if (sampleCount >= 5) break;
                    }

                    if (sampleCount > 0) {
                        const rms = (arr) => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length);
                        opdModeCompare = {
                            sampleCount,
                            exampleImageSphereRadius,
                            referenceModeCounts: refModeCounts,
                            maxAbsDeltaMicrons: Math.max(...absMic),
                            rmsAbsDeltaMicrons: rms(absMic),
                            maxAbsDeltaWaves: Math.max(...absW),
                            rmsAbsDeltaWaves: rms(absW)
                        };
                    } else {
                        opdModeCompare = { sampleCount: 0, exampleImageSphereRadius, referenceModeCounts: refModeCounts };
                    }
                }
            } catch (_) {
                opdModeCompare = { sampleCount: 0 };
            }

            const finiteOpdSamples = (() => {
                try {
                    const arr = wavefrontMap?.opds;
                    if (!Array.isArray(arr)) return 0;
                    let c = 0;
                    for (const v of arr) if (Number.isFinite(v)) c++;
                    return c;
                } catch (_) {
                    return 0;
                }
            })();

            const opdModeCompareSummary = (() => {
                try {
                    const sc = Number(opdModeCompare?.sampleCount || 0);
                    const maxW = opdModeCompare?.maxAbsDeltaWaves;
                    const rmsW = opdModeCompare?.rmsAbsDeltaWaves;
                    const maxU = opdModeCompare?.maxAbsDeltaMicrons;
                    const rmsU = opdModeCompare?.rmsAbsDeltaMicrons;
                    const r = opdModeCompare?.exampleImageSphereRadius;
                    const modes = opdModeCompare?.referenceModeCounts;
                    const modesText = (modes && typeof modes === 'object') ? JSON.stringify(modes) : '';
                    const rText = (r === Infinity) ? 'Infinity' : (Number.isFinite(r) ? Number(r).toFixed(6) : String(r));
                    const maxWText = Number.isFinite(maxW) ? Number(maxW).toExponential(3) : String(maxW);
                    const rmsWText = Number.isFinite(rmsW) ? Number(rmsW).toExponential(3) : String(rmsW);
                    const maxUText = Number.isFinite(maxU) ? Number(maxU).toExponential(3) : String(maxU);
                    const rmsUText = Number.isFinite(rmsU) ? Number(rmsU).toExponential(3) : String(rmsU);
                    return `samples=${sc} finiteOpdSamples=${finiteOpdSamples} | maxΔ=${maxUText}µm (${maxWText}λ) rmsΔ=${rmsUText}µm (${rmsWText}λ) | imageSphereRadius=${rText} | refModes=${modesText}`;
                } catch (_) {
                    return null;
                }
            })();

            if (OPD_DEBUG && opdModeCompareSummary) {
                console.log('🧪 [WavefrontProfile] opdModeCompareSummary:', opdModeCompareSummary);
            }

            OPD_DEBUG && console.log('⏱️ [WavefrontProfile] summary:', {
                profileVersion: '2025-12-31-breakdown-v1',
                gridSize,
                points,
                finiteOpdSamples,
                recordRays,
                opdMode,
                renderFromZernike,
                zernikeMaxNollOpt,
                totalMs: Number.isFinite(totalMs) ? totalMs.toFixed(1) : totalMs,
                refMs: refMs === null ? null : refMs.toFixed(1),
                gridMs: gridMs === null ? null : gridMs.toFixed(1),
                orderMs: orderMs === null ? null : orderMs.toFixed(1),
                opdLoopMs: opdLoopMs === null ? null : opdLoopMs.toFixed(1),
                avgOpdCallMs: avgOpdMs === null ? null : avgOpdMs.toFixed(3),
                zernikeFitMs: fitMs === null ? null : fitMs.toFixed(1),
                zernikeModelMs: modelMs === null ? null : modelMs.toFixed(1),
                applyRemovedMs: applyRemovedMs === null ? null : applyRemovedMs.toFixed(1),
                traceRayToSurfaceCount: prof.traceRayToSurfaceCount || 0,
                traceRayToSurfaceMs: Number.isFinite(prof.traceRayToSurfaceMs) ? prof.traceRayToSurfaceMs.toFixed(1) : (prof.traceRayToSurfaceMs || 0),
                traceRayToEvalCount: prof.traceRayToEvalCount || 0,
                finalStopReuseCount: (typeof prof.finalStopReuseCount === 'number') ? prof.finalStopReuseCount : null,
                finalStopFallbackCount: (typeof prof.finalStopFallbackCount === 'number') ? prof.finalStopFallbackCount : null,
                marginalRayFiniteCalls: prof.marginalRayFiniteCalls || 0,
                marginalRayInfiniteCalls: prof.marginalRayInfiniteCalls || 0,
                finiteStopCorrectionCalls: prof.finiteStopCorrectionCalls || 0,
                finiteStopCorrectionIters: prof.finiteStopCorrectionIters || 0,
                finiteStopCorrectionFastCalls: prof.finiteStopCorrectionFastCalls || 0,
                finiteStopHitCount: prof.finiteStopHitCount || 0,
                finiteBrentFallbackCount: prof.finiteBrentFallbackCount || 0,
                finiteBrentFallbackFastCount: prof.finiteBrentFallbackFastCount || 0,
                finiteInitialTraceNullCount: prof.finiteInitialTraceNullCount || 0,
                finiteEvalNullWithStopHitCount: prof.finiteEvalNullWithStopHitCount || 0,
                finiteDirectionSolveSkippedDueToStopHit: prof.finiteDirectionSolveSkippedDueToStopHit || 0,
                finiteDirectionSolveSkippedDueToNoStopHit: prof.finiteDirectionSolveSkippedDueToNoStopHit || 0,
                finiteNoStopHitFastFallbackAttempted: prof.finiteNoStopHitFastFallbackAttempted || 0,
                finiteNoStopHitFastFallbackSucceeded: prof.finiteNoStopHitFastFallbackSucceeded || 0,
                finiteDirectionSolveCalls: prof.finiteDirectionSolveCalls || 0,
                finiteDirectionSolveFastCalls: prof.finiteDirectionSolveFastCalls || 0,
                finiteDirectionSolveFallbackCalls: prof.finiteDirectionSolveFallbackCalls || 0,
                finiteDirectionSolveFallbackFastCalls: prof.finiteDirectionSolveFallbackFastCalls || 0,
                finiteDirectionSolveMs: Number.isFinite(prof.finiteDirectionSolveMs) ? prof.finiteDirectionSolveMs.toFixed(1) : (prof.finiteDirectionSolveMs || 0),
                marginalRayCalls: prof.marginalRayCalls || 0,
                marginalRayMs: Number.isFinite(prof.marginalRayMs) ? prof.marginalRayMs.toFixed(1) : (prof.marginalRayMs || 0),
                opticalPathCalls: prof.opticalPathCalls || 0,
                opticalPathMs: Number.isFinite(prof.opticalPathMs) ? prof.opticalPathMs.toFixed(1) : (prof.opticalPathMs || 0),
                opticalPathCacheRebuilds: prof.opticalPathCacheRebuilds || 0,
                opdModeCompare,
                opdModeCompareSummary
            });

            // Minimal one-shot summary (this is what you should look at first).
            try {
                const rt = (g && typeof g.getRayTracingProfile === 'function') ? g.getRayTracingProfile({ reset: false }) : null;
                const traceCalls = Number(rt?.traceCalls) || 0;
                const wasmAttempts = Number(rt?.wasmIntersectAttempts) || 0;
                const wasmHits = Number(rt?.wasmIntersectHits) || 0;
                const wasmUnavailable = Number(rt?.wasmIntersectUnavailable) || 0;
                const wasmHitRate = (wasmAttempts > 0) ? (100 * wasmHits / wasmAttempts) : 0;
                const newtonCalls = Number(prof.newtonChiefCalls) || 0;
                const newtonIters = Number(prof.newtonChiefIterations) || 0;
                const newtonAvg = (newtonCalls > 0) ? (newtonIters / newtonCalls) : 0;
                const newtonOk = Number(prof.newtonChiefSuccess) || 0;
                const newtonNg = Number(prof.newtonChiefFail) || 0;
                const totalMsNum = Number.isFinite(totalMs) ? Number(totalMs) : null;
                const callsPerMs = (totalMsNum && totalMsNum > 0) ? (traceCalls / totalMsNum) : 0;

                // Internal breakdown (these counters are independent from ray-tracing profiler traceCalls)
                const toSurface = Number(prof.traceRayToSurfaceCount) || 0;
                const toEval = Number(prof.traceRayToEvalCount) || 0;
                const stopCorrCalls = Number(prof.finiteStopCorrectionCalls) || 0;
                const stopCorrIters = Number(prof.finiteStopCorrectionIters) || 0;
                const stopCorrAvg = (stopCorrCalls > 0) ? (stopCorrIters / stopCorrCalls) : 0;
                const brentFallback = Number(prof.finiteBrentFallbackCount) || 0;
                const dirSolveCalls = Number(prof.finiteDirectionSolveCalls) || 0;
                const finiteMarginal = Number(prof.marginalRayFiniteCalls) || 0;
                const infiniteMarginal = Number(prof.marginalRayInfiniteCalls) || 0;
                const mode = (wavefrontMap && wavefrontMap.pupilSamplingMode) ? String(wavefrontMap.pupilSamplingMode) : '';
                const retryStopRelated = Number(prof.fastToSlowRetryStopRelated) || 0;
                const retryStopMiss = Number(prof.fastRetryStopMiss) || 0;
                const retryStopUnreach = Number(prof.fastRetryStopUnreachable) || 0;
                const retrySlow = Number(prof.fastToSlowRetrySlow) || 0;
                const retrySlowOk = Number(prof.fastToSlowRetrySlowOk) || 0;
                const retrySlowNg = Number(prof.fastToSlowRetrySlowNg) || 0;
                const retrySkip = Number(prof.fastToSlowRetrySkipped) || 0;

                console.log(
                    `📊 [OPD Profile] total=${totalMsNum !== null ? totalMsNum.toFixed(1) : String(totalMs)}ms grid=${gridSize} pts=${points} ` +
                    `traceRay=${traceCalls} (${callsPerMs.toFixed(1)} calls/ms) ` +
                    `toSurface=${toSurface} toEval=${toEval} ` +
                    `stopCorr=${stopCorrCalls}calls/${stopCorrIters}iters(avg=${stopCorrAvg.toFixed(2)}) ` +
                    `brent=${brentFallback} dirSolve=${dirSolveCalls} ` +
                    `marginalRay(finite=${finiteMarginal},inf=${infiniteMarginal})${mode ? ` mode=${mode}` : ''} ` +
                    `fastRetry(stop=${retryStopRelated} miss=${retryStopMiss} unreach=${retryStopUnreach},slow=${retrySlow} ok=${retrySlowOk} ng=${retrySlowNg},skip=${retrySkip}) ` +
                    `chiefNewton=${newtonCalls} calls ${newtonIters} iters (avg=${newtonAvg.toFixed(2)} ok=${newtonOk} ng=${newtonNg}) ` +
                    `wasmIntersectHit=${wasmHitRate.toFixed(1)}% (hit=${wasmHits}/att=${wasmAttempts}, unavail=${wasmUnavailable})`
                );
            } catch (_) {
                // ignore
            }

            // Restore profiler state / detach active run
            try {
                if (g && typeof g.enableRayTracingProfiler === 'function') {
                    if (prof.__rtPrevEnabled === true) g.enableRayTracingProfiler(true, false);
                    else if (prof.__rtPrevEnabled === false) g.enableRayTracingProfiler(false, false);
                }
            } catch (_) {}
            try {
                if (g && g.__cooptActiveWavefrontProfile === prof) delete g.__cooptActiveWavefrontProfile;
            } catch (_) {
                try { if (g) g.__cooptActiveWavefrontProfile = null; } catch (_) {}
            }

            // Detach to avoid leaking counters across runs.
            this.opdCalculator._wavefrontProfile = null;
        }

        emitProgress(100, 'done', 'Wavefront generation complete');

        // Optional display-mode: remove piston+tilt from the *plotted* OPD (defocus kept).
        // This is a view transform; raw and primary stats remain available.
        let display = null;
        let displayStats = null;
        try {
            if (opdDisplayMode === 'pistonTiltRemoved') {
                const fit = this._removeBestFitPlane(wavefrontMap.pupilCoordinates, wavefrontMap.opds);
                if (fit && Array.isArray(fit.residualMicrons) && Array.isArray(fit.residualWaves)) {
                    display = {
                        mode: 'pistonTiltRemoved',
                        planeCoefficientsMicrons: fit.coefficientsMicrons,
                        opds: fit.residualMicrons,
                        opdsInWavelengths: fit.residualWaves,
                        wavefrontAberrations: fit.residualWaves
                    };
                    displayStats = {
                        mode: 'pistonTiltRemoved',
                        planeCoefficientsMicrons: fit.coefficientsMicrons,
                        opdMicrons: this.calculateStatistics(fit.residualMicrons, { removePiston: false }),
                        opdWavelengths: this.calculateStatistics(fit.residualWaves, { removePiston: false })
                    };
                }
            }
        } catch (_) {
            display = null;
            displayStats = null;
        }
        if (display) {
            wavefrontMap.display = display;
        }

        // 統計情報を計算（補正後を primary とする）
        // OPD統計はピストン除去後の値を表示（光学的に意味のある収差量）
        const lowOrderRemoved = this._calculateLowOrderRemovedStats(
            wavefrontMap.pupilCoordinates,
            wavefrontMap.raw?.opds,
            {
                // OSA/ANSI: 0 piston, 1/2 tilt, 4 defocus
                removeIndices: [0, 1, 2, 4],
                maxOrder: 2
            }
        );
        wavefrontMap.statistics = {
            wavefront: this.calculateStatistics(wavefrontMap.wavefrontAberrations, { removePiston: true }),
            opdMicrons: this.calculateStatistics(wavefrontMap.opds, { removePiston: true }),
            opdWavelengths: this.calculateStatistics(wavefrontMap.opdsInWavelengths, { removePiston: true }),
            raw: {
                wavefront: this.calculateStatistics(wavefrontMap.raw.wavefrontAberrations, { removePiston: false }),
                opdMicrons: this.calculateStatistics(wavefrontMap.raw.opds, { removePiston: false }),
                opdWavelengths: this.calculateStatistics(wavefrontMap.raw.opdsInWavelengths, { removePiston: false })
            },
            aberration: lowOrderRemoved,
            display: displayStats
        };

        // Attach mode meta to each statistics object for easy display.
        try {
            const mode = wavefrontMap.pupilSamplingMode || null;
            if (wavefrontMap.statistics?.wavefront) wavefrontMap.statistics.wavefront.pupilSamplingMode = mode;
            if (wavefrontMap.statistics?.opdMicrons) wavefrontMap.statistics.opdMicrons.pupilSamplingMode = mode;
            if (wavefrontMap.statistics?.opdWavelengths) wavefrontMap.statistics.opdWavelengths.pupilSamplingMode = mode;

            const usedOpdMode = wavefrontMap.opdMode || null;
            const usedSkipZernikeFit = !!wavefrontMap.skipZernikeFit;
            if (wavefrontMap.statistics?.wavefront) {
                wavefrontMap.statistics.wavefront.opdMode = usedOpdMode;
                wavefrontMap.statistics.wavefront.skipZernikeFit = usedSkipZernikeFit;
            }
            if (wavefrontMap.statistics?.opdMicrons) {
                wavefrontMap.statistics.opdMicrons.opdMode = usedOpdMode;
                wavefrontMap.statistics.opdMicrons.skipZernikeFit = usedSkipZernikeFit;
            }
            if (wavefrontMap.statistics?.opdWavelengths) {
                wavefrontMap.statistics.opdWavelengths.opdMode = usedOpdMode;
                wavefrontMap.statistics.opdWavelengths.skipZernikeFit = usedSkipZernikeFit;
            }
            if (wavefrontMap.statistics?.raw?.wavefront) {
                wavefrontMap.statistics.raw.wavefront.pupilSamplingMode = mode;
                wavefrontMap.statistics.raw.wavefront.opdMode = usedOpdMode;
                wavefrontMap.statistics.raw.wavefront.skipZernikeFit = usedSkipZernikeFit;
            }
            if (wavefrontMap.statistics?.raw?.opdMicrons) {
                wavefrontMap.statistics.raw.opdMicrons.pupilSamplingMode = mode;
                wavefrontMap.statistics.raw.opdMicrons.opdMode = usedOpdMode;
                wavefrontMap.statistics.raw.opdMicrons.skipZernikeFit = usedSkipZernikeFit;
            }
            if (wavefrontMap.statistics?.raw?.opdWavelengths) {
                wavefrontMap.statistics.raw.opdWavelengths.pupilSamplingMode = mode;
                wavefrontMap.statistics.raw.opdWavelengths.opdMode = usedOpdMode;
                wavefrontMap.statistics.raw.opdWavelengths.skipZernikeFit = usedSkipZernikeFit;
            }

            if (wavefrontMap.statistics?.aberration?.opdMicrons) {
                wavefrontMap.statistics.aberration.opdMicrons.pupilSamplingMode = mode;
                wavefrontMap.statistics.aberration.opdMicrons.opdMode = usedOpdMode;
                wavefrontMap.statistics.aberration.opdMicrons.skipZernikeFit = usedSkipZernikeFit;
                wavefrontMap.statistics.aberration.opdMicrons.removeIndices = wavefrontMap.statistics.aberration.removeIndices;
            }
            if (wavefrontMap.statistics?.aberration?.opdWavelengths) {
                wavefrontMap.statistics.aberration.opdWavelengths.pupilSamplingMode = mode;
                wavefrontMap.statistics.aberration.opdWavelengths.opdMode = usedOpdMode;
                wavefrontMap.statistics.aberration.opdWavelengths.skipZernikeFit = usedSkipZernikeFit;
                wavefrontMap.statistics.aberration.opdWavelengths.removeIndices = wavefrontMap.statistics.aberration.removeIndices;
            }

            if (wavefrontMap.statistics?.display?.opdMicrons) {
                wavefrontMap.statistics.display.opdMicrons.pupilSamplingMode = mode;
                wavefrontMap.statistics.display.opdMicrons.opdMode = usedOpdMode;
                wavefrontMap.statistics.display.opdMicrons.skipZernikeFit = usedSkipZernikeFit;
                wavefrontMap.statistics.display.opdMicrons.opdDisplayMode = opdDisplayMode;
            }
            if (wavefrontMap.statistics?.display?.opdWavelengths) {
                wavefrontMap.statistics.display.opdWavelengths.pupilSamplingMode = mode;
                wavefrontMap.statistics.display.opdWavelengths.opdMode = usedOpdMode;
                wavefrontMap.statistics.display.opdWavelengths.skipZernikeFit = usedSkipZernikeFit;
                wavefrontMap.statistics.display.opdWavelengths.opdDisplayMode = opdDisplayMode;
            }
        } catch (_) {}
        if (OPD_DEBUG) console.log('📊 統計情報:', wavefrontMap.statistics);

        // ---- Discontinuity / outlier diagnostics (log-only) ----
        if (diagnoseDiscontinuities) {
            try {
                this._diagnoseWavefrontDiscontinuities(wavefrontMap, fieldSetting, { topK: diagTopK });
            } catch (e) {
                console.warn('⚠️ [DiscontinuityDiag] failed:', e?.message || e);
            }
        }
        
        // 🆕 デバッグ: 生成されたデータの詳細を確認
        // NOTE: renderFromZernike + valid-pupil masking can introduce NaN entries.
        // Count/Min/Max must ignore non-finite values.
        const finiteCount = (arr) => {
            if (!Array.isArray(arr)) return 0;
            let c = 0;
            for (const v of arr) if (Number.isFinite(v)) c++;
            return c;
        };
        const finiteMinMax = (arr) => {
            if (!Array.isArray(arr)) return { min: NaN, max: NaN };
            let min = Infinity;
            let max = -Infinity;
            let any = false;
            for (const v of arr) {
                if (!Number.isFinite(v)) continue;
                any = true;
                if (v < min) min = v;
                if (v > max) max = v;
            }
            return any ? { min, max } : { min: NaN, max: NaN };
        };

        const validCount = finiteCount(wavefrontMap.wavefrontAberrations);
        const totalInPupil = Array.isArray(gridPoints) ? gridPoints.length : validCount;
        const squareTotal = gridSize * gridSize;
        const pct = (totalInPupil > 0) ? (validCount / totalInPupil * 100) : 0;
        
        if (validCount === 0) {
            console.error(`❌ 有効なデータが1点もありません！`);
            console.log(`🔍 詳細診断:`);
            console.log(`  - 基準光路長: ${this.opdCalculator.referenceOpticalPath}`);
            console.log(`  - グリッドサイズ: ${gridSize}`);
            console.log(`  - 瞳座標範囲: ±${pupilRange}`);
            
            // 中央点での詳細テスト
            console.log(`🔍 中央点(0,0)での詳細テスト:`);
            try {
                const centerOPD = this.opdCalculator.calculateOPD(0, 0, fieldSetting);
                console.log(`  中央点OPD: ${centerOPD}`);
                if (isNaN(centerOPD)) {
                    console.error(`❌ 中央点でもOPD計算に失敗しています`);
                } else {
                    console.log(`✅ 中央点OPD計算は成功: ${centerOPD}μm`);
                }
            } catch (error) {
                console.error(`❌ 中央点OPD計算エラー: ${error.message}`);
            }
        }

        return wavefrontMap;
    }

    /**
     * Zernikeモデル面を「描画用に高密度サンプリング」した格子を生成する。
     * - 元の計算グリッドは変えず、同じZernike関数をより細かい格子で評価するだけ（平滑化/外れ値除去はしない）。
     * - 出力zは dataTypeに応じて波長単位(λ)の値。
     */
    generateZernikeRenderGrid(wavefrontMap, renderGridSize = 129, dataType = 'opd', options = {}) {
        const pupilRange = Number(wavefrontMap?.pupilRange);
        const wavelength = Number(this.opdCalculator?.wavelength);
        const model = wavefrontMap?.zernikeModel;
        const usedCoeffs = model?.usedCoefficientsMicrons;
        const maxNollUsed = Number.isFinite(model?.maxNollUsed) ? Math.floor(model.maxNollUsed) : NaN;

        const rhoMax = Number.isFinite(options?.rhoMax) ? Number(options.rhoMax) : 0.995;

        // Optional: mask rendered pupil by the coarse validity mask from ray tracing.
        // This is crucial for infinite systems with vignetting; PSF should not assume a full circular pupil.
        const useWavefrontMask = options?.useWavefrontMask !== false;
        const validMask = useWavefrontMask ? wavefrontMap?.validPupilMask : null;
        const validMaskG = (Array.isArray(validMask) && validMask.length >= 2) ? validMask.length : null;

        if (!Number.isFinite(pupilRange) || pupilRange <= 0) return null;
        if (!Number.isFinite(wavelength) || wavelength <= 0) return null;
        if (!usedCoeffs || typeof usedCoeffs !== 'object') return null;
        if (!Number.isFinite(maxNollUsed) || maxNollUsed < 1) return null;

        // IMPORTANT: usedCoeffs are OSA/ANSI-indexed (j=0..max-1). Use reconstructOPD.
        const usedCoeffsArray = new Array(maxNollUsed).fill(0);
        for (let j = 0; j < maxNollUsed; j++) {
            const c = Number(usedCoeffs?.[j] ?? 0);
            usedCoeffsArray[j] = Number.isFinite(c) ? c : 0;
        }

        const g = Math.max(2, Math.floor(Number(renderGridSize)));
        const xAxis = [];
        const yAxis = [];
        for (let i = 0; i < g; i++) {
            const t = (i / (g - 1)) * 2 - 1;
            xAxis.push(t * pupilRange);
            yAxis.push(t * pupilRange);
        }

        const zGrid = Array.from({ length: g }, () => Array.from({ length: g }, () => null));
        const eps = 1e-12;
        for (let iy = 0; iy < g; iy++) {
            const y = yAxis[iy];
            for (let ix = 0; ix < g; ix++) {
                const x = xAxis[ix];
                const r = Math.hypot(x, y);
                if (r > pupilRange + eps) {
                    zGrid[iy][ix] = null;
                    continue;
                }

                // Apply coarse physical validity mask (nearest-neighbor) if available.
                if (validMaskG) {
                    const tx = (x / pupilRange + 1) * 0.5;
                    const ty = (y / pupilRange + 1) * 0.5;
                    const mx = Math.max(0, Math.min(validMaskG - 1, Math.round(tx * (validMaskG - 1))));
                    const my = Math.max(0, Math.min(validMaskG - 1, Math.round(ty * (validMaskG - 1))));
                    if (!validMask?.[my]?.[mx]) {
                        zGrid[iy][ix] = null;
                        continue;
                    }
                }

                const rho = r / pupilRange;
                // Display-only trim of the very outer rim to avoid jagged boundary artifacts.
                if (Number.isFinite(rhoMax) && rhoMax > 0 && rho > rhoMax + 1e-12) {
                    zGrid[iy][ix] = null;
                    continue;
                }
                const xn = x / pupilRange;
                const yn = y / pupilRange;
                const microns = reconstructOPD(usedCoeffsArray, xn, yn);

                // dataTypeはどちらでも「λ」表示がUI側の期待。
                // opd: OPD[μm]/λ, wavefront: Wλ も同じく OPD/λ で表現。
                zGrid[iy][ix] = microns / wavelength;
            }
        }

        return { x: xAxis, y: yAxis, z: zGrid };
    }

    _diagnoseWavefrontDiscontinuities(wavefrontMap, fieldSetting, options = {}) {
        const topK = Number.isFinite(options?.topK) ? Math.max(1, Math.floor(options.topK)) : 5;
        const coords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
        const rawMicrons = Array.isArray(wavefrontMap?.raw?.opds) ? wavefrontMap.raw.opds : [];
        const rawWaves = Array.isArray(wavefrontMap?.raw?.opdsInWavelengths) ? wavefrontMap.raw.opdsInWavelengths : [];
        const corrMicrons = Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds : [];
        const corrWaves = Array.isArray(wavefrontMap?.opdsInWavelengths) ? wavefrontMap.opdsInWavelengths : [];
        const gridSize = Math.floor(Number(wavefrontMap?.gridSize));
        const pupilRange = Number(wavefrontMap?.pupilRange);
        if (!coords.length || !Number.isFinite(gridSize) || gridSize < 2 || !Number.isFinite(pupilRange) || pupilRange <= 0) {
            console.warn('⚠️ [DiscontinuityDiag] insufficient data');
            return;
        }

        const key = (ix, iy) => `${ix},${iy}`;
        const idxByCell = new Map();
        for (let i = 0; i < coords.length; i++) {
            const c = coords[i];
            if (!c) continue;
            const ix = Number.isInteger(c.ix) ? c.ix : null;
            const iy = Number.isInteger(c.iy) ? c.iy : null;
            if (ix === null || iy === null) continue;
            if (ix < 0 || ix >= gridSize || iy < 0 || iy >= gridSize) continue;
            const k = key(ix, iy);
            if (!idxByCell.has(k)) idxByCell.set(k, i);
        }

        const byR = [];
        for (let i = 0; i < coords.length; i++) {
            const c = coords[i];
            const v = corrWaves[i];
            if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(v)) continue;
            const r = Math.hypot(c.x, c.y);
            byR.push({ i, r });
        }
        byR.sort((a, b) => a.r - b.r);
        const near = byR.slice(0, 8);
        if (near.length) {
            console.log('🧪 [DiscontinuityDiag] nearest-to-center points (raw→corr):');
            for (const it of near) {
                const i = it.i;
                const c = coords[i];
                console.log(
                    `  r=${it.r.toFixed(5)} pupil(${c.x.toFixed(3)},${c.y.toFixed(3)}) ix=${c.ix},iy=${c.iy}  raw=${(rawWaves[i]).toFixed(6)}λ (${(rawMicrons[i]).toFixed(6)}μm)  corr=${(corrWaves[i]).toFixed(6)}λ (${(corrMicrons[i]).toFixed(6)}μm)`
                );
            }
        }

        const byAbs = [];
        for (let i = 0; i < coords.length; i++) {
            const v = corrWaves[i];
            if (!Number.isFinite(v)) continue;
            byAbs.push({ i, a: Math.abs(v) });
        }
        byAbs.sort((a, b) => b.a - a.a);
        const outliers = byAbs.slice(0, Math.min(topK, byAbs.length));
        if (outliers.length) {
            console.log(`🧪 [DiscontinuityDiag] top |corr OPD| points (show neighbors):`);
            const dirs = [
                [1, 0],
                [-1, 0],
                [0, 1],
                [0, -1]
            ];
            for (const o of outliers) {
                const i = o.i;
                const c = coords[i];
                const ix = Number.isInteger(c?.ix) ? c.ix : null;
                const iy = Number.isInteger(c?.iy) ? c.iy : null;
                const model = (Number.isFinite(rawWaves[i]) && Number.isFinite(corrWaves[i])) ? (rawWaves[i] - corrWaves[i]) : NaN;
                console.log(
                    `  |corr|=${o.a.toFixed(6)}λ at pupil(${c.x.toFixed(3)},${c.y.toFixed(3)}) ix=${ix},iy=${iy} raw=${(rawWaves[i]).toFixed(6)}λ corr=${(corrWaves[i]).toFixed(6)}λ model=${Number.isFinite(model) ? model.toFixed(6) : model}λ`
                );
                if (ix === null || iy === null) continue;
                for (const [dx, dy] of dirs) {
                    const j = idxByCell.get(key(ix + dx, iy + dy));
                    if (j === undefined) continue;
                    const dv = corrWaves[i] - corrWaves[j];
                    const cj = coords[j];
                    const modelJ = (Number.isFinite(rawWaves[j]) && Number.isFinite(corrWaves[j])) ? (rawWaves[j] - corrWaves[j]) : NaN;
                    console.log(
                        `    neighbor (${dx},${dy}) pupil(${cj.x.toFixed(3)},${cj.y.toFixed(3)}) raw=${(rawWaves[j]).toFixed(6)}λ corr=${(corrWaves[j]).toFixed(6)}λ model=${Number.isFinite(modelJ) ? modelJ.toFixed(6) : modelJ}λ  Δcorr=${dv.toFixed(6)}λ`
                    );
                }
            }
        }

        // Global neighbor-diff scan (to locate spikes objectively)
        const diffs = [];
        for (let iy = 0; iy < gridSize; iy++) {
            for (let ix = 0; ix < gridSize; ix++) {
                const a = idxByCell.get(key(ix, iy));
                if (a === undefined) continue;
                const va = corrWaves[a];
                if (!Number.isFinite(va)) continue;

                const bR = idxByCell.get(key(ix + 1, iy));
                if (bR !== undefined) {
                    const vb = corrWaves[bR];
                    if (Number.isFinite(vb)) diffs.push({ d: Math.abs(va - vb), a, b: bR });
                }
                const bU = idxByCell.get(key(ix, iy + 1));
                if (bU !== undefined) {
                    const vb = corrWaves[bU];
                    if (Number.isFinite(vb)) diffs.push({ d: Math.abs(va - vb), a, b: bU });
                }
            }
        }
        if (diffs.length) {
            const ds = diffs.map(x => x.d).sort((a, b) => a - b);
            const median = ds[Math.floor(ds.length / 2)];
            diffs.sort((a, b) => b.d - a.d);
            console.log(`🧪 [DiscontinuityDiag] neighbor Δ stats: edges=${diffs.length}, medianΔ=${median.toFixed(6)}λ, maxΔ=${diffs[0].d.toFixed(6)}λ`);
            const topEdges = diffs.slice(0, 10);
            for (const e of topEdges) {
                const ca = coords[e.a];
                const cb = coords[e.b];
                const modelA = (Number.isFinite(rawWaves[e.a]) && Number.isFinite(corrWaves[e.a])) ? (rawWaves[e.a] - corrWaves[e.a]) : NaN;
                const modelB = (Number.isFinite(rawWaves[e.b]) && Number.isFinite(corrWaves[e.b])) ? (rawWaves[e.b] - corrWaves[e.b]) : NaN;
                console.log(
                    `  edge Δ=${e.d.toFixed(6)}λ  A(${ca.x.toFixed(3)},${ca.y.toFixed(3)}) corr=${(corrWaves[e.a]).toFixed(6)}λ raw=${(rawWaves[e.a]).toFixed(6)}λ model=${Number.isFinite(modelA) ? modelA.toFixed(6) : modelA}λ  B(${cb.x.toFixed(3)},${cb.y.toFixed(3)}) corr=${(corrWaves[e.b]).toFixed(6)}λ raw=${(rawWaves[e.b]).toFixed(6)}λ model=${Number.isFinite(modelB) ? modelB.toFixed(6) : modelB}λ`
                );
            }
        }

        // Re-trace only the worst outlier + its 4-neighbors to see whether ray/OPL is anomalous.
        const worst = outliers?.[0]?.i;
        if (worst === undefined) return;
        const cw = coords[worst];
        const ix0 = Number.isInteger(cw?.ix) ? cw.ix : null;
        const iy0 = Number.isInteger(cw?.iy) ? cw.iy : null;
        if (ix0 === null || iy0 === null) return;

        const cellsToCheck = [
            [ix0, iy0],
            [ix0 + 1, iy0],
            [ix0 - 1, iy0],
            [ix0, iy0 + 1],
            [ix0, iy0 - 1]
        ];
        const seen = new Set();
        console.log('🧪 [DiscontinuityDiag] retrace worst cell + neighbors:');

        // Stop-hit sanity check in stop-local coordinates
        let stopRadius = null;
        try {
            const sidx = this.opdCalculator?.stopSurfaceIndex;
            const stopSurface = this.opdCalculator?.opticalSystemRows?.[sidx];
            if (stopSurface) {
                const semidia = parseFloat(stopSurface.semidia || 0);
                const aperture = parseFloat(stopSurface.aperture || stopSurface.Aperture || 0);
                stopRadius = semidia > 0 ? semidia : (aperture > 0 ? aperture / 2 : null);
            }
        } catch (_) {}
        const stopCenter = this.opdCalculator?.getSurfaceOrigin?.(this.opdCalculator?.stopSurfaceIndex);
        const stopAxes = this.opdCalculator?.getSurfaceAxes?.(this.opdCalculator?.stopSurfaceIndex);
        const dot = (a, b) => (a.x * b.x + a.y * b.y + a.z * b.z);
        for (const [ix, iy] of cellsToCheck) {
            const k = key(ix, iy);
            if (seen.has(k)) continue;
            seen.add(k);
            const idx = idxByCell.get(k);
            if (idx === undefined) continue;
            const c = coords[idx];
            const opdMicron = this.opdCalculator.calculateOPD(c.x, c.y, fieldSetting);
            const last = this.opdCalculator.getLastRayCalculation?.();
            const ray = last?.ray;
            const path = this.opdCalculator.extractPathData?.(ray);
            const pathLen = Array.isArray(path) ? path.length : 0;
            const expected = 1 + (Array.isArray(this.opdCalculator?._recordedSurfaceIndices) ? this.opdCalculator._recordedSurfaceIndices.length : 0);
            const opl = ray ? this.opdCalculator.calculateOpticalPath(ray) : NaN;

            let stopInfo = '';
            try {
                const sp = this.opdCalculator.getStopPointFromRayData?.(ray);
                if (sp && stopCenter && stopAxes?.ex && stopAxes?.ey && Number.isFinite(stopRadius)) {
                    const d = { x: sp.x - stopCenter.x, y: sp.y - stopCenter.y, z: sp.z - stopCenter.z };
                    const localX = dot(d, stopAxes.ex);
                    const localY = dot(d, stopAxes.ey);
                    const expX = c.x * stopRadius;
                    const expY = c.y * stopRadius;
                    const err = Math.hypot(localX - expX, localY - expY);
                    stopInfo = ` stopLocal=(${localX.toFixed(3)},${localY.toFixed(3)})mm exp=(${expX.toFixed(3)},${expY.toFixed(3)})mm err=${err.toFixed(3)}mm`;
                } else if (sp) {
                    stopInfo = ` stop=(${sp.x.toFixed(3)},${sp.y.toFixed(3)})`;
                } else {
                    stopInfo = ' stop=(null)';
                }
            } catch (_) {
                // ignore
            }

            console.log(
                `  cell ix=${ix},iy=${iy} pupil(${c.x.toFixed(3)},${c.y.toFixed(3)})  OPD=${Number.isFinite(opdMicron) ? opdMicron.toFixed(6) : opdMicron}μm (${(opdMicron / this.opdCalculator.wavelength).toFixed(6)}λ)  OPL=${Number.isFinite(opl) ? opl.toFixed(3) : opl}μm  path=${pathLen}/${expected}  last=${last?.success ? 'ok' : ('fail:' + (last?.error || 'unknown'))}${stopInfo}`
            );
        }
    }

    /**
     * 統計情報を計算
     * @param {Array} aberrations - 波面収差の配列
     * @param {Object} options - オプション
     * @param {boolean} options.removePiston - ピストン（平均）を除去してから統計計算（デフォルト: false）
     * @returns {Object} 統計情報
     */
    calculateStatistics(aberrations, options = {}) {
        if (!aberrations || aberrations.length === 0) {
            console.warn('⚠️ 統計計算: データが空です');
            return { count: 0, mean: 0, rms: 0, peakToPeak: 0, min: 0, max: 0 };
        }

        const removePiston = options.removePiston || false;

        // ゼロ以外の有限値のみで統計を計算（ビネッティング/無効を除外）
        // NOTE: Do NOT use Math.min(...arr)/Math.max(...arr) because large grids can overflow the call stack.
        let count = 0;
        let sum = 0;
        let sumSq = 0;
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < aberrations.length; i++) {
            const val = aberrations[i];
            if (val === 0) continue;
            if (!Number.isFinite(val)) continue;
            count++;
            sum += val;
            sumSq += val * val;
            if (val < min) min = val;
            if (val > max) max = val;
        }

        if (count === 0) {
            console.warn('⚠️ 統計計算: 有効な値がありません（すべてゼロまたは無効値）');
            return { count: 0, mean: 0, rms: 0, peakToPeak: 0, min: 0, max: 0 };
        }

        const mean = sum / count;
        
        // ピストン除去オプション: 平均を引いてから統計を再計算
        if (removePiston && Math.abs(mean) > 1e-10) {
            sum = 0;
            sumSq = 0;
            min = Infinity;
            max = -Infinity;
            for (let i = 0; i < aberrations.length; i++) {
                const val = aberrations[i];
                if (val === 0) continue;
                if (!Number.isFinite(val)) continue;
                const centered = val - mean;
                sum += centered;  // Should be ~0
                sumSq += centered * centered;
                if (centered < min) min = centered;
                if (centered > max) max = centered;
            }
        }
        
        // variance = E[x^2] - (E[x])^2
        const ex2 = sumSq / count;
        const meanFinal = removePiston ? 0 : mean;  // ピストン除去時は平均=0
        const variance = Math.max(0, ex2 - meanFinal * meanFinal);
        const rms = Math.sqrt(variance);
        const peakToPeak = max - min;

        if (OPD_DEBUG) {
            console.log(`📊 統計計算詳細: 総数=${aberrations.length}, 有効数=${count}, mean=${meanFinal.toFixed(6)}, rms=${rms.toFixed(6)}, P-P=${peakToPeak.toFixed(6)}${removePiston ? ' (piston removed)' : ''}`);
        }

        return {
            count: count,
            mean: meanFinal,
            rms: rms,
            peakToPeak: peakToPeak,
            min: min,
            max: max
        };
    }

    /**
     * Zernike係数によるフィッティング（基本実装）
     * @param {Object} wavefrontMap - 波面収差マップ
     * @param {number} maxOrder - 最大次数（デフォルト: 4）
     * @returns {Map} Zernike係数
     */
    fitZernikePolynomials(wavefrontMap, maxOrder = 4) {
        const pupilCoordinates = wavefrontMap?.pupilCoordinates || [];
        const opds = wavefrontMap?.opds || [];
        const maxOrderRequested = Math.max(3, Number(maxOrder) || 6);

        // ビネッティング検出用に重み付きポイント配列を作成
        const points = [];
        for (let i = 0; i < pupilCoordinates.length; i++) {
            const p = pupilCoordinates[i];
            const opd = opds[i];
            if (!p) continue;
            
            const r = Math.sqrt(p.x * p.x + p.y * p.y);
            if (r > 1.0 + 1e-9) continue;
            
            // 有効なOPD値には重み1、無効（ビネッティング）には重み0
            const weight = (isFinite(p.x) && isFinite(p.y) && isFinite(opd)) ? 1 : 0;
            points.push({ 
                x: p.x, 
                y: p.y, 
                opd: weight > 0 ? opd : 0,  // 無効点は0として扱う
                weight 
            });
        }

        const validPoints = points.filter(pt => pt.weight > 0);
        if (validPoints.length === 0) {
            console.warn('⚠️ 有効なサンプル点が0個のため、Zernikeフィッティングをスキップします');
            return {
                maxNoll: 0,
                coefficientsMicrons: {},
                stats: { points: 0, rmsResidual: NaN }
            };
        }

        // OPD値を中心化（平均を引く）- 数値的安定性のため
        const opdMean = validPoints.reduce((sum, pt) => sum + pt.opd, 0) / validPoints.length;
        
        for (const pt of points) {
            if (pt.weight > 0) {
                pt.opd -= opdMean;
            }
        }

        // OPD範囲を計算してスケールファクターを決定
        const opdValues = validPoints.map(pt => pt.opd);
        const opdMin = Math.min(...opdValues);
        const opdMax = Math.max(...opdValues);
        const opdRange = opdMax - opdMin;
        
        // スケールファクター: OPD範囲をO(1)にスケーリング（条件数改善のため）
        // 参考文献: Golub & Van Loan "Matrix Computations" (2013), Sec. 2.7, 5.3
        //          Press et al. "Numerical Recipes" (2007), Sec. 15.4
        const scaleFactor = Math.max(1.0, opdRange);  // 少なくとも1以上
        
        // OPD値をスケーリング
        for (const pt of points) {
            if (pt.weight > 0) {
                pt.opd /= scaleFactor;
            }
        }

        // ============================================================
        // 新実装：ハイブリッドアプローチ（Gram-Schmidt + Cholesky）
        // - 低次項（ピストン・チルト）を解析的に計算（数値安定性）
        // - 高次項のみCholesky分解でフィッティング
        // ============================================================
        
        // Step 1: ピストン（j=0）を解析的に計算
        // OPDは既に中心化済み（平均=0）なので、ピストンはopdMean/scaleFactor
        const piston_scaled = 0;  // 中心化済みなので0
        
        // Step 2: チルト（j=1, j=2）を解析的に計算
        // OSA/ANSI（zernike-fitting.js の zernikePolynomial と同じ正規化）:
        //   j=1 → (n=1, m=-1) → Z = 2 * ρ * sin(θ) = 2 * y
        //   j=2 → (n=1, m= 1) → Z = 2 * ρ * cos(θ) = 2 * x
        // OPD = c1*(2*y) + c2*(2*x) を最小二乗で解く
        
        let sum_x = 0, sum_y = 0, sum_x2 = 0, sum_y2 = 0, sum_xy = 0;
        let sum_opd_x = 0, sum_opd_y = 0;
        
        for (const pt of validPoints) {
            sum_x += pt.x;
            sum_y += pt.y;
            sum_x2 += pt.x * pt.x;
            sum_y2 += pt.y * pt.y;
            sum_xy += pt.x * pt.y;
            sum_opd_x += pt.opd * pt.x;
            sum_opd_y += pt.opd * pt.y;
        }
        
        const nPts = validPoints.length;
        const det = sum_x2 * sum_y2 - sum_xy * sum_xy;
        
        let tiltY_scaled = 0, tiltX_scaled = 0;
        if (Math.abs(det) > 1e-10) {
            // Solve: [Σx² Σxy][2*c2] = [Σ(OPD*x)]
            //        [Σxy Σy²][2*c1]   [Σ(OPD*y)]
            const two_c2 = (sum_opd_x * sum_y2 - sum_opd_y * sum_xy) / det;
            const two_c1 = (sum_x2 * sum_opd_y - sum_xy * sum_opd_x) / det;
            tiltY_scaled = two_c1 / 2;  // j=1
            tiltX_scaled = two_c2 / 2;  // j=2
        }
        
        // Step 3: OPDから低次成分を除去
        const opd_residual = validPoints.map(pt => {
            const tiltContribution = tiltY_scaled * 2 * pt.y + tiltX_scaled * 2 * pt.x;
            return pt.opd - tiltContribution;
        });
        
        // 残差をpointsに反映
        validPoints.forEach((pt, i) => {
            pt.opd = opd_residual[i];
        });
        
        // Step 3.5: ノイズ対策 - 外れ値の除外（任意、globalThisで制御可能）
        // 以前の "σベース" はスパイクの影響で閾値が緩くなりやすいので、MAD (median absolute deviation) に変更。
        const enableOutlierRemoval = (typeof globalThis !== 'undefined' && globalThis.__ZERNIKE_REMOVE_OUTLIERS !== false);
        const outlierSigmaMultiplier = (typeof globalThis !== 'undefined' && typeof globalThis.__ZERNIKE_OUTLIER_SIGMA === 'number')
            ? globalThis.__ZERNIKE_OUTLIER_SIGMA
            : 6.0;  // デフォルト: 6σ相当（MADは保守的にしやすい）
        const outlierMinAbs = (typeof globalThis !== 'undefined' && typeof globalThis.__ZERNIKE_OUTLIER_MIN_ABS === 'number')
            ? Math.max(0, globalThis.__ZERNIKE_OUTLIER_MIN_ABS)
            : 0.0;
        const outlierMinPoints = (typeof globalThis !== 'undefined' && Number.isFinite(globalThis.__ZERNIKE_OUTLIER_MIN_POINTS))
            ? Math.max(10, Math.floor(globalThis.__ZERNIKE_OUTLIER_MIN_POINTS))
            : 20;

        const median = (arr) => {
            const vals = Array.isArray(arr) ? arr.filter(Number.isFinite).slice() : [];
            if (vals.length === 0) return NaN;
            vals.sort((a, b) => a - b);
            const mid = Math.floor(vals.length / 2);
            return (vals.length % 2 === 0) ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
        };

        let filteredPoints = validPoints;
        let outlierFilterStats = null;
        if (enableOutlierRemoval && validPoints.length >= outlierMinPoints) {
            const vals = validPoints.map(pt => pt.opd).filter(Number.isFinite);
            const med = median(vals);
            const absDev = vals.map(v => Math.abs(v - med));
            const mad = median(absDev);
            const robustSigma = (Number.isFinite(mad) && mad > 0) ? (1.4826 * mad) : NaN;
            const threshold = (Number.isFinite(robustSigma) && robustSigma > 0)
                ? Math.max(outlierMinAbs, outlierSigmaMultiplier * robustSigma)
                : NaN;

            if (Number.isFinite(threshold) && threshold > 0) {
                filteredPoints = validPoints.filter(pt => {
                    if (!pt || !Number.isFinite(pt.opd)) return false;
                    return Math.abs(pt.opd - med) <= threshold;
                });

                outlierFilterStats = {
                    method: 'MAD',
                    sigmaMultiplier: outlierSigmaMultiplier,
                    minAbs: outlierMinAbs,
                    minPoints: outlierMinPoints,
                    median: med,
                    mad,
                    robustSigma,
                    threshold,
                    removed: validPoints.length - filteredPoints.length,
                    kept: filteredPoints.length
                };

                if (outlierFilterStats.removed > 0) {
                    console.log(`⚡ Zernike fitting: ${outlierFilterStats.removed} outliers removed (MAD, threshold=${threshold.toExponential(3)} in scaled OPD units)`);
                }

                // 外れ値除去で点数が落ちすぎた場合は無効化（不安定化を避ける）
                if (filteredPoints.length < 10) {
                    filteredPoints = validPoints;
                    outlierFilterStats = {
                        ...outlierFilterStats,
                        disabledReason: 'too_few_points_after_filter'
                    };
                }
            }
        }
        
        // Step 4: 高次項（j>=3）のみをフィッティング
        // ノイズ増幅を防ぐため、より保守的な次数制限を適用
        const conservativeFactor = (typeof globalThis !== 'undefined' && typeof globalThis.__ZERNIKE_ORDER_FACTOR === 'number')
            ? globalThis.__ZERNIKE_ORDER_FACTOR
            : 3.0;  // デフォルト: √(N/3) より保守的
        
        const maxOrderFromPoints = Math.floor(Math.sqrt(filteredPoints.length / conservativeFactor));
        const maxOrderForFit = Math.min(
            8,  // Up to 45 terms (OSA j=0..44). System Data can still display a subset (e.g. 37 terms).
            maxOrderRequested,
            maxOrderFromPoints
        );
        
        console.log(`🔧 Zernike fitting: maxOrder=${maxOrderForFit} (points=${filteredPoints.length}, requested=${maxOrderRequested})`);
        
        const fitResult = fitZernikeWeighted(filteredPoints, maxOrderForFit, {
            skipPiston: true,     // j=0をスキップ（既に計算済み）
            skipTilt: true,       // j=1,2をスキップ（既に計算済み）
            removePiston: false,  
            removeTilt: false     
        });
        
        // Step 5: 係数を統合（スケール復元）
        // 🔧 仮実装: ピストン項に実際のOPD平均値を保持
        // NOTE: これにより波面表示時の値が大きくなる可能性があります
        const coefficientsMicrons = {};
        coefficientsMicrons[0] = opdMean;  // ピストン = OPD平均値（仮実装）
        coefficientsMicrons[1] = tiltY_scaled * scaleFactor;  // チルトY
        coefficientsMicrons[2] = tiltX_scaled * scaleFactor;  // チルトX
        
        // デバッグ: OPD平均値の確認
        if (Math.abs(opdMean) > 0.001) {  // 1nm以上の平均値がある場合
            console.log(`📊 OPD平均値: ${opdMean.toFixed(6)}μm → 係数[0]（ピストン項）に設定`);
        }
        
        // 高次項（fitResultから取得）
        for (let j = 3; j < fitResult.coefficients.length; j++) {
            coefficientsMicrons[j] = fitResult.coefficients[j] * scaleFactor;
        }

        // 低次成分除去用の設定（globalThisから上書き可能）
        // デフォルト: ピストン(j=0)のみ除去 - チルトは光軸ずれの情報なので保持
        const defaultRemoveIndices = [0];  // OSA/ANSI: j=0(piston)のみ
        const removeIndices = (typeof globalThis !== 'undefined' && Array.isArray(globalThis.__WAVEFRONT_REMOVE_OSA))
            ? globalThis.__WAVEFRONT_REMOVE_OSA
            : defaultRemoveIndices;

        // 除去用モデルを計算：除去する項のみを使ってOPDを再構築
        const removedModelMicrons = [];
        for (let i = 0; i < pupilCoordinates.length; i++) {
            const p = pupilCoordinates[i];
            if (!p || !isFinite(p.x) || !isFinite(p.y)) {
                removedModelMicrons.push(NaN);
                continue;
            }
            const rho = Math.sqrt(p.x * p.x + p.y * p.y);
            if (rho > 1.0 + 1e-9) {
                removedModelMicrons.push(NaN);
                continue;
            }

            // 除去対象の係数のみを抽出して再構築
            const maxJ = Math.max(...Object.keys(coefficientsMicrons).map(Number));
            const removeCoeffs = new Array(maxJ + 1).fill(0);
            for (const j of removeIndices) {
                if (coefficientsMicrons[j] !== undefined) {
                    removeCoeffs[j] = coefficientsMicrons[j];
                }
            }
            const model = reconstructOPD(removeCoeffs, p.x, p.y);
            
            // デバッグ：最初の数点でモデル値を確認
            if (i < 5) {
                console.log(`🔍 Point ${i}: pupil(${p.x.toFixed(3)}, ${p.y.toFixed(3)}), model=${model.toFixed(6)} μm`);
            }
            
            removedModelMicrons.push(model);
        }

        // Map形式で係数を保存（既存コードとの互換性）
        const coefficients = new Map();
        const maxJ = Math.max(...Object.keys(coefficientsMicrons).map(Number)) + 1;
        for (let j = 0; j < maxJ; j++) {
            const coeff = coefficientsMicrons[j] || 0;
            coefficients.set(j, coeff);
        }
        this.zernikeCoefficients = coefficients;

        // 🔧 軸上視野の物理的補正: m≠0項を除去
        // wavefrontMapにfieldSettingが含まれていないため、グローバルフラグで制御
        if (typeof globalThis !== 'undefined' && globalThis.__REMOVE_ASYMMETRIC_ZERNIKE_FOR_ONAXIS === true) {
            console.log(`🔧 [fitZernikePolynomials] Removing m≠0 Zernike terms for on-axis field`);
            let removedCount = 0;
            
            for (let j = 0; j < maxJ; j++) {
                // OSA index j から (n, m) を計算
                const n = Math.floor((-1 + Math.sqrt(1 + 8 * j)) / 2);
                const m = 2 * j - n * (n + 2);
                
                // m ≠ 0 の項を除去
                if (m !== 0 && coefficientsMicrons[j] !== undefined && coefficientsMicrons[j] !== 0) {
                    if (removedCount < 5) {
                        console.log(`  Removed OSA j=${j} (n=${n}, m=${m}): ${coefficientsMicrons[j].toExponential(3)} μm → 0`);
                    }
                    coefficientsMicrons[j] = 0;
                    coefficients.set(j, 0);
                    removedCount++;
                }
            }
            
            console.log(`🔧 [fitZernikePolynomials] Removed ${removedCount} asymmetric terms`);
        }

        return {
            maxNoll: (maxOrderForFit + 1) * (maxOrderForFit + 2) / 2,
            coefficientsMicrons,
            coefficientsWaves: Object.fromEntries(
                Object.entries(coefficientsMicrons).map(([k, v]) => [k, v / this.opdCalculator.wavelength])
            ),
            removed: removeIndices,
            removedModelMicrons,
            stats: {
                full: {
                    points: validPoints.length,
                    pointsAfterOutlierFilter: filteredPoints.length,
                    rmsResidual: fitResult.rms || 0
                },
                outlierFilter: outlierFilterStats
            }
        };
    }

    /**
     * System Data 用: 規格化Zernike（Noll）でのフィット式と係数をテキスト化
     * - 係数表は「フィット係数（生）」を表示（piston/tilt/defocus を含む）
     * - OPD表示（描画）は piston/tilt のみ除去し、defocus は残す
     */
    formatZernikeReportText(wavefrontMap, options = {}) {
        try {
            const z = wavefrontMap?.zernike;
            const fitCoeffs = (z?.coefficientsMicrons && typeof z.coefficientsMicrons === 'object')
                ? z.coefficientsMicrons
                : (wavefrontMap?.zernikeModel?.fitCoefficientsMicrons && typeof wavefrontMap.zernikeModel.fitCoefficientsMicrons === 'object')
                    ? wavefrontMap.zernikeModel.fitCoefficientsMicrons
                    : null;

            const displayCoeffs = (wavefrontMap?.zernikeModel?.usedCoefficientsMicrons && typeof wavefrontMap.zernikeModel.usedCoefficientsMicrons === 'object')
                ? wavefrontMap.zernikeModel.usedCoefficientsMicrons
                : fitCoeffs;

            const displayRemovedNoll = Array.isArray(wavefrontMap?.zernikeModel?.displayRemovedNoll)
                ? wavefrontMap.zernikeModel.displayRemovedNoll
                : [1, 2, 3];

            if (!fitCoeffs) {
                const lines = [];
                lines.push('=== Zernike Fitting (Orthonormal / Gram–Schmidt) ===');
                lines.push(`Field: ${wavefrontMap?.fieldSetting?.displayName || ''}`);
                lines.push('Zernike report unavailable: coefficients were not produced (missing wavefrontMap.zernike.coefficientsMicrons).');
                return lines.join('\n');
            }

            const wavelength = Number.isFinite(this.opdCalculator?.wavelength) ? this.opdCalculator.wavelength : NaN;
            const maxNoll = Number.isFinite(options?.maxNoll) ? Math.max(1, Math.floor(options.maxNoll)) : (z?.maxNoll || 0);
            const maxUsed = Math.max(1, Math.min(wavefrontMap?.zernikeModel?.maxNollUsed || maxNoll, maxNoll));
            const usedCoeffs = fitCoeffs;

            const calcStatsWaves = (arr) => {
                if (!Array.isArray(arr) || arr.length === 0) {
                    return { count: 0, mean: NaN, rms: NaN, peakToPeak: NaN, min: NaN, max: NaN };
                }
                // Include 0.0 values (valid data). Only drop non-finite.
                const valid = arr.filter(v => Number.isFinite(v));
                if (!valid.length) {
                    return { count: 0, mean: NaN, rms: NaN, peakToPeak: NaN, min: NaN, max: NaN };
                }
                const count = valid.length;
                const mean = valid.reduce((s, v) => s + v, 0) / count;
                const variance = valid.reduce((s, v) => s + (v - mean) * (v - mean), 0) / count;
                const rms = Math.sqrt(variance);
                const min = Math.min(...valid);
                const max = Math.max(...valid);
                const peakToPeak = max - min;
                return { count, mean, rms, peakToPeak, min, max };
            };

            const fmtStatsLine = (label, st) => {
                if (!st || !Number.isFinite(st.rms)) {
                    return `${label}: (insufficient)`;
                }
                return `${label}: count=${st.count}, mean=${st.mean.toFixed(6)} λ, rms=${st.rms.toFixed(6)} λ, P-P=${st.peakToPeak.toFixed(6)} λ, min=${st.min.toFixed(6)} λ, max=${st.max.toFixed(6)} λ`;
            };

            const lines = [];
            lines.push('=== Zernike Fitting (Orthonormal / Gram–Schmidt) ===');
            lines.push(`Field: ${wavefrontMap?.fieldSetting?.displayName || ''}`);
            if (wavefrontMap?.statistics?.opdWavelengths?.opdMode || wavefrontMap?.opdMode) {
                const mode = wavefrontMap?.statistics?.opdWavelengths?.opdMode || wavefrontMap?.opdMode;
                lines.push(`OPD mode: ${mode}`);
            }
            if (wavefrontMap?.statistics?.display?.opdWavelengths?.opdDisplayMode || wavefrontMap?.opdDisplayModeRequested) {
                const dmode = wavefrontMap?.statistics?.display?.opdWavelengths?.opdDisplayMode || wavefrontMap?.opdDisplayModeRequested;
                lines.push(`OPD display mode: ${dmode}`);
            }
            lines.push(`Basis: Normalized Zernike (Noll indexing)`);
            lines.push(`Max Noll used: ${maxUsed}`);
            lines.push(`OPD display removal: piston/tilt only (Noll ${displayRemovedNoll.join(', ')})`);
            if (z?.stats?.full?.rmsResidual !== undefined) {
                lines.push(`Fit RMS residual: ${Number.isFinite(z.stats.full.rmsResidual) ? z.stats.full.rmsResidual.toFixed(6) : z.stats.full.rmsResidual} μm`);
            }
            
            // ⚠️ Warning about asymmetric sampling
            const coords = wavefrontMap?.pupilCoordinates || [];
            if (coords.length > 0) {
                const yValues = coords.filter(p => Number.isFinite(p?.y)).map(p => p.y);
                if (yValues.length > 0) {
                    const yMin = Math.min(...yValues);
                    const yMax = Math.max(...yValues);
                    const yRange = yMax - yMin;
                    const yCenter = (yMax + yMin) / 2;
                    const asymmetry = Math.abs(yCenter) / (yRange || 1);
                    
                    if (asymmetry > 0.1) {
                        lines.push('');
                        lines.push('⚠️  WARNING: Asymmetric sample distribution detected');
                        lines.push(`   Y-coordinate range: [${yMin.toFixed(3)}, ${yMax.toFixed(3)}], center offset: ${yCenter.toFixed(3)}`);
                        lines.push('   High-order Zernike coefficients (j>3) may have reduced accuracy.');
                        lines.push('   Low-order coefficients (piston, tilt) are computed analytically and remain accurate.');
                    }
                }
            }
            
            lines.push('');
            lines.push('Fitting / Rendering equation:');
            lines.push('  ρ = sqrt(x^2 + y^2) / pupilRange,  θ = atan2(y, x)');
            lines.push('  W(ρ,θ) [μm] = Σ_{j=1..J} c_j · Z_j(ρ,θ),   J = max Noll used');
            lines.push('');
            lines.push('Normalized Zernike definition (n,m):');
            lines.push('  Z_n^0(ρ,θ)   = sqrt(n+1) · R_n^{0}(ρ)');
            lines.push('  Z_n^{m>0}(ρ,θ) = sqrt(2(n+1)) · R_n^{m}(ρ) · cos(mθ)');
            lines.push('  Z_n^{-m}(ρ,θ)  = sqrt(2(n+1)) · R_n^{m}(ρ) · sin(mθ)');
            lines.push('');
            lines.push('Coefficients (fitted):');
            lines.push('  j\t(n,m)\tc_j [μm]\tc_j [waves]');

            for (let j = 1; j <= maxUsed; j++) {
                const nm = nollToNM(j);
                const osaIndex = nollToOSA(j);
                const c = Number(usedCoeffs?.[osaIndex] ?? 0);
                const cw = (Number.isFinite(c) && Number.isFinite(wavelength) && wavelength > 0) ? (c / wavelength) : NaN;
                const cStr = Number.isFinite(c) ? c.toExponential(6) : String(c);
                const wStr = Number.isFinite(cw) ? cw.toExponential(6) : String(cw);
                lines.push(`  ${j}\t(${nm.n},${nm.m})\t${cStr}\t${wStr}`);
            }

            // RMS comparison
            lines.push('');
            lines.push('=== RMS Comparison ===');

            // Keep a minimal summary up-front (aligned columns).
            lines.push('Summary (start here):');

            // NOTE: In this codebase, the "primary" OPD stats remove piston (mean) only; tilt is NOT removed.
            // For an apples-to-apples comparison against Zernike piston/tilt-removed RMS, also show a
            // sample-based OPD RMS with piston+tilt removed via best-fit plane (view-transform).
            const sumLabel1 = 'OPD RMS (sample, piston+tilt removed)';
            const sumLabel2 = 'OPD RMS (sample, piston removed)';
            const sumLabel3 = 'Zernike RMS (sample, piston/tilt removed)';
            const sumLabel4 = 'Coeff RMS (area, piston/tilt removed)';

            const col1W = Math.max(18, sumLabel1.length);
            const col2W = Math.max(30, sumLabel2.length);
            const col3W = Math.max(34, sumLabel3.length);
            const col4W = Math.max(30, sumLabel4.length);

            lines.push(`  ${sumLabel1.padEnd(col1W)} / ${sumLabel2.padEnd(col2W)} / ${sumLabel3.padEnd(col3W)} / ${sumLabel4.padEnd(col4W)}`);
            const summaryValueLineIndex = lines.length;
            lines.push(`  ${''.padStart(col1W)} / ${''.padStart(col2W)} / ${''.padStart(col3W)} / ${''.padStart(col4W)}`);

            lines.push('OPD samples (units: waves λ):');

            const primaryOpdWaves = wavefrontMap?.statistics?.opdWavelengths;
            if (primaryOpdWaves && Number.isFinite(primaryOpdWaves.rms)) {
                lines.push(
                    `  primary (piston removed; tilt kept): count=${primaryOpdWaves.count}, mean=${primaryOpdWaves.mean.toFixed(6)} λ, rms=${primaryOpdWaves.rms.toFixed(6)} λ, P-P=${primaryOpdWaves.peakToPeak.toFixed(6)} λ, min=${primaryOpdWaves.min.toFixed(6)} λ, max=${primaryOpdWaves.max.toFixed(6)} λ`
                );
            } else {
                const st = calcStatsWaves(wavefrontMap?.opdsInWavelengths);
                lines.push(`  ${fmtStatsLine('primary (recomputed)', st)}`);
            }

            // OPD stats with piston+tilt removed (best-fit plane) for fair comparison.
            let opdPistonTiltRemovedWavesStats = null;
            try {
                const ds = wavefrontMap?.statistics?.display;
                if (ds && ds.mode === 'pistonTiltRemoved' && ds.opdWavelengths && Number.isFinite(ds.opdWavelengths.rms)) {
                    opdPistonTiltRemovedWavesStats = ds.opdWavelengths;
                } else if (Array.isArray(wavefrontMap?.pupilCoordinates) && Array.isArray(wavefrontMap?.opds) && wavefrontMap.pupilCoordinates.length === wavefrontMap.opds.length) {
                    const fit = this._removeBestFitPlane(wavefrontMap.pupilCoordinates, wavefrontMap.opds);
                    if (fit && Array.isArray(fit.residualWaves) && fit.residualWaves.length) {
                        opdPistonTiltRemovedWavesStats = this.calculateStatistics(fit.residualWaves, { removePiston: false });
                    }
                }
            } catch (_) {
                opdPistonTiltRemovedWavesStats = null;
            }

            const rawStats = wavefrontMap?.statistics?.raw?.opdWavelengths;
            if (rawStats && Number.isFinite(rawStats.rms)) {
                lines.push(
                    `  raw (no piston removal): count=${rawStats.count}, mean=${rawStats.mean.toFixed(6)} λ, rms=${rawStats.rms.toFixed(6)} λ, P-P=${rawStats.peakToPeak.toFixed(6)} λ, min=${rawStats.min.toFixed(6)} λ, max=${rawStats.max.toFixed(6)} λ`
                );
            } else {
                const st = calcStatsWaves(wavefrontMap?.raw?.opdsInWavelengths);
                lines.push(`  ${fmtStatsLine('raw (recomputed)', st)}`);
            }

            // Build a sampled Zernike model on the same pupil samples (basis-independent RMS).
            const pr = (Number.isFinite(Number(wavefrontMap?.pupilRange)) && Number(wavefrontMap.pupilRange) > 0)
                ? Number(wavefrontMap.pupilRange)
                : 1.0;
            const pupilCoords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
            const buildSampledModelWaves = (coeffsMicrons, removedNoll = []) => {
                if (!coeffsMicrons || !pupilCoords.length || !Number.isFinite(wavelength) || wavelength <= 0) return null;
                const removedSet = new Set((Array.isArray(removedNoll) ? removedNoll : []).map(v => Math.floor(Number(v))));
                const model = [];
                for (let i = 0; i < pupilCoords.length; i++) {
                    const p = pupilCoords[i];
                    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                        model.push(NaN);
                        continue;
                    }
                    const rho = Math.hypot(p.x, p.y) / pr;
                    if (!(rho <= 1.0 + 1e-9)) {
                        model.push(NaN);
                        continue;
                    }
                    const theta = Math.atan2(p.y, p.x);
                    let opdMicrons = 0;
                    for (let j = 1; j <= maxUsed; j++) {
                        if (removedSet.has(j)) continue;
                        const c = Number(coeffsMicrons?.[j] ?? 0);
                        if (!Number.isFinite(c) || c === 0) continue;
                        opdMicrons += c * zernikeNoll(j, rho, theta);
                    }
                    model.push(opdMicrons / wavelength);
                }
                return model;
            };

            const modelWavesAll = Array.isArray(wavefrontMap?.zernikeModel?.opdsInWavelengths) && wavefrontMap.zernikeModel.opdsInWavelengths.length
                ? wavefrontMap.zernikeModel.opdsInWavelengths
                : buildSampledModelWaves(usedCoeffs, []);

            const modelWavesDisplayRemoved = buildSampledModelWaves(usedCoeffs, displayRemovedNoll);

            let stModelRemovedForSummary = null;
            if (Array.isArray(modelWavesAll) && modelWavesAll.length) {
                const stModel = calcStatsWaves(modelWavesAll);
                lines.push('Zernike model (reconstructed on same samples):');
                lines.push(`  ${fmtStatsLine('all fitted terms', stModel)}`);
                if (Array.isArray(modelWavesDisplayRemoved) && modelWavesDisplayRemoved.length) {
                    const stRemoved = calcStatsWaves(modelWavesDisplayRemoved);
                    stModelRemovedForSummary = stRemoved;
                    lines.push(`  ${fmtStatsLine(`piston/tilt removed (Noll ${displayRemovedNoll.join(', ')})`, stRemoved)}`);
                }
            }

            // Coefficient-derived RMS (ONLY valid as an area-mean RMS if the basis is orthonormal).
            // For normalized (orthonormal) Zernike on the unit disk: E[W^2] = Σ c_j^2.
            let sum2All = 0;
            let sum2Removed = 0;
            const removedSet = new Set(displayRemovedNoll.map(v => Math.floor(Number(v))));
            for (let j = 1; j <= maxUsed; j++) {
                const c = Number(usedCoeffs?.[j] ?? 0);
                if (!Number.isFinite(c)) continue;
                sum2All += c * c;
                if (!removedSet.has(j)) sum2Removed += c * c;
            }
            const rmsCoeffAllMicrons = Math.sqrt(sum2All);
            const rmsCoeffAllWaves = (Number.isFinite(rmsCoeffAllMicrons) && Number.isFinite(wavelength) && wavelength > 0)
                ? (rmsCoeffAllMicrons / wavelength)
                : NaN;
            const rmsCoeffRemovedMicrons = Math.sqrt(sum2Removed);
            const rmsCoeffRemovedWaves = (Number.isFinite(rmsCoeffRemovedMicrons) && Number.isFinite(wavelength) && wavelength > 0)
                ? (rmsCoeffRemovedMicrons / wavelength)
                : NaN;

            lines.push('Zernike coefficients (normalized / orthonormal assumption):');
            lines.push(
                `  area-mean RMS from coefficients (all terms): rms=${Number.isFinite(rmsCoeffAllWaves) ? rmsCoeffAllWaves.toFixed(6) : rmsCoeffAllWaves} λ  (${Number.isFinite(rmsCoeffAllMicrons) ? rmsCoeffAllMicrons.toFixed(6) : rmsCoeffAllMicrons} μm)`
            );
            lines.push(
                `  area-mean RMS excluding piston/tilt (Noll ${displayRemovedNoll.join(', ')}): rms=${Number.isFinite(rmsCoeffRemovedWaves) ? rmsCoeffRemovedWaves.toFixed(6) : rmsCoeffRemovedWaves} λ  (${Number.isFinite(rmsCoeffRemovedMicrons) ? rmsCoeffRemovedMicrons.toFixed(6) : rmsCoeffRemovedMicrons} μm)`
            );

            // Fill the summary line now that everything is computed.
            const primaryRms = (primaryOpdWaves && Number.isFinite(primaryOpdWaves.rms)) ? primaryOpdWaves.rms : NaN;
            const opdPistonTiltRemovedRms = (opdPistonTiltRemovedWavesStats && Number.isFinite(opdPistonTiltRemovedWavesStats.rms)) ? opdPistonTiltRemovedWavesStats.rms : NaN;
            const modelRemovedRms = (stModelRemovedForSummary && Number.isFinite(stModelRemovedForSummary.rms)) ? stModelRemovedForSummary.rms : NaN;
            const coeffRemovedRms = rmsCoeffRemovedWaves;

            const fmtSum = (v) => Number.isFinite(v) ? `${v.toFixed(6)} λ` : String(v);
            const v1 = fmtSum(opdPistonTiltRemovedRms).padStart(col1W);
            const v2 = fmtSum(primaryRms).padStart(col2W);
            const v3 = fmtSum(modelRemovedRms).padStart(col3W);
            const v4 = fmtSum(coeffRemovedRms).padStart(col4W);
            lines[summaryValueLineIndex] = `  ${v1} / ${v2} / ${v3} / ${v4}`;

            lines.push('Note:');
            lines.push('  - The coefficient RMS (sqrt(Σ c^2)) is only valid as an area-mean RMS under an orthonormal normalized Zernike basis.');
            lines.push('    If it differs from the discrete OPD sample RMS, use “Zernike model (reconstructed on same samples)” as the basis-independent comparison.');

            return lines.join('\n');
        } catch (e) {
            return '';
        }
    }
}

// ------------------------------
// OSA/ANSI Zernike helpers (新実装)
// ------------------------------

// Noll index → (n, m) 変換関数（eva-wavefront-plot.jsで使用）
function nollToNM(j) {
    return nollToNM_deprecated(j);
}

// Noll index → OSA/ANSI index 変換関数
function nollToOSA(nollIndex) {
    const nm = nollToNM(nollIndex);
    if (!nm || !Number.isFinite(nm.n) || !Number.isFinite(nm.m)) return -1;
    // OSA/ANSI index: j = (n*(n+2) + m) / 2
    const osaIndex = (nm.n * (nm.n + 2) + nm.m) / 2;
    return Math.floor(osaIndex);
}

function nollToNM_deprecated(j) {
    // Noll indexing (sequential) mapping.
    // Order n starts at j0 = n(n+1)/2 + 1 and has (n+1) terms with m = -n, -n+2, ..., n.
    const jj = Math.floor(Number(j));
    if (!Number.isFinite(jj) || jj < 1) return { n: 0, m: 0 };

    // Find smallest n such that (n+1)(n+2)/2 >= j
    let n = 0;
    while (((n + 1) * (n + 2)) / 2 < jj) n++;
    const j0 = (n * (n + 1)) / 2 + 1;
    const k = jj - j0; // 0..n
    const m = -n + 2 * k;
    return { n, m };
}

function factorial(n) {
    let r = 1;
    for (let k = 2; k <= n; k++) r *= k;
    return r;
}

function zernikeRadial(n, mAbs, rho) {
    let sum = 0;
    const kMax = (n - mAbs) / 2;
    for (let k = 0; k <= kMax; k++) {
        const num = factorial(n - k);
        const den = factorial(k) * factorial((n + mAbs) / 2 - k) * factorial((n - mAbs) / 2 - k);
        const coeff = ((k % 2) === 0 ? 1 : -1) * (num / den);
        sum += coeff * Math.pow(rho, n - 2 * k);
    }
    return sum;
}

function zernikeNormalized(n, m, rho, theta) {
    const mAbs = Math.abs(m);
    const R = zernikeRadial(n, mAbs, rho);
    if (m === 0) {
        return Math.sqrt(n + 1) * R;
    }
    const norm = Math.sqrt(2 * (n + 1));
    if (m > 0) {
        return norm * R * Math.cos(mAbs * theta);
    }
    return norm * R * Math.sin(mAbs * theta);
}

function zernikeNoll(j, rho, theta) {
    const { n, m } = nollToNM(j);
    return zernikeNormalized(n, m, rho, theta);
}

function solveLinearSystem(A, b) {
    const n = A.length;
    const M = A.map((row, i) => row.slice().concat([b[i]]));

    for (let col = 0; col < n; col++) {
        let pivotRow = col;
        let pivotVal = Math.abs(M[col][col]);
        for (let r = col + 1; r < n; r++) {
            const v = Math.abs(M[r][col]);
            if (v > pivotVal) {
                pivotVal = v;
                pivotRow = r;
            }
        }
        if (pivotVal === 0 || !isFinite(pivotVal)) {
            return null;
        }
        if (pivotRow !== col) {
            const tmp = M[col];
            M[col] = M[pivotRow];
            M[pivotRow] = tmp;
        }

        const diag = M[col][col];
        for (let c = col; c <= n; c++) {
            M[col][c] /= diag;
        }

        for (let r = 0; r < n; r++) {
            if (r === col) continue;
            const factor = M[r][col];
            if (factor === 0) continue;
            for (let c = col; c <= n; c++) {
                M[r][c] -= factor * M[col][c];
            }
        }
    }

    return M.map(row => row[n]);
}

function fitZernikeNollLeastSquares(points, maxNoll) {
    const m = maxNoll;
    const nPts = points.length;
    const coeffs = {};
    for (let j = 1; j <= m; j++) coeffs[j] = 0;

    if (nPts < m) {
        return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual: NaN } };
    }

    const ATA = Array.from({ length: m }, () => Array.from({ length: m }, () => 0));
    const ATb = Array.from({ length: m }, () => 0);

    for (const pt of points) {
        const rho = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        const theta = Math.atan2(pt.y, pt.x);
        const z = [];
        for (let j = 1; j <= m; j++) {
            z.push(zernikeNoll(j, rho, theta));
        }
        for (let i = 0; i < m; i++) {
            ATb[i] += z[i] * pt.opd;
            for (let k = 0; k < m; k++) {
                ATA[i][k] += z[i] * z[k];
            }
        }
    }

    const x = solveLinearSystem(ATA, ATb);
    if (!x) {
        return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual: NaN } };
    }

    for (let j = 1; j <= m; j++) {
        coeffs[j] = x[j - 1];
    }

    let sum2 = 0;
    let count = 0;
    for (const pt of points) {
        const rho = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        const theta = Math.atan2(pt.y, pt.x);
        let pred = 0;
        for (let j = 1; j <= m; j++) {
            pred += coeffs[j] * zernikeNoll(j, rho, theta);
        }
        const e = pt.opd - pred;
        if (isFinite(e)) {
            sum2 += e * e;
            count++;
        }
    }
    const rmsResidual = count > 0 ? Math.sqrt(sum2 / count) : NaN;

    return {
        coefficientsMicrons: coeffs,
        stats: {
            points: nPts,
            rmsResidual
        }
    };
}

function fitZernikeNollLeastSquaresSelected(points, nollList) {
    const nolls = Array.from(new Set((nollList || []).map(v => Math.floor(Number(v))).filter(v => Number.isFinite(v) && v >= 1)))
        .sort((a, b) => a - b);
    const k = nolls.length;
    const nPts = points.length;

    const coeffs = {};
    for (const j of nolls) coeffs[j] = 0;

    if (k === 0) {
        return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual: NaN } };
    }
    if (nPts < k) {
        return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual: NaN } };
    }

    const ATA = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
    const ATb = Array.from({ length: k }, () => 0);

    for (const pt of points) {
        const rho = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        const theta = Math.atan2(pt.y, pt.x);
        const z = nolls.map(j => zernikeNoll(j, rho, theta));
        for (let i = 0; i < k; i++) {
            ATb[i] += z[i] * pt.opd;
            for (let c = 0; c < k; c++) {
                ATA[i][c] += z[i] * z[c];
            }
        }
    }

    const x = solveLinearSystem(ATA, ATb);
    if (!x) {
        return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual: NaN } };
    }

    for (let i = 0; i < k; i++) {
        coeffs[nolls[i]] = x[i];
    }

    let sum2 = 0;
    let count = 0;
    for (const pt of points) {
        const rho = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        const theta = Math.atan2(pt.y, pt.x);
        let pred = 0;
        for (const j of nolls) {
            pred += (coeffs[j] || 0) * zernikeNoll(j, rho, theta);
        }
        const e = pt.opd - pred;
        if (isFinite(e)) {
            sum2 += e * e;
            count++;
        }
    }
    const rmsResidual = count > 0 ? Math.sqrt(sum2 / count) : NaN;

    return {
        coefficientsMicrons: coeffs,
        stats: {
            points: nPts,
            rmsResidual
        }
    };
}

// ------------------------------------------------------------
// Zernike fit via Gram–Schmidt orthonormalization (Modified GS)
// ------------------------------------------------------------

function fitZernikeNollGramSchmidt(points, maxNoll) {
    const m = Math.max(1, Math.floor(Number(maxNoll) || 1));
    const nPts = points.length;
    const coeffs = {};
    for (let j = 1; j <= m; j++) coeffs[j] = 0;

    if (nPts < 1) {
        return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual: NaN } };
    }

    // Compute low-order terms analytically to avoid numerical issues
    // with asymmetric sample distributions
    
    // Noll 1 (piston): mean OPD
    let sum_opd = 0;
    for (const pt of points) sum_opd += pt.opd;
    coeffs[1] = sum_opd / nPts;
    
    // Remove piston from OPD
    const opd_nopiston = new Float64Array(nPts);
    for (let i = 0; i < nPts; i++) {
        opd_nopiston[i] = points[i].opd - coeffs[1];
    }
    
    // Noll 2,3 (tilt): fit to residual after removing piston
    // Z_2 = 2*x, Z_3 = 2*y
    // Solve: OPD' = c_2*2x + c_3*2y
    let sum_x = 0, sum_y = 0, sum_x2 = 0, sum_y2 = 0, sum_xy = 0;
    let sum_opd_x = 0, sum_opd_y = 0;
    
    for (let i = 0; i < nPts; i++) {
        const pt = points[i];
        sum_x += pt.x;
        sum_y += pt.y;
        sum_x2 += pt.x * pt.x;
        sum_y2 += pt.y * pt.y;
        sum_xy += pt.x * pt.y;
        sum_opd_x += opd_nopiston[i] * pt.x;
        sum_opd_y += opd_nopiston[i] * pt.y;
    }
    
    // Solve 2x2 system: [Σx² Σxy][2c_2] = [Σ(OPD'x)]
    //                   [Σxy Σy²][2c_3]   [Σ(OPD'y)]
    const det = sum_x2 * sum_y2 - sum_xy * sum_xy;
    
    if (Math.abs(det) > 1e-10 && m >= 3) {
        const c2_times2 = (sum_opd_x * sum_y2 - sum_opd_y * sum_xy) / det;
        const c3_times2 = (sum_x2 * sum_opd_y - sum_xy * sum_opd_x) / det;
        coeffs[2] = c2_times2 / 2;
        coeffs[3] = c3_times2 / 2;
    }
    
    // For higher-order terms (if requested), subtract low-order fit and use QR
    if (m <= 3) {
        return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual: 0 } };
    }
    
    // Remove low-order contribution from OPD
    const residual_opd = new Float64Array(nPts);
    for (let i = 0; i < nPts; i++) {
        const pt = points[i];
        let fitted = coeffs[1] + coeffs[2] * 2 * pt.x + coeffs[3] * 2 * pt.y;
        residual_opd[i] = pt.opd - fitted;
    }

    // Build basis columns for j=4..m only
    const m_high = m - 3;
    const b = Array.from({ length: m_high }, () => new Float64Array(nPts));
    for (let i = 0; i < nPts; i++) {
        const pt = points[i];
        const rho = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        const theta = Math.atan2(pt.y, pt.x);
        for (let j = 4; j <= m; j++) {
            b[j - 4][i] = zernikeNoll(j, rho, theta);
        }
    }

    const dot = (u, v) => {
        let s = 0;
        for (let i = 0; i < nPts; i++) s += u[i] * v[i];
        return s;
    };

    // Modified Gram–Schmidt on high-order terms only
    const Q = Array.from({ length: m_high }, () => new Float64Array(nPts));
    const R = Array.from({ length: m_high }, () => new Float64Array(m_high));
    const REL_TOL = 1e-12;

    for (let j = 0; j < m_high; j++) {
        const v = new Float64Array(b[j]);
        let bb = 0;
        for (let i = 0; i < nPts; i++) bb += b[j][i] * b[j][i];
        const bNorm = Math.sqrt(Math.max(0, bb));
        for (let k = 0; k < j; k++) {
            const r = dot(Q[k], v);
            R[k][j] = r;
            const qk = Q[k];
            for (let i = 0; i < nPts; i++) v[i] -= r * qk[i];
        }
        let vv = 0;
        for (let i = 0; i < nPts; i++) vv += v[i] * v[i];
        const rjj = Math.sqrt(Math.max(0, vv));
        R[j][j] = rjj;
        const tol = REL_TOL * (Number.isFinite(bNorm) && bNorm > 0 ? bNorm : 1);
        if (!Number.isFinite(rjj) || rjj <= tol) {
            R[j][j] = 0;
            continue;
        }
        for (let i = 0; i < nPts; i++) Q[j][i] = v[i] / rjj;
    }

    // a = Q^T residual_opd
    const a = new Float64Array(m_high);
    for (let j = 0; j < m_high; j++) {
        a[j] = dot(Q[j], residual_opd);
    }

    // Back-substitution: R x = a
    const x = new Float64Array(m_high);
    for (let j = m_high - 1; j >= 0; j--) {
        let s = a[j];
        for (let k = j + 1; k < m_high; k++) s -= R[j][k] * x[k];
        const rjj = R[j][j];
        x[j] = (Number.isFinite(rjj) && rjj !== 0) ? (s / rjj) : 0;
    }

    // Store high-order coefficients
    for (let j = 4; j <= m; j++) coeffs[j] = x[j - 4];

    // Residual RMS
    let sum2 = 0;
    let count = 0;
    for (const pt of points) {
        const rho = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        const theta = Math.atan2(pt.y, pt.x);
        let pred = 0;
        for (let j = 1; j <= m; j++) pred += coeffs[j] * zernikeNoll(j, rho, theta);
        const e = pt.opd - pred;
        if (isFinite(e)) {
            sum2 += e * e;
            count++;
        }
    }
    const rmsResidual = count > 0 ? Math.sqrt(sum2 / count) : NaN;

    return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual } };
}

function fitZernikeNollGramSchmidtSelected(points, nollList) {
    const nolls = Array.from(new Set((nollList || []).map(v => Math.floor(Number(v))).filter(v => Number.isFinite(v) && v >= 1)))
        .sort((a, b) => a - b);
    const k = nolls.length;
    const nPts = points.length;

    const coeffs = {};
    for (const j of nolls) coeffs[j] = 0;

    if (k === 0 || nPts < 1) {
        return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual: NaN } };
    }

    const b = Array.from({ length: k }, () => new Float64Array(nPts));
    const y = new Float64Array(nPts);
    for (let i = 0; i < nPts; i++) {
        const pt = points[i];
        const rho = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        const theta = Math.atan2(pt.y, pt.x);
        y[i] = pt.opd;
        for (let c = 0; c < k; c++) {
            b[c][i] = zernikeNoll(nolls[c], rho, theta);
        }
    }

    const dot = (u, v) => {
        let s = 0;
        for (let i = 0; i < nPts; i++) s += u[i] * v[i];
        return s;
    };

    const Q = Array.from({ length: k }, () => new Float64Array(nPts));
    const R = Array.from({ length: k }, () => new Float64Array(k));

    const REL_TOL = 1e-12;

    for (let j = 0; j < k; j++) {
        const v = new Float64Array(b[j]);
        let bb = 0;
        for (let i = 0; i < nPts; i++) bb += b[j][i] * b[j][i];
        const bNorm = Math.sqrt(Math.max(0, bb));
        for (let p = 0; p < j; p++) {
            const r = dot(Q[p], v);
            R[p][j] = r;
            const qp = Q[p];
            for (let i = 0; i < nPts; i++) v[i] -= r * qp[i];
        }
        let vv = 0;
        for (let i = 0; i < nPts; i++) vv += v[i] * v[i];
        const rjj = Math.sqrt(Math.max(0, vv));
        R[j][j] = rjj;
        const tol = REL_TOL * (Number.isFinite(bNorm) && bNorm > 0 ? bNorm : 1);
        if (!Number.isFinite(rjj) || rjj <= tol) {
            R[j][j] = 0;
            continue;
        }
        for (let i = 0; i < nPts; i++) Q[j][i] = v[i] / rjj;
    }

    const a = new Float64Array(k);
    for (let j = 0; j < k; j++) a[j] = dot(Q[j], y);

    const x = new Float64Array(k);
    for (let j = k - 1; j >= 0; j--) {
        let s = a[j];
        for (let p = j + 1; p < k; p++) s -= R[j][p] * x[p];
        const rjj = R[j][j];
        x[j] = (Number.isFinite(rjj) && rjj !== 0) ? (s / rjj) : 0;
    }

    for (let c = 0; c < k; c++) coeffs[nolls[c]] = x[c];

    let sum2 = 0;
    let count = 0;
    for (const pt of points) {
        const rho = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
        const theta = Math.atan2(pt.y, pt.x);
        let pred = 0;
        for (let c = 0; c < k; c++) {
            const j = nolls[c];
            pred += (coeffs[j] || 0) * zernikeNoll(j, rho, theta);
        }
        const e = pt.opd - pred;
        if (isFinite(e)) {
            sum2 += e * e;
            count++;
        }
    }
    const rmsResidual = count > 0 ? Math.sqrt(sum2 / count) : NaN;

    return { coefficientsMicrons: coeffs, stats: { points: nPts, rmsResidual } };
}

/**
 * エクスポート用のファクトリ関数
 */
export function createOPDCalculator(opticalSystemRows, wavelength = 0.5876) {
    if (OPD_DEBUG) {
        console.log('🔧 OPDCalculator作成:');
        console.log(`  光学系行数: ${opticalSystemRows ? opticalSystemRows.length : 'null'}`);
        console.log(`  波長: ${wavelength}μm`);
    }
    
    // データの詳細検証とデバッグ
    if (!opticalSystemRows) {
        console.error('❌ opticalSystemRows が null または undefined です');
        if (OPD_DEBUG) console.log('🔧 サンプル光学系データを自動生成します');
        opticalSystemRows = createSampleOpticalSystemData();
    } else if (opticalSystemRows.length === 0) {
        console.error('❌ opticalSystemRows が空の配列です');
        if (OPD_DEBUG) console.log('� サンプル光学系データを自動生成します');
        opticalSystemRows = createSampleOpticalSystemData();
    } else {
        if (OPD_DEBUG) {
            console.log('�🔍 光学系データ詳細確認:');
            opticalSystemRows.forEach((row, index) => {
                const surface = index + 1;
                const object = row.object || row.Object || 'N/A';
                const thickness = row.thickness || row.Thickness || 'N/A';
                const aperture = row.aperture || row.Aperture || 'N/A';
                const radius = row.radius || row.Radius || 'N/A';
                const material = row.material || row.Material || 'N/A';
                
                console.log(`  面${surface}: object=${object}, thickness=${thickness}, aperture=${aperture}, radius=${radius}, material=${material}`);
                
                // 異常値チェック
                if (thickness === 'INF' || thickness === Infinity) {
                    console.warn(`    ⚠️ 面${surface}: thickness が無限大です`);
                }
                if (radius === 'INF' || radius === Infinity) {
                    console.log(`    ℹ️ 面${surface}: radius が無限大（平面）です`);
                }
                if (!material || material === 'N/A') {
                    console.warn(`    ⚠️ 面${surface}: 材料情報が不足しています`);
                }
            });
        }
    }
    
    return new OpticalPathDifferenceCalculator(opticalSystemRows, wavelength);
}

/**
 * サンプル光学系データを生成（テスト用）
 */
function createSampleOpticalSystemData() {
    if (OPD_DEBUG) console.log('🔧 サンプル光学系データ生成中...');
    return [
        { object: 'Object', thickness: Infinity, aperture: 10, radius: Infinity, material: 'air' },
        { object: 'L1_Front', thickness: 5, aperture: 8, radius: 50, material: 'BK7' },
        { object: 'L1_Back', thickness: 2, aperture: 8, radius: -50, material: 'air' },
        { object: 'Stop', thickness: 3, aperture: 6, radius: Infinity, material: 'air' },
        { object: 'L2_Front', thickness: 4, aperture: 8, radius: 30, material: 'BK7' },
        { object: 'L2_Back', thickness: 20, aperture: 8, radius: -30, material: 'air' },
        { object: 'Image', thickness: 0, aperture: 10, radius: Infinity, material: 'air' }
    ];
}

export function createWavefrontAnalyzer(opdCalculator) {
    if (OPD_DEBUG) console.log('🔧 WavefrontAnalyzer作成中...');
    
    if (!opdCalculator) {
        console.error('❌ OPDCalculator が null または undefined です');
        throw new Error('有効なOPDCalculatorが必要です。光学系設定を確認してください。');
    }
    
    // OPDCalculatorの有効性をチェック
    if (!opdCalculator.opticalSystemRows || opdCalculator.opticalSystemRows.length === 0) {
        console.error('❌ OPDCalculator内の光学系データが空です');
        throw new Error('有効な光学系データが必要です。光学系設定を確認してください。');
    }
    
    return new WavefrontAberrationAnalyzer(opdCalculator);
}

/**
 * 使用例（コメントアウト）:
 * 
 * // 計算機を作成
 * const calculator = createOPDCalculator(opticalSystemRows, 0.5876);
 * const analyzer = createWavefrontAnalyzer(calculator);
 * 
 * // フィールド設定
 * const fieldSetting = { yHeight: 0, xHeight: 0 }; // On-axis
 * 
 * // 波面収差マップを生成
 * const wavefrontMap = analyzer.generateWavefrontMap(fieldSetting, 16);
 * 
 * // 特定の瞳位置での光路差を計算
 * calculator.setReferenceRay(fieldSetting);
 * const opd = calculator.calculateOPD(0.5, 0.0, fieldSetting);
 * const waveAberr = calculator.calculateWavefrontAberration(0.5, 0.0, fieldSetting);
 */

// グローバル公開（デバッグ・テスト用）
if (typeof window !== 'undefined') {
    window.OpticalPathDifferenceCalculator = OpticalPathDifferenceCalculator;
    window.WavefrontAberrationAnalyzer = WavefrontAberrationAnalyzer;
    window.createWavefrontAnalyzer = createWavefrontAnalyzer;

}
