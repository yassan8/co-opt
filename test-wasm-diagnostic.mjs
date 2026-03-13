import fs from 'node:fs/promises';
import { preloadRustRayTracingWasm } from './rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';

async function test() {
  try {
    console.log('🔍 WASM Diagnostic Test\n');
    const rust = await preloadRustRayTracingWasm();
    const func = rust?.run_native_opd_map_wasm_json;
    
    if (!func) {
      console.error('❌ WASM function not available!');
      process.exit(1);
    }
    
    // Load default optical system
    const data = JSON.parse(await fs.readFile('./defaults/default-load.json', 'utf8'));
    
    // Test with gridSize=5 for simpler investigation
    const req = {
      opticalSystemRows: data.opticalSystem,
      sourceRows: data.source,
      objectRows: data.object,
      objectIndex: 0,
      gridSize: 5,  // Small grid for debugging
      wavelengthUm: 0.5875618,
      pupilSamplingMode: 'stop',
      opdDisplayMode: 'pistonTiltRemoved'
    };
    
    console.log(`Testing with gridSize=${req.gridSize}, wavelength=${req.wavelengthUm} µm\n`);
    
    const outRaw = func(JSON.stringify(req));
    const out = typeof outRaw === 'string' ? JSON.parse(outRaw) : outRaw;
    
    if (!out) {
      console.error('❌ No output from WASM');
      process.exit(1);
    }
    
    console.log('WASM Output Summary:');
    console.log(`  Backend: ${out.backend}`);
    console.log(`  Grid Size: ${out.gridSize}`);
    console.log(`  Sample Count: ${out.sampleCount}`);
    console.log(`  Hit Count: ${out.hitCount}`);
    console.log(`  Hit Rate: ${((out.hitCount / out.sampleCount) * 100).toFixed(1)}%\n`);
    
    // Analyze raw grid values
    const rawGrid = out.rawOpdGrid || [];
    const displayGrid = out.displayOpdGrid || [];
    
    console.log('Raw Grid Analysis:');
    let rawVals = [];
    let rawMin = Infinity, rawMax = -Infinity;
    for (let row of rawGrid) {
      for (let v of row) {
        if (Number.isFinite(v)) {
          rawVals.push(v);
          rawMin = Math.min(rawMin, v);
          rawMax = Math.max(rawMax, v);
        }
      }
    }
    if (rawVals.length > 0) {
      const rawRms = Math.sqrt(rawVals.reduce((a,b) => a+b*b, 0) / rawVals.length);
      const rawMean = rawVals.reduce((a,b) => a+b, 0) / rawVals.length;
      console.log(`  Count: ${rawVals.length}, Min: ${rawMin.toFixed(4)}, Max: ${rawMax.toFixed(4)}`);
      console.log(`  Mean: ${rawMean.toFixed(4)}, RMS: ${rawRms.toFixed(4)} λ`);
      console.log(`  First 5 values: ${rawVals.slice(0, 5).map(v => v.toFixed(2)).join(', ')}`);
    } else {
      console.log('  ❌ No finite raw values!');
    }
    
    console.log('\nDisplay Grid Analysis:');
    let dispVals = [];
    let dispMin = Infinity, dispMax = -Infinity;
    for (let row of displayGrid) {
      for (let v of row) {
        if (Number.isFinite(v)) {
          dispVals.push(v);
          dispMin = Math.min(dispMin, v);
          dispMax = Math.max(dispMax, v);
        }
      }
    }
    if (dispVals.length > 0) {
      const dispRms = Math.sqrt(dispVals.reduce((a,b) => a+b*b, 0) / dispVals.length);
      const dispMean = dispVals.reduce((a,b) => a+b, 0) / dispVals.length;
      console.log(`  Count: ${dispVals.length}, Min: ${dispMin.toFixed(4)}, Max: ${dispMax.toFixed(4)}`);
      console.log(`  Mean: ${dispMean.toFixed(4)}, RMS: ${dispRms.toFixed(4)} λ`);
      console.log(`  First 5 values: ${dispVals.slice(0, 5).map(v => v.toFixed(2)).join(', ')}`);
    } else {
      console.log('  ❌ No finite display values!');
    }
    
    // Estimate chief OPL
    if (out.message) {
      console.log(`\nWASM Message: ${out.message}`);
    }
    
  } catch (e) {
    console.error('ERROR:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

test();
