/**
 * Seidel Aberration Coefficients Calculator
 * 
 * Calculates the five primary Seidel aberration coefficients:
 * - S1: Spherical Aberration (SPHA)
 * - S2: Coma (COMA)
 * - S3: Astigmatism (ASTI)
 * - S4: Field Curvature (FCUR)
 * - S5: Distortion (DIST)
 * 
 * Also calculates:
 * - LCA: Longitudinal Chromatic Aberration (normalized)
 * - TCA: Transverse Chromatic Aberration (normalized)
 */

import { calculateRefractiveIndex, getGlassDataWithSellmeier } from '../../data/glass.ts';
import { 
    getSafeRadius, 
    getSafeThickness, 
    getRefractiveIndex as getRefractiveIndexFromSurface,
    findStopSurfaceIndex,
    calculateFocalLength,
    calculateBackFocalLength,
    calculatePupilsByNewSpec,
    calculateFullSystemParaxialTrace,
    isCoordTransSurface
} from '../../raytracing/core/ray-paraxial.ts';
import { tableSource, loadTableData as loadSourceTableData } from '../../data/table-source.ts';

const console = new Proxy(globalThis.console, {
    get(target, prop, receiver) {
        if (prop === 'log') {
            return () => {};
        }
        return Reflect.get(target, prop, receiver);
    }
}) as Console;

function getSourceRowsSafe() {
    try {
        if (tableSource && typeof tableSource.getData === 'function') {
            const d = tableSource.getData();
            return Array.isArray(d) ? d : [];
        }
    } catch (_) {
        // ignore and fall back
    }
    try {
        const d = loadSourceTableData();
        return Array.isArray(d) ? d : [];
    } catch (_) {
        return [];
    }
}

/**
 * Check if the optical system is afocal (infinite focal length)
 * アフォーカル系の判定（複数条件チェック）
 * @param {number} focalLength - Focal length in mm
 * @param {number} objectDistance - Object distance (thickness of Object surface) in mm
 * @param {number} backFocalLength - Back focal length in mm
 * @returns {boolean} True if afocal system
 */
function isAfocalSystem(focalLength, objectDistance, backFocalLength) {
    console.log('\n🔍 Afocal System Detection:');
    console.log(`   Focal Length: ${focalLength?.toFixed(2)} mm`);
    console.log(`   Object Distance: ${objectDistance?.toFixed(2)} mm`);
    console.log(`   Back Focal Length: ${backFocalLength?.toFixed(2)} mm`);
    
    // 条件1: 焦点距離が非常に大きい（10m以上）
    const isFocalLengthLarge = !isFinite(focalLength) || Math.abs(focalLength) > 10000;
    
    // 条件2: 物体距離と焦点距離の比が特定範囲（アフォーカル系の特徴）
    // アフォーカル系では物体が焦点距離程度離れた位置にある
    const objectToFocalRatio = Math.abs(objectDistance / focalLength);
    const isObjectNearFocalPoint = objectToFocalRatio > 0.05 && objectToFocalRatio < 0.15;
    console.log(`   Object/Focal Ratio: ${objectToFocalRatio.toFixed(4)} (0.05-0.15 for afocal)`);
    
    // 条件3: 後側焦点距離の確認（正規化値が-1前後ならアフォーカル系の可能性）
    const normalizedBFL = backFocalLength / focalLength;
    const isBFLNearMinusOne = Math.abs(normalizedBFL + 1.0) < 0.1;
    console.log(`   Normalized BFL: ${normalizedBFL.toFixed(4)} (near -1.0 for afocal)`);
    
    // 複合判定
    const isAfocal = (isFocalLengthLarge || (isObjectNearFocalPoint && isBFLNearMinusOne));
    
    console.log(`   → Afocal System: ${isAfocal ? '✅ YES' : '❌ NO'}`);
    console.log(`      - Large focal length: ${isFocalLengthLarge}`);
    console.log(`      - Object near focal point: ${isObjectNearFocalPoint}`);
    console.log(`      - BFL near -1.0: ${isBFLNearMinusOne}`);
    
    return isAfocal;
}

/**
 * Get primary wavelength from Source table
 * @returns {number} Primary wavelength in micrometers
 */
function getPrimaryWavelength() {
    const sourceData = getSourceRowsSafe();
    if (!sourceData || sourceData.length === 0) {
        console.warn('⚠️ No source data available, using default primary wavelength');
        return 0.5875618; // d-line default
    }
    
    // Find the row marked as "Primary Wavelength"
    const primaryRow = sourceData.find(row => 
        row.primary && row.primary.toLowerCase().includes('primary')
    );
    
    if (primaryRow && isFinite(parseFloat(primaryRow.wavelength))) {
        const primaryWavelength = parseFloat(primaryRow.wavelength);
        console.log(`📊 Primary wavelength: ${primaryWavelength.toFixed(7)} μm`);
        return primaryWavelength;
    }
    
    console.warn('⚠️ No primary wavelength found, using default');
    return 0.5875618; // d-line default
}

/**
 * Get shortest and longest wavelengths from Source table
 * @returns {Object} {shortest: number, longest: number} wavelengths in micrometers
 */
function getWavelengthRange() {
    const sourceData = getSourceRowsSafe();
    if (!sourceData || sourceData.length === 0) {
        console.warn('⚠️ No source data available, using default wavelengths');
        return { shortest: 0.4861327, longest: 0.6562725 }; // F-line, C-line
    }
    
    let minWavelength = Infinity;
    let maxWavelength = -Infinity;
    
    sourceData.forEach(row => {
        const wavelength = parseFloat(row.wavelength);
        if (isFinite(wavelength)) {
            if (wavelength < minWavelength) minWavelength = wavelength;
            if (wavelength > maxWavelength) maxWavelength = wavelength;
        }
    });
    
    if (!isFinite(minWavelength) || !isFinite(maxWavelength)) {
        console.warn('⚠️ Invalid wavelength data, using defaults');
        return { shortest: 0.4861327, longest: 0.6562725 };
    }
    
    console.log(`📊 Wavelength range: ${minWavelength.toFixed(7)} μm - ${maxWavelength.toFixed(7)} μm`);
    return { shortest: minWavelength, longest: maxWavelength };
}

/**
 * Calculate Seidel coefficients for an optical system
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} wavelength - Wavelength in micrometers
 * @param {Array} objectRows - Object table data for field angle
 * @returns {Object} Seidel coefficients for each surface and totals
 */
