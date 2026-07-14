const nodeNavigator = globalThis.navigator;
try { delete globalThis.navigator; } catch {}
const { preloadRustRayTracingWasm } = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
await preloadRustRayTracingWasm();
if (nodeNavigator !== undefined) globalThis.navigator = nodeNavigator;

if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(String(key)) ?? null,
    setItem: (key, value) => store.set(String(key), String(value)),
    removeItem: (key) => store.delete(String(key)),
    clear: () => store.clear(),
  };
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: node --import tsx diagnostics/optalix-chief-opd-diagnose.mjs <attached.json>');

const fixture = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const opticalSystemRows = fixture.opticalSystem;
const sourceRows = fixture.source;
const objectRows = fixture.object;
const primaryWavelength = Number(sourceRows.find((row) => String(row.primary ?? '').toLowerCase().includes('primary'))?.wavelength ?? 0.55);
const wavelengths = sourceRows.map((row) => Number(row.wavelength));
const gridSize = Math.max(3, Number.parseInt(process.env.OPD_DIAG_GRID_SIZE || '17', 10) || 17);
const focusedMode = process.env.OPD_DIAG_FOCUSED === '1';
const optalix = [
  [0, 0, 0],
  [-0.1390136788e-6, 0, -0.1704400887e-7],
  [-0.5399195118e-6, 0, -0.2118370048e-6],
  [-0.1149045936e-5, 0, -0.4508545359e-6],
  [-0.1897933338e-5, 0, -0.7449473429e-6],
  [-0.2705162210e-5, 0, -0.1062509376e-5],
  [-0.3458456163e-5, 0, -0.1359999430e-5],
  [-0.4043324140e-5, 0, -0.1593527671e-5],
  [-0.4358425116e-5, 0, -0.1724933917e-5],
  [-0.4348004005e-5, 0, -0.1733990111e-5],
  [-0.4017089637e-5, 0, -0.1623581745e-5],
];

const { normalizeTransverseObjectRowsForImageHeight, runNativeOpdRmsWaves } = await import('../src/desktop/ipc/client.ts');
const fixedObjectRows = await normalizeTransverseObjectRowsForImageHeight(
  opticalSystemRows,
  sourceRows,
  objectRows,
  primaryWavelength,
);

async function collect(mode, chiefRayMode, opticalPathSign) {
  const values = [];
  const centerOpdMm = [];
  const opdGridMm = [];
  for (let fieldIndex = 0; fieldIndex < objectRows.length; fieldIndex += 1) {
    values[fieldIndex] = [];
    centerOpdMm[fieldIndex] = [];
    opdGridMm[fieldIndex] = [];
    const primaryRows = mode === 'primary-fixed'
      ? fixedObjectRows
      : await normalizeTransverseObjectRowsForImageHeight(opticalSystemRows, sourceRows, objectRows, primaryWavelength);
    const primaryResult = await runNativeOpdRmsWaves({
      opticalSystemRows,
      sourceRows,
      objectRows: primaryRows,
      objectIndex: fieldIndex,
      wavelengthUm: primaryWavelength,
      gridSize,
      pupilSamplingMode: 'entrance',
      chiefRayMode,
      pupilNormalizationMode: 'fixed-entrance-pupil',
      referenceMode: 'reference-sphere',
      referenceSphereOptions: {
        referenceSphereWavelengthMode: 'per-wavelength',
        chiefImagePoint: 'chief-ray-image-point',
        sphereIntersection: 'exit-pupil-side',
        exitPupilDirection: 'image-to-exit-pupil',
        opticalPathSign,
      },
      opdDisplayMode: 'raw',
    });
    const referenceSphereGeometry = {
      center: primaryResult.referenceSphereCenter,
      radiusMm: Number(primaryResult.referenceSphereRadiusMm),
      direction: primaryResult.referenceSphereDirection,
    };
    for (let colourIndex = 0; colourIndex < wavelengths.length; colourIndex += 1) {
      const wavelengthUm = wavelengths[colourIndex];
      const rows = mode === 'primary-fixed'
        ? fixedObjectRows
        : await normalizeTransverseObjectRowsForImageHeight(opticalSystemRows, sourceRows, objectRows, wavelengthUm);
      const result = await runNativeOpdRmsWaves({
        opticalSystemRows,
        sourceRows,
        objectRows: rows,
        objectIndex: fieldIndex,
        wavelengthUm,
        gridSize,
        pupilSamplingMode: 'entrance',
        chiefRayMode,
        pupilNormalizationMode: 'fixed-entrance-pupil',
        referenceMode: 'reference-sphere',
        referenceSphereOptions: {
          referenceSphereWavelengthMode: 'per-wavelength',
          chiefImagePoint: 'chief-ray-image-point',
          sphereIntersection: 'exit-pupil-side',
          exitPupilDirection: 'image-to-exit-pupil',
          opticalPathSign,
        },
        referenceSphereGeometry,
        opdDisplayMode: 'raw',
      });
      values[fieldIndex][colourIndex] = Number(result.chiefOplUm) / 1000;
      const grid = result.referenceSphereOpdGrid;
      const centerIndex = Math.floor(grid.length / 2);
      centerOpdMm[fieldIndex][colourIndex] = Number(grid[centerIndex][centerIndex]) * wavelengthUm / 1000;
      opdGridMm[fieldIndex][colourIndex] = grid.map((row) => row.map((value) => (
        value == null || !Number.isFinite(Number(value)) ? null : Number(value) * wavelengthUm / 1000
      )));
    }
  }
  return { oplMm: values, centerOpdMm, opdGridMm };
}

