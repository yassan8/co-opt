import * as THREE from 'three';
import { resolveComponentTransform, type CoherentAssemblyDesign } from '../../analysis/coherent-assembly.ts';
import { buildCoherentRenderConnectionOverlay } from '../../analysis/coherent-render-connections.ts';
import { NONSEQUENTIAL_TRACE_CHANNEL, runNonSequentialTrace, type NonSequentialTraceResult } from '../../analysis/nonsequential-trace.ts';
import { runPortRoutedTrace, type PortRoutedTraceResult } from '../../analysis/port-routed-trace.ts';
import { readActiveConfiguration, readActiveCoherentDesign, subscribeActiveCoherentDesign, type ActiveCoherentDesignSnapshot } from '../../data/coherent-config-store.ts';
import { expandSequentialGroupRows } from '../../analysis/sequential-group-rows.ts';
import { drawOpticalSystemSurfaces } from '../../optical/system-renderer.ts';

const GROUP_NAME = 'coopt-non-sequential-assembly';
const CONNECTION_GROUP_NAME = 'coopt-design-connections';
export const RENDER_CONNECTIONS_STORAGE_KEY = 'coopt.render.showPortConnections';
export const RENDER_CONNECTIONS_VISIBILITY_EVENT = 'coopt:render-connections-visibility';
export const DESIGN_CONNECTION_SELECTED_EVENT = 'coopt:design-connection-selected';
export const OPTICAL_ROUTE_SELECTED_EVENT = 'coopt:optical-route-selected';
export const RENDER_SELECTED_ROUTE_STORAGE_KEY = 'coopt.render.selectedOpticalRoute';
export const PORT_ROUTED_RENDER_STATUS_EVENT = 'coopt:port-routed-render-status';

export interface PortRoutedRenderStatusDetail {
  active: boolean;
  state: 'idle' | 'tracing' | 'ready' | 'error';
  rayCount: number;
  routeCount: number;
  message?: string;
}

interface OverlayPayload {
  result?: NonSequentialTraceResult | null;
  design: CoherentAssemblyDesign;
  revision: number;
}

interface OverlayDrawOptions {
  showConnections?: boolean;
  selectedConnectionId?: string | null;
  selectedRouteId?: string | null;
  fitAssembly?: boolean;
}

function adaptPortRoutedRenderResult(result: PortRoutedTraceResult): NonSequentialTraceResult {
  return {
    segments: result.segments.map((segment) => ({
      rayId: segment.rayId,
      parentRayId: null,
      startMm: segment.fromMm,
      endMm: segment.toMm,
      wavelengthNm: segment.wavelengthNm,
      powerW: segment.powerW,
      surfaceId: `${segment.routeId}:${segment.kind}`,
      history: `${segment.routeId}:${segment.direction}:${segment.sequence + 1}`,
    })),
    detectors: [], spectrumLines: [], ghostPaths: [],
    energy: {
      emittedPowerW: result.energy.launchedPowerW,
      detectedRayPowerW: result.energy.detectedPowerW,
      escapedPowerW: result.energy.lostPowerW,
      absorbedPowerW: 0,
      truncatedPowerW: 0,
    },
    generatedRayCount: result.routeMetrics.reduce((sum, route) => sum + route.launchedRays, 0),
    terminatedRayCount: result.routeMetrics.reduce((sum, route) => sum + route.reachedRays, 0),
    warnings: result.warnings,
    revision: result.revision,
    quality: 'preview',
  };
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((material: any) => {
      material.map?.dispose?.();
      material.dispose?.();
    });
  });
}

function wavelengthColor(wavelengthNm: number): THREE.Color {
  const wavelength = Math.max(380, Math.min(780, wavelengthNm));
  let red = 0; let green = 0; let blue = 0;
  if (wavelength < 440) { red = -(wavelength - 440) / 60; blue = 1; }
  else if (wavelength < 490) { green = (wavelength - 440) / 50; blue = 1; }
  else if (wavelength < 510) { green = 1; blue = -(wavelength - 510) / 20; }
  else if (wavelength < 580) { red = (wavelength - 510) / 70; green = 1; }
  else if (wavelength < 645) { red = 1; green = -(wavelength - 645) / 65; }
  else red = 1;
  return new THREE.Color(red, green, blue);
}

function applyComponentTransform(object: THREE.Object3D, transform: ReturnType<typeof resolveComponentTransform>): void {
  object.position.set(transform.positionMm.x, transform.positionMm.y, transform.positionMm.z);
  object.rotation.set(
    THREE.MathUtils.degToRad(transform.rotationDeg.x),
    THREE.MathUtils.degToRad(transform.rotationDeg.y),
    THREE.MathUtils.degToRad(transform.rotationDeg.z),
    'XYZ',
  );
}

