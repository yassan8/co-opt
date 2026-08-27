import type {
  DesignConnection,
  PortRoute,
  PortRouteSet,
} from '../data/block-schema.ts';
import type { Configuration } from '../data/table-configuration.ts';
import {
  resolveComponentTransform,
  type CoherentAssemblyDesign,
  type CoherentPhysicalComponent,
  type Vec3Mm,
} from './coherent-assembly.ts';
import { buildHybridAssemblyFromConfiguration } from './hybrid-design.ts';
import { worldPortDirection, worldPortPosition } from './coherent-port-layout.ts';

export type AssemblyRoutingMode = 'automatic-scene' | 'engineered-paths';

export interface AutomaticAssemblyRoutingResult {
  configuration: Configuration;
  design: CoherentAssemblyDesign;
  connections: DesignConnection[];
  routes: PortRoute[];
  routeSets: PortRouteSet[];
  warnings: string[];
}

interface TraversalLink {
  fromComponentId: string;
  fromPortId: string;
  toComponentId: string;
  toPortId: string;
}

interface TraversalState {
  componentId: string;
  entryPortId: string | null;
  incomingDirection: Vec3Mm | null;
  links: TraversalLink[];
  visitedTransitions: Set<string>;
}

interface PortHit {
  component: CoherentPhysicalComponent;
  portId: string;
  axialMm: number;
  lateralMm: number;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const subtract = (a: Vec3Mm, b: Vec3Mm): Vec3Mm => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3Mm, b: Vec3Mm): number => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (value: Vec3Mm): number => Math.hypot(value.x, value.y, value.z);
const scale = (value: Vec3Mm, factor: number): Vec3Mm => ({ x: value.x * factor, y: value.y * factor, z: value.z * factor });
const add = (a: Vec3Mm, b: Vec3Mm): Vec3Mm => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const normalize = (value: Vec3Mm): Vec3Mm => {
  const magnitude = length(value) || 1;
  return scale(value, 1 / magnitude);
};
const cross = (a: Vec3Mm, b: Vec3Mm): Vec3Mm => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function componentAxes(component: CoherentPhysicalComponent): { x: Vec3Mm; y: Vec3Mm; z: Vec3Mm } {
  const rotation = resolveComponentTransform(component).rotationDeg;
  const rx = rotation.x * Math.PI / 180;
  const ry = rotation.y * Math.PI / 180;
  const rz = rotation.z * Math.PI / 180;
  const cx = Math.cos(rx); const sx = Math.sin(rx);
  const cy = Math.cos(ry); const sy = Math.sin(ry);
  const cz = Math.cos(rz); const sz = Math.sin(rz);
  return {
    x: { x: cz * cy, y: sz * cy, z: -sy },
    y: { x: cz * sy * sx - sz * cx, y: sz * sy * sx + cz * cx, z: cy * sx },
    z: { x: cz * sy * cx + sz * sx, y: sz * sy * cx - cz * sx, z: cy * cx },
  };
}

function reflect(direction: Vec3Mm, normal: Vec3Mm): Vec3Mm {
  const unitNormal = normalize(normal);
  return normalize(subtract(direction, scale(unitNormal, 2 * dot(direction, unitNormal))));
}

export function assemblyRoutingMode(value: Pick<Configuration, 'assemblyRoutingMode'> | null | undefined): AssemblyRoutingMode {
  return value?.assemblyRoutingMode === 'automatic-scene' ? 'automatic-scene' : 'engineered-paths';
}

function componentEntryPorts(component: CoherentPhysicalComponent): string[] {
  if (component.kind === 'source') return [];
  if (component.kind === 'detector' || component.kind === 'time-detector') return ['detect'];
  if (component.kind === 'sequential-group') return ['front', 'back'];
  if (component.kind === 'mirror') return component.ports.some((port) => port.id === 'in') ? ['in'] : component.ports.map((port) => port.id);
  if (component.kind === 'attenuator') return ['in', 'out'];
  if (component.kind === 'target') return ['incident'];
  if (component.kind === 'reflection-grating') return ['incident'];
  if (component.kind === 'beam-splitter') return component.ports.map((port) => port.id);
  return component.ports.map((port) => port.id);
}

