import fs from 'node:fs';
import assert from 'node:assert/strict';

if (typeof globalThis.self === 'undefined') globalThis.self = new EventTarget();
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.addEventListener !== 'function') globalThis.addEventListener = globalThis.self.addEventListener.bind(globalThis.self);
if (typeof globalThis.removeEventListener !== 'function') globalThis.removeEventListener = globalThis.self.removeEventListener.bind(globalThis.self);
if (typeof globalThis.dispatchEvent !== 'function') globalThis.dispatchEvent = globalThis.self.dispatchEvent.bind(globalThis.self);
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };
}

const { expandBlocksToOpticalSystemRows } = await import('../data/block-schema.ts');
const {
  runNativeSphericalAberration,
  runNativeSpotRaytrace,
  runNativeAstigmatism,
  runNativeTransverseAberration,
  runNativeOpdMap,
  runNativeOpdRmsWaves,
  runNativeChiefRayAngle,
  runNativeParaxialMetrics,
  runNativeSeidel,
  runNativeThroughFocusMtfMap,
  runNativeFieldMtfMap,
  runNativePsfMap,
  runNativeMtfMap,
  runNativeDistortion,
  runNativeGridDistortion,
  runNativeMagnificationChromaticAberration,
} = await import('../src/desktop/ipc/client.ts');
const { createOPDCalculator, createWavefrontAnalyzer } = await import('../evaluation/wavefront/wavefront.ts');
const {
  hasAnamorphicIdealThinLens,
  isRotationallySymmetricIdealThinLensOnlySystem,
} = await import('../utils/ideal-thin-lens.ts');

const input = JSON.parse(fs.readFileSync(
  new URL('../Examples/20260823_bug_02.json', import.meta.url),
  'utf8',
));
const activeConfig = input?.configurations?.configurations?.[0];
const expanded = expandBlocksToOpticalSystemRows(activeConfig?.blocks || []);
const opticalSystemRows = expanded.rows;
const sourceRows = input.source.filter((row) => row.enabled !== false);
const objectRows = input.object.filter((row) => row.enabled !== false);
const targetSurface = opticalSystemRows.length - 1;
const wavelengthUm = Number(sourceRows.find((row) => String(row.primary).toLowerCase().includes('primary'))?.wavelength) || 0.5875618;
const symmetricIdealRows = opticalSystemRows.map((row) => (
  row?._blockId === 'Paraxial-2'
    ? { ...row, _thinLensFocalLengthY: 100 }
    : { ...row }
));

assert.equal(hasAnamorphicIdealThinLens(opticalSystemRows), true, 'fixture must exercise different ideal-lens X/Y powers');
assert.equal(hasAnamorphicIdealThinLens(symmetricIdealRows), false, 'equal ideal-lens X/Y powers must remain supported');
assert.equal(isRotationallySymmetricIdealThinLensOnlySystem(symmetricIdealRows), true, 'symmetric ideal-only system was misclassified');

const quiet = async (callback) => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await callback();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
};

const summarizeGrid = (grid) => {
  const values = (Array.isArray(grid) ? grid : [])
    .flatMap((row) => Array.isArray(row) ? row : [])
    .map(Number)
    .filter(Number.isFinite);
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    rms: values.length ? Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) : null,
  };
};

const run = async (name, callback, summarize = (value) => value) => {
  const started = performance.now();
  try {
    const result = await quiet(callback);
    return { name, ok: true, elapsedMs: performance.now() - started, result: summarize(result) };
  } catch (error) {
    return { name, ok: false, elapsedMs: performance.now() - started, error: String(error?.stack || error) };
  }
};

const results = [];
results.push(await run('opd-native', () => runNativeOpdMap({
  opticalSystemRows,
  sourceRows,
  objectRows,
  objectIndex: 0,
  surfaceIndex: targetSurface,
  gridSize: 33,
  wavelengthUm,
  pupilSamplingMode: 'stop',
  opdDisplayMode: 'raw',
}), (value) => ({
  backend: value.backend,
  hitCount: value.hitCount,
  sampleCount: value.sampleCount,
  effectivePupilRadiusMm: value.effectivePupilRadiusMm,
  raw: summarizeGrid(value.rawOpdGrid),
  display: summarizeGrid(value.displayOpdGrid),
  targetHitX: summarizeGrid(value.targetHitXGridMm),
  targetHitY: summarizeGrid(value.targetHitYGridMm),
  message: value.message,
})));

