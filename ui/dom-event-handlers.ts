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

    const rowsMateriallyDiffer = (a: any[], b: any[]): boolean => {
        if (!Array.isArray(a) || !Array.isArray(b)) return true;
        if (a.length !== b.length) return true;
        const keys = [
            'id', 'object type', 'surfType', 'radius', 'radiusX', 'radiusY', 'thickness', 'semidia',
            'material', 'conic', 'coef1', 'coef2', 'coef3', 'coef4', 'coef5', 'coef6', 'coef7', 'coef8', 'coef9', 'coef10'
        ];
        for (let i = 0; i < a.length; i++) {
            const left = a[i] || {};
            const right = b[i] || {};
            for (const key of keys) {
                const lv = String(left?.[key] ?? '').trim();
                const rv = String(right?.[key] ?? '').trim();
                if (lv !== rv) return true;
            }
        }
        return false;
    };
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

function __cooptCloneCanonicalSystemConfig(): any {
    try {
        const persistedConfig = (typeof loadPersistedSystemConfigurationsFromTableConfig === 'function')
            ? loadPersistedSystemConfigurationsFromTableConfig()
            : null;
        if (persistedConfig && typeof persistedConfig === 'object' && Array.isArray(persistedConfig.configurations) && persistedConfig.configurations.length > 0) {
            return JSON.parse(JSON.stringify(persistedConfig));
        }
    } catch (_) {}
    return __cooptCloneSystemConfig();
}

function __cooptPublishRuntimeSystemConfigSnapshot(systemConfig: any, deferMs = 1500): void {
    try {
        const cloned = systemConfig && typeof systemConfig === 'object'
            ? JSON.parse(JSON.stringify(systemConfig))
            : null;
        if (!cloned) return;
        w.__cooptSystemConfig = cloned;
        w.__cooptPreferRuntimeSystemConfig = true;
        w.__cooptDeferDerivedUiUntil = Date.now() + Math.max(0, Number(deferMs) || 0);
    } catch (_) {}
}

