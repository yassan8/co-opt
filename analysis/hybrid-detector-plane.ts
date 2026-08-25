import type { CoherentAssemblyDesign, Vec3Mm } from './coherent-assembly.ts';
import { worldPortDirection, worldPortPosition } from './coherent-port-layout.ts';

export interface HybridDetectorPlaneOffset {
  defocusMm: number;
  lateralOffsetMm: number;
  supported: boolean;
  sequentialComponentId?: string;
  sequenceId?: string;
}

const subtract = (left: Vec3Mm, right: Vec3Mm): Vec3Mm => ({
  x: left.x - right.x,
  y: left.y - right.y,
  z: left.z - right.z,
});

const dot = (left: Vec3Mm, right: Vec3Mm): number => (
  left.x * right.x + left.y * right.y + left.z * right.z
);

/** Returns exact sequential groups upstream of one detector, nearest first. */
export function getHybridDetectorSequentialGroups(
  design: CoherentAssemblyDesign,
  detectorComponentId: string,
): CoherentAssemblyDesign['components'] {
  const byId = new Map(design.components.map((component) => [component.id, component]));
  const incoming = new Map<string, string[]>();
  for (const connection of design.connections) {
    const values = incoming.get(connection.toComponentId) ?? [];
    if (!values.includes(connection.fromComponentId)) values.push(connection.fromComponentId);
    incoming.set(connection.toComponentId, values);
  }
  const queue = [detectorComponentId];
  const visited = new Set<string>();
  const sequential: CoherentAssemblyDesign['components'] = [];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    for (const parentId of incoming.get(currentId) ?? []) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      if (parent.kind === 'sequential-group') sequential.push(parent);
      queue.push(parentId);
    }
  }
  return sequential;
}

/**
 * Returns the signed detector-plane displacement from the exact sequential
 * image surface. The exact PSF can use this as an image-space defocus only
 * when the detector is connected directly to the sequential group.
 */
export function getHybridDetectorPlaneOffset(
  design: CoherentAssemblyDesign,
  detectorComponentId: string,
): HybridDetectorPlaneOffset {
  const detector = design.components.find((component) => component.id === detectorComponentId);
  if (!detector) return { defocusMm: 0, lateralOffsetMm: 0, supported: false };

  const connection = design.connections.find((entry) => (
    entry.toComponentId === detector.id
    && design.components.some((component) => component.id === entry.fromComponentId && component.kind === 'sequential-group')
  ));
  const sequential = connection
    ? design.components.find((component) => component.id === connection.fromComponentId)
    : getHybridDetectorSequentialGroups(design, detectorComponentId)[0];
  if (!sequential) return { defocusMm: 0, lateralOffsetMm: 0, supported: false };
  const identity = {
    sequentialComponentId: sequential.id,
    sequenceId: String(sequential.metadata?.sequenceId ?? sequential.id.replace(/^sequential-group:/, 'sequential:')),
  };
  if (!connection) return { defocusMm: 0, lateralOffsetMm: 0, supported: false, ...identity };

  const sequentialPortId = connection.fromPortId || 'out';
  const detectorPortId = connection.toPortId || 'detect';
  const imagePlane = worldPortPosition(sequential, sequentialPortId, 'from');
  const detectorPlane = worldPortPosition(detector, detectorPortId, 'to');
  const imageAxis = worldPortDirection(sequential, sequentialPortId, 'from');
  const separation = subtract(detectorPlane, imagePlane);
  const defocusMm = dot(separation, imageAxis);
  const separationLengthSquared = dot(separation, separation);
  const lateralOffsetMm = Math.sqrt(Math.max(0, separationLengthSquared - defocusMm * defocusMm));
  return {
    defocusMm: Math.abs(defocusMm) < 1e-12 ? 0 : defocusMm,
    lateralOffsetMm: Math.abs(lateralOffsetMm) < 1e-12 ? 0 : lateralOffsetMm,
    supported: true,
    ...identity,
  };
}
