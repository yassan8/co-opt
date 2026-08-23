import * as THREE from 'three';
import { resolveComponentTransform, type CoherentAssemblyDesign } from '../../analysis/coherent-assembly.ts';
import { NONSEQUENTIAL_TRACE_CHANNEL, runNonSequentialTrace, type NonSequentialTraceResult } from '../../analysis/nonsequential-trace.ts';
import { readActiveCoherentDesign, subscribeActiveCoherentDesign, type ActiveCoherentDesignSnapshot } from '../../data/coherent-config-store.ts';

const GROUP_NAME = 'coopt-non-sequential-assembly';

interface OverlayPayload {
  result: NonSequentialTraceResult;
  design: CoherentAssemblyDesign;
  revision: number;
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((material) => material.dispose());
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

function addComponent(group: THREE.Group, design: CoherentAssemblyDesign, componentId: string): void {
  const item = design.components.find((entry) => entry.id === componentId);
  if (!item) return;
  // Exact sequential surfaces remain owned by the normal renderer.
  if (item.kind === 'sequential-group' || item.kind === 'lens' || item.kind === 'cylindrical-lens') return;
  if (item.metadata?.source === 'design-intent' || item.metadata?.source === 'blocks-reference') return;
  const transform = resolveComponentTransform(item);
  const width = Math.max(0.01, Number(item.dimensions.widthMm) || 1);
  const height = Math.max(0.01, Number(item.dimensions.heightMm) || 1);
  const depth = Math.max(0.01, Number(item.dimensions.depthMm) || 0.2);
  const isDetector = item.kind === 'detector' || item.kind === 'time-detector';
  const isGrating = item.kind === 'reflection-grating';
  const isTarget = item.kind === 'target';
  const isSource = item.kind === 'source';
  const color = isDetector ? 0x16a34a : isGrating ? 0x8b5cf6 : isTarget ? 0xf59e0b : isSource ? 0x0891b2 : 0x64748b;
  const geometry: THREE.BufferGeometry = item.shape === 'cylinder'
    ? new THREE.CylinderGeometry(Math.min(width, height) / 2, Math.min(width, height) / 2, depth, 48)
    : new THREE.BoxGeometry(width, height, depth);
  if (geometry instanceof THREE.CylinderGeometry) geometry.rotateX(Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isDetector || isGrating ? 0.46 : 0.2, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `nonseq-${item.id}`;
  mesh.position.set(transform.positionMm.x, transform.positionMm.y, transform.positionMm.z);
  mesh.rotation.set(
    THREE.MathUtils.degToRad(transform.rotationDeg.x),
    THREE.MathUtils.degToRad(transform.rotationDeg.y),
    THREE.MathUtils.degToRad(transform.rotationDeg.z),
    'XYZ',
  );
  mesh.userData = { type: 'nonSequentialComponent', componentId: item.id, componentKind: item.kind };
  group.add(mesh);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  mesh.add(edge);
}

export function drawNonSequentialOverlay(scene: THREE.Scene, payload: OverlayPayload): void {
  const previous = scene.getObjectByName(GROUP_NAME);
  if (previous) { scene.remove(previous); disposeObject(previous); }
  const group = new THREE.Group();
  group.name = GROUP_NAME;
  group.userData = { type: 'nonSequentialAssembly', revision: payload.revision };
  for (const segment of payload.result.segments) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(segment.startMm.x, segment.startMm.y, segment.startMm.z),
      new THREE.Vector3(segment.endMm.x, segment.endMm.y, segment.endMm.z),
    ]);
    const opacity = Math.max(0.12, Math.min(1, Math.sqrt(segment.powerW / Math.max(payload.result.energy.emittedPowerW, 1e-30))));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: wavelengthColor(segment.wavelengthNm), transparent: true, opacity }));
    line.userData = { type: 'nonSequentialRay', rayId: segment.rayId, history: segment.history };
    group.add(line);
  }
  for (const item of payload.design.components) addComponent(group, payload.design, item.id);
  scene.add(group);
  const renderer = (window as any).renderer ?? (typeof (window as any).getRenderer === 'function' ? (window as any).getRenderer() : null);
  const camera = (window as any).camera ?? (typeof (window as any).getCamera === 'function' ? (window as any).getCamera() : null);
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

function clearNonSequentialOverlay(): void {
  const scene = activeScene();
  if (!scene) return;
  const previous = scene.getObjectByName(GROUP_NAME);
  if (!previous) return;
  scene.remove(previous);
  disposeObject(previous);
  const renderer = (window as any).renderer ?? (typeof (window as any).getRenderer === 'function' ? (window as any).getRenderer() : null);
  const camera = (window as any).camera ?? (typeof (window as any).getCamera === 'function' ? (window as any).getCamera() : null);
  try { renderer?.render?.(scene, camera); } catch (_) {}
}

export function installNonSequentialRenderOverlay(): () => void {
  let disposed = false;
  let latestPayload: OverlayPayload | null = null;
  let drawTimer: number | null = null;
  let traceTimer: number | null = null;
  let traceToken = 0;

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
      // The normal Render view owns camera framing. Fitting only this overlay
      // can push already-drawn sequential rays out of view.
      drawNonSequentialOverlay(scene, latestPayload);
    }, attempt === 0 ? 0 : 75);
  };

  const deliver = (payload: OverlayPayload) => {
    if (!payload?.result || !payload?.design) return;
    if (!hasRenderableNonSequentialContent(payload.design)) {
      latestPayload = null;
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
    if (!hasRenderableNonSequentialContent(snapshot.design)) {
      traceTimer = null;
      latestPayload = null;
      scheduleDraw();
      return;
    }
    traceTimer = window.setTimeout(() => {
      traceTimer = null;
      void runNonSequentialTrace(snapshot.design, 'preview').then((result) => {
        if (disposed || token !== traceToken) return;
        deliver({ result, design: snapshot.design, revision: snapshot.design.revision ?? 0 });
      }).catch((error) => {
        if (token !== traceToken) return;
        console.error('[NonSequentialRender] Preview trace failed:', error);
      });
    }, delayMs);
  };
  const domListener = (event: Event) => deliver((event as CustomEvent<OverlayPayload>).detail);
  const redrawListener = () => scheduleDraw();
  window.addEventListener('coopt:nonsequential-trace-updated', domListener);
  window.addEventListener('coopt:render-redraw-complete', redrawListener);
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(NONSEQUENTIAL_TRACE_CHANNEL) : null;
  if (channel) channel.onmessage = (event) => deliver(event.data as OverlayPayload);
  const unsubscribeDesign = subscribeActiveCoherentDesign((snapshot) => scheduleTrace(snapshot));
  scheduleTrace(readActiveCoherentDesign(), 0);
  return () => {
    disposed = true;
    traceToken += 1;
    if (drawTimer !== null) window.clearTimeout(drawTimer);
    if (traceTimer !== null) window.clearTimeout(traceTimer);
    window.removeEventListener('coopt:nonsequential-trace-updated', domListener);
    window.removeEventListener('coopt:render-redraw-complete', redrawListener);
    unsubscribeDesign();
    channel?.close();
  };
}
