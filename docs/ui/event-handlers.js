/**
 * UI Event handlers for optical system visualization
 */

import { clearAllOpticalElements } from '../optical/system-renderer.js';
import { setRayEmissionPattern, setRayColorMode } from '../optical/ray-renderer.js';
import { calculateSurfaceOrigins } from '../ray-tracing.js';
import { calculateOpticalSystemOffset } from '../utils/math.js';
import { drawLensCrossSectionWithSurfaceOrigins, harmonizeSceneGeometry } from '../surface.js';

const __COOPT_FORCE_INFINITE_PUPIL_MODE_KEY = 'coopt.forceInfinitePupilMode';

function __cooptSanitizeForcedInfinitePupilMode(v) {
    const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
    return (s === 'stop' || s === 'entrance') ? s : '';
}

function __cooptGetForceInfinitePupilMode() {
    try {
        return __cooptSanitizeForcedInfinitePupilMode(globalThis?.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? globalThis?.COOPT_FORCE_INFINITE_PUPIL_MODE);
    } catch (_) {
        return '';
    }
}

function __cooptSetForceInfinitePupilMode(mode) {
    const m = __cooptSanitizeForcedInfinitePupilMode(mode);
    try {
        if (m) {
            globalThis.__COOPT_FORCE_INFINITE_PUPIL_MODE = m;
            globalThis.COOPT_FORCE_INFINITE_PUPIL_MODE = m;
        } else {
            try { delete globalThis.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { globalThis.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
            try { delete globalThis.COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { globalThis.COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
        }
    } catch (_) {}

    try {
        if (m) localStorage.setItem(__COOPT_FORCE_INFINITE_PUPIL_MODE_KEY, m);
        else localStorage.removeItem(__COOPT_FORCE_INFINITE_PUPIL_MODE_KEY);
    } catch (_) {}
}

function __cooptInitForceInfinitePupilModeFromStorage() {
    // Respect explicit globals first; otherwise restore from localStorage.
    const already = __cooptGetForceInfinitePupilMode();
    if (already) return;
    let saved = '';
    try {
        saved = __cooptSanitizeForcedInfinitePupilMode(localStorage.getItem(__COOPT_FORCE_INFINITE_PUPIL_MODE_KEY));
    } catch (_) {
        saved = '';
    }
    if (saved) __cooptSetForceInfinitePupilMode(saved);
}

try {
    if (!globalThis.__cooptForceInfinitePupilModeInitDone) {
        globalThis.__cooptForceInfinitePupilModeInitDone = true;
        __cooptInitForceInfinitePupilModeFromStorage();
        // Expose for popup Settings window.
        try {
            window.__cooptGetForceInfinitePupilMode = __cooptGetForceInfinitePupilMode;
            window.__cooptSetForceInfinitePupilMode = __cooptSetForceInfinitePupilMode;
        } catch (_) {}
    }
} catch (_) {}

// X-Z、Y-Zボタンで必要な関数をグローバルから取得する関数
function getRequiredFunctions() {
    return {
        getOpticalSystemRows: window.getOpticalSystemRows || (() => { 
            console.error('❌ getOpticalSystemRows not available'); 
            return null; 
        }),
        getObjectRows: window.getObjectRows || (() => { 
            console.error('❌ getObjectRows not available'); 
            return null; 
        }),
        generateCrossBeam: window.generateCrossBeam || (async () => { 
            console.error('❌ generateCrossBeam not available'); 
            return { success: false, error: 'generateCrossBeam function not found' }; 
        }),
        generateInfiniteSystemCrossBeam: window.generateInfiniteSystemCrossBeam || (async () => { 
            console.error('❌ generateInfiniteSystemCrossBeam not available'); 
            return { success: false, error: 'generateInfiniteSystemCrossBeam function not found' }; 
        }),
        drawOpticalSystemSurfaces: window.drawOpticalSystemSurfaces || (() => { 
            console.error('❌ drawOpticalSystemSurfaces not available'); 
        }),
        drawCrossBeamRays: window.drawCrossBeamRays || (() => { 
            console.error('❌ drawCrossBeamRays not available'); 
        })
    };
}

const ensurePopupMessageHandler = () => {
    if (window.popupMessageHandlerRegistered) {
        return;
    }

    const messageHandler = async (event) => {
        if (!window.popup3DWindow && event.source) {
            window.popup3DWindow = event.source;
            console.log('🔁 Popup reference re-established after reload');
        }

        if (!window.popup3DWindow || event.source !== window.popup3DWindow) {
            return;
        }

        console.log('📨 Received message from popup:', event.data);
        const { action } = event.data || {};

        if (action === 'popup-ready') {
            console.log('✅ 3D popup window ready');
            return;
        }

        if (action === 'popup-resize') {
            if (!window.popup3DWindow) {
                console.warn('⚠️ Popup window reference is unavailable (resize)');
                return;
            }

            const popupWindow = window.popup3DWindow;
            const viewAxis = (event.data?.viewAxis || 'YZ').toString().toUpperCase();
            const axis = viewAxis === 'XZ' ? 'XZ' : 'YZ';

            try {
                const cameraRef = popupWindow.camera;
                const savedBounds = cameraRef?.userData?.__drawCrossOrthoBounds;
                const centerZOverride = Number.isFinite(savedBounds?.centerZ) ? savedBounds.centerZ : undefined;

                // Rendererサイズはpopup側で更新済みの前提。ここではアスペクト再計算のため再フィット。
                const cameraOptions = {
                    camera: popupWindow.camera,
                    controls: popupWindow.controls,
                    scene: popupWindow.scene,
                    renderer: popupWindow.renderer,
                    includeRayStartMargin: true,
                    preserveDrawCrossBounds: false,
                    ...(Number.isFinite(centerZOverride) ? { centerZOverride } : {})
                };

                if (axis === 'XZ' && typeof window.setCameraForXZCrossSection === 'function') {
                    window.setCameraForXZCrossSection(cameraOptions);
                } else if (axis === 'YZ' && typeof window.setCameraForYZCrossSection === 'function') {
                    window.setCameraForYZCrossSection(cameraOptions);
                }

                console.log(`✅ Popup resize handled (refit camera): axis=${axis}`);
            } catch (error) {
                console.error('❌ Popup resize handling error:', error);
            }
            return;
        }

        const {
            getOpticalSystemRows,
            getObjectRows,
            generateCrossBeam,
            generateInfiniteSystemCrossBeam,
            drawOpticalSystemSurfaces,
            drawCrossBeamRays
        } = getRequiredFunctions();

        if (action === 'draw-cross') {
            console.log('🎯 Handling draw-cross action in popup');
            try {
                const popupWindow = window.popup3DWindow;
                const viewAxisRaw = (event.data?.viewAxis || 'YZ').toString().toUpperCase();
                const viewAxis = viewAxisRaw === 'XZ' ? 'XZ' : 'YZ';
                const userAdjustedView = event.data?.userAdjustedView === true;
                const targetOverride = event.data?.target &&
                    Number.isFinite(event.data.target.x) &&
                    Number.isFinite(event.data.target.y) &&
                    Number.isFinite(event.data.target.z)
                    ? event.data.target
                    : null;
                const rayCount = (() => {
                    const v = parseInt(event.data?.rayCount ?? 51, 10);
                    return Number.isFinite(v) && v > 0 ? v : 51;
                })();
                const rayColorMode = (event.data?.rayColorMode === 'segment') ? 'segment' : 'object';

                try {
                    setRayColorMode(rayColorMode);
                } catch (e) {
                    console.warn('⚠️ Unable to set ray color mode:', e);
                }

                // アクティブなConfigurationをテーブルに反映
                console.log('🔄 [DrawCross] Loading active configuration to tables...');
                if (typeof window.loadActiveConfigurationToTables === 'function') {
                    window.loadActiveConfigurationToTables();
                    console.log('✅ [DrawCross] Active configuration loaded');
                } else if (typeof loadActiveConfigurationToTables === 'function') {
                    loadActiveConfigurationToTables();
                    console.log('✅ [DrawCross] Active configuration loaded');
                } else {
                    console.warn('⚠️ [DrawCross] loadActiveConfigurationToTables not available');
                }

                // Rendering should always reflect the canonical current configuration.
                // Clear any transient override rows left behind by optimization/debug flows.
                try {
                    if (typeof globalThis !== 'undefined') {
                        globalThis.__cooptOpticalSystemRowsOverride = null;
                    }
                } catch (_) {}
                
                const opticalSystemRows = getOpticalSystemRows();
                console.log('📊 Optical system rows:', opticalSystemRows);

                // Provide surface list to popup so it can build per-surface color UI.
                try {
                    const surfaces = Array.isArray(opticalSystemRows)
                        ? opticalSystemRows.map((s, idx) => ({
                            index0: idx,
                            id: (s && typeof s === 'object') ? (s.id ?? null) : null,
                            type: (s && typeof s === 'object') ? (s.type ?? s['object type'] ?? '') : '',
                            _blockId: (s && typeof s === 'object') ? (s._blockId ?? '') : '',
                            _surfaceRole: (s && typeof s === 'object') ? (s._surfaceRole ?? '') : ''
                        }))
                        : [];
                    window.popup3DWindow?.postMessage({ action: 'surface-list', surfaces }, '*');
                } catch (e) {
                    console.warn('⚠️ Unable to post surface list to popup:', e);
                }

                if (!opticalSystemRows || opticalSystemRows.length === 0) {
                    console.error('❌ No optical system data');
                    window.popup3DWindow.postMessage({ status: 'Error: No optical system data' }, '*');
                    return;
                }

                const popupScene = window.popup3DWindow.scene;
                console.log('🎬 Popup scene:', popupScene);

                if (!popupScene) {
                    console.error('❌ Popup scene not available');
                    window.popup3DWindow.postMessage({ status: 'Error: Scene not ready' }, '*');
                    return;
                }

                console.log('🖌️ Drawing optical system surfaces...');
                
                // 完全なキャンバスクリア
                console.log('🧹 [DrawCross] 完全なキャンバスクリア実行');
                if (window.popup3DWindow && window.popup3DWindow.renderer) {
                    window.popup3DWindow.renderer.clear();
                }
                if (popupScene) {
                    const allChildren = [...popupScene.children];
                    allChildren.forEach(child => {
                        popupScene.remove(child);
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) {
                            if (Array.isArray(child.material)) {
                                child.material.forEach(mat => mat.dispose());
                            } else {
                                child.material.dispose();
                            }
                        }
                    });
                }
                clearAllOpticalElements(popupScene);
                drawOpticalSystemSurfaces({
                    opticalSystemData: opticalSystemRows,
                    scene: popupScene,
                    showSemidiaRing: true,
                    showSurfaceOrigins: false,
                    crossSectionOnly: false
                });
                harmonizeSceneGeometry(popupScene);

                console.log(`📷 Setting camera for ${viewAxis} cross section in popup...`);
                if (!popupWindow) {
                    console.warn('⚠️ Popup window reference missing (camera)');
                } else if (viewAxis === 'XZ' && typeof window.setCameraForXZCrossSection === 'function') {
                    window.setCameraForXZCrossSection({
                        camera: popupWindow.camera,
                        controls: popupWindow.controls,
                        scene: popupWindow.scene,
                        renderer: popupWindow.renderer,
                        includeRayStartMargin: true,
                        preserveDrawCrossBounds: userAdjustedView === true,
                        preserveCurrentOrthoBounds: userAdjustedView === true,
                        storeDrawCrossBounds: userAdjustedView !== true,
                        ...(userAdjustedView === true && targetOverride ? { targetOverride } : {})
                    });
                } else if (viewAxis === 'YZ' && typeof window.setCameraForYZCrossSection === 'function') {
                    window.setCameraForYZCrossSection({
                        camera: popupWindow.camera,
                        controls: popupWindow.controls,
                        scene: popupWindow.scene,
                        renderer: popupWindow.renderer,
                        includeRayStartMargin: true,
                        preserveDrawCrossBounds: userAdjustedView === true,
                        preserveCurrentOrthoBounds: userAdjustedView === true,
                        storeDrawCrossBounds: userAdjustedView !== true,
                        ...(userAdjustedView === true && targetOverride ? { targetOverride } : {})
                    });
                } else {
                    console.warn(`⚠️ Popup window/camera not ready for setCameraFor${viewAxis}CrossSection`);
                }

                console.log('🌟 Generating rays...');
                let objectRows = [];
                try {
                    if (typeof getObjectRows === 'function') {
                        objectRows = getObjectRows() || [];
                        console.log('📋 Got object data via helper:', objectRows.length, 'rows');
                    }
                } catch (error) {
                    console.error('❌ Error getting object data via helper:', error);
                }

                if (!Array.isArray(objectRows) || objectRows.length === 0) {
                    try {
                        if (window.tableObject && typeof window.tableObject.getData === 'function') {
                            objectRows = window.tableObject.getData();
                            console.log('📋 Fallback object data from tableObject:', objectRows.length, 'rows');
                        } else {
                            const tableElement = document.getElementById('table-object');
                            if (tableElement && tableElement.tabulator) {
                                objectRows = tableElement.tabulator.getData();
                                console.log('📋 Fallback object data from DOM element:', objectRows.length, 'rows');
                            } else {
                                console.warn('⚠️ No object table found for fallback');
                                objectRows = [];
                            }
                        }
                    } catch (error) {
                        console.error('❌ Error getting fallback object data:', error);
                        objectRows = [];
                    }
                }

                console.log('📊 Object rows:', objectRows);

                if (objectRows && objectRows.length > 0) {
                    console.log('🔍 Object row details:');
                    objectRows.forEach((row, idx) => {
                        console.log(`  Object ${idx}:`, {
                            height: row.height,
                            y: row.y,
                            position: row.position,
                            xHeightAngle: row.xHeightAngle,
                            yHeightAngle: row.yHeightAngle,
                            allFields: Object.keys(row)
                        });
                    });
                }

                const objectSurface = opticalSystemRows[0] || {};
                const thicknessRaw = objectSurface?.thickness;
                const hasThicknessInfo = thicknessRaw !== undefined && thicknessRaw !== null && thicknessRaw !== '';
                const thicknessStr = hasThicknessInfo ? String(thicknessRaw).trim().toUpperCase() : '';
                const thicknessVal = Number(thicknessRaw);
                const thicknessIndicatesInfinite = hasThicknessInfo && (
                    thicknessRaw === Infinity ||
                    thicknessStr === 'INF' ||
                    thicknessStr === 'INFINITY' ||
                    thicknessStr === '∞' ||
                    (Number.isFinite(thicknessVal) && Math.abs(thicknessVal) > 1e6)
                );
                const objectRowsIndicateInfinite = !objectRows || objectRows.length === 0 ||
                    objectRows.every(row => row.position === 'Angle' ||
                        (!row.height && !row.y && !row.xHeightAngle && !row.yHeightAngle) ||
                        parseFloat(row.height || 0) === 0);
                const isInfiniteSystem = hasThicknessInfo ? thicknessIndicatesInfinite : objectRowsIndicateInfinite;

                console.log('📐 Object thickness (popup):', thicknessRaw);
                console.log('📐 System type:', isInfiniteSystem ? 'Infinite' : 'Finite');

                let crossBeamResult;
                if (isInfiniteSystem) {
                    console.log('🔄 Generating infinite system cross beam...');
                    const objectAngles = objectRows.map(row => ({
                        x: parseFloat(row.xHeightAngle) || 0,
                        y: parseFloat(row.yHeightAngle) || 0
                    }));
                    console.log('📐 Object angles:', objectAngles);

                    const imageSurfaceIndex = opticalSystemRows.findIndex(row =>
                        row && (row['object type'] === 'Image' || row.object === 'Image')
                    );
                    const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);

                    const primaryWavelength = (typeof window.getPrimaryWavelength === 'function')
                        ? Number(window.getPrimaryWavelength()) || 0.5876
                        : 0.5876;

                    crossBeamResult = await generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, {
                        rayCount,
                        debugMode: false,
                        wavelength: primaryWavelength,
                        crossType: 'both',
                        targetSurfaceIndex,
                        pupilSamplingMode: 'entrance',
                        logEntrancePupilConfig: true,
                        angleUnit: 'deg',
                        chiefZ: -20
                    });
                } else {
                    const toNumber = (value) => {
                        const num = parseFloat(value);
                        return Number.isFinite(num) ? num : 0;
                    };
                    const allObjectPositions = (objectRows || []).map((row, index) => {
                        if (Array.isArray(row)) {
                            return {
                                x: toNumber(row[1]),
                                y: toNumber(row[2]),
                                z: 0,
                                objectIndex: index
                            };
                        }
                        const xCoord = toNumber(row.xHeightAngle ?? row.x ?? row.height ?? row.heightX);
                        const yCoord = toNumber(row.yHeightAngle ?? row.y ?? row.height ?? row.heightY);
                        return {
                            x: xCoord,
                            y: yCoord,
                            z: 0,
                            objectIndex: row.objectIndex ?? index
                        };
                    });
                    if (allObjectPositions.length === 0) {
                        allObjectPositions.push({ x: 0, y: 0, z: 0 });
                    }
                    console.log('🔄 Generating finite system cross beam for positions:', allObjectPositions);
                    crossBeamResult = await generateCrossBeam(opticalSystemRows, allObjectPositions, {
                        rayCount,
                        debugMode: false,
                        wavelength: 0.5876,
                        crossType: 'both'
                    });
                }

                console.log('📦 Cross beam result:', crossBeamResult);

                if (crossBeamResult.success) {
                    console.log('✅ Drawing rays to popup scene...');

                    let allRays = [];
                    if (crossBeamResult.results && Array.isArray(crossBeamResult.results)) {
                        console.log(`🔍 results配列発見: ${crossBeamResult.results.length}個`);
                        crossBeamResult.results.forEach((result, idx) => {
                            console.log(`   Result${idx + 1}:`, result);
                            if (result.rays && Array.isArray(result.rays)) {
                                allRays = allRays.concat(result.rays);
                                console.log(`   Result${idx + 1} 光線数: ${result.rays.length}`);
                            }
                        });
                    } else if (crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)) {
                        allRays = crossBeamResult.allTracedRays;
                    } else if (crossBeamResult.tracedRays && Array.isArray(crossBeamResult.tracedRays)) {
                        allRays = crossBeamResult.tracedRays;
                    } else if (Array.isArray(crossBeamResult)) {
                        allRays = crossBeamResult;
                    }

                    console.log('🔍 Total rays extracted:', allRays.length);
                    console.log('🔍 Ray data:', allRays);

                    if (allRays && allRays.length > 0) {
                        drawCrossBeamRays(allRays, popupScene);
                        harmonizeSceneGeometry(popupScene);
                    } else {
                        console.warn('⚠️ No ray data found in cross beam result');
                    }

                    window.popup3DWindow.postMessage({ status: 'Drawing complete' }, '*');
                    console.log('✅ Drawing complete!');
                } else {
                    console.error('❌ Cross beam generation failed:', crossBeamResult.error);
                    window.popup3DWindow.postMessage({ status: 'Error: ' + crossBeamResult.error }, '*');
                }
            } catch (error) {
                console.error('❌ Error in draw-cross:', error);
                console.error('Error stack:', error.stack);
                window.popup3DWindow.postMessage({ status: 'Error: ' + error.message }, '*');
            }
            return;
        }

        if (action === 'view-xz' || action === 'view-yz') {
            console.log('🎥 Handling popup view action:', action);
            if (!window.popup3DWindow) {
                console.warn('⚠️ Popup window reference is unavailable');
                return;
            }

            const popupWindow = window.popup3DWindow;
            const popupStatus = popupWindow.document?.getElementById('status') || null;

            try {
                const viewAxis = action === 'view-xz' ? 'XZ' : 'YZ';
                const userAdjustedView = event.data?.userAdjustedView === true;
                const targetOverride = event.data?.target &&
                    Number.isFinite(event.data.target.x) &&
                    Number.isFinite(event.data.target.y) &&
                    Number.isFinite(event.data.target.z)
                    ? event.data.target
                    : null;

                // ✅ Popupでは「Draw Crossで生成済みのシーン」を維持し、カメラだけ切り替える。
                // 断面描画を再実行すると、光線生成パラメータ差や再センタリングで
                // 見かけ上の左ズレ（光線出発点含む）が発生するため。
                const hasSavedBounds = !!(popupWindow.camera?.userData?.__drawCrossOrthoBounds);
                const canSwitchCameraOnly =
                    hasSavedBounds &&
                    popupWindow.scene &&
                    popupWindow.camera &&
                    popupWindow.controls &&
                    popupWindow.renderer &&
                    (typeof window.setCameraForXZCrossSection === 'function') &&
                    (typeof window.setCameraForYZCrossSection === 'function');

                if (canSwitchCameraOnly) {
                    const rotateCameraAroundZOnly = ({ viewAxis, target }) => {
                        const cam = popupWindow.camera;
                        const ctr = popupWindow.controls;
                        const rnd = popupWindow.renderer;
                        const scn = popupWindow.scene;

                        if (!cam || !ctr) return;

                        const syncOrthoBoundsToRendererAspect = () => {
                            try {
                                if (!cam || !cam.isOrthographicCamera || !rnd || typeof rnd.getSize !== 'function') return;
                                const size = rnd.getSize(new (popupWindow?.THREE?.Vector2 || window.THREE?.Vector2 || THREE.Vector2)());
                                const w = Number(size?.x) || 0;
                                const h = Number(size?.y) || 0;
                                if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return;
                                const asp = w / h;

                                const currentHeight = (cam.top - cam.bottom) || 1;
                                const cx = (cam.left + cam.right) / 2;
                                const cy = (cam.top + cam.bottom) / 2;
                                const nextWidth = currentHeight * asp;

                                cam.left = cx - nextWidth / 2;
                                cam.right = cx + nextWidth / 2;
                                cam.top = cy + currentHeight / 2;
                                cam.bottom = cy - currentHeight / 2;
                            } catch (_) {}
                        };

                        const oldTarget = target || {
                            x: ctr.target?.x ?? 0,
                            y: ctr.target?.y ?? 0,
                            z: ctr.target?.z ?? 0
                        };

                        // Determine current view axis from camera position relative to target.
                        // (More reliable than camera.up after free OrbitControls rotation.)
                        const curDx0 = (cam.position?.x ?? 0) - oldTarget.x;
                        const curDy0 = (cam.position?.y ?? 0) - oldTarget.y;
                        const currentAxis = (Math.abs(curDy0) > Math.abs(curDx0)) ? 'XZ' : 'YZ';

                        // When switching between YZ and XZ, the visible vertical axis changes (Y <-> X).
                        // If the user panned vertically in the previous view, keeping the same world
                        // target offset makes that pan disappear (or reappear as a jump). To preserve
                        // the *screen-space* feel, remap the vertical offset across the axes and lock
                        // the depth axis to the cross-section plane.
                        let nextTarget = { ...oldTarget };
                        if (currentAxis === 'YZ' && viewAxis === 'XZ') {
                            nextTarget = { x: oldTarget.y, y: 0, z: oldTarget.z };
                        } else if (currentAxis === 'XZ' && viewAxis === 'YZ') {
                            nextTarget = { x: 0, y: oldTarget.x, z: oldTarget.z };
                        } else {
                            // Same-axis: still lock depth axis to plane
                            if (viewAxis === 'XZ') nextTarget.y = 0;
                            if (viewAxis === 'YZ') nextTarget.x = 0;
                        }

                        const shiftX = nextTarget.x - oldTarget.x;
                        const shiftY = nextTarget.y - oldTarget.y;
                        const shiftZ = nextTarget.z - oldTarget.z;

                        // Keep camera offset relative to target stable by shifting camera with target.
                        cam.position.set(
                            (cam.position?.x ?? 0) + shiftX,
                            (cam.position?.y ?? 0) + shiftY,
                            (cam.position?.z ?? 0) + shiftZ
                        );
                        ctr.target.set(nextTarget.x, nextTarget.y, nextTarget.z);

                        // IMPORTANT:
                        // After the user freely rotates the 3D view, the camera can be tilted.
                        // Rotating around Z only keeps that tilt, which visually distorts the
                        // XZ/YZ cross-section (appears stretched). Snap the camera to the exact
                        // axis-aligned cross-section view while preserving the user's pan.
                        const dx = (cam.position?.x ?? 0) - nextTarget.x;
                        const dy = (cam.position?.y ?? 0) - nextTarget.y;
                        const dz = (cam.position?.z ?? 0) - nextTarget.z;
                        const dist = Math.hypot(dx, dy, dz) || 300;

                        if (viewAxis === 'XZ') {
                            cam.position.set(nextTarget.x, nextTarget.y + dist, nextTarget.z);
                            cam.up.set(1, 0, 0);
                        } else {
                            cam.position.set(nextTarget.x - dist, nextTarget.y, nextTarget.z);
                            cam.up.set(0, 1, 0);
                        }

                        cam.lookAt(nextTarget.x, nextTarget.y, nextTarget.z);
                        ctr.update();

                        // Ensure orthographic bounds match the actual canvas aspect.
                        // Without this, the view can look stretched until a resize event happens.
                        syncOrthoBoundsToRendererAspect();

                        cam.updateProjectionMatrix();
                        if (rnd && scn) rnd.render(scn, cam);
                    };

                    // Pure rotation around Z-axis only (no refit/recenter)
                    rotateCameraAroundZOnly({
                        viewAxis,
                        target: userAdjustedView && targetOverride ? targetOverride : null
                    });

                    // 断面表示では「レンズ色(3D面)」と「リング」を表示しない。
                    // シーンは維持しつつ、断面線だけを描き直す。
                    try {
                        const clearSurfacesOnly = (scene) => {
                            if (!scene) return;
                            const objectsToRemove = [];
                            scene.traverse((child) => {
                                const ud = child.userData || {};
                                // Keep ray lines
                                if (ud.isRayLine || ud.type === 'ray') {
                                    return;
                                }

                                const name = (child.name || '').toString();
                                const isRing = ud.type === 'semidiaRing' || ud.type === 'ring' || ud.surfaceType === 'ring' || name.toLowerCase().includes('ring');
                                const isLensSurface = ud.isLensSurface || ud.surfaceType === '3DSurface' || name.toLowerCase().includes('lenssurface') || name.startsWith('surface') || name.startsWith('lens');
                                const looksLikeTransparentSurface = !!(child.material && child.material.transparent && typeof child.material.opacity === 'number' && child.material.opacity < 1);

                                if ((child.isMesh && (isLensSurface || looksLikeTransparentSurface)) || (child.isLine && isRing)) {
                                    objectsToRemove.push(child);
                                }
                            });
                            // Remove duplicates
                            [...new Set(objectsToRemove)].forEach((obj) => {
                                scene.remove(obj);
                                if (obj.geometry) obj.geometry.dispose();
                                if (obj.material) {
                                    if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
                                    else obj.material.dispose();
                                }
                            });
                        };

                        clearSurfacesOnly(popupWindow.scene);

                        const opticalSystemRows = getOpticalSystemRows();
                        if (Array.isArray(opticalSystemRows) && opticalSystemRows.length > 0) {
                            drawOpticalSystemSurfaces({
                                opticalSystemData: opticalSystemRows,
                                scene: popupWindow.scene,
                                showSemidiaRing: false,
                                showSurfaceOrigins: false,
                                crossSectionOnly: true,
                                crossSectionDirection: viewAxis
                            });
                            harmonizeSceneGeometry(popupWindow.scene);
                        }
                    } catch (e) {
                        console.warn('⚠️ Popup cross-section redraw skipped:', e);
                    }

                    if (popupStatus) {
                        popupStatus.textContent = `${viewAxis === 'XZ' ? 'X-Z' : 'Y-Z'} view ready`;
                    }
                    popupWindow.postMessage({ status: `${viewAxis === 'XZ' ? 'X-Z' : 'Y-Z'} view ready` }, '*');
                    console.log('✅ Popup view switched (camera only)');
                } else {
                    // フォールバック: まだDraw Cross実行前など（bounds未保存）
                    await executeCrossSectionView({
                        viewAxis,
                        statusElement: popupStatus,
                        targetScene: popupWindow.scene,
                        targetCamera: popupWindow.camera,
                        targetControls: popupWindow.controls,
                        targetRenderer: popupWindow.renderer,
                        showAlerts: false
                    });
                    popupWindow.postMessage({ status: `${viewAxis === 'XZ' ? 'X-Z' : 'Y-Z'} view ready` }, '*');
                    console.log('✅ Popup view rendered successfully (fallback redraw)');
                }
            } catch (error) {
                console.error('❌ Popup view rendering error:', error);
                popupWindow.postMessage({ status: `Error: ${error.message}` }, '*');
            }
            return;
        }
    };

    window.addEventListener('message', messageHandler);
    window.popupMessageHandlerRegistered = true;
};

