import type { CoherentDetectorSpec } from './coherent-assembly.ts';

const PLANCK_J_S = 6.62607015e-34;
const LIGHT_M_S = 299792458;

export interface SpectralPsfPlane {
  wavelengthUm: number;
  weight: number;
  psfData: number[][];
  pixelSizeUm: number;
}

export interface ImagingDetectorSignal {
  kind: 'area';
  width: number;
  height: number;
  powerWPerPixel: Float64Array;
  electronsPerPixel: Float64Array;
  aduPerPixel: Uint32Array;
  integratedPowerW: number;
  maximumPowerWPerPixel: number;
  maximumElectronsPerPixel: number;
  capturedFraction: number;
  saturatedPixelCount: number;
  bitDepth: number;
  exposureTimeS: number;
}

export interface CoherentDetectorFieldSample {
  pixelX: number;
  pixelY: number;
  coherenceGroupId: string;
  frequencyHz: number;
  wavelengthNm: number;
  fieldRe: number;
  fieldIm: number;
}

export interface CoherentPsfPlane extends SpectralPsfPlane {
  fieldReal?: number[][];
  fieldImag?: number[][];
}

export interface CoherentFieldDetectorSignal {
  signal: ImagingDetectorSignal;
  spectralModeCount: number;
  inputFieldPowerW: number;
  complexKernelCount: number;
  warning: string;
}

const finite = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(maximum, value));

function quantumEfficiency(detector: CoherentDetectorSpec, wavelengthNm: number): number {
  const samples = Array.isArray(detector.quantumEfficiency)
    ? detector.quantumEfficiency.filter((sample) => Number.isFinite(sample?.wavelengthNm) && Number.isFinite(sample?.value)).sort((a, b) => a.wavelengthNm - b.wavelengthNm)
    : [];
  if (!samples.length) return clamp(finite((detector as any).quantumEfficiencyValue, finite(detector.responsivity, 1)), 0, 1);
  if (wavelengthNm <= samples[0].wavelengthNm) return clamp(samples[0].value, 0, 1);
  if (wavelengthNm >= samples[samples.length - 1].wavelengthNm) return clamp(samples[samples.length - 1].value, 0, 1);
  for (let index = 1; index < samples.length; index += 1) {
    const right = samples[index];
    const left = samples[index - 1];
    if (wavelengthNm > right.wavelengthNm) continue;
    const t = (wavelengthNm - left.wavelengthNm) / Math.max(1e-30, right.wavelengthNm - left.wavelengthNm);
    return clamp(left.value + (right.value - left.value) * t, 0, 1);
  }
  return 1;
}

function sumPositive(grid: number[][]): number {
  let sum = 0;
  for (const row of grid) for (const value of row) if (Number.isFinite(value) && value > 0) sum += value;
  return sum;
}

/**
 * Deposits a square PSF sample into every detector pixel it geometrically
 * overlaps. This conserves energy while allowing PSF and detector pitches to
 * differ by arbitrary, non-integer ratios.
 */
function depositSample(
  target: Float64Array,
  width: number,
  height: number,
  detectorPitchUm: number,
  centerXUm: number,
  centerYUm: number,
  samplePitchUm: number,
  energyFraction: number,
): number {
  const sensorMinX = -width * detectorPitchUm / 2;
  const sensorMinY = -height * detectorPitchUm / 2;
  const left = centerXUm - samplePitchUm / 2;
  const right = centerXUm + samplePitchUm / 2;
  const top = centerYUm - samplePitchUm / 2;
  const bottom = centerYUm + samplePitchUm / 2;
  const startX = Math.max(0, Math.floor((left - sensorMinX) / detectorPitchUm));
  const endX = Math.min(width - 1, Math.floor((right - sensorMinX - 1e-12) / detectorPitchUm));
  const startY = Math.max(0, Math.floor((top - sensorMinY) / detectorPitchUm));
  const endY = Math.min(height - 1, Math.floor((bottom - sensorMinY - 1e-12) / detectorPitchUm));
  if (endX < startX || endY < startY) return 0;
  const sampleArea = samplePitchUm * samplePitchUm;
  let deposited = 0;
  for (let y = startY; y <= endY; y += 1) {
    const pixelTop = sensorMinY + y * detectorPitchUm;
    const overlapY = Math.max(0, Math.min(bottom, pixelTop + detectorPitchUm) - Math.max(top, pixelTop));
    if (!(overlapY > 0)) continue;
    for (let x = startX; x <= endX; x += 1) {
      const pixelLeft = sensorMinX + x * detectorPitchUm;
      const overlapX = Math.max(0, Math.min(right, pixelLeft + detectorPitchUm) - Math.max(left, pixelLeft));
      if (!(overlapX > 0)) continue;
      const portion = energyFraction * overlapX * overlapY / sampleArea;
      target[y * width + x] += portion;
      deposited += portion;
    }
  }
  return deposited;
}

