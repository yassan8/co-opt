/**
 * WebAssembly光線追跡最適化モジュール
 * ray-tracing-wasm.cをコンパイルして生成されるWASMモジュールのJavaScriptラッパー
 * 
 * 使用方法:
 * 1. Emscriptenでray-tracing-wasm.cをコンパイル
 * 2. 生成されたray-tracing-wasm.jsとray-tracing-wasm.wasmを配置
 * 3. このモジュールを読み込んで使用
 */

class WASMRayTracing {
    constructor() {
        this.wasmModule = null;
        this.isInitialized = false;
        this.fallbackMode = false;
        
        // メモリプール（WASM用）
        this.vectorBufferSize = 10000;
        this.vectorBuffer = null;
        this.resultBuffer = null;
        
        // パフォーマンス統計
        this.stats = {
            wasmCallsCount: 0,
            fallbackCallsCount: 0,
            totalWasmTime: 0,
            totalFallbackTime: 0
        };
    }
    
    /**
     * WASMモジュールを初期化
     */
    async initialize() {
        try {
            console.log('🚀 WASM光線追跡モジュールを初期化中...');
            
            // WASMモジュールの読み込みを試行
            if (typeof Module !== 'undefined') {
                this.wasmModule = Module;
            } else {
                // 動的にWASMモジュールを読み込み
                await this.loadWASMModule();
            }
            
            if (this.wasmModule) {
                // WASMメモリバッファの初期化
                this.initializeMemoryBuffers();
                
                // WASM関数のラップ
                this.wrapWASMFunctions();
                
                this.isInitialized = true;
                console.log('✅ WASM光線追跡モジュール初期化完了');
                console.log('   利用可能な関数:', Object.keys(this.wasmFunctions));
                
                // パフォーマンステスト
                await this.performanceTest();
                
            } else {
                throw new Error('WASMモジュールの読み込みに失敗');
            }
            
        } catch (error) {
            console.warn('⚠️ WASM初期化に失敗、フォールバックモードで動作:', error.message);
            this.fallbackMode = true;
            this.initializeFallbackMode();
        }
    }
    
    /**
     * WASMモジュールを動的に読み込み
     */
    async loadWASMModule() {
        return new Promise((resolve, reject) => {
            // WASMファイルが存在する場合の読み込み処理
            const script = document.createElement('script');
            script.src = 'ray-tracing-wasm.js';
            script.onload = () => {
                if (typeof Module !== 'undefined') {
                    Module.onRuntimeInitialized = () => {
                        this.wasmModule = Module;
                        resolve();
                    };
                } else {
                    reject(new Error('WASMモジュールが見つかりません'));
                }
            };
            script.onerror = () => {
                reject(new Error('WASMスクリプトの読み込みに失敗'));
            };
            document.head.appendChild(script);
        });
    }
    
    /**
     * WASMメモリバッファを初期化
     */
    initializeMemoryBuffers() {
        const vectorByteSize = this.vectorBufferSize * 3 * 8; // double * 3 * count
        
        this.vectorBuffer = this.wasmModule._malloc(vectorByteSize);
        this.resultBuffer = this.wasmModule._malloc(vectorByteSize);
        
        console.log(`📦 WASMメモリバッファを初期化: ${this.vectorBufferSize}個のベクトル用`);
    }
    
