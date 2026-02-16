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
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Detect iOS devices (iPad, iPhone, iPod) including iPadOS 13+ (reported as Macintosh with touch)
 * @returns true if running on iOS/iPadOS device
 */
function isIOSLike(): boolean {
    // First check if already detected in index.html
    const w = window as any;
    if (typeof w.__cooptIOSDetected === 'boolean') {
        return w.__cooptIOSDetected;
    }
    
    // Fallback to detection
    try {
        const ua = String(navigator.userAgent || '');
        if (/iPad|iPhone|iPod/i.test(ua)) return true;
        // iPadOS 13+ reports as Macintosh with touch support
        if (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1) return true;
    } catch (_) {
        // Ignore errors in restricted environments
    }
    return false;
}

// =============================================================================
// SCENE INITIALIZATION
// =============================================================================

/**
 * Initialize THREE.js scene, camera, renderer, and controls
 * @returns Object containing scene, camera, renderer, controls instances
 */
export function initializeThreeJS(): SceneComponents {
    const isIOS = isIOSLike();
    const w = window as any;

    // Also store on window for inspection
    w.__sceneSetupIOSDetected = isIOS;
    
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
        
        // iOS-specific fix: Force synchronous layout calculation to prevent canvas position shift
        const isIOS = isIOSLike();
        if (isIOS) {
            console.log('📱 iOS detected - applying rendering fix');
            // Ensure container is displayed before measuring - use block instead of flex on iOS
            currentContainer.style.display = 'block';
            currentContainer.style.position = 'relative';
            // iOS fix: Set minimum height to prevent 0-height container
            currentContainer.style.minHeight = '600px';
            currentContainer.style.height = 'calc(100vh - 200px)';
            // Force reflow to ensure layout is calculated synchronously
            void currentContainer.offsetHeight;
            
            // iOS-specific: Log container computed style for debugging
            const containerStyle = window.getComputedStyle(currentContainer);
            console.log('📱 iOS container computed style:', {
                display: containerStyle.display,
                position: containerStyle.position,
                width: containerStyle.width,
                height: containerStyle.height,
                overflow: containerStyle.overflow,
                justifyContent: containerStyle.justifyContent
            });
        }
        
        if (renderer.domElement.parentElement !== currentContainer) {
            currentContainer.appendChild(renderer.domElement);
        }
        
        // iOS-specific fix: Get actual computed dimensions and constrain canvas strictly
        if (isIOS) {
            const rect = currentContainer.getBoundingClientRect();
            console.log('📱 iOS container rect:', {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom
            });
            
            // Use clientWidth/clientHeight as fallback if rect is 0
            const containerWidth = rect.width > 0 ? rect.width : currentContainer.clientWidth || 800;
            const containerHeight = rect.height > 0 ? rect.height : currentContainer.clientHeight || 600;
            
            console.log(`📱 iOS container dimensions: ${containerWidth}x${containerHeight}`);
            // Use updateStyle=true to separate CSS size from render buffer size
            // This prevents the canvas from exceeding container bounds
            renderer.setSize(containerWidth, containerHeight, true);
            console.log(`📱 iOS canvas size set to: ${containerWidth}x${containerHeight} (updateStyle=true)`);
            
            // Log actual canvas element attributes
            const canvas = renderer.domElement;
            console.log('📱 iOS canvas attributes:', {
                width: canvas.width,
                height: canvas.height,
                styleWidth: canvas.style.width,
                styleHeight: canvas.style.height
            });
            
            // Force canvas position reset on iOS - use absolute positioning with transform
            canvas.style.width = `${containerWidth}px`;
            canvas.style.height = `${containerHeight}px`;
            canvas.style.position = 'absolute';
            canvas.style.left = '50%';
            canvas.style.top = '50%';
            canvas.style.transform = 'translate(-50%, -50%)';
            canvas.style.webkitTransform = 'translate(-50%, -50%)';
            canvas.style.maxWidth = '100%';
            canvas.style.maxHeight = '100%';
            console.log(`📱 iOS canvas styled: ${containerWidth}px x ${containerHeight}px, positioned absolute with transform`);
            
            // Log canvas position after a short delay to see if it changes
            setTimeout(() => {
                const canvasRect = canvas.getBoundingClientRect();
                console.log('📱 iOS canvas position after 100ms:', {
                    x: canvasRect.x,
                    y: canvasRect.y,
                    width: canvasRect.width,
                    height: canvasRect.height,
                    left: canvasRect.left,
                    right: canvasRect.right
                });
                
                const canvasComputedStyle = window.getComputedStyle(canvas);
                console.log('📱 iOS canvas computed style:', {
                    position: canvasComputedStyle.position,
                    left: canvasComputedStyle.left,
                    top: canvasComputedStyle.top,
                    transform: canvasComputedStyle.transform,
                    width: canvasComputedStyle.width,
                    height: canvasComputedStyle.height
                });
            }, 100);
            
            console.log('📱 iOS canvas positioned - CSS transform will center');
        } else {
            // Non-iOS: use percentage-based sizing
            renderer.domElement.style.width = '100%';
            renderer.domElement.style.height = '100%';
        }
        
        container = currentContainer;
        return currentContainer;
    };
    
    // Attach renderer to DOM - with delayed re-initialization
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
        const isIOS = isIOSLike();
        console.log(`🔄 Window resize event (scene-setup.js)${isIOS ? ' [iOS]' : ''}`);

        const currentContainer = attachRendererToContainer();

        if (currentContainer) {
            const newWidth = currentContainer.clientWidth;
            const newHeight = currentContainer.clientHeight;
            if (isIOS) {
                console.log(`📱 iOS resize - container: ${newWidth}x${newHeight}, devicePixelRatio: ${window.devicePixelRatio}`);
            }
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
