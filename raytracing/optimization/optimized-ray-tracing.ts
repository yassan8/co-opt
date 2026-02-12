/**
 * asm.js スタイル高速化光線追跡モジュール
 * EmscriptenやWASMが利用できない環境での高速化代替実装
 * asm.jsの最適化ヒントを使用してJavaScriptエンジンの最適化を促進
 */

function createAsmJSRayTracing() {
    "use asm";
    
    // asm.js互換の高速化実装
    function asmAsphericSag(r, c, k, a4, a6, a8, a10) {
        r = +r;
        c = +c;
        k = +k;
        a4 = +a4;
        a6 = +a6;
        a8 = +a8;
        a10 = +a10;
        
        var r2 = 0.0;
        var cr2 = 0.0;
        var discriminant = 0.0;
        var basicSag = 0.0;
        var r4 = 0.0;
        var r6 = 0.0;
        var r8 = 0.0;
        var r10 = 0.0;
        var asphericalTerms = 0.0;
        
        if (r == 0.0) return 0.0;
        
        r2 = r * r;
        cr2 = c * r2;
        
        discriminant = 1.0 - (1.0 + k) * c * c * r2;
        if (discriminant <= 0.0) return 0.0;
        
        basicSag = cr2 / (1.0 + (+Math.sqrt(discriminant)));
        
        // 高次項計算
        r4 = r2 * r2;
        asphericalTerms = a4 * r4;
        
        if (a6 != 0.0 || a8 != 0.0 || a10 != 0.0) {
            r6 = r4 * r2;
            asphericalTerms = asphericalTerms + a6 * r6;
            
            if (a8 != 0.0 || a10 != 0.0) {
                r8 = r4 * r4;
                asphericalTerms = asphericalTerms + a8 * r8;
                
                if (a10 != 0.0) {
                    r10 = r8 * r2;
                    asphericalTerms = asphericalTerms + a10 * r10;
                }
            }
        }
        
        return basicSag + asphericalTerms;
    }
    
    function asmVectorDot(ax, ay, az, bx, by, bz) {
        ax = +ax; ay = +ay; az = +az;
        bx = +bx; by = +by; bz = +bz;
        
        return +(ax * bx + ay * by + az * bz);
    }
    
    function asmVectorLength(x, y, z) {
        x = +x; y = +y; z = +z;
        return +(+Math.sqrt(x * x + y * y + z * z));
    }
    
    return {
        asphericSag: asmAsphericSag,
        vectorDot: asmVectorDot,
        vectorLength: asmVectorLength
    };
}

/**
 * 型付き配列ベース高速計算クラス
 */
class TypedArrayOptimizer {
    constructor() {
        this.bufferSize = 10000;
        this.float64Buffer = new Float64Array(this.bufferSize * 4); // x,y,z,result
        this.vectorBuffer = new Float64Array(this.bufferSize * 3); // x,y,z
        this.resultBuffer = new Float64Array(this.bufferSize);
        
        // asm.jsモジュール
        this.asmModule = createAsmJSRayTracing();
        
        console.log('⚡ 型付き配列最適化モジュール初期化完了');
    }
    
    /**
     * バッチベクトル正規化（型付き配列版）
     */
    batchVectorNormalize(vectors) {
        const count = Math.min(vectors.length, this.bufferSize);
        const results = [];
        
        for (let batch = 0; batch < vectors.length; batch += count) {
            const batchSize = Math.min(count, vectors.length - batch);
            
            // データを型付き配列にコピー
            for (let i = 0; i < batchSize; i++) {
                const vector = vectors[batch + i];
                const idx = i * 3;
                this.vectorBuffer[idx] = vector.x || 0;
                this.vectorBuffer[idx + 1] = vector.y || 0;
                this.vectorBuffer[idx + 2] = vector.z || 0;
            }
            
            // バッチ処理
            for (let i = 0; i < batchSize; i++) {
                const idx = i * 3;
                const x = this.vectorBuffer[idx];
                const y = this.vectorBuffer[idx + 1];
                const z = this.vectorBuffer[idx + 2];
                
                const length = this.asmModule.vectorLength(x, y, z);
                
                if (length > 0) {
                    const invLength = 1 / length;
                    results.push({
                        x: x * invLength,
                        y: y * invLength,
                        z: z * invLength
                    });
                } else {
                    results.push({ x: 0, y: 0, z: 0 });
                }
            }
        }
        
        return results;
    }
    
