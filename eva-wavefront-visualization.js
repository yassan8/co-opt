/**
 * Wavefront Aberration Ray Visualization
 * 波面収差計算光線の3D描画システム
 * 
 * 機能:
 * - OPD計算で使用した光線をThree.jsキャンバスに描画
 * - グリッド        try {
            // 光線を描画（既存システムを使用）
          console.log(`✅ [WavefrontViz] 波面収差光線描画完了: 描画=${drawnCount}本, スキップ=${skippedCount}本`);
    
    // 🔧 **統計情報**: 色統計をログ出力（絞り端光線を重点監視）
    console.log(`🎯 [統計] 総光線数: ${rayStats.totalRays}本, 実描画: ${drawnCount}本`);
    console.log(`🎯 [統計] 赤色光線: ${rayStats.redRays}本, 青系光線: ${rayStats.blueRays}本`);
    
    // 絞り端光線の統計（赤色のみ表示）
    const edgeRedCount = Object.entries(rayStats.colorDistribution)
        .filter(([color, count]) => color === 'ff0000' || color === '800000')
        .reduce((sum, [color, count]) => sum + count, 0);
    console.log(`🎯 [絞り端確認] 絞り端赤色光線: ${edgeRedCount}本`);
    
    // 色分布の詳細（上位5色のみ表示）
    const sortedColors = Object.entries(rayStats.colorDistribution)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5);
    console.log(`🎨 [色分布] 上位5色:`, sortedColors.map(([color, count]) => `#${color}(${count}本)`).join(', '));
    
    // 🔍 **描画検証**: シーン内の実際のオブジェクトを確認
    let redRayObjectsInScene = 0;
    let totalRayObjectsInScene = 0;
    let edgeRayCoords = [];
    let rayBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
    
    scene.traverse((object) => {
        if (object.userData && object.userData.type === 'wavefront-ray') {
            totalRayObjectsInScene++;
            
            // 光線の座標範囲を収集
            if (object.geometry && object.geometry.attributes && object.geometry.attributes.position) {
                const positions = object.geometry.attributes.position.array;
                for (let i = 0; i < positions.length; i += 3) {
                    const x = positions[i];
                    const y = positions[i + 1];
                    const z = positions[i + 2];
                    
                    rayBounds.minX = Math.min(rayBounds.minX, x);
                    rayBounds.maxX = Math.max(rayBounds.maxX, x);
                    rayBounds.minY = Math.min(rayBounds.minY, y);
                    rayBounds.maxY = Math.max(rayBounds.maxY, y);
                    rayBounds.minZ = Math.min(rayBounds.minZ, z);
                    rayBounds.maxZ = Math.max(rayBounds.maxZ, z);
                }
            }
            
            if (object.material && object.material.color) {
                const colorHex = object.material.color.getHex();
                if (colorHex === 0xff0000) {
                    redRayObjectsInScene++;
                    
                    // 絞り端光線の座標を収集
                    if (object.userData.isEdgeRay) {
                        edgeRayCoords.push({
                            pupilX: object.userData.pupilCoord?.x,
                            pupilY: object.userData.pupilCoord?.y,
                            visible: object.visible,
                            opacity: object.material.opacity
                        });
                    }
                    
                    // 詳細確認（最初の5本）
                    if (redRayObjectsInScene <= 5) {
                        console.log(`🔍 [シーン検証] 赤色光線${redRayObjectsInScene}: 座標=${object.userData.pupilCoord?.x?.toFixed(3)},${object.userData.pupilCoord?.y?.toFixed(3)}, 可視=${object.visible}, 透明度=${object.material.opacity}`);
                    }
                }
            }
        }
    });
    
    console.log(`🔍 [シーン検証] シーン内光線オブジェクト: 総数=${totalRayObjectsInScene}本, 赤色=${redRayObjectsInScene}本`);
    console.log(`📏 [座標範囲] X: ${rayBounds.minX.toFixed(1)} 〜 ${rayBounds.maxX.toFixed(1)}mm`);
    console.log(`📏 [座標範囲] Y: ${rayBounds.minY.toFixed(1)} 〜 ${rayBounds.maxY.toFixed(1)}mm`);
    console.log(`📏 [座標範囲] Z: ${rayBounds.minZ.toFixed(1)} 〜 ${rayBounds.maxZ.toFixed(1)}mm`);
    console.log(`🎯 [絞り端光線] 合計: ${edgeRayCoords.length}本`);
    
    if (edgeRayCoords.length > 0) {
        console.log(`🎯 [絞り端座標] 最初の5本:`)
        edgeRayCoords.slice(0, 5).forEach((coord, i) => {
            console.log(`  ${i+1}: pupil(${coord.pupilX?.toFixed(3)}, ${coord.pupilY?.toFixed(3)}) 可視=${coord.visible} 透明度=${coord.opacity}`);
        });
    }
    
    // 🎯 **レンダリング強制実行**: 絞り端光線を確実に表示
    console.log('🔄 [描画強制] レンダリング更新を実行中...');
    if (window.renderer && window.camera) {
        // レンダラーの状態確認
        console.log(`🔍 [レンダラー] サイズ: ${window.renderer.domElement.width}x${window.renderer.domElement.height}, 可視: ${window.renderer.domElement.style.display !== 'none'}`);
        
        // カメラ位置の確認と調整
        if (window.camera) {
            console.log(`📹 [カメラ前] 位置: (${window.camera.position.x.toFixed(1)}, ${window.camera.position.y.toFixed(1)}, ${window.camera.position.z.toFixed(1)})`);
            
            // 🔧 **カメラ位置の調整**: 絞り端光線が見えるように
            // Y-Z断面表示の場合、X軸から離れてZ軸方向に配置
            const optimalCameraZ = Math.max(100, Math.abs(rayBounds.maxZ - rayBounds.minZ) * 2);
            const currentDistance = Math.sqrt(window.camera.position.x*window.camera.position.x + window.camera.position.z*window.camera.position.z);
            
            if (currentDistance < optimalCameraZ * 0.8) {
                console.log(`📹 [カメラ調整] 距離不足検出: 現在=${currentDistance.toFixed(1)}, 推奨=${optimalCameraZ.toFixed(1)}`);
                
                // カメラを適切な距離に移動
                window.camera.position.set(
                    optimalCameraZ * 0.7,  // 斜め横から見る
                    window.camera.position.y,  // Y位置は維持
                    optimalCameraZ * 0.7   // 斜め後ろから見る
                );
                
                // 光学系の中心を見る
                const centerY = (rayBounds.minY + rayBounds.maxY) / 2;
                const centerZ = (rayBounds.minZ + rayBounds.maxZ) / 2;
                window.camera.lookAt(0, centerY, centerZ);
                
                console.log(`📹 [カメラ調整後] 位置: (${window.camera.position.x.toFixed(1)}, ${window.camera.position.y.toFixed(1)}, ${window.camera.position.z.toFixed(1)})`);
                console.log(`📹 [カメラ調整後] 注視点: (0, ${centerY.toFixed(1)}, ${centerZ.toFixed(1)})`);
            }
        }
        
        // 強制レンダリング実行
        window.renderer.render(scene, window.camera);
        console.log('✅ [描画強制] レンダリング更新完了');
        
        // 絞り端光線が見える位置に調整（必要に応じて）
        const edgeRayBounds = calculateEdgeRayBounds(scene);
        if (edgeRayBounds.hasRays) {
            console.log(`🎯 [絞り端範囲] X: ${edgeRayBounds.minX.toFixed(1)}〜${edgeRayBounds.maxX.toFixed(1)}, Y: ${edgeRayBounds.minY.toFixed(1)}〜${edgeRayBounds.maxY.toFixed(1)}, Z: ${edgeRayBounds.minZ.toFixed(1)}〜${edgeRayBounds.maxZ.toFixed(1)}`);
        }
        
        // ちょっと待ってから再度レンダリング（描画遅延対策）
        setTimeout(() => {
            window.renderer.render(scene, window.camera);
            console.log('✅ [描画強制] 遅延レンダリング完了');
        }, 100);
    } else {
        console.warn('⚠️ [描画強制] レンダラーまたはカメラが見つかりません');
    }avefrontRay(ray.path, rayId, rayColor, scene, rayInfo);
            drawnCount++;
            
            // 🔧 **重複調査**: 色統計を追跡（修正版）
            const colorHex = rayColor.toString(16).padStart(6, '0'); // 6桁でパディング
            rayStats.colorDistribution[colorHex] = (rayStats.colorDistribution[colorHex] || 0) + 1;
            if (rayColor === 0xff0000) rayStats.redRays++; // 赤色カウント
            if ((rayColor & 0x0000ff) > (rayColor & 0xff0000)) rayStats.blueRays++; // 青系カウント
            
            if (index < 5) console.log(`✅ 光線${index}描画完了: 色=${colorHex}`);
        } catch (error) {表示
 * - ケラレ光線とOPD値による視覚化
 * - 既存のdrawCrossBeamRaysシステムとの統合
 * 
 * 作成日: 2025/07/26
 */

