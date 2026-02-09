/**
 * 直接比較ベンチマークテスト
 * WASMの問題を回避してJavaScript最適化の効果を直接測定
 */

// 標準JavaScript版非球面SAG計算
function standardAsphericSag(r, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
    if (r === 0) return 0;
    
    const r2 = r * r;
    const cr2 = c * r2;
    
    // 基本SAG計算
    const discriminant = 1 - (1 + k) * c * c * r2;
    if (discriminant <= 0) return 0;
    
    const basicSag = cr2 / (1 + Math.sqrt(discriminant));
    
    // 非球面項（Math.pow使用）
    let asphericalTerms = 0;
    if (a4 !== 0) asphericalTerms += a4 * Math.pow(r, 4);
    if (a6 !== 0) asphericalTerms += a6 * Math.pow(r, 6);
    if (a8 !== 0) asphericalTerms += a8 * Math.pow(r, 8);
    if (a10 !== 0) asphericalTerms += a10 * Math.pow(r, 10);
    
    return basicSag + asphericalTerms;
}

// 最適化JavaScript版非球面SAG計算（Horner法）
function optimizedAsphericSag(r, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
    if (r === 0) return 0;
    
    const r2 = r * r;
    const cr2 = c * r2;
    
    // 基本SAG計算（最適化済み）
    const discriminant = 1 - (1 + k) * c * c * r2;
    if (discriminant <= 0) return 0;
    
    const sqrtTerm = Math.sqrt(discriminant);
    const basicSag = cr2 / (1 + sqrtTerm);
    
    // 非球面項（Horner法 + 逐次乗算）
    let asphericalTerms = 0;
    if (a4 !== 0 || a6 !== 0 || a8 !== 0 || a10 !== 0) {
        const r4 = r2 * r2;
        
        if (a10 !== 0) {
            const r6 = r4 * r2;
            const r8 = r4 * r4;
            const r10 = r8 * r2;
            // Horner法: a10*r^10 + a8*r^8 + a6*r^6 + a4*r^4
            asphericalTerms = a10 * r10 + a8 * r8 + a6 * r6 + a4 * r4;
        } else if (a8 !== 0) {
            const r6 = r4 * r2;
            const r8 = r4 * r4;
            asphericalTerms = a8 * r8 + a6 * r6 + a4 * r4;
        } else if (a6 !== 0) {
            const r6 = r4 * r2;
            asphericalTerms = a6 * r6 + a4 * r4;
        } else {
            asphericalTerms = a4 * r4;
        }
    }
    
    return basicSag + asphericalTerms;
}

// TypedArray最適化版
function typedArrayAsphericSag(radiusArray, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
    const length = radiusArray.length;
    const results = new Float64Array(length);
    
    for (let i = 0; i < length; i++) {
        const r = radiusArray[i];
        if (r === 0) {
            results[i] = 0;
            continue;
        }
        
        const r2 = r * r;
        const cr2 = c * r2;
        
        const discriminant = 1 - (1 + k) * c * c * r2;
        if (discriminant <= 0) {
            results[i] = 0;
            continue;
        }
        
        const basicSag = cr2 / (1 + Math.sqrt(discriminant));
        
        let asphericalTerms = 0;
        if (a4 !== 0 || a6 !== 0 || a8 !== 0 || a10 !== 0) {
            const r4 = r2 * r2;
            if (a10 !== 0) {
                const r6 = r4 * r2;
                const r8 = r4 * r4;
                const r10 = r8 * r2;
                asphericalTerms = a10 * r10 + a8 * r8 + a6 * r6 + a4 * r4;
            } else if (a8 !== 0) {
                const r6 = r4 * r2;
                const r8 = r4 * r4;
                asphericalTerms = a8 * r8 + a6 * r6 + a4 * r4;
            } else if (a6 !== 0) {
                const r6 = r4 * r2;
                asphericalTerms = a6 * r6 + a4 * r4;
            } else {
                asphericalTerms = a4 * r4;
            }
        }
        
        results[i] = basicSag + asphericalTerms;
    }
    
    return Array.from(results);
}

