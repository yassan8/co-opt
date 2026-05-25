// ui/dom-event-handlers.ts
// DOM event handlers orchestration: comprehensive UI management for the entire application

// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;
const RENDER_DESIGN_INTENT_SYNC_KEY = 'coopt.render.designIntentLiveSync';

function __cooptIsRenderDesignIntentLiveSyncEnabled(): boolean {
    try {
        const stored = localStorage.getItem(RENDER_DESIGN_INTENT_SYNC_KEY);
        if (stored === null) {
            localStorage.setItem(RENDER_DESIGN_INTENT_SYNC_KEY, 'true');
            return true;
        }
        return stored === 'true';
    } catch (_) {
        return true;
    }
}

function __cooptGetSystemConfig(): any {
    try {
        if (typeof w.loadSystemConfigurations === 'function') {
            return w.loadSystemConfigurations();
        }
    } catch (_) {}
    try {
        return loadSystemConfigurations();
    } catch (_) {
        return null;
    }
}

function __cooptCloneSystemConfig(): any {
    try {
        const cfg = __cooptGetSystemConfig();
        return cfg && typeof cfg === 'object' ? JSON.parse(JSON.stringify(cfg)) : null;
    } catch (_) {
        return null;
    }
}

// Import statements (all .ts → .js for ESM runtime)
import { getGlassDataWithSellmeier, findSimilarGlassNames, findSimilarGlassesByNdVd } from '../data/glass.ts';
import { openGlassMapWindow } from '../data/glass-map.ts';
import {
    expandBlocksToOpticalSystemRows,
    expandBlocksIntoConfiguration,
    deriveBlocksFromLegacyOpticalSystemRows,
    evaluateZoomCompensation,
    validateZoomLawDefinitions,
    validateBlocksConfiguration,
    BLOCK_SCHEMA_VERSION
} from '../data/block-schema.ts';
import { SetBlockParameterCommand } from '../core/undo-history.ts';
import { getOrCreateCooptWindowSyncSenderId, requestRefreshBlockInspector, requestUpdateSurfaceNumberSelect } from '../core/window-facade.ts';
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
import {
    DOUBLET_BENDING_BASE_KEY,
    getDoubletBendingCurrentValue,
    isDoubletBendingBlock,
    resolveDoubletBendingUpdate,
    storeDoubletBendingBaseCurvatures,
    syncDoubletBendingState,
} from '../optimization/doublet-bending.ts';
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
import { loadBrowserDefaultProjectJson } from '../utils/default-project-loader.ts';
import { isTauriRuntime } from '../src/desktop/runtime.ts';
import { saveJsonFromNativeDialog } from '../src/desktop/adapters/file.ts';
import { basenameFromPath } from '../src/desktop/runtime.ts';
import {
    requiresExpandedRowsForDesignIntentChange,
    requiresBlockInspectorRefreshForDesignIntentChange,
    requiresZoomUiRefreshForDesignIntentChange
} from './design-intent-refresh-policy.ts';
import { clearOptimizerStop } from '../src/desktop/ipc/client.ts';

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
const COOPT_AUTO_APERTURE_MARGIN_FACTOR = 1.10;
const COOPT_AUTO_APERTURE_MARGIN_MM = 0.05;

function __cooptApplyAutoApertureMargin(radiusMm: number, factor = COOPT_AUTO_APERTURE_MARGIN_FACTOR, absoluteMm = COOPT_AUTO_APERTURE_MARGIN_MM): number {
    const radius = Number(radiusMm);
    if (!(Number.isFinite(radius) && radius > 0)) return radius;
    const marginFactor = Number.isFinite(Number(factor)) && Number(factor) >= 1 ? Number(factor) : COOPT_AUTO_APERTURE_MARGIN_FACTOR;
    const marginMm = Number.isFinite(Number(absoluteMm)) && Number(absoluteMm) >= 0 ? Number(absoluteMm) : COOPT_AUTO_APERTURE_MARGIN_MM;
    return Math.max(radius * marginFactor, radius + marginMm);
}

function __cooptAppendImageHeightDiagToSystemData(record: any): void {
    try {
        const textarea = (document.getElementById('system-data')
            || document.getElementById('systemData')
            || document.querySelector('textarea[data-system-data]')
            || document.querySelector('#system-data, #systemData, textarea.system-data')) as HTMLTextAreaElement | null;
        if (!textarea) return;
        const line = `[ImageHeightDiag] ${String(record?.label ?? 'unknown')} ${JSON.stringify(record)}`;
        textarea.value = textarea.value ? `${textarea.value}\n${line}` : line;
    } catch (_) {}
}

function __cooptSummarizeImageHeightDiag(record: any): string {
    const label = String(record?.label ?? 'unknown');
    const renderErrorX = Number(record?.renderError?.x);
    const renderErrorY = Number(record?.renderError?.y);
    const solveErrorX = Number(record?.error?.x ?? record?.solve?.error?.x);
    const solveErrorY = Number(record?.error?.y ?? record?.solve?.error?.y);
    if (Number.isFinite(renderErrorX) || Number.isFinite(renderErrorY)) {
        return `ImageHeightDiag ${label}\nrenderError: x=${Number.isFinite(renderErrorX) ? renderErrorX.toFixed(6) : 'n/a'}, y=${Number.isFinite(renderErrorY) ? renderErrorY.toFixed(6) : 'n/a'}`;
    }
    if (Number.isFinite(solveErrorX) || Number.isFinite(solveErrorY)) {
        return `ImageHeightDiag ${label}\nsolveError: x=${Number.isFinite(solveErrorX) ? solveErrorX.toFixed(6) : 'n/a'}, y=${Number.isFinite(solveErrorY) ? solveErrorY.toFixed(6) : 'n/a'}`;
    }
    return `ImageHeightDiag ${label}`;
}

function setupImageHeightDiagnosticsBridge(): void {
    if ((window as any).__cooptImageHeightDiagBridgeBound === true) return;
    (window as any).__cooptImageHeightDiagBridgeBound = true;

    window.addEventListener('message', (event) => {
        try {
            if (event?.data?.type !== 'COOPT_IMAGEHEIGHT_DIAG') return;
            const record = event.data.payload;
            const logs = Array.isArray((window as any).__COOPT_IMAGEHEIGHT_DIAG_LOGS)
                ? (window as any).__COOPT_IMAGEHEIGHT_DIAG_LOGS
                : [];
            logs.push(record);
            if (logs.length > 50) logs.splice(0, logs.length - 50);
            (window as any).__COOPT_IMAGEHEIGHT_DIAG_LOGS = logs;
            (window as any).__COOPT_LAST_IMAGEHEIGHT_DIAG = record;
        } catch (error) {
            console.warn('⚠️ [ImageHeightDiag] Failed to receive diagnostic message:', error);
        }
    });
}

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
        const delta = absVal * 0.5;
        return { min: val - delta, max: val + delta, step: absVal * 0.001, useLog: false };
    }

    if (key.includes('Thickness') || key === 'thickness' || key.includes('hickness')) {
        if (isZeroOrNaN) {
            return { min: 0, max: 20, step: 0.1, useLog: false };
        }
        return { min: 0, max: val * 2, step: val * 0.001, useLog: false };
    }

    if (key.includes('semidia') || key.includes('Semidia') || key.includes('aperture')) {
        if (isZeroOrNaN) {
            return { min: 0.1, max: 20, step: 0.1, useLog: false };
        }
        return { min: Math.max(0.1, val * 0.5), max: val * 1.5, step: val * 0.001, useLog: false };
    }

    if (key === 'conic') {
        if (isZeroOrNaN) {
            return { min: -10, max: 10, step: 0.01, useLog: false };
        }
        const absVal = Math.abs(val);
        const delta = Math.max(absVal * 0.5, 1);
        return { min: val - delta, max: val + delta, step: absVal > 1 ? absVal * 0.001 : 0.001, useLog: false };
    }

    if (key.startsWith('coef') || key.includes('Coef')) {
        if (isZeroOrNaN) {
            return { min: -10, max: 10, step: 0.001, useLog: false };
        }
        const absVal = Math.abs(val);
        const delta = Math.max(absVal * 0.5, absVal * 10);
        return { min: val - delta, max: val + delta, step: absVal * 0.01, useLog: false };
    }

    if (isZeroOrNaN) {
        return { min: -10, max: 10, step: 0.01, useLog: false };
    }

    const absVal = Math.abs(val);
    const delta = Math.max(absVal * 0.5, absVal);
    return { min: val - delta, max: val + delta, step: absVal * 0.01, useLog: false };
}

function coordTransDebugLog(message: string, ...args: any[]): void {
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
    } catch (error) {
        console.warn('[CoordTrans] Failed to write styled debug log:', error);
    }

    try {
        const op = (window as any)?.opener;
        if (op && op.console && typeof op.console.log === 'function') {
            op.console.log(message, ...args);
        }
    } catch (error) {
        console.warn('[CoordTrans] Failed to forward debug log to opener:', error);
    }

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
    } catch (error) {
        console.warn('[CoordTrans] Failed to store in-memory debug log:', error);
    }
}

try {
    (window as any).__coordTransConsoleTest = () => {
        const stamp = new Date().toISOString();
        console.log(`[CoordTrans][TEST] console output OK at ${stamp}`);
            try {
                if (persistedConfigOk) delete (window as any).__cooptPreferRuntimeSystemConfig;
                else (window as any).__cooptPreferRuntimeSystemConfig = true;
            } catch (_) {}
        coordTransDebugLog(`✅ [CoordTrans][TEST] coordTransDebugLog OK at ${stamp}`);
        return stamp;
    };
} catch (error) {
    console.warn('[CoordTrans] Failed to install __coordTransConsoleTest:', error);
}

try {
    (window as any).__coordTransConsoleTestFire = () => {
        const stamp = new Date().toISOString();
        console.error(`[CoordTrans][TEST] console.error OK at ${stamp}`);
        console.warn(`[CoordTrans][TEST] console.warn OK at ${stamp}`);
        console.info(`[CoordTrans][TEST] console.info OK at ${stamp}`);
        return stamp;
    };
} catch (error) {
    console.warn('[CoordTrans] Failed to install __coordTransConsoleTestFire:', error);
}


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
    if (t === 'Paraxial') return ['front', 'back'];
    if (t === 'Lens' || t === 'PositiveLens') return ['front', 'back'];
    if (t === 'Doublet') return ['s1', 's2', 's3'];
    if (t === 'Triplet') return ['s1', 's2', 's3', 's4'];
    if (t === 'SingleSurface' || t === 'Mirror') return ['semidia'];
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

function __zmxIsImageOpticalRow(row: any): boolean {
    if (!row || typeof row !== 'object') return false;
    const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
    return objectType === 'image' || objectType.startsWith('image');
}

function __zmxGetRayPathPointIndexForSurfaceIndex(rows: any[], surfaceIndex0: number): number | null {
    if (!Array.isArray(rows)) return null;
    const sIdx = Number(surfaceIndex0);
    if (!Number.isInteger(sIdx) || sIdx < 0 || sIdx >= rows.length) return null;
    const row = rows[sIdx];
    const surfType = String(row?.surfType ?? row?.['surf type'] ?? '').trim().toLowerCase().replace(/\s+/g, '');
    const objectType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
    const blockType = String(row?._blockType ?? row?.blockType ?? '').trim().toLowerCase();
    const isSkippedRow = objectType === 'object'
        || surfType === 'coordtrans'
        || surfType === 'coordinatebreak'
        || surfType === 'ct'
        || blockType === 'gap'
        || blockType === 'airgap';
    if (isSkippedRow) return null;

    let count = 0;
    for (let i = 0; i <= sIdx; i++) {
        const r = rows[i];
        const st = String(r?.surfType ?? r?.['surf type'] ?? '').trim().toLowerCase().replace(/\s+/g, '');
        const ot = String(r?.['object type'] ?? r?.object ?? r?.Object ?? '').trim().toLowerCase();
        const bt = String(r?._blockType ?? r?.blockType ?? '').trim().toLowerCase();
        if (ot === 'object') continue;
        if (st === 'coordtrans' || st === 'coordinatebreak' || st === 'ct') continue;
        if (bt === 'gap' || bt === 'airgap') continue;
        count++;
    }
    return count > 0 ? count : null;
}

function __zmxTransformPointToSurfaceLocal(globalPoint: any, surfaceInfo: any): { x: number; y: number; z: number } | null {
    if (!globalPoint || !surfaceInfo?.origin) return null;
    const translated = {
        x: Number(globalPoint.x) - Number(surfaceInfo.origin.x),
        y: Number(globalPoint.y) - Number(surfaceInfo.origin.y),
        z: Number(globalPoint.z) - Number(surfaceInfo.origin.z)
    };
    if (!Number.isFinite(translated.x) || !Number.isFinite(translated.y) || !Number.isFinite(translated.z)) return null;

    const mInv = surfaceInfo?.inverseRotationMatrix;
    if (Array.isArray(mInv) && Array.isArray(mInv[0])) {
        return {
            x: mInv[0][0] * translated.x + mInv[0][1] * translated.y + mInv[0][2] * translated.z,
            y: mInv[1][0] * translated.x + mInv[1][1] * translated.y + mInv[1][2] * translated.z,
            z: mInv[2][0] * translated.x + mInv[2][1] * translated.y + mInv[2][2] * translated.z
        };
    }

    const m = surfaceInfo?.rotationMatrix;
    if (Array.isArray(m) && Array.isArray(m[0])) {
        return {
            x: m[0][0] * translated.x + m[1][0] * translated.y + m[2][0] * translated.z,
            y: m[0][1] * translated.x + m[1][1] * translated.y + m[2][1] * translated.z,
            z: m[0][2] * translated.x + m[1][2] * translated.y + m[2][2] * translated.z
        };
    }

    return translated;
}

function __zmxResolveImageSurfaceSemidiaFromChiefRays(rows: any[], wavelengthMicrons: number, objectRows: any[] = []): number | null {
    try {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const imageSurfaceIndex = rows.findIndex((row: any) => __zmxIsImageOpticalRow(row));
        if (imageSurfaceIndex < 0) return null;

        const isInfinite = __zmxIsInfiniteConjugateFromObjectRow(rows[0]);
        const rowsForTrace = __zmxBuildRowsForSemidiaTrace(rows);
        const traceObjectSamples = (Array.isArray(objectRows) ? objectRows : [])
            .map((row: any) => {
                const sourceIndex = Array.isArray(objectRows) ? objectRows.indexOf(row) : -1;
                const sample = {
                    x: Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0),
                    y: Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0),
                    ...(Number.isFinite(Number(row?.z)) ? { z: Number(row.z) } : {}),
                    ...(sourceIndex >= 0 ? { objectIndex: sourceIndex } : {})
                };
                const normalized = __cooptNormalizeObjectSampleForTrace(sample, row, rowsForTrace, wavelengthMicrons, isInfinite) as any;
                if (sourceIndex >= 0 && (normalized?.objectIndex === undefined || normalized?.objectIndex === null)) {
                    normalized.objectIndex = sourceIndex;
                }
                return normalized;
            })
            .filter((sample: any) => Number.isFinite(Number(sample?.x)) && Number.isFinite(Number(sample?.y)));
        if (traceObjectSamples.length === 0) return null;

        const tracedRows = isInfinite
            ? rowsForTrace.map((row: any, index: number) => (index === 0 ? { ...(row || {}), thickness: 0 } : row))
            : rowsForTrace;
        const rays = isInfinite
            ? (typeof w.generateInfiniteSystemCrossBeam === 'function'
                ? w.generateInfiniteSystemCrossBeam(tracedRows, traceObjectSamples.map((sample: any) => ({
                    x: Number(sample?.x) || 0,
                    y: Number(sample?.y) || 0,
                    ...(Number.isInteger(Number(sample?.objectIndex)) ? { objectIndex: Number(sample.objectIndex) } : {})
                })), {
                    rayCount: 1,
                    wavelength: wavelengthMicrons,
                    debugMode: false,
                    crossType: 'both',
                    targetSurfaceIndex: imageSurfaceIndex,
                    angleUnit: 'deg',
                    chiefZ: -20
                })
                : null)
            : (typeof w.generateCrossBeam === 'function'
                ? w.generateCrossBeam(tracedRows, traceObjectSamples.map((sample: any) => ({
                    x: Number(sample?.x) || 0,
                    y: Number(sample?.y) || 0,
                    z: Number(sample?.z) || 0,
                    ...(Number.isInteger(Number(sample?.objectIndex)) ? { objectIndex: Number(sample.objectIndex) } : {})
                })), {
                    rayCount: 1,
                    wavelength: wavelengthMicrons,
                    debugMode: false,
                    crossType: 'both'
                })
                : null);
        if (!rays) return null;

        let tracedRays: any[] = [];
        if (Array.isArray(rays?.allTracedRays)) {
            tracedRays = rays.allTracedRays;
        } else if (Array.isArray(rays?.objectResults)) {
            for (const objResult of rays.objectResults) {
                if (Array.isArray(objResult?.tracedRays)) tracedRays.push(...objResult.tracedRays);
            }
        } else if (Array.isArray(rays?.rays)) {
            tracedRays = rays.rays;
        }
        if (tracedRays.length === 0) return null;

        const chiefRays = tracedRays.filter((ray: any) => {
            const type = String(ray?.beamType ?? ray?.type ?? ray?.side ?? ray?.role ?? '').trim().toLowerCase();
            return !type || type.includes('chief') || type.includes('center') || type.includes('middle');
        });
        const candidateRays = chiefRays.length > 0 ? chiefRays : tracedRays;
        const pointIndex = __zmxGetRayPathPointIndexForSurfaceIndex(tracedRows, imageSurfaceIndex);
        const calcSurfaceOrigins = (w as any).calculateSurfaceOrigins || (w as any).mainDebugFunctions?.calculateSurfaceOrigins;
        const surfaceInfoList = typeof calcSurfaceOrigins === 'function' ? calcSurfaceOrigins(tracedRows) : null;
        const imageSurfaceInfo = Array.isArray(surfaceInfoList) ? surfaceInfoList[imageSurfaceIndex] : null;

        let maxHeight = 0;
        for (const ray of candidateRays) {
            const rayPath = Array.isArray(ray?.rayPath)
                ? ray.rayPath
                : (Array.isArray(ray?.rayPathToTarget)
                    ? ray.rayPathToTarget
                    : (Array.isArray(ray?.path) ? ray.path : null));
            if (!Array.isArray(rayPath) || rayPath.length === 0) continue;

            let imagePoint = null;
            if (pointIndex !== null && pointIndex >= 0 && pointIndex < rayPath.length) {
                const direct = rayPath[pointIndex];
                if (direct && Number.isFinite(Number(direct.x)) && Number.isFinite(Number(direct.y))) {
                    imagePoint = direct;
                }
            }
            if (!imagePoint) {
                for (let i = rayPath.length - 1; i >= 0; i--) {
                    const p = rayPath[i];
                    const pSurfaceIndex = Number(p?.surfaceIndex ?? p?.surface ?? p?.surfaceIdx);
                    if (Number.isInteger(pSurfaceIndex) && pSurfaceIndex === imageSurfaceIndex) {
                        if (Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y))) {
                            imagePoint = p;
                            break;
                        }
                    }
                }
            }
            if (!imagePoint) continue;

            const localPoint = imageSurfaceInfo
                ? (__zmxTransformPointToSurfaceLocal(imagePoint, imageSurfaceInfo) || imagePoint)
                : imagePoint;
            const height = Math.max(Math.abs(Number(localPoint?.x) || 0), Math.abs(Number(localPoint?.y) || 0));
            if (Number.isFinite(height)) maxHeight = Math.max(maxHeight, height);
        }

        return maxHeight > 0 ? maxHeight : null;
    } catch (err) {
        console.warn('[autoCalculateMissingSemidia] ImageSurface chief-ray semidia resolution failed:', err);
        return null;
    }
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

function __cooptGetMaxImageHeightTargetMmFromObjectRows(objectRows: any[]): number | null {
    if (!Array.isArray(objectRows) || objectRows.length === 0) return null;
    let maxTarget = 0;
    for (const row of objectRows) {
        const posNorm = String(row?.position ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
        if (posNorm !== 'imageheight') continue;
        const x = Math.abs(Number(row?.xHeightAngle) || 0);
        const y = Math.abs(Number(row?.yHeightAngle) || 0);
        maxTarget = Math.max(maxTarget, x, y);
    }
    return maxTarget > 0 ? maxTarget : null;
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
    const hugeDiameter = hugeSemidia * 2;

    for (const row of cloned) {
        if (!row || typeof row !== 'object') continue;
        const objType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
        const surfType = String(row?.surfType ?? row?.['surf type'] ?? row?.type ?? '').trim().toLowerCase();

        if (objType === 'stop') continue;
        if (objType === 'object' || objType === 'image') continue;
        if (surfType === 'coord trans' || surfType === 'coordinate transform' || surfType === 'ct' || surfType === 'coordtrans' || surfType === 'coordinatetransform') continue;

        row.semidia = hugeSemidia;
        row.__cooptActualSemidia = hugeSemidia;
        row.__cooptExplicitApertureSemidia = hugeSemidia;
        row._apertureWidth = hugeDiameter;
        row._apertureHeight = hugeDiameter;
        row.apertureWidth = hugeDiameter;
        row.apertureHeight = hugeDiameter;
        row.apertureX = hugeDiameter;
        row.apertureY = hugeDiameter;
        row.apertureWidthMm = hugeDiameter;
        row.apertureHeightMm = hugeDiameter;
    }

    return cloned;
}

function __zmxApplyChiefRaySemidiaFloorFromImageHeight(rows: any[], wavelengthMicrons: number, objectRows: any[] = [], options: { apertureMarginFactor?: number; apertureMarginMm?: number } = {}): void {
    try {
        if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(objectRows) || objectRows.length === 0) return;
        const resolved = __cooptResolveMaxImageHeightObjectSample(objectRows);
        if (!resolved || !objectRows[resolved.index]) return;

        const imageSurfaceIndex = rows.findIndex((row: any) => __zmxIsImageOpticalRow(row));
        const rowsForTrace = __zmxBuildRowsForSemidiaTrace(rows);
        const generateChiefRay = typeof w.generateRayStartPointsForObject === 'function' ? w.generateRayStartPointsForObject : null;
        const traceRayFn = typeof w.traceRay === 'function' ? w.traceRay : null;
        const calcSurfaceOrigins = (w as any).calculateSurfaceOrigins || (w as any).mainDebugFunctions?.calculateSurfaceOrigins;
        if (typeof generateChiefRay !== 'function' || typeof traceRayFn !== 'function' || typeof calcSurfaceOrigins !== 'function') return;

        const rayStarts = generateChiefRay(objectRows[resolved.index], rowsForTrace, 1, null, {
            wavelengthUm: wavelengthMicrons,
            wavelength: wavelengthMicrons,
            aimThroughStop: true,
            useChiefRayAnalysis: true,
            allowStopBasedOriginSolve: true,
            ...(imageSurfaceIndex >= 0 ? { targetSurfaceIndex: imageSurfaceIndex } : {})
        });
        if (!Array.isArray(rayStarts) || rayStarts.length === 0) return;

        const chiefRay = rayStarts[0];
        if (!chiefRay?.startP || !chiefRay?.dir) return;

        const tracedPath = traceRayFn(
            rowsForTrace,
            {
                pos: chiefRay.startP,
                dir: chiefRay.dir,
                wavelength: wavelengthMicrons,
            },
            1.0,
            null,
            imageSurfaceIndex >= 0 ? imageSurfaceIndex : null,
            { allowNonStrict: true, requireWasmRayTracing: false, disableWasmRayTracing: false }
        );
        if (!Array.isArray(tracedPath) || tracedPath.length === 0) return;

        const surfaceInfoList = calcSurfaceOrigins(rowsForTrace);
        const updates: string[] = [];

        for (let surfaceIndex = 0; surfaceIndex < rows.length; surfaceIndex += 1) {
            const row = rows[surfaceIndex];
            if (!__zmxIsPhysicalOpticalRow(row)) continue;

            const pointIndex = __zmxGetRayPathPointIndexForSurfaceIndex(rowsForTrace, surfaceIndex);
            let point = null;
            if (pointIndex !== null && pointIndex >= 0 && pointIndex < tracedPath.length) {
                point = tracedPath[pointIndex];
            }
            if (!point) {
                for (let pathIndex = tracedPath.length - 1; pathIndex >= 0; pathIndex -= 1) {
                    const candidate = tracedPath[pathIndex];
                    const candidateSurfaceIndex = Number(candidate?.surfaceIndex ?? candidate?.surface ?? candidate?.surfaceIdx);
                    if (Number.isInteger(candidateSurfaceIndex) && candidateSurfaceIndex === surfaceIndex) {
                        point = candidate;
                        break;
                    }
                }
            }
            if (!point || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) continue;

            const surfaceInfo = Array.isArray(surfaceInfoList) ? surfaceInfoList[surfaceIndex] : null;
            const localPoint = surfaceInfo ? (__zmxTransformPointToSurfaceLocal(point, surfaceInfo) || point) : point;
            const chiefRadiusRaw = Math.hypot(Number(localPoint?.x) || 0, Number(localPoint?.y) || 0);
            if (!(Number.isFinite(chiefRadiusRaw) && chiefRadiusRaw > 0)) continue;
            const chiefRadius = __cooptApplyAutoApertureMargin(chiefRadiusRaw, options?.apertureMarginFactor, options?.apertureMarginMm);

            const prev = __zmxReadPositiveFiniteSemidiaMm(row);
            if (prev === null || chiefRadius > prev + 1e-6) {
                row.semidia = chiefRadius;
                updates.push(`Surface ${Number.isFinite(Number(row?.surf)) ? Number(row.surf) : surfaceIndex} chief=${chiefRadius.toFixed(6)}mm`);
            }
        }

        if (updates.length > 0) {
            console.log('[autoCalculateMissingSemidia] Chief-ray aperture floors:', updates);
        }
    } catch (err) {
        console.warn('[autoCalculateMissingSemidia] Chief-ray aperture floor failed:', err);
    }
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

function __zmxResolveLargestObjectSample(objectRows: any[]): { x: number; y: number; z?: number } | null {
    if (!Array.isArray(objectRows) || objectRows.length === 0) return null;

    let best: { x: number; y: number; z?: number } | null = null;
    let bestRadius = -1;
    for (const row of objectRows) {
        if (!row || typeof row !== 'object') continue;
        const x = Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0);
        const y = Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0);
        const z = Number(row?.z ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const radius = Math.sqrt(x * x + y * y);
        if (radius <= bestRadius) continue;
        bestRadius = radius;
        best = Number.isFinite(z) ? { x, y, z } : { x, y };
    }

    return bestRadius > 0 ? best : null;
}

function __cooptResolveMaxImageHeightObjectSample(objectRows: any[]): { index: number; sample: { x: number; y: number; z?: number } } | null {
    if (!Array.isArray(objectRows) || objectRows.length === 0) return null;

    let bestIndex = -1;
    let bestSample: { x: number; y: number; z?: number } | null = null;
    let bestHeight = -1;
    for (let index = 0; index < objectRows.length; index++) {
        const row = objectRows[index];
        if (!row || typeof row !== 'object') continue;
        const posNorm = String(row?.position ?? row?.object ?? row?.objectType ?? '').trim().toLowerCase();
        if (posNorm !== 'imageheight') continue;
        const x = Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0);
        const y = Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0);
        const z = Number(row?.z ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const height = Math.abs(y);
        if (height <= bestHeight) continue;
        bestHeight = height;
        bestIndex = index;
        bestSample = Number.isFinite(z) ? { x, y, z } : { x, y };
    }

    if (bestIndex < 0 || !bestSample || bestHeight <= 0) return null;
    return { index: bestIndex, sample: bestSample };
}

function __cooptNormalizeObjectSampleForTrace(sample: { x: number; y: number; z?: number }, sourceRow: any, opticalRows: any[], wavelengthMicrons: number, isInfinite: boolean): { x: number; y: number; z?: number } {
    if (!sample || typeof sample !== 'object') return { x: 0, y: 0 };
    const posNorm = String(sourceRow?.position ?? '').trim().toLowerCase();
    if (posNorm !== 'imageheight') return sample;

    const targetX = Number(sample?.x ?? 0);
    const targetY = Number(sample?.y ?? 0);

    try {
        if (typeof w.convertImageHeightToEffectiveObject === 'function') {
            const effective = w.convertImageHeightToEffectiveObject(sourceRow, opticalRows, wavelengthMicrons, isInfinite ? 'infinite' : 'finite');
            return {
                x: Number(effective?.xHeightAngle ?? effective?.x ?? targetX) || 0,
                y: Number(effective?.yHeightAngle ?? effective?.y ?? targetY) || 0,
                z: Number(effective?.z ?? sample?.z ?? 0) || 0,
            };
        }
    } catch (_) {}

    return sample;
}

function __zmxFormatLargestObjectConditionSummary(objectRows: any[]): string | null {
    if (!Array.isArray(objectRows) || objectRows.length === 0) return null;

    let bestIndex = -1;
    let bestRow: any = null;
    let bestRadius = -1;
    for (let index = 0; index < objectRows.length; index++) {
        const row = objectRows[index];
        if (!row || typeof row !== 'object') continue;
        const x = Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0);
        const y = Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const radius = Math.sqrt(x * x + y * y);
        if (radius <= bestRadius) continue;
        bestRadius = radius;
        bestIndex = index;
        bestRow = row;
    }

    if (!bestRow || bestIndex < 0 || bestRadius <= 0) return null;

    return __zmxFormatObjectConditionSummary(bestRow, bestIndex);
}

function __zmxFormatObjectConditionSummary(row: any, index: number): string | null {
    if (!row || typeof row !== 'object' || index < 0) return null;

    const x = Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0);
    const y = Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0);
    const z = Number(row?.z ?? 0);
    const position = String(row?.position ?? row?.object ?? row?.objectType ?? '').trim();
    const isAngle = position.toLowerCase() === 'angle';
    const units = isAngle ? 'deg' : 'mm';
    const parts = [`Object ${index + 1}`, position || (isAngle ? 'Angle' : 'ImageHeight')];
    parts.push(`x=${x.toFixed(3)} ${units}`);
    parts.push(`y=${y.toFixed(3)} ${units}`);
    if (!isAngle && Number.isFinite(z) && Math.abs(z) > 1e-9) parts.push(`z=${z.toFixed(3)} mm`);
    return parts.join(' | ');
}

