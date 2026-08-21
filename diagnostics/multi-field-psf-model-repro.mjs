import assert from 'node:assert/strict';
import { PSFPlotter } from '../evaluation/psf/psf-plot.ts';
import {
  MULTI_FIELD_PSF_GRID_PRESETS,
  buildMultiFieldPsfGrid,
  buildMultiFieldPsfObjectRow,
  calculateMultiFieldPsfOpdRmsUm,
  deriveMultiFieldPsfFieldDefinition,
  getMultiFieldPsfFieldAzimuthDeg,
  getMultiFieldPsfLocalToGlobalRotationDeg,
  getMultiFieldPsfCenteringOffset,
  prepareMultiFieldPsfImage,
  rotateMultiFieldPsfGridCartesian,
  rotateMultiFieldPsfImageCartesian,
} from '../src/app/multi-field-psf-model.ts';

assert.ok(MULTI_FIELD_PSF_GRID_PRESETS.length >= 18, 'Field Grid needs a broad preset range');
assert.ok(MULTI_FIELD_PSF_GRID_PRESETS.includes(31), '31x31 preset is missing');

const definition = deriveMultiFieldPsfFieldDefinition([
  { position: 'Angle', xHeightAngle: 0, yHeightAngle: 0 },
  { position: 'Angle', xHeightAngle: 0, yHeightAngle: 46 },
]);
assert.deepEqual(definition, { mode: 'angle', unit: 'deg', maxX: 46, maxY: 46 });

const rectangular = buildMultiFieldPsfGrid({ rows: 7, columns: 11, maxX: 10, maxY: 6, shape: 'rectangle' });
assert.equal(rectangular.length, 77);
assert.ok(rectangular.every((point) => point.inside));
assert.deepEqual(
  { x: rectangular[0].x, y: rectangular[0].y, xLast: rectangular.at(-1).x, yLast: rectangular.at(-1).y },
  { x: -10, y: 6, xLast: 10, yLast: -6 },
);

const elliptical = buildMultiFieldPsfGrid({ rows: 3, columns: 3, maxX: 10, maxY: 6, shape: 'ellipse' });
assert.equal(elliptical.filter((point) => point.inside).length, 5);

const originalObject = { position: 'Angle', xHeightAngle: 0, yHeightAngle: 46, weight: 2 };
const fieldObject = buildMultiFieldPsfObjectRow([originalObject], { x: -12, y: 8 }, 'angle');
assert.equal(fieldObject.position, 'Angle');
assert.equal(fieldObject.xHeightAngle, -12);
assert.equal(fieldObject.yHeightAngle, 8);
assert.equal(fieldObject.weight, 2);
assert.equal(originalObject.xHeightAngle, 0, 'Field override mutated the Object table row');

const rms = calculateMultiFieldPsfOpdRmsUm(
  [[-1, 1], [-1, 1]],
  [[true, true], [true, true]],
);
assert.equal(rms, 1);

const scalar = [[1, 0], [0, 0.5]];
const trueColorData = {
  red: [[0, 1], [0, 0]],
  green: [[0, 0], [1, 0]],
  blue: [[0, 0], [0, 0]],
};
const trueColorImage = prepareMultiFieldPsfImage(scalar, trueColorData, 'true', false);
assert.ok(trueColorImage);
assert.equal(trueColorImage.width, 2);
assert.equal(trueColorImage.height, 2);
assert.ok(trueColorImage.rgba[12] > 0 && trueColorImage.rgba[13] === 0, 'Cartesian -Y red pixel was not placed at raster bottom-right');
assert.ok(trueColorImage.rgba[1] > 0 && trueColorImage.rgba[0] === 0, 'Cartesian +Y green pixel was not placed at raster top-left');
assert.ok(Math.abs(trueColorImage.intensityCenter.x - 1 / 3) < 1e-10, 'Linear PSF intensity center X was not retained');
assert.ok(Math.abs(trueColorImage.intensityCenter.y - 2 / 3) < 1e-10, 'Linear PSF intensity center Y was not converted into raster coordinates');
const pseudoColorImage = prepareMultiFieldPsfImage(scalar, null, 'pseudo', false);
assert.ok(pseudoColorImage);
assert.ok(pseudoColorImage.rgba[8] > 0, 'Pseudo-color Cartesian -Y peak was not placed at raster bottom-left');
assert.ok(pseudoColorImage.rgba[5] > 0, 'Pseudo-color Cartesian +Y sample was not placed at raster top-right');

