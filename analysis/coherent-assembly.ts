import {
  evaluateBeamSplitter,
  evaluateReflectionGrating,
  generateCombLines,
  type BeamSplitterSpec,
} from './coherent-interferometer.ts';
import type { PortRoute, PortRouteSet } from '../data/block-schema.ts';

const TWO_PI = Math.PI * 2;

export type DimensionConfidence = 'Exact' | 'Estimated' | 'Missing';
export type OpticalTraceMode = 'sequential' | 'non-sequential';
export type ComponentShape = 'box' | 'cylinder' | 'lens';
export type CoherentComponentKind =
  | 'source'
  | 'mirror'
  | 'attenuator'
  | 'lens'
  | 'cylindrical-lens'
  | 'beam-splitter'
  | 'target'
  | 'reflection-grating'
  | 'detector'
  | 'time-detector'
  | 'stl-object'
  | 'sequential-group'
  | 'stop';

export interface Vec3Mm {
  x: number;
  y: number;
  z: number;
}

export interface EulerDeg {
  x: number;
  y: number;
  z: number;
}

export interface ComponentTransform {
  positionMm: Vec3Mm;
  rotationDeg: EulerDeg;
}

export interface ComponentDimensions {
  widthMm: number;
  heightMm: number;
  depthMm: number;
  apertureDiameterMm?: number;
  frontRadiusMm?: number | null;
  backRadiusMm?: number | null;
  centerThicknessMm?: number;
}

export interface OpticalPort {
  id: string;
  label: string;
  localPositionMm: Vec3Mm;
  localDirection: Vec3Mm;
}

export interface CoherentPhysicalComponent {
  id: string;
  label: string;
  reference?: string;
  kind: CoherentComponentKind;
  shape: ComponentShape;
  autoTransform: ComponentTransform;
  manualOffset: ComponentTransform;
  dimensions: ComponentDimensions;
  dimensionConfidence: DimensionConfidence;
  radialClearanceMm?: number;
  axialClearanceMm?: number;
  powerEfficiency?: number;
  refractiveIndexNd?: number;
  abbeNumber?: number;
  pathIds: string[];
  ports: OpticalPort[];
  metadata?: Record<string, unknown>;
}

export interface CoherentConnection {
  id: string;
  fromComponentId: string;
  toComponentId: string;
  pathId: string;
  roundTrip?: boolean;
  fromPortId?: string;
  toPortId?: string;
  distanceMm?: number;
  azimuthDeg?: number;
  elevationDeg?: number;
  allowReverse?: boolean;
  autoPlace?: boolean;
  /** True only when the automatically initialized placement values are intentionally user-authored. */
  placementOverride?: boolean;
  variables?: Record<string, unknown>;
}

export interface CoherentPathDefinition {
  id: string;
  label: string;
  componentIds: string[];
  roundTrip: boolean;
  throughput: number;
}

export interface CoherentBlockSequence {
  id: string;
  label: string;
  pathId: CoherentPathDefinition['id'];
  blocks: unknown[];
  /** User-authored pose relative to the port-routed auto placement. */
  manualOffset?: ComponentTransform;
  /** Resolved world pose used by tracing and Render. */
  rootTransform: ComponentTransform;
  rootTransformVariables?: Record<string, unknown>;
}

export type TargetProfileKind = 'flat' | 'step' | 'tilt' | 'sine' | 'csv';

export interface TargetProfileSpec {
  kind: TargetProfileKind;
  spanMm: number;
  offsetUm: number;
  amplitudeUm: number;
  periodMm: number;
  stepPositionMm: number;
  csvPoints?: Array<{ xMm: number; zUm: number }>;
  /** Controls whether local slope steers the return ray or only adds round-trip phase. */
  surfaceResponse?: 'specular-normal' | 'telecentric-phase';
  interaction?: 'specular' | 'lambertian' | 'abg' | 'harvey-shack' | 'bsdf-csv';
  scatterSamples?: number;
  scatterA?: number;
  scatterB?: number;
  scatterG?: number;
  scatterSigmaDeg?: number;
  bsdfSamples?: Array<{ angleDeg: number; value: number }>;
}

export interface CoherentSourceSpec {
  id?: string;
  componentId?: string;
  kind: 'gaussian-broadband' | 'supercontinuum' | 'frequency-comb';
  centerWavelengthNm: number;
  bandwidthFwhmNm: number;
  spectralSamples: number;
  totalPowerW: number;
  minWavelengthNm?: number;
  maxWavelengthNm?: number;
  spectralShape?: 'gaussian' | 'flat' | 'csv';
  spectrumCsv?: Array<{ wavelengthNm: number; powerWPerNm: number }>;
  beamDiameterMm?: number;
  exitApertureDiameterMm?: number;
  /** Air-side or immersion-side numerical aperture at a fiber/source facet. */
  numericalAperture?: number;
  /** Refractive index on the emitting side of the facet (normally 1 for air). */
  ambientRefractiveIndex?: number;
  divergenceDeg?: number;
  spatialProfile?: 'gaussian' | 'top-hat';
  /** Pupil positions per wavelength/comb line used by the live Render trace. */
  renderSpatialSamples?: number;
  /** Pupil positions per wavelength/comb line used by Detector signal tracing. */
  detectorSpatialSamples?: number;
  /** Legacy shared sample count, retained as a fallback for existing JSON. */
  spatialSamples?: number;
  coherenceGroupId?: string;
  repetitionRateHz?: number;
  ceoFrequencyHz?: number;
  repetitionRateGHz?: number;
  offsetFrequencyMHz?: number;
  lineCount?: number;
  opticalBandwidthHz?: number;
  lineWidthHz?: number;
  initialPhaseRad?: number;
  groupDelayDispersionFs2?: number;
  relativeDelayFs?: number;
  relativePhaseRad?: number;
}

export interface CoherentDetectorSpec {
  id?: string;
  componentId?: string;
  kind?: 'area' | 'time';
  pixelCountX: number;
  pixelCountY: number;
  pixelPitchUm: number;
  responsivity: number;
  activeWidthMm?: number;
  activeHeightMm?: number;
  fillFactor?: number;
  exposureTimeS?: number;
  saturationElectrons?: number;
  maximumSignalW?: number;
  bitDepth?: number;
  frontOnly?: boolean;
  samplingRateHz?: number;
  detectionBandwidthHz?: number;
  integrationTimeS?: number;
  sampleCount?: number;
  impulseResponse?: number[];
  quantumEfficiency?: Array<{ wavelengthNm: number; value: number }>;
  calibrationMinUm?: number;
  calibrationMaxUm?: number;
}

export interface CoherentGratingSpec {
  componentId?: string;
  grooveDensityLinesPerMm: number;
  incidenceAngleDeg: number;
  order: number;
  allowedOrders?: number[];
  efficiency: number;
  complexEfficiency?: Array<{ wavelengthNm: number; order: number; amplitude: number; phaseDeg: number }>;
  grooveDirection?: Vec3Mm;
  blazeAngleDeg?: number;
  blazeWavelengthNm?: number;
  substrateReflectivity?: number;
  nondiffractedReflectivity?: number;
  incidentSide?: 'front' | 'back';
  detectorMagnification: number;
}

export interface CoherentTraceSettings {
  maxInteractions: number;
  minRelativePower: number;
  maxGeneratedRays: number;
  rayEpsilonMm: number;
  renderSegmentLimit: number;
  previewSpatialSamples: number;
  previewSpectralSamples: number;
}

export interface CoherentAssemblyDesign {
  schemaVersion: '0.1' | '1.0';
  mode: OpticalTraceMode;
  /** Custom assemblies are authored from the active Configuration; no built-in instrument preset is embedded. */
  preset: 'custom-hybrid';
  revision?: number;
  name: string;
  routingMode?: 'automatic-scene' | 'engineered-paths';
  components: CoherentPhysicalComponent[];
  connections: CoherentConnection[];
  paths: CoherentPathDefinition[];
  portRoutes?: PortRoute[];
  routeSets?: PortRouteSet[];
  blockSequences: CoherentBlockSequence[];
  clearance: {
    radialMm: number;
    axialMm: number;
  };
  source: CoherentSourceSpec;
  sources?: CoherentSourceSpec[];
  beamSplitter: BeamSplitterSpec;
  grating: CoherentGratingSpec;
  target: TargetProfileSpec;
  detector: CoherentDetectorSpec;
  detectors?: CoherentDetectorSpec[];
  traceSettings?: CoherentTraceSettings;
  attenuatorTransmission: number;
  targetReflectance: number;
  visibility: number;
  calibrationOffsetMm: number;
}

export interface AxisAlignedBounds {
  min: Vec3Mm;
  max: Vec3Mm;
  size: Vec3Mm;
  volumeMm3: number;
}

export interface ComponentEvaluation {
  component: CoherentPhysicalComponent;
  transform: ComponentTransform;
  opticalBounds: AxisAlignedBounds | null;
  mechanicalBounds: AxisAlignedBounds | null;
  opticalVolumeMm3: number | null;
  mechanicalEnvelopeVolumeMm3: number | null;
}

export interface AssemblyCollision {
  componentAId: string;
  componentBId: string;
  overlapMm3: number;
}

export interface AssemblyEvaluation {
  components: ComponentEvaluation[];
  opticalBounds: AxisAlignedBounds | null;
  mechanicalBounds: AxisAlignedBounds | null;
  opticalVolumeMm3: number | null;
  mechanicalEnvelopeVolumeMm3: number | null;
  occupancyRatio: number | null;
  missingDimensionComponentIds: string[];
  estimatedDimensionComponentIds: string[];
  collisions: AssemblyCollision[];
  pathLengthMm: Record<CoherentPathDefinition['id'], number>;
  totalPathLengthMm: number;
  opticalPathDifferenceMm: number;
  confidence: DimensionConfidence;
}

export interface CoherentSurfaceSimulationResult {
  width: number;
  height: number;
  xMm: number[];
  yMm: number[];
  targetHeightUm: number[];
  recoveredHeightUm: number[];
  /** Sub-pixel Detector-Y position selected by the continuity-aware ridge tracker. */
  detectedRidgeY: number[];
  /** True where the diagnostic overlay must start a new segment instead of drawing a false vertical bar. */
  ridgeBreakBefore: boolean[];
  ridgeConfidence: number[];
  meanRidgeConfidence: number;
  spectralSampleCount: number;
  xSampleIntervalMm: number;
  samplesPerTargetPeriod: number | null;
  detectorHeightStepUm: number;
  /** Fraction of Target-X columns containing measurable Camera signal. */
  signalCoverageFraction: number;
  /** Camera-X column used as the measured zero-height reference. */
  cameraReferenceColumn: number | null;
  cameraReferenceXmm: number | null;
  /** Native optical carrier cycles between adjacent Detector-Y pixels. */
  carrierCyclesPerPixel: number;
  carrierAliased: boolean;
  /** Estimated Gaussian-source coherence-envelope FWHM on the reflected-height axis. */
  coherenceEnvelopeFwhmUm?: number;
  /** Detector-Y samples across the estimated coherence-envelope FWHM. */
  envelopeSamplesPerFwhm?: number;
  /** True when a separately traced flat Target established the system ridge. */
  flatReferenceApplied?: boolean;
  measurementSampleCount: number | null;
  samplingLimited: boolean;
  intensityWPerPixel: Float64Array;
  normalizedIntensity: Float64Array;
  coherenceEnvelope: Float64Array;
  maxIntensityWPerPixel: number;
  integratedPowerW: number;
  rmsHeightErrorUm: number;
  maxAbsHeightErrorUm: number;
  propagatingFraction: number;
  objectOpticalPathMm: number;
  referenceOpticalPathMm: number;
  opticalPathDifferenceMm: number;
  warningMessages: string[];
}

export interface CoherentSurfaceSimulationOptions {
  /**
   * Signed measurement-minus-reference OPD for a zero-height Target.  The
   * port-routed Hybrid trace supplies this value so reconstruction uses the
   * physical arm placement instead of a manually entered path-length sketch.
   */
  baseOpdMm?: number;
  /** Legacy shared calculation limit. */
  maximumDetectorPixels?: number;
  /** Independent limits keep the full depth-axis sampling while reducing X. */
  maximumDetectorPixelsX?: number;
  maximumDetectorPixelsY?: number;
  /** Minimum numerical quadrature nodes for a continuous broadband source. */
  minimumBroadbandSpectralSamples?: number;
  /** Explicit reconstruction range.  When omitted, Detector calibration is used. */
  calibrationMinUm?: number;
  calibrationMaxUm?: number;
}