    /**
     * WASM関数をラップ
     */
    wrapWASMFunctions() {
        this.wasmFunctions = {
            asphericSag: this.wasmModule.cwrap('aspheric_sag', 'number', 
                ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
            vectorDot: this.wasmModule.cwrap('vector_dot', 'number', 
                ['number', 'number', 'number', 'number', 'number', 'number']),
            vectorCross: this.wasmModule.cwrap('vector_cross', null,
                ['number', 'number', 'number', 'number', 'number', 'number', 'number']),
            vectorNormalize: this.wasmModule.cwrap('vector_normalize', null,
                ['number', 'number', 'number', 'number']),
            raySphereIntersect: this.wasmModule.cwrap('ray_sphere_intersect', 'number',
                ['number', 'number', 'number', 'number', 'number', 'number', 
                 'number', 'number', 'number', 'number']),
            batchVectorNormalize: this.wasmModule.cwrap('batch_vector_normalize', null,
                ['number', 'number', 'number']),
            batchAsphericSag: this.wasmModule.cwrap('batch_aspheric_sag', null,
                ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'])
        };
    }
    
    /**
     * フォールバックモード初期化
     */
    initializeFallbackMode() {
        // JavaScript版の高速化実装
        this.wasmFunctions = {
            asphericSag: this.fallbackAsphericSag.bind(this),
            vectorDot: this.fallbackVectorDot.bind(this),
            vectorCross: this.fallbackVectorCross.bind(this),
            vectorNormalize: this.fallbackVectorNormalize.bind(this),
            raySphereIntersect: this.fallbackRaySphereIntersect.bind(this),
            batchVectorNormalize: this.fallbackBatchVectorNormalize.bind(this),
            batchAsphericSag: this.fallbackBatchAsphericSag.bind(this)
        };
        
        console.log('📋 フォールバックモードで初期化完了');
    }
    
    /**
     * 高性能非球面SAG計算
     */
    asphericSag(r, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
        const start = performance.now();
        
        let result;
        if (!this.fallbackMode && this.isInitialized) {
            result = this.wasmFunctions.asphericSag(r, c, k, a4, a6, a8, a10);
            this.stats.wasmCallsCount++;
            this.stats.totalWasmTime += performance.now() - start;
        } else {
            result = this.fallbackAsphericSag(r, c, k, a4, a6, a8, a10);
            this.stats.fallbackCallsCount++;
            this.stats.totalFallbackTime += performance.now() - start;
        }
        
        return result;
    }
    
    /**
     * フォールバック版非球面SAG計算
     */
    fallbackAsphericSag(r, c, k, a4, a6, a8, a10) {
        if (r === 0) return 0;
        
        const r2 = r * r;
        const cr2 = c * r2;
        
        // 基本二次曲面
        const discriminant = 1 - (1 + k) * c * c * r2;
        if (discriminant <= 0) return 0;
        
        const basicSag = cr2 / (1 + Math.sqrt(discriminant));
        
        // 高次非球面項（最適化済み）
        if (a4 === 0 && a6 === 0 && a8 === 0 && a10 === 0) {
            return basicSag;
        }
        
        const r4 = r2 * r2;
        let asphericalTerms = a4 * r4;
        
        if (a6 !== 0 || a8 !== 0 || a10 !== 0) {
            const r6 = r4 * r2;
            asphericalTerms += a6 * r6;
            
            if (a8 !== 0 || a10 !== 0) {
                const r8 = r4 * r4;
                asphericalTerms += a8 * r8;
                
                if (a10 !== 0) {
                    const r10 = r8 * r2;
                    asphericalTerms += a10 * r10;
                }
            }
        }
        
        return basicSag + asphericalTerms;
    }
    
    /**
     * ベクトル内積計算
     */
    vectorDot(ax, ay, az, bx, by, bz) {
        if (!this.fallbackMode && this.isInitialized) {
            this.stats.wasmCallsCount++;
            return this.wasmFunctions.vectorDot(ax, ay, az, bx, by, bz);
        } else {
            this.stats.fallbackCallsCount++;
            return this.fallbackVectorDot(ax, ay, az, bx, by, bz);
        }
    }
    
    fallbackVectorDot(ax, ay, az, bx, by, bz) {
        return ax * bx + ay * by + az * bz;
    }
    
    /**
     * ベクトル外積計算
     */
    vectorCross(ax, ay, az, bx, by, bz) {
        if (!this.fallbackMode && this.isInitialized) {
            this.stats.wasmCallsCount++;
            const resultPtr = this.wasmModule._malloc(3 * 8);
            this.wasmFunctions.vectorCross(ax, ay, az, bx, by, bz, resultPtr);
            
            const result = {
                x: this.wasmModule.HEAPF64[resultPtr / 8],
                y: this.wasmModule.HEAPF64[resultPtr / 8 + 1],
                z: this.wasmModule.HEAPF64[resultPtr / 8 + 2]
            };
            
            this.wasmModule._free(resultPtr);
            return result;
        } else {
            this.stats.fallbackCallsCount++;
            return this.fallbackVectorCross(ax, ay, az, bx, by, bz);
        }
    }
    
    fallbackVectorCross(ax, ay, az, bx, by, bz) {
        return {
            x: ay * bz - az * by,
            y: az * bx - ax * bz,
            z: ax * by - ay * bx
        };
    }
    
    /**
     * ベクトル正規化
     */
    vectorNormalize(x, y, z) {
        if (!this.fallbackMode && this.isInitialized) {
            this.stats.wasmCallsCount++;
            const resultPtr = this.wasmModule._malloc(3 * 8);
            this.wasmFunctions.vectorNormalize(x, y, z, resultPtr);
            
            const result = {
                x: this.wasmModule.HEAPF64[resultPtr / 8],
                y: this.wasmModule.HEAPF64[resultPtr / 8 + 1],
                z: this.wasmModule.HEAPF64[resultPtr / 8 + 2]
            };
            
            this.wasmModule._free(resultPtr);
            return result;
        } else {
            this.stats.fallbackCallsCount++;
            return this.fallbackVectorNormalize(x, y, z);
        }
    }
    
    fallbackVectorNormalize(x, y, z) {
        const length = Math.sqrt(x * x + y * y + z * z);
        if (length === 0) return { x: 0, y: 0, z: 0 };
        
        const invLength = 1 / length;
        return {
            x: x * invLength,
            y: y * invLength,
            z: z * invLength
        };
    }
    
    /**
     * バッチ非球面SAG計算（配列処理）
     */
    batchAsphericSag(radiusArray, c, k, a4 = 0, a6 = 0, a8 = 0, a10 = 0) {
        if (!this.fallbackMode && this.isInitialized && radiusArray.length > 100) {
            // 大量データの場合はWASMを使用
            this.stats.wasmCallsCount++;
            
            const count = radiusArray.length;
            const inputPtr = this.wasmModule._malloc(count * 8);
            const outputPtr = this.wasmModule._malloc(count * 8);
            
            // データをWASMメモリにコピー
            const inputArray = new Float64Array(this.wasmModule.HEAPF64.buffer, inputPtr, count);
            inputArray.set(radiusArray);
            
            // WASM関数を呼び出し
            this.wasmFunctions.batchAsphericSag(inputPtr, count, c, k, a4, a6, a8, a10, outputPtr);
            
            // 結果を取得
            const outputArray = new Float64Array(this.wasmModule.HEAPF64.buffer, outputPtr, count);
            const result = Array.from(outputArray);
            
            // メモリを解放
            this.wasmModule._free(inputPtr);
            this.wasmModule._free(outputPtr);
            
            return result;
        } else {
            // 少量データまたはフォールバックモード
            this.stats.fallbackCallsCount++;
            return this.fallbackBatchAsphericSag(radiusArray, c, k, a4, a6, a8, a10);
        }
    }
    
    fallbackBatchAsphericSag(radiusArray, c, k, a4, a6, a8, a10) {
        return radiusArray.map(r => this.fallbackAsphericSag(r, c, k, a4, a6, a8, a10));
    }
    
    /**
     * パフォーマンステスト
     */
    async performanceTest() {
        console.log('🧪 WASM vs JavaScript パフォーマンステスト実行中...');
        
        const testSize = 10000;
        const testRadii = Array.from({ length: testSize }, () => Math.random() * 10);
        const c = 0.05;
        const k = -0.5;
        const a4 = 1e-6;
        
        // JavaScript版テスト
        const jsStart = performance.now();
        const jsResults = testRadii.map(r => this.fallbackAsphericSag(r, c, k, a4));
        const jsTime = performance.now() - jsStart;
        
        // WASM版テスト
        let wasmTime = 0;
        let wasmResults = [];
        
        if (!this.fallbackMode) {
            const wasmStart = performance.now();
            wasmResults = this.batchAsphericSag(testRadii, c, k, a4);
            wasmTime = performance.now() - wasmStart;
        }
        
        // 結果比較
        let maxError = 0;
        if (wasmResults.length > 0) {
            maxError = Math.max(...jsResults.map((js, i) => 
                Math.abs(js - wasmResults[i])
            ));
        }
        
        const speedup = wasmTime > 0 ? jsTime / wasmTime : 'N/A';
        
        console.log('📊 パフォーマンステスト結果:');
        console.log(`   JavaScript: ${jsTime.toFixed(2)}ms`);
        console.log(`   WASM: ${wasmTime.toFixed(2)}ms`);
        console.log(`   高速化倍率: ${typeof speedup === 'number' ? speedup.toFixed(2) + '倍' : speedup}`);
        console.log(`   最大誤差: ${maxError.toExponential(3)}`);
        
        return { jsTime, wasmTime, speedup, maxError };
    }
    
    /**
     * 統計情報の取得
     */
    getStats() {
        const totalCalls = this.stats.wasmCallsCount + this.stats.fallbackCallsCount;
        const avgWasmTime = this.stats.wasmCallsCount > 0 ? 
            this.stats.totalWasmTime / this.stats.wasmCallsCount : 0;
        const avgFallbackTime = this.stats.fallbackCallsCount > 0 ? 
            this.stats.totalFallbackTime / this.stats.fallbackCallsCount : 0;
        
        return {
            ...this.stats,
            totalCalls,
            avgWasmTime,
            avgFallbackTime,
            wasmUsageRate: totalCalls > 0 ? (this.stats.wasmCallsCount / totalCalls * 100) : 0
        };
    }
    
    /**
     * リソースのクリーンアップ
     */
    cleanup() {
        if (this.vectorBuffer) {
            this.wasmModule._free(this.vectorBuffer);
            this.vectorBuffer = null;
        }
        if (this.resultBuffer) {
            this.wasmModule._free(this.resultBuffer);
            this.resultBuffer = null;
        }
        console.log('🧹 WASMリソースをクリーンアップしました');
    }
}

// グローバルインスタンス
let wasmRayTracing = null;

/**
 * WASM光線追跡システムを初期化
 */
async function initializeWASMRayTracing() {
    if (!wasmRayTracing) {
        wasmRayTracing = new WASMRayTracing();
        await wasmRayTracing.initialize();
        
        // グローバル関数として公開
        window.wasmAsphericSag = wasmRayTracing.asphericSag.bind(wasmRayTracing);
        window.wasmVectorDot = wasmRayTracing.vectorDot.bind(wasmRayTracing);
        window.wasmVectorCross = wasmRayTracing.vectorCross.bind(wasmRayTracing);
        window.wasmVectorNormalize = wasmRayTracing.vectorNormalize.bind(wasmRayTracing);
        window.wasmBatchAsphericSag = wasmRayTracing.batchAsphericSag.bind(wasmRayTracing);
        
        // WASMステータス確認関数
        window.getWASMStats = () => wasmRayTracing.getStats();
        window.isWASMEnabled = () => wasmRayTracing && !wasmRayTracing.fallbackMode;
    }
    
    return wasmRayTracing;
}

/**
 * WASM光線追跡パフォーマンステスト
 */
async function testWASMPerformance() {
    console.log('🚀 WASM光線追跡パフォーマンステスト開始...');
    
    if (!wasmRayTracing) {
        await initializeWASMRayTracing();
    }
    
    const results = await wasmRayTracing.performanceTest();
    const stats = wasmRayTracing.getStats();
    
    console.log('📈 使用統計:');
    console.log(`   WASM呼び出し: ${stats.wasmCallsCount}回`);
    console.log(`   フォールバック呼び出し: ${stats.fallbackCallsCount}回`);
    console.log(`   WASM使用率: ${stats.wasmUsageRate.toFixed(1)}%`);
    
    return { results, stats };
}

// モジュールの自動初期化
if (typeof window !== 'undefined') {
    // ブラウザ環境
    window.initializeWASMRayTracing = initializeWASMRayTracing;
    window.testWASMPerformance = testWASMPerformance;
    window.WASMRayTracing = WASMRayTracing;
    
    console.log('🔧 WASM光線追跡モジュールが読み込まれました');
    console.log('   初期化: initializeWASMRayTracing()');
    console.log('   テスト: testWASMPerformance()');
}

// Node.js環境での対応
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { WASMRayTracing, initializeWASMRayTracing, testWASMPerformance };
}