function exitChoices(
  design: CoherentAssemblyDesign,
  component: CoherentPhysicalComponent,
  entryPortId: string | null,
  incomingDirection: Vec3Mm | null,
): Array<{ portId: string; direction: Vec3Mm }> {
  if (component.kind === 'source') return [{ portId: 'emit', direction: worldPortDirection(component, 'emit', 'from') }];
  if (component.kind === 'detector' || component.kind === 'time-detector') return [];
  if (component.kind === 'sequential-group') {
    const portId = entryPortId === 'back' ? 'front' : 'back';
    return [{ portId, direction: worldPortDirection(component, portId, 'from') }];
  }
  const incident = normalize(incomingDirection ?? componentAxes(component).z);
  if (component.kind === 'mirror') {
    const portId = component.ports.some((port) => port.id === 'out') ? 'out' : 'in';
    return [{ portId, direction: reflect(incident, componentAxes(component).z) }];
  }
  if (component.kind === 'attenuator') {
    const portId = entryPortId === 'out' ? 'in' : 'out';
    return [{ portId, direction: incident }];
  }
  if (component.kind === 'target') return [{ portId: 'incident', direction: reflect(incident, componentAxes(component).z) }];
  if (component.kind === 'reflection-grating') {
    const normal = componentAxes(component).z;
    const grooveLocal = normalize({
      x: finite(component.metadata?.grooveDirectionX, 0),
      y: finite(component.metadata?.grooveDirectionY, 1),
      z: finite(component.metadata?.grooveDirectionZ, 0),
    });
    const axes = componentAxes(component);
    const groove = normalize(add(add(scale(axes.x, grooveLocal.x), scale(axes.y, grooveLocal.y)), scale(axes.z, grooveLocal.z)));
    const dispersion = normalize(cross(groove, normal));
    const incidentNormal = dot(incident, normal);
    const incidentTangent = subtract(incident, scale(normal, incidentNormal));
    const wavelengthMm = Math.max(1e-12, finite(design.source?.centerWavelengthNm, 600)) * 1e-6;
    const order = Math.round(finite(design.grating?.order, 1));
    const shift = order * wavelengthMm * Math.max(0, finite(component.metadata?.grooveDensityLinesPerMm, finite(design.grating?.grooveDensityLinesPerMm, 600)));
    const outgoingTangent = add(incidentTangent, scale(dispersion, shift));
    const tangentSquared = dot(outgoingTangent, outgoingTangent);
    if (tangentSquared > 1) return [];
    const normalMagnitude = Math.sqrt(Math.max(0, 1 - tangentSquared));
    const outgoingNormal = incidentNormal >= 0 ? -normalMagnitude : normalMagnitude;
    return [{ portId: 'incident', direction: normalize(add(outgoingTangent, scale(normal, outgoingNormal))) }];
  }
  if (component.kind === 'beam-splitter') {
    const axes = componentAxes(component);
    const reflectionPort = String(design.beamSplitter?.reflectionPort ?? component.metadata?.reflectionPort ?? 'reflect').toLowerCase();
    const normal = reflectionPort === 'recombine' ? normalize(add(axes.z, axes.x)) : normalize(subtract(axes.z, axes.x));
    const ports = entryPortId === 'common'
      ? ['transmit', 'reflect', 'recombine']
      : entryPortId === 'transmit' || entryPortId === 'reflect'
        ? ['recombine', 'common']
        : entryPortId === 'recombine'
          ? ['transmit', 'reflect', 'common']
          : ['transmit', 'reflect', 'recombine'];
    return ports.map((portId) => {
      const entry = String(entryPortId ?? '').toLowerCase();
      const exit = portId.toLowerCase();
      const transmittedPair = (entry === 'common' && exit === 'transmit')
        || (entry === 'transmit' && exit === 'common')
        || (entry === 'reflect' && exit === 'recombine')
        || (entry === 'recombine' && exit === 'reflect');
      return { portId, direction: transmittedPair ? incident : reflect(incident, normal) };
    });
  }
  const portId = component.ports.find((port) => port.id === 'out')?.id
    ?? component.ports.find((port) => port.id !== entryPortId)?.id;
  return portId ? [{ portId, direction: incident }] : [];
}

