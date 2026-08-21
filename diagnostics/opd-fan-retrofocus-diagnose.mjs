import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = () => {};

const input = path.resolve(process.argv[2] || 'Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json');
const config = JSON.parse(await fs.readFile(input, 'utf8'));
const [{ preloadRustRayTracingWasm }, { extractOpdFanSections }, paraxial] = await Promise.all([
  import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts'),
  import('../evaluation/wavefront/opd-fan-plot.ts'),
  import('../raytracing/core/ray-paraxial.ts'),
]);

const primary = config.source.find((row) => String(row.primary || '').toLowerCase().includes('primary'))?.wavelength
  || config.source[0].wavelength;
const pupilDiameter = paraxial.calculateEntrancePupilDiameter(config.opticalSystem, primary);
const pupils = paraxial.calculatePupilsByNewSpec(config.opticalSystem, primary);
const exitPupil = paraxial.calculateExitPupilDiameter(config.opticalSystem, primary);
const rust = await preloadRustRayTracingWasm();
if (typeof rust?.run_native_opd_map_wasm_json !== 'function') throw new Error('Rust OPD WASM is unavailable');
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
const { generateRayStartPointsForObject } = await import('../optical/ray-renderer.ts');
const targetSurface = config.opticalSystem.findIndex((row) => String(row['object type'] || '').toLowerCase() === 'image');

const reports = [];
for (const wavelength of config.source.map((row) => Number(row.wavelength))) {
  const chiefRays = generateRayStartPointsForObject(config.object[2], config.opticalSystem, 3, null, {
    pattern: 'annular',
    wavelengthUm: wavelength,
    aimThroughStop: true,
    useChiefRayAnalysis: true,
    allowStopBasedOriginSolve: true,
    originSolveTraceBackend: 'rust',
    strictChiefDirectionSolve: true,
    targetSurfaceIndex: targetSurface,
  });
  const chiefRayLaunchOrigin = chiefRays?.expectedChiefOrigin ?? chiefRays?.[0]?.startP;
  const chiefRayLaunchDirection = chiefRays?.expectedChiefDir ?? chiefRays?.[0]?.dir;
  const raw = rust.run_native_opd_map_wasm_json(JSON.stringify({
    opticalSystemRows: config.opticalSystem.map((row) => ({
      ...row,
      __cooptResolvedRindex: paraxial.getRefractiveIndex(row, wavelength),
    })),
    referenceOpticalSystemRows: config.opticalSystem.map((row) => ({
      ...row,
      __cooptResolvedRindex: paraxial.getRefractiveIndex(row, primary),
    })),
    sourceRows: config.source,
    objectRows: config.object,
    objectIndex: 2,
    surfaceIndex: targetSurface,
    gridSize: 129,
    wavelengthUm: wavelength,
    opdReferenceWavelengthUm: primary,
    opdWaveNormalization: 'trace',
    pupilRadiusMm: pupilDiameter / 2,
    entrancePupilPositionFromFirstSurfaceMm: pupils?.entrancePupil?.position,
    exitPupilPositionFromLastSurfaceMm: exitPupil?.position,
    pupilSamplingMode: 'entrance',
    chiefRayLaunchOrigin,
    chiefRayLaunchDirection,
    chiefRayMode: 'stop-center',
    pupilNormalizationMode: 'fixed-entrance-pupil',
    exitPupilReferencePointMode: 'chief-ray-intersection',
    referenceSphereOptions: {
      referenceSphereWavelengthMode: 'primary-wavelength',
      opdDisplayMode: 'raw',
      exitPupilPositionSign: 'as-is',
      exitPupilPlaneDefinition: 'surface-local-axis',
      chiefImagePoint: 'chief-ray-image-point',
      sphereIntersection: 'exit-pupil-side',
      opticalPathSign: 'positive',
      exitPupilDirection: 'image-to-exit-pupil',
    },
    referenceMode: 'exit-pupil',
    opdDisplayMode: 'raw',
  }));
  const response = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const sections = extractOpdFanSections(
    response.displayOpdGrid,
    response.entrancePupilCoordinateXGrid,
    response.entrancePupilCoordinateYGrid,
    response.usedObjectX,
    response.usedObjectY,
  );
  const suspicious = sections.tangentialPoints.filter((point) => point.pupilCoordinate > 0.4);
  const finiteSuspicious = suspicious.filter((point) => Number.isFinite(point.opdWaves));
  const maxAbsOuterOpdWaves = finiteSuspicious.reduce(
    (maximum, point) => Math.max(maximum, Math.abs(point.opdWaves)),
    0,
  );
  reports.push({
    wavelength,
    hitCount: response.hitCount,
    sampleCount: response.sampleCount,
    finiteOuterPointCount: finiteSuspicious.length,
    maxAbsOuterOpdWaves,
  });
}

for (const report of reports) {
  assert.ok(report.hitCount > 0, `No valid OPD samples at ${report.wavelength} um`);
  assert.ok(
    report.maxAbsOuterOpdWaves < 0.1,
    `Backwards-ray OPD branch remains at ${report.wavelength} um: ${report.maxAbsOuterOpdWaves} waves`,
  );
}
console.log(JSON.stringify({ input, fieldAngleYDeg: 46, reports, result: 'pass' }, null, 2));
