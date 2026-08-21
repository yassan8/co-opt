import assert from 'node:assert/strict';
import {
  calculateImageSimulationDifferencePercent,
  calculateMaxLateralChromaticDisplacementUm,
  combineImageSimulationSpectralLayers,
  convolveImageSpatiallyVarying,
  createImageSimulationDifference,
  generateImageSimulationTargetSvg,
  getUsaf1951ElementGeometry,
  resamplePsfToImageKernel,
  warpImageWithDistortion,
} from '../src/app/image-simulation-model.ts';
import { calculatePsfImagePixelSizeUm } from '../src/app/psf-scale-model.ts';
import { detectConjugateType } from '../utils/conjugate-detection.ts';
const vectorTargets = ['field-chart', 'usaf-array', 'grid-points'].map((kind) => ({
  kind,
  svg: generateImageSimulationTargetSvg(kind),
}));
for (const { kind, svg } of vectorTargets) {
  assert.match(svg, /^<\?xml[^>]*>\s*<svg\b/, kind + ' target must be a standalone SVG');
  assert.match(svg, /viewBox="0 0 4096 4096"/, kind + ' target must expose a high-detail vector viewBox');
  assert.match(svg, /<path\b/, kind + ' target must contain native vector paths');
  assert.match(svg, /<rect\b/, kind + ' target must contain native vector rectangles');
  assert.doesNotMatch(svg, /<image\b/i, kind + ' target must not embed raster images');
}
assert.ok(vectorTargets.some(({ svg }) => /<circle\b/.test(svg)), 'vector target set must include native vector circles');
assert.equal(new Set(vectorTargets.map(({ svg }) => svg)).size, 3, 'each target kind must produce a distinct SVG');
const usafElements = [1, 2, 3, 4, 5, 6].map((element) => getUsaf1951ElementGeometry(0, element));
assert.ok(Math.abs(usafElements[0].spatialFrequencyLpPerMm - 1) < 1e-12, 'group 0 element 1 must be 1 lp/mm');
assert.ok(Math.abs(usafElements[0].barWidthMm - 0.5) < 1e-12, 'bar width must be half the line-pair pitch');
assert.ok(Math.abs(usafElements[0].spaceWidthMm - usafElements[0].barWidthMm) < 1e-12, 'bar and space widths must match');
assert.ok(Math.abs(usafElements[0].barLengthMm / usafElements[0].barWidthMm - 5) < 1e-12, 'bar length-to-width ratio must be 5:1');
for (let index = 1; index < usafElements.length; index += 1) {
  assert.ok(
    Math.abs(usafElements[index].spatialFrequencyLpPerMm / usafElements[index - 1].spatialFrequencyLpPerMm - Math.pow(2, 1 / 6)) < 1e-12,
    'USAF element frequency must advance by the sixth root of two',
  );
}

const usafSvg = vectorTargets.find(({ kind }) => kind === 'usaf-array').svg;
const usafRowMatches = [...usafSvg.matchAll(/data-usaf-element="(\d)" data-usaf-width-ratio="([^"]+)">[\s\S]*?translate\(-62 ([^ )]+)\)[\s\S]*?data-usaf-bar-length="([^"]+)"/g)]
  .slice(0, 3)
  .map((match) => ({
    element: Number(match[1]),
    widthRatio: Number(match[2]),
    centerY: Number(match[3]),
    length: Number(match[4]),
  }));
assert.equal(usafRowMatches.length, 3, 'each local USAF cluster must expose three elements');
const usafRowGaps = [];
for (let index = 1; index < usafRowMatches.length; index += 1) {
  const previous = usafRowMatches[index - 1];
  const current = usafRowMatches[index];
  const gap = current.centerY - current.length / 2 - (previous.centerY + previous.length / 2);
  usafRowGaps.push(gap);
  assert.ok(gap >= 17.99, 'USAF element rows must not overlap');
}

function makePattern(width = 17, height = 13) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      rgba[offset] = x * 11;
      rgba[offset + 1] = y * 17;
      rgba[offset + 2] = (x + y) * 7;
      rgba[offset + 3] = 255;
    }
  }
  return { width, height, rgba };
}

const idealX = [];
const idealY = [];
for (const y of [-1, 0, 1]) {
  for (const x of [-1, 0, 1]) {
    idealX.push(x);
    idealY.push(y);
  }
}
const source = makePattern();
const identityMap = {
  gridSize: 3,
  idealX,
  idealY,
  realX: [...idealX],
  realY: [...idealY],
};
const identityWarp = warpImageWithDistortion(source, identityMap);
assert.deepEqual([...identityWarp.rgba], [...source.rgba], 'identity distortion must preserve every pixel');