    /**
     * バッチ非球面SAG計算（型付き配列版）
     */
    batchAsphericSag(radiusArray, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
        const results = new Float64Array(radiusArray.length);
        
        // 並列風処理（実際は順次処理だが、最適化されたループ）
        let i = 0;
        const length = radiusArray.length;
        
        // ループアンローリング（4つずつ処理）
        for (; i < length - 3; i += 4) {
            results[i] = this.asmModule.asphericSag(radiusArray[i], c, k, a4, a6, a8, a10);
            results[i + 1] = this.asmModule.asphericSag(radiusArray[i + 1], c, k, a4, a6, a8, a10);
            results[i + 2] = this.asmModule.asphericSag(radiusArray[i + 2], c, k, a4, a6, a8, a10);
            results[i + 3] = this.asmModule.asphericSag(radiusArray[i + 3], c, k, a4, a6, a8, a10);
        }
        
        // 残りの要素を処理
        for (; i < length; i++) {
            results[i] = this.asmModule.asphericSag(radiusArray[i], c, k, a4, a6, a8, a10);
        }
        
        return Array.from(results);
    }
    
    /**
     * バッチベクトル内積計算
     */
    batchVectorDot(vectorsA, vectorsB) {
        const count = Math.min(vectorsA.length, vectorsB.length);
        const results = new Float64Array(count);
        
        for (let i = 0; i < count; i++) {
            const a = vectorsA[i];
            const b = vectorsB[i];
            results[i] = this.asmModule.vectorDot(
                a.x || 0, a.y || 0, a.z || 0,
                b.x || 0, b.y || 0, b.z || 0
            );
        }
        
        return Array.from(results);
    }
}

/**
 * 統合型高速化光線追跡システム
 */
class OptimizedRayTracing {
    constructor() {
        this.wasmModule = null;
        this.typedArrayOptimizer = new TypedArrayOptimizer();
        this.isWASMAvailable = false;
        this.performanceStats = {
            wasmCalls: 0,
            asmCalls: 0,
            jsRayCalls: 0,
            totalTime: 0
        };
    }
    
    /**
     * 初期化
     */
    async initialize() {
        console.log('🚀 統合型光線追跡最適化システム初期化中...');
        
        try {
            // WASM利用を試行
            if (typeof initializeWASMRayTracing === 'function') {
                this.wasmModule = await initializeWASMRayTracing();
                this.isWASMAvailable = !this.wasmModule.fallbackMode;
            }
        } catch (error) {
            console.warn('⚠️ WASM初期化失敗:', error.message);
        }
        
        // パフォーマンステスト
        await this.benchmarkAllMethods();
        
        console.log('✅ 統合型光線追跡最適化システム初期化完了');
        console.log(`   WASM利用可能: ${this.isWASMAvailable ? '✅' : '❌'}`);
        console.log('   型付き配列最適化: ✅');
        console.log('   asm.js最適化: ✅');
    }
    
    /**
     * 最適な実装を自動選択して非球面SAG計算
     */
    optimizedAsphericSag(r, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
        const start = performance.now();
        
        let result;
        
        if (this.isWASMAvailable && this.wasmModule) {
            // WASM版を使用
            result = this.wasmModule.asphericSag(r, c, k, a4, a6, a8, a10);
            this.performanceStats.wasmCalls++;
        } else {
            // asm.js版を使用
            result = this.typedArrayOptimizer.asmModule.asphericSag(r, c, k, a4, a6, a8, a10);
            this.performanceStats.asmCalls++;
        }
        
        this.performanceStats.totalTime += performance.now() - start;
        return result;
    }
    
    /**
     * バッチ処理（配列）
     */
    batchAsphericSag(radiusArray, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
        if (this.isWASMAvailable && this.wasmModule && radiusArray.length > 1000) {
            return this.wasmModule.batchAsphericSag(radiusArray, c, k, a4, a6, a8, a10);
        } else {
            return this.typedArrayOptimizer.batchAsphericSag(radiusArray, c, k, a4, a6, a8, a10);
        }
    }
    
    /**
     * ベクトル演算
     */
    vectorDot(a, b) {
        if (this.isWASMAvailable && this.wasmModule) {
            return this.wasmModule.vectorDot(a.x, a.y, a.z, b.x, b.y, b.z);
        } else {
            return this.typedArrayOptimizer.asmModule.vectorDot(a.x, a.y, a.z, b.x, b.y, b.z);
        }
    }
    
