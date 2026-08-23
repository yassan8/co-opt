import {
  evaluateBeamSplitter,
  evaluateReflectionGrating,
  generateGaussianSpectrum,
  generateCombLines,
  type BeamSplitterSpec,
} from './coherent-interferometer.ts';

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
  autoPlace?: boolean;
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
  rootTransform: ComponentTransform;
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
  divergenceDeg?: number;
  spatialProfile?: 'gaussian' | 'top-hat';
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
  preset: 'custom-hybrid' | 'patent-fig-2' | 'comb-grating-area' | 'patent-fig-14-dual-comb';
  revision?: number;
  name: string;
  components: CoherentPhysicalComponent[];
  connections: CoherentConnection[];
  paths: CoherentPathDefinition[];
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

export interface Fig2SimulationResult {
  width: number;
  height: number;
  xMm: number[];
  yMm: number[];
  targetHeightUm: number[];
  recoveredHeightUm: number[];
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

function component(input: Omit<CoherentPhysicalComponent, 'manualOffset' | 'ports'> & { ports?: OpticalPort[] }): CoherentPhysicalComponent {
  return {
    ...input,
    manualOffset: identityOffset(),
    ports: input.ports ?? defaultPorts(input.dimensions.depthMm),
  };
}
/**
 * Patent Fig. 2 physical-layout starting point. Dimensions are deliberately
 * marked Estimated until the user enters catalogue or measured dimensions.
 */
export function createPatentFig2AssemblyDesign(): CoherentAssemblyDesign {
  const components: CoherentPhysicalComponent[] = [
    component({
      id: 'source-11', label: 'Broadband source', reference: '11', kind: 'source', shape: 'box',
      autoTransform: transform(0, 0, -300), dimensions: { widthMm: 36, heightMm: 28, depthMm: 48 },
      dimensionConfidence: 'Estimated', pathIds: ['common'], powerEfficiency: 1,
    }),
    component({
      id: 'mirror-21', label: 'Fold mirror', reference: '21', kind: 'mirror', shape: 'cylinder',
      autoTransform: transform(0, 0, -250, 0, -45, 0), dimensions: { widthMm: 25, heightMm: 25, depthMm: 5, apertureDiameterMm: 22 },
      dimensionConfidence: 'Estimated', pathIds: ['common'], powerEfficiency: 0.98,
      ports: [
        { id: 'in', label: 'Input', localPositionMm: vector(0, 0, 0), localDirection: vector(-1 / Math.SQRT2, 0, -1 / Math.SQRT2) },
        { id: 'out', label: 'Output', localPositionMm: vector(0, 0, 0), localDirection: vector(1 / Math.SQRT2, 0, -1 / Math.SQRT2) },
      ],
    }),
    component({
      id: 'attenuator-22', label: 'ND filter', reference: '22', kind: 'attenuator', shape: 'box',
      autoTransform: transform(40, 0, -250, 0, 90, 0), dimensions: { widthMm: 25, heightMm: 25, depthMm: 3, apertureDiameterMm: 20 },
      dimensionConfidence: 'Estimated', pathIds: ['common'], powerEfficiency: 0.5,
    }),
    component({
      id: 'beam-expander-23a', label: 'Beam expander L1', reference: '23a', kind: 'lens', shape: 'lens',
      autoTransform: transform(80, 0, -250, 0, 90, 0), dimensions: { widthMm: 20, heightMm: 20, depthMm: 4, apertureDiameterMm: 18, frontRadiusMm: -28, backRadiusMm: 28, centerThicknessMm: 4 },
      dimensionConfidence: 'Estimated', pathIds: ['common'], powerEfficiency: 0.99, refractiveIndexNd: 1.5168, abbeNumber: 64.17, metadata: { focalLengthMm: -25 },
    }),
    component({
      id: 'beam-expander-23b', label: 'Beam expander L2', reference: '23b', kind: 'lens', shape: 'lens',
      autoTransform: transform(110, 0, -250, 0, 90, 0), dimensions: { widthMm: 30, heightMm: 30, depthMm: 5, apertureDiameterMm: 28, frontRadiusMm: 45, backRadiusMm: -45, centerThicknessMm: 5 },
      dimensionConfidence: 'Estimated', pathIds: ['common'], powerEfficiency: 0.99, refractiveIndexNd: 1.5168, abbeNumber: 64.17, metadata: { focalLengthMm: 50 },
    }),
    component({
      id: 'beam-splitter-24', label: 'Beam splitter', reference: '24', kind: 'beam-splitter', shape: 'box',
      autoTransform: transform(150, 0, -250, 0, -45, 0), dimensions: { widthMm: 20, heightMm: 20, depthMm: 20, apertureDiameterMm: 18 },
      dimensionConfidence: 'Estimated', pathIds: ['common', 'object', 'reference', 'detector'], powerEfficiency: 1,
      ports: [
        { id: 'common', label: 'Common', localPositionMm: vector(0, 0, 0), localDirection: vector(-1 / Math.SQRT2, 0, 1 / Math.SQRT2) },
        { id: 'object', label: 'Object arm', localPositionMm: vector(0, 0, 0), localDirection: vector(1 / Math.SQRT2, 0, -1 / Math.SQRT2) },
        { id: 'reference', label: 'Reference arm', localPositionMm: vector(0, 0, 0), localDirection: vector(1 / Math.SQRT2, 0, 1 / Math.SQRT2) },
        { id: 'detector', label: 'Detector', localPositionMm: vector(0, 0, 0), localDirection: vector(-1 / Math.SQRT2, 0, -1 / Math.SQRT2) },
      ],
    }),
    component({
      id: 'cylindrical-lens-25', label: 'Cylindrical lens', reference: '25', kind: 'cylindrical-lens', shape: 'box',
      autoTransform: transform(190, 0, -250, 0, 90, 0), dimensions: { widthMm: 30, heightMm: 25, depthMm: 5, apertureDiameterMm: 22 },
      dimensionConfidence: 'Estimated', pathIds: ['object'], powerEfficiency: 0.99, refractiveIndexNd: 1.5168, abbeNumber: 64.17, metadata: { focalLengthXmm: 1000000000, focalLengthYmm: 1000 },
    }),
    component({
      id: 'focus-lens-26', label: 'Object focusing lens', reference: '26', kind: 'lens', shape: 'lens',
      autoTransform: transform(240, 0, -250, 0, 90, 0), dimensions: { widthMm: 30, heightMm: 30, depthMm: 6, apertureDiameterMm: 28, frontRadiusMm: 50, backRadiusMm: -50, centerThicknessMm: 6 },
      dimensionConfidence: 'Estimated', pathIds: ['object'], powerEfficiency: 0.99, refractiveIndexNd: 1.5168, abbeNumber: 64.17, metadata: { focalLengthMm: 200 },
    }),
    component({
      id: 'target-100', label: 'Measurement target', reference: '100', kind: 'target', shape: 'box',
      autoTransform: transform(400, 0, -250, 0, 90, 0), dimensions: { widthMm: 55, heightMm: 55, depthMm: 6 },
      dimensionConfidence: 'Estimated', pathIds: ['object'], powerEfficiency: 0.7,
    }),
    component({
      id: 'focus-lens-27', label: 'Reference lens 1', reference: '27', kind: 'lens', shape: 'lens',
      autoTransform: transform(150, 0, -160), dimensions: { widthMm: 25, heightMm: 25, depthMm: 5.5, apertureDiameterMm: 23, frontRadiusMm: 42, backRadiusMm: -42, centerThicknessMm: 5.5 },
      dimensionConfidence: 'Estimated', pathIds: ['reference'], powerEfficiency: 0.99, refractiveIndexNd: 1.5168, abbeNumber: 64.17, metadata: { focalLengthMm: 400 },
    }),
    component({
      id: 'focus-lens-28', label: 'Reference lens 2', reference: '28', kind: 'lens', shape: 'lens',
      autoTransform: transform(150, 0, -100), dimensions: { widthMm: 25, heightMm: 25, depthMm: 5.5, apertureDiameterMm: 23, frontRadiusMm: 42, backRadiusMm: -42, centerThicknessMm: 5.5 },
      dimensionConfidence: 'Estimated', pathIds: ['reference'], powerEfficiency: 0.99, refractiveIndexNd: 1.5168, abbeNumber: 64.17, metadata: { focalLengthMm: 100 },
    }),
    component({
      id: 'grating-70', label: 'Reflection grating', reference: '70', kind: 'reflection-grating', shape: 'box',
      autoTransform: transform(150, 0, 0, 0, 10.369, 0), dimensions: { widthMm: 30, heightMm: 30, depthMm: 6, apertureDiameterMm: 25 },
      dimensionConfidence: 'Estimated', pathIds: ['reference'], powerEfficiency: 0.75,
    }),
    component({
      id: 'detector-80', label: '2D detector', reference: '80', kind: 'detector', shape: 'box',
      autoTransform: transform(150, 0, -340), dimensions: { widthMm: 36, heightMm: 32, depthMm: 18 },
      dimensionConfidence: 'Estimated', pathIds: ['detector'], powerEfficiency: 1,
    }),
  ];

  const paths: CoherentPathDefinition[] = [
    { id: 'common', label: 'Common path', componentIds: ['source-11', 'mirror-21', 'attenuator-22', 'beam-expander-23a', 'beam-expander-23b', 'beam-splitter-24'], roundTrip: false, throughput: 0.98 * 0.99 * 0.99 },
    { id: 'object', label: 'Object arm', componentIds: ['beam-splitter-24', 'cylindrical-lens-25', 'focus-lens-26', 'target-100'], roundTrip: true, throughput: 0.99 * 0.99 * 0.99 * 0.99 },
    { id: 'reference', label: 'Reference arm', componentIds: ['beam-splitter-24', 'focus-lens-27', 'focus-lens-28', 'grating-70'], roundTrip: true, throughput: 0.99 * 0.99 * 0.99 * 0.99 },
    { id: 'detector', label: 'Recombination path', componentIds: ['beam-splitter-24', 'detector-80'], roundTrip: false, throughput: 1 },
  ];

  const connections: CoherentConnection[] = paths.flatMap((path) => path.componentIds.slice(1).map((id, index) => ({
    id: `${path.id}-${index + 1}`,
    fromComponentId: path.componentIds[index],
    toComponentId: id,
    pathId: path.id,
    roundTrip: path.roundTrip,
  })));

  return {
    schemaVersion: '1.0',
    mode: 'non-sequential',
    preset: 'patent-fig-2',
    name: 'Patent Fig. 2 · Broadband + grating',
    components,
    connections,
    paths,
    blockSequences: [
      { id: 'common-sequence', label: 'Common path', pathId: 'common', blocks: [], rootTransform: transform(0, 0, -300) },
      { id: 'object-sequence', label: 'Object arm', pathId: 'object', blocks: [], rootTransform: transform(150, 0, -250, 0, 90, 0) },
      { id: 'reference-sequence', label: 'Reference arm', pathId: 'reference', blocks: [], rootTransform: transform(150, 0, -250) },
      { id: 'detector-sequence', label: 'Detector path', pathId: 'detector', blocks: [], rootTransform: transform(150, 0, -250, 0, 180, 0) },
    ],
    clearance: { radialMm: 5, axialMm: 3 },
    source: { id: 'source-11', componentId: 'source-11', kind: 'supercontinuum', centerWavelengthNm: 600, minWavelengthNm: 400, maxWavelengthNm: 800, bandwidthFwhmNm: 160, spectralSamples: 65, spectralShape: 'gaussian', totalPowerW: 0.001, beamDiameterMm: 2, exitApertureDiameterMm: 8, divergenceDeg: 0.05, spatialProfile: 'gaussian', spatialSamples: 49, coherenceGroupId: 'superk-11' },
    sources: [{ id: 'source-11', componentId: 'source-11', kind: 'supercontinuum', centerWavelengthNm: 600, minWavelengthNm: 400, maxWavelengthNm: 800, bandwidthFwhmNm: 160, spectralSamples: 65, spectralShape: 'gaussian', totalPowerW: 0.001, beamDiameterMm: 2, exitApertureDiameterMm: 8, divergenceDeg: 0.05, spatialProfile: 'gaussian', spatialSamples: 49, coherenceGroupId: 'superk-11' }],
    beamSplitter: { reflectance: 0.45, transmittance: 0.55, reflectedPhaseDeg: 90, transmittedPhaseDeg: 0 },
    grating: { componentId: 'grating-70', grooveDensityLinesPerMm: 600, incidenceAngleDeg: 10.369, order: 1, allowedOrders: [1], blazeAngleDeg: 10.369, blazeWavelengthNm: 600, efficiency: 0.75, substrateReflectivity: 0.9, nondiffractedReflectivity: 0, incidentSide: 'front', grooveDirection: { x: 0, y: 1, z: 0 }, detectorMagnification: 1 },
    target: { kind: 'step', spanMm: 8, offsetUm: 0, amplitudeUm: 20, periodMm: 2, stepPositionMm: 0 },
    detector: { id: 'detector-80', componentId: 'detector-80', kind: 'area', pixelCountX: 128, pixelCountY: 128, pixelPitchUm: 10, activeWidthMm: 1.28, activeHeightMm: 1.28, fillFactor: 1, responsivity: 1, exposureTimeS: 0.001, bitDepth: 16, frontOnly: false, calibrationMinUm: -80, calibrationMaxUm: 80 },
    detectors: [{ id: 'detector-80', componentId: 'detector-80', kind: 'area', pixelCountX: 128, pixelCountY: 128, pixelPitchUm: 10, activeWidthMm: 1.28, activeHeightMm: 1.28, fillFactor: 1, responsivity: 1, exposureTimeS: 0.001, bitDepth: 16, frontOnly: false, calibrationMinUm: -80, calibrationMaxUm: 80 }],
    traceSettings: { maxInteractions: 24, minRelativePower: 1e-9, maxGeneratedRays: 250000, rayEpsilonMm: 1e-5, renderSegmentLimit: 25000, previewSpatialSamples: 9, previewSpectralSamples: 9 },
    attenuatorTransmission: 0.5,
    targetReflectance: 0.7,
    visibility: 0.92,
    calibrationOffsetMm: 0,
  };
}

export function normalizeCoherentAssemblyDesign(value: unknown): CoherentAssemblyDesign {
  const fallback = createPatentFig2AssemblyDesign();
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
    : [{ ...normalizedSource, id: normalizedSource.id ?? 'source-11' }];
  const normalizedDetectors = Array.isArray(source.detectors) && source.detectors.length > 0
    ? source.detectors.map((entry, index) => ({ ...normalizedDetector, ...entry, id: entry.id ?? `detector-${index + 1}` }))
    : [{ ...normalizedDetector, id: normalizedDetector.id ?? 'detector-80' }];


  return {
    ...clone,
    ...source,
    schemaVersion: '1.0',
    mode: source.mode === 'sequential' ? 'sequential' : 'non-sequential',
    preset: source.preset ?? clone.preset,
    components: normalizedComponents,
    connections: Array.isArray(source.connections) ? source.connections : clone.connections,
    paths: Array.isArray(source.paths) ? source.paths : clone.paths,
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

export function simulatePatentFig2(input: CoherentAssemblyDesign): Fig2SimulationResult {
  const design = normalizeCoherentAssemblyDesign(input);
  const assembly = evaluateCoherentAssembly(design);
  const splitter = evaluateBeamSplitter(design.beamSplitter);
  const width = Math.max(16, Math.min(512, Math.round(finite(design.detector.pixelCountX, 128))));
  const height = Math.max(16, Math.min(512, Math.round(finite(design.detector.pixelCountY, 128))));
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
    return generateGaussianSpectrum(
      Math.max(1e-6, finite(design.source.centerWavelengthNm, 600)),
      Math.max(1e-6, finite(design.source.bandwidthFwhmNm, 160)),
      Math.max(17, Math.min(513, Math.round(finite(design.source.spectralSamples, 65)))),
    );
  })();
  const spectralBaseOpdMm = spectrum.wavelengthNm.map((wavelengthNm) => (
    calculatePathOpticalLengthMm(design, 'object', wavelengthNm)
    - calculatePathOpticalLengthMm(design, 'reference', wavelengthNm)
    + finite(design.calibrationOffsetMm)
  ));
  const xSpan = Math.max(1e-6, finite(design.target.spanMm, width * pitchMm));
  const xMm = Array.from({ length: width }, (_, index) => (index / Math.max(1, width - 1) - 0.5) * xSpan);
  const yMm = Array.from({ length: height }, (_, index) => (index / Math.max(1, height - 1) - 0.5) * height * pitchMm);
  const targetHeightUm = xMm.map((x) => sampleTargetHeightUm(design.target, x));
  const intensityWPerPixel = new Float64Array(width * height);
  const normalizedIntensity = new Float64Array(width * height);
  const coherenceEnvelope = new Float64Array(width * height);
  const objectOpticalPathMm = finite(assembly.pathLengthMm.object);
  const referenceOpticalPathMm = finite(assembly.pathLengthMm.reference);
  const baseOpdMm = objectOpticalPathMm - referenceOpticalPathMm + finite(design.calibrationOffsetMm);
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

  for (let xi = 0; xi < width; xi += 1) {
    const targetOplMm = 2 * targetHeightUm[xi] * 1e-3;
    for (let yi = 0; yi < height; yi += 1) {
      let interference = 0;
      let coherenceReal = 0;
      let coherenceImag = 0;
      for (let wi = 0; wi < spectrum.wavelengthNm.length; wi += 1) {
        const grating = gratingByWavelength[wi];
        if (!grating.propagating || grating.diffractionAngleDeg === null) continue;
        const wavelengthMm = spectrum.wavelengthNm[wi] * 1e-6;
        const slope = Math.sin(grating.diffractionAngleDeg * Math.PI / 180)
          / Math.max(1e-12, Math.abs(finite(design.grating.detectorMagnification, 1)));
        const opdMm = spectralBaseOpdMm[wi] + targetOplMm - yMm[yi] * slope;
        const phase = TWO_PI * opdMm / wavelengthMm + splitterPhase;
        const weight = spectrum.power[wi];
        interference += weight * Math.cos(phase);
        coherenceReal += weight * Math.cos(phase);
        coherenceImag += weight * Math.sin(phase);
      }
      const index = yi * width + xi;
      intensityWPerPixel[index] = Math.max(0, dcPower + crossAmplitude * interference);
      coherenceEnvelope[index] = Math.hypot(coherenceReal, coherenceImag);
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

  // Calibrate detector Y to height with the same wavelength-resolved grating
  // model used by the forward simulation. A center-wavelength linear formula
  // is not sufficient because diffraction angle changes across a broad band.
  const calibrationMinUm = finite(design.detector.calibrationMinUm, -80);
  const calibrationMaxUm = finite(design.detector.calibrationMaxUm, 80);
  const calibrationLowUm = Math.min(calibrationMinUm, calibrationMaxUm);
  const calibrationHighUm = Math.max(calibrationMinUm, calibrationMaxUm);
  const calibrationSamples = Math.max(257, height * 2 + 1);
  const calibratedHeightByY = new Array<number>(height);
  for (let yi = 0; yi < height; yi += 1) {
    let bestHeightUm = calibrationLowUm;
    let bestCoherence = -Infinity;
    for (let zi = 0; zi < calibrationSamples; zi += 1) {
      const candidateHeightUm = calibrationLowUm + (calibrationHighUm - calibrationLowUm) * zi / Math.max(1, calibrationSamples - 1);
      const candidateOplMm = 2 * candidateHeightUm * 1e-3;
      let real = 0;
      let imaginary = 0;
      for (let wi = 0; wi < spectrum.wavelengthNm.length; wi += 1) {
        const grating = gratingByWavelength[wi];
        if (!grating.propagating || grating.diffractionAngleDeg === null) continue;
        const wavelengthMm = spectrum.wavelengthNm[wi] * 1e-6;
        const slope = Math.sin(grating.diffractionAngleDeg * Math.PI / 180)
          / Math.max(1e-12, Math.abs(finite(design.grating.detectorMagnification, 1)));
        const phase = TWO_PI * (spectralBaseOpdMm[wi] + candidateOplMm - yMm[yi] * slope) / wavelengthMm + splitterPhase;
        const weight = spectrum.power[wi];
        real += weight * Math.cos(phase);
        imaginary += weight * Math.sin(phase);
      }
      const magnitude = Math.hypot(real, imaginary);
      if (magnitude > bestCoherence) {
        bestCoherence = magnitude;
        bestHeightUm = candidateHeightUm;
      }
    }
    calibratedHeightByY[yi] = bestHeightUm;
  }
  const recoveredHeightUm = new Array<number>(width);
  for (let xi = 0; xi < width; xi += 1) {
    let bestY = 0;
    let bestEnvelope = -Infinity;
    for (let yi = 0; yi < height; yi += 1) {
      const value = coherenceEnvelope[yi * width + xi];
      if (value > bestEnvelope) {
        bestEnvelope = value;
        bestY = yi;
      }
    }
    recoveredHeightUm[xi] = calibratedHeightByY[bestY];
  }
  const errors = recoveredHeightUm.map((value, index) => value - targetHeightUm[index]);
  const rmsHeightErrorUm = Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / Math.max(1, errors.length));
  const maxAbsHeightErrorUm = errors.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const warningMessages: string[] = [];
  if (assembly.confidence !== 'Exact') warningMessages.push(`Assembly dimensions are ${assembly.confidence.toLowerCase()}; replace estimated envelopes with catalogue dimensions for final packaging.`);
  if (assembly.collisions.length > 0) warningMessages.push(`${assembly.collisions.length} mechanical-envelope collision(s) detected.`);
  if (propagatingSamples < spectrum.wavelengthNm.length) warningMessages.push('Part of the source spectrum does not propagate in the selected grating order.');
  if (!(Math.abs(centerSlope) > 1e-12)) warningMessages.push('The reference wavefront has no usable detector-axis delay slope.');
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
