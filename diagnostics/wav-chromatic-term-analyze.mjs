import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseZMXTextToOpticalSystemRows } from '../import-export/zemax-import.ts';

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

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = path.resolve(process.argv[2] || path.join(projectRoot, 'diagnostics', '3g_images_source.zmx'));
const inputText = await fs.readFile(inputPath, 'utf8');
const parsed = path.extname(inputPath).toLowerCase() === '.json'
  ? JSON.parse(inputText)
  : parseZMXTextToOpticalSystemRows(inputText);
const parsedOpticalSystemRows = parsed.opticalSystem || parsed.rows;
const imageThicknessOverrideMm = Number(process.env.WAV_IMAGE_THICKNESS_MM);
const opticalSystemRows = Number.isFinite(imageThicknessOverrideMm)
  ? parsedOpticalSystemRows.map((row, index) => index === parsedOpticalSystemRows.length - 2
    ? { ...row, thickness: String(imageThicknessOverrideMm) }
    : row)
  : parsedOpticalSystemRows;
const sourceRows = parsed.source || parsed.sourceRows;
const objectRows = parsed.object || parsed.objectRows;
const wavelengthsUm = [0.475, 0.550, 0.625];
const primaryWavelengthUm = 0.550;
const fieldIndices = process.env.WAV_ALL_FIELDS === '1'
  ? objectRows.map((_, index) => index)
  : [0, 5, 10];
const gridSize = Math.max(17, Number.parseInt(process.env.WAV_TERM_GRID_SIZE || '65', 10) || 65);
const referenceSphereWavelengthMode = process.env.WAV_REFERENCE_SPHERE_MODE === 'per-wavelength'
  ? 'per-wavelength'
  : process.env.WAV_REFERENCE_SPHERE_MODE === 'fixed-primary'
    ? 'fixed-primary'
    : process.env.WAV_REFERENCE_SPHERE_MODE === 'fixed-midpoint'
      ? 'fixed-midpoint'
    : 'primary-wavelength';
const displayModes = process.env.WAV_PISTON_ONLY === '1' ? ['pistonRemoved'] : [
  'raw',
  'pistonRemoved',
  'pistonTiltRemoved',
  'pistonDefocusRemoved',
  'pistonTiltDefocusRemoved',
];
const hikariDispersionScale = Number.isFinite(Number(process.env.WAV_HIKARI_DISPERSION_SCALE))
  ? Number(process.env.WAV_HIKARI_DISPERSION_SCALE)
  : 1;
const hikariDispersionTarget = String(process.env.WAV_HIKARI_DISPERSION_TARGET || '').trim().toUpperCase();
const preserveImageHeightChiefRay = process.env.WAV_PRESERVE_IMAGE_HEIGHT_CHIEF === '1';
const resolveImageHeightChiefRayInRuntime = process.env.WAV_RESOLVE_IMAGE_HEIGHT_CHIEF_RUNTIME === '1';
const pupilSamplingMode = process.env.WAV_PUPIL_SAMPLING_MODE === 'stop' ? 'stop' : 'entrance';
const aimPupilSamplesToStop = process.env.WAV_AIM_PUPIL_TO_STOP === '1';
const aimPupilSamplesAtReferenceWavelength = process.env.WAV_AIM_PUPIL_AT_REFERENCE_WAVELENGTH === '1';
const includeMeridionalTermSamples = process.env.WAV_MERIDIONAL_TERM_SAMPLES === '1';
const usePerWavelengthExitPupil = process.env.WAV_PER_WAVELENGTH_EXIT_PUPIL === '1';
const exitPupilPositionSign = process.env.WAV_EXIT_PUPIL_POSITION_SIGN === 'negated' ? 'negated' : 'as-is';
const exitPupilPlaneDefinition = process.env.WAV_EXIT_PUPIL_PLANE === 'global-z' ? 'global-z' : 'surface-local-axis';
const sphereIntersection = process.env.WAV_SPHERE_INTERSECTION === 'opposite-side' ? 'opposite-side' : 'exit-pupil-side';
const exitPupilDirection = process.env.WAV_EXIT_PUPIL_DIRECTION === 'exit-pupil-to-image'
  ? 'exit-pupil-to-image'
  : 'image-to-exit-pupil';
