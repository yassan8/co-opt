/**
 * JS_lensDraw v3 - Main Application Entry Point (Refactored)
 * 
 * This file serves as the main entry point of the application. 
 * It initializes the application using modular components and sets up the main functionality.
 */

// =============================================================================
// IMPORTS
// =============================================================================

// Core modules
import { APP_CONFIG, initializeReferences, setIsGeneratingSpotDiagram, setIsGeneratingTransverseAberration, getCamera, getControls } from './core/app-config.js';
import { initializeThreeJS, initializeLighting, renderScene, animate } from './core/scene-setup.js';

// Table data modules
import { loadTableData as loadSourceTableData, saveTableData as saveSourceTableData, tableSource } from './table-source.js';
import { loadTableData as loadObjectTableData, saveTableData as saveObjectTableData, tableObject } from './table-object.js';
import { loadTableData as loadOpticalSystemTableData, saveTableData as saveLensTableData, tableOpticalSystem, updateAllRefractiveIndices, updateOpticalPropertiesFromMaterial } from './table-optical-system.js';

// Optical system modules
import { drawOpticalSystemSurfaces, clearAllOpticalElements, findStopSurface } from './optical/system-renderer.js';
import { drawAsphericProfile, drawPlaneProfile, drawLensSurface, drawLensSurfaceWithOrigin, drawLensCrossSection, drawLensCrossSectionWithSurfaceOrigins, drawSemidiaRingWithOriginAndSurface, asphericSurfaceZ, addMirrorBackText } from './surface.js';

// Ray tracing modules
import { traceRay, calculateSurfaceOrigins } from './ray-tracing.js';
import { calculateFocalLength, calculateBackFocalLength, calculateImageDistance, calculateEntrancePupilDiameter, calculateExitPupilDiameter, calculateFullSystemParaxialTrace, calculateParaxialData, debugParaxialRayTrace, calculatePupilsByNewSpec, findStopSurfaceIndex } from './ray-paraxial.js';

// Marginal ray modules
import { calculateAdaptiveMarginalRay, calculateAllMarginalRays } from './ray-marginal.js';

// Analysis modules
import { generateSpotDiagram, drawSpotDiagram, generateSurfaceOptions } from './eva-spot-diagram.js';
import { calculateTransverseAberration, getFieldAnglesFromSource, getPrimaryWavelengthForAberration, validateAberrationData, calculateChiefRayNewton, getEstimatedEntrancePupilDiameter } from './eva-transverse-aberration.js';
import { plotTransverseAberrationDiagram, showTransverseAberrationInNewWindow } from './eva-transverse-aberration-plot.js';
import { showWavefrontDiagram } from './eva-wavefront-plot.js?v=2026-01-15b';
import { OpticalPathDifferenceCalculator, WavefrontAberrationAnalyzer, createOPDCalculator, createWavefrontAnalyzer } from './eva-wavefront.js?v=2026-01-15l';
import { PSFCalculator } from './eva-psf.js?v=2026-01-14b';
import { PSFPlotter, PSFDisplayManager } from './eva-psf-plot.js?v=2026-01-14b';
import { fitZernikeWeighted, reconstructOPD, getZernikeName } from './zernike-fitting.js';
import { calculateOPDWithZernike, displayZernikeAnalysis, exportZernikeAnalysisJSON } from './opd-zernike-analysis.js';
import { generateCrossBeam, generateFiniteSystemCrossBeam, RayColorSystem } from './gen-ray-cross-finite.js';
import { generateInfiniteSystemCrossBeam, RayColorSystem as InfiniteRayColorSystem } from './gen-ray-cross-infinite.js';
// Distortion analysis
import { calculateDistortionData } from './eva-distortion.js';
import { plotDistortionPercent, generateDistortionPlots, plotGridDistortion, generateGridDistortionPlot } from './eva-distortion-plot.js';

// Utility modules
import { getGlassDataWithSellmeier, calculateRefractiveIndex, getPrimaryWavelength } from './glass.js';
import { multiplyMatrices, createRotationMatrixX, createRotationMatrixY, createRotationMatrixZ, createRotationMatrix, calculateLocalCoordinateTransforms, applyMatrixToVector, calculateOpticalSystemOffset } from './utils/math.js';
import { getOpticalSystemRows, getObjectRows, getSourceRows, outputParaxialDataToDebug, outputSeidelCoefficientsToDebug, outputDebugSystemData, displayCoordinateTransformMatrix, debugTableStatus, initializeTablesWithDummyData, renderBlockContributionSummaryFromSeidel, renderSystemConstraintsFromSurfaceRows } from './utils/data-utils.js';
import { initAIAssistant } from './ai-assistant.js';

// Ray rendering modules
import { setRayEmissionPattern, setRayColorMode, getRayEmissionPattern, getRayColorMode, optimizeObjectPositionForStop, optimizeAngleObjectPosition, generateRayStartPointsForObject, drawRayWithSegmentColors } from './optical/ray-renderer.js';

// UI modules
import { setupRayPatternButtons, setupRayColorButtons, setupViewButtons, setupOpticalSystemChangeListeners, setupSimpleViewButtons } from './ui/event-handlers.js?v=2026-01-15l';
import { updateSurfaceNumberSelect, updateAllUIElements, initializeUIEventListeners } from './ui/ui-updates.js';
import { loadFromCompressedDataHashIfPresent, setupDOMEventHandlers } from './ui/dom-event-handlers.js?v=2026-01-14b';
import { updateWavefrontObjectSelect, initializeWavefrontObjectUI, debugResetObjectTable } from './ui/wavefront-object-select.js';

// Suggest (Design Intent) implementation (adds window.SuggestDesignIntent)
import './suggest-design-intent.js';

// Debug modules
import { debugSceneContents, debugDrawingIssues, adjustCameraView, showSceneBoundingBox } from './debug/debug-utils.js';

// Analysis modules
import { clearAllDrawing, showSpotDiagram, showTransverseAberrationDiagram, showLongitudinalAberrationDiagram, showAstigmatismDiagram, showIntegratedAberrationDiagram, outputChiefRayConvergenceData, calculateSceneBounds, fitCameraToScene } from './analysis/optical-analysis.js';

// Performance monitoring (削除されたファイルなのでコメントアウト)
// import { performanceMonitor } from './performance-monitor.js';

// WASM acceleration system
// import { ForceWASMSystem } from './force-wasm-system.js';
// グローバルスコープのForceWASMSystemを使用（スクリプトタグで読み込み済み）

// THREE.js and OrbitControls imports
import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';

// Export THREE to global scope for test scripts
window.THREE = THREE;

// Global WASM system instance
let wasmSystem = null;

// Expose WASM system getter for modules that want optional fast-paths.
// (e.g., ray-tracing.js / surface-math.js look for globalThis.getWASMSystem)
if (typeof globalThis !== 'undefined' && typeof globalThis.getWASMSystem !== 'function') {
    globalThis.getWASMSystem = () => wasmSystem;
}

// =============================================================================
// MAIN APPLICATION INITIALIZATION
// =============================================================================

/**
 * Initialize the main application
 */
async function initializeApplication() {
    try {
        // Initialize WASM system
        
        // ForceWASMSystemがグローバルに利用可能かチェック
        const ForceWASMSystemClass = globalThis.ForceWASMSystem || window?.ForceWASMSystem;
        if (!ForceWASMSystemClass) {
            throw new Error('ForceWASMSystem not available. Make sure force-wasm-system.js is loaded.');
        }
        
        wasmSystem = new ForceWASMSystemClass();
        // Ensure getter returns the latest instance even if initialization fails.
        try {
            if (typeof globalThis !== 'undefined') globalThis.getWASMSystem = () => wasmSystem;
        } catch (_) {}
        try {
            // Add a longer timeout for WASM initialization
            const initTimeout = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('WASM initialization timeout')), 10000)
            );
            
            await Promise.race([
                wasmSystem.forceInitializeWASM(),
                initTimeout
            ]);
            

        } catch (error) {
            console.warn('⚠️ WASM initialization failed, falling back to JavaScript:', error.message);
            // Set a flag to indicate WASM is not available
            wasmSystem.isWASMReady = false;
        }
        
        // Initialize THREE.js scene components
        const { scene, camera, renderer, controls } = initializeThreeJS();
        
        // Initialize lighting
        const lightingResult = initializeLighting(scene);
        const { ambientLight, directionalLight } = lightingResult || { ambientLight: null, directionalLight: null };
        
        // Initialize global references
        initializeReferences(scene, camera, renderer, controls, tableOpticalSystem, tableObject, tableSource);
        
        // Start animation loop
        animate();
        
        // Setup UI event listeners
        try {
            setupOpticalSystemChangeListeners(scene);
        } catch (error) {
            console.error('❌ Error setting up optical system change listeners:', error);
        }
        
        try {
            setupRayPatternButtons();
        } catch (error) {
            console.error('❌ Error setting up ray pattern buttons:', error);
        }
        
        try {
            setupRayColorButtons();

        } catch (error) {
            console.error('❌ Error setting up ray color buttons:', error);
        }
        
        try {
            // setupViewButtons の呼び出しを復活（簡易版のオプションで）
            console.log('🔧 Attempting to setup view buttons...');
            const viewButtonsOptions = {
                scene,
                camera,
                controls,
                renderer,
                drawOptimizedRaysFromObjects,
                getOpticalSystemRows: () => getOpticalSystemRows(tableOpticalSystem),
                getObjectRows: () => getObjectRows(tableObject),
                calculateOpticalSystemOffset: calculateOpticalSystemOffset,
                drawOpticalSystemSurfaceWrapper
            };
            console.log('📋 View buttons options:', viewButtonsOptions);
            setupViewButtons(viewButtonsOptions);
            console.log('✅ View buttons set up');
            
            // 追加: setupSimpleViewButtons を確実に呼び出す
            try {
                setupSimpleViewButtons();

            } catch (simpleError) {
                console.error('❌ Error setting up simple view buttons:', simpleError);
            }
        } catch (error) {
            console.error('❌ Error setting up view buttons:', error);
            console.error('📋 Stack trace:', error.stack);
            // フォールバック: setupSimpleViewButtons を呼び出す
            try {
                setupSimpleViewButtons();
                console.log('✅ Fallback: Simple view buttons set up');
            } catch (simpleError) {
                console.error('❌ Error setting up fallback simple view buttons:', simpleError);
            }
        }
        
        try {
            initializeUIEventListeners();

        } catch (error) {
            console.error('❌ Error initializing UI event listeners:', error);
        }
        
        try {
            setupDOMEventHandlers();

        } catch (error) {
            console.error('❌ Error setting up DOM event handlers:', error);
        }
        
        // 波面収差図Object選択UI初期化
        try {
            initializeWavefrontObjectUI();

        } catch (error) {
            console.error('❌ Error initializing wavefront object UI:', error);
        }
        
        // Update UI elements
        try {
            updateAllUIElements();
            console.log('✅ All UI elements updated');
        } catch (error) {
            console.error('❌ Error updating UI elements:', error);
        }
        
        console.log('✅ Application initialized successfully');
        
        // Debug table initialization status
        setTimeout(async () => {
            debugTableStatus();
            
            // Objectテーブル初期化後にObject選択を再更新
            try {
                if (window.updateWavefrontObjectSelect) {
                    window.updateWavefrontObjectSelect();
                }
            } catch (error) {
                console.error('❌ Error updating wavefront object selection after table init:', error);
            }
            
            // (removed) OPD Rays drawing feature
        }, 1000);
        
        // Export functions to global scope for debugging
        window.debugSceneContents = debugSceneContents;
        window.adjustCameraView = adjustCameraView;
        window.showSceneBoundingBox = showSceneBoundingBox;
        window.fitCameraToScene = fitCameraToScene;
        window.clearAllDrawing = clearAllDrawing;
        window.showSpotDiagram = showSpotDiagram;
        window.showTransverseAberrationDiagram = showTransverseAberrationDiagram;
        window.showLongitudinalAberrationDiagram = showLongitudinalAberrationDiagram;
        window.showAstigmatismDiagram = showAstigmatismDiagram;
        window.showIntegratedAberrationDiagram = showIntegratedAberrationDiagram;
        window.showWavefrontDiagram = showWavefrontDiagram;
        
        // Wavefront analysis functions (for debugging)
        window.OpticalPathDifferenceCalculator = OpticalPathDifferenceCalculator;
        window.WavefrontAberrationAnalyzer = WavefrontAberrationAnalyzer;
        window.createOPDCalculator = createOPDCalculator;
        window.createWavefrontAnalyzer = createWavefrontAnalyzer;
        
        window.outputParaxialDataToDebug = outputParaxialDataToDebug;
        window.outputSeidelCoefficientsToDebug = outputSeidelCoefficientsToDebug;
        window.outputDebugSystemData = outputDebugSystemData;
        window.displayCoordinateTransformMatrix = displayCoordinateTransformMatrix;
        window.renderBlockContributionSummaryFromSeidel = renderBlockContributionSummaryFromSeidel;
        window.renderSystemConstraintsFromSurfaceRows = renderSystemConstraintsFromSurfaceRows;
        
        // Debug functions
        window.debugTableStatus = debugTableStatus;
        window.initializeTablesWithDummyData = initializeTablesWithDummyData;
        
        // Export ray rendering functions
        window.generateRayStartPointsForObject = generateRayStartPointsForObject;
        window.drawRayWithSegmentColors = drawRayWithSegmentColors;
        window.traceRay = traceRay;
        window.getOpticalSystemRows = getOpticalSystemRows;
        window.getObjectRows = getObjectRows;
        window.getSourceRows = getSourceRows;

        // Initialize System Constraints (BFL) on startup.
        setTimeout(() => {
            try {
                const rows = getOpticalSystemRows(tableOpticalSystem);
                window.renderSystemConstraintsFromSurfaceRows?.(rows);
            } catch (_) {
                // ignore
            }
        }, 0);
        
        // Export chief ray optimization functions
        window.outputChiefRayConvergenceData = outputChiefRayConvergenceData;
        
        // Export THREE.js components to global scope for simplified buttons
        window.scene = scene;
        window.camera = camera;
        window.renderer = renderer;
        window.controls = controls;
        
        return {
            scene,
            camera,
            renderer,
            controls,
            ambientLight,
            directionalLight
        };
        
    } catch (error) {
        console.error('❌ Error initializing application:', error);
        throw error;
    }
}

