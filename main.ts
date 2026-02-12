/**
 * JS_lensDraw v3 - Main Application Entry Point (Refactored)
 * 
 * This file serves as the main entry point of the application. 
 * It initializes the application using modular components and sets up the main functionality.
 */

console.log('🚀 [main.ts] Starting to load main.ts module');

// =============================================================================
// IMPORTS
// =============================================================================

console.log('🚀 [main.ts] Importing THREE.js...');

// Core modules
import { APP_CONFIG, initializeReferences, setIsGeneratingSpotDiagram, setIsGeneratingTransverseAberration, getScene, getCamera, getRenderer, getControls } from './core/app-config.ts';
import { initializeThreeJS, initializeLighting, renderScene, animate } from './core/scene-setup.ts';

// Table data modules
import { loadTableData as loadSourceTableData, saveTableData as saveSourceTableData, tableSource, mountTableSourceIfReady } from './data/table-source.ts';
import { loadTableData as loadObjectTableData, saveTableData as saveObjectTableData, tableObject, mountTableObjectIfReady } from './data/table-object.ts';
import { loadTableData as loadOpticalSystemTableData, saveTableData as saveLensTableData, tableOpticalSystem, updateAllRefractiveIndices, updateOpticalPropertiesFromMaterial, mountTableOpticalSystemIfReady } from './data/table-optical-system.ts';
import { loadTableData as loadSystemRequirementsTableData, saveTableData as saveSystemRequirementsTableData } from './data/table-system-requirements.ts';

// Optical system modules
import { drawOpticalSystemSurfaces, clearAllOpticalElements, findStopSurface } from './optical/system-renderer.ts';
import { drawAsphericProfile, drawPlaneProfile, drawLensSurface, drawLensSurfaceWithOrigin, drawLensCrossSection, drawLensCrossSectionWithSurfaceOrigins, drawSemidiaRingWithOriginAndSurface, asphericSurfaceZ, addMirrorBackText } from './optical/surface.ts';

// Ray tracing modules
import { traceRay, calculateSurfaceOrigins, transformPointToLocal, calculateAllSurfacesLocalCoordinates, resetToSurfaceCoordinates, shiftToChiefRayOrigin, restoreFromLocalCoordinates, transformToChiefRayLocalCoordinates, calculateChiefRaySurfaceIntersections } from './raytracing/core/ray-tracing.ts';
import { calculateFocalLength, calculateBackFocalLength, calculateImageDistance, calculateEntrancePupilDiameter, calculateExitPupilDiameter, calculateFullSystemParaxialTrace, calculateParaxialData, debugParaxialRayTrace, calculatePupilsByNewSpec, findStopSurfaceIndex } from './raytracing/core/ray-paraxial.ts';

// Marginal ray modules
import { calculateAdaptiveMarginalRay, calculateAllMarginalRays } from './raytracing/core/ray-marginal.ts';

// Analysis modules
import { generateSpotDiagram, drawSpotDiagram, generateSurfaceOptions } from './evaluation/spot-diagram.ts';
import { calculateTransverseAberration, getFieldAnglesFromSource, getPrimaryWavelengthForAberration, validateAberrationData, calculateChiefRayNewton, getEstimatedEntrancePupilDiameter } from './evaluation/aberrations/transverse-aberration.ts';
import { plotTransverseAberrationDiagram, showTransverseAberrationInNewWindow } from './evaluation/aberrations/transverse-aberration-plot.ts';
import { showWavefrontDiagram } from './evaluation/wavefront/wavefront-plot.ts';
import { OpticalPathDifferenceCalculator, WavefrontAberrationAnalyzer, createOPDCalculator, createWavefrontAnalyzer } from './evaluation/wavefront/wavefront.ts';
import { PSFCalculator } from './evaluation/psf/psf-calculator.ts';
import { PSFPlotter, PSFDisplayManager } from './evaluation/psf/psf-plot.ts';
import { showMTFDiagram } from './evaluation/mtf-plot.ts';
import { fitZernikeWeighted, reconstructOPD, getZernikeName } from './evaluation/wavefront/zernike-fitting.ts';
import { calculateOPDWithZernike, displayZernikeAnalysis, exportZernikeAnalysisJSON } from './evaluation/wavefront/opd-zernike-analysis.ts';
import { generateCrossBeam, generateFiniteSystemCrossBeam, RayColorSystem } from './raytracing/generation/gen-ray-cross-finite.ts';
import { generateInfiniteSystemCrossBeam, RayColorSystem as InfiniteRayColorSystem } from './raytracing/generation/gen-ray-cross-infinite.ts';
// Distortion analysis
import { calculateDistortionData } from './evaluation/aberrations/distortion.ts';
import { plotDistortionPercent, generateDistortionPlots, plotGridDistortion, generateGridDistortionPlot } from './evaluation/aberrations/distortion-plot.ts';

// Utility modules
import { getGlassDataWithSellmeier, calculateRefractiveIndex, getPrimaryWavelength } from './data/glass.ts';
import { multiplyMatrices, createRotationMatrixX, createRotationMatrixY, createRotationMatrixZ, createRotationMatrix, calculateLocalCoordinateTransforms, applyMatrixToVector, calculateOpticalSystemOffset } from './utils/math.ts';
import { getOpticalSystemRows, getObjectRows, getSourceRows, outputParaxialDataToDebug, outputSeidelCoefficientsToDebug, outputDebugSystemData, displayCoordinateTransformMatrix, debugTableStatus, initializeTablesWithDummyData, renderBlockContributionSummaryFromSeidel, renderSystemConstraintsFromSurfaceRows } from './utils/data-utils.ts';
import { initAIAssistant } from './ai/ai-assistant.ts';

// Import/Export modules
import { generateZMXText, downloadZMX } from './import-export/zemax-export.ts';
import { parseZMXTextToOpticalSystemRows, parseZMXArrayBufferToOpticalSystemRows } from './import-export/zemax-import.ts';

// Ray rendering modules
import { setRayEmissionPattern, setRayColorMode, getRayEmissionPattern, getRayColorMode, optimizeObjectPositionForStop, optimizeAngleObjectPosition, generateRayStartPointsForObject, drawRayWithSegmentColors } from './optical/ray-renderer.ts';

// UI modules
import { setupRayPatternButtons, setupRayColorButtons, setupViewButtons, setupOpticalSystemChangeListeners, setupSimpleViewButtons, setupTransformationControls, updateTransformSurfaceSelect, setupAnalysisWindows } from './ui/event-handlers.ts';
import { updateSurfaceNumberSelect, updateAllUIElements, initializeUIEventListeners } from './ui/ui-updates.ts';
import { loadFromCompressedDataHashIfPresent, setupDOMEventHandlers, loadSystemConfigurations, saveSystemConfigurations, loadActiveConfigurationToTables, refreshBlockInspector } from './ui/dom-event-handlers.ts';
import { getToolbarCollapsed, setToolbarCollapsed } from './ui/toolbar-collapsed-storage.ts';
import { updateWavefrontObjectSelect, initializeWavefrontObjectUI, debugResetObjectTable } from './ui/wavefront-object-select.ts';
import { initializeConfigurationUI } from './ui/configuration-handlers.ts';
import { getActiveConfiguration } from './data/table-configuration.ts';
import { expandBlocksToOpticalSystemRows } from './data/block-schema.ts';
import { exposeWindowValue, installCooptWindowFacadeMarker, requestRefreshBlockInspector, requestUpdateSurfaceNumberSelect } from './core/window-facade.ts';
import { setRenderingContext } from './core/rendering-context.ts';

// Editor modules (must be imported to initialize)
import './ui/editors/system-requirements-editor.ts';
import './ui/editors/merit-function-editor.ts';



// Suggest (Design Intent) implementation (adds window.SuggestDesignIntent)
import './optimization/suggest-design-intent.ts';

// Analysis modules
import { clearAllDrawing, showSpotDiagram, showTransverseAberrationDiagram, showLongitudinalAberrationDiagram, showAstigmatismDiagram, showIntegratedAberrationDiagram, outputChiefRayConvergenceData, calculateSceneBounds, fitCameraToScene } from './analysis/optical-analysis.ts';

