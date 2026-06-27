#!/usr/bin/env node
/**
 * Web Worker並列OPD計算のベンチマーク
 * useWebWorkers オプションでON/OFF比較
 */

import { WavefrontAberrationAnalyzer, OpticalPathDifferenceCalculator } from '../evaluation/wavefront/wavefront.ts';
import { loadDefaultOpticalSystem } from '../defaults/default-load.json' assert { type: 'json' };

const gridSize = 128;
const fieldAngleDeg = 10;
const wavelength = 0.5876; // μm
const runs = 3; // 並列は初回オーバーヘッドがあるため3回で十分

console.log('▶ Web Worker並列OPD A/B benchmark start', {
    gridSize,
    fieldX: fieldAngleDeg,
    wavelength,
    runs,
    workerCount: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4
});

// デフォルト光学系をロード
const system = loadDefaultOpticalSystem();
const rows = system.rows;
const stopIndex = rows.findIndex(r => r.surfType === 'Stop' || r.type === 'Stop');
const evalIndex = rows.length - 1;

const fieldSetting = {
    fieldAngle: { x: fieldAngleDeg, y: 0 },
    wavelength: wavelength
};

const calculator = new OpticalPathDifferenceCalculator(rows, stopIndex, evalIndex, wavelength);
const analyzer = new WavefrontAberrationAnalyzer(calculator);

const benchmarkRun = async (useWebWorkers) => {
    const options = {
        useWebWorkers: useWebWorkers,
        workerCount: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4,
        recordRays: false,
        profile: false,
        opdMode: 'referenceSphere'
    };

    const t0 = performance.now();
    const result = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', options);
    const t1 = performance.now();

    const validCount = result?.pupilCoordinates?.length || 0;
    return { ms: t1 - t0, valid: validCount };
};

const runBenchmark = async (label, useWebWorkers) => {
    const samples = [];
    for (let i = 0; i < runs; i++) {
        const sample = await benchmarkRun(useWebWorkers);
        samples.push(sample);
        console.log(`  [${label}] run ${i + 1}/${runs}: ${sample.ms.toFixed(2)}ms (valid: ${sample.valid})`);
    }

    const avgMs = samples.reduce((sum, s) => sum + s.ms, 0) / samples.length;
    const minMs = Math.min(...samples.map(s => s.ms));
    const maxMs = Math.max(...samples.map(s => s.ms));
    const validAvg = Math.round(samples.reduce((sum, s) => sum + s.valid, 0) / samples.length);

    return { avgMs, minMs, maxMs, validAvg, samples };
};

(async () => {
    try {
        console.log('\n🔹 Sequential (OFF) benchmark:');
        const off = await runBenchmark('OFF', false);

        console.log('\n🔹 Parallel (ON) benchmark:');
        const on = await runBenchmark('ON', true);

        const speedup = off.avgMs / on.avgMs;
        const speedupPercent = (speedup - 1) * 100;

        console.log('\n✅ Web Worker parallel OPD benchmark summary');
        console.log(JSON.stringify({
            gridSize,
            fieldX: fieldAngleDeg,
            wavelength,
            runs,
            sequential: off,
            parallel: on,
            speedup: speedup,
            speedupPercent: speedupPercent,
            workerCount: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4
        }, null, 2));

        if (speedup > 1.5) {
            console.log(`\n🎉 並列化成功: ${speedupPercent.toFixed(1)}% speedup!`);
        } else if (speedup > 1.0) {
            console.log(`\n✅ 並列化効果あり: ${speedupPercent.toFixed(1)}% speedup`);
        } else {
            console.log(`\n⚠️ 並列化効果なし: ${speedupPercent.toFixed(1)}% (slowdown)`);
        }

        process.exit(0);
    } catch (err) {
        console.error('❌ Benchmark failed:', err);
        process.exit(1);
    }
})();