const diagonalField = { x: 23, y: 23 };
const diagonalAzimuthDeg = getMultiFieldPsfFieldAzimuthDeg(diagonalField, 'angle');
const diagonalRotationDeg = getMultiFieldPsfLocalToGlobalRotationDeg(diagonalField, 'angle');
assert.ok(Math.abs(diagonalAzimuthDeg - 45) < 1e-10, 'Field (23°, 23°) did not resolve to 45° azimuth');
assert.ok(Math.abs(diagonalRotationDeg - 135) < 1e-10, 'Local PSF basis did not resolve to the required 135° image rotation');
const evenGridOrigin = Array.from({ length: 32 }, () => new Array(32).fill(0));
evenGridOrigin[16][16] = 1;
const rotatedEvenGridOrigin = rotateMultiFieldPsfGridCartesian(evenGridOrigin, 90);
assert.ok(
  rotatedEvenGridOrigin[16][16] > 1 - 1e-12,
  'even-grid fftshift origin must remain fixed during PSF visualization rotation',
);
const localRadialLobe = new Uint8ClampedArray(9 * 9 * 4);
for (let index = 0; index < 9 * 9; index += 1) localRadialLobe[index * 4 + 3] = 255;
localRadialLobe[((4 + 2) * 9 + 4) * 4] = 255;
const rotatedDiagonalLobe = rotateMultiFieldPsfImageCartesian({
  width: 9,
  height: 9,
  rgba: localRadialLobe,
  intensityCenter: { x: 4, y: 6 },
}, diagonalRotationDeg);
let lobePeak = { x: 0, y: 0, value: -1 };
for (let y = 0; y < 9; y += 1) {
  for (let x = 0; x < 9; x += 1) {
    const value = rotatedDiagonalLobe.rgba[(y * 9 + x) * 4];
    if (value > lobePeak.value) lobePeak = { x, y, value };
  }
}
assert.ok(lobePeak.x > 4 && lobePeak.y < 4, 'The diagonal radial lobe was not rotated toward global +X/+Y');
assert.ok(rotatedDiagonalLobe.intensityCenter.x > 4 && rotatedDiagonalLobe.intensityCenter.y < 4, 'The intensity center did not follow the PSF basis rotation');
const centeringOffset = getMultiFieldPsfCenteringOffset(rotatedDiagonalLobe, 90);
const renderedIntensityCenterX = 45 + centeringOffset.x + (rotatedDiagonalLobe.intensityCenter.x - 4) * 10;
const renderedIntensityCenterY = 45 + centeringOffset.y + (rotatedDiagonalLobe.intensityCenter.y - 4) * 10;
assert.ok(Math.abs(renderedIntensityCenterX - 45) < 1e-10, 'Centering offset did not align X');
assert.ok(Math.abs(renderedIntensityCenterY - 45) < 1e-10, 'Centering offset did not align Y');

const blue = PSFPlotter.wavelengthToLinearRGB(0.475);
const red = PSFPlotter.wavelengthToLinearRGB(0.6562725);
assert.ok(blue[2] > blue[0], 'Blue wavelength did not produce blue-dominant true color');
assert.ok(red[0] > red[2], 'Red wavelength did not produce red-dominant true color');
assert.deepEqual(PSFPlotter.wavelengthToLinearRGB(2.5), [0, 0, 0], 'True color must render far IR black');
assert.ok(PSFPlotter.wavelengthToFalseColorLinearRGB(2.5).some((value) => value > 0), 'False color must retain an IR analysis color');

console.log(JSON.stringify({
  ok: true,
  presetCount: MULTI_FIELD_PSF_GRID_PRESETS.length,
  maxPreset: Math.max(...MULTI_FIELD_PSF_GRID_PRESETS),
  rectangularPoints: rectangular.length,
  ellipticalPoints: elliptical.filter((point) => point.inside).length,
  trueColorOrientation: 'row-major y/x, Cartesian +Y up',
  diagonalFieldAzimuthDeg: diagonalAzimuthDeg,
  diagonalPsfBasisRotationDeg: diagonalRotationDeg,
}, null, 2));