// Performance monitoring (削除されたファイルなのでコメントアウト)
// import { performanceMonitor } from './performance-monitor.ts';

// WASM acceleration system
// Temporarily commented out to test loading
// import { ForceWASMSystem } from './wasm/raytracing/force-wasm-system.ts';

// THREE.js and OrbitControls imports
import * as THREE from 'three';
import { OrbitControls } from 'OrbitControls';

// Type definitions for camera options
interface CameraOptions {
  camera?: THREE.Camera;
  controls?: OrbitControls;
  scene?: THREE.Scene;
  renderer?: THREE.WebGLRenderer;
  includeRayStartMargin?: boolean;
  preserveDrawCrossBounds?: boolean;
  centerZOverride?: number;
  targetOverride?: { x: number; y: number; z: number };
  preserveCurrentOrthoBounds?: boolean;
  storeDrawCrossBounds?: boolean;
  cameraDistance?: number;
}

// Export THREE and OrbitControls to global scope for popup windows
window['THREE'] = THREE;
window['OrbitControls'] = OrbitControls;

// ForceWASMSystem globals are owned by wasm/raytracing/force-wasm-system.ts (legacy) or a dedicated service module.

// Global WASM system instance
let wasmSystem = null;

// Note: getWASMSystem/_setWASMSystem globals are installed by core/wasm-service.ts (index.html <head>).
// main.ts only updates the instance via window._setWASMSystem once WASM is ready.
if (typeof window !== 'undefined' && typeof (window as any)._setWASMSystem === 'function') {
    console.log('🔧 [Init] WASM service globals are available');
}

// =============================================================================
// MAIN APPLICATION INITIALIZATION
// =============================================================================

/**
 * Initialize the main application
 */
