// ui/dom-event-handlers.ts
// DOM event handlers orchestration: comprehensive UI management for the entire application

// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

// Import statements (all .ts → .js for ESM runtime)
import { getGlassDataWithSellmeier, findSimilarGlassNames, findSimilarGlassesByNdVd } from '../data/glass.ts';
import { openGlassMapWindow } from '../data/glass-map.ts';
import {
    expandBlocksToOpticalSystemRows,
    expandBlocksIntoConfiguration,
    deriveBlocksFromLegacyOpticalSystemRows,
    validateBlocksConfiguration,
    BLOCK_SCHEMA_VERSION
} from '../data/block-schema.ts';
import { SetBlockParameterCommand } from '../core/undo-history.ts';
import { requestRefreshBlockInspector, requestUpdateSurfaceNumberSelect } from '../core/window-facade.ts';
import { 
    getCompressedStringFromLocation, 
    decodeAllDataFromCompressedString,
    encodeAllDataToCompressedString,
    buildShareUrlFromCompressedString
} from '../utils/url-share.ts';
import { getWindowDebugBagValue } from '../utils/window-debug-bag.ts';
import { setupOpticalSystemChangeListeners, setupAnalysisWindows } from './event-handlers.ts';
import { parseZMXArrayBufferToOpticalSystemRows } from '../import-export/zemax-import.ts';
import { listDesignVariablesFromBlocks } from '../optimization/design-variables.ts';
import { calculateParaxialData } from '../raytracing/core/ray-paraxial.ts';
import {
    loadSystemConfigurations as loadSystemConfigurationsFromTableConfig,
    saveSystemConfigurations as saveSystemConfigurationsFromTableConfig,
    clearAllPersistedState
} from '../data/table-configuration.ts';
import {
    loadTableData as loadSourceTableData,
    saveTableData as saveSourceTableData,
    tryLoadPersistedTableData as tryLoadPersistedSourceTableData
} from '../data/table-source.ts';
import {
    loadTableData as loadOpticalSystemTableData,
    saveTableData as saveOpticalSystemTableData
} from '../data/table-optical-system.ts';
import {
    loadTableData as loadMeritFunctionTableData,
    saveTableData as saveMeritFunctionTableData
} from '../data/table-merit-function.ts';
import {
    loadTableData as loadObjectTableData,
    saveTableData as saveObjectTableData
} from '../data/table-object.ts';
import {
    loadTableData as loadSystemRequirementsTableData,
    saveTableData as saveSystemRequirementsTableData
} from '../data/table-system-requirements.ts';
import { isTauriRuntime } from '../src/desktop/runtime.ts';

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

function coordTransDebugLog(message: string, ...args: any[]): void {
    // 1. ブラウザコンソールに出力（多くの場合失敗してもキャッチされる）
    try {
        if (message.includes('🔴') || message.includes('❌')) {
            console.log(`%c${message}`, 'color: red; font-weight: bold; font-size: 13px;', ...args);
        } else if (message.includes('🔵')) {
            console.log(`%c${message}`, 'color: blue; font-weight: bold; font-size: 12px;', ...args);
        } else if (message.includes('⚠️')) {
            console.log(`%c${message}`, 'color: orange; font-weight: bold;', ...args);
        } else if (message.includes('✅')) {
            console.log(`%c${message}`, 'color: green; font-weight: bold;', ...args);
        } else {
            console.log(message, ...args);
        }
    } catch {}

    try {
        const op = (window as any)?.opener;
        if (op && op.console && typeof op.console.log === 'function') {
            op.console.log(message, ...args);
        }
    } catch {}

    // 2. メモリに記録（JavaScript から確認可能）
    try {
        const wAny = window as any;
        if (!Array.isArray(wAny.__coordTransDebugLogs)) {
            wAny.__coordTransDebugLogs = [];
        }
        wAny.__coordTransDebugLogs.push({
            time: new Date().toISOString(),
            message,
            args
        });
    } catch {}
}

try {
    (window as any).__coordTransConsoleTest = () => {
        const stamp = new Date().toISOString();
        console.log(`[CoordTrans][TEST] console output OK at ${stamp}`);
        coordTransDebugLog(`✅ [CoordTrans][TEST] coordTransDebugLog OK at ${stamp}`);
        return stamp;
    };
} catch {}

try {
    (window as any).__coordTransConsoleTestFire = () => {
        const stamp = new Date().toISOString();
        console.error(`[CoordTrans][TEST] console.error OK at ${stamp}`);
        console.warn(`[CoordTrans][TEST] console.warn OK at ${stamp}`);
        console.info(`[CoordTrans][TEST] console.info OK at ${stamp}`);
        return stamp;
    };
} catch {}


