/**
 * Transverse Aberration Diagram Calculator (Cross Beam Version)
 * 横収差図計算システム（十字光線版）
 * 
 * 機能:
 * - 有限系・無限系の十字光線を使った横収差計算
 * - Brent法による主光線と周辺光線の計算
 * - メリジオナル光線とサジタル光線の分離
 * - 主光線を基準とした横収差の算出
 * - 絞り座標による規格化
 * 
 * 作成日: 2025/07/24
 */

import { generateFiniteSystemCrossBeam } from '../../raytracing/generation/gen-ray-cross-finite.js';
import { generateInfiniteSystemCrossBeam } from '../../raytracing/generation/gen-ray-cross-infinite.js';
import { traceRay, calculateSurfaceOrigins } from '../../raytracing/core/ray-tracing.js';
import { getObjectRows, getSourceRows } from '../../utils/data-utils.js';
import { calculateEntrancePupilDiameter, calculateParaxialData } from '../../raytracing/core/ray-paraxial.js';

const TRANSVERSE_DEBUG = !!(typeof globalThis !== 'undefined' && (globalThis.__TRANSVERSE_DEBUG || globalThis.__OPD_DEBUG || globalThis.__PSF_DEBUG));

console.log('🔍 Transverse Aberration module loaded - CT/Mirror support enabled');

// Helper function to detect mirror surfaces
function isMirrorRow(row) {
    if (!row) return false;
    if (row.material === 'MIRROR') return true;
    if (row.type === 'Mirror') return true;
    if (row._blockType === 'Mirror') return true;
    const surfType = String(row.surfType ?? row.type ?? row.surfaceType ?? '').trim().toLowerCase();
    return surfType === 'mirror';
}

// Helper function to apply rotation matrix to vector
function applyRotationMatrixToVector(matrix, v) {
    if (!matrix) return { x: v.x, y: v.y, z: v.z };
    const x = matrix[0][0] * v.x + matrix[0][1] * v.y + matrix[0][2] * v.z;
    const y = matrix[1][0] * v.x + matrix[1][1] * v.y + matrix[1][2] * v.z;
    const z = matrix[2][0] * v.x + matrix[2][1] * v.y + matrix[2][2] * v.z;
    return { x, y, z };
}

/**
 * 有限系・無限系の判定
 * @param {Array} opticalSystemRows - 光学系データ
 * @returns {boolean} true: 有限系, false: 無限系
 */
function isFiniteSystem(opticalSystemRows) {
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        return false;
    }
    
    const firstSurface = opticalSystemRows[0];
    const thickness = firstSurface.thickness || firstSurface.Thickness;
    
    // 文字列'INF'またはInfinity値の場合は無限系
    if (thickness === 'INF' || thickness === Infinity) {
        return false; // 無限系
    }
    
    // 数値に変換して有限かつ正の値であれば有限系
    const numThickness = parseFloat(thickness);
    return Number.isFinite(numThickness) && numThickness > 0;
}

/**
 * 横収差図データを計算する（十字光線版）
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} targetSurfaceIndex - 評価面のインデックス
 * @param {Array} fieldSettings - フィールド設定（null の場合は自動取得）
 * @param {number} wavelength - 波長 (μm)
 * @param {number} rayCount - 光線数 (奇数推奨)
 * @returns {Object} 横収差データ
 */
export function calculateTransverseAberration(opticalSystemRows, targetSurfaceIndex, fieldSettings = null, wavelength = 0.5876, rayCount = 51) {
    // CACHE BUSTER v2.0 - Force reload check
    console.log('🔥 TRANSVERSE ABERRATION v2.0 - CT/MIRROR SUPPORT LOADED');
    
    // デバッグモードの設定（デフォルトは静か）
    const debugMode = TRANSVERSE_DEBUG;
    
    if (debugMode) {
        console.log('🎯 横収差計算開始（十字光線版）');
    }
    
    // フィールド設定を取得
    if (!fieldSettings) {
        fieldSettings = getFieldSettingsFromObject();
    }
    
    // fieldSettings の詳細ログ
    if (debugMode) console.log('🔍 [DEBUG] fieldSettings詳細:', fieldSettings);
    const safeNumber = (value) => {
        const num = Number(value);
        return Number.isFinite(num) ? num : 0;
    };

    const uniqueFieldKey = (fs) => {
        const positionType = (fs.position || fs.fieldType || fs.type || '').toLowerCase();
        const isAngle = positionType.includes('angle');
        const xVal = isAngle
            ? safeNumber(fs.xFieldAngle ?? fs.xAngle ?? fs.xHeightAngle ?? fs.x)
            : safeNumber(fs.xHeight ?? fs.x ?? fs.xFieldAngle ?? fs.xAngle);
        const yVal = isAngle
            ? safeNumber(fs.yFieldAngle ?? fs.fieldAngle ?? fs.yAngle ?? fs.yHeightAngle ?? fs.y)
            : safeNumber(fs.yHeight ?? fs.y ?? fs.yFieldAngle ?? fs.yAngle);
        const objIndex = fs.objectIndex ?? 1; // Object番号を含める
        return `${positionType}_${xVal}_${yVal}_obj${objIndex}`;
    };
    const seenKeys = new Set();
    fieldSettings = fieldSettings.filter((fs, idx) => {
        const key = uniqueFieldKey(fs);
        if (seenKeys.has(key)) {
            if (debugMode) console.warn(`⚠️ [Transverse] フィールド設定が重複しています: index=${idx}, key=${key}`);
            return false;
        }
        seenKeys.add(key);
        return true;
    });
    
    // 基本設定ログ（簡潔版）
    if (debugMode) {
        console.log(`📊 横収差計算: 評価面=Surface ${targetSurfaceIndex + 1}, フィールド=${fieldSettings.length}点`);
    }
    
    // 絞り面を見つける
    const stopSurfaceIndex = findStopSurfaceIndex(opticalSystemRows);
    if (stopSurfaceIndex === -1) {
        throw new Error('絞り面が見つかりません');
    }
    
    // Detect mirrors and calculate sign flip for odd mirror count
    const mirrorCount = Array.isArray(opticalSystemRows)
        ? opticalSystemRows.filter(isMirrorRow).length
        : 0;
    const mirrorSign = (mirrorCount % 2 === 1) ? -1 : 1;
    console.log(`🔍 Transverse: Detected ${mirrorCount} mirror(s), mirrorSign=${mirrorSign}`);
    
    // Calculate surface origins (for coordinate transformation support)
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    const targetSurfaceInfo = surfaceOrigins?.[targetSurfaceIndex] || null;
    const stopSurfaceInfo = surfaceOrigins?.[stopSurfaceIndex] || null;
    console.log(`🔍 Transverse: targetSurfaceInfo=${targetSurfaceInfo ? 'exists' : 'null'}, stopSurfaceInfo=${stopSurfaceInfo ? 'exists' : 'null'}`);
    if (targetSurfaceInfo?.rotationMatrix) {
        console.log(`🔍 Transverse: Target surface has rotation matrix (CT detected)`);
    }
    
    // 有限系・無限系の判定
    const isFinite = isFiniteSystem(opticalSystemRows);
    
    // 絞り面の物理的半径を取得（正規化の基準として使用）
    const stopSurface = opticalSystemRows[stopSurfaceIndex];
    // 🔧 FIX: semidiaフィールドを優先的に使用（aperture/Apertureはundefinedの場合が多い）
    const apertureValue = Math.abs(parseFloat(stopSurface.semidia || stopSurface.aperture || stopSurface.Aperture || 10));
    if (debugMode) console.log(`🔍 [DEBUG] 絞り面半径取得: semidia=${stopSurface.semidia}, aperture=${stopSurface.aperture}, 使用値=${apertureValue}mm (Surface ${stopSurfaceIndex + 1})`);
    
    // 🔧 FIX: semidia/aperture値は既に半径として保存されている（直径ではない）
    const stopRadius = apertureValue;  // 半径をそのまま使用
    
    // 🔧 FIX: 横収差図の正規化には絞り面半径を使用
    // 光線は絞り面を基準に生成されているため、絞り半径で正規化すれば軸上で±1になる
    const entrancePupilRadius = stopRadius;  // 絞り面半径 = 瞳半径として使用
    
    if (debugMode) {
        console.log(`🔍 光学系: ${isFinite ? '有限系' : '無限系'}, 絞り面=Surface ${stopSurfaceIndex + 1}`);
        console.log(`🔍 絞り半径=${stopRadius}mm (正規化基準)`);
        console.log(`🔍 正規化基準: 瞳半径=${entrancePupilRadius.toFixed(2)}mm (絞り面半径と同じ)`);
    }
    
    const aberrationData = {
        fieldSettings: fieldSettings,
        wavelength: wavelength,
        targetSurface: targetSurfaceIndex,
        stopSurface: stopSurfaceIndex,
        stopRadius: stopRadius,
        pupilRadius: entrancePupilRadius,  // 正規化基準（絞り半径と同じ）
        isFiniteSystem: isFinite,
        meridionalData: [],
        sagittalData: [],
        metadata: {
            rayCount: rayCount,
            calculationTime: new Date().toISOString(),
            version: 'cross-beam'
        }
    };
    
    // 各フィールド設定について計算
    for (let i = 0; i < fieldSettings.length; i++) {
        const fieldSetting = fieldSettings[i];
        if (debugMode) console.log(`\n📍 [DEBUG] フィールド ${i + 1}/${fieldSettings.length}: ${fieldSetting.displayName}`);
        if (debugMode) console.log(`🔍 [DEBUG] fieldSetting詳細:`, fieldSetting);
        
        if (debugMode) {
            console.log(`\n📍 フィールド ${i + 1}/${fieldSettings.length}: ${fieldSetting.displayName}`);
        }
        
        try {
            // 十字光線を生成（絞り面インデックスと評価面インデックスも渡す）
            if (debugMode) console.log(`🎯 [DEBUG] 十字光線生成開始 for field ${i}`);
    const crossBeamData = generateCrossBeamForField(opticalSystemRows, fieldSetting, isFinite, rayCount, wavelength, stopSurfaceIndex, targetSurfaceIndex);
            if (debugMode) console.log(`🎯 [DEBUG] 十字光線生成結果:`, crossBeamData ? 'success' : 'failed');
            
            if (crossBeamData) {
                // メリジオナル・サジタル光線を分離して横収差を計算（絞り半径と入射瞳半径を別々に渡す）
                const meridionalResult = calculateMeridionalAberrationFromCrossBeam(
                    crossBeamData, opticalSystemRows, targetSurfaceIndex, stopSurfaceIndex, stopRadius, entrancePupilRadius, fieldSetting, targetSurfaceInfo, stopSurfaceInfo, mirrorSign
                );
                
                const sagittalResult = calculateSagittalAberrationFromCrossBeam(
                    crossBeamData, opticalSystemRows, targetSurfaceIndex, stopSurfaceIndex, stopRadius, entrancePupilRadius, fieldSetting, targetSurfaceInfo, stopSurfaceInfo, mirrorSign
                );
                
                aberrationData.meridionalData.push(meridionalResult);
                aberrationData.sagittalData.push(sagittalResult);
                
                if (debugMode) {
                    console.log(`✅ フィールド計算完了: M=${meridionalResult.points.length}点, S=${sagittalResult.points.length}点`);
                }
            } else {
                if (debugMode) console.warn(`⚠️ フィールド ${fieldSetting.displayName} の十字光線生成に失敗`);
            }
        } catch (error) {
            console.error(`❌ フィールド ${fieldSetting.displayName} の計算エラー:`, error);
        }
    }
    
    if (debugMode) {
        console.log('✅ 横収差計算完了');
    }
    return aberrationData;
}

// Async wrapper for UI progress bars: runs per-field chunks and yields to the event loop.
// Keeps the original synchronous API intact.
export async function calculateTransverseAberrationAsync(
    opticalSystemRows,
    targetSurfaceIndex,
    fieldSettings = null,
    wavelength = 0.5876,
    rayCount = 51,
    options = null
) {
    console.log('🔥🔥 ASYNC VERSION v2.0 - CALLED', { targetSurfaceIndex, fieldSettings, wavelength, rayCount });
    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;
    const yieldEvery = Number.isInteger(options?.yieldEvery) ? options.yieldEvery : 1;
    const yieldToUI = async () => new Promise(resolve => setTimeout(resolve, 0));
    const safeProgress = (percent, message) => {
        try { onProgress?.({ percent, message }); } catch (_) {}
    };

    // Mirror sync behavior for fieldSettings.
    const fields = (!fieldSettings || !Array.isArray(fieldSettings) || fieldSettings.length === 0)
        ? getFieldSettingsFromObject()
        : fieldSettings;

    const totalFields = Array.isArray(fields) ? fields.length : 0;
    safeProgress(0, 'Starting transverse aberration...');
    await yieldToUI();

    let baseMeta = null;
    const meridionalData = [];
    const sagittalData = [];

    for (let i = 0; i < totalFields; i++) {
        const fs = fields[i];
        const pct = 5 + (85 * (i / Math.max(1, totalFields)));
        const name = fs?.displayName ? String(fs.displayName) : `Field ${i + 1}`;
        safeProgress(Math.min(95, Math.max(0, pct)), `Calculating ${name} (${i + 1}/${totalFields})...`);

        console.log(`🎯 ASYNC calling SYNC version for field ${i + 1}/${totalFields}: ${name}`);
        const partial = calculateTransverseAberration(
            opticalSystemRows,
            targetSurfaceIndex,
            [fs],
            wavelength,
            rayCount
        );
        console.log(`✅ ASYNC received result from SYNC for field ${i + 1}`);

        if (partial && typeof partial === 'object') {
            if (!baseMeta) baseMeta = partial;
            if (Array.isArray(partial.meridionalData)) meridionalData.push(...partial.meridionalData);
            if (Array.isArray(partial.sagittalData)) sagittalData.push(...partial.sagittalData);
        }

        if (yieldEvery > 0 && ((i + 1) % yieldEvery) === 0) {
            await yieldToUI();
        }
    }

    safeProgress(95, 'Finalizing...');
    await yieldToUI();

    const out = (baseMeta && typeof baseMeta === 'object') ? { ...baseMeta } : {};
    out.fieldSettings = fields;
    out.wavelength = wavelength;
    out.targetSurface = targetSurfaceIndex;
    out.meridionalData = meridionalData;
    out.sagittalData = sagittalData;

    safeProgress(100, 'Done');
    return out;
}

/**
 * フィールド設定に応じて十字光線を生成
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} fieldSetting - フィールド設定
 * @param {boolean} isFinite - 有限系かどうか
 * @param {number} rayCount - 光線数
 * @param {number} wavelength - 波長
 * @param {number} stopSurfaceIndex - 絞り面インデックス
 * @param {number} targetSurfaceIndex - 評価面インデックス
 * @returns {Object} 十字光線データ
 */
