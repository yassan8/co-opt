export type DistortionGridMapLike = {
  gridSize: number;
  idealX: number[];
  idealY: number[];
  realX: Array<number | null>;
  realY: Array<number | null>;
};

export type DistortionAffineReference = {
  m00: number;
  m01: number;
  m10: number;
  m11: number;
  tx: number;
  ty: number;
  determinant: number;
  sampleCount: number;
  valid: boolean;
};

type DistortionSeriesLike = {
  idealHeights?: Array<number | null>;
  realHeights?: Array<number | null>;
  distortion?: Array<number | null>;
  distortionPercent?: Array<number | null>;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};

const IDENTITY_AFFINE: DistortionAffineReference = {
  m00: 1,
  m01: 0,
  m10: 0,
  m11: 1,
  tx: 0,
  ty: 0,
  determinant: 1,
  sampleCount: 0,
  valid: false,
};

const finiteNumberOrNull = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

function solveThreeByThree(matrix: number[][], vector: number[]): number[] | null {
  const augmented = matrix.map((row, index) => [row[0], row[1], row[2], vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (!(Math.abs(augmented[pivot][column]) > 1e-14)) return null;
    if (pivot !== column) [augmented[pivot], augmented[column]] = [augmented[column], augmented[pivot]];
    const scale = augmented[column][column];
    for (let entry = column; entry < 4; entry += 1) augmented[column][entry] /= scale;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = column; entry < 4; entry += 1) {
        augmented[row][entry] -= factor * augmented[column][entry];
      }
    }
  }
  return augmented.map((row) => row[3]);
}

export function fitDistortionAffineReference(map: DistortionGridMapLike): DistortionAffineReference {
  const count = Math.min(
    Array.isArray(map?.idealX) ? map.idealX.length : 0,
    Array.isArray(map?.idealY) ? map.idealY.length : 0,
    Array.isArray(map?.realX) ? map.realX.length : 0,
    Array.isArray(map?.realY) ? map.realY.length : 0,
  );
  const samples: Array<{ x: number; y: number; realX: number; realY: number }> = [];
  let maxAbsX = 0;
  let maxAbsY = 0;
  for (let index = 0; index < count; index += 1) {
    const x = finiteNumberOrNull(map.idealX[index]);
    const y = finiteNumberOrNull(map.idealY[index]);
    const realX = finiteNumberOrNull(map.realX[index]);
    const realY = finiteNumberOrNull(map.realY[index]);
    if (x === null || y === null || realX === null || realY === null) continue;
    maxAbsX = Math.max(maxAbsX, Math.abs(x));
    maxAbsY = Math.max(maxAbsY, Math.abs(y));
    samples.push({ x, y, realX, realY });
  }
  if (samples.length < 3 || !(maxAbsX > 1e-12) || !(maxAbsY > 1e-12)) return { ...IDENTITY_AFFINE };

  const localSamples = samples
    .map((sample) => ({
      ...sample,
      u: sample.x / maxAbsX,
      v: sample.y / maxAbsY,
      radius2: (sample.x / maxAbsX) ** 2 + (sample.y / maxAbsY) ** 2,
    }))
    .sort((left, right) => left.radius2 - right.radius2)
    .slice(0, Math.min(samples.length, 13));

  const normal = Array.from({ length: 3 }, () => [0, 0, 0]);
  const rhsX = [0, 0, 0];
  const rhsY = [0, 0, 0];
  for (const sample of localSamples) {
    const basis = [sample.u, sample.v, 1];
    const weight = 1 / Math.max(0.05, 0.05 + sample.radius2);
    for (let row = 0; row < 3; row += 1) {
      rhsX[row] += weight * basis[row] * sample.realX;
      rhsY[row] += weight * basis[row] * sample.realY;
      for (let column = 0; column < 3; column += 1) {
        normal[row][column] += weight * basis[row] * basis[column];
      }
    }
  }
  const coefficientsX = solveThreeByThree(normal, rhsX);
  const coefficientsY = solveThreeByThree(normal, rhsY);
  if (!coefficientsX || !coefficientsY) return { ...IDENTITY_AFFINE, sampleCount: localSamples.length };
  const m00 = coefficientsX[0] / maxAbsX;
  const m01 = coefficientsX[1] / maxAbsY;
  const m10 = coefficientsY[0] / maxAbsX;
  const m11 = coefficientsY[1] / maxAbsY;
  const determinant = m00 * m11 - m01 * m10;
  const matrixScale = Math.max(1e-12, Math.abs(m00), Math.abs(m01), Math.abs(m10), Math.abs(m11));
  const valid = [m00, m01, m10, m11, coefficientsX[2], coefficientsY[2], determinant].every(Number.isFinite)
    && Math.abs(determinant) > matrixScale * matrixScale * 1e-9;
  return {
    m00,
    m01,
    m10,
    m11,
    tx: coefficientsX[2],
    ty: coefficientsY[2],
    determinant,
    sampleCount: localSamples.length,
    valid,
  };
}