const exitPupilReferencePointMode = process.env.WAV_EXIT_PUPIL_REFERENCE_POINT === 'exit-pupil-center'
  ? 'exit-pupil-center'
  : 'chief-ray-intersection';
const requestedChiefImagePointMode = String(process.env.WAV_CHIEF_IMAGE_POINT || '').trim().toLowerCase();
const chiefImagePointMode = [
  'paraxial-image-point',
  'sagittal-best-focus-point',
  'tangential-best-focus-point',
  'tan-sag-mid-focus-point',
  'rms-wavefront-best-focus-point',
  'circle-of-least-confusion-point',
  'defocus-zero-reference-point',
  'weighted-tan-sag-focus-point',
  'per-wavelength-best-focus-point',
  'target-surface-center',
].includes(requestedChiefImagePointMode)
  ? requestedChiefImagePointMode
  : 'chief-ray-image-point';
const pupilGridSampling = process.env.WAV_PUPIL_GRID_SAMPLING === 'cell-centered'
  ? 'cell-centered'
  : 'edge-inclusive';
const referenceMode = process.env.WAV_REFERENCE_MODE === 'image-sphere' ? 'image-sphere' : 'exit-pupil';
const referenceSphereRadiusScale = Number.isFinite(Number(process.env.WAV_REFERENCE_SPHERE_RADIUS_SCALE))
  ? Number(process.env.WAV_REFERENCE_SPHERE_RADIUS_SCALE)
  : 1;
const opdWaveNormalization = process.env.WAV_OPD_WAVE_NORMALIZATION === 'trace'
  ? 'trace'
  : 'primary';
const referenceSphereCenterMode = process.env.WAV_REFERENCE_SPHERE_CENTER_MODE || chiefImagePointMode;
const referenceSphereEvaluationSurface = process.env.WAV_REFERENCE_SPHERE_EVALUATION_SURFACE === 'target'
  ? 'target'
  : 'pre-target';
const excludeObjectSpaceOpl = process.env.WAV_EXCLUDE_OBJECT_SPACE_OPL === '1';

const { normalizeTransverseObjectRowsForImageHeight, runNativeOpdMap, runNativeOpdRmsWaves } = await import('../src/desktop/ipc/client.ts');
const { calculateExitPupilDiameter, calculatePupilsByNewSpec, getRefractiveIndex } = await import('../raytracing/core/ray-paraxial.ts');
const tracedObjectRows = await normalizeTransverseObjectRowsForImageHeight(
  opticalSystemRows,
  sourceRows,
  objectRows,
  primaryWavelengthUm,
);
const primaryPupils = calculatePupilsByNewSpec(opticalSystemRows, primaryWavelengthUm);
const entrancePupilPositionFromFirstSurfaceMm = Number(primaryPupils?.entrancePupil?.position);
const entrancePupilDiameterMm = Number(primaryPupils?.entrancePupil?.diameter);
const pupilRadiusMm = Number.isFinite(entrancePupilDiameterMm) && entrancePupilDiameterMm > 0
  ? entrancePupilDiameterMm / 2
  : undefined;
const exitPupilPositionFromLastSurfaceMm = Number(
  calculateExitPupilDiameter(opticalSystemRows, primaryWavelengthUm)?.position,
);