export interface CoherentDetectorReconstructionOptions {
  powerWPerPixel: ArrayLike<number>;
  /** Flat-Target Camera capture made with the same routes and detector settings. */
  flatReferencePowerWPerPixel?: ArrayLike<number>;
  width: number;
  height: number;
  detector: CoherentDetectorSpec;
  grating: CoherentGratingSpec;
  sourceCenterWavelengthNm: number;
  sourceBandwidthFwhmNm?: number;
  baseOpdMm: number;
  targetSpanMm: number;
  calibrationMinUm: number;
  calibrationMaxUm: number;
  maximumDetectorPixelsX?: number;
  maximumDetectorPixelsY?: number;
  spectralSampleCount?: number;
  /** Monte-Carlo Detector hits represented by the Camera raster. */
  measurementSampleCount?: number;
  /** Optional measured reference column; the first signal-bearing column is used by default. */
  referenceColumn?: number;
  /** Height assigned to the measured reference column. A flat calibration normally supplies this. */
  referenceHeightUm?: number;
  /** Inclusive Camera-X range illuminated by the measurement route. */
  cameraXMin?: number;
  cameraXMax?: number;
  /** Physical Target-X coordinates represented by cameraXMin/cameraXMax. */
  targetXMinMm?: number;
  targetXMaxMm?: number;
  /** Used only for the gray comparison curve and error metrics, never by ridge extraction. */
  comparisonTarget?: TargetProfileSpec;
}

interface ComplexDelayLookup {
  sample(delayMm: number): { real: number; imaginary: number };
}

interface RidgeCandidate {
  y: number;
  value: number;
}

interface RidgeTrackingResult {
  y: number[];
  breakBefore: boolean[];
  confidence: number[];
}

/**
 * Gauss-Legendre quadrature avoids the periodic coherence replicas produced by
 * a uniformly spaced, finite wavelength list.  Those replicas are numerical
 * aliases, not a property of a continuous SLD/supercontinuum spectrum.
 */
function generateGaussianQuadratureSpectrum(centerWavelengthNm: number, bandwidthNm: number, sampleCount: number) {
  const center = Math.max(1e-6, finite(centerWavelengthNm, 600));
  const bandwidth = Math.max(1e-6, finite(bandwidthNm, 160));
  const count = Math.max(17, Math.min(1025, Math.round(finite(sampleCount, 257))));
  const sigma = bandwidth / (2 * Math.sqrt(2 * Math.log(2)));
  const span = Math.min(center * 1.8, bandwidth * 2.5);
  const start = Math.max(1e-6, center - span / 2);
  const end = center + span / 2;
  const midpoint = (start + end) / 2;
  const halfSpan = (end - start) / 2;
  const nodes: Array<{ wavelengthNm: number; weightedPower: number }> = [];
  const roots = Math.ceil(count / 2);
  for (let root = 0; root < roots; root += 1) {
    let z = Math.cos(Math.PI * (root + 0.75) / (count + 0.5));
    let derivative = 0;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      let previous = 1;
      let current = z;
      for (let order = 2; order <= count; order += 1) {
        const next = ((2 * order - 1) * z * current - (order - 1) * previous) / order;
        previous = current;
        current = next;
      }
      const denominator = z * z - 1;
      derivative = count * (z * current - previous)
        / (Math.abs(denominator) > 1e-18 ? denominator : -1e-18);
      const nextZ = z - current / derivative;
      if (Math.abs(nextZ - z) < 1e-14) {
        z = nextZ;
        break;
      }
      z = nextZ;
    }
    // Refresh P'_n at the converged root before calculating its quadrature weight.
    let previous = 1;
    let current = z;
    for (let order = 2; order <= count; order += 1) {
      const next = ((2 * order - 1) * z * current - (order - 1) * previous) / order;
      previous = current;
      current = next;
    }
    derivative = count * (z * current - previous) / (z * z - 1);
    const quadratureWeight = 2 / Math.max(1e-30, (1 - z * z) * derivative * derivative);
    const addNode = (signedRoot: number) => {
      const wavelengthNm = midpoint + halfSpan * signedRoot;
      const gaussian = Math.exp(-0.5 * Math.pow((wavelengthNm - center) / sigma, 2));
      nodes.push({ wavelengthNm, weightedPower: quadratureWeight * halfSpan * gaussian });
    };
    addNode(-z);
    if (Math.abs(z) > 1e-14 && nodes.length < count) addNode(z);
  }
  nodes.sort((a, b) => a.wavelengthNm - b.wavelengthNm);
  const selected = nodes.slice(0, count);
  const total = selected.reduce((sum, node) => sum + node.weightedPower, 0);
  return {
    wavelengthNm: selected.map((node) => node.wavelengthNm),
    power: selected.map((node) => node.weightedPower / Math.max(1e-30, total)),
  };
}

function buildComplexDelayLookup(
  wavelengthNm: number[],
  power: number[],
  spectralBaseOpdMm: number[],
  phaseOffsetRad: number,
  minimumDelayMm: number,
  maximumDelayMm: number,
  detectorDelayStepMm: number,
): ComplexDelayLookup {
  const low = Math.min(minimumDelayMm, maximumDelayMm);
  const high = Math.max(minimumDelayMm, maximumDelayMm);
  const range = Math.max(1e-12, high - low);
  const shortestWavelengthMm = Math.max(1e-9, Math.min(...wavelengthNm) * 1e-6);
  const preferredStepMm = Math.min(
    shortestWavelengthMm / 8,
    Math.abs(detectorDelayStepMm) > 1e-12 ? Math.abs(detectorDelayStepMm) / 4 : Number.POSITIVE_INFINITY,
  );
  const count = Math.max(2, Math.min(262145, Math.ceil(range / Math.max(1e-9, preferredStepMm)) + 1));
  const stepMm = range / Math.max(1, count - 1);
  const real = new Float64Array(count);
  const imaginary = new Float64Array(count);
  for (let wi = 0; wi < wavelengthNm.length; wi += 1) {
    const wavelengthMm = Math.max(1e-12, wavelengthNm[wi] * 1e-6);
    const weight = power[wi] ?? 0;
    let angle = (TWO_PI * (spectralBaseOpdMm[wi] + low) / wavelengthMm + phaseOffsetRad) % TWO_PI;
    const increment = (TWO_PI * stepMm / wavelengthMm) % TWO_PI;
    const incrementCos = Math.cos(increment);
    const incrementSin = Math.sin(increment);
    let cosine = Math.cos(angle);
    let sine = Math.sin(angle);
    for (let index = 0; index < count; index += 1) {
      real[index] += weight * cosine;
      imaginary[index] += weight * sine;
      const nextCosine = cosine * incrementCos - sine * incrementSin;
      sine = sine * incrementCos + cosine * incrementSin;
      cosine = nextCosine;
      if ((index & 1023) === 1023) {
        angle = (angle + increment * 1024) % TWO_PI;
        cosine = Math.cos(angle);
        sine = Math.sin(angle);
      }
    }
  }
  return {
    sample(delayMm: number) {
      const position = clamp((delayMm - low) / stepMm, 0, count - 1);
      const lower = Math.min(count - 1, Math.max(0, Math.floor(position)));
      const upper = Math.min(count - 1, lower + 1);
      const fraction = position - lower;
      return {
        real: real[lower] + (real[upper] - real[lower]) * fraction,
        imaginary: imaginary[lower] + (imaginary[upper] - imaginary[lower]) * fraction,
      };
    },
  };
}

