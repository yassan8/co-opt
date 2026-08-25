import {
  PHYSICAL_BLOCK_TYPES,
  isPhysicalBlockType,
  type Block,
  type DesignConnection,
  type PhysicalBlockType,
} from '../data/block-schema.ts';
import type { Configuration } from '../data/table-configuration.ts';
import { reflowCoherentAssembly, worldPortPosition } from './coherent-port-layout.ts';
import type {
  CoherentAssemblyDesign,
  CoherentBlockSequence,
  CoherentDetectorSpec,
  CoherentPhysicalComponent,
  CoherentSourceSpec,
  ComponentTransform,
  OpticalPort,
  Vec3Mm,
} from './coherent-assembly.ts';
import { calculateSurfaceOrigins } from '../raytracing/core/ray-tracing.ts';
import { resolveComponentTransform } from './coherent-assembly.ts';
import { canonicalPortId, normalizePortRouteConfiguration } from './port-routes.ts';
import { expandSequentialGroupRows } from './sequential-group-rows.ts';

const PHYSICAL_SET = new Set<string>(PHYSICAL_BLOCK_TYPES);
const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const positive = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const sourceHalfAngleDeg = (parameters: Record<string, any>): number => {
  const numericalAperture = finite(parameters.numericalAperture, NaN);
  const ambientIndex = positive(parameters.ambientRefractiveIndex, 1);
  if (Number.isFinite(numericalAperture) && numericalAperture >= 0) {
    return Math.asin(Math.min(1, numericalAperture / ambientIndex)) * 180 / Math.PI;
  }
  return Math.max(0, finite(parameters.divergenceDeg));
};
const identityTransform = () => ({
  positionMm: { x: 0, y: 0, z: 0 },
  rotationDeg: { x: 0, y: 0, z: 0 },
});
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const isSequentialDesignBlock = (block: Block): boolean => !isPhysicalBlockType(block?.blockType);

interface HybridSequentialGroup {
  key: string;
  sequenceId: string;
  componentId: string;
  label: string;
  pathId: string;
  blocks: Block[];
  rootTransform: ComponentTransform;
  rootTransformVariables?: Record<string, unknown>;
}

const sequentialGroupKey = (value: unknown): string => {
  const raw = String(value ?? '').trim()
    .replace(/^sequential-group:/, '')
    .replace(/^sequential:/, '');
  return raw || 'main';
};

export const sequentialGroupComponentId = (sequenceOrGroupId: unknown): string => (
  `sequential-group:${sequentialGroupKey(sequenceOrGroupId)}`
);

export const sequentialGroupSequenceId = (sequenceOrGroupId: unknown): string => (
  `sequential:${sequentialGroupKey(sequenceOrGroupId)}`
);

function sanitizeTransform(value: any): ComponentTransform {
  return {
    positionMm: {
      x: finite(value?.positionMm?.x),
      y: finite(value?.positionMm?.y),
      z: finite(value?.positionMm?.z),
    },
    rotationDeg: {
      x: finite(value?.rotationDeg?.x),
      y: finite(value?.rotationDeg?.y),
      z: finite(value?.rotationDeg?.z),
    },
  };
}

export function resolveHybridSequentialGroups(config: Configuration): HybridSequentialGroup[] {
  const blocks = Array.isArray(config.blocks) ? config.blocks as Block[] : [];
  const sequentialBlocks = blocks.filter(isSequentialDesignBlock);
  const sequentialById = new Map(sequentialBlocks.map((block) => [String(block.blockId ?? ''), block]));
  const assigned = new Set<string>();
  const definitions = Array.isArray(config.sequentialGroups) ? config.sequentialGroups : [];
  const groups: HybridSequentialGroup[] = [];
  if (sequentialBlocks.length === 0 && definitions.length === 0) return groups;

  for (const definition of definitions) {
    const key = sequentialGroupKey(definition?.id);
    if (groups.some((group) => group.key === key)) continue;
    const requestedIds = Array.isArray(definition?.blockIds) ? definition.blockIds.map(String) : [];
    const members: Block[] = [];
    for (const blockId of requestedIds) {
      const block = sequentialById.get(blockId);
      if (!block || assigned.has(blockId)) continue;
      assigned.add(blockId);
      members.push(block);
    }
    groups.push({
      key,
      sequenceId: sequentialGroupSequenceId(key),
      componentId: sequentialGroupComponentId(key),
      label: String(definition?.label ?? '').trim() || (key === 'main' ? 'Exact sequential optics' : `Exact sequential optics · ${key}`),
      pathId: String(definition?.pathLabel ?? '').trim() || (key === 'main' ? 'main' : key),
      blocks: members,
      rootTransform: sanitizeTransform(definition?.rootTransform),
      rootTransformVariables: clone(definition?.rootTransformVariables ?? {}),
    });
  }

  const unassigned = sequentialBlocks.filter((block) => !assigned.has(String(block.blockId ?? '')));
  if (unassigned.length > 0 || groups.length === 0) {
    let main = groups.find((group) => group.key === 'main');
    if (!main) {
      main = {
        key: 'main',
        sequenceId: sequentialGroupSequenceId('main'),
        componentId: sequentialGroupComponentId('main'),
        label: 'Exact sequential optics',
        pathId: 'main',
        blocks: [],
        rootTransform: identityTransform(),
        rootTransformVariables: {},
      };
      groups.unshift(main);
    }
    main.blocks.push(...unassigned);
  }

  return groups;
}

