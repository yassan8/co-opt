/**
 * Marginal Ray Tracing Module for Aperture Edge Rays
 * 絞り周辺光線追跡モジュール
 * 
 * 機能:
 * - 絞り周辺光線計算（上下左右の4方向）
 * - 主光線と同様のニュートン法ベース収束
 * - 完全な光線追跡データ提供
 * - 絞りの物理的制約による光線制限の検出
 * 
 * 作成日: 2025/08/06
 */

// @ts-nocheck

import { traceRay } from './ray-tracing.ts';
import { calculateChiefRayNewton } from '../../evaluation/aberrations/transverse-aberration.ts';
// ray-tracing.jsが依存するutils/math.jsも確実にロード
import '../../utils/math.js';

/**
 * 絞り面のインデックスを検出
 * @param {Array} opticalSystemRows - 光学系データ
 * @returns {number} 絞り面のインデックス
 */
function findApertureStopIndex(opticalSystemRows) {
    console.log(`🔍 [findApertureStopIndex] 絞り面検出開始, 面数: ${opticalSystemRows.length}`);
    
    // 1. まずSTOタイプを探す
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const row = opticalSystemRows[i];
        console.log(`   面${i + 1}: surface_type="${row.surface_type}", object="${row['object type'] || row.object}", aperture="${row.aperture || row.Aperture}"`);
        
        if (row.surface_type === 'STO' || 
            row['object type'] === 'STO' || 
            String(row.object).toUpperCase() === 'STO') {
            console.log(`   ✅ STO面発見: Surface ${i + 1}`);
            return i;
        }
    }
    
    console.log(`   ℹ️ STO面未発見、最小開口面を検索`);
    
    // 2. STOが見つからない場合、最小開口面を探す
    let minApertureIndex = -1;
    let minAperture = Infinity;
    
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const row = opticalSystemRows[i];
        if (row['object type'] === 'Object' || 
            row['object type'] === 'Image' || 
            row.surface_type === 'Object' || 
            row.surface_type === 'Image') {
            console.log(`   スキップ: 面${i + 1} (${row['object type'] || row.surface_type})`);
            continue; // Object面とImage面はスキップ
        }
        
        // apertureまたはApertureフィールドをチェック
        const aperture = parseFloat(row.aperture || row.Aperture || row.semidia || row.thickness);
        console.log(`   面${i + 1}: aperture=${aperture} (元値: "${row.aperture || row.Aperture || row.semidia || row.thickness}")`);
        
        if (!isNaN(aperture) && aperture > 0 && aperture < minAperture) {
            minAperture = aperture;
            minApertureIndex = i;
            console.log(`   📏 新しい最小開口: 面${i + 1}, aperture=${aperture}mm`);
        }
    }
    
    if (minApertureIndex === -1) {
        console.log(`   ⚠️ 有効な絞り面が見つからない、面7をデフォルト使用`);
        return 6; // デフォルト: 面7（インデックス6）
    }
    
    console.log(`   ✅ 最小開口面検出: 面${minApertureIndex + 1}, aperture=${minAperture}mm`);
    return minApertureIndex;
}

/**
 * 絞り周辺光線（上下左右）を計算
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} fieldSetting - フィールド設定
 * @param {number} wavelength - 波長 (μm)
 * @param {string} direction - 方向 ('up', 'down', 'left', 'right')
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object} 絞り周辺光線データ
 */
export function calculateMarginalRay(opticalSystemRows, fieldSetting, direction, wavelength = 0.5875618, debugMode = false) {
    try {
        if (debugMode) {
            console.log(`🎯 [MarginalRay] 絞り周辺光線計算開始:`);
            console.log(`   フィールド: ${fieldSetting.name} (${fieldSetting.x || 0}, ${fieldSetting.y || 0}mm)`);
            console.log(`   方向: ${direction}`);
            console.log(`   波長: ${wavelength}μm`);
        }

        // 適応的絞り周辺光線計算を使用
        const result = calculateAdaptiveMarginalRay(opticalSystemRows, fieldSetting, direction, wavelength, debugMode);
        
        return result;

    } catch (error) {
        console.error(`❌ [MarginalRay] ${direction}方向絞り周辺光線計算エラー:`, error);
        return null;
    }
}

/**
 * 全方向の絞り周辺光線を一括計算
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} fieldSetting - フィールド設定
 * @param {number} wavelength - 波長 (μm)
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object} 全方向の絞り周辺光線データ
 */
