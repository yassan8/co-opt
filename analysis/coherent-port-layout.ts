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

function normalized(vector: Vec3Mm): Vec3Mm {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function rotationAligning(fromInput: Vec3Mm, toInput: Vec3Mm): EulerDeg {
  const from = normalized(fromInput);
  const to = normalized(toInput);
  const crossVector = {
    x: from.y * to.z - from.z * to.y,
    y: from.z * to.x - from.x * to.z,
    z: from.x * to.y - from.y * to.x,
  };
  const cosine = Math.max(-1, Math.min(1, from.x * to.x + from.y * to.y + from.z * to.z));
  let axis = crossVector;
  let sine = Math.hypot(axis.x, axis.y, axis.z);
  if (sine < 1e-12 && cosine < 0) {
    const helper = Math.abs(from.x) < 0.8 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    axis = normalized({
      x: from.y * helper.z - from.z * helper.y,
      y: from.z * helper.x - from.x * helper.z,
      z: from.x * helper.y - from.y * helper.x,
    });
    sine = 0;
  } else if (sine >= 1e-12) {
    axis = { x: axis.x / sine, y: axis.y / sine, z: axis.z / sine };
  }
  const angle = cosine < -1 + 1e-12 ? Math.PI : Math.atan2(sine, cosine);
  const c = Math.cos(angle); const s = Math.sin(angle); const t = 1 - c;
  const { x, y, z } = axis;
  const matrix = cosine > 1 - 1e-12 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
  const ry = Math.asin(Math.max(-1, Math.min(1, -matrix[2][0])));
  const cy = Math.cos(ry);
  const rx = Math.abs(cy) > 1e-9 ? Math.atan2(matrix[2][1], matrix[2][2]) : 0;
  const rz = Math.abs(cy) > 1e-9 ? Math.atan2(matrix[1][0], matrix[0][0]) : Math.atan2(-matrix[0][1], matrix[1][1]);
  return { x: rx * 180 / Math.PI, y: ry * 180 / Math.PI, z: rz * 180 / Math.PI };
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
  const incomingCount = new Map<string, number>();
  for (const component of components) incomingCount.set(component.id, 0);
  for (const connection of design.connections) {
    if (byId.has(connection.toComponentId)) incomingCount.set(connection.toComponentId, (incomingCount.get(connection.toComponentId) ?? 0) + 1);
  }
  const placed = new Set(components.filter((component) => (incomingCount.get(component.id) ?? 0) === 0).map((component) => component.id));
  if (placed.size === 0) {
    const fallbackRoot = components.find((component) => component.kind === 'source') ?? components[0];
    if (fallbackRoot) placed.add(fallbackRoot.id);
  }
  const pending = design.connections.filter((connection) => connection.autoPlace !== false && byId.has(connection.fromComponentId) && byId.has(connection.toComponentId));
  const applyConnection = (connection: CoherentConnection) => {
    const from = byId.get(connection.fromComponentId);
    const to = byId.get(connection.toComponentId);
    if (!from || !to) return false;
    const parameters = getConnectionLayoutParameters({ ...design, components }, connection);
    if (!parameters) return false;
    const azimuth = parameters.azimuthDeg * Math.PI / 180;
    const elevation = parameters.elevationDeg * Math.PI / 180;
    const horizontal = parameters.distanceMm * Math.cos(elevation);
    const fromPort = worldPortPosition(from, parameters.fromPortId, 'from');
    const desiredToPort = {
      x: fromPort.x + horizontal * Math.cos(azimuth),
      y: fromPort.y + parameters.distanceMm * Math.sin(elevation),
      z: fromPort.z + horizontal * Math.sin(azimuth),
    };
    const connectionDirection = {
      x: Math.cos(elevation) * Math.cos(azimuth),
      y: Math.sin(elevation),
      z: Math.cos(elevation) * Math.sin(azimuth),
    };
    const toPortDefinition = portById(to, parameters.toPortId, 'to');
    const alignedRotation = rotationAligning(toPortDefinition.localDirection, {
      x: -connectionDirection.x,
      y: -connectionDirection.y,
      z: -connectionDirection.z,
    });
    to.autoTransform.rotationDeg = {
      x: alignedRotation.x - finite(to.manualOffset.rotationDeg?.x),
      y: alignedRotation.y - finite(to.manualOffset.rotationDeg?.y),
      z: alignedRotation.z - finite(to.manualOffset.rotationDeg?.z),
    };
    const toTransform = resolveComponentTransform(to);
    const toLocalPort = toPortDefinition.localPositionMm;
    const rotatedToPort = rotate(toLocalPort, toTransform.rotationDeg);
    to.autoTransform.positionMm = {
      x: desiredToPort.x - rotatedToPort.x,
      y: desiredToPort.y - rotatedToPort.y,
      z: desiredToPort.z - rotatedToPort.z,
    };
    return true;
  };

  // Place the directed graph, not legacy pathLabel chains. Branches therefore
  // follow their own ports, while a recombination component is positioned by
  // its first incoming auto-placement edge and subsequent edges remain physical
  // closure constraints. Cyclic/round-trip edges never move an already placed
  // component.
  let progress = true;
  while (progress) {
    progress = false;
    for (const connection of pending) {
      if (!placed.has(connection.fromComponentId) || placed.has(connection.toComponentId)) continue;
      if (!applyConnection(connection)) continue;
      placed.add(connection.toComponentId);
      progress = true;
    }
  }
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