// CoordTrans auto-calculation (module-level function, called directly from button handler)
async function performCoordTransCalculation(blockId: string, panel: HTMLElement): Promise<void> {
    const panelAny = panel as any;
    if (panelAny && panelAny.__coordTransCalculating) return;
    if (panelAny) panelAny.__coordTransCalculating = true;

    try {
        console.log('%c🔴 [CoordTrans] performCoordTransCalculation CALLED for blockId=' + blockId, 'color: red; font-weight: bold; font-size: 14px;');
        coordTransDebugLog(`🔴 [CoordTrans] performCoordTransCalculation called for blockId=${blockId}`);

        const getValue = (key: string): string | null => {
            if (!panel) return null;
                let element = panel.querySelector(`input[data-param-key="${key}"]`) as HTMLInputElement | HTMLSelectElement | null;
            if (!element) {
                const wrapper = panel.querySelector(`.param-input-with-slider[data-param-key="${key}"] input[type="text"]`) as HTMLInputElement | null;
                element = wrapper || null;
            }
            if (!element) {
                element = panel.querySelector(`input[name="${key}"]`) as HTMLInputElement | null;
            }
            if (!element) {
                element = panel.querySelector(`select[data-param-key="${key}"]`) as HTMLSelectElement | null;
            }
            if (!element) {
                element = panel.querySelector(`select[name="${key}"]`) as HTMLSelectElement | null;
            }
                return element ? String(element.value ?? '') : null;
        };

        let blockParams: any = null;
        try {
            if (typeof loadSystemConfigurations === 'function') {
                const systemConfig = loadSystemConfigurations();
                const activeId = systemConfig?.activeConfigId;
                const activeCfg = Array.isArray(systemConfig?.configurations)
                    ? systemConfig.configurations.find((c: any) => c && String(c.id) === String(activeId))
                    : null;
                const block = activeCfg?.blocks?.find((b: any) => b && String(b.blockId ?? '') === String(blockId));
                blockParams = block?.parameters || null;
            }
        } catch (_) {}

        const toSurfValue = (blockParams && blockParams.toSurf !== undefined && blockParams.toSurf !== null)
            ? String(blockParams.toSurf)
            : getValue('toSurf');
        const coordReturnValue = (blockParams && blockParams.coordReturn)
            ? String(blockParams.coordReturn)
            : (getValue('coordReturn') || 'none');

        // For AUTO mode, zero out existing decenters to ensure independent calculation
        if (blockParams) {
            const normShift = (v: any) => String(v ?? '').trim().toUpperCase();
            if (['A', 'AUTO'].includes(normShift(blockParams.chiefRayShiftX))) {
                blockParams = { ...blockParams, decenterX: 0 };
            }
            if (['A', 'AUTO'].includes(normShift(blockParams.chiefRayShiftY))) {
                blockParams = { ...blockParams, decenterY: 0 };
            }
            if (['A', 'AUTO'].includes(normShift(blockParams.chiefRayShiftZ))) {
                blockParams = { ...blockParams, decenterZ: 0 };
            }
        }

        // Force Order 1 (Tilt → Decenter) for non-none return
        if (coordReturnValue !== 'none') {
            const currentOrder = getValue('order');
            if (currentOrder !== '1') {
                try {
                    if (typeof (w as any).__blocks_setBlockParamValue === 'function') {
                        const orderRes = (w as any).__blocks_setBlockParamValue(blockId, 'order', '1');
                        if (!orderRes || orderRes.ok !== true) {
                            if (!panelAny || !panelAny.__coordTransOrderWarned) {
                                console.warn('[CoordTrans] Failed to set order to 1:', orderRes?.reason);
                                if (panelAny) panelAny.__coordTransOrderWarned = true;
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        if (!toSurfValue || String(toSurfValue).trim() === '') {
            return;
        }

        const toSurfOrdinal = Number(toSurfValue);
        if (!Number.isFinite(toSurfOrdinal)) {
            console.error('[CoordTrans] Invalid target index:', toSurfValue);
            return;
        }

        const getOpticalSystemRows = (w as any).getOpticalSystemRows;
        if (typeof getOpticalSystemRows !== 'function') {
            console.error('[CoordTrans] getOpticalSystemRows not available');
            return;
        }

        const opticalSystemRows = getOpticalSystemRows();
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            console.error('[CoordTrans] No optical system data');
            return;
        }

        const originalUnenrichedRows = opticalSystemRows.map((row: any) => ({ ...row }));

        let activeSystemConfig: any = null;
        try {
            activeSystemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
        } catch (_) {}

        const isCoordTransRowForPath = (row: any): boolean => {
            const surfType = String(row?.surfType ?? row?.['surf type'] ?? '').toLowerCase().replace(/\s+/g, '');
            return (
                surfType === 'coordbreak' ||
                surfType === 'coordinatebreak' ||
                surfType === 'cb' ||
                surfType === 'coordtrans' ||
                surfType === 'coordinatetransform' ||
                surfType === 'ct'
            );
        };

        const isObjectRowForPath = (row: any): boolean => {
            const objectType = row?.['object type'] ?? row?.object ?? row?.Object;
            return String(objectType ?? '').toLowerCase() === 'object';
        };

        const isGapRowForPath = (row: any): boolean => {
            const surfType = String(row?.surfType ?? row?.['surf type'] ?? '').toLowerCase();
            return surfType === 'gap';
        };

        const resolveSurfaceIndexFromOrdinal = (rows: any[], ordinal: number): number | null => {
            if (!Array.isArray(rows)) return null;
            if (!Number.isFinite(ordinal)) return null;
            const target = Math.floor(ordinal);
            if (target <= 0) return null;
            let count = 0;
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (isCoordTransRowForPath(row)) continue;
                if (isObjectRowForPath(row)) continue;
                if (isGapRowForPath(row)) continue;
                count++;
                if (count === target) return i;
            }
            return null;
        };

        const resolvedToSurf = resolveSurfaceIndexFromOrdinal(opticalSystemRows, toSurfOrdinal);
        const targetIndex = resolvedToSurf !== null
            ? resolvedToSurf
            : Math.max(0, Math.min(Math.floor(toSurfOrdinal), Math.max(0, opticalSystemRows.length - 1)));

        const enrichedRows = opticalSystemRows.map((row: any) => {
            const bid = String(row._blockId ?? row.blockId ?? '');
            if (!bid) return row;

            let myParams: any = null;

            if (bid === String(blockId) && blockParams) {
                myParams = blockParams;
            } else {
                try {
                    if (activeSystemConfig && Array.isArray(activeSystemConfig.configurations)) {
                        const activeId = activeSystemConfig.activeConfigId;
                        const activeCfg = activeSystemConfig.configurations.find((c: any) => c && c.id === activeId);
                        if (activeCfg && Array.isArray(activeCfg.blocks)) {
                            const foundBlock = activeCfg.blocks.find((b: any) => b && String(b.blockId ?? '') === bid);
                            if (foundBlock) myParams = foundBlock.parameters;
                        }
                    }
                } catch (e) {
                    console.warn(`[CoordTrans] Could not get block data for ${bid}:`, e);
                }
            }

            if (!myParams) return row;

            const isCurrentBlock = (bid === String(blockId));
            const normShift = (v: any) => String(v ?? '').trim().toUpperCase();
            const shouldZeroX = isCurrentBlock && ['A', 'AUTO'].includes(normShift(myParams.chiefRayShiftX));
            const shouldZeroY = isCurrentBlock && ['A', 'AUTO'].includes(normShift(myParams.chiefRayShiftY));
            const shouldZeroZ = isCurrentBlock && ['A', 'AUTO'].includes(normShift(myParams.chiefRayShiftZ));

            return {
                ...row,
                decenterX: shouldZeroX ? 0 : (myParams.decenterX !== undefined ? myParams.decenterX : row.decenterX),
                decenterY: shouldZeroY ? 0 : (myParams.decenterY !== undefined ? myParams.decenterY : row.decenterY),
                decenterZ: shouldZeroZ ? 0 : (myParams.decenterZ !== undefined ? myParams.decenterZ : row.decenterZ),
                tiltX: myParams.tiltX !== undefined ? myParams.tiltX : row.tiltX,
                tiltY: myParams.tiltY !== undefined ? myParams.tiltY : row.tiltY,
                tiltZ: myParams.tiltZ !== undefined ? myParams.tiltZ : row.tiltZ,
                order: myParams.order !== undefined ? myParams.order : row.order,
                chiefRayShiftX: myParams.chiefRayShiftX,
                chiefRayShiftY: myParams.chiefRayShiftY,
                chiefRayShiftZ: myParams.chiefRayShiftZ,
                parameters: {
                    ...(row.parameters || {}),
                    decenterX: shouldZeroX ? 0 : (myParams.decenterX !== undefined ? myParams.decenterX : row.parameters?.decenterX),
                    decenterY: shouldZeroY ? 0 : (myParams.decenterY !== undefined ? myParams.decenterY : row.parameters?.decenterY),
                    decenterZ: shouldZeroZ ? 0 : (myParams.decenterZ !== undefined ? myParams.decenterZ : row.parameters?.decenterZ),
                    tiltX: myParams.tiltX !== undefined ? myParams.tiltX : row.parameters?.tiltX,
                    tiltY: myParams.tiltY !== undefined ? myParams.tiltY : row.parameters?.tiltY,
                    tiltZ: myParams.tiltZ !== undefined ? myParams.tiltZ : row.parameters?.tiltZ,
                    order: myParams.order !== undefined ? myParams.order : row.parameters?.order,
                    chiefRayShiftX: myParams.chiefRayShiftX,
                    chiefRayShiftY: myParams.chiefRayShiftY,
                    chiefRayShiftZ: myParams.chiefRayShiftZ
                }
            };
        });

        // Calculate local coordinates
        // We Ignore THIS block to calculate "Return" values based on incoming system.
        // If we include the block's current parameters, we get the *residual* tilt/decenter,
        // rather than the parameters needed to *cancel* the incoming tilt/decenter.
        // Pass both enriched and original unenriched rows so the function can get correct target positions
        const calculateAllSurfacesLocalCoordinates = (w as any).calculateAllSurfacesLocalCoordinates;
        if (typeof calculateAllSurfacesLocalCoordinates !== 'function') {
            console.error('[CoordTrans] calculateAllSurfacesLocalCoordinates not available');
            return;
        }

        const result = await calculateAllSurfacesLocalCoordinates(
            enrichedRows,
            targetIndex,
            null,      // no progress callback
            blockId,   // Ignore THIS block to calculate correct return values
            originalUnenrichedRows  // Original unenriched rows for correct target surface positions
        );

        // Find which surface this CoordTrans block corresponds to
        let blockSurfaceId = -1;
        for (let i = 0; i < opticalSystemRows.length; i++) {
            const bid = String(opticalSystemRows[i]._blockId ?? opticalSystemRows[i].blockId ?? '');
            if (bid === String(blockId)) {
                blockSurfaceId = i;
                break;
            }
        }

        if (blockSurfaceId < 0) {
            console.error('[CoordTrans] Could not find surface for block:', blockId);
            return;
        }

        // Get surface data for this block
        const rowId = String(opticalSystemRows[blockSurfaceId].id);
        let surfData = result.surfaces?.[rowId] || result.surfaces?.[String(rowId)] || result.surfaces?.[Number(rowId)] ||
                      result.surfaces?.[blockSurfaceId] || result.surfaces?.[String(blockSurfaceId)];

        // If no data for this block, try next surface
        if (!surfData) {
            for (let i = blockSurfaceId + 1; i < opticalSystemRows.length; i++) {
                const nextRowId = String(opticalSystemRows[i].id);
                surfData = result.surfaces?.[nextRowId];
                if (surfData) {
                    break;
                }
            }
        }

        if (!surfData) {
            console.error('[CoordTrans] No surface data found');
            return;
        }

        try {
            if (coordReturnValue === 'xyz') {
                console.log('[CoordTrans] Mode:', coordReturnValue, 'blockId:', blockId, 'targetIndex:', targetIndex);
                console.log('[CoordTrans] blockParams:', blockParams);
                console.log('[CoordTrans] surfData tilt:', {
                    tiltX: surfData.localTiltX,
                    tiltY: surfData.localTiltY,
                    tiltZ: surfData.localTiltZ
                });
                console.log('[CoordTrans] surfData decenter (local):', {
                    decenterX: surfData.localDecenterX,
                    decenterY: surfData.localDecenterY,
                    decenterZ: surfData.localDecenterZ
                });
                console.log('[CoordTrans] surfData decenter (flat):', {
                    decenterX: surfData.flatDecenterX,
                    decenterY: surfData.flatDecenterY,
                    decenterZ: surfData.flatDecenterZ
                });
            }
        } catch (_) {}

        const computedValues: Record<string, number> = {};
        const setComputedValue = (key: string, value: any): boolean => {
            if (typeof value === 'number' && Number.isFinite(value)) {
                computedValues[key] = value;
                return true;
            }
            return false;
        };

        const chiefRayShiftX = (blockParams && blockParams.chiefRayShiftX !== undefined)
            ? blockParams.chiefRayShiftX
            : getValue('chiefRayShiftX');
        const chiefRayShiftY = (blockParams && blockParams.chiefRayShiftY !== undefined)
            ? blockParams.chiefRayShiftY
            : getValue('chiefRayShiftY');
        const chiefRayShiftZ = (blockParams && blockParams.chiefRayShiftZ !== undefined)
            ? blockParams.chiefRayShiftZ
            : getValue('chiefRayShiftZ');
        const normShift = (v: any) => String(v ?? '').trim().toUpperCase();
        let shouldAutoX = ['A', 'AUTO'].includes(normShift(chiefRayShiftX));
        let shouldAutoY = ['A', 'AUTO'].includes(normShift(chiefRayShiftY));
        let shouldAutoZ = ['A', 'AUTO'].includes(normShift(chiefRayShiftZ));
        
        // Force Z-direction calculation to be enabled when XYZ mode is active
        // This ensures decenterZ is calculated even if chiefRayShiftZ is not explicitly set to AUTO
        if (coordReturnValue === 'xyz') {
            shouldAutoZ = true;
            console.log('[CoordTrans] XYZ mode detected: forcing shouldAutoZ=true');
        }

        let updated: Record<string, boolean> = {};
        switch (coordReturnValue) {
            case 'none':
                break;
            case 'xyz':
                {
                    const srcX = (surfData.flatDecenterX !== undefined && Number.isFinite(surfData.flatDecenterX))
                        ? surfData.flatDecenterX : surfData.localDecenterX;
                    const srcY = (surfData.flatDecenterY !== undefined && Number.isFinite(surfData.flatDecenterY))
                        ? surfData.flatDecenterY : surfData.localDecenterY;
                    const srcZ = (surfData.flatDecenterZ !== undefined && Number.isFinite(surfData.flatDecenterZ))
                        ? surfData.flatDecenterZ : surfData.localDecenterZ;

                    updated = {
                        decenterX: shouldAutoX ? setComputedValue('decenterX', srcX) : false,
                        decenterY: shouldAutoY ? setComputedValue('decenterY', srcY) : false,
                        decenterZ: shouldAutoZ ? setComputedValue('decenterZ', srcZ) : false,
                        tiltX: setComputedValue('tiltX', surfData.localTiltX),
                        tiltY: setComputedValue('tiltY', surfData.localTiltY),
                        tiltZ: setComputedValue('tiltZ', surfData.localTiltZ)
                    };
                }
                break;
        }

        if (coordReturnValue !== 'none') {
            if (typeof window !== 'undefined') {
                if (!(window as any).__coordTransComputedValues) (window as any).__coordTransComputedValues = {};
                (window as any).__coordTransComputedValues[blockId] = computedValues;
            }
        } else if (typeof window !== 'undefined' && (window as any).__coordTransComputedValues) {
            delete (window as any).__coordTransComputedValues[blockId];
        }

        if (coordReturnValue !== 'none') {
            try {
                (window as any).__coordTransApplyingResults = true;

                const updates: Record<string, number> = {};
                if (coordReturnValue === 'xyz') {
                    let srcX = surfData.localDecenterX;
                    if (surfData.flatDecenterX !== undefined && Number.isFinite(surfData.flatDecenterX)) {
                        srcX = surfData.flatDecenterX;
                    }

                    let srcY = surfData.localDecenterY;
                    if (surfData.flatDecenterY !== undefined && Number.isFinite(surfData.flatDecenterY)) {
                        srcY = surfData.flatDecenterY;
                    }

                    let srcZ = surfData.localDecenterZ;
                    if (surfData.flatDecenterZ !== undefined && Number.isFinite(surfData.flatDecenterZ)) {
                        srcZ = surfData.flatDecenterZ;
                    }
                    
                    console.log(`[CoordTrans XYZ] shouldAutoX=${shouldAutoX}, shouldAutoY=${shouldAutoY}, shouldAutoZ=${shouldAutoZ}`);
                    console.log(`[CoordTrans XYZ] srcX=${srcX.toFixed(4)}, srcY=${srcY.toFixed(4)}, srcZ=${srcZ.toFixed(4)}`);

                    if (shouldAutoX) updates.decenterX = srcX;
                    if (shouldAutoY) updates.decenterY = srcY;
                    if (shouldAutoZ) updates.decenterZ = srcZ;
                    console.log(`[CoordTrans XYZ] After assignment: updates.decenterX=${updates.decenterX}, updates.decenterY=${updates.decenterY}, updates.decenterZ=${updates.decenterZ}`);
                    
                    updates.tiltX = surfData.localTiltX;
                    updates.tiltY = surfData.localTiltY;
                    updates.tiltZ = surfData.localTiltZ;
                }

                if (typeof loadSystemConfigurations === 'function' && typeof saveSystemConfigurations === 'function') {
                    const systemConfig = loadSystemConfigurations();
                    const activeId = systemConfig?.activeConfigId;
                    const activeCfg = Array.isArray(systemConfig?.configurations)
                        ? systemConfig.configurations.find((c: any) => c && String(c.id) === String(activeId))
                        : null;
                    const block = activeCfg?.blocks?.find((b: any) => b && String(b.blockId ?? '') === String(blockId));
                    if (block) {
                        if (!block.parameters || typeof block.parameters !== 'object') block.parameters = {};
                        console.log(`[CoordTrans] Before block update - blockId=${blockId}:`, {decenterX: (block.parameters as any).decenterX, decenterY: (block.parameters as any).decenterY, decenterZ: (block.parameters as any).decenterZ});
                        for (const [k, v] of Object.entries(updates)) {
                            if (typeof v === 'number' && Number.isFinite(v)) {
                                (block.parameters as any)[k] = v;
                                console.log(`[CoordTrans] Set block.parameters.${k} = ${v.toFixed(6)}`);
                            }
                        }
                        console.log(`[CoordTrans] After block update - blockId=${blockId}:`, {decenterX: (block.parameters as any).decenterX, decenterY: (block.parameters as any).decenterY, decenterZ: (block.parameters as any).decenterZ});
                        if (activeCfg?.metadata && typeof activeCfg.metadata === 'object') {
                            activeCfg.metadata.modified = new Date().toISOString();
                        }
                        saveSystemConfigurations(systemConfig);
                    }
                }

                try {
                    if (typeof loadSystemConfigurations === 'function' && typeof expandBlocksToOpticalSystemRows === 'function') {
                        const systemConfig = loadSystemConfigurations();
                        const activeId = systemConfig?.activeConfigId;
                        const activeCfg = Array.isArray(systemConfig?.configurations)
                            ? systemConfig.configurations.find((c: any) => c && String(c.id) === String(activeId))
                            : null;
                        if (activeCfg && Array.isArray(activeCfg.blocks)) {
                            const expanded = expandBlocksToOpticalSystemRows(activeCfg.blocks);
                            if (expanded && Array.isArray(expanded.rows)) {
                                activeCfg.opticalSystem = expanded.rows;
                                if (typeof saveSystemConfigurations === 'function') {
                                    saveSystemConfigurations(systemConfig);
                                }
                            }
                        }
                    }
                } catch (_) {}

                if ((window as any).ConfigurationManager && typeof (window as any).ConfigurationManager.loadActiveConfigurationToTables === 'function') {
                    await (window as any).ConfigurationManager.loadActiveConfigurationToTables({ applyToUI: true });
                } else if (typeof (window as any).loadActiveConfigurationToTables === 'function') {
                    await (window as any).loadActiveConfigurationToTables({ applyToUI: true });
                }

                try {
                    if ((window as any).ConfigurationManager && typeof (window as any).ConfigurationManager.renderBlocksUI === 'function') {
                        (window as any).ConfigurationManager.renderBlocksUI();
                    }
                } catch (_) {}

                try { if (typeof (window as any).__blocks_requestRedraw === 'function') (window as any).__blocks_requestRedraw(); } catch (_) {}
                try { if (typeof (window as any).refreshAllUI === 'function') (window as any).refreshAllUI(); } catch (_) {}
            } finally {
                (window as any).__coordTransApplyingResults = false;
            }
        }

        const successCount = Object.values(updated).filter((v) => v).length;
        console.log('[CoordTrans] Updated', successCount, 'fields:', coordReturnValue);
        try { refreshBlockInspector(); } catch (_) {}
    } catch (error) {
        console.error('[CoordTrans] Calculation error:', error);
    } finally {
        if (panelAny) panelAny.__coordTransCalculating = false;
    }
}

// Zemax import/export utilities
function __zmxPickPrimaryWavelengthMicrons(wavelengthsFromWAVE: number[]): number {
    if (!Array.isArray(wavelengthsFromWAVE) || wavelengthsFromWAVE.length === 0) return NaN;
    return wavelengthsFromWAVE[0];
}

function __zmxReadSemidiaMm(row: any): number {
    const sd = row?.semidia ?? row?.['semidia(mm)'] ?? row?.semidiameter;
    const n = Number(sd);
    return Number.isFinite(n) ? n : NaN;
}

function __zmxReadPositiveFiniteSemidiaMm(row: any): number | null {
    const n = __zmxReadSemidiaMm(row);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function __zmxGetApertureKeysByBlockType(blockType: any): string[] {
    const t = String(blockType ?? '').trim();
    if (t === 'Lens' || t === 'PositiveLens') return ['front', 'back'];
    if (t === 'Doublet') return ['s1', 's2', 's3'];
    if (t === 'Triplet') return ['s1', 's2', 's3', 's4'];
    return [];
}

function __zmxIsPhysicalOpticalRow(row: any): boolean {
    if (!row || typeof row !== 'object') return false;
    const objectType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
    if (objectType === 'object' || objectType === 'stop' || objectType === 'image') return false;
    const surfType = String(row?.surfType ?? row?.['surf type'] ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (surfType === 'coordtrans' || surfType === 'coordbreak' || surfType === 'coordinatebreak') return false;
    return true;
}

function __zmxIsMissingSemidia(row: any): boolean {
    const sd = row?.semidia ?? row?.['semidia(mm)'] ?? row?.semidiameter;
    if (sd === undefined || sd === null) return true;
    if (String(sd).trim() === '') return true;
    const n = Number(sd);
    return !Number.isFinite(n) || n <= 0;
}

function __zmxGetMaxPositiveSemidiaMmFromRows(rows: any[]): number | null {
    let max = 0;
    for (const r of rows) {
        const n = __zmxReadSemidiaMm(r);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max > 0 ? max : null;
}

function __zmxGetStopRadiusMmFromRows(rows: any[]): number | null {
    for (const r of rows) {
        const ot = String(r?.['object type'] ?? r?.object ?? '').toLowerCase();
        if (ot === 'stop') {
            const n = __zmxReadSemidiaMm(r);
            return Number.isFinite(n) && n > 0 ? n : null;
        }
    }
    return null;
}

function __zmxGetStopSurfaceIndex(rows: any[]): number {
    if (!Array.isArray(rows)) return -1;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const ot = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
        if (ot === 'stop') return i;
    }
    return -1;
}

function __zmxEvaluateEntrancePupilForStopSemidia(rows: any[], stopIndex: number, wavelengthMicrons: number, stopSemidiaMm: number): number | null {
    if (!Array.isArray(rows) || stopIndex < 0 || stopIndex >= rows.length) return null;
    if (!(Number.isFinite(stopSemidiaMm) && stopSemidiaMm > 0)) return null;

    try {
        const cloned = rows.map((r: any) => ({ ...(r || {}) }));
        cloned[stopIndex].semidia = stopSemidiaMm;
        const paraxial = calculateParaxialData(cloned, wavelengthMicrons);
        const enpd = Number(paraxial?.entrancePupilDiameter);
        return Number.isFinite(enpd) && enpd > 0 ? enpd : null;
    } catch (_) {
        return null;
    }
}

function __zmxBacksolveStopSemidiaFromEnpd(rows: any[], wavelengthMicrons: number, targetEnpdMm: number): number | null {
    const target = Number(targetEnpdMm);
    if (!(Number.isFinite(target) && target > 0)) return null;

    const stopIndex = __zmxGetStopSurfaceIndex(rows);
    if (stopIndex < 0) return null;

    const minSd = 1e-4;
    let loSd = Math.max(minSd, target * 0.02);
    let hiSd = Math.max(1, target * 1.5);

    let loEnpd = __zmxEvaluateEntrancePupilForStopSemidia(rows, stopIndex, wavelengthMicrons, loSd);
    let hiEnpd = __zmxEvaluateEntrancePupilForStopSemidia(rows, stopIndex, wavelengthMicrons, hiSd);

    for (let i = 0; i < 24 && (!Number.isFinite(hiEnpd as number) || (hiEnpd as number) < target); i++) {
        hiSd *= 1.8;
        hiEnpd = __zmxEvaluateEntrancePupilForStopSemidia(rows, stopIndex, wavelengthMicrons, hiSd);
        if (hiSd > 1e6) break;
    }
    for (let i = 0; i < 24 && Number.isFinite(loEnpd as number) && (loEnpd as number) > target && loSd > minSd; i++) {
        loSd = Math.max(minSd, loSd / 1.8);
        loEnpd = __zmxEvaluateEntrancePupilForStopSemidia(rows, stopIndex, wavelengthMicrons, loSd);
        if (loSd <= minSd) break;
    }

    let bestSd: number | null = null;
    let bestErr = Infinity;

    const consider = (sd: number, enpd: number | null) => {
        if (!(Number.isFinite(sd) && sd > 0)) return;
        if (!(Number.isFinite(enpd as number) && (enpd as number) > 0)) return;
        const err = Math.abs((enpd as number) - target);
        if (err < bestErr) {
            bestErr = err;
            bestSd = sd;
        }
    };

    consider(loSd, loEnpd);
    consider(hiSd, hiEnpd);

    const hasBracket = Number.isFinite(loEnpd as number)
        && Number.isFinite(hiEnpd as number)
        && (((loEnpd as number) - target) * ((hiEnpd as number) - target) <= 0);

    if (hasBracket) {
        let leftSd = loSd;
        let rightSd = hiSd;
        let leftEnpd = loEnpd as number;
        let rightEnpd = hiEnpd as number;

        for (let i = 0; i < 36; i++) {
            const midSd = (leftSd + rightSd) / 2;
            const midEnpdRaw = __zmxEvaluateEntrancePupilForStopSemidia(rows, stopIndex, wavelengthMicrons, midSd);
            if (!Number.isFinite(midEnpdRaw as number) || (midEnpdRaw as number) <= 0) break;
            const midEnpd = midEnpdRaw as number;
            consider(midSd, midEnpd);

            if (Math.abs(midEnpd - target) <= 1e-4) break;

            if ((leftEnpd - target) * (midEnpd - target) <= 0) {
                rightSd = midSd;
                rightEnpd = midEnpd;
            } else {
                leftSd = midSd;
                leftEnpd = midEnpd;
            }

            if (Math.abs(rightSd - leftSd) <= 1e-8 * Math.max(1, midSd)) break;
        }
    } else {
        const low = Math.max(minSd, target * 0.005);
        const high = Math.max(hiSd, target * 20);
        const span = Math.log(high / low);
        const samples = 40;
        for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            const sd = low * Math.exp(span * t);
            const enpd = __zmxEvaluateEntrancePupilForStopSemidia(rows, stopIndex, wavelengthMicrons, sd);
            consider(sd, enpd);
        }
    }

    return (Number.isFinite(bestSd as number) && (bestSd as number) > 0) ? (bestSd as number) : null;
}

function __zmxResolveSearchRadiusMm(rows: any[], entrancePupilDiameterMm?: number): number {
    const stopRad = __zmxGetStopRadiusMmFromRows(rows);
    if (Number.isFinite(stopRad) && (stopRad as number) > 0) return stopRad as number;

    const enpd = Number(entrancePupilDiameterMm);
    if (Number.isFinite(enpd) && enpd > 0) return enpd / 2;

    const maxSemidia = __zmxGetMaxPositiveSemidiaMmFromRows(rows);
    if (Number.isFinite(maxSemidia) && (maxSemidia as number) > 0) return maxSemidia as number;

    return 10;
}

function __zmxIsInfiniteConjugateFromObjectRow(objectRow: any): boolean {
    const t = objectRow?.thickness;
    if (t === Infinity) return true;
    const s = String(t ?? '').trim();
    return /^inf(inity)?$/i.test(s);
}

function __zmxBuildRowsForSemidiaTrace(rows: any[]): any[] {
    const cloned = Array.isArray(rows) ? rows.map((r: any) => ({ ...(r || {}) })) : [];
    const baseMax = __zmxGetMaxPositiveSemidiaMmFromRows(cloned);
    const hugeSemidia = Math.max(1000, Number.isFinite(baseMax as number) ? Number(baseMax) * 20 : 1000);

    for (const row of cloned) {
        if (!row || typeof row !== 'object') continue;
        const objType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
        const surfType = String(row?.surfType ?? row?.['surf type'] ?? row?.type ?? '').trim().toLowerCase();

        if (objType === 'stop') continue;
        if (objType === 'object' || objType === 'image') continue;
        if (surfType === 'coord trans' || surfType === 'coordinate transform' || surfType === 'ct' || surfType === 'coordtrans' || surfType === 'coordinatetransform') continue;

        row.semidia = hugeSemidia;
    }

    return cloned;
}

function __zmxResolveMaxObjectAnglesDeg(objectRows: any[]): { x: number; y: number } {
    let maxX = 0;
    let maxY = 0;
    if (!Array.isArray(objectRows)) return { x: 0, y: 0 };

    for (const row of objectRows) {
        if (!row || typeof row !== 'object') continue;
        const x = Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0);
        const y = Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0);
        if (Number.isFinite(x)) maxX = Math.max(maxX, Math.abs(x));
        if (Number.isFinite(y)) maxY = Math.max(maxY, Math.abs(y));
    }
    return { x: maxX, y: maxY };
}

function __zmxSolveCrossRayToStopCoordAxis(
    rows: any[],
    stopIndex: number,
    primaryWavelength: number,
    targetAxis: 'x' | 'y',
    isInfinite: boolean,
    searchRadiusMm: number
): number | null {
    try {
        let lo = 0;
        let hi = Math.max(2, Number(searchRadiusMm) * 2);
        const maxIter = 12;
        const tol = 1e-4;

        for (let iter = 0; iter < maxIter; iter++) {
            const mid = (lo + hi) / 2;
            const rays = isInfinite
                ? (typeof w.generateInfiniteSystemCrossBeam === 'function'
                    ? w.generateInfiniteSystemCrossBeam(rows, [{ x: targetAxis === 'x' ? mid : 0, y: targetAxis === 'y' ? mid : 0 }], {
                        rayCount: 1,
                        wavelength: primaryWavelength,
                        debugMode: false
                    })
                    : null)
                : (typeof w.generateCrossBeam === 'function'
                    ? w.generateCrossBeam(rows, [{ x: targetAxis === 'x' ? mid : 0, y: targetAxis === 'y' ? mid : 0, z: 0 }], {
                        rayCount: 1,
                        wavelength: primaryWavelength,
                        debugMode: false
                    })
                    : null);

            if (!rays) return null;
            const tracedRay = Array.isArray(rays?.allTracedRays) && rays.allTracedRays.length > 0
                ? rays.allTracedRays[0]
                : (Array.isArray(rays?.objectResults) && rays.objectResults.length > 0 && Array.isArray(rays.objectResults[0]?.tracedRays) && rays.objectResults[0].tracedRays.length > 0
                    ? rays.objectResults[0].tracedRays[0]
                    : (Array.isArray(rays?.rays) && rays.rays.length > 0 ? rays.rays[0] : null));
            if (!tracedRay) return null;

            const rayPath = Array.isArray(tracedRay?.rayPath)
                ? tracedRay.rayPath
                : (Array.isArray(tracedRay?.rayPathToTarget) ? tracedRay.rayPathToTarget : null);
            if (!Array.isArray(rayPath)) return null;
            const stopPos = rayPath[stopIndex];
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

function __zmxApplySemidiaOverridesFromMarginalRays(rows: any[], wavelengthMicrons: number, objectRows: any[] = []): void {
    const stopIndex = rows.findIndex((r: any) => {
        const ot = String(r?.['object type'] ?? r?.object ?? '').toLowerCase();
        return ot === 'stop';
    });
    if (stopIndex < 0) return;

    const objectRow = rows[0];
    const isInfinite = __zmxIsInfiniteConjugateFromObjectRow(objectRow);

    const rowsForTrace = __zmxBuildRowsForSemidiaTrace(rows);

    const enpdHintMm = Number((rows as any)?.__zmxEntrancePupilDiameterMm);
    const searchRadiusMm = __zmxResolveSearchRadiusMm(rows, Number.isFinite(enpdHintMm) ? enpdHintMm : undefined);
    let sampleX = searchRadiusMm;
    let sampleY = searchRadiusMm;

    const maxObjectAngles = isInfinite ? __zmxResolveMaxObjectAnglesDeg(objectRows) : { x: 0, y: 0 };
    const hasObjectAngles = isInfinite && (maxObjectAngles.x > 0 || maxObjectAngles.y > 0);

    if (hasObjectAngles) {
        if (maxObjectAngles.x > 0) sampleX = maxObjectAngles.x;
        if (maxObjectAngles.y > 0) sampleY = maxObjectAngles.y;
    } else {
        const crossX = __zmxSolveCrossRayToStopCoordAxis(rowsForTrace, stopIndex, wavelengthMicrons, 'x', isInfinite, searchRadiusMm);
        const crossY = __zmxSolveCrossRayToStopCoordAxis(rowsForTrace, stopIndex, wavelengthMicrons, 'y', isInfinite, searchRadiusMm);
        sampleX = Number.isFinite(crossX) ? crossX : searchRadiusMm;
        sampleY = Number.isFinite(crossY) ? crossY : searchRadiusMm;
    }

    if (!Number.isFinite(sampleX) || !Number.isFinite(sampleY) || sampleX <= 0 || sampleY <= 0) return;

    const rays = isInfinite
        ? (typeof w.generateInfiniteSystemCrossBeam === 'function'
            ? w.generateInfiniteSystemCrossBeam(rowsForTrace, [{ x: sampleX, y: 0 }, { x: 0, y: sampleY }], {
                rayCount: 13,
                wavelength: wavelengthMicrons,
                debugMode: false
            })
            : null)
        : (typeof w.generateCrossBeam === 'function'
            ? w.generateCrossBeam(rowsForTrace, [{ x: sampleX, y: 0, z: 0 }, { x: 0, y: sampleY, z: 0 }], {
                rayCount: 13,
                wavelength: wavelengthMicrons,
                debugMode: false
            })
            : null);

    if (!rays) return;

    // Support multiple return formats
    let allRays: any[] = [];
    if (Array.isArray(rays.allTracedRays)) {
        // Preferred infinite-system format: already traced rays with rayPath
        allRays = rays.allTracedRays;
    } else if (Array.isArray(rays.rays)) {
        // Old format: {rays: [...]}
        allRays = rays.rays;
    } else if (Array.isArray(rays.objectResults)) {
        // New format: {objectResults: [{tracedRays:[...]}]} or fallback variants
        for (const objResult of rays.objectResults) {
            if (Array.isArray(objResult?.tracedRays)) {
                allRays.push(...objResult.tracedRays);
            } else if (Array.isArray(objResult?.rays)) {
                allRays.push(...objResult.rays);
            } else if (Array.isArray(objResult?.crossBeamRays)) {
                allRays.push(...objResult.crossBeamRays);
            }
        }
    }

    if (allRays.length === 0) return;

    const maxBySurface = new Array(rows.length).fill(0);
    for (const ray of allRays) {
        const rayPath = Array.isArray(ray?.rayPath)
            ? ray.rayPath
            : (Array.isArray(ray?.rayPathToTarget)
                ? ray.rayPathToTarget
                : (Array.isArray(ray?.path)
                    ? ray.path
                    : (Array.isArray(ray?.ray?.path) ? ray.ray.path : null)));
        if (!Array.isArray(rayPath)) continue;
        const rayPathLen = Math.min(rayPath.length, rows.length);
        for (let i = 0; i < rayPathLen; i++) {
            const p = rayPath[i];
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
            const rr = Math.sqrt(p.x * p.x + p.y * p.y);
            if (rr > maxBySurface[i]) maxBySurface[i] = rr;
        }
    }
    let updateCount = 0;
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r || typeof r !== 'object') continue;
        const isPhysical = __zmxIsPhysicalOpticalRow(r);
        if (!isPhysical) continue;

        const wasMissing = __zmxIsMissingSemidia(r);
        const prev = __zmxReadPositiveFiniteSemidiaMm(r);
        const maxR = maxBySurface[i];
        if (maxR > 0 && (wasMissing || prev === null || maxR > (prev + 1e-6))) {
            r.semidia = maxR;
            updateCount++;
        }
    }
}

function autoCalculateMissingSemidia(sourceRows: any[], objectRows: any[], options: { entrancePupilDiameterMm?: number; stopSemidiaWasMissing?: boolean } = {}): void {
    console.log('[autoCalculateMissingSemidia] START');
    const tbl = w.tableOpticalSystem || w.tableOpticalSystem;
    const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
    if (!Array.isArray(rows) || rows.length < 2) {
        console.warn('[autoCalculateMissingSemidia] Invalid rows:', rows);
        return;
    }
    console.log('[autoCalculateMissingSemidia] Table loaded with', rows.length, 'rows');
    console.log('[autoCalculateMissingSemidia] Initial rows (first 5):', 
        rows.slice(0, 5).map((r: any) => ({
            surf: r?.surf,
            type: r?.type,
            object: r?.object,
            'object type': r?.['object type'],
            semidia: r?.semidia,
            radius: r?.radius,
            thickness: r?.thickness
        })));

    try {
        const primaryWavelength = (() => {
            if (typeof w.getPrimaryWavelength === 'function') {
                const wl = Number(w.getPrimaryWavelength());
                if (Number.isFinite(wl) && wl > 0) return wl;
            }
            console.warn('Primary wavelength is unavailable. Semidia auto-calculation is skipped.');
            return NaN;
        })();
        if (!Number.isFinite(primaryWavelength) || primaryWavelength <= 0) return;

        const enpd = Number(options?.entrancePupilDiameterMm);
        const stopIndex = __zmxGetStopSurfaceIndex(rows);
        const stopSemidiaWasMissingAtImport = !!options?.stopSemidiaWasMissing;
        const shouldBacksolveStop = Number.isFinite(enpd) && enpd > 0 && stopIndex >= 0
            && (stopSemidiaWasMissingAtImport || __zmxIsMissingSemidia(rows[stopIndex]));
        if (shouldBacksolveStop) {
            const solvedStopSemidia = __zmxBacksolveStopSemidiaFromEnpd(rows, primaryWavelength, enpd);
            if (Number.isFinite(solvedStopSemidia) && solvedStopSemidia > 0) {
                rows[stopIndex].semidia = solvedStopSemidia;
                console.warn(`[autoCalculateMissingSemidia] Stop semidia backsolved from ENPD=${enpd}: ${solvedStopSemidia}`);
            } else {
                console.warn(`[autoCalculateMissingSemidia] Stop semidia backsolve failed (ENPD=${enpd}, stopIndex=${stopIndex})`);
            }
        }
        if (Number.isFinite(enpd) && enpd > 0) {
            (rows as any).__zmxEntrancePupilDiameterMm = enpd;
        }

        __zmxApplySemidiaOverridesFromMarginalRays(rows, primaryWavelength, objectRows);

        console.log('[autoCalculateMissingSemidia] Ray tracing completed. Sample rows with semidia:', 
            rows.slice(0, 5).map((r: any) => ({
                surf: r?.surf,
                type: r?.type,
                semidia: r?.semidia,
                _blockId: r?._blockId,
                _surfaceRole: r?._surfaceRole
            })));

        try {
            delete (rows as any).__zmxEntrancePupilDiameterMm;
        } catch (_) {}

        if (tbl && typeof tbl.setData === 'function') {
            tbl.setData(rows);
        }

        try {
            saveOpticalSystemTableData(rows as any);
            console.log('[autoCalculateMissingSemidia] ✅ Saved to tableOpticalSystem storage');
        } catch (err) {
            console.error('[autoCalculateMissingSemidia] ❌ Failed to save tableOpticalSystem:', err);
        }

        try {
            const systemConfig = (typeof loadSystemConfigurations === 'function')
                ? loadSystemConfigurations()
                : null;
            if (systemConfig && Array.isArray(systemConfig.configurations)) {
                const activeId = systemConfig.activeConfigId;
                const activeCfg = systemConfig.configurations.find((c: any) => c && String(c.id) === String(activeId))
                    || systemConfig.configurations[0];
                if (activeCfg && typeof activeCfg === 'object') {
                    activeCfg.opticalSystem = rows.map((r: any) => ({ ...(r || {}) }));
                    if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
                    activeCfg.metadata.modified = new Date().toISOString();
                    if (typeof saveSystemConfigurations === 'function') {
                        saveSystemConfigurations(systemConfig);
                        console.log('[autoCalculateMissingSemidia] ✅ Saved to active configuration');
                    }
                }
            }
        } catch (err) {
            console.error('[autoCalculateMissingSemidia] ❌ Failed to save configuration:', err);
        }
    } catch (_) {}
}

function __zmxSyncDesignIntentApertureFromOpticalRows(): void {
    console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] START');
    try {
        const tbl = w.tableOpticalSystem || w.opticalSystemTabulator;
        const tableRows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
        if (!Array.isArray(tableRows) || tableRows.length === 0) {
            console.warn('[__zmxSyncDesignIntentApertureFromOpticalRows] No table rows found');
            return;
        }
        const physicalRows = tableRows.filter((r: any) => __zmxIsPhysicalOpticalRow(r));
        console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] Table rows count:', tableRows.length, '(physical:', physicalRows.length + ')');

        const systemConfig = (typeof loadSystemConfigurations === 'function')
            ? loadSystemConfigurations()
            : null;
        if (!systemConfig || !Array.isArray(systemConfig.configurations) || systemConfig.configurations.length === 0) return;

        const activeId = systemConfig.activeConfigId;
        const activeCfg = systemConfig.configurations.find((c: any) => c && String(c.id) === String(activeId))
            || systemConfig.configurations[0];
        if (!activeCfg || !Array.isArray(activeCfg.blocks) || activeCfg.blocks.length === 0) return;

        console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] Active config has', activeCfg.blocks.length, 'blocks');

        const blockById = new Map<string, any>();
        for (const b of activeCfg.blocks) {
            const bid = String(b?.blockId ?? '').trim();
            if (!bid) continue;
            blockById.set(bid, b);
        }

        const provenanceUpdatedBlockIds = new Set<string>();
        let provenanceUpdateCount = 0;
        for (const row of tableRows) {
            const bid = String(row?._blockId ?? '').trim();
            const role = String(row?._surfaceRole ?? '').trim();
            if (!bid || !role) continue;
            const block = blockById.get(bid);
            if (!block) continue;
            const allowedKeys = __zmxGetApertureKeysByBlockType(block.blockType);
            if (!allowedKeys.includes(role)) continue;
            const semidia = __zmxReadPositiveFiniteSemidiaMm(row);
            if (semidia === null) continue;
            if (!block.aperture || typeof block.aperture !== 'object') block.aperture = {};
            block.aperture[role] = semidia;
            provenanceUpdatedBlockIds.add(bid);
            provenanceUpdateCount++;
            console.log(`[Provenance Sync] Block ${bid} (${block.blockType}) ${role} = ${semidia}mm`);
        }
        console.log(`[__zmxSyncDesignIntentApertureFromOpticalRows] Provenance-based updates: ${provenanceUpdateCount}`);

        const fallbackRows = tableRows.filter((row: any) => __zmxIsPhysicalOpticalRow(row));
        console.log(`[__zmxSyncDesignIntentApertureFromOpticalRows] Fallback physical rows: ${fallbackRows.length}`);
        let fallbackRowIndex = 0;
        let fallbackUpdateCount = 0;
        for (const block of activeCfg.blocks) {
            const apertureKeys = __zmxGetApertureKeysByBlockType(block?.blockType);
            if (apertureKeys.length === 0) continue;
            const bid = String(block?.blockId ?? '').trim();
            if (bid && provenanceUpdatedBlockIds.has(bid)) continue;

            if (!block.aperture || typeof block.aperture !== 'object') block.aperture = {};
            for (const key of apertureKeys) {
                const row = fallbackRows[fallbackRowIndex++];
                if (!row) break;
                const semidia = __zmxReadPositiveFiniteSemidiaMm(row);
                if (semidia === null) continue;
                block.aperture[key] = semidia;
                fallbackUpdateCount++;
                console.log(`[Fallback Sync] Block ${bid || 'unknown'} (${block.blockType}) ${key} = ${semidia}mm (row ${fallbackRowIndex - 1}: surf=${row.surf})`);
            }
        }
        console.log(`[__zmxSyncDesignIntentApertureFromOpticalRows] Fallback updates: ${fallbackUpdateCount}`);

        let expandSuccess = false;
        try {
            if (typeof expandBlocksIntoConfiguration === 'function') {
                const result = expandBlocksIntoConfiguration(activeCfg);
                expandSuccess = result && Array.isArray(result.expandedOpticalSystem);
                console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] expandBlocksIntoConfiguration result:', 
                    expandSuccess ? 'SUCCESS' : 'FAILED', 
                    result ? `(rows: ${result.expandedOpticalSystem?.length || 0}, issues: ${result.issues?.length || 0})` : '');
            } else if (typeof w.expandBlocksIntoConfiguration === 'function') {
                const result = w.expandBlocksIntoConfiguration(activeCfg);
                expandSuccess = result && Array.isArray(result.expandedOpticalSystem);
                console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] expandBlocksIntoConfiguration result:', 
                    expandSuccess ? 'SUCCESS' : 'FAILED',
                    result ? `(rows: ${result.expandedOpticalSystem?.length || 0}, issues: ${result.issues?.length || 0})` : '');
            }
        } catch (err) {
            console.error('[__zmxSyncDesignIntentApertureFromOpticalRows] expandBlocksIntoConfiguration ERROR:', err);
        }

        if (typeof saveSystemConfigurations === 'function') {
            saveSystemConfigurations(systemConfig);
            console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] ✅ Saved system configurations', expandSuccess ? '(with expanded blocks)' : '(WARNING: expand may have failed)');
        }

        console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] Final block apertures:', 
            activeCfg.blocks.map((b: any) => ({
                blockId: b.blockId,
                blockType: b.blockType,
                aperture: b.aperture
            })));

        if (expandSuccess && Array.isArray(activeCfg.opticalSystem)) {
            console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] Expanded opticalSystem sample (first 3):', 
                activeCfg.opticalSystem.slice(0, 3).map((r: any) => ({
                    surf: r?.surf,
                    type: r?.type,
                    semidia: r?.semidia,
                    _blockId: r?._blockId,
                    _surfaceRole: r?._surfaceRole
                })));

            if (tbl && typeof tbl.setData === 'function') {
                tbl.setData(activeCfg.opticalSystem);
                console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] ✅ Updated table with expanded rows');
            }

            try {
                saveOpticalSystemTableData(activeCfg.opticalSystem as any);
                console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] ✅ Saved expanded rows to localStorage');
            } catch (err) {
                console.error('[__zmxSyncDesignIntentApertureFromOpticalRows] ❌ Failed to save to localStorage:', err);
            }
        } else {
            console.warn('[__zmxSyncDesignIntentApertureFromOpticalRows] ⚠️ Skipping table/storage update due to expand failure');
        }

        try { refreshBlockInspector(); } catch (_) {}
        try { requestRefreshBlockInspector(); } catch (_) {}
        try { requestUpdateSurfaceNumberSelect(); } catch (_) {}
        try { if (typeof w.refreshAllUI === 'function') w.refreshAllUI(); } catch (_) {}
        console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] COMPLETE');
    } catch (err) {
        console.error('[__zmxSyncDesignIntentApertureFromOpticalRows] ERROR:', err);
    }
}

