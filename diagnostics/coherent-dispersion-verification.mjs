import assert from 'node:assert/strict';
import { createDefaultPhysicalBlock, buildHybridAssemblyFromConfiguration } from '../analysis/hybrid-design.ts';
import { substrateRefractiveIndex, sourceSpectralPhaseRad } from '../analysis/material-dispersion.ts';
import { runPortRoutedTrace } from '../analysis/port-routed-trace.ts';
import { traceSequentialGroup } from '../analysis/exact-sequential-group.ts';
import { synthesizeDetectorLinearOpdCameraRaster } from '../analysis/detector-signal.ts';

const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
// Independent N-BK7 Sellmeier reference (lambda in micrometres).
function bk7(wavelengthNm) {
  const l2 = (wavelengthNm / 1000) ** 2;
  return Math.sqrt(1 + 1.03961212 * l2 / (l2 - 0.00600069867)
    + 0.231792344 * l2 / (l2 - 0.0200179144) + 1.01046945 * l2 / (l2 - 103.560653));
}
for (const wavelength of [450, 550, 650, 1550]) close(substrateRefractiveIndex({ substrateMaterial: 'N-BK7' }, wavelength), bk7(wavelength), 1e-12, 'catalog n(lambda)');
close(substrateRefractiveIndex({ substrateMaterial: '', substrateIndexNd: 1.6, substrateAbbeNumber: 40 }, 587.5618), 1.6, 1e-12, 'custom nd anchor');
const custom = { substrateMaterial: '', substrateIndexNd: 1.6, substrateAbbeNumber: 40 };
close(substrateRefractiveIndex(custom, 486.1327) - substrateRefractiveIndex(custom, 656.2725), 0.6 / 40, 1e-12, 'Abbe definition');
close(substrateRefractiveIndex({ substrateIndexNd: 1.45 }, 450), 1.45, 1e-12, 'legacy explicit constant index');
close(substrateRefractiveIndex({ substrateMaterial: '1.5168' }, 450), 1.5168, 1e-12, 'numeric glass name is not snapped to a catalog glass');
close(substrateRefractiveIndex({}, 450), bk7(450), 1e-12, 'unspecified substrate default');
assert.throws(() => substrateRefractiveIndex({ substrateMaterial: 'missing-glass' }, 550), /Unknown substrate glass/);

