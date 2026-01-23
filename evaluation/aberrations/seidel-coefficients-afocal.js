/**
 * Afocal System Seidel Aberration Coefficients Calculator
 * アフォーカル系の収差係数計算（Table 1の方法）
 * 
 * Based on verified paraxial ray trace with fixed initial angle:
 * - Chief ray: α₀ = -1.0 rad (fixed)
 * - Reference FL normalization (Auto → 1.0 unit)
 * - Transfer equation backward calculation for initial heights
 */

import { 
    getRefractiveIndex as getRefractiveIndexFromSurface,
    getSafeRadius,
    getSafeThickness,
    calculateFullSystemParaxialTrace
} from '../../raytracing/core/ray-paraxial.js';
import { tableSource } from '../../data/table-source.js';

// ガラス情報の補完: Ref Index/Abbeが無い場合でも、Materialが数値ならndとして扱う
function getNdAbbeAfocal(surf) {
    if (!surf) return { nd: null, abbe: null };
    let nd = parseFloat(surf['Ref Index'] ?? surf.refIndex ?? surf.ref_index ?? surf.n ?? surf.nd);
    if (!isFinite(nd)) {
        const matNum = parseFloat(surf.Material ?? surf.material);
        if (isFinite(matNum)) nd = matNum;
    }
    const abbe = parseFloat(surf.Abbe ?? surf.abbe ?? surf.Vd ?? surf.vd ?? surf.abbeNumber ?? surf.abbe_number);
    return { nd: isFinite(nd) ? nd : null, abbe: isFinite(abbe) ? abbe : null };
}

// 色分散のフォールバック: δN ≈ (nd - 1) / Abbe
function getDispersionFallbackAfocal(surf) {
    const { nd, abbe } = getNdAbbeAfocal(surf);
    if (nd === null || abbe === null || abbe === 0) return null;
    return (nd - 1) / abbe;
}

// アフォーカル系向け色収差計算（LCA/TCA）。surfaceCoefficientsを直接更新する。
function computeAfocalChromaticAberrations(opticalSystemRows, stopIndex, referenceFocalLength, surfaceCoefficients, unitScale) {
    if (!surfaceCoefficients || surfaceCoefficients.length === 0) return { totalLCA: 0, totalTCA: 0, wavelengthShort: null, wavelengthLong: null };

    const { shortest: lambdaShort, longest: lambdaLong } = getWavelengthRangeAfocal();

    // 波長別で近軸追跡（正規化系）
    const traceShort = performAfocalParaxialTrace(opticalSystemRows, lambdaShort, stopIndex, referenceFocalLength);
    const traceLong = performAfocalParaxialTrace(opticalSystemRows, lambdaLong, stopIndex, referenceFocalLength);
    const traceBase = performAfocalParaxialTrace(opticalSystemRows, (lambdaShort + lambdaLong) * 0.5, stopIndex, referenceFocalLength);

    if (!traceShort || !traceLong || !traceBase) {
        console.warn('⚠️ [Afocal] Chromatic trace failed; skipping LCA/TCA');
        return { totalLCA: 0, totalTCA: 0, wavelengthShort: lambdaShort, wavelengthLong: lambdaLong };
    }

    let totalLCA = 0;
    let totalTCA = 0;

    for (let i = 1; i < opticalSystemRows.length; i++) {
        const scIndex = i - 1; // surfaceCoefficientsは1面目がindex0
        const sc = surfaceCoefficients[scIndex];
        if (!sc) continue;

        const surf = opticalSystemRows[i];
        const prevSurf = opticalSystemRows[i - 1];

        const h_marginal = traceBase.marginal[i]?.h || 0;
        const hQ_marginal = sc.hQ || 0;
        const J = sc.J || 0;

        // 短波長・長波長の屈折率（屈折後）
        let n_short = traceShort.marginal[i]?.n || 1;
        let n_long = traceLong.marginal[i]?.n || 1;

        // 屈折前（1つ前の面）
        let n_before_short = i > 0 ? (traceShort.marginal[i - 1]?.n || 1) : 1;
        let n_before_long = i > 0 ? (traceLong.marginal[i - 1]?.n || 1) : 1;

        // d線（基準波長近似）の屈折率
        let n_d = traceBase.marginal[i]?.n || 1.0;
        let n_d_prev = i > 0 ? (traceBase.marginal[i - 1]?.n || 1.0) : 1.0;

        // δN' と δN
        let delta_N_prime = n_short - n_long;
        let delta_N = n_before_short - n_before_long;

        // ガラス未設定/Material数値時のフォールバック
        const fallback_prime = getDispersionFallbackAfocal(surf);
        const fallback_prev = getDispersionFallbackAfocal(prevSurf);
        const { nd: nd_prime } = getNdAbbeAfocal(surf);
        const { nd: nd_prev_val } = getNdAbbeAfocal(prevSurf);

        if ((Math.abs(delta_N_prime) < 1e-12 || !isFinite(delta_N_prime)) && fallback_prime !== null) {
            delta_N_prime = fallback_prime;
            if (Math.abs(n_d - 1.0) < 1e-6 && nd_prime !== null) n_d = nd_prime;
        }
        if ((Math.abs(delta_N) < 1e-12 || !isFinite(delta_N)) && fallback_prev !== null) {
            delta_N = fallback_prev;
            if (Math.abs(n_d_prev - 1.0) < 1e-6 && nd_prev_val !== null) n_d_prev = nd_prev_val;
        }

        // Δ(δN/N) = δN'/N' - δN/N
        let delta_dN_over_N = 0;
        if (Math.abs(n_d) > 1e-12) delta_dN_over_N += delta_N_prime / n_d;
        if (Math.abs(n_d_prev) > 1e-12) delta_dN_over_N -= delta_N / n_d_prev;

        // LCA_j = h × hQ × Δ(δN/N)
        const LCA_j = h_marginal * hQ_marginal * delta_dN_over_N;
        // TCA_j = J × LCA_j
        const TCA_j = J * LCA_j;

        sc.LCA = LCA_j;
        sc.TCA = TCA_j;

        totalLCA += LCA_j;
        totalTCA += TCA_j;
    }

    return { totalLCA, totalTCA, wavelengthShort: lambdaShort, wavelengthLong: lambdaLong };
}

