#!/usr/bin/env node
/**
 * グリッドサイズ最適化のベンチマーク
 * 異なるグリッドサイズでの性能を測定
 */

import { WavefrontAberrationAnalyzer, OpticalPathDifferenceCalculator } from '../evaluation/wavefront/wavefront.ts';
import { getRecommendedGridSize } from '../evaluation/wavefront/adaptive-grid-size.ts';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultSystem = JSON.parse(readFileSync(join(__dirname, '../Examples/default-load.json'), 'utf-8'));

const fieldAngleDeg = 10;
const wavelength = 0.5876;

console.log('▶ Grid Size Optimization Benchmark\n');

const system = defaultSystem;
const rows = system.rows;
const stopIndex = rows.findIndex(r => r.surfType === 'Stop' || r.type === 'Stop');
const evalIndex = rows.length - 1;

const fieldSetting = {
    fieldAngle: { x: fieldAngleDeg, y: 0 },
    wavelength: wavelength
};

const calculator = new OpticalPathDifferenceCalculator(rows, stopIndex, evalIndex, wavelength);
const analyzer = new WavefrontAberrationAnalyzer(calculator);

const gridSizes = [32, 48, 64, 80, 96, 112, 128];

console.log('Grid Size | Points  | Time (ms) | Quality    | Speedup');
console.log('----------|---------|-----------|------------|--------');

let baselineTime = null;

for (const gridSize of gridSizes) {
    const t0 = performance.now();
    const result = await analyzer.generateWavefrontMap(
        fieldSetting,
        gridSize,
        'circular',
        {
            recordRays: false,
            profile: false,
            opdMode: 'referenceSphere'
        }
    );
    const t1 = performance.now();
    
    const elapsed = t1 - t0;
    const validCount = result?.pupilCoordinates?.length || 0;
    
    if (gridSize === 128) {
        baselineTime = elapsed;
    }
    
    const speedup = baselineTime ? (baselineTime / elapsed).toFixed(2) : '-';
    const quality = gridSize <= 32 ? 'Preview' :
                   gridSize <= 64 ? 'Interactive' :
                   gridSize <= 96 ? 'High' : 'Final';
    
    console.log(
        `${String(gridSize).padEnd(9)} | ` +
        `${String(validCount).padEnd(7)} | ` +
        `${elapsed.toFixed(0).padEnd(9)} | ` +
        `${quality.padEnd(10)} | ` +
        `${speedup}x`
    );
}

console.log('\n✅ Benchmark complete\n');

// 推奨設定の表示
console.log('📊 Recommended Settings:\n');

const purposes = ['realtime-preview', 'interactive', 'high-quality', 'export'];
for (const purpose of purposes) {
    const rec = getRecommendedGridSize(purpose, fieldAngleDeg);
    console.log(`${purpose.padEnd(20)}: ${rec.gridSize}×${rec.gridSize} (~${rec.estimatedTimeMs}ms, ${rec.pointCount} points)`);
}

process.exit(0);