function physical(type, id, parameters) {
  const block = createDefaultPhysicalBlock(type, id);
  Object.assign(block.parameters, parameters);
  return block;
}
function fixture(type = 'NDFilter', model = 'cube', reflected = false, angle = 0) {
  const source = physical('BroadbandSource', 'source', { positionZmm: -21, depthMm: 2, minWavelengthNm: 450, maxWavelengthNm: 650, centerWavelengthNm: 550, spectralSamples: 5, totalPowerW: 1, beamDiameterMm: 0.1, divergenceDeg: 0 });
  const medium = physical(type, 'medium', { positionZmm: 20, widthMm: 10, heightMm: 10, depthMm: 10, rotationYdeg: angle, beamSplitterModel: model, substrateThicknessMm: 10, substrateMaterial: 'N-BK7', transmission: 1, reflectance: 0.5, transmittance: 0.5, reflectedPhaseDeg: 0, transmittedPhaseDeg: 0 });
  const detector = physical('AreaDetector', 'camera', { positionZmm: reflected ? 20 : 100, positionXmm: reflected ? 100 : 0, rotationYdeg: reflected ? 90 : 0, depthMm: 10, pixelCountX: 64, pixelCountY: 64, pixelPitchUm: 1000, frontOnly: false });
  const connections = [
    { id: 'a', from: { blockId: 'source', portId: 'emit' }, to: { blockId: 'medium', portId: type === 'NDFilter' ? 'in' : 'common' }, autoPlace: false },
    { id: 'b', from: { blockId: 'medium', portId: type === 'NDFilter' ? 'out' : reflected ? 'reflect' : 'transmit' }, to: { blockId: 'camera', portId: 'detect' }, autoPlace: false },
  ];
  return { id: 1, name: 'Dispersion regression', assemblyRoutingMode: 'engineered-paths', blocks: [source, medium, detector], sequentialGroups: [], designConnections: connections,
    portRoutes: [{ id: 'route', label: 'test', sourceBlockId: 'source', detectorBlockId: 'camera', steps: connections.map((c) => ({ connectionId: c.id, direction: 'forward' })) }],
    routeSets: [{ id: 'set', detectorBlockId: 'camera', routeIds: ['route'] }] };
}
const options = { spatialSamples: 1, spectralSamples: 5, renderRayLimit: 100, spectralFieldsOnly: true };
const reports = [];
for (const [type, model, reflected, angle] of [['NDFilter', 'cube', false, 0], ['NDFilter', 'cube', false, 30], ['BeamSplitter', 'cube', false, 0], ['BeamSplitter', 'cube', true, 0], ['BeamSplitter', 'plate', false, 30]]) {
  const config = fixture(type, model, reflected, angle);
  const trace = await runPortRoutedTrace(config, options);
  assert.equal(trace.routeMetrics[0]?.valid, true, trace.routeMetrics[0]?.failureReason);
  const samples = trace.detectors[0].spectralFields;
  assert.equal(samples.length, 5, 'every wavelength reaches the detector');
  for (const sample of samples) {
    const segments = trace.segments.filter((s) => s.wavelengthNm === sample.wavelengthNm);
    const length = (s) => Math.hypot(s.toMm.x - s.fromMm.x, s.toMm.y - s.fromMm.y, s.toMm.z - s.fromMm.z);
    const inside = segments.filter((s) => s.kind === 'component').reduce((sum, s) => sum + length(s), 0);
    const outside = segments.filter((s) => s.kind === 'free-space').reduce((sum, s) => sum + length(s), 0);
    close(sample.opticalPathLengthMm, outside + bk7(sample.wavelengthNm) * inside, 1e-9, `${type}/${model} OPL`);
    const phase = 2 * Math.PI * sample.opticalPathLengthMm * 1e6 / sample.wavelengthNm;
    const amplitude = Math.hypot(sample.fieldRe, sample.fieldIm);
    close(sample.fieldRe / amplitude, Math.cos(phase), 5e-9, 'material phase real');
    close(sample.fieldIm / amplitude, Math.sin(phase), 5e-9, 'material phase imaginary');
    if (type === 'NDFilter') {
      const incidence = angle * Math.PI / 180;
      const refracted = Math.asin(Math.sin(incidence) / bk7(sample.wavelengthNm));
      const shift = 10 * Math.sin(incidence - refracted) / Math.cos(refracted);
      close(sample.pixelX + 0.5 - 32, shift, 1e-9, 'parallel slab chromatic lateral displacement');
    }
  }
  assert.notEqual(samples[0].opticalPathLengthMm, samples.at(-1).opticalPathLengthMm, 'substrate OPL is dispersive');
  reports.push({ type, model, reflected, angle, hits: samples.length, opl450: samples[0].opticalPathLengthMm, opl650: samples.at(-1).opticalPathLengthMm });
}

// The real-lens Rust/WASM path must agree with the same glass model, in both directions.
const group = { id: 'slab', blocks: [{ blockId: 'lens', blockType: 'Lens', parameters: { frontRadius: 0, backRadius: 0, centerThickness: 10, material: 'N-BK7', semiDiameter: 10 }, variables: {} }], rootTransform: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } } };
for (const wavelengthNm of [450, 650, 1550]) {
  const forward = await traceSequentialGroup(group, 'Front', { positionMm: { x: 0, y: 0, z: -1 }, direction: { x: 0, y: 0, z: 1 }, wavelengthNm });
  assert.equal(forward.ok, true, forward.failureReason);
  close(forward.oplMm, 1 + 10 * bk7(wavelengthNm), 1e-9, 'exact lens forward dispersion');
  const reverse = await traceSequentialGroup(group, 'Back', { positionMm: { x: 0, y: 0, z: 11 }, direction: { x: 0, y: 0, z: -1 }, wavelengthNm });
  assert.equal(reverse.ok, true, reverse.failureReason);
  close(reverse.oplMm, forward.oplMm, 1e-9, 'exact lens reverse dispersion');
}