async function executeCrossSectionView({
    viewAxis,
    buttonElement = null,
    statusElement = null,
    targetScene = window.scene,
    targetCamera = window.camera,
    targetControls = window.controls,
    targetRenderer = window.renderer,
    showAlerts = true
} = {}) {
    ensurePopupMessageHandler();

    const axis = (viewAxis || '').toUpperCase();
    const label = axis === 'XZ' ? 'X-Z' : 'Y-Z';
    
    const sceneRef = targetScene;
    const cameraRef = targetCamera;
    const controlsRef = targetControls;
    const rendererRef = targetRenderer;
    const threeContext = sceneRef?.userData?.renderContext?.three || window.THREE;
    
    const {
        getOpticalSystemRows,
        getObjectRows,
        generateCrossBeam,
        generateInfiniteSystemCrossBeam,
        drawOpticalSystemSurfaces,
        drawCrossBeamRays
    } = getRequiredFunctions();

    let originalButtonText = '';
    function saveButtonState() {
        if (buttonElement) {
            originalButtonText = buttonElement.textContent || '';
            buttonElement.disabled = true;
            buttonElement.textContent = 'Processing...';
        }
    }
    
    function restoreButtonState() {
        if (buttonElement && originalButtonText) {
            buttonElement.disabled = false;
            buttonElement.textContent = originalButtonText;
        }
    }
    
    saveButtonState();
    
    try {
        // Keep behavior consistent with popup draw-cross:
        // always render using the canonical active configuration.
        try {
            if (typeof window.loadActiveConfigurationToTables === 'function') {
                window.loadActiveConfigurationToTables();
            } else if (typeof loadActiveConfigurationToTables === 'function') {
                loadActiveConfigurationToTables();
            }
        } catch (e) {
            console.warn('⚠️ [CrossSectionView] Unable to load active configuration:', e);
        }

        // Clear any transient override rows left behind by optimization/debug flows.
        try {
            if (typeof globalThis !== 'undefined') {
                globalThis.__cooptOpticalSystemRowsOverride = null;
            }
        } catch (_) {}

        const opticalSystemRows = getOpticalSystemRows();
        if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
            throw new Error('光学系データが設定されていません。');
        }

        const objectRows = getObjectRows();
        if (!Array.isArray(objectRows) || objectRows.length === 0) {
            throw new Error('Objectが設定されていません。');
        }

        const objectSurface = opticalSystemRows[0];
        const objectThickness = objectSurface?.thickness;
        const isInfiniteSystem = objectThickness === 'INF' || objectThickness === 'Infinity' || objectThickness === Infinity;

        const allObjectPositions = objectRows.map((obj) => {
            if (Array.isArray(obj)) {
                const xValue = parseFloat(obj[1]);
                const yValue = parseFloat(obj[2]);
                return {
                    x: Number.isFinite(xValue) ? xValue : 0,
                    y: Number.isFinite(yValue) ? yValue : 0,
                    z: 0
                };
            }
            const xCoord = parseFloat(obj.xHeightAngle) || 0;
            const yCoord = parseFloat(obj.yHeightAngle) || 0;
            return { x: xCoord, y: yCoord, z: 0 };
        });

        const drawRayCountInput = document.getElementById('draw-ray-count-input');
        const rayCount = drawRayCountInput ? parseInt(drawRayCountInput.value, 10) || 7 : 7;

        clearAllOpticalElements(sceneRef);

        let crossBeamResult;
        if (isInfiniteSystem) {
            const objectAngles = allObjectPositions.map((pos) => ({
                x: pos.x || 0,
                y: pos.y || 0
            }));

            const imageSurfaceIndex = opticalSystemRows.findIndex(row =>
                row && (row['object type'] === 'Image' || row.object === 'Image')
            );
            const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);

            const primaryWavelength = (typeof window.getPrimaryWavelength === 'function')
                ? Number(window.getPrimaryWavelength()) || 0.5876
                : 0.5876;

            crossBeamResult = await generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, {
                rayCount,
                debugMode: true,
                wavelength: primaryWavelength,
                crossType: 'both',
                targetSurfaceIndex,
                pupilSamplingMode: 'entrance',
                logEntrancePupilConfig: true
            });
        } else {
            crossBeamResult = await generateCrossBeam(opticalSystemRows, allObjectPositions, {
                rayCount,
                debugMode: true,
                wavelength: 0.5876,
                crossType: 'both'
            });
        }

        if (!crossBeamResult || crossBeamResult.success === false) {
            throw new Error(crossBeamResult?.error || 'クロスビーム生成に失敗しました。');
        }

        drawOpticalSystemSurfaces({
            opticalSystemData: opticalSystemRows,
            scene: sceneRef,
            showSemidiaRing: false,
            showSurfaceOrigins: false,
            crossSectionOnly: true,
            crossSectionDirection: axis
        });
        harmonizeSceneGeometry(sceneRef);

        const cameraOptions = {
            camera: cameraRef,
            controls: controlsRef,
            renderer: rendererRef,
            scene: sceneRef,
            includeRayStartMargin: true,
            preserveDrawCrossBounds: true
        };

        if (axis === 'XZ') {
            if (typeof window.setCameraForXZCrossSection === 'function') {
                window.setCameraForXZCrossSection(cameraOptions);
            } else {
                applyFallbackXZCamera();
            }
        } else {
            if (typeof window.setCameraForYZCrossSection === 'function') {
                window.setCameraForYZCrossSection(cameraOptions);
            } else {
                applyFallbackYZCamera();
            }
        }

        const raysToRender = collectRaysFromResult(crossBeamResult);
        if (raysToRender.length > 0) {
            drawCrossBeamRays(raysToRender, sceneRef);
            harmonizeSceneGeometry(sceneRef);
        } else {
            console.warn(`⚠️ [${label} View] No rays to render`);
        }

        if (statusElement) {
            statusElement.textContent = `${label} view ready`;
        }

        console.log(`✅ [${label} View] Completed`);
        return { success: true };
    } catch (error) {
        if (statusElement) {
            statusElement.textContent = `Error: ${error.message}`;
        }
        console.error(`❌ [${label} View] Error:`, error);
        if (showAlerts) {
            alert(`${label}断面描画エラー: ${error.message}`);
        }
        throw error;
    } finally {
        restoreButtonState();
    }

    function collectRaysFromResult(result) {
        if (!result) {
            return [];
        }
        if (Array.isArray(result.results)) {
            return result.results.flatMap((entry) => (Array.isArray(entry?.rays) ? entry.rays : []));
        }
        if (Array.isArray(result.allTracedRays)) {
            return result.allTracedRays;
        }
        if (Array.isArray(result.tracedRays)) {
            return result.tracedRays;
        }
        if (Array.isArray(result)) {
            return result;
        }
        return [];
    }

    function applyFallbackXZCamera() {
        if (!cameraRef) {
            return;
        }
        const savedBounds = cameraRef?.userData?.__drawCrossOrthoBounds;
        if (cameraRef.isOrthographicCamera && savedBounds) {
            cameraRef.left = savedBounds.left;
            cameraRef.right = savedBounds.right;
            cameraRef.top = savedBounds.top;
            cameraRef.bottom = savedBounds.bottom;
            const centerZ = Number.isFinite(savedBounds.centerZ) ? savedBounds.centerZ : 0;
            const cameraDistance = 300;
            cameraRef.position.set(0, cameraDistance, centerZ);
            cameraRef.lookAt(0, 0, centerZ);
            cameraRef.up.set(1, 0, 0);
            cameraRef.updateProjectionMatrix();
            if (controlsRef) {
                controlsRef.target.set(0, 0, centerZ);
                controlsRef.update();
            }
            return;
        }
        const calculateOpticalSystemZRange = window.calculateOpticalSystemZRange;
        if (typeof calculateOpticalSystemZRange === 'function') {
            const range = calculateOpticalSystemZRange();
            const minZ = range?.minZ ?? -50;
            const maxZ = range?.maxZ ?? 50;
            const maxY = Math.max(range?.maxY ?? 25, 1);
            const rayStartMargin = 0;
            const effectiveMinZ = Math.min(minZ, -rayStartMargin);
            const effectiveMaxZ = maxZ;
            const effectiveCenterZ = (effectiveMinZ + effectiveMaxZ) / 2;

            let aspect = 1.5;
            if (rendererRef && typeof rendererRef.getSize === 'function' && threeContext?.Vector2) {
                const size = rendererRef.getSize(new threeContext.Vector2());
                aspect = size.x / size.y;
            } else if (rendererRef?.domElement) {
                const { clientWidth, clientHeight } = rendererRef.domElement;
                if (clientWidth && clientHeight) {
                    aspect = clientWidth / clientHeight;
                }
            }

            const marginFactor = 1.1;
            const visibleHeight = maxY * 2 * marginFactor;
            const visibleWidth = (effectiveMaxZ - effectiveMinZ) * marginFactor;

            if (cameraRef.isOrthographicCamera) {
                let viewHeight;
                let viewWidth;
                const contentAspect = visibleWidth / visibleHeight;
                if (contentAspect > aspect) {
                    viewWidth = visibleWidth / 2;
                    viewHeight = viewWidth / aspect;
                } else {
                    viewHeight = visibleHeight / 2;
                    viewWidth = viewHeight * aspect;
                }
                cameraRef.left = -viewWidth;
                cameraRef.right = viewWidth;
                cameraRef.top = viewHeight;
                cameraRef.bottom = -viewHeight;
            }

            const cameraDistance = 300;
            cameraRef.position.set(0, cameraDistance, effectiveCenterZ);
            cameraRef.lookAt(0, 0, effectiveCenterZ);
            cameraRef.up.set(1, 0, 0);
            cameraRef.updateProjectionMatrix();

            if (controlsRef) {
                controlsRef.target.set(0, 0, effectiveCenterZ);
                controlsRef.update();
            }
        } else {
            const offsetData = calculateOpticalSystemOffset(opticalSystemRows);
            const systemCenterZ = offsetData.z_object + offsetData.offset_z;
            const cameraDistance = 300;
            cameraRef.position.set(0, cameraDistance, systemCenterZ);
            cameraRef.lookAt(0, 0, systemCenterZ);
            cameraRef.up.set(1, 0, 0);
            cameraRef.updateProjectionMatrix();
            if (controlsRef) {
                controlsRef.target.set(0, 0, systemCenterZ);
                controlsRef.update();
            }
        }
    }

    function applyFallbackYZCamera() {
        if (!cameraRef) {
            return;
        }
        const savedBounds = cameraRef?.userData?.__drawCrossOrthoBounds;
        if (cameraRef.isOrthographicCamera && savedBounds) {
            cameraRef.left = savedBounds.left;
            cameraRef.right = savedBounds.right;
            cameraRef.top = savedBounds.top;
            cameraRef.bottom = savedBounds.bottom;
            const centerZ = Number.isFinite(savedBounds.centerZ) ? savedBounds.centerZ : 0;
            const cameraDistance = 300;
            cameraRef.position.set(-cameraDistance, 0, centerZ);
            cameraRef.lookAt(0, 0, centerZ);
            cameraRef.up.set(0, 1, 0);
            cameraRef.updateProjectionMatrix();
            if (controlsRef) {
                controlsRef.target.set(0, 0, centerZ);
                controlsRef.update();
            }
            return;
        }
        const offsetData = calculateOpticalSystemOffset(opticalSystemRows);
        const systemCenterZ = offsetData.z_object + offsetData.offset_z;
        const cameraDistance = 300;
        cameraRef.position.set(-cameraDistance, 0, systemCenterZ);
        cameraRef.lookAt(0, 0, systemCenterZ);
        cameraRef.up.set(0, 1, 0);
        cameraRef.updateProjectionMatrix();
        if (controlsRef) {
            controlsRef.target.set(0, 0, systemCenterZ);
            controlsRef.update();
        }
    }
}

// 絞り周辺光線の描画関数（削除 - ユーザー要求により4本の周辺光線描画機能を削除）

/**
 * Setup ray pattern buttons
 */
export function setupRayPatternButtons() {
    const annularBtn = document.getElementById('annular-pattern-btn');
    const gridBtn = document.getElementById('grid-pattern-btn');
    
    if (annularBtn && gridBtn) {
        // Initial state
        updateButtonStates(annularBtn, gridBtn, 'annular');
        
        annularBtn.addEventListener('click', function() {
            setRayEmissionPattern('annular');
            updateButtonStates(annularBtn, gridBtn, 'annular');
            console.log('🎯 Ray pattern set to: annular');
        });
        
        gridBtn.addEventListener('click', function() {
            setRayEmissionPattern('grid');
            updateButtonStates(annularBtn, gridBtn, 'grid');
            console.log('🎯 Ray pattern set to: grid');
        });
    }
}

/**
 * Setup ray color buttons
 */
export function setupRayColorButtons() {
    const objectBtn = document.getElementById('object-color-btn');
    const segmentBtn = document.getElementById('segment-color-btn');
    
    if (objectBtn && segmentBtn) {
        // Initial state
        updateColorButtonStates(objectBtn, segmentBtn, 'object');
        
        objectBtn.addEventListener('click', function() {
            setRayColorMode('object');
            updateColorButtonStates(objectBtn, segmentBtn, 'object');
            console.log('🎨 Ray color mode set to: object');
        });
        
        segmentBtn.addEventListener('click', function() {
            setRayColorMode('segment');
            updateColorButtonStates(objectBtn, segmentBtn, 'segment');
            console.log('🎨 Ray color mode set to: segment');
        });
    }
}