// 包括的ベンチマーク
function runDirectBenchmark() {
    console.log('🧪 直接比較ベンチマーク開始...');
    
    const testSizes = [1000, 5000, 10000];
    const testCases = [
        { name: '球面レンズ', params: [0.1, 0, 0, 0, 0, 0] },
        { name: '非球面レンズ', params: [0.05, -0.5, 1e-6, 1e-8, 0, 0] },
        { name: '高次非球面', params: [0.02, -1.0, 5e-6, 1e-7, 1e-9, 1e-11] }
    ];
    
    const results = [];
    
    for (const testCase of testCases) {
        console.log(`\n📊 ${testCase.name} テスト:`);
        const [c, k, a4, a6, a8, a10] = testCase.params;
        
        for (const testSize of testSizes) {
            const testRadii = Array.from({ length: testSize }, () => Math.random() * 10);
            
            // 標準版テスト
            const standardStart = performance.now();
            const standardResults = testRadii.map(r => standardAsphericSag(r, c, k, a4, a6, a8, a10));
            const standardTime = performance.now() - standardStart;
            
            // 最適化版テスト
            const optimizedStart = performance.now();
            const optimizedResults = testRadii.map(r => optimizedAsphericSag(r, c, k, a4, a6, a8, a10));
            const optimizedTime = performance.now() - optimizedStart;
            
            // TypedArray版テスト
            const typedArrayStart = performance.now();
            const typedArrayResults = typedArrayAsphericSag(testRadii, c, k, a4, a6, a8, a10);
            const typedArrayTime = performance.now() - typedArrayStart;
            
            // 精度検証
            const maxError1 = Math.max(...standardResults.map((std, i) => Math.abs(std - optimizedResults[i])));
            const maxError2 = Math.max(...standardResults.map((std, i) => Math.abs(std - typedArrayResults[i])));
            
            const speedup1 = standardTime / optimizedTime;
            const speedup2 = standardTime / typedArrayTime;
            
            const result = {
                testCase: testCase.name,
                testSize,
                standardTime,
                optimizedTime,
                typedArrayTime,
                speedup1,
                speedup2,
                maxError1,
                maxError2
            };
            
            results.push(result);
            
            console.log(`   サイズ ${testSize}:`);
            console.log(`     標準版: ${standardTime.toFixed(2)}ms`);
            console.log(`     最適化版: ${optimizedTime.toFixed(2)}ms (${speedup1.toFixed(2)}倍)`);
            console.log(`     TypedArray版: ${typedArrayTime.toFixed(2)}ms (${speedup2.toFixed(2)}倍)`);
            console.log(`     誤差1: ${maxError1.toExponential(3)}`);
            console.log(`     誤差2: ${maxError2.toExponential(3)}`);
        }
    }
    
    // 総合結果
    console.log('\n📈 総合結果:');
    const avgSpeedup1 = results.reduce((sum, r) => sum + r.speedup1, 0) / results.length;
    const avgSpeedup2 = results.reduce((sum, r) => sum + r.speedup2, 0) / results.length;
    const maxSpeedup1 = Math.max(...results.map(r => r.speedup1));
    const maxSpeedup2 = Math.max(...results.map(r => r.speedup2));
    
    console.log(`   Horner法最適化: 平均 ${avgSpeedup1.toFixed(2)}倍, 最大 ${maxSpeedup1.toFixed(2)}倍`);
    console.log(`   TypedArray最適化: 平均 ${avgSpeedup2.toFixed(2)}倍, 最大 ${maxSpeedup2.toFixed(2)}倍`);
    
    return results;
}