function addSourceHousing(
  group: THREE.Group,
  design: CoherentAssemblyDesign,
  item: CoherentAssemblyDesign['components'][number],
  transform: ReturnType<typeof resolveComponentTransform>,
  width: number,
  height: number,
  depth: number,
): void {
  const housing = new THREE.Group();
  housing.name = `nonseq-${item.id}`;
  housing.userData = { type: 'nonSequentialComponent', componentId: item.id, componentKind: item.kind };
  applyComponentTransform(housing, transform);

  const radius = Math.max(0.15, Math.min(width, height) * 0.38);
  const endDepth = Math.min(depth * 0.18, Math.max(0.6, depth * 0.075));
  const collarDepth = Math.min(depth * 0.24, Math.max(0.8, depth * 0.14));
  const bodyDepth = Math.max(0.01, depth - collarDepth);
  const bodyGeometry = new THREE.CylinderGeometry(radius, radius, bodyDepth, 48);
  bodyGeometry.rotateX(Math.PI / 2);
  const body = new THREE.Mesh(
    bodyGeometry,
    new THREE.MeshPhongMaterial({ color: 0x0e7490, transparent: true, opacity: 0.78, shininess: 65, depthWrite: false }),
  );
  body.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(bodyGeometry, 28),
    new THREE.LineBasicMaterial({ color: 0x164e63, transparent: true, opacity: 0.92 }),
  ));
  body.position.z = -collarDepth / 2;
  housing.add(body);

  const capGeometry = new THREE.CylinderGeometry(radius * 1.04, radius * 1.04, endDepth, 48);
  capGeometry.rotateX(Math.PI / 2);
  const capMaterial = new THREE.MeshPhongMaterial({ color: 0x1e293b, shininess: 45 });
  const rearCap = new THREE.Mesh(capGeometry, capMaterial);
  rearCap.position.z = -depth / 2 + endDepth / 2;
  housing.add(rearCap);

  const collarGeometry = new THREE.CylinderGeometry(radius * 0.72, radius * 0.72, collarDepth, 40);
  collarGeometry.rotateX(Math.PI / 2);
  const collar = new THREE.Mesh(collarGeometry, new THREE.MeshPhongMaterial({ color: 0x334155, shininess: 70 }));
  collar.position.z = depth / 2 - collarDepth / 2;
  housing.add(collar);

  const apertureRadius = Math.max(0.08, Math.min(radius * 0.42, Number(item.dimensions.apertureDiameterMm ?? radius) * 0.5));
  const apertureGeometry = new THREE.CylinderGeometry(apertureRadius, apertureRadius, Math.max(0.04, depth * 0.006), 40);
  apertureGeometry.rotateX(Math.PI / 2);
  const aperture = new THREE.Mesh(
    apertureGeometry,
    new THREE.MeshBasicMaterial({ color: 0x07111f, side: THREE.DoubleSide }),
  );
  // The visible aperture and the traced source share the physical Emit plane.
  aperture.position.z = depth / 2;
  housing.add(aperture);
  const apertureRing = new THREE.Mesh(
    new THREE.TorusGeometry(apertureRadius * 1.16, Math.max(0.035, apertureRadius * 0.11), 10, 36),
    new THREE.MeshBasicMaterial({ color: 0x67e8f9 }),
  );
  apertureRing.position.z = depth / 2 + 0.01;
  housing.add(apertureRing);

  const sourceSpec = (design.sources ?? [design.source]).find((source) => (source.componentId ?? source.id) === item.id);
  const isFrequencyComb = sourceSpec?.kind === 'frequency-comb'
    || String(item.metadata?.blockType ?? '').toLowerCase().includes('frequencycomb');
  if (isFrequencyComb) {
    // Spectral rings distinguish a comb source without changing its physical
    // envelope or suggesting a fictitious optical surface.
    const colors = [0x7c3aed, 0x2563eb, 0x16a34a, 0xf59e0b, 0xdc2626];
    colors.forEach((color, index) => {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius * 1.018, Math.max(0.035, radius * 0.035), 8, 36),
        new THREE.MeshBasicMaterial({ color }),
      );
      ring.position.z = -depth * 0.26 + index * depth * 0.065;
      housing.add(ring);
    });
  }

  group.add(housing);
}

function addBeamSplitterHousing(
  group: THREE.Group,
  design: CoherentAssemblyDesign,
  item: CoherentAssemblyDesign['components'][number],
  transform: ReturnType<typeof resolveComponentTransform>,
  width: number,
  height: number,
  depth: number,
): void {
  const model = String(item.metadata?.beamSplitterModel ?? design.beamSplitter?.model ?? 'ideal').toLowerCase();
  const reflectionPort = String(item.metadata?.reflectionPort ?? design.beamSplitter?.reflectionPort ?? 'reflect').toLowerCase();
  const diagonalAngle = reflectionPort === 'recombine' ? Math.PI / 4 : -Math.PI / 4;
  const diagonalNormalLocal = reflectionPort === 'recombine'
    ? new THREE.Vector3(Math.SQRT1_2, 0, Math.SQRT1_2)
    : new THREE.Vector3(-Math.SQRT1_2, 0, Math.SQRT1_2);
  const housing = new THREE.Group();
  housing.name = `nonseq-${item.id}`;
  housing.userData = { type: 'nonSequentialComponent', componentId: item.id, componentKind: item.kind, beamSplitterModel: model };
  applyComponentTransform(housing, transform);

  const bodyColor = model === 'cube' ? 0x67a9d8 : 0x94a3b8;
  if (model !== 'ideal') {
    const bodyDepth = model === 'plate'
      ? Math.max(0.01, Number(item.metadata?.substrateThicknessMm) || depth)
      : depth;
    const geometry = new THREE.BoxGeometry(width, height, bodyDepth);
    const body = new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({
        color: bodyColor,
        transparent: true,
        opacity: model === 'cube' ? 0.24 : 0.18,
        side: THREE.DoubleSide,
        depthWrite: false,
        shininess: 75,
      }),
    );
    // A plate is physically tilted inside the external optical-axis frame.
    // Cube faces remain orthogonal to the four external beam ports.
    if (model === 'plate' || model === 'pellicle') body.rotation.y = diagonalAngle;
    if (model === 'plate') {
      // The component origin is the coated front surface. The substrate sits
      // behind it instead of straddling the optical interaction plane.
      body.position.copy(diagonalNormalLocal).multiplyScalar(bodyDepth * 0.5);
    }
    body.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.88 }),
    ));
    housing.add(body);
  }

  const splitterSpan = model === 'cube'
    ? Math.SQRT2 * Math.max(width, depth) * 0.98
    : width * 0.98;
  const splitterPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(splitterSpan, height * 0.96),
    new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: model === 'ideal' ? 0.45 : 0.34,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  // The diagonal follows reflectionPort; routed rays intersect this same plane
  // before either crossing it or reflecting by 90 degrees.
  splitterPlane.rotation.y = diagonalAngle;
  housing.add(splitterPlane);
  group.add(housing);
}