results.push(await run('opd-rms', () => runNativeOpdRmsWaves({
  opticalSystemRows,
  sourceRows,
  objectRows,
  objectIndex: 0,
  surfaceIndex: targetSurface,
  gridSize: 33,
  wavelengthUm,
  pupilSamplingMode: 'stop',
  opdDisplayMode: 'raw',
})));

results.push(await run('opd-scalar-wavefront', async () => {
  const calculator = createOPDCalculator(opticalSystemRows, wavelengthUm);
  const analyzer = createWavefrontAnalyzer(calculator);
  const map = await analyzer.generateWavefrontMap({
    type: 'Rectangle',
    position: 'Rectangle',
    objectIndex: 0,
    displayName: 'Object 1',
    x: 0,
    y: 0,
    xHeight: 0,
    yHeight: 0,
    fieldAngle: { x: 0, y: 0 },
    fieldX: 0,
    fieldY: 0,
    wavelength: wavelengthUm,
  }, 17, 'circular', {
    recordRays: false,
    opdMode: 'simple',
    renderFromZernike: false,
    iterationReductionPreset: false,
    fullBatchTraceExperimental: false,
    traceOptions: {
      useRustWasm: false,
      requireWasmRayTracing: false,
      requireRustWasm: false,
      allowNonStrict: true,
    },
  });
  return {
    map,
    recordedSurfaceIndices: calculator._recordedSurfaceIndices,
    thinLensRows: opticalSystemRows.map((row, index) => ({
      index,
      blockType: row?._blockType,
      surfaceRole: row?._surfaceRole,
      fx: row?._thinLensFocalLengthX,
      fy: row?._thinLensFocalLengthY,
    })).filter((row) => row.blockType === 'Paraxial' || row.blockType === 'ThinLens'),
  };
}, (value) => ({
  error: value.map?.error,
  gridSize: value.map?.gridSize,
  points: Array.isArray(value.map?.pupilCoordinates) ? value.map.pupilCoordinates.length : 0,
  rawOpdMicrons: summarizeGrid([value.map?.raw?.opds || value.map?.opds || []]),
  wavefront: summarizeGrid([value.map?.wavefrontAberrations || []]),
  recordedSurfaceIndices: value.recordedSurfaceIndices,
  thinLensRows: value.thinLensRows,
  keys: Object.keys(value.map || {}).slice(0, 40),
})));

results.push(await run('spherical', () => runNativeSphericalAberration({
  opticalSystemRows, sourceRows, objectRows, surfaceIndex: targetSurface, rayCount: 11, wavelengthMode: 'primary',
}), (value) => ({
  backend: value.backend,
  meridionalCounts: value.meridionalData?.map((series) => series.points?.length),
  sagittalCounts: value.sagittalData?.map((series) => series.points?.length),
  meridionalSpan: value.meridionalData?.map((series) => summarizeGrid([series.points?.map((point) => point.longitudinalAberration)])),
  sagittalSpan: value.sagittalData?.map((series) => summarizeGrid([series.points?.map((point) => point.longitudinalAberration)])),
})));

if (typeof globalThis.document === 'undefined') {
  globalThis.document = { getElementById: () => null, addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [] };
}
results.push(await run('astigmatism', () => runNativeAstigmatism({
  opticalSystemRows, sourceRows, objectRows, surfaceIndex: targetSurface, pointCount: 5, rayCount: 25, ringCount: 3, pattern: 'annular', wavelengthMode: 'primary',
}), (value) => ({ backend: value.backend, data: value.data, message: value.message })));

results.push(await run('transverse', () => runNativeTransverseAberration({
  opticalSystemRows, sourceRows, objectRows, surfaceIndex: targetSurface, rayCount: 11, ringCount: 3, pattern: 'cross', wavelengthMode: 'primary', wavelength: wavelengthUm,
}), (value) => ({
  backend: value.backend,
  meridional: value.meridionalData?.map((series) => summarizeGrid([series.points?.map((point) => point.transverseAberration)])),
  sagittal: value.sagittalData?.map((series) => summarizeGrid([series.points?.map((point) => point.transverseAberration)])),
  message: value.message,
})));

