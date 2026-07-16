import { readFile } from 'node:fs/promises';

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

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error('Usage: node --import tsx diagnostics/wav-primary-regression.mjs <attached.json>');
}

const fixture = JSON.parse(await readFile(inputPath, 'utf8'));
const opticalSystemRows = fixture.opticalSystem || fixture.opticalSystemRows;
const sourceRows = fixture.source || fixture.sourceRows;
const objectRows = fixture.object || fixture.objectRows;
const wavelengthUm = 0.55;
const pupilNormalizationMode = process.env.WAV_PUPIL_NORMALIZATION === 'effective'
  ? 'effective-transmitted-pupil'
  : 'fixed-entrance-pupil';
const pupilRadiusMm = Number(process.env.WAV_PUPIL_RADIUS_MM);
const optalix = [0.15866, 0.97764, 1.09753, 0.69043, 0.75098, 1.02767, 1.19182, 1.17707, 1.08580, 0.89456, 0.73617];

const { normalizeTransverseObjectRowsForImageHeight, runNativeOpdRmsWaves } = await import('../src/desktop/ipc/client.ts');
const { calculateExitPupilDiameter, calculatePupilsByNewSpec } = await import('../raytracing/core/ray-paraxial.ts');
const tracedObjectRows = await normalizeTransverseObjectRowsForImageHeight(
  opticalSystemRows,
  sourceRows,
  objectRows,
  wavelengthUm,
);
const entrancePupilPositionFromFirstSurfaceMm = Number(
  calculatePupilsByNewSpec(opticalSystemRows, wavelengthUm)?.entrancePupil?.position,
);
const derivedEntrancePupilRadiusMm = Number(
  calculatePupilsByNewSpec(opticalSystemRows, wavelengthUm)?.entrancePupil?.diameter,
) / 2;
const exitPupilPositionFromLastSurfaceMm = Number(
  calculateExitPupilDiameter(opticalSystemRows, wavelengthUm)?.position,
);

const rows = [];
for (let objectIndex = 0; objectIndex < objectRows.length; objectIndex += 1) {
  const result = await runNativeOpdRmsWaves({
    opticalSystemRows,
    sourceRows,
    objectRows: tracedObjectRows,
    objectIndex,
    wavelengthUm,
    gridSize: 129,
    pupilRadiusMm: Number.isFinite(pupilRadiusMm) && pupilRadiusMm > 0
      ? pupilRadiusMm
      : derivedEntrancePupilRadiusMm,
    entrancePupilPositionFromFirstSurfaceMm,
    exitPupilPositionFromLastSurfaceMm,
    pupilSamplingMode: 'entrance',
    chiefRayMode: 'stop-center',
    pupilNormalizationMode,
    exitPupilReferencePointMode: 'chief-ray-intersection',
    referenceSphereOptions: {
      referenceSphereWavelengthMode: 'primary-wavelength',
      chiefImagePoint: 'chief-ray-image-point',
      sphereIntersection: 'exit-pupil-side',
      opticalPathSign: 'positive',
      exitPupilDirection: 'image-to-exit-pupil',
    },
    referenceMode: 'reference-sphere',
    opdDisplayMode: 'pistonRemoved',
  });
  const coopt = Number(result.displayRmsWaves ?? result.rmsWaves);
  rows.push({
    field: objectIndex + 1,
    coopt,
    optalix: optalix[objectIndex],
    error: coopt - optalix[objectIndex],
  });
}

const mae = rows.reduce((sum, row) => sum + Math.abs(row.error), 0) / rows.length;
console.table(rows.map((row) => ({
  field: row.field,
  coopt: row.coopt.toFixed(5),
  optalix: row.optalix.toFixed(5),
  error: row.error.toFixed(5),
})));
console.log(JSON.stringify({ wavelengthUm, pupilNormalizationMode, pupilRadiusMm, mae, rows }, null, 2));

if (!Number.isFinite(mae) || mae > 0.01) process.exitCode = 1;