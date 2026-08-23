import {
  normalizeCoherentAssemblyDesign,
  resolveComponentTransform,
  type CoherentAssemblyDesign,
  type CoherentConnection,
  type CoherentPhysicalComponent,
  type EulerDeg,
  type OpticalPort,
  type Vec3Mm,
} from './coherent-assembly.ts';

export interface PortLayoutConnection extends CoherentConnection {
  fromPortId?: string;
  toPortId?: string;
  distanceMm?: number;
  azimuthDeg?: number;
  elevationDeg?: number;
}

export interface ConnectionLayoutParameters {
  fromPortId: string;
  toPortId: string;
  distanceMm: number;
  azimuthDeg: number;
  elevationDeg: number;
}

const finite = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

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

function rotate(point: Vec3Mm, rotation: EulerDeg): Vec3Mm {
  const matrix = rotationMatrix(rotation);
  return {
    x: matrix[0][0] * point.x + matrix[0][1] * point.y + matrix[0][2] * point.z,
    y: matrix[1][0] * point.x + matrix[1][1] * point.y + matrix[1][2] * point.z,
    z: matrix[2][0] * point.x + matrix[2][1] * point.y + matrix[2][2] * point.z,
  };
}

function inferPortId(component: CoherentPhysicalComponent, connection: CoherentConnection, side: 'from' | 'to'): string {
  if (component.kind === 'beam-splitter') {
    const pathPort = component.ports.find((port) => port.id === connection.pathId);
    if (pathPort) return pathPort.id;
    const common = component.ports.find((port) => port.id === 'common');
    if (common) return common.id;
  }
  const preferred = component.ports.find((port) => port.id === (side === 'from' ? 'out' : 'in'));
  return preferred?.id ?? component.ports[side === 'from' ? component.ports.length - 1 : 0]?.id ?? '';
}

function portById(component: CoherentPhysicalComponent, id: string, side: 'from' | 'to'): OpticalPort {
  return component.ports.find((port) => port.id === id)
    ?? component.ports.find((port) => port.id === (side === 'from' ? 'out' : 'in'))
    ?? component.ports[side === 'from' ? component.ports.length - 1 : 0]
    ?? { id: '', label: '', localPositionMm: { x: 0, y: 0, z: 0 }, localDirection: { x: 0, y: 0, z: side === 'from' ? 1 : -1 } };
}

export function worldPortPosition(component: CoherentPhysicalComponent, portId: string, side: 'from' | 'to'): Vec3Mm {
  const transform = resolveComponentTransform(component);
  const local = portById(component, portId, side).localPositionMm;
  const offset = rotate(local, transform.rotationDeg);
  return {
    x: transform.positionMm.x + offset.x,
    y: transform.positionMm.y + offset.y,
    z: transform.positionMm.z + offset.z,
  };
}

export function worldPortDirection(component: CoherentPhysicalComponent, portId: string, side: 'from' | 'to'): Vec3Mm {
  const transform = resolveComponentTransform(component);
  const direction = rotate(portById(component, portId, side).localDirection, transform.rotationDeg);
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  return { x: direction.x / length, y: direction.y / length, z: direction.z / length };
}

function vectorParameters(from: Vec3Mm, to: Vec3Mm) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const distanceMm = Math.hypot(dx, dy, dz);
  const horizontal = Math.hypot(dx, dz);
  return {
    distanceMm,
    azimuthDeg: Math.atan2(dz, dx) * 180 / Math.PI,
    elevationDeg: Math.atan2(dy, horizontal) * 180 / Math.PI,
  };
}

export function getConnectionLayoutParameters(design: CoherentAssemblyDesign, connection: CoherentConnection): ConnectionLayoutParameters | null {
  const byId = new Map(design.components.map((component) => [component.id, component]));
  const from = byId.get(connection.fromComponentId);
  const to = byId.get(connection.toComponentId);
  if (!from || !to) return null;
  const layout = connection as PortLayoutConnection;
  const fromPortId = layout.fromPortId || inferPortId(from, connection, 'from');
  const toPortId = layout.toPortId || inferPortId(to, connection, 'to');
  const inferred = vectorParameters(worldPortPosition(from, fromPortId, 'from'), worldPortPosition(to, toPortId, 'to'));
  const outgoing = worldPortDirection(from, fromPortId, 'from');
  const directed = vectorParameters({ x: 0, y: 0, z: 0 }, outgoing);
  return {
    fromPortId,
    toPortId,
    distanceMm: Math.max(0, finite(layout.distanceMm, inferred.distanceMm)),
    azimuthDeg: finite(layout.azimuthDeg, directed.azimuthDeg),
    elevationDeg: finite(layout.elevationDeg, directed.elevationDeg),
  };
}