function addComponent(group: THREE.Group, design: CoherentAssemblyDesign, componentId: string): void {
  const item = design.components.find((entry) => entry.id === componentId);
  if (!item) return;
  // Exact sequential surfaces remain owned by the normal renderer.
  if (item.kind === 'sequential-group' || item.kind === 'lens' || item.kind === 'cylindrical-lens') return;
  const transform = resolveComponentTransform(item);
  const width = Math.max(0.01, Number(item.dimensions.widthMm) || 1);
  const height = Math.max(0.01, Number(item.dimensions.heightMm) || 1);
  const depth = Math.max(0.01, Number(item.dimensions.depthMm) || 0.2);
  const isDetector = item.kind === 'detector' || item.kind === 'time-detector';
  const isGrating = item.kind === 'reflection-grating';
  const isTarget = item.kind === 'target';
  const isSource = item.kind === 'source';
  if (isSource) {
    addSourceHousing(group, design, item, transform, width, height, depth);
    return;
  }
  if (item.kind === 'beam-splitter') {
    addBeamSplitterHousing(group, design, item, transform, width, height, depth);
    return;
  }
  const color = isDetector ? 0x16a34a : isGrating ? 0x8b5cf6 : isTarget ? 0xf59e0b : isSource ? 0x0891b2 : 0x64748b;
  const geometry: THREE.BufferGeometry = item.shape === 'cylinder'
    ? new THREE.CylinderGeometry(Math.min(width, height) / 2, Math.min(width, height) / 2, depth, 48)
    : new THREE.BoxGeometry(width, height, depth);
  if (geometry instanceof THREE.CylinderGeometry) geometry.rotateX(Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isDetector || isGrating ? 0.46 : 0.2, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `nonseq-${item.id}`;
  applyComponentTransform(mesh, transform);
  mesh.userData = { type: 'nonSequentialComponent', componentId: item.id, componentKind: item.kind };
  group.add(mesh);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  mesh.add(edge);
}

function addExactSequentialGroups(group: THREE.Group, design: CoherentAssemblyDesign): void {
  for (const sequence of design.blockSequences ?? []) {
    // Use the same boundary-row filtering as the exact tracer. The full block
    // expander adds synthetic Object/Image rows; drawing those rows placed the
    // visible lens at a different local Z than the surface where rays bent.
    const rows = expandSequentialGroupRows(Array.isArray(sequence.blocks) ? sequence.blocks as any[] : []);
    if (!rows.length) continue;
    const temporaryScene = new THREE.Scene();
    try {
      drawOpticalSystemSurfaces({
        scene: temporaryScene,
        opticalSystemData: rows,
        showSurfaceOrigins: false,
        showSemidiaRing: true,
        showMirrorBackText: false,
        showDesignIntentLabels: false,
        showPrincipalPointLabels: false,
        showSurfaceNumberLabels: false,
        surfaceMeshSegments: 40,
        toricMeshSegments: 72,
      });
    } catch (error) {
      console.warn(`[PortRouteRender] Could not draw ${sequence.label}:`, error);
      continue;
    }
    const container = new THREE.Group();
    container.name = `port-route-exact-${sequence.id}`;
    container.userData = { type: 'portRoutedExactGroup', sequenceId: sequence.id };
    applyComponentTransform(container, sequence.rootTransform);
    for (const child of [...temporaryScene.children]) container.add(child);
    group.add(container);
  }
}

function setBaseSequentialVisibility(scene: THREE.Scene, visible: boolean): void {
  scene.traverse((child: any) => {
    if (child?.parent?.name === GROUP_NAME || child?.name === GROUP_NAME) return;
    const optical = child?.userData?.isOpticalElement
      || child?.userData?.isLensSurface
      || child?.userData?.surfaceType === '3DSurface'
      || child?.userData?.isRayLine
      || child?.userData?.type === 'ray';
    if (!optical) return;
    if (!visible) {
      if (child.userData.__cooptPortRoutePreviousVisible === undefined) child.userData.__cooptPortRoutePreviousVisible = child.visible !== false;
      child.visible = false;
    } else if (child.userData.__cooptPortRoutePreviousVisible !== undefined) {
      child.visible = child.userData.__cooptPortRoutePreviousVisible;
      delete child.userData.__cooptPortRoutePreviousVisible;
    }
  });
}

const connectionColor = (tone: 'default' | 'transmit' | 'reflect' | 'detector'): number => {
  if (tone === 'transmit') return 0x2563eb;
  if (tone === 'reflect') return 0xd97706;
  if (tone === 'detector') return 0x16a34a;
  return 0x64748b;
};

function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.height = 80;
  let context = canvas.getContext('2d');
  if (context) {
    context.font = '600 34px system-ui, -apple-system, Segoe UI, sans-serif';
    canvas.width = Math.ceil(Math.min(238, Math.max(56, context.measureText(text).width + 28)));
    context = canvas.getContext('2d');
  }
  if (context) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = '600 34px system-ui, -apple-system, Segoe UI, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = 'rgba(255,255,255,0.92)';
    context.strokeStyle = 'rgba(148,163,184,0.72)';
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(1, 10, canvas.width - 2, 60, 17);
    context.fill();
    context.stroke();
    context.fillStyle = color;
    context.fillText(text, canvas.width / 2, canvas.height / 2 + 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  // Match the small XYZ orientation labels. Port text stays the same screen
  // size while zooming; only its marker remains world-sized for selection.
  const screenHeightPx = 32;
  const screenWidthPx = screenHeightPx * canvas.width / canvas.height;
  sprite.userData = { screenWidthPx, screenHeightPx };
  sprite.onBeforeRender = (renderer, _scene, camera) => {
    const viewportHeightPx = Number(renderer.domElement?.clientHeight)
      || Number(renderer.domElement?.height)
      || 1;
    const basePosition = sprite.userData.basePositionMm as THREE.Vector3 | undefined;
    const scaleProbe = basePosition ?? sprite.getWorldPosition(new THREE.Vector3());
    let worldUnitsPerPixel = 1;
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const ortho = camera as THREE.OrthographicCamera;
      worldUnitsPerPixel = Math.abs(ortho.top - ortho.bottom) / Math.max(1e-12, Math.abs(ortho.zoom || 1)) / viewportHeightPx;
    } else if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const perspective = camera as THREE.PerspectiveCamera;
      const cameraSpacePosition = scaleProbe.clone().applyMatrix4(camera.matrixWorldInverse);
      const distance = Math.max(1e-12, Math.abs(cameraSpacePosition.z));
      worldUnitsPerPixel = 2 * distance * Math.tan(THREE.MathUtils.degToRad(perspective.fov || 50) * 0.5) / viewportHeightPx;
    }
    if (basePosition) {
      const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      sprite.position.copy(basePosition)
        .addScaledVector(cameraRight, Number(sprite.userData.screenOffsetXPx ?? 0) * worldUnitsPerPixel)
        .addScaledVector(cameraUp, Number(sprite.userData.screenOffsetYPx ?? 0) * worldUnitsPerPixel);
    }
    sprite.scale.set(screenWidthPx * worldUnitsPerPixel, screenHeightPx * worldUnitsPerPixel, 1);
  };
  sprite.renderOrder = 62;
  return sprite;
}

