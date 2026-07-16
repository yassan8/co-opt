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

const { readFile } = await import('node:fs/promises');
const {
  normalizeTransverseObjectRowsForImageHeight,
  runNativeOpdMap,
} = await import('../src/desktop/ipc/client.ts');
const {
  calculateExitPupilDiameter,
  calculatePupilsByNewSpec,
} = await import('../raytracing/core/ray-paraxial.ts');
const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error('Usage: node --import tsx diagnostics/optalix-direct-reference-smoke.mjs <attached.json>');
}
const fixture = JSON.parse(await readFile(inputPath, 'utf8'));
const opticalSystemRows = fixture.opticalSystem || fixture.opticalSystemRows;
const sourceRows = fixture.source || fixture.sourceRows;
const objectRows = fixture.object || fixture.objectRows;
const wavelengthUm = Number(process.env.OPD_DIRECT_WAVELENGTH_UM || 0.55);
let tracedObjectRows = await normalizeTransverseObjectRowsForImageHeight(
  opticalSystemRows,
  sourceRows,
  objectRows,
  wavelengthUm,
);
const fieldAngleOverrideDeg = Number(process.env.OPD_DIRECT_FIELD_ANGLE_DEG);
if (Number.isFinite(fieldAngleOverrideDeg)) {
  tracedObjectRows = tracedObjectRows.map((row, index) => {
    if (index !== 5) return row;
    const {
      __cooptImageHeightTarget,
      __cooptImageHeightSolve,
      __cooptOriginalPosition,
      ...angleRow
    } = row;
    return {
      ...angleRow,
      position: 'Angle',
      __cooptEffectivePosition: 'Angle',
      yHeightAngle: fieldAngleOverrideDeg,
    };
  });
}
const pupils = calculatePupilsByNewSpec(opticalSystemRows, wavelengthUm);
const entrancePupilDiameterMm = Number(pupils?.entrancePupil?.diameter);

const request = {
  opticalSystemRows,
  sourceRows,
  objectRows: tracedObjectRows,
  objectIndex: 5,
  wavelengthUm,
  gridSize: 17,
  pupilRadiusMm: entrancePupilDiameterMm / 2,
  entrancePupilPositionFromFirstSurfaceMm: Number(pupils?.entrancePupil?.position),
  exitPupilPositionFromLastSurfaceMm: Number(
    calculateExitPupilDiameter(opticalSystemRows, wavelengthUm)?.position,
  ),
  pupilSamplingMode: 'entrance',
  chiefRayMode: 'stop-center',
  aimPupilSamplesToStop: true,
  aimPupilSamplesAtReferenceWavelength: process.env.OPD_DIRECT_AIM_AT_REFERENCE === '1',
  includeMeridionalTermSamples: process.env.OPD_DIRECT_SCAN_MERIDIONAL === '1',
  pupilNormalizationMode: 'fixed-entrance-pupil',
  exitPupilReferencePointMode: 'chief-ray-intersection',
  referenceSphereOptions: {
    referenceSphereWavelengthMode: 'per-wavelength',
    evaluationSurface: 'target',
    exitPupilPositionSign: 'as-is',
    exitPupilPlaneDefinition: 'surface-local-axis',
    chiefImagePoint: 'chief-ray-image-point',
    sphereIntersection: process.env.OPD_DIRECT_SPHERE_INTERSECTION || 'exit-pupil-side',
    exitPupilDirection: process.env.OPD_DIRECT_EXIT_PUPIL_DIRECTION || 'image-to-exit-pupil',
    opticalPathSign: process.env.OPD_DIRECT_OPTICAL_PATH_SIGN || 'positive',
  },
  opdDisplayMode: 'raw',
};
if (process.env.OPD_DIRECT_REUSE_PRIMARY_SEED === '1' && Math.abs(wavelengthUm - 0.55) > 1e-12) {
  const primarySeedResult = await runNativeOpdMap({
    ...request,
    wavelengthUm: 0.55,
    referenceMode: 'optalix-direct',
  });
  request.sampleRayLaunchOrigin = primarySeedResult.chiefRayLaunchOrigin;
}
const [result, baseline] = await Promise.all([
  runNativeOpdMap({ ...request, referenceMode: 'optalix-direct' }),
  runNativeOpdMap({ ...request, referenceMode: 'reference-sphere' }),
]);

const center = result.referenceSphereCenter;
if (result.referenceMode !== 'optalix-direct') {
  throw new Error(`Unexpected reference mode: ${result.referenceMode}`);
}
if (!center || !Number.isFinite(result.referenceSphereRadiusMm) || result.referenceSphereRadiusMm <= 0) {
  throw new Error('Missing or invalid OpTaliX direct reference geometry');
}
const radiusError = Math.abs(result.referenceSphereRadiusMm - baseline.referenceSphereRadiusMm);
if (radiusError > 1e-10) {
  throw new Error(`OpTaliX direct and image-side reference radii differ by ${radiusError} mm`);
}
const sampleLabel = process.env.OPD_DIRECT_SAMPLE_LABEL || 'upper';
const selectedSample = result.opdTermSamples?.find((sample) => sample.label === sampleLabel);
const sampleOpdUm = Number(selectedSample?.referenceOpdUm);
const samplePreTargetLocalState = selectedSample?.surfaceTrace?.find(
  (state) => state.surfaceIndex === result.targetSurface - 1,
);
const sampleFirstSurfaceState = selectedSample?.surfaceTrace?.find(
  (state) => state.surfaceIndex === 1,
);

console.log(JSON.stringify({
  wavelengthUm,
  fieldAngleDeg: Number(tracedObjectRows[5]?.yHeightAngle),
  referenceMode: result.referenceMode,
  chiefReferenceMode: result.chiefReferenceMode,
  chiefRayLaunchOrigin: result.chiefRayLaunchOrigin,
  pupilSample: { x: selectedSample?.pupilU, y: selectedSample?.pupilV },
  sampleOpdMm: Number.isFinite(sampleOpdUm) ? sampleOpdUm / 1000 : null,
  samplePreTargetPoint: selectedSample?.marginalPreTargetPoint,
  samplePreTargetDirection: selectedSample?.marginalPreTargetDirection,
  sampleTargetPoint: selectedSample?.marginalTargetPoint,
  sampleTargetDirection: selectedSample?.marginalTargetDirection,
  sampleOplTerms: selectedSample && {
    chiefOplUm: selectedSample.chiefOplUm,
    marginalOplUm: selectedSample.marginalOplUm,
    chiefPreTargetOplUm: selectedSample.chiefPreTargetOplUm,
    marginalPreTargetOplUm: selectedSample.marginalPreTargetOplUm,
    chiefSphereOplUm: selectedSample.chiefSphereOplUm,
    marginalSphereOplUm: selectedSample.marginalSphereOplUm,
    referenceOpdUm: selectedSample.referenceOpdUm,
    spherePathDeltaUm: selectedSample.spherePathDeltaUm,
  },
  samplePreTargetLocalState,
  sampleFirstSurfaceState,
  meridionalTargetStates: result.opdTermSamples
    ?.filter((sample) => sample.label.startsWith('meridional-'))
    .map((sample) => ({
      pupilV: sample.pupilV,
      point: sample.marginalTargetPoint,
      direction: sample.marginalTargetDirection,
      opdUm: sample.referenceOpdUm,
    })),
  targetSurface: result.targetSurface,
  referenceSphereCenter: center,
  referenceSphereRadiusMm: result.referenceSphereRadiusMm,
  baselineReferenceSphereRadiusMm: baseline.referenceSphereRadiusMm,
  radiusErrorMm: radiusError,
}, null, 2));