export function calculateImagingDetectorSignal(options: {
  spectralPsf: SpectralPsfPlane[];
  detector: CoherentDetectorSpec;
  totalPowerW: number;
  opticalThroughput?: number;
}): ImagingDetectorSignal {
  const detector = options.detector;
  const width = Math.max(1, Math.round(finite(detector.pixelCountX, 1)));
  const height = Math.max(1, Math.round(finite(detector.pixelCountY, 1)));
  const pitchUm = Math.max(1e-9, finite(detector.pixelPitchUm, 1));
  const fillFactor = clamp(finite(detector.fillFactor, 1), 0, 1);
  const exposureTimeS = Math.max(0, finite(detector.exposureTimeS, 0));
  const throughput = clamp(finite(options.opticalThroughput, 1), 0, 1);
  const inputPowerW = Math.max(0, finite(options.totalPowerW, 0)) * throughput;
  const planes = options.spectralPsf.filter((plane) => Array.isArray(plane.psfData) && plane.psfData.length > 0 && finite(plane.weight) > 0);
  const weightSum = planes.reduce((sum, plane) => sum + finite(plane.weight), 0) || 1;
  const powerWPerPixel = new Float64Array(width * height);
  const electronsPerPixel = new Float64Array(width * height);
  let capturedFraction = 0;

  for (const plane of planes) {
    const planeSum = sumPositive(plane.psfData);
    if (!(planeSum > 0)) continue;
    const spectralWeight = finite(plane.weight) / weightSum;
    const sourcePitchUm = Math.max(1e-9, finite(plane.pixelSizeUm, 1));
    const sourceHeight = plane.psfData.length;
    const sourceWidth = Math.max(0, ...plane.psfData.map((row) => row.length));
    const sourceCenterX = (sourceWidth - 1) / 2;
    const sourceCenterY = (sourceHeight - 1) / 2;
    const fractions = new Float64Array(width * height);
    let planeCaptured = 0;
    for (let sy = 0; sy < sourceHeight; sy += 1) {
      const row = plane.psfData[sy] ?? [];
      for (let sx = 0; sx < row.length; sx += 1) {
        const value = finite(row[sx]);
        if (!(value > 0)) continue;
        const energyFraction = value / planeSum;
        planeCaptured += depositSample(
          fractions, width, height, pitchUm,
          (sx - sourceCenterX) * sourcePitchUm,
          (sy - sourceCenterY) * sourcePitchUm,
          sourcePitchUm, energyFraction,
        );
      }
    }
    const wavelengthM = Math.max(1e-12, finite(plane.wavelengthUm, 0.5875618) * 1e-6);
    const photonEnergyJ = PLANCK_J_S * LIGHT_M_S / wavelengthM;
    const qe = quantumEfficiency(detector, wavelengthM * 1e9);
    const planePowerW = inputPowerW * spectralWeight * fillFactor;
    for (let index = 0; index < fractions.length; index += 1) {
      const pixelPowerW = planePowerW * fractions[index];
      powerWPerPixel[index] += pixelPowerW;
      electronsPerPixel[index] += photonEnergyJ > 0 ? pixelPowerW * exposureTimeS / photonEnergyJ * qe : 0;
    }
    capturedFraction += spectralWeight * planeCaptured * fillFactor;
  }

  const bitDepth = Math.max(1, Math.min(30, Math.round(finite(detector.bitDepth, 16))));
  const maximumAdu = 2 ** bitDepth - 1;
  const fullWell = Math.max(1, finite(detector.saturationElectrons, Number.POSITIVE_INFINITY));
  const aduPerPixel = new Uint32Array(width * height);
  let integratedPowerW = 0;
  let maximumPowerWPerPixel = 0;
  let maximumElectronsPerPixel = 0;
  let saturatedPixelCount = 0;
  for (let index = 0; index < powerWPerPixel.length; index += 1) {
    const power = powerWPerPixel[index];
    const electrons = electronsPerPixel[index];
    integratedPowerW += power;
    maximumPowerWPerPixel = Math.max(maximumPowerWPerPixel, power);
    maximumElectronsPerPixel = Math.max(maximumElectronsPerPixel, electrons);
    if (electrons >= fullWell) saturatedPixelCount += 1;
    const normalized = Number.isFinite(fullWell) ? clamp(electrons / fullWell, 0, 1) : 0;
    aduPerPixel[index] = Math.round(normalized * maximumAdu);
  }
  return {
    kind: 'area', width, height, powerWPerPixel, electronsPerPixel, aduPerPixel,
    integratedPowerW, maximumPowerWPerPixel, maximumElectronsPerPixel,
    capturedFraction, saturatedPixelCount, bitDepth, exposureTimeS,
  };
}
export function calculateDetectorSignalFromPowerMap(options: {
  powerWPerPixel: ArrayLike<number>;
  width: number;
  height: number;
  detector: CoherentDetectorSpec;
  wavelengthNm: number;
  inputPowerW?: number;
}): ImagingDetectorSignal {
  const width = Math.max(1, Math.round(finite(options.width, 1)));
  const height = Math.max(1, Math.round(finite(options.height, 1)));
  const count = width * height;
  const powerWPerPixel = new Float64Array(count);
  const electronsPerPixel = new Float64Array(count);
  const exposureTimeS = Math.max(0, finite(options.detector.exposureTimeS, 0));
  const wavelengthM = Math.max(1e-12, finite(options.wavelengthNm, 587.5618) * 1e-9);
  const photonEnergyJ = PLANCK_J_S * LIGHT_M_S / wavelengthM;
  const qe = quantumEfficiency(options.detector, wavelengthM * 1e9);
  for (let index = 0; index < count; index += 1) {
    const power = Math.max(0, finite(options.powerWPerPixel[index]));
    powerWPerPixel[index] = power;
    electronsPerPixel[index] = photonEnergyJ > 0 ? power * exposureTimeS / photonEnergyJ * qe : 0;
  }
  const bitDepth = Math.max(1, Math.min(30, Math.round(finite(options.detector.bitDepth, 16))));
  const maximumAdu = 2 ** bitDepth - 1;
  const fullWell = Math.max(1, finite(options.detector.saturationElectrons, Number.POSITIVE_INFINITY));
  const aduPerPixel = new Uint32Array(count);
  let integratedPowerW = 0;
  let maximumPowerWPerPixel = 0;
  let maximumElectronsPerPixel = 0;
  let saturatedPixelCount = 0;
  for (let index = 0; index < count; index += 1) {
    const power = powerWPerPixel[index];
    const electrons = electronsPerPixel[index];
    integratedPowerW += power;
    maximumPowerWPerPixel = Math.max(maximumPowerWPerPixel, power);
    maximumElectronsPerPixel = Math.max(maximumElectronsPerPixel, electrons);
    if (electrons >= fullWell) saturatedPixelCount += 1;
    const normalized = Number.isFinite(fullWell) ? clamp(electrons / fullWell, 0, 1) : 0;
    aduPerPixel[index] = Math.round(normalized * maximumAdu);
  }
  const inputPowerW = Math.max(0, finite(options.inputPowerW, integratedPowerW));
  return {
    kind: 'area', width, height, powerWPerPixel, electronsPerPixel, aduPerPixel,
    integratedPowerW, maximumPowerWPerPixel, maximumElectronsPerPixel,
    capturedFraction: inputPowerW > 0 ? clamp(integratedPowerW / inputPowerW, 0, 1) : 0,
    saturatedPixelCount, bitDepth, exposureTimeS,
  };
}