function overlayScale(design: CoherentAssemblyDesign): number {
  const positions = design.components.map((component) => resolveComponentTransform(component).positionMm);
  if (positions.length < 2) return 20;
  const xs = positions.map((position) => position.x);
  const ys = positions.map((position) => position.y);
  const zs = positions.map((position) => position.z);
  return Math.max(
    20,
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    Math.max(...zs) - Math.min(...zs),
  );
}

function addConnectionOverlay(group: THREE.Group, design: CoherentAssemblyDesign, selectedConnectionId?: string | null, selectedRouteId?: string | null): void {
  const model = buildCoherentRenderConnectionOverlay(design);
  const selectedRoute = (design.portRoutes ?? []).find((route) => route.id === selectedRouteId);
  const routeSteps = new Map<string, Array<{ number: number; direction: 'forward' | 'reverse' }>>();
  selectedRoute?.steps.forEach((step, index) => {
    const entries = routeSteps.get(step.connectionId) ?? [];
    entries.push({ number: index + 1, direction: step.direction });
    routeSteps.set(step.connectionId, entries);
  });
  const span = overlayScale(design);
  // Port symbols are navigation controls, not physical geometry. Keep them
  // deliberately larger than a ray so connections remain legible after Fit.
  const markerRadius = Math.max(0.65, Math.min(3.2, span * 0.009));
  const connectionGroup = new THREE.Group();
  connectionGroup.name = CONNECTION_GROUP_NAME;
  connectionGroup.userData = { type: 'designConnectionGroup', pointerThresholdMm: markerRadius * 3.5 };
  const portTone = new Map<string, number>();
  const selectedConnectionPorts = new Set<string>();

  for (const connection of model.connections) {
    const selectedSteps = routeSteps.get(connection.id) ?? [];
    const selectedByRoute = selectedSteps.length > 0;
    const color = selectedByRoute
      ? (selectedSteps.some((step) => step.direction === 'reverse') ? 0xdb2777 : 0x0284c7)
      : connectionColor(connection.tone);
    portTone.set(`${connection.fromComponentId}:${connection.fromPortId}`, color);
    portTone.set(`${connection.toComponentId}:${connection.toPortId}`, color);
    if (connection.id === selectedConnectionId) {
      selectedConnectionPorts.add(`${connection.fromComponentId}:${connection.fromPortId}`);
      selectedConnectionPorts.add(`${connection.toComponentId}:${connection.toPortId}`);
    }
    const start = new THREE.Vector3(connection.startMm.x, connection.startMm.y, connection.startMm.z);
    const end = new THREE.Vector3(connection.endMm.x, connection.endMm.y, connection.endMm.z);
    const delta = end.clone().sub(start);
    const length = delta.length();
    if (length <= 1e-8) {
      if (selectedByRoute) {
        const passLabel = makeLabelSprite(
          selectedSteps.map((step) => `${step.number}${step.direction === 'reverse' ? 'R' : 'F'}`).join(' · '),
          selectedSteps.some((step) => step.direction === 'reverse') ? '#be185d' : '#0369a1',
        );
        passLabel.position.copy(start);
        passLabel.userData = {
          ...passLabel.userData,
          type: 'opticalRoutePassLabel',
          routeId: selectedRouteId,
          connectionId: connection.id,
          basePositionMm: start.clone(),
          screenOffsetXPx: 0,
          screenOffsetYPx: -22,
        };
        connectionGroup.add(passLabel);
      }
      continue;
    }
    const selected = selectedConnectionId === connection.id || selectedByRoute;
    const material = new THREE.LineDashedMaterial({
      color,
      dashSize: Math.max(markerRadius * 2.8, Math.min(7, length * 0.1)),
      gapSize: Math.max(markerRadius * 1.35, Math.min(3.5, length * 0.04)),
      transparent: true,
      opacity: selected ? 1 : (selectedRoute ? 0.28 : 0.82),
      depthTest: false,
      depthWrite: false,
    });
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([start, end]), material);
    line.computeLineDistances();
    line.renderOrder = 58;
    line.userData = {
      type: 'designConnectionOverlay',
      connectionId: connection.id,
      fromComponentId: connection.fromComponentId,
      toComponentId: connection.toComponentId,
      baseOpacity: selected ? 1 : (selectedRoute ? 0.28 : 0.82),
      tooltip: `${connection.fromComponentLabel} ${connection.fromPortLabel} → ${connection.toComponentLabel} ${connection.toPortLabel} · ${connection.distanceMm.toFixed(2)} mm · ${connection.pathId}`,
    };
    connectionGroup.add(line);

    const direction = delta.clone().normalize();
    const arrowLength = Math.max(markerRadius * 3.2, Math.min(8, length * 0.16));
    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(markerRadius * 1.35, arrowLength, 18),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: selected ? 1 : 0.82, depthTest: false, depthWrite: false }),
    );
    arrow.position.copy(start).lerp(end, 0.7);
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    arrow.renderOrder = 59;
    arrow.userData = { ...line.userData, baseOpacity: 0.82 };
    connectionGroup.add(arrow);
    if (selectedByRoute) {
      const passLabel = makeLabelSprite(
        selectedSteps.map((step) => `${step.number}${step.direction === 'reverse' ? 'R' : 'F'}`).join(' · '),
        selectedSteps.some((step) => step.direction === 'reverse') ? '#be185d' : '#0369a1',
      );
      passLabel.position.copy(start).lerp(end, 0.45);
      passLabel.userData = {
        ...passLabel.userData,
        type: 'opticalRoutePassLabel',
        routeId: selectedRouteId,
        connectionId: connection.id,
        basePositionMm: passLabel.position.clone(),
        screenOffsetXPx: 0,
        screenOffsetYPx: -22,
      };
      connectionGroup.add(passLabel);
    }
  }

  for (const port of model.ports) {
    const color = port.connected ? (portTone.get(port.id) ?? 0x475569) : 0xdc2626;
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(markerRadius, 18, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: port.connected ? 0.9 : 1, depthTest: false, depthWrite: false }),
    );
    marker.position.set(port.positionMm.x, port.positionMm.y, port.positionMm.z);
    marker.renderOrder = 60;
    marker.userData = {
      type: 'designPortOverlay',
      componentId: port.componentId,
      portId: port.portId,
      baseOpacity: port.connected ? 0.9 : 1,
      tooltip: `${port.componentLabel} · ${port.label}${port.connected ? '' : ' · Unconnected'}`,
    };
    connectionGroup.add(marker);

    // Connected port names are available as hover tooltips. Showing every
    // FRONT/BACK/IN/OUT label at once makes a routed assembly unreadable,
    // especially where a physical component and a Sequential Group meet.
    // Keep labels only for a selected connection and for ports that still need
    // wiring; route order is already indicated by the numbered pass labels.
    if (port.connected && !selectedConnectionPorts.has(port.id)) continue;
    const label = makeLabelSprite(port.label, port.connected ? '#334155' : '#b91c1c');
    const inputSide = ['in', 'input', 'common', 'detect'].includes(String(port.portId).toLowerCase());
    const labelHalfWidthPx = Number(label.userData.screenWidthPx ?? 24) * 0.5;
    label.position.copy(marker.position);
    label.userData = {
      ...label.userData,
      ...marker.userData,
      type: 'designPortLabel',
      basePositionMm: marker.position.clone(),
      // Put the label beside the marker, leaving the marker itself fully
      // visible. Co-located sequential IN and source OUT labels naturally
      // separate to opposite sides of the same launch point.
      screenOffsetXPx: (inputSide ? -1 : 1) * (labelHalfWidthPx + 10),
      screenOffsetYPx: 0,
    };
    connectionGroup.add(label);
  }
  group.add(connectionGroup);
}