// 実世界シミュレーション
function runRealWorldSimulation() {
    console.log('🎯 実世界シミュレーション開始...');
    
    // 実際の光学系パラメータ
    const lensParameters = [
        { name: 'Bi-Convex', c: 0.0333, k: 0, a4: 0, a6: 0, a8: 0, a10: 0 },
        { name: 'Aspheric', c: 0.0250, k: -0.6, a4: 2.5e-6, a6: -1.2e-8, a8: 0, a10: 0 },
        { name: 'High-Order', c: 0.0125, k: -1.2, a4: 8.3e-6, a6: -3.7e-8, a8: 1.2e-10, a10: -2.8e-13 }
    ];
    
    const rayCount = 25000; // 実用的な光線数
    const results = [];
    
    for (const lens of lensParameters) {
        console.log(`\n🔍 ${lens.name}レンズテスト (${rayCount}光線):`);
        
        // 光線高さ分布（実際の光学系に近い分布）
        const rayHeights = Array.from({ length: rayCount }, (_, i) => {
            const normalized = i / rayCount;
            return Math.sqrt(normalized) * 12.5; // 0-12.5mm, 実際の分布に近似
        });
        
        // 標準版
        const standardStart = performance.now();
        const standardResults = rayHeights.map(r => 
            standardAsphericSag(r, lens.c, lens.k, lens.a4, lens.a6, lens.a8, lens.a10)
        );
        const standardTime = performance.now() - standardStart;
        
        // 最適化版
        const optimizedStart = performance.now();
        const optimizedResults = rayHeights.map(r => 
            optimizedAsphericSag(r, lens.c, lens.k, lens.a4, lens.a6, lens.a8, lens.a10)
        );
        const optimizedTime = performance.now() - optimizedStart;
        
        // TypedArray版
        const typedArrayStart = performance.now();
        const typedArrayResults = typedArrayAsphericSag(rayHeights, lens.c, lens.k, lens.a4, lens.a6, lens.a8, lens.a10);
        const typedArrayTime = performance.now() - typedArrayStart;
        
        const speedup1 = standardTime / optimizedTime;
        const speedup2 = standardTime / typedArrayTime;
        
        const result = {
            lens: lens.name,
            rayCount,
            standardTime,
            optimizedTime,
            typedArrayTime,
            speedup1,
            speedup2,
            efficiency1: rayCount / optimizedTime, // rays/ms
            efficiency2: rayCount / typedArrayTime
        };
        
        results.push(result);
        
        console.log(`   標準版: ${standardTime.toFixed(2)}ms`);
        console.log(`   最適化版: ${optimizedTime.toFixed(2)}ms (${speedup1.toFixed(2)}倍)`);
        console.log(`   TypedArray版: ${typedArrayTime.toFixed(2)}ms (${speedup2.toFixed(2)}倍)`);
        console.log(`   効率: ${result.efficiency1.toFixed(0)} rays/ms (最適化), ${result.efficiency2.toFixed(0)} rays/ms (TypedArray)`);
    }
    
    // 実用性評価
    console.log('\n🚀 実用性評価:');
    const avgEfficiency1 = results.reduce((sum, r) => sum + r.efficiency1, 0) / results.length;
    const avgEfficiency2 = results.reduce((sum, r) => sum + r.efficiency2, 0) / results.length;
    
    console.log(`   平均処理効率:`);
    console.log(`     Horner法最適化: ${avgEfficiency1.toFixed(0)} rays/ms`);
    console.log(`     TypedArray最適化: ${avgEfficiency2.toFixed(0)} rays/ms`);
    console.log(`   実用レベル判定:`);
    console.log(`     100,000光線処理時間:`);
    console.log(`       Horner法: ${(100000/avgEfficiency1).toFixed(0)}ms`);
    console.log(`       TypedArray: ${(100000/avgEfficiency2).toFixed(0)}ms`);
    
    return results;
}

