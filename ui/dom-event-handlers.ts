// ui/dom-event-handlers.ts
// DOM event handlers orchestration: comprehensive UI management for the entire application

// Import statements (all .ts → .js for ESM runtime)
import { getGlassDataWithSellmeier, findSimilarGlassNames, findSimilarGlassesByNdVd } from '../data/glass.js';
import { openGlassMapWindow } from '../data/glass-map.js';
import {
    expandBlocksToOpticalSystemRows,
    deriveBlocksFromLegacyOpticalSystemRows,
    validateBlocksConfiguration,
    BLOCK_SCHEMA_VERSION
} from '../compat/block-schema.js';
import { SetBlockParameterCommand } from '../core/undo-history.js';
import { 
    getCompressedStringFromLocation, 
    decodeAllDataFromCompressedString,
    encodeAllDataToCompressedString,
    buildShareUrlFromCompressedString
} from '../utils/url-share.js';
import { setupOpticalSystemChangeListeners } from './event-handlers.js';
import { listDesignVariablesFromBlocks } from '../optimization/design-variables.js';

// Type definitions
type BlockType = string;
type FieldValue = string | number | boolean | null | undefined;
type ChangeRecord = {
    blockId: string;
    blockType: BlockType;
    variable?: string;
    kind?: string;
    role?: string;
    oldValue: FieldValue;
    newValue: FieldValue;
};

// Default stop semiDiameter constant
const DEFAULT_STOP_SEMI_DIAMETER = 10;

// ============================================================================
// PARAMETER SLIDER HELPER FUNCTIONS
// ============================================================================

/**
 * Get display precision for parameter values
 */
function getDisplayPrecision(value: number, rangeSpan: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(rangeSpan)) return 6;
    
    const absVal = Math.abs(value);
    if (absVal === 0) return 4;
    
    // For very small values, use more precision
    if (absVal < 1e-6) return 15;
    if (absVal < 1e-3) return 10;
    if (absVal < 1) return 6;
    
    // For larger values, adjust based on range
    if (rangeSpan < 1) return 6;
    if (rangeSpan < 10) return 4;
    if (rangeSpan < 100) return 3;
    return 2;
}

/**
 * Convert slider value (0-1) to parameter value using linear or logarithmic scale
 */
function sliderToValue(sliderValue: number, min: number, max: number, useLog: boolean): number {
    if (!useLog) {
        // Linear scale
        return min + sliderValue * (max - min);
    }
    
    // Logarithmic scale
    // Handle case where range crosses zero
    if (min < 0 && max > 0) {
        // Split at zero: 0-0.5 maps to [min, 0], 0.5-1 maps to [0, max]
        if (sliderValue < 0.5) {
            // Negative side: use log scale from min to 0
            const absMin = Math.abs(min);
            const t = sliderValue * 2; // 0-0.5 -> 0-1
            if (absMin < 1e-10) return -1e-10 * (1 - t);
            const logVal = Math.exp(Math.log(absMin) * (1 - t) + Math.log(1e-10) * t);
            return -logVal;
        } else {
            // Positive side: use log scale from 0 to max
            const t = (sliderValue - 0.5) * 2; // 0.5-1 -> 0-1
            if (max < 1e-10) return 1e-10 * t;
            const logVal = Math.exp(Math.log(1e-10) * (1 - t) + Math.log(max) * t);
            return logVal;
        }
    }
    
    // Both positive or both negative
    const absMin = Math.abs(min);
    const absMax = Math.abs(max);
    const minLog = Math.log(Math.max(absMin, 1e-10));
    const maxLog = Math.log(Math.max(absMax, 1e-10));
    const logVal = Math.exp(minLog + sliderValue * (maxLog - minLog));
    
    // Preserve sign
    if (min < 0 && max < 0) return -logVal;
    return logVal;
}

/**
 * Convert parameter value to slider value (0-1)
 */
function valueToSlider(value: number, min: number, max: number, useLog: boolean): number {
    if (!useLog) {
        // Linear scale
        if (max === min) return 0.5;
        return (value - min) / (max - min);
    }
    
    // Logarithmic scale
    if (min < 0 && max > 0) {
        // Split at zero
        if (value < 0) {
            const absMin = Math.abs(min);
            const absVal = Math.abs(value);
            if (absMin < 1e-10 || absVal < 1e-10) return 0.25;
            const t = (Math.log(absVal) - Math.log(1e-10)) / (Math.log(absMin) - Math.log(1e-10));
            return (1 - t) * 0.5;
        } else {
            if (max < 1e-10 || value < 1e-10) return 0.75;
            const t = (Math.log(value) - Math.log(1e-10)) / (Math.log(max) - Math.log(1e-10));
            return 0.5 + t * 0.5;
        }
    }
    
    // Both positive or both negative
    const absMin = Math.abs(min);
    const absMax = Math.abs(max);
    const absVal = Math.abs(value);
    if (absMin < 1e-10 || absMax < 1e-10 || absVal < 1e-10) return 0.5;
    const minLog = Math.log(absMin);
    const maxLog = Math.log(absMax);
    const valLog = Math.log(absVal);
    if (maxLog === minLog) return 0.5;
    return (valLog - minLog) / (maxLog - minLog);
}

/**
 * Get slider range configuration for a parameter
 */
function getSliderRangeForParameter(key: string, blockType: string, currentValue: any): { min: number; max: number; step: number; useLog: boolean } {
    const val = parseFloat(String(currentValue));
    const isZeroOrNaN = !Number.isFinite(val) || val === 0;
    
    // Refractive index (nd)
    if (key === 'nd' || (key === 'material' && !isNaN(val) && val > 0 && val < 4)) {
        return { min: 1.0, max: 2.5, step: 0.0001, useLog: false };
    }
    
    // Abbe number (vd)
    if (key === 'vd' || key === 'abbe') {
        return { min: 20, max: 95, step: 0.1, useLog: false };
    }
    
    // Radius parameters (can be negative)
    if (key.includes('Radius') || key === 'radius') {
        if (isZeroOrNaN) {
            return { min: -100, max: 100, step: 0.1, useLog: false };
        }
        const absVal = Math.abs(val);
        const range = absVal * 0.5;
        return {
            min: val - range,
            max: val + range,
            step: absVal * 0.001,
            useLog: false
        };
    }
    
    // Thickness parameters (non-negative)
    if (key.includes('Thickness') || key === 'thickness' || key.includes('hickness')) {
        if (isZeroOrNaN) {
            return { min: 0, max: 20, step: 0.1, useLog: false };
        }
        return {
            min: 0,
            max: val * 2,
            step: val * 0.001,
            useLog: false
        };
    }
    
    // Semi-diameter / aperture parameters (non-negative)
    if (key.includes('semidia') || key.includes('Semidia') || key.includes('aperture')) {
        if (isZeroOrNaN) {
            return { min: 0.1, max: 20, step: 0.1, useLog: false };
        }
        return {
            min: Math.max(0.1, val * 0.5),
            max: val * 1.5,
            step: val * 0.001,
            useLog: false
        };
    }
    
    // Conic constant
    if (key === 'conic') {
        if (isZeroOrNaN) {
            return { min: -10, max: 10, step: 0.01, useLog: false };
        }
        const absVal = Math.abs(val);
        const range = Math.max(absVal * 0.5, 1);
        return {
            min: val - range,
            max: val + range,
            step: absVal > 1 ? absVal * 0.001 : 0.001,
            useLog: false
        };
    }
    
    // Aspheric coefficients (can be very small)
    if (key.startsWith('coef') || key.includes('Coef')) {
        if (isZeroOrNaN) {
            return { min: -10, max: 10, step: 0.001, useLog: false };
        }
        const absVal = Math.abs(val);
        const range = Math.max(absVal * 0.5, absVal * 10);
        return {
            min: val - range,
            max: val + range,
            step: absVal * 0.01,
            useLog: false
        };
    }
    
    // Default range
    if (isZeroOrNaN) {
        return { min: -10, max: 10, step: 0.01, useLog: false };
    }
    
    const absVal = Math.abs(val);
    const range = Math.max(absVal * 0.5, absVal);
    return {
        min: val - range,
        max: val + range,
        step: absVal * 0.01,
        useLog: false
    };
}

// ============================================================================
// END OF PARAMETER SLIDER HELPERS
// ============================================================================


// Global coordinate transformation calculation function
(window as any).__performCoordTransCalculation = async (blockId: string, panel: HTMLElement): Promise<void> => {
    try {
        const systemConfig = (typeof (window as any).loadSystemConfigurations === 'function') 
            ? (window as any).loadSystemConfigurations() 
            : null;
        const activeId = systemConfig?.activeConfigId;
        const activeCfg = Array.isArray(systemConfig?.configurations)
            ? systemConfig.configurations.find((c: any) => c && c.id === activeId)
            : null;
        const blocks = Array.isArray(activeCfg?.blocks) ? activeCfg.blocks : null;
        if (!blocks || blocks.length === 0) {
            console.warn('⚠️ No blocks found for coordinate transformation calculation');
            return;
        }

        const targetBlock = blocks.find((b: any) => b && String(b.blockId ?? '') === String(blockId));
        if (!targetBlock) {
            console.warn(`⚠️ CoordTrans block not found: ${blockId}`);
            return;
        }

        const coordReturn = String(targetBlock.parameters?.coordReturn ?? '').trim();
        if (coordReturn === 'none' || !coordReturn) {
            console.log(`⚠️ CoordReturn is none or empty. No calculation needed.`);
            return;
        }

        const toSurfRaw = targetBlock.parameters?.toSurf;
        if (toSurfRaw === undefined || toSurfRaw === null || String(toSurfRaw).trim() === '') {
            console.log(`⚠️ toSurf not set. Cannot auto-calculate coordinate transformation.`);
            return;
        }

        const toSurf = Number(toSurfRaw);
        if (!Number.isFinite(toSurf)) {
            console.warn(`⚠️ toSurf is not a valid number: ${toSurfRaw}`);
            return;
        }

        console.log(`🔵 [CoordTrans] Auto-calculating: blockId=${blockId}, coordReturn=${coordReturn}, toSurf=${toSurf}`);

        const expanded = expandBlocksToOpticalSystemRows(blocks);
        const rows = expanded && Array.isArray(expanded.rows) ? expanded.rows : [];

        const sourceRows = ((window as any).tableSource && typeof (window as any).tableSource.getData === 'function') 
            ? (window as any).tableSource.getData() 
            : [];
        const objectRows = ((window as any).tableObject && typeof (window as any).tableObject.getData === 'function') 
            ? (window as any).tableObject.getData() 
            : [];

        const primaryWavelength = (typeof (window as any).getPrimaryWavelength === 'function')
            ? (Number((window as any).getPrimaryWavelength()) || 0.5876)
            : 0.5876;

        const objRow0 = Array.isArray(objectRows) && objectRows.length > 0 ? objectRows[0] : {};
        const isInfinite = (() => {
            const t0 = rows[0]?.thickness;
            if (t0 === Infinity) return true;
            const s = String(t0 ?? '').trim();
            return /^inf(inity)?$/i.test(s);
        })();

        let fieldSettingCenter: any;
        try {
            if (typeof (window as any).createFieldSettingFromObject === 'function') {
                fieldSettingCenter = (window as any).createFieldSettingFromObject(objRow0, 0, isInfinite);
            }
        } catch (_) {}
        if (!fieldSettingCenter) {
            fieldSettingCenter = isInfinite
                ? { type: 'infinite', fieldAngle: { x: 0, y: 0 }, displayName: 'center' }
                : { type: 'finite', xHeight: 0, yHeight: 0, displayName: 'center' };
        }

        let rays: any[] = [];
        if (isInfinite && typeof (window as any).generateInfiniteSystemCrossBeam === 'function') {
            const result = await (window as any).generateInfiniteSystemCrossBeam(rows, [{ x: 0, y: 0 }], {
                rayCount: 21,
                debugMode: false,
                wavelength: primaryWavelength,
                crossType: 'both',
                angleUnit: 'deg',
                chiefZ: -20,
                targetSurfaceIndex: toSurf
            });
            if (result?.rays) rays = result.rays;
        } else if (!isInfinite && typeof (window as any).generateCrossBeam === 'function') {
            const result = await (window as any).generateCrossBeam(rows, [{ x: 0, y: 0, z: 0 }], {
                rayCount: 21,
                debugMode: false,
                wavelength: primaryWavelength,
                crossType: 'both'
            });
            if (result?.rays) rays = result.rays;
        }

        if (rays.length === 0) {
            console.warn(`⚠️ No rays traced for coordinate transformation`);
            return;
        }

        const chiefRay = rays.find((r: any) => r && r.rayType === 'chief') || rays[0];
        if (!chiefRay || !Array.isArray(chiefRay.rayPath)) {
            console.warn(`⚠️ Chief ray not found or has no rayPath`);
            return;
        }

        const ctPos = chiefRay.rayPath.find((p: any, idx: number) => {
            const r = rows[idx];
            return r && String(r._blockId ?? '') === String(blockId);
        });

        const targetPos = chiefRay.rayPath[toSurf];
        if (!ctPos || !targetPos) {
            console.warn(`⚠️ Ray positions not found (ctPos or targetPos missing)`);
            return;
        }

        const dx = Number.isFinite(targetPos.x) && Number.isFinite(ctPos.x) ? targetPos.x - ctPos.x : 0;
        const dy = Number.isFinite(targetPos.y) && Number.isFinite(ctPos.y) ? targetPos.y - ctPos.y : 0;
        const dz = Number.isFinite(targetPos.z) && Number.isFinite(ctPos.z) ? targetPos.z - ctPos.z : 0;

        if (coordReturn === 'xy' || coordReturn === 'xyz') {
            if ((window as any).__blocks_setBlockParamValue) {
                (window as any).__blocks_setBlockParamValue(blockId, 'decenterX', dx);
                (window as any).__blocks_setBlockParamValue(blockId, 'decenterY', dy);
            }
        }
        if (coordReturn === 'xyz') {
            if ((window as any).__blocks_setBlockParamValue) {
                (window as any).__blocks_setBlockParamValue(blockId, 'decenterZ', dz);
            }
        }

        console.log(`✅ [CoordTrans] Applied: dx=${dx.toFixed(6)}, dy=${dy.toFixed(6)}, dz=${dz.toFixed(6)}`);

        try {
            (window as any).refreshBlockInspector?.();
        } catch (_) {}
    } catch (err) {
        console.error('❌ Failed to perform coordinate transformation calculation:', err);
    }
};

// Zemax import/export utilities
function __zmxPickPrimaryWavelengthMicrons(wavelengthsFromWAVE: number[]): number {
    if (!Array.isArray(wavelengthsFromWAVE) || wavelengthsFromWAVE.length === 0) return 0.5876;
    return wavelengthsFromWAVE[0];
}

function __zmxGetStopRadiusMmFromRows(rows: any[]): number | null {
    for (const r of rows) {
        const ot = String(r?.['object type'] ?? r?.object ?? '').toLowerCase();
        if (ot === 'stop') {
            const sd = r?.semidia ?? r?.['semidia(mm)'] ?? r?.semidiameter;
            const n = Number(sd);
            return Number.isFinite(n) && n > 0 ? n : null;
        }
    }
    return null;
}

function __zmxIsInfiniteConjugateFromObjectRow(objectRow: any): boolean {
    const t = objectRow?.thickness;
    if (t === Infinity) return true;
    const s = String(t ?? '').trim();
    return /^inf(inity)?$/i.test(s);
}

function __zmxSolveCrossRayToStopCoordAxis(
    rows: any[],
    stopIndex: number,
    primaryWavelength: number,
    targetAxis: 'x' | 'y',
    isInfinite: boolean
): number | null {
    try {
        const objectRow = rows[0];
        const t0 = objectRow?.thickness;
        const objDist = (t0 === Infinity || /^inf(inity)?$/i.test(String(t0 ?? '').trim())) ? -1000 : Number(t0);
        
        const stopRad = __zmxGetStopRadiusMmFromRows(rows);
        if (!stopRad || stopRad <= 0) return null;

        let lo = 0;
        let hi = stopRad * 2;
        const maxIter = 30;
        const tol = 1e-6;

        for (let iter = 0; iter < maxIter; iter++) {
            const mid = (lo + hi) / 2;
            const rays = isInfinite
                ? (typeof (window as any).generateInfiniteSystemCrossBeam === 'function'
                    ? (window as any).generateInfiniteSystemCrossBeam(rows, [{ x: 0, y: 0 }], {
                        rayCount: 1,
                        wavelength: primaryWavelength,
                        debugMode: false
                    })
                    : null)
                : (typeof (window as any).generateCrossBeam === 'function'
                    ? (window as any).generateCrossBeam(rows, [{ x: targetAxis === 'x' ? mid : 0, y: targetAxis === 'y' ? mid : 0, z: 0 }], {
                        rayCount: 1,
                        wavelength: primaryWavelength,
                        debugMode: false
                    })
                    : null);

            if (!rays || !Array.isArray(rays.rays) || rays.rays.length === 0) return null;
            const ray = rays.rays[0];
            if (!Array.isArray(ray?.rayPath)) return null;
            const stopPos = ray.rayPath[stopIndex];
            if (!stopPos) return null;

            const coord = targetAxis === 'x' ? stopPos.x : stopPos.y;
            if (!Number.isFinite(coord)) return null;

            if (Math.abs(coord) < tol) return mid;
            if (coord > 0) hi = mid;
            else lo = mid;
        }

        return (lo + hi) / 2;
    } catch (_) {
        return null;
    }
}

function __zmxApplySemidiaOverridesFromMarginalRays(rows: any[], wavelengthMicrons: number): void {
    const stopIndex = rows.findIndex((r: any) => {
        const ot = String(r?.['object type'] ?? r?.object ?? '').toLowerCase();
        return ot === 'stop';
    });
    if (stopIndex < 0) return;

    const objectRow = rows[0];
    const isInfinite = __zmxIsInfiniteConjugateFromObjectRow(objectRow);

    const crossX = __zmxSolveCrossRayToStopCoordAxis(rows, stopIndex, wavelengthMicrons, 'x', isInfinite);
    const crossY = __zmxSolveCrossRayToStopCoordAxis(rows, stopIndex, wavelengthMicrons, 'y', isInfinite);

    if (!Number.isFinite(crossX) || !Number.isFinite(crossY)) return;

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r || typeof r !== 'object') continue;
        const sd = r?.semidia ?? r?.['semidia(mm)'] ?? r?.semidiameter;
        if (sd !== undefined && sd !== null && String(sd).trim() !== '') continue;

        const rays = isInfinite
            ? (typeof (window as any).generateInfiniteSystemCrossBeam === 'function'
                ? (window as any).generateInfiniteSystemCrossBeam(rows, [{ x: 0, y: 0 }], {
                    rayCount: 21,
                    wavelength: wavelengthMicrons,
                    debugMode: false
                })
                : null)
            : (typeof (window as any).generateCrossBeam === 'function'
                ? (window as any).generateCrossBeam(rows, [{ x: crossX, y: 0, z: 0 }, { x: 0, y: crossY, z: 0 }], {
                    rayCount: 21,
                    wavelength: wavelengthMicrons,
                    debugMode: false
                })
                : null);

        if (!rays || !Array.isArray(rays.rays)) continue;
        let maxR = 0;
        for (const ray of rays.rays) {
            if (!Array.isArray(ray?.rayPath)) continue;
            const p = ray.rayPath[i];
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            const r = Math.sqrt(p.x * p.x + p.y * p.y);
            if (r > maxR) maxR = r;
        }
        if (maxR > 0) {
            r.semidia = maxR;
        }
    }
}

function autoCalculateMissingSemidia(sourceRows: any[], objectRows: any[]): void {
    const tbl = (window as any).tableOpticalSystem || (globalThis as any).tableOpticalSystem;
    const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
    if (!Array.isArray(rows) || rows.length < 2) return;

    try {
        const primaryWavelength = (typeof (window as any).getPrimaryWavelength === 'function')
            ? (Number((window as any).getPrimaryWavelength()) || 0.5876)
            : 0.5876;

        __zmxApplySemidiaOverridesFromMarginalRays(rows, primaryWavelength);

        if (tbl && typeof tbl.setData === 'function') {
            tbl.setData(rows);
        }
    } catch (_) {}
}