function generateCrossBeamForField(opticalSystemRows, fieldSetting, isFinite, rayCount, wavelength, stopSurfaceIndex, targetSurfaceIndex) {
    const debugMode = TRANSVERSE_DEBUG;
    
    const options = {
        rayCount: rayCount,
        wavelength: wavelength,
        colorMode: 'segment', // セグメント色分け
        crossType: 'both', // 明示的に水平・垂直両方向を指定
        debugMode: debugMode,
        targetSurfaceIndex: targetSurfaceIndex // 評価面インデックスを追加
    };
    
    if (debugMode) {
        console.log('🎯 十字光線生成オプション:', JSON.stringify(options, null, 2));
        console.log('🎯 フィールド設定:', JSON.stringify(fieldSetting, null, 2));
        console.log('🎯 光学系タイプ:', isFinite ? '有限系' : '無限系');
        console.log(`🎯 評価面: Surface ${targetSurfaceIndex + 1} (index: ${targetSurfaceIndex})`);
    }
    
    try {
        let rawCrossBeamData = null;
        
        const forceInfiniteByField = fieldSetting.fieldType === 'Angle';

        if (isFinite && !forceInfiniteByField) {
            // 有限系: Object位置を使用（Rectangle/Angleを区別）
            const objectPosition = {
                comment: fieldSetting.displayName,
                objectIndex: fieldSetting.objectIndex - 1
            };

            if (fieldSetting.fieldType === 'Angle') {
                objectPosition.position = 'Angle';
                objectPosition.xHeightAngle = parseFloat(fieldSetting.xFieldAngle ?? fieldSetting.xAngle ?? fieldSetting.x ?? 0) || 0;
                objectPosition.yHeightAngle = parseFloat(fieldSetting.yFieldAngle ?? fieldSetting.fieldAngle ?? fieldSetting.y ?? 0) || 0;
            } else {
                objectPosition.position = 'Rectangle';
                const xVal = parseFloat(fieldSetting.xHeight ?? fieldSetting.x ?? 0) || 0;
                const yVal = parseFloat(fieldSetting.yHeight ?? fieldSetting.y ?? 0) || 0;
                objectPosition.x = xVal;
                objectPosition.y = yVal;
                objectPosition.xHeight = objectPosition.x;
                objectPosition.yHeight = objectPosition.y;
            }

            const objectPositions = [objectPosition];
            
            if (debugMode) {
                console.log(`🎯 有限系十字光線生成: Object${fieldSetting.objectIndex} (${objectPositions[0].x}, ${objectPositions[0].y})`);
                console.log(`🎯 objectPositions詳細:`, objectPositions);
            }
            rawCrossBeamData = generateFiniteSystemCrossBeam(opticalSystemRows, objectPositions, options);
            
        } else {
            // 無限系: 画角を使用
            let xFieldAngle = 0;
            let yFieldAngle = 0;
            
            if (fieldSetting.fieldType === 'Angle' || fieldSetting.fieldType === 'angle') {
                // X方向の角度
                xFieldAngle = fieldSetting.xFieldAngle || fieldSetting.xHeightAngle || 0;
                
                // Y方向の角度
                if (fieldSetting.yFieldAngle !== undefined) {
                    yFieldAngle = fieldSetting.yFieldAngle;
                } else if (fieldSetting.yHeightAngle !== undefined) {
                    yFieldAngle = fieldSetting.yHeightAngle;
                } else if (fieldSetting.fieldAngle !== undefined) {
                    if (typeof fieldSetting.fieldAngle === 'object') {
                        yFieldAngle = fieldSetting.fieldAngle.y || fieldSetting.fieldAngle.yFieldAngle || 0;
                    } else {
                        yFieldAngle = fieldSetting.fieldAngle;
                    }
                }
            }
            
            console.log(`🎯 [DEBUG] 無限系角度取得詳細:`, {
                fieldType: fieldSetting.fieldType,
                xFieldAngle: xFieldAngle,
                yFieldAngle: yFieldAngle,
                originalFieldSetting: fieldSetting
            });
            
            const objectAngles = [{
                x: xFieldAngle,
                y: yFieldAngle,
                comment: fieldSetting.displayName
            }];
            
            if (debugMode) {
                console.log(`🎯 無限系十字光線生成: (${xFieldAngle}°, ${yFieldAngle}°)`);
                console.log(`🎯 objectAngles:`, objectAngles);
            }
            rawCrossBeamData = generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, options);
        }        if (!rawCrossBeamData || !rawCrossBeamData.success) {
            console.warn('⚠️ 十字光線生成に失敗');
            return null;
        }
        
        if (debugMode) {
            console.log(`✅ 十字光線生成: Object=${rawCrossBeamData.objectResults ? rawCrossBeamData.objectResults.length : 0}群, 光線=${rawCrossBeamData.objectResults && rawCrossBeamData.objectResults.length > 0 ? rawCrossBeamData.objectResults[0].tracedRays.length : 0}本`);
        }
        
        // 光線タイプの初期分布を確認
        if (rawCrossBeamData.objectResults && rawCrossBeamData.objectResults[0]) {
            const typeDistribution = {};
            const coordCheck = {
                horizontal_cross: { xCoords: [], yCoords: [] },
                vertical_cross: { xCoords: [], yCoords: [] }
            };
            
            rawCrossBeamData.objectResults[0].tracedRays.forEach(ray => {
                if (ray.originalRay && ray.originalRay.type) {
                    const type = ray.originalRay.type;
                    typeDistribution[type] = (typeDistribution[type] || 0) + 1;
                    
                    // 十字光線の座標をチェック
                    if (type === 'horizontal_cross' || type === 'vertical_cross') {
                        if (ray.rayPath && ray.rayPath.length > 0) {
                            const firstPoint = ray.rayPath[0];
                            const lastPoint = ray.rayPath[ray.rayPath.length - 1];
                            
                            if (type === 'horizontal_cross') {
                                coordCheck.horizontal_cross.xCoords.push(firstPoint.x);
                                coordCheck.horizontal_cross.yCoords.push(firstPoint.y);
                            } else {
                                coordCheck.vertical_cross.xCoords.push(firstPoint.x);
                                coordCheck.vertical_cross.yCoords.push(firstPoint.y);
                            }
                        }
                    }
                }
            });
            
            // console.log('🔍 生成された光線タイプ分布:', typeDistribution);
            
            // 十字光線の座標分布をチェック
            // console.log('🔍 水平十字光線座標範囲:');
            if (coordCheck.horizontal_cross.xCoords.length > 0) {
                const xMin = Math.min(...coordCheck.horizontal_cross.xCoords);
                const xMax = Math.max(...coordCheck.horizontal_cross.xCoords);
                const yMin = Math.min(...coordCheck.horizontal_cross.yCoords);
                const yMax = Math.max(...coordCheck.horizontal_cross.yCoords);
                // console.log(`  X範囲: ${xMin.toFixed(3)} 〜 ${xMax.toFixed(3)}`);
                // console.log(`  Y範囲: ${yMin.toFixed(3)} 〜 ${yMax.toFixed(3)}`);
            }
            
            // console.log('🔍 垂直十字光線座標範囲:');
            if (coordCheck.vertical_cross.xCoords.length > 0) {
                const xMin = Math.min(...coordCheck.vertical_cross.xCoords);
                const xMax = Math.max(...coordCheck.vertical_cross.xCoords);
                const yMin = Math.min(...coordCheck.vertical_cross.yCoords);
                const yMax = Math.max(...coordCheck.vertical_cross.yCoords);
                // console.log(`  X範囲: ${xMin.toFixed(3)} 〜 ${xMax.toFixed(3)}`);
                // console.log(`  Y範囲: ${yMin.toFixed(3)} 〜 ${yMax.toFixed(3)}`);
            }
        }
        
        // 横収差計算用のrayGroups形式に変換（絞り面インデックスを渡す）
        // NOTE: ray.path は Object/Coord Break 行を交点として記録しないため、
        // 以降の分類/評価で表面インデックス→rayPath点インデックス変換が必要。
        return convertToRayGroupsFormat(rawCrossBeamData, stopSurfaceIndex, opticalSystemRows);
        
    } catch (error) {
        console.error('❌ 十字光線生成エラー:', error);
        return null;
    }
}

/**
 * 十字光線データをrayGroups形式に変換
 * @param {Object} rawCrossBeamData - 十字光線生成結果
 * @param {number} stopSurfaceIndex - 絞り面インデックス
 * @returns {Object} rayGroups形式のデータ
 */
function convertToRayGroupsFormat(rawCrossBeamData, stopSurfaceIndex, opticalSystemRows = null) {
    try {
        const rayGroups = [];
        
        if (rawCrossBeamData.systemType === 'finite' && rawCrossBeamData.objectResults) {
            // 有限系の場合
            rawCrossBeamData.objectResults.forEach((objectResult, objectIndex) => {
                const rays = [];
                
                // 成功・失敗の統計（簡潔版）
                let successCount = 0;
                let failureCount = 0;
                let partialCount = 0;
                
                // 成功・失敗・部分成功の光線追跡結果から光線データを構築
                objectResult.tracedRays.forEach((tracedRay, index) => {
                    // 成功した光線
                    if (tracedRay.success && tracedRay.originalRay && tracedRay.rayPath) {
                        const originalRay = tracedRay.originalRay;
                        
                        // rayTypeの正規化（十字光線はそのまま保持し、後でclassifyCrossBeamRaysで処理）
                        let rayType = originalRay.type || 'unknown';
                        
                        // 基本的な正規化のみ
                        if (rayType === 'chief' || rayType === 'Chief') {
                            rayType = 'chief';
                        } else if (rayType === 'marginal_up' || rayType === 'up' || rayType === 'upper') {
                            rayType = 'upper_marginal';
                        } else if (rayType === 'marginal_down' || rayType === 'down' || rayType === 'lower') {
                            rayType = 'lower_marginal';
                        } else if (rayType === 'marginal_left' || rayType === 'left') {
                            rayType = 'left_marginal';
                        } else if (rayType === 'marginal_right' || rayType === 'right') {
                            rayType = 'right_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('up')) {
                            rayType = 'upper_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('down')) {
                            rayType = 'lower_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('left')) {
                            rayType = 'left_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('right')) {
                            rayType = 'right_marginal';
                        }
                        
                        rays.push({
                            rayType: rayType,
                            path: tracedRay.rayPath,
                            originalRay: originalRay,
                            objectIndex: objectIndex,
                            isFullSuccess: true
                        });
                        
                        successCount++;
                    } else if (!tracedRay.success && tracedRay.originalRay && tracedRay.partialPath && tracedRay.partialPath.length > 0) {
                        // 失敗したが部分的な光路がある場合
                        const originalRay = tracedRay.originalRay;
                        let rayType = originalRay.type || 'unknown';
                        
                        // rayTypeの正規化（成功した光線と同じ処理）
                        if (rayType === 'chief' || rayType === 'Chief') {
                            rayType = 'chief';
                        } else if (rayType === 'marginal_up' || rayType === 'up' || rayType === 'upper') {
                            rayType = 'upper_marginal';
                        } else if (rayType === 'marginal_down' || rayType === 'down' || rayType === 'lower') {
                            rayType = 'lower_marginal';
                        } else if (rayType === 'marginal_left' || rayType === 'left') {
                            rayType = 'left_marginal';
                        } else if (rayType === 'marginal_right' || rayType === 'right') {
                            rayType = 'right_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('up')) {
                            rayType = 'upper_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('down')) {
                            rayType = 'lower_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('left')) {
                            rayType = 'left_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('right')) {
                            rayType = 'right_marginal';
                        }
                        
                        rays.push({
                            rayType: rayType,
                            path: tracedRay.partialPath,
                            originalRay: originalRay,
                            objectIndex: objectIndex,
                            isFullSuccess: false,
                            isPartial: true,
                            failureReason: tracedRay.error || 'Unknown error'
                        });
                        
                        partialCount++;
                    } else {
                        failureCount++;
                    }
                });
                
                // 十字光線の詳細分類を行う
                classifyCrossBeamRays(rays, stopSurfaceIndex, opticalSystemRows);
                
                if (failureCount > 0 || partialCount > 0) {
                    console.log(`📊 Object ${objectIndex}: 成功=${successCount}, 部分=${partialCount}, 失敗=${failureCount}`);
                }
                
                rayGroups.push({
                    objectIndex: objectIndex,
                    rays: rays
                });
            });
            
        } else if (rawCrossBeamData.systemType === 'infinite' && rawCrossBeamData.objectResults) {
            // 無限系の場合 - objectResultsを使用
            rawCrossBeamData.objectResults.forEach((angleResult, angleIndex) => {
                const rays = [];
                let successCount = 0;
                let failureCount = 0;
                let partialCount = 0;
                
                angleResult.tracedRays.forEach(tracedRay => {
                    // 成功した光線
                    if (tracedRay.success && tracedRay.originalRay && tracedRay.rayPath) {
                        const originalRay = tracedRay.originalRay;
                        
                        // rayTypeの正規化（十字光線はそのまま保持し、後でclassifyCrossBeamRaysで処理）
                        let rayType = originalRay.type || 'unknown';
                        
                        // 基本的な正規化のみ
                        if (rayType === 'chief' || rayType === 'Chief') {
                            rayType = 'chief';
                        } else if (rayType === 'marginal_up' || rayType === 'up' || rayType === 'upper') {
                            rayType = 'upper_marginal';
                        } else if (rayType === 'marginal_down' || rayType === 'down' || rayType === 'lower') {
                            rayType = 'lower_marginal';
                        } else if (rayType === 'marginal_left' || rayType === 'left') {
                            rayType = 'left_marginal';
                        } else if (rayType === 'marginal_right' || rayType === 'right') {
                            rayType = 'right_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('up')) {
                            rayType = 'upper_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('down')) {
                            rayType = 'lower_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('left')) {
                            rayType = 'left_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('right')) {
                            rayType = 'right_marginal';
                        }
                        
                        rays.push({
                            rayType: rayType,
                            path: tracedRay.rayPath,
                            originalRay: originalRay,
                            angleIndex: angleIndex,
                            isFullSuccess: true
                        });
                        
                        successCount++;
                    } else if (!tracedRay.success && tracedRay.originalRay && tracedRay.partialPath && tracedRay.partialPath.length > 0) {
                        // 失敗したが部分的な光路がある場合
                        const originalRay = tracedRay.originalRay;
                        let rayType = originalRay.type || 'unknown';
                        
                        // rayTypeの正規化（成功した光線と同じ処理）
                        if (rayType === 'chief' || rayType === 'Chief') {
                            rayType = 'chief';
                        } else if (rayType === 'marginal_up' || rayType === 'up' || rayType === 'upper') {
                            rayType = 'upper_marginal';
                        } else if (rayType === 'marginal_down' || rayType === 'down' || rayType === 'lower') {
                            rayType = 'lower_marginal';
                        } else if (rayType === 'marginal_left' || rayType === 'left') {
                            rayType = 'left_marginal';
                        } else if (rayType === 'marginal_right' || rayType === 'right') {
                            rayType = 'right_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('up')) {
                            rayType = 'upper_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('down')) {
                            rayType = 'lower_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('left')) {
                            rayType = 'left_marginal';
                        } else if (rayType.includes('aperture') && rayType.includes('right')) {
                            rayType = 'right_marginal';
                        }
                        
                        rays.push({
                            rayType: rayType,
                            path: tracedRay.partialPath,
                            originalRay: originalRay,
                            angleIndex: angleIndex,
                            isFullSuccess: false,
                            isPartial: true,
                            failureReason: tracedRay.error || 'Unknown error'
                        });
                        
                        partialCount++;
                    } else {
                        failureCount++;
                    }
                });
                
                // 十字光線の詳細分類を行う
                classifyCrossBeamRays(rays, stopSurfaceIndex, opticalSystemRows);
                
                if (failureCount > 0 || partialCount > 0) {
                    console.log(`📊 Angle ${angleIndex}: 成功=${successCount}, 部分=${partialCount}, 失敗=${failureCount}`);
                }
                
                rayGroups.push({
                    angleIndex: angleIndex,
                    rays: rays
                });
            });
        }
        
        console.log(`🔄 rayGroups変換完了: ${rayGroups.length}グループ, 総光線数=${rayGroups.reduce((sum, group) => sum + group.rays.length, 0)}`);
        
        // 光線タイプの分布を確認（詳細版）
        const rayTypeCounts = {};
        const originalTypeCounts = {};
        rayGroups.forEach(group => {
            group.rays.forEach(ray => {
                rayTypeCounts[ray.rayType] = (rayTypeCounts[ray.rayType] || 0) + 1;
                const originalType = ray.originalRay?.type || 'undefined';
                originalTypeCounts[originalType] = (originalTypeCounts[originalType] || 0) + 1;
            });
        });
        
        console.log('📊 光線タイプ分布（変換後）:', rayTypeCounts);
        console.log('📊 光線タイプ分布（元）:', originalTypeCounts);
        
        // 詳細な光線タイプ分析
        console.log('🔍 詳細光線タイプ分析:');
        Object.keys(originalTypeCounts).forEach(type => {
            console.log(`  元タイプ "${type}": ${originalTypeCounts[type]}本`);
        });
        
        Object.keys(rayTypeCounts).forEach(type => {
            console.log(`  変換後タイプ "${type}": ${rayTypeCounts[type]}本`);
        });
        
        // 主要な光線タイプのみ報告
        const importantTypes = ['chief', 'left_marginal', 'right_marginal', 'upper_marginal', 'lower_marginal'];
        const importantCounts = {};
        importantTypes.forEach(type => {
            if (rayTypeCounts[type]) {
                importantCounts[type] = rayTypeCounts[type];
            }
        });
        
        console.log('📊 主要光線タイプ:', importantCounts);
        
        return {
            rayGroups: rayGroups,
            systemType: rawCrossBeamData.systemType,
            success: true
        };
        
    } catch (error) {
        console.error('❌ rayGroups変換エラー:', error);
        return null;
    }
}