import * as THREE from 'https://unpkg.com/three@0.153.0/build/three.module.js';
import { drawRayWithSegmentColors } from './optical/ray-renderer.js';

function getThreeForScene(scene) {
    try {
        const t = scene?.userData?.renderContext?.three;
        if (t) return t;
    } catch (_) {}
    return THREE;
}

function getGlobalForScene(scene) {
    try {
        const g = scene?.userData?.renderContext?.global;
        if (g) return g;
    } catch (_) {}
    return typeof window !== 'undefined' ? window : globalThis;
}

function toFiniteNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function sanitizeRayPath(rayPath) {
    if (!Array.isArray(rayPath)) return [];
    const out = [];
    for (const p of rayPath) {
        if (!p || typeof p !== 'object') continue;
        const x = toFiniteNumber(p.x);
        const y = toFiniteNumber(p.y);
        const z = toFiniteNumber(p.z);
        if (x === null || y === null || z === null) continue;
        out.push({ x, y, z });
    }
    return out;
}

/**
 * 波面収差計算で生成された光線をキャンバスに描画
 * @param {Object} wavefrontData - 波面収差データ
 * @param {Object} options - 描画オプション
 */
export function drawWavefrontRays(wavefrontData, options = {}) {
    // (Removed) Draw/Clear OPD Rays feature.
    return;
    const {
        scene = window.scene,
        showVignetted = true,
        showValidOnly = false,
        colorMode = 'opd', // 'opd', 'vignetting', 'uniform'
        opdRange = null // {min, max} for OPD color mapping
    } = options;

    console.log('🎯 [WavefrontViz] drawWavefrontRays開始');
    console.log('🔍 シーン:', scene ? '存在' : 'なし');
    console.log('🔍 波面データ:', wavefrontData ? '存在' : 'なし');
    console.log('🔍 光線データ:', wavefrontData?.rayData ? `${wavefrontData.rayData.length}本` : 'なし');

    if (!scene) {
        console.error('❌ [WavefrontViz] 3Dシーンが見つかりません');
        return;
    }

    if (!wavefrontData || !wavefrontData.rayData) {
        console.warn('⚠️ [WavefrontViz] 波面収差データが無効です');
        return;
    }

    console.log('🎯 [WavefrontViz] 波面収差光線描画開始');
    console.log(`📊 [WavefrontViz] 光線データ: ${wavefrontData.rayData.length}本`);

    // 🔧 **重要修正**: drawWavefrontRays内でのクリアを無効化（外部でクリア済み）
    // clearWavefrontRays(scene); // ← コメントアウト: 重複クリアを防止

    // OPD値の範囲を計算（色分け用）
    const opdStats = calculateOPDStatistics(wavefrontData.rayData);
    const effectiveOPDRange = opdRange || opdStats.range;
    
    console.log(`📊 [WavefrontViz] OPD統計: min=${opdStats.range.min?.toFixed(4) || 'N/A'}, max=${opdStats.range.max?.toFixed(4) || 'N/A'}, 有効光線=${opdStats.validCount}/${opdStats.totalCount}`);

    let drawnCount = 0;
    let skippedCount = 0;

    // 🔧 **重複調査**: 描画される光線の統計を追跡
    const rayStats = {
        totalRays: wavefrontData.rayData.length,
        redRays: 0,
        blueRays: 0,
        colorDistribution: {}
    };

    // 各光線を描画
    wavefrontData.rayData.forEach((rayInfo, index) => {
        const { pupilX, pupilY, ray, opd, isVignetted } = rayInfo;
        
        // 最初の数本について詳細ログ
        if (index < 5 || index % 50 === 0) {
            console.log(`🔍 光線${index}: pupil(${pupilX?.toFixed(3)}, ${pupilY?.toFixed(3)}), ケラレ=${isVignetted}, OPD=${opd?.toFixed(6)}`);
            console.log(`🔍 光線${index} ray構造:`, {
                ray: ray !== null && ray !== undefined ? '存在' : 'なし',
                rayType: typeof ray,
                hasPath: ray?.path !== undefined,
                pathLength: ray?.path?.length || 'N/A',
                pathType: ray?.path ? typeof ray.path : 'N/A',
                isArray: Array.isArray(ray?.path)
            });
            
            // rayがnullでない場合、詳細を確認
            if (ray) {
                console.log(`🔍 光線${index} ray詳細:`, ray);
                if (ray.path && ray.path.length > 0) {
                    console.log(`🔍 光線${index} path最初の点:`, ray.path[0]);
                    console.log(`🔍 光線${index} path最後の点:`, ray.path[ray.path.length - 1]);
                }
            }
        }

        // 描画条件をチェック（各条件を個別にログ出力）
        if (isVignetted && !showVignetted) {
            if (index < 5) console.log(`🔍 光線${index}: ケラレによりスキップ（showVignetted=${showVignetted}）`);
            skippedCount++;
            return;
        }

        if (showValidOnly && (isVignetted || isNaN(opd))) {
            if (index < 5) console.log(`🔍 光線${index}: 有効性チェックによりスキップ（showValidOnly=${showValidOnly}, ケラレ=${isVignetted}, OPD=${opd}）`);
            skippedCount++;
            return;
        }

        if (!ray || !ray.path || ray.path.length === 0) {
            if (index < 5) console.log(`🔍 光線${index}: パスなしによりスキップ（ray=${!!ray}, path=${!!ray?.path}, length=${ray?.path?.length}）`);
            skippedCount++;
            return;
        }

        // ここまで到達した光線をログ
        if (index < 5) console.log(`✅ 光線${index}: 描画条件をクリア`);

        // 光線の色を決定
        const rayColor = determineRayColor(colorMode, rayInfo, effectiveOPDRange);

        // 光線IDを生成
        const rayId = `wavefront-ray-${index}-${pupilX.toFixed(3)}-${pupilY.toFixed(3)}`;

        try {
            // 光線を描画（既存システムを使用）
            const ok = drawSingleWavefrontRay(ray.path, rayId, rayColor, scene, rayInfo);
            if (!ok) {
                skippedCount++;
                return;
            }
            drawnCount++;
            
            // 🎯 統計情報の収集（絞り端光線を重点的に監視）
            const pupilRadius = Math.sqrt(pupilX * pupilX + pupilY * pupilY);
            
            // 色統計
            const colorHex = rayColor.toString(16).padStart(6, '0');
            rayStats.colorDistribution[colorHex] = (rayStats.colorDistribution[colorHex] || 0) + 1;
            
            // 色分類
            if (rayColor === 0xff0000 || rayColor === 0x800000) {
                rayStats.redRays++;
            } else if ((rayColor & 0x0000ff) > 0x80) {
                rayStats.blueRays++;
            }
            
            if (index < 5) console.log(`✅ 光線${index}: 描画成功`);
        } catch (error) {
            console.warn(`⚠️ [WavefrontViz] 光線${index}の描画エラー:`, error);
            skippedCount++;
        }
    });

    console.log(`✅ [WavefrontViz] 波面収差光線描画完了: 描画=${drawnCount}本, スキップ=${skippedCount}本`);
    
    // 🔧 **統計情報**: 色統計をログ出力（絞り端光線を重点監視）
    console.log(`� [統計] 総光線数: ${rayStats.totalRays}本, 実描画: ${drawnCount}本`);
    console.log(`🎯 [統計] 赤色光線: ${rayStats.redRays}本, 青系光線: ${rayStats.blueRays}本`);
    
    // 絞り端光線の統計（赤色のみ表示）
    const edgeRedCount = Object.entries(rayStats.colorDistribution)
        .filter(([color, count]) => color === 'ff0000' || color === '800000')
        .reduce((sum, [color, count]) => sum + count, 0);
    console.log(`🎯 [絞り端確認] 絞り端赤色光線: ${edgeRedCount}本`);
    
    // 色分布の詳細（上位5色のみ表示）
    const sortedColors = Object.entries(rayStats.colorDistribution)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5);
    console.log(`🎨 [色分布] 上位5色:`, sortedColors.map(([color, count]) => `#${color}(${count}本)`).join(', '));
}

