/**
 * Wavefront計算結果のキャッシュ管理
 * 同じ条件での再計算を回避し、10-100倍の高速化を実現
 */

export interface WavefrontCacheKey {
    fieldAngleX: number;
    fieldAngleY: number;
    wavelength: number;
    gridSize: number;
    opdMode: string;
    systemHash: string; // 光学系の一意識別子
}

export interface WavefrontCacheEntry {
    key: WavefrontCacheKey;
    result: any; // WavefrontMapResult
    timestamp: number;
    accessCount: number;
    sizeBytes: number;
}

/**
 * LRUキャッシュによるWavefront計算結果の管理
 */
export class WavefrontCache {
    private cache: Map<string, WavefrontCacheEntry>;
    private maxEntries: number;
    private maxSizeBytes: number;
    private currentSizeBytes: number;
    private hits: number;
    private misses: number;

    constructor(maxEntries: number = 50, maxSizeMB: number = 100) {
        this.cache = new Map();
        this.maxEntries = maxEntries;
        this.maxSizeBytes = maxSizeMB * 1024 * 1024;
        this.currentSizeBytes = 0;
        this.hits = 0;
        this.misses = 0;
    }

    /**
     * キャッシュキーから一意の文字列を生成
     */
    private static generateCacheKey(key: WavefrontCacheKey): string {
        return `${key.systemHash}|${key.fieldAngleX.toFixed(6)}|${key.fieldAngleY.toFixed(6)}|${key.wavelength.toFixed(6)}|${key.gridSize}|${key.opdMode}`;
    }

    /**
     * 光学系データからハッシュを生成
     */
    static generateSystemHash(opticalSystemRows: any[]): string {
        // 光学系の重要なパラメータを組み合わせてハッシュ化
        const relevantData = opticalSystemRows.map(row => ({
            surfType: row.surfType,
            radius: row.radius,
            thickness: row.thickness,
            material: row.material,
            semiDiameter: row.semiDiameter,
            conic: row.conic,
            asphericCoeffs: row.asphericCoeffs
        }));
        
        const jsonStr = JSON.stringify(relevantData);
        return this.simpleHash(jsonStr);
    }

