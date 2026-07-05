import fs from 'node:fs';
import { traceRay } from '../raytracing/core/ray-tracing.ts';

const defaultCfgPath = new URL('../dist/attached-repro-3g-v3.json', import.meta.url);
const argPath = process.argv.find((a, i) => i >= 2 && !String(a).startsWith('--'));
const forceRust = process.argv.includes('--rust');
const inputPath = argPath ? argPath : defaultCfgPath;
const cfg = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const optical = cfg.opticalSystem || cfg?.configurations?.configurations?.[0]?.opticalSystem;
const src = (cfg.source || []).find((s) => String(s.primary || '').toLowerCase().includes('primary')) || cfg.source?.[0];
const wavelength = Number(src?.wavelength) || 0.55;

const ray = {
  pos: { x: 0, y: 5, z: 0 },
  dir: { x: 0, y: 0, z: 1 },
  wavelength,
};

const debugLog = [];
traceRay(optical, ray, 1.0, debugLog, null, forceRust ? { useRustWasm: true } : null);

for (const line of debugLog) {
  if (
    line.includes('=== SURFACE') ||
    line.includes('Material field:') ||
    line.includes('Refraction:') ||
    line.includes('TOTAL INTERNAL REFLECTION') ||
    line.includes('Stop/Image/Eval') ||
    line.includes('QconTrace')
  ) {
    console.log(line);
  }
}
