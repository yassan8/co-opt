/**
 * JS_lensDraw v3 - Main Application Entry Point (Refactored)
 * 
 * This file serves as the main entry point of the application. 
 * It initializes the application using modular components and sets up the main functionality.
 */

// ⚠️ MTF Console Filter - TEMPORARILY DISABLED FOR DEBUGGING
// (() => {
//     const globalScope = globalThis as any;
//     if (globalScope.__mtfOnlyConsoleFilterInstalled) return;
//     globalScope.__mtfOnlyConsoleFilterInstalled = true;

//     const methods: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = ['log', 'info', 'warn', 'error', 'debug'];
//     const originalConsole: Partial<Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: any[]) => void>> = {};

//     const containsMTF = (value: unknown, depth = 0): boolean => {
//         try {
//             if (depth > 2 || value == null) return false;
//             if (typeof value === 'string') return /mtf/i.test(value);
//             if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') return false;
//             if (value instanceof Error) return /mtf/i.test(`${value.message || ''} ${value.stack || ''}`);
//             if (Array.isArray(value)) return value.some(v => containsMTF(v, depth + 1));
//             if (typeof value === 'object') {
//                 if (Object.prototype.toString.call(value) !== '[object Object]') {
//                     return false;
//                 }
//                 const obj = value as Record<string, unknown>;
//                 for (const key in obj) {
//                     if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
//                     if (/mtf/i.test(key)) return true;
//                     const val = obj[key];
//                     if (typeof val === 'string' && /mtf/i.test(val)) return true;
//                     if (depth < 2 && containsMTF(val, depth + 1)) return true;
//                 }
//             }
//             return false;
//         } catch {
//             return false;
//         }
//     };

//     const shouldAllow = (args: unknown[]): boolean => {
//         try {
//             return args.some(arg => containsMTF(arg));
//         } catch {
//             return false;
//         }
//     };

//     for (const method of methods) {
//         const original = console[method].bind(console);
//         originalConsole[method] = original;
//         console[method] = (...args: any[]) => {
//             try {
//                 if (shouldAllow(args)) {
//                     original(...args);
//                 }
//             } catch {
//             }
//         };
//     }

//     globalScope.__mtfOriginalConsole = originalConsole;
// })();

// Restore console methods if a wrapper muted logs (e.g., injected debug gate).
(() => {
    const globalScope = globalThis as any;
    if (globalScope.__cooptConsoleRestoreApplied) return;
    globalScope.__cooptConsoleRestoreApplied = true;

    try {
        if (typeof globalScope.isDebugEnabled === 'function') {
            globalScope.isDebugEnabled = () => true;
        }
        const proto = Object.getPrototypeOf(console);
        if (!proto) return;
        const methods: Array<'log' | 'info' | 'warn' | 'debug'> = ['log', 'info', 'warn', 'debug'];
        for (const method of methods) {
            const current = console[method];
            const nativeFn = proto[method];
            if (typeof nativeFn !== 'function') continue;
            const source = Function.prototype.toString.call(current);
            if (source.includes('isDebugEnabled')) {
                console[method] = nativeFn.bind(console);
            }
        }
    } catch {
    }
})();

(() => {
    try {
        const globalScope = globalThis as any;
        if (typeof globalScope.__COOPT_FORCE_RUST_WASM_OPD === 'undefined') {
            globalScope.__COOPT_FORCE_RUST_WASM_OPD = true;
        }

        // Web default: prefer/require Rust-WASM analysis paths unless explicitly overridden.
        const isDesktopRuntime = !!(globalScope && globalScope.__TAURI_INTERNALS__);
        if (!isDesktopRuntime) {
            if (typeof globalScope.__COOPT_ENABLE_RUST_RAYTRACE_WEB === 'undefined') {
                globalScope.__COOPT_ENABLE_RUST_RAYTRACE_WEB = true;
            }
            if (typeof globalScope.__COOPT_REQUIRE_RUST_WASM_ANALYSIS === 'undefined') {
                globalScope.__COOPT_REQUIRE_RUST_WASM_ANALYSIS = true;
            }
        }
    } catch {
        // ignore
    }
})();

// =============================================================================
// IMPORTS
// =============================================================================

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
import { calculateFocalLength, calculateBackFocalLength, calculateImageDistance, calculateEntrancePupilDiameter, calculateExitPupilDiameter, calculateFullSystemParaxialTrace, calculateParaxialData, debugParaxialRayTrace, calculatePupilsByNewSpec, findStopSurfaceIndex, calculateImageSpaceDiffractionParams } from './raytracing/core/ray-paraxial.ts';

// Marginal ray modules
import { calculateAdaptiveMarginalRay, calculateAllMarginalRays } from './raytracing/core/ray-marginal.ts';

// Analysis modules
import { derivePupilAndFocalLengthMmFromParaxial, generateSpotDiagram, drawSpotDiagram, generateSurfaceOptions } from './evaluation/spot-diagram.ts';
import { calculateTransverseAberration, getFieldAnglesFromSource, getPrimaryWavelengthForAberration, validateAberrationData, calculateChiefRayNewton, getEstimatedEntrancePupilDiameter } from './evaluation/aberrations/transverse-aberration.ts';
import { plotTransverseAberrationDiagram, showTransverseAberrationInNewWindow } from './evaluation/aberrations/transverse-aberration-plot.ts';
import { showWavefrontDiagram } from './evaluation/wavefront/wavefront-plot.ts';
import { OpticalPathDifferenceCalculator, WavefrontAberrationAnalyzer, createOPDCalculator, createWavefrontAnalyzer } from './evaluation/wavefront/wavefront.ts';
import { runOPDProfiling } from './evaluation/wavefront/opd-profiler.ts'; // ✅ OPD profiling functions
import { PSFCalculator } from './evaluation/psf/psf-calculator.ts';
import { PSFPlotter, PSFDisplayManager } from './evaluation/psf/psf-plot.ts';
import { showMTFDiagram, showThroughFocusMTFDiagram, showFieldMTFDiagram, showMTFComparisonDiagram } from './evaluation/mtf-plot.ts';
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
import { updateWavefrontObjectSelect, initializeWavefrontObjectUI, initializePSFObjectUI, debugResetObjectTable } from './ui/wavefront-object-select.ts';
import { initializeConfigurationUI } from './ui/configuration-handlers.ts';
import { getActiveConfiguration } from './data/table-configuration.ts';
import { expandBlocksToOpticalSystemRows } from './data/block-schema.ts';
import { exposeWindowValue, installCooptWindowFacadeMarker, requestRefreshBlockInspector, requestUpdateSurfaceNumberSelect } from './core/window-facade.ts';
import { setRenderingContext } from './core/rendering-context.ts';
import { setRayTracingWasmStrict, setPsfWasmStrict } from './core/wasm-service.ts';
import { preloadRustRayTracingWasm, getRustRayTracingWasmInitError } from './rust-wasm/ts/raytracing/rust-raytracing-wasm.ts';
import { isTauriRuntime } from './src/desktop/runtime.ts';
import { getDefaultProject } from './src/desktop/ipc/client.ts';

// Editor modules (must be imported to initialize)
import './ui/editors/system-requirements-editor.ts';
import './ui/editors/merit-function-editor.ts';



// Suggest (Design Intent) implementation (adds window.SuggestDesignIntent)
import './optimization/suggest-design-intent.ts';

// Benchmark tools (must be imported to initialize)
import './tools/benchmark-tfmtf.ts';

// Analysis modules
import { clearAllDrawing, showSpotDiagram, showThroughFocusSpotDiagram, showTransverseAberrationDiagram, showLongitudinalAberrationDiagram, showAstigmatismDiagram, showIntegratedAberrationDiagram, showMagnificationChromaticAberrationDiagram, outputChiefRayConvergenceData, calculateSceneBounds, fitCameraToScene, runSpotParityDiagnostics } from './analysis/optical-analysis.ts';

// Performance monitoring (削除されたファイルなのでコメントアウト)
// import { performanceMonitor } from './performance-monitor.ts';

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

// Global WASM system instance
let wasmSystem = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getPhaseCAutorunSearchParams(): URLSearchParams | null {
    try {
        if (typeof window === 'undefined' || !window.location) return null;
        return new URL(window.location.href).searchParams;
    } catch {
        return null;
    }
}

function readBooleanQueryParam(params: URLSearchParams | null, key: string, fallback = false): boolean {
    try {
        if (!params || !params.has(key)) return fallback;
        const raw = String(params.get(key) ?? '').trim().toLowerCase();
        if (!raw) return true;
        if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
        if (['0', 'false', 'no', 'off'].includes(raw)) return false;
        return fallback;
    } catch {
        return fallback;
    }
}

function readNumberQueryParam(
    params: URLSearchParams | null,
    key: string,
    fallback: number,
    options: { integer?: boolean; min?: number; max?: number } = {}
): number {
    try {
        if (!params || !params.has(key)) return fallback;
        const raw = Number(params.get(key));
        if (!Number.isFinite(raw)) return fallback;
        let value = options.integer ? Math.floor(raw) : raw;
        if (Number.isFinite(options.min)) value = Math.max(options.min as number, value);
        if (Number.isFinite(options.max)) value = Math.min(options.max as number, value);
        return value;
    } catch {
        return fallback;
    }
}

function publishPhaseCAutorunStatus(status: Record<string, unknown>): void {
    try {
        if (typeof window !== 'undefined') {
            window['__cooptPhaseCAutorunStatus'] = status;
            window.dispatchEvent(new CustomEvent('coopt:phasec-autorun-status', { detail: status }));
        }
    } catch (_) {}
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('coopt.phaseCAutorunStatus', JSON.stringify(status));
        }
    } catch (_) {}
    try {
        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.dataset.phasecAutorunState = String(status?.state ?? 'unknown');
        }
    } catch (_) {}
}

async function waitForWindowValue<T>(
    label: string,
    getter: () => T | null | undefined,
    timeoutMs = 10000,
    intervalMs = 50
): Promise<T> {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
        const value = getter();
        if (value) return value;
        await sleep(intervalMs);
    }
    throw new Error(`${label} was not ready within ${timeoutMs}ms`);
}