results.push(await run('chief-ray-angle', () => runNativeChiefRayAngle({ opticalSystemRows, sourceRows, objectRows })));
results.push(await run('paraxial-metrics', () => runNativeParaxialMetrics({ opticalSystemRows, sourceRows, objectRows })));
results.push(await run('seidel', () => runNativeSeidel({ opticalSystemRows, sourceRows, objectRows, referenceWavelengthUm: wavelengthUm })));
results.push(await run('symmetric-ideal-seidel', () => runNativeSeidel({
  opticalSystemRows: symmetricIdealRows,
  sourceRows,
  objectRows,
  referenceWavelengthUm: wavelengthUm,
})));
results.push(await run('distortion', () => runNativeDistortion({
  opticalSystemRows, sourceRows, objectRows, surfaceIndex: targetSurface, fieldSamples: [0, 1, 2], wavelength: wavelengthUm,
}), (value) => ({ backend: value.backend, idealHeights: value.idealHeights, realHeights: value.realHeights, distortion: value.distortion, message: value.message })));
results.push(await run('grid-distortion', () => runNativeGridDistortion({
  opticalSystemRows, sourceRows, objectRows, surfaceIndex: targetSurface, gridSize: 3, wavelength: wavelengthUm,
}), (value) => ({ backend: value.backend, idealX: value.idealX, idealY: value.idealY, realX: value.realX, realY: value.realY, message: value.message })));
results.push(await run('lca', () => runNativeMagnificationChromaticAberration({
  opticalSystemRows,
  sourceRows,
  fieldSamples: [0, 1, 2],
  wavelengths: sourceRows.map((row) => Number(row.wavelength)),
  referenceWavelength: wavelengthUm,
  rayCount: 25,
  ringCount: 3,
  chiefRayDefinition: 'stop-center',
}), (value) => ({ backend: value.backend, data: value.data, message: value.message })));

results.push(await run('through-focus-mtf', () => runNativeThroughFocusMtfMap({
  opticalSystemRows,
  sourceRows,
  objectRows,
  objectIndex: 0,
  defocusMinMm: -1,
  defocusMaxMm: 1,
  steps: 3,
  targetFrequencyLpmm: 10,
  samplingSize: 32,
})));

results.push(await run('field-mtf', () => runNativeFieldMtfMap({
  opticalSystemRows,
  sourceRows,
  objectRows,
  objectIndex: 0,
  fieldMin: 0,
  fieldMax: 1,
  steps: 3,
  samplingSize: 32,
  firstFrequencyLpmm: 10,
  secondFrequencyLpmm: 20,
})));

results.push(await run('psf-mtf', async () => {
  const spot = await runNativeSpotRaytrace({
    opticalSystemRows,
    sourceRows,
    objectRows: [objectRows[0]],
    surfaceIndex: targetSurface,
    rayCount: 1001,
    ringCount: 16,
    pattern: 'grid',
    wavelengthMode: 'primary',
    forceRustWasm: true,
  });
  const rayHitsUm = (spot.series || [])
    .flatMap((series) => series.points || [])
    .map((point) => ({ xUm: Number(point.xUm), yUm: Number(point.yUm), weight: 1 }))
    .filter((point) => Number.isFinite(point.xUm) && Number.isFinite(point.yUm));
  const opd = await runNativeOpdMap({
    opticalSystemRows, sourceRows, objectRows, objectIndex: 0, surfaceIndex: targetSurface,
    gridSize: 33, wavelengthUm, pupilSamplingMode: 'stop', opdDisplayMode: 'raw',
  });
  const pupilMask = opd.pupilMaskGrid.map((row) => row.map(Boolean));
  const gridOpd = opd.displayOpdGrid.map((row) => row.map((value) => Number.isFinite(Number(value)) ? Number(value) * wavelengthUm : 0));
  const psf = await runNativePsfMap({
    gridOpd,
    pupilMask,
    wavelengthUm,
    pixelSizeUm: 0.75,
    zeroPadTo: 128,
    propagationMode: 'auto',
    targetHitXGridMm: opd.targetHitXGridMm,
    targetHitYGridMm: opd.targetHitYGridMm,
    rayHitsUm,
    hybridOutputSize: 512,
    diffractionFwhmXUm: 3.0,
    diffractionFwhmYUm: 3.0,
  });
  const mtf = await runNativeMtfMap({ psfData: psf.psfData, pixelSizeUm: psf.pixelSizeUm || 0.75, sampleFrequenciesLpmm: [10, 20] });
  return { psf, mtf };
}, ({ psf, mtf }) => ({
  psfBackend: psf.backend,
  fwhm: psf.metrics?.fwhm,
  method: psf.method,
  geometricSpanUm: psf.geometricSpanUm,
  phaseSampling: psf.phaseSampling,
  pixelSizeUm: psf.pixelSizeUm,
  center: psf.metrics?.centerPosition,
  mtfBackend: mtf.backend,
  tangential: mtf.sampledMtfTangential,
  sagittal: mtf.sampledMtfSagittal,
})));

