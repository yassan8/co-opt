import fs from 'node:fs';
import path from 'node:path';

const imageDir = process.argv[2] ?? 'diagnostics/results/optalix-image';
const cooptDir = process.argv[3] ?? 'diagnostics/results';
const modes = ['', '-pistonRemoved', '-pistonTiltRemoved', '-pistonDefocusRemoved', '-pistonTiltDefocusRemoved'];

function readCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
  const headers = lines.shift().split(',');
  return lines.map((line) => {
    const fields = line.split(',');
    return Object.fromEntries(headers.map((header, index) => [header, fields[index] ?? '']));
  });
}

function key(x, y) {
  return `${Number(x).toFixed(6)},${Number(y).toFixed(6)}`;
}

function correlation(xs, ys) {
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  return xy / Math.sqrt(xx * yy);
}

function fitError(xs, ys) {
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i += 1) {
    numerator += (xs[i] - xMean) * (ys[i] - yMean);
    denominator += (xs[i] - xMean) ** 2;
  }
  const scale = numerator / denominator;
  const offset = yMean - scale * xMean;
  const rms = Math.sqrt(ys.reduce((sum, y, i) => sum + (y - (scale * xs[i] + offset)) ** 2, 0) / ys.length);
  return { scale, offset, rms };
}

for (const wavelength of ['w1', 'w2', 'w3']) {
  const imageRows = readCsv(path.join(imageDir, `${wavelength}.csv`));
  const imageMap = new Map(imageRows.filter((row) => row.levelMicron !== '').map((row) => [key(row.xNormalized, row.yNormalized), Number(row.levelMicron)]));
  const results = [];
  for (const mode of modes) {
    const cooptPath = path.join(cooptDir, `wav-map-field-6-${wavelength}${mode}.csv`);
    if (!fs.existsSync(cooptPath)) continue;
    const cooptRows = readCsv(cooptPath);
    const cooptMap = new Map(cooptRows.filter((row) => row.displayMicron !== '').map((row) => [key(row.xNormalized, row.yNormalized), Number(row.displayMicron)]));
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        const xs = [];
        const ys = [];
        for (const [coordinate, imageValue] of imageMap) {
          const [x, y] = coordinate.split(',').map(Number);
          const transformed = key(flipX ? -x : x, flipY ? -y : y);
          const cooptValue = cooptMap.get(transformed);
          if (cooptValue == null) continue;
          xs.push(cooptValue);
          ys.push(imageValue);
        }
        if (xs.length < 20) continue;
        const fit = fitError(xs, ys);
        results.push({ mode: mode || 'raw', flipX, flipY, count: xs.length, correlation: correlation(xs, ys), ...fit });
      }
    }
  }
  results.sort((a, b) => b.correlation - a.correlation);
  console.log(`\n${wavelength}`);
  for (const result of results.slice(0, 8)) {
    console.log(`${result.mode.padEnd(25)} flipX=${String(result.flipX).padEnd(5)} flipY=${String(result.flipY).padEnd(5)} n=${String(result.count).padStart(4)} r=${result.correlation.toFixed(4)} scale=${result.scale.toFixed(4)} offset=${result.offset.toFixed(4)} fitRms=${result.rms.toFixed(4)}`);
  }
}