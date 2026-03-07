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

import { generateFiniteSystemCrossBeam } from '../../raytracing/generation/gen-ray-cross-finite.ts';
import { generateInfiniteSystemCrossBeam } from '../../raytracing/generation/gen-ray-cross-infinite.ts';
import { traceRay, calculateSurfaceOrigins } from '../../raytracing/core/ray-tracing.ts';
import { getObjectRows, getSourceRows } from '../../utils/data-utils.ts';
import { calculateEntrancePupilDiameter, calculateParaxialData } from '../../raytracing/core/ray-paraxial.ts';

const TRANSVERSE_DEBUG = !!(typeof globalThis !== 'undefined' && (globalThis.__TRANSVERSE_DEBUG || globalThis.__OPD_DEBUG || globalThis.__PSF_DEBUG));



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
export function calculateTransverseAberration(opticalSystemRows, targetSurfaceIndex, fieldSettings = null, wavelength = 0.5876, rayCount = 51, options = null) {
    // デバッグモードの設定（デフォルトは静か）
    const debugMode = TRANSVERSE_DEBUG;
    
    // フィールド設定を取得
    if (!fieldSettings) {
        fieldSettings = getFieldSettingsFromObject();
    }
    
    const safeNumber = (value) => {
        const num = Number(value);
        return Number.isFinite(num) ? num : 0;
    };

    const uniqueFieldKey = (fs) => {
        const positionType = (fs.position || fs.fieldType || fs.type || '').toLowerCase();
        const isRectangle = positionType.includes('rectangle') || positionType.includes('rect') || positionType.includes('height');
        const isAngle = !isRectangle && positionType.includes('angle');
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
    
    // Calculate surface origins (for coordinate transformation support)
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
    const targetSurfaceInfo = surfaceOrigins?.[targetSurfaceIndex] || null;
    const stopSurfaceInfo = surfaceOrigins?.[stopSurfaceIndex] || null;
    
    // 有限系・無限系の判定
    const isFinite = isFiniteSystem(opticalSystemRows);
    
    // 絞り面の物理的半径を取得（正規化の基準として使用）
    const stopSurface = opticalSystemRows[stopSurfaceIndex];
    // 🔧 FIX: semidiaフィールドを優先的に使用（aperture/Apertureはundefinedの場合が多い）
    const apertureValue = Math.abs(parseFloat(stopSurface.semidia || stopSurface.aperture || stopSurface.Aperture || 10));
    
    // 🔧 FIX: semidia/aperture値は既に半径として保存されている（直径ではない）
    const stopRadius = apertureValue;  // 半径をそのまま使用
    
    // 🔧 FIX: 横収差図の正規化には絞り面半径を使用
    // 光線は絞り面を基準に生成されているため、絞り半径で正規化すれば軸上で±1になる
    const entrancePupilRadius = stopRadius;  // 絞り面半径 = 瞳半径として使用
    

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
    
    const lightweight = !!(options && typeof options === 'object' && options.lightweight === true);

    // 各フィールド設定について計算
    for (let i = 0; i < fieldSettings.length; i++) {
        const fieldSetting = fieldSettings[i];

        try {
            // 十字光線を生成（絞り面インデックスと評価面インデックスも渡す）
            const crossBeamData = generateCrossBeamForField(opticalSystemRows, fieldSetting, isFinite, rayCount, wavelength, stopSurfaceIndex, targetSurfaceIndex, lightweight);
            
            if (crossBeamData) {
                // メリジオナル・サジタル光線を分離して横収差を計算（絞り半径と入射瞳半径を別々に渡す）
                const meridionalResult = calculateMeridionalAberrationFromCrossBeam(
                    crossBeamData, opticalSystemRows, targetSurfaceIndex, stopSurfaceIndex, stopRadius, entrancePupilRadius, fieldSetting, targetSurfaceInfo, stopSurfaceInfo, mirrorSign, lightweight
                );
                
                const sagittalResult = calculateSagittalAberrationFromCrossBeam(
                    crossBeamData, opticalSystemRows, targetSurfaceIndex, stopSurfaceIndex, stopRadius, entrancePupilRadius, fieldSetting, targetSurfaceInfo, stopSurfaceInfo, mirrorSign, lightweight
                );
                
                aberrationData.meridionalData.push(meridionalResult);
                aberrationData.sagittalData.push(sagittalResult);
                
            } else {
                if (debugMode) console.warn(`⚠️ フィールド ${fieldSetting.displayName} の十字光線生成に失敗`);
            }
        } catch (error) {
            console.error(`❌ フィールド ${fieldSetting.displayName} の計算エラー:`, error);
        }
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

        const partial = calculateTransverseAberration(
            opticalSystemRows,
            targetSurfaceIndex,
            [fs],
            wavelength,
            rayCount,
            options
        );

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
function generateCrossBeamForField(opticalSystemRows, fieldSetting, isFinite, rayCount, wavelength, stopSurfaceIndex, targetSurfaceIndex, lightweight = false) {
    const debugMode = TRANSVERSE_DEBUG;
    
    const options = {
        rayCount: rayCount,
        wavelength: wavelength,
        colorMode: 'segment', // セグメント色分け
        crossType: 'both', // 明示的に水平・垂直両方向を指定
        debugMode: debugMode,
        targetSurfaceIndex: targetSurfaceIndex // 評価面インデックスを追加
    };
    
    try {
        let rawCrossBeamData = null;
        
        // Object Position Angleは無限系、それ以外（Rectangle/Height）は有限系として扱う
        const positionType = (fieldSetting.position || fieldSetting.fieldType || '').toLowerCase();
        const isAngleField = positionType.includes('angle') && !positionType.includes('rectangle');
        const forceInfiniteByAngle = isAngleField;  // angle指定は無限系として強制
        const forceFiniteByRectangle = positionType.includes('rectangle') || positionType.includes('height');

        if ((isFinite || forceFiniteByRectangle) && !forceInfiniteByAngle) {
            // 有限系: Object位置を使用（Rectangle/Heightを使用）
            const objectPosition: any = {
                comment: fieldSetting.displayName,
                objectIndex: fieldSetting.objectIndex - 1
            };

            if (false) {  // このブランチは使用されない（Angle指定は上で除外済み）
                objectPosition.position = 'Angle';
                objectPosition.xHeightAngle = parseFloat((fieldSetting as any).xFieldAngle ?? (fieldSetting as any).xAngle ?? (fieldSetting as any).x ?? 0) || 0;
                objectPosition.yHeightAngle = parseFloat((fieldSetting as any).yFieldAngle ?? (fieldSetting as any).fieldAngle ?? (fieldSetting as any).y ?? 0) || 0;
            } else {
                objectPosition.position = 'Rectangle';
                const xVal = parseFloat((fieldSetting as any).xHeight ?? (fieldSetting as any).x ?? 0) || 0;
                const yVal = parseFloat((fieldSetting as any).yHeight ?? (fieldSetting as any).y ?? 0) || 0;
                objectPosition.x = xVal;
                objectPosition.y = yVal;
                objectPosition.xHeight = objectPosition.x;
                objectPosition.yHeight = objectPosition.y;
            }

            const objectPositions = [objectPosition];
            
            rawCrossBeamData = generateFiniteSystemCrossBeam(opticalSystemRows, objectPositions, options);
            
        } else {
            // 無限系: 画角を使用（Object Position Angle）
            // X方向の角度
            const xFieldAngle = parseFloat(fieldSetting.xFieldAngle || fieldSetting.xHeightAngle || fieldSetting.x || 0) || 0;
            
            // Y方向の角度
            let yFieldAngle = 0;
            if (fieldSetting.yFieldAngle !== undefined) {
                yFieldAngle = parseFloat(fieldSetting.yFieldAngle) || 0;
            } else if (fieldSetting.fieldAngle !== undefined) {
                if (typeof fieldSetting.fieldAngle === 'object') {
                    yFieldAngle = parseFloat(fieldSetting.fieldAngle.y || fieldSetting.fieldAngle.yFieldAngle || 0) || 0;
                } else {
                    yFieldAngle = parseFloat(fieldSetting.fieldAngle) || 0;
                }
            } else if (fieldSetting.yHeightAngle !== undefined) {
                yFieldAngle = parseFloat(fieldSetting.yHeightAngle) || 0;
            } else if (fieldSetting.y !== undefined) {
                yFieldAngle = parseFloat(fieldSetting.y) || 0;
            }
            
            const objectAngles = [{
                x: xFieldAngle,
                y: yFieldAngle,
                comment: fieldSetting.displayName
            }];

            rawCrossBeamData = generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, options);
        }        if (!rawCrossBeamData || !rawCrossBeamData.success) {
            console.warn('⚠️ 十字光線生成に失敗');
            return null;
        }
        
        // 横収差計算用のrayGroups形式に変換（絞り面インデックスを渡す）
        // NOTE: ray.path は Object/Coord Break 行を交点として記録しないため、
        // 以降の分類/評価で表面インデックス→rayPath点インデックス変換が必要。
        const convertedData = convertToRayGroupsFormat(rawCrossBeamData, stopSurfaceIndex, opticalSystemRows, lightweight);
        
        return convertedData;
        
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
function convertToRayGroupsFormat(rawCrossBeamData, stopSurfaceIndex, opticalSystemRows = null, lightweight = false) {
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
                        
                        rays.push(
                            lightweight
                                ? {
                                    rayType: rayType,
                                    path: tracedRay.rayPath,
                                    objectIndex: objectIndex,
                                    isFullSuccess: true
                                }
                                : {
                                    rayType: rayType,
                                    path: tracedRay.rayPath,
                                    originalRay: originalRay,
                                    objectIndex: objectIndex,
                                    isFullSuccess: true
                                }
                        );
                        
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
                        
                        rays.push(
                            lightweight
                                ? {
                                    rayType: rayType,
                                    path: tracedRay.partialPath,
                                    objectIndex: objectIndex,
                                    isFullSuccess: false,
                                    isPartial: true,
                                    failureReason: tracedRay.error || 'Unknown error'
                                }
                                : {
                                    rayType: rayType,
                                    path: tracedRay.partialPath,
                                    originalRay: originalRay,
                                    objectIndex: objectIndex,
                                    isFullSuccess: false,
                                    isPartial: true,
                                    failureReason: tracedRay.error || 'Unknown error'
                                }
                        );
                        
                        partialCount++;
                    } else {
                        failureCount++;
                    }
                });
                
                // 十字光線の詳細分類を行う
                if (!lightweight) classifyCrossBeamRays(rays, stopSurfaceIndex, opticalSystemRows);
                
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
                        
                        rays.push(
                            lightweight
                                ? {
                                    rayType: rayType,
                                    path: tracedRay.rayPath,
                                    angleIndex: angleIndex,
                                    isFullSuccess: true
                                }
                                : {
                                    rayType: rayType,
                                    path: tracedRay.rayPath,
                                    originalRay: originalRay,
                                    angleIndex: angleIndex,
                                    isFullSuccess: true
                                }
                        );
                        
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
                        
                        rays.push(
                            lightweight
                                ? {
                                    rayType: rayType,
                                    path: tracedRay.partialPath,
                                    angleIndex: angleIndex,
                                    isFullSuccess: false,
                                    isPartial: true,
                                    failureReason: tracedRay.error || 'Unknown error'
                                }
                                : {
                                    rayType: rayType,
                                    path: tracedRay.partialPath,
                                    originalRay: originalRay,
                                    angleIndex: angleIndex,
                                    isFullSuccess: false,
                                    isPartial: true,
                                    failureReason: tracedRay.error || 'Unknown error'
                                }
                        );
                        
                        partialCount++;
                    } else {
                        failureCount++;
                    }
                });
                
                // 十字光線の詳細分類を行う
                if (!lightweight) classifyCrossBeamRays(rays, stopSurfaceIndex, opticalSystemRows);
                
                rayGroups.push({
                    angleIndex: angleIndex,
                    rays: rays
                });
            });
        }
        
        if (!lightweight) {
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


            // 主要な光線タイプのみ報告
            const importantTypes = ['chief', 'left_marginal', 'right_marginal', 'upper_marginal', 'lower_marginal'];
            const importantCounts = {};
            importantTypes.forEach(type => {
                if (rayTypeCounts[type]) {
                    importantCounts[type] = rayTypeCounts[type];
                }
            });
        }
        
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
function calculateMeridionalAberrationFromCrossBeam(crossBeamData, opticalSystemRows, targetSurfaceIndex, stopSurfaceIndex, stopRadius, entrancePupilRadius, fieldSetting, targetSurfaceInfo = null, stopSurfaceInfo = null, mirrorSign = 1, lightweight = false) {
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
        } else if (ray.rayType === 'vertical_cross' ||  // ✅ vertical_cross rays for meridional
                   ray.rayType === 'upper_marginal' || ray.rayType === 'lower_marginal' || 
                   ray.rayType === 'aperture_up' || ray.rayType === 'aperture_down') {
            meridionalRays.push(ray);
        }
    });
    
    // メリジオナル光線の詳細を確認
    const meridionalTypes = meridionalRays.map(ray => ray.rayType);
    const meridionalTypeCounts = {};
    meridionalTypes.forEach(type => {
        meridionalTypeCounts[type] = (meridionalTypeCounts[type] || 0) + 1;
    });
    
    if (!chiefRay) {
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        if (!(g && g.__cooptRequirementRustProbe === true)) {
            console.warn('⚠️ 主光線が見つかりません');
        }
        return {
            fieldSetting: fieldSetting,
            rayType: 'meridional',
            points: points
        };
    }
    
    const stopPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, stopSurfaceIndex);
    const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);

    // 主光線の評価面での座標を取得
    const chiefIntersection = Number.isInteger(targetPointIndex)
        ? getIntersectionAtPathPoint(chiefRay, targetPointIndex, targetSurfaceInfo, mirrorSign, true)
        : getIntersectionAtSurface(chiefRay, targetSurfaceIndex, opticalSystemRows, targetSurfaceInfo, mirrorSign);
    if (!chiefIntersection) {
        console.warn('⚠️ 主光線の評価面交点が見つかりません');
        return {
            fieldSetting: fieldSetting,
            rayType: 'meridional',
            points: points
        };
    }

    // メリディオナル光線の絞り面でのX座標とY座標統計を収集（オフセット補正用のみ）
    const stopXCoordinates = [];
    const stopYCoordinates = [];
    if (!lightweight) {
        meridionalRays.forEach(ray => {
            const stopIntersection = Number.isInteger(stopPointIndex)
                ? getIntersectionAtPathPoint(ray, stopPointIndex, null, 1, false)
                : getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows);
            if (stopIntersection) {
                stopXCoordinates.push(stopIntersection.x);
                stopYCoordinates.push(stopIntersection.y);
            }
        });
    }
    
    // X座標の中点を計算（X方向オフセット補正値）
    let xOffset = 0;
    if (stopXCoordinates.length > 0) {
        const minX = Math.min(...stopXCoordinates);
        const maxX = Math.max(...stopXCoordinates);
        xOffset = (minX + maxX) / 2;
    }
    
    // Y座標のオフセット補正値を計算
    let yOffset = 0;
    if (stopYCoordinates.length > 0) {
        const minY = Math.min(...stopYCoordinates);
        const maxY = Math.max(...stopYCoordinates);
        yOffset = (minY + maxY) / 2;
    }
    
    // 🔧 FIX: 絞り面半径で正規化（全Objectで統一基準）
    // 光線は絞り面を通るように生成されているため、絞り半径で正規化すれば軸上で±1になる
    const maxAbsY = entrancePupilRadius;  // = stopRadius
    
    // 🔧 FIX: 部分的光線処理用も同じ瞳半径を使用
    const maxCorrectedY = entrancePupilRadius;  // = stopRadius
    
    // メリジオナル光線の横収差を計算（座標分布に基づく正規化）
    meridionalRays.forEach((ray, index) => {
        const intersection = Number.isInteger(targetPointIndex)
            ? getIntersectionAtPathPoint(ray, targetPointIndex, targetSurfaceInfo, mirrorSign, true)
            : getIntersectionAtSurface(ray, targetSurfaceIndex, opticalSystemRows, targetSurfaceInfo, mirrorSign);
        if (intersection) {
            // 絞り面での座標を取得
            const stopIntersection = Number.isInteger(stopPointIndex)
                ? getIntersectionAtPathPoint(ray, stopPointIndex, stopSurfaceInfo, mirrorSign, false)
                : getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows, stopSurfaceInfo, mirrorSign);
            if (stopIntersection) {
                // Y座標はオフセット補正なしで直接使用
                const stopY = stopIntersection.y;
                
                // 🔧 FIX: 事前に計算済みのmaxAbsYを使用（ループ内で再計算しない）
                const normalizedPupilCoord = maxAbsY > 0 ? stopY / maxAbsY : 0;
                
                const transverseAberration = intersection.y - chiefIntersection.y; // Y方向の収差
                
                // 規格化座標が±1以内の光線を含める
                if (Math.abs(normalizedPupilCoord) <= 1.0) {
                    successCount++;
                    points.push(
                        lightweight
                            ? {
                                pupilCoordinate: normalizedPupilCoord,
                                transverseAberration: transverseAberration
                            }
                            : {
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
                            }
                    );
                }
            }
        } else if (ray.isPartial && ray.path) {
            // 🔧 FIX: 絞り面に実際に到達しているかチェック（ケラレ検出）
            // 部分的な光線でも絞り面まで到達していれば処理する
            const stopIntersection = Number.isInteger(stopPointIndex)
                ? getIntersectionAtPathPoint(ray, stopPointIndex, null, 1, false)
                : getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows);
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
                        estimatedIntersection = getIntersectionAtPathPoint(ray, targetPointIndex, null, 1, false);
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
                        

                        points.push(
                            lightweight
                                ? {
                                    pupilCoordinate: normalizedPupilCoord,
                                    transverseAberration: transverseAberration
                                }
                                : {
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
                                }
                        );
                    }
                }
            }
        }
    });
    
    // 主光線の絞り面座標を取得
    const chiefStopIntersection = Number.isInteger(stopPointIndex)
        ? getIntersectionAtPathPoint(chiefRay, stopPointIndex, stopSurfaceInfo, mirrorSign, false)
        : getIntersectionAtSurface(chiefRay, stopSurfaceIndex, opticalSystemRows, stopSurfaceInfo, mirrorSign);

    // 🔧 FIX: 主光線を明示的に追加（Ray number偶数時に瞳座標=0が含まれない問題を回避）
    const chiefStopY = chiefStopIntersection ? chiefStopIntersection.y : 0;
    const chiefNormalizedPupilCoordMeridional = maxAbsY > 0 ? chiefStopY / maxAbsY : 0;
    
    // 主光線が既にpoints配列に含まれているか確認（重複回避）
    const chiefAlreadyExistsMeridional = points.some(p => Math.abs(p.pupilCoordinate - chiefNormalizedPupilCoordMeridional) < 1e-9);
    
    if (!chiefAlreadyExistsMeridional) {
        points.push(
            lightweight
                ? {
                    pupilCoordinate: chiefNormalizedPupilCoordMeridional,
                    transverseAberration: 0
                }
                : {
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
                }
        );
    }

    let zeroAberrationPosition = null;
    let offsetMethod = 'none';
    if (!lightweight) {
        // 瞳座標でソート
        points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);

        // ケラレ統計は内部で保持のみ（ログ出力なし）

    // 横収差0位置を求める
        if (points.length >= 3) {
            // 新しい統一手法：最小絶対値点とその前後3点による直線近似
            const minAbsZero = findZeroAberrationByMinAbsThreePoints(points);
            if (minAbsZero !== null) {
                zeroAberrationPosition = minAbsZero;
                offsetMethod = 'min_abs_3points';
            } else {
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

                    // 有効範囲内かチェック
                    if (Math.abs(zeroAberrationPosition) > 1.5) {
                        zeroAberrationPosition = null;
                        offsetMethod = 'none';
                    }
                }
            }
        }

        // 横収差0位置でのオフセット適用
        if (zeroAberrationPosition !== null && Math.abs(zeroAberrationPosition) > 1e-6) {
            // 284点以上の場合も同じ処理を適用

            // 全点の瞳座標をオフセット
            points.forEach(point => {
                point.originalPupilCoordinate = point.pupilCoordinate; // 元の座標を保存
                point.pupilCoordinate -= zeroAberrationPosition; // オフセット適用
            });

            // オフセット後に再ソート
            points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);

        }
    }
    
    // メリジオナル統計情報（必要時に利用）
    
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
function calculateSagittalAberrationFromCrossBeam(crossBeamData, opticalSystemRows, targetSurfaceIndex, stopSurfaceIndex, stopRadius, entrancePupilRadius, fieldSetting, targetSurfaceInfo = null, stopSurfaceInfo = null, mirrorSign = 1, lightweight = false) {
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
        } else if (ray.rayType === 'horizontal_cross' ||  // ✅ horizontal_cross rays for sagittal
                   ray.rayType === 'left_marginal' || ray.rayType === 'right_marginal' || 
                   ray.rayType === 'aperture_left' || ray.rayType === 'aperture_right') {
            sagittalRays.push(ray);
        }
    });
    
    // サジタル光線の詳細を確認
    const sagittalTypes = sagittalRays.map(ray => ray.rayType);
    const sagittalTypeCounts = {};
    sagittalTypes.forEach(type => {
        sagittalTypeCounts[type] = (sagittalTypeCounts[type] || 0) + 1;
    });
    
    if (!chiefRay) {
        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
        if (!(g && g.__cooptRequirementRustProbe === true)) {
            console.warn('⚠️ 主光線が見つかりません');
        }
        return {
            fieldSetting: fieldSetting,
            rayType: 'sagittal',
            points: points
        };
    }
    
    const stopPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, stopSurfaceIndex);
    const targetPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, targetSurfaceIndex);

    // 主光線の評価面での座標を取得
    const chiefIntersection = Number.isInteger(targetPointIndex)
        ? getIntersectionAtPathPoint(chiefRay, targetPointIndex, targetSurfaceInfo, mirrorSign, true)
        : getIntersectionAtSurface(chiefRay, targetSurfaceIndex, opticalSystemRows, targetSurfaceInfo, mirrorSign);
    if (!chiefIntersection) {
        console.warn('⚠️ 主光線の評価面交点が見つかりません');
        return {
            fieldSetting: fieldSetting,
            rayType: 'sagittal',
            points: points
        };
    }

    // サジタル光線の絞り面でのX座標統計を収集（デバッグ用）
    const stopXCoordinates = [];
    if (!lightweight) {
        sagittalRays.forEach(ray => {
            const stopIntersection = Number.isInteger(stopPointIndex)
                ? getIntersectionAtPathPoint(ray, stopPointIndex, null, 1, false)
                : getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows);
            if (stopIntersection) {
                stopXCoordinates.push(stopIntersection.x);
            }
        });
    }
    
    // 🔧 FIX: オフセット補正は不要（メリディオナルと同じロジック）
    // 絞り面X座標を直接使用して正規化する
    // NOTE: xOffset はデバッグ/部分光線用のみに使用
    let xOffset = 0;
    if (stopXCoordinates.length > 0) {
        const minX = Math.min(...stopXCoordinates);
        const maxX = Math.max(...stopXCoordinates);
        xOffset = (minX + maxX) / 2; // デバッグ用のみ
    }
    
    // 🔧 FIX: 絞り面半径で正規化（全Objectで統一基準）
    // 光線は絞り面を通るように生成されているため、絞り半径で正規化すれば軸上で±1になる
    const maxCorrectedX = entrancePupilRadius;  // = stopRadius
    
    // 主光線の絞り面X座標も取得（参考用）
    const chiefStopIntersection = Number.isInteger(stopPointIndex)
        ? getIntersectionAtPathPoint(chiefRay, stopPointIndex, stopSurfaceInfo, mirrorSign, false)
        : getIntersectionAtSurface(chiefRay, stopSurfaceIndex, opticalSystemRows, stopSurfaceInfo, mirrorSign);
    
    // サジタル光線の横収差を計算（座標分布に基づく正規化）
    sagittalRays.forEach((ray, index) => {
        const intersection = Number.isInteger(targetPointIndex)
            ? getIntersectionAtPathPoint(ray, targetPointIndex, targetSurfaceInfo, mirrorSign, true)
            : getIntersectionAtSurface(ray, targetSurfaceIndex, opticalSystemRows, targetSurfaceInfo, mirrorSign);
        if (intersection) {
            // 絞り面での座標を取得
            const stopIntersection = Number.isInteger(stopPointIndex)
                ? getIntersectionAtPathPoint(ray, stopPointIndex, stopSurfaceInfo, mirrorSign, false)
                : getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows, stopSurfaceInfo, mirrorSign);
            if (stopIntersection) {
                // 🔧 FIX: X座標をオフセット補正せずに直接使用（メリディオナルと同じロジック）
                const stopX = stopIntersection.x;
                
                // 🔧 FIX: 事前に計算済みのmaxCorrectedXを使用（ループ内で再計算しない）
                const normalizedPupilCoord = maxCorrectedX > 0 ? stopX / maxCorrectedX : 0;
                
                const transverseAberration = intersection.x - chiefIntersection.x; // X方向の収差
                
                // 規格化座標が±1以内の光線を含める
                if (Math.abs(normalizedPupilCoord) <= 1.0) {
                    successCount++;
                    points.push(
                        lightweight
                            ? {
                                pupilCoordinate: normalizedPupilCoord,
                                transverseAberration: transverseAberration
                            }
                            : {
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
                            }
                    );
                }
            }
        } else if (ray.isPartial && ray.path) {
            // 🔧 FIX: 絞り面に実際に到達しているかチェック（ケラレ検出）
            // 部分的な光線でも絞り面まで到達していれば処理する
            const stopIntersection = Number.isInteger(stopPointIndex)
                ? getIntersectionAtPathPoint(ray, stopPointIndex, null, 1, false)
                : getIntersectionAtSurface(ray, stopSurfaceIndex, opticalSystemRows);
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
                        estimatedIntersection = getIntersectionAtPathPoint(ray, targetPointIndex, null, 1, false);
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
                        

                        points.push(
                            lightweight
                                ? {
                                    pupilCoordinate: normalizedPupilCoord,
                                    transverseAberration: transverseAberration
                                }
                                : {
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
                                }
                        );
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
        points.push(
            lightweight
                ? {
                    pupilCoordinate: chiefNormalizedPupilCoordSagittal,
                    transverseAberration: 0
                }
                : {
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
                }
        );
    }

    let zeroAberrationPosition = null;
    let offsetMethod = 'none';
    if (!lightweight) {
        // 瞳座標でソート
        points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);

        // ケラレ統計は内部で保持のみ（ログ出力なし）

        // 横収差0位置を求める
        if (points.length >= 3) {
            // 新しい統一手法：最小絶対値点とその前後3点による直線近似
            const minAbsZero = findZeroAberrationByMinAbsThreePoints(points);
            if (minAbsZero !== null) {
                zeroAberrationPosition = minAbsZero;
                offsetMethod = 'min_abs_3points';
            } else {
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

                    // 有効範囲内かチェック
                    if (Math.abs(zeroAberrationPosition) > 1.5) {
                        zeroAberrationPosition = null;
                        offsetMethod = 'none';
                    }
                }
            }
        }

        // 横収差0位置でのオフセット適用
        if (zeroAberrationPosition !== null && Math.abs(zeroAberrationPosition) > 1e-6) {
            // 284点以上の場合も同じ処理を適用

            // 全点の瞳座標をオフセット
            points.forEach(point => {
                point.originalPupilCoordinate = point.pupilCoordinate; // 元の座標を保存
                point.pupilCoordinate -= zeroAberrationPosition; // オフセット適用
            });

            // オフセット後に再ソート
            points.sort((a, b) => a.pupilCoordinate - b.pupilCoordinate);

        }
    }
    
    // サジタル統計情報（必要時に利用）
    
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

