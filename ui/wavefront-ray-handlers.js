/**
 * (Removed) Draw/Clear OPD Rays feature.
 * Kept as a no-op stub to avoid stale imports crashing.
 */

export function setupWavefrontRayButtons() {
    // no-op
}
        
        console.log(`📊 生成された光線データ: ${wavefrontMap.rayData.length}本`);
        
        // 🔍 光線データ構造の詳細デバッグ
        if (wavefrontMap.rayData.length > 0) {
            const firstRay = wavefrontMap.rayData[0];
            console.log(`🔍 最初の光線データ構造:`, firstRay);
            console.log(`🔍 光線データのキー:`, Object.keys(firstRay));
            if (firstRay.ray) {
                console.log(`🔍 ray プロパティ:`, typeof firstRay.ray, firstRay.ray);
                console.log(`🔍 ray のキー:`, Object.keys(firstRay.ray));
                if (firstRay.ray.path) {
                    console.log(`🔍 ray.path:`, Array.isArray(firstRay.ray.path), firstRay.ray.path?.length);
                }
            }
        }
        
        // 光線データの詳細をチェック（改善されたフィルタリング）
        const validRays = wavefrontMap.rayData.filter(r => {
            // 複数の光線データ構造に対応
            if (r.ray) {
                if (Array.isArray(r.ray)) {
                    return r.ray.length > 0;
                } else if (r.ray.path && Array.isArray(r.ray.path)) {
                    return r.ray.path.length > 0;
                } else if (typeof r.ray === 'object' && Object.keys(r.ray).length > 0) {
                    return true;
                }
            }
            return false;
        });
        
        const vignettedRays = wavefrontMap.rayData.filter(r => r.isVignetted);
        console.log(`🔍 有効光線: ${validRays.length}本, ケラレ光線: ${vignettedRays.length}本`);
        
        if (validRays.length === 0) {
            console.warn('⚠️ 有効な光線データがありません');
            alert('有効な光線データがありません。光学系設定を確認してください。');
            return;
        }
        
        // 描画オプションを設定
        console.log('🔍 3Dシーン確認:', targetScene ? '存在' : '未定義', {
            usingPopup: !!(window.popup3DWindow && !window.popup3DWindow.closed && window.popup3DWindow.scene)
        });
        const drawOptions = {
            scene: targetScene,
            showVignetted: true,
            colorMode: 'opd', // OPD値による色分け
            opdRange: null // 自動範囲設定
        };
        
        // 🔧 **重要修正**: 描画前に既存光線を完全クリア
        console.log('🧹 描画前クリア: 既存の全光線を削除中...');
        if (!targetScene) {
            console.error('❌ 3Dシーンが見つかりません（Renderポップアップを開いてください）');
            alert('3D描画シーンが見つかりません。先に Render を開いてください。');
            return;
        }
        clearWavefrontRays(targetScene);
        
        // 光線を描画
        console.log('🎨 光線描画開始...');
        drawWavefrontRays(wavefrontMap, drawOptions);
        
        // 統計情報を表示
        displayWavefrontRayStats(wavefrontMap);
        
        console.log('✅ 波面収差光線描画完了');
        alert(`波面収差光線を描画しました。\n光線数: ${wavefrontMap.rayData.length}本\n有効光線: ${validRays.length}本`);
        
    } catch (error) {
        console.error('❌ 波面収差光線描画エラー:', error);
        alert(`波面収差光線描画エラー: ${error.message}`);
    }
}

/**
 * Handle clearing wavefront rays
 */
function handleClearWavefrontRays() {
    try {
        console.log('🧹 波面収差光線クリア処理開始');

        let clearedAny = false;
        try {
            const popup = window.popup3DWindow;
            if (popup && !popup.closed && popup.scene) {
                clearWavefrontRays(popup.scene);
                clearedAny = true;
            }
        } catch (_) {}

        if (window.scene) {
            clearWavefrontRays(window.scene);
            clearedAny = true;
        }

        if (clearedAny) {
            console.log('✅ 波面収差光線クリア完了');
        } else {
            console.warn('⚠️ 3Dシーンが見つかりません');
        }
        
    } catch (error) {
        console.error('❌ 波面収差光線クリアエラー:', error);
    }
}