export function normalizeDistortionMapToReference<T extends DistortionGridMapLike>(
  map: T,
  reference: DistortionAffineReference,
): T {
  if (!reference.valid) {
    return {
      ...map,
      realX: [...map.realX],
      realY: [...map.realY],
    };
  }
  const count = Math.min(map.realX.length, map.realY.length);
  const realX: Array<number | null> = new Array(count).fill(null);
  const realY: Array<number | null> = new Array(count).fill(null);
  const inverse00 = reference.m11 / reference.determinant;
  const inverse01 = -reference.m01 / reference.determinant;
  const inverse10 = -reference.m10 / reference.determinant;
  const inverse11 = reference.m00 / reference.determinant;
  for (let index = 0; index < count; index += 1) {
    const rawX = finiteNumberOrNull(map.realX[index]);
    const rawY = finiteNumberOrNull(map.realY[index]);
    if (rawX === null || rawY === null) continue;
    const translatedX = rawX - reference.tx;
    const translatedY = rawY - reference.ty;
    realX[index] = inverse00 * translatedX + inverse01 * translatedY;
    realY[index] = inverse10 * translatedX + inverse11 * translatedY;
  }
  return { ...map, realX, realY };
}

export function normalizeDistortionMapsToReference<T extends DistortionGridMapLike>(
  maps: T[],
  referenceIndex = 0,
): { maps: T[]; reference: DistortionAffineReference } {
  if (!Array.isArray(maps) || maps.length === 0) {
    return { maps: [], reference: { ...IDENTITY_AFFINE } };
  }
  const boundedReferenceIndex = Math.max(0, Math.min(maps.length - 1, Math.floor(referenceIndex)));
  const reference = fitDistortionAffineReference(maps[boundedReferenceIndex]);
  return {
    maps: maps.map((map) => normalizeDistortionMapToReference(map, reference)),
    reference,
  };
}

export function normalizeDistortionSeriesLinearReference<T extends DistortionSeriesLike>(series: T): T {
  const ideal = Array.isArray(series?.idealHeights) ? series.idealHeights : [];
  const real = Array.isArray(series?.realHeights) ? series.realHeights : [];
  const count = Math.min(ideal.length, real.length);
  const samples: Array<{ ideal: number; real: number }> = [];
  let intercept = 0;
  let interceptRadius = Number.POSITIVE_INFINITY;
  for (let index = 0; index < count; index += 1) {
    const idealValue = finiteNumberOrNull(ideal[index]);
    const realValue = finiteNumberOrNull(real[index]);
    if (idealValue === null || realValue === null) continue;
    const radius = Math.abs(idealValue);
    if (radius < interceptRadius) {
      interceptRadius = radius;
      intercept = realValue;
    }
    if (radius > 1e-12) samples.push({ ideal: idealValue, real: realValue });
  }
  samples.sort((left, right) => Math.abs(left.ideal) - Math.abs(right.ideal));
  const localSamples = samples.slice(0, Math.min(samples.length, 5));
  let numerator = 0;
  let denominator = 0;
  for (const sample of localSamples) {
    numerator += sample.ideal * (sample.real - intercept);
    denominator += sample.ideal * sample.ideal;
  }
  const scale = denominator > 1e-20 ? numerator / denominator : Number.NaN;
  if (!(Number.isFinite(scale) && Math.abs(scale) > 1e-12)) return series;

  const idealHeights = ideal.map((value) => {
    const numeric = finiteNumberOrNull(value);
    return numeric !== null ? intercept + scale * numeric : null;
  });
  const distortion = idealHeights.map((referenceValue, index) => {
    const measured = finiteNumberOrNull(real[index]);
    const referenceHeight = finiteNumberOrNull(referenceValue);
    if (measured === null || referenceHeight === null) return null;
    const denominatorHeight = referenceHeight - intercept;
    if (Math.abs(denominatorHeight) <= 1e-12) return 0;
    return (measured - referenceHeight) / Math.abs(denominatorHeight);
  });
  const distortionPercent = distortion.map((value) => (
    typeof value === 'number' && Number.isFinite(value) ? value * 100 : null
  ));
  return {
    ...series,
    idealHeights,
    distortion,
    distortionPercent,
    meta: {
      ...(series.meta || {}),
      distortionLinearReferenceScale: scale,
      distortionLinearReferenceOffset: intercept,
      distortionReferenceMode: 'local-chief-ray-linear',
    },
  } as T;
}