/**
 * 単一の波面収差光線を描画
 * @param {Array} rayPath - 光線パス
 * @param {string} rayId - 光線ID
 * @param {number} rayColor - 光線色
 * @param {THREE.Scene} scene - Three.jsシーン
 * @param {Object} rayInfo - 光線情報
 */
function drawSingleWavefrontRay(rayPath, rayId, rayColor, scene, rayInfo) {
    const T = getThreeForScene(scene);
    // console.log(`🎨 光線描画: ${rayId}, 色=${rayColor.toString(16)}, パス点数=${rayPath.length}`);

    const sanitized = sanitizeRayPath(rayPath);
    if (sanitized.length < 2) {
        return false;
    }
    
    // Three.jsの線分オブジェクトを作成
    // Y-Z断面表示用の座標変換: (x, y, z) → (x, y, z) （変換なし）
    // IMPORTANT: Always use typed arrays for BufferGeometry attributes.
    // Some THREE builds will otherwise forward plain JS arrays to WebGL, causing:
    // THREE.WebGLAttributes: Unsupported buffer data format
    // IMPORTANT: create typed arrays in the SAME realm as the target renderer.
    // Popups have their own window/realm; some THREE builds validate typed arrays
    // via instanceof checks which fail across realms.
    const globalScope = getGlobalForScene(scene);
    const Float32ArrayCtor = globalScope?.Float32Array || Float32Array;
    const positions = new Float32ArrayCtor(sanitized.length * 3);
    for (let i = 0; i < sanitized.length; i++) {
        const p = sanitized[i];
        positions[i * 3 + 0] = p.x;
        positions[i * 3 + 1] = p.y;
        positions[i * 3 + 2] = p.z;
    }
    const geometry = new T.BufferGeometry();
    if (typeof T.Float32BufferAttribute === 'function') {
        geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    } else {
        geometry.setAttribute('position', new T.BufferAttribute(positions, 3));
    }
    
    // 線の材質を設定（全光線の太さを統一）
    const material = new T.LineBasicMaterial({
        color: rayColor,
        opacity: rayInfo.isVignetted ? 0.3 : 0.8, // 統一された透明度
        transparent: rayInfo.isVignetted,
        linewidth: rayInfo.isVignetted ? 1 : 2 // 全有効光線を同じ太さに統一
    });

    const line = new T.Line(geometry, material);
    
    line.userData = {
        type: 'wavefront-ray',
        rayId: rayId,
        pupilCoord: { x: rayInfo.pupilX, y: rayInfo.pupilY },
        opd: rayInfo.opd,
        isVignetted: rayInfo.isVignetted
    };

    // シーンに追加
    scene.add(line);
    
    // console.log(`✅ 光線追加完了: ${rayId}`);
    return true;
}