function trackCoherenceRidge(
  envelope: Float64Array,
  width: number,
  height: number,
  validRows: number[],
  calibratedHeightByY: number[],
  anchorHeightUm?: number,
): RidgeTrackingResult {
  const rows = validRows.length ? validRows : Array.from({ length: height }, (_, index) => index);
  let globalMaximum = 0;
  envelope.forEach((value) => { globalMaximum = Math.max(globalMaximum, finite(value)); });
  const candidateColumns: RidgeCandidate[][] = [];
  const maximumCandidates = 24;
  for (let x = 0; x < width; x += 1) {
    const candidates: RidgeCandidate[] = [];
    let nearestAnchorCandidate: RidgeCandidate | null = null;
    const offer = (candidate: RidgeCandidate) => {
      let insertAt = candidates.findIndex((entry) => candidate.value > entry.value);
      if (insertAt < 0) insertAt = candidates.length;
      candidates.splice(insertAt, 0, candidate);
      if (candidates.length > maximumCandidates) candidates.length = maximumCandidates;
    };
    let strongest: RidgeCandidate = { y: rows[0] ?? 0, value: Number.NEGATIVE_INFINITY };
    for (const y of rows) {
      const value = envelope[y * width + x];
      if (value > strongest.value) strongest = { y, value };
      const previous = y > 0 ? envelope[(y - 1) * width + x] : Number.NEGATIVE_INFINITY;
      const next = y + 1 < height ? envelope[(y + 1) * width + x] : Number.NEGATIVE_INFINITY;
      if (value >= previous && value >= next) {
        const candidate = { y, value };
        offer(candidate);
        if (Number.isFinite(anchorHeightUm) && (
          nearestAnchorCandidate === null
          || Math.abs(calibratedHeightByY[y] - Number(anchorHeightUm))
            < Math.abs(calibratedHeightByY[nearestAnchorCandidate.y] - Number(anchorHeightUm))
        )) nearestAnchorCandidate = candidate;
      }
    }
    if (!candidates.some((candidate) => candidate.y === strongest.y)) offer(strongest);
    if (nearestAnchorCandidate && !candidates.some((candidate) => candidate.y === nearestAnchorCandidate!.y)) {
      if (candidates.length >= maximumCandidates) candidates.pop();
      candidates.push(nearestAnchorCandidate);
    }
    candidateColumns.push(candidates.length ? candidates : [strongest]);
  }

  const rangeUm = Math.max(1e-9, Math.abs(calibratedHeightByY[rows[rows.length - 1]] - calibratedHeightByY[rows[0]]));
  const detectorStepUm = rows.length > 1
    ? Math.max(1e-9, Math.abs(calibratedHeightByY[rows[1]] - calibratedHeightByY[rows[0]]))
    : 1;
  // Estimate the admissible local slope from the measured ridge candidates.
  // No Target profile or amplitude is used here: a known design shape is only
  // allowed later when reporting reconstruction error.
  const strongestHeight = candidateColumns.map((candidates) => calibratedHeightByY[candidates[0].y]);
  const measuredJumps = strongestHeight.slice(1)
    .map((heightUm, index) => Math.abs(heightUm - strongestHeight[index]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const robustMeasuredJumpUm = measuredJumps.length
    ? measuredJumps[Math.floor((measuredJumps.length - 1) * 0.6)]
    : 0;
  const normalTransitionScaleUm = Math.max(detectorStepUm * 4, robustMeasuredJumpUm * 2, rangeUm * 0.005);
  const costs: number[][] = [];
  const parents: number[][] = [];
  candidateColumns.forEach((candidates, x) => {
    const columnCosts = new Array<number>(candidates.length);
    const columnParents = new Array<number>(candidates.length).fill(-1);
    candidates.forEach((candidate, candidateIndex) => {
      const emission = -Math.log(Math.max(1e-12, candidate.value / Math.max(1e-30, globalMaximum)));
      if (x === 0) {
        const anchorScaleUm = Math.max(detectorStepUm * 4, rangeUm * 0.01);
        const anchor = Number.isFinite(anchorHeightUm)
          ? 0.5 * Math.pow((calibratedHeightByY[candidate.y] - Number(anchorHeightUm)) / anchorScaleUm, 2)
          : 0;
        columnCosts[candidateIndex] = emission + anchor;
        return;
      }
      let bestCost = Number.POSITIVE_INFINITY;
      let bestParent = 0;
      candidateColumns[x - 1].forEach((previous, previousIndex) => {
        const jumpUm = Math.abs(calibratedHeightByY[candidate.y] - calibratedHeightByY[previous.y]);
        // A persistent physical Step may justify one large transition, while
        // isolated correlation aliases would require a second large jump a few
        // columns later.  The finite cap therefore preserves real Steps and
        // rejects short-lived wrong fringe branches.
        const continuity = Math.min(20, 0.2 * Math.pow(jumpUm / Math.max(1e-9, normalTransitionScaleUm), 2));
        const cost = costs[x - 1][previousIndex] + emission + continuity;
        if (cost < bestCost) {
          bestCost = cost;
          bestParent = previousIndex;
        }
      });
      columnCosts[candidateIndex] = bestCost;
      columnParents[candidateIndex] = bestParent;
    });
    costs.push(columnCosts);
    parents.push(columnParents);
  });

  const selected = new Array<number>(width).fill(0);
  let selectedIndex = costs[width - 1].reduce((best, value, index, array) => value < array[best] ? index : best, 0);
  for (let x = width - 1; x >= 0; x -= 1) {
    selected[x] = candidateColumns[x][selectedIndex].y;
    selectedIndex = x > 0 ? parents[x][selectedIndex] : 0;
  }
  const subpixelY = selected.map((integerY, x) => {
    if (integerY <= rows[0] || integerY >= rows[rows.length - 1]) return integerY;
    const left = envelope[(integerY - 1) * width + x];
    const center = envelope[integerY * width + x];
    const right = envelope[(integerY + 1) * width + x];
    const curvature = left - 2 * center + right;
    return Math.abs(curvature) > 1e-15
      ? integerY + clamp(0.5 * (left - right) / curvature, -0.5, 0.5)
      : integerY;
  });
  const confidence = selected.map((integerY, x) => {
    const selectedValue = envelope[integerY * width + x];
    const alternative = candidateColumns[x]
      .filter((candidate) => Math.abs(candidate.y - integerY) > 2)
      .reduce((maximum, candidate) => Math.max(maximum, candidate.value), 0);
    return clamp(1 - alternative / Math.max(1e-30, selectedValue), 0, 1);
  });
  const breakBefore = subpixelY.map((value, index) => {
    if (index === 0) return false;
    const previousHeight = calibratedHeightByY[Math.max(0, Math.min(height - 1, Math.round(subpixelY[index - 1])))];
    const currentHeight = calibratedHeightByY[Math.max(0, Math.min(height - 1, Math.round(value)))];
    return Math.abs(currentHeight - previousHeight) > Math.max(normalTransitionScaleUm * 6, detectorStepUm * 12);
  });
  return { y: subpixelY, breakBefore, confidence };
}

function repairShortCorrelationExcursions(
  input: number[],
  detectorStepUm: number,
  calibrationRangeUm: number,
): { values: number[]; repaired: boolean[] } {
  const values = input.slice();
  const repaired = new Array<boolean>(values.length).fill(false);
  const jumps = values.slice(1)
    .map((value, index) => Math.abs(value - values[index]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const typicalJump = jumps.length ? jumps[Math.floor((jumps.length - 1) * 0.75)] : 0;
  const threshold = Math.max(detectorStepUm * 12, calibrationRangeUm * 0.12, typicalJump * 1.25);
  const maximumExcursionWidth = 4;
  for (let start = 1; start + 1 < values.length; start += 1) {
    const departure = values[start] - values[start - 1];
    if (Math.abs(departure) < threshold) continue;
    for (let end = start; end < Math.min(values.length - 1, start + maximumExcursionWidth); end += 1) {
      const returnJump = values[end + 1] - values[end];
      if (departure * returnJump >= 0 || Math.abs(returnJump) < threshold * 0.85) continue;
      const outsideChange = Math.abs(values[end + 1] - values[start - 1]);
      if (outsideChange > Math.max(Math.abs(departure), Math.abs(returnJump)) * 0.7) continue;
      const left = values[start - 1];
      const right = values[end + 1];
      for (let index = start; index <= end; index += 1) {
        values[index] = left + (right - left) * (index - start + 1) / (end - start + 2);
        repaired[index] = true;
      }
      start = end;
      break;
    }
  }
  return { values, repaired };
}

const zeroVector = (): Vec3Mm => ({ x: 0, y: 0, z: 0 });
const zeroEuler = (): EulerDeg => ({ x: 0, y: 0, z: 0 });
const identityOffset = (): ComponentTransform => ({ positionMm: zeroVector(), rotationDeg: zeroEuler() });

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function vector(x: number, y: number, z: number): Vec3Mm {
  return { x, y, z };
}

function transform(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): ComponentTransform {
  return { positionMm: vector(x, y, z), rotationDeg: { x: rx, y: ry, z: rz } };
}

function defaultPorts(_depthMm: number): OpticalPort[] {
  return [
    { id: 'in', label: 'Input', localPositionMm: vector(0, 0, 0), localDirection: vector(0, 0, -1) },
    { id: 'out', label: 'Output', localPositionMm: vector(0, 0, 0), localDirection: vector(0, 0, 1) },
  ];
}

/**
 * Empty, instrument-neutral fallback used only when no active Configuration is
 * available. Physical components, routes and dimensions are always authored
 * in Design Intents and Optical Routes rather than embedded as a preset.
 */
export function createGenericCoherentAssemblyDesign(): CoherentAssemblyDesign {
  const source: CoherentSourceSpec = {
    id: 'source', kind: 'gaussian-broadband', centerWavelengthNm: 550,
    bandwidthFwhmNm: 100, spectralSamples: 65, totalPowerW: 1,
    beamDiameterMm: 1, divergenceDeg: 0, spatialProfile: 'gaussian',
    spatialSamples: 9, coherenceGroupId: 'default',
  };
  const detector: CoherentDetectorSpec = {
    id: 'detector', kind: 'area', pixelCountX: 1, pixelCountY: 1,
    pixelPitchUm: 1, responsivity: 1, fillFactor: 1, frontOnly: true,
  };
  return {
    schemaVersion: '1.0',
    mode: 'non-sequential',
    preset: 'custom-hybrid',
    name: 'Coherent signal',
    components: [],
    connections: [],
    paths: [],
    blockSequences: [],
    clearance: { radialMm: 0, axialMm: 0 },
    source,
    sources: [source],
    beamSplitter: { reflectance: 0.5, transmittance: 0.5, reflectedPhaseDeg: 90, transmittedPhaseDeg: 0 },
    grating: { grooveDensityLinesPerMm: 1, incidenceAngleDeg: 0, order: 0, allowedOrders: [0], efficiency: 1, detectorMagnification: 1 },
    target: { kind: 'flat', spanMm: 1, offsetUm: 0, amplitudeUm: 0, periodMm: 1, stepPositionMm: 0 },
    detector,
    detectors: [detector],
    traceSettings: { maxInteractions: 24, minRelativePower: 1e-9, maxGeneratedRays: 250000, rayEpsilonMm: 1e-5, renderSegmentLimit: 25000, previewSpatialSamples: 9, previewSpectralSamples: 9 },
    attenuatorTransmission: 1,
    targetReflectance: 1,
    visibility: 1,
    calibrationOffsetMm: 0,
  };
}
export function normalizeCoherentAssemblyDesign(value: unknown): CoherentAssemblyDesign {
  const fallback = createGenericCoherentAssemblyDesign();
  if (!value || typeof value !== 'object') return fallback;
  const source = value as Partial<CoherentAssemblyDesign>;
  const clone = JSON.parse(JSON.stringify(fallback)) as CoherentAssemblyDesign;
  const components = Array.isArray(source.components) ? source.components : clone.components;
  const normalizedComponents = components.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const candidate = item as CoherentPhysicalComponent;
    const preset = clone.components.find((entry) => entry.id === candidate.id);
    const base = preset ?? candidate;
    const baseAuto = base.autoTransform ?? transform(0, 0, 0);
    const baseManual = base.manualOffset ?? identityOffset();
    const auto = candidate.autoTransform ?? baseAuto;
    const manual = candidate.manualOffset ?? baseManual;
    const dimensions = { ...(base.dimensions ?? {}), ...(candidate.dimensions ?? {}) } as ComponentDimensions;
    return {
      ...base,
      ...candidate,
      autoTransform: { positionMm: { ...baseAuto.positionMm, ...auto.positionMm }, rotationDeg: { ...baseAuto.rotationDeg, ...auto.rotationDeg } },
      manualOffset: { positionMm: { ...baseManual.positionMm, ...manual.positionMm }, rotationDeg: { ...baseManual.rotationDeg, ...manual.rotationDeg } },
      dimensions,
      pathIds: Array.isArray(candidate.pathIds) ? [...candidate.pathIds] : [...(base.pathIds ?? [])],
      ports: Array.isArray(candidate.ports) ? [...candidate.ports] : [...(base.ports ?? defaultPorts(dimensions.depthMm))],
    } as CoherentPhysicalComponent;
  }).filter(Boolean) as CoherentPhysicalComponent[];
  const normalizedSource = { ...clone.source, ...(source.source ?? {}) };
  const normalizedDetector = { ...clone.detector, ...(source.detector ?? {}) };
  const normalizedSources = Array.isArray(source.sources) && source.sources.length > 0
    ? source.sources.map((entry, index) => ({ ...normalizedSource, ...entry, id: entry.id ?? `source-${index + 1}` }))
    : [{ ...normalizedSource, id: normalizedSource.id ?? 'source' }];
  const normalizedDetectors = Array.isArray(source.detectors) && source.detectors.length > 0
    ? source.detectors.map((entry, index) => ({ ...normalizedDetector, ...entry, id: entry.id ?? `detector-${index + 1}` }))
    : [{ ...normalizedDetector, id: normalizedDetector.id ?? 'detector' }];


  return {
    ...clone,
    ...source,
    schemaVersion: '1.0',
    mode: source.mode === 'sequential' ? 'sequential' : 'non-sequential',
    preset: 'custom-hybrid',
    components: normalizedComponents,
    connections: Array.isArray(source.connections) ? source.connections : clone.connections,
    paths: Array.isArray(source.paths) ? source.paths : clone.paths,
    portRoutes: Array.isArray(source.portRoutes) ? source.portRoutes : [],
    routeSets: Array.isArray(source.routeSets) ? source.routeSets : [],
    blockSequences: Array.isArray(source.blockSequences) ? source.blockSequences : clone.blockSequences,
    clearance: { ...clone.clearance, ...(source.clearance ?? {}) },
    source: normalizedSources[0],
    sources: normalizedSources,
    beamSplitter: { ...clone.beamSplitter, ...(source.beamSplitter ?? {}) },
    grating: { ...clone.grating, ...(source.grating ?? {}) },
    target: { ...clone.target, ...(source.target ?? {}) },
    detector: normalizedDetectors[0],
    detectors: normalizedDetectors,
    traceSettings: { ...clone.traceSettings!, ...(source.traceSettings ?? {}) },
  };
}

export function resolveComponentTransform(item: CoherentPhysicalComponent): ComponentTransform {
  return {
    positionMm: {
      x: finite(item.autoTransform?.positionMm?.x) + finite(item.manualOffset?.positionMm?.x),
      y: finite(item.autoTransform?.positionMm?.y) + finite(item.manualOffset?.positionMm?.y),
      z: finite(item.autoTransform?.positionMm?.z) + finite(item.manualOffset?.positionMm?.z),
    },
    rotationDeg: {
      x: finite(item.autoTransform?.rotationDeg?.x) + finite(item.manualOffset?.rotationDeg?.x),
      y: finite(item.autoTransform?.rotationDeg?.y) + finite(item.manualOffset?.rotationDeg?.y),
      z: finite(item.autoTransform?.rotationDeg?.z) + finite(item.manualOffset?.rotationDeg?.z),
    },
  };
}

function rotationMatrix(rotation: EulerDeg): number[][] {
  const rx = finite(rotation.x) * Math.PI / 180;
  const ry = finite(rotation.y) * Math.PI / 180;
  const rz = finite(rotation.z) * Math.PI / 180;
  const cx = Math.cos(rx); const sx = Math.sin(rx);
  const cy = Math.cos(ry); const sy = Math.sin(ry);
  const cz = Math.cos(rz); const sz = Math.sin(rz);
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

function boundsForDimensions(position: Vec3Mm, rotation: EulerDeg, dimensions: ComponentDimensions): AxisAlignedBounds | null {
  const width = finite(dimensions.widthMm, NaN);
  const height = finite(dimensions.heightMm, NaN);
  const depth = finite(dimensions.depthMm, NaN);
  if (!(width > 0 && height > 0 && depth > 0)) return null;
  const half = [width / 2, height / 2, depth / 2];
  const matrix = rotationMatrix(rotation);
  const extent = [0, 1, 2].map((row) => (
    Math.abs(matrix[row][0]) * half[0]
    + Math.abs(matrix[row][1]) * half[1]
    + Math.abs(matrix[row][2]) * half[2]
  ));
  const min = vector(position.x - extent[0], position.y - extent[1], position.z - extent[2]);
  const max = vector(position.x + extent[0], position.y + extent[1], position.z + extent[2]);
  return { min, max, size: vector(extent[0] * 2, extent[1] * 2, extent[2] * 2), volumeMm3: extent[0] * extent[1] * extent[2] * 8 };
}

function sphericalSag(radiusMm: number | null | undefined, radialMm: number): number {
  const radius = finite(radiusMm, Infinity);
  if (!Number.isFinite(radius) || Math.abs(radius) < 1e-12) return 0;
  const r = Math.min(Math.abs(radialMm), Math.abs(radius) * (1 - 1e-12));
  const root = Math.sqrt(Math.max(0, radius * radius - r * r));
  return radius - Math.sign(radius) * root;
}

export function calculateLensVolumeMm3(dimensions: ComponentDimensions, radialSamples = 512): number | null {
  const diameter = finite(dimensions.apertureDiameterMm ?? Math.min(dimensions.widthMm, dimensions.heightMm), NaN);
  const centerThickness = finite(dimensions.centerThicknessMm ?? dimensions.depthMm, NaN);
  if (!(diameter > 0 && centerThickness > 0)) return null;
  const radius = diameter / 2;
  const count = Math.max(32, Math.min(4096, Math.round(radialSamples)));
  let volume = 0;
  for (let index = 0; index < count; index += 1) {
    const r0 = radius * index / count;
    const r1 = radius * (index + 1) / count;
    const rm = (r0 + r1) / 2;
    const front = sphericalSag(dimensions.frontRadiusMm, rm);
    const back = sphericalSag(dimensions.backRadiusMm, rm);
    const localThickness = Math.max(0, centerThickness + back - front);
    volume += TWO_PI * rm * localThickness * (r1 - r0);
  }
  return Number.isFinite(volume) ? volume : null;
}

export function calculateComponentOpticalVolumeMm3(item: CoherentPhysicalComponent): number | null {
  const width = finite(item.dimensions?.widthMm, NaN);
  const height = finite(item.dimensions?.heightMm, NaN);
  const depth = finite(item.dimensions?.depthMm, NaN);
  if (!(width > 0 && height > 0 && depth > 0)) return null;
  if (item.shape === 'box') return width * height * depth;
  if (item.shape === 'cylinder') return Math.PI * Math.pow(Math.min(width, height) / 2, 2) * depth;
  return calculateLensVolumeMm3(item.dimensions);
}

function mergeBounds(items: Array<AxisAlignedBounds | null>): AxisAlignedBounds | null {
  const valid = items.filter((item): item is AxisAlignedBounds => !!item);
  if (valid.length === 0) return null;
  const min = vector(
    Math.min(...valid.map((item) => item.min.x)),
    Math.min(...valid.map((item) => item.min.y)),
    Math.min(...valid.map((item) => item.min.z)),
  );
  const max = vector(
    Math.max(...valid.map((item) => item.max.x)),
    Math.max(...valid.map((item) => item.max.y)),
    Math.max(...valid.map((item) => item.max.z)),
  );
  const size = vector(max.x - min.x, max.y - min.y, max.z - min.z);
  return { min, max, size, volumeMm3: size.x * size.y * size.z };
}

function mechanicalDimensions(item: CoherentPhysicalComponent, design: CoherentAssemblyDesign): ComponentDimensions {
  const radial = Math.max(0, finite(item.radialClearanceMm, finite(design.clearance.radialMm, 5)));
  const axial = Math.max(0, finite(item.axialClearanceMm, finite(design.clearance.axialMm, 3)));
  return {
    ...item.dimensions,
    widthMm: finite(item.dimensions.widthMm) + radial * 2,
    heightMm: finite(item.dimensions.heightMm) + radial * 2,
    depthMm: finite(item.dimensions.depthMm) + axial * 2,
  };
}

function overlapVolume(a: AxisAlignedBounds, b: AxisAlignedBounds): number {
  const dx = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const dy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  const dz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return dx > 1e-9 && dy > 1e-9 && dz > 1e-9 ? dx * dy * dz : 0;
}

function distance(a: Vec3Mm, b: Vec3Mm): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function refractiveIndexAtWavelength(item: CoherentPhysicalComponent, wavelengthNm: number): number {
  const nd = finite(item.refractiveIndexNd, 1);
  if (!(nd > 1)) return 1;
  const abbe = finite(item.abbeNumber, Infinity);
  if (!(abbe > 0) || !Number.isFinite(abbe)) return nd;
  const lambdaUm = Math.max(1e-6, wavelengthNm * 1e-3);
  const lambdaFUm = 0.4861327;
  const lambdaCUm = 0.6562725;
  const lambdaDUm = 0.5875618;
  const deltaFC = (nd - 1) / abbe;
  const b = deltaFC / (1 / (lambdaFUm * lambdaFUm) - 1 / (lambdaCUm * lambdaCUm));
  const a = nd - b / (lambdaDUm * lambdaDUm);
  return a + b / (lambdaUm * lambdaUm);
}

function calculateGeometricPathLength(design: CoherentAssemblyDesign, path: CoherentPathDefinition): number {
  const byId = new Map(design.components.map((item) => [item.id, resolveComponentTransform(item).positionMm]));
  const connections = new Map(design.connections.map((connection) => [
    `${connection.pathId}:${connection.fromComponentId}:${connection.toComponentId}`,
    connection,
  ]));
  let length = 0;
  for (let index = 1; index < path.componentIds.length; index += 1) {
    const fromId = path.componentIds[index - 1];
    const toId = path.componentIds[index];
    const connection = connections.get(`${path.id}:${fromId}:${toId}`);
    const storedDistance = Number(connection?.distanceMm);
    if (Number.isFinite(storedDistance) && storedDistance >= 0) {
      length += storedDistance;
      continue;
    }
    const previous = byId.get(fromId);
    const current = byId.get(toId);
    if (previous && current) length += distance(previous, current);
  }
  return path.roundTrip ? length * 2 : length;
}

export function calculatePathOpticalLengthMm(design: CoherentAssemblyDesign, pathId: CoherentPathDefinition['id'], wavelengthNm: number): number {
  const path = design.paths.find((candidate) => candidate.id === pathId);
  if (!path) return 0;
  const geometric = calculateGeometricPathLength(design, path);
  const passMultiplier = path.roundTrip ? 2 : 1;
  const internalExcess = path.componentIds.reduce((sum, componentId) => {
    const item = design.components.find((candidate) => candidate.id === componentId);
    if (!item) return sum;
    const refractiveIndex = refractiveIndexAtWavelength(item, wavelengthNm);
    if (!(refractiveIndex > 1)) return sum;
    const depthMm = Math.max(0, finite(item.dimensions?.centerThicknessMm ?? item.dimensions?.depthMm));
    return sum + depthMm * (refractiveIndex - 1);
  }, 0);
  return geometric + passMultiplier * internalExcess;
}

function calculatePathLength(design: CoherentAssemblyDesign, path: CoherentPathDefinition): number {
  return calculatePathOpticalLengthMm(design, path.id, finite(design.source.centerWavelengthNm, 587.5618));
}

export function evaluateCoherentAssembly(input: CoherentAssemblyDesign): AssemblyEvaluation {
  const design = normalizeCoherentAssemblyDesign(input);
  const components = design.components.map((item): ComponentEvaluation => {
    const resolved = resolveComponentTransform(item);
    const opticalBounds = item.dimensionConfidence === 'Missing' ? null : boundsForDimensions(resolved.positionMm, resolved.rotationDeg, item.dimensions);
    const mechanical = item.dimensionConfidence === 'Missing' ? null : mechanicalDimensions(item, design);
    const mechanicalBounds = mechanical ? boundsForDimensions(resolved.positionMm, resolved.rotationDeg, mechanical) : null;
    return {
      component: item,
      transform: resolved,
      opticalBounds,
      mechanicalBounds,
      opticalVolumeMm3: item.dimensionConfidence === 'Missing' ? null : calculateComponentOpticalVolumeMm3(item),
      mechanicalEnvelopeVolumeMm3: mechanical ? finite(mechanical.widthMm) * finite(mechanical.heightMm) * finite(mechanical.depthMm) : null,
    };
  });
  const missingDimensionComponentIds = components.filter((item) => item.component.dimensionConfidence === 'Missing' || !item.opticalBounds).map((item) => item.component.id);
  const estimatedDimensionComponentIds = components.filter((item) => item.component.dimensionConfidence === 'Estimated').map((item) => item.component.id);
  const opticalBounds = mergeBounds(components.map((item) => item.opticalBounds));
  const mechanicalBounds = mergeBounds(components.map((item) => item.mechanicalBounds));
  const opticalVolumes = components.map((item) => item.opticalVolumeMm3).filter((value): value is number => Number.isFinite(value));
  const mechanicalVolumes = components.map((item) => item.mechanicalEnvelopeVolumeMm3).filter((value): value is number => Number.isFinite(value));
  const opticalVolumeMm3 = missingDimensionComponentIds.length > 0 ? null : opticalVolumes.reduce((sum, value) => sum + value, 0);
  const mechanicalEnvelopeVolumeMm3 = missingDimensionComponentIds.length > 0 ? null : mechanicalVolumes.reduce((sum, value) => sum + value, 0);
  const collisions: AssemblyCollision[] = [];
  for (let i = 0; i < components.length; i += 1) {
    const a = components[i];
    if (!a.mechanicalBounds) continue;
    for (let j = i + 1; j < components.length; j += 1) {
      const b = components[j];
      if (!b.mechanicalBounds) continue;
      const overlapMm3 = overlapVolume(a.mechanicalBounds, b.mechanicalBounds);
      if (overlapMm3 > 1e-6) collisions.push({ componentAId: a.component.id, componentBId: b.component.id, overlapMm3 });
    }
  }
  const pathLengthMm = Object.fromEntries(design.paths.map((path) => [path.id, calculatePathLength(design, path)])) as Record<CoherentPathDefinition['id'], number>;
  const objectLength = finite(pathLengthMm.object);
  const referenceLength = finite(pathLengthMm.reference);
  const totalPathLengthMm = Object.values(pathLengthMm).reduce((sum, value) => sum + finite(value), 0);
  const confidence: DimensionConfidence = missingDimensionComponentIds.length > 0 ? 'Missing' : estimatedDimensionComponentIds.length > 0 ? 'Estimated' : 'Exact';
  return {
    components,
    opticalBounds,
    mechanicalBounds,
    opticalVolumeMm3,
    mechanicalEnvelopeVolumeMm3,
    occupancyRatio: mechanicalBounds && mechanicalEnvelopeVolumeMm3 !== null && mechanicalBounds.volumeMm3 > 0 ? mechanicalEnvelopeVolumeMm3 / mechanicalBounds.volumeMm3 : null,
    missingDimensionComponentIds,
    estimatedDimensionComponentIds,
    collisions,
    pathLengthMm,
    totalPathLengthMm,
    opticalPathDifferenceMm: objectLength - referenceLength + finite(design.calibrationOffsetMm),
    confidence,
  };
}

function interpolateCsv(points: Array<{ xMm: number; zUm: number }>, xMm: number): number {
  const sorted = points.filter((point) => Number.isFinite(point.xMm) && Number.isFinite(point.zUm)).slice().sort((a, b) => a.xMm - b.xMm);
  if (sorted.length === 0) return 0;
  if (xMm <= sorted[0].xMm) return sorted[0].zUm;
  if (xMm >= sorted[sorted.length - 1].xMm) return sorted[sorted.length - 1].zUm;
  for (let index = 1; index < sorted.length; index += 1) {
    const right = sorted[index];
    const left = sorted[index - 1];
    if (xMm <= right.xMm) {
      const t = (xMm - left.xMm) / Math.max(1e-15, right.xMm - left.xMm);
      return left.zUm + (right.zUm - left.zUm) * t;
    }
  }
  return sorted[sorted.length - 1].zUm;
}

export function sampleTargetHeightUm(spec: TargetProfileSpec, xMm: number): number {
  const offset = finite(spec.offsetUm);
  const amplitude = finite(spec.amplitudeUm);
  if (spec.kind === 'flat') return offset;
  if (spec.kind === 'step') return offset + (xMm >= finite(spec.stepPositionMm) ? amplitude : 0);
  if (spec.kind === 'tilt') return offset + amplitude * xMm / Math.max(1e-12, finite(spec.spanMm, 1) / 2);
  if (spec.kind === 'sine') return offset + amplitude * Math.sin(TWO_PI * xMm / Math.max(1e-12, finite(spec.periodMm, 1)));
  return offset + interpolateCsv(Array.isArray(spec.csvPoints) ? spec.csvPoints : [], xMm);
}

export function parseTargetProfileCsv(text: string): Array<{ xMm: number; zUm: number }> {
  const points: Array<{ xMm: number; zUm: number }> = [];
  String(text ?? '').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const fields = trimmed.split(/[\s,;\t]+/).filter(Boolean);
    if (fields.length < 2) return;
    const xMm = Number(fields[0]);
    const zUm = Number(fields[1]);
    if (Number.isFinite(xMm) && Number.isFinite(zUm)) points.push({ xMm, zUm });
  });
  if (points.length < 2) throw new Error('CSV requires at least two numeric x(mm), z(µm) rows.');
  return points.sort((a, b) => a.xMm - b.xMm);
}

function pathThroughput(design: CoherentAssemblyDesign, id: CoherentPathDefinition['id']): number {
  const path = design.paths.find((candidate) => candidate.id === id);
  return clamp(finite(path?.throughput, 1), 0, 1);
}

export function simulateCoherentSurfaceSignal(
  input: CoherentAssemblyDesign,
  options: CoherentSurfaceSimulationOptions = {},
): CoherentSurfaceSimulationResult {
  const design = normalizeCoherentAssemblyDesign(input);
  const assembly = evaluateCoherentAssembly(design);
  const splitter = evaluateBeamSplitter(design.beamSplitter);
  const sharedMaximum = Math.max(16, Math.min(2048, Math.round(finite(options.maximumDetectorPixels, 512))));
  const maximumDetectorPixelsX = Math.max(16, Math.min(2048, Math.round(finite(options.maximumDetectorPixelsX, sharedMaximum))));
  const maximumDetectorPixelsY = Math.max(16, Math.min(2048, Math.round(finite(options.maximumDetectorPixelsY, sharedMaximum))));
  const width = Math.max(16, Math.min(maximumDetectorPixelsX, Math.round(finite(design.detector.pixelCountX, 128))));
  const height = Math.max(16, Math.min(maximumDetectorPixelsY, Math.round(finite(design.detector.pixelCountY, 128))));
  const pitchMm = Math.max(1e-6, finite(design.detector.pixelPitchUm, 10) * 1e-3);
  const spectrum = (() => {
    if (design.source.kind === 'frequency-comb') {
      const lines = generateCombLines({
        centerWavelengthNm: Math.max(1e-6, finite(design.source.centerWavelengthNm, 600)),
        repetitionRateGHz: Math.max(1e-9, finite(design.source.repetitionRateGHz, 10)),
        offsetFrequencyMHz: finite(design.source.offsetFrequencyMHz, 0),
        lineCount: Math.max(3, Math.min(401, Math.round(finite(design.source.lineCount, 65)))),
        bandwidthNm: Math.max(1e-6, finite(design.source.bandwidthFwhmNm, 160)),
      });
      return { wavelengthNm: lines.map((line) => line.wavelengthNm), power: lines.map((line) => line.power) };
    }
    const minimumSamples = Math.max(17, Math.min(1025, Math.round(finite(options.minimumBroadbandSpectralSamples, 257))));
    return generateGaussianQuadratureSpectrum(
      Math.max(1e-6, finite(design.source.centerWavelengthNm, 600)),
      Math.max(1e-6, finite(design.source.bandwidthFwhmNm, 160)),
      Math.max(minimumSamples, Math.min(1025, Math.round(finite(design.source.spectralSamples, 65)))),
    );
  })();
  const routedBaseOpdMm = Number(options.baseOpdMm);
  const usesRoutedBaseOpd = Number.isFinite(routedBaseOpdMm);
  const spectralBaseOpdMm = spectrum.wavelengthNm.map((wavelengthNm) => (
    usesRoutedBaseOpd
      ? routedBaseOpdMm
      : calculatePathOpticalLengthMm(design, 'object', wavelengthNm)
        - calculatePathOpticalLengthMm(design, 'reference', wavelengthNm)
        + finite(design.calibrationOffsetMm)
  ));
  const xSpan = Math.max(1e-6, finite(design.target.spanMm, width * pitchMm));
  const xMm = Array.from({ length: width }, (_, index) => (index / Math.max(1, width - 1) - 0.5) * xSpan);
  const xSampleIntervalMm = xSpan / Math.max(1, width - 1);
  // The reference-arm calibration places the zero-delay ridge on a Detector
  // row.  Keeping that row explicit avoids losing a sub-micron broadband
  // coherence peak between the two middle pixels of an even-sized sensor.
  const yZeroIndex = Math.floor(height / 2);
  const yMm = Array.from({ length: height }, (_, index) => (index - yZeroIndex) * pitchMm);
  const targetHeightUm = xMm.map((x) => sampleTargetHeightUm(design.target, x));
  const intensityWPerPixel = new Float64Array(width * height);
  const normalizedIntensity = new Float64Array(width * height);
  const coherenceEnvelope = new Float64Array(width * height);
  const objectOpticalPathMm = finite(assembly.pathLengthMm.object);
  const referenceOpticalPathMm = finite(assembly.pathLengthMm.reference);
  const baseOpdMm = usesRoutedBaseOpd
    ? routedBaseOpdMm
    : objectOpticalPathMm - referenceOpticalPathMm + finite(design.calibrationOffsetMm);
  const totalPowerW = Math.max(0, finite(design.source.totalPowerW, 0.001));
  const commonPowerW = totalPowerW * clamp(finite(design.attenuatorTransmission, 0.5), 0, 1) * pathThroughput(design, 'common');
  const objectArmPowerW = commonPowerW * splitter.transmitted.power * splitter.reflected.power
    * clamp(finite(design.targetReflectance, 0.7), 0, 1) * pathThroughput(design, 'object');
  const referenceArmPowerW = commonPowerW * splitter.reflected.power * splitter.transmitted.power
    * clamp(finite(design.grating.efficiency, 0.75), 0, 1) * pathThroughput(design, 'reference');
  const pixelCount = width * height;
  const objectPixelPower = objectArmPowerW / pixelCount;
  const referencePixelPower = referenceArmPowerW / pixelCount;
  const crossAmplitude = 2 * Math.sqrt(Math.max(0, objectPixelPower * referencePixelPower)) * clamp(finite(design.visibility, 0.92), 0, 1);
  const dcPower = objectPixelPower + referencePixelPower;
  const centerGrating = evaluateReflectionGrating({
    wavelengthNm: design.source.centerWavelengthNm,
    grooveDensityLinesPerMm: design.grating.grooveDensityLinesPerMm,
    incidenceAngleDeg: design.grating.incidenceAngleDeg,
    order: design.grating.order,
    efficiency: design.grating.efficiency,
  });
  const centerSlope = centerGrating.propagating && Number.isFinite(centerGrating.diffractionAngleDeg)
    ? Math.sin(finite(centerGrating.diffractionAngleDeg) * Math.PI / 180) / Math.max(1e-12, Math.abs(finite(design.grating.detectorMagnification, 1)))
    : 0;
  let propagatingSamples = 0;
  const gratingByWavelength = spectrum.wavelengthNm.map((wavelengthNm) => {
    const result = evaluateReflectionGrating({
      wavelengthNm,
      grooveDensityLinesPerMm: design.grating.grooveDensityLinesPerMm,
      incidenceAngleDeg: design.grating.incidenceAngleDeg,
      order: design.grating.order,
      efficiency: design.grating.efficiency,
    });
    if (result.propagating) propagatingSamples += 1;
    return result;
  });
  const splitterPhase = splitter.transmitted.phaseRad + splitter.reflected.phaseRad;
  const propagatingSpectralPower = spectrum.power.map((weight, index) => (
    gratingByWavelength[index].propagating ? weight : 0
  ));
  const detectorDelayStepMm = pitchMm * centerSlope;
  const targetOplMm = targetHeightUm.map((heightUm) => 2 * heightUm * 1e-3);
  const detectorDelayMm = yMm.map((positionMm) => positionMm * centerSlope);
  const minimumRelativeDelayMm = Math.min(...targetOplMm) - Math.max(...detectorDelayMm);
  const maximumRelativeDelayMm = Math.max(...targetOplMm) - Math.min(...detectorDelayMm);
  const delayLookup = buildComplexDelayLookup(
    spectrum.wavelengthNm,
    propagatingSpectralPower,
    spectralBaseOpdMm,
    splitterPhase,
    minimumRelativeDelayMm,
    maximumRelativeDelayMm,
    detectorDelayStepMm,
  );

  for (let xi = 0; xi < width; xi += 1) {
    for (let yi = 0; yi < height; yi += 1) {
      const complex = delayLookup.sample(targetOplMm[xi] - detectorDelayMm[yi]);
      const index = yi * width + xi;
      intensityWPerPixel[index] = Math.max(0, dcPower + crossAmplitude * complex.real);
      coherenceEnvelope[index] = Math.hypot(complex.real, complex.imaginary);
    }
  }

  let maximum = 0;
  let integratedPowerW = 0;
  intensityWPerPixel.forEach((value) => {
    maximum = Math.max(maximum, value);
    integratedPowerW += value;
  });
  const denominator = Math.max(1e-30, maximum);
  for (let index = 0; index < intensityWPerPixel.length; index += 1) normalizedIntensity[index] = intensityWPerPixel[index] / denominator;

  // The grating and relay optics encode reference delay monotonically along
  // Detector Y.  Use that physical axis mapping directly.  Searching the
  // entire height range for the largest spectral magnitude at every Y is
  // ambiguous because secondary coherence lobes can be higher than the local
  // solution and can collapse a real Step back onto the zero-height branch.
  const calibrationMinUm = finite(options.calibrationMinUm, finite(design.detector.calibrationMinUm, -80));
  const calibrationMaxUm = finite(options.calibrationMaxUm, finite(design.detector.calibrationMaxUm, 80));
  const calibrationLowUm = Math.min(calibrationMinUm, calibrationMaxUm);
  const calibrationHighUm = Math.max(calibrationMinUm, calibrationMaxUm);
  const calibratedHeightByY = new Array<number>(height);
  const validRidgeRows: number[] = [];
  for (let yi = 0; yi < height; yi += 1) {
    const heightUm = (yMm[yi] * centerSlope - baseOpdMm) * 500;
    calibratedHeightByY[yi] = heightUm;
    if (heightUm >= calibrationLowUm && heightUm <= calibrationHighUm) validRidgeRows.push(yi);
  }
  const ridge = trackCoherenceRidge(
    coherenceEnvelope,
    width,
    height,
    validRidgeRows,
    calibratedHeightByY,
  );
  const recoveredHeightUm = new Array<number>(width);
  for (let xi = 0; xi < width; xi += 1) {
    const subpixelY = ridge.y[xi];
    const lower = Math.max(0, Math.min(height - 1, Math.floor(subpixelY)));
    const upper = Math.max(0, Math.min(height - 1, lower + 1));
    const fraction = subpixelY - lower;
    recoveredHeightUm[xi] = clamp(
      calibratedHeightByY[lower]
        + (calibratedHeightByY[upper] - calibratedHeightByY[lower]) * fraction,
      calibrationLowUm,
      calibrationHighUm,
    );
  }
  const errors = recoveredHeightUm.map((value, index) => value - targetHeightUm[index]);
  const rmsHeightErrorUm = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / Math.max(1, errors.length));
  const maxAbsHeightErrorUm = errors.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const warningMessages: string[] = [];
  const samplesPerTargetPeriod = design.target.kind === 'sine'
    ? Math.abs(finite(design.target.periodMm)) / Math.max(1e-12, xSampleIntervalMm)
    : null;
  const detectorHeightStepUm = Math.abs(detectorDelayStepMm) * 500;
  const carrierCyclesPerPixel = Math.abs(detectorDelayStepMm)
    / Math.max(1e-12, finite(design.source.centerWavelengthNm, 600) * 1e-6);
  const meanRidgeConfidence = ridge.confidence.reduce((sum, value) => sum + value, 0) / Math.max(1, ridge.confidence.length);
  if (assembly.confidence !== 'Exact') warningMessages.push(`Assembly dimensions are ${assembly.confidence.toLowerCase()}; replace estimated envelopes with catalogue dimensions for final packaging.`);
  if (assembly.collisions.length > 0) warningMessages.push(`${assembly.collisions.length} mechanical-envelope collision(s) detected.`);
  if (propagatingSamples < spectrum.wavelengthNm.length) warningMessages.push('Part of the source spectrum does not propagate in the selected grating order.');
  if (!(Math.abs(centerSlope) > 1e-12)) warningMessages.push('The reference wavefront has no usable detector-axis delay slope.');
  if (validRidgeRows.length < 3) warningMessages.push('The calibrated height range does not overlap enough Detector-Y rows.');
  if (samplesPerTargetPeriod !== null && samplesPerTargetPeriod < 8) warningMessages.push(`Sine profile is undersampled along Target X (${samplesPerTargetPeriod.toFixed(2)} samples/period; 8 or more recommended).`);
  if (meanRidgeConfidence < 0.1) warningMessages.push('Coherence-ridge confidence is low; increase broadband integration samples or narrow the calibrated height range.');
  if (recoveredHeightUm.some((value, index) => {
    const edge = Math.abs(value - targetHeightUm[index]);
    return edge > Math.max(1, Math.abs(targetHeightUm[index]) * 0.5);
  })) warningMessages.push('Some target heights fall outside the calibrated detector delay range.');

  return {
    width,
    height,
    xMm,
    yMm,
    targetHeightUm,
    recoveredHeightUm,
    detectedRidgeY: ridge.y,
    ridgeBreakBefore: ridge.breakBefore,
    ridgeConfidence: ridge.confidence,
    meanRidgeConfidence,
    spectralSampleCount: spectrum.wavelengthNm.length,
    xSampleIntervalMm,
    samplesPerTargetPeriod,
    detectorHeightStepUm,
    signalCoverageFraction: 1,
    cameraReferenceColumn: null,
    cameraReferenceXmm: null,
    carrierCyclesPerPixel,
    carrierAliased: carrierCyclesPerPixel > 0.5,
    measurementSampleCount: null,
    samplingLimited: false,
    intensityWPerPixel,
    normalizedIntensity,
    coherenceEnvelope,
    maxIntensityWPerPixel: maximum,
    integratedPowerW,
    rmsHeightErrorUm,
    maxAbsHeightErrorUm,
    propagatingFraction: propagatingSamples / Math.max(1, spectrum.wavelengthNm.length),
    objectOpticalPathMm,
    referenceOpticalPathMm,
    opticalPathDifferenceMm: baseOpdMm,
    warningMessages,
  };
}