// ソーステーブルから波長範囲を取得（なければ F/C ライン既定値）
function getWavelengthRangeAfocal() {
    try {
        const sourceData = tableSource?.getData?.();
        if (!sourceData || sourceData.length === 0) {
            console.warn('⚠️ [Afocal] No source data, using default F/C lines');
            return { shortest: 0.4861327, longest: 0.6562725 };
        }
        let minW = Infinity;
        let maxW = -Infinity;
        for (const row of sourceData) {
            const w = parseFloat(row.wavelength);
            if (isFinite(w)) {
                if (w < minW) minW = w;
                if (w > maxW) maxW = w;
            }
        }
        if (!isFinite(minW) || !isFinite(maxW)) {
            console.warn('⚠️ [Afocal] Invalid source wavelengths, using defaults');
            return { shortest: 0.4861327, longest: 0.6562725 };
        }
        return { shortest: minW, longest: maxW };
    } catch (e) {
        console.warn('⚠️ [Afocal] Wavelength range fetch failed, using defaults', e);
        return { shortest: 0.4861327, longest: 0.6562725 };
    }
}

// 角倍率をパラキシアル追跡から直接評価（α_in = -1 の換算角を入射させて α_out を測定）
// normalizedRows は既に UNIT_SCALE で正規化済みなので radius/thickness はそのまま使う
function computeAngularMagnification(normalizedRows, wavelength, s1) {
    const alpha_in = -1.0; // 入射換算角のテスト値
    let alpha = alpha_in;
    let h = 0.0;
    let n = getRefractiveIndexFromSurface(normalizedRows[0], wavelength) || 1.0;
    for (let i = 1; i < normalizedRows.length; i++) {
        const n_prev = n;
        if (isFinite(thickness) && thickness !== 0) {
            h = h - thickness * alpha / n_prev;
        }
            const surf = normalizedRows[i];
            const prevSurf = normalizedRows[i - 1];
            const isStop = surf['object type'] === 'Stop' || surf.object === 'Stop';
            const thickness = (i === 1) ? s1 : parseFloat(prevSurf.thickness);
            const N_after = getRefractiveIndexFromSurface(surf, wavelength) || 1.0;
            const radius = surf.radius === 'INF' ? Infinity : parseFloat(surf.radius);
        if (isFinite(radius) && radius !== 0) {
            const phi = (N_after - n_prev) / radius;
            alpha = alpha + phi * h;
        }
        n = N_after;
    }
    const gamma = alpha / alpha_in; // 角倍率 γ = α_out / α_in
    console.log(`📐 Angular magnification (direct trace): gamma = ${gamma}`);
    return gamma;
}

// 2x2行列 M の最小特異ベクトル（Mx≈0 を最小二乗で満たす）を返す
function smallestSingularVector2x2(A, B, C, D) {
    // M^T M
    const a = A * A + C * C;
    const b = A * B + C * D;
    const c = B * B + D * D;
    // 固有値: (tr ± sqrt(tr^2 - 4 det)) / 2
    const tr = a + c;
    const det = a * c - b * b;
    const disc = Math.max(tr * tr - 4 * det, 0);
    const lambda_min = (tr - Math.sqrt(disc)) / 2;
    // (M^T M - λI) v = 0 を解く
    let vx, vy;
    if (Math.abs(b) > Math.abs(a - lambda_min)) {
        vx = 1;
        vy = - (a - lambda_min) / b;
    } else if (Math.abs(b) > Math.abs(c - lambda_min)) {
        vx = - (c - lambda_min) / b;
        vy = 1;
    } else {
        // 対角優勢の場合
        vx = 1;
        vy = (lambda_min - a) / b || 0;
    }
    const norm = Math.hypot(vx, vy) || 1;
    return [vx / norm, vy / norm];
}