async function __loadAllDataObjectIntoApp(allData: any, options: { filename?: string } = {}): Promise<boolean> {
    const displayName = options?.filename || 'shared-link.json';

    // Normalize design data first
    try {
        if (typeof (window as any).normalizeDesign === 'function') {
            const normalizedResult = (window as any).normalizeDesign(allData);
            if (normalizedResult?.normalized) {
                allData = normalizedResult.normalized;
            }
        }
    } catch (_) {}

    // Build candidate configuration object
    let candidateConfig: any;
    if (allData && allData.configurations) {
        candidateConfig = allData.configurations;
    } else {
        candidateConfig = allData;
    }

    // Process blocks: derive from opticalSystem if missing or suspicious
    const cfgList = Array.isArray(candidateConfig?.configurations) ? candidateConfig.configurations : [];
    const configurationHasBlocks = (cfg: any) => {
        try {
            return cfg && Array.isArray(cfg.blocks) && cfg.blocks.length > 0;
        } catch (_) { return false; }
    };

    for (const cfg of cfgList) {
        try {
            const legacyRows = Array.isArray(cfg?.opticalSystem) ? cfg.opticalSystem : null;
            if (!legacyRows || legacyRows.length === 0) continue;

            const hasBlocks = configurationHasBlocks(cfg);

            // Try to derive blocks from legacy optical system rows
            if (typeof (window as any).deriveBlocksFromLegacyOpticalSystemRows === 'function') {
                const derived = (window as any).deriveBlocksFromLegacyOpticalSystemRows(legacyRows);
                const hasFatal = Array.isArray(derived?.issues) && derived.issues.some((i: any) => i && i.severity === 'fatal');

                if (!hasFatal && (!hasBlocks || (Array.isArray(derived?.blocks) && derived.blocks.length > 0))) {
                    cfg.blocks = Array.isArray(derived?.blocks) ? derived.blocks : [];
                    if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {};
                    cfg.metadata.importAnalyzeMode = false;
                }
            }
        } catch (_) {}
    }

    // Validate blocks if present
    for (const cfg of cfgList) {
        if (configurationHasBlocks(cfg)) {
            try {
                if (typeof (window as any).validateBlocksConfiguration === 'function') {
                    const issues = (window as any).validateBlocksConfiguration(cfg);
                    const fatals = Array.isArray(issues) ? issues.filter((i: any) => i && i.severity === 'fatal') : [];
                    if (fatals.length > 0) {
                        console.warn('⚠️ Block validation errors:', fatals);
                    }
                }
            } catch (_) {}
        }
    }

    // Expand blocks to opticalSystem for active configuration
    try {
        const activeId = candidateConfig?.activeConfigId || 1;
        const activeCfg = cfgList.find((c: any) => c.id === activeId) || cfgList[0];
        if (activeCfg && configurationHasBlocks(activeCfg)) {
            const legacyBeforeExpand = Array.isArray(activeCfg.opticalSystem) ? activeCfg.opticalSystem : null;
            
            if (typeof (window as any).expandBlocksToOpticalSystemRows === 'function') {
                const expanded = (window as any).expandBlocksToOpticalSystemRows(activeCfg.blocks);
                
                if (Array.isArray(legacyBeforeExpand) && legacyBeforeExpand.length > 0) {
                    // Preserve legacy surface data and overlay provenance
                    try {
                        if (typeof (window as any).__blocks_overlayExpandedProvenanceIntoLegacyRows === 'function') {
                            (window as any).__blocks_overlayExpandedProvenanceIntoLegacyRows(legacyBeforeExpand, expanded.rows);
                        }
                    } catch (_) {}
                    
                    // Normalize IDs
                    try {
                        for (let ii = 0; ii < legacyBeforeExpand.length; ii++) {
                            if (legacyBeforeExpand[ii] && typeof legacyBeforeExpand[ii] === 'object') {
                                legacyBeforeExpand[ii].id = ii;
                            }
                        }
                    } catch (_) {}
                    
                    activeCfg.opticalSystem = legacyBeforeExpand;
                } else if (Array.isArray(expanded?.rows)) {
                    activeCfg.opticalSystem = expanded.rows;
                }
            }
        }
    } catch (_) {}

    // Save configurations to localStorage
    try {
        localStorage.setItem('systemConfigurations', JSON.stringify(candidateConfig));
        console.log('🔵 [Load] Configurations data saved');
    } catch (e) {
        console.error('❌ Failed to save configurations:', e);
        return false;
    }

    // Determine effective data for tables
    let effectiveSource = allData.source;
    let effectiveObject = allData.object;
    let effectiveOpticalSystem = allData.opticalSystem;
    let effectiveMeritFunction = allData.meritFunction;
    let effectiveSystemRequirements = allData.systemRequirements;

    // If blocks exist, use expanded active configuration
    try {
        const activeId = candidateConfig?.activeConfigId || 1;
        const activeCfg = cfgList.find((c: any) => c.id === activeId) || cfgList[0];
        if (activeCfg) {
            if (configurationHasBlocks(activeCfg) && Array.isArray(activeCfg.opticalSystem)) {
                effectiveOpticalSystem = activeCfg.opticalSystem;
            }
            if (!effectiveSource && activeCfg.source) effectiveSource = activeCfg.source;
            if (!effectiveObject && activeCfg.object) effectiveObject = activeCfg.object;
            if (!effectiveOpticalSystem && activeCfg.opticalSystem) effectiveOpticalSystem = activeCfg.opticalSystem;
        }
        if (!effectiveMeritFunction && candidateConfig?.meritFunction) effectiveMeritFunction = candidateConfig.meritFunction;
        if (!effectiveSystemRequirements && candidateConfig?.systemRequirements) effectiveSystemRequirements = candidateConfig.systemRequirements;
    } catch (_) {}

    // Save to localStorage for table loading
    try {
        if (effectiveSystemRequirements) {
            localStorage.setItem('systemRequirementsData', JSON.stringify(effectiveSystemRequirements));
        }
    } catch (_) {}

    try {
        if (effectiveMeritFunction) {
            localStorage.setItem('meritFunctionData', JSON.stringify(effectiveMeritFunction));
        }
    } catch (_) {}

    // Update file name display
    try {
        let hasBlocksInAnyConfig = false;
        try {
            const cfgs = Array.isArray(candidateConfig?.configurations) ? candidateConfig.configurations : [];
            hasBlocksInAnyConfig = cfgs.some((cfg: any) => cfg && Array.isArray(cfg.blocks) && cfg.blocks.length > 0);
        } catch (_) {}
        
        const warn = !hasBlocksInAnyConfig;
        localStorage.setItem('loadedFileName', displayName);
        localStorage.setItem('loadedFileWarn', warn ? '1' : '');
        const fileNameElement = document.getElementById('loaded-file-name');
        if (fileNameElement) {
            fileNameElement.textContent = displayName;
            fileNameElement.style.color = warn ? '#b45309' : '#1a4d8f';
            if (warn && !fileNameElement.textContent.includes('(surfaces only)')) {
                fileNameElement.textContent = `${fileNameElement.textContent} (surfaces only)`;
            }
        }
    } catch (_) {}

    try {
        setTimeout(() => {
            try {
                if (typeof loadActiveConfigurationToTables === 'function') {
                    loadActiveConfigurationToTables();
                }
            } catch (_) {}
            try {
                const sourceData = JSON.parse(localStorage.getItem('sourceTableData') || '[]');
                const tableSource = (window as any).tableSource;
                if (tableSource && typeof tableSource.replaceData === 'function') {
                    tableSource.replaceData(sourceData);
                } else if (tableSource && typeof tableSource.setData === 'function') {
                    tableSource.setData(sourceData);
                }
            } catch (_) {}
            try {
                const objectData = JSON.parse(localStorage.getItem('objectTableData') || '[]');
                const tableObject = (window as any).tableObject;
                if (tableObject && typeof tableObject.replaceData === 'function') {
                    tableObject.replaceData(objectData);
                } else if (tableObject && typeof tableObject.setData === 'function') {
                    tableObject.setData(objectData);
                }
            } catch (_) {}
            try {
                const opticalData = JSON.parse(localStorage.getItem('OpticalSystemTableData') || '[]');
                const tableOptical = (window as any).tableOpticalSystem || (window as any).opticalSystemTabulator;
                if (tableOptical && typeof tableOptical.replaceData === 'function') {
                    tableOptical.replaceData(opticalData);
                } else if (tableOptical && typeof tableOptical.setData === 'function') {
                    tableOptical.setData(opticalData);
                }
            } catch (_) {}
            try {
                const meritData = JSON.parse(localStorage.getItem('meritFunctionData') || '[]');
                const meritEditor = (window as any).meritFunctionEditor;
                if (meritEditor && typeof meritEditor.setData === 'function') {
                    meritEditor.setData(meritData);
                }
            } catch (_) {}
            try {
                const reqData = JSON.parse(localStorage.getItem('systemRequirementsData') || '[]');
                const reqEditor = (window as any).systemRequirementsEditor;
                if (reqEditor && typeof reqEditor.setData === 'function') {
                    reqEditor.setData(reqData);
                    if (typeof reqEditor.scheduleEvaluateAndUpdate === 'function') {
                        reqEditor.scheduleEvaluateAndUpdate();
                    }
                }
            } catch (_) {}
            try { refreshBlockInspector(); } catch (_) {}
            try {
                if (typeof (window as any).updateTransformSurfaceSelect === 'function') {
                    (window as any).updateTransformSurfaceSelect();
                }
            } catch (_) {}
            
            // Wait for config-select element to be available, then initialize Configuration UI
            const waitForConfigSelect = () => {
                const selectElement = document.getElementById('config-select');
                if (selectElement && typeof (window as any).initializeConfigurationUI === 'function') {
                    console.log('🔵 [Load] Calling initializeConfigurationUI()');
                    (window as any).initializeConfigurationUI();
                } else {
                    console.log('🔵 [Load] Waiting for config-select element...');
                    setTimeout(waitForConfigSelect, 100);
                }
            };
            waitForConfigSelect();
        }, 0);
    } catch (_) {}

    console.log(`✅ Loaded: ${displayName}`);
    return true;
}

function setupLoadAllButton(): void {
    const btn = document.getElementById('load-all-btn');
    if (!btn) return;

    const loadHandler = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', async (e: Event) => {
            const target = e.target as HTMLInputElement;
            const file = target?.files?.[0];
            if (!file) return;

            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                await __loadAllDataObjectIntoApp(parsed, { filename: file.name });
            } catch (err) {
                console.error('❌ Load failed:', err);
                alert(`Load failed: ${(err as Error)?.message || String(err)}`);
            }
        });
        input.click();
    };
    
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', loadHandler);
}

// Setup Zemax Import Button
function setupImportZemaxButton(): void {
    const btn = document.getElementById('import-zemax-btn');
    if (!btn) return;

    const importHandler = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zmx';
        input.addEventListener('change', async (e: Event) => {
            const target = e.target as HTMLInputElement;
            const file = target?.files?.[0];
            if (!file) return;

            try {
                const arrayBuffer = await file.arrayBuffer();
                const decoder = new TextDecoder('utf-8');
                const text = decoder.decode(arrayBuffer);

                if (typeof (window as any).parseZemaxFile === 'function') {
                    const parsed = (window as any).parseZemaxFile(text);
                    if (parsed && typeof parsed === 'object') {
                        await __loadAllDataObjectIntoApp(parsed, { filename: file.name });
                        try {
                            autoCalculateMissingSemidia([], []);
                        } catch (_) {}
                    }
                }
            } catch (err) {
                console.error('❌ Zemax import failed:', err);
                alert(`Import failed: ${(err as Error)?.message || String(err)}`);
            }
        });
        input.click();
    };
    
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', importHandler);
}