// =============================================================================
// LEGACY FUNCTION WRAPPERS
// =============================================================================

/**
 * Draw optical system surfaces - wrapper function for backward compatibility
 */
function drawOpticalSystemSurfaceWrapper(options = {}) {
    console.log('🎨 Starting drawOpticalSystemSurfaceWrapper...');
    
    const defaultOptions = {
        crossSectionOnly: false,
        showSurfaceOrigins: false,
        showSemidiaRing: true,
        showMirrorBackText: false,
        crossSectionDirection: 'YZ',
        crossSectionCenterOffset: 0,
        opticalSystemData: null
    };
    
    const finalOptions = { ...defaultOptions, ...options };
    
    try {
        // Get optical system data if not provided
        if (!finalOptions.opticalSystemData) {
            finalOptions.opticalSystemData = getOpticalSystemRows();
        }
        
        if (!finalOptions.opticalSystemData || finalOptions.opticalSystemData.length === 0) {
            console.warn('⚠️ No optical system data available for drawing');
            return;
        }

        // Object Thicknessの値を確認して無限系/有限系を判定
        const objectSurface = finalOptions.opticalSystemData[0]; // Object面（最初の行）
        const objectThickness = objectSurface?.thickness;
        const isInfiniteSystem = objectThickness === 'INF' || objectThickness === 'Infinity' || objectThickness === Infinity;
        
        // 前回のシステムタイプと比較してリング描画問題を回避
        const currentSystemType = isInfiniteSystem ? 'infinite' : 'finite';
        const lastSystemType = window.lastSystemType || null;
        const systemTypeChanged = lastSystemType && lastSystemType !== currentSystemType;
        
        console.log(`🔍 [DrawOpticalSystem] Object Thickness: ${objectThickness}`);
        console.log(`🔍 [DrawOpticalSystem] 光学系タイプ: ${isInfiniteSystem ? '無限系' : '有限系'}`);
        console.log(`🔍 [DrawOpticalSystem] システムタイプ変更: ${systemTypeChanged ? `${lastSystemType} → ${currentSystemType}` : '変更なし'}`);
        
        // システムタイプが変更された場合、より完全なクリアを実行
        if (systemTypeChanged) {
            console.log('🧹 [DrawOpticalSystem] システムタイプ変更検出 - 完全なキャンバスクリア実行');
            // レンダラーとシーンを完全にクリア
            if (window.renderer) {
                window.renderer.clear();
            }
            if (window.scene) {
                // より厳密なクリア：すべての子要素を削除
                const allChildren = [...window.scene.children];
                allChildren.forEach(child => {
                    window.scene.remove(child);
                    // ジオメトリとマテリアルを解放
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
        }
        
        // 現在のシステムタイプを記録
        window.lastSystemType = currentSystemType;
        
        // Draw optical system surfaces
        drawOpticalSystemSurfaces({
            opticalSystemData: finalOptions.opticalSystemData,
            scene: window.scene || document.scene,
            crossSectionOnly: finalOptions.crossSectionOnly,
            showSemidiaRing: finalOptions.showSemidiaRing,
            showSurfaceOrigins: finalOptions.showSurfaceOrigins,
            showMirrorBackText: finalOptions.showMirrorBackText,
            crossSectionDirection: finalOptions.crossSectionDirection,
            crossSectionCenterOffset: finalOptions.crossSectionCenterOffset
        });
        
        console.log('✅ drawOpticalSystemSurfaceWrapper completed successfully');
        
    } catch (error) {
        console.error('❌ Error in drawOpticalSystemSurfaceWrapper:', error);
    }
}

/**
 * Improved draw optical system surface wrapper function
 */
function improvedDrawOpticalSystemSurfaceWrapper() {
    console.log('🔧 Running improved draw optical system surface wrapper...');
    
    try {
        // Clear existing optical elements first
        clearAllOpticalElements();
        
        // Get optical system data
        const opticalSystemRows = getOpticalSystemRows();
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            console.warn('⚠️ No optical system data available');
            return;
        }
        
        // Draw optical system surfaces
        drawOpticalSystemSurfaces({
            opticalSystemData: opticalSystemRows,
            scene: window.scene || document.scene
        });
        
        // Adjust camera view to fit the drawn surfaces
        adjustCameraView();
        
        console.log('✅ Improved draw optical system surface wrapper completed');
    } catch (error) {
        console.error('❌ Error in improvedDrawOpticalSystemSurfaceWrapper:', error);
    }
}

/**
 * Draw optimized rays from objects (正確な光線追跡版)
 */
function drawOptimizedRaysFromObjects(opticalSystemRows) {
    console.log('🌟 Drawing optimized rays from objects (正確な光線追跡版)...');
    
    try {
        const objectRows = getObjectRows();
        const scene = window.scene;
        
        if (!scene) {
            console.warn('⚠️ Scene not available for ray drawing');
            return;
        }
        
        if (!objectRows || objectRows.length === 0) {
            console.warn('⚠️ No object data available for ray drawing');
            return;
        }
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            console.warn('⚠️ No optical system data available for ray drawing');
            return;
        }
        
        // 正確な光線追跡を実行（generateRayStartPointsForObject を使用して Angle も正しく扱う）
        objectRows.forEach((obj, objIndex) => {
            console.log(`🔍 Processing object ${objIndex}:`, obj);

            // Get ray count from UI input
            const rayCountInput = document.getElementById('draw-ray-count-input');
            const rayCount = rayCountInput ? (parseInt(rayCountInput.value, 10) || 5) : 5;
            console.log(`📊 Ray count for object ${objIndex}: ${rayCount}`);

            const isAngle = (obj?.position === 'Angle' || obj?.position === 'angle');
            const rayStartPoints = generateRayStartPointsForObject(
                obj,
                opticalSystemRows,
                rayCount,
                null,
                {
                    // For Angle objects, aim the chief ray through stop center by solving origin.
                    aimThroughStop: !!isAngle,
                    useChiefRayAnalysis: true,
                    allowStopBasedOriginSolve: true,
                    // Keep this consistent with analysis/spot behavior.
                    disableCrossExtent: true,
                }
            );

            if (!Array.isArray(rayStartPoints) || rayStartPoints.length === 0) {
                console.warn(`⚠️ No rayStartPoints generated for object ${objIndex}`);
                return;
            }

            let rayIndex = 0;
            for (const rayStart of rayStartPoints) {
                if (!rayStart || !rayStart.startP || !rayStart.dir) continue;
                if (rayIndex >= rayCount) break;

                try {
                    const ray = {
                        pos: rayStart.startP,
                        dir: rayStart.dir
                    };

                    console.log(
                        `🔍 正確光線${rayIndex} for object ${objIndex}: start=(${ray.pos.x}, ${ray.pos.y}, ${ray.pos.z}), dir=(${ray.dir.x}, ${ray.dir.y}, ${ray.dir.z})`
                    );

                    // window.traceRayと同じ呼び出し方法
                    const rayPath = window.traceRay ? window.traceRay(opticalSystemRows, ray, 1.0) : null;

                    if (rayPath && rayPath.length > 1) {
                        console.log(`✅ 正確光線${rayIndex}追跡成功: ${rayPath.length}点`);
                        console.log(`   開始位置確認: (${rayPath[0].x.toFixed(3)}, ${rayPath[0].y.toFixed(3)}, ${rayPath[0].z.toFixed(3)})`);

                        // 光線の描画（正確な方法で）
                        const points = rayPath.map(point => new window.THREE.Vector3(point.x, point.y, point.z));
                        const geometry = new window.THREE.BufferGeometry().setFromPoints(points);
                        const material = new window.THREE.LineBasicMaterial({
                            color: 0x00ff00 + objIndex * 0x003300  // オブジェクト別に色分け
                        });
                        const line = new window.THREE.Line(geometry, material);
                        line.userData = {
                            type: 'optical-ray',  // 正確な光線追跡識別子
                            objectId: objIndex,
                            rayNumber: rayIndex,
                            rayType: 'accurate',  // 正確な光線追跡識別子
                            isRayLine: true,
                            accurateRayTracing: true  // 正確な光線追跡であることを示す
                        };
                        scene.add(line);

                        console.log(`🎨 正確光線${rayIndex}描画完了 (Object${objIndex})`);
                    } else {
                        console.log(`❌ 正確光線${rayIndex}追跡失敗`);
                    }
                } catch (error) {
                    console.error(`❌ 正確光線${rayIndex}でエラー:`, error.message);
                }

                rayIndex++;
            }
        });
        
        console.log('✅ Optimized rays drawn successfully (正確な光線追跡版)');
        
    } catch (error) {
        console.error('❌ Error drawing optimized rays:', error);
    }
}

/**
 * Force draw everything for testing
 */
function forceDrawEverything() {
    console.log('🎯 Force drawing everything for testing...');
    
    try {
        // Clear scene first
        const scene = window.scene;
        if (scene) {
            // Remove all optical elements
            const objectsToRemove = [];
            scene.traverse((object) => {
                if (object.userData.opticalElement) {
                    objectsToRemove.push(object);
                }
            });
            objectsToRemove.forEach(obj => scene.remove(obj));
        }
        
        // Get data
        const opticalSystemRows = getOpticalSystemRows();
        const objectRows = getObjectRows();
        
        console.log('📊 Available data:');
        console.log('  - Optical system rows:', opticalSystemRows?.length || 0);
        console.log('  - Object rows:', objectRows?.length || 0);
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            console.warn('⚠️ No optical system data, initializing with dummy data');
            initializeTablesWithDummyData();
        }
        
        // Force draw optical surfaces
        console.log('🔧 Drawing optical surfaces...');
        drawOpticalSystemSurfaces({
            opticalSystemData: getOpticalSystemRows(),
            scene: window.scene
        });
        
        // Force draw rays
        console.log('🔧 Drawing rays...');
        const finalOpticalSystemRows = getOpticalSystemRows();
        const finalObjectRows = getObjectRows();
        
        if (finalObjectRows && finalObjectRows.length > 0) {
            drawOptimizedRaysFromObjects(finalOpticalSystemRows);
        } else {
            console.log('🔧 Creating default object for ray drawing...');
            const defaultObject = {
                height: 10,
                distance: 100,
                angle: 0,
                position: 'height'
            };
            
            const rayStartPoints = generateRayStartPointsForObject(defaultObject, finalOpticalSystemRows, 11);
            if (rayStartPoints && rayStartPoints.length > 0) {
                rayStartPoints.forEach(rayStart => {
                    drawRayWithSegmentColors(rayStart, finalOpticalSystemRows, []);
                });
            }
        }
        
        // Force render
        if (window.renderer && window.scene && window.camera) {
            window.renderer.render(window.scene, window.camera);
        }
        
        console.log('✅ Force draw completed');
        
    } catch (error) {
        console.error('❌ Error in force draw:', error);
    }
}

