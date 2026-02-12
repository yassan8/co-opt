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
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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
    let container = document.getElementById('threejs-canvas-container');
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

    const attachRendererToContainer = (): HTMLElement | null => {
        const currentContainer = document.getElementById('threejs-canvas-container');
        if (!currentContainer) {
            return null;
        }
        if (renderer.domElement.parentElement !== currentContainer) {
            currentContainer.appendChild(renderer.domElement);
        }
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        container = currentContainer;
        return currentContainer;
    };
    
    // Attach renderer to DOM
    const initialContainer = attachRendererToContainer();
    if (initialContainer && initialContainer.clientWidth > 0 && initialContainer.clientHeight > 0) {
        renderer.setSize(initialContainer.clientWidth, initialContainer.clientHeight, false);
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

        const currentContainer = attachRendererToContainer();

        if (currentContainer) {
            const newWidth = currentContainer.clientWidth;
            const newHeight = currentContainer.clientHeight;
            if (newWidth <= 0 || newHeight <= 0) {
                return;
            }
            
            // Update renderer
            renderer.setPixelRatio(window.devicePixelRatio);
            renderer.setSize(newWidth, newHeight, false);
            renderer.domElement.style.width = '100%';
            renderer.domElement.style.height = '100%';
            
            // OrthographicCameraの視野範囲を更新
            if (w.updateCameraViewBounds) {
                // 光学系のサイズに基づいて視野範囲を再計算
                console.log('📷 Calling updateCameraViewBounds from resize handler');
                w.updateCameraViewBounds();
            } else {
                // フォールバック: 固定viewSizeを使用（光学系ロード前）
                const newAspect = newWidth / newHeight;
                camera.left = -viewSize * newAspect / 2;
                camera.right = viewSize * newAspect / 2;
                camera.top = viewSize / 2;
                camera.bottom = -viewSize / 2;
                camera.updateProjectionMatrix();
            }
            
            console.log(`Canvas resized to: ${newWidth}x${newHeight} (pixelRatio: ${window.devicePixelRatio})`);
        }
    });

    window.addEventListener('coopt:react-mounted', () => {
        const currentContainer = attachRendererToContainer();
        if (!currentContainer) {
            return;
        }
        const newWidth = currentContainer.clientWidth;
        const newHeight = currentContainer.clientHeight;
        if (newWidth <= 0 || newHeight <= 0) {
            return;
        }
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(newWidth, newHeight, false);
    });
    
    return { scene, camera, renderer, controls };
}

// =============================================================================
// LIGHTING SETUP
// =============================================================================

/**
 * Initialize scene lighting
 * @param scene - The THREE.js scene
 * @returns Object containing light instances
 */
export function initializeLighting(scene: THREE.Scene): LightComponents {
    try {
        // Ambient light
        const ambientLight = new THREE.AmbientLight(0xffffff, APP_CONFIG.AMBIENT_LIGHT_INTENSITY);
        scene.add(ambientLight);
        
        // Directional light
        const directionalLight = new THREE.DirectionalLight(0xffffff, APP_CONFIG.DIRECTIONAL_LIGHT_INTENSITY);
        directionalLight.position.set(
            APP_CONFIG.DIRECTIONAL_LIGHT_POSITION.x,
            APP_CONFIG.DIRECTIONAL_LIGHT_POSITION.y,
            APP_CONFIG.DIRECTIONAL_LIGHT_POSITION.z
        );
        scene.add(directionalLight);
        return { ambientLight, directionalLight };
    } catch (error) {
        console.error('❌ Error initializing lighting:', error);
        throw error;
    }
}

// =============================================================================
// RENDERING
// =============================================================================

/**
 * Render the scene
 * @param scene - The scene to render
 * @param camera - The camera
 * @param renderer - The renderer
 * @param controls - The orbit controls
 */
export function renderScene(
    scene: THREE.Scene,
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
    controls: OrbitControls
): void {
    controls.update();
    renderer.render(scene, camera);
}

/**
 * Animation loop setup
 * @param scene - The scene to render
 * @param camera - The camera
 * @param renderer - The renderer
 * @param controls - The orbit controls
 */
export function setupAnimationLoop(
    scene: THREE.Scene,
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
    controls: OrbitControls
): void {
    function animate(): void {
        requestAnimationFrame(animate);
        renderScene(scene, camera, renderer, controls);
    }
    animate();
}

/**
 * Start the animation loop with global variables from app-config
 */
export function animate(): void {
    function animationLoop(): void {
        requestAnimationFrame(animationLoop);
        
        // Get global references
        const scene = w.scene as THREE.Scene | undefined;
        const camera = w.camera as THREE.Camera | undefined;
        const renderer = w.renderer as THREE.WebGLRenderer | undefined;
        const controls = w.controls as OrbitControls | undefined;
        
        if (scene && camera && renderer && controls) {
            // Update controls
            controls.update();
            
            // Render the scene
            renderer.render(scene, camera);
        }
    }
    
    animationLoop();
}
