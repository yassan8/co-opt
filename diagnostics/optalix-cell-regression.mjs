import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(projectRoot, 'diagnostics', 'fixtures', 'coopt-cell-results.json');
const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
const modes = ['raw', 'piston', 'pistonDefocus', 'pistonDefocusScaled0895'];
const expected = {
  11: { raw: 1.35322, piston: 0.67950, pistonDefocus: 0.27275, pistonDefocusScaled0895: 0.30197 }
};
const failures = [];
let cellCount = 0;
let measuredValueCount = 0;

for (let field = 1; field <= 11; field += 1) {
  for (let wavelength = 1; wavelength <= 3; wavelength += 1) {
    const cell = fixture?.[field]?.[wavelength];
    cellCount += 1;
    if (!cell) {
      failures.push(`missing Field ${field} Wavelength ${wavelength}`);
      continue;
    }
    for (const mode of modes) {
      const value = Number(cell[mode]);
      if (!Number.isFinite(value)) {
        failures.push(`missing ${mode} at Field ${field} Wavelength ${wavelength}`);
      } else {
        measuredValueCount += 1;
      }
    }
  }
}

for (const [field, values] of Object.entries(expected)) {
  for (const [mode, expectedValue] of Object.entries(values)) {
    const actual = Number(fixture?.[field]?.[3]?.[mode]);
    if (!Number.isFinite(actual) || Math.abs(actual - expectedValue) > 1e-9) {
      failures.push(`Field ${field} Wavelength 3 ${mode}: expected ${expectedValue}, got ${actual}`);
    }
  }
}

if (cellCount !== 33) failures.push(`expected 33 cells, got ${cellCount}`);
if (measuredValueCount !== 132) failures.push(`expected 132 measured values, got ${measuredValueCount}`);
if (failures.length > 0) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  fixture: path.relative(projectRoot, fixturePath),
  cellCount,
  measuredValueCount,
  anchor: { field: 11, wavelength: 3, ...fixture[11][3] }
}, null, 2));
