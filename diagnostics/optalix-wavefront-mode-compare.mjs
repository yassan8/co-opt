import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const referencePath = path.join(__dirname, 'fixtures', 'optalix-3g-images-87-03.json');
const defaultInputPath = path.join(__dirname, 'fixtures', 'coopt-cell-results.json');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return args[index + 1] ?? fallback;
};
const resolvePath = (value) => path.resolve(projectRoot, value);
const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const modes = ['raw', 'piston', 'pistonDefocus', 'pistonDefocusScaled0895'];

const reference = JSON.parse(await fs.readFile(getArg('reference', referencePath), 'utf8'));
const input = JSON.parse(await fs.readFile(getArg('input', defaultInputPath), 'utf8'));
const rows = Array.isArray(input?.cells)
  ? input.cells
  : reference.rmsWaves.flatMap((row, fieldIndex) => row.map((_, wavelengthIndex) => ({
    field: fieldIndex + 1,
    wavelength: wavelengthIndex + 1,
    ...(input?.[fieldIndex + 1]?.[wavelengthIndex + 1] || {}),
  })));
const byCell = new Map(rows.map((row) => [`${Number(row.field)}:${Number(row.wavelength)}`, row]));
const weights = reference.relativeWeights.map(Number);
const weightSum = weights.reduce((sum, value) => sum + value, 0);

const fieldReports = [];
for (let field = 1; field <= reference.rmsWaves.length; field += 1) {
  const report = { field, optalix: null };
  const referenceRow = reference.rmsWaves[field - 1];
  report.optalix = Math.sqrt(referenceRow.reduce((sum, value, index) => (
    sum + weights[index] * Number(value) ** 2
  ), 0) / weightSum);

  for (const mode of modes) {
    const values = referenceRow.map((_, index) => finite(
      byCell.get(`${field}:${index + 1}`)?.[mode],
    ));
    report[mode] = values.every((value) => value !== null)
      ? Math.sqrt(values.reduce((sum, value, index) => sum + weights[index] * value ** 2, 0) / weightSum)
      : null;
    report[`${mode}AbsError`] = report[mode] === null
      ? null
      : Math.abs(report[mode] - report.optalix);
  }
  fieldReports.push(report);
}

const summary = {};
for (const mode of modes) {
  const values = fieldReports.map((field) => field[mode]).filter((value) => value !== null);
  const optalix = fieldReports.filter((field) => field[mode] !== null).map((field) => field.optalix);
  const errors = values.map((value, index) => value - optalix[index]);
  summary[mode] = {
    comparedFields: values.length,
    fieldMeanAbsoluteError: errors.length
      ? errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length
      : null,
    fieldRmsError: errors.length
      ? Math.sqrt(errors.reduce((sum, value) => sum + value ** 2, 0) / errors.length)
      : null,
    fieldWins: fieldReports.filter((field) => field[`${mode}AbsError`] !== null)
      .filter((field) => modes.every((other) => (
        field[`${mode}AbsError`] <= (field[`${other}AbsError`] ?? Number.POSITIVE_INFINITY)
      ))).length,
  };
}

const outputPath = resolvePath(getArg(
  'out',
  `diagnostics/results/optalix-wavefront-mode-compare-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
));
const report = {
  reference: path.relative(projectRoot, resolvePath(getArg('reference', referencePath))),
  input: path.relative(projectRoot, resolvePath(getArg('input', defaultInputPath))),
  wavelengthsUm: reference.wavelengthsUm,
  relativeWeights: weights,
  weighting: 'per-Field RMS from three wavelength cells, using relative wavelength weights',
  fields: fieldReports,
  summary,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: path.relative(projectRoot, outputPath), summary }, null, 2));
