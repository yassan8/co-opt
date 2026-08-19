import * as THREE from 'three';
import { createOpticalSceneSolidGroup, generateOpticalSceneStl } from '../import-export/stl-export.ts';
import { createOpenCascadeBrep } from '../import-export/freecad-export.ts';
import {
  drawRectApertureWithOriginAndSurface,
  drawSemidiaRingWithOriginAndSurface,
  drawToricSurfaceWithOrigin,
} from '../optical/surface.ts';

function addSurface(
  scene: THREE.Scene,
  geometry: THREE.BufferGeometry,
  surfaceIndex0: number,
  transform: { z: number; x?: number; ry?: number },
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x67c7ff }));
  mesh.userData = { type: 'lensSurface', isLensSurface: true, surfaceIndex0 };
  mesh.position.set(transform.x || 0, 0, transform.z);
  mesh.rotation.y = transform.ry || 0;
  scene.add(mesh);
  return mesh;
}

function addOutline(
  scene: THREE.Scene,
  points: THREE.Vector3[],
  surfaceIndex0: number,
  type: 'semidiaRing' | 'apertureRect',
  transform: { z: number; x?: number; ry?: number },
): void {
  const line = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial(),
  );
  line.userData = { type, surfaceIndex0 };
  line.position.set(transform.x || 0, 0, transform.z);
  line.rotation.y = transform.ry || 0;
  scene.add(line);
}

function circlePoints(radius: number, segments: number): THREE.Vector3[] {
  return Array.from({ length: segments }, (_, index) => {
    const angle = (index / segments) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
  });
}

function edgeAudit(mesh: THREE.Mesh): { unmatched: number; overmatched: number } {
  const position = mesh.geometry.getAttribute('position');
  const counts = new Map<string, number>();
  const key = (index: number) => {
    const q = (value: number) => Math.round(value * 1e5);
    return `${q(position.getX(index))},${q(position.getY(index))},${q(position.getZ(index))}`;
  };
  for (let i = 0; i + 2 < position.count; i += 3) {
    const triangle = [key(i), key(i + 1), key(i + 2)];
    for (let edge = 0; edge < 3; edge += 1) {
      const pair = [triangle[edge], triangle[(edge + 1) % 3]].sort();
      const edgeKey = `${pair[0]}|${pair[1]}`;
      counts.set(edgeKey, (counts.get(edgeKey) || 0) + 1);
    }
  }
  return {
    unmatched: [...counts.values()].filter((count) => count === 1).length,
    overmatched: [...counts.values()].filter((count) => count > 2).length,
  };
}

function verifyCircular(): void {
  const scene = new THREE.Scene();
  const frontTransform = { z: 0, x: -0.4, ry: 0.04 };
  const backTransform = { z: 4, x: 0.7, ry: -0.03 };
  addSurface(scene, new THREE.CircleGeometry(9.5, 32), 0, frontTransform);
  addSurface(scene, new THREE.CircleGeometry(8.2, 53), 1, backTransform);
  addOutline(scene, circlePoints(10, 71), 0, 'semidiaRing', frontTransform);
  addOutline(scene, circlePoints(8.7, 67), 1, 'semidiaRing', backTransform);
  const result = createOpticalSceneSolidGroup(scene, [{ material: 'N-BK7' }, { material: 'AIR' }]);
  if (result.solidCount !== 1) throw new Error(`circular: expected one solid, got ${result.solidCount}`);
  const audit = edgeAudit(result.group.children[0] as THREE.Mesh);
  if (audit.unmatched || audit.overmatched) throw new Error(`circular: invalid edges ${JSON.stringify(audit)}`);
}

function verifyRectangular(): void {
  const scene = new THREE.Scene();
  const frontTransform = { z: 0, x: 0.2, ry: 0.025 };
  const backTransform = { z: 3.2, x: -0.3, ry: -0.02 };
  addSurface(scene, new THREE.PlaneGeometry(18, 12, 5, 3), 0, frontTransform);
  addSurface(scene, new THREE.PlaneGeometry(16, 10, 7, 4), 1, backTransform);
  const rect = (width: number, height: number) => [
    new THREE.Vector3(-width / 2, -height / 2, 0),
    new THREE.Vector3(width / 2, -height / 2, 0),
    new THREE.Vector3(width / 2, height / 2, 0),
    new THREE.Vector3(-width / 2, height / 2, 0),
  ];
  addOutline(scene, rect(18, 12), 0, 'apertureRect', frontTransform);
  addOutline(scene, rect(16, 10), 1, 'apertureRect', backTransform);
  const result = createOpticalSceneSolidGroup(scene, [
    { material: 'N-BK7', apertureShape: 'Rectangular' },
    { material: 'AIR', apertureShape: 'Rectangular' },
  ]);
  if (result.solidCount !== 1) throw new Error(`rectangular: expected one solid, got ${result.solidCount}`);
  const audit = edgeAudit(result.group.children[0] as THREE.Mesh);
  if (audit.unmatched || audit.overmatched) throw new Error(`rectangular: invalid edges ${JSON.stringify(audit)}`);
}