export function calculateSeidelCoefficients(opticalSystemRows, wavelength = 0.5875618, objectRows = null, options = {}) {
    console.log('🔬 Calculating Seidel coefficients...');
    
    if (!opticalSystemRows || opticalSystemRows.length < 2) {
        console.warn('⚠️ Insufficient optical system data for Seidel calculation');
        return null;
    }
    
    // Stopの位置と入射瞳径を取得
    let stopIndex = -1;
    let entrancePupilRadius = 1.0; // デフォルト値
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const row = opticalSystemRows[i];
        if (row['object type'] === 'Stop' || row.object === 'Stop') {
            stopIndex = i;
            const semidia = parseFloat(row.semidia);
            if (isFinite(semidia) && semidia > 0) {
                entrancePupilRadius = semidia;
            }
            break;
        }
    }
    console.log(`📐 Entrance Pupil Radius (Stop semidia): ${entrancePupilRadius}`);
    
    // Object面のthickness（物体距離）を取得
    const objectThickness = opticalSystemRows.length > 0 ? parseFloat(opticalSystemRows[0].thickness) : 100;

    // 有限系か無限系かを判定（後段の正規化・主光線追跡の分岐で使用）
    const isFiniteSystem = isFinite(objectThickness) && objectThickness !== 0;
    
    // Objectテーブルから最大視野角と物体高さを取得
    let maxFieldAngle = 0; // デフォルト値（ラジアン）
    let maxObjectHeight = 0; // 物体高さ（mm）
    if (objectRows && objectRows.length > 0) {
        console.log(`🔍 Object table rows: ${objectRows.length}`);
        // 最大のyHeightAngleを探す
        objectRows.forEach((obj, idx) => {
            console.log(`🔍 Object ${idx}: position=${obj.position}, yHeightAngle=${obj.yHeightAngle}`, obj);
            const yValue = parseFloat(obj.yHeightAngle);
            if (!isFinite(yValue)) {
                console.log(`  ⚠️ yValue is not finite: ${yValue}`);
                return;
            }
            
            let fieldAngle = 0;
            let objectHeight = 0;
            
            // Positionの設定を確認
            if (obj.position === 'Angle') {
                // 角度として扱う（度→ラジアン）
                fieldAngle = yValue * Math.PI / 180.0;
                // 角度から物体高さを逆算
                objectHeight = objectThickness * Math.tan(fieldAngle);
                console.log(`  📐 Angle mode: ${yValue}° → fieldAngle=${fieldAngle.toFixed(6)} rad, objectHeight=${objectHeight.toFixed(6)} mm`);
            } else if (obj.position === 'Rectangle') {
                // 物体高さとして扱う（mm）
                objectHeight = yValue;
                // 視野角を計算
                if (objectThickness > 0) {
                    fieldAngle = Math.atan(yValue / objectThickness);
                }
                console.log(`  📐 Rectangle mode: height=${yValue} mm → fieldAngle=${fieldAngle.toFixed(6)} rad`);
            } else {
                console.log(`  ⚠️ Unknown position mode: ${obj.position}`);
            }
            
            if (Math.abs(fieldAngle) > Math.abs(maxFieldAngle)) {
                maxFieldAngle = fieldAngle;
                maxObjectHeight = objectHeight;
                console.log(`  ✅ New maximum: fieldAngle=${fieldAngle.toFixed(6)}, objectHeight=${objectHeight.toFixed(6)}`);
            }
        });
    }
    console.log(`📐 Max Field Angle: ${(maxFieldAngle * 180 / Math.PI).toFixed(2)}° (${maxFieldAngle.toFixed(6)} rad)`);
    console.log(`📐 Max Object Height: ${maxObjectHeight.toFixed(6)} mm`);
    
    // 近軸光線追跡を実行（独自実装）
    const traceData = performParaxialTrace(opticalSystemRows, wavelength, entrancePupilRadius, maxFieldAngle);

    if (!traceData || traceData.length === 0) {
        console.warn('⚠️ Paraxial trace failed');
        return null;
    }

    console.log('📊 Trace data length:', traceData.length);

    // 焦点距離を計算（ray-paraxial.jsの標準関数を使用）
    const focalLength = calculateFocalLength(opticalSystemRows, wavelength);
    console.log(`📊 Focal Length (from calculateFocalLength): ${focalLength?.toFixed(6)} mm`);
    
    // 後側焦点距離を計算
    const backFocalLength = calculateBackFocalLength(opticalSystemRows, wavelength);
    console.log(`📊 Back Focal Length: ${backFocalLength?.toFixed(6)} mm`);
    
    if (!focalLength || !isFinite(focalLength) || Math.abs(focalLength) < 1e-10) {
        console.error('⚠️ Invalid focal length calculated');
        return null;
    }
    
    // Reference Focal Length
    // Priority:
    // 1) options.referenceFocalLengthOverride (number)
    //    - >0: force that value
    //    - 0: force Auto (use calculated FL), ignore textbox
    // 2) UI textbox #reference-focal-length (if present)
    // 3) Auto (calculated FL)
    let referenceFocalLength = focalLength; // Auto default

    const overrideRaw = options ? options.referenceFocalLengthOverride : undefined;
    const overrideNum = (overrideRaw === null || overrideRaw === undefined) ? NaN : Number(overrideRaw);

    if (Number.isFinite(overrideNum)) {
        if (overrideNum > 0) {
            referenceFocalLength = overrideNum;
            console.log(`📊 Using Reference Focal Length Override: ${referenceFocalLength.toFixed(6)} mm`);
        } else {
            // overrideNum === 0 => Auto (calculated FL)
            console.log(`📊 Reference Focal Length override set to Auto (using calculated FL: ${referenceFocalLength.toFixed(6)} mm)`);
        }
    } else {
        const refFLInput = (typeof document !== 'undefined') ? document.getElementById('reference-focal-length') : null;
        if (refFLInput) {
            const inputValue = refFLInput.value.trim();
            if (inputValue !== '' && inputValue.toLowerCase() !== 'auto') {
                const parsedValue = parseFloat(inputValue);
                if (isFinite(parsedValue) && parsedValue > 0) {
                    referenceFocalLength = parsedValue;
                    console.log(`📊 Using User-Specified Reference Focal Length: ${referenceFocalLength.toFixed(6)} mm`);
                } else {
                    console.warn('⚠️ Invalid Reference Focal Length input, using auto (calculated FL)');
                }
            } else {
                console.log(`📊 Reference Focal Length set to Auto (using calculated FL: ${referenceFocalLength.toFixed(6)} mm)`);
            }
        }
    }
    
    // NFL (Normalized Focal Length) = FL / Reference FL を計算
    const NFL = focalLength / referenceFocalLength;
    console.log(`📊 NFL (Normalized Focal Length): ${NFL.toFixed(6)}`);
    
    // Reference Focal Lengthで正規化した光学系を作成
    const normalizedOpticalSystem = opticalSystemRows.map(surface => {
        const normalized = { ...surface };
        const radius = getSafeRadius(surface);
        const thickness = getSafeThickness(surface);
        
        if (isFinite(radius) && radius !== 0) {
            normalized.radius = (radius / referenceFocalLength).toString();
        }
        if (isFinite(thickness)) {
            normalized.thickness = (thickness / referenceFocalLength).toString();
        }
        
        return normalized;
    });
    
    // 入射瞳位置を計算（色収差計算で必要）
    const pupilsData = calculatePupilsByNewSpec(normalizedOpticalSystem, wavelength);
    const entrancePupilPosition = pupilsData?.entrancePupil?.position || 0; // 正規化された入射瞳位置
    
    // 正規化された系で周辺光線追跡を実行（NFL = h[1]）
    const normalizedMarginalTrace = performParaxialTrace(normalizedOpticalSystem, wavelength, entrancePupilRadius, maxFieldAngle, NFL, true);
    
    // 有限系の場合、主光線追跡用に正規化Object thicknessを設定
    if (isFiniteSystem) {
        // 元のObject thicknessを正規化（実際の有限値）
        const originalObjectThickness = getSafeThickness(opticalSystemRows[0]);
        const normalizedObjectThickness = originalObjectThickness / referenceFocalLength;
        
        // normalizedOpticalSystemのObject面のthicknessを上書き
        normalizedOpticalSystem[0] = {
            ...normalizedOpticalSystem[0],
            thickness: normalizedObjectThickness.toString()
        };
        
        console.log(`🔧 正規化系のObject thickness設定: ${originalObjectThickness} / ${referenceFocalLength} = ${normalizedObjectThickness.toFixed(6)}`);
    }
    
    // 物体高さを正規化
    const normalizedObjectHeight = maxObjectHeight / referenceFocalLength;
    console.log(`🔧 正規化系の物体高さ: ${maxObjectHeight} / ${referenceFocalLength} = ${normalizedObjectHeight.toFixed(6)}`);
    
    // 正規化された系で主光線追跡を実行（α[1]_ = -1/NFL）
    const normalizedChiefTrace = performChiefRayTrace(normalizedOpticalSystem, wavelength, NFL, maxFieldAngle, normalizedObjectHeight);
    
    // === 主光線追跡データのデバッグ出力 ===
    console.log(`\n🔍 主光線追跡データ（normalizedChiefTrace）:`);
    for (let i = 0; i < normalizedChiefTrace.length; i++) {
        console.log(`  [${i}] surface=${normalizedChiefTrace[i].surface}, h=${normalizedChiefTrace[i].height.toFixed(8)}, α=${normalizedChiefTrace[i].alpha.toFixed(8)}, n=${normalizedChiefTrace[i].n.toFixed(6)}`);
    }
    
    console.log(`\n🔍 周辺光線追跡データ（normalizedMarginalTrace）:`);
    for (let i = 0; i < normalizedMarginalTrace.length; i++) {
        console.log(`  [${i}] surface=${normalizedMarginalTrace[i].surface}, h=${normalizedMarginalTrace[i].height.toFixed(8)}, α=${normalizedMarginalTrace[i].alpha.toFixed(8)}, n=${normalizedMarginalTrace[i].n.toFixed(6)}`);
    }
    
    // === 式3・2・15の検証（正規化された系で）===
    if (isFiniteSystem && normalizedChiefTrace.length > 2) {
        // 主光線がゼロの場合（入射瞳が第1面にある場合）は検証をスキップ
        const hasNonZeroChiefRay = normalizedChiefTrace.some(data => 
            Math.abs(data.height) > 1e-9 || Math.abs(data.alpha) > 1e-9
        );
        
        if (!hasNonZeroChiefRay) {
            console.log(`\n⚠️ 式3・2・15の検証をスキップ: 主光線がゼロ（入射瞳が第1面にあるため）\n`);
        } else {
            // 最後のレンズ面を探す（Image面を除く）
            let lastLensSurfaceIndex = -1;
            for (let i = normalizedOpticalSystem.length - 2; i >= 1; i--) {
                const r = getSafeRadius(normalizedOpticalSystem[i]);
                if (isFinite(r) && r !== 0) {
                    lastLensSurfaceIndex = i;
                    break;
                }
            }
        
        if (lastLensSurfaceIndex > 0 && lastLensSurfaceIndex < normalizedChiefTrace.length) {
            const lensSurface = normalizedChiefTrace[lastLensSurfaceIndex];
            
            // レンズ面kの出射側情報（k'）
            const h_bar_k_prime = lensSurface.height;
            const alpha_bar_k_prime = lensSurface.alpha;
            
            // レンズ面kの左側の屈折率（Nk）
            const n_k_left = lastLensSurfaceIndex > 0 ? getRefractiveIndexFromSurface(normalizedOpticalSystem[lastLensSurfaceIndex - 1], wavelength) : 1.0;
            
            // レンズ面kのパラメータ（正規化済み）
            const r_k = getSafeRadius(normalizedOpticalSystem[lastLensSurfaceIndex]);
            const n_k_right = getRefractiveIndexFromSurface(normalizedOpticalSystem[lastLensSurfaceIndex], wavelength);
            
            // gk'の計算: gk' = Nk' * rk / (Nk' - Nk)
            const g_k_prime = (r_k !== 0 && isFinite(r_k)) ? (n_k_right * r_k) / (n_k_right - n_k_left) : Infinity;
            
            // 入射瞳からこのレンズ面までの距離を計算（ℓk）正規化済み
            const pupilsData = calculatePupilsByNewSpec(normalizedOpticalSystem, wavelength);
            let l_k = 0;
            if (pupilsData && pupilsData.entrancePupil && isFinite(pupilsData.entrancePupil.position)) {
                // entrance pupil position は最初の面からの相対位置なので、Object面からの絶対位置に変換
                const objectThickness_normalized = getSafeThickness(normalizedOpticalSystem[0]);
                const entrancePupilPosFromObject = objectThickness_normalized + pupilsData.entrancePupil.position;
                
                // Object面からこのレンズ面までの全距離を計算
                let totalDistance = 0;
                for (let i = 0; i < lastLensSurfaceIndex; i++) {
                    totalDistance += getSafeThickness(normalizedOpticalSystem[i]);
                }
                l_k = totalDistance - entrancePupilPosFromObject; // 入射瞳からレンズ面までの距離
            }
            
            // 式3・2・15の右辺を計算
            const expected_alpha_bar = isFinite(g_k_prime) && g_k_prime !== 0 ? -(n_k_right / g_k_prime) : 0;
            const expected_h_bar = isFinite(g_k_prime) && g_k_prime !== 0 ? -(l_k / g_k_prime) : 0;
            
            console.log(`\n${'='.repeat(60)}`);
            console.log(`📊 式3・2・15の検証（正規化系・最後のレンズ面）`);
            console.log(`${'='.repeat(60)}`);
            console.log(`  面 k = ${lastLensSurfaceIndex} (${normalizedOpticalSystem[lastLensSurfaceIndex]['object type'] || 'Lens'})`);
            console.log(`  Nk (左側) = ${n_k_left.toFixed(6)}, Nk' (右側) = ${n_k_right.toFixed(6)}`);
            console.log(`  rk (正規化) = ${r_k.toFixed(6)}`);
            console.log(`  gk' (正規化) = ${g_k_prime.toFixed(6)}`);
            console.log(`  ℓk (入射瞳→面k, 正規化) = ${l_k.toFixed(6)}`);
            console.log(`${'─'.repeat(60)}`);
            console.log(`  【実測値（正規化系の光線追跡）】`);
            console.log(`    h̄k' = ${h_bar_k_prime.toFixed(8)}`);
            console.log(`    ᾱk' = ${alpha_bar_k_prime.toFixed(8)}`);
            console.log(`${'─'.repeat(60)}`);
            console.log(`  【式3・2・15の期待値】`);
            console.log(`    ᾱk' = -Nk'/gk' = ${expected_alpha_bar.toFixed(8)}`);
            console.log(`    h̄k' = -ℓk/gk' = ${expected_h_bar.toFixed(8)}`);
            console.log(`${'─'.repeat(60)}`);
            const error_alpha = Math.abs(alpha_bar_k_prime - expected_alpha_bar);
            const error_h = Math.abs(h_bar_k_prime - expected_h_bar);
            console.log(`  【誤差（|実測値 - 期待値|）】`);
            console.log(`    |Δᾱk'| = ${error_alpha.toFixed(10)} ${error_alpha < 1e-6 ? '✅' : '❌'}`);
            console.log(`    |Δh̄k'| = ${error_h.toFixed(10)} ${error_h < 1e-6 ? '✅' : '❌'}`);
            console.log(`${'='.repeat(60)}\n`);
        }
        }
    }
    
    // 光学不変量を計算: H̃ = α₁h₁ - ᾱ₁h₁ (式20c)
    // 絞り面（Stop）のデータを使用
    const stopSurfaceIndex = findStopSurfaceIndex(opticalSystemRows);
    console.log(`🎯 STOP surface index for Seidel calculation: ${stopSurfaceIndex}`);
    
    // 物体が無限遠にある場合の光学不変量計算 (式12b)
    // 注意: h₁ は第1面での周辺光線高さ（正規化系で1.0）
    const alpha_marginal = 0; // α₁ = 0 (無限遠物体)
    const h_marginal = normalizedMarginalTrace[1]?.height || 1.0; // h₁ = 第1面での周辺光線高さ (正規化系で1.0)
    const alpha_chief = -1.0; // ᾱ₁ = -φ = -1/f = -1 (正規化系)
    const h_chief = NFL; // h̄₁ = f (焦点距離、正規化系で1.0)
    
    // 光学不変量: H̄ = α₁h̄₁ - ᾱ₁h₁ (式20c)
    const opticalInvariant = Math.abs(alpha_marginal * h_chief - alpha_chief * h_marginal);
    console.log(`📊 Optical Invariant H̄: ${opticalInvariant.toFixed(6)}`);
    console.log(`   (α₁=${alpha_marginal.toFixed(6)}, h̄₁=${h_chief.toFixed(6)} (=NFL), ᾱ₁=${alpha_chief.toFixed(6)} (=-φ), h₁=${h_marginal.toFixed(6)})`);
    
    // 3次収差係数を計算
    const surfaceCoefficients = [];
    
    console.log(`🔎 収差係数計算開始: opticalSystemRows.length = ${opticalSystemRows.length}`);
    
    for (let j = 1; j < opticalSystemRows.length; j++) {
        const surface = opticalSystemRows[j];
        const normalizedSurface = normalizedOpticalSystem[j];
        
        // 各面の基本情報をログ出力
        console.log(`\n📌 面${j}: surfType='${surface['surf type'] || surface.surfType}', material='${surface.material}', rindex='${surface.rindex}', blockType='${surface._blockType || surface.blockType}'`);
        
        // Mirror面の検出（Mirror面は収差に寄与するため、CoordTransチェック前に判定）
        const isMirror = (
            surface.material === 'MIRROR' || 
            surface.material === 'Mirror' || 
            surface.rindex === '-1' || 
            surface.rindex === -1 ||
            surface['ref index'] === '-1' ||
            surface['ref index'] === -1
        );
        console.log(`   isMirror判定結果: ${isMirror}`);
        if (isMirror) {
            console.log(`   ✅ Mirror面検出 - 収差係数計算に含める`);
        }
        
        // CoordTrans面とGap面をスキップ（ただしMirror面は除く）
        const isCoordTrans = isCoordTransSurface(surface);
        console.log(`   isCoordTransSurface判定結果: ${isCoordTrans}`);
        if (!isMirror && isCoordTrans) {
            console.log(`   ⏭️ CoordTrans面 - スキップ`);
            continue;
        }
        const isGap = surface._blockType === 'Gap' || surface.blockType === 'Gap';
        console.log(`   isGap判定結果: ${isGap}`);
        if (!isMirror && isGap) {
            console.log(`   ⏭️ Gap面 - スキップ`);
            continue;
        }
        
        console.log(`   ➡️ 面${j}を処理します`);

        
        // 周辺光線（Marginal ray）のデータ
        const marginalTrace = normalizedMarginalTrace[j];
        const marginalTracePrev = normalizedMarginalTrace[j - 1];
        
        // 主光線（Chief ray）のデータ
        const chiefTrace = normalizedChiefTrace[j];
        const chiefTracePrev = normalizedChiefTrace[j - 1];
        
        // 半径
        const radius = getSafeRadius(normalizedSurface);
        
        // 面jでの計算
        // 注意: hQ計算では「入射時」の値を使う（転送後、屈折前）
        // これは前の面の屈折後の値 = traceData[j-1].alpha と同じ
        const h = marginalTrace.height;              // h[j] (転送後の高さ)
        const alpha = marginalTracePrev.alpha;       // α[j] (入射時 = 前の面の屈折後)
        const n = marginalTrace.n;                   // n[j] (この面の右側の屈折率)
        const n_prev = marginalTracePrev.n;          // n[j-1] (この面の左側の屈折率 = 入射側)
        
        const h_chief = chiefTrace.height;                  // h[j]_ (転送後)
        
        // STOP面では主光線がその面で初期化されるため、屈折後のαを使う
        const isStopSurface = (j === stopSurfaceIndex);
        const alpha_chief = isStopSurface ? chiefTrace.alpha : chiefTracePrev.alpha;  // α[j]_ (STOP面では屈折後、それ以外は入射時)
        const alpha_chief_prev = chiefTracePrev.alpha;      // α[j-1]_ (前の面での入射時、補助項計算用)
        
        // デバッグ: Surface 1 での alpha_chief の値を確認
        if (j === 1) {
            console.log(`🔍🔍🔍 Surface 1 alpha_chief check:`);
            console.log(`  isStopSurface = ${isStopSurface}, stopSurfaceIndex = ${stopSurfaceIndex}`);
            console.log(`  chiefTracePrev (j-1=0): alpha = ${chiefTracePrev.alpha.toFixed(6)}, surface = ${chiefTracePrev.surface}`);
            console.log(`  chiefTrace (j=1): alpha = ${chiefTrace.alpha.toFixed(6)}, surface = ${chiefTrace.surface}`);
            console.log(`  Selected alpha_chief = ${alpha_chief.toFixed(6)}`);
        }
        
        // Vの計算用に前の面の高さを取得
        const h_prev = marginalTracePrev.height;      // h[j-1]
        const h_chief_prev = chiefTracePrev.height;   // h[j-1]_
        
        // 補助項の計算
        // hQ[j] = h[j] * n_left[j] / r[j] - α_reduced[j]
        // Q̄h̄ = h̄ * n_left / r - ᾱ_reduced
        // n_left[j] は面jの左側（入射側）の屈折率 = n[j-1]
        // 注意: r=∞の場合でも -α_reduced の項は残る（式5.41参照、例題5.2）
        
        // 周辺光線と主光線のαを取得（入射時の値）
        // α_reduced は教科書どおり α = N·u（換算傾角, reduced angle）。ここでは u へ戻さずそのまま扱う。
        const alpha_reduced_incident = alpha;              // 周辺光線の入射時 α = N·u
        const alpha_reduced_chief_incident = alpha_chief;  // 主光線の入射時 α = N·u
        
        // 教科書の式: hQ[j+1] = h[j+1] * N[j+1] / r[j+1] - α[j+1]
        // ここで h[j+1] は物理的高さ、N[j+1] は屈折前（左側）の屈折率
        // α[j+1] は屈折後の角度
        let hQ = -alpha_reduced_incident;  // hQ[j] = -α（r=∞の場合）
        let hQ_chief = -alpha_reduced_chief_incident;  // hQ[j]_ = -ᾱ
        
        if (isFinite(radius) && radius !== 0) {
            // hQ = h * N / r - α （Nは屈折前（左側）の屈折率, αは換算傾角）
            hQ = h * n_prev / radius - alpha_reduced_incident;
            hQ_chief = h_chief * n_prev / radius - alpha_reduced_chief_incident;
        }
        
        const J = (hQ !== 0) ? (hQ_chief / hQ) : 0;
        
        // デバッグ出力: Surface 1 と Surface 2 の詳細
        if (j === 1) {
            console.log(`🔍 Surface 1 Auxiliary Terms Debug:`);
            console.log(`   h = ${h.toFixed(6)}, h_chief = ${h_chief.toFixed(6)}`);
            console.log(`   alpha_reduced (incident, N·u) = ${alpha.toFixed(6)}, alpha_reduced_chief = ${alpha_chief.toFixed(6)}`);
            console.log(`   n_prev (left side) = ${n_prev.toFixed(6)}, radius = ${radius.toFixed(6)}`);
            console.log(`   n (right side) = ${n.toFixed(6)}`);
            console.log(`   hQ = h*n_prev/r - alpha_reduced = ${h.toFixed(6)}*${n_prev.toFixed(6)}/${radius.toFixed(6)} - ${alpha.toFixed(6)} = ${hQ.toFixed(6)}`);
            console.log(`   hQ_chief = h_chief*n_prev/r - alpha_reduced_chief = ${h_chief.toFixed(6)}*${n_prev.toFixed(6)}/${radius.toFixed(6)} - ${alpha_chief.toFixed(6)} = ${hQ_chief.toFixed(6)}`);
            console.log(`   J = hQ_chief / hQ = ${hQ_chief.toFixed(6)} / ${hQ.toFixed(6)} = ${J.toFixed(6)}`);
        }
        if (j === 2) {
            console.log(`🔍 Surface 2 Auxiliary Terms Debug:`);
            console.log(`   h = ${h.toFixed(6)}, h_chief = ${h_chief.toFixed(6)}`);
            console.log(`   alpha_reduced (incident, N·u) = ${alpha.toFixed(6)}, alpha_reduced_chief = ${alpha_chief.toFixed(6)}`);
            console.log(`   n_prev (left side) = ${n_prev.toFixed(6)}, radius = ${radius.toFixed(6)}`);
            console.log(`   n (right side) = ${n.toFixed(6)}`);
            console.log(`   hQ = h*n_prev/r - alpha_reduced = ${h.toFixed(6)}*${n_prev.toFixed(6)}/${radius.toFixed(6)} - ${alpha.toFixed(6)} = ${hQ.toFixed(6)}`);
            console.log(`   hQ_chief = h_chief*n_prev/r - alpha_reduced_chief = ${h_chief.toFixed(6)}*${n_prev.toFixed(6)}/${radius.toFixed(6)} - ${alpha_chief.toFixed(6)} = ${hQ_chief.toFixed(6)}`);
            console.log(`   J = hQ_chief / hQ = ${hQ_chief.toFixed(6)} / ${hQ.toFixed(6)} = ${J.toFixed(6)}`);
            console.log(`   Expected J = -1/3 = ${(-1/3).toFixed(6)}`);
        }
        
        // hΔ(1/ns)[j] = α_after[j] / n_after[j]^2 - α_before[j] / n_before[j]^2
        // 教科書: 同じ面jの屈折前後の差を取る！
        // α_after[j] は面jでの屈折後の値 = traceData[j].alpha
        // α_before[j] は面jでの屈折前の値 = alpha (入射角度)
        // n_after[j] は面jの右側の屈折率 = n
        // n_before[j] は面jの左側の屈折率 = n_prev
        const alpha_after = marginalTrace.alpha;  // 面jの屈折後 α = N·u
        const alpha_before = alpha;  // 面jの屈折前 α = N·u
        const n_after = n;  // 面jの右側（屈折後）
        const n_before = n_prev;  // 面jの左側（屈折前）
        
        const alpha_after_chief = chiefTrace.alpha;  // 面jの屈折後 α = N·u
        const alpha_before_chief = alpha_chief;  // 面jの屈折前 α = N·u
        
        // αは換算傾角 (N·u) として保持し、式通り α/N² 差分で計算する
        const hDelta_1_ns = alpha_after / (n_after * n_after) - alpha_before / (n_before * n_before);
        const hDelta_1_ns_chief = alpha_after_chief / (n_after * n_after) - alpha_before_chief / (n_before * n_before);
        
        // デバッグ出力: Surface 2 の hΔ(1/ns) 計算
        if (j === 2) {
            console.log(`🔍 Surface 2 hΔ(1/ns) Debug (同じ面の屈折前後の差):`);
            console.log(`   周辺光線: α_after[2]=${alpha_after.toFixed(8)}, n_after[2]=${n_after.toFixed(6)} → α/n²=${(alpha_after/(n_after*n_after)).toFixed(8)}`);
            console.log(`   周辺光線: α_before[2]=${alpha_before.toFixed(8)}, n_before[2]=${n_before.toFixed(6)} → α/n²=${(alpha_before/(n_before*n_before)).toFixed(8)}`);
            console.log(`   hΔ(1/ns) = ${hDelta_1_ns.toFixed(8)}`);
            console.log(`   主光線: α_after[2]=${alpha_after_chief.toFixed(8)}, n_after[2]=${n_after.toFixed(6)} → α/n²=${(alpha_after_chief/(n_after*n_after)).toFixed(8)}`);
            console.log(`   主光線: α_before[2]=${alpha_before_chief.toFixed(8)}, n_before[2]=${n_before.toFixed(6)} → α/n²=${(alpha_before_chief/(n_before*n_before)).toFixed(8)}`);
            console.log(`   hΔ(1/ns)_ = ${hDelta_1_ns_chief.toFixed(8)}`);

            // 追加検証: αが実はu(=α/n)として保持されている場合の補正版hΔを試算
            const alpha_after_as_angle = alpha_after * n_after;    // もしuなら角度に戻す
            const alpha_before_as_angle = alpha_before * n_before; // もしuなら角度に戻す
            const hDelta_candidate = alpha_after_as_angle / (n_after * n_after) - alpha_before_as_angle / (n_before * n_before);
            const ratio_candidate_current = (hDelta_1_ns !== 0) ? (hDelta_candidate / hDelta_1_ns) : 0;
            console.log(`   [Debug] hΔ_candidate(αをuと仮定してnを掛け戻し) = ${hDelta_candidate.toFixed(8)}, Ratio(candidate/current) = ${ratio_candidate_current.toFixed(8)}`);
        }
        
        // φ[j] = (n[j] - n[j-1]) / r[j]
        let phi = 0;
        if (isFinite(radius) && radius !== 0) {
            phi = (n - n_prev) / radius;
        }
        
        // P[j] = φ[j] / (n[j] * n[j-1])
        const P = phi / (n * n_prev);
        
        // 3次収差係数の計算（教科書 式(9)を変形）
        // 式(9): Iᵥ = hᵥ⁴Qᵥ²Δ(1/Ns)ᵥ
        // 補助量: hQ ≡ h(N/r) - α
        // 変形すると: Ⅰ[j+1] = h[j+1] × hQ[j+1]² × hΔ(1/ns)[j+1]
        const I = h * hQ * hQ * hDelta_1_ns;                       // Ⅰ[j]: SA (球面収差)
        const II = I * J;                                          // Ⅱ[j]: COMA = SA × J
        const III = h * hQ_chief * hQ_chief * hDelta_1_ns;         // Ⅲ[j]: AS (非点収差)
        
        // デバッグ: Surface 1, 2, 3, 4 の計算詳細
        if (j === 1 || j === 2 || j === 3 || j === 4) {
            console.log(`🔍🔍 Surface ${j} Seidel Calculation (式(9)変形: I=h×hQ²×Δ):`);
            console.log(`   h = ${h.toFixed(8)}, n_prev (left) = ${n_prev.toFixed(6)}, n (right) = ${n.toFixed(6)}`);
            console.log(`   hQ = h*n_prev/r - α = ${h.toFixed(6)}*${n_prev.toFixed(6)}/${radius.toFixed(6)} - ${alpha.toFixed(6)} = ${hQ.toFixed(8)}`);
            console.log(`   hΔ(1/ns) = ${hDelta_1_ns.toFixed(8)}`);
            console.log(`   I = h × hQ² × hΔ(1/ns) = ${h.toFixed(8)} × ${(hQ*hQ).toFixed(8)} × ${hDelta_1_ns.toFixed(8)} = ${I.toFixed(8)}`);

            // 教科書値から逆算した必要hΔ(1/ns)と現在値の比率を出力（スケール誤差観測用）
            const textbookI = (j === 1) ? 0 : (j === 2) ? -0.41176 : (j === 3) ? -0.50621 : (j === 4) ? 19.72708 : 0;
            const required_hDelta = (hQ !== 0) ? (textbookI / (h * hQ * hQ)) : 0;
            const ratio_required_current = (hDelta_1_ns !== 0) ? (required_hDelta / hDelta_1_ns) : 0;
            console.log(`   [Debug] Textbook I = ${textbookI.toFixed(8)}, Required hΔ = ${required_hDelta.toFixed(8)}, Ratio(required/current) = ${ratio_required_current.toFixed(8)}`);
        }
        const IV = III + P;                                         // Ⅳ[j]: Field Curvature (像面湾曲) = Ⅲ+P
        
        // Ⅴ[j]: Distortion (歪曲収差) = J・Ⅳ
        // 特別な場合: hQ = 0 の場合は V = hΔ(1/ns)_chief を使用
        let V;
        if (Math.abs(hQ) < 1e-10) {
            V = hDelta_1_ns_chief;
        } else {
            V = J * IV;
        }
        
        surfaceCoefficients.push({
            surfaceIndex: j,
            surfaceType: surface['object type'] || surface.object || '',
            isMirror: isMirror,  // Mirror面フラグ
            hQ: hQ,
            hQ_chief: hQ_chief,
            J: J,
            hDelta_1_ns: hDelta_1_ns,
            hDelta_1_ns_chief: hDelta_1_ns_chief,
            P: P,
            I: I,    // SA
            II: II,  // COMA
            III: III, // AS
            IV: IV,  // Field Curvature
            V: V     // Distortion
        });
        
        // デバッグ: push直後のisMirror値を確認
        if (isMirror) {
            console.log(`✅ 面${j}を収差係数配列に追加: isMirror=${isMirror}, material='${surface.material}', rindex='${surface.rindex}'`);
        }
    }
    
    // 合計を計算
    const totals = {
        I: 0,   // SA
        II: 0,  // COMA
        III: 0, // AS
        P: 0,   // Petzval sum
        IV: 0,  // Field Curvature
        V: 0    // Distortion
    };
    
    surfaceCoefficients.forEach(coeff => {
        totals.I += coeff.I;
        totals.II += coeff.II;
        totals.III += coeff.III;
        totals.P += coeff.P;
        totals.IV += coeff.IV;
        totals.V += coeff.V;
    });
    
    // 色収差（LCA, TCA）を計算し、surfaceCoefficientsに統合
    const chromaticOverrides = options && options.chromaticOverrides ? options.chromaticOverrides : null;
    const chromaticAberrations = calculateChromaticAberrations(
        opticalSystemRows, 
        normalizedOpticalSystem,
        referenceFocalLength,
        NFL,
        entrancePupilRadius,
        surfaceCoefficients,
        normalizedMarginalTrace,
        normalizedChiefTrace,
        opticalInvariant,
        stopSurfaceIndex,
        entrancePupilPosition,
        maxFieldAngle,  // Object tableから取得した最大画角を渡す
        normalizedObjectHeight,  // 正規化された物体高さ
        chromaticOverrides
    );
    
    // 合計にLCAとTCAを追加
    totals.LCA = chromaticAberrations.totals.LCA;
    totals.TCA = chromaticAberrations.totals.TCA;
    
    return {
        wavelength,
        entrancePupilRadius,
        maxFieldAngle,
        maxObjectHeight,
        focalLength,
        referenceFocalLength,
        NFL,
        surfaceCoefficients,
        totals,
        chromaticAberrations,
        traceData,
        opticalSystemRows,
        chromaticTraceDataOutput: chromaticAberrations.traceDataOutput  // 追加
    };
}