// パラキシアルABCD行列を構築（surface1 から targetSurface まで）
// includeRefractionAtTarget=false なら target 面での屈折を適用せず直前の状態を返す
function buildABCDToSurface(normalizedRows, wavelength, s1, targetSurfaceIndex, includeRefractionAtTarget = true) {
    let A = 1, B = 0, C = 0, D = 1;
    let n_prev = getRefractiveIndexFromSurface(normalizedRows[0], wavelength) || 1.0;
    for (let i = 1; i <= targetSurfaceIndex; i++) {
        const prevSurf = normalizedRows[i - 1];
        const surf = normalizedRows[i];
        const isStop = surf['object type'] === 'Stop' || surf.object === 'Stop';
        const thickness = (i === 1) ? s1 : parseFloat(prevSurf.thickness);
        // translation: h' = h - d * alpha / n_prev
        const tA = 1;
        const tB = -thickness / n_prev;
        const tC = 0;
        const tD = 1;
        // multiply T * M
        const A1 = tA * A + tB * C;
        const B1 = tA * B + tB * D;
        const C1 = tC * A + tD * C;
        const D1 = tC * B + tD * D;
        A = A1; B = B1; C = C1; D = D1;

        const N_after = getRefractiveIndexFromSurface(surf, wavelength) || 1.0;
        const radius = surf.radius === 'INF' ? Infinity : parseFloat(surf.radius);
        if (includeRefractionAtTarget || i < targetSurfaceIndex) {
            if (isFinite(radius) && radius !== 0) {
                const phi = (N_after - n_prev) / radius;
                // refraction: alpha' = alpha + phi * h
                const rA = 1;
                const rB = 0;
                const rC = phi;
                const rD = 1;
                const A2 = rA * A + rB * C;
                const B2 = rA * B + rB * D;
                const C2 = rC * A + rD * C;
                const D2 = rC * B + rD * D;
                A = A2; B = B2; C = C2; D = D2;
            }
        }
        n_prev = N_after;
    }
    return { A, B, C, D };
}

// Optimize initial chief-ray angle/height to keep symmetry in Paraxial Chief Ray Trace Data
// by enforcing |alpha1|≈|alpha_img-1| and h1≈beta*h_img-1 via weighted least squares.
function solveChiefInitialForStopAfocal(normalizedRows, wavelength, s1, stopIndex, beta) {
    const gamma = 1.0 / beta; // 式(21)より h̄₁の目安
    const seedH = gamma;
    const seedAlpha = 0.0;
    const toStop = buildABCDToSurface(normalizedRows, wavelength, s1, stopIndex, false); // stop直前（角度拘束は今回使用しない）
    const toImageAngle = buildABCDToSurface(normalizedRows, wavelength, s1, normalizedRows.length - 2, true);  // 像直前面（img-1）の角度
    const toImageHeightPenult = buildABCDToSurface(normalizedRows, wavelength, s1, normalizedRows.length - 2, false); // 像直前面（img-1）の高さ
    
    // 条件行列 M (2x2):
    // 1) |alpha1| ≈ |alpha_img-1| かつ alpha1<0 → -alpha1 - sign0*alpha_img ≈ 0（sign0で線形化）
    // 2) h1 ≈ beta * h_img-1 → h1 - beta*h_img ≈ 0 → (1 - beta*A_img) h1 + (-beta*B_img) alpha1 ≈ 0
    const sign0 = Math.sign(toImageAngle.C * seedH + toImageAngle.D * seedAlpha || 1) || 1;
    const m11 = -sign0 * toImageAngle.C;      // -alpha1 - sign0*alpha_img の h1 係数（img-1 面）
    const m12 = -1 - sign0 * toImageAngle.D;  // -alpha1 - sign0*alpha_img の α1 係数（img-1 面）
    const m21 = 1 - beta * toImageHeightPenult.A;   // h1 - beta*h_img の h1 係数（img-1 面）
    const m22 = -beta * toImageHeightPenult.B;      // h1 - beta*h_img の α1 係数（img-1 面）

    // 重み
        const w_img_match = 20.0; // |alpha1|≈|alpha_img-1| を最優先に
        const w_h_match = 5.0;    // 高さはさらに抑制

    // 正規方程式 N = M^T W M（2x2 対称行列）
    const n11 = w_img_match * m11 * m11 + w_h_match * m21 * m21;
    const n12 = w_img_match * m11 * m12 + w_h_match * m21 * m22;
    const n22 = w_img_match * m12 * m12 + w_h_match * m22 * m22;

    // 最小特異ベクトル（N は対称 2x2）
    let [h1, alpha1] = smallestSingularVector2x2(n11, n12, n12, n22);

    // シードと同方向に揃える
    const dot = h1 * seedH + alpha1 * seedAlpha;
    if (dot < 0) {
        h1 = -h1;
        alpha1 = -alpha1;
    }

    // シードの高さスケールに合わせる（符号は上で調整済み）
    const scale = seedH !== 0 ? seedH / (h1 || 1) : 1;
    h1 *= scale;
    alpha1 *= scale;

    // ᾱ₁の初期ダンピングを緩めて角度スケールを確保
        const alpha_damp = 1.0;
    alpha1 *= alpha_damp;

    // 依頼: ᾱ₁は負側に揃える（高さの符号は維持）
    if (alpha1 > 0) {
        alpha1 = -alpha1;
    }

    // --- 高さのみ微調整 (角度方向の微小補正) ---
    const N1 = 1.0;
    const h0_fixed = seedH;
    const h1_from_alpha = h0_fixed - s1 * alpha1 / N1;

    // 像直前高さ一致: h1 ≈ beta * h_img (img-1)
    const h_img_penult = toImageHeightPenult.A * h0_fixed + toImageHeightPenult.B * alpha1;
    const err_img = h1_from_alpha - beta * h_img_penult;
    const dh_img_dalpha = toImageHeightPenult.B;
    const dh1_dalpha = -s1 / N1;
    const d_err_img_dalpha = dh1_dalpha - beta * dh_img_dalpha;
    let delta_alpha_img = 0;
    if (Math.abs(d_err_img_dalpha) > 1e-12) {
        delta_alpha_img = -err_img / d_err_img_dalpha;
    }

    // 微小補正をダンピングして適用（高さ一致のみ）
    const corr_gain = 0.08;
    alpha1 += corr_gain * delta_alpha_img;

    // 符号を再確認（負側を維持）
    if (alpha1 > 0) {
        alpha1 = -alpha1;
    }

    // 最終 h1 を更新
    h1 = h0_fixed - s1 * alpha1 / N1;

    // --- 追加: 単一変数の反復最小二乗で収束を詰める（角度一致と高さ対称を同時に） ---
    const w_alpha = w_img_match;  // |alpha1|≈|alpha_img-1| 重み
    const w_height = w_h_match;   // h1≈beta*h_img-1 重み
    const maxIter = 60;      // さらに反復回数を増やす
    const damping = 0.20;    // 一歩を少し大きく
    // 単調性を確保するための簡易バックトラック付きステップ調整
    let prevCost = Infinity;
    for (let k = 0; k < maxIter; k++) {
        const h1_iter = h0_fixed - s1 * alpha1 / N1;
        const alpha_img = toImageAngle.C * h0_fixed + toImageAngle.D * alpha1; // img-1 面の角度
        const h_img = toImageHeightPenult.A * h0_fixed + toImageHeightPenult.B * alpha1;   // img-1 の高さ

        const sign = Math.sign(alpha_img) || 1;   // 現在の符号で |alpha_img| を線形化
        const r_alpha = -alpha1 - sign * alpha_img;    // |alpha1|≈|alpha_img|
        const r_height = h1_iter - beta * h_img;       // h1≈beta*h_img

        const dr_alpha = -1 - sign * toImageAngle.D;   // d(-alpha1 - sign*alpha_img)/dalpha
        const dr_height = -beta * toImageHeightPenult.B + (-s1 / N1); // d(h1 - beta*h_img)/dalpha

        const num = w_alpha * r_alpha * dr_alpha + w_height * r_height * dr_height;
        const den = w_alpha * dr_alpha * dr_alpha + w_height * dr_height * dr_height;
        if (Math.abs(den) < 1e-14) break;

        const step = -damping * num / den;
        let delta = step;
        let trialAlpha = alpha1 + delta;
        if (trialAlpha > 0) trialAlpha = -trialAlpha; // 負側維持

        // コスト (重み付き二乗和)
        const cost = (w_alpha * r_alpha * r_alpha) + (w_height * r_height * r_height);
        let accepted = false;
        let backtrack = 0;
        while (!accepted && backtrack < 4) {
            const h1_bt = h0_fixed - s1 * trialAlpha / N1;
            const alpha_img_bt = toImageAngle.C * h0_fixed + toImageAngle.D * trialAlpha;
            const h_img_bt = toImageHeightPenult.A * h0_fixed + toImageHeightPenult.B * trialAlpha;
            const sign_bt = Math.sign(alpha_img_bt) || 1;
            const r_alpha_bt = -trialAlpha - sign_bt * alpha_img_bt;
            const r_height_bt = h1_bt - beta * h_img_bt;
            const cost_bt = (w_alpha * r_alpha_bt * r_alpha_bt) + (w_height * r_height_bt * r_height_bt);
            if (cost_bt <= cost && cost_bt <= prevCost) {
                accepted = true;
                alpha1 = trialAlpha;
                prevCost = cost_bt;
            } else {
                delta *= 0.5;
                trialAlpha = alpha1 + delta;
                if (trialAlpha > 0) trialAlpha = -trialAlpha;
                backtrack++;
            }
        }
        if (!accepted) break;
    }

    h1 = h0_fixed - s1 * alpha1 / N1;

    return { h1, alpha1 };
}

