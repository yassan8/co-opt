#!/usr/bin/env node

/**
 * Quick test: WASM JSON string parsing
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import init, { optimize_system_in_wasm } from './rust-wasm/pkg/surface_origins.js';

const wasmBinaryPath = path.join(__dirname, 'rust-wasm', 'pkg', 'surface_origins_bg.wasm');
const wasmBuffer = fs.readFileSync(wasmBinaryPath);

await init(wasmBuffer);

// Create a minimal valid payload
const payload = {
  x: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2],
  steps: Array(12).fill(0.01),
  residual0: Array(10).fill(0.1),
  residualsPerturbed: Array(12).fill(null).map(() => Array(10).fill(0.12)),
  damping: 0.01,
  trustRegionRadius: 100,
  varScales: Array(12).fill(1),
};

console.log('✅ Testing WASM JSON string response\n');

const result = optimize_system_in_wasm(JSON.stringify(payload));

if (typeof result !== 'string') {
  console.error(`❌ WASM returned ${typeof result}, expected string`);
  process.exit(1);
}

console.log('  Raw response type: STRING ✓');

let parsed;
try {
  parsed = JSON.parse(result);
  console.log('  JSON.parse succeeded ✓');
} catch (e) {
  console.error(`❌ JSON.parse failed: ${e}`);
  process.exit(1);
}

console.log(`\n📦 Parsed fields:`);
console.log(`  ok: ${parsed.ok}`);
console.log(`  status: ${parsed.status}`);
console.log(`  dx: Array[${parsed.dx.length}] - first 3: [${parsed.dx.slice(0, 3).join(', ')}]`);
console.log(`  xNext: Array[${parsed.xNext.length}] - first 3: [${parsed.xNext.slice(0, 3).join(', ')}]`);
console.log(`  predictedReduction: ${parsed.predictedReduction}`);
console.log(`  jacobianShape: [${parsed.jacobianShape.join(', ')}]`);

if (parsed.ok && parsed.dx.length === 12 && parsed.xNext.length === 12) {
  console.log('\n✅ SUCCESS: WASM returns valid JSON with correct array sizes!');
  process.exit(0);
} else {
  console.log('\n❌ FAILED: Response structure invalid');
  delete parsed.dx;
  delete parsed.xNext;
  console.log('Full parsed:', parsed);
  process.exit(1);
}