/** Captures the current geometry as editable port-to-port connection metadata. */
export function initializeCoherentPortConnections(input: CoherentAssemblyDesign): CoherentAssemblyDesign {
  const design = normalizeCoherentAssemblyDesign(input);
  return {
    ...design,
    connections: design.connections.map((connection) => {
      const existing = connection as PortLayoutConnection;
      if (
        Number.isFinite(Number(existing.distanceMm))
        && Number.isFinite(Number(existing.azimuthDeg))
        && Number.isFinite(Number(existing.elevationDeg))
        && existing.fromPortId
        && existing.toPortId
      ) return connection;
      const parameters = getConnectionLayoutParameters(design, connection);
      return parameters ? { ...connection, ...parameters } : connection;
    }),
  };
}

/**
 * Repositions downstream auto transforms from stored port connections.
 * Manual offsets stay local to each component and are included before placing
 * the following component, so an upstream adjustment propagates downstream.
 */
export function reflowCoherentAssembly(input: CoherentAssemblyDesign): CoherentAssemblyDesign {
  const design = initializeCoherentPortConnections(input);
  const components = design.components.map((component) => ({
    ...component,
    autoTransform: {
      positionMm: { ...component.autoTransform.positionMm },
      rotationDeg: { ...component.autoTransform.rotationDeg },
    },
  }));
  const byId = new Map(components.map((component) => [component.id, component]));
  const connectionByPair = new Map(design.connections.map((connection) => [`${connection.pathId}:${connection.fromComponentId}:${connection.toComponentId}`, connection]));
  const orderedPaths = design.paths.slice().sort((a, b) => (a.id === 'common' ? -1 : b.id === 'common' ? 1 : 0));

  orderedPaths.forEach((path) => {
    for (let index = 1; index < path.componentIds.length; index += 1) {
      const fromId = path.componentIds[index - 1];
      const toId = path.componentIds[index];
      const connection = connectionByPair.get(`${path.id}:${fromId}:${toId}`);
      const from = byId.get(fromId);
      const to = byId.get(toId);
      if (!connection || !from || !to || connection.autoPlace === false) continue;
      const parameters = getConnectionLayoutParameters({ ...design, components }, connection);
      if (!parameters) continue;
      const azimuth = parameters.azimuthDeg * Math.PI / 180;
      const elevation = parameters.elevationDeg * Math.PI / 180;
      const horizontal = parameters.distanceMm * Math.cos(elevation);
      const fromPort = worldPortPosition(from, parameters.fromPortId, 'from');
      const desiredToPort = {
        x: fromPort.x + horizontal * Math.cos(azimuth),
        y: fromPort.y + parameters.distanceMm * Math.sin(elevation),
        z: fromPort.z + horizontal * Math.sin(azimuth),
      };
      const toTransform = resolveComponentTransform(to);
      const toLocalPort = portById(to, parameters.toPortId, 'to').localPositionMm;
      const rotatedToPort = rotate(toLocalPort, toTransform.rotationDeg);
      to.autoTransform.positionMm = {
        x: desiredToPort.x - rotatedToPort.x,
        y: desiredToPort.y - rotatedToPort.y,
        z: desiredToPort.z - rotatedToPort.z,
      };
    }
  });
  return { ...design, components };
}

export function patchConnectionLayout(
  design: CoherentAssemblyDesign,
  connectionId: string,
  patch: Partial<Pick<PortLayoutConnection, 'distanceMm' | 'azimuthDeg' | 'elevationDeg' | 'fromPortId' | 'toPortId'>>,
): CoherentAssemblyDesign {
  const initialized = initializeCoherentPortConnections(design);
  return reflowCoherentAssembly({
    ...initialized,
    connections: initialized.connections.map((connection) => connection.id === connectionId ? { ...connection, ...patch } : connection),
  });
}