function fftComplexInPlace(real: Float64Array, imaginary: Float64Array, inverse: boolean): void {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    while (reversed & bit) { reversed ^= bit; bit >>= 1; }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let size = 2; size <= length; size <<= 1) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < length; offset += size) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < size / 2; index += 1) {
        const even = offset + index;
        const odd = even + size / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < length; index += 1) {
      real[index] /= length;
      imaginary[index] /= length;
    }
  }
}

function removeMovingAverage(signal: Float64Array, radius: number): Float64Array {
  const length = signal.length;
  const prefix = new Float64Array(length + 1);
  for (let index = 0; index < length; index += 1) prefix[index + 1] = prefix[index] + signal[index];
  const residual = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const low = Math.max(0, index - radius);
    const high = Math.min(length, index + radius + 1);
    residual[index] = signal[index] - (prefix[high] - prefix[low]) / Math.max(1, high - low);
  }
  return residual;
}

/**
 * Returns the modulation envelope of one measured Camera column.
 *
 * Figure-2-style acquisition encodes reference-arm delay along Detector Y.
 * Surface depth is therefore the Y position of the white-light correlation
 * maximum, not the translation that best correlates a column with some other
 * Target-X column. A local modulation-RMS detector removes the optical carrier
 * while retaining that directly measured correlation maximum. Unlike a
 * Hilbert transform it remains well-defined when the sampled carrier lies at
 * (or aliases onto) the Camera Nyquist frequency.
 */