/**
 * 十字光線からメリジオナル横収差を計算
 * @param {Object} crossBeamData - 十字光線データ
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} targetSurfaceIndex - 評価面インデックス
 * @param {number} stopSurfaceIndex - 絞り面インデックス
 * @param {number} stopRadius - 絞り半径
 * @param {number} entrancePupilRadius - 入射瞳半径
 * @param {Object} fieldSetting - フィールド設定
 * @param {Object} targetSurfaceInfo - 評価面の座標変換情報
 * @param {Object} stopSurfaceInfo - 絞り面の座標変換情報
 * @param {number} mirrorSign - ミラーによる符号反転 (1 or -1)
 * @returns {Object} メリジオナル横収差データ
 */
function calculateMeridionalAberrationFromCrossBeam(crossBeamData, opticalSystemRows, targetSurfaceIndex, stopSurfaceIndex, stopRadius, entrancePupilRadius, fieldSetting, targetSurfaceInfo = null, stopSurfaceInfo = null, mirrorSign = 1) {
    const points = [];
    
    if (!crossBeamData || !crossBeamData.rayGroups || crossBeamData.rayGroups.length === 0) {
        console.warn('⚠️ 十字光線データが無効です');
        return {
            fieldSetting: fieldSetting,
            rayType: 'meridional',
            points: points
        };
    }
    
    const rayGroup = crossBeamData.rayGroups[0]; // 最初のオブジェクトグループ
    let chiefRay = null;
    const meridionalRays = [];
    
    // 🔧 ケラレ統計用
    let vignetteCount = 0;
    let successCount = 0;
    let partialButReachedStop = 0;
    
    // 主光線とメリジオナル光線を抽出
    const rayTypeCount = {};
    rayGroup.rays.forEach(ray => {
        rayTypeCount[ray.rayType] = (rayTypeCount[ray.rayType] || 0) + 1;
        
        if (ray.rayType === 'chief') {
            chiefRay = ray;
        } else if (ray.rayType === 'upper_marginal' || ray.rayType === 'lower_marginal' || 
                   ray.rayType === 'aperture_up' || ray.rayType === 'aperture_down' ||
                   ray.rayType === 'vertical_cross') {  // vertical_crossも明示的に含める
            meridionalRays.push(ray);
        }
    });
    
    // メリジオナル光線の詳細を確認
    const meridionalTypes = meridionalRays.map(ray => ray.rayType);
    const meridionalTypeCounts = {};
    meridionalTypes.forEach(type => {
        meridionalTypeCounts[type] = (meridionalTypeCounts[type] || 0) + 1;
    });
    // console.log(`🔍 メリジオナル抽出光線:`, meridionalTypeCounts);
    
    if (!chiefRay) {
        console.warn('⚠️ 主光線が見つかりません');
        return {
            fieldSetting: fieldSetting,
            rayType: 'meridional',
            points: points
        };
    }
    
    // 主光線の評価面での座標を取得
    const chiefIntersection = getIntersectionAtSurface(chiefRay, targetSurfaceIndex, opticalSystemRows, targetSurfaceInfo, mirrorSign);
    if (!chiefIntersection) {
        console.warn('⚠️ 主光線の評価面交点が見つかりません');
        return {
            fieldSetting: fieldSetting,
            rayType: 'meridional',
            points: points
        };
    }
    
    console.log(`🎯 主光線評価面座標: (${chiefIntersection.x.toFixed(4)}, ${chiefIntersection.y.toFixed(4)})`);
    
    const stopPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, stopSurfaceIndex);
    const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);

    // メリディオナル光線の絞り面でのX座標とY座標統計を収集（オフセット補正用のみ）
    const stopXCoordinates = [];
    const stopYCoordinates = [];
    meridionalRays.forEach(ray => {
        const stopIntersection = getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows);
        if (stopIntersection) {
            stopXCoordinates.push(stopIntersection.x);
            stopYCoordinates.push(stopIntersection.y);
        }
    });
    
    // X座標の中点を計算（X方向オフセット補正値）
    let xOffset = 0;
    if (stopXCoordinates.length > 0) {
        const minX = Math.min(...stopXCoordinates);
        const maxX = Math.max(...stopXCoordinates);
        xOffset = (minX + maxX) / 2;
        console.log(`🎯 メリディオナル絞り面X座標: min=${minX.toFixed(3)}, max=${maxX.toFixed(3)}, Xオフセット=${xOffset.toFixed(3)}`);
    }
    
    // Y座標のオフセット補正値を計算
    let yOffset = 0;
    if (stopYCoordinates.length > 0) {
        const minY = Math.min(...stopYCoordinates);
        const maxY = Math.max(...stopYCoordinates);
        yOffset = (minY + maxY) / 2;
        console.log(`🎯 メリディオナル絞り面Y座標: min=${minY.toFixed(3)}, max=${maxY.toFixed(3)}, Yオフセット=${yOffset.toFixed(3)}`);
    }
    
    // 🔧 FIX: 絞り面半径で正規化（全Objectで統一基準）
    // 光線は絞り面を通るように生成されているため、絞り半径で正規化すれば軸上で±1になる
    const maxAbsY = entrancePupilRadius;  // = stopRadius
    console.log(`🎯 メリディオナル正規化基準: 瞳半径=${maxAbsY.toFixed(3)}mm (絞り面半径)`);
    
    // 🔧 FIX: 部分的光線処理用も同じ瞳半径を使用
    const maxCorrectedY = entrancePupilRadius;  // = stopRadius
    console.log(`🎯 メリディオナル補正後正規化基準: 瞳半径=${maxCorrectedY.toFixed(3)}mm (絞り面半径)`);
    
    // 主光線の絞り面座標も取得（参考用）
    const chiefStopIntersection = getIntersectionAtSurface(chiefRay, stopSurfaceIndex, opticalSystemRows, stopSurfaceInfo, mirrorSign);
    if (chiefStopIntersection) {
        console.log(`🎯 主光線絞り面: X=${chiefStopIntersection.x.toFixed(3)} (補正後=${(chiefStopIntersection.x - xOffset).toFixed(3)}), Y=${chiefStopIntersection.y.toFixed(3)}`);
    }
    
    // メリジオナル光線の横収差を計算（座標分布に基づく正規化）
    meridionalRays.forEach((ray, index) => {
        const intersection = getIntersectionAtSurface(ray, targetSurfaceIndex, opticalSystemRows, targetSurfaceInfo, mirrorSign);
        if (intersection) {
            // 絞り面での座標を取得
            const stopIntersection = getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows, stopSurfaceInfo, mirrorSign);
            if (stopIntersection) {
                // Y座標はオフセット補正なしで直接使用
                const stopY = stopIntersection.y;
                
                // 🔧 FIX: 事前に計算済みのmaxAbsYを使用（ループ内で再計算しない）
                const normalizedPupilCoord = maxAbsY > 0 ? stopY / maxAbsY : 0;
                
                const transverseAberration = intersection.y - chiefIntersection.y; // Y方向の収差
                
                if (index < 3) {
                    console.log(`🔥 M-Ray ${index}: intersection.y=${intersection.y.toFixed(6)}, chief.y=${chiefIntersection.y.toFixed(6)}, aberration=${transverseAberration.toFixed(6)}, pupilCoord=${normalizedPupilCoord.toFixed(4)}`);
                }
                
                // 規格化座標が±1以内の光線を含める
                if (Math.abs(normalizedPupilCoord) <= 1.0) {
                    successCount++;
                    points.push({
                        pupilCoordinate: normalizedPupilCoord, // Y座標を直接正規化
                        transverseAberration: transverseAberration,
                        rayType: ray.rayType,
                        isPartial: ray.isPartial || false,
                        isFullSuccess: ray.isFullSuccess !== false,
                        failureReason: ray.failureReason || null,
                        actualCoordinate: {
                            x: intersection.x,
                            y: intersection.y
                        },
                        chiefReference: {
                            x: chiefIntersection.x,
                            y: chiefIntersection.y
                        },
                        stopCoordinate: {
                            x: stopIntersection.x,
                            y: stopIntersection.y,
                            maxAbsY: maxAbsY,
                            normalizedY: normalizedPupilCoord
                        }
                    });
                }
            }
        } else if (ray.isPartial && ray.path) {
            // 🔧 FIX: 絞り面に実際に到達しているかチェック（ケラレ検出）
            // 部分的な光線でも絞り面まで到達していれば処理する
            const stopIntersection = getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows);
            if (!stopIntersection) {
                // 絞り面に到達していない = ケラレている
                vignetteCount++;
                return; // この光線はスキップ
            }
            
            // 部分的な光線パスから最大限の情報を取得
            const maxSurfaceIndex = Math.min(
                ray.path.length - 1,
                Math.max(
                    Number.isInteger(targetPointIndex) ? targetPointIndex : 0,
                    Number.isInteger(stopPointIndex) ? stopPointIndex : 0
                )
            );
            
            if (stopIntersection) {
                const correctedStopY = stopIntersection.y - yOffset; // Y座標をオフセット補正
                
                // 🔧 FIX: 事前に計算済みのmaxCorrectedYを使用（ループ内で再計算しない）
                const normalizedPupilCoord = maxCorrectedY > 0 ? correctedStopY / maxCorrectedY : 0;
                
                // 規格化座標が±1以内の光線を含める（座標分布基準）
                if (Math.abs(normalizedPupilCoord) <= 1.0) {
                    partialButReachedStop++;
                    // 評価面まで到達していない場合は外挿して推定
                    let estimatedIntersection = null;
                    if (Number.isInteger(targetPointIndex) && targetPointIndex <= maxSurfaceIndex) {
                        estimatedIntersection = getIntersectionAtSurface(ray, targetSurfaceIndex, opticalSystemRows);
                    } else {
                        // 外挿による推定（最後の2面から推定）
                        if (ray.path.length >= 2) {
                            const lastPoint = ray.path[ray.path.length - 1];
                            const secondLastPoint = ray.path[ray.path.length - 2];
                            // 簡単な線形外挿
                            const deltaZ = lastPoint.z - secondLastPoint.z;
                            if (Math.abs(deltaZ) > 1e-10 && targetSurfaceIndex < opticalSystemRows.length) {
                                const targetZ = opticalSystemRows[targetSurfaceIndex].position || 0;
                                const extrapolationFactor = (targetZ - lastPoint.z) / deltaZ;
                                estimatedIntersection = {
                                    x: lastPoint.x + (lastPoint.x - secondLastPoint.x) * extrapolationFactor,
                                    y: lastPoint.y + (lastPoint.y - secondLastPoint.y) * extrapolationFactor,
                                    z: targetZ
                                };
                            }
                        }
                    }
                    
                    if (estimatedIntersection) {
                        const transverseAberration = estimatedIntersection.y - chiefIntersection.y;
                        
                        if (index < 2) {
                            console.log(`🔍 M光線 ${index} (外挿): Y=${stopIntersection.y.toFixed(3)}→${correctedStopY.toFixed(3)}, 最大補正Y=${maxCorrectedY.toFixed(3)}, 瞳座標=${normalizedPupilCoord.toFixed(3)}, Y収差=${transverseAberration.toFixed(4)}`);
                        }
                        
                        points.push({
                            pupilCoordinate: normalizedPupilCoord, // 座標分布に基づく正規化座標
                            transverseAberration: transverseAberration,
                            rayType: ray.rayType,
                            isPartial: true,
                            isFullSuccess: false,
                            isExtrapolated: true,
                            failureReason: ray.failureReason || 'Partial ray path',
                            actualCoordinate: {
                                x: estimatedIntersection.x,
                                y: estimatedIntersection.y
                            },
                            chiefReference: {
                                x: chiefIntersection.x,
                                y: chiefIntersection.y
                            },
                            stopCoordinate: {
                                x: stopIntersection.x,
                                y: stopIntersection.y,
                                correctedY: correctedStopY,
                                yOffset: yOffset,
                                maxCorrectedY: maxCorrectedY,
                                normalizedY: normalizedPupilCoord
                            }
                        });
                    }
                }
            }
        }
    });
    
    // 🔧 FIX: 主光線を明示的に追加（Ray number偶数時に瞳座標=0が含まれない問題を回避）
    const chiefStopY = chiefStopIntersection ? chiefStopIntersection.y : 0;
    const chiefNormalizedPupilCoordMeridional = maxAbsY > 0 ? chiefStopY / maxAbsY : 0;
    
    // 主光線が既にpoints配列に含まれているか確認（重複回避）
    const chiefAlreadyExistsMeridional = points.some(p => Math.abs(p.pupilCoordinate - chiefNormalizedPupilCoordMeridional) < 1e-9);
    
    if (!chiefAlreadyExistsMeridional) {
        points.push({
            pupilCoordinate: chiefNormalizedPupilCoordMeridional,
            transverseAberration: 0, // 主光線の横収差は定義上0
            rayType: 'chief',
            isPartial: false,
            isFullSuccess: true,
            failureReason: null,
            actualCoordinate: {
                x: chiefIntersection.x,
                y: chiefIntersection.y
            },
            chiefReference: {
                x: chiefIntersection.x,
                y: chiefIntersection.y
            },
            stopCoordinate: {
                x: chiefStopIntersection ? chiefStopIntersection.x : 0,
                y: chiefStopY,
                maxAbsY: maxAbsY,
                normalizedY: chiefNormalizedPupilCoordMeridional
            }
        });
        console.log(`✅ [メリディオナル] 主光線を明示的に追加: 瞳座標=${chiefNormalizedPupilCoordMeridional.toFixed(6)}`);
    }
    
    // 瞳座標でソート
    points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
    
    // � ケラレ統計を出力
    console.log(`� [メリディオナル ${fieldSetting.displayName}] 光線統計: 成功=${successCount}, 部分的だが絞り到達=${partialButReachedStop}, ケラレ=${vignetteCount}, 合計=${meridionalRays.length}`);
    if (vignetteCount > 0) {
        const vignettePercent = ((vignetteCount / meridionalRays.length) * 100).toFixed(1);
        console.log(`⚠️ [メリディオナル ${fieldSetting.displayName}] ケラレ率: ${vignettePercent}% (${vignetteCount}/${meridionalRays.length}本)`);
    }
    
    // 横収差0位置を求める
    let zeroAberrationPosition = null;
    let offsetMethod = 'none';
    
    // 🔍 デバッグ: 光線数と範囲の確認（簡潔に）
    console.log(`🔍 [メリディオナル] データ点数: ${points.length}点`);
    
    if (points.length >= 3) {
        // 新しい統一手法：最小絶対値点とその前後3点による直線近似
        const minAbsZero = findZeroAberrationByMinAbsThreePoints(points);
        if (minAbsZero !== null) {
            zeroAberrationPosition = minAbsZero;
            offsetMethod = 'min_abs_3points';
            console.log(`📊 [メリディオナル] 最小絶対値3点法: 横収差0位置 = ${minAbsZero.toFixed(6)}`);
        } else {
            console.warn('⚠️ [メリディオナル] 最小絶対値3点法が失敗しました');
        }
    } else if (points.length === 2) {
        // 2点の場合は線形補間で横収差0位置を求める（フォールバック）
        const p1 = points[0];
        const p2 = points[1];
        
        // 収差値の符号が異なる場合のみ0点を計算
        if (p1.transverseAberration * p2.transverseAberration <= 0) {
            const deltaX = p2.pupilCoordinate - p1.pupilCoordinate;
            const deltaY = p2.transverseAberration - p1.transverseAberration;
            
            if (Math.abs(deltaY) > 1e-12) {
                // 線形補間: y = 0となるxを求める
                const t = -p1.transverseAberration / deltaY;
                zeroAberrationPosition = p1.pupilCoordinate + t * deltaX;
                offsetMethod = 'linear_2points';
                console.log(`📊 [メリディオナル] 線形補間（2点）: 横収差0位置 = ${zeroAberrationPosition.toFixed(6)}`);
                
                // 有効範囲内かチェック
                if (Math.abs(zeroAberrationPosition) > 1.5) {
                    console.warn('⚠️ [メリディオナル] 線形補間: 解が範囲外、フォールバック');
                    zeroAberrationPosition = null;
                    offsetMethod = 'none';
                }
            } else {
                console.warn('⚠️ [メリディオナル] 2点の収差値がほぼ同じため、0点を求められません');
            }
        } else {
            console.warn('⚠️ [メリディオナル] 2点の収差値の符号が同じため、0点は範囲外です');
        }
    } else {
        console.warn('⚠️ [メリディオナル] データ点数が不足しています（最低2点必要）');
    }
    
    // 横収差0位置でのオフセット適用
    if (zeroAberrationPosition !== null && Math.abs(zeroAberrationPosition) > 1e-6) {
        console.log(`🎯 [メリディオナル] プロットオフセット適用: ${zeroAberrationPosition.toFixed(6)} → 0 (手法: ${offsetMethod})`);
        
        // 284点以上の場合の特別ログ
        if (points.length >= 284) {
            console.log(`⚠️ [メリディオナル] 大量データ(${points.length}点)でのオフセット適用 - 精度チェック開始`);
            const beforeRange = `${Math.min(...points.map(p => p.pupilCoordinate)).toFixed(6)} 〜 ${Math.max(...points.map(p => p.pupilCoordinate)).toFixed(6)}`;
            console.log(`🔍 [メリディオナル] オフセット前範囲: ${beforeRange}`);
        }
        
        // 全点の瞳座標をオフセット
        points.forEach(point => {
            point.originalPupilCoordinate = point.pupilCoordinate; // 元の座標を保存
            point.pupilCoordinate -= zeroAberrationPosition; // オフセット適用
        });
        
        // オフセット後に再ソート
        points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        console.log(`📊 [メリディオナル] オフセット後の瞳座標範囲: ${points[0].pupilCoordinate.toFixed(6)} 〜 ${points[points.length-1].pupilCoordinate.toFixed(6)}`);
        
        // 284点以上の場合の精度確認
        if (points.length >= 284) {
            const zeroNearPoints = points.filter(p => Math.abs(p.pupilCoordinate) < 0.01);
            console.log(`🔍 [メリディオナル] 0近傍点数(±0.01): ${zeroNearPoints.length}点`);
            if (zeroNearPoints.length > 0) {
                const zeroPointAberration = zeroNearPoints.find(p => Math.abs(p.pupilCoordinate) < 0.001);
                if (zeroPointAberration) {
                    console.log(`✅ [メリディオナル] 0点近似確認: 瞳座標=${zeroPointAberration.pupilCoordinate.toFixed(6)}, 横収差=${zeroPointAberration.transverseAberration.toFixed(6)}`);
                }
            }
        }
    } else {
        if (points.length >= 284) {
            console.log(`⚠️ [メリディオナル] 大量データ(${points.length}点)でオフセット未適用: zeroPosition=${zeroAberrationPosition}, method=${offsetMethod}`);
        }
    }
    
    // メリジオナル統計情報（簡潔版）
    if (points.length > 0) {
        const aberrations = points.map(p => p.transverseAberration);
        const maxAberration = Math.max(...aberrations.map(Math.abs));
        console.log(`📊 メリジオナル: ${points.length}点, 最大収差=${maxAberration.toFixed(4)}mm, オフセット=${offsetMethod}`);
    }
    
    console.log(`📊 メリジオナル点数: ${points.length}`);
    
    const result = {
        fieldSetting: fieldSetting,
        rayType: 'meridional',
        points: points,
        zeroAberrationPosition: zeroAberrationPosition,
        offsetMethod: offsetMethod,
        hasOffset: zeroAberrationPosition !== null && Math.abs(zeroAberrationPosition) > 1e-6
    };
    
    return result;
}

