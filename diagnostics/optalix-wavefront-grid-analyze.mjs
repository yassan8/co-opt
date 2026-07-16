import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const diagnosticsDir = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(diagnosticsDir, 'results');

const field = Number(process.argv[process.argv.indexOf('--field') + 1] || 6);
const nativeRmsByField = {
  6: [0.97163, 0.99924, 0.99891, 0.99671, 0.99528],
  11: [0.65745, 0.72747, 0.73198, 0.73807, 0.74011]
};
const nativeRayCountByFieldAndNrd = {
  6: { 16: 178, 32: 723, 64: 2899, 128: 11576, 256: 46280 },
  11: { 16: 128, 32: 516, 64: 2059, 128: 8256, 256: 33015 }
};
const nrdValues = [16, 32, 64, 128, 256];

if (!nativeRmsByField[field]) {
  throw new Error(`Unsupported field ${field}; expected 6 or 11.`);
}

const cases = nrdValues.map((nrd, index) => ({
  nrd,
  nativeRms: nativeRmsByField[field][index]
}));

const parseOpd = (nrd) => {
  const file = path.join(resultsDir, `optalix-wavefront-nrd${nrd}-f${field}-w2.opd`);
  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const [wavelengthNm, pupilRadiusMm] = lines.shift().split(',').map(Number);
  const points = lines.map((line) => {
    const [x, y, waves] = line.split(',').map(Number);
    return { x, y, waves };
  });

  return { file, wavelengthNm, pupilRadiusMm, points };
};

const rms = (sumSquares, weight) => Math.sqrt(sumSquares / weight);

const pistonRms = (points) => {
  const mean = points.reduce((sum, point) => sum + point.waves, 0) / points.length;
  const sumSquares = points.reduce(
    (sum, point) => sum + (point.waves - mean) ** 2,
    0
  );
  return { mean, rms: rms(sumSquares, points.length) };
};

const maskBoundaryRms = (points, nrd) => {
  const byCoordinate = new Map(
    points.map((point) => [`${point.x},${point.y}`, {
      ...point,
      valid: point.waves !== 0 || (point.x === 0 && point.y === 0)
    }])
  );
  const weights = new Map();

  for (let y = -nrd / 2; y < nrd / 2; y += 1) {
    for (let x = -nrd / 2; x < nrd / 2; x += 1) {
      const corners = [
        byCoordinate.get(`${x},${y}`),
        byCoordinate.get(`${x + 1},${y}`),
        byCoordinate.get(`${x + 1},${y + 1}`),
        byCoordinate.get(`${x},${y + 1}`)
      ];
      const validCorners = corners.filter((corner) => corner.valid);
      const validCount = validCorners.length;
      if (validCount === 0) continue;

      const area = validCount === 4
        ? 1
        : validCount === 1
          ? 0.125
          : validCount === 2
            ? 0.5
            : 0.875;
      for (const corner of validCorners) {
        const key = `${corner.x},${corner.y}`;
        weights.set(key, (weights.get(key) || 0) + area / validCount);
      }
    }
  }

  let totalWeight = 0;
  let weightedSum = 0;
  for (const [key, weight] of weights) {
    totalWeight += weight;
    weightedSum += weight * byCoordinate.get(key).waves;
  }
  const mean = weightedSum / totalWeight;
  let weightedSquares = 0;
  for (const [key, weight] of weights) {
    weightedSquares += weight * (byCoordinate.get(key).waves - mean) ** 2;
  }

  return { mean, rms: rms(weightedSquares, totalWeight), totalWeight };
};

const cellAreaRms = (points, radius, subdivisions = 80) => {
  let weightedSquares = 0;
  let totalWeight = 0;

  for (const point of points) {
    const minimumRadius = Math.hypot(
      Math.max(Math.abs(point.x) - 0.5, 0),
      Math.max(Math.abs(point.y) - 0.5, 0)
    );
    const maximumRadius = Math.hypot(
      Math.abs(point.x) + 0.5,
      Math.abs(point.y) + 0.5
    );

    let weight = 0;
    if (maximumRadius <= radius) {
      weight = 1;
    } else if (minimumRadius < radius) {
      let inside = 0;
      for (let row = 0; row < subdivisions; row += 1) {
        const y = point.y - 0.5 + (row + 0.5) / subdivisions;
        for (let column = 0; column < subdivisions; column += 1) {
          const x = point.x - 0.5 + (column + 0.5) / subdivisions;
          if (x * x + y * y <= radius * radius) inside += 1;
        }
      }
      weight = inside / (subdivisions * subdivisions);
    }

    totalWeight += weight;
    weightedSquares += weight * point.waves * point.waves;
  }

  return { rms: rms(weightedSquares, totalWeight), totalWeight };
};