/**
 * Calculate Longitudinal and Transverse Chromatic Aberrations per surface
 * @param {Array} opticalSystemRows - Optical system data (original, not normalized)
 * @param {Array} normalizedOpticalSystem - Normalized optical system (by reference FL)
 * @param {number} referenceFocalLength - Reference focal length for normalization
 * @param {number} NFL - Normalized Focal Length (FL / Reference FL)
 * @param {number} entrancePupilRadius - Entrance pupil radius for normalization
 * @param {Array} surfaceCoefficients - Surface coefficients array to add LCA/TCA to
 * @param {Array} normalizedMarginalTrace - Marginal ray trace data (normalized, at reference wavelength)
 * @param {Array} normalizedChiefTrace - Chief ray trace data (normalized, at reference wavelength)
 * @param {number} opticalInvariant - Optical invariant H̃
 * @param {number} stopSurfaceIndex - Index of the stop surface
 * @param {number} entrancePupilPosition - Entrance pupil position (normalized)
 * @param {number} maxFieldAngle - Maximum field angle in radians (from Object table)
 * @returns {Object} {surfaceCoefficients: Array, totals: Object} chromatic aberrations per surface and totals
 */
function calculateChromaticAberrations(opticalSystemRows, normalizedOpticalSystem, referenceFocalLength, NFL, entrancePupilRadius, surfaceCoefficients, normalizedMarginalTrace, normalizedChiefTrace, opticalInvariant, stopSurfaceIndex, entrancePupilPosition, maxFieldAngle, normalizedObjectHeight, chromaticOverrides = null) {
    const wavelengthRange = getWavelengthRange();
    const defaultShort = wavelengthRange.shortest;  // 短波長
    const defaultLong = wavelengthRange.longest;    // 長波長
    const defaultRef = getPrimaryWavelength();      // 基準波長（主波長から取得）

    const lambdaShort = (chromaticOverrides && isFinite(Number(chromaticOverrides.lambdaShort)))
        ? Number(chromaticOverrides.lambdaShort)
        : defaultShort;
    const lambdaLong = (chromaticOverrides && isFinite(Number(chromaticOverrides.lambdaLong)))
        ? Number(chromaticOverrides.lambdaLong)
        : defaultLong;
    const referenceWavelength = (chromaticOverrides && isFinite(Number(chromaticOverrides.referenceWavelength)))
        ? Number(chromaticOverrides.referenceWavelength)
        : defaultRef;

    // ガラス未設定時の色分散近似: δN ≈ (nd - 1) / Abbe
    const getNdAbbe = (surf) => {
        if (!surf) return { nd: null, abbe: null };
        let nd = parseFloat(surf['Ref Index'] ?? surf.refIndex ?? surf.ref_index ?? surf.n ?? surf.nd);
        // Material が数値指定の場合も nd として扱う
        if (!isFinite(nd)) {
            const matNum = parseFloat(surf.Material ?? surf.material);
            if (isFinite(matNum)) nd = matNum;
        }
        const abbe = parseFloat(surf.Abbe ?? surf.abbe ?? surf.Vd ?? surf.vd ?? surf.abbeNumber ?? surf.abbe_number);
        return { nd: isFinite(nd) ? nd : null, abbe: isFinite(abbe) ? abbe : null };
    };

    // ガラス未設定時の色分散近似: δN ≈ (nd - 1) / Abbe
    const getDispersionFallback = (surf) => {
        const { nd, abbe } = getNdAbbe(surf);
        if (nd === null || abbe === null || abbe === 0) return null;
        return (nd - 1) / abbe;
    };
    
    console.log(`🌈 Calculating chromatic aberrations for λ_short=${lambdaShort.toFixed(7)} μm, λ_long=${lambdaLong.toFixed(7)} μm, λ_ref=${referenceWavelength.toFixed(7)} μm`);
    
    // 短波長での周辺光線追跡
    console.log('🔍 Performing marginal ray trace for short wavelength...');
    const marginalTraceShort = performParaxialMarginalRayTrace(opticalSystemRows, lambdaShort);
    console.log(`📊 Marginal trace short length: ${marginalTraceShort.length}`);
    
    // 長波長での周辺光線追跡
    console.log('🔍 Performing marginal ray trace for long wavelength...');
    const marginalTraceLong = performParaxialMarginalRayTrace(opticalSystemRows, lambdaLong);
    console.log(`📊 Marginal trace long length: ${marginalTraceLong.length}`);
    
    // 正規化系でも周辺光線を追跡（LCA計算用）
    const marginalTraceShortNorm = performParaxialTrace(normalizedOpticalSystem, lambdaShort, entrancePupilRadius, maxFieldAngle, NFL, true);
    const marginalTraceLongNorm = performParaxialTrace(normalizedOpticalSystem, lambdaLong, entrancePupilRadius, maxFieldAngle, NFL, true);
    
    // 正規化系で主光線を追跡（TCA計算用）
    const chiefTraceShortNorm = performChiefRayTrace(normalizedOpticalSystem, lambdaShort, NFL, maxFieldAngle, normalizedObjectHeight);
    const chiefTraceLongNorm = performChiefRayTrace(normalizedOpticalSystem, lambdaLong, NFL, maxFieldAngle, normalizedObjectHeight);
    
    // System dataテキストボックスに出力するテキストを作成
    let outputText = '\n\n=== Paraxial Marginal Ray Trace Data (Short Wavelength: ' + lambdaShort.toFixed(7) + ' μm) ===\n\n';
    outputText += 'Surface\tObject\t        Radius\t     Thickness\t        Index\t         Abbe\t         Power\t         Angle\t        Height\n';
    
    for (let i = 0; i < marginalTraceShort.length; i++) {
        const data = marginalTraceShort[i];
        const surface = opticalSystemRows[i];
        
        // CoordTrans面とGap面をスキップ（表示から除外）
        if (isCoordTransSurface(surface)) {
            continue;
        }
        if (surface._blockType === 'Gap' || surface.blockType === 'Gap') {
            continue;
        }
        
        console.log(`🔍 Surface ${i}:`, surface);
        
        const objectName = getObjectName(surface);
        const radius = getSafeRadius(surface);
        const thickness = getSafeThickness(surface);
        const abbeNumber = getAbbeNumber(surface, lambdaShort);
        
        // Mirror面を識別
        const isMirror = (surface.material === 'MIRROR' || surface.material === 'Mirror' || 
                         surface.rindex === '-1' || surface['ref index'] === '-1');
        const displayObjectName = isMirror ? 'Mirror' : objectName;
        
        console.log(`  Object: ${objectName}, Radius: ${radius}, Thickness: ${thickness}, Abbe: ${abbeNumber}`);
        console.log(`  Data: h=${data.height}, α=${data.alpha}, n=${data.n}, power=${data.power}`);
        
        const radiusStr = isFinite(radius) ? radius.toFixed(6) : 'INF';
        const thicknessStr = isFinite(thickness) ? thickness.toFixed(6) : (i === 0 ? 'INF' : '');
        const indexStr = data.n.toFixed(6);
        const abbeStr = abbeNumber.toFixed(2);
        const powerStr = data.power ? data.power.toFixed(8) : '0.00000000';
        const angleStr = data.alpha.toFixed(8);
        const heightStr = data.height.toFixed(8);
        
        const line = `${i.toString().padStart(7)}\t${displayObjectName.padEnd(6)}\t${radiusStr.padStart(13)}\t${thicknessStr.padStart(13)}\t${indexStr.padStart(13)}\t${abbeStr.padStart(13)}\t${powerStr.padStart(15)}\t${angleStr.padStart(15)}\t${heightStr.padStart(15)}\n`;
        console.log(`  Line: ${line.substring(0, 100)}...`);
        outputText += line;
    }
    
    console.log(`📝 After short wavelength loop, output text length: ${outputText.length}`);
    
    outputText += '\n\n=== Paraxial Marginal Ray Trace Data (Long Wavelength: ' + lambdaLong.toFixed(7) + ' μm) ===\n\n';
    outputText += 'Surface\tObject\t        Radius\t     Thickness\t        Index\t         Abbe\t         Power\t         Angle\t        Height\n';
    
    for (let i = 0; i < marginalTraceLong.length; i++) {
        const data = marginalTraceLong[i];
        const surface = opticalSystemRows[i];
        
        // CoordTrans面とGap面をスキップ（表示から除外）
        if (isCoordTransSurface(surface)) {
            continue;
        }
        if (surface._blockType === 'Gap' || surface.blockType === 'Gap') {
            continue;
        }
        
        console.log(`🔍 Long wavelength Surface ${i}`);
        
        const objectName = getObjectName(surface);
        const radius = getSafeRadius(surface);
        const thickness = getSafeThickness(surface);
        const abbeNumber = getAbbeNumber(surface, lambdaLong);
        
        // Mirror面を識別
        const isMirror = (surface.material === 'MIRROR' || surface.material === 'Mirror' || 
                         surface.rindex === '-1' || surface['ref index'] === '-1');
        const displayObjectName = isMirror ? 'Mirror' : objectName;
        
        const radiusStr = isFinite(radius) ? radius.toFixed(6) : 'INF';
        const thicknessStr = isFinite(thickness) ? thickness.toFixed(6) : (i === 0 ? 'INF' : '');
        const indexStr = data.n.toFixed(6);
        const abbeStr = abbeNumber.toFixed(2);
        const powerStr = data.power ? data.power.toFixed(8) : '0.00000000';
        const angleStr = data.alpha.toFixed(8);
        const heightStr = data.height.toFixed(8);
        
        const line = `${i.toString().padStart(7)}\t${displayObjectName.padEnd(6)}\t${radiusStr.padStart(13)}\t${thicknessStr.padStart(13)}\t${indexStr.padStart(13)}\t${abbeStr.padStart(13)}\t${powerStr.padStart(15)}\t${angleStr.padStart(15)}\t${heightStr.padStart(15)}\n`;
        outputText += line;
    }
    
    console.log(`📝 After long wavelength loop, output text length: ${outputText.length}`);
    
    // TCA計算：疑似コードに従い、各波長で主光線を追跡して像面での差を計算
    console.log(`\n=== Computing TCA using chief ray image heights (per pseudocode) ===`);
    console.log(`NFL: ${NFL.toFixed(6)}`);
    console.log(`Max field angle: ${maxFieldAngle.toFixed(6)} rad`);
    
    // 各波長で絞り面高さ=0になるように初期条件を調整して主光線をトレース（正規化系）
    const chiefTraceRefNorm = solveChiefRayForStop(normalizedOpticalSystem, referenceWavelength, NFL, maxFieldAngle);
    // chiefTraceShortNorm と chiefTraceLongNorm は既に362-363行目で定義済み
    
    // 実寸法系でも主光線をトレース（TCA計算用）
    const chiefTraceShort = solveChiefRayForStop(opticalSystemRows, lambdaShort, 1.0, maxFieldAngle);
    const chiefTraceLong = solveChiefRayForStop(opticalSystemRows, lambdaLong, 1.0, maxFieldAngle);
    
    // 像面での主光線高さを取得（正規化系）
    const imageSurfaceIndex = normalizedOpticalSystem.length - 1;
    const h_image_ref = chiefTraceRefNorm[imageSurfaceIndex]?.height || 0;
    const h_image_short = chiefTraceShortNorm[imageSurfaceIndex]?.height || 0;
    const h_image_long = chiefTraceLongNorm[imageSurfaceIndex]?.height || 0;
    
    console.log(`📊 Chief ray heights at image plane:`);
    console.log(`   Reference (d-line): ${h_image_ref.toFixed(8)}`);
    console.log(`   Short (F-line): ${h_image_short.toFixed(8)}`);
    console.log(`   Long (C-line): ${h_image_long.toFixed(8)}`);
    
    // 総TCA = 像面での高さの差（F-line - C-line）
    const totalTCA_image = h_image_short - h_image_long;
    
    let totalLCA = 0;
    let totalTCA = 0;
    
    // 倍率色収差：論文の公式 T_ν = (1/H̄) h_ν h̄_ν Q_ν Δ(δN/N) を使用
    // h_ν: マージナル光線高さ, h̄_ν: 主光線高さ, Q_ν: 屈折力
    // Δ(δN/N) = (δN/N)_long - (δN/N)_short, δN = n - 1
    // H̄ is the optical invariant (normalized system)
    // 正規化系で計算するため、H̄も正規化系の光学不変量を使用
    
    console.log(`\n📊 Computing TCA using formula: T_ν = h_ν × h̄_ν × Q_ν × Δ(δN/N):`);
    console.log(`  Optical Invariant H̄ (normalized): ${opticalInvariant.toFixed(8)}`);
    console.log(`  Field angle: ${(maxFieldAngle * 180 / Math.PI).toFixed(2)}° (${maxFieldAngle.toFixed(6)} rad)`);
    console.log(`  Total TCA (from image heights): ${totalTCA_image.toFixed(8)}`);
    
    // ========================================
    // 📋 教科書フォーム式(表3・3・2)に従った計算開始
    // ========================================
    console.log(`\n📋 Computing chromatic coefficients using textbook form (表3・3・2):`);
    
    for (let i = 0; i < surfaceCoefficients.length; i++) {
        const j = i + 1; // normalizedOpticalSystemでのインデックス
        const surface = normalizedOpticalSystem[j];
        
        if (!surface) {
            continue;
        }
        
        const radius_normalized = getSafeRadius(surface);
        
        if (!isFinite(radius_normalized) || radius_normalized === 0) {
            surfaceCoefficients[i].TCA = 0;
            surfaceCoefficients[i].LCA = 0;
            continue;
        }
        
        // h, hQ, h̄, hQ̄は全て標準波長（d線）で計算されたものを使用
        // 周辺光線の高さと補助項（d線のトレースデータから取得）
        const h_marginal = normalizedMarginalTrace[j]?.height || 0;
        const hQ_marginal = surfaceCoefficients[i]?.hQ || 0;
        
        // 主光線の高さと補助項（d線のトレースデータから取得）
        const h_chief = normalizedChiefTrace[j]?.height || 0;
        const hQ_chief = surfaceCoefficients[i]?.hQ_chief || 0;

        // 各波長での屈折率（屈折後の屈折率）
        const n_short = marginalTraceShortNorm[j]?.n || 1;
        const n_long = marginalTraceLongNorm[j]?.n || 1;
        const n_avg = (n_short + n_long) / 2;
        
        // 屈折前の屈折率（硝材の屈折率変化を正しく取得するため）
        const n_before_short = j > 0 ? (marginalTraceShortNorm[j-1]?.n || 1) : 1;
        const n_before_long = j > 0 ? (marginalTraceLongNorm[j-1]?.n || 1) : 1;
        
        // d線での屈折率を取得
        let n_d = normalizedMarginalTrace[j]?.n || 1.0;
        let n_d_prev = j > 0 ? (normalizedMarginalTrace[j-1]?.n || 1.0) : 1.0;
        
        // δN'とδNを定義
        let delta_N_prime = n_short - n_long;
        let delta_N = n_before_short - n_before_long;

        // ガラス未設定時の補完: Optical System表のRef IndexとAbbeから δN を近似
        const surf = opticalSystemRows[j];
        const prevSurf = j > 0 ? opticalSystemRows[j - 1] : null;
        const fallback_prime = getDispersionFallback(surf);
        const fallback_prev = getDispersionFallback(prevSurf);
        const { nd: nd_prime } = getNdAbbe(surf);
        const { nd: nd_prev_val } = getNdAbbe(prevSurf);

        if ((Math.abs(delta_N_prime) < 1e-12 || !isFinite(delta_N_prime)) && fallback_prime !== null) {
            delta_N_prime = fallback_prime;
            if (Math.abs(n_d - 1.0) < 1e-6 && nd_prime !== null) {
                n_d = nd_prime; // 空気扱いだった場合、Ref Indexで代用
            }
        }
        if ((Math.abs(delta_N) < 1e-12 || !isFinite(delta_N)) && fallback_prev !== null) {
            delta_N = fallback_prev;
            if (Math.abs(n_d_prev - 1.0) < 1e-6 && nd_prev_val !== null) {
                n_d_prev = nd_prev_val;
            }
        }
        
        // ========================================
        // 📋 教科書フォーム式(表3・3・2)に従った計算
        // ========================================
        
        // (1) Δ(δN/N) = δN'/N' - δN/N
        let delta_dN_over_N = 0;
        if (Math.abs(n_d) > 1e-10) {
            delta_dN_over_N += delta_N_prime / n_d;
        }
        if (Math.abs(n_d_prev) > 1e-10) {
            delta_dN_over_N -= delta_N / n_d_prev;
        }
        
        // (2) (1) × h = Δ(δN/N) × h
        const step2_delta_times_h = delta_dN_over_N * h_marginal;
        
        // (3) hQ (3次収差係数計算で既に計算済み)
        // hQ = h × n / r - α
        
        // L = (2) × (3) = h × hQ × Δ(δN/N)
        const LCA_j = step2_delta_times_h * hQ_marginal;
        
        // J (主光線補助項、3次収差係数計算で既に計算済み)
        const J = surfaceCoefficients[i]?.J || 0;
        
        // T = J × L
        const TCA_j = J * LCA_j;
        
        // デバッグ：面2, 3, 4の計算詳細を表示
        if (j === 2 || j === 3 || j === 4) {
            console.log(`\n📋 面${j} 色収差計算（表3・3・2フォーム式）:`);
            console.log(`  ─────────────────────────`);
            console.log(`  h (周辺光線高さ)            = ${h_marginal.toFixed(8)}`);
            console.log(`  δN' (n_F - n_C, 屈折後)     = ${delta_N_prime.toFixed(8)}`);
            console.log(`  N' (n_d, 屈折後)            = ${n_d.toFixed(8)}`);
            console.log(`  δN (屈折前)                 = ${delta_N.toFixed(8)}`);
            console.log(`  N (屈折前)                  = ${n_d_prev.toFixed(8)}`);
            console.log(`  ─────────────────────────`);
            console.log(`  (1) Δ(δN/N) = δN'/N' - δN/N = ${delta_dN_over_N.toFixed(10)}`);
            console.log(`  (2) (1) × h                 = ${step2_delta_times_h.toFixed(10)}`);
            console.log(`  (3) hQ (3次収差係数より)     = ${hQ_marginal.toFixed(10)}`);
            console.log(`  ─────────────────────────`);
            console.log(`  (2) × (3) = L (LCA)         = ${LCA_j.toFixed(8)}`);
            console.log(`  J (主光線補助項)            = ${J.toFixed(8)}`);
            console.log(`  T = J × L (TCA)             = ${TCA_j.toFixed(8)}`);
        }
        
        surfaceCoefficients[i].TCA = TCA_j;
        surfaceCoefficients[i].LCA = LCA_j;
    }
    
    // 総TCAは各面のTCAの合計を使用（公式法）
    totalTCA = 0;
    for (let i = 0; i < surfaceCoefficients.length; i++) {
        if (surfaceCoefficients[i] && surfaceCoefficients[i].TCA) {
            totalTCA += surfaceCoefficients[i].TCA;
        }
    }
    
    // 総LCAは各面のLCAの合計を使用（公式法）
    totalLCA = 0;
    for (let i = 0; i < surfaceCoefficients.length; i++) {
        if (surfaceCoefficients[i] && surfaceCoefficients[i].LCA) {
            totalLCA += surfaceCoefficients[i].LCA;
        }
    }
    
    console.log(`\n📊 TCA Calculation Summary:`);
    console.log(`   Wavelength range: F-line (${lambdaShort.toFixed(7)} μm) to C-line (${lambdaLong.toFixed(7)} μm)`);
    console.log(`   Field angle: ${(maxFieldAngle * 180 / Math.PI).toFixed(2)}° (${maxFieldAngle.toFixed(6)} rad)`);
    console.log(`   NFL: ${NFL.toFixed(6)}, Reference FL: ${referenceFocalLength.toFixed(6)} mm`);
    console.log(`   Total TCA (normalized): ${totalTCA.toFixed(8)}`);
    console.log(`   Total TCA × NFL: ${(totalTCA * NFL).toFixed(8)}`);
    console.log(`   Total TCA / NFL: ${(totalTCA / NFL).toFixed(8)}`);
    console.log(`   Total TCA × RefFL: ${(totalTCA * referenceFocalLength).toFixed(8)}`);
    console.log(`\n📊 LCA Calculation Summary:`);
    console.log(`   Total LCA (normalized): ${totalLCA.toFixed(8)}`);
    console.log(`   Total LCA × NFL: ${(totalLCA * NFL).toFixed(8)}`);
    console.log(`   Total LCA / NFL: ${(totalLCA / NFL).toFixed(8)}`);
    console.log(`   Total LCA × RefFL: ${(totalLCA * referenceFocalLength).toFixed(8)}`);    console.log(`   Total LCA (mm): ${(totalLCA * referenceFocalLength).toFixed(6)} mm`);
    
    return {
        wavelengthShort: lambdaShort,
        wavelengthLong: lambdaLong,
        surfaceCoefficients,
        totals: {
            LCA: totalLCA,
            TCA: totalTCA
        },
        traceDataOutput: outputText  // 追加: トレースデータのテキスト出力
    };
}