async function __loadAllDataObjectIntoApp(allData: any, options: { filename?: string } = {}): Promise<boolean> {
    const displayName = options?.filename || 'shared-link.json';

    // Normalize design data first
    try {
        if (typeof w.normalizeDesign === 'function') {
            const normalizedResult = w.normalizeDesign(allData);
            if (normalizedResult?.normalized) {
                allData = normalizedResult.normalized;
            }
        }
    } catch (_) {}

    // Build candidate configuration object (accept multiple legacy shapes)
    let candidateConfig: any = null;
    if (allData?.systemConfigurations && allData.systemConfigurations.configurations) {
        candidateConfig = allData.systemConfigurations;
    } else if (allData && allData.configurations && allData.configurations.configurations) {
        candidateConfig = allData.configurations;
    } else if (Array.isArray(allData?.configurations)) {
        candidateConfig = {
            configurations: allData.configurations,
            activeConfigId: allData.activeConfigId,
            meritFunction: allData.meritFunction || [],
            systemRequirements: allData.systemRequirements || [],
            optimizationRules: allData.optimizationRules || {}
        };
    } else if (Array.isArray(allData)) {
        candidateConfig = { configurations: allData };
    } else {
        candidateConfig = allData;
    }

    // Ensure candidateConfig has configurations array
    if (!candidateConfig || !Array.isArray(candidateConfig.configurations)) {
        console.error('❌ [Load] Invalid configurations format:', candidateConfig);
        return false;
    }

    // Ensure config IDs and activeConfigId
    try {
        let maxId = 0;
        for (let i = 0; i < candidateConfig.configurations.length; i++) {
            const cfg = candidateConfig.configurations[i];
            if (!cfg) continue;
            if (cfg.id === undefined || cfg.id === null || String(cfg.id).trim() === '') {
                cfg.id = i + 1;
            }
            const n = Number(cfg.id);
            if (Number.isFinite(n) && n > maxId) maxId = n;
        }
        if (!candidateConfig.activeConfigId) {
            candidateConfig.activeConfigId = candidateConfig.configurations[0]?.id ?? maxId ?? 1;
        }
    } catch (_) {}

    // If configurations are empty but legacy top-level data exists, build a single config
    try {
        if (Array.isArray(candidateConfig.configurations) && candidateConfig.configurations.length === 0) {
            const fallbackCfg: any = {
                id: 1,
                name: 'Config 1',
                schemaVersion: candidateConfig.schemaVersion || BLOCK_SCHEMA_VERSION,
                blocks: Array.isArray(allData?.blocks) ? allData.blocks : [],
                source: Array.isArray(allData?.source) ? allData.source : [],
                object: Array.isArray(allData?.object) ? allData.object : [],
                opticalSystem: Array.isArray(allData?.opticalSystem) ? allData.opticalSystem : [],
                meritFunction: Array.isArray(allData?.meritFunction) ? allData.meritFunction : [],
                systemData: allData?.systemData || { referenceFocalLength: '' },
                metadata: {
                    created: new Date().toISOString(),
                    modified: new Date().toISOString(),
                    locked: false
                }
            };
            candidateConfig.configurations.push(fallbackCfg);
            candidateConfig.activeConfigId = 1;
        }
    } catch (_) {}

    // Merge top-level data into active config if missing
    try {
        const activeId = candidateConfig.activeConfigId;
        const cfgs = candidateConfig.configurations || [];
        const activeCfg = cfgs.find((c: any) => String(c?.id ?? '') === String(activeId)) || cfgs[0];
        if (activeCfg) {
            if ((!activeCfg.source || activeCfg.source.length === 0) && Array.isArray(allData?.source)) {
                activeCfg.source = allData.source;
            }
            if ((!activeCfg.object || activeCfg.object.length === 0) && Array.isArray(allData?.object)) {
                activeCfg.object = allData.object;
            }
            if ((!activeCfg.opticalSystem || activeCfg.opticalSystem.length === 0) && Array.isArray(allData?.opticalSystem)) {
                activeCfg.opticalSystem = allData.opticalSystem;
            }
            if ((!activeCfg.systemData || typeof activeCfg.systemData !== 'object') && allData?.systemData) {
                activeCfg.systemData = allData.systemData;
            }
        }
        if (!candidateConfig.meritFunction && Array.isArray(allData?.meritFunction)) {
            candidateConfig.meritFunction = allData.meritFunction;
        }
        if (!candidateConfig.systemRequirements && Array.isArray(allData?.systemRequirements)) {
            candidateConfig.systemRequirements = allData.systemRequirements;
        }
    } catch (_) {}

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
            if (typeof w.deriveBlocksFromLegacyOpticalSystemRows === 'function') {
                const derived = w.deriveBlocksFromLegacyOpticalSystemRows(legacyRows);
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
                if (typeof w.validateBlocksConfiguration === 'function') {
                    const issues = w.validateBlocksConfiguration(cfg);
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
            
            if (typeof w.expandBlocksToOpticalSystemRows === 'function') {
                const expanded = w.expandBlocksToOpticalSystemRows(activeCfg.blocks);
                
                if (Array.isArray(legacyBeforeExpand) && legacyBeforeExpand.length > 0) {
                    // Preserve legacy surface data and overlay provenance
                    try {
                        if (typeof w.__blocks_overlayExpandedProvenanceIntoLegacyRows === 'function') {
                            w.__blocks_overlayExpandedProvenanceIntoLegacyRows(legacyBeforeExpand, expanded.rows);
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
        saveSystemConfigurations(candidateConfig);
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
            // Prefer activeConfig source/object if available
            if (activeCfg.source && Array.isArray(activeCfg.source) && activeCfg.source.length > 0) {
                effectiveSource = activeCfg.source;
            }
            if (activeCfg.object && Array.isArray(activeCfg.object) && activeCfg.object.length > 0) {
                effectiveObject = activeCfg.object;
            }
            if (!effectiveOpticalSystem && activeCfg.opticalSystem) effectiveOpticalSystem = activeCfg.opticalSystem;
        }
        if (!effectiveMeritFunction && candidateConfig?.meritFunction) effectiveMeritFunction = candidateConfig.meritFunction;
        if (!effectiveSystemRequirements && candidateConfig?.systemRequirements) effectiveSystemRequirements = candidateConfig.systemRequirements;
    } catch (_) {}

    // Save to localStorage for table loading
    try {
        if (effectiveSource) {
            saveSourceTableData(effectiveSource as any);
        }
    } catch (_) {}

    try {
        if (effectiveObject) {
            saveObjectTableData(effectiveObject as any);
        }
    } catch (_) {}

    try {
        if (effectiveOpticalSystem) {
            saveOpticalSystemTableData(effectiveOpticalSystem as any);
        }
    } catch (_) {}

    try {
        if (effectiveSystemRequirements) {
            saveSystemRequirementsTableData(effectiveSystemRequirements as any);
        }
    } catch (_) {}

    try {
        if (effectiveMeritFunction) {
            saveMeritFunctionTableData(effectiveMeritFunction as any);
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
        try {
            const { setLoadedFileState } = await import('./loaded-file-storage.ts');
            setLoadedFileState(displayName, warn);
        } catch (_) {
            // ignore
        }
        const fileNameElement = document.getElementById('loaded-file-name');
        if (fileNameElement) {
            fileNameElement.textContent = displayName;
            fileNameElement.style.color = warn ? '#b45309' : '#1a4d8f';
            if (warn && !fileNameElement.textContent.includes('(surfaces only)')) {
                fileNameElement.textContent = `${fileNameElement.textContent} (surfaces only)`;
            }
        }
        try {
            window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
        } catch (_) {}
    } catch (_) {}

    try {
        setTimeout(() => {
            try {
                if (typeof loadActiveConfigurationToTables === 'function') {
                    loadActiveConfigurationToTables();
                }
            } catch (_) {}
            try {
                const sourceData = loadSourceTableData();
                const tableSource = w.tableSource;
                if (tableSource && typeof tableSource.replaceData === 'function') {
                    tableSource.replaceData(sourceData);
                } else if (tableSource && typeof tableSource.setData === 'function') {
                    tableSource.setData(sourceData);
                }
            } catch (_) {}
            try {
                const objectData = loadObjectTableData();
                const tableObject = w.tableObject;
                if (tableObject && typeof tableObject.replaceData === 'function') {
                    tableObject.replaceData(objectData);
                } else if (tableObject && typeof tableObject.setData === 'function') {
                    tableObject.setData(objectData);
                }
            } catch (_) {}
            try {
                const opticalData = loadOpticalSystemTableData();
                const tableOptical = w.tableOpticalSystem || w.opticalSystemTabulator;
                if (tableOptical && typeof tableOptical.replaceData === 'function') {
                    tableOptical.replaceData(opticalData);
                } else if (tableOptical && typeof tableOptical.setData === 'function') {
                    tableOptical.setData(opticalData);
                }
            } catch (_) {}
            try {
                const meritData = loadMeritFunctionTableData();
                const meritEditor = w.meritFunctionEditor;
                if (meritEditor && typeof meritEditor.setData === 'function') {
                    meritEditor.setData(meritData);
                }
            } catch (_) {}
            try {
                const runRequirementSyncSequence = async () => {
                    const reqEditor = w.systemRequirementsEditor;
                    if (!reqEditor) return;

                    const reqData = loadSystemRequirementsTableData();
                    if (typeof reqEditor.setData === 'function') {
                        reqEditor.setData(reqData);
                    }

                    const evaluateNow = async (reason: string) => {
                        try {
                            if (typeof reqEditor.evaluateAndUpdateNow === 'function') {
                                const p = reqEditor.evaluateAndUpdateNow({ reason, forceSilent: true, silent: true });
                                if (p && typeof p.then === 'function') {
                                    await p;
                                }
                            }
                        } catch (_) {}
                    };

                    await evaluateNow('load-file-seq-initial');

                    if (typeof reqEditor.scheduleEvaluateAndUpdate === 'function') {
                        reqEditor.scheduleEvaluateAndUpdate();
                    }

                    for (let i = 0; i < 4; i++) {
                        await new Promise((resolve) => setTimeout(resolve, 120));
                        await evaluateNow(`load-file-seq-retry-${i + 1}`);
                    }

                    try {
                        window.dispatchEvent(new CustomEvent('coopt:requirements-updated'));
                    } catch (_) {}
                };

                void runRequirementSyncSequence();
            } catch (_) {}
            try { refreshBlockInspector(); } catch (_) {}
            try {
                if (typeof w.updateTransformSurfaceSelect === 'function') {
                    w.updateTransformSurfaceSelect();
                }
            } catch (_) {}
            
            // Wait for config-select element to be available, then initialize Configuration UI
            const waitForConfigSelect = () => {
                const selectElement = document.getElementById('config-select');
                if (selectElement && typeof w.initializeConfigurationUI === 'function') {
                    w.initializeConfigurationUI();
                } else {
                    setTimeout(waitForConfigSelect, 100);
                }
            };
            waitForConfigSelect();
        }, 0);
    } catch (_) {}

    return true;
}

// Expose loader for React toolbar handlers
if (typeof window !== 'undefined') {
    try {
        w.__loadAllDataObjectIntoApp = __loadAllDataObjectIntoApp;
        w.autoCalculateMissingSemidia = autoCalculateMissingSemidia;
    } catch (_) {}
}

function isReactManagedButton(el: HTMLElement | null): boolean {
    if (!el) return false;
    return el.getAttribute('data-react-handled') === '1';
}

function setupLoadAllButton(): void {
    const btn = document.getElementById('load-all-btn');
    if (!btn) return;
    if (isReactManagedButton(btn as HTMLElement)) return;

    const loadHandler = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.style.display = 'none';
        
        input.addEventListener('change', async (e: Event) => {
            const target = e.target as HTMLInputElement;
            const file = target?.files?.[0];
            
            // Remove input from DOM after file selection
            try {
                if (input.parentNode) {
                    input.parentNode.removeChild(input);
                }
            } catch (_) {}
            
            if (!file) {
                console.warn('⚠️ [Load] No file selected');
                return;
            }

            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                await __loadAllDataObjectIntoApp(parsed, { filename: file.name });
            } catch (err) {
                console.error('❌ Load failed:', err);
                alert(`Load failed: ${(err as Error)?.message || String(err)}`);
            }
        });
        
        // Add to DOM before triggering click
        document.body.appendChild(input);
        input.click();
    };
    
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', loadHandler);
}

// Setup Zemax Import Button
function __coopt_isInfLike(value: any): boolean {
    if (value === Infinity) return true;
    const s = String(value ?? '').trim().toUpperCase();
    return s === 'INF' || s === 'INFINITY' || s === '∞';
}

function __coopt_buildFallbackBlocksFromRows(rows: any[]): any[] {
    const safeRows = Array.isArray(rows) ? rows : [];
    const blocks: any[] = [];

    const inferImageSemidia = (): number | null => {
        for (let idx = safeRows.length - 1; idx >= 0; idx--) {
            const row = safeRows[idx] || {};
            const raw = row?.semidia ?? row?.semiDiameter ?? row?.semiDia ?? row?.['semi diameter'] ?? row?.['Semi Diameter'];
            const n = Number(raw);
            if (Number.isFinite(n) && n > 0) return n;
        }
        return null;
    };

    const first = safeRows[0] || {};
    const objectDistanceMode = __coopt_isInfLike(first?.thickness) ? 'INF' : 'Finite';
    const objectDistanceVal = Number(first?.thickness);
    blocks.push({
        blockId: 'ObjectSurface-1',
        blockType: 'ObjectSurface',
        role: null,
        constraints: {},
        parameters: objectDistanceMode === 'INF'
            ? { objectDistanceMode: 'INF' }
            : { objectDistanceMode: 'Finite', objectDistance: Number.isFinite(objectDistanceVal) ? objectDistanceVal : 10 },
        variables: {},
        metadata: { source: 'zemax-fallback' }
    });

    let stopCount = 0;
    let singleCount = 0;
    let gapCount = 0;

    const end = Math.max(1, safeRows.length - 1);
    for (let i = 1; i < end; i++) {
        const row = safeRows[i] || {};
        const objType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
        const isStop = objType === 'stop' || objType === 'sto';

        if (isStop) {
            stopCount++;
            const sdNum = Number(row?.semidia);
            blocks.push({
                blockId: `Stop-${stopCount}`,
                blockType: 'Stop',
                role: null,
                constraints: {},
                parameters: Number.isFinite(sdNum) && sdNum > 0 ? { semiDiameter: sdNum } : {},
                variables: {},
                metadata: { source: 'zemax-fallback' }
            });

            const tRaw = row?.thickness;
            const tNum = Number(tRaw);
            const hasGap = __coopt_isInfLike(tRaw) || (Number.isFinite(tNum) && Math.abs(tNum) > 1e-12);
            if (hasGap) {
                gapCount++;
                blocks.push({
                    blockId: `Gap-${gapCount}`,
                    blockType: 'Gap',
                    role: null,
                    constraints: {},
                    parameters: { thickness: __coopt_isInfLike(tRaw) ? 'INF' : tNum, material: 'AIR' },
                    variables: {},
                    metadata: { source: 'zemax-fallback', from: 'stop-thickness' }
                });
            }
            continue;
        }

        singleCount++;
        const surfTypeRaw = String(row?.surfType ?? '').trim();
        const surfType = surfTypeRaw || 'Spherical';
        const radius = __coopt_isInfLike(row?.radius) ? 'INF' : (String(row?.radius ?? '').trim() === '' ? 'INF' : row.radius);
        const tRaw = row?.thickness;
        const tNum = Number(tRaw);
        const thickness = __coopt_isInfLike(tRaw) ? 'INF' : (Number.isFinite(tNum) ? tNum : 0);
        const material = String(row?.material ?? '').trim();
        const conicNum = Number(row?.conic);

        const params: any = {
            radius,
            thickness,
            material,
            surfType,
            conic: Number.isFinite(conicNum) ? conicNum : 0,
            semidia: row?.semidia ?? ''
        };

        if (surfType === 'Toric') {
            params.radiusX = __coopt_isInfLike(row?.radiusX) ? 'INF' : (String(row?.radiusX ?? '').trim() === '' ? 'INF' : row.radiusX);
            params.radiusY = __coopt_isInfLike(row?.radiusY) ? 'INF' : (String(row?.radiusY ?? '').trim() === '' ? 'INF' : row.radiusY);
            const axisNum = Number(row?.axis);
            params.axis = Number.isFinite(axisNum) ? axisNum : 0;
        }

        for (let k = 1; k <= 10; k++) {
            const n = Number(row?.[`coef${k}`]);
            params[`coef${k}`] = Number.isFinite(n) ? n : 0;
        }

        blocks.push({
            blockId: `SingleSurface-${singleCount}`,
            blockType: 'SingleSurface',
            role: null,
            constraints: {},
            parameters: params,
            variables: {},
            metadata: { source: 'zemax-fallback', rowIndex: i }
        });
    }

    const imageSemidia = inferImageSemidia();
    blocks.push({
        blockId: 'ImageSurface-1',
        blockType: 'ImageSurface',
        role: null,
        constraints: {},
        parameters: Number.isFinite(imageSemidia as any) && (imageSemidia as number) > 0
            ? { semidia: imageSemidia, semidiaMode: 'Auto', optimizeSemiDia: 'A' }
            : { semidiaMode: 'Auto', optimizeSemiDia: 'A' },
        variables: {},
        metadata: { source: 'zemax-fallback' }
    });

    return blocks;
}

function __coopt_normalizeObjectDistanceInBlocks(blocks: any[]): any[] {
    if (!Array.isArray(blocks)) return [];

    let hasObjectSurface = false;
    for (const block of blocks) {
        if (!block || block.blockType !== 'ObjectSurface') continue;
        hasObjectSurface = true;
        const params = (block.parameters && typeof block.parameters === 'object')
            ? block.parameters
            : (block.parameters = {});

        const modeRaw = String(params.objectDistanceMode ?? '').trim();
        const infMode = __coopt_isInfLike(modeRaw);
        if (infMode) {
            params.objectDistanceMode = 'INF';
            const dInf = Number(params.objectDistance);
            params.objectDistance = Number.isFinite(dInf) ? dInf : 10;
            continue;
        }

        params.objectDistanceMode = 'Finite';
        const d = Number(params.objectDistance);
        params.objectDistance = Number.isFinite(d) ? d : 10;
    }

    if (!hasObjectSurface) {
        blocks.unshift({
            blockId: 'ObjectSurface-1',
            blockType: 'ObjectSurface',
            role: null,
            constraints: {},
            parameters: { objectDistanceMode: 'Finite', objectDistance: 10 },
            variables: {},
            metadata: { source: 'zemax-fallback', inserted: true }
        });
    }

    return blocks;
}

function __buildZemaxLoadPayload(parsed: any): any {
    if (parsed && Array.isArray(parsed.configurations)) {
        return parsed;
    }

    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const sourceRows = Array.isArray(parsed?.sourceRows) ? parsed.sourceRows : [];
    const objectRows = Array.isArray(parsed?.objectRows) ? parsed.objectRows : [];

    let blocks: any[] = [];
    try {
        const derived = deriveBlocksFromLegacyOpticalSystemRows(rows);
        const fatals = Array.isArray(derived?.issues)
            ? derived.issues.filter((it: any) => it?.severity === 'fatal')
            : [];
        if (Array.isArray(derived?.blocks) && derived.blocks.length > 0 && fatals.length === 0) {
            blocks = __coopt_normalizeObjectDistanceInBlocks(derived.blocks);
        } else {
            blocks = __coopt_normalizeObjectDistanceInBlocks(__coopt_buildFallbackBlocksFromRows(rows));
            if (fatals.length > 0) {
                console.warn('⚠️ [Zemax Import] deriveBlocks had fatals; fallback blocks generated:', fatals);
            }
        }
    } catch (e) {
        console.warn('⚠️ [Zemax Import] deriveBlocks failed; fallback blocks generated:', e);
        blocks = __coopt_normalizeObjectDistanceInBlocks(__coopt_buildFallbackBlocksFromRows(rows));
    }

    const now = new Date().toISOString();
    return {
        configurations: [{
            id: 1,
            name: 'Config 1',
            schemaVersion: BLOCK_SCHEMA_VERSION,
            blocks,
            source: sourceRows,
            object: objectRows,
            opticalSystem: rows,
            meritFunction: [],
            systemData: { referenceFocalLength: '' },
            metadata: {
                created: now,
                modified: now,
                locked: false,
                importedFrom: 'zemax'
            }
        }],
        activeConfigId: 1,
        meritFunction: [],
        systemRequirements: [],
        optimizationRules: {}
    };
}

function __normalizeZmxFilenameDefault(name: string | null | undefined): string {
    const raw = String(name ?? '').trim().replace(/\s*\(surfaces only\)\s*$/i, '');
    if (!raw) return 'co-opt-export.zmx';

    if (/\.json$/i.test(raw)) {
        return raw.replace(/\.json$/i, '.zmx');
    }
    if (/\.zmx$/i.test(raw)) {
        return raw;
    }
    return `${raw}.zmx`;
}

function setupImportZemaxButton(): void {
    const btn = document.getElementById('import-zemax-btn');
    if (!btn) return;
    if (isReactManagedButton(btn as HTMLElement)) return;

    const importHandler = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zmx';
        input.addEventListener('change', async (e: Event) => {
            const target = e.target as HTMLInputElement;
            const file = target?.files?.[0];

            try {
                if (input.parentNode) input.parentNode.removeChild(input);
            } catch (_) {}

            if (!file) return;

            try {
                console.log('📥 [Zemax Import] Selected file:', file.name, `(${file.size} bytes)`);
                const arrayBuffer = await file.arrayBuffer();
                const parsed: any = parseZMXArrayBufferToOpticalSystemRows(arrayBuffer);

                if (!parsed || typeof parsed !== 'object') {
                    throw new Error('Invalid Zemax parse result.');
                }

                console.log('📥 [Zemax Import] Parsed:', {
                    rows: Array.isArray(parsed?.rows) ? parsed.rows.length : 0,
                    sourceRows: Array.isArray(parsed?.sourceRows) ? parsed.sourceRows.length : 0,
                    objectRows: Array.isArray(parsed?.objectRows) ? parsed.objectRows.length : 0,
                    issues: Array.isArray(parsed?.issues) ? parsed.issues.length : 0
                });

                const payload = __buildZemaxLoadPayload(parsed);
                const loaded = await __loadAllDataObjectIntoApp(payload, { filename: file.name });
                if (!loaded) {
                    throw new Error('Zemax import parsed, but app load step returned false.');
                }

                // Explicitly load active configuration to tables before semidia calculation
                // (__loadAllDataObjectIntoApp uses setTimeout, so table may not be loaded yet)
                // IMPORTANT: Must use the async version from table-configuration.ts with applyToUI: true
                try {
                    const { loadActiveConfigurationToTables: loadConfigToTables } = await import('../data/table-configuration.ts');
                    if (typeof loadConfigToTables === 'function') {
                        await loadConfigToTables({ applyToUI: true });
                        console.log('[Zemax Import] ✅ Loaded active configuration to tables (UI updated)');
                    }
                } catch (err) {
                    console.error('[Zemax Import] ❌ Failed to load configuration to tables:', err);
                }

                try {
                    const parsedRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
                    const parsedStopIndex = parsedRows.findIndex((r: any) => {
                        const ot = String(r?.['object type'] ?? r?.object ?? '').trim().toLowerCase();
                        return ot === 'stop';
                    });
                    const stopSemidiaWasMissing = (() => {
                        if (parsedStopIndex < 0) return false;
                        const stopRow = parsedRows[parsedStopIndex] || {};
                        const raw = stopRow?.semidia ?? stopRow?.semiDiameter ?? stopRow?.semiDia ?? stopRow?.['semi diameter'] ?? stopRow?.['Semi Diameter'];
                        if (raw === null || raw === undefined) return true;
                        const s = String(raw).trim();
                        if (s === '') return true;
                        const n = Number(s);
                        return !(Number.isFinite(n) && n > 0);
                    })();

                    autoCalculateMissingSemidia(
                        Array.isArray(parsed?.sourceRows) ? parsed.sourceRows : [],
                        Array.isArray(parsed?.objectRows) ? parsed.objectRows : [],
                        {
                            entrancePupilDiameterMm: Number(parsed?.entrancePupilDiameterMm),
                            stopSemidiaWasMissing
                        }
                    );
                } catch (_) {}

                try {
                    if (typeof w.calculateImageSemiDiaFromChiefRays === 'function') {
                        const tryAutoImageSemidia = (triesLeft: number) => {
                            setTimeout(() => {
                                try {
                                    Promise.resolve(w.calculateImageSemiDiaFromChiefRays())
                                        .then((ok: any) => {
                                            if (ok === true) {
                                                try { refreshBlockInspector(); } catch (_) {}
                                                try { if (typeof w.refreshAllUI === 'function') w.refreshAllUI(); } catch (_) {}
                                                return;
                                            }
                                            if (triesLeft > 0) {
                                                tryAutoImageSemidia(triesLeft - 1);
                                            }
                                        })
                                        .catch(() => {
                                            if (triesLeft > 0) {
                                                tryAutoImageSemidia(triesLeft - 1);
                                            }
                                        });
                                } catch (_) {
                                    if (triesLeft > 0) {
                                        tryAutoImageSemidia(triesLeft - 1);
                                    }
                                }
                            }, 200);
                        };
                        tryAutoImageSemidia(4);
                    }
                } catch (_) {}

                try {
                    __zmxSyncDesignIntentApertureFromOpticalRows();
                } catch (_) {}

                console.log('✅ [Zemax Import] Completed:', file.name);
            } catch (err) {
                console.error('❌ Zemax import failed:', err);
                alert(`Import failed: ${(err as Error)?.message || String(err)}`);
            }
        });
        document.body.appendChild(input);
        input.click();
    };
    
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', importHandler);
}

// Setup Zemax Export Button
function setupExportZemaxButton(): void {
    const btn = document.getElementById('export-zemax-btn');
    if (!btn) return;
    if (isReactManagedButton(btn as HTMLElement)) return;

    const exportHandler = async () => {
        try {
            // Get optical system rows from table
            const opticalSystemRows = w.getOpticalSystemRows ? w.getOpticalSystemRows(w.tableOpticalSystem) : [];
            const sourceRows = w.tableSource && typeof w.tableSource.getData === 'function' ? w.tableSource.getData() : [];
            const objectRows = w.tableObject && typeof w.tableObject.getData === 'function' ? w.tableObject.getData() : [];
            
            if (!opticalSystemRows || opticalSystemRows.length === 0) {
                alert('No optical system data to export');
                return;
            }

            let loadedFileName: string | null = null;
            try {
                const loadedFileStorage = await import('./loaded-file-storage.ts');
                loadedFileName = loadedFileStorage.getLoadedFileName();
            } catch (_) {
                try {
                    loadedFileName = w.__cooptLoadedFileStorage?.getLoadedFileName?.() ?? null;
                } catch (_) {}
            }
            const defaultFilename = __normalizeZmxFilenameDefault(loadedFileName);

            let filename = prompt(
                'Zemaxエクスポートのファイル名を入力してください（.zmx は自動補完）',
                defaultFilename
            );
            if (!filename) return;
            filename = filename.trim();
            if (!filename) return;
            if (!/\.zmx$/i.test(filename)) filename += '.zmx';
            
            // Generate ZMX text
            if (typeof w.generateZMXText === 'function') {
                const zmxText = w.generateZMXText(opticalSystemRows, {
                    sourceRows,
                    objectRows
                });
                
                // Download the file
                if (typeof w.downloadZMX === 'function') {
                    w.downloadZMX(zmxText, filename);
                    console.log('✅ Zemax file exported successfully');
                } else {
                    console.error('❌ downloadZMX function not available');
                    alert('Export function not available');
                }
            } else {
                console.error('❌ generateZMXText function not available');
                alert('Export function not available');
            }
        } catch (err) {
            console.error('❌ Zemax export failed:', err);
            alert(`Export failed: ${(err as Error)?.message || String(err)}`);
        }
    };
    
    const newBtn = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', exportHandler);
}

// Setup Optimization Buttons
function setupOptimizeDesignIntentButton(): void {
    const optimizeBtn = document.getElementById('optimize-design-intent-btn') as HTMLButtonElement | null;
    if (!optimizeBtn) return;
    if (isReactManagedButton(optimizeBtn)) return;

    optimizeBtn.addEventListener('click', async () => {
        const _gThis = (typeof globalThis !== 'undefined') ? globalThis as any : {} as any;
        const isRunningFlag = !!_gThis.__cooptOptimizerIsRunning;
        const schedulerWindow = _gThis.__cooptOptimizerSchedulerWindow;
        const isStaleRunning = isRunningFlag && (!schedulerWindow || schedulerWindow.closed);

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
            if (isTauriRuntime()) {
                const opticalSystemRows = (w.getOpticalSystemRows && w.tableOpticalSystem)
                    ? w.getOpticalSystemRows(w.tableOpticalSystem)
                    : ((w.tableOpticalSystem && typeof w.tableOpticalSystem.getData === 'function') ? w.tableOpticalSystem.getData() : []);

                if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
                    alert('最適化対象の光学系データがありません。');
                    return;
                }

                const systemRequirementsRows = (() => {
                    try {
                        const sre = (window as any).systemRequirementsEditor;
                        if (sre && typeof sre.getData === 'function') {
                            const rows = sre.getData();
                            if (Array.isArray(rows)) return rows;
                        }
                    } catch (_) {}
                    return [];
                })();

                const sourceRows = (w.tableSource && typeof w.tableSource.getData === 'function')
                    ? w.tableSource.getData()
                    : [];
                const objectRows = (w.tableObject && typeof w.tableObject.getData === 'function')
                    ? w.tableObject.getData()
                    : [];
                const activeConfigId = (() => {
                    try {
                        const cfg = (typeof w.loadSystemConfigurationsFromTableConfig === 'function')
                            ? w.loadSystemConfigurationsFromTableConfig()
                            : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
                        if (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null) {
                            return String(cfg.activeConfigId).trim();
                        }
                    } catch (_) {}
                    return '';
                })();

                const opt = w.OptimizationMVP;
                if (!opt || typeof opt.run !== 'function') {
                    alert('OptimizationMVP が利用できません。');
                    return;
                }

                const progressEvents: any[] = [];
                const result = await opt.run({
                    opticalSystemRows,
                    sourceRows,
                    objectRows,
                    activeConfigId,
                    systemRequirementsRows,
                    maxIterations: 24,
                    method: 'kkt',
                    forceTs: true,
                    onProgress: (ev: any) => {
                        if (!ev || typeof ev !== 'object') return;
                        progressEvents.push(ev);
                    },
                });

                if (Array.isArray(progressEvents) && progressEvents.length > 0) {
                    console.log('📈 [Optimize][TS][Progress]', progressEvents.slice(-8));
                }

                try {
                    if (typeof (window as any).drawOpticalSystem === 'function') {
                        (window as any).drawOpticalSystem();
                    }
                } catch (applyErr) {
                    console.warn('⚠️ [Optimize][TS] result apply failed:', applyErr);
                }

                const modeUsed = String(result?.method || 'kkt');
                const iterations = Number(result?.iterations ?? 0);
                const variableCount = Number(result?.variables ?? 0);
                const meritBefore = Number(result?.before ?? Number.NaN);
                const meritAfter = Number(result?.best ?? Number.NaN);
                const requirementScoreAfter = Number(result?.violationScore ?? Number.NaN);
                const converged = !result?.aborted;

                alert(
                    [
                        'TS optimizer step completed',
                        `mode: ${modeUsed}`,
                        `iterations: ${iterations}`,
                        `variables: ${variableCount}`,
                        `merit: ${Number.isFinite(meritBefore) ? meritBefore.toFixed(6) : 'NaN'} -> ${Number.isFinite(meritAfter) ? meritAfter.toFixed(6) : 'NaN'}`,
                        `requirements: ${Number.isFinite(requirementScoreAfter) ? requirementScoreAfter.toFixed(6) : 'NaN'}`,
                        converged ? 'status: converged' : 'status: in-progress',
                    ].join('\n')
                );
                return;
            }

            const opt = w.OptimizationMVP;
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
                const systemConfig = (typeof w.loadSystemConfigurationsFromTableConfig === 'function')
                    ? w.loadSystemConfigurationsFromTableConfig()
                    : loadSystemConfigurations();
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
            let popupWatchTimer: any = null;
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
<div style="display:flex; align-items:center; gap:10px; flex-wrap:nowrap; white-space:nowrap; margin-bottom:8px;">
    <div style="font-size:14px; font-weight:600; flex:0 0 auto;">Optimize Progress</div>
    <div id="opt-startup-progress-wrap" style="display:flex; align-items:center; gap:8px; flex:1 1 auto; min-width:0; margin:0;">
        <div style="height:6px; background:#eceef2; border-radius:999px; overflow:hidden; flex:1 1 auto; min-width:120px;">
            <div id="opt-startup-progress-bar" style="width:0%; height:100%; background:#4f8cff; transition:width 120ms linear;"></div>
        </div>
        <div id="opt-startup-progress-label" style="font-size:11px; color:#666; flex:0 0 auto;">Idle</div>
    </div>
</div>
<div style="font-size:12px; color:#555; margin-bottom:10px; white-space:nowrap;">Updates per candidate evaluation (±step)</div>
<div style="margin-bottom:10px; display:flex; align-items:center; gap:6px;">
    <button id="opt-run" style="padding:6px 10px;">Run</button>
    <button id="opt-stop" style="padding:6px 10px;" disabled>Stop</button>
    <span id="opt-stop-state" style="margin-left:8px; font-size:12px; color:#555;"></span>
</div>
<div style="margin-bottom:10px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        Method
        <select id="opt-method" style="padding:4px 6px;">
            <option value="kkt" selected>Augmented Lagrangian (AL)</option>
            <option value="lm">Levenberg-Marquardt (LM)</option>
            <option value="cd">Coordinate Descent (CD)</option>
        </select>
    </label>
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        Max Iterations
        <input id="opt-max-iter" type="number" min="1" step="1" value="5000" style="width:100px; padding:4px 6px;" />
    </label>
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        Convergence
        <select id="opt-convergence-profile" style="padding:4px 6px;">
            <option value="fast">Fast</option>
            <option value="balanced" selected>Balanced</option>
            <option value="deep">Deep</option>
        </select>
    </label>
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        <input id="opt-auto-render" type="checkbox" checked style="width:16px; height:16px;" />
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
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">ReqScore(active)</span><span id="opt-cur" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Violation</span><span id="opt-vio" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Soft</span><span id="opt-soft" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Best</span><span id="opt-best" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Penalty ρ</span><span id="opt-rho" style="margin-left:8px;">-</span></div>
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
        <input id="opt-stage-stall-limit" type="number" step="1" value="5" style="width:120px; padding:4px 6px;" />
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
                                try { (globalThis as any).__cooptLastUiStopReason = 'popup-stop-button'; } catch (_) {}
                                try {
                                    const _opt = w.OptimizationMVP;
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
                                    if (stopState) stopState.textContent = 'Running...';
                                    const phaseEl = popup?.document?.getElementById('opt-phase');
                                    if (phaseEl && String(phaseEl.textContent || '').trim() === '-') {
                                        phaseEl.textContent = 'starting';
                                    }
                                    const startupWrap = popup?.document?.getElementById('opt-startup-progress-wrap') as HTMLElement | null;
                                    const startupBar = popup?.document?.getElementById('opt-startup-progress-bar') as HTMLElement | null;
                                    const startupLabel = popup?.document?.getElementById('opt-startup-progress-label') as HTMLElement | null;
                                    if (startupWrap) startupWrap.style.display = 'block';
                                    if (startupBar) startupBar.style.width = '5%';
                                    if (startupLabel) startupLabel.textContent = 'Run clicked. Preparing...';
                                    if (runBtn) runBtn.disabled = true;
                                    if (stopBtn) stopBtn.disabled = false;
                                } catch (_) {}
                                try {
                                    const fn = w.__cooptStartOptimizationFromPopup;
                                    if (typeof fn === 'function') {
                                        window.requestAnimationFrame(() => {
                                            window.setTimeout(() => {
                                                try { fn(); } catch (_) {}
                                            }, 0);
                                        });
                                    }
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
                                try { (globalThis as any).__cooptLastUiStopReason = 'popup-closed-watchdog'; } catch (_) {}
                                try {
                                    const _opt = w.OptimizationMVP;
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
            let currentConvergenceProfile = 'balanced';
            let __lastReqRefreshAt = 0;
            const __reqRefreshThrottleMs = 500;
            let optimizerWasmWarmupPromise: Promise<void> | null = null;
            let runClickAtMs = 0;
            let startupLatencyReported = false;
            let finalAutoRenderRequested = false;

            const warmupOptimizerStartup = (forceWasm = false) => {
                try {
                    if (typeof w.__cooptInitMeritFunctionEditor === 'function') {
                        w.__cooptInitMeritFunctionEditor();
                    }
                } catch (_) {}
                void forceWasm;
                if (optimizerWasmWarmupPromise) return;

                optimizerWasmWarmupPromise = import('../rust-wasm/ts/optimization/optimizer-wasm-bridge.ts')
                    .then((mod: any) => {
                        if (mod && typeof mod.preloadOptimizerWasmBridge === 'function') {
                            return mod.preloadOptimizerWasmBridge();
                        }
                        return null;
                    })
                    .then(() => undefined)
                    .catch(() => undefined);
            };

            try {
                window.setTimeout(() => warmupOptimizerStartup(false), 0);
            } catch (_) {}

            const refreshPreRunScore = async () => {
                let score = NaN;
                let reqCount = NaN;
                try {
                    const sre = w.systemRequirementsEditor;
                    if (sre && typeof sre.evaluateAndUpdateNow === 'function') {
                        const r = sre.evaluateAndUpdateNow({ reason: 'optimize-progress-prerun' });
                        if (r && typeof (r as any).then === 'function') {
                            await r;
                        }
                    }

                    const rows = (() => {
                        try {
                            if (sre && typeof sre.getData === 'function') {
                                const d = sre.getData();
                                if (Array.isArray(d)) return d;
                            }
                        } catch (_) {}
                        try {
                            if (sre && Array.isArray((sre as any).requirements)) {
                                return (sre as any).requirements;
                            }
                        } catch (_) {}
                        return [];
                    })();

                    const activeConfigId = (() => {
                        try {
                            const cfg = (typeof w.loadSystemConfigurationsFromTableConfig === 'function')
                                ? w.loadSystemConfigurationsFromTableConfig()
                                : (typeof w.loadSystemConfigurations === 'function' ? w.loadSystemConfigurations() : null);
                            if (cfg && cfg.activeConfigId !== undefined && cfg.activeConfigId !== null) {
                                return String(cfg.activeConfigId).trim();
                            }
                        } catch (_) {}
                        return '';
                    })();

                    const normalizeConfigId = (row: any): string => {
                        try {
                            if (sre && typeof sre._normalizeConfigId === 'function') {
                                return String(sre._normalizeConfigId(row?.configId, cfg, activeConfigId) || '').trim();
                            }
                        } catch (_) {}
                        const rawCfg = String(row?.configId ?? '').trim();
                        return rawCfg || activeConfigId;
                    };

                    const isActiveRequirement = (row: any): boolean => {
                        if (!row || typeof row !== 'object') return false;
                        const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
                        const operand = String(row.operand ?? '').trim();
                        const weight = Number(row.weight ?? 1);
                        if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) return false;
                        const reqCfg = normalizeConfigId(row);
                        if (!activeConfigId) return true;
                        return reqCfg === activeConfigId;
                    };

                    const activeRows = Array.isArray(rows) ? rows.filter((r: any) => isActiveRequirement(r)) : [];
                    reqCount = activeRows.length;
                    if (activeRows.length > 0) {
                        let s = 0;
                        let finiteCount = 0;
                        for (const row of activeRows) {
                            const c = Number(row?._contribution);
                            if (Number.isFinite(c)) {
                                if (c > 0) s += c;
                                finiteCount += 1;
                            }
                        }
                        if (finiteCount > 0 && Number.isFinite(s)) score = s;
                    }
                } catch (_) {}

                if (!Number.isFinite(score)) {
                    score = NaN;
                }

                if (!popup || popup.closed) return;
                try {
                    const doc = popup.document;
                    const curEl = doc.getElementById('opt-cur');
                    const bestEl = doc.getElementById('opt-best');
                    const reqEl = doc.getElementById('opt-req');
                    const vioEl = doc.getElementById('opt-vio');
                    const softEl = doc.getElementById('opt-soft');
                    const phaseEl = doc.getElementById('opt-phase');
                    if (curEl) curEl.textContent = Number.isFinite(score) ? score.toFixed(6) : '-';
                    if (bestEl) bestEl.textContent = Number.isFinite(score) ? score.toFixed(6) : '-';
                    if (reqEl && Number.isFinite(reqCount)) reqEl.textContent = String(Math.max(0, Math.floor(reqCount)));
                    if (vioEl) vioEl.textContent = Number.isFinite(score) ? score.toFixed(6) : '-';
                    if (softEl) softEl.textContent = Number.isFinite(score) ? '0.000000' : '-';
                    if (phaseEl && String(phaseEl.textContent || '').trim() === '-') {
                        phaseEl.textContent = 'ready';
                    }
                } catch (_) {}
            };

            const ensureRenderPopupAndDraw = () => {
                try {
                    const renderPopup = w.popup3DWindow;
                    const hasOpenRenderPopup = !!(renderPopup && !renderPopup.closed);

                    if (!hasOpenRenderPopup) {
                        const openRender = (w as any).__cooptOpenRenderWindow || (window as any).__cooptOpenRenderWindow;
                        if (isTauriRuntime() && typeof openRender === 'function') {
                            void Promise.resolve(openRender());
                        }
                        if (typeof w.handleRender3D === 'function') {
                            w.handleRender3D();
                        } else {
                            try {
                                const openBtn = document.getElementById('open-3d-window-btn') as HTMLButtonElement | null;
                                if (openBtn && typeof openBtn.click === 'function') {
                                    openBtn.click();
                                } else if (typeof w.__open3DWindowLegacy === 'function') {
                                    w.__open3DWindowLegacy();
                                }
                            } catch (_) {}
                        }
                    }

                    // Tauri render window is a separate WebviewWindow, so use storage-based redraw sync.
                    try {
                        const g = (typeof globalThis !== 'undefined') ? (globalThis as any) : null;
                        const overrideRows = g && Array.isArray(g.__cooptOpticalSystemRowsOverride) && g.__cooptOpticalSystemRowsOverride.length > 0
                            ? g.__cooptOpticalSystemRowsOverride
                            : null;
                        const rows = overrideRows
                            ?? (typeof w.getOpticalSystemRows === 'function' ? w.getOpticalSystemRows(w.tableOpticalSystem) : []);
                        const payload = { ts: Date.now(), rows: Array.isArray(rows) ? rows : [] };
                        localStorage.setItem('coopt.renderSyncRequest', JSON.stringify(payload));
                        if (isTauriRuntime()) {
                            void (async () => {
                                try {
                                    const mod = await import('@tauri-apps/api/event');
                                    if (mod && typeof (mod as any).emit === 'function') {
                                        await (mod as any).emit('coopt-render-sync-request', payload);
                                    }
                                } catch (_) {}
                            })();
                        }
                    } catch (_) {}

                    const drawNow = () => {
                        try {
                            const popup3D = w.popup3DWindow;
                            if (popup3D && !popup3D.closed) {
                                const drawBtn = popup3D.document?.getElementById('draw-btn');
                                if (drawBtn) drawBtn.click();
                            }
                        } catch (_) {}
                    };

                    drawNow();
                    window.setTimeout(drawNow, 120);
                } catch (_) {}
            };

            const updateProgressUI = (p: any) => {
                const phaseStr = String(p?.phase ?? '');

                const setStartupProgress = (percent: number, label?: string, done?: boolean) => {
                    try {
                        if (!popup || popup.closed) return;
                        const wrap = popup.document.getElementById('opt-startup-progress-wrap') as HTMLElement | null;
                        const bar = popup.document.getElementById('opt-startup-progress-bar') as HTMLElement | null;
                        const text = popup.document.getElementById('opt-startup-progress-label') as HTMLElement | null;
                        if (wrap) wrap.style.display = 'block';
                        if (bar) bar.style.width = `${Math.max(0, Math.min(100, Number(percent) || 0))}%`;
                        if (text && label !== undefined) text.textContent = label;
                        if (done) {
                            window.setTimeout(() => {
                                try {
                                    if (!popup || popup.closed) return;
                                    const w2 = popup.document.getElementById('opt-startup-progress-wrap') as HTMLElement | null;
                                    if (w2) w2.style.display = 'none';
                                } catch (_) {}
                            }, 350);
                        }
                    } catch (_) {}
                };

                if (phaseStr === 'start') setStartupProgress(92, 'Optimization started. Waiting first iteration...');
                else if (phaseStr === 'iter' || phaseStr === 'candidate' || phaseStr === 'accept' || phaseStr === 'reject') setStartupProgress(100, 'First iteration reached', true);
                else if (phaseStr === 'done' || phaseStr === 'stopped' || phaseStr === 'error') setStartupProgress(100, 'Finished', true);

                if (!startupLatencyReported && runClickAtMs > 0) {
                    if (phaseStr === 'start' || phaseStr === 'iter' || phaseStr === 'candidate' || phaseStr === 'accept' || phaseStr === 'reject') {
                        startupLatencyReported = true;
                        const startupMs = Math.max(0, Date.now() - runClickAtMs);
                        const startupText = `startup=${startupMs}ms`;
                        try {
                            const currentIssue = String(lastIssueText || '').trim();
                            if (!currentIssue || currentIssue === '-') {
                                lastIssueText = startupText;
                            } else if (!currentIssue.includes('startup=')) {
                                lastIssueText = `${currentIssue} | ${startupText}`;
                            }
                        } catch (_) {}
                        try {
                            console.log(`⏱️ [Optimize] Run→first progress: ${startupMs} ms`);
                        } catch (_) {}
                    }
                }

                if (phaseStr === 'stopped' || phaseStr === 'done' || phaseStr === 'error') {
                    try { optimizeBtn.disabled = false; } catch (_) {}
                    isRunning = false;
                }

                if (phaseStr === 'done' && !finalAutoRenderRequested) {
                    try {
                        if (popup && !popup.closed) {
                            const autoRenderCheckbox = popup.document.getElementById('opt-auto-render') as HTMLInputElement | null;
                            if (autoRenderCheckbox && autoRenderCheckbox.checked) {
                                finalAutoRenderRequested = true;
                                window.setTimeout(() => ensureRenderPopupAndDraw(), 80);
                                window.setTimeout(() => ensureRenderPopupAndDraw(), 260);
                            }
                        }
                    } catch (_) {}
                }

                if (phaseStr === 'accept') {
                    acceptCount++;
                    const a = (p && ('alpha' in p)) ? Number(p.alpha) : NaN;
                    const r = (p && ('rho' in p)) ? Number(p.rho) : NaN;
                    const aText = Number.isFinite(a) ? a.toFixed(6) : '-';
                    const rText = Number.isFinite(r) ? r.toFixed(6) : '-';
                    lastDecisionText = `ACCEPT (α=${aText}, ρ=${rText})`;
                    lastRhoText = rText;  // 【追加】ρを保存して後で表示

                    try {
                        if (popup && !popup.closed) {
                            const autoRenderCheckbox = popup.document.getElementById('opt-auto-render') as HTMLInputElement | null;
                            if (autoRenderCheckbox && autoRenderCheckbox.checked) {
                                ensureRenderPopupAndDraw();
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
                            const sre = w.systemRequirementsEditor;
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
                    const dbg = (w.__cooptLastOptimizerResidualDebug && typeof w.__cooptLastOptimizerResidualDebug === 'object')
                        ? w.__cooptLastOptimizerResidualDebug
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
                _gThis.__cooptOptimizerIsRunning = true;
                runClickAtMs = Date.now();
                startupLatencyReported = false;
                finalAutoRenderRequested = false;

                const setPreRunProgress = (phase: string, issue?: string, iter?: string) => {
                    try {
                        if (!popup || popup.closed) return;
                        const doc = popup.document;
                        const phaseEl = doc.getElementById('opt-phase');
                        const issueEl = doc.getElementById('opt-issue');
                        const iterEl = doc.getElementById('opt-iter');
                        const startupWrap = doc.getElementById('opt-startup-progress-wrap') as HTMLElement | null;
                        const startupBar = doc.getElementById('opt-startup-progress-bar') as HTMLElement | null;
                        const startupLabel = doc.getElementById('opt-startup-progress-label') as HTMLElement | null;
                        if (phaseEl) phaseEl.textContent = String(phase || '-');
                        if (issueEl && issue !== undefined) issueEl.textContent = String(issue || '-');
                        if (iterEl && iter !== undefined) iterEl.textContent = String(iter || '-');
                        if (startupWrap) startupWrap.style.display = 'block';
                        const phaseKey = String(phase || '').toLowerCase();
                        let pct = 10;
                        if (phaseKey === 'prepare') pct = 35;
                        else if (phaseKey === 'warmup') pct = 70;
                        else if (phaseKey === 'start') pct = 88;
                        if (startupBar) startupBar.style.width = `${pct}%`;
                        if (startupLabel && issue !== undefined) startupLabel.textContent = String(issue || '');
                    } catch (_) {}
                };

                try {
                    // Save state before optimization for undo
                    let beforeOptimizationState: any = null;
                    try {
                        const sys = loadSystemConfigurations();
                        beforeOptimizationState = sys ? JSON.parse(JSON.stringify(sys)) : null;
                    } catch (_) {}

                    stopFlag.stop = false;
                    try { (globalThis as any).__cooptLastUiStopReason = null; } catch (_) {}
                    acceptCount = 0;
                    rejectCount = 0;
                    lastIssueText = '-';
                    lastReqText = '-';
                    lastResText = '-';
                    lastRhoText = '-';
                    lastVioText = '-';
                    lastSoftText = '-';
                    lastDecisionText = '-';
                    setPreRunProgress('prepare', 'Loading active configuration...');

                    // Re-read config for each Run
                    try {
                        const systemConfig = (typeof w.loadSystemConfigurationsFromTableConfig === 'function')
                            ? w.loadSystemConfigurationsFromTableConfig()
                            : loadSystemConfigurations();
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

                    setPreRunProgress('prepare', `Configuration loaded (vars=${variableCount}, num=${numericVarCount}, cat=${categoricalVarCount})`);

                    try {
                        if (popup && !popup.closed) {
                            const doc = popup.document;
                            const stopBtn = doc.getElementById('opt-stop') as HTMLButtonElement | null;
                            const runBtn = doc.getElementById('opt-run') as HTMLButtonElement | null;
                            const stopState = doc.getElementById('opt-stop-state');
                            const phaseEl = doc.getElementById('opt-phase');
                            if (stopBtn) stopBtn.disabled = false;
                            if (runBtn) runBtn.disabled = true;
                            if (stopState) stopState.textContent = 'Running...';
                            if (phaseEl && String(phaseEl.textContent || '').trim() === '-') {
                                phaseEl.textContent = 'starting';
                            }
                        }
                    } catch (_) {}

                    try { optimizeBtn.disabled = true; } catch (_) {}

                    const shouldStopNow = () => !!stopFlag.stop;

                    const resolveMaxIterations = (): number => {
                        let n = 5000;
                        try {
                            if (popup && !popup.closed) {
                                const el = popup.document.getElementById('opt-max-iter') as HTMLInputElement | null;
                                const v = el ? Number(el.value) : NaN;
                                if (Number.isFinite(v)) n = Math.trunc(v);
                            }
                        } catch (_) {}
                        if (!Number.isFinite(n) || n < 1) n = 5000;
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
                        const readSelect = (id: string, fallback: string): string => {
                            let v = fallback;
                            try {
                                if (popup && !popup.closed) {
                                    const el = popup.document.getElementById(id) as HTMLSelectElement | null;
                                    const s = el ? String(el.value).trim().toLowerCase() : '';
                                    if (s) v = s;
                                }
                            } catch (_) {}
                            return v;
                        };

                        const trustRegionDelta = readNum('opt-trust-region-delta', 0.05);
                        const trustRegionDeltaMax = Math.max(trustRegionDelta, readNum('opt-trust-region-delta-max', 1.0));
                        const convergenceProfile = readSelect('opt-convergence-profile', 'balanced');

                        const kktPreset = (() => {
                            if (convergenceProfile === 'fast') {
                                return {
                                    kktPlateauStopMinIter: 30,
                                    kktPlateauStopWindow: 30,
                                    kktTailStopMinIter: 80,
                                    kktTailStopWindow: 40,
                                    kktWindowNoGainMinIter: 70,
                                    kktWindowNoGainWindow: 30,
                                    kktGoodEnoughStopMinIter: 55,
                                    kktGoodEnoughStopWindow: 20,
                                    kktNoBestImproveMinIter: 120,
                                    kktNoBestImproveWindow: 80,
                                    kktPostBestNoImproveWindow: 10,
                                    kktPostBestPatienceWindow: 10,
                                    kktHardIterCap: 180,
                                    kktMaxWallMs: 120000
                                };
                            }
                            if (convergenceProfile === 'deep') {
                                return {
                                    kktPlateauStopMinIter: 70,
                                    kktPlateauStopWindow: 70,
                                    kktTailStopMinIter: 180,
                                    kktTailStopWindow: 90,
                                    kktWindowNoGainMinIter: 170,
                                    kktWindowNoGainWindow: 90,
                                    kktGoodEnoughStopMinIter: 130,
                                    kktGoodEnoughStopWindow: 70,
                                    kktNoBestImproveMinIter: 260,
                                    kktNoBestImproveWindow: 180,
                                    kktPostBestNoImproveWindow: 24,
                                    kktPostBestPatienceWindow: 24,
                                    kktHardIterCap: 520,
                                    kktMaxWallMs: 360000
                                };
                            }
                            return {
                                kktPlateauStopMinIter: 45,
                                kktPlateauStopWindow: 45,
                                kktTailStopMinIter: 120,
                                kktTailStopWindow: 60,
                                kktWindowNoGainMinIter: 110,
                                kktWindowNoGainWindow: 50,
                                kktGoodEnoughStopMinIter: 90,
                                kktGoodEnoughStopWindow: 35,
                                kktNoBestImproveMinIter: 180,
                                kktNoBestImproveWindow: 120,
                                kktPostBestNoImproveWindow: 16,
                                kktPostBestPatienceWindow: 16,
                                kktHardIterCap: 320,
                                kktMaxWallMs: 240000
                            };
                        })();

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
                            stageStallLimit: Math.max(1, Math.floor(readNum('opt-stage-stall-limit', 5))),
                            restartOnRejectStreak: Math.max(1, Math.floor(readNum('opt-restart-on-reject-streak', 8))),
                            restartMaxCount: Math.max(0, Math.floor(readNum('opt-restart-max-count', 2))),
                            restartJitterScaled: Math.max(0, readNum('opt-restart-jitter-scaled', 0.035)),
                            lmExploreWhenFlat: readBool('opt-lm-explore-when-flat', false),
                            lmExploreTries: Math.max(1, Math.floor(readNum('opt-lm-explore-tries', 3))),
                            convergenceProfile,
                            ...kktPreset,
                            useWasmLinearSolve: true,
                            profile: false
                        };
                    };

                    const maxIterations = resolveMaxIterations();
                    const optParams = resolveOptParams();
                    currentConvergenceProfile = String(optParams?.convergenceProfile || 'balanced').toLowerCase();
                    setPreRunProgress('prepare', `Options resolved (conv=${currentConvergenceProfile}, maxIter=${maxIterations})`);

                    try {
                        const convText = `conv=${currentConvergenceProfile}`;
                        const issue = String(lastIssueText || '').trim();
                        lastIssueText = (!issue || issue === '-') ? convText : `${issue} | ${convText}`;
                    } catch (_) {}

                    setPreRunProgress('warmup', 'Initializing WASM bridge...');
                    warmupOptimizerStartup(true);
                    try {
                        if (optimizerWasmWarmupPromise) {
                            await optimizerWasmWarmupPromise;
                        }
                        setPreRunProgress('warmup', 'WASM bridge ready');
                    } catch (_) {
                        setPreRunProgress('warmup', 'WASM warmup skipped (fallback available)');
                    }

                    const resolveOptMethod = (): string => {
                        let method = 'kkt'; // default (AL)
                        try {
                            if (popup && !popup.closed) {
                                const el = popup.document.getElementById('opt-method') as HTMLSelectElement | null;
                                const v = el ? String(el.value).toLowerCase().trim() : '';
                                if (v === 'cd' || v === 'lm' || v === 'kkt') {
                                    method = v;
                                }
                            }
                        } catch (_) {}
                        return method;
                    };

                    let result: any = null;
                    let __prevDisableRayTraceDebug: any;
                    try {
                        // Prevent undo recording during optimization
                        if (w.undoHistory) {
                            w.undoHistory.isExecuting = true;
                        }

                        // Force-disable ray-tracing detailed debug logs during optimization.
                        try {
                            __prevDisableRayTraceDebug = _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG;
                        } catch (_) { __prevDisableRayTraceDebug = undefined; }
                        try {
                            _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG = true;
                        } catch (_) {}

                        setPreRunProgress('start', 'Starting optimization and computing initial residuals...', '0');

                        result = await opt.run({
                            multiScenario,
                            runUntilStopped: false,
                            maxIterations,
                            method: resolveOptMethod(),
                            stageMaxCoef: [10],
                            ...optParams,
                            onProgress: updateProgressUI,
                            shouldStop: shouldStopNow
                        });
                        // Restore flags after successful completion
                        try {
                            if (__prevDisableRayTraceDebug !== undefined) _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG = __prevDisableRayTraceDebug;
                            else {
                                try { delete _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG; } catch (_) {}
                            }
                            _gThis.__cooptOptimizerIsRunning = false;
                        } catch (_) {}

                        // Re-enable undo recording after optimization
                        if (w.undoHistory) {
                            w.undoHistory.isExecuting = false;
                        }

                        // Record optimization as a single undo operation
                        try {
                            if (beforeOptimizationState && w.undoHistory && result?.ok) {
                                const sys = loadSystemConfigurations();
                                const afterOptimizationState = sys ? JSON.parse(JSON.stringify(sys)) : null;
                                if (JSON.stringify(beforeOptimizationState) !== JSON.stringify(afterOptimizationState)) {
                                    const command = {
                                        name: 'Optimization',
                                        execute: async () => {
                                            saveSystemConfigurations(afterOptimizationState);
                                            try {
                                                if (w.ConfigurationManager && typeof w.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
                                                    await w.ConfigurationManager.loadActiveConfigurationToTables({ applyToUI: true });
                                                }
                                            } catch (_) {}
                                            try {
                                                requestRefreshBlockInspector(w);
                                            } catch (_) {}
                                        },
                                        undo: async () => {
                                            saveSystemConfigurations(beforeOptimizationState);
                                            try {
                                                if (w.ConfigurationManager && typeof w.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
                                                    await w.ConfigurationManager.loadActiveConfigurationToTables({ applyToUI: true });
                                                }
                                            } catch (_) {}
                                            try {
                                                requestRefreshBlockInspector(w);
                                            } catch (_) {}
                                        },
                                        redo: function() { return this.execute(); }
                                    };
                                    w.undoHistory.record(command);
                                }
                            }
                        } catch (e) {
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

                        if (w.undoHistory) {
                            w.undoHistory.isExecuting = false;
                        }
                    } finally {
                        isRunning = false;
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
                w.__cooptStartOptimizationFromPopup = startRun;
            } catch (_) {}

            try {
                const runBackgroundPreRunRefresh = () => {
                    if (isRunning) return;
                    Promise.resolve()
                        .then(() => refreshPreRunScore())
                        .catch(() => {});
                };

                const g: any = (typeof globalThis !== 'undefined') ? globalThis : null;
                if (g && typeof g.requestIdleCallback === 'function') {
                    g.requestIdleCallback(() => runBackgroundPreRunRefresh(), { timeout: 1500 });
                } else {
                    window.setTimeout(() => runBackgroundPreRunRefresh(), 600);
                }
            } catch (_) {}

        } catch (e) {
            console.warn('⚠️ [Optimize] Failed:', e);
            alert('Optimize の実行に失敗しました。console を確認してください。');
        } finally {
            try { optimizeBtn.disabled = false; } catch (_) {}
            const _gThis2 = (typeof globalThis !== 'undefined') ? globalThis as any : {} as any;
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
                    <input type="checkbox" id="auto-render" checked> Auto-render on Accept
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
    if (isReactManagedButton(btn as HTMLElement)) return;

    // Remove existing listener to prevent duplicates
    const newHandler = () => {
        if (!confirm('Create new file? Current data will be cleared.')) return;
        
        try {
            console.log('🔵 [New File] Clearing localStorage and creating default configuration...');
            clearAllPersistedState();
            
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
                        parameters: { semidiaMode: 'Manual' },
                        variables: {},
                        metadata: { source: 'default' }
                    }
                ],
                source: [
                    { id: 1, wavelength: 0.4358343, weight: 1, primary: '', angle: 0 },
                    { id: 2, wavelength: 0.5875618, weight: 1, primary: 'Primary Wavelength', angle: 0 },
                    { id: 3, wavelength: 0.6562725, weight: 1, primary: '', angle: 0 }
                ],
                object: [
                    { id: 1, xHeightAngle: 0, yHeightAngle: 0, position: 'Angle', angle: 0 },
                    { id: 2, xHeightAngle: 0, yHeightAngle: 17.05, position: 'Angle', angle: 0 }
                ],
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
            
            saveSystemConfigurations(systemConfig);
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
    if (isReactManagedButton(btn as HTMLElement)) return;

    const saveHandler = async () => {
        try {
            if (document.activeElement) (document.activeElement as HTMLElement).blur();

            // Build export data using the same logic as original JS
            const allData = buildAllDataForExport();

            // Get loaded filename for default
            let loadedFileName: string | null = null;
            try {
                const { getLoadedFileName } = await import('./loaded-file-storage.ts');
                loadedFileName = getLoadedFileName();
            } catch (_) {}
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
            try {
                const { setLoadedFileName } = await import('./loaded-file-storage.ts');
                setLoadedFileName(filename);
            } catch (_) {}
            
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
    const parsedConfig = loadSystemConfigurations();
    
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

    let opticalSystemData = w.tableOpticalSystem ? w.tableOpticalSystem.getData() : [];
    
    try {
        const systemConfig = (typeof w.loadSystemConfigurations === 'function') 
            ? w.loadSystemConfigurations() 
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
            if (typeof w.expandBlocksToOpticalSystemRows === 'function') {
                const expanded = w.expandBlocksToOpticalSystemRows(activeCfg.blocks);
                if (expanded && Array.isArray(expanded.rows)) {
                    opticalSystemData = expanded.rows;
                }
            }
        }
    } catch (_) {}

    return {
        source: w.tableSource ? w.tableSource.getData() : [],
        object: w.tableObject ? w.tableObject.getData() : [],
        opticalSystem: opticalSystemData,
        meritFunction: w.meritFunctionEditor ? w.meritFunctionEditor.getData() : [],
        systemRequirements: w.systemRequirementsEditor ? w.systemRequirementsEditor.getData() : [],
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
    if (isReactManagedButton(btn as HTMLElement)) return;

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
    if (isReactManagedButton(btn as HTMLElement)) return;

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
    // No-op: Clear Storage is handled by React toolbar handler.
    // This prevents legacy modal (red button) from flashing.
}

// Setup Analysis Buttons
function setupParaxialButton(): void {
    const btn = document.getElementById('calculate-paraxial-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        try {
            if (typeof w.outputParaxialDataToDebug === 'function') {
                const tableOpticalSystem = w.tableOpticalSystem;
                w.outputParaxialDataToDebug(tableOpticalSystem);
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
    btn.addEventListener('click', async () => {
        try {
            if (typeof w.outputSeidelCoefficientsToDebug === 'function') {
                w.outputSeidelCoefficientsToDebug();
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
        try {
            const { calculateAfocalSeidelCoefficientsIntegrated } = await import('../evaluation/aberrations/seidel-coefficients-afocal.js');
            const { formatSeidelCoefficients } = await import('../evaluation/aberrations/seidel-coefficients.js');

            const opticalSystemRows = w.getOpticalSystemRows ? w.getOpticalSystemRows() : [];
            const objectRows = w.getObjectTableRows ? w.getObjectTableRows() : [];
            const sourceRows = w.getSourceTableRows ? w.getSourceTableRows() : [];

            if (opticalSystemRows.length === 0) {
                console.error('❌ Optical system data is empty');
                alert('光学系データがありません。');
                return;
            }

            const wavelength = (() => {
                if (typeof w.getPrimaryWavelength === 'function') {
                    const wl = Number(w.getPrimaryWavelength());
                    if (Number.isFinite(wl) && wl > 0) return wl;
                }
                alert('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
                return NaN;
            })();
            if (!Number.isFinite(wavelength) || wavelength <= 0) return;

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

                if (typeof w.renderBlockContributionSummaryFromSeidel === 'function') {
                    try {
                        w.renderBlockContributionSummaryFromSeidel(result, opticalSystemRows);
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
        try {
            if (typeof w.displayCoordinateTransformMatrix === 'function') {
                w.displayCoordinateTransformMatrix();
            } else {
                console.error('❌ displayCoordinateTransformMatrix関数が見つかりません');
            }
        } catch (error) {
            console.error('❌ 座標変換ボタンエラー:', error);
        }
    });
}

function setupSpotDiagramButton(): void {
    const btn = document.getElementById('show-spot-diagram-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof w.showSpotDiagram === 'function') {
            w.showSpotDiagram();
        }
    });
}

function setupLongitudinalAberrationButton(): void {
    const btn = document.getElementById('show-longitudinal-aberration-diagram-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof w.showLongitudinalAberration === 'function') {
            w.showLongitudinalAberration();
        }
    });
}

function setupTransverseAberrationButton(): void {
    const btn = document.getElementById('show-transverse-aberration-diagram-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof w.showTransverseAberration === 'function') {
            w.showTransverseAberration();
        }
    });
}

function setupMagnificationChromaticAberrationButton(): void {
    const btn = document.getElementById('show-magnification-chromatic-aberration-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof w.showMagnificationChromaticAberrationDiagram !== 'function') return;

        const progressWrapper = document.getElementById('mca-progress-wrapper');
        const progressBarRaw = document.getElementById('mca-progressbar');
        const progressBarEl = progressBarRaw instanceof HTMLProgressElement ? progressBarRaw : null;
        const progressTextEl = document.getElementById('mca-progress-text');

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

        const onProgress = (evt: any) => {
            try {
                const p = Number(evt?.percent);
                const msg = evt?.message || evt?.phase || 'Working...';
                if (Number.isFinite(p)) setProgress(p, msg);
                else setProgress(undefined, msg);
            } catch (_) {}
        };

        w.showMagnificationChromaticAberrationDiagram({ onProgress });
    });
}

function setupDistortionButton(): void {
    const btn = document.getElementById('show-distortion-diagram-btn');
    if (!btn) return;
    if ((btn as any).__cooptDistortionBound) return;
    (btn as any).__cooptDistortionBound = true;
    btn.addEventListener('click', () => {
        if (typeof w.showDistortion === 'function') {
            w.showDistortion();
        }
    });
}

function setupIntegratedAberrationButton(): void {
    const btn = document.getElementById('show-integrated-aberration-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof w.showIntegratedAberration === 'function') {
            w.showIntegratedAberration();
        }
    });
}

function setupAstigmatismButton(): void {
    const btn = document.getElementById('show-astigmatism-diagram-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        if (typeof w.showAstigmatism === 'function') {
            w.showAstigmatism();
        }
    });
}

// PSF Calculation
async function handlePSFCalculation(debugMode: boolean = false): Promise<void> {
    try {
        const tbl = w.tableOpticalSystem || w.tableOpticalSystem;
        const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
        if (!Array.isArray(rows) || rows.length < 2) {
            alert('Optical system data not available');
            return;
        }

        const objectRows = (w.tableObject && typeof w.tableObject.getData === 'function')
            ? w.tableObject.getData()
            : [];

        const selectedObjectKey = String((document.getElementById('psf-object-select') as HTMLSelectElement)?.value ?? '0');
        const objectIndex = Number(selectedObjectKey);

        const primaryWavelength = (() => {
            if (typeof w.getPrimaryWavelength === 'function') {
                const wl = Number(w.getPrimaryWavelength());
                if (Number.isFinite(wl) && wl > 0) return wl;
            }
            alert('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
            return NaN;
        })();
        if (!Number.isFinite(primaryWavelength) || primaryWavelength <= 0) return;

        const gridSize = 128;
        const zeroPadding = 'auto';
        const opdDisplayMode = 'pistonTiltRemoved';

        if (typeof w.getPSFCalculatorSingleton === 'function') {
            const calculator = await w.getPSFCalculatorSingleton();
            const result = await calculator.calculatePSF(rows, objectRows, objectIndex, primaryWavelength, {
                gridSize,
                zeroPadding,
                opdDisplayMode,
                debugMode
            });

            if (typeof w.displayPSFResult === 'function') {
                w.displayPSFResult(result);
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
        if (typeof w.updatePSFDisplay === 'function') {
            w.updatePSFDisplay();
        }
    });

    contoursCheckbox?.addEventListener('change', () => {
        if (typeof w.updatePSFDisplay === 'function') {
            w.updatePSFDisplay();
        }
    });

    characteristicsCheckbox?.addEventListener('change', () => {
        if (typeof w.updatePSFDisplay === 'function') {
            w.updatePSFDisplay();
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

            if (typeof w.switchPSFDisplayMode === 'function') {
                w.switchPSFDisplayMode(mode);
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
        const tbl = w.tableOpticalSystem || w.tableOpticalSystem;
        const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
        if (!Array.isArray(rows) || rows.length < 2) {
            alert('Optical system data not available');
            return;
        }

        const wavelengthMicrons = options.wavelengthMicrons ?? 'all';
        const objectIndex = options.objectIndex ?? 0;
        const maxFrequencyLpmm = options.maxFrequencyLpmm ?? 100;
        const samplingSize = options.samplingSize ?? 128;

        if (typeof w.calculateMTF === 'function') {
            const result = await w.calculateMTF(rows, {
                wavelengthMicrons,
                objectIndex,
                maxFrequencyLpmm,
                samplingSize
            });

            if (typeof w.displayMTFResult === 'function') {
                w.displayMTFResult(result);
            }
        }
    } catch (err) {
        console.error('❌ MTF calculation failed:', err);
        alert(`MTF calculation failed: ${(err as Error)?.message || String(err)}`);
    }
}

// Configuration Management

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
            parameters: { semidiaMode: 'Manual' },
            variables: {},
            metadata: { source: 'default' }
        }
    ];

    return {
        id: id,
        name: name,
        schemaVersion: BLOCK_SCHEMA_VERSION,
        blocks: defaultBlocks,
        source: [
            { id: 1, wavelength: 0.4358343, weight: 1, primary: '', angle: 0 },
            { id: 2, wavelength: 0.5875618, weight: 1, primary: 'Primary Wavelength', angle: 0 },
            { id: 3, wavelength: 0.6562725, weight: 1, primary: '', angle: 0 }
        ],
        object: [
            { id: 1, xHeightAngle: 0, yHeightAngle: 0, position: 'Angle', angle: 0 },
            { id: 2, xHeightAngle: 0, yHeightAngle: 17.05, position: 'Angle', angle: 0 }
        ],
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
    try {
        return loadSystemConfigurationsFromTableConfig();
    } catch (e) {
        console.warn('⚠️ [Configuration] Load failed; using default system config:', e);
        return defaultSystemConfig;
    }
}

export function saveSystemConfigurations(systemConfig: any): void {
    try {
        saveSystemConfigurationsFromTableConfig(systemConfig);
    } catch (e) {
        console.warn('⚠️ [Configuration] Save failed:', e);
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
        const globalSource = w.tableSource ? w.tableSource.getData() : [];
        saveSourceTableData(globalSource as any);
    } catch (_) {}
    
    activeConfig.object = w.tableObject ? w.tableObject.getData() : [];
    activeConfig.opticalSystem = w.tableOpticalSystem ? w.tableOpticalSystem.getData() : [];
    activeConfig.meritFunction = w.meritFunctionEditor ? w.meritFunctionEditor.getData() : [];
    
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
    const activeConfig = getActiveConfiguration();
    
    if (!activeConfig) {
        console.error('❌ [Configuration] No active config found');
        return;
    }
    
    try {
        const hasGlobal = tryLoadPersistedSourceTableData() !== null;
        const legacy = Array.isArray(activeConfig.source) ? activeConfig.source : null;
        if (!hasGlobal && legacy && legacy.length > 0) {
            saveSourceTableData(legacy as any);
        }
    } catch (_) {}
    
    if (activeConfig.object) {
        saveObjectTableData(activeConfig.object as any);
    }
    if (activeConfig.opticalSystem) {
        saveOpticalSystemTableData(activeConfig.opticalSystem as any);
    }
    if (activeConfig.meritFunction) {
        saveMeritFunctionTableData(activeConfig.meritFunction as any);
    }
    
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
    const prev = w.ConfigurationManager;
    const base = (prev && typeof prev === 'object') ? prev : {};
    w.ConfigurationManager = {
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

function __blocks_setParameterAndApertureModeBulk(enabled: boolean): { ok: boolean; changedCount: number; reason?: string } {
    try {
        const systemConfig = loadSystemConfigurations();
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) {
            return { ok: false, changedCount: 0, reason: 'no system configurations' };
        }

        const activeId = systemConfig.activeConfigId;
        const activeCfg = systemConfig.configurations.find((c: any) => c && c.id === activeId) || null;
        if (!activeCfg || !Array.isArray(activeCfg.blocks)) {
            return { ok: false, changedCount: 0, reason: 'active configuration or blocks not found' };
        }

        const beforeBlocks = JSON.parse(JSON.stringify(activeCfg.blocks));
        const mode = enabled ? 'V' : 'F';
        let changedCount = 0;

        for (const block of activeCfg.blocks) {
            if (!block || typeof block !== 'object') continue;

            if (!block.variables || typeof block.variables !== 'object') {
                block.variables = {};
            }

            const params = (block.parameters && typeof block.parameters === 'object') ? block.parameters : null;
            const paramKeys = params ? Object.keys(params) : [];
            for (const key of paramKeys) {
                if (!block.variables[key] || typeof block.variables[key] !== 'object') {
                    block.variables[key] = { value: params ? params[key] : '' };
                }
                if (Object.prototype.hasOwnProperty.call(block.variables[key], 'value') === false) {
                    block.variables[key].value = params ? params[key] : '';
                }
                if (!block.variables[key].optimize || typeof block.variables[key].optimize !== 'object') {
                    block.variables[key].optimize = {};
                }

                const prevMode = String(block.variables[key].optimize.mode ?? '').trim();
                if (prevMode !== mode) changedCount++;
                block.variables[key].optimize.mode = mode;
                if (!block.variables[key].optimize.scope) {
                    block.variables[key].optimize.scope = 'perConfig';
                }
            }

            const aperture = (block.aperture && typeof block.aperture === 'object') ? block.aperture : null;
            const apertureKeys = aperture ? Object.keys(aperture) : [];
            for (const key of apertureKeys) {
                if (!block.variables[key] || typeof block.variables[key] !== 'object') {
                    block.variables[key] = { value: aperture ? aperture[key] : '' };
                }
                if (Object.prototype.hasOwnProperty.call(block.variables[key], 'value') === false) {
                    block.variables[key].value = aperture ? aperture[key] : '';
                }
                if (!block.variables[key].optimize || typeof block.variables[key].optimize !== 'object') {
                    block.variables[key].optimize = {};
                }

                const prevMode = String(block.variables[key].optimize.mode ?? '').trim();
                if (prevMode !== mode) changedCount++;
                block.variables[key].optimize.mode = mode;
                if (!block.variables[key].optimize.scope) {
                    block.variables[key].optimize.scope = 'perConfig';
                }
            }
        }

        if (changedCount <= 0) {
            return { ok: true, changedCount: 0 };
        }

        const afterBlocks = JSON.parse(JSON.stringify(activeCfg.blocks));

        try {
            if (w.undoHistory && w.SetDesignIntentOptimizeBulkCommand && !w.undoHistory.isExecuting) {
                const cmd = new w.SetDesignIntentOptimizeBulkCommand(String(activeCfg.id ?? activeId ?? ''), beforeBlocks, afterBlocks, enabled);
                w.undoHistory.record(cmd);
            }
        } catch (_) {}

        saveSystemConfigurations(systemConfig);

        try { refreshBlockInspector(); } catch (_) {}
        try { if (typeof w.loadActiveConfigurationToTables === 'function') w.loadActiveConfigurationToTables(); } catch (_) {}
        try {
            if (w.popup3DWindow && !w.popup3DWindow.closed) {
                w.popup3DWindow.postMessage({ action: 'request-redraw' }, '*');
            }
        } catch (_) {}

        return { ok: true, changedCount };
    } catch (e: any) {
        return { ok: false, changedCount: 0, reason: String(e?.message || e) };
    }
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
    const isAsphereType = (v: any): boolean => {
        const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
        return s.includes('aspheric');
    };
    
    if (type === 'Lens' || type === 'PositiveLens') {
        const r1 = pick('frontRadius');
        const r2 = pick('backRadius');
        const ct = pick('centerThickness');
        const mat = pick('material');
        const frontSurfType = pick('frontSurfType');
        const backSurfType = pick('backSurfType');
        const parts = [];
        if (String(r1) !== '') parts.push(`R1=${String(r1)}`);
        if (String(r2) !== '') parts.push(`R2=${String(r2)}`);
        if (String(ct) !== '') parts.push(`CT=${String(ct)}`);
        if (String(mat) !== '') parts.push(`G=${String(mat)}`);
        if (isAsphereType(frontSurfType)) parts.push('Front=Asphere');
        if (isAsphereType(backSurfType)) parts.push('Back=Asphere');
        return parts.join(' ');
    }

    if (type === 'Doublet') {
        const r1 = pick('radius1');
        const r2 = pick('radius2');
        const r3 = pick('radius3');
        const t1 = pick('thickness1');
        const t2 = pick('thickness2');
        const mat1 = pick('material1');
        const abbe1 = pick('abbe1') || pick('vd1');
        const mat2 = pick('material2');
        const abbe2 = pick('abbe2') || pick('vd2');
        const surf1Type = pick('surf1SurfType');
        const surf2Type = pick('surf2SurfType');
        const surf3Type = pick('surf3SurfType');
        const parts = [];
        if (String(r1) !== '') parts.push(`R1=${String(r1)}`);
        if (String(r2) !== '') parts.push(`R2=${String(r2)}`);
        if (String(r3) !== '') parts.push(`R3=${String(r3)}`);
        if (String(t1) !== '') parts.push(`T1=${String(t1)}`);
        if (String(t2) !== '') parts.push(`T2=${String(t2)}`);
        if (String(mat1) !== '') parts.push(`G1=${String(mat1)}`);
        if (String(abbe1) !== '') parts.push(`V1=${String(abbe1)}`);
        if (String(mat2) !== '') parts.push(`G2=${String(mat2)}`);
        if (String(abbe2) !== '') parts.push(`V2=${String(abbe2)}`);
        if (isAsphereType(surf1Type)) parts.push('S1=Asphere');
        if (isAsphereType(surf2Type)) parts.push('S2=Asphere');
        if (isAsphereType(surf3Type)) parts.push('S3=Asphere');
        return parts.join(' ');
    }

    if (type === 'SingleSurface' || type === 'Mirror') {
        const radius = pick('radius');
        const th = pick('thickness');
        const mat = pick('material');
        const surfType = pick('surfType');
        const apertureShape = pick('apertureShape');
        const apertureWidth = pick('apertureWidth');
        const apertureHeight = pick('apertureHeight');
        const parts = [];
        if (String(radius) !== '') parts.push(`R=${String(radius)}`);
        if (String(th) !== '') parts.push(`T=${String(th)}`);
        if (String(mat) !== '') parts.push(`M=${String(mat)}`);
        if (isAsphereType(surfType)) parts.push('Asphere');
        if (String(apertureShape) !== '' && String(apertureShape) !== 'Circular') parts.push(`Aperture=${String(apertureShape)}`);
        if (String(apertureWidth) !== '') parts.push(`AW=${String(apertureWidth)}`);
        if (String(apertureHeight) !== '') parts.push(`AH=${String(apertureHeight)}`);
        return parts.join(' ');
    }

    if (type === 'ImageSurface') {
        const radius = pick('radius');
        const th = pick('thickness');
        const surfType = pick('surfType');
        const apertureShape = pick('apertureShape');
        const apertureWidth = pick('apertureWidth');
        const apertureHeight = pick('apertureHeight');
        const parts = [];
        if (String(radius) !== '') parts.push(`R=${String(radius)}`);
        if (String(th) !== '') parts.push(`T=${String(th)}`);
        if (isAsphereType(surfType)) parts.push('Asphere');
        if (String(apertureShape) !== '' && String(apertureShape) !== 'Circular') parts.push(`Aperture=${String(apertureShape)}`);
        if (String(apertureWidth) !== '') parts.push(`AW=${String(apertureWidth)}`);
        if (String(apertureHeight) !== '') parts.push(`AH=${String(apertureHeight)}`);
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
            if (w.undoHistory && w.SetBlockParameterCommand && !w.undoHistory.isExecuting) {
                const cmd = new w.SetBlockParameterCommand(activeConfig.name, String(blockId), String(path), oldValue, newValue);
                w.undoHistory.record(cmd);
            }
        } catch (_) {}
    }

    cooptSetNestedValue(block, path, newValue);

    // Re-expand Design Intent blocks into opticalSystem rows so rendering/ray-tracing sees latest values.
    try {
        const expanded = expandBlocksToOpticalSystemRows(blocks as any);
        if (expanded && Array.isArray(expanded.rows)) {
            activeConfig.opticalSystem = expanded.rows;
            try { saveOpticalSystemTableData(expanded.rows as any); } catch (_) {}
            try { if (typeof w.saveLensTableData === 'function') w.saveLensTableData(expanded.rows); } catch (_) {}

            try {
                const tableOptical = w.tableOpticalSystem || w.opticalSystemTabulator;
                if (tableOptical && typeof tableOptical.replaceData === 'function') {
                    tableOptical.replaceData(expanded.rows);
                } else if (tableOptical && typeof tableOptical.setData === 'function') {
                    tableOptical.setData(expanded.rows);
                }
            } catch (_) {}
        }
    } catch (_) {}

    try {
        if (activeConfig.metadata) activeConfig.metadata.modified = new Date().toISOString();
    } catch (_) {}
    try { saveSystemConfigurations(systemConfig); } catch (_) {}
    try { refreshBlockInspector(); } catch (_) {}
    try { if (typeof w.loadActiveConfigurationToTables === 'function') w.loadActiveConfigurationToTables(); } catch (_) {}

    // Request render refresh (especially for popup 3D view)
    try {
        const popup = w.popup3DWindow;
        if (popup && !popup.closed && typeof popup.postMessage === 'function') {
            popup.postMessage({ action: 'request-redraw' }, '*');
        }
    } catch (_) {}
}

function renderBlockInspector(summary: any[], groups: any, blockById: Map<string, any> | null = null, blocksInOrder: any[] | null = null): void {
    const container = document.getElementById('block-inspector');
    if (!container) return;

    container.innerHTML = '';

    // Show error banner if scope errors exist
    try {
        if (Array.isArray(w.__blocks_lastScopeErrors) && w.__blocks_lastScopeErrors.length > 0) {
            const e0 = w.__blocks_lastScopeErrors[0];
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

    // Compute per-block surface index ranges (skip Object/Gap/CoordTrans rows)
    const surfRangeByBlockId = new Map<string, {min:number, max:number}>();
    try {
        if (Array.isArray(blocksInOrder) && blocksInOrder.length > 0 && typeof w.expandBlocksToOpticalSystemRows === 'function') {
            const exp = w.expandBlocksToOpticalSystemRows(blocksInOrder);
            const rows = exp && Array.isArray(exp.rows) ? exp.rows : [];
            let surfaceNo = 0;
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                const bid = String(r?._blockId ?? '').trim();
                if (!bid) continue;
                const rowBlockType = String(r?._blockType ?? '').trim();
                if (rowBlockType === 'Gap' || rowBlockType === 'CoordTrans') continue;
                if (rowBlockType === 'ObjectSurface' || rowBlockType === 'ObjectPlane' || rowBlockType === 'Object') continue;
                surfaceNo += 1;
                const prev = surfRangeByBlockId.get(bid);
                    if (!prev) surfRangeByBlockId.set(bid, { min: surfaceNo, max: surfaceNo });
                else {
                        if (surfaceNo < prev.min) prev.min = surfaceNo;
                        if (surfaceNo > prev.max) prev.max = surfaceNo;
                }
            }
        }
    } catch (_) {}

    if (surfRangeByBlockId.size === 0) {
        try {
            let surfaceNo = 0;
            for (const b of list) {
                const blockId = String(b?.blockId ?? '').trim();
                if (!blockId) continue;
                const blockType = String(b?.blockType ?? '').trim();
                if (blockType === 'ObjectSurface' || blockType === 'ObjectPlane' || blockType === 'Object') continue;
                const count = Number(b?.surfaceCount ?? 0);
                if (!Number.isFinite(count) || count <= 0) continue;
                const start = surfaceNo + 1;
                const end = surfaceNo + count;
                surfaceNo = end;
                surfRangeByBlockId.set(blockId, { min: start, max: end });
            }
        } catch (_) {}
    }

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

                    // CoordTrans display priority: decenterX/Y/Z → tiltX/Y/Z → order → coordReturn → toSurf
                    if (blockType === 'CoordTrans') {
                        const coordPriority = (k: string): number => {
                            const kLower = k.toLowerCase();
                            if (kLower === 'decenterx') return 0;
                            if (kLower === 'decentery') return 1;
                            if (kLower === 'decenterz') return 2;
                            if (kLower === 'tiltx') return 3;
                            if (kLower === 'tilty') return 4;
                            if (kLower === 'tiltz') return 5;
                            if (kLower === 'order') return 6;
                            if (kLower === 'coordreturn') return 7;
                            if (kLower === 'tosurf') return 8;
                            return 100;
                        };
                        const aPriority = coordPriority(a);
                        const bPriority = coordPriority(b);
                        if (aPriority !== 100 || bPriority !== 100) {
                            return aPriority - bPriority;
                        }
                    }

                    // Doublet display priority: material1 → abbe1/vd1 → material2 → abbe2/vd2
                    const rank = (k: string): number => {
                        switch (k) {
                            case 'material1': return 0;
                            case 'abbe1':
                            case 'vd1': return 1;
                            case 'material2': return 2;
                            case 'abbe2':
                            case 'vd2': return 3;
                            default: return 100;
                        }
                    };
                    const aRank = rank(a);
                    const bRank = rank(b);
                    if (aRank !== bRank) return aRank - bRank;
                    
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
                    
                    // Aperture parameters: apertureShape → apertureWidth → apertureHeight
                    if (a === 'apertureShape' && b !== 'apertureShape') return -1;
                    if (b === 'apertureShape' && a !== 'apertureShape') return 1;
                    if (a === 'apertureWidth' && b !== 'apertureWidth' && b !== 'apertureShape') return -1;
                    if (b === 'apertureWidth' && a !== 'apertureWidth' && a !== 'apertureShape') return 1;
                    if (a === 'apertureHeight' && b !== 'apertureHeight' && b !== 'apertureShape' && b !== 'apertureWidth') return -1;
                    if (b === 'apertureHeight' && a !== 'apertureHeight' && a !== 'apertureShape' && a !== 'apertureWidth') return 1;
                    
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
            
            // For Gap blocks, ensure material/thicknessMode are always in paramKeys even if not set
            const allParamKeys = Object.keys(params || {}).filter(k => {
                // chiefRayShiftX/Y/Z は廃止フィールド。表示しない
                const kl = k.toLowerCase();
                if (kl === 'chiefrayshiftx' || kl === 'chiefrayshifty' || kl === 'chiefrayshiftz') return false;
                return true;
            });
            if ((blockType === 'Gap' || blockType === 'AirGap') && !allParamKeys.includes('material')) {
                allParamKeys.push('material');
            }
            if ((blockType === 'Gap' || blockType === 'AirGap') && !allParamKeys.includes('thicknessMode')) {
                allParamKeys.push('thicknessMode');
            }
            if (blockType === 'ImageSurface') {
                if (!allParamKeys.includes('semidiaMode')) allParamKeys.push('semidiaMode');
                if (!allParamKeys.includes('apertureShape')) allParamKeys.push('apertureShape');
                if (!allParamKeys.includes('apertureWidth')) allParamKeys.push('apertureWidth');
                if (!allParamKeys.includes('apertureHeight')) allParamKeys.push('apertureHeight');
                if (!allParamKeys.includes('radius')) allParamKeys.push('radius');
                if (!allParamKeys.includes('thickness')) allParamKeys.push('thickness');
                if (!allParamKeys.includes('surfType')) allParamKeys.push('surfType');
                if (!allParamKeys.includes('conic')) allParamKeys.push('conic');
                for (let i = 1; i <= 10; i++) {
                    const coefKey = `coef${i}`;
                    if (!allParamKeys.includes(coefKey)) allParamKeys.push(coefKey);
                }
            }
            // For Lens and other blocks with front/back surfaces, ensure coefficient fields are present
            if (blockType === 'Lens' || blockType === 'PositiveLens' || blockType === 'SingleSurface' || blockType === 'Mirror') {
                if (!allParamKeys.includes('frontSurfType')) allParamKeys.push('frontSurfType');
                if (!allParamKeys.includes('backSurfType')) allParamKeys.push('backSurfType');
                for (let i = 1; i <= 10; i++) {
                    const frontCoefKey = `frontCoef${i}`;
                    const backCoefKey = `backCoef${i}`;
                    if (!allParamKeys.includes(frontCoefKey)) allParamKeys.push(frontCoefKey);
                    if (!allParamKeys.includes(backCoefKey)) allParamKeys.push(backCoefKey);
                }
            }
            const paramKeys = sortParameterKeys(allParamKeys);
            const varKeys = Object.keys(vars || {}).sort();

            const normalizeSurfTypeLabel = (value: any) => {
                return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
            };

            const getSurfTypeForCoefKey = (key: string) => {
                const lower = String(key).toLowerCase();
                if (lower.startsWith('frontcoef')) return params.frontSurfType;
                if (lower.startsWith('backcoef')) return params.backSurfType;
                if (lower.startsWith('surf1coef')) return params.surf1SurfType;
                if (lower.startsWith('surf2coef')) return params.surf2SurfType;
                if (lower.startsWith('surf3coef')) return params.surf3SurfType;
                return params.surfType;
            };

            const getCoefDisplayLabel = (key: string) => {
                const match = String(key).match(/coef(\d+)/i);
                if (!match) return null;
                const idx = parseInt(match[1], 10);
                if (!Number.isFinite(idx) || idx <= 0) return null;

                const surfTypeRaw = getSurfTypeForCoefKey(key);
                const surfType = normalizeSurfTypeLabel(surfTypeRaw);
                const isEven = surfType === 'asphericeven' || surfType === 'asphericaleven' || surfType === 'aspheric-even' || surfType === 'aspherical-even';
                const isOdd = surfType === 'asphericodd' || surfType === 'asphericalodd' || surfType === 'aspheric-odd' || surfType === 'aspherical-odd';
                if (!isEven && !isOdd) return null;

                const aIndex = isEven ? (2 * idx + 2) : (2 * idx + 1);
                const lower = String(key).toLowerCase();
                let prefix = '';
                if (lower.startsWith('frontcoef')) prefix = 'front ';
                else if (lower.startsWith('backcoef')) prefix = 'back ';
                else if (lower.startsWith('surf1coef')) prefix = 'surf1 ';
                else if (lower.startsWith('surf2coef')) prefix = 'surf2 ';
                else if (lower.startsWith('surf3coef')) prefix = 'surf3 ';
                return `${prefix}A${aIndex}`.trim();
            };

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
                const coefLabel = getCoefDisplayLabel(label);
                name.textContent = coefLabel || label;
                name.style.fontSize = '12px';
                name.style.color = isDarkMode ? '#d1d5db' : '#374151';
                name.style.flex = '0 0 140px';

                // Check parameter type - surfType uses exact match (case-sensitive key)
                const isSurfType = label === 'surfType' || label === 'frontSurfType' || label === 'backSurfType' || 
                                   label === 'surf1SurfType' || label === 'surf2SurfType' || label === 'surf3SurfType';
                const isMaterial = label.toLowerCase().includes('material') || paramType === 'material';
                const isGapThicknessMode = (blockType === 'Gap' || blockType === 'AirGap') && label === 'thicknessMode';
                const isObjectDistanceMode = (blockType === 'ObjectSurface' || blockType === 'ObjectPlane') && label === 'objectDistanceMode';
                const isImageSemidiaMode = blockType === 'ImageSurface' && label === 'semidiaMode';
                const isApertureShape = (blockType === 'Mirror' || blockType === 'SingleSurface' || blockType === 'ImageSurface') && label === 'apertureShape';
                const isCoordReturn = blockType === 'CoordTrans' && label === 'coordReturn';
                const isCoordOrder = blockType === 'CoordTrans' && label === 'order';
                const isCoordToSurf = blockType === 'CoordTrans' && label === 'toSurf';
                // Exclude nd, vd, abbe from slider display - they should be text input only
                const isGlassProperty = label === 'nd' || label === 'vd' || label === 'abbe';
                const isNumeric = !isMaterial && !isSurfType && !isGlassProperty && !isGapThicknessMode && !isObjectDistanceMode && !isImageSemidiaMode && !isApertureShape && !isCoordReturn && !isCoordOrder && !isCoordToSurf && !isNaN(parseFloat(String(value)));
                
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
                } else if (isGapThicknessMode) {
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

                    const normalized = String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();
                    const currentValue = (normalized === 'IMD' || normalized === 'BFL') ? normalized : '';

                    const options = [
                        { value: '', label: 'Manual' },
                        { value: 'IMD', label: 'Image distance (IMD)' },
                        { value: 'BFL', label: 'Back focal length (BFL)' }
                    ];

                    options.forEach(({ value: optValue, label: optLabel }) => {
                        const option = document.createElement('option');
                        option.value = optValue;
                        option.textContent = optLabel;
                        if (optValue === currentValue) {
                            option.selected = true;
                        }
                        select.appendChild(option);
                    });

                    const applyThicknessFromMode = (mode: string) => {
                        if (mode !== 'IMD' && mode !== 'BFL') return;
                        try {
                            const blocks = Array.isArray(blocksInOrder) && blocksInOrder.length > 0
                                ? blocksInOrder
                                : (() => {
                                    const systemConfig = loadSystemConfigurations();
                                    const activeConfig = systemConfig?.configurations?.find((c: any) => c.id === systemConfig?.activeConfigId)
                                        || systemConfig?.configurations?.[0];
                                    return Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
                                })();

                            const exp = expandBlocksToOpticalSystemRows(blocks);
                            const rows = exp && Array.isArray(exp.rows) ? exp.rows : [];
                            if (rows.length === 0) return;
                            const primaryWavelength = (() => {
                                try {
                                    if (typeof w.getPrimaryWavelength === 'function') {
                                        const wl = Number(w.getPrimaryWavelength());
                                        if (Number.isFinite(wl) && wl > 0) return wl;
                                    }
                                } catch (_) {}
                                return NaN;
                            })();
                            if (!(Number.isFinite(primaryWavelength) && primaryWavelength > 0)) {
                                console.warn('⚠️ [DesignIntent] Primary wavelength is unavailable. thicknessMode auto-apply is skipped.');
                                return;
                            }

                            const paraxial = calculateParaxialData(rows, primaryWavelength);
                            const target = mode === 'IMD' ? paraxial?.imageDistance : paraxial?.backFocalLength;
                            const numeric = Number(target);
                            if (Number.isFinite(numeric)) {
                                const currentThickness = (params as any)?.thickness;
                                cooptApplyBlockValue(blockId, 'parameters.thickness', currentThickness, numeric);
                            }
                        } catch (err) {
                            console.warn('⚠️ [DesignIntent] Failed to apply thicknessMode:', err);
                        }
                    };

                    select.addEventListener('change', () => {
                        const newValue = select.value;
                        if (newValue !== value) {
                            cooptApplyBlockValue(blockId, path, value, newValue);
                            applyThicknessFromMode(newValue);
                        }
                    });

                    inputElement = select;
                } else if (isObjectDistanceMode) {
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

                    const normalized = String(value ?? '').trim();
                    const isInf = __coopt_isInfLike(normalized) || normalized.toUpperCase() === 'INFINITY';
                    const currentValue = isInf ? 'INF' : 'Finite';
                    const options = [
                        { value: 'INF', label: 'Infinity' },
                        { value: 'Finite', label: 'Finite' }
                    ];

                    options.forEach(({ value: optValue, label: optLabel }) => {
                        const option = document.createElement('option');
                        option.value = optValue;
                        option.textContent = optLabel;
                        if (optValue === currentValue) {
                            option.selected = true;
                        }
                        select.appendChild(option);
                    });

                    select.addEventListener('change', () => {
                        const newValue = select.value;
                        if (newValue !== value) {
                            cooptApplyBlockValue(blockId, path, value, newValue);
                            if (newValue === 'Finite') {
                                const currentDistance = (params as any)?.objectDistance;
                                const distanceValue = Number(currentDistance);
                                if (!Number.isFinite(distanceValue)) {
                                    cooptApplyBlockValue(blockId, 'parameters.objectDistance', currentDistance, 10);
                                }
                            }
                        }
                    });

                    inputElement = select;
                } else if (isImageSemidiaMode) {
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

                    const normalized = String(value ?? '').trim().toLowerCase();
                    const currentValue = normalized === 'auto' ? 'Auto' : 'Manual';
                    const options = ['Manual', 'Auto'];
                    options.forEach((opt) => {
                        const option = document.createElement('option');
                        option.value = opt;
                        option.textContent = opt;
                        if (opt === currentValue) option.selected = true;
                        select.appendChild(option);
                    });

                    select.addEventListener('change', () => {
                        const newMode = select.value;
                        if (newMode !== value) {
                            cooptApplyBlockValue(blockId, path, value, newMode);
                            const currentOpt = params ? (params as any).optimizeSemiDia : undefined;
                            const nextOpt = newMode === 'Auto' ? 'A' : '';
                            if (currentOpt !== nextOpt) {
                                cooptApplyBlockValue(blockId, 'parameters.optimizeSemiDia', currentOpt, nextOpt);
                            }

                            if (newMode === 'Auto') {
                                setTimeout(() => {
                                    try {
                                        if (typeof w.calculateImageSemiDiaFromChiefRays === 'function') {
                                            Promise.resolve(w.calculateImageSemiDiaFromChiefRays())
                                                .then(() => {
                                                    try { refreshBlockInspector(); } catch (_) {}
                                                })
                                                .catch((err: any) => {
                                                    console.warn('⚠️ [DesignIntent] semidiaMode Auto recalculation failed:', err);
                                                });
                                        }
                                    } catch (err) {
                                        console.warn('⚠️ [DesignIntent] semidiaMode Auto trigger failed:', err);
                                    }
                                }, 0);
                            }
                        }
                    });

                    inputElement = select;
                } else if (isCoordReturn) {
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

                    const normalized = String(value ?? '').trim().toLowerCase();
                    const currentValue = (normalized === 'xyz' || normalized === 'none') ? normalized : 'none';
                    const options = [
                        { value: 'xyz', label: 'On' },
                        { value: 'none', label: 'Off' }
                    ];

                    options.forEach(({ value: optValue, label: optLabel }) => {
                        const option = document.createElement('option');
                        option.value = optValue;
                        option.textContent = optLabel;
                        if (optValue === currentValue) option.selected = true;
                        select.appendChild(option);
                    });

                    select.addEventListener('change', async () => {
                        const newValue = select.value;
                        if (newValue !== value) {
                            cooptApplyBlockValue(blockId, path, value, newValue);
                            if (newValue === 'xyz') {
                                const oldOrder = Number((params as any)?.order ?? 0);
                                if (oldOrder !== 1) {
                                    cooptApplyBlockValue(blockId, 'parameters.order', oldOrder, 1);
                                }
                                try {
                                    await performCoordTransCalculation(blockId, panel);
                                } catch (err) {
                                    console.error('[CoordTrans] Auto calculation on ON failed:', err);
                                }
                            }
                        }
                    });

                    inputElement = select;
                } else if (isCoordOrder) {
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

                    // Convert value to numeric for comparison
                    const numValue = Number(value ?? 1);
                    const currentValue = (numValue === 0 || numValue === 1) ? numValue : 1;
                    
                    const options = [
                        { value: '0', label: 'Tilt → Decenter' },
                        { value: '1', label: 'Decenter → Tilt' }
                    ];

                    options.forEach(({ value: optValue, label: optLabel }) => {
                        const option = document.createElement('option');
                        option.value = optValue;
                        option.textContent = optLabel;
                        if (parseInt(optValue) === currentValue) option.selected = true;
                        select.appendChild(option);
                    });

                    select.addEventListener('change', () => {
                        const newValue = parseInt(select.value);
                        const oldValue = Number(value ?? 1);
                        if (newValue !== oldValue) {
                            cooptApplyBlockValue(blockId, path, oldValue, newValue);
                        }
                    });

                    inputElement = select;
                } else if (isCoordToSurf) {
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

                    const options: Array<{ value: string; label: string }> = [];
                    try {
                        if (Array.isArray(blocksInOrder) && blocksInOrder.length > 0 && typeof expandBlocksToOpticalSystemRows === 'function') {
                            const exp = expandBlocksToOpticalSystemRows(blocksInOrder as any);
                            const rows = exp && Array.isArray(exp.rows) ? exp.rows : [];
                            let surfaceOrdinal = 0;
                            const surfaceIndexInBlock = new Map<string, number>();
                            for (let idx = 0; idx < rows.length; idx++) {
                                const r = rows[idx];
                                const rowBlockType = String(r?._blockType ?? r?.type ?? '').trim();
                                if (
                                    rowBlockType === 'Gap' ||
                                    rowBlockType === 'AirGap' ||
                                    rowBlockType === 'CoordTrans' ||
                                    rowBlockType === 'ObjectSurface' ||
                                    rowBlockType === 'ObjectPlane' ||
                                    rowBlockType === 'Object'
                                ) {
                                    continue;
                                }

                                surfaceOrdinal += 1;
                                const rowBlockId = String(r?._blockId ?? '').trim();
                                const perBlockIdx = (surfaceIndexInBlock.get(rowBlockId) || 0) + 1;
                                surfaceIndexInBlock.set(rowBlockId, perBlockIdx);

                                const blockDisplay = displayLabelByBlockId.get(rowBlockId) || rowBlockId || `Surface`;
                                options.push({
                                    value: String(surfaceOrdinal),
                                    label: `${surfaceOrdinal}: ${blockDisplay} S${perBlockIdx}`
                                });
                            }
                        }
                    } catch (_) {}

                    const rawCurrent = Number(value);
                    const hasCurrent = Number.isFinite(rawCurrent) && options.some(o => Number(o.value) === rawCurrent);
                    if (!hasCurrent && Number.isFinite(rawCurrent)) {
                        options.unshift({ value: String(rawCurrent), label: `${rawCurrent}: (current)` });
                    }
                    if (options.length === 0) {
                        options.push({ value: String(Number.isFinite(rawCurrent) ? rawCurrent : 1), label: '1: Surface 1' });
                    }

                    const currentValue = hasCurrent
                        ? String(rawCurrent)
                        : String(Number.isFinite(rawCurrent) ? rawCurrent : Number(options[0].value));

                    options.forEach(({ value: optValue, label: optLabel }) => {
                        const option = document.createElement('option');
                        option.value = optValue;
                        option.textContent = optLabel;
                        if (optValue === currentValue) option.selected = true;
                        select.appendChild(option);
                    });

                    select.addEventListener('change', async () => {
                        const newValue = Number(select.value);
                        const oldValue = Number(value);
                        if (Number.isFinite(newValue) && newValue !== oldValue) {
                            cooptApplyBlockValue(blockId, path, oldValue, newValue);
                            const coordReturnMode = String((params as any)?.coordReturn ?? '').trim().toLowerCase();
                            if (coordReturnMode === 'xyz') {
                                try {
                                    await performCoordTransCalculation(blockId, panel);
                                } catch (err) {
                                    console.error('[CoordTrans] Auto calculation on toSurf change failed:', err);
                                }
                            }
                        }
                    });

                    inputElement = select;
                } else if (isApertureShape) {
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

                    const normalized = String(value ?? '').trim();
                    const normalizeShape = (v: string): string => {
                        const key = v.replace(/\s+/g, '').replace(/[_-]+/g, '').toLowerCase();
                        if (key === 'circle' || key === 'circular') return 'Circular';
                        if (key === 'square' || key === 'sq') return 'Square';
                        if (key === 'rect' || key === 'rectangle' || key === 'rectangular') return 'Rectangular';
                        return 'Circular'; // default
                    };
                    const currentValue = normalizeShape(normalized) || 'Circular';
                    const options = ['Circular', 'Square'];
                    options.forEach((opt) => {
                        const option = document.createElement('option');
                        option.value = opt;
                        option.textContent = opt;
                        if (opt === currentValue) option.selected = true;
                        select.appendChild(option);
                    });

                    select.addEventListener('change', () => {
                        const newValue = select.value;
                        if (newValue !== currentValue) {
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

                                        const abbeFieldPath = path.replace(/material/i, 'abbe');
                                        if (abbeFieldPath !== path && Number.isFinite(glass.vd)) {
                                            try {
                                                cooptApplyBlockValue(blockId, abbeFieldPath, undefined, String(glass.vd));
                                            } catch (_) {}
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

                        const resolveAbbeKeyForMaterial = (materialKey: string): string => {
                            const key = String(materialKey || '').trim().toLowerCase();
                            const m = key.match(/^material(\d+)$/);
                            if (m && m[1]) return `abbe${m[1]}`;
                            return 'abbe';
                        };

                        const resolveVdKeyForMaterial = (materialKey: string): string => {
                            const key = String(materialKey || '').trim().toLowerCase();
                            const m = key.match(/^material(\d+)$/);
                            if (m && m[1]) return `vd${m[1]}`;
                            return 'vd';
                        };

                        const resolveTargetVdFromParameters = (): number | null => {
                            const p: any = params && typeof params === 'object' ? params : null;
                            if (!p) return null;

                            const materialKey = String(label || '').trim();
                            const abbeKey = resolveAbbeKeyForMaterial(materialKey);
                            const vdKey = resolveVdKeyForMaterial(materialKey);

                            const abbeVal = parseFloat(String(p[abbeKey]));
                            if (Number.isFinite(abbeVal) && abbeVal > 0) return abbeVal;

                            const vdVal = parseFloat(String(p[vdKey]));
                            if (Number.isFinite(vdVal) && vdVal > 0) return vdVal;

                            return null;
                        };

                        const parseStrictNumericMaterialNd = (material: string): number | null => {
                            const value = String(material || '').trim();
                            if (!value) return null;
                            if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return null;
                            const nd = Number(value);
                            if (!Number.isFinite(nd) || nd <= 0 || nd >= 4) return null;
                            return nd;
                        };
                        
                        let similarGlasses: any[] = [];
                        let isNumericSearch = false;
                        
                        // Check if current material is a numeric value
                        const numericValue = parseStrictNumericMaterialNd(currentMaterial);
                        if (numericValue !== null) {
                            // Search by nd plus sibling abbe/vd
                            isNumericSearch = true;
                            try {
                                const targetVd = resolveTargetVdFromParameters();
                                if (targetVd === null) {
                                    alert('Abbe (Vd) value is required for numeric material search.');
                                    return;
                                }
                                similarGlasses = findSimilarGlassesByNdVd(numericValue, targetVd, 20);
                                console.log('✅ Found', similarGlasses.length, 'glasses with similar nd/vd to', numericValue, targetVd);
                            } catch (err) {
                                console.error('❌ Failed to find glasses by numeric nd/abbe:', err);
                            }
                        } else {
                            // Search by nd and vd for glass names
                            let targetNd: number | null = null;
                            let targetVd: number | null = null;
                            
                            // Try to get current glass properties
                            if (currentMaterial) {
                                try {
                                    const glassData = getGlassDataWithSellmeier(currentMaterial);
                                    
                                    if (glassData && glassData.nd !== undefined && glassData.vd !== undefined) {
                                        targetNd = glassData.nd;
                                        targetVd = glassData.vd;
                                        console.log('✅ Found glass properties - nd:', targetNd, 'vd:', targetVd);
                                    } else {
                                        alert('Current material does not have valid nd/vd in the glass database.');
                                        return;
                                    }
                                } catch (err) {
                                    console.warn('❌ Failed to get glass data:', err);
                                    alert('Failed to resolve nd/vd from current material.');
                                    return;
                                }
                            } else {
                                alert('Enter a material name or numeric nd value first.');
                                return;
                            }

                            if (!Number.isFinite(targetNd) || !Number.isFinite(targetVd)) {
                                alert('Valid nd/vd values are required to search similar glasses.');
                                return;
                            }
                            
                            console.log('🔍 Searching for glasses similar to nd:', targetNd, 'vd:', targetVd);
                            
                            // Find similar glasses using imported function
                            try {
                                similarGlasses = findSimilarGlassesByNdVd(targetNd as number, targetVd as number, 20);
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
                            item.textContent = `${idx + 1}. ${glass.name} [${glass.manufacturer}] (nd=${glass.nd.toFixed(4)}, vd=${glass.vd.toFixed(1)})`;
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
                                
                                // Set abbe field to the glass's Vd value when glass is selected
                                const abbeFieldPath = path.replace(/material/i, 'abbe');
                                if (abbeFieldPath !== path && glass.vd !== undefined) {
                                    try {
                                        // Set abbe to the Vd value of the selected glass
                                        cooptApplyBlockValue(blockId, abbeFieldPath, undefined, String(glass.vd));
                                    } catch (_) {}
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

                    // Control abbe field enable/disable based on material numeric/name state
                    const parseStrictNumericMaterial = (material: string): boolean => {
                        const val = String(material || '').trim();
                        if (!val) return false;
                        return /^[+-]?(?:\d+\.?\d*|\d*\.\d+)$/.test(val);
                    };

                    const updateAbbeFieldState = () => {
                        const abbeFieldPath = path.replace(/material/i, 'abbe');
                        if (abbeFieldPath === path) return; // No abbe field
                        
                        const isNumeric = parseStrictNumericMaterial(input.value);
                        
                        // Find abbe input by searching for rows with abbe label near this material input
                        const allRows = Array.from(panel.querySelectorAll('div[style*="display: flex"]'));
                        
                        // Find the row containing this material input
                        let materialRowIdx = -1;
                        for (let i = 0; i < allRows.length; i++) {
                            if (allRows[i].contains(input)) {
                                materialRowIdx = i;
                                break;
                            }
                        }
                        
                        // Look for abbe input in the next few rows
                        if (materialRowIdx >= 0) {
                            for (let i = materialRowIdx + 1; i < allRows.length && i < materialRowIdx + 3; i++) {
                                const row = allRows[i];
                                const spans = Array.from(row.querySelectorAll('span'));
                                const hasAbbeLabel = spans.some(s => String(s.textContent || '').toLowerCase().includes('abbe'));
                                
                                if (hasAbbeLabel) {
                                    const abbeInputs = Array.from(row.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
                                    for (const abbeInput of abbeInputs) {
                                        abbeInput.disabled = !isNumeric;
                                        abbeInput.style.opacity = isNumeric ? '1' : '0.5';
                                        abbeInput.style.pointerEvents = isNumeric ? 'auto' : 'none';
                                    }
                                    console.log(`📝 [Abbe Control] Material=${isNumeric ? 'numeric' : 'glass name'} → Abbe ${isNumeric ? 'enabled' : 'disabled'}`);
                                    return;
                                }
                            }
                        }
                    };

                    input.addEventListener('input', updateAbbeFieldState);
                    input.addEventListener('change', updateAbbeFieldState);
                    
                    // Initial state (deferred to allow DOM to settle)
                    setTimeout(updateAbbeFieldState, 200);

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
                    if (blockType === 'ImageSurface' && key === 'optimizeSemiDia') {
                        continue;
                    }
                    // Skip thickness field for ImageSurface (image plane doesn't need thickness)
                    if (blockType === 'ImageSurface' && key === 'thickness') {
                        continue;
                    }
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
                    if (blockType === 'ImageSurface' && key === 'semidiaMode' && (value === undefined || value === null || String(value).trim() === '')) {
                        const opt = String((params as any)?.optimizeSemiDia ?? '').trim().toUpperCase();
                        value = (opt === 'A' || opt === 'AUTO') ? 'Auto' : 'Manual';
                    }
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
                    
                    // nd/vd display is no longer shown here -- abbe field already holds vd,
                    // and nd can be looked up via the glass search button.
                    // Previously showed ↳ nd: / ↳ vd: below material, now removed per user request.
                    const isMaterialParam = key === 'material' || key === 'material1' || key === 'material2' || key === 'material3';
                    if (false && isMaterialParam) {
                        // intentionally disabled
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

            // Add aperture section for blocks that have aperture data
            const aperture = (realBlock.aperture && typeof realBlock.aperture === 'object') ? realBlock.aperture : null;
            if (aperture && Object.keys(aperture).length > 0) {
                panel.appendChild(createSectionTitle('Aperture (Semidiameter)'));
                
                // Sort aperture keys with Lens compatibility:
                // internal keys may be front/back, but UI should show s1/s2 and keep front->back order.
                const apertureKeys = Object.keys(aperture).sort((a, b) => {
                    const rank = (k: string): number => {
                        const key = String(k ?? '').trim().toLowerCase();
                        if (key === 'front') return 1;
                        if (key === 'back') return 2;
                        const m = key.match(/^s(\d+)$/);
                        if (m) return 100 + parseInt(m[1], 10);
                        return 1000;
                    };
                    const ra = rank(a);
                    const rb = rank(b);
                    if (ra !== rb) return ra - rb;
                    return a.localeCompare(b);
                });
                for (const key of apertureKeys) {
                    const value = (aperture as any)[key];
                    const displayKey = key === 'front' ? 's1' : (key === 'back' ? 's2' : key);
                    
                    // Create row with optimize checkbox and scope selector
                    const apertureRow = document.createElement('div');
                    apertureRow.style.display = 'flex';
                    apertureRow.style.alignItems = 'center';
                    apertureRow.style.gap = '6px';
                    apertureRow.style.marginBottom = '6px';

                    // Optimize checkbox
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.style.flex = '0 0 auto';
                    cb.style.width = '16px';
                    cb.style.height = '16px';
                    cb.style.margin = '0 4px 0 0';
                    cb.checked = false; // Aperture typically not optimized
                    cb.addEventListener('click', (e) => e.stopPropagation());

                    // Scope select (Per-config / Shared)
                    const scopeSel = document.createElement('select');
                    scopeSel.style.flex = '0 0 110px';
                    scopeSel.style.fontSize = '12px';
                    scopeSel.style.padding = '2px 4px';
                    scopeSel.innerHTML = '<option value="perConfig">Per-config</option><option value="global">Shared (all configs)</option>';
                    scopeSel.value = 'perConfig';
                    scopeSel.disabled = true;
                    scopeSel.addEventListener('click', (e) => e.stopPropagation());

                    cb.addEventListener('change', (e) => {
                        e.stopPropagation();
                        try { scopeSel.disabled = !cb.checked; } catch (_) {}
                    });

                    const innerRow = createRow(displayKey, value, `aperture.${key}`);
                    innerRow.style.flex = '1';
                    innerRow.style.marginBottom = '0';

                    apertureRow.appendChild(cb);
                    apertureRow.appendChild(scopeSel);
                    apertureRow.appendChild(innerRow);
                    panel.appendChild(apertureRow);
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
                        if (rowBlockType === 'ObjectSurface' || rowBlockType === 'ObjectPlane' || rowBlockType === 'Object') continue;
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

                    const tab = (w.tableOpticalSystem && typeof w.tableOpticalSystem.getData === 'function')
                        ? w.tableOpticalSystem
                        : (w.opticalSystemTabulator && typeof w.opticalSystemTabulator.getData === 'function')
                            ? w.opticalSystemTabulator
                            : null;

                    if (tab) {
                        if (typeof tab.replaceData === 'function') {
                            tab.replaceData(rowsForTable);
                        } else if (typeof tab.setData === 'function') {
                            tab.setData(rowsForTable);
                        }
                    }

                    try {
                        requestUpdateSurfaceNumberSelect(w);
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
            if (typeof w.dumpOpticalSystemProvenance !== 'function') return;
            const result = w.dumpOpticalSystemProvenance({ quiet: true });
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
            const tbl = w.tableOpticalSystem || w.tableOpticalSystem;
            const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
            if (!Array.isArray(rows) || rows.length === 0) {
                alert('Expanded Optical System が見つかりません。');
                return;
            }

            const edits: any[] = [];
            try {
                const pending = w.__pendingSurfaceEdits;
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
            if (edits.length === 0 && w.__lastSurfaceEdit) edits.push(w.__lastSurfaceEdit);

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
                    const last = w.__lastActiveSurfaceCell || w.__lastSelectedSurfaceCell;
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
            try { w.__pendingSurfaceEdits = {}; } catch (_) {}
            
            try {
                const popup = w.popup3DWindow;
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

function __blocks_normalizeBlockType(raw: any): string {
    const t = String(raw ?? '').trim();
    if (t === 'ObjectPlane') return 'ObjectSurface';
    if (t === 'ImagePlane') return 'ImageSurface';
    if (t === 'AirGap') return 'Gap';
    return t;
}

function __blocks_generateUniqueBlockId(blocks: any[], blockType: string): string {
    const type = __blocks_normalizeBlockType(blockType);
    const base = type || 'Block';
    let maxNum = 0;
    const pattern = new RegExp(`^${base}-(\\d+)$`);
    for (const b of blocks || []) {
        const m = pattern.exec(String(b?.blockId || ''));
        if (m) {
            const num = parseInt(m[1], 10);
            if (num > maxNum) maxNum = num;
        }
    }
    return `${base}-${maxNum + 1}`;
}

function __blocks_makeDefaultBlock(blockType: string, blockId: string): any {
    const type = __blocks_normalizeBlockType(blockType);
    const id = String(blockId ?? '').trim();
    const base: any = {
        blockId: id,
        blockType: type,
        role: null,
        constraints: {},
        parameters: {},
        variables: {},
        metadata: { source: 'ui-add' }
    };

    if (type === 'Lens' || type === 'PositiveLens') {
        base.parameters = {
            frontRadius: 'INF',
            backRadius: 'INF',
            centerThickness: 1,
            material: 'N-BK7',
            abbe: '',
            frontSurfType: 'Spherical',
            backSurfType: 'Spherical',
            frontConic: 0,
            backConic: 0
        };
        base.aperture = {
            front: 10,
            back: 10
        };
        return base;
    }
    if (type === 'Doublet') {
        base.parameters = {
            radius1: 'INF',
            radius2: 'INF',
            radius3: 'INF',
            thickness1: 1,
            thickness2: 1,
            material1: 'N-BK7',
            material2: 'N-F2',
            abbe1: '',
            abbe2: '',
            surf1SurfType: 'Spherical',
            surf2SurfType: 'Spherical',
            surf3SurfType: 'Spherical',
            surf1Conic: 0,
            surf2Conic: 0,
            surf3Conic: 0
        };
        base.aperture = {
            s1: 10,
            s2: 10,
            s3: 10
        };
        return base;
    }
    if (type === 'Triplet') {
        base.parameters = {
            radius1: 'INF',
            radius2: 'INF',
            radius3: 'INF',
            radius4: 'INF',
            thickness1: 1,
            thickness2: 1,
            thickness3: 1,
            material1: 'N-BK7',
            material2: 'N-F2',
            material3: 'N-BK7',
            abbe1: '',
            abbe2: '',
            abbe3: '',
            surf1SurfType: 'Spherical',
            surf2SurfType: 'Spherical',
            surf3SurfType: 'Spherical',
            surf4SurfType: 'Spherical',
            surf1Conic: 0,
            surf2Conic: 0,
            surf3Conic: 0,
            surf4Conic: 0
        };
        base.aperture = {
            s1: 10,
            s2: 10,
            s3: 10,
            s4: 10
        };
        return base;
    }
    if (type === 'Gap') {
        base.blockType = 'Gap';
        base.parameters = { thickness: 1, material: 'AIR', abbe: '', thicknessMode: '' };
        return base;
    }
    if (type === 'ObjectSurface') {
        base.parameters = {
            objectDistanceMode: 'Finite',
            objectDistance: 100
        };
        return base;
    }
    if (type === 'Stop') {
        base.parameters = { semiDiameter: DEFAULT_STOP_SEMI_DIAMETER };
        return base;
    }
    if (type === 'Mirror') {
        base.parameters = {
            radius: 'INF',
            thickness: 0,
            material: 'MIRROR',
            surfType: 'Spherical',
            conic: 0,
            coef1: 0,
            coef2: 0,
            coef3: 0,
            coef4: 0,
            coef5: 0,
            coef6: 0,
            coef7: 0,
            coef8: 0,
            coef9: 0,
            coef10: 0,
            apertureShape: 'Circular',
            semidia: 10,
            apertureWidth: 20,
            apertureHeight: 20
        };
        return base;
    }
    if (type === 'CoordTrans') {
        base.parameters = {
            decenterX: 0,
            decenterY: 0,
            decenterZ: 0,
            tiltX: 0,
            tiltY: 0,
            tiltZ: 0,
            order: 0,
            coordReturn: 'none',
            toSurf: 0
        };
        return base;
    }
    if (type === 'SingleSurface') {
        base.parameters = {
            radius: 'INF',
            thickness: 10,
            material: 'AIR',
            surfType: 'Spherical',
            conic: 0,
            coef1: 0,
            coef2: 0,
            coef3: 0,
            coef4: 0,
            coef5: 0,
            coef6: 0,
            coef7: 0,
            coef8: 0,
            coef9: 0,
            coef10: 0,
            apertureShape: 'Circular',
            semidia: 10,
            apertureWidth: 20,
            apertureHeight: 20
        };
        return base;
    }
    if (type === 'ImageSurface') {
        base.parameters = {
            semidia: '',
            semidiaMode: 'Manual',
            optimizeSemiDia: ''
        };
        delete base.variables;
        return base;
    }

    base.parameters = {};
    return base;
}

function __blocks_addBlockToActiveConfig(blockType: string, insertAfterBlockId: string | null = null): any {
    const systemConfig = loadSystemConfigurations();
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) {
        return { ok: false, reason: 'systemConfigurations not found.' };
    }

    const activeId = systemConfig.activeConfigId;
    const cfgIdx = systemConfig.configurations.findIndex((c: any) => c && c.id === activeId);
    if (cfgIdx < 0) return { ok: false, reason: 'active config not found.' };

    const activeCfg = systemConfig.configurations[cfgIdx];
    if (!activeCfg || !Array.isArray(activeCfg.blocks)) return { ok: false, reason: 'active config has no blocks.' };
    const blocks = activeCfg.blocks;

    const type = __blocks_normalizeBlockType(blockType);
    if (!type) return { ok: false, reason: 'blockType is required.' };

    if (type === 'ImageSurface') {
        const already = blocks.some(b => b && String(b.blockType ?? '').trim() === 'ImageSurface');
        if (already) return { ok: false, reason: 'ImageSurface already exists (only one is supported).' };
    }

    if (type === 'ObjectSurface') {
        const already = blocks.some(b => {
            const bt = String(b?.blockType ?? '').trim();
            return bt === 'ObjectSurface' || bt === 'ObjectPlane';
        });
        if (already) return { ok: false, reason: 'ObjectSurface/ObjectPlane already exists (only one is supported).' };
    }

    // Gap requires a preceding surface (Lens/Stop/etc.) to attach to.
    if (type === 'Gap' || type === 'AirGap') {
        const afterId = String(insertAfterBlockId ?? '').trim();
        let checkIdx = -1;
        if (afterId) {
            checkIdx = blocks.findIndex(b => b && String(b.blockId ?? '').trim() === afterId);
        } else {
            // Find last non-ImageSurface block
            for (let i = blocks.length - 1; i >= 0; i--) {
                const bt = String(blocks[i]?.blockType ?? '').trim();
                if (bt !== 'ImageSurface') {
                    checkIdx = i;
                    break;
                }
            }
        }

        if (checkIdx < 0) {
            return { ok: false, reason: 'Gap requires a preceding block (e.g., Lens or Stop). Add a Lens/Stop first.' };
        }

        const prevBlock = blocks[checkIdx];
        const prevType = String(prevBlock?.blockType ?? '').trim();
        if (prevType === 'ObjectSurface' || prevType === 'ObjectPlane') {
            return { ok: false, reason: 'Gap cannot be placed directly after ObjectSurface. Add a Lens or Stop first.' };
        }
    }

    const newId = __blocks_generateUniqueBlockId(blocks, type);
    const newBlock = __blocks_makeDefaultBlock(type, newId);

    let imageIdx = blocks.findIndex(b => b && String(b.blockType ?? '').trim() === 'ImageSurface');
    if (imageIdx < 0) imageIdx = blocks.length;

    let insertIdx = imageIdx;
    if (type === 'ObjectSurface') insertIdx = 0;

    const afterId = String(insertAfterBlockId ?? '').trim();
    if (afterId) {
        const idx = blocks.findIndex(b => b && String(b.blockId ?? '').trim() === afterId);
        if (idx >= 0) insertIdx = Math.min(idx + 1, imageIdx);
    }

    blocks.splice(insertIdx, 0, newBlock);

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    try {
        const issues = validateBlocksConfiguration(activeCfg);
        const fatals = issues.filter(i => i && i.severity === 'fatal');
        if (fatals.length > 0) {
            blocks.splice(insertIdx, 1);
            return { ok: false, reason: 'block validation failed.' };
        }
    } catch (_) {}

    try {
        saveSystemConfigurations(systemConfig);
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true, blockId: newId, blockData: JSON.parse(JSON.stringify(newBlock)), insertIndex: insertIdx };
}

function __blocks_deleteBlockFromActiveConfig(blockId: string): any {
    const systemConfig = loadSystemConfigurations();
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) {
        return { ok: false, reason: 'systemConfigurations not found.' };
    }

    const activeId = systemConfig.activeConfigId;
    const cfgIdx = systemConfig.configurations.findIndex((c: any) => c && c.id === activeId);
    if (cfgIdx < 0) return { ok: false, reason: 'active config not found.' };

    const activeCfg = systemConfig.configurations[cfgIdx];
    if (!activeCfg || !Array.isArray(activeCfg.blocks)) return { ok: false, reason: 'active config has no blocks.' };
    const blocks = activeCfg.blocks;

    const id = String(blockId ?? '').trim();
    if (!id) return { ok: false, reason: 'blockId is required.' };

    const idx = blocks.findIndex(b => b && String(b.blockId ?? '').trim() === id);
    if (idx < 0) return { ok: false, reason: `block not found: ${id}` };

    const type = String(blocks[idx]?.blockType ?? '').trim();

    const removedBlock = JSON.parse(JSON.stringify(blocks[idx]));
    const removed = blocks.splice(idx, 1);

    // If ImageSurface was deleted, immediately recreate it at the end to keep system valid
    if (type === 'ImageSurface') {
        const newId = __blocks_generateUniqueBlockId(blocks, 'ImageSurface');
        const newBlock = __blocks_makeDefaultBlock('ImageSurface', newId);
        blocks.push(newBlock);
    }

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    try {
        const issues = validateBlocksConfiguration(activeCfg);
        const fatals = issues.filter(i => i && i.severity === 'fatal');
        if (fatals.length > 0) {
            blocks.splice(idx, 0, ...(removed || []));
            return { ok: false, reason: 'block validation failed.' };
        }
    } catch (_) {}

    try {
        const expanded = expandBlocksToOpticalSystemRows(activeCfg.blocks);
        if (expanded && Array.isArray(expanded.rows)) {
            activeCfg.opticalSystem = expanded.rows;
            try { saveOpticalSystemTableData(expanded.rows as any); } catch (_) {}
            try { if (typeof w.saveLensTableData === 'function') w.saveLensTableData(expanded.rows); } catch (_) {}
            try {
                if (w.tableOpticalSystem && typeof w.tableOpticalSystem.setData === 'function') {
                    w.tableOpticalSystem.setData(expanded.rows);
                }
            } catch (_) {}
        }
    } catch (_) {}

    try {
        saveSystemConfigurations(systemConfig);
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true, blockData: removedBlock, blockIndex: idx };
}

// Design Intent Add/Delete Buttons Setup
function setupDesignIntentButtons(): void {
    const addBtn = document.getElementById('design-intent-add-block-btn');
    const deleteBtn = document.getElementById('design-intent-delete-block-btn');
    const paramAllOnBtn = document.getElementById('design-intent-param-all-on-btn');
    const paramAllOffBtn = document.getElementById('design-intent-param-all-off-btn');
    const typeSelect = document.getElementById('design-intent-add-block-type') as HTMLSelectElement | null;

    if (addBtn && !addBtn.dataset.designIntentAddBound) {
        addBtn.dataset.designIntentAddBound = '1';

        addBtn.addEventListener('click', (e) => {
            try { e?.preventDefault?.(); } catch (_) {}
            try { e?.stopPropagation?.(); } catch (_) {}

            try {
                const type = String(typeSelect?.value ?? 'Lens').trim();
                const after = __blockInspectorExpandedBlockId;
                const res = __blocks_addBlockToActiveConfig(type, after);
                if (!res || res.ok !== true) {
                    alert(`Failed to add block: ${res?.reason || 'unknown error'}`);
                    return;
                }
                __blockInspectorExpandedBlockId = String(res.blockId ?? '') || null;

                // Record undo
                try {
                    if (w.undoHistory && w.AddBlockCommand && !w.undoHistory.isExecuting && res.blockData && typeof res.insertIndex === 'number') {
                        const sysConfig = loadSystemConfigurations();
                        const cmd = new w.AddBlockCommand(sysConfig.activeConfigId, res.blockData, res.insertIndex);
                        w.undoHistory.record(cmd);
                    }
                } catch (undoError) {
                }

                try { refreshBlockInspector(); } catch (_) {}
                try { if (typeof w.loadActiveConfigurationToTables === 'function') w.loadActiveConfigurationToTables(); } catch (_) {}
                try {
                    if (w.popup3DWindow && !w.popup3DWindow.closed) {
                        w.popup3DWindow.postMessage({ action: 'request-redraw' }, '*');
                    }
                } catch (_) {}
            } catch (e) {
                console.error('❌ Failed to add block:', e);
                alert(`Failed to add block: ${(e as Error)?.message || String(e)}`);
            }
        });
    }

    if (deleteBtn && !deleteBtn.dataset.designIntentDeleteBound) {
        deleteBtn.dataset.designIntentDeleteBound = '1';

        deleteBtn.addEventListener('click', (e) => {
            try { e?.preventDefault?.(); } catch (_) {}
            try { e?.stopPropagation?.(); } catch (_) {}

            try {
                const bid = String(__blockInspectorExpandedBlockId ?? '').trim();
                if (!bid) {
                    alert('Select (expand) a block first to delete.');
                    return;
                }
                const res = __blocks_deleteBlockFromActiveConfig(bid);
                if (!res || res.ok !== true) {
                    alert(`Failed to delete block: ${res?.reason || 'unknown error'}`);
                    return;
                }

                // Record undo
                try {
                    if (w.undoHistory && w.DeleteBlockCommand && !w.undoHistory.isExecuting && res.blockData && typeof res.blockIndex === 'number') {
                        const sysConfig = loadSystemConfigurations();
                        const cmd = new w.DeleteBlockCommand(sysConfig.activeConfigId, res.blockData, res.blockIndex);
                        w.undoHistory.record(cmd);
                    }
                } catch (undoError) {
                }

                __blockInspectorExpandedBlockId = null;
                try { refreshBlockInspector(); } catch (_) {}
                try { if (typeof w.loadActiveConfigurationToTables === 'function') w.loadActiveConfigurationToTables(); } catch (_) {}
                try {
                    if (w.popup3DWindow && !w.popup3DWindow.closed) {
                        w.popup3DWindow.postMessage({ action: 'request-redraw' }, '*');
                    }
                } catch (_) {}
            } catch (e) {
                console.error('❌ Failed to delete block:', e);
                alert(`Failed to delete block: ${(e as Error)?.message || String(e)}`);
            }
        });
    }

    if (paramAllOnBtn && !paramAllOnBtn.dataset.designIntentParamAllOnBound) {
        paramAllOnBtn.dataset.designIntentParamAllOnBound = '1';
        paramAllOnBtn.addEventListener('click', (e) => {
            try { e?.preventDefault?.(); } catch (_) {}
            try { e?.stopPropagation?.(); } catch (_) {}
            const res = __blocks_setParameterAndApertureModeBulk(true);
            if (!res || res.ok !== true) {
                alert(`Failed to set Parameter All ON: ${res?.reason || 'unknown error'}`);
            }
        });
    }

    if (paramAllOffBtn && !paramAllOffBtn.dataset.designIntentParamAllOffBound) {
        paramAllOffBtn.dataset.designIntentParamAllOffBound = '1';
        paramAllOffBtn.addEventListener('click', (e) => {
            try { e?.preventDefault?.(); } catch (_) {}
            try { e?.stopPropagation?.(); } catch (_) {}
            const res = __blocks_setParameterAndApertureModeBulk(false);
            if (!res || res.ok !== true) {
                alert(`Failed to set Parameter All OFF: ${res?.reason || 'unknown error'}`);
            }
        });
    }
}

// Main DOM Event Handlers Setup Function
export function setupDOMEventHandlers(): void {
    try {
        setupImportZemaxButton();
        setupExportZemaxButton();
        setupOptimizeDesignIntentButton();
        setupSuggestOptimizeButtons();
        setupNewFileButton();
        setupSaveButton();
        setupShareUrlButton();
        setupLoadDefaultButton();
        setupLoadAllButton();
        setupClearStorageButton();
        setupDesignIntentButtons(); // Add Design Intent Add/Delete buttons
        
        // setupOpticalSystemChangeListeners needs to wait for React to mount the button
        // It will be called after React mount event
        
        setupParaxialButton();
        setupSeidelButton();
        setupSeidelAfocalButton();
        setupCoordinateTransformButton();
        setupSpotDiagramButton();
        setupLongitudinalAberrationButton();
        setupTransverseAberrationButton();
        setupMagnificationChromaticAberrationButton();
        setupDistortionButton();
        setupIntegratedAberrationButton();
        setupAstigmatismButton();
        
        setupPSFDisplaySettings();
        setupPSFDisplayModeButtons();
        
        setupApplyToDesignIntentButton();
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
    // Listen for React mount event to setup ALL handlers after React renders
    window.addEventListener('coopt:react-mounted', () => {
        // Wait a bit for React to finish rendering all components
        setTimeout(() => {
            setupDOMEventHandlers();
            setupOpticalSystemChangeListeners(null);
            setupAnalysisWindows();
        }, 200);
    });
    
    // Fallback: if React doesn't mount for some reason
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                setupDOMEventHandlers();
                setupOpticalSystemChangeListeners(null);
                setupAnalysisWindows();
            }, 1000);
        });
    } else {
        setTimeout(() => {
            setupDOMEventHandlers();
            setupOpticalSystemChangeListeners(null);
            setupAnalysisWindows();
        }, 1000);
    }
}