/**
 * Get current field setting for wavefront analysis
 * @returns {Object} Current field setting
 */
function getCurrentFieldSetting() {
    try {
        // 🔍 まずObjectデータ全体を確認
        const objectRows = window.getObjectRows ? window.getObjectRows() : [];
        console.log('🔍 利用可能なObjectデータ:', objectRows);
        
        // Object選択ドロップダウンからObjectインデックスを取得
        const objectSelect = document.getElementById('wavefront-object-select');
        const selectedObjectIndex = objectSelect ? parseInt(objectSelect.value) : 0;
        
        console.log(`🔍 選択されたObjectインデックス: ${selectedObjectIndex}`);
        console.log(`🔍 選択ドロップダウン存在: ${!!objectSelect}`);
        if (objectSelect) {
            console.log(`🔍 ドロップダウン値: ${objectSelect.value}`);
            console.log(`🔍 ドロップダウンオプション数: ${objectSelect.options.length}`);
        }
        
        // Objectデータを取得
        if (!objectRows || objectRows.length === 0) {
            console.warn('⚠️ Objectデータが見つかりません、軸上設定を使用');
            return {
                fieldAngle: { x: 0, y: 0 },
                xHeight: 0,
                yHeight: 0,
                displayName: 'On-Axis (Default)'
            };
        }
        
        // 選択されたObjectのデータを取得
        const selectedObject = objectRows[selectedObjectIndex] || objectRows[0];
        console.log(`🔍 選択されたObjectデータ:`, selectedObject);
        
        // オブジェクトデータの実際の構造に合わせて処理
        if (selectedObject.position === 'Angle') {
            // 角度タイプの場合
            const fieldAngle = {
                x: parseFloat(selectedObject.xHeightAngle || 0),
                y: parseFloat(selectedObject.yHeightAngle || 0)
            };
            
            console.log(`🔍 角度タイプObject処理: X=${fieldAngle.x}°, Y=${fieldAngle.y}°`);
            
            return {
                fieldAngle: fieldAngle,
                fieldType: 'Angle',
                displayName: `Object ${selectedObjectIndex + 1} - ${fieldAngle.x}°, ${fieldAngle.y}°`
            };
        } else {
            // 高さタイプの場合
            const height = {
                x: parseFloat(selectedObject.xHeightAngle || 0),
                y: parseFloat(selectedObject.yHeightAngle || 0)
            };
            
            return {
                xHeight: height.x,
                yHeight: height.y,
                fieldType: 'Rectangle',
                displayName: `Object ${selectedObjectIndex + 1} - ${height.x}mm, ${height.y}mm`
            };
        }
        
    } catch (error) {
        console.error('❌ フィールド設定取得エラー:', error);
        return {
            fieldAngle: { x: 0, y: 0 },
            xHeight: 0,
            yHeight: 0,
            displayName: 'On-Axis (Error Fallback)'
        };
    }
}

/**
 * Display wavefront ray statistics
 * @param {Object} wavefrontMap - Wavefront map data
 */
function displayWavefrontRayStats(wavefrontMap) {
    try {
        const statsContainer = document.getElementById('wavefront-container-stats');
        if (!statsContainer) return;
        
        const totalRays = wavefrontMap.rayData.length;
        const validRays = wavefrontMap.rayData.filter(r => !r.isVignetted).length;
        const vignettedRays = totalRays - validRays;
        
        const validOPDs = wavefrontMap.rayData
            .filter(r => !r.isVignetted && !isNaN(r.opd))
            .map(r => r.opd);
        
        const opdStats = validOPDs.length > 0 ? {
            min: Math.min(...validOPDs),
            max: Math.max(...validOPDs),
            mean: validOPDs.reduce((sum, opd) => sum + opd, 0) / validOPDs.length
        } : { min: 0, max: 0, mean: 0 };
        
        statsContainer.innerHTML = `
            <div class="wavefront-stats">
                <h4>🎯 OPD光線統計</h4>
                <p><strong>総光線数:</strong> ${totalRays}本</p>
                <p><strong>有効光線:</strong> ${validRays}本 (${(validRays/totalRays*100).toFixed(1)}%)</p>
                <p><strong>ケラレ光線:</strong> ${vignettedRays}本 (${(vignettedRays/totalRays*100).toFixed(1)}%)</p>
                <p><strong>OPD範囲:</strong> ${opdStats.min.toFixed(4)} ~ ${opdStats.max.toFixed(4)} μm</p>
                <p><strong>OPD平均:</strong> ${opdStats.mean.toFixed(4)} μm</p>
                <p><strong>グリッドサイズ:</strong> ${wavefrontMap.gridSize}×${wavefrontMap.gridSize}</p>
            </div>
        `;
        
    } catch (error) {
        console.error('❌ 統計表示エラー:', error);
    }
}

