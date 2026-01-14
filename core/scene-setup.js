/**
 * THREE.js Scene Setup Module
 * JS_lensDraw v3 - Scene Initialization and Management
 */

import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';
import { APP_CONFIG } from './app-config.js';

/**
 * Initialize THREE.js scene, camera, renderer, and controls
 * @returns {Object} Object containing scene, camera, renderer, controls instances
 */
export function initializeThreeJS() {
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
            
            // OrthographicCameraの視野範囲を更新
            if (window.updateCameraViewBounds) {
                // 光学系のサイズに基づいて視野範囲を再計算
                console.log('📷 Calling updateCameraViewBounds from resize handler');
                window.updateCameraViewBounds();
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
    
    return { scene, camera, renderer, controls };
}

/**
 * Initialize scene lighting
 * @param {THREE.Scene} scene - The THREE.js scene
 * @returns {Object} Object containing light instances
 */
export function initializeLighting(scene) {
    
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

/**
 * Render the scene
 * @param {THREE.Scene} scene - The scene to render
 * @param {THREE.Camera} camera - The camera
 * @param {THREE.WebGLRenderer} renderer - The renderer
 * @param {OrbitControls} controls - The orbit controls
 */
export function renderScene(scene, camera, renderer, controls) {
    controls.update();
    renderer.render(scene, camera);
}

/**
 * Animation loop setup
 * @param {THREE.Scene} scene - The scene to render
 * @param {THREE.Camera} camera - The camera
 * @param {THREE.WebGLRenderer} renderer - The renderer
 * @param {OrbitControls} controls - The orbit controls
 */
export function setupAnimationLoop(scene, camera, renderer, controls) {
    function animate() {
        requestAnimationFrame(animate);
        renderScene(scene, camera, renderer, controls);
    }
    animate();
}

/**
 * Start the animation loop with global variables from app-config
 */
export function animate() {

    
    function animationLoop() {
        requestAnimationFrame(animationLoop);
        
        // Get global references
        const scene = window.scene;
        const camera = window.camera;
        const renderer = window.renderer;
        const controls = window.controls;
        
        if (scene && camera && renderer && controls) {
            // Update controls
            controls.update();
            
            // Render the scene
            renderer.render(scene, camera);
        }
    }
    
    animationLoop();
}