/**
 * 光線の色を決定
 * @param {string} colorMode - 色分けモード
 * @param {Object} rayInfo - 光線情報
 * @param {Object} opdRange - OPD範囲
 * @returns {number} 色値
 */
function determineRayColor(colorMode, rayInfo, opdRange) {
    const { opd, isVignetted, pupilX, pupilY } = rayInfo;

    // 絞り端光線の特別な色分けは削除（通常の色分けのみ）

    switch (colorMode) {
        case 'opd':
            if (isVignetted || isNaN(opd)) {
                return 0x808080; // グレー（無効光線）
            }
            return mapOPDToColor(opd, opdRange);

        case 'vignetting':
            return isVignetted ? 0xff0000 : 0x00ff00; // 赤=ケラレ、緑=有効

        case 'grid':
            // グリッド位置による色分け
            const gridColor = mapGridPositionToColor(pupilX, pupilY);
            return isVignetted ? 0x808080 : gridColor;

        case 'uniform':
        default:
            return isVignetted ? 0x808080 : 0x00ffff; // シアン（均一色）
    }
}

/**
 * OPD値を色にマッピング
 * @param {number} opd - OPD値
 * @param {Object} opdRange - OPD範囲 {min, max}
 * @returns {number} 色値
 */
function mapOPDToColor(opd, opdRange) {
    if (!opdRange || opdRange.min === opdRange.max) {
        return 0xffffff; // 白（範囲なし）
    }

    // OPD値を0-1に正規化
    const normalized = (opd - opdRange.min) / (opdRange.max - opdRange.min);
    const clamped = Math.max(0, Math.min(1, normalized));

    // 色相環で色分け（青→緑→黄→赤）
    const hue = (1 - clamped) * 240 / 360; // 240度（青）から0度（赤）へ
    const saturation = 1.0;
    const lightness = 0.5;

    return hslToHex(hue, saturation, lightness);
}

