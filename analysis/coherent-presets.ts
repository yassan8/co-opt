import {
  createPatentFig2AssemblyDesign,
  type CoherentAssemblyDesign,
  type CoherentDetectorSpec,
  type CoherentPhysicalComponent,
  type CoherentSourceSpec,
} from './coherent-assembly.ts';

export type CoherentPresetId = CoherentAssemblyDesign['preset'];

export const COHERENT_PRESET_OPTIONS: Array<{ id: CoherentPresetId; label: string }> = [
  { id: 'patent-fig-2', label: 'Supercontinuum + Grating + Camera' },
  { id: 'comb-grating-area', label: 'Comb + Grating + Area Detector' },
  { id: 'patent-fig-14-dual-comb', label: 'Dual Comb Interferometer' },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function component(design: CoherentAssemblyDesign, id: string): CoherentPhysicalComponent {
  const found = design.components.find((entry) => entry.id === id);
  if (!found) throw new Error(`Preset component ${id} is missing.`);
  return clone(found);
}

function resetOffset(item: CoherentPhysicalComponent): void {
  item.manualOffset = {
    positionMm: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
  };
}

export function createCombGratingAreaDesign(): CoherentAssemblyDesign {
  const design = clone(createPatentFig2AssemblyDesign());
  const sourceComponent = component(design, 'source-11');
  const gratingComponent = component(design, 'grating-70');
  const detectorComponent = component(design, 'detector-80');

  sourceComponent.label = 'Frequency comb source';
  sourceComponent.autoTransform = { positionMm: { x: 0, y: 0, z: -100 }, rotationDeg: { x: 0, y: 0, z: 0 } };
  sourceComponent.pathIds = ['comb-dispersion'];
  sourceComponent.metadata = { physicalModel: 'frequency-comb', exitApertureDiameterMm: 8 };
  resetOffset(sourceComponent);

  gratingComponent.autoTransform = { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 10.369, z: 0 } };
  gratingComponent.pathIds = ['comb-dispersion'];
  resetOffset(gratingComponent);

  detectorComponent.autoTransform = { positionMm: { x: 0, y: 0, z: -200 }, rotationDeg: { x: 0, y: 0, z: 0 } };
  detectorComponent.dimensions = { widthMm: 24, heightMm: 18, depthMm: 12 };
  detectorComponent.pathIds = ['comb-dispersion'];
  resetOffset(detectorComponent);

  const source: CoherentSourceSpec = {
    id: 'comb-source-1',
    componentId: 'source-11',
    kind: 'frequency-comb',
    centerWavelengthNm: 600,
    bandwidthFwhmNm: 32,
    minWavelengthNm: 580,
    maxWavelengthNm: 620,
    spectralSamples: 257,
    totalPowerW: 0.001,
    repetitionRateHz: 100e9,
    ceoFrequencyHz: 20e6,
    lineCount: 257,
    lineWidthHz: 100e3,
    initialPhaseRad: 0,
    groupDelayDispersionFs2: 0,
    beamDiameterMm: 1,
    exitApertureDiameterMm: 6,
    divergenceDeg: 0,
    spatialProfile: 'gaussian',
    spatialSamples: 25,
    coherenceGroupId: 'comb-1',
  };
  const detector: CoherentDetectorSpec = {
    id: 'area-detector-1',
    componentId: 'detector-80',
    kind: 'area',
    pixelCountX: 2048,
    pixelCountY: 512,
    pixelPitchUm: 10,
    activeWidthMm: 20.48,
    activeHeightMm: 5.12,
    fillFactor: 1,
    responsivity: 1,
    exposureTimeS: 0.001,
    bitDepth: 16,
    frontOnly: false,
  };

  return {
    ...design,
    schemaVersion: '1.0',
    preset: 'comb-grating-area',
    revision: 0,
    name: 'Comb + 600 lines/mm grating + area detector',
    components: [sourceComponent, gratingComponent, detectorComponent],
    paths: [{ id: 'comb-dispersion', label: 'Comb dispersion path', componentIds: ['source-11', 'grating-70', 'detector-80'], roundTrip: false, throughput: 0.75 }],
    connections: [
      { id: 'comb-source-grating', fromComponentId: 'source-11', toComponentId: 'grating-70', pathId: 'comb-dispersion' },
      { id: 'comb-grating-detector', fromComponentId: 'grating-70', toComponentId: 'detector-80', pathId: 'comb-dispersion' },
    ],
    blockSequences: [],
    source,
    sources: [source],
    grating: { ...design.grating, componentId: 'grating-70', allowedOrders: [1], blazeAngleDeg: 10.369, blazeWavelengthNm: 600 },
    detector,
    detectors: [detector],
  };
}