function cooptLoadCanonicalDesignIntentSystemConfig(): any {
    try {
        const persistedConfig = (typeof loadPersistedSystemConfigurationsFromTableConfig === 'function')
            ? loadPersistedSystemConfigurationsFromTableConfig()
            : null;
        if (persistedConfig && Array.isArray(persistedConfig.configurations) && persistedConfig.configurations.length > 0) {
            return persistedConfig;
        }
    } catch (_) {}
    try {
        return (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
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
    isPhysicalBlockType,
    type PhysicalBlockType,
    BLOCK_SCHEMA_VERSION
} from '../data/block-schema.ts';
import { createDefaultPhysicalBlock, normalizeDesignConnections, portsForPhysicalBlock } from '../analysis/hybrid-design.ts';
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
import { calculateParaxialData, getRefractiveIndex } from '../raytracing/core/ray-paraxial.ts';
import {
    loadSystemConfigurations as loadSystemConfigurationsFromTableConfig,
    loadPersistedSystemConfigurations as loadPersistedSystemConfigurationsFromTableConfig,
    saveSystemConfigurations as saveSystemConfigurationsFromTableConfig,
    saveCurrentToActiveConfiguration as saveCurrentToActiveConfigurationFromTableConfig,
    loadActiveConfigurationToTables as loadActiveConfigurationToTablesFromTableConfig,
    shouldPreferImportedOpticalRows,
    clearAllPersistedState,
    getLensSectionInputBinding,
    normalizeLensSectionAnalysisInputs,
    setLensSectionInputBinding,
    type LensSectionInputBinding,
    type LensSectionPort
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
import { loadBundledExampleProjectJson } from '../utils/default-project-loader.ts';
import { createOptimizationActivityGuard } from '../utils/optimization-activity-guard.ts';
import { isTauriRuntime } from '../src/desktop/runtime.ts';
import { saveJsonFromNativeDialog } from '../src/desktop/adapters/file.ts';
import { basenameFromPath } from '../src/desktop/runtime.ts';
import {
    requiresExpandedRowsForDesignIntentChange,
    requiresBlockInspectorRefreshForDesignIntentChange,
    requiresZoomUiRefreshForDesignIntentChange,
    reconcileDesignIntentVariableValues,
    syncDesignIntentParameterToVariable
} from './design-intent-refresh-policy.ts';
import { clearOptimizerStop } from '../src/desktop/ipc/client.ts';
import { createOPDCalculator, createWavefrontAnalyzer } from '../evaluation/wavefront/wavefront.ts';
import { getLastWavefrontMap, getLastWavefrontMeta, patchLastWavefrontMap } from '../evaluation/wavefront/last-wavefront-runtime.ts';

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
const COOPT_AUTO_APERTURE_MARGIN_FACTOR = 1.03;
const COOPT_AUTO_APERTURE_MARGIN_MM = 0.01;

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

function __cooptSetSystemDataText(text: string): void {
    const value = String(text ?? '');
    try {
        w.__cooptSystemDataText = value;
    } catch (_) {}
    try {
        localStorage.setItem('coopt.systemDataText', value);
    } catch (_) {}
    try {
        if (typeof w.__cooptPushSystemDataText === 'function') {
            w.__cooptPushSystemDataText(value);
            return;
        }
    } catch (_) {}
    try {
        const textarea = (document.getElementById('system-data')
            || document.getElementById('systemData')
            || document.querySelector('textarea[data-system-data]')
            || document.querySelector('#system-data, #systemData, textarea.system-data')) as HTMLTextAreaElement | null;
        if (textarea) textarea.value = value;
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
        const shouldApply = forceOverwriteSemidia
            ? (wasMissing || prev === null || Math.abs(maxR - (prev ?? 0)) > 1e-6)
            : (wasMissing || prev === null);
        if (maxR > 0 && shouldApply) {
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

function autoCalculateMissingSemidia(sourceRows: any[], objectRows: any[], options: { entrancePupilDiameterMm?: number; stopSemidiaWasMissing?: boolean; forceOverwriteSemidia?: boolean; strictMaxImageHeightMarginalOnly?: boolean; apertureMarginFactor?: number; apertureMarginMm?: number } = {}): any[] | null {
    console.log('[autoCalculateMissingSemidia] START');
    const tbl = w.tableOpticalSystem || w.opticalSystemTabulator;
    const rows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
    if (!Array.isArray(rows) || rows.length < 2) {
        console.warn('[autoCalculateMissingSemidia] Invalid rows:', rows);
        return null;
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
        if (!Number.isFinite(primaryWavelength) || primaryWavelength <= 0) return null;

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
        return rows;
    } catch (_) {
        return null;
    }
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

        const updatedRows = autoCalculateMissingSemidia(sourceRows, objectRows, {});
        __zmxSyncDesignIntentApertureFromOpticalRows(updatedRows);
        return true;
    } catch (err) {
        console.warn('[DesignIntent] Missing aperture auto-calculation failed:', err);
        return false;
    }
}

function autoSetBlockAperturesFromLargestObjectCondition(): boolean {
    try {
        const systemConfig = (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
        const activeCfg = Array.isArray(systemConfig?.configurations)
            ? (systemConfig.configurations.find((c: any) => c && String(c.id) === String(systemConfig?.activeConfigId)) || systemConfig.configurations[0])
            : null;
        const sourceRows = (() => {
            try {
                if (Array.isArray(activeCfg?.source) && activeCfg.source.length > 0) return activeCfg.source;
            } catch (_) {}
            try { return loadSourceTableData(); } catch (_) { return []; }
        })();
        const objectRows = (() => {
            try {
                if (Array.isArray(activeCfg?.object) && activeCfg.object.length > 0) return activeCfg.object;
            } catch (_) {}
            try { return loadObjectTableData(); } catch (_) { return []; }
        })();

        const opticalRowsForOverwriteCheck = (() => {
            try {
                if (Array.isArray(activeCfg?.opticalSystem) && activeCfg.opticalSystem.length > 0) return activeCfg.opticalSystem;
            } catch (_) {}
            try {
                const tbl = w.tableOpticalSystem || w.opticalSystemTabulator;
                const tableRows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
                if (Array.isArray(tableRows) && tableRows.length > 0) return tableRows;
            } catch (_) {}
            return [];
        })();

        const hasMissingPhysicalSemidia = Array.isArray(opticalRowsForOverwriteCheck)
            && opticalRowsForOverwriteCheck.some((row: any) => __zmxIsPhysicalOpticalRow(row) && __zmxIsMissingSemidia(row));

        const representativeObjectRows = (() => {
            if (!Array.isArray(objectRows) || objectRows.length === 0) return objectRows;
            const angleRows = objectRows
                .map((row: any, index: number) => {
                    const posNorm = String(row?.position ?? row?.object ?? row?.objectType ?? '').trim().toLowerCase();
                    if (posNorm !== 'angle') return null;
                    const x = Number(row?.xHeightAngle ?? row?.x ?? row?.fieldX ?? 0);
                    const y = Number(row?.yHeightAngle ?? row?.y ?? row?.fieldY ?? 0);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                    return { row, index, radius: Math.hypot(x, y) };
                })
                .filter(Boolean) as Array<{ row: any; index: number; radius: number }>;

            if (angleRows.length === 0) return objectRows;
            angleRows.sort((a, b) => b.radius - a.radius);
            const winner = angleRows[0];
            return winner ? [winner.row] : objectRows;
        })();

        let updatedRows = autoCalculateMissingSemidia(sourceRows, representativeObjectRows, {
            forceOverwriteSemidia: hasMissingPhysicalSemidia,
            apertureMarginFactor: COOPT_AUTO_APERTURE_MARGIN_FACTOR,
            apertureMarginMm: COOPT_AUTO_APERTURE_MARGIN_MM
        } as any);
        if (!Array.isArray(updatedRows) || updatedRows.length === 0) {
            const tbl = w.tableOpticalSystem || w.opticalSystemTabulator;
            const tableRows = (tbl && typeof tbl.getData === 'function') ? tbl.getData() : null;
            if (Array.isArray(tableRows) && tableRows.length > 0) {
                updatedRows = tableRows;
            } else if (Array.isArray(activeCfg?.opticalSystem) && activeCfg.opticalSystem.length > 0) {
                updatedRows = activeCfg.opticalSystem;
            }
        }
        if (!Array.isArray(updatedRows) || updatedRows.length === 0) return false;
        __zmxSyncDesignIntentApertureFromOpticalRows(updatedRows);
        return true;
    } catch (err) {
        console.warn('[DesignIntent] Largest-object aperture auto-calculation failed:', err);
        return false;
    }
}

function __zmxSyncDesignIntentApertureFromOpticalRows(rowsOverride: any[] | null = null): void {
    console.log('[__zmxSyncDesignIntentApertureFromOpticalRows] START');
    try {
        const tbl = w.tableOpticalSystem || w.opticalSystemTabulator;
        const tableRows = Array.isArray(rowsOverride) && rowsOverride.length > 0
            ? rowsOverride
            : ((tbl && typeof tbl.getData === 'function') ? tbl.getData() : null);
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
    try { (window as any).__cooptLastLoadFailureReason = ''; } catch (_) {}
    try { localStorage.removeItem('coopt.renderSyncRequest'); } catch (_) {}
    try { delete (window as any).__cooptRenderSnapshotRows; } catch (_) {}
    try { delete (window as any).__cooptRenderSnapshotObjectRows; } catch (_) {}
    try { delete (window as any).__cooptRenderSnapshotSystemConfig; } catch (_) {}
    const failLoad = (reason: string, detail?: any): false => {
        try { (window as any).__cooptLastLoadFailureReason = String(reason || 'unknown-load-failure'); } catch (_) {}
        try { console.error('❌ [Load] ' + reason, detail); } catch (_) {}
        return false;
    };
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
        // Keep a short debounce to avoid duplicate startup apply, but do not
        // block the first render handoff for several seconds.
        (window as any).__cooptSuppressStartupConfigApplyUntil = Date.now() + 1200;
    } catch (_) {}

    // Accept optimizer escape snapshot wrapper files directly.
    // Snapshot files store the design under `systemConfigSnapshot`.
    try {
        const maybeSnapshot = allData as any;
        let wrappedConfig = maybeSnapshot?.systemConfigSnapshot;
        if (!wrappedConfig && maybeSnapshot?.payload && typeof maybeSnapshot.payload === 'object') {
            wrappedConfig = maybeSnapshot.payload.systemConfigSnapshot;
        }
        if (wrappedConfig && typeof wrappedConfig === 'object' && Array.isArray(wrappedConfig.configurations)) {
            allData = wrappedConfig;

            // If a rows snapshot exists, inject it into the active configuration.
            // This preserves the exact row state captured at snapshot save time.
            const rowsSnapshot = Array.isArray(maybeSnapshot?.opticalSystemRowsSnapshot)
                ? maybeSnapshot.opticalSystemRowsSnapshot
                : (Array.isArray(maybeSnapshot?.payload?.opticalSystemRowsSnapshot)
                    ? maybeSnapshot.payload.opticalSystemRowsSnapshot
                    : null);
            const mergedRequirements = Array.isArray(maybeSnapshot?.systemRequirements)
                ? maybeSnapshot.systemRequirements
                : (Array.isArray(maybeSnapshot?.payload?.systemRequirements)
                    ? maybeSnapshot.payload.systemRequirements
                    : null);
            if (mergedRequirements && mergedRequirements.length > 0 && !Array.isArray((allData as any).systemRequirements)) {
                (allData as any).systemRequirements = mergedRequirements;
            }
            if (Array.isArray(maybeSnapshot?.meritFunction) && !Array.isArray((allData as any).meritFunction)) {
                (allData as any).meritFunction = maybeSnapshot.meritFunction;
            }
            if (Array.isArray(maybeSnapshot?.payload?.meritFunction) && !Array.isArray((allData as any).meritFunction)) {
                (allData as any).meritFunction = maybeSnapshot.payload.meritFunction;
            }
            if (Array.isArray(maybeSnapshot?.source) && !Array.isArray((allData as any).source)) {
                (allData as any).source = maybeSnapshot.source;
            }
            if (Array.isArray(maybeSnapshot?.object) && !Array.isArray((allData as any).object)) {
                (allData as any).object = maybeSnapshot.object;
            }
            if (Array.isArray(maybeSnapshot?.payload?.source) && !Array.isArray((allData as any).source)) {
                (allData as any).source = maybeSnapshot.payload.source;
            }
            if (Array.isArray(maybeSnapshot?.payload?.object) && !Array.isArray((allData as any).object)) {
                (allData as any).object = maybeSnapshot.payload.object;
            }

            if (rowsSnapshot && rowsSnapshot.length > 0) {
                const activeId = String((allData as any)?.activeConfigId ?? '').trim();
                const cfgs = Array.isArray((allData as any)?.configurations)
                    ? (allData as any).configurations
                : null;
                const cfgList = Array.isArray(cfgs) ? cfgs : [];
                const activeCfg = cfgList.find((c: any) => String(c?.id ?? '').trim() === activeId) || cfgList[0];
                if (activeCfg && (!Array.isArray(activeCfg.opticalSystem) || activeCfg.opticalSystem.length === 0)) {
                    activeCfg.opticalSystem = rowsSnapshot;
                }
            }
        }
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
            return failLoad('optimization-still-running');
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

    // Ensure candidateConfig has configurations array.
    // Some historical exports are hybrid payloads (top-level source/object/opticalSystem
    // with nested `configurations` object). Try a resilient fallback before failing.
    if (!candidateConfig || !Array.isArray(candidateConfig.configurations)) {
        try {
            const fallbackCfg: any = {
                id: 1,
                name: 'Config 1',
                schemaVersion: BLOCK_SCHEMA_VERSION,
                blocks: Array.isArray(allData?.blocks) ? allData.blocks : [],
                source: Array.isArray(allData?.source) ? allData.source : [],
                object: Array.isArray(allData?.object) ? allData.object : [],
                opticalSystem: Array.isArray(allData?.opticalSystem) ? allData.opticalSystem : [],
                meritFunction: Array.isArray(allData?.meritFunction) ? allData.meritFunction : [],
                systemData: (allData?.systemData && typeof allData.systemData === 'object')
                    ? allData.systemData
                    : { referenceFocalLength: '' },
                metadata: {
                    created: new Date().toISOString(),
                    modified: new Date().toISOString(),
                    locked: false,
                    importedFrom: 'fallback-mixed-shape'
                }
            };

            // If nested configurations exists but was wrapped oddly, prefer its first config as base.
            const nestedConfigs = Array.isArray(allData?.configurations?.configurations)
                ? allData.configurations.configurations
                : [];
            const firstNested = nestedConfigs[0];
            if (firstNested && typeof firstNested === 'object') {
                fallbackCfg.id = firstNested.id ?? fallbackCfg.id;
                fallbackCfg.name = firstNested.name ?? fallbackCfg.name;
                fallbackCfg.schemaVersion = firstNested.schemaVersion ?? fallbackCfg.schemaVersion;
                if (Array.isArray(firstNested.blocks)) fallbackCfg.blocks = firstNested.blocks;
                if (Array.isArray(firstNested.source) && fallbackCfg.source.length === 0) fallbackCfg.source = firstNested.source;
                if (Array.isArray(firstNested.object) && fallbackCfg.object.length === 0) fallbackCfg.object = firstNested.object;
                if (Array.isArray(firstNested.opticalSystem) && fallbackCfg.opticalSystem.length === 0) fallbackCfg.opticalSystem = firstNested.opticalSystem;
                if (Array.isArray(firstNested.meritFunction) && fallbackCfg.meritFunction.length === 0) fallbackCfg.meritFunction = firstNested.meritFunction;
                if (firstNested.systemData && typeof firstNested.systemData === 'object') fallbackCfg.systemData = firstNested.systemData;
            }

            candidateConfig = {
                configurations: [fallbackCfg],
                activeConfigId: fallbackCfg.id,
                meritFunction: Array.isArray(allData?.meritFunction) ? allData.meritFunction : [],
                systemRequirements: Array.isArray(allData?.systemRequirements) ? allData.systemRequirements : [],
                optimizationRules: allData?.optimizationRules || {}
            };
            try { console.warn('⚠️ [Load] Recovered mixed-shape payload via fallback configuration wrapping.'); } catch (_) {}
        } catch (recoveryError) {
            return failLoad('invalid-configurations-format', { candidateConfig, recoveryError });
        }
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
        if (Array.isArray(allData?.systemRequirements)
            && allData.systemRequirements.length > 0
            && (!Array.isArray(candidateConfig.systemRequirements) || candidateConfig.systemRequirements.length === 0)) {
            candidateConfig.systemRequirements = allData.systemRequirements;
        }
    } catch (_) {}

    // If the loaded file includes explicit optical rows that disagree with stored/design-intent
    // block expansion, treat the explicit rows as canonical for this import and refresh blocks.
    try {
        const activeId = candidateConfig?.activeConfigId;
        const cfgs = Array.isArray(candidateConfig?.configurations) ? candidateConfig.configurations : [];
        const activeCfg = cfgs.find((c: any) => String(c?.id ?? '') === String(activeId ?? '')) || cfgs[0];
        const explicitRows = Array.isArray(allData?.opticalSystem) ? allData.opticalSystem : null;
        const configRows = Array.isArray(activeCfg?.opticalSystem) ? activeCfg.opticalSystem : null;
        const hasBlocks = !!(activeCfg && Array.isArray(activeCfg.blocks) && activeCfg.blocks.length > 0);

        if (activeCfg && explicitRows && explicitRows.length > 0 && hasBlocks && rowsMateriallyDiffer(explicitRows, configRows || [])) {
            try {
                const derived = deriveBlocksFromLegacyOpticalSystemRows(explicitRows);
                const fatals = Array.isArray(derived?.issues)
                    ? derived.issues.filter((issue: any) => issue?.severity === 'fatal')
                    : [];
                if (Array.isArray(derived?.blocks) && derived.blocks.length > 0 && fatals.length === 0) {
                    activeCfg.blocks = derived.blocks;
                    activeCfg.opticalSystem = JSON.parse(JSON.stringify(explicitRows));
                    if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
                    activeCfg.metadata.modified = new Date().toISOString();
                    activeCfg.metadata.importRowsPreferred = true;
                    activeCfg.metadata.importRowsPreferredReason = 'explicit-opticalSystem-mismatch';
                    console.warn('⚠️ [Load] Re-derived blocks from explicit opticalSystem because imported rows differed from block expansion.');
                } else {
                    activeCfg.blocks = [];
                    activeCfg.opticalSystem = JSON.parse(JSON.stringify(explicitRows));
                    if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
                    activeCfg.metadata.modified = new Date().toISOString();
                    activeCfg.metadata.importAnalyzeMode = true;
                    activeCfg.metadata.importRowsPreferred = true;
                    activeCfg.metadata.importRowsPreferredReason = 'explicit-opticalSystem-mismatch-derive-failed';
                    console.warn('⚠️ [Load] Explicit opticalSystem differed from blocks and block derivation failed; falling back to surface-row workflow.', fatals);
                }
            } catch (e) {
                activeCfg.blocks = [];
                activeCfg.opticalSystem = JSON.parse(JSON.stringify(explicitRows));
                if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
                activeCfg.metadata.modified = new Date().toISOString();
                activeCfg.metadata.importAnalyzeMode = true;
                activeCfg.metadata.importRowsPreferred = true;
                activeCfg.metadata.importRowsPreferredReason = 'explicit-opticalSystem-mismatch-exception';
                console.warn('⚠️ [Load] Failed to re-derive blocks from explicit opticalSystem; using explicit rows directly.', e);
            }
        }
    } catch (_) {}

    // Process blocks in blocks-only mode. Legacy optical rows are no longer used
    // to reconstruct Design Intent blocks.
    const cfgList = Array.isArray(candidateConfig?.configurations) ? candidateConfig.configurations : [];
    const configurationHasBlocks = (cfg: any) => {
        try {
            return cfg && Array.isArray(cfg.blocks) && cfg.blocks.length > 0;
        } catch (_) { return false; }
    };

    for (const cfg of cfgList) {
        try {
            const hasBlocks = configurationHasBlocks(cfg);
            if (hasBlocks && !shouldPreferImportedOpticalRows(cfg) && typeof w.expandBlocksIntoConfiguration === 'function') {
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
        if (activeCfg && configurationHasBlocks(activeCfg) && !shouldPreferImportedOpticalRows(activeCfg)) {
            const refreshed = (typeof expandBlocksIntoConfiguration === 'function')
                ? expandBlocksIntoConfiguration(activeCfg, { captureLegacyAperture: true })
                : ((typeof w.expandBlocksIntoConfiguration === 'function')
                    ? w.expandBlocksIntoConfiguration(activeCfg, { captureLegacyAperture: true })
                    : null);

            if (!Array.isArray(refreshed?.expandedOpticalSystem) && typeof w.expandBlocksToOpticalSystemRows === 'function') {
                const expanded = w.expandBlocksToOpticalSystemRows(activeCfg.blocks);
                if (Array.isArray(expanded?.rows)) {
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
                if (Array.isArray(cfg.blocks) && cfg.blocks.length > 0 && !shouldPreferImportedOpticalRows(cfg)) {
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

    if (persistedConfigOk) {
        try {
            const importedConfigurations = Array.isArray(candidateConfig?.configurations)
                ? candidateConfig.configurations.map((config: any) => ({
                    id: config?.id,
                    name: config?.name,
                    blocks: Array.isArray(config?.blocks)
                        ? JSON.parse(JSON.stringify(config.blocks))
                        : [],
                }))
                : [];
            localStorage.setItem('coopt.importedDesignIntentBaseline', JSON.stringify({
                version: 1,
                filename: displayName,
                capturedAt: Date.now(),
                activeConfigId: candidateConfig?.activeConfigId,
                configurations: importedConfigurations,
            }));
        } catch (snapshotError) {
            try { localStorage.removeItem('coopt.importedDesignIntentBaseline'); } catch (_) {}
            console.warn('[Load] Imported Design Intent baseline could not be preserved.', snapshotError);
        }
    }

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
        if (effectiveSource === undefined || effectiveSource === null) {
            effectiveSource = loadSourceTableData();
        }
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

    try {
        if (!isStaleLoadSession()) {
            __cooptRequestRenderRedrawWithRows(Array.isArray(effectiveOpticalSystem) ? effectiveOpticalSystem : null);
        }
    } catch (_) {}

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

                // Align legacy loader path with toolbar loader normalization.
                let payload = parsed;
                if (String(parsed?.format || '').trim() === 'coopt-escape-snapshots-archive-v1' && !Array.isArray(parsed?.configurations)) {
                    throw new Error('This file is archive metadata, not a design snapshot. Please load a file under snapshots/*.json.');
                }
                const wrapped = parsed?.systemConfigSnapshot
                    || (parsed?.payload && typeof parsed.payload === 'object' ? parsed.payload.systemConfigSnapshot : null);
                if (wrapped && typeof wrapped === 'object') {
                    payload = wrapped;
                }

                const looksLoadable = !!(
                    payload
                    && typeof payload === 'object'
                    && (
                        Array.isArray(payload?.configurations)
                        || Array.isArray(payload?.opticalSystem)
                        || Array.isArray(payload?.blocks)
                        || Array.isArray(payload?.configurations?.configurations)
                        || Array.isArray(payload?.systemConfigurations?.configurations)
                    )
                );
                if (!looksLoadable) {
                    throw new Error('Selected JSON is not a loadable design format. Choose a design file or snapshots/*.json.');
                }

                const ok = await __loadAllDataObjectIntoApp(payload, { filename: file.name });
                if (!ok) {
                    const reason = String((window as any).__cooptLastLoadFailureReason || '').trim();
                    throw new Error(reason ? `App loader returned false (${reason}).` : 'App loader returned false (reason unavailable; reload app and retry).');
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

const __COOPT_DEFAULT_INF_OBJECT_DISTANCE_MM = 10;

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
    const objectRenderDistanceVal = Number(first?.objectRenderDistance);
    const objectParameters = objectDistanceMode === 'INF'
        ? { objectDistanceMode: 'INF' }
        : { objectDistanceMode: 'Finite' };
    if (objectDistanceMode === 'INF') {
        if (Number.isFinite(objectRenderDistanceVal) && objectRenderDistanceVal > 0) objectParameters.objectDistance = objectRenderDistanceVal;
        else objectParameters.objectDistance = __COOPT_DEFAULT_INF_OBJECT_DISTANCE_MM;
    } else if (Number.isFinite(objectDistanceVal) && objectDistanceVal > 0) {
        objectParameters.objectDistance = objectDistanceVal;
    }
    blocks.push({
        blockId: 'ObjectSurface-1',
        blockType: 'ObjectSurface',
        role: null,
        constraints: {},
        parameters: objectParameters,
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
            if (Number.isFinite(dInf) && dInf > 0) params.objectDistance = dInf;
            else params.objectDistance = __COOPT_DEFAULT_INF_OBJECT_DISTANCE_MM;
            continue;
        }

        params.objectDistanceMode = 'Finite';
        const d = Number(params.objectDistance);
        if (Number.isFinite(d) && d > 0) params.objectDistance = d;
        else delete params.objectDistance;
    }

    if (!hasObjectSurface) {
        blocks.unshift({
            blockId: 'ObjectSurface-1',
            blockType: 'ObjectSurface',
            role: null,
            constraints: {},
            parameters: { objectDistanceMode: 'Finite' },
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
        if (Array.isArray(derived?.blocks) && derived.blocks.length > 0 && fatals.length === 0 && __coopt_shouldAcceptDerivedBlocks(derived.blocks, rows)) {
            blocks = __coopt_normalizeObjectDistanceInBlocks(derived.blocks);
        } else {
            blocks = [];
            if (fatals.length > 0) {
                console.warn('⚠️ [Zemax Import] deriveBlocks had fatals; using explicit rows only:', fatals);
            } else if (Array.isArray(derived?.blocks) && derived.blocks.length > 0) {
                console.warn('⚠️ [Zemax Import] derived blocks were too lossy; using explicit rows only.');
            }
        }
    } catch (e) {
        console.warn('⚠️ [Zemax Import] deriveBlocks failed; using explicit rows only:', e);
        blocks = [];
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
                importedFrom: 'zemax',
                importAnalyzeMode: blocks.length === 0,
                importRowsPreferred: true
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
                    const hasMissingSemidia = parsedRows.some((row: any, index: number) => {
                        const objectType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
                        if (objectType === 'object' || objectType === 'ct') return false;
                        if (index === 0) return false;
                        return __zmxIsMissingSemidia(row);
                    });
                    const imageSurfaceIndex = parsedRows.findIndex((row: any, index: number) => {
                        if (index === parsedRows.length - 1) return true;
                        const objectType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
                        return objectType === 'image';
                    });
                    const imageSemidiaMissing = imageSurfaceIndex < 0 || __zmxIsMissingSemidia(parsedRows[imageSurfaceIndex]);

                    if (hasMissingSemidia || stopSemidiaWasMissing) {
                        autoCalculateMissingSemidia(
                            Array.isArray(parsed?.sourceRows) ? parsed.sourceRows : [],
                            Array.isArray(parsed?.objectRows) ? parsed.objectRows : [],
                            {
                                entrancePupilDiameterMm: Number(parsed?.entrancePupilDiameterMm),
                                stopSemidiaWasMissing
                            }
                        );
                    }

                    if (!imageSemidiaMissing) {
                        (w as any).__cooptSkipImportImageSemidiaAutoFill = true;
                    }
                } catch (_) {}

                try {
                    if ((w as any).__cooptSkipImportImageSemidiaAutoFill !== true && typeof w.calculateImageSemiDiaFromChiefRays === 'function') {
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
                    delete (w as any).__cooptSkipImportImageSemidiaAutoFill;
                } catch (_) {}

                try {
                    __zmxSyncDesignIntentApertureFromOpticalRows();
                } catch (_) {}
                try {
                    const importedRows = Array.isArray(parsed?.rows) ? parsed.rows : null;
                    __cooptRequestRenderRedrawWithRows(Array.isArray(importedRows) ? importedRows : null);
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
                const systemConfig = __cooptCloneSystemConfig();
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
            <option value="kkt" selected>AL + Gauss-Newton (July 27)</option>
            <option value="kkt-sqp">KKT-SQP</option>
            <option value="global">Global (Escape Function)</option>
            <option value="lm">Levenberg-Marquardt (LM)</option>
            <option value="cd">Coordinate Descent (CD)</option>
        </select>
    </label>
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        Max Iterations
        <input id="opt-max-iter" type="number" min="1" step="1" value="5000" style="width:100px; padding:4px 6px;" />
    </label>
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        W
        <input id="opt-escape-width" type="number" min="0" step="0.01" value="1" style="width:100px; padding:4px 6px;" />
    </label>
    <label style="font-size:12px; color:#555; display:flex; align-items:center; gap:6px;">
        H
        <input id="opt-escape-height" type="number" min="0" step="0.01" value="0.1" style="width:100px; padding:4px 6px;" />
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

                const snap = getRequirementScoreSnapshot();
                const tableRequirementScore = Number(snap.score);
                const displayCurrentScore = Number.isFinite(tableRequirementScore)
                    ? tableRequirementScore
                    : Number.NaN;
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
                            let skipFinalReevalForBestSnapshot = false;
                            try {
                                const bestSnapshotState = w.__cooptOptimizeBestRequirementSnapshotApplied;
                                const appliedAt = Number(bestSnapshotState?.at ?? 0);
                                skipFinalReevalForBestSnapshot = phaseStr === 'done'
                                    && Number.isFinite(appliedAt)
                                    && appliedAt > 0
                                    && (Date.now() - appliedAt) < 10000;
                            } catch (_) {}
                            if (!skipFinalReevalForBestSnapshot && sre && typeof sre.evaluateAndUpdateNow === 'function') {
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
                const optimizationActivityGuard = createOptimizationActivityGuard('legacy-optimize');

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
                    await optimizationActivityGuard.acquire();
                    // Save state before optimization for undo
                    let beforeOptimizationState: any = null;
                    try {
                        beforeOptimizationState = __cooptCloneCanonicalSystemConfig();
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
                        const systemConfig = __cooptCloneCanonicalSystemConfig();
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
                        const trustRegionDelta = readNum('opt-trust-region-delta', 0.05);
                        const trustRegionDeltaMax = Math.max(trustRegionDelta, readNum('opt-trust-region-delta-max', 1.0));

                        return {
                            escapeFunctionWidth: readNum('opt-escape-width', 1),
                            escapeFunctionHeight: readNum('opt-escape-height', 0.1),
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
                            useWasmLinearSolve: true,
                            profile: false
                        };
                    };

                    const maxIterations = resolveMaxIterations();
                    const optParams = resolveOptParams();
                    setPreRunProgress('prepare', `Options resolved (maxIter=${maxIterations})`);

                    try {
                        const convText = `maxIter=${maxIterations}`;
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
                        let method = 'kkt';
                        try {
                            if (popup && !popup.closed) {
                                const el = popup.document.getElementById('opt-method') as HTMLSelectElement | null;
                                const v = el ? String(el.value).toLowerCase().trim() : '';
                                if (v === 'cd' || v === 'lm' || v === 'kkt' || v === 'kkt-sqp' || v === 'global') {
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
                                const afterOptimizationState = __cooptCloneCanonicalSystemConfig();
                                __cooptPublishRuntimeSystemConfigSnapshot(afterOptimizationState, 60000);
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
                        await optimizationActivityGuard.release();
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
        } catch (_) {
            return null;
        }
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
    const newHandler = async () => {
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
            
            try {
                const { setLoadedFileName } = await import('./loaded-file-storage.ts');
                setLoadedFileName('new-project-template.json');
            } catch (_) {}
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
            let filename = 'optical_system_data.json';
            if (loadedFileName) {
                filename = loadedFileName;
            }
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
            const data = await loadBundledExampleProjectJson('default-load.json');
            
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

function isThreeBlockPlaceholderConfiguration(systemConfig: any): boolean {
    try {
        const cfgs = Array.isArray(systemConfig?.configurations) ? systemConfig.configurations : [];
        if (cfgs.length !== 1) return false;

        const activeId = systemConfig?.activeConfigId;
        const activeCfg = cfgs.find((c: any) => String(c?.id ?? '') === String(activeId ?? '')) || cfgs[0];
        if (!activeCfg || typeof activeCfg !== 'object') return false;

        const blocks = Array.isArray(activeCfg.blocks) ? activeCfg.blocks : [];
        if (blocks.length !== 3) return false;

        const blockTypes = blocks.map((b: any) => String(b?.blockType ?? '').trim()).sort();
        const expected = ['ImageSurface', 'ObjectSurface', 'Stop'];
        if (blockTypes.length !== expected.length) return false;
        for (let i = 0; i < expected.length; i++) {
            if (blockTypes[i] !== expected[i]) return false;
        }

        const opticalLen = Array.isArray(activeCfg.opticalSystem) ? activeCfg.opticalSystem.length : 0;
        if (opticalLen > 3) return false;

        return true;
    } catch (_) {
        return false;
    }
}

async function maybeAutoRecoverDefaultLensData(): Promise<void> {
    try {
        if ((window as any).__cooptAutoRecoverDefaultLensDataStarted) return;
        (window as any).__cooptAutoRecoverDefaultLensDataStarted = true;
    } catch (_) {}

    try {
        // Never auto-recover while an explicit file/URL load is in progress.
        if ((window as any).__cooptFileLoadInProgress) return;

        const compressed = getCompressedStringFromLocation();
        if (compressed) return;

        const markerKey = 'coopt.autoRecoverDefaultLensData.v1';

        const systemConfig = loadSystemConfigurations();
        const markerDone = (() => {
            try { return localStorage.getItem(markerKey) === 'done'; } catch (_) { return false; }
        })();
        const isPlaceholder = isThreeBlockPlaceholderConfiguration(systemConfig);
        if (markerDone && !isPlaceholder) return;
        if (!isPlaceholder) return;

        let loadedFileName = '';
        try {
            const { getLoadedFileName } = await import('./loaded-file-storage.ts');
            loadedFileName = String(getLoadedFileName() || '').trim();
        } catch (_) {}
        const normalizedLoadedName = loadedFileName.toLowerCase();
        const looksDefaultLabel = normalizedLoadedName.includes('default-load.json') || normalizedLoadedName.includes('/default-load.json');
        if (loadedFileName && !looksDefaultLabel) return;

        const defaultData = await loadBundledExampleProjectJson('default-load.json');
        const loaded = await __loadAllDataObjectIntoApp(defaultData, { filename: 'default-load.json' });
        if (loaded) {
            try { localStorage.setItem(markerKey, 'done'); } catch (_) {}
            console.log('✅ [AutoRecover] Loaded default lens data from placeholder 3-block state.');
        }
    } catch (err) {
        console.warn('⚠️ [AutoRecover] Failed to auto-recover default lens data:', err);
    }
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

            __cooptSetSystemDataText(formatSeidelCoefficients(result));

            if (typeof w.renderBlockContributionSummaryFromSeidel === 'function') {
                try {
                    w.renderBlockContributionSummaryFromSeidel(result, opticalSystemRows);
                } catch (e) {
                    console.warn('⚠️ Block contribution summary render failed (afocal):', e);
                }
            }
        } catch (error: any) {
            console.error('❌ アフォーカル系Seidel係数計算ボタンエラー:', error);
            alert(`エラーが発生しました: ${error.message}`);
        }
    });
}

function setupZernikeFitButton(): void {
    const btn = document.getElementById('zernike-fit-btn');
    if (!btn) return;
    if ((btn as any).dataset?.cooptBoundZernike === '1') return;
    (btn as any).dataset.cooptBoundZernike = '1';

    btn.addEventListener('click', async () => {
        try {
            const wavefrontMap = getLastWavefrontMap(w);
            const wavefrontMeta = getLastWavefrontMeta(w);
            if (!wavefrontMap || wavefrontMap?.error) {
                alert('Zernike fitting 用の波面データがありません。先に Show wavefront diagram を実行してください。');
                return;
            }

            const opticalSystemRows = (typeof w.getOpticalSystemRows === 'function')
                ? w.getOpticalSystemRows()
                : w.tableOpticalSystem;
            if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
                alert('光学系データがありません。');
                return;
            }

            const wavelength = (() => {
                const fromMeta = Number(wavefrontMeta?.wavelength);
                if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
                if (typeof w.getPrimaryWavelength === 'function') {
                    const wl = Number(w.getPrimaryWavelength());
                    if (Number.isFinite(wl) && wl > 0) return wl;
                }
                return NaN;
            })();
            if (!Number.isFinite(wavelength) || wavelength <= 0) {
                alert('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
                return;
            }

            const calculator = createOPDCalculator(opticalSystemRows, wavelength);
            const analyzer = createWavefrontAnalyzer(calculator);
            let reportWavefrontMap = wavefrontMap?.referenceSphereReport || wavefrontMap;

            if (
                reportWavefrontMap?.opdMode === 'native-grid' &&
                reportWavefrontMap?.fieldSetting &&
                typeof analyzer?.generateWavefrontMap === 'function'
            ) {
                try {
                    const reportGridSize = Number.isFinite(Number(reportWavefrontMap?.gridSizeRequested))
                        ? Math.max(4, Math.floor(Number(reportWavefrontMap.gridSizeRequested)))
                        : (Number.isFinite(Number(reportWavefrontMap?.gridSize)) ? Math.max(4, Math.floor(Number(reportWavefrontMap.gridSize))) : 64);
                    const referenceReportMap = await analyzer.generateWavefrontMap(
                        reportWavefrontMap.fieldSetting,
                        reportGridSize,
                        'circular',
                        {
                            recordRays: false,
                            progressEvery: 1024,
                            opdMode: 'referenceSphere',
                            opdDisplayMode: 'pistonTiltRemoved',
                            zernikeMaxNoll: 37,
                            renderFromZernike: false,
                            skipZernikeFit: false,
                            suppressReferenceRayError: false,
                        }
                    );
                    if (referenceReportMap?.zernike?.coefficientsMicrons) {
                        reportWavefrontMap = referenceReportMap;
                    }
                } catch (_) {}
            }

            if (!reportWavefrontMap?.zernike && Array.isArray(reportWavefrontMap?.pupilCoordinates) && Array.isArray(reportWavefrontMap?.raw?.opds)) {
                const sampleCount = reportWavefrontMap.raw.opds.length;
                const maxNoll = Math.max(1, Math.min(37, sampleCount));
                if (sampleCount > 0 && typeof analyzer?.fitZernikePolynomials === 'function') {
                    const fitted = analyzer.fitZernikePolynomials({
                        pupilCoordinates: reportWavefrontMap.pupilCoordinates,
                        opds: reportWavefrontMap.raw.opds,
                        pupilRange: reportWavefrontMap?.pupilRange,
                    }, maxNoll);
                    if (reportWavefrontMap === wavefrontMap) {
                        patchLastWavefrontMap((map) => {
                            map.zernike = fitted;
                        }, { host: w, fallbackMap: reportWavefrontMap });
                    }
                    reportWavefrontMap = {
                        ...reportWavefrontMap,
                        zernike: fitted,
                    };
                }
            }

            const reportText = analyzer.formatZernikeReportText(reportWavefrontMap, { maxNoll: 37 });
            __cooptSetSystemDataText(typeof reportText === 'string' ? reportText : String(reportText ?? ''));
        } catch (error: any) {
            console.error('❌ Zernike fitting button error:', error);
            alert(`Zernike fitting failed: ${error?.message || String(error)}`);
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

        const chiefRayEl = document.getElementById('mca-chief-ray-definition') as HTMLSelectElement | null;
        const chiefRayDefinition = (chiefRayEl && chiefRayEl.value) ? chiefRayEl.value : 'stop-center';

        w.showMagnificationChromaticAberrationDiagram({ onProgress, chiefRayDefinition });
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
    saveCurrentToActiveConfigurationFromTableConfig();
}

export function loadActiveConfigurationToTables(options: any = {}): Promise<void> {
    return loadActiveConfigurationToTablesFromTableConfig(options);
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
        saveCurrentToActiveConfiguration: base.saveCurrentToActiveConfiguration || saveCurrentToActiveConfigurationFromTableConfig,
        loadActiveConfigurationToTables: base.loadActiveConfigurationToTables || loadActiveConfigurationToTablesFromTableConfig,
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
let __designIntentQuickEditorDelegatedBindingInstalled = false;
let __designIntentToolbarDelegatedBindingInstalled = false;

function readDesignIntentQuickEditorEnabled(): boolean {
    return true;
}

function writeDesignIntentQuickEditorEnabled(enabled: boolean): void {
    void enabled;
}

function syncDesignIntentQuickEditorToggle(): void {
    // Quick editor is always enabled.
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
        return;
    }

    __designIntentQuickEditorDelegatedBindingInstalled = true;
}

function __blocks_shouldMarkVar(v: any): boolean {
    if (!v || typeof v !== 'object') return false;
    const mode = v?.optimize?.mode;
    return mode === 'V' || mode === true;
}

function __blocks_getVarEntryForKey(vars: any, key: string): any {
    if (!vars || typeof vars !== 'object') return undefined;
    const rawKey = String(key ?? '').trim();
    if (!rawKey) return undefined;
    const directEntry = Object.prototype.hasOwnProperty.call(vars, rawKey) ? vars[rawKey] : undefined;

    const lower = rawKey.toLowerCase();
    const materialMatch = lower.match(/^(material|rindex|nd|abbe|vd)(\d*)$/);
    if (!materialMatch) return directEntry;

    const family = materialMatch[1];
    const suffix = materialMatch[2] || '';
    const aliasKeys = family === 'abbe'
        ? [`vd${suffix}`]
        : family === 'vd'
            ? [`abbe${suffix}`]
            : family === 'rindex'
                ? [`nd${suffix}`]
                : family === 'nd'
                    ? [`rindex${suffix}`]
                    : [];

            // Keep glass family aliases (abbe<->vd, rindex<->nd) logically in sync for UI state.
            // If either side is marked optimize=V, prefer that entry so checkbox state is stable.
            const directMarked = __blocks_shouldMarkVar(directEntry);
            if (directMarked) return directEntry;

    for (const aliasKey of aliasKeys) {
        if (Object.prototype.hasOwnProperty.call(vars, aliasKey)) {
                    const aliasEntry = vars[aliasKey];
                    if (__blocks_shouldMarkVar(aliasEntry)) return aliasEntry;
                    if (directEntry === undefined) return aliasEntry;
        }
    }
            return directEntry;
}

        function __blocks_getAliasKeyForMaterialFamily(key: string): string | null {
            const rawKey = String(key ?? '').trim();
            if (!rawKey) return null;
            const lower = rawKey.toLowerCase();
            const materialMatch = lower.match(/^(material|rindex|nd|abbe|vd)(\d*)$/);
            if (!materialMatch) return null;

            const family = materialMatch[1];
            const suffix = materialMatch[2] || '';
            if (family === 'abbe') return `vd${suffix}`;
            if (family === 'vd') return `abbe${suffix}`;
            if (family === 'rindex') return `nd${suffix}`;
            if (family === 'nd') return `rindex${suffix}`;
            return null;
        }

function __blocks_resolveVarStorageKey(vars: any, key: string): string {
    const rawKey = String(key ?? '').trim();
    if (!rawKey) return rawKey;
    if (!vars || typeof vars !== 'object') return rawKey;
    if (Object.prototype.hasOwnProperty.call(vars, rawKey)) return rawKey;

    const lower = rawKey.toLowerCase();
    const materialMatch = lower.match(/^(material|rindex|nd|abbe|vd)(\d*)$/);
    if (!materialMatch) return rawKey;

    const family = materialMatch[1];
    const suffix = materialMatch[2] || '';
    const aliasKeys = family === 'abbe'
        ? [`vd${suffix}`]
        : family === 'vd'
            ? [`abbe${suffix}`]
            : family === 'rindex'
                ? [`nd${suffix}`]
                : family === 'nd'
                    ? [`rindex${suffix}`]
                    : [];

    for (const aliasKey of aliasKeys) {
        if (Object.prototype.hasOwnProperty.call(vars, aliasKey)) {
            return aliasKey;
        }
    }

    return rawKey;
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

function __blocks_getPreferredBulkGlassVarFamily(block: any, suffix: string): 'material' | 'numeric' {
    const normalizedSuffix = String(suffix ?? '').trim();
    const materialKey = `material${normalizedSuffix}`;
    const rindexKey = `rindex${normalizedSuffix}`;
    const abbeKey = `abbe${normalizedSuffix}`;
    const vdKey = `vd${normalizedSuffix}`;
    const ndKey = `nd${normalizedSuffix}`;

    const materialVar = block?.variables?.[materialKey];
    if (__blocks_shouldMarkVar(materialVar)) {
        return 'material';
    }

    const numericVarKeys = [rindexKey, abbeKey, vdKey, ndKey];
    if (numericVarKeys.some((key) => __blocks_shouldMarkVar(block?.variables?.[key]))) {
        return 'numeric';
    }

    const params = (block?.parameters && typeof block.parameters === 'object') ? block.parameters : null;
    const materialValue = String(params?.[materialKey] ?? '').trim();
    const rindexValue = String(params?.[rindexKey] ?? params?.[ndKey] ?? '').trim();
    const abbeValue = String(params?.[abbeKey] ?? params?.[vdKey] ?? '').trim();

    if (materialValue !== '') {
        return 'material';
    }
    if (rindexValue !== '' || abbeValue !== '') {
        return 'numeric';
    }

    return 'material';
}

function __blocks_getBulkOptimizeModeForParameter(block: any, key: string, enabled: boolean): 'V' | 'F' {
    if (!enabled) {
        return 'F';
    }

    const normalizedKey = String(key ?? '').trim().toLowerCase();
    const match = normalizedKey.match(/^(material|rindex|abbe|vd|nd)(\d*)$/);
    if (!match) {
        return 'V';
    }

    const family = match[1];
    const suffix = match[2] || '';
    const preferredFamily = __blocks_getPreferredBulkGlassVarFamily(block, suffix);
    const shouldEnable = family === 'material'
        ? preferredFamily === 'material'
        : preferredFamily === 'numeric';

    return shouldEnable ? 'V' : 'F';
}

function __blocks_getVisibleParameterKeys(block: any): string[] {
    const params = (block?.parameters && typeof block.parameters === 'object') ? block.parameters : {};
    const blockType = String(block?.blockType || block?.type || 'unknown');
    const keys = Object.keys(params || {}).filter((key) => {
        const kl = String(key ?? '').trim().toLowerCase();
        if (kl === 'chiefrayshiftx' || kl === 'chiefrayshifty' || kl === 'chiefrayshiftz') return false;
        if (kl === 'zoomgroupaprofile' || kl === 'zoomgroupbprofile') return false;
        if (blockType === 'Doublet' && kl === 'bending') return false;
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

    if ((blockType === 'Gap' || blockType === 'AirGap') && !keys.includes('material')) keys.push('material');
    if ((blockType === 'Gap' || blockType === 'AirGap') && !keys.includes('thicknessMode')) keys.push('thicknessMode');
    if ((blockType === 'ObjectSurface' || blockType === 'ObjectPlane') && !keys.includes('objectDistance')) keys.push('objectDistance');
    if (blockType === 'ImageSurface') {
        if (!keys.includes('semidiaMode')) keys.push('semidiaMode');
        if (!keys.includes('apertureShape')) keys.push('apertureShape');
        if (!keys.includes('apertureWidth')) keys.push('apertureWidth');
        if (!keys.includes('apertureHeight')) keys.push('apertureHeight');
        if (!keys.includes('radius')) keys.push('radius');
        if (!keys.includes('thickness')) keys.push('thickness');
        if (!keys.includes('surfType')) keys.push('surfType');
        if (!keys.includes('conic')) keys.push('conic');
        for (let index = 1; index <= 10; index++) {
            const coefKey = `coef${index}`;
            if (!keys.includes(coefKey)) keys.push(coefKey);
        }
    }
    if (blockType === 'Paraxial') {
        if (!keys.includes('surfType')) keys.push('surfType');
        if (!keys.includes('focalLengthX')) keys.push('focalLengthX');
        if (!keys.includes('focalLengthY')) keys.push('focalLengthY');
    }
    if (blockType === 'Lens' || blockType === 'PositiveLens') {
        if (!keys.includes('bending')) keys.push('bending');
    }
    if ((blockType === 'Lens' || blockType === 'PositiveLens') && !keys.includes('rindex')) keys.push('rindex');
    if ((blockType === 'Lens' || blockType === 'PositiveLens') && !keys.includes('abbe')) keys.push('abbe');
    if (blockType === 'Doublet') {
        if (!keys.includes('rindex1')) keys.push('rindex1');
        if (!keys.includes('rindex2')) keys.push('rindex2');
        if (!keys.includes('abbe1')) keys.push('abbe1');
        if (!keys.includes('abbe2')) keys.push('abbe2');
    }
    if (blockType === 'Triplet') {
        if (!keys.includes('rindex1')) keys.push('rindex1');
        if (!keys.includes('rindex2')) keys.push('rindex2');
        if (!keys.includes('rindex3')) keys.push('rindex3');
        if (!keys.includes('abbe1')) keys.push('abbe1');
        if (!keys.includes('abbe2')) keys.push('abbe2');
        if (!keys.includes('abbe3')) keys.push('abbe3');
    }
    if (blockType === 'Stop' && !keys.includes('semiDiameter')) keys.push('semiDiameter');
    if (blockType !== 'Gap' && blockType !== 'AirGap' && blockType !== 'Stop' && blockType !== 'ImageSurface' && blockType !== 'ObjectSurface' && blockType !== 'ObjectPlane') {
        if (!keys.includes('zoomGroup')) keys.push('zoomGroup');
    }
    if (blockType === 'Lens' || blockType === 'PositiveLens' || blockType === 'SingleSurface' || blockType === 'Mirror') {
        if (!keys.includes('frontSurfType')) keys.push('frontSurfType');
        if (!keys.includes('backSurfType')) keys.push('backSurfType');
        for (let index = 1; index <= 10; index++) {
            const frontCoefKey = `frontCoef${index}`;
            const backCoefKey = `backCoef${index}`;
            if (!keys.includes(frontCoefKey)) keys.push(frontCoefKey);
            if (!keys.includes(backCoefKey)) keys.push(backCoefKey);
        }
    }

    return keys.filter((key) => {
        if (blockType === 'ImageSurface' && key === 'optimizeSemiDia') return false;
        if (blockType === 'ImageSurface' && key === 'thickness') return false;
        if (/^coef\d+$/.test(key) && params.surfType === 'Spherical') return false;
        if (/^frontCoef\d+$/.test(key) && params.frontSurfType === 'Spherical') return false;
        if (/^backCoef\d+$/.test(key) && params.backSurfType === 'Spherical') return false;
        if (/^surf1Coef\d+$/.test(key) && params.surf1SurfType === 'Spherical') return false;
        if (/^surf2Coef\d+$/.test(key) && params.surf2SurfType === 'Spherical') return false;
        if (/^surf3Coef\d+$/.test(key) && params.surf3SurfType === 'Spherical') return false;
        return true;
    });
}

function __blocks_getVisibleApertureKeys(block: any): string[] {
    const blockType = String(block?.blockType || block?.type || 'unknown');
    const aperture = (blockType !== 'Stop' && block?.aperture && typeof block.aperture === 'object') ? block.aperture : null;
    const keys: string[] = [];
    const pushUnique = (key: string) => {
        if (!keys.includes(key)) keys.push(key);
    };
    const pushFirstAlias = (aliases: string[], fallbackKey?: string) => {
        for (const alias of aliases) {
            if (aperture && Object.prototype.hasOwnProperty.call(aperture, alias)) {
                pushUnique(alias);
                return;
            }
        }
        if (fallbackKey) pushUnique(fallbackKey);
    };

    if (blockType === 'Paraxial') {
        pushFirstAlias(['s1', 'front', 'back', 'surf1', 'surf2'], 'front');
        return keys;
    }
    if (blockType === 'Lens' || blockType === 'PositiveLens') {
        pushFirstAlias(['s1', 'front', 'surf1'], 'front');
        pushFirstAlias(['s2', 'back', 'surf2'], 'back');
        return keys;
    }
    if (blockType === 'Doublet') {
        pushFirstAlias(['s1', 'front', 'surf1'], 's1');
        pushFirstAlias(['s2', 'middle', 'mid', 'center', 'surf2'], 's2');
        pushFirstAlias(['s3', 'back', 'rear', 'surf3'], 's3');
        return keys;
    }
    if (blockType === 'Triplet') {
        pushFirstAlias(['s1', 'front', 'surf1'], 's1');
        pushFirstAlias(['s2', 'surf2'], 's2');
        pushFirstAlias(['s3', 'surf3'], 's3');
        pushFirstAlias(['s4', 'back', 'rear', 'surf4'], 's4');
        return keys;
    }
    if (blockType === 'SingleSurface' || blockType === 'Mirror') {
        pushFirstAlias(['semidia', 's1', 'front'], 'semidia');
        return keys;
    }
    if (aperture) {
        for (const key of Object.keys(aperture)) {
            pushUnique(key);
        }
    }
    return keys;
}

function __blocks_setVarScope(blockId: string, key: string, scope: string): void {
    try {
        const systemConfig = cooptLoadCanonicalDesignIntentSystemConfig();
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) return;

        const activeId = systemConfig.activeConfigId;
        const cfgIdx = systemConfig.configurations.findIndex((c: any) => c && c.id === activeId);
        if (cfgIdx < 0) return;

        const activeCfg = systemConfig.configurations[cfgIdx];
        if (!activeCfg || !Array.isArray(activeCfg.blocks)) return;

        const b = activeCfg.blocks.find((x: any) => x && String(x.blockId ?? '') === String(blockId));
        if (!b) return;
        if (String(b?.blockType ?? '').trim() === 'Stop') {
            b.variables = {};
            saveSystemConfigurations(systemConfig);
            return;
        }

        const initialValue = ((String(key ?? '').trim().toLowerCase() === 'bending')
            && !!cooptGetBendingConfigForBlock(b))
            ? cooptComputeLensBendingValue(b, String(b?.blockType ?? '').trim())
            : (cooptGetBlockNumericValue(b, key) ?? '');

        if (!b.variables || typeof b.variables !== 'object') b.variables = {};
        const storageKey = __blocks_resolveVarStorageKey(b.variables, key) || String(key ?? '').trim();
        if (!b.variables[storageKey] || typeof b.variables[storageKey] !== 'object') b.variables[storageKey] = { value: initialValue };
        if (!b.variables[storageKey].optimize || typeof b.variables[storageKey].optimize !== 'object') b.variables[storageKey].optimize = {};
        b.variables[storageKey].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';

        const aliasKey = __blocks_getAliasKeyForMaterialFamily(storageKey);
        if (aliasKey && b.variables[aliasKey] && typeof b.variables[aliasKey] === 'object') {
            if (!b.variables[aliasKey].optimize || typeof b.variables[aliasKey].optimize !== 'object') b.variables[aliasKey].optimize = {};
            b.variables[aliasKey].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';
        }

        try {
            __cooptRememberBlockVariablesForConfig(String(activeCfg?.id ?? activeId ?? ''), [b]);
        } catch (_) {}

        try {
            saveSystemConfigurations(systemConfig);
        } catch (_) {}
    } catch (_) {}
}

function __blocks_sequentialGroupKey(value: any): string {
    return String(value ?? '').trim()
        .replace(/^sequential-group:/, '')
        .replace(/^sequential:/, '') || 'main';
}

function __blocks_ensureSequentialGroup(activeCfg: any, groupId: string): any {
    if (!activeCfg || typeof activeCfg !== 'object') return null;
    if (!Array.isArray(activeCfg.sequentialGroups)) activeCfg.sequentialGroups = [];
    const key = __blocks_sequentialGroupKey(groupId);
    let group = activeCfg.sequentialGroups.find((entry: any) => __blocks_sequentialGroupKey(entry?.id) === key);
    if (!group) {
        group = {
            id: key,
            label: key === 'main' ? 'Lens design 1' : `Lens design ${activeCfg.sequentialGroups.length + 1}`,
            blockIds: [],
            pathLabel: key === 'main' ? 'main' : key,
            rootTransform: {
                positionMm: { x: 0, y: 0, z: 0 },
                rotationDeg: { x: 0, y: 0, z: 0 }
            }
        };
        activeCfg.sequentialGroups.push(group);
    }
    if (!Array.isArray(group.blockIds)) group.blockIds = [];
    return group;
}

function __blocks_assignSequentialBlockToGroup(activeCfg: any, blockId: string, groupId: string): boolean {
    const id = String(blockId ?? '').trim();
    if (!activeCfg || !id || !Array.isArray(activeCfg.blocks)) return false;
    const block = activeCfg.blocks.find((entry: any) => String(entry?.blockId ?? '').trim() === id);
    if (!block || isPhysicalBlockType(String(block?.blockType ?? ''))) return false;

    const target = __blocks_ensureSequentialGroup(activeCfg, groupId);
    if (!target) return false;
    for (const group of activeCfg.sequentialGroups) {
        if (!Array.isArray(group?.blockIds)) group.blockIds = [];
        group.blockIds = group.blockIds.filter((candidate: any) => String(candidate ?? '').trim() !== id);
    }
    target.blockIds.push(id);
    const orderById = new Map<string, number>();
    activeCfg.blocks.forEach((entry: any, index: number) => {
        const entryId = String(entry?.blockId ?? '').trim();
        if (entryId) orderById.set(entryId, index);
    });
    target.blockIds.sort((left: any, right: any) => (
        (orderById.get(String(left ?? '').trim()) ?? Number.MAX_SAFE_INTEGER)
        - (orderById.get(String(right ?? '').trim()) ?? Number.MAX_SAFE_INTEGER)
    ));
    return true;
}

function __blocks_groupIdForBlock(activeCfg: any, blockId: string): string {
    const id = String(blockId ?? '').trim();
    if (!id) return '';
    const group = (Array.isArray(activeCfg?.sequentialGroups) ? activeCfg.sequentialGroups : []).find((entry: any) => (
        Array.isArray(entry?.blockIds)
        && entry.blockIds.some((candidate: any) => String(candidate ?? '').trim() === id)
    ));
    if (group) return __blocks_sequentialGroupKey(group.id);
    const block = Array.isArray(activeCfg?.blocks)
        ? activeCfg.blocks.find((entry: any) => String(entry?.blockId ?? '').trim() === id)
        : null;
    return block && !isPhysicalBlockType(String(block?.blockType ?? '')) ? 'main' : '';
}

function __blocks_updateLensSectionInput(
    sectionId: string,
    port: LensSectionPort,
    patch: Partial<LensSectionInputBinding>
): void {
    try {
        const systemConfig = cooptLoadCanonicalDesignIntentSystemConfig();
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) return;
        const activeCfg = systemConfig.configurations.find((entry: any) => (
            String(entry?.id ?? '') === String(systemConfig.activeConfigId ?? '')
        ));
        if (!activeCfg) return;
        normalizeLensSectionAnalysisInputs(activeCfg);
        const current = getLensSectionInputBinding(activeCfg, sectionId, port);
        setLensSectionInputBinding(activeCfg, { ...current, ...patch, sectionId, port });
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
        saveSystemConfigurationsFromTableConfig(systemConfig);
        try { window.dispatchEvent(new CustomEvent('coopt:analysis-input-sets-updated')); } catch (_) {}
        try { window.dispatchEvent(new CustomEvent('coopt:system-configurations-updated')); } catch (_) {}
    } catch (_) {}
}

function __blocks_refreshExpandedRows(activeCfg: any): void {
    try {
        if (typeof expandBlocksToOpticalSystemRows === 'function' && Array.isArray(activeCfg?.blocks)) {
            const exp = expandBlocksToOpticalSystemRows(activeCfg.blocks);
            if (exp && Array.isArray(exp.rows)) {
                activeCfg.opticalSystem = exp.rows;
                try { if (typeof saveOpticalSystemTableData === 'function') saveOpticalSystemTableData(exp.rows as any); } catch (_) {}
            }
        }
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

        const destinationGroupId = __blocks_groupIdForBlock(activeCfg, toBlockId);
        if (destinationGroupId && !isPhysicalBlockType(String(moved?.blockType ?? ''))) {
            __blocks_assignSequentialBlockToGroup(activeCfg, fromBlockId, destinationGroupId);
        }

        // Re-expand optical system from new block order
        __blocks_refreshExpandedRows(activeCfg);

        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
        saveSystemConfigurations(systemConfig);
        try { refreshBlockInspector(); } catch (_) {}
        try { if (typeof (w as any).loadActiveConfigurationToTables === 'function') (w as any).loadActiveConfigurationToTables({ applyToUI: true }); } catch (_) {}
    } catch (_) {}
}

function __blocks_moveBlockToSequentialGroup(blockId: string, targetGroupId: string): void {
    try {
        const systemConfig = loadSystemConfigurations();
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) return;
        const activeCfg = systemConfig.configurations.find((entry: any) => entry && String(entry.id) === String(systemConfig.activeConfigId));
        if (!activeCfg || !Array.isArray(activeCfg.blocks)) return;

        const id = String(blockId ?? '').trim();
        const blockIndex = activeCfg.blocks.findIndex((entry: any) => String(entry?.blockId ?? '').trim() === id);
        if (blockIndex < 0 || isPhysicalBlockType(String(activeCfg.blocks[blockIndex]?.blockType ?? ''))) return;

        const target = __blocks_ensureSequentialGroup(activeCfg, targetGroupId);
        if (!target) return;
        const previousTargetIds = target.blockIds.map(String).filter((candidate: string) => candidate !== id);
        const [moved] = activeCfg.blocks.splice(blockIndex, 1);
        let insertIndex = activeCfg.blocks.length;
        const lastTargetId = previousTargetIds[previousTargetIds.length - 1];
        if (lastTargetId) {
            const lastTargetIndex = activeCfg.blocks.findIndex((entry: any) => String(entry?.blockId ?? '').trim() === lastTargetId);
            if (lastTargetIndex >= 0) insertIndex = lastTargetIndex + 1;
        } else {
            const imageIndex = activeCfg.blocks.findIndex((entry: any) => String(entry?.blockType ?? '').trim() === 'ImageSurface');
            if (imageIndex >= 0) insertIndex = imageIndex;
        }
        activeCfg.blocks.splice(insertIndex, 0, moved);
        __blocks_assignSequentialBlockToGroup(activeCfg, id, targetGroupId);
        __blocks_refreshExpandedRows(activeCfg);

        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
        saveSystemConfigurations(systemConfig);
        try { refreshBlockInspector(); } catch (_) {}
        try { if (typeof (w as any).loadActiveConfigurationToTables === 'function') (w as any).loadActiveConfigurationToTables({ applyToUI: true }); } catch (_) {}
    } catch (_) {}
}

function __blocks_setVarMode(blockId: string, key: string, enabled: boolean, scope: string = 'perConfig'): void {
    try {
        const systemConfig = cooptLoadCanonicalDesignIntentSystemConfig();
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
            if (String(b?.blockType ?? '').trim() === 'Stop') {
                b.variables = {};
                continue;
            }

            const initialValue = ((String(key ?? '').trim().toLowerCase() === 'bending')
                && !!cooptGetBendingConfigForBlock(b))
                ? cooptComputeLensBendingValue(b, String(b?.blockType ?? '').trim())
                : (cooptGetBlockNumericValue(b, key) ?? '');

            if (!b.variables || typeof b.variables !== 'object') b.variables = {};
            const storageKey = __blocks_resolveVarStorageKey(b.variables, key) || String(key ?? '').trim();
            if (!b.variables[storageKey] || typeof b.variables[storageKey] !== 'object') b.variables[storageKey] = { value: initialValue };
            if (!b.variables[storageKey].optimize || typeof b.variables[storageKey].optimize !== 'object') b.variables[storageKey].optimize = {};
            b.variables[storageKey].optimize.mode = enabled ? 'V' : 'F';
            b.variables[storageKey].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';

            const aliasKey = __blocks_getAliasKeyForMaterialFamily(storageKey);
            if (aliasKey && b.variables[aliasKey] && typeof b.variables[aliasKey] === 'object') {
                if (!b.variables[aliasKey].optimize || typeof b.variables[aliasKey].optimize !== 'object') b.variables[aliasKey].optimize = {};
                b.variables[aliasKey].optimize.mode = enabled ? 'V' : 'F';
                b.variables[aliasKey].optimize.scope = (scope === 'global') ? 'global' : 'perConfig';
            }

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
                    if (b.variables[storageKey] && typeof b.variables[storageKey] === 'object' && Object.prototype.hasOwnProperty.call(b.variables[storageKey], 'value')) {
                        b.variables[storageKey].value = sharedNumericValue;
                    }
                } catch (_) {}
            }

            try {
                __cooptRememberBlockVariablesForConfig(String(cfg?.id ?? ''), [b]);
            } catch (_) {}
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
        const systemConfig = cooptLoadCanonicalDesignIntentSystemConfig();
        if (!systemConfig || !Array.isArray(systemConfig.configurations)) {
            return { ok: false, changedCount: 0, reason: 'no system configurations' };
        }

        const activeId = systemConfig.activeConfigId;
        const activeCfg = systemConfig.configurations.find((c: any) => c && String(c.id) === String(activeId))
            || systemConfig.configurations[0]
            || null;
        if (!activeCfg || !Array.isArray(activeCfg.blocks)) {
            return { ok: false, changedCount: 0, reason: 'active configuration or blocks not found' };
        }

        const beforeBlocks = JSON.parse(JSON.stringify(activeCfg.blocks));
        let changedCount = 0;

        const getBulkTargetState = (currentVarEntry: any): { mode: 'V' | 'F'; scope: 'perConfig' | 'global' } => {
            if (!enabled) {
                return { mode: 'F', scope: 'perConfig' };
            }

            const isEnabled = __blocks_shouldMarkVar(currentVarEntry);
            const currentScope = __blocks_getVarScope(currentVarEntry);
            if (!isEnabled) {
                return { mode: 'V', scope: 'perConfig' };
            }
            return {
                mode: 'V',
                scope: currentScope === 'global' ? 'perConfig' : 'global'
            };
        };

        for (const block of activeCfg.blocks) {
            if (!block || typeof block !== 'object') continue;

            if (!block.variables || typeof block.variables !== 'object') {
                block.variables = {};
            }

            const params = (block.parameters && typeof block.parameters === 'object') ? block.parameters : null;
            const blockType = String(block?.blockType || block?.type || 'unknown');
            if (blockType === 'Stop') {
                if (Object.keys(block.variables).length > 0) changedCount++;
                block.variables = {};
                continue;
            }
            const paramKeys = __blocks_getVisibleParameterKeys(block);
            for (const key of paramKeys) {
                const currentVarEntry = __blocks_getVarEntryForKey(block.variables, key);
                const targetState = getBulkTargetState(currentVarEntry);
                const mode = enabled
                    ? __blocks_getBulkOptimizeModeForParameter(block, key, true)
                    : 'F';
                const initialValue = ((String(key ?? '').trim().toLowerCase() === 'bending')
                    && !!cooptGetBendingConfigForBlock(block))
                    ? cooptComputeLensBendingValue(block, blockType)
                    : (cooptGetBlockNumericValue(block, key) ?? params?.[key] ?? '');
                const storageKey = __blocks_resolveVarStorageKey(block.variables, key) || String(key ?? '').trim();
                if (!block.variables[storageKey] || typeof block.variables[storageKey] !== 'object') {
                    block.variables[storageKey] = { value: initialValue };
                }
                if (Object.prototype.hasOwnProperty.call(block.variables[storageKey], 'value') === false) {
                    block.variables[storageKey].value = initialValue;
                }
                if (!block.variables[storageKey].optimize || typeof block.variables[storageKey].optimize !== 'object') {
                    block.variables[storageKey].optimize = {};
                }

                const prevMode = String(block.variables[storageKey].optimize.mode ?? '').trim();
                const prevScope = String(block.variables[storageKey].optimize.scope ?? '').trim();
                if (prevMode !== mode) changedCount++;
                if (prevScope !== targetState.scope) changedCount++;
                block.variables[storageKey].optimize.mode = mode;
                block.variables[storageKey].optimize.scope = targetState.scope;

                const aliasKey = __blocks_getAliasKeyForMaterialFamily(storageKey);
                if (aliasKey && block.variables[aliasKey] && typeof block.variables[aliasKey] === 'object') {
                    if (!block.variables[aliasKey].optimize || typeof block.variables[aliasKey].optimize !== 'object') {
                        block.variables[aliasKey].optimize = {};
                    }
                    block.variables[aliasKey].optimize.mode = mode;
                    block.variables[aliasKey].optimize.scope = targetState.scope;
                }
            }

            const aperture = (block.aperture && typeof block.aperture === 'object') ? block.aperture : null;
            const apertureKeys = __blocks_getVisibleApertureKeys(block);
            for (const key of apertureKeys) {
                const currentVarEntry = __blocks_getVarEntryForKey(block.variables, key);
                const targetState = getBulkTargetState(currentVarEntry);
                const mode = targetState.mode;
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
                const prevScope = String(block.variables[key].optimize.scope ?? '').trim();
                if (prevMode !== mode) changedCount++;
                if (prevScope !== targetState.scope) changedCount++;
                block.variables[key].optimize.mode = mode;
                block.variables[key].optimize.scope = targetState.scope;
            }
        }

        if (changedCount <= 0) {
            __cooptScheduleDesignIntentUiRefresh({
                systemConfig,
                activeConfigId: String(activeCfg.id ?? activeId ?? ''),
                refreshBlockInspector: true,
                triggerRender: true,
                debounceMs: 40,
            });
            return { ok: true, changedCount: 0 };
        }

        const afterBlocks = JSON.parse(JSON.stringify(activeCfg.blocks));

        try {
            if (w.undoHistory && w.SetDesignIntentOptimizeBulkCommand && !w.undoHistory.isExecuting) {
                const cmd = new w.SetDesignIntentOptimizeBulkCommand(String(activeCfg.id ?? activeId ?? ''), beforeBlocks, afterBlocks, enabled);
                w.undoHistory.record(cmd);
            }
        } catch (_) {}

        try {
            saveSystemConfigurations(systemConfig);
        } catch (e: any) {
            return { ok: false, changedCount: 0, reason: String(e?.message || e) };
        }

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
    if (isPhysicalBlockType(type)) {
        const p = b.parameters ?? {};
        const xyz = `Offset XYZ=${String(p.positionXmm ?? 0)},${String(p.positionYmm ?? 0)},${String(p.positionZmm ?? 0)} mm`;
        if (type === 'BroadbandSource') return `${p.minWavelengthNm ?? '—'}–${p.maxWavelengthNm ?? '—'} nm · ${p.totalPowerW ?? '—'} W · rays R${p.renderSpatialSamples ?? Math.min(9, p.spatialSamples ?? 9)}/D${p.detectorSpatialSamples ?? p.spatialSamples ?? 81} · ${xyz}`;
        if (type === 'FrequencyCombSource') return `f_rep=${p.repetitionRateHz ?? '—'} Hz · f_ceo=${p.ceoFrequencyHz ?? '—'} Hz · rays R${p.renderSpatialSamples ?? Math.min(9, p.spatialSamples ?? 9)}/D${p.detectorSpatialSamples ?? p.spatialSamples ?? 81} · ${xyz}`;
        if (type === 'BeamSplitter') {
            const model = String(p.beamSplitterModel ?? 'ideal');
            const modelLabel = model === 'ideal' ? 'Ideal' : model.charAt(0).toUpperCase() + model.slice(1);
            const substrate = model === 'ideal'
                ? ''
                : ` · n(d)=${p.substrateIndexNd ?? '—'} · t=${p.substrateThicknessMm ?? '—'} mm`;
            return `${modelLabel} · R/T=${p.reflectance ?? '—'}/${p.transmittance ?? '—'}${substrate} · ${xyz}`;
        }
        if (type === 'ReflectionGrating') return `${p.grooveDensityLinesPerMm ?? '—'} lines/mm · order ${p.order ?? '—'} · ${xyz}`;
        if (type === 'AreaDetector') return `${p.pixelCountX ?? '—'}×${p.pixelCountY ?? '—'} · ${p.pixelPitchUm ?? '—'} µm · ${xyz}`;
        if (type === 'TimeDetector') return `${p.samplingRateHz ?? '—'} Hz · ${p.sampleCount ?? '—'} samples · ${xyz}`;
        if (type === 'Target') return `${p.profile ?? 'flat'} / ${p.interaction ?? 'specular'} · ${xyz}`;
        return `${p.widthMm ?? '—'}×${p.heightMm ?? '—'}×${p.depthMm ?? '—'} mm · ${xyz}`;
    }

    const isAsphereType = (v: any): boolean => {
        const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
        return s.includes('aspheric');
    };
    
    if (type === 'Paraxial') {
        const shared = pick('focalLength');
        const explicitX = pick('focalLengthX');
        const explicitY = pick('focalLengthY');
        const flx = String(explicitX) !== '' ? explicitX : shared;
        const fly = String(explicitY) !== '' ? explicitY : shared;
        const parts = [];
        if (String(flx) !== '' || String(fly) !== '') {
            parts.push(`Fx=${String(String(flx) !== '' ? flx : fly)}`);
            parts.push(`Fy=${String(String(fly) !== '' ? fly : flx)}`);
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
        const rindex = pick('rindex');
        const thicknessModeRaw = pick('thicknessMode');
        const thicknessMode = String(thicknessModeRaw ?? '').trim().replace(/\s+/g, '').toUpperCase();
        const matText = String(mat ?? '').trim();
        const matKey = matText.replace(/\s+/g, '').toUpperCase();
        const rindexText = String(rindex ?? '').trim();
        const parts = [];
        if (thicknessMode === 'IMD' || thicknessMode === 'BFL') parts.push(`T=${thicknessMode}`);
        else if (String(th) !== '') parts.push(`T=${String(th)}`);
        if (matText !== '' && matText !== '0' && matKey !== 'AIR') parts.push(`M=${matText}`);
        else if (rindexText !== '' && rindexText !== '0') parts.push(`M=${rindexText}`);
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

function cooptIsMaterialLikePath(path: string): boolean {
    const normalizedPath = String(path ?? '').trim().toLowerCase();
    if (!normalizedPath) return false;
    return /(?:^|\.)(?:material|material1|material2|material3)$/.test(normalizedPath);
}

function cooptNormalizeInputValue(raw: string, original: any, path: string = ''): any {
    const trimmed = String(raw ?? '').trim();
    if (trimmed === '') return '';
    if (cooptIsMaterialLikePath(path)) {
        return trimmed;
    }
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

    return { valid: true, value: cooptNormalizeInputValue(trimmed, original, normalizedPath) };
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
    void expandedRows;
    void legacyRows;
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

    const getBlockParamValue = (block: any, key: string): any => {
        const vars = block?.variables;
        const variableEntry = vars && typeof vars === 'object' ? vars[key] : undefined;
        if (variableEntry && typeof variableEntry === 'object' && Object.prototype.hasOwnProperty.call(variableEntry, 'value')) {
            return variableEntry.value;
        }
        const params = block?.parameters;
        return params && typeof params === 'object' ? params[key] : undefined;
    };

    const primaryWavelength = (() => {
        try {
            if (typeof w.getPrimaryWavelength === 'function') {
                const wl = Number(w.getPrimaryWavelength());
                if (Number.isFinite(wl) && wl > 0) return wl;
            }
        } catch (_) {}
        return 0.5875618;
    })();

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

            const materialText = String(params.material ?? '').trim();
            const rindexText = String(params.rindex ?? '').trim();
            const hasManualRindex = rindexText !== '' && rindexText !== '0';
            if (materialText === '' || materialText === '0') {
                const normalizedMaterial = hasManualRindex ? '' : 'AIR';
                if (String(params.material ?? '') !== normalizedMaterial) {
                    params.material = normalizedMaterial;
                    changed = true;
                }
                if (
                    String(params.rindex ?? '').trim() === '0'
                    && !__blocks_shouldMarkVar(block.variables?.rindex)
                ) {
                    delete params.rindex;
                    changed = true;
                }
                if (
                    String(params.abbe ?? '').trim() === '0'
                    && !__blocks_shouldMarkVar(block.variables?.abbe)
                ) {
                    delete params.abbe;
                    changed = true;
                }
                if (block.variables && typeof block.variables === 'object') {
                    const materialVar = block.variables.material;
                    if (materialVar && typeof materialVar === 'object' && Object.prototype.hasOwnProperty.call(materialVar, 'value') && String(materialVar.value ?? '').trim() === '0') {
                        materialVar.value = 'AIR';
                        changed = true;
                    }
                    const rindexVar = block.variables.rindex;
                    if (
                        rindexVar
                        && typeof rindexVar === 'object'
                        && Object.prototype.hasOwnProperty.call(rindexVar, 'value')
                        && String(rindexVar.value ?? '').trim() === '0'
                        && !__blocks_shouldMarkVar(rindexVar)
                    ) {
                        delete block.variables.rindex;
                        changed = true;
                    }
                    const abbeVar = block.variables.abbe;
                    if (
                        abbeVar
                        && typeof abbeVar === 'object'
                        && Object.prototype.hasOwnProperty.call(abbeVar, 'value')
                        && String(abbeVar.value ?? '').trim() === '0'
                        && !__blocks_shouldMarkVar(abbeVar)
                    ) {
                        delete block.variables.abbe;
                        changed = true;
                    }
                }
            }

            const mode = String(params.thicknessMode ?? '').trim().replace(/\s+/g, '').toUpperCase();
            if (mode !== 'IMD' && mode !== 'BFL') continue;

            const target = mode === 'IMD' ? paraxial.imageDistance : paraxial.backFocalLength;
            const reducedDistance = Number(target);
            if (!Number.isFinite(reducedDistance)) continue;

            const gapRefractiveIndex = Number(getRefractiveIndex({
                material: getBlockParamValue(block, 'material'),
                rindex: getBlockParamValue(block, 'rindex'),
                abbe: getBlockParamValue(block, 'abbe'),
            }, primaryWavelength));
            const mediumScale = (Number.isFinite(gapRefractiveIndex) && gapRefractiveIndex > 0)
                ? gapRefractiveIndex
                : 1;
            const numeric = reducedDistance * mediumScale;
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
    const normalizedPath = String(changedPath ?? '').trim().toLowerCase();
    if (normalizedPath && /(^|\.)variables\.[^.]+\.optimize\.(mode|scope)$/.test(normalizedPath)) {
        return false;
    }
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

    try {
        if (typeof (w as any).__cooptFlushPendingRowsToBlocks === 'function') {
            (w as any).__cooptFlushPendingRowsToBlocks();
        }
    } catch (_) {}

    let rows = Array.isArray(rowsSnapshot) ? rowsSnapshot.slice() : [];
    let objectRows: any[] = [];
    let runtimeSystemConfig: any = null;
    let activeConfig: any = null;

    try {
        runtimeSystemConfig = __cooptGetSystemConfig();
        activeConfig = runtimeSystemConfig?.configurations?.find((cfg: any) => cfg && String(cfg.id) === String(runtimeSystemConfig?.activeConfigId))
            || runtimeSystemConfig?.configurations?.[0]
            || null;
    } catch (_) {}

    if (rows.length === 0) {
        try {
            if (shouldPreferImportedOpticalRows(activeConfig) && Array.isArray(activeConfig?.opticalSystem) && activeConfig.opticalSystem.length > 0) {
                rows = activeConfig.opticalSystem.slice();
            }
            const activeBlocks = Array.isArray(activeConfig?.blocks) ? activeConfig.blocks : [];
            if (rows.length === 0 && activeBlocks.length > 0) {
                const autoGapResult = cooptAutoApplyGapThicknessModes(activeBlocks, '');
                const expandedRows = Array.isArray(autoGapResult?.rows)
                    ? autoGapResult.rows
                    : (() => {
                        const expanded = expandBlocksToOpticalSystemRows(activeBlocks as any);
                        return expanded && Array.isArray(expanded.rows) ? expanded.rows : [];
                    })();
                if (expandedRows.length > 0) {
                    rows = expandedRows.slice();
                    try {
                        activeConfig.opticalSystem = expandedRows;
                    } catch (_) {}
                }
            } else if (rows.length === 0 && Array.isArray(activeConfig?.opticalSystem) && activeConfig.opticalSystem.length > 0) {
                rows = activeConfig.opticalSystem.slice();
            }
        } catch (_) {}
    }

    try {
        if (typeof w.getObjectRows === 'function') {
            const tableRows = w.getObjectRows(w.tableObject);
            if (Array.isArray(tableRows) && tableRows.length > 0) {
                objectRows = tableRows.slice();
            }
        }
    } catch (_) {}
    if (objectRows.length === 0) {
        try {
            if (Array.isArray(activeConfig?.object) && activeConfig.object.length > 0) {
                objectRows = activeConfig.object.slice();
            }
        } catch (_) {}
    }
    if (!Array.isArray(rows) || rows.length === 0) {
        return;
    }

    __cooptPendingRenderSyncRequest = {
        rows: Array.isArray(rows) ? rows.slice() : [],
        objectRows: Array.isArray(objectRows) ? objectRows.slice() : [],
        systemConfig: runtimeSystemConfig,
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
            const pendingSystemConfig = pending.systemConfig;
            const liveSystemConfig = cooptLoadCanonicalDesignIntentSystemConfig();
            const systemConfig = (pendingSystemConfig && Array.isArray(pendingSystemConfig.configurations))
                ? pendingSystemConfig
                : ((liveSystemConfig && Array.isArray(liveSystemConfig.configurations))
                    ? liveSystemConfig
                    : pendingSystemConfig);
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
    const pendingSystemConfig = __cooptBlockParamPendingRefresh?.systemConfig;
    const systemConfig = (pendingSystemConfig && Array.isArray(pendingSystemConfig.configurations))
        ? pendingSystemConfig
        : cooptLoadCanonicalDesignIntentSystemConfig();
    const activeConfig = systemConfig?.configurations?.find((c: any) => c.id === systemConfig?.activeConfigId)
        || systemConfig?.configurations?.[0];
    if (!activeConfig) return;
    const blocks = Array.isArray(activeConfig.blocks) ? activeConfig.blocks : [];
    const block = blocks.find((b: any) => b && String(b.blockId ?? '') === String(blockId));
    if (!block) return;

    const blockType = String(block?.blockType ?? '').trim();
    const isPhysicalAssemblyChange = isPhysicalBlockType(blockType);
    if ((blockType === 'Lens' || blockType === 'PositiveLens') && String(path) === 'parameters.bending') {
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
        syncDesignIntentParameterToVariable(block, path, newValue);
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

    const activeConfigId = String(systemConfig?.activeConfigId ?? activeConfig?.id ?? '');
    __cooptRememberBlockVariablesForConfig(activeConfigId, [block]);

    __cooptBlockParamPendingRefresh = {
        systemConfig,
        activeConfigId,
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
            const pendingSystemConfig = pending?.systemConfig;
            const liveSystemConfig = cooptLoadCanonicalDesignIntentSystemConfig();
            const latestSystemConfig = (pendingSystemConfig && Array.isArray(pendingSystemConfig.configurations))
                ? pendingSystemConfig
                : ((liveSystemConfig && Array.isArray(liveSystemConfig.configurations))
                    ? liveSystemConfig
                    : pendingSystemConfig);
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
        }, isPhysicalAssemblyChange ? 0 : 650);
    }, isPhysicalAssemblyChange ? 40 : 420);
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
        throw new Error('Plotly is unavailable; the bundled Plotly 3.7.0 module has not loaded');
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
                renderChips(groupChips, [], '', 'design-intent-zoom-chip design-intent-zoom-chip-group', 'No zoom groups');
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
        renderChips(groupChips, state.groupNames || [], '', 'design-intent-zoom-chip design-intent-zoom-chip-group', 'No zoom groups');
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
                    renderChips(groupChips, [], 'chip-group', '');
                    renderChips(lawChips, [], 'chip-law', 'Law ');
                    if (!suspendTextSync) lawsInput.value = '';
                    return;
                }

                configName.textContent = state.configName || 'Active config';
                zoomValue.textContent = Number(state.zoomPosition || 0).toFixed(2);
                slider.value = String(state.zoomPosition || 0);
                renderChips(groupChips, state.groupNames || [], 'chip-group', '');
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
    const activeConfigIdForInspector = String(activeCfg?.id ?? '').trim();
    type AssemblyParameterChoice = { value: string | number | boolean; label: string };
    type AssemblyParameterPresentation = { label: string; compactLabel?: string; help: string; choices?: AssemblyParameterChoice[] };
    const getAssemblyParameterPresentation = (type: string, rawKey: string): AssemblyParameterPresentation | null => {
        if (!isPhysicalBlockType(type)) return null;
        const common: Record<string, AssemblyParameterPresentation> = {
            positionXmm: { label: 'Position X (mm)', compactLabel: 'X (mm)', help: 'Manual offset along the world X axis from the automatic port placement.' },
            positionYmm: { label: 'Position Y (mm)', compactLabel: 'Y (mm)', help: 'Manual offset along the world Y axis from the automatic port placement.' },
            positionZmm: { label: 'Position Z (mm)', compactLabel: 'Z (mm)', help: 'Manual offset along the world Z axis from the automatic port placement.' },
            rotationXdeg: { label: 'Rotation X (deg)', compactLabel: 'Rot. X', help: 'Manual rotation about the component X axis, in degrees.' },
            rotationYdeg: { label: 'Rotation Y (deg)', compactLabel: 'Rot. Y', help: 'Manual rotation about the component Y axis, in degrees.' },
            rotationZdeg: { label: 'Rotation Z (deg)', compactLabel: 'Rot. Z', help: 'Manual rotation about the component Z axis, in degrees.' },
            widthMm: { label: 'Body width (mm)', compactLabel: 'Width (mm)', help: 'Physical outer width used by Render, fit and collision checks.' },
            heightMm: { label: 'Body height (mm)', compactLabel: 'Height (mm)', help: 'Physical outer height used by Render, fit and collision checks.' },
            depthMm: { label: 'Body depth (mm)', compactLabel: 'Depth (mm)', help: 'Physical length along the local optical axis.' },
            apertureDiameterMm: { label: 'Clear aperture (mm)', help: 'Usable optical diameter; rays outside this aperture are clipped.' },
            dimensionConfidence: {
                label: 'Dimension confidence',
                help: 'Exact means measured input, Estimated uses an assumed envelope, and Missing prevents a confirmed volume.',
                choices: [
                    { value: 'Exact', label: 'Exact' },
                    { value: 'Estimated', label: 'Estimated' },
                    { value: 'Missing', label: 'Missing' },
                ],
            },
            radialClearanceMm: { label: 'Radial clearance (mm)', help: 'Mechanical allowance added around the optical body.' },
            axialClearanceMm: { label: 'Axial clearance (mm)', help: 'Mechanical allowance added before and after the optical body.' },
            centerWavelengthNm: { label: 'Center wavelength (nm)', compactLabel: 'Center λ (nm)', help: 'Center of the emitted optical spectrum.' },
            totalPowerW: { label: 'Total optical power (W)', compactLabel: 'Power (W)', help: 'Total power distributed across all spatial samples and wavelengths or comb lines.' },
            beamDiameterMm: { label: 'Beam diameter (mm)', help: 'Diameter of the emitted beam at the Source end face.' },
            sourceModel: {
                label: 'Emission model',
                help: 'Fiber facet uses the numerical aperture and ambient refractive index to derive the launch half-angle.',
                choices: [
                    { value: 'fiber-facet', label: 'Fiber facet' },
                    { value: 'collimated', label: 'Collimated beam' },
                ],
            },
            numericalAperture: { label: 'Numerical aperture (NA)', compactLabel: 'NA', help: 'Source-side numerical aperture. In air, NA 0.1 corresponds to a 5.739 deg launch half-angle.' },
            ambientRefractiveIndex: { label: 'Ambient refractive index', compactLabel: 'Ambient n', help: 'Refractive index immediately outside the emitting facet; use 1.0 for air.' },
            coherenceGroupId: { label: 'Coherence group', help: 'Only fields with the same group and optical frequency are added coherently.' },
            renderSpatialSamples: { label: 'Render rays / wavelength', compactLabel: 'Render rays', help: 'Pupil ray samples emitted per wavelength or comb line for the live Render view. Keep this modest for responsive editing.' },
            detectorSpatialSamples: { label: 'Detector rays / wavelength', compactLabel: 'Signal rays', help: 'Pupil ray samples emitted per wavelength or comb line when Coherent Signal calculates Detector power and phase.' },
            reflectance: { label: 'Reflectance R', compactLabel: 'Reflectance', help: 'Fraction of incident optical power sent into the reflected path.' },
            transmittance: { label: 'Transmittance T', compactLabel: 'Transmittance', help: 'Fraction of incident optical power sent into the transmitted path.' },
            transmission: { label: 'Transmission T', compactLabel: 'Transmission', help: 'Fraction of incident optical power passed by this component.' },
            interaction: { label: 'Ray interaction', help: 'Selects how a ray is reflected, scattered, transmitted or absorbed at this component.' },
        };
        const byType: Partial<Record<PhysicalBlockType, Record<string, AssemblyParameterPresentation>>> = {
            BroadbandSource: {
                minWavelengthNm: { label: 'Minimum wavelength (nm)', compactLabel: 'Min λ (nm)', help: 'Shortest wavelength included in the emitted spectrum.' },
                maxWavelengthNm: { label: 'Maximum wavelength (nm)', compactLabel: 'Max λ (nm)', help: 'Longest wavelength included in the emitted spectrum.' },
                spectralSamples: { label: 'Spectral samples', help: 'Number of wavelength samples used between the minimum and maximum wavelengths.' },
                divergenceDeg: { label: 'Launch half-angle (deg)', help: 'Fallback angular half-width. When Numerical aperture is present, the half-angle is derived from asin(NA / ambient n).' },
                spectralShape: {
                    label: 'Spectral profile',
                    help: 'Selects the wavelength-domain power envelope.',
                    choices: [
                        { value: 'gaussian', label: 'Gaussian' },
                        { value: 'flat', label: 'Flat' },
                        { value: 'csv', label: 'CSV data' },
                    ],
                },
                spatialProfile: {
                    label: 'Spatial profile',
                    help: 'Gaussian weights rays toward the axis; Top-hat uses uniform irradiance.',
                    choices: [
                        { value: 'gaussian', label: 'Gaussian' },
                        { value: 'top-hat', label: 'Top-hat' },
                    ],
                },
                spatialSamples: { label: 'Legacy shared ray samples', help: 'Compatibility value used only when separate Render and Detector ray counts are absent.' },
            },
            FrequencyCombSource: {
                repetitionRateHz: { label: 'Repetition rate (Hz)', compactLabel: 'Rep. rate (Hz)', help: 'Frequency spacing f_rep between adjacent comb lines.' },
                ceoFrequencyHz: { label: 'CEO frequency (Hz)', compactLabel: 'CEO freq. (Hz)', help: 'Carrier-envelope offset f_ceo in νn = f_ceo + n f_rep.' },
                lineCount: { label: 'Comb line count', compactLabel: 'Comb lines', help: 'Number of discrete optical frequencies generated around the center.' },
                lineWidthHz: { label: 'Comb linewidth (Hz)', help: 'Optical linewidth assigned to each comb mode.' },
                initialPhaseRad: { label: 'Initial phase (rad)', help: 'Common starting optical phase of this comb source.' },
                groupDelayDispersionFs2: { label: 'Group-delay dispersion (fs²)', help: 'Quadratic spectral phase applied across the comb.' },
                divergenceDeg: { label: 'Launch half-angle (deg)', help: 'Fallback angular half-width. When Numerical aperture is present, the half-angle is derived from asin(NA / ambient n).' },
                spectralShape: {
                    label: 'Spectral envelope',
                    help: 'Selects the power envelope applied across the generated comb lines.',
                    choices: [
                        { value: 'gaussian', label: 'Gaussian' },
                        { value: 'flat', label: 'Flat' },
                        { value: 'csv', label: 'CSV data' },
                    ],
                },
                spatialProfile: {
                    label: 'Spatial profile',
                    help: 'Gaussian weights rays toward the axis; Top-hat uses uniform irradiance.',
                    choices: [
                        { value: 'gaussian', label: 'Gaussian' },
                        { value: 'top-hat', label: 'Top-hat' },
                    ],
                },
            },
            BeamSplitter: {
                beamSplitterModel: {
                    label: 'Beam-splitter model',
                    compactLabel: 'BS model',
                    help: 'Ideal is a zero-thickness splitting surface. Cube traces between its exterior faces and diagonal coating. Plate includes refraction through the parallel substrate and the resulting lateral optical-axis displacement.',
                    choices: [
                        { value: 'ideal', label: 'Ideal surface' },
                        { value: 'plate', label: 'Plate' },
                        { value: 'cube', label: 'Cube' },
                        { value: 'pellicle', label: 'Pellicle' },
                    ],
                },
                reflectionPort: {
                    label: 'Common reflection side',
                    compactLabel: 'Reflect side',
                    help: 'Selects which lateral port receives the Common-port reflected beam and therefore fixes the diagonal coating orientation.',
                    choices: [
                        { value: 'reflect', label: 'Reflect (+X)' },
                        { value: 'recombine', label: 'Recombine (-X)' },
                    ],
                },
                reflectedPhaseDeg: { label: 'Reflected phase (deg)', help: 'Phase shift applied to the reflected complex field.' },
                transmittedPhaseDeg: { label: 'Transmitted phase (deg)', help: 'Phase shift applied to the transmitted complex field.' },
                substrateMaterial: { label: 'Substrate glass', help: 'Glass name used by a physical Plate, Cube or Pellicle model.' },
                substrateIndexNd: { label: 'Substrate index nd', help: 'Refractive index of the beam-splitter substrate at the d line.' },
                substrateAbbeNumber: { label: 'Substrate Abbe number', help: 'Dispersion value used to estimate the substrate index versus wavelength.' },
                substrateThicknessMm: { label: 'Substrate thickness (mm)', help: 'Normal substrate thickness. For Plate, this value and the refractive index determine the transmitted-beam lateral displacement.' },
                wedgeDeg: { label: 'Substrate wedge (deg)', help: 'Angle between the front and rear substrate faces.' },
                backSurfaceReflectance: { label: 'Rear-surface reflectance', help: 'Residual power reflectance of the substrate rear face.' },
            },
            ReflectionGrating: {
                grooveDensityLinesPerMm: { label: 'Groove density (lines/mm)', compactLabel: 'Grooves (lines/mm)', help: 'Number of grating grooves per millimetre used by the vector grating equation.' },
                detectorMagnification: { label: 'Detector depth magnification', compactLabel: 'Depth mag.', help: 'Effective relay magnification from grating angle to the Camera depth axis. It must match the physical relay lens ratio; increase it to reduce spectral-carrier cycles per Camera pixel.' },
                delayModel: {
                    label: 'Delay model',
                    help: 'Diffractive phase models an ordinary zero-thickness grating. Detector-linear OPD models the calibrated grating/relay delay gradient along Camera Y for white-light depth encoding.',
                    choices: [
                        { value: 'diffractive-phase', label: 'Diffractive phase' },
                        { value: 'detector-linear-opd', label: 'Detector-linear OPD' },
                    ],
                },
                order: { label: 'Primary diffraction order', compactLabel: 'Order', help: 'Diffraction order emphasized for the main connected output.' },
                allowedOrders: { label: 'Allowed orders', help: 'List of diffraction orders that may generate outgoing rays.' },
                efficiency: { label: 'Diffraction efficiency', compactLabel: 'Efficiency', help: 'Fraction of incident power assigned to the selected diffraction order.' },
                blazeAngleDeg: { label: 'Blaze angle (deg)', help: 'Facet blaze angle used for the grating efficiency model.' },
                blazeWavelengthNm: { label: 'Blaze wavelength (nm)', help: 'Wavelength at which the configured order is centered on the blaze condition.' },
                grooveDirectionX: { label: 'Groove direction X', help: 'X component of the local groove-direction vector.' },
                grooveDirectionY: { label: 'Groove direction Y', help: 'Y component of the local groove-direction vector.' },
                grooveDirectionZ: { label: 'Groove direction Z', help: 'Z component of the local groove-direction vector.' },
                incidentSide: {
                    label: 'Incident side',
                    help: 'Selects which physical face accepts the incoming ray.',
                    choices: [
                        { value: 'front', label: 'Front face' },
                        { value: 'back', label: 'Back face' },
                    ],
                },
            },
            Target: {
                profile: {
                    label: 'Surface profile',
                    help: 'Selects the mathematical or imported target surface shape.',
                    choices: [
                        { value: 'flat', label: 'Flat' },
                        { value: 'step', label: 'Step' },
                        { value: 'tilt', label: 'Tilt' },
                        { value: 'sine', label: 'Sine' },
                        { value: 'csv', label: 'CSV profile' },
                    ],
                },
                interaction: {
                    label: 'Ray interaction',
                    help: 'Selects the reflection or single-scatter model used at the target.',
                    choices: [
                        { value: 'specular', label: 'Specular' },
                        { value: 'lambertian', label: 'Lambertian' },
                        { value: 'abg', label: 'ABg scatter' },
                        { value: 'harvey-shack', label: 'Harvey–Shack' },
                        { value: 'bsdf-csv', label: 'BSDF CSV' },
                    ],
                },
                surfaceResponse: {
                    label: 'Surface response',
                    help: 'Specular normal applies the local profile slope to the reflected-ray direction. Telecentric phase keeps the nominal return direction and encodes the surface only as the physical round-trip optical path; use it for the coaxial line-imaging approximation where lateral beam walk is intentionally excluded.',
                    choices: [
                        { value: 'specular-normal', label: 'Specular normal' },
                        { value: 'telecentric-phase', label: 'Telecentric phase' },
                    ],
                },
                offsetUm: { label: 'Base height (µm)', help: 'Reference height added to the selected target profile.' },
                amplitudeUm: { label: 'Profile amplitude (µm)', help: 'Step: height change. Tilt: half of the edge-to-edge height change, so local X = -width/2 is offset-amplitude and +width/2 is offset+amplitude. Sine: peak height about the base height.' },
                periodMm: { label: 'Profile period (mm)', help: 'Spatial period of a sinusoidal target profile.' },
                stepPositionMm: { label: 'Step position (mm)', help: 'Lateral position of the height discontinuity for a step target.' },
                scatterSamples: { label: 'Scatter samples', help: 'Number of sampled outgoing rays generated by a scattering interaction.' },
                scatterA: { label: 'ABg A', help: 'Scale coefficient A of the ABg scatter model.' },
                scatterB: { label: 'ABg B', help: 'Offset coefficient B of the ABg scatter model.' },
                scatterG: { label: 'ABg g', help: 'Angular exponent g of the ABg scatter model.' },
                scatterSigmaDeg: { label: 'Scatter sigma (deg)', help: 'Angular width used by the Harvey-Shack style scatter approximation.' },
                bsdfSamples: { label: 'BSDF data', help: 'Sampled bidirectional scattering distribution used by the target.' },
            },
            AreaDetector: {
                pixelCountX: { label: 'Pixels X', compactLabel: 'Pixels X', help: 'Number of active detector columns.' },
                pixelCountY: { label: 'Pixels Y', compactLabel: 'Pixels Y', help: 'Number of active detector rows.' },
                pixelPitchUm: { label: 'Pixel pitch (µm)', compactLabel: 'Pitch (µm)', help: 'Center-to-center spacing of adjacent detector pixels.' },
                quantumEfficiency: { label: 'Quantum efficiency', compactLabel: 'QE', help: 'Fraction of incident photons converted to photoelectrons.' },
                fillFactor: { label: 'Fill factor', help: 'Active photosensitive area divided by total pixel area.' },
                exposureTimeS: { label: 'Exposure time (s)', help: 'Time over which optical power is integrated into charge.' },
                saturationElectrons: { label: 'Full well (electrons)', help: 'Maximum stored charge before the pixel saturates.' },
                bitDepth: { label: 'ADC bit depth', help: 'Digital output resolution used when converting electrons to ADU.' },
                calibrationMinUm: { label: 'Minimum reconstructed height (µm)', compactLabel: 'Height min (µm)', help: 'Lower limit of the calibrated surface-height search range. Keep this close to the expected physical measurement range to reject unrelated correlation peaks.' },
                calibrationMaxUm: { label: 'Maximum reconstructed height (µm)', compactLabel: 'Height max (µm)', help: 'Upper limit of the calibrated surface-height search range. It must be greater than the minimum reconstructed height.' },
                frontOnly: {
                    label: 'Accepted incidence',
                    help: 'Front only rejects rays arriving from the detector rear; Both sides accept either direction.',
                    choices: [
                        { value: true, label: 'Front only' },
                        { value: false, label: 'Front and rear' },
                    ],
                },
            },
            TimeDetector: {
                samplingRateHz: { label: 'Sampling rate (Hz)', compactLabel: 'Sample rate (Hz)', help: 'Number of temporal signal samples acquired each second.' },
                sampleCount: { label: 'Time samples', compactLabel: 'Samples', help: 'Number of samples in the detector time record.' },
                detectionBandwidthHz: { label: 'Detection bandwidth (Hz)', compactLabel: 'Bandwidth (Hz)', help: 'Electrical bandwidth retained by the time detector.' },
                integrationTimeS: { label: 'Integration time (s)', help: 'Observation interval used for temporal power and RF beat analysis.' },
                responsivity: { label: 'Responsivity (A/W)', help: 'Electrical current produced per watt of incident optical power.' },
            },
            STLObject: {
                stlPath: { label: 'STL file', help: 'Path to the triangulated mechanical or optical object used for intersection tests.' },
            },
        };
        const known = byType[type as PhysicalBlockType]?.[rawKey] ?? common[rawKey];
        if (known) return known;
        const readable = String(rawKey ?? '')
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/\bMm\b/g, '(mm)')
            .replace(/\bNm\b/g, '(nm)')
            .replace(/\bDeg\b/g, '(deg)')
            .replace(/^./, (value) => value.toUpperCase());
        return { label: readable || rawKey, help: 'Physical or optical parameter stored with this assembly component.' };
    };
    const maxImageHeightTargetMm = __cooptGetMaxImageHeightTargetMmFromObjectRows(Array.isArray(activeCfg?.object) ? activeCfg.object : []);
    const hierarchyConnections = normalizeDesignConnections(Array.isArray(activeCfg?.blocks) ? activeCfg.blocks : [], activeCfg?.designConnections);
    const hierarchyChildren = new Map<string, string[]>();
    const hierarchyParents = new Map<string, string[]>();
    const hierarchyPathByChild = new Map<string, string>();
    for (const connection of hierarchyConnections) {
        const fromId = String(connection?.from?.blockId ?? '').trim();
        const toId = String(connection?.to?.blockId ?? '').trim();
        if (!fromId || !toId) continue;
        const children = hierarchyChildren.get(fromId) ?? [];
        if (!children.includes(toId)) children.push(toId);
        hierarchyChildren.set(fromId, children);
        const parents = hierarchyParents.get(toId) ?? [];
        if (!parents.includes(fromId)) parents.push(fromId);
        hierarchyParents.set(toId, parents);
        hierarchyPathByChild.set(toId, String(connection?.pathLabel ?? 'main'));
    }
    const hierarchyDepth = new Map<string, number>();
    const physicalIds = (Array.isArray(blocksInOrder) ? blocksInOrder : [])
        .filter((block: any) => isPhysicalBlockType(String(block?.blockType ?? '')))
        .map((block: any) => String(block?.blockId ?? '')).filter(Boolean);
    for (const id of physicalIds) if (!(hierarchyParents.get(id)?.length)) hierarchyDepth.set(id, 0);
    for (let pass = 0; pass < physicalIds.length; pass += 1) {
        let changed = false;
        for (const id of physicalIds) {
            const parentDepths = (hierarchyParents.get(id) ?? []).map((parentId) => hierarchyDepth.get(parentId)).filter((value): value is number => Number.isFinite(value));
            if (!parentDepths.length) continue;
            const nextDepth = Math.min(...parentDepths) + 1;
            if (hierarchyDepth.get(id) !== nextDepth) { hierarchyDepth.set(id, nextDepth); changed = true; }
        }
        if (!changed) break;
    }
    const hierarchyStorageKey = `coopt.designIntent.collapsedPaths.${activeConfigIdForInspector || 'default'}`;
    const collapsedHierarchyIds = (() => {
        try {
            const parsed = JSON.parse(localStorage.getItem(hierarchyStorageKey) || '[]');
            return new Set<string>(Array.isArray(parsed) ? parsed.map(String) : []);
        } catch (_) { return new Set<string>(); }
    })();
    const persistCollapsedHierarchy = () => {
        try { localStorage.setItem(hierarchyStorageKey, JSON.stringify(Array.from(collapsedHierarchyIds))); } catch (_) {}
    };
    const isHiddenByCollapsedParent = (id: string, visiting = new Set<string>()): boolean => {
        if (!id || visiting.has(id)) return false;
        visiting.add(id);
        const parents = hierarchyParents.get(id) ?? [];
        for (const parentId of parents) {
            if (collapsedHierarchyIds.has(parentId) || isHiddenByCollapsedParent(parentId, new Set(visiting))) return true;
        }
        return false;
    };

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

    const DI_COL_WIDTH_STORAGE_KEY = 'coopt.designIntent.columnWidths';
    const diColKeys = ['item', 'r', 'ct', 'g', 'n', 'abbe', 'sd'] as const;
    type DiColKey = typeof diColKeys[number];
    const diColVarNameByKey: Record<DiColKey, string> = {
        item: '--di-col-item',
        r: '--di-col-r',
        ct: '--di-col-ct',
        g: '--di-col-g',
        n: '--di-col-n',
        abbe: '--di-col-abbe',
        sd: '--di-col-sd'
    };

    const applySavedDiColumnWidths = (scopeEl: HTMLElement): void => {
        try {
            const raw = localStorage.getItem(DI_COL_WIDTH_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            for (const key of diColKeys) {
                const width = Number(parsed?.[key]);
                if (!Number.isFinite(width)) continue;
                const px = Math.max(72, Math.min(560, Math.round(width)));
                scopeEl.style.setProperty(diColVarNameByKey[key], `${px}px`);
            }
        } catch (_) {}
    };

    const persistDiColumnWidth = (scopeEl: HTMLElement, key: DiColKey, nextWidth: number): void => {
        const px = Math.max(72, Math.min(560, Math.round(nextWidth)));
        try {
            const raw = localStorage.getItem(DI_COL_WIDTH_STORAGE_KEY);
            const state = raw ? JSON.parse(raw) : {};
            state[key] = px;
            localStorage.setItem(DI_COL_WIDTH_STORAGE_KEY, JSON.stringify(state));
        } catch (_) {}
        scopeEl.style.setProperty(diColVarNameByKey[key], `${px}px`);
    };

    const attachDiColumnResizer = (handleEl: HTMLElement, key: DiColKey, scopeEl: HTMLElement): void => {
        handleEl.addEventListener('mousedown', (downEvent: MouseEvent) => {
            try { downEvent.preventDefault(); } catch (_) {}
            try { downEvent.stopPropagation(); } catch (_) {}

            const cssValue = getComputedStyle(scopeEl).getPropertyValue(diColVarNameByKey[key]);
            const parsedCss = Number.parseFloat(cssValue);
            const fallbackWidth = handleEl.parentElement?.getBoundingClientRect().width ?? 120;
            const startWidth = Number.isFinite(parsedCss) ? parsedCss : fallbackWidth;
            const startX = downEvent.clientX;

            const onMove = (moveEvent: MouseEvent) => {
                const delta = moveEvent.clientX - startX;
                const liveWidth = Math.max(72, Math.min(560, Math.round(startWidth + delta)));
                scopeEl.style.setProperty(diColVarNameByKey[key], `${liveWidth}px`);
            };

            const onUp = (upEvent: MouseEvent) => {
                const delta = upEvent.clientX - startX;
                persistDiColumnWidth(scopeEl, key, startWidth + delta);
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    };

    applySavedDiColumnWidths(container);

    const collapsedHeader = document.createElement('div');
    collapsedHeader.className = 'block-inspector-table-header';
    const headerDrag = document.createElement('div');
    headerDrag.textContent = '';
    const headerId = document.createElement('div');
    headerId.textContent = 'Block';
    const headerIdResizer = document.createElement('span');
    headerIdResizer.className = 'block-inspector-col-resizer';
    headerIdResizer.title = 'Block width';
    headerId.appendChild(headerIdResizer);
    attachDiColumnResizer(headerIdResizer, 'item', container);
    const headerValues = document.createElement('div');
    headerValues.className = 'block-inspector-values-header';
    const valueHeaderColumns: Array<{ label: string; key: DiColKey }> = [
        { label: 'Radius', key: 'r' },
        { label: 'Center Thickness', key: 'ct' },
        { label: 'Glass', key: 'g' },
        { label: 'Refractive Index', key: 'n' },
        { label: 'Abbe', key: 'abbe' },
        { label: 'Semi Diameter', key: 'sd' }
    ];
    for (const item of valueHeaderColumns) {
        const span = document.createElement('span');
        span.textContent = item.label;
        headerValues.appendChild(span);
    }
    const headerZoom = document.createElement('div');
    headerZoom.textContent = 'Zoom';
    const headerSurf = document.createElement('div');
    headerSurf.textContent = 'Surfaces / ports';
    collapsedHeader.appendChild(headerDrag);
    collapsedHeader.appendChild(headerId);
    collapsedHeader.appendChild(headerValues);
    collapsedHeader.appendChild(headerZoom);
    collapsedHeader.appendChild(headerSurf);
    container.appendChild(collapsedHeader);

    type SequentialGroupView = {
        key: string;
        label: string;
        blockIds: string[];
    };
    const sequentialBlockIds = list
        .filter((entry: any) => !isPhysicalBlockType(String(entry?.blockType ?? '')))
        .map((entry: any) => String(entry?.blockId ?? '').trim())
        .filter(Boolean);
    const sequentialIdSet = new Set(sequentialBlockIds);
    const sequentialGroups: SequentialGroupView[] = [];
    const assignedSequentialIds = new Set<string>();
    const configuredGroups = Array.isArray(activeCfg?.sequentialGroups) ? activeCfg.sequentialGroups : [];
    for (const definition of configuredGroups) {
        const key = __blocks_sequentialGroupKey(definition?.id);
        if (sequentialGroups.some((entry) => entry.key === key)) continue;
        const memberIds = (Array.isArray(definition?.blockIds) ? definition.blockIds : [])
            .map((value: any) => String(value ?? '').trim())
            .filter((id: string) => sequentialIdSet.has(id) && !assignedSequentialIds.has(id));
        memberIds.forEach((id: string) => assignedSequentialIds.add(id));
        const rawLabel = String(definition?.label ?? '').trim();
        sequentialGroups.push({
            key,
            label: !rawLabel || rawLabel === 'Exact sequential optics'
                ? (key === 'main' ? 'Main lens train' : `Lens train · ${key}`)
                : rawLabel.replace(/^Lens\s+section\b/i, 'Lens design'),
            blockIds: memberIds
        });
    }
    if (sequentialGroups.length === 0) {
        sequentialGroups.push({ key: 'main', label: 'Lens design 1', blockIds: [] });
    }
    const unassignedSequentialIds = sequentialBlockIds.filter((id: string) => !assignedSequentialIds.has(id));
    let mainSequentialGroup = sequentialGroups.find((entry) => entry.key === 'main');
    if (!mainSequentialGroup && unassignedSequentialIds.length > 0) {
        mainSequentialGroup = { key: 'main', label: 'Lens design 1', blockIds: [] };
        sequentialGroups.unshift(mainSequentialGroup);
    }
    (mainSequentialGroup ?? sequentialGroups[0]).blockIds.push(...unassignedSequentialIds);

    const renderTargetByBlockId = new Map<string, HTMLElement>();
    // A numeric Config id is commonly reused by unrelated JSON files.  Using
    // it alone made a collapsed Lens design in one file hide the Blocks of a
    // newly loaded file with the same id.  Include the authored group/member
    // signature so collapse state follows the actual design instead.
    const lensSectionSignature = sequentialGroups
        .map((group) => `${group.key}:${group.blockIds.join(',')}`)
        .join('|');
    let lensSectionSignatureHash = 2166136261;
    for (let index = 0; index < lensSectionSignature.length; index += 1) {
        lensSectionSignatureHash ^= lensSectionSignature.charCodeAt(index);
        lensSectionSignatureHash = Math.imul(lensSectionSignatureHash, 16777619);
    }
    const lensSectionStorageKey = `coopt.designIntent.collapsedLensSections.${activeConfigIdForInspector || 'default'}.${(lensSectionSignatureHash >>> 0).toString(36)}`;
    const collapsedLensSections = (() => {
        try {
            const parsed = JSON.parse(localStorage.getItem(lensSectionStorageKey) || '[]');
            return new Set<string>(Array.isArray(parsed) ? parsed.map(String) : []);
        } catch (_) {
            return new Set<string>();
        }
    })();
    const persistCollapsedLensSections = () => {
        try { localStorage.setItem(lensSectionStorageKey, JSON.stringify(Array.from(collapsedLensSections))); } catch (_) {}
    };
    const recordAddedBlock = (res: any) => {
        __blockInspectorExpandedBlockId = String(res?.blockId ?? '') || null;
        try {
            if (w.undoHistory && w.AddBlockCommand && !w.undoHistory.isExecuting && res?.blockData && typeof res?.insertIndex === 'number') {
                const sysConfig = loadSystemConfigurations();
                const cmd = new w.AddBlockCommand(sysConfig.activeConfigId, res.blockData, res.insertIndex);
                w.undoHistory.record(cmd);
            }
        } catch (_) {}
        try {
            __cooptScheduleDesignIntentUiRefresh({ forceExpandedRows: true, refreshBlockInspector: true, triggerRender: true, debounceMs: 40 });
        } catch (_) {}
    };
    const addSequentialBlockOptions = (select: HTMLSelectElement) => {
        const exactGroup = document.createElement('optgroup');
        exactGroup.label = 'Exact sequential optics';
        const options: Array<[string, string]> = [
            ['SingleSurface', 'Single Surface'],
            ['Lens', 'Lens'],
            ['Paraxial', 'Paraxial'],
            ['Doublet', 'Doublet'],
            ['Triplet', 'Triplet'],
            ['Mirror', 'Sequential Mirror'],
            ['Gap', 'Gap'],
            ['Stop', 'Stop'],
            ['CoordTrans', 'Coordinate Transform']
        ];
        for (const [value, label] of options) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            exactGroup.appendChild(option);
        }
        const planeGroup = document.createElement('optgroup');
        planeGroup.label = 'Boundary planes';
        for (const [value, label] of [['ObjectPlane', 'Object Surface'], ['ImagePlane', 'Image Surface']] as Array<[string, string]>) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            planeGroup.appendChild(option);
        }
        select.append(exactGroup, planeGroup);
        select.value = 'Lens';
    };
    for (const [groupIndex, group] of sequentialGroups.entries()) {
        const section = document.createElement('section');
        section.className = 'block-inspector-lens-section';
        section.dataset.sequentialGroupId = group.key;
        if (collapsedLensSections.has(group.key)) section.classList.add('is-collapsed');

        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'block-inspector-section-header';
        const sectionToggle = document.createElement('button');
        sectionToggle.type = 'button';
        sectionToggle.className = 'block-inspector-section-toggle';
        sectionToggle.textContent = collapsedLensSections.has(group.key) ? '▸' : '▾';
        sectionToggle.title = 'Collapse / expand this lens design';
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'block-inspector-section-title-wrap';
        const sectionEyebrow = document.createElement('span');
        sectionEyebrow.textContent = `LENS DESIGN ${groupIndex + 1}`;
        const sectionName = document.createElement('strong');
        sectionName.textContent = group.label;
        sectionTitle.append(sectionEyebrow, sectionName);
        const frontPort = document.createElement('span');
        frontPort.className = 'block-inspector-port-chip';
        frontPort.textContent = 'Front';
        const flowArrow = document.createElement('span');
        flowArrow.className = 'block-inspector-section-flow';
        flowArrow.textContent = '→';
        const backPort = document.createElement('span');
        backPort.className = 'block-inspector-port-chip';
        backPort.textContent = 'Back';
        const sectionCount = document.createElement('span');
        sectionCount.className = 'block-inspector-section-count';
        sectionCount.textContent = `${group.blockIds.length} blocks`;

        const addControl = document.createElement('div');
        addControl.className = 'block-inspector-section-add';
        const addSelect = document.createElement('select');
        addSelect.setAttribute('aria-label', `Add block to ${group.label}`);
        addSequentialBlockOptions(addSelect);
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.textContent = 'Add';
        addButton.title = `Add an exact sequential block to ${group.label}`;
        addButton.onclick = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const lastGroupBlockId = [...group.blockIds].reverse().find((id) => sequentialIdSet.has(id)) ?? null;
            const res = __blocks_addBlockToActiveConfig(addSelect.value, lastGroupBlockId, group.key);
            if (!res || res.ok !== true) {
                alert(`Failed to add block: ${res?.reason || 'unknown error'}`);
                return;
            }
            recordAddedBlock(res);
        };
        addControl.append(addSelect, addButton);
        sectionHeader.append(sectionToggle, sectionTitle, addControl, frontPort, flowArrow, backPort, sectionCount);

        const sectionBody = document.createElement('div');
        sectionBody.className = 'block-inspector-section-body';
        normalizeLensSectionAnalysisInputs(activeCfg);
        const launchPanel = document.createElement('div');
        launchPanel.className = 'block-inspector-launch-panel';
        const launchHeading = document.createElement('div');
        launchHeading.className = 'block-inspector-launch-heading';
        const launchTitle = document.createElement('strong');
        launchTitle.textContent = 'Analysis input';
        const launchHelp = document.createElement('span');
        launchHelp.textContent = 'Route uses connected optics. Local launches the selected Source and Field directly at this port.';
        launchHeading.append(launchTitle, launchHelp);
        launchPanel.appendChild(launchHeading);

        const sourceSets = Array.isArray(activeCfg?.sourceSets) ? activeCfg.sourceSets : [];
        const fieldSets = Array.isArray(activeCfg?.fieldSets) ? activeCfg.fieldSets : [];
        const makeLaunchSelect = (
            label: string,
            value: string,
            options: Array<{ value: string; label: string }>,
            title: string
        ): { field: HTMLLabelElement; select: HTMLSelectElement } => {
            const field = document.createElement('label');
            field.className = 'block-inspector-launch-field';
            const caption = document.createElement('span');
            caption.textContent = label;
            const select = document.createElement('select');
            select.title = title;
            for (const optionDefinition of options) {
                const option = document.createElement('option');
                option.value = optionDefinition.value;
                option.textContent = optionDefinition.label;
                select.appendChild(option);
            }
            select.value = value;
            field.append(caption, select);
            return { field, select };
        };

        for (const port of ['Front', 'Back'] as LensSectionPort[]) {
            const binding = getLensSectionInputBinding(activeCfg, group.key, port);
            const launchRow = document.createElement('div');
            launchRow.className = 'block-inspector-launch-row';
            const portLabel = document.createElement('strong');
            portLabel.className = 'block-inspector-launch-port';
            portLabel.textContent = port;
            const modeControl = makeLaunchSelect('Input', binding.mode, [
                { value: 'route', label: 'From route' },
                { value: 'local', label: 'Local analysis' },
                { value: 'disabled', label: 'Disabled' }
            ], 'From route follows Port connections. Local analysis starts a standalone ray set here.');
            const sourceControl = makeLaunchSelect(
                'Source',
                binding.sourceSetId,
                sourceSets.map((set: any) => ({ value: String(set.id), label: String(set.label) })),
                'Named wavelength and weight table edited in Source.'
            );
            const fieldControl = makeLaunchSelect(
                'Field',
                binding.fieldSetId,
                fieldSets.map((set: any) => ({ value: String(set.id), label: String(set.label) })),
                'Named field-angle or object-height table edited in Field.'
            );
            const syncEnabledState = () => {
                const local = modeControl.select.value === 'local';
                sourceControl.select.disabled = !local;
                fieldControl.select.disabled = !local;
                launchRow.classList.toggle('is-route', modeControl.select.value === 'route');
                launchRow.classList.toggle('is-disabled', modeControl.select.value === 'disabled');
            };
            modeControl.select.onchange = () => {
                __blocks_updateLensSectionInput(group.key, port, { mode: modeControl.select.value as any });
                syncEnabledState();
            };
            sourceControl.select.onchange = () => {
                __blocks_updateLensSectionInput(group.key, port, { sourceSetId: sourceControl.select.value });
            };
            fieldControl.select.onchange = () => {
                __blocks_updateLensSectionInput(group.key, port, { fieldSetId: fieldControl.select.value });
            };
            launchRow.append(portLabel, modeControl.field, sourceControl.field, fieldControl.field);
            launchPanel.appendChild(launchRow);
            syncEnabledState();
        }
        sectionBody.appendChild(launchPanel);
        if (group.blockIds.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'block-inspector-section-empty';
            empty.textContent = 'Add a Lens, Surface, Stop, Gap, or Coordinate Transform here.';
            sectionBody.appendChild(empty);
        }
        const setCollapsed = (collapsed: boolean) => {
            section.classList.toggle('is-collapsed', collapsed);
            sectionToggle.textContent = collapsed ? '▸' : '▾';
            if (collapsed) collapsedLensSections.add(group.key); else collapsedLensSections.delete(group.key);
            persistCollapsedLensSections();
        };
        sectionToggle.onclick = (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setCollapsed(!section.classList.contains('is-collapsed'));
        };
        sectionHeader.ondblclick = (event: MouseEvent) => {
            if ((event.target as HTMLElement)?.closest('button, select')) return;
            setCollapsed(!section.classList.contains('is-collapsed'));
        };
        const clearGroupDropState = () => section.classList.remove('is-drag-target');
        section.addEventListener('dragover', (event: DragEvent) => {
            const draggedId = String(__blocks_draggedBlockId ?? '').trim();
            if (!draggedId || !sequentialIdSet.has(draggedId) || group.blockIds.includes(draggedId)) return;
            event.preventDefault();
            section.classList.add('is-drag-target');
        });
        section.addEventListener('dragleave', (event: DragEvent) => {
            if (!section.contains(event.relatedTarget as Node | null)) clearGroupDropState();
        });
        section.addEventListener('drop', (event: DragEvent) => {
            const draggedId = String(__blocks_draggedBlockId ?? '').trim();
            clearGroupDropState();
            if (!draggedId || !sequentialIdSet.has(draggedId) || group.blockIds.includes(draggedId)) return;
            event.preventDefault();
            event.stopPropagation();
            __blocks_moveBlockToSequentialGroup(draggedId, group.key);
        });

        section.append(sectionHeader, sectionBody);
        container.appendChild(section);
        group.blockIds.forEach((blockId) => renderTargetByBlockId.set(blockId, sectionBody));
    }

    const physicalBlockIds = list
        .filter((entry: any) => isPhysicalBlockType(String(entry?.blockType ?? '')))
        .map((entry: any) => String(entry?.blockId ?? '').trim())
        .filter(Boolean);
    let assemblyBody: HTMLElement | null = null;
    if (physicalBlockIds.length > 0) {
        const assemblySection = document.createElement('section');
        assemblySection.className = 'block-inspector-assembly-section';
        const assemblyHeader = document.createElement('div');
        assemblyHeader.className = 'block-inspector-section-header block-inspector-assembly-header';
        const assemblyIcon = document.createElement('span');
        assemblyIcon.className = 'block-inspector-assembly-icon';
        assemblyIcon.textContent = '◇';
        const assemblyTitle = document.createElement('div');
        assemblyTitle.className = 'block-inspector-section-title-wrap';
        assemblyTitle.innerHTML = '<span>PHYSICAL ASSEMBLY</span><strong>Sources, routing parts, targets, and detectors</strong>';
        const assemblyCount = document.createElement('span');
        assemblyCount.className = 'block-inspector-section-count';
        assemblyCount.textContent = `${physicalBlockIds.length} parts`;
        const assemblyHint = document.createElement('span');
        assemblyHint.className = 'block-inspector-assembly-hint';
        assemblyHint.textContent = 'Add from the toolbar above';
        assemblyHeader.append(assemblyIcon, assemblyTitle, assemblyCount, assemblyHint);
        assemblyBody = document.createElement('div');
        assemblyBody.className = 'block-inspector-section-body';
        assemblySection.append(assemblyHeader, assemblyBody);
        container.appendChild(assemblySection);
        physicalBlockIds.forEach((blockId) => renderTargetByBlockId.set(blockId, assemblyBody as HTMLElement));
    }
    const fallbackRenderTarget = assemblyBody ?? container;
    const blockRenderTargetForId = (blockId: string): HTMLElement => renderTargetByBlockId.get(blockId) ?? fallbackRenderTarget;

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
        if (!Number.isFinite(value)) return '';
        if (Math.abs(value) < 1e-9) return '';
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
        return '';
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
        el.style.width = '100%';
        el.style.minWidth = '0';
        el.style.height = '20px';
        el.style.boxSizing = 'border-box';
        el.style.fontSize = '11px';
        el.style.padding = '2px 6px';
        el.style.borderRadius = '4px';
        el.style.border = dark ? '1px solid #4b5563' : '1px solid #d0d7de';
        el.style.background = dark ? '#111827' : '#ffffff';
        el.style.color = dark ? '#f9fafb' : '#111827';
    };

    const resolveQuickColumnIndex = (label: string): number => {
        const key = String(label || '').trim().toLowerCase();
        if (!key) return 1;
        if (key.startsWith('r')) return 1;
        if (key === 'ct') return 2;
        if (key.startsWith('g')) return 3;
        if (key.startsWith('n')) return 4;
        if (key.startsWith('abbe') || key.startsWith('vd')) return 5;
        if (key.startsWith('sd')) return 6;
        return 6;
    };

    const createQuickFieldShell = (label: string): { wrapper: HTMLSpanElement; content: HTMLSpanElement } => {
        const wrapper = document.createElement('span');
        wrapper.className = 'block-inspector-quick-field';
        wrapper.style.gridColumn = String(resolveQuickColumnIndex(label));
        const tag = document.createElement('span');
        tag.className = 'block-inspector-quick-label';
        tag.textContent = label;
        const content = document.createElement('span');
        content.className = 'block-inspector-quick-content';
        wrapper.appendChild(tag);
        wrapper.appendChild(content);
        return { wrapper, content };
    };

    const getPreferredGlassManufacturers = (): string[] => {
        try {
            if (typeof localStorage === 'undefined') return [];
            const raw = JSON.parse(localStorage.getItem('coopt.glassMap.defaultManufacturers') || '[]');
            if (!Array.isArray(raw)) return [];
            const allowed = new Set(['SCHOTT', 'HOYA', 'HIKARI', 'OHARA', 'SUMITA', 'CDGM', 'SPECIAL']);
            const out: string[] = [];
            for (const value of raw) {
                const upper = String(value ?? '').trim().toUpperCase();
                if (!upper || !allowed.has(upper)) continue;
                out.push(upper);
            }
            return Array.from(new Set(out));
        } catch (_) {
            return [];
        }
    };

    const isGlassAllowedByPreferredManufacturers = (name: string, preferredManufacturers: string[]): boolean => {
        if (!Array.isArray(preferredManufacturers) || preferredManufacturers.length === 0) return true;
        try {
            const glass = getGlassDataWithSellmeier(name);
            const manufacturer = String(glass?.manufacturer ?? '').trim().toUpperCase();
            if (!manufacturer) return false;
            return preferredManufacturers.includes(manufacturer);
        } catch (_) {
            return false;
        }
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
        const vars = (blockLike.variables && typeof blockLike.variables === 'object') ? blockLike.variables : {};
        const blockId = String(blockLike?.blockId ?? '').trim();
        if (!blockId) return null;

        const root = document.createElement('div');
        root.className = 'block-inspector-quick-editor';
        root.style.setProperty('--quick-cols', '6');
        stopRowToggle(root);

        const createQuickRow = (): HTMLDivElement => {
            const row = document.createElement('div');
            row.className = 'block-inspector-quick-editor-row';
            stopRowToggle(row);
            return row;
        };

        const createQuickScopeToggle = (varKey: string): HTMLButtonElement => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'block-inspector-quick-scope-btn';

            const key = String(varKey || '').trim();
            let state: 'off' | 'perConfig' | 'global' = 'off';

            const resolveState = () => {
                const vEntry = __cooptGetEffectiveBlockVariableEntry(activeConfigIdForInspector, blockId, vars, key);
                const enabled = __blocks_shouldMarkVar(vEntry);
                const scope = __blocks_getVarScope(vEntry);
                if (!enabled) return 'off';
                return scope === 'global' ? 'global' : 'perConfig';
            };

            const render = () => {
                if (state === 'perConfig') {
                    btn.textContent = 'v';
                    btn.title = 'Pre-config';
                    btn.style.opacity = '1';
                } else if (state === 'global') {
                    btn.textContent = 'w';
                    btn.title = 'Share';
                    btn.style.opacity = '1';
                } else {
                    btn.textContent = '';
                    btn.title = 'Off';
                    btn.style.opacity = '0.5';
                }
            };

            state = resolveState();
            render();

            btn.onclick = (event: MouseEvent) => {
                try { event.preventDefault(); } catch (_) {}
                try { event.stopPropagation(); } catch (_) {}

                state = state === 'off' ? 'perConfig' : (state === 'perConfig' ? 'global' : 'off');

                if (state === 'off') {
                    __blocks_setVarMode(blockId, key, false, 'perConfig');
                } else if (state === 'perConfig') {
                    __blocks_setVarScope(blockId, key, 'perConfig');
                    __blocks_setVarMode(blockId, key, true, 'perConfig');
                } else {
                    __blocks_setVarScope(blockId, key, 'global');
                    __blocks_setVarMode(blockId, key, true, 'global');
                }
                render();
            };

            stopRowToggle(btn);
            return btn;
        };

        const attachQuickScopeToggle = (wrapper: HTMLElement, path: string) => {
            if (blockType === 'Stop' || isPhysicalBlockType(blockType)) return;
            const key = String(path ?? '').trim().split('.').pop() || '';
            if (!key) return;
            wrapper.insertBefore(createQuickScopeToggle(key), wrapper.firstChild);
        };

        const applyAssemblyQuickFieldPresentation = (wrapper: HTMLElement, path: string) => {
            const key = String(path ?? '').trim().split('.').pop() || '';
            const presentation = getAssemblyParameterPresentation(blockType, key);
            if (!presentation) return;
            const tag = wrapper.querySelector('.block-inspector-quick-label') as HTMLElement | null;
            if (tag) tag.textContent = presentation.compactLabel ?? presentation.label;
            wrapper.title = `${presentation.label}\n${presentation.help}`;
            wrapper.setAttribute('aria-label', `${presentation.label}. ${presentation.help}`);
        };

        const appendTextField = (label: string, path: string, currentValue: any, widthPx: number, target: HTMLElement = root): HTMLElement => {
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
            attachQuickScopeToggle(shell.wrapper, path);
            applyAssemblyQuickFieldPresentation(shell.wrapper, path);
            target.appendChild(shell.wrapper);
            return shell.wrapper;
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
                option.textContent = path === 'parameters.beamSplitterModel'
                    ? ({ ideal: 'Ideal surface', plate: 'Plate', cube: 'Cube', pellicle: 'Pellicle' } as Record<string, string>)[item] ?? item
                    : item;
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
            attachQuickScopeToggle(shell.wrapper, path);
            applyAssemblyQuickFieldPresentation(shell.wrapper, path);
            target.appendChild(shell.wrapper);
            return shell.wrapper;
        };

        const appendGrooveAxisField = (target: HTMLElement = root) => {
            const x = Number(params.grooveDirectionX) || 0;
            const y = Number(params.grooveDirectionY) || 0;
            const z = Number(params.grooveDirectionZ) || 0;
            const axis = Math.abs(z) < 1e-9 && Math.abs(x) > 0.999 && Math.abs(y) < 1e-9
                ? 'Local X'
                : Math.abs(z) < 1e-9 && Math.abs(y) > 0.999 && Math.abs(x) < 1e-9
                    ? 'Local Y'
                    : 'Custom';
            const shell = createQuickFieldShell('Grooves');
            shell.wrapper.title = 'Grating groove direction in the component local plane. Render shows the same direction.';
            const select = document.createElement('select');
            styleQuickInput(select, 82);
            ['Local X', 'Local Y', 'Custom'].forEach((value) => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = value;
                option.selected = value === axis;
                select.appendChild(option);
            });
            select.addEventListener('change', () => {
                if (select.value === 'Custom') return;
                const nextX = select.value === 'Local X' ? 1 : 0;
                const nextY = select.value === 'Local Y' ? 1 : 0;
                if (x !== nextX) cooptApplyBlockValue(blockId, 'parameters.grooveDirectionX', params.grooveDirectionX, nextX);
                if (y !== nextY) cooptApplyBlockValue(blockId, 'parameters.grooveDirectionY', params.grooveDirectionY, nextY);
                if (z !== 0) cooptApplyBlockValue(blockId, 'parameters.grooveDirectionZ', params.grooveDirectionZ, 0);
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
                const nextMaterial = cooptNormalizeInputValue(String(glass.name), materialValue, materialPath);
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

                const parseMaterialIndexSuffix = (pathValue: string): string => {
                    const key = String(pathValue || '').trim().split('.').pop() || '';
                    const m = key.toLowerCase().match(/^material(\d+)$/);
                    return m && m[1] ? m[1] : '';
                };
                const suffix = parseMaterialIndexSuffix(materialPath);
                const rindexKey = suffix ? `rindex${suffix}` : 'rindex';
                const abbeKey = suffix ? `abbe${suffix}` : 'abbe';
                const vdKey = suffix ? `vd${suffix}` : 'vd';

                const p: any = params && typeof params === 'object' ? params : null;
                let targetNd = Number.isFinite(Number(p?.[rindexKey])) ? Number(p?.[rindexKey]) : NaN;
                let targetVd = Number.isFinite(Number(p?.[abbeKey])) ? Number(p?.[abbeKey]) : NaN;
                if (!Number.isFinite(targetVd) || targetVd <= 0) {
                    targetVd = Number.isFinite(Number(p?.[vdKey])) ? Number(p?.[vdKey]) : NaN;
                }

                const numericNd = /^[-+]?((\d+\.\d*)|(\d*\.\d+)|(\d+))(e[-+]?\d+)?$/i.test(query) ? Number(query) : NaN;
                if (!Number.isFinite(targetNd) && Number.isFinite(numericNd) && numericNd > 0 && numericNd < 4) {
                    targetNd = numericNd;
                }

                let results: any[] = [];
                if (Number.isFinite(targetNd) && targetNd > 0 && targetNd < 4 && Number.isFinite(targetVd) && targetVd > 0) {
                    results = findSimilarGlassesByNdVd(Number(targetNd), Number(targetVd), 12);
                } else {
                    results = findSimilarGlassNames(query || String(materialValue ?? ''), 12);
                }
                const preferredManufacturers = getPreferredGlassManufacturers();
                results = results.filter((glass: any) => isGlassAllowedByPreferredManufacturers(glass?.name, preferredManufacturers));
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
            attachQuickScopeToggle(shell.wrapper, materialPath);
            target.appendChild(shell.wrapper);
        };

        if (isPhysicalBlockType(blockType)) {
            root.classList.add('block-inspector-quick-editor-physical');
            const specRow = createQuickRow();
            if (blockType === 'BroadbandSource') {
                appendTextField('λ min', 'parameters.minWavelengthNm', params.minWavelengthNm, 74, specRow);
                appendTextField('λ max', 'parameters.maxWavelengthNm', params.maxWavelengthNm, 74, specRow);
                appendTextField('Power W', 'parameters.totalPowerW', params.totalPowerW, 72, specRow);
            } else if (blockType === 'FrequencyCombSource') {
                appendTextField('λ center', 'parameters.centerWavelengthNm', params.centerWavelengthNm, 76, specRow);
                appendTextField('f rep', 'parameters.repetitionRateHz', params.repetitionRateHz, 94, specRow);
                appendTextField('f CEO', 'parameters.ceoFrequencyHz', params.ceoFrequencyHz, 94, specRow);
                appendTextField('Lines', 'parameters.lineCount', params.lineCount, 62, specRow);
            } else if (blockType === 'BeamSplitter') {
                const splitterModel = String(params.beamSplitterModel ?? 'ideal').toLowerCase();
                appendSelectField('Model', 'parameters.beamSplitterModel', splitterModel, ['ideal', 'plate', 'cube', 'pellicle'], 82, specRow);
                appendSelectField('Reflect side', 'parameters.reflectionPort', String(params.reflectionPort ?? 'reflect').toLowerCase(), ['reflect', 'recombine'], 96, specRow);
                appendTextField('R', 'parameters.reflectance', params.reflectance, 62, specRow);
                appendTextField('T', 'parameters.transmittance', params.transmittance, 62, specRow);
            } else if (blockType === 'ReflectionGrating') {
                appendTextField('lines/mm', 'parameters.grooveDensityLinesPerMm', params.grooveDensityLinesPerMm, 82, specRow);
                appendGrooveAxisField(specRow);
                appendTextField('Depth mag.', 'parameters.detectorMagnification', params.detectorMagnification ?? 1, 72, specRow);
                appendTextField('Order', 'parameters.order', params.order, 58, specRow);
                appendTextField('Efficiency', 'parameters.efficiency', params.efficiency, 68, specRow);
            } else if (blockType === 'Target') {
                appendSelectField('Profile', 'parameters.profile', params.profile, ['flat', 'step', 'tilt', 'sine', 'csv', 'stl'], 82, specRow);
                appendSelectField('Interaction', 'parameters.interaction', params.interaction, ['specular', 'lambertian', 'abg', 'harvey-shack', 'bsdf-csv'], 108, specRow);
                appendTextField('Reflect.', 'parameters.reflectance', params.reflectance, 68, specRow);
            } else if (blockType === 'AreaDetector') {
                appendTextField('Pixels X', 'parameters.pixelCountX', params.pixelCountX, 72, specRow);
                appendTextField('Pixels Y', 'parameters.pixelCountY', params.pixelCountY, 72, specRow);
                appendTextField('Pitch µm', 'parameters.pixelPitchUm', params.pixelPitchUm, 72, specRow);
                appendTextField('QE', 'parameters.quantumEfficiency', params.quantumEfficiency, 60, specRow);
                appendTextField('Height min', 'parameters.calibrationMinUm', params.calibrationMinUm ?? -80, 72, specRow);
                appendTextField('Height max', 'parameters.calibrationMaxUm', params.calibrationMaxUm ?? 80, 72, specRow);
            } else if (blockType === 'TimeDetector') {
                appendTextField('Sample Hz', 'parameters.samplingRateHz', params.samplingRateHz, 94, specRow);
                appendTextField('Samples', 'parameters.sampleCount', params.sampleCount, 72, specRow);
                appendTextField('Bandwidth', 'parameters.detectionBandwidthHz', params.detectionBandwidthHz, 94, specRow);
            } else {
                if (blockType === 'NDFilter') appendTextField('T', 'parameters.transmission', params.transmission, 62, specRow);
                if (blockType === 'FoldMirror') appendTextField('R', 'parameters.reflectance', params.reflectance, 62, specRow);
            }
            if (specRow.childElementCount > 0) root.appendChild(specRow);
            if (blockType === 'BroadbandSource' || blockType === 'FrequencyCombSource') {
                const rayRow = createQuickRow();
                appendTextField('Render rays', 'parameters.renderSpatialSamples', params.renderSpatialSamples ?? Math.min(9, Number(params.spatialSamples) || 9), 78, rayRow);
                appendTextField('Signal rays', 'parameters.detectorSpatialSamples', params.detectorSpatialSamples ?? params.spatialSamples ?? 81, 78, rayRow);
                root.appendChild(rayRow);
            }
            if (blockType === 'Target') {
                const profile = String(params.profile ?? 'flat').toLowerCase();
                const shapeRow = createQuickRow();
                if (profile === 'step' || profile === 'tilt' || profile === 'sine') {
                    appendTextField('Height µm', 'parameters.amplitudeUm', params.amplitudeUm ?? 0, 72, shapeRow);
                }
                if (profile === 'sine') appendTextField('Period mm', 'parameters.periodMm', params.periodMm ?? 2, 72, shapeRow);
                if (profile === 'step') appendTextField('Step X mm', 'parameters.stepPositionMm', params.stepPositionMm ?? 0, 72, shapeRow);
                if (shapeRow.childElementCount > 0) root.appendChild(shapeRow);
            }

            // Placement and envelope are common to every assembly part. Keep
            // them compact instead of repeating ten full-width parameter rows.
            const placementRow = createQuickRow();
            appendTextField('X mm', 'parameters.positionXmm', params.positionXmm ?? 0, 66, placementRow);
            appendTextField('Y mm', 'parameters.positionYmm', params.positionYmm ?? 0, 66, placementRow);
            appendTextField('Z mm', 'parameters.positionZmm', params.positionZmm ?? 0, 66, placementRow);
            appendTextField('Rot X', 'parameters.rotationXdeg', params.rotationXdeg ?? 0, 62, placementRow);
            appendTextField('Rot Y', 'parameters.rotationYdeg', params.rotationYdeg ?? 0, 62, placementRow);
            appendTextField('Rot Z', 'parameters.rotationZdeg', params.rotationZdeg ?? 0, 62, placementRow);
            root.appendChild(placementRow);

            const envelopeRow = createQuickRow();
            appendTextField('Width', 'parameters.widthMm', params.widthMm, 66, envelopeRow);
            appendTextField('Height', 'parameters.heightMm', params.heightMm, 66, envelopeRow);
            appendTextField('Depth', 'parameters.depthMm', params.depthMm, 66, envelopeRow);
            appendTextField('Aperture', 'parameters.apertureDiameterMm', params.apertureDiameterMm, 72, envelopeRow);
            root.appendChild(envelopeRow);
        } else if (blockType === 'Paraxial') {
            root.classList.add('block-inspector-quick-editor-multiline');
            const semiDiameter = aperture.front ?? aperture.s1 ?? aperture.back ?? '';

            // Fx/Fy are the ideal-lens equivalents of surface radius, so keep
            // both controls in the Radius column. Explicit grid placement is
            // intentional: nested display:contents rows can otherwise place
            // these controls in the last visible spreadsheet column.
            const fxField = appendTextField('Fx', 'parameters.focalLengthX', params.focalLengthX ?? params.focalLengthY ?? params.focalLength, 72);
            fxField.style.gridColumn = '1';
            fxField.style.gridRow = '1';

            const fyField = appendTextField('Fy', 'parameters.focalLengthY', params.focalLengthY ?? params.focalLengthX ?? params.focalLength, 72);
            fyField.style.gridColumn = '1';
            fyField.style.gridRow = '2';

            const sdField = appendTextField('SD', 'aperture.front', semiDiameter, 58);
            sdField.style.gridColumn = '6';
            sdField.style.gridRow = '1 / span 2';
        } else if (blockType === 'Lens' || blockType === 'PositiveLens') {
            root.classList.add('block-inspector-quick-editor-multiline');
            root.style.setProperty('--quick-cols', '6');
            const row1 = createQuickRow();
            const row2 = createQuickRow();

            appendTextField('R1', 'parameters.frontRadius', params.frontRadius, 62, row1);
            appendTextField('CT', 'parameters.centerThickness', params.centerThickness, 54, row1);
            appendMaterialField('parameters.material', params.material, 'parameters.abbe', params.abbe, 'G', row1);
            appendTextField('n', 'parameters.rindex', params.rindex, 54, row1);
            appendTextField('Abbe', 'parameters.abbe', params.abbe, 54, row1);
            appendTextField('SD1', 'aperture.front', aperture.front, 50, row1);

            appendTextField('R2', 'parameters.backRadius', params.backRadius, 62, row2);
            appendSpacerField('CT', 54, row2);
            appendSpacerField('G', 188, row2);
            appendSpacerField('n', 54, row2);
            appendSpacerField('Abbe', 54, row2);
            appendTextField('SD2', 'aperture.back', aperture.back, 50, row2);

            root.appendChild(row1);
            root.appendChild(row2);
        } else if (blockType === 'Doublet') {
            root.classList.add('block-inspector-quick-editor-multiline');
            root.style.setProperty('--quick-cols', '6');
            const row1 = createQuickRow();
            const row2 = createQuickRow();
            const row3 = createQuickRow();

            appendTextField('R1', 'parameters.radius1', params.radius1, 62, row1);
            appendTextField('CT', 'parameters.thickness1', params.thickness1, 54, row1);
            appendMaterialField('parameters.material1', params.material1, 'parameters.abbe1', params.abbe1, 'G1', row1);
            appendTextField('n1', 'parameters.rindex1', params.rindex1, 60, row1);
            appendTextField('Abbe1', 'parameters.abbe1', params.abbe1, 60, row1);
            appendTextField('SD1', 'aperture.s1', aperture.s1, 50, row1);

            appendTextField('R2', 'parameters.radius2', params.radius2, 62, row2);
            appendTextField('CT', 'parameters.thickness2', params.thickness2, 54, row2);
            appendMaterialField('parameters.material2', params.material2, 'parameters.abbe2', params.abbe2, 'G2', row2);
            appendTextField('n2', 'parameters.rindex2', params.rindex2, 60, row2);
            appendTextField('Abbe2', 'parameters.abbe2', params.abbe2, 60, row2);
            appendTextField('SD2', 'aperture.s2', aperture.s2, 50, row2);

            appendTextField('R3', 'parameters.radius3', params.radius3, 62, row3);
            appendSpacerField('CT', 54, row3);
            appendSpacerField('G1', 188, row3);
            appendSpacerField('n1', 60, row3);
            appendSpacerField('Abbe1', 60, row3);
            appendTextField('SD3', 'aperture.s3', aperture.s3, 50, row3);

            root.appendChild(row1);
            root.appendChild(row2);
            root.appendChild(row3);
        } else if (blockType === 'Triplet') {
            root.classList.add('block-inspector-quick-editor-multiline');
            root.style.setProperty('--quick-cols', '6');
            const row1 = createQuickRow();
            const row2 = createQuickRow();
            const row3 = createQuickRow();

            appendTextField('R1', 'parameters.radius1', params.radius1, 62, row1);
            appendTextField('CT', 'parameters.thickness1', params.thickness1, 54, row1);
            appendMaterialField('parameters.material1', params.material1, 'parameters.abbe1', params.abbe1, 'G1', row1);
            appendTextField('n1', 'parameters.rindex1', params.rindex1, 60, row1);
            appendTextField('Abbe1', 'parameters.abbe1', params.abbe1, 60, row1);
            appendTextField('SD1', 'aperture.s1', aperture.s1, 50, row1);

            appendTextField('R2', 'parameters.radius2', params.radius2, 62, row2);
            appendTextField('CT', 'parameters.thickness2', params.thickness2, 54, row2);
            appendMaterialField('parameters.material2', params.material2, 'parameters.abbe2', params.abbe2, 'G2', row2);
            appendTextField('n2', 'parameters.rindex2', params.rindex2, 60, row2);
            appendTextField('Abbe2', 'parameters.abbe2', params.abbe2, 60, row2);
            appendTextField('SD2', 'aperture.s2', aperture.s2, 50, row2);

            appendTextField('R3', 'parameters.radius3', params.radius3, 62, row3);
            appendTextField('CT', 'parameters.thickness3', params.thickness3, 54, row3);
            appendMaterialField('parameters.material3', params.material3, 'parameters.abbe3', params.abbe3, 'G3', row3);
            appendTextField('n3', 'parameters.rindex3', params.rindex3, 60, row3);
            appendTextField('Abbe3', 'parameters.abbe3', params.abbe3, 60, row3);
            appendTextField('SD3', 'aperture.s3', aperture.s3, 50, row3);
            appendTextField('R4', 'parameters.radius4', params.radius4, 62, row3);
            appendTextField('SD4', 'aperture.s4', aperture.s4, 50, row3);

            root.appendChild(row1);
            root.appendChild(row2);
            root.appendChild(row3);
        } else if (blockType === 'Gap' || blockType === 'AirGap') {
            appendSpacerField('R', 62);
            appendTextField('CT', 'parameters.thickness', params.thickness, 54);
            appendMaterialField('parameters.material', params.material, 'parameters.abbe', params.abbe, 'G');
            appendTextField('n', 'parameters.rindex', params.rindex, 54);
            appendTextField('Abbe', 'parameters.abbe', params.abbe, 54);
            appendSpacerField('SD', 50);
        } else if (blockType === 'Stop') {
            appendSpacerField('R', 62);
            appendSpacerField('CT', 54);
            appendSpacerField('G', 188);
            appendSpacerField('n', 54);
            appendSpacerField('Abbe', 54);
            appendTextField('SD', 'parameters.semiDiameter', params.semiDiameter, 54);
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
        if (isPhysicalBlockType(String(b?.blockType ?? '')) && isHiddenByCollapsedParent(blockId)) continue;
        const row = document.createElement('div');
        row.className = 'block-inspector-row block-inspector-row-spreadsheet';
        if (blockId && __blockInspectorExpandedBlockId === blockId) row.classList.add('selected');

        const colId = document.createElement('div');
        colId.className = 'block-inspector-col-id';
        const blockLabel = document.createElement('span');
        blockLabel.className = 'block-inspector-tree-label';
        blockLabel.textContent = buildBlockInspectorLabelText(b);
        const isPhysicalTreeBlock = isPhysicalBlockType(String(b?.blockType ?? ''));
        if (isPhysicalTreeBlock) row.classList.add('block-inspector-row-physical');
        if (isPhysicalTreeBlock) {
            const depth = Math.max(0, hierarchyDepth.get(blockId) ?? 0);
            colId.classList.add('block-inspector-col-id-tree');
            colId.style.setProperty('--di-tree-depth', String(depth));
            const children = hierarchyChildren.get(blockId) ?? [];
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'block-inspector-tree-toggle';
            toggle.textContent = children.length ? (collapsedHierarchyIds.has(blockId) ? '▸' : '▾') : '·';
            toggle.disabled = children.length === 0;
            toggle.title = children.length ? 'Collapse / expand connected downstream blocks' : 'No downstream connection';
            toggle.onclick = (event: MouseEvent) => {
                event.preventDefault(); event.stopPropagation();
                if (!children.length) return;
                if (collapsedHierarchyIds.has(blockId)) collapsedHierarchyIds.delete(blockId); else collapsedHierarchyIds.add(blockId);
                persistCollapsedHierarchy();
                try { refreshBlockInspector(); } catch (_) {}
            };
            colId.appendChild(toggle);
            const pathLabel = hierarchyPathByChild.get(blockId);
            if (pathLabel) {
                const pathChip = document.createElement('span');
                pathChip.className = 'block-inspector-tree-path';
                pathChip.textContent = pathLabel;
                colId.appendChild(pathChip);
            }
        }
        colId.appendChild(blockLabel);

        const realBlock = (blockById && typeof blockById.get === 'function') ? blockById.get(blockId) || b : b;
        const zoomGroupLabel = getZoomGroupLabel(realBlock);
        const gapZoomChipLabel = getGapZoomChipLabel(realBlock);
        const currentZoomGroupValue = String(readPathValue(realBlock, 'parameters.zoomGroup') ?? 'Fixed').trim() || 'Fixed';
        let zoomGroupChip: HTMLElement | null = null;
        if (zoomGroupLabel) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'block-inspector-zg-chip';
            chip.textContent = currentZoomGroupValue === 'Fixed' ? 'Fixed' : currentZoomGroupValue;
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
            chip.textContent = gapZoomChipLabel === 'Fixed' ? 'Fixed' : gapZoomChipLabel;
            chip.title = `Zoom Group: ${gapZoomChipLabel}`;
            zoomGroupChip = chip;
        }
        const zoomGroupCell = zoomGroupChip || (() => {
            const empty = document.createElement('span');
            empty.className = 'block-inspector-zg-chip-placeholder';
            return empty;
        })();
        const colZoom = document.createElement('div');
        colZoom.className = 'block-inspector-col-zg';
        colZoom.appendChild(zoomGroupCell);

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
        const colParams = document.createElement('div');
        colParams.className = 'block-inspector-col-params';
        const previewText = String(b.preview ?? '');
        const quickEditor = quickEditorEnabled && (!isPhysicalTreeBlock || __blockInspectorExpandedBlockId === blockId)
            ? createQuickEditor(realBlock)
            : null;
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
            const zoomSummary = getZoomPositionSummary(realBlock);
            if (zoomSummary) {
                colParams.appendChild(createSummaryChip(zoomSummary, 'controller'));
            }
            const lawGroups = getZoomLawGroupNames(realBlock);
            if (lawGroups.length > 0) {
                colParams.appendChild(createSummaryChip(`Laws: ${lawGroups.join(', ')}`, 'controller'));
            }
        } else if (!quickEditor && !zoomGroupChip) {
            const zoomGroupText = getZoomGroupLabel(realBlock);
            if (zoomGroupText) {
                colParams.appendChild(createSummaryChip(zoomGroupText === 'Fixed' ? 'Fixed' : zoomGroupText, 'group'));
            }
        }

        const colCount = document.createElement('div');
        colCount.className = 'block-inspector-col-count';
        const n = getLogicalSurfaceCountForBlock(b);
        if (isPhysicalTreeBlock) {
            colCount.classList.add('block-inspector-physical-actions');
            const portLabel = document.createElement('span');
            portLabel.textContent = String(portsForPhysicalBlock(rawTypeForSummary as PhysicalBlockType).length) + ' ports';
            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'block-inspector-physical-edit';
            editButton.textContent = __blockInspectorExpandedBlockId === blockId ? 'Done' : 'Edit';
            editButton.title = __blockInspectorExpandedBlockId === blockId ? 'Close parameter editor' : 'Edit parameters';
            editButton.onclick = (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                __blockInspectorExpandedBlockId = __blockInspectorExpandedBlockId === blockId ? null : blockId;
                try { refreshBlockInspector(); } catch (_) {}
            };
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'block-inspector-physical-remove';
            removeButton.textContent = 'Remove';
            removeButton.title = 'Remove ' + buildBlockInspectorLabelText(b);
            removeButton.onclick = (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                __deleteDesignIntentBlock(blockId);
            };
            colCount.append(portLabel, editButton, removeButton);
        } else {
            colCount.textContent = '→ ' + String(Number.isFinite(n) ? n : 0) + ' surfaces';
        }

        // Drag handle
        const dragHandle = document.createElement('span');
        dragHandle.className = 'block-inspector-drag-handle';
        dragHandle.textContent = '⠿';
        dragHandle.title = 'ドラッグして並び替え';

        row.appendChild(dragHandle);
        row.appendChild(colId);
        row.appendChild(colParams);
        row.appendChild(colZoom);
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

        blockRenderTargetForId(blockId).appendChild(row);

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
            const quickEditorCoveredParamKeys = new Set<string>();
            const quickEditorCoveredApertureKeys = new Set<string>();
            
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
            const shouldHideExpandedField = (rawKey: string): boolean => {
                const key = String(rawKey ?? '').trim().toLowerCase();
                if (!key) return false;
                if (key === 'zoomgroup') return true;
                if (key.includes('semidia') || key === 'semidiameter') return true;
                if (/^rindex\d*$/.test(key)) return true;
                if ((blockType === 'BroadbandSource' || blockType === 'FrequencyCombSource') && key === 'spatialsamples') return true;
                return false;
            };
            if (quickEditorEnabled) {
                if (isPhysicalBlockType(blockType)) {
                    [
                        'positionXmm', 'positionYmm', 'positionZmm',
                        'rotationXdeg', 'rotationYdeg', 'rotationZdeg',
                        'widthMm', 'heightMm', 'depthMm', 'apertureDiameterMm',
                    ].forEach((k) => quickEditorCoveredParamKeys.add(k.toLowerCase()));
                    const physicalQuickKeys: Partial<Record<PhysicalBlockType, string[]>> = {
                        BroadbandSource: ['minWavelengthNm', 'maxWavelengthNm', 'totalPowerW', 'renderSpatialSamples', 'detectorSpatialSamples'],
                        FrequencyCombSource: ['centerWavelengthNm', 'repetitionRateHz', 'ceoFrequencyHz', 'lineCount', 'renderSpatialSamples', 'detectorSpatialSamples'],
                        BeamSplitter: ['beamSplitterModel', 'reflectionPort', 'reflectance', 'transmittance'],
                        FoldMirror: ['reflectance'],
                        NDFilter: ['transmission'],
                        ReflectionGrating: ['grooveDensityLinesPerMm', 'detectorMagnification', 'order', 'efficiency'],
                        Target: ['profile', 'interaction', 'reflectance'],
                        AreaDetector: ['pixelCountX', 'pixelCountY', 'pixelPitchUm', 'quantumEfficiency', 'calibrationMinUm', 'calibrationMaxUm'],
                        TimeDetector: ['samplingRateHz', 'sampleCount', 'detectionBandwidthHz'],
                    };
                    (physicalQuickKeys[blockType as PhysicalBlockType] ?? []).forEach((k) => quickEditorCoveredParamKeys.add(k.toLowerCase()));
                    if (blockType === 'Target') {
                        const profile = String(params.profile ?? 'flat').toLowerCase();
                        if (profile === 'step' || profile === 'tilt' || profile === 'sine') quickEditorCoveredParamKeys.add('amplitudeum');
                        if (profile === 'sine') quickEditorCoveredParamKeys.add('periodmm');
                        if (profile === 'step') quickEditorCoveredParamKeys.add('steppositionmm');
                    }
                    if (blockType === 'ReflectionGrating') {
                        const gx = Number(params.grooveDirectionX) || 0;
                        const gy = Number(params.grooveDirectionY) || 0;
                        const gz = Number(params.grooveDirectionZ) || 0;
                        const isAxisAligned = Math.abs(gz) < 1e-9 && (
                            (Math.abs(gx) > 0.999 && Math.abs(gy) < 1e-9)
                            || (Math.abs(gy) > 0.999 && Math.abs(gx) < 1e-9)
                        );
                        if (isAxisAligned) {
                            ['grooveDirectionX', 'grooveDirectionY', 'grooveDirectionZ'].forEach((k) => quickEditorCoveredParamKeys.add(k.toLowerCase()));
                        }
                    }
                } else if (blockType === 'Paraxial') {
                    ['focalLengthX', 'focalLengthY'].forEach((k) => quickEditorCoveredParamKeys.add(k.toLowerCase()));
                    ['front', 's1', 'back', 'surf1', 'surf2'].forEach((k) => quickEditorCoveredApertureKeys.add(k.toLowerCase()));
                } else if (blockType === 'Lens' || blockType === 'PositiveLens') {
                    ['frontRadius', 'backRadius', 'centerThickness', 'material', 'rindex', 'abbe'].forEach((k) => quickEditorCoveredParamKeys.add(k.toLowerCase()));
                    ['front', 'back'].forEach((k) => quickEditorCoveredApertureKeys.add(k.toLowerCase()));
                } else if (blockType === 'Doublet') {
                    ['radius1', 'radius2', 'radius3', 'thickness1', 'thickness2', 'material1', 'material2', 'rindex1', 'rindex2', 'abbe1', 'abbe2'].forEach((k) => quickEditorCoveredParamKeys.add(k.toLowerCase()));
                    ['s1', 's2', 's3'].forEach((k) => quickEditorCoveredApertureKeys.add(k.toLowerCase()));
                } else if (blockType === 'Triplet') {
                    ['radius1', 'radius2', 'radius3', 'radius4', 'thickness1', 'thickness2', 'thickness3', 'material1', 'material2', 'material3', 'rindex1', 'rindex2', 'rindex3', 'abbe1', 'abbe2', 'abbe3'].forEach((k) => quickEditorCoveredParamKeys.add(k.toLowerCase()));
                    ['s1', 's2', 's3', 's4'].forEach((k) => quickEditorCoveredApertureKeys.add(k.toLowerCase()));
                } else if (blockType === 'Gap' || blockType === 'AirGap') {
                    ['thickness', 'material', 'abbe'].forEach((k) => quickEditorCoveredParamKeys.add(k.toLowerCase()));
                } else if (blockType === 'SingleSurface' || blockType === 'Mirror') {
                    quickEditorCoveredParamKeys.add('radius');
                    if (Object.prototype.hasOwnProperty.call(params, 'material')) {
                        quickEditorCoveredParamKeys.add('material');
                        quickEditorCoveredParamKeys.add('abbe');
                    }
                    quickEditorCoveredApertureKeys.add('semidia');
                } else if (blockType === 'ImageSurface') {
                    quickEditorCoveredParamKeys.add('semidia');
                }
            }

            // For Gap blocks, ensure material/thicknessMode are always in paramKeys even if not set
            const allParamKeys = Object.keys(params || {}).filter(k => {
                // chiefRayShiftX/Y/Z は廃止フィールド。表示しない
                const kl = k.toLowerCase();
                if (shouldHideExpandedField(kl)) return false;
                if (kl === 'chiefrayshiftx' || kl === 'chiefrayshifty' || kl === 'chiefrayshiftz') return false;
                if (kl === 'zoomgroupaprofile' || kl === 'zoomgroupbprofile') return false;
                if (blockType === 'Doublet' && kl === 'bending') return false;
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
            if (blockType === 'BroadbandSource' || blockType === 'FrequencyCombSource') {
                if (!allParamKeys.includes('renderSpatialSamples')) allParamKeys.push('renderSpatialSamples');
                if (!allParamKeys.includes('detectorSpatialSamples')) allParamKeys.push('detectorSpatialSamples');
            }
            if (blockType === 'AreaDetector') {
                if (!allParamKeys.includes('calibrationMinUm')) allParamKeys.push('calibrationMinUm');
                if (!allParamKeys.includes('calibrationMaxUm')) allParamKeys.push('calibrationMaxUm');
            }
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
                if (String(params.surfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('qconNrad')) {
                    allParamKeys.push('qconNrad');
                }
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
            if (blockType === 'Lens' || blockType === 'PositiveLens') {
                if (!allParamKeys.includes('bending')) allParamKeys.push('bending');
            }
            if ((blockType === 'Lens' || blockType === 'PositiveLens') && !allParamKeys.includes('abbe')) {
                allParamKeys.push('abbe');
            }
            if (blockType === 'Doublet') {
                if (!allParamKeys.includes('abbe1')) allParamKeys.push('abbe1');
                if (!allParamKeys.includes('abbe2')) allParamKeys.push('abbe2');
            }
            if (blockType === 'Triplet') {
                if (!allParamKeys.includes('abbe1')) allParamKeys.push('abbe1');
                if (!allParamKeys.includes('abbe2')) allParamKeys.push('abbe2');
                if (!allParamKeys.includes('abbe3')) allParamKeys.push('abbe3');
            }
            // For Lens and other blocks with front/back surfaces, ensure coefficient fields are present
            if (blockType === 'Lens' || blockType === 'PositiveLens' || blockType === 'SingleSurface' || blockType === 'Mirror') {
                if (!allParamKeys.includes('frontSurfType')) allParamKeys.push('frontSurfType');
                if (!allParamKeys.includes('backSurfType')) allParamKeys.push('backSurfType');
                if (String(params.frontSurfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('frontQconNrad')) {
                    allParamKeys.push('frontQconNrad');
                }
                if (String(params.backSurfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('backQconNrad')) {
                    allParamKeys.push('backQconNrad');
                }
                for (let i = 1; i <= 10; i++) {
                    const frontCoefKey = `frontCoef${i}`;
                    const backCoefKey = `backCoef${i}`;
                    if (!allParamKeys.includes(frontCoefKey)) allParamKeys.push(frontCoefKey);
                    if (!allParamKeys.includes(backCoefKey)) allParamKeys.push(backCoefKey);
                }
            }
            if (blockType === 'Doublet') {
                if (!allParamKeys.includes('surf1SurfType')) allParamKeys.push('surf1SurfType');
                if (!allParamKeys.includes('surf2SurfType')) allParamKeys.push('surf2SurfType');
                if (!allParamKeys.includes('surf3SurfType')) allParamKeys.push('surf3SurfType');
                if (String(params.surf1SurfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('surf1QconNrad')) {
                    allParamKeys.push('surf1QconNrad');
                }
                if (String(params.surf2SurfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('surf2QconNrad')) {
                    allParamKeys.push('surf2QconNrad');
                }
                if (String(params.surf3SurfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('surf3QconNrad')) {
                    allParamKeys.push('surf3QconNrad');
                }
                for (let i = 1; i <= 10; i++) {
                    const surf1CoefKey = `surf1Coef${i}`;
                    const surf2CoefKey = `surf2Coef${i}`;
                    const surf3CoefKey = `surf3Coef${i}`;
                    if (!allParamKeys.includes(surf1CoefKey)) allParamKeys.push(surf1CoefKey);
                    if (!allParamKeys.includes(surf2CoefKey)) allParamKeys.push(surf2CoefKey);
                    if (!allParamKeys.includes(surf3CoefKey)) allParamKeys.push(surf3CoefKey);
                }
            }
            if (blockType === 'Triplet') {
                if (!allParamKeys.includes('surf1SurfType')) allParamKeys.push('surf1SurfType');
                if (!allParamKeys.includes('surf2SurfType')) allParamKeys.push('surf2SurfType');
                if (!allParamKeys.includes('surf3SurfType')) allParamKeys.push('surf3SurfType');
                if (!allParamKeys.includes('surf4SurfType')) allParamKeys.push('surf4SurfType');
                if (String(params.surf1SurfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('surf1QconNrad')) {
                    allParamKeys.push('surf1QconNrad');
                }
                if (String(params.surf2SurfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('surf2QconNrad')) {
                    allParamKeys.push('surf2QconNrad');
                }
                if (String(params.surf3SurfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('surf3QconNrad')) {
                    allParamKeys.push('surf3QconNrad');
                }
                if (String(params.surf4SurfType ?? '').toLowerCase() === 'qcon' && !allParamKeys.includes('surf4QconNrad')) {
                    allParamKeys.push('surf4QconNrad');
                }
                for (let i = 1; i <= 10; i++) {
                    const surf1CoefKey = `surf1Coef${i}`;
                    const surf2CoefKey = `surf2Coef${i}`;
                    const surf3CoefKey = `surf3Coef${i}`;
                    const surf4CoefKey = `surf4Coef${i}`;
                    if (!allParamKeys.includes(surf1CoefKey)) allParamKeys.push(surf1CoefKey);
                    if (!allParamKeys.includes(surf2CoefKey)) allParamKeys.push(surf2CoefKey);
                    if (!allParamKeys.includes(surf3CoefKey)) allParamKeys.push(surf3CoefKey);
                    if (!allParamKeys.includes(surf4CoefKey)) allParamKeys.push(surf4CoefKey);
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
            const varKeys = blockType === 'Stop'
                ? []
                : sortVariableKeys(Object.keys(vars || {}).filter((k) => !shouldHideExpandedField(k)));

            const normalizeSurfTypeLabel = (value: any) => {
                return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
            };

            const isQconSurfTypeValue = (value: any): boolean => {
                return normalizeSurfTypeLabel(value) === 'qcon';
            };

            const getSurfTypeForCoefKey = (key: string) => {
                const lower = String(key).toLowerCase();
                if (lower.startsWith('frontcoef')) return params.frontSurfType;
                if (lower.startsWith('frontqconnrad')) return params.frontSurfType;
                if (lower.startsWith('backcoef')) return params.backSurfType;
                if (lower.startsWith('backqconnrad')) return params.backSurfType;
                if (lower.startsWith('surf1coef') || lower.startsWith('surf1qconnrad')) return params.surf1SurfType;
                if (lower.startsWith('surf2coef') || lower.startsWith('surf2qconnrad')) return params.surf2SurfType;
                if (lower.startsWith('surf3coef') || lower.startsWith('surf3qconnrad')) return params.surf3SurfType;
                if (lower.startsWith('surf4coef') || lower.startsWith('surf4qconnrad')) return params.surf4SurfType;
                return params.surfType;
            };

            const getSurfTypeForConicKey = (key: string) => {
                const lower = String(key).toLowerCase();
                if (lower === 'frontconic' || lower === 'frontqconnrad') return params.frontSurfType;
                if (lower === 'backconic' || lower === 'backqconnrad') return params.backSurfType;
                if (lower === 'surf1conic' || lower === 'surf1qconnrad') return params.surf1SurfType;
                if (lower === 'surf2conic' || lower === 'surf2qconnrad') return params.surf2SurfType;
                if (lower === 'surf3conic' || lower === 'surf3qconnrad') return params.surf3SurfType;
                if (lower === 'surf4conic' || lower === 'surf4qconnrad') return params.surf4SurfType;
                if (lower === 'conic') return params.surfType;
                return undefined;
            };

            const isQconCoefKey = (key: string): boolean => {
                if (!/coef\d+/i.test(String(key))) return false;
                return isQconSurfTypeValue(getSurfTypeForCoefKey(key));
            };

            const isQconNradKey = (key: string): boolean => {
                const lower = String(key).toLowerCase();
                if (lower === 'qconNrad') return true;
                // Match front/back/surf variants
                if (/^(?:front|back|surf\d+)?[Qq]con[Nn]rad$/.test(key)) return isQconSurfTypeValue(getSurfTypeForConicKey(key));
                return false;
            };

            const QCON_POLYNOMIAL_TOOLTIP = [
                'Qcon sag: z = z_conic + u^4 * Σ(a_m * Q_m^con(u^2))',
                'u = r / NRAD',
                'Q(0,x) = 1',
                'Q(1,x) = 6x - 5',
                'Q(n+1,x) = ((A_n x + B_n)Q(n,x)) - C_n Q(n-1,x)'
            ].join('\n');

            const getCoefDisplayLabel = (key: string) => {
                const match = String(key).match(/coef(\d+)/i);
                if (!match) return null;
                const idx = parseInt(match[1], 10);
                if (!Number.isFinite(idx) || idx <= 0) return null;

                const surfTypeRaw = getSurfTypeForCoefKey(key);
                const surfType = normalizeSurfTypeLabel(surfTypeRaw);
                const isEven = surfType === 'asphericeven' || surfType === 'asphericaleven' || surfType === 'aspheric-even' || surfType === 'aspherical-even';
                const isOdd = surfType === 'asphericodd' || surfType === 'asphericalodd' || surfType === 'aspheric-odd' || surfType === 'aspherical-odd';
                const aIndex = isEven ? (2 * idx + 2) : (2 * idx + 1);
                const lower = String(key).toLowerCase();
                let prefix = '';
                if (lower.startsWith('frontcoef')) prefix = 's1 ';
                else if (lower.startsWith('backcoef')) prefix = 's2 ';
                else if (lower.startsWith('surf1coef')) prefix = 's1 ';
                else if (lower.startsWith('surf2coef')) prefix = 's2 ';
                else if (lower.startsWith('surf3coef')) prefix = 's3 ';
                else if (lower.startsWith('surf4coef')) prefix = 's4 ';
                const isQcon = surfType === 'qcon';
                if (isQcon) {
                    // For Qcon: coef1=C3, coef2=C4, etc.
                    // C1 is conic, C2 is NRAD (shown separately)
                    return `${prefix}C${idx + 2}`.trim();
                }
                if (!isEven && !isOdd) return null;
                return `${prefix}A${aIndex}`.trim();
            };

            const getDisplayLabelForKey = (rawLabel: string): string => {
                const label = String(rawLabel ?? '').trim();
                const assemblyPresentation = getAssemblyParameterPresentation(blockType, label);
                if (assemblyPresentation) return assemblyPresentation.label;
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
                if (label === 'conic' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 'C1 (K)';
                if (label === 'qconNrad') return isQconSurfTypeValue(getSurfTypeForConicKey(label)) ? 'C2 (Nrad)' : '';
                if (label === 'frontConic' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's1 C1 (K)';
                if (label === 'frontQconNrad' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's1 C2 (Nrad)';
                if (label === 'frontQconNrad') return '';
                if (label === 'backConic' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's2 C1 (K)';
                if (label === 'backQconNrad' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's2 C2 (Nrad)';
                if (label === 'backQconNrad') return '';
                if (label === 'surf1Conic' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's1 C1 (K)';
                if (label === 'surf1QconNrad' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's1 C2 (Nrad)';
                if (label === 'surf1QconNrad') return '';
                if (label === 'surf2Conic' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's2 C1 (K)';
                if (label === 'surf2QconNrad' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's2 C2 (Nrad)';
                if (label === 'surf2QconNrad') return '';
                if (label === 'surf3Conic' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's3 C1 (K)';
                if (label === 'surf3QconNrad' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's3 C2 (Nrad)';
                if (label === 'surf3QconNrad') return '';
                if (label === 'surf4Conic' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's4 C1 (K)';
                if (label === 'surf4QconNrad' && isQconSurfTypeValue(getSurfTypeForConicKey(label))) return 's4 C2 (Nrad)';
                if (label === 'surf4QconNrad') return '';
                if (label === 'frontConic') return 's1 Conic';
                if (label === 'backConic') return 's2 Conic';
                if (label === 'surf1Conic') return 's1 Conic';
                if (label === 'surf2Conic') return 's2 Conic';
                if (label === 'surf3Conic') return 's3 Conic';
                if (label === 'surf4Conic') return 's4 Conic';
                return label;
            };

            const getGroupedSurfaceParamInfo = (rawKey: string): { groupKey: string; surfaceIndex: number } | null => {
                const key = String(rawKey ?? '').trim();
                if (!key) return null;

                const frontBackMatch = key.match(/^(front|back)([A-Z].+)$/);
                if (frontBackMatch) {
                    const surfaceIndex = frontBackMatch[1] === 'front' ? 1 : 2;
                    return {
                        surfaceIndex,
                        groupKey: frontBackMatch[2],
                    };
                }

                const surfMatch = key.match(/^surf(\d+)([A-Z].+)$/);
                if (surfMatch) {
                    const surfaceIndex = Number(surfMatch[1]);
                    if (!Number.isFinite(surfaceIndex) || surfaceIndex <= 0) return null;
                    return {
                        surfaceIndex,
                        groupKey: surfMatch[2],
                    };
                }

                return null;
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

            const normalizeScopeForToggle = (scopeValue: any): string => {
                const s = String(scopeValue ?? '').trim().toLowerCase();
                if (s === 'global' || s === 'shared') return 'global';
                if (s === 'perconfig' || s === 'per-config' || s === 'local') return 'perConfig';
                return '';
            };

            const createOptimizeScopeIconControl = (
                initialEnabled: boolean,
                initialScope: any,
                onStateChange: (state: 'off' | 'perConfig' | 'global') => void,
            ) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'block-inspector-quick-scope-btn';
                btn.style.flex = '0 0 18px';
                btn.style.cursor = 'pointer';
                btn.addEventListener('click', (event) => {
                    try { event.stopPropagation(); } catch (_) {}
                });

                let currentScope = normalizeScopeForToggle(initialScope);
                let currentEnabled = !!initialEnabled;

                const getState = (): 'off' | 'perConfig' | 'global' => {
                    if (!currentEnabled) return 'off';
                    return currentScope === 'global' ? 'global' : 'perConfig';
                };

                const render = () => {
                    btn.textContent = !currentEnabled
                        ? ''
                        : (currentScope === 'perConfig' ? 'V' : (currentScope === 'global' ? 'W' : ''));
                    btn.title = currentEnabled
                        ? (currentScope === 'global' ? 'Share' : 'Per-config')
                        : 'Disabled';
                    btn.style.opacity = currentEnabled ? '1' : '0.45';
                };

                btn.onclick = (event) => {
                    try { event.preventDefault(); } catch (_) {}
                    try { event.stopPropagation(); } catch (_) {}

                    const state = getState();
                    if (state === 'off') {
                        currentEnabled = true;
                        currentScope = 'perConfig';
                    } else if (state === 'perConfig') {
                        currentEnabled = true;
                        currentScope = 'global';
                    } else {
                        currentEnabled = false;
                        currentScope = 'perConfig';
                    }

                    render();
                    onStateChange(getState());
                };

                render();

                return {
                    button: btn,
                    getState,
                    setState: (nextState: 'off' | 'perConfig' | 'global') => {
                        if (nextState === 'off') {
                            currentEnabled = false;
                            currentScope = 'perConfig';
                        } else {
                            currentEnabled = true;
                            currentScope = nextState === 'global' ? 'global' : 'perConfig';
                        }
                        render();
                    },
                };
            };

            const createRow = (label: string, value: any, path: string, badge?: string, paramType?: string) => {
                const isGroupedSurfaceLayout = paramType === '__groupedSurface';
                const row = document.createElement('div');
                row.className = 'block-inspector-detail-row';
                row.style.display = 'grid';
                row.style.gridTemplateColumns = isGroupedSurfaceLayout
                    ? '56px minmax(136px,1fr)'
                    : '148px minmax(220px,1fr) 56px';
                row.style.gap = isGroupedSurfaceLayout ? '6px' : '8px';
                row.style.alignItems = 'center';
                row.style.minHeight = isGroupedSurfaceLayout ? '28px' : '32px';
                row.style.marginBottom = '0';
                row.style.padding = isGroupedSurfaceLayout ? '0' : '4px 0';
                row.style.borderBottom = isGroupedSurfaceLayout
                    ? 'none'
                    : (isDarkMode ? '1px solid #1f2937' : '1px solid #eef2f7');

                const name = document.createElement('div');
                const coefLabel = getCoefDisplayLabel(label);
                const displayLabel = getDisplayLabelForKey(label);
                const assemblyPresentation = getAssemblyParameterPresentation(blockType, label);
                name.textContent = `${coefLabel || displayLabel}${assemblyPresentation ? ' ⓘ' : ''}`;
                name.title = assemblyPresentation
                    ? `${assemblyPresentation.label}\n${assemblyPresentation.help}`
                    : isQconCoefKey(label)
                    ? `${coefLabel || displayLabel}\n\n${QCON_POLYNOMIAL_TOOLTIP}`
                    : (coefLabel || displayLabel);
                name.style.fontSize = '12px';
                name.style.color = isDarkMode ? '#d1d5db' : '#374151';
                name.style.minWidth = '0';
                name.style.whiteSpace = 'nowrap';
                name.style.overflow = 'hidden';
                name.style.textOverflow = 'ellipsis';
                name.style.lineHeight = '1.2';
                if (isGroupedSurfaceLayout) {
                    name.style.fontSize = '11px';
                }

                const relaxFieldSizing = (element: HTMLElement | null | undefined) => {
                    if (!element || !isGroupedSurfaceLayout) return;
                    element.style.minWidth = '0';
                    element.style.maxWidth = '100%';
                    element.style.width = '100%';
                    element.style.boxSizing = 'border-box';
                };

                const applyCompactEditorSizing = (element: HTMLInputElement | HTMLSelectElement | null | undefined) => {
                    if (!element) return;
                    element.style.width = '100%';
                    element.style.minWidth = '0';
                    element.style.height = '20px';
                    element.style.boxSizing = 'border-box';
                    element.style.fontSize = '11px';
                    element.style.padding = '2px 6px';
                    element.style.borderRadius = '4px';
                };

                // Check parameter type - surfType uses exact match (case-sensitive key)
                const isSurfType = label === 'surfType' || label === 'frontSurfType' || label === 'backSurfType' || 
                                   label === 'surf1SurfType' || label === 'surf2SurfType' || label === 'surf3SurfType' || label === 'surf4SurfType';
                const isMaterial = label.toLowerCase().includes('material') || paramType === 'material';
                const isGapThicknessMode = (blockType === 'Gap' || blockType === 'AirGap') && label === 'thicknessMode';
                const isObjectDistanceMode = (blockType === 'ObjectSurface' || blockType === 'ObjectPlane') && label === 'objectDistanceMode';
                const isImageSemidiaMode = blockType === 'ImageSurface' && label === 'semidiaMode';
                const isApertureShape = (blockType === 'Mirror' || blockType === 'SingleSurface' || blockType === 'ImageSurface') && label === 'apertureShape';
                const isCoordReturn = blockType === 'CoordTrans' && label === 'coordReturn';
                const isCoordOrder = blockType === 'CoordTrans' && label === 'order';
                const isCoordToSurf = blockType === 'CoordTrans' && label === 'toSurf';
                const isZoomGroup = label === 'zoomGroup';
                const assemblyChoices = assemblyPresentation?.choices ?? [];
                // Exclude refractive-index / dispersion fields from slider display.
                const isGlassProperty = /^(?:rindex|nd|vd|abbe)\d*$/i.test(label);
                const isNumeric = !isMaterial && !isSurfType && !isGlassProperty && !isGapThicknessMode && !isObjectDistanceMode && !isImageSemidiaMode && !isApertureShape && !isCoordReturn && !isCoordOrder && !isCoordToSurf && !isZoomGroup && !isNaN(parseFloat(String(value)));
                
                // Determine if this parameter should show coef parameters based on surfType
                const shouldHideCoef = (key: string, surfTypeValue: string) => {
                    if (!key.includes('Coef') && !key.includes('coef')) return false;
                    return surfTypeValue === 'Spherical';
                };

                let inputElement: HTMLElement;

                if (assemblyChoices.length > 0) {
                    const select = document.createElement('select');
                    select.style.border = isDarkMode ? '1px solid #444' : '1px solid #ddd';
                    select.style.background = isDarkMode ? '#111827' : '#fff';
                    select.style.color = isDarkMode ? '#f9fafb' : '#111827';
                    select.style.cursor = 'pointer';

                    const valueKey = (candidate: string | number | boolean): string => `${typeof candidate}:${String(candidate)}`;
                    const currentKey = valueKey(value as string | number | boolean);
                    const hasCurrentValue = assemblyChoices.some((choice) => valueKey(choice.value) === currentKey);
                    const resolvedChoices: AssemblyParameterChoice[] = hasCurrentValue
                        ? assemblyChoices
                        : [
                            { value: value as string | number | boolean, label: `${String(value)} (current)` },
                            ...assemblyChoices,
                        ];

                    resolvedChoices.forEach((choice, choiceIndex) => {
                        const option = document.createElement('option');
                        option.value = String(choiceIndex);
                        option.textContent = choice.label;
                        if (valueKey(choice.value) === currentKey) option.selected = true;
                        select.appendChild(option);
                    });

                    select.addEventListener('change', () => {
                        const nextValue = resolvedChoices[Number(select.value)]?.value;
                        if (nextValue !== undefined && valueKey(nextValue) !== currentKey) {
                            cooptApplyBlockValue(blockId, path, value, nextValue);
                        }
                    });

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);
                    inputElement = select;
                } else if (isSurfType) {
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
                            { value: 'Aspheric even', label: 'Aspheric even' },
                            { value: 'Aspheric odd', label: 'Aspheric odd' },
                            { value: 'Qcon', label: 'Qcon' },
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

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);

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
                                return 0.5875618;
                            })();

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

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);

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

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);

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

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);

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

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);

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

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);

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

                                        changedPath: `variables.${String(key ?? '').trim()}.optimize.${enabled ? 'mode' : 'mode'}`,
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

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);

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

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);

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

                    applyCompactEditorSizing(select);
                    relaxFieldSizing(select);

                    inputElement = select;
                } else if (isNumeric) {
                    // Spreadsheet-style numeric editor (slider controls removed)
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

                    const commit = () => {
                        const newValue = cooptNormalizeInputValue(input.value, value, path);
                        if (newValue !== value) {
                            cooptApplyBlockValue(blockId, path, value, newValue);
                        }
                    };

                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            commit();
                        }
                    });

                    input.addEventListener('blur', commit);
                    applyCompactEditorSizing(input);
                    relaxFieldSizing(input);
                    inputElement = input;
                } else if (isMaterial) {
                    // Create material input with glass search
                    const container = document.createElement('div');
                    container.style.display = 'flex';
                    container.style.alignItems = 'center';
                    container.style.gap = '8px';
                    container.style.flex = '1';
                    container.style.flexWrap = 'nowrap';
                    container.style.minHeight = '28px';
                    if (isGroupedSurfaceLayout) {
                        container.style.gap = '4px';
                        container.style.minWidth = '0';
                        container.style.width = '100%';
                    }

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
                    applyCompactEditorSizing(input);
                    relaxFieldSizing(input);

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
                                        const newValue = cooptNormalizeInputValue(glass.name, value, path);
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

                            const materialKey = String(path || '').split('.').pop() || String(label || '').trim();
                            const abbeKey = resolveAbbeKeyForMaterial(materialKey);
                            const vdKey = resolveVdKeyForMaterial(materialKey);

                            const abbeVal = parseFloat(String(p[abbeKey]));
                            if (Number.isFinite(abbeVal) && abbeVal > 0) return abbeVal;

                            const vdVal = parseFloat(String(p[vdKey]));
                            if (Number.isFinite(vdVal) && vdVal > 0) return vdVal;

                            return null;
                        };

                        const resolveRindexKeyForMaterial = (materialKey: string): string => {
                            const key = String(materialKey || '').trim().toLowerCase();
                            const m = key.match(/^material(\d+)$/);
                            if (m && m[1]) return `rindex${m[1]}`;
                            return 'rindex';
                        };

                        const resolveTargetNdFromParameters = (): number | null => {
                            const p: any = params && typeof params === 'object' ? params : null;
                            if (!p) return null;

                            const materialKey = String(path || '').split('.').pop() || String(label || '').trim();
                            const rindexKey = resolveRindexKeyForMaterial(materialKey);
                            const rindexVal = parseFloat(String(p[rindexKey]));
                            if (Number.isFinite(rindexVal) && rindexVal > 1 && rindexVal < 4) return rindexVal;

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

                        // Prioritize explicit RI/Abbe inputs from sibling fields.
                        let targetNd: number | null = resolveTargetNdFromParameters();
                        let targetVd: number | null = resolveTargetVdFromParameters();

                        // If RI field is empty, allow numeric material input as RI fallback.
                        const numericValue = parseStrictNumericMaterialNd(currentMaterial);
                        if (!Number.isFinite(targetNd) && numericValue !== null) {
                            targetNd = numericValue;
                        }

                        // Only fill missing pieces from current material name if needed.
                        if (currentMaterial && (!Number.isFinite(targetNd) || !Number.isFinite(targetVd))) {
                            try {
                                const glassData = getGlassDataWithSellmeier(currentMaterial);
                                if (glassData && Number.isFinite(Number(glassData.nd)) && !Number.isFinite(targetNd)) {
                                    targetNd = Number(glassData.nd);
                                }
                                if (glassData && Number.isFinite(Number(glassData.vd)) && !Number.isFinite(targetVd)) {
                                    targetVd = Number(glassData.vd);
                                }
                            } catch (err) {
                                console.warn('⚠️ Failed to resolve fallback nd/vd from current material:', err);
                            }
                        }

                        if (!Number.isFinite(targetNd) || !Number.isFinite(targetVd)) {
                            alert('RI (nd) and Abbe (Vd) values are required to search similar glasses.');
                            return;
                        }

                        console.log('🔍 Searching for glasses similar to nd:', targetNd, 'vd:', targetVd);
                        try {
                            similarGlasses = findSimilarGlassesByNdVd(targetNd as number, targetVd as number, 20);
                            console.log('✅ Found', similarGlasses.length, 'similar glasses');
                        } catch (err) {
                            console.error('❌ Failed to find similar glasses:', err);
                        }

                        const preferredManufacturers = getPreferredGlassManufacturers();
                        similarGlasses = similarGlasses.filter((glass: any) => isGlassAllowedByPreferredManufacturers(glass?.name, preferredManufacturers));
                        
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
                                const newValue = cooptNormalizeInputValue(glass.name, value, path);
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
                        const newValue = cooptNormalizeInputValue(input.value, value, path);
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
                    relaxFieldSizing(container);
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
                        const newValue = cooptNormalizeInputValue(input.value, value, path);
                        if (newValue !== value) {
                            cooptApplyBlockValue(blockId, path, value, newValue);
                        }
                    });

                    applyCompactEditorSizing(input);
                    relaxFieldSizing(input);

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
                chip.style.justifySelf = 'center';

                if (isGroupedSurfaceLayout) {
                    chip.style.display = 'none';
                }

                row.appendChild(name);
                row.appendChild(inputElement);
                if (!isGroupedSurfaceLayout) {
                    row.appendChild(chip);
                }
                return row;
            };

            if (paramKeys.length > 0) {

                const shouldSkipExpandedParamKey = (key: string): boolean => {
                    if (shouldHideExpandedField(key)) return true;
                    if (quickEditorEnabled && quickEditorCoveredParamKeys.has(String(key).toLowerCase())) return true;
                    if (isPhysicalBlockType(blockType)) {
                        const lower = String(key).toLowerCase();
                        const sourceUsesNa = Number(params.numericalAperture) > 0;
                        if ((blockType === 'BroadbandSource' || blockType === 'FrequencyCombSource') && sourceUsesNa && lower === 'divergencedeg') return true;
                        if (blockType === 'BeamSplitter') {
                            const model = String(params.beamSplitterModel ?? 'ideal').toLowerCase();
                            if (model === 'ideal' && [
                                'substratematerial', 'substrateindexnd', 'substrateabbenumber',
                                'substratethicknessmm', 'wedgedeg', 'backsurfacereflectance',
                            ].includes(lower)) return true;
                            if (model !== 'plate' && lower === 'wedgedeg') return true;
                        }
                        if (blockType === 'ReflectionGrating' && lower === 'allowedorders') {
                            const configured = Array.isArray(params.allowedOrders) ? params.allowedOrders.map(Number).filter(Number.isFinite) : [];
                            if (configured.length <= 1 && (!configured.length || configured[0] === Number(params.order))) return true;
                        }
                        if (blockType === 'Target') {
                            const profile = String(params.profile ?? 'flat').toLowerCase();
                            const interaction = String(params.interaction ?? 'specular').toLowerCase();
                            if (lower === 'periodmm' && profile !== 'sine') return true;
                            if (lower === 'steppositionmm' && profile !== 'step') return true;
                            if (lower === 'amplitudeum' && !['step', 'tilt', 'sine'].includes(profile)) return true;
                            if (['scattersamples', 'scattera', 'scatterb', 'scatterg', 'scattersigmadeg', 'bsdfsamples'].includes(lower)) {
                                if (interaction === 'specular') return true;
                                if (lower === 'bsdfsamples' && interaction !== 'bsdf-csv') return true;
                                if (['scattera', 'scatterb', 'scatterg'].includes(lower) && interaction !== 'abg') return true;
                                if (lower === 'scattersigmadeg' && interaction !== 'harvey-shack') return true;
                            }
                        }
                        if (blockType === 'AreaDetector' && lower === 'responsivity' && Number.isFinite(Number(params.quantumEfficiency))) return true;
                    }
                    if (blockType === 'ImageSurface' && key === 'optimizeSemiDia') return true;
                    if (blockType === 'ImageSurface' && key === 'thickness') return true;
                    if (/^coef\d+$/.test(key) && params.surfType === 'Spherical') return true;
                    if (/^frontCoef\d+$/.test(key) && params.frontSurfType === 'Spherical') return true;
                    if (/^backCoef\d+$/.test(key) && params.backSurfType === 'Spherical') return true;
                    if (/^surf1Coef\d+$/.test(key) && params.surf1SurfType === 'Spherical') return true;
                    if (/^surf2Coef\d+$/.test(key) && params.surf2SurfType === 'Spherical') return true;
                    if (/^surf3Coef\d+$/.test(key) && params.surf3SurfType === 'Spherical') return true;
                    if (/^surf4Coef\d+$/.test(key) && params.surf4SurfType === 'Spherical') return true;
                    if (isQconNradKey(key) && !isQconSurfTypeValue(getSurfTypeForConicKey(key))) return true;
                    return false;
                };

                const groupedSurfaceParamRows: Array<{
                    groupKey: string;
                    keysBySurface: Map<number, string>;
                }> = [];
                const groupedSurfaceParamRowMap = new Map<string, { groupKey: string; keysBySurface: Map<number, string> }>();
                let groupedSurfaceParamColumnCount = 0;

                for (const key of paramKeys) {
                    if (shouldSkipExpandedParamKey(key)) continue;
                    const info = getGroupedSurfaceParamInfo(key);
                    if (!info) continue;
                    let row = groupedSurfaceParamRowMap.get(info.groupKey);
                    if (!row) {
                        row = { groupKey: info.groupKey, keysBySurface: new Map<number, string>() };
                        groupedSurfaceParamRowMap.set(info.groupKey, row);
                        groupedSurfaceParamRows.push(row);
                    }
                    row.keysBySurface.set(info.surfaceIndex, key);
                    groupedSurfaceParamColumnCount = Math.max(groupedSurfaceParamColumnCount, info.surfaceIndex);
                }

                const groupedSurfaceParamKeys = new Set<string>();
                for (const row of groupedSurfaceParamRows) {
                    for (const key of row.keysBySurface.values()) groupedSurfaceParamKeys.add(key);
                }

                const renderedGroupedSurfaceParamRows = new Set<string>();

                const resolveExpandedParamValue = (key: string) => {
                    let value = (params as any)[key];
                    if ((blockType === 'BroadbandSource' || blockType === 'FrequencyCombSource') && key === 'renderSpatialSamples' && (value === undefined || value === null || String(value).trim() === '')) {
                        value = Math.min(9, Number((params as any).spatialSamples) || 9);
                    }
                    if ((blockType === 'BroadbandSource' || blockType === 'FrequencyCombSource') && key === 'detectorSpatialSamples' && (value === undefined || value === null || String(value).trim() === '')) {
                        value = Number((params as any).spatialSamples) || 81;
                    }
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
                    if ((blockType === 'Lens' || blockType === 'PositiveLens') && key === 'bending') {
                        value = cooptComputeLensBendingValue(expandedBlock, blockType);
                    }
                    if (blockType === 'ImageSurface' && key === 'semidiaMode' && (value === undefined || value === null || String(value).trim() === '')) {
                        const opt = String((params as any)?.optimizeSemiDia ?? '').trim().toUpperCase();
                        value = (opt === 'A' || opt === 'AUTO') ? 'Auto' : 'Manual';
                    }
                    if ((blockType === 'Gap' || blockType === 'AirGap') && key === 'material' && (value === undefined || value === null || value === '')) {
                        value = 'AIR';
                    }
                    return value;
                };

                const renderExpandedParamRow = (key: string, mode: 'default' | 'compact' = 'default') => {
                    const value = resolveExpandedParamValue(key);
                    const canOptimize = blockType !== 'Stop';
                    const varEntry = __cooptGetEffectiveBlockVariableEntry(activeConfigIdForInspector, blockId, vars, key);
                    const isAbbeRow = key === 'abbe' || key === 'vd' || /^abbe\d+$/.test(key) || /^vd\d+$/.test(key);
                    const isGroupedSurfTypeRow =
                        (blockType === 'Doublet' || blockType === 'Triplet') &&
                        /^surf\d+SurfType$/.test(key);
                    const isCompact = mode === 'compact';

                    const paramRow = document.createElement('div');
                    paramRow.style.display = 'grid';
                    paramRow.style.gridTemplateColumns = canOptimize
                        ? (isCompact ? '18px minmax(0,1fr)' : '32px minmax(0,1fr)')
                        : 'minmax(0,1fr)';
                    paramRow.style.alignItems = 'center';
                    paramRow.style.gap = '6px';
                    paramRow.style.minHeight = isCompact ? '28px' : '34px';
                    paramRow.style.marginBottom = isCompact ? '0' : ((isAbbeRow || isGroupedSurfTypeRow) ? '4px' : '0');
                    if (isCompact) {
                        paramRow.style.width = '244px';
                        paramRow.style.maxWidth = '100%';
                    }

                    const optimizeControl = canOptimize
                        ? createOptimizeScopeIconControl(
                            __blocks_shouldMarkVar(varEntry),
                            __blocks_getVarScope(varEntry),
                            (nextState) => {
                                if (nextState === 'off') {
                                    __blocks_setVarMode(blockId, key, false, 'perConfig');
                                    return;
                                }
                                const scope = nextState === 'global' ? 'global' : 'perConfig';
                                __blocks_setVarScope(blockId, key, scope);
                                __blocks_setVarMode(blockId, key, true, scope);
                            }
                        )
                        : null;

                    const innerRow = createRow(key, value, `parameters.${key}`, undefined, isCompact ? '__groupedSurface' : undefined);
                    innerRow.style.flex = '1';
                    innerRow.style.marginBottom = '0';
                    if (isCompact) {
                        innerRow.style.minWidth = '0';
                    }

                    if (optimizeControl) paramRow.appendChild(optimizeControl.button);
                    paramRow.appendChild(innerRow);
                    panel.appendChild(paramRow);
                };

                const renderGroupedSurfaceParamRow = (groupKey: string) => {
                    const row = groupedSurfaceParamRowMap.get(groupKey);
                    if (!row || renderedGroupedSurfaceParamRows.has(groupKey)) return;
                    renderedGroupedSurfaceParamRows.add(groupKey);

                    const pairRowScroll = document.createElement('div');
                    pairRowScroll.style.overflowX = 'auto';
                    pairRowScroll.style.overflowY = 'hidden';
                    pairRowScroll.style.paddingBottom = '2px';

                    const pairRow = document.createElement('div');
                    pairRow.style.display = 'grid';
                    pairRow.style.gridTemplateColumns = `repeat(${Math.max(1, groupedSurfaceParamColumnCount)}, 244px)`;
                    pairRow.style.gap = '8px';
                    pairRow.style.alignItems = 'start';
                    pairRow.style.marginBottom = '0';
                    pairRow.style.width = 'max-content';
                    pairRow.style.minWidth = '100%';

                    for (let surfaceIndex = 1; surfaceIndex <= Math.max(1, groupedSurfaceParamColumnCount); surfaceIndex += 1) {
                        const key = row.keysBySurface.get(surfaceIndex);
                        if (!key) {
                            pairRow.appendChild(document.createElement('div'));
                            continue;
                        }

                        let value = (params as any)[key];
                        if (blockType === 'Paraxial' && key === 'surfType' && (value === undefined || value === null || String(value).trim() === '')) {
                            value = 'Toric';
                        }

                        const varEntry = __cooptGetEffectiveBlockVariableEntry(activeConfigIdForInspector, blockId, vars, key);
                        const cell = document.createElement('div');
                        cell.style.display = 'grid';
                        cell.style.gridTemplateColumns = '18px minmax(0,1fr)';
                        cell.style.alignItems = 'center';
                        cell.style.gap = '6px';
                        cell.style.minHeight = '28px';
                        cell.style.minWidth = '0';

                        const optimizeControl = createOptimizeScopeIconControl(
                            __blocks_shouldMarkVar(varEntry),
                            __blocks_getVarScope(varEntry),
                            (nextState) => {
                                if (nextState === 'off') {
                                    __blocks_setVarMode(blockId, key, false, 'perConfig');
                                    return;
                                }
                                const scope = nextState === 'global' ? 'global' : 'perConfig';
                                __blocks_setVarScope(blockId, key, scope);
                                __blocks_setVarMode(blockId, key, true, scope);
                            }
                        );

                        const innerRow = createRow(key, value, `parameters.${key}`, undefined, '__groupedSurface');
                        innerRow.style.flex = '1';
                        innerRow.style.marginBottom = '0';
                        innerRow.style.minWidth = '0';

                        cell.appendChild(optimizeControl.button);
                        cell.appendChild(innerRow);
                        pairRow.appendChild(cell);
                    }

                    pairRowScroll.appendChild(pairRow);
                    panel.appendChild(pairRowScroll);
                };

                if (paramKeys.includes('bending') && !shouldSkipExpandedParamKey('bending')) {
                    renderExpandedParamRow('bending', 'compact');
                }

                if ((blockType === 'Gap' || blockType === 'AirGap') && paramKeys.includes('thicknessMode') && !shouldSkipExpandedParamKey('thicknessMode')) {
                    renderExpandedParamRow('thicknessMode', 'compact');
                }

                for (const key of paramKeys) {
                    if (shouldSkipExpandedParamKey(key)) continue;
                    if (key === 'bending') continue;
                    if ((blockType === 'Gap' || blockType === 'AirGap') && key === 'thicknessMode') continue;
                    if (groupedSurfaceParamKeys.has(key)) {
                        const info = getGroupedSurfaceParamInfo(key);
                        if (info) renderGroupedSurfaceParamRow(info.groupKey);
                        continue;
                    }
                    renderExpandedParamRow(key);
                    
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

            if (apertureEntries.length > 0 && !shouldHideExpandedField('semidia')) {
                panel.appendChild(createSectionTitle('Aperture (Semidiameter)'));

                const renderApertureEntry = (rawKey: string, displayKey: string, value: any): HTMLElement | null => {
                    if (quickEditorEnabled) {
                        const rawLower = String(rawKey).toLowerCase();
                        const displayLower = String(displayKey).toLowerCase();
                        if (quickEditorCoveredApertureKeys.has(rawLower) || quickEditorCoveredApertureKeys.has(displayLower)) {
                            return null;
                        }
                    }

                    const apertureEntry = __cooptGetEffectiveBlockVariableEntry(activeConfigIdForInspector, blockId, vars, rawKey);

                    const apertureCell = document.createElement('div');
                    apertureCell.style.display = 'grid';
                    apertureCell.style.gridTemplateColumns = '24px minmax(0,1fr)';
                    apertureCell.style.alignItems = 'center';
                    apertureCell.style.gap = '6px';
                    apertureCell.style.minHeight = '34px';
                    apertureCell.style.marginBottom = '0';

                    const optimizeControl = createOptimizeScopeIconControl(
                        __blocks_shouldMarkVar(apertureEntry),
                        __blocks_getVarScope(apertureEntry),
                        (nextState) => {
                            if (nextState === 'off') {
                                __blocks_setVarMode(blockId, rawKey, false, 'perConfig');
                                return;
                            }
                            const scope = nextState === 'global' ? 'global' : 'perConfig';
                            __blocks_setVarScope(blockId, rawKey, scope);
                            __blocks_setVarMode(blockId, rawKey, true, scope);
                        }
                    );

                    const innerRow = createRow(displayKey, value, `aperture.${rawKey}`);
                    innerRow.style.flex = '1';
                    innerRow.style.marginBottom = '0';

                    apertureCell.appendChild(optimizeControl.button);
                    apertureCell.appendChild(innerRow);
                    return apertureCell;
                };

                for (let i = 0; i < apertureEntries.length; i += 2) {
                    const pairRow = document.createElement('div');
                    pairRow.style.display = 'grid';
                    pairRow.style.gridTemplateColumns = 'minmax(0,1fr) minmax(0,1fr)';
                    pairRow.style.gap = '8px';
                    pairRow.style.alignItems = 'start';

                    const first = apertureEntries[i];
                    const second = apertureEntries[i + 1];
                    const firstCell = first ? renderApertureEntry(first.rawKey, first.displayKey, first.value) : null;
                    const secondCell = second ? renderApertureEntry(second.rawKey, second.displayKey, second.value) : null;

                    if (firstCell) pairRow.appendChild(firstCell);
                    else pairRow.appendChild(document.createElement('div'));

                    if (secondCell) pairRow.appendChild(secondCell);
                    else pairRow.appendChild(document.createElement('div'));

                    if (firstCell || secondCell) {
                        panel.appendChild(pairRow);
                    }
                }
            }

            if (varKeys.length > 0) {
                for (const key of varKeys) {
                    if (shouldHideExpandedField(key)) {
                        continue;
                    }
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
                    if (quickEditorEnabled) {
                        const keyLower = String(key).toLowerCase();
                        if (quickEditorCoveredParamKeys.has(keyLower) || quickEditorCoveredApertureKeys.has(keyLower) || quickEditorCoveredApertureKeys.has(normalizedVarKey)) {
                            continue;
                        }
                    }
                    
                    const entry = __cooptGetEffectiveBlockVariableEntry(activeConfigIdForInspector, blockId, vars, key);
                    const value = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry;

                    // Create a row with optimize/scope icon control
                    const varRow = document.createElement('div');
                    varRow.style.display = 'grid';
                    varRow.style.gridTemplateColumns = '32px minmax(0,1fr)';
                    varRow.style.alignItems = 'center';
                    varRow.style.gap = '6px';
                    varRow.style.marginBottom = '0';

                    const optimizeControl = createOptimizeScopeIconControl(
                        __blocks_shouldMarkVar(entry),
                        __blocks_getVarScope(entry),
                        (nextState) => {
                            if (nextState === 'off') {
                                __blocks_setVarMode(blockId, key, false, 'perConfig');
                                updateOptimizeChip();
                                return;
                            }
                            const scope = nextState === 'global' ? 'global' : 'perConfig';
                            __blocks_setVarScope(blockId, key, scope);
                            __blocks_setVarMode(blockId, key, true, scope);
                            updateOptimizeChip();
                        }
                    );

                    // Build the standard createRow content but embed in this container
                    const badge = entry && typeof entry === 'object' && entry.optimize && entry.optimize.mode ? `V:${entry.optimize.mode}` : 'V';
                    const innerRow = createRow(key, value, `variables.${key}.value`, badge);
                    innerRow.style.flex = '1';
                    innerRow.style.marginBottom = '0';
                    const chip = innerRow.lastElementChild as HTMLDivElement | null;
                    const updateOptimizeChip = () => {
                        if (!chip) return;
                        chip.textContent = optimizeControl.getState() === 'off' ? 'V:F' : 'V:V';
                        chip.style.border = isDarkMode ? '1px solid #374151' : '1px solid #e5e7eb';
                        chip.style.visibility = 'visible';
                    };

                    updateOptimizeChip();
                    varRow.appendChild(optimizeControl.button);
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

            blockRenderTargetForId(blockId).appendChild(panel);
        }
    }
}

let __cooptBlockInspectorRefreshTimer: number | null = null;
let __cooptBlockInspectorLastRunAtMs = 0;
let __cooptBlockInspectorExpandedRowsOverride: any[] | null = null;
let __cooptBlockInspectorSkipOpticalTableSync = false;
const __cooptBlockVariableCacheByConfigId = new Map<string, Map<string, any>>();

function __cooptIsPlainRecord(value: any): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function __cooptMergeVariableSnapshot(snapshotVars: any, currentVars: any, currentParams?: any): Record<string, any> {
    const snapshot = __cooptIsPlainRecord(snapshotVars) ? snapshotVars : {};
    const current = __cooptIsPlainRecord(currentVars) ? currentVars : {};
    const params = __cooptIsPlainRecord(currentParams) ? currentParams : {};
    const merged: Record<string, any> = { ...snapshot, ...current };

    for (const [key, snapshotEntry] of Object.entries(snapshot)) {
        const currentEntry = current[key];
        if (!__cooptIsPlainRecord(snapshotEntry) || !__cooptIsPlainRecord(currentEntry)) continue;
        const mergedEntry: Record<string, any> = { ...snapshotEntry, ...currentEntry };
        if (__cooptIsPlainRecord(snapshotEntry.optimize) || __cooptIsPlainRecord(currentEntry.optimize)) {
            mergedEntry.optimize = {
                ...(__cooptIsPlainRecord(snapshotEntry.optimize) ? snapshotEntry.optimize : {}),
                ...(__cooptIsPlainRecord(currentEntry.optimize) ? currentEntry.optimize : {}),
            };
        }
        if (Object.prototype.hasOwnProperty.call(params, key)) {
            mergedEntry.value = params[key];
        }
        merged[key] = mergedEntry;
    }

    return merged;
}

function __cooptRememberBlockVariablesForConfig(configId: string, blocks: any[]): void {
    if (!Array.isArray(blocks) || !configId) return;
    let cache = __cooptBlockVariableCacheByConfigId.get(configId);
    if (!cache) {
        cache = new Map<string, any>();
        __cooptBlockVariableCacheByConfigId.set(configId, cache);
    }
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const blockId = String(block?.blockId ?? '').trim();
        if (!blockId || !__cooptIsPlainRecord(block.variables)) continue;
        const previousSnapshot = cache.get(blockId);
        const merged = __cooptMergeVariableSnapshot(previousSnapshot, block.variables, block.parameters);
        cache.set(blockId, cooptCloneJsonValue(merged) || merged);
    }
}

function __cooptGetCachedBlockVariableEntry(configId: string, blockId: string, key: string): any {
    const cfgId = String(configId ?? '').trim();
    const bid = String(blockId ?? '').trim();
    const rawKey = String(key ?? '').trim();
    if (!cfgId || !bid || !rawKey) return undefined;
    const cache = __cooptBlockVariableCacheByConfigId.get(cfgId);
    if (!cache) return undefined;
    const snapshot = cache.get(bid);
    if (!__cooptIsPlainRecord(snapshot)) return undefined;
    return __blocks_getVarEntryForKey(snapshot, rawKey);
}

function __cooptGetEffectiveBlockVariableEntry(configId: string, blockId: string, vars: any, key: string): any {
    const live = __blocks_getVarEntryForKey(vars, key);
    const cached = __cooptGetCachedBlockVariableEntry(configId, blockId, key);
    if (__cooptIsPlainRecord(cached) && __cooptIsPlainRecord(live)) {
        const merged: Record<string, any> = { ...cached, ...live };
        if (__cooptIsPlainRecord(cached.optimize) || __cooptIsPlainRecord(live.optimize)) {
            merged.optimize = {
                ...(__cooptIsPlainRecord(cached.optimize) ? cached.optimize : {}),
                ...(__cooptIsPlainRecord(live.optimize) ? live.optimize : {}),
            };
        }
        return merged;
    }
    return live ?? cached;
}

function __cooptRestoreBlockVariablesFromCache(configId: string, blocks: any[]): number {
    if (!Array.isArray(blocks) || !configId) return 0;
    const cache = __cooptBlockVariableCacheByConfigId.get(configId);
    if (!cache || cache.size === 0) return 0;

    let restoredCount = 0;
    for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        const blockId = String(block?.blockId ?? '').trim();
        if (!blockId) continue;
        const snapshot = cache.get(blockId);
        if (!__cooptIsPlainRecord(snapshot)) continue;
        const beforeText = (() => {
            try { return JSON.stringify(block.variables ?? null); } catch (_) { return ''; }
        })();
        const merged = __cooptMergeVariableSnapshot(snapshot, block.variables, block.parameters);
        const afterText = (() => {
            try { return JSON.stringify(merged); } catch (_) { return beforeText; }
        })();
        if (afterText !== beforeText) {
            block.variables = merged;
            restoredCount += 1;
        }
    }

    return restoredCount;
}

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
        const systemConfig = (() => {
            try {
                const liveConfig = cooptLoadCanonicalDesignIntentSystemConfig();
                if (liveConfig && Array.isArray(liveConfig.configurations) && liveConfig.configurations.length > 0) {
                    return liveConfig;
                }
            } catch (_) {}
            try {
                const persistedConfig = (typeof loadPersistedSystemConfigurationsFromTableConfig === 'function')
                    ? loadPersistedSystemConfigurationsFromTableConfig()
                    : null;
                if (persistedConfig && Array.isArray(persistedConfig.configurations) && persistedConfig.configurations.length > 0) {
                    return persistedConfig;
                }
            } catch (_) {}
            try {
                return (typeof loadSystemConfigurations === 'function') ? loadSystemConfigurations() : null;
            } catch (_) {
                return null;
            }
        })();
        const activeCfg = systemConfig?.configurations?.find((cfg: any) => configIdsEqual(cfg?.id, systemConfig?.activeConfigId))
            || systemConfig?.configurations?.[0]
            || ((typeof getActiveConfiguration === 'function') ? getActiveConfiguration() : null);
        let blocks = activeCfg && Array.isArray(activeCfg.blocks) ? activeCfg.blocks : null;
        const activeConfigId = String(activeCfg?.id ?? systemConfig?.activeConfigId ?? '').trim();

        if (activeCfg && Array.isArray(blocks) && blocks.length > 0) {
            try {
                const autoGapResult = cooptAutoApplyGapThicknessModes(blocks, '');
                if (autoGapResult?.changed) {
                    if (activeCfg.metadata && typeof activeCfg.metadata === 'object') {
                        activeCfg.metadata.modified = new Date().toISOString();
                    }
                    if (systemConfig && typeof saveSystemConfigurations === 'function') {
                        saveSystemConfigurations(systemConfig);
                    }
                }
            } catch (_) {}
        }

        if (Array.isArray(blocks) && blocks.length > 0 && activeConfigId) {
            for (const block of blocks) {
                reconcileDesignIntentVariableValues(block);
            }
            const restoredCount = __cooptRestoreBlockVariablesFromCache(activeConfigId, blocks);
            if (restoredCount > 0) {
                try {
                    if (activeCfg && activeCfg.metadata && typeof activeCfg.metadata === 'object') {
                        activeCfg.metadata.modified = new Date().toISOString();
                    }
                } catch (_) {}
                try {
                    if (systemConfig && typeof saveSystemConfigurations === 'function') {
                        saveSystemConfigurations(systemConfig);
                    }
                } catch (_) {}
            }
            __cooptRememberBlockVariablesForConfig(activeConfigId, blocks);
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
            const blockVariableSnapshots = new Map<string, any>();
            const isObjectRecord = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
            const restoreBlockVariablesFromSnapshot = () => {
                if (blockVariableSnapshots.size === 0) return;
                for (const block of blocks) {
                    if (!block || typeof block !== 'object') continue;
                    const id = String(block?.blockId ?? '').trim();
                    if (!id) continue;
                    const snapshot = blockVariableSnapshots.get(id);
                    if (!isObjectRecord(snapshot)) continue;
                    const current = isObjectRecord(block.variables) ? block.variables : {};
                    const merged: Record<string, any> = { ...snapshot, ...current };
                    for (const [key, snapshotEntry] of Object.entries(snapshot)) {
                        const currentEntry = current[key];
                        if (!isObjectRecord(snapshotEntry) || !isObjectRecord(currentEntry)) continue;
                        const mergedEntry: Record<string, any> = { ...snapshotEntry, ...currentEntry };
                        if (isObjectRecord(snapshotEntry.optimize) || isObjectRecord(currentEntry.optimize)) {
                            mergedEntry.optimize = {
                                ...(isObjectRecord(snapshotEntry.optimize) ? snapshotEntry.optimize : {}),
                                ...(isObjectRecord(currentEntry.optimize) ? currentEntry.optimize : {}),
                            };
                        }
                        merged[key] = mergedEntry;
                    }
                    block.variables = merged;
                }
            };
            try {
                for (const block of blocks) {
                    if (!block || typeof block !== 'object') continue;
                    const id = String(block?.blockId ?? '').trim();
                    if (!id) continue;
                    if (!isObjectRecord(block.variables)) continue;
                    blockVariableSnapshots.set(id, cooptCloneJsonValue(block.variables) || block.variables);
                }

                const rows = Array.isArray(__cooptBlockInspectorExpandedRowsOverride)
                    ? __cooptBlockInspectorExpandedRowsOverride
                    : (() => {
                        if (typeof expandBlocksToOpticalSystemRows !== 'function') return [];
                        const exp = expandBlocksToOpticalSystemRows(blocks);
                        return exp && Array.isArray(exp.rows) ? exp.rows : [];
                    })();
                restoreBlockVariablesFromSnapshot();
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
            } catch (_) {
                restoreBlockVariablesFromSnapshot();
            }

            // Pure block-inspector refresh must not push rows back into the optical table.
            // That path can retrigger row-derived sync and drop block-local var metadata.
            try {
                if (Array.isArray(__cooptBlockInspectorExpandedRowsOverride) && __cooptBlockInspectorExpandedRowsOverride.length > 0) {
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

    if (isPhysicalBlockType(type)) {
        const physical = createDefaultPhysicalBlock(type, id) as any;
        physical.metadata = { ...(physical.metadata ?? {}), source: 'ui-add' };
        return physical;
    }

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

function __blocks_addBlockToActiveConfig(
    blockType: string,
    insertAfterBlockId: string | null = null,
    sequentialGroupId: string | null = null
): any {
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
    const validationIssueKey = (issue: any): string => `${String(issue?.blockId ?? '')}\u0000${String(issue?.message ?? '')}`;
    const preExistingFatalKeys = new Set<string>();
    try {
        for (const issue of validateBlocksConfiguration(activeCfg)) {
            if (issue?.severity === 'fatal') preExistingFatalKeys.add(validationIssueKey(issue));
        }
    } catch (_) {}

    let imageIdx = blocks.findIndex(b => b && String(b.blockType ?? '').trim() === 'ImageSurface');
    if (imageIdx < 0) imageIdx = blocks.length;

    const physicalBlock = isPhysicalBlockType(type);
    let insertIdx = physicalBlock ? blocks.length : imageIdx;
    if (type === 'ObjectSurface') insertIdx = 0;

    const afterId = String(insertAfterBlockId ?? '').trim();
    if (afterId) {
        const idx = blocks.findIndex(b => b && String(b.blockId ?? '').trim() === afterId);
        if (idx >= 0) insertIdx = physicalBlock ? idx + 1 : Math.min(idx + 1, imageIdx);
    }

    blocks.splice(insertIdx, 0, newBlock);

    if (!physicalBlock && String(sequentialGroupId ?? '').trim()) {
        __blocks_assignSequentialBlockToGroup(activeCfg, newId, String(sequentialGroupId));
    }

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    try {
        const issues = validateBlocksConfiguration(activeCfg);
        const fatals = issues.filter(i => i && i.severity === 'fatal');
        // Existing configuration errors belong to their original blocks and
        // must not disable insertion of an otherwise valid, unrelated block.
        const introducedFatals = fatals.filter((issue) => !preExistingFatalKeys.has(validationIssueKey(issue)));
        if (introducedFatals.length > 0) {
            blocks.splice(insertIdx, 1);
            if (Array.isArray(activeCfg.sequentialGroups)) {
                for (const group of activeCfg.sequentialGroups) {
                    if (!Array.isArray(group?.blockIds)) continue;
                    group.blockIds = group.blockIds.filter((candidate: any) => String(candidate ?? '').trim() !== newId);
                }
            }
            return { ok: false, reason: String(introducedFatals[0]?.message ?? 'block validation failed.') };
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
    const previousSequentialGroupId = __blocks_groupIdForBlock(activeCfg, id);

    const removedBlock = JSON.parse(JSON.stringify(blocks[idx]));
    const removed = blocks.splice(idx, 1);
    if (Array.isArray(activeCfg.sequentialGroups)) {
        for (const group of activeCfg.sequentialGroups) {
            if (!Array.isArray(group?.blockIds)) continue;
            group.blockIds = group.blockIds.filter((candidate: any) => String(candidate ?? '').trim() !== id);
        }
    }
    if (Array.isArray(activeCfg.designConnections)) {
        activeCfg.designConnections = activeCfg.designConnections.filter((connection: any) => (
            String(connection?.from?.blockId ?? '') !== id && String(connection?.to?.blockId ?? '') !== id
        ));
    }
    if (isPhysicalBlockType(type)) delete activeCfg.coherentDesign;

    // If ImageSurface was deleted, immediately recreate it at the end to keep system valid
    if (type === 'ImageSurface') {
        const newId = __blocks_generateUniqueBlockId(blocks, 'ImageSurface');
        const newBlock = __blocks_makeDefaultBlock('ImageSurface', newId);
        blocks.push(newBlock);
        if (previousSequentialGroupId) {
            __blocks_assignSequentialBlockToGroup(activeCfg, newId, previousSequentialGroupId);
        }
    }

    try {
        if (!activeCfg.metadata || typeof activeCfg.metadata !== 'object') activeCfg.metadata = {};
        activeCfg.metadata.modified = new Date().toISOString();
    } catch (_) {}

    // Removing an assembly-only block cannot invalidate the exact sequential
    // surface train. Do not let unrelated legacy validation errors prevent
    // Source/Comb/Splitter/Detector removal.
    if (!isPhysicalBlockType(type)) {
        try {
            const issues = validateBlocksConfiguration(activeCfg);
            const fatals = issues.filter(i => i && i.severity === 'fatal');
            if (fatals.length > 0) {
                blocks.splice(idx, 0, ...(removed || []));
                if (previousSequentialGroupId) {
                    __blocks_assignSequentialBlockToGroup(activeCfg, id, previousSequentialGroupId);
                }
                return { ok: false, reason: 'block validation failed.' };
            }
        } catch (_) {}
    }

    try {
        saveSystemConfigurations(systemConfig);
    } catch (e) {
        return { ok: false, reason: `failed to save: ${e?.message || String(e)}` };
    }

    return { ok: true, blockData: removedBlock, blockIndex: idx };
}

function __deleteDesignIntentBlock(blockId: string): boolean {
    const bid = String(blockId ?? '').trim();
    if (!bid) {
        alert('Select a block first to delete.');
        return false;
    }
    const res = __blocks_deleteBlockFromActiveConfig(bid);
    if (!res || res.ok !== true) {
        alert('Failed to delete block: ' + (res?.reason || 'unknown error'));
        return false;
    }
    try {
        if (w.undoHistory && w.DeleteBlockCommand && !w.undoHistory.isExecuting && res.blockData && typeof res.blockIndex === 'number') {
            const sysConfig = loadSystemConfigurations();
            const cmd = new w.DeleteBlockCommand(sysConfig.activeConfigId, res.blockData, res.blockIndex);
            w.undoHistory.record(cmd);
        }
    } catch (_) {}
    if (__blockInspectorExpandedBlockId === bid) __blockInspectorExpandedBlockId = null;
    try {
        __cooptScheduleDesignIntentUiRefresh({ forceExpandedRows: true, refreshBlockInspector: true, triggerRender: true, debounceMs: 40 });
    } catch (_) {}
    return true;
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
    ensureDesignIntentQuickEditorToggleBinding();
    if (__designIntentToolbarDelegatedBindingInstalled) return;
    __designIntentToolbarDelegatedBindingInstalled = true;

    document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;

        const toolbar = target.closest('[id="design-intent-toolbar"]') as HTMLElement | null;
        if (!toolbar) return;

        const typeSelect = toolbar.querySelector('[id="design-intent-add-block-type"]') as HTMLSelectElement | null;
        const addBtn = target.closest('[id="design-intent-add-block-btn"]');
        const deleteBtn = target.closest('[id="design-intent-delete-block-btn"]');
        const paramAllOnBtn = target.closest('[id="design-intent-param-all-on-btn"]');
        const paramAllOffBtn = target.closest('[id="design-intent-param-all-off-btn"]');
        const autoSetAperturesBtn = target.closest('[id="design-intent-auto-set-apertures-btn"]');
        const zoomScenarioBtn = target.closest('[id="design-intent-generate-zoom-scenarios-btn"]');

        if (!addBtn && !deleteBtn && !paramAllOnBtn && !paramAllOffBtn && !autoSetAperturesBtn && !zoomScenarioBtn) {
            return;
        }

        try { e.preventDefault(); } catch (_) {}
        try { e.stopPropagation(); } catch (_) {}

        if (addBtn) {
            try {
                const type = String(typeSelect?.value ?? 'Lens').trim();
                const after = __blockInspectorExpandedBlockId;
                const res = __blocks_addBlockToActiveConfig(type, after);
                if (!res || res.ok !== true) {
                    alert(`Failed to add block: ${res?.reason || 'unknown error'}`);
                    return;
                }
                __blockInspectorExpandedBlockId = String(res.blockId ?? '') || null;
                try {
                    if (w.undoHistory && w.AddBlockCommand && !w.undoHistory.isExecuting && res.blockData && typeof res.insertIndex === 'number') {
                        const sysConfig = loadSystemConfigurations();
                        const cmd = new w.AddBlockCommand(sysConfig.activeConfigId, res.blockData, res.insertIndex);
                        w.undoHistory.record(cmd);
                    }
                } catch (_) {}
                try {
                    __cooptScheduleDesignIntentUiRefresh({ forceExpandedRows: true, refreshBlockInspector: true, triggerRender: true, debounceMs: 40 });
                } catch (_) {}
            } catch (err) {
                console.error('❌ Failed to add block:', err);
                alert(`Failed to add block: ${(err as Error)?.message || String(err)}`);
            }
            return;
        }

        if (deleteBtn) {
            try {
                __deleteDesignIntentBlock(String(__blockInspectorExpandedBlockId ?? ''));
            } catch (err) {
                console.error('Failed to delete block:', err);
                alert('Failed to delete block: ' + ((err as Error)?.message || String(err)));
            }
            return;
        }

        if (paramAllOnBtn) {
            const res = __blocks_setParameterAndApertureModeBulk(true);
            if (!res || res.ok !== true) {
                alert(`Failed to set Parameter All ON: ${res?.reason || 'unknown error'}`);
            }
            return;
        }

        if (paramAllOffBtn) {
            const res = __blocks_setParameterAndApertureModeBulk(false);
            if (!res || res.ok !== true) {
                alert(`Failed to set Parameter All OFF: ${res?.reason || 'unknown error'}`);
            }
            return;
        }

        if (autoSetAperturesBtn) {
            try {
                const ok = autoSetBlockAperturesFromLargestObjectCondition();
                if (!ok) {
                    alert('Failed to auto-set apertures.');
                    return;
                }
                try {
                    __cooptScheduleDesignIntentUiRefresh({ forceExpandedRows: true, refreshBlockInspector: true, triggerRender: true, debounceMs: 40 });
                } catch (_) {}
            } catch (err) {
                console.error('❌ Failed to auto-set apertures:', err);
                alert(`Failed to auto-set apertures: ${(err as Error)?.message || String(err)}`);
            }
            return;
        }

        if (zoomScenarioBtn) {
            try {
                const res = __blocks_generateZoomScenariosForActiveConfig();
                if (!res || res.ok !== true) {
                    alert(`Failed to generate zoom scenarios: ${res?.reason || 'unknown error'}`);
                    return;
                }
                try {
                    __cooptScheduleDesignIntentUiRefresh({ forceExpandedRows: true, refreshBlockInspector: true, refreshZoomUi: true, triggerRender: true, debounceMs: 40 });
                } catch (_) {}
            } catch (err) {
                console.error('❌ Failed to generate zoom scenarios:', err);
                alert(`Failed to generate zoom scenarios: ${(err as Error)?.message || String(err)}`);
            }
        }
    });
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
        setupZernikeFitButton();
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

    // Recover from a stale placeholder config that can hide lens data in Design Intent.
    setTimeout(() => {
        void maybeAutoRecoverDefaultLensData();
    }, 50);
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