/**
 * グリッド位置を色にマッピング
 * @param {number} pupilX - 瞳X座標
 * @param {number} pupilY - 瞳Y座標
 * @returns {number} 色値
 */
function mapGridPositionToColor(pupilX, pupilY) {
    // 瞳座標を角度に変換して色相にマッピング
    const angle = Math.atan2(pupilY, pupilX);
    const normalizedAngle = (angle + Math.PI) / (2 * Math.PI); // 0-1に正規化
    
    return hslToHex(normalizedAngle, 0.8, 0.6);
}

/**
 * HSLからHEX色に変換
 * @param {number} h - 色相 (0-1)
 * @param {number} s - 彩度 (0-1)
 * @param {number} l - 明度 (0-1)
 * @returns {number} HEX色値
 */
function hslToHex(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h * 6) % 2 - 1));
    const m = l - c / 2;

    let r, g, b;
    const hueSegment = Math.floor(h * 6);

    switch (hueSegment) {
        case 0: [r, g, b] = [c, x, 0]; break;
        case 1: [r, g, b] = [x, c, 0]; break;
        case 2: [r, g, b] = [0, c, x]; break;
        case 3: [r, g, b] = [0, x, c]; break;
        case 4: [r, g, b] = [x, 0, c]; break;
        case 5: [r, g, b] = [c, 0, x]; break;
        default: [r, g, b] = [0, 0, 0]; break;
    }

    const toHex = (component) => Math.round((component + m) * 255);
    return (toHex(r) << 16) | (toHex(g) << 8) | toHex(b);
}

