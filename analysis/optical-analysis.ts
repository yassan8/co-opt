// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

/**
 * Optical Analysis Module
 * Handles PSF, spot diagram, and aberration analysis functions
 */

import * as THREE from 'three';
import { getOpticalSystemRows, getObjectRows, getSourceRows } from '../utils/data-utils.ts';
import { expandBlocksToOpticalSystemRows } from '../data/block-schema.ts';
import { loadSystemConfigurations } from '../data/table-configuration.ts';
import { loadTableData as loadSourceTableData } from '../data/table-source.ts';
import { detectConjugateType } from '../utils/conjugate-detection.ts';
import { generateRayStartPointsForObject } from '../optical/ray-renderer.ts';
import { getSpotDiagramPattern, loadSpotDiagramSettingsByConfigId, saveSpotDiagramSettingsByConfigId, saveLastSpotDiagramSettings } from '../ui/spot-diagram-settings-storage.ts';
import { getScene, getCamera, getRenderer, getControls, getTableOpticalSystem, getTableObject, getTableSource,
         getIsGeneratingSpotDiagram, getIsGeneratingTransverseAberration,
         setIsGeneratingSpotDiagram, setIsGeneratingTransverseAberration } from '../core/app-config.ts';

const console = globalThis.console as Console;

let spotDiagramRequestCounter = 0;
let pendingSpotDiagramRequest: { requestId: number; options: any; requestedAt: number } | null = null;
let analysisRustTraceOptionsCache: { options: any; at: number; forceKey: string } | null = null;
let analysisRustTraceOptionsPromise: Promise<any | null> | null = null;

async function resolveAnalysisRustTraceOptions(options: { forceRustWasm?: boolean; requireRustWasm?: boolean } = {}): Promise<any | null> {
    const forceRustWasm = options.forceRustWasm === true;
    const requireRustWasmFromCaller = options.requireRustWasm === true;
    const forceKey = `${forceRustWasm ? 'force' : 'auto'}:${requireRustWasmFromCaller ? 'require' : 'allow'}`;
    const now = Date.now();
    if (analysisRustTraceOptionsCache && analysisRustTraceOptionsCache.forceKey === forceKey && (now - analysisRustTraceOptionsCache.at) < 3000) {
        return analysisRustTraceOptionsCache.options;
    }

    if (analysisRustTraceOptionsPromise) {
        return analysisRustTraceOptionsPromise;
    }

    analysisRustTraceOptionsPromise = (async () => {
        const allowTsFallback = (() => {
            try {
                return typeof window !== 'undefined' && (window as any).__COOPT_ALLOW_TS_ANALYSIS_FALLBACK === true;
            } catch (_) {
                return false;
            }
        })();
        const preferRustWasm = (() => {
            if (forceRustWasm) return true;
            if (!allowTsFallback) return true;
            try {
                return !(typeof window !== 'undefined' && (window as any).__COOPT_DISABLE_RUST_WASM_ANALYSIS === true);
            } catch (_) {
                return true;
            }
        })();
        const requireRustWasm = (() => {
            if (!allowTsFallback) return true;
            if (requireRustWasmFromCaller) return true;
            try {
                return typeof window !== 'undefined' && (window as any).__COOPT_REQUIRE_RUST_WASM_ANALYSIS === true;
            } catch (_) {
                return false;
            }
        })();

        if (!preferRustWasm) {
            analysisRustTraceOptionsCache = { options: null, at: Date.now(), forceKey };
            return null;
        }

        try {
            const rustWasm = await import('../rust-wasm/ts/raytracing/rust-raytracing-wasm.ts');
            const api = rustWasm.getRustRayTracingWasmSync?.() || await rustWasm.preloadRustRayTracingWasm?.();
            if (api) {
                const options = {
                    useRustWasm: true,
                    requireRustWasm,
                    allowNonStrict: !requireRustWasm
                };
                try {
                    (window as any).__COOPT_LAST_ANALYSIS_BACKEND = {
                        kind: 'rust-wasm',
                        forced: forceRustWasm,
                        at: Date.now()
                    };
                    console.warn('🧭 [Analysis Backend] Rust-WASM');
                } catch (_) {}
                analysisRustTraceOptionsCache = { options, at: Date.now(), forceKey };
                return options;
            }

            const errorDetail = (typeof rustWasm.getRustRayTracingWasmInitError === 'function')
                ? rustWasm.getRustRayTracingWasmInitError()
                : null;
            if (requireRustWasm) {
                throw new Error(`Rust WASM is unavailable${errorDetail ? ` (${errorDetail})` : ''}`);
            }
            try {
                (window as any).__COOPT_LAST_ANALYSIS_BACKEND = {
                    kind: 'js',
                    detail: errorDetail || 'Rust WASM unavailable',
                    forced: forceRustWasm,
                    at: Date.now()
                };
                console.warn(`🧭 [Analysis Backend] JavaScript fallback${errorDetail ? ` (${errorDetail})` : ''}`);
            } catch (_) {}
            analysisRustTraceOptionsCache = { options: null, at: Date.now(), forceKey };
            return null;
        } catch (error: any) {
            if (requireRustWasm) {
                throw error;
            }
            try {
                const detail = String(error?.message || error || 'Rust WASM init failed');
                (window as any).__COOPT_LAST_ANALYSIS_BACKEND = {
                    kind: 'js',
                    detail,
                    forced: forceRustWasm,
                    at: Date.now()
                };
                console.warn(`🧭 [Analysis Backend] JavaScript fallback (${detail})`);
            } catch (_) {}
            analysisRustTraceOptionsCache = { options: null, at: Date.now(), forceKey };
            return null;
        }
    })();

    try {
        return await analysisRustTraceOptionsPromise;
    } finally {
        analysisRustTraceOptionsPromise = null;
    }
}

function cloneOpticalSystemRowsWithDefocusShift(opticalSystemRows: any[], defocusShiftMm: number, isFiniteObject: boolean = false): any[] {
    const shift = Number(defocusShiftMm);
    if (!Array.isArray(opticalSystemRows)) return [];

    const cloned = opticalSystemRows.map((row) => (row && typeof row === 'object') ? { ...row } : row);
    if (!Number.isFinite(shift) || Math.abs(shift) < 1e-15) return cloned;

    // Through-Focus: always shift the image plane (evaluation surface)
    // This is standard for both finite and infinite conjugates
    const imageIdx = cloned.findIndex((row) => row && (row['object type'] === 'Image' || row.object === 'Image'));
    const targetIdx = (imageIdx > 0) ? (imageIdx - 1) : Math.max(0, cloned.length - 2);
    if (targetIdx < 0 || targetIdx >= cloned.length) return cloned;

    const target = (cloned[targetIdx] && typeof cloned[targetIdx] === 'object') ? { ...cloned[targetIdx] } : {};
    const baseThickness = Number(target.thickness);
    const safeBaseThickness = Number.isFinite(baseThickness) ? baseThickness : 0;
    target.thickness = safeBaseThickness + shift;
    cloned[targetIdx] = target;

    return cloned;
}

/**
 * Create field setting from object data for PSF calculation
 */
export function createFieldSettingFromObject(objectData: any): any {
    if (!objectData) {
        console.error('❌ Object data is null or undefined');
        return null;
    }

    // Objectテーブルのキー揺れを吸収
    const objectTypeRaw = String(objectData.position ?? objectData.object ?? objectData.Object ?? objectData.objectType ?? 'Point');
    const objectType = objectTypeRaw.toLowerCase();
    const xVal = (objectData.x ?? objectData.xHeightAngle ?? objectData.x_height_angle ?? 0);
    const yVal = (objectData.y ?? objectData.yHeightAngle ?? objectData.y_height_angle ?? 0);

    const fieldSetting: any = {
        fieldType: objectTypeRaw,
        type: objectTypeRaw,
        displayName: `Object ${objectData.id ?? ''} (${objectTypeRaw})`,
        id: objectData.id
    };

    if (objectType.includes('angle')) {
        fieldSetting.fieldAngle = {
            x: Number(xVal) || 0,
            y: Number(yVal) || 0
        };
        fieldSetting.xHeight = 0;
        fieldSetting.yHeight = 0;
    } else {
        // Point/Rectangle/Height 等は高さ扱い
        fieldSetting.fieldAngle = { x: 0, y: 0 };
        fieldSetting.xHeight = Number(xVal) || 0;
        fieldSetting.yHeight = Number(yVal) || 0;
    }
    
    console.log('🎯 Created field setting for PSF:', fieldSetting);
    return fieldSetting;
}

/**
 * Clear all drawing elements from the scene
 */
export function clearAllDrawing(): void {
    const scene = getScene();
    if (!scene) return;
    
    console.log('🧹 Clearing all drawing elements...');
    
    // Create a list of objects to remove
    const objectsToRemove: any[] = [];
    
    // Collect all objects except lights
    scene.children.forEach(child => {
        if (child.type !== 'AmbientLight' && child.type !== 'DirectionalLight') {
            objectsToRemove.push(child);
        }
    });
    
    // Remove all collected objects
    objectsToRemove.forEach(obj => {
        scene.remove(obj);
        
        // Dispose of geometries and materials to free memory
        if ((obj as any).geometry) {
            (obj as any).geometry.dispose();
        }
        if ((obj as any).material) {
            if (Array.isArray((obj as any).material)) {
                (obj as any).material.forEach((mat: any) => mat.dispose());
            } else {
                (obj as any).material.dispose();
            }
        }
    });
    
    console.log(`✅ Cleared ${objectsToRemove.length} objects from scene`);
}

/**
 * Show spot diagram
 */