/**
 * Fit camera to show the optical system properly
 */
function fitCameraToOpticalSystem() {
    console.log('📷 Fitting camera to optical system...');
    
    try {
        const camera = window.camera;
        const controls = window.controls;
        const scene = window.scene;
        
        if (!camera || !controls || !scene) {
            console.error('❌ Camera, controls, or scene not available');
            return;
        }
        
        // 光学系のZ範囲とY範囲を動的に計算
        const { minZ, maxZ, centerZ, totalLength, maxY } = calculateOpticalSystemZRange();
        
        // カメラ位置を光学系のサイズに基づいて設定
        const systemCenterZ = centerZ; // 動的に計算された中心位置
        const systemLength = totalLength;
        
        // Y方向とZ方向の両方を考慮してカメラ距離を計算
        const systemSize = Math.max(systemLength, maxY * 2);
        const cameraDistance = Math.max(systemSize * 1.5, 600); // 光学系のサイズの1.5倍またはmin 600
        
        console.log(`📷 Dynamic camera fitting: centerZ=${systemCenterZ.toFixed(3)}, length=${systemLength.toFixed(3)}, maxY=${maxY.toFixed(3)}, distance=${cameraDistance.toFixed(1)}`);
        
        // Position camera to view the system from a good angle
        camera.position.set(cameraDistance * 0.7, cameraDistance * 0.5, systemCenterZ);
        camera.lookAt(0, 0, systemCenterZ);
        camera.up.set(0, 1, 0);
        
        // Set controls target to center of optical system
        controls.target.set(0, 0, systemCenterZ);
        controls.update();
        
        // Force camera projection matrix update
        camera.updateProjectionMatrix();
        
        // Force render
        if (window.renderer) {
            window.renderer.render(scene, camera);
        }
        
        console.log('✅ Camera fitted to optical system with dynamic positioning');
        console.log(`📷 Camera position: (${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)})`);
        console.log(`🎯 Controls target: (${controls.target.x.toFixed(1)}, ${controls.target.y.toFixed(1)}, ${controls.target.z.toFixed(1)})`);
        
    } catch (error) {
        console.error('❌ Error fitting camera:', error);
    }
}

/**
 * Calculate optical system Z range based on surface origins
 */
function calculateOpticalSystemZRange() {
    try {
        const opticalSystemRows = getOpticalSystemRows();
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            console.warn('⚠️ No optical system data for Z range calculation');
            return { minZ: 0, maxZ: 414, centerZ: 207, totalLength: 414, maxY: 50 };
        }
        
        // Surface origins を計算
        const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
        if (!surfaceOrigins || surfaceOrigins.length === 0) {
            console.warn('⚠️ No surface origins calculated');
            return { minZ: 0, maxZ: 414, centerZ: 207, totalLength: 414, maxY: 50 };
        }
        
        // 各面のZ座標とY方向の最大サイズを取得
        const zPositions = [];
        let maxY = 0;
        
        surfaceOrigins.forEach((surfaceInfo, index) => {
            if (surfaceInfo && surfaceInfo.origin) {
                const z = surfaceInfo.origin.z;
                if (isFinite(z)) {
                    zPositions.push(z);
                    console.log(`🔍 Surface ${index}: Z = ${z.toFixed(3)}`);
                }
            }
        });
        
        // Y方向の最大サイズを計算（semidia から）
        opticalSystemRows.forEach((row, index) => {
            const semidia = parseFloat(row.semidia);
            if (isFinite(semidia) && semidia > 0) {
                maxY = Math.max(maxY, semidia);
            }
        });
        
        if (zPositions.length === 0) {
            console.warn('⚠️ No valid Z positions found');
            return { minZ: 0, maxZ: 414, centerZ: 207, totalLength: 414, maxY: maxY || 50 };
        }
        
        const minZ = Math.min(...zPositions);
        const maxZ = Math.max(...zPositions);
        const centerZ = (minZ + maxZ) / 2;
        const totalLength = maxZ - minZ;
        
        console.log(`📏 Optical system Z range: ${minZ.toFixed(3)} to ${maxZ.toFixed(3)}`);
        console.log(`📏 Center Z: ${centerZ.toFixed(3)}, Total length: ${totalLength.toFixed(3)}`);
        console.log(`📏 Max Y (semidia): ${maxY.toFixed(3)}`);
        
        return { minZ, maxZ, centerZ, totalLength, maxY };
        
    } catch (error) {
        console.error('❌ Error calculating optical system Z range:', error);
        return { minZ: 0, maxZ: 414, centerZ: 207, totalLength: 414, maxY: 50 };
    }
}

/**
 * Image面のSemi Diaを主光線の最大高さで更新
 * optimizeSemiDiaフィールドが"U"の場合のみ更新
 */
function updateImageSemiDiaFromChiefRays(rays, opticalSystemRows) {
    try {
        if (!rays || !Array.isArray(rays) || rays.length === 0) {
            console.log('📐 updateImageSemiDiaFromChiefRays: No rays available');
            return;
        }
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            console.log('📐 updateImageSemiDiaFromChiefRays: No optical system data');
            return;
        }
        
        // Image面（最終面）を見つける
        const imageSurfaceIndex = opticalSystemRows.length - 1;
        const imageSurface = opticalSystemRows[imageSurfaceIndex];
        
        // optimizeSemiDiaが"U"またはsemidiaが"Auto"かチェック
        const isAutoUpdate = imageSurface.optimizeSemiDia === 'U' || imageSurface.semidia === 'Auto';
        
        if (!isAutoUpdate) {
            console.log(`📐 Image面のoptimizeSemiDia="${imageSurface.optimizeSemiDia}", semidia="${imageSurface.semidia}" (Auto/U以外なのでスキップ)`);
            return;
        }
        
        console.log('📐 Image面のSemi Diaを主光線の最大高さで自動更新します');
        
        // 主光線のみを抽出
        const chiefRays = rays.filter(ray => {
            // beamTypeまたはtypeに"chief"が含まれるか確認
            const type = (ray.beamType || ray.type || '').toLowerCase();
            return type.includes('chief');
        });
        
        console.log(`📐 主光線数: ${chiefRays.length}`);
        
        if (chiefRays.length === 0) {
            console.warn('⚠️ 主光線が見つかりません');
            return;
        }
        
        // 各主光線のImage面でのY座標の絶対値を取得
        let maxHeight = 0;
        chiefRays.forEach((ray, index) => {
            if (!ray.rayPath || !Array.isArray(ray.rayPath)) {
                return;
            }
            
            // Image面（最終面）のポイントを取得
            if (imageSurfaceIndex < ray.rayPath.length) {
                const imagePoint = ray.rayPath[imageSurfaceIndex];
                if (imagePoint && isFinite(imagePoint.y)) {
                    const height = Math.abs(imagePoint.y);
                    console.log(`   主光線${index}: Image面でのY高さ = ${height.toFixed(6)}`);
                    maxHeight = Math.max(maxHeight, height);
                }
            }
        });
        
        if (maxHeight > 0) {
            console.log(`📐 主光線の最大高さ: ${maxHeight.toFixed(6)}`);
            
            // Image面のSemi Diaを更新
            imageSurface.semidia = maxHeight;
            
            // テーブルを更新
            if (window.tableOpticalSystem) {
                window.tableOpticalSystem.updateData([imageSurface]);
                console.log(`✅ Image面のSemi Diaを${maxHeight.toFixed(6)}に更新しました`);
            }
        } else {
            console.warn('⚠️ 有効な主光線の高さが見つかりません');
        }
        
    } catch (error) {
        console.error('❌ updateImageSemiDiaFromChiefRays error:', error);
    }
}

/**
 * Update camera view bounds based on optical system size (for resize handling)
 * カメラの位置や方向は変更せず、視野範囲のみを更新
 */
function updateCameraViewBounds() {
    console.log('📷 updateCameraViewBounds called');
    
    const camera = window.camera;
    if (!camera) {
        console.log('📷 No camera available');
        return;
    }
    
    if (!camera.isOrthographicCamera) {
        console.log('📷 Camera is not OrthographicCamera');
        return;
    }
    
    try {
        const sceneBounds = __coopt_calculateOpticalElementsBounds(window.scene);

        // 光学系のZ範囲とY範囲を動的に計算
        const rangeData = calculateOpticalSystemZRange();
        if (!rangeData) {
            console.log('📷 No optical system range data available');
            return;
        }
        
        let { minZ, maxZ, centerZ, totalLength, maxY } = rangeData;
        if (sceneBounds) {
            minZ = Math.min(minZ, sceneBounds.min.z);
            maxZ = Math.max(maxZ, sceneBounds.max.z);
            centerZ = (minZ + maxZ) / 2;
            totalLength = maxZ - minZ;
            const ySpan = sceneBounds.max.y - sceneBounds.min.y;
            if (Number.isFinite(ySpan) && ySpan > 0) {
                maxY = Math.max(maxY || 0, ySpan / 2);
            }
        }
        console.log(`📷 Optical system: maxY=${maxY}, totalLength=${totalLength}`);
        
        // 光線の開始位置も考慮
        const rayStartMargin = 25;
        const effectiveMinZ = Math.min(minZ, -rayStartMargin);
        const effectiveMaxZ = maxZ;
        const effectiveTotalLength = effectiveMaxZ - effectiveMinZ;
        
        // レンダラーの実際のサイズを取得してアスペクト比を計算
        let aspect = 1.5;
        if (window.renderer) {
            const size = window.renderer.getSize(new THREE.Vector2());
            aspect = size.x / size.y;
            console.log(`📷 Renderer aspect: ${aspect.toFixed(3)}`);
        }
        
        // 描画枠全体に光学系が収まるように視野サイズを計算
        const marginFactor = 1.1;
        const safeMaxY = (Number.isFinite(maxY) && maxY > 0) ? maxY : 50;
        const visibleHeight = safeMaxY * 2 * marginFactor;
        const visibleWidth = effectiveTotalLength * marginFactor;
        
        console.log(`📷 Visible size: ${visibleWidth.toFixed(1)} x ${visibleHeight.toFixed(1)}`);
        
        // アスペクト比に基づいて視野範囲を計算
        let viewHeight, viewWidth;
        const contentAspect = visibleWidth / Math.max(1e-9, visibleHeight);
        
        if (contentAspect > aspect) {
            viewWidth = visibleWidth / 2;
            viewHeight = viewWidth / aspect;
        } else {
            viewHeight = visibleHeight / 2;
            viewWidth = viewHeight * aspect;
        }
        
        // カメラの視野範囲を更新（位置や方向は変更しない）
        camera.left = -viewWidth;
        camera.right = viewWidth;
        camera.top = viewHeight;
        camera.bottom = -viewHeight;
        camera.updateProjectionMatrix();
        
        console.log(`📷 View bounds updated: width=${(viewWidth*2).toFixed(1)}, height=${(viewHeight*2).toFixed(1)}`);
        console.log(`📷 Camera bounds: [${camera.left.toFixed(1)}, ${camera.right.toFixed(1)}, ${camera.top.toFixed(1)}, ${camera.bottom.toFixed(1)}]`);
    } catch (error) {
        console.error('❌ Error updating camera view bounds:', error);
    }
}