// Setup Optimization Buttons
function setupOptimizeDesignIntentButton(): void {
    const optimizeBtn = document.getElementById('optimize-design-intent-btn') as HTMLButtonElement | null;
    if (!optimizeBtn) return;

    optimizeBtn.addEventListener('click', async () => {
        const _gThis = (typeof globalThis !== 'undefined') ? globalThis as any : {} as any;
        const isRunningFlag = !!_gThis.__cooptOptimizerIsRunning;
        const schedulerWindow = _gThis.__cooptOptimizerSchedulerWindow;
        const isStaleRunning = isRunningFlag && (!schedulerWindow || schedulerWindow.closed);
        console.log('[Optimize] Button clicked, checking if already running:', isRunningFlag, { isStaleRunning });

        if (isRunningFlag && !isStaleRunning) {
            alert('Optimization is already running. Please wait for it to complete or stop it first.');
            return;
        }
        if (isStaleRunning) {
            _gThis.__cooptOptimizerIsRunning = false;
        }

        const prevDisabled = optimizeBtn.disabled;
        optimizeBtn.disabled = true;
        try {
            const opt = (window as any).OptimizationMVP;
            if (!opt || typeof opt.run !== 'function') {
                alert('OptimizationMVP が利用できません。');
                optimizeBtn.disabled = false;
                return;
            }

            // Auto-detect scenarios
            let multiScenario = false;
            let activeCfg: any = null;
            let variableCount = 0;
            let numericVarCount = 0;
            let categoricalVarCount = 0;
            try {
                const systemConfig = (typeof (window as any).loadSystemConfigurationsFromTableConfig === 'function')
                    ? (window as any).loadSystemConfigurationsFromTableConfig()
                    : JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
                const activeId = systemConfig?.activeConfigId;
                activeCfg = systemConfig?.configurations?.find((c: any) => c && c.id === activeId)
                    || systemConfig?.configurations?.[0]
                    || null;
                if (activeCfg && Array.isArray(activeCfg.scenarios) && activeCfg.scenarios.length >= 2) {
                    multiScenario = true;
                }
                const allVars = listDesignVariablesFromBlocks(activeCfg || {});
                const numericVars = Array.isArray(allVars)
                    ? allVars.filter((v: any) => typeof v?.value === 'number' && Number.isFinite(v.value))
                    : [];
                variableCount = Array.isArray(allVars) ? allVars.length : 0;
                numericVarCount = numericVars.length;
                categoricalVarCount = Math.max(0, variableCount - numericVarCount);
            } catch (_) {}

            // Progress popup window
            let popup: Window | null = null;
            const stopFlag = { stop: false };
            let popupWatchTimer: ReturnType<typeof setInterval> | null = null;
            let isRunning = false;
            try {
                popup = window.open('', 'coopt-optimizer-progress', 'width=500,height=550,resizable=yes,scrollbars=no');
                if (popup && popup.document) {
                    const baseOrigin = (window && window.location && window.location.origin) ? window.location.origin : '';
                    const faviconHref = `${baseOrigin}/favicon.svg`;
                    popup.document.open();
                    popup.document.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Optimize Progress</title>
  <base href="${baseOrigin}/" />
  <link rel="icon" type="image/svg+xml" href="${faviconHref}" />
</head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 12px;">
<div style="font-size:14px; font-weight:600; margin-bottom:8px;">Optimize Progress</div>
<div style="font-size:12px; color:#555; margin-bottom:10px;">Updates per candidate evaluation (±step)</div>
<div style="margin-bottom:10px; display:flex; align-items:center; gap:6px;">
    <button id="opt-run" style="padding:6px 10px;">Run</button>
    <button id="opt-stop" style="padding:6px 10px;" disabled>Stop</button>
    <span id="opt-stop-state" style="margin-left:8px; font-size:12px; color:#555;"></span>
</div>
<div style="margin-bottom:10px; display:flex; align-items:center; gap:10px;">
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        Max Iterations
        <input id="opt-max-iter" type="number" min="1" step="1" value="10000" style="width:100px; padding:4px 6px;" />
    </label>
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        <input id="opt-auto-render" type="checkbox" style="width:16px; height:16px;" />
        Auto-render on Accept
    </label>
</div>
<div style="display:flex; gap:10px; flex-direction:column;">
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Phase</span><span id="opt-phase" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Decision</span><span id="opt-decision" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Accept/Reject</span><span id="opt-decision-count" style="margin-left:8px;">0 / 0</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Iter</span><span id="opt-iter" style="margin-left:8px;">0</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Vars</span><span id="opt-vars" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Req</span><span id="opt-req" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Res</span><span id="opt-res" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Score</span><span id="opt-cur" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Violation</span><span id="opt-vio" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Soft</span><span id="opt-soft" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Best</span><span id="opt-best" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Rho</span><span id="opt-rho" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Issue</span><span id="opt-issue" style="margin-left:8px;">-</span></div>
</div>
<details style="margin-top:10px; margin-bottom:10px; font-size:12px; color:#555;">
    <summary style="font-weight:600; margin-bottom:6px; cursor:pointer;">Stability Tuning</summary>
    <div style="display:grid; grid-template-columns: 180px 140px 1fr; gap:6px 10px; align-items:center; margin-top:6px;">
        <div>stepFraction</div>
        <input id="opt-step-fraction" type="number" step="0.001" value="0.02" style="width:120px; padding:4px 6px;" />
        <div>CDの初期ステップ比率（小さくすると安定）</div>

        <div>minStep</div>
        <input id="opt-min-step" type="number" step="1e-7" value="1e-6" style="width:120px; padding:4px 6px;" />
        <div>CDの最小ステップ</div>

        <div>stepDecay</div>
        <input id="opt-step-decay" type="number" step="0.05" value="0.5" style="width:120px; padding:4px 6px;" />
        <div>CDの失敗時縮小率</div>

        <div>lmLambda0</div>
        <input id="opt-lm-lambda0" type="number" step="1e-4" value="1e-3" style="width:120px; padding:4px 6px;" />
        <div>LM初期ダンピング</div>

        <div>lmLambdaUp</div>
        <input id="opt-lm-lambdaup" type="number" step="1" value="10" style="width:120px; padding:4px 6px;" />
        <div>LM拒否時の増加係数</div>

        <div>lmLambdaDown</div>
        <input id="opt-lm-lambdadown" type="number" step="0.05" value="0.3" style="width:120px; padding:4px 6px;" />
        <div>LM受理時の減少係数</div>

        <div>trustRegion</div>
        <input id="opt-trust-region" type="checkbox" checked style="width:16px; height:16px;" />
        <div>信頼領域を有効化</div>

        <div>trustRegionDelta</div>
        <input id="opt-trust-region-delta" type="number" step="0.01" value="0.05" style="width:120px; padding:4px 6px;" />
        <div>信頼領域の基本半径</div>

        <div>trustRegionDeltaMax</div>
        <input id="opt-trust-region-delta-max" type="number" step="0.1" value="1.0" style="width:120px; padding:4px 6px;" />
        <div>信頼領域の最大半径</div>

        <div>backtracking</div>
        <input id="opt-backtracking" type="checkbox" checked style="width:16px; height:16px;" />
        <div>LMのバックトラック探索</div>

        <div>backtrackingMaxTries</div>
        <input id="opt-backtracking-max-tries" type="number" step="1" value="8" style="width:120px; padding:4px 6px;" />
        <div>バックトラック試行回数</div>

        <div>fdStepFraction</div>
        <input id="opt-fd-step-fraction" type="number" step="1e-5" value="1e-4" style="width:120px; padding:4px 6px;" />
        <div>数値微分の相対ステップ</div>

        <div>fdMinStep</div>
        <input id="opt-fd-min-step" type="number" step="1e-19" value="1e-18" style="width:120px; padding:4px 6px;" />
        <div>数値微分の最小ステップ</div>

        <div>fdScaledStep</div>
        <input id="opt-fd-scaled-step" type="number" step="1e-4" value="1e-3" style="width:120px; padding:4px 6px;" />
        <div>スケール付き微分ステップ</div>

        <div>staged</div>
        <input id="opt-staged" type="checkbox" checked style="width:16px; height:16px;" />
        <div>係数の段階的解放</div>

        <div>stageStallLimit</div>
        <input id="opt-stage-stall-limit" type="number" step="1" value="2" style="width:120px; padding:4px 6px;" />
        <div>段階の停滞許容回数</div>

        <div>restartOnRejectStreak</div>
        <input id="opt-restart-on-reject-streak" type="number" step="1" value="8" style="width:120px; padding:4px 6px;" />
        <div>連続拒否でリスタート</div>

        <div>restartMaxCount</div>
        <input id="opt-restart-max-count" type="number" step="1" value="2" style="width:120px; padding:4px 6px;" />
        <div>リスタートの最大回数</div>

        <div>restartJitterScaled</div>
        <input id="opt-restart-jitter-scaled" type="number" step="0.005" value="0.035" style="width:120px; padding:4px 6px;" />
        <div>リスタート時のジッタ量</div>

        <div>lmExploreWhenFlat</div>
        <input id="opt-lm-explore-when-flat" type="checkbox" style="width:16px; height:16px;" />
        <div>LMが平坦時に探索を許可</div>

        <div>lmExploreTries</div>
        <input id="opt-lm-explore-tries" type="number" step="1" value="3" style="width:120px; padding:4px 6px;" />
        <div>探索ステップ試行回数</div>
    </div>
</details>
     </body>
    </html>`);
                    popup.document.close();

                    try {
                        const varsEl = popup.document.getElementById('opt-vars');
                        if (varsEl) {
                            const parts: string[] = [];
                            if (Number.isFinite(variableCount)) parts.push(String(variableCount));
                            if (Number.isFinite(numericVarCount) || Number.isFinite(categoricalVarCount)) {
                                parts.push(`(num ${numericVarCount}, cat ${categoricalVarCount})`);
                            }
                            varsEl.textContent = parts.length ? parts.join(' ') : '-';
                        }
                    } catch (_) {}

                    try {
                        const stopBtn = popup.document.getElementById('opt-stop') as HTMLButtonElement | null;
                        const runBtn = popup.document.getElementById('opt-run') as HTMLButtonElement | null;
                        const stopState = popup.document.getElementById('opt-stop-state');
                        if (stopBtn) {
                            stopBtn.addEventListener('click', () => {
                                stopFlag.stop = true;
                                try {
                                    const _opt = (window as any).OptimizationMVP;
                                    if (_opt && typeof _opt.stop === 'function') _opt.stop();
                                } catch (_) {}
                                try { if (stopBtn) stopBtn.disabled = true; } catch (_) {}
                                try { if (runBtn) runBtn.disabled = true; } catch (_) {}
                                if (stopState) stopState.textContent = 'Stopping...';
                            });
                        }
                        if (runBtn) {
                            runBtn.addEventListener('click', () => {
                                try {
                                    const fn = (window as any).__cooptStartOptimizationFromPopup;
                                    if (typeof fn === 'function') fn();
                                } catch (_) {}
                            });
                        }
                    } catch (_) {}
                }
            } catch (_) {
                popup = null;
            }

            // Popup watchdog
            if (popup) {
                try {
                    _gThis.__cooptOptimizerSchedulerWindow = popup;
                    _gThis.__cooptOptimizerIsRunning = false;
                } catch (_) {}

                try {
                    (popup as any).onbeforeunload = function(e: any) {
                        if (_gThis.__cooptOptimizerIsRunning) {
                            const message = 'Optimization is still running. Closing this window may cause instability. Are you sure?';
                            e.returnValue = message;
                            return message;
                        }
                    };
                } catch (_) {}

                try {
                    popupWatchTimer = window.setInterval(() => {
                        if (!popup || popup.closed) {
                            if (_gThis.__cooptOptimizerIsRunning) {
                                alert('⚠️ Warning: Optimize Progress window was closed while optimization was running.\nThis may cause instability. Use the Stop button before closing the window.');
                                stopFlag.stop = true;
                                try {
                                    const _opt = (window as any).OptimizationMVP;
                                    if (_opt && typeof _opt.stop === 'function') _opt.stop();
                                } catch (_) {}
                                _gThis.__cooptOptimizerIsRunning = false;
                            }
                            if (popupWatchTimer) {
                                try { window.clearInterval(popupWatchTimer); } catch (_) {}
                                popupWatchTimer = null;
                            }
                            try {
                                if (_gThis.__cooptOptimizerSchedulerWindow === popup) {
                                    _gThis.__cooptOptimizerSchedulerWindow = null;
                                }
                            } catch (_) {}
                        }
                    }, 250);
                } catch (_) {}
            }

            const totalMeritEl = document.getElementById('total-merit-value');
            let lastIssueText = '-';
            let lastReqText = '-';
            let lastResText = '-';
            let lastRhoText = '-';
            let lastVioText = '-';
            let lastSoftText = '-';
            let lastDecisionText = '-';
            let acceptCount = 0;
            let rejectCount = 0;
            let __lastReqRefreshAt = 0;
            const __reqRefreshThrottleMs = 500;

            const updateProgressUI = (p: any) => {
                const phaseStr = String(p?.phase ?? '');
                if (phaseStr === 'stopped' || phaseStr === 'done' || phaseStr === 'error') {
                    try { optimizeBtn.disabled = false; } catch (_) {}
                    isRunning = false;
                }

                if (phaseStr === 'accept') {
                    acceptCount++;
                    const a = (p && ('alpha' in p)) ? Number(p.alpha) : NaN;
                    const r = (p && ('rho' in p)) ? Number(p.rho) : NaN;
                    const aText = Number.isFinite(a) ? a.toFixed(6) : '-';
                    const rText = Number.isFinite(r) ? r.toFixed(6) : '-';
                    lastDecisionText = `ACCEPT (α=${aText}, ρ=${rText})`;

                    try {
                        if (popup && !popup.closed) {
                            const autoRenderCheckbox = popup.document.getElementById('opt-auto-render') as HTMLInputElement | null;
                            if (autoRenderCheckbox && autoRenderCheckbox.checked) {
                                if ((window as any).popup3DWindow && !(window as any).popup3DWindow.closed) {
                                    const drawBtn = (window as any).popup3DWindow.document.getElementById('draw-btn');
                                    if (drawBtn) drawBtn.click();
                                }
                            }
                        }
                    } catch (_) {}
                } else if (phaseStr === 'reject') {
                    rejectCount++;
                    lastDecisionText = 'REJECT';
                }

                const cur = Number(p?.current);
                const best = Number(p?.best);
                if (totalMeritEl && Number.isFinite(cur)) {
                    totalMeritEl.textContent = cur.toFixed(6);
                }

                try {
                    const now = Date.now();
                    if ((now - __lastReqRefreshAt) >= __reqRefreshThrottleMs) {
                        if (phaseStr === 'start' || phaseStr === 'iter' || phaseStr === 'candidate' || phaseStr === 'accept' || phaseStr === 'reject') {
                            const sre = (window as any).systemRequirementsEditor;
                            if (sre && typeof sre.scheduleEvaluateAndUpdate === 'function') {
                                __lastReqRefreshAt = now;
                                sre.scheduleEvaluateAndUpdate();
                            }
                        }
                    }
                } catch (_) {}

                if (p && ('materialIssue' in p)) {
                    lastIssueText = (p.materialIssue === undefined || p.materialIssue === null || p.materialIssue === '')
                        ? '-'
                        : String(p.materialIssue);
                }

                // Surface the worst residual/requirement contributor
                try {
                    const dbg = ((window as any).__cooptLastOptimizerResidualDebug && typeof (window as any).__cooptLastOptimizerResidualDebug === 'object')
                        ? (window as any).__cooptLastOptimizerResidualDebug
                        : null;
                    const worst = dbg && dbg.worst && typeof dbg.worst === 'object' ? dbg.worst : null;
                    const at = dbg ? Number(dbg.at) : NaN;
                    const fresh = Number.isFinite(at) ? (Date.now() - at) < 3000 : false;
                    const fmtNum = (x: any) => {
                        const n = Number(x);
                        return Number.isFinite(n) ? n.toFixed(6) : String(x ?? '-');
                    };
                    if (fresh && worst && worst.operand) {
                        const op = String(worst.operand);
                        const cfg = String(worst.configId ?? '');
                        const sid = (worst.scenarioId !== undefined && worst.scenarioId !== null && String(worst.scenarioId).trim())
                            ? String(worst.scenarioId)
                            : '';
                        const amt = fmtNum(worst.amount);
                        const curV = fmtNum(worst.current);
                        const rsn = String(worst.reason ?? '').trim();

                        const spotTag = (() => {
                            try {
                                if (!op.startsWith('SPOT_SIZE')) return '';
                                const sd = (dbg && dbg.spotDebug && typeof dbg.spotDebug === 'object') ? dbg.spotDebug : null;
                                if (!sd) return '';
                                const impl = String(sd.impl ?? '').trim();
                                const r = String(sd.reason ?? '').trim();
                                const hrRaw = sd.earlyAbortHitRate;
                                const hr = (hrRaw === null || hrRaw === undefined || hrRaw === '') ? NaN : Number(hrRaw);
                                const kind = String(sd.failPenaltyKind ?? '').trim();
                                const lf = (sd.lastRayTraceFailure && typeof sd.lastRayTraceFailure === 'object') ? sd.lastRayTraceFailure : null;
                                const ld = (lf && lf.details && typeof lf.details === 'object') ? lf.details : null;
                                const surfNo = Number(sd.blockSurfaceNumber ?? ld?.surfaceNumber);
                                const hitR = Number(sd.blockHitRadiusMm ?? ld?.hitRadiusMm);
                                const limR = Number(sd.blockApertureLimitMm ?? ld?.apertureLimitMm);
                                const surfIdx = Number(sd.targetSurfaceIndex);
                                const wl = Number(sd.wavelength);
                                const rays = Number(sd.rayCountRequested);
                                const hits = Number(sd.hits);
                                const parts: string[] = [];
                                if (impl) parts.push(impl);
                                if (r) parts.push(r);
                                if (Number.isFinite(hr)) parts.push(`hitRate=${hr.toFixed(3)}`);
                                if (kind) parts.push(kind);
                                if (Number.isFinite(surfIdx) && surfIdx >= 0) parts.push(`Sidx=${Math.floor(surfIdx)}`);
                                if (Number.isFinite(wl) && wl > 0) parts.push(`wl=${wl.toFixed(4)}um`);
                                if (Number.isFinite(rays) && rays > 0) parts.push(`rays=${Math.floor(rays)}`);
                                if (Number.isFinite(hits) && hits >= 0) parts.push(`hits=${Math.floor(hits)}`);
                                if (kind === 'PHYSICAL_APERTURE_BLOCK') {
                                    if (Number.isFinite(surfNo) && surfNo > 0) parts.push(`S${Math.floor(surfNo)}`);
                                    if (Number.isFinite(hitR) && Number.isFinite(limR) && limR > 0) {
                                        parts.push(`r=${hitR.toFixed(3)}/${limR.toFixed(3)}mm`);
                                    }
                                }
                                return parts.length > 0 ? ` [spot:${parts.join(' ')}]` : '';
                            } catch (_) {
                                return '';
                            }
                        })();

                        const tag = sid ? ` cfg=${cfg} scn=${sid}` : (cfg ? ` cfg=${cfg}` : '');
                        const reasonTag = rsn ? ` (${rsn})` : '';
                        lastIssueText = `Worst: ${op}${tag} cur=${curV} amt=${amt}${reasonTag}${spotTag}`;
                    }
                } catch (_) {}

                if (p?.requirementCount !== undefined) {
                    lastReqText = String(p.requirementCount);
                }
                if (p?.residualCount !== undefined) {
                    lastResText = String(p.residualCount);
                }
                if (p && ('rho' in p)) {
                    const r = Number(p.rho);
                    lastRhoText = Number.isFinite(r) ? r.toFixed(6) : '-';
                }
                if (p && ('violationScore' in p)) {
                    const v = Number(p.violationScore);
                    lastVioText = Number.isFinite(v) ? v.toFixed(6) : '-';
                }
                if (p && ('softPenalty' in p)) {
                    const s = Number(p.softPenalty);
                    lastSoftText = Number.isFinite(s) ? s.toFixed(6) : '-';
                }

                if (popup && !popup.closed) {
                    try {
                        const doc = popup.document;
                        const setText = (id: string, v: string) => {
                            const el = doc.getElementById(id);
                            if (el) el.textContent = v;
                        };
                        setText('opt-phase', String(p?.phase ?? '-'));
                        setText('opt-decision', lastDecisionText);
                        setText('opt-decision-count', `${acceptCount} / ${rejectCount}`);
                        setText('opt-iter', String(p?.iter ?? '-'));
                        setText('opt-req', lastReqText);
                        setText('opt-res', lastResText);
                        setText('opt-cur', Number.isFinite(cur) ? cur.toFixed(6) : String(p?.current ?? '-'));
                        setText('opt-vio', lastVioText);
                        setText('opt-soft', lastSoftText);
                        setText('opt-best', Number.isFinite(best) ? best.toFixed(6) : String(p?.best ?? '-'));
                        setText('opt-rho', lastRhoText);
                        setText('opt-issue', lastIssueText);

                        if (String(p?.phase) === 'stopped') {
                            setText('opt-stop-state', 'Stopped');
                            try {
                                const btn = doc.getElementById('opt-stop') as HTMLButtonElement | null;
                                if (btn) btn.disabled = true;
                                const runBtn = doc.getElementById('opt-run') as HTMLButtonElement | null;
                                if (runBtn) runBtn.disabled = false;
                            } catch (_) {}
                        } else if (String(p?.phase) === 'done') {
                            setText('opt-stop-state', 'Done');
                            try {
                                const btn = doc.getElementById('opt-stop') as HTMLButtonElement | null;
                                if (btn) btn.disabled = true;
                                const runBtn = doc.getElementById('opt-run') as HTMLButtonElement | null;
                                if (runBtn) runBtn.disabled = false;
                            } catch (_) {}
                        } else if (String(p?.phase) === 'error') {
                            setText('opt-stop-state', 'Error');
                            try {
                                const btn = doc.getElementById('opt-stop') as HTMLButtonElement | null;
                                if (btn) btn.disabled = true;
                                const runBtn = doc.getElementById('opt-run') as HTMLButtonElement | null;
                                if (runBtn) runBtn.disabled = false;
                            } catch (_) {}
                        } else if (stopFlag.stop) {
                            setText('opt-stop-state', 'Stopping...');
                        }
                    } catch (_) {}
                }
            };

            const startRun = async () => {
                isRunning = true;
                console.log('[Optimize] startRun called, setting flags to true');
                _gThis.__cooptOptimizerIsRunning = true;

                try {
                    // Save state before optimization for undo
                    let beforeOptimizationState: any = null;
                    try {
                        const json = localStorage.getItem('systemConfigurations');
                        if (json) beforeOptimizationState = JSON.parse(json);
                    } catch (_) {}

                    stopFlag.stop = false;
                    acceptCount = 0;
                    rejectCount = 0;
                    lastIssueText = '-';
                    lastReqText = '-';
                    lastResText = '-';
                    lastRhoText = '-';
                    lastVioText = '-';
                    lastSoftText = '-';
                    lastDecisionText = '-';

                    // Re-read config for each Run
                    try {
                        const systemConfig = (typeof (window as any).loadSystemConfigurationsFromTableConfig === 'function')
                            ? (window as any).loadSystemConfigurationsFromTableConfig()
                            : JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
                        const activeId = systemConfig?.activeConfigId;
                        activeCfg = systemConfig?.configurations?.find((c: any) => c && c.id === activeId)
                            || systemConfig?.configurations?.[0]
                            || null;
                        if (activeCfg && Array.isArray(activeCfg.scenarios) && activeCfg.scenarios.length >= 2) {
                            multiScenario = true;
                        } else {
                            multiScenario = false;
                        }

                        const allVars = listDesignVariablesFromBlocks(activeCfg || {});
                        const numericVars = Array.isArray(allVars)
                            ? allVars.filter((v: any) => typeof v?.value === 'number' && Number.isFinite(v.value))
                            : [];
                        variableCount = Array.isArray(allVars) ? allVars.length : 0;
                        numericVarCount = numericVars.length;
                        categoricalVarCount = Math.max(0, variableCount - numericVarCount);

                        if (popup && !popup.closed) {
                            try {
                                const varsEl = popup.document.getElementById('opt-vars');
                                if (varsEl) {
                                    const parts: string[] = [];
                                    if (Number.isFinite(variableCount)) parts.push(String(variableCount));
                                    if (Number.isFinite(numericVarCount) || Number.isFinite(categoricalVarCount)) {
                                        parts.push(`(num ${numericVarCount}, cat ${categoricalVarCount})`);
                                    }
                                    varsEl.textContent = parts.length ? parts.join(' ') : '-';
                                }
                            } catch (_) {}
                        }
                    } catch (_) {}

                    try {
                        if (popup && !popup.closed) {
                            const doc = popup.document;
                            const stopBtn = doc.getElementById('opt-stop') as HTMLButtonElement | null;
                            const runBtn = doc.getElementById('opt-run') as HTMLButtonElement | null;
                            const stopState = doc.getElementById('opt-stop-state');
                            if (stopBtn) stopBtn.disabled = false;
                            if (runBtn) runBtn.disabled = true;
                            if (stopState) stopState.textContent = 'Running...';
                        }
                    } catch (_) {}

                    try { optimizeBtn.disabled = true; } catch (_) {}

                    console.log('🛠️ [Optimize] Running OptimizationMVP...', { multiScenario });
                    const shouldStopNow = () => !!stopFlag.stop;

                    const resolveMaxIterations = (): number => {
                        let n = 1000;
                        try {
                            if (popup && !popup.closed) {
                                const el = popup.document.getElementById('opt-max-iter') as HTMLInputElement | null;
                                const v = el ? Number(el.value) : NaN;
                                if (Number.isFinite(v)) n = Math.trunc(v);
                            }
                        } catch (_) {}
                        if (!Number.isFinite(n) || n < 1) n = 1000;
                        return n;
                    };

                    const resolveOptParams = () => {
                        const readNum = (id: string, fallback: number): number => {
                            let v = fallback;
                            try {
                                if (popup && !popup.closed) {
                                    const el = popup.document.getElementById(id) as HTMLInputElement | null;
                                    const n = el ? Number(el.value) : NaN;
                                    if (Number.isFinite(n)) v = n;
                                }
                            } catch (_) {}
                            return v;
                        };
                        const readBool = (id: string, fallback: boolean): boolean => {
                            let v = fallback;
                            try {
                                if (popup && !popup.closed) {
                                    const el = popup.document.getElementById(id) as HTMLInputElement | null;
                                    if (el && typeof el.checked === 'boolean') v = !!el.checked;
                                }
                            } catch (_) {}
                            return v;
                        };

                        const trustRegionDelta = readNum('opt-trust-region-delta', 0.05);
                        const trustRegionDeltaMax = Math.max(trustRegionDelta, readNum('opt-trust-region-delta-max', 1.0));

                        return {
                            stepFraction: readNum('opt-step-fraction', 0.02),
                            minStep: readNum('opt-min-step', 1e-6),
                            stepDecay: readNum('opt-step-decay', 0.5),
                            lmLambda0: readNum('opt-lm-lambda0', 1e-3),
                            lmLambdaUp: readNum('opt-lm-lambdaup', 10),
                            lmLambdaDown: readNum('opt-lm-lambdadown', 0.3),
                            trustRegion: readBool('opt-trust-region', true),
                            trustRegionDelta,
                            trustRegionDeltaMax,
                            backtracking: readBool('opt-backtracking', true),
                            backtrackingMaxTries: Math.max(1, Math.floor(readNum('opt-backtracking-max-tries', 8))),
                            fdStepFraction: readNum('opt-fd-step-fraction', 1e-4),
                            fdMinStep: readNum('opt-fd-min-step', 1e-18),
                            fdScaledStep: readNum('opt-fd-scaled-step', 1e-3),
                            staged: readBool('opt-staged', true),
                            stageStallLimit: Math.max(1, Math.floor(readNum('opt-stage-stall-limit', 2))),
                            restartOnRejectStreak: Math.max(1, Math.floor(readNum('opt-restart-on-reject-streak', 8))),
                            restartMaxCount: Math.max(0, Math.floor(readNum('opt-restart-max-count', 2))),
                            restartJitterScaled: Math.max(0, readNum('opt-restart-jitter-scaled', 0.035)),
                            lmExploreWhenFlat: readBool('opt-lm-explore-when-flat', false),
                            lmExploreTries: Math.max(1, Math.floor(readNum('opt-lm-explore-tries', 3)))
                        };
                    };

                    const maxIterations = resolveMaxIterations();
                    const optParams = resolveOptParams();

                    let result: any = null;
                    let __prevDisableRayTraceDebug: any;
                    try {
                        // Prevent undo recording during optimization
                        if ((window as any).undoHistory) {
                            (window as any).undoHistory.isExecuting = true;
                        }

                        // Force-disable ray-tracing detailed debug logs during optimization.
                        try {
                            __prevDisableRayTraceDebug = _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG;
                        } catch (_) { __prevDisableRayTraceDebug = undefined; }
                        try {
                            _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG = true;
                        } catch (_) {}

                        result = await opt.run({
                            multiScenario,
                            runUntilStopped: false,
                            maxIterations,
                            method: 'lm',
                            stageMaxCoef: [10],
                            ...optParams,
                            onProgress: updateProgressUI,
                            shouldStop: shouldStopNow
                        });
                        console.log('✅ [Optimize] Done', result);

                        // Restore flags after successful completion
                        try {
                            if (__prevDisableRayTraceDebug !== undefined) _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG = __prevDisableRayTraceDebug;
                            else {
                                try { delete _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG; } catch (_) {}
                            }
                            _gThis.__cooptOptimizerIsRunning = false;
                        } catch (_) {}

                        // Re-enable undo recording after optimization
                        if ((window as any).undoHistory) {
                            (window as any).undoHistory.isExecuting = false;
                        }

                        // Record optimization as a single undo operation
                        try {
                            if (beforeOptimizationState && (window as any).undoHistory && result?.ok) {
                                const afterOptimizationState = JSON.parse(localStorage.getItem('systemConfigurations') || '{}');
                                if (JSON.stringify(beforeOptimizationState) !== JSON.stringify(afterOptimizationState)) {
                                    const command = {
                                        name: 'Optimization',
                                        execute: async () => {
                                            localStorage.setItem('systemConfigurations', JSON.stringify(afterOptimizationState));
                                            try {
                                                if ((window as any).ConfigurationManager && typeof (window as any).ConfigurationManager.loadActiveConfigurationToTables === 'function') {
                                                    await (window as any).ConfigurationManager.loadActiveConfigurationToTables({ applyToUI: true });
                                                }
                                            } catch (_) {}
                                            try {
                                                if (typeof (window as any).refreshBlockInspector === 'function') (window as any).refreshBlockInspector();
                                            } catch (_) {}
                                        },
                                        undo: async () => {
                                            localStorage.setItem('systemConfigurations', JSON.stringify(beforeOptimizationState));
                                            try {
                                                if ((window as any).ConfigurationManager && typeof (window as any).ConfigurationManager.loadActiveConfigurationToTables === 'function') {
                                                    await (window as any).ConfigurationManager.loadActiveConfigurationToTables({ applyToUI: true });
                                                }
                                            } catch (_) {}
                                            try {
                                                if (typeof (window as any).refreshBlockInspector === 'function') (window as any).refreshBlockInspector();
                                            } catch (_) {}
                                        },
                                        redo: function() { return this.execute(); }
                                    };
                                    (window as any).undoHistory.record(command);
                                }
                            }
                        } catch (e) {
                            console.warn('[Undo] Failed to record optimization:', e);
                        }
                    } catch (e: any) {
                        console.warn('⚠️ [Optimize] Failed:', e);
                        result = { ok: false, reason: e?.message ?? String(e) };

                        try {
                            if (__prevDisableRayTraceDebug !== undefined) _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG = __prevDisableRayTraceDebug;
                            else {
                                try { delete _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG; } catch (_) {}
                            }
                            _gThis.__cooptOptimizerIsRunning = false;
                        } catch (_) {}

                        if ((window as any).undoHistory) {
                            (window as any).undoHistory.isExecuting = false;
                        }
                    } finally {
                        isRunning = false;
                        console.log('[Optimize] Optimization completed in finally block, resetting isRunning flag');
                        _gThis.__cooptOptimizerIsRunning = false;
                        try { optimizeBtn.disabled = false; } catch (_) {}
                        try {
                            if (popup && !popup.closed) {
                                const doc = popup.document;
                                const stopBtn = doc.getElementById('opt-stop') as HTMLButtonElement | null;
                                const runBtn = doc.getElementById('opt-run') as HTMLButtonElement | null;
                                const stopState = doc.getElementById('opt-stop-state');
                                if (stopBtn) stopBtn.disabled = true;
                                if (runBtn) runBtn.disabled = false;
                                if (stopState && stopFlag.stop) stopState.textContent = 'Stopped';
                            }
                        } catch (_) {}
                    }

                    if (result && result.ok === false) {
                        const reason = String(result.reason || 'Optimize did not run.');
                        try {
                            if (popup && !popup.closed) {
                                const el = popup.document.getElementById('opt-phase');
                                if (el) el.textContent = 'error';
                                const curEl = popup.document.getElementById('opt-cur');
                                if (curEl) curEl.textContent = reason;
                            }
                        } catch (_) {}
                        alert(reason);
                    }
                } catch (outerError) {
                    console.warn('⚠️ [Optimize] Outer error:', outerError);
                    _gThis.__cooptOptimizerIsRunning = false;
                    isRunning = false;
                }
            };

            // Expose the starter for the popup
            try {
                (window as any).__cooptStartOptimizationFromPopup = startRun;
            } catch (_) {}

            console.log('[Optimize] Optimization ready. Press Run to start.');

        } catch (e) {
            console.warn('⚠️ [Optimize] Failed:', e);
            alert('Optimize の実行に失敗しました。console を確認してください。');
        } finally {
            try { optimizeBtn.disabled = false; } catch (_) {}
            const _gThis2 = (typeof globalThis !== 'undefined') ? globalThis as any : {} as any;
            console.log('[Optimize] Resetting isRunning flag in finally block');
            _gThis2.__cooptOptimizerIsRunning = false;
        }
    });
}

function setupSuggestOptimizeButtons(): void {
    const btn = document.getElementById('suggest-optimize-btn');
    if (!btn) return;

    btn.addEventListener('click', async () => {
        try {
            const popup = window.open('', 'OptimizationProgress', 'width=900,height=700');
            if (!popup) {
                alert('Popup blocked. Please allow popups for this site.');
                return;
            }

            popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Optimization Progress</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            margin: 0;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        h1 {
            margin: 0 0 20px 0;
            font-size: 24px;
            color: #333;
        }
        .progress-bar {
            width: 100%;
            height: 30px;
            background: #e0e0e0;
            border-radius: 4px;
            overflow: hidden;
            margin-bottom: 20px;
        }
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #4CAF50, #45a049);
            transition: width 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
        }
        .metrics {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 12px;
            margin-bottom: 20px;
        }
        .metric {
            padding: 12px;
            background: #f9f9f9;
            border-radius: 4px;
            border: 1px solid #e0e0e0;
        }
        .metric-label {
            font-size: 12px;
            color: #666;
            margin-bottom: 4px;
        }
        .metric-value {
            font-size: 18px;
            font-weight: bold;
            color: #333;
        }
        .tuning-params {
            margin-top: 20px;
            padding: 15px;
            background: #f0f8ff;
            border-radius: 4px;
        }
        .tuning-params h3 {
            margin: 0 0 12px 0;
            font-size: 16px;
        }
        .param-row {
            display: flex;
            align-items: center;
            margin-bottom: 8px;
        }
        .param-label {
            flex: 0 0 200px;
            font-size: 13px;
        }
        .param-input {
            flex: 1;
            padding: 4px 8px;
            border: 1px solid #ddd;
            border-radius: 4px;
        }
        .button-row {
            display: flex;
            gap: 12px;
            margin-top: 20px;
        }
        .btn {
            flex: 1;
            padding: 12px;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            transition: background 0.2s;
        }
        .btn-start {
            background: #4CAF50;
            color: white;
        }
        .btn-start:hover {
            background: #45a049;
        }
        .btn-start:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .btn-stop {
            background: #f44336;
            color: white;
        }
        .btn-stop:hover {
            background: #da190b;
        }
        .btn-accept {
            background: #2196F3;
            color: white;
        }
        .btn-accept:hover {
            background: #0b7dda;
        }
        .btn-reject {
            background: #ff9800;
            color: white;
        }
        .btn-reject:hover {
            background: #e68900;
        }
        .log {
            margin-top: 20px;
            padding: 12px;
            background: #f5f5f5;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 12px;
        }
        .log-entry {
            margin-bottom: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Optimization Progress</h1>
        <div class="progress-bar">
            <div class="progress-fill" id="progress" style="width: 0%">0%</div>
        </div>
        <div class="metrics">
            <div class="metric">
                <div class="metric-label">Iteration</div>
                <div class="metric-value" id="iteration">0</div>
            </div>
            <div class="metric">
                <div class="metric-label">Merit Function</div>
                <div class="metric-value" id="merit">—</div>
            </div>
            <div class="metric">
                <div class="metric-label">Best Merit</div>
                <div class="metric-value" id="best-merit">—</div>
            </div>
            <div class="metric">
                <div class="metric-label">Accepted</div>
                <div class="metric-value" id="accepted">0</div>
            </div>
            <div class="metric">
                <div class="metric-label">Rejected</div>
                <div class="metric-value" id="rejected">0</div>
            </div>
            <div class="metric">
                <div class="metric-label">Variables</div>
                <div class="metric-value" id="variables">0</div>
            </div>
        </div>
        <div class="tuning-params">
            <h3>Stability Tuning Parameters</h3>
            <div class="param-row">
                <label class="param-label">Step Fraction:</label>
                <input type="number" class="param-input" id="step-fraction" value="0.1" step="0.01" min="0.01" max="1">
            </div>
            <div class="param-row">
                <label class="param-label">Min Step:</label>
                <input type="number" class="param-input" id="min-step" value="1e-6" step="1e-7">
            </div>
            <div class="param-row">
                <label class="param-label">LM Lambda:</label>
                <input type="number" class="param-input" id="lm-lambda" value="0.001" step="0.001">
            </div>
            <div class="param-row">
                <label class="param-label">Max Iterations:</label>
                <input type="number" class="param-input" id="max-iter" value="100" step="10" min="10">
            </div>
            <div class="param-row">
                <label class="param-label">
                    <input type="checkbox" id="auto-render"> Auto-render on Accept
                </label>
            </div>
        </div>
        <div class="button-row">
            <button class="btn btn-start" id="start-btn">Start Optimization</button>
            <button class="btn btn-stop" id="stop-btn" disabled>Stop</button>
            <button class="btn btn-accept" id="accept-btn" disabled>Accept</button>
            <button class="btn btn-reject" id="reject-btn" disabled>Reject</button>
        </div>
        <div class="log" id="log"></div>
    </div>
    <script>
        let isRunning = false;
        let currentBest = null;
        
        function log(message) {
            const logEl = document.getElementById('log');
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            entry.textContent = new Date().toLocaleTimeString() + ': ' + message;
            logEl.appendChild(entry);
            logEl.scrollTop = logEl.scrollHeight;
        }
        
        document.getElementById('start-btn').addEventListener('click', () => {
            if (isRunning) return;
            isRunning = true;
            document.getElementById('start-btn').disabled = true;
            document.getElementById('stop-btn').disabled = false;
            
            const params = {
                stepFraction: parseFloat(document.getElementById('step-fraction').value),
                minStep: parseFloat(document.getElementById('min-step').value),
                lmLambda: parseFloat(document.getElementById('lm-lambda').value),
                maxIter: parseInt(document.getElementById('max-iter').value)
            };
            
            window.opener.postMessage({ action: 'start-optimization', params }, '*');
            log('Optimization started');
        });
        
        document.getElementById('stop-btn').addEventListener('click', () => {
            if (!isRunning) return;
            isRunning = false;
            document.getElementById('start-btn').disabled = false;
            document.getElementById('stop-btn').disabled = true;
            window.opener.postMessage({ action: 'stop-optimization' }, '*');
            log('Stop requested');
        });
        
        document.getElementById('accept-btn').addEventListener('click', () => {
            window.opener.postMessage({ action: 'accept-result' }, '*');
            document.getElementById('accept-btn').disabled = true;
            document.getElementById('reject-btn').disabled = true;
            log('Result accepted');
            
            if (document.getElementById('auto-render').checked) {
                window.opener.postMessage({ action: 'request-render' }, '*');
            }
        });
        
        document.getElementById('reject-btn').addEventListener('click', () => {
            window.opener.postMessage({ action: 'reject-result' }, '*');
            document.getElementById('accept-btn').disabled = true;
            document.getElementById('reject-btn').disabled = true;
            log('Result rejected');
        });
        
        window.addEventListener('message', (e) => {
            if (e.data.type === 'optimization-progress') {
                const data = e.data;
                document.getElementById('progress').style.width = data.progress + '%';
                document.getElementById('progress').textContent = data.progress + '%';
                document.getElementById('iteration').textContent = data.iteration;
                document.getElementById('merit').textContent = data.merit?.toFixed(6) || '—';
                document.getElementById('best-merit').textContent = data.bestMerit?.toFixed(6) || '—';
                document.getElementById('accepted').textContent = data.accepted || 0;
                document.getElementById('rejected').textContent = data.rejected || 0;
                document.getElementById('variables').textContent = data.variables || 0;
            }
            
            if (e.data.type === 'optimization-complete') {
                isRunning = false;
                document.getElementById('start-btn').disabled = false;
                document.getElementById('stop-btn').disabled = true;
                document.getElementById('accept-btn').disabled = false;
                document.getElementById('reject-btn').disabled = false;
                log('Optimization complete');
            }
        });
    </script>
</body>
</html>
            `);
        } catch (err) {
            console.error('❌ Failed to open optimization popup:', err);
        }
    });
}

// Setup New File Button
function setupNewFileButton(): void {
    const btn = document.getElementById('new-file-btn');
    if (!btn) return;

    // Remove existing listener to prevent duplicates
    const newHandler = () => {
        if (!confirm('Create new file? Current data will be cleared.')) return;
        
        try {
            console.log('🔵 [New File] Clearing localStorage and creating default configuration...');
            localStorage.clear();
            
            // Create default configuration using the same structure as table-configuration.ts
            const defaultConfig = {
                id: 1,
                name: 'Config 1',
                schemaVersion: BLOCK_SCHEMA_VERSION,
                blocks: [
                    {
                        blockId: 'ObjectSurface-1',
                        blockType: 'ObjectSurface',
                        role: null,
                        constraints: {},
                        parameters: { objectDistanceMode: 'INF' },
                        variables: {},
                        metadata: { source: 'default' }
                    },
                    {
                        blockId: 'Stop-1',
                        blockType: 'Stop',
                        role: null,
                        constraints: {},
                        parameters: { semiDiameter: 10 },
                        variables: {},
                        metadata: { source: 'default' }
                    },
                    {
                        blockId: 'ImageSurface-1',
                        blockType: 'ImageSurface',
                        role: null,
                        constraints: {},
                        parameters: {},
                        variables: {},
                        metadata: { source: 'default' }
                    }
                ],
                source: [],
                object: [],
                opticalSystem: [],
                systemData: { referenceFocalLength: '' },
                metadata: {
                    created: new Date().toISOString(),
                    modified: new Date().toISOString(),
                    locked: false
                },
                meritFunction: []
            };
            
            const systemConfig = {
                configurations: [defaultConfig],
                activeConfigId: 1,
                meritFunction: [],
                systemRequirements: [],
                optimizationRules: {}
            };
            
            localStorage.setItem('systemConfigurations', JSON.stringify(systemConfig));
            console.log('✅ [New File] Default configuration created, reloading...');
            location.reload();
        } catch (err) {
            console.error('❌ Failed to create new file:', err);
            alert('Failed to create new file. See console for details.');
        }
    };
    
    // Clone and replace to remove all old listeners
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', newHandler);
}

// Setup Save Button
function setupSaveButton(): void {
    const btn = document.getElementById('save-all-btn');
    if (!btn) return;

    const saveHandler = () => {
        try {
            if (document.activeElement) (document.activeElement as HTMLElement).blur();

            // Build export data using the same logic as original JS
            const allData = buildAllDataForExport();

            // Get loaded filename for default
            const loadedFileName = localStorage.getItem('loadedFileName');
            let defaultName = 'optical_system_data';
            
            if (loadedFileName) {
                defaultName = loadedFileName.replace(/\.json$/i, '');
            }

            let filename = prompt(
                "保存するファイル名を入力してください（拡張子 .json は自動で付きます）\n\n" +
                "※ダウンロードフォルダに既存ファイルがある場合はブラウザが自動的に連番を付けます",
                defaultName
            );
            
            if (!filename) return;
            if (!filename.endsWith('.json')) filename += '.json';

            const blob = new Blob([JSON.stringify(allData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            
            // Save filename for next time
            localStorage.setItem('loadedFileName', filename);
            
            console.log('✅ データが保存されました:', filename);
        } catch (err) {
            console.error('❌ Failed to save:', err);
            alert(`Save failed: ${(err as Error)?.message || String(err)}`);
        }
    };
    
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', saveHandler);
}

function getSanitizedConfigurationsForExport(): any {
    const systemConfigurations = localStorage.getItem('systemConfigurations');
    const parsedConfig = systemConfigurations ? JSON.parse(systemConfigurations) : null;
    
    const sanitizedConfig = parsedConfig ? JSON.parse(JSON.stringify(parsedConfig)) : null;
    if (sanitizedConfig) {
        try { delete sanitizedConfig.meritFunction; } catch (_) {}
        try { delete sanitizedConfig.systemRequirements; } catch (_) {}
        try {
            if (Array.isArray(sanitizedConfig.configurations)) {
                for (const cfg of sanitizedConfig.configurations) {
                    if (cfg && typeof cfg === 'object') {
                        try { delete cfg.source; } catch (_) {}
                    }
                }
            }
        } catch (_) {}
    }
    return sanitizedConfig;
}

function buildAllDataForExport(): any {
    const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement;
    const referenceFocalLength = refFLInput ? refFLInput.value : '';

    let opticalSystemData = (window as any).tableOpticalSystem ? (window as any).tableOpticalSystem.getData() : [];
    
    try {
        const systemConfig = (typeof (window as any).loadSystemConfigurations === 'function') 
            ? (window as any).loadSystemConfigurations() 
            : null;
        const activeId = systemConfig?.activeConfigId;
        const activeCfg = Array.isArray(systemConfig?.configurations)
            ? (systemConfig.configurations.find((c: any) => String(c?.id) === String(activeId)) || systemConfig.configurations[0])
            : null;
        
        const configurationHasBlocks = (cfg: any) => {
            try {
                return cfg && Array.isArray(cfg.blocks) && cfg.blocks.length > 0;
            } catch (_) { return false; }
        };
        
        if (activeCfg && configurationHasBlocks(activeCfg)) {
            if (typeof (window as any).expandBlocksToOpticalSystemRows === 'function') {
                const expanded = (window as any).expandBlocksToOpticalSystemRows(activeCfg.blocks);
                if (expanded && Array.isArray(expanded.rows)) {
                    opticalSystemData = expanded.rows;
                }
            }
        }
    } catch (_) {}

    return {
        source: (window as any).tableSource ? (window as any).tableSource.getData() : [],
        object: (window as any).tableObject ? (window as any).tableObject.getData() : [],
        opticalSystem: opticalSystemData,
        meritFunction: (window as any).meritFunctionEditor ? (window as any).meritFunctionEditor.getData() : [],
        systemRequirements: (window as any).systemRequirementsEditor ? (window as any).systemRequirementsEditor.getData() : [],
        systemData: {
            referenceFocalLength: referenceFocalLength
        },
        configurations: getSanitizedConfigurationsForExport()
    };
}

// Setup Load Default System Button
function setupLoadDefaultButton(): void {
    const btn = document.getElementById('load-default-btn');
    if (!btn) return;

    const defaultHandler = async () => {
        if (!confirm('Load default optical system? Current data will be replaced.')) return;
        
        try {
            // Try both paths for development and production
            let response = await fetch('/co-opt/defaults/default-load.json');
            if (!response.ok) {
                response = await fetch('/defaults/default-load.json');
            }
            if (!response.ok) {
                throw new Error(`Failed to load default system: ${response.statusText}`);
            }
            const data = await response.json();
            
            await __loadAllDataObjectIntoApp(data, { filename: 'default-load.json' });
            console.log('✅ Default optical system loaded successfully');
        } catch (err) {
            console.error('❌ Failed to load default system:', err);
            alert('Failed to load default optical system. Check console for details.');
        }
    };
    
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', defaultHandler);
}

// Setup Share URL Button
function setupShareUrlButton(): void {
    const btn = document.getElementById('share-url-btn');
    if (!btn) return;

    const WARN_LEN = 2000;
    const MAX_LEN = 30000;

    const shareHandler = async () => {
        try {
            if (document.activeElement) (document.activeElement as HTMLElement).blur();

            let compressed: string;
            try {
                const allData = buildAllDataForExport();
                compressed = encodeAllDataToCompressedString(allData);
            } catch (e) {
                console.warn('❌ [Share] Failed to encode:', e);
                alert((e as Error)?.message || 'Failed to generate share URL');
                return;
            }

            const base = `${location.origin}${location.pathname}`;
            let url: string;
            try {
                url = buildShareUrlFromCompressedString(compressed, base);
            } catch (e) {
                console.warn('❌ [Share] Failed to build URL:', e);
                alert((e as Error)?.message || 'Failed to generate share URL');
                return;
            }

            const len = url.length;
            if (len > MAX_LEN) {
                alert(`Share URL is too long (${len} chars). Please use Save instead.`);
                return;
            }
            if (len >= WARN_LEN) {
                const ok = confirm(`Share URL is long (${len} chars) and may not work in some apps.\n\nContinue?`);
                if (!ok) return;
            }

            try {
                await navigator.clipboard.writeText(url);
                alert('Share URL copied to clipboard.');
            } catch (e) {
                // Fallback: let user copy manually
                prompt('Copy this URL:', url);
            }
        } catch (err) {
            console.error('❌ Failed to share:', err);
            alert(`Share failed: ${(err as Error)?.message || String(err)}`);
        }
    };
    
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', shareHandler);
}

// Setup Clear Storage Button
function setupClearStorageButton(): void {
    const attachModal = () => {
        const existing = document.getElementById('clear-storage-modal');
        if (existing && existing.parentElement) existing.parentElement.removeChild(existing);

        const modal = document.createElement('div');
        modal.id = 'clear-storage-modal';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100%';
        modal.style.height = '100%';
        modal.style.background = 'rgba(0,0,0,0.5)';
        modal.style.display = 'flex';
        modal.style.alignItems = 'center';
        modal.style.justifyContent = 'center';
        modal.style.zIndex = '10000';
        modal.style.pointerEvents = 'auto';

        const dialog = document.createElement('div');
        dialog.style.background = 'white';
        dialog.style.padding = '24px';
        dialog.style.borderRadius = '8px';
        dialog.style.maxWidth = '400px';
        dialog.innerHTML = `
            <h2 style="margin: 0 0 16px 0;">Clear Chashe</h2>
            <p>This will delete all saved data. Continue?</p>
            <div style="display: flex; gap: 12px; margin-top: 20px;">
                <button id="confirm-clear" style="flex: 1; padding: 10px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer;">Clear</button>
                <button id="cancel-clear" style="flex: 1; padding: 10px; background: #ccc; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
            </div>
        `;

        modal.appendChild(dialog);
        document.body.appendChild(modal);

        const confirmBtn = document.getElementById('confirm-clear');
        const cancelBtn = document.getElementById('cancel-clear');

        confirmBtn?.addEventListener('click', () => {
            localStorage.clear();
            location.reload();
        });

        cancelBtn?.addEventListener('click', () => {
            document.body.removeChild(modal);
        });
    };

    const btn = document.getElementById('clear-storage-btn');
    if (btn) {
        if ((btn as any).dataset && (btn as any).dataset.clearStorageBound === '1') return;
        if ((btn as any).dataset) (btn as any).dataset.clearStorageBound = '1';
        btn.addEventListener('click', attachModal);
        return;
    }

    if ((document.body as any).dataset && (document.body as any).dataset.clearStorageDelegated === '1') return;
    if ((document.body as any).dataset) (document.body as any).dataset.clearStorageDelegated = '1';
    document.addEventListener('click', (evt) => {
        const target = evt.target as HTMLElement | null;
        if (!target) return;
        const trigger = target.closest('#clear-storage-btn');
        if (trigger) attachModal();
    });
}

// Setup Analysis Buttons
function setupParaxialButton(): void {
    const btn = document.getElementById('calculate-paraxial-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        console.log('📐 近軸計算ボタンがクリックされました');
        try {
            if (typeof (window as any).outputParaxialDataToDebug === 'function') {
                const tableOpticalSystem = (window as any).tableOpticalSystem;
                (window as any).outputParaxialDataToDebug(tableOpticalSystem);
                console.log('✅ 近軸計算が完了しました');
            } else {
                console.error('❌ outputParaxialDataToDebug関数が見つかりません');
            }
        } catch (error) {
            console.error('❌ 近軸計算ボタンエラー:', error);
        }
    });
}

function setupSeidelButton(): void {
    const btn = document.getElementById('calculate-seidel-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        console.log('🔬 Seidel係数計算ボタンがクリックされました');
        try {
            if (typeof (window as any).outputSeidelCoefficientsToDebug === 'function') {
                (window as any).outputSeidelCoefficientsToDebug();
                console.log('✅ Seidel係数計算が完了しました');
            } else {
                console.error('❌ outputSeidelCoefficientsToDebug関数が見つかりません');
            }
        } catch (error) {
            console.error('❌ Seidel係数計算ボタンエラー:', error);
        }
    });
}

function setupSeidelAfocalButton(): void {
    const btn = document.getElementById('calculate-seidel-afocal-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        console.log('🔬 Seidel係数計算（アフォーカル）ボタンがクリックされました');
        try {
            const { calculateAfocalSeidelCoefficientsIntegrated } = await import('../evaluation/aberrations/seidel-coefficients-afocal.js');
            const { formatSeidelCoefficients } = await import('../evaluation/aberrations/seidel-coefficients.js');

            const opticalSystemRows = (window as any).getOpticalSystemRows ? (window as any).getOpticalSystemRows() : [];
            const objectRows = (window as any).getObjectTableRows ? (window as any).getObjectTableRows() : [];
            const sourceRows = (window as any).getSourceTableRows ? (window as any).getSourceTableRows() : [];

            if (opticalSystemRows.length === 0) {
                console.error('❌ Optical system data is empty');
                alert('光学系データがありません。');
                return;
            }

            const wavelength = sourceRows.length > 0 && sourceRows[0].wavelength
                ? parseFloat(sourceRows[0].wavelength)
                : 0.5876;

            let stopIndex = opticalSystemRows.findIndex((row: any) =>
                row['object type'] === 'Stop' || row.object === 'Stop'
            );

            if (stopIndex === -1) {
                console.warn('⚠️ Stop surface not found, using surface 1');
                stopIndex = 1;
            }

            const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement | null;
            let referenceFocalLength: number | undefined = undefined;

            if (refFLInput) {
                const raw = refFLInput.value.trim();
                if (raw !== '' && raw.toLowerCase() !== 'auto') {
                    const parsed = parseFloat(raw);
                    referenceFocalLength = isFinite(parsed) ? parsed : undefined;
                }
            }

            const result = calculateAfocalSeidelCoefficientsIntegrated(
                opticalSystemRows,
                wavelength,
                stopIndex,
                objectRows,
                referenceFocalLength
            );

            if (!result) {
                console.error('❌ Afocal Seidel coefficients calculation failed');
                alert('アフォーカル系収差係数の計算に失敗しました。');
                return;
            }

            const systemDataTextarea = document.getElementById('system-data') as HTMLTextAreaElement | null;
            if (systemDataTextarea) {
                systemDataTextarea.value = formatSeidelCoefficients(result);
                console.log('✅ アフォーカル系Seidel係数計算が完了しました');

                if (typeof (window as any).renderBlockContributionSummaryFromSeidel === 'function') {
                    try {
                        (window as any).renderBlockContributionSummaryFromSeidel(result, opticalSystemRows);
                    } catch (e) {
                        console.warn('⚠️ Block contribution summary render failed (afocal):', e);
                    }
                }
            } else {
                console.error('❌ System Data textarea not found');
            }
        } catch (error: any) {
            console.error('❌ アフォーカル系Seidel係数計算ボタンエラー:', error);
            alert(`エラーが発生しました: ${error.message}`);
        }
    });
}

function setupCoordinateTransformButton(): void {
    const btn = document.getElementById('coord-transform-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        console.log('🔄 座標変換ボタンがクリックされました');
        try {
            if (typeof (window as any).displayCoordinateTransformMatrix === 'function') {
                (window as any).displayCoordinateTransformMatrix();
                console.log('✅ 座標変換表示が完了しました');
            } else {
                console.error('❌ displayCoordinateTransformMatrix関数が見つかりません');
            }
        } catch (error) {
            console.error('❌ 座標変換ボタンエラー:', error);
        }
    });
}

