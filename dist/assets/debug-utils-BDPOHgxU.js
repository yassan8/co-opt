/**
 * Debug Utilities Module
 * JS_lensDraw v3 - Debugging and Scene Analysis Functions
 */

import * as THREE from 'three';
import { getWASMSystem } from '../main.js';

/**
 * Debug scene contents
 * @param {THREE.Scene} scene - The THREE.js scene
 * @param {THREE.Camera} camera - The camera
 * @param {OrbitControls} controls - The orbit controls
 */
export function debugSceneContents(scene, camera, controls) {
  console.log('🔍 === Scene Debug Info ===');
  console.log(`Total children: ${scene.children.length}`);
  console.log(
    `Camera position: (${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`
  );
  console.log(
    `Camera target: (${controls.target.x.toFixed(2)}, ${controls.target.y.toFixed(2)}, ${controls.target.z.toFixed(2)})`
  );

  // Calculate scene bounding box
  const box = new THREE.Box3().setFromObject(scene);
  if (!box.isEmpty()) {
    console.log('Scene bounding box:');
    console.log(
      `  Min: (${box.min.x.toFixed(2)}, ${box.min.y.toFixed(2)}, ${box.min.z.toFixed(2)})`
    );
    console.log(
      `  Max: (${box.max.x.toFixed(2)}, ${box.max.y.toFixed(2)}, ${box.max.z.toFixed(2)})`
    );
    console.log(
      `  Size: (${(box.max.x - box.min.x).toFixed(2)}, ${(box.max.y - box.min.y).toFixed(2)}, ${(box.max.z - box.min.z).toFixed(2)})`
    );
  }

  let meshCount = 0;
  let lineCount = 0;
  let lightCount = 0;
  let otherCount = 0;

  scene.children.forEach((child) => {
    if (child.isMesh) {
      meshCount++;
      console.log(
        `  Mesh ${meshCount}: pos(${child.position.x.toFixed(2)}, ${child.position.y.toFixed(2)}, ${child.position.z.toFixed(2)}), scale(${child.scale.x.toFixed(2)}, ${child.scale.y.toFixed(2)}, ${child.scale.z.toFixed(2)})`
      );
    } else if (child.isLine) {
      lineCount++;
    } else if (child.isLight) {
      lightCount++;
    } else {
      otherCount++;
    }
  });

  console.log(`Mesh objects: ${meshCount}`);
  console.log(`Line objects: ${lineCount}`);
  console.log(`Light objects: ${lightCount}`);
  console.log(`Other objects: ${otherCount}`);
  console.log('=================');
}

/**
 * 描画問題をデバッグする関数
 * @param {THREE.Scene} scene - The THREE.js scene
 * @param {THREE.Camera} camera - The camera
 * @param {OrbitControls} controls - The orbit controls
 */
export function debugDrawingIssues(scene, camera, controls) {
  console.log('🔍 Debugging drawing issues...');

  if (scene) {
    console.log('📊 Scene objects:', scene.children.length);
    scene.children.forEach((child, index) => {
      console.log(`   Object ${index}: ${child.type}, visible: ${child.visible}`);
      if (child.name) console.log(`     Name: ${child.name}`);
      if (child.position) {
        console.log(
          `     Position: (${child.position.x.toFixed(2)}, ${child.position.y.toFixed(2)}, ${child.position.z.toFixed(2)})`
        );
      }
      if (child.scale) {
        console.log(
          `     Scale: (${child.scale.x.toFixed(2)}, ${child.scale.y.toFixed(2)}, ${child.scale.z.toFixed(2)})`
        );
      }
    });
  }

  if (camera) {
    console.log('📷 Camera position:', camera.position);
    console.log('📷 Camera target:', controls?.target);
  }
}

/**
 * カメラビューを調整する関数
 * @param {THREE.Scene} scene - The THREE.js scene
 * @param {THREE.Camera} camera - The camera
 * @param {OrbitControls} controls - The orbit controls
 * @param {THREE.WebGLRenderer} renderer - The renderer
 */