/**
 * Perform paraxial marginal ray trace at a specific wavelength (real mm units)
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} wavelength - Wavelength in micrometers
 * @returns {Array} Trace data for each surface including power
 */
function performParaxialMarginalRayTrace(opticalSystemRows, wavelength) {
    const traceData = [];
    
    // 初期条件: h[0]=1.0mm（Object面）、α[0]=0（無限遠物体の周辺光線）
    let h = 1.0;
    let alpha = 0.0;
    let n = 1.0;  // Object空間の屈折率
    
    // Object面（面0）
    traceData.push({
        surface: 0,
        height: h,
        alpha: alpha,
        n: n,
        power: 0
    });
    
    // 各面を追跡
    for (let i = 1; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const prevSurface = opticalSystemRows[i - 1];
        
        // 前の面の屈折率（現在の空間の屈折率）
        const n_prev = n;
        
        // 前の面からの転送（transfer）: h[i] = h[i-1] - d[i-1] * α[i-1] / n[i-1]
        const thickness = getSafeThickness(prevSurface);
        if (isFinite(thickness) && thickness !== 0) {
            h = h - thickness * alpha / n_prev;
        }
        
        // この面の右側の屈折率
        const n_next = getRefractiveIndexFromSurface(surface, wavelength);
        
        // 屈折力（power）: φ = (n' - n) / r
        const radius = getSafeRadius(surface);
        let phi = 0;
        if (radius !== 0 && isFinite(radius)) {
            phi = (n_next - n_prev) / radius;
        }
        
        // 屈折（refraction）: α[i] = α[i-1] + φ * h[i]
        alpha = alpha + phi * h;
        
        // 屈折率を更新
        n = n_next;
        
        traceData.push({
            surface: i,
            height: h,
            alpha: alpha,
            n: n,
            power: phi
        });
    }
    
    return traceData;
}

/**
 * Get object name from surface
 */
function getObjectName(surface) {
    if (!surface) return '';
    if (surface['object type'] === 'Stop' || surface.object === 'Stop') return 'Stop';
    if (surface['object type'] === 'Image' || surface.object === 'Image') return 'Image';
    if (surface['object type'] === 'Object' || surface.object === 'Object') return 'Object';
    return '';
}

/**
 * Get Abbe number for a surface
 * Priority: 
 *   1. Optical System table's Abbe column
 *   2. Return 0 if no glass (air)
 *   3. Glass data's abbe property
 *   4. Calculate from refractive indices: ν = (n_d - 1) / (n_F - n_C)
 */
function getAbbeNumber(surface, wavelength) {
    if (!surface) return 0;
    
    // 1. Optical System テーブルの Abbe カラムから取得（最優先）
    if (surface.abbe !== undefined && surface.abbe !== null && surface.abbe !== '') {
        const abbeValue = parseFloat(surface.abbe);
        if (isFinite(abbeValue)) {
            return abbeValue;
        }
    }
    
    // 2. Glass がない場合は空気（Abbe = 0）
    if (!surface.glass) return 0;
    
    // 3. Glass data からアッベ数を取得
    const glassData = window.glassData;
    if (glassData && glassData[surface.glass]) {
        const glass = glassData[surface.glass];
        if (glass.abbe) return glass.abbe;
    }
    
    // 4. 計算: ν = (n_d - 1) / (n_F - n_C)
    const n_d = getRefractiveIndexFromSurface(surface, 0.5875618); // d線
    const n_F = getRefractiveIndexFromSurface(surface, 0.4861327); // F線
    const n_C = getRefractiveIndexFromSurface(surface, 0.6562725); // C線
    
    if (n_F === n_C) return 0;
    return (n_d - 1) / (n_F - n_C);
}

/**
 * Solve chief ray initial condition so that height = 0 at stop surface (per pseudocode)
 * @param {Array} opticalSystemRows - Normalized optical system data
 * @param {number} wavelength - Wavelength in micrometers
 * @param {number} NFL - Normalized Focal Length
 * @param {number} fieldAngle - Field angle in radians
 * @returns {Array} Trace data for chief ray
 */
function solveChiefRayForStop(opticalSystemRows, wavelength, NFL, fieldAngle) {
    // Find stop surface index
    const stopIndex = opticalSystemRows.findIndex(s => s['object type'] === 'Stop');
    if (stopIndex === -1) {
        console.warn('⚠️ Stop surface not found, using regular chief ray trace');
        return performChiefRayTrace(opticalSystemRows, wavelength, NFL);
    }
    
    console.log(`🔍 solveChiefRayForStop: wavelength=${wavelength.toFixed(7)} μm`);
    
    // Log refractive indices at this wavelength
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        if (surface.material && surface.material !== '' && surface.material !== 'Air') {
            const n = getRefractiveIndexFromSurface(surface, wavelength);
            console.log(`   Surface ${i} (${surface.material}): n(λ=${wavelength.toFixed(7)})=${n.toFixed(8)}`);
        }
    }
    
    // Initial angle from field angle: u = -tan(fieldAngle) / NFL ≈ -fieldAngle / NFL
    const u0 = -fieldAngle / NFL;
    
    // Try two different initial heights: h=0 and h=1
    const traceA = traceChiefWithInitialHeight(opticalSystemRows, wavelength, NFL, 0, u0);
    const traceB = traceChiefWithInitialHeight(opticalSystemRows, wavelength, NFL, 1, u0);
    
    // Get heights at stop surface
    const hStopA = traceA[stopIndex]?.height || 0;
    const hStopB = traceB[stopIndex]?.height || 0;
    
    // Solve for initial height that makes hStop = 0
    // hStop = hStopA + (hStopB - hStopA) * h0
    // We want: hStop = 0
    // So: h0 = -hStopA / (hStopB - hStopA)
    const denom = hStopB - hStopA;
    if (Math.abs(denom) < 1e-12) {
        console.warn('⚠️ Chief ray solve failed, using h0=0');
        return traceA;
    }
    
    const h0 = -hStopA / denom;
    
    console.log(`   Solved h0=${h0.toFixed(8)}, stop heights: A=${hStopA.toFixed(8)}, B=${hStopB.toFixed(8)}`);
    
    // Trace with solved initial height
    const finalTrace = traceChiefWithInitialHeight(opticalSystemRows, wavelength, NFL, h0, u0);
    
    // Log heights at key surfaces
    console.log(`   Surface 2 height: ${finalTrace[2]?.height.toFixed(8)}`);
    console.log(`   Surface 3 height: ${finalTrace[3]?.height.toFixed(8)}`);
    console.log(`   Image height: ${finalTrace[finalTrace.length-1]?.height.toFixed(8)}`);
    
    return finalTrace;
}

