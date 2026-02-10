/**
 * Aperture Edge Ray Calculation Module
 * 絞り周辺光線計算モジュール
 * 
 * 機能:
 * - 絞り周辺光線計算（上下左右4方向）
 * - 主光線と同様のNewton法を使用
 * - 波面収差・光線収差解析用のデータ提供
 * 
 * 作成日: 2025/08/06
 */

import { traceRay } from './ray-tracing.ts';
import { calculateChiefRayNewton } from '../../evaluation/aberrations/transverse-aberration.ts';

/**
 * 絞り周辺光線の4方向計算（上下左右）
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} fieldSetting - フィールド設定
 * @param {number} apertureRadius - 絞り半径（相対値: 0-1）
 * @param {number} wavelength - 波長 (μm)
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object} 絞り周辺光線データ（上下左右）
 */
export function calculateApertureEdgeRays(opticalSystemRows, fieldSetting, apertureRadius = 1.0, wavelength = 0.5876, debugMode = false) {
    if (debugMode) {
        console.log(`🎯 [ApertureEdge] 絞り周辺光線計算開始:`);
        console.log(`   フィールド: ${fieldSetting.displayName || JSON.stringify(fieldSetting)}`);
        console.log(`   絞り半径: ${apertureRadius}`);
        console.log(`   波長: ${wavelength}μm`);
    }

    try {
        // 絞り面の位置を取得（STOPと記載された面を探す）
        const apertureSurfaceIndex = findApertureSurface(opticalSystemRows);
        if (apertureSurfaceIndex === -1) {
            console.error('❌ [ApertureEdge] 絞り面が見つかりません');
            return null;
        }

        const apertureSurface = opticalSystemRows[apertureSurfaceIndex];
        const apertureRadius_abs = (apertureSurface.semidia || 1.0) * apertureRadius;

        if (debugMode) {
            console.log(`🎯 [ApertureEdge] 絞り面: 面${apertureSurfaceIndex}, 半径=${apertureRadius_abs.toFixed(3)}`);
        }

        // 主光線の絞り面での交点を計算（ここを基点に外側へ探索）
        let chiefAtAperture = null;
        let chiefRayResult = null;
        try {
            chiefRayResult = calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelength);
            if (chiefRayResult && chiefRayResult.convergence?.converged) {
                const pos = calculateRayPositionAtSurface(
                    chiefRayResult.startP,
                    chiefRayResult.dir,
                    opticalSystemRows,
                    apertureSurfaceIndex
                );
                if (pos && isFinite(pos.x) && isFinite(pos.y)) {
                    chiefAtAperture = { x: pos.x, y: pos.y };
                }
            }
        } catch (e) {
            if (debugMode) console.warn('⚠️ [ApertureEdge] 主光線計算に失敗（フォールバックします）:', e?.message);
        }

        const results = {};

        const directions = ['top','bottom','right','left'];
        // 各方向に対して絞り周辺光線を計算
        for (const direction of directions) {
            if (debugMode) {
                console.log(`🔄 [ApertureEdge] ${direction}方向の絞り周辺光線計算中...`);
            }

            // まず主光線の交点から外側に向かってターゲットを生成
            const targetCandidates = generateTargetsFromChief(
                chiefAtAperture,
                direction,
                apertureRadius_abs
            );

            // フォールバック: 従来の軸上ターゲットと正規化スクエア端
            const fallbackTargets = fallbackTargetsForDirection(direction, apertureRadius_abs, chiefAtAperture);
            const allTargets = dedupeTargets([...targetCandidates, ...fallbackTargets]);

            let edgeRayResult = null;
            for (const target of allTargets) {
                const res = calculateApertureEdgeRayForDirection(
                    opticalSystemRows,
                    fieldSetting,
                    target,
                    apertureSurfaceIndex,
                    wavelength,
                    debugMode
                );
                if (res) { edgeRayResult = res; break; }
            }

            if (edgeRayResult) {
                results[direction] = edgeRayResult;
                if (debugMode) {
                    console.log(`✅ [ApertureEdge] ${direction}方向完了`);
                }
            } else {
                console.warn(`⚠️ [ApertureEdge] ${direction}方向の計算に失敗`);
                results[direction] = null;
            }
        }

        // 結果の統計情報
        const successCount = Object.values(results).filter(r => r !== null).length;
        if (debugMode) {
            console.log(`📊 [ApertureEdge] 計算結果: ${successCount}/4方向成功`);
        }

        return {
            success: successCount > 0,
            apertureRadius: apertureRadius_abs,
            apertureSurfaceIndex,
            wavelength,
            fieldSetting,
            rays: results
        };

    } catch (error) {
        console.error('❌ [ApertureEdge] 絞り周辺光線計算エラー:', error);
        return null;
    }
}