export function adjustCameraView(scene, camera, controls, renderer) {
  console.log('📷 Adjusting camera view...');

  if (!camera || !controls) {
    console.warn('⚠️ Camera or controls not found');
    return;
  }

  const box = new THREE.Box3();
  const objectsInScene = [];

  scene.children.forEach((child) => {
    if (child.isMesh || child.isLine || child.isGroup) {
      if (child.type !== 'DirectionalLight' && child.type !== 'AmbientLight') {
        objectsInScene.push(child);
        box.expandByObject(child);
      }
    }
  });

  if (objectsInScene.length === 0) {
    console.warn('⚠️ No objects found in scene');
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  const minOpticalSize = 100;
  const expandedSize = new THREE.Vector3(
    Math.max(size.x, minOpticalSize),
    Math.max(size.y, minOpticalSize),
    size.z
  );

  const maxDimension = Math.max(expandedSize.x, expandedSize.y, expandedSize.z);

  console.log(
    `📊 Scene bounds: center(${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`
  );
  console.log(`📊 Original size: (${size.x.toFixed(2)}, ${size.y.toFixed(2)}, ${size.z.toFixed(2)})`);
  console.log(
    `📊 Expanded size: (${expandedSize.x.toFixed(2)}, ${expandedSize.y.toFixed(2)}, ${expandedSize.z.toFixed(2)})`
  );
  console.log(`📊 Max dimension: ${maxDimension.toFixed(2)}`);

  const distance = maxDimension * 1.5;
  const cameraPosition = new THREE.Vector3(center.x, center.y, center.z + distance);

  camera.position.copy(cameraPosition);
  controls.target.copy(center);
  controls.update();

  if (camera.isOrthographicCamera) {
    const aspect = camera.right / camera.top;
    const viewSize = maxDimension * 0.6;

    camera.left = (-viewSize * aspect) / 2;
    camera.right = (viewSize * aspect) / 2;
    camera.top = viewSize / 2;
    camera.bottom = -viewSize / 2;
    camera.updateProjectionMatrix();

    console.log(`📷 Updated orthographic camera view size: ${viewSize.toFixed(2)}`);
  }

  console.log(
    `📷 Camera moved to: (${cameraPosition.x.toFixed(2)}, ${cameraPosition.y.toFixed(2)}, ${cameraPosition.z.toFixed(2)})`
  );
  console.log(`📷 Camera target: (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`);

  if (renderer) {
    renderer.render(scene, camera);
  }
}

/**
 * デバッグ用のシーンバウンディングボックスを表示
 * @param {THREE.Scene} scene - The THREE.js scene
 * @param {THREE.WebGLRenderer} renderer - The renderer
 * @param {THREE.Camera} camera - The camera
 */
export function showSceneBoundingBox(scene, renderer, camera) {
  console.log('📦 Showing scene bounding box...');
  if (!scene) return;

  const existingBox = scene.getObjectByName('debug-bounding-box');
  if (existingBox) scene.remove(existingBox);

  const existingCenter = scene.getObjectByName('debug-center-point');
  if (existingCenter) scene.remove(existingCenter);

  const box = new THREE.Box3();
  const objectsInScene = [];

  scene.children.forEach((child) => {
    if (child.isMesh || child.isLine || child.isGroup) {
      if (child.type !== 'DirectionalLight' && child.type !== 'AmbientLight') {
        objectsInScene.push(child);
        box.expandByObject(child);
      }
    }
  });

  if (objectsInScene.length === 0) {
    console.warn('⚠️ No objects found for bounding box');
    return;
  }

  const helper = new THREE.Box3Helper(box, 0xff0000);
  helper.name = 'debug-bounding-box';
  scene.add(helper);

  const center = box.getCenter(new THREE.Vector3());
  const centerGeometry = new THREE.SphereGeometry(1, 8, 8);
  const centerMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
  const centerMesh = new THREE.Mesh(centerGeometry, centerMaterial);
  centerMesh.position.copy(center);
  centerMesh.name = 'debug-center-point';
  scene.add(centerMesh);

  console.log(
    `📦 Bounding box created at center: (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`
  );

  if (renderer) {
    renderer.render(scene, camera);
  }
}

/**
 * WASM関連のデバッグ情報を出力
 */
export async function debugWASMSystem() {
  try {
    const wasm = await getWASMSystem();
    if (!wasm) {
      console.warn('⚠️ WASM system is not available');
      return null;
    }
    console.log('🧪 WASM system:', wasm);
    if (wasm.exports) console.log('🧪 WASM exports:', Object.keys(wasm.exports));
    return wasm;
  } catch (e) {
    console.warn('⚠️ debugWASMSystem failed:', e);
    return null;
  }
}

/**
 * Quick comparison helper (placeholder)
 */
export async function quickWASMComparison() {
  console.log('🧪 quickWASMComparison: not implemented in this build');
  return null;
}