// グローバル関数として公開
if (typeof window !== 'undefined') {
    window.runDirectBenchmark = runDirectBenchmark;
    window.runRealWorldSimulation = runRealWorldSimulation;
    window.standardAsphericSag = standardAsphericSag;
    window.optimizedAsphericSag = optimizedAsphericSag;
    window.typedArrayAsphericSag = typedArrayAsphericSag;
    
    // WASM比較機能
    window.runWASMComparison = async function() {
        console.log('🤖 === WASM vs JavaScript Ultimate Comparison ===');
        
        // WASM system check
        let wasmSystem = null;
        try {
            if (typeof getWASMSystem === 'function') {
                wasmSystem = getWASMSystem();
            } else if (typeof window.getWASMSystem === 'function') {
                wasmSystem = window.getWASMSystem();
            }
            
            if (!wasmSystem || !wasmSystem.isWASMReady) {
                console.log('⚠️ WASM system not available, skipping WASM comparison');
                return runDirectBenchmark();
            }
            
            console.log('✅ WASM system available, running full comparison');
            
        } catch (error) {
            console.error('❌ WASM system check failed:', error);
            return runDirectBenchmark();
        }
        
        const testSizes = [1000, 5000, 10000, 25000];
        const testCases = [
            { name: '球面レンズ', params: [0.1, 0, 0, 0, 0, 0] },
            { name: '非球面レンズ', params: [0.05, -0.5, 1e-6, 1e-8, 0, 0] },
            { name: '高次非球面', params: [0.02, -1.0, 5e-6, 1e-7, 1e-9, 1e-11] }
        ];
        
        const results = [];
        
        for (const testCase of testCases) {
            console.log(`\n🔍 ${testCase.name} - WASM vs JavaScript比較:`);
            const [c, k, a4, a6, a8, a10] = testCase.params;
            
            for (const testSize of testSizes) {
                const testRadii = Array.from({ length: testSize }, () => Math.random() * 10);
                
                // JavaScript標準版
                const jsStart = performance.now();
                const jsResults = testRadii.map(r => standardAsphericSag(r, c, k, a4, a6, a8, a10));
                const jsTime = performance.now() - jsStart;
                
                // JavaScript最適化版
                const optStart = performance.now();
                const optResults = testRadii.map(r => optimizedAsphericSag(r, c, k, a4, a6, a8, a10));
                const optTime = performance.now() - optStart;
                
                // TypedArray版
                const typedStart = performance.now();
                const typedResults = typedArrayAsphericSag(testRadii, c, k, a4, a6, a8, a10);
                const typedTime = performance.now() - typedStart;
                
                // WASM版
                const wasmStart = performance.now();
                const wasmResults = testRadii.map(r => wasmSystem.forceAsphericSag(r, c, k, a4, a6, a8, a10));
                const wasmTime = performance.now() - wasmStart;
                
                // 精度検証
                const maxErrorOpt = Math.max(...jsResults.map((js, i) => Math.abs(js - optResults[i])));
                const maxErrorTyped = Math.max(...jsResults.map((js, i) => Math.abs(js - typedResults[i])));
                const maxErrorWasm = Math.max(...jsResults.map((js, i) => Math.abs(js - wasmResults[i])));
                
                const result = {
                    testCase: testCase.name,
                    testSize,
                    jsTime,
                    optTime,
                    typedTime,
                    wasmTime,
                    speedupOpt: jsTime / optTime,
                    speedupTyped: jsTime / typedTime,
                    speedupWasm: jsTime / wasmTime,
                    wasmVsOpt: optTime / wasmTime,
                    wasmVsTyped: typedTime / wasmTime,
                    maxErrorOpt,
                    maxErrorTyped,
                    maxErrorWasm
                };
                
                results.push(result);
                
                console.log(`   サイズ ${testSize}:`);
                console.log(`     JavaScript標準: ${jsTime.toFixed(2)}ms`);
                console.log(`     JavaScript最適化: ${optTime.toFixed(2)}ms (${result.speedupOpt.toFixed(2)}倍)`);
                console.log(`     TypedArray: ${typedTime.toFixed(2)}ms (${result.speedupTyped.toFixed(2)}倍)`);
                console.log(`     WASM: ${wasmTime.toFixed(2)}ms (${result.speedupWasm.toFixed(2)}倍)`);
                console.log(`     WASM効率: vs最適化 ${result.wasmVsOpt.toFixed(2)}倍, vsTypedArray ${result.wasmVsTyped.toFixed(2)}倍`);
                console.log(`     誤差: 最適化 ${maxErrorOpt.toExponential(3)}, TypedArray ${maxErrorTyped.toExponential(3)}, WASM ${maxErrorWasm.toExponential(3)}`);
            }
        }
        
        // 総合評価
        console.log('\n🏆 === Ultimate Performance Results ===');
        
        // 各手法の平均パフォーマンス
        const avgSpeedupOpt = results.reduce((sum, r) => sum + r.speedupOpt, 0) / results.length;
        const avgSpeedupTyped = results.reduce((sum, r) => sum + r.speedupTyped, 0) / results.length;
        const avgSpeedupWasm = results.reduce((sum, r) => sum + r.speedupWasm, 0) / results.length;
        
        const avgWasmVsOpt = results.reduce((sum, r) => sum + r.wasmVsOpt, 0) / results.length;
        const avgWasmVsTyped = results.reduce((sum, r) => sum + r.wasmVsTyped, 0) / results.length;
        
        console.log(`📊 平均パフォーマンス比較（vs JavaScript標準）:`);
        console.log(`   JavaScript最適化: ${avgSpeedupOpt.toFixed(2)}倍`);
        console.log(`   TypedArray最適化: ${avgSpeedupTyped.toFixed(2)}倍`);
        console.log(`   WASM: ${avgSpeedupWasm.toFixed(2)}倍`);
        
        console.log(`🎯 WASM相対パフォーマンス:`);
        console.log(`   vs JavaScript最適化: ${avgWasmVsOpt.toFixed(2)}倍 ${avgWasmVsOpt > 1 ? '🏆 WASM勝利' : '📜 JS勝利'}`);
        console.log(`   vs TypedArray: ${avgWasmVsTyped.toFixed(2)}倍 ${avgWasmVsTyped > 1 ? '🏆 WASM勝利' : '🎯 TypedArray勝利'}`);
        
        // 推奨使用場面
        console.log(`\n💡 推奨使用場面:`);
        if (avgWasmVsOpt > 1.2) {
            console.log(`   🤖 WASM推奨: 大規模計算、ブラウザ間一貫性重視`);
        } else if (avgWasmVsOpt > 0.8) {
            console.log(`   ⚖️  JavaScript/WASM併用: 用途に応じて選択`);
        } else {
            console.log(`   📜 JavaScript推奨: 軽量計算、開発効率重視`);
        }
        
        if (avgSpeedupTyped > avgSpeedupWasm && avgSpeedupTyped > avgSpeedupOpt) {
            console.log(`   🎯 TypedArray: 最高効率バッチ処理に最適`);
        }
        
        return results;
    };
    
    console.log('🎯 直接比較ベンチマークモジュールが読み込まれました');
    console.log('   runDirectBenchmark() - 包括的ベンチマーク');
    console.log('   runRealWorldSimulation() - 実世界シミュレーション');
    console.log('   runWASMComparison() - WASM vs JavaScript究極比較');
}
