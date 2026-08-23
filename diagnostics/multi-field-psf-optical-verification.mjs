import assert from 'node:assert/strict';
import fs from 'node:fs';

globalThis.self = new EventTarget();
const wasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
const api = await wasm.preloadRustRayTracingWasm();
assert.ok(api, 'Rust ray-tracing WASM did not initialize');
const wasmService = await import('../core/wasm-service.ts');
wasmService.setWASMSystem({ backend: 'rust-wasm', isWASMReady: true, api });

globalThis.addEventListener = globalThis.self.addEventListener.bind(globalThis.self);
globalThis.removeEventListener = globalThis.self.removeEventListener.bind(globalThis.self);
globalThis.dispatchEvent = globalThis.self.dispatchEvent.bind(globalThis.self);
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };

const [{ runNativeOpdMap, runNativePsfMap }, paraxial, scaleModel] = await Promise.all([
  import('../src/desktop/ipc/client.ts'),
  import('../raytracing/core/ray-paraxial.ts'),
  import('../src/app/psf-scale-model.ts'),
]);
const input = JSON.parse(fs.readFileSync(
  new URL('../Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json', import.meta.url),
  'utf8',
));
const wavelengthUm = Number(
  input.source.find((row) => String(row.primary || '').includes('Primary'))?.wavelength,
);
const samplingSize = 32;
const fftSize = 64;
const diffraction = paraxial.calculateImageSpaceDiffractionParams(input.opticalSystem, wavelengthUm);
assert.ok(diffraction?.fNumberWorking > 0, 'working F-number is unavailable');
const pixelSizeUm = scaleModel.calculatePsfImagePixelSizeUm(
  wavelengthUm,
  diffraction.fNumberWorking,
  samplingSize,
  fftSize,
);

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = () => {};
console.warn = () => {};
console.error = () => {};
const fields = [];
try {
  for (const [objectIndex, objectRow] of input.object.entries()) {
    const opd = await runNativeOpdMap({
      opticalSystemRows: input.opticalSystem,
      sourceRows: input.source,
      objectRows: [objectRow],
      objectIndex: 0,
      surfaceIndex: input.opticalSystem.length - 1,
      gridSize: samplingSize,
      wavelengthUm,
      opdReferenceWavelengthUm: wavelengthUm,
      opdWaveNormalization: 'trace',
      pupilSamplingMode: 'entrance',
      chiefRayMode: 'stop-center',
      pupilNormalizationMode: 'fixed-entrance-pupil',
      exitPupilReferencePointMode: 'chief-ray-intersection',
      referenceMode: 'exit-pupil',
      opdDisplayMode: 'raw',
    });
    const rawGrid = Array.isArray(opd.rawOpdGrid) ? opd.rawOpdGrid : [];
    const displayGrid = Array.isArray(opd.displayOpdGrid) ? opd.displayOpdGrid : rawGrid;
    assert.equal(rawGrid.length, samplingSize, `Object ${objectIndex + 1} OPD grid height`);
    const gridOpd = Array.from({ length: samplingSize }, () => new Array(samplingSize).fill(0));
    const gridAmplitude = Array.from({ length: samplingSize }, () => new Array(samplingSize).fill(0));
    const pupilMask = Array.from({ length: samplingSize }, () => new Array(samplingSize).fill(false));
    let validPupilSamples = 0;
    for (let y = 0; y < samplingSize; y += 1) {
      for (let x = 0; x < samplingSize; x += 1) {
        const rawWaves = Number(rawGrid[y]?.[x]);
        if (!Number.isFinite(rawWaves)) continue;
        const displayWaves = Number(displayGrid[y]?.[x]);
        gridOpd[y][x] = (Number.isFinite(displayWaves) ? displayWaves : rawWaves) * wavelengthUm;
        gridAmplitude[y][x] = 1;
        pupilMask[y][x] = true;
        validPupilSamples += 1;
      }
    }
    assert.ok(validPupilSamples > 0, `Object ${objectIndex + 1} has no valid pupil samples`);
    const psf = await runNativePsfMap({
      gridOpd,
      gridAmplitude,
      pupilMask,
      wavelengthUm,
      pixelSizeUm,
      removeTilt: false,
      zeroPadTo: fftSize,
      recenterIfWrapped: false,
    });
    assert.equal(psf.psfData?.length, fftSize, `Object ${objectIndex + 1} PSF height`);
    let energy = 0;
    let peak = { x: -1, y: -1, value: -Infinity };
    let finiteCount = 0;
    psf.psfData.forEach((row, y) => {
      assert.equal(row.length, fftSize, `Object ${objectIndex + 1} PSF row width`);
      row.forEach((cell, x) => {
        const value = Number(cell);
        assert.ok(Number.isFinite(value) && value >= 0, `Object ${objectIndex + 1} invalid PSF intensity`);
        finiteCount += 1;
        energy += value;
        if (value > peak.value) peak = { x, y, value };
      });
    });
    assert.ok(energy > 0 && peak.value > 0, `Object ${objectIndex + 1} PSF has no energy`);
    fields.push({
      objectId: Number(objectRow.id ?? objectIndex + 1),
      fieldXDeg: Number(objectRow.xHeightAngle ?? 0),
      fieldYDeg: Number(objectRow.yHeightAngle ?? 0),
      opdBackend: opd.backend,
      psfBackend: psf.backend,
      validPupilSamples,
      finiteCount,
      energy,
      peak,
      strehlRatio: Number(psf.metrics?.strehlRatio),
      fwhmXUm: Number(psf.metrics?.fwhm?.x),
      fwhmYUm: Number(psf.metrics?.fwhm?.y),
    });
  }
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

assert.equal(fields.length, input.object.length, 'Multi-Field PSF omitted a configured object');
assert.ok(fields.some((field) => field.objectId === 3 && field.validPupilSamples > 0), 'Multi-Field PSF omitted Object 3');
assert.ok(fields.every((field) => Number.isFinite(field.strehlRatio)), 'Multi-Field PSF has a non-finite Strehl ratio');
originalLog(JSON.stringify({
  ok: true,
  samplingSize,
  fftSize,
  wavelengthUm,
  workingFNumber: diffraction.fNumberWorking,
  pixelSizeUm,
  fields,
}, null, 2));
