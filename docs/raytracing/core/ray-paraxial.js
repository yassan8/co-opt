// ray-paraxial.js
// 近軸光線追跡による光学系の主要諸量計算関数

import { miscellaneousDB, oharaGlassDB, schottGlassDB, calculateRefractiveIndex } from '../../data/glass.js';

// デバッグレベル設定（0: エラーのみ、1: 警告+エラー、2: 情報+警告+エラー、3: すべて）
const DEBUG_LEVEL = 1;

function debugLog(level, ...args) {
  if (level <= DEBUG_LEVEL) {
    console.log(...args);
  }
}

function debugWarn(level, ...args) {
  if (level <= DEBUG_LEVEL) {
    // console.warn(...args);
  }
}

/**
 * ガラスカタログからガラスデータを検索
 */
function getGlassData(glassMaterial) {
  if (!glassMaterial) return null;
  
  // まず、miscellaneousDBから検索
  let glassData = miscellaneousDB.find(glass => glass.name === glassMaterial);
  if (glassData) return glassData;
  
  // 次に、oharaGlassDBから検索
  glassData = oharaGlassDB.find(glass => glass.name === glassMaterial);
  if (glassData) return glassData;
  
  // 最後に、schottGlassDBから検索（存在する場合）
  if (typeof schottGlassDB !== 'undefined') {
    glassData = schottGlassDB.find(glass => glass.name === glassMaterial);
    if (glassData) return glassData;
  }
  
  return null;
}

/**
 * 新仕様による瞳計算（統合関数）
 */
export function calculatePupilsByNewSpec(opticalSystemRows, wavelength = 0.5875618) {
  try {
    // console.log('=== 新仕様による瞳計算開始 ===');
    
    const stopIndex = findStopSurfaceIndex(opticalSystemRows);
    if (stopIndex === -1) {
      // console.warn('絞り面が見つかりません');
      return { exitPupil: null, entrancePupil: null, isValid: false };
    }
    
    const stopSurface = opticalSystemRows[stopIndex];
    const stopRadius = parseFloat(stopSurface.semidia || stopSurface["Semi Diameter"] || 10);
    
    const exitPupil = calculateExitPupilByNewSpecInternal(opticalSystemRows, stopIndex, stopRadius, wavelength);
    const entrancePupil = calculateEntrancePupilByNewSpecInternal(opticalSystemRows, stopIndex, stopRadius, wavelength);
    
    return {
      exitPupil: exitPupil,
      entrancePupil: entrancePupil,
      isValid: exitPupil !== null && entrancePupil !== null,
      stopIndex: stopIndex,
      stopRadius: stopRadius
    };
  } catch (error) {
    // console.error('新仕様による瞳計算エラー:', error);
    return { exitPupil: null, entrancePupil: null, isValid: false, error: error.message };
  }
}

/**
 * 面の曲率半径を安全に取得
 * @param {Object} surface - 面データ
 * @returns {number} 曲率半径（無効な値の場合はInfinity）
 */
export function getSafeRadius(surface) {
  if (!surface) {
    // // console.warn('getSafeRadius: surface is null/undefined, returning Infinity');
    return Infinity;
  }
  
  let radius = surface.radius;
  if (radius === undefined || radius === null || radius === "") {
    // console.log(`getSafeRadius: radius未定義 (surface: ${surface.surface || 'unknown'}), Infinityを使用`);
    return Infinity;
  }
  
  const r = parseFloat(radius);
  if (!isFinite(r)) {
    // // console.warn(`getSafeRadius: 無効なradius値 "${radius}" (surface: ${surface.surface || 'unknown'}), Infinityを使用`);
    return Infinity;
  }
  
  if (Math.abs(r) < 1e-10) {
    // console.log(`getSafeRadius: radius≈0 (${r}) (surface: ${surface.surface || 'unknown'}), Infinityを使用`);
    return Infinity;
  }
  
  return r;
}

/**
 * 面の肉厚を安全に取得
 * @param {Object} surface - 面データ
 * @returns {number} 肉厚（無効な値の場合は0、INFの場合はInfinity）
 */
export function getSafeThickness(surface) {
  if (!surface) {
    // // console.warn('getSafeThickness: surface is null/undefined, returning 0');
    return 0;
  }

  // Coord Trans rows reuse the thickness field for decenterZ.
  // When a dedicated gap thickness is present, allow spacing; otherwise treat as 0.
  try {
    const st = String(surface.surfType ?? '').trim().toLowerCase();
    if (st === 'coord trans' || st === 'coordinate break' || st === 'ct') {
      const gapRaw = surface.__cooptGapThickness;
      if (gapRaw !== undefined && gapRaw !== null && String(gapRaw).trim() !== '') {
        const gapStr = String(gapRaw).toUpperCase();
        if (gapStr === 'INF' || gapStr === 'INFINITY') return Infinity;
        const gapVal = parseFloat(gapRaw);
        return isFinite(gapVal) ? gapVal : 0;
      }
      return 0;
    }
  } catch (_) {}
  
  let thickness = surface.thickness;
  if (thickness === undefined || thickness === null || thickness === "") {
    return 0;
  }
  
  // INF や Infinity の文字列処理
  const thicknessStr = String(thickness).toUpperCase();
  if (thicknessStr === "INF" || thicknessStr === "INFINITY") {
    return Infinity;
  }
  
  const t = parseFloat(thickness);
  if (!isFinite(t)) {
    // // console.warn(`getSafeThickness: 無効なthickness値 "${thickness}" (surface: ${surface.surface || 'unknown'}), 0を使用`);
    return 0;
  }
  
  return t;
}

/**
 * 全系近軸光線追跡を実行し、焦点距離とバックフォーカスを計算
 * 条件：α[0]=0（無限遠物体）、ObjectのThicknessを含めない
 * @param {Array} opticalSystemRows - 光学系データ配列
 * @param {number} wavelength - 波長 (μm), デフォルト 0.5875618μm (d-line)
 * @returns {Object} 計算結果 {focalLength, backFocalLength, imageDistance, finalHeight, finalAlpha}
 */