// グローバルに公開
window.updateCameraViewBounds = updateCameraViewBounds;

function __coopt_calculateOpticalElementsBounds(scene) {
    try {
        if (!scene) return null;
        const box = new THREE.Box3();
        let has = false;

        scene.traverse((child) => {
            if (!child || child.visible === false) return;
            if (!(child.isMesh || child.isLine || child.isGroup)) return;

            // Skip helpers/lights
            if (child.type === 'GridHelper' || child.type === 'AxesHelper' || child.type === 'AmbientLight' || child.type === 'DirectionalLight') return;

            const name = String(child.name || '');
            const ud = child.userData || {};
            const isOptical = !!(
                ud.isOpticalElement ||
                ud.isLensSurface ||
                ud.isRayLine ||
                ud.type === 'ray' ||
                ud.type === 'surfaceProfile' ||
                ud.type === 'semidiaRing' ||
                ud.type === 'ring' ||
                ud.type === 'crossSection' ||
                ud.surfaceIndex !== undefined ||
                /surface|lens|cross-section|semidia|mirror|profile|ring|connection/i.test(name)
            );
            if (!isOptical) return;

            const childBox = new THREE.Box3().setFromObject(child);
            if (!childBox.isEmpty()) {
                box.union(childBox);
                has = true;
            }
        });

        return has ? box : null;
    } catch (_) {
        return null;
    }
}

function expandOrthoBoundsToAspect(camera, aspect) {
    if (!camera?.isOrthographicCamera) return;
    if (!Number.isFinite(aspect) || aspect <= 0) return;

    const width = camera.right - camera.left;
    const height = camera.top - camera.bottom;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;

    const currentAspect = width / height;
    if (!Number.isFinite(currentAspect) || currentAspect <= 0) return;
    if (Math.abs(currentAspect - aspect) < 1e-6) return;

    const centerX = (camera.left + camera.right) / 2;
    const centerY = (camera.top + camera.bottom) / 2;

    if (currentAspect < aspect) {
        // Canvas is wider than current bounds -> expand width
        const newWidth = height * aspect;
        camera.left = centerX - newWidth / 2;
        camera.right = centerX + newWidth / 2;
    } else {
        // Canvas is taller than current bounds -> expand height
        const newHeight = width / aspect;
        camera.top = centerY + newHeight / 2;
        camera.bottom = centerY - newHeight / 2;
    }
}

/**
 * Set camera for Y-Z cross section front view (for Draw Cross)
 */
function setCameraForYZCrossSection(options = {}) {
    console.log('📷 Setting camera for Y-Z cross section front view...');
    
    try {
        const camera = options.camera || window.camera;
        const controls = options.controls || window.controls;
        const scene = options.scene || window.scene;
        const renderer = options.renderer || window.renderer;
        
        if (!camera || !controls || !scene) {
            console.error('❌ Camera, controls, or scene not available');
            return;
        }
        
        // 光学系のZ範囲とY範囲を動的に計算
        const { minZ, maxZ, centerZ, totalLength, maxY } = calculateOpticalSystemZRange();
        
        // Y-Z断面を正面から見るためにX軸負方向からカメラを配置
        // Z軸は光軸（画面横方向）、Y軸は上下方向、X軸は視線方向
        
        // 光線の開始位置も考慮（無限系の場合、Z=-25程度から開始することがある）
        // Popupでは「光学系が画面に収まる」優先のため、固定マージンは無効化できる
        const includeRayStartMargin = options.includeRayStartMargin !== false;
        const rayStartMargin = includeRayStartMargin ? 25 : 0;
        const effectiveMinZ = Math.min(minZ, -rayStartMargin);
        const effectiveMaxZ = maxZ;
        const effectiveTotalLength = effectiveMaxZ - effectiveMinZ;
        const effectiveCenterZ = (effectiveMinZ + effectiveMaxZ) / 2;

        // Prefer actual drawn geometry bounds when available (more robust than semidia-based estimates).
        const sceneBounds = __coopt_calculateOpticalElementsBounds(scene);
        const fitMinZ = sceneBounds ? Math.min(effectiveMinZ, sceneBounds.min.z) : effectiveMinZ;
        const fitMaxZ = sceneBounds ? Math.max(effectiveMaxZ, sceneBounds.max.z) : effectiveMaxZ;
        const fitTotalLength = fitMaxZ - fitMinZ;
        const fitCenterZ = (fitMinZ + fitMaxZ) / 2;
        const fitCenterY = sceneBounds ? ((sceneBounds.min.y + sceneBounds.max.y) / 2) : 0;
        const fitMaxY = (() => {
            let y = maxY;
            if (sceneBounds) {
                const ySpan = sceneBounds.max.y - sceneBounds.min.y;
                if (Number.isFinite(ySpan) && ySpan > 0) y = Math.max(y || 0, ySpan / 2);
            }
            return y;
        })();

        // Draw Crossの表示範囲を保存/再利用（XZ/YZ切り替えでスケールが変わらないように）
        const savedBounds = camera?.userData?.__drawCrossOrthoBounds;
        const preserveDrawCrossBounds = options.preserveDrawCrossBounds === true && savedBounds;
        const systemCenterZ = Number.isFinite(options.centerZOverride)
            ? options.centerZOverride
            : (preserveDrawCrossBounds && Number.isFinite(savedBounds.centerZ) ? savedBounds.centerZ : fitCenterZ);

        const targetOverride = options.targetOverride &&
            Number.isFinite(options.targetOverride.x) &&
            Number.isFinite(options.targetOverride.y) &&
            Number.isFinite(options.targetOverride.z)
            ? options.targetOverride
            : null;
        
        // レンダラーの実際のサイズを取得してアスペクト比を計算
        let aspect = 1.5; // デフォルト値
        if (renderer) {
            const size = renderer.getSize(new THREE.Vector2());
            aspect = size.x / size.y;
            console.log(`📷 Renderer size: ${size.x.toFixed(0)} x ${size.y.toFixed(0)}, aspect: ${aspect.toFixed(3)}`);
        }
        
        // 描画枠全体に光学系が収まるように視野サイズを計算
        const marginFactor = 1.1; // マージンを10%
        const safeMaxY = (Number.isFinite(fitMaxY) && fitMaxY > 0) ? fitMaxY : 50;
        const visibleHeight = safeMaxY * 2 * marginFactor; // Y方向の高さ（両側+マージン）
        const visibleWidth = fitTotalLength * marginFactor; // Z方向の幅（光線開始位置/描画物を含む+マージン）
        
        // OrthographicCameraの場合、視野範囲を直接設定
        if (camera.isOrthographicCamera) {
            const preserveRequested = options.preserveCurrentOrthoBounds === true;
            // If semidia is missing (maxY<=0), preserving the current bounds tends to keep
            // the popup's default view (often centered near the image plane). Force a refit.
            const hasReliableExtent = (Number.isFinite(maxY) && maxY > 0);
            const preserveCurrentOrthoBounds = preserveRequested && hasReliableExtent;
            if (preserveCurrentOrthoBounds) {
                // User already adjusted the view (pan/zoom/rotate).
                // Keep the current bounds so pressing Render does not change the scale.
                expandOrthoBoundsToAspect(camera, aspect);
                console.log('📷 Preserving current orthographic bounds (YZ)');
            } else if (preserveDrawCrossBounds) {
                camera.left = savedBounds.left;
                camera.right = savedBounds.right;
                camera.top = savedBounds.top;
                camera.bottom = savedBounds.bottom;
                expandOrthoBoundsToAspect(camera, aspect);
                console.log('📷 Using preserved Draw Cross orthographic bounds (YZ)');
            } else {
                // アスペクト比に基づいて、どちらの方向を基準にするか決定
                let viewHeight, viewWidth;

                // 光学系のアスペクト比
                const contentAspect = visibleWidth / Math.max(1e-9, visibleHeight);

                if (contentAspect > aspect) {
                    // 光学系が横長 → 横幅を基準に
                    viewWidth = visibleWidth / 2;
                    viewHeight = viewWidth / aspect;
                } else {
                    // 光学系が縦長 → 高さを基準に
                    viewHeight = visibleHeight / 2;
                    viewWidth = viewHeight * aspect;
                }

                // カメラの視野範囲を更新
                camera.left = -viewWidth;
                camera.right = viewWidth;
                camera.top = viewHeight;
                camera.bottom = -viewHeight;

                console.log(`📷 Content aspect: ${contentAspect.toFixed(3)}, Screen aspect: ${aspect.toFixed(3)}`);
                console.log(`📷 OrthographicCamera view: width=${(viewWidth*2).toFixed(1)}, height=${(viewHeight*2).toFixed(1)}`);
                console.log(`📷 Camera bounds: left=${camera.left.toFixed(1)}, right=${camera.right.toFixed(1)}, top=${camera.top.toFixed(1)}, bottom=${camera.bottom.toFixed(1)}`);
            }
        }
        
        console.log(`📷 Dynamic camera setup: centerZ=${systemCenterZ.toFixed(3)}`);
        console.log(`📷 Optical system range: Z=${minZ.toFixed(3)} to ${maxZ.toFixed(3)} (length: ${totalLength.toFixed(3)}), maxY=${maxY.toFixed(3)}`);
        console.log(`📷 Effective range (with rays): Z=${effectiveMinZ.toFixed(3)} to ${effectiveMaxZ.toFixed(3)} (length: ${effectiveTotalLength.toFixed(3)})`);
        if (sceneBounds) {
            console.log(`📷 Scene-bounds fit: Z=${fitMinZ.toFixed(3)} to ${fitMaxZ.toFixed(3)} (length: ${fitTotalLength.toFixed(3)}), maxY≈${safeMaxY.toFixed(3)}`);
        }
        console.log(`📷 Visible dimensions: height=${visibleHeight.toFixed(1)} (Y-vertical), width=${visibleWidth.toFixed(1)} (Z-horizontal)`);
        
        // カメラをX軸負方向に配置（Y-Z断面の正面）- 距離は任意（正投影なので影響なし）
        const cameraDistance = 300; // 正投影カメラでは距離は見た目に影響しない
        // When the popup user has panned/zoomed, it sends us an absolute OrbitControls target.
        // If we reuse that absolute target across optical edits (e.g., CoordBreak -> 0), the view can
        // appear "stuck" even though geometry returned. Preserve pan *relative to the content center*.
        const lastFitCenter = camera?.userData?.__drawCrossLastFitCenter;
        const hasLastFitCenter = !!(lastFitCenter && Number.isFinite(lastFitCenter.y) && Number.isFinite(lastFitCenter.z));

        const baseTargetX = 0;
        const baseTargetY = fitCenterY;
        const baseTargetZ = systemCenterZ;

        const panDeltaY = (targetOverride && hasLastFitCenter) ? (targetOverride.y - lastFitCenter.y) : 0;
        const panDeltaZ = (targetOverride && hasLastFitCenter) ? (targetOverride.z - lastFitCenter.z) : 0;

        const targetX = baseTargetX;
        const targetY = targetOverride ? (baseTargetY + panDeltaY) : baseTargetY;
        const targetZ = targetOverride ? (baseTargetZ + panDeltaZ) : baseTargetZ;

        camera.position.set(targetX - cameraDistance, targetY, targetZ);
        camera.lookAt(targetX, targetY, targetZ);
        camera.up.set(0, 1, 0); // Y軸が上方向
        
        // コントロールのターゲットを光学系の中心に設定
        controls.target.set(targetX, targetY, targetZ);
        controls.update();
        
        // カメラ投影行列を更新
        camera.updateProjectionMatrix();

        // Remember the latest content center used for relative-pan preservation.
        camera.userData.__drawCrossLastFitCenter = { x: 0, y: baseTargetY, z: baseTargetZ };

        if (options.storeDrawCrossBounds === true && camera.isOrthographicCamera) {
            camera.userData.__drawCrossOrthoBounds = {
                left: camera.left,
                right: camera.right,
                top: camera.top,
                bottom: camera.bottom,
                centerZ: targetZ
            };
            console.log('💾 Saved Draw Cross orthographic bounds to camera.userData');
        }
        
        // 強制レンダリング
        if (renderer && scene) {
            renderer.render(scene, camera);
        }
        
        console.log('✅ Camera set for Y-Z cross section view with dynamic positioning');
        console.log(`📷 Camera position: (${camera.position.x}, ${camera.position.y}, ${camera.position.z})`);
        console.log(`🎯 Controls target: (${controls.target.x}, ${controls.target.y}, ${controls.target.z})`);
        
    } catch (error) {
        console.error('❌ Error setting camera for Y-Z cross section:', error);
    }
}

