/**
 * Optical Analysis Module
 * Handles PSF, spot diagram, and aberration analysis functions
 */

import * as THREE from 'three';
import { getOpticalSystemRows, getObjectRows, getSourceRows } from '../utils/data-utils.js';
import { expandBlocksToOpticalSystemRows } from '../block-schema.js';
import { getScene, getCamera, getRenderer, getControls, getTableOpticalSystem, getTableObject, getTableSource,
         getIsGeneratingSpotDiagram, getIsGeneratingTransverseAberration,
         setIsGeneratingSpotDiagram, setIsGeneratingTransverseAberration } from '../core/app-config.js';

/**
 * Create field setting from object data for PSF calculation
 * @param {Object} objectData - Object data from table
 * @returns {Object} Field setting object
 */
export function createFieldSettingFromObject(objectData) {
    if (!objectData) {
        console.error('❌ Object data is null or undefined');
        return null;
    }

    // Objectテーブルのキー揺れを吸収
    const objectTypeRaw = String(objectData.position ?? objectData.object ?? objectData.Object ?? objectData.objectType ?? 'Point');
    const objectType = objectTypeRaw.toLowerCase();
    const xVal = (objectData.x ?? objectData.xHeightAngle ?? objectData.x_height_angle ?? 0);
    const yVal = (objectData.y ?? objectData.yHeightAngle ?? objectData.y_height_angle ?? 0);

    const fieldSetting = {
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
export function clearAllDrawing() {
    const scene = getScene();
    if (!scene) return;
    
    console.log('🧹 Clearing all drawing elements...');
    
    // Create a list of objects to remove
    const objectsToRemove = [];
    
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
        if (obj.geometry) {
            obj.geometry.dispose();
        }
        if (obj.material) {
            if (Array.isArray(obj.material)) {
                obj.material.forEach(mat => mat.dispose());
            } else {
                obj.material.dispose();
            }
        }
    });
    
    console.log(`✅ Cleared ${objectsToRemove.length} objects from scene`);
}

/**
 * Show spot diagram
 */