export function portsForPhysicalBlock(type: PhysicalBlockType): OpticalPort[] {
  const inPort = { id: 'in', label: 'Input', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: 0, y: 0, z: -1 } };
  const outPort = { id: 'out', label: 'Output', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: 0, y: 0, z: 1 } };
  if (type === 'BroadbandSource' || type === 'FrequencyCombSource') return [{ ...outPort, id: 'emit', label: 'Emit' }];
  if (type === 'AreaDetector' || type === 'TimeDetector') return [{ ...inPort, id: 'detect', label: 'Detect' }];
  if (type === 'FoldMirror') {
    return [
      { ...inPort, id: 'in', label: 'Incident' },
      { ...inPort, id: 'out', label: 'Reflected' },
    ];
  }
  if (type === 'BeamSplitter') {
    return [
      { ...inPort, id: 'common', label: 'Common' },
      { ...outPort, id: 'transmit', label: 'Transmit' },
      { id: 'reflect', label: 'Reflect', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: 1, y: 0, z: 0 } },
      { id: 'recombine', label: 'Recombine', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: -1, y: 0, z: 0 } },
    ];
  }
  if (type === 'Target') {
    return [
      { ...inPort, id: 'incident', label: 'Incident' },
      { ...inPort, id: 'specular', label: 'Specular' },
      { id: 'scatter', label: 'Scatter', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: 0, y: 1, z: 0 } },
    ];
  }
  if (type === 'ReflectionGrating') {
    return [
      { ...inPort, id: 'incident', label: 'Incident' },
      { ...inPort, id: 'order-0', label: 'Order 0' },
      { id: 'order+1', label: 'Order +1', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: 0.5, y: 0, z: -0.8660254037844386 } },
      { id: 'order-1', label: 'Order -1', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: -0.5, y: 0, z: -0.8660254037844386 } },
    ];
  }
  return [inPort, outPort];
}

const defaultParameters: Record<PhysicalBlockType, Record<string, unknown>> = {
  BroadbandSource: { centerWavelengthNm: 587.5618, minWavelengthNm: 435.8343, maxWavelengthNm: 656.2725, spectralSamples: 31, totalPowerW: 0.001, beamDiameterMm: 5, divergenceDeg: 0, spatialProfile: 'gaussian', renderSpatialSamples: 9, detectorSpatialSamples: 81, spatialSamples: 81, coherenceGroupId: 'source-1' },
  FrequencyCombSource: { centerWavelengthNm: 1550, repetitionRateHz: 100e6, ceoFrequencyHz: 20e6, lineCount: 101, lineWidthHz: 1000, totalPowerW: 0.001, beamDiameterMm: 2, renderSpatialSamples: 9, detectorSpatialSamples: 81, spatialSamples: 81, coherenceGroupId: 'comb-1' },
  BeamSplitter: {
    widthMm: 20,
    heightMm: 20,
    depthMm: 3,
    beamSplitterModel: 'ideal',
    reflectionPort: 'reflect',
    reflectance: 0.5,
    transmittance: 0.5,
    reflectedPhaseDeg: 90,
    transmittedPhaseDeg: 0,
    substrateMaterial: 'N-BK7',
    substrateIndexNd: 1.5168,
    substrateAbbeNumber: 64.17,
    substrateThicknessMm: 3,
    wedgeDeg: 0,
    backSurfaceReflectance: 0,
  },
  FoldMirror: { widthMm: 25, heightMm: 25, depthMm: 3, reflectance: 0.98 },
  NDFilter: { widthMm: 25, heightMm: 25, depthMm: 3, transmission: 0.5 },
  ReflectionGrating: { widthMm: 30, heightMm: 30, depthMm: 6, grooveDensityLinesPerMm: 600, order: 1, allowedOrders: [1], efficiency: 0.75, blazeAngleDeg: 10.369, blazeWavelengthNm: 600, grooveDirectionX: 0, grooveDirectionY: 1, grooveDirectionZ: 0 },
  Target: { widthMm: 50, heightMm: 50, depthMm: 5, profile: 'flat', interaction: 'specular', reflectance: 0.7, amplitudeUm: 0, periodMm: 2, stepPositionMm: 0, scatterSamples: 16, scatterA: 1, scatterB: 0.01, scatterG: 2, scatterSigmaDeg: 5, bsdfSamples: [] },
  AreaDetector: { pixelCountX: 1024, pixelCountY: 1024, pixelPitchUm: 5, quantumEfficiency: 0.8, fillFactor: 1, exposureTimeS: 0.01, saturationElectrons: 30000, bitDepth: 16, frontOnly: true },
  TimeDetector: { samplingRateHz: 1e9, sampleCount: 4096, detectionBandwidthHz: 500e6, integrationTimeS: 1e-3, responsivity: 0.8 },
  STLObject: { widthMm: 10, heightMm: 10, depthMm: 10, stlPath: '', interaction: 'absorbing' },
};

export function createDefaultPhysicalBlock(type: PhysicalBlockType, blockId?: string): Block {
  const suffix = blockId ?? `${type}-${Date.now().toString(36)}`;
  return {
    blockId: suffix,
    blockType: type,
    role: null,
    constraints: {},
    parameters: {
      ...clone(defaultParameters[type]),
      positionXmm: 0,
      positionYmm: 0,
      positionZmm: 0,
      rotationXdeg: 0,
      rotationYdeg: 0,
      rotationZdeg: 0,
    },
    variables: {},
    metadata: { source: 'design-intent', collapsed: false },
  };
}

