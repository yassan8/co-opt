import {
  normalizeCoherentAssemblyDesign,
  type CoherentAssemblyDesign,
} from '../analysis/coherent-assembly.ts';
import { buildHybridAssemblyFromConfiguration } from '../analysis/hybrid-design.ts';
import { normalizePortRouteConfiguration } from '../analysis/port-routes.ts';
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
  // Prefer the in-memory Design Intent edit when it exists. Reading persisted
  // storage first made a quick "edit Source -> Run" sequence use the previous
  // ray count until the debounced save completed.
  return loadSystemConfigurations() ?? loadPersistedSystemConfigurations();
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
  active.assemblyRoutingMode = design.routingMode === 'automatic-scene' ? 'automatic-scene' : 'engineered-paths';
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

  for (const source of design.sources?.length ? design.sources : [design.source]) {
    const sourceBlock = byId.get(String(source?.componentId ?? source?.id ?? ''));
    if (!sourceBlock) continue;
    Object.assign(sourceBlock.parameters ?? (sourceBlock.parameters = {}), {
      centerWavelengthNm: source.centerWavelengthNm, minWavelengthNm: source.minWavelengthNm,
      maxWavelengthNm: source.maxWavelengthNm, bandwidthFwhmNm: source.bandwidthFwhmNm,
      spectralSamples: source.spectralSamples, totalPowerW: source.totalPowerW,
      beamDiameterMm: source.beamDiameterMm, divergenceDeg: source.divergenceDeg,
      spatialProfile: source.spatialProfile, coherenceGroupId: source.coherenceGroupId,
      repetitionRateHz: source.repetitionRateHz, ceoFrequencyHz: source.ceoFrequencyHz,
      lineCount: source.lineCount, lineWidthHz: source.lineWidthHz,
    });
  }
  for (const detector of design.detectors?.length ? design.detectors : [design.detector]) {
    const detectorBlock = byId.get(String(detector?.componentId ?? detector?.id ?? ''));
    if (!detectorBlock) continue;
    Object.assign(detectorBlock.parameters ?? (detectorBlock.parameters = {}), {
      pixelCountX: detector.pixelCountX, pixelCountY: detector.pixelCountY, pixelPitchUm: detector.pixelPitchUm,
      responsivity: detector.responsivity, fillFactor: detector.fillFactor, exposureTimeS: detector.exposureTimeS,
      saturationElectrons: detector.saturationElectrons, bitDepth: detector.bitDepth, frontOnly: detector.frontOnly,
      samplingRateHz: detector.samplingRateHz, detectionBandwidthHz: detector.detectionBandwidthHz,
      integrationTimeS: detector.integrationTimeS, sampleCount: detector.sampleCount,
    });
  }
  const gratingBlock = byId.get(String(design.grating?.componentId ?? ''));
  if (gratingBlock) Object.assign(gratingBlock.parameters ?? (gratingBlock.parameters = {}), {
    grooveDensityLinesPerMm: design.grating.grooveDensityLinesPerMm,
    incidenceAngleDeg: design.grating.incidenceAngleDeg, order: design.grating.order,
    allowedOrders: design.grating.allowedOrders, efficiency: design.grating.efficiency,
    blazeAngleDeg: design.grating.blazeAngleDeg, blazeWavelengthNm: design.grating.blazeWavelengthNm,
    detectorMagnification: design.grating.detectorMagnification,
  });
  const splitter = blocks.find((block: any) => block?.blockType === 'BeamSplitter');
  if (splitter) Object.assign(splitter.parameters ?? (splitter.parameters = {}), {
    beamSplitterModel: design.beamSplitter.model,
    reflectionPort: design.beamSplitter.reflectionPort ?? 'reflect',
    reflectance: design.beamSplitter.reflectance,
    transmittance: design.beamSplitter.transmittance,
    reflectedPhaseDeg: design.beamSplitter.reflectedPhaseDeg,
    transmittedPhaseDeg: design.beamSplitter.transmittedPhaseDeg,
    substrateMaterial: design.beamSplitter.substrateMaterial,
    substrateIndexNd: design.beamSplitter.substrateIndexNd,
    substrateAbbeNumber: design.beamSplitter.substrateAbbeNumber,
    substrateThicknessMm: design.beamSplitter.substrateThicknessMm,
    wedgeDeg: design.beamSplitter.wedgeDeg,
    backSurfaceReflectance: design.beamSplitter.backSurfaceReflectance,
  });
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
  const componentIds = new Set((design.components ?? []).map((component) => String(component.id)));
  active.sequentialGroups = (design.blockSequences ?? []).map((sequence) => ({
    id: String(sequence.id ?? '').replace(/^sequential-group:/, '').replace(/^sequential:/, '') || 'main',
    label: String(sequence.label ?? '').trim() || 'Exact sequential optics',
    blockIds: (Array.isArray(sequence.blocks) ? sequence.blocks : [])
      .map((block: any) => String(block?.blockId ?? ''))
      .filter(Boolean),
    pathLabel: String(sequence.pathId ?? '').trim() || 'main',
    // Persist only the authored offset. rootTransform is the resolved world
    // pose after port auto-placement and must not be reapplied on the next load.
    rootTransform: clone(sequence.manualOffset ?? sequence.rootTransform),
    rootTransformVariables: clone(sequence.rootTransformVariables ?? {}),
  }));
  active.designConnections = (design.connections ?? [])
    .filter((connection) => componentIds.has(String(connection.fromComponentId)) && componentIds.has(String(connection.toComponentId)))
    .map((connection) => ({
      id: connection.id,
      from: { blockId: connection.fromComponentId, portId: connection.fromPortId ?? 'out' },
      to: { blockId: connection.toComponentId, portId: connection.toPortId ?? 'in' },
      distanceMm: Number(connection.distanceMm ?? 0), azimuthDeg: Number.isFinite(Number(connection.azimuthDeg)) ? Number(connection.azimuthDeg) : undefined, elevationDeg: Number.isFinite(Number(connection.elevationDeg)) ? Number(connection.elevationDeg) : undefined, autoPlace: connection.autoPlace !== false, placementOverride: connection.placementOverride === true, pathLabel: connection.pathId,
      allowReverse: connection.allowReverse === true,
      variables: clone(connection.variables ?? {}),
    }));
  active.portRoutes = clone(design.portRoutes ?? active.portRoutes ?? []);
  active.routeSets = clone(design.routeSets ?? active.routeSets ?? []);
  delete active.coherentDesign;
}