async function initializeApplication() {
    console.log('🚀 [Init] initializeApplication() started');
    try {
        // Initialize WASM system (non-blocking - run in background)
        const wasmInitPromise = (async () => {
            try {
                // Temporarily skip WASM initialization
                console.log('⚠️ [Init] WASM system temporarily disabled');
                return;
                // wasmSystem = new ForceWASMSystem();
                console.log('🔧 [Init] ForceWASMSystem インスタンスを作成しました');
                
                // Update the global reference immediately
                if (typeof window !== 'undefined' && typeof window._setWASMSystem === 'function') {
                    window._setWASMSystem(wasmSystem);
                    console.log('🔧 [Init] window._setWASMSystemでインスタンスを更新しました');
                }
                
                // Shorter timeout for WASM initialization
                const initTimeout = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('WASM initialization timeout')), 3000)
                );
                
                await Promise.race([
                    wasmSystem.forceInitializeWASM(),
                    initTimeout
                ]);
                console.log('✅ [Init] WASM初期化が完了しました');
            } catch (error) {
                console.warn('⚠️ WASM initialization failed:', error);
                // Set a flag to indicate WASM is not available
                if (wasmSystem) {
                    wasmSystem.isWASMReady = false;
                }
            }
        })();
        
        // Don't wait for WASM - continue with UI initialization immediately
        
        // Initialize THREE.js scene components
        const { scene, camera, renderer, controls } = initializeThreeJS();

        // Ensure React-rendered tables are mounted before wiring references
        try { mountTableSourceIfReady(); } catch (_) {}
        try { mountTableObjectIfReady(); } catch (_) {}
        try { mountTableOpticalSystemIfReady(); } catch (_) {}
        
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
        }
        
        try {
            setupRayPatternButtons();
        } catch (error) {
        }
        
        try {
            setupRayColorButtons();

        } catch (error) {
        }
        
        try {
            setupTransformationControls();
        } catch (error) {
        }
        
        try {
            // Setup analysis window buttons (must be called after React mount)
            setupAnalysisWindows();
            
            // Initialize spot diagram controls after a short delay to ensure DOM is ready
            setTimeout(() => {
                try {
                    if (typeof window.updateSpotDiagramConfigSelect === 'function') {
                        window.updateSpotDiagramConfigSelect();
                    }
                    requestUpdateSurfaceNumberSelect();
                } catch (e) {
                    console.warn('Failed to initialize spot diagram selects:', e);
                }
            }, 100);
        } catch (error) {
            console.error('Failed to setup analysis windows:', error);
        }
        
        try {
            // View buttons setup - using simple version
            setupSimpleViewButtons();
        } catch (error) {
        }
        
        try {
            initializeUIEventListeners();

        } catch (error) {
        }
        
        try {
            setupDOMEventHandlers();

        } catch (error) {
        }
        
        // Configuration UI初期化
        try {
            initializeConfigurationUI();
        } catch (error) {
        }
        
        // 波面収差図Object選択UI初期化
        try {
            initializeWavefrontObjectUI();

        } catch (error) {
        }
        
        // Update UI elements
        try {
            updateAllUIElements();
        } catch (error) {
        }

        // Expose rebind helpers for React-mount timing
        try {
            window['initializeAllTables'] = () => {
                try { mountTableSourceIfReady(); } catch (_) {}
                try { mountTableObjectIfReady(); } catch (_) {}
                try { mountTableOpticalSystemIfReady(); } catch (_) {}
                try { updateAllUIElements(); } catch (_) {}
                try { requestRefreshBlockInspector(); } catch (_) {}
                try { requestUpdateSurfaceNumberSelect(); } catch (_) {}
            };
        } catch (_) {}

        // Expose analysis/setup helpers for React timing
        try {
            window['setupAnalysisWindows'] = setupAnalysisWindows;
            window['setupOpticalSystemChangeListeners'] = setupOpticalSystemChangeListeners;
        } catch (_) {}

        try {
            window['rebindEventHandlers'] = () => {
                console.log('🔄 [Rebind] rebindEventHandlers called');
                const mainToolbarBtns = [
                    'new-file-btn', 'save-all-btn', 'load-all-btn', 'load-default-btn',
                    'import-zemax-btn', 'export-zemax-btn', 'optimize-design-intent-btn'
                ];
                console.log('🔄 [Rebind] Checking button existence:');
                mainToolbarBtns.forEach(id => {
                    const btn = document.getElementById(id);
                    console.log(`  ${id}: ${btn ? '✅ found' : '❌ NOT FOUND'}`);
                });
                
                try { initializeUIEventListeners(); } catch (_) {}
                try { setupDOMEventHandlers(); } catch (_) {}
                try { initializeConfigurationUI(); } catch (_) {}
                try {
                    const scene = getScene?.();
                    if (scene) setupOpticalSystemChangeListeners(scene);
                } catch (_) {}
                try { setupAnalysisWindows(); } catch (_) {}
                
                console.log('✅ [Rebind] rebindEventHandlers completed');
            };
        } catch (_) {}
        
        
        // Debug table initialization status
        setTimeout(async () => {
            debugTableStatus();
            
            // Objectテーブル初期化後にObject選択を再更新
            try {
                if (window.updateWavefrontObjectSelect) {
                    window.updateWavefrontObjectSelect();
                }
            } catch (error) {
            }
            
            // (removed) OPD Rays drawing feature
        }, 1000);
        
        // Export functions to global scope for debugging
        // debugSceneContents global export removed (debug-utils.ts deleted)
        // legacy debug camera helper export removed (debug-utils.ts deleted)
        // showSceneBoundingBox global export removed (debug-utils.ts deleted)
        window['fitCameraToScene'] = fitCameraToScene;
        window['clearAllDrawing'] = clearAllDrawing;
        window['showSpotDiagram'] = showSpotDiagram;
        window['showTransverseAberrationDiagram'] = showTransverseAberrationDiagram;
        window['showLongitudinalAberrationDiagram'] = showLongitudinalAberrationDiagram;
        window['showAstigmatismDiagram'] = showAstigmatismDiagram;
        window['showAstigmatism'] = async () => {
            const progressWrapper = document.getElementById('astigmatism-progress-wrapper');
            const progressBarRaw = document.getElementById('astigmatism-progressbar');
            const progressBarEl = progressBarRaw instanceof HTMLProgressElement ? progressBarRaw : null;
            const progressTextEl = document.getElementById('astigmatism-progress-text');

            const setProgress = (value?: number, text?: string) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) {
                        progressBarEl.value = Math.max(0, Math.min(100, value as number));
                    }
                    if (progressTextEl && typeof text === 'string') {
                        progressTextEl.textContent = text;
                    }
                } catch (_) {}
            };

            setProgress(0, 'Starting...');

            try {
                const onProgress = (evt: any) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };

                await showAstigmatismDiagram({ onProgress });
                setProgress(100, 'Done');
            } catch (error) {
                console.error('❌ Astigmatism diagram error:', error);
                setProgress(100, 'Failed');
            }
        };
        window['showIntegratedAberrationDiagram'] = showIntegratedAberrationDiagram;
        window['showWavefrontDiagram'] = showWavefrontDiagram;
        window['showMTFDiagram'] = showMTFDiagram;
        
        // Wavefront analysis functions (for debugging)
        // window.OpticalPathDifferenceCalculator / window.WavefrontAberrationAnalyzer / window.createWavefrontAnalyzer
        // are owned by evaluation/wavefront/wavefront.ts
        
        window['outputParaxialDataToDebug'] = outputParaxialDataToDebug;
        window['outputSeidelCoefficientsToDebug'] = outputSeidelCoefficientsToDebug;
        window['outputDebugSystemData'] = outputDebugSystemData;
        window['displayCoordinateTransformMatrix'] = displayCoordinateTransformMatrix;
        window['renderBlockContributionSummaryFromSeidel'] = renderBlockContributionSummaryFromSeidel;
        window['renderSystemConstraintsFromSurfaceRows'] = renderSystemConstraintsFromSurfaceRows;
        
        // Debug functions
        window['debugTableStatus'] = debugTableStatus;
        window['initializeTablesWithDummyData'] = initializeTablesWithDummyData;
        
        // Export ray rendering functions
        // (already exported at module top-level backward-compat section)
        
        // Export Zemax import/export functions
        window['generateZMXText'] = generateZMXText;
        window['downloadZMX'] = downloadZMX;
        window['parseZMXTextToOpticalSystemRows'] = parseZMXTextToOpticalSystemRows;
        window['parseZMXArrayBufferToOpticalSystemRows'] = parseZMXArrayBufferToOpticalSystemRows;
        
        // Export evaluation/analysis functions for popup windows
        // window.createOPDCalculator is already exported at module top-level
        // window.PSFCalculator / window.PSFPlotter are owned by evaluation/psf modules
        window['calculateFocalLength'] = calculateFocalLength;
        window['findStopSurfaceIndex'] = findStopSurfaceIndex;
        
        // Export coordinate transformation functions
        window['calculateAllSurfacesLocalCoordinates'] = calculateAllSurfacesLocalCoordinates;
        window['resetToSurfaceCoordinates'] = resetToSurfaceCoordinates;
        window['shiftToChiefRayOrigin'] = shiftToChiefRayOrigin;
        window['restoreFromLocalCoordinates'] = restoreFromLocalCoordinates;
        window['transformToChiefRayLocalCoordinates'] = transformToChiefRayLocalCoordinates;
        window['calculateChiefRaySurfaceIntersections'] = calculateChiefRaySurfaceIntersections;
        window['updateTransformSurfaceSelect'] = updateTransformSurfaceSelect;
        
        // Export undo system dependencies
        window['loadSystemConfigurations'] = loadSystemConfigurations;
        window['saveSystemConfigurations'] = saveSystemConfigurations;
        window['loadActiveConfigurationToTables'] = loadActiveConfigurationToTables;
        installCooptWindowFacadeMarker();
        exposeWindowValue('refreshBlockInspector', refreshBlockInspector, { overwrite: true });
        window['expandBlocksToOpticalSystemRows'] = expandBlocksToOpticalSystemRows;
        window['getActiveConfiguration'] = getActiveConfiguration;
        window['loadSourceTableData'] = loadSourceTableData;
        window['saveSourceTableData'] = saveSourceTableData;
        window['loadObjectTableData'] = loadObjectTableData;
        window['saveObjectTableData'] = saveObjectTableData;
        window['loadSystemRequirementsTableData'] = loadSystemRequirementsTableData;
        window['saveSystemRequirementsTableData'] = saveSystemRequirementsTableData;
        
        // Export Configuration UI initialization
        window['initializeConfigurationUI'] = initializeConfigurationUI;

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
        window['outputChiefRayConvergenceData'] = outputChiefRayConvergenceData;
        
        // Export THREE.js components to global scope (debug/legacy)
        setRenderingContext({ scene, camera, renderer, controls });
        
        return {
            scene,
            camera,
            renderer,
            controls,
            ambientLight,
            directionalLight
        };
        
    } catch (error) {
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
        
        
        const scene = getScene?.();
        const renderer = getRenderer?.();

        // システムタイプが変更された場合、より完全なクリアを実行
        if (systemTypeChanged) {
            // レンダラーとシーンを完全にクリア
            if (renderer) {
                renderer.clear();
            }
            if (scene) {
                // より厳密なクリア：すべての子要素を削除
                const allChildren = [...scene.children];
                allChildren.forEach(child => {
                    scene.remove(child);
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
        setLastSystemType(currentSystemType);
        
        // Draw optical system surfaces
        drawOpticalSystemSurfaces({
            opticalSystemData: finalOptions.opticalSystemData,
            scene: scene || (document as any).scene,
            crossSectionOnly: finalOptions.crossSectionOnly,
            showSemidiaRing: finalOptions.showSemidiaRing,
            showSurfaceOrigins: finalOptions.showSurfaceOrigins,
            showMirrorBackText: finalOptions.showMirrorBackText,
            crossSectionDirection: finalOptions.crossSectionDirection,
            crossSectionCenterOffset: finalOptions.crossSectionCenterOffset
        });
        
        
    } catch (error) {
    }
}

/**
 * Improved draw optical system surface wrapper function
 */
function improvedDrawOpticalSystemSurfaceWrapper() {
    
    try {
        const scene = getScene?.();
        const camera = getCamera?.();
        const controls = getControls?.();
        const renderer = getRenderer?.();

        // Clear existing optical elements first
        if (scene) clearAllOpticalElements(scene);
        
        // Get optical system data
        const opticalSystemRows = getOpticalSystemRows();
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            return;
        }
        
        // Draw optical system surfaces
        drawOpticalSystemSurfaces({
            opticalSystemData: opticalSystemRows,
            scene: scene!,
            crossSectionOnly: false,
            showSurfaceOrigins: false,
            showSemidiaRing: true,
            showMirrorBackText: false,
            crossSectionDirection: 'z',
            crossSectionCenterOffset: 0
        });
        
        // Adjust camera view to fit the drawn surfaces
        if (typeof window.adjustCameraView === 'function') {
            window.adjustCameraView(scene, camera, controls, renderer);
        }
        
    } catch (error) {
    }
}

function setLastSystemType(systemType: string) {
    (window as any)['lastSystemType'] = systemType;
}

function setCurrentDrawCrossRays(rays: any[]) {
    (window as any)['currentDrawCrossRays'] = rays;
}

/**
 * Draw optimized rays from objects (正確な光線追跡版)
 */
function drawOptimizedRaysFromObjects(opticalSystemRows) {
    
    try {
        const objectRows = getObjectRows();
        const scene = getScene?.();
        
        if (!scene) {
            return;
        }
        
        if (!objectRows || objectRows.length === 0) {
            return;
        }
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            return;
        }
        
        // 正確な光線追跡を実行（generateRayStartPointsForObject を使用して Angle も正しく扱う）
        objectRows.forEach((obj, objIndex) => {

            // Get ray count from UI input
            const rayCountInput = document.getElementById('draw-ray-count-input') as HTMLInputElement | null;
            const rayCount = rayCountInput ? (parseInt(rayCountInput.value || '5', 10) || 5) : 5;

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

                    } else {
                    }
                } catch (error) {
                }

                rayIndex++;
            }
        });
        
        
    } catch (error) {
    }
}