/**
 * Trace chief ray with specified initial height and angle
 * @param {Array} opticalSystemRows - Normalized optical system data
 * @param {number} wavelength - Wavelength in micrometers
 * @param {number} NFL - Normalized Focal Length
 * @param {number} h0 - Initial height at surface 0
 * @param {number} u0 - Initial angle
 * @returns {Array} Trace data
 */
function traceChiefWithInitialHeight(opticalSystemRows, wavelength, NFL, h0, u0) {
    const traceData = [];
    
    // Initial refractive index
    const n1 = getRefractiveIndexFromSurface(opticalSystemRows[0], wavelength);
    
    let h = h0;
    let u = u0;
    let n = n1;
    
    // Object surface
    traceData.push({
        surface: 0,
        height: h,
        alpha: u,
        n: n1
    });
    
    // Trace through all surfaces
    for (let i = 1; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const prevSurface = opticalSystemRows[i - 1];
        
        const n_prev = n;
        
        // Transfer: h[j] = h[j-1] - d[j-1] * u[j-1] / n[j-1]
        const thickness = getSafeThickness(prevSurface);
        if (isFinite(thickness) && thickness !== 0) {
            h = h - thickness * u / n_prev;
        }
        
        // Get next refractive index
        const n_next = getRefractiveIndexFromSurface(surface, wavelength);
        
        // Refraction: u[j] = u[j-1] + φ[j] * h[j]
        // where φ[j] = (n_next - n_prev) / r[j]
        const radius = getSafeRadius(surface);
        let phi = 0;
        if (isFinite(radius) && radius !== 0) {
            phi = (n_next - n_prev) / radius;
        }
        
        u = u + phi * h;
        n = n_next;
        
        traceData.push({
            surface: i,
            height: h,
            alpha: u,
            n: n
        });
    }
    
    return traceData;
}

/**
 * Perform paraxial chief ray trace at a specific wavelength (non-normalized, real mm units)
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} wavelength - Wavelength in micrometers
 * @param {number} fieldAngle - Field angle in radians
 * @returns {Array} Trace data for each surface
 */
function performParaxialChiefRayTrace(opticalSystemRows, wavelength, fieldAngle) {
    const traceData = [];
    
    // Stopの位置を見つける
    const stopIndex = findStopSurfaceIndex(opticalSystemRows);
    if (stopIndex === -1) {
        console.warn('⚠️ STOP surface not found');
        return [];
    }
    
    // 初期条件: Object面で h=0, ubar=fieldAngle
    let hbar = 0.0;
    let ubar = fieldAngle;
    let n = 1.0;
    
    console.log(`Surface 0 (Object): h=${hbar.toFixed(8)}, α=${ubar.toFixed(8)}, n=${n.toFixed(6)}`);
    
    traceData.push({
        surface: 0,
        height: hbar,
        alpha: ubar,
        n: n
    });
    
    // 各面を追跡
    for (let i = 1; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const prevSurface = opticalSystemRows[i - 1];
        
        // 前の面の屈折率
        const n_prev = n;
        
        // 前の面からの転送（transfer）
        const thickness = getSafeThickness(prevSurface);
        if (isFinite(thickness) && thickness !== 0) {
            hbar = hbar - thickness * ubar / n_prev;
        }
        
        // この面の右側の屈折率
        const n_next = getRefractiveIndexFromSurface(surface, wavelength);
        
        // 屈折（refraction）
        const radius = getSafeRadius(surface);
        let phi = 0;
        if (radius !== 0 && isFinite(radius)) {
            phi = (n_next - n_prev) / radius;
        }
        
        ubar = ubar + phi * hbar;
        n = n_next;
        
        console.log(`Surface ${i}: h=${hbar.toFixed(8)}, α=${ubar.toFixed(8)}, n=${n.toFixed(6)}`);
        
        traceData.push({
            surface: i,
            height: hbar,
            alpha: ubar,
            n: n
        });
    }
    
    return traceData;
}

/**
 * Perform paraxial ray trace for Seidel calculation using ray-paraxial.js functions
 * Returns array of trace data for each surface
 * @param {Array} opticalSystemRows - Optical system data
 * @param {number} wavelength - Wavelength in micrometers
 * @param {number} entrancePupilRadius - Entrance pupil radius (Stop semidia)
 * @param {number} maxFieldAngle - Maximum field angle in radians
 * @param {number} NFL - Normalized Focal Length (FL / Reference FL)
 * @param {boolean} useSeidelFormulation - If true, use Seidel formulation (式3.2.12) for finite systems
 */
function performParaxialTrace(opticalSystemRows, wavelength, entrancePupilRadius = 1.0, maxFieldAngle = 0.1, NFL = 1.0, useSeidelFormulation = false) {
    const traceData = [];
    
    // Stopの位置を見つける
    const stopIndex = findStopSurfaceIndex(opticalSystemRows);
    if (stopIndex === -1) {
        console.warn('⚠️ STOP surface not found');
        return [];
    }
    console.log(`🎯 STOP surface found at index ${stopIndex}`);
    
    // 初期条件
    // Marginal ray (周辺光線): 無限遠物体の場合 h[1] = NFL, α[1] = 0
    // Chief ray (主光線): Object面で高さ0、視野角ubarで開始
    let hbar = 0.0;  // 主光線高さ
    let ubar = maxFieldAngle;  // 主光線角度（視野角）
    let n = 1.0;  // 屈折率
    
    // Object面
    const objectSurface = opticalSystemRows[0];
    const objectThickness = getSafeThickness(objectSurface);
    
    // 第1面の屈折率
    const n1 = getRefractiveIndexFromSurface(opticalSystemRows[1], wavelength);
    
    // 有限系か無限系かを判定
    const isFiniteSystem = isFinite(objectThickness) && objectThickness !== 0;
    
    console.log(`🔍 [performParaxialTrace] isFiniteSystem=${isFiniteSystem}, objectThickness=${objectThickness}, useSeidelFormulation=${useSeidelFormulation}`);
    
    let h_obj, alpha_obj;
    
    if (isFiniteSystem && useSeidelFormulation) {
        // 有限系かつSeidel係数計算用の場合（式3・2・12）
        // βは正規化される前の元の系から計算する必要がある
        // opticalSystemRowsは既に正規化された系なので、元のデータが必要
        
        // s₁: Object面から第1面までの距離（= -objectThickness, 正規化された値）
        const s1 = -objectThickness;
        const n1 = getRefractiveIndexFromSurface(opticalSystemRows[1], wavelength);
        
        // 第1面の曲率半径（正規化された値）
        const r1 = getSafeRadius(opticalSystemRows[1]);
        
        // g₁: 第1面の焦点距離（正規化された系）
        const g1 = (r1 !== 0 && isFinite(r1)) ? (n1 * r1) / (n1 - 1.0) : Infinity;
        
        // λ₁ = s₁/g₁（正規化された系での結像倍率パラメータ）
        const lambda1 = isFinite(g1) && g1 !== 0 ? s1 / g1 : 0;
        
        // β = λ₁N₁/g₁（式3.2.11）
        const beta = isFinite(g1) && g1 !== 0 ? (lambda1 * n1) / g1 : 1.0;
        
        console.log(`🎯 Finite System Initial conditions (式3・2・12):`);
        console.log(`   s₁ = ${s1.toFixed(6)}, N₁ = ${n1.toFixed(6)}`);
        console.log(`   r₁ = ${r1}, g₁ = ${g1.toFixed(6)}`);
        console.log(`   λ₁ = ${lambda1.toFixed(6)}, β = ${beta.toFixed(6)}`);
        
        // 式3・2・12に従った初期値
        // α₁ = β
        // h₁ = (s₁/N₁)β
        const alpha1 = beta;
        h_obj = (s1 / n1) * beta;
        alpha_obj = alpha1;  // αをそのまま保持

        console.log(`   h₁ = ${h_obj.toFixed(6)}, α₁ = ${alpha1.toFixed(6)}, u₁ = ${(alpha1 / n1).toFixed(6)}`);
    } else {
        // 無限遠物体の場合: 面1でh[1]=NFL, α[1]=0となるように初期条件を設定
        h_obj = NFL;
        alpha_obj = 0.0;
        console.log(`🎯 Infinite System Initial conditions: h=${h_obj.toFixed(6)} (NFL), α=${alpha_obj.toFixed(6)}`);
    }
    
    console.log(`🎯 Chief ray initial: hbar=${hbar.toFixed(6)}, ubar=${ubar.toFixed(6)}`);
    
    traceData.push({
        surface: 0,
        height: h_obj,
        alpha: alpha_obj,  // αを保存
        height_chief: hbar,
        alpha_chief: ubar * n,  // α = N*u
        n: n
    });
    
    // 各面を追跡
    let h = h_obj;
    let alpha = alpha_obj;
    let alpha_chief = ubar * n;  // α = N*u
    
    for (let i = 1; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const prevSurface = opticalSystemRows[i - 1];
        
        // CoordTrans面・Gap面をスキップ（近軸光線追跡では座標変換のみで光学的影響なし）
        const isCurrentCoordTrans = isCoordTransSurface(surface) || surface._blockType === 'Gap' || surface.blockType === 'Gap';
        if (isCurrentCoordTrans) {
            // CoordTrans面/Gap面: 光学的変化なし、前の値をそのまま記録
            traceData.push({
                surface: i,
                height: h,
                alpha: alpha,
                height_chief: hbar,
                alpha_chief: alpha_chief,
                n: n
            });
            continue;
        }
        
        // 前の面の屈折率（現在の空間の屈折率）
        const n_prev = n;
        
        // 前の面からの転送（transfer）: h[j] = h[j-1] - d[j-1] * α[j-1] / n[j-1]
        // 注意: αは換算傾角（N*u）なので、移行時に屈折率で割って傾きを取得する
        // CoordTrans面の後は、埋め込まれたGap情報を考慮
        const isPrevCoordTrans = isCoordTransSurface(prevSurface) || prevSurface._blockType === 'Gap' || prevSurface.blockType === 'Gap';
        if (!isPrevCoordTrans) {
            const thickness = getSafeThickness(prevSurface);
            if (isFinite(thickness) && thickness !== 0) {
                h = h - thickness * alpha / n_prev;
                hbar = hbar - thickness * alpha_chief / n_prev;
            }
        } else {
            // CoordTrans面の場合、埋め込まれたGap情報（__cooptGapThickness）を確認
            const gapThickness = prevSurface.__cooptGapThickness;
            if (gapThickness !== undefined && isFinite(gapThickness) && gapThickness !== 0) {
                // Gap情報をそのまま使用（符号を保持）
                h = h - gapThickness * alpha / n_prev;
                hbar = hbar - gapThickness * alpha_chief / n_prev;
                console.log(`🔧 CoordTrans面${i-1}にGap情報あり: thickness=${gapThickness.toFixed(6)}, h更新: ${h.toFixed(6)}`);
            }
        }
        
        // 面1での確認
        if (i === 1) {
            console.log(`✅ At surface 1: Marginal ray height = ${h.toFixed(6)} (target: ${NFL})`);
        }
        
        // STOP面での確認
        if (i === stopIndex) {
            console.log(`✅ At STOP surface (index ${i}): Marginal ray height = ${h.toFixed(6)}`);
            console.log(`✅ At STOP surface (index ${i}): Chief ray height = ${hbar.toFixed(6)}`);
        }
        
        // この面の右側の屈折率
        const n_next = getRefractiveIndexFromSurface(surface, wavelength);
        
        // 屈折（refraction）: α[j] = α[j-1] + φ[j-1] * h[j-1]
        // ここで、φ[j] = (n[j+1] - n[j]) / r[j]
        const radius = getSafeRadius(surface);
        let phi = 0;
        if (radius !== Infinity && radius !== 0) {
            phi = (n_next - n_prev) / radius;
            // 換算傾角の更新（α = N*u）
            alpha = alpha + phi * h;
            alpha_chief = alpha_chief + phi * hbar;
        }
        
        // 屈折率更新
        n = n_next;
        
        traceData.push({
            surface: i,
            height: h,
            alpha: alpha,  // αを保存
            height_chief: hbar,
            alpha_chief: alpha_chief,  // αを保存
            n: n
        });
    }
    
    return traceData;
}

/**
 * Perform chief ray paraxial trace
 * @param {Array} opticalSystemRows - Optical system data (normalized)
 * @param {number} wavelength - Wavelength in micrometers
 * @param {number} NFL - Normalized Focal Length (FL / Reference FL)
 * @param {number} maxFieldAngle - Maximum field angle in radians
 * @param {number} maxObjectHeight - Maximum object height in mm (normalized)
 */
