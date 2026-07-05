import fs from 'node:fs';
import { expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';

const inputPath = '\\\\SynologyNAS\\Temp\\lens_data\\3G_IMAGES_02.json';
const cfg = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const activeCfg = cfg.configurations.configurations[0];
const blocks = activeCfg.blocks;
const rows = activeCfg.opticalSystem;

const { rows: expanded, issues } = expandBlocksToOpticalSystemRows(blocks);

console.log('issues:', JSON.stringify(issues, null, 2));

function pick(r) {
  if (!r) return null;
  return {
    id: r.id, surfType: r.surfType, radius: r.radius, semidia: r.semidia,
    qconNrad: r.qconNrad, conic: r.conic,
    coef1: r.coef1, coef2: r.coef2, coef3: r.coef3, coef4: r.coef4,
  };
}

// Find the Qcon surface in both.
const rowQcon = rows.find((r) => String(r.surfType) === 'Qcon');
const expQconIdx = expanded.findIndex((r) => String(r.surfType) === 'Qcon');
console.log('\n=== ORIGINAL opticalSystem Qcon row ===');
console.log(JSON.stringify(pick(rowQcon), null, 2));
console.log('\n=== EXPANDED-FROM-BLOCKS Qcon row (index ' + expQconIdx + ') ===');
console.log(JSON.stringify(pick(expanded[expQconIdx]), null, 2));

console.log('\n=== expanded count vs original count:', expanded.length, rows.length, '===');
console.log('\n=== ALL expanded surfTypes ===');
console.log(expanded.map((r, i) => `${i}:${r.surfType}(r=${r.radius})`).join('\n'));
