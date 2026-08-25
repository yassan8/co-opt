import { preloadRustRayTracingWasm } from '../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';
import type { CoherentBlockSequence, ComponentTransform, Vec3Mm } from './coherent-assembly.ts';
import { expandSequentialGroupRows } from './sequential-group-rows.ts';

export type SequentialGroupEntryPort = 'Front' | 'Back';

export interface SequentialGroupRayState {
  positionMm: Vec3Mm;
  direction: Vec3Mm;
  wavelengthNm: number;
  refractiveIndex?: number;
  opticalPathLengthMm?: number;
  amplitudeRe?: number;
  amplitudeIm?: number;
  coherenceGroupId?: string;
  history?: string[];
}

export interface SequentialGroupRenderSegment {
  fromMm: Vec3Mm;
  toMm: Vec3Mm;
  groupId: string;
  entryPort: SequentialGroupEntryPort;
}

export interface SequentialGroupTraceResult {
  ok: boolean;
  exitPort: SequentialGroupEntryPort;
  rayState: SequentialGroupRayState;
  oplMm: number;
  blocked: boolean;
  tir: boolean;
  failureReason?: string;
  segments: SequentialGroupRenderSegment[];
}

interface PreparedSequentialGroupTrace {
  rowsJson: string;
  rowCount: number;
  transform: ComponentTransform;
  groupId: string;
}

interface CachedSequentialGeometry {
  rowsJson: string;
  rowCount: number;
}

const sequentialGeometryCache = new Map<string, CachedSequentialGeometry>();
const MAX_SEQUENTIAL_GEOMETRY_CACHE = 48;