function performChiefRayTrace(opticalSystemRows, wavelength, NFL = 1.0, maxFieldAngle = 0, maxObjectHeight = 0) {
    const traceData = [];
    
    // n1を取得（Object面の右側の屈折率 = 第0面から第1面までの空間の屈折率）
    const n1 = getRefractiveIndexFromSurface(opticalSystemRows[0], wavelength);
    console.log(`🎯 Chief Ray - Refractive index n1: ${n1.toFixed(6)}`);
    
    // Object面の厚さを取得して有限系か無限系かを判定
    const objectSurface = opticalSystemRows[0];
    const objectThickness = getSafeThickness(objectSurface);
    const isFiniteSystem = isFinite(objectThickness) && objectThickness !== 0;
    
    let h, alpha, n;  // alpha: reduced angle (N·u)
    
    if (isFiniteSystem) {
        // 有限系の場合（式3・2・13）
        // ℓ₁: 第1面から入射瞳までの距離
        const pupilsData = calculatePupilsByNewSpec(opticalSystemRows, wavelength);
        let l1 = 0; // デフォルト値
        
        if (pupilsData && pupilsData.entrancePupil && isFinite(pupilsData.entrancePupil.position)) {
            // pupilsData.entrancePupil.position は最初の面(Surface 1)からの相対位置
            const entrancePupilPosFromSurface1 = pupilsData.entrancePupil.position;
            const d0 = objectThickness;
            const entrancePupilPosFromObject = d0 + entrancePupilPosFromSurface1;
            l1 = entrancePupilPosFromSurface1; // Surface 1から入射瞳までの距離
            console.log(`🎯 Chief Ray - Entrance Pupil Position from Surface 1: ${entrancePupilPosFromSurface1.toFixed(6)}`);
            console.log(`🎯 Chief Ray - Entrance Pupil Position from Object: ${entrancePupilPosFromObject.toFixed(6)}`);
            console.log(`🎯 Chief Ray - Object thickness d[0]: ${d0.toFixed(6)}`);
            console.log(`🎯 Chief Ray - ℓ₁ (from Surface 1 to EnP): ${l1.toFixed(6)}`);
        }
        
        // g₁: 第1面の焦点距離
        const r1 = getSafeRadius(opticalSystemRows[1]);
        const n1_right = getRefractiveIndexFromSurface(opticalSystemRows[1], wavelength); // 第1面の右側の屈折率
        const g1 = (r1 !== 0 && isFinite(r1)) ? (n1_right * r1) / (n1_right - n1) : Infinity;
        
        console.log(`🎯 Chief Ray - r₁ = ${r1}, N₁ = ${n1.toFixed(6)}, N₁' = ${n1_right.toFixed(6)}`);
        console.log(`🎯 Chief Ray - g₁ = ${g1.toFixed(6)}`);
        
        // 特別ケース: 入射瞳が第1面にある場合（l₁ = 0）
        if (Math.abs(l1) < 1e-9) {
            // 入射瞳が第1面にある場合、主光線は入射瞳の中心を通る
            // h̄₁ = 0
            h = 0;
            
            // 有限系の標準的な主光線初期条件を使用
            // ᾱ₁ = -1/NFL （式3・2・13の簡略版）
            // α = ᾱ/n より、α₁ = -1/(NFL × n₁)
            const alpha_bar1 = -1.0 / NFL;
            alpha = alpha_bar1;   // reduced angle α = N·u
            n = n1;
            
            console.log(`🎯 Special Case: Entrance Pupil at Surface 1 (l₁ ≈ 0):`);
            console.log(`   h̄₁ = 0 (chief ray passes through entrance pupil center)`);
            console.log(`   ᾱ₁ = -1/NFL = ${alpha_bar1.toFixed(6)}`);
            const slope1 = alpha_bar1 / n1;
            console.log(`   ū₁ = ᾱ₁/N₁ = ${slope1.toFixed(6)}`);
            console.log(`   N₁ = ${n1.toFixed(6)}`);
        } else {
            // λ̄₁ = ℓ₁/g₁（式3・1・24から）
            const lambda_bar1 = isFinite(g1) && g1 !== 0 ? l1 / g1 : 0;
            
            // β = λ̄₁N₁'/g₁（式3.2.11の主光線版）
            const beta = isFinite(g1) && g1 !== 0 ? (lambda_bar1 * n1_right) / g1 : 0;
            const inv_beta = beta !== 0 ? 1.0 / beta : 0;
            
            // 式3・2・13に従った初期値
            // ᾱ₁ = -(N₁'/g₁) · 1/β
            // h̄₁ = -(ℓ₁/g₁) · 1/β
            const alpha_bar1 = isFinite(g1) && g1 !== 0 ? -(n1_right / g1) * inv_beta : 0;
            h = isFinite(g1) && g1 !== 0 ? -(l1 / g1) * inv_beta : 0;
            alpha = alpha_bar1;   // reduced angle α = N·u
            n = n1;
            
            console.log(`🎯 Finite System Chief Ray Initial conditions (式3・2・13):`);
            console.log(`   ℓ₁ = ${l1.toFixed(6)}, g₁ = ${g1.toFixed(6)}, N₁ = ${n1.toFixed(6)}`);
            console.log(`   λ̄₁ = ${lambda_bar1.toFixed(6)}, β = ${beta.toFixed(6)}, 1/β = ${inv_beta.toFixed(6)}`);
            const slope1 = alpha_bar1 / n1;
            console.log(`   h̄₁ = ${h.toFixed(6)}, ᾱ₁ = ${alpha_bar1.toFixed(6)}, ū₁ = ${slope1.toFixed(6)}`);
        }
    } else {
        // 無限系の場合
        // 正規化された系で入射瞳位置を計算する必要がある
        const pupilsData = calculatePupilsByNewSpec(opticalSystemRows, wavelength);
        
        let t1_normalized = 0; // 第1面からの入射瞳位置（正規化済み）
        let entrancePupilPos_normalized = 0; // Object面からの入射瞳位置（正規化済み）
        
        if (pupilsData && pupilsData.entrancePupil && isFinite(pupilsData.entrancePupil.position)) {
            entrancePupilPos_normalized = pupilsData.entrancePupil.position;
            t1_normalized = entrancePupilPos_normalized;
            console.log(`🎯 Infinite object detected`);
            console.log(`🎯 Normalized Entrance Pupil Position from Surface 1 (t1): ${t1_normalized.toFixed(6)}`);
        } else {
            console.warn('⚠️ 入射瞳位置の計算に失敗。t1=0として継続します。');
        }
        
        // 主光線の初期条件（無限系）
        // 教科書: ᾱ₁ = -1/f (換算傾角)、h̄₁ = -t₁/N₁ · φ だが
        // 正規化系では f_normalized = NFL なので ᾱ₁ = -1/NFL とする
        h = -entrancePupilPos_normalized / (n1 * NFL);
        alpha = -1.0 / NFL;  // ᾱ₁ = -1/f_normalized
        n = n1;
        
        const slope_init = alpha / n1;
        console.log(`🎯 Infinite System Chief Ray Initial conditions:`);
        console.log(`   h̄[1]=${h.toFixed(6)} (-EnP/(n1*NFL)), ᾱ[1]=${alpha.toFixed(6)} (-1/NFL), ū[1]=${slope_init.toFixed(6)}, n[1]=${n.toFixed(6)}`);
    }

    
    // Object面のデータを常に追加（係数計算でインデックスを合わせるため）
    if (isFiniteSystem) {
        // 有限系：Object面データはダミー（係数計算でインデックスを合わせるため）
        // 式3・2・13の初期条件はSurface 1で設定されている
        traceData.push({
            surface: 0,
            height: 0,     // ダミー値（使用しない）
            alpha: 0,      // ダミー値（使用しない）
            n: n1
        });
    } else {
        // 無限系：Object面から開始
        traceData.push({
            surface: 0,
            height: h,
            alpha: alpha,  // reduced angle α
            n: n1
        });
    }
    
    // Surface 1のデータを追加と屈折処理
    if (isFiniteSystem) {
        // 有限系：式3・2・13の初期条件を使用
        const surface1 = opticalSystemRows[1];
        const r1 = getSafeRadius(surface1);
        const n1_right = getRefractiveIndexFromSurface(surface1, wavelength);
        
        // Surface 1での屈折前のαを記録
        const alpha_before_refraction = alpha;  // reduced angle before refraction
        
        // Surface 1での屈折を適用
        let phi1 = 0;
        if (r1 !== Infinity && r1 !== 0) {
            phi1 = (n1_right - n) / r1;
            alpha = alpha + phi1 * h;
        }
        
        // 屈折率更新後のαを計算（スネルの法則に基づく）
        n = n1_right; // Surface 1通過後の屈折率に更新
        
        // Surface 1での屈折後の値をプッシュ
        traceData.push({
            surface: 1,
            height: h,
            alpha: alpha,  // reduced angle after refraction
            n: n
        });
        
        const u_before = alpha_before_refraction / n1;
        const u_after = alpha / n;
        console.log(`🎯 Surface 1 Chief Ray: h=${h.toFixed(6)}, u_before=${u_before.toFixed(6)}, u_after=${u_after.toFixed(6)}, alpha_before=${alpha_before_refraction.toFixed(6)}, alpha_after=${alpha.toFixed(6)}`);
    }
    
    // 各面を追跡
    const startIndex = isFiniteSystem ? 2 : 1;  // 有限系は面2から、無限系は面1から
    for (let i = startIndex; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const prevSurface = opticalSystemRows[i - 1];
        
        // CoordTrans面・Gap面をスキップ（近軸光線追跡では座標変換のみで光学的影響なし）
        const isCurrentCoordTrans = isCoordTransSurface(surface) || surface._blockType === 'Gap' || surface.blockType === 'Gap';
        if (isCurrentCoordTrans) {
            // CoordTrans面/Gap面: 光学的変化なし、前の値をそのまま記録
            traceData.push({
                surface: i,
                height: h,
                alpha: alpha,
                n: n
            });
            continue;
        }
        
        // 前の面の屈折率（現在の空間の屈折率）
        const n_prev = n;

        // 前の面からの転送（transfer）: h[j] = h[j-1] - d[j-1] * α[j-1] / n[j-1]
        // CoordTrans面の後は、埋め込まれたGap情報を考慮
        const isPrevCoordTrans = isCoordTransSurface(prevSurface) || prevSurface._blockType === 'Gap' || prevSurface.blockType === 'Gap';
        if (!isPrevCoordTrans) {
            const thickness = getSafeThickness(prevSurface);
            if (isFinite(thickness) && thickness !== 0) {
                h = h - thickness * alpha / n_prev; // α/n_prev = slope
            }
        } else {
            // CoordTrans面の場合、埋め込まれたGap情報（__cooptGapThickness）を確認
            const gapThickness = prevSurface.__cooptGapThickness;
            if (gapThickness !== undefined && isFinite(gapThickness) && gapThickness !== 0) {
                h = h - gapThickness * alpha / n_prev;
            }
        }
        
        // この面の右側の屈折率
        const n_next = getRefractiveIndexFromSurface(surface, wavelength);
        
        // デバッグログは必要に応じて有効化
        
        // 屈折（refraction）: α[j] = α[j-1] + φ[j-1] × h[j-1]
        // ここで、φ[j] = (n[j+1] - n[j]) / r[j]
        const radius = getSafeRadius(surface);
        let phi = 0;
        if (radius !== Infinity && radius !== 0) {
            phi = (n_next - n_prev) / radius;
            alpha = alpha + phi * h; // keep reduced angle α
        }
        
        // 屈折率更新
        n = n_next;
        
        traceData.push({
            surface: i,
            height: h,
            alpha: alpha,  // reduced angle α
            n: n
        });
    }
    
    return traceData;
}

/**
 * Perform chief ray trace with chromatic aberration at specific surface
 * Traces chief ray through system, using specified wavelength only at target surface
 * @param {Array} opticalSystemRows - Optical system data (normalized)
 * @param {number} targetSurfaceIndex - Surface index where wavelength is applied
 * @param {number} wavelength - Wavelength in micrometers for target surface
 * @param {number} NFL - Normalized Focal Length
 * @returns {Array} Trace data for each surface
 */
function performChiefRayTraceWithColorAtSurface(opticalSystemRows, targetSurfaceIndex, wavelength, NFL = 1.0) {
    const traceData = [];
    
    // 基準波長（この関数では使わないが、パラメータとして必要）
    const referenceWavelength = 0.5875618;
    
    // 入射瞳位置を計算
    const pupilsData = calculatePupilsByNewSpec(opticalSystemRows, referenceWavelength);
    let t1_normalized = 0;
    let entrancePupilPos_normalized = 0;
    
    if (pupilsData && pupilsData.entrancePupil && isFinite(pupilsData.entrancePupil.position)) {
        entrancePupilPos_normalized = pupilsData.entrancePupil.position;
        const d0 = getSafeThickness(opticalSystemRows[0]);
        if (!isFinite(d0)) {
            t1_normalized = entrancePupilPos_normalized;
        } else {
            t1_normalized = entrancePupilPos_normalized - d0;
        }
    }
    
    // 第1面（通常はStop）の左側の屈折率
    const n1 = getRefractiveIndexFromSurface(opticalSystemRows[0], referenceWavelength);
    
    // 初期条件（αを直接持つ）
    let h = -entrancePupilPos_normalized / (n1 * NFL);
    let alpha = -1.0; // α = N·u, normalized chief ray
    let n = n1;
    
    traceData.push({
        surface: 0,
        height: h,
        alpha: u,
        n: n1
    });
    
    // 各面を追跡
    for (let i = 1; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        const prevSurface = opticalSystemRows[i - 1];
        
        // CoordTrans面・Gap面をスキップ（近軸光線追跡では座標変換のみで光学的影響なし）
        const isCurrentCoordTrans = isCoordTransSurface(surface) || surface._blockType === 'Gap' || surface.blockType === 'Gap';
        if (isCurrentCoordTrans) {
            // CoordTrans面/Gap面: 光学的変化なし、前の値をそのまま記録
            traceData.push({
                surface: i,
                height: h,
                alpha: alpha,
                n: n
            });
            continue;
        }
        
        const n_prev = n;
        
        // 転送: h[j] = h[j-1] - d[j-1] * α[j-1] / n[j-1]
        // CoordTrans面の後は、埋め込まれたGap情報を考慮
        const isPrevCoordTrans = isCoordTransSurface(prevSurface) || prevSurface._blockType === 'Gap' || prevSurface.blockType === 'Gap';
        if (!isPrevCoordTrans) {
            const thickness = getSafeThickness(prevSurface);
            if (isFinite(thickness) && thickness !== 0) {
                h = h - thickness * alpha / n_prev;
            }
        } else {
            // CoordTrans面の場合、埋め込まれたGap情報（__cooptGapThickness）を確認
            const gapThickness = prevSurface.__cooptGapThickness;
            if (gapThickness !== undefined && isFinite(gapThickness) && gapThickness !== 0) {
                h = h - gapThickness * alpha / n_prev;
            }
        }
        
        // この面での波長を決定（targetSurfaceIndexの時だけ指定波長、それ以外は基準波長）
        const currentWavelength = (i === targetSurfaceIndex) ? wavelength : referenceWavelength;
        
        // 屈折率を取得
        const n_next = getRefractiveIndexFromSurface(surface, currentWavelength);
        
        // 屈折
        const radius = getSafeRadius(surface);
        let phi = 0;
        if (radius !== Infinity && radius !== 0) {
            phi = (n_next - n_prev) / radius;
        }
        
        alpha = alpha + phi * h; // reduced angle update
        n = n_next;
        
        traceData.push({
            surface: i,
            height: h,
            alpha: alpha,
            n: n
        });
    }
    
    return traceData;
}


/**
 * Calculate optical invariant (Lagrange invariant)
 * H = n * (h * ubar - hbar * u)
 * For infinite conjugate: H = n * h * ubar (since u = 0)
 */
function calculateOpticalInvariant(traceData) {
    // 光学不変量: H̃ = α₁h₁ - ᾱ₁h₁ (式20c)
    // 絞り面（第1面）で計算
    const firstTrace = traceData[0] || {};
    const n = firstTrace.n || 1.0;
    const alpha = firstTrace.alpha || 0; // マージナル光線角度 α₁
    const h = firstTrace.height || 1.0; // マージナル光線高さ h₁
    const alpha_chief = firstTrace.alpha_chief || 0; // 主光線角度 ᾱ₁
    
    // H̃ = α₁ × h₁ - ᾱ₁ × h₁
    const H = alpha * h - alpha_chief * h;
    return Math.abs(H);
}

/**
 * Calculate Seidel coefficients for a single surface
 * Based on the standard Japanese optical design method (VBA reference)
 * 
 * 補助量:
 *   Q1 = h1 * n / r - u1  (周辺光線の補助量)
 *   Q2 = h2 * n / r - u2  (主光線の補助量)
 *   Δ1 = u1' / n'^2 - u1 / n^2  (周辺光線の換算角度変化)
 *   Δ2 = u2' / n'^2 - u2 / n^2  (主光線の換算角度変化)
 * 
 * Seidel係数:
 *   S1 = h1 * Q1^2 * Δ1  (球面収差)
 *   S2 = h1 * Q1 * Q2 * Δ1  (コマ収差)
 *   S3 = h1 * Q2^2 * Δ1  (非点収差)
 *   S4 = P = φ / (n * n')  (Petzval像面湾曲)
 *   S5 = h1 * Q2^2 * Δ2 - h2 * Q2 * P  (歪曲収差)
 */
function calculateSurfaceSeidelCoefficients(
    surface,
    prevSurface,
    trace,
    prevTrace,
    wavelength,
    H  // Lagrange invariant (not used in this standard method)
) {
    // 屈折率
    const n = prevTrace.n || 1.0;      // この面の左側の屈折率
    const n_prime = trace.n || 1.0;    // この面の右側の屈折率
    
    // 曲率
    const radius = parseFloat(surface.radius);
    let r = 0;
    if (radius !== 0 && isFinite(radius) && radius !== 'INF' && radius !== Infinity) {
        r = radius;
    }
    
    // 近軸光線データ (屈折前)
    const h1 = prevTrace.height || 0;           // 周辺光線高さ (屈折前)
    const u1 = prevTrace.alpha || 0;            // 周辺光線角度 (屈折前)
    const h2 = prevTrace.height_chief || 0;     // 主光線高さ (屈折前)
    const u2 = prevTrace.alpha_chief || 0;      // 主光線角度 (屈折前)
    
    // 近軸光線データ (屈折後)
    const u1_prime = trace.alpha || 0;          // 周辺光線角度 (屈折後)
    const u2_prime = trace.alpha_chief || 0;    // 主光線角度 (屈折後)
    
    // 面パワー
    const c = (r !== 0) ? 1.0 / r : 0;
    const phi = (n_prime - n) * c;
    
    // 補助量の計算
    let Q1, Q2;
    if (r !== 0) {
        Q1 = h1 * n / r - u1;
        Q2 = h2 * n / r - u2;
    } else {
        Q1 = 0;
        Q2 = 0;
    }
    
    // 換算角度変化
    const Delta1 = u1_prime / (n_prime * n_prime) - u1 / (n * n);
    const Delta2 = u2_prime / (n_prime * n_prime) - u2 / (n * n);
    
    // Petzval項
    const P = (n !== 0 && n_prime !== 0) ? phi / (n * n_prime) : 0;
    
    // Seidel係数の計算
    const S1 = h1 * Q1 * Q1 * Delta1;           // 球面収差
    const S2 = h1 * Q1 * Q2 * Delta1;           // コマ収差
    const S3 = h1 * Q2 * Q2 * Delta1;           // 非点収差
    const S4 = P;                                // Petzval像面湾曲
    const S5 = h1 * Q2 * Q2 * Delta2 - h2 * Q2 * P;  // 歪曲収差
    
    // 色収差 (要実装: 複数波長での計算が必要)
    const CL = 0;
    const CT = 0;
    
    return { S1, S2, S3, S4, S5, CL, CT };
}


/**
 * Calculate Petzval radius using ray-paraxial.js functions
 * Petzval sum = Σ(φ/n') where φ = (n' - n) * c, n' = refractive power after surface
 */
function calculatePetzvalRadius(opticalSystemRows, wavelength) {
    let petzvalSum = 0;
    
    console.log('🔍 Calculating Petzval sum:');
    
    for (let i = 1; i < opticalSystemRows.length - 1; i++) {
        const surface = opticalSystemRows[i];
        const prevSurface = opticalSystemRows[i - 1];
        
        // 前の面（左側）の屈折率
        const n_before = i === 1 ? 1.0 : getRefractiveIndexFromSurface(prevSurface, wavelength);
        
        // この面（右側）の屈折率
        const n_after = getRefractiveIndexFromSurface(surface, wavelength);
        
        // 曲率
        const radius = getSafeRadius(surface);
        const c = (radius === 0 || !isFinite(radius) || radius === Infinity) ? 0 : 1.0 / radius;
        
        // 屈折力: φ = (n' - n) * c
        const phi = (n_after - n_before) * c;
        
        // Petzval項: φ / n'
        const petzvalContribution = n_after !== 0 ? phi / n_after : 0;
        petzvalSum += petzvalContribution;
        
        const surfType = surface['object type'] || surface.object || '';
        console.log(`  Surface ${i} ${surfType === 'Stop' ? '(STOP)' : ''}: n=${n_before.toFixed(4)}→${n_after.toFixed(4)}, c=${c.toFixed(6)}, φ=${phi.toFixed(6)}, φ/n'=${petzvalContribution.toFixed(6)}`);
    }
    
    console.log(`📊 Total Petzval sum: ${petzvalSum.toFixed(6)}`);
    
    // Petzval radius = -1 / Petzval sum
    const petzvalRadius = petzvalSum !== 0 ? -1.0 / petzvalSum : Infinity;
    console.log(`📊 Petzval radius: ${petzvalRadius.toFixed(4)}`);
    
    return petzvalRadius;
}