/**
 * 十字光線からサジタル横収差を計算
 * @param {Object} crossBeamData - 十字光線データ
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} targetSurfaceIndex - 評価面インデックス
 * @param {number} stopSurfaceIndex - 絞り面インデックス
 * @param {number} stopRadius - 絞り半径
 * @param {number} entrancePupilRadius - 入射瞳半径
 * @param {Object} fieldSetting - フィールド設定
 * @param {Object} targetSurfaceInfo - 評価面の座標変換情報
 * @param {Object} stopSurfaceInfo - 絞り面の座標変換情報
 * @param {number} mirrorSign - ミラーによる符号反転 (1 or -1)
 * @returns {Object} サジタル横収差データ
 */
function calculateSagittalAberrationFromCrossBeam(crossBeamData, opticalSystemRows, targetSurfaceIndex, stopSurfaceIndex, stopRadius, entrancePupilRadius, fieldSetting, targetSurfaceInfo = null, stopSurfaceInfo = null, mirrorSign = 1) {
    const points = [];
    
    if (!crossBeamData || !crossBeamData.rayGroups || crossBeamData.rayGroups.length === 0) {
        console.warn('⚠️ 十字光線データが無効です');
        return {
            fieldSetting: fieldSetting,
            rayType: 'sagittal',
            points: points
        };
    }
    
    const rayGroup = crossBeamData.rayGroups[0]; // 最初のオブジェクトグループ
    let chiefRay = null;
    const sagittalRays = [];
    
    // 🔧 ケラレ統計用
    let vignetteCount = 0;
    let successCount = 0;
    let partialButReachedStop = 0;
    
    // 主光線とサジタル光線を抽出
    const rayTypeCount = {};
    rayGroup.rays.forEach(ray => {
        rayTypeCount[ray.rayType] = (rayTypeCount[ray.rayType] || 0) + 1;
        
        if (ray.rayType === 'chief') {
            chiefRay = ray;
        } else if (ray.rayType === 'left_marginal' || ray.rayType === 'right_marginal' || 
                   ray.rayType === 'aperture_left' || ray.rayType === 'aperture_right' ||
                   ray.rayType === 'horizontal_cross') {  // horizontal_crossも明示的に含める
            sagittalRays.push(ray);
        }
    });
    
    // console.log(`🔍 サジタル光線タイプ分布:`, rayTypeCount);
    // console.log(`🔍 サジタル: 主光線=${chiefRay ? 'あり' : 'なし'}, 光線=${sagittalRays.length}本`);
    
    // サジタル光線の詳細を確認
    const sagittalTypes = sagittalRays.map(ray => ray.rayType);
    const sagittalTypeCounts = {};
    sagittalTypes.forEach(type => {
        sagittalTypeCounts[type] = (sagittalTypeCounts[type] || 0) + 1;
    });
    // console.log(`🔍 サジタル抽出光線:`, sagittalTypeCounts);
    
    if (!chiefRay) {
        console.warn('⚠️ 主光線が見つかりません');
        return {
            fieldSetting: fieldSetting,
            rayType: 'sagittal',
            points: points
        };
    }
    
    // 主光線の評価面での座標を取得
    const chiefIntersection = getIntersectionAtSurface(chiefRay, targetSurfaceIndex, opticalSystemRows, targetSurfaceInfo, mirrorSign);
    if (!chiefIntersection) {
        console.warn('⚠️ 主光線の評価面交点が見つかりません');
        return {
            fieldSetting: fieldSetting,
            rayType: 'sagittal',
            points: points
        };
    }
    
    const stopPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, stopSurfaceIndex);
    const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);

    // サジタル光線の絞り面でのX座標統計を収集（デバッグ用）
    const stopXCoordinates = [];
    sagittalRays.forEach(ray => {
        const stopIntersection = getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows);
        if (stopIntersection) {
            stopXCoordinates.push(stopIntersection.x);
        }
    });
    
    // 🔧 FIX: オフセット補正は不要（メリディオナルと同じロジック）
    // 絞り面X座標を直接使用して正規化する
    // NOTE: xOffset はデバッグ/部分光線用のみに使用
    let xOffset = 0;
    if (stopXCoordinates.length > 0) {
        const minX = Math.min(...stopXCoordinates);
        const maxX = Math.max(...stopXCoordinates);
        xOffset = (minX + maxX) / 2; // デバッグ用のみ
        console.log(`🎯 サジタル絞り面X座標: min=${minX.toFixed(3)}, max=${maxX.toFixed(3)}, オフセット=${xOffset.toFixed(3)}`);
    }
    
    // 🔧 FIX: 絞り面半径で正規化（全Objectで統一基準）
    // 光線は絞り面を通るように生成されているため、絞り半径で正規化すれば軸上で±1になる
    const maxCorrectedX = entrancePupilRadius;  // = stopRadius
    console.log(`🎯 サジタル正規化基準: 瞳半径=${maxCorrectedX.toFixed(3)}mm (絞り面半径)`);
    
    // 主光線の絞り面X座標も取得（参考用）
    const chiefStopIntersection = getIntersectionAtSurface(chiefRay, stopSurfaceIndex, opticalSystemRows, stopSurfaceInfo, mirrorSign);
    if (chiefStopIntersection) {
        console.log(`🎯 主光線絞り面X=${chiefStopIntersection.x.toFixed(3)}`);
    }
    
    // サジタル光線の横収差を計算（座標分布に基づく正規化）
    sagittalRays.forEach((ray, index) => {
        const intersection = getIntersectionAtSurface(ray, targetSurfaceIndex, opticalSystemRows, targetSurfaceInfo, mirrorSign);
        if (intersection) {
            // 絞り面での座標を取得
            const stopIntersection = getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows, stopSurfaceInfo, mirrorSign);
            if (stopIntersection) {
                // 🔧 FIX: X座標をオフセット補正せずに直接使用（メリディオナルと同じロジック）
                const stopX = stopIntersection.x;
                
                // 🔧 FIX: 事前に計算済みのmaxCorrectedXを使用（ループ内で再計算しない）
                const normalizedPupilCoord = maxCorrectedX > 0 ? stopX / maxCorrectedX : 0;
                
                const transverseAberration = intersection.x - chiefIntersection.x; // X方向の収差
                
                // 規格化座標が±1以内の光線を含める
                if (Math.abs(normalizedPupilCoord) <= 1.0) {
                    successCount++;
                    points.push({
                        pupilCoordinate: normalizedPupilCoord, // 座標分布に基づく正規化座標
                        transverseAberration: transverseAberration,
                        rayType: ray.rayType,
                        isPartial: ray.isPartial || false,
                        isFullSuccess: ray.isFullSuccess !== false,
                        failureReason: ray.failureReason || null,
                        actualCoordinate: {
                            x: intersection.x,
                            y: intersection.y
                        },
                        chiefReference: {
                            x: chiefIntersection.x,
                            y: chiefIntersection.y
                        },
                        stopCoordinate: {
                            x: stopIntersection.x,
                            y: stopIntersection.y,
                            maxCorrectedX: maxCorrectedX,
                            normalizedX: normalizedPupilCoord
                        }
                    });
                }
            }
        } else if (ray.isPartial && ray.path) {
            // 🔧 FIX: 絞り面に実際に到達しているかチェック（ケラレ検出）
            // 部分的な光線でも絞り面まで到達していれば処理する
            const stopIntersection = getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows);
            if (!stopIntersection) {
                // 絞り面に到達していない = ケラレている
                vignetteCount++;
                return; // この光線はスキップ
            }
            
            // 部分的な光線パスから最大限の情報を取得
            const maxSurfaceIndex = Math.min(
                ray.path.length - 1,
                Math.max(
                    Number.isInteger(targetPointIndex) ? targetPointIndex : 0,
                    Number.isInteger(stopPointIndex) ? stopPointIndex : 0
                )
            );
            
            if (stopIntersection) {
                const correctedStopX = stopIntersection.x - xOffset; // X座標をオフセット補正
                
                // 🔧 FIX: 事前に計算済みのmaxCorrectedXを使用（ループ内で再計算しない）
                const normalizedPupilCoord = maxCorrectedX > 0 ? correctedStopX / maxCorrectedX : 0;
                
                // 規格化座標が±1以内の光線を含める（座標分布基準）
                if (Math.abs(normalizedPupilCoord) <= 1.0) {
                    partialButReachedStop++;
                    // 評価面まで到達していない場合は外挿して推定
                    let estimatedIntersection = null;
                    if (Number.isInteger(targetPointIndex) && targetPointIndex <= maxSurfaceIndex) {
                        estimatedIntersection = getIntersectionAtSurface(ray, targetSurfaceIndex, opticalSystemRows);
                    } else {
                        // 外挿による推定（最後の2面から推定）
                        if (ray.path.length >= 2) {
                            const lastPoint = ray.path[ray.path.length - 1];
                            const secondLastPoint = ray.path[ray.path.length - 2];
                            // 簡単な線形外挿
                            const deltaZ = lastPoint.z - secondLastPoint.z;
                            if (Math.abs(deltaZ) > 1e-10 && targetSurfaceIndex < opticalSystemRows.length) {
                                const targetZ = opticalSystemRows[targetSurfaceIndex].position || 0;
                                const extrapolationFactor = (targetZ - lastPoint.z) / deltaZ;
                                estimatedIntersection = {
                                    x: lastPoint.x + (lastPoint.x - secondLastPoint.x) * extrapolationFactor,
                                    y: lastPoint.y + (lastPoint.y - secondLastPoint.y) * extrapolationFactor,
                                    z: targetZ
                                };
                            }
                        }
                    }
                    
                    if (estimatedIntersection) {
                        const transverseAberration = estimatedIntersection.x - chiefIntersection.x; // X方向の収差
                        
                        if (index < 2) {
                            console.log(`🔍 S光線 ${index} (外挿): X=${stopIntersection.x.toFixed(3)}→${correctedStopX.toFixed(3)}, 瞳座標=${normalizedPupilCoord.toFixed(3)}, X収差=${transverseAberration.toFixed(4)}`);
                        }
                        
                        points.push({
                            pupilCoordinate: normalizedPupilCoord, // 座標分布に基づく正規化座標
                            transverseAberration: transverseAberration,
                            rayType: ray.rayType,
                            isPartial: true,
                            isFullSuccess: false,
                            isExtrapolated: true,
                            failureReason: ray.failureReason || 'Partial ray path',
                            actualCoordinate: {
                                x: estimatedIntersection.x,
                                y: estimatedIntersection.y
                            },
                            chiefReference: {
                                x: chiefIntersection.x,
                                y: chiefIntersection.y
                            },
                            stopCoordinate: {
                                x: stopIntersection.x,
                                y: stopIntersection.y,
                                correctedX: correctedStopX,
                                xOffset: xOffset,
                                maxCorrectedX: maxCorrectedX,
                                normalizedX: normalizedPupilCoord
                            }
                        });
                    }
                }
            }
        }
    });
    
    // 🔧 FIX: 主光線を明示的に追加（Ray number偶数時に瞳座標=0が含まれない問題を回避）
    const chiefStopX = chiefStopIntersection ? chiefStopIntersection.x : 0;
    const chiefNormalizedPupilCoordSagittal = maxCorrectedX > 0 ? chiefStopX / maxCorrectedX : 0;
    
    // 主光線が既にpoints配列に含まれているか確認（重複回避）
    const chiefAlreadyExistsSagittal = points.some(p => Math.abs(p.pupilCoordinate - chiefNormalizedPupilCoordSagittal) < 1e-9);
    
    if (!chiefAlreadyExistsSagittal) {
        points.push({
            pupilCoordinate: chiefNormalizedPupilCoordSagittal,
            transverseAberration: 0, // 主光線の横収差は定義上0
            rayType: 'chief',
            isPartial: false,
            isFullSuccess: true,
            failureReason: null,
            actualCoordinate: {
                x: chiefIntersection.x,
                y: chiefIntersection.y
            },
            chiefReference: {
                x: chiefIntersection.x,
                y: chiefIntersection.y
            },
            stopCoordinate: {
                x: chiefStopX,
                y: chiefStopIntersection ? chiefStopIntersection.y : 0,
                maxCorrectedX: maxCorrectedX,
                normalizedX: chiefNormalizedPupilCoordSagittal
            }
        });
        console.log(`✅ [サジタル] 主光線を明示的に追加: 瞳座標=${chiefNormalizedPupilCoordSagittal.toFixed(6)}`);
    }
    
    // 瞳座標でソート
    points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
    
    // 🔧 ケラレ統計を出力
    console.log(`📊 [サジタル ${fieldSetting.displayName}] 光線統計: 成功=${successCount}, 部分的だが絞り到達=${partialButReachedStop}, ケラレ=${vignetteCount}, 合計=${sagittalRays.length}`);
    if (vignetteCount > 0) {
        const vignettePercent = ((vignetteCount / sagittalRays.length) * 100).toFixed(1);
        console.log(`⚠️ [サジタル ${fieldSetting.displayName}] ケラレ率: ${vignettePercent}% (${vignetteCount}/${sagittalRays.length}本)`);
    }
    
    // 横収差0位置を求める
    let zeroAberrationPosition = null;
    let offsetMethod = 'none';
    
    // 🔍 デバッグ: 光線数と範囲の確認（簡潔に）
    console.log(`🔍 [サジタル] データ点数: ${points.length}点`);
    
    if (points.length >= 3) {
        // 新しい統一手法：最小絶対値点とその前後3点による直線近似
        const minAbsZero = findZeroAberrationByMinAbsThreePoints(points);
        if (minAbsZero !== null) {
            zeroAberrationPosition = minAbsZero;
            offsetMethod = 'min_abs_3points';
            console.log(`📊 [サジタル] 最小絶対値3点法: 横収差0位置 = ${minAbsZero.toFixed(6)}`);
        } else {
            console.warn('⚠️ [サジタル] 最小絶対値3点法が失敗しました');
        }
    } else if (points.length === 2) {
        // 2点の場合は線形補間で横収差0位置を求める（フォールバック）
        const p1 = points[0];
        const p2 = points[1];
        
        // 収差値の符号が異なる場合のみ0点を計算
        if (p1.transverseAberration * p2.transverseAberration <= 0) {
            const deltaX = p2.pupilCoordinate - p1.pupilCoordinate;
            const deltaY = p2.transverseAberration - p1.transverseAberration;
            
            if (Math.abs(deltaY) > 1e-12) {
                // 線形補間: y = 0となるxを求める
                const t = -p1.transverseAberration / deltaY;
                zeroAberrationPosition = p1.pupilCoordinate + t * deltaX;
                offsetMethod = 'linear_2points';
                console.log(`📊 [サジタル] 線形補間（2点）: 横収差0位置 = ${zeroAberrationPosition.toFixed(6)}`);
                
                // 有効範囲内かチェック
                if (Math.abs(zeroAberrationPosition) > 1.5) {
                    console.warn('⚠️ [サジタル] 線形補間: 解が範囲外、フォールバック');
                    zeroAberrationPosition = null;
                    offsetMethod = 'none';
                }
            } else {
                console.warn('⚠️ [サジタル] 2点の収差値がほぼ同じため、0点を求められません');
            }
        } else {
            console.warn('⚠️ [サジタル] 2点の収差値の符号が同じため、0点は範囲外です');
        }
    } else {
        console.warn('⚠️ [サジタル] データ点数が不足しています（最低2点必要）');
    }
    
    // 横収差0位置でのオフセット適用
    if (zeroAberrationPosition !== null && Math.abs(zeroAberrationPosition) > 1e-6) {
        console.log(`🎯 [サジタル] プロットオフセット適用: ${zeroAberrationPosition.toFixed(6)} → 0 (手法: ${offsetMethod})`);
        
        // 284点以上の場合の特別ログ
        if (points.length >= 284) {
            console.log(`⚠️ [サジタル] 大量データ(${points.length}点)でのオフセット適用 - 精度チェック開始`);
            const beforeRange = `${Math.min(...points.map(p => p.pupilCoordinate)).toFixed(6)} 〜 ${Math.max(...points.map(p => p.pupilCoordinate)).toFixed(6)}`;
            console.log(`🔍 [サジタル] オフセット前範囲: ${beforeRange}`);
        }
        
        // 全点の瞳座標をオフセット
        points.forEach(point => {
            point.originalPupilCoordinate = point.pupilCoordinate; // 元の座標を保存
            point.pupilCoordinate -= zeroAberrationPosition; // オフセット適用
        });
        
        // オフセット後に再ソート
        points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        console.log(`📊 [サジタル] オフセット後の瞳座標範囲: ${points[0].pupilCoordinate.toFixed(6)} 〜 ${points[points.length-1].pupilCoordinate.toFixed(6)}`);
        
        // 284点以上の場合の精度確認
        if (points.length >= 284) {
            const zeroNearPoints = points.filter(p => Math.abs(p.pupilCoordinate) < 0.01);
            console.log(`🔍 [サジタル] 0近傍点数(±0.01): ${zeroNearPoints.length}点`);
            if (zeroNearPoints.length > 0) {
                const zeroPointAberration = zeroNearPoints.find(p => Math.abs(p.pupilCoordinate) < 0.001);
                if (zeroPointAberration) {
                    console.log(`✅ [サジタル] 0点近似確認: 瞳座標=${zeroPointAberration.pupilCoordinate.toFixed(6)}, 横収差=${zeroPointAberration.transverseAberration.toFixed(6)}`);
                }
            }
        }
    } else {
        if (points.length >= 284) {
            console.log(`⚠️ [サジタル] 大量データ(${points.length}点)でオフセット未適用: zeroPosition=${zeroAberrationPosition}, method=${offsetMethod}`);
        }
    }
    
    // サジタル統計情報（簡潔版）
    if (points.length > 0) {
        const aberrations = points.map(p => p.transverseAberration);
        const maxAberration = Math.max(...aberrations.map(Math.abs));
        console.log(`📊 サジタル: ${points.length}点, 最大収差=${maxAberration.toFixed(4)}mm, オフセット=${offsetMethod}`);
    }
    
    console.log(`📊 サジタル点数: ${points.length}`);
    
    const result = {
        fieldSetting: fieldSetting,
        rayType: 'sagittal',
        points: points,
        zeroAberrationPosition: zeroAberrationPosition,
        offsetMethod: offsetMethod,
        hasOffset: zeroAberrationPosition !== null && Math.abs(zeroAberrationPosition) > 1e-6
    };
    
    return result;
}

