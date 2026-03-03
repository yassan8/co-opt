#!/usr/bin/env node

/**
 * Direct WASM payload diagnostic
 * Inspects raw return types from optimize_system_in_wasm
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import and initialize WASM module with explicit binary path
import init, { optimize_system_in_wasm } from './rust-wasm/pkg/surface_origins.js';

const wasmBinaryPath = path.join(__dirname, 'rust-wasm', 'pkg', 'surface_origins_bg.wasm');
const wasmBuffer = fs.readFileSync(wasmBinaryPath);

// Initialize WASM module with buffer
await init(wasmBuffer);

// Create a minimal valid payload
const payload = {
  x: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2],
  steps: Array(12).fill(1),
  residual0: Array(10).fill(0.1),
  residualsPerturbed: Array(12).fill(null).map(() => Array(10).fill(0.12)),
  damping: 0.01,
  trustRegionRadius: 100,
  varScales: Array(12).fill(1),
};

console.log('📊 WASM Payload Diagnosis\n');
console.log('Input shape:');
console.log(`  x: length=${payload.x.length}`);
console.log(`  residual0: length=${payload.residual0.length}`);
console.log(`  residualsPerturbed: [${payload.residualsPerturbed.length}][${payload.residualsPerturbed[0]?.length || 0}]`);
console.log(`  damping=${payload.damping}, trustRegionRadius=${payload.trustRegionRadius}`);

try {
  console.log('\n🔍 Calling optimize_system_in_wasm...');
  const raw = optimize_system_in_wasm(JSON.stringify(payload));

  console.log('\n📦 Raw return value:');
  console.log(`  Type: ${typeof raw}`);
  console.log(`  Constructor: ${raw?.constructor?.name}`);
  console.log(`  Is Object: ${raw && typeof raw === 'object'}`);

  if (raw && typeof raw === 'object') {
    console.log('\n✓ Parsing return object:');
    
    const fields = ['ok', 'status', 'dx', 'xNext', 'predictedReduction', 'jacobianShape', 'usedDamping', 'usedTrustRegionRadius'];
    for (const field of fields) {
      const val = raw[field];
      const type = typeof val;
      if (Array.isArray(val)) {
        console.log(`  ${field}: Array[${val.length}], first 3 items: ${JSON.stringify(val.slice(0, 3))}`);
      } else if (ArrayBuffer.isView(val)) {
        console.log(`  ${field}: ${val.constructor.name}[${val.length}], first 3: ${Array.from(val).slice(0, 3)}`);
      } else if (type === 'object' && val && typeof val[Symbol.iterator] === 'function') {
        const arr = Array.from(val);
        console.log(`  ${field}: Iterable[${arr.length}], first 3: ${JSON.stringify(arr.slice(0, 3))}`);
      } else {
        console.log(`  ${field}: ${type} = ${JSON.stringify(val)}`);
      }
    }

    // Simulate the normalizeNumericVector logic
    console.log('\n🔧 Normalizing dx (simulating bridge parser):');
    const dx = raw.dx;
    if (Array.isArray(dx)) {
      const normalized = dx.map((item) => Number(item)).filter((item) => Number.isFinite(item));
      console.log(`  Input: Array[${dx.length}]`);
      console.log(`  Output: Array[${normalized.length}]`);
      console.log(`  First 3 elements: ${JSON.stringify(normalized.slice(0, 3))}`);
    } else if (ArrayBuffer.isView(dx) && typeof dx.length === 'number') {
      const normalized = Array.from(dx).map((item) => Number(item)).filter((item) => Number.isFinite(item));
      console.log(`  Input: ${dx.constructor.name}[${dx.length}]`);
      console.log(`  Output: Array[${normalized.length}]`);
      console.log(`  First 3 elements: ${JSON.stringify(normalized.slice(0, 3))}`);
    } else if (dx && typeof dx === 'object' && typeof dx[Symbol.iterator] === 'function') {
      const normalized = Array.from(dx).map((item) => Number(item)).filter((item) => Number.isFinite(item));
      console.log(`  Input: Custom Iterable[?]`);
      console.log(`  Output: Array[${normalized.length}]`);
      console.log(`  First 3 elements: ${JSON.stringify(normalized.slice(0, 3))}`);
    } else {
      console.log(`  Input: ${typeof dx}, cannot normalize`);
    }

    console.log('\n✅ Diagnosis complete. If dx shows as Float64Array or Iterable, parser fix handles it.');
  } else {
    console.log('\n❌ Raw returned non-object: ' + JSON.stringify(raw));
  }
} catch (err) {
  console.error('\n❌ Error:', err.message);
  console.error(err.stack);
}