/**
 * Apply aperture vignetting to existing wavefront map with best-effort marginal rays
 * @param {Object} baseWavefrontMap - Base wavefront map
 * @param {Array} opticalSystemRows - Optical system data
 * @returns {Object} Wavefront map with aperture vignetting applied
 */
async function applyApertureVignetting(baseWavefrontMap, opticalSystemRows) {
    console.log(`🌊 絞り考慮（ベストエフォート周辺光線）適用開始`);
    
    try {
        // Stop面を検索
        const stopSurface = findStopSurface(opticalSystemRows);
        if (!stopSurface) {
            console.warn('⚠️ Stop面が見つかりません。元のマップをそのまま使用');
            return baseWavefrontMap;
        }

        // 絞りサイズを取得
        let apertureRadius = 5; // デフォルト値
        try {
            if (stopSurface && stopSurface.semidia) {
                apertureRadius = parseFloat(stopSurface.semidia);
            } else if (stopSurface && stopSurface.diameter) {
                apertureRadius = parseFloat(stopSurface.diameter) / 2;
            } else {
                const maxRadius = Math.max(...opticalSystemRows.map(row => 
                    Math.abs(parseFloat(row.semidia) || parseFloat(row.diameter) / 2 || 0)
                ).filter(r => r > 0));
                if (maxRadius > 0) {
                    apertureRadius = maxRadius * 0.95;
                }
            }
        } catch (error) {
            console.warn(`⚠️ 絞り半径推定エラー: ${error.message}, デフォルト値使用`);
        }
        
        console.log(`📍 絞り半径: ${apertureRadius}mm`);
        
        // 🆕 ベストエフォート周辺光線を一時的に無効化（光学系互換性問題のため）
        console.log(`⚠️ ベストエフォート周辺光線処理をスキップします`);
        const enhancedWavefrontMap = baseWavefrontMap; // addBestEffortMarginalRays をスキップ
        
        // 基本的な瞳座標制限を適用（大幅に緩和）
        const vignettedMap = {
            ...enhancedWavefrontMap,
            rayData: enhancedWavefrontMap.rayData.map(rayData => {
                // 瞳半径をチェック
                const pupilRadius = Math.sqrt(rayData.pupilX * rayData.pupilX + rayData.pupilY * rayData.pupilY);
                
                // 🆕 大幅に緩和された制限
                let apertureLimit;
                if (rayData.isBestEffortMarginal) {
                    apertureLimit = 2.0; // ベストエフォート周辺光線は瞳座標2.0まで許可
                } else {
                    apertureLimit = 2.0; // 🆕 通常光線も2.0まで許可（波面収差計算と一致）
                }
                
                const isOutsideAperture = pupilRadius > apertureLimit;
                
                if (isOutsideAperture) {
                    // 瞳座標制限のログを削減（重要なケースのみ）
                    if (pupilRadius > 2.5) {
                        console.log(`🔍 瞳座標制限適用: pupilRadius=${pupilRadius.toFixed(3)} > limit=${apertureLimit.toFixed(1)} (${rayData.isBestEffortMarginal ? 'ベストエフォート' : '通常'})`);
                    }
                }
                
                if (isOutsideAperture) {
                    // 絞り外の光線をビネッティング扱いに
                    return {
                        ...rayData,
                        isVignetted: true,
                        opd: NaN,
                        wavefrontAberration: NaN
                    };
                } else {
                    // 絞り内の光線はそのまま
                    return rayData;
                }
            })
        };
        
        // 統計を再計算
        const validRayData = vignettedMap.rayData.filter(r => !r.isVignetted);
        const validOPDs = validRayData.map(r => r.opd).filter(opd => !isNaN(opd));
        const validWavelengthAberrations = validRayData.map(r => r.wavefrontAberration).filter(wa => !isNaN(wa));
        
        vignettedMap.pupilCoordinates = validRayData.map(r => ({ 
            x: r.pupilX, 
            y: r.pupilY, 
            r: Math.sqrt(r.pupilX * r.pupilX + r.pupilY * r.pupilY) 
        }));
        vignettedMap.opds = validOPDs;
        vignettedMap.wavefrontAberrations = validWavelengthAberrations;
        
        const originalValid = baseWavefrontMap.rayData.filter(r => !r.isVignetted).length;
        const afterValid = validRayData.length;
        const bestEffortCount = vignettedMap.rayData.filter(r => r.isBestEffortMarginal && !r.isVignetted).length;
        
        console.log(`📊 絞りビネッティング適用結果: ${originalValid}本 → ${afterValid}本（ベストエフォート: ${bestEffortCount}本）`);
        
        return vignettedMap;
        
    } catch (error) {
        console.error('❌ 絞りビネッティング適用エラー:', error);
        console.warn('⚠️ 元のマップをそのまま使用');
        return baseWavefrontMap;
    }
}