function setCameraForXZCrossSection(options = {}) {
    console.log('📷 Setting camera for X-Z cross section view...');

    try {
        const camera = options.camera || window.camera;
        const controls = options.controls || window.controls;
        const scene = options.scene || window.scene;
        const renderer = options.renderer || window.renderer;

        if (!camera || !controls || !scene) {
            console.error('❌ Camera, controls, or scene not available');
            return;
        }

        const rangeData = calculateOpticalSystemZRange();
        if (!rangeData) {
            console.warn('⚠️ Unable to calculate optical system range for X-Z view');
            return;
        }

        const { minZ, maxZ, maxY } = rangeData;
        const includeRayStartMargin = options.includeRayStartMargin !== false;
        const rayStartMargin = includeRayStartMargin ? 25 : 0;
        const effectiveMinZ = Math.min(minZ, -rayStartMargin);
        const effectiveMaxZ = maxZ;
        const effectiveTotalLength = effectiveMaxZ - effectiveMinZ;
        const effectiveCenterZ = (effectiveMinZ + effectiveMaxZ) / 2;

        const sceneBounds = __coopt_calculateOpticalElementsBounds(scene);
        const fitMinZ = sceneBounds ? Math.min(effectiveMinZ, sceneBounds.min.z) : effectiveMinZ;
        const fitMaxZ = sceneBounds ? Math.max(effectiveMaxZ, sceneBounds.max.z) : effectiveMaxZ;
        const fitTotalLength = fitMaxZ - fitMinZ;
        const fitCenterZ = (fitMinZ + fitMaxZ) / 2;
        const fitCenterX = sceneBounds ? ((sceneBounds.min.x + sceneBounds.max.x) / 2) : 0;
        const fitMaxX = (() => {
            let x = maxY;
            if (sceneBounds) {
                const xSpan = sceneBounds.max.x - sceneBounds.min.x;
                if (Number.isFinite(xSpan) && xSpan > 0) x = Math.max(x || 0, xSpan / 2);
            }
            return x;
        })();

        const savedBounds = camera?.userData?.__drawCrossOrthoBounds;
        const preserveDrawCrossBounds = options.preserveDrawCrossBounds === true && savedBounds;
        const targetCenterZ = Number.isFinite(options.centerZOverride)
            ? options.centerZOverride
            : (preserveDrawCrossBounds && Number.isFinite(savedBounds.centerZ) ? savedBounds.centerZ : fitCenterZ);

        const targetOverride = options.targetOverride &&
            Number.isFinite(options.targetOverride.x) &&
            Number.isFinite(options.targetOverride.y) &&
            Number.isFinite(options.targetOverride.z)
            ? options.targetOverride
            : null;

        let aspect = 1.5;
        if (renderer) {
            const size = renderer.getSize(new THREE.Vector2());
            aspect = size.x / size.y;
            console.log(`📷 [XZ] Renderer aspect: ${aspect.toFixed(3)}`);
        }

        const marginFactor = 1.1;
        const safeMaxX = (Number.isFinite(fitMaxX) && fitMaxX > 0) ? fitMaxX : 50;
        const visibleHeight = safeMaxX * 2 * marginFactor;
        const visibleWidth = fitTotalLength * marginFactor;

        if (camera.isOrthographicCamera) {
            const preserveRequested = options.preserveCurrentOrthoBounds === true;
            const hasReliableExtent = (Number.isFinite(maxY) && maxY > 0);
            const preserveCurrentOrthoBounds = preserveRequested && hasReliableExtent;
            if (preserveCurrentOrthoBounds) {
                expandOrthoBoundsToAspect(camera, aspect);
                console.log('📷 [XZ] Preserving current orthographic bounds');
            } else if (preserveDrawCrossBounds) {
                camera.left = savedBounds.left;
                camera.right = savedBounds.right;
                camera.top = savedBounds.top;
                camera.bottom = savedBounds.bottom;
                expandOrthoBoundsToAspect(camera, aspect);
                console.log('📷 [XZ] Using preserved Draw Cross orthographic bounds');
            } else {
                let viewHeight, viewWidth;
                const contentAspect = visibleWidth / Math.max(1e-9, visibleHeight);

                if (contentAspect > aspect) {
                    viewWidth = visibleWidth / 2;
                    viewHeight = viewWidth / aspect;
                } else {
                    viewHeight = visibleHeight / 2;
                    viewWidth = viewHeight * aspect;
                }

                camera.left = -viewWidth;
                camera.right = viewWidth;
                camera.top = viewHeight;
                camera.bottom = -viewHeight;
            }
        }

        const cameraDistance = options.cameraDistance || 300;
        const lastFitCenter = camera?.userData?.__drawCrossLastFitCenter;
        const hasLastFitCenter = !!(lastFitCenter && Number.isFinite(lastFitCenter.x) && Number.isFinite(lastFitCenter.z));

        const baseTargetX = fitCenterX;
        const baseTargetY = 0;
        const baseTargetZ = targetCenterZ;

        const panDeltaX = (targetOverride && hasLastFitCenter) ? (targetOverride.x - lastFitCenter.x) : 0;
        const panDeltaZ = (targetOverride && hasLastFitCenter) ? (targetOverride.z - lastFitCenter.z) : 0;

        const targetX = targetOverride ? (baseTargetX + panDeltaX) : baseTargetX;
        const targetY = baseTargetY;
        const targetZ = targetOverride ? (baseTargetZ + panDeltaZ) : baseTargetZ;

        camera.position.set(targetX, targetY + cameraDistance, targetZ);
        camera.lookAt(targetX, targetY, targetZ);
        camera.up.set(1, 0, 0);
        camera.updateProjectionMatrix();

        controls.target.set(targetX, targetY, targetZ);
        controls.update();

        camera.userData.__drawCrossLastFitCenter = { x: baseTargetX, y: 0, z: baseTargetZ };

        if (renderer && scene) {
            renderer.render(scene, camera);
        }

        console.log('✅ Camera set for X-Z cross section view');
    } catch (error) {
        console.error('❌ Error setting camera for X-Z cross section:', error);
    }
}

/**
 * Debug 3D canvas and renderer status
 */
function debug3DCanvas() {
    console.log('🖼️ Debugging 3D canvas status...');
    
    const canvasContainer = document.getElementById('threejs-canvas-container');
    const canvas = window.renderer?.domElement;
    
    console.log('Canvas container:', !!canvasContainer);
    if (canvasContainer) {
        console.log('Container dimensions:', canvasContainer.offsetWidth, 'x', canvasContainer.offsetHeight);
        console.log('Container style:', canvasContainer.style.cssText);
    }
    
    console.log('Canvas element:', !!canvas);
    if (canvas) {
        console.log('Canvas dimensions:', canvas.width, 'x', canvas.height);
        console.log('Canvas style:', canvas.style.cssText);
        console.log('Canvas parent:', canvas.parentElement?.id);
    }
    
    console.log('Renderer:', !!window.renderer);
    if (window.renderer) {
        const size = window.renderer.getSize(new THREE.Vector2());
        console.log('Renderer size:', size.x, 'x', size.y);
    }
    
    console.log('Scene children count:', window.scene?.children?.length || 0);
    console.log('Camera position:', window.camera?.position);
    console.log('Controls target:', window.controls?.target);
    
    return {
        canvasContainer: !!canvasContainer,
        canvas: !!canvas,
        renderer: !!window.renderer,
        scene: !!window.scene,
        camera: !!window.camera,
        controls: !!window.controls
    };
}

// =============================================================================
// GLOBAL EXPORTS FOR BACKWARD COMPATIBILITY
// =============================================================================

// Export legacy functions to global scope
window.drawOpticalSystemSurfaceWrapper = drawOpticalSystemSurfaceWrapper;
window.improvedDrawOpticalSystemSurfaceWrapper = improvedDrawOpticalSystemSurfaceWrapper;
window.drawOptimizedRaysFromObjects = drawOptimizedRaysFromObjects;
window.generateRayStartPointsForObject = generateRayStartPointsForObject;
window.drawRayWithSegmentColors = drawRayWithSegmentColors;
window.forceDrawEverything = forceDrawEverything;
window.fitCameraToOpticalSystem = fitCameraToOpticalSystem;
window.setCameraForYZCrossSection = setCameraForYZCrossSection;
window.setCameraForXZCrossSection = setCameraForXZCrossSection;
window.calculateOpticalSystemZRange = calculateOpticalSystemZRange;
window.debug3DCanvas = debug3DCanvas;

// Export imported functions to global scope
window.traceRay = traceRay;
window.getOpticalSystemRows = getOpticalSystemRows;
window.getObjectRows = getObjectRows;
window.getSourceRows = getSourceRows;

// Export main functions
window.initializeApplication = initializeApplication;
window.updateSurfaceNumberSelect = updateSurfaceNumberSelect;

// =============================================================================
// APPLICATION STARTUP
// =============================================================================

