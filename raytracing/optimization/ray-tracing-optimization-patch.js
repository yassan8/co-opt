/**
 * ray-tracing.js統合最適化パッチ
 * 既存のray-tracing.jsにWASM/asm.js最適化を統合するためのパッチモジュール
 */

class RayTracingOptimizationPatch {
    constructor() {
        this.optimizedSystem = null;
        this.isInitialized = false;
        this.originalFunctions = {};
        this.fallbackMode = false;
        this.performanceGain = 1.0;
    }

    /**
     * 最適化システムを初期化
     */
    async initialize() {
        if (this.isInitialized) return;

        const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
        if (RAYTRACE_DEBUG) console.log('🚀 ray-tracing.js最適化パッチ初期化中...');
        
        try {
            // 統合最適化システムを初期化
            if (typeof initializeOptimizedRayTracing === 'function') {
                this.optimizedSystem = await initializeOptimizedRayTracing();
                
                // パフォーマンステストで実際の効果を測定
                const testResult = await this.benchmarkIntegration();
                this.performanceGain = testResult.speedup;
                
                if (this.performanceGain > 1.2) { // 20%以上の改善がある場合のみ適用
                    this.patchRayTracingFunctions();
                    if (RAYTRACE_DEBUG) console.log(`✅ ray-tracing.js最適化適用完了 (${this.performanceGain.toFixed(2)}倍高速化)`);
                } else {
                    if (RAYTRACE_DEBUG) console.log('ℹ️ 最適化効果が限定的なため、既存実装を維持');
                    this.fallbackMode = true;
                }
            } else {
                throw new Error('統合最適化システムが利用できません');
            }
        } catch (error) {
            if (RAYTRACE_DEBUG) {
                console.warn(`⚠️ ray-tracing.js最適化初期化失敗: ${error.message}`);
                console.log('📋 フォールバックモードで動作');
            }
            this.fallbackMode = true;
        }
        
        this.isInitialized = true;
    }

    /**
     * 統合ベンチマーク
     */
    async benchmarkIntegration() {
        const testCount = 1000;
        const testParams = {
            radius: 100,
            conic: -0.5,
            coef1: 1e-6,
            coef2: 1e-8,
            coef3: 1e-10
        };
        
        // 元の関数でのテスト
        let originalTime = 0;
        if (typeof window.asphericSag === 'function') {
            const start = performance.now();
            for (let i = 0; i < testCount; i++) {
                const r = Math.random() * 10;
                window.asphericSag(r, testParams, "even");
            }
            originalTime = performance.now() - start;
        }
        
        // 最適化版でのテスト
        let optimizedTime = 0;
        if (this.optimizedSystem && this.optimizedSystem.optimizedAsphericSag) {
            const start = performance.now();
            for (let i = 0; i < testCount; i++) {
                const r = Math.random() * 10;
                // パラメータを統合最適化システム用に変換
                this.optimizedSystem.optimizedAsphericSag(
                    r,
                    testParams.radius ? 1/testParams.radius : 0,
                    testParams.conic || 0,
                    testParams.coef1 || 0,
                    testParams.coef2 || 0,
                    testParams.coef3 || 0,
                    testParams.coef4 || 0
                );
            }
            optimizedTime = performance.now() - start;
        }
        
        const speedup = originalTime > 0 && optimizedTime > 0 ? originalTime / optimizedTime : 1.0;
        
        console.log(`📊 統合ベンチマーク結果:`);
        console.log(`   元の実装: ${originalTime.toFixed(2)}ms`);
        console.log(`   最適化版: ${optimizedTime.toFixed(2)}ms`);
        console.log(`   高速化率: ${speedup.toFixed(2)}倍`);
        
        return { originalTime, optimizedTime, speedup };
    }