const byName = (name) => results.find((entry) => entry.name === name);
const expectOk = (name) => {
  const entry = byName(name);
  assert(entry, `missing audit result: ${name}`);
  assert.equal(entry.ok, true, `${name} failed: ${entry.error || 'unknown error'}`);
  return entry.result;
};

const transverse = expectOk('transverse');
assert(Number(transverse.meridional?.[0]?.max) - Number(transverse.meridional?.[0]?.min) > 19.9, 'Y/meridional line must span about 20 mm');
assert(Math.abs(Number(transverse.sagittal?.[0]?.max) - Number(transverse.sagittal?.[0]?.min)) < 1e-6, 'X/sagittal focus must remain near zero');
const opd = expectOk('opd-native');
assert(opd.hitCount > 700 && opd.raw.rms > 1, 'anamorphic OPD must contain a populated non-flat wavefront');
assert(opd.targetHitX.count > 700 && opd.targetHitY.count > 700, 'OPD kernel must expose detector-plane intersection grids');
expectOk('opd-rms');
expectOk('opd-scalar-wavefront');
const spherical = expectOk('spherical');
assert.equal(spherical.meridionalCounts?.[0], 0, 'afocal Y meridian must not invent a finite longitudinal focus');
assert.equal(spherical.sagittalCounts?.[0], 11, 'focused X meridian must retain all samples');
const astig = expectOk('astigmatism');
assert(astig.data.length > 0, 'astigmatism must report axis status for an ideal line-focus system');
assert(astig.data.every((row) => row.meridionalFocusStatus === 'afocal' && row.sagittalFocusStatus === 'finite'));
expectOk('chief-ray-angle');
const paraxial = expectOk('paraxial-metrics');
assert(Math.abs(paraxial.axisMetrics.x.EFL - 66.6666666667) < 1e-6);
assert(Math.abs(paraxial.axisMetrics.y.EFL - 100) < 1e-9);
assert.equal(paraxial.axisFocusStatus.x, 'finite');
assert.equal(paraxial.axisFocusStatus.y, 'afocal');
assert.equal(paraxial.primaryAxis, 'x');
const psfMtf = expectOk('psf-mtf');
assert.equal(psfMtf.method, 'hybrid-geometric', 'strong anamorphic blur must auto-select hybrid PSF');
assert(psfMtf.geometricSpanUm.y > 19_900 && psfMtf.geometricSpanUm.x < 1e-3, 'hybrid PSF must be a vertical line');
assert(psfMtf.fwhm.y > psfMtf.fwhm.x * 20, 'hybrid PSF line aspect ratio is too small');
const seidel = byName('seidel');
assert.equal(seidel?.ok, false, 'classical rotational Seidel must remain explicitly unavailable for an anamorphic system');
assert.match(String(seidel?.error || ''), /rotationally symmetric/);
expectOk('symmetric-ideal-seidel');
expectOk('distortion');
const grid = expectOk('grid-distortion');
assert(grid.idealX.length === 9 && grid.realX.filter(Number.isFinite).length === 9);
expectOk('lca');
expectOk('through-focus-mtf');
expectOk('field-mtf');
assert(psfMtf.fwhm && Number.isFinite(psfMtf.fwhm.x) && Number.isFinite(psfMtf.fwhm.y));

const verbose = process.argv.includes('--verbose');
console.log(JSON.stringify({
  fixture: '20260823_bug_02.json',
  auditPassed: true,
  checks: results.map((entry) => ({ name: entry.name, ok: entry.ok })),
  transverseLineSpanMm: Number(transverse.meridional?.[0]?.max) - Number(transverse.meridional?.[0]?.min),
  focusedAxisSpanMm: Number(transverse.sagittal?.[0]?.max) - Number(transverse.sagittal?.[0]?.min),
  axisMetrics: paraxial.axisMetrics,
  axisFocusStatus: paraxial.axisFocusStatus,
  psfFwhm: psfMtf.fwhm,
  ...(verbose ? { results } : {}),
}, null, 2));
process.exit(0);
