// 🎯 実用的なWASM vs JavaScript ハイブリッド実装ガイド
// Based on Advanced WASM Benchmark Suite Results

/**
 * 最適化された非球面計算システム
 * 測定結果に基づく動的選択アルゴリズム
 */

class OptimalAsphericCalculator {
    constructor() {
        this.wasmSystem = null;
        this.performanceThresholds = {
            wasmMinSize: 10000,     // WASM有利になる最小サイズ
            batchMinSize: 50000,    // バッチ処理推奨サイズ
            callOverhead: 50,       // μs per call (測定平均値)
        };
        
        this.performanceStats = {
            totalCalculations: 0,
            wasmCalls: 0,
            jsCalls: 0,
            lastStrategy: 'js-standard',
            averageTime: 0
        };
        
        this.isInitialized = false;
    }
    
    async initialize() {
        if (this.isInitialized) return;
        
        // WASM system initialization
        try {
            if (typeof ForceWASMSystem !== 'undefined') {
                this.wasmSystem = new ForceWASMSystem();
                await this.wasmSystem.forceInitializeWASM();
                console.log('✅ Hybrid calculator: WASM system ready');
            } else {
                console.log('⚠️ Hybrid calculator: WASM not available, using JavaScript only');
            }
        } catch (error) {
            console.warn('⚠️ WASM initialization failed, fallback to JavaScript:', error.message);
        }
        
        this.isInitialized = true;
    }
    
    /**
     * 現在のアクティブ戦略を取得
     * @returns {string} 現在の戦略
     */
    getActiveStrategy() {
        return this.performanceStats.lastStrategy || 'js-standard';
    }
    
    /**
     * パフォーマンス統計を取得
     * @returns {Object} パフォーマンス統計
     */
    getPerformanceStats() {
        return {
            ...this.performanceStats,
            wasmAvailable: !!(this.wasmSystem && this.wasmSystem.isWASMReady),
            totalCalculations: this.performanceStats.totalCalculations,
            wasmRatio: this.performanceStats.totalCalculations > 0 ? 
                      this.performanceStats.wasmCalls / this.performanceStats.totalCalculations : 0
        };
    }
    
    /**
     * 非球面SAG計算（統合インターフェース）
     * @param {Array|number} radiusData - 半径データ
     * @param {number} k - コニック定数
     * @param {Array} coef - 非球面係数 [a4, a6, a8, a10]
     * @param {string} mode - 計算モード
     * @returns {Object} 計算結果 {values, strategy, time}
     */
    async calculateAsphericSag(radiusData, k, coef, mode = "even") {
        if (!this.isInitialized) {
            await this.initialize();
        }
        
        const isArray = Array.isArray(radiusData);
        const dataSize = isArray ? radiusData.length : 1;
        const data = isArray ? radiusData : [radiusData];
        
        // パラメータを内部形式に変換
        const params = {
            c: 0.05,  // デフォルト曲率
            k: k || 0,
            a4: coef[0] || 0,
            a6: coef[1] || 0,
            a8: coef[2] || 0,
            a10: coef[3] || 0
        };
        
        const startTime = performance.now();
        const strategy = this.selectOptimalStrategy(dataSize, { priority: 'balanced' });
        
        let result;
        try {
            result = this.calculateWithStrategy(data, params, strategy);
        } catch (error) {
            console.warn(`Strategy ${strategy} failed, falling back to JS standard:`, error.message);
            result = this.calculateJSStandard(data, params);
            strategy = 'js-standard';
        }
        
        const time = performance.now() - startTime;
        
        // 統計更新
        this.performanceStats.totalCalculations++;
        this.performanceStats.lastStrategy = strategy;
        this.performanceStats.averageTime = 
            (this.performanceStats.averageTime + time) / 2;
            
        if (strategy.startsWith('wasm')) {
            this.performanceStats.wasmCalls++;
        } else {
            this.performanceStats.jsCalls++;
        }
        
        return {
            values: isArray ? result : result[0],
            strategy: strategy,
            time: Math.round(time * 100) / 100
        };
    }
    
