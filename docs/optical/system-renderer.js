/**
 * Optical system renderer for 3D visualization
 */

import * as THREE from 'three';
import { calculateSurfaceOrigins } from '../ray-tracing.js';
import { drawAsphericProfile, drawPlaneProfile, drawLensSurface, drawLensSurfaceWithOrigin,
         drawLensCrossSection, drawLensCrossSectionWithSurfaceOrigins, 
         drawSemidiaRingWithOriginAndSurface, asphericSurfaceZ, addMirrorBackText } from '../surface.js';

const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
const COORD_BREAK_DEBUG_STORAGE_KEY = 'coopt.debug.coordBreak';

function __coopt_isCoordBreakDebugEnabled() {
    try {
        const g = (typeof globalThis !== 'undefined') ? globalThis : null;
        if (g && g.__COOPT_DEBUG_COORD_BREAK) return true;
        // If running inside an iframe, allow enabling from parent.
        try {
            if (g && g.parent && g.parent !== g && g.parent.__COOPT_DEBUG_COORD_BREAK) return true;
        } catch (_) {}
        // Also allow enabling via localStorage so both parent/child frames can see it.
        try {
            if (typeof localStorage !== 'undefined') {
                const v = String(localStorage.getItem(COORD_BREAK_DEBUG_STORAGE_KEY) ?? '').trim();
                if (v && v !== '0' && v.toLowerCase() !== 'false') return true;
            }
        } catch (_) {}
    } catch (_) {}
    return false;
}