function setupSpotDiagramButton(): void {
    const btn = document.getElementById('spot-diagram-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof (window as any).showSpotDiagram === 'function') {
            (window as any).showSpotDiagram();
        }
    });
}

function setupLongitudinalAberrationButton(): void {
    const btn = document.getElementById('longitudinal-aberration-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof (window as any).showLongitudinalAberration === 'function') {
            (window as any).showLongitudinalAberration();
        }
    });
}

function setupTransverseAberrationButton(): void {
    const btn = document.getElementById('transverse-aberration-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof (window as any).showTransverseAberration === 'function') {
            (window as any).showTransverseAberration();
        }
    });
}

function setupDistortionButton(): void {
    const btn = document.getElementById('distortion-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof (window as any).showDistortion === 'function') {
            (window as any).showDistortion();
        }
    });
}

function setupIntegratedAberrationButton(): void {
    const btn = document.getElementById('integrated-aberration-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof (window as any).showIntegratedAberration === 'function') {
            (window as any).showIntegratedAberration();
        }
    });
}

function setupAstigmatismButton(): void {
    const btn = document.getElementById('astigmatism-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof (window as any).showAstigmatism === 'function') {
            (window as any).showAstigmatism();
        }
    });
}

// PSF Calculation
async function handlePSFCalculation(debugMode: boolean = false): Promise<void> {
    try {
        const tbl = (window as any).tableOpticalSystem || (globalThis as any).tableOpticalSystem;
        const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
        if (!Array.isArray(rows) || rows.length < 2) {
            alert('Optical system data not available');
            return;
        }

        const objectRows = ((window as any).tableObject && typeof (window as any).tableObject.getData === 'function')
            ? (window as any).tableObject.getData()
            : [];

        const selectedObjectKey = String((document.getElementById('psf-object-select') as HTMLSelectElement)?.value ?? '0');
        const objectIndex = Number(selectedObjectKey);

        const primaryWavelength = (typeof (window as any).getPrimaryWavelength === 'function')
            ? (Number((window as any).getPrimaryWavelength()) || 0.5876)
            : 0.5876;

        const gridSize = 128;
        const zeroPadding = 'auto';
        const opdDisplayMode = 'pistonTiltRemoved';

        if (typeof (window as any).getPSFCalculatorSingleton === 'function') {
            const calculator = await (window as any).getPSFCalculatorSingleton();
            const result = await calculator.calculatePSF(rows, objectRows, objectIndex, primaryWavelength, {
                gridSize,
                zeroPadding,
                opdDisplayMode,
                debugMode
            });

            if (typeof (window as any).displayPSFResult === 'function') {
                (window as any).displayPSFResult(result);
            }
        }
    } catch (err) {
        console.error('❌ PSF calculation failed:', err);
        alert(`PSF calculation failed: ${(err as Error)?.message || String(err)}`);
    }
}