const fixedReferenceSphereGeometry = (() => {
  if (referenceSphereWavelengthMode !== 'fixed-primary' && referenceSphereWavelengthMode !== 'fixed-midpoint') {
    return undefined;
  }
  const fixedGeometryReferenceMode = process.env.WAV_FIXED_REFERENCE_GEOMETRY_MODE === 'image-sphere'
    ? 'image-sphere'
    : 'exit-pupil';
  const geometryOptions = {
    referenceSphereWavelengthMode: 'per-wavelength',
    exitPupilPositionSign,
    exitPupilPlaneDefinition,
    chiefImagePoint: 'chief-ray-image-point',
    sphereIntersection,
    exitPupilDirection,
    opticalPathSign: 'positive',
    referenceSphereRadiusScale: 1,
  };
  const getGeometry = async (wavelengthUm) => {
    const geometryRequest = {
      opticalSystemRows,
      referenceOpticalSystemRows: opticalSystemRows,
      sourceRows,
      objectRows: tracedObjectRows,
      objectIndex: 5,
      wavelengthUm,
      gridSize: 17,
      pupilGridSampling,
      pupilRadiusMm,
      entrancePupilPositionFromFirstSurfaceMm,
      exitPupilPositionFromLastSurfaceMm: Number(calculateExitPupilDiameter(opticalSystemRows, wavelengthUm)?.position),
      pupilSamplingMode,
      chiefRayMode: 'stop-center',
      aimPupilSamplesToStop,
      pupilNormalizationMode: 'fixed-entrance-pupil',
      exitPupilReferencePointMode,
      referenceMode: fixedGeometryReferenceMode,
      referenceSphereOptions: geometryOptions,
      opdDisplayMode: 'raw',
    };
    const result = await runNativeOpdRmsWaves(geometryRequest);
    const mapResult = await runNativeOpdMap(geometryRequest);
    const referenceSphereCenter = result.referenceSphereCenter || mapResult.referenceSphereCenter;
    const referenceSphereDirection = result.referenceSphereDirection || mapResult.referenceSphereDirection;
    const referenceSphereRadiusMm = result.referenceSphereRadiusMm ?? mapResult.referenceSphereRadiusMm;
    if (!referenceSphereCenter || !referenceSphereDirection || !Number.isFinite(Number(referenceSphereRadiusMm))) {
      return undefined;
    }
    const toPointObject = (point) => ({
      x: Number(point.x ?? point[0]),
      y: Number(point.y ?? point[1]),
      z: Number(point.z ?? point[2]),
    });
    return {
      center: toPointObject(referenceSphereCenter),
      radiusMm: Number(referenceSphereRadiusMm),
      direction: toPointObject(referenceSphereDirection),
    };
  };
  return (async () => {
    const wavelengths = referenceSphereWavelengthMode === 'fixed-primary'
      ? [primaryWavelengthUm]
      : [wavelengthsUm[0], wavelengthsUm[2]];
    const geometries = (await Promise.all(wavelengths.map(getGeometry))).filter(Boolean);
    if (geometries.length !== wavelengths.length) return undefined;
    if (geometries.length === 1) return geometries[0];
    const [short, long] = geometries;
    return {
      center: {
        x: (short.center.x + long.center.x) / 2,
        y: (short.center.y + long.center.y) / 2,
        z: (short.center.z + long.center.z) / 2,
      },
      radiusMm: (short.radiusMm + long.radiusMm) / 2,
      direction: {
        x: short.direction.x + long.direction.x,
        y: short.direction.y + long.direction.y,
        z: short.direction.z + long.direction.z,
      },
    };
  })();
})();
const resolvedFixedReferenceSphereGeometry = fixedReferenceSphereGeometry
  ? await fixedReferenceSphereGeometry
  : undefined;

