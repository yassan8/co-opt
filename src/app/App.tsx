import { useEffect, useState } from "react";
import MainToolbar from "../ui/components/MainToolbar";
import ConfigurationSection from "../ui/components/ConfigurationSection";
import SourceObjectSection from "../ui/components/SourceObjectSection";
import DesignIntentSection from "../ui/components/DesignIntentSection";
import RequirementsSection from "../ui/components/RequirementsSection";
import LegacyPanels from "../ui/components/LegacyPanels";
import { SystemDataPanel } from "../ui/components/LegacyPanels";
import { requestRefreshBlockInspector } from "../../core/window-facade.ts";

export default function App() {
  const [renderWindowStatus, setRenderWindowStatus] = useState("Initializing...");
  const [renderViewAxis, setRenderViewAxis] = useState<'YZ' | 'XZ'>('YZ');
  const [renderRayCount, setRenderRayCount] = useState(5);
  const [astigChiefRayDefinition, setAstigChiefRayDefinition] = useState('stop-center');
  const [astigBeamPattern, setAstigBeamPattern] = useState<'cross' | 'grid' | 'annular'>('annular');
  const [astigRayCount, setAstigRayCount] = useState(30);
  const [astigRingCount, setAstigRingCount] = useState(32);
  const [astigStatus, setAstigStatus] = useState('');
  const [astigBusy, setAstigBusy] = useState(false);
  const [astigProgress, setAstigProgress] = useState(0);
  const [astigProgressText, setAstigProgressText] = useState('');
  const isRenderWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get('coopt_render_window') === '1';
    } catch (_) {
      return false;
    }
  })();
  const analysisWindowMode = (() => {
    try {
      const url = new URL(window.location.href);
      const enabled = url.searchParams.get('coopt_analysis_window') === '1';
      const analysis = String(url.searchParams.get('coopt_analysis') || '').trim();
      return { enabled, analysis };
    } catch (_) {
      return { enabled: false, analysis: '' };
    }
  })();

  const ensurePlotlyLoaded = async (): Promise<void> => {
    const w = window as any;
    if (w.Plotly && typeof w.Plotly.newPlot === 'function') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const existing = document.querySelector('script[data-coopt-plotly="1"]') as HTMLScriptElement | null;
      if (existing) {
        if (w.Plotly && typeof w.Plotly.newPlot === 'function') {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('Failed to load Plotly')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://cdn.plot.ly/plotly-2.32.0.min.js';
      script.async = true;
      script.setAttribute('data-coopt-plotly', '1');
      script.addEventListener('load', () => resolve(), { once: true });
      script.addEventListener('error', () => reject(new Error('Failed to load Plotly')), { once: true });
      document.head.appendChild(script);
    });

    if (!(window as any).Plotly || typeof (window as any).Plotly.newPlot !== 'function') {
      throw new Error('Plotly is unavailable');
    }
  };

  const ensureRenderCanvasAttached = (): boolean => {
    try {
      const w = window as any;
      const container = document.getElementById('threejs-canvas-container');
      if (!container) return false;

      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const canvas = renderer?.domElement;
      if (!renderer || !canvas) return false;

      if (canvas.parentElement !== container) {
        container.appendChild(canvas);
      }

      const width = Math.max(1, container.clientWidth || window.innerWidth || 1);
      const height = Math.max(1, container.clientHeight || (window.innerHeight - 44) || 1);
      if (typeof renderer.setPixelRatio === 'function') {
        renderer.setPixelRatio(window.devicePixelRatio || 1);
      }
      if (typeof renderer.setSize === 'function') {
        renderer.setSize(width, height, false);
      }
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      return true;
    } catch (_) {
      return false;
    }
  };

  const syncOrthoBoundsToRendererAspect = (): void => {
    try {
      const w = window as any;
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      if (!camera?.isOrthographicCamera || !renderer || typeof renderer.getSize !== 'function') return;

      const THREERef = w.THREE;
      if (!THREERef?.Vector2) return;

      const size = renderer.getSize(new THREERef.Vector2());
      const width = Number(size?.x) || 0;
      const height = Number(size?.y) || 0;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return;

      const aspect = width / height;
      const currentHeight = (camera.top - camera.bottom) || 1;
      const centerX = (camera.left + camera.right) / 2;
      const centerY = (camera.top + camera.bottom) / 2;
      const nextWidth = currentHeight * aspect;

      camera.left = centerX - nextWidth / 2;
      camera.right = centerX + nextWidth / 2;
      camera.top = centerY + currentHeight / 2;
      camera.bottom = centerY - currentHeight / 2;
      camera.updateProjectionMatrix();
    } catch (_) {}
  };

  const collectLegacyCrossRays = async (opticalSystemRows: any[], axis: 'YZ' | 'XZ' | 'BOTH' = 'BOTH'): Promise<any[]> => {
    const w = window as any;
    try {
      const getObjectRows = w.getObjectRows;
      const objectRowsRaw = (typeof getObjectRows === 'function') ? (getObjectRows(w.tableObject) || []) : [];
      const objectRows = Array.isArray(objectRowsRaw) ? objectRowsRaw : [];

      const objectSurface = opticalSystemRows[0] || {};
      const thicknessRaw = objectSurface?.thickness;
      const thicknessStr = String(thicknessRaw ?? '').trim().toUpperCase();
      const thicknessVal = Number(thicknessRaw);
      const isInfiniteSystem = (
        thicknessRaw === Infinity ||
        thicknessStr === 'INF' ||
        thicknessStr === 'INFINITY' ||
        thicknessStr === '∞' ||
        (Number.isFinite(thicknessVal) && Math.abs(thicknessVal) > 1e6)
      );

      const primaryWavelength = (typeof w.getPrimaryWavelength === 'function')
        ? (Number(w.getPrimaryWavelength()) || 0.5876)
        : 0.5876;

      const toNumber = (value: any) => {
        const parsed = parseFloat(String(value ?? ''));
        return Number.isFinite(parsed) ? parsed : 0;
      };

      let crossBeamResult: any = null;
      const crossType = axis === 'YZ' ? 'vertical' : (axis === 'XZ' ? 'horizontal' : 'both');
      if (isInfiniteSystem && typeof w.generateInfiniteSystemCrossBeam === 'function') {
        const objectAngles = (objectRows.length ? objectRows : [{}]).map((row: any) => ({
          x: toNumber(row?.xHeightAngle ?? row?.x),
          y: toNumber(row?.yHeightAngle ?? row?.y)
        }));

        const isImageRow = (row: any) => {
          const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
          const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
          return normalized === 'image' || normalized.startsWith('image');
        };
        const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) => row && isImageRow(row));
        const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);

        crossBeamResult = await w.generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, {
          rayCount: renderRayCount,
          debugMode: false,
          wavelength: primaryWavelength,
          crossType,
          targetSurfaceIndex,
          angleUnit: 'deg',
          chiefZ: -20
        });
      } else if (typeof w.generateCrossBeam === 'function') {
        const allObjectPositions = (objectRows.length ? objectRows : [{}]).map((row: any, index: number) => {
          if (Array.isArray(row)) {
            return { x: toNumber(row[1]), y: toNumber(row[2]), z: 0, objectIndex: index };
          }
          return {
            x: toNumber(row?.xHeightAngle ?? row?.x ?? row?.height ?? row?.heightX),
            y: toNumber(row?.yHeightAngle ?? row?.y ?? row?.height ?? row?.heightY),
            z: 0,
            objectIndex: row?.objectIndex ?? index
          };
        });

        crossBeamResult = await w.generateCrossBeam(opticalSystemRows, allObjectPositions, {
          rayCount: renderRayCount,
          debugMode: false,
          wavelength: primaryWavelength,
          crossType
        });
      }

      if (!crossBeamResult || crossBeamResult.success === false) {
        return [];
      }

      let allRays: any[] = [];
      if (crossBeamResult.results && Array.isArray(crossBeamResult.results)) {
        crossBeamResult.results.forEach((result: any, resultIndex: number) => {
          if (result?.rays && Array.isArray(result.rays)) {
            const objectIndex = Number.isFinite(Number(result?.objectIndex))
              ? Number(result.objectIndex)
              : resultIndex;
            const normalized = result.rays.map((ray: any) => ({
              ...ray,
              objectIndex: Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : objectIndex,
              originalRay: {
                ...(ray?.originalRay || {}),
                objectIndex: Number.isFinite(Number(ray?.originalRay?.objectIndex))
                  ? Number(ray.originalRay.objectIndex)
                  : (Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : objectIndex)
              }
            }));
            allRays = allRays.concat(normalized);
          }
        });
      } else if (
        crossBeamResult.allCrossBeamRays && Array.isArray(crossBeamResult.allCrossBeamRays) &&
        crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)
      ) {
        allRays = crossBeamResult.allTracedRays.map((tracedRay: any, index: number) => {
          const crossRay = crossBeamResult.allCrossBeamRays[index];
          if (crossRay) {
            tracedRay.type = crossRay.type;
            tracedRay.beamType = crossRay.beamType;
            tracedRay.objectIndex = tracedRay.objectIndex ?? crossRay.objectIndex;
            tracedRay.originalRay = tracedRay.originalRay || crossRay;
          }
          return tracedRay;
        });
      } else if (crossBeamResult.allCrossBeamRays && Array.isArray(crossBeamResult.allCrossBeamRays)) {
        allRays = crossBeamResult.allCrossBeamRays;
      } else if (crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)) {
        allRays = crossBeamResult.allTracedRays;
      } else if (crossBeamResult.tracedRays && Array.isArray(crossBeamResult.tracedRays)) {
        allRays = crossBeamResult.tracedRays;
      } else if (Array.isArray(crossBeamResult)) {
        allRays = crossBeamResult;
      }
      const normalizedAllRays = Array.isArray(allRays) ? allRays.map((ray: any) => {
        const inferredObjectIndex = Number.isFinite(Number(ray?.objectIndex))
          ? Number(ray.objectIndex)
          : (Number.isFinite(Number(ray?.originalRay?.objectIndex))
            ? Number(ray.originalRay.objectIndex)
            : 0);
        return {
          ...ray,
          objectIndex: inferredObjectIndex,
          originalRay: {
            ...(ray?.originalRay || {}),
            objectIndex: inferredObjectIndex
          }
        };
      }) : [];

      const desiredCount = Math.max(1, Number.parseInt(String(renderRayCount), 10) || 1);
      const grouped = new Map<number, any[]>();
      normalizedAllRays.forEach((ray: any) => {
        const objectIndex = Number.isFinite(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : 0;
        if (!grouped.has(objectIndex)) grouped.set(objectIndex, []);
        grouped.get(objectIndex)!.push(ray);
      });

      const limitedRays: any[] = [];
      grouped.forEach((rays, objectIndex) => {
        const chief = rays.filter((r: any) => String(r?.originalRay?.type || r?.type || '').toLowerCase() === 'chief');
        const nonChief = rays.filter((r: any) => String(r?.originalRay?.type || r?.type || '').toLowerCase() !== 'chief');

        const ordered = [...chief, ...nonChief].map((r: any) => ({
          ...r,
          objectIndex,
          originalRay: {
            ...(r?.originalRay || {}),
            objectIndex
          }
        }));

        limitedRays.push(...ordered.slice(0, desiredCount));
      });

      return limitedRays;
    } catch (error) {
      console.error('[RenderWindow] Legacy cross-beam generation failed:', error);
      return [];
    }
  };

  const applyRenderWindowDirectCrossFill = (scene: any, axis: 'YZ' | 'XZ', opticalSystemRows: any[]): number => {
    const w = window as any;
    const THREE = w?.THREE;
    if (!scene || !THREE || !Array.isArray(opticalSystemRows) || opticalSystemRows.length < 2) return 0;

    const toRemove: any[] = [];
    scene.traverse((child: any) => {
      if (child?.userData?.type === 'renderWindowDirectFill') {
        toRemove.push(child);
      }
    });
    [...new Set(toRemove)].forEach((obj: any) => {
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
        else obj.material.dispose();
      }
    });

    const isCoordBreak = (surface: any): boolean => {
      const surfType = String(surface?.surfType || surface?.type || '').trim().toLowerCase();
      const objType = String(surface?.['object type'] || '').trim().toLowerCase();
      return (
        surfType === 'coord break' || surfType === 'coordinate break' ||
        surfType === 'cb' || surfType === 'coordtrans' ||
        surfType === 'coordinatebreak' || surfType === 'coord trans' ||
        surfType === 'coordinate transform' || surfType === 'ct' ||
        objType === 'coord break' || objType === 'coordinate break' ||
        objType === 'cb' || objType === 'coordtrans' ||
        objType === 'coordinatebreak'
      );
    };

    const isGap = (surface: any): boolean => {
      const blockType = String(surface?._blockType ?? surface?.blockType ?? '').trim().toLowerCase();
      if (blockType === 'gap' || blockType === 'airgap') return true;
      const objType = String(surface?.['object type'] ?? surface?.type ?? '').trim().toLowerCase();
      if (objType === 'gap' || objType === 'air gap' || objType === 'airgap') return true;
      const role = String(surface?._surfaceRole ?? '').trim().toLowerCase();
      if (role === 'gap' || role === 'airgap') return true;
      return false;
    };

    const isGlassMaterial = (materialValue: any): boolean => {
      const material = String(materialValue ?? '').trim().toUpperCase();
      if (!material) return false;
      return !(material === 'AIR' || material === '0' || material === 'MIRROR');
    };

    const getSemidia = (surface: any): number | null => {
      const candidates: Array<{ value: any; isDiameter: boolean }> = [
        { value: surface?.semidia, isDiameter: false },
        { value: surface?.semiDiameter, isDiameter: false },
        { value: surface?.['semi-diameter'], isDiameter: false },
        { value: surface?.semi_diameter, isDiameter: false },
        { value: surface?.clearAperture, isDiameter: false },
        { value: surface?.Clear_Aperture, isDiameter: false },
        { value: surface?.diameter, isDiameter: true }
      ];
      for (const candidate of candidates) {
        const n = Number(candidate.value);
        const parsed = Number.isFinite(n) ? n : parseFloat(String(candidate.value ?? ''));
        if (Number.isFinite(parsed) && parsed > 0) {
          return candidate.isDiameter ? parsed * 0.5 : parsed;
        }
      }
      return null;
    };

    const isLensInterval = (front: any, back: any): boolean => {
      if (!front || !back) return false;
      if (String(front?.['object type'] ?? '').trim().toLowerCase() === 'object') return false;
      if (isGap(front) || isGap(back)) return false;
      if (isCoordBreak(front) || isCoordBreak(back)) return false;
      // Fill only the medium AFTER the front surface. If it's AIR, do not paint.
      return isGlassMaterial(front?.material);
    };

    const readWorldPolylinePoints = (lineObj: any): any[] => {
      if (!lineObj?.geometry?.attributes?.position) return [];
      const attr = lineObj.geometry.attributes.position;
      const points: any[] = [];
      for (let idx = 0; idx < attr.count; idx++) {
        const p = new THREE.Vector3(attr.getX(idx), attr.getY(idx), attr.getZ(idx));
        if (typeof lineObj.localToWorld === 'function') {
          lineObj.localToWorld(p);
        }
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
          points.push(p);
        }
      }
      return points;
    };

    const orientPolyline = (points: any[], startRef: any, endRef: any): any[] => {
      if (!Array.isArray(points) || points.length < 2 || !startRef || !endRef) return points || [];
      const d1 = points[0].distanceTo(startRef) + points[points.length - 1].distanceTo(endRef);
      const d2 = points[0].distanceTo(endRef) + points[points.length - 1].distanceTo(startRef);
      return d1 <= d2 ? points.slice() : points.slice().reverse();
    };

    const samplePolyline = (points: any[], count: number): any[] => {
      if (!Array.isArray(points) || points.length < 2 || count < 2) return [];
      const sampled: any[] = [];
      for (let s = 0; s < count; s++) {
        const t = s / (count - 1);
        const idx = Math.round(t * (points.length - 1));
        const p = points[Math.max(0, Math.min(idx, points.length - 1))];
        if (p) sampled.push(p.clone());
      }
      return sampled;
    };

    const surfaceOriginsZ: number[] = [];
    let zAccum = 0;
    for (let i = 0; i < opticalSystemRows.length; i++) {
      surfaceOriginsZ.push(zAccum);
      const tRaw = opticalSystemRows[i]?.thickness;
      const tNum = Number(tRaw);
      const tParsed = Number.isFinite(tNum) ? tNum : parseFloat(String(tRaw ?? ''));
      if (Number.isFinite(tParsed)) zAccum += tParsed;
    }

    const fillColor = 0x00ccff;
    let createdCount = 0;

    const profileMap = new Map<number, any>();
    const connectionMap = new Map<number, any[]>();
    scene.traverse((child: any) => {
      const ud = child?.userData || {};
      if (ud.type === 'surfaceProfile' && ud.profileType === axis) {
        const surfaceIndex = Number(ud.surfaceIndex);
        if (Number.isFinite(surfaceIndex)) {
          profileMap.set(surfaceIndex, child);
        }
      }
      if (ud.type === 'connectionLine' && ud.direction === axis) {
        const surfaceIndex = Number(ud.surfaceIndex);
        if (Number.isFinite(surfaceIndex)) {
          if (!connectionMap.has(surfaceIndex)) connectionMap.set(surfaceIndex, []);
          connectionMap.get(surfaceIndex)!.push(child);
        }
      }
    });

    for (let i = 0; i < opticalSystemRows.length - 1; i++) {
      const front = opticalSystemRows[i];
      const back = opticalSystemRows[i + 1];
      if (!isLensInterval(front, back)) continue;

      const frontIndex = i + 1;
      const backIndex = i + 2;
      const frontLine = profileMap.get(frontIndex);
      const backLine = profileMap.get(backIndex);

      let frontPoints = frontLine ? readWorldPolylinePoints(frontLine) : [];
      let backPoints = backLine ? readWorldPolylinePoints(backLine) : [];

      let geometry: any = null;
      let frontNeg: any = null;
      let frontPos: any = null;
      let backNeg: any = null;
      let backPos: any = null;
      if (frontPoints.length >= 2 && backPoints.length >= 2) {
        const frontStart = frontPoints[0];
        const frontEnd = frontPoints[frontPoints.length - 1];
        const backStart = backPoints[0];
        const backEnd = backPoints[backPoints.length - 1];

        const forwardCost = frontStart.distanceToSquared(backStart) + frontEnd.distanceToSquared(backEnd);
        const reverseCost = frontStart.distanceToSquared(backEnd) + frontEnd.distanceToSquared(backStart);
        const alignedBack = orientPolyline(backPoints, frontStart, frontEnd);
        const backUsed = (forwardCost <= reverseCost) ? alignedBack : alignedBack.slice().reverse();

        frontNeg = frontPoints[0].clone();
        frontPos = frontPoints[frontPoints.length - 1].clone();
        backNeg = backUsed[0].clone();
        backPos = backUsed[backUsed.length - 1].clone();

        const sampleCount = Math.max(8, Math.min(48, Math.min(frontPoints.length, backUsed.length)));
        const sampledFront = samplePolyline(frontPoints, sampleCount);
        const sampledBack = samplePolyline(backUsed, sampleCount);

        if (sampledFront.length >= 2 && sampledBack.length >= 2 && sampledFront.length === sampledBack.length) {
          const vertexCount = sampledFront.length * 2;
          const positions = new Float32Array(vertexCount * 3);
          const triangles: number[] = [];

          for (let j = 0; j < sampledFront.length; j++) {
            const f = sampledFront[j];
            const b = sampledBack[j];
            const fi = j * 2;
            const bi = fi + 1;

            positions[fi * 3] = f.x;
            positions[fi * 3 + 1] = f.y;
            positions[fi * 3 + 2] = f.z;

            positions[bi * 3] = b.x;
            positions[bi * 3 + 1] = b.y;
            positions[bi * 3 + 2] = b.z;

            if (j < sampledFront.length - 1) {
              const a = fi;
              const bIdx = bi;
              const c = fi + 2;
              const d = bi + 2;
              triangles.push(a, bIdx, c);
              triangles.push(bIdx, d, c);
            }
          }

          if (triangles.length >= 3) {
            const indexArray = vertexCount > 65535 ? new Uint32Array(triangles) : new Uint16Array(triangles);
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
            geometry.computeVertexNormals();
          }
        }
      }

      if (!geometry) {
        const sd1 = getSemidia(front);
        const sd2 = getSemidia(back);
        if (!Number.isFinite(sd1) || !Number.isFinite(sd2) || (sd1 as number) <= 0 || (sd2 as number) <= 0) continue;

        const z1 = surfaceOriginsZ[i] ?? 0;
        const z2 = surfaceOriginsZ[i + 1] ?? z1;

        const positions = new Float32Array(12);
        if (axis === 'YZ') {
          positions.set([
            0, -(sd1 as number), z1,
            0, (sd1 as number), z1,
            0, -(sd2 as number), z2,
            0, (sd2 as number), z2
          ]);
        } else {
          positions.set([
            -(sd1 as number), 0, z1,
            (sd1 as number), 0, z1,
            -(sd2 as number), 0, z2,
            (sd2 as number), 0, z2
          ]);
        }

        const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();

        if (axis === 'YZ') {
          frontNeg = new THREE.Vector3(0, -(sd1 as number), z1);
          frontPos = new THREE.Vector3(0, (sd1 as number), z1);
          backNeg = new THREE.Vector3(0, -(sd2 as number), z2);
          backPos = new THREE.Vector3(0, (sd2 as number), z2);
        } else {
          frontNeg = new THREE.Vector3(-(sd1 as number), 0, z1);
          frontPos = new THREE.Vector3((sd1 as number), 0, z1);
          backNeg = new THREE.Vector3(-(sd2 as number), 0, z2);
          backPos = new THREE.Vector3((sd2 as number), 0, z2);
        }
      }

      const material = new THREE.MeshBasicMaterial({
        color: fillColor,
        transparent: true,
        opacity: 0.52,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 60000;
      mesh.userData = {
        type: 'renderWindowDirectFill',
        axis,
        intervalIndex: i,
        isDebugOverlay: true
      };
      scene.add(mesh);
      createdCount += 1;

      const axisCoord = (p: any) => axis === 'YZ' ? Number(p?.y) : Number(p?.x);
      const sideLines = (connectionMap.get(frontIndex) || [])
        .map((lineObj: any) => {
          const pts = readWorldPolylinePoints(lineObj);
          if (pts.length < 3) return null;
          const avg = pts.reduce((sum: number, p: any) => sum + axisCoord(p), 0) / pts.length;
          return { pts, avg };
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.avg - b.avg);

      const addLSideFill = (linePts: any[], frontEnd: any, backEnd: any) => {
        if (!linePts || linePts.length < 3 || !frontEnd || !backEnd) return;
        const p0 = linePts[0];
        const p1 = linePts[Math.floor(linePts.length / 2)];
        const p2 = linePts[linePts.length - 1];

        const directCost = p0.distanceToSquared(frontEnd) + p2.distanceToSquared(backEnd);
        const reverseCost = p0.distanceToSquared(backEnd) + p2.distanceToSquared(frontEnd);

        const f = (directCost <= reverseCost) ? p0 : p2;
        const b = (directCost <= reverseCost) ? p2 : p0;
        const elbow = p1;

        if (!elbow) return;

        const sidePositions = new Float32Array([
          f.x, f.y, f.z,
          elbow.x, elbow.y, elbow.z,
          b.x, b.y, b.z
        ]);
        const sideGeometry = new THREE.BufferGeometry();
        sideGeometry.setAttribute('position', new THREE.BufferAttribute(sidePositions, 3));
        sideGeometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
        sideGeometry.computeVertexNormals();

        const sideMaterial = new THREE.MeshBasicMaterial({
          color: fillColor,
          transparent: true,
          opacity: 0.52,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false
        });
        const sideMesh = new THREE.Mesh(sideGeometry, sideMaterial);
        sideMesh.frustumCulled = false;
        sideMesh.renderOrder = 60001;
        sideMesh.userData = {
          type: 'renderWindowDirectFill',
          axis,
          intervalIndex: i,
          isEdgeLFill: true
        };
        scene.add(sideMesh);
      };

      if (sideLines.length >= 1) {
        addLSideFill(sideLines[0].pts, frontNeg, backNeg);
      }
      if (sideLines.length >= 2) {
        addLSideFill(sideLines[sideLines.length - 1].pts, frontPos, backPos);
      }
    }

    return createdCount;
  };

  const drawCrossSectionView = async (axis: 'YZ' | 'XZ'): Promise<boolean> => {
    const w = window as any;
    try {
      const cm = w.ConfigurationManager;
      if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
        await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
      }
    } catch (_) {}

    try {
      if (typeof w.initializeAllTables === 'function') w.initializeAllTables();
    } catch (_) {}

    ensureRenderCanvasAttached();

    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    } catch (_) {}

    let rows: any[] = [];
    try {
      if (typeof w.getOpticalSystemRows === 'function') {
        const r = w.getOpticalSystemRows(w.tableOpticalSystem);
        rows = Array.isArray(r) ? r : [];
      }
    } catch (_) {
      rows = [];
    }
    if (!rows.length) {
      setRenderWindowStatus('No optical data');
      return false;
    }

    try {
      const sceneForDraw = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      if (sceneForDraw && typeof w.clearAllOpticalElements === 'function') {
        try { w.clearAllOpticalElements(sceneForDraw); } catch (_) {}
      }
      if (sceneForDraw) {
        try {
          const raysToRemove: any[] = [];
          sceneForDraw.traverse((child: any) => {
            if (child?.userData?.type === 'optical-ray' || child?.userData?.isRayLine) {
              raysToRemove.push(child);
            }
          });
          [...new Set(raysToRemove)].forEach((obj: any) => {
            sceneForDraw.remove(obj);
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
              if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
              else obj.material.dispose();
            }
          });
        } catch (_) {}
      }
      if (typeof w.drawOpticalSystemSurfaces === 'function' && sceneForDraw) {
        w.drawOpticalSystemSurfaces({
          opticalSystemData: rows,
          scene: sceneForDraw,
          crossSectionOnly: true,
          showSurfaceOrigins: false,
          showSemidiaRing: false,
          showMirrorBackText: false,
          crossSectionDirection: axis,
          crossSectionCenterOffset: 0
        });
      }

      if (sceneForDraw) {
        try {
          sceneForDraw.traverse((child: any) => {
            const ud = child?.userData || {};
            if (ud.type === 'surfaceProfile' && (ud.profileType === 'YZ' || ud.profileType === 'XZ')) {
              child.visible = ud.profileType === axis;
            }
            if (ud.type === 'connectionLine' && (ud.direction === 'YZ' || ud.direction === 'XZ')) {
              child.visible = ud.direction === axis;
            }
          });
        } catch (_) {}
      }

      const legacyCrossRays = await collectLegacyCrossRays(rows, axis);
      if (legacyCrossRays.length > 0 && typeof w.drawCrossBeamRays === 'function') {
        w.drawCrossBeamRays(legacyCrossRays, sceneForDraw);
      }

      let fillCount = 0;

      try {
        fillCount = applyRenderWindowDirectCrossFill(sceneForDraw, axis, rows);
      } catch (e) {
        console.warn('[RenderWindow] Direct cross fill failed:', e);
      }

      if (axis === 'XZ' && typeof w.setCameraForXZCrossSection === 'function') {
        w.setCameraForXZCrossSection({ includeRayStartMargin: true, storeDrawCrossBounds: true });
      } else if (axis === 'YZ' && typeof w.setCameraForYZCrossSection === 'function') {
        w.setCameraForYZCrossSection({ includeRayStartMargin: true, storeDrawCrossBounds: true });
      }

      syncOrthoBoundsToRendererAspect();
      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      if (renderer && scene && camera && typeof renderer.render === 'function') {
        renderer.render(scene, camera);
      }

      setRenderWindowStatus(`Ready (${axis} section) fill=${fillCount} source=renderwindow-app`);
      return true;
    } catch (err) {
      console.error('[RenderWindow] Cross-section draw failed:', err);
      setRenderWindowStatus('Draw failed');
      return false;
    }
  };

  const drawRender3DView = async (): Promise<boolean> => {
    const w = window as any;

    try {
      ensureRenderCanvasAttached();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

      let rows: any[] = [];
      try {
        if (typeof w.getOpticalSystemRows === 'function') {
          const r = w.getOpticalSystemRows(w.tableOpticalSystem);
          rows = Array.isArray(r) ? r : [];
        }
      } catch (_) {
        rows = [];
      }

      if (!rows.length) {
        setRenderWindowStatus('No optical data');
        return false;
      }

      const sceneForDraw = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      if (!sceneForDraw) {
        setRenderWindowStatus('Scene unavailable');
        return false;
      }

      if (typeof w.clearAllOpticalElements === 'function') {
        try { w.clearAllOpticalElements(sceneForDraw); } catch (_) {}
      }

      try {
        const raysToRemove: any[] = [];
        sceneForDraw.traverse((child: any) => {
          if (child?.userData?.type === 'optical-ray' || child?.userData?.isRayLine) {
            raysToRemove.push(child);
          }
        });
        [...new Set(raysToRemove)].forEach((obj: any) => {
          sceneForDraw.remove(obj);
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
            else obj.material.dispose();
          }
        });
      } catch (_) {}

      if (typeof w.drawOpticalSystemSurfaces === 'function') {
        w.drawOpticalSystemSurfaces({
          opticalSystemData: rows,
          scene: sceneForDraw,
          crossSectionOnly: false,
          showSurfaceOrigins: false,
          showSemidiaRing: true,
          showMirrorBackText: false,
          crossSectionDirection: 'YZ',
          crossSectionCenterOffset: 0
        });
      }

      const legacyCrossRays = await collectLegacyCrossRays(rows, 'BOTH');
      if (legacyCrossRays.length > 0 && typeof w.drawCrossBeamRays === 'function') {
        w.drawCrossBeamRays(legacyCrossRays, sceneForDraw);
      }

      try {
        if (typeof w.setCameraForYZCrossSection === 'function') {
          w.setCameraForYZCrossSection({ includeRayStartMargin: true, storeDrawCrossBounds: true });
        } else if (typeof w.fitCameraToScene === 'function') {
          w.fitCameraToScene();
        } else if (typeof w.adjustCameraView === 'function') {
          const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
          const controls = w.controls || (typeof w.getControls === 'function' ? w.getControls() : null);
          const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
          w.adjustCameraView(sceneForDraw, camera, controls, renderer);
        }
      } catch (_) {}

      const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
      const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
      const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
      if (renderer && scene && camera && typeof renderer.render === 'function') {
        renderer.render(scene, camera);
      }

      setRenderWindowStatus('Ready (3D)');
      return true;
    } catch (err) {
      console.error('[RenderWindow] 3D draw failed:', err);
      setRenderWindowStatus('Draw failed');
      return false;
    }
  };

  useEffect(() => {
    // FIRST: Signal that React is mounted so main.ts can start initializing
    // This breaks the deadlock where main.ts waits for React and React waits for main.ts
    (window as typeof window & { __cooptReactMounted?: boolean })
      .__cooptReactMounted = true;
    window.dispatchEvent(new CustomEvent("coopt:react-mounted"));

    const w = window as any;
    
    const initializeAfterMainTS = (_mode: "main-ready" | "module-loaded" | "fallback") => {
      if (isRenderWindowMode) {
        const drawWithPreparedData = async (): Promise<boolean> => {
          const w = window as any;
          try {
            const cm = w.ConfigurationManager;
            if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
              await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
            }
          } catch (err) {
            console.warn('[RenderWindow] Configuration load failed before draw:', err);
          }

          try {
            if (typeof w.initializeAllTables === 'function') {
              w.initializeAllTables();
            }
          } catch (_) {}

          ensureRenderCanvasAttached();

          try {
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          } catch (_) {}

          let rowCount = 0;
          try {
            if (typeof w.getOpticalSystemRows === 'function') {
              const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
              rowCount = Array.isArray(rows) ? rows.length : 0;
            }
          } catch (_) {}

          if (rowCount === 0) {
            setRenderWindowStatus('No optical data');
            return false;
          }

          try {
            const ok = await drawRender3DView();
            if (!ok) {
              setRenderWindowStatus('Draw failed');
              return false;
            }
          } catch (err) {
            console.error('[RenderWindow] Failed to draw optical system:', err);
            setRenderWindowStatus('Draw failed');
            return false;
          }

          const hasCanvas = ensureRenderCanvasAttached() || !!document.querySelector('#threejs-canvas-container canvas');
          if (hasCanvas) {
            setRenderWindowStatus('Ready (3D)');
            return true;
          }

          const hasRenderer = !!(w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null));
          if (!hasRenderer) {
            setRenderWindowStatus('Renderer unavailable');
          } else if (!hasCanvas) {
            setRenderWindowStatus('Canvas unavailable');
          } else {
            setRenderWindowStatus('Draw unavailable');
          }
          return false;
        };

        setRenderWindowStatus('Initializing...');
        setTimeout(() => {
          drawWithPreparedData().catch(() => {
            setRenderWindowStatus('Draw unavailable');
          });
        }, 200);
        return;
      }
      
      // Load active configuration to tables (this expands Blocks to Optical System rows)
      if (typeof (window as any).loadActiveConfigurationToTables === 'function') {
        try {
          (window as any).loadActiveConfigurationToTables();
        } catch (err) {
          console.error("[React] Failed to load active configuration:", err);
        }
      }
      
      // Initialize tables
      if (typeof (window as any).initializeAllTables === 'function') {
        (window as any).initializeAllTables();
      }
      
      requestRefreshBlockInspector();
      
      // Ensure analysis windows are set up
      if (typeof (window as any).setupAnalysisWindows === 'function') {
        (window as any).setupAnalysisWindows();
      }
      if (typeof (window as any).setupOpticalSystemChangeListeners === 'function') {
        (window as any).setupOpticalSystemChangeListeners(null);
      }
      
      // Verify optical system data is available
      setTimeout(() => {
        const w = window as any;
        if (typeof w.getOpticalSystemRows === 'function' && w.tableOpticalSystem) {
          w.getOpticalSystemRows(w.tableOpticalSystem);
        }
      }, 200);
    };

    const isMainReady = () => !!w.__cooptMainReady;
    const isMainModuleLoaded = () => !!w.__cooptMainModuleLoaded || typeof w.getOpticalSystemRows === "function";

    if (isMainReady()) {
      setTimeout(() => initializeAfterMainTS("main-ready"), 0);
      return;
    }

    if (isMainModuleLoaded()) {
      setTimeout(() => initializeAfterMainTS("module-loaded"), 0);
      return;
    }

    let initialized = false;
    const completeInit = (mode: "main-ready" | "module-loaded" | "fallback") => {
      if (initialized) return;
      initialized = true;
      setTimeout(() => initializeAfterMainTS(mode), 0);
    };

    const onMainReady = () => completeInit("main-ready");
    const onMainModuleLoaded = () => completeInit("module-loaded");
    const onMainLoadFailed = (evt: Event) => {
      const detail = (evt as CustomEvent<any>)?.detail;
      console.error("[React] main.ts load failed", detail || { message: w.__cooptMainLoadError || "unknown" });
    };

    window.addEventListener("coopt:main-ready", onMainReady, { once: true });
    window.addEventListener("coopt:main-module-loaded", onMainModuleLoaded, { once: true });
    window.addEventListener("coopt:main-load-failed", onMainLoadFailed);

    const fallbackTimer = window.setTimeout(() => {
      if (initialized) return;
      const status = {
        getOpticalSystemRows: typeof w.getOpticalSystemRows,
        initializeAllTables: typeof w.initializeAllTables,
        loadActiveConfigurationToTables: typeof w.loadActiveConfigurationToTables,
        mainReadyFlag: !!w.__cooptMainReady,
        mainModuleLoaded: !!w.__cooptMainModuleLoaded,
        mainLoadError: w.__cooptMainLoadError || null
      };
      if (status.mainLoadError) {
        console.warn("[React] main bootstrap timeout after load error, proceeding with fallback", status);
      } else {
        console.info("[React] main bootstrap slow-start, proceeding with fallback", status);
      }
      completeInit("fallback");
    }, 30000);

    return () => {
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("coopt:main-ready", onMainReady);
      window.removeEventListener("coopt:main-module-loaded", onMainModuleLoaded);
      window.removeEventListener("coopt:main-load-failed", onMainLoadFailed);
    };
  }, []);

  useEffect(() => {
    if (!isRenderWindowMode) return;
    const onResize = () => {
      try {
        ensureRenderCanvasAttached();
        syncOrthoBoundsToRendererAspect();
        const w = window as any;
        const renderer = w.renderer || (typeof w.getRenderer === 'function' ? w.getRenderer() : null);
        const scene = w.scene || (typeof w.getScene === 'function' ? w.getScene() : null);
        const camera = w.camera || (typeof w.getCamera === 'function' ? w.getCamera() : null);
        if (renderer && scene && camera && typeof renderer.render === 'function') {
          renderer.render(scene, camera);
        }
      } catch (_) {}
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isRenderWindowMode, renderViewAxis]);

  useEffect(() => {
    if (!analysisWindowMode.enabled) return;
    if (analysisWindowMode.analysis === 'astigmatism') return;

    const originalOpen = window.open;

    let restoreOpener: (() => void) | null = null;
    try {
      const openerDescriptor = Object.getOwnPropertyDescriptor(window, 'opener');
      Object.defineProperty(window, 'opener', {
        configurable: true,
        get: () => window,
      });
      restoreOpener = () => {
        try {
          if (openerDescriptor) {
            Object.defineProperty(window, 'opener', openerDescriptor);
          } else {
            delete (window as any).opener;
          }
        } catch (_) {}
      };
    } catch (_) {}

    (window as any).open = (...args: any[]) => {
      const first = typeof args?.[0] === 'string' ? args[0] : '';
      if (!first || first === 'about:blank') {
        return window as any;
      }
      return originalOpen.apply(window, args as any);
    };

    const analysisButtonMap: Record<string, string> = {
      'system-data': 'open-system-data-window-btn',
      'spot-diagram': 'open-spot-diagram-window-btn',
      'spherical-aberration': 'open-spherical-aberration-window-btn',
      'astigmatism': 'open-astigmatism-window-btn',
      'distortion': 'open-distortion-window-btn',
      'magnification-chromatic-aberration': 'open-magnification-chromatic-aberration-window-btn',
      'integrated-aberration': 'open-integrated-aberration-window-btn',
      'transverse-aberration': 'open-transverse-aberration-window-btn',
      'opd': 'open-opd-window-btn',
      'psf': 'open-psf-window-btn',
      'mtf': 'open-mtf-window-btn',
      'through-focus-spot': 'open-through-focus-spot-window-btn',
      'through-focus-mtf': 'open-through-focus-mtf-window-btn',
      'field-mtf': 'open-field-mtf-window-btn',
    };

    const targetButtonId = analysisButtonMap[analysisWindowMode.analysis];
    let disposed = false;
    let rafId = 0;
    let timeoutId = 0;
    let tries = 0;
    const maxTries = 180;

    const attemptLaunch = () => {
      if (disposed) return;
      if (analysisWindowMode.analysis === 'system-data') {
        return;
      }
      tries += 1;
      const w = window as any;
      try {
        if (typeof w.setupAnalysisWindows === 'function') {
          w.setupAnalysisWindows();
        }
      } catch (_) {}

      const button = targetButtonId ? document.getElementById(targetButtonId) : null;
      if (button) {
        try {
          const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          button.dispatchEvent(clickEvent);
        } catch (_) {}
        return;
      }

      if (tries >= maxTries) {
        return;
      }
      rafId = window.requestAnimationFrame(attemptLaunch);
    };

    const onMainReady = () => {
      if (disposed) return;
      try { window.cancelAnimationFrame(rafId); } catch (_) {}
      rafId = window.requestAnimationFrame(attemptLaunch);
    };

    window.addEventListener('coopt:main-ready', onMainReady);
    timeoutId = window.setTimeout(() => {
      if (disposed) return;
      attemptLaunch();
    }, 0);
    rafId = window.requestAnimationFrame(attemptLaunch);

    return () => {
      disposed = true;
      try { window.removeEventListener('coopt:main-ready', onMainReady); } catch (_) {}
      try { window.cancelAnimationFrame(rafId); } catch (_) {}
      try { window.clearTimeout(timeoutId); } catch (_) {}
      (window as any).open = originalOpen;
      if (restoreOpener) restoreOpener();
    };
  }, [analysisWindowMode.enabled, analysisWindowMode.analysis]);

  useEffect(() => {
    if (!(analysisWindowMode.enabled && analysisWindowMode.analysis === 'astigmatism')) return;
    setAstigBusy(false);
    setAstigProgress(0);
    setAstigProgressText('');
    setAstigStatus('Press Show to render');
  }, [analysisWindowMode.enabled, analysisWindowMode.analysis]);

  if (analysisWindowMode.enabled && analysisWindowMode.analysis === 'system-data') {
    return (
      <>
        <div style={{ height: '100vh', width: '100vw', overflow: 'hidden', display: 'flex' }}>
          <SystemDataPanel visible />
        </div>
        <div style={{ display: 'none' }}>
          <MainToolbar />
          <ConfigurationSection />
          <SourceObjectSection />
          <DesignIntentSection />
          <RequirementsSection />
        </div>
      </>
    );
  }

  if (analysisWindowMode.enabled && analysisWindowMode.analysis === 'astigmatism') {
    const rerenderAstigmatism = async () => {
      const w = window as any;
      if (typeof w.showAstigmatismDiagram !== 'function') {
        setAstigStatus('Astigmatism function unavailable');
        return;
      }
      setAstigBusy(true);
      setAstigProgress(0);
      setAstigProgressText('Preparing...');
      setAstigStatus('');
      try {
        await ensurePlotlyLoaded();
        await Promise.resolve(w.showAstigmatismDiagram({
          containerId: 'analysis-astig-container',
          chiefRayDefinition: astigChiefRayDefinition,
          pattern: astigBeamPattern,
          rayCount: astigRayCount,
          ringCount: astigRingCount,
          onProgress: ({ percent, message }: { percent?: number; message?: string }) => {
            let nextPercent: number | null = null;
            if (typeof percent === 'number' && Number.isFinite(percent)) {
              nextPercent = Math.max(0, Math.min(100, percent));
              setAstigProgress(nextPercent);
            }
            if (typeof message === 'string' && message.trim()) {
              setAstigProgressText(message);
            } else if (nextPercent !== null) {
              setAstigProgressText(`${Math.round(nextPercent)}%`);
            }
          },
        }));
        setAstigProgress(100);
        setAstigProgressText('Done');
        await new Promise<void>((resolve) => window.setTimeout(resolve, 700));
        setAstigProgress(0);
        setAstigProgressText('');
      } catch (err) {
        setAstigProgressText('');
        setAstigStatus(`Astigmatism error: ${(err as any)?.message || String(err)}`);
      } finally {
        setAstigBusy(false);
      }
    };

    return (
      <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', background: '#f4f4f4' }}>
        <div style={{ padding: '10px 12px', background: '#f8f8f8', borderBottom: '1px solid #ddd', display: 'flex', gap: 10, alignItems: 'center' }}>
          <label htmlFor="analysis-astig-chief-ray" style={{ fontSize: 12, color: '#333' }}>Chief ray:</label>
          <select
            id="analysis-astig-chief-ray"
            value={astigChiefRayDefinition}
            onChange={(e) => setAstigChiefRayDefinition(e.target.value)}
            style={{ padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
          >
            <option value="stop-center">Stop center</option>
            <option value="beam-midpoint">Beam midpoint</option>
            <option value="beam-centroid">Beam centroid</option>
            <option value="stop-center-image">Stop center (image)</option>
            <option value="beam-midpoint-image">Beam midpoint (image)</option>
            <option value="beam-centroid-image">Beam centroid (image)</option>
          </select>
          <label htmlFor="analysis-astig-beam-pattern" style={{ fontSize: 12, color: '#333' }}>Beam:</label>
          <select
            id="analysis-astig-beam-pattern"
            value={astigBeamPattern}
            onChange={(e) => setAstigBeamPattern(e.target.value as 'cross' | 'grid' | 'annular')}
            style={{ padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
          >
            <option value="cross">Cross</option>
            <option value="grid">Grid</option>
            <option value="annular">Annular</option>
          </select>
          <label htmlFor="analysis-astig-ray-count" style={{ fontSize: 12, color: '#333' }}>Rays:</label>
          <input
            id="analysis-astig-ray-count"
            type="number"
            min={9}
            max={2001}
            step={1}
            value={astigRayCount}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              if (!Number.isFinite(parsed)) return;
              setAstigRayCount(Math.max(9, Math.min(2001, Math.round(parsed))));
            }}
            style={{ width: 88, padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
          />
          {astigBeamPattern === 'annular' && (
            <>
              <label htmlFor="analysis-astig-ring-count" style={{ fontSize: 12, color: '#333' }}>Rings:</label>
              <input
                id="analysis-astig-ring-count"
                type="number"
                min={1}
                max={64}
                step={1}
                value={astigRingCount}
                onChange={(e) => {
                  const parsed = Number(e.target.value);
                  if (!Number.isFinite(parsed)) return;
                  setAstigRingCount(Math.max(1, Math.min(64, Math.round(parsed))));
                }}
                style={{ width: 78, padding: '5px 8px', fontSize: 12, border: '1px solid #bbb', borderRadius: 4, background: 'white' }}
              />
            </>
          )}
          <button
            type="button"
            onClick={rerenderAstigmatism}
            disabled={astigBusy}
            style={{ padding: '6px 10px', border: '1px solid #bbb', borderRadius: 4, background: '#f8f8f8', cursor: astigBusy ? 'default' : 'pointer', fontSize: 12 }}
          >
            {astigBusy ? 'Rendering...' : 'Show'}
          </button>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: astigStatus.startsWith('Astigmatism error:') ? '#b00020' : '#666' }}>
            {astigStatus || ''}
          </span>
        </div>
        {(astigBusy || !!astigProgressText) && (
          <>
            <div style={{ padding: '6px 12px', fontSize: 12, color: '#333', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 40 }}>{Math.round(astigProgress)}%</span>
              <span>{astigProgressText || 'Calculating...'}</span>
            </div>
            <div style={{ height: 4, background: '#e6e6e6', width: '100%' }}>
              <div
                style={{
                  height: '100%',
                  width: `${astigProgress}%`,
                  background: '#1677ff',
                  transition: 'width 120ms linear'
                }}
              />
            </div>
          </>
        )}
        <div id="analysis-astig-container" style={{ flex: 1, minHeight: 0, background: 'white' }} />
      </div>
    );
  }

  if (isRenderWindowMode) {
    const handleRenderDraw = async () => {
      try {
        const w = window as any;
        try {
          const cm = w.ConfigurationManager;
          if (cm && typeof cm.loadActiveConfigurationToTables === 'function') {
            await Promise.resolve(cm.loadActiveConfigurationToTables({ applyToUI: true }));
          }
        } catch (_) {}

        try {
          if (typeof w.initializeAllTables === 'function') {
            w.initializeAllTables();
          }
        } catch (_) {}

        ensureRenderCanvasAttached();

        try {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        } catch (_) {}

        let rowCount = 0;
        try {
          if (typeof w.getOpticalSystemRows === 'function') {
            const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
            rowCount = Array.isArray(rows) ? rows.length : 0;
          }
        } catch (_) {}

        if (rowCount === 0) {
          setRenderWindowStatus('No optical data');
          return;
        }

        const ok = await drawRender3DView();
        if (!ok) return;

        ensureRenderCanvasAttached();
        setRenderWindowStatus('Ready (3D)');
      } catch (err) {
        console.error('[RenderWindow] Manual draw failed:', err);
        setRenderWindowStatus('Draw failed');
      }
    };

    const handleViewXZ = () => {
      setRenderViewAxis('XZ');
      drawCrossSectionView('XZ').catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    const handleViewYZ = () => {
      setRenderViewAxis('YZ');
      drawCrossSectionView('YZ').catch(() => {
        setRenderWindowStatus('Draw failed');
      });
    };

    return (
      <>
        <div style={{ height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column', margin: 0 }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid #ddd', fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={handleRenderDraw}>Render</button>
            <button type="button" onClick={handleViewXZ}>X-Z View</button>
            <button type="button" onClick={handleViewYZ}>Y-Z View</button>
            <label htmlFor="render-ray-count-input" style={{ marginLeft: 12, fontSize: 12, fontWeight: 500 }}>Raynum</label>
            <input
              id="render-ray-count-input"
              type="number"
              min={1}
              max={10001}
              step={1}
              value={renderRayCount}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                if (Number.isFinite(parsed) && parsed > 0) {
                  setRenderRayCount(parsed);
                } else if (e.target.value === '') {
                  setRenderRayCount(5);
                }
              }}
              style={{ width: 84 }}
            />
            <span style={{ marginLeft: 'auto', fontWeight: 400, fontSize: 12, color: '#666' }}>{renderWindowStatus}</span>
          </div>
          <div id="threejs-canvas-container" aria-label="Optical system 3D canvas" style={{ flex: 1, minHeight: 0 }} />
        </div>
        <div style={{ display: 'none' }}>
          <MainToolbar />
          <ConfigurationSection />
          <SourceObjectSection />
          <DesignIntentSection />
          <RequirementsSection />
          <LegacyPanels />
        </div>
      </>
    );
  }

  return (
    <>
      <MainToolbar />
      <ConfigurationSection />
      <SourceObjectSection />
      <DesignIntentSection />
      <RequirementsSection />
      <LegacyPanels />
    </>
  );
}
