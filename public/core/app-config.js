/**
 * Application Configuration and Global Variables
 * JS_lensDraw v3 - Core Configuration Module
 */

// =============================================================================
// APPLICATION CONSTANTS
// =============================================================================

export const APP_CONFIG = {
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
    DEFAULT_SPOT_DIAGRAM_RAYS: 501,
    DEFAULT_TRANSVERSE_RAYS: 51
};

// =============================================================================
// GLOBAL STATE VARIABLES
// =============================================================================

// Control flags for preventing multiple simultaneous operations
export let isGeneratingSpotDiagram = false;
export let isGeneratingTransverseAberration = false;

// Global scene, camera, renderer, controls references
export let scene = null;
export let camera = null;
export let renderer = null;
export let controls = null;

// Setters for global THREE.js objects
export function setScene(sceneInstance) {
    scene = sceneInstance;
}

export function setCamera(cameraInstance) {
    camera = cameraInstance;
}

export function setRenderer(rendererInstance) {
    renderer = rendererInstance;
}

export function setControls(controlsInstance) {
    controls = controlsInstance;
}

// Global table references
export let tableSource = null;
export let tableObject = null;
export let tableOpticalSystem = null;

export function setTableSource(table) {
    tableSource = table;
}

export function setTableObject(table) {
    tableObject = table;
}

export function setTableOpticalSystem(table) {
    tableOpticalSystem = table;
}

// Getters for THREE.js objects
export function getScene() {
    return scene;
}

export function getCamera() {
    return camera;
}

export function getRenderer() {
    return renderer;
}

// Getters for global state variables
export function getIsGeneratingSpotDiagram() {
    return isGeneratingSpotDiagram;
}

export function getIsGeneratingTransverseAberration() {
    return isGeneratingTransverseAberration;
}

// Updated setters with proper naming
export function setIsGeneratingSpotDiagram(value) {
    isGeneratingSpotDiagram = value;
}

export function setIsGeneratingTransverseAberration(value) {
    isGeneratingTransverseAberration = value;
}

export function getControls() {
    return controls;
}

export function getTableSource() {
    return tableSource;
}

export function getTableObject() {
    return tableObject;
}

export function getTableOpticalSystem() {
    return tableOpticalSystem;
}

// Initialize all references - used during application startup
export function initializeReferences(sceneRef, cameraRef, rendererRef, controlsRef, tableOpticalSystemRef, tableObjectRef, tableSourceRef) {
    scene = sceneRef;
    camera = cameraRef;
    renderer = rendererRef;
    controls = controlsRef;
    tableOpticalSystem = tableOpticalSystemRef;
    tableObject = tableObjectRef;
    tableSource = tableSourceRef;
    

}
