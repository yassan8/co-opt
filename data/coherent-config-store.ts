import {
  normalizeCoherentAssemblyDesign,
  type CoherentAssemblyDesign,
} from '../analysis/coherent-assembly.ts';
import { buildHybridAssemblyFromConfiguration } from '../analysis/hybrid-design.ts';
import {
  loadPersistedSystemConfigurations,
  loadSystemConfigurations,
  saveSystemConfigurations,
} from './table-configuration.ts';
import { isTauriRuntime } from '../src/desktop/runtime.ts';

const CHANNEL_NAME = 'coopt-coherent-design-v1';
const EVENT_NAME = 'coopt:coherent-design-updated';
const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const undoByConfig = new Map<string, CoherentAssemblyDesign[]>();
const redoByConfig = new Map<string, CoherentAssemblyDesign[]>();

export interface ActiveCoherentDesignSnapshot {
  design: CoherentAssemblyDesign;
  configId: string;
  configName: string;
}

interface CoherentUpdateDetail extends ActiveCoherentDesignSnapshot {
  origin: string;
  reason: string;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function readSystemConfig(): any {
  return loadPersistedSystemConfigurations() ?? loadSystemConfigurations();
}

function activeConfig(system: any): any {
  const configurations = Array.isArray(system?.configurations) ? system.configurations : [];
  return configurations.find((entry: any) => String(entry?.id) === String(system?.activeConfigId)) ?? configurations[0] ?? null;
}

export function readActiveSequentialBlocks(): unknown[] {
  const active = activeConfig(readSystemConfig());
  return Array.isArray(active?.blocks) ? clone(active.blocks) : [];
}

export function readActiveCoherentDesign(): ActiveCoherentDesignSnapshot {
  const system = readSystemConfig();
  const active = activeConfig(system);
  const design = active ? buildHybridAssemblyFromConfiguration(active) : normalizeCoherentAssemblyDesign(undefined);
  return {
    design,
    configId: String(active?.id ?? ''),
    configName: String(active?.name ?? 'Config'),
  };
}

function announce(detail: CoherentUpdateDetail): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
  window.dispatchEvent(new CustomEvent('coopt:system-configurations-updated', { detail }));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(detail);
    channel.close();
  }
  if (isTauriRuntime()) {
    void import('@tauri-apps/api/event')
      .then(({ emit }) => emit(EVENT_NAME, detail))
      .catch(() => undefined);
  }
}