// PSF Display Settings
function setupPSFDisplaySettings(): void {
    const logScaleCheckbox = document.getElementById('psf-log-scale') as HTMLInputElement;
    const contoursCheckbox = document.getElementById('psf-contours') as HTMLInputElement;
    const characteristicsCheckbox = document.getElementById('psf-characteristics') as HTMLInputElement;

    logScaleCheckbox?.addEventListener('change', () => {
        if (typeof (window as any).updatePSFDisplay === 'function') {
            (window as any).updatePSFDisplay();
        }
    });

    contoursCheckbox?.addEventListener('change', () => {
        if (typeof (window as any).updatePSFDisplay === 'function') {
            (window as any).updatePSFDisplay();
        }
    });

    characteristicsCheckbox?.addEventListener('change', () => {
        if (typeof (window as any).updatePSFDisplay === 'function') {
            (window as any).updatePSFDisplay();
        }
    });
}

// PSF Display Mode Buttons
function setupPSFDisplayModeButtons(): void {
    const buttons = [
        { id: 'psf-2d-btn', mode: '2d' },
        { id: 'psf-3d-btn', mode: '3d' },
        { id: 'psf-profile-btn', mode: 'profile' },
        { id: 'psf-energy-btn', mode: 'energy' },
        { id: 'psf-wavefront-btn', mode: 'wavefront' }
    ];

    buttons.forEach(({ id, mode }) => {
        const btn = document.getElementById(id);
        if (!btn) return;

        btn.addEventListener('click', () => {
            buttons.forEach(({ id: otherId }) => {
                const otherBtn = document.getElementById(otherId);
                otherBtn?.classList.remove('active');
            });
            btn.classList.add('active');

            if (typeof (window as any).switchPSFDisplayMode === 'function') {
                (window as any).switchPSFDisplayMode(mode);
            }
        });
    });
}

// MTF Diagram
async function showMTFDiagram(options: {
    wavelengthMicrons?: number | 'all';
    objectIndex?: number;
    maxFrequencyLpmm?: number;
    samplingSize?: number;
} = {}): Promise<void> {
    try {
        const tbl = (window as any).tableOpticalSystem || (globalThis as any).tableOpticalSystem;
        const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
        if (!Array.isArray(rows) || rows.length < 2) {
            alert('Optical system data not available');
            return;
        }

        const wavelengthMicrons = options.wavelengthMicrons ?? 'all';
        const objectIndex = options.objectIndex ?? 0;
        const maxFrequencyLpmm = options.maxFrequencyLpmm ?? 100;
        const samplingSize = options.samplingSize ?? 128;

        if (typeof (window as any).calculateMTF === 'function') {
            const result = await (window as any).calculateMTF(rows, {
                wavelengthMicrons,
                objectIndex,
                maxFrequencyLpmm,
                samplingSize
            });

            if (typeof (window as any).displayMTFResult === 'function') {
                (window as any).displayMTFResult(result);
            }
        }
    } catch (err) {
        console.error('❌ MTF calculation failed:', err);
        alert(`MTF calculation failed: ${(err as Error)?.message || String(err)}`);
    }
}

// Configuration Management
const STORAGE_KEY = "systemConfigurations";

function createDefaultConfiguration(id: number, name: string): any {
    const defaultBlocks = [
        {
            blockId: 'ObjectSurface-1',
            blockType: 'ObjectSurface',
            role: null,
            constraints: {},
            parameters: {
                objectDistanceMode: 'INF'
            },
            variables: {},
            metadata: { source: 'default' }
        },
        {
            blockId: 'Stop-1',
            blockType: 'Stop',
            role: null,
            constraints: {},
            parameters: {
                semiDiameter: DEFAULT_STOP_SEMI_DIAMETER
            },
            variables: {},
            metadata: { source: 'default' }
        },
        {
            blockId: 'ImageSurface-1',
            blockType: 'ImageSurface',
            role: null,
            constraints: {},
            parameters: undefined,
            variables: {},
            metadata: { source: 'default' }
        }
    ];

    return {
        id: id,
        name: name,
        schemaVersion: BLOCK_SCHEMA_VERSION,
        blocks: defaultBlocks,
        source: [],
        object: [],
        opticalSystem: [],
        meritFunction: [],
        metadata: {
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            optimizationTarget: null,
            locked: false
        }
    };
}

const defaultSystemConfig = {
    configurations: [
        createDefaultConfiguration(1, "Config 1")
    ],
    activeConfigId: 1,
    optimizationRules: {}
};

export function loadSystemConfigurations(): any {
    const json = localStorage.getItem(STORAGE_KEY);
    
    if (json) {
        try {
            const parsed = JSON.parse(json);
            return parsed;
        } catch (e) {
            console.warn('⚠️ [Configuration] Parse error:', e);
        }
    }
    
    console.log('🔵 [Configuration] Using default system config');
    return defaultSystemConfig;
}

export function saveSystemConfigurations(systemConfig: any): void {
    if (systemConfig && systemConfig.configurations) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(systemConfig));
    } else {
        console.warn('⚠️ [Configuration] Invalid system config, not saving:', systemConfig);
    }
}

export function getActiveConfiguration(): any {
    const systemConfig = loadSystemConfigurations();
    const activeConfig = systemConfig.configurations.find((c: any) => c.id === systemConfig.activeConfigId);
    
    if (!activeConfig) {
        console.warn('⚠️ [Configuration] Active config not found, using first');
        return systemConfig.configurations[0];
    }
    
    return activeConfig;
}

export function getActiveConfigId(): number {
    const systemConfig = loadSystemConfigurations();
    return systemConfig.activeConfigId;
}

export function setActiveConfiguration(configId: number): boolean {
    const systemConfig = loadSystemConfigurations();
    const config = systemConfig.configurations.find((c: any) => c.id === configId);
    
    if (!config) {
        console.error('❌ [Configuration] Config not found:', configId);
        return false;
    }
    
    systemConfig.activeConfigId = configId;
    saveSystemConfigurations(systemConfig);
    console.log(`✅ [Configuration] Active config changed to: ${config.name}`);
    return true;
}

export function saveCurrentToActiveConfiguration(): void {
    console.log('🔵 [Configuration] Saving current table data to active configuration...');
    
    const systemConfig = loadSystemConfigurations();
    const activeConfig = systemConfig.configurations.find((c: any) => c.id === systemConfig.activeConfigId);
    
    if (!activeConfig) {
        console.error('❌ [Configuration] Active config not found');
        return;
    }
    
    try {
        const globalSource = (window as any).tableSource ? (window as any).tableSource.getData() : [];
        localStorage.setItem('sourceTableData', JSON.stringify(globalSource));
    } catch (_) {}
    
    activeConfig.object = (window as any).tableObject ? (window as any).tableObject.getData() : [];
    activeConfig.opticalSystem = (window as any).tableOpticalSystem ? (window as any).tableOpticalSystem.getData() : [];
    activeConfig.meritFunction = (window as any).meritFunctionEditor ? (window as any).meritFunctionEditor.getData() : [];
    
    activeConfig.metadata.modified = new Date().toISOString();
    
    if (!activeConfig.metadata.designer) {
        activeConfig.metadata.designer = {
            type: "human",
            name: "user",
            confidence: null
        };
    }
    
    saveSystemConfigurations(systemConfig);
    console.log(`✅ [Configuration] Saved to: ${activeConfig.name}`);
}

export function loadActiveConfigurationToTables(): void {
    console.log('🔵 [Configuration] Loading active configuration to tables...');
    
    const activeConfig = getActiveConfiguration();
    
    if (!activeConfig) {
        console.error('❌ [Configuration] No active config found');
        return;
    }
    
    try {
        const hasGlobal = !!localStorage.getItem('sourceTableData');
        const legacy = Array.isArray(activeConfig.source) ? activeConfig.source : null;
        if (!hasGlobal && legacy && legacy.length > 0) {
            localStorage.setItem('sourceTableData', JSON.stringify(legacy));
        }
    } catch (_) {}
    
    if (activeConfig.object) {
        localStorage.setItem('objectTableData', JSON.stringify(activeConfig.object));
    }
    if (activeConfig.opticalSystem) {
        localStorage.setItem('OpticalSystemTableData', JSON.stringify(activeConfig.opticalSystem));
    }
    if (activeConfig.meritFunction) {
        localStorage.setItem('meritFunctionData', JSON.stringify(activeConfig.meritFunction));
    }
    
    console.log(`✅ [Configuration] Loaded: ${activeConfig.name}`);
}

export function addConfiguration(name: string): number {
    const systemConfig = loadSystemConfigurations();
    
    const maxId = Math.max(...systemConfig.configurations.map((c: any) => c.id), 0);
    const newId = maxId + 1;
    
    const newConfig = createDefaultConfiguration(newId, name);
    
    const activeConfig = getActiveConfiguration();
    if (activeConfig) {
        newConfig.object = JSON.parse(JSON.stringify(activeConfig.object));
        newConfig.opticalSystem = JSON.parse(JSON.stringify(activeConfig.opticalSystem));
        newConfig.meritFunction = JSON.parse(JSON.stringify(activeConfig.meritFunction));
    }
    
    systemConfig.configurations.push(newConfig);
    saveSystemConfigurations(systemConfig);
    
    console.log(`✅ [Configuration] Added new configuration: ${name} (ID: ${newId})`);
    return newId;
}

export function deleteConfiguration(configId: number): boolean {
    const systemConfig = loadSystemConfigurations();
    
    if (systemConfig.configurations.length <= 1) {
        console.warn('⚠️ [Configuration] Cannot delete last configuration');
        return false;
    }
    
    const index = systemConfig.configurations.findIndex((c: any) => c.id === configId);
    
    if (index === -1) {
        console.error('❌ [Configuration] Config not found:', configId);
        return false;
    }
    
    const configName = systemConfig.configurations[index].name;
    systemConfig.configurations.splice(index, 1);
    
    if (systemConfig.activeConfigId === configId) {
        systemConfig.activeConfigId = systemConfig.configurations[0].id;
        console.log(`🔄 [Configuration] Active config changed to: ${systemConfig.configurations[0].name}`);
    }
    
    saveSystemConfigurations(systemConfig);
    console.log(`✅ [Configuration] Deleted configuration: ${configName}`);
    return true;
}

export function duplicateConfiguration(configId: number): number | null {
    const systemConfig = loadSystemConfigurations();
    const sourceConfig = systemConfig.configurations.find((c: any) => c.id === configId);
    
    if (!sourceConfig) {
        console.error('❌ [Configuration] Config not found:', configId);
        return null;
    }
    
    const maxId = Math.max(...systemConfig.configurations.map((c: any) => c.id), 0);
    const newId = maxId + 1;
    
    const newConfig = JSON.parse(JSON.stringify(sourceConfig));
    newConfig.id = newId;
    newConfig.name = `${sourceConfig.name} (Copy)`;
    newConfig.metadata.created = new Date().toISOString();
    newConfig.metadata.modified = new Date().toISOString();
    
    systemConfig.configurations.push(newConfig);
    saveSystemConfigurations(systemConfig);
    
    console.log(`✅ [Configuration] Duplicated configuration: ${newConfig.name} (ID: ${newId})`);
    return newId;
}

export function renameConfiguration(configId: number, newName: string): boolean {
    const systemConfig = loadSystemConfigurations();
    const config = systemConfig.configurations.find((c: any) => c.id === configId);
    
    if (!config) {
        console.error('❌ [Configuration] Config not found:', configId);
        return false;
    }
    
    const oldName = config.name;
    config.name = newName;
    config.metadata.modified = new Date().toISOString();
    
    saveSystemConfigurations(systemConfig);
    console.log(`✅ [Configuration] Renamed: ${oldName} → ${newName}`);
    return true;
}