// Initialize application on DOM content loaded
if (typeof document !== 'undefined' && document?.addEventListener) document.addEventListener('DOMContentLoaded', async function() {
    try {
        // Initialize the main application

        initAIAssistant();
        const appComponents = await initializeApplication();
        
        if (!appComponents) {
            throw new Error('Failed to initialize application components');
        }
        
        console.log('✅ Application components initialized:', appComponents);
        // Store references globally for backward compatibility
        if (appComponents) {
            window.scene = appComponents.scene;
            window.camera = appComponents.camera;
            window.renderer = appComponents.renderer;
            window.controls = appComponents.controls;
            window.ambientLight = appComponents.ambientLight;
            window.directionalLight = appComponents.directionalLight;
            console.log('✅ App components stored globally');
        } else {
            console.error('❌ App components not initialized');
        }
        
        // Store table references globally
        window.tableOpticalSystem = tableOpticalSystem;
        window.tableObject = tableObject;
        window.tableSource = tableSource;
        
        console.log('✅ Application initialization completed');

        // URL share load (hash: #compressed_data=...)
        // Run on next tick so other DOMContentLoaded listeners can finish too.
        setTimeout(() => {
            try {
                Promise.resolve(loadFromCompressedDataHashIfPresent()).catch((e) => {
                    console.warn('⚠️ [URL Load] Failed:', e);
                });
            } catch (e) {
                console.warn('⚠️ [URL Load] Failed:', e);
            }
        }, 0);
        
        // (removed) OPD Rays drawing feature
        
        // 🔍 Objectデータデバッグボタンの設定
        const debugObjectDataBtn = document.getElementById('debug-object-data');
        if (debugObjectDataBtn) {
            debugObjectDataBtn.addEventListener('click', () => {
                console.log('\n🔍 [ObjectDebug] Objectデータデバッグ開始');
                
                const objectRows = window.getObjectRows ? window.getObjectRows() : [];
                const objectSelect = document.getElementById('wavefront-object-select');
                const selectedIndex = objectSelect ? parseInt(objectSelect.value) : 0;
                
                console.log('🔍 [ObjectDebug] 基本情報:');
                console.log(`  Object総数: ${objectRows.length}`);
                console.log(`  選択インデックス: ${selectedIndex}`);
                console.log(`  ドロップダウン存在: ${!!objectSelect}`);
                
                if (objectRows.length === 0) {
                    console.warn('⚠️ [ObjectDebug] Objectデータが見つかりません');
                    alert('Objectデータが読み込まれていません。JSONファイルをロードしてください。');
                    return;
                }
                
                console.log('🔍 [ObjectDebug] 全Objectデータ:');
                objectRows.forEach((obj, index) => {
                    console.log(`  Object ${index + 1}:`, obj);
                    console.log(`    Type: ${obj.Type || obj.type || '未設定'}`);
                    console.log(`    X: ${obj.X || obj.x || '未設定'}`);
                    console.log(`    Y: ${obj.Y || obj.y || '未設定'}`);
                    
                    // 角度かどうかの判定
                    const isAngleType = (obj.Type === 'Angle' || obj.type === 'Angle');
                    console.log(`    角度タイプ: ${isAngleType}`);
                    
                    if (isAngleType) {
                        const angleX = parseFloat(obj.X || obj.x || 0);
                        const angleY = parseFloat(obj.Y || obj.y || 0);
                        console.log(`    画角: X=${angleX}°, Y=${angleY}°`);
                    }
                });
                
                // 選択されたObjectの詳細
                const selectedObject = objectRows[selectedIndex] || objectRows[0];
                console.log('🎯 [ObjectDebug] 選択されたObject詳細:');
                console.log('  データ:', selectedObject);
                
                // フィールド設定として変換
                const fieldSetting = convertObjectToFieldSetting(selectedObject, selectedIndex);
                console.log('  変換後フィールド設定:', fieldSetting);
                
                // コンソールクリアボタンの説明
                console.log('💡 [ObjectDebug] ヒント: コンソールをクリアするには、ブラウザのF12で開発者ツールを開き、コンソールタブで右クリック→"Clear console"を選択してください。');
            });
        }
        
        // 🔍 光線角度デバッグボタンの設定
        const debugRayAnglesBtn = document.getElementById('debug-ray-angles');
        if (debugRayAnglesBtn) {
            debugRayAnglesBtn.addEventListener('click', () => {
                console.log('\n🔍 [RayAngleDebug] 光線角度デバッグ開始');
                
                if (window.debugOPDRayAngles) {
                    window.debugOPDRayAngles();
                } else {
                    console.warn('⚠️ [RayAngleDebug] debugOPDRayAngles関数が見つかりません');
                    console.log('💡 [RayAngleDebug] debug-opd-ray-angles.jsが正しく読み込まれているか確認してください');
                }
            });
        }
        
        // Draw Crossボタンのイベントリスナー
        const drawCrossBtn = document.getElementById('draw-cross-btn');
        if (drawCrossBtn) {
            drawCrossBtn.addEventListener('click', async () => {
                try {
                    console.log('🎯 [DrawCross] クロスビーム描画開始');
                    
                    // ボタンを無効化
                    drawCrossBtn.disabled = true;
                    drawCrossBtn.textContent = 'Generating...';
                    
                    // 光学系データの取得
                    const opticalSystemRows = getOpticalSystemRows();
                    if (!opticalSystemRows || opticalSystemRows.length === 0) {
                        alert('光学系データが設定されていません。');
                        return;
                    }
                    
                    // Object Thicknessの値を確認して無限系/有限系を判定
                    const objectSurface = opticalSystemRows[0]; // Object面（最初の行）
                    const objectThickness = objectSurface?.thickness;
                    const isInfiniteSystem = objectThickness === 'INF' || objectThickness === 'Infinity' || objectThickness === Infinity;
                    
                    // 前回のシステムタイプと比較してリング描画問題を回避
                    const currentSystemType = isInfiniteSystem ? 'infinite' : 'finite';
                    const lastSystemType = window.lastSystemType || null;
                    const systemTypeChanged = lastSystemType && lastSystemType !== currentSystemType;
                    
                    console.log(`🔍 [DrawCross] Object Thickness: ${objectThickness}`);
                    console.log(`🔍 [DrawCross] 光学系タイプ: ${isInfiniteSystem ? '無限系' : '有限系'}`);
                    console.log(`🔍 [DrawCross] システムタイプ変更: ${systemTypeChanged ? `${lastSystemType} → ${currentSystemType}` : '変更なし'}`);
                    
                    // システムタイプが変更された場合、より完全なクリアを実行
                    if (systemTypeChanged) {
                        console.log('🧹 [DrawCross] システムタイプ変更検出 - 完全なキャンバスクリア実行');
                        // レンダラーとシーンを完全にクリア
                        if (window.renderer) {
                            window.renderer.clear();
                        }
                        if (window.scene) {
                            // より厳密なクリア：すべての子要素を削除
                            const allChildren = [...window.scene.children];
                            allChildren.forEach(child => {
                                window.scene.remove(child);
                                // ジオメトリとマテリアルを解放
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
                    }
                    
                    // 現在のシステムタイプを記録
                    window.lastSystemType = currentSystemType;
                    
                    if (isInfiniteSystem) {
                        console.log('🌟 [DrawCross] 無限系光学系 - gen-ray-cross-infinite.js を使用');
                    } else {
                        console.log('🎯 [DrawCross] 有限系光学系 - gen-ray-cross-finite.js を使用');
                    }
                    
                    // Objectデータの取得
                    const objectRows = getObjectRows();
                    if (!objectRows || objectRows.length === 0) {
                        alert('Objectが設定されていません。');
                        return;
                    }
                    
                    // 全てのObjectの位置を取得（X-Z/Y-Zボタンと同じ処理）
                    const allObjectPositions = [];
                    
                    objectRows.forEach((obj, index) => {
                        let objectPosition;
                        
                        if (Array.isArray(obj)) {
                            const xValue = parseFloat(obj[1]);
                            const yValue = parseFloat(obj[2]);
                            objectPosition = {
                                x: xValue || 0,
                                y: yValue || 0,
                                z: 0
                            };
                        } else {
                            // オブジェクト形式の場合（X-Z/Y-Zボタンと同じシンプルな処理）
                            const xCoord = parseFloat(obj.xHeightAngle) || 0;
                            const yCoord = parseFloat(obj.yHeightAngle) || 0;
                            objectPosition = {
                                x: xCoord,
                                y: yCoord,
                                z: 0
                            };
                        }
                        
                        allObjectPositions.push(objectPosition);
                    });
                    
                    // Draw ray numberの値を取得
                    const drawRayCountInput = document.getElementById('draw-ray-count-input');
                    const rayCount = drawRayCountInput ? (parseInt(drawRayCountInput.value, 10) || 7) : 7;  // デフォルト7本
                    
                    console.log(`🎯 [DrawCross] 光線数: ${rayCount}`);
                    console.log(`🎯 [DrawCross] 光学系データ: ${opticalSystemRows.length}面`);
                    console.log(`🎯 [DrawCross] 処理Object数: ${allObjectPositions.length}`);
                    console.log(`🎯 [DrawCross] 送信するObjectデータ:`, allObjectPositions);
                    
                    // 評価面の選択値を取得
                    const transverseSurfaceSelect = document.getElementById('transverse-surface-select');
                    let targetSurfaceIndex = null;
                    if (transverseSurfaceSelect && transverseSurfaceSelect.value !== '') {
                        targetSurfaceIndex = parseInt(transverseSurfaceSelect.value) - 1; // 1-based to 0-based
                        console.log(`🎯 [DrawCross] 評価面インデックス: ${targetSurfaceIndex} (Surface ${targetSurfaceIndex + 1})`);
                    } else {
                        const imageSurfaceIndex = opticalSystemRows.findIndex(row =>
                            row && (row['object type'] === 'Image' || row.object === 'Image')
                        );
                        targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);
                        console.log(`🎯 [DrawCross] 評価面未選択 - デフォルトでSurface ${targetSurfaceIndex + 1} (index: ${targetSurfaceIndex}) を使用`);
                    }
                    
                    // Object Thicknessに基づいて適切な関数を選択
                    let crossBeamResult;
                    const primaryWavelength = (typeof window.getPrimaryWavelength === 'function')
                        ? Number(window.getPrimaryWavelength()) || 0.5876
                        : 0.5876;
                    if (isInfiniteSystem) {
                        console.log('🌟 [DrawCross] 無限系クロスビーム生成を開始');
                        // 無限系の場合、objectPositionsを角度形式に変換
                        const objectAngles = allObjectPositions.map(pos => ({
                            x: pos.x || 0,  // 角度として扱う
                            y: pos.y || 0   // 角度として扱う
                        }));
                        console.log('🌟 [DrawCross] Object角度データ:', objectAngles);
                        console.log('🔧 [DrawCross] 光学系データ:', JSON.stringify(opticalSystemRows.slice(0, 3), null, 2));
                        
                        crossBeamResult = await generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, {
                            rayCount: rayCount,
                            debugMode: false,
                            wavelength: primaryWavelength,
                            crossType: 'both',  // 横・縦両方
                            targetSurfaceIndex: targetSurfaceIndex,  // 評価面インデックスを追加
                            angleUnit: 'deg',  // 角度は度数で指定
                            chiefZ: -20  // 主光線始点をz=-20に設定
                        });
                    } else {
                        console.log('🎯 [DrawCross] 有限系クロスビーム生成を開始');
                        crossBeamResult = await generateCrossBeam(opticalSystemRows, allObjectPositions, {
                            rayCount: rayCount,
                            debugMode: false,
                            wavelength: primaryWavelength,
                            crossType: 'both'  // 横・縦両方
                        });
                    }
                    
                    if (!crossBeamResult.success) {
                        alert(`クロスビーム生成失敗: ${crossBeamResult.error}`);
                        return;
                    }
                    
                    console.log(`🎯 [DrawCross] ${isInfiniteSystem ? '無限系' : '有限系'}クロスビーム生成結果:`);
                    console.log(`🔍 [DrawCross] crossBeamResult構造:`, crossBeamResult);
                    console.log(`🔍 [DrawCross] crossBeamResult.success:`, crossBeamResult.success);
                    console.log(`🔍 [DrawCross] crossBeamResult keys:`, Object.keys(crossBeamResult));
                    
                    // 戻り値の構造を確認して適切にアクセス
                    let allRays = [];
                    let processedCount = 0;
                    let totalCount = 0;
                    
                    if (crossBeamResult.results && Array.isArray(crossBeamResult.results)) {
                        // results配列がある場合
                        console.log(`🔍 [DrawCross] results配列発見: ${crossBeamResult.results.length}個`);
                        crossBeamResult.results.forEach((result, idx) => {
                            console.log(`   Result${idx + 1}:`, result);
                            if (result.rays && Array.isArray(result.rays)) {
                                allRays = allRays.concat(result.rays);
                                console.log(`   Result${idx + 1} 光線数: ${result.rays.length}`);
                            }
                        });
                        processedCount = crossBeamResult.results.length;
                        totalCount = crossBeamResult.results.length;
                    } else if (crossBeamResult.allCrossBeamRays && Array.isArray(crossBeamResult.allCrossBeamRays) &&
                               crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)) {
                        // 両方の配列がある場合：allTracedRaysにtypeプロパティを追加
                        console.log(`🔍 [DrawCross] allCrossBeamRays と allTracedRays を統合`);
                        allRays = crossBeamResult.allTracedRays.map((tracedRay, index) => {
                            const crossRay = crossBeamResult.allCrossBeamRays[index];
                            // tracedRayをベースにして、typeとbeamTypeのみ上書き（pathデータを保持）
                            if (crossRay) {
                                tracedRay.type = crossRay.type;
                                tracedRay.beamType = crossRay.beamType;
                            }
                            return tracedRay;
                        });
                        processedCount = crossBeamResult.processedObjectCount || 0;
                        totalCount = crossBeamResult.objectCount || 0;
                    } else if (crossBeamResult.allCrossBeamRays && Array.isArray(crossBeamResult.allCrossBeamRays)) {
                        // allCrossBeamRays配列のみ（光線タイプ情報を保持）
                        console.log(`⚠️ [DrawCross] allCrossBeamRays のみ使用（successプロパティなし）`);
                        allRays = crossBeamResult.allCrossBeamRays;
                        processedCount = crossBeamResult.processedObjectCount || 0;
                        totalCount = crossBeamResult.objectCount || 0;
                    } else if (crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)) {
                        // allTracedRays配列のみ（フォールバック）
                        console.log(`⚠️ [DrawCross] allTracedRays のみ使用（typeプロパティなし）`);
                        allRays = crossBeamResult.allTracedRays;
                        processedCount = crossBeamResult.processedObjectCount || 0;
                        totalCount = crossBeamResult.objectCount || 0;
                    } else if (crossBeamResult.tracedRays && Array.isArray(crossBeamResult.tracedRays)) {
                        // tracedRays配列がある場合
                        allRays = crossBeamResult.tracedRays;
                        processedCount = 1;
                        totalCount = 1;
                    } else {
                        // 戻り値自体が光線配列の場合
                        if (Array.isArray(crossBeamResult)) {
                            allRays = crossBeamResult;
                            processedCount = 1;
                            totalCount = 1;
                        }
                    }
                    
                    console.log(`   処理Object数: ${processedCount}/${totalCount}`);
                    console.log(`   総光線数: ${allRays.length}`);
                    if (allRays.length > 0) {
                        console.log(`   成功光線数: ${allRays.filter(r => r.success).length}`);
                        
                        // デバッグ: allRaysの最初の3本を詳細表示
                        console.log(`🔍 [DrawCross] allRays サンプル (最初3本):`);
                        allRays.slice(0, 3).forEach((ray, idx) => {
                            console.log(`   光線${idx}: type="${ray.type}", beamType="${ray.beamType}", success=${ray.success}`);
                        });
                        
                        // 横方向光線: horizontal_cross, left_marginal, right_marginal
                        const horizontalCount = allRays.filter(r => 
                            r.type === 'horizontal_cross' || r.type === 'left_marginal' || r.type === 'right_marginal'
                        ).length;
                        
                        // 縦方向光線: vertical_cross, upper_marginal, lower_marginal
                        const verticalCount = allRays.filter(r => 
                            r.type === 'vertical_cross' || r.type === 'upper_marginal' || r.type === 'lower_marginal'
                        ).length;
                        
                        console.log(`   横方向光線: ${horizontalCount}`);
                        console.log(`   縦方向光線: ${verticalCount}`);
                    }
                    
                    // 既存の光学要素と光線をクリア
                    clearAllOpticalElements(window.scene);
                    
                    // 光学系の描画（レンズリング表示を含む）
                    // クロスビーム描画時はレンズのリング表示をオフにして、円環状の見かけを防ぐ
                    drawOpticalSystemSurfaces({
                        opticalSystemData: opticalSystemRows,
                        scene: window.scene || document.scene,
                        showSemidiaRing: true,  // 要望: セミダイアリングを表示
                        showSurfaceOrigins: false,  // 表面の原点は表示しない
                        crossSectionOnly: false  // 断面のみではなく、完全な3D表示
                    });
                    
                    // カメラをY-Z断面の正面に設定（Draw Crossに最適化）
                    setCameraForYZCrossSection();
                    
                    // 複数Object対応クロスビームの描画
                    console.log(`🎯 [DrawCross] 描画する光線数: ${allRays.length}`);
                    if (allRays.length > 0) {
                        console.log(`🎯 [DrawCross] 描画光線のObject分布:`);
                        const objectDistribution = {};
                        allRays.forEach(ray => {
                            const objIndex = ray.objectIndex || 0;
                            objectDistribution[objIndex] = (objectDistribution[objIndex] || 0) + 1;
                        });
                        console.log(`   Object分布:`, objectDistribution);
                        
                        const successfulCrossRays = allRays.filter(ray => ray && ray.success && Array.isArray(ray.rayPath) && ray.rayPath.length > 0);
                        window.currentDrawCrossRays = successfulCrossRays.map(ray => ({
                            orientation: (() => {
                                const labels = [ray.beamType, ray.type, ray.originalRay?.type, ray.originalRay?.beamType];
                                const labelStr = labels.filter(Boolean).map(v => String(v).toLowerCase()).join(' ');
                                if (labelStr.includes('horizontal') || labelStr.includes('x')) return 'horizontal';
                                if (labelStr.includes('vertical') || labelStr.includes('y')) return 'vertical';
                                return 'unknown';
                            })(),
                            rayPath: ray.rayPath,
                            objectIndex: ray.objectIndex ?? ray.originalRay?.objectIndex ?? 0,
                            crossParameter: ray.originalRay?.crossParameter ?? ray.crossParameter ?? null,
                            description: ray.description || ray.originalRay?.description || '',
                            source: ray
                        }));
                        console.log('Stored draw-cross rays for overlay:', window.currentDrawCrossRays.length);
                        
                        drawCrossBeamRays(allRays);
                    } else {
                        console.warn(`⚠️ [DrawCross] 描画する光線が見つかりません`);
                        window.currentDrawCrossRays = [];
                    }
                    
                    // 結果をグローバルに保存
                    window.crossBeamResult = crossBeamResult;
                    window.lastGeneratedRays = allRays;
                    
                    // Image面のSemi Diaを主光線の最大高さで更新（optimizeSemiDiaが"U"の場合）
                    updateImageSemiDiaFromChiefRays(allRays, opticalSystemRows);
                    
                    // 絞り周辺光線を追加 - 停止中
                    /*
                    try {
                        const currentSystem = getCurrentOpticalSystem();
                        if (currentSystem && currentSystem.length > 0) {
                            console.log('🌟 [DrawCross] 絞り周辺光線の計算を開始');
                            // 軸上の点（デフォルトフィールド設定）を使用
                            const fieldSetting = { x: 0, y: 0, displayName: "On-axis" };
                            const marginalRays = calculateAllMarginalRays(currentSystem, fieldSetting, 0.5876); // opticalSystem, fieldSetting, wavelength
                            drawMarginalRays(marginalRays, currentSystem);
                            console.log('✅ [DrawCross] 絞り周辺光線の描画完了');
                        }
                    } catch (marginalError) {
                        console.warn('⚠️ [DrawCross] 絞り周辺光線描画でエラー:', marginalError);
                        // 絞り周辺光線のエラーは致命的ではないので続行
                    }
                    */
                    
                    console.log('✅ [DrawCross] クロスビーム描画完了');
                    
                } catch (error) {
                    console.error('❌ [DrawCross] エラー:', error);
                    alert(`クロスビーム描画エラー: ${error.message}`);
                } finally {
                    // ボタンを再有効化
                    drawCrossBtn.disabled = false;
                    drawCrossBtn.textContent = 'Draw Cross';
                }
            });
        }


        
    } catch (error) {
        console.error('❌ Failed to initialize application:', error);
        alert(`Failed to initialize application: ${error.message}`);
    }
});