const barrelMap = {
  ...identityMap,
  realX: idealX.map((x, index) => x * (0.82 + 0.06 * Math.abs(idealY[index]))),
  realY: idealY.map((y, index) => y * (0.82 + 0.06 * Math.abs(idealX[index]))),
};
const barrelWarp = warpImageWithDistortion(source, barrelMap);
assert.ok(calculateImageSimulationDifferencePercent(source, barrelWarp) > 1, 'barrel map must visibly change the image');

const deltaPsf = Array.from({ length: 7 }, () => new Array(7).fill(0));
deltaPsf[3][3] = 1;
const identityKernel = resamplePsfToImageKernel(deltaPsf, 1, 1, 1, 15);
assert.equal(identityKernel.sparse.length, 1, 'delta PSF must remain a one-tap kernel');
assert.ok(Math.abs(identityKernel.sparse[0].weight - 1) < 1e-12);
assert.deepEqual(
  { dx: identityKernel.sparse[0].dx, dy: identityKernel.sparse[0].dy },
  { dx: 0, dy: 0 },
  'odd-grid PSF origin must stay on the image pixel origin',
);

for (const fftSize of [32, 64]) {
  const evenDeltaPsf = Array.from({ length: fftSize }, () => new Array(fftSize).fill(0));
  evenDeltaPsf[fftSize / 2][fftSize / 2] = 1;
  const evenIdentityKernel = resamplePsfToImageKernel(evenDeltaPsf, 1, 1, 1, 15);
  assert.equal(evenIdentityKernel.sparse.length, 1, fftSize + '-point centered PSF must not become a 2x2 blur');
  assert.deepEqual(
    { dx: evenIdentityKernel.sparse[0].dx, dy: evenIdentityKernel.sparse[0].dy },
    { dx: 0, dy: 0 },
    fftSize + '-point fftshift origin must remain centered',
  );
}

const oversampledDeltaPsf = Array.from({ length: 32 }, () => new Array(32).fill(0));
oversampledDeltaPsf[16][16] = 1;
const oversampledIdentityKernel = resamplePsfToImageKernel(oversampledDeltaPsf, 0.25, 1, 1, 15);
assert.equal(oversampledIdentityKernel.sparse.length, 1, 'a PSF cell contained by one image pixel must not leak to neighbors');

const directionalPsf = Array.from({ length: 32 }, () => new Array(32).fill(0));
directionalPsf[16][18] = 1;
const rotatedDirectionalKernel = resamplePsfToImageKernel(directionalPsf, 1, 1, 1, 15, 90);
assert.equal(rotatedDirectionalKernel.sparse.length, 1, '90-degree PSF rotation must not add interpolation blur');
assert.deepEqual(
  { dx: rotatedDirectionalKernel.sparse[0].dx, dy: rotatedDirectionalKernel.sparse[0].dy },
  { dx: 0, dy: -2 },
  'positive local X must rotate toward Cartesian positive Y',
);

assert.equal(detectConjugateType([{ thickness: 'INF' }]), 'infinite');
assert.equal(detectConjugateType([{ thickness: -Infinity }]), 'infinite');
assert.equal(detectConjugateType([{ Thickness: '∞' }]), 'infinite');
assert.equal(detectConjugateType([{ distance: 1e7 }]), 'infinite');
assert.equal(detectConjugateType([{ thickness: 200 }]), 'finite');
assert.ok(
  Math.abs(calculatePsfImagePixelSizeUm(0.55, 4, 32, 64) - 1.1) < 1e-12,
  'PSF image pitch must be wavelength times working F-number times FFT sampling ratio',
);

const gaussianPsf = Array.from({ length: 9 }, (_, y) => Array.from({ length: 9 }, (_, x) => {
  const dx = x - 4;
  const dy = y - 4;
  return Math.exp(-(dx * dx + dy * dy) / 4);
}));
const blurKernel = resamplePsfToImageKernel(gaussianPsf, 1, 1, 1, 15);
const kernelEnergy = blurKernel.data.reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(kernelEnergy - 1) < 1e-5, 'resampled PSF must conserve energy');
assert.ok(blurKernel.sparse.length > 9, 'Gaussian PSF must produce a nontrivial convolution kernel');

const identityConvolution = await convolveImageSpatiallyVarying(source, [
  { xNorm: 0, yNorm: 0, kernel: identityKernel },
]);
let maxIdentityError = 0;
for (let index = 0; index < source.rgba.length; index += 1) {
  maxIdentityError = Math.max(maxIdentityError, Math.abs(source.rgba[index] - identityConvolution.rgba[index]));
}
assert.ok(maxIdentityError <= 1, 'identity PSF must preserve the image within sRGB roundoff');

const impulse = {
  width: 21,
  height: 21,
  rgba: new Uint8ClampedArray(21 * 21 * 4),
};
for (let index = 0; index < 21 * 21; index += 1) impulse.rgba[index * 4 + 3] = 255;
const centerOffset = (10 * 21 + 10) * 4;
impulse.rgba[centerOffset] = 255;
impulse.rgba[centerOffset + 1] = 255;
impulse.rgba[centerOffset + 2] = 255;

