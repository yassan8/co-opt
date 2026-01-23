/**
 * アフォーカル光学系の近軸光線追跡と初期値確認
 * α1, h1, ᾱ1, h̄1 の計算値を確認
 */

import { getOpticalSystemRows } from '../utils/data-utils.js';

/**
 * 近軸光線追跡（主光線・子午光線）
 * @param {Array} opticalSystemRows - 光学系データ
 * @param {number} y1 - 初期物体高さ (アフォーカル系では最大画面サイズを1とする)
 */
function paraxialRayTrace(opticalSystemRows, y1 = 1.0) {
    console.log('\n📐 ===== 近軸光線追跡開始 =====');
    console.log(`📏 初期物体高さ y1 = ${y1}`);
    
    // 光学系データの確認
    console.log(`\n📊 光学系データ: ${opticalSystemRows.length} 面`);
    
    // Stop面を探す
    let stopIndex = -1;
    for (let i = 0; i < opticalSystemRows.length; i++) {
        if (opticalSystemRows[i]['object type'] === 'Stop') {
            stopIndex = i;
            break;
        }
    }
    console.log(`🎯 Stop面: Surface ${stopIndex} (0-indexed)`);
    
    // 主光線 (chief ray) の初期値
    // アフォーカル系: α1 = β = 1/γ, h1 = (s1/N1)β = (s1/N1)(1/γ)
    // ここではまず、Object位置から始める
    let alpha = 0;  // 初期角度（後で計算）
    let h = y1;     // 初期高さ
    
    // 子午光線 (marginal ray) の初期値
    // アフォーカル系: ᾱ1 = 0, h̄1 = 1/β = γ
    let alpha_bar = 0;  // 初期角度（後で計算）
    let h_bar = 0;      // 初期高さ（軸上から出発）
    
    console.log('\n🔵 主光線 (Chief Ray) 追跡:');
    console.log('═'.repeat(80));
    
    // 第1面のデータ
    const surf0 = opticalSystemRows[0];
    const surf1 = opticalSystemRows[1];
    
    // 第1面の屈折率
    const N0 = 1.0;  // Object space (空気)
    const N1 = parseFloat(surf1.material) || 1.0;
    
    // 第1面の曲率
    const r1 = surf1.radius === 'INF' ? Infinity : parseFloat(surf1.radius);
    const c1 = r1 === Infinity ? 0 : 1.0 / r1;
    
    // Object面からの距離
    const d0 = parseFloat(surf0.thickness);
    
    console.log(`\nSurface 0 (Object): thickness = ${d0}`);
    console.log(`Surface 1: radius = ${r1}, material = ${N1}, curvature = ${c1}`);
    
    // アフォーカル系の初期値設定
    // 物体が無限遠にある場合: a1 = 0, s1 = -d0 (Object面からの距離)
    const s1 = -d0;  // 第1面から見た物体距離（負の値）
    
    // アフォーカル系の理論値から計算
    // γ は光学系の倍率パラメータだが、ここではまず近軸追跡で求める
    
    // 主光線の初期角度: Stop面を通るように設定
    // 簡易的に、h1 = y1 として、Stop面で h = 0 になるように角度を設定
    
    console.log(`\n📍 初期値設定:`);
    console.log(`  物体距離 s1 = ${s1} mm`);
    console.log(`  第1面屈折率 N1 = ${N1}`);
    
    // 近軸光線追跡の実行
    const results = [];
    
    // 主光線の追跡
    alpha = 0;  // 初期はStop面で h=0 になるように後で調整
    h = y1;
    
    // 簡易的な近軸追跡: まずは全面を通して追跡
    for (let i = 1; i < opticalSystemRows.length; i++) {
        const surf = opticalSystemRows[i];
        const prevSurf = opticalSystemRows[i - 1];
        
        const thickness = parseFloat(prevSurf.thickness);
        const radius = surf.radius === 'INF' ? Infinity : parseFloat(surf.radius);
        const curvature = radius === Infinity ? 0 : 1.0 / radius;
        
        // 屈折率
        const N_before = i === 1 ? 1.0 : (parseFloat(opticalSystemRows[i - 1].material) || 1.0);
        const N_after = surf['object type'] === 'Image' ? 1.0 : (parseFloat(surf.material) || 1.0);
        
        // Transfer (前の面からこの面まで)
        const h_new = h + thickness * alpha;
        
        // Refraction (この面での屈折)
        const phi = h_new * curvature;  // 入射高さ × 曲率
        const alpha_new = alpha + phi * (N_before - N_after) / N_after;
        
        results.push({
            surface: i,
            surfType: surf.surfType || 'Spherical',
            objectType: surf['object type'] || '',
            h_before: h,
            h_after: h_new,
            alpha_before: alpha,
            alpha_after: alpha_new,
            thickness: thickness,
            radius: radius,
            curvature: curvature,
            N_before: N_before,
            N_after: N_after,
            phi: phi
        });
        
        h = h_new;
        alpha = alpha_new;
        
        // Stop面での確認
        if (i === stopIndex) {
            console.log(`\n⭐ Stop面 (Surface ${i}): h = ${h.toFixed(6)}, α = ${alpha.toFixed(6)}`);
        }
    }
    
    console.log('\n📊 近軸光線追跡結果:');
    console.log('═'.repeat(100));
    console.log('Surf | Type      | h_in      | h_out     | α_in      | α_out     | r         | N_in  | N_out');
    console.log('─'.repeat(100));
    
    for (const r of results) {
        const surfLabel = r.objectType ? `${r.surface} (${r.objectType})` : r.surface;
        console.log(
            `${surfLabel.toString().padEnd(4)} | ` +
            `${r.surfType.substring(0, 9).padEnd(9)} | ` +
            `${r.h_before.toFixed(6).padStart(9)} | ` +
            `${r.h_after.toFixed(6).padStart(9)} | ` +
            `${r.alpha_before.toFixed(6).padStart(9)} | ` +
            `${r.alpha_after.toFixed(6).padStart(9)} | ` +
            `${(r.radius === Infinity ? 'INF' : r.radius.toFixed(2)).padStart(9)} | ` +
            `${r.N_before.toFixed(3)} | ` +
            `${r.N_after.toFixed(3)}`
        );
    }
    
    // 最終値（Image面）
    const finalResult = results[results.length - 1];
    console.log('\n✅ 最終値 (Image面):');
    console.log(`   h (主光線高さ) = ${finalResult.h_after.toFixed(6)} mm`);
    console.log(`   α (主光線角度) = ${finalResult.alpha_after.toFixed(6)} rad`);
    
    // アフォーカル系の初期値を計算
    console.log('\n📐 アフォーカル系の理論初期値:');
    
    // 第1面での主光線データ
    const firstSurfResult = results[0];
    const h1 = firstSurfResult.h_after;
    const alpha1 = firstSurfResult.alpha_after;
    
    console.log(`\n🔵 主光線 (Chief Ray) - 第1面通過後:`);
    console.log(`   α1 = ${alpha1.toFixed(6)} rad`);
    console.log(`   h1 = ${h1.toFixed(6)} mm`);
    
    // 子午光線の追跡（軸上から、Stop面の端を通る）
    console.log('\n🔴 子午光線 (Marginal Ray) 追跡:');
    console.log('═'.repeat(80));
    
    // 子午光線: 軸上の点から出て、Stop面の開口端を通る
    let alpha_bar_trace = 0;
    let h_bar_trace = 0;
    
    const stopSurf = opticalSystemRows[stopIndex];
    const stopRadius = parseFloat(stopSurf.semidia) || 5.5;  // Stop面の半径
    
    console.log(`Stop面の半径 (semidia): ${stopRadius} mm`);
    
    // Object面から第1面までの距離で、Stop面の端に到達するような角度を計算
    // 簡易計算: Stop面までの累積距離を計算
    let cumulativeThickness = 0;
    for (let i = 0; i < stopIndex; i++) {
        cumulativeThickness += parseFloat(opticalSystemRows[i].thickness);
    }
    
    console.log(`Object面からStop面までの距離: ${cumulativeThickness} mm`);
    
    // 初期角度: h_bar = 0, Stop面で h = stopRadius になるように
    // 単純化: alpha_bar_initial ≈ stopRadius / cumulativeThickness
    const alpha_bar_initial = stopRadius / cumulativeThickness;
    
    alpha_bar_trace = alpha_bar_initial;
    h_bar_trace = 0;
    
    console.log(`初期角度 ᾱ_initial ≈ ${alpha_bar_initial.toFixed(6)} rad`);
    
    const marginalResults = [];
    
    for (let i = 1; i < opticalSystemRows.length; i++) {
        const surf = opticalSystemRows[i];
        const prevSurf = opticalSystemRows[i - 1];
        
        const thickness = parseFloat(prevSurf.thickness);
        const radius = surf.radius === 'INF' ? Infinity : parseFloat(surf.radius);
        const curvature = radius === Infinity ? 0 : 1.0 / radius;
        
        const N_before = i === 1 ? 1.0 : (parseFloat(opticalSystemRows[i - 1].material) || 1.0);
        const N_after = surf['object type'] === 'Image' ? 1.0 : (parseFloat(surf.material) || 1.0);
        
        const h_bar_new = h_bar_trace + thickness * alpha_bar_trace;
        const phi_bar = h_bar_new * curvature;
        const alpha_bar_new = alpha_bar_trace + phi_bar * (N_before - N_after) / N_after;
        
        marginalResults.push({
            surface: i,
            h_bar_before: h_bar_trace,
            h_bar_after: h_bar_new,
            alpha_bar_before: alpha_bar_trace,
            alpha_bar_after: alpha_bar_new
        });
        
        h_bar_trace = h_bar_new;
        alpha_bar_trace = alpha_bar_new;
        
        if (i === stopIndex) {
            console.log(`\n⭐ Stop面 (Surface ${i}): h̄ = ${h_bar_trace.toFixed(6)}, ᾱ = ${alpha_bar_trace.toFixed(6)}`);
        }
    }
    
    const marginalFinal = marginalResults[marginalResults.length - 1];
    console.log('\n✅ 子午光線最終値 (Image面):');
    console.log(`   h̄ (子午光線高さ) = ${marginalFinal.h_bar_after.toFixed(6)} mm`);
    console.log(`   ᾱ (子午光線角度) = ${marginalFinal.alpha_bar_after.toFixed(6)} rad`);
    
    // 第1面での子午光線データ
    const marginalFirst = marginalResults[0];
    const h1_bar = marginalFirst.h_bar_after;
    const alpha1_bar = marginalFirst.alpha_bar_after;
    
    console.log(`\n🔴 子午光線 (Marginal Ray) - 第1面通過後:`);
    console.log(`   ᾱ1 = ${alpha1_bar.toFixed(6)} rad`);
    console.log(`   h̄1 = ${h1_bar.toFixed(6)} mm`);
    
    // アフォーカル系のパラメータ計算
    console.log('\n📐 アフォーカル系パラメータ:');
    
    // 横倍率 β (理論値: アフォーカル系では定義が異なる)
    // 簡易的に最終高さ比から計算
    const h_final = finalResult.h_after;
    const h_initial = y1;
    const beta_effective = h_final / h_initial;
    
    console.log(`   実効横倍率 β_eff = h_final / h_initial = ${beta_effective.toFixed(6)}`);
    
    // γ パラメータ (理論: β = 1/γ)
    const gamma = beta_effective !== 0 ? 1.0 / beta_effective : Infinity;
    console.log(`   γ = 1/β = ${gamma.toFixed(6)}`);
    
    // 理論値との比較
    console.log('\n📊 理論値との比較:');
    console.log('   アフォーカル系理論公式:');
    console.log('   ・α1 = β = 1/γ');
    console.log('   ・h1 = (s1/N1) × β = (s1/N1) × (1/γ)');
    console.log('   ・ᾱ1 = 0');
    console.log('   ・h̄1 = 1/β = γ');
    
    const alpha1_theory = 1.0 / gamma;
    const h1_theory = (s1 / N1) * (1.0 / gamma);
    const alpha1_bar_theory = 0;
    const h1_bar_theory = gamma;
    
    console.log(`\n   理論値 (計算):`);
    console.log(`   ・α1_theory  = ${alpha1_theory.toFixed(6)} rad`);
    console.log(`   ・h1_theory  = ${h1_theory.toFixed(6)} mm`);
    console.log(`   ・ᾱ1_theory  = ${alpha1_bar_theory.toFixed(6)} rad`);
    console.log(`   ・h̄1_theory  = ${h1_bar_theory.toFixed(6)} mm`);
    
    console.log(`\n   実測値 (近軸光線追跡):`);
    console.log(`   ・α1_actual  = ${alpha1.toFixed(6)} rad`);
    console.log(`   ・h1_actual  = ${h1.toFixed(6)} mm`);
    console.log(`   ・ᾱ1_actual  = ${alpha1_bar.toFixed(6)} rad`);
    console.log(`   ・h̄1_actual  = ${h1_bar.toFixed(6)} mm`);
    
    console.log('\n📐 ===== 近軸光線追跡完了 =====\n');
    
    return {
        chiefRay: {
            alpha1: alpha1,
            h1: h1,
            alpha_final: finalResult.alpha_after,
            h_final: finalResult.h_after
        },
        marginalRay: {
            alpha1_bar: alpha1_bar,
            h1_bar: h1_bar,
            alpha_bar_final: marginalFinal.alpha_bar_after,
            h_bar_final: marginalFinal.h_bar_after
        },
        parameters: {
            beta: beta_effective,
            gamma: gamma,
            s1: s1,
            N1: N1
        },
        theory: {
            alpha1_theory: alpha1_theory,
            h1_theory: h1_theory,
            alpha1_bar_theory: alpha1_bar_theory,
            h1_bar_theory: h1_bar_theory
        }
    };
}

// メイン実行
console.log('🚀 アフォーカル光学系の近軸光線追跡と初期値確認');
console.log('=' .repeat(80));

const opticalSystemRows = getOpticalSystemRows();
console.log(`✅ 光学系データ読み込み: ${opticalSystemRows.length} 面`);

// 近軸光線追跡実行
// y1 = 1 (アフォーカル系では最大画面サイズを1とする単位系)
const results = paraxialRayTrace(opticalSystemRows, 1.0);

console.log('✅ 計算完了');