function extractCameraCoherenceEnvelope(
  intensity: Float64Array,
  backgroundRadius: number,
): Float64Array {
  const length = intensity.length;
  const residual = removeMovingAverage(intensity, backgroundRadius);

  // Normalize by the local DC illumination so vignetting and the exact-lens
  // PSF do not move the detected coherence maximum toward a brighter row.
  const prefix = new Float64Array(length + 1);
  const residualEnergyPrefix = new Float64Array(length + 1);
  let meanIntensity = 0;
  for (let index = 0; index < length; index += 1) {
    meanIntensity += Math.max(0, intensity[index]);
    prefix[index + 1] = prefix[index] + Math.max(0, intensity[index]);
    residualEnergyPrefix[index + 1] = residualEnergyPrefix[index] + residual[index] * residual[index];
  }
  meanIntensity /= Math.max(1, length);
  const illuminationFloor = Math.max(1e-30, meanIntensity * 1e-3);
  const rawEnvelope = new Float64Array(length);
  const modulationRadius = 1;
  for (let index = 0; index < length; index += 1) {
    const low = Math.max(0, index - backgroundRadius);
    const high = Math.min(length, index + backgroundRadius + 1);
    const localDc = (prefix[high] - prefix[low]) / Math.max(1, high - low);
    const modulationLow = Math.max(0, index - modulationRadius);
    const modulationHigh = Math.min(length, index + modulationRadius + 1);
    const modulationRms = Math.sqrt(
      (residualEnergyPrefix[modulationHigh] - residualEnergyPrefix[modulationLow])
        / Math.max(1, modulationHigh - modulationLow),
    );
    rawEnvelope[index] = modulationRms / Math.max(illuminationFloor, localDc);
  }

  // A one-pixel triangular filter suppresses Monte-Carlo pixel noise without
  // broadening a narrow white-light correlation line materially.
  const envelope = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const previous = rawEnvelope[Math.max(0, index - 1)];
    const current = rawEnvelope[index];
    const next = rawEnvelope[Math.min(length - 1, index + 1)];
    envelope[index] = (previous + 2 * current + next) * 0.25;
  }
  return envelope;
}