function applyHybridDesignToConfiguration(active: any, design: CoherentAssemblyDesign): void {
  const blocks = Array.isArray(active?.blocks) ? active.blocks : [];
  const byId = new Map<string, any>(blocks.map((block: any) => [String(block?.blockId ?? ''), block]));
  for (const component of design.components ?? []) {
    const blockId = String(component.metadata?.blockId ?? component.id ?? '');
    const block = byId.get(blockId);
    if (!block) continue;
    const parameters = block.parameters && typeof block.parameters === 'object' ? block.parameters : (block.parameters = {});
    parameters.positionXmm = Number(component.manualOffset?.positionMm?.x ?? 0);
    parameters.positionYmm = Number(component.manualOffset?.positionMm?.y ?? 0);
    parameters.positionZmm = Number(component.manualOffset?.positionMm?.z ?? 0);
    parameters.rotationXdeg = Number(component.manualOffset?.rotationDeg?.x ?? 0);
    parameters.rotationYdeg = Number(component.manualOffset?.rotationDeg?.y ?? 0);
    parameters.rotationZdeg = Number(component.manualOffset?.rotationDeg?.z ?? 0);
    parameters.widthMm = component.dimensions?.widthMm;
    parameters.heightMm = component.dimensions?.heightMm;
    parameters.depthMm = component.dimensions?.depthMm;
    if (component.dimensions?.apertureDiameterMm !== undefined) parameters.apertureDiameterMm = component.dimensions.apertureDiameterMm;
    parameters.dimensionConfidence = component.dimensionConfidence;
  }

  const source = design.source;
  const sourceBlock = byId.get(String(source?.componentId ?? source?.id ?? ''));
  if (sourceBlock) Object.assign(sourceBlock.parameters ?? (sourceBlock.parameters = {}), {
    centerWavelengthNm: source.centerWavelengthNm, minWavelengthNm: source.minWavelengthNm,
    maxWavelengthNm: source.maxWavelengthNm, bandwidthFwhmNm: source.bandwidthFwhmNm,
    spectralSamples: source.spectralSamples, totalPowerW: source.totalPowerW,
    beamDiameterMm: source.beamDiameterMm, divergenceDeg: source.divergenceDeg,
    spatialProfile: source.spatialProfile, coherenceGroupId: source.coherenceGroupId,
    repetitionRateHz: source.repetitionRateHz, ceoFrequencyHz: source.ceoFrequencyHz,
    lineCount: source.lineCount, lineWidthHz: source.lineWidthHz,
  });
  const detector = design.detector;
  const detectorBlock = byId.get(String(detector?.componentId ?? detector?.id ?? ''));
  if (detectorBlock) Object.assign(detectorBlock.parameters ?? (detectorBlock.parameters = {}), {
    pixelCountX: detector.pixelCountX, pixelCountY: detector.pixelCountY, pixelPitchUm: detector.pixelPitchUm,
    responsivity: detector.responsivity, fillFactor: detector.fillFactor, exposureTimeS: detector.exposureTimeS,
    saturationElectrons: detector.saturationElectrons, bitDepth: detector.bitDepth, frontOnly: detector.frontOnly,
    samplingRateHz: detector.samplingRateHz, detectionBandwidthHz: detector.detectionBandwidthHz,
    integrationTimeS: detector.integrationTimeS, sampleCount: detector.sampleCount,
  });
  const gratingBlock = byId.get(String(design.grating?.componentId ?? ''));
  if (gratingBlock) Object.assign(gratingBlock.parameters ?? (gratingBlock.parameters = {}), {
    grooveDensityLinesPerMm: design.grating.grooveDensityLinesPerMm,
    incidenceAngleDeg: design.grating.incidenceAngleDeg, order: design.grating.order,
    allowedOrders: design.grating.allowedOrders, efficiency: design.grating.efficiency,
    blazeAngleDeg: design.grating.blazeAngleDeg, blazeWavelengthNm: design.grating.blazeWavelengthNm,
    detectorMagnification: design.grating.detectorMagnification,
  });
  const splitter = blocks.find((block: any) => block?.blockType === 'BeamSplitter');
  if (splitter) Object.assign(splitter.parameters ?? (splitter.parameters = {}), design.beamSplitter);
  const target = blocks.find((block: any) => block?.blockType === 'Target');
  if (target) Object.assign(target.parameters ?? (target.parameters = {}), {
    profile: design.target.kind, widthMm: design.target.spanMm, offsetUm: design.target.offsetUm,
    amplitudeUm: design.target.amplitudeUm, periodMm: design.target.periodMm,
    stepPositionMm: design.target.stepPositionMm, interaction: design.target.interaction,
    scatterSamples: design.target.scatterSamples, scatterA: design.target.scatterA,
    scatterB: design.target.scatterB, scatterG: design.target.scatterG,
    scatterSigmaDeg: design.target.scatterSigmaDeg, bsdfSamples: design.target.bsdfSamples,
    reflectance: design.targetReflectance,
  });
  active.designConnections = (design.connections ?? [])
    .filter((connection) => byId.has(String(connection.fromComponentId)) && byId.has(String(connection.toComponentId)))
    .map((connection) => ({
      id: connection.id,
      from: { blockId: connection.fromComponentId, portId: connection.fromPortId ?? 'out' },
      to: { blockId: connection.toComponentId, portId: connection.toPortId ?? 'in' },
      distanceMm: Number(connection.distanceMm ?? 0), azimuthDeg: Number.isFinite(Number(connection.azimuthDeg)) ? Number(connection.azimuthDeg) : undefined, elevationDeg: Number.isFinite(Number(connection.elevationDeg)) ? Number(connection.elevationDeg) : undefined, autoPlace: connection.autoPlace !== false, pathLabel: connection.pathId,
    }));
  delete active.coherentDesign;
}
function persist(
  input: CoherentAssemblyDesign,
  reason: string,
  options: { recordHistory?: boolean; preserveRevision?: boolean } = {},
): ActiveCoherentDesignSnapshot {
  const system = clone(readSystemConfig());
  const active = activeConfig(system);
  if (!active) throw new Error('Active configuration was not found.');
  const configId = String(active.id ?? '');
  const previous = buildHybridAssemblyFromConfiguration(active);
  if (options.recordHistory !== false && JSON.stringify(previous) !== JSON.stringify(input)) {
    const undo = undoByConfig.get(configId) ?? [];
    undo.push(clone(previous));
    if (undo.length > 100) undo.shift();
    undoByConfig.set(configId, undo);
    redoByConfig.set(configId, []);
  }
  const design = normalizeCoherentAssemblyDesign(input);
  design.revision = options.preserveRevision
    ? Math.max(0, Math.round(Number(design.revision) || 0))
    : Math.max(Number(previous.revision) || 0, Number(design.revision) || 0) + 1;
  applyHybridDesignToConfiguration(active, design);
  if (active.metadata && typeof active.metadata === 'object') active.metadata.modified = new Date().toISOString();
  saveSystemConfigurations(system);
  const snapshot = { design, configId, configName: String(active.name ?? 'Config') };
  announce({ ...snapshot, origin: instanceId, reason });
  return snapshot;
}