    /**
     * 指定された戦略で計算実行
     */
    calculateWithStrategy(data, params, strategy) {
        switch (strategy) {
            case 'wasm-batch':
                return this.calculateWASMBatch(data, params);
            case 'wasm-individual':
                return this.calculateWASMIndividual(data, params);
            case 'js-optimized':
                return this.calculateJSOptimized(data, params);
            default:
                return this.calculateJSStandard(data, params);
        }
    }
    
    /**
     * 最適化された非球面SAG計算（レガシーインターフェース）
     * @param {Array|number} radiusData - 単一値または配列
     * @param {Object} params - 光学パラメータ {c, k, a4, a6, a8, a10}
     * @param {Object} options - 計算オプション
     * @returns {number|Array} 計算結果
     */
    calculate(radiusData, params, options = {}) {
        const isArray = Array.isArray(radiusData);
        const dataSize = isArray ? radiusData.length : 1;
        const data = isArray ? radiusData : [radiusData];
        
        // 動的最適化選択
        const strategy = this.selectOptimalStrategy(dataSize, options);
        this.performanceStats.lastStrategy = strategy;
        
        console.log(`📊 Calculation strategy: ${strategy} (${dataSize} calculations)`);
        
        let result;
        try {
            result = this.calculateWithStrategy(data, params, strategy);
        } catch (error) {
            console.warn(`Strategy ${strategy} failed, falling back:`, error.message);
            result = this.calculateJSStandard(data, params);
        }
        
        return isArray ? result : result[0];
    }
    
    /**
     * 最適戦略選択アルゴリズム
     */
    selectOptimalStrategy(dataSize, options) {
        const { priority = 'balanced' } = options;
        
        // WASM利用不可の場合
        if (!this.wasmSystem || !this.wasmSystem.isWASMReady) {
            return dataSize > 50000 ? 'js-optimized' : 'js-standard';
        }
        
        // 優先度に基づく選択
        switch (priority) {
            case 'speed':
                // 速度優先: JavaScriptを優先
                return dataSize > 50000 ? 'wasm-individual' : 'js-optimized';
                
            case 'consistency':
                // 一貫性優先: WASMを優先
                return dataSize > 1000 ? 'wasm-individual' : 'js-standard';
                
            case 'balanced':
            default:
                // バランス重視: 測定結果に基づく最適選択
                if (dataSize >= this.performanceThresholds.batchMinSize) {
                    return 'wasm-batch';  // 大規模: バッチ処理
                } else if (dataSize >= this.performanceThresholds.wasmMinSize) {
                    return 'wasm-individual';  // 中規模: WASM個別
                } else {
                    return 'js-optimized';  // 小規模: JavaScript最適化
                }
        }
    }
    
    /**
     * WASM バッチ処理 (最高効率、要実装)
     */
    calculateWASMBatch(data, params) {
        // TODO: バッチ処理APIの実装
        if (this.wasmSystem.forceAsphericSagBatch) {
            return this.wasmSystem.forceAsphericSagBatch(data, params.c, params.k, params.a4, params.a6, params.a8, params.a10);
        } else {
            // フォールバック: 個別処理
            return this.calculateWASMIndividual(data, params);
        }
    }
    
    /**
     * WASM 個別処理 (一貫性重視)
     */
    calculateWASMIndividual(data, params) {
        return data.map(r => this.wasmSystem.forceAsphericSag(
            r, 
            params.c || 0, 
            params.k || 0, 
            params.a4 || 0, 
            params.a6 || 0, 
            params.a8 || 0, 
            params.a10 || 0
        ));
    }
    
