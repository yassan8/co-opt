#!/usr/bin/env node

/**
 * Cache Effect Benchmark
 * 
 * Measures the performance impact of caching by running the same optical system
 * trace multiple times. Caches should hit on iterations 2+.
 * 
 * Usage: node tools/bench-cache-effect.mjs [--iterations 10] [--modes js,wasm-strict,rust-wasm]
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const workspaceRoot = resolve(__dirname, '..');

// Setup global context for TypeScript/ES modules
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}
if (!globalThis.localStorage || typeof globalThis.localStorage.getItem !== 'function') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(String(k)) ? store.get(String(k)) : null),
    setItem: (k, v) => { store.set(String(k), String(v)); },
    removeItem: (k) => { store.delete(String(k)); },
    clear: () => { store.clear(); }
  };
}

// Parse command-line arguments
const args = process.argv.slice(2);
let iterations = 10;
let modes = ['js', 'wasm-strict', 'rust-wasm'];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--iterations' && i + 1 < args.length) {
    iterations = parseInt(args[i + 1], 10);
  }
  if (args[i] === '--modes' && i + 1 < args.length) {
    modes = args[i + 1].split(',').map(m => m.trim());
  }
}

console.log(`\n🔄 Cache Effect Benchmark: ${iterations} iterations per mode`);
console.log(`📊 Modes: ${modes.join(', ')}\n`);

// Import profiling functions
const { runOPDProfilingCompareModes, buildOPDProfileReport } = await import(
  resolve(workspaceRoot, 'evaluation/wavefront/opd-profiler.ts')
);

// Test configuration: single lightweight optical system
const fields = [{ fieldAngle: { x: 0, y: 0 } }];
const gridSize = 128;

const results = {};

for (const mode of modes) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Mode: ${mode.toUpperCase()}`);
  console.log(`${'='.repeat(60)}`);
  
  const timings = [];
  const cacheHitTimings = [];
  
  for (let iter = 0; iter < iterations; iter++) {
    process.stdout.write(`  Iteration ${iter + 1}/${iterations}... `);
    
    const startTime = performance.now();
    
    try {
      const compareOut = await runOPDProfilingCompareModes({
        traceModes: [mode],
        gridSizes: [gridSize],
        fields,
        warmup: false // No warmup on subsequent iterations
      });
      
      const endTime = performance.now();
      const elapsed = endTime - startTime;
      timings.push(elapsed);
      
      // Cache should hit on iterations 2+
      if (iter > 0) {
        cacheHitTimings.push(elapsed);
      }
      
      console.log(`${elapsed.toFixed(2)}ms`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      timings.push(NaN);
    }
  }
  
  // Calculate statistics
  const validTimings = timings.filter(t => isFinite(t));
  const validCacheHits = cacheHitTimings.filter(t => isFinite(t));
  
  const avg = validTimings.reduce((a, b) => a + b, 0) / validTimings.length;
  const cacheAvg = validCacheHits.length > 0 
    ? validCacheHits.reduce((a, b) => a + b, 0) / validCacheHits.length 
    : NaN;
  
  const min = Math.min(...validTimings);
  const max = Math.max(...validTimings);
  
  const cacheImprovement = isFinite(cacheAvg)
    ? ((timings[0] - cacheAvg) / timings[0]) * 100
    : NaN;
  
  results[mode] = {
    firstRun: timings[0],
    averageAllRuns: avg,
    averageCacheHits: cacheAvg,
    minTime: min,
    maxTime: max,
    cacheImprovementPct: cacheImprovement,
    allTimings: timings
  };
  
  console.log(`\n  📈 Statistics:`);
  console.log(`    First run (cold cache):     ${timings[0].toFixed(2)}ms`);
  console.log(`    Average (all runs):         ${avg.toFixed(2)}ms`);
  console.log(`    Average (cache hits 2-${iterations}):  ${cacheAvg.toFixed(2)}ms`);
  console.log(`    Min/Max:                    ${min.toFixed(2)}ms / ${max.toFixed(2)}ms`);
  console.log(`    Cache improvement:          ${cacheImprovement.toFixed(1)}%`);
}

// Summary table
console.log(`\n${'='.repeat(80)}`);
console.log('📊 SUMMARY: Cache Effect Analysis');
console.log(`${'='.repeat(80)}\n`);

console.log('Mode          | First Run | Avg All  | Avg Cache | Improvement');
console.log('              |    (ms)   |   (ms)   |   (ms)    |     (%)');
console.log('-'.repeat(65));

for (const mode of modes) {
  const r = results[mode];
  const improvement = isFinite(r.cacheImprovementPct) ? r.cacheImprovementPct.toFixed(1) : 'N/A';
  console.log(
    `${mode.padEnd(13)} | ${r.firstRun.toFixed(3).padStart(8)} | ${r.averageAllRuns.toFixed(3).padStart(7)} | ${r.averageCacheHits.toFixed(3).padStart(8)} | ${improvement.padStart(8)}`
  );
}

console.log();

// Performance ranking
const ranked = modes
  .map(m => ({ mode: m, improvement: results[m].cacheImprovementPct }))
  .filter(r => isFinite(r.improvement))
  .sort((a, b) => b.improvement - a.improvement);

if (ranked.length > 0) {
  console.log('🏆 Ranking by cache improvement:');
  ranked.forEach((r, i) => {
    console.log(`   ${i + 1}. ${r.mode.toUpperCase()}: ${r.improvement.toFixed(1)}% faster on cache hits`);
  });
}

console.log('\n✅ Cache effect benchmark complete\n');

// Export results as JSON for further analysis
const summary = {
  timestamp: new Date().toISOString(),
  configuration: { iterations, gridSize, modes },
  results
};

console.log('Results summary:');
console.log(JSON.stringify(summary, null, 2).split('\n').slice(0, 30).join('\n'));
console.log('...');