function fitCameraToAssembly(group: THREE.Group): void {
  const camera = (window as any).camera ?? (typeof (window as any).getCamera === 'function' ? (window as any).getCamera() : null);
  const controls = (window as any).controls ?? (typeof (window as any).getControls === 'function' ? (window as any).getControls() : null);
  const renderer = (window as any).renderer ?? (typeof (window as any).getRenderer === 'function' ? (window as any).getRenderer() : null);
  if (!camera || !controls || !renderer) return;
  const box = new THREE.Box3().setFromObject(group);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const diagonal = Math.max(10, box.getSize(new THREE.Vector3()).length());
  const distance = Math.max(diagonal * 1.6, Number(camera.position?.distanceTo?.(controls.target)) || 0);
  // Hybrid assemblies are authored primarily in the X-Z bench plane. View
  // that plane from +Y, with world X as screen-up, so world Z remains
  // horizontal while split/return arms stay visibly separated.
  const viewDirection = new THREE.Vector3(0, -1, 0);
  camera.up.set(1, 0, 0);
  camera.position.copy(center).addScaledVector(viewDirection, -distance);
  controls.target.copy(center);
  camera.lookAt(center);
  controls.update?.();
  camera.updateMatrixWorld?.(true);
  const corners: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
    }
  }
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
  let halfWidth = 1;
  let halfHeight = 1;
  for (const corner of corners) {
    const offset = corner.sub(center);
    halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
    halfHeight = Math.max(halfHeight, Math.abs(offset.dot(up)));
  }
  const canvas = renderer.domElement as HTMLCanvasElement | undefined;
  const aspect = Math.max(0.2, (canvas?.clientWidth || 1) / Math.max(1, canvas?.clientHeight || 1));
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const ortho = camera as THREE.OrthographicCamera;
    const fitHeight = Math.max(halfHeight * 2, halfWidth * 2 / aspect) * 1.18;
    ortho.left = -fitHeight * aspect / 2;
    ortho.right = fitHeight * aspect / 2;
    ortho.top = fitHeight / 2;
    ortho.bottom = -fitHeight / 2;
    ortho.zoom = 1;
    ortho.updateProjectionMatrix();
  }
  controls.update?.();
}

export function drawNonSequentialOverlay(scene: THREE.Scene, payload: OverlayPayload, options: OverlayDrawOptions = {}): void {
  const previous = scene.getObjectByName(GROUP_NAME);
  if (previous) { scene.remove(previous); disposeObject(previous); }
  const group = new THREE.Group();
  group.name = GROUP_NAME;
  group.userData = { type: 'nonSequentialAssembly', revision: payload.revision };
  const enabledRoutes = (payload.design.portRoutes ?? []).filter((route) => route.enabled !== false);
  const effectiveSelectedRouteId = enabledRoutes.some((route) => route.id === options.selectedRouteId)
    ? options.selectedRouteId
    : enabledRoutes.length === 1 ? enabledRoutes[0].id : null;
  const portRouted = enabledRoutes.length > 0;
  const hasRoutedRaySegments = portRouted && (payload.result?.segments.length ?? 0) > 0;
  // Do not blank Render while a Port trace is pending, failed, or produced no
  // usable segments.  Replace the legacy rays only after routed rays exist.
  setBaseSequentialVisibility(scene, !hasRoutedRaySegments);
  if (portRouted) addExactSequentialGroups(group, payload.design);
  for (const segment of payload.result?.segments ?? []) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(segment.startMm.x, segment.startMm.y, segment.startMm.z),
      new THREE.Vector3(segment.endMm.x, segment.endMm.y, segment.endMm.z),
    ]);
    const opacity = Math.max(0.12, Math.min(1, Math.sqrt(segment.powerW / Math.max(payload.result?.energy.emittedPowerW ?? 0, 1e-30))));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: wavelengthColor(segment.wavelengthNm), transparent: true, opacity }));
    line.userData = { type: 'nonSequentialRay', rayId: segment.rayId, history: segment.history };
    group.add(line);
  }
  for (const item of payload.design.components) addComponent(group, payload.design, item.id);
  if (options.showConnections !== false) addConnectionOverlay(group, payload.design, options.selectedConnectionId, effectiveSelectedRouteId);
  scene.add(group);
  const renderer = (window as any).renderer ?? (typeof (window as any).getRenderer === 'function' ? (window as any).getRenderer() : null);
  const camera = (window as any).camera ?? (typeof (window as any).getCamera === 'function' ? (window as any).getCamera() : null);
  if (options.fitAssembly) fitCameraToAssembly(group);
  try { renderer?.render?.(scene, camera); } catch (_) {}
}