function componentKind(type: PhysicalBlockType): CoherentPhysicalComponent['kind'] {
  const map: Record<PhysicalBlockType, CoherentPhysicalComponent['kind']> = {
    BroadbandSource: 'source', FrequencyCombSource: 'source', BeamSplitter: 'beam-splitter',
    FoldMirror: 'mirror', NDFilter: 'attenuator', ReflectionGrating: 'reflection-grating',
    Target: 'target', AreaDetector: 'detector', TimeDetector: 'time-detector', STLObject: 'stl-object',
  };
  return map[type];
}

function physicalComponent(block: Block): CoherentPhysicalComponent {
  const type = block.blockType as PhysicalBlockType;
  const p = block.parameters ?? {};
  const beamSplitterModel = String(p.beamSplitterModel ?? 'ideal').toLowerCase();
  const beamDiameter = positive(p.beamDiameterMm, 5);
  const pixelWidth = positive(p.pixelCountX, 1024) * positive(p.pixelPitchUm, 5) * 1e-3;
  const pixelHeight = positive(p.pixelCountY, 1024) * positive(p.pixelPitchUm, 5) * 1e-3;
  const width = type === 'AreaDetector' ? pixelWidth : positive(p.widthMm, beamDiameter + 10);
  const height = type === 'AreaDetector' ? pixelHeight : positive(p.heightMm, beamDiameter + 10);
  const depth = positive(p.depthMm, type.endsWith('Source') ? 30 : type.includes('Detector') ? 10 : 3);
  const ports = portsForPhysicalBlock(type).map((port) => {
    let localDirection = port.localDirection;
    if (type === 'ReflectionGrating' && /^order[+-]?\d+$/i.test(port.id)) {
      const order = Number(port.id.match(/([+-]?\d+)$/)?.[1] ?? p.order ?? 0);
      const shift = order * positive(p.blazeWavelengthNm, 600) * 1e-6 * positive(p.grooveDensityLinesPerMm, 600);
      if (Math.abs(shift) <= 1) localDirection = { x: shift, y: 0, z: -Math.sqrt(Math.max(0, 1 - shift * shift)) };
    }
    const directionLength = Math.hypot(localDirection.x, localDirection.y, localDirection.z) || 1;
    const direction = {
      x: localDirection.x / directionLength,
      y: localDirection.y / directionLength,
      z: localDirection.z / directionLength,
    };
    if (type === 'BeamSplitter' && beamSplitterModel !== 'cube') {
      // Ideal, plate and pellicle split at their optical surface. A cube has
      // real entrance/exit faces, while a flat splitter keeps all ports on the
      // coated plane and lets the tracer calculate the substrate displacement.
      return {
        ...port,
        localPositionMm: { x: 0, y: 0, z: 0 },
      };
    }
    const faceScale = 0.5 / Math.max(
      Math.abs(direction.x) / Math.max(width, 1e-9),
      Math.abs(direction.y) / Math.max(height, 1e-9),
      Math.abs(direction.z) / Math.max(depth, 1e-9),
      1e-9,
    );
    return {
      ...port,
      // Ports live on the physical envelope, not at the component centre.
      // This keeps connection lines readable around splitters and detectors.
      localPositionMm: {
        x: direction.x * faceScale,
        y: direction.y * faceScale,
        z: direction.z * faceScale,
      },
    };
  });
  return {
    id: String(block.blockId),
    label: String(block.metadata?.label ?? p.label ?? type),
    kind: componentKind(type),
    shape: type === 'FoldMirror' ? 'cylinder' : 'box',
    autoTransform: identityTransform(),
    manualOffset: {
      positionMm: { x: finite(p.positionXmm), y: finite(p.positionYmm), z: finite(p.positionZmm) },
      rotationDeg: { x: finite(p.rotationXdeg), y: finite(p.rotationYdeg), z: finite(p.rotationZdeg) },
    },
    dimensions: { widthMm: width, heightMm: height, depthMm: depth, apertureDiameterMm: positive(p.apertureDiameterMm, Math.min(width, height)) },
    dimensionConfidence: p.dimensionConfidence === 'Exact' ? 'Exact' : p.dimensionConfidence === 'Missing' ? 'Missing' : 'Estimated',
    radialClearanceMm: finite(p.radialClearanceMm, 5),
    axialClearanceMm: finite(p.axialClearanceMm, 3),
    powerEfficiency: finite(p.efficiency ?? p.reflectance ?? p.transmission, 1),
    pathIds: [String(block.metadata?.pathId ?? 'main')],
    ports,
    metadata: {
      source: 'blocks',
      blockId: block.blockId,
      blockType: type,
      ...(type === 'BeamSplitter' ? {
        beamSplitterModel,
        reflectionPort: String(p.reflectionPort ?? 'reflect').toLowerCase() === 'recombine' ? 'recombine' : 'reflect',
        substrateIndexNd: positive(p.substrateIndexNd, 1.5168),
        substrateThicknessMm: positive(p.substrateThicknessMm, depth),
        wedgeDeg: finite(p.wedgeDeg, 0),
      } : {}),
      ...block.metadata,
    },
  };
}