export async function showSpotDiagram(options = {}) {
    console.log('🎯 Starting spot diagram generation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    // Default target container is the in-page one
    let containerTarget = 'spot-diagram-container';
    if (options && typeof options === 'object') {
        if (options.containerElement) {
            containerTarget = options.containerElement;
        } else if (typeof options.containerId === 'string' && options.containerId.trim() !== '') {
            containerTarget = options.containerId;
        }
    }
    
    // Check if already generating
    if (getIsGeneratingSpotDiagram()) {
        console.warn('⚠️ Spot diagram generation already in progress');
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
        const surfaceSelect = document.getElementById('surface-number-select');
        const configSelect = document.getElementById('spot-diagram-config-select');
        const rayCountInput = document.getElementById('ray-count-input');
        const wavelengthInput = document.getElementById('wavelength-input');
        const ringCountSelect = document.getElementById('ring-count-select');

        const providedConfigId = (options && typeof options === 'object' && options.configId !== undefined && options.configId !== null)
            ? String(options.configId).trim()
            : '';
        const selectedConfigId = providedConfigId || (configSelect && configSelect.value !== undefined && configSelect.value !== null ? String(configSelect.value).trim() : '');
        
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

        const surfaceId = surfaceIndex;
        console.log(`🎯 Generating spot diagram for surfaceId ${surfaceId}, ${rayCount} rays, ${wavelength}nm, ring count ${ringCount}`);
        
        // Get data either from active UI tables or from a selected configuration snapshot.
        const loadRowsForSelectedConfig = () => {
            if (!selectedConfigId) {
                const tableOpticalSystem = getTableOpticalSystem();
                const tableObject = getTableObject();
                const tableSource = getTableSource();
                return {
                    opticalSystemRows: getOpticalSystemRows(tableOpticalSystem),
                    objectRows: getObjectRows(tableObject),
                    sourceRows: getSourceRows(tableSource)
                };
            }

            const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
            const cloneJson = (v) => {
                try { return JSON.parse(JSON.stringify(v)); } catch { return null; }
            };
            const parseOverrideKey = (variableId) => {
                const s = String(variableId ?? '');
                const dot = s.indexOf('.');
                if (dot <= 0) return null;
                const blockId = s.slice(0, dot);
                const key = s.slice(dot + 1);
                if (!blockId || !key) return null;
                return { blockId, key };
            };
            const applyOverridesToBlocks = (blocks, overrides) => {
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
                const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('systemConfigurations') : null;
                const sys = raw ? JSON.parse(raw) : null;

                const activeId = (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                    ? String(sys.activeConfigId)
                    : '';

                // Always use the selected config snapshot (not active UI tables).
                // This keeps Spot Diagram independent of ActiveConfig selection.

                const cfg = Array.isArray(sys?.configurations)
                    ? sys.configurations.find(c => String(c?.id) === String(selectedConfigId))
                    : null;

                // Prefer cached optical rows for the selected config (avoids mixing after CB insertion).
                try {
                    if (cfg && typeof window !== 'undefined' && window.__cooptOpticalSystemByConfigId) {
                        const cached = window.__cooptOpticalSystemByConfigId[String(selectedConfigId)];
                        if (Array.isArray(cached) && cached.length > 0) {
                            return {
                                opticalSystemRows: cached,
                                objectRows: Array.isArray(cfg?.object) ? cfg.object : [],
                                sourceRows: (() => {
                                    try {
                                        const json = localStorage.getItem('sourceTableData');
                                        const parsed = json ? JSON.parse(json) : null;
                                        return Array.isArray(parsed) ? parsed : [];
                                    } catch (_) {
                                        return [];
                                    }
                                })()
                            };
                        }
                    }
                } catch (_) {}

                const expandedOptical = (() => {
                    try {
                        if (!cfg || !Array.isArray(cfg.blocks) || cfg.blocks.length === 0) return null;
                        const scenarios = Array.isArray(cfg.scenarios) ? cfg.scenarios : null;
                        const scenarioId = cfg.activeScenarioId ? String(cfg.activeScenarioId) : '';
                        const scn = (scenarioId && scenarios)
                            ? scenarios.find(s => s && String(s.id) === String(scenarioId))
                            : null;
                        const overrides = scn && isPlainObject(scn.overrides) ? scn.overrides : null;
                        const blocksToExpand = overrides ? applyOverridesToBlocks(cfg.blocks, overrides) : cfg.blocks;
                        const exp = expandBlocksToOpticalSystemRows(blocksToExpand);
                        if (!exp || !Array.isArray(exp.rows)) return null;
                        // Preserve semidia (aperture) from persisted opticalSystem when available.
                        // Blocks expansion uses schema defaults (e.g., DEFAULT_SEMIDIA / DEFAULT_STOP_SEMI_DIAMETER),
                        // which can vignette rays unexpectedly compared to the saved table.
                        try {
                            const legacyRows = Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem : null;
                            const rows = exp.rows;

                            const normType = (r) => String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
                            const findBlockById = (blockId) => {
                                if (!blockId) return null;
                                const bid = String(blockId);
                                return Array.isArray(blocksToExpand)
                                    ? blocksToExpand.find(b => b && String(b.blockId) === bid)
                                    : null;
                            };
                            const getExplicitStopSemiDiameter = (blockId) => {
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
                                    if (t === 'stop') {
                                        // If Stop block has an explicit semiDiameter (possibly via scenario override), keep it.
                                        const explicit = getExplicitStopSemiDiameter(row._blockId);
                                        if (explicit !== null) continue;
                                    }
                                    row.semidia = lsRaw;
                                }
                            }
                        } catch (_) {}
                        // Preserve Object thickness from persisted opticalSystem when possible.
                        try {
                            const rows = exp.rows;
                            const hasObjectPlane = Array.isArray(cfg?.blocks) && cfg.blocks.some(b => String(b?.blockType ?? '').trim() === 'ObjectPlane');
                            if (!hasObjectPlane) {
                                const preferredThickness = cfg?.opticalSystem?.[0]?.thickness;
                                if (rows.length > 0 && preferredThickness !== undefined && preferredThickness !== null && String(preferredThickness).trim() !== '') {
                                    rows[0] = { ...rows[0], thickness: preferredThickness };
                                }
                            }
                        } catch (_) {}
                        return exp.rows;
                    } catch (_) {
                        return null;
                    }
                })();

                return {
                    opticalSystemRows: Array.isArray(expandedOptical) ? expandedOptical : (Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem : []),
                    objectRows: Array.isArray(cfg?.object) ? cfg.object : [],
                    // Source is global (shared across configurations).
                    sourceRows: (() => {
                        try {
                            const json = localStorage.getItem('sourceTableData');
                            const parsed = json ? JSON.parse(json) : null;
                            return Array.isArray(parsed) ? parsed : [];
                        } catch (_) {
                            return [];
                        }
                    })()
                };
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

        // Resolve CB-invariant surfaceId -> actual rowIndex in opticalSystemRows.
        let resolvedSurfaceRowIndex = null;
        try {
            const { generateSurfaceOptions } = await import('../eva-spot-diagram.js');
            const opts = generateSurfaceOptions(opticalSystemRows || []);
            const match = opts.find(o => Number(o?.value) === Number(surfaceId));
            if (match && Number.isInteger(match.rowIndex)) {
                resolvedSurfaceRowIndex = match.rowIndex;
            } else if (opts.length > 0) {
                const img = opts.find(o => typeof o?.label === 'string' && o.label.includes('(Image)'));
                resolvedSurfaceRowIndex = Number.isInteger(img?.rowIndex) ? img.rowIndex : opts[opts.length - 1].rowIndex;
            }
        } catch (e) {
            // As a last resort, keep the original number as an index.
            resolvedSurfaceRowIndex = Number.isInteger(surfaceId) ? surfaceId : 0;
        }
        if (!Number.isInteger(resolvedSurfaceRowIndex) || resolvedSurfaceRowIndex < 0) {
            resolvedSurfaceRowIndex = 0;
        }
        surfaceIndex = resolvedSurfaceRowIndex;

        // Persist the current spot-diagram settings for other modules (e.g., Requirements spot size operands).
        // This also bridges main window vs popup window differences by using shared localStorage.
        try {
            const pattern = (typeof window !== 'undefined' && typeof window.getRayEmissionPattern === 'function')
                ? String(window.getRayEmissionPattern() || '').trim().toLowerCase()
                : String(window.rayEmissionPattern || '').trim().toLowerCase();

            let primaryWavelengthUm = 0.5876;
            if (Array.isArray(sourceRows) && sourceRows.length > 0) {
                const parsed = sourceRows
                    .map((row, idx) => ({
                        idx,
                        wl: Number(row?.wavelength),
                        isPrimary: row?.primary === 'Primary Wavelength'
                    }))
                    .filter(e => Number.isFinite(e.wl) && e.wl > 0);
                const primary = parsed.find(e => e.isPrimary) || parsed[0] || null;
                if (primary) primaryWavelengthUm = primary.wl;
            }

            localStorage.setItem('lastSpotDiagramSettings', JSON.stringify({
                surfaceId,
                surfaceRowIndex: surfaceIndex,
                rayCount,
                ringCount,
                pattern: pattern || null,
                primaryWavelengthUm,
                configId: selectedConfigId || null,
                updatedAt: Date.now()
            }));

            // Also persist per-config settings so Requirements can evaluate
            // non-active configs without depending on whichever config was last opened.
            try {
                let cfgKey = selectedConfigId ? String(selectedConfigId).trim() : '';
                if (!cfgKey) {
                    const sysRaw = (typeof localStorage !== 'undefined') ? localStorage.getItem('systemConfigurations') : null;
                    const sys = sysRaw ? JSON.parse(sysRaw) : null;
                    cfgKey = (sys && sys.activeConfigId !== undefined && sys.activeConfigId !== null)
                        ? String(sys.activeConfigId).trim()
                        : '';
                }

                if (cfgKey) {
                    const rawMap = (typeof localStorage !== 'undefined') ? localStorage.getItem('spotDiagramSettingsByConfigId') : null;
                    const map = rawMap ? (JSON.parse(rawMap) || {}) : {};
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
                    localStorage.setItem('spotDiagramSettingsByConfigId', JSON.stringify(map));
                    
                    // CRITICAL: Also update in-memory cache so merit evaluation uses latest settings immediately.
                    // This prevents Spot Diagram execution from requiring browser reload to update UR values.
                    if (typeof window !== 'undefined') {
                        if (!window.__cooptSpotDiagramSettingsByConfigId || typeof window.__cooptSpotDiagramSettingsByConfigId !== 'object') {
                            window.__cooptSpotDiagramSettingsByConfigId = {};
                        }
                        window.__cooptSpotDiagramSettingsByConfigId[cfgKey] = map[cfgKey];
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
            opticalSystemRows.forEach((row, idx) => {
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
        console.log(`🎯 Final surface index: ${surfaceIndex} (0-indexed), converting to surface number: ${surfaceNumber}`);
        
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
            const { generateSpotDiagramAsync, drawSpotDiagram } = await import('../eva-spot-diagram.js');
            
            const spotDiagramData = await generateSpotDiagramAsync(
                opticalSystemRows,
                sourceRows || [],
                defaultObjectRows,
                surfaceNumber,
                rayCount,
                ringCount,
                { onProgress, physicalVignetting: true }
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
                wavelength / 1000 // convert nm to μm
            );
            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
            
        } else {
            // Generate spot diagram with existing object data
            const { generateSpotDiagramAsync, drawSpotDiagram } = await import('../eva-spot-diagram.js');
            
            const spotDiagramData = await generateSpotDiagramAsync(
                opticalSystemRows,
                sourceRows || [],
                objectRows,
                surfaceNumber,
                rayCount,
                ringCount,
                { onProgress, physicalVignetting: true }
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
                wavelength / 1000 // convert nm to μm
            );

            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
            
            console.log('✅ [SPOT DIAGRAM] drawSpotDiagram call completed');
        }
        
        console.log('✅ Spot diagram generated successfully');
        
    } catch (error) {
        console.error('❌ Error generating spot diagram:', error);
        console.error('Error details:', error.stack);
        const container = typeof containerTarget === 'string'
            ? document.getElementById(containerTarget)
            : containerTarget;
        if (container) {
            container.innerHTML = `<div style="padding: 20px; color: red; font-family: Arial;">
                <strong>Spot diagram error:</strong><br>
                ${error.message}<br>
                <small style="color: #888;">Check console for details</small>
            </div>`;
        }
        alert(`Spot diagram error:\n${error.message}`);
    } finally {
        setIsGeneratingSpotDiagram(false);
    }
}

/**
 * Show transverse aberration diagram
 */
export async function showTransverseAberrationDiagram(options = {}) {
    console.log('📊 Starting transverse aberration calculation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    // Default target container is the in-page one
    let containerTarget = 'transverse-aberration-container';
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

        const transverseRayCountInput = document.getElementById('transverse-ray-count-input');
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

        const opticalSystemRows = getOpticalSystemRows();
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            throw new Error('光学系データが見つかりません');
        }

        const isCoordBreakRow = (row) => {
            const stRaw = String(row?.surfType ?? row?.['surf type'] ?? row?.surface_type ?? '').toLowerCase();
            const st = stRaw.trim();
            return st === 'coord break' || st === 'coordinate break' || st === 'coordbreak' || st === 'coordinatebreak' || st === 'cb';
        };
        const isObjectRow = (row) => {
            const t = String(row?.['object type'] ?? row?.object ?? row?.Object ?? row?.surface_type ?? '').toLowerCase();
            return t === 'object';
        };
        const isImageRow = (row) => {
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
                if (isCoordBreakRow(row) || isObjectRow(row)) continue;
                targetSurfaceIndex = i;
                break;
            }
        }
        if (targetSurfaceIndex < 0) {
            targetSurfaceIndex = opticalSystemRows.length - 1;
        }
        console.log(`📊 評価面: Surface ${targetSurfaceIndex + 1}`);
        console.log(`📊 光線本数: ${rayCount}本`);

        const { getPrimaryWavelengthForAberration, calculateTransverseAberrationAsync } = await import('../eva-transverse-aberration.js');
        const { plotTransverseAberrationDiagram } = await import('../eva-transverse-aberration-plot.js');

        const wavelength = getPrimaryWavelengthForAberration(); // μm
        console.log(`📊 Wavelength: ${wavelength} μm`);

        const aberrationData = await calculateTransverseAberrationAsync(
            opticalSystemRows,
            targetSurfaceIndex,
            null,
            wavelength,
            rayCount,
            { onProgress }
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
                ${error.message}<br>
                <small style="color: #888;">Check console for details</small>
            </div>`;
        }
        alert(`Transverse aberration error: ${error.message}`);
    } finally {
        setIsGeneratingTransverseAberration(false);
    }
}

export async function showAstigmatismDiagram(options = {}) {
    console.log('📊 Starting astigmatism calculation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    // Default target container is the in-page one
    let containerTarget = 'astigmatic-field-curves-container';
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

        const opticalSystemRows = getOpticalSystemRows();
        const sourceRows = getSourceRows();
        const objectRows = getObjectRows();

        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            throw new Error('光学系データが見つかりません');
        }

        // Get ray count from (optional) input field or provided options
        const rayCountInput = document.getElementById('astigmatism-ray-count-input');
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
        const rayFilterSelect = document.getElementById('astigmatism-ray-filter');
        const rayFilter = rayFilterSelect ? rayFilterSelect.value : 'all';

        // Get field mode setting (optional)
        const fieldModeSelect = document.getElementById('astigmatism-field-mode');
        const fieldMode = fieldModeSelect ? fieldModeSelect.value : 'object';

        console.log(`📊 光線本数: ${rayCount}本`);
        console.log(`📊 光線フィルタ: ${rayFilter}`);
        console.log(`📊 画角モード: ${fieldMode}`);

        // 補間モードの場合、0°から最大値まで10等分した画角を生成
        // ただし Rectangle/height 指定が1件でもあれば高さモードとみなし、補間は行わずそのまま使う
        let processedObjectRows = objectRows;
        const hasHeightRect = (objectRows || []).some(obj => {
            const pos = (obj.position || obj.fieldType || obj.type || '').toLowerCase();
            return pos.includes('height') || pos.includes('rect');
        });

        if (fieldMode === 'interpolate' && (objectRows || []).length > 0 && !hasHeightRect) {
            // Y方向の最大角度を取得
            const maxYAngle = Math.max(...objectRows.map(obj => Math.abs(parseFloat(obj.yHeightAngle || 0))));

            console.log(`📊 最大Y角度: ${maxYAngle}°`);

            // 0°から最大値まで10等分（11点: 0%, 10%, 20%, ..., 100%）
            processedObjectRows = [];
            for (let i = 0; i <= 10; i++) {
                const angle = (maxYAngle * i) / 10;
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

        const { calculateAstigmatismData } = await import('../eva-astigmatism.js');
        const { plotAstigmaticFieldCurves } = await import('../eva-astigmatism-plot.js');

        console.log('🎯 非点収差曲線データ生成中（RMS最小値探索）...');
        const fieldCurvesData = await calculateAstigmatismData(
            opticalSystemRows,
            sourceRows || [],
            processedObjectRows || [],
            targetSurfaceIndex,
            {
                spotDiagramMode: false,
                rayCount: rayCount,
                interpolationPoints: 10,
                verbose: true,
                onProgress
            }
        );

        if (!fieldCurvesData || !fieldCurvesData.data || fieldCurvesData.data.length === 0) {
            console.warn('⚠️ 非点収差曲線データの生成に失敗しました');
        } else {
            try { onProgress?.({ percent: 95, message: 'Rendering...' }); } catch (_) {}
            plotAstigmaticFieldCurves(containerTarget, fieldCurvesData);
            try { onProgress?.({ percent: 100, message: 'Done' }); } catch (_) {}
        }

        console.log('✅ Astigmatism diagram generated successfully');
    } catch (error) {
        console.error('❌ Astigmatism diagram error:', error);
        alert(`Astigmatism diagram error: ${error.message}`);
    } finally {
        setIsGeneratingTransverseAberration(false);
    }
}

/**
 * Show spherical aberration diagram (球面収差図)
 * Displays longitudinal aberration as a function of pupil coordinate
 */
export async function showLongitudinalAberrationDiagram(options = {}) {
    console.log('📊 Starting spherical aberration calculation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    // Default target container is the in-page one
    let containerTarget = 'longitudinal-aberration-container';
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
        const rayCountInput = document.getElementById('longitudinal-ray-count-input');
        
        // Use defaults if form elements not found
        let surfaceIndex = 0;  // Default to image surface
        let rayCount = 51;     // Default ray count for spherical aberration
        
        // Get wavelengths from Source table for spherical aberration diagram.
        // Normalize nm→μm (e.g. 587.6nm → 0.5876μm) and drop invalid/≤0 entries.
        const sourceRows = getSourceRows();
        const wavelengths = (() => {
            const normalizeUm = (raw) => {
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0) return null;
                if (n > 10) return n / 1000;
                return n;
            };

            const rows = Array.isArray(sourceRows) ? sourceRows : [];
            const unique = [];
            for (const row of rows) {
                const wl = normalizeUm(row?.wavelength ?? row?.Wavelength);
                if (!Number.isFinite(wl) || wl <= 0) continue;
                if (!unique.some(w => Math.abs(w - wl) < 1e-12)) unique.push(wl);
                if (unique.length >= 6) break;
            }
            return unique.length > 0 ? unique : [0.5876];
        })();

        console.log(`📊 Wavelengths from Source table: ${wavelengths.map(w => w.toFixed(4)).join(', ')} μm`);
        
        // For longitudinal aberration, always use the last surface (image surface) as default
        const opticalSystemData = getOpticalSystemRows();
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
        const tableOpticalSystem = getTableOpticalSystem();
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
        const { calculateLongitudinalAberrationAsync } = await import('../eva-longitudinal-aberration.js');
        const { plotLongitudinalAberrationDiagram } = await import('../eva-longitudinal-aberration-plot.js');
        
        const aberrationData = await calculateLongitudinalAberrationAsync(
            opticalSystemRows,
            surfaceIndex,
            wavelengths, // Array of wavelengths from Source table
            rayCount,
            { onProgress, debugSA: Boolean(globalThis.__COOPT_DEBUG_SA) }
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
                ${error.message}<br>
                <small style="color: #888;">Check console for details</small>
            </div>`;
        }
        alert(`Error generating longitudinal aberration diagram: ${error.message}`);
    } finally {
        setIsGeneratingTransverseAberration(false);
    }
}

/**
 * Output chief ray convergence data to debug
 * @param {Object} aberrationData - Aberration calculation data
 */
export function outputChiefRayConvergenceData(aberrationData) {
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
            console.log(`  ${key}: ${value.toFixed(6)}`);
        });
    }
    
    console.log('================================');
}

/**
 * Calculate scene bounds for camera fitting
 * @returns {Object} Scene bounds object
 */
export function calculateSceneBounds() {
    const scene = getScene();
    if (!scene) return null;
    
    const bounds = {
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
        if (child.visible && (child.isMesh || child.isLine || child.isGroup)) {
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
export function fitCameraToScene() {
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
    camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    controls.target.set(bounds.centerX, bounds.centerY, bounds.centerZ);
    
    // Update orthographic camera view size if needed
    if (camera.isOrthographicCamera) {
        const aspect = camera.right / camera.top;
        const frustumSize = bounds.maxSize * 0.6;
        
        camera.left = -frustumSize * aspect / 2;
        camera.right = frustumSize * aspect / 2;
        camera.top = frustumSize / 2;
        camera.bottom = -frustumSize / 2;
        camera.updateProjectionMatrix();
    }
    
    // Update controls
    controls.update();
    
    // Render the scene
    renderer.render(getScene(), camera);
    
    console.log(`🎥 Camera fitted to scene, distance: ${distance.toFixed(2)}`);
    console.log(`🎥 Camera position: (${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)})`);
}

/**
 * Create test PSF data for performance testing
 * @param {number} size - Grid size
 * @returns {Object} Test PSF data
 */
export function createTestPSFData(size = 256) {
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
export async function runPlotPerformanceTest() {
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
        alert(`Performance test failed: ${error.message}`);
    }
}

/**
 * Show integrated aberration diagram (球面収差、非点収差、歪曲収差を統合)
 */
export async function showIntegratedAberrationDiagram(options = {}) {
    console.log('📊 Starting integrated aberration diagram calculation...');

    const onProgress = (options && typeof options === 'object' && typeof options.onProgress === 'function')
        ? options.onProgress
        : null;

    const mapProgress = (base, span, prefix) => {
        if (!onProgress) return null;
        return (evt) => {
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
        const opticalSystemRows = getOpticalSystemRows();
        const objectRows = getObjectRows();
        const sourceRows = getSourceRows();
        
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
            const normalizeUm = (raw) => {
                const n = Number(raw);
                if (!Number.isFinite(n) || n <= 0) return null;
                // Heuristic: values like 587.6 are nm; convert to μm.
                if (n > 10) return n / 1000;
                return n;
            };

            // Legend/calc order should match Source table order.
            const rows = Array.isArray(sourceRows) ? sourceRows : [];
            const unique = [];
            for (const row of rows) {
                const wl = normalizeUm(row?.wavelength);
                if (!Number.isFinite(wl) || wl <= 0) continue;
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
        const { calculateLongitudinalAberrationAsync } = await import('../eva-longitudinal-aberration.js');
        
        const longitudinalData = await calculateLongitudinalAberrationAsync(
            opticalSystemRows,
            surfaceIndex,
            wavelengths,
            rayCountSpherical,
            { onProgress: mapProgress(5, 30, 'Spherical') }
        );
        
        if (!longitudinalData) {
            throw new Error('Failed to calculate longitudinal aberration');
        }
        
        // 2. 非点収差データを計算
        console.log('📊 Calculating astigmatism...');
        const { calculateAstigmatismData } = await import('../eva-astigmatism.js');
        
        const astigmatismData = await calculateAstigmatismData(
            opticalSystemRows,
            sourceRows,
            objectRows,
            surfaceIndex,
            { rayCount: rayCountAstigmatism, interpolationPoints: 10, onProgress: mapProgress(35, 35, 'Astigmatism') }
        );
        
        if (!astigmatismData) {
            throw new Error('Failed to calculate astigmatism');
        }
        
        // 3. 歪曲収差データを計算
        console.log('📊 Calculating distortion...');
        const { calculateDistortionData } = await import('../eva-distortion.js');
        const { deriveMaxFieldAngleFromObjects } = await import('../eva-distortion-plot.js');
        
        // Decide field sweep (object angles vs object heights) based on Object table setting
        const inferObjectFieldMode = (objects) => {
            const rows = Array.isArray(objects) ? objects : [];
            const pickTag = (o) => {
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
            const heightCandidates = (rows || []).map(o => parseFloat(o?.yHeight ?? o?.y ?? o?.yHeightAngle ?? NaN)).filter(v => Number.isFinite(v));
            const angleCandidates = (rows || []).map(o => parseFloat(o?.fieldAngle ?? o?.yFieldAngle ?? o?.yAngle ?? NaN)).filter(v => Number.isFinite(v));
            if (heightCandidates.length > 0 && angleCandidates.length === 0) return { mode: 'height' };
            return { mode: 'angle' };
        };
        const fieldMode = inferObjectFieldMode(objectRows);
        const heightMode = fieldMode.mode === 'height';

        const heightCandidates = (objectRows || []).map(o => parseFloat(o.yHeight ?? o.y ?? o.yHeightAngle ?? NaN)).filter(v => Number.isFinite(v));

        const numPoints = 10;
        let fieldValues = [];
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
        const { plotIntegratedAberrationDiagram } = await import('../eva-integrated-aberration-plot.js');

        try { onProgress?.({ percent: 96, message: 'Rendering...' }); } catch (_) {}
        
        // System Configuration名を取得
        const systemConfig = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
        const activeConfig = systemConfig.configurations?.find(c => c.id === systemConfig.activeConfigId);
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
        alert(`Error generating integrated aberration diagram: ${error.message}`);
    }
}