export function getConfigurationList(): any[] {
    const systemConfig = loadSystemConfigurations();
    return systemConfig.configurations.map((c: any) => ({
        id: c.id,
        name: c.name,
        active: c.id === systemConfig.activeConfigId,
        created: c.metadata.created,
        modified: c.metadata.modified,
        locked: c.metadata.locked
    }));
}

// Global exports
if (typeof window !== 'undefined') {
    const prev = (window as any).ConfigurationManager;
    const base = (prev && typeof prev === 'object') ? prev : {};
    (window as any).ConfigurationManager = {
        ...base,
        loadSystemConfigurations: base.loadSystemConfigurations || loadSystemConfigurations,
        saveSystemConfigurations: base.saveSystemConfigurations || saveSystemConfigurations,
        getActiveConfiguration: base.getActiveConfiguration || getActiveConfiguration,
        getActiveConfigId: base.getActiveConfigId || getActiveConfigId,
        setActiveConfiguration: base.setActiveConfiguration || setActiveConfiguration,
        saveCurrentToActiveConfiguration: base.saveCurrentToActiveConfiguration || saveCurrentToActiveConfiguration,
        loadActiveConfigurationToTables: base.loadActiveConfigurationToTables || loadActiveConfigurationToTables,
        addConfiguration: base.addConfiguration || addConfiguration,
        deleteConfiguration: base.deleteConfiguration || deleteConfiguration,
        duplicateConfiguration: base.duplicateConfiguration || duplicateConfiguration,
        renameConfiguration: base.renameConfiguration || renameConfiguration,
        getConfigurationList: base.getConfigurationList || getConfigurationList,
    };
}

// Block Inspector and Design Intent Management
let __blockInspectorExpandedBlockId: string | null = null;
const __blockInspectorPreferredMaterialKeyByBlockId = new Map<string, string>();
let __blocks_lastScopeErrors: any[] = [];

function __blocks_shouldMarkVar(v: any): boolean {
    if (!v || typeof v !== 'object') return false;
    const mode = v?.optimize?.mode;
    return mode === 'V' || mode === true;
}

function __blocks_getVarScope(v: any): string {
    try {
        const s = String(v?.optimize?.scope ?? '').trim();
        if (s === 'global' || s === 'shared') return 'global';
        if (s === 'perConfig' || s === 'local' || s === 'per-config') return 'perConfig';
    } catch (_) {}
    return 'perConfig';
}

function __blocks_setVarScope(blockId: string, key: string, scope: string): void {
    try {
        const systemConfig = loadSystemConfigurations();
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) return;

        const activeId = systemConfig.activeConfigId;
        const cfgIdx = systemConfig.configurations.findIndex((c: any) => c && c.id === activeId);
        if (cfgIdx < 0) return;

        const activeCfg = systemConfig.configurations[cfgIdx];
        if (!activeCfg || !Array.isArray(activeCfg.blocks)) return;

        const b = activeCfg.blocks.find((x: any) => x && String(x.blockId ?? '') === String(blockId));
        if (!b) return;

        if (!b.variables || typeof b.variables !== 'object') b.variables = {};
        if (!b.variables[key] || typeof b.variables[key] !== 'object') b.variables[key] = { value: b.parameters?.[key] ?? '' };
        if (!b.variables[key].optimize || typeof b.variables[key].optimize !== 'object') b.variables[key].optimize = {};
        b.variables[key].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';

        try {
            saveSystemConfigurations(systemConfig);
        } catch (_) {}
    } catch (_) {}
}

function __blocks_setVarMode(blockId: string, key: string, enabled: boolean, scope: string = 'perConfig'): void {
    try {
        const systemConfig = loadSystemConfigurations();
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) return;

        const missing: Array<{configId: string, configName?: string}> = [];

        const activeId = systemConfig.activeConfigId;
        const targets = (scope === 'global')
            ? (systemConfig.configurations || [])
            : [systemConfig.configurations.find((c: any) => c && c.id === activeId) || systemConfig.configurations[0]];

        // If making a variable global/shared, prefer syncing numeric parameter values across configs
        let sharedNumericValue: number | null = null;
        if (enabled && scope === 'global') {
            try {
                const activeCfg0 = systemConfig.configurations.find((c: any) => c && c.id === activeId);
                const b0 = activeCfg0 && Array.isArray(activeCfg0.blocks)
                    ? activeCfg0.blocks.find((x: any) => x && String(x.blockId ?? '') === String(blockId))
                    : null;
                const raw0 = b0?.parameters?.[key] ?? b0?.variables?.[key]?.value;
                const n0 = (typeof raw0 === 'number') ? raw0 : Number(String(raw0 ?? '').trim());
                if (Number.isFinite(n0)) sharedNumericValue = n0;
            } catch (_) {}
        }

        for (const cfg of targets) {
            if (!cfg || !Array.isArray(cfg.blocks)) {
                missing.push({ configId: String(cfg?.id ?? '(none)'), configName: cfg?.name });
                continue;
            }
            const b = cfg.blocks.find((x: any) => x && String(x.blockId ?? '') === String(blockId));
            if (!b) {
                missing.push({ configId: String(cfg?.id ?? '(none)'), configName: cfg?.name });
                continue;
            }

            if (!b.variables || typeof b.variables !== 'object') b.variables = {};
            if (!b.variables[key] || typeof b.variables[key] !== 'object') b.variables[key] = { value: b.parameters?.[key] ?? '' };
            if (!b.variables[key].optimize || typeof b.variables[key].optimize !== 'object') b.variables[key].optimize = {};
            b.variables[key].optimize.mode = enabled ? 'V' : 'F';
            b.variables[key].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';

            // Sync numeric value when switching to global.
            if (sharedNumericValue !== null && scope === 'global') {
                try {
                    if (!b.parameters || typeof b.parameters !== 'object') b.parameters = {};
                    b.parameters[key] = sharedNumericValue;
                    if (b.variables[key] && typeof b.variables[key] === 'object' && Object.prototype.hasOwnProperty.call(b.variables[key], 'value')) {
                        b.variables[key].value = sharedNumericValue;
                    }
                } catch (_) {}
            }
        }

        __blocks_lastScopeErrors = missing.length > 0
            ? [{
                blockId: String(blockId),
                key: String(key),
                scope: String(scope),
                missing
            }]
            : [];

        try {
            saveSystemConfigurations(systemConfig);
        } catch (_) {}
    } catch (_) {}
}

function formatBlockPreview(block: any): string {
    const b = block && typeof block === 'object' ? block : null;
    if (!b) return '';

    const pick = (key: string): any => {
        const pObj = (b.parameters && typeof b.parameters === 'object') ? b.parameters : null;
        const fromParam = pObj ? pObj[key] : undefined;
        if (fromParam !== undefined && fromParam !== null && String(fromParam).trim() !== '') return fromParam;
        const vObj = (b.variables && typeof b.variables === 'object') ? b.variables : null;
        const fromVar = vObj && vObj[key] && typeof vObj[key] === 'object' ? vObj[key].value : undefined;
        if (fromVar !== undefined && fromVar !== null && String(fromVar).trim() !== '') return fromVar;
        return '';
    };

    const type = String(b.blockType ?? '');
    
    if (type === 'Lens' || type === 'PositiveLens') {
        const r1 = pick('frontRadius');
        const r2 = pick('backRadius');
        const ct = pick('centerThickness');
        const mat = pick('material');
        const parts = [];
        if (String(r1) !== '') parts.push(`R1=${String(r1)}`);
        if (String(r2) !== '') parts.push(`R2=${String(r2)}`);
        if (String(ct) !== '') parts.push(`CT=${String(ct)}`);
        if (String(mat) !== '') parts.push(`G=${String(mat)}`);
        return parts.join(' ');
    }

    if (type === 'Gap' || type === 'AirGap') {
        const th = pick('thickness');
        const mat = pick('material');
        const parts = [];
        if (String(th) !== '') parts.push(`T=${String(th)}`);
        if (String(mat) !== '' && String(mat).trim().toUpperCase() !== 'AIR') parts.push(`M=${String(mat)}`);
        return parts.join(' ');
    }

    if (type === 'Stop') {
        const sd = pick('semiDiameter');
        return String(sd) !== '' ? `SD=${String(sd)}` : '';
    }

    return '';
}

function cooptSetNestedValue(obj: any, path: string, value: any): void {
    if (!obj || typeof obj !== 'object') return;
    const parts = String(path || '').split('.').filter(Boolean);
    if (parts.length === 0) return;
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (!current[key] || typeof current[key] !== 'object') current[key] = {};
        current = current[key];
    }
    const lastKey = parts[parts.length - 1];
    current[lastKey] = value;
}

function cooptNormalizeInputValue(raw: string, original: any): any {
    const trimmed = String(raw ?? '').trim();
    if (trimmed === '') return '';
    if (/^[-+]?((\d+\.\d*)|(\d*\.\d+)|(\d+))(e[-+]?\d+)?$/i.test(trimmed)) {
        return Number(trimmed);
    }
    if (typeof original === 'boolean') return trimmed.toLowerCase() === 'true';
    return trimmed;
}

function cooptApplyBlockValue(blockId: string, path: string, oldValue: any, newValue: any): void {
    const systemConfig = loadSystemConfigurations();
    const activeConfig = systemConfig?.configurations?.find((c: any) => c.id === systemConfig?.activeConfigId)
        || systemConfig?.configurations?.[0];
    if (!activeConfig) return;
    const blocks = Array.isArray(activeConfig.blocks) ? activeConfig.blocks : [];
    const block = blocks.find((b: any) => b && String(b.blockId ?? '') === String(blockId));
    if (!block) return;

    if (oldValue !== newValue) {
        try {
            if ((window as any).undoHistory && (window as any).SetBlockParameterCommand && !(window as any).undoHistory.isExecuting) {
                const cmd = new (window as any).SetBlockParameterCommand(activeConfig.name, String(blockId), String(path), oldValue, newValue);
                (window as any).undoHistory.record(cmd);
            }
        } catch (_) {}
    }

    cooptSetNestedValue(block, path, newValue);
    try {
        if (activeConfig.metadata) activeConfig.metadata.modified = new Date().toISOString();
    } catch (_) {}
    try { saveSystemConfigurations(systemConfig); } catch (_) {}
    try { refreshBlockInspector(); } catch (_) {}
    try { if (typeof (window as any).loadActiveConfigurationToTables === 'function') (window as any).loadActiveConfigurationToTables(); } catch (_) {}
}