export async function showSpotDiagram(options: any = {}): Promise<void> {
        const forceRustWasmTrace = (options && typeof options === 'object')
            ? options.forceRustWasmTrace === true
            : false;
        const requireRustWasmTrace = (options && typeof options === 'object')
            ? options.requireRustWasmTrace === true
            : false;

    console.log('🎯 Starting spot diagram generation...');

    const nowMs = () => {
        try {
            if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
                return performance.now();
            }
        } catch (_) {}
        return Date.now();
    };
    const profileStartMs = nowMs();

    const requestId = ++spotDiagramRequestCounter;
    const spotProfile: any = {
        requestId,
        startedAt: Date.now(),
        backend: null,
        input: null,
        result: null,
        timingsMs: {
            resolveBackend: 0,
            generateData: 0,
            render: 0,
            total: 0
        },
        status: 'running',
        error: null
    };

    // If a configuration switch is in progress, the Tabulator tables can be mid-update.
    // Defer this request so we don't mix old object rows with the new optical system.
    try {
        const isSwitching = typeof window !== 'undefined' && (w as any).__configurationSwitching === true;
        if (isSwitching) {
            pendingSpotDiagramRequest = { requestId, options, requestedAt: Date.now() };
            console.warn(`⚠️ Spot diagram requested during configuration switching; queued request ${requestId}`);
            // Retry soon; the finally-block queue runner will also pick up the latest request.
            setTimeout(() => {
                try {
                    const still = typeof window !== 'undefined' && (w as any).__configurationSwitching === true;
                    if (!still) {
                        showSpotDiagram(options).catch(() => {});
                    }
                } catch (_) {}
            }, 50);
            return;
        }
    } catch (_) {}

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;
    const chiefRayDefinition = (options && typeof options === 'object' && typeof options.chiefRayDefinition === 'string')
        ? options.chiefRayDefinition
        : 'stop-center';
    const logChiefRayDefinition = (options && typeof options === 'object')
        ? !!options.logChiefRayDefinition
        : false;
    const useActiveConfigSnapshot = (options && typeof options === 'object')
        ? options.useActiveConfigSnapshot === true
        : false;
    const configId = (options && typeof options === 'object')
        ? options.configId
        : null;

    // Default target container is the in-page one
    let containerTarget: any = 'spot-diagram-container';
    if (options && typeof options === 'object') {
        if (options.containerElement) {
            containerTarget = options.containerElement;
        } else if (typeof options.containerId === 'string' && options.containerId.trim() !== '') {
            containerTarget = options.containerId;
        }
    }
    
    // Check if already generating
    // IMPORTANT: When switching configurations quickly, we must not drop the latest request.
    // If we just `return`, the UI can keep showing spot data computed from the previous config.
    if (getIsGeneratingSpotDiagram()) {
        pendingSpotDiagramRequest = { requestId, options, requestedAt: Date.now() };
        console.warn(`⚠️ Spot diagram generation already in progress; queued request ${requestId}`);
        return;
    }
    
    try {
        setIsGeneratingSpotDiagram(true);

        try { onProgress?.({ percent: 0, message: 'Preparing spot diagram...' }); } catch (_) {}
        
        const providedSurfaceIndex = Number.isInteger(options?.surfaceIndex) ? options.surfaceIndex : null;
        const providedSurfaceRowIndex = Number.isInteger(options?.surfaceRowIndex) ? options.surfaceRowIndex : null;
        const providedSurfaceRowId = (options && typeof options === 'object' && options.surfaceRowId !== undefined && options.surfaceRowId !== null)
            ? String(options.surfaceRowId).trim()
            : '';
        const providedSurfaceRowSig = (options && typeof options === 'object' && options.surfaceRowSig !== undefined && options.surfaceRowSig !== null)
            ? String(options.surfaceRowSig).trim()
            : '';
        const providedSurfaceIsImage = (options && typeof options === 'object')
            ? options.surfaceIsImage === true
            : false;
        const providedRayCount = Number.isInteger(options?.rayCount) ? options.rayCount : null;
        const providedWavelengthNm = Number.isFinite(options?.wavelengthNm) ? options.wavelengthNm : null;
        const providedRingCount = Number.isInteger(options?.ringCount) ? options.ringCount : null;

        // Get selected parameters with fallback defaults
        const surfaceSelect = document.getElementById('surface-number-select') as HTMLSelectElement | null;
        const rayCountInput = document.getElementById('ray-count-input') as HTMLInputElement | null;
        const wavelengthInput = document.getElementById('wavelength-input') as HTMLInputElement | null;
        const ringCountSelect = document.getElementById('ring-count-select') as HTMLSelectElement | null;
        const resolveActiveConfigId = () => {
            try {
                if (typeof localStorage === 'undefined') return '';
                const sys = loadSystemConfigurations();
                const activeId = (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                    ? String(sys.activeConfigId).trim()
                    : '';
                return activeId;
            } catch (_) {
                return '';
            }
        };
        const activeConfigId = resolveActiveConfigId();
        const selectedConfigId = activeConfigId;
        
        // Use defaults if form elements not found
        // NOTE: Spot Diagram UI uses a CB-invariant "surface id" (Object=0, first physical surface=1, ...).
        // We resolve that id to an actual row index after loading opticalSystemRows.
        let surfaceIndex = 0;  // temporarily treated as surfaceId
        let rayCount = 501;    // Default ray count
        let wavelength = 550;  // Default wavelength (nm)
        let ringCount = 3;     // Default annular ring count
        
        if (providedSurfaceIndex !== null && providedSurfaceIndex >= 0) {
            surfaceIndex = providedSurfaceIndex;
            console.log(`📊 Using surface id from options: ${surfaceIndex}`);
        } else if (surfaceSelect && surfaceSelect.value !== '') {
            surfaceIndex = parseInt(surfaceSelect.value, 10);
            console.log(`📊 Using surface id from select: ${surfaceIndex}`);
        } else {
            console.warn('⚠️ Surface select not found, using default (image surface)');
            // Get optical system data to determine last surface
            const tableOpticalSystem = getTableOpticalSystem();
            const opticalSystemData = getOpticalSystemRows(tableOpticalSystem);
            if (opticalSystemData && opticalSystemData.length > 0) {
                // Fallback: choose the last non-CB surface id (approx).
                surfaceIndex = opticalSystemData.length - 1;
                console.log(`📊 Using last surface (fallback) as default: ${surfaceIndex}`);
            } else {
                console.warn('⚠️ No optical system data available for default surface calculation');
            }
        }
        
        if (providedRayCount !== null && providedRayCount > 0) {
            rayCount = providedRayCount;
        } else if (rayCountInput && rayCountInput.value !== '') {
            rayCount = parseInt(rayCountInput.value) || 501;
        } else {
            console.warn('⚠️ Ray count input not found, using default (501)');
        }
        
        const isPrimarySourceRow = (raw: any): boolean => {
            if (raw === true || raw === 1) return true;
            const s = String(raw ?? '').trim().toLowerCase();
            return s.includes('primary') || s === 'true' || s === 'yes' || s === '1';
        };

        const resolveLivePrimaryWavelengthNm = (): number | null => {
            try {
                const src = (typeof window !== 'undefined' && w.tableSource && typeof w.tableSource.getData === 'function')
                    ? w.tableSource.getData()
                    : null;
                if (!Array.isArray(src) || src.length === 0) return null;
                const parsed = src
                    .map((row: any) => ({
                        wlUm: Number(row?.wavelength),
                        isPrimary: isPrimarySourceRow(row?.primary)
                    }))
                    .filter((entry: any) => Number.isFinite(entry.wlUm) && entry.wlUm > 0);
                const primary = parsed.find((entry: any) => entry.isPrimary) || parsed[0] || null;
                if (!primary) return null;
                return Number(primary.wlUm) * 1000;
            } catch (_) {
                return null;
            }
        };

        const resolvedProvidedWavelengthNm = (() => {
            if (providedWavelengthNm !== null && providedWavelengthNm > 0) return providedWavelengthNm;
            const livePrimaryNm = resolveLivePrimaryWavelengthNm();
            if (Number.isFinite(livePrimaryNm) && livePrimaryNm! > 0) return livePrimaryNm;
            return null;
        })();

        if (resolvedProvidedWavelengthNm !== null && resolvedProvidedWavelengthNm > 0) {
            wavelength = resolvedProvidedWavelengthNm;
        } else {
            console.log('ℹ️ No explicit wavelength option, will use Source primary wavelength after rows load');
        }

        if (providedRingCount !== null && providedRingCount > 0) {
            ringCount = providedRingCount;
        } else if (ringCountSelect && ringCountSelect.value !== '') {
            const parsedRingCount = parseInt(ringCountSelect.value, 10);
            ringCount = Number.isInteger(parsedRingCount) && parsedRingCount > 0 ? parsedRingCount : 3;
        } else {
            console.warn('⚠️ Ring count select not found, using default (3)');
        }
        
        if (isNaN(surfaceIndex) || surfaceIndex < 0) {
            surfaceIndex = 0;
            console.warn('⚠️ Invalid surface id, using default (0)');
        }

        const resolveSpotPattern = () => {
            const explicit = String(options?.pattern || '').trim().toLowerCase();
            if (explicit === 'grid' || explicit === 'annular') return explicit;
            try {
                const p = getSpotDiagramPattern();
                if (p === 'grid' || p === 'annular') return p;
            } catch (_) {}
            const annularBtn = document.getElementById('annular-pattern-btn');
            const gridBtn = document.getElementById('grid-pattern-btn');
            if (gridBtn && gridBtn.classList.contains('active')) return 'grid';
            if (annularBtn && annularBtn.classList.contains('active')) return 'annular';
            try {
                if (typeof window !== 'undefined' && typeof w.getRayEmissionPattern === 'function') {
                    const p = String(w.getRayEmissionPattern() || '').trim().toLowerCase();
                    if (p === 'grid' || p === 'annular') return p;
                }
            } catch (_) {}
            try {
                const map = loadSpotDiagramSettingsByConfigId();
                const entry = (map && selectedConfigId) ? map[selectedConfigId] : null;
                const p = entry && typeof entry.pattern === 'string' ? entry.pattern.trim().toLowerCase() : '';
                if (p === 'grid' || p === 'annular') return p;
            } catch (_) {}
            return 'annular';
        };
        const patternFromUi = resolveSpotPattern();
        try {
            if (typeof window !== 'undefined' && typeof w.setRayEmissionPattern === 'function') {
                w.setRayEmissionPattern(patternFromUi);
            }
        } catch (_) {}

        const surfaceId = surfaceIndex;
        console.log(`🎯 Generating spot diagram for surfaceId ${surfaceId}, ${rayCount} rays, ${wavelength}nm, ring count ${ringCount}`);
        
        // Get data either from active UI tables or from a selected configuration snapshot.
        const loadRowsForSelectedConfig = () => {
            // Spot diagram should not depend on whatever config is currently active.
            // In particular, do NOT override semidia/aperture values from the current UI table when evaluating
            // a different configuration, otherwise spot sizes change after switching configs.
            const USE_CURRENT_TABLE_SEMIDIA_FOR_OTHER_CONFIGS = false;

            if (!selectedConfigId) {
                console.log(`🔍 [Load Rows] Using CURRENT tables (no config selected)`);
                const tableOpticalSystem = getTableOpticalSystem();
                const tableObject = getTableObject();
                const tableSource = getTableSource();
                const rows = {
                    opticalSystemRows: getOpticalSystemRows(tableOpticalSystem),
                    objectRows: getObjectRows(tableObject),
                    sourceRows: getSourceRows(tableSource)
                };
                console.log(`🔍 [Load Rows] Current: opticalSystem=${rows.opticalSystemRows?.length}, objects=${rows.objectRows?.length}`);
                return rows;
            }

            console.log(`🔍 [Load Rows] Loading Config "${selectedConfigId}"`);
            const isPlainObject = (v: any) => !!v && typeof v === 'object' && !Array.isArray(v);
            const cloneJson = (v: any) => {
                try { return JSON.parse(JSON.stringify(v)); } catch { return null; }
            };
            
            // Debug: Check what's in localStorage
            try {
                if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
                const sys = loadSystemConfigurations();
                const cfg = Array.isArray(sys?.configurations) ? sys.configurations.find((c: any) => String(c?.id) === String(selectedConfigId)) : null;
                if (cfg) {
                    console.log(`🔍 [Config Content] Config "${selectedConfigId}":`, {
                        hasBlocks: Array.isArray(cfg.blocks) && cfg.blocks.length > 0,
                        blockCount: cfg.blocks?.length || 0,
                        hasOpticalSystem: Array.isArray(cfg.opticalSystem) && cfg.opticalSystem.length > 0,
                        opticalSystemLength: cfg.opticalSystem?.length || 0,
                        hasObject: Array.isArray(cfg.object) && cfg.object.length > 0,
                        objectLength: cfg.object?.length || 0,
                        firstOpticalSurface: cfg.opticalSystem?.[0] || null
                    });
                } else {
                    console.error(`❌ [Config Not Found] Config "${selectedConfigId}" not found in localStorage`);
                }
            } catch (e) {
                console.error(`❌ [Config Read Error]:`, e);
            }
            
            const parseOverrideKey = (variableId: any) => {
                const s = String(variableId ?? '');
                const dot = s.indexOf('.');
                if (dot <= 0) return null;
                const blockId = s.slice(0, dot);
                const key = s.slice(dot + 1);
                if (!blockId || !key) return null;
                return { blockId, key };
            };
            const normalizeObjectRows = (rows: any) => {
                if (!Array.isArray(rows)) return [];
                return rows.map((r: any) => {
                    if (!r || typeof r !== 'object') return r;
                    const out = { ...r };
                    if (out.xHeightAngle == null && out['object x'] != null) out.xHeightAngle = out['object x'];
                    if (out.yHeightAngle == null && out['object y'] != null) out.yHeightAngle = out['object y'];
                    if (out.xHeightAngle == null && out.x != null) out.xHeightAngle = out.x;
                    if (out.yHeightAngle == null && out.y != null) out.yHeightAngle = out.y;
                    if (out.position == null && out.objectType != null) out.position = out.objectType;
                    return out;
                });
            };
            const applyOverridesToBlocks = (blocks: any, overrides: any) => {
                const cloned = cloneJson(blocks);
                if (!Array.isArray(cloned)) return Array.isArray(blocks) ? blocks : [];
                if (!isPlainObject(overrides)) return cloned;

                const byId = new Map();
                for (const b of cloned) {
                    const id = isPlainObject(b) ? String(b.blockId ?? '') : '';
                    if (id) byId.set(id, b);
                }

                for (const [varId, rawVal] of Object.entries(overrides)) {
                    const parsed = parseOverrideKey(varId);
                    if (!parsed) continue;
                    const blk = byId.get(String(parsed.blockId));
                    if (!blk || !isPlainObject(blk.parameters)) continue;
                    const n = Number(rawVal);
                    blk.parameters[parsed.key] = Number.isFinite(n) ? n : rawVal;
                }

                return cloned;
            };

            try {
                const sys = (typeof localStorage === 'undefined') ? null : loadSystemConfigurations();

                const activeId = (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                    ? String(sys.activeConfigId)
                    : '';

                const isConfigSwitching = (() => {
                    try {
                        return typeof window !== 'undefined' && (w as any).__configurationSwitching === true;
                    } catch {
                        return false;
                    }
                })();

                // If the selected config is the active one, prefer live UI tables to avoid stale snapshot data.
                // However, if the UI tables are still stale (race after config switch), fall back to snapshot.
                if (activeId && String(activeId) === String(selectedConfigId) && !isConfigSwitching) {
                    console.log(`🔍 [Load Rows] Selected config is ACTIVE; using current tables instead of snapshot`);
                    const tableOpticalSystem = getTableOpticalSystem();
                    const tableObject = getTableObject();
                    const tableSource = getTableSource();

                    const live = {
                        opticalSystemRows: getOpticalSystemRows(tableOpticalSystem),
                        objectRows: getObjectRows(tableObject),
                        sourceRows: getSourceRows(tableSource)
                    };

                    try {
                        const cfg = Array.isArray(sys?.configurations)
                            ? sys.configurations.find((c: any) => String(c?.id) === String(selectedConfigId))
                            : null;
                        const snapObj = normalizeObjectRows(Array.isArray(cfg?.object) ? cfg.object : []);
                        const liveObj = normalizeObjectRows(Array.isArray(live.objectRows) ? live.objectRows : []);
                        const keyOf = (r: any) => String(r?.id ?? '');
                        const byId = (rows: any[]) => {
                            const m = new Map<string, any>();
                            for (const r of rows) {
                                if (r && typeof r === 'object') {
                                    const k = keyOf(r);
                                    if (k) m.set(k, r);
                                }
                            }
                            return m;
                        };
                        const lm = byId(liveObj);
                        const sm = byId(snapObj);
                        const probeId = '2';
                        const l2 = lm.get(probeId);
                        const s2 = sm.get(probeId);
                        const normPos = (v: any) => String(v ?? '').trim().toLowerCase();
                        if (l2 && s2) {
                            const lp = normPos(l2.position);
                            const sp = normPos(s2.position);
                            const ly = Number(l2.yHeightAngle ?? l2.y ?? l2['object y']);
                            const sy = Number(s2.yHeightAngle ?? s2.y ?? s2['object y']);
                            if (lp !== sp || (Number.isFinite(ly) && Number.isFinite(sy) && Math.abs(ly - sy) > 1e-9)) {
                                console.warn('⚠️ [Load Rows] Live Object table differs from config snapshot; using snapshot for Object rows', {
                                    live: { position: l2.position, yHeightAngle: l2.yHeightAngle },
                                    snapshot: { position: s2.position, yHeightAngle: s2.yHeightAngle }
                                });
                                return { ...live, objectRows: snapObj };
                            }
                        }
                    } catch (_) {}

                    return live;
                }

                // Always use the selected config snapshot (not active UI tables).
                // This keeps Spot Diagram independent of ActiveConfig selection.

                const cfg = Array.isArray(sys?.configurations)
                    ? sys.configurations.find((c: any) => String(c?.id) === String(selectedConfigId))
                    : null;

                // Prefer cached optical rows for the selected config (avoids mixing after CB insertion).
                try {
                    if (cfg && typeof window !== 'undefined' && w.__cooptOpticalSystemByConfigId) {
                        const cached = w.__cooptOpticalSystemByConfigId[String(selectedConfigId)];
                        if (Array.isArray(cached) && cached.length > 0) {
                            console.log(`🔍 [Cache Hit] Config "${selectedConfigId}": Using cached opticalSystemRows (${cached.length} surfaces)`);
                            
                            // Clone cached data. Do NOT override semidias from the current UI table here;
                            // cached rows belong to the selected config and should be self-consistent.
                            const cachedRows = JSON.parse(JSON.stringify(cached));
                            
                            return {
                                opticalSystemRows: cachedRows,
                                objectRows: normalizeObjectRows(Array.isArray(cfg?.object) ? cfg.object : []),
                                sourceRows: (() => {
                                    try {
                                        const rows = loadSourceTableData();
                                        return Array.isArray(rows) ? rows : [];
                                    } catch (_) {
                                        return [];
                                    }
                                })()
                            };
                        } else {
                            console.log(`🔍 [Cache Miss] Config "${selectedConfigId}": Cache empty or invalid, will expand blocks`);
                        }
                    } else {
                        console.log(`🔍 [No Cache] Config "${selectedConfigId}": No cache object found, will expand blocks`);
                    }
                } catch (_) {}

                console.log(`🔍 [Block Expansion] Config "${selectedConfigId}": Expanding blocks to optical system`);
                const expandedOptical = (() => {
                    try {
                        if (!cfg || !Array.isArray(cfg.blocks) || cfg.blocks.length === 0) {
                            console.log(`⚠️ [Block Expansion] Config "${selectedConfigId}": No blocks found (cfg=${!!cfg}, blocks=${cfg?.blocks?.length})`);
                            return null;
                        }
                        const scenarios = Array.isArray(cfg.scenarios) ? cfg.scenarios : null;
                        const scenarioId = cfg.activeScenarioId ? String(cfg.activeScenarioId) : '';
                        const scn = (scenarioId && scenarios)
                            ? scenarios.find((s: any) => s && String(s.id) === String(scenarioId))
                            : null;
                        const overrides = scn && isPlainObject(scn.overrides) ? scn.overrides : null;
                        const blocksToExpand = overrides ? applyOverridesToBlocks(cfg.blocks, overrides) : cfg.blocks;
                        const exp = expandBlocksToOpticalSystemRows(blocksToExpand);
                        console.log(`🔍 [Block Expansion] Config "${selectedConfigId}": exp=${!!exp}, exp.rows=${exp?.rows?.length}`);
                        if (!exp || !Array.isArray(exp.rows)) {
                            console.log(`⚠️ [Block Expansion] Config "${selectedConfigId}": Block expansion failed`);
                            return null;
                        }
                        // Preserve semidia (aperture) from persisted opticalSystem when available.
                        // Blocks expansion uses schema defaults (e.g., DEFAULT_SEMIDIA / DEFAULT_STOP_SEMI_DIAMETER),
                        // which can vignette rays unexpectedly compared to the saved table.
                        // For Spot Diagram, keep per-config semidias so other configs don't change when switching active config.
                        try {
                            const DISABLE_LEGACY_SEMIDIA_FOR_SPOT_DIAGRAM = false;
                            
                            if (!DISABLE_LEGACY_SEMIDIA_FOR_SPOT_DIAGRAM) {
                                const legacyRows = Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem : null;
                                const rows = exp.rows;

                                const normType = (r: any) => String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
                                const findBlockById = (blockId: any) => {
                                    if (!blockId) return null;
                                    const bid = String(blockId);
                                    return Array.isArray(blocksToExpand)
                                        ? blocksToExpand.find((b: any) => b && String(b.blockId) === bid)
                                        : null;
                                };
                                const getExplicitStopSemiDiameter = (blockId: any) => {
                                    const b = findBlockById(blockId);
                                    const v = b?.parameters?.semiDiameter;
                                    const n = Number(v);
                                    return Number.isFinite(n) && n > 0 ? n : null;
                                };

                                if (legacyRows && rows.length > 0) {
                                    // Object row semidia can differ even when row counts differ.
                                    const legacyObj = legacyRows[0];
                                    const lo = String(legacyObj?.semidia ?? '').trim();
                                    if (lo !== '') rows[0] = { ...rows[0], semidia: legacyObj.semidia };

                                    const n = Math.min(legacyRows.length, rows.length);
                                    for (let i = 0; i < n; i++) {
                                        const legacy = legacyRows[i];
                                        const row = rows[i];
                                        if (!legacy || typeof legacy !== 'object' || !row || typeof row !== 'object') continue;

                                        const lsRaw = legacy.semidia;
                                        const ls = String(lsRaw ?? '').trim();
                                        if (ls === '') continue;

                                        const t = normType(row);
                                        // Skip Image surface - always use current table value for Spot Diagram
                                        if (t === 'image') continue;
                                        
                                        if (t === 'stop') {
                                            // If Stop block has an explicit semiDiameter (possibly via scenario override), keep it.
                                            const explicit = getExplicitStopSemiDiameter(row._blockId);
                                            if (explicit !== null) continue;
                                        }
                                        row.semidia = lsRaw;
                                    }
                                }
                            }
                        } catch (_) {}
                        // Historically we overrode semidias from the current UI table to avoid vignetting.
                        // That caused cross-config coupling, so keep it disabled by default.
                        if (USE_CURRENT_TABLE_SEMIDIA_FOR_OTHER_CONFIGS) {
                            try {
                                const rows = exp.rows;
                                const tableOpticalSystem = getTableOpticalSystem();
                                const currentOpticalRows = getOpticalSystemRows(tableOpticalSystem);
                                if (currentOpticalRows && rows && rows.length > 0) {
                                    const n = Math.min(rows.length, currentOpticalRows.length);
                                    for (let i = 0; i < n; i++) {
                                        const currentSemidia = currentOpticalRows[i]?.semidia;
                                        if (currentSemidia !== undefined && currentSemidia !== null && String(currentSemidia).trim() !== '') {
                                            rows[i] = { ...rows[i], semidia: currentSemidia };
                                        }
                                    }
                                }
                            } catch (err) {
                                console.error(`❌ [ALL SEMIDIA OVERRIDE Error] Config "${cfg?.name || cfg?.id || selectedConfigId}":`, err);
                            }
                        }
                        // Preserve Object row from persisted config (critical for finite object distance).
                        // Do NOT override with current table when evaluating non-active configs.
                        try {
                            const rows = exp.rows;
                            const hasObjectSurface = Array.isArray(cfg?.blocks) && cfg.blocks.some((b: any) => String(b?.blockType ?? '').trim() === 'ObjectSurface');
                            if (!hasObjectSurface) {
                                const legacyObjectRow = Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem[0] : null;
                                if (rows.length > 0 && legacyObjectRow) {
                                    console.log(`🔧 [Object Row Restore] Config "${cfg?.name || cfg?.id}": Using saved Object row`);
                                    console.log(`  Old Object: thickness=${rows[0]?.thickness}, fieldX=${rows[0]?.fieldX}, fieldY=${rows[0]?.fieldY}`);
                                    console.log(`  New Object: thickness=${legacyObjectRow?.thickness}, fieldX=${legacyObjectRow?.fieldX}, fieldY=${legacyObjectRow?.fieldY}`);
                                    rows[0] = { ...rows[0], ...legacyObjectRow };
                                } else {
                                    console.log(`⚠️ [Object Row Restore] Config "${cfg?.name || cfg?.id}": No saved Object row to restore (hasRows=${rows.length > 0}, hasLegacyObject=${!!legacyObjectRow})`);
                                }
                            }
                        } catch (err) {
                            console.error(`❌ [Object Row Restore Error]:`, err);
                        }
                        // Override Image surface semidia from current table to prevent vignetting off-axis objects.
                        // Saved configs may have outdated/smaller apertures that block angle objects (e.g., Object2).
                        try {
                            const rows = exp.rows;
                            console.log(`🔍 [Image Semidia Override Check] Config "${cfg?.name || cfg?.id}", rows.length=${rows.length}`);
                            if (rows.length > 0) {
                                const tableOpticalSystem = getTableOpticalSystem();
                                const currentOpticalRows = getOpticalSystemRows(tableOpticalSystem);
                                console.log(`🔍 [Image Semidia Override] currentOpticalRows.length=${currentOpticalRows?.length}`);
                                
                                // Find Image surface in both current and config rows
                                const normType = (r: any) => String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
                                const currentImageIdx = currentOpticalRows?.findIndex((r: any) => normType(r) === 'image');
                                const configImageIdx = rows.findIndex((r: any) => normType(r) === 'image');
                                
                                console.log(`🔍 [Image Semidia Override] currentImageIdx=${currentImageIdx}, configImageIdx=${configImageIdx}`);
                                
                                if (currentImageIdx >= 0 && configImageIdx >= 0) {
                                    const currentImageSemidia = currentOpticalRows[currentImageIdx]?.semidia;
                                    const configImageSemidia = rows[configImageIdx]?.semidia;
                                    
                                    console.log(`🔍 [Image Semidia Override] current=${currentImageSemidia}, config=${configImageSemidia}`);
                                    
                                    // Always use current table's semidia for Spot Diagram evaluation
                                    if (currentImageSemidia !== undefined && currentImageSemidia !== null && String(currentImageSemidia).trim() !== '') {
                                        const currentVal = Number(currentImageSemidia);
                                        console.log(`🔍 [Image Semidia Override] currentVal=${currentVal}, isFinite=${Number.isFinite(currentVal)}, gt0=${currentVal > 0}`);
                                        if (Number.isFinite(currentVal) && currentVal > 0) {
                                            console.log(`🔧 [Image Semidia Override] Config "${cfg?.name || cfg?.id}", surface ${configImageIdx}: ${configImageSemidia} → ${currentImageSemidia} (FORCED)`);
                                            rows[configImageIdx] = { ...rows[configImageIdx], semidia: currentImageSemidia };
                                        }
                                    }
                                }
                            }
                        } catch (err) {
                            console.error(`❌ [Image Semidia Override Error]`, err);
                        }
                        
                        // DEBUG: Compare all semidias between config and current table
                        try {
                            const rows = exp.rows;
                            const tableOpticalSystem = getTableOpticalSystem();
                            const currentOpticalRows = getOpticalSystemRows(tableOpticalSystem);
                            
                            console.log(`📊 [SEMIDIA COMPARISON] Config "${cfg?.name || cfg?.id}"`);
                            const maxLen = Math.max(rows?.length || 0, currentOpticalRows?.length || 0);
                            for (let i = 0; i < maxLen; i++) {
                                const configRow = rows?.[i];
                                const currentRow = currentOpticalRows?.[i];
                                const configSemidia = configRow?.semidia;
                                const currentSemidia = currentRow?.semidia;
                                const configType = configRow?.surfType || configRow?.['object type'] || configRow?.object;
                                const currentType = currentRow?.surfType || currentRow?.['object type'] || currentRow?.object;
                                
                                if (configSemidia !== currentSemidia) {
                                    console.log(`  ⚠️ Surface ${i} (${configType}): config=${configSemidia}, current=${currentSemidia}`);
                                } else {
                                    console.log(`  ✅ Surface ${i} (${configType}): ${configSemidia}`);
                                }
                            }
                        } catch (err) {
                            console.error(`❌ [SEMIDIA COMPARISON Error]`, err);
                        }
                        
                        return exp.rows;
                    } catch (_) {
                        return null;
                    }
                })();

                const result = {
                    opticalSystemRows: Array.isArray(expandedOptical) ? expandedOptical : (Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem : []),
                    objectRows: normalizeObjectRows(Array.isArray(cfg?.object) ? cfg.object : []),
                    // Source is global (shared across configurations).
                    sourceRows: (() => {
                        try {
                            const rows = loadSourceTableData();
                            return Array.isArray(rows) ? rows : [];
                        } catch (_) {
                            return [];
                        }
                    })()
                };
                
                
                // Do not globally override semidias from the current UI table.
                // If needed, enable USE_CURRENT_TABLE_SEMIDIA_FOR_OTHER_CONFIGS (kept false by default).
                
                console.log(`🔍 [Load Result] Config "${selectedConfigId}": opticalSystem=${result.opticalSystemRows?.length} (from ${Array.isArray(expandedOptical) ? 'BLOCK EXPANSION' : 'DIRECT cfg.opticalSystem'}), objects=${result.objectRows?.length}`);
                
                return result;
            } catch (e) {
                console.warn('⚠️ Failed to load Spot Diagram config snapshot, falling back to active tables:', e);
                const tableOpticalSystem = getTableOpticalSystem();
                const tableObject = getTableObject();
                const tableSource = getTableSource();
                return {
                    opticalSystemRows: getOpticalSystemRows(tableOpticalSystem),
                    objectRows: getObjectRows(tableObject),
                    sourceRows: getSourceRows(tableSource)
                };
            }
        };

        let { opticalSystemRows, objectRows, sourceRows } = loadRowsForSelectedConfig();

        const resolveEffectiveSourceRowsForSpot = (rows: any[]): any[] => {
            if (resolvedProvidedWavelengthNm !== null && resolvedProvidedWavelengthNm > 0) {
                return [{
                    id: 'spot-explicit-wavelength',
                    wavelength: Number(resolvedProvidedWavelengthNm) / 1000,
                    weight: 1,
                    primary: 'Primary Wavelength',
                    name: 'Explicit Wavelength'
                }];
            }

            if (!Array.isArray(rows) || rows.length === 0) {
                return [{
                    id: 'spot-default-wavelength',
                    wavelength: 0.5876,
                    weight: 1,
                    primary: 'Primary Wavelength',
                    name: 'Default d-line'
                }];
            }

            const parsed = rows
                .map((row: any, idx: number) => ({
                    idx,
                    row,
                    wl: Number(row?.wavelength),
                    isPrimary: isPrimarySourceRow(row?.primary)
                }))
                .filter((entry: any) => Number.isFinite(entry.wl) && entry.wl > 0);

            const primary = parsed.find((entry: any) => entry.isPrimary) || parsed[0] || null;
            if (!primary) {
                return [{
                    id: 'spot-default-wavelength',
                    wavelength: 0.5876,
                    weight: 1,
                    primary: 'Primary Wavelength',
                    name: 'Default d-line'
                }];
            }

            return [{
                ...(primary.row && typeof primary.row === 'object' ? primary.row : {}),
                wavelength: Number(primary.wl),
                weight: Number.isFinite(Number(primary.row?.weight)) ? Number(primary.row.weight) : 1,
                primary: 'Primary Wavelength'
            }];
        };

        const effectiveSourceRowsForSpot = resolveEffectiveSourceRowsForSpot(sourceRows);
        const sourcePrimaryWavelengthUm = Number(effectiveSourceRowsForSpot[0]?.wavelength) || 0.5876;
        wavelength = sourcePrimaryWavelengthUm * 1000;

        // (Debug logs removed) Config preview logs were too noisy for normal operation.
        
        // Check Image surface (index=20) semidia specifically
        if (opticalSystemRows && opticalSystemRows.length > 20) {
            const imageSurface = opticalSystemRows[20];
            console.log(`🔍 [IMAGE SURFACE DEBUG] Index=20:`, {
                surfType: imageSurface.surfType || imageSurface['surf type'],
                objectType: imageSurface['object type'] || imageSurface.objectType,
                semidia: imageSurface.semidia,
                radius: imageSurface.radius,
                thickness: imageSurface.thickness
            });
        }
        
        // Debug objectRows
        if (objectRows && objectRows.length > 0) {
            console.log(`🔍 [Object Debug] objectRows.length=${objectRows.length}`);
            objectRows.forEach((obj: any, idx: number) => {
                console.log(`🔍 [Object Debug] Object ${idx + 1}:`, {
                    id: obj.id,
                    position: obj.position,
                    'object x': obj['object x'],
                    'object y': obj['object y'],
                    angle: obj.angle,
                    'decenter y': obj['decenter y'],
                    vignetting: obj.vignetting
                });
            });
        } else {
            console.warn(`⚠️ [Object Debug] No objectRows found for config "${selectedConfigId}"`);
        }

        // Resolve CB-invariant surfaceId -> actual rowIndex in opticalSystemRows.
        // Use separated functions for finite and infinite conjugates to prevent mutual interference.
        let resolvedSurfaceRowIndex: number | null = null;
        const buildRowSig = (row: any): string => {
            try {
                const norm = (v: any) => String(v ?? '').trim().toLowerCase();
                const n0 = (v: any) => {
                    const x = Number(v);
                    return Number.isFinite(x) ? String(x) : norm(v);
                };
                const objTypeRaw = row?.['object type'] ?? row?.objectType ?? row?.object ?? '';
                const surfTypeRaw = row?.surfType ?? row?.['surf type'] ?? row?.type ?? '';
                const surfaceType = objTypeRaw || surfTypeRaw || 'Standard';
                return [
                    `t:${norm(surfaceType)}`,
                    `r:${n0(row?.radius ?? row?.R ?? '')}`,
                    `th:${n0(row?.thickness ?? row?.T ?? '')}`,
                    `sd:${n0(row?.semidia ?? row?.semiDia ?? '')}`,
                    `m:${norm(row?.material ?? row?.glass ?? row?.['glass'] ?? row?.refractiveIndex ?? '')}`,
                    `c:${norm(row?.comment ?? row?.name ?? '')}`
                ].join('|');
            } catch (_) {
                return '';
            }
        };
        if (providedSurfaceRowId) {
            const idxById = Array.isArray(opticalSystemRows)
                ? opticalSystemRows.findIndex((row: any) => row && row.id !== undefined && row.id !== null && String(row.id) === providedSurfaceRowId)
                : -1;
            if (Number.isInteger(idxById) && idxById >= 0) {
                resolvedSurfaceRowIndex = idxById;
                console.log(`✅ [Surface Resolution] Using explicit surfaceRowId=${providedSurfaceRowId} -> rowIndex=${resolvedSurfaceRowIndex}`);
            } else {
                console.warn(`⚠️ [Surface Resolution] surfaceRowId=${providedSurfaceRowId} not found in current rows`);
            }
        }
        if (resolvedSurfaceRowIndex === null && providedSurfaceRowSig) {
            const idxBySig = Array.isArray(opticalSystemRows)
                ? opticalSystemRows.findIndex((row: any) => buildRowSig(row) === providedSurfaceRowSig)
                : -1;
            if (Number.isInteger(idxBySig) && idxBySig >= 0) {
                resolvedSurfaceRowIndex = idxBySig;
                console.log(`✅ [Surface Resolution] Using explicit surfaceRowSig -> rowIndex=${resolvedSurfaceRowIndex}`);
            } else {
                console.warn('⚠️ [Surface Resolution] surfaceRowSig not found in current rows');
            }
        }
        if (Number.isInteger(providedSurfaceRowIndex) && providedSurfaceRowIndex !== null) {
            if (providedSurfaceRowIndex >= 0 && providedSurfaceRowIndex < opticalSystemRows.length) {
                if (resolvedSurfaceRowIndex === null) {
                    resolvedSurfaceRowIndex = providedSurfaceRowIndex;
                    console.log(`✅ [Surface Resolution] Using explicit surfaceRowIndex=${resolvedSurfaceRowIndex}`);
                }
            } else {
                console.warn(`⚠️ [Surface Resolution] Ignoring out-of-range surfaceRowIndex=${providedSurfaceRowIndex} (rows=${opticalSystemRows.length})`);
            }
        }

        if (resolvedSurfaceRowIndex === null && providedSurfaceIsImage) {
            const idxImage = Array.isArray(opticalSystemRows)
                ? opticalSystemRows.findIndex((row: any) => {
                    const objTypeRaw = String(row?.['object type'] ?? row?.objectType ?? row?.object ?? '').toLowerCase();
                    const surfTypeRaw = String(row?.surfType ?? row?.['surf type'] ?? row?.type ?? '').toLowerCase();
                    return objTypeRaw.includes('image') || surfTypeRaw.includes('image');
                })
                : -1;
            if (Number.isInteger(idxImage) && idxImage >= 0) {
                resolvedSurfaceRowIndex = idxImage;
                console.log(`✅ [Surface Resolution] Using explicit Image selection -> rowIndex=${resolvedSurfaceRowIndex}`);
            } else {
                console.warn('⚠️ [Surface Resolution] Explicit Image selection requested but no Image row found');
            }
        }
        try {
            const { generateSurfaceOptions } = await import('../evaluation/spot-diagram.js');
            const opts = generateSurfaceOptions(opticalSystemRows || []);

            if (providedSurfaceIsImage && Array.isArray(opts) && opts.length > 0) {
                const imageOpt = opts.find((o: any) => {
                    const label = String(o?.label ?? '').toLowerCase();
                    return label.includes('(image)') || label.includes(' image');
                });
                if (imageOpt && Number.isInteger(imageOpt.rowIndex)) {
                    resolvedSurfaceRowIndex = imageOpt.rowIndex;
                    console.log(`✅ [Surface Resolution] Explicit Image selection mapped via options -> rowIndex=${resolvedSurfaceRowIndex} (${imageOpt.label})`);
                } else if (Number.isInteger(opts[opts.length - 1]?.rowIndex)) {
                    resolvedSurfaceRowIndex = opts[opts.length - 1].rowIndex;
                    console.warn(`⚠️ [Surface Resolution] Explicit Image selection fallback -> last option rowIndex=${resolvedSurfaceRowIndex}`);
                }
            }
            
            // Detect conjugate type using unified detection
            const conjugateType = detectConjugateType(opticalSystemRows);
            
            console.log(`🔍 [Surface Resolution] Conjugate: ${conjugateType}, Looking for surfaceId=${surfaceId} in ${opts.length} options`);
            console.log(`🔍 [Surface Options Sample]:`, opts.slice(0, 3).map((o: any) => ({ surfaceId: o.surfaceId, value: o.value, rowIndex: o.rowIndex, label: o.label })));
            
            const resolveSurfaceRowIndex = (): number | null => {
                const imageOpt = opts.find((o: any) => typeof o?.label === 'string' && o.label.includes('(Image)'));
                const match = opts.find((o: any) => Number(o?.surfaceId) === Number(surfaceId));

                // Always honor explicit Surf selection first.
                if (match && Number.isInteger(match.rowIndex)) {
                    console.log(`✅ [Surface Resolution] Matched surfaceId=${surfaceId} → rowIndex=${match.rowIndex} (${match.label})`);
                    return match.rowIndex;
                }

                console.warn(`⚠️ [Surface Resolution] surfaceId=${surfaceId} not found in current config; fallback to Image/last`);

                if (imageOpt && Number.isInteger(imageOpt.rowIndex)) {
                    console.warn(`⚠️ [Surface Resolution] Using Image surface at rowIndex=${imageOpt.rowIndex}`);
                    return imageOpt.rowIndex;
                }

                if (opts.length > 0 && Number.isInteger(opts[opts.length - 1].rowIndex)) {
                    console.warn(`⚠️ [Surface Resolution] Using last surface at rowIndex=${opts[opts.length - 1].rowIndex}`);
                    return opts[opts.length - 1].rowIndex;
                }

                return null;
            };

            if (resolvedSurfaceRowIndex === null) {
                resolvedSurfaceRowIndex = resolveSurfaceRowIndex();
            }
            
            if (Number.isInteger(resolvedSurfaceRowIndex)) {
                console.log(`✅ [Surface Resolution] ${conjugateType} resolved: surfaceId=${surfaceId} → rowIndex=${resolvedSurfaceRowIndex}`);
            }
        } catch (e) {
            // As a last resort, keep the original number as an index.
            resolvedSurfaceRowIndex = Number.isInteger(surfaceId) ? surfaceId : 0;
            console.error(`❌ [Surface Resolution] Error:`, e);
        }

        if (Number.isInteger(resolvedSurfaceRowIndex) && resolvedSurfaceRowIndex !== null) {
            surfaceIndex = resolvedSurfaceRowIndex;
        }
        if (resolvedSurfaceRowIndex === null || !Number.isInteger(resolvedSurfaceRowIndex) || resolvedSurfaceRowIndex < 0) {
            resolvedSurfaceRowIndex = 0;
        }
        surfaceIndex = resolvedSurfaceRowIndex!;

        // Persist the current spot-diagram settings for other modules (e.g., Requirements spot size operands).
        // This also bridges main window vs popup window differences by using shared localStorage.
        try {
            const pattern = patternFromUi;

            let primaryWavelengthUm = sourcePrimaryWavelengthUm;

            // If wavelength was not explicitly provided by options, bind it to Source primary.
            if (!(resolvedProvidedWavelengthNm !== null && resolvedProvidedWavelengthNm > 0)) {
                wavelength = primaryWavelengthUm * 1000;
            }

            saveLastSpotDiagramSettings({
                surfaceId,
                surfaceRowIndex: surfaceIndex,
                rayCount,
                ringCount,
                pattern: pattern || null,
                primaryWavelengthUm,
                configId: selectedConfigId || null,
                updatedAt: Date.now()
            });

            // Also persist per-config settings so Requirements can evaluate
            // non-active configs without depending on whichever config was last opened.
            try {
                let cfgKey = selectedConfigId ? String(selectedConfigId).trim() : '';
                if (!cfgKey) {
                    if (typeof localStorage === 'undefined') return;
                    const sys = loadSystemConfigurations();
                    cfgKey = (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                        ? String(sys.activeConfigId).trim()
                        : '';
                }

                if (cfgKey) {
                    const map = loadSpotDiagramSettingsByConfigId();
                    map[cfgKey] = {
                        // Backward compat: surfaceIndex was historically a row index.
                        surfaceIndex,
                        surfaceId,
                        surfaceRowIndex: surfaceIndex,
                        rayCount,
                        ringCount,
                        pattern: pattern || null,
                        primaryWavelengthUm,
                        configId: cfgKey,
                        updatedAt: Date.now()
                    };
                    saveSpotDiagramSettingsByConfigId(map);
                    
                    // CRITICAL: Also update in-memory cache so merit evaluation uses latest settings immediately.
                    // This prevents Spot Diagram execution from requiring browser reload to update UR values.
                    if (typeof window !== 'undefined') {
                        if (!w.__cooptSpotDiagramSettingsByConfigId || typeof w.__cooptSpotDiagramSettingsByConfigId !== 'object') {
                            w.__cooptSpotDiagramSettingsByConfigId = {};
                        }
                        w.__cooptSpotDiagramSettingsByConfigId[cfgKey] = map[cfgKey];
                    }
                }
            } catch (_) {
                // ignore
            }
        } catch (_) {
            // ignore
        }
        
        // Debug data retrieval
        console.log('📊 Retrieved data:', { configId: selectedConfigId || '(Current)' });
        console.log('  - opticalSystemRows:', opticalSystemRows ? opticalSystemRows.length : 'null', opticalSystemRows);
        if (opticalSystemRows && opticalSystemRows.length > 0) {
            opticalSystemRows.forEach((row: any, idx: number) => {
                console.log(`    [${idx}]`, row);
            });
        } else {
            console.warn('⚠️ opticalSystemRows is empty! サンプルデータを自動生成します。');
            // サンプルデータ（仮）: 簡単なレンズ系
            opticalSystemRows = [
                { surfaceType: 'object', radius: 'INF', thickness: 'INF', refractiveIndex: 1.0, comment: 'Object surface' },
                { surfaceType: 'sphere', radius: 50, thickness: 5, refractiveIndex: 1.5, comment: 'Lens front' },
                { surfaceType: 'sphere', radius: -50, thickness: 10, refractiveIndex: 1.0, comment: 'Lens back' },
                { surfaceType: 'image', radius: 'INF', thickness: 0, refractiveIndex: 1.0, comment: 'Image surface' }
            ];
            console.log('📊 Generated sample optical system:', opticalSystemRows);
        }
        console.log('  - objectRows:', objectRows ? objectRows.length : 'null', objectRows);
        console.log('  - sourceRows:', sourceRows ? sourceRows.length : 'null', sourceRows);
        console.log('  - effectiveSourceRowsForSpot:', effectiveSourceRowsForSpot);
        
        // Validate surface index against actual data
        if (opticalSystemRows && opticalSystemRows.length > 0) {
            const maxSurfaceIndex = opticalSystemRows.length - 1; // 0-indexed
            if (surfaceIndex > maxSurfaceIndex) {
                console.warn(`⚠️ Surface index ${surfaceIndex} is too large, using last surface (${maxSurfaceIndex})`);
                surfaceIndex = maxSurfaceIndex;
            }
        }
        
        const surfaceNumber = surfaceIndex + 1;
        const backendResolveStartMs = nowMs();
        const analysisTraceOptions = await resolveAnalysisRustTraceOptions({
            forceRustWasm: forceRustWasmTrace,
            requireRustWasm: requireRustWasmTrace,
        });
        spotProfile.timingsMs.resolveBackend = Math.max(0, nowMs() - backendResolveStartMs);
        spotProfile.backend = (() => {
            try {
                const b = (typeof window !== 'undefined') ? (w as any).__COOPT_LAST_ANALYSIS_BACKEND : null;
                if (b && typeof b === 'object') return b;
            } catch (_) {}
            return {
                kind: (analysisTraceOptions && analysisTraceOptions.useRustWasm === true) ? 'rust-wasm' : 'js',
                at: Date.now()
            };
        })();
        spotProfile.input = {
            surfaceId,
            surfaceIndex,
            surfaceNumber,
            rayCount,
            ringCount,
            wavelengthNm: wavelength,
            pattern: patternFromUi,
            objectCount: Array.isArray(objectRows) ? objectRows.length : 0,
            opticalSurfaceCount: Array.isArray(opticalSystemRows) ? opticalSystemRows.length : 0
        };
        console.log(`🎯 Final surface resolution: surfaceId(input)=${surfaceId} → rowIndex=${surfaceIndex} → surfaceNumber=${surfaceNumber}`);
        console.log(`🎯 Target surface:`, opticalSystemRows[surfaceIndex]);
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            throw new Error('No optical system data available');
        }
        
        if (!objectRows || objectRows.length === 0) {
            console.warn('⚠️ No object data available, creating default object data');
            // Create default object data for spot diagram
            const defaultObjectRows = [
                {
                    id: 1,
                    height: 10,
                    distance: 100,
                    angle: 0,
                    wavelength: wavelength / 1000, // Convert nm to μm
                    primary: true
                }
            ];
            console.log('📊 Using default object data:', defaultObjectRows);
            
            // Import functions and use default object data
            const { generateSpotDiagramAsync, drawSpotDiagram } = await import('../evaluation/spot-diagram.js');
            const generateStartMs = nowMs();
            const spotDiagramData = await generateSpotDiagramAsync(
                opticalSystemRows,
                effectiveSourceRowsForSpot,
                defaultObjectRows,
                surfaceNumber,
                rayCount,
                ringCount,
                {
                    onProgress,
                    physicalVignetting: true,
                    displaySurfaceNumber: surfaceId,
                    pattern: patternFromUi,
                    traceOptions: analysisTraceOptions
                }
            );
            spotProfile.timingsMs.generateData += Math.max(0, nowMs() - generateStartMs);
            
            if (!spotDiagramData) {
                throw new Error('Failed to generate spot diagram data');
            }
            spotProfile.result = {
                objectCount: Array.isArray(spotDiagramData?.spotData) ? spotDiagramData.spotData.length : 0,
                totalRays: Array.isArray(spotDiagramData?.spotData)
                    ? spotDiagramData.spotData.reduce((sum: number, o: any) => sum + (Number(o?.totalRays) || 0), 0)
                    : 0,
                successfulRays: Array.isArray(spotDiagramData?.spotData)
                    ? spotDiagramData.spotData.reduce((sum: number, o: any) => sum + (Number(o?.successfulRays) || 0), 0)
                    : 0,
                generationProfile: (spotDiagramData && typeof spotDiagramData === 'object' && spotDiagramData.profile)
                    ? spotDiagramData.profile
                    : null
            };
            
            // Draw spot diagram with proper parameters
            try { onProgress?.({ percent: 90, message: 'Rendering...' }); } catch (_) {}
            const renderStartMs = nowMs();
            await drawSpotDiagram(
                spotDiagramData, 
                surfaceNumber,
                containerTarget,
                (wavelength / 1000) as any // convert nm to μm
            );
            spotProfile.timingsMs.render += Math.max(0, nowMs() - renderStartMs);
            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
            
        } else {
            // Generate spot diagram with existing object data
            const { generateSpotDiagramAsync, drawSpotDiagram } = await import('../evaluation/spot-diagram.js');
            const generateStartMs = nowMs();
            const spotDiagramData = await generateSpotDiagramAsync(
                opticalSystemRows,
                effectiveSourceRowsForSpot,
                objectRows,
                surfaceNumber,
                rayCount,
                ringCount,
                {
                    onProgress,
                    physicalVignetting: true,
                    displaySurfaceNumber: surfaceId,
                    pattern: patternFromUi,
                    traceOptions: analysisTraceOptions
                }
            );
            spotProfile.timingsMs.generateData += Math.max(0, nowMs() - generateStartMs);
            
            if (!spotDiagramData) {
                throw new Error('Failed to generate spot diagram data');
            }
            spotProfile.result = {
                objectCount: Array.isArray(spotDiagramData?.spotData) ? spotDiagramData.spotData.length : 0,
                totalRays: Array.isArray(spotDiagramData?.spotData)
                    ? spotDiagramData.spotData.reduce((sum: number, o: any) => sum + (Number(o?.totalRays) || 0), 0)
                    : 0,
                successfulRays: Array.isArray(spotDiagramData?.spotData)
                    ? spotDiagramData.spotData.reduce((sum: number, o: any) => sum + (Number(o?.successfulRays) || 0), 0)
                    : 0,
                generationProfile: (spotDiagramData && typeof spotDiagramData === 'object' && spotDiagramData.profile)
                    ? spotDiagramData.profile
                    : null
            };
            
            console.log('📋 [SPOT DIAGRAM] About to call drawSpotDiagram with:', {
                spotDataType: typeof spotDiagramData,
                spotDataKeys: spotDiagramData ? Object.keys(spotDiagramData) : 'null',
                actualSpotDataLength: spotDiagramData.spotData ? spotDiagramData.spotData.length : 'null',
                surfaceNumber: surfaceNumber,
                containerId: typeof containerTarget === 'string' ? containerTarget : '(element)',
                wavelength: wavelength / 1000
            });
            
            // Draw spot diagram with proper parameters
            try { onProgress?.({ percent: 90, message: 'Rendering...' }); } catch (_) {}
            const renderStartMs = nowMs();
            await drawSpotDiagram(
                spotDiagramData, 
                surfaceNumber,
                containerTarget,
                wavelength / 1000 as any // convert nm to μm
            );
            spotProfile.timingsMs.render += Math.max(0, nowMs() - renderStartMs);

            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
            
            console.log('✅ [SPOT DIAGRAM] drawSpotDiagram call completed');
        }

        spotProfile.timingsMs.total = Math.max(0, nowMs() - profileStartMs);
        spotProfile.status = 'ok';
        try {
            if (typeof window !== 'undefined') {
                (w as any).__cooptLastSpotDiagramProfile = spotProfile;
                const prev = Array.isArray((w as any).__cooptSpotDiagramProfileHistory)
                    ? (w as any).__cooptSpotDiagramProfileHistory
                    : [];
                const next = prev.concat([spotProfile]);
                (w as any).__cooptSpotDiagramProfileHistory = next.slice(Math.max(0, next.length - 20));
            }
        } catch (_) {}
        console.warn('⏱️ [SPOT PROFILE]', {
            backend: spotProfile?.backend?.kind || 'unknown',
            totalMs: Number(spotProfile?.timingsMs?.total || 0).toFixed(1),
            resolveBackendMs: Number(spotProfile?.timingsMs?.resolveBackend || 0).toFixed(1),
            generateDataMs: Number(spotProfile?.timingsMs?.generateData || 0).toFixed(1),
            generateCloneRowsMs: Number(spotProfile?.result?.generationProfile?.timingsMs?.cloneRows || 0).toFixed(1),
            generateStartsMs: Number(spotProfile?.result?.generationProfile?.timingsMs?.generateStarts || 0).toFixed(1),
            generateTraceRayMs: Number(spotProfile?.result?.generationProfile?.timingsMs?.traceRay || 0).toFixed(1),
            generateNonTraceMs: Number(spotProfile?.result?.generationProfile?.timingsMs?.nonTrace || 0).toFixed(1),
            renderMs: Number(spotProfile?.timingsMs?.render || 0).toFixed(1),
            traceRayCalls: Number(spotProfile?.result?.generationProfile?.counters?.traceRayCalls || 0),
            pupilAttempts: Number(spotProfile?.result?.generationProfile?.counters?.pupilAttempts || 0),
            startGenerationCacheHits: Number(spotProfile?.result?.generationProfile?.counters?.startGenerationCacheHits || 0),
            startGenerationCacheMisses: Number(spotProfile?.result?.generationProfile?.counters?.startGenerationCacheMisses || 0),
            raysTried: Number(spotProfile?.result?.generationProfile?.counters?.raysTried || 0),
            objects: Number(spotProfile?.result?.objectCount || 0),
            rays: Number(spotProfile?.result?.successfulRays || 0) + '/' + Number(spotProfile?.result?.totalRays || 0)
        });
        
        console.log('✅ Spot diagram generated successfully');
        
    } catch (error) {
        spotProfile.timingsMs.total = Math.max(0, nowMs() - profileStartMs);
        spotProfile.status = 'error';
        spotProfile.error = String((error as any)?.message || error || 'unknown error');
        try {
            if (typeof window !== 'undefined') {
                (w as any).__cooptLastSpotDiagramProfile = spotProfile;
                const prev = Array.isArray((w as any).__cooptSpotDiagramProfileHistory)
                    ? (w as any).__cooptSpotDiagramProfileHistory
                    : [];
                const next = prev.concat([spotProfile]);
                (w as any).__cooptSpotDiagramProfileHistory = next.slice(Math.max(0, next.length - 20));
            }
        } catch (_) {}
        console.error('❌ Error generating spot diagram:', error);
        console.error('Error details:', (error as any).stack);
        const container = typeof containerTarget === 'string'
            ? document.getElementById(containerTarget)
            : containerTarget;
        if (container) {
            container.innerHTML = `<div style="padding: 20px; color: red; font-family: Arial;">
                <strong>Spot diagram error:</strong><br>
                ${(error as any).message}<br>
                <small style="color: #888;">Check console for details</small>
            </div>`;
        }
        alert(`Spot diagram error:\n${(error as any).message}`);
    } finally {
        setIsGeneratingSpotDiagram(false);

        // If a newer request arrived while we were generating, run it now (last request wins).
        try {
            const pending = pendingSpotDiagramRequest;
            if (pending && pending.requestId > requestId) {
                pendingSpotDiagramRequest = null;
                setTimeout(() => {
                    showSpotDiagram(pending.options).catch((e) => {
                        console.error('❌ Error running queued spot diagram request:', e);
                    });
                }, 0);
            } else if (pending && pending.requestId === requestId) {
                pendingSpotDiagramRequest = null;
            }
        } catch (_) {
            // Best-effort only
        }
    }
}

export async function showThroughFocusSpotDiagram(options: any = {}): Promise<void> {
    try {
        const isSwitching = typeof window !== 'undefined' && (w as any).__configurationSwitching === true;
        if (isSwitching) {
            console.warn('⚠️ Through-Focus Spot requested during configuration switching; retrying shortly');
            setTimeout(() => {
                try {
                    const still = typeof window !== 'undefined' && (w as any).__configurationSwitching === true;
                    if (!still) {
                        showThroughFocusSpotDiagram(options).catch(() => {});
                    }
                } catch (_) {}
            }, 60);
            return;
        }
    } catch (_) {}

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    let containerTarget: any = 'through-focus-spot-container';
    if (options && typeof options === 'object') {
        if (options.containerElement) {
            containerTarget = options.containerElement;
        } else if (typeof options.containerId === 'string' && options.containerId.trim() !== '') {
            containerTarget = options.containerId;
        }
    }

    const reportProgress = (percent: number, message: string) => {
        try { onProgress?.({ percent, message }); } catch (_) {}
    };

    const parseIntOr = (v: any, fallback: number) => {
        const n = parseInt(String(v ?? ''), 10);
        return Number.isInteger(n) ? n : fallback;
    };
    const parseFloatOr = (v: any, fallback: number) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const getColorForWavelength = (wavelengthUm: number): string => {
        if (!Number.isFinite(wavelengthUm) || wavelengthUm <= 0) return '#1f77b4';
        if (wavelengthUm < 0.45) return '#8B00FF';
        if (wavelengthUm < 0.495) return '#0000FF';
        if (wavelengthUm < 0.57) return '#00CC44';
        if (wavelengthUm < 0.59) return '#C6C400';
        if (wavelengthUm < 0.62) return '#FF8800';
        return '#FF0000';
    };

    try {
        try {
            const loadActiveConfigurationToTables = w.loadActiveConfigurationToTables;
            if (typeof loadActiveConfigurationToTables === 'function') {
                await loadActiveConfigurationToTables({
                    applyToUI: true,
                    suppressOpticalSystemDataChanged: true
                });
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        } catch (_) {}

        const tableOpticalSystem = getTableOpticalSystem();
        const tableObject = getTableObject();
        const tableSource = getTableSource();

        let baseOpticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
        let objectRows = getObjectRows(tableObject);
        const sourceRows = getSourceRows(tableSource);

        try {
            const systemConfig = loadSystemConfigurations();
            const configs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
            const activeConfig = configs.find((cfg: any) => String(cfg?.id) === String(systemConfig?.activeConfigId)) || configs[0] || null;
            if (activeConfig) {
                let snapshotOpticalRows: any[] = Array.isArray(activeConfig?.opticalSystem)
                    ? activeConfig.opticalSystem.map((row: any) => (row && typeof row === 'object') ? { ...row } : row)
                    : [];

                if (Array.isArray(activeConfig?.blocks) && activeConfig.blocks.length > 0) {
                    const expanded = expandBlocksToOpticalSystemRows(activeConfig.blocks);
                    if (Array.isArray(expanded?.rows) && expanded.rows.length > 0) {
                        snapshotOpticalRows = expanded.rows.map((row: any) => (row && typeof row === 'object') ? { ...row } : row);
                    }
                }

                const snapshotObjectRows = Array.isArray(activeConfig?.object)
                    ? activeConfig.object.map((row: any) => (row && typeof row === 'object') ? { ...row } : row)
                    : [];

                if (snapshotOpticalRows.length > 0) {
                    baseOpticalSystemRows = snapshotOpticalRows;
                }
                if (snapshotObjectRows.length > 0) {
                    objectRows = snapshotObjectRows;
                }
            }
        } catch (_) {}

        if (!Array.isArray(baseOpticalSystemRows) || baseOpticalSystemRows.length === 0) {
            throw new Error('No optical system data available');
        }
        if (!Array.isArray(objectRows) || objectRows.length === 0) {
            throw new Error('No object data available');
        }

        const surfaceSelect = document.getElementById('surface-number-select') as HTMLSelectElement | null;
        const rayCountInput = document.getElementById('ray-count-input') as HTMLInputElement | null;
        const ringCountSelect = document.getElementById('ring-count-select') as HTMLSelectElement | null;

        const surfaceId = Number.isInteger(options?.surfaceIndex)
            ? Number(options.surfaceIndex)
            : parseIntOr(surfaceSelect?.value, 0);
        const rayCount = clamp(
            Number.isInteger(options?.rayCount) ? Number(options.rayCount) : parseIntOr(rayCountInput?.value, 101),
            1,
            20001
        );
        const ringCount = clamp(
            Number.isInteger(options?.ringCount) ? Number(options.ringCount) : parseIntOr(ringCountSelect?.value, 10),
            1,
            64
        );

        const minDefocusMm = parseFloatOr(options?.defocusMinMm, -0.1);
        const maxDefocusMm = parseFloatOr(options?.defocusMaxMm, 0.1);
        const steps = clamp(parseIntOr(options?.steps, 5), 3, 61);
        const scaleWidthUm = Math.max(1, parseFloatOr(options?.scaleUm, 100));
        const halfScaleUm = scaleWidthUm * 0.5;
        const wavelengthModeRaw = String(options?.wavelengthMode || 'all').trim().toLowerCase();
        const wavelengthMode: 'all' | 'primary' = (wavelengthModeRaw === 'primary') ? 'primary' : 'all';

        const { generateSurfaceOptions } = await import('../evaluation/spot-diagram.js');
        const { runNativeSpotRaytrace } = await import('../src/desktop/ipc/client.ts');

        const surfaceOptions = generateSurfaceOptions(baseOpticalSystemRows || []);
        let surfaceIndex = 0;
        const matched = Array.isArray(surfaceOptions)
            ? surfaceOptions.find((o: any) => Number(o?.surfaceId) === Number(surfaceId))
            : null;
        if (matched && Number.isInteger(matched.rowIndex)) {
            surfaceIndex = matched.rowIndex;
        } else {
            const imageOption = Array.isArray(surfaceOptions)
                ? surfaceOptions.find((o: any) => typeof o?.label === 'string' && o.label.includes('(Image)'))
                : null;
            if (imageOption && Number.isInteger(imageOption.rowIndex)) {
                surfaceIndex = imageOption.rowIndex;
            } else {
                surfaceIndex = Math.max(0, baseOpticalSystemRows.length - 1);
            }
        }

        const surfaceNumber = surfaceIndex + 1;
        const defocusValues = Array.from({ length: steps }, (_, i) => {
            if (steps <= 1) return minDefocusMm;
            const t = i / (steps - 1);
            return minDefocusMm + t * (maxDefocusMm - minDefocusMm);
        });

        const wavelengthRows: any[] = (() => {
            if (!Array.isArray(sourceRows) || sourceRows.length === 0) return [];
            return sourceRows
                .map((row: any, index: number) => {
                    const wl = Number(row?.wavelength);
                    if (!Number.isFinite(wl) || wl <= 0) return null;
                    const primaryText = String(row?.primary || '').toLowerCase();
                    const isPrimary = primaryText.includes('primary');
                    return {
                        ...row,
                        wavelength: wl,
                        __wlIndex: index,
                        __isPrimary: isPrimary,
                        __label: `${(wl * 1000).toFixed(1)} nm${isPrimary ? ' (primary)' : ''}`
                    };
                })
                .filter(Boolean);
        })();

        const primaryWavelengthRow = wavelengthRows.find((row: any) => row?.__isPrimary)
            || (wavelengthRows.length > 0 ? wavelengthRows[0] : null);

        const effectiveWavelengthRows = wavelengthMode === 'primary'
            ? (primaryWavelengthRow ? [primaryWavelengthRow] : [{ wavelength: 0.5876, weight: 1, __isPrimary: true, __label: '587.6 nm (primary)' }])
            : (wavelengthRows.length > 0 ? wavelengthRows : [{ wavelength: 0.5876, weight: 1, __isPrimary: true, __label: '587.6 nm (primary)' }]);

        const getObjectLabel = (row: any, index: number) => {
            const id = row && row.id !== undefined ? String(row.id).trim() : '';
            if (id) return id;
            const obj = row && row.object !== undefined ? String(row.object).trim() : '';
            if (obj) return obj;
            const pos = row && row.position !== undefined ? String(row.position).trim() : '';
            if (pos) return `Object ${index + 1} (${pos})`;
            return `Object ${index + 1}`;
        };
        const toWavelengthLabel = (rawLabel: any) => {
            const text = String(rawLabel || '').trim();
            const nm = text.match(/(\d+(?:\.\d+)?)\s*nm/i);
            if (nm && nm[1]) return `Wavelength ${nm[1]}nm`;
            const lower = text.toLowerCase();
            if (lower.includes('primary')) return 'Wavelength Primary';
            return `Wavelength ${text}`;
        };
        const wavelengthLabelFromSeries = (seriesItem: any, rawLabel: any) => {
            const wl = Number(seriesItem?.wavelengthUm);
            if (Number.isFinite(wl) && wl > 0) {
                return `Wavelength ${(wl * 1000).toFixed(1)}nm`;
            }
            return toWavelengthLabel(rawLabel);
        };
        const parseSeriesLabel = (label: any, fallbackObjectLabel: string) => {
            const raw = String(label || '').trim();
            if (!raw) {
                return { objectLabel: fallbackObjectLabel, wavelengthLabel: 'Wavelength Primary' };
            }
            const m = raw.match(/(Primary(?:\s*\([^)]*\))?|\d+(?:\.\d+)?\s*nm)\s*$/i);
            if (m && m[1]) {
                const wlRaw = String(m[1] || 'Primary');
                const prefix = raw.slice(0, Math.max(0, m.index || 0)).replace(/[|@\-\s]+$/, '').trim();
                return {
                    objectLabel: prefix || fallbackObjectLabel,
                    wavelengthLabel: toWavelengthLabel(wlRaw),
                };
            }
            return { objectLabel: raw, wavelengthLabel: 'Wavelength Primary' };
        };
        const objectLabels = objectRows.map((row: any, index: number) => getObjectLabel(row, index));
        const objectLabelToIndex = new Map<string, number>(objectLabels.map((label: string, index: number) => [label, index]));

        const focusGrid: any[][] = Array.from({ length: objectRows.length }, () => []);
        const tfTraceStatsRows: any[] = [];
        const patternFromOption = String(options?.pattern || '').trim().toLowerCase();
        const pattern = (patternFromOption === 'grid' || patternFromOption === 'annular')
            ? patternFromOption
            : getSpotDiagramPattern();

        for (let i = 0; i < defocusValues.length; i++) {
            const shift = defocusValues[i];
            const p = Math.floor((i / Math.max(1, defocusValues.length)) * 90);
            reportProgress(p, `Defocus ${shift.toFixed(4)} mm (${i + 1}/${defocusValues.length})`);

            const shiftedRows = cloneOpticalSystemRowsWithDefocusShift(baseOpticalSystemRows, shift);
            const raySeries: any[] = [];
            for (let objIdx = 0; objIdx < objectRows.length; objIdx++) {
                const objectRow = objectRows[objIdx] || {};
                const objectLabel = objectLabels[objIdx] || getObjectLabel(objectRow, objIdx);
                const hasFieldAngle = String(objectRow.position ?? objectRow.object ?? objectRow.Object ?? '').trim().toLowerCase() === 'angle';
                for (let wlIdx = 0; wlIdx < effectiveWavelengthRows.length; wlIdx++) {
                    const wlRow = effectiveWavelengthRows[wlIdx];
                    const wlValueUm = Number(wlRow?.wavelength);
                    const wlLabel = String(wlRow?.__label || `${(wlValueUm * 1000).toFixed(1)} nm`);
                    const starts = generateRayStartPointsForObject(
                        objectRow,
                        shiftedRows,
                        rayCount,
                        null,
                        {
                            annularRingCount: ringCount,
                            wavelengthUm: wlValueUm,
                            pattern,
                        } as any,
                    );
                    const rays = (Array.isArray(starts) ? starts : [])
                        .map((start: any) => ({
                            startP: {
                                x: Number(start?.startP?.x) || 0,
                                y: Number(start?.startP?.y) || 0,
                                z: Number(start?.startP?.z) || 0,
                            },
                            dir: {
                                x: Number(start?.dir?.x) || 0,
                                y: Number(start?.dir?.y) || 0,
                                z: Number(start?.dir?.z) || 1,
                            },
                            wavelengthUm: wlValueUm,
                            pupilU: Number.isFinite(Number(start?.planeCoords?.u)) ? Number(start.planeCoords.u) : undefined,
                            pupilV: Number.isFinite(Number(start?.planeCoords?.v)) ? Number(start.planeCoords.v) : undefined,
                            isChief: start?.isChief === true || (start?.isChief == null && (start?.rayIndex === 0 || start?.index === 0)),
                        }))
                        .filter((ray: any) => Number.isFinite(ray.startP.x) && Number.isFinite(ray.startP.y) && Number.isFinite(ray.startP.z));

                    if (rays.length === 0) continue;

                    raySeries.push({
                        label: `${objectLabel} ${wlLabel}`,
                        color: getColorForWavelength(wlValueUm),
                        hasFieldAngle,
                        rays,
                    });
                }
            }

            const spotResult = await runNativeSpotRaytrace({
                opticalSystemRows: shiftedRows,
                sourceRows: effectiveWavelengthRows,
                objectRows,
                surfaceIndex,
                rayCount,
                ringCount,
                pattern,
                wavelengthMode,
                raySeries,
            } as any);

            const perSeriesStats = Array.isArray((spotResult as any)?.seriesStats) ? (spotResult as any).seriesStats : [];
            for (const stat of perSeriesStats) {
                tfTraceStatsRows.push({
                    backend: String((spotResult as any)?.backend || 'unknown'),
                    defocusMm: Number(shift),
                    label: String((stat as any)?.label || ''),
                    attemptedRays: Number((stat as any)?.attemptedRays || 0),
                    hitRays: Number((stat as any)?.hitRays || 0),
                    missRays: Number((stat as any)?.missRays || 0),
                    apertureBlockRays: Number((stat as any)?.apertureBlockRays || 0),
                    noIntersectionRays: Number((stat as any)?.noIntersectionRays || 0),
                    tirRays: Number((stat as any)?.tirRays || 0),
                    unknownFailRays: Number((stat as any)?.unknownFailRays || 0),
                    statusCounts: (((stat as any) && typeof (stat as any).statusCounts === 'object' && !Array.isArray((stat as any).statusCounts)) ? (stat as any).statusCounts : {}),
                    hitRatePercent: Number((stat as any)?.hitRatePercent || 0),
                });
            }

            const groupedByObject = new Map<number, Array<{ key: string; label: string; color: string; points: Array<{ xUm: number; yUm: number }> }>>();
            const series = Array.isArray(spotResult?.series) ? spotResult.series : [];
            const wavelengthCount = Math.max(1, effectiveWavelengthRows.length);

            for (let sIdx = 0; sIdx < series.length; sIdx++) {
                const seriesItem = series[sIdx] || {};
                const objectIndexByOrder = Math.floor(sIdx / wavelengthCount);
                const fallbackObjectLabel = objectLabels[objectIndexByOrder] || `Object ${objectIndexByOrder + 1}`;
                const parsed = parseSeriesLabel(seriesItem?.label, fallbackObjectLabel);
                const resolvedObjectIndex = objectLabelToIndex.has(parsed.objectLabel)
                    ? Number(objectLabelToIndex.get(parsed.objectLabel))
                    : Math.max(0, Math.min(objectRows.length - 1, objectIndexByOrder));
                const wlLabel = wavelengthLabelFromSeries(seriesItem, parsed.wavelengthLabel);
                const points = (Array.isArray(seriesItem?.points) ? seriesItem.points : [])
                    .map((point: any) => ({
                        xUm: Number(point?.xUm),
                        yUm: Number(point?.yUm),
                    }))
                    .filter((point: any) => Number.isFinite(point.xUm) && Number.isFinite(point.yUm));
                if (!groupedByObject.has(resolvedObjectIndex)) {
                    groupedByObject.set(resolvedObjectIndex, []);
                }
                groupedByObject.get(resolvedObjectIndex)!.push({
                    key: wlLabel,
                    label: wlLabel,
                    color: String(seriesItem?.color || getColorForWavelength(Number(seriesItem?.wavelengthUm))),
                    points,
                });
            }

            for (let objIdx = 0; objIdx < objectRows.length; objIdx++) {
                const groups = Array.isArray(groupedByObject.get(objIdx)) ? groupedByObject.get(objIdx)! : [];
                const mergedPoints: Array<{ xUm: number; yUm: number }> = [];
                for (const group of groups) {
                    const pts = Array.isArray(group?.points) ? group.points : [];
                    for (const point of pts) {
                        mergedPoints.push({ xUm: Number(point?.xUm) || 0, yUm: Number(point?.yUm) || 0 });
                    }
                }

                let cx = 0;
                let cy = 0;
                if (mergedPoints.length > 0) {
                    cx = mergedPoints.reduce((sum, point) => sum + point.xUm, 0) / mergedPoints.length;
                    cy = mergedPoints.reduce((sum, point) => sum + point.yUm, 0) / mergedPoints.length;
                }

                focusGrid[objIdx].push({
                    shiftMm: shift,
                    pointsByWavelength: groups.map((group) => ({
                        key: group.key,
                        label: group.label,
                        color: group.color,
                        points: (Array.isArray(group.points) ? group.points : []).map((point) => ({
                            xUm: (Number(point?.xUm) || 0) - cx,
                            yUm: (Number(point?.yUm) || 0) - cy,
                        })),
                    })),
                });
            }
        }

        try {
            (w as any).__cooptTfSpotLastTraceStats = tfTraceStatsRows;
        } catch (_) {}
        try {
            (globalThis as any).__cooptTfSpotLastTraceStats = tfTraceStatsRows;
        } catch (_) {}
        try {
            if (console.table) {
                console.table(tfTraceStatsRows);
            } else {
                console.log('[TFSD_TRACE_STATS]', tfTraceStatsRows);
            }
        } catch (_) {}

        const containerEl = (typeof containerTarget === 'string')
            ? document.getElementById(containerTarget)
            : containerTarget;
        if (!containerEl) {
            throw new Error('Through-Focus Spot container element not found');
        }

        const targetWindow = containerEl?.ownerDocument?.defaultView || window;
        const plotly = targetWindow?.Plotly || (window as any)?.Plotly;
        if (!plotly || typeof plotly.newPlot !== 'function') {
            throw new Error('Plotly is not available');
        }

        reportProgress(92, 'Building plot...');
        const rows = objectRows.length;
        const cols = defocusValues.length;
        const traces: any[] = [];
        const layout: any = {
            title: {
                text: 'Through-Focus Spot Diagram',
                x: 0.5,
                xanchor: 'center',
                y: 0.98,
                yanchor: 'top'
            },
            showlegend: true,
            grid: { rows, columns: cols, pattern: 'independent' },
            margin: { l: 60, r: 20, t: 95, b: 60 },
            paper_bgcolor: '#ffffff',
            plot_bgcolor: '#ffffff',
            height: Math.max(420, rows * 145 + 90),
            legend: {
                orientation: 'h',
                yanchor: 'bottom',
                y: 1.06,
                xanchor: 'center',
                x: 0.5
            },
            legendgroupclick: 'togglegroup'
        };

        const shownLegendGroups = new Set<string>();
        const legendEntries = new Map<string, { label: string; color: string }>();

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c + 1;
                const axisRefX = idx === 1 ? 'x' : `x${idx}`;
                const axisRefY = idx === 1 ? 'y' : `y${idx}`;
                const axisKeyX = idx === 1 ? 'xaxis' : `xaxis${idx}`;
                const axisKeyY = idx === 1 ? 'yaxis' : `yaxis${idx}`;
                const cell = focusGrid?.[r]?.[c] || { pointsByWavelength: [] };
                const groups = Array.isArray(cell.pointsByWavelength) ? cell.pointsByWavelength : [];

                for (const group of groups) {
                    const pts = Array.isArray(group?.points) ? group.points : [];
                    const groupKey = String(group?.key || group?.label || 'wavelength');
                    if (!legendEntries.has(groupKey)) {
                        legendEntries.set(groupKey, {
                            label: String(group?.label || groupKey),
                            color: String(group?.color || 'blue')
                        });
                    }
                    traces.push({
                        x: pts.map((p: any) => p.xUm),
                        y: pts.map((p: any) => p.yUm),
                        mode: 'markers',
                        type: 'scattergl',
                        name: String(group?.label || groupKey),
                        legendgroup: groupKey,
                        showlegend: false,
                        marker: {
                            size: 3,
                            color: String(group?.color || 'blue'),
                            opacity: 0.75
                        },
                        xaxis: axisRefX,
                        yaxis: axisRefY,
                        hovertemplate: 'x=%{x:.2f} µm<br>y=%{y:.2f} µm<extra></extra>'
                    });
                    shownLegendGroups.add(groupKey);
                }

                layout[axisKeyX] = {
                    range: [-halfScaleUm, halfScaleUm],
                    showgrid: true,
                    zeroline: true,
                    showticklabels: r === rows - 1,
                    title: r === rows - 1 ? `${defocusValues[c].toFixed(3)} mm` : ''
                };
                layout[axisKeyY] = {
                    range: [-halfScaleUm, halfScaleUm],
                    showgrid: true,
                    zeroline: true,
                    showticklabels: c === 0,
                    title: c === 0 ? `Field ${r + 1}` : '',
                    scaleanchor: axisRefX,
                    scaleratio: 1
                };
            }
        }

        for (const [groupKey, entry] of legendEntries.entries()) {
            traces.push({
                x: [null],
                y: [null],
                mode: 'markers',
                type: 'scatter',
                name: entry.label,
                legendgroup: groupKey,
                showlegend: true,
                marker: {
                    size: 8,
                    color: entry.color,
                    symbol: 'circle'
                },
                hoverinfo: 'skip'
            });
        }

        reportProgress(98, 'Rendering plot...');
        await plotly.newPlot(containerEl, traces, layout, { responsive: true, displaylogo: false });
        reportProgress(100, 'Done');
    } catch (error: any) {
        const container = typeof containerTarget === 'string'
            ? document.getElementById(containerTarget)
            : containerTarget;
        if (container) {
            container.innerHTML = `<div style="padding:20px;color:red;font-family:Arial;">Failed to generate Through-Focus Spot Diagram.<br>${String(error?.message || error)}</div>`;
        }
        throw error;
    }
}