/**
 * Helper function to update button states
 */
function updateButtonStates(annularBtn, gridBtn, activePattern) {
    annularBtn.classList.remove('active');
    gridBtn.classList.remove('active');
    
    if (activePattern === 'annular') {
        annularBtn.classList.add('active');
    } else if (activePattern === 'grid') {
        gridBtn.classList.add('active');
    }
}

/**
 * Helper function to update color button states
 */
function updateColorButtonStates(objectBtn, segmentBtn, activeMode) {
    objectBtn.classList.remove('active');
    segmentBtn.classList.remove('active');
    
    if (activeMode === 'object') {
        objectBtn.classList.add('active');
    } else if (activeMode === 'segment') {
        segmentBtn.classList.add('active');
    }
}

/**
 * Setup view buttons (Draw, Clear All)
 * @param {Object} options - Configuration options
 * @param {THREE.Scene} options.scene - Three.js scene
 * @param {THREE.Camera} options.camera - Three.js camera
 * @param {THREE.Controls} options.controls - Three.js controls
 * @param {THREE.Renderer} options.renderer - Three.js renderer
 * @param {Function} options.drawOptimizedRaysFromObjects - Function to draw rays
 * @param {Function} options.getOpticalSystemRows - Function to get optical system data
 * @param {Function} options.getObjectRows - Function to get object data
 * @param {Function} options.calculateOpticalSystemOffset - Function to calculate offset
 * @param {Function} options.drawOpticalSystemSurfaceWrapper - Function to draw surfaces
 */
export function setupViewButtons(options) {
    
    if (!options) {
        throw new Error('❌ setupViewButtons: options parameter is required');
    }
    
    const {
        scene,
        camera,
        controls,
        renderer,
        drawOptimizedRaysFromObjects,
        getOpticalSystemRows,
        getObjectRows,
        calculateOpticalSystemOffset,
        drawOpticalSystemSurfaceWrapper
    } = options;

    // Validate required options
    if (!scene || !camera || !controls || !renderer) {
        throw new Error('❌ setupViewButtons: Missing required THREE.js components');
    }

    if (!drawOptimizedRaysFromObjects || !getOpticalSystemRows || !getObjectRows) {
        throw new Error('❌ setupViewButtons: Missing required functions');
    }

    if (!calculateOpticalSystemOffset || !drawOpticalSystemSurfaceWrapper) {
        throw new Error('❌ setupViewButtons: Missing required utility functions');
    }

    // Clear All button
    const clearAllBtn = document.getElementById('clear-all-btn');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', function() {
            try {
                clearAllOpticalElements(scene);
                
                // 手動でレンダリングを実行
                if (renderer) {
                    renderer.render(scene, camera);
                    console.log('🎨 Clear All rendered');
                }
            } catch (error) {
                console.error('❌ Error in Clear All button:', error);
            }
        });
    }
}

/**
 * Setup simplified view buttons without complex dependencies
 */
export function setupSimpleViewButtons() {
    
    // X-Z View button (modified functionality)
    const xzBtn = document.getElementById('view-xz-btn');
    if (xzBtn) {
        xzBtn.addEventListener('click', async function() {
            try {
                await executeCrossSectionView({ viewAxis: 'XZ', buttonElement: xzBtn });
            } catch (error) {
                console.error('❌ [X-Z View] エラー:', error);
            }
        });
    }
    
    // Y-Z View button (modified functionality)
    const yzBtn = document.getElementById('view-yz-btn');
    if (yzBtn) {
        yzBtn.addEventListener('click', async function() {
            try {
                await executeCrossSectionView({ viewAxis: 'YZ', buttonElement: yzBtn });
            } catch (error) {
                console.error('❌ [Y-Z View] エラー:', error);
            }
        });
    }
}

/**
 * Setup optical system change listeners
 * Handles table data changes and automatically clears optical elements when needed
 */
export function setupOpticalSystemChangeListeners(scene) {

    // Guard: avoid duplicate listener registration.
    if (window.__opticalSystemChangeListenersBound) {
        console.log('ℹ️ Optical system change listeners already bound; skipping');
        return;
    }
    window.__opticalSystemChangeListenersBound = true;
    
    // テーブルデータ変更時のリスナー（自動クリアは無効化）
    if (window.opticalSystemTabulator) {
        window.opticalSystemTabulator.on('cellEdited', function(cell) {
            console.log('📝 Optical system cell edited:', cell.getField(), '=', cell.getValue());
            // 自動クリアは無効化 - 手動でDrawボタンを押してもらう
            // clearAllOpticalElements();
        });
        
        window.opticalSystemTabulator.on('rowAdded', function(row) {
            console.log('➕ Optical system row added');
            // 自動クリアは無効化 - 手動でDrawボタンを押してもらう
            // clearAllOpticalElements();
        });
        
        window.opticalSystemTabulator.on('rowDeleted', function(row) {
            console.log('➖ Optical system row deleted');
            // 自動クリアは無効化 - 手動でDrawボタンを押してもらう
            // clearAllOpticalElements();
        });
        
        window.opticalSystemTabulator.on('dataChanged', function(data) {
            console.log('🔄 Optical system data changed');
            // 自動クリアは無効化 - 手動でDrawボタンを押してもらう
            // clearAllOpticalElements();
        });
    }

    // Popup message handling is centralized in ensurePopupMessageHandler()
    // (Avoid registering duplicate/legacy handlers that can redraw and shift the scene after reload.)
    ensurePopupMessageHandler();
    
    // Open in window button
    const open3DWindowBtn = document.getElementById('open-3d-window-btn');
    if (open3DWindowBtn) {
        open3DWindowBtn.addEventListener('click', () => {
            // Create popup window
            const popup = window.open('', '3D Optical System', 'width=800,height=600');
            
            // Write HTML structure with full Three.js setup
            popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <title>3D Optical System Viewer</title>
    <style>
        html, body {
            height: 100%;
        }
        body { 
            margin: 0; 
            overflow: hidden; 
            background: #f4f4f4;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
        }
        .header {
            padding: 10px 12px;
            background: white;
            color: #333;
            font-weight: 600;
            flex: 0 0 auto;
            border-bottom: 1px solid #ddd;
        }
        #threejs-container { 
            flex: 1 1 auto;
            min-height: 0;
            width: 100%;
            background: white;
        }
        #threejs-container canvas {
            display: block;
            width: 100%;
            height: 100%;
        }
        #controls {
            flex: 0 0 auto;
            background: #ffffff;
            border-bottom: 1px solid #ddd;
            padding: 10px 12px;
            display: flex;
            align-items: center;
            gap: 8px 10px;
            flex-wrap: wrap;
        }
        button {
            padding: 6px 10px;
            font-size: 12px;
            cursor: pointer;
            border: 1px solid #ccc;
            border-radius: 4px;
            background-color: #f9f9f9;
            color: #333;
        }
        button:hover {
            background-color: #e9e9e9;
        }
        button:disabled {
            background-color: #f5f5f5;
            color: #999;
            cursor: not-allowed;
        }
        #status {
            margin-left: auto;
            color: #666;
            font-size: 13px;
        }

        #main {
            flex: 1 1 auto;
            min-height: 0;
            display: flex;
            width: 100%;
        }

        .ctrl-group {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .ctrl-group label {
            color: #333;
            font-size: 12px;
            white-space: nowrap;
        }

        .ctrl-group input[type="number"] {
            width: 90px;
            padding: 5px 8px;
            border: 1px solid #ccc;
            border-radius: 4px;
            font-size: 12px;
        }

        .pattern-btn.active {
            background-color: #e9e9e9;
        }

        #surface-colors {
            flex: 0 0 240px;
            min-height: 0;
            background: #ffffff;
            border-left: 1px solid #ddd;
            padding: 10px 10px;
            display: flex;
            flex-direction: column;
        }

        #surface-colors.collapsed {
            flex: 0 0 32px;
            padding: 10px 6px;
        }

        #surface-colors .title {
            font-size: 12px;
            font-weight: 600;
            color: #333;
            margin-bottom: 8px;
        }

        #surface-colors .header-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 8px;
        }

        #surface-colors .header-row .title {
            margin-bottom: 0;
        }

        #surface-colors-toggle {
            padding: 4px 6px;
            font-size: 12px;
            line-height: 1;
        }

        #surface-colors.collapsed .table-wrap {
            display: none;
        }

        #surface-colors.collapsed .title {
            display: none;
        }

        #surface-colors .table-wrap {
            flex: 1 1 auto;
            min-height: 0;
            max-height: none;
            overflow: auto;
            border: 1px solid #ddd;
            border-radius: 4px;
        }

        #surface-colors table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }

        #surface-colors th,
        #surface-colors td {
            padding: 4px 6px;
            border-bottom: 1px solid #eee;
            text-align: left;
            white-space: nowrap;
        }

        #surface-colors th {
            position: sticky;
            top: 0;
            background: #fafafa;
            z-index: 1;
            font-weight: 600;
        }

        #surface-colors select {
            font-size: 12px;
            width: 100%;
            box-sizing: border-box;
            height: 22px;
            line-height: 22px;
            padding: 0 6px;
        }
    </style>
</head>
<body>
    <div class="header">Render Optical System</div>
    <div id="controls">
        <button id="draw-btn">Render</button>
        <button id="view-xz-btn">X-Z View</button>
        <button id="view-yz-btn">Y-Z View</button>
        <button id="clear-btn">Clear</button>

        <div class="ctrl-group">
            <label for="draw-ray-count-input">Ray number:</label>
            <input type="number" id="draw-ray-count-input" value="1" min="1" max="10001" step="2">
        </div>

        <div class="ctrl-group">
            <label>Ray colors by:</label>
            <button id="object-color-btn" class="pattern-btn active" type="button">Object</button>
            <button id="segment-color-btn" class="pattern-btn" type="button">Segment</button>
        </div>

        <div id="status">Ready</div>
    </div>
    <div id="main">
        <div id="threejs-container"></div>
        <div id="surface-colors">
            <div class="header-row">
                <div class="title">Surface Colors</div>
                <button id="surface-colors-toggle" type="button" title="Collapse/Expand">◀</button>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Color</th>
                        </tr>
                    </thead>
                    <tbody id="surface-colors-tbody"></tbody>
                </table>
            </div>
        </div>
    </div>
    <script src="https://unpkg.com/three@0.138.0/build/three.min.js"></script>
    <script src="https://unpkg.com/three@0.138.0/examples/js/controls/OrbitControls.js"></script>
    <script>
        console.log('🚀 Popup window script starting...');
        console.log('THREE available:', typeof THREE !== 'undefined');
        
        // Wait for THREE to be available
        function initPopup() {
            if (typeof THREE === 'undefined') {
                console.error('❌ THREE.js not loaded');
                setTimeout(initPopup, 100);
                return;
            }
            
            console.log('✅ THREE.js loaded');
            
            // Initialize Three.js scene
            const container = document.getElementById('threejs-container');
            const rect = container.getBoundingClientRect();
            const width = Math.max(1, Math.floor(rect.width));
            const height = Math.max(1, Math.floor(rect.height));
            const aspect = width / height;
            const viewSize = 50;
            
            console.log('📐 Container size:', width, 'x', height);
            
            const scene = new THREE.Scene();
            scene.userData = scene.userData || {};
            scene.userData.renderContext = { three: THREE, global: window };
            const camera = new THREE.OrthographicCamera(
                -viewSize * aspect / 2,
                viewSize * aspect / 2,
                viewSize / 2,
                -viewSize / 2,
                0.1,
                10000
            );
            
            const renderer = new THREE.WebGLRenderer({ 
                antialias: true, 
                alpha: true,
                precision: 'highp',
                logarithmicDepthBuffer: true
            });
            renderer.setPixelRatio(window.devicePixelRatio);
            // Let CSS control the canvas display size; match the backing buffer to container pixels.
            renderer.setSize(width, height, false);
            renderer.setClearColor(0xffffff, 1);
            renderer.sortObjects = false;
            renderer.shadowMap.enabled = false;
            container.appendChild(renderer.domElement);
            
            console.log('🎬 Scene and renderer created');
            
            // Add OrbitControls
            const controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            controls.enableRotate = true;
            controls.enablePan = true;
            controls.enableZoom = true;
            // Don't set mouseButtons - use defaults

            // Track whether the user has manually adjusted the view.
            // If true, resizing should NOT refit/recenter the view.
            window.__userAdjustedView = false;
            controls.addEventListener('start', () => {
                window.__userAdjustedView = true;
            });
            
            console.log('🎮 OrbitControls initialized');
            
            // Set initial camera position (same as main Draw Cross: view from side, Y-Z plane)
            camera.position.set(0, 50, 100);
            camera.lookAt(0, 0, 0);
            camera.up.set(0, 1, 0);  // Y-axis is up
            controls.target.set(0, 0, 100);  // Look at center of optical system
            controls.update();
            
            // Zoom is handled by OrbitControls (orthographic camera.zoom).
            
            // Add lights
            const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
            scene.add(ambientLight);
            const directionalLight = new THREE.DirectionalLight(0xffffff, 0.4);
            directionalLight.position.set(10, 10, 10);
            scene.add(directionalLight);
            
            // Animation loop
            function animate() {
                requestAnimationFrame(animate);
                controls.update();
                renderer.render(scene, camera);
            }
            animate();
            
            console.log('🎥 Animation started');

            // Resize handling: observe the actual container size.
            // When the popup is very small, controls can wrap and change the canvas height
            // without a reliable one-to-one window resize event; ResizeObserver fixes that.
            let __resizeRaf = 0;
            let __lastResizeSent = 0;
            let __lastResizeW = 0;
            let __lastResizeH = 0;

            function applyResize() {
                const r = container.getBoundingClientRect();
                const w = Math.max(1, Math.round(r.width));
                const h = Math.max(1, Math.round(r.height));

                // Avoid extreme aspect glitches when height is momentarily ~0 during layout.
                if (w < 2 || h < 2) {
                    return;
                }

                renderer.setPixelRatio(window.devicePixelRatio);
                renderer.setSize(w, h, false);
                controls.update();

                if (camera && camera.isOrthographicCamera) {
                    const asp = w / h;
                    const currentHeight = camera.top - camera.bottom;
                    const currentCenterX = (camera.left + camera.right) / 2;
                    const currentCenterY = (camera.top + camera.bottom) / 2;
                    const nextWidth = currentHeight * asp;

                    camera.left = currentCenterX - nextWidth / 2;
                    camera.right = currentCenterX + nextWidth / 2;
                    camera.top = currentCenterY + currentHeight / 2;
                    camera.bottom = currentCenterY - currentHeight / 2;
                    camera.updateProjectionMatrix();
                }

                // Only for the initial, untouched view: refit to keep the full system in frame.
                // Debounce slightly to avoid spamming postMessage during continuous resize.
                if (!window.__userAdjustedView && window.opener) {
                    const now = performance.now();
                    const sizeChanged = (w !== __lastResizeW) || (h !== __lastResizeH);
                    if (sizeChanged && (now - __lastResizeSent) > 80) {
                        __lastResizeSent = now;
                        __lastResizeW = w;
                        __lastResizeH = h;
                        const axis = window.__currentViewAxis || 'YZ';
                        window.opener.postMessage({ action: 'popup-resize', viewAxis: axis }, '*');
                    }
                }
            }

            function scheduleResize() {
                if (__resizeRaf) cancelAnimationFrame(__resizeRaf);
                // Two RAFs: wait for flex/line-wrap layout to settle.
                __resizeRaf = requestAnimationFrame(() => {
                    __resizeRaf = requestAnimationFrame(() => {
                        __resizeRaf = 0;
                        applyResize();
                    });
                });
            }

            window.addEventListener('resize', scheduleResize);
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(() => scheduleResize());
                ro.observe(container);
            }
            
            // Store references globally in popup
            window.scene = scene;
            window.camera = camera;
            window.renderer = renderer;
            window.controls = controls;
            
            console.log('💾 References stored globally');
            
            // Button event handlers - communicate with parent
            const drawBtn = document.getElementById('draw-btn');
            const xzBtn = document.getElementById('view-xz-btn');
            const yzBtn = document.getElementById('view-yz-btn');
            const clearBtn = document.getElementById('clear-btn');
            const status = document.getElementById('status');

            const rayCountInput = document.getElementById('draw-ray-count-input');
            const objectColorBtn = document.getElementById('object-color-btn');
            const segmentColorBtn = document.getElementById('segment-color-btn');

            const surfaceColorsTbody = document.getElementById('surface-colors-tbody');
            const surfaceColorsPanel = document.getElementById('surface-colors');
            const surfaceColorsToggle = document.getElementById('surface-colors-toggle');

            const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
            const COLOR_PALETTE = [
                { name: 'Light Pink', hex: '#F8BBD0' },
                { name: 'Light Red', hex: '#FFCDD2' },
                { name: 'Light Orange', hex: '#FFE0B2' },
                { name: 'Light Amber', hex: '#FFECB3' },
                { name: 'Light Yellow', hex: '#FFF9C4' },
                { name: 'Light Lime', hex: '#F0F4C3' },
                { name: 'Light Green', hex: '#C8E6C9' },
                { name: 'Light Mint', hex: '#B2DFDB' },
                { name: 'Light Cyan', hex: '#B3E5FC' },
                { name: 'Light Sky', hex: '#BBDEFB' },
                { name: 'Light Blue', hex: '#90CAF9' },
                { name: 'Light Indigo', hex: '#C5CAE9' },
                { name: 'Light Purple', hex: '#E1BEE7' },
                { name: 'Light Lavender', hex: '#D1C4E9' },
                { name: 'Light Peach', hex: '#FFCCBC' },
                { name: 'Light Gray', hex: '#ECEFF1' }
            ];

            function isPlainObject(v) {
                return !!v && typeof v === 'object' && !Array.isArray(v);
            }

            function surfaceColorKey(surf) {
                try {
                    const bid = String(surf?._blockId ?? '').trim();
                    const role = String(surf?._surfaceRole ?? '').trim();
                    if (bid && role) return 'p:' + bid + '|' + role;
                } catch (_) {}
                try {
                    const sid = Number(surf?.id);
                    if (Number.isFinite(sid)) return 'id:' + String(Math.floor(sid));
                } catch (_) {}
                const idx = Number(surf?.index0);
                return 'i:' + String(Math.floor(Number.isFinite(idx) ? idx : 0));
            }

            function loadColorOverrides() {
                try {
                    const raw = localStorage.getItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY);
                    if (!raw) return {};
                    const parsed = JSON.parse(raw);
                    return isPlainObject(parsed) ? parsed : {};
                } catch (_) {
                    return {};
                }
            }

            function saveColorOverrides(map) {
                try {
                    localStorage.setItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY, JSON.stringify(map || {}));
                } catch (e) {
                    console.warn('⚠️ Failed to save surface color overrides:', e);
                }
            }

            function requestRedrawFromPopup() {
                try {
                    if (!window.opener) return;
                    const viewState = getPopupViewState();
                    window.opener.postMessage({ action: 'draw-cross', ...viewState }, '*');
                    if (status) status.textContent = 'Redrawing...';
                } catch (e) {
                    console.warn('⚠️ Redraw request failed:', e);
                }
            }

            function renderSurfaceColorsTable(surfaces) {
                if (!surfaceColorsTbody) return;
                const list = Array.isArray(surfaces) ? surfaces : [];
                const overrides = loadColorOverrides();

                const applySelectSwatch = (selectEl) => {
                    try {
                        const v = String(selectEl?.value || '').trim();
                        if (!v) {
                            selectEl.style.backgroundColor = '';
                            return;
                        }
                        // v is a hex string like "#RRGGBB".
                        selectEl.style.backgroundColor = v;
                    } catch (_) {}
                };

                surfaceColorsTbody.innerHTML = '';
                for (const surf of list) {
                    const tr = document.createElement('tr');

                    const idx0 = (Number(surf?.index0) || 0);
                    const tdIndex = document.createElement('td');
                    tdIndex.textContent = String(idx0);

                    const tdColor = document.createElement('td');
                    const sel = document.createElement('select');
                    const key = surfaceColorKey(surf);
                    const current = (typeof overrides[key] === 'string') ? overrides[key] : '';

                    const optDefault = document.createElement('option');
                    optDefault.value = '';
                    optDefault.textContent = 'Default';
                    sel.appendChild(optDefault);

                    for (const c of COLOR_PALETTE) {
                        const opt = document.createElement('option');
                        opt.value = c.hex;
                        opt.textContent = c.name;
                        opt.style.color = c.hex;
                        sel.appendChild(opt);
                    }

                    sel.value = current;
                    applySelectSwatch(sel);
                    sel.addEventListener('change', () => {
                        const next = String(sel.value || '').trim();
                        const nextMap = loadColorOverrides();
                        if (!next) {
                            delete nextMap[key];
                        } else {
                            nextMap[key] = next;
                        }
                        saveColorOverrides(nextMap);
                        applySelectSwatch(sel);
                        requestRedrawFromPopup();
                    });

                    tdColor.appendChild(sel);

                    tr.appendChild(tdIndex);
                    tr.appendChild(tdColor);
                    surfaceColorsTbody.appendChild(tr);
                }
            }

            function applySurfaceColorsCollapsedState(collapsed) {
                if (!surfaceColorsPanel || !surfaceColorsToggle) return;
                const isCollapsed = collapsed === true;
                surfaceColorsPanel.classList.toggle('collapsed', isCollapsed);
                surfaceColorsToggle.textContent = isCollapsed ? '▶' : '◀';
            }

            // Default: collapsed
            window.__surfaceColorsCollapsed = true;
            applySurfaceColorsCollapsedState(window.__surfaceColorsCollapsed);

            if (surfaceColorsToggle) {
                surfaceColorsToggle.addEventListener('click', () => {
                    window.__surfaceColorsCollapsed = !window.__surfaceColorsCollapsed;
                    applySurfaceColorsCollapsedState(window.__surfaceColorsCollapsed);
                });
            }

            window.__rayColorMode = 'object';

            function setPopupRayColorMode(mode) {
                window.__rayColorMode = mode === 'segment' ? 'segment' : 'object';
                if (objectColorBtn && segmentColorBtn) {
                    objectColorBtn.classList.toggle('active', window.__rayColorMode === 'object');
                    segmentColorBtn.classList.toggle('active', window.__rayColorMode === 'segment');
                }
            }

            if (objectColorBtn) {
                objectColorBtn.addEventListener('click', () => setPopupRayColorMode('object'));
            }
            if (segmentColorBtn) {
                segmentColorBtn.addEventListener('click', () => setPopupRayColorMode('segment'));
            }
            
            console.log('🔧 Setting up popup button handlers...');
            console.log('Buttons:', {drawBtn, xzBtn, yzBtn, clearBtn, status});

            // Receive status updates from parent
            window.addEventListener('message', (event) => {
                if (!window.opener || event.source !== window.opener) {
                    return;
                }
                const data = event.data || {};
                if (data && data.action === 'surface-list') {
                    try {
                        renderSurfaceColorsTable(data.surfaces);
                    } catch (e) {
                        console.warn('⚠️ Failed to render surface colors table:', e);
                    }
                    return;
                }
                if (data && data.action === 'request-redraw') {
                    try {
                        const axisRaw = (data.viewAxis || window.__currentViewAxis || 'YZ').toString().toUpperCase();
                        window.__currentViewAxis = axisRaw === 'XZ' ? 'XZ' : 'YZ';
                    } catch (_) {}

                    try {
                        const viewState = getPopupViewState();
                        if (status) {
                            status.textContent = 'Redrawing...';
                        }
                        window.opener.postMessage({ action: 'draw-cross', ...viewState }, '*');
                    } catch (e) {
                        console.error('❌ request-redraw failed:', e);
                    }
                    return;
                }
                if (typeof data.status === 'string' && status) {
                    status.textContent = data.status;
                }
            });

            function getPopupViewState() {
                const rayCount = (() => {
                    const v = parseInt(rayCountInput?.value || '51', 10);
                    return Number.isFinite(v) && v > 0 ? v : 51;
                })();
                return {
                    userAdjustedView: !!window.__userAdjustedView,
                    viewAxis: window.__currentViewAxis || 'YZ',
                    rayCount,
                    rayColorMode: window.__rayColorMode || 'object',
                    target: {
                        x: controls?.target?.x ?? 0,
                        y: controls?.target?.y ?? 0,
                        z: controls?.target?.z ?? 0
                    },
                    camera: {
                        x: camera?.position?.x ?? 0,
                        y: camera?.position?.y ?? 0,
                        z: camera?.position?.z ?? 0
                    },
                    zoom: camera?.zoom ?? 1
                };
            }
            
            if (drawBtn) {
                drawBtn.addEventListener('click', () => {
                    console.log('🎯 Draw Cross button clicked in popup');
                    const viewState = getPopupViewState();
                    console.log('📤 Sending message to parent:', { action: 'draw-cross', ...viewState });
                    if (window.opener) {
                        window.opener.postMessage({ action: 'draw-cross', ...viewState }, '*');
                        status.textContent = 'Drawing...';
                    } else {
                        console.error('❌ window.opener not available');
                    }
                });
            }
            
            if (xzBtn) {
                xzBtn.addEventListener('click', () => {
                    console.log('🎯 X-Z View button clicked in popup');
                    window.__currentViewAxis = 'XZ';
                    if (window.opener) {
                        const viewState = getPopupViewState();
                        window.opener.postMessage({ action: 'view-xz', ...viewState }, '*');
                        status.textContent = 'Switching to X-Z view...';
                    }
                });
            }
            
            if (yzBtn) {
                yzBtn.addEventListener('click', () => {
                    console.log('🎯 Y-Z View button clicked in popup');
                    window.__currentViewAxis = 'YZ';
                    if (window.opener) {
                        const viewState = getPopupViewState();
                        window.opener.postMessage({ action: 'view-yz', ...viewState }, '*');
                        status.textContent = 'Switching to Y-Z view...';
                    }
                });
            }
            
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    console.log('🧹 Clear button clicked in popup');
                    // Clear all objects from scene except lights
                    const objectsToRemove = [];
                    scene.traverse((object) => {
                        if (object !== scene && !(object instanceof THREE.Light)) {
                            objectsToRemove.push(object);
                        }
                    });
                    objectsToRemove.forEach((obj) => {
                        scene.remove(obj);
                        if (obj.geometry) obj.geometry.dispose();
                        if (obj.material) {
                            if (Array.isArray(obj.material)) {
                                obj.material.forEach(mat => mat.dispose());
                            } else {
                                obj.material.dispose();
                            }
                        }
                    });
                    renderer.render(scene, camera);
                    status.textContent = 'Cleared';
                    console.log('✅ Scene cleared');
                });
            }
            
            // Notify parent that popup is ready
            console.log('✅ Popup window initialized successfully');
            console.log('📤 Sending popup-ready message to parent');
            if (window.opener) {
                window.opener.postMessage({ action: 'popup-ready' }, '*');
            }

            // Auto-render immediately on open (same as pressing the popup Render button)
            if (drawBtn && window.opener) {
                setTimeout(() => {
                    try {
                        drawBtn.click();
                    } catch (e) {
                        console.error('❌ Auto-render failed:', e);
                    }
                }, 0);
            }
        }
        
        // Start initialization
        initPopup();
    </script>