// =============================================================================
// EXPORT MAIN FUNCTIONS FOR MODULE USAGE
// =============================================================================

export {
    initializeApplication,
    drawOpticalSystemSurfaceWrapper,
    improvedDrawOpticalSystemSurfaceWrapper,
    drawOptimizedRaysFromObjects
};

/**
 * Draw cross beam rays in the 3D scene (複数Object対応)
 */
function drawCrossBeamRays(tracedRays, targetScene) {
    // Use provided scene or default to window.scene
    const scene = targetScene || window.scene;
    
    console.log('🎯 [DrawCrossBeamRays] 複数Object対応描画開始', tracedRays);
    console.log('🎯 [DrawCrossBeamRays] Using scene:', scene === window.scene ? 'window.scene' : 'custom scene');
    
    if (!tracedRays || tracedRays.length === 0) {
        console.warn('⚠️ [DrawCrossBeamRays] 描画する光線がありません');
        console.log('🔍 [DrawCrossBeamRays] tracedRays:', tracedRays);
        console.log('🔍 [DrawCrossBeamRays] tracedRays type:', typeof tracedRays);
        console.log('🔍 [DrawCrossBeamRays] Array.isArray(tracedRays):', Array.isArray(tracedRays));
        return;
    }
    
    // 余計なパターン（円環・グリッド等）が混入した場合に備え、クロスビーム関連の光線だけに限定
    const allowedTypes = new Set([
        'chief',
        'left_marginal', 'right_marginal', 'upper_marginal', 'lower_marginal',
        'horizontal_cross', 'vertical_cross'
    ]);
    // 無限系では周辺光線が 'boundary' として来るケースに対応し事前に型マッピング
    tracedRays.forEach(r => {
        if (r?.originalRay?.type === 'boundary') {
            const side = r.originalRay.side || r.side;
            if (side === 'left') r.originalRay.type = 'left_marginal';
            else if (side === 'right') r.originalRay.type = 'right_marginal';
            else if (side === 'upper' || side === 'top') r.originalRay.type = 'upper_marginal';
            else if (side === 'lower' || side === 'bottom') r.originalRay.type = 'lower_marginal';
        }
    });
    const filteredRays = tracedRays.filter(r => {
        const t = r?.originalRay?.type;
        if (!(r && r.success && t && allowedTypes.has(t))) {
            console.warn(`[DrawCrossBeamRays] ❌ 除外: type=${t}, success=${r?.success}, objectIndex=${r?.objectIndex}`);
            return false;
        }
        if (r.fallback) {
            console.warn(`[DrawCrossBeamRays] ❌ 除外: フォールバック直線光線 (type=${t}, side=${r?.originalRay?.side})`);
            return false;
        }
        // 安全にパス取得
        const path = Array.isArray(r.rayPath) ? r.rayPath : (Array.isArray(r.rayPathToTarget) ? r.rayPathToTarget : []);
        
        // path配列は{x, y, z}の座標配列形式（surfaceIndexプロパティなし）
        // 有効な座標を持つ要素をフィルタリング
        const validHits = path.filter(p => 
            p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number'
        );
        
        if (validHits.length === 0) {
            console.warn(`[DrawCrossBeamRays] ⚠️ 有効な座標なし: type=${t}, pathLen=${path.length}`);
            return false; // 描画をスキップ
        }
        return true;
    });
    if (filteredRays.length !== tracedRays.length) {
        console.log(`🧹 [DrawCrossBeamRays] 非クロス系光線を除外: ${tracedRays.length - filteredRays.length}本 → 残り${filteredRays.length}本`);
    }
    const fallbackCount = filteredRays.filter(r => r.fallback).length;
    if (fallbackCount > 0) {
        console.warn(`⚠️ [DrawCrossBeamRays] フォールバック合成光線: ${fallbackCount}本 (trace失敗を補完)`);
    }
    tracedRays = filteredRays;

    if (!scene) {
        console.error('❌ [DrawCrossBeamRays] 3Dシーンが見つかりません');
        return;
    }
    
    try {
        // Object毎の光線数を集計
        const objectRayCount = {};
        tracedRays.forEach(rayData => {
            const objIndex = rayData.objectIndex || 0;
            objectRayCount[objIndex] = (objectRayCount[objIndex] || 0) + 1;
        });
        
        console.log('🎯 [DrawCrossBeamRays] Object毎の光線数:', JSON.stringify(objectRayCount));
        
        // 全ての光線を描画
        tracedRays.forEach((rayData, index) => {
            if (!rayData.success) {
                console.warn(`⚠️ [DrawCrossBeamRays] 光線${index}の追跡に失敗: ${rayData.error}`);
                return;
            }
            
            const rayPath = rayData.rayPath;
            if (!rayPath || rayPath.length === 0) {
                console.warn(`⚠️ [DrawCrossBeamRays] 光線${index}のパスが空です (objectIndex=${rayData.objectIndex}, type=${rayData.originalRay?.type})`);
                return;
            }
            
            // Object識別情報を取得
            const objectIndex = rayData.objectIndex || 0;
            const objectPosition = rayData.objectPosition;

            // beamType/side の正規化（generator由来の originalRay を尊重）
            const original = rayData.originalRay || {};
            const origType = (original.type || '').toString();
            const origSide = (original.side || '').toString();
            // 既存のbeamTypeが無い場合は推定する
            let beamType = rayData.beamType;
            if (!beamType) {
                const lt = origType.toLowerCase();
                const ls = origSide.toLowerCase();
                if (lt.includes('horizontal')) {
                    beamType = 'horizontal';
                } else if (lt.includes('vertical')) {
                    beamType = 'vertical';
                } else if (ls === 'left' || ls === 'right') {
                    beamType = 'horizontal';
                } else if (ls === 'upper' || ls === 'lower' || ls === 'top' || ls === 'bottom') {
                    beamType = 'vertical';
                } else if (lt === 'chief') {
                    // 主光線は縦横どちらのグループにも属さないため専用扱い
                    beamType = 'chief';
                } else {
                    // 安全側：縦として扱う（従来の else 分岐と互換）
                    beamType = 'vertical';
                }
            }
            // sideも表示用に正規化
            const side = (origSide.toLowerCase() === 'top') ? 'upper' : (origSide.toLowerCase() === 'bottom') ? 'lower' : (origSide || 'center');
            
            // 光線の実際の開始位置を確認
            console.log(`🔍 [DrawCrossBeamRays] 光線${index}(Object${objectIndex + 1}, ${beamType}/${side}): 開始位置 (${rayPath[0].x}, ${rayPath[0].y}, ${rayPath[0].z})`);
            if (objectPosition) {
                console.log(`   Object${objectIndex + 1}位置: (${objectPosition.x}, ${objectPosition.y}, ${objectPosition.z})`);
            }
            
            // 色分けモードを取得
            const currentColorMode = getRayColorMode(); // 'object' または 'segment'
            
            // 光線の色を設定
            let rayColor;
            const colorSystem = RayColorSystem; // 有限系・無限系共通
            
            if (currentColorMode === 'object') {
                // Object別色分け
                rayColor = colorSystem.getColor(colorSystem.MODE.OBJECT, objectIndex);
            } else if (currentColorMode === 'segment') {
                // Segment別色分け（光線タイプに基づく）
                const segmentType = rayData.segmentType || 'chief';
                rayColor = colorSystem.getColor(colorSystem.MODE.SEGMENT, 0, segmentType);
            } else {
                // デフォルト色
                rayColor = 0xffffff;
            }
            
            // LM最適化済み光線の表示
            if (rayData.optimized) {
                console.log(`🔧 [DrawCrossBeamRays] LM最適化済み光線: Object${objectIndex + 1}, ${beamType}`);
            }
            
            // 光線の色を設定（Object毎に異なる色を使用）
            let objectId;
            if (beamType === 'horizontal') {
                objectId = `cross-horizontal-obj${objectIndex}`;
            } else if (beamType === 'vertical') {
                objectId = `cross-vertical-obj${objectIndex}`;
            } else if (beamType === 'chief') {
                // 主光線は専用IDにして色マップで制御（Object1=青）
                objectId = `chief-obj${objectIndex}`;
            } else {
                // 主光線などグループ外はObject色にフォールバック
                objectId = objectIndex;
            }
            
            // 光線パスを描画（正しいパラメータで呼び出し）
            drawRayWithSegmentColors(rayPath, objectId, index, scene);
        });
        
        console.log(`✅ [DrawCrossBeamRays] ${tracedRays.length}本の光線を描画完了`);
        console.log(`   処理Object数: ${Object.keys(objectRayCount).length}`);
        
    } catch (error) {
        console.error('❌ [DrawCrossBeamRays] エラー:', error);
    }
}

