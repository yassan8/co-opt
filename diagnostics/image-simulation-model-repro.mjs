import assert from 'node:assert/strict';
import {
  calculateImageSimulationDifferencePercent,
  calculateMaxLateralChromaticDisplacementUm,
  combineImageSimulationSpectralLayers,
  convolveImageSpatiallyVarying,
  createImageSimulationDifference,
  generateImageSimulationTargetSvg,
  getImageSimulationPhysicalExtent,
  getImageSimulationTargetNominalMaxFrequencyLpmm,
  getUsaf1951ElementGeometry,
  resamplePsfToImageKernel,
  resolveImageSimulationRasterExtent,
  warpImageWithDistortion,
} from '../src/app/image-simulation-model.ts';
import {
  CALIBRATED_CAMERA_TARGET_SPEC,
  getCalibratedCameraTargetNominalMaxFrequencyLpmm,
} from '../src/app/calibrated-camera-resolution-target.ts';
import {
  OPTICAL_SHOWCASE_TARGET_SPEC,
} from '../src/app/optical-showcase-target.ts';
import { calculatePsfImagePixelSizeUm } from '../src/app/psf-scale-model.ts';
import { detectConjugateType } from '../utils/conjugate-detection.ts';
const vectorTargets = ['optical-showcase', 'field-chart', 'usaf-array', 'grid-points'].map((kind) => ({
  kind,
  svg: generateImageSimulationTargetSvg(kind),
}));
for (const { kind, svg } of vectorTargets) {
  assert.match(svg, /^<\?xml[^>]*>\s*<svg\b/, kind + ' target must be a standalone SVG');
  assert.match(svg, /<path\b/, kind + ' target must contain native vector paths');
  assert.match(svg, /<rect\b/, kind + ' target must contain native vector rectangles');
  assert.doesNotMatch(svg, /<image\b/i, kind + ' target must not embed raster images');
  if (kind === 'field-chart') {
    assert.match(svg, /width="240mm" height="240mm" viewBox="0 0 240 240"/,
      'calibrated chart must use a millimetre coordinate system');
    assert.match(svg, /data-coordinate-unit="mm"/);
    assert.match(svg, /data-nominal-width-mm="240" data-nominal-height-mm="240"/);
    assert.equal((svg.match(/data-target="esfr-slanted-square"/g) || []).length, 20,
      'calibrated chart must sample twenty non-central field positions with eSFR squares');
    assert.equal((svg.match(/data-target="usaf-1951"/g) || []).length, 4,
      'calibrated chart must include four equation-sized USAF groups');
    assert.match(svg, /data-target="binary-siemens-star"/);
    assert.match(svg, /data-cycles-per-revolution="72"/);
    assert.ok(Math.abs(CALIBRATED_CAMERA_TARGET_SPEC.edgeLinearContrast - 4) < 1e-4,
      'decoded 8-bit sRGB edge contrast must be calibrated to 4:1');
    assert.deepEqual([...CALIBRATED_CAMERA_TARGET_SPEC.edgeAnglesDeg], [-7, -5, 5, 7]);
    const positions = [...CALIBRATED_CAMERA_TARGET_SPEC.fieldPositionsMm];
    const minimumPitch = Math.min(...positions.slice(1).map((value, index) => value - positions[index]));
    assert.ok(minimumPitch > CALIBRATED_CAMERA_TARGET_SPEC.edgePatchSizeMm,
      'adjacent eSFR patches must have positive clearance');
    assert.ok(
      minimumPitch > CALIBRATED_CAMERA_TARGET_SPEC.siemensRadiusMm + CALIBRATED_CAMERA_TARGET_SPEC.usafPlateWidthMm / 2,
      'central Siemens star and axial USAF plates must have positive clearance',
    );
    assert.ok(positions[0] - CALIBRATED_CAMERA_TARGET_SPEC.edgePatchSizeMm / 2 > CALIBRATED_CAMERA_TARGET_SPEC.marginMm,
      'first field target must clear the calibrated frame');
    assert.ok(positions.at(-1) + CALIBRATED_CAMERA_TARGET_SPEC.edgePatchSizeMm / 2
      < CALIBRATED_CAMERA_TARGET_SPEC.heightMm - CALIBRATED_CAMERA_TARGET_SPEC.marginMm,
    'last field target must clear the calibrated frame');
    const calibratedUsaf = [...svg.matchAll(/data-usaf-group="(-?\d+)" data-usaf-element="(\d)" data-frequency-lp-mm="([^"]+)">[\s\S]*?data-bar-width-mm="([^"]+)"/g)];
    assert.equal(calibratedUsaf.length, 24, 'four USAF groups must expose all six calibrated elements');
    calibratedUsaf.forEach((match) => {
      const group = Number(match[1]);
      const element = Number(match[2]);
      const frequency = Number(match[3]);
      const barWidth = Number(match[4]);
      const expectedFrequency = Math.pow(2, group + (element - 1) / 6);
      assert.ok(Math.abs(frequency - expectedFrequency) < 1e-8,
        'embedded USAF frequency must match 2^(group+(element-1)/6)');
      assert.ok(Math.abs(barWidth - 1 / (2 * expectedFrequency)) < 1e-8,
        'embedded USAF bar width must match 1/(2f) mm');
    });
    const embeddedMax = Number(svg.match(/data-nominal-max-frequency-lp-mm="([^"]+)"/)?.[1]);
    assert.ok(Math.abs(embeddedMax - getCalibratedCameraTargetNominalMaxFrequencyLpmm()) < 1e-8,
      'embedded maximum frequency must match the analytic chart specification');
  } else if (kind === 'optical-showcase') {
    assert.match(svg, /width="240mm" height="240mm" viewBox="0 0 240 240"/,
      'USAF radial grid must remain a square millimetre-coordinate native SVG');
    assert.match(svg, /data-scene="optical-showcase"/);
    assert.match(svg, /data-scene-name="USAF 1951 Radial Grid 01"/);
    assert.match(svg, /data-usaf-frequency-formula="2\^\(group\+\(element-1\)\/6\)"/);
    assert.match(svg, /data-usaf-bar-aspect-ratio="5:1"/);
    assert.match(svg, /data-usaf-line-to-space-ratio="1:1"/);
    assert.doesNotMatch(svg, /<filter\b/i, 'USAF source must not contain pre-rendered optical blur');
    assert.doesNotMatch(svg, /scale\s*\(/i, 'USAF element dimensions must not be altered by SVG scale transforms');
    assert.match(svg, /data-diagnostic="field-grid"/);
    assert.match(svg, /data-diagnostic="radial-grid"/);
    assert.match(svg, /data-diagnostic="registration"/);
    assert.match(svg, /data-diagnostic="corner-radial-charts"/);
    assert.match(svg, /data-diagnostic="color-grayscale-bars"/);
    assert.equal((svg.match(/data-placement="center"/g) || []).length, 1);
    assert.equal((svg.match(/data-placement="radial"/g) || []).length, OPTICAL_SHOWCASE_TARGET_SPEC.radialTargetCount);
    assert.equal((svg.match(/data-placement="grid"/g) || []).length, OPTICAL_SHOWCASE_TARGET_SPEC.gridTargetCount);
    const radialPlacements = [...svg.matchAll(/data-placement="radial" data-placement-index="(\d+)"[^>]*data-rotation-deg="([^"]+)"/g)];
    assert.equal(radialPlacements.length, OPTICAL_SHOWCASE_TARGET_SPEC.radialTargetCount);
    radialPlacements.forEach((match) => {
      const index = Number(match[1]);
      const rotationDeg = Number(match[2]);
      assert.ok(Math.abs(rotationDeg - index * 360 / OPTICAL_SHOWCASE_TARGET_SPEC.radialTargetCount) < 1e-9,
        'radial USAF pair long axes must point away from the chart center');
    });
    const plateCount = 1 + OPTICAL_SHOWCASE_TARGET_SPEC.radialTargetCount + OPTICAL_SHOWCASE_TARGET_SPEC.gridTargetCount;
    assert.equal((svg.match(/data-layout="classic-spiral-pair"/g) || []).length, plateCount);
    assert.equal((svg.match(/data-diagnostic="opaque-reference-square"/g) || []).length, plateCount);
    const pairDimensions = [...svg.matchAll(/data-layout="classic-spiral-pair"[^>]*data-inner-width-mm="([^"]+)" data-inner-height-mm="([^"]+)"/g)];
    assert.equal(pairDimensions.length, plateCount);
    pairDimensions.forEach((match) => {
      const aspectRatio = Number(match[1]) / Number(match[2]);
      assert.ok(Math.abs(aspectRatio - 1) < 1e-9,
        'classic USAF group pair must be square rather than a vertical strip');
    });
    const alignedElementBottoms = [...svg.matchAll(/data-layout="classic-spiral-pair"[^>]*data-primary-element-one-bottom-mm="([^"]+)" data-primary-element-six-bottom-mm="([^"]+)"/g)];
    assert.equal(alignedElementBottoms.length, plateCount);
    alignedElementBottoms.forEach((match) => assert.ok(Math.abs(Number(match[1]) - Number(match[2])) < 1e-9,
      'primary Element 1 and Element 6 bottoms must align exactly'));
    const layoutScaleByInstance = new Map(
      [...svg.matchAll(/data-target="usaf-1951-group" data-instance="([^"]+)" data-usaf-group="-?\d+" data-reference-bar-width-mm="[^"]+" data-pair-reference-bar-width-mm="([^"]+)"/g)]
        .map((match) => [match[1], Number(match[2])]),
    );
    const alignedHorizontalElements = [...svg.matchAll(/data-target="usaf-1951-element" data-instance="([^"]+)" data-usaf-group="-?\d+" data-usaf-element="(\d)" data-frequency-lp-mm="[^"]+" data-bar-width-mm="[^"]+" data-space-width-mm="[^"]+" data-bar-length-mm="([^"]+)" data-first-center-x-mm="([^"]+)" data-second-center-x-mm="([^"]+)" data-center-y-mm="[^"]+" data-first-orientation="(horizontal|vertical)" data-second-orientation="(horizontal|vertical)"/g)];
    assert.equal(alignedHorizontalElements.length, plateCount * 2 * 6);
    alignedHorizontalElements.forEach((match) => {
      const instance = match[1];
      const element = Number(match[2]);
      const barLength = Number(match[3]);
      const firstCenterX = Number(match[4]);
      const secondCenterX = Number(match[5]);
      const firstOrientation = match[6];
      const secondOrientation = match[7];
      const pairUnit = layoutScaleByInstance.get(instance);
      assert.ok(Number.isFinite(pairUnit));
      if (instance.endsWith('-a') && element >= 2) {
        assert.equal(firstOrientation, 'horizontal');
        assert.ok(Math.abs(firstCenterX - barLength / 2 - 3 * pairUnit) < 1e-8,
          'primary Elements 2-6 horizontal bars must share the imaginary square left edge');
      } else {
        assert.equal(secondOrientation, 'horizontal');
        assert.ok(Math.abs(secondCenterX + barLength / 2 - 27 * pairUnit) < 1e-8,
          'secondary Elements and primary Element 1 horizontal bars must share the imaginary square right edge');
      }
    });
    assert.equal((svg.match(/data-target="binary-radial-chart"/g) || []).length,
      OPTICAL_SHOWCASE_TARGET_SPEC.cornerRadialChartCount);
    assert.equal((svg.match(/data-cycles-per-revolution="36"/g) || []).length,
      OPTICAL_SHOWCASE_TARGET_SPEC.cornerRadialChartCount);
    assert.equal((svg.match(/data-target="srgb-color-bar"/g) || []).length, 1);
    assert.equal((svg.match(/data-bar-role="color"/g) || []).length, OPTICAL_SHOWCASE_TARGET_SPEC.colorBarPatchCount);
    assert.equal((svg.match(/data-target="srgb-grayscale-bar"/g) || []).length, 1);
    assert.equal((svg.match(/data-bar-role="grayscale"/g) || []).length, OPTICAL_SHOWCASE_TARGET_SPEC.grayscaleBarPatchCount);
    const groupCount = plateCount * 2;
    assert.equal((svg.match(/data-target="usaf-1951-group"/g) || []).length, groupCount);
    assert.equal((svg.match(/data-target="usaf-1951-element"/g) || []).length, groupCount * 6);
    assert.equal((svg.match(/data-usaf-bar="true"/g) || []).length, groupCount * 6 * 6);
    const elementMatches = [...svg.matchAll(/data-target="usaf-1951-element" data-instance="([^"]+)" data-usaf-group="(-?\d+)" data-usaf-element="(\d)" data-frequency-lp-mm="([^"]+)" data-bar-width-mm="([^"]+)" data-space-width-mm="([^"]+)" data-bar-length-mm="([^"]+)"/g)];
    assert.equal(elementMatches.length, groupCount * 6);
    elementMatches.forEach((match) => {
      const group = Number(match[2]);
      const element = Number(match[3]);
      const frequency = Number(match[4]);
      const barWidth = Number(match[5]);
      const spaceWidth = Number(match[6]);
      const barLength = Number(match[7]);
      const expectedFrequency = Math.pow(2, group + (element - 1) / 6);
      assert.ok(Math.abs(frequency - expectedFrequency) < 1e-8);
      assert.ok(Math.abs(barWidth - 1 / (2 * expectedFrequency)) < 1e-8);
      assert.ok(Math.abs(spaceWidth - barWidth) < 1e-9);
      assert.ok(Math.abs(barLength - 5 * barWidth) < 1e-8);
    });
    const instanceNumberScales = new Map(
      [...svg.matchAll(/data-target="usaf-1951-group" data-instance="([^"]+)" data-usaf-group="-?\d+" data-reference-bar-width-mm="[^"]+" data-pair-reference-bar-width-mm="([^"]+)" data-number-scale-role="(primary|secondary)"/g)]
        .map((match) => [match[1], { pairReferenceBarWidth: Number(match[2]), role: match[3] }]),
    );
    const groupNumbers = [...svg.matchAll(/data-target="usaf-1951-group" data-instance="([^"]+)"[^>]*>[\s\S]*?<text data-number-role="group" data-number-size-mm="([^"]+)"/g)];
    assert.equal(groupNumbers.length, groupCount);
    groupNumbers.forEach((match) => assert.ok(Math.abs(
      Number(match[2]) / instanceNumberScales.get(match[1]).pairReferenceBarWidth
        - OPTICAL_SHOWCASE_TARGET_SPEC.groupNumberToPairReferenceBarRatio,
    ) < 1e-8));
    const elementNumbers = [...svg.matchAll(/data-target="usaf-1951-element" data-instance="([^"]+)"[^>]*>[\s\S]*?<text data-number-role="element" data-number-size-mm="([^"]+)"/g)];
    assert.equal(elementNumbers.length, groupCount * 6);
    elementNumbers.forEach((match) => {
      const numberScale = instanceNumberScales.get(match[1]);
      const expectedRatio = numberScale.role === 'primary'
        ? OPTICAL_SHOWCASE_TARGET_SPEC.primaryElementNumberToPairReferenceBarRatio
        : OPTICAL_SHOWCASE_TARGET_SPEC.secondaryElementNumberToPairReferenceBarRatio;
      assert.ok(Math.abs(Number(match[2]) / numberScale.pairReferenceBarWidth - expectedRatio) < 1e-8);
    });
  } else {
    assert.match(svg, /viewBox="0 0 4096 4096"/, kind + ' target must expose a high-detail vector viewBox');
    assert.match(svg, /<rect x="16" y="16" width="4064" height="4064" fill="url\(#minor-grid\)"\/>/,
      kind + ' target must keep the sampling edge clear of the minor grid');
    assert.match(svg, /<rect x="16" y="16" width="4064" height="4064" fill="url\(#major-grid\)"\/>/,
      kind + ' target must keep the sampling edge clear of the major grid');
  }
}
assert.ok(vectorTargets.some(({ svg }) => /<circle\b/.test(svg)), 'vector target set must include native vector circles');
assert.equal(new Set(vectorTargets.map(({ svg }) => svg)).size, 4, 'each target kind must produce a distinct SVG');
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
const missingCornerIndices = new Set([0, 2, 6, 8]);
const missingCornerMap = {
  ...identityMap,
  realX: identityMap.realX.map((value, index) => (missingCornerIndices.has(index) ? null : value)),
  realY: identityMap.realY.map((value, index) => (missingCornerIndices.has(index) ? null : value)),
};
const missingCornerWarp = warpImageWithDistortion(source, missingCornerMap);
assert.deepEqual([...missingCornerWarp.rgba], [...source.rgba],
  'null corner rays must be interpolated instead of being treated as image-center hits');