async function waitForPhaseCAutorunLoadSettled(timeoutMs = 2000): Promise<void> {
    try {
        await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                try { window.removeEventListener('coopt:loaded-file-updated', onLoaded); } catch (_) {}
                try { clearTimeout(timer); } catch (_) {}
                resolve();
            };
            const onLoaded = () => finish();
            const timer = setTimeout(() => finish(), timeoutMs);
            window.addEventListener('coopt:loaded-file-updated', onLoaded, { once: true });
        });
    } catch {
        await sleep(250);
    }
    await sleep(250);
}

async function loadDefaultProjectForPhaseCAutorun(): Promise<void> {
    const loadIntoApp = await waitForWindowValue<any>(
        '__loadAllDataObjectIntoApp',
        () => (typeof window !== 'undefined' ? (window as any).__loadAllDataObjectIntoApp : null),
        10000,
        50
    );

    if (isTauriRuntime()) {
        const { project } = await getDefaultProject();
        await loadIntoApp(project, { filename: 'default-load.json' });
        await waitForPhaseCAutorunLoadSettled();
        return;
    }

    let response = await fetch('/co-opt/defaults/default-load.json');
    if (!response.ok) {
        response = await fetch('/defaults/default-load.json');
    }
    if (!response.ok) {
        throw new Error(`Failed to load default system: ${response.statusText}`);
    }
    const project = await response.json();
    await loadIntoApp(project, { filename: 'default-load.json' });
    await waitForPhaseCAutorunLoadSettled();
}

async function runPhaseCAutorunFromUrl(): Promise<void> {
    try {
        if (typeof window === 'undefined') return;
        if ((window as any).__cooptPhaseCAutorunStarted) return;

        const params = getPhaseCAutorunSearchParams();
        const enabled = readBooleanQueryParam(params, 'phasec', false)
            || readBooleanQueryParam(params, 'phasecAutorun', false);
        if (!enabled) return;

        (window as any).__cooptPhaseCAutorunStarted = true;
        const startedAt = new Date().toISOString();
        publishPhaseCAutorunStatus({ state: 'starting', startedAt });

        if (readBooleanQueryParam(params, 'phasecLoadDefault', true)) {
            publishPhaseCAutorunStatus({ state: 'loading-default', startedAt });
            await loadDefaultProjectForPhaseCAutorun();
        }

        const exportMatrixFreeJson = await waitForWindowValue<any>(
            'OptimizationMVP.exportMatrixFreeJson',
            () => (window as any)?.OptimizationMVP?.exportMatrixFreeJson,
            10000,
            50
        );

        const options: Record<string, unknown> = {
            repeat: readNumberQueryParam(params, 'phasecRepeat', 6, { integer: true, min: 1 }),
            warmupDiscard: readNumberQueryParam(params, 'phasecWarmupDiscard', 1, { integer: true, min: 0 }),
            filterOutliers: readBooleanQueryParam(params, 'phasecFilterOutliers', true),
            matchBaselineBestStop: readBooleanQueryParam(params, 'phasecMatchBaselineBestStop', true),
            matchBaselineBestMinIter: readNumberQueryParam(params, 'phasecMatchBaselineBestMinIter', 8, { integer: true, min: 0 }),
            download: readBooleanQueryParam(params, 'phasecDownload', true)
        };

        const fileName = params?.get('phasecFileName');
        if (fileName) options.fileName = fileName;
        const method = params?.get('phasecMethod');
        if (method) options.method = method;
        if (params?.has('phasecMaxIter')) {
            options.maxIter = readNumberQueryParam(params, 'phasecMaxIter', 0, { integer: true, min: 1 });
        }
        if (params?.has('phasecMatchBaselineBestRelTol')) {
            options.matchBaselineBestRelTol = readNumberQueryParam(params, 'phasecMatchBaselineBestRelTol', 0, { min: 0 });
        }
        if (params?.has('phasecMatchBaselineBestAbsTol')) {
            options.matchBaselineBestAbsTol = readNumberQueryParam(params, 'phasecMatchBaselineBestAbsTol', 0, { min: 0 });
        }

        publishPhaseCAutorunStatus({ state: 'running', startedAt, options });
        const result = await exportMatrixFreeJson(options);
        try {
            (window as any).__cooptPhaseCAutorunResult = result;
        } catch (_) {}
        try {
            if (typeof localStorage !== 'undefined' && result?.summary) {
                localStorage.setItem('coopt.phaseCLastSummary', JSON.stringify(result.summary));
            }
        } catch (_) {}

        publishPhaseCAutorunStatus({
            state: 'done',
            startedAt,
            completedAt: new Date().toISOString(),
            selectedMode: result?.summary?.phaseC?.selectedMode ?? null,
            elapsedSpeedup: result?.summary?.phaseC?.elapsedSpeedup ?? null,
            fileName: fileName || null
        });
    } catch (error) {
        const message = (error instanceof Error) ? error.message : String(error);
        console.error('❌ [PhaseC Autorun] Failed:', error);
        publishPhaseCAutorunStatus({
            state: 'error',
            completedAt: new Date().toISOString(),
            error: message
        });
    }
}

// Note: getWASMSystem/_setWASMSystem globals are installed by core/wasm-service.ts (index.html <head>).
// main.ts only updates the instance via window._setWASMSystem once WASM is ready.

// =============================================================================
// MAIN APPLICATION INITIALIZATION
// =============================================================================

/**
 * Initialize the main application
 */