function rotationMatrix(transform: ComponentTransform): number[][] {
  const rx = Number(transform?.rotationDeg?.x ?? 0) * Math.PI / 180;
  const ry = Number(transform?.rotationDeg?.y ?? 0) * Math.PI / 180;
  const rz = Number(transform?.rotationDeg?.z ?? 0) * Math.PI / 180;
  const cx = Math.cos(rx); const sx = Math.sin(rx);
  const cy = Math.cos(ry); const sy = Math.sin(ry);
  const cz = Math.cos(rz); const sz = Math.sin(rz);
  return [
    [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
    [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
    [-sy, cy * sx, cy * cx],
  ];
}

function multiply(matrix: number[][], vector: Vec3Mm): Vec3Mm {
  return {
    x: matrix[0][0] * vector.x + matrix[0][1] * vector.y + matrix[0][2] * vector.z,
    y: matrix[1][0] * vector.x + matrix[1][1] * vector.y + matrix[1][2] * vector.z,
    z: matrix[2][0] * vector.x + matrix[2][1] * vector.y + matrix[2][2] * vector.z,
  };
}

function transpose(matrix: number[][]): number[][] {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function normalize(vector: Vec3Mm): Vec3Mm {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function toLocalRay(ray: SequentialGroupRayState, transform: ComponentTransform): Float64Array {
  const matrix = rotationMatrix(transform);
  const inverse = transpose(matrix);
  const relative = {
    x: ray.positionMm.x - Number(transform.positionMm?.x ?? 0),
    y: ray.positionMm.y - Number(transform.positionMm?.y ?? 0),
    z: ray.positionMm.z - Number(transform.positionMm?.z ?? 0),
  };
  const position = multiply(inverse, relative);
  const direction = normalize(multiply(inverse, ray.direction));
  return new Float64Array([position.x, position.y, position.z, direction.x, direction.y, direction.z]);
}

function toWorldPoint(point: Vec3Mm, transform: ComponentTransform): Vec3Mm {
  const rotated = multiply(rotationMatrix(transform), point);
  return {
    x: rotated.x + Number(transform.positionMm?.x ?? 0),
    y: rotated.y + Number(transform.positionMm?.y ?? 0),
    z: rotated.z + Number(transform.positionMm?.z ?? 0),
  };
}

function toWorldDirection(direction: Vec3Mm, transform: ComponentTransform): Vec3Mm {
  return normalize(multiply(rotationMatrix(transform), direction));
}

function statusReason(status: number): string {
  if (status === 3) return 'No forward intersection in the selected traversal direction.';
  if (status === 4) return 'Ray was blocked by an exact surface aperture.';
  if (status === 5) return 'Total internal reflection stopped the exact sequential traversal.';
  if (status === 6) return 'The requested exit port was not reached.';
  return 'Invalid Exact Sequential Group input.';
}

function prepareSequentialGroup(group: CoherentBlockSequence): PreparedSequentialGroupTrace | null {
  const blocks = Array.isArray(group.blocks) ? group.blocks as any[] : [];
  const geometryKey = JSON.stringify(blocks);
  let geometry = sequentialGeometryCache.get(geometryKey);
  if (!geometry) {
    const rows = expandSequentialGroupRows(blocks);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    geometry = { rowsJson: JSON.stringify(rows), rowCount: rows.length };
    sequentialGeometryCache.set(geometryKey, geometry);
    if (sequentialGeometryCache.size > MAX_SEQUENTIAL_GEOMETRY_CACHE) {
      sequentialGeometryCache.delete(sequentialGeometryCache.keys().next().value as string);
    }
  }
  return {
    rowsJson: geometry.rowsJson,
    rowCount: geometry.rowCount,
    transform: group.rootTransform ?? { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 } },
    groupId: group.id,
  };
}

function failedResult(
  groupId: string,
  entryPort: SequentialGroupEntryPort,
  rayState: SequentialGroupRayState,
  reason: string,
  status = 2,
): SequentialGroupTraceResult {
  const exitPort: SequentialGroupEntryPort = entryPort === 'Front' ? 'Back' : 'Front';
  return {
    ok: false,
    exitPort,
    rayState: { ...rayState, history: [...(rayState.history ?? []), `${groupId}:${entryPort}:failed`] },
    oplMm: 0,
    blocked: status === 4,
    tir: status === 5,
    failureReason: reason,
    segments: [],
  };
}

/**
 * Batch form used by the Port router. Rays are grouped by wavelength and
 * incident medium because those values are shared by one packed Rust call.
 * This avoids one WASM boundary crossing and one surface-pack operation per
 * ray during Detector and optimization evaluation.
 */
export async function traceSequentialGroupBatch(
  group: CoherentBlockSequence,
  entryPort: SequentialGroupEntryPort,
  rayStates: SequentialGroupRayState[],
  options: { includeSegments?: boolean } = {},
): Promise<SequentialGroupTraceResult[]> {
  if (rayStates.length === 0) return [];
  const prepared = prepareSequentialGroup(group);
  if (!prepared) {
    return rayStates.map((ray) => failedResult(group.id, entryPort, ray, 'Exact Sequential Group has no expandable surfaces.'));
  }
  const wasm = await preloadRustRayTracingWasm();
  const trace = wasm?.trace_sequential_group_with_rows_json;
  const tracePath = options.includeSegments ? wasm?.trace_sequential_group_path_with_rows_json : undefined;
  if (typeof trace !== 'function') {
    return rayStates.map((ray) => failedResult(group.id, entryPort, ray, 'Port-routed Exact tracing requires the current Rust/WASM optics kernel.'));
  }

  const output = new Array<SequentialGroupTraceResult>(rayStates.length);
  const batches = new Map<string, number[]>();
  rayStates.forEach((ray, index) => {
    const wavelengthNm = Number(ray.wavelengthNm);
    const refractiveIndex = Number(ray.refractiveIndex ?? 1);
    const key = `${wavelengthNm.toPrecision(15)}:${refractiveIndex.toPrecision(15)}`;
    const indices = batches.get(key) ?? [];
    indices.push(index);
    batches.set(key, indices);
  });

  for (const indices of batches.values()) {
    const first = rayStates[indices[0]];
    const packedRays = new Float64Array(indices.length * 6);
    indices.forEach((sourceIndex, batchIndex) => {
      packedRays.set(toLocalRay(rayStates[sourceIndex], prepared.transform), batchIndex * 6);
    });
    let raw: Float64Array | number[];
    let rawPath: Float64Array | number[] | null = null;
    try {
      raw = trace(
        prepared.rowsJson,
        packedRays,
        indices.length,
        Number(first.wavelengthNm) / 1000,
        Number(first.refractiveIndex ?? 1),
        entryPort === 'Back' ? 'back' : 'front',
        1,
      );
      if (typeof tracePath === 'function') {
        rawPath = tracePath(
          prepared.rowsJson,
          packedRays,
          indices.length,
          Number(first.wavelengthNm) / 1000,
          Number(first.refractiveIndex ?? 1),
          entryPort === 'Back' ? 'back' : 'front',
          1,
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      for (const sourceIndex of indices) output[sourceIndex] = failedResult(group.id, entryPort, rayStates[sourceIndex], reason);
      continue;
    }
    const values = Array.from(raw as ArrayLike<number>);
    const pathValues = rawPath ? Array.from(rawPath as ArrayLike<number>) : null;
    indices.forEach((sourceIndex, batchIndex) => {
      const rayState = rayStates[sourceIndex];
      const base = batchIndex * 8;
      const status = Number(values[base]);
      if (status !== 1) {
        output[sourceIndex] = failedResult(group.id, entryPort, rayState, statusReason(status), status);
        return;
      }
      const localPosition = { x: Number(values[base + 2]), y: Number(values[base + 3]), z: Number(values[base + 4]) };
      const localDirection = { x: Number(values[base + 5]), y: Number(values[base + 6]), z: Number(values[base + 7]) };
      const worldPosition = toWorldPoint(localPosition, prepared.transform);
      const worldDirection = toWorldDirection(localDirection, prepared.transform);
      const oplMm = Number(values[base + 1]) / 1000;
      const exitPort: SequentialGroupEntryPort = entryPort === 'Front' ? 'Back' : 'Front';
      const pathSegments: SequentialGroupRenderSegment[] = [];
      if (pathValues) {
        let previous = { ...rayState.positionMm };
        for (let step = 0; step < prepared.rowCount; step += 1) {
          const pathBase = (batchIndex * prepared.rowCount + step) * 8;
          if (Number(pathValues[pathBase]) !== 1) break;
          const point = toWorldPoint({
            x: Number(pathValues[pathBase + 2]),
            y: Number(pathValues[pathBase + 3]),
            z: Number(pathValues[pathBase + 4]),
          }, prepared.transform);
          if (Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z) > 1e-10) {
            pathSegments.push({ fromMm: previous, toMm: point, groupId: group.id, entryPort });
          }
          previous = point;
        }
      }
      output[sourceIndex] = {
        ok: true,
        exitPort,
        rayState: {
          ...rayState,
          positionMm: worldPosition,
          direction: worldDirection,
          opticalPathLengthMm: Number(rayState.opticalPathLengthMm ?? 0) + oplMm,
          history: [...(rayState.history ?? []), `${group.id}:${entryPort}->${exitPort}`],
        },
        oplMm,
        blocked: false,
        tir: false,
        segments: pathSegments.length > 0
          ? pathSegments
          : [{ fromMm: { ...rayState.positionMm }, toMm: worldPosition, groupId: group.id, entryPort }],
      };
    });
  }
  return output;
}

/**
 * Trace one ray through a saved physical prescription from either port.
 * Back entry uses descending surface order and swaps media inside the Rust
 * kernel.  It never rewrites R, K or any asphere/Qcon/Toric coefficient.
 */
export async function traceSequentialGroup(
  group: CoherentBlockSequence,
  entryPort: SequentialGroupEntryPort,
  rayState: SequentialGroupRayState,
): Promise<SequentialGroupTraceResult> {
  const [result] = await traceSequentialGroupBatch(group, entryPort, [rayState], { includeSegments: true });
  return result;
}