function getIntersectionAtPathPoint(ray, pointIndex, surfaceInfo = null, mirrorSign = 1, preferTargetPath = true) {
    try {
        const targetPath = (preferTargetPath && ray?.rayPathToTarget) ? ray.rayPathToTarget : ray?.path;
        if (!Array.isArray(targetPath)) return null;
        if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= targetPath.length) return null;

        const intersectionGlobal = targetPath[pointIndex];
        if (!intersectionGlobal || typeof intersectionGlobal.x !== 'number' || typeof intersectionGlobal.y !== 'number') {
            return null;
        }

        let intersection = intersectionGlobal;
        if (surfaceInfo?.rotationMatrix) {
            intersection = applyRotationMatrixToVector(surfaceInfo.rotationMatrix, intersectionGlobal);
        }

        return {
            x: intersection.x,
            y: intersection.y * mirrorSign,
            z: intersection.z || 0
        };
    } catch (_) {
        return null;
    }
}

function getIntersectionAtSurface(ray, surfaceIndex, opticalSystemRows, surfaceInfo = null, mirrorSign = 1) {
    try {
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
                    surfaceInfo.rotationMatrix,
                    intersectionGlobal
                );
            }
            
            // Mirror signを適用（X軸周りの反射: Y座標のみ反転）
            const result = {
                x: intersection.x,
                y: intersection.y * mirrorSign,
                z: intersection.z || 0
            };
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
    
    if (!opticalSystemRows || !Array.isArray(opticalSystemRows)) {
        if (debugMode) console.warn('⚠️ 無効な光学系データです');
        return -1;
    }
    
    // パターン1: Object列に "Stop" を含む面を探す
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const objectType = surface.object || surface.Object || surface['object type'] || surface['Object Type'] || '';
        if (objectType && objectType.toString().toLowerCase().includes('stop')) {
            return i;
        }
    }
    
    // パターン2: Comment列に "stop", "aperture", "絞り" を含む面を探す
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const comment = (surface.comment || surface.Comment || '').toLowerCase();
        if (comment.includes('stop') || comment.includes('aperture') || comment.includes('絞り')) {
            return i;
        }
    }
    
    // パターン3: Type列に "Stop" を含む面を探す
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const type = surface.type || surface.Type || surface['surf type'] || surface['surfType'] || '';
        if (type && type.toString().toLowerCase().includes('stop')) {
            return i;
        }
    }
    
    // パターン4: aperture が "INF" または無限大の面を絞りとする（物理的な絞り穴）
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const apertureRaw = (surface.aperture || surface.Aperture || '').toString().toUpperCase();
        
        if (apertureRaw === 'INF' || apertureRaw === 'INFINITY' || apertureRaw === '∞') {
            return i;
        }
    }
    
    // パターン5: 最小aperture値を持つ面を絞りとする
    let minAperture = Infinity;
    let stopIndex = -1;
    

    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const apertureRaw = surface.aperture || surface.Aperture || surface.semidia || surface.SemiDia;
        const aperture = Math.abs(parseFloat(apertureRaw || Infinity));
        
        if (isFinite(aperture) && aperture > 0 && aperture < minAperture) {
            minAperture = aperture;
            stopIndex = i;
        }
    }
    
    if (stopIndex !== -1) {
        return stopIndex;
    }
    
    // フォールバック: 光学系の中央付近の面を絞りとする
    if (opticalSystemRows.length > 2) {
        const middleIndex = Math.floor(opticalSystemRows.length / 2);
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
    
    try {
        if (window.tableObject && typeof window.tableObject.getData === 'function') {
            const objectData = window.tableObject.getData();
            
            objectData.forEach((row, index) => {
                
                // displayName の構築を改善
                let displayName = `Object ${index + 1}`;
                if (row.comment && row.comment.trim() !== '') {
                    displayName += ` - ${row.comment}`;
                }
                
                // より柔軟な位置タイプ判定
                const positionType = (row.position || row.Position || '').toLowerCase();
                const isRectangle = positionType.includes('rectangle') || positionType.includes('rect') || positionType.includes('height') || positionType.includes('座標');
                const isAngle = !isRectangle && (positionType.includes('angle') || positionType.includes('角度'));
                
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

                    const xValue = parseFloat(
                        row.x || row.X || row.xHeight || row.XHeight || 
                        row.xHeightAngle || row.XHeightAngle || 0
                    );
                    const yValue = parseFloat(
                        row.y || row.Y || row.yHeight || row.YHeight || 
                        row.yHeightAngle || row.YHeightAngle || 0
                    );
                    
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
        
        // 最小絶対値点とその前後の点を取得（合計3点）
        let selectedPoints = [];
        
        if (minAbsIndex === 0) {
            // 最初の点が最小の場合：最初の3点を使用
            selectedPoints = validPoints.slice(0, 3);
        } else if (minAbsIndex === validPoints.length - 1) {
            // 最後の点が最小の場合：最後の3点を使用
            selectedPoints = validPoints.slice(-3);
        } else {
            // 中間の点が最小の場合：前の点、最小点、後の点の3点を使用
            selectedPoints = [
                validPoints[minAbsIndex - 1],
                validPoints[minAbsIndex],
                validPoints[minAbsIndex + 1]
            ];
        }
        
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
            console.warn('⚠️ 直線近似失敗：分母が0に近い');
            return null;
        }
        
        const a = (n * sumXY - sumX * sumY) / denominator; // 傾き
        const b = (sumY - a * sumX) / n; // 切片
        
        // y = 0となるx座標を計算: 0 = a*x + b → x = -b/a
        if (Math.abs(a) < 1e-12) {
            console.warn('⚠️ 傾きが0に近いため、0交点を計算できません');
            // 傾きが0の場合は最小絶対値点のx座標を返す
            return minAbsPoint.pupilCoordinate;
        }
        
        const zeroX = -b / a;
        
        // 結果の妥当性チェック
        if (!isFinite(zeroX)) {
            console.warn('⚠️ 計算結果が無限値です');
            return minAbsPoint.pupilCoordinate;
        }
        
        // 有効範囲チェック（±1.5程度まで許容）
        if (Math.abs(zeroX) > 1.5) {
            console.warn(`⚠️ 結果が範囲外: ${zeroX.toFixed(6)}, 最小絶対値点を採用`);
            return minAbsPoint.pupilCoordinate;
        }
        
        return zeroX;
        
    } catch (error) {
        console.error('❌ 最小絶対値3点法エラー:', error);
        return null;
    }
}

/**
 * 横収差データを検証・統計情報を出力
 * @param {Object} aberrationData - 横収差データ
 */
export function validateAberrationData(aberrationData) {
    if (!TRANSVERSE_DEBUG) return;
    void aberrationData;
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
            
            // エッジ近傍も全て保持
            edgeNearPoints.forEach(point => {
                const exists = fittingPoints.some(fp => 
                    Math.abs(fp.pupilCoordinate - point.pupilCoordinate) < 0.01
                );
                if (!exists) {
                    fittingPoints.push(point);
                }
            });
            
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
        
        return bestRoot;
        
    } catch (error) {
        console.error('❌ 多項式フィッティングエラー:', error);
        
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
                        return zeroX;
                    }
                }
            }
        }
        
        // 0交点が見つからない場合、最小絶対値の点を返す
        const minAbsPoint = validPoints.reduce((prev, curr) => 
            Math.abs(curr.transverseAberration) < Math.abs(prev.transverseAberration) ? curr : prev
        );

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
            return minAbsPoint.pupilCoordinate;
        }
        
        // 信頼性の高い候補を選択
        candidates.sort((a, b) => b.confidence - a.confidence);
        const bestCandidate = candidates[0];

        
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
        // Object Position Angleは無限系、Rectangle/Heightは有限系として扱う
        const positionType = (fieldSetting.position || fieldSetting.fieldType || '').toLowerCase();
        const isAngleField = positionType.includes('angle') && !positionType.includes('rectangle');
        const isFinite = isAngleField ? false : isFiniteSystem(opticalSystemRows);
        

        // クロスビーム生成でオブジェクト点数を1に設定
        // options.rayCountが指定されていればそれを使用、なければデフォルト51
        const targetSurfaceIndexOption = Number.isInteger((options as any)?.targetSurfaceIndex)
            ? Math.max(0, Math.min((options as any).targetSurfaceIndex, Math.max(0, opticalSystemRows.length - 1)))
            : null;

        const crossBeamOptions = {
            rayCount: (options as any).rayCount || 51, // ユーザー指定の光線数または非点収差計算用のデフォルト値
            wavelength: wavelength,
            colorMode: 'segment',
            targetSurfaceIndex: targetSurfaceIndexOption
        };
        
        let crossBeamData = null;
        
        if (isFinite) {
            // 有限系: Object位置を使用（Rectangle/Height）
            const xVal = parseFloat(fieldSetting.xHeight || fieldSetting.x || 0) || 0;
            const yVal = parseFloat(fieldSetting.yHeight || fieldSetting.y || 0) || 0;
            
            const objectPositions = [{
                x: xVal,
                y: yVal,
                comment: fieldSetting.displayName
            }];

            // 有限系の十字光線生成は raw 形式なので、rayGroups 形式へ変換する
            const rawCrossBeamData = generateFiniteSystemCrossBeam(opticalSystemRows, objectPositions, crossBeamOptions);
            crossBeamData = convertToRayGroupsFormat(rawCrossBeamData, stopSurfaceIndex);
        } else {
            // 無限系: 画角を使用（Object Position Angle）
            const xFieldAngle = parseFloat(fieldSetting.xFieldAngle || fieldSetting.xHeightAngle || fieldSetting.x || 0) || 0;
            
            // Y方向の角度を取得
            let yFieldAngle = 0;
            if (fieldSetting.yFieldAngle !== undefined) {
                yFieldAngle = parseFloat(fieldSetting.yFieldAngle) || 0;
            } else if (fieldSetting.fieldAngle !== undefined) {
                yFieldAngle = parseFloat(fieldSetting.fieldAngle) || 0;
            } else if (fieldSetting.yHeightAngle !== undefined) {
                yFieldAngle = parseFloat(fieldSetting.yHeightAngle) || 0;
            } else if (fieldSetting.y !== undefined) {
                yFieldAngle = parseFloat(fieldSetting.y) || 0;
            }

            const objectAngles = [{
                x: xFieldAngle,
                y: yFieldAngle,
                comment: fieldSetting.displayName
            }];
            
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
        const chiefRayDefinition = (typeof (options as any)?.chiefRayDefinition === 'string')
            ? (options as any).chiefRayDefinition
            : 'stop-center';
        const fallbackTargetSurfaceIndex = Array.isArray(opticalSystemRows) ? (opticalSystemRows.length - 1) : null;
        const targetSurfaceIndex = Number.isInteger((options as any)?.targetSurfaceIndex)
            ? (options as any).targetSurfaceIndex
            : fallbackTargetSurfaceIndex;

        let chiefRay = null;
        if (Array.isArray(rayGroup.rays)) {
            const stopPointIndex = surfaceIndexToRayPathPointIndex(opticalSystemRows, stopSurfaceIndex);

            const selectClosestToStopCenter = (rays: any[]) => {
                let bestRay = null;
                let bestDist2 = Infinity;
                for (const ray of rays) {
                    const path = ray?.rayPathToTarget || ray?.path;
                    if (!Array.isArray(path) || path.length === 0) continue;
                    const idx = (stopPointIndex !== null && stopPointIndex >= 0 && stopPointIndex < path.length)
                        ? stopPointIndex
                        : null;
                    if (idx === null) continue;
                    const p = path[idx];
                    const x = Number(p?.x);
                    const y = Number(p?.y);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    const d2 = x * x + y * y;
                    if (d2 < bestDist2) {
                        bestDist2 = d2;
                        bestRay = ray;
                    }
                }
                return bestRay;
            };

            if (chiefRayDefinition === 'stop-center') {
                chiefRay = selectClosestToStopCenter(rayGroup.rays);
            }

            if (!chiefRay) {
                const chiefCandidates = rayGroup.rays.filter(ray => ray?.rayType === 'chief');
                if (chiefCandidates.length === 1) {
                    chiefRay = chiefCandidates[0];
                } else if (chiefCandidates.length > 1) {
                    chiefRay = selectClosestToStopCenter(chiefCandidates);
                }
            }
        }

        if (chiefRayDefinition !== 'stop-center' && Array.isArray(rayGroup.rays)) {
            // Evaluate at stop surface instead of image surface
            const evalSurfaceIndex = stopSurfaceIndex;
            const targetPointIndexRaw = surfaceIndexToRayPathPointIndex(opticalSystemRows, evalSurfaceIndex);
            const intersections = [] as Array<{ ray: any; x: number; y: number }>;

            let targetSurfaceInfo = null;
            try {
                const origins = calculateSurfaceOrigins(opticalSystemRows);
                targetSurfaceInfo = origins?.[evalSurfaceIndex] || null;
            } catch (_) {
                targetSurfaceInfo = null;
            }
            const toLocal = (point) => {
                if (!targetSurfaceInfo?.origin || !targetSurfaceInfo?.rotationMatrix) return point;
                const dx = point.x - targetSurfaceInfo.origin.x;
                const dy = point.y - targetSurfaceInfo.origin.y;
                const dz = point.z - targetSurfaceInfo.origin.z;
                const R = targetSurfaceInfo.rotationMatrix;
                return {
                    x: R[0][0] * dx + R[1][0] * dy + R[2][0] * dz,
                    y: R[0][1] * dx + R[1][1] * dy + R[2][1] * dz,
                    z: R[0][2] * dx + R[1][2] * dy + R[2][2] * dz
                };
            };

            for (const ray of rayGroup.rays) {
                const path = ray?.rayPathToTarget || ray?.path;
                if (!Array.isArray(path) || path.length === 0) continue;
                let idx = targetPointIndexRaw;
                if (idx === null || idx === undefined) idx = path.length - 1;
                if (idx < 0 || idx >= path.length) continue;
                const p = path[idx];
                const local = (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) ? toLocal(p) : p;
                const x = local?.x;
                const y = local?.y;
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                intersections.push({ ray, x, y });
            }

            if (intersections.length > 0) {
                let targetX = 0;
                let targetY = 0;

                if (chiefRayDefinition === 'beam-midpoint') {
                    let minX = intersections[0].x;
                    let maxX = intersections[0].x;
                    let minY = intersections[0].y;
                    let maxY = intersections[0].y;
                    for (const hit of intersections) {
                        if (hit.x < minX) minX = hit.x;
                        if (hit.x > maxX) maxX = hit.x;
                        if (hit.y < minY) minY = hit.y;
                        if (hit.y > maxY) maxY = hit.y;
                    }
                    targetX = (minX + maxX) * 0.5;
                    targetY = (minY + maxY) * 0.5;
                } else if (chiefRayDefinition === 'beam-centroid') {
                    let sumX = 0;
                    let sumY = 0;
                    for (const hit of intersections) {
                        sumX += hit.x;
                        sumY += hit.y;
                    }
                    targetX = sumX / intersections.length;
                    targetY = sumY / intersections.length;
                }

                let bestRay = null;
                let bestDist2 = Infinity;
                for (const hit of intersections) {
                    const dx = hit.x - targetX;
                    const dy = hit.y - targetY;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < bestDist2) {
                        bestDist2 = d2;
                        bestRay = hit.ray;
                    }
                }
                if (bestRay) {
                    chiefRay = bestRay;
                }
            }
        }

        if (!chiefRay) {
            const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
            const alreadyRetried = !!((options as any)?.__chiefRayJsRetry);
            const requireRustWasm = !!((options as any)?.requireRustWasm);
            const rustOverrideActive = !!(g && g.__cooptTraceOptionsOverride && g.__cooptTraceOptionsOverride.useRustWasm === true);
            if (rustOverrideActive && !alreadyRetried && !requireRustWasm) {
                const prevOverride = g.__cooptTraceOptionsOverride;
                try {
                    g.__cooptTraceOptionsOverride = {
                        ...(prevOverride && typeof prevOverride === 'object' ? prevOverride : {}),
                        useRustWasm: false,
                        requireRustWasm: false
                    };
                    const retry = calculateChiefRayNewton(
                        opticalSystemRows,
                        fieldSetting,
                        wavelength,
                        rayType,
                        {
                            ...(options && typeof options === 'object' ? options : {}),
                            __chiefRayJsRetry: true
                        }
                    );
                    if (retry && (retry.success === true || retry.convergence === true)) {
                        return {
                            ...retry,
                            chiefRayFallback: 'js-retry-from-rust'
                        };
                    }
                } catch (_) {
                    // ignore retry errors and continue original error path
                } finally {
                    g.__cooptTraceOptionsOverride = prevOverride;
                }
            }
            if (!(g && g.__cooptRequirementRustProbe === true)) {
                console.warn('⚠️ 主光線が見つかりません');
            }
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
    let verticalCount = 0;
    let horizontalCount = 0;
    let otherCount = 0;
    
    // 座標統計を収集
    const coordStats = {
        horizontal_cross: { x: [], y: [] },
        vertical_cross: { x: [], y: [] }
    };
    
    rays.forEach((ray, index) => {
        // PRESERVE original cross-beam type BEFORE reclassification
        if (ray.rayType === 'vertical_cross' || ray.rayType === 'horizontal_cross') {
            ray.originalCrossBeamType = ray.rayType;  // ✅ SAVE the original type
        }
        
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
                    
                    // 🔧 FIX: DO NOT RECLASSIFY cross-beam rays!
                    // Keep vertical_cross and horizontal_cross as-is.
                    // These types are fundamental for meridional/sagittal separation.
                    // Reclassifying them destroys the meridional/sagittal distinction.
                    // Just keep the original type:
                    // ray.rayType already = vertical_cross or horizontal_cross (no change needed)
                }
            }
        }
    });
    
    if (coordStats.horizontal_cross.x.length > 0) {
        const xMin = Math.min(...coordStats.horizontal_cross.x);
        const xMax = Math.max(...coordStats.horizontal_cross.x);
        const xAvg = coordStats.horizontal_cross.x.reduce((sum, x) => sum + x, 0) / coordStats.horizontal_cross.x.length;
    }
    
    if (coordStats.vertical_cross.y.length > 0) {
        const yMin = Math.min(...coordStats.vertical_cross.y);
        const yMax = Math.max(...coordStats.vertical_cross.y);
        const yAvg = coordStats.vertical_cross.y.reduce((sum, y) => sum + y, 0) / coordStats.vertical_cross.y.length;
    }
}