export function calculateFullSystemParaxialTrace(opticalSystemRows, wavelength = 0.5875618) {
  if (!opticalSystemRows || opticalSystemRows.length === 0) {
    // console.warn('光学系データが空です');
    return null;
  }

  try {
    // 標準の初期光線高さ h[1] = 1.0 を使用
    const initialHeight = 1.0;
    
    // オブジェクト距離の取得
    const objectThickness = opticalSystemRows[0]?.thickness;
    let objectDistance = null;
    let initialAlpha = 0; // デフォルトは無限遠物体
    
    // オブジェクト距離の判定と初期傾角の計算
    if (objectThickness !== undefined && objectThickness !== null) {
      const objectThicknessStr = String(objectThickness).toUpperCase();
      if (objectThicknessStr === "INF" || objectThicknessStr === "INFINITY" || objectThickness === Infinity) {
        objectDistance = Infinity;
        initialAlpha = 0; // 無限遠物体
        // console.log('オブジェクト距離: 無限遠');
      } else {
        objectDistance = parseFloat(objectThickness);
        if (isFinite(objectDistance) && objectDistance !== 0) {
          // 有限物体の場合：α[1] = -h[1] / (n * object_distance)
          // ここでは最初の媒質の屈折率を1.0（空気）と仮定
          initialAlpha = -initialHeight / (1.0 * objectDistance);
          // console.log(`オブジェクト距離: ${objectDistance.toFixed(6)} mm`);
          // console.log(`初期傾角計算: α[1] = -h[1]/(n*d0) = -${initialHeight}/(1.0*${objectDistance}) = ${initialAlpha.toFixed(6)}`);
        } else {
          objectDistance = Infinity;
          initialAlpha = 0;
          // console.log('オブジェクト距離: 無限遠（無効な値のため）');
        }
      }
    } else {
      objectDistance = Infinity;
      initialAlpha = 0;
      // console.log('オブジェクト距離: 無限遠（未定義）');
    }
    
    // 近軸光線追跡
    let h = initialHeight;    // 初期光線高さ
    let alpha = initialAlpha; // 初期換算傾角
    
    // console.log(`=== 全系近軸光線追跡開始 ===`);
    // console.log(`初期光線高さ h[1]: ${initialHeight.toFixed(6)} mm`);
    // console.log(`初期換算傾角 α[1]: ${alpha.toFixed(6)}`);
    
    // 最終面の前の面で止める（Image面の手前）
    let prevN = 1.0; // 前の媒質の屈折率（空気から開始）
    
    for (let j = 1; j < opticalSystemRows.length - 1; j++) {
      const surface = opticalSystemRows[j];
      
      // Image面をチェック
      if (surface["object type"] === "Image" || surface.comment === "Image") {
        // console.log(`面${j}: Image面 - 光線追跡終了`);
        break;
      }
      
      // Coord Transサーフェスをスキップ
      if (isCoordTransSurface(surface)) {
        // console.log(`面${j}: Coord Trans - スキップ`);
        continue;
      }
      
      const radius = getSafeRadius(surface);
      const thickness = getSafeThickness(surface);
      
      // 次の媒質の屈折率を決定
      let nextN = 1.0; // デフォルトは空気
      
      // 手動設定のRef Indexまたは材料名がある場合
      const hasManualRefIndex = surface.rindex || surface['ref index'] || surface.refIndex || surface['Ref Index'];
      const hasMaterial = surface.material && surface.material !== "" && surface.material !== "0";
      
      if (thickness > 0 && (hasManualRefIndex || hasMaterial)) {
        // 手動設定の屈折率または材料が指定されている場合
        nextN = getRefractiveIndex(surface, wavelength);
      } else {
        // 材料なし、手動屈折率なし、またはthickness=0の場合は空気
        nextN = 1.0;
      }
      
      // console.log(`面${j}: R=${radius.toFixed(6)}, t=${thickness.toFixed(6)}, n=${prevN.toFixed(6)}→${nextN.toFixed(6)}`);
      // console.log(`面${j} 入射: h=${h.toFixed(6)}, α=${alpha.toFixed(6)}`);
      
      // console.log(`面${j}: Material="${surface.material || 'empty'}", RefIndex="${surface['ref index'] || surface.refIndex || 'none'}", R=${radius.toFixed(6)}, t=${thickness.toFixed(6)}, n=${prevN.toFixed(6)}→${nextN.toFixed(6)}`);
      // console.log(`面${j} 入射: h=${h.toFixed(6)}, α=${alpha.toFixed(6)}`);
      
      // 数値チェック
      if (!isFinite(nextN) || nextN <= 0) {
        // console.log(`  ⚠️ 無効な屈折率 nextN=${nextN}, 1.0を使用`);
        nextN = 1.0;
      }
      
      // 屈折力 φ[j] = (nextN - prevN) / radius
      let phi = 0;
      if (radius !== Infinity && radius !== 0) {
        phi = (nextN - prevN) / radius;
        if (!isFinite(phi)) {
          // console.log(`  ⚠️ 無効な屈折力 φ=${phi}, 0を使用`);
          phi = 0;
        }
      }
      
      // console.log(`  屈折力 φ = (${nextN.toFixed(6)} - ${prevN.toFixed(6)}) / ${radius.toFixed(6)} = ${phi.toFixed(6)}`);
      
      // console.log(`  屈折力 φ = (${nextN.toFixed(6)} - ${prevN.toFixed(6)}) / ${radius.toFixed(6)} = ${phi.toFixed(6)}`);
      
      // 光線屈折式：α[j+1] = α[j] + φ[j] * h[j]
      const oldAlpha = alpha;
      alpha = alpha + phi * h;
      // console.log(`  屈折: α[${j+1}] = ${oldAlpha.toFixed(6)} + ${phi.toFixed(6)} * ${h.toFixed(6)} = ${alpha.toFixed(6)}`);
      
      if (!isFinite(alpha)) {
        // console.log(`  ❌ αが無効になりました: α=${alpha}, phi=${phi}, h=${h}`);
        return null;
      }
      
      // 光線移行（最終面でない場合）：h[j+1] = h[j] - thickness * α[j+1] / nextN
      if (j < opticalSystemRows.length - 2 && thickness > 0) {
        const oldH = h;
        h = h - thickness * alpha / nextN;
        // console.log(`  移行: h[${j+1}] = ${oldH.toFixed(6)} - ${thickness.toFixed(6)} * ${alpha.toFixed(6)} / ${nextN.toFixed(6)} = ${h.toFixed(6)}`);
        
        if (!isFinite(h)) {
          // console.log(`  ❌ hが無効になりました: h=${h}, thickness=${thickness}, alpha=${alpha}, nextN=${nextN}`);
          return null;
        }
      } else if (j >= opticalSystemRows.length - 2) {
        // console.log(`  最終面: 移行計算スキップ`);
      }
      
      // 次のiterationのために屈折率を更新
      prevN = nextN;
    }
    
    // console.log(`最終値: h=${h.toFixed(6)}, α=${alpha.toFixed(6)}`);
    
    // EFL計算：常に無限遠物体条件（α=0）で別途計算
    let focalLength = null;
    if (objectDistance !== Infinity) {
      // 有限物体の場合、EFL計算のために無限遠物体条件で再計算
      // console.log('=== EFL計算のための無限遠物体条件での光線追跡 ===');
      const eflResult = calculateEFLTrace(opticalSystemRows, wavelength);
      if (eflResult && Math.abs(eflResult.finalAlpha) > 1e-10) {
        focalLength = initialHeight / eflResult.finalAlpha;
        // console.log(`EFL計算: f = h[1]/α[final] = ${initialHeight.toFixed(6)}/${eflResult.finalAlpha.toFixed(6)} = ${focalLength.toFixed(6)} mm`);
      } else {
        focalLength = Infinity;
      }
    } else {
      // 無限遠物体の場合、通常通り計算
      if (Math.abs(alpha) > 1e-10) {
        focalLength = initialHeight / alpha;
        // console.log(`EFL計算: f = h[1]/α[final] = ${initialHeight.toFixed(6)}/${alpha.toFixed(6)} = ${focalLength.toFixed(6)} mm`);
      } else {
        focalLength = Infinity;
      }
    }
    
    // バックフォーカス計算：常に無限遠物体条件（α=0）で計算
    let backFocalLength = null;
    if (objectDistance !== Infinity) {
      // 有限物体の場合、BFL計算のために無限遠物体条件での結果を使用
      const eflResult = calculateEFLTrace(opticalSystemRows, wavelength);
      if (eflResult && Math.abs(eflResult.finalAlpha) > 1e-10) {
        backFocalLength = eflResult.finalHeight / eflResult.finalAlpha;
        // console.log(`BFL計算: BFL = h[final]/α[final] = ${eflResult.finalHeight.toFixed(6)}/${eflResult.finalAlpha.toFixed(6)} = ${backFocalLength.toFixed(6)} mm`);
      } else {
        backFocalLength = Infinity;
      }
    } else {
      // 無限遠物体の場合、通常通り計算
      if (Math.abs(alpha) > 1e-10) {
        backFocalLength = h / alpha;
        // console.log(`BFL計算: BFL = h[final]/α[final] = ${h.toFixed(6)}/${alpha.toFixed(6)} = ${backFocalLength.toFixed(6)} mm`);
      } else {
        backFocalLength = Infinity;
      }
    }
    
    // イメージディスタンス = 実際のオブジェクト距離での計算結果
    let imageDistance = null;
    if (Math.abs(alpha) > 1e-10) {
      imageDistance = h / alpha;
    } else {
      imageDistance = Infinity;
    }
    
    // console.log(`計算結果:`);
    // console.log(`  焦点距離 f = h[1]/α[final] = ${initialHeight.toFixed(6)}/${alpha.toFixed(6)} = ${focalLength.toFixed(6)} mm`);
    // console.log(`  バックフォーカス BFL = h[final]/α[final] = ${h.toFixed(6)}/${alpha.toFixed(6)} = ${backFocalLength.toFixed(6)} mm`);
    // console.log(`  イメージディスタンス = ${imageDistance.toFixed(6)} mm`);
    
    console.log(`=== 近軸計算結果 ===`);
    console.log(`  焦点距離 f = h[1]/α[final] = ${initialHeight.toFixed(6)}/${alpha.toFixed(6)} = ${focalLength.toFixed(6)} mm`);
    console.log(`  バックフォーカス BFL = h[final]/α[final] = ${h.toFixed(6)}/${alpha.toFixed(6)} = ${backFocalLength.toFixed(6)} mm`);
    console.log(`  イメージディスタンス = ${imageDistance?.toFixed(6)} mm`);
    
    return {
      focalLength: focalLength,
      backFocalLength: backFocalLength,
      imageDistance: imageDistance,
      finalHeight: h,
      finalAlpha: alpha
    };
  } catch (error) {
    // console.error('全系近軸光線追跡エラー:', error);
    // console.error('スタックトレース:', error.stack);
    return null;
  }
}

/**
 * 焦点距離（EFL: Effective Focal Length）を計算
 * @param {Array} opticalSystemRows - 光学系データ配列
 * @param {number} wavelength - 波長 (μm), デフォルト 0.5875618μm (d-line)
 * @returns {number} 焦点距離 (mm)
 */
export function calculateFocalLength(opticalSystemRows, wavelength = 0.5875618) {
  const result = calculateFullSystemParaxialTrace(opticalSystemRows, wavelength);
  return result ? result.focalLength : null;
}

/**
 * バックフォーカス（BFL: Back Focal Length）を計算
 * @param {Array} opticalSystemRows - 光学系データ配列
 * @param {number} wavelength - 波長 (μm), デフォルト 0.5875618μm (d-line)
 * @returns {number} バックフォーカス (mm)
 */
