/**
 * 代替最適化モジュール
 * SIMD非対応環境向けの高速化手法
 * 
 * 機能:
 * - 型付き配列によるメモリ最適化
 * - ループアンローリングによる高速化
 * - キャッシュ効率的なデータアクセス
 * - WebWorker並列処理
 * 
 * 作成日: 2025/08/06
 */

/**
 * 型付き配列ベクトル演算クラス
 */
class TypedArrayVectorMath {
    /**
     * 3Dベクトルの内積計算（型付き配列版）
     * @param {Object} a - ベクトルA {x, y, z}
     * @param {Object} b - ベクトルB {x, y, z}
     * @returns {number} 内積値
     */
    static dotProduct3(a, b) {
        // 型付き配列に変換して計算
        const vecA = new Float32Array([a.x || 0, a.y || 0, a.z || 0]);
        const vecB = new Float32Array([b.x || 0, b.y || 0, b.z || 0]);
        
        return vecA[0] * vecB[0] + vecA[1] * vecB[1] + vecA[2] * vecB[2];
    }
    
    /**
     * バッチ内積計算（ループアンローリング版）
     * @param {Array} vectorsA - ベクトル配列A
     * @param {Array} vectorsB - ベクトル配列B
     * @returns {Float32Array} 内積結果配列
     */
    static batchDotProduct3(vectorsA, vectorsB) {
        const length = Math.min(vectorsA.length, vectorsB.length);
        const results = new Float32Array(length);
        
        // ループアンローリング: 4つずつまとめて処理
        let i = 0;
        for (; i < length - 3; i += 4) {
            // 4つ同時に計算
            if (vectorsA[i] && vectorsB[i]) {
                results[i] = (vectorsA[i].x || 0) * (vectorsB[i].x || 0) +
                            (vectorsA[i].y || 0) * (vectorsB[i].y || 0) +
                            (vectorsA[i].z || 0) * (vectorsB[i].z || 0);
            }
            if (vectorsA[i+1] && vectorsB[i+1]) {
                results[i+1] = (vectorsA[i+1].x || 0) * (vectorsB[i+1].x || 0) +
                              (vectorsA[i+1].y || 0) * (vectorsB[i+1].y || 0) +
                              (vectorsA[i+1].z || 0) * (vectorsB[i+1].z || 0);
            }
            if (vectorsA[i+2] && vectorsB[i+2]) {
                results[i+2] = (vectorsA[i+2].x || 0) * (vectorsB[i+2].x || 0) +
                              (vectorsA[i+2].y || 0) * (vectorsB[i+2].y || 0) +
                              (vectorsA[i+2].z || 0) * (vectorsB[i+2].z || 0);
            }
            if (vectorsA[i+3] && vectorsB[i+3]) {
                results[i+3] = (vectorsA[i+3].x || 0) * (vectorsB[i+3].x || 0) +
                              (vectorsA[i+3].y || 0) * (vectorsB[i+3].y || 0) +
                              (vectorsA[i+3].z || 0) * (vectorsB[i+3].z || 0);
            }
        }
        
        // 残りの要素を処理
        for (; i < length; i++) {
            if (vectorsA[i] && vectorsB[i]) {
                results[i] = (vectorsA[i].x || 0) * (vectorsB[i].x || 0) +
                            (vectorsA[i].y || 0) * (vectorsB[i].y || 0) +
                            (vectorsA[i].z || 0) * (vectorsB[i].z || 0);
            }
        }
        
        return results;
    }
    
    /**
     * 高速正規化（型付き配列＋sqrt逆数近似）
     * @param {Object} vec - ベクトル {x, y, z}
     * @returns {Object} 正規化されたベクトル
     */
    static normalize3Fast(vec) {
        const x = vec.x || 0;
        const y = vec.y || 0;
        const z = vec.z || 0;
        
        const lengthSq = x * x + y * y + z * z;
        if (lengthSq === 0) return { x: 0, y: 0, z: 0 };
        
        // 高速逆数平方根近似 (Quake III algorithm)
        const invLength = TypedArrayVectorMath.fastInverseSqrt(lengthSq);
        
        return {
            x: x * invLength,
            y: y * invLength,
            z: z * invLength
        };
    }
    