function componentCatchRadiusMm(component: CoherentPhysicalComponent): number {
  const apertureRadius = Math.max(0, finite(component.dimensions.apertureDiameterMm) * 0.5);
  const envelopeRadius = Math.max(0, Math.min(
    finite(component.dimensions.widthMm, 0),
    finite(component.dimensions.heightMm, 0),
  ) * 0.5);
  return Math.max(0.35, apertureRadius, envelopeRadius);
}

function nearestPortHit(
  design: CoherentAssemblyDesign,
  fromComponentId: string,
  origin: Vec3Mm,
  direction: Vec3Mm,
): PortHit | null {
  let best: PortHit | null = null;
  for (const component of design.components) {
    if (component.id === fromComponentId || component.kind === 'source') continue;
    for (const portId of componentEntryPorts(component)) {
      if (!component.ports.some((port) => port.id === portId)) continue;
      const target = worldPortPosition(component, portId, 'to');
      const delta = subtract(target, origin);
      const axialMm = dot(delta, direction);
      if (!(axialMm > 1e-4)) continue;
      const lateralMm = Math.sqrt(Math.max(0, dot(delta, delta) - axialMm * axialMm));
      const toleranceMm = componentCatchRadiusMm(component) + Math.min(2, axialMm * 0.0025);
      if (lateralMm > toleranceMm) continue;
      if (!best || axialMm < best.axialMm - 1e-6 || (
        Math.abs(axialMm - best.axialMm) <= 1e-6 && lateralMm < best.lateralMm
      )) best = { component, portId, axialMm, lateralMm };
    }
  }
  return best;
}

function routeLabel(design: CoherentAssemblyDesign, links: TraversalLink[], index: number): string {
  const byId = new Map(design.components.map((component) => [component.id, component]));
  const source = byId.get(links[0]?.fromComponentId)?.label ?? 'Source';
  const componentIds = new Set(links.flatMap((link) => [link.fromComponentId, link.toComponentId]));
  const hasTarget = Array.from(componentIds).some((id) => byId.get(id)?.kind === 'target');
  const hasGrating = Array.from(componentIds).some((id) => byId.get(id)?.kind === 'reflection-grating');
  const role = hasTarget ? 'Measurement' : hasGrating ? 'Reference' : 'Auxiliary';
  return `${source} · ${role} ${index + 1}`;
}

/**
 * Discovers primary Source-to-Detector traversals from component world poses.
 * The result is deterministic and ephemeral: ports remain an internal tracing
 * detail, so normal Design Intent editing only needs components, poses and the
 * receiving Detector.
 */
export function discoverAutomaticAssemblyRoutes(
  input: CoherentAssemblyDesign,
  maxInteractions = 32,
): { links: TraversalLink[]; routes: Array<{ links: TraversalLink[]; sourceId: string; detectorId: string }>; warnings: string[] } {
  const design = input;
  const byId = new Map(design.components.map((component) => [component.id, component]));
  const sources = design.components.filter((component) => component.kind === 'source');
  const completed: Array<{ links: TraversalLink[]; sourceId: string; detectorId: string }> = [];
  const warnings: string[] = [];
  for (const source of sources) {
    const queue: TraversalState[] = [{ componentId: source.id, entryPortId: null, incomingDirection: null, links: [], visitedTransitions: new Set() }];
    let expanded = 0;
    while (queue.length > 0 && expanded < 2048) {
      const state = queue.shift()!;
      const component = byId.get(state.componentId);
      if (!component) continue;
      if (component.kind === 'detector' || component.kind === 'time-detector') {
        if (state.links.length > 0) completed.push({ links: state.links, sourceId: source.id, detectorId: component.id });
        continue;
      }
      if (state.links.length >= maxInteractions) continue;
      for (const choice of exitChoices(design, component, state.entryPortId, state.incomingDirection)) {
        const { portId: exitPortId, direction } = choice;
        if (!component.ports.some((port) => port.id === exitPortId)) continue;
        const origin = worldPortPosition(component, exitPortId, 'from');
        const hit = nearestPortHit(design, component.id, origin, direction);
        if (!hit) continue;
        const transitionKey = `${component.id}:${exitPortId}->${hit.component.id}:${hit.portId}`;
        if (state.visitedTransitions.has(transitionKey)) continue;
        const nextVisited = new Set(state.visitedTransitions);
        nextVisited.add(transitionKey);
        queue.push({
          componentId: hit.component.id,
          entryPortId: hit.portId,
          incomingDirection: direction,
          links: [...state.links, {
            fromComponentId: component.id,
            fromPortId: exitPortId,
            toComponentId: hit.component.id,
            toPortId: hit.portId,
          }],
          visitedTransitions: nextVisited,
        });
        expanded += 1;
      }
    }
    if (!completed.some((route) => route.sourceId === source.id)) {
      warnings.push(`${source.label}: automatic scene tracing did not find a Detector.`);
    }
  }
  const unique = new Map<string, (typeof completed)[number]>();
  for (const route of completed) {
    const signature = route.links.map((link) => `${link.fromComponentId}:${link.fromPortId}>${link.toComponentId}:${link.toPortId}`).join('|');
    if (!unique.has(signature)) unique.set(signature, route);
  }
  const routes = Array.from(unique.values());
  return { links: routes.flatMap((route) => route.links), routes, warnings };
}