</body>
</html>
            `);
            popup.document.close();
            
            // Store reference
            window.popup3DWindow = popup;
            
        });
    }

        // System Data popup window button
        const openSystemDataWindowBtn = document.getElementById('open-system-data-window-btn');
        if (openSystemDataWindowBtn) {
                openSystemDataWindowBtn.addEventListener('click', () => {
                        if (window.__systemDataPopup && !window.__systemDataPopup.closed) {
                                try { window.__systemDataPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'System Data', 'width=1200,height=600');
                        window.__systemDataPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>System Data</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: white;
            color: #333;
            font-weight: 600;
            flex: 0 0 auto;
            border-bottom: 1px solid #ddd;
        }
        .controls {
            padding: 10px 12px;
            background: white;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
        }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
        }
        .content {
            flex: 1 1 auto;
            padding: 10px 12px;
            min-height: 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        textarea {
            flex: 1 1 auto;
            width: 100%;
            resize: none;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            font-size: 12px;
            line-height: 1.4;
            border: 1px solid #bbb;
            border-radius: 4px;
            padding: 10px;
            box-sizing: border-box;
            min-height: 0;
            background: white;
        }
    </style>
</head>
<body>
    <div class="header">System Data</div>
    <div class="controls">
        <button id="popup-calculate-paraxial">Calculate Paraxial</button>
        <button id="popup-calculate-seidel">Aberration Coefficients</button>
        <button id="popup-calculate-seidel-afocal">Aberration Coefficients (Afocal)</button>
        <label for="popup-reference-focal-length">Reference Focal Length:</label>
        <input type="text" id="popup-reference-focal-length" placeholder="Auto" style="width: 80px;" />
        <button id="popup-coord-transform">Coord Transform</button>
    </div>
    <div class="content">
        <textarea id="popup-system-data" placeholder="System information will appear here..."></textarea>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncFromOpener() {
            const ref = getOpenerEl('reference-focal-length');
            const src = getOpenerEl('system-data');
            const popupRef = document.getElementById('popup-reference-focal-length');
            const popupText = document.getElementById('popup-system-data');

            if (popupRef && ref && popupRef.value !== ref.value) {
                popupRef.value = ref.value;
            }
            if (popupText && src && popupText.value !== src.value) {
                popupText.value = src.value;
            }
        }

        function triggerOpenerClick(id) {
            const btn = getOpenerEl(id);
            if (btn) {
                btn.click();
                // allow async handlers to update textarea
                setTimeout(syncFromOpener, 50);
                setTimeout(syncFromOpener, 200);
            }
        }

        document.getElementById('popup-calculate-paraxial').addEventListener('click', () => triggerOpenerClick('calculate-paraxial-btn'));
        document.getElementById('popup-calculate-seidel').addEventListener('click', () => triggerOpenerClick('calculate-seidel-btn'));
        document.getElementById('popup-calculate-seidel-afocal').addEventListener('click', () => triggerOpenerClick('calculate-seidel-afocal-btn'));
        document.getElementById('popup-coord-transform').addEventListener('click', () => triggerOpenerClick('coord-transform-btn'));

        document.getElementById('popup-reference-focal-length').addEventListener('input', (e) => {
            const value = e.target.value;
            const ref = getOpenerEl('reference-focal-length');
            if (ref) ref.value = value;
            try {
                localStorage.setItem('systemData', JSON.stringify({ referenceFocalLength: value }));
            } catch (_) {}
        });

        // Keep in sync with the main window.
        setInterval(syncFromOpener, 500);
        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Spot Diagram popup window button
        const openSpotDiagramWindowBtn = document.getElementById('open-spot-diagram-window-btn');
        if (openSpotDiagramWindowBtn) {
                openSpotDiagramWindowBtn.addEventListener('click', () => {
                        if (window.__spotDiagramPopup && !window.__spotDiagramPopup.closed) {
                                try { window.__spotDiagramPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Spot Diagram', 'width=800,height=600');
                        window.__spotDiagramPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Spot Diagram</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: white;
            color: #333;
            font-weight: 600;
            flex: 0 0 auto;
            border-bottom: 1px solid #ddd;
        }
        .controls {
            padding: 10px 12px;
            background: white;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls input, .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .pattern-btn.active { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            background: white;
        }
        #popup-spot-diagram-container {
            min-height: 100%;
        }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Spot Diagram</div>
    <div class="controls">
        <label for="popup-spot-diagram-config-select">Config:</label>
        <select id="popup-spot-diagram-config-select"></select>

        <label for="popup-surface-number-select">Surf:</label>
        <select id="popup-surface-number-select"></select>

        <label for="popup-ray-count-input">Ray number:</label>
        <input type="number" id="popup-ray-count-input" value="501" min="1" max="10001" step="1" />

        <label for="popup-ring-count-select">Ring count:</label>
        <select id="popup-ring-count-select">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="6">6</option>
            <option value="7">7</option>
            <option value="8">8</option>
            <option value="9">9</option>
            <option value="10" selected>10</option>
            <option value="12">12</option>
            <option value="15">15</option>
            <option value="16">16</option>
            <option value="20">20</option>
            <option value="24">24</option>
            <option value="32">32</option>
        </select>

        <label>Ray pattern:</label>
        <button id="popup-annular-pattern-btn" class="pattern-btn active" type="button">Annular</button>
        <button id="popup-grid-pattern-btn" class="pattern-btn" type="button">Rectangle</button>

        <button id="popup-show-spot-diagram-btn" type="button">Show spot diagram</button>
    </div>
    <div class="note">
        Note: Select a surface where rays can reach (usually Image surface or earlier).
    </div>
    <div id="popup-spot-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-spot-progress-text" style="margin-bottom: 6px;">Calculating spot diagram...</div>
        <progress id="popup-spot-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-spot-diagram-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncSurfaceOptionsFromOpener() {
            const openerSelect = getOpenerEl('surface-number-select');
            const popupSelect = document.getElementById('popup-surface-number-select');
            if (!popupSelect) return;

            popupSelect.innerHTML = '';
            if (!openerSelect || !openerSelect.options) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'Select Surf';
                popupSelect.appendChild(opt);
                return;
            }

            for (const o of openerSelect.options) {
                const opt = document.createElement('option');
                opt.value = o.value;
                // Replace Japanese "面" prefix and "Surface" prefix with "Surf".
                const label = (o.textContent || '').replace(/^面\s*/,'Surf ').replace(/^Surface\s*/,'Surf ');
                opt.textContent = label;
                popupSelect.appendChild(opt);
            }

            // mirror selected value
            popupSelect.value = openerSelect.value;
        }

        function syncConfigOptionsFromOpener() {
            const openerCfg = getOpenerEl('spot-diagram-config-select');
            const popupCfg = document.getElementById('popup-spot-diagram-config-select');
            if (!popupCfg) return;

            popupCfg.innerHTML = '';
            if (!openerCfg || !openerCfg.options) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'Current';
                popupCfg.appendChild(opt);
                return;
            }

            for (const o of openerCfg.options) {
                const opt = document.createElement('option');
                opt.value = o.value;
                opt.textContent = o.textContent || '';
                popupCfg.appendChild(opt);
            }

            popupCfg.value = openerCfg.value;
        }

        function syncInputsFromOpener() {
            const openerRay = getOpenerEl('ray-count-input');
            const openerRing = getOpenerEl('ring-count-select');
            const popupRay = document.getElementById('popup-ray-count-input');
            const popupRing = document.getElementById('popup-ring-count-select');

            if (popupRay && openerRay && popupRay.value !== openerRay.value) popupRay.value = openerRay.value;
            if (popupRing && openerRing && popupRing.value !== openerRing.value) popupRing.value = openerRing.value;

            // pattern
            const annular = getOpenerEl('annular-pattern-btn');
            const grid = getOpenerEl('grid-pattern-btn');
            const popupAnnular = document.getElementById('popup-annular-pattern-btn');
            const popupGrid = document.getElementById('popup-grid-pattern-btn');
            if (popupAnnular && popupGrid) {
                const isAnnular = !!annular && annular.classList.contains('active');
                popupAnnular.classList.toggle('active', isAnnular);
                popupGrid.classList.toggle('active', !isAnnular);
            }
        }

        function syncConfigToOpener() {
            const popupCfg = document.getElementById('popup-spot-diagram-config-select');
            const openerCfg = getOpenerEl('spot-diagram-config-select');
            if (!popupCfg || !openerCfg) return;
            openerCfg.value = popupCfg.value;
            try {
                openerCfg.dispatchEvent(new Event('change', { bubbles: true }));
            } catch (_) {
                // ignore
            }
        }

        document.getElementById('popup-spot-diagram-config-select').addEventListener('change', () => {
            syncConfigToOpener();
            // surface options depend on config, so resync
            syncSurfaceOptionsFromOpener();
        });

        function setPopupPattern(isAnnular) {
            const popupAnnular = document.getElementById('popup-annular-pattern-btn');
            const popupGrid = document.getElementById('popup-grid-pattern-btn');
            popupAnnular.classList.toggle('active', isAnnular);
            popupGrid.classList.toggle('active', !isAnnular);

            const openerAnnular = getOpenerEl('annular-pattern-btn');
            const openerGrid = getOpenerEl('grid-pattern-btn');
            if (isAnnular && openerAnnular) openerAnnular.click();
            if (!isAnnular && openerGrid) openerGrid.click();
        }

        document.getElementById('popup-annular-pattern-btn').addEventListener('click', () => setPopupPattern(true));
        document.getElementById('popup-grid-pattern-btn').addEventListener('click', () => setPopupPattern(false));

        document.getElementById('popup-show-spot-diagram-btn').addEventListener('click', async () => {
            const popupContainer = document.getElementById('popup-spot-diagram-container');
            if (popupContainer) popupContainer.innerHTML = '';

            const progressWrapper = document.getElementById('popup-spot-progress-wrapper');
            const progressBarEl = document.getElementById('popup-spot-progressbar');
            const progressTextEl = document.getElementById('popup-spot-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const openerRay = getOpenerEl('ray-count-input');
            const openerRing = getOpenerEl('ring-count-select');
            const openerSurface = getOpenerEl('surface-number-select');
            const openerCfg = getOpenerEl('spot-diagram-config-select');
            const popupRay = document.getElementById('popup-ray-count-input');
            const popupRing = document.getElementById('popup-ring-count-select');
            const popupSurface = document.getElementById('popup-surface-number-select');
            const popupCfg = document.getElementById('popup-spot-diagram-config-select');

            if (openerRay && popupRay) openerRay.value = popupRay.value;
            if (openerRing && popupRing) openerRing.value = popupRing.value;
            if (openerSurface && popupSurface) openerSurface.value = popupSurface.value;
            if (openerCfg && popupCfg) {
                openerCfg.value = popupCfg.value;
                try { openerCfg.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
            }

            if (!window.opener || typeof window.opener.showSpotDiagram !== 'function') {
                if (popupContainer) popupContainer.textContent = 'showSpotDiagram is not available in the main window.';
                return;
            }

            try {
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };

                await window.opener.showSpotDiagram({
                    surfaceIndex: popupSurface && popupSurface.value !== '' ? parseInt(popupSurface.value, 10) : undefined,
                    rayCount: popupRay && popupRay.value !== '' ? parseInt(popupRay.value, 10) : undefined,
                    ringCount: popupRing && popupRing.value !== '' ? parseInt(popupRing.value, 10) : undefined,
                    configId: popupCfg && popupCfg.value !== '' ? String(popupCfg.value) : undefined,
                    containerElement: popupContainer,
                    onProgress
                });
                setProgress(100, 'Done');
            } catch (e) {
                if (popupContainer) popupContainer.textContent = String(e && e.message ? e.message : e);
                setProgress(100, 'Failed');
            }
        });

        function syncAll() {
            syncConfigOptionsFromOpener();
            syncSurfaceOptionsFromOpener();
            syncInputsFromOpener();
        }

        window.addEventListener('focus', syncAll);
        syncAll();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Spherical Aberration (Longitudinal Aberration) popup window button
        const openSphericalAberrationWindowBtn = document.getElementById('open-spherical-aberration-window-btn');
        if (openSphericalAberrationWindowBtn) {
                openSphericalAberrationWindowBtn.addEventListener('click', () => {
                        if (window.__sphericalAberrationPopup && !window.__sphericalAberrationPopup.closed) {
                                try { window.__sphericalAberrationPopup.focus(); } catch (_) {}
                    try {
                        if (typeof window.__sphericalAberrationPopup.renderSphericalAberration === 'function') {
                            window.__sphericalAberrationPopup.renderSphericalAberration();
                        }
                    } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Spherical Aberration', 'width=800,height=600');
                        window.__sphericalAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Spherical Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 90px;
        }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            background: white;
        }
        #popup-longitudinal-aberration-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Spherical Aberration</div>
    <div class="controls">
        <label for="popup-longitudinal-ray-count-input">Ray number:</label>
        <input type="number" id="popup-longitudinal-ray-count-input" value="20" min="1" max="1001" step="1" />
        <span class="note-inline" style="font-size:12px;color:#666;">(Always normalized by stop diameter)</span>
        <button id="popup-show-spherical-aberration-btn" type="button">Show spherical aberration diagram</button>
    </div>
    <div id="popup-spherical-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-spherical-progress-text" style="margin-bottom: 6px;">Calculating spherical aberration...</div>
        <progress id="popup-spherical-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="note">
        Note: X-axis is longitudinal aberration (mm), Y-axis is normalized pupil coordinate.
    </div>
    <div class="content">
        <div id="popup-longitudinal-aberration-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerRay = getOpenerEl('longitudinal-ray-count-input');
            const popupRay = document.getElementById('popup-longitudinal-ray-count-input');
            if (openerRay && popupRay) {
                popupRay.value = openerRay.value;
            }
        }

        window.renderSphericalAberration = async () => {
            const progressWrapper = document.getElementById('popup-spherical-progress-wrapper');
            const progressBarEl = document.getElementById('popup-spherical-progressbar');
            const progressTextEl = document.getElementById('popup-spherical-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const popupRay = document.getElementById('popup-longitudinal-ray-count-input');
            const rayCount = popupRay ? parseInt(popupRay.value, 10) : 51;
            const openerRay = getOpenerEl('longitudinal-ray-count-input');
            if (openerRay && Number.isFinite(rayCount)) {
                openerRay.value = String(rayCount);
            }

            const containerEl = document.getElementById('popup-longitudinal-aberration-container');
            if (containerEl) containerEl.innerHTML = '';

            try {
                if (!window.opener || typeof window.opener.showLongitudinalAberrationDiagram !== 'function') {
                    throw new Error('showLongitudinalAberrationDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.showLongitudinalAberrationDiagram({
                    rayCount: Number.isFinite(rayCount) ? rayCount : 51,
                    containerElement: containerEl,
                    onProgress
                });
                setProgress(100, 'Done');
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate spherical aberration diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-spherical-aberration-btn').addEventListener('click', () => {
            window.renderSphericalAberration();
        });

        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderSphericalAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Astigmatism popup window button
        const openAstigmatismWindowBtn = document.getElementById('open-astigmatism-window-btn');
        if (openAstigmatismWindowBtn) {
                openAstigmatismWindowBtn.addEventListener('click', () => {
                        if (window.__astigmatismPopup && !window.__astigmatismPopup.closed) {
                                try { window.__astigmatismPopup.focus(); } catch (_) {}
                                try {
                                        if (typeof window.__astigmatismPopup.renderAstigmatism === 'function') {
                                                window.__astigmatismPopup.renderAstigmatism();
                                        }
                                } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Astigmatism', 'width=800,height=600');
                        window.__astigmatismPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Astigmatism</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-astigmatic-field-curves-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Astigmatism</div>
    <div class="controls">
        <button id="popup-show-astigmatism-btn" type="button">Show astigmatism diagram</button>
    </div>
    <div id="popup-astigmatism-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-astigmatism-progress-text" style="margin-bottom: 6px;">Calculating astigmatism...</div>
        <progress id="popup-astigmatism-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="note">
        Note: Astigmatism diagram shows sagittal and meridional focal positions across field.
    </div>
    <div class="content">
        <div id="popup-astigmatic-field-curves-container"></div>
    </div>

    <script>
        window.renderAstigmatism = async () => {
            const containerEl = document.getElementById('popup-astigmatic-field-curves-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-astigmatism-progress-wrapper');
            const progressBarEl = document.getElementById('popup-astigmatism-progressbar');
            const progressTextEl = document.getElementById('popup-astigmatism-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            try {
                if (!window.opener || typeof window.opener.showAstigmatismDiagram !== 'function') {
                    throw new Error('showAstigmatismDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.showAstigmatismDiagram({
                    containerElement: containerEl,
                    onProgress
                });
                setProgress(100, 'Done');
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate astigmatism diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-astigmatism-btn').addEventListener('click', () => {
            window.renderAstigmatism();
        });

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderAstigmatism(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Distortion popup window button
        const openDistortionWindowBtn = document.getElementById('open-distortion-window-btn');
        if (openDistortionWindowBtn) {
                openDistortionWindowBtn.addEventListener('click', () => {
                        if (window.__distortionPopup && !window.__distortionPopup.closed) {
                                try { window.__distortionPopup.focus(); } catch (_) {}
                                try {
                                        if (typeof window.__distortionPopup.renderDistortion === 'function') {
                                                window.__distortionPopup.renderDistortion();
                                        }
                                } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Distortion', 'width=800,height=600');
                        window.__distortionPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Distortion</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        .plot-area { flex: 1 1 auto; min-height: 0; }
        #popup-distortion-grid-area { display: none; border-top: 1px solid #eee; }
        #popup-distortion-percent { height: 100%; }
        #popup-distortion-grid { height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Distortion</div>
    <div class="controls">
        <button id="popup-show-distortion-btn" type="button">Show distortion diagram</button>
        <label for="popup-distortion-grid-size">Grid Size:</label>
        <select id="popup-distortion-grid-size">
            <option value="10">10×10</option>
            <option value="15">15×15</option>
            <option value="20" selected>20×20</option>
            <option value="25">25×25</option>
            <option value="30">30×30</option>
            <option value="35">35×35</option>
            <option value="40">40×40</option>
            <option value="45">45×45</option>
            <option value="50">50×50</option>
        </select>
        <button id="popup-show-distortion-grid-btn" type="button">Show grid distortion</button>
    </div>
    <div id="popup-distortion-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-distortion-progress-text" style="margin-bottom: 6px;">Calculating distortion...</div>
        <progress id="popup-distortion-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-distortion-percent-area" class="plot-area"><div id="popup-distortion-percent"></div></div>
        <div id="popup-distortion-grid-area" class="plot-area"><div id="popup-distortion-grid"></div></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerGrid = getOpenerEl('grid-size-select');
            const popupGrid = document.getElementById('popup-distortion-grid-size');
            if (openerGrid && popupGrid) {
                popupGrid.value = openerGrid.value;
            }
        }

        function resizePlots() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const a = document.getElementById('popup-distortion-percent');
                const b = document.getElementById('popup-distortion-grid');
                if (a) plotly.Plots.resize(a);
                if (b) plotly.Plots.resize(b);
            } catch (_) {}
        }

        function setGridVisible(visible) {
            const gridArea = document.getElementById('popup-distortion-grid-area');
            const percentArea = document.getElementById('popup-distortion-percent-area');
            if (!gridArea || !percentArea) return;

            if (visible) {
                gridArea.style.display = 'block';
                percentArea.style.flex = '1 1 50%';
                gridArea.style.flex = '1 1 50%';
            } else {
                gridArea.style.display = 'none';
                percentArea.style.flex = '1 1 auto';
            }

            // Let layout settle, then resize plots
            setTimeout(resizePlots, 0);
        }

        window.renderDistortion = async () => {
            const percentEl = document.getElementById('popup-distortion-percent');
            if (percentEl) percentEl.innerHTML = '';
            // Default to full-height distortion plot
            setGridVisible(false);

            const progressWrapper = document.getElementById('popup-distortion-progress-wrapper');
            const progressBarEl = document.getElementById('popup-distortion-progressbar');
            const progressTextEl = document.getElementById('popup-distortion-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            try {
                if (!window.opener || typeof window.opener.generateDistortionPlots !== 'function') {
                    throw new Error('generateDistortionPlots is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.generateDistortionPlots({ targetElement: percentEl, onProgress });
                setProgress(100, 'Done');
                setTimeout(resizePlots, 0);
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (percentEl) {
                    percentEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate distortion diagram. Check console.</div>';
                }
            }
        };

        window.renderGridDistortion = async () => {
            const gridEl = document.getElementById('popup-distortion-grid');
            if (gridEl) gridEl.innerHTML = '';
            // Split view when grid is requested
            setGridVisible(true);

            const progressWrapper = document.getElementById('popup-distortion-progress-wrapper');
            const progressBarEl = document.getElementById('popup-distortion-progressbar');
            const progressTextEl = document.getElementById('popup-distortion-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const gridSizeEl = document.getElementById('popup-distortion-grid-size');
            const gridSize = gridSizeEl ? parseInt(gridSizeEl.value, 10) : 20;
            const openerGrid = getOpenerEl('grid-size-select');
            if (openerGrid && Number.isFinite(gridSize)) openerGrid.value = String(gridSize);

            try {
                if (!window.opener || typeof window.opener.generateGridDistortionPlot !== 'function') {
                    throw new Error('generateGridDistortionPlot is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.generateGridDistortionPlot({ gridSize: Number.isFinite(gridSize) ? gridSize : 20, targetElement: gridEl, onProgress });
                setProgress(100, 'Done');
                setTimeout(resizePlots, 0);
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (gridEl) {
                    gridEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate grid distortion. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-distortion-btn').addEventListener('click', () => window.renderDistortion());
        document.getElementById('popup-show-distortion-grid-btn').addEventListener('click', () => window.renderGridDistortion());
        window.addEventListener('resize', resizePlots);
        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();

        // Auto-render immediately on open (distortion percent)
        window.addEventListener('load', () => {
            try { window.renderDistortion(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Integrated Aberration popup window button
        const openIntegratedAberrationWindowBtn = document.getElementById('open-integrated-aberration-window-btn');
        if (openIntegratedAberrationWindowBtn) {
                openIntegratedAberrationWindowBtn.addEventListener('click', () => {
                        if (window.__integratedAberrationPopup && !window.__integratedAberrationPopup.closed) {
                                try { window.__integratedAberrationPopup.focus(); } catch (_) {}
                                try {
                                        if (typeof window.__integratedAberrationPopup.renderIntegratedAberration === 'function') {
                                                window.__integratedAberrationPopup.renderIntegratedAberration();
                                        }
                                } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Integrated Aberration', 'width=800,height=600');
                        window.__integratedAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Integrated Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-integrated-aberration-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Integrated Aberration</div>
    <div class="controls">
        <button id="popup-show-integrated-aberration-btn" type="button">Show integrated aberration diagram</button>
    </div>
    <div id="popup-integrated-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-integrated-progress-text" style="margin-bottom: 6px;">Calculating integrated aberration...</div>
        <progress id="popup-integrated-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-integrated-aberration-container"></div>
    </div>

    <script>
        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const el = document.getElementById('popup-integrated-aberration-container');
                if (el) plotly.Plots.resize(el);
            } catch (_) {}
        }

        window.renderIntegratedAberration = async () => {
            const containerEl = document.getElementById('popup-integrated-aberration-container');
            if (containerEl) containerEl.innerHTML = '';
            resizePlot();

            const progressWrapper = document.getElementById('popup-integrated-progress-wrapper');
            const progressBarEl = document.getElementById('popup-integrated-progressbar');
            const progressTextEl = document.getElementById('popup-integrated-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            try {
                if (!window.opener || typeof window.opener.showIntegratedAberrationDiagram !== 'function') {
                    throw new Error('showIntegratedAberrationDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.showIntegratedAberrationDiagram({ containerElement: containerEl, onProgress });
                setProgress(100, 'Done');
                resizePlot();
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate integrated aberration diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-integrated-aberration-btn').addEventListener('click', () => {
            window.renderIntegratedAberration();
        });

        window.addEventListener('resize', resizePlot);

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderIntegratedAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Optical Path Difference (OPD) popup window button
        const openOpdWindowBtn = document.getElementById('open-opd-window-btn');
        if (openOpdWindowBtn) {
                openOpdWindowBtn.addEventListener('click', () => {
                        if (window.__opdPopup && !window.__opdPopup.closed) {
                    // Always reopen fresh so stale about:blank popup code can't persist.
                    try { window.__opdPopup.close(); } catch (_) {}
                    window.__opdPopup = null;
                        }

                        const popup = window.open('', 'Optical Path Difference', 'width=800,height=600');
                        window.__opdPopup = popup;

                        try { popup.document.open(); } catch (_) {}

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Optical Path Difference</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-wavefront-container { flex: 1 1 auto; min-height: 0; }
        #popup-wavefront-container-stats { flex: 0 0 auto; padding: 8px 12px; font-size: 12px; color: #333; border-top: 1px solid #eee; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Optical Path Difference</div>
    <div class="controls">
        <label for="popup-wavefront-object-select">Object:</label>
        <select id="popup-wavefront-object-select"></select>
        <label for="popup-wavefront-plot-type-select">Plot type:</label>
        <select id="popup-wavefront-plot-type-select">
            <option value="surface">3D Surface</option>
            <option value="heatmap">Heatmap</option>
            <option value="multifield">Multi-field Comparison</option>
        </select>
        <label for="popup-wavefront-grid-size-select">Grid size:</label>
        <select id="popup-wavefront-grid-size-select">
            <option value="16">16x16</option>
            <option value="32">32x32</option>
            <option value="64" selected>64x64</option>
            <option value="128">128x128</option>
            <option value="256">256x256</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-zernike-fit-checkbox" type="checkbox" />
            Zernike (calc)
        </label>
        <button id="popup-show-wavefront-btn" type="button">Show wavefront diagram</button>
        <button id="popup-stop-opd-btn" type="button" disabled>Stop</button>
    </div>
    <div id="popup-opd-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-opd-progress-text" style="margin-bottom: 6px;">Calculating OPD...</div>
        <progress id="popup-opd-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-wavefront-container"></div>
        <div id="popup-wavefront-container-stats"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncObjectOptionsFromOpener() {
            const openerSelect = getOpenerEl('wavefront-object-select');
            const popupSelect = document.getElementById('popup-wavefront-object-select');
            if (!popupSelect) return;

            const current = popupSelect.value;
            const nextOptions = [];

            // MTF-style: build from opener.getObjectRows() first.
            let opener = null;
            try { opener = window.opener || null; } catch (_) { opener = null; }
            let objects = [];
            if (opener && typeof opener.getObjectRows === 'function') {
                try { objects = opener.getObjectRows(opener.tableObject); } catch (_) { objects = []; }
            }
            if (Array.isArray(objects) && objects.length > 0) {
                const toFiniteNumber = (v) => {
                    const n = (typeof v === 'number') ? v : parseFloat(v);
                    return (Number.isFinite(n) ? n : NaN);
                };
                const pickNumber = (obj, keys, fallback) => {
                    for (let i = 0; i < keys.length; i++) {
                        const k = keys[i];
                        if (!k) continue;
                        const raw = obj ? obj[k] : undefined;
                        if (raw === undefined || raw === null || raw === '') continue;
                        const n = toFiniteNumber(raw);
                        if (Number.isFinite(n)) return n;
                    }
                    return fallback;
                };
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(obj.position ?? obj.object ?? obj.Object ?? obj.objectType ?? 'Point');
                    const x = (obj.x ?? obj.xHeightAngle ?? 0);
                    const y = (obj.y ?? obj.yHeightAngle ?? 0);
                    nextOptions.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }

            // Fallback: clone opener select.
            if (nextOptions.length === 0 && openerSelect && openerSelect.options) {
                Array.from(openerSelect.options).forEach(opt => {
                    nextOptions.push({ value: String(opt.value), label: String(opt.textContent ?? '') });
                });
            }
            // Last fallback: placeholder + schedule a retry (opener tables may not be ready yet).
            if (nextOptions.length === 0) {
                nextOptions.push({ value: '0', label: '1' });
                setTimeout(() => {
                    try { syncObjectOptionsFromOpener(); } catch (_) {}
                }, 250);
            }

            popupSelect.innerHTML = '';
            for (const opt of nextOptions) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                popupSelect.appendChild(o);
            }

            if (current && Array.from(popupSelect.options).some(o => o.value === current)) {
                popupSelect.value = current;
            } else if (openerSelect && openerSelect.value && Array.from(popupSelect.options).some(o => o.value === openerSelect.value)) {
                popupSelect.value = openerSelect.value;
            } else {
                popupSelect.value = popupSelect.options[0]?.value ?? '0';
            }
        }

        function syncInputsFromOpener() {
            const openerPlotType = getOpenerEl('wavefront-plot-type-select');
            const openerGrid = getOpenerEl('wavefront-grid-size-select');
            const popupPlotType = document.getElementById('popup-wavefront-plot-type-select');
            const popupGrid = document.getElementById('popup-wavefront-grid-size-select');
            if (openerPlotType && popupPlotType) popupPlotType.value = openerPlotType.value;
            if (openerGrid && popupGrid) popupGrid.value = openerGrid.value;
        }

        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const el = document.getElementById('popup-wavefront-container');
                if (el) plotly.Plots.resize(el);
            } catch (_) {}
        }

        window.renderOPD = async () => {
            const containerEl = document.getElementById('popup-wavefront-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-opd-progress-wrapper');
            const progressBarEl = document.getElementById('popup-opd-progressbar');
            const progressTextEl = document.getElementById('popup-opd-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const popupObject = document.getElementById('popup-wavefront-object-select');
            const popupPlotType = document.getElementById('popup-wavefront-plot-type-select');
            const popupGrid = document.getElementById('popup-wavefront-grid-size-select');
            const popupZernikeFit = document.getElementById('popup-zernike-fit-checkbox');

            const objectIndex = (() => {
                if (!popupObject) return 0;
                const v = parseInt(String(popupObject.value), 10);
                if (Number.isFinite(v)) return v;
                const idx = Number(popupObject.selectedIndex);
                return Number.isFinite(idx) && idx >= 0 ? idx : 0;
            })();
            const plotType = popupPlotType ? popupPlotType.value : 'surface';
            const gridSize = popupGrid ? parseInt(popupGrid.value, 10) : 64;

            const openerObject = getOpenerEl('wavefront-object-select');
            const openerPlotType = getOpenerEl('wavefront-plot-type-select');
            const openerGrid = getOpenerEl('wavefront-grid-size-select');
            if (openerObject && Number.isFinite(objectIndex)) openerObject.value = String(objectIndex);
            if (openerPlotType) openerPlotType.value = plotType;
            if (openerGrid && Number.isFinite(gridSize)) openerGrid.value = String(gridSize);

            try {
                const computeInPopup = false;
                
                // Create cancel token (reuse PSF helper if available, or inline)
                const createCancelToken = window.opener.createCancelToken || (() => {
                    let aborted = false;
                    let reason = null;
                    const listeners = [];
                    return {
                        get aborted() { return aborted; },
                        get reason() { return reason; },
                        abort(r = 'User requested stop') {
                            if (aborted) return;
                            aborted = true;
                            reason = r;
                            listeners.forEach(fn => { try { fn(r); } catch (_) {} });
                        },
                        onAbort(fn) { listeners.push(fn); }
                    };
                });
                
                const popupCancelToken = createCancelToken();
                window.__popupOpdCancelToken = popupCancelToken;
                
                const stopBtn = document.getElementById('popup-stop-opd-btn');
                
                
                if (stopBtn) {
                    stopBtn.disabled = false;
                    stopBtn.textContent = 'Stop';
                }

                setProgress(0, 'Starting...');

                // NOTE: Wavefront generator supports only options.onProgress (same as PSF)
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                
                try {
                    if (!window.opener || typeof window.opener.showWavefrontDiagram !== 'function') {
                        throw new Error('showWavefrontDiagram is not available on opener');
                    }
                    await window.opener.showWavefrontDiagram(plotType, 'opd', Number.isFinite(gridSize) ? gridSize : 64, Number.isFinite(objectIndex) ? objectIndex : 0, {
                        containerElement: containerEl,
                        cancelToken: popupCancelToken,
                        onProgress
                    });

                    // Optional: Zernike fit + push report to System Data
                    const shouldZernikeFit = !!(popupZernikeFit && popupZernikeFit.checked);
                    if (shouldZernikeFit) {
                        try {
                            if (String(plotType) === 'multifield') {
                                setProgress(100, 'Zernike fit is not available for Multi-field');
                            } else {
                                setProgress(98, 'Zernike fitting...');

                                const opener = window.opener;
                                const map = opener ? opener.__lastWavefrontMap : null;
                                const meta = opener ? opener.__lastWavefrontMeta : null;
                                if (!map || map?.error) {
                                    throw new Error('No valid wavefrontMap to fit');
                                }

                                const coordsAll = Array.isArray(map?.pupilCoordinates) ? map.pupilCoordinates : [];
                                const opdsAll = Array.isArray(map?.raw?.opds) ? map.raw.opds : (Array.isArray(map?.opds) ? map.opds : []);
                                const n = Math.min(coordsAll.length, opdsAll.length);
                                if (!n) {
                                    throw new Error('No OPD samples found');
                                }

                                // Filter out invalid samples for fitting
                                const coords = [];
                                const opds = [];
                                for (let i = 0; i < n; i++) {
                                    const c = coordsAll[i];
                                    const v = opdsAll[i];
                                    const x = Number(c?.x);
                                    const y = Number(c?.y);
                                    const opd = Number(v);
                                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(opd)) continue;
                                    coords.push({ x, y });
                                    opds.push(opd);
                                }
                                if (coords.length < 5) {
                                    throw new Error('Not enough valid samples for Zernike fitting');
                                }

                                const wavelength = Number(meta?.wavelength) || (() => {
                                    try {
                                        const w = Number(opener?.getPrimaryWavelength?.());
                                        if (Number.isFinite(w) && w > 0) return w;
                                    } catch (_) {}
                                    return 0.5876;
                                })();

                                const opticalSystemRows = (typeof opener?.getOpticalSystemRows === 'function')
                                    ? opener.getOpticalSystemRows()
                                    : null;
                                const calculator = opener?.createOPDCalculator
                                    ? opener.createOPDCalculator(opticalSystemRows, wavelength)
                                    : null;
                                const analyzer = opener?.createWavefrontAnalyzer
                                    ? opener.createWavefrontAnalyzer(calculator)
                                    : null;

                                if (!analyzer || typeof analyzer.fitZernikePolynomials !== 'function' || typeof analyzer.formatZernikeReportText !== 'function') {
                                    throw new Error('Wavefront analyzer is not available for Zernike fitting');
                                }

                                const maxNoll = Math.max(1, Math.min(37, opds.length));
                                const fit = analyzer.fitZernikePolynomials({ pupilCoordinates: coords, opds }, maxNoll);

                                // Store coefficients for the main window Zernike Fit button
                                try {
                                    opener.__lastWavefrontMap = opener.__lastWavefrontMap || map;
                                    opener.__lastWavefrontMap.zernike = fit;
                                    opener.__lastWavefrontMap.statistics = opener.__lastWavefrontMap.statistics || (map.statistics || {});
                                    opener.__lastWavefrontMap.statistics.skipZernikeFit = false;
                                } catch (_) {}

                                // Build a lightweight report map so formatting can rely on aligned sample arrays
                                const reportMap = {
                                    ...map,
                                    pupilCoordinates: coords,
                                    raw: { ...(map.raw || {}), opds },
                                    opds,
                                    zernike: fit
                                };

                                const reportText = analyzer.formatZernikeReportText(reportMap, { maxNoll });

                                const pushSystemData = (text) => {
                                    try {
                                        const ta = opener?.document?.getElementById?.('system-data');
                                        if (!ta || typeof ta.value !== 'string') return false;
                                        // Replace (clear then push) so each run shows only the latest report.
                                        ta.value = String(text || '');
                                        return true;
                                    } catch (_) {
                                        return false;
                                    }
                                };

                                const tryOpenSystemDataWindow = () => {
                                    try {
                                        const w = opener?.__systemDataPopup;
                                        if (w && !w.closed) {
                                            try { w.focus(); } catch (_) {}
                                            return true;
                                        }
                                    } catch (_) {}

                                    // Some browsers block popups triggered by synthetic clicks.
                                    // We still try the main-window button first, but fall back to
                                    // opening the System Data window directly from this user action.
                                    try {
                                        const btn = opener?.document?.getElementById?.('open-system-data-window-btn');
                                        if (btn) {
                                            btn.click();
                                            // If the click worked, the opener should set __systemDataPopup.
                                            try {
                                                const w = opener?.__systemDataPopup;
                                                if (w && !w.closed) {
                                                    try { w.focus(); } catch (_) {}
                                                    return true;
                                                }
                                            } catch (_) {}
                                        }
                                    } catch (_) {}

                                    // Fallback: open and render a minimal System Data popup directly.
                                    try {
                                        const popup = opener?.open?.('', 'System Data', 'width=1200,height=600');
                                        if (!popup) return false;
                                        try { opener.__systemDataPopup = popup; } catch (_) {}
                                        try { popup.document.open(); } catch (_) {}

                                        const html = [
                                            '<!DOCTYPE html>',
                                            '<html>',
                                            '<head>',
                                            '  <meta charset="UTF-8" />',
                                            '  <title>System Data</title>',
                                            '  <style>',
                                            '    html, body { height: 100%; }',
                                            '    body { margin: 0; font-family: Arial, sans-serif; display: flex; flex-direction: column; height: 100vh; background: #f4f4f4; }',
                                            '    .header { padding: 10px 12px; background: white; color: #333; font-weight: 600; border-bottom: 1px solid #ddd; }',
                                            '    .content { flex: 1 1 auto; padding: 10px 12px; min-height: 0; display: flex; }',
                                            '    textarea { flex: 1 1 auto; width: 100%; resize: none; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; line-height: 1.4; border: 1px solid #bbb; border-radius: 4px; padding: 10px; box-sizing: border-box; min-height: 0; background: white; }',
                                            '  </style>',
                                            '</head>',
                                            '<body onload="(function(){function getOpenerEl(id){try{return window.opener&&window.opener.document?window.opener.document.getElementById(id):null;}catch(e){return null;}}function sync(){var src=getOpenerEl(\\\'system-data\\\');var dst=document.getElementById(\\\'popup-system-data\\\');if(dst&&src&&dst.value!==src.value){dst.value=src.value;}}setInterval(sync,500);window.addEventListener(\\\'focus\\\',sync);sync();})();">',
                                            '  <div class="header">System Data</div>',
                                            '  <div class="content">',
                                            '    <textarea id="popup-system-data" placeholder="System information will appear here..."></textarea>',
                                            '  </div>',
                                            '</body>',
                                            '</html>'
                                        ].join('\\n');

                                        popup.document.write(html);
                                        try { popup.document.close(); } catch (_) {}
                                        try { popup.focus(); } catch (_) {}
                                        return true;
                                    } catch (_) {}

                                    return false;
                                };

                                const pushed = pushSystemData(reportText);
                                const opened = tryOpenSystemDataWindow();
                                if (pushed && opened) {
                                    setProgress(100, 'Zernike report pushed to System Data');
                                } else if (pushed) {
                                    setProgress(100, 'Zernike report pushed. See System data.');
                                } else {
                                    setProgress(100, 'Zernike fit done (could not write System Data). See System data.');
                                }
                            }
                        } catch (e) {
                            console.warn('⚠️ Zernike fit/push failed:', e);
                            setProgress(100, 'Zernike fit failed. See console.');
                        }
                    }

                    if (!shouldZernikeFit) setProgress(100, 'Done');
                    resizePlot();
                } catch (err) {
                    if (err?.message?.includes('Cancelled')) {
                        setProgress(100, 'Cancelled');
                        console.log('🛑 OPD calculation cancelled by user');
                    } else {
                        throw err;
                    }
                } finally {
                    if (stopBtn) {
                        stopBtn.disabled = true;
                        stopBtn.textContent = 'Stop';
                    }
                    window.__popupOpdCancelToken = null;
                }
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate OPD diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-wavefront-btn').addEventListener('click', () => window.renderOPD());
        document.getElementById('popup-stop-opd-btn').addEventListener('click', () => {
            console.log('🛑 Popup OPD Stop button clicked');
            const token = window.__popupOpdCancelToken;
            if (token && typeof token.abort === 'function') {
                token.abort('Stopped by user');
                const stopBtn = document.getElementById('popup-stop-opd-btn');
                if (stopBtn) {
                    stopBtn.disabled = true;
                    stopBtn.textContent = 'Stopping...';
                }
            }
        });

        function syncAll() {
            syncObjectOptionsFromOpener();
            syncInputsFromOpener();
        }
        window.addEventListener('resize', resizePlot);
        window.addEventListener('focus', syncAll);
        syncAll();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Point Spread Function popup window button
        const openPsfWindowBtn = document.getElementById('open-psf-window-btn');
        if (openPsfWindowBtn) {
                openPsfWindowBtn.addEventListener('click', () => {
                        if (window.__psfPopup && !window.__psfPopup.closed) {
                                // Always reopen fresh so stale about:blank popup code can't persist.
                                try { window.__psfPopup.close(); } catch (_) {}
                                window.__psfPopup = null;
                        }

                        const popup = window.open('', 'Point Spread Function', 'width=800,height=600');
                        window.__psfPopup = popup;

                        try { popup.document.open(); } catch (_) {}

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Point Spread Function</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-psf-container { flex: 1 1 auto; min-height: 0; }
        #popup-psf-container-stats { flex: 0 0 auto; padding: 8px 12px; font-size: 12px; color: #333; border-top: 1px solid #eee; }
        .note { padding: 8px 12px; font-size: 12px; color: #666; border-bottom: 1px solid #eee; background: #fff; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Point Spread Function</div>
    <div class="controls">
        <label for="popup-psf-object-select">Object:</label>
        <select id="popup-psf-object-select"><option value="0">1</option></select>
        <label for="popup-psf-sampling-select" title="Zero-padding increases FFT size without increasing OPD ray grid.">Zero pad:</label>
        <select id="popup-psf-sampling-select" title="Auto: pad to at least 512. None: no padding (FFT size = OPD grid). Or choose an explicit FFT size.">
            <option value="auto">Auto (≥512)</option>
            <option value="none">None</option>
            <option value="512">512</option>
            <option value="1024" selected>1024</option>
            <option value="2048">2048</option>
            <option value="4096">4096</option>
        </select>
        <label for="popup-psf-zernike-sampling-select">OPD grid:</label>
        <select id="popup-psf-zernike-sampling-select" title="Ray-traced OPD grid size (number of rays traced across pupil)">
            <option value="32">32x32</option>
            <option value="64">64x64</option>
            <option value="128">128x128</option>
            <option value="256">256x256</option>
            <option value="512">512x512</option>
            <option value="1024">1024x1024</option>
            <option value="2048">2048x2048</option>
            <option value="4096">4096x4096</option>
        </select>
        <label><input type="checkbox" id="popup-psf-log-scale-checkbox"> Log scale</label>
        <label><input type="checkbox" id="popup-psf-force-wasm-checkbox"> Force WASM</label>
        <button id="popup-show-psf-btn" type="button">Show PSF</button>
        <button id="popup-stop-psf-btn" type="button" disabled>Stop</button>
    </div>
    <div class="note">
        Note: PSF is calculated from OPD data using Fourier transform. Generate OPD data first.
    </div>
    <div id="popup-psf-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-psf-progress-text" style="margin-bottom: 6px;">Calculating PSF...</div>
        <progress id="popup-psf-progress" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-psf-container"></div>
        <div id="popup-psf-container-stats"></div>
    </div>
        <script>
        // Debug: confirm the popup script version in console.
                // build tag intentionally not shown
        function isIOSLike() {
            try {
                const ua = String(navigator.userAgent || '');
                if (/iPad|iPhone|iPod/i.test(ua)) return true;
                // iPadOS 13+ may masquerade as Mac
                if (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1) return true;
            } catch (_) {}
            return false;
        }

        function createCancelToken() {
            return {
                aborted: false,
                reason: null,
                _listeners: [],
                abort(reason = 'User requested stop') {
                    if (this.aborted) return;
                    this.aborted = true;
                    this.reason = reason;
                    const ls = Array.isArray(this._listeners) ? this._listeners.slice() : [];
                    for (const fn of ls) {
                        try { fn(reason); } catch (_) {}
                    }
                },
                onAbort(fn) {
                    if (typeof fn !== 'function') return;
                    if (this.aborted) {
                        try { fn(this.reason); } catch (_) {}
                        return;
                    }
                    this._listeners.push(fn);
                }
            };
        }

        let activeCancelToken = null;

        let __psfObjectSyncRetries = 0;
        const __psfScheduleObjectResync = () => {
            // On some loads, the opener's Tabulator may not be ready yet; retry briefly.
            if (__psfObjectSyncRetries >= 60) return;
            const delay = Math.min(2000, 150 + (__psfObjectSyncRetries * 150));
            __psfObjectSyncRetries++;
            setTimeout(() => {
                try { syncObjectOptionsFromOpener(); } catch (_) {}
            }, delay);
        };

        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncObjectOptionsFromOpener() {
            const openerPsfSelect = getOpenerEl('psf-object-select');
            const openerWavefrontSelect = getOpenerEl('wavefront-object-select');
            const openerSelect = openerWavefrontSelect || openerPsfSelect;
            const popupSelect = document.getElementById('popup-psf-object-select');
            if (!popupSelect) return;

            const toFiniteNumber = (v) => {
                const n = (typeof v === 'number') ? v : parseFloat(v);
                return Number.isFinite(n) ? n : NaN;
            };
            const pickNumber = (obj, keys, fallback) => {
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    if (!k) continue;
                    const raw = obj ? obj[k] : undefined;
                    if (raw === undefined || raw === null || raw === '') continue;
                    const n = toFiniteNumber(raw);
                    if (Number.isFinite(n)) return n;
                }
                return fallback;
            };

            const current = popupSelect.value;
            const nextOptions = [];

            // OPD/MTF-style: build options from opener.getObjectRows() first.
            let opener = null;
            try { opener = window.opener || null; } catch (_) { opener = null; }
            let objects = [];
            if (opener && typeof opener.getObjectRows === 'function') {
                try {
                    objects = opener.getObjectRows(opener.tableObject);
                    if (!Array.isArray(objects) || objects.length === 0) objects = [];
                } catch (_) {
                    objects = [];
                }
            }
            if (Array.isArray(objects) && objects.length > 0) {
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(
                        (obj.position !== undefined && obj.position !== null) ? obj.position :
                        (obj.object !== undefined && obj.object !== null) ? obj.object :
                        (obj.Object !== undefined && obj.Object !== null) ? obj.Object :
                        (obj.objectType !== undefined && obj.objectType !== null) ? obj.objectType :
                        'Point'
                    );
                    const x = pickNumber(obj, ['x', 'X', 'xFieldAngle', 'xAngle', 'xHeightAngle', 'XHeightAngle', 'x_height_angle', 'x_field_angle', 'x_angle'], 0);
                    const y = pickNumber(obj, ['y', 'Y', 'yFieldAngle', 'yAngle', 'yHeightAngle', 'YHeightAngle', 'y_height_angle', 'y_field_angle', 'y_angle', 'fieldAngle', 'angle'], 0);
                    nextOptions.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }

            // Fallback: clone opener select options if present (but ignore single placeholder).
            if (nextOptions.length === 0 && openerSelect && openerSelect.options && openerSelect.options.length > 0) {
                const opts = Array.from(openerSelect.options);
                let looksLikePlaceholder = false;
                if (opts.length === 1) {
                    const t = String(opts[0].textContent || '').trim().toLowerCase();
                    looksLikePlaceholder = (t === '0' || t === 'object 1' || t === 'object1');
                }
                if (!looksLikePlaceholder) {
                    const normalizeLabel = (label) => {
                        const s = String(label || '').trim();
                        // Convert e.g. "Object1 : Angle (...)" / "Object 1: ..." / "object1" => "1: ..." / "1"
                        const m = s.match(/^object\s*(\d+)\s*[:：]?\s*(.*)$/i);
                        if (m) {
                            const n = m[1];
                            const rest = String(m[2] || '').trim();
                            return rest ? (n + ': ' + rest) : String(n);
                        }
                        return s;
                    };
                    opts.forEach(opt => {
                        const raw = String((opt.textContent !== undefined && opt.textContent !== null) ? opt.textContent : '');
                        nextOptions.push({ value: String(opt.value), label: normalizeLabel(raw) });
                    });
                }
            }

            if (nextOptions.length === 0) {
                nextOptions.push({ value: '0', label: '1' });
                __psfScheduleObjectResync();
            } else {
                __psfObjectSyncRetries = 0;
            }

            popupSelect.innerHTML = '';
            for (const opt of nextOptions) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                popupSelect.appendChild(o);
            }

            if (current && Array.from(popupSelect.options).some(o => o.value === current)) {
                popupSelect.value = current;
                return;
            }
            const preferred = (openerPsfSelect && openerPsfSelect.value)
                ? openerPsfSelect.value
                : (openerSelect && openerSelect.value ? openerSelect.value : '');
            if (preferred && Array.from(popupSelect.options).some(o => o.value === preferred)) {
                popupSelect.value = preferred;
            } else {
                const firstOpt = (popupSelect.options && popupSelect.options.length > 0) ? popupSelect.options[0] : null;
                popupSelect.value = (firstOpt && firstOpt.value !== undefined && firstOpt.value !== null) ? firstOpt.value : '0';
            }
        }

        function syncInputsFromOpener() {
            const openerZeroPad = getOpenerEl('psf-zeropad-select');
            const openerZernikeSampling = getOpenerEl('psf-zernike-sampling-select');
            const openerLog = getOpenerEl('psf-log-scale-checkbox');
            const popupSampling = document.getElementById('popup-psf-sampling-select');
            const popupZernikeSampling = document.getElementById('popup-psf-zernike-sampling-select');
            const popupLog = document.getElementById('popup-psf-log-scale-checkbox');
            if (openerZeroPad && popupSampling && openerZeroPad.value) {
                if (Array.from(popupSampling.options || []).some(o => String(o.value) === String(openerZeroPad.value))) {
                    popupSampling.value = openerZeroPad.value;
                }
            }
            if (popupZernikeSampling && openerZernikeSampling && openerZernikeSampling.value) popupZernikeSampling.value = openerZernikeSampling.value;
            // Default: Log scale should start unchecked for PSF.
            try {
                if (openerLog) openerLog.checked = false;
                if (popupLog) popupLog.checked = false;
            } catch (_) {}
        }

        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const el = document.getElementById('popup-psf-container');
                if (el) plotly.Plots.resize(el);
            } catch (_) {}
        }

        window.renderPSF = async () => {
            const containerEl = document.getElementById('popup-psf-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-psf-progress-wrapper');
            const progressEl = document.getElementById('popup-psf-progress');
            const progressTextEl = document.getElementById('popup-psf-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressEl && Number.isFinite(value)) progressEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            const stopBtn = document.getElementById('popup-stop-psf-btn');
            if (stopBtn) {
                stopBtn.disabled = false;
            }

            activeCancelToken = createCancelToken();

            const popupObject = document.getElementById('popup-psf-object-select');
            const popupSampling = document.getElementById('popup-psf-sampling-select');
            const popupZernikeSampling = document.getElementById('popup-psf-zernike-sampling-select');
            const popupLog = document.getElementById('popup-psf-log-scale-checkbox');
            const popupForceWasm = document.getElementById('popup-psf-force-wasm-checkbox');

            let objectIndex = popupObject ? parseInt(popupObject.value, 10) : 0;
            if (!Number.isFinite(objectIndex) && popupObject && Number.isFinite(popupObject.selectedIndex)) {
                objectIndex = popupObject.selectedIndex;
            }
            const zernikeSampling = popupZernikeSampling ? parseInt(popupZernikeSampling.value, 10) : 128;
            const zeroPadRaw = popupSampling ? String(popupSampling.value || 'auto') : 'auto';
            const logScale = !!(popupLog && popupLog.checked);
            const forceWasm = !!(popupForceWasm && popupForceWasm.checked);
            const PSF_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__PSF_DEBUG);

            const openerObject = getOpenerEl('psf-object-select');
            const openerSampling = getOpenerEl('psf-sampling-select');
            const openerZeroPad = getOpenerEl('psf-zeropad-select');
            const openerZernikeSampling = getOpenerEl('psf-zernike-sampling-select');
            const openerLog = getOpenerEl('psf-log-scale-checkbox');
            if (openerObject && Number.isFinite(objectIndex)) openerObject.value = String(objectIndex);
            if (openerSampling && Number.isFinite(zernikeSampling)) openerSampling.value = String(zernikeSampling);
            if (openerZeroPad && zeroPadRaw) {
                if (Array.from(openerZeroPad.options || []).some(o => String(o.value) === String(zeroPadRaw))) {
                    openerZeroPad.value = zeroPadRaw;
                }
            }
            if (openerZernikeSampling && Number.isFinite(zernikeSampling)) openerZernikeSampling.value = String(zernikeSampling);
            if (openerLog) openerLog.checked = logScale;

            try {
                setProgress(0, 'Starting...');
                // Allow the popup to paint the progress UI before heavy computation begins.
                await new Promise(r => setTimeout(r, 0));

                const onProgress = (evt) => {
                    try {
                        const p = Number(evt && evt.percent);
                        const msg = (evt && evt.message) || (evt && evt.phase) || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };

                // Always compute inside the popup to avoid background throttling of the opener
                // when the main window is hidden/minimized/unfocused.
                {
                    const CACHE_BUSTER = '2026-01-14b';
                    const moduleURL = (relPath) => {
                        const baseHref = (() => {
                            try {
                                return (window.opener && window.opener.location && window.opener.location.href)
                                    ? window.opener.location.href
                                    : window.location.href;
                            } catch (_) {
                                return window.location.href;
                            }
                        })();
                        const url = new URL(relPath, baseHref);
                        if (!url.searchParams.has('v')) url.searchParams.set('v', CACHE_BUSTER);
                        return url.href;
                    };

                    const throwIfCancelled = (token) => {
                        if (token && token.aborted) {
                            const err = new Error(String(token.reason || 'Cancelled'));
                            err.code = 'CANCELLED';
                            throw err;
                        }
                    };
                    const raceWithCancel = async (promise, token) => {
                        if (!token) return await promise;
                        throwIfCancelled(token);
                        const cancelPromise = new Promise((_, reject) => {
                            token.onAbort((reason) => {
                                const err = new Error(String(reason || 'Cancelled'));
                                err.code = 'CANCELLED';
                                reject(err);
                            });
                        });
                        return await Promise.race([promise, cancelPromise]);
                    };

                    const [{ getOpticalSystemRows, getObjectRows, getSourceRows }, { PSFPlotter }, { createOPDCalculator, WavefrontAberrationAnalyzer }, { PSFCalculator }, { calculateFocalLength, findStopSurfaceIndex }, { DEFAULT_STOP_SEMI_DIAMETER }] = await Promise.all([
                        import(moduleURL('./utils/data-utils.js')),
                        import(moduleURL('./eva-psf-plot.js')),
                        import(moduleURL('./eva-wavefront.js')),
                        import(moduleURL('./eva-psf.js')),
                        import(moduleURL('./ray-paraxial.js')),
                        import(moduleURL('./block-schema.js'))
                    ]);

                    const cloneRows = (rows) => {
                        if (!Array.isArray(rows)) return rows;
                        try {
                            if (typeof structuredClone === 'function') return structuredClone(rows);
                        } catch (_) {}
                        try {
                            return JSON.parse(JSON.stringify(rows));
                        } catch (_) {
                            return rows;
                        }
                    };

                    const opticalSystemRows = (() => {
                        try {
                            if (window.opener && typeof window.opener.getOpticalSystemRows === 'function') {
                                // Prefer live Tabulator table data if available.
                                const r = window.opener.getOpticalSystemRows(window.opener.tableOpticalSystem);
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        return getOpticalSystemRows(window.tableOpticalSystem);
                    })();

                    const objects = (() => {
                        try {
                            if (window.opener && typeof window.opener.getObjectRows === 'function') {
                                const r = window.opener.getObjectRows(window.opener.tableObject);
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        return getObjectRows(window.tableObject);
                    })();

                    const sources = (() => {
                        try {
                            if (window.opener && typeof window.opener.getSourceRows === 'function') {
                                const r = window.opener.getSourceRows(window.opener.tableSource);
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        return getSourceRows ? getSourceRows(window.tableSource) : [];
                    })();
                    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) throw new Error('No optical system data (popup).');
                    if (!Array.isArray(objects) || objects.length === 0) throw new Error('No object data (popup).');

                    const toFiniteNumber = (v) => {
                        const n = (typeof v === 'number') ? v : parseFloat(v);
                        return (Number.isFinite(n) ? n : NaN);
                    };
                    const pickNumber = (obj, keys, fallback) => {
                        for (let i = 0; i < keys.length; i++) {
                            const k = keys[i];
                            if (!k) continue;
                            const raw = obj ? obj[k] : undefined;
                            if (raw === undefined || raw === null || raw === '') continue;
                            const n = toFiniteNumber(raw);
                            if (Number.isFinite(n)) return n;
                        }
                        return fallback;
                    };

                    let idx = Number.isFinite(objectIndex) ? objectIndex : 0;
                    // If the select values are 1-based for any reason, normalize.
                    if ((idx >= objects.length) && idx > 0 && (idx - 1) < objects.length) idx = idx - 1;
                    if (idx < 0) idx = 0;
                    const selectedObject = objects[idx];
                    if (!selectedObject) throw new Error('Selected object not found (popup).');

                    const primaryWl = (() => {
                        try {
                            if (window.opener && typeof window.opener.getPrimaryWavelength === 'function') {
                                const v = Number(window.opener.getPrimaryWavelength());
                                if (Number.isFinite(v) && v > 0) return v;
                            }
                        } catch (_) {}
                        return NaN;
                    })();
                    const s0 = (sources && sources.length > 0) ? sources[0] : null;
                    const wl0 = (s0 && s0.wavelength !== undefined && s0.wavelength !== null) ? Number(s0.wavelength) : NaN;
                    const wavelength = Number.isFinite(primaryWl) ? primaryWl : (Number.isFinite(wl0) ? wl0 : 0.5876);

                    // Match showPSFDiagram(): build a fieldSetting compatible with eva-wavefront.js.
                    const objectX = pickNumber(selectedObject, ['x', 'X', 'xFieldAngle', 'xAngle', 'xHeightAngle', 'XHeightAngle', 'x_height_angle', 'x_field_angle', 'x_angle'], 0);
                    const objectY = pickNumber(selectedObject, ['y', 'Y', 'yFieldAngle', 'yAngle', 'yHeightAngle', 'YHeightAngle', 'y_height_angle', 'y_field_angle', 'y_angle', 'fieldAngle', 'angle'], 0);
                    const objectTypeRaw = String(
                        (selectedObject && selectedObject.position !== undefined && selectedObject.position !== null) ? selectedObject.position :
                        (selectedObject && selectedObject.object !== undefined && selectedObject.object !== null) ? selectedObject.object :
                        (selectedObject && selectedObject.Object !== undefined && selectedObject.Object !== null) ? selectedObject.Object :
                        (selectedObject && selectedObject.objectType !== undefined && selectedObject.objectType !== null) ? selectedObject.objectType :
                        'Point'
                    );
                    const objectType = objectTypeRaw;
                    const objectTypeLower = String(objectTypeRaw).toLowerCase();
                    let fieldAngle = { x: 0, y: 0 };
                    let xHeight = 0;
                    let yHeight = 0;
                    if (/\\bangle\\b/.test(objectTypeLower)) {
                        fieldAngle = { x: Number(objectX) || 0, y: Number(objectY) || 0 };
                        xHeight = 0;
                        yHeight = 0;
                    } else {
                        fieldAngle = { x: 0, y: 0 };
                        xHeight = Number(objectX) || 0;
                        yHeight = Number(objectY) || 0;
                    }
                    const fieldSetting = {
                        objectIndex: idx,
                        type: objectType,
                        fieldAngle,
                        xHeight,
                        yHeight,
                        wavelength
                    };

                    const getActiveConfigLabel = () => {
                        try {
                            if (typeof localStorage === 'undefined') return '';
                            const raw = localStorage.getItem('systemConfigurations');
                            if (!raw) return '';
                            const sys = JSON.parse(raw);
                            const activeId = sys?.activeConfigId;
                            const cfg = Array.isArray(sys?.configurations)
                                ? sys.configurations.find(c => String(c?.id) === String(activeId))
                                : null;
                            if (!cfg) return (activeId !== undefined && activeId !== null) ? ('id=' + activeId) : '';
                            return ('id=' + cfg.id + ' name=' + (cfg.name || '')).trim();
                        } catch (_) {
                            return '';
                        }
                    };

                    const calcFNV1a32 = (str) => {
                        let hash = 0x811c9dc5;
                        for (let i = 0; i < str.length; i++) {
                            hash ^= str.charCodeAt(i);
                            hash = Math.imul(hash, 0x01000193);
                        }
                        return (hash >>> 0).toString(16);
                    };

                    const summarizeOpticalSystemRows = (rows) => {
                        if (!Array.isArray(rows) || rows.length === 0) return { checksum: '0' };
                        const parts = [];
                        for (const r of rows) {
                            if (!r) continue;
                            const obj = r['object type'] ?? r.object ?? r.Object ?? '';
                            const radius = r.radius ?? r.Radius ?? '';
                            const thickness = r.thickness ?? r.Thickness ?? '';
                            const material = r.material ?? r.Material ?? '';
                            const semidia = r.semidia ?? r.semidiameter ?? r.SemiDia ?? '';
                            const id = r.id ?? '';
                            parts.push(String(id) + '|' + String(obj) + '|' + String(radius) + '|' + String(thickness) + '|' + String(material) + '|' + String(semidia));
                        }
                        return { checksum: calcFNV1a32(parts.join(';')) };
                    };

                    if (PSF_DEBUG) {
                        try {
                            const fa = (fieldSetting && fieldSetting.fieldAngle && typeof fieldSetting.fieldAngle === 'object')
                                ? fieldSetting.fieldAngle
                                : { x: 0, y: 0 };
                            const line = '🧭 [PSF popup] objectIndex=' + idx + ' type=' + objectType +
                                ' fieldAngle=(' + (Number(fa.x) || 0) + ',' + (Number(fa.y) || 0) + ')' +
                                ' height=(' + (Number(fieldSetting && fieldSetting.xHeight) || 0) + ',' + (Number(fieldSetting && fieldSetting.yHeight) || 0) + ')' +
                                ' wl=' + (Number(wavelength) || 0);
                            console.log(line);
                            try {
                                if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                    window.opener.console.log(line);
                                }
                            } catch (_) {}
                        } catch (_) {}
                    }

                    if (PSF_DEBUG) {
                        try {
                            const summary = summarizeOpticalSystemRows(opticalSystemRows);
                            const idLine = '🧾 [PSF popup] activeConfig=' + (getActiveConfigLabel() || '(none)') +
                                ' rows=' + (Array.isArray(opticalSystemRows) ? opticalSystemRows.length : 0) +
                                ' checksum=' + (summary && summary.checksum ? summary.checksum : '0');
                            console.log(idLine);
                            try {
                                if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                    window.opener.console.log(idLine);
                                }
                            } catch (_) {}
                        } catch (_) {}
                    }

                    // Also log PSF physical scale inputs (pupil diameter / focal length) once available.
                    // This is critical when the plot auto-normalizes intensity and hides differences.
                    const logScaleInputs = (pupilDiameterMm, focalLengthMm, stopIndex) => {
                        if (!PSF_DEBUG) return;
                        try {
                            const line = '📏 [PSF popup] pupilDiameterMm=' + (Number(pupilDiameterMm) || 0) +
                                ' focalLengthMm=' + (Number(focalLengthMm) || 0) +
                                ' stopIndex=' + (Number.isFinite(Number(stopIndex)) ? Number(stopIndex) : -1);
                            console.log(line);
                            try {
                                if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                    window.opener.console.log(line);
                                }
                            } catch (_) {}
                        } catch (_) {}
                    };

                    const opdCalculator = createOPDCalculator(opticalSystemRows, wavelength);
                    const analyzer = new WavefrontAberrationAnalyzer(opdCalculator);
                    
                    // CRITICAL: Force stop mode to match render behavior
                    // PSF calculation should use same pupil sampling as render, not entrance pupil
                    try {
                        if (fieldSetting.type === 'Angle' || !fieldSetting.height) {
                            opdCalculator._setInfinitePupilMode(fieldSetting, 'stop');
                            if (PSF_DEBUG) console.log('🔑 [PSF Popup] Forced stop mode for infinite field');
                        }
                    } catch (e) {
                        console.warn('⚠️ [PSF Popup] Failed to set stop mode:', e);
                    }
                    
                    onProgress({ percent: 0, phase: 'opd', message: 'OPD...' });
                    const wavefrontGridSize = Number.isFinite(zernikeSampling)
                        ? Math.max(16, Math.floor(Number(zernikeSampling)))
                        : 128;
                    const wavefrontMap = await raceWithCancel(analyzer.generateWavefrontMap(fieldSetting, wavefrontGridSize, 'circular', {
                        // Match OPD display pipeline:
                        // - referenceSphere
                        // - no Zernike fit
                        // - piston+tilt removed (display)
                        recordRays: false,
                        progressEvery: 0,
                        renderFromZernike: false,
                        skipZernikeFit: true,
                        opdMode: 'referenceSphere',
                        opdDisplayMode: 'pistonTiltRemoved',
                        diagnoseDiscontinuities: PSF_DEBUG,
                        diagTopK: 8,
                        cancelToken: activeCancelToken,
                        onProgress: (evt) => {
                            const p = Number(evt && evt.percent);
                            const msg = (evt && evt.message) || (evt && evt.phase) || 'OPD...';
                            const phase = (evt && evt.phase) ? evt.phase : 'opd';
                            if (Number.isFinite(p)) onProgress({ percent: Math.max(0, Math.min(80, p * 0.8)), phase, message: msg });
                            else onProgress({ percent: null, phase, message: msg });
                        }
                    }), activeCancelToken);
                    throwIfCancelled(activeCancelToken);

                    if (wavefrontMap && wavefrontMap.error) {
                        const err = new Error((wavefrontMap.error && wavefrontMap.error.message) ? wavefrontMap.error.message : 'Wavefront generation failed (popup).');
                        err.code = 'WAVEFRONT_UNAVAILABLE';
                        err.wavefrontError = wavefrontMap.error;
                        throw err;
                    }

                    if (PSF_DEBUG) {
                        console.log('🔍 [PSF Popup] Wavefront map keys:', Object.keys(wavefrontMap));
                        console.log('🔍 [PSF Popup] pupilPhysicalRadiusMm:', wavefrontMap.pupilPhysicalRadiusMm);
                        console.log('🔍 [PSF Popup] pupilSamplingMode:', wavefrontMap.pupilSamplingMode);
                        console.log('🔍 [PSF Popup] entranceEffectiveRadiusMm:', wavefrontMap.entranceEffectiveRadiusMm);
                    }
                    
                    // CRITICAL: Use actual entrance pupil radius for spatial frequency scaling
                    // In entrance pupil mode, pupilPhysicalRadiusMm (stop radius) != actual entrance pupil radius
                    const actualPupilRadiusMm = (wavefrontMap.pupilSamplingMode === 'entrance' && 
                                                  Number.isFinite(wavefrontMap.entranceEffectiveRadiusMm))
                        ? wavefrontMap.entranceEffectiveRadiusMm
                        : wavefrontMap.pupilPhysicalRadiusMm;
                    
                    if (PSF_DEBUG) console.log('🔍 [PSF Popup] Using actualPupilRadiusMm:', actualPupilRadiusMm);

                    // Convert to PSF calculator format (gridData)
                    // Build OPD grid from the wavefront map samples (piston+tilt removed display OPD).
                    const gridSize = wavefrontGridSize;
                    const s = Math.max(2, Math.floor(Number(gridSize)));
                    const opdGrid = Array.from({ length: s }, () => new Float32Array(s));
                    const ampGrid = Array.from({ length: s }, () => new Float32Array(s));
                    const maskGrid = Array.from({ length: s }, () => Array(s).fill(false));
                    const xCoords = new Float32Array(s);
                    const yCoords = new Float32Array(s);

                    const pupilRange = (Number.isFinite(Number(wavefrontMap?.pupilRange)) && Number(wavefrontMap.pupilRange) > 0)
                        ? Number(wavefrontMap.pupilRange)
                        : 1.0;
                    for (let i = 0; i < s; i++) {
                        const t = (i / (s - 1 || 1)) * 2 - 1;
                        xCoords[i] = t * pupilRange;
                        yCoords[i] = t * pupilRange;
                    }

                    const coords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
                    const opdMicrons = (wavefrontMap?.display && Array.isArray(wavefrontMap.display.opds))
                        ? wavefrontMap.display.opds
                        : (Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds : []);
                    const n = Math.min(coords.length, opdMicrons.length);
                    for (let k = 0; k < n; k++) {
                        const c = coords[k];
                        const ix = Number.isInteger(c?.ix) ? c.ix : null;
                        const iy = Number.isInteger(c?.iy) ? c.iy : null;
                        if (ix === null || iy === null) continue;
                        if (ix < 0 || ix >= s || iy < 0 || iy >= s) continue;
                        const vMicrons = Number(opdMicrons[k]);
                        if (!Number.isFinite(vMicrons)) continue;
                        maskGrid[iy][ix] = true;
                        opdGrid[iy][ix] = vMicrons;
                        ampGrid[iy][ix] = 1.0;
                    }

                    const opdData = {
                        gridSize: s,
                        wavelength: wavelength,
                        gridData: {
                            opd: opdGrid,
                            amplitude: ampGrid,
                            pupilMask: maskGrid,
                            xCoords,
                            yCoords
                        }
                    };
                    
                    if (PSF_DEBUG) try {
                        let valid = 0;
                        let sum = 0;
                        let sum2 = 0;
                        let min = Infinity;
                        let max = -Infinity;
                        for (let iy = 0; iy < s; iy++) {
                            for (let ix = 0; ix < s; ix++) {
                                if (!maskGrid[iy][ix]) continue;
                                const v = Number(opdGrid[iy][ix]);
                                if (!Number.isFinite(v)) continue;
                                valid++;
                                sum += v;
                                sum2 += v * v;
                                if (v < min) min = v;
                                if (v > max) max = v;
                            }
                        }
                        const mean = valid ? (sum / valid) : NaN;
                        const rms = valid ? Math.sqrt(Math.max(0, sum2 / valid - mean * mean)) : NaN;
                        const ptp = (Number.isFinite(min) && Number.isFinite(max)) ? (max - min) : NaN;
                        const rmsW = (Number.isFinite(rms) && Number.isFinite(wavelength) && wavelength > 0) ? (rms / wavelength) : NaN;
                        const ptpW = (Number.isFinite(ptp) && Number.isFinite(wavelength) && wavelength > 0) ? (ptp / wavelength) : NaN;
                        const line = '📌 [PSF popup] OPD grid stats: valid=' + valid + '/' + (s * s) +
                            ' (' + (100 * valid / (s * s)).toFixed(1) + '%)' +
                            ' rms=' + (Number.isFinite(rms) ? rms.toExponential(3) : String(rms)) + 'µm' +
                            ' (' + (Number.isFinite(rmsW) ? rmsW.toExponential(3) : String(rmsW)) + 'λ)' +
                            ' ptp=' + (Number.isFinite(ptp) ? ptp.toExponential(3) : String(ptp)) + 'µm' +
                            ' (' + (Number.isFinite(ptpW) ? ptpW.toExponential(3) : String(ptpW)) + 'λ)';
                        console.log(line);
                        try {
                            if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                window.opener.console.log(line);
                            }
                        } catch (_) {}
                        if (wavefrontMap?.pupilMaskStats) {
                            console.log('📌 [PSF popup] pupilMaskStats:', wavefrontMap.pupilMaskStats);
                        }

                        try {
                            const mode = wavefrontMap && wavefrontMap.pupilSamplingMode;
                            const bestEffort = !!(wavefrontMap && wavefrontMap.bestEffortVignettedPupil);
                            if (mode) {
                                const msg = '📌 [PSF popup] pupilSamplingMode=' + String(mode) + (bestEffort ? ' (bestEffortVignettedPupil=true)' : '');
                                console.log(msg);
                                try {
                                    if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                        window.opener.console.log(msg);
                                    }
                                } catch (_) {}
                            }

                            const reasons = (wavefrontMap && wavefrontMap.invalidReasonCounts) ? wavefrontMap.invalidReasonCounts : null;
                            const top = reasons
                                ? Object.entries(reasons).sort((a, b) => ((b && b[1]) || 0) - ((a && a[1]) || 0)).slice(0, 8)
                                : [];
                            if (top.length) {
                                const msg = '📌 [PSF popup] invalid reasons top: ' + top.map((kv) => String(kv && kv[0]) + ':' + String(kv && kv[1])).join(', ');
                                console.log(msg);
                                try {
                                    if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                        window.opener.console.log(msg);
                                    }
                                } catch (_) {}
                            }
                        } catch (_) {}
                    } catch (_) {}

                    let pupilDiameterMm = actualPupilRadiusMm * 2;  // Use actual entrance pupil diameter
                    let focalLengthMm = 100.0;
                    let stopIndexForLog = -1;
                    
                    // Get stop diameter for PSF calculation
                    // CRITICAL: Always use stop diameter for Strehl ratio calculation
                    // Entrance pupil radius is only for understanding vignetting, not for defining diffraction limit
                    let stopDiameterMm = 24.0;  // Default
                    try {
                        const stopIndex = findStopSurfaceIndex(opticalSystemRows);
                        stopIndexForLog = stopIndex;
                        const stopRow = (stopIndex >= 0 && opticalSystemRows && opticalSystemRows.length > stopIndex) ? opticalSystemRows[stopIndex] : null;
                        const sdRaw =
                            (stopRow && stopRow.semidia !== undefined && stopRow.semidia !== null) ? stopRow.semidia :
                            (stopRow && stopRow.Semidia !== undefined && stopRow.Semidia !== null) ? stopRow.Semidia :
                            (stopRow && stopRow['Semi Diameter'] !== undefined && stopRow['Semi Diameter'] !== null) ? stopRow['Semi Diameter'] :
                            (stopRow && stopRow.aperture !== undefined && stopRow.aperture !== null) ? stopRow.aperture :
                            (stopRow && stopRow.Aperture !== undefined && stopRow.Aperture !== null) ? stopRow.Aperture :
                            NaN;
                        const sd = Math.abs(parseFloat(sdRaw));
                        if (Number.isFinite(sd) && sd > 0) {
                            const isApertureField = stopRow && (stopRow.aperture !== undefined || stopRow.Aperture !== undefined);
                            const stopRadiusMm = isApertureField ? (sd * 0.5) : sd;
                            if (Number.isFinite(stopRadiusMm) && stopRadiusMm > 0) stopDiameterMm = stopRadiusMm * 2;
                        }
                    } catch (_) {}
                    
                    // In entrance pupil mode, keep actualPupilRadiusMm for understanding
                    // but use stopDiameterMm for PSF calculation to maintain consistent diffraction limit
                    if (wavefrontMap.pupilSamplingMode === 'entrance') {
                        if (PSF_DEBUG) console.log('🔍 [PSF Popup] Entrance pupil mode: using stop diameter', stopDiameterMm, 'mm instead of entrance', actualPupilRadiusMm * 2, 'mm');
                        pupilDiameterMm = stopDiameterMm;
                    } else {
                        pupilDiameterMm = stopDiameterMm;  // Use stop diameter in stop mode too
                    }
                    
                    try {
                        const fl = calculateFocalLength(opticalSystemRows, wavelength);
                        if (Number.isFinite(fl) && Math.abs(fl) > 1e-9 && fl !== Infinity) focalLengthMm = Math.abs(fl);
                    } catch (_) {}

                    logScaleInputs(pupilDiameterMm, focalLengthMm, stopIndexForLog);

                    if (!window.__popupPsfCalculator) window.__popupPsfCalculator = new PSFCalculator();
                    const psfCalculator = window.__popupPsfCalculator;
                    const psfSamplingSize = Number.isFinite(zernikeSampling) ? zernikeSampling : 128;
                    const zeroPadTo = (zeroPadRaw === 'none')
                        ? psfSamplingSize
                        : (zeroPadRaw === 'auto')
                            ? 0
                            : (Number.isFinite(parseInt(zeroPadRaw)) ? parseInt(zeroPadRaw) : 0);
                    const psfResult = await raceWithCancel(psfCalculator.calculatePSF(opdData, {
                        samplingSize: psfSamplingSize,
                        zeroPadTo,
                        pupilDiameter: pupilDiameterMm,
                        focalLength: focalLengthMm,
                        forceImplementation: forceWasm ? 'wasm' : null,
                        // Zernike render removes piston+tilt (Noll 1..3) by design.
                        // Still safe to leave removeTilt=true for robustness; but keep it off to preserve definition.
                        removeTilt: false,
                        onProgress: (evt) => {
                            const p = Number(evt && evt.percent);
                            const msg = (evt && evt.message) || (evt && evt.phase) || 'PSF...';
                            const phase = (evt && evt.phase) ? evt.phase : 'psf';
                            if (!Number.isFinite(p)) { onProgress({ percent: null, phase, message: msg }); return; }
                            onProgress({ percent: 80 + 0.2 * p, phase, message: msg });
                        }
                    }), activeCancelToken);
                    throwIfCancelled(activeCancelToken);

                    const plotter = new PSFPlotter(containerEl);
                    await plotter.plot2DPSF(psfResult, { logScale, title: 'Point Spread Function' });
                }

                setProgress(100, 'Done');
                resizePlot();
                hideProgress();
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    const msg = String((err && err.message) || err || 'Unknown error');
                    const stack = String((err && err.stack) || '');
                    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => {
                        switch (ch) {
                            case '&': return '&amp;';
                            case '<': return '&lt;';
                            case '>': return '&gt;';
                            case '"': return '&quot;';
                            case "'": return '&#39;';
                            default: return ch;
                        }
                    });
                    const details = escapeHtml(msg + (stack ? '\\n\\n' + stack : ''));
                    containerEl.innerHTML =
                        '<div style="padding:20px;color:red;font-family:Arial;">' +
                            '<div style="font-weight:bold;margin-bottom:8px;">Failed to generate PSF</div>' +
                            '<pre style="white-space:pre-wrap;word-break:break-word;">' + details + '</pre>' +
                        '</div>';
                }
            } finally {
                try {
                    if (stopBtn) stopBtn.disabled = true;
                } catch (_) {}
            }
        };

        document.getElementById('popup-show-psf-btn').addEventListener('click', () => window.renderPSF());

        document.getElementById('popup-stop-psf-btn').addEventListener('click', () => {
            try {
                if (activeCancelToken && typeof activeCancelToken.abort === 'function') {
                    activeCancelToken.abort('Stopped by user');
                }
            } catch (_) {}
        });

        function syncAll() {
            syncObjectOptionsFromOpener();
            syncInputsFromOpener();
        }
        // Expose for opener-triggered refresh when reusing an existing popup window.
        window.syncAll = syncAll;
        window.syncObjectOptionsFromOpener = syncObjectOptionsFromOpener;
        window.addEventListener('resize', resizePlot);
        window.addEventListener('focus', syncAll);
        syncAll();

        // Do not auto-render on open; user triggers calculation via "Show PSF".
        window.addEventListener('load', () => {
            try {
                const popupSampling = document.getElementById('popup-psf-sampling-select');
                const popupZernikeSampling = document.getElementById('popup-psf-zernike-sampling-select');
                const popupLog = document.getElementById('popup-psf-log-scale-checkbox');
                if (popupSampling) popupSampling.value = '1024';
                if (popupZernikeSampling) popupZernikeSampling.value = '128';
                if (popupLog) popupLog.checked = false;
            } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Modulation Transfer Function (MTF) popup window button
        const openMtfWindowBtn = document.getElementById('open-mtf-window-btn');
        if (openMtfWindowBtn) {
                openMtfWindowBtn.addEventListener('click', () => {
                        if (window.__mtfPopup && !window.__mtfPopup.closed) {
                                try { window.__mtfPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Modulation Transfer Function', 'width=800,height=600');
                        window.__mtfPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Modulation Transfer Function</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 120px;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .note { padding: 8px 12px; font-size: 12px; color: #666; border-bottom: 1px solid #eee; background: #fff; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-mtf-container { flex: 1 1 auto; min-height: 0; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Modulation Transfer Function</div>
    <div class="controls">
        <label for="popup-mtf-wavelength-select">Wavelength:</label>
        <select id="popup-mtf-wavelength-select"></select>
        <label for="popup-mtf-object-select">Object:</label>
        <select id="popup-mtf-object-select"></select>
        <label for="popup-mtf-max-freq-input">Max (lp/mm):</label>
        <input id="popup-mtf-max-freq-input" type="number" min="0" step="1" value="100" />
        <label for="popup-mtf-sampling-select">Sampling:</label>
        <select id="popup-mtf-sampling-select">
            <option value="32">32x32</option>
            <option value="64">64x64</option>
            <option value="128">128x128</option>
            <option value="256" selected>256x256</option>
            <option value="512">512x512</option>
            <option value="1024">1024x1024</option>
            <option value="2048">2048x2048</option>
            <option value="4096">4096x4096</option>
        </select>
        <button id="popup-show-mtf-btn" type="button">Show MTF</button>
    </div>
    <div class="note">
        Note: MTF is computed from PSF via Fourier transform.
    </div>
    <div id="popup-mtf-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-mtf-progress-text" style="margin-bottom: 6px;">Calculating MTF...</div>
        <progress id="popup-mtf-progress" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-mtf-container"></div>
    </div>

    <script>
        function safeCall(fn, fallback) {
            try { return fn(); } catch (_) { return fallback; }
        }

        function getOpener() {
            try { return window.opener || null; } catch (_) { return null; }
        }

        function getPrimaryWavelength() {
            const opener = getOpener();
            if (!opener) return null;
            if (typeof opener.getPrimaryWavelength !== 'function') return null;
            const v = Number(safeCall(() => opener.getPrimaryWavelength(), 0));
            return Number.isFinite(v) && v > 0 ? v : null;
        }

        function buildWavelengthOptions() {
            const opener = getOpener();
            if (!opener) return [];
            const getSourceRows = opener.getSourceRows;
            const sources = (typeof getSourceRows === 'function')
                ? safeCall(() => getSourceRows(opener.tableSource), [])
                : [];
            const primary = getPrimaryWavelength();
            const out = [{ value: 'all', label: 'All' }];
            if (Array.isArray(sources) && sources.length > 0) {
                for (let i = 0; i < sources.length; i++) {
                    const wl = Number(sources[i]?.wavelength);
                    if (!Number.isFinite(wl) || wl <= 0) continue;
                    const nm = wl * 1000;
                    const label = Number.isFinite(primary) && Math.abs(wl - primary) < 1e-9
                        ? (nm.toFixed(1) + ' nm (primary)')
                        : (nm.toFixed(1) + ' nm');
                    out.push({ value: String(wl), label });
                }
            }
            if (out.length === 1) {
                out.push({ value: String(primary || 0.5876), label: (((primary || 0.5876) * 1000).toFixed(1) + ' nm') });
            }
            return out;
        }

        function buildObjectOptions() {
            const opener = getOpener();
            if (!opener) return [];
            const getObjectRows = opener.getObjectRows;
            const objects = (typeof getObjectRows === 'function')
                ? safeCall(() => getObjectRows(opener.tableObject), [])
                : [];
            const out = [];
            if (Array.isArray(objects) && objects.length > 0) {
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(obj.position ?? obj.object ?? obj.Object ?? obj.objectType ?? 'Point');
                    const x = (obj.x ?? obj.xHeightAngle ?? 0);
                    const y = (obj.y ?? obj.yHeightAngle ?? 0);
                    out.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }
            if (out.length === 0) out.push({ value: '0', label: '0' });
            return out;
        }

        function populateSelect(selectEl, options) {
            if (!selectEl) return;
            const current = selectEl.value;
            selectEl.innerHTML = '';
            for (const opt of options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                selectEl.appendChild(o);
            }
            if (current && Array.from(selectEl.options).some(o => o.value === current)) {
                selectEl.value = current;
            }
        }

        function syncAllOptions() {
            const wlSel = document.getElementById('popup-mtf-wavelength-select');
            const prevWl = wlSel ? wlSel.value : '';
            populateSelect(wlSel, buildWavelengthOptions());
            // Default to Primary (not All) on first open.
            if (wlSel && (!prevWl || !Array.from(wlSel.options).some(o => o.value === prevWl))) {
                const primary = getPrimaryWavelength();
                if (Number.isFinite(primary) && Array.from(wlSel.options).some(o => o.value === String(primary))) {
                    wlSel.value = String(primary);
                } else {
                    // Fallback to first numeric wavelength if present
                    const firstNumeric = Array.from(wlSel.options).find(o => o.value !== 'all');
                    if (firstNumeric) wlSel.value = firstNumeric.value;
                }
            }
            populateSelect(document.getElementById('popup-mtf-object-select'), buildObjectOptions());
        }

        window.renderMTF = async () => {
            const containerEl = document.getElementById('popup-mtf-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-mtf-progress-wrapper');
            const progressEl = document.getElementById('popup-mtf-progress');
            const progressTextEl = document.getElementById('popup-mtf-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressEl && Number.isFinite(value)) progressEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            const wlSel = document.getElementById('popup-mtf-wavelength-select');
            const objSel = document.getElementById('popup-mtf-object-select');
            const maxEl = document.getElementById('popup-mtf-max-freq-input');
            const samplingEl = document.getElementById('popup-mtf-sampling-select');

            const wlValue = wlSel ? String(wlSel.value) : '';
            const primary = getPrimaryWavelength();
            const wavelength = (wlValue === 'all') ? 'all' : Number(wlValue);
            const objectIndex = objSel ? parseInt(objSel.value, 10) : 0;
            const maxFreq = maxEl ? Number(maxEl.value) : 100;
            const sampling = samplingEl ? Number(samplingEl.value) : 256;

            try {
                const opener = getOpener();
                if (!opener || typeof opener.showMTFDiagram !== 'function') {
                    throw new Error('showMTFDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                // Allow the popup to paint the progress UI before heavy computation begins.
                await new Promise(r => setTimeout(r, 0));
                await opener.showMTFDiagram({
                    wavelengthMicrons: (wavelength === 'all') ? 'all' : (Number.isFinite(wavelength) ? wavelength : (primary || 0.5876)),
                    objectIndex: Number.isFinite(objectIndex) ? objectIndex : 0,
                    maxFrequencyLpmm: Number.isFinite(maxFreq) ? maxFreq : 100,
                    samplingSize: Number.isFinite(sampling) ? sampling : 256,
                    onProgress: (evt) => {
                        try {
                            const p = Number(evt?.percent);
                            const msg = evt?.message || evt?.phase || 'Working...';
                            if (Number.isFinite(p)) setProgress(p, msg);
                            else setProgress(undefined, msg);
                        } catch (_) {}
                    },
                    containerElement: containerEl
                });
                setProgress(100, 'Done');
                hideProgress();
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate MTF. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-mtf-btn').addEventListener('click', () => window.renderMTF());
        window.addEventListener('focus', syncAllOptions);
        window.addEventListener('load', () => syncAllOptions());
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Transverse Aberration popup window button
        const openTransverseAberrationWindowBtn = document.getElementById('open-transverse-aberration-window-btn');
        if (openTransverseAberrationWindowBtn) {
                openTransverseAberrationWindowBtn.addEventListener('click', () => {
                        if (window.__transverseAberrationPopup && !window.__transverseAberrationPopup.closed) {
                                try { window.__transverseAberrationPopup.focus(); } catch (_) {}
                    try {
                        if (typeof window.__transverseAberrationPopup.renderTransverseAberration === 'function') {
                            window.__transverseAberrationPopup.renderTransverseAberration();
                        }
                    } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Transverse Aberration', 'width=800,height=600');
                        window.__transverseAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Transverse Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 90px;
        }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-transverse-aberration-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header">Transverse Aberration</div>
    <div class="controls">
        <label for="popup-transverse-ray-count-input">Ray number:</label>
        <input type="number" id="popup-transverse-ray-count-input" value="101" min="1" max="1001" step="1" />
        <span class="note-inline" style="font-size:12px;color:#666;">(Always normalized by stop diameter)</span>
        <button id="popup-show-transverse-aberration-btn" type="button">Show transverse aberration diagram</button>
    </div>
    <div id="popup-transverse-progress-wrapper" style="display:none;padding:10px 12px;border-bottom:1px solid #eee;background:#fff;">
        <div id="popup-transverse-progress-text" style="margin-bottom: 6px; font-size:12px; color:#555;">Starting...</div>
        <progress id="popup-transverse-progressbar" value="0" max="100" style="display:block;width:calc(100% + 24px);margin-left:-12px;height:14px;"></progress>
    </div>
    <div class="note">
        Note: X-axis is transverse aberration (μm), Y-axis is normalized pupil coordinate.
    </div>
    <div class="content">
        <div id="popup-transverse-aberration-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerRay = getOpenerEl('transverse-ray-count-input');
            const popupRay = document.getElementById('popup-transverse-ray-count-input');
            if (openerRay && popupRay) {
                popupRay.value = openerRay.value;
            }
        }

        window.renderTransverseAberration = async () => {
            const progressWrap = document.getElementById('popup-transverse-progress-wrapper');
            const progressBar = document.getElementById('popup-transverse-progressbar');
            const progressText = document.getElementById('popup-transverse-progress-text');
            const setProgress = (percent, message) => {
                try {
                    if (progressWrap) progressWrap.style.display = 'block';
                    if (progressBar && Number.isFinite(percent)) progressBar.value = Math.max(0, Math.min(100, percent));
                    if (progressText) progressText.textContent = message || '';
                } catch (_) {}
            };
            const onProgress = (evt) => {
                const p = Number(evt?.percent);
                const msg = (evt && (evt.message || evt.phase)) ? String(evt.message || evt.phase) : '';
                setProgress(Number.isFinite(p) ? p : 0, msg);
            };

            const popupRay = document.getElementById('popup-transverse-ray-count-input');
            const rayCount = popupRay ? parseInt(popupRay.value, 10) : 51;
            const openerRay = getOpenerEl('transverse-ray-count-input');
            if (openerRay && Number.isFinite(rayCount)) {
                openerRay.value = String(rayCount);
            }

            const containerEl = document.getElementById('popup-transverse-aberration-container');
            if (containerEl) containerEl.innerHTML = '';

            try {
                if (!window.opener || typeof window.opener.showTransverseAberrationDiagram !== 'function') {
                    throw new Error('showTransverseAberrationDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                await window.opener.showTransverseAberrationDiagram({
                    rayCount: Number.isFinite(rayCount) ? rayCount : 51,
                    containerElement: containerEl,
                    onProgress
                });
                setProgress(100, 'Done');
            } catch (err) {
                console.error(err);
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate transverse aberration diagram. Check console.</div>';
                }
                setProgress(100, 'Failed');
            }
        };

        document.getElementById('popup-show-transverse-aberration-btn').addEventListener('click', () => {
            window.renderTransverseAberration();
        });

        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderTransverseAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Settings popup (environment settings)
        const openSettingsBtn = document.getElementById('open-settings-btn');
        if (openSettingsBtn) {
                openSettingsBtn.addEventListener('click', () => {
                        if (window.__settingsPopup && !window.__settingsPopup.closed) {
                                try { window.__settingsPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = window.open('', 'Settings', 'width=520,height=340');
                        window.__settingsPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Settings</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .content {
            padding: 12px;
            background: #fff;
            flex: 1 1 auto;
            overflow: auto;
        }
        .section-title { font-size: 13px; font-weight: 600; color: #333; margin: 0 0 8px 0; }
        .help { font-size: 12px; color: #666; margin: 0 0 10px 0; line-height: 1.35; }
        .radio-group { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 12px 0; }
        label { font-size: 13px; color: #333; }
        .footer {
            padding: 10px 12px;
            border-top: 1px solid #ddd;
            background: #f8f8f8;
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }
        button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        button:hover { background: #e9e9e9; }
        code { font-family: Menlo, Consolas, monospace; font-size: 12px; }
    </style>
</head>
<body>
    <div class="header">Settings</div>
    <div class="content">
        <div class="section-title">Glass Map: Default Manufacturers</div>
        <div class="help">
            Choose which manufacturers are enabled by default when opening Glass Map.
            <br />If nothing is selected, Glass Map will show all manufacturers.
        </div>

        <div class="checkbox-group" style="display:flex;flex-direction:column;gap:8px;margin:8px 0 14px 0;">
            <label><input type="checkbox" class="glassmap-mfr-cb" value="SCHOTT" /> SCHOTT</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="HOYA" /> HOYA</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="OHARA" /> OHARA</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="Sumita" /> Sumita</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="CDGM" /> CDGM</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="Special" /> Special</label>
        </div>

        <div class="section-title">Infinite Field: Pupil Sampling Mode</div>
        <div class="help">
            Fix the sampling mode used for infinite-field wavefront/PSF/MTF generation.
            <br />
            This sets <code>__COOPT_FORCE_INFINITE_PUPIL_MODE</code> to <code>stop</code> or <code>entrance</code>.
        </div>

        <div class="radio-group">
            <label><input type="radio" name="force-mode" value="" /> Auto (default)</label>
            <label><input type="radio" name="force-mode" value="stop" /> Force <code>stop</code></label>
            <label><input type="radio" name="force-mode" value="entrance" /> Force <code>entrance</code></label>
        </div>

        <div class="help" style="margin-top: 6px;">
            Note: Changes take effect on the next calculation.
        </div>
    </div>
    <div class="footer">
        <button id="close-btn" type="button">Close</button>
    </div>

    <script>
        const KEY = 'coopt.forceInfinitePupilMode';
        const GLASS_MAP_MFR_KEY = 'coopt.glassMap.defaultManufacturers';
        const sanitize = (v) => {
            const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
            return (s === 'stop' || s === 'entrance') ? s : '';
        };

        const sanitizeMfrList = (list) => {
            if (!Array.isArray(list)) return [];
            const allow = new Set(['SCHOTT', 'HOYA', 'OHARA', 'SUMITA', 'CDGM', 'SPECIAL']);
            const out = [];
            for (const v of list) {
                const s = String(v ?? '').trim();
                if (!s) continue;
                const upper = s.toUpperCase();
                if (!allow.has(upper)) continue;
                // Preserve canonical casing used in the checkboxes.
                if (upper === 'SUMITA') out.push('Sumita');
                else if (upper === 'SPECIAL') out.push('Special');
                else out.push(upper);
            }
            // Deduplicate
            return Array.from(new Set(out));
        };

        function getOpener() {
            try { return window.opener || null; } catch (_) { return null; }
        }

        function getCurrent() {
            const o = getOpener();
            try {
                const fromOpener = o && typeof o.__cooptGetForceInfinitePupilMode === 'function'
                    ? sanitize(o.__cooptGetForceInfinitePupilMode())
                    : sanitize(o?.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? o?.COOPT_FORCE_INFINITE_PUPIL_MODE);
                if (fromOpener) return fromOpener;
            } catch (_) {}
            try { return sanitize(localStorage.getItem(KEY)); } catch (_) { return ''; }
        }

        function applyMode(mode) {
            const m = sanitize(mode);
            const o = getOpener();
            try {
                if (o && typeof o.__cooptSetForceInfinitePupilMode === 'function') {
                    o.__cooptSetForceInfinitePupilMode(m);
                } else if (o) {
                    if (m) {
                        o.__COOPT_FORCE_INFINITE_PUPIL_MODE = m;
                        o.COOPT_FORCE_INFINITE_PUPIL_MODE = m;
                    } else {
                        try { delete o.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { o.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
                        try { delete o.COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { o.COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
                    }
                }
            } catch (_) {}

            try {
                if (m) localStorage.setItem(KEY, m);
                else localStorage.removeItem(KEY);
            } catch (_) {}
        }

        function syncUI() {
            const cur = getCurrent();
            const radios = document.querySelectorAll('input[name="force-mode"]');
            radios.forEach(r => {
                r.checked = (sanitize(r.value) === cur);
                if (cur === '' && sanitize(r.value) === '') r.checked = true;
            });

            // Glass Map manufacturers
            let stored = [];
            try {
                stored = sanitizeMfrList(JSON.parse(localStorage.getItem(GLASS_MAP_MFR_KEY) || '[]'));
            } catch (_) {
                stored = [];
            }
            const storedSet = new Set(stored.map(s => String(s).toUpperCase()));
            document.querySelectorAll('.glassmap-mfr-cb').forEach(cb => {
                const v = String(cb.value || '');
                cb.checked = storedSet.has(v.toUpperCase());
            });
        }

        function saveGlassMapMfrSelection() {
            const selected = [];
            document.querySelectorAll('.glassmap-mfr-cb').forEach(cb => {
                if (cb.checked) selected.push(cb.value);
            });
            const sanitized = sanitizeMfrList(selected);
            try {
                if (sanitized.length) localStorage.setItem(GLASS_MAP_MFR_KEY, JSON.stringify(sanitized));
                else localStorage.removeItem(GLASS_MAP_MFR_KEY);
            } catch (_) {}
        }

        document.querySelectorAll('input[name="force-mode"]').forEach(r => {
            r.addEventListener('change', () => {
                if (r.checked) applyMode(r.value);
            });
        });

        document.querySelectorAll('.glassmap-mfr-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                saveGlassMapMfrSelection();
            });
        });

        document.getElementById('close-btn').addEventListener('click', () => {
            try { window.close(); } catch (_) {}
        });

        window.addEventListener('focus', syncUI);
        syncUI();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }
    
}