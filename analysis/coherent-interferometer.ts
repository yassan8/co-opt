export const SPEED_OF_LIGHT_M_PER_S = 299_792_458;

const TWO_PI = Math.PI * 2;

export interface BeamSplitterSpec {
  model?: 'ideal' | 'plate' | 'cube' | 'pellicle';
  /** Common-port reflection exits through this lateral port. */
  reflectionPort?: 'reflect' | 'recombine';
  reflectance: number;
  transmittance: number;
  reflectedPhaseDeg?: number;
  transmittedPhaseDeg?: number;
  substrateMaterial?: string;
  substrateIndexNd?: number;
  substrateAbbeNumber?: number;
  substrateThicknessMm?: number;
  wedgeDeg?: number;
  backSurfaceReflectance?: number;
}

export interface BeamSplitterPort {
  power: number;
  amplitude: number;
  phaseRad: number;
}

export interface BeamSplitterResponse {
  reflected: BeamSplitterPort;
  transmitted: BeamSplitterPort;
  loss: number;
}

export interface ReflectionGratingSpec {
  wavelengthNm: number;
  grooveDensityLinesPerMm: number;
  incidenceAngleDeg: number;
  order: number;
  efficiency?: number;
}

export interface ReflectionGratingResult {
  propagating: boolean;
  diffractionAngleDeg: number | null;
  angularDispersionDegPerNm: number | null;
  efficiency: number;
  argument: number;
}

export interface CombSpec {
  centerWavelengthNm: number;
  repetitionRateGHz: number;
  offsetFrequencyMHz?: number;
  lineCount: number;
  bandwidthNm: number;
}

export interface CombLine {
  mode: number;
  frequencyHz: number;
  wavelengthNm: number;
  power: number;
  amplitude: number;
}

export interface DualCombBeatNote {
  mode: number;
  frequencyHz: number;
  amplitude: number;
  phaseRad: number;
  signalWavelengthNm: number;
}

export interface DualCombSimulationInput {
  signal: CombSpec;
  localOscillator: CombSpec;
  opticalPathDifferenceMm: number;
  beamSplitter: BeamSplitterSpec;
  visibility: number;
  relativePhaseDeg?: number;
  durationUs: number;
  sampleCount: number;
}

export interface DualCombSimulationResult {
  signalLines: CombLine[];
  localOscillatorLines: CombLine[];
  beatNotes: DualCombBeatNote[];
  timeUs: number[];
  detectorSignal: number[];
  dcLevel: number;
  interferogramPeriodUs: number | null;
  peakTimeUs: number;
  nyquistFrequencyMHz: number;
  maxBeatFrequencyMHz: number;
  aliased: boolean;
}

export interface BroadbandSimulationInput {
  centerWavelengthNm: number;
  bandwidthNm: number;
  sampleCount: number;
  opticalPathDifferenceMm: number;
  beamSplitter: BeamSplitterSpec;
  visibility: number;
  relativePhaseDeg?: number;
  grating: Omit<ReflectionGratingSpec, 'wavelengthNm'>;
}

export interface BroadbandSimulationResult {
  wavelengthNm: number[];
  sourcePower: number[];
  detectorPower: number[];
  diffractionAngleDeg: Array<number | null>;
  propagatingFraction: number;
  integratedDetectorPower: number;
}

function finiteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function inRange(value: number, min: number, max: number, label: string): number {
  finiteNumber(value, label);
  if (value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return value;
}

function degToRad(value: number): number {
  return value * Math.PI / 180;
}

function radToDeg(value: number): number {
  return value * 180 / Math.PI;
}

function wrapPhase(value: number): number {
  const wrapped = value % TWO_PI;
  return wrapped < -Math.PI ? wrapped + TWO_PI : wrapped > Math.PI ? wrapped - TWO_PI : wrapped;
}

function normalizeOddCount(value: number, min: number, max: number): number {
  let count = Math.max(min, Math.min(max, Math.round(Number(value) || min)));
  if (count % 2 === 0) count += count < max ? 1 : -1;
  return count;
}

export function evaluateBeamSplitter(spec: BeamSplitterSpec): BeamSplitterResponse {
  const reflectance = inRange(spec.reflectance, 0, 1, 'Beam-splitter reflectance');
  const transmittance = inRange(spec.transmittance, 0, 1, 'Beam-splitter transmittance');
  if (reflectance + transmittance > 1 + 1e-12) {
    throw new Error('Beam-splitter reflectance + transmittance cannot exceed 1.');
  }

  return {
    reflected: {
      power: reflectance,
      amplitude: Math.sqrt(reflectance),
      phaseRad: degToRad(finiteNumber(spec.reflectedPhaseDeg ?? 90, 'Reflected phase')),
    },
    transmitted: {
      power: transmittance,
      amplitude: Math.sqrt(transmittance),
      phaseRad: degToRad(finiteNumber(spec.transmittedPhaseDeg ?? 0, 'Transmitted phase')),
    },
    loss: Math.max(0, 1 - reflectance - transmittance),
  };
}

/**
 * Plane reflection-grating convention used by the Newport/Richardson handbook:
 * d (sin(alpha) + sin(beta)) = m lambda. Angles are measured from the grating
 * normal, so zero order gives beta = -alpha.
 */
export function evaluateReflectionGrating(spec: ReflectionGratingSpec): ReflectionGratingResult {
  const wavelengthNm = finiteNumber(spec.wavelengthNm, 'Wavelength');
  const grooveDensity = finiteNumber(spec.grooveDensityLinesPerMm, 'Groove density');
  const incidenceAngleDeg = finiteNumber(spec.incidenceAngleDeg, 'Incidence angle');
  const order = Math.trunc(finiteNumber(spec.order, 'Diffraction order'));
  const efficiency = inRange(spec.efficiency ?? 1, 0, 1, 'Grating efficiency');
  if (wavelengthNm <= 0) throw new Error('Wavelength must be positive.');
  if (grooveDensity <= 0) throw new Error('Groove density must be positive.');
  if (Math.abs(incidenceAngleDeg) >= 90) throw new Error('Incidence angle must be inside (-90, 90) degrees.');

  const spacingMm = 1 / grooveDensity;
  const wavelengthMm = wavelengthNm * 1e-6;
  const argument = order * wavelengthMm / spacingMm - Math.sin(degToRad(incidenceAngleDeg));
  if (Math.abs(argument) > 1) {
    return {
      propagating: false,
      diffractionAngleDeg: null,
      angularDispersionDegPerNm: null,
      efficiency: 0,
      argument,
    };
  }

  const beta = Math.asin(argument);
  const dispersionRadPerNm = order * 1e-6 / (spacingMm * Math.max(1e-15, Math.cos(beta)));
  return {
    propagating: true,
    diffractionAngleDeg: radToDeg(beta),
    angularDispersionDegPerNm: radToDeg(dispersionRadPerNm),
    efficiency,
    argument,
  };
}

export function generateCombLines(spec: CombSpec): CombLine[] {
  const centerWavelengthNm = finiteNumber(spec.centerWavelengthNm, 'Comb center wavelength');
  const repetitionRateGHz = finiteNumber(spec.repetitionRateGHz, 'Comb repetition rate');
  const bandwidthNm = finiteNumber(spec.bandwidthNm, 'Comb bandwidth');
  const offsetFrequencyMHz = finiteNumber(spec.offsetFrequencyMHz ?? 0, 'Comb offset frequency');
  if (centerWavelengthNm <= 0) throw new Error('Comb center wavelength must be positive.');
  if (repetitionRateGHz <= 0) throw new Error('Comb repetition rate must be positive.');
  if (bandwidthNm <= 0) throw new Error('Comb bandwidth must be positive.');

  const lineCount = normalizeOddCount(spec.lineCount, 3, 401);
  const half = Math.floor(lineCount / 2);
  const centerFrequencyHz = SPEED_OF_LIGHT_M_PER_S / (centerWavelengthNm * 1e-9);
  const repetitionRateHz = repetitionRateGHz * 1e9;
  const offsetFrequencyHz = offsetFrequencyMHz * 1e6;
  const bandwidthFrequencyHz = SPEED_OF_LIGHT_M_PER_S * (bandwidthNm * 1e-9) / Math.pow(centerWavelengthNm * 1e-9, 2);
  const raw: Array<Omit<CombLine, 'amplitude'>> = [];

  for (let mode = -half; mode <= half; mode += 1) {
    const frequencyHz = centerFrequencyHz + offsetFrequencyHz + mode * repetitionRateHz;
    if (!(frequencyHz > 0)) continue;
    const deltaFrequency = frequencyHz - (centerFrequencyHz + offsetFrequencyHz);
    const power = Math.exp(-4 * Math.log(2) * Math.pow(deltaFrequency / bandwidthFrequencyHz, 2));
    raw.push({
      mode,
      frequencyHz,
      wavelengthNm: SPEED_OF_LIGHT_M_PER_S / frequencyHz * 1e9,
      power,
    });
  }

  const sumPower = raw.reduce((sum, line) => sum + line.power, 0);
  return raw.map((line) => {
    const power = sumPower > 0 ? line.power / sumPower : 1 / Math.max(1, raw.length);
    return { ...line, power, amplitude: Math.sqrt(power) };
  });
}

export function buildDualCombBeatNotes(
  signalLines: CombLine[],
  localOscillatorLines: CombLine[],
  opticalPathDifferenceMm: number,
  phaseOffsetRad = 0,
): DualCombBeatNote[] {
  const delaySeconds = finiteNumber(opticalPathDifferenceMm, 'Optical path difference') * 1e-3 / SPEED_OF_LIGHT_M_PER_S;
  const localByMode = new Map(localOscillatorLines.map((line) => [line.mode, line]));
  const notes: DualCombBeatNote[] = [];

  for (const signalLine of signalLines) {
    const localLine = localByMode.get(signalLine.mode);
    if (!localLine) continue;
    notes.push({
      mode: signalLine.mode,
      frequencyHz: signalLine.frequencyHz - localLine.frequencyHz,
      amplitude: 2 * signalLine.amplitude * localLine.amplitude,
      phaseRad: wrapPhase(TWO_PI * signalLine.frequencyHz * delaySeconds + phaseOffsetRad),
      signalWavelengthNm: signalLine.wavelengthNm,
    });
  }

  return notes;
}

export function simulateDualComb(input: DualCombSimulationInput): DualCombSimulationResult {
  const beamSplitter = evaluateBeamSplitter(input.beamSplitter);
  const visibility = inRange(input.visibility, 0, 1, 'Visibility');
  const durationUs = finiteNumber(input.durationUs, 'Acquisition duration');
  if (durationUs <= 0) throw new Error('Acquisition duration must be positive.');
  const sampleCount = Math.max(64, Math.min(16_384, Math.round(input.sampleCount)));
  const signalLines = generateCombLines(input.signal);
  const localOscillatorLines = generateCombLines(input.localOscillator);
  const beatNotes = buildDualCombBeatNotes(signalLines, localOscillatorLines, input.opticalPathDifferenceMm, degToRad(input.relativePhaseDeg ?? 0));
  const armAmplitude = beamSplitter.reflected.amplitude * beamSplitter.transmitted.amplitude;
  const dcLevel = 2 * armAmplitude * armAmplitude;
  const durationSeconds = durationUs * 1e-6;
  const timeUs = new Array<number>(sampleCount);
  const detectorSignal = new Array<number>(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const timeSeconds = sampleCount > 1 ? durationSeconds * index / (sampleCount - 1) : 0;
    let interference = 0;
    for (const note of beatNotes) {
      interference += note.amplitude * Math.cos(TWO_PI * note.frequencyHz * timeSeconds + note.phaseRad);
    }
    timeUs[index] = timeSeconds * 1e6;
    detectorSignal[index] = dcLevel + visibility * armAmplitude * armAmplitude * interference;
  }

  let peakIndex = 0;
  for (let index = 1; index < detectorSignal.length; index += 1) {
    if (detectorSignal[index] > detectorSignal[peakIndex]) peakIndex = index;
  }

  const repetitionDeltaHz = Math.abs(input.signal.repetitionRateGHz - input.localOscillator.repetitionRateGHz) * 1e9;
  const sampleRateHz = sampleCount > 1 ? (sampleCount - 1) / durationSeconds : 0;
  const maxBeatFrequencyHz = beatNotes.reduce((max, note) => Math.max(max, Math.abs(note.frequencyHz)), 0);
  return {
    signalLines,
    localOscillatorLines,
    beatNotes,
    timeUs,
    detectorSignal,
    dcLevel,
    interferogramPeriodUs: repetitionDeltaHz > 0 ? 1e6 / repetitionDeltaHz : null,
    peakTimeUs: timeUs[peakIndex] ?? 0,
    nyquistFrequencyMHz: sampleRateHz / 2e6,
    maxBeatFrequencyMHz: maxBeatFrequencyHz / 1e6,
    aliased: maxBeatFrequencyHz > sampleRateHz / 2,
  };
}

export function fabryPerotFreeSpectralRangeGHz(cavityLengthMm: number, refractiveIndex = 1): number {
  const lengthMm = finiteNumber(cavityLengthMm, 'Cavity length');
  const index = finiteNumber(refractiveIndex, 'Cavity refractive index');
  if (lengthMm <= 0) throw new Error('Cavity length must be positive.');
  if (index <= 0) throw new Error('Cavity refractive index must be positive.');
  return SPEED_OF_LIGHT_M_PER_S / (2 * index * lengthMm * 1e-3) / 1e9;
}

export function generateGaussianSpectrum(centerWavelengthNm: number, bandwidthNm: number, sampleCount: number) {
  const center = finiteNumber(centerWavelengthNm, 'Center wavelength');
  const bandwidth = finiteNumber(bandwidthNm, 'Bandwidth');
  if (center <= 0 || bandwidth <= 0) throw new Error('Center wavelength and bandwidth must be positive.');
  const count = Math.max(17, Math.min(2049, Math.round(sampleCount)));
  const sigma = bandwidth / (2 * Math.sqrt(2 * Math.log(2)));
  const span = Math.min(center * 1.8, bandwidth * 2.5);
  const start = Math.max(1e-6, center - span / 2);
  const end = center + span / 2;
  const wavelengthNm: number[] = [];
  const rawPower: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const wavelength = start + (end - start) * index / (count - 1);
    wavelengthNm.push(wavelength);
    rawPower.push(Math.exp(-0.5 * Math.pow((wavelength - center) / sigma, 2)));
  }
  const sum = rawPower.reduce((total, value) => total + value, 0);
  return { wavelengthNm, power: rawPower.map((value) => value / sum) };
}

