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

const [native, simulation, multiField, paraxial, scaleModel, psfPlot] = await Promise.all([
  import('../src/desktop/ipc/client.ts'),
  import('../src/app/image-simulation-model.ts'),
  import('../src/app/multi-field-psf-model.ts'),
  import('../raytracing/core/ray-paraxial.ts'),
  import('../src/app/psf-scale-model.ts'),
  import('../evaluation/psf/psf-plot.ts'),
]);

const input = JSON.parse(fs.readFileSync(
  new URL('../Examples/US3834556_RETROFUCUS WIDE-ANGLE LENS SYSTEM_1／3.5.json', import.meta.url),
  'utf8',
));
const wavelengths = input.source.map((row) => ({
  wavelengthUm: Number(row.wavelength),
  weight: Math.max(0, Number(row.weight) || 0),
}));
const primaryWavelengthUm = Number(
  input.source.find((row) => String(row.primary || '').includes('Primary'))?.wavelength,
);
assert.equal(wavelengths.length, 3, 'fixture must retain all three spectral lines');
assert.ok(Number.isFinite(primaryWavelengthUm), 'primary wavelength is unavailable');

const samplingSize = 32;
const fftSize = 64;
const imageSize = 128;
const fieldGridSize = 3;
const kernelSize = 15;
const maximumAxisFieldDeg = Math.atan(
  Math.tan(46 * Math.PI / 180) * Math.SQRT1_2,
) * 180 / Math.PI;
const fieldPoints = multiField.buildMultiFieldPsfGrid({
  rows: fieldGridSize,
  columns: fieldGridSize,
  maxX: maximumAxisFieldDeg,
  maxY: maximumAxisFieldDeg,
  shape: 'rectangle',
}).filter((point) => point.inside);
assert.equal(fieldPoints.length, 9, '3x3 rectangular field grid must contain nine samples');
assert.ok(Math.abs(
  Math.atan(Math.hypot(
    Math.tan(maximumAxisFieldDeg * Math.PI / 180),
    Math.tan(maximumAxisFieldDeg * Math.PI / 180),
  )) * 180 / Math.PI - 46
) < 1e-10, 'corner field must remain on the configured 46-degree radial field');

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const distortionLayers = [];
const kernelsByWavelength = new Map();
let opdJobs = 0;
let psfJobs = 0;
try {
  for (const entry of wavelengths) {
    const response = await native.runNativeGridDistortion({
      opticalSystemRows: input.opticalSystem,
      sourceRows: input.source,
      objectRows: input.object,
      gridSize: 5,
      wavelength: entry.wavelengthUm,
      detailProgress: false,
    });
    assert.match(String(response.backend), /rust-wasm/i, 'Grid Distortion must use Web Rust/WASM');
    const map = {
      gridSize: Number(response.gridSize),
      idealX: response.idealX,
      idealY: response.idealY,
      realX: response.realX,
      realY: response.realY,
    };
    assert.equal(map.idealX.length, 25, 'distortion grid X length');
    assert.equal(map.realY.length, 25, 'distortion grid Y length');
    assert.ok(map.realX.some((value) => Number.isFinite(value)), 'distortion map has no reachable samples');
    distortionLayers.push({ ...entry, map, backend: response.backend });
    kernelsByWavelength.set(entry.wavelengthUm.toFixed(9), []);
  }

  const referenceLayer = distortionLayers.find(
    (layer) => Math.abs(layer.wavelengthUm - primaryWavelengthUm) < 1e-9,
  );
  assert.ok(referenceLayer, 'primary distortion layer is missing');
  const rasterExtent = simulation.getImageSimulationPhysicalExtent(referenceLayer.map);
  const imagePixelPitchXUm = rasterExtent.widthMm * 1000 / imageSize;
  const imagePixelPitchYUm = rasterExtent.heightMm * 1000 / imageSize;

  for (const point of fieldPoints) {
    const objectRow = multiField.buildMultiFieldPsfObjectRow(input.object, point, 'angle');
    const rotationDeg = multiField.getMultiFieldPsfLocalToGlobalRotationDeg(point, 'angle');
    for (const entry of wavelengths) {
      const diffraction = paraxial.calculateImageSpaceDiffractionParams(
        input.opticalSystem,
        entry.wavelengthUm,
      );
      assert.ok(diffraction?.fNumberWorking > 0, 'working F-number is unavailable');
      const pixelSizeUm = scaleModel.calculatePsfImagePixelSizeUm(
        entry.wavelengthUm,
        diffraction.fNumberWorking,
        samplingSize,
        fftSize,
      );
      const opd = await native.runNativeOpdMap({
        opticalSystemRows: input.opticalSystem,
        sourceRows: input.source,
        objectRows: [objectRow],
        objectIndex: 0,
        surfaceIndex: input.opticalSystem.length - 1,
        gridSize: samplingSize,
        wavelengthUm: entry.wavelengthUm,
        opdReferenceWavelengthUm: entry.wavelengthUm,
        opdWaveNormalization: 'trace',
        pupilSamplingMode: 'entrance',
        chiefRayMode: 'stop-center',
        pupilNormalizationMode: 'fixed-entrance-pupil',
        exitPupilReferencePointMode: 'chief-ray-intersection',
        referenceMode: 'exit-pupil',
        opdDisplayMode: 'pistonTiltRemoved',
      });
      opdJobs += 1;
      assert.match(String(opd.backend), /rust-wasm/i, 'OPD must use Web Rust/WASM');
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
          gridOpd[y][x] = (Number.isFinite(displayWaves) ? displayWaves : rawWaves) * entry.wavelengthUm;
          gridAmplitude[y][x] = 1;
          pupilMask[y][x] = true;
          validPupilSamples += 1;
        }
      }
      assert.ok(validPupilSamples > 0, `no pupil samples at field ${point.key}`);
      const psf = await native.runNativePsfMap({
        gridOpd,
        gridAmplitude,
        pupilMask,
        wavelengthUm: entry.wavelengthUm,
        pixelSizeUm,
        removeTilt: false,
        zeroPadTo: fftSize,
        recenterIfWrapped: false,
      });
      psfJobs += 1;
      assert.match(String(psf.backend), /rust-wasm/i, 'PSF must use Web Rust/WASM');
      assert.equal(psf.psfData?.length, fftSize, 'PSF output height');
      const kernel = simulation.resamplePsfToImageKernel(
        psf.psfData,
        pixelSizeUm,
        imagePixelPitchXUm,
        imagePixelPitchYUm,
        kernelSize,
        rotationDeg,
      );
      const kernelEnergy = kernel.data.reduce((sum, value) => sum + value, 0);
      assert.ok(Math.abs(kernelEnergy - 1) < 1e-6, 'rebinned PSF kernel must conserve energy');
      kernelsByWavelength.get(entry.wavelengthUm.toFixed(9)).push({
        xNorm: Math.tan(point.x * Math.PI / 180) / Math.tan(maximumAxisFieldDeg * Math.PI / 180),
        yNorm: Math.tan(point.y * Math.PI / 180) / Math.tan(maximumAxisFieldDeg * Math.PI / 180),
        kernel,
        fieldLabel: point.key,
      });
    }
  }

  const rgba = new Uint8ClampedArray(imageSize * imageSize * 4);
  for (let y = 0; y < imageSize; y += 1) {
    for (let x = 0; x < imageSize; x += 1) {
      const offset = (y * imageSize + x) * 4;
      const grid = (x % 16 < 2) || (y % 16 < 2);
      const checker = ((Math.floor(x / 8) + Math.floor(y / 8)) & 1) === 0;
      rgba[offset] = grid ? 22 : checker ? 242 : 196;
      rgba[offset + 1] = grid ? 68 : checker ? 230 : 206;
      rgba[offset + 2] = grid ? 152 : checker ? 212 : 238;
      rgba[offset + 3] = 255;
    }
  }
  const source = { width: imageSize, height: imageSize, rgba };
  const spectralImages = [];
  for (const layer of distortionLayers) {
    const warped = simulation.warpImageWithDistortion(source, layer.map, rasterExtent);
    const convolved = await simulation.convolveImageSpatiallyVarying(
      warped,
      kernelsByWavelength.get(layer.wavelengthUm.toFixed(9)),
      { tileSize: 32 },
    );
    spectralImages.push({
      image: convolved,
      wavelengthUm: layer.wavelengthUm,
      weight: layer.weight,
      linearRgb: psfPlot.PSFPlotter.wavelengthToLinearRGB(layer.wavelengthUm),
    });
  }
  const simulated = simulation.combineImageSimulationSpectralLayers(spectralImages);
  const differencePercent = simulation.calculateImageSimulationDifferencePercent(source, simulated);
  assert.equal(simulated.width, imageSize, 'simulated output must retain source width');
  assert.equal(simulated.height, imageSize, 'simulated output must retain source height');
  assert.equal(simulated.rgba.length, imageSize * imageSize * 4, 'simulated output buffer length');
  let transparentPixels = 0;
  let nonFinitePixels = 0;
  for (let index = 0; index < simulated.rgba.length; index += 1) {
    if (!Number.isFinite(simulated.rgba[index])) nonFinitePixels += 1;
    if (index % 4 === 3 && simulated.rgba[index] !== 255) transparentPixels += 1;
  }
  assert.equal(nonFinitePixels, 0, 'simulated image contains non-finite samples');
  assert.equal(transparentPixels, 0, 'simulated image must not contain transparent corners');
  assert.ok(differencePercent > 0.01, 'real optical pipeline must change the source image');

  originalLog(JSON.stringify({
    ok: true,
    fixture: 'US3834556 retrofocus 1/3.5',
    backend: [...new Set(distortionLayers.map((layer) => layer.backend))],
    wavelengthsUm: wavelengths.map((entry) => entry.wavelengthUm),
    distortionMaps: distortionLayers.length,
    distortionPointsPerMap: 25,
    fieldGrid: [fieldGridSize, fieldGridSize],
    fieldPoints: fieldPoints.length,
    opdJobs,
    psfJobs,
    samplingSize,
    fftSize,
    output: [simulated.width, simulated.height],
    transparentPixels,
    nonFinitePixels,
    differencePercent,
  }, null, 2));
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}

process.exit(0);
