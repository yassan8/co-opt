import type { Block } from '../data/block-schema.ts';
import type {
  CoherentAssemblyDesign,
  CoherentBlockSequence,
  CoherentPhysicalComponent,
  ComponentTransform,
  DimensionConfidence,
  EulerDeg,
  Vec3Mm,
} from './coherent-assembly.ts';

export interface DesignIntentAssemblyResult {
  components: CoherentPhysicalComponent[];
  issues: string[];
  expandedSurfaceCount: number;
}

type Matrix3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];

const finite = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const identityOffset = (): ComponentTransform => ({
  positionMm: { x: 0, y: 0, z: 0 },
  rotationDeg: { x: 0, y: 0, z: 0 },
});

function eulerMatrix(rotation: EulerDeg): Matrix3 {
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

function matrix3(value: unknown): Matrix3 {
  const rows = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((row) => [0, 1, 2].map((column) => finite(rows[row]?.[column], row === column ? 1 : 0))) as Matrix3;
}

function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  return [0, 1, 2].map((row) => [0, 1, 2].map((column) => (
    a[row][0] * b[0][column] + a[row][1] * b[1][column] + a[row][2] * b[2][column]
  ))) as Matrix3;
}

function apply(matrix: Matrix3, point: Vec3Mm): Vec3Mm {
  return {
    x: matrix[0][0] * point.x + matrix[0][1] * point.y + matrix[0][2] * point.z,
    y: matrix[1][0] * point.x + matrix[1][1] * point.y + matrix[1][2] * point.z,
    z: matrix[2][0] * point.x + matrix[2][1] * point.y + matrix[2][2] * point.z,
  };
}

function matrixToEuler(matrix: Matrix3): EulerDeg {
  const y = Math.asin(Math.max(-1, Math.min(1, -matrix[2][0])));
  const cy = Math.cos(y);
  let x: number;
  let z: number;
  if (Math.abs(cy) > 1e-8) {
    x = Math.atan2(matrix[2][1], matrix[2][2]);
    z = Math.atan2(matrix[1][0], matrix[0][0]);
  } else {
    x = 0;
    z = Math.atan2(-matrix[0][1], matrix[1][1]);
  }
  const degrees = 180 / Math.PI;
  return { x: x * degrees, y: y * degrees, z: z * degrees };
}

function worldTransform(root: ComponentTransform, localPosition: Vec3Mm, localRotation: unknown): ComponentTransform {
  const rootMatrix = eulerMatrix(root.rotationDeg);
  const offset = apply(rootMatrix, localPosition);
  return {
    positionMm: {
      x: finite(root.positionMm.x) + offset.x,
      y: finite(root.positionMm.y) + offset.y,
      z: finite(root.positionMm.z) + offset.z,
    },
    rotationDeg: matrixToEuler(multiply(rootMatrix, matrix3(localRotation))),
  };
}