function __cooptFormatMaxImageHeightConditionSummary(objectRows: any[]): string | null {
    const resolved = __cooptResolveMaxImageHeightObjectSample(objectRows);
    if (!resolved) return null;

    const row = objectRows[resolved.index] ?? null;
    const x = Number(resolved.sample.x ?? 0);
    const y = Number(resolved.sample.y ?? 0);
    const z = Number(resolved.sample.z ?? 0);
    const position = String(row?.position ?? row?.object ?? row?.objectType ?? 'ImageHeight').trim();
    const isAngle = position.toLowerCase() === 'angle';
    const units = isAngle ? 'deg' : 'mm';
    const parts = [`Object ${resolved.index + 1}`, position || 'ImageHeight'];
    parts.push(`maxY=${Math.abs(y).toFixed(3)} ${units}`);
    parts.push(`x=${x.toFixed(3)} ${units}`);
    parts.push(`y=${y.toFixed(3)} ${units}`);
    if (!isAngle && Number.isFinite(z) && Math.abs(z) > 1e-9) parts.push(`z=${z.toFixed(3)} mm`);
    return parts.join(' | ');
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

function __zmxApplySemidiaOverridesFromMarginalRays(rows: any[], wavelengthMicrons: number, objectRows: any[] = [], options: { forceOverwriteSemidia?: boolean; strictMaxImageHeightMarginalOnly?: boolean; apertureMarginFactor?: number; apertureMarginMm?: number } = {}): void {
    const stopIndex = rows.findIndex((r: any) => {
        const ot = String(r?.['object type'] ?? r?.object ?? '').toLowerCase();
        return ot === 'stop';
    });
    if (stopIndex < 0) return;

    const objectRow = rows[0];
    const isInfinite = __zmxIsInfiniteConjugateFromObjectRow(objectRow);

    const rowsForTrace = __zmxBuildRowsForSemidiaTrace(rows);
    const strictMaxImageHeightMarginalOnly = options?.strictMaxImageHeightMarginalOnly === true;

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

    const candidateObjectRows = (Array.isArray(objectRows) ? objectRows : []).filter((row: any) => {
        if (!row || typeof row !== 'object') return false;
        const posNorm = String(row?.position ?? row?.object ?? row?.objectType ?? '').trim().toLowerCase();
        if (strictMaxImageHeightMarginalOnly && posNorm !== 'imageheight') return false;
        const x = Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0);
        const y = Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0);
        return Number.isFinite(x) && Number.isFinite(y);
    });

    const prioritizedObjectRows = (() => {
        if (!strictMaxImageHeightMarginalOnly || candidateObjectRows.length === 0) return candidateObjectRows;

        const withRadius = candidateObjectRows
            .map((row: any) => {
                const x = Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0);
                const y = Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0);
                return { row, radius: Math.hypot(x, y) };
            })
            .filter((entry) => Number.isFinite(entry.radius));

        const offAxis = withRadius.filter((entry) => entry.radius > 1e-9);
        const chosen = offAxis.length > 0 ? offAxis : withRadius;
        chosen.sort((a, b) => b.radius - a.radius);
        return chosen.map((entry) => entry.row);
    })();

    const objectSamples = prioritizedObjectRows
        .map((row: any) => {
            const sourceIndex = Array.isArray(objectRows) ? objectRows.indexOf(row) : -1;
            const sample = {
                x: Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0),
                y: Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0),
                ...(Number.isFinite(Number(row?.z)) ? { z: Number(row.z) } : {}),
                ...(sourceIndex >= 0 ? { objectIndex: sourceIndex } : {})
            };
            const normalized = __cooptNormalizeObjectSampleForTrace(sample, row, rowsForTrace, wavelengthMicrons, isInfinite) as any;
            if (sourceIndex >= 0 && (normalized?.objectIndex === undefined || normalized?.objectIndex === null)) {
                normalized.objectIndex = sourceIndex;
            }
            return normalized;
        })
        .filter((sample: any) => Number.isFinite(Number(sample?.x)) && Number.isFinite(Number(sample?.y)));

    if (objectSamples.length === 0 && (!Number.isFinite(sampleX) || !Number.isFinite(sampleY) || sampleX <= 0 || sampleY <= 0)) return;

    const traceObjectSamples = objectSamples.length > 0
        ? objectSamples
        : (isInfinite
            ? [{ x: sampleX, y: 0 }, { x: 0, y: sampleY }]
            : [{ x: sampleX, y: 0, z: 0 }, { x: 0, y: sampleY, z: 0 }]);

    const rays = isInfinite
        ? (typeof w.generateInfiniteSystemCrossBeam === 'function'
            ? w.generateInfiniteSystemCrossBeam(rowsForTrace, traceObjectSamples.map((sample: any) => ({
                x: Number(sample?.x) || 0,
                y: Number(sample?.y) || 0,
                ...(Number.isInteger(Number(sample?.objectIndex)) ? { objectIndex: Number(sample.objectIndex) } : {})
            })), {
                rayCount: strictMaxImageHeightMarginalOnly ? 3 : 13,
                wavelength: wavelengthMicrons,
                debugMode: false,
                crossType: strictMaxImageHeightMarginalOnly ? 'vertical' : 'both'
            })
            : null)
        : (typeof w.generateCrossBeam === 'function'
            ? w.generateCrossBeam(rowsForTrace, traceObjectSamples.map((sample: any) => ({
                x: Number(sample?.x) || 0,
                y: Number(sample?.y) || 0,
                z: Number(sample?.z) || 0,
                ...(Number.isInteger(Number(sample?.objectIndex)) ? { objectIndex: Number(sample.objectIndex) } : {})
            })), {
                rayCount: strictMaxImageHeightMarginalOnly ? 3 : 13,
                wavelength: wavelengthMicrons,
                debugMode: false,
                crossType: strictMaxImageHeightMarginalOnly ? 'vertical' : 'both'
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

    const filteredRays = strictMaxImageHeightMarginalOnly
        ? allRays.filter((ray: any) => {
            const side = String(ray?.side ?? ray?.originalRay?.side ?? ray?.name ?? '').trim().toLowerCase();
            if (!side) return true;
            if (side === 'upper' || side === 'lower' || side === 'chief' || side === 'center' || side === 'middle') return true;
            if (side.includes('upper') || side.includes('lower') || side.includes('chief') || side.includes('center')) return true;
            return false;
        })
        : allRays;

    if (filteredRays.length === 0) return;

    const calcSurfaceOrigins = (w as any).calculateSurfaceOrigins || (w as any).mainDebugFunctions?.calculateSurfaceOrigins;
    const surfaceInfoList = typeof calcSurfaceOrigins === 'function' ? calcSurfaceOrigins(rowsForTrace) : null;
    const surfacePointIndices = rows.map((_: any, surfaceIndex: number) => __zmxGetRayPathPointIndexForSurfaceIndex(rowsForTrace, surfaceIndex));

    const maxBySurface = new Array(rows.length).fill(0);
    const maxBySurfaceSource = new Array(rows.length).fill(null);
    for (const ray of filteredRays) {
        const rayPath = Array.isArray(ray?.rayPath)
            ? ray.rayPath
            : (Array.isArray(ray?.rayPathToTarget)
                ? ray.rayPathToTarget
                : (Array.isArray(ray?.path)
                    ? ray.path
                    : (Array.isArray(ray?.ray?.path) ? ray.ray.path : null)));
        if (!Array.isArray(rayPath)) continue;
        for (let i = 0; i < rows.length; i++) {
            const pointIndex = surfacePointIndices[i];
            if (pointIndex === null) continue;

            let p = null;
            if (pointIndex >= 0 && pointIndex < rayPath.length) {
                p = rayPath[pointIndex];
            }
            if ((!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) && Array.isArray(rayPath)) {
                for (let pathIndex = rayPath.length - 1; pathIndex >= 0; pathIndex -= 1) {
                    const candidate = rayPath[pathIndex];
                    const candidateSurfaceIndex = Number(candidate?.surfaceIndex ?? candidate?.surface ?? candidate?.surfaceIdx);
                    if (Number.isInteger(candidateSurfaceIndex) && candidateSurfaceIndex === i) {
                        p = candidate;
                        break;
                    }
                }
            }
            if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) continue;

            const surfaceInfo = Array.isArray(surfaceInfoList) ? surfaceInfoList[i] : null;
            const localPoint = surfaceInfo ? (__zmxTransformPointToSurfaceLocal(p, surfaceInfo) || p) : p;
            const rr = Math.hypot(Number(localPoint?.x) || 0, Number(localPoint?.y) || 0);
            if (rr > maxBySurface[i]) {
                maxBySurface[i] = rr;
                maxBySurfaceSource[i] = {
                    radius: rr,
                    objectIndex: Number.isInteger(Number(ray?.objectIndex)) ? Number(ray.objectIndex) : null,
                    rayType: String(ray?.type ?? ray?.side ?? ray?.role ?? ray?.name ?? 'unknown').trim() || 'unknown'
                };
            }
        }
    }
    const forceOverwriteSemidia = options?.forceOverwriteSemidia === true;
    let updateCount = 0;
    const updateSummaries: string[] = [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r || typeof r !== 'object') continue;
        const isPhysical = __zmxIsPhysicalOpticalRow(r);
        if (!isPhysical) continue;

        const wasMissing = __zmxIsMissingSemidia(r);
        const prev = __zmxReadPositiveFiniteSemidiaMm(r);
        const maxRRaw = maxBySurface[i];
        const maxR = __cooptApplyAutoApertureMargin(maxRRaw, options?.apertureMarginFactor, options?.apertureMarginMm);
        if (maxR > 0 && (forceOverwriteSemidia || wasMissing || prev === null || maxR > (prev + 1e-6) || maxR < (prev - 1e-6))) {
            r.semidia = maxR;
            updateCount++;
            const winner = maxBySurfaceSource[i];
            const objectIndex = Number.isInteger(Number(winner?.objectIndex)) ? Number(winner.objectIndex) : null;
            const objectSummary = objectIndex !== null && Array.isArray(objectRows) && objectRows[objectIndex]
                ? __zmxFormatObjectConditionSummary(objectRows[objectIndex], objectIndex)
                : null;
            const surfaceLabel = `Surface ${Number.isFinite(Number(r?.surf)) ? Number(r.surf) : i}`;
            const typeLabel = String(r?.type ?? r?.['object type'] ?? '').trim() || 'unknown';
            updateSummaries.push([
                `${surfaceLabel} (${typeLabel})`,
                `semidia=${maxR.toFixed(6)}mm`,
                maxRRaw > 0 ? `required=${maxRRaw.toFixed(6)}mm` : null,
                winner?.rayType ? `ray=${winner.rayType}` : null,
                objectSummary ? `winner=${objectSummary}` : null
            ].filter(Boolean).join(' | '));
        }
    }
    if (updateSummaries.length > 0) {
        console.log('[autoCalculateMissingSemidia] Aperture winners by surface:', updateSummaries);
    }
}

function autoCalculateMissingSemidia(sourceRows: any[], objectRows: any[], options: { entrancePupilDiameterMm?: number; stopSemidiaWasMissing?: boolean; forceOverwriteSemidia?: boolean; strictMaxImageHeightMarginalOnly?: boolean; apertureMarginFactor?: number; apertureMarginMm?: number } = {}): void {
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

        __zmxApplySemidiaOverridesFromMarginalRays(rows, primaryWavelength, objectRows, {
            forceOverwriteSemidia: options?.forceOverwriteSemidia === true,
            strictMaxImageHeightMarginalOnly: options?.strictMaxImageHeightMarginalOnly === true,
            apertureMarginFactor: options?.apertureMarginFactor,
            apertureMarginMm: options?.apertureMarginMm
        });
        __zmxApplyChiefRaySemidiaFloorFromImageHeight(rows, primaryWavelength, objectRows, {
            apertureMarginFactor: options?.apertureMarginFactor,
            apertureMarginMm: options?.apertureMarginMm
        });

        const imageChiefSemidia = __zmxResolveImageSurfaceSemidiaFromChiefRays(rows, primaryWavelength, objectRows);
        if (Number.isFinite(imageChiefSemidia) && (imageChiefSemidia as number) > 0) {
            console.log(`[autoCalculateMissingSemidia] ImageSurface chief-ray semidia resolved but not applied=${Number(imageChiefSemidia).toFixed(6)}mm`);
        }

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

function __cooptExpectedApertureKeysForBlockType(blockTypeRaw: any): string[] {
    const blockType = String(blockTypeRaw ?? '').trim().toLowerCase();
    if (blockType === 'paraxial' || blockType === 'thinlens') return ['front'];
    if (blockType === 'lens' || blockType === 'positivelens') return ['front', 'back'];
    if (blockType === 'doublet') return ['s1', 's2', 's3'];
    if (blockType === 'triplet') return ['s1', 's2', 's3', 's4'];
    if (blockType === 'singlesurface' || blockType === 'mirror') return ['semidia'];
    return [];
}

function __cooptHasUsableApertureValue(value: any): boolean {
    if (value === null || value === undefined) return false;
    const text = String(value).trim();
    if (text === '') return false;
    const numeric = Number(text);
    return Number.isFinite(numeric) && numeric > 0;
}

function __cooptActiveConfigHasMissingTrackedAperture(systemConfig?: any): boolean {
    try {
        const cfgs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
        const activeCfg = cfgs.find((c: any) => c && String(c.id) === String(systemConfig?.activeConfigId)) || cfgs[0];
        if (!activeCfg || !Array.isArray(activeCfg.blocks)) return false;
        return activeCfg.blocks.some((block: any) => {
            const keys = __cooptExpectedApertureKeysForBlockType(block?.blockType);
            if (keys.length === 0) return false;
            const aperture = (block?.aperture && typeof block.aperture === 'object') ? block.aperture : null;
            return keys.some((key) => !__cooptHasUsableApertureValue(aperture?.[key]));
        });
    } catch (_) {
        return false;
    }
}

function __cooptAutoCalculateMissingDesignIntentApertures(): boolean {
    try {
        const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
        if (!__cooptActiveConfigHasMissingTrackedAperture(systemConfig)) return false;

        const sourceRows = (() => {
            try {
                const activeCfg = Array.isArray(systemConfig?.configurations)
                    ? (systemConfig.configurations.find((c: any) => c && String(c.id) === String(systemConfig?.activeConfigId)) || systemConfig.configurations[0])
                    : null;
                if (Array.isArray(activeCfg?.source) && activeCfg.source.length > 0) return activeCfg.source;
            } catch (_) {}
            try { return loadSourceTableData(); } catch (_) { return []; }
        })();
        const objectRows = (() => {
            try {
                const activeCfg = Array.isArray(systemConfig?.configurations)
                    ? (systemConfig.configurations.find((c: any) => c && String(c.id) === String(systemConfig?.activeConfigId)) || systemConfig.configurations[0])
                    : null;
                if (Array.isArray(activeCfg?.object) && activeCfg.object.length > 0) return activeCfg.object;
            } catch (_) {}
            try { return loadObjectTableData(); } catch (_) { return []; }
        })();

        autoCalculateMissingSemidia(sourceRows, objectRows, {});
        __zmxSyncDesignIntentApertureFromOpticalRows();
        return true;
    } catch (err) {
        console.warn('[DesignIntent] Missing aperture auto-calculation failed:', err);
        return false;
    }
}

function autoSetBlockAperturesFromLargestObjectCondition(): boolean {
    try {
        const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
        const sourceRows = (() => {
            try {
                const activeCfg = Array.isArray(systemConfig?.configurations)
                    ? (systemConfig.configurations.find((c: any) => c && String(c.id) === String(systemConfig?.activeConfigId)) || systemConfig.configurations[0])
                    : null;
                if (Array.isArray(activeCfg?.source) && activeCfg.source.length > 0) return activeCfg.source;
            } catch (_) {}
            try { return loadSourceTableData(); } catch (_) { return []; }
        })();
        const objectRows = (() => {
            try {
                const activeCfg = Array.isArray(systemConfig?.configurations)
                    ? (systemConfig.configurations.find((c: any) => c && String(c.id) === String(systemConfig?.activeConfigId)) || systemConfig.configurations[0])
                    : null;
                if (Array.isArray(activeCfg?.object) && activeCfg.object.length > 0) return activeCfg.object;
            } catch (_) {}
            try { return loadObjectTableData(); } catch (_) { return []; }
        })();

        autoCalculateMissingSemidia(sourceRows, objectRows, {
            forceOverwriteSemidia: true,
            strictMaxImageHeightMarginalOnly: true,
            apertureMarginFactor: COOPT_AUTO_APERTURE_MARGIN_FACTOR,
            apertureMarginMm: COOPT_AUTO_APERTURE_MARGIN_MM
        } as any);
        __zmxSyncDesignIntentApertureFromOpticalRows();
        return true;
    } catch (err) {
        console.warn('[DesignIntent] Largest-object aperture auto-calculation failed:', err);
        return false;
    }
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

        const imageRow = tableRows.find((row: any) => __zmxIsImageOpticalRow(row));
        const imageSemidia = imageRow ? __zmxReadPositiveFiniteSemidiaMm(imageRow) : null;
        const imageBlock = activeCfg.blocks.find((block: any) => String(block?.blockType ?? '').trim() === 'ImageSurface');
        if (imageBlock && imageSemidia !== null) {
            if (!imageBlock.parameters || typeof imageBlock.parameters !== 'object') imageBlock.parameters = {};
            imageBlock.parameters.semidia = imageSemidia;
            console.log(`[ImageSurface Sync] Block ${String(imageBlock?.blockId ?? 'unknown')} semidia = ${imageSemidia}mm`);
        }

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
        // Secondary fallback: if table rows had no provenance (e.g. Tabulator setData is async and getData
        // returned stale rows), use activeCfg.opticalSystem which was synchronously saved by
        // autoCalculateMissingSemidia with _blockId/_surfaceRole + updated semidia values.
        if (provenanceUpdateCount === 0 && Array.isArray(activeCfg?.opticalSystem) && activeCfg.opticalSystem.length > 0) {
            const configHasProvenance = activeCfg.opticalSystem.some((r: any) => String(r?._blockId ?? '').trim());
            if (configHasProvenance) {
                console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] Table had no _blockId, falling back to activeCfg.opticalSystem for provenance sync');
                for (const row of activeCfg.opticalSystem) {
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
                    console.log(`[Config Provenance Sync] Block ${bid} (${block.blockType}) ${role} = ${semidia}mm`);
                }
                console.log(`[__zmxSyncDesignIntentApertureFromOpticalRows] Config provenance updates: ${provenanceUpdateCount}`);
            }
        }
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
    const loadSessionId = (() => {
        try {
            const next = Number((window as any).__cooptFileLoadSessionId || 0) + 1;
            (window as any).__cooptFileLoadSessionId = next;
            (window as any).__cooptFileLoadInProgress = true;
            return next;
        } catch (_) {
            return Date.now();
        }
    })();
    const isStaleLoadSession = (): boolean => {
        try {
            return Number((window as any).__cooptFileLoadSessionId || 0) !== Number(loadSessionId);
        } catch (_) {
            return false;
        }
    };

    try {
        (window as any).__cooptSuppressStartupConfigApplyUntil = Date.now() + 5000;
    } catch (_) {}

    // File load must not race an optimizer popup. If optimization is active, block
    // the load. If the popup is only open/idle, close it and clear its transient
    // state before rebinding tables/configuration to the new design.
    try {
        const g = (typeof globalThis !== 'undefined') ? globalThis as any : null;
        const popup = g?.__cooptOptimizerSchedulerWindow;
        const popupClosed = !popup || popup.closed;
        const popupPhase = popupClosed
            ? ''
            : String(popup?.document?.getElementById('opt-phase')?.textContent || '').trim().toLowerCase();
        const popupRunDisabled = popupClosed
            ? false
            : !!popup?.document?.getElementById('opt-run')?.disabled;
        const popupStopDisabled = popupClosed
            ? true
            : !!popup?.document?.getElementById('opt-stop')?.disabled;
        const popupLooksIdle = popupClosed
            || popupPhase === ''
            || popupPhase === '-'
            || popupPhase === 'ready'
            || popupPhase === 'done'
            || popupPhase === 'stopped'
            || popupPhase === 'error'
            || (!popupRunDisabled && popupStopDisabled);

        if (g?.__cooptOptimizerIsRunning === true && !popupLooksIdle) {
            alert('Optimization is still running. Stop it or close the optimize window before loading a file.');
            return false;
        }

        if (!popupClosed && popupLooksIdle) {
            try { popup.close(); } catch (_) {}
            if (g?.__cooptOptimizerSchedulerWindow === popup) {
                g.__cooptOptimizerSchedulerWindow = null;
            }
        }

        if (g?.__cooptOptimizerIsRunning === true && popupLooksIdle) {
            g.__cooptOptimizerIsRunning = false;
        }
        if (g?.__cooptOptimizerIsRunning !== true) {
            g.__cooptOpticalSystemRowsOverride = null;
        }
    } catch (_) {}

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

            // Only derive blocks when missing. Existing blocks are the authoritative
            // Design Intent and may contain information that cannot be reconstructed
            // from expanded opticalSystem rows (for example Paraxial focalLength V vars).
            if (!hasBlocks && typeof w.deriveBlocksFromLegacyOpticalSystemRows === 'function') {
                const derived = w.deriveBlocksFromLegacyOpticalSystemRows(legacyRows);
                const hasFatal = Array.isArray(derived?.issues) && derived.issues.some((i: any) => i && i.severity === 'fatal');

                if (!hasFatal && Array.isArray(derived?.blocks) && derived.blocks.length > 0) {
                    cfg.blocks = Array.isArray(derived?.blocks) ? derived.blocks : [];
                    if (!cfg.metadata || typeof cfg.metadata !== 'object') cfg.metadata = {};
                    cfg.metadata.importAnalyzeMode = false;
                }
            } else if (typeof w.expandBlocksIntoConfiguration === 'function') {
                // Existing blocks stay authoritative, but imported legacy rows may still
                // contain semidia that needs to be persisted into block.aperture so the
                // Design Intent inspector can display and edit Aperture (Semidiameter).
                w.expandBlocksIntoConfiguration(cfg);
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

    const buildPersistableConfig = (config: any): any => {
        try {
            const cloned = JSON.parse(JSON.stringify(config));
            const cfgs = Array.isArray(cloned?.configurations) ? cloned.configurations : [];
            for (const cfg of cfgs) {
                if (!cfg || typeof cfg !== 'object') continue;
                // Source is persisted globally; per-config duplicates increase storage pressure.
                try { delete cfg.source; } catch (_) {}
                // For block-driven designs, expanded optical rows are derivable and can be large.
                if (Array.isArray(cfg.blocks) && cfg.blocks.length > 0) {
                    try { delete cfg.opticalSystem; } catch (_) {}
                }
            }
            return cloned;
        } catch (_) {
            return config;
        }
    };

    const clearTransientStoragePressureKeys = (): void => {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return;
            const keys = [
                'lastWavefrontSnapshot',
                'lastPsfMeta',
                'lastPsfError',
                'spotDiagramSettingsByConfigId',
                'lastSpotDiagramSettings',
                'lastSpotSettings'
            ];
            for (const key of keys) {
                try { localStorage.removeItem(key); } catch (_) {}
            }
        } catch (_) {}
    };

    const clearTableProjectionKeys = (): void => {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return;
            const keys = [
                'sourceTableData',
                'objectTableData',
                'OpticalSystemTableData',
                'systemRequirementsData',
                'meritFunctionData',
                'systemData'
            ];
            for (const key of keys) {
                try { localStorage.removeItem(key); } catch (_) {}
            }
        } catch (_) {}
    };

    const scheduleDeferredLoadWork = (work: () => void, delayMs = 120): void => {
        const run = () => {
            window.setTimeout(() => {
                try { work(); } catch (_) {}
            }, delayMs);
        };
        try {
            const ric = (window as any).requestIdleCallback;
            if (typeof ric === 'function') {
                ric(() => run(), { timeout: Math.max(250, delayMs) });
                return;
            }
        } catch (_) {}
        try {
            window.requestAnimationFrame(() => run());
            return;
        } catch (_) {}
        run();
    };

    const verifyPersistedConfig = (expected: any): boolean => {
        try {
            const reloaded = loadSystemConfigurationsFromTableConfig();
            const expectedCfgs = Array.isArray(expected?.configurations) ? expected.configurations : [];
            const actualCfgs = Array.isArray(reloaded?.configurations) ? reloaded.configurations : [];
            if (expectedCfgs.length === 0 || actualCfgs.length === 0) return false;
            if (actualCfgs.length < expectedCfgs.length) return false;

            const expectedActiveId = expected?.activeConfigId;
            const actualActiveId = reloaded?.activeConfigId;
            if (String(expectedActiveId ?? '') !== String(actualActiveId ?? '')) return false;

            const expectedActiveCfg = expectedCfgs.find((c: any) => String(c?.id ?? '') === String(expectedActiveId ?? '')) || expectedCfgs[0];
            const actualActiveCfg = actualCfgs.find((c: any) => String(c?.id ?? '') === String(actualActiveId ?? '')) || actualCfgs[0];
            if (!expectedActiveCfg || !actualActiveCfg) return false;

            const expectedBlocks = Array.isArray(expectedActiveCfg.blocks) ? expectedActiveCfg.blocks.length : 0;
            const actualBlocks = Array.isArray(actualActiveCfg.blocks) ? actualActiveCfg.blocks.length : 0;
            if (expectedBlocks > 0 && actualBlocks === 0) return false;

            return true;
        } catch (_) {
            return false;
        }
    };

    // Save configurations to localStorage (with compact fallback) and verify persistence.
    let persistedConfigOk = false;
    try {
        saveSystemConfigurations(candidateConfig);
        persistedConfigOk = verifyPersistedConfig(candidateConfig);
        if (!persistedConfigOk) {
            clearTransientStoragePressureKeys();
            try { localStorage.removeItem('systemConfigurations'); } catch (_) {}
            const compactConfig = buildPersistableConfig(candidateConfig);
            saveSystemConfigurations(compactConfig);
            persistedConfigOk = verifyPersistedConfig(compactConfig);
        }
    } catch (e) {
        console.error('❌ Failed to save configurations:', e);
        persistedConfigOk = false;
    }
    if (!persistedConfigOk) {
        console.error('❌ [Load] Configuration persistence failed (possible storage quota or blocked storage).');
    }

    // During an explicit file load, prefer the in-memory configuration immediately.
    // This prevents any in-flight startup/default config reload from overwriting
    // the first manual load right after Clear Cache.
    try {
        (window as any).__cooptSystemConfig = candidateConfig;
        (window as any).__cooptPreferRuntimeSystemConfig = true;
    } catch (_) {}

    // Determine effective data for tables
    let effectiveSource = allData.source;
    let effectiveObject = allData.object;
    let effectiveOpticalSystem = allData.opticalSystem;
    let effectiveMeritFunction = allData.meritFunction;
    let effectiveSystemRequirements = allData.systemRequirements;

    const stripDerivedRequirementFieldsForLoad = (rows: any): any => {
        if (!Array.isArray(rows)) return rows;
        return rows.map((row: any) => {
            if (!row || typeof row !== 'object') return row;
            const next = { ...row };
            if (next.rowType === 'memo') return next;
            try { delete next.current; } catch (_) {}
            try { delete next.status; } catch (_) {}
            try { delete next._violation; } catch (_) {}
            try { delete next._contribution; } catch (_) {}
            try { delete next.score; } catch (_) {}
            return next;
        });
    };

    // If blocks exist, use expanded active configuration
    try {
        const activeId = candidateConfig?.activeConfigId || 1;
        const activeCfg = cfgList.find((c: any) => String(c?.id ?? '') === String(activeId)) || cfgList[0];
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

    effectiveSystemRequirements = stripDerivedRequirementFieldsForLoad(effectiveSystemRequirements);

    // Save to localStorage for table loading
    try {
        clearTableProjectionKeys();
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
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        if (!isStaleLoadSession()) {
            try {
                const tableSource = w.tableSource;
                if (tableSource && typeof tableSource.replaceData === 'function') {
                    await Promise.resolve(tableSource.replaceData(Array.isArray(effectiveSource) ? effectiveSource : []));
                } else if (tableSource && typeof tableSource.setData === 'function') {
                    await Promise.resolve(tableSource.setData(Array.isArray(effectiveSource) ? effectiveSource : []));
                }
            } catch (_) {}
            try {
                const tableObject = w.tableObject;
                if (tableObject && typeof tableObject.replaceData === 'function') {
                    await Promise.resolve(tableObject.replaceData(Array.isArray(effectiveObject) ? effectiveObject : []));
                } else if (tableObject && typeof tableObject.setData === 'function') {
                    await Promise.resolve(tableObject.setData(Array.isArray(effectiveObject) ? effectiveObject : []));
                }
            } catch (_) {}
            try {
                const tableOptical = w.tableOpticalSystem || w.opticalSystemTabulator;
                if (tableOptical && typeof tableOptical.replaceData === 'function') {
                    await Promise.resolve(tableOptical.replaceData(Array.isArray(effectiveOpticalSystem) ? effectiveOpticalSystem : []));
                } else if (tableOptical && typeof tableOptical.setData === 'function') {
                    await Promise.resolve(tableOptical.setData(Array.isArray(effectiveOpticalSystem) ? effectiveOpticalSystem : []));
                }
            } catch (_) {}
            try {
                const meritEditor = w.meritFunctionEditor;
                if (meritEditor && typeof meritEditor.setData === 'function') {
                    meritEditor.setData(Array.isArray(effectiveMeritFunction) ? effectiveMeritFunction : []);
                }
            } catch (_) {}
            try {
                const runRequirementSyncSequence = async () => {
                    const reqEditor = w.systemRequirementsEditor;
                    if (!reqEditor || isStaleLoadSession()) return;

                    if (typeof reqEditor.setData === 'function') {
                        reqEditor.setData(Array.isArray(effectiveSystemRequirements) ? effectiveSystemRequirements : []);
                    }

                    const evaluateNow = async (reason: string) => {
                        try {
                            if (typeof reqEditor.evaluateAndUpdateNow === 'function' && !isStaleLoadSession()) {
                                const p = reqEditor.evaluateAndUpdateNow({ reason, forceSilent: true, silent: true });
                                if (p && typeof p.then === 'function') {
                                    await p;
                                }
                            }
                        } catch (_) {}
                    };

                    await evaluateNow('load-file-seq-initial');

                    try {
                        if (!isStaleLoadSession()) {
                            window.dispatchEvent(new CustomEvent('coopt:requirements-updated'));
                        }
                    } catch (_) {}
                };

                scheduleDeferredLoadWork(() => {
                    void runRequirementSyncSequence();
                }, 180);
            } catch (_) {}

            if (!persistedConfigOk) {
                try {
                    (window as any).__cooptSystemConfig = candidateConfig;
                } catch (_) {}
                try {
                    if ((window as any).ConfigurationManager && typeof (window as any).ConfigurationManager.renderBlocksUI === 'function') {
                        (window as any).ConfigurationManager.renderBlocksUI();
                    }
                } catch (_) {}
                try { requestRefreshBlockInspector(); } catch (_) {}
            }
            scheduleDeferredLoadWork(() => {
                try { if (!isStaleLoadSession()) requestRefreshBlockInspector(); } catch (_) {}
            }, 90);
            try {
                if (typeof w.updateTransformSurfaceSelect === 'function') {
                    w.updateTransformSurfaceSelect();
                }
            } catch (_) {}

            const waitForConfigurationUI = () => {
                if (isStaleLoadSession()) return;
                const configListElement = document.getElementById('config-order-list');
                if (configListElement) {
                    if (typeof w.refreshConfigurationUI === 'function') {
                        w.refreshConfigurationUI();
                    } else if (typeof w.initializeConfigurationUI === 'function') {
                        w.initializeConfigurationUI();
                    }
                } else {
                    setTimeout(waitForConfigurationUI, 100);
                }
            };
            waitForConfigurationUI();

            try {
                if (persistedConfigOk) {
                    delete (window as any).__cooptPreferRuntimeSystemConfig;
                }
            } catch (_) {}
        }
    } catch (_) {}
    try {
        if (!isStaleLoadSession()) {
            delete (window as any).__cooptFileLoadInProgress;
        }
    } catch (_) {}

    if (!persistedConfigOk) {
        alert('Load completed partially: the file was applied to tables, but persistent storage failed.\n\nTry reducing file size or clearing old local data.');
    }

    return true;
}