export async function runSpotParityDiagnostics(options: any = {}): Promise<any> {
    const parseIntOr = (v: any, fallback: number) => {
        const n = parseInt(String(v ?? ''), 10);
        return Number.isInteger(n) ? n : fallback;
    };
    const parseFloatOr = (v: any, fallback: number) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    const normalizePointsUm = (points: any[]) => {
        const raw = Array.isArray(points)
            ? points
                .map((pt: any) => ({ x: Number(pt?.x), y: Number(pt?.y) }))
                .filter((pt: any) => Number.isFinite(pt.x) && Number.isFinite(pt.y))
            : [];

        if (raw.length === 0) {
            return [] as Array<{ xUm: number; yUm: number }>;
        }

        const cx = raw.reduce((sum: number, pt: any) => sum + pt.x, 0) / raw.length;
        const cy = raw.reduce((sum: number, pt: any) => sum + pt.y, 0) / raw.length;
        return raw.map((pt: any) => ({
            xUm: (pt.x - cx) * 1000,
            yUm: (pt.y - cy) * 1000,
        }));
    };

    const metricFromPointsUm = (points: Array<{ xUm: number; yUm: number }>) => {
        if (!Array.isArray(points) || points.length === 0) {
            return { count: 0, rmsUm: NaN, diaUm: NaN };
        }

        const rsq = points.map((pt) => pt.xUm * pt.xUm + pt.yUm * pt.yUm);
        const maxR = Math.sqrt(Math.max(...rsq));
        const meanRsq = rsq.reduce((s, v) => s + v, 0) / rsq.length;
        return {
            count: points.length,
            rmsUm: Math.sqrt(meanRsq),
            diaUm: 2 * maxR,
        };
    };

    const resultTableFromMaps = (
        tsMap: Map<string, any>,
        rustMap: Map<string, any>,
    ) => {
        const keys = Array.from(new Set<string>([
            ...Array.from(tsMap.keys()),
            ...Array.from(rustMap.keys()),
        ])).sort();

        return keys.map((key) => {
            const t = tsMap.get(key) || {};
            const r = rustMap.get(key) || {};
            const tsRms = Number(t.rmsUm);
            const rustRms = Number(r.rmsUm);
            const tsDia = Number(t.diaUm);
            const rustDia = Number(r.diaUm);
            return {
                key,
                tsCount: Number(t.count || 0),
                rustCount: Number(r.count || 0),
                tsRmsUm: tsRms,
                rustRmsUm: rustRms,
                deltaRmsUm: Number.isFinite(tsRms) && Number.isFinite(rustRms) ? (rustRms - tsRms) : NaN,
                tsDiaUm: tsDia,
                rustDiaUm: rustDia,
                deltaDiaUm: Number.isFinite(tsDia) && Number.isFinite(rustDia) ? (rustDia - tsDia) : NaN,
            };
        });
    };

    const finiteNumber = (v: any) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    const computeSummary = (rows: any[]) => {
        const rmsAbs = (rows || [])
            .map((r: any) => finiteNumber(r?.deltaRmsUm))
            .filter((v: any) => v !== null)
            .map((v: number) => Math.abs(v));
        const diaAbs = (rows || [])
            .map((r: any) => finiteNumber(r?.deltaDiaUm))
            .filter((v: any) => v !== null)
            .map((v: number) => Math.abs(v));
        const rmsSigned = (rows || [])
            .map((r: any) => finiteNumber(r?.deltaRmsUm))
            .filter((v: any) => v !== null);
        const diaSigned = (rows || [])
            .map((r: any) => finiteNumber(r?.deltaDiaUm))
            .filter((v: any) => v !== null);

        const mean = (arr: number[]) => arr.length > 0 ? (arr.reduce((s, v) => s + v, 0) / arr.length) : NaN;
        const max = (arr: number[]) => arr.length > 0 ? Math.max(...arr) : NaN;

        return {
            rowCount: (rows || []).length,
            meanAbsDeltaRmsUm: mean(rmsAbs),
            maxAbsDeltaRmsUm: max(rmsAbs),
            meanAbsDeltaDiaUm: mean(diaAbs),
            maxAbsDeltaDiaUm: max(diaAbs),
            signedMeanDeltaRmsUm: mean(rmsSigned),
            signedMeanDeltaDiaUm: mean(diaSigned),
        };
    };

    const topHotspots = (rows: any[], deltaField: 'deltaRmsUm' | 'deltaDiaUm', topN: number) => {
        const picked = (rows || [])
            .map((r: any) => ({ ...r, __abs: Math.abs(Number(r?.[deltaField])) }))
            .filter((r: any) => Number.isFinite(r.__abs))
            .sort((a: any, b: any) => b.__abs - a.__abs)
            .slice(0, topN)
            .map(({ __abs, ...rest }: any) => ({ ...rest, absDelta: __abs }));
        return picked;
    };

    const parseThroughFocusKey = (key: string) => {
        const [defocusRaw, wlRaw] = String(key || '').split('|').map((s) => s.trim());
        const defocusMm = Number(defocusRaw);
        return {
            defocusMm: Number.isFinite(defocusMm) ? defocusMm : NaN,
            wavelengthLabel: wlRaw || '',
        };
    };

    const aggregateThroughFocusByWavelength = (rows: any[]) => {
        const map = new Map<string, { absRms: number[]; absDia: number[] }>();
        for (const row of rows || []) {
            const parsed = parseThroughFocusKey(String(row?.key || ''));
            const wl = parsed.wavelengthLabel || 'unknown';
            if (!map.has(wl)) map.set(wl, { absRms: [], absDia: [] });
            const slot = map.get(wl)!;
            const dRms = finiteNumber(row?.deltaRmsUm);
            const dDia = finiteNumber(row?.deltaDiaUm);
            if (dRms !== null) slot.absRms.push(Math.abs(dRms));
            if (dDia !== null) slot.absDia.push(Math.abs(dDia));
        }

        const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : NaN;
        return Array.from(map.entries()).map(([wavelengthLabel, slot]) => ({
            wavelengthLabel,
            meanAbsDeltaRmsUm: mean(slot.absRms),
            meanAbsDeltaDiaUm: mean(slot.absDia),
            sampleCount: Math.max(slot.absRms.length, slot.absDia.length),
        })).sort((a, b) => {
            const aa = Number.isFinite(a.meanAbsDeltaRmsUm) ? a.meanAbsDeltaRmsUm : -1;
            const bb = Number.isFinite(b.meanAbsDeltaRmsUm) ? b.meanAbsDeltaRmsUm : -1;
            return bb - aa;
        });
    };

    const buildCorrectionCandidates = (spotRows: any[], tfRows: any[], summaries: any) => {
        const candidates: Array<{ area: string; reason: string; action: string }> = [];

        const countMismatch = [...(spotRows || []), ...(tfRows || [])]
            .filter((r: any) => Number(r?.tsCount || 0) !== Number(r?.rustCount || 0));
        if (countMismatch.length > 0) {
            candidates.push({
                area: 'sampling',
                reason: `TS/Rust の点数不一致が ${countMismatch.length} ケース`,
                action: 'Rust 側の rayCount clamp・grid side 算出・annular 点生成順を TS 実装と完全一致させる',
            });
        }

        const signedRms = Number(summaries?.throughFocus?.signedMeanDeltaRmsUm);
        if (Number.isFinite(signedRms) && Math.abs(signedRms) > 0.5) {
            candidates.push({
                area: 'spot-scale',
                reason: `through-focus の平均RMS差が ${signedRms.toFixed(3)} µm`,
                action: signedRms > 0
                    ? 'Rust の spot σ 係数（base/defocus gain）を小さくして全体幅を縮小'
                    : 'Rust の spot σ 係数（base/defocus gain）を大きくして全体幅を拡大',
            });
        }

        const spotMax = Number(summaries?.spotDiagram?.maxAbsDeltaRmsUm);
        const tfMax = Number(summaries?.throughFocus?.maxAbsDeltaRmsUm);
        if ((Number.isFinite(spotMax) && spotMax > 3.0) || (Number.isFinite(tfMax) && tfMax > 3.0)) {
            candidates.push({
                area: 'phase-to-spot model',
                reason: `最大RMS差が大きい (spot=${Number.isFinite(spotMax) ? spotMax.toFixed(3) : 'n/a'} µm, tf=${Number.isFinite(tfMax) ? tfMax.toFixed(3) : 'n/a'} µm)`,
                action: 'PSF二次モーメント→spot σ 変換の倍率と anisotropy 項を波長・defocusごとに再フィットする',
            });
        }

        return candidates;
    };

    try {
        const runtime = await import('../src/desktop/runtime.ts');
        if (!runtime.isTauriRuntime()) {
            throw new Error('runSpotParityDiagnostics requires Tauri desktop runtime');
        }
    } catch (error: any) {
        throw new Error(String(error?.message || error || 'runtime check failed'));
    }

    const { runAnalysisCompute } = await import('../src/desktop/ipc/client.ts');
    const { generateSurfaceOptions, generateSpotDiagramAsync } = await import('../evaluation/spot-diagram.js');

    const tableOpticalSystem = getTableOpticalSystem();
    const tableObject = getTableObject();
    const tableSource = getTableSource();

    const opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
    const objectRows = getObjectRows(tableObject);
    const sourceRows = getSourceRows(tableSource);

    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        throw new Error('No optical system rows available');
    }
    if (!Array.isArray(objectRows) || objectRows.length === 0) {
        throw new Error('No object rows available');
    }

    const objectIndex = clamp(parseIntOr(options?.objectIndex, 0), 0, objectRows.length - 1);
    const objectRow = objectRows[objectIndex] || objectRows[0];

    const surfaceOptions = generateSurfaceOptions(opticalSystemRows || []);
    const surfaceId = Number.isInteger(options?.surfaceIndex)
        ? Number(options.surfaceIndex)
        : 0;
    const matched = Array.isArray(surfaceOptions)
        ? surfaceOptions.find((o: any) => Number(o?.surfaceId) === Number(surfaceId))
        : null;
    const surfaceIndex = Number.isInteger(matched?.rowIndex)
        ? Number(matched.rowIndex)
        : Math.max(0, opticalSystemRows.length - 1);
    const surfaceNumber = surfaceIndex + 1;

    const rayCount = clamp(parseIntOr(options?.rayCount, 501), 9, 20001);
    const ringCount = clamp(parseIntOr(options?.ringCount, 10), 1, 64);
    const pattern = String(options?.pattern || getSpotDiagramPattern() || 'annular').toLowerCase() === 'grid'
        ? 'grid'
        : 'annular';
    const wavelengthMode = String(options?.wavelengthMode || 'all').toLowerCase() === 'primary'
        ? 'primary'
        : 'all';

    const defocusMinMm = parseFloatOr(options?.defocusMinMm, -0.1);
    const defocusMaxMm = parseFloatOr(options?.defocusMaxMm, 0.1);
    const steps = clamp(parseIntOr(options?.steps, 5), 3, 61);
    const scaleUm = Math.max(1, parseFloatOr(options?.scaleUm, 100));

    const wavelengthRows: any[] = (() => {
        if (!Array.isArray(sourceRows) || sourceRows.length === 0) return [];
        return sourceRows
            .map((row: any) => {
                const wl = Number(row?.wavelength);
                if (!Number.isFinite(wl) || wl <= 0) return null;
                const primaryText = String(row?.primary || '').toLowerCase();
                const isPrimary = primaryText.includes('primary');
                return {
                    ...row,
                    wavelength: wl,
                    __isPrimary: isPrimary,
                    __label: `${(wl * 1000).toFixed(1)} nm${isPrimary ? ' (primary)' : ''}`,
                };
            })
            .filter(Boolean);
    })();
    const primaryWavelengthRow = wavelengthRows.find((row: any) => row?.__isPrimary)
        || (wavelengthRows.length > 0 ? wavelengthRows[0] : null);
    const effectiveWavelengthRows = wavelengthMode === 'primary'
        ? (primaryWavelengthRow ? [primaryWavelengthRow] : [{ wavelength: 0.5876, __label: '587.6 nm (primary)' }])
        : (wavelengthRows.length > 0 ? wavelengthRows : [{ wavelength: 0.5876, __label: '587.6 nm (primary)' }]);

    const traceOptions = await resolveAnalysisRustTraceOptions({
        forceRustWasm: options?.forceRustWasm === true,
        requireRustWasm: options?.requireRustWasm !== false,
    });

    const tsSpotDiagram = new Map<string, any>();
    for (const wlRow of effectiveWavelengthRows) {
        const wlLabel = String(wlRow?.__label || `${(Number(wlRow?.wavelength || 0.5876) * 1000).toFixed(1)} nm`);
        const spotResult = await generateSpotDiagramAsync(
            opticalSystemRows,
            [wlRow],
            [objectRow],
            surfaceNumber,
            rayCount,
            ringCount,
            {
                onProgress: null,
                physicalVignetting: true,
                displaySurfaceNumber: surfaceId,
                pattern,
                traceOptions,
            }
        );
        const pointsRaw = (spotResult?.spotData?.[0]?.spotPoints || []);
        const pointsUm = normalizePointsUm(pointsRaw);
        tsSpotDiagram.set(wlLabel, metricFromPointsUm(pointsUm));
    }

    const rustSpotDiagramRes = await runAnalysisCompute({
        kind: 'spot-diagram',
        opticalSystemRows,
        sourceRows,
        objectRows: [objectRow],
        surfaceIndex,
        rayCount,
        ringCount,
        pattern,
        wavelengthMode,
    });

    const rustSpotDiagram = new Map<string, any>();
    const rustSeries = Array.isArray(rustSpotDiagramRes?.spotDiagramSeries) ? rustSpotDiagramRes.spotDiagramSeries : [];
    for (const series of rustSeries) {
        const key = String(series?.label || 'series');
        const pointsUm = Array.isArray(series?.points)
            ? series.points.map((pt: any) => ({ xUm: Number(pt?.xUm), yUm: Number(pt?.yUm) }))
                .filter((pt: any) => Number.isFinite(pt.xUm) && Number.isFinite(pt.yUm))
            : [];
        rustSpotDiagram.set(key, metricFromPointsUm(pointsUm));
    }

    const defocusValues = Array.from({ length: steps }, (_, i) => {
        if (steps <= 1) return defocusMinMm;
        const t = i / (steps - 1);
        return defocusMinMm + t * (defocusMaxMm - defocusMinMm);
    });

    const tsThroughFocus = new Map<string, any>();
    for (const shift of defocusValues) {
        const shiftedRows = cloneOpticalSystemRowsWithDefocusShift(opticalSystemRows, shift);
        for (const wlRow of effectiveWavelengthRows) {
            const wlLabel = String(wlRow?.__label || `${(Number(wlRow?.wavelength || 0.5876) * 1000).toFixed(1)} nm`);
            const key = `${shift.toFixed(6)} | ${wlLabel}`;
            const spotResult = await generateSpotDiagramAsync(
                shiftedRows,
                [wlRow],
                [objectRow],
                surfaceNumber,
                rayCount,
                ringCount,
                {
                    onProgress: null,
                    physicalVignetting: true,
                    displaySurfaceNumber: surfaceId,
                    pattern,
                    traceOptions,
                }
            );
            const pointsRaw = (spotResult?.spotData?.[0]?.spotPoints || []);
            const pointsUm = normalizePointsUm(pointsRaw);
            tsThroughFocus.set(key, metricFromPointsUm(pointsUm));
        }
    }

    const rustThroughFocusRes = await runAnalysisCompute({
        kind: 'through-focus-spot',
        opticalSystemRows,
        sourceRows,
        objectRows: [objectRow],
        surfaceIndex,
        defocusMinMm,
        defocusMaxMm,
        steps,
        rayCount,
        ringCount,
        scaleUm,
        pattern,
        wavelengthMode,
    });

    const rustThroughFocus = new Map<string, any>();
    const rustTfSeries = Array.isArray(rustThroughFocusRes?.spotSeries) ? rustThroughFocusRes.spotSeries : [];
    for (const series of rustTfSeries) {
        const defocus = Number(series?.defocusMm);
        const wlLabel = String(series?.wavelengthLabel || 'wavelength');
        const key = `${defocus.toFixed(6)} | ${wlLabel}`;
        const pointsUm = Array.isArray(series?.points)
            ? series.points.map((pt: any) => ({ xUm: Number(pt?.xUm), yUm: Number(pt?.yUm) }))
                .filter((pt: any) => Number.isFinite(pt.xUm) && Number.isFinite(pt.yUm))
            : [];
        rustThroughFocus.set(key, metricFromPointsUm(pointsUm));
    }

    const spotDiagramRows = resultTableFromMaps(tsSpotDiagram, rustSpotDiagram);
    const throughFocusRows = resultTableFromMaps(tsThroughFocus, rustThroughFocus);

    const topN = clamp(parseIntOr(options?.topN, 12), 3, 100);
    const summaries = {
        spotDiagram: computeSummary(spotDiagramRows),
        throughFocus: computeSummary(throughFocusRows),
    };
    const hotspots = {
        spotDiagramByRms: topHotspots(spotDiagramRows, 'deltaRmsUm', topN),
        spotDiagramByDia: topHotspots(spotDiagramRows, 'deltaDiaUm', topN),
        throughFocusByRms: topHotspots(throughFocusRows, 'deltaRmsUm', topN),
        throughFocusByDia: topHotspots(throughFocusRows, 'deltaDiaUm', topN),
        throughFocusByWavelength: aggregateThroughFocusByWavelength(throughFocusRows),
    };
    const correctionCandidates = buildCorrectionCandidates(spotDiagramRows, throughFocusRows, summaries);

    const report = {
        config: {
            objectIndex,
            surfaceIndex,
            rayCount,
            ringCount,
            pattern,
            wavelengthMode,
            defocusMinMm,
            defocusMaxMm,
            steps,
            scaleUm,
        },
        summaries,
        hotspots,
        correctionCandidates,
        spotDiagramRows,
        throughFocusRows,
        generatedAt: Date.now(),
    };

    try {
        (window as any).__cooptLastSpotParity = report;
        console.groupCollapsed('📊 [SpotParity] TS vs Rust');
        console.log('config', report.config);
        console.log('summaries', summaries);
        console.log('hotspots', hotspots);
        console.log('correctionCandidates', correctionCandidates);
        console.log('spotDiagramRows', spotDiagramRows);
        console.log('throughFocusRows', throughFocusRows);
        if (console.table) {
            console.table(hotspots.spotDiagramByRms);
            console.table(hotspots.throughFocusByRms);
            console.table(hotspots.throughFocusByWavelength);
            console.table(spotDiagramRows);
            console.table(throughFocusRows);
        }
        console.groupEnd();
    } catch (_) {}

    return report;
}

