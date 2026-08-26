import type { CoherentDetectorFieldSample } from './detector-signal.ts';
import { sampleTargetHeightUm, type TargetProfileSpec } from './coherent-assembly.ts';

const LIGHT_M_S = 299_792_458;
const TWO_PI = Math.PI * 2;

export interface DualCombCameraReconstructionOptions {
  spectralFields: ArrayLike<CoherentDetectorFieldSample>;
  detectorWidth: number;
  detectorHeight: number;
  targetSpanMm: number;
  measurementRouteId: string;
  referenceRouteId: string;
  localOscillatorRouteId: string;
  maximumProfilePoints?: number;
  exposureTimeS?: number;
  /** Flat-target Camera RF fields acquired through the same optical assembly. */
  flatReferenceSpectralFields?: ArrayLike<CoherentDetectorFieldSample>;
  /** Camera RF fields acquired with a known uniform Target gradient. */
  slopeReferenceSpectralFields?: ArrayLike<CoherentDetectorFieldSample>;
  /** Known dz/dx gradient used for the slope-reference acquisition. */
  slopeReferenceGradient?: number;
  /** Multiple known uniform-gradient Camera acquisitions for nonlinear shift calibration. */
  slopeCalibrationReferences?: Array<{
    spectralFields: ArrayLike<CoherentDetectorFieldSample>;
    gradient: number;
    /** Axial height of the tilted calibration plane at local X = 0. */
    offsetUm?: number;
  }>;
  /** Flat, axially offset Camera acquisitions used to separate height from slope. */
  heightCalibrationReferences?: Array<{
    spectralFields: ArrayLike<CoherentDetectorFieldSample>;
    offsetUm: number;
  }>;
  /** Comparison only. Never used by RF phase extraction or unwrapping. */
  comparisonTarget?: TargetProfileSpec;
}

export interface DualCombCameraReconstructionResult {
  width: number;
  profileAxis: 'x' | 'y';
  xMm: number[];
  recoveredHeightUm: number[];
  targetHeightUm: number[];
  opticalPathDifferenceMm: number[];
  phaseFitRmsRad: number[];
  validLineCount: number[];
  coverageFraction: number;
  /** Physical Target-coordinate span represented by the recovered samples. */
  targetRangeMm: number;
  /** Illuminated/recovered Target span divided by the configured Target span. */
  targetCoverageFraction: number;
  meanPhaseFitRmsRad: number;
  meanLineCount: number;
  referenceColumn: number;
  referenceXmm: number;
  maximumBeatFrequencyHz: number;
  requiredFrameRateHz: number;
  timeIntegratedCamera: boolean;
  flatReferenceApplied: boolean;
  slopeCalibrationApplied: boolean;
  /** Diagnostic: enough matched micro-tilt Camera samples were available. */
  slopeCalibrationAvailable?: boolean;
  /** Diagnostic candidate spans used for automatic observable selection. */
  slopeCandidatePeakToValleyUm?: number;
  phaseCandidatePeakToValleyUm?: number;
  slopeCalibrationReferenceCount?: number;
  heightCalibrationReferenceCount?: number;
  reconstructionMethod: 'rf-opd' | 'camera-slope';
  meanCameraShiftPx: number;
  rmsHeightErrorUm: number;
  maxAbsHeightErrorUm: number;
  warningMessages: string[];
}

type Complex = { re: number; im: number };
type LineField = { frequencyHz: number; field: Complex; sampleCount: number };

const finite = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;

function addComplex(target: Complex, re: number, im: number): void {
  target.re += re;
  target.im += im;
}

function multiplyConjugate(left: Complex, right: Complex): Complex {
  return {
    re: left.re * right.re + left.im * right.im,
    im: left.im * right.re - left.re * right.im,
  };
}

function multiply(left: Complex, right: Complex): Complex {
  return {
    re: left.re * right.re - left.im * right.im,
    im: left.re * right.im + left.im * right.re,
  };
}

function interpolateMissing(values: number[]): number[] {
  const output = values.slice();
  const valid = output.map((value, index) => Number.isFinite(value) ? index : -1).filter((index) => index >= 0);
  if (!valid.length) return output.map(() => 0);
  for (let index = 0; index < valid[0]; index += 1) output[index] = output[valid[0]];
  for (let pair = 0; pair + 1 < valid.length; pair += 1) {
    const left = valid[pair];
    const right = valid[pair + 1];
    for (let index = left + 1; index < right; index += 1) {
      const fraction = (index - left) / (right - left);
      output[index] = output[left] + (output[right] - output[left]) * fraction;
    }
  }
  for (let index = valid[valid.length - 1] + 1; index < output.length; index += 1) output[index] = output[valid[valid.length - 1]];
  return output;
}

function fitDelayFromBeatPhase(lines: Array<{ frequencyHz: number; phaseRad: number; weight: number }>): {
  opdMm: number;
  rmsRad: number;
} | null {
  if (lines.length < 3) return null;
  lines.sort((left, right) => left.frequencyHz - right.frequencyHz);
  const phase = new Array<number>(lines.length);
  phase[0] = lines[0].phaseRad;
  for (let index = 1; index < lines.length; index += 1) {
    let next = lines[index].phaseRad;
    while (next - phase[index - 1] > Math.PI) next -= TWO_PI;
    while (next - phase[index - 1] < -Math.PI) next += TWO_PI;
    phase[index] = next;
  }
  const totalWeight = lines.reduce((sum, line) => sum + line.weight, 0);
  if (!(totalWeight > 0)) return null;
  const meanFrequency = lines.reduce((sum, line) => sum + line.frequencyHz * line.weight, 0) / totalWeight;
  const meanPhase = lines.reduce((sum, line, index) => sum + phase[index] * line.weight, 0) / totalWeight;
  let covariance = 0;
  let frequencyVariance = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const frequencyOffset = lines[index].frequencyHz - meanFrequency;
    covariance += lines[index].weight * frequencyOffset * (phase[index] - meanPhase);
    frequencyVariance += lines[index].weight * frequencyOffset * frequencyOffset;
  }
  if (!(frequencyVariance > 0)) return null;
  const slopeRadPerHz = covariance / frequencyVariance;
  const intercept = meanPhase - slopeRadPerHz * meanFrequency;
  const phaseVariance = lines.reduce((sum, line, index) => {
    const residual = phase[index] - (intercept + slopeRadPerHz * line.frequencyHz);
    return sum + line.weight * residual * residual;
  }, 0) / totalWeight;
  return {
    opdMm: slopeRadPerHz * LIGHT_M_S / TWO_PI * 1000,
    rmsRad: Math.sqrt(Math.max(0, phaseVariance)),
  };
}

