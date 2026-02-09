// Type definitions for ray-renderer.js
import * as THREE from 'three';

export function drawRayWithSegmentColors(
  rayPath: any,
  objectId: any,
  rayNumber: any,
  scene?: THREE.Scene
): void;

export function setRayEmissionPattern(...args: any[]): void;
export function setRayColorMode(...args: any[]): void;
export function getRayEmissionPattern(...args: any[]): any;
export function getRayColorMode(...args: any[]): any;
export function optimizeObjectPositionForStop(...args: any[]): any;
export function optimizeAngleObjectPosition(...args: any[]): any;
export function generateRayStartPointsForObject(...args: any[]): any;
