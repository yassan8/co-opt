import assert from 'node:assert/strict';

const {
  normalizeDistortionMapsToReference,
} = await import('../evaluation/aberrations/distortion-normalization.ts');

function buildMap({ nonlinear = 0, chromaticScale = 1 } = {}) {
  const gridSize = 7;
  const idealX = [];
  const idealY = [];
  const realX = [];
  const realY = [];
  for (let row = 0; row < gridSize; row += 1) {
    const y = -12 + 24 * row / (gridSize - 1);
    for (let column = 0; column < gridSize; column += 1) {
      const x = -18 + 36 * column / (gridSize - 1);
      const radius2 = (x / 18) ** 2 + (y / 12) ** 2;
      const distortedX = chromaticScale * x * (1 + nonlinear * radius2);
      const distortedY = chromaticScale * y * (1 + nonlinear * radius2);
      idealX.push(x);
      idealY.push(y);
      realX.push(-1.2 * distortedX + 0.15 * distortedY + 2.5);
      realY.push(0.08 * distortedX - 1.6 * distortedY - 1.75);
    }
  }
  return { gridSize, idealX, idealY, realX, realY };
}

const primaryAffine = buildMap();
const affineNormalized = normalizeDistortionMapsToReference([primaryAffine]);
assert.equal(affineNormalized.reference.valid, true, 'affine reference must be invertible');
let maxAffineResidual = 0;
for (let index = 0; index < primaryAffine.idealX.length; index += 1) {
  maxAffineResidual = Math.max(maxAffineResidual, Math.hypot(
    affineNormalized.maps[0].realX[index] - primaryAffine.idealX[index],
    affineNormalized.maps[0].realY[index] - primaryAffine.idealY[index],
  ));
}
assert.ok(maxAffineResidual < 1e-10, 'magnification, inversion, rotation and translation must not appear as distortion');

const barrelMap = buildMap({ nonlinear: -0.08 });
const barrelNormalized = normalizeDistortionMapsToReference([barrelMap]);
const cornerIndex = 0;
const centerIndex = Math.floor(barrelMap.realX.length / 2);
const cornerResidual = Math.hypot(
  barrelNormalized.maps[0].realX[cornerIndex] - barrelMap.idealX[cornerIndex],
  barrelNormalized.maps[0].realY[cornerIndex] - barrelMap.idealY[cornerIndex],
);
const centerResidual = Math.hypot(
  barrelNormalized.maps[0].realX[centerIndex] - barrelMap.idealX[centerIndex],
  barrelNormalized.maps[0].realY[centerIndex] - barrelMap.idealY[centerIndex],
);
assert.ok(cornerResidual > 1, 'non-linear edge distortion must remain after affine reference removal');
assert.ok(centerResidual < 1e-9, 'the optical axis must remain fixed');

const secondaryChromatic = buildMap({ chromaticScale: 1.01 });
const chromaticNormalized = normalizeDistortionMapsToReference([primaryAffine, secondaryChromatic], 0);
const rightCenterIndex = Math.floor(primaryAffine.gridSize / 2) * primaryAffine.gridSize + primaryAffine.gridSize - 1;
const chromaticShiftX = chromaticNormalized.maps[1].realX[rightCenterIndex] - primaryAffine.idealX[rightCenterIndex];
assert.ok(Math.abs(chromaticShiftX - 0.18) < 1e-10, 'a shared primary reference must preserve lateral chromatic magnification');

console.log(JSON.stringify({
  ok: true,
  affineReference: affineNormalized.reference,
  maxAffineResidual,
  barrelCornerResidual: cornerResidual,
  barrelCenterResidual: centerResidual,
  chromaticShiftX,
}, null, 2));