function bakeResolvedPoses(config: Configuration, design: CoherentAssemblyDesign): Configuration {
  const baked = clone(config);
  const componentByBlock = new Map(design.components.map((component) => [
    String(component.metadata?.blockId ?? component.id),
    component,
  ]));
  for (const block of baked.blocks ?? []) {
    const component = componentByBlock.get(String(block.blockId ?? ''));
    if (!component || component.kind === 'sequential-group') continue;
    const transform = resolveComponentTransform(component);
    const parameters = block.parameters ?? (block.parameters = {});
    parameters.positionXmm = transform.positionMm.x;
    parameters.positionYmm = transform.positionMm.y;
    parameters.positionZmm = transform.positionMm.z;
    parameters.rotationXdeg = transform.rotationDeg.x;
    parameters.rotationYdeg = transform.rotationDeg.y;
    parameters.rotationZdeg = transform.rotationDeg.z;
  }
  const sequenceByKey = new Map(design.blockSequences.map((sequence) => [
    String(sequence.id).replace(/^sequential:/, ''),
    sequence,
  ]));
  baked.sequentialGroups = (baked.sequentialGroups ?? []).map((group) => {
    const sequence = sequenceByKey.get(String(group.id).replace(/^sequential-group:/, '').replace(/^sequential:/, ''));
    return sequence ? { ...group, rootTransform: clone(sequence.rootTransform) } : group;
  });
  return baked;
}