/** Selects the measured Camera-Y intensity maximum independently at each X. */
function detectCameraEnvelopeRidge(
  envelope: Float64Array,
  width: number,
  height: number,
  validRows: number[],
): RidgeTrackingResult {
  const rows = validRows.length ? validRows : Array.from({ length: height }, (_, index) => index);
  const y = new Array<number>(width).fill(rows[0] ?? 0);
  const confidence = new Array<number>(width).fill(0);
  for (let x = 0; x < width; x += 1) {
    let peakY = rows[0] ?? 0;
    let peak = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      const value = envelope[row * width + x];
      if (value > peak) {
        peak = value;
        peakY = row;
      }
    }
    let subpixelY = peakY;
    if (peakY > 0 && peakY + 1 < height) {
      const previous = envelope[(peakY - 1) * width + x];
      const current = envelope[peakY * width + x];
      const next = envelope[(peakY + 1) * width + x];
      const curvature = previous - 2 * current + next;
      if (Math.abs(curvature) > 1e-15) {
        subpixelY += clamp(0.5 * (previous - next) / curvature, -0.5, 0.5);
      }
    }
    let alternative = 0;
    for (const row of rows) {
      if (Math.abs(row - peakY) <= 2) continue;
      const value = envelope[row * width + x];
      const previous = row > 0 ? envelope[(row - 1) * width + x] : Number.NEGATIVE_INFINITY;
      const next = row + 1 < height ? envelope[(row + 1) * width + x] : Number.NEGATIVE_INFINITY;
      if (value >= previous && value >= next) alternative = Math.max(alternative, value);
    }
    y[x] = subpixelY;
    confidence[x] = clamp(1 - alternative / Math.max(1e-30, peak), 0, 1);
  }
  return {
    y,
    confidence,
    breakBefore: new Array<boolean>(width).fill(false),
  };
}

interface CameraColumnCorrelation {
  scoreByLag: Float64Array;
  minimumLag: number;
}

/**
 * Suppresses column-local correlation peak hops without consulting the Target
 * prescription.  A Hampel-style replacement removes isolated low-confidence
 * outliers, then a short Savitzky-Golay pass rejects Camera-column noise while
 * retaining smooth slope and curvature. Strong, well-measured discontinuities
 * divide the profile into separate segments so a real step is not rounded.
 */
function regularizeDifferentialCameraLag(
  rawLag: number[],
  confidence: number[],
  minimumLag: number,
  maximumLag: number,
): number[] {
  if (rawLag.length < 5) return [...rawLag];
  const robust = [...rawLag];
  const median = (values: number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) * 0.5;
  };
  for (let index = 2; index + 2 < rawLag.length; index += 1) {
    const neighborhood = rawLag.slice(index - 2, index + 3);
    const localMedian = median(neighborhood);
    const deviation = median(neighborhood.map((value) => Math.abs(value - localMedian)));
    const threshold = Math.max(1.25, deviation * 3.5);
    if (confidence[index] < 0.65 && Math.abs(rawLag[index] - localMedian) > threshold) {
      robust[index] = localMedian;
    }
  }

  const lagSpan = Math.max(1, maximumLag - minimumLag);
  const discontinuityThreshold = Math.max(8, lagSpan * 0.18);
  const breakBefore = robust.map((value, index) => (
    index > 0
      && Math.min(confidence[index - 1], confidence[index]) > 0.35
      && Math.abs(value - robust[index - 1]) > discontinuityThreshold
  ));
  const smoothOnce = (input: number[]): number[] => {
    const output = [...input];
    // Five-point quadratic Savitzky-Golay coefficients. At the current
    // >20 Camera samples/period this removes pixel-scale jitter without
    // attenuating the measured Sine amplitude.
    const coefficients = [-3, 12, 17, 12, -3];
    for (let index = 2; index + 2 < input.length; index += 1) {
      let crossesBreak = false;
      for (let cursor = index - 1; cursor <= index + 2; cursor += 1) {
        if (breakBefore[cursor]) { crossesBreak = true; break; }
      }
      if (crossesBreak) continue;
      let value = 0;
      for (let offset = -2; offset <= 2; offset += 1) value += coefficients[offset + 2] * input[index + offset];
      output[index] = clamp(value / 35, minimumLag, maximumLag);
    }
    return output;
  };
  return smoothOnce(smoothOnce(robust));
}

/**
 * Normalized linear cross-correlation of two measured Camera columns.  The
 * FFT supplies the numerator; overlap-specific energy normalization prevents
 * large lags from winning merely because fewer Detector pixels overlap.
 */