function __coopt_isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function __coopt_parseColorToInt(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (/^0x[0-9a-fA-F]{6}$/.test(s)) return parseInt(s.slice(2), 16);
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return parseInt(s.slice(1), 16);
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function __coopt_surfaceColorKey(surface, index0) {
    try {
        const bid = String(surface?._blockId ?? '').trim();
        const role = String(surface?._surfaceRole ?? '').trim();
        if (bid && role) return `p:${bid}|${role}`;
    } catch (_) {}

    try {
        const sid = Number(surface?.id);
        if (Number.isFinite(sid)) return `id:${Math.floor(sid)}`;
    } catch (_) {}

    return `i:${Math.floor(Number(index0) || 0)}`;
}

function __coopt_loadSurfaceColorOverrides() {
    try {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return __coopt_isPlainObject(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

/**
 * Draw optical system surfaces
 * @param {Object} options - Drawing options
 * @param {boolean} options.crossSectionOnly - Only draw cross-sections
 * @param {THREE.Scene} options.scene - Three.js scene
 * @param {boolean} options.showSurfaceOrigins - Show surface origins
 * @param {boolean} options.showSemidiaRing - Show semidia rings
 * @param {boolean} options.showMirrorBackText - Show mirror back text
 * @param {string} options.crossSectionDirection - Cross-section direction (YZ or XZ)
 * @param {number} options.crossSectionCenterOffset - Center offset for cross-section
 * @param {Array} options.opticalSystemData - Optical system data
 */
export function drawOpticalSystemSurfaces(options = {}) {
    const {
        crossSectionOnly = false,
        scene,
        showSurfaceOrigins = false,
        showSemidiaRing = false,
        showMirrorBackText = false,
        crossSectionDirection = 'YZ',
        viewPlane = null,
        crossSectionCenterOffset = 0,
        opticalSystemData
    } = options;

    // viewPlaneパラメータをcrossSectionDirectionに変換
    const actualCrossSectionDirection = viewPlane ? viewPlane.toUpperCase() : crossSectionDirection;

    if (!scene) {
        console.error('Scene not provided to drawOpticalSystemSurfaces');
        return;
    }

    if (!opticalSystemData || opticalSystemData.length === 0) {
        console.error('💡 光学系データが取得できません。JSONファイルをロードしてください。');
        alert('光学系データがありません。JSONファイルをロードしてください。');
        return;
    }

    console.log(`📊 Using optical system data: ${opticalSystemData.length} surfaces`);
    console.log('🔍 Optical system data preview:', opticalSystemData.slice(0, 3));
    console.log('🔍 Cross-section only mode:', crossSectionOnly);

    // Clear existing optical elements before drawing new ones
    clearExistingOpticalElements(scene);

    // Surface origins calculation - NOW with the correct parameter
    const surfaceOrigins = calculateSurfaceOrigins(opticalSystemData);
    console.log('🔍 Surface origins calculated:', surfaceOrigins ? surfaceOrigins.length : 'None');

    // Opt-in Coord Break debug: helps verify that decenter params are numeric at render time.
    try {
        const DEBUG_CB = __coopt_isCoordBreakDebugEnabled();
        if (DEBUG_CB && Array.isArray(surfaceOrigins)) {
            console.log('🧭 [CO-OPT] Coord Break debug enabled');
            const cbRows = [];
            for (let i = 0; i < opticalSystemData.length; i++) {
                const row = opticalSystemData[i];
                if (!row) continue;
                if (String(row.surfType || '') !== 'Coord Break') continue;
                const origin = surfaceOrigins[i]?.origin;
                const cbParams = surfaceOrigins[i]?.cbParams;
                cbRows.push({
                    i,
                    blockId: row._blockId || null,
                    raw: {
                        semidia: row.semidia,
                        material: row.material,
                        thickness: row.thickness,
                        rindex: row.rindex,
                        abbe: row.abbe,
                        conic: row.conic,
                        coef1: row.coef1,
                        decenterX: row.decenterX,
                        decenterY: row.decenterY,
                        decenterZ: row.decenterZ,
                        tiltX: row.tiltX,
                        tiltY: row.tiltY,
                        tiltZ: row.tiltZ,
                        order: row.order
                    },
                    parsed: cbParams || null,
                    origin: origin ? { x: origin.x, y: origin.y, z: origin.z } : null
                });
            }
            if (cbRows.length) {
                const tableRows = cbRows.map(r => ({
                    i: r.i,
                    blockId: r.blockId,
                    raw_material: r.raw.material,
                    raw_semidia: r.raw.semidia,
                    raw_thickness: r.raw.thickness,
                    decX: r.parsed?.decenterX,
                    decY: r.parsed?.decenterY,
                    decZ: r.parsed?.decenterZ,
                    tiltX: r.parsed?.tiltX,
                    tiltY: r.parsed?.tiltY,
                    tiltZ: r.parsed?.tiltZ,
                    order: r.parsed?.transformOrder,
                    ox: r.origin?.x,
                    oy: r.origin?.y,
                    oz: r.origin?.z
                }));

                // Print table outside of groups so it's visible even when groups are collapsed.
                console.table(tableRows);

                console.groupCollapsed(`🧭 [CO-OPT] Coord Break debug (${cbRows.length} rows)`);
                for (const r of tableRows) {
                    console.log('🧭 [CO-OPT] CB row:', JSON.stringify(r));
                }
                console.log(cbRows);
                console.groupEnd();
            }
        }
    } catch (_) {}

    const surfaceColorOverrides = __coopt_loadSurfaceColorOverrides();
    
    // Debug: Show all surface origins
    if (surfaceOrigins) {
        console.log('🔍 All surface origins:');
        surfaceOrigins.forEach((surfaceInfo, index) => {
            const origin = surfaceInfo?.origin;
            console.log(`  Surface ${index}: (${origin?.x?.toFixed(3) || 'undefined'}, ${origin?.y?.toFixed(3) || 'undefined'}, ${origin?.z?.toFixed(3) || 'undefined'})`);
        });
    }

    // Draw 3D surfaces (skip if crossSectionOnly is true)
    if (!crossSectionOnly) {
        console.log('🎨 Starting 3D surface drawing...');
        for (let i = 0; i < opticalSystemData.length; i++) {
            const surface = opticalSystemData[i];
            
            console.log(`🔍 Processing surface ${i}: type=${surface.type}, conic=${surface.conic}`);
            
            // Object面のスキップ判定
            const objectType = surface["object type"] || "";
            if (objectType === "Object") {
                const objectThickness = surface.thickness;
                const isInfiniteThickness = objectThickness === 'INF' || objectThickness === 'Infinity' || objectThickness === Infinity;
                
                if (isInfiniteThickness) {
                    // Objectデータを取得してangle判定も行う
                    let isAngleObject = false;
                    try {
                        const objectRows = window.getObjectRows ? window.getObjectRows() : [];
                        if (objectRows && objectRows.length > 0) {
                            const firstObject = objectRows[0];
                            const position = firstObject.position || (Array.isArray(firstObject) ? firstObject[3] : null);
                            isAngleObject = position === 'angle' || position === 'Angle';
                            console.log(`🔍 3D Surface ${i}: Object position判定 - position=${position}, isAngleObject=${isAngleObject}`);
                        }
                    } catch (error) {
                        console.warn(`⚠️ 3D Surface ${i}: Object data取得エラー:`, error);
                    }
                    
                    if (isAngleObject) {
                        console.log(`🔸 3D Surface ${i}: Object面（無限系 + angle）、3D描画スキップ`);
                        continue;
                    } else {
                        console.log(`🔸 3D Surface ${i}: Object面（無限系 but not angle）、3D描画実行`);
                    }
                } else {
                    console.log(`🔸 3D Surface ${i}: Object面（有限系、thickness=${objectThickness}）、3D描画実行`);
                }
            }

            // Coord Break surfaces are transform-only and must not be drawn in 3D.
            const surfType = String(surface?.surfType ?? '').trim();
            if (surfType === 'Coord Break' || surfType === 'Coordinate Break' || surfType === 'CB') {
                console.log(`🔸 3D Surface ${i}: Coord Break (${surfType})、3D描画スキップ`);
                continue;
            }
            
            try {
                if (surface.type === 'Stop' || surface['object type'] === 'Stop') {
                    // Stop面の場合は特別な処理
                    console.log(`🟢 Drawing Stop surface ${i}`);
                    if (showSemidiaRing) {
                        console.log(`⭕ Drawing Stop ring for surface ${i}, semidia: ${surface.semidia}`);
                        try {
                            drawSemidiaRingWithOriginAndSurface(
                                scene, 
                                surface.semidia || 20,   // semidia値
                                100,                     // segments
                                0x000000,               // color (黒)
                                surfaceOrigins[i]?.origin || {x: 0, y: 0, z: 0},       // origin オブジェクト
                                surfaceOrigins[i]?.rotationMatrix || null,            // rotationMatrix
                                surface                  // surf オブジェクト
                            );
                            console.log(`✅ Stop ring drawn for surface ${i}`);
                        } catch (stopRingError) {
                            console.error(`❌ Error drawing Stop ring for surface ${i}:`, stopRingError);
                        }
                    }
                } else if (surface.type === 'Mirror') {
                    // Mirror面の処理
                    console.log(`🪞 Drawing 3D Mirror surface ${i} with origin and rotation`);
                    const mirrorDefaultColor = 0xc0c0c0;
                    const mirrorKey = __coopt_surfaceColorKey(surface, i);
                    const mirrorOverride = __coopt_parseColorToInt(surfaceColorOverrides?.[mirrorKey]);
                    const mirrorColor = (mirrorOverride !== null) ? mirrorOverride : mirrorDefaultColor;
                    drawLensSurfaceWithOrigin(
                        scene, 
                        surface,                     // params オブジェクト全体
                        surfaceOrigins[i].origin,    // origin から .origin プロパティを使用
                        surfaceOrigins[i].rotationMatrix, // rotation matrix
                        "even",                      // mode
                        100,                         // segments
                        mirrorColor,                // color
                        0.8,                        // opacity
                        'Mirror'                     // surfaceType
                    );
                    
                    if (showMirrorBackText) {
                        addMirrorBackText(
                            scene, 
                            surface, 
                            surfaceOrigins[i], 
                            i
                        );
                    }
                } else {
                    // 通常のレンズ面の処理
                    console.log(`🔵 Drawing Lens surface ${i}`);
                    
                    // 3D表面を描画
                    console.log(`� Drawing 3D lens surface ${i} with origin and rotation`);
                    const lensDefaultColor = 0x00ccff;
                    const lensKey = __coopt_surfaceColorKey(surface, i);
                    const lensOverride = __coopt_parseColorToInt(surfaceColorOverrides?.[lensKey]);
                    const lensColor = (lensOverride !== null) ? lensOverride : lensDefaultColor;
                    drawLensSurfaceWithOrigin(
                        scene, 
                        surface,                     // params オブジェクト全体
                        surfaceOrigins[i].origin,    // origin から .origin プロパティを使用
                        surfaceOrigins[i].rotationMatrix, // rotation matrix
                        "even",                      // mode
                        100,                         // segments
                        lensColor,                  // color
                        0.5,                        // opacity
                        surface.type                 // surfaceType
                    );
                }
                
                // Surface origins表示（デバッグ用の追加表示のみ）
                if (showSurfaceOrigins) {
                    console.log(`📍 Drawing surface origin marker for surface ${i}`);
                    // 原点マーカーとして小さな球を描画
                    const geometry = new THREE.SphereGeometry(2, 8, 8);
                    const material = new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.8 });
                    const marker = new THREE.Mesh(geometry, material);
                    const origin = surfaceOrigins[i]?.origin || {x: 0, y: 0, z: 0};
                    marker.position.set(origin.x, origin.y, origin.z);
                    marker.userData = { type: 'surface-origin-marker', surfaceIndex: i };
                    scene.add(marker);
                }
                
                // Semidia ring表示
                if (showSemidiaRing && surface.type !== 'Stop' && surface['object type'] !== 'Stop') {
                    console.log(`⭕ Drawing semidia ring for surface ${i}, semidia: ${surface.semidia}`);
                    console.log(`⭕ Ring origin for ${i}:`, surfaceOrigins[i]);
                    console.log(`⭕ Surface type: ${surface.type}, material: ${surface.material}`);
                    
                    try {
                        drawSemidiaRingWithOriginAndSurface(
                            scene, 
                            surface.semidia || 20,   // semidia 値
                            100,                     // segments
                            0x000000,               // color (黒)
                            surfaceOrigins[i]?.origin || {x: 0, y: 0, z: 0},       // origin オブジェクト
                            surfaceOrigins[i]?.rotationMatrix || null,            // rotationMatrix
                            surface                  // surf オブジェクト
                        );
                        console.log(`✅ Semidia ring drawn for surface ${i}`);
                    } catch (ringError) {
                        console.error(`❌ Error drawing semidia ring for surface ${i}:`, ringError);
                    }
                }
            } catch (error) {
                console.error(`❌ Error drawing surface ${i}:`, error);
            }
        }
        console.log('✅ 3D surface drawing completed');
    } else {
        console.log('⏭️ Skipping 3D surface drawing (crossSectionOnly = true)');
    }

    // Draw cross-sections
    if (actualCrossSectionDirection === 'YZ') {
        drawLensCrossSectionWithSurfaceOrigins(
            scene, 
            opticalSystemData, 
            surfaceOrigins, 
            crossSectionCenterOffset
        );
    } else if (actualCrossSectionDirection === 'XZ') {
        drawLensCrossSectionWithSurfaceOrigins(
            scene, 
            opticalSystemData, 
            surfaceOrigins, 
            crossSectionCenterOffset, 
            'XZ'
        );
    }
}

/**
 * Find stop surface in optical system
 * @param {Array} opticalSystemRows - Optical system data
 * @param {Array} surfaceOrigins - Surface origins (optional)
 * @returns {Object|null} Stop surface data or null if not found
 */
export function findStopSurface(opticalSystemRows, surfaceOrigins = null) {
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        return null;
    }

    const DEBUG_STOP = !!(typeof globalThis !== 'undefined' && globalThis.__COOPT_DEBUG_STOP_SURFACE);
    if (DEBUG_STOP) {
        // 光学系データ全体をデバッグ出力
        console.log(`🔍 [findStopSurface] 光学系データ全体:`, opticalSystemRows);
        console.log(`🔍 [findStopSurface] データ数: ${opticalSystemRows.length}`);
    }
    
    for (let i = 0; i < opticalSystemRows.length; i++) {
        const surface = opticalSystemRows[i];
        // console.log(`🔍 [findStopSurface] Surface ${i}:`, surface);
        // console.log(`🔍 [findStopSurface] Surface ${i} keys:`, Object.keys(surface));
        // console.log(`🔍 [findStopSurface] Surface ${i} type:`, surface.type);
        // console.log(`🔍 [findStopSurface] Surface ${i} object type:`, surface['object type']);
        
        // 両方のフィールド名をチェック
        if (surface.type === 'Stop' || surface['object type'] === 'Stop') {
            // console.log(`🎯 [findStopSurface] Stop面発見! Surface ${i}`);
            
            // Stop面の位置を計算（CB対応）
            let stopX = 0;
            let stopY = 0;
            let stopZ = 0;
            if (surfaceOrigins && surfaceOrigins[i]) {
                // calculateSurfaceOrigins() returns entries like { origin: {x,y,z}, rotationMatrix, ... }
                const o = surfaceOrigins[i].origin || surfaceOrigins[i];
                const ox = Number(o?.x);
                const oy = Number(o?.y);
                const oz = Number(o?.z);
                if (Number.isFinite(ox)) stopX = ox;
                if (Number.isFinite(oy)) stopY = oy;
                if (Number.isFinite(oz)) stopZ = oz;
            } else {
                // surfaceOriginsが無い場合は累積距離で計算
                for (let j = 0; j < i; j++) {
                    const thickness = opticalSystemRows[j].thickness;
                    if (thickness !== undefined && thickness !== null && thickness !== 'INF' && thickness !== 'Infinity') {
                        stopZ += parseFloat(thickness) || 0;
                    }
                }
            }
            
            // stopZが数値であることを確認
            stopZ = parseFloat(stopZ) || 0;
            
            // Stop面の半径を取得（複数のフィールド名を試す）
            let stopRadius = 10; // デフォルト値
            // console.log(`🔍 [findStopSurface] Stop面データ:`, surface);
            // console.log(`🔍 [findStopSurface] Stop面の全プロパティ:`, JSON.stringify(surface, null, 2));
            
            // より多くのフィールド名を試す
            const radiusFields = [
                'semidia',          // 実際のフィールド名！
                'semiDiameter', 'semi-diameter', 'semi_diameter',
                'radius', 'aperture', 'diameter', 'semi-dia',
                'semiDia', 'aper', 'halfDiameter', 'half-diameter',
                'Clear_Aperture', 'clearAperture', 'clear_aperture'
            ];
            
            // console.log(`🔍 [findStopSurface] 半径候補チェック:`);
            for (const field of radiusFields) {
                const value = surface[field];
                // console.log(`  ${field}: ${value} (type: ${typeof value})`);
                if (value !== undefined && value !== null && value !== '') {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue)) {
                        stopRadius = numValue;
                        // console.log(`🎯 [findStopSurface] フィールド "${field}" を使用: ${stopRadius}`);
                        break;
                    }
                }
            }
            
            // 手動で設定された半径値があるかチェック
            if (window.forceStopRadius && !isNaN(window.forceStopRadius)) {
                console.log(`🔧 [findStopSurface] 手動設定の半径を使用: ${window.forceStopRadius}`);
                stopRadius = window.forceStopRadius;
            }
            
            // NaNチェック
            if (isNaN(stopRadius)) {
                console.warn(`⚠️ [findStopSurface] 半径値が無効、デフォルト値10を使用`);
                stopRadius = 10;
            }
            
            // console.log(`🔍 [findStopSurface] 最終的な半径: ${stopRadius}`);
            
            return {
                surface: surface,
                index: i,
                center: { x: stopX, y: stopY, z: stopZ },  // centerプロパティを追加（CB対応）
                position: { x: stopX, y: stopY, z: stopZ },  // 互換性のために保持
                radius: stopRadius,  // 正しい半径値を使用
                origin: surfaceOrigins ? surfaceOrigins[i] : null
            };
        }
    }
    
    console.warn(`⚠️ [findStopSurface] Stop面が見つかりません`);
    return null;
}

