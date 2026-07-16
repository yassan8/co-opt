import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const inputPath = process.argv[2] ?? 'data/wav f6.png';
const outputDir = process.argv[3] ?? 'diagnostics/results/optalix-image';

function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error('Unsupported PNG signature');
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType)) throw new Error(`Unsupported PNG format: depth=${bitDepth} colorType=${colorType}`);
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  let rawOffset = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset++];
    const row = Buffer.from(raw.subarray(rawOffset, rawOffset + stride));
    rawOffset += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= channels ? previous[i - channels] : 0;
      if (filter === 1) row[i] = (row[i] + left) & 255;
      else if (filter === 2) row[i] = (row[i] + up) & 255;
      else if (filter === 3) row[i] = (row[i] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        row[i] = (row[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
      } else if (filter !== 0) throw new Error(`Unsupported PNG filter: ${filter}`);
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      pixels[target] = row[source];
      pixels[target + 1] = row[source + 1];
      pixels[target + 2] = row[source + 2];
      pixels[target + 3] = channels === 4 ? row[source + 3] : 255;
    }
    previous = row;
  }
  return { width, height, data: pixels };
}

const image = decodePng(fs.readFileSync(inputPath));
fs.mkdirSync(outputDir, { recursive: true });

const panels = [
  {
    name: 'w1',
    x0: 635, x1: 1790, y0: 445, y1: 1740,
    levels: [0.67396, 0.63184, 0.58972, 0.54759, 0.50547, 0.46335, 0.42123, 0.37910, 0.33698, 0.29486, 0.25274, 0.21061, 0.16849, 0.12637, 0.08425, 0.04212],
  },
  {
    name: 'w2',
    x0: 2670, x1: 3835, y0: 445, y1: 1740,
    levels: [0.85911, 0.80541, 0.75172, 0.69802, 0.64433, 0.59064, 0.53694, 0.48325, 0.42955, 0.37586, 0.32217, 0.26847, 0.21478, 0.16108, 0.10739, 0.05369],
  },
  {
    name: 'w3',
    x0: 635, x1: 1790, y0: 2110, y1: 3405,
    levels: [0.65990, 0.61866, 0.57742, 0.53617, 0.49493, 0.45368, 0.41244, 0.37120, 0.32995, 0.28871, 0.24746, 0.20622, 0.16498, 0.12373, 0.08249, 0.04124],
  },
];

function pixel(x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

function colorDistance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function classify(rgb, palette) {
  const spread = Math.max(...rgb) - Math.min(...rgb);
  if (spread < 30 || Math.min(...rgb) > 245) return null;
  let best = null;
  for (let i = 0; i < palette.length; i += 1) {
    const distance = colorDistance(rgb, palette[i]);
    if (!best || distance < best.distance) best = { index: i, distance };
  }
  return best?.distance <= 110 ? best.index : null;
}

function csvValue(value) {
  return value == null ? '' : value.toFixed(6);
}

for (const panel of panels) {
  const palette = [
    [254, 0, 0], [254, 47, 0], [254, 95, 0], [254, 142, 0],
    [254, 190, 0], [254, 238, 0], [222, 254, 31], [174, 254, 79],
    [127, 254, 126], [79, 254, 174], [31, 254, 222], [0, 238, 254],
    [0, 190, 254], [0, 142, 254], [0, 95, 254], [0, 47, 254],
  ];
  const rows = ['xNormalized,yNormalized,levelMicron,confidence'];
  for (let iy = 0; iy < 129; iy += 1) {
    const y = Math.round(panel.y0 + (panel.y1 - panel.y0) * iy / 128);
    for (let ix = 0; ix < 129; ix += 1) {
      const x = Math.round(panel.x0 + (panel.x1 - panel.x0) * ix / 128);
      let best = null;
      for (let dy = -8; dy <= 8; dy += 1) {
        for (let dx = -8; dx <= 8; dx += 1) {
          const candidate = classify(pixel(x + dx, y + dy), palette);
          if (candidate == null) continue;
          const distance = Math.hypot(dx, dy);
          if (!best || distance < best.distance) best = { index: candidate, distance };
        }
      }
      const value = best ? panel.levels[Math.min(best.index, panel.levels.length - 1)] : null;
      rows.push(`${(-1 + 2 * ix / 128).toFixed(6)},${(1 - 2 * iy / 128).toFixed(6)},${csvValue(value)},${best ? (1 / (1 + best.distance)).toFixed(6) : ''}`);
    }
  }
  fs.writeFileSync(path.join(outputDir, `${panel.name}.csv`), `${rows.join('\n')}\n`);
  console.log(`${panel.name}: palette=${palette.map((rgb) => rgb.join('/')).join(' ')} output=${path.join(outputDir, `${panel.name}.csv`)}`);
}