// Expose loader for React toolbar handlers
if (typeof window !== 'undefined') {
    try {
        w.__loadAllDataObjectIntoApp = __loadAllDataObjectIntoApp;
        w.autoCalculateMissingSemidia = autoCalculateMissingSemidia;
        w.autoSetBlockAperturesFromLargestObjectCondition = autoSetBlockAperturesFromLargestObjectCondition;
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
                const ok = await __loadAllDataObjectIntoApp(parsed, { filename: file.name });
                if (!ok) {
                    throw new Error('Load step failed (invalid format or persistence failure).');
                }
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

function __coopt_shouldAcceptDerivedBlocks(blocks: any[], rows: any[]): boolean {
    if (!Array.isArray(blocks) || blocks.length === 0) return false;

    const physicalBlocks = blocks.filter((block: any) => {
        const blockType = String(block?.blockType ?? '').trim();
        return blockType !== 'ObjectSurface' && blockType !== 'ObjectPlane' && blockType !== 'ImageSurface';
    });

    if (physicalBlocks.length === 0) return false;

    const physicalRowCount = Math.max(0, (Array.isArray(rows) ? rows.length : 0) - 2);
    if (physicalRowCount >= 4 && physicalBlocks.length <= 1) return false;

    return true;
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
                const arrayBuffer = await file.arrayBuffer();
                const parsed: any = parseZMXArrayBufferToOpticalSystemRows(arrayBuffer);

                if (!parsed || typeof parsed !== 'object') {
                    throw new Error('Invalid Zemax parse result.');
                }
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
            let stopRequestedAtMs = 0;
            let lastProgressAtMs = 0;
            let lastActivityText = 'Idle';
            let scoreHistory: number[] = [];
            let lastIterForSparkline = -1;

            const formatElapsedLabel = (ms: number): string => {
                if (!Number.isFinite(ms) || ms <= 0) return '0s';
                if (ms < 1000) return `${Math.round(ms)}ms`;
                const seconds = ms / 1000;
                if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
                const minutes = Math.floor(seconds / 60);
                const remainSeconds = Math.round(seconds % 60);
                return `${minutes}m ${remainSeconds}s`;
            };

            const setPopupText = (id: string, value: string) => {
                try {
                    if (!popup || popup.closed) return;
                    const el = popup.document.getElementById(id);
                    if (el) el.textContent = value;
                } catch (_) {}
            };

            const getOptimizerGlassManufacturerLabel = (): string => {
                try {
                    const raw = JSON.parse(localStorage.getItem('coopt.glassMap.defaultManufacturers') || '[]');
                    if (!Array.isArray(raw) || raw.length === 0) return 'All manufacturers';
                    const allow = new Set(['SCHOTT', 'HOYA', 'HIKARI', 'OHARA', 'SUMITA', 'CDGM', 'SPECIAL']);
                    const normalized = raw
                        .map((value: any) => String(value ?? '').trim())
                        .filter(Boolean)
                        .filter((value: string) => allow.has(value.toUpperCase()));
                    return normalized.length > 0 ? normalized.join(', ') : 'All manufacturers';
                } catch (_) {
                    return 'All manufacturers';
                }
            };

            const describeOptimizerActivity = (p: any): string => {
                const phase = String(p?.phase ?? '').trim().toLowerCase();
                const iter = Number(p?.iter);
                const method = String(p?.method ?? '').trim().toUpperCase();
                const variableId = p?.variableId === undefined || p?.variableId === null
                    ? ''
                    : String(p.variableId);
                switch (phase) {
                    case 'prepare':
                        return 'Preparing active configuration';
                    case 'start':
                        return `Initializing ${method || 'optimizer'} state`;
                    case 'iter': {
                        const parts: string[] = [];
                        if (Number.isFinite(iter)) parts.push(`iter ${iter}`);
                        if (method) parts.push(method);
                        if (Number.isFinite(Number(p?.activeViolations))) {
                            parts.push(`active violations ${Math.max(0, Math.floor(Number(p.activeViolations)))}`);
                        }
                        return parts.length > 0 ? `Evaluating ${parts.join(' | ')}` : 'Evaluating current design';
                    }
                    case 'jacobian':
                        return Number.isFinite(iter)
                            ? `Building Jacobian at iter ${iter}`
                            : 'Building Jacobian';
                    case 'jacobian-col': {
                        const col = Number(p?.col);
                        const cols = Number(p?.cols);
                        if (Number.isFinite(col) && Number.isFinite(cols) && cols > 0) {
                            return `Building Jacobian column ${Math.floor(col)}/${Math.floor(cols)}`;
                        }
                        return 'Building Jacobian columns';
                    }
                    case 'solve':
                        return Number.isFinite(iter)
                            ? `Solving step direction at iter ${iter}`
                            : 'Solving step direction';
                    case 'candidate':
                        return variableId
                            ? `Testing candidate for ${variableId}`
                            : 'Testing candidate step';
                    case 'accept':
                        return variableId
                            ? `Accepted update for ${variableId}`
                            : 'Accepted candidate step';
                    case 'reject':
                        return variableId
                            ? `Rejected update for ${variableId}`
                            : 'Rejected candidate step';
                    case 'done':
                        return 'Optimization finished';
                    case 'stopped':
                        return 'Optimization stopped';
                    case 'error':
                        return 'Optimization failed';
                    default:
                        return phase ? `Working: ${phase}` : 'Waiting for progress update';
                }
            };

            const refreshPopupRuntimeStatus = () => {
                try {
                    if (!popup || popup.closed) return;
                    const now = Date.now();
                    const stopState = popup.document.getElementById('opt-stop-state');
                    const phaseText = String(popup.document.getElementById('opt-phase')?.textContent || '').trim().toLowerCase();
                    const terminalPhase = phaseText === 'done' || phaseText === 'stopped' || phaseText === 'error';

                    if (!terminalPhase) {
                        if (stopFlag.stop) {
                            if (stopState) stopState.textContent = 'Stopping...';
                            const waited = stopRequestedAtMs > 0 ? formatElapsedLabel(now - stopRequestedAtMs) : '0s';
                            setPopupText('opt-stop-detail', `Stop requested ${waited} ago. Waiting for a safe stop point.`);
                        } else {
                            if (stopState && isRunning) stopState.textContent = 'Running...';
                            setPopupText('opt-stop-detail', isRunning ? 'No stop requested.' : 'Idle');
                        }
                    }

                    if (lastProgressAtMs > 0) {
                        setPopupText('opt-last-update', `${formatElapsedLabel(now - lastProgressAtMs)} since last progress event`);
                    } else if (isRunning) {
                        setPopupText('opt-last-update', 'Waiting for first progress event');
                    } else {
                        setPopupText('opt-last-update', 'No updates yet');
                    }

                    setPopupText('opt-activity', lastActivityText || '-');

                    // Elapsed time counter
                    try {
                        if (runClickAtMs > 0 && isRunning) {
                            const elapsedEl = popup.document.getElementById('opt-elapsed') as HTMLElement | null;
                            if (elapsedEl) elapsedEl.textContent = formatElapsedLabel(now - runClickAtMs);
                        }
                    } catch (_) {}

                    // Pulse dot state
                    try {
                        const dot = popup.document.getElementById('opt-pulse-dot') as HTMLElement | null;
                        if (dot) {
                            if (terminalPhase) {
                                dot.className = phaseText === 'done' ? 'opt-pulse-dot done' : 'opt-pulse-dot error';
                            } else if (isRunning) {
                                dot.className = 'opt-pulse-dot running';
                            } else {
                                dot.className = 'opt-pulse-dot idle';
                            }
                        }
                    } catch (_) {}
                } catch (_) {}
            };

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
  <style>
    @keyframes __opt_pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.78)}}
    .opt-pulse-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#bbb;flex-shrink:0;vertical-align:middle;transition:background .4s}
    .opt-pulse-dot.running{background:#4f8cff;animation:__opt_pulse 1.35s ease-in-out infinite}
    .opt-pulse-dot.done{background:#22a854;animation:none}
    .opt-pulse-dot.error{background:#d33;animation:none}
    .opt-pulse-dot.idle{background:#bbb;animation:none}
    @keyframes __opt_fl_acc{0%{background:#c8f0d8}100%{background:transparent}}
    @keyframes __opt_fl_rej{0%{background:#f8d7da}100%{background:transparent}}
    .opt-flash-accept{animation:__opt_fl_acc .9s ease-out forwards}
    .opt-flash-reject{animation:__opt_fl_rej .9s ease-out forwards}
    #opt-iter-bar-fill{height:100%;background:linear-gradient(90deg,#4f8cff,#82b4ff);border-radius:999px;transition:width 500ms ease;width:0%}
  </style>
</head>
<body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 12px;">
<div style="display:flex; align-items:center; gap:8px; flex-wrap:nowrap; white-space:nowrap; margin-bottom:6px;">
    <div style="font-size:14px; font-weight:600; flex:0 0 auto;">Optimize Progress</div>
    <span class="opt-pulse-dot idle" id="opt-pulse-dot"></span>
    <span id="opt-elapsed" style="font-size:11px;color:#888;flex:0 0 auto;min-width:28px;font-variant-numeric:tabular-nums;"></span>
    <div id="opt-startup-progress-wrap" style="display:flex; align-items:center; gap:8px; flex:1 1 auto; min-width:0; margin:0;">
        <div style="height:6px; background:#eceef2; border-radius:999px; overflow:hidden; flex:1 1 auto; min-width:120px;">
            <div id="opt-startup-progress-bar" style="width:0%; height:100%; background:#4f8cff; transition:width 120ms linear;"></div>
        </div>
        <div id="opt-startup-progress-label" style="font-size:11px; color:#666; flex:0 0 auto;">Idle</div>
    </div>
</div>
<div style="height:4px;background:#eceef2;border-radius:999px;overflow:hidden;margin:0 0 4px;display:none" id="opt-iter-bar-wrap"><div id="opt-iter-bar-fill"></div></div>
<div id="opt-sparkline-wrap" style="background:#f7f8fa;border:1px solid #eceef2;border-radius:4px;overflow:hidden;height:54px;margin:0 0 6px;display:none"><canvas id="opt-sparkline" height="54" style="display:block;width:100%;height:54px"></canvas></div>
<div style="margin-bottom:8px; display:flex; align-items:center; gap:6px;">
    <button id="opt-run" style="padding:6px 10px;">Run</button>
    <button id="opt-stop" style="padding:6px 10px;" disabled>Stop</button>
    <span id="opt-stop-state" style="margin-left:8px; font-size:12px; color:#555;"></span>
</div>
<div style="margin:-2px 0 8px 0; font-size:11px; color:#888; line-height:1.5;">
    <div id="opt-stop-detail">Idle</div>
    <div id="opt-last-update">No updates yet</div>
</div>
<div style="margin-bottom:8px; display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
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
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Activity</span><span id="opt-activity" style="margin-left:8px;">Idle</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Decision</span><span id="opt-decision" style="margin-left:8px;">-</span></div>
    <div id="opt-decision-row" style="display:flex; align-items:baseline; border-radius:3px; padding:1px 3px 1px 0;"><span style="display:inline-block; width:110px; color:#555;">Accept/Reject</span><span id="opt-decision-count" style="margin-left:8px; font-variant-numeric:tabular-nums;">0 / 0</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Iter</span><span id="opt-iter" style="margin-left:8px;">0</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Vars</span><span id="opt-vars" style="margin-left:8px;">-</span></div>
    <div style="display:flex; align-items:baseline;"><span style="display:inline-block; width:110px; color:#555;">Glass Mfr</span><span id="opt-glass-mfr" style="margin-left:8px;">All manufacturers</span></div>
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
        <input id="opt-staged" type="checkbox" style="width:16px; height:16px;" />
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
                        const glassMfrEl = popup.document.getElementById('opt-glass-mfr');
                        if (glassMfrEl) {
                            glassMfrEl.textContent = getOptimizerGlassManufacturerLabel();
                        }
                    } catch (_) {}

                    try {
                        const stopBtn = popup.document.getElementById('opt-stop') as HTMLButtonElement | null;
                        const runBtn = popup.document.getElementById('opt-run') as HTMLButtonElement | null;
                        const stopState = popup.document.getElementById('opt-stop-state');
                        if (stopBtn) {
                            stopBtn.addEventListener('click', () => {
                                stopFlag.stop = true;
                                stopRequestedAtMs = Date.now();
                                lastActivityText = 'Stop requested from progress window';
                                try { (globalThis as any).__cooptLastUiStopReason = 'popup-stop-button'; } catch (_) {}
                                try {
                                    const _opt = w.OptimizationMVP;
                                    if (_opt && typeof _opt.stop === 'function') _opt.stop();
                                } catch (_) {}
                                try { if (stopBtn) stopBtn.disabled = true; } catch (_) {}
                                try { if (runBtn) runBtn.disabled = true; } catch (_) {}
                                if (stopState) stopState.textContent = 'Stopping...';
                                refreshPopupRuntimeStatus();
                            });
                        }
                        if (runBtn) {
                            runBtn.addEventListener('click', () => {
                                try {
                                    stopRequestedAtMs = 0;
                                    lastProgressAtMs = 0;
                                    lastActivityText = 'Run requested. Preparing optimizer...';
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
                                    setPopupText('opt-glass-mfr', getOptimizerGlassManufacturerLabel());
                                    if (runBtn) runBtn.disabled = true;
                                    if (stopBtn) stopBtn.disabled = false;
                                    refreshPopupRuntimeStatus();
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
                        } else {
                            refreshPopupRuntimeStatus();
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
            let bestRequirementScore = Number.POSITIVE_INFINITY;
            let acceptCount = 0;
            let rejectCount = 0;
            let currentConvergenceProfile = 'balanced';
            let __lastReqRefreshAt = 0;
            let __lastReqDeepRefreshAt = 0;
            const __reqRefreshThrottleMs = 250;
            const __reqDeepRefreshThrottleMs = 2500;
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

            const getRequirementScoreSnapshot = () => {
                try {
                    const sre = w.systemRequirementsEditor;
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

                    const isScoreRequirement = (row: any): boolean => {
                        if (!row || typeof row !== 'object') return false;
                        const enabled = (row.enabled === undefined || row.enabled === null) ? true : !!row.enabled;
                        const operand = String(row.operand ?? '').trim();
                        const weight = Number(row.weight ?? 1);
                        if (!enabled || !operand || !(Number.isFinite(weight) && weight > 0)) return false;
                        return true;
                    };

                    const scoreRows = Array.isArray(rows) ? rows.filter((r: any) => isScoreRequirement(r)) : [];
                    let score = Number.NaN;
                    if (scoreRows.length > 0) {
                        let s = 0;
                        let finiteCount = 0;
                        for (const row of scoreRows) {
                            const c = Number(row?._contribution);
                            if (Number.isFinite(c)) {
                                if (c > 0) s += c;
                                finiteCount += 1;
                            }
                        }
                        if (finiteCount > 0 && Number.isFinite(s)) score = s;
                    }
                    return {
                        score,
                        reqCount: scoreRows.length,
                    };
                } catch (_) {
                    return { score: Number.NaN, reqCount: Number.NaN };
                }
            };

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

                    const snap = getRequirementScoreSnapshot();
                    score = snap.score;
                    reqCount = snap.reqCount;
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

            let renderDebounceTimer: number | null = null;
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
                        const token = `${Date.now()}-ensure-render-popup`;
                        const rows = overrideRows
                            ?? (typeof w.getOpticalSystemRows === 'function' ? w.getOpticalSystemRows(w.tableOpticalSystem) : []);
                        const objectRows = typeof w.getObjectRows === 'function'
                            ? (w.getObjectRows(w.tableObject) || [])
                            : [];
                        const systemConfig = __cooptCloneSystemConfig();
                        const payload = {
                            ts: token,
                            token,
                            rows: Array.isArray(rows) ? rows : [],
                            objectRows: Array.isArray(objectRows) ? objectRows : [],
                            systemConfig,
                            senderId: getOrCreateCooptWindowSyncSenderId(),
                        };
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

                    // Debounce: cancel any pending draw timer and schedule a fresh one.
                    // This prevents render request pile-up when the optimizer accepts rapidly.
                    if (renderDebounceTimer !== null) clearTimeout(renderDebounceTimer);
                    renderDebounceTimer = window.setTimeout(() => {
                        renderDebounceTimer = null;
                        drawNow();
                    }, 120);
                } catch (_) {}
            };

            const updateProgressUI = (p: any) => {
                const phaseStr = String(p?.phase ?? '');
                lastProgressAtMs = Date.now();
                lastActivityText = describeOptimizerActivity(p);

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
                    try {
                        if (popup && !popup.closed) {
                            const autoRenderCheckbox = popup.document.getElementById('opt-auto-render') as HTMLInputElement | null;
                            if (autoRenderCheckbox && autoRenderCheckbox.checked) {
                                ensureRenderPopupAndDraw();
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
                            const dc = popup.document.getElementById('opt-decision-row') as HTMLElement | null;
                            if (dc) { dc.className = ''; void dc.offsetWidth; dc.className = 'opt-flash-accept'; }
                        }
                    } catch (_) {}
                } else if (phaseStr === 'reject') {
                    rejectCount++;
                    lastDecisionText = 'REJECT';
                    try {
                        if (popup && !popup.closed) {
                            const dc = popup.document.getElementById('opt-decision-row') as HTMLElement | null;
                            if (dc) { dc.className = ''; void dc.offsetWidth; dc.className = 'opt-flash-reject'; }
                        }
                    } catch (_) {}
                }

                try {
                    const now = Date.now();
                    if ((now - __lastReqRefreshAt) >= __reqRefreshThrottleMs) {
                        if (phaseStr === 'start' || phaseStr === 'iter' || phaseStr === 'candidate' || phaseStr === 'accept' || phaseStr === 'reject') {
                            const sre = w.systemRequirementsEditor;
                            const payloadReqSnapshot = Array.isArray(p?.requirementSnapshots) ? p.requirementSnapshots : null;
                            const dbg = (w.__cooptLastOptimizerResidualDebug && typeof w.__cooptLastOptimizerResidualDebug === 'object')
                                ? w.__cooptLastOptimizerResidualDebug
                                : null;
                            const reqSnapshot = (payloadReqSnapshot && payloadReqSnapshot.length > 0)
                                ? payloadReqSnapshot
                                : (Array.isArray(dbg?.requirementsSnapshot) ? dbg.requirementsSnapshot : null);
                            let appliedSnapshot = false;
                            if (sre && typeof sre.applyOptimizerRequirementSnapshot === 'function' && reqSnapshot && reqSnapshot.length > 0) {
                                __lastReqRefreshAt = now;
                                appliedSnapshot = !!sre.applyOptimizerRequirementSnapshot(reqSnapshot);
                            }
                            if ((!appliedSnapshot) && sre && typeof sre.scheduleEvaluateAndUpdate === 'function' && (now - __lastReqDeepRefreshAt) >= __reqDeepRefreshThrottleMs) {
                                __lastReqRefreshAt = now;
                                __lastReqDeepRefreshAt = now;
                                sre.scheduleEvaluateAndUpdate();
                            }
                        }
                    }
                } catch (_) {}

                const cur = Number(p?.current);
                const progressViolationScore = Number(p?.violationScore);
                const snap = getRequirementScoreSnapshot();
                const tableRequirementScore = Number(snap.score);
                const displayCurrentScore = Number.isFinite(tableRequirementScore)
                    ? tableRequirementScore
                    : (Number.isFinite(cur) ? cur : Number.NaN);
                if (Number.isFinite(displayCurrentScore)) {
                    bestRequirementScore = Number.isFinite(bestRequirementScore)
                        ? Math.min(bestRequirementScore, displayCurrentScore)
                        : displayCurrentScore;
                } else if (!Number.isFinite(bestRequirementScore) && Number.isFinite(tableRequirementScore)) {
                    bestRequirementScore = tableRequirementScore;
                }
                const displayBestScore = Number.isFinite(bestRequirementScore)
                    ? bestRequirementScore
                    : Number.NaN;
                if (totalMeritEl && Number.isFinite(displayCurrentScore)) {
                    totalMeritEl.textContent = displayCurrentScore.toFixed(6);
                }

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
                if (Number.isFinite(Number(snap.reqCount))) {
                    lastReqText = String(Math.max(0, Math.floor(Number(snap.reqCount))));
                }
                if (p?.residualCount !== undefined) {
                    lastResText = String(p.residualCount);
                }
                if (p && ('rho' in p)) {
                    const r = Number(p.rho);
                    lastRhoText = Number.isFinite(r) ? r.toFixed(6) : '-';
                }
                if (Number.isFinite(tableRequirementScore)) {
                    lastVioText = tableRequirementScore.toFixed(6);
                }
                if (p && ('softPenalty' in p)) {
                    const s = Number(p.softPenalty);
                    lastSoftText = Number.isFinite(s) ? s.toFixed(6) : '-';
                }

                // Sparkline + iter progress bar
                try {
                    const iterNum = Number(p?.iter);
                    if (Number.isFinite(displayCurrentScore) && Number.isFinite(iterNum) && iterNum > lastIterForSparkline) {
                        lastIterForSparkline = iterNum;
                        scoreHistory.push(displayCurrentScore);
                        if (scoreHistory.length > 400) scoreHistory.splice(0, scoreHistory.length - 400);
                    }
                    if (popup && !popup.closed) {
                        // Iteration progress bar
                        const iterBarWrap = popup.document.getElementById('opt-iter-bar-wrap') as HTMLElement | null;
                        const iterBarFill = popup.document.getElementById('opt-iter-bar-fill') as HTMLElement | null;
                        const maxIterInput = popup.document.getElementById('opt-max-iter') as HTMLInputElement | null;
                        const maxIter = maxIterInput ? Number(maxIterInput.value) : 0;
                        if (iterBarWrap && iterBarFill && Number.isFinite(iterNum) && Number.isFinite(maxIter) && maxIter > 0) {
                            iterBarWrap.style.display = 'block';
                            const pct = Math.max(0, Math.min(99.5, (iterNum / maxIter) * 100));
                            iterBarFill.style.width = `${pct}%`;
                        }
                        // Sparkline
                        if (scoreHistory.length >= 2) {
                            const sparkWrap = popup.document.getElementById('opt-sparkline-wrap') as HTMLElement | null;
                            const canvas = popup.document.getElementById('opt-sparkline') as HTMLCanvasElement | null;
                            if (sparkWrap && canvas) {
                                sparkWrap.style.display = 'block';
                                const ctx = canvas.getContext('2d');
                                if (ctx) {
                                    const cw = canvas.offsetWidth || 460;
                                    canvas.width = cw;
                                    const ch = canvas.height;
                                    ctx.clearRect(0, 0, cw, ch);
                                    const scores = scoreHistory;
                                    const minS = Math.min(...scores);
                                    const maxS = Math.max(...scores);
                                    const rng = maxS - minS;
                                    const toY = (v: number) => rng > 1e-15 ? ch - 4 - ((v - minS) / rng) * (ch - 10) : ch / 2;
                                    const toX = (i: number) => scores.length < 2 ? cw / 2 : (i / (scores.length - 1)) * (cw - 6) + 3;
                                    // Shaded area
                                    ctx.beginPath();
                                    ctx.moveTo(toX(0), ch);
                                    for (let i = 0; i < scores.length; i++) ctx.lineTo(toX(i), toY(scores[i]));
                                    ctx.lineTo(toX(scores.length - 1), ch);
                                    ctx.closePath();
                                    ctx.fillStyle = 'rgba(79,140,255,0.10)';
                                    ctx.fill();
                                    // Line
                                    ctx.beginPath();
                                    ctx.strokeStyle = '#4f8cff';
                                    ctx.lineWidth = 1.5;
                                    for (let i = 0; i < scores.length; i++) {
                                        if (i === 0) ctx.moveTo(toX(i), toY(scores[i]));
                                        else ctx.lineTo(toX(i), toY(scores[i]));
                                    }
                                    ctx.stroke();
                                    // Current point marker
                                    ctx.beginPath();
                                    ctx.arc(toX(scores.length - 1), toY(scores[scores.length - 1]), 3, 0, Math.PI * 2);
                                    ctx.fillStyle = phaseStr === 'accept' ? '#1a7a3d' : (phaseStr === 'reject' ? '#c33' : '#4f8cff');
                                    ctx.fill();
                                    // Scale labels
                                    ctx.fillStyle = 'rgba(100,100,100,0.7)';
                                    ctx.font = '9px system-ui, sans-serif';
                                    ctx.fillText(maxS.toExponential(2), 3, 9);
                                    ctx.fillText(minS.toExponential(2), 3, ch - 2);
                                }
                            }
                        }
                    }
                } catch (_) {}

                if (popup && !popup.closed) {
                    try {
                        const doc = popup.document;
                        const setText = (id: string, v: string) => {
                            const el = doc.getElementById(id);
                            if (el) el.textContent = v;
                        };
                        setText('opt-phase', String(p?.phase ?? '-'));
                        setText('opt-activity', lastActivityText);
                        setText('opt-decision', lastDecisionText);
                        setText('opt-decision-count', `${acceptCount} / ${rejectCount}`);
                        setText('opt-iter', String(p?.iter ?? '-'));
                        setText('opt-glass-mfr', getOptimizerGlassManufacturerLabel());
                        setText('opt-req', lastReqText);
                        setText('opt-res', lastResText);
                        setText('opt-cur', Number.isFinite(displayCurrentScore) ? displayCurrentScore.toFixed(6) : '-');
                        setText('opt-vio', lastVioText);
                        setText('opt-soft', lastSoftText);
                        setText('opt-best', Number.isFinite(displayBestScore) ? displayBestScore.toFixed(6) : '-');
                        setText('opt-rho', lastRhoText);
                        setText('opt-issue', lastIssueText);

                        if (String(p?.phase) === 'stopped') {
                            setText('opt-stop-state', 'Stopped');
                            setText('opt-stop-detail', stopRequestedAtMs > 0
                                ? `Stop acknowledged after ${formatElapsedLabel(Date.now() - stopRequestedAtMs)}.`
                                : 'Stopped by request.');
                            try {
                                const btn = doc.getElementById('opt-stop') as HTMLButtonElement | null;
                                if (btn) btn.disabled = true;
                                const runBtn = doc.getElementById('opt-run') as HTMLButtonElement | null;
                                if (runBtn) runBtn.disabled = false;
                            } catch (_) {}
                        } else if (String(p?.phase) === 'done') {
                            setText('opt-stop-state', 'Done');
                            setText('opt-stop-detail', stopRequestedAtMs > 0
                                ? `Stop request completed after ${formatElapsedLabel(Date.now() - stopRequestedAtMs)}.`
                                : 'Run completed normally.');
                            try {
                                const btn = doc.getElementById('opt-stop') as HTMLButtonElement | null;
                                if (btn) btn.disabled = true;
                                const runBtn = doc.getElementById('opt-run') as HTMLButtonElement | null;
                                if (runBtn) runBtn.disabled = false;
                            } catch (_) {}
                        } else if (String(p?.phase) === 'error') {
                            setText('opt-stop-state', 'Error');
                            setText('opt-stop-detail', 'Stopped because the optimizer reported an error.');
                            try {
                                const btn = doc.getElementById('opt-stop') as HTMLButtonElement | null;
                                if (btn) btn.disabled = true;
                                const runBtn = doc.getElementById('opt-run') as HTMLButtonElement | null;
                                if (runBtn) runBtn.disabled = false;
                            } catch (_) {}
                        } else if (stopFlag.stop) {
                            setText('opt-stop-state', 'Stopping...');
                            setText('opt-stop-detail', `Stop requested ${formatElapsedLabel(Date.now() - stopRequestedAtMs)} ago. Current task: ${lastActivityText}`);
                        } else {
                            setText('opt-stop-detail', 'No stop requested.');
                        }

                        setText('opt-last-update', 'just now');
                    } catch (_) {}
                }

                if (phaseStr === 'done' || phaseStr === 'stopped') {
                    void (async () => {
                        try {
                            const sre = w.systemRequirementsEditor;
                            const shouldAwaitFinalSync = !(phaseStr === 'stopped' || stopFlag.stop);
                            if (sre && typeof sre.evaluateAndUpdateNow === 'function') {
                                const r = sre.evaluateAndUpdateNow({ reason: 'optimize-progress-final-sync' });
                                if (shouldAwaitFinalSync && r && typeof (r as any).then === 'function') {
                                    await r;
                                }
                            }
                            const finalSnap = getRequirementScoreSnapshot();
                            const finalScore = Number(finalSnap.score);
                            if (!popup || popup.closed) return;
                            const doc = popup.document;
                            const setText = (id: string, v: string) => {
                                const el = doc.getElementById(id);
                                if (el) el.textContent = v;
                            };
                            if (Number.isFinite(finalScore)) {
                                bestRequirementScore = Number.isFinite(bestRequirementScore)
                                    ? Math.min(bestRequirementScore, finalScore)
                                    : finalScore;
                                setText('opt-cur', finalScore.toFixed(6));
                                setText('opt-best', bestRequirementScore.toFixed(6));
                                setText('opt-vio', finalScore.toFixed(6));
                            }
                            if (Number.isFinite(Number(finalSnap.reqCount))) {
                                setText('opt-req', String(Math.max(0, Math.floor(Number(finalSnap.reqCount)))));
                            }
                        } catch (_) {}
                    })();
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
                    stopRequestedAtMs = 0;
                    lastProgressAtMs = 0;
                    try { (globalThis as any).__cooptLastUiStopReason = null; } catch (_) {}
                    acceptCount = 0;
                    rejectCount = 0;
                    bestRequirementScore = Number.POSITIVE_INFINITY;
                    lastIssueText = '-';
                    scoreHistory = [];
                    lastIterForSparkline = -1;
                    lastReqText = '-';
                    lastResText = '-';
                    lastRhoText = '-';
                    lastVioText = '-';
                    lastSoftText = '-';
                    lastDecisionText = '-';
                    lastActivityText = 'Loading active configuration';
                    setPreRunProgress('prepare', 'Loading active configuration...');
                    refreshPopupRuntimeStatus();

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
                            setPopupText('opt-stop-detail', 'No stop requested.');
                            setPopupText('opt-last-update', 'Waiting for first progress event');
                            if (phaseEl) phaseEl.textContent = 'starting';
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
                            staged: readBool('opt-staged', false),
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
                            preferNative: isTauriRuntime(),
                            stageMaxCoef: [10],
                            ...optParams,
                            onProgress: updateProgressUI,
                            shouldStop: shouldStopNow
                        });
                        // Restore flags after successful completion.
                        // Keep the autosave guard active until post-run state capture finishes.
                        try {
                            if (__prevDisableRayTraceDebug !== undefined) _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG = __prevDisableRayTraceDebug;
                            else {
                                try { delete _gThis.__COOPT_DISABLE_RAYTRACE_DEBUG; } catch (_) {}
                            }
                        } catch (_) {}

                        try {
                            _gThis.__cooptLastOptimizationSyncAt = Date.now();
                            _gThis.__cooptOptimizerIsRunning = false;
                        } catch (_) {}

                        // Clean up render state to prevent UI slowdown on subsequent operations
                        try {
                            // Clear any pending render debounce timer
                            if (renderDebounceTimer !== null) {
                                clearTimeout(renderDebounceTimer);
                                renderDebounceTimer = null;
                            }
                        } catch (_) {}

                        try {
                            // Reset draw-cross pending data and in-flight flag
                            w.__cooptDrawCrossLastData = null;
                            w.__cooptDrawCrossInFlight = false;
                        } catch (_) {}

                        try {
                            // Reset stop flag for next optimization run
                            stopFlag.stop = false;
                            stopRequestedAtMs = 0;
                        } catch (_) {}

                        try {
                            // Clear native optimizer stop state (Tauri only)
                            if (typeof clearOptimizerStop === 'function') {
                                await clearOptimizerStop();
                            }
                        } catch (_) {}

                        // Record optimization as a single undo operation
                        try {
                            if (beforeOptimizationState && w.undoHistory && result?.ok) {
                                const sys = loadSystemConfigurations();
                                const afterOptimizationState = sys ? JSON.parse(JSON.stringify(sys)) : null;
                                if (JSON.stringify(beforeOptimizationState) !== JSON.stringify(afterOptimizationState)) {
                                    const applyOptimizationSnapshot = async (snapshot: any) => {
                                        if (!snapshot) return;
                                        try {
                                            delete w.__cooptBlocksOverride;
                                        } catch (_) {}
                                        try {
                                            delete w.__cooptScenarioOverride;
                                        } catch (_) {}
                                        try {
                                            delete w.__cooptOpticalSystemByConfigId;
                                        } catch (_) {}
                                        try {
                                            delete w.__cooptSystemConfig;
                                        } catch (_) {}
                                        try {
                                            delete (globalThis as any).__cooptOpticalSystemRowsOverride;
                                        } catch (_) {}

                                        saveSystemConfigurations(snapshot);

                                        try {
                                            if (w.ConfigurationManager && typeof w.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
                                                await w.ConfigurationManager.loadActiveConfigurationToTables({ applyToUI: true });
                                            }
                                        } catch (_) {}
                                        try {
                                            requestRefreshBlockInspector(w);
                                        } catch (_) {}
                                        try {
                                            if (typeof w.refreshAllUI === 'function') {
                                                w.refreshAllUI();
                                            }
                                        } catch (_) {}
                                        try {
                                            if (w.systemRequirementsEditor && typeof w.systemRequirementsEditor.evaluateAndUpdateNow === 'function') {
                                                await w.systemRequirementsEditor.evaluateAndUpdateNow({ reason: 'optimization-undo-redo' });
                                            }
                                        } catch (_) {}
                                        try {
                                            if (w.meritFunctionEditor && typeof w.meritFunctionEditor.calculateMerit === 'function') {
                                                w.meritFunctionEditor.calculateMerit();
                                            }
                                        } catch (_) {}
                                    };
                                    const command = {
                                        timestamp: Date.now(),
                                        __cooptOptimizationCommand: true,
                                        description: 'Optimization',
                                        name: 'Optimization',
                                        execute: async () => {
                                            await applyOptimizationSnapshot(afterOptimizationState);
                                        },
                                        undo: async () => {
                                            await applyOptimizationSnapshot(beforeOptimizationState);
                                        },
                                        redo: function() { return this.execute(); }
                                    };
                                    if (w.undoHistory) {
                                        w.undoHistory.isExecuting = false;
                                    }
                                    w.undoHistory.record(command);
                                    try {
                                        (globalThis as any).__cooptLastOptimizationUndoRecordAt = Number(command.timestamp) || Date.now();
                                    } catch (_) {}
                                    try {
                                        (globalThis as any).__cooptUndoRecordSuppressedUntil = Date.now() + 1500;
                                    } catch (_) {}
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
                        try {
                            if (typeof _gThis.__cooptLastOptimizationSyncAt !== 'number') {
                                _gThis.__cooptLastOptimizationSyncAt = Date.now();
                            }
                            _gThis.__cooptOptimizerIsRunning = false;
                        } catch (_) {
                        try {
                            if (w.undoHistory && w.undoHistory.isExecuting === true) {
                                w.undoHistory.isExecuting = false;
                            }
                        } catch (_) {}
                            _gThis.__cooptOptimizerIsRunning = false;
                        }
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
                                if (stopFlag.stop) {
                                    setPopupText('opt-stop-detail', stopRequestedAtMs > 0
                                        ? `Stop completed after ${formatElapsedLabel(Date.now() - stopRequestedAtMs)}.`
                                        : 'Stopped by request.');
                                }
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
            try { optimizeBtn.disabled = prevDisabled; } catch (_) {}
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
                        parameters: { objectDistanceMode: 'INF', objectDistance: 10 },
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
            const serialized = JSON.stringify(allData, null, 2);

            if (isTauriRuntime()) {
                const savedPath = await saveJsonFromNativeDialog(serialized);
                if (!savedPath) return;
                const filename = basenameFromPath(savedPath);
                try {
                    const { setLoadedFileName } = await import('./loaded-file-storage.ts');
                    setLoadedFileName(filename);
                } catch (_) {}
                try {
                    window.dispatchEvent(new CustomEvent('coopt:loaded-file-updated'));
                } catch (_) {}
                console.log('✅ データが保存されました:', savedPath);
                return;
            }

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

            const blob = new Blob([serialized], { type: 'application/json' });
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
    const liveSource = w.tableSource ? w.tableSource.getData() : [];
    const liveObject = w.tableObject ? w.tableObject.getData() : [];
    const liveOpticalSystem = w.tableOpticalSystem ? w.tableOpticalSystem.getData() : [];
    const liveMeritFunction = w.meritFunctionEditor ? w.meritFunctionEditor.getData() : [];
    const liveSystemRequirements = w.systemRequirementsEditor ? w.systemRequirementsEditor.getData() : [];
    const refFLInput = document.getElementById('reference-focal-length') as HTMLInputElement | null;
    
    const sanitizedConfig = parsedConfig ? JSON.parse(JSON.stringify(parsedConfig)) : null;
    if (sanitizedConfig) {
        try {
            const activeId = sanitizedConfig.activeConfigId;
            const activeCfg = Array.isArray(sanitizedConfig.configurations)
                ? (sanitizedConfig.configurations.find((cfg: any) => String(cfg?.id) === String(activeId)) || sanitizedConfig.configurations[0])
                : null;
            if (activeCfg && typeof activeCfg === 'object') {
                activeCfg.source = liveSource;
                activeCfg.object = liveObject;
                activeCfg.opticalSystem = liveOpticalSystem;
                activeCfg.systemData = {
                    ...(activeCfg.systemData && typeof activeCfg.systemData === 'object' ? activeCfg.systemData : {}),
                    referenceFocalLength: refFLInput ? refFLInput.value : ''
                };
                if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
                activeCfg.metadata.modified = new Date().toISOString();
            }
            sanitizedConfig.meritFunction = liveMeritFunction;
            sanitizedConfig.systemRequirements = liveSystemRequirements;
        } catch (_) {}
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
    let activeSystemData: any = null;
    
    try {
        const systemConfig = (typeof w.loadSystemConfigurations === 'function') 
            ? w.loadSystemConfigurations() 
            : null;
        const activeId = systemConfig?.activeConfigId;
        const activeCfg = Array.isArray(systemConfig?.configurations)
            ? (systemConfig.configurations.find((c: any) => String(c?.id) === String(activeId)) || systemConfig.configurations[0])
            : null;
        activeSystemData = (activeCfg && typeof activeCfg === 'object' && activeCfg.systemData && typeof activeCfg.systemData === 'object')
            ? activeCfg.systemData
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
            ...(activeSystemData && typeof activeSystemData === 'object' ? activeSystemData : {}),
            referenceFocalLength: referenceFocalLength
        },
        configurations: getSanitizedConfigurationsForExport()
    };
}

function __compactSharePayloadValue(value: any): any {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
        const compacted = value
            .map((item) => __compactSharePayloadValue(item))
            .filter((item) => item !== undefined);
        return compacted.length > 0 ? compacted : undefined;
    }
    if (typeof value !== 'object') {
        return value;
    }

    const compacted: any = {};
    for (const [key, raw] of Object.entries(value)) {
        if (key === 'modified') continue;
        if (key === 'referenceFocalLength' && String(raw ?? '').trim() === '') continue;
        const next = __compactSharePayloadValue(raw);
        if (next !== undefined) {
            compacted[key] = next;
        }
    }
    return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function buildAllDataForShareExport(): any {
    const configurations = getSanitizedConfigurationsForExport();
    if (!configurations || !Array.isArray(configurations.configurations)) {
        return buildAllDataForExport();
    }

    const shareConfigurations = JSON.parse(JSON.stringify(configurations));
    try {
        if (Array.isArray(shareConfigurations.configurations)) {
            for (const cfg of shareConfigurations.configurations) {
                if (!cfg || typeof cfg !== 'object') continue;
                if (Array.isArray(cfg.blocks) && cfg.blocks.length > 0) {
                    delete cfg.opticalSystem;
                }
                if (cfg.metadata && typeof cfg.metadata === 'object') {
                    delete cfg.metadata.modified;
                    if (Object.keys(cfg.metadata).length === 0) delete cfg.metadata;
                }
                if (cfg.systemData && typeof cfg.systemData === 'object') {
                    const refFL = String(cfg.systemData.referenceFocalLength ?? '').trim();
                    if (!refFL) delete cfg.systemData.referenceFocalLength;
                    if (Object.keys(cfg.systemData).length === 0) delete cfg.systemData;
                }
            }
        }
    } catch (_) {}

    return __compactSharePayloadValue({
        configurations: shareConfigurations,
        meritFunction: w.meritFunctionEditor ? w.meritFunctionEditor.getData() : [],
        systemRequirements: w.systemRequirementsEditor ? w.systemRequirementsEditor.getData() : []
    }) ?? { configurations: shareConfigurations };
}

// Setup Load Default System Button
function setupLoadDefaultButton(): void {
    const btn = document.getElementById('load-default-btn');
    if (!btn) return;
    if (isReactManagedButton(btn as HTMLElement)) return;

    const defaultHandler = async () => {
        if (!confirm('Load default optical system? Current data will be replaced.')) return;
        
        try {
            const data = await loadBrowserDefaultProjectJson();
            
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
function showShareUrlLengthOnButton(urlLength: number): void {
    const btn = document.getElementById('share-url-btn') as HTMLButtonElement | null;
    if (!btn) return;

    const nextLabel = `Share URL (${urlLength} chars)`;
    const restoreMs = 8000;
    const previousTimer = Number((btn as any).__cooptShareUrlLabelTimer);
    if (Number.isFinite(previousTimer) && previousTimer > 0) {
        window.clearTimeout(previousTimer);
    }

    if (!(btn as any).__cooptShareUrlLabelOriginal) {
        (btn as any).__cooptShareUrlLabelOriginal = btn.textContent || 'Share URL';
    }

    btn.textContent = nextLabel;
    btn.title = nextLabel;

    const restoreLabel = String((btn as any).__cooptShareUrlLabelOriginal || 'Share URL');
    (btn as any).__cooptShareUrlLabelTimer = window.setTimeout(() => {
        btn.textContent = restoreLabel;
        btn.title = restoreLabel;
        (btn as any).__cooptShareUrlLabelTimer = 0;
    }, restoreMs);
}

function showShareUrlLengthBanner(urlLength: number): void {
    const bannerId = 'coopt-share-url-banner';
    let banner = document.getElementById(bannerId) as HTMLDivElement | null;
    if (!banner) {
        banner = document.createElement('div');
        banner.id = bannerId;
        banner.style.position = 'fixed';
        banner.style.top = '14px';
        banner.style.right = '14px';
        banner.style.zIndex = '2147483647';
        banner.style.padding = '10px 14px';
        banner.style.borderRadius = '10px';
        banner.style.border = '1px solid rgba(15, 23, 42, 0.14)';
        banner.style.background = 'rgba(15, 23, 42, 0.94)';
        banner.style.color = '#f8fafc';
        banner.style.fontSize = '12px';
        banner.style.fontWeight = '600';
        banner.style.letterSpacing = '0.01em';
        banner.style.boxShadow = '0 12px 30px rgba(15, 23, 42, 0.28)';
        banner.style.opacity = '0';
        banner.style.transform = 'translateY(-6px)';
        banner.style.transition = 'opacity 140ms ease, transform 140ms ease';
        banner.style.pointerEvents = 'none';
        document.body.appendChild(banner);
    }

    const message = `Share URL length: ${urlLength} chars`;
    banner.textContent = message;
    banner.title = message;
    banner.style.opacity = '1';
    banner.style.transform = 'translateY(0)';

    const previousTimer = Number((banner as any).__cooptHideTimer);
    if (Number.isFinite(previousTimer) && previousTimer > 0) {
        window.clearTimeout(previousTimer);
    }

    (banner as any).__cooptHideTimer = window.setTimeout(() => {
        banner!.style.opacity = '0';
        banner!.style.transform = 'translateY(-6px)';
        (banner as any).__cooptHideTimer = 0;
    }, 5000);
}

function announceShareUrlLength(urlLength: number): void {
    try {
        const loadedFileName = document.getElementById('loaded-file-name') as HTMLSpanElement | null;
        if (loadedFileName) {
            loadedFileName.textContent = `Share URL: ${urlLength} chars`;
            loadedFileName.style.color = '#0f766e';
        }
    } catch (_) {}

    try {
        window.dispatchEvent(new CustomEvent('coopt:share-url-generated', {
            detail: { urlLength }
        }));
    } catch (_) {}
}

function setupShareUrlButton(): void {
    const btn = document.getElementById('share-url-btn');
    if (!btn) return;
    if (isReactManagedButton(btn as HTMLElement)) return;

    const WARN_LEN = 2000;

    const shareHandler = async () => {
        try {
            if (document.activeElement) (document.activeElement as HTMLElement).blur();

            let compressed: string;
            try {
                const allData = buildAllDataForShareExport();
                compressed = await encodeAllDataToCompressedString(allData);
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
            announceShareUrlLength(len);
            showShareUrlLengthOnButton(len);
            showShareUrlLengthBanner(len);
            if (len >= WARN_LEN) {
                const ok = confirm(`Share URL is long (${len} chars) and may not work in some apps.\n\nContinue?`);
                if (!ok) return;
            }

            // Show the length synchronously in a modal before any async clipboard call.
            prompt(`Share URL (${len} chars):`, url);

            try {
                await navigator.clipboard.writeText(url);
            } catch (e) {
                // Fallback: let user copy manually
                prompt(`Copy this URL (${len} chars):`, url);
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
    if ((btn as any).dataset?.cooptBoundParaxial === '1') return;
    (btn as any).dataset.cooptBoundParaxial = '1';
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
                objectDistanceMode: 'INF',
                objectDistance: 10
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
        try {
            window.dispatchEvent(new CustomEvent('coopt:system-configurations-updated'));
        } catch (_) {}
    } catch (e) {
        console.warn('⚠️ [Configuration] Save failed:', e);
    }
}

function configIdsEqual(left: any, right: any): boolean {
    return String(left ?? '') === String(right ?? '');
}

export function getActiveConfiguration(): any {
    const systemConfig = loadSystemConfigurations();
    const activeConfig = systemConfig.configurations.find((c: any) => configIdsEqual(c?.id, systemConfig.activeConfigId));
    
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
    const config = systemConfig.configurations.find((c: any) => configIdsEqual(c?.id, configId));
    
    if (!config) {
        console.error('❌ [Configuration] Config not found:', configId);
        return false;
    }
    
    systemConfig.activeConfigId = configId;
    saveSystemConfigurations(systemConfig);
    return true;
}

export function saveCurrentToActiveConfiguration(): void {
    const systemConfig = loadSystemConfigurations();
    const activeConfig = systemConfig.configurations.find((c: any) => configIdsEqual(c?.id, systemConfig.activeConfigId));
    
    if (!activeConfig) {
        console.error('❌ [Configuration] Active config not found');
        return;
    }
    
    try {
        const globalSource = w.tableSource ? w.tableSource.getData() : [];
        saveSourceTableData(globalSource as any);
    } catch (_) {}
    
    // Keep existing object rows if this window does not host Object table.
    if (w.tableObject && typeof w.tableObject.getData === 'function') {
        activeConfig.object = w.tableObject.getData();
    }
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
}

export function loadActiveConfigurationToTables(): void {
    const activeConfig = getActiveConfiguration();
    const systemConfig = loadSystemConfigurations();
    
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
    saveSystemRequirementsTableData(
        Array.isArray(systemConfig?.systemRequirements) ? systemConfig.systemRequirements as any : []
    );
    
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
    return newId;
}

export function deleteConfiguration(configId: number): boolean {
    const systemConfig = loadSystemConfigurations();
    
    if (systemConfig.configurations.length <= 1) {
        console.warn('⚠️ [Configuration] Cannot delete last configuration');
        return false;
    }
    
    const index = systemConfig.configurations.findIndex((c: any) => configIdsEqual(c?.id, configId));
    
    if (index === -1) {
        console.error('❌ [Configuration] Config not found:', configId);
        return false;
    }
    
    const configName = systemConfig.configurations[index].name;
    systemConfig.configurations.splice(index, 1);
    
    if (configIdsEqual(systemConfig.activeConfigId, configId)) {
        systemConfig.activeConfigId = systemConfig.configurations[0].id;
    }
    
    saveSystemConfigurations(systemConfig);
    return true;
}

export function duplicateConfiguration(configId: number): number | null {
    const systemConfig = loadSystemConfigurations();
    const sourceConfig = systemConfig.configurations.find((c: any) => configIdsEqual(c?.id, configId));
    
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
    return newId;
}

export function renameConfiguration(configId: number, newName: string): boolean {
    const systemConfig = loadSystemConfigurations();
    const config = systemConfig.configurations.find((c: any) => configIdsEqual(c?.id, configId));
    
    if (!config) {
        console.error('❌ [Configuration] Config not found:', configId);
        return false;
    }
    
    const oldName = config.name;
    config.name = newName;
    config.metadata.modified = new Date().toISOString();
    
    saveSystemConfigurations(systemConfig);
    return true;
}

export function getConfigurationList(): any[] {
    const systemConfig = loadSystemConfigurations();
    return systemConfig.configurations.map((c: any) => ({
        id: c.id,
        name: c.name,
        active: configIdsEqual(c?.id, systemConfig.activeConfigId),
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
let __blocks_draggedBlockId: string | null = null;
let __cooptBlockInspectorLastSummary: any[] | null = null;
let __cooptBlockInspectorLastGroups: any = null;
let __cooptBlockInspectorLastBlockById: Map<string, any> | null = null;
let __cooptBlockInspectorLastBlocksInOrder: any[] | null = null;
const DESIGN_INTENT_QUICK_EDITOR_STORAGE_KEY = 'coopt.blockInspectorQuickEditorEnabled';
let __designIntentQuickEditorDelegatedBindingInstalled = false;

function readDesignIntentQuickEditorEnabled(): boolean {
    try {
        const stored = localStorage.getItem(DESIGN_INTENT_QUICK_EDITOR_STORAGE_KEY);
        if (stored === '0' || stored === 'false') return false;
        if (stored === '1' || stored === 'true') return true;
    } catch (_) {}
    return true;
}

function writeDesignIntentQuickEditorEnabled(enabled: boolean): void {
    try {
        localStorage.setItem(DESIGN_INTENT_QUICK_EDITOR_STORAGE_KEY, enabled ? '1' : '0');
    } catch (_) {}
}

function syncDesignIntentQuickEditorToggle(): void {
    const toggle = document.getElementById('design-intent-quick-editor-toggle') as HTMLInputElement | null;
    if (toggle) toggle.checked = readDesignIntentQuickEditorEnabled();
}

function rerenderBlockInspectorFromCache(): boolean {
    if (!Array.isArray(__cooptBlockInspectorLastSummary)) return false;
    try {
        renderBlockInspector(
            __cooptBlockInspectorLastSummary,
            __cooptBlockInspectorLastGroups || {},
            __cooptBlockInspectorLastBlockById,
            __cooptBlockInspectorLastBlocksInOrder,
        );
        return true;
    } catch (_) {
        return false;
    }
}

function ensureDesignIntentQuickEditorToggleBinding(): void {
    if (__designIntentQuickEditorDelegatedBindingInstalled) {
        syncDesignIntentQuickEditorToggle();
        return;
    }

    document.addEventListener('click', (event) => {
        const target = event.target as HTMLElement | null;
        if (target && target.id === 'design-intent-quick-editor-toggle') {
            try { event.stopPropagation(); } catch (_) {}
        }
    });

    document.addEventListener('change', (event) => {
        const target = event.target as HTMLInputElement | null;
        if (!target || target.id !== 'design-intent-quick-editor-toggle') return;
        writeDesignIntentQuickEditorEnabled(!!target.checked);
        syncDesignIntentQuickEditorToggle();
        if (!rerenderBlockInspectorFromCache()) {
            try { refreshBlockInspector(); } catch (_) {}
        }
    });

    __designIntentQuickEditorDelegatedBindingInstalled = true;
    syncDesignIntentQuickEditorToggle();
}

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

function __blocks_getMutuallyExclusiveGlassVarKeys(key: string): string[] {
    const normalizedKey = String(key ?? '').trim().toLowerCase();
    const match = normalizedKey.match(/^(material|rindex|abbe|vd|nd)(\d*)$/);
    if (!match) return [];

    const family = match[1];
    const suffix = match[2] || '';
    if (family === 'material') {
        return [`rindex${suffix}`, `abbe${suffix}`, `vd${suffix}`, `nd${suffix}`];
    }

    return [`material${suffix}`];
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

        const initialValue = ((String(key ?? '').trim().toLowerCase() === 'bending')
            && !!cooptGetBendingConfigForBlock(b))
            ? cooptComputeLensBendingValue(b, String(b?.blockType ?? '').trim())
            : (cooptGetBlockNumericValue(b, key) ?? '');

        if (!b.variables || typeof b.variables !== 'object') b.variables = {};
        if (!b.variables[key] || typeof b.variables[key] !== 'object') b.variables[key] = { value: initialValue };
        if (!b.variables[key].optimize || typeof b.variables[key].optimize !== 'object') b.variables[key].optimize = {};
        b.variables[key].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';

        try {
            saveSystemConfigurations(systemConfig);
        } catch (_) {}
    } catch (_) {}
}

function __blocks_moveBlock(fromBlockId: string, toBlockId: string, position: 'before' | 'after'): void {
    try {
        const systemConfig = loadSystemConfigurations();
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) return;
        const activeId = systemConfig.activeConfigId;
        const activeCfg = systemConfig.configurations.find((c: any) => c && c.id === activeId);
        if (!activeCfg || !Array.isArray(activeCfg.blocks)) return;

        const blocks: any[] = activeCfg.blocks;
        const fromIdx = blocks.findIndex((b: any) => String(b?.blockId ?? '') === fromBlockId);
        const toIdx = blocks.findIndex((b: any) => String(b?.blockId ?? '') === toBlockId);
        if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;

        const [moved] = blocks.splice(fromIdx, 1);
        const insertIdx = blocks.findIndex((b: any) => String(b?.blockId ?? '') === toBlockId);
        const finalIdx = (position === 'before') ? insertIdx : insertIdx + 1;
        blocks.splice(finalIdx, 0, moved);

        // Re-expand optical system from new block order
        try {
            if (typeof expandBlocksToOpticalSystemRows === 'function') {
                const exp = expandBlocksToOpticalSystemRows(blocks);
                if (exp && Array.isArray(exp.rows)) {
                    activeCfg.opticalSystem = exp.rows;
                    try { if (typeof saveOpticalSystemTableData === 'function') saveOpticalSystemTableData(exp.rows as any); } catch (_) {}
                }
            }
        } catch (_) {}

        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
        saveSystemConfigurations(systemConfig);
        try { refreshBlockInspector(); } catch (_) {}
        try { if (typeof (w as any).loadActiveConfigurationToTables === 'function') (w as any).loadActiveConfigurationToTables({ applyToUI: true }); } catch (_) {}
    } catch (_) {}
}

function __blocks_setVarMode(blockId: string, key: string, enabled: boolean, scope: string = 'perConfig'): void {
    try {
        const systemConfig = loadSystemConfigurations();
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) return;

        const mutuallyExclusiveKeys = enabled
            ? __blocks_getMutuallyExclusiveGlassVarKeys(key)
            : [];

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
                const raw0 = (String(key ?? '').trim().toLowerCase() === 'bending' && b0)
                    ? cooptComputeLensBendingValue(b0, String(b0?.blockType ?? '').trim())
                    : cooptGetBlockNumericValue(b0, key);
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

            const initialValue = ((String(key ?? '').trim().toLowerCase() === 'bending')
                && !!cooptGetBendingConfigForBlock(b))
                ? cooptComputeLensBendingValue(b, String(b?.blockType ?? '').trim())
                : (cooptGetBlockNumericValue(b, key) ?? '');

            if (!b.variables || typeof b.variables !== 'object') b.variables = {};
            if (!b.variables[key] || typeof b.variables[key] !== 'object') b.variables[key] = { value: initialValue };
            if (!b.variables[key].optimize || typeof b.variables[key].optimize !== 'object') b.variables[key].optimize = {};
            b.variables[key].optimize.mode = enabled ? 'V' : 'F';
            b.variables[key].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';

            if (enabled && mutuallyExclusiveKeys.length > 0) {
                for (const excludedKey of mutuallyExclusiveKeys) {
                    const existing = b.variables?.[excludedKey];
                    if (!existing || typeof existing !== 'object') continue;
                    if (!existing.optimize || typeof existing.optimize !== 'object') existing.optimize = {};
                    existing.optimize.mode = 'F';
                }
            }

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

        try {
            __cooptScheduleDesignIntentUiRefresh({
                systemConfig,
                activeConfigId: systemConfig.activeConfigId,
                refreshBlockInspector: true,
                triggerRender: false,
                skipOpticalTableSync: true,
                debounceMs: 40,
            });
        } catch (_) {
            try { requestRefreshBlockInspector(); } catch (_) {}
        }
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

        __cooptScheduleDesignIntentUiRefresh({
            systemConfig,
            activeConfigId: String(activeCfg.id ?? activeId ?? ''),
            refreshBlockInspector: true,
            triggerRender: true,
            debounceMs: 80,
        });

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
    
    if (type === 'Paraxial') {
        const flx = pick('focalLengthX') || pick('focalLength');
        const fly = pick('focalLengthY') || pick('focalLength');
        const parts = [];
        if (String(flx) !== '' || String(fly) !== '') {
            parts.push(`Fx=${String(flx || fly)}`);
            parts.push(`Fy=${String(fly || flx)}`);
        }
        return parts.join(' ');
    }

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

function cooptIsStrictNumericQuickInputPath(path: string): boolean {
    const normalizedPath = String(path ?? '').trim();
    if (!normalizedPath) return false;
    return /^(?:parameters\.(?:frontRadius|backRadius|centerThickness|abbe|radius(?:[1-4])?|thickness(?:[1-3])?|semidia)|aperture\.(?:front|back|s[1-4]|semidia))$/.test(normalizedPath);
}

function cooptNormalizeQuickInputValue(raw: string, original: any, path: string): { valid: boolean; value: any } {
    const normalizedPath = String(path ?? '').trim();
    const trimmed = String(raw ?? '').trim();
    const numericField = cooptIsStrictNumericQuickInputPath(normalizedPath);
    const radiusField = /(?:^|\.)(?:frontRadius|backRadius|radius(?:[1-4])?|radius)$/.test(normalizedPath);

    if (numericField) {
        if (trimmed === '') return { valid: true, value: '' };
        if (radiusField && /^inf(inity)?$/i.test(trimmed)) return { valid: true, value: 'INF' };
        if (/^[-+]?((\d+\.\d*)|(\d*\.\d+)|(\d+))(e[-+]?\d+)?$/i.test(trimmed)) {
            return { valid: true, value: Number(trimmed) };
        }
        return { valid: false, value: original };
    }

    return { valid: true, value: cooptNormalizeInputValue(trimmed, original) };
}

function cooptParseFiniteRadius(value: any): number | null {
    const text = String(value ?? '').trim();
    if (!text || /^inf(inity)?$/i.test(text)) return null;
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || Math.abs(numeric) < 1e-12) return null;
    return numeric;
}

function cooptParseRadiusCurvature(value: any): number | null {
    const text = String(value ?? '').trim();
    if (!text) return null;
    if (/^inf(inity)?$/i.test(text)) return 0;
    const numeric = Number(text);
    if (!Number.isFinite(numeric) || Math.abs(numeric) < 1e-12) return null;
    return 1 / numeric;
}

function cooptGetBlockNumericValue(block: any, key: string): any {
    if (!block || typeof block !== 'object') return undefined;
    const params = (block.parameters && typeof block.parameters === 'object') ? block.parameters : null;
    if (params && Object.prototype.hasOwnProperty.call(params, key)) {
        const value = params[key];
        if (value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')) {
            return value;
        }
    }
    const vars = (block.variables && typeof block.variables === 'object') ? block.variables : null;
    const entry = vars?.[key];
    if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value')) {
        return entry.value;
    }
    return undefined;
}

function cooptGetBendingConfigForBlock(blockOrType: any): {
    radiusAKey: string;
    radiusBKey: string;
} | null {
    const blockType = typeof blockOrType === 'string'
        ? String(blockOrType).trim()
        : String(blockOrType?.blockType ?? '').trim();
    if (blockType === 'Lens' || blockType === 'PositiveLens') {
        return { radiusAKey: 'frontRadius', radiusBKey: 'backRadius' };
    }
    return null;
}

function cooptComputeLensBendingValue(blockOrParams: any, blockType: string = 'Lens'): number | '' {
    if (isDoubletBendingBlock(blockType)) {
        const block = (blockOrParams && typeof blockOrParams === 'object' && (blockOrParams.parameters || blockOrParams.variables))
            ? blockOrParams
            : { blockType, parameters: blockOrParams };
        return getDoubletBendingCurrentValue(block);
    }
    const config = cooptGetBendingConfigForBlock(blockType);
    if (!config) return '';
    const block = (blockOrParams && typeof blockOrParams === 'object' && (blockOrParams.parameters || blockOrParams.variables))
        ? blockOrParams
        : { parameters: blockOrParams };
    const c1 = cooptParseRadiusCurvature(cooptGetBlockNumericValue(block, config.radiusAKey));
    const c2 = cooptParseRadiusCurvature(cooptGetBlockNumericValue(block, config.radiusBKey));
    if (c1 === null || c2 === null) return '';

    const curvatureDiff = c1 - c2;
    if (!Number.isFinite(curvatureDiff) || Math.abs(curvatureDiff) < 1e-12) return '';

    const bending = (c1 + c2) / curvatureDiff;
    return Number.isFinite(bending) ? bending : '';
}

function cooptCloneJsonValue(value: any): any {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (_) {
        return value;
    }
}

function cooptPreserveLegacySemidiaIntoExpanded(expandedRows: any[], legacyRows: any[]): void {
    if (!Array.isArray(expandedRows) || !Array.isArray(legacyRows) || expandedRows.length === 0 || legacyRows.length === 0) return;

    const hasValue = (value: any): boolean => {
        if (value === null || value === undefined) return false;
        return String(value).trim() !== '';
    };

    const getLegacySemidia = (row: any): any => {
        if (!row || typeof row !== 'object') return null;
        return row.semidia ?? row['Semi Diameter'] ?? row['semi diameter'] ?? row.semiDiameter ?? row.semiDia;
    };

    const rowType = (row: any): string => String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();

    const isSkippableRow = (row: any): boolean => {
        const type = rowType(row);
        return type === 'stop' || type === 'sto' || type === 'image' || type === 'object'
            || type === 'coordtrans' || type === 'coord trans' || type === 'ct';
    };

    const keyFor = (row: any): string => {
        if (!row || typeof row !== 'object') return '';
        const blockId = String(row._blockId ?? '').trim();
        const role = String(row._surfaceRole ?? '').trim();
        return (blockId && role) ? `${blockId}|${role}` : '';
    };

    const legacyByKey = new Map<string, any>();
    for (const legacyRow of legacyRows) {
        if (!legacyRow || typeof legacyRow !== 'object' || isSkippableRow(legacyRow)) continue;
        const key = keyFor(legacyRow);
        if (key) legacyByKey.set(key, legacyRow);
    }

    let legacyIndex = 0;
    for (const expandedRow of expandedRows) {
        if (!expandedRow || typeof expandedRow !== 'object' || isSkippableRow(expandedRow)) continue;

        let legacyRow: any = null;
        const key = keyFor(expandedRow);
        if (key && legacyByKey.has(key)) {
            legacyRow = legacyByKey.get(key);
        } else {
            while (legacyIndex < legacyRows.length && isSkippableRow(legacyRows[legacyIndex])) legacyIndex += 1;
            legacyRow = legacyIndex < legacyRows.length ? legacyRows[legacyIndex] : null;
            legacyIndex += 1;
        }

        const legacySemidia = getLegacySemidia(legacyRow);
        if (hasValue(legacySemidia)) expandedRow.semidia = legacySemidia;
    }
}

function cooptResolveLensBendingUpdate(block: any, bendingValue: any): {
    radiusAKey: string;
    radiusBKey: string;
    oldRadiusA: any;
    oldRadiusB: any;
    newRadiusA: number | 'INF';
    newRadiusB: number | 'INF';
} | null {
    const params = (block && typeof block === 'object' && block.parameters && typeof block.parameters === 'object') ? block.parameters : null;
    if (!params) return null;
    const config = cooptGetBendingConfigForBlock(block);
    if (!config) return null;

    const nextBending = Number(bendingValue);
    if (!Number.isFinite(nextBending)) return null;

    const c1 = cooptParseRadiusCurvature(params[config.radiusAKey]);
    const c2 = cooptParseRadiusCurvature(params[config.radiusBKey]);
    if (c1 === null || c2 === null) return null;
    const curvatureDiff = c1 - c2;
    if (!Number.isFinite(curvatureDiff) || Math.abs(curvatureDiff) < 1e-12) return null;

    const curvatureSum = nextBending * curvatureDiff;
    const nextC1 = (curvatureSum + curvatureDiff) / 2;
    const nextC2 = (curvatureSum - curvatureDiff) / 2;
    if (!Number.isFinite(nextC1) || !Number.isFinite(nextC2)) return null;
    if (Math.abs(nextC1) > 1e6 || Math.abs(nextC2) > 1e6) return null;

    const curvatureToRadius = (curvature: number): number | 'INF' | null => {
        if (!Number.isFinite(curvature) || Math.abs(curvature) > 1e6) return null;
        if (Math.abs(curvature) < 1e-12) return 'INF';
        const radius = 1 / curvature;
        return Number.isFinite(radius) ? radius : null;
    };

    const newRadiusA = curvatureToRadius(nextC1);
    const newRadiusB = curvatureToRadius(nextC2);
    if (newRadiusA === null || newRadiusB === null) return null;

    return {
        radiusAKey: config.radiusAKey,
        radiusBKey: config.radiusBKey,
        oldRadiusA: params[config.radiusAKey],
        oldRadiusB: params[config.radiusBKey],
        newRadiusA,
        newRadiusB,
    };
}

function cooptAutoApplyGapThicknessModes(blocks: any[], changedPath: string = ''): { changed: boolean; rows: any[] | null } {
    if (!Array.isArray(blocks) || blocks.length === 0) return { changed: false, rows: null };

    const primaryWavelength = (() => {
        try {
            if (typeof w.getPrimaryWavelength === 'function') {
                const wl = Number(w.getPrimaryWavelength());
                if (Number.isFinite(wl) && wl > 0) return wl;
            }
        } catch (_) {}
        return NaN;
    })();
    if (!(Number.isFinite(primaryWavelength) && primaryWavelength > 0)) return { changed: false, rows: null };

    try {
        const expanded = expandBlocksToOpticalSystemRows(blocks as any);
        const rows = expanded && Array.isArray(expanded.rows) ? expanded.rows : [];
        if (rows.length === 0) return { changed: false, rows: null };

        const paraxial = calculateParaxialData(rows, primaryWavelength);
        if (!paraxial) return { changed: false, rows: null };

        let changed = false;
        for (const block of blocks) {
            if (!block || typeof block !== 'object') continue;
            const blockType = String(block.blockType ?? '').trim();
            if (blockType !== 'Gap' && blockType !== 'AirGap') continue;

            const params = (block.parameters && typeof block.parameters === 'object') ? block.parameters : null;
            if (!params) continue;

            const mode = String(params.thicknessMode ?? '').trim().replace(/\s+/g, '').toUpperCase();
            if (mode !== 'IMD' && mode !== 'BFL') continue;

            const target = mode === 'IMD' ? paraxial.imageDistance : paraxial.backFocalLength;
            const numeric = Number(target);
            if (!Number.isFinite(numeric)) continue;

            const current = Number(params.thickness);
            if (Number.isFinite(current) && Math.abs(current - numeric) <= 1e-9) continue;

            params.thickness = numeric;
            if (block.variables && typeof block.variables === 'object' && block.variables.thickness && typeof block.variables.thickness === 'object' && Object.prototype.hasOwnProperty.call(block.variables.thickness, 'value')) {
                block.variables.thickness.value = numeric;
            }
            changed = true;
        }

        return { changed, rows };
    } catch (err) {
        console.warn('⚠️ [DesignIntent] Failed to auto-apply thicknessMode:', err);
        return { changed: false, rows: null };
    }
}

let __cooptBlockParamDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let __cooptBlockDerivedUiTimer: ReturnType<typeof setTimeout> | null = null;
let __cooptBlockOpticalTableTimer: ReturnType<typeof setTimeout> | null = null;
let __cooptRenderSyncTimer: ReturnType<typeof setTimeout> | null = null;
let __cooptPendingRenderSyncRequest: {
    rows: any[];
    objectRows: any[];
    systemConfig: any;
} | null = null;
let __cooptBlockParamPendingRefresh: {
    systemConfig: any;
    activeConfigId: string;
    changedPath: string;
} | null = null;

function cooptHasActiveRenderSyncTarget(): boolean {
    try {
        if (localStorage.getItem(RENDER_DESIGN_INTENT_SYNC_KEY) !== 'true') {
            return false;
        }
    } catch (_) {
        return false;
    }

    try {
        if (typeof w.__cooptRenderWindowRedraw === 'function') return true;
    } catch (_) {}
    try {
        if (w.popup3DWindow && !w.popup3DWindow.closed) return true;
    } catch (_) {}
    try {
        if (isTauriRuntime()) return true;
    } catch (_) {}
    return false;
}

function cooptHasMountedOpticalTable(): boolean {
    try {
        const tableOptical = w.tableOpticalSystem || w.opticalSystemTabulator;
        return !!(tableOptical && (typeof tableOptical.replaceData === 'function' || typeof tableOptical.setData === 'function'));
    } catch (_) {
        return false;
    }
}

function cooptHasAutoGapThicknessMode(blocks: any[]): boolean {
    if (!Array.isArray(blocks) || blocks.length === 0) return false;
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const blockType = String(block.blockType ?? '').trim();
        if (blockType !== 'Gap' && blockType !== 'AirGap') continue;
        const mode = String(block?.parameters?.thicknessMode ?? '').trim().replace(/\s+/g, '').toUpperCase();
        if (mode === 'IMD' || mode === 'BFL') return true;
    }
    return false;
}

function cooptNeedsExpandedRowsForBlockChange(blocks: any[], changedPath: string): boolean {
    if (requiresExpandedRowsForDesignIntentChange(changedPath)) return true;
    if (cooptHasAutoGapThicknessMode(blocks)) return true;
    return false;
}

function cooptSuppressOpticalSystemDataChanged(enabled: boolean): void {
    try {
        const key = '__suppressOpticalSystemDataChangedDepth';
        const depth = Number(w[key] || 0);
        if (enabled) {
            w[key] = depth + 1;
            w.__suppressOpticalSystemDataChanged = true;
            return;
        }
        const next = Math.max(0, depth - 1);
        w[key] = next;
        w.__suppressOpticalSystemDataChanged = next > 0;
    } catch (_) {}
}

function cooptScheduleDeferredOpticalTableSync(rows: any[] | null): void {
    if (!Array.isArray(rows)) return;

    const schedule = () => {
        try {
            saveOpticalSystemTableData(rows as any);
        } catch (_) {}
        try {
            if (typeof w.saveLensTableData === 'function') w.saveLensTableData(rows);
        } catch (_) {}

        try {
            const tableOptical = w.tableOpticalSystem || w.opticalSystemTabulator;
            if (tableOptical && typeof tableOptical.replaceData === 'function') {
                cooptSuppressOpticalSystemDataChanged(true);
                tableOptical.replaceData(rows);
            } else if (tableOptical && typeof tableOptical.setData === 'function') {
                cooptSuppressOpticalSystemDataChanged(true);
                tableOptical.setData(rows);
            }
        } catch (_) {}
        try {
            requestUpdateSurfaceNumberSelect(w);
        } catch (_) {}
        try {
            setTimeout(() => {
                cooptSuppressOpticalSystemDataChanged(false);
            }, 0);
        } catch (_) {}
    };

    if (__cooptBlockOpticalTableTimer !== null) clearTimeout(__cooptBlockOpticalTableTimer);
    __cooptBlockOpticalTableTimer = setTimeout(() => {
        __cooptBlockOpticalTableTimer = null;
        try {
            const requestIdle = (w as any).requestIdleCallback;
            if (typeof requestIdle === 'function') {
                requestIdle(() => schedule(), { timeout: 800 });
                return;
            }
        } catch (_) {}
        schedule();
    }, 900);
}

function __cooptRequestRenderRedrawWithRows(rowsSnapshot: any[] | null): void {
    if (!__cooptIsRenderDesignIntentLiveSyncEnabled()) {
        return;
    }

    let rows = Array.isArray(rowsSnapshot) ? rowsSnapshot : [];
    let objectRows: any[] = [];
    try {
        if (typeof w.getObjectRows === 'function') {
            const liveTableRows = w.getObjectRows(w.tableObject);
            if (Array.isArray(liveTableRows) && liveTableRows.length > 0) {
                objectRows = liveTableRows.slice();
            }
        }
    } catch (_) {}
    try {
        const runtimeSystemConfig = __cooptGetSystemConfig();
        const activeConfig = runtimeSystemConfig?.configurations?.find((cfg: any) => cfg && String(cfg.id) === String(runtimeSystemConfig?.activeConfigId))
            || runtimeSystemConfig?.configurations?.[0]
            || null;
        if (objectRows.length === 0 && Array.isArray(activeConfig?.object) && activeConfig.object.length > 0) {
            objectRows = activeConfig.object.slice();
        }
        if (rows.length === 0) {
            const activeBlocks = Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
            if (Array.isArray(activeConfig?.opticalSystem) && activeConfig.opticalSystem.length > 0) {
                rows = activeConfig.opticalSystem.slice();
            } else if (activeBlocks.length > 0) {
                const legacyRows = Array.isArray(activeConfig?.opticalSystem) ? activeConfig.opticalSystem : [];
                const autoGapResult = cooptAutoApplyGapThicknessModes(activeBlocks, '');
                const expandedRows = Array.isArray(autoGapResult?.rows)
                    ? autoGapResult.rows
                    : (() => {
                        const expanded = expandBlocksToOpticalSystemRows(activeBlocks as any);
                        return expanded && Array.isArray(expanded.rows) ? expanded.rows : [];
                    })();
                if (expandedRows.length > 0) {
                    cooptPreserveLegacySemidiaIntoExpanded(expandedRows, legacyRows);
                    rows = expandedRows.slice();
                    try {
                        activeConfig.opticalSystem = expandedRows;
                    } catch (_) {}
                }
            }
        }
    } catch (_) {}
    if (objectRows.length === 0) {
        try {
            if (typeof w.getObjectRows === 'function') {
                const tableRows = w.getObjectRows(w.tableObject);
                if (Array.isArray(tableRows) && tableRows.length > 0) {
                    objectRows = tableRows.slice();
                }
            }
        } catch (_) {}
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        return;
    }

    __cooptPendingRenderSyncRequest = {
        rows: Array.isArray(rows) ? rows.slice() : [],
        objectRows: Array.isArray(objectRows) ? objectRows.slice() : [],
        systemConfig: __cooptGetSystemConfig(),
    };

    if (__cooptRenderSyncTimer !== null) {
        clearTimeout(__cooptRenderSyncTimer);
    }

    __cooptRenderSyncTimer = setTimeout(() => {
        __cooptRenderSyncTimer = null;
        const pending = __cooptPendingRenderSyncRequest;
        __cooptPendingRenderSyncRequest = null;
        if (!pending || !Array.isArray(pending.rows) || pending.rows.length === 0) {
            return;
        }

        const renderRowsPayload = cooptCloneJsonValue(pending.rows) || [];
        const renderObjectRowsPayload = Array.isArray(pending.objectRows) ? (cooptCloneJsonValue(pending.objectRows) || []) : [];
        const systemConfig = (pending.systemConfig && typeof pending.systemConfig === 'object')
            ? (cooptCloneJsonValue(pending.systemConfig) || pending.systemConfig)
            : null;
        const token = `${Date.now()}-block-param`;
        const popup = (() => {
            try {
                return w.popup3DWindow && !w.popup3DWindow.closed ? w.popup3DWindow : null;
            } catch (_) {
                return null;
            }
        })();
        const hasLocalRenderTarget = typeof w.__cooptRenderWindowRedraw === 'function';
        const canUseTauriRenderSync = isTauriRuntime();
        const hasPopupDirectRedraw = !!(popup && typeof popup.__cooptRenderWindowRedraw === 'function');
        const hasPopupMessageTarget = !!(popup && typeof popup.postMessage === 'function');
        const needsExternalSync = canUseTauriRenderSync || (!hasLocalRenderTarget && !hasPopupDirectRedraw && !hasPopupMessageTarget);

        try {
            if (hasLocalRenderTarget && typeof w.__cooptRenderWindowRedraw === 'function') {
                try {
                    if (systemConfig && typeof systemConfig === 'object') {
                        w.__cooptPendingRenderSystemConfig = systemConfig;
                        w.__cooptSystemConfig = systemConfig;
                        w.__cooptPreferRuntimeSystemConfig = true;
                    }
                } catch (_) {}
                w.__cooptRenderWindowRedraw(renderRowsPayload, token, renderObjectRowsPayload);
            }
        } catch (_) {}

        try {
            if (popup && !popup.closed) {
                if (hasPopupDirectRedraw) {
                    try {
                        if (systemConfig && typeof systemConfig === 'object') {
                            popup.__cooptPendingRenderSystemConfig = systemConfig;
                            popup.__cooptSystemConfig = systemConfig;
                            popup.__cooptPreferRuntimeSystemConfig = true;
                        }
                    } catch (_) {}
                    popup.__cooptRenderWindowRedraw(renderRowsPayload, token, renderObjectRowsPayload);
                } else if (hasPopupMessageTarget) {
                    try { popup.__cooptPendingRenderRows = renderRowsPayload; } catch (_) {}
                    try { popup.__cooptPendingRenderObjectRows = renderObjectRowsPayload; } catch (_) {}
                    popup.postMessage({ action: 'request-redraw', rows: renderRowsPayload, objectRows: renderObjectRowsPayload, systemConfig, ts: token, token }, '*');
                }
            }
        } catch (_) {}

        try {
            if (needsExternalSync) {
                localStorage.setItem('coopt.renderSyncRequest', JSON.stringify({ ts: token, token, rows: renderRowsPayload, objectRows: renderObjectRowsPayload, systemConfig, senderId: getOrCreateCooptWindowSyncSenderId() }));
            }
        } catch (_) {}

        try {
            if (canUseTauriRenderSync) {
                void (async () => {
                    try {
                        const mod = await import('@tauri-apps/api/event');
                        if (mod && typeof (mod as any).emit === 'function') {
                            await (mod as any).emit('coopt-render-sync-request', { ts: token, token, rows: renderRowsPayload, objectRows: renderObjectRowsPayload, systemConfig });
                        }
                    } catch (_) {}
                })();
            }
        } catch (_) {}
    }, 90);
}

function cooptRequiresBlockInspectorRefresh(path: string): boolean {
    return requiresBlockInspectorRefreshForDesignIntentChange(path);
}

function cooptRequiresZoomUiRefresh(path: string): boolean {
    return requiresZoomUiRefreshForDesignIntentChange(path);
}

let __cooptDesignIntentUiRefreshTimer: number | null = null;
let __cooptPendingDesignIntentUiRefresh: any = null;

function __cooptScheduleDesignIntentUiRefresh(options: any = {}): void {
    const next = (options && typeof options === 'object') ? options : {};
    const prev = (__cooptPendingDesignIntentUiRefresh && typeof __cooptPendingDesignIntentUiRefresh === 'object')
        ? __cooptPendingDesignIntentUiRefresh
        : {};

    __cooptPendingDesignIntentUiRefresh = {
        systemConfig: next.systemConfig || prev.systemConfig || null,
        activeConfigId: next.activeConfigId ?? prev.activeConfigId ?? null,
        changedPath: String(next.changedPath ?? prev.changedPath ?? ''),
        forceExpandedRows: prev.forceExpandedRows === true || next.forceExpandedRows === true,
        refreshBlockInspector: prev.refreshBlockInspector === true || next.refreshBlockInspector === true,
        refreshZoomUi: prev.refreshZoomUi === true || next.refreshZoomUi === true,
        triggerRender: next.triggerRender === false ? false : (prev.triggerRender === false ? false : true),
        skipOpticalTableSync: prev.skipOpticalTableSync === true || next.skipOpticalTableSync === true,
        debounceMs: Number.isFinite(Number(next.debounceMs)) ? Math.max(0, Number(next.debounceMs)) : (Number.isFinite(Number(prev.debounceMs)) ? Math.max(0, Number(prev.debounceMs)) : 120),
    };

    if (__cooptDesignIntentUiRefreshTimer !== null) {
        clearTimeout(__cooptDesignIntentUiRefreshTimer);
    }

    __cooptDesignIntentUiRefreshTimer = window.setTimeout(() => {
        __cooptDesignIntentUiRefreshTimer = null;
        const pending = (__cooptPendingDesignIntentUiRefresh && typeof __cooptPendingDesignIntentUiRefresh === 'object')
            ? __cooptPendingDesignIntentUiRefresh
            : {};
        __cooptPendingDesignIntentUiRefresh = null;

        try {
            const systemConfig = pending.systemConfig || loadSystemConfigurations();
            const activeConfigId = String(pending.activeConfigId ?? systemConfig?.activeConfigId ?? '');
            const activeConfig = systemConfig?.configurations?.find((cfg: any) => String(cfg?.id ?? '') === activeConfigId)
                || systemConfig?.configurations?.find((cfg: any) => String(cfg?.id ?? '') === String(systemConfig?.activeConfigId ?? ''))
                || systemConfig?.configurations?.[0]
                || null;
            if (!activeConfig) return;

            const changedPath = String(pending.changedPath ?? '');
            const blocks = Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
            const legacyRows = Array.isArray(activeConfig?.opticalSystem) ? activeConfig.opticalSystem : [];
            const shouldRefreshBlockInspector = pending.refreshBlockInspector === true || cooptRequiresBlockInspectorRefresh(changedPath);
            const shouldRefreshZoomUi = pending.refreshZoomUi === true || cooptRequiresZoomUiRefresh(changedPath);
            const shouldExpandRows = pending.forceExpandedRows === true || cooptNeedsExpandedRowsForBlockChange(blocks, changedPath);

            let rowsSnapshot: any[] | null = null;

            try {
                w.__cooptSystemConfig = systemConfig;
                w.__cooptPreferRuntimeSystemConfig = true;
            } catch (_) {}

            if (shouldExpandRows) {
                const autoGapResult = cooptAutoApplyGapThicknessModes(blocks, changedPath);
                const expandedRows = Array.isArray(autoGapResult?.rows)
                    ? autoGapResult.rows
                    : (() => {
                        const expanded = expandBlocksToOpticalSystemRows(blocks as any);
                        return expanded && Array.isArray(expanded.rows) ? expanded.rows : null;
                    })();
                if (Array.isArray(expandedRows)) {
                    cooptPreserveLegacySemidiaIntoExpanded(expandedRows, legacyRows);
                    rowsSnapshot = expandedRows.slice();
                    activeConfig.opticalSystem = expandedRows;
                    if (pending.skipOpticalTableSync !== true) {
                        cooptScheduleDeferredOpticalTableSync(expandedRows);
                    }
                }
            }

            try {
                saveSystemConfigurations(systemConfig);
                delete w.__cooptPreferRuntimeSystemConfig;
            } catch (_) {}

            if (shouldRefreshBlockInspector) {
                try {
                    __cooptBlockInspectorExpandedRowsOverride = Array.isArray(rowsSnapshot) ? rowsSnapshot.slice() : null;
                    __cooptBlockInspectorSkipOpticalTableSync = Array.isArray(rowsSnapshot);
                    requestRefreshBlockInspector();
                } catch (_) {}
            }
            if (shouldRefreshZoomUi) {
                try { refreshZoomControlTab(); } catch (_) {}
            }
            if (pending.triggerRender !== false) {
                __cooptRequestRenderRedrawWithRows(rowsSnapshot);
            }
        } catch (_) {
        } finally {
            try { delete w.__cooptDeferDerivedUiUntil; } catch (_) {}
        }
    }, __cooptPendingDesignIntentUiRefresh.debounceMs);
}

try {
    w.__cooptScheduleDesignIntentUiRefresh = __cooptScheduleDesignIntentUiRefresh;
} catch (_) {}

function cooptApplyBlockValue(blockId: string, path: string, oldValue: any, newValue: any): void {
    const systemConfig = loadSystemConfigurations();
    const activeConfig = systemConfig?.configurations?.find((c: any) => c.id === systemConfig?.activeConfigId)
        || systemConfig?.configurations?.[0];
    if (!activeConfig) return;
    const blocks = Array.isArray(activeConfig.blocks) ? activeConfig.blocks : [];
    const block = blocks.find((b: any) => b && String(b.blockId ?? '') === String(blockId));
    if (!block) return;

    const blockType = String(block?.blockType ?? '').trim();
    if ((blockType === 'Lens' || blockType === 'PositiveLens' || blockType === 'Doublet') && String(path) === 'parameters.bending') {
        if (blockType === 'Doublet') {
            const bendingUpdate = resolveDoubletBendingUpdate(block, newValue);
            if (!bendingUpdate) {
                try { refreshBlockInspector(); } catch (_) {}
                return;
            }

            const oldBase = cooptCloneJsonValue(block?.metadata?.[DOUBLET_BENDING_BASE_KEY]);
            try {
                if (w.undoHistory && w.CompoundCommand && w.SetBlockParameterCommand && !w.undoHistory.isExecuting) {
                    const cmd = new w.CompoundCommand(`Set ${String(blockId)}.bending`);
                    cmd.addCommand(new w.SetBlockParameterCommand(activeConfig.name, String(blockId), 'parameters.radius1', bendingUpdate.oldRadius1, bendingUpdate.newRadius1));
                    cmd.addCommand(new w.SetBlockParameterCommand(activeConfig.name, String(blockId), 'parameters.radius2', bendingUpdate.oldRadius2, bendingUpdate.newRadius2));
                    cmd.addCommand(new w.SetBlockParameterCommand(activeConfig.name, String(blockId), 'parameters.radius3', bendingUpdate.oldRadius3, bendingUpdate.newRadius3));
                    cmd.addCommand(new w.SetBlockParameterCommand(activeConfig.name, String(blockId), 'parameters.bending', block?.parameters?.bending, bendingUpdate.bending));
                    cmd.addCommand(new w.SetBlockParameterCommand(activeConfig.name, String(blockId), `metadata.${DOUBLET_BENDING_BASE_KEY}`, oldBase, cooptCloneJsonValue(bendingUpdate.baseCurvatures)));
                    w.undoHistory.record(cmd);
                }
            } catch (_) {}

            cooptSetNestedValue(block, 'parameters.radius1', bendingUpdate.newRadius1);
            cooptSetNestedValue(block, 'parameters.radius2', bendingUpdate.newRadius2);
            cooptSetNestedValue(block, 'parameters.radius3', bendingUpdate.newRadius3);
            cooptSetNestedValue(block, 'parameters.bending', bendingUpdate.bending);
            cooptSetNestedValue(block, `metadata.${DOUBLET_BENDING_BASE_KEY}`, cooptCloneJsonValue(bendingUpdate.baseCurvatures));
            if (block.variables?.radius1 && typeof block.variables.radius1 === 'object' && Object.prototype.hasOwnProperty.call(block.variables.radius1, 'value')) {
                block.variables.radius1.value = bendingUpdate.newRadius1;
            }
            if (block.variables?.radius2 && typeof block.variables.radius2 === 'object' && Object.prototype.hasOwnProperty.call(block.variables.radius2, 'value')) {
                block.variables.radius2.value = bendingUpdate.newRadius2;
            }
            if (block.variables?.radius3 && typeof block.variables.radius3 === 'object' && Object.prototype.hasOwnProperty.call(block.variables.radius3, 'value')) {
                block.variables.radius3.value = bendingUpdate.newRadius3;
            }
            if (block.variables?.bending && typeof block.variables.bending === 'object' && Object.prototype.hasOwnProperty.call(block.variables.bending, 'value')) {
                block.variables.bending.value = bendingUpdate.bending;
            }
        }

        if (blockType !== 'Doublet') {
            const bendingUpdate = cooptResolveLensBendingUpdate(block, newValue);
            if (!bendingUpdate) {
                try { refreshBlockInspector(); } catch (_) {}
                return;
            }

            const { radiusAKey, radiusBKey, oldRadiusA, oldRadiusB, newRadiusA, newRadiusB } = bendingUpdate;
            if (oldRadiusA === newRadiusA && oldRadiusB === newRadiusB) {
                return;
            }

            try {
                if (w.undoHistory && w.SetLensBendingCommand && !w.undoHistory.isExecuting) {
                    const cmd = new w.SetLensBendingCommand(
                        activeConfig.name,
                        String(blockId),
                        oldRadiusA,
                        oldRadiusB,
                        newRadiusA,
                        newRadiusB,
                    );
                    w.undoHistory.record(cmd);
                }
            } catch (_) {}

            cooptSetNestedValue(block, `parameters.${radiusAKey}`, newRadiusA);
            cooptSetNestedValue(block, `parameters.${radiusBKey}`, newRadiusB);
            cooptSetNestedValue(block, 'parameters.bending', Number(newValue));
            if (block.variables?.[radiusAKey] && typeof block.variables[radiusAKey] === 'object' && Object.prototype.hasOwnProperty.call(block.variables[radiusAKey], 'value')) {
                block.variables[radiusAKey].value = newRadiusA;
            }
            if (block.variables?.[radiusBKey] && typeof block.variables[radiusBKey] === 'object' && Object.prototype.hasOwnProperty.call(block.variables[radiusBKey], 'value')) {
                block.variables[radiusBKey].value = newRadiusB;
            }
            if (block.variables?.bending && typeof block.variables.bending === 'object' && Object.prototype.hasOwnProperty.call(block.variables.bending, 'value')) {
                block.variables.bending.value = Number(newValue);
            }
        }
    } else {

        if (oldValue !== newValue) {
            try {
                if (w.undoHistory && w.SetBlockParameterCommand && !w.undoHistory.isExecuting) {
                    const cmd = new w.SetBlockParameterCommand(activeConfig.name, String(blockId), String(path), oldValue, newValue);
                    w.undoHistory.record(cmd);
                }
            } catch (_) {}
        }

        cooptSetNestedValue(block, path, newValue);
    }
    if (blockType === 'Doublet' && /^parameters\.radius[123]$/.test(String(path))) {
        const bending = syncDoubletBendingState(block);
        if (block.variables?.bending && typeof block.variables.bending === 'object' && Object.prototype.hasOwnProperty.call(block.variables.bending, 'value')) {
            block.variables.bending.value = bending;
        }
        const baseCurvatures = cooptCloneJsonValue(block?.metadata?.[DOUBLET_BENDING_BASE_KEY]);
        if (baseCurvatures) {
            storeDoubletBendingBaseCurvatures(block, baseCurvatures);
        }
    }
    if (blockType === 'ImageSurface' && String(path) === 'parameters.semidia') {
        const semidiaText = String(newValue ?? '').trim().toLowerCase();
        if (semidiaText !== '' && semidiaText !== 'auto') {
            if (!block.parameters || typeof block.parameters !== 'object') block.parameters = {};
            block.parameters.semidiaMode = 'Manual';
            block.parameters.optimizeSemiDia = '';
        }
    }
    if (blockType === 'Paraxial' && /^aperture\./.test(String(path))) {
        if (!block.aperture || typeof block.aperture !== 'object') block.aperture = {};
        const apertureKey = String(path).slice('aperture.'.length).trim();
        if (apertureKey === 's1' || apertureKey === 'front' || apertureKey === 'back') {
            block.aperture.s1 = newValue;
            block.aperture.front = newValue;
            block.aperture.back = newValue;
        }
    }
    try {
        if (activeConfig.metadata) activeConfig.metadata.modified = new Date().toISOString();
    } catch (_) {}
    try {
        w.__cooptDeferDerivedUiUntil = Date.now() + 1400;
    } catch (_) {}
    try {
        w.__cooptSystemConfig = systemConfig;
        w.__cooptPreferRuntimeSystemConfig = true;
    } catch (_) {}

    __cooptBlockParamPendingRefresh = {
        systemConfig,
        activeConfigId: String(systemConfig?.activeConfigId ?? activeConfig?.id ?? ''),
        changedPath: String(path ?? '')
    };

    // Debounce heavy UI refresh so rapid input (e.g. typing digits) does not freeze the page.
    if (__cooptBlockParamDebounceTimer !== null) clearTimeout(__cooptBlockParamDebounceTimer);
    __cooptBlockParamDebounceTimer = setTimeout(() => {
        __cooptBlockParamDebounceTimer = null;
        let rowsSnapshot: any[] | null = null;
        let didPersistSystemConfig = false;
        const pending = __cooptBlockParamPendingRefresh;

        try {
            __cooptBlockParamPendingRefresh = null;
            const latestSystemConfig = pending?.systemConfig || loadSystemConfigurations();
            const latestActiveConfig = latestSystemConfig?.configurations?.find((c: any) => String(c?.id ?? '') === String(pending?.activeConfigId ?? ''))
                || latestSystemConfig?.configurations?.find((c: any) => c.id === latestSystemConfig?.activeConfigId)
                || latestSystemConfig?.configurations?.[0];
            const latestBlocks = Array.isArray(latestActiveConfig?.blocks) ? latestActiveConfig.blocks : [];
            const legacyRows = Array.isArray(latestActiveConfig?.opticalSystem) ? latestActiveConfig.opticalSystem : [];
            const changedPath = String(pending?.changedPath ?? '');
            if (cooptNeedsExpandedRowsForBlockChange(latestBlocks, changedPath)) {
                const autoGapResult = cooptAutoApplyGapThicknessModes(latestBlocks, changedPath);
                const expandedRows = Array.isArray(autoGapResult.rows)
                    ? autoGapResult.rows
                    : (() => {
                        const expanded = expandBlocksToOpticalSystemRows(latestBlocks as any);
                        return expanded && Array.isArray(expanded.rows) ? expanded.rows : null;
                    })();
                if (Array.isArray(expandedRows)) {
                    cooptPreserveLegacySemidiaIntoExpanded(expandedRows, legacyRows);
                    rowsSnapshot = expandedRows.slice();
                    latestActiveConfig.opticalSystem = expandedRows;
                    cooptScheduleDeferredOpticalTableSync(expandedRows);

                    try {
                        saveSystemConfigurations(latestSystemConfig);
                        didPersistSystemConfig = true;
                        delete w.__cooptPreferRuntimeSystemConfig;
                    } catch (_) {}
                }
            }

            if (!didPersistSystemConfig) {
                try {
                    saveSystemConfigurations(latestSystemConfig);
                    didPersistSystemConfig = true;
                    delete w.__cooptPreferRuntimeSystemConfig;
                } catch (_) {}
            }
        } catch (_) {}

        if (__cooptBlockDerivedUiTimer !== null) clearTimeout(__cooptBlockDerivedUiTimer);
        __cooptBlockDerivedUiTimer = setTimeout(() => {
            __cooptBlockDerivedUiTimer = null;
            const changedPath = String(pending?.changedPath ?? '');
            if (cooptRequiresBlockInspectorRefresh(changedPath)) {
                try {
                    __cooptBlockInspectorExpandedRowsOverride = Array.isArray(rowsSnapshot) ? rowsSnapshot.slice() : null;
                    __cooptBlockInspectorSkipOpticalTableSync = Array.isArray(rowsSnapshot);
                    requestRefreshBlockInspector();
                } catch (_) {}
            }
            if (cooptRequiresZoomUiRefresh(changedPath)) {
                try { refreshZoomControlTab(); } catch (_) {}
            }
            __cooptRequestRenderRedrawWithRows(rowsSnapshot);
            try { delete w.__cooptDeferDerivedUiUntil; } catch (_) {}
        }, 650);
    }, 420);
}

const ZOOM_GROUP_OPTIONS = ['Fixed', ...Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index))];
const ZOOM_PREVIEW_COMMIT_DELAY_MS = 140;
const ZOOM_PREVIEW_RENDER_INTERVAL_MS = 180;

let __zoomPreviewCommitTimer: number | null = null;
let __zoomPreviewRafId: number | null = null;
let __zoomPreviewQueuedValue: number | null = null;
let __zoomPreviewPrevPreferRuntime: boolean | null = null;
let __zoomPreviewPrevRuntimeConfig: any = null;
let __zoomPreviewLastRenderAt = 0;
let __zoomPreviewPendingCommit: {
    blockId: string;
    oldValue: number;
    latestValue: number;
    systemConfig: any;
    activeConfig: any;
    controller: any;
    blocks: any[];
} | null = null;

function __zoom_stageRuntimePreviewConfig(systemConfig: any): void {
    try {
        if (__zoomPreviewPrevPreferRuntime === null) {
            __zoomPreviewPrevPreferRuntime = !!w.__cooptPreferRuntimeSystemConfig;
            __zoomPreviewPrevRuntimeConfig = w.__cooptSystemConfig;
        }
    } catch (_) {}
    try {
        w.__cooptSystemConfig = systemConfig;
        w.__cooptPreferRuntimeSystemConfig = true;
    } catch (_) {}
}

function __zoom_restoreRuntimePreviewConfig(): void {
    try {
        if (__zoomPreviewPrevPreferRuntime) {
            w.__cooptSystemConfig = __zoomPreviewPrevRuntimeConfig;
            w.__cooptPreferRuntimeSystemConfig = true;
        } else {
            delete w.__cooptPreferRuntimeSystemConfig;
            if (__zoomPreviewPrevRuntimeConfig === undefined) delete w.__cooptSystemConfig;
            else w.__cooptSystemConfig = __zoomPreviewPrevRuntimeConfig;
        }
    } catch (_) {}
    __zoomPreviewPrevPreferRuntime = null;
    __zoomPreviewPrevRuntimeConfig = null;
}

function __zoom_requestRenderRefresh(expandedRowsForRender: any[] | null): void {
    const popup = (() => {
        try {
            return w.popup3DWindow && !w.popup3DWindow.closed ? w.popup3DWindow : null;
        } catch (_) {
            return null;
        }
    })();
    if (!popup && typeof w.__cooptRenderWindowRedraw !== 'function') return;

    try {
        if (popup && !popup.closed) {
            try {
                popup.__cooptZoomPreviewActive = !!(globalThis as any).__cooptZoomPreviewActive;
            } catch (_) {}
        }
        __cooptRequestRenderRedrawWithRows(Array.isArray(expandedRowsForRender) ? expandedRowsForRender : null);
    } catch (_) {}
}

function __zoom_applyPreviewPosition(nextValue: number): void {
    const pending = __zoomPreviewPendingCommit;
    if (!pending?.activeConfig || !pending?.controller || !Array.isArray(pending.blocks)) return;

    try {
        (globalThis as any).__cooptZoomPreviewActive = true;
    } catch (_) {}

    const safeZoomPosition = Math.max(0, Math.min(1, Number(nextValue) || 0));
    if (!pending.controller.parameters || typeof pending.controller.parameters !== 'object') pending.controller.parameters = {};
    pending.controller.parameters.zoomPosition = safeZoomPosition;
    pending.latestValue = safeZoomPosition;
    if (!pending.activeConfig.metadata || typeof pending.activeConfig.metadata !== 'object') pending.activeConfig.metadata = {};
    pending.activeConfig.metadata.modified = new Date().toISOString();

    // Keep runtime config in sync, but do not expand/redraw on every slider frame.
    // Zoom preview is intentionally degraded to a throttled preview to avoid freezing the UI.
    __zoom_stageRuntimePreviewConfig(pending.systemConfig);

    const hasRenderTarget = (() => {
        try {
            if (typeof w.__cooptRenderWindowRedraw === 'function') return true;
        } catch (_) {}
        try {
            return !!(w.popup3DWindow && !w.popup3DWindow.closed);
        } catch (_) {
            return false;
        }
    })();
    if (!hasRenderTarget) return;

    const now = Date.now();
    if ((now - __zoomPreviewLastRenderAt) < ZOOM_PREVIEW_RENDER_INTERVAL_MS) return;
    __zoomPreviewLastRenderAt = now;

    let expandedRowsForRender: any[] | null = null;
    try {
        const expanded = expandBlocksToOpticalSystemRows(pending.blocks as any);
        if (expanded && Array.isArray(expanded.rows)) {
            expandedRowsForRender = expanded.rows;
            pending.activeConfig.opticalSystem = expanded.rows;
        }
    } catch (_) {}

    __zoom_requestRenderRefresh(expandedRowsForRender);
}

function __zoom_schedulePreviewCommit(): void {
    if (__zoomPreviewCommitTimer !== null) {
        try { window.clearTimeout(__zoomPreviewCommitTimer); } catch (_) {}
    }
    __zoomPreviewCommitTimer = window.setTimeout(() => {
        __zoomPreviewCommitTimer = null;
        __zoom_flushPreviewCommit();
    }, ZOOM_PREVIEW_COMMIT_DELAY_MS);
}

function __zoom_previewSetPosition(nextValue: any): any {
    const state = __zoom_collectState();
    if (!state.available || !state.controllerBlockId) return state;

    const safeZoomPosition = Math.max(0, Math.min(1, Number(nextValue) || 0));
    if (!__zoomPreviewPendingCommit || __zoomPreviewPendingCommit.blockId !== state.controllerBlockId) {
        const { systemConfig, activeConfig, controller } = __zoom_getActiveConfigAndController();
        const blocks = Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
        if (!systemConfig || !activeConfig || !controller || !Array.isArray(blocks) || blocks.length === 0) {
            return state;
        }
        __zoomPreviewPendingCommit = {
            blockId: state.controllerBlockId,
            oldValue: Number(state.zoomPosition) || 0,
            latestValue: safeZoomPosition,
            systemConfig,
            activeConfig,
            controller,
            blocks
        };
    } else {
        __zoomPreviewPendingCommit.latestValue = safeZoomPosition;
    }

    __zoomPreviewQueuedValue = safeZoomPosition;
    if (__zoomPreviewRafId === null) {
        __zoomPreviewRafId = window.requestAnimationFrame(() => {
            __zoomPreviewRafId = null;
            const queuedValue = __zoomPreviewQueuedValue;
            __zoomPreviewQueuedValue = null;
            if (!Number.isFinite(queuedValue)) return;
            __zoom_applyPreviewPosition(queuedValue as number);
        });
    }

    __zoom_schedulePreviewCommit();
    return {
        ...state,
        zoomPosition: safeZoomPosition
    };
}

function __zoom_flushPreviewCommit(): any {
    if (__zoomPreviewCommitTimer !== null) {
        try { window.clearTimeout(__zoomPreviewCommitTimer); } catch (_) {}
        __zoomPreviewCommitTimer = null;
    }

    if (__zoomPreviewRafId !== null) {
        try { window.cancelAnimationFrame(__zoomPreviewRafId); } catch (_) {}
        __zoomPreviewRafId = null;
        const queuedValue = __zoomPreviewQueuedValue;
        __zoomPreviewQueuedValue = null;
        if (Number.isFinite(queuedValue)) {
            __zoom_applyPreviewPosition(queuedValue as number);
        }
    }

    const pending = __zoomPreviewPendingCommit;
    __zoomPreviewPendingCommit = null;
    __zoomPreviewLastRenderAt = 0;
    try {
        (globalThis as any).__cooptZoomPreviewActive = false;
    } catch (_) {}
    try {
        const popup = w.popup3DWindow;
        if (popup && !popup.closed) {
            popup.__cooptZoomPreviewActive = false;
        }
    } catch (_) {}
    if (!pending || !pending.blockId) {
        __zoom_restoreRuntimePreviewConfig();
        return __zoom_collectState();
    }
    if (pending.oldValue === pending.latestValue) {
        __zoom_restoreRuntimePreviewConfig();
        return __zoom_collectState();
    }

    cooptApplyBlockValue(pending.blockId, 'parameters.zoomPosition', pending.oldValue, pending.latestValue);
    __zoom_restoreRuntimePreviewConfig();
    return __zoom_collectState();
}

function __zoom_updateSliderReadout(nextValue: number): void {
    const zoomValue = document.getElementById('design-intent-zoom-value');
    if (zoomValue) zoomValue.textContent = Number(nextValue || 0).toFixed(2);
}

function __zoom_getActiveConfigAndController(): { systemConfig: any; activeConfig: any; controller: any | null } {
        const systemConfig = loadSystemConfigurations();
        const activeConfig = systemConfig?.configurations?.find((c: any) => c.id === systemConfig?.activeConfigId)
                || systemConfig?.configurations?.[0]
                || null;
        const controller = Array.isArray(activeConfig?.blocks)
                ? activeConfig.blocks.find((block: any) => {
                        const type = String(block?.blockType ?? '').trim();
                        return type === 'ObjectSurface' || type === 'ObjectPlane';
                }) || null
                : null;
        return { systemConfig, activeConfig, controller };
}

function __zoom_getControllerLawText(params: any): string {
        const raw = String(params?.zoomGroupProfiles ?? '').trim();
        if (raw) return raw;
        const legacyA = String(params?.zoomGroupAProfile ?? '').trim();
        const legacyB = String(params?.zoomGroupBProfile ?? '').trim();
        const lines: string[] = [];
        if (legacyA) lines.push(`A=${legacyA}`);
        if (legacyB) lines.push(`B=${legacyB}`);
        return lines.join('\n');
}

function __zoom_parseLawGroupNames(rawValue: any): string[] {
        const text = String(rawValue ?? '').trim();
        if (!text) return [];
        const names: string[] = [];
        for (const line of text.split(/\r?\n|;/)) {
                const trimmed = String(line ?? '').trim();
                if (!trimmed) continue;
                const eqIndex = trimmed.indexOf('=');
                if (eqIndex <= 0) continue;
            const groupName = String(trimmed.slice(0, eqIndex)).trim();
            if (/^(?:const\s+|\$)[A-Za-z_][A-Za-z0-9_]*$/i.test(groupName)) continue;
                if (groupName && !names.includes(groupName)) names.push(groupName);
        }
        return names;
}

    function __zoom_getControllerLinkText(params: any): string {
        return String(params?.zoomLinkedGroupScales ?? '').trim();
    }

    function __zoom_parseLinkedGroupNames(rawValue: any): string[] {
        const text = String(rawValue ?? '').trim();
        if (!text) return [];
        const names: string[] = [];
        for (const line of text.split(/\r?\n|;/)) {
            const trimmed = String(line ?? '').trim();
            if (!trimmed) continue;
            const eqIndex = trimmed.indexOf('=');
            const groupName = String(eqIndex > 0 ? trimmed.slice(0, eqIndex) : trimmed).trim();
            if (!groupName || groupName === 'Fixed') continue;
            if (!names.includes(groupName)) names.push(groupName);
        }
        return names;
    }

    let __zoomPlotlyLoadPromise: Promise<void> | null = null;

    function __zoom_clearCompensationChart(target: HTMLElement): void {
        if (!target) return;
        try {
            if (window.Plotly && typeof window.Plotly.purge === 'function') {
                window.Plotly.purge(target);
            }
        } catch (_) {
            // Ignore Plotly cleanup failures and fall back to replacing contents.
        }
    }

    function __zoom_showChartPlaceholder(target: HTMLElement, text: string): void {
        if (!target) return;
        __zoom_clearCompensationChart(target);
        target.innerHTML = `<div class="design-intent-zoom-empty" style="padding: 14px;">${text}</div>`;
    }

    async function __zoom_ensurePlotlyLoaded(): Promise<void> {
        if (window.Plotly && typeof window.Plotly.newPlot === 'function') {
            return;
        }

        if (!__zoomPlotlyLoadPromise) {
            __zoomPlotlyLoadPromise = new Promise<void>((resolve, reject) => {
                const existing = document.querySelector('script[data-coopt-plotly="1"]') as HTMLScriptElement | null;
                if (existing) {
                    if (window.Plotly && typeof window.Plotly.newPlot === 'function') {
                        resolve();
                        return;
                    }
                    existing.addEventListener('load', () => resolve(), { once: true });
                    existing.addEventListener('error', () => reject(new Error('Failed to load Plotly')), { once: true });
                    return;
                }

                const script = document.createElement('script');
                script.src = 'https://cdn.plot.ly/plotly-2.32.0.min.js';
                script.async = true;
                script.setAttribute('data-coopt-plotly', '1');
                script.addEventListener('load', () => resolve(), { once: true });
                script.addEventListener('error', () => reject(new Error('Failed to load Plotly')), { once: true });
                document.head.appendChild(script);
            }).finally(() => {
                if (!(window.Plotly && typeof window.Plotly.newPlot === 'function')) {
                    __zoomPlotlyLoadPromise = null;
                }
            });
        }

        await __zoomPlotlyLoadPromise;
        if (!(window.Plotly && typeof window.Plotly.newPlot === 'function')) {
            throw new Error('Plotly is unavailable');
        }
    }

    async function __zoom_renderCompensationChart(target: HTMLElement, compensation: any): Promise<void> {
        if (!target) return;
        const samples = Array.isArray(compensation?.samples) ? compensation.samples : [];
        const finiteSamples = samples.filter((sample: any) => Number.isFinite(Number(sample?.focusShift)));
        if (finiteSamples.length === 0) {
            __zoom_showChartPlaceholder(target, 'No valid paraxial focus-shift samples.');
            return;
        }

        const renderToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        target.dataset.zoomPlotToken = renderToken;

        const values = finiteSamples.map((sample: any) => Number(sample.focusShift));
        let minY = Math.min(...values);
        let maxY = Math.max(...values);
        if (Math.abs(maxY - minY) <= 1e-9) {
            const pad = Math.abs(maxY) > 1e-6 ? Math.abs(maxY) * 0.15 : 0.1;
            minY -= pad;
            maxY += pad;
        }

        try {
            await __zoom_ensurePlotlyLoaded();
            if (target.dataset.zoomPlotToken !== renderToken) return;

            const isDarkMode = document.body.classList.contains('dark-mode');
            const xValues = finiteSamples.map((sample: any) => Number(sample.zoomPosition));
            const yValues = finiteSamples.map((sample: any) => Number(sample.focusShift));
            const collisionSamples = finiteSamples.filter((sample: any) => !!sample?.collision);
            const zeroCrossings = Array.isArray(compensation?.zeroCrossings) ? compensation.zeroCrossings : [];
            const traces: any[] = [
                {
                    x: xValues,
                    y: yValues,
                    type: 'scatter',
                    mode: 'lines+markers',
                    name: 'Focus shift',
                    line: { color: '#2563eb', width: 2.5 },
                    marker: { color: '#2563eb', size: 6 },
                    hovertemplate: 'x=%{x:.3f}<br>focus shift=%{y:.5f} mm<extra></extra>'
                }
            ];

            if (collisionSamples.length > 0) {
                traces.push({
                    x: collisionSamples.map((sample: any) => Number(sample.zoomPosition)),
                    y: collisionSamples.map((sample: any) => Number(sample.focusShift)),
                    type: 'scatter',
                    mode: 'markers',
                    name: 'Collision',
                    marker: { color: '#dc2626', size: 10, symbol: 'diamond' },
                    hovertemplate: 'x=%{x:.3f}<br>focus shift=%{y:.5f} mm<br>negative gap detected<extra></extra>'
                });
            }

            const shapes: any[] = [];
            if (minY <= 0 && maxY >= 0) {
                shapes.push({
                    type: 'line',
                    x0: 0,
                    x1: 1,
                    y0: 0,
                    y1: 0,
                    line: { color: '#94a3b8', width: 1, dash: 'dash' }
                });
            }
            for (const crossing of zeroCrossings) {
                const value = Number(crossing);
                if (!Number.isFinite(value)) continue;
                shapes.push({
                    type: 'line',
                    x0: value,
                    x1: value,
                    y0: minY,
                    y1: maxY,
                    line: { color: '#f97316', width: 1.25, dash: 'dot' }
                });
            }

            const layout = {
                margin: { l: 56, r: 20, t: 20, b: 44 },
                paper_bgcolor: isDarkMode ? 'rgba(15, 23, 42, 0)' : 'rgba(255,255,255,0)',
                plot_bgcolor: isDarkMode ? 'rgba(15, 23, 42, 0.32)' : 'rgba(248, 251, 255, 0.9)',
                showlegend: traces.length > 1,
                legend: {
                    orientation: 'h',
                    x: 0,
                    y: 1.15,
                    font: { size: 11, color: isDarkMode ? '#e2e8f0' : '#475569' }
                },
                font: { color: isDarkMode ? '#e2e8f0' : '#334155' },
                xaxis: {
                    title: 'Zoom position',
                    range: [0, 1],
                    tickformat: '.2f',
                    gridcolor: isDarkMode ? 'rgba(148, 163, 184, 0.16)' : 'rgba(148, 163, 184, 0.18)',
                    zeroline: false
                },
                yaxis: {
                    title: 'Focus shift [mm]',
                    range: [minY, maxY],
                    tickformat: '.4f',
                    gridcolor: isDarkMode ? 'rgba(148, 163, 184, 0.16)' : 'rgba(148, 163, 184, 0.18)',
                    zeroline: false
                },
                shapes,
                annotations: zeroCrossings.map((crossing: number) => ({
                    x: Number(crossing),
                    y: maxY,
                    yanchor: 'bottom',
                    text: '0-cross',
                    showarrow: false,
                    font: { size: 10, color: '#f97316' },
                    bgcolor: isDarkMode ? 'rgba(15, 23, 42, 0.72)' : 'rgba(255,255,255,0.85)'
                }))
            };
            const config = {
                responsive: true,
                displaylogo: false,
                displayModeBar: false
            };

            if (typeof window.Plotly.react === 'function') {
                await window.Plotly.react(target, traces, layout, config);
            } else {
                await window.Plotly.newPlot(target, traces, layout, config);
            }
            try { window.Plotly?.Plots?.resize?.(target); } catch (_) {}
        } catch (error: any) {
            if (target.dataset.zoomPlotToken !== renderToken) return;
            __zoom_showChartPlaceholder(target, `Plotly render failed: ${String(error?.message ?? error ?? 'Unknown error')}`);
        }
    }

function __zoom_collectState(): any {
        try {
                const { activeConfig, controller } = __zoom_getActiveConfigAndController();
                const blocks = Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
                if (!activeConfig || !controller) {
                        return {
                                available: false,
                                configName: String(activeConfig?.name ?? '').trim(),
                                zoomPosition: 0,
                                lawsText: '',
                                lawErrors: [],
                                linkedGroupsText: '',
                                linkedGroupNames: [],
                                compensationStroke: 0,
                                compensationSamples: 33,
                                compensation: null,
                                lawGroups: [],
                                groupNames: [],
                                controllerBlockId: ''
                        };
                }

                const params = (controller.parameters && typeof controller.parameters === 'object') ? controller.parameters : {};
                const zoomPositionRaw = Number(params.zoomPosition);
                const pendingPreviewValue = (__zoomPreviewPendingCommit && __zoomPreviewPendingCommit.blockId === String(controller?.blockId ?? '').trim())
                    ? __zoomPreviewPendingCommit.latestValue
                    : null;
                const zoomPosition = Number.isFinite(pendingPreviewValue)
                    ? Math.max(0, Math.min(1, Number(pendingPreviewValue)))
                    : (Number.isFinite(zoomPositionRaw) ? Math.max(0, Math.min(1, zoomPositionRaw)) : 0);
                const lawsText = __zoom_getControllerLawText(params) || 'A=0:0,1:0';
                const linkedGroupsText = __zoom_getControllerLinkText(params);
                const lawErrors = validateZoomLawDefinitions(blocks);
                const lawGroups = __zoom_parseLawGroupNames(lawsText);
                const linkedGroupNames = __zoom_parseLinkedGroupNames(linkedGroupsText);
                const compensationStrokeRaw = Number(params.zoomCompensationStroke);
                const compensationSamplesRaw = Math.floor(Number(params.zoomCompensationSamples));
                const groupNames: string[] = [];
                for (const block of blocks) {
                        const blockType = String(block?.blockType ?? '').trim();
                        if (!blockType || blockType === 'Gap' || blockType === 'AirGap' || blockType === 'ImageSurface' || blockType === 'ObjectSurface' || blockType === 'ObjectPlane') {
                                continue;
                        }
                        const blockParams = (block?.parameters && typeof block.parameters === 'object') ? block.parameters : null;
                        const groupName = String(blockParams?.zoomGroup ?? '').trim() || 'Fixed';
                        if (!groupNames.includes(groupName)) groupNames.push(groupName);
                }

                const compensation = evaluateZoomCompensation(blocks, {
                    sampleCount: Number.isFinite(compensationSamplesRaw) ? compensationSamplesRaw : 33
                });

                return {
                        available: true,
                        configName: String(activeConfig?.name ?? '').trim(),
                        zoomPosition,
                        lawsText,
                        lawErrors,
                    linkedGroupsText,
                    linkedGroupNames,
                    compensationStroke: Number.isFinite(compensationStrokeRaw) ? compensationStrokeRaw : 0,
                    compensationSamples: Number.isFinite(compensationSamplesRaw) ? compensationSamplesRaw : 33,
                    compensation,
                        lawGroups,
                        groupNames,
                        controllerBlockId: String(controller?.blockId ?? '').trim()
                };
        } catch (_) {
                return {
                        available: false,
                        configName: '',
                        zoomPosition: 0,
                        lawsText: '',
                        lawErrors: [],
                        linkedGroupsText: '',
                        linkedGroupNames: [],
                        compensationStroke: 0,
                        compensationSamples: 33,
                        compensation: null,
                        lawGroups: [],
                        groupNames: [],
                        controllerBlockId: ''
                };
        }
}

    function refreshZoomControlTab(): void {
        const configName = document.getElementById('design-intent-zoom-config-name');
        const zoomValue = document.getElementById('design-intent-zoom-value');
        const zoomSlider = document.getElementById('design-intent-zoom-slider') as HTMLInputElement | null;
        const groupChips = document.getElementById('design-intent-zoom-group-chips');
        const lawChips = document.getElementById('design-intent-zoom-law-chips');
        const linkedGroupsInput = document.getElementById('design-intent-zoom-linked-groups') as HTMLTextAreaElement | null;
        const compStrokeInput = document.getElementById('design-intent-zoom-comp-stroke') as HTMLInputElement | null;
        const compSamplesInput = document.getElementById('design-intent-zoom-comp-samples') as HTMLInputElement | null;
        const compSummary = document.getElementById('design-intent-zoom-comp-summary');
        const compAlert = document.getElementById('design-intent-zoom-comp-alert');
        const compChart = document.getElementById('design-intent-zoom-comp-chart');
        const lawError = document.getElementById('design-intent-zoom-law-error');
        const lawsInput = document.getElementById('design-intent-zoom-laws') as HTMLTextAreaElement | null;
        const emptyState = document.getElementById('design-intent-zoom-empty');
        const body = document.getElementById('design-intent-zoom-body');
        if (!configName || !zoomValue || !zoomSlider || !groupChips || !lawChips || !linkedGroupsInput || !compStrokeInput || !compSamplesInput || !compSummary || !compAlert || !compChart || !lawsInput || !emptyState || !body || !lawError) return;

        const renderChips = (target: HTMLElement, values: string[], prefix: string, className: string, emptyText: string) => {
            target.innerHTML = '';
            if (!Array.isArray(values) || values.length === 0) {
                const empty = document.createElement('span');
                empty.className = 'design-intent-zoom-empty-inline';
                empty.textContent = emptyText;
                target.appendChild(empty);
                return;
            }
            for (const value of values) {
                const chip = document.createElement('span');
                chip.className = className;
                chip.textContent = `${prefix}${value}`;
                target.appendChild(chip);
            }
        };

        const state = __zoom_collectState();
        if (!state || !state.available) {
                configName.textContent = 'No zoom controller on active config';
                zoomValue.textContent = '0.00';
                zoomSlider.value = '0';
                zoomSlider.disabled = true;
                lawsInput.value = '';
                lawsInput.disabled = true;
                linkedGroupsInput.value = '';
                linkedGroupsInput.disabled = true;
                compStrokeInput.value = '0';
                compStrokeInput.disabled = true;
                compSamplesInput.value = '33';
                compSamplesInput.disabled = true;
                compSummary.textContent = '';
                compAlert.textContent = '';
                compAlert.style.display = 'none';
                compChart.innerHTML = '<div class="design-intent-zoom-empty" style="padding: 14px;">No compensation data.</div>';
                body.style.display = 'none';
                emptyState.style.display = '';
                lawError.textContent = '';
                lawError.style.display = 'none';
                renderChips(groupChips, [], 'ZG ', 'design-intent-zoom-chip design-intent-zoom-chip-group', 'No zoom groups');
                renderChips(lawChips, [], 'Law ', 'design-intent-zoom-chip design-intent-zoom-chip-law', 'No zoom laws');
                return;
        }

        configName.textContent = state.configName || 'Active config';
        zoomValue.textContent = Number(state.zoomPosition || 0).toFixed(2);
        zoomSlider.value = String(state.zoomPosition || 0);
        zoomSlider.disabled = false;
        if (document.activeElement !== lawsInput) {
            lawsInput.value = state.lawsText || '';
        }
        if (document.activeElement !== linkedGroupsInput) {
            linkedGroupsInput.value = state.linkedGroupsText || '';
        }
        lawsInput.disabled = false;
        linkedGroupsInput.disabled = false;
        compStrokeInput.disabled = false;
        compSamplesInput.disabled = false;
        compStrokeInput.value = String(Number(state.compensationStroke || 0));
        compSamplesInput.value = String(Number(state.compensationSamples || 33));
        body.style.display = '';
        emptyState.style.display = 'none';
        renderChips(groupChips, state.groupNames || [], 'ZG ', 'design-intent-zoom-chip design-intent-zoom-chip-group', 'No zoom groups');
        renderChips(lawChips, state.lawGroups || [], 'Law ', 'design-intent-zoom-chip design-intent-zoom-chip-law', 'No zoom laws');
        if (Array.isArray(state.lawErrors) && state.lawErrors.length > 0) {
            lawError.textContent = state.lawErrors[0];
            lawError.style.display = '';
        } else {
            lawError.textContent = '';
            lawError.style.display = 'none';
        }

        const compensation = state.compensation;
        const linkedGroupNames = Array.isArray(state.linkedGroupNames) ? state.linkedGroupNames : [];
        const zeroCrossings = Array.isArray(compensation?.zeroCrossings) ? compensation.zeroCrossings : [];
        const focusMin = Number(compensation?.minFocusShift);
        const focusMax = Number(compensation?.maxFocusShift);
        compSummary.textContent = linkedGroupNames.length > 0
            ? `Linked groups: ${linkedGroupNames.join(', ')} | stroke ${Number(state.compensationStroke || 0).toFixed(2)} mm | zero crossings ${zeroCrossings.length}`
            : 'No optical compensation link is defined yet. Enter Group=scale lines, set the stroke in mm, click Apply Links, then use this chart to reduce the focus-shift span.';

        const warnings: string[] = [];
        if (Array.isArray(compensation?.collisionPositions) && compensation.collisionPositions.length > 0) {
            warnings.push(`Motion limit collision detected near x=${Number(compensation.collisionPositions[0]).toFixed(3)}.`);
        }
        if (Number.isFinite(focusMin) && Number.isFinite(focusMax)) {
            warnings.push(`Focus shift span ${focusMin.toFixed(4)} to ${focusMax.toFixed(4)} mm.`);
        }
        if (warnings.length > 0) {
            compAlert.textContent = warnings.join(' ');
            compAlert.style.display = '';
        } else {
            compAlert.textContent = '';
            compAlert.style.display = 'none';
        }
        __zoom_renderCompensationChart(compChart, compensation);
    }

function __zoom_setControllerValue(
    field: 'zoomPosition' | 'zoomGroupProfiles' | 'zoomLinkedGroupScales' | 'zoomCompensationStroke' | 'zoomCompensationSamples',
    nextValue: any
): any {
    if (field === 'zoomPosition') {
        return __zoom_previewSetPosition(nextValue);
    }
        const state = __zoom_collectState();
        if (!state.available || !state.controllerBlockId) return state;
    const oldValue = state.lawsText;
        cooptApplyBlockValue(state.controllerBlockId, `parameters.${field}`, oldValue, nextValue);
        return __zoom_collectState();
}

    function setupZoomControlTab(): void {
        const zoomSlider = document.getElementById('design-intent-zoom-slider') as HTMLInputElement | null;
        const lawsInput = document.getElementById('design-intent-zoom-laws') as HTMLTextAreaElement | null;
        const applyLawsButton = document.getElementById('design-intent-zoom-apply-laws');
        const linkedGroupsInput = document.getElementById('design-intent-zoom-linked-groups') as HTMLTextAreaElement | null;
        const compStrokeInput = document.getElementById('design-intent-zoom-comp-stroke') as HTMLInputElement | null;
        const compSamplesInput = document.getElementById('design-intent-zoom-comp-samples') as HTMLInputElement | null;
        const applyCompButton = document.getElementById('design-intent-zoom-apply-comp');
        if (!zoomSlider || !lawsInput || !applyLawsButton || !linkedGroupsInput || !compStrokeInput || !compSamplesInput || !applyCompButton) return;
        if (!zoomSlider.dataset.zoomControlBound) {
            zoomSlider.dataset.zoomControlBound = '1';
            zoomSlider.addEventListener('input', () => {
                const value = Number.parseFloat(zoomSlider.value);
                if (!Number.isFinite(value)) return;
                __zoom_setControllerValue('zoomPosition', value);
                __zoom_updateSliderReadout(value);
            });
            zoomSlider.addEventListener('change', () => {
                __zoom_flushPreviewCommit();
                refreshZoomControlTab();
            });
        }
        if (!applyLawsButton.dataset.zoomControlBound) {
            applyLawsButton.dataset.zoomControlBound = '1';
            applyLawsButton.addEventListener('click', () => {
                __zoom_setControllerValue('zoomGroupProfiles', lawsInput.value);
                refreshZoomControlTab();
            });
        }
        if (!applyCompButton.dataset.zoomControlBound) {
            applyCompButton.dataset.zoomControlBound = '1';
            applyCompButton.addEventListener('click', () => {
                const strokeValue = Number.parseFloat(compStrokeInput.value);
                const sampleValue = Math.round(Number.parseFloat(compSamplesInput.value));
                __zoom_setControllerValue('zoomLinkedGroupScales', linkedGroupsInput.value);
                __zoom_setControllerValue('zoomCompensationStroke', Number.isFinite(strokeValue) ? strokeValue : 0);
                __zoom_setControllerValue('zoomCompensationSamples', Number.isFinite(sampleValue) ? sampleValue : 33);
                refreshZoomControlTab();
            });
        }
        refreshZoomControlTab();
    }

function openZoomControlWindow(): void {
        try {
                const existing = w.__cooptZoomControlWindow;
                if (existing && !existing.closed) {
                        try { existing.focus(); } catch (_) {}
                        try { if (typeof existing.__cooptRefresh === 'function') existing.__cooptRefresh(); } catch (_) {}
                        return;
                }
        } catch (_) {}

        const popup = window.open('', 'coopt_zoom_control', 'popup=yes,width=420,height=360');
        if (!popup) {
                alert('Popup was blocked. Please allow popups for this site and try again.');
                return;
        }

        try { w.__cooptZoomControlWindow = popup; } catch (_) {}

        popup.document.open();
        popup.document.write(`<!doctype html>
<html>
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Zoom Control</title>
    <style>
        html, body { margin: 0; padding: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #111827; }
        .wrap { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
        .card { background: #fff; border: 1px solid rgba(17,24,39,0.12); border-radius: 10px; padding: 12px; box-shadow: 0 8px 20px rgba(0,0,0,0.06); }
        .title { font-size: 18px; font-weight: 700; margin: 0 0 4px; }
        .meta { font-size: 12px; color: #4b5563; }
        .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .value { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .chips { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
        .chip { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
        .chip-group { background: #eef2ff; color: #3730a3; }
        .chip-law { background: #ecfeff; color: #155e75; }
        .label { display: block; font-size: 12px; font-weight: 600; color: #374151; margin-bottom: 6px; }
        textarea { width: 100%; min-height: 120px; resize: vertical; box-sizing: border-box; padding: 8px 10px; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; border-radius: 8px; border: 1px solid #d1d5db; }
        input[type="range"] { width: 100%; }
        .actions { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
        button { height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; }
        button.primary { background: #111827; color: #fff; border-color: #111827; }
        .hint { font-size: 11px; color: #6b7280; line-height: 1.4; }
        .empty { color: #6b7280; font-size: 12px; }
        .error { display: none; margin-top: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid #fecaca; background: #fff1f2; color: #991b1b; font-size: 12px; line-height: 1.4; }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="card">
            <div class="title">Zoom Control</div>
            <div id="configName" class="meta">Active config</div>
            <div class="row" style="margin-top: 10px;">
                <div id="zoomValue" class="value">0.00</div>
                <button id="refreshBtn" type="button">Refresh</button>
            </div>
            <input id="zoomSlider" type="range" min="0" max="1" step="0.001" value="0" />
            <div class="hint">Use this window to drive zoomPosition. Render and tables refresh from the active configuration.</div>
            <div id="groupChips" class="chips"></div>
        </div>
        <div class="card">
            <label class="label" for="lawsInput">Zoom Laws</label>
            <textarea id="lawsInput" spellcheck="false"></textarea>
            <div id="lawError" class="error"></div>
            <div class="actions" style="margin-top: 8px;">
                <div id="lawChips" class="chips" style="margin-top: 0;"></div>
                <button id="applyLawsBtn" type="button" class="primary">Apply Laws</button>
            </div>
        </div>
    </div>

    <script>
        (function() {
            var slider = document.getElementById('zoomSlider');
            var zoomValue = document.getElementById('zoomValue');
            var configName = document.getElementById('configName');
            var groupChips = document.getElementById('groupChips');
            var lawChips = document.getElementById('lawChips');
            var lawError = document.getElementById('lawError');
            var lawsInput = document.getElementById('lawsInput');
            var applyLawsBtn = document.getElementById('applyLawsBtn');
            var refreshBtn = document.getElementById('refreshBtn');
            var suspendTextSync = false;

            function getApi() {
                try {
                    return window.opener && window.opener.__cooptZoomControlApi ? window.opener.__cooptZoomControlApi : null;
                } catch (_) {
                    return null;
                }
            }

            function renderChips(target, values, className, prefix) {
                target.innerHTML = '';
                if (!Array.isArray(values) || values.length === 0) {
                    var empty = document.createElement('span');
                    empty.className = 'empty';
                    empty.textContent = prefix === 'Law ' ? 'No zoom laws' : 'No zoom groups';
                    target.appendChild(empty);
                    return;
                }
                values.forEach(function(value) {
                    var chip = document.createElement('span');
                    chip.className = 'chip ' + className;
                    chip.textContent = prefix + value;
                    target.appendChild(chip);
                });
            }

            function refresh() {
                var api = getApi();
                if (!api || typeof api.getState !== 'function') return;
                var state = api.getState();
                if (!state || !state.available) {
                    configName.textContent = 'No zoom controller on active config';
                    zoomValue.textContent = '0.00';
                    slider.value = '0';
                    lawError.textContent = '';
                    lawError.style.display = 'none';
                    renderChips(groupChips, [], 'chip-group', 'ZG ');
                    renderChips(lawChips, [], 'chip-law', 'Law ');
                    if (!suspendTextSync) lawsInput.value = '';
                    return;
                }

                configName.textContent = state.configName || 'Active config';
                zoomValue.textContent = Number(state.zoomPosition || 0).toFixed(2);
                slider.value = String(state.zoomPosition || 0);
                renderChips(groupChips, state.groupNames || [], 'chip-group', 'ZG ');
                renderChips(lawChips, state.lawGroups || [], 'chip-law', 'Law ');
                if (Array.isArray(state.lawErrors) && state.lawErrors.length > 0) {
                    lawError.textContent = state.lawErrors[0];
                    lawError.style.display = '';
                } else {
                    lawError.textContent = '';
                    lawError.style.display = 'none';
                }
                if (!suspendTextSync && document.activeElement !== lawsInput) {
                    lawsInput.value = state.lawsText || '';
                }
            }

            slider.addEventListener('input', function() {
                var api = getApi();
                if (!api || typeof api.setZoomPosition !== 'function') return;
                var value = Number.parseFloat(slider.value);
                if (!Number.isFinite(value)) return;
                api.setZoomPosition(value);
                zoomValue.textContent = Number(value || 0).toFixed(2);
            });

            slider.addEventListener('change', function() {
                var api = getApi();
                if (!api || typeof api.commitZoomPosition !== 'function') {
                    refresh();
                    return;
                }
                api.commitZoomPosition();
                refresh();
            });

            lawsInput.addEventListener('focus', function() {
                suspendTextSync = true;
            });
            lawsInput.addEventListener('blur', function() {
                suspendTextSync = false;
            });

            applyLawsBtn.addEventListener('click', function() {
                var api = getApi();
                if (!api || typeof api.setZoomGroupProfiles !== 'function') return;
                api.setZoomGroupProfiles(lawsInput.value);
                suspendTextSync = false;
                refresh();
            });

            refreshBtn.addEventListener('click', refresh);
            window.__cooptRefresh = refresh;
            window.addEventListener('focus', refresh);
            window.setInterval(refresh, 500);
            refresh();
        })();
    </script>
</body>
</html>`);
        popup.document.close();
}

try {
        w.__cooptZoomControlApi = {
                getState: () => __zoom_collectState(),
                setZoomPosition: (value: any) => __zoom_setControllerValue('zoomPosition', value),
            commitZoomPosition: () => __zoom_flushPreviewCommit(),
                setZoomGroupProfiles: (value: any) => __zoom_setControllerValue('zoomGroupProfiles', value),
                open: () => openZoomControlWindow()
        };
        w.__cooptOpenZoomControlWindow = openZoomControlWindow;
} catch (_) {}

function renderBlockInspector(summary: any[], groups: any, blockById: Map<string, any> | null = null, blocksInOrder: any[] | null = null): void {
    const container = document.getElementById('block-inspector');
    if (!container) return;

    __cooptBlockInspectorLastSummary = Array.isArray(summary) ? summary : [];
    __cooptBlockInspectorLastGroups = groups || {};
    __cooptBlockInspectorLastBlockById = blockById instanceof Map ? blockById : null;
    __cooptBlockInspectorLastBlocksInOrder = Array.isArray(blocksInOrder) ? blocksInOrder : null;

    container.innerHTML = '';
    syncDesignIntentQuickEditorToggle();
    const activeCfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
    const maxImageHeightTargetMm = __cooptGetMaxImageHeightTargetMmFromObjectRows(Array.isArray(activeCfg?.object) ? activeCfg.object : []);

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

    const quickEditorEnabled = readDesignIntentQuickEditorEnabled();

    const isLogicalDesignIntentSurfaceRow = (row: any) => {
        if (!row || typeof row !== 'object') return false;
        const rowBlockType = String(row?._blockType ?? row?.blockType ?? '').trim().toLowerCase();
        const rowSurfaceRole = String(row?._surfaceRole ?? row?.surfaceRole ?? '').trim().toLowerCase();
        if (rowBlockType === 'gap' || rowBlockType === 'airgap' || rowBlockType === 'air gap') return false;
        if (rowBlockType === 'coordtrans' || rowBlockType === 'coord trans') return false;
        if (rowBlockType === 'objectsurface' || rowBlockType === 'objectplane' || rowBlockType === 'object') return false;
        if ((rowBlockType === 'paraxial' || rowBlockType === 'thinlens') && rowSurfaceRole === 'back') return false;
        return true;
    };

    const getLogicalSurfaceCountForBlock = (blockLike: any) => {
        const blockId = String(blockLike?.blockId ?? '').trim();
        const range = blockId ? surfRangeByBlockId.get(blockId) : null;
        if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
            return Math.max(0, (range.max - range.min) + 1);
        }

        const blockType = String(blockLike?.blockType ?? '').trim();
        if (blockType === 'Paraxial' || blockType === 'ThinLens') return 1;

        const n = Number(blockLike?.surfaceCount ?? 0);
        return Number.isFinite(n) ? n : 0;
    };

    // Compute per-block surface index ranges using the same logical numbering as Spot Diagram.
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
                if (!isLogicalDesignIntentSurfaceRow(r)) continue;
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
                const count = getLogicalSurfaceCountForBlock(b);
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

    const unifiedLensToneTypes = new Set(['lens', 'doublet', 'triplet']);
    const buildBlockInspectorLabelText = (blockLike: any) => {
        const rawId = String(blockLike?.blockId ?? '(none)');
        const label = displayLabelByBlockId.get(rawId) || formatSingletonBlockLabel(blockLike?.blockType, rawId);
        const bt = String(blockLike?.blockType ?? '').trim();
        if (bt === 'ObjectSurface' || bt === 'ObjectPlane') {
            return `${label} → Surf 0`;
        }
        const range = surfRangeByBlockId.get(String(blockLike?.blockId ?? '').trim());
        if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
            const surfText = (range.min === range.max)
                ? `Surf ${range.min}`
                : `Surf ${range.min}–${range.max}`;
            return `${label} → ${surfText}`;
        }
        return label;
    };

    const unifiedLensBadgeWidthCh = (() => {
        let maxChars = 0;
        for (const item of list) {
            const rawType = String(item?.blockType ?? '').trim();
            const normalized = (() => {
                const t = (rawType === 'ObjectPlane') ? 'ObjectSurface' : rawType;
                if (t === 'PositiveLens' || t === 'Paraxial') return 'lens';
                if (t === 'AirGap') return 'gap';
                return String(t || 'unknown').trim().toLowerCase();
            })();
            if (!unifiedLensToneTypes.has(normalized)) continue;
            maxChars = Math.max(maxChars, buildBlockInspectorLabelText(item).length);
        }
        return Math.max(14, maxChars + 1);
    })();

    const getZoomGroupLabel = (blockLike: any): string => {
        if (!blockLike || typeof blockLike !== 'object') return '';
        const blockType = String(blockLike?.blockType ?? '').trim();
        if (blockType === 'Gap' || blockType === 'AirGap' || blockType === 'ImageSurface' || blockType === 'ObjectSurface' || blockType === 'ObjectPlane') {
            return '';
        }
        const params = (blockLike.parameters && typeof blockLike.parameters === 'object') ? blockLike.parameters : null;
        const raw = String(params?.zoomGroup ?? '').trim();
        return raw || 'Fixed';
    };

    const getZoomLawGroupNames = (blockLike: any): string[] => {
        if (!blockLike || typeof blockLike !== 'object') return [];
        const blockType = String(blockLike?.blockType ?? '').trim();
        if (blockType !== 'ObjectSurface' && blockType !== 'ObjectPlane') return [];
        const params = (blockLike.parameters && typeof blockLike.parameters === 'object') ? blockLike.parameters : null;
        const raw = String(params?.zoomGroupProfiles ?? '').trim();
        if (!raw) return [];
        const names: string[] = [];
        const lines = raw.split(/\r?\n|;/);
        for (const line of lines) {
            const text = String(line ?? '').trim();
            if (!text) continue;
            const eqIndex = text.indexOf('=');
            if (eqIndex <= 0) continue;
            const groupName = String(text.slice(0, eqIndex)).trim();
            if (!groupName) continue;
            if (!names.includes(groupName)) names.push(groupName);
        }
        return names;
    };

    const getZoomPositionSummary = (blockLike: any): string => {
        if (!blockLike || typeof blockLike !== 'object') return '';
        const blockType = String(blockLike?.blockType ?? '').trim();
        if (blockType !== 'ObjectSurface' && blockType !== 'ObjectPlane') return '';
        const params = (blockLike.parameters && typeof blockLike.parameters === 'object') ? blockLike.parameters : null;
        const value = Number(params?.zoomPosition);
        if (!Number.isFinite(value)) return 'Zoom x=0.00';
        return `Zoom x=${value.toFixed(2)}`;
    };

    const getGapBoundaryLabel = (blockLike: any): string => {
        const blockType = String(blockLike?.blockType ?? '').trim();
        if (blockType !== 'Gap' && blockType !== 'AirGap') return '';

        const sourceBlocks = Array.isArray(blocksInOrder) && blocksInOrder.length > 0 ? blocksInOrder : list;
        const currentId = String(blockLike?.blockId ?? '').trim();
        if (!currentId || !Array.isArray(sourceBlocks) || sourceBlocks.length === 0) return '';

        const currentIndex = sourceBlocks.findIndex((candidate: any) => String(candidate?.blockId ?? '').trim() === currentId);
        if (currentIndex < 0) return '';

        const getAnchorGroupAt = (startIndex: number, direction: -1 | 1): string => {
            for (let index = startIndex; index >= 0 && index < sourceBlocks.length; index += direction) {
                const candidate = sourceBlocks[index];
                const candidateType = String(candidate?.blockType ?? '').trim();
                if (!candidateType || candidateType === 'Gap' || candidateType === 'AirGap' || candidateType === 'ImageSurface') continue;
                if (candidateType === 'ObjectSurface' || candidateType === 'ObjectPlane') return 'Fixed';
                return getZoomGroupLabel(candidate) || 'Fixed';
            }
            return 'Fixed';
        };

        const prevGroup = getAnchorGroupAt(currentIndex - 1, -1);
        const nextGroup = getAnchorGroupAt(currentIndex + 1, 1);
        return `${prevGroup}→${nextGroup}`;
    };

    const getGapZoomChipLabel = (blockLike: any): string => {
        const boundary = String(getGapBoundaryLabel(blockLike) || '').trim();
        if (!boundary) return '';
        const parts = boundary.split(/->|→/).map((part) => String(part ?? '').trim()).filter(Boolean);
        if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
        return boundary;
    };

    const createSummaryChip = (text: string, kind: 'group' | 'controller' | 'gap'): HTMLElement => {
        const chip = document.createElement('span');
        chip.className = `block-inspector-summary-chip block-inspector-summary-chip-${kind}`;
        chip.textContent = text;
        return chip;
    };

    const readPathValue = (target: any, path: string): any => {
        if (!target || typeof target !== 'object') return undefined;
        const parts = String(path || '').split('.').filter(Boolean);
        let cursor = target;
        for (const part of parts) {
            if (!cursor || typeof cursor !== 'object') return undefined;
            cursor = cursor[part];
        }
        return cursor;
    };

    const stopRowToggle = (el: HTMLElement): void => {
        const stopper = (event: Event) => {
            try { event.stopPropagation(); } catch (_) {}
        };
        el.addEventListener('click', stopper);
        el.addEventListener('mousedown', stopper);
        el.addEventListener('keydown', stopper);
    };

    const styleQuickInput = (el: HTMLInputElement | HTMLSelectElement, widthPx: number): void => {
        const dark = document.body.classList.contains('dark-mode');
        el.className = 'block-inspector-quick-input';
        el.style.width = `${widthPx}px`;
        el.style.minWidth = `${widthPx}px`;
        el.style.height = '24px';
        el.style.boxSizing = 'border-box';
        el.style.fontSize = '11px';
        el.style.padding = '2px 6px';
        el.style.borderRadius = '4px';
        el.style.border = dark ? '1px solid #4b5563' : '1px solid #d0d7de';
        el.style.background = dark ? '#111827' : '#ffffff';
        el.style.color = dark ? '#f9fafb' : '#111827';
    };

    const createQuickFieldShell = (label: string): { wrapper: HTMLSpanElement; content: HTMLSpanElement } => {
        const wrapper = document.createElement('span');
        wrapper.className = 'block-inspector-quick-field';
        const tag = document.createElement('span');
        tag.className = 'block-inspector-quick-label';
        tag.textContent = label;
        const content = document.createElement('span');
        content.className = 'block-inspector-quick-content';
        wrapper.appendChild(tag);
        wrapper.appendChild(content);
        return { wrapper, content };
    };

    const openQuickGlassPicker = (results: any[], onPick: (glass: any) => void): void => {
        if (!Array.isArray(results) || results.length === 0) {
            alert('No glasses found in database.');
            return;
        }
        const dark = document.body.classList.contains('dark-mode');
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.background = 'rgba(0, 0, 0, 0.45)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '9999';

        const dialog = document.createElement('div');
        dialog.style.width = 'min(520px, calc(100vw - 32px))';
        dialog.style.maxHeight = '70vh';
        dialog.style.overflow = 'auto';
        dialog.style.borderRadius = '10px';
        dialog.style.padding = '14px';
        dialog.style.background = dark ? '#111827' : '#ffffff';
        dialog.style.boxShadow = '0 20px 50px rgba(0, 0, 0, 0.25)';

        const title = document.createElement('div');
        title.textContent = 'Select Glass';
        title.style.fontSize = '13px';
        title.style.fontWeight = '600';
        title.style.marginBottom = '10px';
        title.style.color = dark ? '#f9fafb' : '#111827';
        dialog.appendChild(title);

        const listEl = document.createElement('div');
        listEl.style.display = 'flex';
        listEl.style.flexDirection = 'column';
        listEl.style.gap = '6px';
        results.slice(0, 12).forEach((glass: any, index: number) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.style.textAlign = 'left';
            item.style.padding = '8px 10px';
            item.style.borderRadius = '6px';
            item.style.border = dark ? '1px solid #374151' : '1px solid #e5e7eb';
            item.style.background = dark ? '#1f2937' : '#f8fafc';
            item.style.color = dark ? '#f9fafb' : '#111827';
            item.style.cursor = 'pointer';
            item.style.fontSize = '12px';
            item.textContent = `${index + 1}. ${glass.name} [${glass.manufacturer || 'Unknown'}] (nd=${Number(glass.nd).toFixed(4)}, vd=${Number(glass.vd).toFixed(1)})`;
            item.onclick = (event) => {
                try { event.preventDefault(); } catch (_) {}
                try { event.stopPropagation(); } catch (_) {}
                try { onPick(glass); } catch (_) {}
                try { document.body.removeChild(overlay); } catch (_) {}
            };
            listEl.appendChild(item);
        });
        dialog.appendChild(listEl);

        overlay.onclick = (event) => {
            if (event.target === overlay) {
                try { document.body.removeChild(overlay); } catch (_) {}
            }
        };
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
    };

    const openQuickOptionMenu = (
        anchor: HTMLElement,
        title: string,
        options: string[],
        currentValue: string,
        onPick: (value: string) => void
    ): void => {
        const dark = document.body.classList.contains('dark-mode');
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '9999';
        overlay.style.background = 'transparent';

        const menu = document.createElement('div');
        menu.className = 'block-inspector-chip-menu';
        menu.style.position = 'fixed';
        menu.style.minWidth = '120px';
        menu.style.maxWidth = '220px';
        menu.style.display = 'flex';
        menu.style.flexDirection = 'column';
        menu.style.padding = '6px';
        menu.style.borderRadius = '10px';
        menu.style.border = dark ? '1px solid #374151' : '1px solid #d0d7de';
        menu.style.background = dark ? '#111827' : '#ffffff';
        menu.style.boxShadow = '0 18px 40px rgba(0, 0, 0, 0.18)';

        const rect = anchor.getBoundingClientRect();
        const viewportPadding = 8;
        const menuGap = 6;
        const estimatedMenuHeight = Math.min(320, 36 + options.length * 34);
        const availableBelow = Math.max(120, window.innerHeight - rect.bottom - menuGap - viewportPadding);
        const availableAbove = Math.max(120, rect.top - menuGap - viewportPadding);
        const shouldOpenAbove = availableBelow < Math.min(estimatedMenuHeight, 220) && availableAbove > availableBelow;
        const maxMenuHeight = Math.max(120, Math.min(320, shouldOpenAbove ? availableAbove : availableBelow));

        menu.style.left = `${Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - 240))}px`;
        menu.style.maxHeight = `${maxMenuHeight}px`;
        menu.style.top = shouldOpenAbove
            ? `${Math.max(viewportPadding, rect.top - menuGap - maxMenuHeight)}px`
            : `${Math.min(window.innerHeight - viewportPadding - maxMenuHeight, rect.bottom + menuGap)}px`;

        const titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.fontSize = '11px';
        titleEl.style.fontWeight = '600';
        titleEl.style.padding = '4px 6px 8px';
        titleEl.style.color = dark ? '#d1d5db' : '#4b5563';
        menu.appendChild(titleEl);

        const list = document.createElement('div');
        list.style.display = 'flex';
        list.style.flexDirection = 'column';
        list.style.gap = '2px';
        list.style.minHeight = '0';
        list.style.overflowY = 'auto';
        list.style.overflowX = 'hidden';
        list.style.paddingRight = '2px';

        options.forEach((optionValue) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'block-inspector-chip-menu-item';
            btn.textContent = optionValue;
            btn.style.textAlign = 'left';
            btn.style.padding = '7px 10px';
            btn.style.border = 'none';
            btn.style.borderRadius = '7px';
            btn.style.background = optionValue === currentValue
                ? (dark ? '#1d4ed8' : '#dbeafe')
                : 'transparent';
            btn.style.color = optionValue === currentValue
                ? (dark ? '#eff6ff' : '#1d4ed8')
                : (dark ? '#f9fafb' : '#111827');
            btn.style.cursor = 'pointer';
            btn.onclick = (event) => {
                try { event.preventDefault(); } catch (_) {}
                try { event.stopPropagation(); } catch (_) {}
                try { onPick(optionValue); } catch (_) {}
                try { document.body.removeChild(overlay); } catch (_) {}
            };
            list.appendChild(btn);
        });

        menu.appendChild(list);
        overlay.appendChild(menu);
        overlay.onclick = (event) => {
            if (event.target === overlay) {
                try { document.body.removeChild(overlay); } catch (_) {}
            }
        };
        document.body.appendChild(overlay);
    };

    const createQuickEditor = (blockLike: any): HTMLElement | null => {
        if (!blockLike || typeof blockLike !== 'object') return null;
        const blockType = String(blockLike?.blockType ?? '').trim();
        const params = (blockLike.parameters && typeof blockLike.parameters === 'object') ? blockLike.parameters : {};
        const aperture = (blockLike.aperture && typeof blockLike.aperture === 'object') ? blockLike.aperture : {};
        const blockId = String(blockLike?.blockId ?? '').trim();
        if (!blockId) return null;

        const root = document.createElement('div');
        root.className = 'block-inspector-quick-editor';
        stopRowToggle(root);

        const createQuickRow = (): HTMLDivElement => {
            const row = document.createElement('div');
            row.className = 'block-inspector-quick-editor-row';
            stopRowToggle(row);
            return row;
        };

        const appendTextField = (label: string, path: string, currentValue: any, widthPx: number, target: HTMLElement = root) => {
            const shell = createQuickFieldShell(label);
            const input = document.createElement('input');
            input.type = 'text';
            input.value = currentValue === undefined || currentValue === null ? '' : String(currentValue);
            input.placeholder = label;
            styleQuickInput(input, widthPx);
            const commit = () => {
                const normalized = cooptNormalizeQuickInputValue(input.value, currentValue, path);
                if (!normalized.valid) {
                    input.value = currentValue === undefined || currentValue === null ? '' : String(currentValue);
                    return;
                }
                const nextValue = normalized.value;
                if (nextValue !== currentValue) {
                    cooptApplyBlockValue(blockId, path, currentValue, nextValue);
                }
            };
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    try { event.preventDefault(); } catch (_) {}
                    commit();
                }
            });
            input.addEventListener('blur', commit);
            stopRowToggle(input);
            shell.content.appendChild(input);
            target.appendChild(shell.wrapper);
        };

        const appendSpacerField = (label: string, widthPx: number, target: HTMLElement = root) => {
            const shell = createQuickFieldShell(label);
            shell.wrapper.style.visibility = 'hidden';
            shell.wrapper.style.pointerEvents = 'none';
            const input = document.createElement('input');
            input.type = 'text';
            input.tabIndex = -1;
            styleQuickInput(input, widthPx);
            shell.content.appendChild(input);
            target.appendChild(shell.wrapper);
        };

        const appendSelectField = (label: string, path: string, currentValue: any, options: string[], widthPx: number, target: HTMLElement = root) => {
            const shell = createQuickFieldShell(label);
            const select = document.createElement('select');
            styleQuickInput(select, widthPx);
            const currentText = String(currentValue ?? '').trim() || options[0] || '';
            const items = options.includes(currentText) ? options : [currentText, ...options.filter((item) => item !== currentText)];
            for (const item of items) {
                const option = document.createElement('option');
                option.value = item;
                option.textContent = item;
                if (item === currentText) option.selected = true;
                select.appendChild(option);
            }
            select.addEventListener('change', () => {
                const nextValue = select.value;
                if (nextValue !== currentValue) {
                    cooptApplyBlockValue(blockId, path, currentValue, nextValue);
                }
            });
            stopRowToggle(select);
            shell.content.appendChild(select);
            target.appendChild(shell.wrapper);
        };

        const appendMaterialField = (
            materialPath: string,
            materialValue: any,
            abbePath: string | null,
            abbeValue: any,
            label: string = 'G',
            target: HTMLElement = root
        ) => {
            const shell = createQuickFieldShell(label);
            const group = document.createElement('span');
            group.className = 'block-inspector-quick-material';

            const applyGlassDerivedFields = (nextMaterialValue: any, selectedGlass?: any) => {
                const glass = (selectedGlass && typeof selectedGlass === 'object')
                    ? selectedGlass
                    : getGlassDataWithSellmeier(String(nextMaterialValue ?? '').trim());
                if (!glass) return;

                const rindexPath = materialPath.replace(/material/i, 'rindex');
                if (rindexPath !== materialPath && Number.isFinite(Number(glass.nd))) {
                    try {
                        cooptApplyBlockValue(blockId, rindexPath, undefined, String(glass.nd));
                    } catch (_) {}
                }

                if (abbePath && Number.isFinite(Number(glass.vd))) {
                    try {
                        cooptApplyBlockValue(blockId, abbePath, abbeValue, String(glass.vd));
                    } catch (_) {}
                }
            };

            const input = document.createElement('input');
            input.type = 'text';
            input.value = materialValue === undefined || materialValue === null ? '' : String(materialValue);
            input.placeholder = 'Glass';
            styleQuickInput(input, 96);
            const commitMaterial = () => {
                const normalized = cooptNormalizeQuickInputValue(input.value, materialValue, materialPath);
                if (!normalized.valid) {
                    input.value = materialValue === undefined || materialValue === null ? '' : String(materialValue);
                    return;
                }
                const nextValue = normalized.value;
                if (nextValue !== materialValue) {
                    cooptApplyBlockValue(blockId, materialPath, materialValue, nextValue);
                    applyGlassDerivedFields(nextValue);
                }
            };
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    try { event.preventDefault(); } catch (_) {}
                    commitMaterial();
                }
            });
            input.addEventListener('blur', commitMaterial);
            stopRowToggle(input);
            group.appendChild(input);

            const applyGlass = (glass: any) => {
                if (!glass || !glass.name) return;
                input.value = String(glass.name);
                const nextMaterial = cooptNormalizeInputValue(String(glass.name), materialValue);
                if (nextMaterial !== materialValue) {
                    cooptApplyBlockValue(blockId, materialPath, materialValue, nextMaterial);
                }
                applyGlassDerivedFields(nextMaterial, glass);
            };

            const searchBtn = document.createElement('button');
            searchBtn.type = 'button';
            searchBtn.className = 'block-inspector-quick-btn';
            searchBtn.textContent = '🔍';
            searchBtn.title = 'Find glass';
            searchBtn.onclick = (event) => {
                try { event.preventDefault(); } catch (_) {}
                try { event.stopPropagation(); } catch (_) {}
                const query = String(input.value ?? '').trim();
                const numericNd = /^[-+]?((\d+\.\d*)|(\d*\.\d+)|(\d+))(e[-+]?\d+)?$/i.test(query) ? Number(query) : NaN;
                let results: any[] = [];
                if (Number.isFinite(numericNd) && numericNd > 0 && numericNd < 4 && Number.isFinite(Number(abbeValue)) && Number(abbeValue) > 0) {
                    results = findSimilarGlassesByNdVd(Number(numericNd), Number(abbeValue), 12);
                } else {
                    results = findSimilarGlassNames(query || String(materialValue ?? ''), 12);
                }
                openQuickGlassPicker(results, applyGlass);
            };
            stopRowToggle(searchBtn);
            group.appendChild(searchBtn);

            const mapBtn = document.createElement('button');
            mapBtn.type = 'button';
            mapBtn.className = 'block-inspector-quick-btn';
            mapBtn.textContent = '🗺️';
            mapBtn.title = 'Open glass map';
            mapBtn.onclick = (event) => {
                try { event.preventDefault(); } catch (_) {}
                try { event.stopPropagation(); } catch (_) {}
                if (typeof openGlassMapWindow === 'function') {
                    openGlassMapWindow(
                        () => {},
                        (glass: any) => {
                            applyGlass(glass);
                            return true;
                        }
                    );
                }
            };
            stopRowToggle(mapBtn);
            group.appendChild(mapBtn);

            shell.content.appendChild(group);
            target.appendChild(shell.wrapper);
        };

        if (blockType === 'Lens' || blockType === 'PositiveLens') {
            appendTextField('R1', 'parameters.frontRadius', params.frontRadius, 62);
            appendTextField('R2', 'parameters.backRadius', params.backRadius, 62);
            appendTextField('CT', 'parameters.centerThickness', params.centerThickness, 54);
            appendMaterialField('parameters.material', params.material, 'parameters.abbe', params.abbe);
            appendTextField('n', 'parameters.rindex', params.rindex, 54);
            appendTextField('Abbe', 'parameters.abbe', params.abbe, 54);
            appendTextField('SD1', 'aperture.front', aperture.front, 50);
            appendTextField('SD2', 'aperture.back', aperture.back, 50);
        } else if (blockType === 'Doublet') {
            root.classList.add('block-inspector-quick-editor-multiline');
            const row1 = createQuickRow();
            const row2 = createQuickRow();

            appendTextField('R1', 'parameters.radius1', params.radius1, 62, row1);
            appendTextField('R2', 'parameters.radius2', params.radius2, 62, row1);
            appendTextField('CT', 'parameters.thickness1', params.thickness1, 54, row1);
            appendMaterialField('parameters.material1', params.material1, 'parameters.abbe1', params.abbe1, 'G1', row1);
            appendTextField('n1', 'parameters.rindex1', params.rindex1, 60, row1);
            appendTextField('Abbe1', 'parameters.abbe1', params.abbe1, 60, row1);
            appendTextField('SD1', 'aperture.s1', aperture.s1, 50, row1);
            appendTextField('SD2', 'aperture.s2', aperture.s2, 50, row1);

            appendSpacerField('R1', 62, row2);
            appendTextField('R3', 'parameters.radius3', params.radius3, 62, row2);
            appendTextField('CT', 'parameters.thickness2', params.thickness2, 54, row2);
            appendMaterialField('parameters.material2', params.material2, 'parameters.abbe2', params.abbe2, 'G2', row2);
            appendTextField('n2', 'parameters.rindex2', params.rindex2, 60, row2);
            appendTextField('Abbe2', 'parameters.abbe2', params.abbe2, 60, row2);
            appendSpacerField('SD1', 50, row2);
            appendTextField('SD3', 'aperture.s3', aperture.s3, 50, row2);

            root.appendChild(row1);
            root.appendChild(row2);
        } else if (blockType === 'Triplet') {
            root.classList.add('block-inspector-quick-editor-multiline');
            const row1 = createQuickRow();
            const row2 = createQuickRow();
            const row3 = createQuickRow();

            appendTextField('R1', 'parameters.radius1', params.radius1, 62, row1);
            appendTextField('R2', 'parameters.radius2', params.radius2, 62, row1);
            appendTextField('CT', 'parameters.thickness1', params.thickness1, 54, row1);
            appendMaterialField('parameters.material1', params.material1, 'parameters.abbe1', params.abbe1, 'G1', row1);
            appendTextField('n1', 'parameters.rindex1', params.rindex1, 60, row1);
            appendTextField('Abbe1', 'parameters.abbe1', params.abbe1, 60, row1);
            appendTextField('SD1', 'aperture.s1', aperture.s1, 50, row1);
            appendTextField('SD2', 'aperture.s2', aperture.s2, 50, row1);

            appendSpacerField('R1', 62, row2);
            appendTextField('R3', 'parameters.radius3', params.radius3, 62, row2);
            appendTextField('CT', 'parameters.thickness2', params.thickness2, 54, row2);
            appendMaterialField('parameters.material2', params.material2, 'parameters.abbe2', params.abbe2, 'G2', row2);
            appendTextField('n2', 'parameters.rindex2', params.rindex2, 60, row2);
            appendTextField('Abbe2', 'parameters.abbe2', params.abbe2, 60, row2);
            appendSpacerField('SD1', 50, row2);
            appendTextField('SD3', 'aperture.s3', aperture.s3, 50, row2);

            appendSpacerField('R1', 62, row3);
            appendSpacerField('R2', 62, row3);
            appendTextField('R4', 'parameters.radius4', params.radius4, 62, row3);
            appendTextField('CT', 'parameters.thickness3', params.thickness3, 54, row3);
            appendMaterialField('parameters.material3', params.material3, 'parameters.abbe3', params.abbe3, 'G3', row3);
            appendTextField('n3', 'parameters.rindex3', params.rindex3, 60, row3);
            appendTextField('Abbe3', 'parameters.abbe3', params.abbe3, 60, row3);
            appendSpacerField('SD1', 50, row3);
            appendSpacerField('SD2', 50, row3);
            appendTextField('SD4', 'aperture.s4', aperture.s4, 50, row3);

            root.appendChild(row1);
            root.appendChild(row2);
            root.appendChild(row3);
        } else if (blockType === 'Gap' || blockType === 'AirGap') {
            appendSpacerField('R1', 62);
            appendSpacerField('R2', 62);
            appendTextField('CT', 'parameters.thickness', params.thickness, 54);
            appendMaterialField('parameters.material', params.material, 'parameters.abbe', params.abbe);
            appendTextField('Abbe', 'parameters.abbe', params.abbe, 54);
        } else if (blockType === 'SingleSurface' || blockType === 'Mirror') {
            appendTextField('R', 'parameters.radius', params.radius, 62);
            if (Object.prototype.hasOwnProperty.call(params, 'material')) {
                appendMaterialField('parameters.material', params.material, 'parameters.abbe', params.abbe);
                appendTextField('Abbe', 'parameters.abbe', params.abbe, 54);
            }
            appendTextField('SD', 'aperture.semidia', aperture.semidia, 54);
        } else if (blockType === 'ImageSurface') {
            appendTextField('SD', 'parameters.semidia', params.semidia, 54);
            const semidiaValue = Number(params?.semidia);
            if (Number.isFinite(semidiaValue) && semidiaValue > 0 && Number.isFinite(maxImageHeightTargetMm) && Number(maxImageHeightTargetMm) - semidiaValue > 1e-6) {
                const isDarkMode = document.body.classList.contains('dark-mode');
                const warning = document.createElement('div');
                warning.style.flexBasis = '100%';
                warning.style.marginTop = '6px';
                warning.style.padding = '6px 8px';
                warning.style.borderRadius = '6px';
                warning.style.border = '1px solid #f5c2c7';
                warning.style.background = isDarkMode ? '#3b0d0f' : '#fff1f2';
                warning.style.color = isDarkMode ? '#fecdd3' : '#9f1239';
                warning.style.fontSize = '11px';
                warning.style.lineHeight = '1.35';
                warning.textContent = `Warning: semidia ${semidiaValue.toFixed(2)} mm is smaller than max Image Height ${Number(maxImageHeightTargetMm).toFixed(2)} mm.`;
                root.appendChild(warning);
            }
        } else {
            return null;
        }

        return root.childElementCount > 0 ? root : null;
    };

    for (const b of list) {
        const blockId = String(b.blockId ?? '').trim();
        const row = document.createElement('div');
        row.className = 'block-inspector-row';
        if (blockId && __blockInspectorExpandedBlockId === blockId) row.classList.add('selected');

        const colId = document.createElement('div');
        colId.className = 'block-inspector-col-id';
        colId.textContent = buildBlockInspectorLabelText(b);

        const realBlock = (blockById && typeof blockById.get === 'function') ? blockById.get(blockId) || b : b;
        const zoomGroupLabel = getZoomGroupLabel(realBlock);
        const gapZoomChipLabel = getGapZoomChipLabel(realBlock);
        const currentZoomGroupValue = String(readPathValue(realBlock, 'parameters.zoomGroup') ?? 'Fixed').trim() || 'Fixed';
        let zoomGroupChip: HTMLElement | null = null;
        if (zoomGroupLabel) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'block-inspector-zg-chip';
            chip.textContent = `ZG ${currentZoomGroupValue}`;
            chip.title = `Zoom Group: ${currentZoomGroupValue}`;
            chip.onclick = (e: MouseEvent) => {
                try { e.preventDefault(); } catch (_) {}
                try { e.stopPropagation(); } catch (_) {}
                openQuickOptionMenu(chip, 'Zoom Group', ZOOM_GROUP_OPTIONS, currentZoomGroupValue, (nextValue: string) => {
                    if (nextValue !== currentZoomGroupValue) {
                        cooptApplyBlockValue(blockId, 'parameters.zoomGroup', currentZoomGroupValue, nextValue);
                    }
                });
            };
            zoomGroupChip = chip;
        } else if (gapZoomChipLabel) {
            const chip = document.createElement('span');
            chip.className = 'block-inspector-zg-chip block-inspector-zg-chip-gap';
            chip.textContent = `ZG ${gapZoomChipLabel}`;
            chip.title = `Zoom Group: ${gapZoomChipLabel}`;
            zoomGroupChip = chip;
        }

        const rawType = String(b.blockType ?? '').trim();
        const displayType = (rawType === 'ObjectPlane') ? 'ObjectSurface' : String(b.blockType ?? '(none)');
        const toneType = (() => {
            const normalized = (rawType === 'ObjectPlane') ? 'ObjectSurface' : rawType;
            if (normalized === 'PositiveLens' || normalized === 'Paraxial') return 'lens';
            if (normalized === 'AirGap') return 'gap';
            return String(normalized || 'unknown').trim().toLowerCase();
        })();
        row.dataset.blockType = toneType;
        colId.dataset.blockType = toneType;
        colId.title = displayType;
        if (unifiedLensToneTypes.has(toneType) || toneType === 'gap') {
            const unifiedWidth = `${unifiedLensBadgeWidthCh}ch`;
            colId.style.width = unifiedWidth;
            colId.style.minWidth = unifiedWidth;
            colId.style.maxWidth = unifiedWidth;
            colId.style.flex = `0 0 ${unifiedWidth}`;
        }

        const colParams = document.createElement('div');
        colParams.className = 'block-inspector-col-params';
        const previewText = String(b.preview ?? '');
        const quickEditor = quickEditorEnabled ? createQuickEditor(realBlock) : null;
        if (quickEditor) {
            if (previewText) colParams.title = previewText;
            colParams.appendChild(quickEditor);
        } else {
            const previewSpan = document.createElement('span');
            previewSpan.className = 'block-inspector-col-params-text';
            previewSpan.textContent = previewText;
            if (previewText) colParams.appendChild(previewSpan);
        }

        const rawTypeForSummary = String(realBlock?.blockType ?? b?.blockType ?? '').trim();
        if (rawTypeForSummary === 'ObjectSurface' || rawTypeForSummary === 'ObjectPlane') {
            colParams.appendChild(createSummaryChip(getZoomPositionSummary(realBlock), 'controller'));
            const lawGroups = getZoomLawGroupNames(realBlock);
            if (lawGroups.length > 0) {
                colParams.appendChild(createSummaryChip(`Laws: ${lawGroups.join(', ')}`, 'controller'));
            }
        } else if ((rawTypeForSummary === 'Gap' || rawTypeForSummary === 'AirGap') && !zoomGroupChip) {
            const gapBoundaryText = getGapBoundaryLabel(realBlock);
            if (gapBoundaryText) {
                colParams.appendChild(createSummaryChip(`ZG ${gapBoundaryText}`, 'gap'));
            }
        } else if (!quickEditor && !zoomGroupChip) {
            const zoomGroupText = getZoomGroupLabel(realBlock);
            if (zoomGroupText) {
                colParams.appendChild(createSummaryChip(`ZG ${zoomGroupText}`, 'group'));
            }
        }

        const colCount = document.createElement('div');
        colCount.className = 'block-inspector-col-count';
        const n = getLogicalSurfaceCountForBlock(b);
        colCount.textContent = `→ ${Number.isFinite(n) ? n : 0} surfaces`;

        // Drag handle
        const dragHandle = document.createElement('span');
        dragHandle.className = 'block-inspector-drag-handle';
        dragHandle.textContent = '⠿';
        dragHandle.title = 'ドラッグして並び替え';

        row.appendChild(dragHandle);
        row.appendChild(colId);
        row.appendChild(colParams);
        if (zoomGroupChip) row.appendChild(zoomGroupChip);
        row.appendChild(colCount);

        // Drag-and-drop support (only when blocksInOrder is available)
        if (Array.isArray(blocksInOrder) && blocksInOrder.length > 0 && blockId) {
            dragHandle.draggable = true;
            row.dataset.blockId = blockId;

            dragHandle.addEventListener('dragstart', (e: DragEvent) => {
                __blocks_draggedBlockId = blockId;
                row.classList.add('dragging');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', blockId);
                }
                // Prevent expand/collapse click from firing on drag
                e.stopPropagation();
            });

            dragHandle.addEventListener('dragend', () => {
                __blocks_draggedBlockId = null;
                row.classList.remove('dragging');
                row.classList.remove('drag-over-before');
                row.classList.remove('drag-over-after');
            });

            row.addEventListener('dragover', (e: DragEvent) => {
                if (!__blocks_draggedBlockId || __blocks_draggedBlockId === blockId) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                const rect = row.getBoundingClientRect();
                const midY = rect.top + rect.height / 2;
                const isAbove = e.clientY < midY;
                row.classList.toggle('drag-over-before', isAbove);
                row.classList.toggle('drag-over-after', !isAbove);
            });

            row.addEventListener('dragleave', () => {
                row.classList.remove('drag-over-before');
                row.classList.remove('drag-over-after');
            });

            row.addEventListener('drop', (e: DragEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const fromId = __blocks_draggedBlockId;
                row.classList.remove('drag-over-before');
                row.classList.remove('drag-over-after');
                if (!fromId || fromId === blockId) return;
                const rect = row.getBoundingClientRect();
                const position: 'before' | 'after' = (e.clientY < rect.top + rect.height / 2) ? 'before' : 'after';
                try { __blocks_moveBlock(fromId, blockId, position); } catch (_) {}
            });
        }

        row.onclick = (e: MouseEvent) => {
            // Ignore if dragging
            if ((e.target as HTMLElement)?.classList?.contains('block-inspector-drag-handle')) return;
            if (!blockId) return;
            __blockInspectorExpandedBlockId = (__blockInspectorExpandedBlockId === blockId) ? null : blockId;
            try { refreshBlockInspector(); } catch (_) {}
        };

        container.appendChild(row);

        const expandedBlock = blockById && typeof blockById.get === 'function' ? blockById.get(blockId) : null;
        if (expandedBlock && __blockInspectorExpandedBlockId === blockId) {
            const panel = document.createElement('div');
            panel.className = 'block-inspector-expanded-panel';
            panel.style.padding = '8px 10px';
            panel.style.margin = '0';
            const isDarkMode = document.body.classList.contains('dark-mode');
            panel.style.borderTop = isDarkMode ? '1px solid #333' : '1px solid #eee';
            panel.style.fontSize = '12px';
            panel.style.color = isDarkMode ? '#ffffff' : '#333';
            
            panel.dataset.blockId = String(blockId);
            panel.setAttribute('data-block-id', String(blockId));

            const params = (expandedBlock.parameters && typeof expandedBlock.parameters === 'object') ? expandedBlock.parameters : {};
            const vars = (expandedBlock.variables && typeof expandedBlock.variables === 'object') ? expandedBlock.variables : {};
            
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

                    // Doublet display priority: material1 → rindex1 → abbe1/vd1 → material2 → rindex2 → abbe2/vd2
                    const rank = (k: string): number => {
                        switch (k) {
                            case 'material1': return 0;
                            case 'rindex1': return 1;
                            case 'abbe1':
                            case 'vd1': return 2;
                            case 'material2': return 3;
                            case 'rindex2': return 4;
                            case 'abbe2':
                            case 'vd2': return 5;
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
                    
                    if (a === 'rindex') return -1;
                    if (b === 'rindex') return 1;

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

                    // Zoom controls
                    const placeZoomGroupLast = blockType === 'Doublet' || blockType === 'Triplet';
                    if (placeZoomGroupLast) {
                        if (a === 'zoomGroup' && b !== 'zoomGroup') return 1;
                        if (b === 'zoomGroup' && a !== 'zoomGroup') return -1;
                    } else {
                        if (a === 'zoomGroup' && b !== 'zoomGroup') return -1;
                        if (b === 'zoomGroup' && a !== 'zoomGroup') return 1;
                    }
                    if (a === 'zoomPosition' && b !== 'zoomGroup' && b !== 'zoomPosition') return -1;
                    if (b === 'zoomPosition' && a !== 'zoomGroup' && a !== 'zoomPosition') return 1;
                    if (a === 'zoomGroupProfiles' && !['zoomGroup', 'zoomPosition', 'zoomGroupProfiles'].includes(b)) return -1;
                    if (b === 'zoomGroupProfiles' && !['zoomGroup', 'zoomPosition', 'zoomGroupProfiles'].includes(a)) return 1;
                    
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
            
            const blockType = String(expandedBlock.blockType || expandedBlock.type || 'unknown');
            // For Gap blocks, ensure material/thicknessMode are always in paramKeys even if not set
            const allParamKeys = Object.keys(params || {}).filter(k => {
                // chiefRayShiftX/Y/Z は廃止フィールド。表示しない
                const kl = k.toLowerCase();
                if (kl === 'chiefrayshiftx' || kl === 'chiefrayshifty' || kl === 'chiefrayshiftz') return false;
                if (kl === 'zoomgroupaprofile' || kl === 'zoomgroupbprofile') return false;
                if ((blockType === 'ObjectSurface' || blockType === 'ObjectPlane') && (kl === 'zoomposition' || kl === 'zoomgroupprofiles')) return false;
                if (blockType === 'Paraxial') {
                    if (kl === 'material' || kl === 'abbe' || kl === 'vd' || kl === 'nd' || kl === 'rindex' || kl === 'bending') return false;
                    if (kl === 'frontradius' || kl === 'backradius' || kl === 'centerthickness' || kl === 'radiusx') return false;
                    if (kl === 'focallength') return false;
                    if (kl === 'conic' || kl === 'axis' || /^coef\d+$/.test(kl)) return false;
                    if (kl === 'backsurftype' || kl === 'backconic' || /^backcoef\d+$/.test(kl)) return false;
                    if (kl === 'frontsurftype' || kl === 'frontconic' || /^frontcoef\d+$/.test(kl)) return false;
                }
                return true;
            });
            if ((blockType === 'Gap' || blockType === 'AirGap') && !allParamKeys.includes('material')) {
                allParamKeys.push('material');
            }
            if ((blockType === 'Gap' || blockType === 'AirGap') && !allParamKeys.includes('thicknessMode')) {
                allParamKeys.push('thicknessMode');
            }
            if ((blockType === 'ObjectSurface' || blockType === 'ObjectPlane') && !allParamKeys.includes('objectDistance')) {
                allParamKeys.push('objectDistance');
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
            if (blockType === 'Paraxial') {
                if (!allParamKeys.includes('surfType')) allParamKeys.push('surfType');
                if (!allParamKeys.includes('focalLengthX')) allParamKeys.push('focalLengthX');
                if (!allParamKeys.includes('focalLengthY')) allParamKeys.push('focalLengthY');
            }
            if (blockType === 'Lens' || blockType === 'PositiveLens' || blockType === 'Doublet') {
                if (!allParamKeys.includes('bending')) allParamKeys.push('bending');
            }
            if ((blockType === 'Lens' || blockType === 'PositiveLens') && !allParamKeys.includes('rindex')) {
                allParamKeys.push('rindex');
            }
            if (blockType === 'Doublet') {
                if (!allParamKeys.includes('rindex1')) allParamKeys.push('rindex1');
                if (!allParamKeys.includes('rindex2')) allParamKeys.push('rindex2');
            }
            if (blockType === 'Triplet') {
                if (!allParamKeys.includes('rindex1')) allParamKeys.push('rindex1');
                if (!allParamKeys.includes('rindex2')) allParamKeys.push('rindex2');
                if (!allParamKeys.includes('rindex3')) allParamKeys.push('rindex3');
            }
            if (blockType === 'Stop') {
                if (!allParamKeys.includes('semiDiameter')) allParamKeys.push('semiDiameter');
            }
            if (blockType !== 'Gap' && blockType !== 'AirGap' && blockType !== 'ImageSurface' && blockType !== 'ObjectSurface' && blockType !== 'ObjectPlane') {
                if (!allParamKeys.includes('zoomGroup')) allParamKeys.push('zoomGroup');
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
            const sortVariableKeys = (keys: string[]): string[] => {
                const rank = (key: string): number => {
                    const lower = String(key ?? '').trim().toLowerCase();
                    if (lower === 'material') return 0;
                    if (lower === 'rindex') return 1;
                    if (lower === 'abbe' || lower === 'vd' || lower === 'nd') return 2;

                    const materialMatch = lower.match(/^material(\d+)$/);
                    if (materialMatch) return 10 + (Number(materialMatch[1]) * 10);

                    const rindexMatch = lower.match(/^rindex(\d+)$/);
                    if (rindexMatch) return 11 + (Number(rindexMatch[1]) * 10);

                    const abbeMatch = lower.match(/^(abbe|vd|nd)(\d+)$/);
                    if (abbeMatch) return 12 + (Number(abbeMatch[2]) * 10);

                    return 1000;
                };

                return keys.slice().sort((a, b) => {
                    const rankA = rank(a);
                    const rankB = rank(b);
                    if (rankA !== rankB) return rankA - rankB;
                    return a.localeCompare(b);
                });
            };
            const varKeys = sortVariableKeys(Object.keys(vars || {}));

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
                if (lower.startsWith('frontcoef')) prefix = 's1 ';
                else if (lower.startsWith('backcoef')) prefix = 's2 ';
                else if (lower.startsWith('surf1coef')) prefix = 's1 ';
                else if (lower.startsWith('surf2coef')) prefix = 's2 ';
                else if (lower.startsWith('surf3coef')) prefix = 's3 ';
                else if (lower.startsWith('surf4coef')) prefix = 's4 ';
                return `${prefix}A${aIndex}`.trim();
            };

            const getDisplayLabelForKey = (rawLabel: string): string => {
                const label = String(rawLabel ?? '').trim();
                if (blockType === 'Paraxial') {
                    if (label === 'surfType' || label === 'frontSurfType') return 'X/Y Power';
                    if (label === 'focalLengthX') return 'Focal Length X';
                    if (label === 'focalLengthY' || label === 'focalLength') return 'Focal Length Y';
                }
                if (label === 'bending') return 'Bending';
                if (label === 'zoomPosition') return 'Zoom Position';
                if (label === 'zoomGroup') return 'Zoom Group';
                if (label === 'zoomGroupProfiles') return 'Zoom Group Laws';
                if (label === 'frontSurfType') return 's1 Surf Type';
                if (label === 'backSurfType') return 's2 Surf Type';
                if (label === 'surf1SurfType') return 's1 Surf Type';
                if (label === 'surf2SurfType') return 's2 Surf Type';
                if (label === 'surf3SurfType') return 's3 Surf Type';
                if (label === 'surf4SurfType') return 's4 Surf Type';
                if (label === 'frontConic') return 's1 Conic';
                if (label === 'backConic') return 's2 Conic';
                if (label === 'surf1Conic') return 's1 Conic';
                if (label === 'surf2Conic') return 's2 Conic';
                if (label === 'surf3Conic') return 's3 Conic';
                if (label === 'surf4Conic') return 's4 Conic';
                return label;
            };

            const createSectionTitle = (label: string) => {
                const title = document.createElement('div');
                title.className = 'block-inspector-section-title';
                title.textContent = label;
                title.style.fontWeight = '600';
                title.style.margin = '6px 0';
                title.style.fontSize = '12px';
                return title;
            };

            const createRow = (label: string, value: any, path: string, badge?: string, paramType?: string) => {
                const row = document.createElement('div');
                row.className = 'block-inspector-detail-row';
                row.style.display = 'flex';
                row.style.gap = '8px';
                row.style.alignItems = 'center';
                row.style.minHeight = '32px';
                row.style.marginBottom = '4px';

                const name = document.createElement('div');
                const coefLabel = getCoefDisplayLabel(label);
                const displayLabel = getDisplayLabelForKey(label);
                name.textContent = coefLabel || displayLabel;
                name.title = coefLabel || displayLabel;
                name.style.fontSize = '12px';
                name.style.color = isDarkMode ? '#d1d5db' : '#374151';
                name.style.flex = '0 0 140px';
                name.style.whiteSpace = 'nowrap';
                name.style.overflow = 'hidden';
                name.style.textOverflow = 'ellipsis';
                name.style.lineHeight = '1.2';

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
                const isZoomGroup = label === 'zoomGroup';
                // Exclude refractive-index / dispersion fields from slider display.
                const isGlassProperty = /^(?:rindex|nd|vd|abbe)\d*$/i.test(label);
                const isNumeric = !isMaterial && !isSurfType && !isGlassProperty && !isGapThicknessMode && !isObjectDistanceMode && !isImageSemidiaMode && !isApertureShape && !isCoordReturn && !isCoordOrder && !isCoordToSurf && !isZoomGroup && !isNaN(parseFloat(String(value)));
                
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

                    const options = (blockType === 'Paraxial' && label === 'surfType')
                        ? [{ value: 'Toric', label: 'X/Y power' }]
                        : [
                            { value: 'Spherical', label: 'Spherical' },
                            { value: 'Aspherical even', label: 'Aspherical even' },
                            { value: 'Aspherical odd', label: 'Aspherical odd' },
                            { value: 'Toric', label: 'Astigmatic (X/Y power)' }
                        ];
                    const currentValue = String(value || 'Spherical');

                    options.forEach(({ value: optionValue, label: optionLabel }) => {
                        const option = document.createElement('option');
                        option.value = optionValue;
                        option.textContent = optionLabel;
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
                } else if (isZoomGroup) {
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

                    const currentValue = String(value ?? 'Fixed').trim() || 'Fixed';
                    const options = ZOOM_GROUP_OPTIONS.includes(currentValue)
                        ? ZOOM_GROUP_OPTIONS.slice()
                        : [currentValue, ...ZOOM_GROUP_OPTIONS.filter((option) => option !== currentValue)];

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
                            cooptApplyBlockValue(blockId, path, currentValue, newValue);
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
                    container.style.flexWrap = 'nowrap';
                    container.style.minHeight = '28px';

                    const applyMaterialDerivedFields = (nextMaterialValue: any, selectedGlass?: any) => {
                        const glass = (selectedGlass && typeof selectedGlass === 'object')
                            ? selectedGlass
                            : getGlassDataWithSellmeier(String(nextMaterialValue ?? '').trim());
                        if (!glass) return;

                        const rindexFieldPath = path.replace(/material/i, 'rindex');
                        if (rindexFieldPath !== path && Number.isFinite(Number(glass.nd))) {
                            try {
                                cooptApplyBlockValue(blockId, rindexFieldPath, undefined, String(glass.nd));
                            } catch (_) {}
                        }

                        const abbeFieldPath = path.replace(/material/i, 'abbe');
                        if (abbeFieldPath !== path && Number.isFinite(Number(glass.vd))) {
                            try {
                                cooptApplyBlockValue(blockId, abbeFieldPath, undefined, String(glass.vd));
                            } catch (_) {}
                        }
                    };

                    const input = document.createElement('input');
                    input.type = 'text';
                    input.value = value === undefined || value === null ? '' : String(value);
                    input.style.fontSize = '12px';
                    input.style.padding = '4px 6px';
                    input.style.border = isDarkMode ? '1px solid #444' : '1px solid #ddd';
                    input.style.background = isDarkMode ? '#111827' : '#fff';
                    input.style.color = isDarkMode ? '#f9fafb' : '#111827';
                    input.style.borderRadius = '4px';
                    input.style.flex = '1';
                    input.style.minWidth = '200px';
                    input.style.height = '28px';
                    input.style.boxSizing = 'border-box';

                    const glassBtn = document.createElement('button');
                    glassBtn.type = 'button';
                    glassBtn.className = 'block-inspector-icon-btn';
                    glassBtn.textContent = '🔍';
                    glassBtn.title = 'Find Glass';

                    // Glass Map button
                    const glassMapBtn = document.createElement('button');
                    glassMapBtn.type = 'button';
                    glassMapBtn.className = 'block-inspector-icon-btn';
                    glassMapBtn.textContent = '🗺️';
                    glassMapBtn.title = 'Open Glass Map';

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

                                        applyMaterialDerivedFields(newValue, glass);
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

                                applyMaterialDerivedFields(newValue, glass);
                                
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
                            applyMaterialDerivedFields(newValue);
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
                    input.style.borderRadius = '4px';
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
                    if (blockType === 'Paraxial' && key === 'focalLengthX' && (value === undefined || value === null || String(value).trim() === '')) {
                        value = (params as any).focalLengthY ?? (params as any).focalLength ?? 100;
                    }
                    if (blockType === 'Paraxial' && (key === 'focalLengthY' || key === 'focalLength') && (value === undefined || value === null || String(value).trim() === '')) {
                        value = (params as any).focalLengthX ?? (params as any).focalLength ?? 100;
                    }
                    if (blockType === 'Paraxial' && key === 'surfType' && (value === undefined || value === null || String(value).trim() === '')) {
                        value = 'Toric';
                    }
                    if ((blockType === 'ObjectSurface' || blockType === 'ObjectPlane') && key === 'zoomPosition' && (value === undefined || value === null || String(value).trim() === '')) {
                        value = 0;
                    }
                    if ((blockType === 'ObjectSurface' || blockType === 'ObjectPlane') && key === 'zoomGroupProfiles' && (value === undefined || value === null || String(value).trim() === '')) {
                        const legacyA = String((params as any)?.zoomGroupAProfile ?? '').trim();
                        const legacyB = String((params as any)?.zoomGroupBProfile ?? '').trim();
                        const lines: string[] = [];
                        if (legacyA) lines.push(`A=${legacyA}`);
                        if (legacyB) lines.push(`B=${legacyB}`);
                        value = lines.length > 0 ? lines.join('\n') : 'A=0:0,1:0';
                    }
                    if (key === 'zoomGroup' && (value === undefined || value === null || String(value).trim() === '')) {
                        value = 'Fixed';
                    }
                    if ((blockType === 'Lens' || blockType === 'PositiveLens' || blockType === 'Doublet') && key === 'bending') {
                        value = cooptComputeLensBendingValue(expandedBlock, blockType);
                    }
                    if (blockType === 'ImageSurface' && key === 'semidiaMode' && (value === undefined || value === null || String(value).trim() === '')) {
                        const opt = String((params as any)?.optimizeSemiDia ?? '').trim().toUpperCase();
                        value = (opt === 'A' || opt === 'AUTO') ? 'Auto' : 'Manual';
                    }
                    // For Gap/AirGap material, default to 'AIR' if undefined or empty
                    if ((blockType === 'Gap' || blockType === 'AirGap') && key === 'material' && (value === undefined || value === null || value === '')) {
                        value = 'AIR';
                    }
                    const varEntry = (vars as any)[key];
                    const isAbbeRow = key === 'abbe' || key === 'vd' || /^abbe\d+$/.test(key) || /^vd\d+$/.test(key);
                    const isGroupedSurfTypeRow =
                        (blockType === 'Doublet' || blockType === 'Triplet') &&
                        /^surf\d+SurfType$/.test(key);

                    // Create row with optimize checkbox and scope selector
                    const paramRow = document.createElement('div');
                    paramRow.style.display = 'flex';
                    paramRow.style.alignItems = 'center';
                    paramRow.style.gap = '6px';
                    paramRow.style.minHeight = '32px';
                    paramRow.style.marginBottom = (isAbbeRow || isGroupedSurfTypeRow) ? '8px' : '4px';

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
                    });

                    scopeSel.addEventListener('change', (e) => {
                        e.stopPropagation();
                        const newScope = String(scopeSel.value);
                        __blocks_setVarScope(blockId, key, newScope);
                        if (cb.checked) {
                            __blocks_setVarMode(blockId, key, true, newScope);
                        }
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

            // Add aperture section for blocks that can accept semidiameter input,
            // even when imported JSON does not yet carry block.aperture.
            const aperture = (blockType !== 'Stop' && expandedBlock.aperture && typeof expandedBlock.aperture === 'object') ? expandedBlock.aperture : null;
            const renderedApertureKeys = new Set<string>();
            const apertureEntries: Array<{ rawKey: string; displayKey: string; value: any }> = [];
            const pickApertureEntry = (displayKey: string, aliases: string[], fallbackKey?: string) => {
                for (const alias of aliases) {
                    if (aperture && Object.prototype.hasOwnProperty.call(aperture, alias)) {
                        apertureEntries.push({ rawKey: alias, displayKey, value: (aperture as any)[alias] });
                        renderedApertureKeys.add(displayKey.toLowerCase());
                        return;
                    }
                }
                if (fallbackKey) {
                    apertureEntries.push({ rawKey: fallbackKey, displayKey, value: '' });
                    renderedApertureKeys.add(displayKey.toLowerCase());
                }
            };

            if (blockType === 'Paraxial') {
                pickApertureEntry('s1', ['s1', 'front', 'back', 'surf1', 'surf2'], 'front');
            } else if (blockType === 'Lens' || blockType === 'PositiveLens') {
                pickApertureEntry('s1', ['s1', 'front', 'surf1'], 'front');
                pickApertureEntry('s2', ['s2', 'back', 'surf2'], 'back');
            } else if (blockType === 'Doublet') {
                pickApertureEntry('s1', ['s1', 'front', 'surf1'], 's1');
                pickApertureEntry('s2', ['s2', 'middle', 'mid', 'center', 'surf2'], 's2');
                pickApertureEntry('s3', ['s3', 'back', 'rear', 'surf3'], 's3');
            } else if (blockType === 'Triplet') {
                pickApertureEntry('s1', ['s1', 'front', 'surf1'], 's1');
                pickApertureEntry('s2', ['s2', 'surf2'], 's2');
                pickApertureEntry('s3', ['s3', 'surf3'], 's3');
                pickApertureEntry('s4', ['s4', 'back', 'rear', 'surf4'], 's4');
            } else if (blockType === 'SingleSurface' || blockType === 'Mirror') {
                pickApertureEntry('semidia', ['semidia', 's1', 'front'], 'semidia');
            } else if (aperture) {
                for (const key of Object.keys(aperture)) {
                    apertureEntries.push({ rawKey: key, displayKey: key, value: (aperture as any)[key] });
                    renderedApertureKeys.add(String(key).toLowerCase());
                }
            }

            if (apertureEntries.length > 0) {
                panel.appendChild(createSectionTitle('Aperture (Semidiameter)'));

                for (const { rawKey, displayKey, value } of apertureEntries) {
                    const apertureEntry = (vars as any)[rawKey];
                    
                    // Create row with optimize checkbox and scope selector
                    const apertureRow = document.createElement('div');
                    apertureRow.style.display = 'flex';
                    apertureRow.style.alignItems = 'center';
                    apertureRow.style.gap = '6px';
                    apertureRow.style.minHeight = '32px';
                    apertureRow.style.marginBottom = '4px';

                    // Optimize checkbox
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.style.flex = '0 0 auto';
                    cb.style.width = '16px';
                    cb.style.height = '16px';
                    cb.style.margin = '0 4px 0 0';
                    cb.checked = __blocks_shouldMarkVar(apertureEntry);
                    cb.addEventListener('click', (e) => e.stopPropagation());

                    // Scope select (Per-config / Shared)
                    const scopeSel = document.createElement('select');
                    scopeSel.style.flex = '0 0 110px';
                    scopeSel.style.fontSize = '12px';
                    scopeSel.style.padding = '2px 4px';
                    scopeSel.innerHTML = '<option value="perConfig">Per-config</option><option value="global">Shared (all configs)</option>';
                    scopeSel.value = __blocks_getVarScope(apertureEntry);
                    scopeSel.disabled = !cb.checked;
                    scopeSel.addEventListener('click', (e) => e.stopPropagation());

                    cb.addEventListener('change', (e) => {
                        e.stopPropagation();
                        try { scopeSel.disabled = !cb.checked; } catch (_) {}
                        __blocks_setVarMode(blockId, rawKey, cb.checked, String(scopeSel.value));
                    });

                    scopeSel.addEventListener('change', (e) => {
                        e.stopPropagation();
                        const newScope = String(scopeSel.value);
                        __blocks_setVarScope(blockId, rawKey, newScope);
                        if (cb.checked) {
                            __blocks_setVarMode(blockId, rawKey, true, newScope);
                        }
                    });

                    const innerRow = createRow(displayKey, value, `aperture.${rawKey}`);
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
                    const normalizedVarKey = String(key ?? '').trim().toLowerCase()
                        .replace(/^front$/, 's1')
                        .replace(/^back$/, blockType === 'Lens' || blockType === 'PositiveLens' ? 's2' : 's3')
                        .replace(/^surf1$/, 's1')
                        .replace(/^surf2$/, 's2')
                        .replace(/^surf3$/, 's3')
                        .replace(/^surf4$/, 's4');
                    // Skip if this key is already shown in Parameters or Aperture
                    if (paramKeys.includes(key) || renderedApertureKeys.has(normalizedVarKey)) {
                        continue;
                    }
                    
                    const entry = (vars as any)[key];
                    const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;

                    // Create a row with checkbox and scope select
                    const varRow = document.createElement('div');
                    varRow.style.display = 'flex';
                    varRow.style.alignItems = 'center';
                    varRow.style.gap = '6px';
                    varRow.style.marginBottom = '4px';

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
                        updateOptimizeChip();
                    });

                    scopeSel.addEventListener('change', (e) => {
                        e.stopPropagation();
                        const newScope = String(scopeSel.value);
                        __blocks_setVarScope(blockId, key, newScope);
                        if (cb.checked) {
                            __blocks_setVarMode(blockId, key, true, newScope);
                        }
                        updateOptimizeChip();
                    });

                    // Build the standard createRow content but embed in this container
                    const badge = entry && typeof entry === 'object' && entry.optimize && entry.optimize.mode ? `V:${entry.optimize.mode}` : 'V';
                    const innerRow = createRow(key, value, `variables.${key}.value`, badge);
                    innerRow.style.flex = '1';
                    innerRow.style.marginBottom = '0';
                    const chip = innerRow.lastElementChild as HTMLDivElement | null;
                    const updateOptimizeChip = () => {
                        if (!chip) return;
                        chip.textContent = cb.checked ? 'V:V' : 'V:F';
                        chip.style.border = isDarkMode ? '1px solid #374151' : '1px solid #e5e7eb';
                        chip.style.visibility = 'visible';
                    };

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

let __cooptBlockInspectorRefreshTimer: number | null = null;
let __cooptBlockInspectorLastRunAtMs = 0;
let __cooptBlockInspectorExpandedRowsOverride: any[] | null = null;
let __cooptBlockInspectorSkipOpticalTableSync = false;

function __cooptIsBlockInspectorDiagEnabled(): boolean {
    try {
        if (typeof window !== 'undefined' && (window as any).__cooptBlocksDiag === true) return true;
    } catch (_) {}
    return false;
}

export function refreshBlockInspector(): void {
    const now = Date.now();
    const minIntervalMs = 140;
    if (now - __cooptBlockInspectorLastRunAtMs < minIntervalMs) {
        if (__cooptBlockInspectorRefreshTimer !== null) {
            clearTimeout(__cooptBlockInspectorRefreshTimer);
        }
        __cooptBlockInspectorRefreshTimer = window.setTimeout(() => {
            __cooptBlockInspectorRefreshTimer = null;
            refreshBlockInspector();
        }, minIntervalMs);
        return;
    }
    __cooptBlockInspectorLastRunAtMs = now;

    const banner = document.getElementById('import-analyze-mode-banner');
    const setBannerVisible = (isVisible: boolean) => {
        if (!banner) return;
        banner.style.display = isVisible ? '' : 'none';
    };

    try {
        const activeCfg = (typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null;
        let blocks = activeCfg && Array.isArray(activeCfg.blocks) ? activeCfg.blocks : null;

        if ((!blocks || blocks.length === 0) && activeCfg && Array.isArray(activeCfg.opticalSystem) && activeCfg.opticalSystem.length > 0) {
            try {
                const legacyRows = activeCfg.opticalSystem;
                let recoveredBlocks: any[] = [];
                const derived = deriveBlocksFromLegacyOpticalSystemRows(legacyRows);
                const fatals = Array.isArray(derived?.issues)
                    ? derived.issues.filter((issue: any) => issue && issue.severity === 'fatal')
                    : [];

                if (fatals.length === 0 && __coopt_shouldAcceptDerivedBlocks(derived?.blocks, legacyRows)) {
                    recoveredBlocks = __coopt_normalizeObjectDistanceInBlocks(derived.blocks);
                } else {
                    recoveredBlocks = __coopt_normalizeObjectDistanceInBlocks(__coopt_buildFallbackBlocksFromRows(legacyRows));
                }

                if (recoveredBlocks.length > 0) {
                    const systemConfig = loadSystemConfigurations();
                    const cfgList = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
                    const persistedCfg = cfgList.find((cfg: any) => configIdsEqual(cfg?.id, systemConfig?.activeConfigId));
                    if (persistedCfg) {
                        persistedCfg.blocks = recoveredBlocks;
                        if (!persistedCfg.metadata || typeof persistedCfg.metadata !== 'object') persistedCfg.metadata = {};
                        persistedCfg.metadata.importAnalyzeMode = false;
                        persistedCfg.metadata.modified = new Date().toISOString();
                        saveSystemConfigurations(systemConfig);
                        blocks = recoveredBlocks;
                        console.log('✅ [Blocks] Recovered missing Design Intent blocks from optical rows:', {
                            activeConfigId: systemConfig?.activeConfigId,
                            rowCount: legacyRows.length,
                            blockCount: recoveredBlocks.length,
                        });
                    }
                }
            } catch (recoverError) {
                console.warn('⚠️ [Blocks] Failed to recover blocks from optical rows during refresh:', recoverError);
            }
        }

        if (activeCfg && __cooptIsBlockInspectorDiagEnabled()) {
            console.log('🔍 [Blocks] refreshBlockInspector state:', {
                activeConfigId: activeCfg?.id,
                blockCount: Array.isArray(blocks) ? blocks.length : 0,
                opticalRowCount: Array.isArray(activeCfg?.opticalSystem) ? activeCfg.opticalSystem.length : 0,
            });
        }

        const apertureAutoConditionSummary = __zmxFormatLargestObjectConditionSummary(
            Array.isArray(activeCfg?.object) ? activeCfg.object : []
        );

        try {
            const isImportAnalyze = !blocks || blocks.length === 0;
            setBannerVisible(!!isImportAnalyze);
        } catch (_) {}

        if (blocks && blocks.length > 0) {
            const countById = new Map<string, number>();
            let expandedRowsForUI: any = null;
            try {
                const rows = Array.isArray(__cooptBlockInspectorExpandedRowsOverride)
                    ? __cooptBlockInspectorExpandedRowsOverride
                    : (() => {
                        if (typeof expandBlocksToOpticalSystemRows !== 'function') return [];
                        const exp = expandBlocksToOpticalSystemRows(blocks);
                        return exp && Array.isArray(exp.rows) ? exp.rows : [];
                    })();
                expandedRowsForUI = rows;
                for (const r of rows) {
                    const bid = r?._blockId;
                    if (bid === null || bid === undefined) continue;
                    const id = String(bid).trim();
                    if (!id || id === '(none)') continue;
                    const rowBlockType = String(r?._blockType ?? '').trim();
                    if (rowBlockType === 'Gap' || rowBlockType === 'CoordTrans') continue;
                    if (rowBlockType === 'ObjectSurface' || rowBlockType === 'ObjectPlane' || rowBlockType === 'Object') continue;
                    if (rowBlockType === 'Paraxial') {
                        if (!countById.has(id)) countById.set(id, 1);
                        continue;
                    }
                    countById.set(id, (countById.get(id) || 0) + 1);
                }
            } catch (_) {}

            try {
                if (!__cooptBlockInspectorSkipOpticalTableSync && Array.isArray(expandedRowsForUI) && expandedRowsForUI.length > 0) {
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
                        try {
                            cooptSuppressOpticalSystemDataChanged(true);
                            if (typeof tab.replaceData === 'function') {
                                tab.replaceData(rowsForTable);
                            } else if (typeof tab.setData === 'function') {
                                tab.setData(rowsForTable);
                            }
                        } finally {
                            window.setTimeout(() => {
                                cooptSuppressOpticalSystemDataChanged(false);
                            }, 0);
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
            refreshZoomControlTab();
        } else {
            if (typeof w.dumpOpticalSystemProvenance !== 'function') return;
            const result = w.dumpOpticalSystemProvenance({ quiet: true });
            renderBlockInspector(result?.summary || [], result?.groups || {}, null, null);
            refreshZoomControlTab();
        }
    } catch (e) {
        console.warn('⚠️ [Blocks] Failed to refresh block inspector:', e);
    } finally {
        __cooptBlockInspectorExpandedRowsOverride = null;
        __cooptBlockInspectorSkipOpticalTableSync = false;
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

            try { __cooptRequestRenderRedrawWithRows(null); } catch (_) {}
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
    if (t === 'ThinLens') return 'Paraxial';
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

    if (type === 'Paraxial') {
        base.parameters = {
            zoomGroup: 'Fixed',
            surfType: 'Toric',
            focalLengthX: 100,
            focalLengthY: 100
        };
        base.aperture = {
            front: ''
        };
        return base;
    }

    if (type === 'Lens' || type === 'PositiveLens') {
        base.parameters = {
            frontRadius: 'INF',
            backRadius: 'INF',
            centerThickness: 1,
            material: 'N-BK7',
            rindex: '',
            abbe: '',
            frontSurfType: 'Spherical',
            backSurfType: 'Spherical',
            frontConic: 0,
            backConic: 0
        };
        base.aperture = {
            front: '',
            back: ''
        };
        return base;
    }
    if (type === 'Doublet') {
        base.parameters = {
            radius1: 120,
            radius2: -72,
            radius3: -180,
            thickness1: 1,
            thickness2: 1,
            material1: 'N-BK7',
            rindex1: '',
            material2: 'N-F2',
            rindex2: '',
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
            s1: '',
            s2: '',
            s3: ''
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
            rindex1: '',
            material2: 'N-F2',
            rindex2: '',
            material3: 'N-BK7',
            rindex3: '',
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
            s1: '',
            s2: '',
            s3: '',
            s4: ''
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
            objectDistance: 100,
            zoomPosition: 0,
            zoomGroupProfiles: 'A=0:0,1:0'
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
            semidia: '',
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
            semidia: '',
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
        saveSystemConfigurations(systemConfig);
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true, blockData: removedBlock, blockIndex: idx };
}

function __blocks_generateZoomScenariosForActiveConfig(): any {
    const systemConfig = loadSystemConfigurations();
    if (!systemConfig || !Array.isArray(systemConfig.configurations)) {
        return { ok: false, reason: 'systemConfigurations not found.' };
    }

    const activeCfg = systemConfig.configurations.find((cfg: any) => cfg && String(cfg.id) === String(systemConfig.activeConfigId));
    if (!activeCfg || !Array.isArray(activeCfg.blocks)) {
        return { ok: false, reason: 'active config has no blocks.' };
    }

    const objectBlock = activeCfg.blocks.find((block: any) => {
        const type = String(block?.blockType ?? '').trim();
        return type === 'ObjectSurface' || type === 'ObjectPlane';
    });
    if (!objectBlock || typeof objectBlock !== 'object') {
        return { ok: false, reason: 'ObjectSurface block not found.' };
    }

    if (!objectBlock.parameters || typeof objectBlock.parameters !== 'object') objectBlock.parameters = {};
    if (objectBlock.parameters.zoomPosition === undefined || objectBlock.parameters.zoomPosition === null || String(objectBlock.parameters.zoomPosition).trim() === '') {
        objectBlock.parameters.zoomPosition = 0;
    }
    if (objectBlock.parameters.zoomGroupProfiles === undefined || objectBlock.parameters.zoomGroupProfiles === null || String(objectBlock.parameters.zoomGroupProfiles).trim() === '') {
        const legacyA = String(objectBlock.parameters.zoomGroupAProfile ?? '').trim();
        const legacyB = String(objectBlock.parameters.zoomGroupBProfile ?? '').trim();
        const lines: string[] = [];
        if (legacyA) lines.push(`A=${legacyA}`);
        if (legacyB) lines.push(`B=${legacyB}`);
        objectBlock.parameters.zoomGroupProfiles = lines.length > 0 ? lines.join('\n') : 'A=0:0,1:0';
    }

    const objectBlockId = String(objectBlock.blockId ?? '').trim();
    if (!objectBlockId) return { ok: false, reason: 'ObjectSurface blockId is missing.' };

    const generatedIds = new Set(['zoom-wide', 'zoom-mid', 'zoom-tele']);
    const existingScenarios = Array.isArray(activeCfg.scenarios) ? activeCfg.scenarios : [];
    const preservedScenarios = existingScenarios.filter((scenario: any) => !generatedIds.has(String(scenario?.id ?? '').trim()));
    const buildScenario = (id: string, name: string, zoomPosition: number) => ({
        id,
        name,
        weight: 1,
        overrides: {
            [`${objectBlockId}.zoomPosition`]: zoomPosition
        },
        metadata: { source: 'zoom-mvp' }
    });

    activeCfg.scenarios = [
        ...preservedScenarios,
        buildScenario('zoom-wide', 'Wide', 0),
        buildScenario('zoom-mid', 'Mid', 0.5),
        buildScenario('zoom-tele', 'Tele', 1)
    ];
    activeCfg.activeScenarioId = 'zoom-wide';

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    try {
        saveSystemConfigurations(systemConfig);
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true, count: 3, blockId: objectBlockId };
}

// Design Intent Add/Delete Buttons Setup
function setupDesignIntentButtons(): void {
    const addBtn = document.getElementById('design-intent-add-block-btn');
    const deleteBtn = document.getElementById('design-intent-delete-block-btn');
    const paramAllOnBtn = document.getElementById('design-intent-param-all-on-btn');
    const paramAllOffBtn = document.getElementById('design-intent-param-all-off-btn');
    const autoSetAperturesBtn = document.getElementById('design-intent-auto-set-apertures-btn');
    const zoomScenarioBtn = document.getElementById('design-intent-generate-zoom-scenarios-btn');
    const typeSelect = document.getElementById('design-intent-add-block-type') as HTMLSelectElement | null;
    ensureDesignIntentQuickEditorToggleBinding();

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

                try {
                    __cooptScheduleDesignIntentUiRefresh({
                        forceExpandedRows: true,
                        refreshBlockInspector: true,
                        triggerRender: true,
                        debounceMs: 40,
                    });
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
                try {
                    __cooptScheduleDesignIntentUiRefresh({
                        forceExpandedRows: true,
                        refreshBlockInspector: true,
                        triggerRender: true,
                        debounceMs: 40,
                    });
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

    if (autoSetAperturesBtn && !autoSetAperturesBtn.dataset.designIntentAutoSetAperturesBound) {
        autoSetAperturesBtn.dataset.designIntentAutoSetAperturesBound = '1';
        autoSetAperturesBtn.addEventListener('click', (e) => {
            try { e?.preventDefault?.(); } catch (_) {}
            try { e?.stopPropagation?.(); } catch (_) {}
            try {
                const ok = typeof w.autoSetBlockAperturesFromLargestObjectCondition === 'function'
                    ? w.autoSetBlockAperturesFromLargestObjectCondition()
                    : false;
                if (!ok) {
                    alert('Failed to auto-set apertures.');
                    return;
                }
                try {
                    __cooptScheduleDesignIntentUiRefresh({
                        forceExpandedRows: true,
                        refreshBlockInspector: true,
                        triggerRender: true,
                        debounceMs: 40,
                    });
                } catch (_) {}
            } catch (err) {
                console.error('❌ Failed to auto-set apertures:', err);
                alert(`Failed to auto-set apertures: ${(err as Error)?.message || String(err)}`);
            }
        });
    }

    if (zoomScenarioBtn && !zoomScenarioBtn.dataset.designIntentZoomScenarioBound) {
        zoomScenarioBtn.dataset.designIntentZoomScenarioBound = '1';
        zoomScenarioBtn.addEventListener('click', (e) => {
            try { e?.preventDefault?.(); } catch (_) {}
            try { e?.stopPropagation?.(); } catch (_) {}
            try {
                const res = __blocks_generateZoomScenariosForActiveConfig();
                if (!res || res.ok !== true) {
                    alert(`Failed to generate zoom scenarios: ${res?.reason || 'unknown error'}`);
                    return;
                }
                try {
                    __cooptScheduleDesignIntentUiRefresh({
                        forceExpandedRows: true,
                        refreshBlockInspector: true,
                        refreshZoomUi: true,
                        triggerRender: true,
                        debounceMs: 40,
                    });
                } catch (_) {}
            } catch (e) {
                console.error('❌ Failed to generate zoom scenarios:', e);
                alert(`Failed to generate zoom scenarios: ${(e as Error)?.message || String(e)}`);
            }
        });
    }
}

// Main DOM Event Handlers Setup Function
export function setupDOMEventHandlers(): void {
    try {
        setupImageHeightDiagnosticsBridge();
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
        setupZoomControlTab();
        
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
        allData = await decodeAllDataFromCompressedString(compressed);
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