    /**
     * 簡易ハッシュ関数（高速）
     */
    private static simpleHash(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 32bit整数に変換
        }
        return hash.toString(36);
    }

    /**
     * 結果のサイズを推定（バイト単位）
     */
    private estimateResultSize(result: any): number {
        // 簡易推定: 1点あたり約40バイト（pupilX, pupilY, opd, etc.）
        const pointCount = result?.pupilCoordinates?.length || 0;
        return pointCount * 40 + 1000; // +1000はメタデータ用
    }

    /**
     * キャッシュから取得
     */
    get(key: WavefrontCacheKey): any | null {
        const cacheKey = WavefrontCache.generateCacheKey(key);
        const entry = this.cache.get(cacheKey);

        if (entry) {
            this.hits++;
            entry.accessCount++;
            entry.timestamp = Date.now();
            
            // LRU更新: 削除して再挿入（Mapは挿入順を保持）
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, entry);
            
            return entry.result;
        }

        this.misses++;
        return null;
    }

    /**
     * キャッシュに保存
     */
    set(key: WavefrontCacheKey, result: any): void {
        const cacheKey = WavefrontCache.generateCacheKey(key);
        const sizeBytes = this.estimateResultSize(result);

        // 既存エントリがあれば削除
        const existing = this.cache.get(cacheKey);
        if (existing) {
            this.currentSizeBytes -= existing.sizeBytes;
            this.cache.delete(cacheKey);
        }

        // サイズ制限チェック: 必要に応じて古いエントリを削除
        while (this.cache.size >= this.maxEntries || 
               this.currentSizeBytes + sizeBytes > this.maxSizeBytes) {
            if (this.cache.size === 0) break;
            
            // 最も古いエントリ（Map先頭）を削除
            const oldestKey = this.cache.keys().next().value;
            const oldestEntry = this.cache.get(oldestKey);
            if (oldestEntry) {
                this.currentSizeBytes -= oldestEntry.sizeBytes;
            }
            this.cache.delete(oldestKey);
        }

        // 新しいエントリを追加
        const entry: WavefrontCacheEntry = {
            key,
            result,
            timestamp: Date.now(),
            accessCount: 1,
            sizeBytes
        };

        this.cache.set(cacheKey, entry);
        this.currentSizeBytes += sizeBytes;
    }

    /**
     * 光学系が変更されたときのキャッシュ無効化
     */
    invalidateBySystemHash(systemHash: string): number {
        let removed = 0;
        for (const [cacheKey, entry] of this.cache.entries()) {
            if (entry.key.systemHash === systemHash) {
                this.currentSizeBytes -= entry.sizeBytes;
                this.cache.delete(cacheKey);
                removed++;
            }
        }
        return removed;
    }

    /**
     * すべてのキャッシュをクリア
     */
    clear(): void {
        this.cache.clear();
        this.currentSizeBytes = 0;
        this.hits = 0;
        this.misses = 0;
    }

    /**
     * キャッシュ統計情報を取得
     */
    getStats() {
        return {
            entries: this.cache.size,
            maxEntries: this.maxEntries,
            sizeBytes: this.currentSizeBytes,
            sizeMB: (this.currentSizeBytes / (1024 * 1024)).toFixed(2),
            maxSizeMB: (this.maxSizeBytes / (1024 * 1024)).toFixed(2),
            hits: this.hits,
            misses: this.misses,
            hitRate: this.hits + this.misses > 0 
                ? ((this.hits / (this.hits + this.misses)) * 100).toFixed(1) + '%'
                : 'N/A'
        };
    }

    /**
     * デバッグ用: キャッシュ内容の一覧
     */
    listEntries(): Array<{key: string, accessCount: number, age: string, sizeMB: string}> {
        const now = Date.now();
        return Array.from(this.cache.entries()).map(([cacheKey, entry]) => ({
            key: cacheKey,
            accessCount: entry.accessCount,
            age: `${((now - entry.timestamp) / 1000).toFixed(0)}s ago`,
            sizeMB: (entry.sizeBytes / (1024 * 1024)).toFixed(3)
        }));
    }
}

/**
 * グローバルキャッシュインスタンス（シングルトン）
 */
let globalWavefrontCache: WavefrontCache | null = null;

export function getGlobalWavefrontCache(): WavefrontCache {
    if (!globalWavefrontCache) {
        globalWavefrontCache = new WavefrontCache(50, 100); // 最大50エントリ、100MB
    }
    return globalWavefrontCache;
}

export function setGlobalWavefrontCache(cache: WavefrontCache): void {
    globalWavefrontCache = cache;
}

/**
 * 使用例:
 * 
 * // キャッシュの取得
 * const cache = getGlobalWavefrontCache();
 * 
 * // 計算前にキャッシュをチェック
 * const cacheKey = {
 *     fieldAngleX: 10,
 *     fieldAngleY: 0,
 *     wavelength: 0.5876,
 *     gridSize: 64,
 *     opdMode: 'referenceSphere',
 *     systemHash: WavefrontCache.generateSystemHash(opticalSystemRows)
 * };
 * 
 * let result = cache.get(cacheKey);
 * if (!result) {
 *     // キャッシュミス: 計算実行
 *     result = await analyzer.generateWavefrontMap(...);
 *     cache.set(cacheKey, result);
 * }
 * 
 * // 統計情報の確認
 * console.log('Cache stats:', cache.getStats());
 * // → { entries: 5, hits: 23, misses: 5, hitRate: '82.1%' }
 * 
 * // 光学系変更時の無効化
 * cache.invalidateBySystemHash(systemHash);
 */