const directionalData = new Float32Array(25);
directionalData[2 * 5 + 3] = 1;
const directional = await convolveImageSpatiallyVarying(impulse, [
  {
    xNorm: 0,
    yNorm: 0,
    kernel: {
      size: 5,
      data: directionalData,
      sparse: [{ dx: 1, dy: 0, weight: 1 }],
    },
  },
]);
assert.equal(directional.rgba[(10 * 21 + 11) * 4], 255, 'positive-X PSF lobe must appear to the right');
assert.equal(directional.rgba[(10 * 21 + 9) * 4], 0, 'positive-X PSF lobe must not be mirrored');
const blurred = await convolveImageSpatiallyVarying(impulse, [
  { xNorm: -1, yNorm: 1, kernel: blurKernel },
  { xNorm: 1, yNorm: 1, kernel: blurKernel },
  { xNorm: -1, yNorm: -1, kernel: blurKernel },
  { xNorm: 1, yNorm: -1, kernel: blurKernel },
]);
assert.ok(blurred.rgba[centerOffset] < 255, 'blur must reduce the impulse peak');
assert.ok(blurred.rgba[centerOffset + 4] > 0, 'blur must spread energy to neighboring pixels');

const shiftedChromaticMap = {
  ...identityMap,
  realX: idealX.map((x) => x + 0.012),
  realY: [...idealY],
};
const lateralChromaticUm = calculateMaxLateralChromaticDisplacementUm([identityMap, shiftedChromaticMap]);
assert.ok(Math.abs(lateralChromaticUm - 12) < 1e-9, 'wavelength map separation must be reported in micrometres');

const identicalSpectral = combineImageSimulationSpectralLayers([
  { image: source, wavelengthUm: 0.486, weight: 0.4, linearRgb: [0.1, 0.3, 1] },
  { image: source, wavelengthUm: 0.656, weight: 0.6, linearRgb: [1, 0.2, 0.01] },
]);
let maxSpectralIdentityError = 0;
for (let index = 0; index < source.rgba.length; index += 1) {
  maxSpectralIdentityError = Math.max(maxSpectralIdentityError, Math.abs(source.rgba[index] - identicalSpectral.rgba[index]));
}
assert.ok(maxSpectralIdentityError <= 1, 'identical wavelength layers must preserve the source image');

const redShift = { width: 5, height: 1, rgba: new Uint8ClampedArray(20) };
const blueShift = { width: 5, height: 1, rgba: new Uint8ClampedArray(20) };
for (let x = 0; x < 5; x += 1) {
  redShift.rgba[x * 4 + 3] = 255;
  blueShift.rgba[x * 4 + 3] = 255;
}
redShift.rgba[4] = redShift.rgba[5] = redShift.rgba[6] = 255;
blueShift.rgba[12] = blueShift.rgba[13] = blueShift.rgba[14] = 255;
const chromaticFringe = combineImageSimulationSpectralLayers([
  { image: redShift, wavelengthUm: 0.656, weight: 1, linearRgb: [1, 0, 0] },
  { image: blueShift, wavelengthUm: 0.486, weight: 1, linearRgb: [0, 0, 1] },
]);
assert.equal(chromaticFringe.rgba[4], 255, 'red wavelength displacement must remain in the red channel');
assert.equal(chromaticFringe.rgba[14], 255, 'blue wavelength displacement must remain in the blue channel');
assert.equal(chromaticFringe.rgba[12], 0, 'red channel must not inherit the blue wavelength position');
assert.equal(chromaticFringe.rgba[6], 0, 'blue channel must not inherit the red wavelength position');

const difference = createImageSimulationDifference(source, barrelWarp, 3);
assert.equal(difference.width, source.width);
assert.equal(difference.height, source.height);
assert.ok(difference.rgba.some((value, index) => index % 4 !== 3 && value > 0), 'difference view must contain changed pixels');

console.log(JSON.stringify({
  ok: true,
  identityWarp: true,
  identityConvolutionMaxError: maxIdentityError,
  kernelEnergy,
  blurKernelTaps: blurKernel.sparse.length,
  barrelDifferencePercent: calculateImageSimulationDifferencePercent(source, barrelWarp),
  linearLightConvolution: true,
  directionalPsfOrientation: '+X preserved',
  wavelengthSpecificDistortion: true,
  lateralChromaticUm,
  maxSpectralIdentityError,
  vectorTargets: vectorTargets.map(({ kind, svg }) => ({ kind, bytes: Buffer.byteLength(svg) })),
  embeddedRasterImages: false,
  usaf1951Geometry: {
    elements: 6,
    lineToSpaceRatio: '1:1',
    barAspectRatio: '5:1',
    frequencyStep: '2^(1/6)',
    normalizedScale: true,
    minimumRowGapSvgUnits: Math.min(...usafRowGaps),
  },
}, null, 2));
