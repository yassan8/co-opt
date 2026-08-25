import {
  type CoherentAssemblyDesign,
  type CoherentConnection,
  type CoherentPhysicalComponent,
  type OpticalPort,
  type Vec3Mm,
} from './coherent-assembly.ts';
import { getConnectionLayoutParameters, worldPortPosition } from './coherent-port-layout.ts';

export type ConnectionOverlayTone = 'default' | 'transmit' | 'reflect' | 'detector';

export interface RenderConnectionOverlay {
  id: string;
  pathId: string;
  fromComponentId: string;
  toComponentId: string;
  fromComponentLabel: string;
  toComponentLabel: string;
  fromPortId: string;
  toPortId: string;
  fromPortLabel: string;
  toPortLabel: string;
  startMm: Vec3Mm;
  endMm: Vec3Mm;
  distanceMm: number;
  tone: ConnectionOverlayTone;
  reachesDetector: boolean;
}

export interface RenderPortOverlay {
  id: string;
  componentId: string;
  componentLabel: string;
  portId: string;
  label: string;
  positionMm: Vec3Mm;
  connected: boolean;
}

export interface CoherentRenderConnectionOverlay {
  connections: RenderConnectionOverlay[];
  ports: RenderPortOverlay[];
}

const shortPortLabel = (component: CoherentPhysicalComponent, port: OpticalPort): string => {
  if (component.kind === 'detector' || component.kind === 'time-detector') return 'DET';
  if (component.kind === 'source') return 'OUT';
  const id = String(port.id ?? '').toLowerCase();
  if (id === 'emit' || id === 'out' || id === 'specular') return 'OUT';
  if (id === 'in' || id === 'common' || id === 'incident') return 'IN';
  if (id === 'transmit') return 'T';
  if (id === 'reflect') return 'R';
  if (id === 'recombine') return 'RC';
  if (id === 'detect') return 'DET';
  if (id === 'scatter') return 'SCT';
  if (id.startsWith('order')) return id.slice('order'.length).replace('+', '+') || '0';
  return String(port.label || port.id || 'PORT').slice(0, 5).toUpperCase();
};

const connectionKey = (componentId: string, portId: string): string => `${componentId}:${portId}`;

function inferPort(
  design: CoherentAssemblyDesign,
  component: CoherentPhysicalComponent,
  connection: CoherentConnection,
  side: 'from' | 'to',
): OpticalPort | null {
  const layout = getConnectionLayoutParameters(design, connection);
  const id = side === 'from' ? layout?.fromPortId : layout?.toPortId;
  return component.ports.find((port) => port.id === id)
    ?? component.ports.find((port) => port.id === (side === 'from' ? 'out' : 'in'))
    ?? component.ports[side === 'from' ? Math.max(0, component.ports.length - 1) : 0]
    ?? null;
}

function detectorReachability(design: CoherentAssemblyDesign): Set<string> {
  const detectorIds = new Set(
    design.components
      .filter((component) => component.kind === 'detector' || component.kind === 'time-detector')
      .map((component) => component.id),
  );
  const incoming = new Map<string, CoherentConnection[]>();
  design.connections.forEach((connection) => {
    const list = incoming.get(connection.toComponentId) ?? [];
    list.push(connection);
    incoming.set(connection.toComponentId, list);
  });
  const reaches = new Set<string>();
  const pending = [...detectorIds];
  const visitedComponents = new Set(pending);
  while (pending.length > 0) {
    const componentId = pending.shift()!;
    for (const connection of incoming.get(componentId) ?? []) {
      reaches.add(connection.id);
      if (!visitedComponents.has(connection.fromComponentId)) {
        visitedComponents.add(connection.fromComponentId);
        pending.push(connection.fromComponentId);
      }
    }
  }
  return reaches;
}

function connectionTone(connection: CoherentConnection, reachesDetector: boolean): ConnectionOverlayTone {
  const port = String(connection.fromPortId ?? '').toLowerCase();
  if (port === 'transmit') return 'transmit';
  if (port === 'reflect') return 'reflect';
  return reachesDetector ? 'detector' : 'default';
}

export function buildCoherentRenderConnectionOverlay(input: CoherentAssemblyDesign): CoherentRenderConnectionOverlay {
  const byId = new Map(input.components.map((component) => [component.id, component]));
  const connectedPorts = new Set<string>();
  const reachesDetector = detectorReachability(input);
  const connections: RenderConnectionOverlay[] = [];

  for (const connection of input.connections) {
    const from = byId.get(connection.fromComponentId);
    const to = byId.get(connection.toComponentId);
    if (!from || !to) continue;
    const layout = getConnectionLayoutParameters(input, connection);
    const fromPort = inferPort(input, from, connection, 'from');
    const toPort = inferPort(input, to, connection, 'to');
    if (!layout || !fromPort || !toPort) continue;
    const startMm = worldPortPosition(from, layout.fromPortId, 'from');
    const endMm = worldPortPosition(to, layout.toPortId, 'to');
    const geometricDistance = Math.hypot(endMm.x - startMm.x, endMm.y - startMm.y, endMm.z - startMm.z);
    connectedPorts.add(connectionKey(from.id, fromPort.id));
    connectedPorts.add(connectionKey(to.id, toPort.id));
    const detectorPath = reachesDetector.has(connection.id);
    connections.push({
      id: connection.id,
      pathId: connection.pathId || 'main',
      fromComponentId: from.id,
      toComponentId: to.id,
      fromComponentLabel: from.label,
      toComponentLabel: to.label,
      fromPortId: fromPort.id,
      toPortId: toPort.id,
      fromPortLabel: shortPortLabel(from, fromPort),
      toPortLabel: shortPortLabel(to, toPort),
      startMm,
      endMm,
      distanceMm: geometricDistance,
      tone: connectionTone(connection, detectorPath),
      reachesDetector: detectorPath,
    });
  }

  const ports = input.components.flatMap((component) => component.ports.map((port): RenderPortOverlay => ({
    id: connectionKey(component.id, port.id),
    componentId: component.id,
    componentLabel: component.label,
    portId: port.id,
    label: shortPortLabel(component, port),
    positionMm: worldPortPosition(component, port.id, port.localDirection.z >= 0 ? 'from' : 'to'),
    connected: connectedPorts.has(connectionKey(component.id, port.id)),
  })));

  return { connections, ports };
}