/**
 * Perform Afocal System Paraxial Trace with Fixed Initial Angle
 * アフォーカル系用近軸光線追跡（Table 1の方法を使用）
 * 
 * @param {Array} opticalSystemRows - Optical system data (in mm)
 * @param {number} wavelength - Wavelength in micrometers
 * @param {number} stopIndex - Index of the Stop surface
 * @param {number} referenceFocalLength - Reference focal length for normalization (default: 1.0 unit when omitted/Auto)
 * @returns {Object} {chief: Array, marginal: Array} trace data
 */
export function performAfocalParaxialTrace(opticalSystemRows, wavelength, stopIndex, referenceFocalLength) {
    console.log('\n📐 ===== Afocal System Paraxial Trace (Formula 21 Method) =====');
    
    const UNIT_SCALE = (referenceFocalLength !== undefined && isFinite(referenceFocalLength))
        ? referenceFocalLength
        : 1.0; // Auto/未指定なら1.0を単位長とする
    
    // 光学系を正規化単位で正規化（半径・厚みは安全取得）
    const normalizedRows = opticalSystemRows.map(surf => ({
        ...surf,
        radius: surf.radius === 'INF' ? 'INF' : getSafeRadius(surf) / UNIT_SCALE,
        thickness: getSafeThickness(surf) / UNIT_SCALE,
        semidia: parseFloat(surf.semidia) / UNIT_SCALE
    }));
    
    const s0_mm = parseFloat(opticalSystemRows[0].thickness); // Object面の厚さ（mm単位、正の値）
    const s1_mm = -s0_mm; // s₁ = -s₀（符号反転）
    const s1 = s1_mm / UNIT_SCALE; // 正規化単位
    const N1 = 1.0; // Object面の後は空気（常に1.0）
    
    console.log(`📏 Unit Scale: ${UNIT_SCALE}mm = 1 unit`);
    console.log(`📍 s₀ (thickness) = ${s0_mm} mm (original data)`);
    console.log(`📍 s₁ = -s₀ = ${s1_mm.toFixed(6)} mm (= ${s1.toFixed(6)} unit)`);
    console.log(`📍 N₁ = ${N1.toFixed(6)} (空気)`);
    
    // 横倍率βを取得（Paraxial Magnification = initialAlpha / finalAlpha）
    const fullSystemResult = calculateFullSystemParaxialTrace(opticalSystemRows, wavelength);
    
    if (!fullSystemResult || !fullSystemResult.finalAlpha) {
        console.error('❌ Paraxial trace failed');
        return null;
    }
    
    // β = initialAlpha / finalAlpha を計算
    // initialAlpha = -h₁/(n₁*s₀), h₁=1.0, n₁=1.0 なので initialAlpha = -1.0/s₀
    const initialAlpha = -1.0 / s0_mm; // α[1] = -h[1]/(n*s₀)
    const finalAlpha = fullSystemResult.finalAlpha;
    const beta = initialAlpha / finalAlpha;

    // 教科書式: γ = 1/β を採用（式(21)準拠）
    const gamma = 1.0 / beta;
    
    console.log(`📊 Initial α (Object) = ${initialAlpha.toFixed(8)} rad`);
    console.log(`📊 Final α (Image) = ${finalAlpha.toFixed(8)} rad`);
    console.log(`📊 Paraxial Magnification β = ${beta.toFixed(8)}`);
    console.log(`📊 Angular Magnification γ = ${gamma.toFixed(8)}`);
    
    // === ステップ1: Marginal Ray（子午光線）の初期条件 ===
    // 式(21): α₁ = β, h₁ = (s₁/N₁)β where s₁ = -s₀
    // mm単位で計算してから正規化単位に変換
    const alpha1_marginal = beta;
    const h1_marginal_mm = (s1_mm / N1) * beta; // s₁ = -s₀を使用
    const h1_marginal = h1_marginal_mm / UNIT_SCALE; // 正規化単位に変換
    
    // h₀を逆算: h₁ = h₀ - s₁·α₁/N₁ → h₀ = h₁ + s₁·α₁/N₁
    const h0_marginal = h1_marginal + s1 * alpha1_marginal / N1;
    
    console.log('\n🔴 Marginal Ray (子午光線) Initial Conditions [Formula 21]:');
    console.log(`   α₁ = β = ${alpha1_marginal.toFixed(8)}`);
    console.log(`   h₁ = (s₁/N₁)β = (${s1_mm.toFixed(6)}/${N1.toFixed(6)})×${beta.toFixed(8)} = ${h1_marginal_mm.toFixed(8)} mm = ${h1_marginal.toFixed(8)} unit`);
    console.log(`   h₀ (back-calculated) = ${h0_marginal.toFixed(8)} unit`);
    
    // 子午光線の追跡
    const marginalTrace = [];
    let h_marginal = h0_marginal;
    let alpha_marginal = alpha1_marginal; // 換算傾角
    let n = getRefractiveIndexFromSurface(normalizedRows[0], wavelength) || 1.0;
    
    marginalTrace.push({
        surface: 0,
        h: h_marginal,
        alpha: alpha_marginal,
        n: n,
        u: alpha_marginal / n
    });
    
    for (let i = 1; i < normalizedRows.length; i++) {
        const surf = normalizedRows[i];
        const prevSurf = normalizedRows[i - 1];
        const isStop = surf['object type'] === 'Stop' || surf.object === 'Stop';

        // 厚み（正規化）
        const thickness = (i === 1) ? s1 : parseFloat(prevSurf.thickness);

        // 転送 h[j] = h[j-1] - d * α / n_prev
        const n_prev = n;
        if (isFinite(thickness) && thickness !== 0) {
            h_marginal = h_marginal - thickness * alpha_marginal / n_prev;
        }

        // 入射換算角（更新前を保持）
        const alpha_incident = alpha_marginal;

        // 屈折率
        const N_after = getRefractiveIndexFromSurface(surf, wavelength) || 1.0;
        const radius = surf.radius === 'INF' ? Infinity : parseFloat(surf.radius);
        let phi = 0;
        if (isFinite(radius) && radius !== 0) {
            phi = (N_after - n_prev) / radius;
            alpha_marginal = alpha_incident + phi * h_marginal; // 換算傾角更新（屈折後）
        }

        // 屈折後の屈折率に更新
        n = N_after;
        
        marginalTrace.push({
            surface: i,
            h: h_marginal,
            alpha: alpha_incident,
            alpha_after: alpha_marginal,
            n_before: n_prev,
            n_after: N_after,
            n: N_after,
            u: alpha_incident / n_prev,
            phi: phi,
            curvature: isFinite(radius) && radius !== 0 ? 1.0 / radius : 0
        });
        
        if (i === 1) {
            console.log(`   ✅ Surface 1: h₁ = ${h_marginal.toFixed(8)}, α₁ (incident) = ${alpha_incident.toFixed(8)}, α₁ (after) = ${alpha_marginal.toFixed(8)}`);
        }
        if (i === stopIndex) {
            console.log(`   ✅ Stop (Surface ${i}): h = ${h_marginal.toFixed(8)}, α (incident) = ${alpha_incident.toFixed(8)}, α (after) = ${alpha_marginal.toFixed(8)}`);
        }
    }
    
    // === ステップ2: Chief Ray（主光線）の初期条件 ===
    // 条件: (1) stop面を通過 (h̄_stop≈0), (2) 出射平行 (ᾱ_final≈0)
    const solvedChief = solveChiefInitialForStopAfocal(normalizedRows, wavelength, s1, stopIndex, beta);
    // デバッグ・確認用にハードコード（依頼値）
        const alpha1_chief = solvedChief.alpha1;
        const h1_chief = solvedChief.h1;

    // h₀を逆算: h₁ = h₀ - s₁·α₁/N₁
    // 要望: h̄₀ 初期値を 1/β とする。ᾱ₁ が決まったあとで h̄₀ を固定し、h̄₁ を再算出する。
    // h0 はハードコード h1 と α1 から再計算
    const h0_chief = h1_chief + s1 * alpha1_chief / N1;
    const h1_chief_final = h1_chief;
    
    console.log('\n🔵 Chief Ray (主光線) Initial Conditions [Constraints: stop h̄≈0, ᾱ_out≈0]:');
        console.log(`   ᾱ₁ (estimated) = ${alpha1_chief.toFixed(8)}`);
        console.log(`   h̄₁ (estimated) = ${h1_chief_final.toFixed(8)} unit`);
        console.log(`   h̄₀ (back-calculated) = ${h0_chief.toFixed(8)} unit`);
    
    // 主光線の追跡
    const chiefTrace = [];
    let h_chief = h0_chief;
    let alpha_chief = alpha1_chief; // 換算傾角
    n = getRefractiveIndexFromSurface(normalizedRows[0], wavelength) || 1.0;
    
    chiefTrace.push({
        surface: 0,
        h: h_chief,
        alpha: alpha_chief,
        n: n,
        u: alpha_chief / n
    });
    
    for (let i = 1; i < normalizedRows.length; i++) {
        const surf = normalizedRows[i];
        const prevSurf = normalizedRows[i - 1];
        const isStop = surf['object type'] === 'Stop' || surf.object === 'Stop';

        // 厚み（正規化）
        const thickness = (i === 1) ? s1 : parseFloat(prevSurf.thickness);

        const n_prev = n;
        if (isFinite(thickness) && thickness !== 0) {
            h_chief = h_chief - thickness * alpha_chief / n_prev;
        }

        // 入射換算角を保持
        const alpha_incident = alpha_chief;

        const N_after = getRefractiveIndexFromSurface(surf, wavelength) || 1.0;
        const radius = surf.radius === 'INF' ? Infinity : parseFloat(surf.radius);
        let phi = 0;
        if (isFinite(radius) && radius !== 0) {
            phi = (N_after - n_prev) / radius;
            alpha_chief = alpha_incident + phi * h_chief;
        }

        n = N_after;
        
        chiefTrace.push({
            surface: i,
            h: h_chief,
            alpha: alpha_incident,
            alpha_after: alpha_chief,
            n_before: n_prev,
            n_after: N_after,
            n: N_after,
            u: alpha_incident / n_prev,
            phi: phi,
            curvature: isFinite(radius) && radius !== 0 ? 1.0 / radius : 0
        });
        
        if (i === 1) {
            console.log(`   ✅ Surface 1: h̄₁ = ${h_chief.toFixed(8)}, ᾱ₁ (incident) = ${alpha_incident.toFixed(8)}, ᾱ₁ (after) = ${alpha_chief.toFixed(8)}`);
        }
        if (i === stopIndex) {
            console.log(`   ✅ Stop (Surface ${i}): h̄ = ${h_chief.toFixed(8)}, ᾱ (incident) = ${alpha_incident.toFixed(8)}, ᾱ (after) = ${alpha_chief.toFixed(8)}`);
        }
    }
    
    console.log('✅ Afocal Paraxial Trace Complete (Formula 21)\n');
    
    return {
        chief: chiefTrace,         // 主光線（ᾱ₁=0, h̄₁=γ）
        marginal: marginalTrace,   // 子午光線（α₁=β, h₁=(s₁/N₁)β）
        stopIndex: stopIndex,
        unitScale: UNIT_SCALE,
        normalizedRows: normalizedRows
    };
}