export function hasRenderableNonSequentialContent(design: CoherentAssemblyDesign): boolean {
  const components = Array.isArray(design?.components) ? design.components : [];
  const sourceIds = new Set(
    (Array.isArray(design?.sources) && design.sources.length > 0 ? design.sources : [design?.source])
      .map((source) => String(source?.componentId ?? source?.id ?? ''))
      .filter(Boolean),
  );
  const hasPhysicalSource = components.some((item) => item.kind === 'source' && sourceIds.has(String(item.id)));
  const hasTraceableSurface = components.some((item) => {
    if (item.kind === 'source' || item.kind === 'sequential-group') return false;
    if ((item.kind === 'lens' || item.kind === 'cylindrical-lens') && (
      item.metadata?.source === 'design-intent' || item.metadata?.source === 'blocks-reference'
    )) return false;
    return true;
  });
  return hasPhysicalSource && hasTraceableSurface;
}
function activeScene(): THREE.Scene | null {
  const scene = (window as any).scene ?? (typeof (window as any).getScene === 'function' ? (window as any).getScene() : null);
  return scene?.isScene ? scene as THREE.Scene : null;
}

function publishPortRoutedRenderStatus(detail: PortRoutedRenderStatusDetail): void {
  try { window.dispatchEvent(new CustomEvent(PORT_ROUTED_RENDER_STATUS_EVENT, { detail })); } catch (_) {}
  try {
    const hostWindow = window.parent && window.parent !== window ? window.parent : null;
    hostWindow?.dispatchEvent(new CustomEvent(PORT_ROUTED_RENDER_STATUS_EVENT, { detail }));
  } catch (_) {}
}

function clearNonSequentialOverlay(): void {
  const scene = activeScene();
  if (!scene) return;
  const previous = scene.getObjectByName(GROUP_NAME);
  setBaseSequentialVisibility(scene, true);
  if (!previous) return;
  scene.remove(previous);
  disposeObject(previous);
  const renderer = (window as any).renderer ?? (typeof (window as any).getRenderer === 'function' ? (window as any).getRenderer() : null);
  const camera = (window as any).camera ?? (typeof (window as any).getCamera === 'function' ? (window as any).getCamera() : null);
  try { renderer?.render?.(scene, camera); } catch (_) {}
}