/**
 * Applies the exact sequential PSF to a physical-path detector irradiance map.
 * The sparse kernel is expressed in detector-pixel offsets, so PSF and sensor
 * pitches may differ. Energy is conserved except for light blurred outside the
 * finite detector area.
 */
export function convolveDetectorPowerWithPsf(options: {
  powerWPerPixel: ArrayLike<number>;
  width: number;
  height: number;
  detector: CoherentDetectorSpec;
  psfData: number[][];
  psfPixelSizeUm: number;
  wavelengthNm: number;
}): ImagingDetectorSignal {
  const width = Math.max(1, Math.round(finite(options.width, 1)));
  const height = Math.max(1, Math.round(finite(options.height, 1)));
  const detectorPitchUm = Math.max(1e-9, finite(options.detector.pixelPitchUm, 1));
  const psfPitchUm = Math.max(1e-9, finite(options.psfPixelSizeUm, detectorPitchUm));
  const rows = Array.isArray(options.psfData) ? options.psfData : [];
  const psfHeight = rows.length;
  const psfWidth = rows.reduce((maximum, row) => Math.max(maximum, Array.isArray(row) ? row.length : 0), 0);
  const centerX = (psfWidth - 1) / 2;
  const centerY = (psfHeight - 1) / 2;
  const offsetWeights = new Map<string, { dx: number; dy: number; weight: number }>();
  let maximumWeight = 0;
  for (const row of rows) for (const value of row) maximumWeight = Math.max(maximumWeight, Math.max(0, finite(value)));
  const threshold = maximumWeight * 1e-7;
  for (let y = 0; y < psfHeight; y += 1) {
    const row = rows[y] ?? [];
    for (let x = 0; x < row.length; x += 1) {
      const weight = Math.max(0, finite(row[x]));
      if (!(weight > threshold)) continue;
      const dx = Math.round((x - centerX) * psfPitchUm / detectorPitchUm);
      const dy = Math.round((y - centerY) * psfPitchUm / detectorPitchUm);
      const key = `${dx}:${dy}`;
      const existing = offsetWeights.get(key);
      if (existing) existing.weight += weight;
      else offsetWeights.set(key, { dx, dy, weight });
    }
  }
  let kernel = Array.from(offsetWeights.values()).sort((a, b) => b.weight - a.weight).slice(0, 4096);
  const kernelSum = kernel.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(kernelSum > 0)) kernel = [{ dx: 0, dy: 0, weight: 1 }];
  else kernel = kernel.map((entry) => ({ ...entry, weight: entry.weight / kernelSum }));

  const output = new Float64Array(width * height);
  let inputPowerW = 0;
  for (let index = 0; index < width * height; index += 1) {
    const power = Math.max(0, finite(options.powerWPerPixel[index]));
    if (!(power > 0)) continue;
    inputPowerW += power;
    const sourceX = index % width;
    const sourceY = Math.floor(index / width);
    for (const entry of kernel) {
      const x = sourceX + entry.dx;
      const y = sourceY + entry.dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      output[y * width + x] += power * entry.weight;
    }
  }
  return calculateDetectorSignalFromPowerMap({
    powerWPerPixel: output, width, height, detector: options.detector,
    wavelengthNm: options.wavelengthNm, inputPowerW,
  });
}