/**
 * 光線の指定面での交点を取得
 * @param {Object} ray - 光線データ
 * @param {number} surfaceIndex - 面インデックス
 * @param {Array} opticalSystemRows - 光学系データ
 * @returns {Object|null} 交点座標 {x, y, z} またはnull
 */
function isCoordTransRow(row) {
    const stRaw = String(row?.surfType ?? row?.['surf type'] ?? row?.surface_type ?? '').toLowerCase();
    const st = stRaw.trim();
    return st === 'coord trans' || st === 'coordinate break' || st === 'coordtrans' || st === 'coordinatebreak' || st === 'ct';
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

function getIntersectionAtSurface(ray, surfaceIndex, opticalSystemRows, surfaceInfo = null, mirrorSign = 1) {
    try {
        console.log(`🔧🔧 getIntersection ENTRY: surfIdx=${surfaceIndex}, hasInfo=${!!surfaceInfo}, hasMatrix=${!!(surfaceInfo?.rotationMatrix)}`);
        
        // 横収差計算用の評価面までのパスを優先使用
        const targetPath = ray.rayPathToTarget || ray.path;
        
        if (!targetPath || !Array.isArray(targetPath)) {
            console.warn('⚠️ 光線パスが無効です');
            return null;
        }
        
        let pointIndex = surfaceIndex;
        if (opticalSystemRows && Array.isArray(opticalSystemRows)) {
            const mapped = surfaceIndexToRayPathPointIndex(opticalSystemRows, surfaceIndex);
            if (mapped === null) return null;
            pointIndex = mapped;
        }

        if (pointIndex < 0 || pointIndex >= targetPath.length) {
            // 到達していない（ケラレ等）
            return null;
        }

        const intersectionGlobal = targetPath[pointIndex];
        if (intersectionGlobal && typeof intersectionGlobal.x === 'number' && typeof intersectionGlobal.y === 'number') {
            // Transverse aberration: 評価面がCTで回転している場合、
            // 評価面の局所座標系での座標を使用する必要がある
            let intersection = intersectionGlobal;
            
            if (surfaceInfo?.rotationMatrix) {
                // 回転行列を適用して局所座標系に変換
                intersection = applyRotationMatrixToVector(
                    intersectionGlobal,
                    surfaceInfo.rotationMatrix,
                    surfaceInfo.origin || { x: 0, y: 0, z: 0 }
                );
            }
            
            // Mirror signを適用（X軸周りの反射: Y座標のみ反転）
            const result = {
                x: intersection.x,
                y: intersection.y * mirrorSign,
                z: intersection.z || 0
            };
            
            console.log(`🎯 getIntersection: surfIdx=${surfaceIndex}, mirrorSign=${mirrorSign}, global=(${intersectionGlobal.x.toFixed(4)}, ${intersectionGlobal.y.toFixed(4)}), local=(${intersection.x.toFixed(4)}, ${intersection.y.toFixed(4)}), result=(${result.x.toFixed(4)}, ${result.y.toFixed(4)})`);
            return result;
        }
        
        return null;
    } catch (error) {
        console.error('❌ 交点取得エラー:', error);
        return null;
    }
}

/**
 * 絞り面インデックスを取得
 * @param {Array} opticalSystemRows - 光学系データ
 * @returns {number} 絞り面インデックス（見つからない場合は-1）
 */
export function findStopSurfaceIndex(opticalSystemRows) {
    const debugMode = TRANSVERSE_DEBUG;

    if (debugMode) console.log('🔍 絞り面を検索中...');
    
    if (!opticalSystemRows || !Array.isArray(opticalSystemRows)) {
        if (debugMode) console.warn('⚠️ 無効な光学系データです');
        return -1;
    }
    
    // パターン1: Object列に "Stop" を含む面を探す
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const objectType = surface.object || surface.Object || surface['object type'] || surface['Object Type'] || '';
        if (debugMode) console.log(`   Surface ${i + 1}: object type="${objectType}" (${typeof objectType})`);
        if (objectType && objectType.toString().toLowerCase().includes('stop')) {
            if (debugMode) console.log(`✅ 絞り面発見 (Object): Surface ${i + 1} - "${objectType}" [配列インデックス: ${i}]`);
            return i;
        }
    }
    
    // パターン2: Comment列に "stop", "aperture", "絞り" を含む面を探す
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const comment = (surface.comment || surface.Comment || '').toLowerCase();
        if (comment.includes('stop') || comment.includes('aperture') || comment.includes('絞り')) {
            if (debugMode) console.log(`✅ 絞り面発見 (Comment): Surface ${i + 1} - ${comment}`);
            return i;
        }
    }
    
    // パターン3: Type列に "Stop" を含む面を探す
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const type = surface.type || surface.Type || surface['surf type'] || surface['surfType'] || '';
        if (debugMode) console.log(`   Surface ${i + 1}: type="${type}" (${typeof type})`);
        if (type && type.toString().toLowerCase().includes('stop')) {
            if (debugMode) console.log(`✅ 絞り面発見 (Type): Surface ${i + 1} - "${type}" [配列インデックス: ${i}]`);
            return i;
        }
    }
    
    // パターン4: aperture が "INF" または無限大の面を絞りとする（物理的な絞り穴）
    if (debugMode) console.log('🔍 INF aperture面をチェック中...');
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const apertureRaw = (surface.aperture || surface.Aperture || '').toString().toUpperCase();
        
        if (apertureRaw === 'INF' || apertureRaw === 'INFINITY' || apertureRaw === '∞') {
            if (debugMode) console.log(`✅ 絞り面発見 (INF aperture): Surface ${i + 1} - aperture=${apertureRaw}`);
            return i;
        }
    }
    
    // パターン5: 最小aperture値を持つ面を絞りとする
    let minAperture = Infinity;
    let stopIndex = -1;
    
    if (debugMode) console.log('🔍 全面のaperture値をチェック中...');
    
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const apertureRaw = surface.aperture || surface.Aperture || surface.semidia || surface.SemiDia;
        const aperture = Math.abs(parseFloat(apertureRaw || Infinity));
        
        // より詳細なデバッグ情報
        if (debugMode) console.log(`   Surface ${i + 1}:`);
        if (debugMode) console.log(`     aperture="${surface.aperture}", Aperture="${surface.Aperture}"`);
        if (debugMode) console.log(`     semidia="${surface.semidia}", SemiDia="${surface.SemiDia}"`);
        if (debugMode) console.log(`     → 使用値="${apertureRaw}" → 数値=${aperture} (有限:${isFinite(aperture)}, >0:${aperture > 0})`);
        
        if (isFinite(aperture) && aperture > 0 && aperture < minAperture) {
            minAperture = aperture;
            stopIndex = i;
            if (debugMode) console.log(`   → 新しい最小aperture面: Surface ${i + 1} (${aperture}) [配列インデックス: ${i}]`);
        }
    }
    
    if (stopIndex !== -1) {
        if (debugMode) console.log(`✅ 絞り面推定 (最小aperture): Surface ${stopIndex + 1} - aperture=${minAperture}`);
        if (debugMode) console.log(`   → 配列インデックス=${stopIndex}, 表示用Surface番号=${stopIndex + 1}`);
        return stopIndex;
    }
    
    // フォールバック: 光学系の中央付近の面を絞りとする
    if (opticalSystemRows.length > 2) {
        const middleIndex = Math.floor(opticalSystemRows.length / 2);
        if (debugMode) console.log(`⚠️ 絞り面が見つからないため、中央の面を使用: Surface ${middleIndex + 1}`);
        return middleIndex;
    }
    
    console.error('❌ 絞り面を特定できませんでした');
    return -1;
}

/**
 * Objectテーブルからフィールド設定を取得
 * @returns {Array} フィールド設定配列
 */
function getFieldSettingsFromObject() {
    const fieldSettings = [];
    const debugMode = TRANSVERSE_DEBUG;
    
    try {
        if (window.tableObject && typeof window.tableObject.getData === 'function') {
            const objectData = window.tableObject.getData();
            
            if (debugMode) console.log('🔍 [DEBUG] Object テーブルデータ取得:', objectData);
            
            objectData.forEach((row, index) => {
                if (debugMode) console.log(`🔍 [DEBUG] Object ${index + 1} 行データ:`, row);
                if (debugMode) console.log(`🔍 [DEBUG] Object ${index + 1} フィールド一覧:`, Object.keys(row));
                
                // position フィールドの詳細チェック
                if (debugMode) console.log(`🔍 [DEBUG] Object ${index + 1} position関連:`, {
                    position: row.position,
                    Position: row.Position,
                    positionType: typeof row.position,
                    PositionType: typeof row.Position
                });
                
                // 座標フィールドの詳細チェック
                if (debugMode) console.log(`🔍 [DEBUG] Object ${index + 1} 座標関連:`, {
                    x: row.x, X: row.X, xHeightAngle: row.xHeightAngle,
                    y: row.y, Y: row.Y, yHeightAngle: row.yHeightAngle,
                    height: row.height, Height: row.Height,
                    angle: row.angle, Angle: row.Angle
                });
                
                // displayName の構築を改善
                let displayName = `Object ${index + 1}`;
                if (row.comment && row.comment.trim() !== '') {
                    displayName += ` - ${row.comment}`;
                }
                
                // より柔軟な位置タイプ判定
                const positionType = (row.position || row.Position || '').toLowerCase();
                const isRectangle = positionType.includes('rectangle') || positionType.includes('rect') || positionType.includes('height') || positionType.includes('座標');
                const isAngle = positionType.includes('angle') || positionType.includes('角度');
                
                if (debugMode) console.log(`🔍 [DEBUG] Object ${index + 1} 位置タイプ判定: positionType="${positionType}", isRectangle=${isRectangle}, isAngle=${isAngle}`);
                
                if (isRectangle) {
                    // より多くのフィールド名パターンを試行
                    const xValue = parseFloat(
                        row.x || row.X || row.xHeight || row.XHeight || 
                        row.xHeightAngle || row.XHeightAngle || 
                        row.height_x || row.Height_X || 0
                    );
                    const yValue = parseFloat(
                        row.y || row.Y || row.yHeight || row.YHeight || 
                        row.yHeightAngle || row.YHeightAngle || 
                        row.height_y || row.Height_Y || 0
                    );
                    
                    if (debugMode) console.log(`🔍 [DEBUG] Object ${index + 1} Rectangle: x=${xValue}, y=${yValue}`);
                    
                    displayName += ` (${xValue}, ${yValue})`;
                    
                    fieldSettings.push({
                        objectIndex: index + 1,
                        fieldType: 'Rectangle',
                        xHeight: xValue,
                        yHeight: yValue,
                        displayName: displayName
                    });
                } else if (isAngle) {
                    // より多くのフィールド名パターンを試行
                    const xAngle = parseFloat(
                        row.xHeightAngle || row.XHeightAngle || 
                        row.xAngle || row.XAngle || 
                        row.x || row.X || 
                        row.angle_x || row.Angle_X || 0
                    );
                    const yAngle = parseFloat(
                        row.yHeightAngle || row.YHeightAngle || 
                        row.yAngle || row.YAngle || 
                        row.y || row.Y || 
                        row.angle_y || row.Angle_Y || 0
                    );
                    
                    console.log(`🔍 [DEBUG] Object ${index + 1} Angle: xAngle=${xAngle}°, yAngle=${yAngle}°`);
                    console.log(`🔍 [DEBUG] Object ${index + 1} 原データ: xHeightAngle=${row.xHeightAngle}, x=${row.x}, X=${row.X}`);
                    console.log(`🔍 [DEBUG] Object ${index + 1} 原データ: yHeightAngle=${row.yHeightAngle}, y=${row.y}, Y=${row.Y}`);
                    
                    displayName += ` (${xAngle}°, ${yAngle}°)`;
                    
                    fieldSettings.push({
                        objectIndex: index + 1,
                        fieldType: 'Angle',
                        fieldAngle: yAngle, // 単一値として扱う
                        xFieldAngle: xAngle,
                        yFieldAngle: yAngle,
                        displayName: displayName
                    });
                } else {
                    // position が設定されていない場合のフォールバック
                    console.log(`🔍 [DEBUG] Object ${index + 1} position未設定 - 座標として試行`);
                    
                    const xValue = parseFloat(
                        row.x || row.X || row.xHeight || row.XHeight || 
                        row.xHeightAngle || row.XHeightAngle || 0
                    );
                    const yValue = parseFloat(
                        row.y || row.Y || row.yHeight || row.YHeight || 
                        row.yHeightAngle || row.YHeightAngle || 0
                    );
                    
                    console.log(`🔍 [DEBUG] Object ${index + 1} フォールバック座標: x=${xValue}, y=${yValue}`);
                    
                    displayName += ` (${xValue}, ${yValue})`;
                    
                    fieldSettings.push({
                        objectIndex: index + 1,
                        fieldType: 'Rectangle', // デフォルトでRectangleとして扱う
                        xHeight: xValue,
                        yHeight: yValue,
                        displayName: displayName
                    });
                }
            });
        }
        
        // フォールバック：Sourceテーブルから画角を取得
        if (fieldSettings.length === 0) {
            const fieldAngles = getFieldAnglesFromSource();
            fieldAngles.forEach((angle, index) => {
                fieldSettings.push({
                    objectIndex: index + 1,
                    fieldType: 'Angle',
                    fieldAngle: angle,
                    yFieldAngle: angle,
                    displayName: `Field Angle ${angle}°`
                });
            });
        }
        
    } catch (error) {
        console.error('❌ フィールド設定取得エラー:', error);
        // フォールバック
        fieldSettings.push({
            objectIndex: 1,
            fieldType: 'Angle',
            fieldAngle: 0,
            yFieldAngle: 0,
            displayName: 'On-Axis'
        });
    }
    
    console.log('🔍 [DEBUG] 最終fieldSettings:', fieldSettings);
    return fieldSettings;
}

