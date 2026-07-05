import fs from 'node:fs';
import { traceRay } from '../raytracing/core/ray-tracing.ts';

const inputPath = '\\\\SynologyNAS\\Temp\\lens_data\\3G_IMAGES_02.json';
const cfg = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const optical = cfg.opticalSystem || cfg?.configurations?.configurations?.[0]?.opticalSystem;
const src = (cfg.source || []).find((s) => String(s.primary || '').toLowerCase().includes('primary')) || cfg.source?.[0];
const wavelength = Number(src?.wavelength) || 0.55;

function extractSurf(debugLog, surfNo) {
  const startIdx = debugLog.findIndex((l) => l.includes(`=== SURFACE ${surfNo} `));
  if (startIdx < 0) return `(surface ${surfNo} not reached)`;
  const endIdx = debugLog.findIndex((l, i) => i > startIdx && l.includes('=== SURFACE '));
  return debugLog.slice(startIdx, endIdx < 0 ? debugLog.length : endIdx)
    .filter((l) => /Type|Refraction|Intersect|Iter|Normal|APERTURE|BLOCK|Qcon|sag|semi-dia|radius/.test(l))
    .join('\n');
}

for (const useRust of [false, true]) {
  for (const h of [1, 2, 3]) {
    const ray = { pos: { x: 0, y: h, z: 0 }, dir: { x: 0, y: 0, z: 1 }, wavelength };
    const debugLog = [];
    const res = traceRay(optical, ray, 1.0, debugLog, null, useRust ? { useRustWasm: true } : null);
    const reached = debugLog.some((l) => l.includes('=== SURFACE 12'));
    console.log(`\n########## rust=${useRust} height=${h} reachedS12=${reached} finalBlocked=${res?.blocked ?? '?'} ##########`);
    console.log('--- SURFACE 12 (Qcon) ---');
    console.log(extractSurf(debugLog, 12));
  }
}