/**
 * 特定方向の絞り周辺光線を計算
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} fieldSetting - フィールド設定
 * @param {Object} edgePosition - 絞り面での光線位置
 * @param {number} apertureSurfaceIndex - 絞り面インデックス
 * @param {number} wavelength - 波長
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object} 光線計算結果
 */
function calculateApertureEdgeRayForDirection(opticalSystemRows, fieldSetting, edgePosition, apertureSurfaceIndex, wavelength, debugMode = false) {
    try {
        // Newton法で物体面から絞り面の指定位置を通る光線を計算
        const rayResult = calculateRayToAperturePosition(
            opticalSystemRows,
            fieldSetting,
            edgePosition,
            apertureSurfaceIndex,
            wavelength,
            debugMode
        );

        if (!rayResult || !rayResult.convergence?.converged) {
            if (debugMode) {
                console.warn('⚠️ [ApertureEdge] 光線計算が収束しませんでした');
            }
            return null;
        }

        // 完全な光線追跡を実行
        const traceResult = traceApertureEdgeRayComplete(
            opticalSystemRows, 
            rayResult, 
            wavelength, 
            debugMode
        );

        if (!traceResult.success) {
            return null;
        }

        return {
            startPosition: rayResult.startP,
            startDirection: rayResult.dir,
            aperturePosition: edgePosition,
            rayPath: traceResult.rayPath,
            finalPosition: traceResult.finalPosition,
            exitDirection: traceResult.exitDirection,
            pathLength: traceResult.pathLength,
            convergence: rayResult.convergence
        };

    } catch (error) {
        if (debugMode) {
            console.error('❌ [ApertureEdge] 方向別計算エラー:', error);
        }
        return null;
    }
}

/**
 * Newton法で物体面から絞り面の指定位置を通る光線を計算
 * 主光線計算と同じアルゴリズムを使用
 */
function calculateRayToAperturePosition(opticalSystemRows, fieldSetting, targetAperturePos, apertureSurfaceIndex, wavelength, debugMode = false) {
    try {
        // 主光線計算のアルゴリズムを流用
        // fieldSettingを一時的に調整して、絞り面での目標位置を指定
        const modifiedFieldSetting = {
            ...fieldSetting,
            // 絞り面での目標位置を追加情報として設定
            targetAperturePosition: targetAperturePos,
            targetApertureSurface: apertureSurfaceIndex
        };

        // Newton法を使用（主光線計算関数を流用）
        // 注意: この部分は主光線計算関数を修正して絞り面目標位置に対応させる必要があります
        const rayResult = calculateChiefRayNewton(opticalSystemRows, modifiedFieldSetting, wavelength);
        
        if (rayResult && rayResult.convergence?.converged) {
            // 絞り面での実際の位置をチェック
            const actualAperturePos = calculateRayPositionAtSurface(
                rayResult.startP, 
                rayResult.dir, 
                opticalSystemRows, 
                apertureSurfaceIndex
            );
            
            if (actualAperturePos) {
                const distance = Math.sqrt(
                    Math.pow(actualAperturePos.x - targetAperturePos.x, 2) +
                    Math.pow(actualAperturePos.y - targetAperturePos.y, 2)
                );
                
                if (debugMode) {
                    console.log(`🎯 [ApertureEdge] 目標位置との距離: ${distance.toFixed(6)}`);
                }
                
                // 許容誤差内であれば成功
                if (distance < 1e-3) {
                    return rayResult;
                }
            }
        }
        
        return null;

    } catch (error) {
        if (debugMode) {
            console.error('❌ [ApertureEdge] Newton法計算エラー:', error);
        }
        return null;
    }
}