const loaded = cases.map((entry) => ({ ...entry, ...parseOpd(entry.nrd) }));

for (const entry of loaded) {
  const halfNrd = entry.nrd / 2;
  const sumSquares = entry.points.reduce(
    (sum, point) => sum + point.waves * point.waves,
    0
  );
  const circlePoints = entry.points.filter(
    (point) => point.x * point.x + point.y * point.y <= halfNrd * halfNrd
  );
  const circleSquares = circlePoints.reduce(
    (sum, point) => sum + point.waves * point.waves,
    0
  );
  const nonzeroPoints = entry.points.filter((point) => point.waves !== 0);
  const nativeRayCount = nativeRayCountByFieldAndNrd[field][entry.nrd] || null;
  const nonzeroPiston = pistonRms(nonzeroPoints);
  const boundaryProbe = cellAreaRms(entry.points, halfNrd * 1.0128);
  const maskBoundaryProbe = maskBoundaryRms(entry.points, entry.nrd);

  console.log(JSON.stringify({
    field,
    nrd: entry.nrd,
    dimensions: [entry.nrd + 1, entry.nrd + 1],
    wavelengthNm: entry.wavelengthNm,
    pupilRadiusMm: entry.pupilRadiusMm,
    pointCount: entry.points.length,
    nonzeroCount: nonzeroPoints.length,
    nativeRayCount,
    nonzeroCountDeltaFromNativeRays: nativeRayCount === null
      ? null
      : nonzeroPoints.length - nativeRayCount,
    nativeRms: entry.nativeRms,
    unitCirclePointCount: circlePoints.length,
    unitCircleRawRms: rms(circleSquares, circlePoints.length),
    fullGridSumSquares: sumSquares,
    impliedEffectiveWeight: sumSquares / (entry.nativeRms * entry.nativeRms),
    nonzeroPistonProbe: {
      mean: nonzeroPiston.mean,
      rms: nonzeroPiston.rms,
      deltaFromNative: nonzeroPiston.rms - entry.nativeRms
    },
    boundaryCellProbe: {
      radiusScale: 1.0128,
      rms: boundaryProbe.rms,
      totalWeight: boundaryProbe.totalWeight,
      deltaFromNative: boundaryProbe.rms - entry.nativeRms
    },
    maskBoundaryProbe: {
      edgeCrossingFraction: 0.5,
      rms: maskBoundaryProbe.rms,
      totalWeight: maskBoundaryProbe.totalWeight,
      deltaFromNative: maskBoundaryProbe.rms - entry.nativeRms
    }
  }, null, 2));
}

for (let index = 0; index < loaded.length - 1; index += 1) {
  const coarse = loaded[index];
  const fine = loaded[index + 1];
  const fineByCoordinate = new Map(
    fine.points.map((point) => [`${point.x},${point.y}`, point.waves])
  );
  const cellCenters = fine.points.filter(
    (point) => Math.abs(point.x) % 2 === 1
      && Math.abs(point.y) % 2 === 1
      && point.waves !== 0
  );
  const cellCenterPiston = pistonRms(cellCenters);
  let different = 0;
  let maximumDifference = 0;

  for (const point of coarse.points) {
    const fineValue = fineByCoordinate.get(`${point.x * 2},${point.y * 2}`);
    const difference = Math.abs(point.waves - fineValue);
    if (difference !== 0) different += 1;
    maximumDifference = Math.max(maximumDifference, difference);
  }

  console.log(JSON.stringify({
    nesting: `${coarse.nrd}->${fine.nrd}`,
    compared: coarse.points.length,
    different,
    maximumDifference,
    coarseCellCenterProbe: {
      count: cellCenters.length,
      pistonRms: cellCenterPiston.rms,
      nativeRms: coarse.nativeRms,
      deltaFromNative: cellCenterPiston.rms - coarse.nativeRms
    }
  }, null, 2));
}