import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultDirectory = path.join(projectRoot, 'diagnostics', 'results');
const maps = [
  { wavelength: 1, limitMicron: 6.5 },
  { wavelength: 2, limitMicron: 2.4 },
  { wavelength: 3, limitMicron: 5.0 },
];
const modes = ['', '-pistonRemoved', '-pistonTiltRemoved', '-pistonDefocusRemoved', '-pistonTiltDefocusRemoved'];
const size = 640;
const cellSize = size / 129;

function colorFor(value, limit) {
  const normalized = Math.max(-1, Math.min(1, Number(value) / limit));
  const hue = 240 - (normalized + 1) * 120;
  return `hsl(${hue.toFixed(1)} 100% 50%)`;
}

function parseCsv(text) {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const columns = header.split(',');
  return lines.map((line) => {
    const values = line.split(',');
    return Object.fromEntries(columns.map((column, index) => [column, values[index] ?? '']));
  });
}

for (const map of maps) {
  for (const mode of modes) {
  const csvPath = path.join(resultDirectory, `wav-map-field-6-w${map.wavelength}${mode}.csv`);
  try {
    await fs.access(csvPath);
  } catch {
    continue;
  }
  const csv = parseCsv(await fs.readFile(csvPath, 'utf8'));
  const cells = csv.flatMap((row) => {
    if (row.displayMicron === '') return [];
    const x = (Number(row.xNormalized) + 1) * size / 2;
    const y = (1 - Number(row.yNormalized)) * size / 2;
    return [`<rect x="${(x - cellSize / 2).toFixed(3)}" y="${(y - cellSize / 2).toFixed(3)}" width="${(cellSize + 0.2).toFixed(3)}" height="${(cellSize + 0.2).toFixed(3)}" fill="${colorFor(row.displayMicron, map.limitMicron)}"/>`];
  });
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size + 150}" height="${size + 70}" viewBox="0 0 ${size + 150} ${size + 70}">
  <rect width="100%" height="100%" fill="#888"/>
  <g transform="translate(20 20)">${cells.join('')}</g>
  <text x="20" y="${size + 48}" font-family="sans-serif" font-size="16" fill="#111">Field 6 / W${map.wavelength} / displayMicron</text>
  <text x="${size + 35}" y="35" font-family="sans-serif" font-size="14" fill="#111">+${map.limitMicron} um</text>
  <rect x="${size + 20}" y="45" width="18" height="${size}" fill="url(#scale)"/>
  <text x="${size + 35}" y="${size + 62}" font-family="sans-serif" font-size="14" fill="#111">-${map.limitMicron} um</text>
  <defs><linearGradient id="scale" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(0 100% 50%)"/><stop offset="0.5" stop-color="hsl(120 100% 50%)"/><stop offset="1" stop-color="hsl(240 100% 50%)"/></linearGradient></defs>
</svg>
`;
  const outputPath = path.join(resultDirectory, `wav-map-field-6-w${map.wavelength}${mode}.svg`);
  await fs.writeFile(outputPath, svg, 'utf8');
  console.log(outputPath);
  }
}