export function calculateBackFocalLength(opticalSystemRows, wavelength = 0.5875618) {
  const result = calculateFullSystemParaxialTrace(opticalSystemRows, wavelength);
  return result ? result.backFocalLength : null;
}

/**
 * イメージディスタンス（像面距離）を計算
 * @param {Array} opticalSystemRows - 光学系データ配列
 * @param {number} wavelength - 波長 (μm), デフォルト 0.5875618μm (d-line)
 * @returns {number} イメージディスタンス (mm)
 */
export function calculateImageDistance(opticalSystemRows, wavelength = 0.5875618) {
  const result = calculateFullSystemParaxialTrace(opticalSystemRows, wavelength);
  return result ? result.imageDistance : null;
}

/**
 * 入射瞳径（EnP: Entrance Pupil Diameter）を計算
 * @param {Array} opticalSystemRows - 光学系データ配列
 * @param {number} wavelength - 波長 (μm), デフォルト 0.5875618μm (d-line)
 * @returns {number} 入射瞳径 (mm)
 */
export function calculateEntrancePupilDiameter(opticalSystemRows, wavelength = 0.5875618) {
  if (!opticalSystemRows || opticalSystemRows.length === 0) {
    // console.warn('光学系データが空です');
    return null;
  }

  try {
    debugLog(2, '=== 入射瞳径計算デバッグ ===');
    const stopIndex = findStopSurfaceIndex(opticalSystemRows);
    if (stopIndex === -1) {
      // console.warn('絞り面が見つかりません');
      return null;
    }
    
    debugLog(2, `絞り面インデックス: ${stopIndex}`);
    const stopSurface = opticalSystemRows[stopIndex];
    const stopRadius = Number(stopSurface.semidia || stopSurface["Semi Diameter"] || 10);
    const stopDiameter = stopRadius * 2;
    
    debugLog(2, `Stop面半径: ${stopRadius.toFixed(6)} mm`);
    // console.log(`📏 実絞り径: ${stopDiameter.toFixed(6)} mm`);

    // 全ての場合で近軸光線追跡による適切な入射瞳径計算を実行
    // console.log('🔬 近軸光線追跡による入射瞳径計算を実行...');
    
    // 新仕様による入射瞳計算を実行
    const entrancePupilDetails = calculateEntrancePupilByNewSpecInternal(opticalSystemRows, stopIndex, stopRadius, wavelength);
    
    if (entrancePupilDetails && entrancePupilDetails.diameter > 0) {
      // console.log(`✅ 近軸計算による入射瞳径: ${entrancePupilDetails.diameter.toFixed(6)} mm`);
      // console.log(`📍 入射瞳位置: ${entrancePupilDetails.position.toFixed(6)} mm`);
      // console.log(`📊 倍率: ${entrancePupilDetails.magnification.toFixed(6)}`);
      // console.log('================================');
      return entrancePupilDetails.diameter;
    }
    
    // フォールバック: 簡単な近軸近似（第1面基準）
    // console.warn('⚠️ 新仕様計算が失敗、簡単な近軸近似を使用');
    
    if (stopIndex === 0) {
      // 絞りが第1面の場合は絞り径をそのまま使用
      // console.log('🔍 絞りが第1面: 入射瞳径 = 絞り径');
      // console.log('================================');
      return stopDiameter;
    }
    
    // その他の場合：物体面から絞り面への倍率を簡易計算
    // これは暫定的な処理で、より精密な計算が必要
    let accumulatedMagnification = 1.0;
    
    for (let i = 1; i <= stopIndex; i++) {
      const currentSurface = opticalSystemRows[i];
      const radius = Number(currentSurface.radius || currentSurface.Radius || 0);
      const thickness = Number(currentSurface.thickness || currentSurface.Thickness || 0);
      const n1 = i > 0 ? Number(opticalSystemRows[i-1]['Ref Index'] || 1.0) : 1.0;
      const n2 = Number(currentSurface['Ref Index'] || 1.0);
      
      if (Math.abs(radius) > 1e-10) {
        // 簡易的な屈折による倍率変化を考慮（近似）
        const power = (n2 - n1) / radius;
        const surfaceMagnification = n1 / n2; // 簡易近似
        accumulatedMagnification *= surfaceMagnification;
      }
    }
    
    const estimatedEntrancePupilDiameter = stopDiameter * Math.abs(accumulatedMagnification);
    
    // console.log(`📊 簡易近軸近似による入射瞳径: ${estimatedEntrancePupilDiameter.toFixed(6)} mm`);
    // console.log(`📊 累積倍率: ${accumulatedMagnification.toFixed(6)}`);
    // console.log('================================');
    return estimatedEntrancePupilDiameter;
    
  } catch (error) {
    // console.error('入射瞳径計算エラー:', error);
    // 最終フォールバック
    const stopSurface = opticalSystemRows.find(row => 
      row['object type'] === 'Stop' || row.material === 'Stop'
    );
    if (stopSurface && stopSurface.semidia) {
      const fallbackDiameter = parseFloat(stopSurface.semidia) * 2;
      // console.log(`❌ エラー時フォールバック: ${fallbackDiameter.toFixed(6)} mm`);
      return fallbackDiameter;
    }
    return null;
  }
}

/**
 * 射出瞳径（ExP: Exit Pupil Diameter）を計算
 * @param {Array} opticalSystemRows - 光学系データ配列
 * @param {number} wavelength - 波長 (μm), デフォルト 0.5875618μm (d-line)
 * @returns {number} 射出瞳径 (mm)
 */
/**
 * 射出瞳径（ExP: Exit Pupil Diameter）を計算
 * 方法：Stop面のsemidia*2*倍率
 * @param {Array} opticalSystemRows - 光学系データ配列
 * @param {number} wavelength - 波長 (μm), デフォルト 0.5875618μm (d-line)
 * @returns {number} 射出瞳径 (mm)
 */