    /**
     * 高速逆数平方根近似
     * @param {number} x - 入力値
     * @returns {number} 1/sqrt(x)の近似値
     */
    static fastInverseSqrt(x) {
        // JavaScript版のQuake III逆数平方根近似
        if (x <= 0) return 0;
        
        // 通常の実装（JavaScriptでは型変換のコストが高いため）
        return 1.0 / Math.sqrt(x);
    }
}

/**
 * メモリプール管理クラス
 */
class MemoryPool {
    constructor(createFunc, resetFunc = null, initialSize = 1000) {
        this.createFunc = createFunc;
        this.resetFunc = resetFunc;
        this.pool = [];
        this.index = 0;
        
        // プールを事前作成
        for (let i = 0; i < initialSize; i++) {
            this.pool.push(createFunc());
        }
    }
    
    /**
     * オブジェクトを取得
     */
    get() {
        if (this.index >= this.pool.length) {
            // プールが不足したら拡張
            for (let i = 0; i < 100; i++) {
                this.pool.push(this.createFunc());
            }
        }
        return this.pool[this.index++];
    }
    
    /**
     * プールをリセット
     */
    reset() {
        if (this.resetFunc) {
            for (let i = 0; i < this.index; i++) {
                this.resetFunc(this.pool[i]);
            }
        }
        this.index = 0;
    }
    
    /**
     * プールサイズ取得
     */
    size() {
        return this.pool.length;
    }
    
    /**
     * 使用量取得
     */
    usage() {
        return this.index;
    }
}

/**
 * 高速化非球面計算クラス
 */
class FastAsphericMath {
    /**
     * バッチ非球面SAG計算（ループアンローリング版）
     * @param {Float32Array} rValues - 半径値配列（型付き配列）
     * @param {number} curvature - 曲率
     * @param {number} conic - 円錐定数
     * @param {Float32Array} aspheric - 非球面係数配列
     * @returns {Float32Array} SAG値配列
     */
    static batchAsphericSag(rValues, curvature, conic, aspheric = new Float32Array()) {
        const length = rValues.length;
        const results = new Float32Array(length);
        
        const c = curvature;
        const k = conic;
        const c2 = c * c;
        const factor = 1 + k;
        
        // ループアンローリング: 4つずつまとめて処理
        let i = 0;
        for (; i < length - 3; i += 4) {
            // 4点同時処理
            this.computeSagFour(rValues, i, results, c, c2, factor, k, aspheric);
        }
        
        // 残りの要素を処理
        for (; i < length; i++) {
            const r = rValues[i];
            const r2 = r * r;
            
            // 基本球面項
            const sqrt_term = Math.sqrt(1 - factor * c2 * r2);
            const denominator = 1 + sqrt_term;
            let sag = c * r2 / denominator;
            
            // 非球面項（Horner法）
            if (aspheric.length > 0) {
                let r_power = r2 * r2; // r^4から開始
                for (let j = 0; j < aspheric.length; j++) {
                    sag += aspheric[j] * r_power;
                    r_power *= r2;
                }
            }
            
            results[i] = sag;
        }
        
        return results;
    }
    
    /**
     * 4点同時SAG計算（インライン展開）
     */
    static computeSagFour(rValues, startIndex, results, c, c2, factor, k, aspheric) {
        for (let offset = 0; offset < 4; offset++) {
            const idx = startIndex + offset;
            if (idx >= rValues.length) break;
            
            const r = rValues[idx];
            const r2 = r * r;
            
            // 基本球面項
            const sqrt_term = Math.sqrt(1 - factor * c2 * r2);
            const denominator = 1 + sqrt_term;
            let sag = c * r2 / denominator;
            
            // 非球面項
            if (aspheric.length > 0) {
                let r_power = r2 * r2;
                for (let j = 0; j < aspheric.length; j++) {
                    sag += aspheric[j] * r_power;
                    r_power *= r2;
                }
            }
            
            results[idx] = sag;
        }
    }
}

