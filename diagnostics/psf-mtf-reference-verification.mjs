import assert from 'node:assert/strict';

globalThis.self = new EventTarget();
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };

const { PSFCalculator, SimpleFFT } = await import('../evaluation/psf/psf-calculator.ts');

const pupilSize = 64;
const fftSize = 256;
const wavelengthUm = 0.55;
const pupilDiameterMm = 25;
const focalLengthMm = 100;
const center = (pupilSize - 1) / 2;
const radius = (pupilSize - 1) / 2;
const opd = Array.from({ length: pupilSize }, () => new Float64Array(pupilSize));
const amplitude = Array.from({ length: pupilSize }, () => new Float64Array(pupilSize));
const pupilMask = Array.from({ length: pupilSize }, () => new Array(pupilSize).fill(false));
for (let y = 0; y < pupilSize; y += 1) {
  for (let x = 0; x < pupilSize; x += 1) {
    const inside = Math.hypot(x - center, y - center) <= radius;
    pupilMask[y][x] = inside;
    amplitude[y][x] = inside ? 1 : 0;
  }
}

const calculator = new PSFCalculator();
const originalLog = console.log;
const originalWarn = console.warn;
console.log = () => {};
console.warn = () => {};
let result;
try {
  result = await calculator.calculatePSF({ gridData: { opd, amplitude, pupilMask } }, {
    samplingSize: pupilSize,
    zeroPadTo: fftSize,
    wavelength: wavelengthUm,
    pupilDiameter: pupilDiameterMm,
    focalLength: focalLengthMm,
    forceImplementation: 'javascript',
    forceWasmFFT: false,
    removeTilt: false,
  });
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
}

const psf = result?.psfData;
assert.equal(psf?.length, fftSize, 'PSF FFT size is incorrect');
assert.ok(psf.every((row) => Array.isArray(row) && row.length === fftSize), 'PSF is not square');
let peak = { x: -1, y: -1, value: -Infinity };
let energy = 0;
let finiteCount = 0;
for (let y = 0; y < fftSize; y += 1) {
  for (let x = 0; x < fftSize; x += 1) {
    const value = Number(psf[y][x]);
    assert.ok(Number.isFinite(value) && value >= 0, `PSF contains an invalid intensity at ${x},${y}`);
    finiteCount += 1;
    energy += value;
    if (value > peak.value) peak = { x, y, value };
  }
}
assert.deepEqual({ x: peak.x, y: peak.y }, { x: fftSize / 2, y: fftSize / 2 }, 'unaberrated PSF peak is not centered');
assert.ok(Math.abs(peak.value - 1) < 1e-12, 'PSF peak normalization is not one');
assert.ok(energy > 0, 'PSF has no energy');
assert.ok(Math.abs(Number(result?.metrics?.strehlRatio) - 1) < 1e-8, 'unaberrated Strehl ratio is not one');

let maxSymmetryError = 0;
const psfCenter = fftSize / 2;
for (let y = 0; y < fftSize; y += 1) {
  for (let x = 0; x < fftSize; x += 1) {
    const mirrorX = (2 * psfCenter - x + fftSize) % fftSize;
    const mirrorY = (2 * psfCenter - y + fftSize) % fftSize;
    maxSymmetryError = Math.max(maxSymmetryError, Math.abs(psf[y][x] - psf[mirrorY][mirrorX]));
  }
}
assert.ok(maxSymmetryError < 1e-10, `unaberrated circular PSF symmetry error is ${maxSymmetryError}`);

const otfReal = psf.map((row) => row.map(Number));
const otfImag = Array.from({ length: fftSize }, () => new Array(fftSize).fill(0));
const otf = SimpleFFT.fft2D(otfReal, otfImag);
const dc = Math.hypot(otf.real[0][0], otf.imag[0][0]);
assert.ok(dc > 0, 'OTF DC normalization is zero');

const overlapMtf = (shiftX) => {
  let numerator = 0;
  let denominator = 0;
  for (let y = 0; y < pupilSize; y += 1) {
    for (let x = 0; x < pupilSize; x += 1) {
      if (!pupilMask[y][x]) continue;
      denominator += 1;
      const shiftedX = x + shiftX;
      if (shiftedX >= 0 && shiftedX < pupilSize && pupilMask[y][shiftedX]) numerator += 1;
    }
  }
  return numerator / denominator;
};
const analyticCircularMtf = (normalizedFrequency) => {
  if (normalizedFrequency >= 1) return 0;
  const nu = Math.max(0, normalizedFrequency);
  return (2 / Math.PI) * (Math.acos(nu) - nu * Math.sqrt(1 - nu * nu));
};

const samples = [0, 8, 16, 32, 48, 63].map((bin) => {
  const actual = Math.hypot(otf.real[0][bin], otf.imag[0][bin]) / dc;
  const discreteReference = overlapMtf(bin);
  const analyticReference = analyticCircularMtf(bin / (2 * radius));
  const discreteDelta = Math.abs(actual - discreteReference);
  const analyticDelta = Math.abs(actual - analyticReference);
  assert.ok(discreteDelta < 1e-10, `MTF bin ${bin} violates the pupil autocorrelation theorem by ${discreteDelta}`);
  assert.ok(analyticDelta < 0.025, `MTF bin ${bin} differs from the circular-aperture analytic curve by ${analyticDelta}`);
  return { bin, actual, discreteReference, analyticReference, discreteDelta, analyticDelta };
});
assert.ok(samples.every((sample, index) => index === 0 || sample.actual <= samples[index - 1].actual + 1e-12), 'diffraction-limited MTF is not monotonic');

originalLog(JSON.stringify({
  ok: true,
  pupilSize,
  fftSize,
  wavelengthUm,
  fNumber: focalLengthMm / pupilDiameterMm,
  pixelSizeUm: result.options.pixelSize,
  finiteCount,
  peak,
  energy,
  strehlRatio: result.metrics.strehlRatio,
  maxSymmetryError,
  mtfSamples: samples,
}, null, 2));
process.exit(0);