export function calculateAllMarginalRays(opticalSystemRows, fieldSetting, wavelength = 0.5876, debugMode = false) {
    const directions = ['up', 'down', 'left', 'right'];
    const results = {};

    for (const direction of directions) {
        const marginalRay = calculateMarginalRay(opticalSystemRows, fieldSetting, direction, wavelength, debugMode);
        if (marginalRay) {
            results[direction] = marginalRay;
        } else {
            console.warn(`⚠️ [MarginalRay] ${direction}方向の計算に失敗しました`);
        }
    }

    return {
        marginalRays: results,
        fieldSetting: fieldSetting,
        wavelength: wavelength,
        calculationDate: new Date().toISOString(),
        successfulDirections: Object.keys(results),
        failedDirections: directions.filter(dir => !results[dir])
    };
}

/**
 * 絞り面を特定
 * @param {Array} opticalSystemRows - 光学系データ
 * @returns {number} 絞り面のインデックス（-1: 見つからない）
 */
function findApertureStop(opticalSystemRows) {
    // 1. STO (Stop) マークがある面を探す
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        if (surface.surface_type === 'STO' || surface.type === 'STO') {
            return i;
        }
    }

    // 2. 最小の aperture/semidia を持つ面を絞りとする
    let minAperture = Infinity;
    let stopIndex = -1;
    
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const aperture = parseFloat(surface.aperture) || parseFloat(surface.semidia) || Infinity;
        
        if (aperture < minAperture && aperture > 0) {
            minAperture = aperture;
            stopIndex = i;
        }
    }

    return stopIndex;
}

/**
 * 方向に応じた絞り周辺の目標位置を取得（適応的）
 * @param {string} direction - 方向
 * @param {number} radius - 絞り半径
 * @param {number} scaleFactor - スケール係数（0.1-1.0）
 * @returns {Object} 目標位置 {x, y}
 */
function getMarginalRayTarget(direction, radius, scaleFactor = 0.95) {
    // 適応的にスケール係数を調整して、通過可能な最大位置を見つける
    const targetRadius = radius * scaleFactor;
    
    switch (direction.toLowerCase()) {
        case 'up':
            return { x: 0, y: targetRadius };
        case 'down':
            return { x: 0, y: -targetRadius };
        case 'left':
            return { x: -targetRadius, y: 0 };
        case 'right':
            return { x: targetRadius, y: 0 };
        default:
            console.warn(`⚠️ [MarginalRay] 不明な方向: ${direction}, up方向を使用`);
            return { x: 0, y: targetRadius };
    }
}

/**
 * 適応的絞り周辺光線計算
 * 開口制限で通過できない場合、徐々に内側の位置を試行
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} fieldSetting - フィールド設定
 * @param {string} direction - 方向 ('up', 'down', 'left', 'right')
 * @param {number} wavelength - 波長 (μm)
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object|null} 絞り周辺光線詳細データ
 */