/**
 * Sourceテーブルから画角データを取得
 * @returns {Array} 画角配列 (度)
 */
export function getFieldAnglesFromSource() {
    const fieldAngles = [];
    
    try {
        if (window.tableSource && typeof window.tableSource.getData === 'function') {
            const sourceData = window.tableSource.getData();
            
            sourceData.forEach(row => {
                if (row.type === 'Angle' || row.Type === 'Angle') {
                    const angle = parseFloat(row.angle || row.Angle || 0);
                    if (!isNaN(angle)) {
                        fieldAngles.push(angle);
                    }
                }
            });
        }
        
        // デフォルト画角
        if (fieldAngles.length === 0) {
            fieldAngles.push(0, 5, 10);
        }
        
    } catch (error) {
        console.error('❌ 画角取得エラー:', error);
        fieldAngles.push(0, 5, 10);
    }
    
    return fieldAngles;
}

/**
 * 主波長を取得
 * @returns {number} 主波長 (μm)
 */
export function getPrimaryWavelengthForAberration() {
    try {
        if (window.tableSource && typeof window.tableSource.getData === 'function') {
            const sourceData = window.tableSource.getData();
            const primaryEntry = sourceData.find(row => row.primary === "Primary Wavelength");
            
            if (primaryEntry && primaryEntry.wavelength) {
                const wavelength = parseFloat(primaryEntry.wavelength);
                if (!isNaN(wavelength) && wavelength > 0) {
                    return wavelength;
                }
            }
        }
    } catch (error) {
        console.error('❌ 主波長取得エラー:', error);
    }
    
    return 0.5876; // d線デフォルト
}

/**
 * 最小絶対値点とその前後3点を使った直線近似による横収差0位置計算
 * @param {Array} points - 横収差データ点 [{pupilCoordinate, transverseAberration}]
 * @returns {number|null} 横収差0となる瞳座標位置
 */
function findZeroAberrationByMinAbsThreePoints(points) {
    if (!points || points.length < 3) {
        console.warn('⚠️ 最小絶対値3点法には最低3点必要です');
        return null;
    }
    
    try {
        // 有効なデータ点のみを使用
        const validPoints = points.filter(p => 
            isFinite(p.pupilCoordinate) && 
            isFinite(p.transverseAberration) &&
            Math.abs(p.pupilCoordinate) <= 1.0
        );
        
        if (validPoints.length < 3) {
            console.warn('⚠️ 最小絶対値3点法: 有効なデータ点が不足');
            return null;
        }
        
        // 瞳座標でソート
        validPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        console.log(`🔧 [MinAbs3Points] ${validPoints.length}点から最小絶対値点を検索`);
        
        // 横収差の絶対値が最小の点を見つける
        let minAbsIndex = 0;
        let minAbsValue = Math.abs(validPoints[0].transverseAberration);
        
        for (let i = 1; i < validPoints.length; i++) {
            const absValue = Math.abs(validPoints[i].transverseAberration);
            if (absValue < minAbsValue) {
                minAbsValue = absValue;
                minAbsIndex = i;
            }
        }
        
        const minAbsPoint = validPoints[minAbsIndex];
        console.log(`🎯 [MinAbs3Points] 最小絶対値点: index=${minAbsIndex}, 瞳座標=${minAbsPoint.pupilCoordinate.toFixed(6)}, 横収差=${minAbsPoint.transverseAberration.toFixed(6)}`);
        
        // 最小絶対値点とその前後の点を取得（合計3点）
        let selectedPoints = [];
        
        if (minAbsIndex === 0) {
            // 最初の点が最小の場合：最初の3点を使用
            selectedPoints = validPoints.slice(0, 3);
            console.log(`🔧 [MinAbs3Points] 最初の点が最小：最初の3点を使用`);
        } else if (minAbsIndex === validPoints.length - 1) {
            // 最後の点が最小の場合：最後の3点を使用
            selectedPoints = validPoints.slice(-3);
            console.log(`🔧 [MinAbs3Points] 最後の点が最小：最後の3点を使用`);
        } else {
            // 中間の点が最小の場合：前の点、最小点、後の点の3点を使用
            selectedPoints = [
                validPoints[minAbsIndex - 1],
                validPoints[minAbsIndex],
                validPoints[minAbsIndex + 1]
            ];
            console.log(`🔧 [MinAbs3Points] 中間点が最小：前後3点を使用 (${minAbsIndex-1}, ${minAbsIndex}, ${minAbsIndex+1})`);
        }
        
        // 選択された3点の詳細ログ
        console.log(`🔍 [MinAbs3Points] 選択された3点:`);
        selectedPoints.forEach((point, index) => {
            console.log(`   点${index + 1}: 瞳座標=${point.pupilCoordinate.toFixed(6)}, 横収差=${point.transverseAberration.toFixed(6)}`);
        });
        
        // 3点を使って直線近似 (最小二乗法)
        const n = selectedPoints.length;
        let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
        
        for (let i = 0; i < n; i++) {
            const x = selectedPoints[i].pupilCoordinate;
            const y = selectedPoints[i].transverseAberration;
            sumX += x;
            sumY += y;
            sumXY += x * y;
            sumX2 += x * x;
        }
        
        // 直線の式: y = a*x + b
        // 最小二乗法による係数計算
        const denominator = n * sumX2 - sumX * sumX;
        if (Math.abs(denominator) < 1e-12) {
            console.warn('⚠️ [MinAbs3Points] 直線近似失敗：分母が0に近い');
            return null;
        }
        
        const a = (n * sumXY - sumX * sumY) / denominator; // 傾き
        const b = (sumY - a * sumX) / n; // 切片
        
        console.log(`📊 [MinAbs3Points] 直線近似: y = ${a.toFixed(6)} * x + ${b.toFixed(6)}`);
        
        // y = 0となるx座標を計算: 0 = a*x + b → x = -b/a
        if (Math.abs(a) < 1e-12) {
            console.warn('⚠️ [MinAbs3Points] 傾きが0に近いため、0交点を計算できません');
            // 傾きが0の場合は最小絶対値点のx座標を返す
            console.log(`🔧 [MinAbs3Points] フォールバック：最小絶対値点のx座標を採用`);
            return minAbsPoint.pupilCoordinate;
        }
        
        const zeroX = -b / a;
        
        console.log(`✅ [MinAbs3Points] 直線近似結果: 横収差0位置 = ${zeroX.toFixed(6)}`);
        
        // 結果の妥当性チェック
        if (!isFinite(zeroX)) {
            console.warn('⚠️ [MinAbs3Points] 計算結果が無限値です');
            return minAbsPoint.pupilCoordinate;
        }
        
        // 有効範囲チェック（±1.5程度まで許容）
        if (Math.abs(zeroX) > 1.5) {
            console.warn(`⚠️ [MinAbs3Points] 結果が範囲外: ${zeroX.toFixed(6)}, 最小絶対値点を採用`);
            return minAbsPoint.pupilCoordinate;
        }
        
        // 近似の品質チェック
        const approximationErrors = selectedPoints.map(point => {
            const predictedY = a * point.pupilCoordinate + b;
            return Math.abs(predictedY - point.transverseAberration);
        });
        const maxError = Math.max(...approximationErrors);
        const avgError = approximationErrors.reduce((sum, err) => sum + err, 0) / approximationErrors.length;
        
        console.log(`📊 [MinAbs3Points] 近似品質: 最大誤差=${maxError.toFixed(6)}, 平均誤差=${avgError.toFixed(6)}`);
        
        return zeroX;
        
    } catch (error) {
        console.error('❌ [MinAbs3Points] エラー:', error);
        return null;
    }
}

/**
 * 横収差データを検証・統計情報を出力
 * @param {Object} aberrationData - 横収差データ
 */
export function validateAberrationData(aberrationData) {
    console.log('🔍 横収差データ検証:');
    console.log(`- 光学系タイプ: ${aberrationData.isFiniteSystem ? '有限系' : '無限系'}`);
    console.log(`- フィールド数: ${aberrationData.fieldSettings.length}`);
    console.log(`- 波長: ${aberrationData.wavelength} μm`);
    console.log(`- 評価面: ${aberrationData.targetSurface + 1}`);
    console.log(`- 絞り面: ${aberrationData.stopSurface + 1}`);
    
    aberrationData.meridionalData.forEach((data, index) => {
        const validPoints = data.points.filter(p => !isNaN(p.transverseAberration)).length;
        const maxAberration = validPoints > 0 ? Math.max(...data.points.map(p => Math.abs(p.transverseAberration))) : 0;
        console.log(`- ${data.fieldSetting.displayName} (M): ${validPoints}点, 最大収差 ${maxAberration.toFixed(4)}mm`);
    });
    
    aberrationData.sagittalData.forEach((data, index) => {
        const validPoints = data.points.filter(p => !isNaN(p.transverseAberration)).length;
        const maxAberration = validPoints > 0 ? Math.max(...data.points.map(p => Math.abs(p.transverseAberration))) : 0;
        console.log(`- ${data.fieldSetting.displayName} (S): ${validPoints}点, 最大収差 ${maxAberration.toFixed(4)}mm`);
    });
}

/**
 * 3次多項式フィッティングによる横収差0の位置を求める
 * @param {Array} points - 横収差データ点 [{pupilCoordinate, transverseAberration}]
 * @returns {number|null} 横収差0となる瞳座標位置
 */
function findZeroAberrationByPolynomialFitting(points) {
    if (!points || points.length < 4) {
        console.warn('⚠️ 多項式フィッティングには最低4点必要です');
        return null;
    }
    
    try {
        // 有効なデータ点のみを使用
        const validPoints = points.filter(p => 
            isFinite(p.pupilCoordinate) && 
            isFinite(p.transverseAberration) &&
            Math.abs(p.pupilCoordinate) <= 1.0
        );
        
        if (validPoints.length < 4) {
            console.warn('⚠️ 有効なデータ点が不足です');
            return null;
        }
        
        // 瞳座標でソート
        validPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        // 大量データ（284点以上）の場合は代表点を選択して数値安定性を向上
        let fittingPoints = validPoints;
        if (validPoints.length >= 284) {
            console.log(`🔧 大量データ検出（${validPoints.length}点）: 代表点サンプリングを実行`);
            
            // 3段階サンプリング戦略
            // 1) 重要な領域（0近傍、±1近傍）は密に保持
            // 2) 中間領域は適度にサンプリング
            // 3) 全体で最大120点程度に抑制
            
            const zeroNearPoints = validPoints.filter(p => Math.abs(p.pupilCoordinate) < 0.1);
            const edgeNearPoints = validPoints.filter(p => Math.abs(Math.abs(p.pupilCoordinate) - 1.0) < 0.1);
            const middlePoints = validPoints.filter(p => 
                Math.abs(p.pupilCoordinate) >= 0.1 && 
                Math.abs(Math.abs(p.pupilCoordinate) - 1.0) >= 0.1
            );
            
            fittingPoints = [];
            
            // 0近傍は全て保持
            fittingPoints.push(...zeroNearPoints);
            console.log(`🔧 0近傍保持: ${zeroNearPoints.length}点`);
            
            // エッジ近傍も全て保持
            edgeNearPoints.forEach(point => {
                const exists = fittingPoints.some(fp => 
                    Math.abs(fp.pupilCoordinate - point.pupilCoordinate) < 0.01
                );
                if (!exists) {
                    fittingPoints.push(point);
                }
            });
            console.log(`🔧 エッジ近傍追加後: ${fittingPoints.length}点`);
            
            // 中間領域は等間隔サンプリング
            if (middlePoints.length > 0) {
                const targetMiddleCount = Math.max(40, Math.min(80, Math.floor(validPoints.length / 10)));
                const step = Math.max(1, Math.floor(middlePoints.length / targetMiddleCount));
                for (let i = 0; i < middlePoints.length; i += step) {
                    const point = middlePoints[i];
                    const exists = fittingPoints.some(fp => 
                        Math.abs(fp.pupilCoordinate - point.pupilCoordinate) < 0.01
                    );
                    if (!exists) {
                        fittingPoints.push(point);
                    }
                }
            }
            
            // 再ソート
            fittingPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
            console.log(`🔧 最終サンプリング完了: ${fittingPoints.length}点を選択（元: ${validPoints.length}点）`);
            
            // サンプリングが適切か確認
            const sampledRange = fittingPoints.length > 0 ? 
                `${fittingPoints[0].pupilCoordinate.toFixed(3)} 〜 ${fittingPoints[fittingPoints.length-1].pupilCoordinate.toFixed(3)}` : '不明';
            console.log(`🔧 サンプリング範囲: ${sampledRange}`);
        }
        
        // 3次多項式フィッティング: y = a*x³ + b*x² + c*x + d
        const n = fittingPoints.length;
        const A = [];
        const B = [];
        
        // 連立方程式の係数行列を構築（数値安定性のため正規化）
        for (let i = 0; i < n; i++) {
            const x = fittingPoints[i].pupilCoordinate;
            const y = fittingPoints[i].transverseAberration;
            A.push([x*x*x, x*x, x, 1]);
            B.push(y);
        }
        
        // 最小二乗法で係数を求める（改良版）
        const coeffs = solveLeastSquaresStable(A, B);
        if (!coeffs || coeffs.length !== 4) {
            console.warn('⚠️ 多項式フィッティングに失敗、大量データ用区分的線形補間にフォールバック');
            
            // 大量データ用の区分的線形補間
            if (validPoints.length >= 284) {
                return findZeroAberrationByPiecewiseLinear(validPoints);
            } else {
                return findZeroAberrationByLinearInterpolation(points);
            }
        }
        
        const [a, b, c, d] = coeffs;
        console.log(`📊 3次多項式係数: a=${a.toFixed(6)}, b=${b.toFixed(6)}, c=${c.toFixed(6)}, d=${d.toFixed(6)}`);
        
        // 3次方程式 a*x³ + b*x² + c*x + d = 0 の解を求める
        const roots = solveCubicEquation(a, b, c, d);
        
        // 実根のうち[-1, 1]範囲内の解を選択
        const validRoots = roots.filter(root => 
            typeof root === 'number' && 
            isFinite(root) && 
            Math.abs(root) <= 1.0
        );
        
        if (validRoots.length === 0) {
            console.warn('⚠️ 有効な解が見つかりません、大量データ用区分的線形補間にフォールバック');
            
            // 大量データ用の区分的線形補間
            if (validPoints.length >= 284) {
                return findZeroAberrationByPiecewiseLinear(validPoints);
            } else {
                return findZeroAberrationByLinearInterpolation(points);
            }
        }
        
        // 最も0に近い解を選択
        const bestRoot = validRoots.reduce((prev, curr) => 
            Math.abs(curr) < Math.abs(prev) ? curr : prev
        );
        
        console.log(`✅ フィッティング結果: 横収差0位置 = ${bestRoot.toFixed(6)}`);
        return bestRoot;
        
    } catch (error) {
        console.error('❌ 多項式フィッティングエラー:', error);
        console.log('🔧 大量データ用区分的線形補間にフォールバック');
        
        // 大量データ用の区分的線形補間
        if (points && points.length >= 284) {
            return findZeroAberrationByPiecewiseLinear(points);
        } else {
            return findZeroAberrationByLinearInterpolation(points);
        }
    }
}