export function calculateExitPupilDiameter(opticalSystemRows, wavelength = 0.5875618) {
  if (!opticalSystemRows || opticalSystemRows.length === 0) {
    // console.warn('光学系データが空です');
    return null;
  }

  try {
    // 絞り面を検索
    const stopIndex = findStopSurfaceIndex(opticalSystemRows);
    if (stopIndex === -1) {
      // console.warn('絞り面が見つかりません');
      return null;
    }

    // console.log('=== 射出瞳径計算デバッグ ===');
    // console.log(`絞り面インデックス: ${stopIndex}`);

    const stopSurface = opticalSystemRows[stopIndex];
    const stopRadius = Number(stopSurface.semidia || stopSurface["Semi Diameter"] || 0);
    const stopDiameter = stopRadius * 2;
    // console.log(`Stop面semidia: ${stopRadius.toFixed(6)} mm`);
    // console.log(`Stop面径 (semidia*2): ${stopDiameter.toFixed(6)} mm`);

    if (stopIndex === opticalSystemRows.length - 1) {
      // 絞りが最終面の場合、射出瞳径は絞り径と同じ
      // console.log('絞りが最終面のため、射出瞳径 = Stop径');
      // console.log('==============================');
      return {
        diameter: stopDiameter,
        position: 0  // 最終面なので位置は0
      };
    }

    // 標準準拠の近軸光線追跡による射出瞳径計算
    // console.log(`🔍 射出瞳径計算開始 (標準準拠) - Stop径: ${stopDiameter.toFixed(6)} mm`);
    
  // 新公式による射出瞳径計算を実行
    const newFormulaResult = calculateExitPupilByNewFormula(opticalSystemRows, stopIndex, wavelength);
    
    if (newFormulaResult && newFormulaResult.isValid && newFormulaResult.diameter !== null) {
  // 新公式の射出瞳径を使用
      console.log('==============================');
      return {
        diameter: newFormulaResult.diameter,
        position: newFormulaResult.position,
        magnification: newFormulaResult.magnification,
  calculationMethod: 'paraxial'
      };
    }
    
    // フォールバック: Zemax準拠の主光線・周辺光線計算
    console.log('=== フォールバック: Zemax準拠 主光線・周辺光線計算 ===');
    const primaryExitPupilData = calculateExitPupilByParaxialMethod(opticalSystemRows, stopIndex, wavelength);
    
    if (primaryExitPupilData && primaryExitPupilData.diameter !== null && isFinite(primaryExitPupilData.diameter)) {
      // console.log(`✅ 射出瞳位置: ${primaryExitPupilData.position.toFixed(6)} mm`);
      // console.log(`✅ 射出瞳径 (主光線・周辺光線計算): ${primaryExitPupilData.diameter.toFixed(6)} mm`);
      // console.log('==============================');
      return primaryExitPupilData;  // 位置と径の両方を含むオブジェクトを返す
    }
    
    // 新仕様では従来計算は使用しない
    // console.warn('❌ 主光線・周辺光線計算が失敗しました。仕様準拠計算のみを使用します。');
    // console.log('==============================');
    return {
      diameter: null,
      position: null
    };
    
    // === 以下は従来計算（新仕様では使用しない） ===
    /*
    // フォールバック: 射出瞳位置を使用した計算
    // console.warn('主光線・周辺光線計算に失敗、射出瞳位置ベース計算を使用');
    const exitPupilPosition = calculateExitPupilPosition(opticalSystemRows, wavelength);
    // console.log(`射出瞳位置: ${exitPupilPosition.toFixed(6)} mm`);
    
    if (isFinite(exitPupilPosition) && exitPupilPosition !== 0) {
      // 絞り面から像面までの距離を計算
      const imageDistance = calculateImageDistance(opticalSystemRows, wavelength);
    // console.log(`像面距離: ${imageDistance.toFixed(6)} mm`);
      
      // 射出瞳径 = 絞り径 × |射出瞳位置| / |像面距離|
      const exitPupilDiameter = stopDiameter * Math.abs(exitPupilPosition) / Math.abs(imageDistance);
      
    // console.log(`射出瞳径計算: ${stopDiameter} × ${Math.abs(exitPupilPosition).toFixed(6)} / ${Math.abs(imageDistance).toFixed(6)} = ${exitPupilDiameter.toFixed(6)} mm`);      
    // console.log(`✅ 射出瞳径 (位置ベース計算): ${exitPupilDiameter.toFixed(6)} mm`);
    // console.log('==============================');
      return {
        diameter: exitPupilDiameter,
        position: exitPupilPosition
      };
    }
    */
    
    // フォールバック：従来の計算も新仕様では使用しない
    /*
    // console.warn('正確な倍率計算に失敗、従来の方法を使用');
    const exitPupilData = calculateExitPupilByParaxialMethod(opticalSystemRows, stopIndex, wavelength);
    
    if (!exitPupilData || exitPupilData.diameter === null) {
      // console.warn('標準準拠射出瞳径計算に失敗しました、フォールバックとして従来の計算を使用');
      const fallbackMagnification = calculateMagnificationFromStop(opticalSystemRows, stopIndex, wavelength);
      if (fallbackMagnification !== null && !isNaN(fallbackMagnification)) {
        const fallbackDiameter = stopDiameter * Math.abs(fallbackMagnification);
    // console.log(`🔄 フォールバック径: ${fallbackDiameter.toFixed(6)} mm`);
        return {
          diameter: fallbackDiameter,
          position: 0
        };
      }
      return {
        diameter: stopDiameter,
        position: 0
      }; // 最終フォールバック
    }
    
    // console.log(`✅ 射出瞳位置: ${exitPupilData.position.toFixed(6)} mm`);
    // console.log(`✅ 射出瞳径 (標準準拠): ${exitPupilData.diameter.toFixed(6)}`);
    
    // 異常値チェック
    if (exitPupilData.diameter > 1000) {
      // console.warn(`⚠️ 射出瞳径が異常に大きいです: ${exitPupilData.diameter.toFixed(6)} mm`);
      // console.warn('従来の倍率計算にフォールバックします');
      const fallbackMagnification = calculateMagnificationFromStop(opticalSystemRows, stopIndex, wavelength);
      if (fallbackMagnification !== null && !isNaN(fallbackMagnification)) {
        const fallbackDiameter = stopDiameter * Math.abs(fallbackMagnification);
    // console.log(`🔄 フォールバック径: ${fallbackDiameter.toFixed(6)} mm`);
        return {
          diameter: fallbackDiameter,
          position: exitPupilData.position || 0
        };
      }
    }
    // console.log('==============================');
    
    return exitPupilData;  // 位置と径の両方を含むオブジェクトを返す
    */
  } catch (error) {
    // console.error('射出瞳径計算エラー:', error);
    return {
      diameter: null,
      position: null
    };
  }
}

/**
 * 新仕様による射出瞳計算（内部関数）
 */
function calculateExitPupilByNewSpecInternal(opticalSystemRows, stopIndex, stopRadius, wavelength) {
  try {
    // console.log('--- 射出瞳位置・径計算 (新仕様) ---');
    
    // **新仕様**: STOP面が最終面(Image面-1)の場合の特別処理
    const imageIndex = opticalSystemRows.length - 1; // Image面のインデックス
    const lastOpticalSurfaceIndex = imageIndex - 1;  // 最終光学面のインデックス
    
    if (stopIndex === lastOpticalSurfaceIndex) {
    // console.log('🔴 STOP面が最終面(Image面-1)のため、特別処理を適用');
      const stopSurface = opticalSystemRows[stopIndex];
      const stopThickness = getSafeThickness(stopSurface);
      
      // 射出瞳位置 = STOP面のthicknessのマイナス値
      const exitPupilPosition = -stopThickness;
      
      // 射出瞳径 = 絞り径（倍率は1.0とする）
      const exitPupilDiameter = stopRadius * 2;
      
    // console.log(`  STOP面thickness: ${stopThickness}mm`);
    // console.log(`  射出瞳位置: ${exitPupilPosition}mm (Image面からの距離)`);
    // console.log(`  射出瞳径: ${exitPupilDiameter}mm (倍率=1.0)`);
      
      return {
        position: exitPupilPosition,
        diameter: exitPupilDiameter,
        magnification: 1.0,
        imageDistance: 0,
        finalHeight: 0,
        finalAlpha: 0,
        initialAlpha: 0,
        isLastSurface: true  // 特別処理フラグ
      };
    }
    
    // 通常の光線追跡による計算
    const result = traceParaxialRayFromStopInternal(opticalSystemRows, stopIndex, wavelength);
    if (!result) {
    // console.error('絞り面からの光線追跡に失敗');
      return null;
    }
    
    const { imageDistance, finalHeight, finalAlpha, initialAlpha } = result;
    
    // 倍率計算: β = α[1] / α[k+1]
    const beta = Math.abs(finalAlpha) > 1e-10 ? initialAlpha / finalAlpha : 0;
    
    // 射出瞳位置 = イメージディスタンス - 最終面のthickness（Image面からの距離）
    const finalSurface = opticalSystemRows[opticalSystemRows.length - 2]; // 最終光学面
    const finalThickness = getSafeThickness(finalSurface);
    const exitPupilPosition = imageDistance - finalThickness;
    
    // 射出瞳径 = |β| × 絞り径
    const exitPupilDiameter = Math.abs(beta) * stopRadius * 2;
    
    // console.log(`射出瞳位置: ${exitPupilPosition}mm (Image面からの距離)`);
    // console.log(`  計算詳細: imageDistance=${imageDistance}mm - finalThickness=${finalThickness}mm`);
    // console.log(`射出瞳径: ${exitPupilDiameter}mm`);
    // console.log(`倍率 β: ${beta}`);
    
    return {
      position: exitPupilPosition,
      diameter: exitPupilDiameter,
      magnification: beta,
      imageDistance: imageDistance,
      finalHeight: finalHeight,
      finalAlpha: finalAlpha,
      initialAlpha: initialAlpha,
      isLastSurface: false
    };
  } catch (error) {
    // console.error('射出瞳計算エラー:', error);
    return null;
  }
}

/**
 * 新仕様による入射瞳計算（内部関数）
 */
