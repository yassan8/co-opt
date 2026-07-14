import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const referencePath = path.join(projectRoot, 'diagnostics', 'fixtures', 'optalix-3g-images-87-03.json');
const reference = JSON.parse(await fs.readFile(referencePath, 'utf8'));
const fieldHeightsMm = [0, 2.16, 4.33, 6.49, 8.65, 10.82, 12.98, 15.14, 17.31, 19.47, 21.63];
const wavelengthWeightSum = reference.relativeWeights.reduce((sum, value) => sum + value, 0);
const fieldRms = reference.rmsWaves.map((row) => Math.sqrt(
  row.reduce((sum, value, index) => sum + reference.relativeWeights[index] * value * value, 0) / wavelengthWeightSum
));
const target = Number(reference.weightedRmsWaves);
const schemes = {
  equal: fieldRms.map(() => 1),
  imageHeight: fieldHeightsMm.map((value) => value || 1),
  imageHeightSquared: fieldHeightsMm.map((value) => (value || 1) ** 2),
  annularArea: fieldHeightsMm.map((value, index) => index === 0 ? 1 : 2 * index + 1),
  edgeEmphasis: fieldRms.map((_, index) => Math.exp((index + 1) / 4))
};

const aggregate = (weights) => {
  const sum = weights.reduce((total, value) => total + value, 0);
  return Math.sqrt(fieldRms.reduce((total, value, index) => total + weights[index] * value * value, 0) / sum);
};
const scan = Object.fromEntries(Object.entries(schemes).map(([name, weights]) => [name, {
  aggregateRms: aggregate(weights),
  deltaFromOptalix: aggregate(weights) - target
}]));

console.log(JSON.stringify({
  reference: path.relative(projectRoot, referencePath),
  targetOptalixTotal: target,
  fieldHeightsMm,
  fieldRms,
  scan,
  conclusion: 'Natural field-only weighting models do not reproduce the Optalix total; investigate ray-level aggregate or undocumented field weights.'
}, null, 2));