export function normalizeDesignConnections(blocks: Block[], input: unknown, extraComponentIds: string[] = []): DesignConnection[] {
  const ids = new Set([
    ...blocks.map((block) => String(block.blockId ?? '')).filter(Boolean),
    ...extraComponentIds.map(String).filter(Boolean),
  ]);
  const hasExplicitConnections = Array.isArray(input);
  const valid = (hasExplicitConnections ? input : []).filter((connection: any) => (
    connection && ids.has(String(connection.from?.blockId ?? '')) && ids.has(String(connection.to?.blockId ?? ''))
  )).map((connection: any, index): DesignConnection => ({
    id: String(connection.id ?? `connection-${index + 1}`),
    from: { blockId: String(connection.from.blockId), portId: String(connection.from.portId ?? 'out') },
    to: { blockId: String(connection.to.blockId), portId: String(connection.to.portId ?? 'in') },
    distanceMm: Math.max(0, finite(connection.distanceMm, 10)),
    azimuthDeg: Number.isFinite(Number(connection.azimuthDeg)) ? Number(connection.azimuthDeg) : undefined,
    elevationDeg: Number.isFinite(Number(connection.elevationDeg)) ? Number(connection.elevationDeg) : undefined,
    allowReverse: connection.allowReverse === true,
    autoPlace: connection.autoPlace !== false,
    pathLabel: String(connection.pathLabel ?? 'main'),
    manualOffset: connection.manualOffset ? clone(connection.manualOffset) : undefined,
    variables: connection.variables ? clone(connection.variables) : undefined,
  }));
  // An explicit empty array means that the user intentionally removed every
  // connection. Only legacy Configs with no designConnections field receive
  // the backwards-compatible single-path auto connection.
  if (hasExplicitConnections) return valid;

  const physical = blocks.filter((block) => PHYSICAL_SET.has(String(block.blockType)));
  const outputPort = (block: Block): string => {
    if (block.blockType === 'BroadbandSource' || block.blockType === 'FrequencyCombSource') return 'emit';
    if (block.blockType === 'BeamSplitter') return 'transmit';
    if (block.blockType === 'Target') return 'specular';
    if (block.blockType === 'ReflectionGrating') return 'order+1';
    return 'out';
  };
  const inputPort = (block: Block): string => {
    if (block.blockType === 'AreaDetector' || block.blockType === 'TimeDetector') return 'detect';
    if (block.blockType === 'Target') return 'incident';
    if (block.blockType === 'ReflectionGrating') return 'incident';
    if (block.blockType === 'BeamSplitter') return 'common';
    return 'in';
  };
  return physical.slice(1).map((to, index) => ({
    id: `auto-${index + 1}`,
    from: { blockId: String(physical[index].blockId), portId: outputPort(physical[index]) },
    to: { blockId: String(to.blockId), portId: inputPort(to) },
    distanceMm: 10,
    autoPlace: true,
    pathLabel: 'main',
  }));
}

function sourceFromBlock(block: Block | undefined, config: Configuration): CoherentSourceSpec {
  const p = block?.parameters ?? {};
  const mainFrontInput = (config.lensSectionInputs ?? []).find((binding) => (
    String(binding?.sectionId ?? 'main') === 'main' && binding?.port === 'Front'
  ));
  const selectedSourceSet = mainFrontInput?.mode === 'local'
    ? (config.sourceSets ?? []).find((set) => set.id === mainFrontInput.sourceSetId)
    : null;
  const sourceRows = Array.isArray(selectedSourceSet?.rows) && selectedSourceSet.rows.length > 0
    ? selectedSourceSet.rows
    : (config.source ?? []);
  const wavelengthsNm = sourceRows.map((row: any) => finite(row?.wavelength, NaN) * 1000).filter(Number.isFinite);
  const min = wavelengthsNm.length ? Math.min(...wavelengthsNm) : 435.8343;
  const max = wavelengthsNm.length ? Math.max(...wavelengthsNm) : 656.2725;
  const comb = block?.blockType === 'FrequencyCombSource';
  return {
    id: String(block?.blockId ?? 'sequential-source'),
    componentId: String(block?.blockId ?? ''),
    kind: comb ? 'frequency-comb' : 'supercontinuum',
    centerWavelengthNm: positive(p.centerWavelengthNm, (min + max) / 2),
    minWavelengthNm: positive(p.minWavelengthNm, min),
    maxWavelengthNm: positive(p.maxWavelengthNm, max),
    bandwidthFwhmNm: positive(p.bandwidthFwhmNm, Math.max(1, max - min)),
    spectralSamples: Math.max(1, Math.round(positive(p.spectralSamples, wavelengthsNm.length || 3))),
    totalPowerW: positive(p.totalPowerW, 0.001),
    beamDiameterMm: positive(p.beamDiameterMm, 5),
    numericalAperture: Number.isFinite(finite(p.numericalAperture, NaN))
      ? Math.max(0, finite(p.numericalAperture))
      : undefined,
    ambientRefractiveIndex: positive(p.ambientRefractiveIndex, 1),
    divergenceDeg: sourceHalfAngleDeg(p),
    spatialProfile: p.spatialProfile === 'top-hat' ? 'top-hat' : 'gaussian',
    renderSpatialSamples: Math.max(1, Math.round(positive(p.renderSpatialSamples, Math.min(9, positive(p.spatialSamples, 9))))),
    detectorSpatialSamples: Math.max(1, Math.round(positive(p.detectorSpatialSamples, positive(p.spatialSamples, 81)))),
    spatialSamples: Math.max(1, Math.round(positive(p.spatialSamples, 49))),
    coherenceGroupId: String(p.coherenceGroupId ?? 'source-1'),
    repetitionRateHz: comb ? positive(p.repetitionRateHz, 100e6) : undefined,
    ceoFrequencyHz: comb ? Math.max(0, finite(p.ceoFrequencyHz, 20e6)) : undefined,
    lineCount: comb ? Math.max(1, Math.round(positive(p.lineCount, 101))) : undefined,
    lineWidthHz: comb ? positive(p.lineWidthHz, 1000) : undefined,
  };
}