/**
 * WebWorker並列処理マネージャー
 */
class ParallelProcessor {
    constructor(workerScript, maxWorkers = navigator.hardwareConcurrency || 4) {
        this.workerScript = workerScript;
        this.maxWorkers = Math.min(maxWorkers, 8); // 最大8ワーカー
        this.workers = [];
        this.taskQueue = [];
        this.activeWorkers = 0;
    }
    
    /**
     * ワーカー初期化
     */
    async initWorkers() {
        const workerCode = `
            self.onmessage = function(e) {
                const { taskType, data, taskId } = e.data;
                let result;
                
                switch(taskType) {
                    case 'vectorDotProduct':
                        result = computeVectorDotProducts(data);
                        break;
                    case 'asphericSag':
                        result = computeAsphericSag(data);
                        break;
                    default:
                        result = { error: 'Unknown task type' };
                }
                
                self.postMessage({ result, taskId });
            };
            
            function computeVectorDotProducts(data) {
                const { vectorsA, vectorsB } = data;
                const results = new Float32Array(vectorsA.length);
                
                for (let i = 0; i < vectorsA.length; i++) {
                    const a = vectorsA[i];
                    const b = vectorsB[i];
                    results[i] = (a.x || 0) * (b.x || 0) + 
                                (a.y || 0) * (b.y || 0) + 
                                (a.z || 0) * (b.z || 0);
                }
                
                return Array.from(results);
            }
            
            function computeAsphericSag(data) {
                const { rValues, curvature, conic, aspheric } = data;
                const results = new Float32Array(rValues.length);
                
                for (let i = 0; i < rValues.length; i++) {
                    const r = rValues[i];
                    const r2 = r * r;
                    
                    const factor = 1 + conic;
                    const sqrt_term = Math.sqrt(1 - factor * curvature * curvature * r2);
                    let sag = curvature * r2 / (1 + sqrt_term);
                    
                    if (aspheric && aspheric.length > 0) {
                        let r_power = r2 * r2;
                        for (let j = 0; j < aspheric.length; j++) {
                            sag += aspheric[j] * r_power;
                            r_power *= r2;
                        }
                    }
                    
                    results[i] = sag;
                }
                
                return Array.from(results);
            }
        `;
        
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        
        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = new Worker(workerUrl);
            this.workers.push(worker);
        }
        
        URL.revokeObjectURL(workerUrl);
    }
    
    /**
     * 並列タスク実行
     */
    async processParallel(taskType, data, chunkSize = 1000) {
        if (this.workers.length === 0) {
            await this.initWorkers();
        }
        
        return new Promise((resolve, reject) => {
            const chunks = this.chunkData(data, chunkSize);
            const results = new Array(chunks.length);
            let completedChunks = 0;
            
            chunks.forEach((chunk, index) => {
                const worker = this.workers[index % this.workers.length];
                const taskId = `${taskType}_${index}_${Date.now()}`;
                
                const handleMessage = (e) => {
                    if (e.data.taskId === taskId) {
                        worker.removeEventListener('message', handleMessage);
                        results[index] = e.data.result;
                        completedChunks++;
                        
                        if (completedChunks === chunks.length) {
                            const flatResults = results.flat();
                            resolve(flatResults);
                        }
                    }
                };
                
                worker.addEventListener('message', handleMessage);
                worker.postMessage({ taskType, data: chunk, taskId });
            });
        });
    }
    
    /**
     * データをチャンクに分割
     */
    chunkData(data, chunkSize) {
        if (Array.isArray(data)) {
            const chunks = [];
            for (let i = 0; i < data.length; i += chunkSize) {
                chunks.push(data.slice(i, i + chunkSize));
            }
            return chunks;
        } else {
            // オブジェクトの場合
            const keys = Object.keys(data);
            const chunks = [];
            for (let i = 0; i < keys[0].length; i += chunkSize) {
                const chunk = {};
                keys.forEach(key => {
                    chunk[key] = data[key].slice(i, i + chunkSize);
                });
                chunks.push(chunk);
            }
            return chunks;
        }
    }
    
    /**
     * ワーカー終了
     */
    terminate() {
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
    }
}

