// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

/**
 * THREE.js Scene Setup Module
 * JS_lensDraw v3 - Scene Initialization and Management
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.ts';
import { APP_CONFIG, type AppConfig } from './app-config.ts';

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

export interface SceneComponents {
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
}

export interface LightComponents {
    ambientLight: THREE.AmbientLight;
    directionalLight: THREE.DirectionalLight;
}

// =============================================================================
// SCENE INITIALIZATION
// =============================================================================

/**
 * Initialize THREE.js scene, camera, renderer, and controls
 * @returns Object containing scene, camera, renderer, controls instances
 */
export function initializeThreeJS(): SceneComponents {
    // Get container size dynamically
    const container = document.getElementById('threejs-canvas-container');
    const width = container ? container.clientWidth : APP_CONFIG.CANVAS_WIDTH;
    const height = container ? container.clientHeight : APP_CONFIG.CANVAS_HEIGHT;
    const aspect = width / height;
    const viewSize = APP_CONFIG.VIEW_SIZE;
    
    // Create scene
    const scene = new THREE.Scene();
    scene.userData = scene.userData || {};
    scene.userData.renderContext = {
        three: THREE,
        global: typeof window !== 'undefined' ? window : globalThis
    };
    
    // Create orthographic camera
    const camera = new THREE.OrthographicCamera(
        -viewSize * aspect / 2,
        viewSize * aspect / 2,
        viewSize / 2,
        -viewSize / 2,
        APP_CONFIG.CAMERA_CLIP_NEAR,
        APP_CONFIG.CAMERA_CLIP_FAR
    );
    
    // Create renderer
    const renderer = new THREE.WebGLRenderer({ 
        antialias: true, 
        alpha: true,  // Enable transparent background
        precision: 'highp',  // Use high precision for better rendering
        logarithmicDepthBuffer: true  // Better depth buffer for large scenes
    });
    
    // Set device pixel ratio for high-resolution displays
    renderer.setPixelRatio(window.devicePixelRatio);
    
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x000000, 0); // Set transparent background
    renderer.sortObjects = false; // Disable sorting for better performance
    renderer.shadowMap.enabled = false; // Disable shadows for better performance
    
    // Attach renderer to DOM
    if (container) {
        container.appendChild(renderer.domElement);
        // Set canvas style to fill container
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
    }
    
    // Create orbit controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = true;
    controls.enableZoom = true;
    controls.maxDistance = 5000;  // Maximum zoom out distance
    controls.minDistance = 10;    // Minimum zoom in distance
    controls.enableRotate = true;
    controls.enablePan = true;
    
    // Set initial camera position
    camera.position.set(
        APP_CONFIG.CAMERA_INITIAL_POSITION.x,
        APP_CONFIG.CAMERA_INITIAL_POSITION.y,
        APP_CONFIG.CAMERA_INITIAL_POSITION.z
    );
    camera.lookAt(
        APP_CONFIG.CAMERA_INITIAL_TARGET.x,
        APP_CONFIG.CAMERA_INITIAL_TARGET.y,
        APP_CONFIG.CAMERA_INITIAL_TARGET.z
    );
    controls.target.set(
        APP_CONFIG.CAMERA_INITIAL_TARGET.x,
        APP_CONFIG.CAMERA_INITIAL_TARGET.y,
        APP_CONFIG.CAMERA_INITIAL_TARGET.z
    );
    controls.update();
    
    // Force camera projection matrix update
    camera.updateProjectionMatrix();
    
    // Add window resize listener
    window.addEventListener('resize', () => {
        console.log('🔄 Window resize event (scene-setup.js)');
        
        if (container) {
            const newWidth = container.clientWidth;
            const newHeight = container.clientHeight;
            
            // Update renderer
            renderer.setPixelRatio(window.devicePixelRatio);
            renderer.setSize(newWidth, newHeight, false);
            renderer.domElement.style.width = '100%';
            renderer.domElement.style.height = '100%';
            
