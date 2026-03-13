import fs from 'node:fs/promises';
import { preloadRustRayTracingWasm } from './rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';

async function test() {
  try {
    console.log('🧪 Loading WASM module...');
    const rust = await preloadRustRayTracingWasm();
    const func = rust?.run_native_opd_map_wasm_json;
    
    if (!func) {
      console.error('❌ run_native_opd_map_wasm_json NOT available!');
      process.exit(1);
    }
    
    console.log('✅ WASM function loaded');
    
    // Load default optical system
    const data = JSON.parse(await fs.readFile('./defaults/default-load.json', 'utf8'));
    
    const req = {
      opticalSystemRows: data.opticalSystem,
      sourceRows: data.source,
      objectRows: data.object,
      objectIndex: 0,
      gridSize: 129,
      wavelengthUm: 0.5875618,
      pupilSamplingMode: 'stop',
      opdDisplayMode: 'pistonTiltRemoved'
    };
    
    console.log('Calling WASM with gridSize=129...');
    let outRaw;
    let out;
    try {
      outRaw = func(JSON.stringify(req));
      if (!outRaw) {
        console.error('❌ WASM returned null/undefined!');
        console.error('Raw result:', outRaw);
        process.exit(1);
      }
      out = typeof outRaw === 'string' ? JSON.parse(outRaw) : outRaw;
    } catch (parseErr) {
      console.error('❌ Failed to parse WASM result:', parseErr.message);
      console.error('Raw output:', outRaw);
      process.exit(1);
    }
    
    console.log('\nWASM returned:');
    console.log('  backend:', out.backend);
    console.log('  gridSize:', out.gridSize);
    console.log('  sampleCount:', out.sampleCount);
    console.log('  hitCount:', out.hitCount);
    console.log('  hasDisplayGrid:', !!out.displayOpdGrid);
    
    // Calculate RMS from displayOpdGrid
    const vals = [];
    for (const row of (out.displayOpdGrid || [])) {
      for (const v of (row || [])) {
        if (Number.isFinite(v)) vals.push(v);
      }
    }
    
    if (vals.length > 0) {
      const rms = Math.sqrt(vals.reduce((a,b) => a+b*b, 0) / vals.length);
      console.log('  RMS from grid:', rms.toFixed(4), 'λ');
      if (Math.abs(rms - 0.59) < 1) {
        console.log('  ✅ WASM is CORRECT!');
      } else {
        console.log('  ❌ RMS is way off! Expected ~0.59 λ, got', rms.toFixed(4), 'λ');
      }
    } else {
      console.log('  ❌ No finite values in displayOpdGrid!');
    }
  } catch (e) {
    console.error('ERROR:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}

test();