function calculateEntrancePupilByNewSpecInternal(opticalSystemRows, stopIndex, stopRadius, wavelength) {
  try {
    console.log('=== 入射瞳位置・径計算 ===');
    console.log(`STOP面インデックス: ${stopIndex}`);
    console.log(`STOP面半径: ${stopRadius}mm`);
    
    // **新仕様**: STOP面が最初面(Object面+1)の場合の特別処理
    const firstOpticalSurfaceIndex = 1; // Object面の次の面（最初の光学面）
    
    if (stopIndex === firstOpticalSurfaceIndex) {
      console.log('🔵 STOP面が最初面(Object面+1)のため、入射瞳計算で特別処理を適用');
      console.log('  ⚠️ 入射瞳位置 = 0mm（最初の面からの相対位置）');
      console.log('  ⚠️ 入射瞳径 = STOP面のSemi Dia × 2');
      
      const entrancePupilPosition = 0; // 最初の面からの相対位置なので0
      const entrancePupilDiameter = stopRadius * 2; // Semi Dia × 2
      
      console.log(`  入射瞳位置: ${entrancePupilPosition}mm`);
      console.log(`  入射瞳径: ${entrancePupilDiameter}mm`);
      
      return {
        position: entrancePupilPosition,
        diameter: entrancePupilDiameter,
        magnification: 1.0,
        imageDistance: 0,
        finalHeight: 0,
        finalAlpha: 0,
        initialAlpha: 0,
        isFirstSurface: true,
        calculationMethod: 'first-surface-special'
      };
    }
    
    // **新仕様**: STOP面が最終面(Image面-1)の場合の特別処理
    const imageIndex = opticalSystemRows.length - 1; // Image面のインデックス
    const lastOpticalSurfaceIndex = imageIndex - 1;  // 最終光学面のインデックス
    
    if (stopIndex === lastOpticalSurfaceIndex) {
      console.log('🔴 STOP面が最終面(Image面-1)のため、入射瞳計算で特別処理を適用');
      console.log('  ⚠️ STOP面のthickness、material、rindex、abbeを前の面の値にシフト');
      
      // STOP面のパラメータを面シフトした反転システムを作成
      const reversedSystemForLastStop = createReversedOpticalSystemForLastStopInternal(opticalSystemRows, stopIndex, wavelength);
      if (!reversedSystemForLastStop || reversedSystemForLastStop.length === 0) {
        console.error('STOP面が最終面の反転システム作成に失敗');
        return null;
      }
      
      // 反転システムでのSTOP面インデックスは0
      const reversedStopIndex = 0;
      
      const result = traceParaxialRayFromStopInternal(reversedSystemForLastStop, reversedStopIndex, wavelength);
      if (!result) {
        console.warn('⚠️ STOP面が最終面の光線追跡に失敗、簡易計算を使用');
        
        // フォールバック: 簡易計算
        let cumulativeDistance = 0;
        for (let i = 0; i < stopIndex; i++) {
          const surface = opticalSystemRows[i];
          const thickness = getSafeThickness(surface);
          if (isFinite(thickness)) {
            cumulativeDistance += thickness;
          }
        }
        
        return {
          position: -cumulativeDistance * 0.5,
          diameter: stopRadius * 2,
          magnification: 1.0,
          imageDistance: 0,
          finalHeight: 0,
          finalAlpha: 0,
          initialAlpha: 0,
          isLastSurface: true,
          calculationMethod: 'simplified'
        };
      }
      
      const { imageDistance, finalHeight, finalAlpha, initialAlpha } = result;
      
      // 倍率計算: β = α[1] / α[k+1]
      const beta = Math.abs(finalAlpha) > 1e-10 ? initialAlpha / finalAlpha : 0;
      
      // 入射瞳位置 = -イメージディスタンス（物体面からの距離）
      const entrancePupilPosition = -imageDistance;
      
      // 入射瞳径 = |β| × 絞り径
      const entrancePupilDiameter = Math.abs(beta) * stopRadius * 2;
      
      console.log(`  入射瞳位置: ${entrancePupilPosition}mm`);
      console.log(`  入射瞳径: ${entrancePupilDiameter}mm`);
      console.log(`  倍率 β: ${beta}`);
      
      return {
        position: entrancePupilPosition,
        diameter: entrancePupilDiameter,
        magnification: beta,
        imageDistance: imageDistance,
        finalHeight: finalHeight,
        finalAlpha: finalAlpha,
        initialAlpha: initialAlpha,
        isLastSurface: true,
        calculationMethod: 'paraxial'
      };
    }
    
    console.log('🟢 通常のSTOP面位置、反転系での光線追跡を実行');
    
    // 通常の光線追跡による計算
    const reversedSystem = createReversedOpticalSystemInternal(opticalSystemRows, stopIndex);
    
    // 反転系での絞り面インデックス（最初の面）
    const reversedStopIndex = 0;
    
    // 反転系で絞り面から光線追跡
    const result = traceParaxialRayFromStopInternal(reversedSystem, reversedStopIndex, wavelength);
    if (!result) {
      console.error('反転系での光線追跡に失敗');
      return null;
    }
    
    const { imageDistance, finalHeight, finalAlpha, initialAlpha } = result;
    
    // 倍率計算
    const beta = Math.abs(finalAlpha) > 1e-10 ? initialAlpha / finalAlpha : 0;
    
    // 入射瞳位置 = イメージディスタンス（符号反転）
    const entrancePupilPosition = -imageDistance;
    
    // 入射瞳径 = |β| × 絞り径
    const entrancePupilDiameter = Math.abs(beta) * stopRadius * 2;
    
    console.log(`  入射瞳位置: ${entrancePupilPosition}mm`);
    console.log(`  入射瞳径: ${entrancePupilDiameter}mm`);
    console.log(`  倍率 β: ${beta}`);
    
    return {
      position: entrancePupilPosition,
      diameter: entrancePupilDiameter,
      magnification: beta,
      imageDistance: imageDistance,
      finalHeight: finalHeight,
      finalAlpha: finalAlpha,
      initialAlpha: initialAlpha
    };
  } catch (error) {
    // console.error('入射瞳計算エラー:', error);
    return null;
  }
}

/**
 * 光学系反転関数（内部関数）
 * 入射瞳計算用に絞り面から物体面への部分システムを作成
 */
function createReversedOpticalSystemInternal(opticalSystemRows, stopIndex) {
  const reversed = [];
  
  console.log(`  反転系作成: STOP面インデックス=${stopIndex}`);
  
  // 絞り面から物体面まで（逆順）の部分システムを作成
  for (let i = stopIndex; i >= 0; i--) {
    const surface = opticalSystemRows[i];
    const reversedSurface = { ...surface };
    
    // 曲率半径の符号を反転
    if (surface.radius && surface.radius !== 'Infinity' && surface.radius !== 'INF') {
      reversedSurface.radius = -parseFloat(surface.radius);
    }
    
    // 厚さと材料を前の面（面-1）の値に設定
    if (i > 0) {
      const prevSurface = opticalSystemRows[i - 1];
      reversedSurface.thickness = prevSurface.thickness;
      reversedSurface.material = prevSurface.material;
      reversedSurface.rindex = prevSurface.rindex;
    } else {
      // 最初の面（元のObject面）は厚さ0
      reversedSurface.thickness = 0;
      reversedSurface.material = '';
      reversedSurface.rindex = 1;
    }
    
    // 面IDを調整（デバッグ用）
    reversedSurface.originalId = surface.id;
    
    reversed.push(reversedSurface);
  }
  
  return reversed;
}

/**
 * 絞り面が最終面の場合の反転システム作成関数（STOP面のパラメータを面シフト）
 */
function createReversedOpticalSystemForLastStopInternal(opticalSystemRows, stopIndex, wavelength) {
  try {
    // console.log(`  🔄 STOP面が最終面の反転システム作成 (STOP面index=${stopIndex})`);
    
    const reversed = [];
    
    // STOP面から物体面へ逆順で処理
    for (let i = stopIndex; i >= 0; i--) {
      const originalSurface = opticalSystemRows[i];
      const reversedSurface = { ...originalSurface };
      
      // 曲率半径の符号反転
      if (reversedSurface.radius !== 'INF' && reversedSurface.radius !== 'Infinity' && reversedSurface.radius !== Infinity) {
        reversedSurface.radius = -parseFloat(reversedSurface.radius);
      }
      
      if (i === stopIndex) {
        // **修正**: STOP面のthickness、material、rindex、abbeを前の面（index-1）から取得
        const originalThickness = getSafeThickness(originalSurface);
        if (i - 1 >= 0) {
          const prevOriginalSurface = opticalSystemRows[i - 1];
          const newThickness = getSafeThickness(prevOriginalSurface);
          reversedSurface.thickness = newThickness;  // 前の面のthicknessを使用
          reversedSurface.material = prevOriginalSurface.material || '';
          reversedSurface.rindex = getRefractiveIndex(prevOriginalSurface, wavelength) || 1;
          reversedSurface.abbe = prevOriginalSurface.abbe || 1;
    // console.log(`    ⚠️ STOP面(面${originalSurface.id})のthickness ${originalThickness}mm → ${newThickness}mm (from 面${prevOriginalSurface.id})`);
    // console.log(`    ⚠️ STOP面(面${originalSurface.id})のmaterial '${originalSurface.material}' → '${reversedSurface.material}' (from 面${prevOriginalSurface.id})`);
    // console.log(`    ⚠️ STOP面(面${originalSurface.id})のrindex ${getRefractiveIndex(originalSurface, wavelength)} → ${reversedSurface.rindex} (from 面${prevOriginalSurface.id})`);
        } else {
          // 前の面がない場合（STOP面がObject面の場合）は0を使用
          reversedSurface.thickness = 0;
          reversedSurface.material = '';
          reversedSurface.rindex = 1;
          reversedSurface.abbe = 1;
    // console.log(`    ⚠️ STOP面(面${originalSurface.id})のthickness ${originalThickness}mm → 0mm (前の面なし)`);
        }
      } else if (i === 0) {
        // Object面: thickness=0、前の媒質（元のObject面の後ろ）
        const originalThickness = getSafeThickness(originalSurface);
        reversedSurface.thickness = 0;
        const nextOriginalSurface = opticalSystemRows[1]; // 元の面2
        reversedSurface.material = nextOriginalSurface.material || '';
        reversedSurface.rindex = getRefractiveIndex(nextOriginalSurface, wavelength) || 1;
        reversedSurface.abbe = nextOriginalSurface.abbe || 1;
        
    // console.log(`    📋 Object面: thickness ${originalThickness}mm → 0mm`);
    // console.log(`    📋 Object面: material '${originalSurface.material}' → '${reversedSurface.material}' (from 面${nextOriginalSurface.id})`);
    // console.log(`    📋 Object面: rindex ${getRefractiveIndex(originalSurface, wavelength)} → ${reversedSurface.rindex} (from 面${nextOriginalSurface.id})`);
      } else {
        // **修正**: 通常の面のthickness、material、rindex、abbeを前の面（index-1）から取得
        const prevOriginalSurface = opticalSystemRows[i - 1];
        const originalThickness = getSafeThickness(originalSurface);
        const newThickness = getSafeThickness(prevOriginalSurface);
        
        reversedSurface.thickness = newThickness;
        reversedSurface.material = prevOriginalSurface.material || '';
        reversedSurface.rindex = getRefractiveIndex(prevOriginalSurface, wavelength) || 1;
        reversedSurface.abbe = prevOriginalSurface.abbe || 1;
        reversedSurface.semidia = prevOriginalSurface.semidia || originalSurface.semidia;
        
    // console.log(`    📋 面${originalSurface.id}: thickness ${originalThickness}mm → ${newThickness}mm (from 面${prevOriginalSurface.id})`);
    // console.log(`    📋 面${originalSurface.id}: material '${originalSurface.material}' → '${reversedSurface.material}' (from 面${prevOriginalSurface.id})`);
    // console.log(`    📋 面${originalSurface.id}: rindex ${getRefractiveIndex(originalSurface, wavelength)} → ${reversedSurface.rindex} (from 面${prevOriginalSurface.id})`);
      }
      
      // デバッグ用ID
      reversedSurface.originalId = originalSurface.id;
      reversedSurface.reversedIndex = reversed.length;
      
      reversed.push(reversedSurface);
    }
    
    // console.log(`    反転システム作成完了: ${reversed.length}面`);
    
    // 反転システムの内容を詳細表示
    // console.log('  📊 反転システム詳細:');
    for (let j = 0; j < reversed.length; j++) {
      const surf = reversed[j];
    // console.log(`    [${j}] 元面${surf.originalId}: R=${surf.radius}, t=${surf.thickness}, n=${surf.rindex}, material='${surf.material}', semidia=${surf.semidia}`);
    }
    
    return reversed;
    
  } catch (error) {
    // console.error('STOP面が最終面の反転システム作成エラー:', error);
    return null;
  }
}