/**
 * Calculate Seidel Aberration Coefficients for Afocal System (Integrated Version)
 * アフォーカル系のSeidel収差係数計算（統合版）
 * 
 * @param {Array} opticalSystemRows - Optical system data (in mm)
 * @param {number} wavelength - Wavelength in micrometers
 * @param {number} stopIndex - Index of the Stop surface
 * @param {Array} objectRows - Object table data (not used for afocal)
 * @param {number} referenceFocalLength - Reference focal length for normalization (default: 40mm)
 * @returns {Object} Seidel coefficients in standard format
 */
export function calculateAfocalSeidelCoefficientsIntegrated(opticalSystemRows, wavelength, stopIndex, objectRows, referenceFocalLength) {
    console.log('\n🔭 ===== Afocal System Seidel Coefficients (Integrated) =====');
    
    // アフォーカル系専用の近軸追跡を実行
    const afocalResult = performAfocalParaxialTrace(opticalSystemRows, wavelength, stopIndex, referenceFocalLength);
    
    if (!afocalResult) {
        console.error('❌ Afocal paraxial trace failed');
        return null;
    }
    
    const { chief, marginal, unitScale, normalizedRows } = afocalResult;
    
    // 収差係数の計算
    const surfaceCoefficients = [];
    let totalSI = 0, totalSII = 0, totalSIII = 0, totalSIV = 0, totalSV = 0;
    let totalP = 0;
    
    for (let i = 1; i < normalizedRows.length; i++) {
        const surf = normalizedRows[i];
        
        const chiefData = chief[i];
        const marginalData = marginal[i];
        
        const h = marginalData.h;
        const hbar = chiefData.h;
        
        const alpha_marginal = marginalData.alpha;          // 入射時の角度
        const alpha_chief = chiefData.alpha;                // 入射時の角度
        const alpha_marginal_after = marginalData.alpha_after;  // 屈折後の角度
        const alpha_chief_after = chiefData.alpha_after;        // 屈折後の角度
        
        const n_before = marginalData.n_before;
        const n_after = marginalData.n_after;
        
        const radius = surf.radius === 'INF' ? Infinity : parseFloat(surf.radius);
        const curvature = radius === Infinity ? 0 : 1.0 / radius;
        
        // 補助項の計算（eva-seidel-coefficients.jsと同じ方法）
        const u_marginal = alpha_marginal / n_before; // 入射側で割る（換算傾角→傾き）
        const u_chief = alpha_chief / n_before;

        let hQ = -alpha_marginal;      // r=∞の場合
        let hQ_chief = -alpha_chief;

        if (isFinite(radius) && radius !== 0) {
            hQ = h * n_before / radius - alpha_marginal;
            hQ_chief = hbar * n_before / radius - alpha_chief;
        }
        
        const J = (Math.abs(hQ) > 1e-10) ? (hQ_chief / hQ) : 0;
        
        // 前の面のデータを取得
        const marginalDataPrev = marginal[i - 1];
        const chiefDataPrev = chief[i - 1];
        
        const alpha_marginal_prev = marginalDataPrev.alpha_after || marginalDataPrev.alpha;
        const alpha_chief_prev = chiefDataPrev.alpha_after || chiefDataPrev.alpha;
        const n_prev = marginalDataPrev.n_after || marginalDataPrev.n;
        
        // hΔ(1/ns)の計算
        const hDelta_1_ns = alpha_marginal_after / (n_after * n_after) - alpha_marginal_prev / (n_prev * n_prev);
        const hDelta_1_ns_chief = alpha_chief_after / (n_after * n_after) - alpha_chief_prev / (n_prev * n_prev);
        
        // φ = (n' - n) / r
        let phi = 0;
        if (isFinite(radius) && radius !== 0) {
            phi = (n_after - n_before) / radius;
        }
        
        // Petzval項
        const P = phi / (n_after * n_before);
        
        // Seidel係数の計算（eva-seidel-coefficients.jsと同じ）
        const I = h * hQ * hQ * hDelta_1_ns;                   // Ⅰ: SA
        const II = I * (hQ_chief / hQ || 0);                   // Ⅱ: COMA = SA×J
        const III = h * hQ_chief * hQ_chief * hDelta_1_ns;     // Ⅲ: AS
        const IV = III + P;                                     // Ⅳ: Field Curvature
        
        let V;
        if (Math.abs(hQ) < 1e-10) {
            V = hDelta_1_ns_chief;
        } else {
            V = J * IV;
        }
        
        totalSI += I;
        totalSII += II;
        totalSIII += III;
        totalSIV += IV;
        totalSV += V;
        
        totalP += P;
        
        surfaceCoefficients.push({
            surfaceIndex: i,
            surfaceType: surf['object type'] || 'Lens',
            radius: radius * unitScale,
            thickness: parseFloat(surf.thickness) * unitScale,
            n: n_after,
            I: I,
            II: II,
            III: III,
            IV: IV,
            V: V,
            LCA: 0,
            TCA: 0,
            hQ: hQ,
            hQ_chief: hQ_chief,
            J: J,
            hDelta_1_ns: hDelta_1_ns,
            hDelta_1_ns_chief: hDelta_1_ns_chief,
            P: isFinite(P) ? P : 0
        });
    }
    
    // 色収差（LCA/TCA）計算・補完（数値Material/RefIndex+Abbe対応）
    const chromatic = computeAfocalChromaticAberrations(opticalSystemRows, stopIndex, referenceFocalLength, surfaceCoefficients, unitScale);
    const { totalLCA, totalTCA } = chromatic;

    console.log('\n📊 Total Aberration Coefficients (Afocal):');
    console.log(`   ΣSI   = ${totalSI.toFixed(6)} (Spherical)`);
    console.log(`   ΣSII  = ${totalSII.toFixed(6)} (Coma)`);
    console.log(`   ΣSIII = ${totalSIII.toFixed(6)} (Astigmatism)`);
    console.log(`   ΣSIV  = ${totalSIV.toFixed(6)} (Field Curvature)`);
    console.log(`   ΣSV   = ${totalSV.toFixed(6)} (Distortion)`);
    console.log(`   ΣP    = ${totalP.toFixed(6)} (Petzval Sum)`);
    console.log(`   ΣLCA  = ${totalLCA.toFixed(6)} (Longitudinal Chromatic)`);
    console.log(`   ΣTCA  = ${totalTCA.toFixed(6)} (Transverse Chromatic)`);
    console.log('✅ Afocal Seidel Coefficients Calculation Complete\n');
    
    return {
        surfaceCoefficients: surfaceCoefficients,
        totals: {
            I: totalSI,
            II: totalSII,
            III: totalSIII,
            IV: totalSIV,
            V: totalSV,
            LCA: totalLCA,
            TCA: totalTCA,
            P: totalP
        },
        totalSI: totalSI,
        totalSII: totalSII,
        totalSIII: totalSIII,
        totalSIV: totalSIV,
        totalSV: totalSV,
        totalLCA: totalLCA,
        totalTCA: totalTCA,
        opticalSystemRows: opticalSystemRows,
        wavelength: wavelength,
        unitScale: unitScale,
        chromaticAberrations: chromatic,
        marginalTraceData: marginal.map((d, i) => ({
            surface: i,
            height: d.h * unitScale,
            alpha: d.alpha,
            n: d.n
        })),
        chiefTraceData: chief.map((d, i) => ({
            surface: i,
            height: d.h * unitScale,
            alpha: d.alpha,
            n: d.n
        })),
        isAfocal: true
    };
}


