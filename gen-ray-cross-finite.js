/**
 * Cross Beam Generation for Finite Object System
 * 有限系でクロスビームの生成
 * 
 * 仕様に基づいた実装:
 * 1. Object位置（Rectangle）から発散する等間隔のクロス光束
 * 2. 主光線の算出（Object → Stop面中心）をBrent法で探索
 * 3. 絞り周辺光線の算出（Object → 絞り周辺各点）をBrent法で探索
 * 4. クロスビームの等分割と対称配置
 * 5. 射出z位置は0で固定、方向ベクトルを変化
 * 
 * 作成日: 2025/07/23 (Brent法対応)
 */

import { traceRay, calculateSurfaceOrigins, asphericSag } from './ray-tracing.js';

function isCoordBreakRow(row) {
    const st = String(row?.surfType ?? row?.['surf type'] ?? '').toLowerCase();
    return st === 'coord break' || st === 'coordinate break' || st === 'cb';
}

function isObjectRow(row) {
    const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();
    return t === 'object';
}

function isStopRow(row) {
    const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? row?.Type ?? '';
    const t = String(raw ?? '').trim().toLowerCase();
    return t === 'stop' || t === 'sto';
}

// traceRay の rayPath は Object 行 / Coord Break 行を交点として記録しない。
// surfaceIndex(テーブル行) -> rayPath の point index への変換を行う。
function getRayPathPointIndexForSurfaceIndex(opticalSystemRows, surfaceIndex) {
    if (!Array.isArray(opticalSystemRows) || surfaceIndex === null || surfaceIndex === undefined) return null;
    const sIdx = Math.max(0, Math.min(surfaceIndex, opticalSystemRows.length - 1));
    let count = 0;
    for (let i = 0; i <= sIdx; i++) {
        const row = opticalSystemRows[i];
        if (isCoordBreakRow(row)) continue;
        if (isObjectRow(row)) continue;
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

/**
 * Local implementation of findStopSurface to avoid Three.js dependency
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Array} surfaceOrigins - 面原点データ（オプション）
 * @returns {Object|null} 絞り面情報
 */
function findStopSurface(opticalSystemRows, surfaceOrigins = null) {
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        return null;
    }
    
    console.log(`🔍 [findStopSurface] ${opticalSystemRows.length}面から絞りを検索`);
    
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];

        if (isStopRow(surface) || (String(surface?.comment ?? surface?.Comment ?? '').toLowerCase().includes('stop'))) {
            console.log(`✅ [findStopSurface] Surface ${i}: object="${surface.object ?? surface['object type'] ?? surface.type}", semidia="${surface.semidia}"`);

            const o = (surfaceOrigins && surfaceOrigins[i]) ? surfaceOrigins[i] : null;
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

// 色分けシステム
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
        chief: 0xff0000,        // 主光線 - Red
        upper_marginal: 0x00ff00, // 上マージナル光線 - Green
        lower_marginal: 0x0000ff, // 下マージナル光線 - Blue
        left_marginal: 0xffff00,  // 左マージナル光線 - Yellow
        right_marginal: 0xff00ff, // 右マージナル光線 - Magenta
        aperture_up: 0x00ffff,    // 絞り上端 - Cyan
        aperture_down: 0xffa500,  // 絞り下端 - Orange
        aperture_left: 0x800080,  // 絞り左端 - Purple
        aperture_right: 0xffc0cb  // 絞り右端 - Pink
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
 * Brent法による根探索アルゴリズム（無限系から移植）
 * ニュートン法より安定で、二分法より高速
 * @param {Function} f - 目的関数
 * @param {number} a - 探索区間の左端
 * @param {number} b - 探索区間の右端
 * @param {number} tol - 許容誤差
 * @param {number} maxIter - 最大反復回数
 * @returns {number} 根の近似値
 */
function brent(f, a, b, tol = 1e-6, maxIter = 100) {
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
 * 有限系での主光線方向ベクトル探索（Brent法）
 * Object位置（固定）からStop面中心を通る光線の方向ベクトルを探索
 * @param {Object} objectPosition - Object位置 {x, y, z}
 * @param {Object} stopCenter - Stop面中心位置
 * @param {number} stopSurfaceIndex - Stop面のインデックス
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {boolean} debugMode - デバッグモード
 * @param {number} wavelength - 波長（デフォルト0.5876μm）
 * @returns {Object} 主光線の方向ベクトル
 */
export function findFiniteSystemChiefRayDirection(objectPosition, stopCenter, stopSurfaceIndex, opticalSystemRows, debugMode = false, wavelength = 0.5876) {
    if (debugMode) {
        console.log(`🔍 [FiniteSystem] 主光線方向ベクトル探索開始（Brent法）`);
        console.log(`   Object位置: (${objectPosition.x.toFixed(3)}, ${objectPosition.y.toFixed(3)}, ${objectPosition.z.toFixed(3)})`);
        console.log(`   Stop面中心: (${stopCenter.x.toFixed(3)}, ${stopCenter.y.toFixed(3)}, ${stopCenter.z.toFixed(3)})`);
    }
    
    try {
        // 初期推定値（幾何学的計算）
        const deltaX = stopCenter.x - objectPosition.x;
        const deltaY = stopCenter.y - objectPosition.y;
        const deltaZ = stopCenter.z - objectPosition.z;
        const norm = Math.sqrt(deltaX*deltaX + deltaY*deltaY + deltaZ*deltaZ);
        
        const initialDirection = {
            i: deltaX / norm,
            j: deltaY / norm,
            k: deltaZ / norm
        };
        
        if (debugMode) {
            console.log(`   初期方向ベクトル: (${initialDirection.i.toFixed(6)}, ${initialDirection.j.toFixed(6)}, ${initialDirection.k.toFixed(6)})`);
        }

        // X方向成分の目的関数
        const objectiveFunctionDirX = (dirX) => {
            // 残りの成分を計算（単位ベクトル条件を維持）
            const dirY = optimalDirY; // 最新のY成分を使用
            const dirZ_squared = 1 - dirX*dirX - dirY*dirY;
            
            if (dirZ_squared <= 0) {
                return 1000; // 無効な方向ベクトル
            }
            
            const dirZ = Math.sqrt(dirZ_squared) * Math.sign(initialDirection.k);
            
            const ray = {
                wavelength: wavelength,
                pos: { x: objectPosition.x, y: objectPosition.y, z: objectPosition.z },
                dir: { x: dirX, y: dirY, z: dirZ },
                wavelength: wavelength
            };
            
            try {
                const rayPath = traceRay(opticalSystemRows, ray, 1.0, null, stopSurfaceIndex);
                if (rayPath && rayPath.length > stopSurfaceIndex) {
                    const actualStopPoint = getRayPointAtSurfaceIndex(rayPath, opticalSystemRows, stopSurfaceIndex);
                    return actualStopPoint.x - stopCenter.x;
                } else {
                    return 1000;
                }
            } catch (error) {
                return 1000;
            }
        };
        
        // Y方向成分の目的関数
        const objectiveFunctionDirY = (dirY) => {
            const dirX = optimalDirX; // 最新のX成分を使用
            const dirZ_squared = 1 - dirX*dirX - dirY*dirY;
            
            if (dirZ_squared <= 0) {
                return 1000;
            }
            
            const dirZ = Math.sqrt(dirZ_squared) * Math.sign(initialDirection.k);
            
            const ray = {
                wavelength: wavelength,
                pos: { x: objectPosition.x, y: objectPosition.y, z: objectPosition.z },
                dir: { x: dirX, y: dirY, z: dirZ }
            };
            
            try {
                const rayPath = traceRay(opticalSystemRows, ray, 1.0, null, stopSurfaceIndex);
                if (rayPath && rayPath.length > stopSurfaceIndex) {
                    const actualStopPoint = getRayPointAtSurfaceIndex(rayPath, opticalSystemRows, stopSurfaceIndex);
                    return actualStopPoint.y - stopCenter.y;
                } else {
                    return 1000;
                }
            } catch (error) {
                return 1000;
            }
        };
        
        // 探索範囲（方向ベクトル成分の範囲）
        const searchRange = 0.95; // ±0.95（主光線でもより広い範囲）
        let optimalDirX = initialDirection.i;
        let optimalDirY = initialDirection.j;
        
        // 交互最適化（X→Y→X→Y）
        const maxIterations = 3;
        for (let iter = 0; iter < maxIterations; iter++) {
            // X方向成分の最適化（無限系スタイルの広範囲探索）
            try {
                // 初期推定の大きさに応じた適応的探索範囲
                const adaptiveRangeX = Math.max(0.1, Math.abs(optimalDirX) * 2);
                let aX = Math.max(-searchRange, optimalDirX - adaptiveRangeX);
                let bX = Math.min(searchRange, optimalDirX + adaptiveRangeX);
                let faX = objectiveFunctionDirX(aX);
                let fbX = objectiveFunctionDirX(bX);
                
                if (debugMode) {
                    console.log(`🔍 [Brent-X] 反復${iter + 1}: 適応範囲±${adaptiveRangeX.toFixed(3)}, 初期区間[${aX.toFixed(6)}, ${bX.toFixed(6)}], f(a)=${faX.toFixed(6)}, f(b)=${fbX.toFixed(6)}`);
                }
                
                if (faX * fbX >= 0) {
                    // 符号変化区間を広範囲で探索（無限系のアプローチ）
                    let found = false;
                    for (let i = 1; i <= 50 && !found; i++) {
                        const range = Math.max(0.05 * i, adaptiveRangeX * (1 + i * 0.5));
                        aX = Math.max(-searchRange, optimalDirX - range);
                        bX = Math.min(searchRange, optimalDirX + range);
                        faX = objectiveFunctionDirX(aX);
                        fbX = objectiveFunctionDirX(bX);
                        if (faX * fbX < 0) {
                            found = true;
                            if (debugMode) {
                                console.log(`   ✅ X方向: 符号変化区間発見 (試行${i}回目, 範囲±${range.toFixed(3)}): [${aX.toFixed(6)}, ${bX.toFixed(6)}]`);
                            }
                        }
                    }
                    
                    if (found) {
                        optimalDirX = brent(objectiveFunctionDirX, aX, bX, 0.0001, 500);
                        if (debugMode) {
                            console.log(`   ✅ X方向最適化完了: ${optimalDirX.toFixed(6)}`);
                        }
                    } else {
                        // 符号変化が見つからない場合、勾配ベース探索（無限系スタイル）
                        if (debugMode) {
                            try {
                                const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
                                if (RAYTRACE_DEBUG) {
                                    console.warn(`   ⚠️ X方向: 符号変化区間が見つからない → 勾配探索へ切替`);
                                }
                            } catch (_) {}
                        }
                        const step = 0.001;
                        const f0 = objectiveFunctionDirX(optimalDirX);
                        const fp = objectiveFunctionDirX(optimalDirX + step);
                        const gradient = (fp - f0) / step;
                        if (Math.abs(gradient) > 1e-10) {
                            const newDirX = optimalDirX - f0 / gradient;
                            if (newDirX >= -searchRange && newDirX <= searchRange) {
                                optimalDirX = newDirX;
                                if (debugMode) {
                                    console.log(`   📐 勾配法: ${optimalDirX.toFixed(6)}, 誤差改善: ${f0.toFixed(6)} → ${objectiveFunctionDirX(optimalDirX).toFixed(6)}`);
                                }
                            }
                        }
                    }
                } else {
                    optimalDirX = brent(objectiveFunctionDirX, aX, bX, 0.0001, 500);
                    if (debugMode) {
                        console.log(`   ✅ X方向最適化完了: ${optimalDirX.toFixed(6)}`);
                    }
                }
            } catch (error) {
                if (debugMode) {
                    console.error(`   ❌ X方向最適化エラー: ${error.message}`);
                }
            }
            
            // Y方向成分の最適化（無限系スタイルの広範囲探索）
            try {
                // 初期推定の大きさに応じた適応的探索範囲
                const adaptiveRangeY = Math.max(0.1, Math.abs(optimalDirY) * 2);
                let aY = Math.max(-searchRange, optimalDirY - adaptiveRangeY);
                let bY = Math.min(searchRange, optimalDirY + adaptiveRangeY);
                let faY = objectiveFunctionDirY(aY);
                let fbY = objectiveFunctionDirY(bY);
                
                if (debugMode) {
                    console.log(`🔍 [Brent-Y] 反復${iter + 1}: 適応範囲±${adaptiveRangeY.toFixed(3)}, 初期区間[${aY.toFixed(6)}, ${bY.toFixed(6)}], f(a)=${faY.toFixed(6)}, f(b)=${fbY.toFixed(6)}`);
                }
                
                if (faY * fbY >= 0) {
                    // 符号変化区間を広範囲で探索（無限系のアプローチ）
                    let found = false;
                    for (let i = 1; i <= 50 && !found; i++) {
                        const range = Math.max(0.05 * i, adaptiveRangeY * (1 + i * 0.5));
                        aY = Math.max(-searchRange, optimalDirY - range);
                        bY = Math.min(searchRange, optimalDirY + range);
                        faY = objectiveFunctionDirY(aY);
                        fbY = objectiveFunctionDirY(bY);
                        if (faY * fbY < 0) {
                            found = true;
                            if (debugMode) {
                                console.log(`   ✅ Y方向: 符号変化区間発見 (試行${i}回目, 範囲±${range.toFixed(3)}): [${aY.toFixed(6)}, ${bY.toFixed(6)}]`);
                            }
                        }
                    }
                    
                    if (found) {
                        optimalDirY = brent(objectiveFunctionDirY, aY, bY, 0.0001, 500);
                        if (debugMode) {
                            console.log(`   ✅ Y方向最適化完了: ${optimalDirY.toFixed(6)}`);
                        }
                    } else {
                        // 符号変化が見つからない場合、勾配ベース探索（無限系スタイル）
                        if (debugMode) {
                            try {
                                const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
                                if (RAYTRACE_DEBUG) {
                                    console.warn(`   ⚠️ Y方向: 符号変化区間が見つからない → 勾配探索へ切替`);
                                }
                            } catch (_) {}
                        }
                        const step = 0.001;
                        const f0 = objectiveFunctionDirY(optimalDirY);
                        const fp = objectiveFunctionDirY(optimalDirY + step);
                        const gradient = (fp - f0) / step;
                        if (Math.abs(gradient) > 1e-10) {
                            const newDirY = optimalDirY - f0 / gradient;
                            if (newDirY >= -searchRange && newDirY <= searchRange) {
                                optimalDirY = newDirY;
                                if (debugMode) {
                                    console.log(`   📐 勾配法: ${optimalDirY.toFixed(6)}, 誤差改善: ${f0.toFixed(6)} → ${objectiveFunctionDirY(optimalDirY).toFixed(6)}`);
                                }
                            }
                        }
                    }
                } else {
                    optimalDirY = brent(objectiveFunctionDirY, aY, bY, 0.0001, 500);
                    if (debugMode) {
                        console.log(`   ✅ Y方向最適化完了: ${optimalDirY.toFixed(6)}`);
                    }
                }
            } catch (error) {
                if (debugMode) {
                    console.error(`   ❌ Y方向最適化エラー: ${error.message}`);
                }
            }
        }
        
        if (debugMode) {
            console.log(`✅ [Brent] 交互最適化完了: X=${optimalDirX.toFixed(6)}, Y=${optimalDirY.toFixed(6)}`);
        }
        
        // Z成分を計算（単位ベクトル条件）
        const dirZ_squared = 1 - optimalDirX*optimalDirX - optimalDirY*optimalDirY;
        const optimalDirZ = dirZ_squared > 0 ? Math.sqrt(dirZ_squared) * Math.sign(initialDirection.k) : initialDirection.k;
        
        // 単位ベクトルとして正規化
        const magnitude = Math.sqrt(optimalDirX*optimalDirX + optimalDirY*optimalDirY + optimalDirZ*optimalDirZ);
        
        if (magnitude < 1e-10) {
            // 無効なベクトルの場合、フォールバックを使用
            if (debugMode) {
                console.warn(`⚠️ [Brent] 無効な方向ベクトル(大きさ=${magnitude}), フォールバック使用`);
            }
            return {
                i: initialDirection.i,
                j: initialDirection.j,
                k: initialDirection.k
            };
        }
        
        const result = {
            i: optimalDirX / magnitude,
            j: optimalDirY / magnitude,
            k: optimalDirZ / magnitude
        };
        
        // Z成分が負の場合（後方への光線）をチェック
        if (result.k <= 0) {
            if (debugMode) {
                console.warn(`⚠️ [Brent] 後方光線検出(k=${result.k.toFixed(6)}), フォールバック使用`);
            }
            return {
                i: initialDirection.i,
                j: initialDirection.j,
                k: Math.abs(initialDirection.k) // 前方に強制
            };
        }
        
        if (debugMode) {
            console.log(`🔍 [Brent] 正規化前: (${optimalDirX.toFixed(6)}, ${optimalDirY.toFixed(6)}, ${optimalDirZ.toFixed(6)}), 大きさ=${magnitude.toFixed(6)}`);
            console.log(`🔍 [Brent] 正規化後: (${result.i.toFixed(6)}, ${result.j.toFixed(6)}, ${result.k.toFixed(6)})`);
        }
        
        // 結果を検証
        const verificationRay = {
            pos: objectPosition,
            dir: { x: result.i, y: result.j, z: result.k },
            wavelength: wavelength
        };
        
        const verificationPath = traceRay(opticalSystemRows, verificationRay, 1.0);
        if (verificationPath && verificationPath.length > stopSurfaceIndex) {
            const actualPoint = getRayPointAtSurfaceIndex(verificationPath, opticalSystemRows, stopSurfaceIndex);
            const errorX = actualPoint.x - stopCenter.x;
            const errorY = actualPoint.y - stopCenter.y;
            const totalError = Math.sqrt(errorX*errorX + errorY*errorY);
            
            if (debugMode) {
                console.log(`📊 [Brent] 結果検証:`);
                console.log(`   最適方向ベクトル: (${result.i.toFixed(6)}, ${result.j.toFixed(6)}, ${result.k.toFixed(6)})`);
                console.log(`   Stop面実際位置: (${actualPoint.x.toFixed(3)}, ${actualPoint.y.toFixed(3)})`);
                console.log(`   Stop面目標位置: (${stopCenter.x.toFixed(3)}, ${stopCenter.y.toFixed(3)})`);
                console.log(`   誤差: X=${errorX.toFixed(6)}mm, Y=${errorY.toFixed(6)}mm, 総合=${totalError.toFixed(6)}mm`);
            }
        } else {
            // 主光線がStop面に到達しない場合 → グリッドサーチでフォールバック
            if (debugMode) {
                console.warn(`⚠️ [Brent] 主光線がStop面に到達せず（パス長${verificationPath ? verificationPath.length : 0}） → グリッドサーチへ切替`);
            }
            
            // グリッドサーチ: Y方向を中心に広範囲探索
            let bestDir = null;
            let bestError = Infinity;
            let bestPathLength = 0;
            
            const yStart = -0.20;
            const yEnd = 0.10;
            const yStep = 0.0025;  // 0.005 → 0.0025 (2倍精度)
            const xStart = -0.10;
            const xEnd = 0.10;
            const xStep = 0.005;   // 0.01 → 0.005 (2倍精度)
            
            for (let yDir = yStart; yDir <= yEnd; yDir += yStep) {
                for (let xDir = xStart; xDir <= xEnd; xDir += xStep) {
                    const zDir = Math.sqrt(Math.max(0, 1 - xDir*xDir - yDir*yDir));
                    if (zDir < 0.9) continue; // 現実的な範囲のみ
                    
                    const testRay = {
                        pos: objectPosition,
                        dir: { x: xDir, y: yDir, z: zDir },
                        wavelength: wavelength
                    };
                    
                    const testPath = traceRay(opticalSystemRows, testRay, 1.0);
                    if (testPath && testPath.length > stopSurfaceIndex) {
                        const testPoint = getRayPointAtSurfaceIndex(testPath, opticalSystemRows, stopSurfaceIndex);
                        const testErrorX = testPoint.x - stopCenter.x;
                        const testErrorY = testPoint.y - stopCenter.y;
                        const testError = Math.sqrt(testErrorX*testErrorX + testErrorY*testErrorY);
                        
                        if (testPath.length > bestPathLength || (testPath.length === bestPathLength && testError < bestError)) {
                            bestPathLength = testPath.length;
                            bestError = testError;
                            bestDir = { i: xDir, j: yDir, k: zDir };
                        }
                    }
                }
            }
            
            if (bestDir && bestPathLength > stopSurfaceIndex) {
                if (debugMode) {
                    console.log(`✅ [Grid] グリッドサーチ成功: 方向(${bestDir.i.toFixed(6)}, ${bestDir.j.toFixed(6)}, ${bestDir.k.toFixed(6)}), 誤差${bestError.toFixed(3)}mm`);
                }
                
                // グリッドサーチ結果をそのまま使用（十分な精度のため）
                // Brent法微調整はreadonly propertyエラーを回避するためスキップ
                return bestDir
            } else {
                if (debugMode) {
                    console.error(`❌ [Grid] グリッドサーチでも解が見つかりませんでした`);
                }
            }
        }
        
        return result;
        
    } catch (error) {
        if (debugMode) {
            console.error(`❌ [Brent] 主光線方向ベクトル探索エラー: ${error.message}`);
        }
        
        // フォールバック: 幾何学的計算
        const deltaX = stopCenter.x - objectPosition.x;
        const deltaY = stopCenter.y - objectPosition.y;
        const deltaZ = stopCenter.z - objectPosition.z;
        const norm = Math.sqrt(deltaX*deltaX + deltaY*deltaY + deltaZ*deltaZ);
        
        return {
            i: deltaX / norm,
            j: deltaY / norm,
            k: deltaZ / norm
        };
    }
}

/**
 * 有限系での絞り周辺光線方向ベクトル探索（Brent法）
 * Object位置（固定）から絞り周辺の指定点を通る光線の方向ベクトルを探索
 * @param {Object} objectPosition - Object位置 {x, y, z}
 * @param {Object} targetPoint - 絞り面上の目標点
 * @param {number} stopSurfaceIndex - Stop面のインデックス
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {boolean} debugMode - デバッグモード
 * @returns {Object} 周辺光線の方向ベクトル
 */
function findFiniteSystemMarginalRayDirection(objectPosition, targetPoint, stopSurfaceIndex, opticalSystemRows, debugMode, wavelength = 0.5876) {
    try {
        // 初期推定値（幾何学的計算）
        const deltaX = targetPoint.x - objectPosition.x;
        const deltaY = targetPoint.y - objectPosition.y;
        const deltaZ = targetPoint.z - objectPosition.z;
        const norm = Math.sqrt(deltaX*deltaX + deltaY*deltaY + deltaZ*deltaZ);
        
        if (norm < 1e-10) {
            if (debugMode) {
                console.warn(`⚠️ [Marginal] 距離が0に近すぎます: ${norm}`);
            }
            return { i: 0, j: 0, k: 1 }; // デフォルト方向
        }
        
        const initialDirection = {
            i: deltaX / norm,
            j: deltaY / norm,
            k: deltaZ / norm
        };
        
        if (debugMode) {
            console.log(`🔍 [Marginal] 初期方向ベクトル: (${initialDirection.i.toFixed(6)}, ${initialDirection.j.toFixed(6)}, ${initialDirection.k.toFixed(6)})`);
            console.log(`🎯 [Marginal] 目標点: (${targetPoint.x.toFixed(3)}, ${targetPoint.y.toFixed(3)}, ${targetPoint.z.toFixed(3)})`);
        }

        // X方向成分の目的関数
        const objectiveFunctionDirX = (dirX) => {
            const dirY = initialDirection.j; // Y成分は固定
            const dirZ_squared = 1 - dirX*dirX - dirY*dirY;
            
            if (dirZ_squared <= 0) {
                return 1000; // 無効な方向ベクトル
            }
            
            const dirZ = Math.sqrt(dirZ_squared) * Math.sign(initialDirection.k);
            
            const ray = {
                wavelength: wavelength,
                pos: { x: objectPosition.x, y: objectPosition.y, z: objectPosition.z },
                dir: { x: dirX, y: dirY, z: dirZ }
            };
            
            try {
                const rayPath = traceRay(opticalSystemRows, ray, 1.0);
                if (rayPath && rayPath.length > stopSurfaceIndex) {
                    const actualStopPoint = getRayPointAtSurfaceIndex(rayPath, opticalSystemRows, stopSurfaceIndex);
                    return actualStopPoint.x - targetPoint.x;
                } else {
                    return 1000;
                }
            } catch (error) {
                return 1000;
            }
        };
        
        // Y方向成分の目的関数
        const objectiveFunctionDirY = (dirY) => {
            const dirX = initialDirection.i; // X成分は固定
            const dirZ_squared = 1 - dirX*dirX - dirY*dirY;
            
            if (dirZ_squared <= 0) {
                return 1000;
            }
            
            const dirZ = Math.sqrt(dirZ_squared) * Math.sign(initialDirection.k);
            
            const ray = {
                wavelength: wavelength,
                pos: { x: objectPosition.x, y: objectPosition.y, z: objectPosition.z },
                dir: { x: dirX, y: dirY, z: dirZ }
            };
            
            try {
                const rayPath = traceRay(opticalSystemRows, ray, 1.0);
                if (rayPath && rayPath.length > stopSurfaceIndex) {
                    const actualStopPoint = getRayPointAtSurfaceIndex(rayPath, opticalSystemRows, stopSurfaceIndex);
                    return actualStopPoint.y - targetPoint.y;
                } else {
                    return 1000;
                }
            } catch (error) {
                return 1000;
            }
        };

        // 探索範囲（方向ベクトル成分の範囲）
        const searchRange = 0.95; // ±0.95（より広い範囲）
        let optimalDirX = initialDirection.i;
        let optimalDirY = initialDirection.j;
        
        // X方向成分の最適化
        try {
            let aX = Math.max(-searchRange, initialDirection.i - 0.9);
            let bX = Math.min(searchRange, initialDirection.i + 0.9);
            let faX = objectiveFunctionDirX(aX);
            let fbX = objectiveFunctionDirX(bX);
            
            if (faX * fbX >= 0) {
                // 符号変化区間を探す
                let found = false;
                for (let i = 1; i <= 30 && !found; i++) {
                    const range = 0.03 * i; // より細かい刻み
                    aX = Math.max(-searchRange, initialDirection.i - range);
                    bX = Math.min(searchRange, initialDirection.i + range);
                    faX = objectiveFunctionDirX(aX);
                    fbX = objectiveFunctionDirX(bX);
                    if (faX * fbX < 0) {
                        found = true;
                    }
                }
                
                if (found) {
                    optimalDirX = brent(objectiveFunctionDirX, aX, bX, 0.0001, 500);
                }
            } else {
                optimalDirX = brent(objectiveFunctionDirX, aX, bX, 0.0001, 500);
            }
            
            if (debugMode) {
                console.log(`✅ [Marginal-Brent] X方向成分最適化完了: ${optimalDirX.toFixed(6)}`);
            }
        } catch (error) {
            if (debugMode) {
                console.warn(`⚠️ [Marginal-Brent] X方向最適化失敗: ${error.message}, 初期値使用`);
            }
        }
        
        // Y方向成分の最適化
        try {
            let aY = Math.max(-searchRange, initialDirection.j - 0.9);
            let bY = Math.min(searchRange, initialDirection.j + 0.9);
            let faY = objectiveFunctionDirY(aY);
            let fbY = objectiveFunctionDirY(bY);
            
            if (faY * fbY >= 0) {
                let found = false;
                for (let i = 1; i <= 30 && !found; i++) {
                    const range = 0.03 * i; // より細かい刻み
                    aY = Math.max(-searchRange, initialDirection.j - range);
                    bY = Math.min(searchRange, initialDirection.j + range);
                    faY = objectiveFunctionDirY(aY);
                    fbY = objectiveFunctionDirY(bY);
                    if (faY * fbY < 0) {
                        found = true;
                    }
                }
                
                if (found) {
                    optimalDirY = brent(objectiveFunctionDirY, aY, bY, 0.0001, 500);
                }
            } else {
                optimalDirY = brent(objectiveFunctionDirY, aY, bY, 0.0001, 500);
            }
            
            if (debugMode) {
                console.log(`✅ [Marginal-Brent] Y方向成分最適化完了: ${optimalDirY.toFixed(6)}`);
            }
        } catch (error) {
            if (debugMode) {
                console.warn(`⚠️ [Marginal-Brent] Y方向最適化失敗: ${error.message}, 初期値使用`);
            }
        }

        // Z成分を計算（単位ベクトル条件）
        const dirZ_squared = 1 - optimalDirX*optimalDirX - optimalDirY*optimalDirY;
        const optimalDirZ = dirZ_squared > 0 ? Math.sqrt(dirZ_squared) * Math.sign(initialDirection.k) : initialDirection.k;
        
        // 単位ベクトルとして正規化
        const magnitude = Math.sqrt(optimalDirX*optimalDirX + optimalDirY*optimalDirY + optimalDirZ*optimalDirZ);
        
        if (magnitude < 1e-10) {
            if (debugMode) {
                console.warn(`⚠️ [Marginal-Brent] 無効な方向ベクトル(大きさ=${magnitude}), 初期値使用`);
            }
            return initialDirection;
        }
        
        const result = {
            i: optimalDirX / magnitude,
            j: optimalDirY / magnitude,
            k: optimalDirZ / magnitude
        };
        
        // Z成分が負の場合をチェック
        if (result.k <= 0) {
            if (debugMode) {
                console.warn(`⚠️ [Marginal-Brent] 後方光線検出(k=${result.k.toFixed(6)}), 初期値使用`);
            }
            return initialDirection;
        }
        
        // 結果を検証
        const verificationRay = {
            pos: objectPosition,
            dir: { x: result.i, y: result.j, z: result.k }
        };
        
        try {
            const verificationPath = traceRay(opticalSystemRows, verificationRay, 1.0);
            if (verificationPath && verificationPath.length > stopSurfaceIndex) {
                const actualPoint = getRayPointAtSurfaceIndex(verificationPath, opticalSystemRows, stopSurfaceIndex);
                const errorX = actualPoint.x - targetPoint.x;
                const errorY = actualPoint.y - targetPoint.y;
                const totalError = Math.sqrt(errorX*errorX + errorY*errorY);
                
                if (debugMode) {
                    console.log(`📊 [Marginal-Brent] 結果検証:`);
                    console.log(`   最適方向ベクトル: (${result.i.toFixed(6)}, ${result.j.toFixed(6)}, ${result.k.toFixed(6)})`);
                    console.log(`   Stop面実際位置: (${actualPoint.x.toFixed(3)}, ${actualPoint.y.toFixed(3)})`);
                    console.log(`   Stop面目標位置: (${targetPoint.x.toFixed(3)}, ${targetPoint.y.toFixed(3)})`);
                    console.log(`   誤差: X=${errorX.toFixed(6)}mm, Y=${errorY.toFixed(6)}mm, 総合=${totalError.toFixed(6)}mm`);
                }
                
                // 誤差が大きい場合はグリッドサーチへフォールバック
                const tolerance = 0.5; // 0.5mm以上の誤差ならグリッドサーチ
                if (totalError > tolerance) {
                    if (debugMode) {
                        try {
                            const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
                            if (RAYTRACE_DEBUG) {
                                console.warn(`⚠️ [Marginal-Brent] 誤差が大きい(${totalError.toFixed(3)}mm > ${tolerance}mm) → グリッドサーチへ切替`);
                            }
                        } catch (_) {}
                    }
                    // グリッドサーチへジャンプ（下のグリッドサーチセクションと同じコード）
                    const gridSearchMargin = 0.15;
                    const yStart = initialDirection.j - gridSearchMargin;
                    const yEnd = initialDirection.j + gridSearchMargin;
                    const yStep = 0.005;
                    const xStart = initialDirection.i - gridSearchMargin;
                    const xEnd = initialDirection.i + gridSearchMargin;
                    const xStep = 0.005;
                    
                    let bestDir = null;
                    let bestError = Infinity;
                    let bestPathLength = 0;
                    
                    for (let dirJ = yStart; dirJ <= yEnd; dirJ += yStep) {
                        for (let dirI = xStart; dirI <= xEnd; dirI += xStep) {
                            const dirK_squared = 1 - dirI*dirI - dirJ*dirJ;
                            if (dirK_squared <= 0) continue;
                            
                            const dirK = Math.sqrt(dirK_squared);
                            if (dirK < 0.5) continue;
                            
                            const testRay = {
                                wavelength: wavelength,
                                pos: { x: objectPosition.x, y: objectPosition.y, z: objectPosition.z },
                                dir: { x: dirI, y: dirJ, z: dirK }
                            };
                            
                            try {
                                const testPath = traceRay(opticalSystemRows, testRay, 1.0);
                                if (!testPath || testPath.length <= stopSurfaceIndex) continue;
                                
                                const actualPoint = getRayPointAtSurfaceIndex(testPath, opticalSystemRows, stopSurfaceIndex);
                                const errorX = actualPoint.x - targetPoint.x;
                                const errorY = actualPoint.y - targetPoint.y;
                                const totalError = Math.sqrt(errorX*errorX + errorY*errorY);
                                
                                if (testPath.length > bestPathLength || 
                                    (testPath.length === bestPathLength && totalError < bestError)) {
                                    bestPathLength = testPath.length;
                                    bestError = totalError;
                                    bestDir = { i: dirI, j: dirJ, k: dirK };
                                }
                            } catch (error) {
                                continue;
                            }
                        }
                    }
                    
                    if (bestDir && bestPathLength > stopSurfaceIndex) {
                        if (debugMode) {
                            console.log(`✅ [Marginal-Grid] グリッドサーチ成功: 方向(${bestDir.i.toFixed(6)}, ${bestDir.j.toFixed(6)}, ${bestDir.k.toFixed(6)}), 誤差${bestError.toFixed(3)}mm`);
                        }
                        return bestDir;
                    }
                }
                
                // 追加リファイン: 誤差が小さい閾値より大きい場合、簡易2D勾配風調整で再試行
                const refineTolerance = 0.05; // 0.05mm以内なら十分とみなす
                if (totalError > tolerance) {
                    let refined = { ...result };
                    let bestErr = totalError;
                    const maxRefineIter = 8;
                    const gain = 0.15; // 調整係数（やや控えめ）
                    for (let it = 0; it < maxRefineIter; it++) {
                        // 誤差方向へ向けて i,j を補正（Stop面上のX,Y誤差をそのまま使用: 単純比例）
                        refined.i -= gain * errorX;
                        refined.j -= gain * errorY;
                        // 正規化と z再計算
                        const magIJ2 = refined.i*refined.i + refined.j*refined.j;
                        if (magIJ2 >= 0.9999) { // 極端な傾きは抑制
                            refined.i *= 0.95; refined.j *= 0.95;
                        }
                        const k2 = 1 - (refined.i*refined.i + refined.j*refined.j);
                        refined.k = k2 > 0 ? Math.sqrt(k2) : 1e-6;
                        const testPath = traceRay(opticalSystemRows, { pos: objectPosition, dir: { x: refined.i, y: refined.j, z: refined.k } }, 1.0);
                        if (testPath && testPath.length > stopSurfaceIndex) {
                            const p = getRayPointAtSurfaceIndex(testPath, opticalSystemRows, stopSurfaceIndex);
                            const ex = p.x - targetPoint.x;
                            const ey = p.y - targetPoint.y;
                            const e = Math.sqrt(ex*ex + ey*ey);
                            if (e < bestErr) {
                                bestErr = e;
                                result.i = refined.i; result.j = refined.j; result.k = refined.k;
                                if (debugMode) {
                                    console.log(`🔧 [Marginal-Refine] it=${it} 誤差改善 → ${e.toFixed(4)}mm`);
                                }
                                if (e < tolerance) break;
                            }
                        } else {
                            // Stopに届かない → 少し光軸寄りに戻す
                            refined.i *= 0.9; refined.j *= 0.9;
                        }
                    }
                }
                return result;                
            } else {
                if (debugMode) {
                    try {
                        const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
                        if (RAYTRACE_DEBUG) {
                            console.warn(`⚠️ [Marginal-Brent] 周辺光線がStop面に到達せず（パス長${verificationPath ? verificationPath.length : 0}） → グリッドサーチへ切替`);
                        }
                    } catch (_) {}
                }
                
                // グリッドサーチフォールバック（主光線と同様の手法）
                const gridSearchMargin = 0.15; // マージナル光線用の探索範囲（主光線より広め）
                const yStart = initialDirection.j - gridSearchMargin;
                const yEnd = initialDirection.j + gridSearchMargin;
                const yStep = 0.005; // 0.005刻み
                const xStart = initialDirection.i - gridSearchMargin;
                const xEnd = initialDirection.i + gridSearchMargin;
                const xStep = 0.005; // 0.005刻み
                
                let bestDir = null;
                let bestError = Infinity;
                let bestPathLength = 0;
                
                for (let dirJ = yStart; dirJ <= yEnd; dirJ += yStep) {
                    for (let dirI = xStart; dirI <= xEnd; dirI += xStep) {
                        const dirK_squared = 1 - dirI*dirI - dirJ*dirJ;
                        if (dirK_squared <= 0) continue;
                        
                        const dirK = Math.sqrt(dirK_squared);
                        if (dirK < 0.5) continue; // 極端な傾きは除外
                        
                        const testRay = {
                            wavelength: wavelength,
                            pos: { x: objectPosition.x, y: objectPosition.y, z: objectPosition.z },
                            dir: { x: dirI, y: dirJ, z: dirK }
                        };
                        
                        try {
                            const testPath = traceRay(opticalSystemRows, testRay, 1.0);
                            if (!testPath || testPath.length <= stopSurfaceIndex) continue;
                            
                            const actualPoint = getRayPointAtSurfaceIndex(testPath, opticalSystemRows, stopSurfaceIndex);
                            const errorX = actualPoint.x - targetPoint.x;
                            const errorY = actualPoint.y - targetPoint.y;
                            const totalError = Math.sqrt(errorX*errorX + errorY*errorY);
                            
                            // パス長優先、次に誤差
                            if (testPath.length > bestPathLength || 
                                (testPath.length === bestPathLength && totalError < bestError)) {
                                bestPathLength = testPath.length;
                                bestError = totalError;
                                bestDir = { i: dirI, j: dirJ, k: dirK };
                            }
                        } catch (error) {
                            continue;
                        }
                    }
                }
                
                if (bestDir && bestPathLength > stopSurfaceIndex) {
                    if (debugMode) {
                        console.log(`✅ [Marginal-Grid] グリッドサーチ成功: 方向(${bestDir.i.toFixed(6)}, ${bestDir.j.toFixed(6)}, ${bestDir.k.toFixed(6)}), 誤差${bestError.toFixed(3)}mm`);
                    }
                    return bestDir;
                }
                
                if (debugMode) {
                    console.warn(`⚠️ [Marginal-Grid] グリッドサーチも失敗、初期方向使用`);
                }
                return initialDirection;
            }
        } catch (error) {
            if (debugMode) {
                console.warn(`⚠️ [Marginal] 周辺光線検証エラー: ${error.message}`);
            }
            return initialDirection;
        }
        
    } catch (error) {
        if (debugMode) {
            console.error(`❌ [Marginal] 周辺光線方向ベクトル探索エラー: ${error.message}`);
        }
        
        // フォールバック
        return { i: 0, j: 0, k: 1 };
    }
}

/**
 * 有限系でのクロスビーム生成（Rectangleオブジェクト対応、Brent法使用）
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Array} objectPositions - Object位置配列（Rectangle形状）
 * @param {Object} options - オプション
 * @returns {Object} 生成結果
 */
export function generateFiniteSystemCrossBeam(opticalSystemRows, objectPositions, options = {}) {
    const {
        rayCount = 51,
        debugMode = false,
        wavelength = 0.5876,
        crossType = 'both',
        targetSurfaceIndex = null  // 評価面インデックス
    } = options;

    // デバッグモードの設定
    const actualDebugMode = true;

    try {
        const allResults = [];
        const allTracedRays = [];
        const allCrossBeamRays = [];

        if (actualDebugMode) {
            console.log('🌟 [FiniteSystem] 有限系クロスビーム生成開始');
            console.log(`   Object数: ${objectPositions.length}, 光線数: ${rayCount}, クロスタイプ: ${crossType}`);
        }
        
        if (actualDebugMode) {
            console.log(`   光学系行数: ${opticalSystemRows.length}`);
            // 光学系の最初の数行をチェック
            console.log('📋 [FiniteSystem] 光学系サンプル:');
            for (let i = 0; i < Math.min(3, opticalSystemRows.length); i++) {
                const row = opticalSystemRows[i];
                console.log(`   Surface${i + 1}: R=${row.radius}, T=${row.thickness}, ND=${row.nd}, VD=${row.vd}`);
            }
        }

        // Stop面を検索
        const stopSurface = findStopSurface(opticalSystemRows);
        if (!stopSurface) {
            throw new Error('Stop面が見つかりません');
        }

        const stopSurfaceIndex = stopSurface.index;
        
        // Stop面の正しいz位置を計算
        const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
        let stopZ;
        
        if (surfaceOrigins && surfaceOrigins[stopSurfaceIndex] && surfaceOrigins[stopSurfaceIndex].origin) {
            stopZ = surfaceOrigins[stopSurfaceIndex].origin.z;
        } else {
            // フォールバック: 累積厚さから計算
            stopZ = 0;
            for (let i = 0; i < stopSurfaceIndex; i++) {
                const thickness = parseFloat(opticalSystemRows[i].thickness) || 0;
                stopZ += thickness;
            }
        }
        
        // Stop面中心位置を設定（CB対応: decenter/tilt により光軸上とは限らない）
        const stopCenter = {
            x: (surfaceOrigins && surfaceOrigins[stopSurfaceIndex] && surfaceOrigins[stopSurfaceIndex].origin && Number.isFinite(surfaceOrigins[stopSurfaceIndex].origin.x))
                ? surfaceOrigins[stopSurfaceIndex].origin.x
                : 0,
            y: (surfaceOrigins && surfaceOrigins[stopSurfaceIndex] && surfaceOrigins[stopSurfaceIndex].origin && Number.isFinite(surfaceOrigins[stopSurfaceIndex].origin.y))
                ? surfaceOrigins[stopSurfaceIndex].origin.y
                : 0,
            z: stopZ
        };

        if (actualDebugMode) {
            console.log(`   Stop面: Surface${stopSurfaceIndex + 1}, 中心(${stopCenter.x}, ${stopCenter.y}, ${stopCenter.z})`);
        }
        if (actualDebugMode) {
            console.log(`📍 [FiniteSystem] Stop面詳細確認:`);
            console.log(`   Stop面インデックス: ${stopSurfaceIndex}`);
            console.log(`   Stop面データからのz: ${stopSurface.z}`);
            console.log(`   surfaceOrigins[${stopSurfaceIndex}]: ${surfaceOrigins && surfaceOrigins[stopSurfaceIndex] ? JSON.stringify(surfaceOrigins[stopSurfaceIndex]) : 'undefined'}`);
            console.log(`   surfaceOrigins[${stopSurfaceIndex}].origin.z: ${surfaceOrigins && surfaceOrigins[stopSurfaceIndex] && surfaceOrigins[stopSurfaceIndex].origin ? surfaceOrigins[stopSurfaceIndex].origin.z : 'undefined'}`);
            console.log(`   計算されたz位置: ${stopZ}`);
            console.log(`   最終Stop面中心: (${stopCenter.x}, ${stopCenter.y}, ${stopCenter.z})`);
        }
        
        // 基本的な光線追跡テスト（デバッグモード時のみ）
        if (actualDebugMode) {
            console.log('🧪 [FiniteSystem] 光線追跡テスト開始');
            try {
                const testRay = {
                    pos: { x: 0, y: 0, z: 0 },
                    dir: { x: 0, y: 0, z: 1 }
                };
                const testPath = traceRay(opticalSystemRows, testRay, 1.0);
                console.log(`   テスト光線（光軸沿い）: ${testPath ? testPath.length : 0}点`);
                if (testPath && testPath.length > 1) {
                    console.log(`   テスト光線成功: 開始(${testPath[0].x.toFixed(3)}, ${testPath[0].y.toFixed(3)}, ${testPath[0].z.toFixed(3)}) → 終了(${testPath[testPath.length-1].x.toFixed(3)}, ${testPath[testPath.length-1].y.toFixed(3)}, ${testPath[testPath.length-1].z.toFixed(3)})`);
                } else {
                    console.warn(`   ⚠️ テスト光線失敗: パス長${testPath ? testPath.length : 0}`);
                }
            } catch (testError) {
                console.error(`   ❌ テスト光線エラー: ${testError.message}`);
            }
        }

        // 各Objectの処理
        for (let objectIndex = 0; objectIndex < objectPositions.length; objectIndex++) {
            const objectPos = objectPositions[objectIndex];
            
            // 実際のObjectインデックスを取得（fieldSettingから渡された値を使用）
            const actualObjectIndex = objectPos.objectIndex !== undefined ? objectPos.objectIndex : objectIndex;
            
            // Object面のsag（サグ）を考慮したz位置の計算
            let objectZ = 0; // デフォルト値
            
            try {
                // 最初の面（Object面）のパラメータを取得
                const objectSurface = opticalSystemRows[0];
                if (objectSurface) {
                    // Object位置での光軸からの距離（安全な取得）
                    const objX = Number(objectPos.x || objectPos.xHeightAngle || 0);
                    const objY = Number(objectPos.y || objectPos.yHeightAngle || 0);
                    const rho = Math.sqrt(objX * objX + objY * objY);
                    
                    if (rho > 0 && Math.abs(parseFloat(objectSurface.radius) || 0) > 1e-10) {
                        // surface.jsのasphericSurfaceZ関数を使用してsag計算
                        const surfaceParams = {
                            radius: parseFloat(objectSurface.radius) || 0,
                            conic: parseFloat(objectSurface.k) || 0, // 円錐定数
                            coef1: parseFloat(objectSurface.A1) || 0,
                            coef2: parseFloat(objectSurface.A2) || 0,
                            coef3: parseFloat(objectSurface.A3) || 0,
                            coef4: parseFloat(objectSurface.A4) || 0,
                            coef5: parseFloat(objectSurface.A5) || 0,
                            coef6: parseFloat(objectSurface.A6) || 0,
                            coef7: parseFloat(objectSurface.A7) || 0,
                            coef8: parseFloat(objectSurface.A8) || 0,
                            coef9: parseFloat(objectSurface.A9) || 0,
                            coef10: parseFloat(objectSurface.A10) || 0
                        };
                        
                        // ray-tracing.jsのasphericSag関数を使用してsag計算
                        objectZ = asphericSag(rho, surfaceParams, "even");
                        
                        // 無効な値の場合はデフォルト値を使用
                        if (!isFinite(objectZ)) {
                            objectZ = 0;
                            if (actualDebugMode) {
                                console.warn(`   Object面sag計算結果が無効: rho=${rho.toFixed(3)}, デフォルト値使用`);
                            }
                        } else if (actualDebugMode) {
                            console.log(`   Object面sag計算: R=${surfaceParams.radius}, k=${surfaceParams.conic}, rho=${rho.toFixed(3)}, sag=${objectZ.toFixed(6)}mm`);
                        }
                    } else if (actualDebugMode) {
                        console.log(`   Object面は平面または光軸上: R=${objectSurface.radius}, rho=${rho.toFixed(3)}`);
                    }
                }
            } catch (sagError) {
                if (actualDebugMode) {
                    console.warn(`   Object面sag計算エラー: ${sagError.message}, デフォルト値使用`);
                }
            }
            
            const fixedObjectPos = {
                x: Number(objectPos.x || objectPos.xHeightAngle || 0),
                y: Number(objectPos.y || objectPos.yHeightAngle || 0),
                z: objectZ
            };
            
            console.log(`🎯 [FiniteSystem] Object${actualObjectIndex + 1}処理開始: 位置(${fixedObjectPos.x.toFixed(3)}, ${fixedObjectPos.y.toFixed(3)}, ${fixedObjectPos.z.toFixed(3)})`);
            
            // Object位置の妥当性チェック
            if (fixedObjectPos.x === 0 && fixedObjectPos.y === 0 && fixedObjectPos.z === 0) {
                try {
                    const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
                    if (RAYTRACE_DEBUG) {
                        console.warn(`⚠️ [FiniteSystem] Object${actualObjectIndex + 1}が原点(0,0,0)に位置しています。これは正常ですが、主光線計算に注意が必要です。`);
                    }
                } catch (_) {}
            }
            
            // Object位置からの基本光線テスト（デバッグモード時のみ）
            if (actualDebugMode) {
                try {
                    const simpleTestRay = {
                        pos: fixedObjectPos,
                        dir: { x: 0, y: 0, z: 1 } // まっすぐ前方
                    };
                    const simpleTestPath = traceRay(opticalSystemRows, simpleTestRay, 1.0);
                    console.log(`   Object${actualObjectIndex + 1}基本テスト: パス長${simpleTestPath ? simpleTestPath.length : 0}`);
                    
                    if (simpleTestPath && simpleTestPath.length <= 1) {
                        console.error(`   ❌ Object${actualObjectIndex + 1}からの基本光線が失敗。Position問題の可能性`);
                    }
                } catch (simpleError) {
                    console.error(`   ❌ Object${actualObjectIndex + 1}基本テストエラー: ${simpleError.message}`);
                }
            }

            // 1. 主光線の方向ベクトル探索（Brent法を使用）
            let chiefRayDirection;
            
            try {
                if (actualDebugMode) {
                    console.log(`🔍 [FiniteSystem] Object${actualObjectIndex + 1}: 主光線方向ベクトル探索開始`);
                    console.log(`   Object位置: (${fixedObjectPos.x.toFixed(3)}, ${fixedObjectPos.y.toFixed(3)}, ${fixedObjectPos.z.toFixed(3)})`);
                    console.log(`   Stop面中心: (${stopCenter.x.toFixed(3)}, ${stopCenter.y.toFixed(3)}, ${stopCenter.z.toFixed(3)})`);
                }
                
                // Brent法による主光線方向ベクトル探索
                chiefRayDirection = findFiniteSystemChiefRayDirection(
                    fixedObjectPos, 
                    stopCenter, 
                    stopSurfaceIndex, 
                    opticalSystemRows, 
                    actualDebugMode,
                    wavelength
                );
                
                if (actualDebugMode) {
                    console.log(`✅ [FiniteSystem] Object${actualObjectIndex + 1}: 主光線方向ベクトル計算完了`);
                    console.log(`   結果: (${chiefRayDirection.i.toFixed(6)}, ${chiefRayDirection.j.toFixed(6)}, ${chiefRayDirection.k.toFixed(6)})`);
                }
                
            } catch (error) {
                if (actualDebugMode) {
                    console.error(`❌ [FiniteSystem] Object${actualObjectIndex + 1}: 主光線方向ベクトル探索エラー: ${error.message}`);
                }
                
                // フォールバック: 幾何学的計算
                const deltaX = stopCenter.x - fixedObjectPos.x;
                const deltaY = stopCenter.y - fixedObjectPos.y;
                const deltaZ = stopCenter.z - fixedObjectPos.z;
                const norm = Math.sqrt(deltaX*deltaX + deltaY*deltaY + deltaZ*deltaZ);
                
                if (norm < 1e-10) {
                    chiefRayDirection = { i: 0, j: 0, k: 1 }; // デフォルト前方方向
                } else {
                    chiefRayDirection = {
                        i: deltaX / norm,
                        j: deltaY / norm,
                        k: deltaZ / norm
                    };
                }
                
                if (actualDebugMode) {
                    console.log(`🔄 [FiniteSystem] Object${objectIndex + 1}: フォールバック計算使用`);
                    console.log(`   幾何学的方向: (${chiefRayDirection.i.toFixed(6)}, ${chiefRayDirection.j.toFixed(6)}, ${chiefRayDirection.k.toFixed(6)})`);
                }
            }
            
            // NaN チェック
            if (!isFinite(chiefRayDirection.i) || !isFinite(chiefRayDirection.j) || !isFinite(chiefRayDirection.k)) {
                if (actualDebugMode) {
                    console.warn(`⚠️ [FiniteSystem] Object${objectIndex + 1}: 主光線方向ベクトルが無効、デフォルト値使用`);
                }
                chiefRayDirection = { i: 0, j: 0, k: 1 }; // デフォルト前方方向
            }
            
            if (actualDebugMode) {
                console.log(`   主光線方向: (${chiefRayDirection.i.toFixed(6)}, ${chiefRayDirection.j.toFixed(6)}, ${chiefRayDirection.k.toFixed(6)})`);
                
                // 主光線をテスト
                try {
                    const chiefTestRay = {
                        pos: fixedObjectPos,
                        dir: { x: chiefRayDirection.i, y: chiefRayDirection.j, z: chiefRayDirection.k }
                    };
                    const chiefTestPath = traceRay(opticalSystemRows, chiefTestRay, 1.0);
                    console.log(`   主光線テスト: パス長${chiefTestPath ? chiefTestPath.length : 0}`);
                    
                    if (chiefTestPath && chiefTestPath.length > stopSurfaceIndex) {
                        const stopPoint = getRayPointAtSurfaceIndex(chiefTestPath, opticalSystemRows, stopSurfaceIndex);
                        const errorX = stopPoint.x - stopCenter.x;
                        const errorY = stopPoint.y - stopCenter.y;
                        const totalError = Math.sqrt(errorX*errorX + errorY*errorY);
                        console.log(`   Stop面到達: 実際(${stopPoint.x.toFixed(3)}, ${stopPoint.y.toFixed(3)}), 目標(${stopCenter.x.toFixed(3)}, ${stopCenter.y.toFixed(3)}), 誤差=${totalError.toFixed(3)}mm`);
                    } else {
                        console.warn(`   ⚠️ 主光線がStop面に到達せず: パス長${chiefTestPath ? chiefTestPath.length : 0}`);
                    }
                } catch (chiefError) {
                    console.error(`   ❌ 主光線エラー: ${chiefError.message}`);
                }
            }

            if (!chiefRayDirection) {
                console.warn(`⚠️ [FiniteSystem] Object${objectIndex + 1}の主光線方向ベクトル計算失敗`);
                continue;
            }

            const rays = [];
            let rayIndex = 0;

            // 主光線を追加
            const chiefRay = {
                position: fixedObjectPos,
                direction: { x: chiefRayDirection.i, y: chiefRayDirection.j, z: chiefRayDirection.k },
                type: 'chief',
                wavelength: wavelength,
                objectIndex: actualObjectIndex,
                rayIndex: rayIndex++
            };
            rays.push(chiefRay);

            if (actualDebugMode) {
                console.log(`   主光線方向: (${chiefRayDirection.i.toFixed(6)}, ${chiefRayDirection.j.toFixed(6)}, ${chiefRayDirection.k.toFixed(6)})`);
            }

            // 2. 絞り周辺光線の探索
            let leftRay = null, rightRay = null, topRay = null, bottomRay = null;
            let leftDirection = null, rightDirection = null, topDirection = null, bottomDirection = null;

            // 絞りサイズの動的推定（実際のStop面データから取得）
            let apertureRadius = 5; // デフォルト値
            
            console.log(`🔍 [FiniteSystem] Object${actualObjectIndex + 1}: 絞り半径の取得を開始`);
            console.log(`   stopSurface:`, stopSurface);
            console.log(`   stopSurfaceIndex: ${stopSurfaceIndex}`);
            
            try {
                // Stop面の実際の半径を光学系データから直接取得
                const actualStopSurface = opticalSystemRows[stopSurfaceIndex];
                console.log(`   実際のStop面データ:`, actualStopSurface);
                
                // semidia取得の試行（複数のフィールド名をチェック）
                const semidiaFields = ['semidia', 'semiDiameter', 'semi-diameter', 'semi_diameter', 
                                       'Clear_Aperture', 'clearAperture', 'clear_aperture'];
                let foundSemidia = false;
                
                for (const field of semidiaFields) {
                    if (actualStopSurface && actualStopSurface[field] !== undefined && actualStopSurface[field] !== null && actualStopSurface[field] !== '') {
                        const value = parseFloat(actualStopSurface[field]);
                        if (!isNaN(value) && value > 0) {
                            apertureRadius = value;
                            foundSemidia = true;
                            console.log(`   ✅ 絞り半径を${field}から取得: ${apertureRadius.toFixed(3)}mm`);
                            break;
                        }
                    }
                }
                
                // diameter から取得を試行
                if (!foundSemidia && actualStopSurface && actualStopSurface.diameter) {
                    const diameter = parseFloat(actualStopSurface.diameter);
                    if (!isNaN(diameter) && diameter > 0) {
                        apertureRadius = diameter / 2;
                        foundSemidia = true;
                        console.log(`   ✅ 絞り半径をdiameterから取得: ${apertureRadius.toFixed(3)}mm (diameter=${diameter})`);
                    }
                }
                
                // それでも見つからない場合、stopSurface.radiusを使用
                if (!foundSemidia && stopSurface && stopSurface.radius) {
                    apertureRadius = stopSurface.radius;
                    foundSemidia = true;
                    console.log(`   ✅ 絞り半径をstopSurface.radiusから取得: ${apertureRadius.toFixed(3)}mm`);
                }
                
                if (!foundSemidia) {
                    console.warn(`   ⚠️ Stop面の半径が見つかりません。デフォルト値${apertureRadius}mmを使用`);
                }
            } catch (error) {
                console.error(`   ❌ 絞り半径推定エラー: ${error.message}, デフォルト値使用`);
            }
            
            console.log(`   📏 最終的な絞り半径: ${apertureRadius.toFixed(3)}mm`);

            // 主光線が絞り面で実際に通過する位置を取得
            const chiefTestRay = { pos: fixedObjectPos, dir: { x: chiefRayDirection.i, y: chiefRayDirection.j, z: chiefRayDirection.k } };
            const chiefRayPath = traceRay(opticalSystemRows, chiefTestRay, 1.0);
            let chiefStopX = 0, chiefStopY = 0;
            if (chiefRayPath && chiefRayPath.length > stopSurfaceIndex) {
                const stopPoint = getRayPointAtSurfaceIndex(chiefRayPath, opticalSystemRows, stopSurfaceIndex);
                chiefStopX = stopPoint.x;
                chiefStopY = stopPoint.y;
                console.log(`   📍 主光線の絞り通過位置: (${chiefStopX.toFixed(3)}, ${chiefStopY.toFixed(3)}, ${stopCenter.z.toFixed(3)})`);
            } else {
                console.warn(`   ⚠️ 主光線の絞り面通過位置を取得できませんでした (パス長: ${chiefRayPath ? chiefRayPath.length : 'null'})`);
            }

            if (crossType === 'both' || crossType === 'horizontal') {
                // 水平方向マージナル光線の目標点を計算（絞り中心基準）
                const leftTarget = { 
                    x: stopCenter.x - apertureRadius,  // 絞り中心から左へapertureRadius
                    y: stopCenter.y, 
                    z: stopCenter.z 
                };
                const rightTarget = { 
                    x: stopCenter.x + apertureRadius,  // 絞り中心から右へapertureRadius
                    y: stopCenter.y, 
                    z: stopCenter.z 
                };

                console.log(`🔍 [FiniteSystem] Object${actualObjectIndex + 1}: 水平方向光線探索開始`);
                console.log(`   左目標点: (${leftTarget.x.toFixed(3)}, ${leftTarget.y.toFixed(3)}, ${leftTarget.z.toFixed(3)})`);
                console.log(`   右目標点: (${rightTarget.x.toFixed(3)}, ${rightTarget.y.toFixed(3)}, ${rightTarget.z.toFixed(3)})`);

                try {
                    leftDirection = findFiniteSystemMarginalRayDirection(
                        fixedObjectPos, leftTarget, stopSurfaceIndex, opticalSystemRows, true, wavelength
                    );
                    
                    console.log(`✅ [FiniteSystem] Object${actualObjectIndex + 1}: 左マージナル光線方向: (${leftDirection.i.toFixed(6)}, ${leftDirection.j.toFixed(6)}, ${leftDirection.k.toFixed(6)})`);
                } catch (error) {
                    console.error(`❌ [FiniteSystem] Object${actualObjectIndex + 1}: 左マージナル光線計算失敗: ${error.message}`);
                    console.error(`   スタックトレース:`, error.stack);
                    // フォールバック: 主光線方向から微小オフセット
                    const angularOffset = apertureRadius / stopCenter.z;
                    leftDirection = { 
                        i: chiefRayDirection.i - angularOffset, 
                        j: chiefRayDirection.j, 
                        k: Math.sqrt(1 - (chiefRayDirection.i - angularOffset)**2 - chiefRayDirection.j**2)
                    };
                }

                try {
                    rightDirection = findFiniteSystemMarginalRayDirection(
                        fixedObjectPos, rightTarget, stopSurfaceIndex, opticalSystemRows, true, wavelength
                    );
                    
                    console.log(`✅ [FiniteSystem] Object${actualObjectIndex + 1}: 右マージナル光線方向: (${rightDirection.i.toFixed(6)}, ${rightDirection.j.toFixed(6)}, ${rightDirection.k.toFixed(6)})`);
                } catch (error) {
                    console.error(`❌ [FiniteSystem] Object${actualObjectIndex + 1}: 右マージナル光線計算失敗: ${error.message}`);
                    console.error(`   スタックトレース:`, error.stack);
                    const angularOffset = apertureRadius / stopCenter.z;
                    // フォールバック: 主光線方向から微小オフセット
                    rightDirection = { 
                        i: chiefRayDirection.i + angularOffset, 
                        j: chiefRayDirection.j, 
                        k: Math.sqrt(1 - (chiefRayDirection.i + angularOffset)**2 - chiefRayDirection.j**2)
                    };
                }

                leftRay = {
                    position: fixedObjectPos,
                    direction: { x: leftDirection.i, y: leftDirection.j, z: leftDirection.k },
                    type: 'left_marginal',
                    wavelength: wavelength,
                    objectIndex: actualObjectIndex,
                    rayIndex: rayIndex++
                };

                rightRay = {
                    position: fixedObjectPos,
                    direction: { x: rightDirection.i, y: rightDirection.j, z: rightDirection.k },
                    type: 'right_marginal',
                    wavelength: wavelength,
                    objectIndex: actualObjectIndex,
                    rayIndex: rayIndex++
                };

                rays.push(leftRay, rightRay);
            }

            if (crossType === 'both' || crossType === 'vertical') {
                // 垂直方向マージナル光線の目標点を計算（絞り中心基準）
                const topTarget = { 
                    x: stopCenter.x, 
                    y: stopCenter.y + apertureRadius, 
                    z: stopCenter.z 
                };
                const bottomTarget = { 
                    x: stopCenter.x, 
                    y: stopCenter.y - apertureRadius, 
                    z: stopCenter.z 
                };

                console.log(`🔍 [FiniteSystem] Object${actualObjectIndex + 1}: 垂直方向光線探索開始`);
                console.log(`   上目標点: (${topTarget.x.toFixed(3)}, ${topTarget.y.toFixed(3)}, ${topTarget.z.toFixed(3)})`);
                console.log(`   下目標点: (${bottomTarget.x.toFixed(3)}, ${bottomTarget.y.toFixed(3)}, ${bottomTarget.z.toFixed(3)})`);

                try {
                    topDirection = findFiniteSystemMarginalRayDirection(
                        fixedObjectPos, topTarget, stopSurfaceIndex, opticalSystemRows, true, wavelength
                    );
                    
                    console.log(`✅ [FiniteSystem] Object${actualObjectIndex + 1}: 上マージナル光線方向: (${topDirection.i.toFixed(6)}, ${topDirection.j.toFixed(6)}, ${topDirection.k.toFixed(6)})`);
                } catch (error) {
                    console.error(`❌ [FiniteSystem] Object${actualObjectIndex + 1}: 上マージナル光線計算失敗: ${error.message}`);
                    console.error(error.stack);
                    // フォールバック: 主光線方向から微小オフセット
                    const angularOffset = apertureRadius / stopCenter.z;
                    topDirection = { 
                        i: chiefRayDirection.i, 
                        j: chiefRayDirection.j + angularOffset, 
                        k: Math.sqrt(1 - chiefRayDirection.i**2 - (chiefRayDirection.j + angularOffset)**2)
                    };
                }

                try {
                    bottomDirection = findFiniteSystemMarginalRayDirection(
                        fixedObjectPos, bottomTarget, stopSurfaceIndex, opticalSystemRows, true, wavelength
                    );
                    
                    console.log(`✅ [FiniteSystem] Object${actualObjectIndex + 1}: 下マージナル光線方向: (${bottomDirection.i.toFixed(6)}, ${bottomDirection.j.toFixed(6)}, ${bottomDirection.k.toFixed(6)})`);
                } catch (error) {
                    console.error(`❌ [FiniteSystem] Object${actualObjectIndex + 1}: 下マージナル光線計算失敗: ${error.message}`);
                    console.error(error.stack);
                    // フォールバック: 主光線方向から微小オフセット
                    const angularOffset = apertureRadius / stopCenter.z;
                    bottomDirection = { 
                        i: chiefRayDirection.i, 
                        j: chiefRayDirection.j - angularOffset, 
                        k: Math.sqrt(1 - chiefRayDirection.i**2 - (chiefRayDirection.j - angularOffset)**2)
                    };
                }

                topRay = {
                    position: fixedObjectPos,
                    direction: { x: topDirection.i, y: topDirection.j, z: topDirection.k },
                    type: 'upper_marginal',
                    wavelength: wavelength,
                    objectIndex: actualObjectIndex,
                    rayIndex: rayIndex++
                };

                bottomRay = {
                    position: fixedObjectPos,
                    direction: { x: bottomDirection.i, y: bottomDirection.j, z: bottomDirection.k },
                    type: 'lower_marginal',
                    wavelength: wavelength,
                    objectIndex: actualObjectIndex,
                    rayIndex: rayIndex++
                };

                rays.push(topRay, bottomRay);
            }

            // 3. 残りの光線を対称的に配置（-方向から+方向への等分）
            if (rayIndex < rayCount) {
                const remainingRays = rayCount - rayIndex;
                
                if (actualDebugMode) {
                    console.log(`🔍 [CrossBeam] 十字配置光線生成: ${remainingRays}本`);
                }
                
                // 利用可能な方向を確認
                const hasHorizontal = leftRay && rightRay;
                const hasVertical = topRay && bottomRay;
                
                // 方向ベクトル妥当性チェック関数 (高画角で k が小さくなるケースに対応し閾値を緩和)
                const isValidDirection = (dir) => {
                    const magnitude = Math.sqrt(dir.x*dir.x + dir.y*dir.y + dir.z*dir.z);
                    // z 成分閾値を 0.0001 まで緩和。極端に負方向(後方向)を除外し、異常に発散した方向も除外。
                    return magnitude > 1e-10 && dir.z > 0.0001 && Math.abs(dir.x) < 10 && Math.abs(dir.y) < 10;
                };
                
                if (hasHorizontal && hasVertical) {
                    // 両方向がある場合：水平線と垂直線で等分配置
                    const horizontalRays = Math.floor(remainingRays / 2);
                    const verticalRays = remainingRays - horizontalRays;
                    
                    // 水平線（左から右へ等分配置）
                    if (horizontalRays > 0) {
                        for (let i = 0; i < horizontalRays && rayIndex < rayCount; i++) {
                            const t = (i + 1) / (horizontalRays + 1) * 2 - 1; // -1 < t < 1
                            
                            // 以前: maxRatio=0.8 によりマージナルとの間に未描画領域が残るケースがあった。
                            // 改善: 一旦 1.0 まで許容し、無効なら段階的に縮小 (adaptive) して必ず何本か生成。
                            const targetT = t; // フルスパン
                            let limitedT = targetT;
                            
                            let interpolatedDirection;
                            const buildDir = (ratio, side) => {
                                if (side === 'left') {
                                    return {
                                        x: chiefRayDirection.i + ratio * (leftDirection.i - chiefRayDirection.i),
                                        y: chiefRayDirection.j + ratio * (leftDirection.j - chiefRayDirection.j),
                                        z: chiefRayDirection.k + ratio * (leftDirection.k - chiefRayDirection.k)
                                    };
                                } else {
                                    return {
                                        x: chiefRayDirection.i + ratio * (rightDirection.i - chiefRayDirection.i),
                                        y: chiefRayDirection.j + ratio * (rightDirection.j - chiefRayDirection.j),
                                        z: chiefRayDirection.k + ratio * (rightDirection.k - chiefRayDirection.k)
                                    };
                                }
                            };

                            const side = limitedT < 0 ? 'left' : 'right';
                            let ratio = Math.abs(limitedT);
                            let attempts = 0;
                            let accepted = false;
                            while (attempts < 5 && !accepted) {
                                interpolatedDirection = buildDir(ratio, side);
                                const mag = Math.sqrt(interpolatedDirection.x**2 + interpolatedDirection.y**2 + interpolatedDirection.z**2);
                                if (mag > 1e-12) {
                                    interpolatedDirection.x /= mag;
                                    interpolatedDirection.y /= mag;
                                    interpolatedDirection.z /= mag;
                                }
                                if (isValidDirection(interpolatedDirection)) {
                                    rays.push({
                                        position: fixedObjectPos,
                                        direction: interpolatedDirection,
                                        type: 'horizontal_cross',
                                        wavelength: wavelength,
                                        side,
                                        objectIndex: actualObjectIndex,
                                        rayIndex: rayIndex++,
                                        crossParameter: side === 'left' ? -ratio : ratio
                                    });
                                    accepted = true;
                                } else {
                                    // 方向が無効 => 比率を少し縮め再試行
                                    ratio *= 0.7;
                                    attempts++;
                                    if (attempts === 1 && actualDebugMode) {
                                        console.warn(`⚠️ [CrossBeam] 水平光線${i} 初回無効 -> 比率縮小再試行`);
                                    }
                                }
                            }
                            if (!accepted && actualDebugMode) {
                                console.warn(`⚠️ [CrossBeam] 水平光線${i} を生成できませんでした (side=${side})`);
                            }
                        }
                    }
                    
                    // 垂直線（下から上へ等分配置）
                    if (verticalRays > 0) {
                        for (let i = 0; i < verticalRays && rayIndex < rayCount; i++) {
                            const t = (i + 1) / (verticalRays + 1) * 2 - 1; // -1 < t < 1
                            
                            // 同様に full span を試し無効なら adapt 縮小
                            const targetT = t;
                            let limitedT = targetT;
                            
                            let interpolatedDirection;
                            const buildDirV = (ratio, side) => {
                                if (side === 'bottom') {
                                    return {
                                        x: chiefRayDirection.i + ratio * (bottomDirection.i - chiefRayDirection.i),
                                        y: chiefRayDirection.j + ratio * (bottomDirection.j - chiefRayDirection.j),
                                        z: chiefRayDirection.k + ratio * (bottomDirection.k - chiefRayDirection.k)
                                    };
                                } else { // top
                                    return {
                                        x: chiefRayDirection.i + ratio * (topDirection.i - chiefRayDirection.i),
                                        y: chiefRayDirection.j + ratio * (topDirection.j - chiefRayDirection.j),
                                        z: chiefRayDirection.k + ratio * (topDirection.k - chiefRayDirection.k)
                                    };
                                }
                            };

                            const side = limitedT < 0 ? 'bottom' : 'top';
                            let ratio = Math.abs(limitedT);
                            let attempts = 0;
                            let accepted = false;
                            while (attempts < 6 && !accepted) { // 垂直方向は問題報告があったため 1 回多めに試行
                                interpolatedDirection = buildDirV(ratio, side);
                                const mag = Math.sqrt(interpolatedDirection.x**2 + interpolatedDirection.y**2 + interpolatedDirection.z**2);
                                if (mag > 1e-12) {
                                    interpolatedDirection.x /= mag;
                                    interpolatedDirection.y /= mag;
                                    interpolatedDirection.z /= mag;
                                }
                                if (isValidDirection(interpolatedDirection)) {
                                    rays.push({
                                        position: fixedObjectPos,
                                        direction: interpolatedDirection,
                                        type: 'vertical_cross',
                                        wavelength: wavelength,
                                        side,
                                        objectIndex: actualObjectIndex,
                                        rayIndex: rayIndex++,
                                        crossParameter: side === 'bottom' ? -ratio : ratio
                                    });
                                    accepted = true;
                                } else {
                                    ratio *= 0.7;
                                    attempts++;
                                    if (attempts === 1 && actualDebugMode) {
                                        console.warn(`⚠️ [CrossBeam] 垂直光線${i} 初回無効 -> 比率縮小再試行 (side=${side})`);
                                    }
                                }
                            }
                            if (!accepted && actualDebugMode) {
                                console.warn(`⚠️ [CrossBeam] 垂直光線${i} を生成できませんでした (side=${side})`);
                            }
                        }
                    }
                }
            }

            // 4. 光線追跡
            const tracedRays = [];
            if (actualDebugMode) {
                console.log(`🔬 [RayTrace] Object${actualObjectIndex + 1}: ${rays.length}本の光線を追跡開始`);
            }
            
            for (const ray of rays) {
                try {
                    if (actualDebugMode) {
                        console.log(`🔬 [RayTrace] 光線${ray.rayIndex}(${ray.type}): 位置(${ray.position.x.toFixed(3)}, ${ray.position.y.toFixed(3)}, ${ray.position.z.toFixed(3)}), 方向(${ray.direction.x.toFixed(6)}, ${ray.direction.y.toFixed(6)}, ${ray.direction.z.toFixed(6)})`);
                    }
                    
                    const rayPath = traceRay(opticalSystemRows, {
                        pos: ray.position,
                        dir: ray.direction,
                        wavelength: wavelength
                    }, 1.0);

                    if (rayPath && rayPath.length > 1) {
                        if (actualDebugMode) {
                            console.log(`   → 成功: パス長${rayPath.length}点, 開始(${rayPath[0].x.toFixed(3)}, ${rayPath[0].y.toFixed(3)}, ${rayPath[0].z.toFixed(3)}) → 終了(${rayPath[rayPath.length-1].x.toFixed(3)}, ${rayPath[rayPath.length-1].y.toFixed(3)}, ${rayPath[rayPath.length-1].z.toFixed(3)})`);
                        }
                        
                        tracedRays.push({
                            success: true,
                            originalRay: ray,
                            rayPath: rayPath,
                            objectIndex: actualObjectIndex
                        });
                    } else {
                        if (actualDebugMode) {
                            console.warn(`   → 失敗: パス長${rayPath ? rayPath.length : 0}が短すぎる`);
                            if (rayPath && rayPath.length === 1) {
                                console.warn(`     開始点のみ: (${rayPath[0].x.toFixed(3)}, ${rayPath[0].y.toFixed(3)}, ${rayPath[0].z.toFixed(3)})`);
                            }
                        }
                        
                        tracedRays.push({
                            success: false,
                            originalRay: ray,
                            error: `Ray path too short: ${rayPath ? rayPath.length : 0} points`,
                            objectIndex: actualObjectIndex
                        });
                    }
                } catch (error) {
                    if (actualDebugMode) {
                        console.error(`   → エラー: ${error.message}`);
                    }
                    tracedRays.push({
                        success: false,
                        originalRay: ray,
                        error: error.message,
                        objectIndex: actualObjectIndex
                    });
                }
            }

            allResults.push({
                objectIndex: actualObjectIndex,
                objectPosition: fixedObjectPos,
                chiefRayDirection: chiefRayDirection,
                rays: rays,
                tracedRays: tracedRays
            });

            rays.forEach(ray => {
                ray.objectIndex = objectIndex;
                allCrossBeamRays.push(ray);
            });

            tracedRays.forEach(ray => {
                ray.objectIndex = objectIndex;
                allTracedRays.push(ray);
            });

            const successCount = tracedRays.filter(r => r.success).length;
            console.log(`✅ [FiniteSystem] Object${objectIndex + 1}処理完了: 光線${rays.length}本, 追跡成功${successCount}本 (成功率${(successCount/rays.length*100).toFixed(1)}%)`);
            
            // System Data出力: 主光線の収束品質
            try {
                // 主光線がStop面中心にどれだけ近いか評価
                const chiefTracedRay = tracedRays.find(r => r.type === 'chief');
                if (chiefTracedRay && chiefTracedRay.success && chiefTracedRay.path && chiefTracedRay.path.length > stopSurfaceIndex) {
                    const stopPoint = getRayPointAtSurfaceIndex(chiefTracedRay?.path, opticalSystemRows, stopSurfaceIndex);
                    const errorX = stopPoint.x - stopCenter.x;
                    const errorY = stopPoint.y - stopCenter.y;
                    const totalError = Math.sqrt(errorX * errorX + errorY * errorY);
                    
                    // System Dataに出力
                    outputFiniteSystemChiefRayToSystemData(
                        objectIndex + 1,
                        fixedObjectPos.x,
                        fixedObjectPos.y,
                        totalError,
                        'brent-optimization' // 有限系ではBrent法使用
                    );
                    
                    console.log(`📊 [FiniteSystem] Object${objectIndex + 1}: System Data出力完了, 誤差=${totalError.toFixed(6)}mm`);
                } else {
                        try {
                            const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
                            if (RAYTRACE_DEBUG) {
                                console.warn(`⚠️ [FiniteSystem] Object${objectIndex + 1}: 主光線がStop面に到達せず、System Data出力スキップ`);
                            }
                        } catch (_) {}
                }
            } catch (systemDataError) {
                console.error(`❌ [FiniteSystem] Object${objectIndex + 1}: System Data出力エラー:`, systemDataError);
            }
            
            if (successCount === 0) {
                console.error(`❌ Object${objectIndex + 1}: 全ての光線が失敗。光学系またはObject位置に問題がある可能性`);
            }
        }

        const totalRays = allCrossBeamRays.length;
        const totalSuccess = allTracedRays.filter(r => r.success).length;
        
        // 水平・垂直方向の光線をカウント
        const horizontalCount = allCrossBeamRays.filter(r => 
            r.type === 'horizontal_cross' || r.type === 'left_marginal' || r.type === 'right_marginal'
        ).length;
        const verticalCount = allCrossBeamRays.filter(r => 
            r.type === 'vertical_cross' || r.type === 'upper_marginal' || r.type === 'lower_marginal'
        ).length;
        
        if (actualDebugMode) {
            console.log(`✅ [FiniteSystem] 有限系クロスビーム生成完了`);
            console.log(`   処理Object数: ${allResults.length}/${objectPositions.length}`);
            console.log(`   総生成光線数: ${totalRays}`);
            console.log(`   総追跡成功: ${totalSuccess}/${allTracedRays.length} (成功率${(totalSuccess/allTracedRays.length*100).toFixed(1)}%)`);
            console.log(`   水平方向光線: ${horizontalCount}`);
            console.log(`   垂直方向光線: ${verticalCount}`);
        }
        
        if (totalSuccess === 0) {
            console.error(`❌ [CRITICAL] 全ての光線追跡が失敗。システム設定を確認してください。`);
        }

        return {
            success: true,
            systemType: 'finite',
            objectCount: objectPositions.length,
            processedObjectCount: allResults.length,
            objectResults: allResults,
            allTracedRays: allTracedRays,
            allCrossBeamRays: allCrossBeamRays,
            rayCount: rayCount,
            crossType: crossType,
            wavelength: wavelength,
            stopSurfaceIndex: stopSurfaceIndex,
            stopCenter: stopCenter,
            horizontalCount: horizontalCount,
            verticalCount: verticalCount
        };

    } catch (error) {
        console.error(`❌ [FiniteSystem] 有限系クロスビーム生成エラー: ${error.message}`);
        return {
            success: false,
            error: error.message,
            systemType: 'finite'
        };
    }
}

/**
 * 下位互換性のためのalias
 */
export function generateCrossBeam(opticalSystemRows, objectPositions, options = {}) {
    return generateFiniteSystemCrossBeam(opticalSystemRows, objectPositions, options);
}

/**
 * 有限系での主光線収束情報をSystem Dataに出力
 * @param {number} objectNumber - Object番号（1-based）
 * @param {number} xPosition - X位置（mm）
 * @param {number} yPosition - Y位置（mm）
 * @param {number} distanceFromCenter - 絞り中心からの距離（mm）
 * @param {string} optimizationMethod - 最適化手法
 */
function outputFiniteSystemChiefRayToSystemData(objectNumber, xPosition, yPosition, distanceFromCenter, optimizationMethod) {
    try {
        console.log(`📊 [SystemData] 有限系出力関数呼び出し: Object${objectNumber}, 位置(${xPosition}mm, ${yPosition}mm), 距離=${distanceFromCenter}mm, 手法=${optimizationMethod}`);
        
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
        
        console.log(`✅ [SystemData] テキストエリアが見つかりました:`, systemDataTextarea);
        
        // 最適化手法の日本語表示
        const methodDisplayName = {
            'brent-optimization': 'Brent法による高精度最適化（有限系）',
            'newton-optimization': 'Newton法による最適化（有限系）',
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
        const convergenceReport = `
=== 主光線収束解析 [有限系] (Object ${objectNumber}, 位置: ${xPosition.toFixed(3)}mm, ${yPosition.toFixed(3)}mm) ===
絞り中心からの距離: ${distanceFromCenter.toFixed(6)}mm
最適化手法: ${methodName}
収束品質: ${qualityAssessment}
解析時刻: ${new Date().toLocaleTimeString()}
------------------------------------------------------------
`;
        
        // テキストエリアの先頭に追加
        systemDataTextarea.value = convergenceReport + systemDataTextarea.value;
        
        // スクロールを最上位に移動
        systemDataTextarea.scrollTop = 0;
        
        console.log(`✅ [SystemData] System Data出力完了: Object${objectNumber}`);
    } catch (error) {
        console.error(`❌ [SystemData] System Data出力エラー:`, error);
    }
}

// Export color system
export { RayColorSystem };

// Export utility functions
export { findFiniteSystemMarginalRayDirection };