function reconstructFromFlatCameraMeasurement(
  options: DualCombCameraReconstructionOptions,
  currentSamples: CoherentDetectorFieldSample[],
  flatSamples: CoherentDetectorFieldSample[],
  profileAxis: 'x' | 'y',
  beamsOverlap: boolean,
): DualCombCameraReconstructionResult | null {
  const currentMeasurement = currentSamples.filter((sample) => (
    sample.routeId === options.measurementRouteId && Number.isFinite(sample.targetXmm)
  ));
  const flatMeasurement = flatSamples.filter((sample) => (
    sample.routeId === options.measurementRouteId && Number.isFinite(sample.targetXmm)
  ));
  const slopeReferenceSets = (options.slopeCalibrationReferences ?? [])
    .filter((reference) => Number.isFinite(reference?.gradient))
    .map((reference) => ({
      gradient: Number(reference.gradient),
      offsetUm: finite(reference.offsetUm),
      samples: Array.from(reference.spectralFields ?? []).filter((sample) => (
        sample.routeId === options.measurementRouteId && Number.isFinite(sample.targetXmm)
      )),
    }));
  const heightReferenceSets = (options.heightCalibrationReferences ?? [])
    .filter((reference) => Number.isFinite(reference?.offsetUm) && Math.abs(Number(reference.offsetUm)) > 1e-12)
    .map((reference) => ({
      offsetUm: Number(reference.offsetUm),
      samples: Array.from(reference.spectralFields ?? []).filter((sample) => (
        sample.routeId === options.measurementRouteId && Number.isFinite(sample.targetXmm)
      )),
    }));
  if (!slopeReferenceSets.length && options.slopeReferenceSpectralFields) {
    slopeReferenceSets.push({
      gradient: finite(options.slopeReferenceGradient, Number.NaN),
      samples: Array.from(options.slopeReferenceSpectralFields).filter((sample) => (
        sample.routeId === options.measurementRouteId && Number.isFinite(sample.targetXmm)
      )),
    });
  }
  if (!currentMeasurement.length || !flatMeasurement.length) return null;

  const pupilKey = (sample: CoherentDetectorFieldSample) => (
    `${finite(sample.pupilXmm).toFixed(9)}:${finite(sample.pupilYmm).toFixed(9)}`
  );
  const flatByRay = new Map(flatMeasurement.map((sample) => (
    [`${Math.round(finite(sample.lineIndex))}:${pupilKey(sample)}`, sample]
  )));
  const slopeByRay = slopeReferenceSets.map((reference) => ({
    gradient: reference.gradient,
    offsetUm: reference.offsetUm,
    samples: new Map(reference.samples.map((sample) => (
      [`${Math.round(finite(sample.lineIndex))}:${pupilKey(sample)}`, sample]
    ))),
  }));
  const heightByRay = heightReferenceSets.map((reference) => ({
    offsetUm: reference.offsetUm,
    samples: new Map(reference.samples.map((sample) => (
      [`${Math.round(finite(sample.lineIndex))}:${pupilKey(sample)}`, sample]
    ))),
  }));
  const matched = currentMeasurement.map((sample) => {
    const lineIndex = Math.round(finite(sample.lineIndex));
    const spatialKey = pupilKey(sample);
    const flat = flatByRay.get(`${lineIndex}:${spatialKey}`);
    if (!flat) return null;
    const detectorCoordinate = profileAxis === 'x' ? sample.pixelX : sample.pixelY;
    const flatDetectorCoordinate = profileAxis === 'x' ? flat.pixelX : flat.pixelY;
    const calibrationCurve = slopeByRay.map((reference, referenceIndex) => {
      const slopeReference = reference.samples.get(`${lineIndex}:${spatialKey}`);
      const slopeDetectorCoordinate = slopeReference
        ? (profileAxis === 'x' ? slopeReference.pixelX : slopeReference.pixelY)
        : Number.NaN;
      return {
        referenceIndex,
        gradient: reference.gradient,
        offsetUm: reference.offsetUm,
        shiftPx: slopeDetectorCoordinate - flatDetectorCoordinate,
        shiftXpx: slopeReference ? slopeReference.pixelX - flat.pixelX : Number.NaN,
        shiftYpx: slopeReference ? slopeReference.pixelY - flat.pixelY : Number.NaN,
        targetXmm: slopeReference ? finite(slopeReference.targetXmm, flat.targetXmm) : Number.NaN,
        differential: slopeReference ? multiplyConjugate(
          { re: slopeReference.fieldRe, im: slopeReference.fieldIm },
          { re: flat.fieldRe, im: flat.fieldIm },
        ) : null,
      };
    }).filter((entry) => Number.isFinite(entry.gradient) && Number.isFinite(entry.shiftPx));
    const heightCalibrationCurve = heightByRay.map((reference, referenceIndex) => {
      const heightReference = reference.samples.get(`${lineIndex}:${spatialKey}`);
      const heightDetectorCoordinate = heightReference
        ? (profileAxis === 'x' ? heightReference.pixelX : heightReference.pixelY)
        : Number.NaN;
      return {
        referenceIndex,
        offsetUm: reference.offsetUm,
        shiftPx: heightDetectorCoordinate - flatDetectorCoordinate,
        shiftXpx: heightReference ? heightReference.pixelX - flat.pixelX : Number.NaN,
        shiftYpx: heightReference ? heightReference.pixelY - flat.pixelY : Number.NaN,
        differential: heightReference ? multiplyConjugate(
          { re: heightReference.fieldRe, im: heightReference.fieldIm },
          { re: flat.fieldRe, im: flat.fieldIm },
        ) : null,
      };
    }).filter((entry) => Number.isFinite(entry.offsetUm) && Number.isFinite(entry.shiftPx));
    const calibrationShiftPx = calibrationCurve[0]?.shiftPx ?? Number.NaN;
    const cameraShiftPx = detectorCoordinate - flatDetectorCoordinate;
    return {
      lineIndex,
      spatialKey,
      // Flat acquisition establishes the Target-coordinate calibration. The
      // unknown surface is never used to provide its own X mapping.
      targetXmm: finite(flat.targetXmm, finite(sample.targetXmm)),
      frequencyHz: 0.5 * (sample.frequencyHz + flat.frequencyHz),
      cameraShiftPx,
      cameraShiftXpx: sample.pixelX - flat.pixelX,
      cameraShiftYpx: sample.pixelY - flat.pixelY,
      calibrationShiftPx,
      calibrationCurve,
      heightCalibrationCurve,
      differential: multiplyConjugate(
        { re: sample.fieldRe, im: sample.fieldIm },
        { re: flat.fieldRe, im: flat.fieldIm },
      ),
    };
  }).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (!matched.length) return null;
  const coordinateBySpatialKey = new Map<string, { total: number; count: number }>();
  for (const entry of matched) {
    const coordinate = coordinateBySpatialKey.get(entry.spatialKey) ?? { total: 0, count: 0 };
    coordinate.total += entry.targetXmm;
    coordinate.count += 1;
    coordinateBySpatialKey.set(entry.spatialKey, coordinate);
  }
  const maximumPoints = Math.max(3, Math.round(finite(options.maximumProfilePoints, 512)));
  const selectedSpatialKeys = Array.from(coordinateBySpatialKey.entries())
    .map(([key, value]) => ({ key, xMm: value.total / value.count }))
    .sort((left, right) => left.xMm - right.xMm)
    .filter((_, index, entries) => entries.length <= maximumPoints || index % Math.ceil(entries.length / maximumPoints) === 0)
    .slice(0, maximumPoints);
  const xMm = selectedSpatialKeys.map((entry) => entry.xMm);
  const spatialIndex = new Map(selectedSpatialKeys.map((entry, index) => [entry.key, index]));
  const differentialByLineAndPosition = new Map<string, LineField>();
  const slopeByPosition = new Map<number, Array<{
    cameraShiftPx: number;
    cameraShiftXpx: number;
    cameraShiftYpx: number;
    calibrationShiftPx: number;
    calibrationCurve: Array<{
      referenceIndex: number;
      gradient: number;
      offsetUm: number;
      shiftPx: number;
      shiftXpx: number;
      shiftYpx: number;
      targetXmm: number;
      differential: Complex | null;
    }>;
    heightCalibrationCurve: Array<{
      referenceIndex: number;
      offsetUm: number;
      shiftPx: number;
      shiftXpx: number;
      shiftYpx: number;
      differential: Complex | null;
    }>;
  }>>();
  const slopeDifferentialByReference = slopeReferenceSets.map(() => new Map<string, LineField>());
  const heightDifferentialByReference = heightReferenceSets.map(() => new Map<string, LineField>());
  const addReferenceDifferential = (
    map: Map<string, LineField>,
    key: string,
    frequencyHz: number,
    differential: Complex | null,
  ) => {
    if (!differential) return;
    const aggregate = map.get(key) ?? {
      frequencyHz,
      field: { re: 0, im: 0 },
      sampleCount: 0,
    };
    addComplex(aggregate.field, differential.re, differential.im);
    aggregate.frequencyHz += (frequencyHz - aggregate.frequencyHz) / (aggregate.sampleCount + 1);
    aggregate.sampleCount += 1;
    map.set(key, aggregate);
  };
  for (const entry of matched) {
    const x = spatialIndex.get(entry.spatialKey);
    if (x === undefined) continue;
    const key = `${entry.lineIndex}:${x}`;
    const aggregate = differentialByLineAndPosition.get(key) ?? {
      frequencyHz: entry.frequencyHz,
      field: { re: 0, im: 0 },
      sampleCount: 0,
    };
    addComplex(aggregate.field, entry.differential.re, entry.differential.im);
    aggregate.frequencyHz += (entry.frequencyHz - aggregate.frequencyHz) / (aggregate.sampleCount + 1);
    aggregate.sampleCount += 1;
    differentialByLineAndPosition.set(key, aggregate);
    if (Number.isFinite(entry.cameraShiftPx) && Number.isFinite(entry.calibrationShiftPx)) {
      const slope = slopeByPosition.get(x) ?? [];
      slope.push({
        cameraShiftPx: entry.cameraShiftPx,
        cameraShiftXpx: entry.cameraShiftXpx,
        cameraShiftYpx: entry.cameraShiftYpx,
        calibrationShiftPx: entry.calibrationShiftPx,
        calibrationCurve: entry.calibrationCurve,
        heightCalibrationCurve: entry.heightCalibrationCurve,
      });
      slopeByPosition.set(x, slope);
    }
    for (const calibration of entry.calibrationCurve) {
      addReferenceDifferential(
        slopeDifferentialByReference[calibration.referenceIndex],
        key,
        entry.frequencyHz,
        calibration.differential,
      );
    }
    for (const calibration of entry.heightCalibrationCurve) {
      addReferenceDifferential(
        heightDifferentialByReference[calibration.referenceIndex],
        key,
        entry.frequencyHz,
        calibration.differential,
      );
    }
  }
  const lineIndices = Array.from(new Set(matched.map((entry) => entry.lineIndex))).sort((a, b) => a - b);
  const rawOpdMm = new Array<number>(xMm.length).fill(Number.NaN);
  const phaseFitRmsRad = new Array<number>(xMm.length).fill(Number.NaN);
  const validLineCount = new Array<number>(xMm.length).fill(0);
  for (let x = 0; x < xMm.length; x += 1) {
    const beatLines: Array<{ frequencyHz: number; phaseRad: number; weight: number }> = [];
    for (const lineIndex of lineIndices) {
      const differential = differentialByLineAndPosition.get(`${lineIndex}:${x}`);
      if (!differential) continue;
      const weight = Math.hypot(differential.field.re, differential.field.im);
      if (!(weight > 0)) continue;
      beatLines.push({
        frequencyHz: differential.frequencyHz,
        phaseRad: Math.atan2(differential.field.im, differential.field.re),
        weight,
      });
    }
    validLineCount[x] = beatLines.length;
    const fit = fitDelayFromBeatPhase(beatLines);
    if (!fit) continue;
    rawOpdMm[x] = fit.opdMm;
    phaseFitRmsRad[x] = fit.rmsRad;
  }
  const fitReferenceOpd = (fields: Map<string, LineField>): number[] => xMm.map((_, x) => {
    const beatLines: Array<{ frequencyHz: number; phaseRad: number; weight: number }> = [];
    for (const lineIndex of lineIndices) {
      const differential = fields.get(`${lineIndex}:${x}`);
      if (!differential) continue;
      const weight = Math.hypot(differential.field.re, differential.field.im);
      if (!(weight > 0)) continue;
      beatLines.push({
        frequencyHz: differential.frequencyHz,
        phaseRad: Math.atan2(differential.field.im, differential.field.re),
        weight,
      });
    }
    return fitDelayFromBeatPhase(beatLines)?.opdMm ?? Number.NaN;
  });
  const slopeReferenceOpdMm = slopeDifferentialByReference.map(fitReferenceOpd);
  const heightReferenceOpdMm = heightDifferentialByReference.map(fitReferenceOpd);

  const validColumns = rawOpdMm.map((value, index) => Number.isFinite(value) ? index : -1).filter((index) => index >= 0);
  const referenceColumn = validColumns[0] ?? 0;
  const referenceOpdMm = Number.isFinite(rawOpdMm[referenceColumn]) ? rawOpdMm[referenceColumn] : 0;
  const opticalPathDifferenceMm = interpolateMissing(rawOpdMm).map((value) => value - referenceOpdMm);
  const phaseRecoveredHeightUm = opticalPathDifferenceMm.map((value) => value * 500);
  const median = (values: number[]): number => {
    if (!values.length) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const center = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[center] : 0.5 * (sorted[center - 1] + sorted[center]);
  };
  const robustLocalQuadraticSmooth = (
    positions: number[],
    values: number[],
    requestedRadius?: number,
  ): number[] => {
    if (positions.length < 4 || positions.length !== values.length) return [...values];
    const positiveSpacings = positions.slice(1)
      .map((position, index) => position - positions[index])
      .filter((spacing) => Number.isFinite(spacing) && spacing > 1e-9);
    const spacing = median(positiveSpacings);
    const span = Math.max(1e-9, positions[positions.length - 1] - positions[0]);
    // About five measured profile points participate in each fit. Keep the
    // window tied only to the measured Camera sampling interval: a fraction of
    // the full profile span would erase short-period surfaces (for example a
    // 1 mm sine across a 50 mm target).
    const radius = Math.max(1e-6, finite(requestedRadius, Math.max(spacing * 2.5, span / 48)));
    const fitAt = (centerPosition: number, robustWeights?: number[]): number => {
      const augmented = Array.from({ length: 3 }, () => new Array<number>(4).fill(0));
      let usable = 0;
      let weightedTotal = 0;
      let weightedValue = 0;
      for (let index = 0; index < positions.length; index += 1) {
        const value = values[index];
        if (!Number.isFinite(value)) continue;
        const normalizedDistance = (positions[index] - centerPosition) / radius;
        const absoluteDistance = Math.abs(normalizedDistance);
        if (absoluteDistance >= 1) continue;
        const tricube = Math.pow(1 - Math.pow(absoluteDistance, 3), 3);
        const weight = tricube * (robustWeights?.[index] ?? 1);
        if (!(weight > 1e-12)) continue;
        const basis = [1, normalizedDistance, normalizedDistance * normalizedDistance];
        for (let row = 0; row < 3; row += 1) {
          for (let column = 0; column < 3; column += 1) {
            augmented[row][column] += weight * basis[row] * basis[column];
          }
          augmented[row][3] += weight * basis[row] * value;
        }
        weightedTotal += weight;
        weightedValue += weight * value;
        usable += 1;
      }
      if (usable < 3 || !(weightedTotal > 0)) return Number.NaN;
      for (let pivot = 0; pivot < 3; pivot += 1) {
        let best = pivot;
        for (let row = pivot + 1; row < 3; row += 1) {
          if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
        }
        if (Math.abs(augmented[best][pivot]) < 1e-12) return weightedValue / weightedTotal;
        [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
        const divisor = augmented[pivot][pivot];
        for (let column = pivot; column < 4; column += 1) augmented[pivot][column] /= divisor;
        for (let row = 0; row < 3; row += 1) {
          if (row === pivot) continue;
          const factor = augmented[row][pivot];
          for (let column = pivot; column < 4; column += 1) {
            augmented[row][column] -= factor * augmented[pivot][column];
          }
        }
      }
      return augmented[0][3];
    };
    const firstPass = positions.map((position, index) => {
      const fitted = fitAt(position);
      return Number.isFinite(fitted) ? fitted : values[index];
    });
    const residuals = values.map((value, index) => value - firstPass[index]);
    const residualCenter = median(residuals.filter(Number.isFinite));
    const residualMad = median(residuals.map((value) => Math.abs(value - residualCenter)).filter(Number.isFinite));
    if (!(residualMad > 1e-12)) return firstPass;
    const robustScale = 6 * 1.4826 * residualMad;
    const robustWeights = residuals.map((residual) => {
      const normalized = Math.abs(residual - residualCenter) / robustScale;
      return normalized < 1 ? Math.pow(1 - normalized * normalized, 2) : 0;
    });
    return positions.map((position, index) => {
      const fitted = fitAt(position, robustWeights);
      return Number.isFinite(fitted) ? fitted : firstPass[index];
    });
  };
  const calibrationGradient = finite(options.slopeReferenceGradient, Number.NaN);
  const globalCalibrationShift = median(matched
    .map((entry) => Math.abs(entry.calibrationShiftPx))
    .filter((value) => Number.isFinite(value) && value > 1e-7));
  const rawSlopeGradient = xMm.map((_, index) => {
    const pairs = slopeByPosition.get(index) ?? [];
    const interpolateCalibrationCurve = (
      shiftPx: number,
      curve: Array<{ gradient: number; shiftPx: number }>,
    ): number => {
      const points = [{ gradient: 0, shiftPx: 0 }, ...curve]
        .filter((entry) => Number.isFinite(entry.gradient) && Number.isFinite(entry.shiftPx))
        .sort((left, right) => left.shiftPx - right.shiftPx)
        .filter((entry, pointIndex, entries) => (
          pointIndex === 0 || Math.abs(entry.shiftPx - entries[pointIndex - 1].shiftPx) > 1e-7
        ));
      if (points.length < 2) return Number.NaN;
      // A Camera displacement outside the measured calibration envelope is
      // not evidence for an arbitrarily steeper surface. Clamp to the nearest
      // calibrated gradient instead of extrapolating numerical ray noise.
      if (shiftPx <= points[0].shiftPx) return points[0].gradient;
      if (shiftPx >= points[points.length - 1].shiftPx) return points[points.length - 1].gradient;
      let left = points[0];
      let right = points[1];
      if (shiftPx > points[0].shiftPx) {
        for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
          if (shiftPx <= points[pointIndex].shiftPx) {
            left = points[pointIndex - 1];
            right = points[pointIndex];
            break;
          }
        }
      }
      const span = right.shiftPx - left.shiftPx;
      return Math.abs(span) > 1e-9
        ? left.gradient + (shiftPx - left.shiftPx) / span * (right.gradient - left.gradient)
        : Number.NaN;
    };
    const calibratedGradients = slopeReferenceSets.length >= 2
      ? pairs
        .map((entry) => interpolateCalibrationCurve(entry.cameraShiftPx, entry.calibrationCurve))
        .filter(Number.isFinite)
      : [];
    if (calibratedGradients.length >= Math.max(3, Math.ceil(pairs.length * 0.2))) {
      const center = median(calibratedGradients);
      const mad = median(calibratedGradients.map((value) => Math.abs(value - center)));
      const tolerance = Math.max(1e-7, 6 * mad, Math.abs(center) * 0.2);
      const inliers = calibratedGradients.filter((value) => Math.abs(value - center) <= tolerance);
      return median(inliers.length ? inliers : calibratedGradients);
    }
    const medianCalibrationShift = median(pairs.map((entry) => Math.abs(entry.calibrationShiftPx)).filter(Number.isFinite));
    const minimumCalibrationShift = Math.max(
      1e-5,
      medianCalibrationShift * 0.05,
      Number.isFinite(globalCalibrationShift) ? globalCalibrationShift * 0.03 : 0,
    );
    const usable = pairs.filter((entry) => Math.abs(entry.calibrationShiftPx) >= minimumCalibrationShift);
    if (!usable.length || !Number.isFinite(calibrationGradient)) return Number.NaN;

    // Do not average per-ray divisions: a nearly stationary calibration ray
    // turns sub-pixel numerical noise into an arbitrarily large slope. First
    // reject ratio outliers, then solve cameraShift = scale * calibrationShift
    // for the whole wavelength group in one weighted least-squares step.
    const ratios = usable.map((entry) => entry.cameraShiftPx / entry.calibrationShiftPx);
    const ratioCenter = median(ratios);
    const ratioMad = median(ratios.map((value) => Math.abs(value - ratioCenter)));
    const ratioTolerance = Math.max(1e-6, 6 * ratioMad, Math.abs(ratioCenter) * 0.15);
    const inliers = usable.filter((_, pairIndex) => Math.abs(ratios[pairIndex] - ratioCenter) <= ratioTolerance);
    const selected = inliers.length >= Math.max(3, Math.ceil(usable.length * 0.25)) ? inliers : usable;
    let cross = 0;
    let square = 0;
    for (const entry of selected) {
      cross += entry.calibrationShiftPx * entry.cameraShiftPx;
      square += entry.calibrationShiftPx * entry.calibrationShiftPx;
    }
    return square > 1e-12 ? cross / square * calibrationGradient : ratioCenter * calibrationGradient;
  });
  const usableSlopePositionCount = rawSlopeGradient.filter(Number.isFinite).length;
  const slopeGradient = interpolateMissing(rawSlopeGradient);
  const meanCameraShiftPx = slopeByPosition.size
    ? median(Array.from(slopeByPosition.values()).map((entries) => (
      Math.abs(median(entries.map((entry) => entry.cameraShiftPx).filter(Number.isFinite)))
    )).filter(Number.isFinite))
    : 0;
  // Detector coordinates remain continuous until final image binning, so a
  // valid shallow tilt can move a traced ray by much less than 0.05 pixel.
  // Reject only numerical zero here; the observable selection below still
  // guards steps and flat surfaces by comparing slope and RF-OPD spans.
  const hasSlopeCalibration = usableSlopePositionCount >= Math.max(2, Math.ceil(xMm.length * 0.5))
    && meanCameraShiftPx > 1e-7
    && (slopeReferenceSets.length >= 2 || Number.isFinite(finite(options.slopeReferenceGradient, Number.NaN)));
  let slopeRecoveredHeightUm = new Array<number>(xMm.length).fill(0);
  for (let index = 1; index < xMm.length; index += 1) {
    const dxMm = xMm[index] - xMm[index - 1];
    slopeRecoveredHeightUm[index] = slopeRecoveredHeightUm[index - 1]
      + 0.5 * (slopeGradient[index - 1] + slopeGradient[index]) * dxMm * 1000;
  }
  const integratedReferenceHeightUm = slopeRecoveredHeightUm[referenceColumn] ?? 0;
  slopeRecoveredHeightUm = slopeRecoveredHeightUm.map((heightUm) => heightUm - integratedReferenceHeightUm);
  // Camera displacement alone cannot distinguish a local height offset from
  // a local surface slope. A pair of axially shifted flat acquisitions adds a
  // second, independent RF-phase observable. Solve the calibrated 2x2 Camera
  // response at every launched spatial sample; no Target height is consulted.
  const calibratedHeightMm = xMm.map((xPositionMm, index) => {
    if (heightReferenceSets.length < 2 || slopeReferenceSets.length < 2) return Number.NaN;
    const pairs = slopeByPosition.get(index) ?? [];
    if (!pairs.length) return Number.NaN;
    let heightSquare = 0;
    let shiftHeightCross = 0;
    let opdHeightCross = 0;
    for (let referenceIndex = 0; referenceIndex < heightReferenceSets.length; referenceIndex += 1) {
      const heightMm = heightReferenceSets[referenceIndex].offsetUm * 1e-3;
      const shiftPx = median(pairs.map((entry) => (
        entry.heightCalibrationCurve.find((calibration) => calibration.referenceIndex === referenceIndex)?.shiftPx
      )).filter(Number.isFinite));
      const opdMm = heightReferenceOpdMm[referenceIndex]?.[index];
      if (!Number.isFinite(shiftPx) || !Number.isFinite(opdMm) || Math.abs(heightMm) < 1e-12) continue;
      heightSquare += heightMm * heightMm;
      shiftHeightCross += heightMm * shiftPx;
      opdHeightCross += heightMm * opdMm;
    }
    if (!(heightSquare > 1e-12)) return Number.NaN;
    const shiftPerHeight = shiftHeightCross / heightSquare;
    const opdPerHeight = opdHeightCross / heightSquare;
    let shiftGradientSquare = 0;
    let opdGradientSquare = 0;
    let shiftGradientCross = 0;
    let opdGradientCross = 0;
    const minimumCalibrationGradient = slopeReferenceSets.reduce((minimum, reference) => {
      const magnitude = Math.abs(reference.gradient);
      return magnitude > 1e-12 ? Math.min(minimum, magnitude) : minimum;
    }, Number.POSITIVE_INFINITY);
    for (let referenceIndex = 0; referenceIndex < slopeReferenceSets.length; referenceIndex += 1) {
      const gradient = slopeReferenceSets[referenceIndex].gradient;
      if (!Number.isFinite(gradient) || Math.abs(gradient) < 1e-12) continue;
      const shiftPx = median(pairs.map((entry) => (
        entry.calibrationCurve.find((calibration) => calibration.referenceIndex === referenceIndex)?.shiftPx
      )).filter(Number.isFinite));
      const opdMm = slopeReferenceOpdMm[referenceIndex]?.[index];
      if (!Number.isFinite(shiftPx) || !Number.isFinite(opdMm)) continue;
      const referenceHeightMm = slopeReferenceSets[referenceIndex].offsetUm * 1e-3
        + gradient * median(pairs.map((entry) => (
          entry.calibrationCurve.find((calibration) => calibration.referenceIndex === referenceIndex)?.targetXmm
        )).filter(Number.isFinite));
      shiftGradientSquare += gradient * gradient;
      shiftGradientCross += gradient * (shiftPx - shiftPerHeight * referenceHeightMm);
      // RF group delay aliases first on the steep calibration planes. Use the
      // nearest symmetric micro-tilt pair for the local phase derivative while
      // retaining the full range for the Camera-position derivative.
      if (Math.abs(gradient) <= minimumCalibrationGradient * 1.05) {
        opdGradientSquare += gradient * gradient;
        opdGradientCross += gradient * (opdMm - opdPerHeight * referenceHeightMm);
      }
    }
    if (!(shiftGradientSquare > 1e-12) || !(opdGradientSquare > 1e-12)) return Number.NaN;
    const shiftPerGradient = shiftGradientCross / shiftGradientSquare;
    const opdPerGradient = opdGradientCross / opdGradientSquare;
    const determinant = shiftPerHeight * opdPerGradient - shiftPerGradient * opdPerHeight;
    const cameraShiftPx = median(pairs.map((entry) => entry.cameraShiftPx).filter(Number.isFinite));
    const currentOpdMm = rawOpdMm[index];
    const responseScale = Math.max(
      1e-12,
      Math.abs(shiftPerHeight * opdPerGradient),
      Math.abs(shiftPerGradient * opdPerHeight),
    );
    if (!Number.isFinite(cameraShiftPx) || !Number.isFinite(currentOpdMm)
      || Math.abs(determinant) < responseScale * 1e-6) return Number.NaN;
    return (cameraShiftPx * opdPerGradient - shiftPerGradient * currentOpdMm) / determinant;
  });
  const solveLocalHeight = (
    nodes: Array<{ shiftXpx: number; shiftYpx: number; opdMm: number; heightMm: number }>,
    currentShiftXpx: number,
    currentShiftYpx: number,
    currentOpdMm: number,
  ): number => {
    if (nodes.length < 5 || !Number.isFinite(currentShiftXpx)
      || !Number.isFinite(currentShiftYpx) || !Number.isFinite(currentOpdMm)) return Number.NaN;
    const shiftXValues = nodes.map((node) => node.shiftXpx);
    const shiftYValues = nodes.map((node) => node.shiftYpx);
    const opdValues = nodes.map((node) => node.opdMm);
    const shiftXScale = Math.max(1e-9, Math.max(...shiftXValues) - Math.min(...shiftXValues));
    const shiftYScale = Math.max(1e-9, Math.max(...shiftYValues) - Math.min(...shiftYValues));
    const opdScale = Math.max(1e-9, Math.max(...opdValues) - Math.min(...opdValues));
    const nearest = nodes.map((node) => {
      const shiftX = (node.shiftXpx - currentShiftXpx) / shiftXScale;
      const shiftY = (node.shiftYpx - currentShiftYpx) / shiftYScale;
      const opd = (node.opdMm - currentOpdMm) / opdScale;
      return { ...node, shiftX, shiftY, opd, distanceSquared: shiftX * shiftX + shiftY * shiftY + opd * opd };
    }).sort((left, right) => left.distanceSquared - right.distanceSquared).slice(0, Math.min(10, nodes.length));
    const basisSize = 4;
    const augmented = Array.from({ length: basisSize }, () => new Array<number>(basisSize + 1).fill(0));
    for (const node of nearest) {
      const weight = 1 / (0.01 + node.distanceSquared);
      const basis = [1, node.shiftX, node.shiftY, node.opd];
      for (let row = 0; row < basisSize; row += 1) {
        for (let column = 0; column < basisSize; column += 1) {
          augmented[row][column] += weight * basis[row] * basis[column];
        }
        augmented[row][basisSize] += weight * basis[row] * node.heightMm;
      }
    }
    for (let pivot = 0; pivot < basisSize; pivot += 1) {
      let best = pivot;
      for (let row = pivot + 1; row < basisSize; row += 1) {
        if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
      }
      if (Math.abs(augmented[best][pivot]) < 1e-12) return Number.NaN;
      [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
      const divisor = augmented[pivot][pivot];
      for (let column = pivot; column <= basisSize; column += 1) augmented[pivot][column] /= divisor;
      for (let row = 0; row < basisSize; row += 1) {
        if (row === pivot) continue;
        const factor = augmented[row][pivot];
        for (let column = pivot; column <= basisSize; column += 1) {
          augmented[row][column] -= factor * augmented[pivot][column];
        }
      }
    }
    return augmented[0][basisSize];
  };
  const locallyCalibratedHeightMm = xMm.map((xPositionMm, index) => {
    const pairs = slopeByPosition.get(index) ?? [];
    if (!pairs.length) return Number.NaN;
    const nodes: Array<{ shiftXpx: number; shiftYpx: number; opdMm: number; heightMm: number }> = [{ shiftXpx: 0, shiftYpx: 0, opdMm: 0, heightMm: 0 }];
    for (let referenceIndex = 0; referenceIndex < heightReferenceSets.length; referenceIndex += 1) {
      const shiftXpx = median(pairs.map((entry) => (
        entry.heightCalibrationCurve.find((calibration) => calibration.referenceIndex === referenceIndex)?.shiftXpx
      )).filter(Number.isFinite));
      const shiftYpx = median(pairs.map((entry) => (
        entry.heightCalibrationCurve.find((calibration) => calibration.referenceIndex === referenceIndex)?.shiftYpx
      )).filter(Number.isFinite));
      const opdMm = heightReferenceOpdMm[referenceIndex]?.[index];
      if (Number.isFinite(shiftXpx) && Number.isFinite(shiftYpx) && Number.isFinite(opdMm)) {
        nodes.push({ shiftXpx, shiftYpx, opdMm, heightMm: heightReferenceSets[referenceIndex].offsetUm * 1e-3 });
      }
    }
    for (let referenceIndex = 0; referenceIndex < slopeReferenceSets.length; referenceIndex += 1) {
      const shiftXpx = median(pairs.map((entry) => (
        entry.calibrationCurve.find((calibration) => calibration.referenceIndex === referenceIndex)?.shiftXpx
      )).filter(Number.isFinite));
      const shiftYpx = median(pairs.map((entry) => (
        entry.calibrationCurve.find((calibration) => calibration.referenceIndex === referenceIndex)?.shiftYpx
      )).filter(Number.isFinite));
      const opdMm = slopeReferenceOpdMm[referenceIndex]?.[index];
      if (Number.isFinite(shiftXpx) && Number.isFinite(shiftYpx) && Number.isFinite(opdMm)) {
        const reference = slopeReferenceSets[referenceIndex];
        const referenceTargetXmm = median(pairs.map((entry) => (
          entry.calibrationCurve.find((calibration) => calibration.referenceIndex === referenceIndex)?.targetXmm
        )).filter(Number.isFinite));
        nodes.push({
          shiftXpx,
          shiftYpx,
          opdMm,
          heightMm: reference.offsetUm * 1e-3 + reference.gradient * referenceTargetXmm,
        });
      }
    }
    const cameraShiftXpx = median(pairs.map((entry) => entry.cameraShiftXpx).filter(Number.isFinite));
    const cameraShiftYpx = median(pairs.map((entry) => entry.cameraShiftYpx).filter(Number.isFinite));
    return solveLocalHeight(nodes, cameraShiftXpx, cameraShiftYpx, rawOpdMm[index]);
  });
  const localCalibrationCount = locallyCalibratedHeightMm.filter(Number.isFinite).length;
  const activeCalibratedHeightMm = localCalibrationCount >= Math.max(2, Math.ceil(xMm.length * 0.5))
    ? locallyCalibratedHeightMm
    : calibratedHeightMm;
  const validCalibratedHeights = activeCalibratedHeightMm.filter(Number.isFinite).length;
  const calibratedHeightAvailable = validCalibratedHeights >= Math.max(2, Math.ceil(xMm.length * 0.5));
  if (calibratedHeightAvailable) {
    const interpolatedHeightMm = interpolateMissing(activeCalibratedHeightMm);
    const robustHeightMm = xMm.length <= 128
      ? robustLocalQuadraticSmooth(xMm, interpolatedHeightMm)
      : (() => {
        const positiveSpacings = xMm.slice(1)
          .map((x, index) => x - xMm[index])
          .filter((spacing) => spacing > 1e-9);
        const spacing = median(positiveSpacings);
        const medianRadiusMm = Math.max(1e-6, spacing * 2.5);
        const medianFiltered = interpolatedHeightMm.map((heightMm, index) => {
          const neighbors: number[] = [];
          for (let neighbor = index; neighbor >= 0 && xMm[index] - xMm[neighbor] <= medianRadiusMm; neighbor -= 1) {
            neighbors.push(interpolatedHeightMm[neighbor]);
          }
          for (let neighbor = index + 1; neighbor < xMm.length && xMm[neighbor] - xMm[index] <= medianRadiusMm; neighbor += 1) {
            neighbors.push(interpolatedHeightMm[neighbor]);
          }
          return neighbors.length >= 3 ? median(neighbors) : heightMm;
        });
        return robustLocalQuadraticSmooth(xMm, medianFiltered, Math.max(1e-6, spacing * 2.75));
      })();
    const referenceHeightMm = robustHeightMm[referenceColumn] ?? 0;
    slopeRecoveredHeightUm = robustHeightMm.map((heightMm) => (heightMm - referenceHeightMm) * 1000);
  }
  const peakToValley = (values: number[]): number => (
    values.length ? Math.max(...values) - Math.min(...values) : 0
  );
  // A discontinuous Step produces a strong RF-OPD jump and only a small
  // camera-position artifact. A continuously sloped surface does the reverse.
  // Select from the two independent Camera observables without consulting the
  // configured comparison Target.
  const slopeCandidatePeakToValleyUm = peakToValley(slopeRecoveredHeightUm);
  const phaseCandidatePeakToValleyUm = peakToValley(phaseRecoveredHeightUm);
  const slopeCalibrationApplied = hasSlopeCalibration && (
    calibratedHeightAvailable
      ? slopeCandidatePeakToValleyUm > 0.05
      : slopeReferenceSets.length >= 2
      ? slopeCandidatePeakToValleyUm > Math.max(0.05, phaseCandidatePeakToValleyUm * 0.05)
      : slopeCandidatePeakToValleyUm > phaseCandidatePeakToValleyUm * 1.25
  );
  const recoveredHeightUm = slopeCalibrationApplied ? slopeRecoveredHeightUm : phaseRecoveredHeightUm;
  const referenceXmm = xMm[referenceColumn] ?? 0;
  const comparisonReferenceHeightUm = options.comparisonTarget
    ? sampleTargetHeightUm(options.comparisonTarget, referenceXmm)
    : 0;
  const targetHeightUm = options.comparisonTarget
    ? xMm.map((x) => sampleTargetHeightUm(options.comparisonTarget!, x) - comparisonReferenceHeightUm)
    : new Array<number>(xMm.length).fill(Number.NaN);
  const errors = recoveredHeightUm.map((value, index) => value - targetHeightUm[index]).filter(Number.isFinite);
  const validFits = phaseFitRmsRad.filter(Number.isFinite);
  const loByLine = new Map<number, number>();
  for (const sample of currentSamples) {
    if (sample.routeId === options.localOscillatorRouteId) loByLine.set(Math.round(finite(sample.lineIndex)), sample.frequencyHz);
  }
  const maximumBeatFrequencyHz = currentMeasurement.reduce((maximum, sample) => Math.max(
    maximum,
    Math.abs(sample.frequencyHz - finite(loByLine.get(Math.round(finite(sample.lineIndex))), sample.frequencyHz)),
  ), 0);
  const exposureTimeS = Math.max(0, finite(options.exposureTimeS));
  const timeIntegratedCamera = maximumBeatFrequencyHz > 0 && exposureTimeS * maximumBeatFrequencyHz > 0.25;
  const meanLineCount = validColumns.length
    ? validColumns.reduce((sum, index) => sum + validLineCount[index], 0) / validColumns.length
    : 0;
  const targetRangeMm = xMm.length > 1 ? Math.max(0, xMm[xMm.length - 1] - xMm[0]) : 0;
  const targetCoverageFraction = Math.min(1, targetRangeMm / Math.max(1e-12, Math.abs(finite(options.targetSpanMm))));
  const warningMessages: string[] = [];
  if (!beamsOverlap) warningMessages.push('Probe measurement, Probe reference and LO beams do not overlap on the Camera. No per-pixel dual-comb RF interference exists; align their Camera centroids in Render before reconstruction.');
  if (validColumns.length < 2) warningMessages.push('Flat-referenced dual-comb recovery needs RF phase on at least two Target profile samples.');
  if (meanLineCount < 3) warningMessages.push('Fewer than three matched comb lines are available per Target-X sample; OPD phase slope cannot be fitted reliably.');
  if (timeIntegratedCamera) warningMessages.push(`The configured exposure integrates over the RF beats (up to ${(maximumBeatFrequencyHz / 1e6).toFixed(6)} MHz). A single Camera frame loses their phase; use ≥${(2 * maximumBeatFrequencyHz / 1e6).toFixed(3)} Mfps or per-pixel lock-in I/Q.`);
  if ((options.comparisonTarget?.kind === 'tilt' || options.comparisonTarget?.kind === 'sine') && !slopeCalibrationApplied) warningMessages.push('This continuously sloped surface needs a known micro-tilt Camera calibration before its return-beam displacement can be converted to quantitative height.');
  if (targetCoverageFraction < 0.8) warningMessages.push(`Illuminated Camera samples cover ${targetRangeMm.toFixed(3)} mm (${(targetCoverageFraction * 100).toFixed(1)}%) of the configured Target profile span.`);

  return {
    width: xMm.length,
    profileAxis,
    xMm,
    recoveredHeightUm,
    targetHeightUm,
    opticalPathDifferenceMm,
    phaseFitRmsRad,
    validLineCount,
    coverageFraction: validColumns.length / Math.max(1, xMm.length),
    targetRangeMm,
    targetCoverageFraction,
    meanPhaseFitRmsRad: validFits.length ? validFits.reduce((sum, value) => sum + value, 0) / validFits.length : Number.NaN,
    meanLineCount,
    referenceColumn,
    referenceXmm,
    maximumBeatFrequencyHz,
    requiredFrameRateHz: 2 * maximumBeatFrequencyHz,
    timeIntegratedCamera,
    flatReferenceApplied: true,
    slopeCalibrationApplied,
    slopeCalibrationAvailable: hasSlopeCalibration,
    slopeCandidatePeakToValleyUm,
    phaseCandidatePeakToValleyUm,
    slopeCalibrationReferenceCount: slopeReferenceSets.length,
    heightCalibrationReferenceCount: heightReferenceSets.length,
    reconstructionMethod: slopeCalibrationApplied ? 'camera-slope' : 'rf-opd',
    meanCameraShiftPx,
    rmsHeightErrorUm: errors.length ? Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length) : Number.NaN,
    maxAbsHeightErrorUm: errors.length ? errors.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0) : Number.NaN,
    warningMessages,
  };
}