const results = [];
for (const fieldIndex of fieldIndices) {
  for (const wavelengthUm of wavelengthsUm) {
    const wavelengthRows = Math.abs(hikariDispersionScale - 1) <= 1e-12
      ? opticalSystemRows
      : opticalSystemRows.map((row) => {
          const material = String(row?.material || '').toUpperCase();
          if (!material.startsWith('J-') || (hikariDispersionTarget && material !== hikariDispersionTarget)) return row;
          const primaryIndex = Number(getRefractiveIndex(row, primaryWavelengthUm));
          const wavelengthIndex = Number(getRefractiveIndex(row, wavelengthUm));
          if (!Number.isFinite(primaryIndex) || !Number.isFinite(wavelengthIndex)) return row;
          const scaledIndex = primaryIndex + hikariDispersionScale * (wavelengthIndex - primaryIndex);
          return { ...row, material: String(scaledIndex), rindex: String(scaledIndex), abbe: '' };
        });
    const modes = {};
    const traceExitPupilPositionFromLastSurfaceMm = usePerWavelengthExitPupil
      ? Number(calculateExitPupilDiameter(wavelengthRows, wavelengthUm)?.position)
      : exitPupilPositionFromLastSurfaceMm;
    for (const opdDisplayMode of displayModes) {
      const request = {
        opticalSystemRows: wavelengthRows,
        sourceRows,
        objectRows: tracedObjectRows,
        objectIndex: fieldIndex,
        wavelengthUm,
        gridSize,
        pupilGridSampling,
        pupilRadiusMm,
        entrancePupilPositionFromFirstSurfaceMm: Number.isFinite(entrancePupilPositionFromFirstSurfaceMm)
          ? entrancePupilPositionFromFirstSurfaceMm
          : undefined,
        exitPupilPositionFromLastSurfaceMm: Number.isFinite(traceExitPupilPositionFromLastSurfaceMm)
          ? traceExitPupilPositionFromLastSurfaceMm
          : undefined,
        pupilSamplingMode,
        chiefRayMode: 'stop-center',
        preserveImageHeightChiefRay,
        resolveImageHeightChiefRayInRuntime,
        aimPupilSamplesToStop,
        aimPupilSamplesAtReferenceWavelength,
        includeMeridionalTermSamples,
        excludeObjectSpaceOpl,
        pupilNormalizationMode: 'fixed-entrance-pupil',
        exitPupilReferencePointMode,
        referenceMode,
        referenceSphereGeometry: resolvedFixedReferenceSphereGeometry,
        referenceSphereOptions: {
          referenceSphereWavelengthMode,
            evaluationSurface: referenceSphereEvaluationSurface,
          exitPupilPositionSign,
          exitPupilPlaneDefinition,
          chiefImagePoint: referenceSphereCenterMode,
          sphereIntersection,
          exitPupilDirection,
          opticalPathSign: 'positive',
          referenceSphereRadiusScale,
        },
        opdWaveNormalization,
        opdReferenceWavelengthUm: opdWaveNormalization === 'trace'
          ? wavelengthUm
          : primaryWavelengthUm,
        opdDisplayMode,
      };
      const result = await runNativeOpdRmsWaves(request);
      const mapResult = await runNativeOpdMap(request);
      const firstSurfaceStatusCounts = Array.isArray(mapResult.chiefSurfaceTrace)
        ? mapResult.chiefSurfaceTrace.find((entry) => entry?.diagnostic === 'firstSurfaceTraceStatusCounts')
        : undefined;
      modes[opdDisplayMode] = {
        rmsWaves: Number(result.rmsWaves),
        fit: result.wavefrontFit || result.displayFit || null,
        displayOpdGrid: mapResult.displayOpdGrid || result.displayOpdGrid,
        validSampleCount: Number(result.validSampleCount),
        referenceOpdRmsUm: Number(result.referenceOpdRmsUm),
        trackedOpdRmsUm: Number(result.trackedOpdRmsUm),
        beforeTargetTrackedOpdRmsUm: Number(result.beforeTargetTrackedOpdRmsUm),
        targetSegmentOpdRmsUm: Number(result.targetSegmentOpdRmsUm),
        firstSurfaceOpdRmsUm: Number(mapResult.firstSurfaceOpdRmsUm ?? result.firstSurfaceOpdRmsUm),
        firstSurfaceExcludedOpdRmsUm: Number(mapResult.firstSurfaceExcludedOpdRmsUm ?? result.firstSurfaceExcludedOpdRmsUm),
        firstSurfaceExcludedOpdRmsUm: Number(mapResult.firstSurfaceExcludedOpdRmsUm),
        rawWasmRmsWaves: Number(mapResult.rawWasmRmsWaves),
        rawWasmOpdWaveNormalization: mapResult.rawWasmOpdWaveNormalization,
        currentReferenceOpdRmsUm: Number(result.currentReferenceOpdRmsUm),
        alternateReferenceOpdRmsUm: Number(result.alternateReferenceOpdRmsUm),
        targetOriginReferenceOpdRmsUm: Number(result.targetOriginReferenceOpdRmsUm),
        airReferenceOpdRmsUm: Number(result.airReferenceOpdRmsUm),
        imagePlaneReferenceOpdRmsUm: Number(mapResult.imagePlaneReferenceOpdRmsUm ?? result.imagePlaneReferenceOpdRmsUm),
        stopImageReferenceOpdRmsUm: Number(mapResult.stopImageReferenceOpdRmsUm ?? result.stopImageReferenceOpdRmsUm),
        stopReferenceOpdRmsUm: Number(mapResult.stopReferenceOpdRmsUm ?? result.stopReferenceOpdRmsUm),
        alternateSignReferenceOpdRmsUm: Number(result.alternateSignReferenceOpdRmsUm),
        spherePathDeltaRmsUm: Number(result.spherePathDeltaRmsUm),
        spherePathOptimalScale: Number(result.spherePathOptimalScale),
        spherePathOptimalRmsUm: Number(result.spherePathOptimalRmsUm),
        alternateReferenceOpdRmsUm: Number(result.alternateReferenceOpdRmsUm),
        axisReferenceSphereRmsUm: Number(result.axisReferenceSphereRmsUm),
        sphereRadiusOptimalScale: Number(result.sphereRadiusOptimalScale),
        sphereRadiusOptimalRmsUm: Number(result.sphereRadiusOptimalRmsUm),
        referenceSphereRadiusMm: Number(result.referenceSphereRadiusMm),
        primaryReferenceGeometryApplied: Boolean(result.primaryReferenceGeometryApplied),
        primaryReferenceSphereRadiusMm: Number(result.primaryReferenceSphereRadiusMm),
        referenceSphereCenter: result.referenceSphereCenter,
        referenceSphereDirection: result.referenceSphereDirection,
        chiefImagePoint: mapResult.chiefImagePoint,
        paraxialImagePoint: mapResult.paraxialImagePoint,
        sagittalBestFocusPoint: mapResult.sagittalBestFocusPoint,
        tangentialBestFocusPoint: mapResult.tangentialBestFocusPoint,
        rmsBestFocusPoint: mapResult.rmsBestFocusPoint,
        imageSpaceN: Number(result.imageSpaceN),
        chiefSurfaceTrace: mapResult.chiefSurfaceTrace || result.chiefSurfaceTrace,
        firstSurfaceTraceStatusCounts: firstSurfaceStatusCounts || null,
        imageHeightRuntimeSolvedAngle: result.imageHeightRuntimeSolvedAngle,
        opdTermSamples: opdDisplayMode === 'raw'
          ? (mapResult.opdTermSamples || result.opdTermSamples)
          : undefined,
        unreferencedOpdGrid: opdDisplayMode === 'raw'
          ? (mapResult.unreferencedOpdGrid || result.unreferencedOpdGrid)
          : undefined,
        referenceSphereOpdGrid: opdDisplayMode === 'raw'
          ? (mapResult.referenceSphereOpdGrid || result.referenceSphereOpdGrid)
          : undefined,
        pupilMaskGrid: result.pupilMaskGrid,
        entrancePupilCoordinateXGrid: result.entrancePupilCoordinateXGrid,
        entrancePupilCoordinateYGrid: result.entrancePupilCoordinateYGrid,
      };
    }
    results.push({ field: fieldIndex + 1, wavelengthUm, modes });
  }
}