/**
 * Calculate Seidel Aberration Coefficients for Afocal System
 * アフォーカル系のSeidel収差係数計算
 * 
 * @param {Array} opticalSystemRows - Optical system data (in mm)
 * @param {number} wavelength - Wavelength in micrometers
 * @param {number} stopIndex - Index of the Stop surface
 * @returns {Object} Aberration coefficients for each surface and totals
 */
export function calculateAfocalSeidelCoefficients(opticalSystemRows, wavelength, stopIndex, referenceFocalLength) {
    console.log('\n🔬 ===== Afocal System Seidel Coefficients =====');
    
    // 近軸光線追跡実行
    const traceResult = performAfocalParaxialTrace(opticalSystemRows, wavelength, stopIndex, referenceFocalLength);
    
    if (!traceResult) {
        console.error('❌ Paraxial trace failed');
        return null;
    }
    
    const { chief, marginal, unitScale, normalizedRows } = traceResult;
    
    // 収差係数の計算
    const coefficients = [];
    
    for (let i = 1; i < normalizedRows.length; i++) {
        const surf = normalizedRows[i];
        
        // この面での主光線と子午光線のデータ
        const chiefData = chief[i];
        const marginalData = marginal[i];
        const prevChiefData = chief[i - 1];
        const prevMarginalData = marginal[i - 1];
        
        const h = marginalData.h;  // 子午光線の高さ
        const hbar = chiefData.h;  // 主光線の高さ
        const u = marginalData.u;  // 子午光線の換算傾角
        const ubar = chiefData.u;  // 主光線の換算傾角
        const n = chiefData.n;
        const n_prev = chief[i - 1].n;
        
        const radius = surf.radius === 'INF' ? Infinity : parseFloat(surf.radius);
        const curvature = radius === Infinity ? 0 : 1.0 / radius;
        
        // A = h × ubar (invariant)
        const A = h * ubar;
        
        // Hbar = n × hbar × ubar
        const Hbar = n * hbar * ubar;
        
        // 屈折不変量 I
        const I = n * h * u - n_prev * prevMarginalData.h * prevMarginalData.u;
        
        // 収差係数の計算（Seidel係数）
        const c = curvature;
        const c3 = c * c * c;
        
        const SI = 0.5 * A * A * I * c3 * h * h;
        const SII = A * Hbar * I * c3 * h * h;
        const SIII = 0.5 * Hbar * Hbar * I * c3 * h * h;
        const SIV = 0.5 * Hbar * I * c * (n + n_prev);
        const SV = 0.5 * Hbar * Hbar * I * c;
        
        coefficients.push({
            surface: i,
            surfaceType: surf.surfType || 'Spherical',
            objectType: surf['object type'] || '',
            radius: radius * unitScale,  // mm単位に戻す
            h: h * unitScale,
            hbar: hbar * unitScale,
            u: u,
            ubar: ubar,
            n: n,
            A: A,
            Hbar: Hbar,
            I: I,
            SI: SI,
            SII: SII,
            SIII: SIII,
            SIV: SIV,
            SV: SV
        });
        
        if (i === stopIndex) {
            console.log(`\n⭐ Stop (Surface ${i}) Aberration Coefficients:`);
            console.log(`   SI   = ${SI.toExponential(6)}`);
            console.log(`   SII  = ${SII.toExponential(6)}`);
            console.log(`   SIII = ${SIII.toExponential(6)}`);
            console.log(`   SIV  = ${SIV.toExponential(6)}`);
            console.log(`   SV   = ${SV.toExponential(6)}`);
        }
    }
    
    // 合計を計算
    const totals = {
        SI: coefficients.reduce((sum, c) => sum + c.SI, 0),
        SII: coefficients.reduce((sum, c) => sum + c.SII, 0),
        SIII: coefficients.reduce((sum, c) => sum + c.SIII, 0),
        SIV: coefficients.reduce((sum, c) => sum + c.SIV, 0),
        SV: coefficients.reduce((sum, c) => sum + c.SV, 0)
    };
    
    console.log('\n📊 Total Aberration Coefficients:');
    console.log(`   ΣSI   = ${totals.SI.toFixed(6)} (Spherical)`);
    console.log(`   ΣSII  = ${totals.SII.toFixed(6)} (Coma)`);
    console.log(`   ΣSIII = ${totals.SIII.toFixed(6)} (Astigmatism)`);
    console.log(`   ΣSIV  = ${totals.SIV.toFixed(6)} (Field Curvature)`);
    console.log(`   ΣSV   = ${totals.SV.toFixed(6)} (Distortion)`);
    
    console.log('\n✅ Afocal Seidel Coefficients Calculation Complete\n');
    
    return {
        coefficients: coefficients,
        totals: totals,
        traceResult: traceResult
    };
}