function doubleDifference(opl) {
  return opl.map((row, fieldIndex) => row.map((value, colourIndex) => (
    value - row[1] - opl[0][colourIndex] + opl[0][1]
  )));
}

function normalizeSpectralDirection(values) {
  return values.map((row) => row.map((value, colourIndex) => {
    const direction = Math.sign(primaryWavelength - wavelengths[colourIndex]);
    return direction === 0 ? 0 : value * direction;
  }));
}

function metrics(values) {
  let sumAbs = 0;
  let sumSq = 0;
  let count = 0;
  for (let fieldIndex = 1; fieldIndex < values.length; fieldIndex += 1) {
    for (const colourIndex of [0, 2]) {
      const delta = values[fieldIndex][colourIndex] - optalix[fieldIndex][colourIndex];
      sumAbs += Math.abs(delta);
      sumSq += delta * delta;
      count += 1;
    }
  }
  return { maeMm: sumAbs / count, rmseMm: Math.sqrt(sumSq / count) };
}

function colourMetrics(values, colourIndex) {
  let sumAbs = 0;
  let sumSq = 0;
  let count = 0;
  for (let fieldIndex = 1; fieldIndex < values.length; fieldIndex += 1) {
    const delta = values[fieldIndex][colourIndex] - optalix[fieldIndex][colourIndex];
    sumAbs += Math.abs(delta);
    sumSq += delta * delta;
    count += 1;
  }
  return { maeMm: sumAbs / count, rmseMm: Math.sqrt(sumSq / count) };
}

function findBestFixedPupilSample(opdGridMm) {
  const gridSize = opdGridMm[0][0].length;
  let best = null;
  const bestByColour = { 0: null, 2: null };
  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const sampledValues = opdGridMm.map((field) => field.map((grid) => grid[y][x]));
      if (sampledValues.some((row) => row.some((value) => value == null))) continue;
      const values = normalizeSpectralDirection(doubleDifference(sampledValues));
      const candidateMetrics = metrics(values);
      if (!best || candidateMetrics.maeMm < best.metrics.maeMm) {
        best = {
          relativeApertureX: gridSize > 1 ? -1 + 2 * x / (gridSize - 1) : 0,
          relativeApertureY: gridSize > 1 ? -1 + 2 * y / (gridSize - 1) : 0,
          valuesMm: values,
          metrics: candidateMetrics,
        };
      }
      for (const colourIndex of [0, 2]) {
        const candidateColourMetrics = colourMetrics(values, colourIndex);
        if (!bestByColour[colourIndex] || candidateColourMetrics.maeMm < bestByColour[colourIndex].metrics.maeMm) {
          bestByColour[colourIndex] = {
            relativeApertureX: gridSize > 1 ? -1 + 2 * x / (gridSize - 1) : 0,
            relativeApertureY: gridSize > 1 ? -1 + 2 * y / (gridSize - 1) : 0,
            valuesMm: values.map((row) => row[colourIndex]),
            metrics: candidateColourMetrics,
          };
        }
      }
    }
  }
  return { combined: best, byColour: bestByColour };
}

const output = {};
const chiefRayModes = focusedMode ? ['stop-center'] : ['stop-center', 'entrance-pupil-center', 'transmitted-pupil-center'];
const opticalPathSigns = focusedMode ? ['positive'] : ['positive', 'negative'];
const fieldModes = focusedMode ? ['primary-fixed'] : ['primary-fixed', 'per-wavelength'];
for (const chiefRayMode of chiefRayModes) {
  for (const opticalPathSign of opticalPathSigns) {
    for (const mode of fieldModes) {
      const collected = await collect(mode, chiefRayMode, opticalPathSign);
      const values = doubleDifference(collected.oplMm);
      const centerValues = doubleDifference(collected.centerOpdMm);
      const bestFixedPupilSamples = findBestFixedPupilSample(collected.opdGridMm);
      output[`${mode}:${chiefRayMode}:${opticalPathSign}`] = {
        valuesMm: values,
        metrics: metrics(values),
        centerOpdValuesMm: centerValues,
        centerOpdMetrics: metrics(centerValues),
        bestFixedPupilSample: bestFixedPupilSamples.combined,
        bestFixedPupilSampleByColour: bestFixedPupilSamples.byColour,
      };
    }
  }
}

const outputPath = path.join(projectRoot, 'diagnostics', 'results', 'optalix-chief-opd-diagnose.json');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  outputPath,
  modes: Object.fromEntries(Object.entries(output).map(([key, value]) => [key, {
    chiefOpl: value.metrics,
    pupilCenterOpd: value.centerOpdMetrics,
    bestFixedPupilSample: value.bestFixedPupilSample && {
      relativeApertureX: value.bestFixedPupilSample.relativeApertureX,
      relativeApertureY: value.bestFixedPupilSample.relativeApertureY,
      metrics: value.bestFixedPupilSample.metrics,
    },
    bestFixedPupilSampleByColour: value.bestFixedPupilSampleByColour,
  }])),
}, null, 2));