function renderBlockInspector(summary: any[], groups: any, blockById: Map<string, any> | null = null, blocksInOrder: any[] | null = null): void {
    const container = document.getElementById('block-inspector');
    if (!container) return;

    container.innerHTML = '';

    // Show error banner if scope errors exist
    try {
        if (Array.isArray((globalThis as any).__blocks_lastScopeErrors) && (globalThis as any).__blocks_lastScopeErrors.length > 0) {
            const e0 = (globalThis as any).__blocks_lastScopeErrors[0];
            const miss = Array.isArray(e0?.missing) ? e0.missing : [];
            const names = miss.slice(0, 6).map((m: any) => m?.configName ? `${String(m.configName)}(${String(m.configId)})` : String(m?.configId ?? '')).filter(Boolean);
            const banner = document.createElement('div');
            banner.style.padding = '8px 10px';
            banner.style.margin = '6px 0 10px 0';
            banner.style.border = '1px solid #f2c2c2';
            banner.style.background = '#fff5f5';
            banner.style.color = '#8a1f1f';
            banner.style.borderRadius = '6px';
            banner.style.fontSize = '12px';
            banner.textContent = `ERROR: Cannot apply "Shared (all configs)" because this Block is missing in some configurations: ${String(e0?.blockId ?? '')}.${String(e0?.key ?? '')} / missing in ${miss.length} config(s): ${names.join(', ')}${miss.length > names.length ? ', ...' : ''}`;
            container.appendChild(banner);
        }
    } catch (_) {}

    const list = Array.isArray(summary) ? summary : [];
    if (list.length === 0) {
        const empty = document.createElement('div');
        empty.style.padding = '8px';
        empty.style.fontSize = '13px';
        empty.style.color = '#666';
        empty.textContent = 'No blocks (or no provenance).';
        container.appendChild(empty);
        return;
    }

    // Compute per-block surface index ranges
    const surfRangeByBlockId = new Map<string, {min:number, max:number}>();
    try {
        if (Array.isArray(blocksInOrder) && blocksInOrder.length > 0 && typeof (window as any).expandBlocksToOpticalSystemRows === 'function') {
            const exp = (window as any).expandBlocksToOpticalSystemRows(blocksInOrder);
            const rows = exp && Array.isArray(exp.rows) ? exp.rows : [];
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                const bid = String(r?._blockId ?? '').trim();
                if (!bid) continue;
                const rowBlockType = String(r?._blockType ?? '').trim();
                if (rowBlockType === 'Gap' || rowBlockType === 'CoordTrans') continue;
                const surfNo = i;
                const prev = surfRangeByBlockId.get(bid);
                if (!prev) surfRangeByBlockId.set(bid, { min: surfNo, max: surfNo });
                else {
                    if (surfNo < prev.min) prev.min = surfNo;
                    if (surfNo > prev.max) prev.max = surfNo;
                }
            }
        }
    } catch (_) {}

    const formatSingletonBlockLabel = (blockType: string, blockIdRaw: string) => {
        const t = String(blockType ?? '').trim();
        const id = String(blockIdRaw ?? '').trim();
        if (t === 'ObjectSurface' || t === 'ObjectPlane' || t === 'ImageSurface') {
            return (t === 'ObjectPlane') ? 'ObjectSurface' : t;
        }
        const mPlane = /^ObjectPlane-(\d+)$/i.exec(id);
        if (mPlane) return 'ObjectSurface';
        const m = /^(ObjectSurface|ImageSurface)-(\d+)$/i.exec(id);
        if (m) return m[1];
        return id || '(none)';
    };

    // UI display label mapping with auto-numbering
    const displayLabelByBlockId = new Map<string, string>();
    try {
        const counts = new Map<string, number>();
        const blocks = Array.isArray(blocksInOrder) ? blocksInOrder : [];
        for (const bb of blocks) {
            if (!bb || typeof bb !== 'object') continue;
            const realId = String(bb.blockId ?? '').trim();
            if (!realId) continue;
            const tRaw = String(bb.blockType ?? '').trim();
            if (!tRaw) continue;

            if (tRaw === 'ObjectSurface' || tRaw === 'ObjectPlane' || tRaw === 'ImageSurface') {
                const displayType = (tRaw === 'ObjectPlane') ? 'ObjectSurface' : tRaw;
                displayLabelByBlockId.set(realId, displayType);
                continue;
            }

            const baseType = (tRaw === 'PositiveLens') ? 'Lens' : tRaw;
            const next = (counts.get(baseType) || 0) + 1;
            counts.set(baseType, next);
            displayLabelByBlockId.set(realId, `${baseType}-${next}`);
        }
    } catch (_) {}

    for (const b of list) {
        const blockId = String(b.blockId ?? '').trim();

        const row = document.createElement('div');
        row.className = 'block-inspector-row';
        if (blockId && __blockInspectorExpandedBlockId === blockId) row.classList.add('selected');

        const colId = document.createElement('div');
        colId.className = 'block-inspector-col-id';
        {
            const rawId = String(b.blockId ?? '(none)');
            const label = displayLabelByBlockId.get(rawId) || formatSingletonBlockLabel(b.blockType, rawId);
            const bt = String(b.blockType ?? '').trim();
            if (bt === 'ObjectSurface' || bt === 'ObjectPlane') {
                colId.textContent = `${label} → Surf 0`;
            } else {
                const range = surfRangeByBlockId.get(String(b.blockId ?? '').trim());
                if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
                    const surfText = (range.min === range.max)
                        ? `Surf ${range.min}`
                        : `Surf ${range.min}–${range.max}`;
                    colId.textContent = `${label} → ${surfText}`;
                } else {
                    colId.textContent = label;
                }
            }
        }

        const colType = document.createElement('div');
        colType.className = 'block-inspector-col-type';
        const displayType = (String(b.blockType ?? '').trim() === 'ObjectPlane') ? 'ObjectSurface' : String(b.blockType ?? '(none)');
        colType.textContent = displayType;

        const colParams = document.createElement('div');
        colParams.className = 'block-inspector-col-params';
        colParams.textContent = String(b.preview ?? '');

        const colCount = document.createElement('div');
        colCount.className = 'block-inspector-col-count';
        const n = Number(b.surfaceCount ?? 0);
        colCount.textContent = `→ ${Number.isFinite(n) ? n : 0} surfaces`;

        row.appendChild(colId);
        row.appendChild(colType);
        row.appendChild(colParams);
        row.appendChild(colCount);

        row.onclick = () => {
            if (!blockId) return;
            __blockInspectorExpandedBlockId = (__blockInspectorExpandedBlockId === blockId) ? null : blockId;
            try { refreshBlockInspector(); } catch (_) {}
        };

        container.appendChild(row);

        const realBlock = blockById && typeof blockById.get === 'function' ? blockById.get(blockId) : null;
        if (realBlock && __blockInspectorExpandedBlockId === blockId) {
            const panel = document.createElement('div');
            panel.style.padding = '6px 8px 10px 8px';
            const isDarkMode = document.body.classList.contains('dark-mode');
            panel.style.borderTop = isDarkMode ? '1px solid #333' : '1px solid #eee';
            panel.style.fontSize = '12px';
            panel.style.color = isDarkMode ? '#ffffff' : '#333';
            
            panel.dataset.blockId = String(blockId);
            panel.setAttribute('data-block-id', String(blockId));

            const params = (realBlock.parameters && typeof realBlock.parameters === 'object') ? realBlock.parameters : {};
            const vars = (realBlock.variables && typeof realBlock.variables === 'object') ? realBlock.variables : {};
            
            // Custom sort order: material1 → material2 → abbe → front* → back* → radius → conic → thickness → semidia → coef*
            const sortParameterKeys = (keys: string[]): string[] => {
                return keys.sort((a, b) => {
                    const aLower = a.toLowerCase();
                    const bLower = b.toLowerCase();
                    
                    // Material1 first, then material2
                    if (a === 'material1') return -1;
                    if (b === 'material1') return 1;
                    if (a === 'material2' && b !== 'material1') return -1;
                    if (b === 'material2' && a !== 'material1') return 1;
                    // Other materials after material1/2
                    if (aLower.includes('material') && !bLower.includes('material')) return -1;
                    if (bLower.includes('material') && !aLower.includes('material')) return 1;
                    
                    // Abbe/vd second
                    if (a === 'abbe' || a === 'vd') return -1;
                    if (b === 'abbe' || b === 'vd') return 1;
                    
                    // Front parameters: surfType → radius → conic → coef*
                    if (aLower.startsWith('front') && !bLower.startsWith('front')) return -1;
                    if (!aLower.startsWith('front') && bLower.startsWith('front')) return 1;
                    if (aLower.startsWith('front') && bLower.startsWith('front')) {
                        const aHasSurf = aLower.includes('surf');
                        const bHasSurf = bLower.includes('surf');
                        const aHasRadius = aLower.includes('radius');
                        const bHasRadius = bLower.includes('radius');
                        const aHasConic = aLower.includes('conic');
                        const bHasConic = bLower.includes('conic');
                        const aHasCoef = aLower.includes('coef');
                        const bHasCoef = bLower.includes('coef');
                        
                        if (aHasSurf && !bHasSurf) return -1;
                        if (!aHasSurf && bHasSurf) return 1;
                        if (aHasRadius && !bHasRadius) return -1;
                        if (!aHasRadius && bHasRadius) return 1;
                        if (aHasConic && !bHasConic) return -1;
                        if (!aHasConic && bHasConic) return 1;
                        
                        // Within frontCoef, sort numerically
                        if (aHasCoef && bHasCoef) {
                            const aMatch = a.match(/\d+/);
                            const bMatch = b.match(/\d+/);
                            if (aMatch && bMatch) {
                                return parseInt(aMatch[0]) - parseInt(bMatch[0]);
                            }
                        }
                    }
                    
                    // Back parameters: surfType → radius → conic → coef*
                    if (aLower.startsWith('back') && !bLower.startsWith('back')) return -1;
                    if (!aLower.startsWith('back') && bLower.startsWith('back')) return 1;
                    if (aLower.startsWith('back') && bLower.startsWith('back')) {
                        const aHasSurf = aLower.includes('surf');
                        const bHasSurf = bLower.includes('surf');
                        const aHasRadius = aLower.includes('radius');
                        const bHasRadius = bLower.includes('radius');
                        const aHasConic = aLower.includes('conic');
                        const bHasConic = bLower.includes('conic');
                        const aHasCoef = aLower.includes('coef');
                        const bHasCoef = bLower.includes('coef');
                        
                        if (aHasSurf && !bHasSurf) return -1;
                        if (!aHasSurf && bHasSurf) return 1;
                        if (aHasRadius && !bHasRadius) return -1;
                        if (!aHasRadius && bHasRadius) return 1;
                        if (aHasConic && !bHasConic) return -1;
                        if (!aHasConic && bHasConic) return 1;
                        
                        // Within backCoef, sort numerically
                        if (aHasCoef && bHasCoef) {
                            const aMatch = a.match(/\d+/);
                            const bMatch = b.match(/\d+/);
                            if (aMatch && bMatch) {
                                return parseInt(aMatch[0]) - parseInt(bMatch[0]);
                            }
                        }
                    }
                    
                    // Radius (general)
                    if (aLower.includes('radius') && !aLower.startsWith('front') && !aLower.startsWith('back') &&
                        !bLower.includes('radius')) return -1;
                    if (bLower.includes('radius') && !bLower.startsWith('front') && !bLower.startsWith('back') &&
                        !aLower.includes('radius')) return 1;
                    
                    // Conic (general)
                    if (aLower.includes('conic') && !aLower.startsWith('front') && !aLower.startsWith('back') &&
                        !bLower.includes('conic')) return -1;
                    if (bLower.includes('conic') && !bLower.startsWith('front') && !bLower.startsWith('back') &&
                        !aLower.includes('conic')) return 1;
                    
                    // Thickness
                    if (aLower.includes('thickness') && !bLower.includes('thickness')) return -1;
                    if (!aLower.includes('thickness') && bLower.includes('thickness')) return 1;
                    
                    // SemiDia / SemiDiameter
                    if (aLower.includes('semidia') && !bLower.includes('semidia')) return -1;
                    if (!aLower.includes('semidia') && bLower.includes('semidia')) return 1;
                    
                    // Coefficients - sort by numeric value
                    const aIsCoef = aLower.includes('coef');
                    const bIsCoef = bLower.includes('coef');
                    
                    if (aIsCoef && bIsCoef) {
                        // Both are coefficients - extract number and sort numerically
                        const aMatch = a.match(/\d+/);
                        const bMatch = b.match(/\d+/);
                        if (aMatch && bMatch) {
                            return parseInt(aMatch[0]) - parseInt(bMatch[0]);
                        }
                    }
                    
                    // Coefficients last (but before other misc params)
                    if (aIsCoef && !bIsCoef) return 1;
                    if (!aIsCoef && bIsCoef) return -1;
                    
                    // Default alphabetical
                    return a.localeCompare(b);
                });
            };
            
            const blockType = String(realBlock.blockType || realBlock.type || 'unknown');
            
            // For Gap blocks, ensure material is always in paramKeys even if not set
            const allParamKeys = Object.keys(params || {});
            if ((blockType === 'Gap' || blockType === 'AirGap') && !allParamKeys.includes('material')) {
                allParamKeys.push('material');
            }
            const paramKeys = sortParameterKeys(allParamKeys);
            const varKeys = Object.keys(vars || {}).sort();

            const createSectionTitle = (label: string) => {
                const title = document.createElement('div');
                title.textContent = label;
                title.style.fontWeight = '600';
                title.style.margin = '8px 0 4px 0';
                title.style.fontSize = '12px';
                return title;
            };

            const createRow = (label: string, value: any, path: string, badge?: string, paramType?: string) => {
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.gap = '8px';
                row.style.alignItems = 'center';
                row.style.marginBottom = '6px';

                const name = document.createElement('div');
                name.textContent = label;
                name.style.fontSize = '12px';
                name.style.color = isDarkMode ? '#d1d5db' : '#374151';
                name.style.flex = '0 0 140px';

                // Check parameter type - surfType uses exact match (case-sensitive key)
                const isSurfType = label === 'surfType' || label === 'frontSurfType' || label === 'backSurfType' || 
                                   label === 'surf1SurfType' || label === 'surf2SurfType' || label === 'surf3SurfType';
                const isMaterial = label.toLowerCase().includes('material') || paramType === 'material';
                // Exclude nd, vd, abbe from slider display - they should be text input only
                const isGlassProperty = label === 'nd' || label === 'vd' || label === 'abbe';
                const isNumeric = !isMaterial && !isSurfType && !isGlassProperty && !isNaN(parseFloat(String(value)));
                
                // Determine if this parameter should show coef parameters based on surfType
                const shouldHideCoef = (key: string, surfTypeValue: string) => {
                    if (!key.includes('Coef') && !key.includes('coef')) return false;
                    return surfTypeValue === 'Spherical';
                };

                let inputElement: HTMLElement;

                if (isSurfType) {
                    // Create dropdown for surface type
                    const select = document.createElement('select');
                    select.style.fontSize = '12px';
                    select.style.padding = '4px 6px';
                    select.style.border = isDarkMode ? '1px solid #444' : '1px solid #ddd';
                    select.style.background = isDarkMode ? '#111827' : '#fff';
                    select.style.color = isDarkMode ? '#f9fafb' : '#111827';
                    select.style.borderRadius = '4px';
                    select.style.flex = '1';
                    select.style.cursor = 'pointer';
                    select.style.minWidth = '200px';
                    select.style.height = '28px';
                    select.style.boxSizing = 'border-box';

                    const options = ['Spherical', 'Aspherical even', 'Aspherical odd', 'Toric'];
                    const currentValue = String(value || 'Spherical');

                    options.forEach(optionValue => {
                        const option = document.createElement('option');
                        option.value = optionValue;
                        option.textContent = optionValue;
                        if (optionValue === currentValue) {
                            option.selected = true;
                        }
                        select.appendChild(option);
                    });

                    select.addEventListener('change', () => {
                        const newValue = select.value;
                        if (newValue !== value) {
                            cooptApplyBlockValue(blockId, path, value, newValue);
                        }
                    });

                    inputElement = select;
                } else if (isNumeric) {
                    // Create parameter slider with Lin/Log, ×0.1/×10 buttons
                    const container = document.createElement('div');
                    container.className = 'param-input-with-slider';
                    container.style.display = 'grid';
                    container.style.gridTemplateColumns = '120px 40px 40px 40px 140px 220px';
                    container.style.columnGap = '6px';
                    container.style.alignItems = 'center';
                    container.style.flex = '1';

                    // Parse initial value
                    const initialVal = parseFloat(String(value));
                    const hasValidValue = Number.isFinite(initialVal);

                    // Get initial range
                    let rangeConfig = getSliderRangeForParameter(label, blockType, value);
                    let { min, max, step } = rangeConfig;
                    let useLog = false;
                    let magnitudeMultiplier = 1.0;

                    // Text input
                    const textInput = document.createElement('input');
                    textInput.type = 'text';
                    textInput.value = value === undefined || value === null ? '' : String(value);
                    textInput.style.fontSize = '12px';
                    textInput.style.padding = '4px 6px';
                    textInput.style.border = isDarkMode ? '1px solid #444' : '1px solid #ddd';
                    textInput.style.background = isDarkMode ? '#111827' : '#fff';
                    textInput.style.color = isDarkMode ? '#f9fafb' : '#111827';
                    textInput.style.borderRadius = '4px';
                    textInput.style.boxSizing = 'border-box';
                    textInput.style.height = '28px';

                    // Lin/Log toggle button
                    const scaleBtn = document.createElement('button');
                    scaleBtn.type = 'button';
                    scaleBtn.className = 'scale-mode-btn';
                    scaleBtn.textContent = 'Lin';
                    scaleBtn.title = 'Toggle linear/logarithmic scale';
                    scaleBtn.style.fontSize = '10px';
                    scaleBtn.style.padding = '2px';
                    scaleBtn.style.boxSizing = 'border-box';
                    scaleBtn.style.height = '28px';

                    // Magnitude down button (×0.1)
                    const magDownBtn = document.createElement('button');
                    magDownBtn.type = 'button';
                    magDownBtn.className = 'magnitude-btn';
                    magDownBtn.textContent = '×0.1';
                    magDownBtn.title = 'Decrease range by 10x';
                    magDownBtn.style.fontSize = '9px';
                    magDownBtn.style.padding = '2px';
                    magDownBtn.style.boxSizing = 'border-box';
                    magDownBtn.style.height = '28px';

                    // Magnitude up button (×10)
                    const magUpBtn = document.createElement('button');
                    magUpBtn.type = 'button';
                    magUpBtn.className = 'magnitude-btn';
                    magUpBtn.textContent = '×10';
                    magUpBtn.title = 'Increase range by 10x';
                    magUpBtn.style.fontSize = '9px';
                    magUpBtn.style.padding = '2px';
                    magUpBtn.style.boxSizing = 'border-box';
                    magUpBtn.style.height = '28px';

                    // Range display
                    const rangeDisplay = document.createElement('div');
                    rangeDisplay.className = 'slider-range-display';
                    rangeDisplay.style.fontSize = '9px';
                    rangeDisplay.style.color = '#666';
                    rangeDisplay.style.whiteSpace = 'nowrap';
                    rangeDisplay.style.overflow = 'hidden';
                    rangeDisplay.style.textOverflow = 'ellipsis';
                    rangeDisplay.style.fontFamily = 'monospace';
                    rangeDisplay.title = 'Slider range (min ~ max)';

                    // Range slider
                    const slider = document.createElement('input');
                    slider.type = 'range';
                    slider.min = '0';
                    slider.max = '1';
                    slider.step = '0.001';
                    slider.value = hasValidValue ? String(valueToSlider(initialVal, min, max, useLog)) : '0.5';

                    // Update range display
                    const formatRangeValue = (val: number, precision: number) => {
                        const n = Number(val);
                        if (!Number.isFinite(n)) return String(val ?? '');
                        const abs = Math.abs(n);
                        if (abs > 0 && abs < 1e-6) return n.toExponential(2);
                        return n.toFixed(precision);
                    };

                    const updateRangeDisplay = () => {
                        const precision = Math.max(2, Math.min(6, -Math.floor(Math.log10(Math.abs(max - min) / 100))));
                        rangeDisplay.textContent = `[${formatRangeValue(min, precision)} ~ ${formatRangeValue(max, precision)}]`;
                    };
                    updateRangeDisplay();

                    // Update range from magnitude multiplier
                    const updateRangeFromMultiplier = () => {
                        const baseConfig = getSliderRangeForParameter(label, blockType, value);
                        const center = (baseConfig.min + baseConfig.max) / 2;
                        const baseRange = (baseConfig.max - baseConfig.min) / 2;
                        const newRange = baseRange * magnitudeMultiplier;

                        min = center - newRange;
                        max = center + newRange;
                        step = baseConfig.step * magnitudeMultiplier;

                        // For non-negative parameters, clamp min to 0
                        if (label.includes('Thickness') || label.includes('hickness') ||
                            label.includes('semidia') || label.includes('aperture')) {
                            if (min < 0) {
                                min = 0;
                                max = center * 2;
                            }
                        }

                        updateSliderPosition();
                        updateRangeDisplay();
                    };

                    // Update slider position
                    const updateSliderPosition = () => {
                        const val = parseFloat(textInput.value);
                        if (Number.isFinite(val)) {
                            slider.value = String(valueToSlider(val, min, max, useLog));
                        }
                    };

                    // Event handlers
                    scaleBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        useLog = !useLog;
                        scaleBtn.textContent = useLog ? 'Log' : 'Lin';
                        scaleBtn.style.background = useLog ? '#007acc' : '';
                        scaleBtn.style.color = useLog ? 'white' : '';
                        updateSliderPosition();
                        updateRangeDisplay();
                    });

                    magDownBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        magnitudeMultiplier *= 0.1;
                        updateRangeFromMultiplier();
                    });

                    magUpBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        magnitudeMultiplier *= 10;
                        updateRangeFromMultiplier();
                    });

                    slider.addEventListener('input', (e) => {
                        e.stopPropagation();
                        const sliderVal = parseFloat(slider.value);
                        const paramVal = sliderToValue(sliderVal, min, max, useLog);
                        const precision = getDisplayPrecision(paramVal, max - min);
                        textInput.value = paramVal.toFixed(precision);
                    });

                    slider.addEventListener('change', (e) => {
                        e.stopPropagation();
                        const sliderVal = parseFloat(slider.value);
                        const paramVal = sliderToValue(sliderVal, min, max, useLog);
                        const precision = getDisplayPrecision(paramVal, max - min);
                        const newValue = paramVal.toFixed(precision);
                        textInput.value = newValue;
                        cooptApplyBlockValue(blockId, path, value, newValue);
                    });

                    const tryCommit = () => {
                        const newValue = textInput.value;
                        const numVal = parseFloat(newValue);
                        if (Number.isFinite(numVal)) {
                            slider.value = String(valueToSlider(numVal, min, max, useLog));
                        }
                        cooptApplyBlockValue(blockId, path, value, newValue);
                    };

                    textInput.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            tryCommit();
                        }
                    });

                    textInput.addEventListener('blur', () => {
                        tryCommit();
                    });

                    container.appendChild(textInput);
                    container.appendChild(scaleBtn);
                    container.appendChild(magDownBtn);
                    container.appendChild(magUpBtn);
                    container.appendChild(rangeDisplay);
                    container.appendChild(slider);

                    inputElement = container;
                } else if (isMaterial) {
                    // Create material input with glass search
                    const container = document.createElement('div');
                    container.style.display = 'flex';
                    container.style.alignItems = 'center';
                    container.style.gap = '8px';
                    container.style.flex = '1';
                    container.style.flexWrap = 'wrap';

                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = value === undefined || value === null ? '' : String(value);
                    input.style.fontSize = '12px';
                    input.style.padding = '4px 6px';
                    input.style.border = isDarkMode ? '1px solid #444' : '1px solid #ddd';
                    input.style.background = isDarkMode ? '#111827' : '#fff';
                    input.style.color = isDarkMode ? '#f9fafb' : '#111827';
                    input.style.flex = '1';
                    input.style.minWidth = '200px';
                    input.style.height = '28px';
                    input.style.boxSizing = 'border-box';

                    const glassBtn = document.createElement('button');
                    glassBtn.textContent = '🔍';
                    glassBtn.title = 'Find Glass';
                    glassBtn.style.fontSize = '14px';
                    glassBtn.style.padding = '2px 8px';
                    glassBtn.style.border = isDarkMode ? '1px solid #444' : '1px solid #ddd';
                    glassBtn.style.background = isDarkMode ? '#1f2937' : '#f9fafb';
                    glassBtn.style.cursor = 'pointer';
                    glassBtn.style.borderRadius = '4px';
                    glassBtn.style.height = '28px';
                    glassBtn.style.boxSizing = 'border-box';

                    // Glass Map button
                    const glassMapBtn = document.createElement('button');
                    glassMapBtn.textContent = '🗺️';
                    glassMapBtn.title = 'Open Glass Map';
                    glassMapBtn.style.fontSize = '14px';
                    glassMapBtn.style.padding = '2px 8px';
                    glassMapBtn.style.border = isDarkMode ? '1px solid #444' : '1px solid #ddd';
                    glassMapBtn.style.background = isDarkMode ? '#1f2937' : '#f9fafb';
                    glassMapBtn.style.cursor = 'pointer';
                    glassMapBtn.style.borderRadius = '4px';
                    glassMapBtn.style.height = '28px';
                    glassMapBtn.style.boxSizing = 'border-box';

                    glassMapBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof openGlassMapWindow === 'function') {
                            openGlassMapWindow(
                                (region) => {
                                    console.log('Region selected:', region);
                                },
                                (glass) => {
                                    if (glass && glass.name) {
                                        input.value = glass.name;
                                        const newValue = cooptNormalizeInputValue(glass.name, value);
                                        if (newValue !== value) {
                                            cooptApplyBlockValue(blockId, path, value, newValue);
                                        }
                                        return true;
                                    }
                                    return false;
                                }
                            );
                        }
                    };

                    glassBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        
                        // Simple glass picker for Design Intent
                        const currentMaterial = input.value.trim();
                        
                        let similarGlasses = [];
                        let isNumericSearch = false;
                        
                        // Check if current material is a numeric value
                        const numericValue = parseFloat(currentMaterial);
                        if (currentMaterial && !isNaN(numericValue) && numericValue > 0 && numericValue < 4) {
                            // Search by nd only for numeric input
                            isNumericSearch = true;
                            try {
                                // Use findSimilarGlassesByNdVd with a wide Vd range
                                similarGlasses = findSimilarGlassesByNdVd(numericValue, 50, 20);
                                console.log('✅ Found', similarGlasses.length, 'glasses with similar nd to', numericValue);
                            } catch (err) {
                                console.error('❌ Failed to find glasses by nd:', err);
                            }
                        } else {
                            // Search by nd and vd for glass names
                            let targetNd = 1.5168, targetVd = 64.2; // Default BK7 values
                            
                            // Try to get current glass properties
                            if (currentMaterial) {
                                try {
                                    const glassData = getGlassDataWithSellmeier(currentMaterial);
                                    
                                    if (glassData && glassData.nd !== undefined && glassData.vd !== undefined) {
                                        targetNd = glassData.nd;
                                        targetVd = glassData.vd;
                                        console.log('✅ Found glass properties - nd:', targetNd, 'vd:', targetVd);
                                    } else {
                                        console.warn('⚠️ Glass not found, using default BK7 values');
                                    }
                                } catch (err) {
                                    console.warn('❌ Failed to get glass data:', err);
                                }
                            } else {
                                console.log('ℹ️ No current material, using default BK7 values');
                            }
                            
                            console.log('🔍 Searching for glasses similar to nd:', targetNd, 'vd:', targetVd);
                            
                            // Find similar glasses using imported function
                            try {
                                similarGlasses = findSimilarGlassesByNdVd(targetNd, targetVd, 20);
                                console.log('✅ Found', similarGlasses.length, 'similar glasses');
                            } catch (err) {
                                console.error('❌ Failed to find similar glasses:', err);
                            }
                        }
                        
                        if (similarGlasses.length === 0) {
                            alert('No glasses found in database.');
                            return;
                        }
                        
                        // Create simple picker dialog
                        const isDark = document.documentElement.classList.contains('dark');
                        const overlay = document.createElement('div');
                        overlay.style.position = 'fixed';
                        overlay.style.top = '0';
                        overlay.style.left = '0';
                        overlay.style.right = '0';
                        overlay.style.bottom = '0';
                        overlay.style.background = 'rgba(0,0,0,0.6)';
                        overlay.style.display = 'flex';
                        overlay.style.alignItems = 'center';
                        overlay.style.justifyContent = 'center';
                        overlay.style.zIndex = '9999';
                        
                        const dialog = document.createElement('div');
                        dialog.style.background = isDark ? '#1f2937' : '#fff';
                        dialog.style.borderRadius = '8px';
                        dialog.style.padding = '20px';
                        dialog.style.maxWidth = '600px';
                        dialog.style.maxHeight = '80vh';
                        dialog.style.overflow = 'auto';
                        dialog.style.boxShadow = '0 4px 20px rgba(0,0,0,0.3)';
                        
                        const title = document.createElement('h3');
                        title.textContent = '🔍 Select Glass Material';
                        title.style.margin = '0 0 15px 0';
                        title.style.color = isDark ? '#f9fafb' : '#111827';
                        
                        const list = document.createElement('div');
                        list.style.display = 'flex';
                        list.style.flexDirection = 'column';
                        list.style.gap = '4px';
                        list.style.marginBottom = '15px';
                        
                        similarGlasses.slice(0, 15).forEach((glass: any, idx: number) => {
                            const item = document.createElement('div');
                            item.style.padding = '8px 12px';
                            item.style.cursor = 'pointer';
                            item.style.borderRadius = '4px';
                            item.style.background = isDark ? '#374151' : '#f3f4f6';
                            item.style.transition = 'background 0.15s';
                            item.textContent = `${idx + 1}. ${glass.name} (nd=${glass.nd.toFixed(4)}, vd=${glass.vd.toFixed(1)})`;
                            item.style.fontSize = '13px';
                            item.style.color = isDark ? '#f9fafb' : '#111827';
                            
                            item.onmouseenter = () => {
                                item.style.background = isDark ? '#4b5563' : '#e5e7eb';
                            };
                            item.onmouseleave = () => {
                                item.style.background = isDark ? '#374151' : '#f3f4f6';
                            };
                            item.onclick = () => {
                                input.value = glass.name;
                                const newValue = cooptNormalizeInputValue(glass.name, value);
                                if (newValue !== value) {
                                    cooptApplyBlockValue(blockId, path, value, newValue);
                                }
                                document.body.removeChild(overlay);
                            };
                            
                            list.appendChild(item);
                        });
                        
                        const cancelBtn = document.createElement('button');
                        cancelBtn.textContent = 'Cancel';
                        cancelBtn.style.padding = '6px 16px';
                        cancelBtn.style.border = 'none';
                        cancelBtn.style.borderRadius = '4px';
                        cancelBtn.style.background = isDark ? '#4b5563' : '#d1d5db';
                        cancelBtn.style.color = isDark ? '#f9fafb' : '#111827';
                        cancelBtn.style.cursor = 'pointer';
                        cancelBtn.onclick = () => document.body.removeChild(overlay);
                        
                        dialog.appendChild(title);
                        dialog.appendChild(list);
                        dialog.appendChild(cancelBtn);
                        overlay.appendChild(dialog);
                        
                        overlay.onclick = (e) => {
                            if (e.target === overlay) {
                                document.body.removeChild(overlay);
                            }
                        };
                        
                        document.body.appendChild(overlay);
                    };

                    input.addEventListener('blur', () => {
                        const newValue = cooptNormalizeInputValue(input.value, value);
                        if (newValue !== value) {
                            cooptApplyBlockValue(blockId, path, value, newValue);
                        }
                    });

                    container.appendChild(input);
                    container.appendChild(glassBtn);
                    container.appendChild(glassMapBtn);
                    inputElement = container;
                } else {
                    // Standard text input
                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = value === undefined || value === null ? '' : String(value);
                    input.style.fontSize = '12px';
                    input.style.padding = '4px 6px';
                    input.style.border = isDarkMode ? '1px solid #444' : '1px solid #ddd';
                    input.style.background = isDarkMode ? '#111827' : '#fff';
                    input.style.color = isDarkMode ? '#f9fafb' : '#111827';
                    input.style.flex = '1';
                    input.style.minWidth = '200px';
                    input.style.height = '28px';
                    input.style.boxSizing = 'border-box';

                    input.addEventListener('blur', () => {
                        const newValue = cooptNormalizeInputValue(input.value, value);
                        if (newValue !== value) {
                            cooptApplyBlockValue(blockId, path, value, newValue);
                        }
                    });

                    inputElement = input;
                }

                const chip = document.createElement('div');
                chip.textContent = badge || '';
                chip.style.fontSize = '10px';
                chip.style.padding = '2px 6px';
                chip.style.borderRadius = '999px';
                chip.style.border = badge ? (isDarkMode ? '1px solid #374151' : '1px solid #e5e7eb') : 'none';
                chip.style.color = isDarkMode ? '#9ca3af' : '#6b7280';
                chip.style.visibility = badge ? 'visible' : 'hidden';

                row.appendChild(name);
                row.appendChild(inputElement);
                row.appendChild(chip);
                return row;
            };

            if (paramKeys.length > 0) {
                panel.appendChild(createSectionTitle('Parameters'));
                for (const key of paramKeys) {
                    // Skip coef* parameters when surfType is "Spherical"
                    if (/^coef\d+$/.test(key) && params.surfType === 'Spherical') {
                        continue;
                    }
                    if (/^frontCoef\d+$/.test(key) && params.frontSurfType === 'Spherical') {
                        continue;
                    }
                    if (/^backCoef\d+$/.test(key) && params.backSurfType === 'Spherical') {
                        continue;
                    }
                    if (/^surf1Coef\d+$/.test(key) && params.surf1SurfType === 'Spherical') {
                        continue;
                    }
                    if (/^surf2Coef\d+$/.test(key) && params.surf2SurfType === 'Spherical') {
                        continue;
                    }
                    if (/^surf3Coef\d+$/.test(key) && params.surf3SurfType === 'Spherical') {
                        continue;
                    }
                    
                    let value = (params as any)[key];
                    // For Gap/AirGap material, default to 'AIR' if undefined or empty
                    if ((blockType === 'Gap' || blockType === 'AirGap') && key === 'material' && (value === undefined || value === null || value === '')) {
                        value = 'AIR';
                    }
                    const varEntry = (vars as any)[key];

                    // Create row with optimize checkbox and scope selector
                    const paramRow = document.createElement('div');
                    paramRow.style.display = 'flex';
                    paramRow.style.alignItems = 'center';
                    paramRow.style.gap = '6px';
                    paramRow.style.marginBottom = '6px';

                    // Optimize checkbox
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.style.flex = '0 0 auto';
                    cb.style.width = '16px';
                    cb.style.height = '16px';
                    cb.style.margin = '0 4px 0 0';
                    cb.checked = __blocks_shouldMarkVar(varEntry);
                    cb.addEventListener('click', (e) => e.stopPropagation());

                    // Scope select (Per-config / Shared)
                    const scopeSel = document.createElement('select');
                    scopeSel.style.flex = '0 0 110px';
                    scopeSel.style.fontSize = '12px';
                    scopeSel.style.padding = '2px 4px';
                    scopeSel.innerHTML = '<option value="perConfig">Per-config</option><option value="global">Shared (all configs)</option>';
                    scopeSel.value = __blocks_getVarScope(varEntry);
                    scopeSel.disabled = !cb.checked;
                    scopeSel.addEventListener('click', (e) => e.stopPropagation());

                    cb.addEventListener('change', (e) => {
                        e.stopPropagation();
                        try { scopeSel.disabled = !cb.checked; } catch (_) {}
                        __blocks_setVarMode(blockId, key, cb.checked, String(scopeSel.value));
                        try { refreshBlockInspector(); } catch (_) {}
                    });

                    scopeSel.addEventListener('change', (e) => {
                        e.stopPropagation();
                        const newScope = String(scopeSel.value);
                        __blocks_setVarScope(blockId, key, newScope);
                        if (cb.checked) {
                            __blocks_setVarMode(blockId, key, true, newScope);
                        }
                        try { refreshBlockInspector(); } catch (_) {}
                    });

                    const innerRow = createRow(key, value, `parameters.${key}`);
                    innerRow.style.flex = '1';
                    innerRow.style.marginBottom = '0';

                    paramRow.appendChild(cb);
                    paramRow.appendChild(scopeSel);
                    paramRow.appendChild(innerRow);
                    panel.appendChild(paramRow);
                    
                    // If this is a material parameter and has a glass name, show nd/vd below
                    const isMaterialParam = key === 'material' || key === 'material1' || key === 'material2' || key === 'material3';
                    if (isMaterialParam && value && typeof value === 'string' && value.trim() !== '' && value.trim().toUpperCase() !== 'AIR') {
                        try {
                            const glassData = getGlassDataWithSellmeier(String(value).trim());
                            if (glassData && glassData.nd !== undefined && glassData.vd !== undefined) {
                                // Create read-only display for nd
                                const ndRow = document.createElement('div');
                                ndRow.style.display = 'flex';
                                ndRow.style.alignItems = 'center';
                                ndRow.style.gap = '6px';
                                ndRow.style.marginBottom = '4px';
                                ndRow.style.marginLeft = '132px'; // Indent to align with parameter value
                                ndRow.style.fontSize = '11px';
                                ndRow.style.color = isDarkMode ? '#9ca3af' : '#6b7280';
                                
                                const ndLabel = document.createElement('span');
                                ndLabel.textContent = '↳ nd:';
                                ndLabel.style.width = '60px';
                                
                                const ndValue = document.createElement('span');
                                ndValue.textContent = glassData.nd.toFixed(5);
                                ndValue.style.fontFamily = 'monospace';
                                
                                ndRow.appendChild(ndLabel);
                                ndRow.appendChild(ndValue);
                                panel.appendChild(ndRow);
                                
                                // Create read-only display for vd (abbe)
                                const vdRow = document.createElement('div');
                                vdRow.style.display = 'flex';
                                vdRow.style.alignItems = 'center';
                                vdRow.style.gap = '6px';
                                vdRow.style.marginBottom = '6px';
                                vdRow.style.marginLeft = '132px'; // Indent to align with parameter value
                                vdRow.style.fontSize = '11px';
                                vdRow.style.color = isDarkMode ? '#9ca3af' : '#6b7280';
                                
                                const vdLabel = document.createElement('span');
                                vdLabel.textContent = '↳ vd:';
                                vdLabel.style.width = '60px';
                                
                                const vdValue = document.createElement('span');
                                vdValue.textContent = glassData.vd.toFixed(2);
                                vdValue.style.fontFamily = 'monospace';
                                
                                vdRow.appendChild(vdLabel);
                                vdRow.appendChild(vdValue);
                                panel.appendChild(vdRow);
                            }
                        } catch (err) {
                            // Glass not found or error - silently ignore
                        }
                    }
                }
            }

            if (varKeys.length > 0) {
                for (const key of varKeys) {
                    // Skip if this key is already shown in Parameters
                    if (paramKeys.includes(key)) {
                        continue;
                    }
                    
                    const entry = (vars as any)[key];
                    const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;

                    // Create a row with checkbox and scope select
                    const varRow = document.createElement('div');
                    varRow.style.display = 'flex';
                    varRow.style.alignItems = 'center';
                    varRow.style.gap = '6px';
                    varRow.style.marginBottom = '6px';

                    // Optimize checkbox
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.style.flex = '0 0 auto';
                    cb.style.width = '16px';
                    cb.style.height = '16px';
                    cb.style.margin = '0 4px 0 0';
                    cb.checked = __blocks_shouldMarkVar(entry);
                    cb.addEventListener('click', (e) => e.stopPropagation());

                    // Scope select (Per-config / Shared)
                    const scopeSel = document.createElement('select');
                    scopeSel.style.flex = '0 0 110px';
                    scopeSel.style.fontSize = '12px';
                    scopeSel.style.padding = '2px 4px';
                    scopeSel.innerHTML = '<option value="perConfig">Per-config</option><option value="global">Shared (all configs)</option>';
                    scopeSel.value = __blocks_getVarScope(entry);
                    scopeSel.disabled = !cb.checked;
                    scopeSel.addEventListener('click', (e) => e.stopPropagation());

                    cb.addEventListener('change', (e) => {
                        e.stopPropagation();
                        try { scopeSel.disabled = !cb.checked; } catch (_) {}
                        __blocks_setVarMode(blockId, key, cb.checked, String(scopeSel.value));
                        try { refreshBlockInspector(); } catch (_) {}
                    });

                    scopeSel.addEventListener('change', (e) => {
                        e.stopPropagation();
                        const newScope = String(scopeSel.value);
                        __blocks_setVarScope(blockId, key, newScope);
                        if (cb.checked) {
                            __blocks_setVarMode(blockId, key, true, newScope);
                        }
                        try { refreshBlockInspector(); } catch (_) {}
                    });

                    // Build the standard createRow content but embed in this container
                    const badge = entry && typeof entry === 'object' && entry.optimize && entry.optimize.mode ? `V:${entry.optimize.mode}` : 'V';
                    const innerRow = createRow(key, value, `variables.${key}.value`, badge);
                    innerRow.style.flex = '1';
                    innerRow.style.marginBottom = '0';

                    varRow.appendChild(cb);
                    varRow.appendChild(scopeSel);
                    varRow.appendChild(innerRow);
                    panel.appendChild(varRow);
                }
            }

            if (paramKeys.length === 0 && varKeys.length === 0) {
                const empty = document.createElement('div');
                empty.textContent = 'No parameters defined for this block.';
                empty.style.fontSize = '12px';
                empty.style.color = isDarkMode ? '#9ca3af' : '#6b7280';
                panel.appendChild(empty);
            }

            container.appendChild(panel);
        }
    }
}