/**
 * ニュートン法による横収差0の位置を求める
 * @param {Array} points - 横収差データ点
 * @returns {number|null} 横収差0となる瞳座標位置
 */
function findZeroAberrationByNewtonMethod(points) {
    if (!points || points.length < 2) {
        console.warn('⚠️ ニュートン法には最低2点必要です');
        return null;
    }
    
    try {
        // 有効なデータ点のみを使用
        const validPoints = points.filter(p => 
            isFinite(p.pupilCoordinate) && 
            isFinite(p.transverseAberration) &&
            Math.abs(p.pupilCoordinate) <= 1.0
        );
        
        if (validPoints.length < 2) {
            console.warn('⚠️ ニュートン法: 有効なデータ点が不足です');
            return null;
        }
        
        // 瞳座標でソート
        validPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        // 2点の場合は線形補間を使用
        if (validPoints.length === 2) {
            const p1 = validPoints[0];
            const p2 = validPoints[1];
            
            if (p1.transverseAberration * p2.transverseAberration <= 0) {
                const deltaX = p2.pupilCoordinate - p1.pupilCoordinate;
                const deltaY = p2.transverseAberration - p1.transverseAberration;
                
                if (Math.abs(deltaY) > 1e-12) {
                    const t = -p1.transverseAberration / deltaY;
                    const zeroX = p1.pupilCoordinate + t * deltaX;
                    
                    if (Math.abs(zeroX) <= 1.0) {
                        console.log(`✅ ニュートン法（2点線形）: 横収差0位置 = ${zeroX.toFixed(6)}`);
                        return zeroX;
                    }
                }
            }
            console.warn('⚠️ ニュートン法（2点）: 有効な0点が見つかりません');
            return null;
        }
        
        // 線形補間による関数値と微分値の計算
        function interpolateValue(x) {
            // 線形補間で横収差値を求める
            for (let i = 0; i < validPoints.length - 1; i++) {
                const p1 = validPoints[i];
                const p2 = validPoints[i + 1];
                
                if (x >= p1.pupilCoordinate && x <= p2.pupilCoordinate) {
                    const t = (x - p1.pupilCoordinate) / (p2.pupilCoordinate - p1.pupilCoordinate);
                    return p1.transverseAberration + t * (p2.transverseAberration - p1.transverseAberration);
                }
            }
            
            // 範囲外の場合は外挿
            if (x < validPoints[0].pupilCoordinate) {
                const p1 = validPoints[0];
                const p2 = validPoints[1];
                const slope = (p2.transverseAberration - p1.transverseAberration) / (p2.pupilCoordinate - p1.pupilCoordinate);
                return p1.transverseAberration + slope * (x - p1.pupilCoordinate);
            } else {
                const p1 = validPoints[validPoints.length - 2];
                const p2 = validPoints[validPoints.length - 1];
                const slope = (p2.transverseAberration - p1.transverseAberration) / (p2.pupilCoordinate - p1.pupilCoordinate);
                return p2.transverseAberration + slope * (x - p2.pupilCoordinate);
            }
        }
        
        function interpolateDerivative(x) {
            // 微分の近似計算
            const h = 0.001;
            return (interpolateValue(x + h) - interpolateValue(x - h)) / (2 * h);
        }
        
        // ニュートン法による解の探索
        let x = 0; // 初期値は0（光軸近傍）
        const maxIterations = 50;
        const tolerance = 1e-8;
        
        for (let iter = 0; iter < maxIterations; iter++) {
            const f = interpolateValue(x);
            const df = interpolateDerivative(x);
            
            if (Math.abs(df) < 1e-12) {
                console.warn('⚠️ ニュートン法: 微分値が0に近すぎます');
                break;
            }
            
            const dx = -f / df;
            x += dx;
            
            // 収束判定
            if (Math.abs(dx) < tolerance) {
                console.log(`✅ ニュートン法収束: ${iter + 1}回反復, 横収差0位置 = ${x.toFixed(6)}`);
                
                // 解が有効範囲内かチェック
                if (Math.abs(x) <= 1.0) {
                    return x;
                } else {
                    console.warn('⚠️ ニュートン法: 解が有効範囲外です');
                    return null;
                }
            }
            
            // 発散防止
            if (Math.abs(x) > 2.0) {
                console.warn('⚠️ ニュートン法: 発散しました');
                return null;
            }
        }
        
        console.warn('⚠️ ニュートン法: 最大反復数に達しました');
        return null;
        
    } catch (error) {
        console.error('❌ ニュートン法エラー:', error);
        return null;
    }
}

/**
 * 最小二乗法による連立方程式の解（数値安定版）
 * @param {Array} A - 係数行列
 * @param {Array} B - 定数ベクトル
 * @returns {Array|null} 解ベクトル
 */
function solveLeastSquaresStable(A, B) {
    try {
        const m = A.length; // 方程式の数
        const n = A[0].length; // 未知数の数
        
        // 大きなデータセットで数値安定性を向上させるため、SVD風の処理を簡易実装
        // ここでは行列の条件数を改善する前処理を行う
        
        // 列の正規化（各変数の影響を平衡化）
        const colNorms = new Array(n).fill(0);
        for (let j = 0; j < n; j++) {
            for (let i = 0; i < m; i++) {
                colNorms[j] += A[i][j] * A[i][j];
            }
            colNorms[j] = Math.sqrt(colNorms[j]);
        }
        
        // 正規化した行列を作成
        const A_normalized = [];
        for (let i = 0; i < m; i++) {
            A_normalized[i] = [];
            for (let j = 0; j < n; j++) {
                A_normalized[i][j] = colNorms[j] > 1e-12 ? A[i][j] / colNorms[j] : A[i][j];
            }
        }
        
        // A^T * A を計算（正規化版）
        const AtA = [];
        for (let i = 0; i < n; i++) {
            AtA[i] = [];
            for (let j = 0; j < n; j++) {
                let sum = 0;
                for (let k = 0; k < m; k++) {
                    sum += A_normalized[k][i] * A_normalized[k][j];
                }
                AtA[i][j] = sum;
            }
        }
        
        // A^T * B を計算（正規化版）
        const AtB = [];
        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let k = 0; k < m; k++) {
                sum += A_normalized[k][i] * B[k];
            }
            AtB[i] = sum;
        }
        
        // 対角要素に微小値を加算して特異性を回避
        for (let i = 0; i < n; i++) {
            AtA[i][i] += 1e-12;
        }
        
        // ガウス消去法で解く
        const solution = solveLinearSystem(AtA, AtB);
        
        if (!solution) {
            return null;
        }
        
        // 正規化を元に戻す
        for (let i = 0; i < n; i++) {
            if (colNorms[i] > 1e-12) {
                solution[i] /= colNorms[i];
            }
        }
        
        return solution;
        
    } catch (error) {
        console.error('❌ 数値安定版最小二乗法エラー:', error);
        // フォールバックとして通常版を試行
        return solveLeastSquares(A, B);
    }
}

/**
 * 最小二乗法による連立方程式の解（簡易版）
 * @param {Array} A - 係数行列
 * @param {Array} B - 定数ベクトル
 * @returns {Array|null} 解ベクトル
 */
function solveLeastSquares(A, B) {
    try {
        const m = A.length; // 方程式の数
        const n = A[0].length; // 未知数の数
        
        // A^T * A を計算
        const AtA = [];
        for (let i = 0; i < n; i++) {
            AtA[i] = [];
            for (let j = 0; j < n; j++) {
                let sum = 0;
                for (let k = 0; k < m; k++) {
                    sum += A[k][i] * A[k][j];
                }
                AtA[i][j] = sum;
            }
        }
        
        // A^T * B を計算
        const AtB = [];
        for (let i = 0; i < n; i++) {
            let sum = 0;
            for (let k = 0; k < m; k++) {
                sum += A[k][i] * B[k];
            }
            AtB[i] = sum;
        }
        
        // ガウス消去法で解く（簡易版）
        return solveLinearSystem(AtA, AtB);
        
    } catch (error) {
        console.error('❌ 最小二乗法エラー:', error);
        return null;
    }
}

/**
 * ガウス消去法による連立一次方程式の解
 * @param {Array} A - 係数行列
 * @param {Array} B - 定数ベクトル
 * @returns {Array|null} 解ベクトル
 */
function solveLinearSystem(A, B) {
    try {
        const n = A.length;
        const Ab = A.map((row, i) => [...row, B[i]]);
        
        // 前進消去
        for (let i = 0; i < n; i++) {
            // ピボット選択
            let maxRow = i;
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(Ab[k][i]) > Math.abs(Ab[maxRow][i])) {
                    maxRow = k;
                }
            }
            
            // 行交換
            [Ab[i], Ab[maxRow]] = [Ab[maxRow], Ab[i]];
            
            // 前進消去
            for (let k = i + 1; k < n; k++) {
                if (Math.abs(Ab[i][i]) < 1e-12) continue;
                const factor = Ab[k][i] / Ab[i][i];
                for (let j = i; j < n + 1; j++) {
                    Ab[k][j] -= factor * Ab[i][j];
                }
            }
        }
        
        // 後退代入
        const x = new Array(n);
        for (let i = n - 1; i >= 0; i--) {
            x[i] = Ab[i][n];
            for (let j = i + 1; j < n; j++) {
                x[i] -= Ab[i][j] * x[j];
            }
            if (Math.abs(Ab[i][i]) < 1e-12) {
                console.warn('⚠️ 特異行列です');
                return null;
            }
            x[i] /= Ab[i][i];
        }
        
        return x;
        
    } catch (error) {
        console.error('❌ ガウス消去法エラー:', error);
        return null;
    }
}

/**
 * 3次方程式の実根を求める（カルダノの公式）
 * @param {number} a - x³の係数
 * @param {number} b - x²の係数
 * @param {number} c - xの係数
 * @param {number} d - 定数項
 * @returns {Array} 実根の配列
 */
function solveCubicEquation(a, b, c, d) {
    try {
        if (Math.abs(a) < 1e-12) {
            // 2次方程式として解く
            return solveQuadraticEquation(b, c, d);
        }
        
        // 正規化
        b /= a;
        c /= a;
        d /= a;
        
        // Tschirnhaus変換: t = x + b/3
        const p = c - b * b / 3;
        const q = (2 * b * b * b - 9 * b * c + 27 * d) / 27;
        
        const discriminant = -(4 * p * p * p + 27 * q * q);
        
        if (discriminant > 0) {
            // 3つの実根
            const m = 2 * Math.sqrt(-p / 3);
            const theta = Math.acos(3 * q / (p * m)) / 3;
            const roots = [];
            for (let k = 0; k < 3; k++) {
                const root = m * Math.cos(theta - 2 * Math.PI * k / 3) - b / 3;
                roots.push(root);
            }
            return roots;
        } else {
            // 1つの実根
            const sqrtDelta = Math.sqrt(-discriminant / 27);
            const u = Math.cbrt(-q / 2 + sqrtDelta);
            const v = Math.cbrt(-q / 2 - sqrtDelta);
            return [u + v - b / 3];
        }
        
    } catch (error) {
        console.error('❌ 3次方程式求解エラー:', error);
        return [];
    }
}

/**
 * 線形補間による横収差0の位置を求める（簡易手法）
 * @param {Array} points - 横収差データ点
 * @returns {number|null} 横収差0となる瞳座標位置
 */
function findZeroAberrationByLinearInterpolation(points) {
    if (!points || points.length < 2) {
        console.warn('⚠️ 線形補間には最低2点必要です');
        return null;
    }
    
    try {
        // 有効なデータ点のみを使用
        const validPoints = points.filter(p => 
            isFinite(p.pupilCoordinate) && 
            isFinite(p.transverseAberration) &&
            Math.abs(p.pupilCoordinate) <= 1.0
        );
        
        if (validPoints.length < 2) {
            console.warn('⚠️ 線形補間用の有効なデータ点が不足です');
            return null;
        }
        
        // 瞳座標でソート
        validPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        // 符号が変わる隣接点のペアを探す
        for (let i = 0; i < validPoints.length - 1; i++) {
            const p1 = validPoints[i];
            const p2 = validPoints[i + 1];
            
            // 符号が異なる（0を跨ぐ）場合
            if (p1.transverseAberration * p2.transverseAberration <= 0) {
                // 線形補間で0交点を求める
                const deltaX = p2.pupilCoordinate - p1.pupilCoordinate;
                const deltaY = p2.transverseAberration - p1.transverseAberration;
                
                if (Math.abs(deltaY) > 1e-12) {
                    const zeroX = p1.pupilCoordinate - p1.transverseAberration * (deltaX / deltaY);
                    
                    // 結果が有効範囲内かチェック
                    if (Math.abs(zeroX) <= 1.0) {
                        console.log(`✅ 線形補間収束: 点${i}と点${i+1}の間, 横収差0位置 = ${zeroX.toFixed(6)}`);
                        return zeroX;
                    }
                }
            }
        }
        
        // 0交点が見つからない場合、最小絶対値の点を返す
        const minAbsPoint = validPoints.reduce((prev, curr) => 
            Math.abs(curr.transverseAberration) < Math.abs(prev.transverseAberration) ? curr : prev
        );
        
        console.log(`⚠️ 線形補間: 0交点なし、最小収差点を使用 = ${minAbsPoint.pupilCoordinate.toFixed(6)}`);
        return minAbsPoint.pupilCoordinate;
        
    } catch (error) {
        console.error('❌ 線形補間エラー:', error);
        return null;
    }
}

/**
 * 大量データ用区分的線形補間による横収差0の位置を求める
 * @param {Array} points - 横収差データ点
 * @returns {number|null} 横収差0となる瞳座標位置
 */
function findZeroAberrationByPiecewiseLinear(points) {
    if (!points || points.length < 10) {
        console.warn('⚠️ 区分的線形補間には最低10点必要です');
        return findZeroAberrationByLinearInterpolation(points);
    }
    
    try {
        // 有効なデータ点のみを使用
        const validPoints = points.filter(p => 
            isFinite(p.pupilCoordinate) && 
            isFinite(p.transverseAberration) &&
            Math.abs(p.pupilCoordinate) <= 1.0
        );
        
        if (validPoints.length < 10) {
            console.warn('⚠️ 区分的線形補間: 有効なデータ点が不足');
            return findZeroAberrationByLinearInterpolation(points);
        }
        
        // 瞳座標でソート
        validPoints.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);
        
        console.log(`🔧 区分的線形補間開始: ${validPoints.length}点を使用`);
        
        // 区間に分割して各区間で線形補間を行う
        const segments = Math.min(20, Math.floor(validPoints.length / 15)); // 最大20区間
        const segmentSize = Math.floor(validPoints.length / segments);
        
        const candidates = [];
        
        for (let seg = 0; seg < segments; seg++) {
            const start = seg * segmentSize;
            const end = (seg === segments - 1) ? validPoints.length : (seg + 1) * segmentSize + 1;
            const segmentPoints = validPoints.slice(start, end);
            
            if (segmentPoints.length < 2) continue;
            
            // この区間内で符号変化を探す
            for (let i = 0; i < segmentPoints.length - 1; i++) {
                const p1 = segmentPoints[i];
                const p2 = segmentPoints[i + 1];
                
                // 符号が異なる（0を跨ぐ）場合
                if (p1.transverseAberration * p2.transverseAberration <= 0) {
                    const deltaX = p2.pupilCoordinate - p1.pupilCoordinate;
                    const deltaY = p2.transverseAberration - p1.transverseAberration;
                    
                    if (Math.abs(deltaY) > 1e-12) {
                        const zeroX = p1.pupilCoordinate - p1.transverseAberration * (deltaX / deltaY);
                        
                        // 結果が有効範囲内かチェック
                        if (Math.abs(zeroX) <= 1.0) {
                            candidates.push({
                                position: zeroX,
                                segment: seg,
                                confidence: 1.0 / (Math.abs(deltaY) + 1e-6) // 勾配が小さいほど信頼性高
                            });
                        }
                    }
                }
            }
        }
        
        if (candidates.length === 0) {
            console.warn('⚠️ 区分的線形補間: 0交点が見つかりません');
            // 最小絶対値の点を探す
            const minAbsPoint = validPoints.reduce((prev, curr) => 
                Math.abs(curr.transverseAberration) < Math.abs(prev.transverseAberration) ? curr : prev
            );
            console.log(`🔧 最小絶対値点を採用: 瞳座標=${minAbsPoint.pupilCoordinate.toFixed(6)}, 横収差=${minAbsPoint.transverseAberration.toFixed(6)}`);
            return minAbsPoint.pupilCoordinate;
        }
        
        // 信頼性の高い候補を選択
        candidates.sort((a, b) => b.confidence - a.confidence);
        const bestCandidate = candidates[0];
        
        console.log(`✅ 区分的線形補間結果: 横収差0位置 = ${bestCandidate.position.toFixed(6)} (区間${bestCandidate.segment}, 信頼度${bestCandidate.confidence.toFixed(3)})`);
        
        // 複数候補がある場合の警告
        if (candidates.length > 1) {
            console.log(`🔍 他の候補: ${candidates.slice(1, 3).map(c => c.position.toFixed(6)).join(', ')}`);
        }
        
        return bestCandidate.position;
        
    } catch (error) {
        console.error('❌ 区分的線形補間エラー:', error);
        return findZeroAberrationByLinearInterpolation(points);
    }
}

