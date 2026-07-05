import fs from 'node:fs';
import { traceRay } from '../raytracing/core/ray-tracing.ts';

// Load the user's imported Zemax JSON directly.
const inputPath = process.argv.find((a, i) => i >= 2 && !String(a).startsWith('--'))
  || '\\\\SynologyNAS\\Temp\\lens_data\\3G_IMAGES_02.json';
const forceRust = process.argv.includes('--rust');
const cfg = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

// importRowsPreferred => use the top-level opticalSystem rows directly (what render uses).
const optical = cfg.opticalSystem
  || cfg?.configurations?.configurations?.[0]?.opticalSystem;

const src = (cfg.source || []).find((s) => String(s.primary || '').toLowerCase().includes('primary')) || cfg.source?.[0];
const wavelength = Number(src?.wavelength) || 0.55;

console.log('=== SURFACE 12 (Qcon) row as imported ===');
const q = optical.find((r) => Number(r.id) === 12);
console.log(JSON.stringify({
  surfType: q.surfType, radius: q.radius, semidia: q.semidia,
  qconNrad: q.qconNrad, conic: q.conic,
  coef1: q.coef1, coef2: q.coef2, coef3: q.coef3, coef4: q.coef4,
  types: {
    qconNrad: typeof q.qconNrad, coef1: typeof q.coef1, radius: typeof q.radius,
  },
}, null, 2));

function traceAt(y, label) {
  const ray = { pos: { x: 0, y, z: 0 }, dir: { x: 0, y: 0, z: 1 }, wavelength };
  const debugLog = [];
  traceRay(optical, ray, 1.0, debugLog, null, forceRust ? { useRustWasm: true } : null);
  console.log(`\n===== ${label} (y=${y}) rust=${forceRust} =====`);
  for (const line of debugLog) {
    if (
      /=== SURFACE (11|12|13|14)/.test(line) ||
      line.includes('Qcon') || line.includes('QconTrace') ||
      line.includes('Refraction:') || line.includes('Intersection') ||
      line.includes('Normal') || line.includes('mode') ||
      line.includes('TOTAL INTERNAL')
    ) {
      console.log(line);
    }
  }
}

traceAt(10, 'meridional ray height 10');