export function createPatentFig14DualCombDesign(): CoherentAssemblyDesign {
  const base = clone(createPatentFig2AssemblyDesign());
  const firstSource = component(base, 'source-11');
  firstSource.id = 'comb-source-61';
  firstSource.reference = '61';
  firstSource.label = 'Frequency comb source 1';
  firstSource.autoTransform = { positionMm: { x: -0.4, y: 0, z: -120 }, rotationDeg: { x: 0, y: 0, z: 0 } };
  firstSource.pathIds = ['dual-comb'];
  resetOffset(firstSource);

  const secondSource = clone(firstSource);
  secondSource.id = 'comb-source-62';
  secondSource.reference = '62';
  secondSource.label = 'Frequency comb source 2';
  secondSource.autoTransform.positionMm.x = 0.4;

  const splitter = component(base, 'beam-splitter-24');
  splitter.id = 'beam-splitter-63';
  splitter.reference = '63';
  splitter.autoTransform = { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } };
  splitter.pathIds = ['dual-comb', 'target-arm'];
  resetOffset(splitter);

  const target = component(base, 'target-100');
  target.id = 'target-64';
  target.reference = '64';
  target.autoTransform = { positionMm: { x: 0, y: 0, z: 100 }, rotationDeg: { x: 0, y: 0, z: 0 } };
  target.dimensions = { widthMm: 40, heightMm: 40, depthMm: 5 };
  target.pathIds = ['target-arm'];
  resetOffset(target);

  const detectorComponent = component(base, 'detector-80');
  detectorComponent.id = 'time-detector-65';
  detectorComponent.reference = '65';
  detectorComponent.label = 'High-speed photodetector';
  detectorComponent.kind = 'time-detector';
  detectorComponent.autoTransform = { positionMm: { x: 0, y: 0, z: -180 }, rotationDeg: { x: 0, y: 0, z: 0 } };
  detectorComponent.dimensions = { widthMm: 12, heightMm: 12, depthMm: 20, apertureDiameterMm: 8 };
  detectorComponent.pathIds = ['dual-comb'];
  resetOffset(detectorComponent);

  const source1: CoherentSourceSpec = {
    id: 'comb-source-61', componentId: 'comb-source-61', kind: 'frequency-comb',
    centerWavelengthNm: 1550, bandwidthFwhmNm: 4, spectralSamples: 33, totalPowerW: 0.005,
    repetitionRateHz: 100e6, ceoFrequencyHz: 20e6, lineCount: 33, lineWidthHz: 1e3,
    beamDiameterMm: 2, divergenceDeg: 0, spatialProfile: 'gaussian', spatialSamples: 9,
    coherenceGroupId: 'dual-comb-pair', initialPhaseRad: 0, groupDelayDispersionFs2: 0,
  };
  const source2: CoherentSourceSpec = {
    ...source1,
    id: 'comb-source-62', componentId: 'comb-source-62',
    repetitionRateHz: 100.001e6, ceoFrequencyHz: 20.01e6,
    relativeDelayFs: 0, relativePhaseRad: 0,
  };
  const detector: CoherentDetectorSpec = {
    id: 'time-detector-65', componentId: 'time-detector-65', kind: 'time',
    pixelCountX: 1, pixelCountY: 1, pixelPitchUm: 8000, fillFactor: 1, responsivity: 1,
    frontOnly: false, samplingRateHz: 10e6, detectionBandwidthHz: 5e6,
    integrationTimeS: 0.002, sampleCount: 4096,
  };

  return {
    ...base,
    schemaVersion: '1.0',
    preset: 'patent-fig-14-dual-comb',
    revision: 0,
    name: 'Dual frequency comb interferometer',
    components: [firstSource, secondSource, splitter, target, detectorComponent],
    paths: [
      { id: 'dual-comb', label: 'Dual-comb receive path', componentIds: ['comb-source-61', 'comb-source-62', 'beam-splitter-63', 'time-detector-65'], roundTrip: false, throughput: 0.5 },
      { id: 'target-arm', label: 'Target arm', componentIds: ['beam-splitter-63', 'target-64'], roundTrip: true, throughput: 0.5 },
    ],
    connections: [
      { id: 'comb-1-splitter', fromComponentId: 'comb-source-61', toComponentId: 'beam-splitter-63', pathId: 'dual-comb' },
      { id: 'comb-2-splitter', fromComponentId: 'comb-source-62', toComponentId: 'beam-splitter-63', pathId: 'dual-comb' },
      { id: 'splitter-target', fromComponentId: 'beam-splitter-63', toComponentId: 'target-64', pathId: 'target-arm', roundTrip: true },
      { id: 'splitter-time-detector', fromComponentId: 'beam-splitter-63', toComponentId: 'time-detector-65', pathId: 'dual-comb' },
    ],
    blockSequences: [],
    source: source1,
    sources: [source1, source2],
    beamSplitter: { reflectance: 0.5, transmittance: 0.5, reflectedPhaseDeg: 90, transmittedPhaseDeg: 0 },
    target: { kind: 'flat', spanMm: 20, offsetUm: 0, amplitudeUm: 0, periodMm: 2, stepPositionMm: 0 },
    detector,
    detectors: [detector],
    traceSettings: { ...base.traceSettings!, maxInteractions: 12, previewSpatialSamples: 3, previewSpectralSamples: 9 },
  };
}

export function createCoherentPreset(id: CoherentPresetId): CoherentAssemblyDesign {
  if (id === 'comb-grating-area') return createCombGratingAreaDesign();
  if (id === 'patent-fig-14-dual-comb') return createPatentFig14DualCombDesign();
  return createPatentFig2AssemblyDesign();
}
