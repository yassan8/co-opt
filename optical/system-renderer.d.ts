// Type definitions for system-renderer.js
import * as THREE from 'three';

export function clearAllOpticalElements(scene?: THREE.Scene): void;

export function drawOpticalSystemSurfaces(options: {
  crossSectionOnly?: boolean;
  scene: THREE.Scene;
  showSurfaceOrigins?: boolean;
  showSemidiaRing?: boolean;
  showMirrorBackText?: boolean;
  crossSectionDirection?: string;
  crossSectionCenterOffset?: number;
  opticalSystemData: any[];
}): void;

export function findStopSurface(...args: any[]): any;
