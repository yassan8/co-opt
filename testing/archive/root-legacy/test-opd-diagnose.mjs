import fs from 'node:fs/promises';
import { preloadRustRayTracingWasm } from './rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';

async function test() {
  const rust = await preloadRustRayTracingWasm();
  const func = rust?.run_native_opd_map_wasm_json;
  if (!func) { console.error('No WASM func'); process.exit(1); }

  const data = JSON.parse(await fs.readFile('./defaults/default-load.json', 'utf8'));
  const req = {
    opticalSystemRows: data.opticalSystem,
    sourceRows: data.source,
    objectRows: data.object,
    objectIndex: 0,
    gridSize: 17,  // small grid for speed
    wavelengthUm: 0.5875618,
    pupilSamplingMode: 'stop',
    opdDisplayMode: 'pistonTiltRemoved'
  };

  const outRaw = func(JSON.stringify(req));
  const out = typeof outRaw === 'string' ? JSON.parse(outRaw) : outRaw;

  console.log('chiefOplUm:', out.chiefOplUm);
  console.log('pupilSamplingMode:', out.pupilSamplingMode);
  console.log('chiefReferenceMode:', out.chiefReferenceMode);
  console.log('hitCount:', out.hitCount, '/', out.sampleCount);

  // Print debug chief trace
  const dt = out.debugChiefTrace;
  if (dt && dt.length > 0) {
    console.log('\nPer-surface chief ray trace:');
    for (const s of dt) {
      if (s.skip) {
        console.log(`  s${s.i}: kind=${s.kind} SKIP origin_z=${s.origin_z?.toFixed(4)}`);
      } else {
        const opl = s.opl_contrib != null ? s.opl_contrib.toFixed(2) : '?';
        console.log(`  s${s.i}: r=${s.r?.toFixed(3)} oz=${s.origin_z?.toFixed(4)} pz=${s.pz?.toFixed(4)} lpz=${s.lpz?.toFixed(6)} t=${s.t?.toFixed(6)} n=${s.n_cur?.toFixed(4)} oplContrib=${opl} oplAcc=${s.opl_acc?.toFixed(2)}`);
      }
    }
  }

  // Print raw OPD grid (before display mode)
  const raw = out.rawOpdGrid;
  const rawVals = [];
  for (const row of (raw || [])) {
    for (const v of (row || [])) {
      if (v !== null && Number.isFinite(v)) rawVals.push(v);
    }
  }
  if (rawVals.length > 0) {
    const mean = rawVals.reduce((a,b)=>a+b,0) / rawVals.length;
    const rms = Math.sqrt(rawVals.reduce((a,b)=>a+b*b,0) / rawVals.length);
    const min = Math.min(...rawVals);
    const max = Math.max(...rawVals);
    console.log('\nRaw OPD (before display mode):');
    console.log('  mean:', mean.toFixed(4), 'λ');
    console.log('  RMS:', rms.toFixed(4), 'λ');
    console.log('  min:', min.toFixed(4), 'λ');
    console.log('  max:', max.toFixed(4), 'λ');
    console.log('  range:', (max-min).toFixed(4), 'λ');
    // Print first few samples
    console.log('  first 5:', rawVals.slice(0,5).map(v=>v.toFixed(4)).join(', '));
  }

  // Display OPD
  const disp = out.displayOpdGrid;
  const dispVals = [];
  for (const row of (disp || [])) {
    for (const v of (row || [])) {
      if (v !== null && Number.isFinite(v)) dispVals.push(v);
    }
  }
  if (dispVals.length > 0) {
    const rms = Math.sqrt(dispVals.reduce((a,b)=>a+b*b,0) / dispVals.length);
    const min = Math.min(...dispVals);
    const max = Math.max(...dispVals);
    console.log('\nDisplay OPD (pistonTiltRemoved):');
    console.log('  RMS:', rms.toFixed(4), 'λ');
    console.log('  min:', min.toFixed(4), 'λ');
    console.log('  max:', max.toFixed(4), 'λ');
    console.log('  range:', (max-min).toFixed(4), 'λ');
  }
}

test().catch(e => { console.error(e); process.exit(1); });