/**
 * 2次方程式の実根を求める
 * @param {number} a - x²の係数
 * @param {number} b - xの係数
 * @param {number} c - 定数項
 * @returns {Array} 実根の配列
 */
function solveQuadraticEquation(a, b, c) {
    try {
        if (Math.abs(a) < 1e-12) {
            // 1次方程式
            return Math.abs(b) > 1e-12 ? [-c / b] : [];
        }
        
        const discriminant = b * b - 4 * a * c;
        if (discriminant < 0) {
            return []; // 実根なし
        } else if (discriminant === 0) {
            return [-b / (2 * a)]; // 重根
        } else {
            const sqrt_d = Math.sqrt(discriminant);
            return [(-b + sqrt_d) / (2 * a), (-b - sqrt_d) / (2 * a)];
        }
        
    } catch (error) {
        console.error('❌ 2次方程式求解エラー:', error);
        return [];
    }
}

/**
 * 近軸光線追跡から入射瞳径を取得する
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} wavelength - 波長 (μm)
 * @returns {number} 入射瞳径 (mm)
 */
export function getEstimatedEntrancePupilDiameter(opticalSystemRows, wavelength = 0.5876) {
    try {
        // まず包括的な近軸計算を実行
        const paraxialData = calculateParaxialData(opticalSystemRows, wavelength);
        
        if (paraxialData && paraxialData.entrancePupilDiameter && 
            isFinite(paraxialData.entrancePupilDiameter) && 
            paraxialData.entrancePupilDiameter > 0) {
            return paraxialData.entrancePupilDiameter;
        }
        
        // フォールバック：専用の入射瞳径計算関数を使用
        const diameter = calculateEntrancePupilDiameter(opticalSystemRows, wavelength);
        
        if (diameter && isFinite(diameter) && diameter > 0) {
            return diameter;
        }
        
        // フォールバック：絞り面から推定
        const stopSurfaceIndex = findStopSurfaceIndex(opticalSystemRows);
        if (stopSurfaceIndex !== -1) {
            const stopSurface = opticalSystemRows[stopSurfaceIndex];
            const aperture = Math.abs(parseFloat(stopSurface.aperture || stopSurface.Aperture || 10));
            if (aperture > 0) {
                return aperture; // 絞り面のaperture値を使用
            }
        }
        
        // 最終フォールバック値
        return 20.0;
        
    } catch (error) {
        console.error('❌ 入射瞳径取得エラー:', error);
        return 20.0; // フォールバック
    }
}

/**
 * Newton法による主光線計算（互換性維持用）
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {Object} fieldSetting - フィールド設定
 * @param {number} wavelength - 波長 (μm)
 * @param {string} rayType - 光線種別 (互換性のため保持)
 * @param {Object} options - オプション
 * @returns {Object} 主光線データ
 */
export function calculateChiefRayNewton(opticalSystemRows, fieldSetting, wavelength = 0.5876, rayType = 'unified', options = {}) {
    console.log('🔄 calculateChiefRayNewton: クロスビーム版への変換');
    
    try {
        // フィールド設定の正規化
        if (fieldSetting && fieldSetting.position && !fieldSetting.fieldType) {
            fieldSetting.fieldType = fieldSetting.position;
        }
        
        // 入力検証
        if (!opticalSystemRows || !Array.isArray(opticalSystemRows)) {
            console.error('❌ calculateChiefRayNewton: Invalid opticalSystemRows');
            return { convergence: false, finalError: 'Invalid opticalSystemRows' };
        }
        
        if (!fieldSetting || !fieldSetting.fieldType) {
            console.error('❌ calculateChiefRayNewton: fieldSetting.fieldType is missing', fieldSetting);
            return { convergence: false, finalError: 'fieldSetting.fieldType is missing' };
        }
        
        // 絞り面を見つける
        const stopSurfaceIndex = findStopSurfaceIndex(opticalSystemRows);
        if (stopSurfaceIndex === -1) {
            console.error('❌ 絞り面が見つかりません');
            return { convergence: false, finalError: '絞り面が見つかりません' };
        }
        
        // 有限系・無限系の判定
        // フィールド指定が角度の場合は強制的に無限系として扱う（厚み判定だけだと誤って有限系になるため）
        const isAngleField = (fieldSetting.fieldType || fieldSetting.position || '').toLowerCase().includes('angle');
        const isFinite = isAngleField ? false : isFiniteSystem(opticalSystemRows);
        
        // クロスビーム生成でオブジェクト点数を1に設定
        // options.rayCountが指定されていればそれを使用、なければデフォルト51
        const crossBeamOptions = {
            rayCount: options.rayCount || 51, // ユーザー指定の光線数または非点収差計算用のデフォルト値
            wavelength: wavelength,
            colorMode: 'segment'
        };
        
        let crossBeamData = null;
        
        if (isFinite) {
            // 有限系: Object位置を使用
            const objectPositions = [{
                x: fieldSetting.xHeight || 0,
                y: fieldSetting.yHeight || 0,
                comment: fieldSetting.displayName
            }];
            
            // 有限系の十字光線生成は raw 形式なので、rayGroups 形式へ変換する
            const rawCrossBeamData = generateFiniteSystemCrossBeam(opticalSystemRows, objectPositions, crossBeamOptions);
            crossBeamData = convertToRayGroupsFormat(rawCrossBeamData, stopSurfaceIndex);
        } else {
            // 無限系: 画角を使用
            console.log('🔍 [calculateChiefRayNewton] fieldSetting受信:', JSON.stringify(fieldSetting, null, 2));
            
            let xFieldAngle = 0;
            let yFieldAngle = 0;
            
            if (fieldSetting.fieldType === 'Angle' || fieldSetting.fieldType === 'angle') {
                // X方向の角度 - 優先順位: x > xFieldAngle > xHeightAngle
                xFieldAngle = fieldSetting.x ?? fieldSetting.xFieldAngle ?? fieldSetting.xHeightAngle ?? 0;
                
                // Y方向の角度 - 優先順位: y > yFieldAngle > yHeightAngle > fieldAngle
                yFieldAngle = fieldSetting.y ?? fieldSetting.yFieldAngle ?? fieldSetting.yHeightAngle ?? fieldSetting.fieldAngle ?? 0;
            }
            
            console.log(`🔍 [calculateChiefRayNewton] 角度計算結果: x=${xFieldAngle}°, y=${yFieldAngle}°`);
            
            const objectAngles = [{
                x: xFieldAngle,
                y: yFieldAngle,
                comment: fieldSetting.displayName
            }];
            
            console.log('🔍 [calculateChiefRayNewton] objectAngles:', JSON.stringify(objectAngles, null, 2));
            
            const rawCrossBeamData = generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, crossBeamOptions);
            
            // rayGroups形式に変換
            crossBeamData = convertToRayGroupsFormat(rawCrossBeamData, stopSurfaceIndex);
        }
        
        if (!crossBeamData || !crossBeamData.rayGroups || crossBeamData.rayGroups.length === 0) {
            console.warn('⚠️ クロスビーム生成に失敗');
            return { 
                success: false,
                convergence: false, 
                finalError: 'クロスビーム生成に失敗' 
            };
        }
        
        // 主光線を抽出
        const rayGroup = crossBeamData.rayGroups[0];
        const chiefRay = rayGroup.rays.find(ray => ray.rayType === 'chief');
        
        if (!chiefRay) {
            console.warn('⚠️ 主光線が見つかりません');
            return { 
                success: false,
                convergence: false, 
                finalError: '主光線が見つかりません' 
            };
        }
        
        // 主光線の開始点と方向ベクトルを抽出
        const startPoint = chiefRay.path[0]; // 最初の面での座標
        let direction = null;
        
        if (chiefRay.path.length > 1) {
            const secondPoint = chiefRay.path[1];
            direction = {
                x: secondPoint.x - startPoint.x,
                y: secondPoint.y - startPoint.y,
                z: secondPoint.z - startPoint.z
            };
            
            // 正規化
            const length = Math.sqrt(direction.x * direction.x + direction.y * direction.y + direction.z * direction.z);
            if (length > 0) {
                direction.x /= length;
                direction.y /= length;
                direction.z /= length;
            }
        }
        
        // eva-astigmatism.js が期待する形式で返す
        return {
            success: true,
            rayData: {
                segments: chiefRay.path,
                startP: startPoint,
                dir: direction
            },
            // 従来の形式も維持（互換性のため）
            convergence: true,
            startP: startPoint,
            dir: direction,
            finalError: 0,
            iterations: 1,
            ray: chiefRay,
            // 🔥 重要: rayGroupsを追加（非点収差計算で十字光線を使用するため）
            rayGroups: crossBeamData.rayGroups,
            crossBeamData: crossBeamData  // 完全なデータも含める
        };
        
    } catch (error) {
        console.error('❌ calculateChiefRayNewton エラー:', error);
        return { 
            success: false,
            convergence: false, 
            finalError: error.message 
        };
    }
}

/**
 * 十字光線の詳細分類を行う
 * @param {Array} rays - 光線配列
 * @param {number} stopSurfaceIndex - 絞り面インデックス
 */
function classifyCrossBeamRays(rays, stopSurfaceIndex, opticalSystemRows = null) {
    console.log(`🔄 classifyCrossBeamRays開始: ${rays.length}本の光線を分析`);
    console.log(`🔄 使用絞り面インデックス: ${stopSurfaceIndex}`);
    
    let verticalCount = 0;
    let horizontalCount = 0;
    let otherCount = 0;
    
    // 座標統計を収集
    const coordStats = {
        horizontal_cross: { x: [], y: [] },
        vertical_cross: { x: [], y: [] }
    };
    
    rays.forEach((ray, index) => {
        if (ray.rayType === 'vertical_cross') {
            verticalCount++;
        } else if (ray.rayType === 'horizontal_cross') {
            horizontalCount++;
        } else {
            otherCount++;
        }
        
        if (ray.rayType === 'vertical_cross' || ray.rayType === 'horizontal_cross') {
            const originalType = ray.rayType;
            
            // 絞り面での座標を取得して分類
            if (ray.path && ray.path.length > 0) {
                let stopCoord = null;
                
                // 絞り面インデックスが指定されていて有効な場合はそれを使用
                let stopPointIndex = stopSurfaceIndex;
                if (opticalSystemRows && Array.isArray(opticalSystemRows)) {
                    stopPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, stopSurfaceIndex);
                }

                if (stopPointIndex !== null && stopPointIndex >= 0 && stopPointIndex < ray.path.length) {
                    stopCoord = ray.path[stopPointIndex];
                } else {
                    // 絞り面が指定されていない場合は光学系の中央付近を使用
                    const midIndex = Math.floor(ray.path.length / 2);
                    stopCoord = ray.path[midIndex];
                }
                
                if (stopCoord) {
                    // 座標統計に追加
                    if (originalType === 'horizontal_cross') {
                        coordStats.horizontal_cross.x.push(stopCoord.x);
                        coordStats.horizontal_cross.y.push(stopCoord.y);
                    } else if (originalType === 'vertical_cross') {
                        coordStats.vertical_cross.x.push(stopCoord.x);
                        coordStats.vertical_cross.y.push(stopCoord.y);
                    }
                    
                    // 最初の数本の光線で詳細ログを出力
                    if (index < 5 || (originalType === 'horizontal_cross' && index < verticalCount + 5)) {
                        console.log(`🔍 光線 ${index}: ${originalType} → 座標(${stopCoord.x.toFixed(4)}, ${stopCoord.y.toFixed(4)})`);
                    }
                    
                    if (originalType === 'vertical_cross') {
                        // 垂直十字光線：Y座標で上下を判定
                        if (Math.abs(stopCoord.y) > 0.01) {  // 閾値を小さく設定
                            ray.rayType = stopCoord.y > 0 ? 'upper_marginal' : 'lower_marginal';
                        } else {
                            // Y座標がゼロに近い場合、光線経路を詳しく調べる
                            const pathY = ray.path.map(p => p.y).filter(y => Math.abs(y) > 0.01);
                            if (pathY.length > 0) {
                                const avgY = pathY.reduce((sum, y) => sum + y, 0) / pathY.length;
                                ray.rayType = avgY > 0 ? 'upper_marginal' : 'lower_marginal';
                            } else {
                                ray.rayType = 'upper_marginal';  // デフォルト
                            }
                        }
                    } else if (originalType === 'horizontal_cross') {
                        // 水平十字光線：X座標で左右を判定
                        if (Math.abs(stopCoord.x) > 0.01) {  // 閾値を小さく設定
                            ray.rayType = stopCoord.x > 0 ? 'right_marginal' : 'left_marginal';
                        } else {
                            // X座標がゼロに近い場合、光線経路を詳しく調べる
                            const pathX = ray.path.map(p => p.x).filter(x => Math.abs(x) > 0.01);
                            if (pathX.length > 0) {
                                const avgX = pathX.reduce((sum, x) => sum + x, 0) / pathX.length;
                                ray.rayType = avgX > 0 ? 'right_marginal' : 'left_marginal';
                            } else {
                                ray.rayType = 'left_marginal';  // デフォルト
                            }
                        }
                    }
                    
                    // 個別の光線分類ログは頻度を下げる
                    if (index < 3 || index % 50 === 0) {
                        console.log(`🔄 光線分類: ${originalType} → ${ray.rayType} (座標: ${stopCoord.x.toFixed(3)}, ${stopCoord.y.toFixed(3)})`);
                    }
                }
            }
        }
    });
    
    // 座標統計を出力
    console.log('📊 座標統計:');
    if (coordStats.horizontal_cross.x.length > 0) {
        const xMin = Math.min(...coordStats.horizontal_cross.x);
        const xMax = Math.max(...coordStats.horizontal_cross.x);
        const xAvg = coordStats.horizontal_cross.x.reduce((sum, x) => sum + x, 0) / coordStats.horizontal_cross.x.length;
        console.log(`  水平十字光線X座標: 範囲[${xMin.toFixed(3)}, ${xMax.toFixed(3)}], 平均=${xAvg.toFixed(3)}`);
    }
    
    if (coordStats.vertical_cross.y.length > 0) {
        const yMin = Math.min(...coordStats.vertical_cross.y);
        const yMax = Math.max(...coordStats.vertical_cross.y);
        const yAvg = coordStats.vertical_cross.y.reduce((sum, y) => sum + y, 0) / coordStats.vertical_cross.y.length;
        console.log(`  垂直十字光線Y座標: 範囲[${yMin.toFixed(3)}, ${yMax.toFixed(3)}], 平均=${yAvg.toFixed(3)}`);
    }
    
    console.log(`📊 十字光線分類完了: vertical=${verticalCount}, horizontal=${horizontalCount}, other=${otherCount}`);
}