export function installNonSequentialRenderOverlay(): () => void {
  const runtimeWindow = window as any;
  // Vite Fast Refresh can replace this module while the Render iframe stays
  // alive. Ensure an older overlay cannot keep tracing a stale Config and
  // overwrite the current three-route result with duplicate/obsolete routes.
  try { runtimeWindow.__cooptDisposeNonSequentialRenderOverlay?.(); } catch (_) {}
  let disposed = false;
  let latestPayload: OverlayPayload | null = null;
  let drawTimer: number | null = null;
  let traceTimer: number | null = null;
  let traceToken = 0;
  let showConnections = (() => {
    try { return localStorage.getItem(RENDER_CONNECTIONS_STORAGE_KEY) !== 'false'; } catch (_) { return true; }
  })();
  let selectedConnectionId: string | null = null;
  let selectedRouteId: string | null = (() => {
    try { return localStorage.getItem(RENDER_SELECTED_ROUTE_STORAGE_KEY); } catch (_) { return null; }
  })();
  let hoveredConnectionId: string | null = null;
  let lastAssemblyFitKey: string | null = null;
  let boundCanvas: HTMLCanvasElement | null = null;
  let tooltip: HTMLDivElement | null = null;

  const renderScene = () => {
    const scene = activeScene();
    const renderer = (window as any).renderer ?? (typeof (window as any).getRenderer === 'function' ? (window as any).getRenderer() : null);
    const camera = (window as any).camera ?? (typeof (window as any).getCamera === 'function' ? (window as any).getCamera() : null);
    try { renderer?.render?.(scene, camera); } catch (_) {}
  };

  const updateSelectionStyles = () => {
    const connectionGroup = activeScene()?.getObjectByName(CONNECTION_GROUP_NAME);
    if (!connectionGroup) return;
    connectionGroup.traverse((object: any) => {
      const connectionId = String(object?.userData?.connectionId ?? '');
      if (!connectionId || !object.material) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const active = connectionId === hoveredConnectionId || connectionId === selectedConnectionId;
      const dimmed = !!selectedConnectionId && connectionId !== selectedConnectionId;
      materials.forEach((material: any) => {
        material.opacity = active ? 1 : dimmed ? Math.min(0.3, Number(object.userData.baseOpacity ?? 0.64)) : Number(object.userData.baseOpacity ?? 0.64);
        material.needsUpdate = true;
      });
    });
    renderScene();
  };

  const hideTooltip = () => {
    if (tooltip) tooltip.style.display = 'none';
  };

  const hitAt = (event: PointerEvent): THREE.Intersection | null => {
    if (!boundCanvas || !showConnections) return null;
    const scene = activeScene();
    const camera = (window as any).camera ?? (typeof (window as any).getCamera === 'function' ? (window as any).getCamera() : null);
    const group = scene?.getObjectByName(CONNECTION_GROUP_NAME);
    if (!group || !camera) return null;
    const rect = boundCanvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: Number(group.userData.pointerThresholdMm ?? 1) };
    raycaster.setFromCamera(pointer, camera);
    return raycaster.intersectObject(group, true).find((intersection) => {
      const type = String(intersection.object?.userData?.type ?? '');
      return type === 'designConnectionOverlay' || type === 'designPortOverlay' || type === 'designPortLabel';
    }) ?? null;
  };

  const handlePointerMove = (event: PointerEvent) => {
    const hit = hitAt(event);
    const userData = hit?.object?.userData;
    const nextHovered = userData?.connectionId ? String(userData.connectionId) : null;
    if (nextHovered !== hoveredConnectionId) {
      hoveredConnectionId = nextHovered;
      updateSelectionStyles();
    }
    if (!boundCanvas) return;
    boundCanvas.style.cursor = hit ? 'pointer' : '';
    if (!hit || !userData?.tooltip) { hideTooltip(); return; }
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'render-connection-tooltip';
      Object.assign(tooltip.style, {
        position: 'fixed', zIndex: '100000', pointerEvents: 'none', maxWidth: '360px',
        padding: '6px 9px', borderRadius: '6px', border: '1px solid rgba(148,163,184,.65)',
        background: 'rgba(255,255,255,.96)', color: '#172033', boxShadow: '0 6px 18px rgba(15,23,42,.16)',
        font: '12px/1.35 system-ui, -apple-system, Segoe UI, sans-serif', whiteSpace: 'nowrap',
      });
      document.body.appendChild(tooltip);
    }
    tooltip.textContent = String(userData.tooltip);
    tooltip.style.left = `${event.clientX + 14}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    tooltip.style.display = 'block';
  };

  const handlePointerLeave = () => {
    hoveredConnectionId = null;
    if (boundCanvas) boundCanvas.style.cursor = '';
    hideTooltip();
    updateSelectionStyles();
  };

  const handleClick = (event: MouseEvent) => {
    const hit = hitAt(event as PointerEvent);
    const userData = hit?.object?.userData;
    if (!userData?.connectionId) return;
    selectedConnectionId = String(userData.connectionId);
    updateSelectionStyles();
    const detail = {
      connectionId: selectedConnectionId,
      fromComponentId: userData.fromComponentId,
      toComponentId: userData.toComponentId,
    };
    const hostWindow = (() => {
      try { return window.parent && window.parent !== window ? window.parent : window; } catch (_) { return window; }
    })();
    try { (hostWindow as any).__cooptOpenDesignConnection?.(detail); } catch (_) {}
    window.dispatchEvent(new CustomEvent(DESIGN_CONNECTION_SELECTED_EVENT, { detail }));
    if (hostWindow !== window) {
      try { hostWindow.dispatchEvent(new CustomEvent(DESIGN_CONNECTION_SELECTED_EVENT, { detail })); } catch (_) {}
    }
  };

  const bindInteraction = () => {
    const renderer = (window as any).renderer ?? (typeof (window as any).getRenderer === 'function' ? (window as any).getRenderer() : null);
    const canvas = renderer?.domElement instanceof HTMLCanvasElement ? renderer.domElement : null;
    if (canvas === boundCanvas) return;
    if (boundCanvas) {
      boundCanvas.removeEventListener('pointermove', handlePointerMove);
      boundCanvas.removeEventListener('pointerleave', handlePointerLeave);
      boundCanvas.removeEventListener('click', handleClick);
    }
    boundCanvas = canvas;
    if (boundCanvas) {
      boundCanvas.addEventListener('pointermove', handlePointerMove);
      boundCanvas.addEventListener('pointerleave', handlePointerLeave);
      boundCanvas.addEventListener('click', handleClick);
    }
  };

  const scheduleDraw = (attempt = 0) => {
    if (disposed) return;
    if (drawTimer !== null) window.clearTimeout(drawTimer);
    drawTimer = window.setTimeout(() => {
      drawTimer = null;
      if (!latestPayload) { clearNonSequentialOverlay(); return; }
      const scene = activeScene();
      if (!scene) {
        if (attempt < 80) scheduleDraw(attempt + 1);
        return;
      }
      // Port-routed Render hides the legacy sequential chain, so its first
      // completed trace owns framing for the whole physical assembly.
      const fitKey = latestPayload.result
        ? `${latestPayload.revision}|${latestPayload.design.components.map((component) => {
            const transform = resolveComponentTransform(component);
            return `${component.id}:${transform.positionMm.x},${transform.positionMm.y},${transform.positionMm.z}:${transform.rotationDeg.x},${transform.rotationDeg.y},${transform.rotationDeg.z}`;
          }).join('|')}`
        : null;
      drawNonSequentialOverlay(scene, latestPayload, {
        showConnections,
        selectedConnectionId,
        selectedRouteId,
        fitAssembly: !!fitKey && fitKey !== lastAssemblyFitKey,
      });
      if (fitKey) lastAssemblyFitKey = fitKey;
      const enabledRoutes = (latestPayload.design.portRoutes ?? []).filter((route) => route.enabled !== false);
      const drawableRayCount = latestPayload.result
        ? new Set(latestPayload.result.segments.map((segment) => segment.rayId)).size
        : 0;
      publishPortRoutedRenderStatus({
        active: enabledRoutes.length > 0,
        state: latestPayload.result ? 'ready' : 'tracing',
        rayCount: drawableRayCount,
        routeCount: enabledRoutes.length,
      });
      bindInteraction();
    }, attempt === 0 ? 0 : 75);
  };

  const deliver = (payload: OverlayPayload) => {
    if (!payload?.design) return;
    if (selectedConnectionId && !payload.design.connections.some((connection) => connection.id === selectedConnectionId)) {
      selectedConnectionId = null;
    }
    const hasConnections = Array.isArray(payload.design.connections) && payload.design.connections.length > 0;
    const hasPhysicalComponents = Array.isArray(payload.design.components)
      && payload.design.components.some((component) => component.kind !== 'sequential-group');
    if (!hasRenderableNonSequentialContent(payload.design) && !hasConnections && !hasPhysicalComponents) {
      latestPayload = null;
      publishPortRoutedRenderStatus({ active: false, state: 'idle', rayCount: 0, routeCount: 0 });
      scheduleDraw();
      return;
    }
    latestPayload = payload;
    scheduleDraw();
  };

  const scheduleTrace = (snapshot: ActiveCoherentDesignSnapshot, delayMs = 40) => {
    traceToken += 1;
    const token = traceToken;
    if (traceTimer !== null) window.clearTimeout(traceTimer);
    if (selectedConnectionId && !snapshot.design.connections.some((connection) => connection.id === selectedConnectionId)) {
      selectedConnectionId = null;
    }
    // Draw the intended connections immediately. A subsequent physical trace
    // adds solid ray segments without making the layout overlay wait.
    latestPayload = { result: null, design: snapshot.design, revision: snapshot.design.revision ?? 0 };
    const enabledRouteCount = (snapshot.design.portRoutes ?? []).filter((route) => route.enabled !== false).length;
    publishPortRoutedRenderStatus({
      active: enabledRouteCount > 0,
      state: enabledRouteCount > 0 ? 'tracing' : 'idle',
      rayCount: 0,
      routeCount: enabledRouteCount,
    });
    scheduleDraw();
    if (!hasRenderableNonSequentialContent(snapshot.design)) {
      traceTimer = null;
      return;
    }
    traceTimer = window.setTimeout(() => {
      traceTimer = null;
      const activeConfiguration = readActiveConfiguration();
      const savedRoutes = activeConfiguration?.portRoutes ?? snapshot.design.portRoutes ?? [];
      const tracePromise = activeConfiguration && savedRoutes.some((route) => route.enabled !== false)
        ? runPortRoutedTrace(activeConfiguration, {
          samplePurpose: 'render',
          spectralSamples: 3,
          renderRayLimit: snapshot.design.traceSettings?.renderSegmentLimit ?? 12000,
        }).then(adaptPortRoutedRenderResult)
        : runNonSequentialTrace(snapshot.design, 'preview');
      void tracePromise.then((result) => {
        if (disposed || token !== traceToken) return;
        deliver({ result, design: snapshot.design, revision: snapshot.design.revision ?? 0 });
      }).catch((error) => {
        if (token !== traceToken) return;
        console.error('[NonSequentialRender] Preview trace failed:', error);
        publishPortRoutedRenderStatus({
          active: enabledRouteCount > 0,
          state: 'error',
          rayCount: 0,
          routeCount: enabledRouteCount,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
  };
  const domListener = (event: Event) => deliver((event as CustomEvent<OverlayPayload>).detail);
  const redrawListener = () => {
    // The base Render redraw restores its sequential camera. Re-fit the hybrid
    // X-Z bench plane afterwards so sections downstream of fold mirrors remain
    // visibly folded instead of collapsing onto the original straight axis.
    lastAssemblyFitKey = null;
    scheduleDraw();
  };
  const visibilityListener = (event: Event) => {
    const detail = (event as CustomEvent<{ visible?: boolean }>).detail;
    showConnections = detail?.visible !== false;
    if (!showConnections) {
      hoveredConnectionId = null;
      hideTooltip();
    }
    scheduleDraw();
  };
  const routeSelectionListener = (event: Event) => {
    const detail = (event as CustomEvent<{ routeId?: string | null }>).detail;
    selectedRouteId = detail?.routeId ? String(detail.routeId) : null;
    try {
      if (selectedRouteId) localStorage.setItem(RENDER_SELECTED_ROUTE_STORAGE_KEY, selectedRouteId);
      else localStorage.removeItem(RENDER_SELECTED_ROUTE_STORAGE_KEY);
    } catch (_) {}
    selectedConnectionId = null;
    scheduleDraw();
  };
  window.addEventListener('coopt:nonsequential-trace-updated', domListener);
  window.addEventListener('coopt:render-redraw-complete', redrawListener);
  window.addEventListener(RENDER_CONNECTIONS_VISIBILITY_EVENT, visibilityListener);
  window.addEventListener(OPTICAL_ROUTE_SELECTED_EVENT, routeSelectionListener);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(NONSEQUENTIAL_TRACE_CHANNEL) : null;
  if (channel) channel.onmessage = (event) => deliver(event.data as OverlayPayload);
  const unsubscribeDesign = subscribeActiveCoherentDesign((snapshot) => scheduleTrace(snapshot));
  scheduleTrace(readActiveCoherentDesign(), 0);
  const disposeOverlay = () => {
    if (disposed) return;
    disposed = true;
    traceToken += 1;
    if (drawTimer !== null) window.clearTimeout(drawTimer);
    if (traceTimer !== null) window.clearTimeout(traceTimer);
    window.removeEventListener('coopt:nonsequential-trace-updated', domListener);
    window.removeEventListener('coopt:render-redraw-complete', redrawListener);
    window.removeEventListener(RENDER_CONNECTIONS_VISIBILITY_EVENT, visibilityListener);
    window.removeEventListener(OPTICAL_ROUTE_SELECTED_EVENT, routeSelectionListener);
    if (boundCanvas) {
      boundCanvas.removeEventListener('pointermove', handlePointerMove);
      boundCanvas.removeEventListener('pointerleave', handlePointerLeave);
      boundCanvas.removeEventListener('click', handleClick);
      boundCanvas.style.cursor = '';
    }
    tooltip?.remove();
    clearNonSequentialOverlay();
    unsubscribeDesign();
    channel?.close();
    if (runtimeWindow.__cooptDisposeNonSequentialRenderOverlay === disposeOverlay) {
      try { delete runtimeWindow.__cooptDisposeNonSequentialRenderOverlay; } catch (_) {
        runtimeWindow.__cooptDisposeNonSequentialRenderOverlay = undefined;
      }
    }
  };
  runtimeWindow.__cooptDisposeNonSequentialRenderOverlay = disposeOverlay;
  return disposeOverlay;
}