/**
 * 絞り端光線の描画範囲を計算
 * @param {THREE.Scene} scene - Three.jsシーン
 * @returns {Object} 絞り端光線の範囲情報
 */
function calculateEdgeRayBounds(scene) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let hasRays = false;

    scene.traverse((object) => {
        if (object.userData && 
            object.userData.type === 'wavefront-ray' && 
            object.userData.isEdgeRay &&
            object.material && 
            object.material.color.getHex() === 0xff0000) {
            
            hasRays = true;
            
            // Geometryの点を取得
            if (object.geometry && object.geometry.attributes && object.geometry.attributes.position) {
                const positions = object.geometry.attributes.position.array;
                for (let i = 0; i < positions.length; i += 3) {
                    const x = positions[i];
                    const y = positions[i + 1];
                    const z = positions[i + 2];
                    
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                    minY = Math.min(minY, y);
                    maxY = Math.max(maxY, y);
                    minZ = Math.min(minZ, z);
                    maxZ = Math.max(maxZ, z);
                }
            }
        }
    });

    return {
        hasRays,
        minX: hasRays ? minX : 0,
        maxX: hasRays ? maxX : 0,
        minY: hasRays ? minY : 0,
        maxY: hasRays ? maxY : 0,
        minZ: hasRays ? minZ : 0,
        maxZ: hasRays ? maxZ : 0
    };
}

/**
 * OPD統計情報を計算
 * @param {Array} rayData - 光線データ配列
 * @returns {Object} 統計情報
 */
function calculateOPDStatistics(rayData) {
    const validOPDs = rayData
        .filter(ray => !ray.isVignetted && !isNaN(ray.opd))
        .map(ray => ray.opd);

    if (validOPDs.length === 0) {
        return {
            range: { min: 0, max: 0 },
            validCount: 0,
            totalCount: rayData.length,
            mean: 0,
            std: 0
        };
    }

    const min = Math.min(...validOPDs);
    const max = Math.max(...validOPDs);
    const mean = validOPDs.reduce((sum, opd) => sum + opd, 0) / validOPDs.length;
    const variance = validOPDs.reduce((sum, opd) => sum + Math.pow(opd - mean, 2), 0) / validOPDs.length;
    const std = Math.sqrt(variance);

    return {
        range: { min, max },
        validCount: validOPDs.length,
        totalCount: rayData.length,
        mean,
        std
    };
}

/**
 * 既存の波面収差光線をシーンからクリア
 * @param {THREE.Scene} scene - Three.jsシーン
 */