    /**
     * ray-tracing.js関数をパッチ
     */
    patchRayTracingFunctions() {
        // 元のasphericSag関数をバックアップ
        if (typeof window.asphericSag === 'function') {
            this.originalFunctions.asphericSag = window.asphericSag;
        }

        // 最適化版asphericSag関数を作成
        const self = this;
        window.asphericSag = function(r, params, mode = "even") {
            try {
                if (!self.fallbackMode && self.optimizedSystem) {
                    // パラメータ変換
                    const curvature = params.radius ? 1/params.radius : 0;
                    const conic = params.conic || 0;
                    const a4 = params.coef1 || 0;
                    const a6 = params.coef2 || 0;
                    const a8 = params.coef3 || 0;
                    const a10 = params.coef4 || 0;
                    
                    return self.optimizedSystem.optimizedAsphericSag(r, curvature, conic, a4, a6, a8, a10);
                } else {
                    // フォールバック: 元の実装を呼び出し
                    return self.originalFunctions.asphericSag ? 
                           self.originalFunctions.asphericSag(r, params, mode) : 
                           self.fallbackAsphericSag(r, params, mode);
                }
            } catch (error) {
                console.warn(`⚠️ 最適化asphericSag実行エラー: ${error.message}`);
                return self.originalFunctions.asphericSag ? 
                       self.originalFunctions.asphericSag(r, params, mode) : 
                       self.fallbackAsphericSag(r, params, mode);
            }
        };

        // ベクトル演算の最適化（可能であれば）
        if (this.optimizedSystem && this.optimizedSystem.vectorDot) {
            if (typeof window.dot === 'function') {
                this.originalFunctions.dot = window.dot;
                
                window.dot = function(a, b) {
                    try {
                        if (!self.fallbackMode && a && b && 
                            typeof a.x === 'number' && typeof a.y === 'number' && typeof a.z === 'number' &&
                            typeof b.x === 'number' && typeof b.y === 'number' && typeof b.z === 'number') {
                            return self.optimizedSystem.vectorDot(a, b);
                        } else {
                            return self.originalFunctions.dot(a, b);
                        }
                    } catch (error) {
                        return self.originalFunctions.dot(a, b);
                    }
                };
            }
        }

        console.log('🔧 ray-tracing.js関数パッチ適用完了');
    }

    /**
     * フォールバック用asphericSag実装
     */
    fallbackAsphericSag(r, params, mode = "even") {
        const { radius, conic = 0, coef1 = 0, coef2 = 0, coef3 = 0, coef4 = 0 } = params;
        if (!isFinite(radius) || radius === 0) return 0;
        
        const r2 = r * r;
        const sqrtTerm = 1 - (1 + conic) * r2 / (radius * radius);
        if (!isFinite(sqrtTerm) || sqrtTerm < 0) return 0;
        
        const base = r2 / (radius * (1 + Math.sqrt(sqrtTerm)));
        const coefs = [coef1, coef2, coef3, coef4];
        
        let asphere = 0;
        let r_power = r2;
        for (let i = 0; i < coefs.length; i++) {
            if (coefs[i] !== 0) {
                asphere += coefs[i] * r_power;
            }
            r_power *= r2;
        }
        
        return base + asphere;
    }

    /**
     * パッチを元に戻す
     */
    unpatch() {
        if (this.originalFunctions.asphericSag) {
            window.asphericSag = this.originalFunctions.asphericSag;
        }
        if (this.originalFunctions.dot) {
            window.dot = this.originalFunctions.dot;
        }
        console.log('🔄 ray-tracing.js関数パッチを除去');
    }

    /**
     * 統計情報を取得
     */
    getStats() {
        const baseStats = {
            isInitialized: this.isInitialized,
            fallbackMode: this.fallbackMode,
            performanceGain: this.performanceGain,
            patchedFunctions: Object.keys(this.originalFunctions)
        };

        if (this.optimizedSystem) {
            return {
                ...baseStats,
                optimizationStats: this.optimizedSystem.getStats()
            };
        }

        return baseStats;
    }
}

// グローバルインスタンス
let rayTracingOptimizationPatch = null;

/**
 * ray-tracing.js最適化パッチを初期化
 */
async function initializeRayTracingOptimization() {
    if (!rayTracingOptimizationPatch) {
        rayTracingOptimizationPatch = new RayTracingOptimizationPatch();
        await rayTracingOptimizationPatch.initialize();
    }
    return rayTracingOptimizationPatch;
}

/**
 * ray-tracing.js最適化パッチを適用
 */
async function applyRayTracingOptimization() {
    const patch = await initializeRayTracingOptimization();
    return patch;
}

/**
 * ray-tracing.js最適化統計を取得
 */
function getRayTracingOptimizationStats() {
    return rayTracingOptimizationPatch ? rayTracingOptimizationPatch.getStats() : null;
}

// モジュール公開
if (typeof window !== 'undefined') {
    window.initializeRayTracingOptimization = initializeRayTracingOptimization;
    window.applyRayTracingOptimization = applyRayTracingOptimization;
    window.getRayTracingOptimizationStats = getRayTracingOptimizationStats;
    window.RayTracingOptimizationPatch = RayTracingOptimizationPatch;
    
    const RAYTRACE_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__RAYTRACE_DEBUG);
    if (RAYTRACE_DEBUG) console.log('⚡ ray-tracing.js最適化パッチモジュールが読み込まれました');
}