function calculateAdaptiveMarginalRay(opticalSystemRows, fieldSetting, direction, wavelength, debugMode = false) {
    try {
        // 絞り面を特定
        const stopSurfaceIndex = findApertureStopIndex(opticalSystemRows);
        const stopSurface = opticalSystemRows[stopSurfaceIndex];
        
        // 絞り半径を取得（複数のフィールドを試行）
        let stopRadius = parseFloat(stopSurface.aperture || stopSurface.Aperture);
        if (isNaN(stopRadius)) {
            // apertureが無効な場合、semidiaやthicknessを試行
            stopRadius = parseFloat(stopSurface.semidia) || parseFloat(stopSurface.thickness) || 10.0;
        }
        // 直径の場合は半径に変換
        if (stopRadius > 50) {  // 50mm以上なら直径と推定
            stopRadius = stopRadius / 2;
        }

        if (debugMode) {
            console.log(`🎯 [AdaptiveMarginalRay] 適応的絞り周辺光線計算開始:`);
            console.log(`   フィールド: ${fieldSetting.name} (${fieldSetting.x || 0}, ${fieldSetting.y || 0}mm)`);
            console.log(`   方向: ${direction}`);
            console.log(`   絞り面: Surface ${stopSurfaceIndex + 1}, 半径=${stopRadius.toFixed(3)}mm`);
            console.log(`   元データ: aperture="${stopSurface.aperture}", semidia="${stopSurface.semidia}", thickness="${stopSurface.thickness}"`);
        }

        // 改良: まずエッジに近い係数から試行（98%→96%→…→30%）
        const scaleFactors = [
            0.98, 0.96, 0.94, 0.92, 0.90,
            0.88, 0.86, 0.84, 0.82, 0.80,
            0.75, 0.70, 0.65, 0.60, 0.55,
            0.50, 0.45, 0.40, 0.35, 0.30
        ];
        let bestResult = null;
        let bestScaleFactor = 0;
        let bestEdgeError = Infinity; // |r - stopRadius|

        for (const scaleFactor of scaleFactors) {
            if (debugMode) {
                console.log(`🔄 [AdaptiveMarginalRay] スケール係数${(scaleFactor * 100).toFixed(0)}%で試行中...`);
            }

            const targetPosition = getMarginalRayTarget(direction, stopRadius, scaleFactor);
            
            // ニュートン法で収束計算
            const marginalRayResult = calculateMarginalRayNewton(
                opticalSystemRows,
                fieldSetting,
                stopSurfaceIndex,
                targetPosition,
                wavelength,
                debugMode
            );

            if (!marginalRayResult?.convergence?.converged) {
                if (debugMode) {
                    console.log(`   ❌ ニュートン法収束失敗 (${(scaleFactor * 100).toFixed(0)}%)`);
                }
                continue;
            }

            // 完全な光線追跡を試行
            const traceResult = traceMarginalRayComplete(opticalSystemRows, marginalRayResult, wavelength, debugMode);

            if (traceResult.success) {
                const ax = marginalRayResult.stopIntersection.x;
                const ay = marginalRayResult.stopIntersection.y;
                const r = Math.hypot(ax, ay);
                const edgeErr = Math.abs(r - stopRadius);

                if (debugMode) {
                    console.log(`   ✅ 成功! scale=${(scaleFactor * 100).toFixed(0)}%  絞り半径誤差 |r-R|=${edgeErr.toExponential(2)} (r=${r.toFixed(4)}, R=${stopRadius.toFixed(4)})`);
                }

                // よりエッジに近い、もしくはより大きい係数を優先
                const isBetter = (scaleFactor > bestScaleFactor) || (Math.abs(scaleFactor - bestScaleFactor) < 1e-6 && edgeErr < bestEdgeError);
                if (isBetter) {
                    bestResult = {
                        direction: direction,
                        success: true,  // Add success flag for drawing function
                        stopSurfaceIndex: stopSurfaceIndex,
                        stopRadius: stopRadius,
                        actualScaleFactor: scaleFactor,
                        targetPosition: targetPosition,
                        actualStopPosition: marginalRayResult.stopIntersection,
                        initialRay: {
                            pos: marginalRayResult.startP,
                            dir: marginalRayResult.dir
                        },
                        convergence: marginalRayResult.convergence,
                        traceData: traceResult.rayPath,
                        surfacePoints: traceResult.rayPath,  // Add expected surfacePoints for drawing
                        finalPosition: traceResult.finalPosition,
                        exitDirection: traceResult.exitDirection,
                        opticalPathLength: traceResult.opticalPathLength,
                        wavelength: wavelength,
                        fieldSetting: fieldSetting,
                        calculationDate: new Date().toISOString()
                    };
                    bestScaleFactor = scaleFactor;
                    bestEdgeError = edgeErr;
                }
                // 続行してさらに外側の成功解を探す（breakしない）
            } else {
                if (debugMode) {
                    console.log(`   ❌ 光線追跡失敗 (${(scaleFactor * 100).toFixed(0)}%): ${traceResult.error}`);
                    // 最初の試行で詳細表示
                }
            }
        }

        if (bestResult) {
            // 追加の二分探索でエッジまで詰める
            const refine = (base) => {
                const maxIter = 12;
                const tolR = Math.max(1e-4, stopRadius * 1e-4); // 半径の0.01%
                let lo = base.actualScaleFactor;
                let hi = Math.min(1.0, lo + 0.08); // 少しだけ外側も試す
                let best = base;
                let bestErr = Math.abs(Math.hypot(base.actualStopPosition.x, base.actualStopPosition.y) - stopRadius);
                for (let it = 0; it < maxIter; it++) {
                    const mid = (lo + hi) / 2;
                    const target = getMarginalRayTarget(direction, stopRadius, mid);
                    const mr = calculateMarginalRayNewton(
                        opticalSystemRows,
                        fieldSetting,
                        stopSurfaceIndex,
                        target,
                        wavelength,
                        false // 静かに実行
                    );
                    if (!mr?.convergence?.converged) {
                        // 収束しない→外側に寄りすぎ。内側へ
                        hi = mid;
                        continue;
                    }
                    const rNow = Math.hypot(mr.stopIntersection.x, mr.stopIntersection.y);
                    const err = Math.abs(rNow - stopRadius);
                    if (err < bestErr) {
                        // 追跡して最終データも更新
                        const tr = traceMarginalRayComplete(opticalSystemRows, mr, wavelength, false);
                        if (tr.success) {
                            best = {
                                ...base,
                                actualScaleFactor: mid,
                                targetPosition: target,
                                actualStopPosition: mr.stopIntersection,
                                initialRay: { pos: mr.startP, dir: mr.dir },
                                convergence: mr.convergence,
                                traceData: tr.rayPath,
                                surfacePoints: tr.rayPath,
                                finalPosition: tr.finalPosition,
                                exitDirection: tr.exitDirection,
                                opticalPathLength: tr.opticalPathLength
                            };
                            bestErr = err;
                        }
                    }
                    // rNow < R (内側) はさらに外へ。rNow > R は内へ。
                    if (rNow < stopRadius) {
                        lo = mid; // 外側へ
                    } else {
                        hi = mid; // 内側へ
                    }
                    if (bestErr <= tolR) break;
                }
                return { best, bestErr };
            };

            const { best, bestErr } = refine(bestResult);
            bestResult = best;
            bestScaleFactor = best.actualScaleFactor;
            if (debugMode) {
                console.log(`🎉 [AdaptiveMarginalRay] ${direction}方向成功!`);
                console.log(`   最終スケール係数: ${(bestScaleFactor * 100).toFixed(2)}%`);
                console.log(`   エッジ誤差 |r-R|≈ ${bestErr.toExponential(2)} (R=${stopRadius.toFixed(4)})`);
                console.log(`   最終位置: (${bestResult.finalPosition.x.toFixed(4)}, ${bestResult.finalPosition.y.toFixed(4)}, ${bestResult.finalPosition.z.toFixed(4)})`);
            }
            if (debugMode) {
                // no-op
            }
            return bestResult;
        } else {
            if (debugMode) {
                console.log(`❌ [AdaptiveMarginalRay] ${direction}方向: すべてのスケール係数で失敗`);
            }
            return null;
        }

    } catch (error) {
        console.error(`❌ [AdaptiveMarginalRay] ${direction}方向エラー:`, error);
        return null;
    }
}