function midpoint(a: Vec3Mm, b: Vec3Mm): Vec3Mm {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function distance(a: Vec3Mm, b: Vec3Mm): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function semidiameter(row: any): number | null {
  const candidates = [row?.__cooptExplicitApertureSemidia, row?.semidia, row?.semiDiameter, row?.['Semi Diameter']];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function componentLabel(block: Block | undefined, type: string, elementIndex?: number): string {
  const base = String(block?.metadata?.label ?? block?.parameters?.label ?? block?.role ?? type).trim() || type;
  return elementIndex === undefined ? base : `${base} L${elementIndex + 1}`;
}

function ports(depthMm: number) {
  const half = depthMm / 2;
  return [
    { id: 'in', label: 'Input', localPositionMm: { x: 0, y: 0, z: -half }, localDirection: { x: 0, y: 0, z: -1 } },
    { id: 'out', label: 'Output', localPositionMm: { x: 0, y: 0, z: half }, localDirection: { x: 0, y: 0, z: 1 } },
  ];
}

function confidenceFor(aperture: number | null, depth: number, forcedMissing = false): DimensionConfidence {
  if (forcedMissing || aperture === null || !(depth > 0)) return 'Missing';
  // Aperture and glass thickness describe the optical solid. Its mount remains
  // an estimate until catalogue/measured dimensions replace the global margin.
  return 'Estimated';
}

/**
 * Expands one named Design Intent sequence into physical optical solids.
 * Lens/Doublet/Triplet intervals become individual lens components; coordinate
 * breaks only affect their resulting world transforms and never become solids.
 */
export async function deriveDesignIntentPhysicalComponents(sequence: CoherentBlockSequence): Promise<DesignIntentAssemblyResult> {
  if (!Array.isArray(sequence.blocks) || sequence.blocks.length === 0) {
    return { components: [], issues: [], expandedSurfaceCount: 0 };
  }
  const [{ expandBlocksToOpticalSystemRows }, { calculateSurfaceOrigins }] = await Promise.all([
    import('../data/block-schema.ts'),
    import('../raytracing/core/ray-tracing.ts'),
  ]);
  const expansion = expandBlocksToOpticalSystemRows(sequence.blocks as Block[]);
  const issues = expansion.issues.map((issue) => `${issue.severity}: ${issue.message}`);
  if (expansion.issues.some((issue) => issue.severity === 'fatal')) {
    throw new Error(`Design Intent expansion failed: ${issues.join(' | ')}`);
  }
  const rows = expansion.rows;
  const origins = calculateSurfaceOrigins(rows);
  const blockById = new Map((sequence.blocks as Block[]).map((block) => [String(block.blockId ?? ''), block]));
  const grouped = new Map<string, number[]>();
  rows.forEach((row: any, index: number) => {
    const blockId = String(row?._blockId ?? '').trim();
    if (!blockId) return;
    const indices = grouped.get(blockId) ?? [];
    indices.push(index);
    grouped.set(blockId, indices);
  });

  const components: CoherentPhysicalComponent[] = [];
  const lensTypes = new Set(['Lens', 'PositiveLens', 'Paraxial', 'Doublet', 'Triplet']);
  const skippedTypes = new Set(['Object', 'Image', 'Gap', 'CoordTrans', 'CoordinateTransform', 'AirGap', 'ImageSurface', 'ObjectSurface', 'ObjectPlane']);

  for (const [blockId, indices] of grouped) {
    const firstRow = rows[indices[0]] as any;
    const type = String(firstRow?._blockType ?? blockById.get(blockId)?.blockType ?? '').trim();
    if (!type || skippedTypes.has(type)) continue;
    const block = blockById.get(blockId);

    if (lensTypes.has(type)) {
      const intervalCount = Math.max(1, indices.length - 1);
      for (let elementIndex = 0; elementIndex < intervalCount; elementIndex += 1) {
        const frontIndex = indices[Math.min(elementIndex, indices.length - 1)];
        const backIndex = indices[Math.min(elementIndex + 1, indices.length - 1)];
        const front = rows[frontIndex] as any;
        const back = rows[backIndex] as any;
        const frontOrigin = origins[frontIndex]?.origin as Vec3Mm;
        const backOrigin = origins[backIndex]?.origin as Vec3Mm;
        if (!frontOrigin || !backOrigin) continue;
        const physicalDepth = distance(frontOrigin, backOrigin);
        const thin = type === 'Paraxial' || !(physicalDepth > 1e-9);
        const depthMm = thin ? 1 : physicalDepth;
        const aperture = Math.max(semidiameter(front) ?? 0, semidiameter(back) ?? 0) || null;
        const diameter = aperture === null ? 10 : aperture * 2;
        const localCenter = thin ? frontOrigin : midpoint(frontOrigin, backOrigin);
        components.push({
          id: `intent:${sequence.id}:${blockId}:${elementIndex}`,
          label: componentLabel(block, type, intervalCount > 1 ? elementIndex : undefined),
          kind: 'lens',
          shape: 'lens',
          autoTransform: worldTransform(sequence.rootTransform, localCenter, origins[frontIndex]?.rotationMatrix),
          manualOffset: identityOffset(),
          dimensions: {
            widthMm: diameter,
            heightMm: diameter,
            depthMm,
            apertureDiameterMm: aperture === null ? undefined : aperture * 2,
            frontRadiusMm: Number.isFinite(Number(front?.radius)) ? Number(front.radius) : null,
            backRadiusMm: Number.isFinite(Number(back?.radius)) ? Number(back.radius) : null,
            centerThicknessMm: depthMm,
          },
          dimensionConfidence: confidenceFor(aperture, depthMm),
          powerEfficiency: 0.99,
          pathIds: [sequence.pathId],
          ports: ports(depthMm),
          metadata: { source: 'design-intent', sequenceId: sequence.id, blockId, blockType: type, elementIndex },
        });
      }
      continue;
    }

    const index = indices[0];
    const row = rows[index] as any;
    const origin = origins[index]?.origin as Vec3Mm;
    if (!origin) continue;
    const aperture = semidiameter(row);
    const diameter = aperture === null ? 10 : aperture * 2;
    const isMirror = type === 'Mirror';
    const isStop = type === 'Stop';
    const depthMm = isMirror ? 3 : 1;
    components.push({
      id: `intent:${sequence.id}:${blockId}:0`,
      label: componentLabel(block, type),
      kind: isMirror ? 'mirror' : isStop ? 'stop' : 'lens',
      shape: isMirror ? 'cylinder' : isStop ? 'box' : 'lens',
      autoTransform: worldTransform(sequence.rootTransform, origin, origins[index]?.rotationMatrix),
      manualOffset: identityOffset(),
      dimensions: {
        widthMm: diameter,
        heightMm: diameter,
        depthMm,
        apertureDiameterMm: aperture === null ? undefined : aperture * 2,
        frontRadiusMm: Number.isFinite(Number(row?.radius)) ? Number(row.radius) : null,
        backRadiusMm: null,
        centerThicknessMm: depthMm,
      },
      dimensionConfidence: confidenceFor(aperture, depthMm, !isMirror && !isStop),
      powerEfficiency: isMirror ? 0.98 : 1,
      pathIds: [sequence.pathId],
      ports: ports(depthMm),
      metadata: { source: 'design-intent', sequenceId: sequence.id, blockId, blockType: type },
    });
  }
  return { components, issues, expandedSurfaceCount: rows.length };
}

export function replaceDesignIntentSequenceComponents(
  design: CoherentAssemblyDesign,
  sequenceId: string,
  generated: CoherentPhysicalComponent[],
): CoherentAssemblyDesign {
  const retained = design.components.filter((component) => !(
    component.metadata?.source === 'design-intent'
    && component.metadata?.sequenceId === sequenceId
  ));
  return { ...design, components: [...retained, ...generated] };
}