/**
 * Recovers a relative surface profile from per-pixel dual-comb RF phasors.
 * Probe/reference target settings never participate in the inversion. A real
 * Camera must supply a time sequence (or lock-in I/Q per pixel); a single
 * exposure contains only the time-integrated intensity and cannot retain this
 * RF phase.
 */
export function reconstructDualCombSurfaceFromCamera(
  options: DualCombCameraReconstructionOptions,
): DualCombCameraReconstructionResult {
  const detectorWidth = Math.max(1, Math.round(finite(options.detectorWidth, 1)));
  const detectorHeight = Math.max(1, Math.round(finite(options.detectorHeight, 1)));
  const samples = Array.from(options.spectralFields).filter((sample) => (
    Number.isFinite(sample.pixelX)
    && Number.isFinite(sample.pixelY)
    && sample.pixelX >= 0
    && sample.pixelX < detectorWidth
    && sample.pixelY >= 0
    && sample.pixelY < detectorHeight
    && Number.isFinite(sample.frequencyHz)
    && sample.frequencyHz > 0
    && Number.isFinite(sample.fieldRe)
    && Number.isFinite(sample.fieldIm)
    && Number.isFinite(sample.lineIndex)
  ));
  const routeSamples = samples.filter((sample) => (
    sample.routeId === options.measurementRouteId
    || sample.routeId === options.referenceRouteId
    || sample.routeId === options.localOscillatorRouteId
  ));
  const measurementSamples = routeSamples.filter((sample) => sample.routeId === options.measurementRouteId);
  const measurementSpanX = measurementSamples.length
    ? Math.max(...measurementSamples.map((sample) => sample.pixelX)) - Math.min(...measurementSamples.map((sample) => sample.pixelX))
    : 0;
  const measurementSpanY = measurementSamples.length
    ? Math.max(...measurementSamples.map((sample) => sample.pixelY)) - Math.min(...measurementSamples.map((sample) => sample.pixelY))
    : 0;
  const targetMappedSamples = measurementSamples.filter((sample) => Number.isFinite(sample.targetXmm));
  const correlationWithTarget = (axis: 'x' | 'y'): number => {
    if (targetMappedSamples.length < 3) return Number.NaN;
    const targetMean = targetMappedSamples.reduce((sum, sample) => sum + finite(sample.targetXmm), 0)
      / targetMappedSamples.length;
    const detectorMean = targetMappedSamples.reduce((sum, sample) => (
      sum + finite(axis === 'x' ? sample.pixelX : sample.pixelY)
    ), 0) / targetMappedSamples.length;
    let covariance = 0;
    let targetVariance = 0;
    let detectorVariance = 0;
    for (const sample of targetMappedSamples) {
      const targetOffset = finite(sample.targetXmm) - targetMean;
      const detectorOffset = finite(axis === 'x' ? sample.pixelX : sample.pixelY) - detectorMean;
      covariance += targetOffset * detectorOffset;
      targetVariance += targetOffset * targetOffset;
      detectorVariance += detectorOffset * detectorOffset;
    }
    return covariance / Math.sqrt(Math.max(Number.MIN_VALUE, targetVariance * detectorVariance));
  };
  const targetCorrelationX = Math.abs(correlationWithTarget('x'));
  const targetCorrelationY = Math.abs(correlationWithTarget('y'));
  // A dispersed interferogram can span most of the Camera in Y even when the
  // Target profile maps to X. Prefer the measured Target-coordinate
  // correlation and use beam extent only when no Target coordinates exist.
  const profileAxis: 'x' | 'y' = Number.isFinite(targetCorrelationX) && Number.isFinite(targetCorrelationY)
    ? (targetCorrelationY > targetCorrelationX ? 'y' : 'x')
    : (measurementSpanY > measurementSpanX ? 'y' : 'x');
  const profilePixelCount = profileAxis === 'x' ? detectorWidth : detectorHeight;
  const routeBounds = [options.measurementRouteId, options.referenceRouteId, options.localOscillatorRouteId]
    .map((routeId) => {
      const fields = routeSamples.filter((sample) => sample.routeId === routeId);
      return fields.length ? {
        routeId,
        minimumX: Math.min(...fields.map((sample) => sample.pixelX)),
        maximumX: Math.max(...fields.map((sample) => sample.pixelX)),
        minimumY: Math.min(...fields.map((sample) => sample.pixelY)),
        maximumY: Math.max(...fields.map((sample) => sample.pixelY)),
      } : null;
    });
  const beamsOverlap = routeBounds.every(Boolean) && (
    Math.min(...routeBounds.map((bounds) => bounds!.maximumX)) >= Math.max(...routeBounds.map((bounds) => bounds!.minimumX))
    && Math.min(...routeBounds.map((bounds) => bounds!.maximumY)) >= Math.max(...routeBounds.map((bounds) => bounds!.minimumY))
  );
  if (options.flatReferenceSpectralFields?.length) {
    const flatSamples = Array.from(options.flatReferenceSpectralFields).filter((sample) => (
      Number.isFinite(sample.frequencyHz)
      && sample.frequencyHz > 0
      && Number.isFinite(sample.fieldRe)
      && Number.isFinite(sample.fieldIm)
      && Number.isFinite(sample.lineIndex)
      && Number.isFinite(sample.targetXmm)
    ));
    const calibrated = reconstructFromFlatCameraMeasurement(
      options,
      routeSamples,
      flatSamples,
      profileAxis,
      beamsOverlap,
    );
    if (calibrated) return calibrated;
  }
  const distinctLines = new Set(routeSamples.map((sample) => Math.round(finite(sample.lineIndex)))).size;
  const sampleLimitedWidth = distinctLines > 0
    ? Math.max(3, Math.floor(measurementSamples.length / distinctLines))
    : 3;
  const width = Math.max(1, Math.min(
    profilePixelCount,
    Math.max(3, Math.round(finite(options.maximumProfilePoints, 512))),
    sampleLimitedWidth,
  ));
  const targetSpanMm = Math.max(1e-9, finite(options.targetSpanMm, detectorWidth));
  const xMm = Array.from({ length: width }, (_, index) => (index / Math.max(1, width - 1) - 0.5) * targetSpanMm);

  const aggregate = new Map<string, LineField>();
  for (const sample of routeSamples) {
    const sourceCoordinate = Math.max(0, Math.min(
      profilePixelCount - 1,
      Math.floor(profileAxis === 'x' ? sample.pixelX : sample.pixelY),
    ));
    const x = Math.max(0, Math.min(width - 1, Math.floor((sourceCoordinate + 0.5) * width / profilePixelCount)));
    const lineIndex = Math.round(finite(sample.lineIndex));
    const key = `${sample.routeId}:${lineIndex}:${x}`;
    const entry = aggregate.get(key) ?? {
      frequencyHz: sample.frequencyHz,
      field: { re: 0, im: 0 },
      sampleCount: 0,
    };
    addComplex(entry.field, sample.fieldRe, sample.fieldIm);
    entry.frequencyHz += (sample.frequencyHz - entry.frequencyHz) / (entry.sampleCount + 1);
    entry.sampleCount += 1;
    aggregate.set(key, entry);
  }

  const rawOpdMm = new Array<number>(width).fill(Number.NaN);
  const phaseFitRmsRad = new Array<number>(width).fill(Number.NaN);
  const validLineCount = new Array<number>(width).fill(0);
  let maximumBeatFrequencyHz = 0;
  for (let x = 0; x < width; x += 1) {
    const beatLines: Array<{ frequencyHz: number; phaseRad: number; weight: number }> = [];
    for (let lineIndex = 0; lineIndex < distinctLines; lineIndex += 1) {
      const measurement = aggregate.get(`${options.measurementRouteId}:${lineIndex}:${x}`);
      const reference = aggregate.get(`${options.referenceRouteId}:${lineIndex}:${x}`);
      const localOscillator = aggregate.get(`${options.localOscillatorRouteId}:${lineIndex}:${x}`);
      if (!measurement || !reference || !localOscillator) continue;
      const measurementBeat = multiplyConjugate(measurement.field, localOscillator.field);
      const referenceBeat = multiplyConjugate(reference.field, localOscillator.field);
      const differentialBeat = multiply(measurementBeat, { re: referenceBeat.re, im: -referenceBeat.im });
      const weight = Math.hypot(differentialBeat.re, differentialBeat.im);
      if (!(weight > 0)) continue;
      beatLines.push({
        frequencyHz: 0.5 * (measurement.frequencyHz + reference.frequencyHz),
        phaseRad: Math.atan2(differentialBeat.im, differentialBeat.re),
        weight,
      });
      maximumBeatFrequencyHz = Math.max(
        maximumBeatFrequencyHz,
        Math.abs(measurement.frequencyHz - localOscillator.frequencyHz),
        Math.abs(reference.frequencyHz - localOscillator.frequencyHz),
      );
    }
    validLineCount[x] = beatLines.length;
    const fit = fitDelayFromBeatPhase(beatLines);
    if (!fit) continue;
    rawOpdMm[x] = fit.opdMm;
    phaseFitRmsRad[x] = fit.rmsRad;
  }

  const validColumns = rawOpdMm.map((value, index) => Number.isFinite(value) ? index : -1).filter((index) => index >= 0);
  const referenceColumn = validColumns[0] ?? 0;
  const referenceOpdMm = Number.isFinite(rawOpdMm[referenceColumn]) ? rawOpdMm[referenceColumn] : 0;
  let opticalPathDifferenceMm = interpolateMissing(rawOpdMm).map((value) => value - referenceOpdMm);
  let flatReferenceApplied = false;
  if (options.flatReferenceSpectralFields?.length) {
    const flatReference = reconstructDualCombSurfaceFromCamera({
      ...options,
      spectralFields: options.flatReferenceSpectralFields,
      flatReferenceSpectralFields: undefined,
      comparisonTarget: undefined,
      exposureTimeS: 0,
    });
    if (flatReference.profileAxis === profileAxis && flatReference.opticalPathDifferenceMm.length > 0) {
      const sampleFlatOpd = (index: number): number => {
        if (width <= 1 || flatReference.opticalPathDifferenceMm.length <= 1) {
          return finite(flatReference.opticalPathDifferenceMm[0]);
        }
        const source = index / (width - 1) * (flatReference.opticalPathDifferenceMm.length - 1);
        const left = Math.floor(source);
        const right = Math.min(flatReference.opticalPathDifferenceMm.length - 1, left + 1);
        const fraction = source - left;
        return finite(flatReference.opticalPathDifferenceMm[left]) * (1 - fraction)
          + finite(flatReference.opticalPathDifferenceMm[right]) * fraction;
      };
      opticalPathDifferenceMm = opticalPathDifferenceMm.map((value, index) => value - sampleFlatOpd(index));
      flatReferenceApplied = true;
    }
  }
  const recoveredHeightUm = opticalPathDifferenceMm.map((opdMm) => opdMm * 500);
  const referenceXmm = xMm[referenceColumn] ?? 0;
  const comparisonReferenceHeightUm = options.comparisonTarget
    ? sampleTargetHeightUm(options.comparisonTarget, referenceXmm)
    : 0;
  const targetHeightUm = options.comparisonTarget
    ? xMm.map((x) => sampleTargetHeightUm(options.comparisonTarget!, x) - comparisonReferenceHeightUm)
    : new Array<number>(width).fill(Number.NaN);
  const errors = recoveredHeightUm.map((value, index) => value - targetHeightUm[index]).filter(Number.isFinite);
  const rmsHeightErrorUm = errors.length
    ? Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length)
    : Number.NaN;
  const maxAbsHeightErrorUm = errors.length
    ? errors.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0)
    : Number.NaN;
  const validPhaseFits = phaseFitRmsRad.filter(Number.isFinite);
  const meanPhaseFitRmsRad = validPhaseFits.length
    ? validPhaseFits.reduce((sum, value) => sum + value, 0) / validPhaseFits.length
    : Number.NaN;
  const meanLineCount = validColumns.length
    ? validColumns.reduce((sum, index) => sum + validLineCount[index], 0) / validColumns.length
    : 0;
  const exposureTimeS = Math.max(0, finite(options.exposureTimeS));
  const timeIntegratedCamera = maximumBeatFrequencyHz > 0 && exposureTimeS * maximumBeatFrequencyHz > 0.25;
  const targetRangeMm = xMm.length > 1 ? Math.max(0, xMm[xMm.length - 1] - xMm[0]) : 0;
  const targetCoverageFraction = Math.min(1, targetRangeMm / Math.max(1e-12, Math.abs(finite(options.targetSpanMm))));
  const warningMessages: string[] = [];
  if (!routeSamples.length) warningMessages.push('No routed dual-comb Camera fields reached this Detector.');
  for (const [routeId, bounds] of [options.measurementRouteId, options.referenceRouteId, options.localOscillatorRouteId]
    .map((routeId, index) => [routeId, routeBounds[index]] as const)) {
    if (!bounds) warningMessages.push(`Route ${routeId} has no complex Camera field.`);
  }
  if (routeBounds.every(Boolean) && !beamsOverlap) warningMessages.push('Probe measurement, Probe reference and LO beams do not overlap on the Camera. No per-pixel dual-comb RF interference exists; align their Camera centroids in Render before reconstruction.');
  if (validColumns.length < 2) warningMessages.push(`Dual-comb phase recovery needs Probe measurement, Probe reference and LO fields on at least two Camera-${profileAxis.toUpperCase()} positions.`);
  if (meanLineCount < 3) warningMessages.push('Fewer than three matched comb lines are available per Camera-X position; OPD phase slope cannot be fitted reliably.');
  if (timeIntegratedCamera) warningMessages.push(`The configured exposure integrates over the RF beats (up to ${(maximumBeatFrequencyHz / 1e6).toFixed(6)} MHz). A single Camera frame loses their phase; use ≥${(2 * maximumBeatFrequencyHz / 1e6).toFixed(3)} Mfps or per-pixel lock-in I/Q.`);
  if (validColumns.length && validColumns.length < width * 0.8) warningMessages.push(`Dual-comb RF phase covers only ${(validColumns.length / width * 100).toFixed(1)}% of Camera-${profileAxis.toUpperCase()} bins.`);
  if (!flatReferenceApplied) warningMessages.push('No flat Camera RF reference was applied. Fixed lens, grating and route phase remains in the recovered profile.');
  if (targetCoverageFraction < 0.8) warningMessages.push(`Illuminated Camera samples cover ${targetRangeMm.toFixed(3)} mm (${(targetCoverageFraction * 100).toFixed(1)}%) of the configured Target profile span.`);

  return {
    width,
    profileAxis,
    xMm,
    recoveredHeightUm,
    targetHeightUm,
    opticalPathDifferenceMm,
    phaseFitRmsRad,
    validLineCount,
    coverageFraction: validColumns.length / Math.max(1, width),
    targetRangeMm,
    targetCoverageFraction,
    meanPhaseFitRmsRad,
    meanLineCount,
    referenceColumn,
    referenceXmm,
    maximumBeatFrequencyHz,
    requiredFrameRateHz: 2 * maximumBeatFrequencyHz,
    timeIntegratedCamera,
    flatReferenceApplied,
    slopeCalibrationApplied: false,
    reconstructionMethod: 'rf-opd',
    meanCameraShiftPx: 0,
    rmsHeightErrorUm,
    maxAbsHeightErrorUm,
    warningMessages,
  };
}
