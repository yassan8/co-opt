import { evaluateCoherentAssembly, type AxisAlignedBounds, type CoherentAssemblyDesign, type Vec3Mm } from './coherent-assembly.ts';
import { initializeCoherentPortConnections, worldPortPosition, type PortLayoutConnection } from './coherent-port-layout.ts';

export interface OpticalPathInterference {
  connectionId: string;
  pathId: string;
  componentId: string;
}

function segmentIntersectsBounds(start: Vec3Mm, end: Vec3Mm, bounds: AxisAlignedBounds): boolean {
  let minimum = 0;
  let maximum = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const direction = end[axis] - start[axis];
    if (Math.abs(direction) < 1e-12) {
      if (start[axis] < bounds.min[axis] || start[axis] > bounds.max[axis]) return false;
      continue;
    }
    let entry = (bounds.min[axis] - start[axis]) / direction;
    let exit = (bounds.max[axis] - start[axis]) / direction;
    if (entry > exit) [entry, exit] = [exit, entry];
    minimum = Math.max(minimum, entry);
    maximum = Math.min(maximum, exit);
    if (minimum > maximum) return false;
  }
  return maximum >= 0 && minimum <= 1;
}

/** Checks every port-to-port beam segment against non-endpoint mechanical envelopes. */
export function evaluateOpticalPathClearance(input: CoherentAssemblyDesign): OpticalPathInterference[] {
  const design = initializeCoherentPortConnections(input);
  const evaluation = evaluateCoherentAssembly(design);
  const byId = new Map(design.components.map((component) => [component.id, component]));
  const boundsById = new Map(evaluation.components.map((entry) => [entry.component.id, entry.mechanicalBounds]));
  const interferences: OpticalPathInterference[] = [];
  design.connections.forEach((connection) => {
    const from = byId.get(connection.fromComponentId);
    const to = byId.get(connection.toComponentId);
    if (!from || !to) return;
    const layout = connection as PortLayoutConnection;
    const start = worldPortPosition(from, String(layout.fromPortId ?? ''), 'from');
    const end = worldPortPosition(to, String(layout.toPortId ?? ''), 'to');
    evaluation.components.forEach((entry) => {
      const componentId = entry.component.id;
      if (componentId === connection.fromComponentId || componentId === connection.toComponentId) return;
      const bounds = boundsById.get(componentId);
      if (bounds && segmentIntersectsBounds(start, end, bounds)) {
        interferences.push({ connectionId: connection.id, pathId: connection.pathId, componentId });
      }
    });
  });
  return interferences;
}