/**
 * Force draw everything for testing
 */
function forceDrawEverything() {
    
    try {
        // Clear scene first
        const scene = getScene?.();
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
        
        console.log('  - Optical system rows:', opticalSystemRows?.length || 0);
        console.log('  - Object rows:', objectRows?.length || 0);
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            initializeTablesWithDummyData();
        }
        
        // Force draw optical surfaces
        if (!scene) {
            return;
        }
        drawOpticalSystemSurfaces({
            opticalSystemData: getOpticalSystemRows(),
            scene: scene,
            crossSectionOnly: false,
            showSurfaceOrigins: false,
            showSemidiaRing: true,
            showMirrorBackText: false,
            crossSectionDirection: 'z',
            crossSectionCenterOffset: 0
        });
        
        // Force draw rays
        const finalOpticalSystemRows = getOpticalSystemRows();
        const finalObjectRows = getObjectRows();
        
        if (finalObjectRows && finalObjectRows.length > 0) {
            drawOptimizedRaysFromObjects(finalOpticalSystemRows);
        } else {
            const defaultObject = {
                height: 10,
                distance: 100,
                angle: 0,
                position: 'height'
            };
            
            const rayStartPoints = generateRayStartPointsForObject(defaultObject, finalOpticalSystemRows, 11);
            if (rayStartPoints && rayStartPoints.length > 0) {
                rayStartPoints.forEach((rayStart: any) => {
                    drawRayWithSegmentColors(rayStart, finalOpticalSystemRows, [], scene);
                });
            }
        }
        
        // Force render
        const renderer = getRenderer?.();
        const camera = getCamera?.();
        if (renderer && scene && camera) {
            renderer.render(scene, camera);
        }
        
        
    } catch (error) {
    }
}

/**
 * Fit camera to show the optical system properly
 */
function fitCameraToOpticalSystem() {
    
    try {
        const camera = getCamera?.();
        const controls = getControls?.();
        const scene = getScene?.();
        const renderer = getRenderer?.();
        
        if (!camera || !controls || !scene) {
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
        if (renderer) {
            renderer.render(scene, camera);
        }
        
        
    } catch (error) {
    }
}

/**
 * Calculate optical system Z range based on surface origins
 */
function calculateOpticalSystemZRange() {
    try {
        const opticalSystemRows = getOpticalSystemRows();
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            return { minZ: 0, maxZ: 414, centerZ: 207, totalLength: 414, maxY: 50 };
        }
        
        // Surface origins を計算
        const surfaceOrigins = calculateSurfaceOrigins(opticalSystemRows);
        if (!surfaceOrigins || surfaceOrigins.length === 0) {
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
            return { minZ: 0, maxZ: 414, centerZ: 207, totalLength: 414, maxY: maxY || 50 };
        }
        
        const minZ = Math.min(...zPositions);
        const maxZ = Math.max(...zPositions);
        const centerZ = (minZ + maxZ) / 2;
        const totalLength = maxZ - minZ;
        
        
        return { minZ, maxZ, centerZ, totalLength, maxY };
        
    } catch (error) {
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
            return;
        }
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            return;
        }
        
        const isCoordTransRow = (row) => {
            const stRaw = String(row?.surfType ?? row?.['surf type'] ?? row?.surface_type ?? '').toLowerCase();
            const st = stRaw.trim();
            return st === 'coord trans' || st === 'coordinate break' || st === 'coordtrans' || st === 'coordinatebreak' || st === 'ct';
        };

        const isObjectRow = (row) => {
            const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();
            return t === 'object';
        };

        const getRayPathPointIndexForSurfaceIndex = (rows, surfaceIndex) => {
            if (!Array.isArray(rows) || surfaceIndex === null || surfaceIndex === undefined) return null;
            const sIdx = Math.max(0, Math.min(surfaceIndex, rows.length - 1));
            let count = 0;
            for (let i = 0; i <= sIdx; i++) {
                const row = rows[i];
                if (isCoordTransRow(row)) continue;
                if (isObjectRow(row)) continue;
                count++;
            }
            return count > 0 ? count : null;
        };

        const getRayPointAtSurfaceIndex = (rayPath, rows, surfaceIndex) => {
            if (!Array.isArray(rayPath)) return null;
            const pIdx = getRayPathPointIndexForSurfaceIndex(rows, surfaceIndex);
            if (pIdx === null) return null;
            if (pIdx >= 0 && pIdx < rayPath.length) return rayPath[pIdx];
            return null;
        };

        // Image面（最終面）を見つける
        const imageSurfaceIndex = opticalSystemRows.length - 1;
        const imageSurface = opticalSystemRows[imageSurfaceIndex];
        const surfaceInfos = calculateSurfaceOrigins(opticalSystemRows);
        const imageSurfaceInfo = Array.isArray(surfaceInfos) ? surfaceInfos[imageSurfaceIndex] : null;
        
        // optimizeSemiDiaが"U"またはsemidiaが"Auto"かチェック
        const isAutoUpdate = imageSurface.optimizeSemiDia === 'U' || imageSurface.semidia === 'Auto';
        
        if (!isAutoUpdate) {
            return;
        }
        
        
        // 主光線のみを抽出
        const chiefRays = rays.filter(ray => {
            // beamTypeまたはtypeに"chief"が含まれるか確認
            const type = (ray.beamType || ray.type || '').toLowerCase();
            return type.includes('chief');
        });
        
        
        if (chiefRays.length === 0) {
            return;
        }
        
        // 各主光線のImage面でのY座標の絶対値を取得
        let maxHeight = 0;
        chiefRays.forEach((ray, index) => {
            if (!ray.rayPath || !Array.isArray(ray.rayPath)) {
                return;
            }
            
            // Image面（最終面）のポイントを取得 (Coord Break/Object行はrayPathに含まれない)
            const imagePoint = getRayPointAtSurfaceIndex(ray.rayPath, opticalSystemRows, imageSurfaceIndex);
            if (imagePoint && Number.isFinite(imagePoint.x) && Number.isFinite(imagePoint.y)) {
                const localPoint = imageSurfaceInfo ? transformPointToLocal(imagePoint, imageSurfaceInfo) : imagePoint;
                const objPos = ray.objectPosition || ray.originalRay?.objectPosition || null;
                let height = 0;
                if (objPos && (objPos.x || objPos.y)) {
                    const objX = Math.abs(Number(objPos.x) || 0);
                    const objY = Math.abs(Number(objPos.y) || 0);
                    height = (objX > objY)
                        ? Math.abs(Number(localPoint.x) || 0)
                        : Math.abs(Number(localPoint.y) || 0);
                } else {
                    height = Math.max(Math.abs(Number(localPoint.x) || 0), Math.abs(Number(localPoint.y) || 0));
                }
                console.log(`   主光線${index}: Image面ローカル高さ = ${height.toFixed(6)}`);
                maxHeight = Math.max(maxHeight, height);
            }
        });
        
        if (maxHeight > 0) {
            
            // Image面のSemi Diaを更新
            imageSurface.semidia = maxHeight;
            
            // テーブルを更新
            if (window.tableOpticalSystem) {
                window.tableOpticalSystem.updateData([imageSurface]);
            }
        } else {
        }
        
    } catch (error) {
    }
}

/**
 * Update camera view bounds based on optical system size (for resize handling)
 * カメラの位置や方向は変更せず、視野範囲のみを更新
 */