export function simulateBroadbandGrating(input: BroadbandSimulationInput): BroadbandSimulationResult {
  const beamSplitter = evaluateBeamSplitter(input.beamSplitter);
  const visibility = inRange(input.visibility, 0, 1, 'Visibility');
  const opticalPathDifferenceMm = finiteNumber(input.opticalPathDifferenceMm, 'Optical path difference');
  const spectrum = generateGaussianSpectrum(input.centerWavelengthNm, input.bandwidthNm, input.sampleCount);
  const armPower = beamSplitter.reflected.power * beamSplitter.transmitted.power;
  const detectorPower: number[] = [];
  const diffractionAngleDeg: Array<number | null> = [];
  let propagatingCount = 0;

  for (let index = 0; index < spectrum.wavelengthNm.length; index += 1) {
    const wavelengthNm = spectrum.wavelengthNm[index];
    const grating = evaluateReflectionGrating({ ...input.grating, wavelengthNm });
    diffractionAngleDeg.push(grating.diffractionAngleDeg);
    if (!grating.propagating) {
      detectorPower.push(0);
      continue;
    }
    propagatingCount += 1;
    const wavelengthMm = wavelengthNm * 1e-6;
    const phase = TWO_PI * opticalPathDifferenceMm / wavelengthMm + degToRad(input.relativePhaseDeg ?? 0);
    const normalizedInterference = 2 * armPower * (1 + visibility * Math.cos(phase));
    detectorPower.push(spectrum.power[index] * normalizedInterference * grating.efficiency);
  }

  return {
    wavelengthNm: spectrum.wavelengthNm,
    sourcePower: spectrum.power,
    detectorPower,
    diffractionAngleDeg,
    propagatingFraction: propagatingCount / Math.max(1, spectrum.wavelengthNm.length),
    integratedDetectorPower: detectorPower.reduce((sum, value) => sum + value, 0),
  };
}