export function refreshBlockInspector(): void {
    const banner = document.getElementById('import-analyze-mode-banner');
    const setBannerVisible = (isVisible: boolean) => {
        if (!banner) return;
        banner.style.display = isVisible ? '' : 'none';
    };

    try {
        const activeCfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
        const blocks = activeCfg && Array.isArray(activeCfg.blocks) ? activeCfg.blocks : null;

        try {
            const isImportAnalyze = !blocks || blocks.length === 0;
            setBannerVisible(!!isImportAnalyze);
        } catch (_) {}

        if (blocks && blocks.length > 0) {
            const countById = new Map<string, number>();
            let expandedRowsForUI: any = null;
            try {
                if (typeof expandBlocksToOpticalSystemRows === 'function') {
                    const exp = expandBlocksToOpticalSystemRows(blocks);
                    const rows = exp && Array.isArray(exp.rows) ? exp.rows : [];
                    expandedRowsForUI = rows;
                    for (const r of rows) {
                        const bid = r?._blockId;
                        if (bid === null || bid === undefined) continue;
                        const id = String(bid).trim();
                        if (!id || id === '(none)') continue;
                        const rowBlockType = String(r?._blockType ?? '').trim();
                        if (rowBlockType === 'Gap' || rowBlockType === 'CoordTrans') continue;
                        countById.set(id, (countById.get(id) || 0) + 1);
                    }
                }
            } catch (_) {}

            try {
                if (Array.isArray(expandedRowsForUI) && expandedRowsForUI.length > 0) {
                    const rowsForTable = expandedRowsForUI.map((r: any, idx: number) => {
                        const row = (r && typeof r === 'object') ? { ...r } : {};
                        row.id = idx;
                        if (idx === 0) row['object type'] = 'Object';
                        else if (idx === expandedRowsForUI.length - 1) row['object type'] = 'Image';
                        return row;
                    });

                    const tab = ((window as any).tableOpticalSystem && typeof (window as any).tableOpticalSystem.getData === 'function')
                        ? (window as any).tableOpticalSystem
                        : ((window as any).opticalSystemTabulator && typeof (window as any).opticalSystemTabulator.getData === 'function')
                            ? (window as any).opticalSystemTabulator
                            : null;

                    if (tab) {
                        if (typeof tab.replaceData === 'function') {
                            tab.replaceData(rowsForTable);
                        } else if (typeof tab.setData === 'function') {
                            tab.setData(rowsForTable);
                        }
                    }

                    try {
                        if (typeof (window as any).updateSurfaceNumberSelect === 'function') (window as any).updateSurfaceNumberSelect();
                    } catch (_) {}
                }
            } catch (_) {}

            const merged = blocks.map((b: any) => {
                const id = String(b?.blockId ?? '(none)');
                return {
                    blockId: id,
                    blockType: String(b?.blockType ?? '(none)'),
                    surfaceCount: countById.has(id) ? countById.get(id) : 0,
                    preview: formatBlockPreview(b)
                };
            });

            const blockById = new Map<string, any>();
            for (const b of blocks) {
                const id = String(b?.blockId ?? '').trim();
                if (!id) continue;
                blockById.set(id, b);
            }
            renderBlockInspector(merged, {}, blockById, blocks);
        } else {
            if (typeof (window as any).dumpOpticalSystemProvenance !== 'function') return;
            const result = (window as any).dumpOpticalSystemProvenance({ quiet: true });
            renderBlockInspector(result?.summary || [], result?.groups || {}, null, null);
        }
    } catch (e) {
        console.warn('⚠️ [Blocks] Failed to refresh block inspector:', e);
    }
}

// Apply to Design Intent Button Setup
function setupApplyToDesignIntentButton(): void {
    const btn = document.getElementById('apply-to-design-intent-btn');
    if (!btn) return;

    if ((btn as any).dataset && (btn as any).dataset.applyToDesignIntentBound === '1') return;
    if ((btn as any).dataset) (btn as any).dataset.applyToDesignIntentBound = '1';

    btn.addEventListener('click', () => {
        try {
            const tbl = (window as any).tableOpticalSystem || (globalThis as any).tableOpticalSystem;
            const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
            if (!Array.isArray(rows) || rows.length === 0) {
                alert('Expanded Optical System が見つかりません。');
                return;
            }

            const edits: any[] = [];
            try {
                const pending = (globalThis as any).__pendingSurfaceEdits;
                if (pending && typeof pending === 'object') {
                    for (const [key, v] of Object.entries(pending)) {
                        const [sidRaw, fieldRaw] = String(key).split(':');
                        const surfaceId = Number(sidRaw);
                        const field = String(fieldRaw ?? '').trim();
                        if (!Number.isFinite(surfaceId) || !field) continue;
                        const row = rows.find((r: any) => r && typeof r.id === 'number' && r.id === surfaceId);
                        if (!row) continue;
                        edits.push({ row, field, oldValue: (v as any)?.oldValue, newValue: row[field] });
                    }
                }
            } catch (_) {}
            if (edits.length === 0 && (globalThis as any).__lastSurfaceEdit) edits.push((globalThis as any).__lastSurfaceEdit);

            if (edits.length === 0) {
                try {
                    const cells = (tbl && typeof tbl.getSelectedCells === 'function') ? tbl.getSelectedCells() : [];
                    const cell = Array.isArray(cells) && cells.length > 0 ? cells[cells.length - 1] : null;
                    if (cell && typeof cell.getField === 'function' && typeof cell.getRow === 'function') {
                        const field = cell.getField();
                        const rowData = cell.getRow()?.getData?.() ?? null;
                        const newValue = (typeof cell.getValue === 'function') ? cell.getValue() : (rowData ? rowData[field] : undefined);
                        let oldValue: any = undefined;
                        try { oldValue = (typeof cell.getOldValue === 'function') ? cell.getOldValue() : undefined; } catch (_) {}
                        if (oldValue === undefined) oldValue = null;
                        if (rowData) edits.push({ row: rowData, field, oldValue, newValue });
                    }
                } catch (_) {}
            }

            if (edits.length === 0) {
                try {
                    const last = (globalThis as any).__lastActiveSurfaceCell || (globalThis as any).__lastSelectedSurfaceCell;
                    const surfaceId = Number(last?.surfaceId);
                    const field = String(last?.field ?? '').trim();
                    if (Number.isFinite(surfaceId) && field) {
                        const row = rows.find((r: any) => r && typeof r.id === 'number' && r.id === surfaceId);
                        if (row) edits.push({ row, field, oldValue: null, newValue: row[field] });
                    }
                } catch (_) {}
            }
            
            if (edits.length === 0) {
                alert('Apply対象の変更が見つかりません。');
                return;
            }

            console.log(`✅ Apply to Design Intent: ${edits.length} edits processed`);

            try { refreshBlockInspector(); } catch (_) {}
            try { (globalThis as any).__pendingSurfaceEdits = {}; } catch (_) {}
            
            try {
                const popup = (window as any).popup3DWindow;
                if (popup && !popup.closed && typeof popup.postMessage === 'function') {
                    popup.postMessage({ action: 'request-redraw' }, '*');
                }
            } catch (_) {}
        } catch (e) {
            console.error('❌ Apply to Design Intent failed:', e);
            alert(`Apply failed: ${(e as Error)?.message || String(e)}`);
        }
    });
}

// Main DOM Event Handlers Setup Function
export function setupDOMEventHandlers(): void {
    console.log('🔵 [DOM] Setting up DOM event handlers...');

    try {
        setupImportZemaxButton();
        setupOptimizeDesignIntentButton();
        setupSuggestOptimizeButtons();
        setupNewFileButton();
        setupSaveButton();
        setupShareUrlButton();
        setupLoadDefaultButton();
        setupLoadAllButton();
        setupClearStorageButton();
        
        // setupOpticalSystemChangeListeners needs to wait for React to mount the button
        // It will be called after React mount event
        
        setupParaxialButton();
        setupSeidelButton();
        setupSeidelAfocalButton();
        setupCoordinateTransformButton();
        setupSpotDiagramButton();
        setupLongitudinalAberrationButton();
        setupTransverseAberrationButton();
        setupDistortionButton();
        setupIntegratedAberrationButton();
        setupAstigmatismButton();
        
        setupPSFDisplaySettings();
        setupPSFDisplayModeButtons();
        
        setupApplyToDesignIntentButton();
        
        console.log('✅ [DOM] DOM event handlers setup complete');
    } catch (err) {
        console.error('❌ [DOM] Failed to setup event handlers:', err);
    }
}

/**
 * Load design from compressed URL hash if present
 */
export async function loadFromCompressedDataHashIfPresent(): Promise<{ ok: boolean; reason?: string }> {
    const compressed = getCompressedStringFromLocation();
    if (!compressed) return { ok: false, reason: 'no_hash' };
    
    const confirmed = confirm(
        'リンクから設計を読み込みます。現在の設計は上書きされます。続行しますか？\n\n' +
        'Load design from URL? Current design will be overwritten.'
    );
    if (!confirmed) return { ok: false, reason: 'cancelled' };
    
    let allData;
    try {
        allData = decodeAllDataFromCompressedString(compressed);
    } catch (e) {
        console.warn('❌ [URL Load] Decode failed:', e);
        alert((e as any)?.message || 'Failed to load design from URL');
        return { ok: false, reason: 'decode_failed' };
    }

    const ok = await __loadAllDataObjectIntoApp(allData, { filename: 'shared-link.json' });
    if (ok) {
        try {
            history.replaceState(null, '', `${location.origin}${location.pathname}${location.search}`);
        } catch (_) {}
    }
    return { ok };
}

// Auto-initialize on module load
if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setupDOMEventHandlers();
        });
    } else {
        setupDOMEventHandlers();
    }
    
    // Listen for React mount event to setup handlers that depend on React-rendered elements
    document.addEventListener('coopt:react-mounted', () => {
        console.log('🔵 [DOM] React mounted, setting up React-dependent handlers...');
        setupOpticalSystemChangeListeners(null);
    });
}
