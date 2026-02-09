/**
 * Debug Utilities Module
 * JS_lensDraw v3 - Debugging and Scene Analysis Functions
 */

import * as THREE from 'three';
import { getWASMSystem } from '../main.ts';

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