const barrelMap = {
  ...identityMap,
  realX: idealX.map((x, index) => x * (0.82 + 0.06 * Math.abs(idealY[index]))),
  realY: idealY.map((y, index) => y * (0.82 + 0.06 * Math.abs(idealX[index]))),
};
const barrelWarp = warpImageWithDistortion(source, barrelMap);
assert.ok(calculateImageSimulationDifferencePercent(source, barrelWarp) > 1, 'barrel map must visibly change the image');
const uniformSource = { ...source, rgba: new Uint8ClampedArray(source.rgba.length).fill(255) };
const uniformBarrelWarp = warpImageWithDistortion(uniformSource, barrelMap);
assert.ok([...uniformBarrelWarp.rgba].every((value) => value === 255),
  'distortion outside a finite source chart must extend edge pixels instead of adding dark corners');

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

const fieldExtent = getImageSimulationPhysicalExtent(identityMap);
const fieldFitExtent = resolveImageSimulationRasterExtent(fieldExtent, 'field-fit', source.width, source.height, 1, 1, 1);
assert.deepEqual(fieldFitExtent, fieldExtent, 'Field fit must preserve the traced image extent');
const sensorExtent = resolveImageSimulationRasterExtent(fieldExtent, 'sensor-width', source.width, source.height, 0.5, 0.25, 1);
assert.ok(Math.abs(sensorExtent.widthMm - 0.5) < 1e-12, 'sensor-width mode must use the requested width');
assert.ok(Math.abs(sensorExtent.heightMm - 0.25) < 1e-12, 'sensor-width mode must use the requested height independently');
assert.ok(Math.abs(sensorExtent.minXmm + sensorExtent.maxXmm) < 1e-12, 'sensor crop must remain centered in X');
assert.ok(Math.abs(sensorExtent.minYmm + sensorExtent.maxYmm) < 1e-12, 'sensor crop must remain centered in Y');
const pitchExtent = resolveImageSimulationRasterExtent(fieldExtent, 'pixel-pitch', source.width, source.height, 1, 1, 2);
assert.ok(Math.abs(pitchExtent.widthMm - source.width * 2 / 1000) < 1e-12, 'pixel-pitch mode must derive sensor width from raster pixels');
assert.ok(Math.abs(pitchExtent.heightMm - source.height * 2 / 1000) < 1e-12, 'pixel-pitch mode must derive sensor height from raster pixels');
const sensorIdentityWarp = warpImageWithDistortion(source, identityMap, sensorExtent);
assert.deepEqual([...sensorIdentityWarp.rgba], [...source.rgba], 'identity distortion must preserve a centered sensor crop');
const fieldChartFrequency = getImageSimulationTargetNominalMaxFrequencyLpmm('field-chart', fieldExtent.widthMm, fieldExtent.heightMm);
const usafArrayFrequency = getImageSimulationTargetNominalMaxFrequencyLpmm('usaf-array', fieldExtent.widthMm);
assert.ok(Number.isFinite(fieldChartFrequency) && fieldChartFrequency > 0, 'calibrated chart must report its analytic maximum frequency');
assert.ok(Number.isFinite(usafArrayFrequency) && fieldChartFrequency > usafArrayFrequency,
  'calibrated chart must report its analytic Siemens/USAF maximum');