type ComplexKernelTap = { dx: number; dy: number; re: number; im: number; power: number };

function buildComplexDetectorKernel(
  plane: CoherentPsfPlane,
  detectorPitchUm: number,
  maximumTaps = 1024,
): ComplexKernelTap[] {
  const real = Array.isArray(plane.fieldReal) ? plane.fieldReal : [];
  const imag = Array.isArray(plane.fieldImag) ? plane.fieldImag : [];
  const height = Math.min(real.length, imag.length);
  const rowWidths = real.slice(0, height)
    .map((row, index) => Math.min(row?.length ?? 0, imag[index]?.length ?? 0));
  const width = rowWidths.length ? Math.min(...rowWidths) : 0;
  if (!(height > 0 && width > 0)) return [];
  const sourcePitchUm = Math.max(1e-9, finite(plane.pixelSizeUm, detectorPitchUm));
  const centerX = (width - 1) / 2;
  const centerY = (height - 1) / 2;
  let maximumPower = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const re = finite(real[y]?.[x]);
      const im = finite(imag[y]?.[x]);
      maximumPower = Math.max(maximumPower, re * re + im * im);
    }
  }
  if (!(maximumPower > 0)) return [];
  const threshold = maximumPower * 1e-9;
  const aggregated = new Map<string, ComplexKernelTap>();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const re = finite(real[y]?.[x]);
      const im = finite(imag[y]?.[x]);
      const power = re * re + im * im;
      if (!(power > threshold)) continue;
      const dx = Math.round((x - centerX) * sourcePitchUm / detectorPitchUm);
      const dy = Math.round((y - centerY) * sourcePitchUm / detectorPitchUm);
      const key = `${dx}:${dy}`;
      const previous = aggregated.get(key);
      if (previous) {
        previous.re += re;
        previous.im += im;
        previous.power = previous.re * previous.re + previous.im * previous.im;
      } else {
        aggregated.set(key, { dx, dy, re, im, power });
      }
    }
  }
  const taps = Array.from(aggregated.values())
    .map((tap) => ({ ...tap, power: tap.re * tap.re + tap.im * tap.im }))
    .filter((tap) => tap.power > 0)
    .sort((left, right) => right.power - left.power)
    .slice(0, Math.max(1, maximumTaps));
  const energy = taps.reduce((sum, tap) => sum + tap.power, 0);
  if (!(energy > 0)) return [];
  const normalization = Math.sqrt(energy);
  return taps.map((tap) => ({
    ...tap,
    re: tap.re / normalization,
    im: tap.im / normalization,
    power: tap.power / energy,
  }));
}