/**
 * ニュートン法により絞り周辺光線を計算
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} fieldSetting - フィールド設定
 * @param {number} stopSurfaceIndex - 絞り面インデックス
 * @param {Object} targetPosition - 目標位置 {x, y}
 * @param {number} wavelength - 波長 (μm)
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object} ニュートン法結果
 */
function calculateMarginalRayNewton(opticalSystemRows, fieldSetting, stopSurfaceIndex, targetPosition, wavelength, debugMode = false) {
    const maxIterations = 50;
    const tolerance = 1e-8;
    
    // 初期推定値: フィールド位置から絞り中心へのベクトル
    let currentDir = {
        x: -fieldSetting.angleX || 0,
        y: -fieldSetting.angleY || 0,
        z: 1.0
    };

    // 方向ベクトルを正規化
    const dirLength = Math.sqrt(currentDir.x * currentDir.x + currentDir.y * currentDir.y + currentDir.z * currentDir.z);
    currentDir.x /= dirLength;
    currentDir.y /= dirLength;
    currentDir.z /= dirLength;

    let iteration = 0;
    let lastResidual = Infinity;

    for (iteration = 0; iteration < maxIterations; iteration++) {
        // 現在の方向で光線追跡を実行
        const initialRay = {
            pos: { x: fieldSetting.x || 0, y: fieldSetting.y || 0, z: 0 },
            dir: currentDir
        };

        const rayPath = traceRay(opticalSystemRows, initialRay, 1.0, null, stopSurfaceIndex);

        if (!Array.isArray(rayPath) || rayPath.length <= stopSurfaceIndex) {
            if (debugMode) {
                console.log(`⚠️ [MarginalRay Newton] 反復${iteration}: 光線追跡失敗`);
            }
            break;
        }

        // 絞り面での交点を取得
        const stopIntersection: any = rayPath[stopSurfaceIndex] as any;
        const actualPosition = stopIntersection?.pos || stopIntersection;

        // 残差を計算
        const residual = {
            x: actualPosition.x - targetPosition.x,
            y: actualPosition.y - targetPosition.y
        };

        const residualMagnitude = Math.sqrt(residual.x * residual.x + residual.y * residual.y);

        if (debugMode && iteration < 5) {
            console.log(`🔄 [MarginalRay Newton] 反復${iteration}: 残差=${residualMagnitude.toFixed(8)}, 位置=(${actualPosition.x.toFixed(4)}, ${actualPosition.y.toFixed(4)}), 目標=(${targetPosition.x.toFixed(4)}, ${targetPosition.y.toFixed(4)})`);
        }

        // 収束判定
        if (residualMagnitude < tolerance) {
            return {
                startP: initialRay.pos,
                dir: currentDir,
                convergence: {
                    converged: true,
                    iterations: iteration + 1,
                    residual: residualMagnitude
                },
                stopIntersection: actualPosition
            };
        }

        // ヤコビアンの数値近似による方向修正
        const stepSize = 1e-6;
        const jacobian = calculateNumericalJacobian(opticalSystemRows, initialRay, stopSurfaceIndex, stepSize);
        
        if (!jacobian) {
            if (debugMode) {
                console.log(`⚠️ [MarginalRay Newton] 反復${iteration}: ヤコビアン計算失敗（光線がブロック）`);
            }
            break;
        }
        
        if (jacobian.det !== 0) {
            // ニュートン法による更新
            const deltaDir = solveLinearSystem(jacobian, residual);
            currentDir.x -= deltaDir.x * 0.5; // 減衰係数0.5で安定化
            currentDir.y -= deltaDir.y * 0.5;
            
            // 方向ベクトルを正規化
            const newDirLength = Math.sqrt(currentDir.x * currentDir.x + currentDir.y * currentDir.y + currentDir.z * currentDir.z);
            currentDir.x /= newDirLength;
            currentDir.y /= newDirLength;
            currentDir.z /= newDirLength;
        } else {
            if (debugMode) {
                console.log(`⚠️ [MarginalRay Newton] 反復${iteration}: ヤコビアン特異`);
            }
            break;
        }

        lastResidual = residualMagnitude;
    }

    return {
        startP: { x: fieldSetting.x || 0, y: fieldSetting.y || 0, z: 0 },
        dir: currentDir,
        convergence: {
            converged: false,
            iterations: iteration,
            residual: lastResidual
        }
    };
}