/**
 * 絞り面からの光線追跡（内部関数）
 */
export function traceParaxialRayFromStopInternal(opticalSystemRows, stopIndex, wavelength) {
  try {
    console.log(`  絞り面 ${stopIndex} からの光線追跡開始`);
    
    // 初期値設定：絞り面で h[1]=1.0
    let h = 1.0;
    
    // 絞り面自体の処理
    const stopSurface = opticalSystemRows[stopIndex];
    const stopThickness = getSafeThickness(stopSurface);
    const stopN = getRefractiveIndex(stopSurface, wavelength);
    
    // Object面の物体距離を取得してα[1]を計算
    const objectSurface = opticalSystemRows[0];
    const objectDistance = getSafeThickness(objectSurface);
    
    // 逆システムでは無限遠物体として計算（入射瞳計算用）
    const d0 = -Infinity;
    
    // 絞り面でのα計算：marginal ray用
    let alpha = calculateMarginalAlphaAtStop(opticalSystemRows, stopIndex, wavelength);
    const initialAlpha = alpha; // 初期α値を記録
    
    console.log(`  絞り面初期値: h=${h.toFixed(6)}, α=${alpha.toFixed(6)}`);
    
    // 絞り面自体での処理（屈折力φ=0、移行計算なし）
    console.log(`  絞り面${stopIndex}: φ=0（屈折力なし）`);
    
    // 絞り面では移行計算をスキップ（表計算に合わせる）
    console.log(`  絞り面移行: スキップ（h=${h.toFixed(6)}維持）`);
    
    console.log(`  絞り面処理完了: h=${h.toFixed(6)}, α=${alpha.toFixed(6)}`);
    
    // 絞り面の次の面から像面まで追跡
    for (let i = stopIndex + 1; i < opticalSystemRows.length; i++) {
      const surface = opticalSystemRows[i];
      const nextSurface = i < opticalSystemRows.length - 1 ? opticalSystemRows[i + 1] : null;
      
      // Image面は光線追跡から除外
      if (surface["object type"] === "Image" || surface.comment === "Image") {
        debugLog(2, `面${i}（面${surface.id}）: Image面 - 光線追跡終了`);
        break;
      }
      
      // Coord Trans面はスキップ
      if (isCoordTransSurface(surface)) {
        debugLog(2, `面${i}（面${surface.id}）: Coord Trans面をスキップ`);
        continue;
      }
      
      // 屈折率取得（前の媒質から現在の媒質へ）
      const prevSurface = i > 0 ? opticalSystemRows[i - 1] : null;
      const currentN = prevSurface ? getRefractiveIndex(prevSurface, wavelength) : 1.0; // 前の媒質
      const nextN = getRefractiveIndex(surface, wavelength); // 現在の面の媒質
      
      // 曲率半径取得
      const radius = getSafeRadius(surface);
      const thickness = getSafeThickness(surface);
      
    // console.log(`面${i}（面${surface.id}）: R=${radius}, n=${currentN}→${nextN}, t=${thickness}`);
    // console.log(`面${i}（面${surface.id}）入射: h=${h}, α=${alpha}`);
      
      // 屈折計算
      if (radius !== Infinity && radius !== 0) {
        const phi = (nextN - currentN) / radius;
        alpha = alpha + phi * h;
      }
      
    // console.log(`面${i}（面${surface.id}）屈折後: h=${h}, α=${alpha}`);
      
      // 移行計算（スプレッドシート式: h[j+1] = h[j] - d[j] * α[j+1] / n[j+1]）
      // 最終面（面11）では移行計算をスキップ
      if (i < opticalSystemRows.length - 2) {
        // thickness = 0の場合は1E-18を使用（瞳計算での数値安定性のため）
        const effectiveThickness = thickness === 0 ? 1e-18 : thickness;
        
        if (effectiveThickness > 0 && nextN > 0) {
          const originalH = h;
          h = h - effectiveThickness * alpha / nextN;
          
          if (thickness === 0) {
    // console.log(`面${i}（面${surface.id}）移行: thickness=0 → 1E-18使用, h: ${originalH} → ${h}`);
          } else {
    // console.log(`面${i}（面${surface.id}）移行後: h=${h}, α=${alpha}`);
          }
        } else {
    // console.log(`面${i}（面${surface.id}）移行スキップ（thickness=${effectiveThickness}, nextN=${nextN}）`);
        }
      } else {
    // console.log(`面${i}（面${surface.id}）移行スキップ（最終面）: h=${h}, α=${alpha}`);
      }
    }
    
    // イメージディスタンス計算
    const imageDistance = Math.abs(alpha) > 1e-10 ? h / alpha : Infinity;
    
    console.log(`  最終値: h=${h.toFixed(6)}, α=${alpha.toFixed(6)}`);
    console.log(`  イメージディスタンス: ${imageDistance.toFixed(6)}mm`);
    
    return {
      imageDistance: imageDistance,
      finalHeight: h,
      finalAlpha: alpha,
      initialAlpha: initialAlpha
    };
    
  } catch (error) {
    console.error('光線追跡エラー:', error);
    return null;
  }
}

/**
 * 屈折率を取得
 */