/**
 * Add best-effort marginal rays using Brent method results
 * @param {Object} baseWavefrontMap - Base wavefront map
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} apertureRadius - Aperture radius
 * @returns {Object} Enhanced wavefront map with best-effort marginal rays
 */
async function addBestEffortMarginalRays(baseWavefrontMap, opticalSystemRows, apertureRadius) {
    console.log(`🎯 ベストエフォート周辺光線生成開始`);
    
    try {
        // 現在のフィールド設定を取得
        const fieldSetting = getCurrentFieldSetting();
        
        // Object位置を計算
        let objectPos;
        if (fieldSetting.fieldType === 'Angle' && fieldSetting.fieldAngle) {
            // 角度モードの場合、Object距離から高さを計算
            const objectDistance = -Math.abs(parseFloat(opticalSystemRows[0].thickness) || 100);
            objectPos = {
                x: objectDistance * Math.tan(fieldSetting.fieldAngle.x * Math.PI / 180),
                y: objectDistance * Math.tan(fieldSetting.fieldAngle.y * Math.PI / 180),
                z: 0
            };
        } else {
            // 高さモード
            objectPos = {
                x: fieldSetting.xHeight || 0,
                y: fieldSetting.yHeight || 0,
                z: 0
            };
        }
        
        console.log(`📍 Object位置: (${objectPos.x.toFixed(3)}, ${objectPos.y.toFixed(3)}, ${objectPos.z})`);
        
        // Stop面情報
        const stopSurface = findStopSurface(opticalSystemRows);
        const stopSurfaceIndex = stopSurface.index;
        const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
        let stopZ;
        
        if (surfaceOrigins && surfaceOrigins[stopSurfaceIndex] && surfaceOrigins[stopSurfaceIndex].origin) {
            stopZ = surfaceOrigins[stopSurfaceIndex].origin.z;
        } else {
            stopZ = 0;
            for (let i = 0; i < stopSurfaceIndex; i++) {
                const thickness = parseFloat(opticalSystemRows[i].thickness) || 0;
                stopZ += thickness;
            }
        }
        
        const stopCenter = { x: 0, y: 0, z: stopZ };
        console.log(`📍 Stop面中心: (${stopCenter.x}, ${stopCenter.y}, ${stopCenter.z})`);
        
        // 🆕 拡張された周辺光線を生成（より多くの方向・半径で）
        const expandedRadius = apertureRadius * 1.2; // 20%拡大
        const marginalDirections = [
            // 4方向の基本
            { name: 'right', targetOffset: { x: expandedRadius, y: 0 } },
            { name: 'left', targetOffset: { x: -expandedRadius, y: 0 } },
            { name: 'top', targetOffset: { x: 0, y: expandedRadius } },
            { name: 'bottom', targetOffset: { x: 0, y: -expandedRadius } },
            // 対角線方向も追加
            { name: 'top-right', targetOffset: { x: expandedRadius * 0.707, y: expandedRadius * 0.707 } },
            { name: 'top-left', targetOffset: { x: -expandedRadius * 0.707, y: expandedRadius * 0.707 } },
            { name: 'bottom-right', targetOffset: { x: expandedRadius * 0.707, y: -expandedRadius * 0.707 } },
            { name: 'bottom-left', targetOffset: { x: -expandedRadius * 0.707, y: -expandedRadius * 0.707 } }
        ];
        
        console.log(`🔍 拡張周辺光線: 基準半径${apertureRadius.toFixed(3)}mm → 拡張半径${expandedRadius.toFixed(3)}mm`);
        
        const bestEffortRays = [];
        
        for (const direction of marginalDirections) {
            const targetPoint = {
                x: stopCenter.x + direction.targetOffset.x,
                y: stopCenter.y + direction.targetOffset.y,
                z: stopZ
            };
            
            console.log(`🎯 ${direction.name}方向周辺光線生成: 目標 (${targetPoint.x.toFixed(3)}, ${targetPoint.y.toFixed(3)})`);
            
            // ベストエフォート光線方向を計算
            const bestEffortResult = findBestEffortMarginalRayDirection(objectPos, targetPoint, opticalSystemRows);
            
            // 🆕 エラー判定を緩和（70%以内なら採用）
            if (bestEffortResult.success || bestEffortResult.bestError < apertureRadius * 0.7) {
                const rayDirection = bestEffortResult.direction;
                const initialRay = {
                    pos: { x: objectPos.x, y: objectPos.y, z: objectPos.z },
                    dir: rayDirection
                };
                
                try {
                    const tracedPath = traceRay(opticalSystemRows, initialRay, 1.0);
                    
                    if (tracedPath && tracedPath.length > 1) {
                        // 瞳座標を計算（拡張半径から逆算）
                        const pupilX = direction.targetOffset.x / expandedRadius;
                        const pupilY = direction.targetOffset.y / expandedRadius;
                        
                        console.log(`  ✅ ${direction.name}: 瞳座標(${pupilX.toFixed(3)}, ${pupilY.toFixed(3)}), エラー=${bestEffortResult.bestError.toFixed(6)}mm, 拡張半径=${expandedRadius.toFixed(3)}mm`);
                        
                        bestEffortRays.push({
                            pupilX: pupilX,
                            pupilY: pupilY,
                            opd: null, // 後で計算
                            wavefrontAberration: null, // 後で計算
                            isVignetted: false,
                            ray: { path: tracedPath },
                            isBestEffortMarginal: true,
                            marginalDirection: direction.name,
                            targetError: bestEffortResult.bestError,
                            gridIndex: -1 // 特別なインデックス
                        });
                    } else {
                        console.warn(`  ⚠️ ${direction.name}: 光線追跡失敗`);
                    }
                } catch (error) {
                    console.warn(`  ⚠️ ${direction.name}: 光線追跡エラー: ${error.message}`);
                }
            } else {
                console.warn(`  ❌ ${direction.name}: エラーが大きすぎる (${bestEffortResult.bestError.toFixed(6)}mm > ${(apertureRadius * 0.7).toFixed(6)}mm)`);
            }
        }
        
        console.log(`📊 ベストエフォート周辺光線: ${bestEffortRays.length}/8方向 成功`);
        
        // 🆕 全ての周辺光線が失敗した場合のフォールバック処理
        if (bestEffortRays.length === 0) {
            console.warn(`⚠️ 全ての周辺光線最適化が失敗しました。簡易周辺光線を生成します。`);
            
            // 簡易周辺光線: 主光線と同じ方向で、わずかに位置をオフセット
            const simpleDirections = [
                { name: 'center-offset-1', x: 0.3, y: 0.0 },
                { name: 'center-offset-2', x: -0.3, y: 0.0 },
                { name: 'center-offset-3', x: 0.0, y: 0.3 },
                { name: 'center-offset-4', x: 0.0, y: -0.3 }
            ];
            
            for (const offset of simpleDirections) {
                try {
                    const fieldSetting = baseWavefrontMap.fieldSetting;
                    
                    // わずかにオフセットした瞳座標で光線を生成
                    const offsetPupilX = offset.x;
                    const offsetPupilY = offset.y;
                    
                    // eva-wavefront.js の generateMarginalRay を使用
                    if (window.lastWavefrontAnalyzer) {
                        const marginalRay = window.lastWavefrontAnalyzer.opdCalculator.generateMarginalRay(
                            offsetPupilX, offsetPupilY, fieldSetting
                        );
                        
                        if (marginalRay && marginalRay.length > 1) {
                            console.log(`  ✅ ${offset.name}: 簡易周辺光線生成成功`);
                            bestEffortRays.push({
                                pupilX: offsetPupilX,
                                pupilY: offsetPupilY,
                                opd: 0, // 仮のOPD値
                                wavefrontAberration: 0,
                                isVignetted: false,
                                ray: { path: marginalRay },
                                isBestEffortMarginal: true,
                                gridIndex: -1
                            });
                        }
                    }
                } catch (error) {
                    console.warn(`  ⚠️ ${offset.name}: 簡易周辺光線生成失敗: ${error.message}`);
                }
            }
            
            console.log(`📊 簡易周辺光線生成結果: ${bestEffortRays.length}本`);
        }
        
        // 既存の光線データに追加
        const enhancedWavefrontMap = {
            ...baseWavefrontMap,
            rayData: [...baseWavefrontMap.rayData, ...bestEffortRays]
        };
        
        return enhancedWavefrontMap;
        
    } catch (error) {
        console.error('❌ ベストエフォート周辺光線生成エラー:', error);
        return baseWavefrontMap;
    }
}