function updateCameraViewBounds() {
    
    const camera = getCamera?.();
    if (!camera) {
        return;
    }
    
    if (!camera.isOrthographicCamera) {
        return;
    }
    
    try {
        const scene = getScene?.();
        const sceneBounds = __coopt_calculateOpticalElementsBounds(scene);

        // 光学系のZ範囲とY範囲を動的に計算
        const rangeData = calculateOpticalSystemZRange();
        if (!rangeData) {
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
        
        // 光線の開始位置も考慮
        const rayStartMargin = 25;
        const effectiveMinZ = Math.min(minZ, -rayStartMargin);
        const effectiveMaxZ = maxZ;
        const effectiveTotalLength = effectiveMaxZ - effectiveMinZ;
        
        // レンダラーの実際のサイズを取得してアスペクト比を計算
        let aspect = 1.5;
        const renderer = getRenderer?.();
        if (renderer) {
            const size = renderer.getSize(new THREE.Vector2());
            aspect = size.x / size.y;
        }
        
        // 描画枠全体に光学系が収まるように視野サイズを計算
        const marginFactor = 1.1;
        const safeMaxY = (Number.isFinite(maxY) && maxY > 0) ? maxY : 50;
        const visibleHeight = safeMaxY * 2 * marginFactor;
        const visibleWidth = effectiveTotalLength * marginFactor;
        
        
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
        
    } catch (error) {
    }
}

// グローバルに公開
window['updateCameraViewBounds'] = updateCameraViewBounds;

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
function setCameraForYZCrossSection(options: CameraOptions = {}) {
    
    try {
        const camera = options.camera || getCamera?.();
        const controls = options.controls || getControls?.();
        const scene = options.scene || getScene?.();
        const renderer = options.renderer || getRenderer?.();
        
        if (!camera || !controls || !scene) {
            return;
        }
        
        // 光学系のZ範囲とY範囲を動的に計算
        // まずシーン内の実際のオブジェクト（光線含む）のバウンディングボックスを取得
        const sceneBounds = __coopt_calculateOpticalElementsBounds(scene);
        
        // sceneBoundsが取得できた場合は、それを優先的に使用
        let fitMinZ, fitMaxZ, fitMinY, fitMaxY, fitCenterZ, fitCenterY;
        
        if (sceneBounds && !sceneBounds.isEmpty()) {
            fitMinZ = sceneBounds.min.z;
            fitMaxZ = sceneBounds.max.z;
            fitMinY = sceneBounds.min.y;
            fitMaxY = sceneBounds.max.y;
            fitCenterZ = (fitMinZ + fitMaxZ) / 2;
            fitCenterY = (fitMinY + fitMaxY) / 2;
            
            console.log('🎯 YZ Camera Fit - Scene Bounds:', {
                minZ: fitMinZ.toFixed(2),
                maxZ: fitMaxZ.toFixed(2),
                centerZ: fitCenterZ.toFixed(2),
                minY: fitMinY.toFixed(2),
                maxY: fitMaxY.toFixed(2),
                centerY: fitCenterY.toFixed(2),
                width: (fitMaxZ - fitMinZ).toFixed(2),
                height: (fitMaxY - fitMinY).toFixed(2)
            });
        } else {
            // フォールバック: 光学系データから推定
            const { minZ, maxZ, centerZ, totalLength, maxY } = calculateOpticalSystemZRange();
            const includeRayStartMargin = options.includeRayStartMargin !== false;
            const rayStartMargin = includeRayStartMargin ? 50 : 0;
            fitMinZ = Math.min(minZ, -rayStartMargin);
            fitMaxZ = maxZ;
            fitCenterZ = (fitMinZ + fitMaxZ) / 2;
            fitCenterY = 0;
            fitMinY = -(maxY || 50);
            fitMaxY = (maxY || 50);
        }

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
        }
        
        // 描画枠全体に光学系が収まるように視野サイズを計算
        const marginFactor = 1.2;
        const visibleHeight = (fitMaxY - fitMinY) * marginFactor;
        const visibleWidth = (fitMaxZ - fitMinZ) * marginFactor;
        
        // OrthographicCameraの場合、視野範囲を直接設定
        if (camera.isOrthographicCamera) {
            const preserveRequested = options.preserveCurrentOrthoBounds === true;
            const hasReliableExtent = sceneBounds && !sceneBounds.isEmpty();
            const preserveCurrentOrthoBounds = preserveRequested && hasReliableExtent;
            if (preserveCurrentOrthoBounds) {
                // User already adjusted the view (pan/zoom/rotate).
                // Keep the current bounds so pressing Render does not change the scale.
                expandOrthoBoundsToAspect(camera, aspect);
            } else if (preserveDrawCrossBounds) {
                camera.left = savedBounds.left;
                camera.right = savedBounds.right;
                camera.top = savedBounds.top;
                camera.bottom = savedBounds.bottom;
                expandOrthoBoundsToAspect(camera, aspect);
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
                // Y-Z view: left/right = Z軸, top/bottom = Y軸
                camera.left = fitCenterZ - viewWidth;
                camera.right = fitCenterZ + viewWidth;
                camera.top = fitCenterY + viewHeight;
                camera.bottom = fitCenterY - viewHeight;
                
                console.log('📐 YZ Camera bounds set:', {
                    left: camera.left.toFixed(2),
                    right: camera.right.toFixed(2),
                    top: camera.top.toFixed(2),
                    bottom: camera.bottom.toFixed(2),
                    viewWidth: viewWidth.toFixed(2),
                    viewHeight: viewHeight.toFixed(2)
                });

            }
        }
        
        if (sceneBounds) {
        }
        
        // カメラをX軸負方向に配置（Y-Z断面の正面）- 距離は任意（正投影なので影響なし）
        const cameraDistance = 300; // 正投影カメラでは距離は見た目に影響しない
        const baseTargetX = 0;
        const baseTargetY = fitCenterY;
        const baseTargetZ = systemCenterZ;

        const targetX = baseTargetX;
        const targetY = targetOverride ? targetOverride.y : baseTargetY;
        const targetZ = targetOverride ? targetOverride.z : baseTargetZ;

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
        }
        
        // 強制レンダリング
        if (renderer && scene) {
            renderer.render(scene, camera);
        }
        
        
    } catch (error) {
    }
}

function setCameraForXZCrossSection(options: CameraOptions = {}) {

    try {
        const camera = options.camera || getCamera?.();
        const controls = options.controls || getControls?.();
        const scene = options.scene || getScene?.();
        const renderer = options.renderer || getRenderer?.();

        if (!camera || !controls || !scene) {
            return;
        }

        // まずシーン内の実際のオブジェクト（光線含む）のバウンディングボックスを取得
        const sceneBounds = __coopt_calculateOpticalElementsBounds(scene);
        
        // sceneBoundsが取得できた場合は、それを優先的に使用
        let fitMinZ, fitMaxZ, fitMinX, fitMaxX, fitCenterZ, fitCenterX;
        
        if (sceneBounds && !sceneBounds.isEmpty()) {
            fitMinZ = sceneBounds.min.z;
            fitMaxZ = sceneBounds.max.z;
            fitMinX = sceneBounds.min.x;
            fitMaxX = sceneBounds.max.x;
            fitCenterZ = (fitMinZ + fitMaxZ) / 2;
            fitCenterX = (fitMinX + fitMaxX) / 2;
            
            console.log('🎯 XZ Camera Fit - Scene Bounds:', {
                minZ: fitMinZ.toFixed(2),
                maxZ: fitMaxZ.toFixed(2),
                centerZ: fitCenterZ.toFixed(2),
                minX: fitMinX.toFixed(2),
                maxX: fitMaxX.toFixed(2),
                centerX: fitCenterX.toFixed(2),
                width: (fitMaxZ - fitMinZ).toFixed(2),
                height: (fitMaxX - fitMinX).toFixed(2)
            });
        } else {
            // フォールバック: 光学系データから推定
            const rangeData = calculateOpticalSystemZRange();
            if (!rangeData) {
                return;
            }
            const { minZ, maxZ, maxY } = rangeData;
            const includeRayStartMargin = options.includeRayStartMargin !== false;
            const rayStartMargin = includeRayStartMargin ? 50 : 0;
            fitMinZ = Math.min(minZ, -rayStartMargin);
            fitMaxZ = maxZ;
            fitCenterZ = (fitMinZ + fitMaxZ) / 2;
            fitCenterX = 0;
            fitMinX = -(maxY || 50);
            fitMaxX = (maxY || 50);
        }

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
        }

        const marginFactor = 1.2;
        const visibleHeight = (fitMaxX - fitMinX) * marginFactor;
        const visibleWidth = (fitMaxZ - fitMinZ) * marginFactor;

        if (camera.isOrthographicCamera) {
            const preserveRequested = options.preserveCurrentOrthoBounds === true;
            const hasReliableExtent = sceneBounds && !sceneBounds.isEmpty();
            const preserveCurrentOrthoBounds = preserveRequested && hasReliableExtent;
            if (preserveCurrentOrthoBounds) {
                expandOrthoBoundsToAspect(camera, aspect);
            } else if (preserveDrawCrossBounds) {
                camera.left = savedBounds.left;
                camera.right = savedBounds.right;
                camera.top = savedBounds.top;
                camera.bottom = savedBounds.bottom;
                expandOrthoBoundsToAspect(camera, aspect);
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

                camera.left = fitCenterZ - viewWidth;
                camera.right = fitCenterZ + viewWidth;
                camera.top = fitCenterX + viewHeight;
                camera.bottom = fitCenterX - viewHeight;
                
                console.log('📐 XZ Camera bounds set:', {
                    left: camera.left.toFixed(2),
                    right: camera.right.toFixed(2),
                    top: camera.top.toFixed(2),
                    bottom: camera.bottom.toFixed(2),
                    viewWidth: viewWidth.toFixed(2),
                    viewHeight: viewHeight.toFixed(2)
                });
            }
        }

        const cameraDistance = options.cameraDistance || 300;
        const baseTargetX = fitCenterX;
        const baseTargetY = 0;
        const baseTargetZ = targetCenterZ;

        const targetX = targetOverride ? targetOverride.x : baseTargetX;
        const targetY = baseTargetY;
        const targetZ = targetOverride ? targetOverride.z : baseTargetZ;

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

    } catch (error) {
    }
}