function detectorFromBlock(block: Block | undefined): CoherentDetectorSpec {
  const p = block?.parameters ?? {};
  const time = block?.blockType === 'TimeDetector';
  return {
    id: String(block?.blockId ?? 'image-surface-detector'),
    componentId: String(block?.blockId ?? ''),
    kind: time ? 'time' : 'area',
    pixelCountX: Math.max(1, Math.round(positive(p.pixelCountX, 1024))),
    pixelCountY: Math.max(1, Math.round(positive(p.pixelCountY, 1024))),
    pixelPitchUm: positive(p.pixelPitchUm, 5),
    responsivity: positive(p.responsivity, 1),
    fillFactor: Math.min(1, Math.max(0, finite(p.fillFactor, 1))),
    exposureTimeS: positive(p.exposureTimeS, 0.01),
    saturationElectrons: positive(p.saturationElectrons, 30000),
    bitDepth: Math.max(1, Math.round(positive(p.bitDepth, 16))),
    frontOnly: p.frontOnly !== false,
    samplingRateHz: time ? positive(p.samplingRateHz, 1e9) : undefined,
    detectionBandwidthHz: time ? positive(p.detectionBandwidthHz, 500e6) : undefined,
    integrationTimeS: time ? positive(p.integrationTimeS, 1e-3) : undefined,
    sampleCount: time ? Math.max(1, Math.round(positive(p.sampleCount, 4096))) : undefined,
    quantumEfficiency: [{ wavelengthNm: positive(p.centerWavelengthNm, 587.5618), value: Math.min(1, Math.max(0, finite(p.quantumEfficiency, 0.8))) }],
  };
}