/**
 * Show transverse aberration diagram
 */
export async function showTransverseAberrationDiagram(options: any = {}): Promise<any> {
    console.log('📊 Starting transverse aberration calculation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    // Default target container is the in-page one
    let containerTarget: any = 'transverse-aberration-container';
    if (options && typeof options === 'object') {
        if (options.containerElement) {
            containerTarget = options.containerElement;
        } else if (typeof options.containerId === 'string' && options.containerId.trim() !== '') {
            containerTarget = options.containerId;
        }
    }
    
    // Check if already generating
    if (getIsGeneratingTransverseAberration()) {
        console.warn('⚠️ Transverse aberration calculation already in progress');
        return;
    }
    
    try {
        setIsGeneratingTransverseAberration(true);

        try { onProgress?.({ percent: 0, message: 'Preparing transverse aberration...' }); } catch (_) {}

        const transverseRayCountInput = document.getElementById('transverse-ray-count-input') as HTMLInputElement | null;
        let rayCount = 51;
        const providedRayCount = Number.isInteger(options?.rayCount) ? options.rayCount : null;
        if (providedRayCount !== null && providedRayCount > 0) {
            rayCount = providedRayCount;
        } else if (transverseRayCountInput && transverseRayCountInput.value !== '') {
            const inputValue = parseInt(transverseRayCountInput.value);
            if (!isNaN(inputValue) && inputValue > 0) {
                rayCount = inputValue;
            }
        }
        rayCount = Math.max(9, Math.min(10001, Math.round(rayCount)));

        const tableOpticalSystem = getTableOpticalSystem();
        const opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            throw new Error('光学系データが見つかりません');
        }

        const isCoordTransRow = (row: any) => {
            const stRaw = String(row?.surfType ?? row?.['surf type'] ?? row?.surface_type ?? '').toLowerCase();
            const st = stRaw.trim();
            return st === 'coord trans' || st === 'coordinate break' || st === 'coordtrans' || st === 'coordinatebreak' || st === 'ct';
        };
        const isObjectRow = (row: any) => {
            const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? row?.surface_type ?? '').toLowerCase();
            return t === 'object';
        };
        const isGapRow = (row: any) => {
            const norm = (v: any) => String(v ?? '').trim().toLowerCase();
            const compact = (v: any) => norm(v).replace(/[\s_-]+/g, '');
            const surfType = norm(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
            const surfTypeCompact = compact(row?.surfType ?? row?.['surf type'] ?? row?.type ?? row?.surface_type ?? '');
            const blockType = norm(row?._blockType ?? row?.blockType ?? '');
            const blockTypeCompact = compact(row?._blockType ?? row?.blockType ?? '');
            return (
                surfType === 'gap' || surfType === 'air gap' || surfTypeCompact === 'gap' || surfTypeCompact === 'airgap' ||
                blockType === 'gap' || blockType === 'air gap' || blockTypeCompact === 'gap' || blockTypeCompact === 'airgap'
            );
        };
        const isImageRow = (row: any) => {
            const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').toLowerCase();
            return t === 'image';
        };

        // Prefer explicit Image surface; otherwise fall back to last non-CB/non-Object surface.
        let targetSurfaceIndex = -1;
        for (let i = 0; i < opticalSystemRows.length; i++) {
            if (isImageRow(opticalSystemRows[i])) {
                targetSurfaceIndex = i;
            }
        }
        if (targetSurfaceIndex < 0) {
            for (let i = opticalSystemRows.length - 1; i >= 0; i--) {
                const row = opticalSystemRows[i];
                if (isCoordTransRow(row) || isObjectRow(row) || isGapRow(row)) continue;
                targetSurfaceIndex = i;
                break;
            }
        }
        if (targetSurfaceIndex < 0) {
            targetSurfaceIndex = opticalSystemRows.length - 1;
        }
        console.log(`📊 評価面: Surface ${targetSurfaceIndex + 1}`);
        console.log(`📊 光線本数: ${rayCount}本`);

        const { getPrimaryWavelengthForAberration } = await import('../evaluation/aberrations/transverse-aberration.js');
        const { plotTransverseAberrationDiagram } = await import('../evaluation/aberrations/transverse-aberration-plot.js');
        const { runNativeTransverseAberration } = await import('../src/desktop/ipc/client.ts');

        const wavelength = getPrimaryWavelengthForAberration(); // μm
        console.log(`📊 Wavelength: ${wavelength} μm`);

        const tableSource = getTableSource();
        const tableObject = getTableObject();
        const sourceRows = getSourceRows(tableSource);
        const objectRows = getObjectRows(tableObject);

        try { onProgress?.({ percent: 10, message: 'Computing transverse aberration (Rust API)...' }); } catch (_) {}
        const aberrationData: any = await runNativeTransverseAberration({
            opticalSystemRows,
            sourceRows: Array.isArray(sourceRows) ? sourceRows : [],
            objectRows: Array.isArray(objectRows) ? objectRows : [],
            surfaceIndex: targetSurfaceIndex,
            rayCount,
            pattern: 'cross',
            wavelengthMode: 'primary',
            wavelength,
        });

        if (!aberrationData) {
            throw new Error('Failed to calculate transverse aberration data');
        }

        try { onProgress?.({ percent: 95, message: 'Rendering...' }); } catch (_) {}
        plotTransverseAberrationDiagram(aberrationData, containerTarget, typeof containerTarget === 'string' ? document : containerTarget.ownerDocument);
        try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
        console.log('✅ Transverse aberration diagram generated successfully');
        return aberrationData;
    } catch (error) {
        console.error('❌ Transverse aberration diagram error:', error);
        const container = typeof containerTarget === 'string'
            ? document.getElementById(containerTarget)
            : containerTarget;
        if (container) {
            container.innerHTML = `<div style="padding: 20px; color: red; font-family: Arial;">
                <strong>Transverse aberration error:</strong><br>
                ${(error as any).message}<br>
                <small style="color: #888;">Check console for details</small>
            </div>`;
        }
        alert(`Transverse aberration error: ${(error as any).message}`);
        return null;
    } finally {
        setIsGeneratingTransverseAberration(false);
    }
}