const output = {
  source: path.relative(projectRoot, inputPath),
  gridSize,
  referenceSphereWavelengthMode,
  hikariDispersionScale,
  hikariDispersionTarget: hikariDispersionTarget || 'ALL',
  pupilRadiusMm,
  entrancePupilPositionFromFirstSurfaceMm,
  exitPupilPositionFromLastSurfaceMm,
  results,
};
const outputPath = path.join(projectRoot, 'diagnostics', 'results', 'wav-chromatic-term-analyze.json');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

const exportMapField = Number.parseInt(process.env.WAV_EXPORT_MAP_FIELD || '6', 10);
if (process.env.WAV_EXPORT_MAP_CSV !== '0') {
  const mapRows = results.filter((row) => row.field === exportMapField && row.modes.raw);
  for (const row of mapRows) {
    for (const [modeName, mode] of Object.entries(row.modes)) {
      const grid = mode.displayOpdGrid;
      const gridSize = Array.isArray(grid) ? grid.length : 0;
      if (!gridSize) continue;
      const lines = ['xNormalized,yNormalized,displayWaves,displayMicron'];
      for (let y = 0; y < gridSize; y += 1) {
        for (let x = 0; x < gridSize; x += 1) {
          const value = grid?.[y]?.[x];
          const micronValue = value == null ? null : Number(value) * row.wavelengthUm;
          lines.push([
            (2 * x / (gridSize - 1) - 1).toFixed(9),
            (2 * y / (gridSize - 1) - 1).toFixed(9),
            value == null ? '' : Number(value).toPrecision(12),
            micronValue == null ? '' : Number(micronValue).toPrecision(12),
          ].join(','));
        }
      }
      const modeSuffix = modeName === 'raw' ? '' : `-${modeName}`;
      const csvPath = path.join(projectRoot, 'diagnostics', 'results',
        `wav-map-field-${exportMapField}-w${wavelengthsUm.indexOf(row.wavelengthUm) + 1}${modeSuffix}.csv`);
      await fs.writeFile(csvPath, `${lines.join('\n')}\n`, 'utf8');
    }
  }
}

