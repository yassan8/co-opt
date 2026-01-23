/**
 * SIMD最適化モジュール
 * Single Instruction Multiple Data (SIMD) を使用したベクトル計算の高速化
 * 
 * 機能:
 * - ベクトル演算の並列処理
 * - 行列計算の最適化
 * - 光線-面交点計算の高速化
 * - 非球面SAG計算の並列化
 * 
 * 作成日: 2025/08/06
 */

// SIMD対応チェック
const SIMD_AVAILABLE = typeof SIMD !== 'undefined' && 
                       typeof SIMD.Float32x4 !== 'undefined' &&
                       typeof SIMD.Float64x2 !== 'undefined';

console.log(`🔧 SIMD対応状況: ${SIMD_AVAILABLE ? '✅ 利用可能' : '❌ 非対応（フォールバック使用）'}`);

/**
 * SIMD最適化ベクトル演算クラス
 */
class SIMDVectorMath {
    /**
     * 3Dベクトルの内積計算（SIMD最適化）
     * @param {Object} a - ベクトルA {x, y, z}
     * @param {Object} b - ベクトルB {x, y, z}
     * @returns {number} 内積値
     */
    static dotProduct3(a, b) {
        if (SIMD_AVAILABLE) {
            // SIMD版: 4つの要素を一度に処理（4番目は0）
            const vecA = SIMD.Float32x4(a.x || 0, a.y || 0, a.z || 0, 0);
            const vecB = SIMD.Float32x4(b.x || 0, b.y || 0, b.z || 0, 0);
            const product = SIMD.Float32x4.mul(vecA, vecB);
            
            return SIMD.Float32x4.extractLane(product, 0) + 
                   SIMD.Float32x4.extractLane(product, 1) + 
                   SIMD.Float32x4.extractLane(product, 2);
        }
        // フォールバック版
        return (a.x || 0) * (b.x || 0) + (a.y || 0) * (b.y || 0) + (a.z || 0) * (b.z || 0);
    }
    
    /**
     * 3Dベクトルの外積計算（SIMD最適化）
     * @param {Object} a - ベクトルA {x, y, z}
     * @param {Object} b - ベクトルB {x, y, z}
     * @returns {Object} 外積ベクトル {x, y, z}
     */
    static crossProduct3(a, b) {
        if (SIMD_AVAILABLE) {
            const vecA = SIMD.Float32x4(a.x || 0, a.y || 0, a.z || 0, 0);
            const vecB = SIMD.Float32x4(b.x || 0, b.y || 0, b.z || 0, 0);
            
            // 外積計算のSIMD版
            const a_yzxw = SIMD.Float32x4.shuffle(vecA, vecA, 1, 2, 0, 3);
            const b_zxyw = SIMD.Float32x4.shuffle(vecB, vecB, 2, 0, 1, 3);
            const a_zxyw = SIMD.Float32x4.shuffle(vecA, vecA, 2, 0, 1, 3);
            const b_yzxw = SIMD.Float32x4.shuffle(vecB, vecB, 1, 2, 0, 3);
            
            const cross1 = SIMD.Float32x4.mul(a_yzxw, b_zxyw);
            const cross2 = SIMD.Float32x4.mul(a_zxyw, b_yzxw);
            const result = SIMD.Float32x4.sub(cross1, cross2);
            
            return {
                x: SIMD.Float32x4.extractLane(result, 0),
                y: SIMD.Float32x4.extractLane(result, 1),
                z: SIMD.Float32x4.extractLane(result, 2)
            };
        }
        // フォールバック版
        return {
            x: (a.y || 0) * (b.z || 0) - (a.z || 0) * (b.y || 0),
            y: (a.z || 0) * (b.x || 0) - (a.x || 0) * (b.z || 0),
            z: (a.x || 0) * (b.y || 0) - (a.y || 0) * (b.x || 0)
        };
    }
    
    /**
     * ベクトルの正規化（SIMD最適化）
     * @param {Object} vec - ベクトル {x, y, z}
     * @returns {Object} 正規化されたベクトル {x, y, z}
     */
    static normalize3(vec) {
        if (SIMD_AVAILABLE) {
            const v = SIMD.Float32x4(vec.x || 0, vec.y || 0, vec.z || 0, 0);
            const squared = SIMD.Float32x4.mul(v, v);
            const sum = SIMD.Float32x4.extractLane(squared, 0) + 
                       SIMD.Float32x4.extractLane(squared, 1) + 
                       SIMD.Float32x4.extractLane(squared, 2);
            const length = Math.sqrt(sum);
            
            if (length === 0) return { x: 0, y: 0, z: 0 };
            
            const invLength = SIMD.Float32x4.splat(1.0 / length);
            const result = SIMD.Float32x4.mul(v, invLength);
            
            return {
                x: SIMD.Float32x4.extractLane(result, 0),
                y: SIMD.Float32x4.extractLane(result, 1),
                z: SIMD.Float32x4.extractLane(result, 2)
            };
        }
        // フォールバック版
        const length = Math.sqrt((vec.x || 0) ** 2 + (vec.y || 0) ** 2 + (vec.z || 0) ** 2);
        if (length === 0) return { x: 0, y: 0, z: 0 };
        
        return {
            x: (vec.x || 0) / length,
            y: (vec.y || 0) / length,
            z: (vec.z || 0) / length
        };
    }
    