    /**
     * 全実装のベンチマーク
     */
    async benchmarkAllMethods() {
        console.log('🧪 全実装ベンチマーク実行中...');
        
        const testSize = 5000;
        const testRadii = Array.from({ length: testSize }, () => Math.random() * 10);
        const c = 0.05, k = -0.5, a4 = 1e-6;
        
        // JavaScript標準版
        const jsStart = performance.now();
        const jsResults = testRadii.map(r => {
            if (r === 0) return 0;
            const r2 = r * r;
            const cr2 = c * r2;
            const discriminant = 1 - (1 + k) * c * c * r2;
            if (discriminant <= 0) return 0;
            const basicSag = cr2 / (1 + Math.sqrt(discriminant));
            return basicSag + a4 * r2 * r2;
        });
        const jsTime = performance.now() - jsStart;
        
        // asm.js版
        const asmStart = performance.now();
        const asmResults = this.typedArrayOptimizer.batchAsphericSag(testRadii, c, k, a4);
        const asmTime = performance.now() - asmStart;
        
        // WASM版（利用可能な場合）
        let wasmTime = 0;
        let wasmResults = [];
        if (this.isWASMAvailable && this.wasmModule) {
            const wasmStart = performance.now();
            wasmResults = this.wasmModule.batchAsphericSag(testRadii, c, k, a4);
            wasmTime = performance.now() - wasmStart;
        }
        
        // 結果比較
        const maxErrorAsm = Math.max(...jsResults.map((js, i) => Math.abs(js - asmResults[i])));
        const maxErrorWasm = wasmResults.length > 0 ? 
            Math.max(...jsResults.map((js, i) => Math.abs(js - wasmResults[i]))) : 0;
        
        console.log('📊 ベンチマーク結果:');
        console.log(`   JavaScript: ${jsTime.toFixed(2)}ms`);
        console.log(`   asm.js: ${asmTime.toFixed(2)}ms (${(jsTime / asmTime).toFixed(2)}倍高速)`);
        if (wasmTime > 0) {
            console.log(`   WASM: ${wasmTime.toFixed(2)}ms (${(jsTime / wasmTime).toFixed(2)}倍高速)`);
        }
        console.log(`   最大誤差 (asm.js): ${maxErrorAsm.toExponential(3)}`);
        if (maxErrorWasm > 0) {
            console.log(`   最大誤差 (WASM): ${maxErrorWasm.toExponential(3)}`);
        }
        
        return {
            jsTime, asmTime, wasmTime,
            asmSpeedup: jsTime / asmTime,
            wasmSpeedup: wasmTime > 0 ? jsTime / wasmTime : 0,
            maxErrorAsm, maxErrorWasm
        };
    }
    
    /**
     * 統計情報
     */
    getStats() {
        const totalCalls = this.performanceStats.wasmCalls + 
                          this.performanceStats.asmCalls + 
                          this.performanceStats.jsRayCalls;
        
        return {
            ...this.performanceStats,
            totalCalls,
            avgTimePerCall: totalCalls > 0 ? this.performanceStats.totalTime / totalCalls : 0,
            wasmUsageRate: totalCalls > 0 ? (this.performanceStats.wasmCalls / totalCalls * 100) : 0,
            asmUsageRate: totalCalls > 0 ? (this.performanceStats.asmCalls / totalCalls * 100) : 0
        };
    }
}

// グローバルインスタンス
let optimizedRayTracing = null;

/**
 * 統合型最適化システムを初期化
 */
async function initializeOptimizedRayTracing() {
    if (!optimizedRayTracing) {
        optimizedRayTracing = new OptimizedRayTracing();
        await optimizedRayTracing.initialize();
        
        // グローバル関数として公開
        window['optimizedAsphericSag'] = optimizedRayTracing.optimizedAsphericSag.bind(optimizedRayTracing);
        window['optimizedBatchAsphericSag'] = optimizedRayTracing.batchAsphericSag.bind(optimizedRayTracing);
        window['optimizedVectorDot'] = optimizedRayTracing.vectorDot.bind(optimizedRayTracing);
        window['getOptimizationStats'] = () => optimizedRayTracing.getStats();
        window['benchmarkOptimizations'] = () => optimizedRayTracing.benchmarkAllMethods();
    }
    
    return optimizedRayTracing;
}

/**
 * 統合最適化テスト
 */
async function testOptimizedRayTracing() {
    console.log('🧪 統合最適化テスト開始...');
    
    if (!optimizedRayTracing) {
        await initializeOptimizedRayTracing();
    }
    
    const benchmarkResults = await optimizedRayTracing.benchmarkAllMethods();
    const stats = optimizedRayTracing.getStats();
    
    console.log('📈 最適化効果:');
    if (benchmarkResults.asmSpeedup > 1) {
        console.log(`✅ asm.js版: ${benchmarkResults.asmSpeedup.toFixed(2)}倍高速化`);
    }
    if (benchmarkResults.wasmSpeedup > 1) {
        console.log(`✅ WASM版: ${benchmarkResults.wasmSpeedup.toFixed(2)}倍高速化`);
    }
    
    return { benchmarkResults, stats };
}

// グローバル公開
if (typeof window !== 'undefined') {
    window['initializeOptimizedRayTracing'] = initializeOptimizedRayTracing;
    window['testOptimizedRayTracing'] = testOptimizedRayTracing;
    window['OptimizedRayTracing'] = OptimizedRayTracing;
    window['TypedArrayOptimizer'] = TypedArrayOptimizer;
    
    const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
    if (RAYTRACE_DEBUG) {
        console.log('⚡ 統合型光線追跡最適化モジュールが読み込まれました');
        console.log('   初期化: initializeOptimizedRayTracing()');
        console.log('   テスト: testOptimizedRayTracing()');
    }
}