/**
 * Show lateral chromatic aberration diagram (倍率色収差図)
 */
export async function showMagnificationChromaticAberrationDiagram(options: any = {}): Promise<void> {
     console.log('📊 Starting lateral chromatic aberration calculation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;
    const chiefRayDefinition = (options && typeof options === 'object' && typeof options.chiefRayDefinition === 'string')
        ? options.chiefRayDefinition
        : 'stop-center';

    let containerTarget: any = 'magnification-chromatic-aberration-container';
    if (options && typeof options === 'object') {
        if (options.containerElement) {
            containerTarget = options.containerElement;
        } else if (typeof options.containerId === 'string' && options.containerId.trim() !== '') {
            containerTarget = options.containerId;
        }
    }

    try {
        try { onProgress?.({ percent: 0, message: 'Preparing lateral chromatic aberration...' }); } catch (_) {}

        const xMinInput = document.getElementById('mca-xmin-input') as HTMLInputElement | null;
        const xMaxInput = document.getElementById('mca-xmax-input') as HTMLInputElement | null;
        const optXMin = (options && typeof options === 'object') ? Number((options as any).xMin) : NaN;
        const optXMax = (options && typeof options === 'object') ? Number((options as any).xMax) : NaN;
        let xMin = Number.isFinite(optXMin) ? optXMin : Number(xMinInput?.value);
        let xMax = Number.isFinite(optXMax) ? optXMax : Number(xMaxInput?.value);
        if (!Number.isFinite(xMin)) xMin = -0.05;
        if (!Number.isFinite(xMax)) xMax = 0.05;
        if (xMin >= xMax) {
            xMin = -0.05;
            xMax = 0.05;
        }

        const tableOpticalSystem = getTableOpticalSystem();
        const tableObject = getTableObject();
        const tableSource = getTableSource();
        const opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
        const objectRows = getObjectRows(tableObject);
        const sourceRows = getSourceRows(tableSource);

        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            throw new Error('光学系データが見つかりません');
        }

        const inferObjectFieldMode = (objects: any) => {
            const rows = Array.isArray(objects) ? objects : [];
            const pickTag = (o: any) => {
                const raw = o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type;
                return (raw ?? '').toString().toLowerCase();
            };
            const tags = rows.map(pickTag).filter(Boolean);
            const hasRect = tags.some(t => t.includes('rect') || t.includes('rectangle'));
            const hasHeight = tags.some(t => t.includes('height'));
            if (hasRect || hasHeight) return { mode: 'height' };
            const hasAngle = tags.some(t => t.includes('angle'));
            if (hasAngle) return { mode: 'angle' };

            const heightCandidates = rows
                .map((o: any) => parseFloat(o?.yHeight ?? o?.y ?? NaN))
                .filter(v => Number.isFinite(v));
            if (heightCandidates.length > 0) return { mode: 'height' };
            return { mode: 'angle' };
        };

        const fieldMode = inferObjectFieldMode(objectRows);
        const heightMode = fieldMode.mode === 'height';

        const rawFieldValues = (objectRows || [])
            .map((o: any) => {
                if (heightMode) {
                    return parseFloat(o?.yHeight ?? o?.y ?? o?.yHeightAngle ?? NaN);
                }
                return parseFloat(o?.yHeightAngle ?? o?.yFieldAngle ?? o?.yAngle ?? o?.fieldAngle ?? o?.y ?? NaN);
            })
            .filter(v => Number.isFinite(v))
            .map(v => Math.abs(v));

        if (rawFieldValues.length === 0) {
            throw new Error('Objectテーブルに有効な値がありません');
        }

        const maxFieldValue = Math.max(...rawFieldValues.map(v => Number(v)));
        if (!Number.isFinite(maxFieldValue) || maxFieldValue <= 0) {
            throw new Error('Objectテーブルに有効な最大値がありません');
        }

        const pointCountInput = document.getElementById('mca-point-count-input') as HTMLInputElement | null;
        const optPointCount = (options && typeof options === 'object') ? Number((options as any).pointCount) : NaN;
        let pointCount = Number.isFinite(optPointCount) ? Math.round(optPointCount) : Number(pointCountInput?.value);
        if (!Number.isFinite(pointCount) || pointCount < 2) pointCount = 11;

        const fieldValues: number[] = [];
        if (pointCount <= 1) {
            fieldValues.push(maxFieldValue);
        } else {
            for (let i = 0; i < pointCount; i++) {
                const v = (maxFieldValue * i) / (pointCount - 1);
                fieldValues.push(Number(v.toFixed(6)));
            }
        }

        const normalizeUm = (raw: any) => {
            const n = Number(raw);
            if (!Number.isFinite(n) || n <= 0) return null;
            return n > 10 ? (n / 1000) : n;
        };
        const fallbackWavelengths = [0.4358, 0.5876, 0.6563];
        const wavelengths = (() => {
            const rows = Array.isArray(sourceRows) ? sourceRows : [];
            const unique: number[] = [];
            for (const row of rows) {
                const wl = normalizeUm(row?.wavelength ?? row?.Wavelength);
                if (wl === null) continue;
                if (!unique.some(w => Math.abs(w - wl) < 1e-12)) unique.push(wl);
                if (unique.length >= 6) break;
            }
            return unique.length > 0 ? unique : fallbackWavelengths.slice();
        })();

        const referenceWavelength = 0.5876;
        if (!wavelengths.some(w => Math.abs(w - referenceWavelength) < 1e-6)) {
            wavelengths.push(referenceWavelength);
            wavelengths.sort((a, b) => a - b);
        }

        const { runNativeMagnificationChromaticAberration } = await import('../src/desktop/ipc/client.ts');
        const { plotMagnificationChromaticAberration } = await import('../evaluation/aberrations/magnification-chromatic-aberration-plot.js');

        const data = await runNativeMagnificationChromaticAberration({
            opticalSystemRows,
            sourceRows,
            fieldSamples: fieldValues,
            wavelengths,
            referenceWavelength,
            heightMode,
            chiefRayDefinition,
        } as any);
        try {
            console.log('📊 [LCA] backend:', (data as any)?.backend || (data as any)?.meta?.backend || 'unknown');
        } catch (_) {}

        if (!data) {
            throw new Error('倍率色収差の計算に失敗しました');
        }

        try { onProgress?.({ percent: 95, message: 'Rendering...' }); } catch (_) {}

        const plotted = plotMagnificationChromaticAberration(
            data,
            containerTarget,
            { xMin, xMax }
        );
        if (!plotted) {
            throw new Error('倍率色収差: 描画可能な有効データがありません');
        }

        try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
        console.log('✅ Lateral chromatic aberration diagram generated successfully');
    } catch (error) {
        console.error('❌ Lateral chromatic aberration diagram error:', error);
        const container = typeof containerTarget === 'string'
            ? document.getElementById(containerTarget)
            : containerTarget;
        if (container) {
            container.innerHTML = `<div style="padding: 20px; color: red; font-family: Arial;">
                <strong>Lateral chromatic aberration error:</strong><br>
                ${(error as any).message}<br>
                <small style="color: #888;">Check console for details</small>
            </div>`;
        }
        alert(`Lateral chromatic aberration error: ${(error as any).message}`);
    }
}

