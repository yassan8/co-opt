import type {
  DesignConnection,
  PortRoute,
  PortRouteSet,
  PortRouteStep,
  PortRouteTraversalDirection,
} from '../data/block-schema.ts';
import type { Configuration } from '../data/table-configuration.ts';

export interface PortRouteIssue {
  routeId: string;
  stepIndex?: number;
  connectionId?: string;
  port?: { blockId: string; portId: string };
  message: string;
}

export interface DirectedConnectionStep {
  connection: DesignConnection;
  direction: PortRouteTraversalDirection;
  departure: { blockId: string; portId: string };
  arrival: { blockId: string; portId: string };
}

export interface ResolvedPortRoute {
  route: PortRoute;
  steps: DirectedConnectionStep[];
  valid: boolean;
  issues: PortRouteIssue[];
}

export interface NormalizedPortRouteConfiguration {
  routes: PortRoute[];
  routeSets: PortRouteSet[];
  resolvedRoutes: ResolvedPortRoute[];
  issues: PortRouteIssue[];
  generated: boolean;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function id(value: unknown): string {
  return String(value ?? '').trim();
}

function blockTypeMap(config: Configuration): Map<string, string> {
  return new Map((config.blocks ?? []).map((block) => [id(block.blockId), id(block.blockType)]));
}

function groupComponentIds(config: Configuration): Set<string> {
  const ids = new Set((config.sequentialGroups ?? []).flatMap((group) => {
    const groupId = id(group.id) || 'main';
    return [groupId, `sequential:${groupId}`, `sequential-group:${groupId}`];
  }));
  // Existing files have one implicit exact group and already use this runtime
  // component id in connections even though sequentialGroups[] is absent.
  if ((config.sequentialGroups ?? []).length === 0) {
    ids.add('main');
    ids.add('sequential:main');
    ids.add('sequential-group:main');
  }
  return ids;
}

export function canonicalPortId(componentId: string, portId: string, config?: Configuration): string {
  const raw = id(portId).toLowerCase();
  const groups = config ? groupComponentIds(config) : null;
  const isGroup = groups?.has(id(componentId)) || id(componentId).startsWith('sequential-group:');
  if (!isGroup) return id(portId);
  if (raw === 'in' || raw === 'input' || raw === 'front') return 'front';
  if (raw === 'out' || raw === 'output' || raw === 'back') return 'back';
  return id(portId);
}

export function directConnectionStep(
  connection: DesignConnection,
  direction: PortRouteTraversalDirection,
): DirectedConnectionStep {
  const reverse = direction === 'reverse';
  return {
    connection,
    direction,
    departure: clone(reverse ? connection.to : connection.from),
    arrival: clone(reverse ? connection.from : connection.to),
  };
}

export function resolvePortRoute(config: Configuration, route: PortRoute): ResolvedPortRoute {
  const byId = new Map((config.designConnections ?? []).map((connection) => [id(connection.id), connection]));
  const blocks = new Set((config.blocks ?? []).map((block) => id(block.blockId)).filter(Boolean));
  for (const groupId of groupComponentIds(config)) blocks.add(groupId);
  const issues: PortRouteIssue[] = [];
  const steps: DirectedConnectionStep[] = [];

  for (let stepIndex = 0; stepIndex < (route.steps ?? []).length; stepIndex += 1) {
    const step = route.steps[stepIndex];
    const connection = byId.get(id(step.connectionId));
    if (!connection) {
      issues.push({ routeId: route.id, stepIndex, connectionId: id(step.connectionId), message: 'Connection was removed.' });
      continue;
    }
    if (step.direction === 'reverse' && connection.allowReverse !== true) {
      issues.push({ routeId: route.id, stepIndex, connectionId: connection.id, message: 'Reverse traversal is disabled for this connection.' });
    }
    const directed = directConnectionStep(connection, step.direction === 'reverse' ? 'reverse' : 'forward');
    if (id(step.departurePortId)) directed.departure.portId = id(step.departurePortId);
    if (id(step.arrivalPortId)) directed.arrival.portId = id(step.arrivalPortId);
    directed.departure.portId = canonicalPortId(directed.departure.blockId, directed.departure.portId, config);
    directed.arrival.portId = canonicalPortId(directed.arrival.blockId, directed.arrival.portId, config);
    if (!blocks.has(directed.departure.blockId)) {
      issues.push({ routeId: route.id, stepIndex, connectionId: connection.id, port: directed.departure, message: 'Departure component is missing.' });
    }
    if (!blocks.has(directed.arrival.blockId)) {
      issues.push({ routeId: route.id, stepIndex, connectionId: connection.id, port: directed.arrival, message: 'Arrival component is missing.' });
    }
    const previous = steps[steps.length - 1];
    if (previous && previous.arrival.blockId !== directed.departure.blockId) {
      issues.push({
        routeId: route.id,
        stepIndex,
        connectionId: connection.id,
        port: directed.departure,
        message: `Route is discontinuous after ${previous.arrival.blockId}:${previous.arrival.portId}.`,
      });
    } else if (previous && previous.arrival.blockId === directed.departure.blockId) {
      const componentId = directed.departure.blockId;
      if (groupComponentIds(config).has(componentId)) {
        const entry = canonicalPortId(componentId, previous.arrival.portId, config);
        const exit = canonicalPortId(componentId, directed.departure.portId, config);
        if (!((entry === 'front' && exit === 'back') || (entry === 'back' && exit === 'front'))) {
          issues.push({ routeId: route.id, stepIndex, connectionId: connection.id, port: directed.departure, message: 'Exact Sequential Group must be crossed between Front and Back.' });
        }
      }
    }
    steps.push(directed);
  }

  if (steps.length === 0) issues.push({ routeId: route.id, message: 'Route has no connection steps.' });
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (route.sourceBlockId && first && id(route.sourceBlockId) !== first.departure.blockId) {
    issues.push({ routeId: route.id, stepIndex: 0, port: first.departure, message: 'Saved source does not match the first route component.' });
  }
  if (route.detectorBlockId && last && id(route.detectorBlockId) !== last.arrival.blockId) {
    issues.push({ routeId: route.id, stepIndex: steps.length - 1, port: last.arrival, message: 'Saved detector does not match the last route component.' });
  }
  return { route: clone(route), steps, valid: issues.length === 0 && route.enabled !== false, issues };
}

function sourceAndDetectorIds(config: Configuration): { sources: Set<string>; detectors: Set<string> } {
  const types = blockTypeMap(config);
  const sources = new Set<string>();
  const detectors = new Set<string>();
  for (const [blockId, type] of types) {
    if (type === 'BroadbandSource' || type === 'FrequencyCombSource') sources.add(blockId);
    if (type === 'AreaDetector' || type === 'TimeDetector') detectors.add(blockId);
  }
  return { sources, detectors };
}

function inferredLabel(index: number, detectorId: string): string {
  return detectorId ? `Path ${index + 1} → ${detectorId}` : `Optical path ${index + 1}`;
}

/** Auto discovery deliberately rejects cycles. Round trips and recombination stay explicit. */
export function discoverSimplePortRoutes(config: Configuration, maxSteps = 64): PortRoute[] {
  const connections = config.designConnections ?? [];
  const { sources, detectors } = sourceAndDetectorIds(config);
  const edgesByDeparture = new Map<string, DirectedConnectionStep[]>();
  for (const connection of connections) {
    const forward = directConnectionStep(connection, 'forward');
    const list = edgesByDeparture.get(forward.departure.blockId) ?? [];
    list.push(forward);
    edgesByDeparture.set(forward.departure.blockId, list);
    if (connection.allowReverse === true) {
      const reverse = directConnectionStep(connection, 'reverse');
      const reverseList = edgesByDeparture.get(reverse.departure.blockId) ?? [];
      reverseList.push(reverse);
      edgesByDeparture.set(reverse.departure.blockId, reverseList);
    }
  }

  const found: PortRoute[] = [];
  const exactGroups = groupComponentIds(config);
  const visit = (
    sourceId: string,
    componentId: string,
    entryPortId: string | null,
    steps: PortRouteStep[],
    usedConnections: Set<string>,
    visitedPorts: Set<string>,
    visitedComponents: Set<string>,
  ) => {
    if (steps.length > maxSteps) return;
    if (detectors.has(componentId) && steps.length > 0) {
      const routeIndex = found.length;
      found.push({
        id: `auto-route-${routeIndex + 1}`,
        label: inferredLabel(routeIndex, componentId),
        enabled: true,
        sourceBlockId: sourceId,
        detectorBlockId: componentId,
        steps: clone(steps),
      });
      return;
    }
    for (const edge of edgesByDeparture.get(componentId) ?? []) {
      if (usedConnections.has(edge.connection.id)) continue;
      const departurePort = canonicalPortId(componentId, edge.departure.portId, config);
      if (entryPortId && exactGroups.has(componentId)) {
        const canonicalEntry = canonicalPortId(componentId, entryPortId, config);
        const crossesGroup = (canonicalEntry === 'front' && departurePort === 'back')
          || (canonicalEntry === 'back' && departurePort === 'front');
        if (!crossesGroup) continue;
      }
      const arrivalPort = canonicalPortId(edge.arrival.blockId, edge.arrival.portId, config);
      const portKey = `${edge.arrival.blockId}:${arrivalPort}`;
      if (visitedPorts.has(portKey) || visitedComponents.has(edge.arrival.blockId)) continue;
      const nextUsed = new Set(usedConnections);
      nextUsed.add(edge.connection.id);
      const nextVisited = new Set(visitedPorts);
      nextVisited.add(portKey);
      const nextComponents = new Set(visitedComponents);
      nextComponents.add(edge.arrival.blockId);
      visit(
        sourceId,
        edge.arrival.blockId,
        arrivalPort,
        [...steps, { connectionId: edge.connection.id, direction: edge.direction }],
        nextUsed,
        nextVisited,
        nextComponents,
      );
    }
  };
  for (const sourceId of sources) visit(sourceId, sourceId, null, [], new Set(), new Set([`${sourceId}:emit`]), new Set([sourceId]));
  return found;
}

function migratePathLabels(config: Configuration): PortRoute[] {
  const labels = new Map<string, DesignConnection[]>();
  for (const connection of config.designConnections ?? []) {
    const label = id(connection.pathLabel);
    if (!label) continue;
    const list = labels.get(label) ?? [];
    list.push(connection);
    labels.set(label, list);
  }
  const migrated: PortRoute[] = [];
  for (const [label, pendingInput] of labels) {
    const pending = [...pendingInput];
    const arrivals = new Set(pending.map((connection) => id(connection.to.blockId)));
    let current = pending.find((connection) => !arrivals.has(id(connection.from.blockId))) ?? pending[0];
    const steps: PortRouteStep[] = [];
    while (current) {
      steps.push({ connectionId: current.id, direction: 'forward' });
      pending.splice(pending.indexOf(current), 1);
      current = pending.find((candidate) => id(candidate.from.blockId) === id(current?.to.blockId)) as DesignConnection | undefined;
    }
    if (steps.length === pendingInput.length && steps.length > 0) {
      migrated.push({ id: `route-${label.replace(/[^a-zA-Z0-9_-]+/g, '-')}`, label, enabled: true, steps, migratedFromPathLabel: true });
    }
  }
  return migrated;
}

function createRouteSets(config: Configuration, routes: PortRoute[]): PortRouteSet[] {
  const resolved = routes.map((route) => resolvePortRoute(config, route)).filter((route) => route.valid);
  const detectorRoutes = new Map<string, string[]>();
  for (const entry of resolved) {
    const detectorId = id(entry.route.detectorBlockId) || id(entry.steps[entry.steps.length - 1]?.arrival.blockId);
    if (!detectorId) continue;
    const list = detectorRoutes.get(detectorId) ?? [];
    list.push(entry.route.id);
    detectorRoutes.set(detectorId, list);
  }
  return Array.from(detectorRoutes, ([detectorBlockId, routeIds], index) => ({
    id: `route-set-${index + 1}`,
    label: `Detector ${detectorBlockId}`,
    detectorBlockId,
    routeIds,
    measurementRouteId: routeIds[0],
    referenceRouteId: routeIds[1],
  }));
}

export function normalizePortRouteConfiguration(config: Configuration): NormalizedPortRouteConfiguration {
  const saved = Array.isArray(config.portRoutes) ? clone(config.portRoutes) : [];
  const migrated = saved.length === 0 ? migratePathLabels(config) : [];
  const discovered = saved.length === 0 && migrated.length === 0 ? discoverSimplePortRoutes(config) : [];
  const baseRoutes = saved.length > 0 ? saved : (migrated.length > 0 ? migrated : discovered);
  const routes = baseRoutes.map((route) => {
    const resolved = resolvePortRoute(config, route);
    const first = resolved.steps[0];
    const last = resolved.steps[resolved.steps.length - 1];
    return {
      ...route,
      // The ordered path is authoritative. Keeping duplicate endpoint IDs as
      // the source of truth made a renamed/replaced Source or Detector leave a
      // visually correct route in an unusable "missing endpoint" state.
      sourceBlockId: first?.departure.blockId || id(route.sourceBlockId) || undefined,
      detectorBlockId: last?.arrival.blockId || id(route.detectorBlockId) || undefined,
    };
  });
  const routeSets = Array.isArray(config.routeSets) && config.routeSets.length > 0
    ? clone(config.routeSets)
    : createRouteSets(config, routes);
  const resolvedRoutes = routes.map((route) => resolvePortRoute(config, route));
  return {
    routes,
    routeSets,
    resolvedRoutes,
    issues: resolvedRoutes.flatMap((route) => route.issues),
    generated: saved.length === 0,
  };
}
