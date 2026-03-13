import fs from 'node:fs/promises';
import { preloadRustRayTracingWasm } from './rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';

const data = JSON.parse(await fs.readFile('./defaults/default-load.json', 'utf8'));
const rust = await preloadRustRayTracingWasm();
const func = rust?.run_native_opd_map_wasm_json;
if (!func) { console.error('WASM not available'); process.exit(1); }

const rmsOf = (grid) => {
  const vals = [];
  for (const row of (grid || [])) for (const v of (row || [])) if (Number.isFinite(v)) vals.push(v);
  return { rms: vals.length ? Math.sqrt(vals.reduce((a, b) => a + b * b, 0) / vals.length) : NaN, n: vals.length };
};

async function run(label, overrides) {
  const req = {
    opticalSystemRows: data.opticalSystem,
    sourceRows: data.source,
    objectRows: data.object,
    objectIndex: 0,
    gridSize: 129,
    wavelengthUm: 0.5875618,
    pupilSamplingMode: 'stop',
    opdDisplayMode: 'pistonTiltRemoved',
    ...overrides,
  };
  const raw = func(JSON.stringify(req));
  const out = (typeof raw === 'string') ? JSON.parse(raw) : raw;
  const d = rmsOf(out.displayOpdGrid);
  console.log(`[${label}] RMS=${d.rms.toFixed(4)}λ  pts=${d.n}  stopSurface=${out.stopSurface}  hitCount=${out.hitCount}/${out.sampleCount}`);
}

// Baseline (no explicit stopSurfaceIndex)
await run('baseline g129, no explicit stop', {});
// With explicit stop=14
await run('g129  stop=14', { stopSurfaceIndex: 14 });
// Wrong stop=0
await run('g129  stop=0',  { stopSurfaceIndex: 0 });
// Web-like: g257 stop=14 wl=0.5876
await run('g257  stop=14 wl=0.5876', { gridSize: 257, stopSurfaceIndex: 14, wavelengthUm: 0.5876 });
// Web-like: g257 no explicit stop wl=0.5876
await run('g257  no stop  wl=0.5876', { gridSize: 257, wavelengthUm: 0.5876 });