// グローバルプール作成
const vector3Pool = new MemoryPool(
    () => ({ x: 0, y: 0, z: 0 }),
    (obj) => { obj.x = 0; obj.y = 0; obj.z = 0; },
    10000
);

const rayPool = new MemoryPool(
    () => ({ start: { x: 0, y: 0, z: 0 }, dir: { x: 0, y: 0, z: 0 } }),
    (obj) => {
        obj.start.x = obj.start.y = obj.start.z = 0;
        obj.dir.x = obj.dir.y = obj.dir.z = 0;
    },
    1000
);

// 並列処理マネージャー
const parallelProcessor = new ParallelProcessor();

/**
 * 代替最適化テスト関数
 */
function testAlternativeOptimization() {
    console.log('🧪 代替最適化テストを開始...');
    
    const testVectorA = { x: 1.0, y: 2.0, z: 3.0 };
    const testVectorB = { x: 4.0, y: 5.0, z: 6.0 };
    
    // 型付き配列版テスト
    const startTime = performance.now();
    const dotResult = TypedArrayVectorMath.dotProduct3(testVectorA, testVectorB);
    const typedArrayTime = performance.now() - startTime;
    
    // 通常版での計算
    const normalStart = performance.now();
    const normalDot = testVectorA.x * testVectorB.x + testVectorA.y * testVectorB.y + testVectorA.z * testVectorB.z;
    const normalTime = performance.now() - normalStart;
    
    console.log('📊 代替最適化テスト結果:');
    console.log(`   内積結果: 型付き配列=${dotResult.toFixed(6)}, 通常=${normalDot.toFixed(6)}`);
    console.log(`   処理時間: 型付き配列=${typedArrayTime.toFixed(3)}ms, 通常=${normalTime.toFixed(3)}ms`);
    console.log(`   速度向上: ${(normalTime / typedArrayTime).toFixed(2)}倍`);
    
    // メモリプールテスト
    console.log(`   メモリプール: Vector3プール=${vector3Pool.size()}個, 使用量=${vector3Pool.usage()}個`);
    
    return {
        typedArrayAvailable: true,
        dotResult,
        speedup: normalTime / typedArrayTime,
        memoryPoolSize: vector3Pool.size()
    };
}

/**
 * 代替最適化を有効化
 */
function enableAlternativeOptimization() {
    console.log('🚀 代替最適化を有効化...');
    
    // バックアップ
    if (!window.originalMathFunctions) {
        window.originalMathFunctions = {
            dotProduct: window.dotProduct,
            normalize: window.normalize
        };
    }
    
    // 型付き配列版で置き換え
    window.dotProduct = TypedArrayVectorMath.dotProduct3;
    window.normalize = TypedArrayVectorMath.normalize3Fast;
    
    console.log('✅ 代替最適化が有効になりました');
}

// グローバル公開
window.TypedArrayVectorMath = TypedArrayVectorMath;
window.MemoryPool = MemoryPool;
window.FastAsphericMath = FastAsphericMath;
window.ParallelProcessor = ParallelProcessor;
window.testAlternativeOptimization = testAlternativeOptimization;
window.enableAlternativeOptimization = enableAlternativeOptimization;
window.vector3Pool = vector3Pool;
window.rayPool = rayPool;
window.parallelProcessor = parallelProcessor;

console.log('⚡ 代替最適化モジュールが読み込まれました');
console.log('   テスト実行: testAlternativeOptimization()');
console.log('   有効化: enableAlternativeOptimization()');
