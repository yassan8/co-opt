/**
 * Three.js Scene Management Module
 * Three.jsのシーン、カメラ、レンダラーを管理
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class SceneManager {
    scene: THREE.Scene | null;
    camera: THREE.OrthographicCamera | THREE.PerspectiveCamera | null;
    renderer: THREE.WebGLRenderer | null;
    controls: OrbitControls | null;
    container: HTMLElement | null;
    
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.container = null;
        
        this.initializeScene();
    }
    
    initializeScene(): void {
        // シーンの作成
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0xf0f0f0);
        
        // カメラの設定
        this.setupCamera();
        
        // レンダラーの設定
        this.setupRenderer();
        
        // コントロールの設定
        this.setupControls();
        
        // ライトの設定
        this.setupLights();
        
        // 座標軸の表示
        this.addAxisHelper();
        
        console.log('✅ Scene Manager initialized');
    }
    
    setupCamera(): void {
        // コンテナのサイズを取得（まだない場合はデフォルト値）
        const container = document.getElementById('threejs-canvas-container');
        const width = container ? container.clientWidth : 800;
        const height = container ? container.clientHeight : 600;
        const viewSize = 200;
        const aspectRatio = width / height;
        
        this.camera = new THREE.OrthographicCamera(
            -viewSize * aspectRatio / 2, viewSize * aspectRatio / 2,
            viewSize / 2, -viewSize / 2,
            1, 2000
        );
        
        this.camera.position.set(100, 100, 100);
        this.camera.lookAt(0, 0, 100);
        this.camera.up.set(0, 1, 0);
    }
    
    setupRenderer(): void {
        this.renderer = new THREE.WebGLRenderer({ 
            antialias: true,
            preserveDrawingBuffer: true 
        });
        
        // デバイスピクセル比を設定（高解像度ディスプレイ対応）
        this.renderer.setPixelRatio(window.devicePixelRatio);
        
        // コンテナに追加
        this.container = document.getElementById('threejs-canvas-container');
        if (this.container) {
            this.container.innerHTML = '';
            this.container.appendChild(this.renderer.domElement);
            
            // 初期サイズ設定（DOMレンダリング後に実行）
            requestAnimationFrame(() => {
                this.updateRendererSize();
            });
            
            // ウィンドウリサイズイベントを監視
            window.addEventListener('resize', () => this.onWindowResize());
        } else {
            // コンテナがない場合はデフォルトサイズ
            this.renderer.setSize(800, 600);
        }
        
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    
    updateRendererSize(): void {
        console.log('📐 updateRendererSize called');
        console.log('📐 this.container:', !!this.container);
        console.log('📐 this.renderer:', !!this.renderer);
        console.log('📐 this.camera:', !!this.camera);
        
        if (this.container && this.renderer && this.camera) {
            const width = this.container.clientWidth;
            const height = this.container.clientHeight;
            
            console.log(`📐 Container size: ${width}x${height}`);
            
            // デバイスピクセル比を再設定（リサイズ時も高解像度を維持）
            this.renderer.setPixelRatio(window.devicePixelRatio);
            
            // レンダラーサイズを更新（第3引数falseでCSSスタイルを更新しない）
            this.renderer.setSize(width, height, false);
            
            // キャンバス要素のスタイルを直接設定（コンテナいっぱいに広げる）
            this.renderer.domElement.style.width = '100%';
            this.renderer.domElement.style.height = '100%';
            
            console.log('📐 Camera type check: isOrthographicCamera =', (this.camera as any).isOrthographicCamera);
            
            // OrthographicCameraの場合、光学系がロード済みなら視野範囲を再計算
            if ((this.camera as any).isOrthographicCamera) {
                console.log('📐 Is OrthographicCamera');
                console.log('📐 window.updateCameraViewBounds:', typeof (window as any).updateCameraViewBounds);
                
                // 光学系がロード済みで、updateCameraViewBounds関数が利用可能な場合
                if ((window as any).updateCameraViewBounds) {
                    try {
                        // 光学系のサイズに基づいて視野範囲のみを再計算（カメラ位置は変更しない）
                        console.log('📷 Calling updateCameraViewBounds for resized window...');
                        (window as any).updateCameraViewBounds();
                        console.log('📷 updateCameraViewBounds completed');
                    } catch (error) {
                        console.error('❌ Error in updateCameraViewBounds:', error);
                        this.camera.updateProjectionMatrix();
                    }
                } else {
                    console.log('📷 updateCameraViewBounds not available, updating projection matrix only');
                    // 関数が利用できない場合は投影行列のみ更新
                    this.camera.updateProjectionMatrix();
                }
            } else {
                console.log('📐 Not OrthographicCamera, updating aspect ratio');
                // PerspectiveCameraの場合はアスペクト比を更新
                if (this.camera instanceof THREE.PerspectiveCamera) {
                    this.camera.aspect = width / height;
                }
                this.camera.updateProjectionMatrix();
            }
            
            console.log(`📐 Canvas resized to: ${width}x${height} (pixelRatio: ${window.devicePixelRatio})`);
        } else {
            console.log('📐 updateRendererSize: condition not met - container/renderer/camera missing');
        }
    }
    
    onWindowResize(): void {
        console.log('🔄 Window resize event triggered');
        console.log('🔍 Checking window.updateCameraViewBounds:', typeof (window as any).updateCameraViewBounds);
        this.updateRendererSize();
    }
    
    setupControls(): void {
        if (this.camera && this.renderer) {
            this.controls = new OrbitControls(this.camera, this.renderer.domElement);
            this.controls.enableDamping = true;
            this.controls.dampingFactor = 0.05;
            this.controls.target.set(0, 0, 100);
            this.controls.update();
        }
    }
    
    setupLights(): void {
        if (!this.scene) return;
        
        // 環境光
        const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
        this.scene.add(ambientLight);
        
        // 指向性ライト
        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(100, 100, 50);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        this.scene.add(directionalLight);
        
        // 補助ライト
        const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
        directionalLight2.position.set(-100, -100, -50);
        this.scene.add(directionalLight2);
    }
    
    addAxisHelper(): void {
        if (!this.scene) return;
        const axesHelper = new THREE.AxesHelper(50);
        this.scene.add(axesHelper);
    }
    
    // カメラビューの設定
    setView(viewType: string): void {
        if (!this.camera || !this.controls) return;
        
        switch (viewType) {
            case 'xz':
                this.camera.position.set(0, 100, 100);
                this.camera.lookAt(0, 0, 100);
                this.camera.up.set(1, 0, 0);
                break;
            case 'yz':
                this.camera.position.set(100, 0, 100);
                this.camera.lookAt(0, 0, 100);
                this.camera.up.set(0, 1, 0);
                break;
            default:
                this.camera.position.set(100, 100, 100);
                this.camera.lookAt(0, 0, 100);
                this.camera.up.set(0, 1, 0);
        }
        this.camera.updateProjectionMatrix();
        this.controls.target.set(0, 0, 100);
        this.controls.update();
    }
    
    // レンダリング
    render(): void {
        if (!this.renderer || !this.scene || !this.camera) return;
        
        if (this.controls) {
            this.controls.update();
        }
        this.renderer.render(this.scene, this.camera);
    }
    
    // アニメーションループ
    startRenderLoop(): void {
        const animate = () => {
            requestAnimationFrame(animate);
            this.render();
        };
        animate();
    }
    
    // シーンクリア
    clearScene(): void {
        if (!this.scene) return;
        
        const elementsToRemove: THREE.Object3D[] = [];
        this.scene.traverse((child) => {
            if (child.userData && (
                child.userData.isLensSurface ||
                child.userData.type === 'ray' ||
                child.userData.isOpticalElement
            )) {
                elementsToRemove.push(child);
            }
        });
        
        elementsToRemove.forEach(element => {
            if (this.scene) {
                this.scene.remove(element);
            }
            if ((element as any).geometry) (element as any).geometry.dispose();
            if ((element as any).material) {
                const material = (element as any).material;
                if (Array.isArray(material)) {
                    material.forEach(mat => mat.dispose());
                } else {
                    material.dispose();
                }
            }
        });
        
        console.log(`🧹 Cleared ${elementsToRemove.length} optical elements from scene`);
    }
    
    // オブジェクトをシーンに追加
    addToScene(object: THREE.Object3D): void {
        if (this.scene) {
            this.scene.add(object);
        }
    }
    
    // オブジェクトをシーンから削除
    removeFromScene(object: THREE.Object3D): void {
        if (this.scene) {
            this.scene.remove(object);
        }
    }
    
    // リサイズ処理
    onWindowResize(width: number, height: number): void {
        if (!this.camera || !this.renderer) return;
        
        const viewSize = 200;
        const aspectRatio = width / height;
        
        if (this.camera instanceof THREE.OrthographicCamera) {
            this.camera.left = -viewSize * aspectRatio / 2;
            this.camera.right = viewSize * aspectRatio / 2;
            this.camera.top = viewSize / 2;
            this.camera.bottom = -viewSize / 2;
            this.camera.updateProjectionMatrix();
        }
        
        this.renderer.setSize(width, height);
    }
}

// グローバルアクセス用のシングルトンインスタンス
let sceneManagerInstance: SceneManager | null = null;

export function getSceneManager(): SceneManager {
    if (!sceneManagerInstance) {
        sceneManagerInstance = new SceneManager();
    }
    return sceneManagerInstance;
}

// 従来のグローバル変数との互換性のためのエクスポート
export function initializeGlobalThreeJS(): SceneManager {
    const manager = getSceneManager();
    (window as any).scene = manager.scene;
    (window as any).camera = manager.camera;
    (window as any).renderer = manager.renderer;
    (window as any).controls = manager.controls;
    
    // レンダリングループ開始
    manager.startRenderLoop();
    
    return manager;
}