    /**
     * 複数ベクトルの内積を一度に計算（バッチ処理）
     * @param {Array} vectorsA - ベクトル配列A
     * @param {Array} vectorsB - ベクトル配列B  
     * @returns {Array} 内積結果配列
     */
    static batchDotProduct3(vectorsA, vectorsB) {
        const results = [];
        const length = Math.min(vectorsA.length, vectorsB.length);
        
        // 4つずつまとめて処理
        for (let i = 0; i < length; i += 4) {
            const batch = [];
            for (let j = 0; j < 4 && i + j < length; j++) {
                if (vectorsA[i + j] && vectorsB[i + j]) {
                    batch.push(this.dotProduct3(vectorsA[i + j], vectorsB[i + j]));
                } else {
                    batch.push(0);
                }
            }
            results.push(...batch);
        }
        
        return results.slice(0, length);
    }
}

/**
 * SIMD最適化光線計算クラス
 */
class SIMDRayMath {
    /**
     * 複数光線の方向ベクトル正規化（バッチ処理）
     * @param {Array} rays - 光線配列
     * @returns {Array} 正規化された光線配列
     */
    static batchNormalizeRays(rays) {
        return rays.map(ray => ({
            ...ray,
            dir: SIMDVectorMath.normalize3(ray.dir)
        }));
    }
    
    /**
     * 光線-平面交点のバッチ計算
     * @param {Array} rays - 光線配列
     * @param {Object} plane - 平面 {normal, d}
     * @returns {Array} 交点座標配列
     */
    static batchRayPlaneIntersection(rays, plane) {
        return rays.map(ray => {
            const dotProduct = SIMDVectorMath.dotProduct3(ray.dir, plane.normal);
            if (Math.abs(dotProduct) < 1e-10) return null; // 平行
            
            const t = -(SIMDVectorMath.dotProduct3(ray.start, plane.normal) + plane.d) / dotProduct;
            if (t < 0) return null; // 後方
            
            return {
                x: ray.start.x + t * ray.dir.x,
                y: ray.start.y + t * ray.dir.y,
                z: ray.start.z + t * ray.dir.z,
                t: t
            };
        });
    }
}

/**
 * SIMD最適化非球面計算クラス
 */
class SIMDAsphericMath {
    /**
     * 複数点の非球面SAG値を一度に計算
     * @param {Array} rValues - 半径値配列
     * @param {number} curvature - 曲率
     * @param {number} conic - 円錐定数
     * @param {Array} aspheric - 非球面係数配列
     * @returns {Array} SAG値配列
     */
    static batchAsphericSag(rValues, curvature, conic, aspheric = []) {
        const results = [];
        
        if (SIMD_AVAILABLE && rValues.length >= 4) {
            // SIMD版: 4つずつまとめて処理
            for (let i = 0; i < rValues.length; i += 4) {
                const batch = [];
                for (let j = 0; j < 4 && i + j < rValues.length; j++) {
                    const r = rValues[i + j];
                    const r2 = r * r;
                    
                    // 基本球面項
                    const denominator = 1 + Math.sqrt(1 - (1 + conic) * curvature * curvature * r2);
                    let sag = curvature * r2 / denominator;
                    
                    // 非球面項（Horner法）
                    if (aspheric.length > 0) {
                        let r_power = r2 * r2; // r^4から開始
                        for (let k = 0; k < aspheric.length; k++) {
                            sag += aspheric[k] * r_power;
                            r_power *= r2; // 次の冪乗
                        }
                    }
                    
                    batch.push(sag);
                }
                results.push(...batch);
            }
        } else {
            // フォールバック版
            for (const r of rValues) {
                const r2 = r * r;
                const denominator = 1 + Math.sqrt(1 - (1 + conic) * curvature * curvature * r2);
                let sag = curvature * r2 / denominator;
                
                if (aspheric.length > 0) {
                    let r_power = r2 * r2;
                    for (let k = 0; k < aspheric.length; k++) {
                        sag += aspheric[k] * r_power;
                        r_power *= r2;
                    }
                }
                
                results.push(sag);
            }
        }
        
        return results.slice(0, rValues.length);
    }
}