export function readActiveConfiguration(): any {
  return clone(activeConfig(readSystemConfig()));
}

export function detectActivePortRoutes(): ActiveCoherentDesignSnapshot {
  const system = readSystemConfig();
  const active = activeConfig(system);
  if (!active) throw new Error('Active configuration was not found.');
  const detected = normalizePortRouteConfiguration({ ...active, portRoutes: undefined, routeSets: undefined });
  const current = buildHybridAssemblyFromConfiguration(active);
  current.portRoutes = detected.routes;
  current.routeSets = detected.routeSets;
  return updateActiveCoherentDesign(current, 'route-auto-detect');
}

function coherentSnapshotContentSignature(snapshot: ActiveCoherentDesignSnapshot): string {
  const { revision: _revision, ...designContent } = snapshot.design;
  return JSON.stringify({
    configId: snapshot.configId,
    configName: snapshot.configName,
    design: designContent,
  });
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
  const authoredDesign = normalizeCoherentAssemblyDesign(input);
  authoredDesign.revision = options.preserveRevision
    ? Math.max(0, Math.round(Number(authoredDesign.revision) || 0))
    : Math.max(Number(previous.revision) || 0, Number(authoredDesign.revision) || 0) + 1;
  applyHybridDesignToConfiguration(active, authoredDesign);
  if (active.metadata && typeof active.metadata === 'object') active.metadata.modified = new Date().toISOString();
  // Rebuild from the just-updated Config before notifying other windows. This
  // applies Auto-place distance/azimuth/elevation and synchronizes the resolved
  // world pose of every Exact Sequential Group. Sending the authored snapshot
  // here left Render on the old component transforms until a reload.
  const design = buildHybridAssemblyFromConfiguration(active);
  design.revision = authoredDesign.revision;
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
  let storageRefreshTimer: number | null = null;
  let lastDeliveredSignature = coherentSnapshotContentSignature(readActiveCoherentDesign());
  const deliver = (detail?: Partial<CoherentUpdateDetail>) => {
    if (disposed || detail?.origin === instanceId) return;
    const snapshot = detail?.design && detail.configId !== undefined
      ? { design: normalizeCoherentAssemblyDesign(detail.design), configId: String(detail.configId), configName: String(detail.configName ?? 'Config') }
      : readActiveCoherentDesign();
    // Several same-origin windows can persist the same Config while an
    // analysis is running. Do not turn equivalent storage/DOM notifications
    // into fresh React snapshots, because that restarts Preview and Full PSF.
    const signature = coherentSnapshotContentSignature(snapshot);
    if (signature === lastDeliveredSignature) return;
    lastDeliveredSignature = signature;
    listener(snapshot, String(detail?.reason ?? 'external'));
  };
  const domListener = (event: Event) => deliver((event as CustomEvent<CoherentUpdateDetail>).detail);
  window.addEventListener(EVENT_NAME, domListener);
  window.addEventListener('coopt:system-configurations-updated', domListener);
  // MDI analysis windows run in same-origin iframes. A DOM event dispatched
  // by Design Intents stays in the host window, while the persisted Config
  // change is observable here through the cross-document storage event.
  const storageListener = (event: StorageEvent) => {
    if (event.key !== null && event.key !== 'systemConfigurations') return;
    if (storageRefreshTimer !== null) window.clearTimeout(storageRefreshTimer);
    storageRefreshTimer = window.setTimeout(() => {
      storageRefreshTimer = null;
      deliver({ reason: 'configuration-storage-updated' });
    }, 40);
  };
  window.addEventListener('storage', storageListener);
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
    if (storageRefreshTimer !== null) window.clearTimeout(storageRefreshTimer);
    window.removeEventListener(EVENT_NAME, domListener);
    window.removeEventListener('coopt:system-configurations-updated', domListener);
    window.removeEventListener('storage', storageListener);
    channel?.close();
    unlistenTauri?.();
  };
}