export async function showAstigmatismDiagram(options: any = {}): Promise<void> {
    console.log('📊 Starting astigmatism calculation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;
    const chiefRayDefinition = (options && typeof options === 'object' && typeof options.chiefRayDefinition === 'string')
        ? options.chiefRayDefinition
        : 'stop-center';
    const logChiefRayDefinition = (options && typeof options === 'object')
        ? !!options.logChiefRayDefinition
        : false;
    const useActiveConfigSnapshot = (options && typeof options === 'object')
        ? options.useActiveConfigSnapshot === true
        : false;
    const configId = (options && typeof options === 'object')
        ? options.configId
        : null;

    // Default target container is the in-page one
    let containerTarget: any = 'astigmatic-field-curves-container';
    if (options && typeof options === 'object') {
        if (options.containerElement) {
            containerTarget = options.containerElement;
        } else if (typeof options.containerId === 'string' && options.containerId.trim() !== '') {
            containerTarget = options.containerId;
        }
    }

    if (getIsGeneratingTransverseAberration()) {
        console.warn('⚠️ Astigmatism calculation already in progress');
        return;
    }

    try {
        setIsGeneratingTransverseAberration(true);

        try { onProgress?.({ percent: 0, message: 'Preparing...' }); } catch (_) {}

        const normalizeObjectRows = (rows: any) => {
            if (!Array.isArray(rows)) return [];
            return rows.map((r: any) => {
                if (!r || typeof r !== 'object') return r;
                const out = { ...r } as any;
                if (out.xHeightAngle == null && out['object x'] != null) out.xHeightAngle = out['object x'];
                if (out.yHeightAngle == null && out['object y'] != null) out.yHeightAngle = out['object y'];
                if (out.xHeightAngle == null && out.x != null) out.xHeightAngle = out.x;
                if (out.yHeightAngle == null && out.y != null) out.yHeightAngle = out.y;
                if (out.position == null && out.objectType != null) out.position = out.objectType;
                return out;
            });
        };
        const loadConfigSnapshot = () => {
            try {
                if (typeof localStorage === 'undefined') return null;
                const sys = loadSystemConfigurations();
                if (!sys || !Array.isArray(sys.configurations)) return null;
                const activeId = (sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                    ? String(sys.activeConfigId)
                    : '';
                const targetId = (configId !== null && configId !== undefined)
                    ? String(configId)
                    : activeId;
                if (!targetId) return null;
                const cfg = sys.configurations.find((c: any) => String(c?.id) === targetId);
                if (!cfg) return null;
                const sourceRows = (() => {
                    try {
                        const rows = loadSourceTableData();
                        return Array.isArray(rows) ? rows : [];
                    } catch (_) {
                        return [];
                    }
                })();
                return {
                    opticalSystemRows: Array.isArray(cfg.opticalSystem) ? cfg.opticalSystem : [],
                    objectRows: normalizeObjectRows(Array.isArray(cfg.object) ? cfg.object : []),
                    sourceRows
                };
            } catch (e) {
                console.warn('⚠️ Failed to load config snapshot for astigmatism:', e);
                return null;
            }
        };

        const tableOpticalSystem = getTableOpticalSystem();
        const tableSource = getTableSource();
        const tableObject = getTableObject();
        let opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
        let sourceRows = getSourceRows(tableSource);
        let objectRows = getObjectRows(tableObject);
        if (useActiveConfigSnapshot || (configId !== null && configId !== undefined)) {
            const snapshot = loadConfigSnapshot();
            if (snapshot?.opticalSystemRows?.length) {
                opticalSystemRows = snapshot.opticalSystemRows;
                if (Array.isArray(snapshot.sourceRows) && snapshot.sourceRows.length > 0) {
                    sourceRows = snapshot.sourceRows;
                }
                if (Array.isArray(snapshot.objectRows) && snapshot.objectRows.length > 0) {
                    objectRows = snapshot.objectRows;
                }
            }
        }

        if (!Array.isArray(objectRows) || objectRows.length === 0) {
            try {
                const directRows = (window as any).tableObject && Array.isArray((window as any).tableObject.data)
                    ? (window as any).tableObject.data
                    : null;
                if (Array.isArray(directRows) && directRows.length > 0) {
                    objectRows = directRows;
                }
            } catch (_) {}
        }

        if ((!Array.isArray(objectRows) || objectRows.length === 0) && typeof localStorage !== 'undefined') {
            try {
                const raw = localStorage.getItem('objectTableData');
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        objectRows = parsed;
                    }
                }
            } catch (_) {}
        }

        if (!Array.isArray(sourceRows) || sourceRows.length === 0) {
            try {
                const loadedSourceRows = loadSourceTableData();
                if (Array.isArray(loadedSourceRows) && loadedSourceRows.length > 0) {
                    sourceRows = loadedSourceRows;
                }
            } catch (_) {}
        }

        if (!Array.isArray(objectRows) || objectRows.length === 0) {
            const conjugateType = detectConjugateType(opticalSystemRows);
            const isInfinite = String(conjugateType).toLowerCase() !== 'finite';
            objectRows = [
                isInfinite
                    ? {
                        name: 'AutoField0',
                        position: 'Angle',
                        xHeightAngle: 0,
                        yHeightAngle: 0,
                        x: 0,
                        y: 0,
                    }
                    : {
                        name: 'AutoField0',
                        position: 'Rectangle',
                        xHeight: 0,
                        yHeight: 0,
                        x: 0,
                        y: 0,
                    }
            ];
            console.warn(`[ASTIG_DEBUG][FALLBACK_OBJECT] Injected default object row for conjugate=${conjugateType}`);
        }

        console.log(
            `[ASTIG_DEBUG][INPUT_ROWS] optical=${Array.isArray(opticalSystemRows) ? opticalSystemRows.length : 0} ` +
            `source=${Array.isArray(sourceRows) ? sourceRows.length : 0} ` +
            `object=${Array.isArray(objectRows) ? objectRows.length : 0} ` +
            `snapshot=${useActiveConfigSnapshot || (configId !== null && configId !== undefined)}`
        );
        try {
            onProgress?.({
                percent: 12,
                message:
                    `Input optical=${Array.isArray(opticalSystemRows) ? opticalSystemRows.length : 0} ` +
                    `source=${Array.isArray(sourceRows) ? sourceRows.length : 0} ` +
                    `object=${Array.isArray(objectRows) ? objectRows.length : 0}`
            });
        } catch (_) {}

        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            throw new Error('光学系データが見つかりません');
        }

        const rayCountFromOption = Number(options?.rayCount);
        const rayCount = Number.isFinite(rayCountFromOption)
            ? Math.max(9, Math.min(2001, Math.round(rayCountFromOption)))
            : 30;
        const ringCountFromOption = Number(options?.ringCount);
        const ringCount = Number.isFinite(ringCountFromOption)
            ? Math.max(1, Math.min(64, Math.round(ringCountFromOption)))
            : 32;
        const patternFromOption = String(options?.pattern || '').trim().toLowerCase();
        const pattern: 'grid' | 'cross' | 'annular' = (
            patternFromOption === 'grid' || patternFromOption === 'cross' || patternFromOption === 'annular'
        )
            ? (patternFromOption as 'grid' | 'cross' | 'annular')
            : 'annular';

        // Get ray filter setting (optional)
        const rayFilterSelect = document.getElementById('astigmatism-ray-filter') as HTMLSelectElement | null;
        const rayFilter = rayFilterSelect ? rayFilterSelect.value : 'all';

        // Get field mode setting (optional)
        const fieldModeSelect = document.getElementById('astigmatism-field-mode') as HTMLSelectElement | null;
        const fieldMode = fieldModeSelect ? fieldModeSelect.value : 'interpolate';
        
        // Get chief ray mode setting (optional)
        const chiefRayModeSelect = document.getElementById('astigmatism-chief-ray-mode') as HTMLSelectElement | null;
        const chiefRayDefinitionMap: Record<string, ChiefRayMode> = {
            'stop-center': 'stopCenter',
            'beam-midpoint': 'beamCenter',
            'beam-centroid': 'centroid'
        };
        const chiefRayModeFromPopup = chiefRayDefinitionMap[chiefRayDefinition] || null;
        const chiefRayModeValue = chiefRayModeFromPopup
            ? chiefRayModeFromPopup
            : (chiefRayModeSelect ? chiefRayModeSelect.value : 'stopCenter');
        type ChiefRayMode = 'stopCenter' | 'beamCenter' | 'centroid';
        const chiefRayModeCandidates: ChiefRayMode[] = [
            'stopCenter',
            'beamCenter',
            'centroid'
        ];
        const chiefRayMode: ChiefRayMode = chiefRayModeCandidates.includes(chiefRayModeValue as ChiefRayMode)
            ? (chiefRayModeValue as ChiefRayMode)
            : 'stopCenter';

        // 補間モードの場合、0°から最大値まで100等分した画角を生成
        // ただし Rectangle/height 指定が1件でもあれば高さモードとみなし、補間は行わずそのまま使う
        let processedObjectRows = objectRows;
        const hasHeightRect = (objectRows || []).some((obj: any) => {
            const pos = (obj.position || obj.fieldType || obj.type || '').toLowerCase();
            return pos.includes('height') || pos.includes('rect');
        });

        if (fieldMode === 'interpolate' && (objectRows || []).length > 0 && !hasHeightRect) {
            // Y方向の最大角度を取得
            const maxYAngle = Math.max(...objectRows.map((obj: any) => Math.abs(parseFloat(obj.yHeightAngle || 0))));

            // 0°から最大値まで100等分（101点）
            const subdivisions = 50;
            const interpolationProgressStart = 16;
            const interpolationProgressEnd = 60;
            processedObjectRows = [];
            try {
                onProgress?.({
                    percent: interpolationProgressStart,
                    message: `Interpolating fields 0/${subdivisions} (angle=0.00° / max=${maxYAngle.toFixed(2)}°)`
                });
            } catch (_) {}
            for (let i = 0; i <= subdivisions; i++) {
                const angle = (maxYAngle * i) / subdivisions;
                processedObjectRows.push({
                    name: `Field${i}`,
                    xHeightAngle: 0,
                    yHeightAngle: angle,
                    position: 'angle'
                });
                const interpolationRatio = subdivisions > 0 ? (i / subdivisions) : 1;
                const interpolationPercent = interpolationProgressStart + (interpolationProgressEnd - interpolationProgressStart) * interpolationRatio;
                try {
                    onProgress?.({
                        percent: interpolationPercent,
                        message: `Interpolating fields ${i}/${subdivisions} (angle=${angle.toFixed(2)}° / max=${maxYAngle.toFixed(2)}°)`
                    });
                } catch (_) {}
            }

        }

        // Use last surface (image surface) as evaluation surface
        const targetSurfaceIndex = opticalSystemRows.length - 1;

        const { runNativeAstigmatism } = await import('../src/desktop/ipc/client.ts');
        const { plotAstigmaticFieldCurves } = await import('../evaluation/aberrations/astigmatism-plot.js');
        const fieldCurvesData: any = await runNativeAstigmatism({
            opticalSystemRows,
            sourceRows: sourceRows || [],
            objectRows: processedObjectRows || [],
            surfaceIndex: targetSurfaceIndex,
            rayCount,
            ringCount,
            pattern,
            chiefRayMode,
            wavelengthMode: 'all',
        });
        const astigBackend = String((fieldCurvesData as any)?.backend || 'tauri-native').trim();
        console.log(`[ASTIG_BACKEND] ${astigBackend}`);
        try {
            onProgress?.({ percent: 92, message: `Backend: ${astigBackend}` });
        } catch (_) {}

        const astigRows = Array.isArray((fieldCurvesData as any)?.data) ? (fieldCurvesData as any).data : [];
        const validMeridionalCount = astigRows.filter((row: any) => row?.meridionalDeviation !== null && row?.meridionalDeviation !== undefined && Number.isFinite(Number(row?.meridionalDeviation))).length;
        const validSagittalCount = astigRows.filter((row: any) => row?.sagittalDeviation !== null && row?.sagittalDeviation !== undefined && Number.isFinite(Number(row?.sagittalDeviation))).length;
        const wavelengthCount = new Set(astigRows.map((row: any) => Number(row?.wavelength)).filter((wl: number) => Number.isFinite(wl))).size;
        try {
            onProgress?.({
                percent: 94,
                message:
                    `Summary rows=${astigRows.length} validM=${validMeridionalCount} ` +
                    `validS=${validSagittalCount} wl=${wavelengthCount}`
            });
        } catch (_) {}

        if (!fieldCurvesData || !(fieldCurvesData as any).data || (fieldCurvesData as any).data.length === 0) {
            console.warn('⚠️ 非点収差曲線データの生成に失敗しました');
            try {
                onProgress?.({
                    percent: 100,
                    message: `No plot data (rows=${astigRows.length}, validM=${validMeridionalCount}, validS=${validSagittalCount})`
                });
            } catch (_) {}
            const targetContainer = (typeof containerTarget === 'string')
                ? document.getElementById(containerTarget)
                : containerTarget;
            if (targetContainer) {
                targetContainer.innerHTML =
                    '<div style="padding:16px;color:#b00020;font-family:Arial;">' +
                    '<div style="font-weight:600;margin-bottom:6px;">No astigmatism plot data</div>' +
                    `<div style="font-size:12px;color:#444;">rows=${astigRows.length}, validM=${validMeridionalCount}, validS=${validSagittalCount}</div>` +
                    '</div>';
            }
        } else {
            try { onProgress?.({ percent: 95, message: 'Rendering...' }); } catch (_) {}
            try {
                plotAstigmaticFieldCurves(containerTarget, fieldCurvesData);
                try { onProgress?.({ percent: 100, message: '' }); } catch (_) {}
            } catch (plotError) {
                throw plotError;
            }
        }

        console.log('✅ Astigmatism diagram generated successfully');
    } catch (error) {
        console.error('❌ Astigmatism diagram error:', error);
        alert(`Astigmatism diagram error: ${(error as any).message}`);
    } finally {
        setIsGeneratingTransverseAberration(false);
    }
}