/**
 * 絞り周辺光線の完全な光線追跡を実行
 */
function traceApertureEdgeRayComplete(opticalSystemRows, rayResult, wavelength, debugMode = false) {
    try {
        const opticalRowsCopy = JSON.parse(JSON.stringify(opticalSystemRows));
        const debugLog = [];
        const initialRay = {
            pos: rayResult.startP,
            dir: rayResult.dir
        };
        
        const rayPath = traceRay(opticalRowsCopy, initialRay, 1.0, debugLog);
        
        if (!rayPath || rayPath.length === 0) {
            return { success: false, error: 'Ray path is null or empty' };
        }

        // 最終位置と射出方向を取得
        const finalPoint = rayPath[rayPath.length - 1];
        const finalPos = finalPoint?.pos || finalPoint;
        
        if (!finalPos || typeof finalPos.x !== 'number') {
            return { success: false, error: 'Invalid final position' };
        }

        // 光路長計算
        let totalPathLength = 0;
        for (let i = 1; i < rayPath.length; i++) {
            const p1 = rayPath[i-1]?.pos || rayPath[i-1];
            const p2 = rayPath[i]?.pos || rayPath[i];
            if (p1 && p2) {
                const distance = Math.sqrt(
                    Math.pow(p2.x - p1.x, 2) +
                    Math.pow(p2.y - p1.y, 2) +
                    Math.pow(p2.z - p1.z, 2)
                );
                totalPathLength += distance;
            }
        }

        return {
            success: true,
            rayPath,
            finalPosition: finalPos,
            exitDirection: rayPath.length > 1 ? calculateExitDirection(rayPath) : rayResult.dir,
            pathLength: totalPathLength
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 絞り面を検索
 */
function findApertureSurface(opticalSystemRows) {
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const row = opticalSystemRows[i];
        if (row.note && row.note.toUpperCase().includes('STOP')) {
            return i;
        }
        // 絞り面は通常、半径が最小の面でもある
        if (i > 0 && row.semidia && row.semidia < 100) {  // 適切な閾値を設定
            // 他の面と比較して明らかに小さい場合
            const avgSemidia = opticalSystemRows
                .filter(r => r.semidia && r.semidia > 0)
                .reduce((sum, r) => sum + r.semidia, 0) / opticalSystemRows.length;
            
            if (row.semidia < avgSemidia * 0.5) {
                return i;
            }
        }
    }
    return -1; // 見つからない場合
}

/**
 * 指定面での光線位置を計算
 */
function calculateRayPositionAtSurface(startPos, direction, opticalSystemRows, surfaceIndex) {
    // 簡略化された実装: 実際にはtraceRayを使って指定面まで追跡
    try {
        const rayPath = traceRay(opticalSystemRows.slice(0, surfaceIndex + 1), 
                                { pos: startPos, dir: direction }, 1.0);
        
        if (rayPath && rayPath.length > surfaceIndex) {
            const surfacePos = rayPath[surfaceIndex]?.pos || rayPath[surfaceIndex];
            return surfacePos;
        }
        return null;
    } catch (error) {
        return null;
    }
}

/**
 * 主光線交点から外側へ向かうターゲット列を生成（境界→中心の順で段階的に内側へ）
 */
function generateTargetsFromChief(chiefAtAperture, direction, R) {
    const targets = [];
    if (!chiefAtAperture || !isFinite(chiefAtAperture.x) || !isFinite(chiefAtAperture.y) || !isFinite(R) || R <= 0) {
        return targets; // 主光線がない場合は空（フォールバックに任せる）
    }

    const cx = chiefAtAperture.x;
    const cy = chiefAtAperture.y;
    const R2 = R * R;

    // 方向ごとに、主光線からその方向の境界点を計算（円形境界 x^2 + y^2 = R^2 に沿う）
    let bx = cx, by = cy;
    if (direction === 'top') {
        const rad = Math.max(R2 - cx*cx, 0);
        by = Math.sqrt(rad);
        bx = cx;
        if (by < cy) by = cy; // 念のため単調性を確保
    } else if (direction === 'bottom') {
        const rad = Math.max(R2 - cx*cx, 0);
        by = -Math.sqrt(rad);
        bx = cx;
        if (by > cy) by = cy;
    } else if (direction === 'right') {
        const rad = Math.max(R2 - cy*cy, 0);
        bx = Math.sqrt(rad);
        by = cy;
        if (bx < cx) bx = cx;
    } else if (direction === 'left') {
        const rad = Math.max(R2 - cy*cy, 0);
        bx = -Math.sqrt(rad);
        by = cy;
        if (bx > cx) bx = cx;
    }

    // s=1.0（境界）から内側へ: 0.95, 0.9, ... 0.5
    const steps = [1.0, 0.975, 0.95, 0.925, 0.9, 0.875, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5];
    for (const s of steps) {
        const tx = cx + (bx - cx) * s;
        const ty = cy + (by - cy) * s;
        // 範囲内にクリップ
        const clx = Math.max(-R, Math.min(R, tx));
        const cly = Math.max(-R, Math.min(R, ty));
        targets.push({ x: clx, y: cly, z: 0 });
    }
    return targets;
}

/**
 * 軸上ターゲットと正規化スクエア端ターゲット（保険）
 */
function fallbackTargetsForDirection(direction, R, chiefAtAperture) {
    const list = [];
    // 既存の軸上ターゲット
    if (direction === 'top') list.push({ x: 0, y: R, z: 0 });
    if (direction === 'bottom') list.push({ x: 0, y: -R, z: 0 });
    if (direction === 'right') list.push({ x: R, y: 0, z: 0 });
    if (direction === 'left') list.push({ x: -R, y: 0, z: 0 });

    // 正規化スクエアの端（(x,y)∈[-R,R]^2）
    if (chiefAtAperture) {
        const cx = Math.max(-R, Math.min(R, chiefAtAperture.x || 0));
        const cy = Math.max(-R, Math.min(R, chiefAtAperture.y || 0));
        if (direction === 'top') list.push({ x: cx, y: R, z: 0 });
        if (direction === 'bottom') list.push({ x: cx, y: -R, z: 0 });
        if (direction === 'right') list.push({ x: R, y: cy, z: 0 });
        if (direction === 'left') list.push({ x: -R, y: cy, z: 0 });
    }
    return list;
}

function dedupeTargets(arr) {
    const seen = new Set();
    const out = [];
    for (const p of arr) {
        if (!p) continue;
        const key = `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(p);
        }
    }
    return out;
}

/**
 * 射出方向を計算
 */
function calculateExitDirection(rayPath) {
    if (rayPath.length < 2) return null;
    
    const lastPos = rayPath[rayPath.length - 1]?.pos || rayPath[rayPath.length - 1];
    const prevPos = rayPath[rayPath.length - 2]?.pos || rayPath[rayPath.length - 2];
    
    if (!lastPos || !prevPos) return null;
    
    const dx = lastPos.x - prevPos.x;
    const dy = lastPos.y - prevPos.y;
    const dz = lastPos.z - prevPos.z;
    const length = Math.sqrt(dx*dx + dy*dy + dz*dz);
    
    if (length === 0) return null;
    
    return {
        x: dx / length,
        y: dy / length,
        z: dz / length
    };
}

// グローバルスコープで利用できるように設定
if (typeof window !== 'undefined') {
    window.calculateApertureEdgeRays = calculateApertureEdgeRays;
}
