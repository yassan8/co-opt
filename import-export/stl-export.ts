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

type SurfaceMeshData = {
  surfaceIndex0: number;
  geometry: THREE.BufferGeometry;
  positions: THREE.Vector3[];
  triangles: Array<[number, number, number]>;
  boundary: number[];
  center: THREE.Vector3;
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

function prepareSurfaceMesh(object: THREE.Mesh): SurfaceMeshData | null {
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

  return { surfaceIndex0, geometry, positions, triangles, boundary, center };
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

function buildClosedSolid(front: SurfaceMeshData, back: SurfaceMeshData): THREE.Mesh | null {
  const axis = new THREE.Vector3().subVectors(back.center, front.center);
  if (axis.lengthSq() < 1e-18) return null;
  axis.normalize();
  const vertices: number[] = [];

  front.triangles.forEach(([a, b, c]) => addOrientedTriangle(vertices, front.positions[a], front.positions[b], front.positions[c], axis.clone().negate()));
  back.triangles.forEach(([a, b, c]) => addOrientedTriangle(vertices, back.positions[a], back.positions[b], back.positions[c], axis));

  const frontLoop = front.boundary.map((i) => front.positions[i]);
  let backLoop = back.boundary.map((i) => back.positions[i]);
  let closest = 0;
  let closestDistance = Infinity;
  for (let i = 0; i < backLoop.length; i += 1) {
    const distance = frontLoop[0].distanceToSquared(backLoop[i]);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = i;
    }
  }
  backLoop = [...backLoop.slice(closest), ...backLoop.slice(0, closest)];
  if (frontLoop.length > 1 && backLoop.length > 2) {
    const forward = frontLoop[1].distanceToSquared(backLoop[1]);
    const reverse = frontLoop[1].distanceToSquared(backLoop[backLoop.length - 1]);
    if (reverse < forward) backLoop = [backLoop[0], ...backLoop.slice(1).reverse()];
  }

  const solidCenter = new THREE.Vector3().addVectors(front.center, back.center).multiplyScalar(0.5);
  const addSide = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    const hint = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3).sub(solidCenter);
    // Remove the axial component so the hint points radially out through the rim.
    hint.addScaledVector(axis, -hint.dot(axis));
    addOrientedTriangle(vertices, a, b, c, hint);
  };

  let i = 0;
  let j = 0;
  const n = frontLoop.length;
  const m = backLoop.length;
  while (i < n || j < m) {
    const nextFront = (i + 1) / n;
    const nextBack = (j + 1) / m;
    const f0 = frontLoop[i % n];
    const b0 = backLoop[j % m];
    if (Math.abs(nextFront - nextBack) < 1e-12) {
      const f1 = frontLoop[(i + 1) % n];
      const b1 = backLoop[(j + 1) % m];
      addSide(f0, f1, b0);
      addSide(f1, b1, b0);
      i += 1;
      j += 1;
    } else if (nextFront < nextBack) {
      addSide(f0, frontLoop[(i + 1) % n], b0);
      i += 1;
    } else {
      addSide(f0, backLoop[(j + 1) % m], b0);
      j += 1;
    }
  }

  if (vertices.length < 36) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry);
  mesh.userData = { type: 'opticalSolid', frontSurfaceIndex0: front.surfaceIndex0, backSurfaceIndex0: back.surfaceIndex0 };
  return mesh;
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

  const surfaceMeshes = new Map<number, SurfaceMeshData>();
  if (options.solid) {
    scene.traverse((object) => {
      if (!isExportableOpticalSurface(object)) return;
      const prepared = prepareSurfaceMesh(object);
      if (prepared && !surfaceMeshes.has(prepared.surfaceIndex0)) surfaceMeshes.set(prepared.surfaceIndex0, prepared);
    });

    const rows = Array.isArray(options.opticalSystemRows) ? options.opticalSystemRows : [];
    const indexes = [...surfaceMeshes.keys()].sort((a, b) => a - b);
    for (const frontIndex of indexes) {
      if (!mediumAfterSurfaceIsSolid(rows[frontIndex])) continue;
      const backIndex = indexes.find((candidate) => candidate > frontIndex);
      if (backIndex === undefined) continue;
      const solid = buildClosedSolid(surfaceMeshes.get(frontIndex)!, surfaceMeshes.get(backIndex)!);
      if (!solid) continue;
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

  surfaceMeshes.forEach((surface) => surface.geometry.dispose());
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