/**
 * Clear all optical elements from scene
 * @param {THREE.Scene} scene - Three.js scene
 */
export function clearAllOpticalElements(scene) {
    if (!scene) {
        console.error('Scene not provided to clearAllOpticalElements');
        return;
    }
    
    const objectsToRemove = [];
    
    scene.traverse((child) => {
        // Surface and lens objects by name
        if (child.name && 
            (child.name.startsWith('surface') || 
             child.name.startsWith('lens') ||
             child.name.startsWith('cross-section') ||
             child.name.startsWith('semidia') ||
             child.name.startsWith('mirror') ||
             child.name.includes('Profile') ||
             child.name.includes('Ring') ||
             child.name.includes('Connection'))) {
            objectsToRemove.push(child);
        }
        
        // Semidia ring objects specifically (for thickness change bug fix)
        if (child.userData && (
            child.userData.type === 'semidiaRing' ||
            child.userData.type === 'ring' ||
            child.userData.surfaceType === 'ring' ||
            child.name.includes('semidiaRing')
        )) {
            objectsToRemove.push(child);
        }
        
        // Ray objects by userData
        if (child.userData && (
            child.userData.isRayLine || 
            child.userData.type === 'ray'
        )) {
            objectsToRemove.push(child);
        }
        
        // Objects by userData type
        if (child.userData && (
            child.userData.isLensSurface ||
            child.userData.surfaceType === '3DSurface' ||
            child.userData.type === 'ring' ||
            child.userData.type === 'pupil' ||
            child.userData.type === 'crossSection'
        )) {
            objectsToRemove.push(child);
        }
        
        // Objects by material properties (lens surfaces are often transparent)
        if (child.material && child.material.transparent && 
            child.material.opacity && child.material.opacity < 1 &&
            child.type !== 'GridHelper' && child.type !== 'AxesHelper') {
            objectsToRemove.push(child);
        }
    });
    
    // Remove duplicates
    const uniqueObjects = [...new Set(objectsToRemove)];
    
    console.log(`🧹 Clearing ${uniqueObjects.length} optical elements from scene`);
    
    uniqueObjects.forEach(obj => {
        scene.remove(obj);
        
        // Dispose of geometry and material to free memory
        if (obj.geometry) {
            obj.geometry.dispose();
        }
        if (obj.material) {
            if (Array.isArray(obj.material)) {
                obj.material.forEach(material => material.dispose());
            } else {
                obj.material.dispose();
            }
        }
    });
}