/**
 * Format Seidel coefficients as text output (similar to Zemax/CODE V format)
 */
export function formatSeidelCoefficients(seidelData) {
    if (!seidelData) return 'No Seidel data available';
    
    let output = '';
    
    // === 収差係数の表示（LCA, TCA, SA, COMA, AS, P, V統合） ===
    if (seidelData.surfaceCoefficients && seidelData.surfaceCoefficients.length > 0) {
        output += '=== Third-Order Aberration Coefficients ===\n';
        if (seidelData.chromaticAberrations) {
            output += `Chromatic Aberration Wavelength Range: ${seidelData.chromaticAberrations.wavelengthShort.toFixed(7)} μm - ${seidelData.chromaticAberrations.wavelengthLong.toFixed(7)} μm\n`;
        }
        output += '\n';
        
        output += `${'Surface'.padStart(7)}\t${'Object'.padEnd(6)}\t${'LCA'.padStart(15)}\t${'TCA'.padStart(15)}\t${'Ⅰ(SA)'.padStart(14)}\t${'Ⅱ(COMA)'.padStart(14)}\t${'Ⅲ(AS)'.padStart(14)}\t${'P'.padStart(14)}\t${'Ⅳ(Field)'.padStart(14)}\t${'Ⅴ(DIST)'.padStart(14)}\n`;
        
        for (let i = 0; i < seidelData.surfaceCoefficients.length; i++) {
            const coeff = seidelData.surfaceCoefficients[i];
            const surfaceIndex = coeff.surfaceIndex;
            
            // 対応する面のデータを取得してCoordTrans/Gap面をスキップ
            const surface = seidelData.opticalSystemRows[surfaceIndex];
            if (surface) {
                const isCoordTrans = isCoordTransSurface(surface) || surface._blockType === 'Gap' || surface.blockType === 'Gap';
                if (isCoordTrans) {
                    continue; // CoordTrans/Gap面は表示しない
                }
            }
            
            // 面番号
            let surfNum = surfaceIndex.toString();
            let objectType = '';
            if (surfaceIndex === 0) {
                objectType = 'Object';
            } else if (coeff.surfaceType === 'Stop') {
                objectType = 'Stop';
            } else if (coeff.isMirror) {
                objectType = 'Mirror';  // Mirror面を識別
            } else if (surfaceIndex === seidelData.opticalSystemRows.length - 1) {
                objectType = 'Image';
            }
            
            output += `${surfNum.padStart(7)}\t${objectType.padEnd(6)}\t`;
            output += `${(coeff.LCA || 0).toFixed(8).padStart(15)}\t`;
            output += `${(coeff.TCA || 0).toFixed(8).padStart(15)}\t`;
            output += `${coeff.I.toFixed(8).padStart(15)}\t`;
            output += `${coeff.II.toFixed(8).padStart(15)}\t`;
            output += `${coeff.III.toFixed(8).padStart(15)}\t`;
            output += `${coeff.P.toFixed(8).padStart(15)}\t`;
            output += `${coeff.IV.toFixed(8).padStart(15)}\t`;
            output += `${coeff.V.toFixed(8).padStart(15)}\n`;
        }
        
        // 合計値を表示
        output += `${'TOTAL'.padStart(7)}\t${''.padEnd(6)}\t`;
        output += `${(seidelData.totals.LCA || 0).toFixed(8).padStart(15)}\t`;
        output += `${(seidelData.totals.TCA || 0).toFixed(8).padStart(15)}\t`;
        output += `${seidelData.totals.I.toFixed(8).padStart(15)}\t`;
        output += `${seidelData.totals.II.toFixed(8).padStart(15)}\t`;
        output += `${seidelData.totals.III.toFixed(8).padStart(15)}\t`;
        output += `${seidelData.totals.P.toFixed(8).padStart(15)}\t`;
        output += `${seidelData.totals.IV.toFixed(8).padStart(15)}\t`;
        output += `${seidelData.totals.V.toFixed(8).padStart(15)}\n`;
        
        output += '\n';
    }
    
    // === アフォーカル系の近軸追跡データ ===
    if (seidelData.isAfocal && seidelData.marginalTraceData && seidelData.chiefTraceData && seidelData.unitScale) {
        const unitScale = seidelData.unitScale;
        const opticalSystemRows = seidelData.opticalSystemRows;
        
        // 子午光線（Marginal Ray）- 正規化単位で表示
        output += `=== Paraxial Marginal Ray Trace Data (Normalized by Reference Focal Length) ===\n\n`;
        output += `Reference Focal Length: ${unitScale.toFixed(1)} mm = 1.0 unit\n\n`;
        output += `${'Surface'.padStart(7)}\t${'Object'.padEnd(6)}\t${'Radius'.padStart(15)}\t${'Thickness'.padStart(15)}\t${'Index'.padStart(12)}\t${'Abbe'.padStart(12)}\t${'Power'.padStart(15)}\t${'Angle'.padStart(15)}\t${'Height'.padStart(15)}\n`;
        
        for (let j = 0; j < seidelData.marginalTraceData.length; j++) {
            const trace = seidelData.marginalTraceData[j];
            const surface = opticalSystemRows[j];
            
            // CoordTrans面とGap面をスキップ（表示から除外）
            if (isCoordTransSurface(surface)) {
                continue;
            }
            if (surface._blockType === 'Gap' || surface.blockType === 'Gap') {
                continue;
            }
            
            let surfNum = j.toString();
            let objectType = '';
            if (j === 0) {
                objectType = 'Object';
            } else if (surface['object type'] === 'Stop' || surface.object === 'Stop') {
                objectType = 'Stop';
            } else if (j === seidelData.marginalTraceData.length - 1) {
                objectType = 'Image';
            }
            
            // Mirror面を識別
            const isMirror = (surface.material === 'MIRROR' || surface.material === 'Mirror' || 
                             surface.rindex === '-1' || surface['ref index'] === '-1');
            if (isMirror) {
                objectType = 'Mirror';
            }
            
            output += `${surfNum.padStart(7)}\t${objectType.padEnd(6)}\t`;
            
            // 半径（正規化）
            const radius = parseFloat(surface.radius);
            if (!isFinite(radius) || radius === 0 || surface.radius === 'INF') {
                output += `${'INF'.padStart(15)}\t`;
            } else {
                output += `${(radius / unitScale).toFixed(6).padStart(15)}\t`;
            }
            
            // Image面の場合は、Radius表示後に改行して終了
            if (j === seidelData.marginalTraceData.length - 1) {
                output += '\n';
                continue;
            }
            
            // 面間距離（正規化）
            const thickness = parseFloat(surface.thickness);
            if (!isFinite(thickness)) {
                output += `${'INF'.padStart(15)}\t`;
            } else {
                output += `${(thickness / unitScale).toFixed(6).padStart(15)}\t`;
            }
            
            // 屈折率
            output += `${trace.n.toFixed(6).padStart(12)}\t`;
            
            // アッベ数
            const abbe = surface.abbe || 0;
            output += `${abbe.toString().padStart(12)}\t`;
            
            // パワー（正規化）
            let power = 0;
            if (j > 0) {
                const radius = parseFloat(surface.radius);
                if (radius !== 0 && isFinite(radius) && surface.radius !== 'INF') {
                    const n_before = seidelData.marginalTraceData[j-1].n;
                    const n_after = trace.n;
                    const c = unitScale / radius; // 正規化された曲率
                    power = (n_after - n_before) * c;
                }
            }
            output += `${power.toFixed(8).padStart(15)}\t`;
            
            // 換算傾角 α
            const alpha = trace.alpha;
            output += `${alpha.toFixed(8).padStart(15)}\t`;
            
            // 光線高さ（正規化単位）
            const h_normalized = trace.height / unitScale;
            output += `${h_normalized.toFixed(8).padStart(15)}\n`;
        }
        
        output += '\n';
        
        // 主光線（Chief Ray）- 正規化単位で表示
        output += `=== Paraxial Chief Ray Trace Data (Normalized by Reference Focal Length) ===\n`;
        output += `Note: Initial chief-ray angle/height are optimized to preserve symmetry (|α₁|≈|α_img-1|, h₁≈β·h_img-1).\n\n`;
        output += `Reference Focal Length: ${unitScale.toFixed(1)} mm = 1.0 unit\n\n`;
        output += `${'Surface'.padStart(7)}\t${'Object'.padEnd(6)}\t${'Radius'.padStart(15)}\t${'Thickness'.padStart(15)}\t${'Index'.padStart(12)}\t${'Abbe'.padStart(12)}\t${'Power'.padStart(15)}\t${'Angle'.padStart(15)}\t${'Height'.padStart(15)}\n`;
        
        for (let j = 0; j < seidelData.chiefTraceData.length; j++) {
            const trace = seidelData.chiefTraceData[j];
            const surface = opticalSystemRows[j];
            
            // CoordTrans面とGap面をスキップ（表示から除外）
            if (isCoordTransSurface(surface)) {
                continue;
            }
            if (surface._blockType === 'Gap' || surface.blockType === 'Gap') {
                continue;
            }
            
            let surfNum = j.toString();
            let objectType = '';
            if (j === 0) {
                objectType = 'Object';
            } else if (surface['object type'] === 'Stop' || surface.object === 'Stop') {
                objectType = 'Stop';
            } else if (j === seidelData.chiefTraceData.length - 1) {
                objectType = 'Image';
            }
            
            // Mirror面を識別
            const isMirror = (surface.material === 'MIRROR' || surface.material === 'Mirror' || 
                             surface.rindex === '-1' || surface['ref index'] === '-1');
            if (isMirror) {
                objectType = 'Mirror';
            }
            
            output += `${surfNum.padStart(7)}\t${objectType.padEnd(6)}\t`;
            
            // 半径（正規化）
            const radius = parseFloat(surface.radius);
            if (!isFinite(radius) || radius === 0 || surface.radius === 'INF') {
                output += `${'INF'.padStart(15)}\t`;
            } else {
                output += `${(radius / unitScale).toFixed(6).padStart(15)}\t`;
            }
            
            // Image面の場合は、Radius表示後に改行して終了
            if (j === seidelData.chiefTraceData.length - 1) {
                output += '\n';
                continue;
            }
            
            // 面間距離（正規化）
            const thickness = parseFloat(surface.thickness);
            if (!isFinite(thickness)) {
                output += `${'INF'.padStart(15)}\t`;
            } else {
                output += `${(thickness / unitScale).toFixed(6).padStart(15)}\t`;
            }
            
            // 屈折率
            output += `${trace.n.toFixed(6).padStart(12)}\t`;
            
            // アッベ数
            const abbe = surface.abbe || 0;
            output += `${abbe.toString().padStart(12)}\t`;
            
            // パワー（正規化）
            let power = 0;
            if (j > 0) {
                const radius = parseFloat(surface.radius);
                if (radius !== 0 && isFinite(radius) && surface.radius !== 'INF') {
                    const n_before = seidelData.chiefTraceData[j-1].n;
                    const n_after = trace.n;
                    const c = unitScale / radius; // 正規化された曲率
                    power = (n_after - n_before) * c;
                }
            }
            output += `${power.toFixed(8).padStart(15)}\t`;
            
            // 換算傾角 α_
            const alpha = trace.alpha;
            output += `${alpha.toFixed(8).padStart(15)}\t`;
            
            // 光線高さ（正規化単位）
            const h_normalized = trace.height / unitScale;
            output += `${h_normalized.toFixed(8).padStart(15)}\n`;
        }
        
        output += '\n';
        
        // === 補助項の表示（アフォーカル系） ===
        if (seidelData.surfaceCoefficients && seidelData.surfaceCoefficients.length > 0) {
            output += '=== Auxiliary Terms ===\n\n';
            output += `${'Surface'.padStart(7)}\t${'Object'.padEnd(6)}\t${'hQ'.padStart(15)}\t${'hQ_'.padStart(15)}\t${'J'.padStart(15)}\t${'hΔ(1/ns)'.padStart(15)}\t${'hΔ(1/ns)_'.padStart(15)}\t${'P'.padStart(15)}\n`;
            
            // デバッグ：surfaceCoefficients配列の内容を確認
            console.log(`📊 surfaceCoefficients配列の要素数: ${seidelData.surfaceCoefficients.length}`);
            for (const sc of seidelData.surfaceCoefficients) {
                if (sc.isMirror) {
                    console.log(`  → 面${sc.surfaceIndex}: isMirror=${sc.isMirror}`);
                }
            }
            
            for (let i = 0; i < seidelData.surfaceCoefficients.length; i++) {
                const coeff = seidelData.surfaceCoefficients[i];
                const surfaceIndex = coeff.surfaceIndex;
                
                // 対応する面のデータを取得してCoordTrans/Gap面をスキップ
                const surface = seidelData.opticalSystemRows[surfaceIndex];
                if (surface) {
                    const isCoordTrans = isCoordTransSurface(surface) || surface._blockType === 'Gap' || surface.blockType === 'Gap';
                    if (isCoordTrans) {
                        continue; // CoordTrans/Gap面は表示しない
                    }
                }
                
                let surfNum = surfaceIndex.toString();
                let objectType = '';
                if (surfaceIndex === 0) {
                    objectType = 'Object';
                } else if (coeff.surfaceType === 'Stop') {
                    objectType = 'Stop';
                } else if (coeff.isMirror) {
                    objectType = 'Mirror';
                    console.log(`🪞 Mirror面検出（補助項表示）: 面${surfaceIndex}, isMirror=${coeff.isMirror}`);
                } else if (surfaceIndex === seidelData.opticalSystemRows.length - 1) {
                    objectType = 'Image';
                }
                
                // デバッグ：Mirror面候補の確認
                if (surface && (surface.material === 'MIRROR' || surface.rindex === '-1' || surface.rindex === -1)) {
                    console.log(`🔍 Mirror候補: 面${surfaceIndex}, material='${surface.material}', rindex='${surface.rindex}', isMirror=${coeff.isMirror}, objectType='${objectType}'`);
                }
                
                output += `${surfNum.padStart(7)}\t${objectType.padEnd(6)}\t`;
                output += `${(coeff.hQ || 0).toFixed(8).padStart(15)}\t`;
                output += `${(coeff.hQ_chief || 0).toFixed(8).padStart(15)}\t`;
                output += `${(coeff.J || 0).toFixed(8).padStart(15)}\t`;
                output += `${(coeff.hDelta_1_ns || 0).toFixed(8).padStart(15)}\t`;
                output += `${(coeff.hDelta_1_ns_chief || 0).toFixed(8).padStart(15)}\t`;
                output += `${(coeff.P || 0).toFixed(8).padStart(15)}\n`;
            }
            
            output += '\n';
        }
        
        return output; // アフォーカル系の場合はここで終了
    }
    
    // === 近軸計算値テーブル ===
    if (seidelData.traceData && seidelData.opticalSystemRows) {
        output += '=== Paraxial Marginal Ray Trace Data ===\n\n';
        output += `${'Surface'.padStart(7)}\t${'Object'.padEnd(6)}\t${'Radius'.padStart(15)}\t${'Thickness'.padStart(15)}\t${'Index'.padStart(12)}\t${'Abbe'.padStart(12)}\t${'Power'.padStart(15)}\t${'Angle'.padStart(15)}\t${'Height'.padStart(15)}\n`;
        
        const opticalSystemRows = seidelData.opticalSystemRows;
        const traceData = seidelData.traceData;
        
        // Object面から開始（j=0）
        for (let j = 0; j < traceData.length; j++) {
            const trace = traceData[j];
            const surface = opticalSystemRows[j];
            
            // CoordTrans面とGap面をスキップ（表示から除外）
            if (isCoordTransSurface(surface)) {
                continue;
            }
            if (surface._blockType === 'Gap' || surface.blockType === 'Gap') {
                continue;
            }
            
            // 面番号（配列インデックスを使用）
            let surfNum = j.toString();
            let objectType = '';
            if (j === 0) {
                objectType = 'Object';
            } else if (surface['object type'] === 'Stop' || surface.object === 'Stop') {
                objectType = 'Stop';
            } else if (j === traceData.length - 1) {
                objectType = 'Image';
            }
            
            // Mirror面を識別
            const isMirror = (surface.material === 'MIRROR' || surface.material === 'Mirror' || 
                             surface.rindex === '-1' || surface['ref index'] === '-1');
            if (isMirror) {
                objectType = 'Mirror';
            }
            
            output += `${surfNum.padStart(7)}\t${objectType.padEnd(6)}\t`;
            
            // 半径 r[j-1] (この面の曲率半径)
            const radius = parseFloat(surface.radius);
            if (!isFinite(radius) || radius === 0) {
                output += `${'INF'.padStart(15)}\t`;
            } else {
                output += `${radius.toFixed(6).padStart(15)}\t`;
            }
            
            // Image面の場合は、Radius表示後に改行して終了
            if (j === traceData.length - 1) {
                output += '\n';
                continue;
            }
            
            // 面間距離 d[j-1] (この面のthickness)
            const thickness = parseFloat(surface.thickness);
            if (!isFinite(thickness)) {
                output += `${'INF'.padStart(15)}\t`;
            } else if (thickness === 0) {
                output += `${'0.000000'.padStart(15)}\t`;
            } else if (Math.abs(thickness) < 1e-50) {
                // 非常に小さい値（1e-100など）は指数表記で表示
                output += `${thickness.toExponential(6).padStart(15)}\t`;
            } else {
                output += `${thickness.toFixed(6).padStart(15)}\t`;
            }
            
            // 屈折率 n[j] (この面の右側の屈折率)
            output += `${trace.n.toFixed(6).padStart(12)}\t`;
            
            // アッベ数 v[j] (この面の右側の材料のアッベ数)
            const abbe = surface.abbe || 0;
            output += `${abbe.toString().padStart(12)}\t`;
            
            // パワー φ[j-1] (この面のパワー)
            let power = 0;
            if (j > 0) {
                const radius = parseFloat(surface.radius);
                if (radius !== 0 && isFinite(radius)) {
                    const n_before = traceData[j-1].n;
                    const n_after = trace.n;
                    const c = 1.0 / radius;
                    power = (n_after - n_before) * c;
                }
            }
            output += `${power.toFixed(8).padStart(15)}\t`;
            
            // 換算傾角 α[j] (周辺光線の角度)
            output += `${trace.alpha.toFixed(8).padStart(15)}\t`;
            
            // 光線高さ h[j] (周辺光線の高さ)
            output += `${trace.height.toFixed(8).padStart(15)}\n`;
        }
        
        output += '\n';
    }
    
    // === 焦点距離で正規化した近軸計算値テーブル ===
    if (seidelData.traceData && seidelData.opticalSystemRows && seidelData.focalLength) {
        const focalLength = seidelData.focalLength;
        const referenceFocalLength = seidelData.referenceFocalLength || focalLength;
        const NFL = seidelData.NFL || 1.0;
        const wavelength = seidelData.wavelength;
        const entrancePupilRadius = seidelData.entrancePupilRadius || 1.0;
        const maxFieldAngle = seidelData.maxFieldAngle || 0.1;
        const opticalSystemRows = seidelData.opticalSystemRows;
        
        output += '=== Paraxial Marginal Ray Trace Data (Normalized by Reference Focal Length) ===\n\n';
        output += `Focal Length (FL): ${focalLength.toFixed(6)} mm\n`;
        output += `Reference Focal Length: ${referenceFocalLength.toFixed(6)} mm\n`;
        output += `NFL (Normalized Focal Length): ${NFL.toFixed(6)} (= FL / Reference FL)\n\n`;
        output += `Initial Conditions:\n`;
        output += `  Marginal ray: h[1] = ${NFL.toFixed(6)} (NFL), α[1] = 0.0\n`;
        output += `  Chief ray: h[1]_ = -EnP/n1/NFL, α[1]_ = ${(-1.0/NFL).toFixed(6)} (-1/NFL)\n\n`;
        
        // 正規化した光学系を作成
        const normalizedOpticalSystem = opticalSystemRows.map(surface => {
            const normalizedSurface = { ...surface };
            
            // Radiusを正規化
            const radius = parseFloat(surface.radius);
            if (isFinite(radius) && radius !== 0) {
                normalizedSurface.radius = radius / referenceFocalLength;
            }
            
            // Thicknessを正規化
            const thickness = parseFloat(surface.thickness);
            if (isFinite(thickness) && thickness !== 0) {
                normalizedSurface.thickness = thickness / referenceFocalLength;
            }
            
            return normalizedSurface;
        });
        
        // 正規化した光学系での焦点距離を計算
        const normalizedFocalLength = calculateFocalLength(normalizedOpticalSystem, wavelength);
        const normalizedBackFocalLength = calculateBackFocalLength(normalizedOpticalSystem, wavelength);
        output += `Normalized Focal Length: ${normalizedFocalLength?.toFixed(6) || 'N/A'} (should be ${NFL.toFixed(6)})\n`;
        output += `Normalized Back Focal Length: ${normalizedBackFocalLength?.toFixed(6) || 'N/A'}\n\n`;
        
        // 正規化した光学系で近軸光線追跡を実行（NFLパラメータを渡す）
        const normalizedTraceData = performParaxialTrace(normalizedOpticalSystem, wavelength, entrancePupilRadius, maxFieldAngle, NFL);
        
        output += `${'Surface'.padStart(7)}\t${'Object'.padEnd(6)}\t${'Radius'.padStart(15)}\t${'Thickness'.padStart(15)}\t${'Index'.padStart(12)}\t${'Abbe'.padStart(12)}\t${'Power'.padStart(15)}\t${'Angle'.padStart(15)}\t${'Height'.padStart(15)}\n`;
        
        // Object面から開始（j=0）
        for (let j = 0; j < normalizedTraceData.length; j++) {
            const trace = normalizedTraceData[j];
            const surface = normalizedOpticalSystem[j];
            const originalSurface = opticalSystemRows[j];
            
            // CoordTrans面とGap面をスキップ（表示から除外）
            if (isCoordTransSurface(originalSurface)) {
                continue;
            }
            if (originalSurface._blockType === 'Gap' || originalSurface.blockType === 'Gap') {
                continue;
            }
            
            // 面番号（配列インデックスを使用）
            let surfNum = j.toString();
            let objectType = '';
            if (j === 0) {
                objectType = 'Object';
            } else if (originalSurface['object type'] === 'Stop' || originalSurface.object === 'Stop') {
                objectType = 'Stop';
            } else if (j === normalizedTraceData.length - 1) {
                objectType = 'Image';
            }
            
            // Mirror面を識別
            const isMirror = (originalSurface.material === 'MIRROR' || originalSurface.material === 'Mirror' || 
                             originalSurface.rindex === '-1' || originalSurface['ref index'] === '-1');
            if (isMirror) {
                objectType = 'Mirror';
            }
            
            output += `${surfNum.padStart(7)}\t${objectType.padEnd(6)}\t`;
            
            // 半径 r[j-1] (この面の曲率半径) - 正規化済み
            const radius = parseFloat(surface.radius);
            if (!isFinite(radius) || radius === 0) {
                output += `${'INF'.padStart(15)}\t`;
            } else {
                output += `${radius.toFixed(6).padStart(15)}\t`;
            }
            
            // Image面の場合は、Radius表示後に改行して終了
            if (j === normalizedTraceData.length - 1) {
                output += '\n';
                continue;
            }
            
            // 面間距離 d[j-1] (この面のthickness) - 正規化済み
            const thickness = parseFloat(surface.thickness);
            if (!isFinite(thickness)) {
                output += `${'INF'.padStart(15)}\t`;
            } else if (thickness === 0) {
                output += `${'0.000000'.padStart(15)}\t`;
            } else if (Math.abs(thickness) < 1e-50) {
                // 非常に小さい値（1e-100など）は0と表示
                output += `${'0.000000'.padStart(15)}\t`;
            } else {
                output += `${thickness.toFixed(6).padStart(15)}\t`;
            }
            
            // 屈折率 n[j] (この面の右側の屈折率)
            output += `${trace.n.toFixed(6).padStart(12)}\t`;
            
            // アッベ数 v[j] (この面の右側の材料のアッベ数)
            const abbe = originalSurface.abbe || 0;
            output += `${abbe.toString().padStart(12)}\t`;
            
            // パワー φ[j-1] (この面のパワー) - 正規化した系での計算値
            let power = 0;
            if (j > 0) {
                const radius = parseFloat(surface.radius);
                if (radius !== 0 && isFinite(radius)) {
                    const n_before = normalizedTraceData[j-1].n;
                    const n_after = trace.n;
                    const c = 1.0 / radius;
                    power = (n_after - n_before) * c;
                }
            }
            output += `${power.toFixed(8).padStart(15)}\t`;
            
            // 換算傾角 α[j] (周辺光線の角度) - 正規化した系での計算値
            output += `${trace.alpha.toFixed(8).padStart(15)}\t`;
            
            // 光線高さ h[j] (周辺光線の高さ) - 正規化した系での計算値
            output += `${trace.height.toFixed(8).padStart(15)}\n`;
        }
        
        output += '\n';
    }
    
    // === 主光線の焦点距離で正規化した近軸計算値テーブル ===
    if (seidelData.traceData && seidelData.opticalSystemRows && seidelData.focalLength) {
        const focalLength = seidelData.focalLength;
        const referenceFocalLength = seidelData.referenceFocalLength || focalLength;
        const NFL = seidelData.NFL || 1.0;
        const wavelength = seidelData.wavelength;
        const opticalSystemRows = seidelData.opticalSystemRows;
        const maxFieldAngle = seidelData.maxFieldAngle || 0;
        
        output += '=== Paraxial Chief Ray Trace Data (Normalized by Reference Focal Length) ===\n\n';
        output += `Focal Length (FL): ${focalLength.toFixed(6)} mm\n`;
        output += `Reference Focal Length: ${referenceFocalLength.toFixed(6)} mm\n`;
        output += `NFL (Normalized Focal Length): ${NFL.toFixed(6)}\n\n`;
        
        // 正規化した光学系を作成
        const normalizedOpticalSystem = opticalSystemRows.map(surface => {
            const normalizedSurface = { ...surface };
            
            // Radiusを正規化
            const radius = parseFloat(surface.radius);
            if (isFinite(radius) && radius !== 0) {
                normalizedSurface.radius = radius / referenceFocalLength;
            }
            
            // Thicknessを正規化
            const thickness = parseFloat(surface.thickness);
            if (isFinite(thickness) && thickness !== 0) {
                normalizedSurface.thickness = thickness / referenceFocalLength;
            }
            
            return normalizedSurface;
        });
        
        // 主光線の近軸光線追跡を実行: α[1] = -1/NFL, h[1] = -t1/n1
        // 物体高さを正規化（seidelDataにmaxObjectHeightがあれば使用）
        const maxObjectHeight = seidelData.maxObjectHeight || 0;
        const normalizedObjectHeight = maxObjectHeight / referenceFocalLength;
        const chiefTraceData = performChiefRayTrace(normalizedOpticalSystem, wavelength, NFL, maxFieldAngle, normalizedObjectHeight);
        
        // 正規化された入射瞳位置を出力
        if (chiefTraceData.length > 0 && chiefTraceData[0].entrancePupilPosition !== undefined) {
            output += `Normalized Entrance Pupil Position: ${chiefTraceData[0].entrancePupilPosition.toFixed(6)}\n`;
        }
        output += '\n';
        
        output += `${'Surface'.padStart(7)}\t${'Object'.padEnd(6)}\t${'Radius'.padStart(15)}\t${'Thickness'.padStart(15)}\t${'Index'.padStart(12)}\t${'Abbe'.padStart(12)}\t${'Power'.padStart(15)}\t${'Angle'.padStart(15)}\t${'Height'.padStart(15)}\n`;
        
        // Object面から開始（j=0）
        for (let j = 0; j < chiefTraceData.length; j++) {
            const trace = chiefTraceData[j];
            const surface = normalizedOpticalSystem[j];
            const originalSurface = opticalSystemRows[j];
            
            // CoordTrans面とGap面をスキップ（表示から除外）
            if (isCoordTransSurface(originalSurface)) {
                continue;
            }
            if (originalSurface._blockType === 'Gap' || originalSurface.blockType === 'Gap') {
                continue;
            }
            
            // 面番号（配列インデックスを使用）
            let surfNum = j.toString();
            let objectType = '';
            if (j === 0) {
                objectType = 'Object';
            } else if (originalSurface['object type'] === 'Stop' || originalSurface.object === 'Stop') {
                objectType = 'Stop';
            } else if (j === chiefTraceData.length - 1) {
                objectType = 'Image';
            }
            
            // Mirror面を識別
            const isMirror = (originalSurface.material === 'MIRROR' || originalSurface.material === 'Mirror' || 
                             originalSurface.rindex === '-1' || originalSurface['ref index'] === '-1');
            if (isMirror) {
                objectType = 'Mirror';
            }
            
            output += `${surfNum.padStart(7)}\t${objectType.padEnd(6)}\t`;
            
            // 半径 r[j-1] (この面の曲率半径) - 正規化済み
            const radius = parseFloat(surface.radius);
            if (!isFinite(radius) || radius === 0) {
                output += `${'INF'.padStart(15)}\t`;
            } else {
                output += `${radius.toFixed(6).padStart(15)}\t`;
            }
            
            // Image面の場合は、Radius表示後に改行して終了
            if (j === chiefTraceData.length - 1) {
                output += '\n';
                continue;
            }
            
            // 面間距離 d[j-1] (この面のthickness) - 正規化済み
            const thickness = parseFloat(surface.thickness);
            if (!isFinite(thickness)) {
                output += `${'INF'.padStart(15)}\t`;
            } else if (thickness === 0) {
                output += `${'0.000000'.padStart(15)}\t`;
            } else if (Math.abs(thickness) < 1e-50) {
                // 非常に小さい値（1e-100など）は0と表示
                output += `${'0.000000'.padStart(15)}\t`;
            } else {
                output += `${thickness.toFixed(6).padStart(15)}\t`;
            }
            
            // 屈折率 n[j] (この面の右側の屈折率)
            output += `${trace.n.toFixed(6).padStart(12)}\t`;
            
            // アッベ数 v[j] (この面の右側の材料のアッベ数)
            const abbe = originalSurface.abbe || 0;
            output += `${abbe.toString().padStart(12)}\t`;
            
            // パワー φ[j-1] (この面のパワー) - 正規化した系での計算値
            let power = 0;
            if (j > 0) {
                const radius = parseFloat(surface.radius);
                if (radius !== 0 && isFinite(radius)) {
                    const n_before = chiefTraceData[j-1].n;
                    const n_after = trace.n;
                    const c = 1.0 / radius;
                    power = (n_after - n_before) * c;
                }
            }
            output += `${power.toFixed(8).padStart(15)}\t`;
            
            // 換算傾角 α[j] (主光線の角度) - 正規化した系での計算値
            output += `${trace.alpha.toFixed(8).padStart(15)}\t`;
            
            // 光線高さ h[j] (主光線の高さ) - 正規化した系での計算値
            output += `${trace.height.toFixed(8).padStart(15)}\n`;
        }
        
        output += '\n';
    }
    
    // === 補助項の表示 ===
    if (seidelData.surfaceCoefficients && seidelData.surfaceCoefficients.length > 0) {
        output += '=== Auxiliary Terms ===\n\n';
        output += `${'Surface'.padStart(7)}\t${'Object'.padEnd(6)}\t${'hQ'.padStart(15)}\t${'hQ_'.padStart(15)}\t${'J'.padStart(15)}\t${'hΔ(1/ns)'.padStart(15)}\t${'hΔ(1/ns)_'.padStart(15)}\t${'P'.padStart(15)}\n`;
        
        for (let i = 0; i < seidelData.surfaceCoefficients.length; i++) {
            const coeff = seidelData.surfaceCoefficients[i];
            const surfaceIndex = coeff.surfaceIndex;
            const originalSurface = seidelData.opticalSystemRows[surfaceIndex];
            
            // 対応する面のデータを取得してCoordTrans/Gap面をスキップ
            if (originalSurface) {
                const isCoordTrans = isCoordTransSurface(originalSurface) || originalSurface._blockType === 'Gap' || originalSurface.blockType === 'Gap';
                if (isCoordTrans) {
                    continue; // CoordTrans/Gap面は表示しない
                }
            }
            
            // 面番号（配列インデックスを使用）
            let surfNum = surfaceIndex.toString();
            let objectType = '';
            if (surfaceIndex === 0) {
                objectType = 'Object';
            } else if (coeff.surfaceType === 'Stop') {
                objectType = 'Stop';
            } else if (coeff.isMirror) {
                objectType = 'Mirror';
            } else if (surfaceIndex === seidelData.opticalSystemRows.length - 1) {
                objectType = 'Image';
            }
            
            output += `${surfNum.padStart(7)}\t${objectType.padEnd(6)}\t`;
            output += `${coeff.hQ.toFixed(8).padStart(15)}\t`;
            output += `${coeff.hQ_chief.toFixed(8).padStart(15)}\t`;
            output += `${coeff.J.toFixed(8).padStart(15)}\t`;
            output += `${coeff.hDelta_1_ns.toFixed(8).padStart(15)}\t`;
            output += `${coeff.hDelta_1_ns_chief.toFixed(8).padStart(15)}\t`;
            output += `${coeff.P.toFixed(8).padStart(15)}\n`;
        }
    }
    
    return output;
}