export function getRefractiveIndex(surface, wavelength = 0.5875618) {
  if (!surface) return 1.0;
  
  // ガラスカタログから屈折率を取得（Materialが設定されている場合を優先）
  if (surface.material && surface.material !== '' && surface.material !== 'Air' && surface.material !== 'AIR' && surface.material !== 'empty') {
    try {
      const glassData = getGlassData(surface.material);
      if (glassData) {
        // 指定波長での屈折率を計算
        if (glassData.sellmeier) {
          const refractiveIndex = calculateRefractiveIndex(glassData.sellmeier, wavelength);
          // console.log(`🔍 ${surface.material}: λ=${wavelength.toFixed(4)}μm → n=${refractiveIndex.toFixed(6)}`);
          return refractiveIndex;
        } else {
          // Sellmeierデータがない場合はd線の屈折率を使用
          console.log(`⚠️ ${surface.material}: Sellmeierデータなし、d線屈折率=${glassData.nd}を使用`);
          return glassData.nd;
        }
      }
    } catch (error) {
      console.warn(`⚠️ ガラスデータ取得エラー: ${surface.material}, ${error.message} - 手動Ref Indexにフォールバック`);
    }
  }
  
  // 手動設定のRef Indexをチェック（Materialが空の場合のみ）
  if (surface.rindex || surface['ref index'] || surface.refIndex || surface['Ref Index']) {
    const manualRefIndex = surface.rindex || surface['ref index'] || surface.refIndex || surface['Ref Index'];
    const numValue = parseFloat(manualRefIndex);
    if (!isNaN(numValue) && numValue > 0) {
      // console.log(`🔧 手動設定Ref Index使用: ${numValue} (Material: "${surface.material || 'empty'}")`);
      return numValue;
    }
  }
  
  // デバッグ：Material空白の場合の処理状況
  if (!surface.material || surface.material === '' || surface.material === 'empty') {
    const availableRefIndex = surface.rindex || surface['ref index'] || surface.refIndex || 'none';
    if (availableRefIndex !== 'none') {
      // console.log(`ℹ️ Material空白面（手動屈折率設定あり）: ref index=${availableRefIndex}`);
    } else {
      // console.log(`ℹ️ Material空白面（屈折率未設定）: 最終屈折率=1.0（空気）`);
    }
  }
  
  // 数値で直接指定されている場合
  if (typeof surface.material === 'number') {
    return surface.material;
  }
  
  // 文字列で数値が指定されている場合
  if (typeof surface.material === 'string') {
    const numValue = parseFloat(surface.material);
    if (!isNaN(numValue)) {
      return numValue;
    }
  }
  
  // ガラスカタログから屈折率を取得
  if (surface.material && surface.material !== '' && surface.material !== 'Air' && surface.material !== 'AIR') {
    try {
      const glassData = getGlassData(surface.material);
      if (glassData) {
        // 指定波長での屈折率を計算
        if (glassData.sellmeier) {
          const refractiveIndex = calculateRefractiveIndex(glassData.sellmeier, wavelength);
          console.log(`🔍 ${surface.material}: λ=${wavelength.toFixed(4)}μm → n=${refractiveIndex.toFixed(6)}`);
          return refractiveIndex;
        } else {
          // Sellmeierデータがない場合はd線の屈折率を使用
          console.log(`⚠️ ${surface.material}: Sellmeierデータなし、d線屈折率=${glassData.nd}を使用`);
          return glassData.nd;
        }
      }
    } catch (error) {
      debugWarn(1, `ガラスデータ取得エラー: ${surface.material}, ${error.message}`);
    }
  }
  
  // 最終的にAirまたは空の場合
  debugWarn(1, `未知の材質: ${surface.material}、屈折率1.0を使用`);
  return 1.0;
}

/**
 * 絞り面のインデックスを検索
 */
export function findStopSurfaceIndex(opticalSystemRows) {
  if (!opticalSystemRows || opticalSystemRows.length === 0) {
    return -1;
  }

  // 明示的に絞り面が指定されている場合（Objectカラムで"Stop"を検索）
  for (let i = 0; i < opticalSystemRows.length; i++) {
    const surface = opticalSystemRows[i];
    if (isCoordTransSurface(surface)) continue;
    const objectRaw = String(surface.object ?? surface["object type"] ?? '').trim().toLowerCase();
    const commentRaw = String(surface.comment ?? '').trim().toLowerCase();
    if (objectRaw === 'sto' || objectRaw === 'stop' || objectRaw.includes('stop') ||
        commentRaw === 'stop' || commentRaw === 'aperture stop' || commentRaw.includes('stop')) {
    // console.log(`絞り面が見つかりました: インデックス ${i}（面${surface.id}）`);
      return i;
    }
  }

  // 明示的な絞り面が見つからない場合、光学系の中央付近を絞り面とする
  // Object面、Image面、Coord Trans面を除外した有効面の中央
  let validSurfaces = [];
  for (let i = 1; i < opticalSystemRows.length - 1; i++) {
    const surface = opticalSystemRows[i];
    if (surface.comment !== "Object" && 
        surface.comment !== "Image" && 
        !isCoordTransSurface(surface)) {
      validSurfaces.push(i);
    }
  }
  
  if (validSurfaces.length > 0) {
    const middleIndex = Math.floor(validSurfaces.length / 2);
    const stopIndex = validSurfaces[middleIndex];
    // console.log(`明示的な絞り面が見つからないため、面${stopIndex}を絞り面として使用`);
    return stopIndex;
  }

    // console.log('絞り面が見つかりませんでした');
  return -1;
}

/**
 * 近軸データの統合計算
 */
export function calculateParaxialData(opticalSystemRows, wavelength = 0.5875618) {
  try {
    // console.log('=== calculateParaxialData 開始 ===');
    
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
    // console.warn('光学系データが空です');
      return null;
    }

    // console.log('全系近軸光線追跡実行中...');
    const fullSystemResult = calculateFullSystemParaxialTrace(opticalSystemRows, wavelength);
    
    if (!fullSystemResult) {
    // console.error('全系近軸光線追跡が失敗しました');
      return null;
    }

    // console.log('焦点距離:', fullSystemResult.focalLength);
    // console.log('バックフォーカス:', fullSystemResult.backFocalLength);
    // console.log('イメージディスタンス:', fullSystemResult.imageDistance);

    // console.log('入射瞳径計算中...');
    const EnP = calculateEntrancePupilDiameter(opticalSystemRows, wavelength);
    // console.log(`入射瞳径: ${EnP}`);
    
    // 絞り面検索
    // console.log('絞り面検索中...');
    const stopIndex = findStopSurfaceIndex(opticalSystemRows);
    // console.log(`絞り面インデックス: ${stopIndex}`);
    
    let exitPupilDetails = null;
    if (stopIndex !== -1) {
    // console.log('射出瞳詳細計算中...');
      // 🆕 新公式による射出瞳径計算を最優先で実行
      const newFormulaResult = calculateExitPupilByNewFormula(opticalSystemRows, stopIndex, wavelength);
      
      if (newFormulaResult && newFormulaResult.isValid) {
        exitPupilDetails = newFormulaResult;
      } else {
        // フォールバック: 従来の計算方法
        exitPupilDetails = calculateExitPupilByParaxialMethod(opticalSystemRows, stopIndex, wavelength);
      }
    // console.log('射出瞳詳細計算完了:', exitPupilDetails);
    }

    // console.log('射出瞳径計算中...');
    const ExP = exitPupilDetails ? exitPupilDetails.diameter : calculateExitPupilDiameter(opticalSystemRows, wavelength);
    // console.log(`最終射出瞳径: ${ExP}`);

    // === 新仕様による瞳計算 ===
    // console.log('=== 新仕様による瞳計算実行 ===');
    const newSpecPupils = calculatePupilsByNewSpec(opticalSystemRows, wavelength);

    const result = {
      focalLength: fullSystemResult.focalLength,
      backFocalLength: fullSystemResult.backFocalLength,
      imageDistance: fullSystemResult.imageDistance,
      finalAlpha: fullSystemResult.finalAlpha,
      entrancePupilDiameter: EnP,
      exitPupilDiameter: ExP,
      wavelength: wavelength,
      exitPupilDetails: exitPupilDetails,
      newSpecPupils: newSpecPupils
    };

    // console.log('=== calculateParaxialData 結果 ===', result);
    return result;
  } catch (error) {
    // console.error('calculateParaxialData でエラーが発生しました:', error);
    // console.error('スタックトレース:', error.stack);
    return null;
  }
}

/**
 * 近軸光線追跡のデバッグ情報を出力
 */
export function debugParaxialRayTrace(opticalSystemRows, wavelength = 0.5875618) {
    // console.log('=== 近軸光線追跡デバッグ ===');
  
  if (!opticalSystemRows || opticalSystemRows.length === 0) {
    // console.warn('光学系データが空です');
    return;
  }

    // console.log(`波長: ${wavelength}nm`);
    // console.log(`光学系面数: ${opticalSystemRows.length}`);
  
  // 各面の基本情報を出力
  opticalSystemRows.forEach((surface, index) => {
    const radius = getSafeRadius(surface);
    const thickness = getSafeThickness(surface);
    const material = surface.material || 'Air';
    const n = getRefractiveIndex(surface, wavelength);
    
    // console.log(`面${index}: R=${radius}, t=${thickness}, 材質=${material}, n=${n}`);
  });
  
  // 絞り面の検索
  const stopIndex = findStopSurfaceIndex(opticalSystemRows);
    // console.log(`絞り面インデックス: ${stopIndex}`);
  
  // 近軸データ計算
  const paraxialData = calculateParaxialData(opticalSystemRows, wavelength);
  if (paraxialData) {
    // console.log('近軸データ:', paraxialData);
  }
  
    // console.log('=== 近軸光線追跡デバッグ終了 ===');
}

/**
 * 新仕様準拠の射出瞳位置・径計算（主光線・周辺光線方式）
 */
