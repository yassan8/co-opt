import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type OpticalStlExport = {
  data: ArrayBuffer | ArrayBufferView | string;
  meshCount: number;
  solidCount: number;
  triangleCount: number;
  solidMeshes: Array<{ positions: number[]; label: string }>;
};

export type OpticalSolidScene = {
  group: THREE.Group;
  solidCount: number;
  triangleCount: number;
};

export type OpticalSolidDisplayOptions = {
  /** Direction of the removed half around global +Z: 0=+X, 90=+Y. */
  sectionAngleDegrees?: number | null;
};

type SurfaceMeshData = {
  surfaceIndex0: number;
  geometry: THREE.BufferGeometry;
  positions: THREE.Vector3[];
  triangles: Array<[number, number, number]>;
  boundary: number[];
  rim: THREE.Vector3[];
  rimExtendsBoundary: boolean;
  center: THREE.Vector3;
  color: number;
};

function isEffectivelyVisible(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

function isExportableOpticalSurface(object: THREE.Object3D): object is THREE.Mesh {
  if (!(object as THREE.Mesh).isMesh || !isEffectivelyVisible(object)) return false;
  const userData = object.userData || {};
  return userData.isLensSurface === true || userData.type === 'lensSurface';
}

function readSurfaceIndex(object: THREE.Object3D): number | null {
  const value = Number(object.userData?.surfaceIndex0);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function loopPerimeter(loop: THREE.Vector3[]): number {
  return loop.reduce((sum, point, index) => sum + point.distanceTo(loop[(index + 1) % loop.length]), 0);
}

function cleanClosedLoop(points: THREE.Vector3[]): THREE.Vector3[] {
  const output: THREE.Vector3[] = [];
  points.forEach((point) => {
    if (output.length === 0 || output[output.length - 1].distanceToSquared(point) > 1e-12) output.push(point);
  });
  if (output.length > 2 && output[0].distanceToSquared(output[output.length - 1]) <= 1e-12) output.pop();
  return output;
}

function pointToSegmentDistanceSquared(point: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const edge = new THREE.Vector3().subVectors(b, a);
  const lengthSquared = edge.lengthSq();
  if (lengthSquared <= 1e-18) return point.distanceToSquared(a);
  const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(point, a).dot(edge) / lengthSquared, 0, 1);
  return point.distanceToSquared(edge.multiplyScalar(t).add(a));
}

function outlineAddsGeometry(boundary: THREE.Vector3[], outline: THREE.Vector3[]): boolean {
  if (boundary.length < 3 || outline.length < 3) return false;
  const scale = Math.max(1, loopPerimeter(boundary), loopPerimeter(outline));
  const toleranceSquared = Math.pow(scale * 1e-6, 2);
  return outline.some((point) => {
    let closest = Infinity;
    for (let i = 0; i < boundary.length; i += 1) {
      closest = Math.min(closest, pointToSegmentDistanceSquared(point, boundary[i], boundary[(i + 1) % boundary.length]));
    }
    return closest > toleranceSquared;
  });
}

function approximateLoopNormal(loop: THREE.Vector3[]): THREE.Vector3 {
  // Newell's method gives a stable approximate normal even when the rim follows
  // a curved optical sag rather than lying on a perfectly flat plane.
  const normal = new THREE.Vector3();
  for (let i = 0; i < loop.length; i += 1) {
    const current = loop[i];
    const next = loop[(i + 1) % loop.length];
    normal.x += (current.y - next.y) * (current.z + next.z);
    normal.y += (current.z - next.z) * (current.x + next.x);
    normal.z += (current.x - next.x) * (current.y + next.y);
  }
  return normal.lengthSq() < 1e-18 ? new THREE.Vector3(0, 0, 1) : normal.normalize();
}

function loopHasConcaveTurn(loop: THREE.Vector3[]): boolean {
  if (loop.length < 4) return false;
  const normal = approximateLoopNormal(loop);

  let basisU = new THREE.Vector3();
  for (let i = 0; i < loop.length && basisU.lengthSq() < 1e-18; i += 1) {
    basisU.subVectors(loop[(i + 1) % loop.length], loop[i]);
    basisU.addScaledVector(normal, -basisU.dot(normal));
  }
  if (basisU.lengthSq() < 1e-18) return false;
  basisU.normalize();
  const basisV = new THREE.Vector3().crossVectors(normal, basisU).normalize();
  const projected = loop.map((point) => new THREE.Vector2(point.dot(basisU), point.dot(basisV)));
  const scale = Math.max(1, loopPerimeter(loop));
  const turnTolerance = scale * scale * 1e-10;
  let turnSign = 0;
  for (let i = 0; i < projected.length; i += 1) {
    const previous = projected[(i + projected.length - 1) % projected.length];
    const current = projected[i];
    const next = projected[(i + 1) % projected.length];
    const incomingX = current.x - previous.x;
    const incomingY = current.y - previous.y;
    const outgoingX = next.x - current.x;
    const outgoingY = next.y - current.y;
    const cross = incomingX * outgoingY - incomingY * outgoingX;
    if (Math.abs(cross) <= turnTolerance) continue;
    const sign = Math.sign(cross);
    if (turnSign !== 0 && sign !== turnSign) return true;
    turnSign = sign;
  }
  return false;
}

function collectSurfaceOutlines(scene: THREE.Object3D, opticalSystemRows: any[]): Map<number, THREE.Vector3[]> {
  const candidates = new Map<number, Array<{ type: string; points: THREE.Vector3[] }>>();
  scene.traverse((object) => {
    if (!isEffectivelyVisible(object)) return;
    const type = String(object.userData?.type || '');
    if (type !== 'semidiaRing' && type !== 'apertureRect') return;
    const surfaceIndex0 = readSurfaceIndex(object);
    const position = (object as THREE.LineLoop).geometry?.getAttribute?.('position');
    if (surfaceIndex0 === null || !position || position.count < 3) return;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < position.count; i += 1) {
      points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld));
    }
    const loop = cleanClosedLoop(points);
    if (loop.length >= 3) candidates.set(surfaceIndex0, [...(candidates.get(surfaceIndex0) || []), { type, points: loop }]);
  });

  const outlines = new Map<number, THREE.Vector3[]>();
  candidates.forEach((entries, surfaceIndex0) => {
    const shape = String(opticalSystemRows[surfaceIndex0]?._apertureShape
      ?? opticalSystemRows[surfaceIndex0]?.apertureShape
      ?? opticalSystemRows[surfaceIndex0]?.ApertureShape
      ?? '').toLowerCase();
    const preferredType = /square|rect/.test(shape) ? 'apertureRect' : 'semidiaRing';
    const preferred = entries.filter((entry) => entry.type === preferredType);
    const pool = preferred.length > 0 ? preferred : entries;
    pool.sort((a, b) => loopPerimeter(b.points) - loopPerimeter(a.points));
    if (pool[0]) outlines.set(surfaceIndex0, pool[0].points);
  });
  return outlines;
}