function verifyToricCircular(): void {
  const scene = new THREE.Scene();
  const front = { radiusX: 45, radiusY: 70, conic: 0, axis: 18, semidia: 10, __cooptSurfaceIndex0: 0 };
  const back = { radiusX: -55, radiusY: -80, conic: 0, axis: 18, semidia: 9, __cooptSurfaceIndex0: 1 };
  drawToricSurfaceWithOrigin(scene, front, { x: 0, y: 0, z: 0 }, null, 18);
  drawToricSurfaceWithOrigin(scene, back, { x: 0.5, y: -0.2, z: 4 }, null, 21);
  drawSemidiaRingWithOriginAndSurface(scene, 10, 73, 0, { x: 0, y: 0, z: 0 }, null, front);
  drawSemidiaRingWithOriginAndSurface(scene, 9, 69, 0, { x: 0.5, y: -0.2, z: 4 }, null, back);
  const result = createOpticalSceneSolidGroup(scene, [{ material: 'N-BK7' }, { material: 'AIR' }]);
  if (result.solidCount !== 1) throw new Error(`toric circular: expected one solid, got ${result.solidCount}`);
  const audit = edgeAudit(result.group.children[0] as THREE.Mesh);
  if (audit.unmatched || audit.overmatched) throw new Error(`toric circular: invalid edges ${JSON.stringify(audit)}`);
}

function verifyFlatToricRectangular(): void {
  const scene = new THREE.Scene();
  const front = {
    radiusX: Infinity,
    radiusY: Infinity,
    conic: 0,
    axis: 0,
    semidia: 10,
    apertureShape: 'Rectangular',
    apertureWidth: 18,
    apertureHeight: 11,
    __cooptSurfaceIndex0: 0,
  };
  const back = { ...front, apertureWidth: 16, apertureHeight: 9, __cooptSurfaceIndex0: 1 };
  drawToricSurfaceWithOrigin(scene, front, { x: 0, y: 0, z: 0 }, null, 9);
  drawToricSurfaceWithOrigin(scene, back, { x: 0, y: 0, z: 3 }, null, 11);
  drawRectApertureWithOriginAndSurface(scene, 18, 11, 17, 0, { x: 0, y: 0, z: 0 }, null, front);
  drawRectApertureWithOriginAndSurface(scene, 16, 9, 19, 0, { x: 0, y: 0, z: 3 }, null, back);
  const rows = [
    { material: 'N-BK7', apertureShape: 'Rectangular' },
    { material: 'AIR', apertureShape: 'Rectangular' },
  ];
  const result = createOpticalSceneSolidGroup(scene, rows);
  if (result.solidCount !== 1) throw new Error(`flat toric rect: expected one solid, got ${result.solidCount}`);
  const audit = edgeAudit(result.group.children[0] as THREE.Mesh);
  if (audit.unmatched || audit.overmatched) throw new Error(`flat toric rect: invalid edges ${JSON.stringify(audit)}`);
}

function verifyLNotch(): void {
  const scene = new THREE.Scene();
  const makeLGeometry = () => {
    const shape = new THREE.Shape();
    shape.moveTo(-5, -4);
    shape.lineTo(5, -4);
    shape.lineTo(5, 4);
    shape.lineTo(1, 4);
    shape.lineTo(1, 0);
    shape.lineTo(-5, 0);
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  };
  addSurface(scene, makeLGeometry(), 0, { z: 0 });
  addSurface(scene, makeLGeometry(), 1, { z: 3 });
  const fullRectangle = [
    new THREE.Vector3(-5, -4, 0),
    new THREE.Vector3(5, -4, 0),
    new THREE.Vector3(5, 4, 0),
    new THREE.Vector3(-5, 4, 0),
  ];
  // Simulate the generic aperture guide that previously filled the notch.
  addOutline(scene, fullRectangle, 0, 'apertureRect', { z: 0 });
  addOutline(scene, fullRectangle, 1, 'apertureRect', { z: 3 });
  const rows = [
    { material: 'N-BK7', apertureShape: 'Rectangular' },
    { material: 'AIR', apertureShape: 'Rectangular' },
  ];
  const result = createOpticalSceneSolidGroup(scene, rows);
  if (result.solidCount !== 1) throw new Error(`L notch: expected one solid, got ${result.solidCount}`);
  const solid = result.group.children[0] as THREE.Mesh;
  const audit = edgeAudit(solid);
  if (audit.unmatched || audit.overmatched) throw new Error(`L notch: invalid edges ${JSON.stringify(audit)}`);
  const position = solid.geometry.getAttribute('position');
  let hasInnerCorner = false;
  let hasFilledCorner = false;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    if (Math.abs(x - 1) < 1e-5 && Math.abs(y) < 1e-5) hasInnerCorner = true;
    if (Math.abs(x + 5) < 1e-5 && Math.abs(y - 4) < 1e-5) hasFilledCorner = true;
  }
  if (!hasInnerCorner || hasFilledCorner) {
    throw new Error(`L notch: cutout was not preserved (inner=${hasInnerCorner}, filled=${hasFilledCorner})`);
  }
}