/**
 * Show spherical aberration diagram (球面収差図)
 * Displays longitudinal aberration as a function of pupil coordinate
 */
export async function showLongitudinalAberrationDiagram(options: any = {}): Promise<void> {
    console.log('📊 Starting spherical aberration calculation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    // Default target container is the in-page one
    let containerTarget: any = 'longitudinal-aberration-container';
    if (options && typeof options === 'object') {
        if (options.containerElement) {
            containerTarget = options.containerElement;
        } else if (typeof options.containerId === 'string' && options.containerId.trim() !== '') {
            containerTarget = options.containerId;
        }
    }
    
    // Check if already generating
    if (getIsGeneratingTransverseAberration()) {
        console.warn('⚠️ Spherical aberration calculation already in progress');
        return;
    }
    
    try {
        setIsGeneratingTransverseAberration(true);

        try { onProgress?.({ percent: 0, message: 'Preparing spherical aberration...' }); } catch (_) {}

        const precomputedAberrationData = options && typeof options === 'object'
            ? options.precomputedAberrationData
            : null;
        if (precomputedAberrationData && typeof precomputedAberrationData === 'object') {
            const { plotLongitudinalAberrationDiagram } = await import('../evaluation/aberrations/longitudinal-aberration-plot.js');
            try { onProgress?.({ percent: 95, message: 'Rendering...' }); } catch (_) {}
            await plotLongitudinalAberrationDiagram(precomputedAberrationData, containerTarget);
            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
            return;
        }
        
        // Get selected parameters with fallback defaults
        const rayCountInput = document.getElementById('longitudinal-ray-count-input') as HTMLInputElement | null;
        const referenceFocusModeInput = document.getElementById('longitudinal-reference-focus-mode') as HTMLSelectElement | null;
        
        // Use defaults if form elements not found
        let surfaceIndex = 0;  // Default to image surface
        let rayCount = 51;     // Default ray count for spherical aberration
        let referenceFocusMode = 'current-paraxial';
        
        // Get wavelengths from Source table for spherical aberration diagram.
        // Normalize nm→μm (e.g. 587.6nm → 0.5876μm) and drop invalid/≤0 entries.
        const tableSource = getTableSource();
        const sourceRows = getSourceRows(tableSource);
        const wavelengths = (() => {
            const normalizeUm = (raw: any) => {
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0) return null;
                if (n > 10) return n / 1000;
                return n;
            };

            const rows = Array.isArray(sourceRows) ? sourceRows : [];
            const unique: number[] = [];
            for (const row of rows) {
                const wl = normalizeUm(row?.wavelength ?? row?.Wavelength);
                if (wl === null || !Number.isFinite(wl) || wl <= 0) continue;
                if (!unique.some(w => Math.abs(w - wl) < 1e-12)) unique.push(wl);
                if (unique.length >= 6) break;
            }
            return unique.length > 0 ? unique : [0.5876];
        })();

        console.log(`📊 Wavelengths from Source table: ${wavelengths.map(w => w.toFixed(4)).join(', ')} μm`);
        
        // For longitudinal aberration, always use the last surface (image surface) as default
        let tableOpticalSystem = getTableOpticalSystem();
        let opticalSystemData = getOpticalSystemRows(tableOpticalSystem);
        if (opticalSystemData && opticalSystemData.length > 0) {
            surfaceIndex = opticalSystemData.length - 1; // Last surface (image)
            console.log(`📊 Using default image surface: Surface ${surfaceIndex + 1} (0-indexed: ${surfaceIndex})`);
        }
        
        const providedRayCount = Number.isInteger(options?.rayCount) ? options.rayCount : null;
        if (providedRayCount !== null && providedRayCount > 0) {
            rayCount = providedRayCount;
        } else if (rayCountInput && rayCountInput.value !== '') {
            rayCount = parseInt(rayCountInput.value) || 51;
        } else {
            console.warn('⚠️ Ray count input not found, using default (51)');
        }

        const providedReferenceMode = typeof options?.referenceFocusMode === 'string' ? options.referenceFocusMode : null;
        if (providedReferenceMode) {
            referenceFocusMode = providedReferenceMode;
        } else if (referenceFocusModeInput && referenceFocusModeInput.value) {
            referenceFocusMode = referenceFocusModeInput.value;
        }
        
        if (isNaN(surfaceIndex) || surfaceIndex < 0) {
            surfaceIndex = 0;
            console.warn('⚠️ Invalid surface index, using default (0)');
        }
        
        console.log(`📊 Calculating spherical aberration for surface ${surfaceIndex}, ${rayCount} rays, wavelengths: ${wavelengths.map(w => w.toFixed(4)).join(', ')} μm`);
        
        // Get data with proper table instances
        tableOpticalSystem = getTableOpticalSystem();
        const tableObject = getTableObject();
        
        const opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
        const objectRows = getObjectRows(tableObject);
        
        // Validate surface index against actual data
        if (opticalSystemRows && opticalSystemRows.length > 0) {
            const maxSurfaceIndex = opticalSystemRows.length - 1; // 0-indexed
            if (surfaceIndex > maxSurfaceIndex) {
                console.warn(`⚠️ Surface index ${surfaceIndex} is too large, using last surface (${maxSurfaceIndex})`);
                surfaceIndex = maxSurfaceIndex;
            }
        }
        
        console.log(`📊 Final surface index: ${surfaceIndex} (0-indexed), using as targetSurfaceIndex: ${surfaceIndex}`);
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            throw new Error('No optical system data available');
        }
        
        if (!objectRows || objectRows.length === 0) {
            throw new Error('No object data available');
        }
        
        // Calculate longitudinal aberration using async wrapper (allows progress UI repaint)
        const { calculateLongitudinalAberrationAsync } = await import('../evaluation/aberrations/longitudinal-aberration.js');
        const { plotLongitudinalAberrationDiagram } = await import('../evaluation/aberrations/longitudinal-aberration-plot.js');
        
        const aberrationData = await calculateLongitudinalAberrationAsync(
            opticalSystemRows,
            surfaceIndex,
            wavelengths as any, // Array of wavelengths from Source table
            rayCount,
            { onProgress, debugSA: Boolean(w.__COOPT_DEBUG_SA), referenceFocusMode } as any
        );
        
        if (!aberrationData) {
            throw new Error('Failed to calculate spherical aberration data');
        }
        
        // Plot spherical aberration diagram
        try { onProgress?.({ percent: 95, message: 'Rendering...' }); } catch (_) {}
        await plotLongitudinalAberrationDiagram(aberrationData, containerTarget);

        try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
        
        console.log('✅ Spherical aberration diagram generated successfully');
        
    } catch (error) {
        console.error('❌ Error generating longitudinal aberration diagram:', error);
        const container = typeof containerTarget === 'string'
            ? document.getElementById(containerTarget)
            : containerTarget;
        if (container) {
            container.innerHTML = `<div style="padding: 20px; color: red; font-family: Arial;">
                <strong>Spherical aberration error:</strong><br>
                ${(error as any).message}<br>
                <small style="color: #888;">Check console for details</small>
            </div>`;
        }
        alert(`Error generating longitudinal aberration diagram: ${(error as any).message}`);
    } finally {
        setIsGeneratingTransverseAberration(false);
    }
}