function prepareSurfaceMesh(object: THREE.Mesh, outline?: THREE.Vector3[]): SurfaceMeshData | null {
  const surfaceIndex0 = readSurfaceIndex(object);
  if (surfaceIndex0 === null) return null;

  const sourcePosition = object.geometry?.getAttribute?.('position');
  if (!sourcePosition || sourcePosition.count < 3) return null;

  // Keep position + topology only so mergeVertices can weld the duplicated
  // angular seam and centre vertices of the rendered radial grid.
  const bare = new THREE.BufferGeometry();
  const worldPositions = sourcePosition.clone();
  const point = new THREE.Vector3();
  for (let i = 0; i < worldPositions.count; i += 1) {
    point.fromBufferAttribute(worldPositions, i).applyMatrix4(object.matrixWorld);
    worldPositions.setXYZ(i, point.x, point.y, point.z);
  }
  bare.setAttribute('position', worldPositions);
  if (object.geometry.index) bare.setIndex(object.geometry.index.clone());

  const geometry = mergeVertices(bare, 1e-5);
  bare.dispose();
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  if (!position || !index) {
    geometry.dispose();
    return null;
  }

  const positions: THREE.Vector3[] = [];
  const center = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    const p = new THREE.Vector3().fromBufferAttribute(position, i);
    positions.push(p);
    center.add(p);
  }
  center.multiplyScalar(1 / Math.max(1, positions.length));

  const triangles: Array<[number, number, number]> = [];
  const edgeCounts = new Map<string, { a: number; b: number; count: number }>();
  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}:${hi}`;
    const existing = edgeCounts.get(key);
    if (existing) existing.count += 1;
    else edgeCounts.set(key, { a: lo, b: hi, count: 1 });
  };

  for (let i = 0; i + 2 < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    if (a === b || b === c || c === a) continue;
    triangles.push([a, b, c]);
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }

  const adjacency = new Map<number, number[]>();
  edgeCounts.forEach(({ a, b, count }) => {
    if (count !== 1) return;
    adjacency.set(a, [...(adjacency.get(a) || []), b]);
    adjacency.set(b, [...(adjacency.get(b) || []), a]);
  });

  const loops: number[][] = [];
  const unused = new Set<string>();
  adjacency.forEach((neighbors, a) => neighbors.forEach((b) => unused.add(`${Math.min(a, b)}:${Math.max(a, b)}`)));
  while (unused.size > 0) {
    const firstEdge = unused.values().next().value as string;
    const [start, second] = firstEdge.split(':').map(Number);
    const loop = [start];
    let previous = start;
    let current = second;
    unused.delete(firstEdge);
    let guard = 0;
    while (current !== start && guard <= adjacency.size + 1) {
      loop.push(current);
      const candidates = adjacency.get(current) || [];
      const next = candidates.find((candidate) => candidate !== previous && unused.has(`${Math.min(current, candidate)}:${Math.max(current, candidate)}`));
      if (next === undefined) break;
      unused.delete(`${Math.min(current, next)}:${Math.max(current, next)}`);
      previous = current;
      current = next;
      guard += 1;
    }
    if (current === start && loop.length >= 3) loops.push(loop);
  }

  const perimeter = (loop: number[]) => loop.reduce((sum, vertex, i) => (
    sum + positions[vertex].distanceTo(positions[loop[(i + 1) % loop.length]])
  ), 0);
  loops.sort((a, b) => perimeter(b) - perimeter(a));
  const boundary = loops[0] || [];
  if (triangles.length === 0 || boundary.length < 3) {
    geometry.dispose();
    return null;
  }

  const material = Array.isArray(object.material) ? object.material[0] : object.material;
  const color = Number((material as THREE.Material & { color?: THREE.Color })?.color?.getHex?.()) || 0x67c7ff;
  const meshBoundary = boundary.map((index) => positions[index]);
  const cleanedOutline = cleanClosedLoop(Array.isArray(outline) ? outline : []);
  // A concave boundary is authoritative: replacing it with a generic circular
  // or rectangular guide would fill an L-shaped notch or another real cutout.
  const rimExtendsBoundary = !loopHasConcaveTurn(meshBoundary)
    && outlineAddsGeometry(meshBoundary, cleanedOutline);
  const rim = rimExtendsBoundary ? cleanedOutline : meshBoundary;
  return { surfaceIndex0, geometry, positions, triangles, boundary, rim, rimExtendsBoundary, center, color };
}

function mediumAfterSurfaceIsSolid(row: any): boolean {
  const material = String(row?.material ?? '').trim().toUpperCase();
  if (material === 'AIR' || material === '0' || material === 'MIRROR') return false;
  if (material) return true;
  const refractiveIndex = Number(row?.rindex ?? row?.refractiveIndex);
  return Number.isFinite(refractiveIndex) && refractiveIndex > 1.0001;
}

function addOrientedTriangle(
  output: number[],
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  outwardHint: THREE.Vector3,
): void {
  const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
  if (normal.lengthSq() < 1e-18) return;
  if (normal.dot(outwardHint) < 0) {
    output.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
  } else {
    output.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }
}

function cumulativeLoopProgress(loop: THREE.Vector3[]): number[] {
  const cumulative = [0];
  for (let i = 0; i < loop.length; i += 1) {
    cumulative.push(cumulative[i] + loop[i].distanceTo(loop[(i + 1) % loop.length]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= 1e-18) return cumulative.map(() => 0);
  return cumulative.map((value) => value / total);
}

function sampleClosedLoopAtProgress(
  loop: THREE.Vector3[],
  progress: number[],
  target: number,
): THREE.Vector3 {
  let edge = 0;
  while (edge + 1 < loop.length && progress[edge + 1] < target) edge += 1;
  const next = (edge + 1) % loop.length;
  const span = progress[edge + 1] - progress[edge];
  const t = span > 1e-18 ? (target - progress[edge]) / span : 0;
  return loop[edge].clone().lerp(loop[next], THREE.MathUtils.clamp(t, 0, 1));
}

function sampleClosedLoop(loop: THREE.Vector3[], count: number): THREE.Vector3[] {
  const progress = cumulativeLoopProgress(loop);
  const output: THREE.Vector3[] = [];
  for (let sample = 0; sample < count; sample += 1) {
    output.push(sampleClosedLoopAtProgress(loop, progress, sample / count));
  }
  return output;
}

function alignClosedLoop(reference: THREE.Vector3[], target: THREE.Vector3[]): THREE.Vector3[] {
  if (reference.length < 3 || target.length < 3) return target;
  const sampleCount = Math.max(16, Math.min(128, Math.max(reference.length, target.length)));
  const referenceSamples = sampleClosedLoop(reference, sampleCount);
  let bestLoop = target;
  let bestScore = Infinity;

  for (const candidate of [target, [...target].reverse()]) {
    for (let offset = 0; offset < candidate.length; offset += 1) {
      const rotated = [...candidate.slice(offset), ...candidate.slice(0, offset)];
      const samples = sampleClosedLoop(rotated, sampleCount);
      let score = 0;
      for (let i = 0; i < sampleCount; i += 1) score += referenceSamples[i].distanceToSquared(samples[i]);
      if (score < bestScore) {
        bestScore = score;
        bestLoop = rotated;
      }
    }
  }
  return bestLoop;
}

function stitchClosedLoops(
  loopA: THREE.Vector3[],
  rawLoopB: THREE.Vector3[],
  addTriangle: (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => void,
): void {
  if (loopA.length < 3 || rawLoopB.length < 3) return;
  const loopB = alignClosedLoop(loopA, rawLoopB);
  const progressA = cumulativeLoopProgress(loopA);
  const progressB = cumulativeLoopProgress(loopB);
  let i = 0;
  let j = 0;
  while (i < loopA.length || j < loopB.length) {
    const nextA = progressA[Math.min(i + 1, loopA.length)];
    const nextB = progressB[Math.min(j + 1, loopB.length)];
    const a0 = loopA[i % loopA.length];
    const b0 = loopB[j % loopB.length];
    if (Math.abs(nextA - nextB) < 1e-12) {
      const a1 = loopA[(i + 1) % loopA.length];
      const b1 = loopB[(j + 1) % loopB.length];
      addTriangle(a0, a1, b0);
      addTriangle(a1, b1, b0);
      i += 1;
      j += 1;
    } else if (nextA < nextB) {
      addTriangle(a0, loopA[(i + 1) % loopA.length], b0);
      i += 1;
    } else {
      addTriangle(a0, loopB[(j + 1) % loopB.length], b0);
      j += 1;
    }
  }
}

function readNominalSemiDiameter(row: any): number | null {
  const values = [row?.semidia, row?.semiDia, row?._semidia, row?.semiDiameter, row?.apertureRadius];
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.abs(parsed);
  }
  return null;
}

function radialExtent(loop: THREE.Vector3[], center: THREE.Vector3, axis: THREE.Vector3): number {
  return loop.reduce((maximum, point) => {
    const offset = new THREE.Vector3().subVectors(point, center);
    offset.addScaledVector(axis, -offset.dot(axis));
    return Math.max(maximum, offset.length());
  }, 0);
}

function buildClosedSolid(
  front: SurfaceMeshData,
  back: SurfaceMeshData,
  frontRow?: any,
  backRow?: any,
): THREE.Mesh | null {
  const axis = new THREE.Vector3().subVectors(back.center, front.center);
  if (axis.lengthSq() < 1e-18) return null;
  axis.normalize();
  const vertices: number[] = [];
  let stepRingPoints: THREE.Vector3[] | null = null;

  front.triangles.forEach(([a, b, c]) => addOrientedTriangle(vertices, front.positions[a], front.positions[b], front.positions[c], axis.clone().negate()));
  back.triangles.forEach(([a, b, c]) => addOrientedTriangle(vertices, back.positions[a], back.positions[b], back.positions[c], axis));

  const solidCenter = new THREE.Vector3().addVectors(front.center, back.center).multiplyScalar(0.5);
  const addRadialSide = (
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    axialDirection: THREE.Vector3 = axis,
  ) => {
    const hint = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3).sub(solidCenter);
    // Remove the axial component so the hint points radially out through the rim.
    hint.addScaledVector(axialDirection, -hint.dot(axialDirection));
    addOrientedTriangle(vertices, a, b, c, hint);
  };

  const frontBoundary = front.boundary.map((index) => front.positions[index]);
  const backBoundary = back.boundary.map((index) => back.positions[index]);
  if (front.rimExtendsBoundary) {
    stitchClosedLoops(frontBoundary, front.rim, (a, b, c) => addOrientedTriangle(vertices, a, b, c, axis.clone().negate()));
  }
  if (back.rimExtendsBoundary) {
    stitchClosedLoops(backBoundary, back.rim, (a, b, c) => addOrientedTriangle(vertices, a, b, c, axis));
  }

  const frontNominal = readNominalSemiDiameter(frontRow);
  const backNominal = readNominalSemiDiameter(backRow);
  const frontExtent = frontNominal ?? radialExtent(front.rim, front.center, axis);
  const backExtent = backNominal ?? radialExtent(back.rim, back.center, axis);
  const extentScale = Math.max(1, frontExtent, backExtent);
  if (Math.abs(frontExtent - backExtent) <= extentScale * 1e-6) {
    stitchClosedLoops(front.rim, back.rim, addRadialSide);
  } else {
    // Match the Render profile: the larger rim first runs parallel to its local
    // optical axis, then steps radially to the smaller rim. This produces the
    // intended L-shaped edge instead of a tapered/diagonal loft.
    const frontIsLarger = frontExtent > backExtent;
    const larger = frontIsLarger ? front : back;
    const smaller = frontIsLarger ? back : front;
    const largerLoop = larger.rim;
    const smallerLoop = alignClosedLoop(largerLoop, smaller.rim);
    const largerAxis = approximateLoopNormal(largerLoop);
    const towardSmaller = new THREE.Vector3().subVectors(smaller.center, larger.center);
    if (largerAxis.dot(towardSmaller) < 0) largerAxis.negate();
    const largerProgress = cumulativeLoopProgress(largerLoop);
    const smallerProgress = cumulativeLoopProgress(smallerLoop);
    const elbowLoop = largerLoop.map((point, index) => {
      const correspondingSmall = sampleClosedLoopAtProgress(smallerLoop, smallerProgress, largerProgress[index]);
      const axialLength = new THREE.Vector3().subVectors(correspondingSmall, point).dot(largerAxis);
      return point.clone().addScaledVector(largerAxis, axialLength);
    });
    stepRingPoints = elbowLoop;

    stitchClosedLoops(largerLoop, elbowLoop, (a, b, c) => addRadialSide(a, b, c, largerAxis));
    const shoulderHint = frontIsLarger ? axis : axis.clone().negate();
    stitchClosedLoops(elbowLoop, smallerLoop, (a, b, c) => addOrientedTriangle(vertices, a, b, c, shoulderHint));
  }

  if (vertices.length < 36) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry);
  mesh.userData = { type: 'opticalSolid', frontSurfaceIndex0: front.surfaceIndex0, backSurfaceIndex0: back.surfaceIndex0 };
  mesh.userData.displayColor = front.color;
  if (stepRingPoints) mesh.userData.stepRingPoints = stepRingPoints.map((point) => point.toArray());
  return mesh;
}

function buildClosedSolids(scene: THREE.Object3D, opticalSystemRows: any[]): THREE.Mesh[] {
  scene.updateMatrixWorld(true);
  const outlines = collectSurfaceOutlines(scene, opticalSystemRows);
  const surfaceMeshes = new Map<number, SurfaceMeshData>();
  scene.traverse((object) => {
    if (!isExportableOpticalSurface(object)) return;
    const surfaceIndex0 = readSurfaceIndex(object);
    const prepared = prepareSurfaceMesh(object, surfaceIndex0 === null ? undefined : outlines.get(surfaceIndex0));
    if (prepared && !surfaceMeshes.has(prepared.surfaceIndex0)) surfaceMeshes.set(prepared.surfaceIndex0, prepared);
  });

  const solids: THREE.Mesh[] = [];
  const indexes = [...surfaceMeshes.keys()].sort((a, b) => a - b);
  for (const frontIndex of indexes) {
    if (!mediumAfterSurfaceIsSolid(opticalSystemRows[frontIndex])) continue;
    const backIndex = indexes.find((candidate) => candidate > frontIndex);
    if (backIndex === undefined) continue;
    const solid = buildClosedSolid(
      surfaceMeshes.get(frontIndex)!,
      surfaceMeshes.get(backIndex)!,
      opticalSystemRows[frontIndex],
      opticalSystemRows[backIndex],
    );
    if (solid) solids.push(solid);
  }

  surfaceMeshes.forEach((surface) => surface.geometry.dispose());
  return solids;
}

type ClippedSolidGeometry = {
  geometry: THREE.BufferGeometry;
  sectionLoops: THREE.Vector3[][];
};

function cutIntersection(a: THREE.Vector3, b: THREE.Vector3, da: number, db: number): THREE.Vector3 {
  const denominator = da - db;
  const t = Math.abs(denominator) > 1e-18 ? da / denominator : 0;
  return a.clone().lerp(b, THREE.MathUtils.clamp(t, 0, 1));
}

function clipTriangleToKeptHalf(points: THREE.Vector3[], distances: number[], tolerance: number): THREE.Vector3[] {
  const output: THREE.Vector3[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const previousIndex = (i + points.length - 1) % points.length;
    const previous = points[previousIndex];
    const current = points[i];
    const previousDistance = distances[previousIndex];
    const currentDistance = distances[i];
    const previousInside = previousDistance <= tolerance;
    const currentInside = currentDistance <= tolerance;
    if (currentInside) {
      if (!previousInside) output.push(cutIntersection(previous, current, previousDistance, currentDistance));
      output.push(current.clone());
    } else if (previousInside) {
      output.push(cutIntersection(previous, current, previousDistance, currentDistance));
    }
  }
  return cleanClosedLoop(output);
}

function trianglePlaneSegment(
  points: THREE.Vector3[],
  distances: number[],
  tolerance: number,
): [THREE.Vector3, THREE.Vector3] | null {
  const intersections: THREE.Vector3[] = [];
  const addUnique = (point: THREE.Vector3) => {
    if (!intersections.some((existing) => existing.distanceToSquared(point) <= tolerance * tolerance)) {
      intersections.push(point);
    }
  };
  for (let i = 0; i < 3; i += 1) {
    const next = (i + 1) % 3;
    const da = distances[i];
    const db = distances[next];
    if (Math.abs(da) <= tolerance) addUnique(points[i].clone());
    if ((da < -tolerance && db > tolerance) || (da > tolerance && db < -tolerance)) {
      addUnique(cutIntersection(points[i], points[next], da, db));
    }
  }
  return intersections.length === 2 ? [intersections[0], intersections[1]] : null;
}

function connectCutSegments(segments: Array<[THREE.Vector3, THREE.Vector3]>, tolerance: number): THREE.Vector3[][] {
  const scale = 1 / Math.max(tolerance, 1e-8);
  const pointKey = (point: THREE.Vector3) => (
    `${Math.round(point.x * scale)}:${Math.round(point.y * scale)}:${Math.round(point.z * scale)}`
  );
  const points = new Map<string, THREE.Vector3>();
  const adjacency = new Map<string, Set<string>>();
  const unusedEdges = new Set<string>();
  const edgeKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
  segments.forEach(([a, b]) => {
    const ka = pointKey(a);
    const kb = pointKey(b);
    if (ka === kb) return;
    points.set(ka, points.get(ka) || a);
    points.set(kb, points.get(kb) || b);
    adjacency.set(ka, adjacency.get(ka) || new Set());
    adjacency.set(kb, adjacency.get(kb) || new Set());
    adjacency.get(ka)!.add(kb);
    adjacency.get(kb)!.add(ka);
    unusedEdges.add(edgeKey(ka, kb));
  });

  const loops: THREE.Vector3[][] = [];
  while (unusedEdges.size > 0) {
    const first = unusedEdges.values().next().value as string;
    const separator = first.indexOf('|');
    const start = first.slice(0, separator);
    let previous = start;
    let current = first.slice(separator + 1);
    const keys = [start];
    unusedEdges.delete(first);
    let guard = 0;
    while (current !== start && guard <= points.size + 2) {
      keys.push(current);
      const next = [...(adjacency.get(current) || [])]
        .find((candidate) => candidate !== previous && unusedEdges.has(edgeKey(current, candidate)));
      if (!next) break;
      unusedEdges.delete(edgeKey(current, next));
      previous = current;
      current = next;
      guard += 1;
    }
    if (current === start && keys.length >= 3) {
      loops.push(keys.map((key) => points.get(key)!.clone()));
    }
  }
  return loops;
}

function clipClosedGeometryForSection(
  source: THREE.BufferGeometry,
  removedDirection: THREE.Vector3,
): ClippedSolidGeometry | null {
  const position = source.getAttribute('position');
  if (!position || position.count < 3) return null;
  source.computeBoundingBox();
  const diagonal = source.boundingBox?.getSize(new THREE.Vector3()).length() || 1;
  const tolerance = Math.max(1e-7, diagonal * 1e-7);
  const vertices: number[] = [];
  const cutSegments: Array<[THREE.Vector3, THREE.Vector3]> = [];
  const appendTriangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (normal.lengthSq() <= tolerance * tolerance) return;
    vertices.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  for (let i = 0; i + 2 < position.count; i += 3) {
    const triangle = [0, 1, 2].map((corner) => new THREE.Vector3().fromBufferAttribute(position, i + corner));
    const distances = triangle.map((point) => point.dot(removedDirection));
    const clipped = clipTriangleToKeptHalf(triangle, distances, tolerance);
    for (let corner = 1; corner + 1 < clipped.length; corner += 1) {
      appendTriangle(clipped[0], clipped[corner], clipped[corner + 1]);
    }
    const segment = trianglePlaneSegment(triangle, distances, tolerance);
    if (segment) cutSegments.push(segment);
  }

  const sectionLoops = connectCutSegments(cutSegments, tolerance * 10);
  const tangent = new THREE.Vector3(-removedDirection.y, removedDirection.x, 0).normalize();
  sectionLoops.forEach((loop) => {
    const contour = loop.map((point) => new THREE.Vector2(point.dot(tangent), point.z));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    faces.forEach(([a, b, c]) => addOrientedTriangle(vertices, loop[a], loop[b], loop[c], removedDirection));
  });

  if (vertices.length < 36) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return { geometry, sectionLoops };
}

function addLoopOutline(
  parent: THREE.Object3D,
  loops: THREE.Vector3[][],
  name: string,
  type: string,
  renderOrder: number,
): void {
  const linePositions: number[] = [];
  loops.forEach((loop) => loop.forEach((point, index) => {
    const next = loop[(index + 1) % loop.length];
    linePositions.push(point.x, point.y, point.z, next.x, next.y, next.z);
  }));
  if (linePositions.length < 6) return;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  const line = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
    color: 0x101010,
    transparent: true,
    opacity: 1,
    depthTest: false,
    depthWrite: false,
  }));
  line.name = name;
  line.renderOrder = renderOrder;
  line.userData = { type, isOpticalElement: true };
  parent.add(line);
}

function clipLoopForSection(points: THREE.Vector3[], removedDirection: THREE.Vector3): number[] {
  const output: number[] = [];
  const tolerance = 1e-7;
  points.forEach((a, index) => {
    const b = points[(index + 1) % points.length];
    const da = a.dot(removedDirection);
    const db = b.dot(removedDirection);
    const aInside = da <= tolerance;
    const bInside = db <= tolerance;
    if (aInside && bInside) {
      output.push(a.x, a.y, a.z, b.x, b.y, b.z);
    } else if (aInside !== bInside) {
      const intersection = cutIntersection(a, b, da, db);
      const inside = aInside ? a : b;
      output.push(inside.x, inside.y, inside.z, intersection.x, intersection.y, intersection.z);
    }
  });
  return output;
}

/** Build the same closed lens geometry used by Solid STL/FCStd for display. */
export function createOpticalSceneSolidGroup(
  scene: THREE.Object3D,
  opticalSystemRows: any[] = [],
  options: OpticalSolidDisplayOptions = {},
): OpticalSolidScene {
  if (!scene || typeof scene.traverse !== 'function') {
    throw new Error('A rendered Three.js scene is required for solid display.');
  }
  const group = new THREE.Group();
  group.name = 'co-opt-render-solids';
  group.userData = { type: 'renderSolidGroup', isOpticalElement: true };
  const solids = buildClosedSolids(scene, Array.isArray(opticalSystemRows) ? opticalSystemRows : []);
  const requestedAngle = Number(options.sectionAngleDegrees);
  const sectionEnabled = options.sectionAngleDegrees !== null
    && options.sectionAngleDegrees !== undefined
    && Number.isFinite(requestedAngle);
  const normalizedAngle = sectionEnabled ? ((requestedAngle % 360) + 360) % 360 : 0;
  const angleRadians = THREE.MathUtils.degToRad(normalizedAngle);
  const removedDirection = new THREE.Vector3(Math.cos(angleRadians), Math.sin(angleRadians), 0).normalize();
  let triangleCount = 0;
  solids.forEach((solid, index) => {
    solid.name = `Lens Solid ${String(index + 1).padStart(3, '0')}`;
    solid.userData = { ...solid.userData, type: 'renderSolid', isOpticalElement: true, solidIndex0: index };
    if (sectionEnabled) {
      const clipped = clipClosedGeometryForSection(solid.geometry, removedDirection);
      if (clipped) {
        solid.geometry.dispose();
        solid.geometry = clipped.geometry;
        solid.userData.sectionAngleDegrees = normalizedAngle;
        addLoopOutline(
          solid,
          clipped.sectionLoops,
          `Lens Section Outline ${String(index + 1).padStart(3, '0')}`,
          'solidSectionOutline',
          1003,
        );
      }
    }
    triangleCount += Math.floor((solid.geometry.getAttribute('position')?.count || 0) / 3);
    const stepRingPoints = Array.isArray(solid.userData.stepRingPoints)
      ? solid.userData.stepRingPoints
        .filter((point: unknown) => Array.isArray(point) && point.length >= 3)
        .map((point: number[]) => new THREE.Vector3(Number(point[0]), Number(point[1]), Number(point[2])))
        .filter((point: THREE.Vector3) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z))
      : [];
    if (stepRingPoints.length >= 3) {
      const clippedLinePositions = sectionEnabled ? clipLoopForSection(stepRingPoints, removedDirection) : [];
      const ringGeometry = new THREE.BufferGeometry();
      if (sectionEnabled) ringGeometry.setAttribute('position', new THREE.Float32BufferAttribute(clippedLinePositions, 3));
      else ringGeometry.setFromPoints(stepRingPoints);
      const RingConstructor = sectionEnabled ? THREE.LineSegments : THREE.LineLoop;
      const ring = new RingConstructor(
        ringGeometry,
        new THREE.LineBasicMaterial({
          color: 0x101010,
          transparent: true,
          opacity: 1,
          depthTest: false,
          depthWrite: false,
        }),
      );
      ring.name = `Lens Step Ring ${String(index + 1).padStart(3, '0')}`;
      ring.renderOrder = 1002;
      ring.userData = {
        type: 'solidStepRing',
        isOpticalElement: true,
        solidIndex0: index,
        frontSurfaceIndex0: solid.userData.frontSurfaceIndex0,
        backSurfaceIndex0: solid.userData.backSurfaceIndex0,
      };
      solid.add(ring);
    }
    group.add(solid);
  });
  return { group, solidCount: solids.length, triangleCount };
}

/**
 * Convert the visible 3D optical surfaces in a rendered Three.js scene to STL.
 *
 * STL has no unit metadata. co-opt coordinates are written unchanged and are
 * intended to be interpreted as millimetres by the receiving CAD application.
 * Rays, labels, cross-section fills, rings, and debug markers are excluded.
 */
export function generateOpticalSceneStl(
  scene: THREE.Object3D,
  options: { binary?: boolean; opticalSystemRows?: any[]; solid?: boolean } = {},
): OpticalStlExport {
  if (!scene || typeof scene.traverse !== 'function') {
    throw new Error('A rendered Three.js scene is required for STL export.');
  }

  scene.updateMatrixWorld(true);
  const exportRoot = new THREE.Group();
  let meshCount = 0;
  let solidCount = 0;
  let triangleCount = 0;
  const solidMeshes: Array<{ positions: number[]; label: string }> = [];

  if (options.solid) {
    const rows = Array.isArray(options.opticalSystemRows) ? options.opticalSystemRows : [];
    const solids = buildClosedSolids(scene, rows);
    for (const solid of solids) {
      exportRoot.add(solid);
      meshCount += 1;
      solidCount += 1;
      const solidPosition = solid.geometry.getAttribute('position');
      triangleCount += Math.floor((solidPosition?.count || 0) / 3);
      solidMeshes.push({
        positions: solidPosition ? Array.from(solidPosition.array as ArrayLike<number>) : [],
        label: `Lens Solid ${String(solidCount).padStart(3, '0')}`,
      });
    }
  }

  if (!options.solid) {
    scene.traverse((object) => {
      if (!isExportableOpticalSurface(object)) return;
      const sourceGeometry = object.geometry;
      const position = sourceGeometry?.getAttribute?.('position');
      if (!sourceGeometry || !position || position.count < 3) return;

      // Bake the complete world transform into a detached geometry. This avoids
      // re-parenting or mutating any object currently displayed in Render.
      const geometry = sourceGeometry.clone();
      geometry.applyMatrix4(object.matrixWorld);
      const mesh = new THREE.Mesh(geometry);
      mesh.matrixAutoUpdate = false;
      exportRoot.add(mesh);

      meshCount += 1;
      triangleCount += geometry.index
        ? Math.floor(geometry.index.count / 3)
        : Math.floor(position.count / 3);
    });
  }

  if (meshCount === 0 || triangleCount === 0) {
    throw new Error(options.solid
      ? 'No closed lens solids could be built. Press Render and check that lens rows have a non-AIR material.'
      : 'No visible 3D optical surface meshes are available. Press Render first.');
  }

  const exporter = new STLExporter();
  const binary = options.binary !== false;
  // Three r182 returns DataView for binary output, although older declarations
  // and documentation commonly describe the result as ArrayBuffer.
  const data = exporter.parse(exportRoot, { binary }) as ArrayBuffer | ArrayBufferView | string;

  exportRoot.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) {
      (object as THREE.Mesh).geometry.dispose();
    }
  });

  return { data, meshCount, solidCount, triangleCount, solidMeshes };
}

export function downloadStl(data: ArrayBuffer | ArrayBufferView | string, filename = 'co-opt-render.stl'): void {
  const ensuredName = /\.stl$/i.test(filename) ? filename : `${filename}.stl`;
  const blob = new Blob([data as BlobPart], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = ensuredName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
