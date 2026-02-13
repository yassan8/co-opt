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
import { detectConjugateType, ConjugateType } from '../utils/conjugate-detection.ts';
import { getSpotDiagramPattern, loadSpotDiagramSettingsByConfigId, saveSpotDiagramSettingsByConfigId, saveLastSpotDiagramSettings } from '../ui/spot-diagram-settings-storage.ts';
import { getScene, getCamera, getRenderer, getControls, getTableOpticalSystem, getTableObject, getTableSource,
         getIsGeneratingSpotDiagram, getIsGeneratingTransverseAberration,
         setIsGeneratingSpotDiagram, setIsGeneratingTransverseAberration } from '../core/app-config.ts';

let spotDiagramRequestCounter = 0;
let pendingSpotDiagramRequest: { requestId: number; options: any; requestedAt: number } | null = null;

function cloneOpticalSystemRowsWithDefocusShift(opticalSystemRows: any[], defocusShiftMm: number, isFiniteObject: boolean = false): any[] {
    const shift = Number(defocusShiftMm);
    if (!Array.isArray(opticalSystemRows)) return [];

    const cloned = opticalSystemRows.map((row) => (row && typeof row === 'object') ? { ...row } : row);
    if (!Number.isFinite(shift) || Math.abs(shift) < 1e-15) return cloned;

    if (isFiniteObject) {
        // Finite object: shift the object plane (first thickness)
        if (cloned.length > 0 && cloned[0]) {
            const objRow = (cloned[0] && typeof cloned[0] === 'object') ? { ...cloned[0] } : {};
            const baseThickness = Number(objRow.thickness);
            const safeBaseThickness = Number.isFinite(baseThickness) ? baseThickness : 0;
            objRow.thickness = safeBaseThickness - shift; // Negative to move object away/closer
            cloned[0] = objRow;
        }
    } else {
        // Infinite object: shift the image plane
        const imageIdx = cloned.findIndex((row) => row && (row['object type'] === 'Image' || row.object === 'Image'));
        const targetIdx = (imageIdx > 0) ? (imageIdx - 1) : Math.max(0, cloned.length - 2);
        if (targetIdx < 0 || targetIdx >= cloned.length) return cloned;

        const target = (cloned[targetIdx] && typeof cloned[targetIdx] === 'object') ? { ...cloned[targetIdx] } : {};
        const baseThickness = Number(target.thickness);
        const safeBaseThickness = Number.isFinite(baseThickness) ? baseThickness : 0;
        target.thickness = safeBaseThickness + shift;
        cloned[targetIdx] = target;
    }

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
    console.log('🎯 Starting spot diagram generation...');

    const requestId = ++spotDiagramRequestCounter;

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
        
        if (providedWavelengthNm !== null && providedWavelengthNm > 0) {
            wavelength = providedWavelengthNm;
        } else if (wavelengthInput && wavelengthInput.value !== '') {
            wavelength = parseFloat(wavelengthInput.value) || 550;
        } else {
            console.warn('⚠️ Wavelength input not found, using default (550nm)');
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
        try {
            const { generateSurfaceOptions } = await import('../evaluation/spot-diagram.js');
            const opts = generateSurfaceOptions(opticalSystemRows || []);
            
            // Detect conjugate type using unified detection
            const conjugateType = detectConjugateType(opticalSystemRows);
            
            console.log(`🔍 [Surface Resolution] Conjugate: ${conjugateType}, Looking for surfaceId=${surfaceId} in ${opts.length} options`);
            console.log(`🔍 [Surface Options Sample]:`, opts.slice(0, 3).map((o: any) => ({ surfaceId: o.surfaceId, value: o.value, rowIndex: o.rowIndex, label: o.label })));
            
            /**
             * Resolve surface for FINITE conjugate systems.
             * Strategy: Ensure Image surface selection is preserved across configs.
             * Detect if surfaceId accidentally matches Image-1 due to CB number differences.
             */
            const resolveSurfaceForFiniteConjugate = (): number | null => {
                // First, identify if Image surface exists in current config
                const imageOpt = opts.find((o: any) => typeof o?.label === 'string' && o.label.includes('(Image)'));
                
                console.log(`🔍 [Finite] Image surface found:`, imageOpt ? `surfaceId=${imageOpt.surfaceId}, rowIndex=${imageOpt.rowIndex}, label="${imageOpt.label}"` : 'NOT FOUND');
                
                // Strategy 1: Check if surfaceId matches Image surface's ID
                if (imageOpt && Number(imageOpt.surfaceId) === Number(surfaceId)) {
                    console.log(`✅ [Finite] surfaceId=${surfaceId} is Image surface at rowIndex=${imageOpt.rowIndex}`);
                    return imageOpt.rowIndex;
                }
                
                // Strategy 2: Direct surfaceId match (for non-Image surfaces)
                const match = opts.find((o: any) => Number(o?.surfaceId) === Number(surfaceId));
                if (match && Number.isInteger(match.rowIndex)) {
                    console.log(`🔍 [Finite] Found match: surfaceId=${surfaceId} → rowIndex=${match.rowIndex}, label="${match.label}"`);
                    
                    // Verify this isn't accidentally matching wrong surface due to CB differences
                    const isImageSurface = typeof match.label === 'string' && match.label.includes('(Image)');
                    if (!isImageSurface && imageOpt) {
                        const distance = Math.abs(match.rowIndex - imageOpt.rowIndex);
                        console.log(`🔍 [Finite] Distance from Image: ${distance} (match.rowIndex=${match.rowIndex}, imageOpt.rowIndex=${imageOpt.rowIndex})`);
                        
                        if (distance <= 1) {
                            // Matched surface is very close to Image surface, likely config mismatch
                            console.warn(`⚠️ [Finite] surfaceId=${surfaceId} matched rowIndex=${match.rowIndex} (${match.label}) is adjacent to Image at ${imageOpt.rowIndex}, using Image instead`);
                            return imageOpt.rowIndex;
                        }
                    }
                    console.log(`✅ [Finite] Matched surfaceId=${surfaceId} → rowIndex=${match.rowIndex} (${match.label})`);
                    return match.rowIndex;
                }
                
                console.warn(`⚠️ [Finite] surfaceId=${surfaceId} not found in current config`);
                
                // Strategy 3: Default to Image surface (most common expectation)
                if (imageOpt && Number.isInteger(imageOpt.rowIndex)) {
                    console.warn(`⚠️ [Finite] Using Image surface at rowIndex=${imageOpt.rowIndex}`);
                    return imageOpt.rowIndex;
                }
                
                // Strategy 4: Fallback to last surface
                if (opts.length > 0 && Number.isInteger(opts[opts.length - 1].rowIndex)) {
                    console.warn(`⚠️ [Finite] Using last surface at rowIndex=${opts[opts.length - 1].rowIndex}`);
                    return opts[opts.length - 1].rowIndex;
                }
                
                return null;
            };
            
            /**
             * Resolve surface for INFINITE conjugate systems.
             * Strategy: ALWAYS prioritize Image surface for infinite systems.
             * Infinite systems typically focus at the image plane regardless of surfaceId.
             */
            const resolveSurfaceForInfiniteConjugate = (): number | null => {
                // Strategy 1: For infinite systems, ALWAYS use Image surface (physical expectation)
                const imageOpt = opts.find((o: any) => typeof o?.label === 'string' && o.label.includes('(Image)'));
                if (imageOpt && Number.isInteger(imageOpt.rowIndex)) {
                    console.log(`✅ [Infinite] Using Image surface at rowIndex=${imageOpt.rowIndex} (surfaceId=${imageOpt.surfaceId})`);
                    return imageOpt.rowIndex;
                }
                
                // Strategy 2: If no Image surface found (unusual), try surfaceId match
                const match = opts.find((o: any) => Number(o?.surfaceId) === Number(surfaceId));
                if (match && Number.isInteger(match.rowIndex)) {
                    console.warn(`⚠️ [Infinite] No Image surface, matched surfaceId=${surfaceId} → rowIndex=${match.rowIndex}`);
                    return match.rowIndex;
                }
                
                // Strategy 3: Fallback to last surface
                if (opts.length > 0 && Number.isInteger(opts[opts.length - 1].rowIndex)) {
                    console.warn(`⚠️ [Infinite] Using last surface at rowIndex=${opts[opts.length - 1].rowIndex}`);
                    return opts[opts.length - 1].rowIndex;
                }
                
                return null;
            };
            
            // Route to appropriate resolver based on conjugate type
            resolvedSurfaceRowIndex = (conjugateType === 'finite')
                ? resolveSurfaceForFiniteConjugate()
                : resolveSurfaceForInfiniteConjugate();
            
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

            let primaryWavelengthUm = 0.5876;
            if (Array.isArray(sourceRows) && sourceRows.length > 0) {
                const parsed = sourceRows
                    .map((row: any, idx: number) => ({
                        idx,
                        wl: Number(row?.wavelength),
                        isPrimary: row?.primary === 'Primary Wavelength'
                    }))
                    .filter((e: any) => Number.isFinite(e.wl) && e.wl > 0);
                const primary = parsed.find((e: any) => e.isPrimary) || parsed[0] || null;
                if (primary) primaryWavelengthUm = primary.wl;
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
        
        // Validate surface index against actual data
        if (opticalSystemRows && opticalSystemRows.length > 0) {
            const maxSurfaceIndex = opticalSystemRows.length - 1; // 0-indexed
            if (surfaceIndex > maxSurfaceIndex) {
                console.warn(`⚠️ Surface index ${surfaceIndex} is too large, using last surface (${maxSurfaceIndex})`);
                surfaceIndex = maxSurfaceIndex;
            }
        }
        
        const surfaceNumber = surfaceIndex + 1;
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
            
            const spotDiagramData = await generateSpotDiagramAsync(
                opticalSystemRows,
                sourceRows || [],
                defaultObjectRows,
                surfaceNumber,
                rayCount,
                ringCount,
                { onProgress, physicalVignetting: true, displaySurfaceNumber: surfaceId, pattern: patternFromUi }
            );
            
            if (!spotDiagramData) {
                throw new Error('Failed to generate spot diagram data');
            }
            
            // Draw spot diagram with proper parameters
            try { onProgress?.({ percent: 90, message: 'Rendering...' }); } catch (_) {}
            await drawSpotDiagram(
                spotDiagramData, 
                surfaceNumber,
                containerTarget,
                (wavelength / 1000) as any // convert nm to μm
            );
            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
            
        } else {
            // Generate spot diagram with existing object data
            const { generateSpotDiagramAsync, drawSpotDiagram } = await import('../evaluation/spot-diagram.js');
            
            const spotDiagramData = await generateSpotDiagramAsync(
                opticalSystemRows,
                sourceRows || [],
                objectRows,
                surfaceNumber,
                rayCount,
                ringCount,
                { onProgress, physicalVignetting: true, displaySurfaceNumber: surfaceId, pattern: patternFromUi }
            );
            
            if (!spotDiagramData) {
                throw new Error('Failed to generate spot diagram data');
            }
            
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
            await drawSpotDiagram(
                spotDiagramData, 
                surfaceNumber,
                containerTarget,
                wavelength / 1000 as any // convert nm to μm
            );

            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
            
            console.log('✅ [SPOT DIAGRAM] drawSpotDiagram call completed');
        }
        
        console.log('✅ Spot diagram generated successfully');
        
    } catch (error) {
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
        const tableOpticalSystem = getTableOpticalSystem();
        const tableObject = getTableObject();
        const tableSource = getTableSource();

        const baseOpticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
        const objectRows = getObjectRows(tableObject);
        const sourceRows = getSourceRows(tableSource);

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

        const { generateSurfaceOptions, generateSpotDiagramAsync } = await import('../evaluation/spot-diagram.js');

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

        // Determine if using finite object (Point/Height) vs infinite object (Angle)
        const firstObject = objectRows[0] || {};
        const objectTypeRaw = String(firstObject.position ?? firstObject.object ?? firstObject.Object ?? firstObject.objectType ?? 'Angle').toLowerCase();
        const isFiniteObject = !objectTypeRaw.includes('angle');

        const focusGrid: any[][] = Array.from({ length: objectRows.length }, () => []);
        const patternFromOption = String(options?.pattern || '').trim().toLowerCase();
        const pattern = (patternFromOption === 'grid' || patternFromOption === 'annular')
            ? patternFromOption
            : getSpotDiagramPattern();

        for (let i = 0; i < defocusValues.length; i++) {
            const shift = defocusValues[i];
            const p = Math.floor((i / Math.max(1, defocusValues.length)) * 90);
            reportProgress(p, `Defocus ${shift.toFixed(4)} mm (${i + 1}/${defocusValues.length})`);

            const shiftedRows = cloneOpticalSystemRowsWithDefocusShift(baseOpticalSystemRows, shift, isFiniteObject);
            for (let objIdx = 0; objIdx < objectRows.length; objIdx++) {
                const mergedRawPoints: Array<{ x: number; y: number }> = [];
                const perWavelengthRaw: Array<{ key: string; label: string; color: string; points: Array<{ x: number; y: number }> }> = [];

                for (let wlIdx = 0; wlIdx < effectiveWavelengthRows.length; wlIdx++) {
                    const wlRow = effectiveWavelengthRows[wlIdx];
                    const wlValueUm = Number(wlRow?.wavelength);
                    const wlColor = getColorForWavelength(wlValueUm);
                    const wlLabel = String(wlRow.__label || `${(Number(wlRow.wavelength) * 1000).toFixed(1)} nm`);
                    reportProgress(
                        p,
                        `Defocus ${shift.toFixed(4)} mm (${i + 1}/${defocusValues.length}), λ ${wlIdx + 1}/${effectiveWavelengthRows.length}`
                    );

                    const spotResult = await generateSpotDiagramAsync(
                        shiftedRows,
                        [wlRow],
                        objectRows,
                        surfaceNumber,
                        rayCount,
                        ringCount,
                        {
                            onProgress: null,
                            physicalVignetting: true,
                            displaySurfaceNumber: surfaceId,
                            pattern
                        }
                    );

                    const objects = Array.isArray(spotResult?.spotData) ? spotResult.spotData : [];
                    const objData = objects[objIdx] || {};
                    const points = Array.isArray(objData?.spotPoints) ? objData.spotPoints : [];

                    const wlPoints: Array<{ x: number; y: number }> = [];

                    for (const pt of points) {
                        const x = Number(pt?.x || 0);
                        const y = Number(pt?.y || 0);
                        mergedRawPoints.push({ x, y });
                        wlPoints.push({ x, y });
                    }

                    perWavelengthRaw.push({
                        key: wlLabel,
                        label: wlLabel,
                        color: wlColor,
                        points: wlPoints
                    });
                }

                let cx = 0;
                let cy = 0;
                if (mergedRawPoints.length > 0) {
                    cx = mergedRawPoints.reduce((sum, pt) => sum + pt.x, 0) / mergedRawPoints.length;
                    cy = mergedRawPoints.reduce((sum, pt) => sum + pt.y, 0) / mergedRawPoints.length;
                }

                focusGrid[objIdx].push({
                    shiftMm: shift,
                    pointsByWavelength: perWavelengthRaw.map((group) => ({
                        key: group.key,
                        label: group.label,
                        color: group.color,
                        points: group.points.map((pt) => ({
                            xUm: (pt.x - cx) * 1000,
                            yUm: (pt.y - cy) * 1000
                        }))
                    }))
                });
            }
        }

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

/**
 * Show transverse aberration diagram
 */
export async function showTransverseAberrationDiagram(options: any = {}): Promise<void> {
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
                if (isCoordTransRow(row) || isObjectRow(row)) continue;
                targetSurfaceIndex = i;
                break;
            }
        }
        if (targetSurfaceIndex < 0) {
            targetSurfaceIndex = opticalSystemRows.length - 1;
        }
        console.log(`📊 評価面: Surface ${targetSurfaceIndex + 1}`);
        console.log(`📊 光線本数: ${rayCount}本`);

        const { getPrimaryWavelengthForAberration, calculateTransverseAberrationAsync } = await import('../evaluation/aberrations/transverse-aberration.js');
        const { plotTransverseAberrationDiagram } = await import('../evaluation/aberrations/transverse-aberration-plot.js');

        const wavelength = getPrimaryWavelengthForAberration(); // μm
        console.log(`📊 Wavelength: ${wavelength} μm`);

        const aberrationData = await calculateTransverseAberrationAsync(
            opticalSystemRows,
            targetSurfaceIndex,
            null,
            wavelength,
            rayCount,
            { onProgress } as any
        );

        if (!aberrationData) {
            throw new Error('Failed to calculate transverse aberration data');
        }

        try { onProgress?.({ percent: 95, message: 'Rendering...' }); } catch (_) {}
        plotTransverseAberrationDiagram(aberrationData, containerTarget, typeof containerTarget === 'string' ? document : containerTarget.ownerDocument);
        try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
        console.log('✅ Transverse aberration diagram generated successfully');
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
    } finally {
        setIsGeneratingTransverseAberration(false);
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

        try { onProgress?.({ percent: 0, message: 'Preparing astigmatism...' }); } catch (_) {}

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
                sourceRows = snapshot.sourceRows;
                objectRows = snapshot.objectRows;
            }
        }

        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            throw new Error('光学系データが見つかりません');
        }

        // Get ray count from (optional) input field or provided options
        const rayCountInput = document.getElementById('astigmatism-ray-count-input') as HTMLInputElement | null;
        let rayCount = 51; // Default
        const providedRayCount = Number.isInteger(options?.rayCount) ? options.rayCount : null;
        if (providedRayCount !== null && providedRayCount > 0) {
            rayCount = providedRayCount;
        } else if (rayCountInput) {
            const inputValue = parseInt(rayCountInput.value);
            if (!isNaN(inputValue) && inputValue > 0) {
                rayCount = inputValue;
            }
        }

        // Get ray filter setting (optional)
        const rayFilterSelect = document.getElementById('astigmatism-ray-filter') as HTMLSelectElement | null;
        const rayFilter = rayFilterSelect ? rayFilterSelect.value : 'all';

        // Get field mode setting (optional)
        const fieldModeSelect = document.getElementById('astigmatism-field-mode') as HTMLSelectElement | null;
        const fieldMode = fieldModeSelect ? fieldModeSelect.value : 'object';
        
        // Get chief ray mode setting (optional)
        const chiefRayModeSelect = document.getElementById('astigmatism-chief-ray-mode') as HTMLSelectElement | null;
        const chiefRayDefinitionMap: Record<string, ChiefRayMode> = {
            'stop-center': 'stopCenter',
            'beam-midpoint': 'beamCenter',
            'beam-centroid': 'centroid',
            'stop-center-image': 'stopCenterImage',
            'beam-midpoint-image': 'beamCenterImage',
            'beam-centroid-image': 'centroidImage'
        };
        const chiefRayModeFromPopup = chiefRayDefinitionMap[chiefRayDefinition] || null;
        const chiefRayModeValue = chiefRayModeFromPopup
            ? chiefRayModeFromPopup
            : (chiefRayModeSelect ? chiefRayModeSelect.value : 'stopCenter');
        type ChiefRayMode = 'stopCenter' | 'beamCenter' | 'centroid' | 'stopCenterImage' | 'beamCenterImage' | 'centroidImage';
        const chiefRayModeCandidates: ChiefRayMode[] = [
            'stopCenter',
            'beamCenter',
            'centroid',
            'stopCenterImage',
            'beamCenterImage',
            'centroidImage'
        ];
        const chiefRayMode: ChiefRayMode = chiefRayModeCandidates.includes(chiefRayModeValue as ChiefRayMode)
            ? (chiefRayModeValue as ChiefRayMode)
            : 'stopCenter';

        console.log(`📊 光線本数: ${rayCount}本`);
        console.log(`📊 光線フィルタ: ${rayFilter}`);
        console.log(`📊 画角モード: ${fieldMode}`);
        console.log(`📊 主光線モード: ${chiefRayMode}`);

        // 補間モードの場合、0°から最大値まで20等分した画角を生成
        // ただし Rectangle/height 指定が1件でもあれば高さモードとみなし、補間は行わずそのまま使う
        let processedObjectRows = objectRows;
        const hasHeightRect = (objectRows || []).some((obj: any) => {
            const pos = (obj.position || obj.fieldType || obj.type || '').toLowerCase();
            return pos.includes('height') || pos.includes('rect');
        });

        if (fieldMode === 'interpolate' && (objectRows || []).length > 0 && !hasHeightRect) {
            // Y方向の最大角度を取得
            const maxYAngle = Math.max(...objectRows.map((obj: any) => Math.abs(parseFloat(obj.yHeightAngle || 0))));

            console.log(`📊 最大Y角度: ${maxYAngle}°`);

            // 0°から最大値まで20等分（21点: 0%, 5%, 10%, ..., 100%）
            processedObjectRows = [];
            for (let i = 0; i <= 20; i++) {
                const angle = (maxYAngle * i) / 20;
                processedObjectRows.push({
                    name: `Field${i}`,
                    xHeightAngle: 0,
                    yHeightAngle: angle,
                    position: 'angle'
                });
            }

            console.log(`📊 補間画角生成: ${processedObjectRows.length}点 (0° ~ ${maxYAngle}°)`);
        } else if (fieldMode === 'interpolate' && hasHeightRect) {
            console.log('ℹ️ Rectangle/heightフィールドのため補間をスキップし、元のObjectを使用');
        }

        // Use last surface (image surface) as evaluation surface
        const targetSurfaceIndex = opticalSystemRows.length - 1;
        console.log(`📊 評価面: Surface ${targetSurfaceIndex + 1}`);

        const { calculateAstigmatismData } = await import('../evaluation/aberrations/astigmatism.js');
        const { plotAstigmaticFieldCurves } = await import('../evaluation/aberrations/astigmatism-plot.js');

        console.log('🎯 非点収差曲線データ生成中（RMS最小値探索）...');
        const fieldCurvesData = await calculateAstigmatismData(
            opticalSystemRows,
            sourceRows || [],
            processedObjectRows || [],
            targetSurfaceIndex,
            {
                spotDiagramMode: false,
                rayCount: rayCount,
                interpolationPoints: 20,
                chiefRayMode: chiefRayMode,
                onProgress
            }
        );

        if (!fieldCurvesData || !(fieldCurvesData as any).data || (fieldCurvesData as any).data.length === 0) {
            console.warn('⚠️ 非点収差曲線データの生成に失敗しました');
        } else {
            try { onProgress?.({ percent: 95, message: 'Rendering...' }); } catch (_) {}
            plotAstigmaticFieldCurves(containerTarget, fieldCurvesData);
            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
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
        
        // Get selected parameters with fallback defaults
        const rayCountInput = document.getElementById('longitudinal-ray-count-input') as HTMLInputElement | null;
        
        // Use defaults if form elements not found
        let surfaceIndex = 0;  // Default to image surface
        let rayCount = 51;     // Default ray count for spherical aberration
        
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
            { onProgress, debugSA: Boolean(w.__COOPT_DEBUG_SA) } as any
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
        // 光学系データを取得
        const tableOpticalSystem = getTableOpticalSystem();
        const tableObject = getTableObject();
        const tableSource = getTableSource();
        const opticalSystemRows = getOpticalSystemRows(tableOpticalSystem);
        const objectRows = getObjectRows(tableObject);
        const sourceRows = getSourceRows(tableSource);
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            alert('光学系データがありません。');
            return;
        }
        
        // デフォルト設定
        // Integrated Aberration Diagram の球面収差は固定で 20 本（Normalized Pupil を粗く分割して高速化）
        const rayCountSpherical = 20;
        const rayCountAstigmatism = 31;  // 非点収差用の光線数（計算時間を考慮）

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
            { onProgress: mapProgress(5, 30, 'Spherical') } as any
        );
        
        if (!longitudinalData) {
            throw new Error('Failed to calculate longitudinal aberration');
        }
        
        // 2. 非点収差データを計算
        console.log('📊 Calculating astigmatism...');
        const { calculateAstigmatismData } = await import('../evaluation/aberrations/astigmatism.js');
        
        const astigmatismData = await calculateAstigmatismData(
            opticalSystemRows,
            sourceRows,
            objectRows,
            surfaceIndex,
            { spotDiagramMode: false, rayCount: rayCountAstigmatism, interpolationPoints: 20 }
        );
        
        if (!astigmatismData) {
            throw new Error('Failed to calculate astigmatism');
        }
        
        // 3. 歪曲収差データを計算
        console.log('📊 Calculating distortion...');
        const { calculateDistortionData } = await import('../evaluation/aberrations/distortion.js');
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
            const distData = await calculateDistortionData(
                opticalSystemRows,
                fieldValues,
                wavelength,
                { heightMode, onProgress: mapProgress(wlBase, wlSpan, `Distortion (λ=${wavelength.toFixed(4)}μm)`) }
            );
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
        
        // 4. 統合収差図を表示
        console.log('📊 Plotting integrated aberration diagram...');
        const { plotIntegratedAberrationDiagram } = await import('../evaluation/aberrations/integrated-aberration-plot.js');

        try { onProgress?.({ percent: 96, message: 'Rendering...' }); } catch (_) {}
        
        // System Configuration名を取得
        const systemConfig = (typeof localStorage === 'undefined') ? null : loadSystemConfigurations();
        const activeConfig = systemConfig?.configurations?.find((c: any) => c && String(c.id) === String(systemConfig.activeConfigId));
        const configName = activeConfig ? activeConfig.name : 'Default';
        
        plotIntegratedAberrationDiagram(longitudinalData, astigmatismData, distortionDataByWavelength, {
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
