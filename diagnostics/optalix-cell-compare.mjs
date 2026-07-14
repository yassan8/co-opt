import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const defaultReferencePath = path.join(__dirname, 'fixtures', 'optalix-3g-images-87-03.json');

const args = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value === undefined || String(value).startsWith('--') ? 'true' : value;
};

const resolvePath = (value, fallback) => path.resolve(projectRoot, value || fallback);
const finite = (value) => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const modes = ['raw', 'piston', 'pistonDefocus', 'pistonDefocusScaled0895'];

const referencePath = resolvePath(getArg('reference'), defaultReferencePath);
const inputPath = getArg('input');
const outputPath = resolvePath(getArg('out'), `diagnostics/results/optalix-cell-compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const reference = JSON.parse(await fs.readFile(referencePath, 'utf8'));
const templatePath = getArg('template');

if (templatePath) {
  const template = {
    cells: reference.rmsWaves.flatMap((row, fieldIndex) => row.map((_, wavelengthIndex) => ({
      field: fieldIndex + 1,
      wavelength: wavelengthIndex + 1,
      raw: null,
      piston: null,
      pistonDefocus: null,
      pistonDefocusScaled0895: null
    })))
  };
  const resolvedTemplatePath = resolvePath(templatePath);
  await fs.mkdir(path.dirname(resolvedTemplatePath), { recursive: true });
  await fs.writeFile(resolvedTemplatePath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ template: path.relative(projectRoot, resolvedTemplatePath), cellCount: template.cells.length }, null, 2));
  process.exit(0);
}

const buildRows = (payload) => {
  if (Array.isArray(payload?.cells)) return payload.cells;
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    return reference.rmsWaves.flatMap((row, fieldIndex) => row.map((_, wavelengthIndex) => ({
      field: fieldIndex + 1,
      wavelength: wavelengthIndex + 1,
      ...(payload[fieldIndex + 1]?.[wavelengthIndex + 1] || {})
    })));
  }
  return [];
};

const input = inputPath ? JSON.parse(await fs.readFile(resolvePath(inputPath), 'utf8')) : null;
const suppliedRows = buildRows(input);
const suppliedByCell = new Map(suppliedRows.map((row) => [`${Number(row.field)}:${Number(row.wavelength)}`, row]));

const cells = [];
for (let field = 1; field <= reference.rmsWaves.length; field += 1) {
  for (let wavelength = 1; wavelength <= reference.rmsWaves[field - 1].length; wavelength += 1) {
    const supplied = suppliedByCell.get(`${field}:${wavelength}`) || {};
    const optalix = reference.rmsWaves[field - 1][wavelength - 1];
    const values = { field, wavelength, optalix, weight: reference.relativeWeights[wavelength - 1] };
    for (const mode of modes) {
      const value = finite(supplied[mode]);
      values[mode] = value;
      values[`${mode}AbsError`] = value === null ? null : Math.abs(value - optalix);
    }
    const available = modes.filter((mode) => values[`${mode}AbsError`] !== null);
    values.bestMode = available.length
      ? available.reduce((best, mode) => values[`${mode}AbsError`] < values[`${best}AbsError`] ? mode : best, available[0])
      : null;
    cells.push(values);
  }
}

const summary = {};
for (const mode of modes) {
  const errors = cells.map((cell) => cell[`${mode}AbsError`]).filter((value) => value !== null);
  const weightedCells = cells.filter((cell) => cell[`${mode}AbsError`] !== null && Number(cell.weight) > 0);
  const weightSum = weightedCells.reduce((sum, cell) => sum + cell.weight, 0);
  const weightedAbsoluteError = weightedCells.reduce((sum, cell) => sum + cell.weight * cell[`${mode}AbsError`], 0);
  const weightedSquaredError = weightedCells.reduce((sum, cell) => sum + cell.weight * cell[`${mode}AbsError`] ** 2, 0);
  summary[mode] = {
    comparedCells: errors.length,
    meanAbsoluteError: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null,
    rmsError: errors.length ? Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length) : null,
    wavelengthWeightedMeanAbsoluteError: weightSum > 0 ? weightedAbsoluteError / weightSum : null,
    wavelengthWeightedRmsError: weightSum > 0 ? Math.sqrt(weightedSquaredError / weightSum) : null,
    maxAbsoluteError: errors.length ? Math.max(...errors) : null,
    wins: cells.filter((cell) => cell.bestMode === mode).length
  };
}

const measuredValueCount = modes.reduce((count, mode) => count + cells.filter((cell) => cell[mode] !== null).length, 0);
const expectedValueCount = cells.length * modes.length;

const report = {
  reference: path.relative(projectRoot, referencePath),
  reportedOptalixWeightedRms: reference.weightedRmsWaves,
  cellCount: cells.length,
  measuredValueCount,
  expectedValueCount,
  complete: measuredValueCount === expectedValueCount,
  cells,
  summary,
  note: measuredValueCount === 0
    ? 'The input contains no measured co-opt values. Fill the template before interpreting the comparison.'
    : measuredValueCount < expectedValueCount
      ? 'The comparison is partial because some co-opt mode values are missing.'
      : undefined
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  output: path.relative(projectRoot, outputPath),
  cellCount: report.cellCount,
  measuredValueCount: report.measuredValueCount,
  complete: report.complete,
  summary: report.summary,
  missingInput: !inputPath
}, null, 2));