function correlateCameraColumns(
  signal: Float64Array,
  reference: Float64Array,
  minimumLag: number,
  maximumLag: number,
): CameraColumnCorrelation {
  const length = Math.min(signal.length, reference.length);
  let fftLength = 1;
  while (fftLength < length * 2) fftLength <<= 1;
  const signalReal = new Float64Array(fftLength);
  const signalImaginary = new Float64Array(fftLength);
  const referenceReal = new Float64Array(fftLength);
  const referenceImaginary = new Float64Array(fftLength);
  signalReal.set(signal.subarray(0, length));
  referenceReal.set(reference.subarray(0, length));
  fftComplexInPlace(signalReal, signalImaginary, false);
  fftComplexInPlace(referenceReal, referenceImaginary, false);
  for (let index = 0; index < fftLength; index += 1) {
    const signalRe = signalReal[index];
    const signalIm = signalImaginary[index];
    const referenceRe = referenceReal[index];
    const referenceIm = referenceImaginary[index];
    signalReal[index] = signalRe * referenceRe + signalIm * referenceIm;
    signalImaginary[index] = signalIm * referenceRe - signalRe * referenceIm;
  }
  fftComplexInPlace(signalReal, signalImaginary, true);
  const signalEnergy = new Float64Array(length + 1);
  const referenceEnergy = new Float64Array(length + 1);
  for (let index = 0; index < length; index += 1) {
    signalEnergy[index + 1] = signalEnergy[index] + signal[index] * signal[index];
    referenceEnergy[index + 1] = referenceEnergy[index] + reference[index] * reference[index];
  }
  const lowLag = Math.max(-(length - 2), Math.ceil(minimumLag));
  const highLag = Math.min(length - 2, Math.floor(maximumLag));
  const scoreByLag = new Float64Array(Math.max(1, highLag - lowLag + 1));
  for (let lag = lowLag; lag <= highLag; lag += 1) {
    const signalLow = Math.max(0, lag);
    const signalHigh = Math.min(length, length + lag);
    const referenceLow = signalLow - lag;
    const referenceHigh = signalHigh - lag;
    const numeratorIndex = lag >= 0 ? lag : fftLength + lag;
    const numerator = signalReal[numeratorIndex];
    const signalNorm = signalEnergy[signalHigh] - signalEnergy[signalLow];
    const referenceNorm = referenceEnergy[referenceHigh] - referenceEnergy[referenceLow];
    scoreByLag[lag - lowLag] = clamp(
      numerator / Math.sqrt(Math.max(Number.MIN_VALUE, signalNorm * referenceNorm)),
      0,
      1,
    );
  }
  return { scoreByLag, minimumLag: lowLag };
}

/**
 * Measures the movement of the white-light interferogram against a separately
 * acquired flat-Target Camera capture.  The flat image removes relay
 * curvature, pupil phase and fixed Camera-Y shear per Target-X column; only
 * the measured Camera rasters enter this differential estimate.
 */
function detectDifferentialCameraRidge(
  measuredSignal: Float64Array,
  flatSignal: Float64Array,
  width: number,
  height: number,
  minimumLag: number,
  maximumLag: number,
  flatRidge: RidgeTrackingResult,
  peakExclusionRadius = 2,
): { ridge: RidgeTrackingResult; lag: number[] } {
  const measuredColumn = new Float64Array(height);
  const flatColumn = new Float64Array(height);
  const lag = new Array<number>(width).fill(0);
  const confidence = new Array<number>(width).fill(0);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      measuredColumn[y] = measuredSignal[y * width + x];
      flatColumn[y] = flatSignal[y * width + x];
    }
    const correlation = correlateCameraColumns(
      measuredColumn,
      flatColumn,
      minimumLag,
      maximumLag,
    );
    let peakIndex = 0;
    for (let index = 1; index < correlation.scoreByLag.length; index += 1) {
      if (correlation.scoreByLag[index] > correlation.scoreByLag[peakIndex]) peakIndex = index;
    }
    let subpixelIndex = peakIndex;
    if (peakIndex > 0 && peakIndex + 1 < correlation.scoreByLag.length) {
      const previous = correlation.scoreByLag[peakIndex - 1];
      const current = correlation.scoreByLag[peakIndex];
      const next = correlation.scoreByLag[peakIndex + 1];
      const curvature = previous - 2 * current + next;
      if (Math.abs(curvature) > 1e-15) {
        subpixelIndex += clamp(0.5 * (previous - next) / curvature, -0.5, 0.5);
      }
    }
    const selectedLag = correlation.minimumLag + subpixelIndex;
    lag[x] = selectedLag;
    const peak = correlation.scoreByLag[peakIndex];
    let alternative = 0;
    for (let index = 0; index < correlation.scoreByLag.length; index += 1) {
      if (Math.abs(index - peakIndex) <= peakExclusionRadius) continue;
      alternative = Math.max(alternative, correlation.scoreByLag[index]);
    }
    confidence[x] = clamp(1 - alternative / Math.max(1e-30, peak), 0, 1);
  }
  const regularizedLag = regularizeDifferentialCameraLag(lag, confidence, minimumLag, maximumLag);
  const y = regularizedLag.map((value, index) => clamp(flatRidge.y[index] + value, 0, height - 1));
  return {
    lag: regularizedLag,
    ridge: {
      y,
      confidence,
      breakBefore: new Array<boolean>(width).fill(false),
    },
  };
}

/**
 * Reconstructs a surface strictly from the Camera power raster.  Optical Route
 * OPD and Detector/Grating calibration convert the detected Y ridge to height;
 * the optional Target profile is evaluated only after reconstruction for the
 * gray comparison curve and error metrics.
 */