/**
 * Clear existing optical elements from the scene
 * @param {THREE.Scene} scene - The THREE.js scene
 */
function clearExistingOpticalElements(scene) {
    const elementsToRemove = [];
    
    scene.traverse((child) => {
        // Clear renderables (Mesh/Line/Sprite/Points) created by the optical renderer.
        // Sprites are used for labels (e.g., mirrorBackText) and must be cleared too.
        if (!(child.isMesh || child.isLine || child.isSprite || child.isPoints)) return;

        const ud = child.userData;
        const isOptical = !!(ud && ud.isOpticalElement);

        // Remove optical surfaces, rings, markers, and labels
        if (isOptical || (ud && (
            ud.type === 'lensSurface' ||
            ud.isLensSurface ||
            ud.surfaceType === '3DSurface' ||
            ud.type === 'ring' ||
            ud.type === 'semidiaRing' ||
            ud.type === 'pupil' ||
            ud.type === 'surface-origin-marker' ||
            ud.surfaceIndex !== undefined
        )) || child.name.includes('LensSurface') || child.name.includes('Surface') || child.name.includes('semidiaRing')) {
            elementsToRemove.push(child);
        }
    });
    
    elementsToRemove.forEach(element => {
        scene.remove(element);
        if (element.geometry) element.geometry.dispose();
        if (element.material) {
            if (Array.isArray(element.material)) {
                element.material.forEach(mat => mat.dispose());
            } else {
                element.material.dispose();
            }
        }
        // Sprites often own a texture map that should be disposed.
        try {
            const m = element.material;
            const mats = Array.isArray(m) ? m : (m ? [m] : []);
            for (const mm of mats) {
                if (mm && mm.map && typeof mm.map.dispose === 'function') mm.map.dispose();
            }
        } catch (_) {}
    });
    
    console.log(`🧹 Cleared ${elementsToRemove.length} existing optical elements`);
}