export function updateActiveCoherentDesign(
  input: CoherentAssemblyDesign,
  reason = 'edit',
): ActiveCoherentDesignSnapshot {
  return persist(input, reason, { recordHistory: true });
}

export function undoActiveCoherentDesign(): ActiveCoherentDesignSnapshot | null {
  const current = readActiveCoherentDesign();
  const undo = undoByConfig.get(current.configId) ?? [];
  const previous = undo.pop();
  if (!previous) return null;
  const redo = redoByConfig.get(current.configId) ?? [];
  redo.push(clone(current.design));
  redoByConfig.set(current.configId, redo);
  undoByConfig.set(current.configId, undo);
  return persist(previous, 'undo', { recordHistory: false });
}

export function redoActiveCoherentDesign(): ActiveCoherentDesignSnapshot | null {
  const current = readActiveCoherentDesign();
  const redo = redoByConfig.get(current.configId) ?? [];
  const next = redo.pop();
  if (!next) return null;
  const undo = undoByConfig.get(current.configId) ?? [];
  undo.push(clone(current.design));
  undoByConfig.set(current.configId, undo);
  redoByConfig.set(current.configId, redo);
  return persist(next, 'redo', { recordHistory: false });
}

export function subscribeActiveCoherentDesign(
  listener: (snapshot: ActiveCoherentDesignSnapshot, reason: string) => void,
): () => void {
  let disposed = false;
  const deliver = (detail?: Partial<CoherentUpdateDetail>) => {
    if (disposed || detail?.origin === instanceId) return;
    const snapshot = detail?.design && detail.configId !== undefined
      ? { design: normalizeCoherentAssemblyDesign(detail.design), configId: String(detail.configId), configName: String(detail.configName ?? 'Config') }
      : readActiveCoherentDesign();
    listener(snapshot, String(detail?.reason ?? 'external'));
  };
  const domListener = (event: Event) => deliver((event as CustomEvent<CoherentUpdateDetail>).detail);
  window.addEventListener(EVENT_NAME, domListener);
  window.addEventListener('coopt:system-configurations-updated', domListener);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
  if (channel) channel.onmessage = (event) => deliver(event.data as CoherentUpdateDetail);
  let unlistenTauri: (() => void) | undefined;
  if (isTauriRuntime()) {
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<CoherentUpdateDetail>(EVENT_NAME, (event) => deliver(event.payload)))
      .then((unlisten) => { unlistenTauri = unlisten; })
      .catch(() => undefined);
  }
  return () => {
    disposed = true;
    window.removeEventListener(EVENT_NAME, domListener);
    window.removeEventListener('coopt:system-configurations-updated', domListener);
    channel?.close();
    unlistenTauri?.();
  };
}