    /**
     * JavaScript 最適化版 (速度重視)
     */
    calculateJSOptimized(data, params) {
        const { c, k, a4, a6, a8, a10 } = params;
        const c2 = c * c;
        
        // TypedArrayを使用した最適化
        const results = new Float64Array(data.length);
        
        for (let i = 0; i < data.length; i++) {
            const r = data[i];
            const r2 = r * r;
            const r4 = r2 * r2;
            
            // Horner法による多項式最適化
            const polynomial = r4 * (a4 + r2 * (a6 + r2 * (a8 + r2 * a10)));
            const curvature = c * r2;
            const conic = 1 + k * c2 * r2;
            
            if (conic > 0) {
                results[i] = curvature / (1 + Math.sqrt(conic)) + polynomial;
            } else {
                results[i] = curvature + polynomial;
            }
        }
        
        return Array.from(results);
    }
    
    /**
     * JavaScript 標準版 (シンプル)
     */
    calculateJSStandard(data, params) {
        const { c, k, a4, a6, a8, a10 } = params;
        
        return data.map(r => {
            const r2 = r * r;
            const curvature = c * r2;
            const conic = 1 + k * c * c * r2;
            const polynomial = (a4 || 0) * r2 * r2 + 
                              (a6 || 0) * r2 * r2 * r2 + 
                              (a8 || 0) * r2 * r2 * r2 * r2 + 
                              (a10 || 0) * r2 * r2 * r2 * r2 * r2;
            
            if (conic > 0) {
                return curvature / (1 + Math.sqrt(conic)) + polynomial;
            } else {
                return curvature + polynomial;
            }
        });
    }
    
    /**
     * パフォーマンステスト機能
     */
    async benchmarkStrategies(testSize = 10000) {
        const testData = Array.from({length: testSize}, (_, i) => 0.1 + i / testSize * 4.9);
        const params = { c: 0.05, k: -0.5, a4: 1e-6 };
        
        const results = {};
        
        // 各戦略の測定
        const strategies = ['js-standard', 'js-optimized', 'wasm-individual'];
        
        for (const strategy of strategies) {
            if (strategy.startsWith('wasm') && (!this.wasmSystem || !this.wasmSystem.isWASMReady)) {
                continue;
            }
            
            const start = performance.now();
            const result = this.calculate(testData, params, { strategy });
            const time = performance.now() - start;
            
            results[strategy] = {
                time: time,
                speed: testSize / time * 1000,
                accuracy: this.verifyAccuracy(result, testData, params)
            };
        }
        
        return results;
    }
    
    /**
     * 精度検証
     */
    verifyAccuracy(results, testData, params) {
        const reference = this.calculateJSStandard(testData, params);
        const maxError = Math.max(...results.map((r, i) => Math.abs(r - reference[i])));
        return maxError;
    }
}

// 使用例
async function demonstrateOptimalCalculator() {
    const calculator = new OptimalAsphericCalculator();
    await calculator.initialize();
    
    // 小規模計算 (JavaScript有利)
    const smallData = [1, 2, 3, 4, 5];
    const smallResult = calculator.calculate(smallData, { c: 0.05, k: -0.5, a4: 1e-6 });
    console.log('Small calculation result:', smallResult);
    
    // 大規模計算 (WASM有利の可能性)
    const largeData = Array.from({length: 50000}, (_, i) => i * 0.0001);
    const largeResult = calculator.calculate(largeData, { c: 0.05, k: -0.5, a4: 1e-6 }, { priority: 'consistency' });
    console.log('Large calculation completed, size:', largeResult.length);
    
    // パフォーマンス比較
    const benchmark = await calculator.benchmarkStrategies(10000);
    console.table(benchmark);
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = OptimalAsphericCalculator;
} else if (typeof window !== 'undefined') {
    window.OptimalAsphericCalculator = OptimalAsphericCalculator;
    window.demonstrateOptimalCalculator = demonstrateOptimalCalculator;
}

console.log('🎯 Optimal Aspheric Calculator loaded');
console.log('   Use: demonstrateOptimalCalculator() for demo');
console.log('   Create: new OptimalAsphericCalculator() for usage');
