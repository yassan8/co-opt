/**
 * Application Configuration and Global Variables
 * JS_lensDraw v3 - Core Configuration Module
 */

import type * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface AppConfig {
    CANVAS_WIDTH: number;
    CANVAS_HEIGHT: number;
    VIEW_SIZE: number;
    CAMERA_CLIP_NEAR: number;
    CAMERA_CLIP_FAR: number;
    CAMERA_INITIAL_POSITION: { x: number; y: number; z: number };
    CAMERA_INITIAL_TARGET: { x: number; y: number; z: number };
    AMBIENT_LIGHT_INTENSITY: number;
    DIRECTIONAL_LIGHT_INTENSITY: number;
    DIRECTIONAL_LIGHT_POSITION: { x: number; y: number; z: number };
    DEFAULT_RAY_COUNT: number;
    DEFAULT_SPOT_DIAGRAM_RAYS: number;
    DEFAULT_TRANSVERSE_RAYS: number;
}

// Type for Tabulator table (using any for now as Tabulator doesn't have TS types)
export type TabulatorTable = any;

// =============================================================================
// APPLICATION CONSTANTS
// =============================================================================

export const APP_CONFIG: AppConfig = {
    CANVAS_WIDTH: 800,
    CANVAS_HEIGHT: 600,
    VIEW_SIZE: 800,  // Increased from 500 to 800 for better optical system viewing
    CAMERA_CLIP_NEAR: 0.01,  // Decreased from 0.1 to 0.01 for closer objects
    CAMERA_CLIP_FAR: 10000,  // Increased from 2000 to 10000 for farther objects
    CAMERA_INITIAL_POSITION: { x: 0, y: 0, z: 300 },  // Moved farther back from z: 100 to z: 300
    CAMERA_INITIAL_TARGET: { x: 0, y: 0, z: 0 },
    AMBIENT_LIGHT_INTENSITY: 1.2,
    DIRECTIONAL_LIGHT_INTENSITY: 1.0,
    DIRECTIONAL_LIGHT_POSITION: { x: -100, y: 0, z: -100 },
    DEFAULT_RAY_COUNT: 5,
    DEFAULT_SPOT_DIAGRAM_RAYS: 128,
    DEFAULT_TRANSVERSE_RAYS: 21
};

// =============================================================================
// GLOBAL STATE VARIABLES
// =============================================================================

// Control flags for preventing multiple simultaneous operations
export let isGeneratingSpotDiagram: boolean = false;
export let isGeneratingTransverseAberration: boolean = false;

// Global scene, camera, renderer, controls references
export let scene: THREE.Scene | null = null;
export let camera: THREE.PerspectiveCamera | null = null;
export let renderer: THREE.WebGLRenderer | null = null;
export let controls: OrbitControls | null = null;

// Setters for global THREE.js objects
export function setScene(sceneInstance: THREE.Scene): void {
    scene = sceneInstance;
}

export function setCamera(cameraInstance: THREE.PerspectiveCamera): void {
    camera = cameraInstance;
}

export function setRenderer(rendererInstance: THREE.WebGLRenderer): void {
    renderer = rendererInstance;
}

export function setControls(controlsInstance: OrbitControls): void {
    controls = controlsInstance;
}

// Global table references
export let tableSource: TabulatorTable | null = null;
export let tableObject: TabulatorTable | null = null;
export let tableOpticalSystem: TabulatorTable | null = null;

export function setTableSource(table: TabulatorTable): void {
    tableSource = table;
}

export function setTableObject(table: TabulatorTable): void {
    tableObject = table;
}

export function setTableOpticalSystem(table: TabulatorTable): void {
    tableOpticalSystem = table;
}

// Getters for THREE.js objects
export function getScene(): THREE.Scene | null {
    return scene;
}

export function getCamera(): THREE.PerspectiveCamera | null {
    return camera;
}

export function getRenderer(): THREE.WebGLRenderer | null {
    return renderer;
}

// Getters for global state variables
export function getIsGeneratingSpotDiagram(): boolean {
    return isGeneratingSpotDiagram;
}

export function getIsGeneratingTransverseAberration(): boolean {
    return isGeneratingTransverseAberration;
}

// Updated setters with proper naming
export function setIsGeneratingSpotDiagram(value: boolean): void {
    isGeneratingSpotDiagram = value;
}

export function setIsGeneratingTransverseAberration(value: boolean): void {
    isGeneratingTransverseAberration = value;
}

export function getControls(): OrbitControls | null {
    return controls;
}

export function getTableSource(): TabulatorTable | null {
    return tableSource;
}

export function getTableObject(): TabulatorTable | null {
    return tableObject;
}

export function getTableOpticalSystem(): TabulatorTable | null {
    return tableOpticalSystem;
}

// Initialize all references - used during application startup
export function initializeReferences(
    sceneRef: THREE.Scene,
    cameraRef: THREE.PerspectiveCamera,
    rendererRef: THREE.WebGLRenderer,
    controlsRef: OrbitControls,
    tableOpticalSystemRef: TabulatorTable,
    tableObjectRef: TabulatorTable,
    tableSourceRef: TabulatorTable
): void {
    scene = sceneRef;
    camera = cameraRef;
    renderer = rendererRef;
    controls = controlsRef;
    tableOpticalSystem = tableOpticalSystemRef;
    tableObject = tableObjectRef;
    tableSource = tableSourceRef;
}