export function clearWavefrontRays(scene) {
    // (Removed) Draw/Clear OPD Rays feature.
    return;
    console.log('🧹 [WavefrontViz] 光線クリア開始 - 包括的削除モード');

    const T = getThreeForScene(scene);
    
    const objectsToRemove = [];
    
    scene.traverse((object) => {
        // 波面収差関連のオブジェクトを特定（より包括的）
        if (object.userData && (
            object.userData.type === 'wavefront-ray' ||
            object.userData.type === 'cross-beam-ray' ||
            object.userData.type === 'optical-ray' ||
            object.userData.type === 'edge-ray-marker' ||  // 絞り端マーカー球体も削除
            object.userData.rayType === 'crossBeam' ||
            object.userData.rayType === 'wavefront' ||
            (object.userData.rayId && (
                object.userData.rayId.includes('wavefront') ||
                object.userData.rayId.includes('cross') ||
                object.userData.rayId.includes('opd')
            ))
        )) {
            objectsToRemove.push(object);
        }
        
        // 光線系のThree.js Lineオブジェクトもクリア（色ベース）
        if (object instanceof T.Line && object.material && object.material.color) {
            const colorHex = object.material.color.getHex();
            if (colorHex === 0xff0000 ||  // 赤（Cross）
                colorHex === 0x0000ff ||  // 青（OPD）
                colorHex === 0x00ffff ||  // シアン
                colorHex === 0xff00ff ||  // マゼンタ
                colorHex === 0xffff00) {  // 黄色
                objectsToRemove.push(object);
            }
        }
        
        // 絞り端マーカー球体もクリア
        if (object instanceof T.Mesh && object.material && object.material.color) {
            const colorHex = object.material.color.getHex();
            if (colorHex === 0xff0000 || colorHex === 0xff4444) {  // 赤系マーカー
                objectsToRemove.push(object);
            }
        }
    });
    
    console.log(`🧹 [WavefrontViz] 削除対象: ${objectsToRemove.length}個のオブジェクト`);

    objectsToRemove.forEach((object, index) => {
        scene.remove(object);
        
        // リソース解放
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
            if (Array.isArray(object.material)) {
                object.material.forEach(material => material.dispose());
            } else {
                object.material.dispose();
            }
        }
        
        if (index < 5) { // 最初の5個をログ出力
            console.log(`  削除${index + 1}: ${object.userData?.type || 'Line'} (color: ${object.material?.color?.getHex()?.toString(16) || 'unknown'})`);
        }
    });

    console.log(`✅ [WavefrontViz] 光線クリア完了: ${objectsToRemove.length}個削除`);
    
    // 強制レンダリング更新
    const globalScope = getGlobalForScene(scene);
    const renderer = globalScope?.renderer;
    const camera = globalScope?.camera;
    if (renderer && camera && typeof renderer.render === 'function') {
        renderer.render(scene, camera);
    }
}

/**
 * 波面収差光線の表示/非表示を切り替え
 * @param {THREE.Scene} scene - Three.jsシーン
 * @param {boolean} visible - 表示フラグ
 */
export function toggleWavefrontRaysVisibility(scene, visible) {
    scene.traverse((object) => {
        if (object.userData && object.userData.type === 'wavefront-ray') {
            object.visible = visible;
        }
    });
    
    console.log(`👁️ [WavefrontViz] 波面収差光線の表示: ${visible ? 'ON' : 'OFF'}`);
}

/**
 * 特定のOPD範囲の光線のみを表示
 * @param {THREE.Scene} scene - Three.jsシーン
 * @param {Object} opdRange - 表示するOPD範囲 {min, max}
 */
export function filterWavefrontRaysByOPD(scene, opdRange) {
    let visibleCount = 0;
    let hiddenCount = 0;

    scene.traverse((object) => {
        if (object.userData && object.userData.type === 'wavefront-ray') {
            const opd = object.userData.opd;
            const shouldShow = !isNaN(opd) && opd >= opdRange.min && opd <= opdRange.max;
            
            object.visible = shouldShow;
            if (shouldShow) {
                visibleCount++;
            } else {
                hiddenCount++;
            }
        }
    });

    console.log(`🔍 [WavefrontViz] OPDフィルタ適用: 表示=${visibleCount}本, 非表示=${hiddenCount}本`);
}

/**
 * 波面収差光線描画システムを初期化
 * @param {Object} options - 初期化オプション
 */
export function initializeWavefrontVisualization(options = {}) {
    // (Removed) Draw/Clear OPD Rays feature.
    // Intentionally left as a no-op.
}
