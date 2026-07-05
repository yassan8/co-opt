// Diagnostic: import the real 3G .zmx source and dump surfaces 12/13 (Qcon).
// Run: node --experimental-strip-types diagnostics/qcon-import-real-zmx.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseZMXTextToOpticalSystemRows } from '../import-export/zemax-import.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zmxPath = path.join(__dirname, '3g_images_source.zmx');
const text = fs.readFileSync(zmxPath, 'utf8');

const result = parseZMXTextToOpticalSystemRows(text, {});
const rows = result.rows || [];

console.log('=== ISSUES ===');
for (const iss of (result.issues || [])) {
  console.log(`  [${iss.severity}] ${iss.message}`);
}

const coefKeys = Array.from({ length: 10 }, (_, i) => `coef${i + 1}`);
function dump(row, label) {
  if (!row) { console.log(`${label}: (missing)`); return; }
  const coefs = coefKeys.map(k => row[k]);
  console.log(`${label}: id=${row.id} surfType=${JSON.stringify(row.surfType)} radius=${row.radius} `
    + `conic=${JSON.stringify(row.conic)} qconNrad=${JSON.stringify(row.qconNrad)} `
    + `material=${JSON.stringify(row.material)}`);
  console.log(`    coef1..10 = ${JSON.stringify(coefs)}`);
}

console.log('\n=== ALL SURFTYPES ===');
rows.forEach((r, i) => console.log(`  row[${i}] id=${r.id} surfType=${JSON.stringify(r.surfType)} radius=${r.radius}`));

console.log('\n=== QCON SURFACES (source SURF 12 / 13) ===');
// Find rows by radius signature
const front = rows.find(r => String(r.radius).includes('19.780') || String(r.radius).includes('-19.78'));
const back = rows.find(r => String(r.radius).includes('55.354') || String(r.radius).includes('-55.35'));
dump(front, 'SURF12 front (r ~ -19.78)');
dump(back, 'SURF13 back  (r ~ -55.35)');

console.log('\n=== EXPECTED (from .zmx XDAT 4-10) ===');
console.log('  SURF12 coefs: [1.04543217, 1.80472429, 0.339289379, -0.245947139, -0.320303330, -0.150543431, -0.0394380297]');
console.log('  SURF13 coefs: [1.98950194, 0.672366625, 0.194094848, 0.113035204, 0.0288526524, 0.00855756778, -0.00173184141]');