export function calculateExitPupilByParaxialMethod(opticalSystemRows, stopIndex, wavelength = 0.5875618) {
  try {
    // console.log('=== 射出瞳径算出方法2 ===');
    
    if (!opticalSystemRows || opticalSystemRows.length === 0 || stopIndex === -1) {
    // console.warn('光学系データまたは絞り面が無効です');
      return { 
        position: null, 
        diameter: null,
        specMethodDetails: {
          isValid: false,
          warning: 'Invalid optical system data or stop surface not found'
        }
      };
    }

    // Object面のThicknessを物体距離として取得
    const objectThickness = opticalSystemRows[0].thickness;
    const objectDistance = getSafeThickness(opticalSystemRows[0]);
    const d0 = objectDistance === Infinity ? -Infinity : -objectDistance;
    
    // console.log(`Object面thickness: ${objectThickness}, objectDistance: ${objectDistance}mm, d0: ${d0}mm`);

    // 絞り面の径を取得（入射瞳径）
    const stopSurface = opticalSystemRows[stopIndex];
    const stopRadius = parseFloat(stopSurface.semidia || stopSurface["Semi Diameter"] || 10);
    const entrancePupilDiameter = stopRadius * 2;
    // console.log(`入射瞳径: ${entrancePupilDiameter}mm`);

    // 周辺光線の初期値設定（無限遠物体からの光線）
    let h = 1.0;  // 標準初期光線高 h[1] = 1.0
    let alpha_marginal_full = objectDistance === Infinity ? 0 : h / (-d0);
    
    // console.log(`周辺光線初期値: h[1]=${h}, α=${alpha_marginal_full}`);

    // 絞り面から像面まで光線追跡
    const result = traceParaxialRayFromStopInternal(opticalSystemRows, stopIndex, wavelength);
    if (!result) {
    // console.error('絞り面からの光線追跡に失敗');
      return { position: null, diameter: null };
    }
    
    const { imageDistance, finalHeight, finalAlpha, initialAlpha } = result;
    
    // 倍率計算
    const beta = Math.abs(finalAlpha) > 1e-10 ? initialAlpha / finalAlpha : 0;
    
    // 射出瞳径 = |β| × 絞り径
    const exitPupilDiameter = Math.abs(beta) * stopRadius * 2;
    
    // console.log(`射出瞳径 = |β| × 絞り半径 × 2 = ${Math.abs(beta)} × ${stopRadius} × 2 = ${exitPupilDiameter}mm`);
    
    return {
      position: imageDistance,
      diameter: exitPupilDiameter,
      imageDistance: imageDistance,
      finalHeight: finalHeight,
      magnification: beta,
      details: {
        alpha_marginal_full: alpha_marginal_full,
        initialAlpha: initialAlpha,
        finalAlpha: finalAlpha
      }
    };
  } catch (error) {
    // console.error('射出瞳計算エラー:', error);
    return null;
  }
}

/**
 * marginal ray（周辺光線）用の絞り面でのα値を計算
 * 計算式: α = h / (-thickness × material)
 */
export function calculateMarginalAlphaAtStop(opticalSystemRows, stopIndex, wavelength) {
  try {
    const stopSurface = opticalSystemRows[stopIndex];
    const stopThickness = getSafeThickness(stopSurface);
    const stopMaterial = getRefractiveIndex(stopSurface, wavelength);
    
    // thickness = 0の場合は1E-18を使用（瞳計算での数値安定性のため）
    const effectiveThickness = stopThickness === 0 ? 1e-18 : stopThickness;
    
    // α = h / (-thickness × material)
    // h = 1.0（標準化された光線高さ）
    const marginalAlpha = 1.0 / (-effectiveThickness * stopMaterial);
    
    // console.log(`marginal ray α計算:`);
    // console.log(`  h = 1.0`);
    // console.log(`  thickness = ${stopThickness}${stopThickness === 0 ? ' → 1E-18使用' : ''}`);
    // console.log(`  material = ${stopMaterial}`);
    // console.log(`  α = 1.0 / (-${effectiveThickness} × ${stopMaterial}) = ${marginalAlpha}`);
    
    return marginalAlpha;
  } catch (error) {
    // console.error('marginal ray α計算エラー:', error);
    return 0;
  }
}

/**
 * Coord Trans面かどうかを判定
 * @param {Object} surface - 面データ
 * @returns {boolean} Coord Trans面の場合true
 */
function isCoordTransSurface(surface) {
  if (!surface) return false;
  
  const fields = [
    surface.surfType, surface.type, surface.surfaceType, surface.surface_type, surface.surfTypeName,
    surface['object type'], surface.object, surface.Object,
    surface.comment, surface.Comment,
    surface.blockType, surface.block_type, surface.blockTypeName
  ];
  const isCb = (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    if (!s) return false;
    if (s === 'ct' || s === 'coordtrans' || s === 'coordinatebreak' || s === 'coord trans' || s === 'coordinate break') return true;
    return s.includes('coord trans') || s.includes('coordinate break');
  };
  return fields.some(isCb);
}

/**
 * EFL計算専用の無限遠物体条件での光線追跡
 * @param {Array} opticalSystemRows - 光学系データ配列
 * @param {number} wavelength - 波長 (nm)
 * @returns {Object} {finalHeight, finalAlpha}
 */
function calculateEFLTrace(opticalSystemRows, wavelength = 0.5875618) {
  const initialHeight = 1.0;
  let h = initialHeight;
  let alpha = 0; // 無限遠物体条件
  
  let prevN = 1.0; // 前の媒質の屈折率（空気から開始）
  
  for (let j = 1; j < opticalSystemRows.length - 1; j++) {
    const surface = opticalSystemRows[j];
    
    // Image面をチェック
    if (surface["object type"] === "Image" || surface.comment === "Image") {
      break;
    }
    
    // Coord Transサーフェスをスキップ
    if (isCoordTransSurface(surface)) {
      continue;
    }
    
    const radius = getSafeRadius(surface);
    const thickness = getSafeThickness(surface);
    
    // 次の媒質の屈折率を決定
    let nextN = 1.0; // デフォルトは空気
    
    // 手動設定のRef Indexまたは材料名がある場合
    const hasManualRefIndex = surface['ref index'] || surface.refIndex || surface['Ref Index'];
    const hasMaterial = surface.material && surface.material !== "" && surface.material !== "0";
    
    if (thickness > 0 && (hasManualRefIndex || hasMaterial)) {
      nextN = getRefractiveIndex(surface, wavelength);
    }
    
    if (!isFinite(nextN) || nextN <= 0) {
      nextN = 1.0;
    }
    
    // 屈折力 φ[j] = (nextN - prevN) / radius
    let phi = 0;
    if (radius !== Infinity && radius !== 0) {
      phi = (nextN - prevN) / radius;
      if (!isFinite(phi)) {
        phi = 0;
      }
    }
    
    // 光線屈折式：α[j+1] = α[j] + φ[j] * h[j]
    alpha = alpha + phi * h;
    
    if (!isFinite(alpha)) {
      return null;
    }
    
    // 光線移行（最終面でない場合）
    if (j < opticalSystemRows.length - 2 && thickness > 0) {
      h = h - thickness * alpha / nextN;
      
      if (!isFinite(h)) {
        return null;
      }
    }
    
    // 次のiterationのために屈折率を更新
    prevN = nextN;
  }
  
  return {
    finalHeight: h,
    finalAlpha: alpha
  };
}

/**
 * 新公式を使って射出瞳径を計算
 * ExPD = abs(stop_sr × βexp × 2)
 * ここで βexp は「Stop→Image」の近軸倍率（βexp = α[1] / α[k+1]）。
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} stopIndex - 絞り面インデックス
 * @param {number} wavelength - 波長
 * @returns {Object} 射出瞳データ
 */
function calculateExitPupilByNewFormula(opticalSystemRows, stopIndex, wavelength = 0.5875618) {
  try {
  // 射出瞳径計算開始
    
    // 絞り面の半径を取得
    const stopSurface = opticalSystemRows[stopIndex];
    const stopRadius = Number(stopSurface.semidia || stopSurface["Semi Diameter"] || 10);
  // Stop面半径: ${stopRadius}
    
    // 射出瞳倍率（Stop→Image）を計算（βexp = α[1] / α[k+1]）
    // 近軸の標準計算（絞り面から像面）を使って取得
    const exitPupilResult = calculateExitPupilByParaxialMethod(opticalSystemRows, stopIndex, wavelength);
    const betaExp = exitPupilResult?.magnification;
    if (betaExp === undefined || betaExp === null || !isFinite(betaExp)) {
      console.error('❌ βexp計算に失敗しました');
      return null;
    }
  // βexp (Stop→Image倍率): ${betaExp}

    // 新公式: ExPD = abs(stop_sr × βexp × 2)
    const exitPupilDiameter = Math.abs(stopRadius * betaExp * 2);
  // ExPD = abs(stop_sr × βexp × 2) = ${exitPupilDiameter}
    
    return {
      diameter: exitPupilDiameter,
      position: exitPupilResult?.position || null,
  magnification: betaExp, // 射出瞳倍率
      betaExp: betaExp,
  betaEnp: undefined,
      stopRadius: stopRadius,
  calculationMethod: 'paraxial',
      isValid: true
    };
    
  } catch (error) {
    console.error('❌ 新公式による射出瞳径計算エラー:', error);
    return null;
  }
}