// GDD and delay must survive the Block -> Source -> Camera chain.
const plain = fixture();
const chirped = structuredClone(plain);
Object.assign(chirped.blocks[0].parameters, { initialPhaseRad: 0.2, relativePhaseRad: 0.1, relativeDelayFs: 5, groupDelayDispersionFs2: 100 });
const source = buildHybridAssemblyFromConfiguration(chirped).source;
assert.equal(source.groupDelayDispersionFs2, 100);
const baseSamples = (await runPortRoutedTrace(plain, options)).detectors[0].spectralFields;
const gddSamples = (await runPortRoutedTrace(chirped, options)).detectors[0].spectralFields;
for (let i = 0; i < baseSamples.length; i++) {
  const a = baseSamples[i]; const b = gddSamples[i];
  const actual = Math.atan2(b.fieldIm, b.fieldRe) - Math.atan2(a.fieldIm, a.fieldRe);
  const deltaOmega = 2 * Math.PI * (b.frequencyHz - 299792458 / 550e-9);
  const expected = 0.3 + 5e-15 * deltaOmega + 0.5 * 100e-30 * deltaOmega ** 2;
  close(Math.sin(actual - expected), 0, 1e-8, 'GDD appears at Camera');
  close(sourceSpectralPhaseRad(source, b.frequencyHz), expected, 1e-10, 'source spectral phase convention');
}

// Equal dispersive arms cancel. Changing only the other arm's glass leaves
// wavelength-dependent phase, including curvature after scalar delay removal.
const other = structuredClone(plain);
other.blocks[1].parameters.substrateMaterial = 'AIR';
const otherSamples = (await runPortRoutedTrace(other, options)).detectors[0].spectralFields;
const chirpedOther = structuredClone(other);
Object.assign(chirpedOther.blocks[0].parameters, chirped.blocks[0].parameters);
const chirpedOtherSamples = (await runPortRoutedTrace(chirpedOther, options)).detectors[0].spectralFields;
const crossPhase = (a, b) => Math.atan2(a.fieldIm * b.fieldRe - a.fieldRe * b.fieldIm, a.fieldRe * b.fieldRe + a.fieldIm * b.fieldIm);
for (let i = 0; i < baseSamples.length; i++) {
  close(crossPhase(baseSamples[i], baseSamples[i]), 0, 1e-12, 'balanced material cancels');
  close(Math.sin(crossPhase(gddSamples[i], chirpedOtherSamples[i]) - crossPhase(baseSamples[i], otherSamples[i])), 0, 1e-8, 'shared source GDD cancels');
}
const centerLambda = 550e-6;
const nDerivative = (bk7(550.001) - bk7(549.999)) / (0.002e-6);
const groupOpd = 10 * (bk7(550) - 1 - centerLambda * nDerivative);
const centerPhase = 2 * Math.PI * 10 * (bk7(550) - 1) / centerLambda;
const residualPhase = baseSamples.map((sample, i) => {
  const lambda = sample.wavelengthNm * 1e-6;
  return 2 * Math.PI * (sample.opticalPathLengthMm - otherSamples[i].opticalPathLengthMm) / lambda
    - centerPhase - 2 * Math.PI * groupOpd * (1 / lambda - 1 / centerLambda);
});
assert.ok(Math.max(...residualPhase.map(Math.abs)) > 1, 'differential material dispersion survives scalar OPD calibration');

// Linear-OPD Camera conversion must retain the per-wavelength traced material OPL.
const rasterFields = [];
for (const sample of baseSamples) {
  rasterFields.push({ ...sample, routeId: 'measurement', pixelX: 8, targetXmm: 0 });
  rasterFields.push({ ...sample, routeId: 'reference', opticalPathLengthMm: 115, pixelX: 8, detectorDelaySlopeMmPerMm: 0.01 });
}
const raster = synthesizeDetectorLinearOpdCameraRaster({ spectralFields: rasterFields, measurementRouteId: 'measurement', referenceRouteId: 'reference', detector: { pixelCountX: 16, pixelCountY: 16, pixelPitchUm: 10 }, cameraXMin: 0, cameraXMax: 15, maximumWidth: 16, maximumHeight: 16 });
assert.ok(raster);
for (const y of [0, 7, 15]) {
  const yMm = (y + 0.5 - 8) * 0.01;
  const expected = baseSamples.reduce((sum, sample) => {
    const power = sample.fieldRe ** 2 + sample.fieldIm ** 2;
    return sum + 2 * power * (1 + Math.cos(2 * Math.PI * (sample.opticalPathLengthMm - 115 - 0.01 * yMm) * 1e6 / sample.wavelengthNm));
  }, 0);
  close(raster.powerWPerPixel[y * 16 + 8], expected, 1e-8, 'broadband Camera dispersion');
}
console.log(JSON.stringify({ ok: true, checks: ['Catalog and nd/Vd', 'ND tilted slab', 'Cube R/T and Plate', 'Rust exact forward/reverse', 'Source GDD at Camera', 'Common-phase cancellation and residual dispersion', 'Broadband Camera raster'], reports }, null, 2));
