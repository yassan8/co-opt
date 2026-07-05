import fs from 'node:fs';
import { traceRay } from '../raytracing/core/ray-tracing.ts';

const inputPath = process.argv.find((a, i) => i >= 2 && !String(a).startsWith('--'))
  || '\\\\SynologyNAS\\Temp\\lens_data\\3G_IMAGES_02.json';
const forceRust = process.argv.includes('--rust');
const cfg = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const optical = cfg.opticalSystem || cfg?.configurations?.configurations?.[0]?.opticalSystem;
const src = (cfg.source || []).find((s) => String(s.primary || '').toLowerCase().includes('primary')) || cfg.source?.[0];
const wavelength = Number(src?.wavelength) || 0.55;

const ray = { pos: { x: 0, y: 10, z: 0 }, dir: { x: 0, y: 0, z: 1 }, wavelength };
const debugLog = [];
traceRay(optical, ray, 1.0, debugLog, null, forceRust ? { useRustWasm: true } : null);
fs.writeFileSync('diagnostics/results/qcon-trace-dump.txt', debugLog.join('\n'), 'utf8');
console.log('lines:', debugLog.length, 'rust:', forceRust);