export function buildHybridAssemblyFromConfiguration(config: Configuration): CoherentAssemblyDesign {
  const blocks = Array.isArray(config.blocks) ? config.blocks as Block[] : [];
  const physicalBlocks = blocks.filter((block) => isPhysicalBlockType(block.blockType));
  const components = physicalBlocks.map(physicalComponent);
  const sequentialBlocks = blocks.filter(isSequentialDesignBlock);
  const sequentialGroups = resolveHybridSequentialGroups(config);
  const blockSequences: CoherentBlockSequence[] = [];
  for (const group of sequentialGroups) {
    const canReuseLegacyRows = sequentialGroups.length === 1
      && group.blocks.length === sequentialBlocks.length
      && Array.isArray(config.opticalSystem)
      && config.opticalSystem.length > 0;
    const sequentialRows = canReuseLegacyRows
      ? clone(config.opticalSystem ?? [])
      : expandSequentialGroupRows(group.blocks);
    const surfaceOrigins = Array.isArray(sequentialRows) && sequentialRows.length > 0
      ? calculateSurfaceOrigins(sequentialRows)
      : [];
    const firstOrigin = surfaceOrigins[0]?.origin ?? { x: 0, y: 0, z: 0 };
    const lastOrigin = surfaceOrigins[surfaceOrigins.length - 1]?.origin ?? firstOrigin;
    const lastRotation = surfaceOrigins[surfaceOrigins.length - 1]?.rotationMatrix;
    const outputDirection = {
      x: finite(lastRotation?.[0]?.[2], 0),
      y: finite(lastRotation?.[1]?.[2], 0),
      z: finite(lastRotation?.[2]?.[2], 1),
    };
    components.push({
      id: group.componentId, label: group.label, kind: 'sequential-group', shape: 'box',
      autoTransform: identityTransform(), manualOffset: clone(group.rootTransform),
      dimensions: { widthMm: 0, heightMm: 0, depthMm: 0 }, dimensionConfidence: 'Exact', powerEfficiency: 1,
      pathIds: [group.pathId], ports: [
        { id: 'front', label: 'Front', localPositionMm: { ...firstOrigin }, localDirection: { x: 0, y: 0, z: -1 } },
        { id: 'back', label: 'Back', localPositionMm: { ...lastOrigin }, localDirection: outputDirection },
      ],
      metadata: {
        source: 'blocks-reference',
        sequenceId: group.sequenceId,
        groupId: group.key,
        blockIds: group.blocks.map((block) => block.blockId),
        opticalSystemRows: sequentialRows,
      },
    });
    blockSequences.push({
      id: group.sequenceId,
      label: group.label,
      pathId: group.pathId,
      blocks: clone(group.blocks),
      manualOffset: clone(group.rootTransform),
      rootTransform: clone(group.rootTransform),
      rootTransformVariables: clone(group.rootTransformVariables ?? {}),
    });
  }
  const designConnections = normalizeDesignConnections(
    blocks,
    config.designConnections,
    sequentialGroups.map((group) => group.componentId),
  );
  const primarySequentialGroupId = sequentialGroups.find((group) => group.key === 'main')?.componentId
    ?? sequentialGroups[0]?.componentId
    ?? '';
  if (primarySequentialGroupId) {
    const sequentialGroup = components.find((component) => component.id === primarySequentialGroupId);
    const downstreamIds = new Set(designConnections.map((connection) => String(connection.to.blockId)));
    const explicitlyConnectedIds = new Set(designConnections.flatMap((connection) => [
      String(connection.from.blockId),
      String(connection.to.blockId),
    ]));
    if (sequentialGroup) {
      const sequentialInput = worldPortPosition(sequentialGroup, 'front', 'to');
      for (const component of components) {
        if (component.kind !== 'source' || downstreamIds.has(component.id) || explicitlyConnectedIds.has(component.id)) continue;
        // Source XYZ is a manual offset from the natural launch position. The
        // natural position puts the physical Emit end face exactly on the
        // first surface origin of the exact sequential train.
        const sourceAtZeroManualPosition: CoherentPhysicalComponent = {
          ...component,
          manualOffset: {
            ...component.manualOffset,
            positionMm: { x: 0, y: 0, z: 0 },
          },
        };
        const emitAt = worldPortPosition(sourceAtZeroManualPosition, 'emit', 'from');
        component.autoTransform.positionMm = {
          x: component.autoTransform.positionMm.x + sequentialInput.x - emitAt.x,
          y: component.autoTransform.positionMm.y + sequentialInput.y - emitAt.y,
          z: component.autoTransform.positionMm.z + sequentialInput.z - emitAt.z,
        };
      }
    }
  }
  const coherentConnections = designConnections.map((connection) => ({
    id: connection.id,
    fromComponentId: connection.from.blockId,
    toComponentId: connection.to.blockId,
    fromPortId: canonicalPortId(connection.from.blockId, connection.from.portId, config),
    toPortId: canonicalPortId(connection.to.blockId, connection.to.portId, config),
    distanceMm: connection.distanceMm,
    azimuthDeg: connection.azimuthDeg,
    elevationDeg: connection.elevationDeg,
    allowReverse: connection.allowReverse === true,
    autoPlace: connection.autoPlace !== false,
    variables: connection.variables ? clone(connection.variables) : undefined,
    pathId: connection.pathLabel ?? 'main',
  }));
  const pathMap = new Map<string, string[]>();
  for (const connection of designConnections) {
    const label = connection.pathLabel ?? 'main';
    const ids = pathMap.get(label) ?? [];
    if (!ids.includes(connection.from.blockId)) ids.push(connection.from.blockId);
    if (!ids.includes(connection.to.blockId)) ids.push(connection.to.blockId);
    pathMap.set(label, ids);
  }

  const sourceBlocks = physicalBlocks.filter((block) => block.blockType === 'BroadbandSource' || block.blockType === 'FrequencyCombSource');
  const detectorBlocks = physicalBlocks.filter((block) => block.blockType === 'AreaDetector' || block.blockType === 'TimeDetector');
  const gratingBlock = physicalBlocks.find((block) => block.blockType === 'ReflectionGrating');
  const targetBlock = physicalBlocks.find((block) => block.blockType === 'Target');
  const splitterBlock = physicalBlocks.find((block) => block.blockType === 'BeamSplitter');
  const sources = sourceBlocks.length > 0
    ? sourceBlocks.map((block) => sourceFromBlock(block, config))
    : [sourceFromBlock(undefined, config)];
  const detectors = detectorBlocks.length > 0
    ? detectorBlocks.map(detectorFromBlock)
    : [detectorFromBlock(undefined)];
  const source = sources[0];
  const detector = detectors[0];
  const gp = gratingBlock?.parameters ?? {};
  const tp = targetBlock?.parameters ?? {};
  const bp = splitterBlock?.parameters ?? {};
  const design: CoherentAssemblyDesign = {
    schemaVersion: '1.0', mode: 'non-sequential', preset: 'custom-hybrid', revision: Number(config.metadata?.modified ? Date.parse(config.metadata.modified) : 0) || 0,
    name: `${config.name} · Hybrid Assembly`, components, connections: coherentConnections,
    paths: Array.from(pathMap, ([id, componentIds]) => ({ id, label: id, componentIds, roundTrip: false, throughput: 1 })),
    portRoutes: [], routeSets: [],
    blockSequences,
    clearance: { radialMm: 5, axialMm: 3 },
    source, sources,
    beamSplitter: {
      model: ['plate', 'cube', 'pellicle'].includes(String(bp.beamSplitterModel)) ? bp.beamSplitterModel as 'plate' | 'cube' | 'pellicle' : 'ideal',
      reflectionPort: String(bp.reflectionPort ?? 'reflect').toLowerCase() === 'recombine' ? 'recombine' : 'reflect',
      reflectance: Math.max(0, finite(bp.reflectance, 0.5)),
      transmittance: Math.max(0, finite(bp.transmittance, 0.5)),
      reflectedPhaseDeg: finite(bp.reflectedPhaseDeg, 90),
      transmittedPhaseDeg: finite(bp.transmittedPhaseDeg, 0),
      substrateMaterial: String(bp.substrateMaterial ?? 'N-BK7'),
      substrateIndexNd: positive(bp.substrateIndexNd, 1.5168),
      substrateAbbeNumber: positive(bp.substrateAbbeNumber, 64.17),
      substrateThicknessMm: positive(bp.substrateThicknessMm, positive(bp.depthMm, 3)),
      wedgeDeg: finite(bp.wedgeDeg, 0),
      backSurfaceReflectance: Math.min(1, Math.max(0, finite(bp.backSurfaceReflectance, 0))),
    },
    grating: { componentId: String(gratingBlock?.blockId ?? ''), grooveDensityLinesPerMm: positive(gp.grooveDensityLinesPerMm, 600), incidenceAngleDeg: finite(gp.incidenceAngleDeg), order: Math.round(finite(gp.order, 1)), allowedOrders: Array.isArray(gp.allowedOrders) ? gp.allowedOrders.map(Number).filter(Number.isFinite) : [Math.round(finite(gp.order, 1))], efficiency: Math.max(0, finite(gp.efficiency, 0.75)), blazeAngleDeg: finite(gp.blazeAngleDeg, 10.369), blazeWavelengthNm: positive(gp.blazeWavelengthNm, source.centerWavelengthNm), grooveDirection: { x: finite(gp.grooveDirectionX), y: finite(gp.grooveDirectionY, 1), z: finite(gp.grooveDirectionZ) } as Vec3Mm, detectorMagnification: positive(gp.detectorMagnification, 1) },
    target: { kind: ['step', 'tilt', 'sine', 'csv'].includes(String(tp.profile)) ? tp.profile as any : 'flat', spanMm: positive(tp.widthMm, 10), offsetUm: finite(tp.offsetUm), amplitudeUm: finite(tp.amplitudeUm), periodMm: positive(tp.periodMm, 2), stepPositionMm: finite(tp.stepPositionMm), interaction: ['lambertian', 'abg', 'harvey-shack', 'bsdf-csv'].includes(String(tp.interaction)) ? tp.interaction as any : 'specular', scatterSamples: Math.max(1, Math.min(128, Math.round(positive(tp.scatterSamples, 16)))), scatterA: Math.max(0, finite(tp.scatterA, 1)), scatterB: positive(tp.scatterB, 0.01), scatterG: positive(tp.scatterG, 2), scatterSigmaDeg: positive(tp.scatterSigmaDeg, 5), bsdfSamples: Array.isArray(tp.bsdfSamples) ? tp.bsdfSamples : [] },
    detector, detectors,
    traceSettings: { maxInteractions: 24, minRelativePower: 1e-9, maxGeneratedRays: 250000, rayEpsilonMm: 1e-5, renderSegmentLimit: 25000, previewSpatialSamples: 9, previewSpectralSamples: 9 },
    attenuatorTransmission: Math.max(0, finite(physicalBlocks.find((block) => block.blockType === 'NDFilter')?.parameters?.transmission, 1)),
    targetReflectance: Math.max(0, finite(tp.reflectance, 1)), visibility: 1, calibrationOffsetMm: 0,
  };
  const routeConfiguration = normalizePortRouteConfiguration({
    ...config,
    designConnections: designConnections.map((connection) => ({
      ...connection,
      from: { ...connection.from, portId: canonicalPortId(connection.from.blockId, connection.from.portId, config) },
      to: { ...connection.to, portId: canonicalPortId(connection.to.blockId, connection.to.portId, config) },
    })),
  });
  design.portRoutes = routeConfiguration.routes;
  design.routeSets = routeConfiguration.routeSets;
  const reflowed = reflowCoherentAssembly(design);
  const sequenceComponent = new Map(reflowed.components
    .filter((component) => component.kind === 'sequential-group')
    .map((component) => [String(component.metadata?.sequenceId ?? ''), component]));
  reflowed.blockSequences = reflowed.blockSequences.map((sequence) => {
    const component = sequenceComponent.get(sequence.id);
    return component ? {
      ...sequence,
      manualOffset: clone(component.manualOffset),
      rootTransform: resolveComponentTransform(component),
    } : sequence;
  });
  return reflowed;
}
export function migrateLegacyCoherentDesign(
  legacy: CoherentAssemblyDesign,
  existingBlocks: Block[],
): { blocks: Block[]; designConnections: DesignConnection[] } {
  const existingIds = new Set(existingBlocks.map((block) => String(block.blockId ?? '')).filter(Boolean));
  const componentToType = (component: CoherentPhysicalComponent): PhysicalBlockType | null => {
    if (component.metadata?.source === 'design-intent' || component.metadata?.source === 'blocks-reference') return null;
    if (component.kind === 'source') {
      const source = (legacy.sources ?? [legacy.source]).find((entry) => (entry.componentId ?? entry.id) === component.id) ?? legacy.source;
      return source.kind === 'frequency-comb' ? 'FrequencyCombSource' : 'BroadbandSource';
    }
    if (component.kind === 'mirror') return 'FoldMirror';
    if (component.kind === 'attenuator') return 'NDFilter';
    if (component.kind === 'beam-splitter') return 'BeamSplitter';
    if (component.kind === 'reflection-grating') return 'ReflectionGrating';
    if (component.kind === 'target') return 'Target';
    if (component.kind === 'detector') return 'AreaDetector';
    if (component.kind === 'time-detector') return 'TimeDetector';
    if (component.kind === 'stl-object') return 'STLObject';
    return null;
  };
  const migrated: Block[] = [];
  const idMap = new Map<string, string>();
  for (const component of legacy.components ?? []) {
    const type = componentToType(component);
    if (!type) continue;
    let blockId = String(component.id || type);
    if (existingIds.has(blockId)) blockId = `assembly:${blockId}`;
    existingIds.add(blockId);
    idMap.set(component.id, blockId);
    const block = createDefaultPhysicalBlock(type, blockId);
    const p = block.parameters ?? (block.parameters = {});
    const auto = component.autoTransform ?? identityTransform();
    const manual = component.manualOffset ?? identityTransform();
    p.positionXmm = finite(auto.positionMm?.x) + finite(manual.positionMm?.x);
    p.positionYmm = finite(auto.positionMm?.y) + finite(manual.positionMm?.y);
    p.positionZmm = finite(auto.positionMm?.z) + finite(manual.positionMm?.z);
    p.rotationXdeg = finite(auto.rotationDeg?.x) + finite(manual.rotationDeg?.x);
    p.rotationYdeg = finite(auto.rotationDeg?.y) + finite(manual.rotationDeg?.y);
    p.rotationZdeg = finite(auto.rotationDeg?.z) + finite(manual.rotationDeg?.z);
    p.widthMm = component.dimensions?.widthMm;
    p.heightMm = component.dimensions?.heightMm;
    p.depthMm = component.dimensions?.depthMm;
    p.apertureDiameterMm = component.dimensions?.apertureDiameterMm;
    p.dimensionConfidence = component.dimensionConfidence;
    block.metadata = { ...(block.metadata ?? {}), source: 'coherentDesign-migration', label: component.label, legacyComponentId: component.id };
    const source = (legacy.sources ?? [legacy.source]).find((entry) => (entry.componentId ?? entry.id) === component.id);
    if (source) Object.assign(p, {
      centerWavelengthNm: source.centerWavelengthNm, minWavelengthNm: source.minWavelengthNm,
      maxWavelengthNm: source.maxWavelengthNm, bandwidthFwhmNm: source.bandwidthFwhmNm,
      spectralSamples: source.spectralSamples, totalPowerW: source.totalPowerW,
      beamDiameterMm: source.beamDiameterMm, divergenceDeg: source.divergenceDeg,
      spatialProfile: source.spatialProfile,
      renderSpatialSamples: source.renderSpatialSamples,
      detectorSpatialSamples: source.detectorSpatialSamples,
      spatialSamples: source.spatialSamples,
      coherenceGroupId: source.coherenceGroupId, repetitionRateHz: source.repetitionRateHz,
      ceoFrequencyHz: source.ceoFrequencyHz, lineCount: source.lineCount, lineWidthHz: source.lineWidthHz,
    });
    const detector = (legacy.detectors ?? [legacy.detector]).find((entry) => (entry.componentId ?? entry.id) === component.id);
    if (detector) Object.assign(p, {
      pixelCountX: detector.pixelCountX, pixelCountY: detector.pixelCountY,
      pixelPitchUm: detector.pixelPitchUm, responsivity: detector.responsivity,
      fillFactor: detector.fillFactor, exposureTimeS: detector.exposureTimeS,
      saturationElectrons: detector.saturationElectrons, bitDepth: detector.bitDepth,
      frontOnly: detector.frontOnly, samplingRateHz: detector.samplingRateHz,
      detectionBandwidthHz: detector.detectionBandwidthHz, integrationTimeS: detector.integrationTimeS,
      sampleCount: detector.sampleCount,
    });
    if (type === 'BeamSplitter') Object.assign(p, legacy.beamSplitter);
    if (type === 'ReflectionGrating') Object.assign(p, legacy.grating);
    if (type === 'Target') Object.assign(p, {
      profile: legacy.target.kind, widthMm: legacy.target.spanMm, offsetUm: legacy.target.offsetUm,
      amplitudeUm: legacy.target.amplitudeUm, periodMm: legacy.target.periodMm,
      stepPositionMm: legacy.target.stepPositionMm, reflectance: legacy.targetReflectance,
    });
    if (type === 'NDFilter') p.transmission = legacy.attenuatorTransmission;
    migrated.push(block);
  }
  const designConnections = (legacy.connections ?? []).flatMap((connection, index): DesignConnection[] => {
    const fromId = idMap.get(connection.fromComponentId);
    const toId = idMap.get(connection.toComponentId);
    if (!fromId || !toId) return [];
    return [{
      id: String(connection.id ?? `legacy-${index + 1}`),
      from: { blockId: fromId, portId: String(connection.fromPortId ?? 'out') },
      to: { blockId: toId, portId: String(connection.toPortId ?? 'in') },
      distanceMm: Math.max(0, finite(connection.distanceMm)),
      azimuthDeg: Number.isFinite(Number(connection.azimuthDeg)) ? Number(connection.azimuthDeg) : undefined,
      elevationDeg: Number.isFinite(Number(connection.elevationDeg)) ? Number(connection.elevationDeg) : undefined,
      allowReverse: false,
      autoPlace: connection.autoPlace !== false,
      pathLabel: String(connection.pathId ?? 'main'),
    }];
  });
  return { blocks: [...existingBlocks, ...migrated], designConnections };
}