/**
 * Debug 3D canvas and renderer status
 */
function debug3DCanvas() {
    console.log('🖼️ Debugging 3D canvas status...');
    
    const canvasContainer = document.getElementById('threejs-canvas-container');
    const renderer = getRenderer?.();
    const scene = getScene?.();
    const camera = getCamera?.();
    const controls = getControls?.();
    const canvas = renderer?.domElement;
    
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
    
    console.log('Renderer:', !!renderer);
    if (renderer) {
        const size = renderer.getSize(new THREE.Vector2());
        console.log('Renderer size:', size.x, 'x', size.y);
    }
    
    console.log('Scene children count:', scene?.children?.length || 0);
    console.log('Camera position:', camera?.position);
    console.log('Controls target:', controls?.target);
    
    return {
        canvasContainer: !!canvasContainer,
        canvas: !!canvas,
        renderer: !!renderer,
        scene: !!scene,
        camera: !!camera,
        controls: !!controls
    };
}

// =============================================================================
// GLOBAL EXPORTS FOR BACKWARD COMPATIBILITY
// =============================================================================

// Export legacy functions to global scope
window['drawOpticalSystemSurfaceWrapper'] = drawOpticalSystemSurfaceWrapper;
window['improvedDrawOpticalSystemSurfaceWrapper'] = improvedDrawOpticalSystemSurfaceWrapper;
window['drawOptimizedRaysFromObjects'] = drawOptimizedRaysFromObjects;
window['generateRayStartPointsForObject'] = generateRayStartPointsForObject;
window['drawRayWithSegmentColors'] = drawRayWithSegmentColors;
window['setRayEmissionPattern'] = setRayEmissionPattern;
window['getRayEmissionPattern'] = getRayEmissionPattern;
window['setRayColorMode'] = setRayColorMode;
window['getRayColorMode'] = getRayColorMode;
window['forceDrawEverything'] = forceDrawEverything;
window['fitCameraToOpticalSystem'] = fitCameraToOpticalSystem;
window['setCameraForYZCrossSection'] = setCameraForYZCrossSection;
window['setCameraForXZCrossSection'] = setCameraForXZCrossSection;
window['calculateOpticalSystemZRange'] = calculateOpticalSystemZRange;
window['debug3DCanvas'] = debug3DCanvas;

// Export imported functions to global scope
window['traceRay'] = traceRay;
window['getOpticalSystemRows'] = getOpticalSystemRows;
window['getObjectRows'] = getObjectRows;
window['getSourceRows'] = getSourceRows;

// Export main functions
window['initializeApplication'] = initializeApplication;
installCooptWindowFacadeMarker();
exposeWindowValue('updateSurfaceNumberSelect', updateSurfaceNumberSelect, { overwrite: true });

// =============================================================================
// APPLICATION STARTUP
// =============================================================================

