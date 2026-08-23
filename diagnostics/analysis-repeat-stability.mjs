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

const [native, paraxial, scaleModel] = await Promise.all([
  import('../src/desktop/ipc/client.ts'),
  import('../raytracing/core/ray-paraxial.ts'),
  import('../src/app/psf-scale-model.ts'),
]);
const input = JSON.parse(fs.readFileSync(
  new URL('../Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json', import.meta.url),
  'utf8',
));
const objectRow = input.object[1];
const wavelengthUm = Number(
  input.source.find((row) => String(row.primary || '').includes('Primary'))?.wavelength,
);
const samplingSize = 32;
const fftSize = 64;
const repetitions = 6;
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

const runs = [];
try {
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const startedAt = performance.now();
    const distortion = await native.runNativeGridDistortion({
      opticalSystemRows: input.opticalSystem,
      sourceRows: input.source,
      objectRows: input.object,
      gridSize: 5,
      wavelength: wavelengthUm,
      detailProgress: false,
    });
    const opd = await native.runNativeOpdMap({
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
      opdDisplayMode: 'pistonTiltRemoved',
    });
    const rawGrid = Array.isArray(opd.rawOpdGrid) ? opd.rawOpdGrid : [];
    const displayGrid = Array.isArray(opd.displayOpdGrid) ? opd.displayOpdGrid : rawGrid;
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
    assert.ok(validPupilSamples > 0, 'OPD returned no valid pupil samples');
    const psf = await native.runNativePsfMap({
      gridOpd,
      gridAmplitude,
      pupilMask,
      wavelengthUm,
      pixelSizeUm,
      removeTilt: false,
      zeroPadTo: fftSize,
      recenterIfWrapped: false,
    });
    const mtf = await native.runNativeMtfMap({
      psfData: psf.psfData,
      pixelSizeUm,
      maxFrequencyLpmm: 100,
      sampleFrequenciesLpmm: [0, 10, 20, 40, 80],
      points: 101,
      method: 'hopkins-tcc',
    });
    const finiteDistortion = distortion.realX.filter((value) => Number.isFinite(value));
    const finiteOpd = displayGrid.flat().filter((value) => Number.isFinite(value));
    const psfCenter = Number(psf.psfData?.[fftSize / 2]?.[fftSize / 2]);
    const mtfTangential = (mtf.sampledMtfTangential || mtf.sampled_mtf_tangential || []).map(Number);
    const mtfSagittal = (mtf.sampledMtfSagittal || mtf.sampled_mtf_sagittal || []).map(Number);
    assert.equal(mtfTangential.length, 5, 'MTF tangential sample count');
    assert.equal(mtfSagittal.length, 5, 'MTF sagittal sample count');
    runs.push({
      elapsedMs: performance.now() - startedAt,
      backend: [distortion.backend, opd.backend, psf.backend, mtf.backend],
      signature: [
        finiteDistortion.length,
        finiteDistortion.reduce((sum, value) => sum + value, 0),
        validPupilSamples,
        finiteOpd.reduce((sum, value) => sum + value, 0),
        psfCenter,
        Number(psf.metrics?.strehlRatio),
        ...mtfTangential,
        ...mtfSagittal,
      ],
    });
  }

  const reference = runs[0].signature;
  let maxOutputDelta = 0;
  for (const run of runs.slice(1)) {
    assert.equal(run.signature.length, reference.length, 'repeat signature width changed');
    run.signature.forEach((value, index) => {
      assert.ok(Number.isFinite(value), `repeat signature ${index} is not finite`);
      maxOutputDelta = Math.max(maxOutputDelta, Math.abs(value - reference[index]));
    });
  }
  assert.ok(maxOutputDelta <= 1e-12, `repeat output drifted by ${maxOutputDelta}`);
  const steadyTimings = runs.slice(1).map((run) => run.elapsedMs).sort((a, b) => a - b);
  const steadyMedianMs = steadyTimings[Math.floor(steadyTimings.length / 2)];
  const steadyMaxMs = Math.max(...steadyTimings);
  assert.ok(steadyMaxMs <= Math.max(1000, steadyMedianMs * 8), 'repeat runtime shows an excessive long-tail stall');
  assert.ok(runs.every((run) => run.backend.every((backend) => /rust-wasm/i.test(String(backend)))),
    'a repeated analysis fell back from Rust/WASM');

  originalLog(JSON.stringify({
    ok: true,
    fixture: 'US3834556 retrofocus 1/3.5 Object 2',
    repetitions,
    pipeline: ['Grid Distortion', 'OPD', 'PSF', 'MTF'],
    timingsMs: runs.map((run) => run.elapsedMs),
    warmupMs: runs[0].elapsedMs,
    steadyMedianMs,
    steadyMaxMs,
    maxOutputDelta,
    backend: runs[0].backend,
  }, null, 2));
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

process.exit(0);