/**
 * Find best-effort marginal ray direction using advanced Brent method
 * @param {Object} objectPos - Object position
 * @param {Object} targetPoint - Target point on stop surface  
 * @param {Array} opticalSystemRows - Optical system data
 * @returns {Object} Result with direction and error
 */
function findBestEffortMarginalRayDirection(objectPos, targetPoint, opticalSystemRows) {
    console.log(`🎯 高精度Brent法による周辺光線最適化開始`);
    
    // 初期方向ベクトル（Object → Target）
    const dx = targetPoint.x - objectPos.x;
    const dy = targetPoint.y - objectPos.y;
    const dz = targetPoint.z - objectPos.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    const baseDirection = {
        i: dx / distance,
        j: dy / distance,
        k: dz / distance
    };
    
    console.log(`📍 基準方向: (${baseDirection.i.toFixed(6)}, ${baseDirection.j.toFixed(6)}, ${baseDirection.k.toFixed(6)})`);
    
    let bestDirection = { ...baseDirection };
    let bestError = Number.MAX_VALUE;
    let success = false;
    
    try {
        // Stop面インデックスを取得
        const stopSurface = findStopSurface(opticalSystemRows);
        const stopIndex = stopSurface.index;
        
        console.log(`📍 Stop面インデックス: ${stopIndex}`);
        
        // X方向とY方向を独立に最適化する（gen-ray-cross-infinite.jsの手法）
        const tolerance = 1e-6;
        const maxIterations = 50;
        
        // X方向の最適化用目的関数
        const objectiveFunctionX = (deltaAngleX) => {
            try {
                // 角度調整を適用した方向ベクトル
                const adjustedDirection = {
                    i: baseDirection.i + deltaAngleX,
                    j: baseDirection.j,
                    k: baseDirection.k
                };
                
                // 正規化
                const norm = Math.sqrt(adjustedDirection.i * adjustedDirection.i + 
                                     adjustedDirection.j * adjustedDirection.j + 
                                     adjustedDirection.k * adjustedDirection.k);
                adjustedDirection.i /= norm;
                adjustedDirection.j /= norm;
                adjustedDirection.k /= norm;
                
                const testRay = {
                    pos: { x: objectPos.x, y: objectPos.y, z: objectPos.z },
                    dir: adjustedDirection
                };
                
                const tracedPath = traceRay(opticalSystemRows, testRay, 1.0);
                
                if (tracedPath && tracedPath.length > stopIndex) {
                    const stopPoint = tracedPath[stopIndex];
                    return stopPoint.x - targetPoint.x; // X方向の誤差
                } else {
                    return 1000; // 光線追跡失敗時は大きな値を返す
                }
            } catch (error) {
                return 1000;
            }
        };
        
        // Y方向の最適化用目的関数  
        const objectiveFunctionY = (deltaAngleY) => {
            try {
                // 角度調整を適用した方向ベクトル
                const adjustedDirection = {
                    i: baseDirection.i,
                    j: baseDirection.j + deltaAngleY,
                    k: baseDirection.k
                };
                
                // 正規化
                const norm = Math.sqrt(adjustedDirection.i * adjustedDirection.i + 
                                     adjustedDirection.j * adjustedDirection.j + 
                                     adjustedDirection.k * adjustedDirection.k);
                adjustedDirection.i /= norm;
                adjustedDirection.j /= norm;
                adjustedDirection.k /= norm;
                
                const testRay = {
                    pos: { x: objectPos.x, y: objectPos.y, z: objectPos.z },
                    dir: adjustedDirection
                };
                
                const tracedPath = traceRay(opticalSystemRows, testRay, 1.0);
                
                if (tracedPath && tracedPath.length > stopIndex) {
                    const stopPoint = tracedPath[stopIndex];
                    return stopPoint.y - targetPoint.y; // Y方向の誤差
                } else {
                    return 1000; // 光線追跡失敗時は大きな値を返す
                }
            } catch (error) {
                return 1000;
            }
        };
        
        let optimalDeltaX = 0;
        let optimalDeltaY = 0;
        
        // 🎯 高精度Brent法でX方向を最適化
        if (brentMethod && typeof brentMethod === 'function') {
            console.log(`🔍 Brent法によるX方向最適化開始`);
            
            try {
                // 符号変化区間を探索（gen-ray-cross-infinite.jsと同じ手法）
                const searchRange = 0.1; // 探索範囲
                let aX = -searchRange, bX = searchRange;
                
                // 符号変化区間の確認と調整
                let faX = objectiveFunctionX(aX);
                let fbX = objectiveFunctionX(bX);
                
                if (faX * fbX >= 0) {
                    // 符号変化区間が見つからない場合は近似最適値を探索
                    let minError = Number.MAX_VALUE;
                    let bestDelta = 0;
                    
                    for (let delta = -searchRange; delta <= searchRange; delta += searchRange / 20) {
                        const error = Math.abs(objectiveFunctionX(delta));
                        if (error < minError) {
                            minError = error;
                            bestDelta = delta;
                        }
                    }
                    optimalDeltaX = bestDelta;
                    console.log(`⚠️ [Brent] X方向：符号変化区間が見つからず、近似値使用: ${optimalDeltaX.toFixed(6)}`);
                } else {
                    optimalDeltaX = brentMethod(objectiveFunctionX, aX, bX, tolerance, maxIterations);
                    console.log(`✅ [Brent] X方向最適化完了: ${optimalDeltaX.toFixed(6)}`);
                }
            } catch (error) {
                console.warn(`⚠️ [Brent] X方向最適化失敗: ${error.message}, フォールバック値使用`);
                optimalDeltaX = 0;
            }
            
            // 🎯 高精度Brent法でY方向を最適化
            console.log(`🔍 Brent法によるY方向最適化開始`);
            
            try {
                const searchRange = 0.1;
                let aY = -searchRange, bY = searchRange;
                
                let faY = objectiveFunctionY(aY);
                let fbY = objectiveFunctionY(bY);
                
                if (faY * fbY >= 0) {
                    // 符号変化区間が見つからない場合は近似最適値を探索
                    let minError = Number.MAX_VALUE;
                    let bestDelta = 0;
                    
                    for (let delta = -searchRange; delta <= searchRange; delta += searchRange / 20) {
                        const error = Math.abs(objectiveFunctionY(delta));
                        if (error < minError) {
                            minError = error;
                            bestDelta = delta;
                        }
                    }
                    optimalDeltaY = bestDelta;
                    console.log(`⚠️ [Brent] Y方向：符号変化区間が見つからず、近似値使用: ${optimalDeltaY.toFixed(6)}`);
                } else {
                    optimalDeltaY = brentMethod(objectiveFunctionY, aY, bY, tolerance, maxIterations);
                    console.log(`✅ [Brent] Y方向最適化完了: ${optimalDeltaY.toFixed(6)}`);
                }
            } catch (error) {
                console.warn(`⚠️ [Brent] Y方向最適化失敗: ${error.message}, フォールバック値使用`);
                optimalDeltaY = 0;
            }
        } else {
            console.warn(`⚠️ Brent法が利用できません。基本最適化を使用`);
            
            // フォールバック：基本的な最適化
            const iterations = 20;
            const adjustment = 0.01;
            
            for (let i = 0; i < iterations; i++) {
                const errorX = objectiveFunctionX(optimalDeltaX);
                const errorY = objectiveFunctionY(optimalDeltaY);
                
                optimalDeltaX -= adjustment * errorX / (i + 1);
                optimalDeltaY -= adjustment * errorY / (i + 1);
                
                const totalError = Math.sqrt(errorX * errorX + errorY * errorY);
                if (totalError < tolerance) {
                    success = true;
                    break;
                }
            }
        }
        
        // 最適化された方向ベクトルを計算
        bestDirection = {
            i: baseDirection.i + optimalDeltaX,
            j: baseDirection.j + optimalDeltaY,
            k: baseDirection.k
        };
        
        // 正規化
        const norm = Math.sqrt(bestDirection.i * bestDirection.i + 
                             bestDirection.j * bestDirection.j + 
                             bestDirection.k * bestDirection.k);
        bestDirection.i /= norm;
        bestDirection.j /= norm;
        bestDirection.k /= norm;
        
        // 最終誤差を計算
        const finalRay = {
            pos: { x: objectPos.x, y: objectPos.y, z: objectPos.z },
            dir: bestDirection
        };
        
        const finalPath = traceRay(opticalSystemRows, finalRay, 1.0);
        
        if (finalPath && finalPath.length > stopIndex) {
            const finalStopPoint = finalPath[stopIndex];
            const errorX = finalStopPoint.x - targetPoint.x;
            const errorY = finalStopPoint.y - targetPoint.y;
            bestError = Math.sqrt(errorX * errorX + errorY * errorY);
            
            success = bestError < tolerance * 100; // より緩い成功判定
            
            console.log(`📊 [Brent] 最終結果: エラー=${bestError.toFixed(6)}mm, 成功=${success}`);
            console.log(`📊 [Brent] 最適化量: ΔX=${optimalDeltaX.toFixed(6)}, ΔY=${optimalDeltaY.toFixed(6)}`);
            console.log(`📊 [Brent] 最終方向: (${bestDirection.i.toFixed(6)}, ${bestDirection.j.toFixed(6)}, ${bestDirection.k.toFixed(6)})`);
        }
        
    } catch (error) {
        console.error(`❌ [Brent] 最適化エラー: ${error.message}`);
        bestDirection = baseDirection;
        bestError = Number.MAX_VALUE;
    }
    
    return {
        success: success,
        direction: bestDirection,
        bestError: bestError,
        usedBrentMethod: brentMethod !== null
    };
}

// グローバル関数として公開
window.setupWavefrontRayButtons = setupWavefrontRayButtons;
window.handleDrawWavefrontRays = handleDrawWavefrontRays;
window.getCurrentFieldSetting = getCurrentFieldSetting;
window.handleClearWavefrontRays = handleClearWavefrontRays;