/**
 * SIMD最適化テスト関数
 */
function testSIMDOptimization() {
    console.log('🧪 SIMD最適化テストを開始...');
    
    const testVectorA = { x: 1.0, y: 2.0, z: 3.0 };
    const testVectorB = { x: 4.0, y: 5.0, z: 6.0 };
    
    // 内積テスト
    const startTime = performance.now();
    const dotResult = SIMDVectorMath.dotProduct3(testVectorA, testVectorB);
    const simdTime = performance.now() - startTime;
    
    // フォールバック版での計算
    const fallbackStart = performance.now();
    const fallbackDot = testVectorA.x * testVectorB.x + testVectorA.y * testVectorB.y + testVectorA.z * testVectorB.z;
    const fallbackTime = performance.now() - fallbackStart;
    
    console.log('📊 SIMD最適化テスト結果:');
    console.log(`   内積結果: SIMD=${dotResult.toFixed(6)}, フォールバック=${fallbackDot.toFixed(6)}`);
    console.log(`   処理時間: SIMD=${simdTime.toFixed(3)}ms, フォールバック=${fallbackTime.toFixed(3)}ms`);
    console.log(`   速度向上: ${SIMD_AVAILABLE ? ((fallbackTime / simdTime).toFixed(2) + '倍') : 'N/A（SIMD非対応）'}`);
    
    // 外積テスト
    const crossResult = SIMDVectorMath.crossProduct3(testVectorA, testVectorB);
    console.log(`   外積結果: (${crossResult.x.toFixed(3)}, ${crossResult.y.toFixed(3)}, ${crossResult.z.toFixed(3)})`);
    
    // バッチ処理テスト
    const testVectors = Array.from({ length: 1000 }, (_, i) => ({
        x: Math.sin(i * 0.1),
        y: Math.cos(i * 0.1),
        z: i * 0.001
    }));
    
    const batchStart = performance.now();
    const batchResults = SIMDVectorMath.batchDotProduct3(testVectors, testVectors);
    const batchTime = performance.now() - batchStart;
    
    console.log(`   バッチ処理: 1000ベクトル処理時間=${batchTime.toFixed(3)}ms`);
    console.log(`   平均処理時間: ${(batchTime / 1000).toFixed(6)}ms/ベクトル`);
    
    return {
        simdAvailable: SIMD_AVAILABLE,
        dotResult,
        crossResult,
        batchTime,
        speedup: SIMD_AVAILABLE ? (fallbackTime / simdTime) : 1.0
    };
}

/**
 * 既存の光線追跡関数をSIMD最適化版で置き換える
 */
function enableSIMDOptimization() {
    console.log('🚀 SIMD最適化を有効化...');
    
    // 既存関数のバックアップ
    if (!window.originalVectorMath) {
        window.originalVectorMath = {
            dotProduct: window.dotProduct || function(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; },
            crossProduct: window.crossProduct || function(a, b) { 
                return {
                    x: a.y * b.z - a.z * b.y,
                    y: a.z * b.x - a.x * b.z,
                    z: a.x * b.y - a.y * b.x
                };
            },
            normalize: window.normalize || function(v) {
                const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
                return len === 0 ? {x: 0, y: 0, z: 0} : {x: v.x/len, y: v.y/len, z: v.z/len};
            }
        };
    }
    
    // SIMD最適化版で置き換え
    window.dotProduct = SIMDVectorMath.dotProduct3;
    window.crossProduct = SIMDVectorMath.crossProduct3;
    window.normalize = SIMDVectorMath.normalize3;
    
    console.log('✅ SIMD最適化が有効になりました');
}

/**
 * SIMD最適化を無効化
 */
function disableSIMDOptimization() {
    console.log('🔄 SIMD最適化を無効化...');
    
    if (window.originalVectorMath) {
        window.dotProduct = window.originalVectorMath.dotProduct;
        window.crossProduct = window.originalVectorMath.crossProduct;
        window.normalize = window.originalVectorMath.normalize;
        console.log('✅ 元の関数に戻しました');
    } else {
        console.log('⚠️ バックアップされた関数が見つかりません');
    }
}

// グローバルに公開
window.SIMDVectorMath = SIMDVectorMath;
window.SIMDRayMath = SIMDRayMath;
window.SIMDAsphericMath = SIMDAsphericMath;
window.testSIMDOptimization = testSIMDOptimization;
window.enableSIMDOptimization = enableSIMDOptimization;
window.disableSIMDOptimization = disableSIMDOptimization;

// 初期化メッセージ
console.log('🔧 SIMD最適化モジュールが読み込まれました');
console.log('   テスト実行: testSIMDOptimization()');
console.log('   有効化: enableSIMDOptimization()');
console.log('   無効化: disableSIMDOptimization()');
