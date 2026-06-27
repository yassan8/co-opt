// Type definitions for debug-utils.js
import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';

export function adjustCameraView(
  scene?: THREE.Scene,
  camera?: THREE.Camera,
  controls?: OrbitControls,
  renderer?: THREE.WebGLRenderer
): void;

export function debugSceneContents(...args: any[]): void;
export function debugDrawingIssues(...args: any[]): void;
export function showSceneBoundingBox(...args: any[]): void;