function verifySteppedEdgeProfile(): void {
  const scene = new THREE.Scene();
  addSurface(scene, new THREE.CircleGeometry(10, 48), 0, { z: 0 });
  addSurface(scene, new THREE.CircleGeometry(7, 48), 1, { z: 4 });
  const rows = [
    { material: 'N-BK7', semidia: 10 },
    { material: 'AIR', semidia: 7 },
  ];
  const result = createOpticalSceneSolidGroup(scene, rows);
  if (result.solidCount !== 1) throw new Error(`stepped edge: expected one solid, got ${result.solidCount}`);
  const solid = result.group.children[0] as THREE.Mesh;
  const stepRing = solid.children.find((child) => child.userData?.type === 'solidStepRing') as THREE.LineLoop | undefined;
  if (!stepRing) throw new Error('stepped edge: 3D step ring is missing');
  const ringPosition = stepRing.geometry.getAttribute('position');
  for (let i = 0; i < ringPosition.count; i += 1) {
    const radius = Math.hypot(ringPosition.getX(i), ringPosition.getY(i));
    if (Math.abs(radius - 10) > 1e-4 || Math.abs(ringPosition.getZ(i) - 4) > 1e-4) {
      throw new Error(`stepped edge: 3D ring is off the L vertex (r=${radius}, z=${ringPosition.getZ(i)})`);
    }
  }
  const audit = edgeAudit(solid);
  if (audit.unmatched || audit.overmatched) throw new Error(`stepped edge: invalid edges ${JSON.stringify(audit)}`);
  const position = solid.geometry.getAttribute('position');
  let hasOuterElbow = false;
  let hasDiagonalMidpoint = false;
  for (let i = 0; i < position.count; i += 1) {
    const radius = Math.hypot(position.getX(i), position.getY(i));
    const z = position.getZ(i);
    if (Math.abs(radius - 10) < 1e-4 && Math.abs(z - 4) < 1e-4) hasOuterElbow = true;
    if (radius > 7.2 && radius < 9.8 && z > 0.2 && z < 3.8) hasDiagonalMidpoint = true;
  }
  if (!hasOuterElbow || hasDiagonalMidpoint) {
    throw new Error(`stepped edge: L profile missing (elbow=${hasOuterElbow}, diagonal=${hasDiagonalMidpoint})`);
  }
  const stl = generateOpticalSceneStl(scene, { binary: true, solid: true, opticalSystemRows: rows });
  if (stl.solidCount !== 1 || stl.solidMeshes.length !== 1) {
    throw new Error(`stepped edge STL: expected one solid, got ${stl.solidCount}`);
  }
  const brep = createOpenCascadeBrep(stl.solidMeshes[0]);
  if (!brep.includes('CASCADE Topology V1')) throw new Error('stepped edge FreeCAD: invalid BREP');
}

function verifySectionCut(): void {
  const verifyAngle = (angle: 90 | 270) => {
    const scene = new THREE.Scene();
    addSurface(scene, new THREE.CircleGeometry(10, 48), 0, { z: 0 });
    addSurface(scene, new THREE.CircleGeometry(7, 48), 1, { z: 4 });
    const rows = [{ material: 'N-BK7', semidia: 10 }, { material: 'AIR', semidia: 7 }];
    const result = createOpticalSceneSolidGroup(scene, rows, { sectionAngleDegrees: angle });
    if (result.solidCount !== 1) throw new Error(`section ${angle}: expected one solid`);
    const solid = result.group.children[0] as THREE.Mesh;
    const audit = edgeAudit(solid);
    if (audit.unmatched || audit.overmatched) throw new Error(`section ${angle}: invalid edges ${JSON.stringify(audit)}`);
    const position = solid.geometry.getAttribute('position');
    let capTriangles = 0;
    for (let i = 0; i + 2 < position.count; i += 3) {
      const ys = [position.getY(i), position.getY(i + 1), position.getY(i + 2)];
      if (angle === 90 && ys.some((y) => y > 1e-4)) throw new Error(`section 90: +Y point remained`);
      if (angle === 270 && ys.some((y) => y < -1e-4)) throw new Error(`section 270: -Y point remained`);
      if (ys.every((y) => Math.abs(y) < 1e-5)) capTriangles += 1;
    }
    if (capTriangles === 0) throw new Error(`section ${angle}: cap face is missing`);
    if (!solid.children.some((child) => child.userData?.type === 'solidSectionOutline')) {
      throw new Error(`section ${angle}: section outline is missing`);
    }
  };
  verifyAngle(90);
  verifyAngle(270);
}

verifyCircular();
verifyRectangular();
verifyToricCircular();
verifyFlatToricRectangular();
verifyLNotch();
verifySteppedEdgeProfile();
verifySectionCut();
console.log('solid rim regression: PASS');