/**
 * Output chief ray convergence data to debug
 */
export function outputChiefRayConvergenceData(aberrationData: any): void {
    console.log('📈 === Chief Ray Convergence Data ===');
    
    if (!aberrationData || !aberrationData.chiefRayData) {
        console.warn('⚠️ No chief ray data available');
        return;
    }
    
    const chiefRayData = aberrationData.chiefRayData;
    
    console.log(`Field angles: X=${chiefRayData.fieldAngleX}°, Y=${chiefRayData.fieldAngleY}°`);
    console.log(`Entrance pupil position: ${chiefRayData.entrancePupilPosition?.toFixed(4) || 'N/A'}`);
    console.log(`Exit pupil position: ${chiefRayData.exitPupilPosition?.toFixed(4) || 'N/A'}`);
    
    if (chiefRayData.convergencePoint) {
        console.log(`Chief ray convergence point: (${chiefRayData.convergencePoint.x.toFixed(4)}, ${chiefRayData.convergencePoint.y.toFixed(4)}, ${chiefRayData.convergencePoint.z.toFixed(4)})`);
    }
    
    if (chiefRayData.aberrationCoefficients) {
        console.log('Aberration coefficients:');
        Object.entries(chiefRayData.aberrationCoefficients).forEach(([key, value]) => {
            console.log(`  ${key}: ${(value as number).toFixed(6)}`);
        });
    }
    
    console.log('================================');
}

/**
 * Calculate scene bounds for camera fitting
 */
export function calculateSceneBounds(): any {
    const scene = getScene();
    if (!scene) return null;
    
    const bounds: any = {
        minX: Infinity,
        maxX: -Infinity,
        minY: Infinity,
        maxY: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity
    };
    
    let hasObjects = false;
    
    // Calculate bounds from all visible objects
    scene.children.forEach(child => {
        if (child.visible && ((child as any).isMesh || (child as any).isLine || (child as any).isGroup)) {
            if (child.type !== 'AmbientLight' && child.type !== 'DirectionalLight') {
                const box = new THREE.Box3().setFromObject(child);
                
                if (!box.isEmpty()) {
                    bounds.minX = Math.min(bounds.minX, box.min.x);
                    bounds.maxX = Math.max(bounds.maxX, box.max.x);
                    bounds.minY = Math.min(bounds.minY, box.min.y);
                    bounds.maxY = Math.max(bounds.maxY, box.max.y);
                    bounds.minZ = Math.min(bounds.minZ, box.min.z);
                    bounds.maxZ = Math.max(bounds.maxZ, box.max.z);
                    hasObjects = true;
                }
            }
        }
    });
    
    if (!hasObjects) {
        console.warn('⚠️ No visible objects found for bounds calculation');
        return null;
    }
    
    // Calculate center and size
    bounds.centerX = (bounds.minX + bounds.maxX) / 2;
    bounds.centerY = (bounds.minY + bounds.maxY) / 2;
    bounds.centerZ = (bounds.minZ + bounds.maxZ) / 2;
    bounds.sizeX = bounds.maxX - bounds.minX;
    bounds.sizeY = bounds.maxY - bounds.minY;
    bounds.sizeZ = bounds.maxZ - bounds.minZ;
    bounds.maxSize = Math.max(bounds.sizeX, bounds.sizeY, bounds.sizeZ);
    
    return bounds;
}

/**
 * Fit camera to scene bounds
 */
export function fitCameraToScene(): void {
    const camera = getCamera();
    const controls = getControls();
    const renderer = getRenderer();
    
    if (!camera || !controls || !renderer) {
        console.warn('⚠️ Camera, controls, or renderer not available');
        return;
    }
    
    const bounds = calculateSceneBounds();
    if (!bounds) {
        console.warn('⚠️ No scene bounds available for camera fitting');
        return;
    }
    
    console.log('🎥 Fitting camera to scene bounds...');
    console.log(`Scene bounds: (${bounds.minX.toFixed(2)}, ${bounds.minY.toFixed(2)}, ${bounds.minZ.toFixed(2)}) to (${bounds.maxX.toFixed(2)}, ${bounds.maxY.toFixed(2)}, ${bounds.maxZ.toFixed(2)})`);
    
    // Calculate optimal camera position
    const distance = bounds.maxSize * 1.5;
    const cameraPosition = {
        x: bounds.centerX,
        y: bounds.centerY,
        z: bounds.centerZ + distance
    };
    
    // Update camera position and target
    (camera as any).position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    controls.target.set(bounds.centerX, bounds.centerY, bounds.centerZ);
    
    // Update orthographic camera view size if needed
    if ((camera as any).isOrthographicCamera) {
        const aspect = (camera as any).right / (camera as any).top;
        const frustumSize = bounds.maxSize * 0.6;
        
        (camera as any).left = -frustumSize * aspect / 2;
        (camera as any).right = frustumSize * aspect / 2;
        (camera as any).top = frustumSize / 2;
        (camera as any).bottom = -frustumSize / 2;
        camera.updateProjectionMatrix();
    }
    
    // Update controls
    controls.update();
    
    // Render the scene
    renderer.render(getScene()!, camera);
    
    console.log(`🎥 Camera fitted to scene, distance: ${distance.toFixed(2)}`);
    console.log(`🎥 Camera position: (${(camera as any).position.x.toFixed(2)}, ${(camera as any).position.y.toFixed(2)}, ${(camera as any).position.z.toFixed(2)})`);
}

/**
 * Create test PSF data for performance testing
 */
export function createTestPSFData(size: number = 256): any {
    console.log(`🧪 Creating test PSF data (${size}x${size})...`);
    
    const psfData = new Float32Array(size * size);
    const center = size / 2;
    const sigma = size / 10; // Standard deviation for Gaussian
    
    // Generate a 2D Gaussian PSF
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - center;
            const dy = y - center;
            const r2 = dx * dx + dy * dy;
            const value = Math.exp(-r2 / (2 * sigma * sigma));
            psfData[y * size + x] = value;
        }
    }
    
    // Normalize the PSF
    const maxValue = Math.max(...psfData);
    for (let i = 0; i < psfData.length; i++) {
        psfData[i] /= maxValue;
    }
    
    console.log(`✅ Test PSF data created (${size}x${size})`);
    
    return {
        data: psfData,
        width: size,
        height: size,
        gridSize: size,
        pixelSize: 1.0, // μm per pixel
        wavelength: 550, // nm
        statistics: {
            peak: 1.0,
            total: psfData.reduce((sum, val) => sum + val, 0),
            rms: Math.sqrt(psfData.reduce((sum, val) => sum + val * val, 0) / psfData.length)
        }
    };
}

/**
 * Run plot performance test
 */
export async function runPlotPerformanceTest(): Promise<void> {
    console.log('🧪 Running plot performance test...');
    
    try {
        // 削除されたperformance-monitor.jsの代わりに基本的なパフォーマンステストを実行
        console.log('⚠️ performance-monitor.js が見つからないため、基本テストを実行します');
        
        // Create test data
        const testSizes = [64, 128, 256, 512];
        const results = [];
        
        for (const size of testSizes) {
            console.log(`🧪 Testing ${size}x${size} plot performance...`);
            
            const startTime = performance.now();
            // 基本的なテスト実行
            const testData = Array.from({length: size * size}, () => Math.random());
            const endTime = performance.now();
            
            const result = {
                size: size,
                time: endTime - startTime,
                dataPoints: testData.length
            };
            
            results.push(result);
            console.log(`✅ ${size}x${size}: ${result.time.toFixed(2)}ms`);
            
            // Small delay to allow UI updates
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // 結果を表示
        console.log('📊 パフォーマンステスト結果:');
        results.forEach(result => {
            console.log(`  ${result.size}x${result.size}: ${result.time.toFixed(2)}ms (${result.dataPoints} データポイント)`);
        });
        
        console.log('✅ Plot performance test completed');
        
    } catch (error) {
        console.error('❌ Error running plot performance test:', error);
        alert(`Performance test failed: ${(error as any).message}`);
    }
}

/**
 * Show integrated aberration diagram (球面収差、非点収差、歪曲収差を統合)
 */
export async function showIntegratedAberrationDiagram(options: any = {}): Promise<void> {
    console.log('📊 Starting integrated aberration diagram calculation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;
    const useActiveConfigSnapshot = (options && typeof options === 'object')
        ? options.useActiveConfigSnapshot === true
        : false;
    const configId = (options && typeof options === 'object')
        ? options.configId
        : null;

    const mapProgress = (base: number, span: number, prefix?: string) => {
        if (!onProgress) return null;
        return (evt: any) => {
            try {
                const p = Number(evt?.percent);
                const msg = evt?.message || evt?.phase || 'Working...';
                const mapped = Number.isFinite(p) ? (base + (span * p) / 100) : base;
                onProgress({ percent: mapped, message: prefix ? `${prefix}: ${msg}` : msg });
            } catch (_) {}
        };
    };
    
    try {
        try { onProgress?.({ percent: 0, message: 'Starting...' }); } catch (_) {}
        const normalizeObjectRows = (rows: any) => {
            if (!Array.isArray(rows)) return [];
            return rows.map((r: any) => {
                if (!r || typeof r !== 'object') return r;
                const out = { ...r } as any;
                if (out.xHeightAngle == null && out['object x'] != null) out.xHeightAngle = out['object x'];
                if (out.yHeightAngle == null && out['object y'] != null) out.yHeightAngle = out['object y'];
                if (out.xHeightAngle == null && out.x != null) out.xHeightAngle = out.x;
                if (out.yHeightAngle == null && out.y != null) out.yHeightAngle = out.y;
                if (out.position == null && out.objectType != null) out.position = out.objectType;
                return out;
            });
        };
        const loadConfigSnapshot = () => {
            try {
                if (typeof localStorage === 'undefined') return null;
                const sys = loadSystemConfigurations();
                if (!sys || !Array.isArray(sys.configurations)) return null;
                const activeId = (sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                    ? String(sys.activeConfigId)
                    : '';
                const targetId = (configId !== null && configId !== undefined)
                    ? String(configId)
                    : activeId;
                if (!targetId) return null;
                const cfg = sys.configurations.find((c: any) => String(c?.id) === targetId);
                if (!cfg) return null;
                const snapshotSourceRows = (() => {
                    try {
                        const rows = loadSourceTableData();
                        return Array.isArray(rows) ? rows : [];
                    } catch (_) {
                        return [];
                    }
                })();
                return {
                    opticalSystemRows: Array.isArray(cfg.opticalSystem) ? cfg.opticalSystem : [],
                    objectRows: normalizeObjectRows(Array.isArray(cfg.object) ? cfg.object : []),
                    sourceRows: snapshotSourceRows
                };
            } catch (e) {
                console.warn('⚠️ Failed to load config snapshot for integrated aberration:', e);
                return null;
            }
        };

        // 光学系データを取得
        const tableOpticalSystem = getTableOpticalSystem();
        const tableObject = getTableObject();
        const tableSource = getTableSource();
        let opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
        let objectRows = normalizeObjectRows(getObjectRows(tableObject));
        let sourceRows = getSourceRows(tableSource);
        if (useActiveConfigSnapshot || (configId !== null && configId !== undefined)) {
            const snapshot = loadConfigSnapshot();
            if (snapshot?.opticalSystemRows?.length) {
                opticalSystemRows = snapshot.opticalSystemRows;
                objectRows = snapshot.objectRows;
                sourceRows = snapshot.sourceRows;
            }
        }
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            alert('光学系データがありません。');
            return;
        }
        
        // デフォルト設定
        // Integrated Aberration Diagram の球面収差は 100 本
        const rayCountSpherical = 100;
        const rayCountAstigmatism = 30;

        // Wavelengths:
        // - Prefer Source table wavelengths (μm). If the user entered nm (e.g. 587.6), normalize to μm.
        // - Fallback to g/d/C lines when Source is empty.
        const wavelengths = (() => {
            const fallback = [0.4308, 0.5876, 0.6563];
            const normalizeUm = (raw: any) => {
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0) return null;
                // Heuristic: values like 587.6 are nm; convert to μm.
                if (n > 10) return n / 1000;
                return n;
            };

            // Legend/calc order should match Source table order.
            const rows = Array.isArray(sourceRows) ? sourceRows : [];
            const unique: number[] = [];
            for (const row of rows) {
                const wl = normalizeUm(row?.wavelength);
                if (wl === null || !Number.isFinite(wl) || wl <= 0) continue;
                if (!unique.some(w => Math.abs(w - wl) < 1e-12)) unique.push(wl);
                if (unique.length >= 6) break;
            }
            return unique.length > 0 ? unique : fallback;
        })();
        
        // 像面インデックスを取得
        const surfaceIndex = opticalSystemRows.length - 1;  // 最終面（像面）
        
        console.log('📊 Calculating aberrations...');
        
        // 1. 球面収差データを計算
        console.log('📊 Calculating spherical aberration...');
        const { calculateLongitudinalAberrationAsync } = await import('../evaluation/aberrations/longitudinal-aberration.js');
        
        const longitudinalData = await calculateLongitudinalAberrationAsync(
            opticalSystemRows,
            surfaceIndex,
            wavelengths as any,
            rayCountSpherical,
            { onProgress: mapProgress(5, 30, 'Spherical'), referenceFocusMode: 'current-paraxial' } as any
        );
        
        if (!longitudinalData) {
            throw new Error('Failed to calculate longitudinal aberration');
        }
        
        // 2. 非点収差データを計算
        console.log('📊 Calculating astigmatism...');
        let astigmatismData: any = null;
        const { runNativeAstigmatism } = await import('../src/desktop/ipc/client.ts');
        const astigRingCount = 32;
        const astigPattern: 'annular' = 'annular';
        astigmatismData = await runNativeAstigmatism({
            opticalSystemRows,
            sourceRows: sourceRows || [],
            objectRows: objectRows || [],
            surfaceIndex,
            rayCount: rayCountAstigmatism,
            ringCount: astigRingCount,
            pattern: astigPattern,
            chiefRayMode: 'stopCenter',
            wavelengthMode: 'all',
        });
        
        if (!astigmatismData) {
            throw new Error('Failed to calculate astigmatism');
        }
        
        // 3. 歪曲収差データを計算
        console.log('📊 Calculating distortion...');
        const { runNativeDistortion, runNativeMagnificationChromaticAberration } = await import('../src/desktop/ipc/client.ts');
        const { deriveMaxFieldAngleFromObjects } = await import('../evaluation/aberrations/distortion-plot.js');
        
        // Decide field sweep (object angles vs object heights) based on Object table setting
        const inferObjectFieldMode = (objects: any) => {
            const rows = Array.isArray(objects) ? objects : [];
            const pickTag = (o: any) => {
                const raw = o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type;
                return (raw ?? '').toString().toLowerCase();
            };
            const tags = rows.map(pickTag).filter(Boolean);
            const hasRect = tags.some(t => t.includes('rect') || t.includes('rectangle'));
            const hasHeight = tags.some(t => t.includes('height'));
            if (hasRect || hasHeight) return { mode: 'height' };
            const hasAngle = tags.some(t => t.includes('angle'));
            if (hasAngle) return { mode: 'angle' };

            // Fallback if tags are missing
            const heightCandidates = (rows || []).map((o: any) => parseFloat(o?.yHeight ?? o?.y ?? o?.yHeightAngle ?? NaN)).filter(v => Number.isFinite(v));
            const angleCandidates = (rows || []).map((o: any) => parseFloat(o?.fieldAngle ?? o?.yFieldAngle ?? o?.yAngle ?? NaN)).filter(v => Number.isFinite(v));
            if (heightCandidates.length > 0 && angleCandidates.length === 0) return { mode: 'height' };
            return { mode: 'angle' };
        };
        const fieldMode = inferObjectFieldMode(objectRows);
        const heightMode = fieldMode.mode === 'height';

        const heightCandidates = (objectRows || []).map((o: any) => parseFloat(o.yHeight ?? o.y ?? o.yHeightAngle ?? NaN)).filter(v => Number.isFinite(v));

        const numPoints = 10;
        let fieldValues: number[] = [];
        if (heightMode) {
            let minH = Math.min(...heightCandidates);
            let maxH = Math.max(...heightCandidates);
            if (minH <= 0) {
                minH = 0.001; // avoid 0mm sample
                if (maxH < minH) maxH = minH;
            }
            if (minH === maxH) {
                fieldValues = [minH];
            } else {
                for (let i = 0; i < numPoints; i++) {
                    const h = minH + ((maxH - minH) * i) / (numPoints - 1);
                    fieldValues.push(parseFloat(h.toFixed(6)));
                }
            }
            console.log(`📊 Object heights for distortion (${fieldValues.length} points): ${fieldValues.join(', ')} mm`);
        } else {
            const maxFieldAngle = deriveMaxFieldAngleFromObjects();
            const minFieldAngle = maxFieldAngle * 0.001;  // 軸上色収差の観点から0を避ける
            for (let i = 0; i < numPoints; i++) {
                const angle = minFieldAngle + ((maxFieldAngle - minFieldAngle) * i) / (numPoints - 1);
                fieldValues.push(parseFloat(angle.toFixed(6)));
            }
            console.log(`📊 Field angles for distortion (${numPoints} points, starting from ${minFieldAngle.toFixed(6)}°): ${fieldValues.join(', ')}°`);
        }
        
        // 各波長で歪曲収差を計算
        const distortionDataByWavelength = [];
        for (let wlIndex = 0; wlIndex < wavelengths.length; wlIndex++) {
            const wavelength = wavelengths[wlIndex];
            const wlBase = 70 + (25 * wlIndex) / Math.max(1, wavelengths.length);
            const wlSpan = 25 / Math.max(1, wavelengths.length);
            const distData = await runNativeDistortion({
                opticalSystemRows,
                fieldSamples: fieldValues,
                heightMode,
                wavelength,
            } as any);
            if (distData) {
                distortionDataByWavelength.push({
                    wavelength: wavelength,
                    data: distData
                });
            }
        }
        
        if (distortionDataByWavelength.length === 0) {
            throw new Error('Failed to calculate distortion for any wavelength');
        }

        // 4. Lateral Chromatic Aberration (LCA) データを計算
        console.log('📊 Calculating lateral chromatic aberration...');
        const lcaMaxField = heightMode
            ? Math.max(...heightCandidates)
            : Math.max(...fieldValues.map(v => Math.abs(v)));
        const lcaPointCount = 21;
        const lcaFieldValues: number[] = [];
        if (Number.isFinite(lcaMaxField) && lcaMaxField > 0) {
            for (let i = 0; i < lcaPointCount; i++) {
                const v = (lcaMaxField * i) / (lcaPointCount - 1);
                lcaFieldValues.push(Number(v.toFixed(6)));
            }
        }

        const lcaData = lcaFieldValues.length > 0
            ? await runNativeMagnificationChromaticAberration({
                opticalSystemRows,
                sourceRows,
                fieldSamples: lcaFieldValues,
                wavelengths,
                referenceWavelength: 0.5876,
                heightMode,
            } as any)
            : null;
        
        // 5. 統合収差図を表示
        console.log('📊 Plotting integrated aberration diagram...');
        const { plotIntegratedAberrationDiagram } = await import('../evaluation/aberrations/integrated-aberration-plot.js');

        try { onProgress?.({ percent: 96, message: 'Rendering...' }); } catch (_) {}
        
        // System Configuration名を取得
        const systemConfig = (typeof localStorage === 'undefined') ? null : loadSystemConfigurations();
        const activeConfig = systemConfig?.configurations?.find((c: any) => c && String(c.id) === String(systemConfig.activeConfigId));
        const configName = activeConfig ? activeConfig.name : 'Default';
        
        plotIntegratedAberrationDiagram(longitudinalData, astigmatismData, distortionDataByWavelength, lcaData, {
            width: 1440,
            height: 600,
            mainTitle: `Integrated Aberration Diagram - ${configName}`,
            configName: configName,
            ...(options?.containerElement ? { containerElement: options.containerElement } : {}),
            ...(options?.infoElement ? { infoElement: options.infoElement } : {})
        });

        try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
        
        console.log('✅ Integrated aberration diagram generated successfully');
        
    } catch (error) {
        console.error('❌ Error generating integrated aberration diagram:', error);
        alert(`Error generating integrated aberration diagram: ${(error as any).message}`);
    }
}