const anisotropicChartFrequency = getImageSimulationTargetNominalMaxFrequencyLpmm('field-chart', fieldExtent.widthMm, fieldExtent.heightMm / 2);
assert.ok(Math.abs(anisotropicChartFrequency / fieldChartFrequency - 2) < 1e-12,
  'calibrated chart frequency must include independent X/Y physical scaling');
assert.equal(getImageSimulationTargetNominalMaxFrequencyLpmm('grid-points', fieldExtent.widthMm), null);
assert.equal(getImageSimulationTargetNominalMaxFrequencyLpmm('upload', fieldExtent.widthMm), null);
const radialGridFrequency = getImageSimulationTargetNominalMaxFrequencyLpmm('optical-showcase', fieldExtent.widthMm, fieldExtent.heightMm);
assert.ok(Number.isFinite(radialGridFrequency) && radialGridFrequency > 0,
  'USAF radial grid must report its Group 1 Element 6 maximum frequency');
const anisotropicRadialGridFrequency = getImageSimulationTargetNominalMaxFrequencyLpmm('optical-showcase', fieldExtent.widthMm, fieldExtent.heightMm / 2);
assert.ok(Math.abs(anisotropicRadialGridFrequency / radialGridFrequency - 2) < 1e-12,
  'USAF radial grid frequency must include independent X/Y physical scaling');

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
  calibratedCameraTarget: {
    coordinateModelMm: [CALIBRATED_CAMERA_TARGET_SPEC.widthMm, CALIBRATED_CAMERA_TARGET_SPEC.heightMm],
    edgeAnglesDeg: CALIBRATED_CAMERA_TARGET_SPEC.edgeAnglesDeg,
    decodedLinearContrast: CALIBRATED_CAMERA_TARGET_SPEC.edgeLinearContrast,
    nominalMaxFrequencyLpmm: getCalibratedCameraTargetNominalMaxFrequencyLpmm(),
  },
  opticalShowcase: {
    scene: OPTICAL_SHOWCASE_TARGET_SPEC.sceneName,
    coordinateModelMm: [OPTICAL_SHOWCASE_TARGET_SPEC.widthMm, OPTICAL_SHOWCASE_TARGET_SPEC.heightMm],
    centralGroups: OPTICAL_SHOWCASE_TARGET_SPEC.centralGroups,
    fieldGroups: OPTICAL_SHOWCASE_TARGET_SPEC.fieldGroups,
    radialTargetCount: OPTICAL_SHOWCASE_TARGET_SPEC.radialTargetCount,
    gridTargetCount: OPTICAL_SHOWCASE_TARGET_SPEC.gridTargetCount,
    groupNumberRatio: OPTICAL_SHOWCASE_TARGET_SPEC.groupNumberToPairReferenceBarRatio,
    primaryElementNumberRatio: OPTICAL_SHOWCASE_TARGET_SPEC.primaryElementNumberToPairReferenceBarRatio,
    secondaryElementNumberRatio: OPTICAL_SHOWCASE_TARGET_SPEC.secondaryElementNumberToPairReferenceBarRatio,
    pairInnerAspectRatio: OPTICAL_SHOWCASE_TARGET_SPEC.pairInnerWidthUnits / OPTICAL_SHOWCASE_TARGET_SPEC.pairInnerHeightUnits,
    cornerRadialChartCount: OPTICAL_SHOWCASE_TARGET_SPEC.cornerRadialChartCount,
    colorBarPatchCount: OPTICAL_SHOWCASE_TARGET_SPEC.colorBarPatchCount,
    grayscaleBarPatchCount: OPTICAL_SHOWCASE_TARGET_SPEC.grayscaleBarPatchCount,
    nominalMaxFrequencyLpmm: getImageSimulationTargetNominalMaxFrequencyLpmm('optical-showcase', 240, 240),
  },
  imageScaleModes: ['field-fit', 'sensor-width', 'pixel-pitch'],
}, null, 2));