// drawCrossBeamRays関数をグローバルに公開
window.drawCrossBeamRays = drawCrossBeamRays;

// generateInfiniteSystemCrossBeam関数をグローバルに公開
window.generateInfiniteSystemCrossBeam = generateInfiniteSystemCrossBeam;

// generateCrossBeam関数（有限系用）をグローバルに公開
window.generateCrossBeam = generateCrossBeam;

// drawOpticalSystemSurfaces関数をグローバルに公開
window.drawOpticalSystemSurfaces = drawOpticalSystemSurfaces;

// =============================================================================
// DEBUGGING EXPORTS - グローバルスコープに関数を公開
// =============================================================================

window.calculateChiefRayNewton = calculateChiefRayNewton;
window.traceRay = traceRay;
window.findStopSurface = findStopSurface;
window.calculateSurfaceOrigins = calculateSurfaceOrigins;

// 光学系判定関数を公開（gen-ray-cross-finite.jsから）
window.isFiniteSystem = function(opticalSystemRows) {
    // 最初の面の厚さが有限であれば有限系
    if (opticalSystemRows && opticalSystemRows.length > 0) {
        const firstSurface = opticalSystemRows[0];
        const thickness = firstSurface.thickness;
        
        // 文字列'INF'またはInfinity値の場合は無限系
        if (thickness === 'INF' || thickness === Infinity) {
            console.log(`🔍 [SystemCheck] 無限系検出: 第1面厚さ=${thickness}`);
            return false; // 無限系
        }
        
        // 数値に変換して有限かつ正の値であれば有限系
        const numThickness = parseFloat(thickness);
        const isFinite = Number.isFinite(numThickness) && numThickness > 0;
        
        console.log(`🔍 [SystemCheck] 第1面厚さ: ${thickness}, 数値: ${numThickness}, 有限性: ${isFinite}`);
        return isFinite;
    }
    return false;
};

// Distortion functions global expose
window.calculateDistortionData = calculateDistortionData;
window.plotDistortionPercent = plotDistortionPercent;
window.generateDistortionPlots = generateDistortionPlots;
window.plotGridDistortion = plotGridDistortion;
window.generateGridDistortionPlot = generateGridDistortionPlot;

// グローバルスコープへの公開用変数をまとめて定義
window.mainDebugFunctions = {
    generateCrossBeam,
    calculateChiefRayNewton,
    traceRay,
    findStopSurface,
    calculateSurfaceOrigins,
    isFiniteSystem
};

// Distortion helpers
window.mainDebugFunctions.generateDistortionPlots = generateDistortionPlots;
window.mainDebugFunctions.calculateDistortionData = calculateDistortionData;

// 🔍 Object → FieldSetting変換ヘルパー関数
function convertObjectToFieldSetting(objectData, index) {
    if (!objectData) {
        return {
            fieldAngle: { x: 0, y: 0 },
            xHeight: 0,
            yHeight: 0,
            displayName: 'On-Axis (No Data)'
        };
    }
    
    // 実際のObjectデータ構造に基づいて判定
    const isAngleType = (objectData.position === 'Angle' || objectData.Type === 'Angle' || objectData.type === 'Angle');
    
    if (isAngleType) {
        // 実際のプロパティ名を使用
        const angleX = parseFloat(objectData.xHeightAngle || objectData.X || objectData.x || 0);
        const angleY = parseFloat(objectData.yHeightAngle || objectData.Y || objectData.y || 0);
        
        console.log(`🔍 [ConvertObject] 角度変換 Object ${index + 1}: xHeightAngle=${objectData.xHeightAngle}, yHeightAngle=${objectData.yHeightAngle} → angleX=${angleX}, angleY=${angleY}`);
        
        return {
            fieldAngle: { x: angleX, y: angleY },
            fieldType: 'Angle',
            displayName: `Object ${index + 1} - ${angleX}°, ${angleY}°`
        };
    } else {
        // 高さの場合も同様に実際のプロパティ名を使用
        const heightX = parseFloat(objectData.xHeight || objectData.X || objectData.x || 0);
        const heightY = parseFloat(objectData.yHeight || objectData.Y || objectData.y || 0);
        
        console.log(`🔍 [ConvertObject] 高さ変換 Object ${index + 1}: xHeight=${objectData.xHeight}, yHeight=${objectData.yHeight} → heightX=${heightX}, heightY=${heightY}`);
        
        return {
            xHeight: heightX,
            yHeight: heightY,
            fieldType: 'Rectangle',
            displayName: `Object ${index + 1} - ${heightX}mm, ${heightY}mm`
        };
    }
}

// グローバルスコープに公開
window.convertObjectToFieldSetting = convertObjectToFieldSetting;

// 絞り周辺光線の描画関数
function drawMarginalRays(marginalRaysData, opticalSystem) {
    if (!marginalRaysData || !window.scene) {
        console.log('⚠️ [MarginalRays] 描画に必要な要素が不足しています');
        return;
    }

    // marginalRaysDataの構造を確認し、適切なデータを取得
    const marginalRays = marginalRaysData.marginalRays || marginalRaysData;

    // 要望: X-Z(水平:左右) も Y-Z(上下) と同じ青で表示する
    const rayColors = {
        up: 0x0000ff,    // 青
        down: 0x0000ff,  // 青
        left: 0x0000ff,  // 青
        right: 0x0000ff  // 青
    };

    console.log('🌟 [MarginalRays] 絞り周辺光線を描画開始');
    console.log('🔍 [MarginalRays] データ構造:', Object.keys(marginalRays));

    Object.entries(marginalRays).forEach(([direction, rayData]) => {
        if (!rayData || !rayData.success || !rayData.surfacePoints) {
            console.log(`⚠️ [MarginalRays] ${direction}方向の光線データが無効です`);
            return;
        }

        const color = rayColors[direction] || 0xffffff;
        const rayGeometry = new THREE.BufferGeometry();
        const rayPoints = [];

        // 光線の軌跡を描画用ポイントに変換
        rayData.surfacePoints.forEach(point => {
            rayPoints.push(new THREE.Vector3(point.x, point.y, -point.z));
        });

        rayGeometry.setFromPoints(rayPoints);
        const rayMaterial = new THREE.LineBasicMaterial({ 
            color: color, 
            linewidth: 2,
            transparent: true,
            opacity: 0.8
        });
        
        const rayLine = new THREE.Line(rayGeometry, rayMaterial);
        rayLine.userData = { 
            type: 'marginal-ray', 
            direction: direction,
            isOpticalRay: true 
        };
        
        window.scene.add(rayLine);
        console.log(`✅ [MarginalRays] ${direction}方向光線を追加 (色: 0x${color.toString(16).padStart(6, '0')})`);
    });
}

// 現在の光学系を取得する関数
function getCurrentOpticalSystem() {
    return getOpticalSystemRows();
}

// Export WASM system for use in other modules
export function getWASMSystem() {
    return wasmSystem;
}

// Global access to WASM system
window.getWASMSystem = getWASMSystem;
