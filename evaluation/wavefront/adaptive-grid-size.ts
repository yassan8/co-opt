/**
 * 適応的グリッドサイズ計算
 * パフォーマンスと品質のバランスを自動調整
 */

export interface GridSizeRecommendation {
    gridSize: number;
    estimatedTimeMs: number;
    quality: 'preview' | 'interactive' | 'high' | 'final';
    pointCount: number;
}

/**
 * 使用ケースに応じた推奨グリッドサイズを計算
 */
export function getRecommendedGridSize(
    purpose: 'realtime-preview' | 'interactive' | 'high-quality' | 'export',
    fieldAngleDeg: number = 0
): GridSizeRecommendation {
    // 基準: 128×128 で 10° field = 2,672ms, 12,644点
    const baselineMs = 2672;
    const baselineGridSize = 128;
    
    // 画角による補正係数（大きい画角ほど計算が重い）
    const fieldFactor = Math.max(1.0, 1.0 + Math.abs(fieldAngleDeg) / 30.0);
    
    switch (purpose) {
        case 'realtime-preview':
            // 目標: <300ms (リアルタイム更新)
            // 32×32 = 約775点, 約150ms
            return {
                gridSize: 32,
                estimatedTimeMs: Math.round(150 * fieldFactor),
                quality: 'preview',
                pointCount: estimatePointCount(32)
            };
            
        case 'interactive':
            // 目標: <800ms (インタラクティブ操作)
            // 64×64 = 約3,141点, 約650ms
            return {
                gridSize: 64,
                estimatedTimeMs: Math.round(650 * fieldFactor),
                quality: 'interactive',
                pointCount: estimatePointCount(64)
            };
            
        case 'high-quality':
            // 目標: <2000ms (品質重視)
            // 96×96 = 約7,069点, 約1,500ms
            return {
                gridSize: 96,
                estimatedTimeMs: Math.round(1500 * fieldFactor),
                quality: 'high',
                pointCount: estimatePointCount(96)
            };
            
        case 'export':
            // 目標: 最高品質（時間制約なし）
            // 128×128 = 約12,644点, 約2,672ms
            return {
                gridSize: 128,
                estimatedTimeMs: Math.round(2672 * fieldFactor),
                quality: 'final',
                pointCount: estimatePointCount(128)
            };
            
        default:
            return {
                gridSize: 64,
                estimatedTimeMs: Math.round(650 * fieldFactor),
                quality: 'interactive',
                pointCount: estimatePointCount(64)
            };
    }
}

/**
 * 円形マスク内の有効点数を推定
 * 実測: 128×128 (16,384点) → 約12,644点 (77%)
 */
function estimatePointCount(gridSize: number): number {
    const totalPoints = gridSize * gridSize;
    const circularEfficiency = 0.77; // 円形マスクによる削減
    return Math.round(totalPoints * circularEfficiency);
}

/**
 * 目標時間から適切なグリッドサイズを逆算
 */
export function getGridSizeForTargetTime(
    targetTimeMs: number,
    fieldAngleDeg: number = 0
): GridSizeRecommendation {
    const fieldFactor = Math.max(1.0, 1.0 + Math.abs(fieldAngleDeg) / 30.0);
    
    // 基準性能: 128×128 = 2,672ms
    // O(n²) なので gridSize ∝ √time
    const baselineMs = 2672;
    const baselineGridSize = 128;
    
    const adjustedTarget = targetTimeMs / fieldFactor;
    const scaleFactor = Math.sqrt(adjustedTarget / baselineMs);
    const gridSize = Math.max(16, Math.min(256, Math.round(baselineGridSize * scaleFactor / 16) * 16)); // 16の倍数
    
    let quality: GridSizeRecommendation['quality'] = 'interactive';
    if (gridSize <= 32) quality = 'preview';
    else if (gridSize <= 64) quality = 'interactive';
    else if (gridSize <= 96) quality = 'high';
    else quality = 'final';
    
    return {
        gridSize,
        estimatedTimeMs: Math.round(baselineMs * (gridSize / baselineGridSize) ** 2 * fieldFactor),
        quality,
        pointCount: estimatePointCount(gridSize)
    };
}

/**
 * Progressive Loading戦略: 段階的に品質を向上
 */
export interface ProgressiveStrategy {
    stages: Array<{
        gridSize: number;
        delayMs: number; // 前のステージとの間隔
        description: string;
    }>;
}

export function getProgressiveStrategy(
    finalGridSize: number = 128
): ProgressiveStrategy {
    const stages = [];
    
    // Stage 1: 即座にプレビュー表示
    stages.push({
        gridSize: 32,
        delayMs: 0,
        description: 'Quick preview'
    });
    
    // Stage 2: インタラクティブ品質（少し待つ）
    if (finalGridSize >= 64) {
        stages.push({
            gridSize: 64,
            delayMs: 200, // ユーザーが最初のプレビューを見る時間
            description: 'Interactive quality'
        });
    }
    
    // Stage 3: 高品質（さらに待つ）
    if (finalGridSize >= 96) {
        stages.push({
            gridSize: 96,
            delayMs: 500,
            description: 'High quality'
        });
    }
    
    // Stage 4: 最終品質
    if (finalGridSize > 96) {
        stages.push({
            gridSize: finalGridSize,
            delayMs: 1000,
            description: 'Final quality'
        });
    }
    
    return { stages };
}

/**
 * 使用例:
 * 
 * // インタラクティブUIの場合
 * const rec = getRecommendedGridSize('interactive', 10);
 * console.log(`Grid: ${rec.gridSize}, Time: ${rec.estimatedTimeMs}ms`);
 * // → Grid: 64, Time: 650ms
 * 
 * // エクスポートの場合
 * const rec = getRecommendedGridSize('export', 10);
 * // → Grid: 128, Time: 2672ms
 * 
 * // Progressive Loading
 * const strategy = getProgressiveStrategy(128);
 * for (const stage of strategy.stages) {
 *     await delay(stage.delayMs);
 *     const result = await generateWavefrontMap(..., stage.gridSize, ...);
 *     displayWavefront(result);
 * }
 */