const startApplicationOnce = (() => {
    let started = false;
    return async () => {
        if (started) return;
        started = true;
        try {
            initAIAssistant();
            const appComponents = await initializeApplication();
        
            if (!appComponents) {
                throw new Error('Failed to initialize application components');
            }
        
        // Store references globally for backward compatibility
            if (appComponents) {
                setRenderingContext({
                    scene: appComponents.scene,
                    camera: appComponents.camera,
                    renderer: appComponents.renderer,
                    controls: appComponents.controls
                });
                window['ambientLight'] = appComponents.ambientLight;
                window['directionalLight'] = appComponents.directionalLight;
            } else {
            }
        
        // Store table references globally
            // window.tableOpticalSystem is owned by data/table-optical-system.ts
            window['tableObject'] = tableObject;
            window['tableSource'] = tableSource;

        // URL share load (hash: #compressed_data=...)
        // Run on next tick so other DOMContentLoaded listeners can finish too.
            setTimeout(() => {
                try {
                    Promise.resolve(loadFromCompressedDataHashIfPresent()).catch((e) => {
                    });
                } catch (e) {
                }
            }, 0);
        
        // (removed) OPD Rays drawing feature
        
        // 🔍 Objectデータデバッグボタンの設定
            const debugObjectDataBtn = document.getElementById('debug-object-data');
            if (debugObjectDataBtn) {
                debugObjectDataBtn.addEventListener('click', () => {
                
                const objectRows = window.getObjectRows ? window.getObjectRows() : [];
                const objectSelect = document.getElementById('wavefront-object-select');
                const selectedIndex = objectSelect ? parseInt(objectSelect.value) : 0;
                
                console.log(`  Object総数: ${objectRows.length}`);
                console.log(`  選択インデックス: ${selectedIndex}`);
                console.log(`  ドロップダウン存在: ${!!objectSelect}`);
                
                if (objectRows.length === 0) {
                    alert('Objectデータが読み込まれていません。JSONファイルをロードしてください。');
                    return;
                }
                
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
                
                if (window.debugOPDRayAngles) {
                    window.debugOPDRayAngles();
                } else {
                    console.log('💡 [RayAngleDebug] debug-opd-ray-angles.jsが正しく読み込まれているか確認してください');
                }
            });
        }
        
        // Draw Crossボタンのイベントリスナー
        const drawCrossBtn = document.getElementById('draw-cross-btn');
        if (drawCrossBtn) {
            drawCrossBtn.addEventListener('click', async () => {
                try {
                    
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
                    
                    
                    // システムタイプが変更された場合、より完全なクリアを実行
                    if (systemTypeChanged) {
                        // レンダラーとシーンを完全にクリア
                        const renderer = getRenderer?.();
                        const scene = getScene?.();
                        if (renderer) {
                            renderer.clear();
                        }
                        if (scene) {
                            // より厳密なクリア：すべての子要素を削除
                            const allChildren = [...scene.children];
                            allChildren.forEach(child => {
                                scene.remove(child);
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
                    setLastSystemType(currentSystemType);
                    
                    if (isInfiniteSystem) {
                    } else {
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
                    
                    
                    // 評価面の選択値を取得
                    const transverseSurfaceSelect = document.getElementById('transverse-surface-select');
                    let targetSurfaceIndex = null;
                    if (transverseSurfaceSelect && transverseSurfaceSelect.value !== '') {
                        targetSurfaceIndex = parseInt(transverseSurfaceSelect.value) - 1; // 1-based to 0-based
                    } else {
                        const imageSurfaceIndex = opticalSystemRows.findIndex(row =>
                            row && (row['object type'] === 'Image' || row.object === 'Image')
                        );
                        targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);
                    }
                    
                    // Object Thicknessに基づいて適切な関数を選択
                    let crossBeamResult;
                    const primaryWavelength = (typeof window.getPrimaryWavelength === 'function')
                        ? Number(window.getPrimaryWavelength()) || 0.5876
                        : 0.5876;
                    if (isInfiniteSystem) {
                        // 無限系の場合、objectPositionsを角度形式に変換
                        const objectAngles = allObjectPositions.map(pos => ({
                            x: pos.x || 0,  // 角度として扱う
                            y: pos.y || 0   // 角度として扱う
                        }));
                        
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
                    
                    
                    // 戻り値の構造を確認して適切にアクセス
                    let allRays = [];
                    let processedCount = 0;
                    let totalCount = 0;
                    
                    if (crossBeamResult.results && Array.isArray(crossBeamResult.results)) {
                        // results配列がある場合
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
                        allRays = crossBeamResult.allCrossBeamRays;
                        processedCount = crossBeamResult.processedObjectCount || 0;
                        totalCount = crossBeamResult.objectCount || 0;
                    } else if (crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)) {
                        // allTracedRays配列のみ（フォールバック）
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
                    
                    const scene = getScene?.();

                    // 既存の光学要素と光線をクリア
                    if (scene) {
                        clearAllOpticalElements(scene);
                    }
                    
                    // 光学系の描画（レンズリング表示を含む）
                    // クロスビーム描画時はレンズのリング表示をオフにして、円環状の見かけを防ぐ
                    drawOpticalSystemSurfaces({
                        opticalSystemData: opticalSystemRows,
                        scene: scene || (document as any).scene,
                        showSemidiaRing: true,  // 要望: セミダイアリングを表示
                        showSurfaceOrigins: false,  // 表面の原点は表示しない
                        crossSectionOnly: false  // 断面のみではなく、完全な3D表示
                    });
                    
                    // カメラをY-Z断面の正面に設定（Draw Crossに最適化）
                    setCameraForYZCrossSection();
                    
                    // 複数Object対応クロスビームの描画
                    if (allRays.length > 0) {
                        const objectDistribution = {};
                        allRays.forEach(ray => {
                            const objIndex = ray.objectIndex || 0;
                            objectDistribution[objIndex] = (objectDistribution[objIndex] || 0) + 1;
                        });
                        console.log(`   Object分布:`, objectDistribution);
                        
                        const successfulCrossRays = allRays.filter(ray => ray && ray.success && Array.isArray(ray.rayPath) && ray.rayPath.length > 0);
                        setCurrentDrawCrossRays(successfulCrossRays.map(ray => ({
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
                        })));
                        console.log('Stored draw-cross rays for overlay:', window.currentDrawCrossRays.length);
                        
                        drawCrossBeamRays(allRays, scene);
                    } else {
                        setCurrentDrawCrossRays([]);
                    }
                    
                    // 結果をグローバルに保存
                    window['crossBeamResult'] = crossBeamResult;
                    window['lastGeneratedRays'] = allRays;
                    
                    // Image面のSemi Diaを主光線の最大高さで更新（optimizeSemiDiaが"U"の場合）
                    updateImageSemiDiaFromChiefRays(allRays, opticalSystemRows);
                    
                    // 絞り周辺光線を追加 - 停止中
                    /*
                    try {
                        const currentSystem = getCurrentOpticalSystem();
                        if (currentSystem && currentSystem.length > 0) {
                            // 軸上の点（デフォルトフィールド設定）を使用
                            const fieldSetting = { x: 0, y: 0, displayName: "On-axis" };
                            const marginalRays = calculateAllMarginalRays(currentSystem, fieldSetting, 0.5876); // opticalSystem, fieldSetting, wavelength
                            drawMarginalRays(marginalRays, currentSystem);
                        }
                    } catch (marginalError) {
                        // 絞り周辺光線のエラーは致命的ではないので続行
                    }
                    */
                    
                    
                } catch (error) {
                    alert(`クロスビーム描画エラー: ${error.message}`);
                } finally {
                    // ボタンを再有効化
                    drawCrossBtn.disabled = false;
                    drawCrossBtn.textContent = 'Draw Cross';
                }
            });
        }

        // =============================================================================
        // UNDO/REDO SYSTEM SETUP
        // =============================================================================
        
        // Setup Undo/Redo button handlers
        const undoBtn = document.getElementById('undo-btn');
        const redoBtn = document.getElementById('redo-btn');
        
        console.log('[Init] Setting up Undo/Redo buttons:', { undoBtn: !!undoBtn, redoBtn: !!redoBtn });

        if (undoBtn) {
            undoBtn.addEventListener('click', () => {
                console.log('[Undo] Undo button clicked');
                if (window.undoHistory) {
                    const success = window.undoHistory.undo();
                    if (success) {
                    }
                } else {
                    console.error('[Undo] window.undoHistory not found');
                }
            });
        } else {
            console.warn('[Undo] undo-btn not found');
        }

        if (redoBtn) {
            redoBtn.addEventListener('click', () => {
                console.log('[Undo] Redo button clicked');
                if (window.undoHistory) {
                    const success = window.undoHistory.redo();
                    if (success) {
                    }
                } else {
                    console.error('[Undo] window.undoHistory not found');
                }
            });
        } else {
            console.warn('[Undo] redo-btn not found');
        }

        console.log('[Undo] Button handlers registered');
        
        // Setup Toolbar Toggle button
        const toggleToolbarBtn = document.getElementById('toggle-toolbar-btn');
        const topButtonsRow = document.getElementById('top-buttons-row');
        
        const isReactHandled = toggleToolbarBtn?.getAttribute('data-toggle-handled') === 'react';
        if (toggleToolbarBtn && topButtonsRow && !isReactHandled) {
            toggleToolbarBtn.addEventListener('click', () => {
                const isCollapsed = topButtonsRow.classList.toggle('collapsed');
                toggleToolbarBtn.classList.toggle('collapsed', isCollapsed);
                // Save state to localStorage
                setToolbarCollapsed(isCollapsed);
            });
            
            // Restore state from localStorage
            if (getToolbarCollapsed()) {
                topButtonsRow.classList.add('collapsed');
                toggleToolbarBtn.classList.add('collapsed');
            }
        }
        
        } catch (error) {
            alert(`Failed to initialize application: ${error.message}`);
        }
    };
})();

const scheduleApplicationStart = () => {
    const hasReactRoot = !!document.getElementById('react-root');
    if (hasReactRoot) {
        if (window.__cooptReactMounted) {
            console.log('🚀 [Init] React already mounted, starting immediately');
            startApplicationOnce();
            return;
        }
        console.log('🚀 [Init] Waiting for React to mount...');
        window.addEventListener('coopt:react-mounted', () => {
            console.log('🚀 [Init] Received coopt:react-mounted event');
            startApplicationOnce();
        }, { once: true });
        
        // Fallback: If React hasn't fired the event within 2 seconds, start anyway
        setTimeout(() => {
            if (!window.__cooptReactMounted) {
                console.warn('⚠️ [Init] React mount event timeout, starting anyway');
                startApplicationOnce();
            }
        }, 2000);
    } else {
        console.log('🚀 [Init] No React root found, starting immediately');
        startApplicationOnce();
    }
};

if (typeof document !== 'undefined' && document?.addEventListener) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scheduleApplicationStart);
    } else {
        scheduleApplicationStart();
    }
}

// =============================================================================
// EXPORT MAIN FUNCTIONS FOR MODULE USAGE
// =============================================================================

export {
    initializeApplication,
    drawOpticalSystemSurfaceWrapper,
    improvedDrawOpticalSystemSurfaceWrapper,
    drawOptimizedRaysFromObjects,
    getWASMSystem
};

/**
 * Draw cross beam rays in the 3D scene (複数Object対応)
 */
function drawCrossBeamRays(tracedRays, targetScene) {
    // Prefer explicit scene; fall back to app-config getter
    const scene = targetScene || getScene?.();
    
    
    if (!tracedRays || tracedRays.length === 0) {
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
            return false;
        }
        if (r.fallback) {
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
            return false; // 描画をスキップ
        }
        return true;
    });
    if (filteredRays.length !== tracedRays.length) {
    }
    const fallbackCount = filteredRays.filter(r => r.fallback).length;
    if (fallbackCount > 0) {
    }
    tracedRays = filteredRays;

    if (!scene) {
        return;
    }
    
    try {
        // Object毎の光線数を集計
        const objectRayCount = {};
        tracedRays.forEach(rayData => {
            const objIndex = rayData.objectIndex || 0;
            objectRayCount[objIndex] = (objectRayCount[objIndex] || 0) + 1;
        });
        
        
        // 全ての光線を描画
        tracedRays.forEach((rayData, index) => {
            if (!rayData.success) {
                return;
            }
            
            const rayPath = rayData.rayPath;
            if (!rayPath || rayPath.length === 0) {
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
                rayColor = colorSystem.getColor(colorSystem.MODE.OBJECT, objectIndex, null);
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
        
        console.log(`   処理Object数: ${Object.keys(objectRayCount).length}`);
        
    } catch (error) {
    }
}

// drawCrossBeamRays関数をグローバルに公開
window['drawCrossBeamRays'] = drawCrossBeamRays;

// generateInfiniteSystemCrossBeam関数をグローバルに公開
window['generateInfiniteSystemCrossBeam'] = generateInfiniteSystemCrossBeam;

// generateCrossBeam関数（有限系用）をグローバルに公開
window['generateCrossBeam'] = generateCrossBeam;

// drawOpticalSystemSurfaces関数をグローバルに公開
window['drawOpticalSystemSurfaces'] = drawOpticalSystemSurfaces;

// =============================================================================
// DEBUGGING EXPORTS - グローバルスコープに関数を公開
// =============================================================================

window['calculateChiefRayNewton'] = calculateChiefRayNewton;
window['findStopSurface'] = findStopSurface;

// 光学系判定関数を公開（gen-ray-cross-finite.jsから）
window['isFiniteSystem'] = function(opticalSystemRows) {
    // 最初の面の厚さが有限であれば有限系
    if (opticalSystemRows && opticalSystemRows.length > 0) {
        const firstSurface = opticalSystemRows[0];
        const thickness = firstSurface.thickness;
        
        // 文字列'INF'またはInfinity値の場合は無限系
        if (thickness === 'INF' || thickness === Infinity) {
            return false; // 無限系
        }
        
        // 数値に変換して有限かつ正の値であれば有限系
        const numThickness = parseFloat(thickness);
        const isFiniteLocal = Number.isFinite(numThickness) && numThickness > 0;
        
        return isFiniteLocal;
    }
    return false;
};

// Distortion functions global expose
// window.calculateDistortionData is owned by evaluation/aberrations/distortion.ts
// window.plotDistortionPercent / window.generateDistortionPlots / window.plotGridDistortion /
// window.generateGridDistortionPlot are owned by evaluation/aberrations/distortion-plot.ts

// グローバルスコープへの公開用変数をまとめて定義
window['mainDebugFunctions'] = {
    generateCrossBeam,
    calculateChiefRayNewton,
    traceRay,
    findStopSurface,
    calculateSurfaceOrigins,
    isFiniteSystem: window.isFiniteSystem
};

// Distortion helpers
window['mainDebugFunctions'].generateDistortionPlots = generateDistortionPlots;
window['mainDebugFunctions'].calculateDistortionData = calculateDistortionData;

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
        
        
        return {
            fieldAngle: { x: angleX, y: angleY },
            fieldType: 'Angle',
            displayName: `Object ${index + 1} - ${angleX}°, ${angleY}°`
        };
    } else {
        // 高さの場合も同様に実際のプロパティ名を使用
        const heightX = parseFloat(objectData.xHeight || objectData.X || objectData.x || 0);
        const heightY = parseFloat(objectData.yHeight || objectData.Y || objectData.y || 0);
        
        
        return {
            xHeight: heightX,
            yHeight: heightY,
            fieldType: 'Rectangle',
            displayName: `Object ${index + 1} - ${heightX}mm, ${heightY}mm`
        };
    }
}

// グローバルスコープに公開
window['convertObjectToFieldSetting'] = convertObjectToFieldSetting;

// 絞り周辺光線の描画関数
function drawMarginalRays(marginalRaysData: any, opticalSystem: any) {
    const scene = getScene?.();
    if (!marginalRaysData || !scene) {
        return;
    }

    // marginalRaysDataの構造を確認し、適切なデータを取得
    const marginalRays = marginalRaysData.marginalRays || marginalRaysData;

    // 要望: X-Z(水平:左右) も Y-Z(上下) と同じ青で表示する
    const rayColors: Record<string, number> = {
        up: 0x0000ff,    // 青
        down: 0x0000ff,  // 青
        left: 0x0000ff,  // 青
        right: 0x0000ff  // 青
    };


    Object.entries(marginalRays).forEach(([direction, rayData]: [string, any]) => {
        if (!rayData || !rayData.success || !rayData.surfacePoints) {
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
        
        scene.add(rayLine);
    });
}

// 現在の光学系を取得する関数
function getCurrentOpticalSystem() {
    return getOpticalSystemRows();
}

// Export WASM system for use in other modules
function getWASMSystem() {
    return wasmSystem;
}

// Note: getWASMSystem/_setWASMSystem globals are installed by core/wasm-service.ts

// =============================================================================
// ANALYSIS DROPDOWN HANDLER
// =============================================================================

// Setup analysis dropdown to trigger existing button handlers
const analysisSelect = document.getElementById('analysis-select');
if (analysisSelect) {
    analysisSelect.addEventListener('change', (e) => {
        const target = e.target as HTMLSelectElement;
        const value = target.value;
        if (!value) return;
        
        // Map dropdown values to existing button IDs
        const buttonMap: Record<string, string> = {
            'spot-diagram': 'open-spot-diagram-window-btn',
            'spherical-aberration': 'open-spherical-aberration-window-btn',
            'astigmatism': 'open-astigmatism-window-btn',
            'distortion': 'open-distortion-window-btn',
            'integrated-aberration': 'open-integrated-aberration-window-btn',
            'transverse-aberration': 'open-transverse-aberration-window-btn',
            'opd': 'open-opd-window-btn',
            'psf': 'open-psf-window-btn',
            'mtf': 'open-mtf-window-btn'
        };
        
        const btnId = buttonMap[value];
        if (btnId) {
            const btn = document.getElementById(btnId);
            if (btn) {
                btn.click();
            }
        }
        
        // Reset dropdown to placeholder
        target.value = '';
    });
}

// Setup keyboard shortcuts for Undo/Redo
document.addEventListener('keydown', (e) => {
    // Check if we're in an input field - don't intercept undo in text inputs
    const activeElement = document.activeElement;
    const isInInput = activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        (activeElement as any).isContentEditable
    );
    
    // Ctrl+Z / Cmd+Z for Undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey && !isInInput) {
        e.preventDefault();
        if (window.undoHistory) {
            window.undoHistory.undo();
        }
    }
    
    // Ctrl+Y / Cmd+Shift+Z for Redo
    if (!isInInput && (
        ((e.ctrlKey || e.metaKey) && e.key === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z')
    )) {
        e.preventDefault();
        if (window.undoHistory) {
            window.undoHistory.redo();
        }
    }
});

// Clear undo history on configuration switch, import, or load
function clearUndoHistoryOnMajorChange(reason) {
    if (window.undoHistory) {
        window.undoHistory.clear();
        console.log(`[Undo] History cleared: ${reason}`);
    }
}

// Export for use in other modules
window['clearUndoHistoryOnMajorChange'] = clearUndoHistoryOnMajorChange;