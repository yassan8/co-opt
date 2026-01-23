/**
 * WASM強制実行システム
 * WASMを確実に機能させるための専用実装
 */

class ForceWASMSystem {
    constructor() {
        this.wasmModule = null;
        this.isWASMReady = false;
        this.initializationPromise = null;
        this.performanceData = new Map();
    }

    _getRayTracingWasmCacheBustParam() {
        try {
            if (typeof document === 'undefined') return '';
            const scripts = Array.from(document.getElementsByTagName('script'));
            const tag = scripts.find(s => (s?.src || '').includes('ray-tracing-wasm-v3.js'));
            if (!tag?.src) return '';
            const url = new URL(tag.src, window.location?.href || undefined);
            return url.searchParams.get('v') || '';
        } catch (_) {
            return '';
        }
    }

    /**
     * WASM強制初期化
     */
    async forceInitializeWASM() {
        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        this.initializationPromise = this._performInitialization();
        return this.initializationPromise;
    }

    async _performInitialization() {
        try {
            // WASM V3モジュールの確認と初期化
            
            // RayTracingWASM関数が利用可能になるまで待機
            let attempts = 0;
            const maxAttempts = 100; // 10秒間待機
            
            while (typeof RayTracingWASM === 'undefined' && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            
            if (typeof RayTracingWASM === 'undefined') {
                throw new Error('WASM V3モジュール (RayTracingWASM) が読み込まれていません');
            }
            
            // WASMモジュールを初期化
            const cacheBust = this._getRayTracingWasmCacheBustParam();
            try {
                // Expose for debugging in DevTools.
                if (typeof window !== 'undefined') window.__rayTracingWasmCacheBust = cacheBust;
            } catch (_) {}
            const initOptions = {
                locateFile: (path, prefix) => {
                    const p = String(path || '');
                    const pre = String(prefix || '');
                    let out = pre + p;
                    // Important: bust cache for the actual .wasm binary as well.
                    if (cacheBust && p.endsWith('.wasm')) {
                        out += (out.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(cacheBust);
                    }
                    return out;
                }
            };
            this.wasmModule = await RayTracingWASM(initOptions);
            
            if (!this.wasmModule) {
                throw new Error('WASM V3モジュールの初期化に失敗');
            }
            
            console.log('✅ WASM V3モジュール初期化成功');
            
            // メモリ管理機能の確認
            if (typeof this.wasmModule._malloc === 'function' && typeof this.wasmModule._free === 'function') {
                console.log('✅ メモリ管理機能利用可能');
                this.memoryManagementAvailable = true;
            } else {
                console.warn('⚠️  メモリ管理機能なし - フォールバックモード');
                this.memoryManagementAvailable = false;
            }
            
            // 関数の存在確認
            // Keep backward compatibility: require legacy functions.
            // Extended functions (_aspheric_sag10/_batch_aspheric_sag10) are optional.
            const requiredFunctions = ['_aspheric_sag', '_batch_aspheric_sag'];
            for (const funcName of requiredFunctions) {
                if (typeof this.wasmModule[funcName] !== 'function') {
                    throw new Error(`WASM関数 ${funcName} が見つかりません`);
                }
            }

            this.isWASMReady = true;

            
            // 動作テスト
            await this.testWASMFunctionality();
            
            return true;

        } catch (error) {
            console.error('❌ WASM V3初期化失敗:', error.message);
            this.isWASMReady = false;
            throw error;
        }
    }

    /**
     * WASM機能テスト
     */
    async testWASMFunctionality() {
        
        try {
            // 基本的な計算テスト
            const testCases = [
                { r: 0, expected: 0 },
                { r: 1, c: 0.1, k: -0.5, a4: 1e-6 },
                { r: 5, c: 0.05, k: -1, a4: 1e-5, a6: 1e-8 }
            ];

            for (let i = 0; i < testCases.length; i++) {
                const test = testCases[i];
                const { r, c = 0.05, k = -0.5, a4 = 0, a6 = 0, a8 = 0, a10 = 0 } = test;
                
                const result = this.wasmModule._aspheric_sag(r, c, k, a4, a6, a8, a10);
                
                if (isNaN(result) || !isFinite(result)) {
                    throw new Error(`無効な結果: ${result} (r=${r})`);
                }
            }
            return true;

        } catch (error) {
            console.error('❌ WASM機能テスト失敗:', error.message);
            throw error;
        }
    }

    /**
     * WASM専用非球面SAG計算
     */
    wasmAsphericSag(r, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
        if (!this.isWASMReady) {
            throw new Error('WASM が初期化されていません');
        }

        try {
            return this.wasmModule._aspheric_sag(r, c, k, a4, a6, a8, a10);
        } catch (error) {
            throw new Error(`WASM計算エラー: ${error.message}`);
        }
    }

    wasmAsphericSag10(r, c, k,
        a4 = 0, a6 = 0, a8 = 0, a10 = 0,
        a12 = 0, a14 = 0, a16 = 0, a18 = 0, a20 = 0, a22 = 0) {
        if (!this.isWASMReady) {
            throw new Error('WASM が初期化されていません');
        }
        if (!this.wasmModule || typeof this.wasmModule._aspheric_sag10 !== 'function') {
            // Fallback to legacy if extended entrypoint is not available.
            return this.wasmAsphericSag(r, c, k, a4, a6, a8, a10) +
                (a12 * Math.pow(r, 12)) + (a14 * Math.pow(r, 14)) + (a16 * Math.pow(r, 16)) +
                (a18 * Math.pow(r, 18)) + (a20 * Math.pow(r, 20)) + (a22 * Math.pow(r, 22));
        }
        try {
            return this.wasmModule._aspheric_sag10(r, c, k, a4, a6, a8, a10, a12, a14, a16, a18, a20, a22);
        } catch (error) {
            throw new Error(`WASM計算エラー(aspheric_sag10): ${error.message}`);
        }
    }

    /**
     * 統一インターフェース - 非球面SAG計算
     */
    forceAsphericSag(r, c, k,
        a4 = 0, a6 = 0, a8 = 0, a10 = 0,
        a12 = 0, a14 = 0, a16 = 0, a18 = 0, a20 = 0, a22 = 0) {
        if (!this.isWASMReady) {
            // JavaScriptフォールバック
            if (r === 0) return 0;
            const r2 = r * r;
            const discriminant = 1 - (1 + k) * c * c * r2;
            if (discriminant <= 0) return 0;
            const basicSag = c * r2 / (1 + Math.sqrt(discriminant));
            const rr = r;
            const r4 = r2 * r2;
            const r6 = r4 * r2;
            const r8 = r4 * r4;
            const r10 = r8 * r2;
            const r12 = r6 * r6;
            const r14 = r12 * r2;
            const r16 = r8 * r8;
            const r18 = r16 * r2;
            const r20 = r10 * r10;
            const r22 = r20 * r2;
            return basicSag +
                (a4 * r4) + (a6 * r6) + (a8 * r8) + (a10 * r10) +
                (a12 * r12) + (a14 * r14) + (a16 * r16) + (a18 * r18) + (a20 * r20) + (a22 * r22);
        }

        // Prefer extended entrypoint if present.
        if (this.wasmModule && typeof this.wasmModule._aspheric_sag10 === 'function') {
            return this.wasmAsphericSag10(r, c, k, a4, a6, a8, a10, a12, a14, a16, a18, a20, a22);
        }

        // Legacy WASM entrypoint + JS add for higher orders.
        const base = this.wasmAsphericSag(r, c, k, a4, a6, a8, a10);
        return base +
            (a12 * Math.pow(r, 12)) + (a14 * Math.pow(r, 14)) + (a16 * Math.pow(r, 16)) +
            (a18 * Math.pow(r, 18)) + (a20 * Math.pow(r, 20)) + (a22 * Math.pow(r, 22));
    }

    /**
     * WASM強制バッチ処理 (V3 with memory management)
     */
    forceWASMBatch(radiusArray, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
        if (!this.isWASMReady) {
            throw new Error('WASM が初期化されていません');
        }

        console.log(`🔧 WASM V3バッチ処理: ${radiusArray.length.toLocaleString()}要素`);

        // メモリ管理機能が利用可能な場合は効率的なバッチ処理
        if (this.memoryManagementAvailable && radiusArray.length >= 1000) {
            return this.efficientBatchProcessing(radiusArray, c, k, a4, a6, a8, a10);
        }

        // フォールバック: 個別関数呼び出し
        const results = new Array(radiusArray.length);
        let successCount = 0;
        let errorCount = 0;

        for (let i = 0; i < radiusArray.length; i++) {
            try {
                results[i] = this.wasmModule._aspheric_sag(
                    radiusArray[i], c, k, a4, a6, a8, a10
                );
                successCount++;
            } catch (error) {
                console.warn(`WASM計算エラー at index ${i}: ${error.message}`);
                results[i] = 0; // フォールバック値
                errorCount++;
            }
        }

        console.log(`✅ WASM V3バッチ処理完了: ${successCount}成功, ${errorCount}エラー`);
        return results;
    }

    /**
     * 効率的バッチ処理 (メモリ管理機能使用)
     */
    efficientBatchProcessing(radiusArray, c, k, a4, a6 = 0, a8 = 0, a10 = 0) {
        const size = radiusArray.length;
        const inputSize = size * 8; // double precision
        const outputSize = size * 8;

        console.log(`🚀 効率的バッチ処理開始: ${size.toLocaleString()}要素 (${(inputSize/1024/1024).toFixed(1)}MB)`);

        let inputPtr = null;
        let outputPtr = null;

        try {
            // メモリ割り当て
            inputPtr = this.wasmModule._malloc(inputSize);
            outputPtr = this.wasmModule._malloc(outputSize);

            if (!inputPtr || !outputPtr) {
                throw new Error('メモリ割り当て失敗');
            }

            // 入力データをWASMメモリにコピー
            const inputHeap = new Float64Array(this.wasmModule.HEAPF64.buffer, inputPtr, size);
            for (let i = 0; i < size; i++) {
                inputHeap[i] = radiusArray[i];
            }

            // バッチ関数呼び出し
            const start = performance.now();
            this.wasmModule._batch_aspheric_sag(inputPtr, outputPtr, size, c, k, a4);
            const execTime = performance.now() - start;

            // 結果をJavaScript配列に変換
            const outputHeap = new Float64Array(this.wasmModule.HEAPF64.buffer, outputPtr, size);
            const results = Array.from(outputHeap);

            const throughput = size / execTime;
            console.log(`✅ 効率的バッチ処理完了: ${execTime.toFixed(2)}ms (${throughput.toFixed(0)} ops/ms)`);

            return results;

        } catch (error) {
            console.error('❌ 効率的バッチ処理エラー:', error.message);
            throw error;
        } finally {
            // メモリ解放
            if (inputPtr) this.wasmModule._free(inputPtr);
            if (outputPtr) this.wasmModule._free(outputPtr);
        }
    }

    /**
     * WASM性能強制測定
     */
    async forceWASMPerformanceTest() {
        if (!this.isWASMReady) {
            await this.forceInitializeWASM();
        }

        console.log('🎯 WASM性能強制測定開始...');
        console.log('   注意: これは純粋なWASM性能を測定します');

        const testSizes = [1000, 5000, 10000, 50000, 100000, 500000, 1000000];
        const results = [];

        for (const size of testSizes) {
            console.log(`\n📊 サイズ ${size.toLocaleString()} の WASM性能測定:`);
            
            // メモリ使用量確認（100万要素の場合）
            if (size >= 1000000) {
                const memoryMB = (size * 8) / (1024 * 1024); // 8 bytes per double
                console.log(`   📈 推定メモリ使用量: ${memoryMB.toFixed(1)}MB`);
            }

            // テストデータ準備
            const testRadii = Array.from({ length: size }, () => Math.random() * 10);
            const c = 0.05, k = -0.5, a4 = 1e-6, a6 = 1e-8;

            // ウォームアップ
            for (let i = 0; i < Math.min(100, size); i++) {
                this.wasmModule._aspheric_sag(testRadii[i], c, k, a4, a6, 0, 0);
            }

            // 実際の測定（複数回実行）
            const measurements = [];
            const iterations = size >= 1000000 ? 3 : (size >= 100000 ? 5 : 10); // 100万要素は3回測定

            for (let iter = 0; iter < iterations; iter++) {
                if (size >= 1000000) {
                    console.log(`     測定 ${iter + 1}/${iterations} 実行中... (100万要素)`);
                }
                
                const start = performance.now();
                
                for (let i = 0; i < size; i++) {
                    this.wasmModule._aspheric_sag(testRadii[i], c, k, a4, a6, 0, 0);
                }
                
                const execTime = performance.now() - start;
                measurements.push(execTime);
                
                if (size >= 1000000) {
                    console.log(`     測定 ${iter + 1} 完了: ${execTime.toFixed(2)}ms`);
                }
            }

            // 統計計算
            const avgTime = measurements.reduce((a, b) => a + b, 0) / measurements.length;
            const minTime = Math.min(...measurements);
            const maxTime = Math.max(...measurements);
            const throughput = size / avgTime;

            const result = {
                size,
                avgTime,
                minTime,
                maxTime,
                throughput,
                measurements
            };

            results.push(result);

            console.log(`   平均実行時間: ${avgTime.toFixed(2)}ms`);
            console.log(`   最速: ${minTime.toFixed(2)}ms`);
            console.log(`   最遅: ${maxTime.toFixed(2)}ms`);
            console.log(`   処理効率: ${throughput.toFixed(0)} ops/ms`);
            console.log(`   測定回数: ${iterations}回`);

            this.performanceData.set(size, result);
        }

        // 総合評価
        console.log('\n🚀 WASM性能総合評価:');
        const bestResult = results.reduce((best, current) => 
            current.throughput > best.throughput ? current : best
        );
        const avgThroughput = results.reduce((sum, r) => sum + r.throughput, 0) / results.length;

        console.log(`   最高性能: ${bestResult.throughput.toFixed(0)} ops/ms (サイズ: ${bestResult.size.toLocaleString()})`);
        console.log(`   平均性能: ${avgThroughput.toFixed(0)} ops/ms`);
        console.log(`   WASMの特性: ${bestResult.size >= 50000 ? '大規模データで最適' : '中規模データが最適'}`);

        // 実用性評価
        const practicalSizes = results.filter(r => r.size >= 10000 && r.size <= 100000);
        if (practicalSizes.length > 0) {
            const practicalAvg = practicalSizes.reduce((sum, r) => sum + r.throughput, 0) / practicalSizes.length;
            console.log(`   実用範囲性能: ${practicalAvg.toFixed(0)} ops/ms (1万〜10万要素)`);
        }

        return results;
    }

    /**
     * JavaScript vs WASM 直接比較
     */
    async directWASMComparison() {
        if (!this.isWASMReady) {
            await this.forceInitializeWASM();
        }

        console.log('🔬 JavaScript vs WASM 直接比較開始...');

        const testSize = 1000000; // 100万要素に増加
        const testRadii = Array.from({ length: testSize }, () => Math.random() * 10);
        const c = 0.05, k = -0.5, a4 = 1e-6;

        // JavaScript版実装
        const jsAsphericSag = (r, c, k, a4) => {
            if (r === 0) return 0;
            const r2 = r * r;
            const discriminant = 1 - (1 + k) * c * c * r2;
            if (discriminant <= 0) return 0;
            const basicSag = c * r2 / (1 + Math.sqrt(discriminant));
            return basicSag + a4 * Math.pow(r, 4);
        };

        // JavaScript測定
        console.log('📊 JavaScript版測定...');
        const jsStart = performance.now();
        const jsResults = testRadii.map(r => jsAsphericSag(r, c, k, a4));
        const jsTime = performance.now() - jsStart;

        // WASM測定（効率的な呼び出し方法）
        console.log('📊 WASM版測定（効率的バッチ処理）...');
        
        const wasmStart = performance.now();
        
        // 小さなバッチに分けて処理（オーバーヘッド削減）
        const batchSize = 10000;
        const wasmResults = new Array(testSize);
        
        for (let i = 0; i < testSize; i += batchSize) {
            const endIdx = Math.min(i + batchSize, testSize);
            
            // バッチ内を一括処理
            for (let j = i; j < endIdx; j++) {
                wasmResults[j] = this.wasmModule._aspheric_sag(testRadii[j], c, k, a4, 0, 0, 0);
            }
            
            // 進捗表示（大規模データの場合）
            if (testSize >= 100000 && (i + batchSize) % 100000 === 0) {
                const progress = Math.min(100, ((i + batchSize) / testSize) * 100);
                console.log(`     進捗: ${progress.toFixed(0)}% (${(i + batchSize).toLocaleString()}/${testSize.toLocaleString()})`);
            }
        }
        
        const wasmTime = performance.now() - wasmStart;

        // 参考：真のバッチ処理（batch_aspheric_sag使用を試行）
        console.log('📊 参考：ネイティブバッチ処理テスト...');
        try {
            // まず小さなサンプルでテスト
            const sampleSize = 1000;
            const sampleRadii = testRadii.slice(0, sampleSize);
            
            // JavaScriptの配列をWASMに直接渡せるか確認
            if (this.wasmModule._batch_aspheric_sag) {
                console.log('   batch_aspheric_sag関数が利用可能');
                // 注意：メモリ管理なしでの呼び出し - これは失敗する可能性が高い
            } else {
                console.log('   batch_aspheric_sag関数が見つかりません');
            }
        } catch (error) {
            console.log(`   ネイティブバッチ処理エラー: ${error.message}`);
        }

        // 精度比較
        let maxError = 0;
        for (let i = 0; i < Math.min(1000, testSize); i++) {
            const error = Math.abs(jsResults[i] - wasmResults[i]);
            maxError = Math.max(maxError, error);
        }

        // 結果表示
        const speedup = jsTime / wasmTime;
        console.log('\n📈 直接比較結果:');
        console.log(`   テストサイズ: ${testSize.toLocaleString()}要素`);
        console.log(`   計算内容: 非球面SAG計算 (c=${c}, k=${k}, a4=${a4})`);
        console.log(`   JavaScript: ${jsTime.toFixed(2)}ms (${(testSize/jsTime).toFixed(0)} ops/ms)`);
        console.log(`   WASM バッチ: ${wasmTime.toFixed(2)}ms (${(testSize/wasmTime).toFixed(0)} ops/ms)`);
        console.log(`   WASM高速化率: ${speedup.toFixed(2)}倍`);
        console.log(`   最大誤差: ${maxError.toExponential(3)}`);
        console.log(`   WASMの判定: ${speedup > 1 ? '✅ 高速' : '❌ 低速'}`);

        return {
            testSize,
            jsTime,
            wasmTime,
            speedup,
            maxError,
            jsResults: jsResults.slice(0, 5),
            wasmResults: wasmResults.slice(0, 5)
        };
    }

    /**
     * WASM最適化モード切替
     */
    async optimizeWASMMode() {
        console.log('🔧 WASM最適化モード設定...');

        // 最適化フラグの設定
        if (this.wasmModule && this.wasmModule._set_optimization_level) {
            try {
                this.wasmModule._set_optimization_level(2); // 最高最適化
                console.log('✅ WASM最適化レベル設定: 2');
            } catch (error) {
                console.warn('⚠️ WASM最適化レベル設定失敗');
            }
        }

        // メモリ最適化
        if (this.wasmModule && this.wasmModule._optimize_memory) {
            try {
                this.wasmModule._optimize_memory();
                console.log('✅ WASMメモリ最適化実行');
            } catch (error) {
                console.warn('⚠️ WASMメモリ最適化失敗');
            }
        }
    }

    /**
     * システム状態確認
     */
    getSystemStatus() {
        return {
            isWASMReady: this.isWASMReady,
            moduleLoaded: this.wasmModule !== null,
            availableFunctions: this.wasmModule ? 
                Object.keys(this.wasmModule).filter(k => k.startsWith('_')) : [],
            performanceDataCount: this.performanceData.size
        };
    }

    /**
     * Reusable pooled batch runner for aspheric_sag (minimizes malloc/free & copies)
     */
    createPooledBatchRunner() {
        if (!this.isWASMReady) {
            throw new Error('WASM が初期化されていません');
        }
        const mod = this.wasmModule;
        const state = { inPtr: 0, outPtr: 0, capacity: 0 };
        const ensureCapacity = (n) => {
            if (n <= state.capacity) return;
            if (state.inPtr) mod._free(state.inPtr);
            if (state.outPtr) mod._free(state.outPtr);
            const bytes = n * 8;
            state.inPtr = mod._malloc(bytes);
            state.outPtr = mod._malloc(bytes);
            if (!state.inPtr || !state.outPtr) throw new Error('メモリ割り当て失敗');
            state.capacity = n;
        };
        return (radiusArray, c, k, a4 = 0) => {
            const n = radiusArray.length;
            ensureCapacity(n);
            // zero-copy write using HEAPF64 view
            const inHeap = new Float64Array(mod.HEAPF64.buffer, state.inPtr, n);
            inHeap.set(radiusArray);
            mod.batchAsphericSagFast(state.inPtr, state.outPtr, n, c, k, a4);
            // zero-copy read via subarray + slice (copy out once)
            const outHeap = new Float64Array(mod.HEAPF64.buffer, state.outPtr, n);
            return outHeap.slice();
        };
    }
}

// グローバル関数
let forceWasmSystem = null;

async function initializeForceWASM() {
    if (!forceWasmSystem) {
        forceWasmSystem = new ForceWASMSystem();
        await forceWasmSystem.forceInitializeWASM();
    }
    return forceWasmSystem;
}

async function runForceWASMTest() {
    const system = await initializeForceWASM();
    return await system.forceWASMPerformanceTest();
}

async function runWASMDirectComparison() {
    const system = await initializeForceWASM();
    return await system.directWASMComparison();
}

function getWASMSystemStatus() {
    if (!forceWasmSystem) {
        return { status: 'not_initialized' };
    }
    return forceWasmSystem.getSystemStatus();
}

// モジュール公開
if (typeof window !== 'undefined') {
    window.initializeForceWASM = initializeForceWASM;
    window.runForceWASMTest = runForceWASMTest;
    window.runWASMDirectComparison = runWASMDirectComparison;
    window.getWASMSystemStatus = getWASMSystemStatus;
    window.ForceWASMSystem = ForceWASMSystem;
    
    const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
    if (RAYTRACE_DEBUG) {
        console.log('🚀 WASM強制実行システムが読み込まれました');
        console.log('   initializeForceWASM() - WASM強制初期化');
        console.log('   runForceWASMTest() - WASM性能強制測定');
        console.log('   runWASMDirectComparison() - JS vs WASM直接比較');
        console.log('   getWASMSystemStatus() - システム状態確認');
    }
}

// Browser環境用のexport
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ForceWASMSystem };
} else if (typeof window !== 'undefined') {
    window.ForceWASMSystem = ForceWASMSystem;
}

// ES Module export for browser import (only if in module context)
try {
    if (typeof document === 'undefined' || document.currentScript?.type === 'module') {
        // This will only work if the file is loaded as a module
        // Will be ignored in regular script context
        eval('export { ForceWASMSystem }');
    }
} catch (e) {
    // Ignore export errors in non-module context
    const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
    if (RAYTRACE_DEBUG) console.log('ForceWASMSystem: ES module export not available (normal for script tag loading)');
}
