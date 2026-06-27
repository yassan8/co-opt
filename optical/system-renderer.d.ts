// Type definitions for system-renderer.js
import * as THREE from 'three';

export function clearAllOpticalElements(scene?: THREE.Scene): void;

export function drawOpticalSystemSurfaces(options: {
  crossSectionOnly?: boolean;
  scene: THREE.Scene;
  showSurfaceOrigins?: boolean;
  showSemidiaRing?: boolean;
  showMirrorBackText?: boolean;
  showDesignIntentLabels?: boolean;
  showPrincipalPointLabels?: boolean;
  showSurfaceNumberLabels?: boolean;
  crossSectionDirection?: string;
  crossSectionCenterOffset?: number;
  opticalSystemData: any[];
  surfaceOrigins?: any[] | null;
  surfaceMeshSegments?: number;
  toricMeshSegments?: number;
}): void;

export function findStopSurface(...args: any[]): any;