console.log(`pupilRadiusMm=${pupilRadiusMm} grid=${gridSize} sphereMode=${referenceSphereWavelengthMode} sphereIntersection=${sphereIntersection} exitPupilSign=${exitPupilPositionSign} exitPupilPlane=${exitPupilPlaneDefinition} exitPupilReference=${exitPupilReferencePointMode} exitPupilDirection=${exitPupilDirection} hikariScale=${hikariDispersionScale}`);
console.log('field,wl,raw,piston,pistonTilt,pistonDefocus,pistonTiltDefocus,tiltPower,defocusPower,higherOrder');
for (const row of results) {
  if (!row.modes.raw) {
    console.log([row.field, row.wavelengthUm.toFixed(3), row.modes.pistonRemoved.rmsWaves]
      .map((value) => typeof value === 'number' ? value.toFixed(6) : value).join(','));
    continue;
  }
  const raw = row.modes.raw.rmsWaves;
  const piston = row.modes.pistonRemoved.rmsWaves;
  const pistonTilt = row.modes.pistonTiltRemoved.rmsWaves;
  const pistonDefocus = row.modes.pistonDefocusRemoved.rmsWaves;
  const higherOrder = row.modes.pistonTiltDefocusRemoved.rmsWaves;
  const tiltPower = Math.sqrt(Math.max(0, piston ** 2 - pistonTilt ** 2));
  const defocusPower = Math.sqrt(Math.max(0, piston ** 2 - pistonDefocus ** 2));
  console.log([
    row.field,
    row.wavelengthUm.toFixed(3),
    raw,
    piston,
    pistonTilt,
    pistonDefocus,
    higherOrder,
    tiltPower,
    defocusPower,
    higherOrder,
  ].map((value) => typeof value === 'number' ? value.toFixed(6) : value).join(','));
}
console.log(`output=${path.relative(projectRoot, outputPath)}`);