/**
 * 数値ヤコビアンを計算
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} ray - 初期光線
 * @param {number} stopSurfaceIndex - 絞り面インデックス
 * @param {number} stepSize - ステップサイズ
 * @returns {Object} ヤコビアン行列
 */
function calculateNumericalJacobian(opticalSystemRows, ray, stopSurfaceIndex, stepSize) {
    // ベースライン位置
    const basePath = traceRay(opticalSystemRows, ray, 1.0, null, stopSurfaceIndex);
    if (!Array.isArray(basePath) || basePath.length <= stopSurfaceIndex) {
        console.warn(`⚠️ [MarginalRay] ベースライン光線追跡失敗`);
        return null;
    }
    const baseHit: any = basePath[stopSurfaceIndex] as any;
    const basePos = baseHit?.pos || baseHit;

    // x方向の偏微分
    const rayDx = {
        pos: ray.pos,
        dir: { x: ray.dir.x + stepSize, y: ray.dir.y, z: ray.dir.z }
    };
    const pathDx = traceRay(opticalSystemRows, rayDx, 1.0, null, stopSurfaceIndex);
    if (!Array.isArray(pathDx) || pathDx.length <= stopSurfaceIndex) {
        console.warn(`⚠️ [MarginalRay] X方向偏微分光線追跡失敗`);
        return null;
    }
    const hitDx: any = pathDx[stopSurfaceIndex] as any;
    const posDx = hitDx?.pos || hitDx;

    // y方向の偏微分
    const rayDy = {
        pos: ray.pos,
        dir: { x: ray.dir.x, y: ray.dir.y + stepSize, z: ray.dir.z }
    };
    const pathDy = traceRay(opticalSystemRows, rayDy, 1.0, null, stopSurfaceIndex);
    if (!Array.isArray(pathDy) || pathDy.length <= stopSurfaceIndex) {
        console.warn(`⚠️ [MarginalRay] Y方向偏微分光線追跡失敗`);
        return null;
    }
    const hitDy: any = pathDy[stopSurfaceIndex] as any;
    const posDy = hitDy?.pos || hitDy;

    // ヤコビアン行列を計算
    const J11 = (posDx.x - basePos.x) / stepSize;
    const J12 = (posDy.x - basePos.x) / stepSize;
    const J21 = (posDx.y - basePos.y) / stepSize;
    const J22 = (posDy.y - basePos.y) / stepSize;

    const det = J11 * J22 - J12 * J21;

    return {
        J11, J12, J21, J22,
        det: det
    };
}