async function initializeApplication() {
    try {
        // WASM strict defaults are enabled; can be overridden from DevTools globals.
        try {
            const g = globalThis as any;
            const rayStrict = (typeof g.__COOPT_RAYTRACE_WASM_STRICT === 'boolean')
                ? g.__COOPT_RAYTRACE_WASM_STRICT
                : true;
            const psfStrict = (typeof g.__COOPT_PSF_WASM_STRICT === 'boolean')
                ? g.__COOPT_PSF_WASM_STRICT
                : true;
            setRayTracingWasmStrict(rayStrict);
            setPsfWasmStrict(psfStrict);
            g.__COOPT_RAYTRACE_WASM_STRICT = rayStrict;
            g.__COOPT_PSF_WASM_STRICT = psfStrict;
            console.log('🔒 [Init] WASM strict mode', { rayStrict, psfStrict });
        } catch (_) {
            // ignore strict bootstrap errors and continue initialization
        }

        // Initialize WASM system (non-blocking - run in background)
        const wasmInitPromise = (async () => {
            try {
                const rustApi = await preloadRustRayTracingWasm();
                if (!rustApi) {
                    const initError = getRustRayTracingWasmInitError?.();
                    if (initError) {
                        console.warn('⚠️ [Init] Rust-WASM preload failed:', initError);
                    }
                    return;
                }

                wasmSystem = {
                    backend: 'rust-wasm',
                    isWASMReady: true,
                    api: rustApi
                };
                console.log('🔧 [Init] Rust-WASM backend is ready');
                
                // Update the global reference immediately
                if (typeof window !== 'undefined' && typeof window._setWASMSystem === 'function') {
                    window._setWASMSystem(wasmSystem);
                    console.log('🔧 [Init] window._setWASMSystemでインスタンスを更新しました');
                }

                console.log('✅ [Init] Rust-WASM初期化が完了しました');
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

        // PSF Object選択UI初期化
        try {
            initializePSFObjectUI();
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
                if (window.updatePSFObjectOptions) {
                    window.updatePSFObjectOptions();
                }
            } catch (error) {
            }
            
            // (removed) OPD Rays drawing feature
        }, 1000);
        
        // Export functions to global scope for debugging
        // debugSceneContents global export removed (debug-utils.ts deleted)
        // legacy debug camera helper export removed (debug-utils.ts deleted)
        // showSceneBoundingBox global export removed (debug-utils.ts deleted)
        window['refreshBlockInspector'] = refreshBlockInspector;
        window['loadSystemConfigurations'] = loadSystemConfigurations;
        window['saveSystemConfigurations'] = saveSystemConfigurations;
        window['fitCameraToScene'] = fitCameraToScene;
        window['clearAllDrawing'] = clearAllDrawing;
        window['showSpotDiagram'] = showSpotDiagram;
        window['showTransverseAberrationDiagram'] = showTransverseAberrationDiagram;
        window['showTransverseAberration'] = async () => {
            const transverseRayCountInput = document.getElementById('transverse-ray-count-input') as HTMLInputElement | null;
            let rayCount = 51;
            if (transverseRayCountInput && transverseRayCountInput.value !== '') {
                const inputValue = parseInt(transverseRayCountInput.value, 10);
                if (!isNaN(inputValue) && inputValue > 0) {
                    rayCount = inputValue;
                }
            }
            rayCount = Math.max(9, Math.min(10001, Math.round(rayCount)));
            await showTransverseAberrationDiagram({ rayCount });
        };
        window['showLongitudinalAberrationDiagram'] = showLongitudinalAberrationDiagram;
        window['showMagnificationChromaticAberrationDiagram'] = showMagnificationChromaticAberrationDiagram;
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
        window['compareOpdNativeVsWasm'] = async (options: any = {}) => {
            const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
                ? () => performance.now()
                : () => Date.now();

            const toStats = (values: number[]) => {
                const finite = values.filter((v) => Number.isFinite(v));
                if (!finite.length) {
                    return { count: 0, rms: NaN, peakToPeak: NaN, min: NaN, max: NaN };
                }
                let sumSq = 0;
                let min = Infinity;
                let max = -Infinity;
                for (const v of finite) {
                    sumSq += v * v;
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
                return {
                    count: finite.length,
                    rms: Math.sqrt(sumSq / finite.length),
                    peakToPeak: max - min,
                    min,
                    max
                };
            };

            const flattenGrid = (grid: any) => {
                const out: number[] = [];
                if (!Array.isArray(grid)) return out;
                for (const row of grid) {
                    if (!Array.isArray(row)) continue;
                    for (const v of row) {
                        if (v === null || v === undefined) continue;
                        const n = Number(v);
                        if (Number.isFinite(n)) out.push(n);
                    }
                }
                return out;
            };

            const computeOpdRmsWaves = (opd: Float32Array[] | number[][], mask: boolean[][], wavelengthUm: number) => {
                if (!Array.isArray(opd) || !Array.isArray(mask) || !Number.isFinite(wavelengthUm) || wavelengthUm <= 0) {
                    return { validCount: 0, meanUm: NaN, rmsUm: NaN, rmsWaves: NaN, marechalStrehl: NaN };
                }
                let count = 0;
                let sum = 0;
                for (let iy = 0; iy < opd.length; iy++) {
                    const row = opd[iy] as any;
                    const mrow = mask[iy] as any;
                    if (!row || !mrow) continue;
                    const w = Math.min(row.length || 0, mrow.length || 0);
                    for (let ix = 0; ix < w; ix++) {
                        if (!mrow[ix]) continue;
                        const v = Number(row[ix]);
                        if (!Number.isFinite(v)) continue;
                        sum += v;
                        count += 1;
                    }
                }
                if (count <= 0) {
                    return { validCount: 0, meanUm: NaN, rmsUm: NaN, rmsWaves: NaN, marechalStrehl: NaN };
                }
                const meanUm = sum / count;
                let sumSq = 0;
                for (let iy = 0; iy < opd.length; iy++) {
                    const row = opd[iy] as any;
                    const mrow = mask[iy] as any;
                    if (!row || !mrow) continue;
                    const w = Math.min(row.length || 0, mrow.length || 0);
                    for (let ix = 0; ix < w; ix++) {
                        if (!mrow[ix]) continue;
                        const v = Number(row[ix]);
                        if (!Number.isFinite(v)) continue;
                        const d = v - meanUm;
                        sumSq += d * d;
                    }
                }
                const rmsUm = Math.sqrt(sumSq / count);
                const rmsWaves = rmsUm / wavelengthUm;
                const marechalStrehl = Math.exp(-Math.pow(2 * Math.PI * rmsWaves, 2));
                return {
                    validCount: count,
                    meanUm,
                    rmsUm,
                    rmsWaves,
                    marechalStrehl: Number.isFinite(marechalStrehl) ? Math.max(0, Math.min(1, marechalStrehl)) : NaN,
                };
            };

            const opticalSystemRows = getOpticalSystemRows();
            const objectRows = getObjectRows();
            const sourceRows = getSourceRows(tableSource);
            const objectIndex = Number.isFinite(Number(options?.objectIndex)) ? Number(options.objectIndex) : 0;
            const gridSize = Number.isFinite(Number(options?.gridSize)) ? Math.max(17, Math.min(513, Math.floor(Number(options.gridSize)))) : 129;
            const displayMode = String(options?.opdDisplayMode || 'pistonTiltRemoved');
            const wasmOpdMode = String(options?.wasmOpdMode || 'simple');
            const wavelength = (() => {
                try {
                    if (typeof window.getPrimaryWavelength === 'function') {
                        const w = Number(window.getPrimaryWavelength());
                        if (Number.isFinite(w) && w > 0) return w;
                    }
                } catch (_) {}
                const fallback = Number(getPrimaryWavelength?.());
                return Number.isFinite(fallback) && fallback > 0 ? fallback : 0.5876;
            })();

            const selectedObject = (Array.isArray(objectRows) && objectRows[objectIndex]) ? objectRows[objectIndex] : (objectRows?.[0] || {});
            const pos = String(selectedObject?.position ?? selectedObject?.Position ?? '').toLowerCase();
            const xVal = Number(selectedObject?.xHeightAngle ?? selectedObject?.x ?? 0) || 0;
            const yVal = Number(selectedObject?.yHeightAngle ?? selectedObject?.y ?? 0) || 0;
            const isAngleMode = pos === 'angle' || pos === 'field angle' || pos === 'angles' || pos === 'point';
            const fieldSetting = {
                id: selectedObject?.id || objectIndex + 1,
                displayName: `Object ${objectIndex + 1}`,
                type: isAngleMode ? 'Angle' : 'Rectangle',
                fieldAngle: isAngleMode ? { x: xVal, y: yVal } : { x: 0, y: 0 },
                xHeight: isAngleMode ? 0 : xVal,
                yHeight: isAngleMode ? 0 : yVal,
                objectIndex,
                wavelength
            };

            const wasmStart = now();
            const calculator = createOPDCalculator(opticalSystemRows, wavelength);
            const analyzer = createWavefrontAnalyzer(calculator);
            const wasmMap = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', {
                recordRays: false,
                progressEvery: 0,
                opdMode: wasmOpdMode,
                skipZernikeFit: true,
                renderFromZernike: false,
                opdDisplayMode: displayMode,
                fullBatchTraceExperimental: true
            });
            const wasmElapsedMs = now() - wasmStart;
            if (wasmMap?.error) {
                throw new Error(`WASM/legacy OPD failed: ${wasmMap.error?.message || wasmMap.error}`);
            }

            const wasmValues = (() => {
                if (Array.isArray(wasmMap?.display?.opdsInWavelengths)) return wasmMap.display.opdsInWavelengths;
                if (Array.isArray(wasmMap?.opdsInWavelengths)) return wasmMap.opdsInWavelengths;
                if (Array.isArray(wasmMap?.opds)) return wasmMap.opds;
                return [];
            })().map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v));
            const wasmRawValues = (() => {
                if (Array.isArray(wasmMap?.raw?.opdsInWavelengths)) return wasmMap.raw.opdsInWavelengths;
                if (Array.isArray(wasmMap?.raw?.opds)) return wasmMap.raw.opds;
                return [];
            })().map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v));

            const nativeStart = now();
            const { runNativeOpdMap } = await import('./src/desktop/ipc/client.ts');
            const native = await runNativeOpdMap({
                opticalSystemRows: Array.isArray(opticalSystemRows) ? opticalSystemRows : [],
                sourceRows: Array.isArray(sourceRows) ? sourceRows : [],
                objectRows: Array.isArray(objectRows) ? objectRows : [],
                objectIndex,
                gridSize,
                wavelengthUm: wavelength,
                opdDisplayMode: (displayMode === 'raw' || displayMode === 'pistonTiltRemoved' || displayMode === 'pistonTiltDefocusRemoved') ? displayMode : 'pistonTiltRemoved'
            });
            const nativeElapsedMs = now() - nativeStart;

            const nativeGrid = Array.isArray(native?.displayOpdGrid) && native.displayOpdGrid.length
                ? native.displayOpdGrid
                : native?.rawOpdGrid;
            const nativeValues = flattenGrid(nativeGrid);
            const nativeRawValues = flattenGrid(native?.rawOpdGrid);

            const wasmStats = toStats(wasmValues);
            const nativeStats = toStats(nativeValues);
            const nativeComparedCount = Number.isFinite(Number(native?.hitCount))
                ? Number(native.hitCount)
                : (nativeStats.count || 0);
            const diff = {
                rmsAbs: Number.isFinite(wasmStats.rms) && Number.isFinite(nativeStats.rms) ? Math.abs(nativeStats.rms - wasmStats.rms) : NaN,
                peakToPeakAbs: Number.isFinite(wasmStats.peakToPeak) && Number.isFinite(nativeStats.peakToPeak) ? Math.abs(nativeStats.peakToPeak - wasmStats.peakToPeak) : NaN,
                countDiff: Math.abs(nativeComparedCount - (wasmStats.count || 0))
            };
            const wasmRawStats = toStats(wasmRawValues);
            const nativeRawStats = toStats(nativeRawValues);
            const nativeRawComparedCount = Number.isFinite(Number(native?.hitCount))
                ? Number(native.hitCount)
                : (nativeRawStats.count || 0);
            const rawDiff = {
                rmsAbs: Number.isFinite(wasmRawStats.rms) && Number.isFinite(nativeRawStats.rms) ? Math.abs(nativeRawStats.rms - wasmRawStats.rms) : NaN,
                peakToPeakAbs: Number.isFinite(wasmRawStats.peakToPeak) && Number.isFinite(nativeRawStats.peakToPeak) ? Math.abs(nativeRawStats.peakToPeak - wasmRawStats.peakToPeak) : NaN,
                countDiff: Math.abs(nativeRawComparedCount - (wasmRawStats.count || 0))
            };

            const report = {
                backend: { wasm: 'wavefront.generateWavefrontMap', native: native?.backend || 'run_native_opd_map' },
                options: { objectIndex, gridSize, wavelength, opdDisplayMode: displayMode, wasmOpdMode },
                wasm: { elapsedMs: wasmElapsedMs, stats: wasmStats },
                native: {
                    elapsedMs: nativeElapsedMs,
                    stats: nativeStats,
                    sampleCount: Number(native?.sampleCount ?? 0),
                    hitCount: Number(native?.hitCount ?? 0)
                },
                diff,
                raw: {
                    wasm: wasmRawStats,
                    native: nativeRawStats,
                    diff: rawDiff
                }
            };

            console.log('📊 [OPD Parity] native vs wasm', report);
            try {
                console.log(
                    `[OPD Parity Summary] display rms wasm=${Number(wasmStats.rms).toFixed(6)} native=${Number(nativeStats.rms).toFixed(6)} diff=${Number(diff.rmsAbs).toFixed(6)} ` +
                    `pp wasm=${Number(wasmStats.peakToPeak).toFixed(6)} native=${Number(nativeStats.peakToPeak).toFixed(6)} diff=${Number(diff.peakToPeakAbs).toFixed(6)} count wasm=${wasmStats.count} native=${nativeComparedCount} (gridNonNull=${nativeStats.count})`
                );
                console.log(
                    `[OPD Parity Summary][raw] rms wasm=${Number(wasmRawStats.rms).toFixed(6)} native=${Number(nativeRawStats.rms).toFixed(6)} diff=${Number(rawDiff.rmsAbs).toFixed(6)} ` +
                    `pp wasm=${Number(wasmRawStats.peakToPeak).toFixed(6)} native=${Number(nativeRawStats.peakToPeak).toFixed(6)} diff=${Number(rawDiff.peakToPeakAbs).toFixed(6)} count wasm=${wasmRawStats.count} native=${nativeRawComparedCount} (gridNonNull=${nativeRawStats.count})`
                );
            } catch (_) {}
            return report;
        };
        window['comparePsfNativeVsJs'] = async (options: any = {}) => {
            const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
                ? () => performance.now()
                : () => Date.now();

            const signatureFromGrid = (grid: any) => {
                if (!Array.isArray(grid) || !grid.length || !Array.isArray(grid[0])) {
                    return { count: 0, sum: NaN, sumSq: NaN, min: NaN, max: NaN, hash: 'na' };
                }
                let count = 0;
                let sum = 0;
                let sumSq = 0;
                let min = Infinity;
                let max = -Infinity;
                let hash = 2166136261 >>> 0;
                for (let iy = 0; iy < grid.length; iy++) {
                    const row = grid[iy];
                    if (!Array.isArray(row)) continue;
                    for (let ix = 0; ix < row.length; ix++) {
                        const v = Number(row[ix]);
                        if (!Number.isFinite(v)) continue;
                        count++;
                        sum += v;
                        sumSq += v * v;
                        if (v < min) min = v;
                        if (v > max) max = v;
                        const q = Math.round(v * 1e9);
                        hash ^= (q & 0xff);
                        hash = Math.imul(hash, 16777619) >>> 0;
                        hash ^= ((q >> 8) & 0xff);
                        hash = Math.imul(hash, 16777619) >>> 0;
                        hash ^= ((q >> 16) & 0xff);
                        hash = Math.imul(hash, 16777619) >>> 0;
                        hash ^= ((q >> 24) & 0xff);
                        hash = Math.imul(hash, 16777619) >>> 0;
                    }
                }
                return {
                    count,
                    sum,
                    sumSq,
                    min: Number.isFinite(min) ? min : NaN,
                    max: Number.isFinite(max) ? max : NaN,
                    hash: hash.toString(16),
                };
            };

            const flattenGrid = (grid: any) => {
                const out: number[] = [];
                if (!Array.isArray(grid)) return out;
                for (const row of grid) {
                    if (!Array.isArray(row)) continue;
                    for (const v of row) {
                        const n = Number(v);
                        if (Number.isFinite(n)) out.push(n);
                    }
                }
                return out;
            };

            const computeOpdRmsWaves = (opd: Float32Array[] | number[][], mask: boolean[][], wavelengthUm: number) => {
                if (!Array.isArray(opd) || !Array.isArray(mask) || !Number.isFinite(wavelengthUm) || wavelengthUm <= 0) {
                    return { validCount: 0, meanUm: NaN, rmsUm: NaN, rmsWaves: NaN, marechalStrehl: NaN };
                }
                let count = 0;
                let sum = 0;
                for (let iy = 0; iy < opd.length; iy++) {
                    const row = opd[iy] as any;
                    const mrow = mask[iy] as any;
                    if (!row || !mrow) continue;
                    const w = Math.min(row.length || 0, mrow.length || 0);
                    for (let ix = 0; ix < w; ix++) {
                        if (!mrow[ix]) continue;
                        const v = Number(row[ix]);
                        if (!Number.isFinite(v)) continue;
                        sum += v;
                        count += 1;
                    }
                }
                if (count <= 0) {
                    return { validCount: 0, meanUm: NaN, rmsUm: NaN, rmsWaves: NaN, marechalStrehl: NaN };
                }
                const meanUm = sum / count;
                let sumSq = 0;
                for (let iy = 0; iy < opd.length; iy++) {
                    const row = opd[iy] as any;
                    const mrow = mask[iy] as any;
                    if (!row || !mrow) continue;
                    const w = Math.min(row.length || 0, mrow.length || 0);
                    for (let ix = 0; ix < w; ix++) {
                        if (!mrow[ix]) continue;
                        const v = Number(row[ix]);
                        if (!Number.isFinite(v)) continue;
                        const d = v - meanUm;
                        sumSq += d * d;
                    }
                }
                const rmsUm = Math.sqrt(sumSq / count);
                const rmsWaves = rmsUm / wavelengthUm;
                const marechalStrehl = Math.exp(-Math.pow(2 * Math.PI * rmsWaves, 2));
                return {
                    validCount: count,
                    meanUm,
                    rmsUm,
                    rmsWaves,
                    marechalStrehl: Number.isFinite(marechalStrehl) ? Math.max(0, Math.min(1, marechalStrehl)) : NaN,
                };
            };

            const opticalSystemRows = getOpticalSystemRows();
            const objectRows = getObjectRows();
            const sourceRows = getSourceRows(tableSource);
            const objectIndex = Number.isFinite(Number(options?.objectIndex)) ? Number(options.objectIndex) : 0;
            const samplingSize = Number.isFinite(Number(options?.samplingSize)) ? Math.max(32, Math.min(1024, Math.floor(Number(options.samplingSize)))) : 128;
            const zeroPadToRaw = options?.zeroPadTo;
            const zeroPadTo = Number.isFinite(Number(zeroPadToRaw)) ? Math.max(0, Math.min(4096, Math.floor(Number(zeroPadToRaw)))) : 0;
            const opdDisplayMode = String(options?.opdDisplayMode || 'pistonTiltRemoved');
            const removeTilt = options?.removeTilt === undefined ? false : !!options.removeTilt;
            const recenterIfWrapped = options?.recenterIfWrapped === undefined ? undefined : !!options.recenterIfWrapped;
            const wavelength = (() => {
                try {
                    if (typeof window.getPrimaryWavelength === 'function') {
                        const w = Number(window.getPrimaryWavelength());
                        if (Number.isFinite(w) && w > 0) return w;
                    }
                } catch (_) {}
                const fallback = Number(getPrimaryWavelength?.());
                return Number.isFinite(fallback) && fallback > 0 ? fallback : 0.5876;
            })();

            if (!isTauriRuntime()) {
                throw new Error('comparePsfNativeVsJs requires Tauri runtime');
            }

            const selectedObject = (Array.isArray(objectRows) && objectRows[objectIndex]) ? objectRows[objectIndex] : (objectRows?.[0] || {});
            const pos = String(selectedObject?.position ?? selectedObject?.Position ?? '').toLowerCase();
            const xVal = Number(selectedObject?.xHeightAngle ?? selectedObject?.x ?? 0) || 0;
            const yVal = Number(selectedObject?.yHeightAngle ?? selectedObject?.y ?? 0) || 0;
            const isAngleMode = pos === 'angle' || pos === 'field angle' || pos === 'angles';
            const fieldSetting = {
                id: selectedObject?.id || objectIndex + 1,
                displayName: `Object ${objectIndex + 1}`,
                type: isAngleMode ? 'Angle' : 'Rectangle',
                fieldAngle: isAngleMode ? { x: xVal, y: yVal } : { x: 0, y: 0 },
                xHeight: isAngleMode ? 0 : xVal,
                yHeight: isAngleMode ? 0 : yVal,
                objectIndex,
                wavelength
            };

            const wfStart = now();
            const calculator = createOPDCalculator(opticalSystemRows, wavelength);
            const analyzer = createWavefrontAnalyzer(calculator);
            const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, samplingSize, 'circular', {
                recordRays: false,
                progressEvery: 0,
                opdMode: 'simple',
                skipZernikeFit: true,
                renderFromZernike: false,
                opdDisplayMode,
                fullBatchTraceExperimental: true
            });
            const wfElapsedMs = now() - wfStart;
            if (wavefrontMap?.error) {
                throw new Error(`Wavefront generation failed: ${wavefrontMap.error?.message || wavefrontMap.error}`);
            }

            const s = Math.max(16, Math.floor(Number(samplingSize)));
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
            const useDisplayOpd = (opdDisplayMode !== 'raw') && Array.isArray(wavefrontMap?.display?.opds);
            const opdMicrons = useDisplayOpd
                ? wavefrontMap.display.opds
                : (Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds : []);
            const nPts = Math.min(coords.length, opdMicrons.length);

            const rayData: any[] = [];
            for (let k = 0; k < nPts; k++) {
                const c = coords[k];
                const ix = Number.isInteger(c?.ix) ? c.ix : null;
                const iy = Number.isInteger(c?.iy) ? c.iy : null;
                const vMicrons = Number(opdMicrons[k]);
                if (ix !== null && iy !== null && ix >= 0 && ix < s && iy >= 0 && iy < s && Number.isFinite(vMicrons)) {
                    maskGrid[iy][ix] = true;
                    opdGrid[iy][ix] = vMicrons;
                    ampGrid[iy][ix] = 1.0;
                }

                const x = Number(c?.x);
                const y = Number(c?.y);
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(vMicrons)) {
                    rayData.push({ pupilX: x, pupilY: y, opd: vMicrons, isVignetted: false });
                }
            }

            const opdData = {
                gridSize: s,
                wavelength,
                rayData,
                gridData: {
                    opd: opdGrid,
                    amplitude: ampGrid,
                    pupilMask: maskGrid,
                    xCoords,
                    yCoords,
                }
            };

            let stopDiameterMm = 24.0;
            try {
                const stopIndex = Number((window as any).findStopSurfaceIndex?.(opticalSystemRows));
                const stopRow = (Number.isFinite(stopIndex) && stopIndex >= 0 && opticalSystemRows?.[stopIndex]) ? opticalSystemRows[stopIndex] : null;
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

            let focalLengthMm = 100.0;
            try {
                if (typeof (window as any).calculateFocalLength === 'function') {
                    const fl = Number((window as any).calculateFocalLength(opticalSystemRows, wavelength));
                    if (Number.isFinite(fl) && Math.abs(fl) > 1e-9 && fl !== Infinity) focalLengthMm = Math.abs(fl);
                }
            } catch (_) {}

            const { PSFCalculator } = await import('./evaluation/psf/psf-calculator.ts');
            const psfCalculator = new PSFCalculator();

            const nativeStart = now();
            const nativeResult = await psfCalculator.calculatePSF(opdData, {
                samplingSize: s,
                wavelength,
                zeroPadTo,
                pupilDiameter: stopDiameterMm,
                focalLength: focalLengthMm,
                forceImplementation: 'native',
                removeTilt,
                recenterIfWrapped,
            });
            const nativeElapsedMs = now() - nativeStart;

            const jsStart = now();
            const jsResult = await psfCalculator.calculatePSF(opdData, {
                samplingSize: s,
                wavelength,
                zeroPadTo,
                pupilDiameter: stopDiameterMm,
                focalLength: focalLengthMm,
                forceImplementation: 'javascript',
                removeTilt,
                recenterIfWrapped,
            });
            const jsElapsedMs = now() - jsStart;

            const extractPsfGrid = (result: any) => {
                if (Array.isArray(result?.psfData)) return result.psfData;
                if (Array.isArray(result?.psf)) return result.psf;
                return [];
            };

            const extractPsfMetrics = (result: any) => {
                if (result?.metrics && typeof result.metrics === 'object') {
                    return result.metrics;
                }
                return {
                    strehlRatio: Number(result?.strehlRatio),
                    fwhm: result?.fwhm,
                    centerPosition: result?.centerPosition,
                };
            };

            const extractImplementationUsed = (result: any) =>
                String(result?.implementationUsed || result?.metadata?.method || 'unknown');

            const nativeGrid = extractPsfGrid(nativeResult);
            const jsGrid = extractPsfGrid(jsResult);
            const nativeMetrics = extractPsfMetrics(nativeResult);
            const jsMetrics = extractPsfMetrics(jsResult);
            const h = Math.min(nativeGrid.length, jsGrid.length);
            const w = h > 0 ? Math.min((nativeGrid[0] || []).length, (jsGrid[0] || []).length) : 0;
            const nativeSig = signatureFromGrid(nativeGrid);
            const jsSig = signatureFromGrid(jsGrid);

            let count = 0;
            let sumSq = 0;
            let sumAbs = 0;
            let maxAbs = 0;
            for (let iy = 0; iy < h; iy++) {
                for (let ix = 0; ix < w; ix++) {
                    const a = Number(nativeGrid[iy]?.[ix]);
                    const b = Number(jsGrid[iy]?.[ix]);
                    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                    const d = a - b;
                    const ad = Math.abs(d);
                    sumSq += d * d;
                    sumAbs += ad;
                    if (ad > maxAbs) maxAbs = ad;
                    count++;
                }
            }

            const opdQuality = computeOpdRmsWaves(opdGrid as any, maskGrid as any, wavelength);

            const nativeStrehl = Number(nativeMetrics?.strehlRatio);
            const jsStrehl = Number(jsMetrics?.strehlRatio);

            const report = {
                options: {
                    objectIndex,
                    samplingSize: s,
                    zeroPadTo,
                    wavelength,
                    opdDisplayMode,
                    removeTilt,
                    recenterIfWrapped: recenterIfWrapped === undefined ? null : recenterIfWrapped,
                    pupilDiameterMm: stopDiameterMm,
                    focalLengthMm,
                },
                timings: {
                    wavefrontMs: wfElapsedMs,
                    nativeMs: nativeElapsedMs,
                    javascriptMs: jsElapsedMs,
                },
                backend: {
                    native: extractImplementationUsed(nativeResult),
                    javascript: extractImplementationUsed(jsResult),
                    nativeMethod: String(nativeResult?.metadata?.method || ''),
                    javascriptMethod: String(jsResult?.metadata?.method || ''),
                },
                diff: {
                    comparedGrid: `${h}x${w}`,
                    count,
                    rmsAbs: count > 0 ? Math.sqrt(sumSq / count) : NaN,
                    meanAbs: count > 0 ? (sumAbs / count) : NaN,
                    maxAbs,
                },
                metrics: {
                    native: nativeMetrics || null,
                    javascript: jsMetrics || null,
                    expected: opdQuality,
                    delta: {
                        strehl: nativeStrehl - jsStrehl,
                        fwhmAvgUm: Number(nativeMetrics?.fwhm?.average) - Number(jsMetrics?.fwhm?.average),
                        centerX: Number(nativeMetrics?.centerPosition?.x) - Number(jsMetrics?.centerPosition?.x),
                        centerY: Number(nativeMetrics?.centerPosition?.y) - Number(jsMetrics?.centerPosition?.y),
                    }
                },
                grids: {
                    native: flattenGrid(nativeGrid).length,
                    javascript: flattenGrid(jsGrid).length,
                    nativeHash: nativeSig.hash,
                    javascriptHash: jsSig.hash,
                    nativeSum: nativeSig.sum,
                    javascriptSum: jsSig.sum,
                }
            };

            console.log('📊 [PSF Parity] native vs javascript', report);
            try {
                console.log(
                    `[PSF Parity Summary] grid=${report.diff.comparedGrid} n=${report.diff.count} ` +
                    `rmsAbs=${Number(report.diff.rmsAbs).toExponential(4)} meanAbs=${Number(report.diff.meanAbs).toExponential(4)} maxAbs=${Number(report.diff.maxAbs).toExponential(4)} ` +
                    `strehl(native=${Number(nativeStrehl).toFixed(6)},js=${Number(jsStrehl).toFixed(6)},Δ=${Number(report.metrics.delta.strehl).toExponential(4)}) ` +
                    `marechal≈${Number(report.metrics.expected?.marechalStrehl).toFixed(6)} opdRms=${Number(report.metrics.expected?.rmsWaves).toExponential(4)}waves ` +
                    `fwhmAvgΔ=${Number(report.metrics.delta.fwhmAvgUm).toExponential(4)}µm centerΔ=(${report.metrics.delta.centerX},${report.metrics.delta.centerY}) ` +
                    `backend(native=${report.backend.native}, js=${report.backend.javascript})`
                );
            } catch (_) {}
            return report;
        };
        window['comparePsfNativeVsJsForObjects'] = async (options: any = {}) => {
            const rows = getObjectRows();
            const totalObjects = Array.isArray(rows) ? rows.length : 0;
            const requested = Array.isArray(options?.objectIndices)
                ? options.objectIndices
                : (totalObjects >= 2 ? [0, 1] : [0]);
            const objectIndices = requested
                .map((v: any) => Number(v))
                .filter((v: number) => Number.isFinite(v) && v >= 0 && v < Math.max(1, totalObjects));

            if (!objectIndices.length) {
                throw new Error('No valid objectIndices. Example: [0, 1]');
            }

            const reports: any[] = [];
            for (const objectIndex of objectIndices) {
                const r = await (window as any).comparePsfNativeVsJs({
                    ...options,
                    objectIndex,
                });
                reports.push(r);
            }

            const byObject = reports.map((r) => ({
                objectIndex: Number(r?.options?.objectIndex),
                nativeHash: r?.grids?.nativeHash,
                jsHash: r?.grids?.javascriptHash,
                nativeStrehl: Number(r?.metrics?.native?.strehlRatio),
                jsStrehl: Number(r?.metrics?.javascript?.strehlRatio),
                marechalStrehl: Number(r?.metrics?.expected?.marechalStrehl),
                opdRmsWaves: Number(r?.metrics?.expected?.rmsWaves),
                nativeFwhmAvg: Number(r?.metrics?.native?.fwhm?.average),
                jsFwhmAvg: Number(r?.metrics?.javascript?.fwhm?.average),
                centerNative: r?.metrics?.native?.centerPosition,
                centerJs: r?.metrics?.javascript?.centerPosition,
            }));

            const variation: any[] = [];
            for (let i = 1; i < byObject.length; i++) {
                const a = byObject[i - 1];
                const b = byObject[i];
                variation.push({
                    fromObject: a.objectIndex,
                    toObject: b.objectIndex,
                    nativeHashChanged: a.nativeHash !== b.nativeHash,
                    jsHashChanged: a.jsHash !== b.jsHash,
                    nativeStrehlDelta: b.nativeStrehl - a.nativeStrehl,
                    jsStrehlDelta: b.jsStrehl - a.jsStrehl,
                    nativeFwhmDelta: b.nativeFwhmAvg - a.nativeFwhmAvg,
                    jsFwhmDelta: b.jsFwhmAvg - a.jsFwhmAvg,
                });
            }

            const summary = { objectIndices, byObject, variation };
            console.log('📊 [PSF Object Compare] native vs javascript', summary);
            return summary;
        };
        window['runOPDProfiling'] = runOPDProfiling; // ✅ OPD performance profiling
        window['showMTFDiagram'] = showMTFDiagram;
        window['showMTFComparisonDiagram'] = showMTFComparisonDiagram;
        window['showThroughFocusSpotDiagram'] = showThroughFocusSpotDiagram;
        window['runSpotParityDiagnostics'] = runSpotParityDiagnostics;
        window['showThroughFocusMTFDiagram'] = showThroughFocusMTFDiagram;
        window['benchmarkMTFOnce'] = async (options: any = {}) => {
            const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
            const prevWavefrontProfile = g ? g.__WAVEFRONT_PROFILE : undefined;
            const prevOpdDebug = g ? g.__OPD_DEBUG : undefined;
            const prevPsfDebug = g ? g.__PSF_DEBUG : undefined;

            const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
                ? () => performance.now()
                : () => Date.now();

            const container = document.createElement('div');
            container.id = `mtf-benchmark-${Date.now()}`;
            container.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:800px;height:600px;overflow:hidden;';
            document.body.appendChild(container);

            try {
                if (g) {
                    g.__WAVEFRONT_PROFILE = true;
                    g.__OPD_DEBUG = false;
                    g.__PSF_DEBUG = false;
                }

                const t0 = now();
                await showMTFDiagram({
                    wavelengthMicrons: options.wavelengthMicrons ?? 'all',
                    objectIndex: Number.isFinite(Number(options.objectIndex)) ? Number(options.objectIndex) : 0,
                    maxFrequencyLpmm: Number.isFinite(Number(options.maxFrequencyLpmm)) ? Number(options.maxFrequencyLpmm) : 100,
                    samplingSize: Number.isFinite(Number(options.samplingSize)) ? Number(options.samplingSize) : 256,
                    samplingPoints: Number.isFinite(Number(options.samplingPoints)) ? Number(options.samplingPoints) : 64,
                    opdDisplayMode: options.opdDisplayMode ?? 'pistonTiltRemoved',
                    containerElement: container,
                    onProgress: null
                });
                const elapsedMs = now() - t0;
                const rt = (g && typeof g.getRayTracingProfile === 'function')
                    ? g.getRayTracingProfile({ reset: true })
                    : null;
                const traceCalls = Number(rt?.traceCalls) || 0;
                const lockstepCalls = Number(rt?.traceBatchLockstepCalls) || 0;
                const lockstepRays = Number(rt?.traceBatchLockstepRays) || 0;
                const lockstepCallRatio = traceCalls > 0 ? (lockstepCalls / traceCalls) : 0;
                const lockstepRaysPerCall = lockstepCalls > 0 ? (lockstepRays / lockstepCalls) : 0;
                const traceCallsPerMs = elapsedMs > 0 ? (traceCalls / elapsedMs) : 0;
                const result = {
                    elapsedMs,
                    samplingSize: Number.isFinite(Number(options.samplingSize)) ? Number(options.samplingSize) : 256,
                    samplingPoints: Number.isFinite(Number(options.samplingPoints)) ? Number(options.samplingPoints) : 64,
                    wavelengthMicrons: options.wavelengthMicrons ?? 'all',
                    maxFrequencyLpmm: Number.isFinite(Number(options.maxFrequencyLpmm)) ? Number(options.maxFrequencyLpmm) : 100,
                    objectIndex: Number.isFinite(Number(options.objectIndex)) ? Number(options.objectIndex) : 0,
                    rayTracing: {
                        traceCalls,
                        traceCallsPerMs,
                        lockstepCalls,
                        lockstepRays,
                        lockstepCallRatio,
                        lockstepRaysPerCall
                    },
                    note: 'See [OPD Profile] logs for wavefront/raytrace breakdown.'
                };
                console.log('📊 benchmarkMTFOnce result:', result);
                return result;
            } finally {
                try { container.remove(); } catch (_) {}
                if (g) {
                    g.__WAVEFRONT_PROFILE = prevWavefrontProfile;
                    g.__OPD_DEBUG = prevOpdDebug;
                    g.__PSF_DEBUG = prevPsfDebug;
                }
            }
        };
        window['benchmarkMTF'] = async (options: any = {}) => {
            const runs = Math.max(1, Math.floor(Number(options.runs) || 3));
            const warmup = Math.max(0, Math.floor(Number(options.warmup) || 1));
            const samples: number[] = [];
            const lockstepCallRatios: number[] = [];
            const lockstepRaysPerCallArr: number[] = [];

            for (let i = 0; i < warmup; i++) {
                await (window as any).benchmarkMTFOnce(options);
            }
            for (let i = 0; i < runs; i++) {
                const r = await (window as any).benchmarkMTFOnce(options);
                const ms = Number(r?.elapsedMs);
                if (Number.isFinite(ms)) samples.push(ms);
                const lockstepCallRatio = Number(r?.rayTracing?.lockstepCallRatio);
                if (Number.isFinite(lockstepCallRatio)) lockstepCallRatios.push(lockstepCallRatio);
                const lockstepRaysPerCall = Number(r?.rayTracing?.lockstepRaysPerCall);
                if (Number.isFinite(lockstepRaysPerCall)) lockstepRaysPerCallArr.push(lockstepRaysPerCall);
            }

            const avg = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : NaN;
            const min = samples.length > 0 ? Math.min(...samples) : NaN;
            const max = samples.length > 0 ? Math.max(...samples) : NaN;
            const avgLockstepCallRatio = lockstepCallRatios.length > 0
                ? (lockstepCallRatios.reduce((a, b) => a + b, 0) / lockstepCallRatios.length)
                : NaN;
            const avgLockstepRaysPerCall = lockstepRaysPerCallArr.length > 0
                ? (lockstepRaysPerCallArr.reduce((a, b) => a + b, 0) / lockstepRaysPerCallArr.length)
                : NaN;
            const summary = {
                runs,
                warmup,
                samples,
                avgMs: avg,
                minMs: min,
                maxMs: max,
                lockstep: {
                    avgCallRatio: avgLockstepCallRatio,
                    avgRaysPerCall: avgLockstepRaysPerCall
                }
            };
            console.log('📈 benchmarkMTF summary:', summary);
            return summary;
        };
        window['benchmarkMTFCompare'] = async (options: any = {}) => {
            const beforeLabel = String(options.beforeLabel ?? 'before');
            const afterLabel = String(options.afterLabel ?? 'after');
            const beforeOptions = { ...(options.beforeOptions ?? {}) };
            const afterOptions = { ...(options.afterOptions ?? {}) };

            if (options.runs !== undefined) {
                beforeOptions.runs = options.runs;
                afterOptions.runs = options.runs;
            }
            if (options.warmup !== undefined) {
                beforeOptions.warmup = options.warmup;
                afterOptions.warmup = options.warmup;
            }

            const before = await (window as any).benchmarkMTF(beforeOptions);
            const after = await (window as any).benchmarkMTF(afterOptions);

            const beforeAvg = Number(before?.avgMs);
            const afterAvg = Number(after?.avgMs);
            const beforeMin = Number(before?.minMs);
            const afterMin = Number(after?.minMs);
            const beforeMax = Number(before?.maxMs);
            const afterMax = Number(after?.maxMs);

            const avgDeltaMs = (Number.isFinite(beforeAvg) && Number.isFinite(afterAvg)) ? (afterAvg - beforeAvg) : NaN;
            const minDeltaMs = (Number.isFinite(beforeMin) && Number.isFinite(afterMin)) ? (afterMin - beforeMin) : NaN;
            const maxDeltaMs = (Number.isFinite(beforeMax) && Number.isFinite(afterMax)) ? (afterMax - beforeMax) : NaN;
            const avgImprovementPct = (Number.isFinite(beforeAvg) && beforeAvg > 0 && Number.isFinite(afterAvg))
                ? ((beforeAvg - afterAvg) / beforeAvg) * 100
                : NaN;
            const beforeLockstepRatio = Number(before?.lockstep?.avgCallRatio);
            const afterLockstepRatio = Number(after?.lockstep?.avgCallRatio);
            const lockstepRatioDelta = (Number.isFinite(beforeLockstepRatio) && Number.isFinite(afterLockstepRatio))
                ? (afterLockstepRatio - beforeLockstepRatio)
                : NaN;

            const comparison = {
                labels: { before: beforeLabel, after: afterLabel },
                before,
                after,
                delta: {
                    avgMs: avgDeltaMs,
                    minMs: minDeltaMs,
                    maxMs: maxDeltaMs,
                    avgImprovementPct,
                    lockstepCallRatioDelta: lockstepRatioDelta
                }
            };
            console.log('🧪 benchmarkMTFCompare result:', comparison);
            return comparison;
        };
        window['compareMTFvsTFMTFAtFrequency'] = async (options: any = {}) => {
            const freq = Number.isFinite(Number(options?.frequencyLpmm)) ? Number(options.frequencyLpmm) : 10;
            const wl = (options?.wavelengthMicrons === 'all')
                ? 'all'
                : (Number.isFinite(Number(options?.wavelengthMicrons)) ? Number(options.wavelengthMicrons) : 0.5876);
            const objIndex = Number.isFinite(Number(options?.objectIndex)) ? Number(options.objectIndex) : 0;
            const samplingSize = Number.isFinite(Number(options?.samplingSize)) ? Number(options.samplingSize) : 256;
            const zeroPadTo = Number.isFinite(Number(options?.zeroPadTo)) ? Number(options.zeroPadTo) : 0;
            const opdDisplayMode = String(options?.opdDisplayMode || 'pistonTiltRemoved');

            const interpolateAtFrequency = (trace: any, targetFreq: number) => {
                const x = Array.isArray(trace?.x) ? trace.x : [];
                const y = Array.isArray(trace?.y) ? trace.y : [];
                if (!x.length || x.length !== y.length) return NaN;
                const points = x
                    .map((vx: any, i: number) => ({ x: Number(vx), y: Number(y[i]) }))
                    .filter((p: any) => Number.isFinite(p.x) && Number.isFinite(p.y))
                    .sort((a: any, b: any) => a.x - b.x);
                if (!points.length) return NaN;
                if (points.length === 1) return points[0].y;
                if (targetFreq <= points[0].x) return points[0].y;
                if (targetFreq >= points[points.length - 1].x) return points[points.length - 1].y;
                for (let i = 1; i < points.length; i++) {
                    const a = points[i - 1];
                    const b = points[i];
                    if (targetFreq <= b.x && b.x > a.x) {
                        const t = (targetFreq - a.x) / (b.x - a.x);
                        return a.y + t * (b.y - a.y);
                    }
                }
                return points[points.length - 1].y;
            };

            const pickMtfTraces = (traces: any[]) => {
                const regular = (Array.isArray(traces) ? traces : []).filter((tr: any) => tr?.meta?.overlayType !== 'diffractionLimit');
                const meridional = regular.find((tr: any) => /meridional|tangential/i.test(String(tr?.name || '')));
                const sagittal = regular.find((tr: any) => /sagittal/i.test(String(tr?.name || '')));
                return { meridional, sagittal, regularCount: regular.length };
            };

            const pickTfmtfAtZeroDefocus = (trace: any) => {
                const x = Array.isArray(trace?.x) ? trace.x : [];
                const y = Array.isArray(trace?.y) ? trace.y : [];
                if (!x.length || x.length !== y.length) return NaN;
                let bestIdx = 0;
                let bestAbs = Infinity;
                for (let i = 0; i < x.length; i++) {
                    const xi = Number(x[i]);
                    if (!Number.isFinite(xi)) continue;
                    const d = Math.abs(xi);
                    if (d < bestAbs) {
                        bestAbs = d;
                        bestIdx = i;
                    }
                }
                const v = Number(y[bestIdx]);
                return Number.isFinite(v) ? v : NaN;
            };

            const hiddenContainer = document.createElement('div');
            hiddenContainer.id = `mtf-parity-${Date.now()}`;
            hiddenContainer.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:800px;height:600px;overflow:hidden;';
            document.body.appendChild(hiddenContainer);

            try {
                const mtfResult = await showMTFDiagram({
                    wavelengthMicrons: wl as any,
                    objectIndex: objIndex,
                    maxFrequencyLpmm: Math.max(20, freq),
                    samplingSize,
                    zeroPadTo,
                    opdDisplayMode,
                    skipPlot: true,
                    containerElement: hiddenContainer,
                });
                const mtfTraces = Array.isArray((mtfResult as any)?.traces) ? (mtfResult as any).traces : [];
                const mtfPicked = pickMtfTraces(mtfTraces);
                const mtfMeridional = interpolateAtFrequency(mtfPicked.meridional, freq);
                const mtfSagittal = interpolateAtFrequency(mtfPicked.sagittal, freq);

                const tfmtfResult = await showThroughFocusMTFDiagram({
                    wavelengthMicrons: wl as any,
                    objectIndex: objIndex,
                    targetFrequencyLpmm: freq,
                    defocusMinMm: 0,
                    defocusMaxMm: 0,
                    steps: 3,
                    samplingSize,
                    zeroPadTo,
                    opdDisplayMode,
                    containerElement: hiddenContainer,
                });
                const tfmtfTraces = Array.isArray((tfmtfResult as any)?.traces) ? (tfmtfResult as any).traces : [];
                const tfmtfPicked = pickMtfTraces(tfmtfTraces);
                const tfmtfMeridional = pickTfmtfAtZeroDefocus(tfmtfPicked.meridional);
                const tfmtfSagittal = pickTfmtfAtZeroDefocus(tfmtfPicked.sagittal);

                const report = {
                    conditions: { frequencyLpmm: freq, wavelengthMicrons: wl, objectIndex: objIndex, samplingSize, zeroPadTo, opdDisplayMode },
                    mtf: { meridional: mtfMeridional, sagittal: mtfSagittal, traceCount: mtfPicked.regularCount },
                    tfmtfAtDefocus0: { meridional: tfmtfMeridional, sagittal: tfmtfSagittal, traceCount: tfmtfPicked.regularCount },
                    delta: {
                        meridional: (Number.isFinite(mtfMeridional) && Number.isFinite(tfmtfMeridional)) ? (tfmtfMeridional - mtfMeridional) : NaN,
                        sagittal: (Number.isFinite(mtfSagittal) && Number.isFinite(tfmtfSagittal)) ? (tfmtfSagittal - mtfSagittal) : NaN,
                    }
                };
                console.log('📊 [MTF vs TFMTF parity]', report);
                return report;
            } finally {
                try { hiddenContainer.remove(); } catch (_) {}
            }
        };
        window['compareNativeVsTsObjectMtf'] = async (options: any = {}) => {
            const freq1 = Number.isFinite(Number(options?.firstFrequencyLpmm)) ? Number(options.firstFrequencyLpmm) : 10;
            const freq2 = Number.isFinite(Number(options?.secondFrequencyLpmm)) ? Number(options.secondFrequencyLpmm) : 30;
            const wl = (options?.wavelengthMicrons === 'all')
                ? 'all'
                : (Number.isFinite(Number(options?.wavelengthMicrons)) ? Number(options.wavelengthMicrons) : 0.5876);
            const samplingSize = Number.isFinite(Number(options?.samplingSize)) ? Number(options.samplingSize) : 256;
            const zeroPadTo = Number.isFinite(Number(options?.zeroPadTo)) ? Number(options.zeroPadTo) : 0;
            const fieldMin = Number.isFinite(Number(options?.fieldMin)) ? Number(options.fieldMin) : 0;
            const fieldMax = Number.isFinite(Number(options?.fieldMax)) ? Number(options.fieldMax) : 10;
            const steps = Number.isFinite(Number(options?.steps)) ? Math.max(3, Math.floor(Number(options.steps))) : 21;
            const axisMode = (options?.fieldAxisMode === 'height' || options?.fieldAxisMode === 'angle')
                ? options.fieldAxisMode
                : 'angle';
            const opdDisplayMode = String(options?.opdDisplayMode || 'pistonTiltRemoved');

            const hiddenContainer = document.createElement('div');
            hiddenContainer.id = `field-mtf-compare-${Date.now()}`;
            hiddenContainer.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:900px;height:650px;overflow:hidden;';
            document.body.appendChild(hiddenContainer);

            const parseTrace = (trace: any) => {
                const name = String(trace?.name || '');
                const x = Array.isArray(trace?.x) ? trace.x.map((v: any) => Number(v)) : [];
                const y = Array.isArray(trace?.y) ? trace.y.map((v: any) => Number(v)) : [];
                if (!x.length || x.length !== y.length) return null;
                return { name, x, y };
            };

            const toSeriesMap = (traces: any[]) => {
                const out: Record<string, { x: number[]; y: number[] }> = {};
                for (const tr of (Array.isArray(traces) ? traces : [])) {
                    const parsed = parseTrace(tr);
                    if (!parsed) continue;
                    out[parsed.name] = { x: parsed.x, y: parsed.y };
                }
                return out;
            };

            const getAtNearestField = (series: { x: number[]; y: number[] } | undefined, targetField: number) => {
                if (!series || !Array.isArray(series.x) || !Array.isArray(series.y) || series.x.length !== series.y.length || series.x.length === 0) {
                    return NaN;
                }
                let bestIdx = 0;
                let bestDf = Infinity;
                for (let i = 0; i < series.x.length; i++) {
                    const xi = Number(series.x[i]);
                    if (!Number.isFinite(xi)) continue;
                    const df = Math.abs(xi - targetField);
                    if (df < bestDf) {
                        bestDf = df;
                        bestIdx = i;
                    }
                }
                const v = Number(series.y[bestIdx]);
                return Number.isFinite(v) ? v : NaN;
            };

            try {
                const nativeFn = (window as any).runDesktopNativeFieldMtfForPopup;
                if (typeof nativeFn !== 'function') {
                    throw new Error('runDesktopNativeFieldMtfForPopup is not available');
                }

                const nativeResp = await nativeFn({
                    objectIndex: 0,
                    wavelengths: wl === 'all' ? [] : [Number(wl)],
                    firstFrequencyLpmm: freq1,
                    secondFrequencyLpmm: freq2,
                    fieldMin,
                    fieldMax,
                    steps,
                    samplingSize,
                    zeroPadTo,
                    opdDisplayMode,
                    fieldAxisMode: axisMode,
                });

                const tsResp = await showFieldMTFDiagram({
                    wavelengthMicrons: wl as any,
                    firstFrequencyLpmm: freq1,
                    secondFrequencyLpmm: freq2,
                    fieldMin,
                    fieldMax,
                    steps,
                    samplingSize,
                    zeroPadTo,
                    opdDisplayMode,
                    fieldAxisMode: axisMode as any,
                    containerElement: hiddenContainer,
                });

                const nativeSeries0 = Array.isArray(nativeResp?.series) ? nativeResp.series[0] : null;
                const nativeX = Array.isArray(nativeResp?.xAxis) ? nativeResp.xAxis.map((v: any) => Number(v)) : [];

                const nativeTraces = [
                    { name: `Meridional ${freq1.toFixed(1)} lp/mm`, x: nativeX, y: Array.isArray(nativeSeries0?.meridionalFirst) ? nativeSeries0.meridionalFirst : [] },
                    { name: `Sagittal ${freq1.toFixed(1)} lp/mm`, x: nativeX, y: Array.isArray(nativeSeries0?.sagittalFirst) ? nativeSeries0.sagittalFirst : [] },
                    { name: `Meridional ${freq2.toFixed(1)} lp/mm`, x: nativeX, y: Array.isArray(nativeSeries0?.meridionalSecond) ? nativeSeries0.meridionalSecond : [] },
                    { name: `Sagittal ${freq2.toFixed(1)} lp/mm`, x: nativeX, y: Array.isArray(nativeSeries0?.sagittalSecond) ? nativeSeries0.sagittalSecond : [] },
                ];

                const tsSeriesMap = toSeriesMap(Array.isArray((tsResp as any)?.traces) ? (tsResp as any).traces : []);
                const fieldGrid = nativeX.length ? nativeX : (Array.isArray(Object.values(tsSeriesMap)?.[0]?.x) ? Object.values(tsSeriesMap)[0].x : []);

                const deltas = fieldGrid.map((f: number) => {
                    const nM1 = getAtNearestField({ x: nativeX, y: nativeTraces[0].y as number[] }, f);
                    const nS1 = getAtNearestField({ x: nativeX, y: nativeTraces[1].y as number[] }, f);
                    const nM2 = getAtNearestField({ x: nativeX, y: nativeTraces[2].y as number[] }, f);
                    const nS2 = getAtNearestField({ x: nativeX, y: nativeTraces[3].y as number[] }, f);

                    const tsM1 = getAtNearestField(tsSeriesMap[Object.keys(tsSeriesMap).find(k => k.startsWith(`Meridional ${freq1.toFixed(1)} lp/mm`)) || ''], f);
                    const tsS1 = getAtNearestField(tsSeriesMap[Object.keys(tsSeriesMap).find(k => k.startsWith(`Sagittal ${freq1.toFixed(1)} lp/mm`)) || ''], f);
                    const tsM2 = getAtNearestField(tsSeriesMap[Object.keys(tsSeriesMap).find(k => k.startsWith(`Meridional ${freq2.toFixed(1)} lp/mm`)) || ''], f);
                    const tsS2 = getAtNearestField(tsSeriesMap[Object.keys(tsSeriesMap).find(k => k.startsWith(`Sagittal ${freq2.toFixed(1)} lp/mm`)) || ''], f);

                    return {
                        field: f,
                        native: { m1: nM1, s1: nS1, m2: nM2, s2: nS2 },
                        ts: { m1: tsM1, s1: tsS1, m2: tsM2, s2: tsS2 },
                        delta: {
                            m1: (Number.isFinite(nM1) && Number.isFinite(tsM1)) ? (nM1 - tsM1) : NaN,
                            s1: (Number.isFinite(nS1) && Number.isFinite(tsS1)) ? (nS1 - tsS1) : NaN,
                            m2: (Number.isFinite(nM2) && Number.isFinite(tsM2)) ? (nM2 - tsM2) : NaN,
                            s2: (Number.isFinite(nS2) && Number.isFinite(tsS2)) ? (nS2 - tsS2) : NaN,
                        }
                    };
                });

                const report = {
                    conditions: { wl, freq1, freq2, fieldMin, fieldMax, steps, samplingSize, zeroPadTo, axisMode, opdDisplayMode },
                    native: { xAxis: nativeX, series: nativeSeries0 },
                    tsTraceNames: Object.keys(tsSeriesMap),
                    perField: deltas,
                };
                console.log('📊 [Object MTF Native vs TS]', report);
                return report;
            } finally {
                try { hiddenContainer.remove(); } catch (_) {}
            }
        };
        
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
        window['calculateParaxialData'] = calculateParaxialData;
        window['calculateEntrancePupilDiameter'] = calculateEntrancePupilDiameter;
        window['calculateImageSpaceDiffractionParams'] = calculateImageSpaceDiffractionParams;
        window['derivePupilAndFocalLengthMmFromParaxial'] = derivePupilAndFocalLengthMmFromParaxial;
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
        console.error('[RenderWindow] drawOpticalSystemSurfaceWrapper failed:', error);
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
            crossSectionDirection: 'YZ',
            crossSectionCenterOffset: 0
        });
        
        // Adjust camera view to fit the drawn surfaces
        if (typeof window.adjustCameraView === 'function') {
            window.adjustCameraView(scene, camera, controls, renderer);
        }
        
    } catch (error) {
        console.error('[RenderWindow] improvedDrawOpticalSystemSurfaceWrapper failed:', error);
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
            const rayCountInput =
                (document.getElementById('render-ray-count-input') as HTMLInputElement | null)
                || (document.getElementById('draw-ray-count-input') as HTMLInputElement | null);
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
                        const rayPath = window.traceRay ? window.traceRay(opticalSystemRows, ray, 1.0, null, null, {
                            allowNonStrict: true,
                            requireWasmRayTracing: false,
                            useRustWasm: true,
                            disableWasmRayTracing: false,
                        }) : null;

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

        const { minZ, maxZ, centerZ, totalLength, maxY } = calculateOpticalSystemZRange();
        const includeRayStartMargin = options.includeRayStartMargin !== false;
        const rayStartMargin = includeRayStartMargin ? 25 : 0;
        const effectiveMinZ = Math.min(minZ, -rayStartMargin);
        const effectiveMaxZ = maxZ;
        const effectiveTotalLength = effectiveMaxZ - effectiveMinZ;
        const effectiveCenterZ = (effectiveMinZ + effectiveMaxZ) / 2;

        const savedBounds = camera?.userData?.__drawCrossOrthoBounds;
        const preserveDrawCrossBounds = options.preserveDrawCrossBounds === true && savedBounds;
        const systemCenterZ = Number.isFinite(options.centerZOverride)
            ? options.centerZOverride
            : (preserveDrawCrossBounds && Number.isFinite(savedBounds.centerZ) ? savedBounds.centerZ : effectiveCenterZ);

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

        const marginFactor = 1.1;
        const visibleHeight = maxY * 2 * marginFactor;
        const visibleWidth = effectiveTotalLength * marginFactor;

        if (camera.isOrthographicCamera) {
            if (preserveDrawCrossBounds) {
                camera.left = savedBounds.left;
                camera.right = savedBounds.right;
                camera.top = savedBounds.top;
                camera.bottom = savedBounds.bottom;
            } else {
                let viewHeight, viewWidth;
                const contentAspect = visibleWidth / visibleHeight;

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

        const cameraDistance = 300;
        const targetX = targetOverride ? targetOverride.x : 0;
        const targetY = targetOverride ? targetOverride.y : 0;
        const targetZ = targetOverride ? targetOverride.z : systemCenterZ;

        camera.position.set(targetX - cameraDistance, targetY, targetZ);
        camera.lookAt(targetX, targetY, targetZ);
        camera.up.set(0, 1, 0);

        controls.target.set(targetX, targetY, targetZ);
        controls.update();

        camera.updateProjectionMatrix();

        if (options.storeDrawCrossBounds === true && camera.isOrthographicCamera) {
            camera.userData.__drawCrossOrthoBounds = {
                left: camera.left,
                right: camera.right,
                top: camera.top,
                bottom: camera.bottom,
                centerZ: targetZ
            };
        }

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

        const rangeData = calculateOpticalSystemZRange();
        if (!rangeData) {
            return;
        }

        const { minZ, maxZ, maxY } = rangeData;
        const includeRayStartMargin = options.includeRayStartMargin !== false;
        const rayStartMargin = includeRayStartMargin ? 25 : 0;
        const effectiveMinZ = Math.min(minZ, -rayStartMargin);
        const effectiveMaxZ = maxZ;
        const effectiveTotalLength = effectiveMaxZ - effectiveMinZ;
        const effectiveCenterZ = (effectiveMinZ + effectiveMaxZ) / 2;

        const savedBounds = camera?.userData?.__drawCrossOrthoBounds;
        const preserveDrawCrossBounds = options.preserveDrawCrossBounds === true && savedBounds;
        const targetCenterZ = Number.isFinite(options.centerZOverride)
            ? options.centerZOverride
            : (preserveDrawCrossBounds && Number.isFinite(savedBounds.centerZ) ? savedBounds.centerZ : effectiveCenterZ);

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

        const marginFactor = 1.1;
        const visibleHeight = maxY * 2 * marginFactor;
        const visibleWidth = effectiveTotalLength * marginFactor;

        if (camera.isOrthographicCamera) {
            if (preserveDrawCrossBounds) {
                camera.left = savedBounds.left;
                camera.right = savedBounds.right;
                camera.top = savedBounds.top;
                camera.bottom = savedBounds.bottom;
            } else {
                let viewHeight, viewWidth;
                const contentAspect = visibleWidth / visibleHeight;

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
        const targetX = targetOverride ? targetOverride.x : 0;
        const targetY = targetOverride ? targetOverride.y : 0;
        const targetZ = targetOverride ? targetOverride.z : targetCenterZ;

        camera.position.set(targetX, targetY + cameraDistance, targetZ);
        camera.lookAt(targetX, targetY, targetZ);
        camera.up.set(1, 0, 0);
        camera.updateProjectionMatrix();

        controls.target.set(targetX, targetY, targetZ);
        controls.update();

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
window['generateSurfaceOptions'] = generateSurfaceOptions;

// Export main functions
window['initializeApplication'] = initializeApplication;
installCooptWindowFacadeMarker();
exposeWindowValue('updateSurfaceNumberSelect', updateSurfaceNumberSelect, { overwrite: true });

// =============================================================================
// APPLICATION STARTUP
// =============================================================================

const startApplicationOnce = (() => {
    let started = false;
    let readyEmitted = false;
    const emitMainReady = () => {
        if (readyEmitted) return;
        readyEmitted = true;
        try {
            window['__cooptMainReady'] = true;
            window.dispatchEvent(new CustomEvent('coopt:main-ready'));
        } catch (e) {
            console.warn('⚠️ [Init] Failed to dispatch coopt:main-ready', e);
        }
    };
    return async () => {
        if (started) return;
        started = true;
        try {
            initAIAssistant();
            const appComponents = await initializeApplication();
        
            if (!appComponents) {
                throw new Error('Failed to initialize application components');
            }

            emitMainReady();
            setTimeout(() => {
                Promise.resolve(runPhaseCAutorunFromUrl()).catch((error) => {
                    console.error('❌ [PhaseC Autorun] Unexpected startup failure:', error);
                });
            }, 0);
        
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
                        showSemidiaRing: true,
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
        
        if (undoBtn) {
            undoBtn.addEventListener('click', () => {
                if (window.undoHistory) {
                    window.undoHistory.undo();
                }
            });
        }

        if (redoBtn) {
            redoBtn.addEventListener('click', () => {
                if (window.undoHistory) {
                    window.undoHistory.redo();
                }
            });
        }
        
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
            startApplicationOnce();
            return;
        }
        window.addEventListener('coopt:react-mounted', () => {
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
    
    let previousRayColorMode: string | null = null;
    try {
        previousRayColorMode = getRayColorMode();
        if (previousRayColorMode !== 'object') {
            try { setRayColorMode('object'); } catch (_) {}
        }

        // Object毎の光線数を集計
        const objectRayCount = {};
        tracedRays.forEach(rayData => {
            const objIndex = rayData.objectIndex || 0;
            objectRayCount[objIndex] = (objectRayCount[objIndex] || 0) + 1;
        });
        
        
        // 全ての光線を描画
        const rawObjectIndices = tracedRays
            .map((rayData) => Number.parseInt(String(
                rayData?.objectIndex ??
                rayData?.originalRay?.objectIndex ??
                rayData?.originalRay?.objIndex ??
                NaN
            ), 10))
            .filter((value) => Number.isFinite(value));
        const shouldNormalizeOneBasedObjectIndex =
            rawObjectIndices.length > 0 &&
            !rawObjectIndices.includes(0) &&
            rawObjectIndices.every((value) => value >= 1);

        tracedRays.forEach((rayData, index) => {
            if (!rayData.success) {
                return;
            }
            
            const rayPath = rayData.rayPath;
            if (!rayPath || rayPath.length === 0) {
                return;
            }
            
            // Object識別情報を取得
            const objectIndexRaw =
                rayData.objectIndex ??
                rayData.originalRay?.objectIndex ??
                rayData.originalRay?.objIndex ??
                0;
            const objectIndexNum = Number.parseInt(String(objectIndexRaw), 10);
            const objectIndex = Number.isFinite(objectIndexNum) ? Math.max(0, objectIndexNum) : 0;
            const normalizedObjectIndex = shouldNormalizeOneBasedObjectIndex
                ? Math.max(0, objectIndex - 1)
                : objectIndex;
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
                console.log(`   Object${normalizedObjectIndex + 1}位置: (${objectPosition.x}, ${objectPosition.y}, ${objectPosition.z})`);
            }
            
            // 色分けモードを取得
            const currentColorMode = getRayColorMode(); // 'object' または 'segment'
            
            // 光線の色を設定
            let rayColor;
            const colorSystem = RayColorSystem; // 有限系・無限系共通
            
            if (currentColorMode === 'object') {
                // Object別色分け
                rayColor = colorSystem.getColor(colorSystem.MODE.OBJECT, normalizedObjectIndex, null);
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
            
            // 光線の型に応じたobjectIdを構築
            // chief も Raynum>=2 のクロスビーム色に合わせて同一Object色へ寄せる
            let objectId;
            if (beamType === 'chief') {
                objectId = `cross-horizontal-obj${normalizedObjectIndex}`;
            } else if (beamType === 'horizontal') {
                objectId = `cross-horizontal-obj${normalizedObjectIndex}`;
            } else if (beamType === 'vertical') {
                objectId = `cross-vertical-obj${normalizedObjectIndex}`;
            } else {
                // フォールバック
                objectId = `cross-vertical-obj${normalizedObjectIndex}`;
            }
            
            // 光線パスを描画（正しいパラメータで呼び出し）
            drawRayWithSegmentColors(rayPath, objectId, index, scene);
        });

    } catch (error) {
    } finally {
        if (previousRayColorMode && previousRayColorMode !== 'object') {
            try { setRayColorMode(previousRayColorMode); } catch (_) {}
        }
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
if (analysisSelect && (analysisSelect as HTMLElement).getAttribute('data-react-handled') !== '1') {
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
            'magnification-chromatic-aberration': 'open-magnification-chromatic-aberration-window-btn',
            'integrated-aberration': 'open-integrated-aberration-window-btn',
            'transverse-aberration': 'open-transverse-aberration-window-btn',
            'opd': 'open-opd-window-btn',
            'psf': 'open-psf-window-btn',
            'mtf': 'open-mtf-window-btn',
            'through-focus-spot': 'open-through-focus-spot-window-btn',
            'through-focus-mtf': 'open-through-focus-mtf-window-btn',
            'field-mtf': 'open-field-mtf-window-btn'
        };
        
        const btnId = buttonMap[value];
        if (btnId) {
            try {
                if (typeof (window as any).setupAnalysisWindows === 'function') {
                    (window as any).setupAnalysisWindows();
                }
            } catch (_) {}
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
    }
}

// Export for use in other modules
window['clearUndoHistoryOnMajorChange'] = clearUndoHistoryOnMajorChange;