export function reconstructSurfaceFromDetectorSignal(
  options: CoherentDetectorReconstructionOptions,
): CoherentSurfaceSimulationResult {
  const detectorWidth = Math.max(1, Math.round(finite(options.width, 1)));
  const sourceHeight = Math.max(1, Math.round(finite(options.height, 1)));
  const cameraXMin = clamp(Math.round(finite(options.cameraXMin, 0)), 0, detectorWidth - 1);
  const cameraXMax = clamp(
    Math.round(finite(options.cameraXMax, detectorWidth - 1)),
    cameraXMin,
    detectorWidth - 1,
  );
  const sourceWidth = cameraXMax - cameraXMin + 1;
  const requestedMaximumWidth = Math.max(16, Math.min(2048, Math.round(finite(options.maximumDetectorPixelsX, 1024))));
  const measurementSampleCount = Number(options.measurementSampleCount);
  // A reconstructed profile point is inferred from a Camera column rather
  // than from a single ray.  Keep enough physical Detector hits in every
  // resampled column for the current/flat column correlation to be stable.
  const minimumSamplesPerProfilePoint = 64;
  const samplingLimitedWidth = Number.isFinite(measurementSampleCount) && measurementSampleCount > 0
    ? Math.max(16, Math.floor(measurementSampleCount / minimumSamplesPerProfilePoint))
    : requestedMaximumWidth;
  const maximumWidth = Math.min(requestedMaximumWidth, samplingLimitedWidth);
  const maximumHeight = Math.max(16, Math.min(2048, Math.round(finite(options.maximumDetectorPixelsY, 2048))));
  let width = Math.max(1, Math.min(sourceWidth, maximumWidth));
  const height = Math.max(1, Math.min(sourceHeight, maximumHeight));
  const pitchMm = Math.max(1e-9, finite(options.detector.pixelPitchUm, 5) * 1e-3);
  const configuredTargetSpanMm = Math.max(1e-9, Math.abs(finite(options.targetSpanMm, sourceWidth * pitchMm)));
  const mappedTargetXMinMm = finite(options.targetXMinMm, -configuredTargetSpanMm * 0.5);
  const mappedTargetXMaxMm = finite(options.targetXMaxMm, configuredTargetSpanMm * 0.5);
  const mappedTargetLowMm = Math.min(mappedTargetXMinMm, mappedTargetXMaxMm);
  const mappedTargetHighMm = Math.max(mappedTargetXMinMm, mappedTargetXMaxMm);
  const xSpanMm = Math.max(1e-9, mappedTargetHighMm - mappedTargetLowMm);
  const xSampleIntervalMm = xSpanMm / Math.max(1, width - 1);
  const samplingLimited = width < Math.min(sourceWidth, requestedMaximumWidth);
  const xMm = Array.from({ length: width }, (_, index) => (
    mappedTargetXMinMm + index / Math.max(1, width - 1) * (mappedTargetXMaxMm - mappedTargetXMinMm)
  ));
  const yZeroIndex = Math.floor(height / 2);
  const yMm = Array.from({ length: height }, (_, index) => (index - yZeroIndex) * pitchMm);

  // Area-average Camera X pixels into the reconstruction grid. Detector Y is
  // preserved because it is the calibrated delay/depth axis.
  const intensityWPerPixel = new Float64Array(width * height);
  let integratedPowerW = 0;
  let maximum = 0;
  for (let sourceY = 0; sourceY < sourceHeight; sourceY += 1) {
    for (let sourceX = 0; sourceX < sourceWidth; sourceX += 1) {
      const detectorX = cameraXMin + sourceX;
      const value = Math.max(0, finite(options.powerWPerPixel[sourceY * detectorWidth + detectorX]));
      integratedPowerW += value;
    }
  }
  for (let y = 0; y < height; y += 1) {
    const sourceY0 = Math.floor(y * sourceHeight / height);
    const sourceY1 = Math.max(sourceY0 + 1, Math.floor((y + 1) * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX0 = Math.floor(x * sourceWidth / width);
      const sourceX1 = Math.max(sourceX0 + 1, Math.floor((x + 1) * sourceWidth / width));
      let sum = 0;
      let samples = 0;
      for (let sourceY = sourceY0; sourceY < Math.min(sourceHeight, sourceY1); sourceY += 1) {
        for (let sourceX = sourceX0; sourceX < Math.min(sourceWidth, sourceX1); sourceX += 1) {
          const detectorX = cameraXMin + sourceX;
          sum += Math.max(0, finite(options.powerWPerPixel[sourceY * detectorWidth + detectorX]));
          samples += 1;
        }
      }
      const value = sum / Math.max(1, samples);
      intensityWPerPixel[y * width + x] = value;
      maximum = Math.max(maximum, value);
    }
  }
  const normalizedIntensity = new Float64Array(width * height);
  for (let index = 0; index < intensityWPerPixel.length; index += 1) {
    normalizedIntensity[index] = intensityWPerPixel[index] / Math.max(1e-30, maximum);
  }

  const flatReferenceIntensity = options.flatReferencePowerWPerPixel
    ? new Float64Array(width * height)
    : null;
  if (flatReferenceIntensity) {
    for (let y = 0; y < height; y += 1) {
      const sourceY0 = Math.floor(y * sourceHeight / height);
      const sourceY1 = Math.max(sourceY0 + 1, Math.floor((y + 1) * sourceHeight / height));
      for (let x = 0; x < width; x += 1) {
        const sourceX0 = Math.floor(x * sourceWidth / width);
        const sourceX1 = Math.max(sourceX0 + 1, Math.floor((x + 1) * sourceWidth / width));
        let sum = 0;
        let samples = 0;
        for (let sourceY = sourceY0; sourceY < Math.min(sourceHeight, sourceY1); sourceY += 1) {
          for (let sourceX = sourceX0; sourceX < Math.min(sourceWidth, sourceX1); sourceX += 1) {
            const detectorX = cameraXMin + sourceX;
            sum += Math.max(0, finite(options.flatReferencePowerWPerPixel![sourceY * detectorWidth + detectorX]));
            samples += 1;
          }
        }
        flatReferenceIntensity[y * width + x] = sum / Math.max(1, samples);
      }
    }
  }

  const centerGrating = evaluateReflectionGrating({
    wavelengthNm: Math.max(1e-6, finite(options.sourceCenterWavelengthNm, 600)),
    grooveDensityLinesPerMm: options.grating.grooveDensityLinesPerMm,
    incidenceAngleDeg: options.grating.incidenceAngleDeg,
    order: options.grating.order,
    efficiency: options.grating.efficiency,
  });
  const centerSlope = centerGrating.propagating && Number.isFinite(centerGrating.diffractionAngleDeg)
    ? Math.sin(finite(centerGrating.diffractionAngleDeg) * Math.PI / 180)
      / Math.max(1e-12, Math.abs(finite(options.grating.detectorMagnification, 1)))
    : 0;
  const detectorDelayStepMm = pitchMm * centerSlope;
  const detectorHeightStepUm = Math.abs(detectorDelayStepMm) * 500;
  const centerWavelengthMm = Math.max(1e-9, finite(options.sourceCenterWavelengthNm, 600) * 1e-6);
  const cyclesPerPixel = Math.abs(detectorDelayStepMm / centerWavelengthMm);
  const aliasedCyclesPerPixel = Math.abs(cyclesPerPixel - Math.round(cyclesPerPixel));
  const carrierPeriodPixels = aliasedCyclesPerPixel > 1e-4 ? 1 / aliasedCyclesPerPixel : 8;
  const backgroundRadius = Math.max(12, Math.min(96, Math.round(carrierPeriodPixels * 7)));

  // The configured profile maps to Detector X while reference-arm OPL maps to
  // Detector Y. Extract the white-light correlation envelope independently in
  // every measured column. A flat capture is a system calibration only; it is
  // never used as a template in a column-correlation decoder.
  const coherenceEnvelope = new Float64Array(width * height);
  const flatReferenceEnvelope = flatReferenceIntensity ? new Float64Array(width * height) : null;
  const correlationSignal = new Float64Array(width * height);
  const flatCorrelationSignal = flatReferenceIntensity ? new Float64Array(width * height) : null;
  const columnEnergy = new Float64Array(width);
  const column = new Float64Array(height);
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) column[y] = intensityWPerPixel[y * width + x];
    const envelope = extractCameraCoherenceEnvelope(column, backgroundRadius);
    const residual = removeMovingAverage(column, backgroundRadius);
    let energy = 0;
    for (let y = 0; y < height; y += 1) {
      const value = envelope[y];
      coherenceEnvelope[y * width + x] = value;
      correlationSignal[y * width + x] = residual[y];
      energy += value * value;
    }
    columnEnergy[x] = energy;
    if (flatReferenceIntensity && flatReferenceEnvelope) {
      for (let y = 0; y < height; y += 1) column[y] = flatReferenceIntensity[y * width + x];
      const flatEnvelope = extractCameraCoherenceEnvelope(column, backgroundRadius);
      const flatResidual = removeMovingAverage(column, backgroundRadius);
      for (let y = 0; y < height; y += 1) {
        flatReferenceEnvelope[y * width + x] = flatEnvelope[y];
        flatCorrelationSignal![y * width + x] = flatResidual[y];
      }
    }
  }
  let strongestColumnEnergy = 0;
  columnEnergy.forEach((value) => { strongestColumnEnergy = Math.max(strongestColumnEnergy, value); });
  const requestedReferenceColumn = Math.round(finite(options.referenceColumn, Number.NaN));
  const strongestCameraColumn = columnEnergy.reduce(
    (best, value, index, array) => value > array[best] ? index : best,
    0,
  );
  const cameraReferenceColumn = Number.isFinite(requestedReferenceColumn)
    ? Math.max(0, Math.min(width - 1, requestedReferenceColumn))
    : strongestCameraColumn;
  const cameraReferenceXmm = xMm[cameraReferenceColumn] ?? mappedTargetXMinMm;
  const referenceHeightUm = finite(options.referenceHeightUm, 0);

  const calibrationLowUm = Math.min(finite(options.calibrationMinUm, -80), finite(options.calibrationMaxUm, 80));
  const calibrationHighUm = Math.max(finite(options.calibrationMinUm, -80), finite(options.calibrationMaxUm, 80));
  const signedDetectorHeightStepUm = detectorDelayStepMm * 500;
  const safeSignedHeightStepUm = Math.abs(signedDetectorHeightStepUm) > 1e-12 ? signedDetectorHeightStepUm : 1;
  const validRidgeRows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const detectorHeightUm = (y - yZeroIndex) * safeSignedHeightStepUm;
    // Read the white-light intensity maximum inside the calibrated Detector-Y
    // depth span. Searching the full sensor would admit periodic
    // correlation replicas caused by the finite/discrete simulated spectrum.
    // A flat capture establishes the system zero but is not a column template;
    // both flat and measured maxima are selected independently in this same
    // physical height window.
    const absoluteHeightUm = referenceHeightUm + detectorHeightUm - finite(options.baseOpdMm) * 500;
    if (absoluteHeightUm >= calibrationLowUm && absoluteHeightUm <= calibrationHighUm) validRidgeRows.push(y);
  }

  const directRidge = detectCameraEnvelopeRidge(coherenceEnvelope, width, height, validRidgeRows);
  const flatRidge = flatReferenceEnvelope
    ? detectCameraEnvelopeRidge(flatReferenceEnvelope, width, height, validRidgeRows)
    : null;
  const minimumDifferentialLag = Math.floor(Math.min(
    (calibrationLowUm - referenceHeightUm) / safeSignedHeightStepUm,
    (calibrationHighUm - referenceHeightUm) / safeSignedHeightStepUm,
  ));
  const maximumDifferentialLag = Math.ceil(Math.max(
    (calibrationLowUm - referenceHeightUm) / safeSignedHeightStepUm,
    (calibrationHighUm - referenceHeightUm) / safeSignedHeightStepUm,
  ));
  const differential = flatReferenceEnvelope && flatCorrelationSignal && flatRidge
    ? detectDifferentialCameraRidge(
      correlationSignal,
      flatCorrelationSignal,
      width,
      height,
      minimumDifferentialLag,
      maximumDifferentialLag,
      flatRidge,
      8,
    )
    : null;
  const ridge = differential?.ridge ?? directRidge;
  const recoveredHeightUm = ridge.y.map((subpixelY, index) => clamp(
    referenceHeightUm + (differential
      ? differential.lag[index] * safeSignedHeightStepUm
      : (subpixelY - yZeroIndex) * safeSignedHeightStepUm - finite(options.baseOpdMm) * 500),
    calibrationLowUm,
    calibrationHighUm,
  ));
  ridge.breakBefore = recoveredHeightUm.map((value, index) => (
    index > 0 && Math.abs(value - recoveredHeightUm[index - 1]) > Math.max(detectorHeightStepUm * 12, (calibrationHighUm - calibrationLowUm) * 0.2)
  ));

  const targetHeightUm = options.comparisonTarget
    ? xMm.map((x) => sampleTargetHeightUm(options.comparisonTarget!, x))
    : new Array<number>(width).fill(Number.NaN);
  const errors = recoveredHeightUm
    .map((value, index) => value - targetHeightUm[index])
    .filter(Number.isFinite);
  const rmsHeightErrorUm = errors.length
    ? Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length)
    : Number.NaN;
  const maxAbsHeightErrorUm = errors.length
    ? errors.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    : Number.NaN;
  let envelopeMaximum = 0;
  coherenceEnvelope.forEach((value) => { envelopeMaximum = Math.max(envelopeMaximum, value); });
  // A differential flat-reference reconstruction measures a Camera-Y lag,
  // so the absolute routed OPD does not need to lie inside the relative
  // height-calibration window.  detectCameraEnvelopeRidge already falls back
  // to the full detector when that absolute window contains no rows; use the
  // same rows for coverage or an otherwise valid differential reconstruction
  // is incorrectly reported as 0% signal coverage.
  const coverageRows = differential
    ? Array.from({ length: height }, (_, index) => index)
    : validRidgeRows;
  let coveredColumns = 0;
  for (let x = 0; x < width; x += 1) {
    let columnMaximum = 0;
    for (const y of coverageRows) columnMaximum = Math.max(columnMaximum, coherenceEnvelope[y * width + x]);
    if (columnMaximum > envelopeMaximum * 1e-4) coveredColumns += 1;
  }
  const signalCoverageFraction = coveredColumns / Math.max(1, width);
  const meanRidgeConfidence = ridge.confidence.reduce((sum, value) => sum + value, 0) / Math.max(1, ridge.confidence.length);
  const bandwidthFwhmNm = Math.abs(finite(options.sourceBandwidthFwhmNm));
  const coherenceEnvelopeFwhmUm = bandwidthFwhmNm > 1e-12
    ? 0.0002205 * Math.pow(Math.max(1e-6, finite(options.sourceCenterWavelengthNm, 600)), 2) / bandwidthFwhmNm
    : Number.NaN;
  const envelopeSamplesPerFwhm = Number.isFinite(coherenceEnvelopeFwhmUm)
    ? coherenceEnvelopeFwhmUm / Math.max(1e-12, detectorHeightStepUm)
    : Number.NaN;
  const samplesPerTargetPeriod = options.comparisonTarget?.kind === 'sine'
    ? Math.abs(finite(options.comparisonTarget.periodMm)) / Math.max(1e-12, xSampleIntervalMm)
    : null;
  const warningMessages: string[] = [];
  if (!(maximum > 0)) warningMessages.push('Camera power raster contains no measurable signal.');
  if (!(Math.abs(centerSlope) > 1e-12)) warningMessages.push('The grating provides no usable Detector-Y depth calibration.');
  if (validRidgeRows.length < 3) warningMessages.push('The calibrated height range does not overlap enough Detector-Y rows.');
  if (signalCoverageFraction < 0.8) warningMessages.push(`Camera signal covers only ${(signalCoverageFraction * 100).toFixed(1)}% of Target-X reconstruction columns.`);
  if (meanRidgeConfidence < 0.2) warningMessages.push('Camera-derived white-light ridge confidence is low; increase Detector rays/wavelength, improve arm overlap, or increase fringe visibility.');
  if (Number.isFinite(envelopeSamplesPerFwhm) && envelopeSamplesPerFwhm < 2) warningMessages.push(`The white-light correlation envelope is undersampled (${envelopeSamplesPerFwhm.toFixed(2)} Camera pixels/FWHM; 2 or more required).`);
  if (cyclesPerPixel > 0.5) warningMessages.push(`The optical fringe carrier is undersampled (${cyclesPerPixel.toFixed(3)} cycles/Camera pixel); Figure-2 height still uses the directly detected white-light envelope position, not aliased fringe phase.`);
  if (samplingLimited) warningMessages.push(`Camera sampling provides ${Math.round(measurementSampleCount).toLocaleString()} Detector hits; Target-X reconstruction is binned to ${width.toLocaleString()} points (about ${minimumSamplesPerProfilePoint} hits/point required). Increase Detector rays/wavelength for finer recovery.`);
  if (samplesPerTargetPeriod !== null && samplesPerTargetPeriod < 8) warningMessages.push(`Sine profile is undersampled along Target X (${samplesPerTargetPeriod.toFixed(2)} samples/period; 8 or more recommended).`);
  const targetCoverageFraction = xSpanMm / configuredTargetSpanMm;
  if (targetCoverageFraction < 0.8) warningMessages.push(`The measurement route samples only ${xSpanMm.toFixed(3)} mm (${(targetCoverageFraction * 100).toFixed(1)}%) of the configured ${configuredTargetSpanMm.toFixed(3)} mm Target span. Unsampled Target regions are not reconstructed.`);
  if (!flatReferenceEnvelope) warningMessages.push('No flat Camera calibration was acquired; absolute height uses the routed OPD and grating-axis calibration.');

  return {
    width,
    height,
    xMm,
    yMm,
    targetHeightUm,
    recoveredHeightUm,
    detectedRidgeY: ridge.y,
    ridgeBreakBefore: ridge.breakBefore,
    ridgeConfidence: ridge.confidence,
    meanRidgeConfidence,
    spectralSampleCount: Math.max(0, Math.round(finite(options.spectralSampleCount))),
    xSampleIntervalMm,
    samplesPerTargetPeriod,
    detectorHeightStepUm,
    signalCoverageFraction,
    cameraReferenceColumn,
    cameraReferenceXmm,
    carrierCyclesPerPixel: cyclesPerPixel,
    carrierAliased: cyclesPerPixel > 0.5,
    coherenceEnvelopeFwhmUm,
    envelopeSamplesPerFwhm,
    flatReferenceApplied: Boolean(flatReferenceEnvelope),
    measurementSampleCount: Number.isFinite(measurementSampleCount) ? Math.max(0, Math.round(measurementSampleCount)) : null,
    samplingLimited,
    intensityWPerPixel,
    normalizedIntensity,
    coherenceEnvelope,
    maxIntensityWPerPixel: maximum,
    integratedPowerW,
    rmsHeightErrorUm,
    maxAbsHeightErrorUm,
    propagatingFraction: centerGrating.propagating ? 1 : 0,
    objectOpticalPathMm: Number.NaN,
    referenceOpticalPathMm: Number.NaN,
    opticalPathDifferenceMm: finite(options.baseOpdMm),
    warningMessages,
  };
}
