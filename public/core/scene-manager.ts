/**
 * Three.js Scene Management Module
 * Three.jsのシーン、カメラ、レンダラーを管理
 */

import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';

export class SceneManager {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.container = null;
        
        this.initializeScene();
    }
    
    initializeScene() {
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
    
    setupCamera() {
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
    
    setupRenderer() {
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
    
    updateRendererSize() {
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
            
            console.log('📐 Camera type check: isOrthographicCamera =', this.camera.isOrthographicCamera);
            
            // OrthographicCameraの場合、光学系がロード済みなら視野範囲を再計算
            if (this.camera.isOrthographicCamera) {
                console.log('📐 Is OrthographicCamera');
                console.log('📐 window.updateCameraViewBounds:', typeof window.updateCameraViewBounds);
                
                // 光学系がロード済みで、updateCameraViewBounds関数が利用可能な場合
                if (window.updateCameraViewBounds) {
                    try {
                        // 光学系のサイズに基づいて視野範囲のみを再計算（カメラ位置は変更しない）
                        console.log('📷 Calling updateCameraViewBounds for resized window...');
                        window.updateCameraViewBounds();
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
                this.camera.aspect = width / height;
                this.camera.updateProjectionMatrix();
            }
            
            console.log(`📐 Canvas resized to: ${width}x${height} (pixelRatio: ${window.devicePixelRatio})`);
        } else {
            console.log('📐 updateRendererSize: condition not met - container/renderer/camera missing');
        }
    }
    
    onWindowResize() {
        console.log('🔄 Window resize event triggered');
        console.log('🔍 Checking window.updateCameraViewBounds:', typeof window.updateCameraViewBounds);
        this.updateRendererSize();
    }
    
    setupControls() {
        if (this.camera && this.renderer) {
            this.controls = new OrbitControls(this.camera, this.renderer.domElement);
            this.controls.enableDamping = true;
            this.controls.dampingFactor = 0.05;
            this.controls.target.set(0, 0, 100);
            this.controls.update();
        }
    }
    
    setupLights() {
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
    
    addAxisHelper() {
        const axesHelper = new THREE.AxesHelper(50);
        this.scene.add(axesHelper);
    }
    
    // カメラビューの設定
    setView(viewType) {
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
    render() {
        if (this.controls) {
            this.controls.update();
        }
        this.renderer.render(this.scene, this.camera);
    }
    
    // アニメーションループ
    startRenderLoop() {
        const animate = () => {
            requestAnimationFrame(animate);
            this.render();
        };
        animate();
    }
    
    // シーンクリア
    clearScene() {
        const elementsToRemove = [];
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
            this.scene.remove(element);
            if (element.geometry) element.geometry.dispose();
            if (element.material) {
                if (Array.isArray(element.material)) {
                    element.material.forEach(mat => mat.dispose());
                } else {
                    element.material.dispose();
                }
            }
        });
        
        console.log(`🧹 Cleared ${elementsToRemove.length} optical elements from scene`);
    }
    
    // オブジェクトをシーンに追加
    addToScene(object) {
        this.scene.add(object);
    }
    
    // オブジェクトをシーンから削除
    removeFromScene(object) {
        this.scene.remove(object);
    }
    
    // リサイズ処理
    onWindowResize(width, height) {
        const viewSize = 200;
        const aspectRatio = width / height;
        
        this.camera.left = -viewSize * aspectRatio / 2;
        this.camera.right = viewSize * aspectRatio / 2;
        this.camera.top = viewSize / 2;
        this.camera.bottom = -viewSize / 2;
        this.camera.updateProjectionMatrix();
        
        this.renderer.setSize(width, height);
    }
}

// グローバルアクセス用のシングルトンインスタンス
let sceneManagerInstance = null;

export function getSceneManager() {
    if (!sceneManagerInstance) {
        sceneManagerInstance = new SceneManager();
    }
    return sceneManagerInstance;
}

// 従来のグローバル変数との互換性のためのエクスポート
export function initializeGlobalThreeJS() {
    const manager = getSceneManager();
    try {
        // Prefer the shared rendering context (keeps debug globals owned in one place).
        if (typeof window !== 'undefined' && typeof window.__cooptSetRenderingContext === 'function') {
            window.__cooptSetRenderingContext({
                scene: manager.scene,
                camera: manager.camera,
                renderer: manager.renderer,
                controls: manager.controls
            });
        }
    } catch (_) {}
    
    // レンダリングループ開始
    manager.startRenderLoop();
    
    return manager;
}