/**
 * 線形システムを解く (2x2)
 * @param {Object} jacobian - ヤコビアン行列
 * @param {Object} residual - 残差ベクトル
 * @returns {Object} 解ベクトル
 */
function solveLinearSystem(jacobian, residual) {
    const { J11, J12, J21, J22, det } = jacobian;
    
    if (Math.abs(det) < 1e-15) {
        return { x: 0, y: 0 };
    }

    const invDet = 1.0 / det;
    return {
        x: invDet * (J22 * residual.x - J12 * residual.y),
        y: invDet * (-J21 * residual.x + J11 * residual.y)
    };
}

/**
 * 絞り周辺光線の完全な光線追跡を実行
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} marginalRayResult - ニュートン法結果
 * @param {number} wavelength - 波長 (μm)
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object} 光線追跡結果
 */
function traceMarginalRayComplete(opticalSystemRows, marginalRayResult, wavelength, debugMode = false) {
    try {
        const opticalRowsCopy = JSON.parse(JSON.stringify(opticalSystemRows));
        const debugLog = debugMode ? [] : null;
        const initialRay = {
            pos: marginalRayResult.startP,
            dir: marginalRayResult.dir
        };
        
        if (debugMode) {
            console.log(`🔍 [TraceMarginalRay] 完全光線追跡開始:`);
            console.log(`   初期位置: (${initialRay.pos.x.toFixed(4)}, ${initialRay.pos.y.toFixed(4)}, ${initialRay.pos.z.toFixed(4)})`);
            console.log(`   初期方向: (${initialRay.dir.x.toFixed(6)}, ${initialRay.dir.y.toFixed(6)}, ${initialRay.dir.z.toFixed(6)})`);
        }
        
        const rayPath = traceRay(opticalRowsCopy, initialRay, 1.0, debugLog);

        if (!Array.isArray(rayPath) || rayPath.length === 0) {
            const errorDetails = debugLog ? debugLog.join('\n') : '詳細ログなし';
            if (debugMode) {
                console.log(`❌ [TraceMarginalRay] 光線追跡失敗 - デバッグログ:`);
                console.log(errorDetails);
            }
            return { 
                success: false, 
                error: 'Ray path is null or empty',
                debugInfo: errorDetails
            };
        }

        // 最終点（像面）のデータを取得
        const finalPoint = rayPath[rayPath.length - 1];
        const finalPos = finalPoint?.pos || finalPoint;
        
        if (!finalPos || typeof finalPos.x !== 'number') {
            return { success: false, error: 'Invalid final position' };
        }

        // 射出方向を計算
        let exitDirection = marginalRayResult.dir;
        if (rayPath.length > 1) {
            const secondLast = rayPath[rayPath.length - 2];
            const lastPoint = rayPath[rayPath.length - 1];
            const secondLastPos = secondLast?.pos || secondLast;
            
            if (secondLastPos) {
                exitDirection = {
                    x: finalPos.x - secondLastPos.x,
                    y: finalPos.y - secondLastPos.y,
                    z: finalPos.z - secondLastPos.z
                };
                const length = Math.sqrt(exitDirection.x * exitDirection.x + exitDirection.y * exitDirection.y + exitDirection.z * exitDirection.z);
                if (length > 0) {
                    exitDirection.x /= length;
                    exitDirection.y /= length;
                    exitDirection.z /= length;
                }
            }
        }

        // 光路長を計算
        let opticalPathLength = 0;
        for (let i = 1; i < rayPath.length; i++) {
            const prevPos = rayPath[i - 1]?.pos || rayPath[i - 1];
            const currPos = rayPath[i]?.pos || rayPath[i];
            
            if (prevPos && currPos) {
                const distance = Math.sqrt(
                    (currPos.x - prevPos.x) ** 2 +
                    (currPos.y - prevPos.y) ** 2 +
                    (currPos.z - prevPos.z) ** 2
                );
                opticalPathLength += distance;
            }
        }

        return {
            success: true,
            rayPath: rayPath,
            finalPosition: finalPos,
            exitDirection: exitDirection,
            opticalPathLength: opticalPathLength
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Export the main function that wasn't exported before
export { calculateAdaptiveMarginalRay };