export function compileAutomaticAssemblyRouting(config: Configuration): AutomaticAssemblyRoutingResult {
  const design = buildHybridAssemblyFromConfiguration(config);
  const discovered = discoverAutomaticAssemblyRoutes(design);
  // Existing assemblies already contain the user's intended measurement,
  // reference and return-pass topology. Treat that topology as a one-time
  // migration hint, not as editable runtime plumbing. New assemblies with no
  // saved routes are discovered solely from physical scene intersections.
  const authoredConnections = new Map((config.designConnections ?? []).map((connection) => [connection.id, connection]));
  const migratedRoutes = (config.portRoutes ?? []).filter((route) => route.enabled !== false).map((route) => {
    const links: TraversalLink[] = [];
    for (const step of route.steps ?? []) {
      const connection = authoredConnections.get(step.connectionId);
      if (!connection) continue;
      const reverse = step.direction === 'reverse';
      const from = reverse ? connection.to : connection.from;
      const to = reverse ? connection.from : connection.to;
      links.push({
        fromComponentId: from.blockId,
        fromPortId: step.departurePortId ?? from.portId,
        toComponentId: to.blockId,
        toPortId: step.arrivalPortId ?? to.portId,
      });
    }
    return {
      links,
      sourceId: String(route.sourceBlockId ?? links[0]?.fromComponentId ?? ''),
      detectorId: String(route.detectorBlockId ?? links[links.length - 1]?.toComponentId ?? ''),
      routeId: route.id,
      authoredLabel: route.label,
    };
  }).filter((route) => route.links.length > 0 && route.sourceId && route.detectorId);
  const traversals = migratedRoutes.length > 0 ? migratedRoutes : discovered.routes;
  const connectionBySignature = new Map<string, DesignConnection>();
  const connectionFor = (link: TraversalLink): DesignConnection => {
    const signature = `${link.fromComponentId}:${link.fromPortId}>${link.toComponentId}:${link.toPortId}`;
    const existing = connectionBySignature.get(signature);
    if (existing) return existing;
    const from = design.components.find((component) => component.id === link.fromComponentId)!;
    const to = design.components.find((component) => component.id === link.toComponentId)!;
    const fromPoint = worldPortPosition(from, link.fromPortId, 'from');
    const toPoint = worldPortPosition(to, link.toPortId, 'to');
    const delta = subtract(toPoint, fromPoint);
    const distanceMm = length(delta);
    const horizontal = Math.hypot(delta.x, delta.z);
    const connection: DesignConnection = {
      id: `scene-link-${connectionBySignature.size + 1}`,
      from: { blockId: link.fromComponentId, portId: link.fromPortId },
      to: { blockId: link.toComponentId, portId: link.toPortId },
      distanceMm,
      azimuthDeg: Math.atan2(delta.z, delta.x) * 180 / Math.PI,
      elevationDeg: Math.atan2(delta.y, horizontal) * 180 / Math.PI,
      allowReverse: true,
      autoPlace: false,
      placementOverride: false,
      pathLabel: 'automatic-scene',
    };
    connectionBySignature.set(signature, connection);
    return connection;
  };
  const routes: PortRoute[] = traversals.map((route, index) => ({
    id: 'routeId' in route ? route.routeId : `scene-route-${index + 1}`,
    label: 'authoredLabel' in route ? route.authoredLabel : routeLabel(design, route.links, index),
    enabled: true,
    sourceBlockId: route.sourceId,
    detectorBlockId: route.detectorId,
    steps: route.links.map((link) => ({ connectionId: connectionFor(link).id, direction: 'forward' as const })),
  }));
  const byId = new Map(design.components.map((component) => [component.id, component]));
  const routeSets: PortRouteSet[] = [];
  for (const detectorId of Array.from(new Set(routes.map((route) => String(route.detectorBlockId ?? '')).filter(Boolean)))) {
    const detectorRoutes = routes.filter((route) => route.detectorBlockId === detectorId);
    const containsKind = (route: PortRoute, kind: CoherentPhysicalComponent['kind']) => route.steps.some((step) => {
      const connection = Array.from(connectionBySignature.values()).find((entry) => entry.id === step.connectionId);
      return byId.get(String(connection?.from.blockId))?.kind === kind || byId.get(String(connection?.to.blockId))?.kind === kind;
    });
    const measurement = detectorRoutes.find((route) => containsKind(route, 'target'));
    const reference = detectorRoutes.find((route) => route.id !== measurement?.id && containsKind(route, 'reflection-grating'));
    const prior = (config.routeSets ?? []).find((set) => String(set.detectorBlockId) === detectorId);
    routeSets.push({
      id: prior?.id ?? `scene-route-set-${routeSets.length + 1}`,
      label: `${byId.get(detectorId)?.label ?? detectorId} signal`,
      detectorBlockId: detectorId,
      routeIds: detectorRoutes.map((route) => route.id),
      measurementRouteId: measurement?.id ?? detectorRoutes[0]?.id,
      referenceRouteId: reference?.id ?? detectorRoutes.find((route) => route.id !== measurement?.id)?.id,
      opdCalibrationMm: prior?.opdCalibrationMm,
    });
  }
  const configuration = bakeResolvedPoses(config, design);
  configuration.designConnections = Array.from(connectionBySignature.values());
  configuration.portRoutes = routes;
  configuration.routeSets = routeSets;
  return {
    configuration,
    design,
    connections: configuration.designConnections,
    routes,
    routeSets,
    warnings: migratedRoutes.length > 0 ? [] : discovered.warnings,
  };
}