/**
 * Propagates physical-path complex detector fields through the exact-lens
 * coherent impulse response before square-law detection. Fields interfere only
 * when both their optical frequency and coherence group match.
 */
export function convolveDetectorFieldsWithCoherentPsf(options: {
  spectralFields: CoherentDetectorFieldSample[];
  width: number;
  height: number;
  detector: CoherentDetectorSpec;
  spectralPsf: CoherentPsfPlane[];
}): CoherentFieldDetectorSignal | null {
  const width = Math.max(1, Math.round(finite(options.width, 1)));
  const height = Math.max(1, Math.round(finite(options.height, 1)));
  const detectorPitchUm = Math.max(1e-9, finite(options.detector.pixelPitchUm, 1));
  const planes = options.spectralPsf.filter((plane) => (
    Array.isArray(plane.fieldReal) && plane.fieldReal.length > 0
    && Array.isArray(plane.fieldImag) && plane.fieldImag.length > 0
  ));
  const samples = options.spectralFields.filter((sample) => (
    Number.isFinite(sample.pixelX) && Number.isFinite(sample.pixelY)
    && Number.isFinite(sample.frequencyHz) && sample.frequencyHz > 0
    && Number.isFinite(sample.wavelengthNm) && sample.wavelengthNm > 0
    && Number.isFinite(sample.fieldRe) && Number.isFinite(sample.fieldIm)
  ));
  if (!planes.length || !samples.length) return null;

  const kernelCache = new Map<number, ComplexKernelTap[]>();
  const nearestPlaneIndex = (wavelengthNm: number): number => {
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    planes.forEach((plane, index) => {
      const candidate = Math.abs(finite(plane.wavelengthUm) * 1000 - wavelengthNm);
      if (candidate < distance) { best = index; distance = candidate; }
    });
    return best;
  };
  const kernelFor = (index: number): ComplexKernelTap[] => {
    const cached = kernelCache.get(index);
    if (cached) return cached;
    const kernel = buildComplexDetectorKernel(planes[index], detectorPitchUm);
    kernelCache.set(index, kernel);
    return kernel;
  };

  type Mode = { wavelengthNm: number; field: Map<number, { re: number; im: number }> };
  const modes = new Map<string, Mode>();
  let inputFieldPowerW = 0;
  for (const sample of samples) {
    const sourceX = Math.round(sample.pixelX);
    const sourceY = Math.round(sample.pixelY);
    if (sourceX < 0 || sourceX >= width || sourceY < 0 || sourceY >= height) continue;
    const kernel = kernelFor(nearestPlaneIndex(sample.wavelengthNm));
    if (!kernel.length) continue;
    inputFieldPowerW += sample.fieldRe * sample.fieldRe + sample.fieldIm * sample.fieldIm;
    const modeKey = `${sample.coherenceGroupId || 'source'}:${sample.frequencyHz.toPrecision(15)}`;
    const mode = modes.get(modeKey) ?? { wavelengthNm: sample.wavelengthNm, field: new Map() };
    modes.set(modeKey, mode);
    for (const tap of kernel) {
      const x = sourceX + tap.dx;
      const y = sourceY + tap.dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const index = y * width + x;
      const previous = mode.field.get(index) ?? { re: 0, im: 0 };
      previous.re += sample.fieldRe * tap.re - sample.fieldIm * tap.im;
      previous.im += sample.fieldRe * tap.im + sample.fieldIm * tap.re;
      mode.field.set(index, previous);
    }
  }
  if (!modes.size) return null;

  const powerWPerPixel = new Float64Array(width * height);
  const electronsPerPixel = new Float64Array(width * height);
  const exposureTimeS = Math.max(0, finite(options.detector.exposureTimeS, 0));
  for (const mode of modes.values()) {
    const wavelengthM = mode.wavelengthNm * 1e-9;
    const photonEnergyJ = PLANCK_J_S * LIGHT_M_S / Math.max(1e-30, wavelengthM);
    const qe = quantumEfficiency(options.detector, mode.wavelengthNm);
    for (const [index, field] of mode.field) {
      const power = field.re * field.re + field.im * field.im;
      powerWPerPixel[index] += power;
      electronsPerPixel[index] += power * exposureTimeS / photonEnergyJ * qe;
    }
  }

  const bitDepth = Math.max(1, Math.min(30, Math.round(finite(options.detector.bitDepth, 16))));
  const maximumAdu = 2 ** bitDepth - 1;
  const fullWell = Math.max(1, finite(options.detector.saturationElectrons, Number.POSITIVE_INFINITY));
  const aduPerPixel = new Uint32Array(width * height);
  let integratedPowerW = 0;
  let maximumPowerWPerPixel = 0;
  let maximumElectronsPerPixel = 0;
  let saturatedPixelCount = 0;
  for (let index = 0; index < powerWPerPixel.length; index += 1) {
    const power = powerWPerPixel[index];
    const electrons = electronsPerPixel[index];
    integratedPowerW += power;
    maximumPowerWPerPixel = Math.max(maximumPowerWPerPixel, power);
    maximumElectronsPerPixel = Math.max(maximumElectronsPerPixel, electrons);
    if (electrons >= fullWell) saturatedPixelCount += 1;
    aduPerPixel[index] = Math.round(clamp(electrons / fullWell, 0, 1) * maximumAdu);
  }
  return {
    signal: {
      kind: 'area', width, height, powerWPerPixel, electronsPerPixel, aduPerPixel,
      integratedPowerW, maximumPowerWPerPixel, maximumElectronsPerPixel,
      capturedFraction: inputFieldPowerW > 0 ? clamp(integratedPowerW / inputFieldPowerW, 0, 1) : 0,
      saturatedPixelCount, bitDepth, exposureTimeS,
    },
    spectralModeCount: modes.size,
    inputFieldPowerW,
    complexKernelCount: kernelCache.size,
    warning: planes.length < new Set(samples.map((sample) => sample.wavelengthNm.toPrecision(12))).size
      ? `Exact-lens complex fields were sampled at ${planes.length} wavelength${planes.length === 1 ? '' : 's'} and matched to the nearest physical spectral line.`
      : '',
  };
}
