// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

import { clearAllOpticalElements } from '../optical/system-renderer.ts';
import * as THREE_NS from 'three';
import { generateRayStartPointsForObject, setRayEmissionPattern, setRayColorMode } from '../optical/ray-renderer.ts';
import { calculateSurfaceOrigins } from '../raytracing/core/ray-tracing.ts';
import { calculateOpticalSystemOffset } from '../utils/math.ts';
import {
    drawLensCrossSectionWithSurfaceOrigins,
    harmonizeSceneGeometry,
    validateSceneGeometry
} from '../optical/surface.ts';
import { getOpticalSystemRows, getObjectRows, getSourceRows } from '../utils/data-utils.ts';
import { derivePupilAndFocalLengthMmFromParaxial, generateSurfaceOptions } from '../evaluation/spot-diagram.ts';
import { PSFPlotter } from '../evaluation/psf/psf-plot.ts';
import { createOPDCalculator, createWavefrontAnalyzer, WavefrontAberrationAnalyzer } from '../evaluation/wavefront/wavefront.ts';
import { PSFCalculator } from '../evaluation/psf/psf-calculator.ts';
import { getLastWavefrontMap, getLastWavefrontMeta, patchLastWavefrontMap } from '../evaluation/wavefront/last-wavefront-runtime.ts';
import { calculateFocalLength, calculateParaxialData, findStopSurfaceIndex, calculateImageSpaceDiffractionParams } from '../raytracing/core/ray-paraxial.ts';
import { DEFAULT_STOP_SEMI_DIAMETER } from '../data/block-schema.ts';
import { loadSystemConfigurations } from '../data/table-configuration.ts';
import { requestUpdateSurfaceNumberSelect } from '../core/window-facade.ts';
import { runAnalysisCompute, runNativeDistortion, runNativeFieldMtfMap, runNativeGridDistortion, runNativeMtfMap, runNativeOpdMap, runNativePsfMap, runNativeSphericalAberration, runNativeSpotRaytrace, runNativeThroughFocusMtfMap } from '../src/desktop/ipc/client.ts';
import { isTauriRuntime } from '../src/desktop/runtime.ts';
import { listen } from '@tauri-apps/api/event';
import { hideAnalysisProgressHud, showAnalysisProgressHud, updateAnalysisProgressHud } from './shared/analysis-progress-hud.ts';
import type { RunAnalysisComputeRequest, RunAnalysisComputeResponse } from '../src/shared/contracts/analysis.ts';

let popupPsfCalculatorCache: PSFCalculator | null = null;

function getPopupPsfCalculator(): PSFCalculator {
    if (popupPsfCalculatorCache) {
        return popupPsfCalculatorCache;
    }
    const PsfCalculatorCtor =
        (window.opener && window.opener.PSFCalculator)
        || window.PSFCalculator
        || PSFCalculator;
    if (typeof PsfCalculatorCtor !== 'function') {
        throw new Error('PSFCalculator is not available');
    }
    popupPsfCalculatorCache = new PsfCalculatorCtor();
    return popupPsfCalculatorCache;
}

function collectPopupRowsFromMainWindow(): {
    opticalSystemRows: any[];
    sourceRows: any[];
    objectRows: any[];
} {
    let opticalSystemRows: any[] = [];
    let sourceRows: any[] = [];
    let objectRows: any[] = [];

    try {
        const rows = getOpticalSystemRows(w.tableOpticalSystem);
        if (Array.isArray(rows)) opticalSystemRows = rows;
    } catch (_) {}

    try {
        const rows = getSourceRows(w.tableSource);
        if (Array.isArray(rows)) sourceRows = rows;
    } catch (_) {}

    try {
        const rows = getObjectRows(w.tableObject);
        if (Array.isArray(rows)) objectRows = rows;
    } catch (_) {}

    // Keep popup analysis input aligned with the active configuration snapshot.
    // This reduces path drift between popup-native and in-page analysis flows.
    try {
        let activeConfig: any = null;
        if (typeof w.getActiveConfiguration === 'function') {
            activeConfig = w.getActiveConfiguration();
        }
        if (!activeConfig) {
            const all = loadSystemConfigurations();
            const activeIdRaw = all?.activeConfigId;
            const activeId = Number(activeIdRaw);
            const list = Array.isArray(all?.configurations) ? all.configurations : [];
            if (Number.isFinite(activeId)) {
                activeConfig = list.find((c: any) => Number(c?.id) === activeId) || null;
            }
            if (!activeConfig && list.length > 0) {
                activeConfig = list[0];
            }
        }

        if (activeConfig) {
            let snapshotOpticalRows: any[] = Array.isArray(activeConfig?.opticalSystem)
                ? activeConfig.opticalSystem.map((row: any) => (row && typeof row === 'object') ? { ...row } : row)
                : [];
            if (Array.isArray(activeConfig?.blocks) && activeConfig.blocks.length > 0) {
                const expanded = w.expandBlocksToOpticalSystemRows
                    ? w.expandBlocksToOpticalSystemRows(activeConfig.blocks)
                    : null;
                if (Array.isArray(expanded?.rows) && expanded.rows.length > 0) {
                    snapshotOpticalRows = expanded.rows.map((row: any) => (row && typeof row === 'object') ? { ...row } : row);
                }
            }
            const snapshotObjectRows: any[] = Array.isArray(activeConfig?.object)
                ? activeConfig.object.map((row: any) => (row && typeof row === 'object') ? { ...row } : row)
                : [];

            if (snapshotOpticalRows.length > 0) {
                opticalSystemRows = snapshotOpticalRows;
            }
            if (snapshotObjectRows.length > 0) {
                objectRows = snapshotObjectRows;
            }
        }
    } catch (_) {}

    if (!Array.isArray(objectRows) || objectRows.length === 0) {
        try {
            const directRows = w.tableObject && Array.isArray(w.tableObject.data) ? w.tableObject.data : null;
            if (Array.isArray(directRows) && directRows.length > 0) {
                objectRows = directRows;
            }
        } catch (_) {}
    }

    if (!Array.isArray(objectRows) || objectRows.length === 0) {
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

    if (!Array.isArray(objectRows) || objectRows.length === 0) {
        try {
            let activeConfig: any = null;
            if (typeof w.getActiveConfiguration === 'function') {
                activeConfig = w.getActiveConfiguration();
            }
            if (!activeConfig) {
                const all = loadSystemConfigurations();
                const activeId = Number(all?.activeConfigId);
                const list = Array.isArray(all?.configurations) ? all.configurations : [];
                if (Number.isFinite(activeId)) {
                    activeConfig = list.find((c: any) => Number(c?.id) === activeId) || null;
                }
                if (!activeConfig && list.length > 0) {
                    activeConfig = list[0];
                }
            }

            const cfgRows = activeConfig && Array.isArray(activeConfig.object) ? activeConfig.object : null;
            if (Array.isArray(cfgRows) && cfgRows.length > 0) {
                objectRows = cfgRows.map((row: any) => (row && typeof row === 'object') ? { ...row } : row);
            }
        } catch (_) {}
    }

    return { opticalSystemRows, sourceRows, objectRows };
}

function getPrimaryWavelengthMicronsFromSourceRows(sourceRows: any[]): number {
    try {
        if (!Array.isArray(sourceRows) || sourceRows.length === 0) return 0.5876;
        const isPrimaryRow = (raw: any): boolean => {
            if (raw === true || raw === 1) return true;
            const s = String(raw ?? '').trim().toLowerCase();
            return s.includes('primary') || s === 'true' || s === 'yes' || s === '1';
        };

        let fallbackWavelength = NaN;
        for (let i = 0; i < sourceRows.length; i++) {
            const row = sourceRows[i];
            const wl = Number(row?.wavelength);
            if (!Number.isFinite(wl) || wl <= 0) continue;
            if (!Number.isFinite(fallbackWavelength)) fallbackWavelength = wl;
            if (isPrimaryRow(row?.primary)) return wl;
        }

        return Number.isFinite(fallbackWavelength) && fallbackWavelength > 0 ? fallbackWavelength : 0.5876;
    } catch (_) {
        return 0.5876;
    }
}

function derivePupilAndFocalLengthMmForAiry(opticalSystemRows: any[], wavelengthUm: number): { pupilDiameterMm: number; focalLengthMm: number } {
    try {
        const derived = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, wavelengthUm, true);
        const pupilDiameterMm = Number(derived?.pupilDiameterMm);
        const focalLengthMm = Number(derived?.focalLengthMm);
        return { pupilDiameterMm, focalLengthMm };
    } catch (_) {}
    return { pupilDiameterMm: NaN, focalLengthMm: NaN };
}

function computePopupAiryRadiusUm(opticalSystemRows: any[], sourceRows: any[]): number {
    try {
        const wavelengthUm = getPrimaryWavelengthMicronsFromSourceRows(sourceRows);
        const { pupilDiameterMm, focalLengthMm } = derivePupilAndFocalLengthMmForAiry(opticalSystemRows, wavelengthUm);
        if (![wavelengthUm, pupilDiameterMm, focalLengthMm].every(Number.isFinite)) return NaN;
        if (wavelengthUm <= 0 || pupilDiameterMm <= 0 || focalLengthMm <= 0) return NaN;
        const fNumber = focalLengthMm / pupilDiameterMm;
        if (!Number.isFinite(fNumber) || fNumber <= 0) return NaN;
        const airyRadiusUm = 1.22 * wavelengthUm * fNumber;
        return Number.isFinite(airyRadiusUm) && airyRadiusUm > 0 ? airyRadiusUm : NaN;
    } catch (_) {
        return NaN;
    }
}

async function runDesktopAnalysisComputeForPopup(
    payload: Omit<RunAnalysisComputeRequest, 'opticalSystemRows' | 'sourceRows' | 'objectRows'>,
): Promise<RunAnalysisComputeResponse> {
    const jobId = `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let unlisten: null | (() => void) = null;

    showAnalysisProgressHud('Starting analysis...', 180);

    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    try {
        try {
            unlisten = await listen('analysis-progress', (event) => {
                try {
                    const data = event?.payload as any;
                    if (!data || String(data.jobId || '') !== jobId) return;

                    const message = String(data?.message || data?.phase || 'Computing analysis...');
                    const percentRaw = Number(data?.percent);
                    const percent = Number.isFinite(percentRaw) ? percentRaw : null;
                    updateAnalysisProgressHud({ label: message, percent });
                } catch (_) {}
            });
        } catch (listenErr) {
            // Some popup windows do not have permission for event.listen.
            // Continue without progress subscription and still run native compute.
            try {
                console.warn('[analysis-progress] listen unavailable in this window, continuing without progress events:', listenErr);
            } catch (_) {}
            unlisten = null;
        }

        const response = await runAnalysisCompute({
            ...payload,
            jobId,
            opticalSystemRows,
            sourceRows,
            objectRows,
        });
        updateAnalysisProgressHud({ label: 'Done', percent: 100 });
        return response;
    } finally {
        if (typeof unlisten === 'function') {
            try {
                unlisten();
            } catch (_) {}
        }
        window.setTimeout(() => {
            try {
                hideAnalysisProgressHud();
            } catch (_) {}
        }, 220);
    }
}

w.runDesktopAnalysisComputeForPopup = runDesktopAnalysisComputeForPopup;

async function runDesktopNativeOpdMapForPopup(payload: {
    objectIndex?: number;
    gridSize?: number;
    wavelengthUm?: number;
    opdDisplayMode?: 'raw' | 'pistonTiltRemoved' | 'pistonTiltDefocusRemoved' | string;
}) {
    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    const jobId = `native-opd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let unlistenProgress: null | (() => void) = null;

    try {
        showAnalysisProgressHud('Native OPD: starting...', 140);
        try {
            unlistenProgress = await listen('analysis-progress', (event: any) => {
                try {
                    const data = event?.payload || {};
                    if (!data || String(data.jobId || '') !== jobId) return;
                    const percent = Number(data.percent);
                    updateAnalysisProgressHud({
                        label: data.message || 'Native OPD running...',
                        percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
                    });
                } catch (_) {}
            });
        } catch (listenErr) {
            try {
                console.warn('[analysis-progress] listen unavailable for native OPD, continuing without progress events:', listenErr);
            } catch (_) {}
            unlistenProgress = null;
        }

        const fieldSetting = buildPopupFieldSettingFromObjectRows(
            objectRows,
            Number.isFinite(Number(payload?.objectIndex)) ? Number(payload.objectIndex) : 0,
            Number.isFinite(Number(payload?.wavelengthUm)) ? Number(payload.wavelengthUm) : getPrimaryWavelengthMicronsFromSourceRows(sourceRows || [])
        );
        const forcedInfinitePupilMode = __cooptGetForceInfinitePupilMode();
        const autoAngleX = Number(fieldSetting?.fieldAngle?.x ?? 0);
        const autoAngleY = Number(fieldSetting?.fieldAngle?.y ?? 0);
        const isNonZeroAngleField = Math.abs(autoAngleX) > 1e-12 || Math.abs(autoAngleY) > 1e-12;
        const requestedPupilSamplingMode = (forcedInfinitePupilMode === 'stop' || forcedInfinitePupilMode === 'entrance')
            ? forcedInfinitePupilMode
            : ((String(fieldSetting?.type || '').toLowerCase() === 'angle' && isNonZeroAngleField) ? 'entrance' : undefined);

        const result = await runNativeOpdMap({
            jobId,
            opticalSystemRows,
            sourceRows,
            objectRows,
            objectIndex: Number.isFinite(Number(payload?.objectIndex)) ? Number(payload.objectIndex) : 0,
            gridSize: Number.isFinite(Number(payload?.gridSize)) ? Number(payload.gridSize) : 129,
            wavelengthUm: Number.isFinite(Number(payload?.wavelengthUm)) ? Number(payload.wavelengthUm) : undefined,
            pupilSamplingMode: requestedPupilSamplingMode,
            opdDisplayMode: (payload?.opdDisplayMode as any) || 'pistonTiltRemoved',
        });

        updateAnalysisProgressHud({ label: 'Native OPD done', percent: 100 });
        return result;
    } finally {
        try {
            if (unlistenProgress) {
                unlistenProgress();
            }
        } catch (_) {}
        setTimeout(() => {
            try {
                hideAnalysisProgressHud();
            } catch (_) {}
        }, 220);
    }
}

w.runDesktopNativeOpdMapForPopup = runDesktopNativeOpdMapForPopup;

async function runDesktopNativePsfMapForPopup(payload: {
    gridOpd: number[][];
    pupilMask: boolean[][];
    gridAmplitude?: number[][];
    wavelengthUm: number;
    pixelSizeUm?: number;
    removeTilt?: boolean;
    zeroPadTo?: number;
    recenterIfWrapped?: boolean;
}) {
    const jobId = `native-psf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let unlistenProgress: null | (() => void) = null;

    try {
        showAnalysisProgressHud('Native PSF: starting...', 140);
        try {
            unlistenProgress = await listen('analysis-progress', (event: any) => {
                try {
                    const data = event?.payload || {};
                    if (!data || String(data.jobId || '') !== jobId) return;
                    const percent = Number(data.percent);
                    updateAnalysisProgressHud({
                        label: data.message || 'Native PSF running...',
                        percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
                    });
                } catch (_) {}
            });
        } catch (listenErr) {
            try {
                console.warn('[analysis-progress] listen unavailable for native PSF, continuing without progress events:', listenErr);
            } catch (_) {}
            unlistenProgress = null;
        }

        const result = await runNativePsfMap({
            jobId,
            gridOpd: Array.isArray(payload?.gridOpd) ? payload.gridOpd : [],
            pupilMask: Array.isArray(payload?.pupilMask) ? payload.pupilMask : [],
            gridAmplitude: Array.isArray(payload?.gridAmplitude) ? payload.gridAmplitude : undefined,
            wavelengthUm: Number(payload?.wavelengthUm),
            pixelSizeUm: Number.isFinite(Number(payload?.pixelSizeUm)) ? Number(payload?.pixelSizeUm) : undefined,
            removeTilt: !!payload?.removeTilt,
            zeroPadTo: Number.isFinite(Number(payload?.zeroPadTo)) ? Number(payload?.zeroPadTo) : undefined,
            recenterIfWrapped: !!payload?.recenterIfWrapped,
        });

        updateAnalysisProgressHud({ label: 'Native PSF done', percent: 100 });
        return result;
    } finally {
        try {
            if (unlistenProgress) {
                unlistenProgress();
            }
        } catch (_) {}
        setTimeout(() => {
            try {
                hideAnalysisProgressHud();
            } catch (_) {}
        }, 220);
    }
}

w.runDesktopNativePsfMapForPopup = runDesktopNativePsfMapForPopup;

async function runDesktopNativeMtfMapForPopup(payload: {
    psfData: number[][];
    pixelSizeUm: number;
    maxFrequencyLpmm?: number;
    points?: number;
}) {
    const result = await runNativeMtfMap({
        psfData: Array.isArray(payload?.psfData) ? payload.psfData : [],
        pixelSizeUm: Number(payload?.pixelSizeUm),
        maxFrequencyLpmm: Number.isFinite(Number(payload?.maxFrequencyLpmm)) ? Number(payload.maxFrequencyLpmm) : undefined,
        points: Number.isFinite(Number(payload?.points)) ? Number(payload.points) : undefined,
    });
    return result;
}

w.runDesktopNativeMtfMapForPopup = runDesktopNativeMtfMapForPopup;

async function runDesktopNativeThroughFocusMtfForPopup(payload: {
    objectIndex?: number;
    pupilSamplingMode?: 'stop' | 'entrance';
    wavelengths?: number[];
    targetFrequencyLpmm?: number;
    defocusMinMm?: number;
    defocusMaxMm?: number;
    steps?: number;
    samplingSize?: number;
    zeroPadTo?: number;
    opdDisplayMode?: string;
    onProgress?: (evt: { percent?: number; message?: string }) => void;
}) {
    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    const jobId = `native-tfmtf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let unlistenProgress: null | (() => void) = null;
    const samplingSize = Number.isFinite(Number(payload?.samplingSize)) ? Math.max(32, Math.floor(Number(payload.samplingSize))) : 256;
    const zeroPadTo = Number.isFinite(Number(payload?.zeroPadTo)) ? Math.floor(Number(payload.zeroPadTo)) : 0;
    const objectIndex = Number.isFinite(Number(payload?.objectIndex)) ? Math.max(0, Math.floor(Number(payload.objectIndex))) : 0;
    const fieldSetting = buildPopupFieldSettingFromObjectRows(
        objectRows,
        objectIndex,
        Number.isFinite(Number(payload?.wavelengths?.[0])) ? Number(payload.wavelengths?.[0]) : getPrimaryWavelengthMicronsFromSourceRows(sourceRows || [])
    );
    const forcedInfinitePupilMode = __cooptGetForceInfinitePupilMode();
    const autoAngleX = Number(fieldSetting?.fieldAngle?.x ?? 0);
    const autoAngleY = Number(fieldSetting?.fieldAngle?.y ?? 0);
    const isNonZeroAngleField = Math.abs(autoAngleX) > 1e-12 || Math.abs(autoAngleY) > 1e-12;
    const requestedPupilSamplingMode = (forcedInfinitePupilMode === 'stop' || forcedInfinitePupilMode === 'entrance')
        ? forcedInfinitePupilMode
        : ((String(fieldSetting?.type || '').toLowerCase() === 'angle' && isNonZeroAngleField) ? 'entrance' : undefined);

    let wavelengthForScale = Number.NaN;
    if (Array.isArray(payload?.wavelengths) && payload.wavelengths.length > 0) {
        const w0 = Number(payload.wavelengths[0]);
        if (Number.isFinite(w0) && w0 > 0) wavelengthForScale = w0;
    }
    if (!Number.isFinite(wavelengthForScale) || wavelengthForScale <= 0) {
        wavelengthForScale = getPrimaryWavelengthMicronsFromSourceRows(sourceRows || []);
    }
    if (!Number.isFinite(wavelengthForScale) || wavelengthForScale <= 0) {
        wavelengthForScale = 0.5876;
    }

    let pupilDiameterMm = Number.NaN;
    let focalLengthMm = Number.NaN;
    try {
        const diffParams = calculateImageSpaceDiffractionParams(opticalSystemRows || [], wavelengthForScale);
        const fWork = Number(diffParams?.fNumberWorking);
        const fl = Number(diffParams?.focalLengthMm);
        if (Number.isFinite(fWork) && fWork > 0 && Number.isFinite(fl) && fl > 0) {
            focalLengthMm = Math.abs(fl);
            pupilDiameterMm = focalLengthMm / fWork;
        }
    } catch (_) {}
    if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0) || !(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
        const derived = derivePupilAndFocalLengthMmForAiry(opticalSystemRows || [], wavelengthForScale);
        pupilDiameterMm = Number(derived?.pupilDiameterMm);
        focalLengthMm = Number(derived?.focalLengthMm);
    }
    const requestedFftSize = (!zeroPadTo || zeroPadTo === 0)
        ? Math.max(samplingSize, 512)
        : Math.max(samplingSize, zeroPadTo);
    const basePixelPitchUm = (wavelengthForScale * Math.abs(Number(focalLengthMm))) / Math.max(1e-12, Math.abs(Number(pupilDiameterMm)));
    const pixelSizeUm = basePixelPitchUm * (samplingSize / requestedFftSize);
    const reportProgress = (evt?: { percent?: number; message?: string }) => {
        try {
            const fn = payload?.onProgress;
            if (typeof fn !== 'function') return;
            fn({
                percent: Number.isFinite(Number(evt?.percent)) ? Number(evt?.percent) : undefined,
                message: (typeof evt?.message === 'string' && evt.message.trim()) ? evt.message : undefined,
            });
        } catch (_) {}
    };

    if (isTauriRuntime()) {
        try {
            unlistenProgress = await listen('analysis-progress', (event: any) => {
                try {
                    const data = event?.payload || {};
                    if (!data || String(data.jobId || '') !== jobId) return;
                    const percent = Number(data?.percent);
                    const message = String(data?.message || data?.phase || 'Computing Through-Focus MTF...');
                    reportProgress({
                        percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined,
                        message,
                    });
                } catch (_) {}
            });
        } catch (_) {
            unlistenProgress = null;
        }
    }

    try {
        return await runNativeThroughFocusMtfMap({
            jobId,
            opticalSystemRows,
            sourceRows,
            objectRows,
            objectIndex,
            pupilSamplingMode: (payload?.pupilSamplingMode === 'stop' || payload?.pupilSamplingMode === 'entrance')
                ? payload.pupilSamplingMode
                : requestedPupilSamplingMode,
            wavelengths: Array.isArray(payload?.wavelengths)
                ? payload.wavelengths.filter((w) => Number.isFinite(Number(w)) && Number(w) > 0).map((w) => Number(w))
                : [],
            targetFrequencyLpmm: Number.isFinite(Number(payload?.targetFrequencyLpmm)) ? Number(payload.targetFrequencyLpmm) : 10,
            defocusMinMm: Number.isFinite(Number(payload?.defocusMinMm)) ? Number(payload.defocusMinMm) : -0.5,
            defocusMaxMm: Number.isFinite(Number(payload?.defocusMaxMm)) ? Number(payload.defocusMaxMm) : 0.5,
            steps: Number.isFinite(Number(payload?.steps)) ? Math.floor(Number(payload.steps)) : 21,
            samplingSize,
            zeroPadTo: requestedFftSize,
            pixelSizeUm,
            opdDisplayMode: String(payload?.opdDisplayMode || 'pistonTiltRemoved'),
        }, reportProgress);
    } finally {
        try {
            if (unlistenProgress) unlistenProgress();
        } catch (_) {}
    }
}

w.runDesktopNativeThroughFocusMtfForPopup = runDesktopNativeThroughFocusMtfForPopup;

async function runDesktopNativeCompareMtfVsTfmtfForPopup(payload: {
    objectIndex?: number;
    wavelengthUm?: number;
    targetFrequencyLpmm?: number;
    samplingSize?: number;
    zeroPadTo?: number;
    opdDisplayMode?: string;
    pupilSamplingMode?: 'stop' | 'entrance';
}) {
    if (!isTauriRuntime()) {
        throw new Error('Desktop runtime is not available');
    }

    const { opticalSystemRows, sourceRows } = collectPopupRowsFromMainWindow();
    const objectIndex = Number.isFinite(Number(payload?.objectIndex)) ? Math.max(0, Math.floor(Number(payload.objectIndex))) : 0;
    const targetFrequencyLpmm = Number.isFinite(Number(payload?.targetFrequencyLpmm)) ? Number(payload.targetFrequencyLpmm) : 10;
    const samplingSize = Number.isFinite(Number(payload?.samplingSize)) ? Math.max(32, Math.floor(Number(payload.samplingSize))) : 256;
    const zeroPadToRaw = Number.isFinite(Number(payload?.zeroPadTo)) ? Math.floor(Number(payload.zeroPadTo)) : 0;
    const requestedFftSize = (!zeroPadToRaw || zeroPadToRaw === 0)
        ? Math.max(samplingSize, 512)
        : Math.max(samplingSize, zeroPadToRaw);
    const opdDisplayModeRaw = String(payload?.opdDisplayMode || 'pistonTiltRemoved');
    const opdDisplayMode: 'raw' | 'pistonTiltRemoved' | 'pistonTiltDefocusRemoved' =
        (opdDisplayModeRaw === 'raw' || opdDisplayModeRaw === 'pistonTiltDefocusRemoved')
            ? opdDisplayModeRaw
            : 'pistonTiltRemoved';

    const wlFromPayload = Number(payload?.wavelengthUm);
    const wavelengthUm = (Number.isFinite(wlFromPayload) && wlFromPayload > 0)
        ? wlFromPayload
        : getPrimaryWavelengthMicronsFromSourceRows(sourceRows || []);
    const wl = (Number.isFinite(wavelengthUm) && wavelengthUm > 0) ? wavelengthUm : 0.5876;

    const interpolateAxisValue = (axis: any[], values: any[], targetX: number): number => {
        if (!Array.isArray(axis) || !Array.isArray(values) || axis.length !== values.length) return NaN;
        const pts = axis
            .map((x: any, i: number) => ({ x: Number(x), y: Number(values[i]) }))
            .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
            .sort((a, b) => a.x - b.x);
        if (!pts.length) return NaN;
        if (pts.length === 1) return pts[0].y;
        if (targetX <= pts[0].x) return pts[0].y;
        if (targetX >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1];
            const b = pts[i];
            if (targetX <= b.x && b.x > a.x) {
                const t = (targetX - a.x) / (b.x - a.x);
                return a.y + t * (b.y - a.y);
            }
        }
        return pts[pts.length - 1].y;
    };

    const pickZeroDefocusValue = (xAxis: any[], yAxis: any[]): number => {
        if (!Array.isArray(xAxis) || !Array.isArray(yAxis) || xAxis.length !== yAxis.length || xAxis.length === 0) return NaN;
        let bestIdx = 0;
        let best = Infinity;
        for (let i = 0; i < xAxis.length; i++) {
            const x = Number(xAxis[i]);
            if (!Number.isFinite(x)) continue;
            const d = Math.abs(x);
            if (d < best) {
                best = d;
                bestIdx = i;
            }
        }
        const v = Number(yAxis[bestIdx]);
        return Number.isFinite(v) ? v : NaN;
    };

    // Native TFMTF at defocus=0
    const tfmtfResp = await runDesktopNativeThroughFocusMtfForPopup({
        objectIndex,
        pupilSamplingMode: payload?.pupilSamplingMode,
        wavelengths: [wl],
        targetFrequencyLpmm,
        defocusMinMm: 0,
        defocusMaxMm: 0,
        steps: 3,
        samplingSize,
        zeroPadTo: requestedFftSize,
        opdDisplayMode,
    });

    const tfSeries = Array.isArray(tfmtfResp?.series) ? tfmtfResp.series[0] : null;
    const tfXAxis = Array.isArray(tfmtfResp?.xAxis) ? tfmtfResp.xAxis : [];
    const tfTangential = pickZeroDefocusValue(tfXAxis, Array.isArray(tfSeries?.mtfTangential) ? tfSeries.mtfTangential : []);
    const tfSagittal = pickZeroDefocusValue(tfXAxis, Array.isArray(tfSeries?.mtfSagittal) ? tfSeries.mtfSagittal : []);

    // Native MTF (single-focus)
    const nativeOpdResp = await runDesktopNativeOpdMapForPopup({
        objectIndex,
        gridSize: samplingSize,
        wavelengthUm: wl,
        opdDisplayMode,
    });

    const s = samplingSize;
    const opdGrid = Array.from({ length: s }, () => new Float32Array(s));
    const ampGrid = Array.from({ length: s }, () => new Float32Array(s));
    const maskGrid = Array.from({ length: s }, () => Array(s).fill(false));
    const displayOpdGrid = Array.isArray(nativeOpdResp?.displayOpdGrid) ? nativeOpdResp.displayOpdGrid : [];
    const rawOpdGrid = Array.isArray(nativeOpdResp?.rawOpdGrid) ? nativeOpdResp.rawOpdGrid : [];

    for (let iy = 0; iy < s; iy++) {
        const rowDisplay = displayOpdGrid[iy] || [];
        const rowRaw = rawOpdGrid[iy] || [];
        for (let ix = 0; ix < s; ix++) {
            const rawCell = rowRaw[ix];
            if (rawCell === null || rawCell === undefined) continue;
            const vRawWaves = Number(rawCell);
            if (!Number.isFinite(vRawWaves)) continue;
            const displayCell = rowDisplay[ix];
            const vDisplayWaves = (displayCell === null || displayCell === undefined) ? NaN : Number(displayCell);
            const vWaves = Number.isFinite(vDisplayWaves) ? vDisplayWaves : vRawWaves;
            opdGrid[iy][ix] = vWaves * wl;
            ampGrid[iy][ix] = 1.0;
            maskGrid[iy][ix] = true;
        }
    }

    let pupilDiameterMm = Number.NaN;
    let focalLengthMm = Number.NaN;
    let fNumberForDiffraction = Number.NaN;
    let naImage = Number.NaN;
    let cutoffLpmm = Number.NaN;
    try {
        const diffParams = calculateImageSpaceDiffractionParams(opticalSystemRows || [], wl);
        const fWork = Number(diffParams?.fNumberWorking);
        const fl = Number(diffParams?.focalLengthMm);
        const naImg = Number(diffParams?.naImage);
        const cutoff = Number(diffParams?.cutoffLpmm);
        if (Number.isFinite(fWork) && fWork > 0 && Number.isFinite(fl) && fl > 0) {
            focalLengthMm = Math.abs(fl);
            pupilDiameterMm = focalLengthMm / fWork;
            fNumberForDiffraction = fWork;
        }
        if (Number.isFinite(naImg) && naImg > 0) {
            naImage = naImg;
        }
        if (Number.isFinite(cutoff) && cutoff > 0) {
            cutoffLpmm = cutoff;
        }
    } catch (_) {}
    if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0) || !(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
        const derived = derivePupilAndFocalLengthMmForAiry(opticalSystemRows || [], wl);
        pupilDiameterMm = Number(derived?.pupilDiameterMm);
        focalLengthMm = Number(derived?.focalLengthMm);
    }

    const basePixelPitchUm = (wl * Math.abs(Number(focalLengthMm))) / Math.max(1e-12, Math.abs(Number(pupilDiameterMm)));
    const pixelSizeUm = basePixelPitchUm * (samplingSize / requestedFftSize);
    if (!(Number.isFinite(fNumberForDiffraction) && fNumberForDiffraction > 0)) {
        const fNum = Math.abs(Number(focalLengthMm)) / Math.max(1e-12, Math.abs(Number(pupilDiameterMm)));
        if (Number.isFinite(fNum) && fNum > 0) {
            fNumberForDiffraction = fNum;
        }
    }
    if (!(Number.isFinite(cutoffLpmm) && cutoffLpmm > 0) && Number.isFinite(fNumberForDiffraction) && fNumberForDiffraction > 0) {
        cutoffLpmm = 1000.0 / (Math.max(1e-12, wl) * fNumberForDiffraction);
    }

    const nativePsfResp = await runDesktopNativePsfMapForPopup({
        gridOpd: Array.from({ length: s }, (_, iy) => Array.from(opdGrid[iy] || [])),
        gridAmplitude: Array.from({ length: s }, (_, iy) => Array.from(ampGrid[iy] || [])),
        pupilMask: Array.from({ length: s }, (_, iy) => Array.from(maskGrid[iy] || [])),
        wavelengthUm: wl,
        pixelSizeUm,
        removeTilt: false,
        zeroPadTo: requestedFftSize,
        recenterIfWrapped: false,
    });

    const nativeMtfResp = await runDesktopNativeMtfMapForPopup({
        psfData: nativePsfResp?.psfData,
        pixelSizeUm,
        maxFrequencyLpmm: Number.isFinite(targetFrequencyLpmm) ? Math.max(1, targetFrequencyLpmm) : 10,
        points: 121,
    });

    const freqAxis = Array.isArray(nativeMtfResp?.frequencyAxis) ? nativeMtfResp.frequencyAxis : [];
    const mtfTangentialAxis = Array.isArray(nativeMtfResp?.mtfTangential) ? nativeMtfResp.mtfTangential : [];
    const mtfSagittalAxis = Array.isArray(nativeMtfResp?.mtfSagittal) ? nativeMtfResp.mtfSagittal : [];
    const mtfTangential = interpolateAxisValue(freqAxis, mtfTangentialAxis, targetFrequencyLpmm);
    const mtfSagittal = interpolateAxisValue(freqAxis, mtfSagittalAxis, targetFrequencyLpmm);

    const report = {
        backend: 'desktop-native-rust',
        conditions: {
            objectIndex,
            wavelengthUm: wl,
            targetFrequencyLpmm,
            samplingSize,
            zeroPadTo: requestedFftSize,
            opdDisplayMode,
            pupilSamplingMode: String(nativeOpdResp?.pupilSamplingMode || ''),
            pixelSizeUm,
            fNumberForDiffraction,
            naImage,
            cutoffLpmm,
        },
        mtf: {
            tangential: mtfTangential,
            sagittal: mtfSagittal,
            nyquistLpmm: Number(nativeMtfResp?.nyquistLpmm),
        },
        tfmtfAtDefocus0: {
            tangential: tfTangential,
            sagittal: tfSagittal,
        },
        delta: {
            tangential: (Number.isFinite(mtfTangential) && Number.isFinite(tfTangential)) ? (tfTangential - mtfTangential) : NaN,
            sagittal: (Number.isFinite(mtfSagittal) && Number.isFinite(tfSagittal)) ? (tfSagittal - mtfSagittal) : NaN,
        }
    };

    console.log('📊 [Native Rust MTF vs TFMTF parity]', report);
    return report;
}

w.runDesktopNativeCompareMtfVsTfmtfForPopup = runDesktopNativeCompareMtfVsTfmtfForPopup;

async function runDesktopNativeFieldMtfForPopup(payload: {
    objectIndex?: number;
    pupilSamplingMode?: 'stop' | 'entrance';
    wavelengths?: number[];
    firstFrequencyLpmm?: number;
    secondFrequencyLpmm?: number;
    fieldMin?: number;
    fieldMax?: number;
    steps?: number;
    samplingSize?: number;
    zeroPadTo?: number;
    opdDisplayMode?: string;
    fieldAxisMode?: 'angle' | 'height';
    onProgress?: (evt: { percent?: number; message?: string }) => void;
}) {
    if (!isTauriRuntime()) {
        throw new Error('Desktop runtime is not available');
    }

    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    const samplingSize = Number.isFinite(Number(payload?.samplingSize)) ? Math.max(32, Math.floor(Number(payload.samplingSize))) : 256;
    const zeroPadTo = Number.isFinite(Number(payload?.zeroPadTo)) ? Math.floor(Number(payload.zeroPadTo)) : 0;
    const objectIndex = Number.isFinite(Number(payload?.objectIndex)) ? Math.max(0, Math.floor(Number(payload.objectIndex))) : 0;
    const forcedInfinitePupilMode = __cooptGetForceInfinitePupilMode();
    const requestedPupilSamplingMode = (payload?.pupilSamplingMode === 'stop' || payload?.pupilSamplingMode === 'entrance')
        ? payload.pupilSamplingMode
        : ((forcedInfinitePupilMode === 'stop' || forcedInfinitePupilMode === 'entrance') ? forcedInfinitePupilMode : undefined);

    const isPowerOfTwo = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
    const nextPowerOfTwo = (n: number) => {
        let p = 1;
        const target = Math.max(1, Math.floor(Number(n) || 1));
        while (p < target && p < 4096) p <<= 1;
        return p;
    };

    const firstFrequencyLpmm = Number.isFinite(Number(payload?.firstFrequencyLpmm)) ? Number(payload.firstFrequencyLpmm) : 10;
    const secondFrequencyLpmm = Number.isFinite(Number(payload?.secondFrequencyLpmm)) ? Number(payload.secondFrequencyLpmm) : 30;
    const fieldMinRaw = Number.isFinite(Number(payload?.fieldMin)) ? Number(payload.fieldMin) : 0;
    const fieldMaxRaw = Number.isFinite(Number(payload?.fieldMax)) ? Number(payload.fieldMax) : 10;
    const fieldMin = Math.min(fieldMinRaw, fieldMaxRaw);
    const fieldMax = Math.max(fieldMinRaw, fieldMaxRaw);
    const steps = Number.isFinite(Number(payload?.steps)) ? Math.max(3, Math.floor(Number(payload.steps))) : 21;
    const opdDisplayModeRaw = String(payload?.opdDisplayMode || 'pistonTiltRemoved');
    const opdDisplayMode: 'raw' | 'pistonTiltRemoved' | 'pistonTiltDefocusRemoved' =
        (opdDisplayModeRaw === 'raw' || opdDisplayModeRaw === 'pistonTiltDefocusRemoved')
            ? opdDisplayModeRaw
            : 'pistonTiltRemoved';
    const axisMode = payload?.fieldAxisMode === 'height' ? 'height' : 'angle';

    const desiredPlotPointCount = 121;
    const hasExplicitZeroPad = Number.isFinite(zeroPadTo) && zeroPadTo >= samplingSize && isPowerOfTwo(zeroPadTo);
    const minRequiredNForBins = Math.max(samplingSize, 2 * (desiredPlotPointCount - 1));
    const adaptiveZeroPadTo = nextPowerOfTwo(minRequiredNForBins);
    let requestedFftSize = hasExplicitZeroPad ? zeroPadTo : adaptiveZeroPadTo;
    if (hasExplicitZeroPad && requestedFftSize === samplingSize && samplingSize <= 32) {
        requestedFftSize = 64;
    }

    const wavelengths = (() => {
        const arr = Array.isArray(payload?.wavelengths)
            ? payload.wavelengths.filter((w) => Number.isFinite(Number(w)) && Number(w) > 0).map((w) => Number(w))
            : [];
        if (arr.length > 0) return arr;
        const p = getPrimaryWavelengthMicronsFromSourceRows(sourceRows || []);
        return [Number.isFinite(p) && p > 0 ? p : 0.5876];
    })();

    const xAxis = Array.from({ length: steps }, (_, i) => {
        if (steps <= 1) return fieldMin;
        const t = i / (steps - 1);
        return fieldMin + t * (fieldMax - fieldMin);
    });

    const reportProgress = (percent: number, message: string) => {
        try {
            const fn = payload?.onProgress;
            if (typeof fn === 'function') {
                fn({ percent, message });
            }
        } catch (_) {}
    };

    const interpolateAxis = (axis: any[], values: any[], targetX: number): number => {
        if (!Array.isArray(axis) || !Array.isArray(values) || axis.length !== values.length) return 0;
        const pts = axis
            .map((x: any, i: number) => ({ x: Number(x), y: Number(values[i]) }))
            .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
            .sort((a, b) => a.x - b.x);
        if (!pts.length) return 0;
        if (pts.length === 1) return Math.max(0, Math.min(1, pts[0].y));
        if (targetX <= pts[0].x) return Math.max(0, Math.min(1, pts[0].y));
        if (targetX >= pts[pts.length - 1].x) return Math.max(0, Math.min(1, pts[pts.length - 1].y));
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1];
            const b = pts[i];
            if (targetX <= b.x && b.x > a.x) {
                const t = (targetX - a.x) / (b.x - a.x);
                return Math.max(0, Math.min(1, a.y + t * (b.y - a.y)));
            }
        }
        return Math.max(0, Math.min(1, pts[pts.length - 1].y));
    };

    const findBracket = (axis: any[], targetX: number): [number | null, number | null] => {
        if (!Array.isArray(axis) || axis.length === 0 || !Number.isFinite(targetX)) return [null, null];
        const pts = axis.map((x: any) => Number(x)).filter((x: number) => Number.isFinite(x)).sort((a: number, b: number) => a - b);
        if (!pts.length) return [null, null];
        if (targetX <= pts[0]) return [pts[0], pts[0]];
        if (targetX >= pts[pts.length - 1]) return [pts[pts.length - 1], pts[pts.length - 1]];
        for (let i = 1; i < pts.length; i++) {
            if (targetX <= pts[i]) return [pts[i - 1], pts[i]];
        }
        return [pts[pts.length - 1], pts[pts.length - 1]];
    };

    const cloneObjectRowsForField = (fieldValue: number): any[] => {
        const cloned = Array.isArray(objectRows)
            ? objectRows.map((r) => {
                try { return JSON.parse(JSON.stringify(r)); } catch (_) { return { ...(r || {}) }; }
            })
            : [];
        if (!cloned.length) {
            cloned.push(axisMode === 'angle'
                ? { name: 'AutoField0', position: 'Angle', xHeightAngle: 0, yHeightAngle: fieldValue, x: 0, y: fieldValue }
                : { name: 'AutoField0', position: 'Rectangle', xHeight: 0, yHeight: fieldValue, x: 0, y: fieldValue });
        }
        const idx = Math.max(0, Math.min(objectIndex, cloned.length - 1));
        const row: any = cloned[idx] && typeof cloned[idx] === 'object' ? cloned[idx] : {};
        if (axisMode === 'angle') {
            row.position = 'Angle';
            row.xHeightAngle = 0;
            row.yHeightAngle = fieldValue;
            row.x = 0;
            row.y = fieldValue;
        } else {
            row.position = 'Rectangle';
            row.xHeight = 0;
            row.yHeight = fieldValue;
            row.x = 0;
            row.y = fieldValue;
        }
        cloned[idx] = row;
        return cloned;
    };

    const inferTanAxis = (fieldValue: number): 'x' | 'y' => {
        const fx = 0;
        const fy = Number(fieldValue);
        if (!(Math.abs(fx) > 0 || Math.abs(fy) > 0)) return 'x';
        return Math.abs(fx) >= Math.abs(fy) ? 'x' : 'y';
    };

    const computePixelSizeUm = (wl: number): number => {
        let pupilDiameterMm = Number.NaN;
        let focalLengthMm = Number.NaN;
        try {
            const diffParams = calculateImageSpaceDiffractionParams(opticalSystemRows || [], wl);
            const fWork = Number(diffParams?.fNumberWorking);
            const fl = Number(diffParams?.focalLengthMm);
            if (Number.isFinite(fl) && fl > 0 && Number.isFinite(fWork) && fWork > 0) {
                focalLengthMm = Math.abs(fl);
                pupilDiameterMm = focalLengthMm / fWork;
            }
        } catch (_) {}

        if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) {
            try {
                const si = Number(findStopSurfaceIndex(opticalSystemRows || []));
                const stopRow: any = (Number.isFinite(si) && si >= 0) ? (opticalSystemRows as any[])?.[si] : null;
                const sdRaw = stopRow?.semidia ?? stopRow?.Semidia ?? stopRow?.['Semi Diameter'] ?? stopRow?.aperture ?? stopRow?.Aperture ?? NaN;
                const sd = Math.abs(parseFloat(sdRaw));
                if (Number.isFinite(sd) && sd > 0) {
                    const isApertureField = !!(stopRow && (stopRow.aperture !== undefined || stopRow.Aperture !== undefined));
                    const stopRadiusMm = isApertureField ? (sd * 0.5) : sd;
                    if (Number.isFinite(stopRadiusMm) && stopRadiusMm > 0) {
                        pupilDiameterMm = stopRadiusMm * 2;
                    }
                }
            } catch (_) {}
        }

        if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
            try {
                const fl = Number(calculateFocalLength(opticalSystemRows || [], wl));
                if (Number.isFinite(fl) && Math.abs(fl) > 1e-9 && fl !== Infinity) {
                    focalLengthMm = Math.abs(fl);
                }
            } catch (_) {}
        }

        if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0) || !(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
            const derived = derivePupilAndFocalLengthMmForAiry(opticalSystemRows || [], wl);
            if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) pupilDiameterMm = Number(derived?.pupilDiameterMm);
            if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) focalLengthMm = Number(derived?.focalLengthMm);
        }

        if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
            focalLengthMm = 100.0;
        }
        if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) {
            pupilDiameterMm = 10.0;
        }

        const basePixelPitchUm = (wl * Math.abs(Number(focalLengthMm))) / Math.max(1e-12, Math.abs(Number(pupilDiameterMm)));
        return basePixelPitchUm * (samplingSize / requestedFftSize);
    };

    const series: any[] = [];
    const totalPoints = Math.max(1, wavelengths.length * xAxis.length);
    let completedPoints = 0;
    reportProgress(5, `Computing Object MTF: ${wavelengths.length} wavelength(s), ${xAxis.length} field points`);
    for (const wl of wavelengths) {
        const meridionalFirst: number[] = [];
        const sagittalFirst: number[] = [];
        const meridionalSecond: number[] = [];
        const sagittalSecond: number[] = [];
        const fieldDiagnostics: any[] = [];
        const pixelSizeUm = computePixelSizeUm(wl);

        for (let fieldIndex = 0; fieldIndex < xAxis.length; fieldIndex++) {
            const fieldValue = xAxis[fieldIndex];
            const overallIndex = completedPoints + 1;
            const nm = (wl * 1000).toFixed(1);
            const unit = axisMode === 'height' ? 'mm' : 'deg';
            const pct = 5 + (overallIndex / totalPoints) * 90;
            reportProgress(
                Math.max(5, Math.min(95, pct)),
                `Computing Object MTF: λ=${nm}nm, point ${fieldIndex + 1}/${xAxis.length} (${Number(fieldValue).toFixed(3)} ${unit})`
            );

            const stepObjectRows = cloneObjectRowsForField(fieldValue);
            const autoMode = axisMode === 'angle' ? 'entrance' : undefined;
            const pupilSamplingMode = requestedPupilSamplingMode || autoMode;

            const opdResp = await runNativeOpdMap({
                opticalSystemRows,
                sourceRows,
                objectRows: stepObjectRows,
                objectIndex,
                surfaceIndex: undefined,
                gridSize: samplingSize,
                wavelengthUm: wl,
                pupilSamplingMode,
                opdDisplayMode,
            });

            const s = samplingSize;
            const gridOpd = Array.from({ length: s }, () => Array.from({ length: s }, () => 0));
            const pupilMask = Array.from({ length: s }, () => Array.from({ length: s }, () => false));
            const displayOpdGrid = Array.isArray((opdResp as any)?.displayOpdGrid) ? (opdResp as any).displayOpdGrid : [];
            const rawOpdGrid = Array.isArray((opdResp as any)?.rawOpdGrid) ? (opdResp as any).rawOpdGrid : [];
            for (let iy = 0; iy < s; iy++) {
                const rowDisplay = displayOpdGrid[iy] || [];
                const rowRaw = rawOpdGrid[iy] || [];
                for (let ix = 0; ix < s; ix++) {
                    const rawCell = rowRaw[ix];
                    if (rawCell === null || rawCell === undefined || rawCell === '') continue;
                    const vRawWaves = Number(rawCell);
                    if (!Number.isFinite(vRawWaves)) continue;
                    const displayCell = rowDisplay[ix];
                    const vDisplayWaves = (displayCell === null || displayCell === undefined || displayCell === '') ? NaN : Number(displayCell);
                    const vWaves = Number.isFinite(vDisplayWaves) ? vDisplayWaves : vRawWaves;
                    gridOpd[iy][ix] = vWaves * wl;
                    pupilMask[iy][ix] = true;
                }
            }

            const psfResp = await runNativePsfMap({
                gridOpd,
                pupilMask,
                wavelengthUm: wl,
                pixelSizeUm,
                removeTilt: false,
                zeroPadTo: requestedFftSize,
                recenterIfWrapped: false,
            });

            const mtfResp = await runNativeMtfMap({
                psfData: (psfResp as any)?.psfData,
                pixelSizeUm,
                maxFrequencyLpmm: Math.max(1, Math.max(firstFrequencyLpmm, secondFrequencyLpmm) * 2),
                points: 121,
            });

            const freqAxis = Array.isArray((mtfResp as any)?.frequencyAxis) ? (mtfResp as any).frequencyAxis : [];
            const mtfTangential = Array.isArray((mtfResp as any)?.mtfTangential) ? (mtfResp as any).mtfTangential : [];
            const mtfSagittal = Array.isArray((mtfResp as any)?.mtfSagittal) ? (mtfResp as any).mtfSagittal : [];
            const tanAxis = inferTanAxis(fieldValue);
            const tanVals = tanAxis === 'x' ? mtfSagittal : mtfTangential;
            const sagVals = tanAxis === 'x' ? mtfTangential : mtfSagittal;

            const firstM = interpolateAxis(freqAxis, tanVals, firstFrequencyLpmm);
            const firstS = interpolateAxis(freqAxis, sagVals, firstFrequencyLpmm);
            const secondM = interpolateAxis(freqAxis, tanVals, secondFrequencyLpmm);
            const secondS = interpolateAxis(freqAxis, sagVals, secondFrequencyLpmm);

            meridionalFirst.push(firstM);
            sagittalFirst.push(firstS);
            meridionalSecond.push(secondM);
            sagittalSecond.push(secondS);

            const [firstLo, firstHi] = findBracket(freqAxis, firstFrequencyLpmm);
            const [secondLo, secondHi] = findBracket(freqAxis, secondFrequencyLpmm);
            const sampleCount = Number((opdResp as any)?.sampleCount || 0);
            const hitCount = Number((opdResp as any)?.hitCount || 0);
            fieldDiagnostics.push({
                fieldValue,
                effectivePupilSamplingMode: String((opdResp as any)?.pupilSamplingMode || ''),
                usedObjectPosition: String((opdResp as any)?.usedObjectPosition || ''),
                targetSurfaceIndex: Number((opdResp as any)?.targetSurface),
                usedObjectIndex: Number((opdResp as any)?.usedObjectIndex),
                opdSampleCount: sampleCount,
                opdHitCount: hitCount,
                opdHitRate: sampleCount > 0 ? (hitCount / sampleCount) : 0,
                firstFrequencyLpmm,
                firstBracketLowLpmm: firstLo,
                firstBracketHighLpmm: firstHi,
                firstValueMeridional: firstM,
                firstValueSagittal: firstS,
                secondFrequencyLpmm,
                secondBracketLowLpmm: secondLo,
                secondBracketHighLpmm: secondHi,
                secondValueMeridional: secondM,
                secondValueSagittal: secondS,
            });

            completedPoints += 1;
        }

        series.push({
            wavelengthUm: wl,
            label: `${(wl * 1000).toFixed(1)}nm`,
            meridionalFirst,
            sagittalFirst,
            meridionalSecond,
            sagittalSecond,
            fieldDiagnostics,
        });
    }

    return {
        backend: 'desktop-native-field-mtf-via-analysis-mtf',
        xAxis,
        axisMode,
        series,
        message: 'Native Object MTF computed via background analysis MTF sampling',
    };
}

w.runDesktopNativeFieldMtfForPopup = runDesktopNativeFieldMtfForPopup;

async function runPortableFieldMtfForPopup(payload: {
    objectIndex?: number;
    pupilSamplingMode?: 'stop' | 'entrance';
    wavelengths?: number[];
    firstFrequencyLpmm?: number;
    secondFrequencyLpmm?: number;
    fieldMin?: number;
    fieldMax?: number;
    steps?: number;
    samplingSize?: number;
    zeroPadTo?: number;
    opdDisplayMode?: string;
    fieldAxisMode?: 'angle' | 'height';
    onProgress?: (evt: { percent?: number; message?: string }) => void;
}) {
    if (isTauriRuntime()) {
        return runDesktopNativeFieldMtfForPopup(payload || {});
    }

    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    return runNativeFieldMtfMap({
        opticalSystemRows,
        sourceRows,
        objectRows,
        objectIndex: Number.isFinite(Number(payload?.objectIndex)) ? Math.max(0, Math.floor(Number(payload?.objectIndex))) : 0,
        pupilSamplingMode: payload?.pupilSamplingMode,
        wavelengths: Array.isArray(payload?.wavelengths) ? payload.wavelengths : undefined,
        firstFrequencyLpmm: Number.isFinite(Number(payload?.firstFrequencyLpmm)) ? Number(payload?.firstFrequencyLpmm) : undefined,
        secondFrequencyLpmm: Number.isFinite(Number(payload?.secondFrequencyLpmm)) ? Number(payload?.secondFrequencyLpmm) : undefined,
        fieldMin: Number.isFinite(Number(payload?.fieldMin)) ? Number(payload?.fieldMin) : undefined,
        fieldMax: Number.isFinite(Number(payload?.fieldMax)) ? Number(payload?.fieldMax) : undefined,
        steps: Number.isFinite(Number(payload?.steps)) ? Math.max(3, Math.floor(Number(payload?.steps))) : undefined,
        samplingSize: Number.isFinite(Number(payload?.samplingSize)) ? Math.max(32, Math.floor(Number(payload?.samplingSize))) : undefined,
        zeroPadTo: Number.isFinite(Number(payload?.zeroPadTo)) ? Math.floor(Number(payload?.zeroPadTo)) : undefined,
        opdDisplayMode: payload?.opdDisplayMode,
        fieldAxisMode: payload?.fieldAxisMode,
        onProgress: payload?.onProgress,
    } as any);
}

w.runPortableFieldMtfForPopup = runPortableFieldMtfForPopup;

function inferDistortionFieldModeForPopup(objectRows: any[]): 'angle' | 'height' {
    const rows = Array.isArray(objectRows) ? objectRows : [];
    const tags = rows
        .map((o) => String(o?.position ?? o?.fieldType ?? o?.field_type ?? o?.field ?? o?.type ?? '').toLowerCase())
        .filter(Boolean);
    if (tags.some((t) => t.includes('rect') || t.includes('rectangle') || t.includes('height'))) return 'height';
    if (tags.some((t) => t.includes('angle'))) return 'angle';
    const hasNumericHeight = rows.some((o) => {
        const h = parseFloat(o?.yHeight ?? o?.y ?? o?.height ?? o?.y_height ?? Number.NaN);
        return Number.isFinite(h) && Math.abs(h) > 0;
    });
    return hasNumericHeight ? 'height' : 'angle';
}

function deriveDistortionFieldValuesForPopup(objectRows: any[]): { fieldValues: number[]; heightMode: boolean } {
    const mode = inferDistortionFieldModeForPopup(objectRows);
    if (mode === 'height') {
        const heights = (Array.isArray(objectRows) ? objectRows : [])
            .map((o) => parseFloat(o?.yHeight ?? o?.y ?? o?.height ?? o?.y_height ?? Number.NaN))
            .filter((v) => Number.isFinite(v));
        if (!heights.length) return { fieldValues: [0.001], heightMode: true };
        let minH = Math.min(...heights);
        let maxH = Math.max(...heights);
        if (minH <= 0) {
            minH = 0.001;
            if (maxH < minH) maxH = minH;
        }
        if (minH === maxH) return { fieldValues: [minH], heightMode: true };
        const pts = 10;
        const fieldValues = Array.from({ length: pts }, (_, i) => {
            const t = i / (pts - 1);
            return parseFloat((minH + (maxH - minH) * t).toFixed(6));
        });
        return { fieldValues, heightMode: true };
    }

    let maxAngle = 0;
    for (const o of (Array.isArray(objectRows) ? objectRows : [])) {
        const candidates = [o?.yFieldAngle, o?.yAngle, o?.fieldAngle, o?.xFieldAngle, o?.xAngle, o?.xHeightAngle, o?.yHeightAngle];
        for (const c of candidates) {
            if (typeof c === 'number' && Number.isFinite(c)) {
                maxAngle = Math.max(maxAngle, Math.abs(c));
            }
        }
    }
    if (!(maxAngle > 0)) maxAngle = 20;
    let step = 1;
    if (maxAngle <= 5) step = 0.5;
    else if (maxAngle <= 15) step = 1;
    else if (maxAngle <= 40) step = 2;
    else step = Math.ceil(maxAngle / 25);
    const minAngle = maxAngle * 0.001;
    const fieldValues: number[] = [];
    for (let a = minAngle; a <= maxAngle + 1e-9; a += step) fieldValues.push(parseFloat(a.toFixed(6)));
    if (fieldValues[fieldValues.length - 1] !== maxAngle) fieldValues.push(maxAngle);
    return { fieldValues, heightMode: false };
}

async function runPortableDistortionDataForPopup(payload: {
    wavelengths?: number[];
    onProgress?: (evt: { percent?: number; message?: string }) => void;
}) {
    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    const { fieldValues, heightMode } = deriveDistortionFieldValuesForPopup(objectRows || []);
    const wavelengths = (() => {
        const arr = Array.isArray(payload?.wavelengths)
            ? payload.wavelengths.filter((w) => Number.isFinite(Number(w)) && Number(w) > 0).map((w) => Number(w))
            : [];
        if (arr.length) return arr;
        const fromSource = (Array.isArray(sourceRows) ? sourceRows : [])
            .map((s: any) => Number(s?.wavelength))
            .filter((w: number) => Number.isFinite(w) && w > 0);
        if (fromSource.length) return fromSource;
        const primary = getPrimaryWavelengthMicronsFromSourceRows(sourceRows || []);
        return [Number.isFinite(primary) && primary > 0 ? primary : 0.5876];
    })();

    const allData = [];
    for (let i = 0; i < wavelengths.length; i++) {
        const wl = wavelengths[i];
        const base = (i / Math.max(1, wavelengths.length)) * 100;
        const span = 100 / Math.max(1, wavelengths.length);
        const resp = await runNativeDistortion({
            opticalSystemRows,
            sourceRows,
            objectRows,
            fieldSamples: fieldValues,
            heightMode,
            wavelength: wl,
        });
        allData.push({
            fieldValues: Array.isArray(resp?.fieldValues) ? resp.fieldValues : fieldValues,
            idealHeights: Array.isArray(resp?.idealHeights) ? resp.idealHeights : [],
            realHeights: Array.isArray(resp?.realHeights) ? resp.realHeights : [],
            distortion: Array.isArray(resp?.distortion) ? resp.distortion : [],
            distortionPercent: Array.isArray(resp?.distortionPercent) ? resp.distortionPercent : [],
            meta: { ...(resp?.meta || {}), wavelength: wl, heightMode },
        });
        try {
            payload?.onProgress?.({
                percent: base + span,
                message: `Distortion (λ=${wl.toFixed(4)} μm)`,
            });
        } catch (_) {}
    }
    return { backend: 'portable-distortion', allData };
}

async function runPortableGridDistortionForPopup(payload: {
    gridSize?: number;
    wavelength?: number;
    onProgress?: (evt: { percent?: number; message?: string }) => void;
}) {
    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    const wavelength = Number.isFinite(Number(payload?.wavelength)) && Number(payload?.wavelength) > 0
        ? Number(payload?.wavelength)
        : (() => {
            const primary = getPrimaryWavelengthMicronsFromSourceRows(sourceRows || []);
            return Number.isFinite(primary) && primary > 0 ? primary : 0.5876;
        })();

    const resp = await runNativeGridDistortion({
        opticalSystemRows,
        sourceRows,
        objectRows,
        gridSize: Number.isFinite(Number(payload?.gridSize)) ? Number(payload?.gridSize) : 20,
        wavelength,
    });
    try {
        payload?.onProgress?.({ percent: 100, message: 'Done' });
    } catch (_) {}
    return {
        backend: 'portable-grid-distortion',
        idealGrid: {
            x: Array.isArray(resp?.idealX) ? resp.idealX : [],
            y: Array.isArray(resp?.idealY) ? resp.idealY : [],
        },
        realGrid: {
            x: Array.isArray(resp?.realX) ? resp.realX : [],
            y: Array.isArray(resp?.realY) ? resp.realY : [],
        },
        gridSize: Number.isFinite(Number(resp?.gridSize)) ? Number(resp.gridSize) : 20,
        maxFieldAngle: Number.isFinite(Number(resp?.maxFieldAngle)) ? Number(resp.maxFieldAngle) : 0,
        meta: { ...(resp?.meta || {}), wavelength },
    };
}

w.runPortableDistortionDataForPopup = runPortableDistortionDataForPopup;
w.runPortableGridDistortionForPopup = runPortableGridDistortionForPopup;

async function runDesktopNativeFieldMtfDiagnosticsForPopup(payload: {
    objectIndex?: number;
    pupilSamplingMode?: 'stop' | 'entrance';
    wavelengths?: number[];
    firstFrequencyLpmm?: number;
    secondFrequencyLpmm?: number;
    fieldMin?: number;
    fieldMax?: number;
    steps?: number;
    samplingSize?: number;
    zeroPadTo?: number;
    opdDisplayMode?: string;
    fieldAxisMode?: 'angle' | 'height';
}) {
    const response = await runDesktopNativeFieldMtfForPopup(payload || {});
    const series = Array.isArray((response as any)?.series) ? (response as any).series : [];
    const diagnostics = Array.isArray(series?.[0]?.fieldDiagnostics) ? series[0].fieldDiagnostics : [];

    const discontinuities: any[] = [];
    let modeSwitchAcrossAll = 0;
    let positionSwitchAcrossAll = 0;
    let surfaceSwitchAcrossAll = 0;
    for (let i = 1; i < diagnostics.length; i++) {
        const a: any = diagnostics[i - 1] || {};
        const b: any = diagnostics[i] || {};
        if (String(a.effectivePupilSamplingMode || '') !== String(b.effectivePupilSamplingMode || '')) modeSwitchAcrossAll += 1;
        if (String(a.usedObjectPosition || '') !== String(b.usedObjectPosition || '')) positionSwitchAcrossAll += 1;
        if (Number(a.targetSurfaceIndex) !== Number(b.targetSurfaceIndex)) surfaceSwitchAcrossAll += 1;
        const dM1 = Math.abs(Number(b.firstValueMeridional) - Number(a.firstValueMeridional));
        const dS1 = Math.abs(Number(b.firstValueSagittal) - Number(a.firstValueSagittal));
        const dM2 = Math.abs(Number(b.secondValueMeridional) - Number(a.secondValueMeridional));
        const dS2 = Math.abs(Number(b.secondValueSagittal) - Number(a.secondValueSagittal));

        if ([dM1, dS1, dM2, dS2].some((v) => Number.isFinite(v) && v > 0.12)) {
            discontinuities.push({
                fromField: Number(a.fieldValue),
                toField: Number(b.fieldValue),
                deltaFirstMeridional: dM1,
                deltaFirstSagittal: dS1,
                deltaSecondMeridional: dM2,
                deltaSecondSagittal: dS2,
                opdHitRateFrom: Number(a.opdHitRate),
                opdHitRateTo: Number(b.opdHitRate),
                opdHitRateDelta: Math.abs(Number(b.opdHitRate) - Number(a.opdHitRate)),
                modeFrom: String(a.effectivePupilSamplingMode || ''),
                modeTo: String(b.effectivePupilSamplingMode || ''),
                usedObjectPositionFrom: String(a.usedObjectPosition || ''),
                firstBracketTo: [Number(b.firstBracketLowLpmm), Number(b.firstBracketHighLpmm)],
                secondBracketTo: [Number(b.secondBracketLowLpmm), Number(b.secondBracketHighLpmm)],
                usedObjectPositionTo: String(b.usedObjectPosition || ''),
                targetSurfaceFrom: Number(a.targetSurfaceIndex),
                targetSurfaceTo: Number(b.targetSurfaceIndex),
                usedObjectIndexFrom: Number(a.usedObjectIndex),
                usedObjectIndexTo: Number(b.usedObjectIndex),
            });
        }
    }

    let modeSwitchOnDiscontinuity = 0;
    let positionSwitchOnDiscontinuity = 0;
    let surfaceSwitchOnDiscontinuity = 0;
    let hitRateJumpOnDiscontinuity = 0;
    for (const d of discontinuities) {
        if (String(d.modeFrom || '') !== String(d.modeTo || '')) modeSwitchOnDiscontinuity += 1;
        if (String(d.usedObjectPositionFrom || '') !== String(d.usedObjectPositionTo || '')) positionSwitchOnDiscontinuity += 1;
        if (Number(d.targetSurfaceFrom) !== Number(d.targetSurfaceTo)) surfaceSwitchOnDiscontinuity += 1;
        if (Number.isFinite(Number(d.opdHitRateDelta)) && Number(d.opdHitRateDelta) > 0.03) hitRateJumpOnDiscontinuity += 1;
    }

    const report = {
        conditions: {
            objectIndex: Number.isFinite(Number(payload?.objectIndex)) ? Number(payload?.objectIndex) : 0,
            firstFrequencyLpmm: Number.isFinite(Number(payload?.firstFrequencyLpmm)) ? Number(payload?.firstFrequencyLpmm) : 10,
            secondFrequencyLpmm: Number.isFinite(Number(payload?.secondFrequencyLpmm)) ? Number(payload?.secondFrequencyLpmm) : 30,
            fieldMin: Number.isFinite(Number(payload?.fieldMin)) ? Number(payload?.fieldMin) : 0,
            fieldMax: Number.isFinite(Number(payload?.fieldMax)) ? Number(payload?.fieldMax) : 10,
            steps: Number.isFinite(Number(payload?.steps)) ? Number(payload?.steps) : 21,
            samplingSize: Number.isFinite(Number(payload?.samplingSize)) ? Number(payload?.samplingSize) : 256,
            zeroPadTo: Number.isFinite(Number(payload?.zeroPadTo)) ? Number(payload?.zeroPadTo) : 0,
            opdDisplayMode: String(payload?.opdDisplayMode || 'pistonTiltRemoved'),
            fieldAxisMode: payload?.fieldAxisMode === 'height' ? 'height' : 'angle',
            pupilSamplingMode: payload?.pupilSamplingMode,
        },
        diagnosticsCount: diagnostics.length,
        summary: {
            discontinuityCount: discontinuities.length,
            modeSwitchAcrossAll,
            positionSwitchAcrossAll,
            surfaceSwitchAcrossAll,
            modeSwitchOnDiscontinuity,
            positionSwitchOnDiscontinuity,
            surfaceSwitchOnDiscontinuity,
            hitRateJumpOnDiscontinuity,
        },
        discontinuities,
        diagnostics,
    };

    try {
        console.log('📊 [Object MTF native diagnostics await]', report);
    } catch (_) {}
    return report;
}

w.runDesktopNativeFieldMtfDiagnosticsForPopup = runDesktopNativeFieldMtfDiagnosticsForPopup;

function buildPopupFieldSettingFromObjectRows(objectRows: any[], objectIndex: number, wavelengthUm: number): any {
    const rows = Array.isArray(objectRows) ? objectRows : [];
    const idx = Number.isInteger(objectIndex)
        ? Math.max(0, Math.min(objectIndex, Math.max(0, rows.length - 1)))
        : 0;
    const row = rows[idx] || {};
    const positionRaw = String(row?.position ?? row?.object ?? row?.type ?? '').trim().toLowerCase();
    const isAngle = positionRaw.includes('angle') || positionRaw === 'point';
    if (isAngle) {
        return {
            objectIndex: idx,
            type: 'Angle',
            fieldAngle: {
                x: Number(row?.xHeightAngle ?? row?.xFieldAngle ?? row?.xAngle ?? row?.x ?? 0) || 0,
                y: Number(row?.yHeightAngle ?? row?.yFieldAngle ?? row?.fieldAngle ?? row?.yAngle ?? row?.angle ?? row?.y ?? 0) || 0,
            },
            xHeight: 0,
            yHeight: 0,
            wavelength: Number.isFinite(wavelengthUm) && wavelengthUm > 0 ? wavelengthUm : 0.5876,
        };
    }
    return {
        objectIndex: idx,
        type: 'Height',
        fieldAngle: { x: 0, y: 0 },
        xHeight: Number(row?.xHeight ?? row?.x ?? 0) || 0,
        yHeight: Number(row?.yHeight ?? row?.y ?? row?.height ?? 0) || 0,
        wavelength: Number.isFinite(wavelengthUm) && wavelengthUm > 0 ? wavelengthUm : 0.5876,
    };
}

function summarizeOpdParityDiff(tsGridIn: any, nativeGridIn: any, topK: number = 12): any {
    const tsGrid = Array.isArray(tsGridIn) ? tsGridIn : [];
    const nativeGrid = Array.isArray(nativeGridIn) ? nativeGridIn : [];
    const h = Math.min(tsGrid.length, nativeGrid.length);
    const w = (h > 0)
        ? Math.min(
            Array.isArray(tsGrid[0]) ? tsGrid[0].length : 0,
            Array.isArray(nativeGrid[0]) ? nativeGrid[0].length : 0,
        )
        : 0;

    const diffs: Array<{ x: number; y: number; ts: number; native: number; abs: number }> = [];
    let count = 0;
    let sumAbs = 0;
    let sumSq = 0;
    let maxAbs = 0;
    let sumTs = 0;
    let sumNative = 0;
    let sumTs2 = 0;
    let sumNative2 = 0;
    let sumTsNative = 0;

    for (let y = 0; y < h; y++) {
        const tr = Array.isArray(tsGrid[y]) ? tsGrid[y] : [];
        const nr = Array.isArray(nativeGrid[y]) ? nativeGrid[y] : [];
        for (let x = 0; x < w; x++) {
            const tv = (tr[x] === null || tr[x] === undefined) ? NaN : Number(tr[x]);
            const nv = (nr[x] === null || nr[x] === undefined) ? NaN : Number(nr[x]);
            if (!Number.isFinite(tv) || !Number.isFinite(nv)) continue;
            const abs = Math.abs(tv - nv);
            count += 1;
            sumAbs += abs;
            sumSq += abs * abs;
            if (abs > maxAbs) maxAbs = abs;
            sumTs += tv;
            sumNative += nv;
            sumTs2 += tv * tv;
            sumNative2 += nv * nv;
            sumTsNative += tv * nv;
            diffs.push({ x, y, ts: tv, native: nv, abs });
        }
    }

    const meanTs = count > 0 ? (sumTs / count) : 0;
    const meanNative = count > 0 ? (sumNative / count) : 0;
    const varTs = sumTs2 - (sumTs * sumTs) / Math.max(1, count);
    const varNative = sumNative2 - (sumNative * sumNative) / Math.max(1, count);
    const cov = sumTsNative - (sumTs * sumNative) / Math.max(1, count);
    const slope = (Math.abs(varTs) > 1e-20) ? (cov / varTs) : NaN;
    const intercept = Number.isFinite(slope) ? (meanNative - slope * meanTs) : NaN;
    const corr = (varTs > 1e-20 && varNative > 1e-20)
        ? (cov / Math.sqrt(varTs * varNative))
        : NaN;

    let rmsAfterAffineFit = NaN;
    let rmsAfterNegTs = NaN;
    if (count > 0) {
        let errFitSq = 0;
        let errNegSq = 0;
        for (const d of diffs) {
            if (Number.isFinite(slope) && Number.isFinite(intercept)) {
                const pred = slope * d.ts + intercept;
                const e = d.native - pred;
                errFitSq += e * e;
            }
            const eNeg = d.native - (-d.ts);
            errNegSq += eNeg * eNeg;
        }
        if (Number.isFinite(slope) && Number.isFinite(intercept)) {
            rmsAfterAffineFit = Math.sqrt(errFitSq / count);
        }
        rmsAfterNegTs = Math.sqrt(errNegSq / count);
    }

    diffs.sort((a, b) => b.abs - a.abs);
    return {
        overlap: { width: w, height: h, comparedPointCount: count },
        maxAbsDeltaWaves: maxAbs,
        meanAbsDeltaWaves: count > 0 ? (sumAbs / count) : 0,
        rmsDeltaWaves: count > 0 ? Math.sqrt(sumSq / count) : 0,
        affine: {
            slopeTsToNative: slope,
            interceptTsToNative: intercept,
            correlation: corr,
            rmsAfterAffineFit,
            rmsAfterNegTs,
            meanTs,
            meanNative,
        },
        topDiffs: diffs.slice(0, Math.max(1, Math.floor(topK))).map((d) => ({
            x: d.x,
            y: d.y,
            tsWaves: d.ts,
            nativeWaves: d.native,
            absDeltaWaves: d.abs,
        })),
    };
}

async function runPsfParityInMain(options: any = {}) {
    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        throw new Error('No optical system data');
    }
    if (!Array.isArray(objectRows) || objectRows.length === 0) {
        throw new Error('No object data');
    }

    const requestedObjectIndex = Number.isFinite(Number(options?.objectIndex))
        ? Math.max(0, Math.floor(Number(options.objectIndex)))
        : Math.max(0, objectRows.length - 1);
    const objectIndex = Math.max(0, Math.min(requestedObjectIndex, objectRows.length - 1));
    const gridSize = Math.max(16, Math.floor(Number(options?.gridSize ?? 128)));
    const wavelength = Number.isFinite(Number(options?.wavelengthUm))
        ? Number(options.wavelengthUm)
        : getPrimaryWavelengthMicronsFromSourceRows(sourceRows);
    const zeroPadTo = Number.isFinite(Number(options?.zeroPadTo)) ? Number(options.zeroPadTo) : 0;
    const opdDisplayMode = String(options?.opdDisplayMode || 'pistonTiltRemoved');

    const fieldSetting = buildPopupFieldSettingFromObjectRows(objectRows, objectIndex, wavelength);
    const opdCalculator = createOPDCalculator(opticalSystemRows, wavelength);
    const analyzer = createWavefrontAnalyzer(opdCalculator) as WavefrontAberrationAnalyzer;

    const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', {
        recordRays: false,
        progressEvery: 0,
        renderFromZernike: false,
        skipZernikeFit: true,
        opdMode: 'simple',
        opdDisplayMode,
    });

    if (wavefrontMap && (wavefrontMap as any).error) {
        const msg = String((wavefrontMap as any).error?.message || 'Wavefront map generation failed');
        throw new Error(msg);
    }

    const s = gridSize;
    const opdGrid = Array.from({ length: s }, () => new Float32Array(s));
    const ampGrid = Array.from({ length: s }, () => new Float32Array(s));
    const maskGrid = Array.from({ length: s }, () => Array(s).fill(false));
    const xCoords = new Float32Array(s);
    const yCoords = new Float32Array(s);

    const pupilRange = (Number.isFinite(Number((wavefrontMap as any)?.pupilRange)) && Number((wavefrontMap as any).pupilRange) > 0)
        ? Number((wavefrontMap as any).pupilRange)
        : 1.0;
    for (let i = 0; i < s; i++) {
        const t = (i / (s - 1 || 1)) * 2 - 1;
        xCoords[i] = t * pupilRange;
        yCoords[i] = t * pupilRange;
    }

    const coords = Array.isArray((wavefrontMap as any)?.pupilCoordinates) ? (wavefrontMap as any).pupilCoordinates : [];
    const opdMicrons = ((wavefrontMap as any)?.display && Array.isArray((wavefrontMap as any).display.opds))
        ? (wavefrontMap as any).display.opds
        : (Array.isArray((wavefrontMap as any)?.opds) ? (wavefrontMap as any).opds : []);

    const nSamples = Math.min(coords.length, opdMicrons.length);
    for (let k = 0; k < nSamples; k++) {
        const c = coords[k];
        const ix = Number.isInteger(c?.ix) ? c.ix : null;
        const iy = Number.isInteger(c?.iy) ? c.iy : null;
        if (ix === null || iy === null || ix < 0 || ix >= s || iy < 0 || iy >= s) continue;
        const vMicrons = Number(opdMicrons[k]);
        if (!Number.isFinite(vMicrons)) continue;
        maskGrid[iy][ix] = true;
        opdGrid[iy][ix] = vMicrons;
        ampGrid[iy][ix] = 1.0;
    }

    const opdData = {
        gridSize: s,
        wavelength,
        rayData: [],
        gridData: {
            opd: opdGrid,
            amplitude: ampGrid,
            pupilMask: maskGrid,
            xCoords,
            yCoords,
        },
    };

    const derived = derivePupilAndFocalLengthMmForAiry(opticalSystemRows, wavelength);
    const pupilDiameter = (Number.isFinite(Number(derived?.pupilDiameterMm)) && Number(derived.pupilDiameterMm) > 0)
        ? Number(derived.pupilDiameterMm)
        : 10.0;
    const focalLength = (Number.isFinite(Number(derived?.focalLengthMm)) && Number(derived.focalLengthMm) > 0)
        ? Number(derived.focalLengthMm)
        : 100.0;

    const psfCalculator = new PSFCalculator();
    const baseOpts = {
        samplingSize: s,
        wavelength,
        zeroPadTo,
        pupilDiameter,
        focalLength,
        removeTilt: false,
        recenterIfWrapped: false,
    };

    const nativeResult = await psfCalculator.calculatePSF(opdData, {
        ...baseOpts,
        forceImplementation: isTauriRuntime() ? 'native' : 'javascript',
    });
    const jsResult = await psfCalculator.calculatePSF(opdData, {
        ...baseOpts,
        forceImplementation: 'javascript',
    });

    const nativeGrid = Array.isArray((nativeResult as any)?.psfData) ? (nativeResult as any).psfData : [];
    const jsGrid = Array.isArray((jsResult as any)?.psfData) ? (jsResult as any).psfData : [];
    const h = Math.min(nativeGrid.length, jsGrid.length);
    const width = h > 0 ? Math.min((nativeGrid[0] || []).length, (jsGrid[0] || []).length) : 0;

    let count = 0;
    let sumSq = 0;
    let sumAbs = 0;
    let maxAbs = 0;
    for (let iy = 0; iy < h; iy++) {
        for (let ix = 0; ix < width; ix++) {
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

    const rmsAbs = count > 0 ? Math.sqrt(sumSq / count) : NaN;
    const meanAbs = count > 0 ? (sumAbs / count) : NaN;
    const nMetrics = (nativeResult as any)?.metrics || {};
    const jMetrics = (jsResult as any)?.metrics || {};
    const fwhmNative = Number(nMetrics?.fwhm?.average);
    const fwhmJs = Number(jMetrics?.fwhm?.average);
    const strehlNative = Number(nMetrics?.strehlRatio);
    const strehlJs = Number(jMetrics?.strehlRatio);
    const centerNative = nMetrics?.centerPosition || {};
    const centerJs = jMetrics?.centerPosition || {};

    const parityLine =
        '📊 [PSF Parity][main] native-vs-js ' +
        'grid=' + h + 'x' + width + ' n=' + count + ' ' +
        'rmsAbs=' + (Number.isFinite(rmsAbs) ? rmsAbs.toExponential(4) : 'NaN') + ' ' +
        'meanAbs=' + (Number.isFinite(meanAbs) ? meanAbs.toExponential(4) : 'NaN') + ' ' +
        'maxAbs=' + (Number.isFinite(maxAbs) ? maxAbs.toExponential(4) : 'NaN') + ' ' +
        'strehlΔ=' + (Number.isFinite(strehlNative) && Number.isFinite(strehlJs) ? (strehlNative - strehlJs).toExponential(4) : 'NaN') + ' ' +
        'fwhmAvgΔ=' + (Number.isFinite(fwhmNative) && Number.isFinite(fwhmJs) ? (fwhmNative - fwhmJs).toExponential(4) : 'NaN') + 'µm ' +
        'centerΔ=(' + ((Number(centerNative?.x) - Number(centerJs?.x))) + ',' + ((Number(centerNative?.y) - Number(centerJs?.y))) + ')';

    const paritySummary = {
        objectIndex,
        gridSize: s,
        wavelengthUm: wavelength,
        impl: {
            native: String((nativeResult as any)?.implementationUsed || 'unknown'),
            js: String((jsResult as any)?.implementationUsed || 'unknown'),
        },
        abs: {
            rms: Number.isFinite(rmsAbs) ? rmsAbs : null,
            mean: Number.isFinite(meanAbs) ? meanAbs : null,
            max: Number.isFinite(maxAbs) ? maxAbs : null,
        },
        delta: {
            strehl: Number.isFinite(strehlNative) && Number.isFinite(strehlJs) ? (strehlNative - strehlJs) : null,
            fwhmAvgUm: Number.isFinite(fwhmNative) && Number.isFinite(fwhmJs) ? (fwhmNative - fwhmJs) : null,
            centerX: Number(centerNative?.x) - Number(centerJs?.x),
            centerY: Number(centerNative?.y) - Number(centerJs?.y),
        },
    };

    (globalThis as any).__lastPsfParityLine = parityLine;
    (globalThis as any).__lastPsfParity = paritySummary;
    console.log(parityLine);
    return {
        parityLine,
        parity: paritySummary,
        nativeResult,
        jsResult,
    };
}

w.runPsfParityInMain = runPsfParityInMain;

function transformGridForParity(
    srcIn: Array<Array<number | null>>,
    mode: 'identity' | 'flipX' | 'flipY' | 'flipXY' | 'transpose' | 'transposeFlipX' | 'transposeFlipY' | 'transposeFlipXY',
): Array<Array<number | null>> {
    const src = Array.isArray(srcIn) ? srcIn : [];
    const h = src.length;
    const w = h > 0 && Array.isArray(src[0]) ? src[0].length : 0;
    if (h === 0 || w === 0) return [];

    const get = (x: number, y: number): number | null => {
        const row = src[y];
        return Array.isArray(row) ? (row[x] ?? null) : null;
    };

    const build = (oh: number, ow: number, sample: (x: number, y: number) => number | null) => {
        const out: Array<Array<number | null>> = Array.from({ length: oh }, () => Array.from({ length: ow }, () => null));
        for (let y = 0; y < oh; y++) {
            for (let x = 0; x < ow; x++) {
                out[y][x] = sample(x, y);
            }
        }
        return out;
    };

    switch (mode) {
        case 'identity':
            return build(h, w, (x, y) => get(x, y));
        case 'flipX':
            return build(h, w, (x, y) => get((w - 1) - x, y));
        case 'flipY':
            return build(h, w, (x, y) => get(x, (h - 1) - y));
        case 'flipXY':
            return build(h, w, (x, y) => get((w - 1) - x, (h - 1) - y));
        case 'transpose':
            return build(w, h, (x, y) => get(y, x));
        case 'transposeFlipX':
            return build(w, h, (x, y) => get(y, (h - 1) - x));
        case 'transposeFlipY':
            return build(w, h, (x, y) => get((w - 1) - y, x));
        case 'transposeFlipXY':
            return build(w, h, (x, y) => get((w - 1) - y, (h - 1) - x));
        default:
            return build(h, w, (x, y) => get(x, y));
    }
}

function findBestParityAlignment(
    tsGrid: Array<Array<number | null>>,
    nativeGrid: Array<Array<number | null>>,
    topK: number,
): { alignment: string; summary: any } {
    const modes: Array<'identity' | 'flipX' | 'flipY' | 'flipXY' | 'transpose' | 'transposeFlipX' | 'transposeFlipY' | 'transposeFlipXY'> = [
        'identity',
        'flipX',
        'flipY',
        'flipXY',
        'transpose',
        'transposeFlipX',
        'transposeFlipY',
        'transposeFlipXY',
    ];

    let best = {
        alignment: 'identity',
        summary: summarizeOpdParityDiff(tsGrid, nativeGrid, topK),
    };

    for (const mode of modes) {
        const transformed = transformGridForParity(tsGrid, mode);
        const candidate = summarizeOpdParityDiff(transformed, nativeGrid, topK);
        const cCount = Number(candidate?.overlap?.comparedPointCount || 0);
        const bCount = Number(best?.summary?.overlap?.comparedPointCount || 0);
        const cRms = Number(candidate?.rmsDeltaWaves || Infinity);
        const bRms = Number(best?.summary?.rmsDeltaWaves || Infinity);
        if (cCount > bCount || (cCount === bCount && cRms < bRms)) {
            best = { alignment: mode, summary: candidate };
        }
    }

    return best;
}

function normalizeWavefrontOpdGridWaves(
    wavefrontMap: any,
    gridSize: number,
    wavelengthUm: number,
    mode: 'display' | 'raw' = 'display',
): Array<Array<number | null>> {
    const isNestedGrid = (v: any): boolean => {
        if (!Array.isArray(v) || v.length === 0) return false;
        return Array.isArray(v[0]);
    };

    const cloneNested = (v: any): Array<Array<number | null>> => {
        const src = Array.isArray(v) ? v : [];
        return src.map((row: any) => (Array.isArray(row) ? row.map((x: any) => {
            if (x === null || x === undefined) return null;
            const n = Number(x);
            return Number.isFinite(n) ? n : null;
        }) : []));
    };

    const coords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
    const safeGrid = Number.isFinite(Number(gridSize)) ? Math.max(3, Math.floor(Number(gridSize))) : 129;
    const out: Array<Array<number | null>> = Array.from({ length: safeGrid }, () => Array.from({ length: safeGrid }, () => null));

    const displayWaves = wavefrontMap?.display?.opdsInWavelengths;
    const displayMicrons = wavefrontMap?.display?.opds;
    const rawWaves = wavefrontMap?.raw?.opdsInWavelengths ?? wavefrontMap?.opdsInWavelengths;
    const rawMicrons = wavefrontMap?.raw?.opds ?? wavefrontMap?.opds;

    const primaryWaves = mode === 'raw' ? rawWaves : displayWaves;
    const primaryMicrons = mode === 'raw' ? rawMicrons : displayMicrons;
    const fallbackWaves = mode === 'raw' ? displayWaves : rawWaves;
    const fallbackMicrons = mode === 'raw' ? displayMicrons : rawMicrons;

    if (isNestedGrid(primaryWaves)) return cloneNested(primaryWaves);
    if (isNestedGrid(fallbackWaves)) return cloneNested(fallbackWaves);

    const srcFlat = Array.isArray(primaryWaves)
        ? primaryWaves
        : (Array.isArray(fallbackWaves)
            ? fallbackWaves
            : (Array.isArray(primaryMicrons)
                ? primaryMicrons
                : (Array.isArray(fallbackMicrons) ? fallbackMicrons : [])));
    const srcIsMicrons = !Array.isArray(primaryWaves) && !Array.isArray(fallbackWaves);

    if (!Array.isArray(srcFlat) || srcFlat.length === 0) {
        return out;
    }

    const toWaves = (v: any): number | null => {
        if (v === null || v === undefined) return null;
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        if (srcIsMicrons) {
            if (!Number.isFinite(wavelengthUm) || wavelengthUm <= 0) return null;
            return n / wavelengthUm;
        }
        return n;
    };

    let mapped = 0;
    for (let i = 0; i < srcFlat.length; i++) {
        const coord = coords[i];
        if (!coord || !Number.isFinite(Number(coord?.ix)) || !Number.isFinite(Number(coord?.iy))) {
            continue;
        }
        const ix = Math.floor(Number(coord.ix));
        const iy = Math.floor(Number(coord.iy));
        if (ix < 0 || ix >= safeGrid || iy < 0 || iy >= safeGrid) continue;
        const w = toWaves(srcFlat[i]);
        if (!Number.isFinite(Number(w))) continue;
        out[iy][ix] = Number(w);
        mapped += 1;
    }

    if (mapped > 0) return out;

    const n = Math.min(srcFlat.length, safeGrid * safeGrid);
    for (let idx = 0; idx < n; idx++) {
        const y = Math.floor(idx / safeGrid);
        const x = idx % safeGrid;
        const w = toWaves(srcFlat[idx]);
        if (Number.isFinite(Number(w))) out[y][x] = Number(w);
    }
    return out;
}

async function compareOpdTsVsRustForPopup(payload: {
    objectIndex?: number;
    gridSize?: number;
    wavelengthUm?: number;
    opdDisplayMode?: 'raw' | 'pistonTiltRemoved' | 'pistonTiltDefocusRemoved' | string;
    topK?: number;
} = {}): Promise<any> {
    if (!isTauriRuntime()) {
        throw new Error('Desktop runtime is not available');
    }

    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        throw new Error('compareOpdTsVsRustForPopup: opticalSystemRows is empty');
    }

    const objectIndex = Number.isInteger(payload?.objectIndex) ? Number(payload.objectIndex) : 0;
    const gridSize = Number.isFinite(Number(payload?.gridSize)) ? Math.max(17, Math.floor(Number(payload.gridSize))) : 129;
    const wavelengthUm = Number.isFinite(Number(payload?.wavelengthUm))
        ? Number(payload?.wavelengthUm)
        : getPrimaryWavelengthMicronsFromSourceRows(sourceRows);
    const opdDisplayMode = (payload?.opdDisplayMode as any) || 'pistonTiltRemoved';
    const fieldSetting = buildPopupFieldSettingFromObjectRows(objectRows, objectIndex, wavelengthUm);
    const forcedInfinitePupilMode = __cooptGetForceInfinitePupilMode();
    const autoAngleX = Number(fieldSetting?.fieldAngle?.x ?? 0);
    const autoAngleY = Number(fieldSetting?.fieldAngle?.y ?? 0);
    const isNonZeroAngleField = Math.abs(autoAngleX) > 1e-12 || Math.abs(autoAngleY) > 1e-12;
    const requestedPupilSamplingMode = (forcedInfinitePupilMode === 'stop' || forcedInfinitePupilMode === 'entrance')
        ? forcedInfinitePupilMode
        : ((String(fieldSetting?.type || '').toLowerCase() === 'angle' && isNonZeroAngleField) ? 'entrance' : undefined);

    const opdCalculator = createOPDCalculator(opticalSystemRows, wavelengthUm);
    const jsPupilRadiusMm = Number((opdCalculator as any)?._getCachedStopRadiusMm?.());

    const nativeResult = await runNativeOpdMap({
        opticalSystemRows,
        sourceRows,
        objectRows,
        objectIndex,
        gridSize,
        wavelengthUm,
        pupilRadiusMm: Number.isFinite(jsPupilRadiusMm) && jsPupilRadiusMm > 0 ? jsPupilRadiusMm : undefined,
        pupilSamplingMode: requestedPupilSamplingMode,
        opdDisplayMode,
    });

    const analyzer = createWavefrontAnalyzer(opdCalculator);
    const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', {
        recordRays: false,
        progressEvery: 0,
        renderFromZernike: false,
        skipZernikeFit: true,
        opdMode: 'simple',
        opdDisplayMode,
    });

    const tsGrid = normalizeWavefrontOpdGridWaves(wavefrontMap, gridSize, wavelengthUm, 'display');
    const tsRawGrid = normalizeWavefrontOpdGridWaves(wavefrontMap, gridSize, wavelengthUm, 'raw');
    const nativeGrid = (Array.isArray(nativeResult?.displayOpdGrid)
        ? nativeResult.displayOpdGrid
        : (Array.isArray(nativeResult?.rawOpdGrid) ? nativeResult.rawOpdGrid : [])) as any[];
    const nativeRawGrid = (Array.isArray(nativeResult?.rawOpdGrid)
        ? nativeResult.rawOpdGrid
        : (Array.isArray(nativeResult?.displayOpdGrid) ? nativeResult.displayOpdGrid : [])) as any[];

    const bestDisplay = findBestParityAlignment(tsGrid, nativeGrid, Number(payload?.topK) || 12);
    const bestRaw = findBestParityAlignment(tsRawGrid, nativeRawGrid, Number(payload?.topK) || 12);
    const summary = {
        ...bestDisplay.summary,
        alignment: bestDisplay.alignment,
    };
    const rawSummary = {
        ...bestRaw.summary,
        alignment: bestRaw.alignment,
    };
    const out = {
        config: {
            objectIndex,
            gridSize,
            wavelengthUm,
            opdDisplayMode,
        },
        nativeMeta: {
            backend: nativeResult?.backend,
            targetSurface: nativeResult?.targetSurface,
            stopSurface: nativeResult?.stopSurface,
            usedObjectPosition: nativeResult?.usedObjectPosition,
            usedObjectX: nativeResult?.usedObjectX,
            usedObjectY: nativeResult?.usedObjectY,
            hitCount: nativeResult?.hitCount,
            sampleCount: nativeResult?.sampleCount,
            message: nativeResult?.message,
        },
        rawSummary,
        summary,
    };

    try {
        console.log('📊 [OPD TS-Rust][opener] summary', {
            objectIndex,
            gridSize,
            wavelengthUm,
            mode: opdDisplayMode,
            tsGridShape: {
                h: Array.isArray(tsGrid) ? tsGrid.length : 0,
                w: (Array.isArray(tsGrid) && Array.isArray(tsGrid[0])) ? tsGrid[0].length : 0,
            },
            comparedPointCount: summary?.overlap?.comparedPointCount,
            maxAbsDeltaWaves: summary?.maxAbsDeltaWaves,
            meanAbsDeltaWaves: summary?.meanAbsDeltaWaves,
            rmsDeltaWaves: summary?.rmsDeltaWaves,
            rawComparedPointCount: rawSummary?.overlap?.comparedPointCount,
            rawMaxAbsDeltaWaves: rawSummary?.maxAbsDeltaWaves,
            rawMeanAbsDeltaWaves: rawSummary?.meanAbsDeltaWaves,
            rawRmsDeltaWaves: rawSummary?.rmsDeltaWaves,
            alignment: summary?.alignment,
            rawAlignment: rawSummary?.alignment,
            affineSlopeTsToNative: summary?.affine?.slopeTsToNative,
            affineInterceptTsToNative: summary?.affine?.interceptTsToNative,
            affineCorrelation: summary?.affine?.correlation,
            affineRmsAfterFit: summary?.affine?.rmsAfterAffineFit,
            affineRmsAfterNegTs: summary?.affine?.rmsAfterNegTs,
            rawAffineSlopeTsToNative: rawSummary?.affine?.slopeTsToNative,
            rawAffineInterceptTsToNative: rawSummary?.affine?.interceptTsToNative,
            rawAffineCorrelation: rawSummary?.affine?.correlation,
            rawAffineRmsAfterFit: rawSummary?.affine?.rmsAfterAffineFit,
            rawAffineRmsAfterNegTs: rawSummary?.affine?.rmsAfterNegTs,
            nativeHitCount: nativeResult?.hitCount,
            nativeSampleCount: nativeResult?.sampleCount,
        });
    } catch (_) {}

    try {
        w.__COOPT_LAST_OPD_TS_RUST_DIFF = {
            ...out,
            at: Date.now(),
        };
    } catch (_) {}

    return out;
}

w.compareOpdTsVsRustForPopup = compareOpdTsVsRustForPopup;

function clonePopupOpticalRowsWithDefocusShift(opticalSystemRows: any[], defocusShiftMm?: number): any[] {
    if (!Array.isArray(opticalSystemRows)) return [];
    const shift = Number(defocusShiftMm);
    const cloned = opticalSystemRows.map((row) => (row && typeof row === 'object') ? { ...row } : row);
    if (!Number.isFinite(shift) || Math.abs(shift) < 1e-15) {
        return cloned;
    }

    const imageIdx = cloned.findIndex((row: any) => {
        const objType = String(row?.['object type'] ?? row?.object ?? row?.Object ?? '').trim().toLowerCase();
        return objType === 'image';
    });
    const targetIdx = (imageIdx > 0) ? (imageIdx - 1) : Math.max(0, cloned.length - 2);
    if (targetIdx < 0 || targetIdx >= cloned.length) {
        return cloned;
    }

    const target = (cloned[targetIdx] && typeof cloned[targetIdx] === 'object') ? { ...cloned[targetIdx] } : {};
    const baseThickness = Number((target as any).thickness);
    const safeBaseThickness = Number.isFinite(baseThickness) ? baseThickness : 0;
    (target as any).thickness = safeBaseThickness + shift;
    cloned[targetIdx] = target;
    return cloned;
}

async function runDesktopNativeSpotRaytraceForPopup(payload: {
    surfaceIndex?: number;
    rayCount?: number;
    ringCount?: number;
    pattern?: string;
    wavelengthMode?: string;
    objectRows?: any[];
    defocusMm?: number;
}): Promise<any> {
    const normalizeSpotWavelengthUm = (raw: any): number | null => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n > 10 ? (n / 1000) : n;
    };
    const isPrimarySourceRow = (raw: any): boolean => {
        if (raw === true || raw === 1) return true;
        const s = String(raw ?? '').trim().toLowerCase();
        return s === '1' || s === 'true' || s === 'yes' || s.includes('primary');
    };
    const toSpotObjectLabel = (obj: any, index: number): string => {
        const id = String(obj?.id ?? '').trim();
        if (id) return id;
        const name = String(obj?.name ?? '').trim();
        if (name) return name;
        const pos = String(obj?.position ?? obj?.object ?? '').trim();
        return pos ? (`Object ${index + 1} (${pos})`) : (`Object ${index + 1}`);
    };
    const collectSpotWavelengths = (rows: any[], modeRaw: string | undefined): Array<{ wavelengthUm: number; label: string; color: string; isPrimary: boolean }> => {
        const mode = String(modeRaw || 'all').trim().toLowerCase() === 'primary' ? 'primary' : 'all';
        const palette = ['#2563eb', '#dc2626', '#16a34a', '#7c3aed', '#ea580c', '#0891b2', '#4f46e5', '#0f766e'];
        const picked = (Array.isArray(rows) ? rows : [])
            .map((row, idx) => {
                const wl = normalizeSpotWavelengthUm(row?.wavelength ?? row?.Wavelength);
                if (!Number.isFinite(wl) || wl <= 0) return null;
                return {
                    wavelengthUm: wl,
                    isPrimary: isPrimarySourceRow(row?.primary ?? row?.Primary),
                    name: String(row?.name ?? '').trim(),
                    idx,
                };
            })
            .filter((v): v is { wavelengthUm: number; isPrimary: boolean; name: string; idx: number } => !!v);

        if (picked.length === 0) {
            return [{
                wavelengthUm: 0.5876,
                label: 'Primary 587.6nm',
                color: palette[0],
                isPrimary: true,
            }];
        }

        const dedup: Array<{ wavelengthUm: number; label: string; color: string; isPrimary: boolean }> = [];
        for (let i = 0; i < picked.length; i++) {
            const p = picked[i];
            if (dedup.some((d) => Math.abs(d.wavelengthUm - p.wavelengthUm) < 1e-12)) continue;
            const nm = p.wavelengthUm * 1000;
            const nmText = Number.isFinite(nm) ? nm.toFixed(1) : '587.6';
            dedup.push({
                wavelengthUm: p.wavelengthUm,
                label: p.isPrimary ? (`Primary ${nmText}nm`) : (p.name || `${nmText}nm`),
                color: palette[dedup.length % palette.length],
                isPrimary: p.isPrimary,
            });
        }

        if (mode === 'primary') {
            const primary = dedup.find((d) => d.isPrimary) || dedup[0];
            return primary ? [primary] : [];
        }
        return dedup;
    };

    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    const explicitObjectRows = Array.isArray(payload?.objectRows) ? payload.objectRows : null;
    const effectiveObjectRows = (explicitObjectRows && explicitObjectRows.length > 0) ? explicitObjectRows : objectRows;
    const effectiveOpticalRows = clonePopupOpticalRowsWithDefocusShift(opticalSystemRows, payload?.defocusMm);
    const targetSurfaceIndex = Number.isInteger(payload?.surfaceIndex) ? Number(payload.surfaceIndex) : undefined;
    const tStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    const requestedPattern = payload?.pattern ? String(payload.pattern) : 'annular';
    const airyRadiusUm = computePopupAiryRadiusUm(effectiveOpticalRows, sourceRows);
    const tInvokeStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    const requestBody = {
        opticalSystemRows: effectiveOpticalRows,
        sourceRows,
        objectRows: effectiveObjectRows,
        surfaceIndex: targetSurfaceIndex,
        rayCount: Number.isInteger(payload?.rayCount) ? payload.rayCount : undefined,
        ringCount: Number.isInteger(payload?.ringCount) ? payload.ringCount : undefined,
        pattern: requestedPattern,
        wavelengthMode: payload?.wavelengthMode ? String(payload.wavelengthMode) : undefined,
    } as any;

    try {
        const safePattern = (requestedPattern === 'grid' || requestedPattern === 'annular')
            ? requestedPattern
            : 'annular';
        const rayCount = Number.isInteger(payload?.rayCount) ? Math.max(1, Number(payload?.rayCount)) : 501;
        const ringCount = Number.isInteger(payload?.ringCount) ? Math.max(1, Number(payload?.ringCount)) : 10;
        const wavelengths = collectSpotWavelengths(sourceRows, payload?.wavelengthMode ? String(payload.wavelengthMode) : undefined);
        const raySeries: any[] = [];

        if (Array.isArray(effectiveObjectRows) && effectiveObjectRows.length > 0 && wavelengths.length > 0) {
            for (let objIndex = 0; objIndex < effectiveObjectRows.length; objIndex++) {
                const obj = effectiveObjectRows[objIndex];
                for (let wlIndex = 0; wlIndex < wavelengths.length; wlIndex++) {
                    const wl = wavelengths[wlIndex];
                    const starts = generateRayStartPointsForObject(
                        obj,
                        effectiveOpticalRows,
                        rayCount,
                        null,
                        {
                            annularRingCount: ringCount,
                            wavelengthUm: wl.wavelengthUm,
                            pattern: safePattern,
                        } as any,
                    );
                    const rays = (Array.isArray(starts) ? starts : [])
                        .map((s: any) => ({
                            startP: {
                                x: Number(s?.startP?.x) || 0,
                                y: Number(s?.startP?.y) || 0,
                                z: Number(s?.startP?.z) || 0,
                            },
                            dir: {
                                x: Number(s?.dir?.x) || 0,
                                y: Number(s?.dir?.y) || 0,
                                z: Number(s?.dir?.z) || 1,
                            },
                            wavelengthUm: wl.wavelengthUm,
                            pupilU: Number.isFinite(Number(s?.planeCoords?.u)) ? Number(s.planeCoords.u) : undefined,
                            pupilV: Number.isFinite(Number(s?.planeCoords?.v)) ? Number(s.planeCoords.v) : undefined,
                            isChief: s?.isChief === true || (s?.isChief == null && (s?.rayIndex === 0 || s?.index === 0)),
                        }))
                        .filter((r: any) => Number.isFinite(r.startP.x) && Number.isFinite(r.startP.y) && Number.isFinite(r.startP.z));

                    if (rays.length === 0) continue;
                    raySeries.push({
                        label: `${toSpotObjectLabel(obj, objIndex)} ${wl.label}`,
                        color: wl.color,
                        hasFieldAngle: String(obj?.position ?? obj?.object ?? '').trim().toLowerCase() === 'angle',
                        rays,
                    });
                }
            }
        }

        if (raySeries.length > 0) {
            requestBody.raySeries = raySeries;
        }
    } catch (_) {
        // Fall back to legacy request if explicit raySeries generation fails.
    }

    let result = await runNativeSpotRaytrace(requestBody);

    const selectedSurfaceHasNoHit = (Number(result?.totalHitRays) || 0) <= 0;
    if (selectedSurfaceHasNoHit) {
        const findImageSurfaceIndex = (rows: any[]): number | undefined => {
            if (!Array.isArray(rows) || rows.length === 0) return undefined;
            const normalize = (v: any) => String(v ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i] || {};
                const objectType = normalize(row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? row?.surfType);
                if (objectType === 'image' || objectType.startsWith('image')) {
                    return i;
                }
            }
            for (let i = rows.length - 1; i >= 0; i--) {
                const row = rows[i] || {};
                const objectType = normalize(row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? row?.surfType);
                if (objectType !== 'object' && objectType !== 'gap' && objectType !== 'airgap') {
                    return i;
                }
            }
            return undefined;
        };

        const fallbackSurfaceIndex = findImageSurfaceIndex(effectiveOpticalRows);
        if (Number.isInteger(fallbackSurfaceIndex) && fallbackSurfaceIndex !== targetSurfaceIndex) {
            result = await runNativeSpotRaytrace({
                ...requestBody,
                surfaceIndex: fallbackSurfaceIndex,
            });
            try {
                (result as any).__surfaceIndexRetriedFrom = targetSurfaceIndex;
                (result as any).__surfaceIndexRetriedTo = fallbackSurfaceIndex;
            } catch (_) {}
        }
    }
    const tInvokeEnd = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
    const rustRayGenerationMs = Number(result?.rayGenerationMs);
    const rustTraceMs = Number(result?.traceMs);

    return {
        ...result,
        airyRadiusUm: Number.isFinite(airyRadiusUm) ? airyRadiusUm : undefined,
        timingMs: {
            raySeriesGeneration: Number.isFinite(rustRayGenerationMs) ? rustRayGenerationMs : 0,
            nativeInvoke: Math.max(0, tInvokeEnd - tInvokeStart),
            nativeTrace: Number.isFinite(rustTraceMs) ? rustTraceMs : 0,
            total: Math.max(0, tInvokeEnd - tStart),
        },
    };
}

w.runDesktopNativeSpotRaytraceForPopup = runDesktopNativeSpotRaytraceForPopup;

async function runDesktopNativeSphericalAberrationForPopup(payload: {
    surfaceIndex?: number;
    rayCount?: number;
    referenceFocusMode?: 'primary-paraxial' | 'current-paraxial' | 'chief-ray';
    wavelengthMode?: 'all' | 'primary';
}): Promise<any> {
    const { opticalSystemRows, sourceRows, objectRows } = collectPopupRowsFromMainWindow();
    return runNativeSphericalAberration({
        opticalSystemRows,
        sourceRows,
        objectRows,
        surfaceIndex: Number.isInteger(payload?.surfaceIndex) ? Number(payload.surfaceIndex) : undefined,
        rayCount: Number.isInteger(payload?.rayCount) ? Number(payload.rayCount) : undefined,
        referenceFocusMode: payload?.referenceFocusMode || 'current-paraxial',
        wavelengthMode: payload?.wavelengthMode || 'all',
    });
}

w.runDesktopNativeSphericalAberrationForPopup = runDesktopNativeSphericalAberrationForPopup;

function collectSphericalWavelengthsFromSourceRows(sourceRows: any[]): number[] {
    const normalizeUm = (raw: any): number | null => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n > 10 ? (n / 1000) : n;
    };

    const rows = Array.isArray(sourceRows) ? sourceRows : [];
    const out: number[] = [];
    for (const row of rows) {
        const wl = normalizeUm(row?.wavelength ?? row?.Wavelength);
        if (wl === null || !Number.isFinite(wl) || wl <= 0) continue;
        if (!out.some((v) => Math.abs(v - wl) < 1e-12)) out.push(wl);
        if (out.length >= 6) break;
    }
    return out.length > 0 ? out : [0.5876];
}

function summarizeSphericalParityDiff(tsData: any, rustData: any): any {
    const makeSeriesMap = (series: any[]): Map<string, any> => {
        const map = new Map<string, any>();
        for (const entry of (Array.isArray(series) ? series : [])) {
            const wl = Number(entry?.wavelength);
            if (!Number.isFinite(wl)) continue;
            const key = wl.toFixed(7);
            map.set(key, entry);
        }
        return map;
    };

    const perWavelength: Array<{
        wavelengthUm: number;
        meridionalMaxAbsDeltaMm: number;
        sagittalMaxAbsDeltaMm: number;
        comparedPointCount: number;
    }> = [];

    const compareAxis = (axisName: 'meridional' | 'sagittal', tsSeries: any[], rustSeries: any[]) => {
        const tsMap = makeSeriesMap(tsSeries);
        const rustMap = makeSeriesMap(rustSeries);
        const axisResults: Array<{ wl: number; maxAbs: number; sumAbs: number; count: number }> = [];

        for (const [key, rustEntry] of rustMap.entries()) {
            const tsEntry = tsMap.get(key);
            if (!tsEntry) continue;

            const tsPoints = Array.isArray(tsEntry?.points) ? tsEntry.points : [];
            const rustPoints = Array.isArray(rustEntry?.points) ? rustEntry.points : [];
            if (tsPoints.length === 0 || rustPoints.length === 0) continue;

            const tsByPupil = new Map<string, number>();
            for (const p of tsPoints) {
                const pupil = Number(p?.pupilCoordinate);
                const la = Number(p?.longitudinalAberration);
                if (!Number.isFinite(pupil) || !Number.isFinite(la)) continue;
                tsByPupil.set(pupil.toFixed(6), la);
            }

            let maxAbs = 0;
            let sumAbs = 0;
            let count = 0;
            for (const p of rustPoints) {
                const pupil = Number(p?.pupilCoordinate);
                const laRust = Number(p?.longitudinalAberration);
                if (!Number.isFinite(pupil) || !Number.isFinite(laRust)) continue;
                const laTs = tsByPupil.get(pupil.toFixed(6));
                if (!Number.isFinite(laTs as number)) continue;
                const abs = Math.abs(laRust - (laTs as number));
                maxAbs = Math.max(maxAbs, abs);
                sumAbs += abs;
                count += 1;
            }

            axisResults.push({
                wl: Number(rustEntry?.wavelength),
                maxAbs,
                sumAbs,
                count,
            });
        }

        return axisResults;
    };

    const merResults = compareAxis('meridional', tsData?.meridionalData, rustData?.meridionalData);
    const sagResults = compareAxis('sagittal', tsData?.sagittalData, rustData?.sagittalData);

    const byWl = new Map<number, {
        wavelengthUm: number;
        meridionalMaxAbsDeltaMm: number;
        sagittalMaxAbsDeltaMm: number;
        comparedPointCount: number;
        sumAbs: number;
    }>();

    for (const result of merResults) {
        if (!Number.isFinite(result.wl)) continue;
        const current = byWl.get(result.wl) || {
            wavelengthUm: result.wl,
            meridionalMaxAbsDeltaMm: 0,
            sagittalMaxAbsDeltaMm: 0,
            comparedPointCount: 0,
            sumAbs: 0,
        };
        current.meridionalMaxAbsDeltaMm = Math.max(current.meridionalMaxAbsDeltaMm, result.maxAbs);
        current.comparedPointCount += result.count;
        current.sumAbs += result.sumAbs;
        byWl.set(result.wl, current);
    }
    for (const result of sagResults) {
        if (!Number.isFinite(result.wl)) continue;
        const current = byWl.get(result.wl) || {
            wavelengthUm: result.wl,
            meridionalMaxAbsDeltaMm: 0,
            sagittalMaxAbsDeltaMm: 0,
            comparedPointCount: 0,
            sumAbs: 0,
        };
        current.sagittalMaxAbsDeltaMm = Math.max(current.sagittalMaxAbsDeltaMm, result.maxAbs);
        current.comparedPointCount += result.count;
        current.sumAbs += result.sumAbs;
        byWl.set(result.wl, current);
    }

    let globalMaxAbs = 0;
    let globalSumAbs = 0;
    let globalCount = 0;
    for (const item of byWl.values()) {
        globalMaxAbs = Math.max(globalMaxAbs, item.meridionalMaxAbsDeltaMm, item.sagittalMaxAbsDeltaMm);
        globalSumAbs += item.sumAbs;
        globalCount += item.comparedPointCount;
        perWavelength.push({
            wavelengthUm: item.wavelengthUm,
            meridionalMaxAbsDeltaMm: item.meridionalMaxAbsDeltaMm,
            sagittalMaxAbsDeltaMm: item.sagittalMaxAbsDeltaMm,
            comparedPointCount: item.comparedPointCount,
        });
    }

    perWavelength.sort((a, b) => a.wavelengthUm - b.wavelengthUm);

    return {
        comparedPointCount: globalCount,
        maxAbsDeltaMm: globalMaxAbs,
        meanAbsDeltaMm: globalCount > 0 ? (globalSumAbs / globalCount) : 0,
        largeDeltaThresholdMm: 1e-3,
        hasLargeDelta: globalMaxAbs > 1e-3,
        perWavelength,
    };
}

async function compareSphericalAberrationTsVsRustForPopup(payload: {
    rustResult: any;
    rayCount?: number;
    referenceFocusMode?: 'primary-paraxial' | 'current-paraxial' | 'chief-ray';
    surfaceIndex?: number;
}): Promise<any> {
    const rustResult = payload?.rustResult;
    if (!rustResult || typeof rustResult !== 'object') {
        throw new Error('compareSphericalAberrationTsVsRustForPopup: rustResult is required');
    }

    const { opticalSystemRows, sourceRows } = collectPopupRowsFromMainWindow();
    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) {
        throw new Error('compareSphericalAberrationTsVsRustForPopup: opticalSystemRows is empty');
    }

    const targetSurfaceIndex = Number.isInteger(payload?.surfaceIndex)
        ? Number(payload.surfaceIndex)
        : (opticalSystemRows.length - 1);
    const rayCount = Number.isInteger(payload?.rayCount) ? Number(payload.rayCount) : 51;
    const referenceFocusMode = payload?.referenceFocusMode || 'current-paraxial';
    const wavelengths = collectSphericalWavelengthsFromSourceRows(sourceRows);

    const { calculateLongitudinalAberrationAsync } = await import('../evaluation/aberrations/longitudinal-aberration.ts');
    const tsData = await calculateLongitudinalAberrationAsync(
        opticalSystemRows,
        targetSurfaceIndex,
        wavelengths as any,
        rayCount,
        {
            silent: true,
            referenceFocusMode,
        } as any
    );

    const summary = summarizeSphericalParityDiff(tsData, rustResult);
    try {
        console.log('📊 [SA TS-Rust][opener] summary', {
            comparedPointCount: summary?.comparedPointCount,
            maxAbsDeltaMm: summary?.maxAbsDeltaMm,
            meanAbsDeltaMm: summary?.meanAbsDeltaMm,
            hasLargeDelta: summary?.hasLargeDelta,
        });
    } catch (_) {}
    try {
        w.__COOPT_LAST_SA_TS_RUST_DIFF = {
            ...summary,
            at: Date.now(),
            referenceFocusMode,
            rayCount,
            surfaceIndex: targetSurfaceIndex,
        };
    } catch (_) {}
    return summary;
}

w.compareSphericalAberrationTsVsRustForPopup = compareSphericalAberrationTsVsRustForPopup;

function shouldUseDesktopRustAnalysis(): boolean {
    try {
        if (typeof window !== 'undefined' && (window as any).__COOPT_DISABLE_DESKTOP_RUST_ANALYSIS === true) {
            return false;
        }
        if (typeof window !== 'undefined' && (window as any).__COOPT_FORCE_DESKTOP_RUST_ANALYSIS === true) {
            return true;
        }
    } catch (_) {}
    return true;
}

w.shouldUseDesktopRustAnalysis = shouldUseDesktopRustAnalysis;

// ============================================================================
// GLOBAL CONFIGURATION: FORCE INFINITE PUPIL MODE
// ============================================================================

const __COOPT_FORCE_INFINITE_PUPIL_MODE_KEY = 'coopt.forceInfinitePupilMode';
const __COOPT_FORCE_INFINITE_PUPIL_MODE_EVENT = 'coopt-force-infinite-pupil-mode-changed';

function __cooptSanitizeForcedInfinitePupilMode(v: any): string {
    const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
    return (s === 'stop' || s === 'entrance') ? s : '';
}

function __cooptGetForceInfinitePupilMode(): string {
    try {
        const fromGlobal = w.__COOPT_FORCE_INFINITE_PUPIL_MODE;
        if (fromGlobal) return __cooptSanitizeForcedInfinitePupilMode(fromGlobal);
    } catch (_) {}
    
    try {
        const fromStorage = localStorage.getItem(__COOPT_FORCE_INFINITE_PUPIL_MODE_KEY);
        return __cooptSanitizeForcedInfinitePupilMode(fromStorage);
    } catch (_) {
        return '';
    }
}

function __cooptSetForceInfinitePupilMode(mode: string): void {
    const m = __cooptSanitizeForcedInfinitePupilMode(mode);
    
    try {
        if (m) {
            w.__COOPT_FORCE_INFINITE_PUPIL_MODE = m;
        } else {
            try {
                delete w.__COOPT_FORCE_INFINITE_PUPIL_MODE;
            } catch (_) {
                w.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined;
            }
        }
    } catch (_) {}
    
    try {
        if (m) {
            localStorage.setItem(__COOPT_FORCE_INFINITE_PUPIL_MODE_KEY, m);
        } else {
            localStorage.removeItem(__COOPT_FORCE_INFINITE_PUPIL_MODE_KEY);
        }
    } catch (_) {}
}

function __cooptInitForceInfinitePupilModeFromStorage(): void {
    const mode = __cooptGetForceInfinitePupilMode();
    if (mode) {
        try {
            w.__COOPT_FORCE_INFINITE_PUPIL_MODE = mode;
        } catch (_) {}
    }
}

function __cooptInstallDesktopForceInfinitePupilModeBridge(): void {
    if (!isTauriRuntime()) return;
    if (w.__cooptForceInfinitePupilModeBridgeInstalled) return;
    w.__cooptForceInfinitePupilModeBridgeInstalled = true;

    w.__cooptBroadcastForceInfinitePupilMode = (mode: any) => {
        const m = __cooptSanitizeForcedInfinitePupilMode(mode);
        __cooptSetForceInfinitePupilMode(m);
        (async () => {
            try {
                const mod = await import('@tauri-apps/api/event');
                if (mod && typeof (mod as any).emit === 'function') {
                    await (mod as any).emit(__COOPT_FORCE_INFINITE_PUPIL_MODE_EVENT, { mode: m });
                }
                if (mod && typeof (mod as any).emitTo === 'function') {
                    try { await (mod as any).emitTo('main', __COOPT_FORCE_INFINITE_PUPIL_MODE_EVENT, { mode: m }); } catch (_) {}
                    try { await (mod as any).emitTo('settings-window', __COOPT_FORCE_INFINITE_PUPIL_MODE_EVENT, { mode: m }); } catch (_) {}
                }
            } catch (_) {}
        })();
    };

    (async () => {
        try {
            const mod = await import('@tauri-apps/api/event');
            if (!mod || typeof (mod as any).listen !== 'function') return;
            const unlisten = await (mod as any).listen(__COOPT_FORCE_INFINITE_PUPIL_MODE_EVENT, (event: any) => {
                const m = __cooptSanitizeForcedInfinitePupilMode(event?.payload?.mode);
                __cooptSetForceInfinitePupilMode(m);
            });
            w.__cooptForceInfinitePupilModeBridgeUnlisten = unlisten;
        } catch (_) {}
    })();
}

// Expose globally for Settings popup
w.__cooptGetForceInfinitePupilMode = __cooptGetForceInfinitePupilMode;
w.__cooptSetForceInfinitePupilMode = __cooptSetForceInfinitePupilMode;

// Initialize on load
__cooptInitForceInfinitePupilModeFromStorage();
__cooptInstallDesktopForceInfinitePupilModeBridge();

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getRequiredFunctions(): any {
    return {
        getOpticalSystemRows: w.getOpticalSystemRows || (() => []),
        getObjectRows: w.getObjectRows || (() => []),
        generateCrossBeam: w.generateCrossBeam || (() => ({ results: [] })),
        generateInfiniteSystemCrossBeam: w.generateInfiniteSystemCrossBeam || (() => ({ results: [] })),
        drawOpticalSystemSurfaces: w.drawOpticalSystemSurfaces || (() => {}),
        drawCrossBeamRays: w.drawCrossBeamRays || (() => {}),
        harmonizeSceneGeometry: w.harmonizeSceneGeometry || (() => {}),
        clearAllOpticalElements: w.clearAllOpticalElements || (() => {})
    };
}

const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';

function __coopt_isPlainObject(v: any): boolean {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function __coopt_parseColorToInt(value: any): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (/^0x[0-9a-fA-F]{6}$/.test(s)) return parseInt(s.slice(2), 16);
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return parseInt(s.slice(1), 16);
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

function __coopt_surfaceColorKey(surface: any, index0: number): string {
    try {
        const bid = String(surface?._blockId ?? '').trim();
        const role = String(surface?._surfaceRole ?? '').trim();
        if (bid && role) return `p:${bid}|${role}`;
    } catch (_) {}

    try {
        const sid = Number(surface?.id);
        if (Number.isFinite(sid)) return `id:${Math.floor(sid)}`;
    } catch (_) {}

    return `i:${Math.floor(Number(index0) || 0)}`;
}

function __coopt_isCoordBreakSurface(surface: any): boolean {
    const surfType = String(surface?.surfType || surface?.type || '').trim().toLowerCase();
    const objType = String(surface?.['object type'] || '').trim().toLowerCase();
    return (
        surfType === 'coord break' || surfType === 'coordinate break' ||
        surfType === 'cb' || surfType === 'coordtrans' ||
        surfType === 'coordinatebreak' || surfType === 'coord trans' ||
        surfType === 'coordinate transform' || surfType === 'ct' ||
        objType === 'coord break' || objType === 'coordinate break' ||
        objType === 'cb' || objType === 'coordtrans' ||
        objType === 'coordinatebreak'
    );
}

function __coopt_isGapSurface(surface: any): boolean {
    const blockType = String(surface?._blockType ?? surface?.blockType ?? '').trim().toLowerCase();
    if (blockType === 'gap' || blockType === 'airgap') return true;

    const objType = String(surface?.['object type'] ?? surface?.type ?? '').trim().toLowerCase();
    if (
        objType === 'gap' ||
        objType === 'air gap' ||
        objType === 'airgap'
    ) {
        return true;
    }

    const role = String(surface?._surfaceRole ?? '').trim().toLowerCase();
    if (role === 'gap' || role === 'airgap') return true;

    return false;
}

function __coopt_isGlassMaterial(materialValue: any): boolean {
    const material = String(materialValue ?? '').trim().toUpperCase();
    if (!material) return false;
    if (material === 'AIR' || material === '0' || material === 'MIRROR') return false;
    return true;
}

function __coopt_hasLensTag(surface: any): boolean {
    const blockType = String(surface?._blockType ?? surface?.blockType ?? '').trim().toLowerCase();
    const surfaceRole = String(surface?._surfaceRole ?? surface?.surfaceRole ?? '').trim().toLowerCase();
    if (blockType === 'lens' || blockType === 'glass' || blockType === 'element') return true;
    if (surfaceRole === 'lens' || surfaceRole === 'front' || surfaceRole === 'back') return true;
    return false;
}

function __coopt_isLensInterval(frontSurface: any, backSurface: any): boolean {
    if (!frontSurface || !backSurface) return false;
    if ((frontSurface['object type'] || '') === 'Object') return false;
    if (__coopt_isGapSurface(frontSurface) || __coopt_isGapSurface(backSurface)) return false;
    if (__coopt_isCoordBreakSurface(frontSurface) || __coopt_isCoordBreakSurface(backSurface)) return false;

    const frontIsGlass = __coopt_isGlassMaterial(frontSurface.material);
    const backIsGlass = __coopt_isGlassMaterial(backSurface.material);
    const frontHasLensTag = __coopt_hasLensTag(frontSurface);
    const backHasLensTag = __coopt_hasLensTag(backSurface);
    return frontIsGlass || backIsGlass || frontHasLensTag || backHasLensTag;
}

function __coopt_getSurfaceSemidiaMm(surface: any): number | null {
    const candidates: Array<{ value: any; isDiameter: boolean }> = [
        { value: surface?.semidia, isDiameter: false },
        { value: surface?.semiDiameter, isDiameter: false },
        { value: surface?.['semi-diameter'], isDiameter: false },
        { value: surface?.semi_diameter, isDiameter: false },
        { value: surface?.clearAperture, isDiameter: false },
        { value: surface?.Clear_Aperture, isDiameter: false },
        { value: surface?.diameter, isDiameter: true }
    ];
    for (const candidate of candidates) {
        const value = candidate.value;
        const n = Number(value);
        const parsed = Number.isFinite(n) ? n : parseFloat(String(value ?? ''));
        const resolved = Number.isFinite(parsed) ? parsed : NaN;
        if (Number.isFinite(resolved) && resolved > 0) {
            if (candidate.isDiameter) return resolved * 0.5;
            return resolved;
        }
    }
    return null;
}

function __coopt_isObjectSurface(surface: any): boolean {
    const objectType = String(surface?.['object type'] ?? surface?.type ?? '').trim().toLowerCase();
    return objectType === 'object';
}

function __coopt_isRenderableLensCandidateSurface(surface: any): boolean {
    if (!surface) return false;
    if (__coopt_isObjectSurface(surface)) return false;
    if (__coopt_isGapSurface(surface)) return false;
    if (__coopt_isCoordBreakSurface(surface)) return false;
    return true;
}

function __coopt_buildApproxSurfaceOrigins(rows: any[]): Array<{ origin: { x: number; y: number; z: number } }> {
    const out: Array<{ origin: { x: number; y: number; z: number } }> = [];
    if (!Array.isArray(rows) || rows.length === 0) return out;
    let z = 0;
    for (let i = 0; i < rows.length; i++) {
        out.push({ origin: { x: 0, y: 0, z } });
        const thicknessRaw = rows[i]?.thickness;
        const thickness = Number.isFinite(Number(thicknessRaw)) ? Number(thicknessRaw) : parseFloat(String(thicknessRaw ?? ''));
        if (Number.isFinite(thickness)) {
            z += thickness;
        }
    }
    return out;
}

function __coopt_loadSurfaceColorOverridesSafe(): Record<string, any> {
    try {
        if (typeof localStorage === 'undefined') return {};
        const raw = localStorage.getItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return __coopt_isPlainObject(parsed) ? parsed : {};
    } catch (_) {
        return {};
    }
}

function __coopt_clearPopupLensFillMeshes(scene: any): void {
    if (!scene) return;
    const toRemove: any[] = [];
    scene.traverse((child: any) => {
        if (child?.userData?.type === 'popupLensFill') {
            toRemove.push(child);
        }
    });
    [...new Set(toRemove)].forEach((obj: any) => {
        scene.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
            else obj.material.dispose();
        }
    });
}

function __coopt_readWorldPolylinePoints(lineObj: any, THREE: any): any[] {
    if (!lineObj || !lineObj.geometry || !lineObj.geometry.attributes?.position || !THREE) return [];
    const attr = lineObj.geometry.attributes.position;
    const points: any[] = [];
    for (let i = 0; i < attr.count; i++) {
        const p = new THREE.Vector3(attr.getX(i), attr.getY(i), attr.getZ(i));
        lineObj.localToWorld(p);
        if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
            points.push(p);
        }
    }
    return points;
}

function __coopt_orientPolyline(points: any[], startRef: any, endRef: any): any[] {
    if (!Array.isArray(points) || points.length < 2 || !startRef || !endRef) return points || [];
    const d1 = points[0].distanceTo(startRef) + points[points.length - 1].distanceTo(endRef);
    const d2 = points[0].distanceTo(endRef) + points[points.length - 1].distanceTo(startRef);
    return d1 <= d2 ? points.slice() : points.slice().reverse();
}

function __coopt_addUltraDebugCrossOverlay(scene: any, THREE: any, viewAxis: 'XZ' | 'YZ'): void {
    if (!scene || !THREE) return;

    const size = 100000;
    const ortho = 0;

    const positions = new Float32Array(12);
    if (viewAxis === 'YZ') {
        positions.set([
            ortho, -size, -size,
            ortho, size, -size,
            ortho, -size, size,
            ortho, size, size
        ]);
    } else {
        positions.set([
            -size, ortho, -size,
            size, ortho, -size,
            -size, ortho, size,
            size, ortho, size
        ]);
    }

    const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);
    const meshGeometry = new THREE.BufferGeometry();
    meshGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    meshGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    meshGeometry.computeVertexNormals();

    const meshMaterial = new THREE.MeshBasicMaterial({
        color: 0xff00ff,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
    });

    const mesh = new THREE.Mesh(meshGeometry, meshMaterial);
    mesh.frustumCulled = false;
    mesh.renderOrder = 60000;
    mesh.userData = {
        type: 'popupLensFill',
        viewAxis,
        surfaceIndex: -999,
        isOpticalElement: true,
        isUltraDebugOverlay: true
    };
    scene.add(mesh);

    const guidePoints = viewAxis === 'YZ'
        ? [new THREE.Vector3(0, -size, 0), new THREE.Vector3(0, size, 0), new THREE.Vector3(0, 0, -size), new THREE.Vector3(0, 0, size)]
        : [new THREE.Vector3(-size, 0, 0), new THREE.Vector3(size, 0, 0), new THREE.Vector3(0, 0, -size), new THREE.Vector3(0, 0, size)];

    const lineGeometryA = new THREE.BufferGeometry().setFromPoints([guidePoints[0], guidePoints[1]]);
    const lineGeometryB = new THREE.BufferGeometry().setFromPoints([guidePoints[2], guidePoints[3]]);
    const lineMaterial = new THREE.LineBasicMaterial({
        color: 0xffff00,
        transparent: true,
        opacity: 1.0,
        depthTest: false,
        depthWrite: false
    });
    const lineA = new THREE.Line(lineGeometryA, lineMaterial.clone());
    const lineB = new THREE.Line(lineGeometryB, lineMaterial.clone());
    lineA.renderOrder = 60010;
    lineB.renderOrder = 60010;
    lineA.frustumCulled = false;
    lineB.frustumCulled = false;
    lineA.userData = { type: 'popupLensFill', isUltraDebugOverlay: true, isOpticalElement: true };
    lineB.userData = { type: 'popupLensFill', isUltraDebugOverlay: true, isOpticalElement: true };
    scene.add(lineA);
    scene.add(lineB);
}

function __coopt_getFillDebugStatusSuffix(viewAxis?: 'XZ' | 'YZ'): string {
    return '';
}

function __coopt_setPopupStatusWithFillDebug(popupWindow: any, baseStatus: string, viewAxis: 'XZ' | 'YZ'): void {
    const suffix = __coopt_getFillDebugStatusSuffix(viewAxis);
    const statusText = `${baseStatus}${suffix}`;
    try {
        const popupStatus = popupWindow?.document?.getElementById?.('status');
        if (popupStatus) popupStatus.textContent = statusText;
    } catch (_) {}
    try {
        popupWindow?.postMessage?.({ status: statusText }, '*');
    } catch (_) {}
}

function __coopt_applyPopupCrossSectionLensFill(options: {
    popupWindow: any;
    scene: any;
    viewAxis: 'XZ' | 'YZ';
    opticalSystemRows: any[];
    source?: string;
}): void {
    // Keep cross-section rendering clean in popup windows: no debug fill overlays.
    return;

    const { popupWindow, scene, viewAxis, opticalSystemRows, source = 'unknown' } = options;
    if (!scene || !Array.isArray(opticalSystemRows) || opticalSystemRows.length < 2) return;

    const THREE = popupWindow?.THREE || w.THREE || THREE_NS;
    if (!THREE) return;

    const FORCE_DEBUG_FILL = true;

    __coopt_clearPopupLensFillMeshes(scene);

    const activeProfileMap = new Map<number, any>();
    const activeConnectionMap = new Map<number, any[]>();

    scene.traverse((child: any) => {
        const ud = child?.userData || {};

        if (ud.type === 'surfaceProfile' && (ud.profileType === 'XZ' || ud.profileType === 'YZ')) {
            const si = Number(ud.surfaceIndex);
            const row = Number.isFinite(si) ? opticalSystemRows[si - 1] : null;
            if (row && __coopt_isGapSurface(row)) {
                child.visible = false;
                return;
            }

            // Always show both YZ and XZ profiles (crosshair lines)
            child.visible = true;
            const isActive = ud.profileType === viewAxis;
            if (isActive) {
                if (Number.isFinite(si)) {
                    activeProfileMap.set(si, child);
                }
            }
            return;
        }

        if (ud.type === 'connectionLine' && (ud.direction === 'XZ' || ud.direction === 'YZ')) {
            const si = Number(ud.surfaceIndex);
            const frontRow = Number.isFinite(si) ? opticalSystemRows[si - 1] : null;
            if (frontRow && __coopt_isGapSurface(frontRow)) {
                child.visible = false;
                return;
            }

            // Always show both YZ and XZ connection lines
            child.visible = true;
            const isActive = ud.direction === viewAxis;
            if (isActive) {
                if (Number.isFinite(si)) {
                    if (!activeConnectionMap.has(si)) activeConnectionMap.set(si, []);
                    activeConnectionMap.get(si)!.push(child);
                }
            }
            return;
        }

        if (ud.isRayLine || ud.type === 'ray') {
            child.renderOrder = Math.max(Number(child.renderOrder) || 0, 1300);
            if (child.material) {
                const materials = Array.isArray(child.material) ? child.material : [child.material];
                materials.forEach((mat: any) => {
                    if (mat) {
                        mat.depthTest = false;
                        mat.depthWrite = false;
                        mat.transparent = true;
                    }
                });
            }
        }
    });

    const overrides = __coopt_loadSurfaceColorOverridesSafe();
    const surfaceOrigins = (() => {
        try {
            const exact = calculateSurfaceOrigins(opticalSystemRows);
            if (Array.isArray(exact) && exact.length > 0) return exact;
            return __coopt_buildApproxSurfaceOrigins(opticalSystemRows);
        } catch (_) {
            return __coopt_buildApproxSurfaceOrigins(opticalSystemRows);
        }
    })();
    const axisCoord = (p: any) => (viewAxis === 'YZ' ? p.y : p.x);

    const strictIntervalIndices: number[] = [];
    for (let i = 0; i < opticalSystemRows.length - 1; i++) {
        const frontSurface = opticalSystemRows[i];
        const backSurface = opticalSystemRows[i + 1];
        if (__coopt_isLensInterval(frontSurface, backSurface)) {
            strictIntervalIndices.push(i);
        }
    }

    const fallbackIntervalIndices: number[] = [];
    if (strictIntervalIndices.length === 0) {
        console.warn('[RenderWindow] Lens fill strict interval detection matched 0 pairs. Falling back to geometry-based adjacent pairing.');
        for (let i = 0; i < opticalSystemRows.length - 1; i++) {
            const frontSurface = opticalSystemRows[i];
            const backSurface = opticalSystemRows[i + 1];
            if (!__coopt_isRenderableLensCandidateSurface(frontSurface) || !__coopt_isRenderableLensCandidateSurface(backSurface)) {
                continue;
            }
            const sd1 = __coopt_getSurfaceSemidiaMm(frontSurface);
            const sd2 = __coopt_getSurfaceSemidiaMm(backSurface);
            if (Number.isFinite(sd1) && Number.isFinite(sd2) && (sd1 as number) > 0 && (sd2 as number) > 0) {
                fallbackIntervalIndices.push(i);
            }
        }
    }

    const intervalIndices = strictIntervalIndices.length > 0 ? strictIntervalIndices : fallbackIntervalIndices;

    let createdMeshCount = 0;

    for (const i of intervalIndices) {
        const frontSurface = opticalSystemRows[i];
        const backSurface = opticalSystemRows[i + 1];

        const frontSurfaceIndex = i + 1;
        const backSurfaceIndex = i + 2;

        const frontLine = activeProfileMap.get(frontSurfaceIndex);
        const backLine = activeProfileMap.get(backSurfaceIndex);
        const sideLines = activeConnectionMap.get(frontSurfaceIndex) || [];

        let frontPoints = frontLine ? __coopt_readWorldPolylinePoints(frontLine, THREE) : [];
        let backPoints = backLine ? __coopt_readWorldPolylinePoints(backLine, THREE) : [];

        if (frontPoints.length < 2 || backPoints.length < 2) {
            const o1 = surfaceOrigins?.[i]?.origin;
            const o2 = surfaceOrigins?.[i + 1]?.origin;
            const sd1 = __coopt_getSurfaceSemidiaMm(frontSurface);
            const sd2 = __coopt_getSurfaceSemidiaMm(backSurface);
            if (o1 && o2 && Number.isFinite(sd1) && Number.isFinite(sd2) && sd1! > 0 && sd2! > 0) {
                if (viewAxis === 'YZ') {
                    frontPoints = [
                        new THREE.Vector3(Number(o1.x) || 0, -sd1!, Number(o1.z) || 0),
                        new THREE.Vector3(Number(o1.x) || 0, sd1!, Number(o1.z) || 0)
                    ];
                    backPoints = [
                        new THREE.Vector3(Number(o2.x) || 0, -sd2!, Number(o2.z) || 0),
                        new THREE.Vector3(Number(o2.x) || 0, sd2!, Number(o2.z) || 0)
                    ];
                } else {
                    frontPoints = [
                        new THREE.Vector3(-sd1!, Number(o1.y) || 0, Number(o1.z) || 0),
                        new THREE.Vector3(sd1!, Number(o1.y) || 0, Number(o1.z) || 0)
                    ];
                    backPoints = [
                        new THREE.Vector3(-sd2!, Number(o2.y) || 0, Number(o2.z) || 0),
                        new THREE.Vector3(sd2!, Number(o2.y) || 0, Number(o2.z) || 0)
                    ];
                }
            }
        }
        if (frontPoints.length < 2 || backPoints.length < 2) continue;

        const boundary3D: any[] = [];
        const sideCandidates = sideLines
            .map((lineObj: any) => {
                const pts = __coopt_readWorldPolylinePoints(lineObj, THREE);
                if (pts.length < 2) return null;
                const avg = pts.reduce((sum: number, p: any) => sum + axisCoord(p), 0) / pts.length;
                return { pts, avg };
            })
            .filter(Boolean)
            .sort((a: any, b: any) => a.avg - b.avg);

        if (sideCandidates.length >= 2) {
            const negSideRaw = sideCandidates[0].pts;
            const posSideRaw = sideCandidates[sideCandidates.length - 1].pts;

            const frontNeg = frontPoints[0];
            const frontPos = frontPoints[frontPoints.length - 1];
            const backNeg = backPoints[0];
            const backPos = backPoints[backPoints.length - 1];

            const posSide = __coopt_orientPolyline(posSideRaw, frontPos, backPos);
            const negSide = __coopt_orientPolyline(negSideRaw, backNeg, frontNeg);

            boundary3D.push(...frontPoints);
            boundary3D.push(...posSide.slice(1));
            boundary3D.push(...backPoints.slice().reverse().slice(1));
            boundary3D.push(...negSide.slice(1));
        } else {
            const frontStart = frontPoints[0];
            const frontEnd = frontPoints[frontPoints.length - 1];
            const backStart = backPoints[0];
            const backEnd = backPoints[backPoints.length - 1];

            const forwardCost = frontStart.distanceToSquared(backStart) + frontEnd.distanceToSquared(backEnd);
            const reverseCost = frontStart.distanceToSquared(backEnd) + frontEnd.distanceToSquared(backStart);
            const alignedBack = (forwardCost <= reverseCost) ? backPoints.slice() : backPoints.slice().reverse();

            boundary3D.push(...frontPoints);
            boundary3D.push(...alignedBack.slice().reverse().slice(1));
        }

        const frontStart = frontPoints[0];
        const frontEnd = frontPoints[frontPoints.length - 1];
        const backStart = backPoints[0];
        const backEnd = backPoints[backPoints.length - 1];

        const forwardCost = frontStart.distanceToSquared(backStart) + frontEnd.distanceToSquared(backEnd);
        const reverseCost = frontStart.distanceToSquared(backEnd) + frontEnd.distanceToSquared(backStart);
        const alignedBack = (forwardCost <= reverseCost) ? backPoints.slice() : backPoints.slice().reverse();

        const sampleCount = Math.max(2, Math.min(frontPoints.length, alignedBack.length));
        const samplePolyline = (pts: any[], count: number): any[] => {
            if (!Array.isArray(pts) || pts.length === 0 || count < 2) return [];
            const out: any[] = [];
            for (let s = 0; s < count; s++) {
                const t = s / (count - 1);
                const idx = Math.round(t * (pts.length - 1));
                const p = pts[Math.max(0, Math.min(idx, pts.length - 1))];
                if (Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z)) {
                    out.push(p.clone());
                }
            }
            return out;
        };

        const sampledFront = samplePolyline(frontPoints, sampleCount);
        const sampledBack = samplePolyline(alignedBack, sampleCount);
        if (sampledFront.length < 2 || sampledBack.length < 2 || sampledFront.length !== sampledBack.length) continue;

        const vertexCount = sampledFront.length * 2;
        const positions = new Float32Array(vertexCount * 3);
        for (let j = 0; j < sampledFront.length; j++) {
            const f = sampledFront[j];
            const b = sampledBack[j];
            const fi = j * 2;
            const bi = fi + 1;
            positions[fi * 3] = f.x;
            positions[fi * 3 + 1] = f.y;
            positions[fi * 3 + 2] = f.z;
            positions[bi * 3] = b.x;
            positions[bi * 3 + 1] = b.y;
            positions[bi * 3 + 2] = b.z;
        }

        const flatIndices: number[] = [];
        for (let j = 0; j < sampledFront.length - 1; j++) {
            const a = j * 2;
            const b = a + 1;
            const c = a + 2;
            const d = a + 3;
            flatIndices.push(a, b, c);
            flatIndices.push(b, d, c);
        }
        if (flatIndices.length < 3) continue;

        const indexArray = (vertexCount > 65535)
            ? new Uint32Array(flatIndices)
            : new Uint16Array(flatIndices);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));
        geometry.computeVertexNormals();

        const key = __coopt_surfaceColorKey(frontSurface, i);
        const colorOverride = __coopt_parseColorToInt(overrides?.[key]);
        const isWhiteLike = (value: number | null): boolean => {
            if (value === null || !Number.isFinite(value)) return false;
            const r = (value >> 16) & 0xff;
            const g = (value >> 8) & 0xff;
            const b = value & 0xff;
            return r >= 245 && g >= 245 && b >= 245;
        };
        const lensColor = (colorOverride !== null && !isWhiteLike(colorOverride)) ? colorOverride : 0x00ccff;

        const material = new THREE.MeshBasicMaterial(
            FORCE_DEBUG_FILL
                ? {
                    color: 0xff00ff,
                    transparent: true,
                    opacity: 1.0,
                    side: THREE.DoubleSide,
                    depthTest: false,
                    depthWrite: false
                }
                : {
                    color: lensColor,
                    transparent: true,
                    opacity: 0.72,
                    side: THREE.DoubleSide,
                    depthTest: false,
                    depthWrite: false
                }
        );

        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        mesh.renderOrder = FORCE_DEBUG_FILL ? 50000 : 1400;
        mesh.userData = {
            type: 'popupLensFill',
            viewAxis,
            surfaceIndex: frontSurfaceIndex,
            isOpticalElement: true
        };
        scene.add(mesh);
        createdMeshCount += 1;
    }

    if (FORCE_DEBUG_FILL && createdMeshCount === 0) {
        const fallbackPoints: any[] = [];

        activeProfileMap.forEach((lineObj: any) => {
            const pts = __coopt_readWorldPolylinePoints(lineObj, THREE);
            if (pts.length > 0) fallbackPoints.push(...pts);
        });

        if (fallbackPoints.length < 2) {
            for (let i = 0; i < opticalSystemRows.length; i++) {
                const row = opticalSystemRows[i];
                if (!__coopt_isRenderableLensCandidateSurface(row)) continue;
                const o = surfaceOrigins?.[i]?.origin;
                const sd = __coopt_getSurfaceSemidiaMm(row);
                if (!o || !Number.isFinite(sd) || (sd as number) <= 0) continue;
                if (viewAxis === 'YZ') {
                    fallbackPoints.push(
                        new THREE.Vector3(Number(o.x) || 0, -(sd as number), Number(o.z) || 0),
                        new THREE.Vector3(Number(o.x) || 0, (sd as number), Number(o.z) || 0)
                    );
                } else {
                    fallbackPoints.push(
                        new THREE.Vector3(-(sd as number), Number(o.y) || 0, Number(o.z) || 0),
                        new THREE.Vector3((sd as number), Number(o.y) || 0, Number(o.z) || 0)
                    );
                }
            }
        }

        if (fallbackPoints.length >= 2) {
            let minZ = Infinity;
            let maxZ = -Infinity;
            let minAxis = Infinity;
            let maxAxis = -Infinity;
            let fixedOrth = 0;

            fallbackPoints.forEach((p: any) => {
                minZ = Math.min(minZ, Number(p.z));
                maxZ = Math.max(maxZ, Number(p.z));
                if (viewAxis === 'YZ') {
                    minAxis = Math.min(minAxis, Number(p.y));
                    maxAxis = Math.max(maxAxis, Number(p.y));
                    fixedOrth = Number.isFinite(Number(p.x)) ? Number(p.x) : fixedOrth;
                } else {
                    minAxis = Math.min(minAxis, Number(p.x));
                    maxAxis = Math.max(maxAxis, Number(p.x));
                    fixedOrth = Number.isFinite(Number(p.y)) ? Number(p.y) : fixedOrth;
                }
            });

            if (Number.isFinite(minZ) && Number.isFinite(maxZ) && Number.isFinite(minAxis) && Number.isFinite(maxAxis)) {
                const zPad = Math.max(0.1, (maxZ - minZ) * 0.01);
                const aPad = Math.max(0.1, (maxAxis - minAxis) * 0.01);
                minZ -= zPad;
                maxZ += zPad;
                minAxis -= aPad;
                maxAxis += aPad;

                const positions = new Float32Array(12);
                if (viewAxis === 'YZ') {
                    positions.set([
                        fixedOrth, minAxis, minZ,
                        fixedOrth, maxAxis, minZ,
                        fixedOrth, minAxis, maxZ,
                        fixedOrth, maxAxis, maxZ
                    ]);
                } else {
                    positions.set([
                        minAxis, fixedOrth, minZ,
                        maxAxis, fixedOrth, minZ,
                        minAxis, fixedOrth, maxZ,
                        maxAxis, fixedOrth, maxZ
                    ]);
                }

                const indices = new Uint16Array([0, 1, 2, 1, 3, 2]);
                const geometry = new THREE.BufferGeometry();
                geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
                geometry.setIndex(new THREE.BufferAttribute(indices, 1));
                geometry.computeVertexNormals();

                const material = new THREE.MeshBasicMaterial({
                    color: 0xff00ff,
                    transparent: true,
                    opacity: 0.95,
                    side: THREE.DoubleSide,
                    depthTest: false,
                    depthWrite: false
                });

                const fallbackMesh = new THREE.Mesh(geometry, material);
                fallbackMesh.frustumCulled = false;
                fallbackMesh.renderOrder = 50000;
                fallbackMesh.userData = {
                    type: 'popupLensFill',
                    viewAxis,
                    surfaceIndex: -1,
                    isOpticalElement: true,
                    isDebugFallback: true
                };
                scene.add(fallbackMesh);
            }
        }
    }

    if (FORCE_DEBUG_FILL) {
        __coopt_addUltraDebugCrossOverlay(scene, THREE, viewAxis);
    }

    try {
        w.__cooptLastFillDebug = {
            time: Date.now(),
            viewAxis,
            source,
            createdMeshCount,
            sceneChildCount: Array.isArray(scene?.children) ? scene.children.length : 0,
            forceDebugFill: FORCE_DEBUG_FILL
        };
    } catch (_) {}
}

// ============================================================================
// POPUP MESSAGE HANDLER
// ============================================================================

function ensurePopupMessageHandler(): void {
    if (w.popupMessageHandlerRegistered) {
        return;
    }
    w.popupMessageHandlerRegistered = true;

    const syncPopupOrthoBoundsToRendererAspect = (popupWindow: any): void => {
        try {
            const cameraRef = w.popupCamera || popupWindow?.camera;
            const rendererRef = w.popupRenderer || popupWindow?.renderer;
            if (!cameraRef?.isOrthographicCamera || !rendererRef || typeof rendererRef.getSize !== 'function') {
                return;
            }

            const THREERef = popupWindow?.THREE || w.THREE;
            if (!THREERef?.Vector2) {
                return;
            }

            const size = rendererRef.getSize(new THREERef.Vector2());
            const width = Number(size?.x) || 0;
            const height = Number(size?.y) || 0;
            if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
                return;
            }

            const aspect = width / height;
            const currentHeight = (cameraRef.top - cameraRef.bottom) || 1;
            const centerX = (cameraRef.left + cameraRef.right) / 2;
            const centerY = (cameraRef.top + cameraRef.bottom) / 2;
            const nextWidth = currentHeight * aspect;

            cameraRef.left = centerX - nextWidth / 2;
            cameraRef.right = centerX + nextWidth / 2;
            cameraRef.top = centerY + currentHeight / 2;
            cameraRef.bottom = centerY - currentHeight / 2;
            cameraRef.updateProjectionMatrix();
        } catch (_) {}
    };
    
    window.addEventListener('message', async (event: MessageEvent) => {
        const popup = w.popup3DWindow;
        if (!popup || event.source !== popup) {
            return;
        }
        
        const data = event.data || {};
        
        // Handle popup-ready message
        if (data.action === 'popup-ready') {
            // Trigger initial draw when popup is ready
            const popup = w.popup3DWindow;
            if (popup && !popup.closed) {
                try {
                    const initialRayCount = (() => {
                        const input = document.getElementById('draw-ray-count-input') as HTMLInputElement | null;
                        const v = parseInt(input?.value || '51', 10);
                        return Number.isFinite(v) && v > 0 ? v : 51;
                    })();
                    // Send initial draw request to popup
                    const initialViewState = {
                        userAdjustedView: false,
                        viewAxis: 'YZ',
                        rayCount: initialRayCount,
                        rayColorMode: 'object'
                    };
                    
                    // Simulate receiving draw-cross message from popup
                    setTimeout(() => {
                        window.postMessage({ action: 'draw-cross', ...initialViewState }, '*');
                    }, 100);
                } catch (e) {
                    console.error('Failed to trigger initial draw:', e);
                }
            }
            
            return;
        }
        
        // Handle popup-resize message
        if (data.action === 'popup-resize') {
            if (!w.popup3DWindow) {
                console.warn('⚠️ Popup window reference is unavailable (resize)');
                return;
            }

            const popupWindow = w.popup3DWindow;
            const viewAxisRaw = (data?.viewAxis || w.__currentPopupViewAxis || 'YZ').toString().toUpperCase();
            const viewAxis = viewAxisRaw === 'XZ' ? 'XZ' : 'YZ';

            try {
                const cameraRef = popupWindow.camera;
                const savedBounds = cameraRef?.userData?.__drawCrossOrthoBounds;
                const centerZOverride = Number.isFinite(savedBounds?.centerZ) ? savedBounds.centerZ : undefined;
                const cameraOptions: any = {
                    camera: popupWindow.camera,
                    controls: popupWindow.controls,
                    scene: popupWindow.scene,
                    renderer: popupWindow.renderer,
                    includeRayStartMargin: true,
                    preserveDrawCrossBounds: true,
                    storeDrawCrossBounds: false,
                    ...(Number.isFinite(centerZOverride) ? { centerZOverride } : {})
                };

                if (viewAxis === 'XZ' && typeof w.setCameraForXZCrossSection === 'function') {
                    w.setCameraForXZCrossSection(cameraOptions);
                } else if (viewAxis === 'YZ' && typeof w.setCameraForYZCrossSection === 'function') {
                    w.setCameraForYZCrossSection(cameraOptions);
                }

                syncPopupOrthoBoundsToRendererAspect(popupWindow);

                const popupRenderer = w.popupRenderer || popupWindow?.renderer;
                const popupScene = w.popupScene || popupWindow?.scene;
                const popupCamera = w.popupCamera || popupWindow?.camera;
                if (popupRenderer && popupScene && popupCamera) {
                    popupRenderer.render(popupScene, popupCamera);
                }
            } catch (error) {
                console.error('❌ Popup resize handling error:', error);
            }
            
            return;
        }
        
        // Handle draw-cross message
        if (data.action === 'draw-cross') {
            try {
                const popupWindow = w.popup3DWindow;
                const viewAxisRaw = (data?.viewAxis || 'YZ').toString().toUpperCase();
                const viewAxis = viewAxisRaw === 'XZ' ? 'XZ' : 'YZ';
                const userAdjustedView = data?.userAdjustedView === true;
                const targetOverride = data?.target &&
                    Number.isFinite(data.target.x) &&
                    Number.isFinite(data.target.y) &&
                    Number.isFinite(data.target.z)
                    ? data.target
                    : null;
                const rayCount = (() => {
                    const v = parseInt(data?.rayCount ?? 51, 10);
                    return Number.isFinite(v) && v > 0 ? v : 51;
                })();
                const rayColorMode = (data?.rayColorMode === 'segment') ? 'segment' : 'object';
                
                try {
                    if (typeof w.setRayColorMode === 'function') {
                        w.setRayColorMode(rayColorMode);
                    }
                } catch (e) {}

                const isOptimizing = (typeof globalThis !== 'undefined') ? !!w.__cooptOptimizerIsRunning : false;
                
                if (!isOptimizing) {
                    if (typeof w.loadActiveConfigurationToTables === 'function') {
                        w.loadActiveConfigurationToTables();
                    }
                }

                if (!isOptimizing) {
                    try {
                        if (typeof globalThis !== 'undefined') {
                            w.__cooptOpticalSystemRowsOverride = null;
                        }
                    } catch (_) {}
                }
                
                const {
                    getOpticalSystemRows,
                    getObjectRows,
                    drawOpticalSystemSurfaces,
                    harmonizeSceneGeometry,
                    clearAllOpticalElements,
                    generateCrossBeam,
                    generateInfiniteSystemCrossBeam,
                    drawCrossBeamRays
                } = getRequiredFunctions();
                
                const opticalSystemRows = getOpticalSystemRows();

                try {
                    const surfaces = Array.isArray(opticalSystemRows)
                        ? opticalSystemRows.map((s: any, idx: number) => ({
                            index0: idx,
                            id: (s && typeof s === 'object') ? (s.id ?? null) : null,
                            type: (s && typeof s === 'object') ? (s.type ?? s['object type'] ?? '') : '',
                            _blockId: (s && typeof s === 'object') ? (s._blockId ?? '') : '',
                            _surfaceRole: (s && typeof s === 'object') ? (s._surfaceRole ?? '') : ''
                        }))
                        : [];
                    w.popup3DWindow?.postMessage({ action: 'surface-list', surfaces }, '*');
                } catch (e) {}

                if (!opticalSystemRows || opticalSystemRows.length === 0) {
                    w.popup3DWindow.postMessage({ status: 'Error: No optical system data' }, '*');
                    return;
                }

                const popupScene = w.popupScene || w.popup3DWindow?.scene || null;

                if (!popupScene) {
                    w.popup3DWindow.postMessage({ status: 'Error: Scene not ready' }, '*');
                    return;
                }

                const popupRenderer = w.popupRenderer || w.popup3DWindow?.renderer || null;
                if (popupScene) {
                    const allChildren = [...popupScene.children];
                    allChildren.forEach((child: any) => {
                        popupScene.remove(child);
                        if (child.geometry) child.geometry.dispose();
                        if (child.material) {
                            if (Array.isArray(child.material)) {
                                child.material.forEach((mat: any) => mat.dispose());
                            } else {
                                child.material.dispose();
                            }
                        }
                    });
                }
                if (typeof clearAllOpticalElements === 'function') {
                    clearAllOpticalElements(popupScene);
                }
                if (typeof drawOpticalSystemSurfaces === 'function') {
                    drawOpticalSystemSurfaces({
                        opticalSystemData: opticalSystemRows,
                        scene: popupScene,
                        showSemidiaRing: true,
                        showSurfaceOrigins: false,
                        crossSectionOnly: false
                    });
                }
                if (typeof harmonizeSceneGeometry === 'function') {
                    harmonizeSceneGeometry(popupScene);
                }

                let objectRows: any[] = [];
                try {
                    if (typeof getObjectRows === 'function') {
                        objectRows = getObjectRows() || [];
                    }
                } catch (error) {}

                if (!Array.isArray(objectRows) || objectRows.length === 0) {
                    try {
                        if (w.tableObject && typeof w.tableObject.getData === 'function') {
                            objectRows = w.tableObject.getData();
                        } else {
                            const tableElement = document.getElementById('table-object');
                            if (tableElement && (tableElement as any).tabulator) {
                                objectRows = (tableElement as any).tabulator.getData();
                            } else {
                                objectRows = [];
                            }
                        }
                    } catch (error) {
                        objectRows = [];
                    }
                }

                const objectSurface = opticalSystemRows[0] || {};
                const thicknessRaw = objectSurface?.thickness;
                const hasThicknessInfo = thicknessRaw !== undefined && thicknessRaw !== null && thicknessRaw !== '';
                const thicknessStr = hasThicknessInfo ? String(thicknessRaw).trim().toUpperCase() : '';
                const thicknessVal = Number(thicknessRaw);
                const thicknessIndicatesInfinite = hasThicknessInfo && (
                    thicknessRaw === Infinity ||
                    thicknessStr === 'INF' ||
                    thicknessStr === 'INFINITY' ||
                    thicknessStr === '∞' ||
                    (Number.isFinite(thicknessVal) && Math.abs(thicknessVal) > 1e6)
                );
                const objectRowsIndicateInfinite = !objectRows || objectRows.length === 0 ||
                    objectRows.every((row: any) => row.position === 'Angle' ||
                        (!row.height && !row.y && !row.xHeightAngle && !row.yHeightAngle) ||
                        parseFloat(row.height || 0) === 0);
                const isInfiniteSystem = hasThicknessInfo ? thicknessIndicatesInfinite : objectRowsIndicateInfinite;
                const primaryWavelength = (() => {
                    try {
                        if (typeof w.getPrimaryWavelength === 'function') {
                            const wl = Number(w.getPrimaryWavelength());
                            if (Number.isFinite(wl) && wl > 0) return wl;
                        }
                    } catch (_) {}
                    throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
                })();

                let crossBeamResult: any;
                if (isInfiniteSystem) {
                    const objectAngles = objectRows.map((row: any) => ({
                        x: parseFloat(row.xHeightAngle) || 0,
                        y: parseFloat(row.yHeightAngle) || 0
                    }));

                    const isImageRow = (row: any) => {
                        const raw = row?.['object type'] ?? row?.object ?? row?.Object ?? row?.type ?? '';
                        const normalized = String(raw).trim().toLowerCase().replace(/[\s_-]+/g, '');
                        return normalized === 'image' || normalized.startsWith('image');
                    };
                    const imageSurfaceIndex = opticalSystemRows.findIndex((row: any) =>
                        row && isImageRow(row)
                    );
                    const targetSurfaceIndex = imageSurfaceIndex >= 0 ? imageSurfaceIndex : Math.max(0, opticalSystemRows.length - 1);
                    if (imageSurfaceIndex < 0) {
                        console.warn(`⚠️ [DrawCross] Image surface not detected by object type. Falling back to last row index=${targetSurfaceIndex}.`);
                    }

                    crossBeamResult = await generateInfiniteSystemCrossBeam(opticalSystemRows, objectAngles, {
                        rayCount,
                        debugMode: false,
                        wavelength: primaryWavelength,
                        crossType: 'both',
                        targetSurfaceIndex,
                        pupilSamplingMode: 'entrance',
                        logEntrancePupilConfig: false,
                        angleUnit: 'deg',
                        chiefZ: -20
                    });
                } else {
                    const toNumber = (value: any) => {
                        const num = parseFloat(value);
                        return Number.isFinite(num) ? num : 0;
                    };
                    const allObjectPositions = (objectRows || []).map((row: any, index: number) => {
                        if (Array.isArray(row)) {
                            return {
                                x: toNumber(row[1]),
                                y: toNumber(row[2]),
                                z: 0,
                                objectIndex: index
                            };
                        }
                        const xCoord = toNumber(row.xHeightAngle ?? row.x ?? row.height ?? row.heightX);
                        const yCoord = toNumber(row.yHeightAngle ?? row.y ?? row.height ?? row.heightY);
                        return {
                            x: xCoord,
                            y: yCoord,
                            z: 0,
                            objectIndex: row.objectIndex ?? index
                        };
                    });
                    if (allObjectPositions.length === 0) {
                        allObjectPositions.push({ x: 0, y: 0, z: 0, objectIndex: 0 });
                    }
                    crossBeamResult = await generateCrossBeam(opticalSystemRows, allObjectPositions, {
                        rayCount,
                        debugMode: false,
                        wavelength: primaryWavelength,
                        crossType: 'both'
                    });
                }

                if (crossBeamResult.success) {
                    let allRays: any[] = [];
                    if (crossBeamResult.results && Array.isArray(crossBeamResult.results)) {
                        crossBeamResult.results.forEach((result: any) => {
                            if (result.rays && Array.isArray(result.rays)) {
                                allRays = allRays.concat(result.rays);
                            }
                        });
                    } else if (crossBeamResult.allTracedRays && Array.isArray(crossBeamResult.allTracedRays)) {
                        allRays = crossBeamResult.allTracedRays;
                    } else if (crossBeamResult.tracedRays && Array.isArray(crossBeamResult.tracedRays)) {
                        allRays = crossBeamResult.tracedRays;
                    } else if (Array.isArray(crossBeamResult)) {
                        allRays = crossBeamResult;
                    }

                    if (allRays && allRays.length > 0) {
                        drawCrossBeamRays(allRays, popupScene);
                        try {
                            (popupWindow as any).__lastCrossRays = allRays;
                            w.__lastCrossRays = allRays;
                        } catch (_) {}
                    }

                    try {
                        __coopt_applyPopupCrossSectionLensFill({
                            popupWindow,
                            scene: popupScene,
                            viewAxis,
                            opticalSystemRows,
                            source: 'draw-cross'
                        });
                    } catch (e) {
                        console.warn('⚠️ Popup lens fill postprocess failed:', e);
                    }

                    harmonizeSceneGeometry(popupScene);

                    if (!popupWindow) {
                        console.warn('⚠️ Popup window reference missing (camera)');
                    } else if (viewAxis === 'XZ' && typeof w.setCameraForXZCrossSection === 'function') {
                        w.setCameraForXZCrossSection({
                            camera: w.popupCamera || popupWindow.camera,
                            controls: w.popupControls || popupWindow.controls,
                            scene: w.popupScene || popupWindow.scene,
                            renderer: w.popupRenderer || popupWindow.renderer,
                            includeRayStartMargin: true,
                            preserveDrawCrossBounds: userAdjustedView === true,
                            preserveCurrentOrthoBounds: userAdjustedView === true,
                            storeDrawCrossBounds: userAdjustedView !== true,
                            ...(userAdjustedView === true && targetOverride ? { targetOverride } : {})
                        });
                    } else if (viewAxis === 'YZ' && typeof w.setCameraForYZCrossSection === 'function') {
                        w.setCameraForYZCrossSection({
                            camera: w.popupCamera || popupWindow.camera,
                            controls: w.popupControls || popupWindow.controls,
                            scene: w.popupScene || popupWindow.scene,
                            renderer: w.popupRenderer || popupWindow.renderer,
                            includeRayStartMargin: true,
                            preserveDrawCrossBounds: userAdjustedView === true,
                            preserveCurrentOrthoBounds: userAdjustedView === true,
                            storeDrawCrossBounds: userAdjustedView !== true,
                            ...(userAdjustedView === true && targetOverride ? { targetOverride } : {})
                        });
                    } else {
                        const popupRenderer = w.popupRenderer || popupWindow?.renderer;
                        const popupCamera = w.popupCamera || popupWindow?.camera;
                        if (popupRenderer && popupScene && popupCamera) {
                            popupRenderer.render(popupScene, popupCamera);
                        }
                        console.warn(`⚠️ setCameraFor${viewAxis}CrossSection not available`);
                    }

                    syncPopupOrthoBoundsToRendererAspect(popupWindow);

                    const popupRendererAfterCamera = w.popupRenderer || popupWindow?.renderer;
                    const popupCameraAfterCamera = w.popupCamera || popupWindow?.camera;
                    if (popupRendererAfterCamera && popupScene && popupCameraAfterCamera) {
                        popupRendererAfterCamera.render(popupScene, popupCameraAfterCamera);
                    }

                    __coopt_setPopupStatusWithFillDebug(w.popup3DWindow, 'Drawing complete', viewAxis);
                } else {
                    w.popup3DWindow.postMessage({ status: 'Error: ' + crossBeamResult.error }, '*');
                }
            } catch (error: any) {
                console.error('Error stack:', error.stack);
                w.popup3DWindow.postMessage({ status: 'Error: ' + error.message }, '*');
            }
            return;
        }
        
        // Handle view-xz and view-yz messages
        if (data.action === 'view-xz' || data.action === 'view-yz') {
            console.log('🎥 Handling popup view action:', data.action);
            if (!w.popup3DWindow) {
                return;
            }

            const popupWindow = w.popup3DWindow;
            const popupScene = w.popupScene || popupWindow.scene || null;
            const popupCamera = w.popupCamera || popupWindow.camera || null;
            const popupControls = w.popupControls || popupWindow.controls || null;
            const popupRenderer = w.popupRenderer || popupWindow.renderer || null;
            const popupStatus = popupWindow.document?.getElementById('status') || null;
            
            try {
                const viewAxis = data.action === 'view-xz' ? 'XZ' : 'YZ';
                const userAdjustedView = data?.userAdjustedView === true;
                const targetOverride = data?.target &&
                    Number.isFinite(data.target.x) &&
                    Number.isFinite(data.target.y) &&
                    Number.isFinite(data.target.z)
                    ? data.target
                    : null;

                const hasSavedBounds = !!(popupCamera?.userData?.__drawCrossOrthoBounds);
                const canSwitchCameraOnly =
                    hasSavedBounds &&
                    popupScene &&
                    popupCamera &&
                    popupControls &&
                    popupRenderer &&
                    (typeof w.setCameraForXZCrossSection === 'function') &&
                    (typeof w.setCameraForYZCrossSection === 'function');

                if (canSwitchCameraOnly) {
                    const rotateCameraAroundZOnly = ({ viewAxis, target }: any) => {
                        const cam = popupCamera;
                        const ctr = popupControls;
                        const rnd = popupRenderer;
                        const scn = popupScene;

                        if (!cam || !ctr) return;

                        const syncOrthoBoundsToRendererAspect = () => {
                            try {
                                if (!cam || !cam.isOrthographicCamera || !rnd || typeof rnd.getSize !== 'function') return;
                                const THREE = popupWindow?.THREE || w.THREE;
                                const size = rnd.getSize(new THREE.Vector2());
                                const width = Number(size?.x) || 0;
                                const height = Number(size?.y) || 0;
                                if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return;
                                const asp = width / height;

                                const currentHeight = (cam.top - cam.bottom) || 1;
                                const cx = (cam.left + cam.right) / 2;
                                const cy = (cam.top + cam.bottom) / 2;
                                const nextWidth = currentHeight * asp;

                                cam.left = cx - nextWidth / 2;
                                cam.right = cx + nextWidth / 2;
                                cam.top = cy + currentHeight / 2;
                                cam.bottom = cy - currentHeight / 2;
                            } catch (_) {}
                        };

                        const oldTarget = target || {
                            x: ctr.target?.x ?? 0,
                            y: ctr.target?.y ?? 0,
                            z: ctr.target?.z ?? 0
                        };

                        const curDx0 = (cam.position?.x ?? 0) - oldTarget.x;
                        const curDy0 = (cam.position?.y ?? 0) - oldTarget.y;
                        const currentAxis = (Math.abs(curDy0) > Math.abs(curDx0)) ? 'XZ' : 'YZ';
                        
                        let nextTarget = { ...oldTarget };
                        if (currentAxis === 'YZ' && viewAxis === 'XZ') {
                            nextTarget = { x: oldTarget.y, y: 0, z: oldTarget.z };
                        } else if (currentAxis === 'XZ' && viewAxis === 'YZ') {
                            nextTarget = { x: 0, y: oldTarget.x, z: oldTarget.z };
                        } else {
                            if (viewAxis === 'XZ') nextTarget.y = 0;
                            if (viewAxis === 'YZ') nextTarget.x = 0;
                        }

                        const shiftX = nextTarget.x - oldTarget.x;
                        const shiftY = nextTarget.y - oldTarget.y;
                        const shiftZ = nextTarget.z - oldTarget.z;

                        cam.position.set(
                            (cam.position?.x ?? 0) + shiftX,
                            (cam.position?.y ?? 0) + shiftY,
                            (cam.position?.z ?? 0) + shiftZ
                        );
                        ctr.target.set(nextTarget.x, nextTarget.y, nextTarget.z);
                        
                        const dx = (cam.position?.x ?? 0) - nextTarget.x;
                        const dy = (cam.position?.y ?? 0) - nextTarget.y;
                        const dz = (cam.position?.z ?? 0) - nextTarget.z;
                        const dist = Math.hypot(dx, dy, dz) || 300;

                        if (viewAxis === 'XZ') {
                            cam.position.set(nextTarget.x, nextTarget.y + dist, nextTarget.z);
                            cam.up.set(1, 0, 0);
                        } else {
                            cam.position.set(nextTarget.x - dist, nextTarget.y, nextTarget.z);
                            cam.up.set(0, 1, 0);
                        }

                        cam.lookAt(nextTarget.x, nextTarget.y, nextTarget.z);
                        ctr.update();

                        syncOrthoBoundsToRendererAspect();

                        cam.updateProjectionMatrix();
                        if (rnd && scn) rnd.render(scn, cam);
                    };

                    rotateCameraAroundZOnly({
                        viewAxis,
                        target: userAdjustedView && targetOverride ? targetOverride : null
                    });

                    try {
                        const clearSurfacesOnly = (scene: any) => {
                            if (!scene) return;
                            const objectsToRemove: any[] = [];
                            scene.traverse((child: any) => {
                                const ud = child.userData || {};
                                if (ud.type === 'popupLensFill' || ud.isUltraDebugOverlay === true) {
                                    return;
                                }
                                if (ud.isRayLine || ud.type === 'ray') {
                                    return;
                                }

                                const name = (child.name || '').toString();
                                const isRing = ud.type === 'semidiaRing' || ud.type === 'ring' || ud.surfaceType === 'ring' || name.toLowerCase().includes('ring');
                                const isLensSurface = ud.isLensSurface || ud.surfaceType === '3DSurface' || name.toLowerCase().includes('lenssurface') || name.startsWith('surface') || name.startsWith('lens');
                                const looksLikeTransparentSurface = !!(child.material && child.material.transparent && typeof child.material.opacity === 'number' && child.material.opacity < 1);
                                
                                if ((child.isMesh && (isLensSurface || looksLikeTransparentSurface)) || (child.isLine && isRing)) {
                                    objectsToRemove.push(child);
                                }
                            });
                            [...new Set(objectsToRemove)].forEach((obj: any) => {
                                scene.remove(obj);
                                if (obj.geometry) obj.geometry.dispose();
                                if (obj.material) {
                                    if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
                                    else obj.material.dispose();
                                }
                            });
                        };

                        clearSurfacesOnly(popupScene);

                        const { getOpticalSystemRows, drawOpticalSystemSurfaces, drawCrossBeamRays, harmonizeSceneGeometry } = getRequiredFunctions();
                        const clearRaysOnly = (scene: any) => {
                            if (!scene) return;
                            const raysToRemove: any[] = [];
                            scene.traverse((child: any) => {
                                const ud = child.userData || {};
                                if (ud.isRayLine || ud.type === 'ray') {
                                    raysToRemove.push(child);
                                }
                            });
                            [...new Set(raysToRemove)].forEach((obj: any) => {
                                scene.remove(obj);
                                if (obj.geometry) obj.geometry.dispose();
                                if (obj.material) {
                                    if (Array.isArray(obj.material)) obj.material.forEach((m: any) => m.dispose());
                                    else obj.material.dispose();
                                }
                            });
                        };
                        const opticalSystemRows = getOpticalSystemRows();
                        if (Array.isArray(opticalSystemRows) && opticalSystemRows.length > 0) {
                            drawOpticalSystemSurfaces({
                                opticalSystemData: opticalSystemRows,
                                scene: popupScene,
                                showSemidiaRing: false,
                                showSurfaceOrigins: false,
                                crossSectionOnly: true,
                                crossSectionDirection: viewAxis
                            });
                            harmonizeSceneGeometry(popupScene);
                        }

                        const cachedRays = (popupWindow as any).__lastCrossRays || w.__lastCrossRays;
                        if (Array.isArray(cachedRays) && cachedRays.length > 0 && typeof drawCrossBeamRays === 'function') {
                            clearRaysOnly(popupScene);
                            drawCrossBeamRays(cachedRays, popupScene);
                            harmonizeSceneGeometry(popupScene);
                        }

                        try {
                            __coopt_applyPopupCrossSectionLensFill({
                                popupWindow,
                                scene: popupScene,
                                viewAxis,
                                opticalSystemRows: Array.isArray(opticalSystemRows) ? opticalSystemRows : [],
                                source: 'view-switch-camera-only'
                            });
                        } catch (e) {
                            console.warn('⚠️ Popup lens fill postprocess failed:', e);
                        }
                        
                        // Re-render to show both rays and updated surfaces
                        if (popupRenderer && popupScene && popupCamera) {
                            popupRenderer.render(popupScene, popupCamera);
                        }
                    } catch (e) {
                        console.error('Error updating surfaces:', e);
                    }

                    __coopt_setPopupStatusWithFillDebug(popupWindow, `${viewAxis === 'XZ' ? 'X-Z' : 'Y-Z'} view ready`, viewAxis);
                } else {
                    await executeCrossSectionView({
                        viewAxis,
                        statusElement: popupStatus,
                        targetScene: popupScene,
                        targetCamera: popupCamera,
                        targetControls: popupControls,
                        targetRenderer: popupRenderer,
                        showAlerts: false
                    });

                    try {
                        const { getOpticalSystemRows } = getRequiredFunctions();
                        const opticalSystemRows = getOpticalSystemRows();
                        __coopt_applyPopupCrossSectionLensFill({
                            popupWindow,
                            scene: popupScene,
                            viewAxis,
                            opticalSystemRows: Array.isArray(opticalSystemRows) ? opticalSystemRows : [],
                            source: 'view-switch-execute-after'
                        });
                        if (popupRenderer && popupScene && popupCamera) {
                            popupRenderer.render(popupScene, popupCamera);
                        }
                    } catch (e) {
                        console.warn('⚠️ Popup lens fill postprocess failed:', e);
                    }

                    __coopt_setPopupStatusWithFillDebug(popupWindow, `${viewAxis === 'XZ' ? 'X-Z' : 'Y-Z'} view ready`, viewAxis);
                }
            } catch (error: any) {
                popupWindow.postMessage({ status: `Error: ${error.message}` }, '*');
            }
            return;
        }
    });
}

// ============================================================================
// EXECUTE CROSS-SECTION VIEW
// ============================================================================

function executeCrossSectionView(options: {
    viewAxis: string;
    buttonElement?: HTMLElement | null;
    statusElement?: HTMLElement | null;
    targetScene?: any;
    targetCamera?: any;
    targetControls?: any;
    targetRenderer?: any;
    showAlerts?: boolean;
}): void {
    const {
        viewAxis,
        buttonElement = null,
        statusElement = null,
        targetScene = null,
        targetCamera = null,
        targetControls = null,
        targetRenderer = null,
        showAlerts = false
    } = options;
    
    const saveButtonState = (): any => {
        if (!buttonElement) return null;
        return {
            originalText: buttonElement.textContent,
            disabled: (buttonElement as any).disabled
        };
    };
    
    const restoreButtonState = (state: any): void => {
        if (!buttonElement || !state) return;
        buttonElement.textContent = state.originalText;
        (buttonElement as any).disabled = state.disabled;
    };
    
    const buttonState = saveButtonState();
    
    if (buttonElement) {
        buttonElement.textContent = 'Drawing...';
        (buttonElement as any).disabled = true;
    }
    
    try {
        const isOptimizing = !!w.__cooptOptimizerIsRunning;
        
        if (!isOptimizing) {
            const loadActiveConfigurationToTables = w.loadActiveConfigurationToTables;
            if (typeof loadActiveConfigurationToTables === 'function') {
                loadActiveConfigurationToTables();
            }
        }
        
        // Keep override rows during optimization so Render reflects accept updates.
        if (!isOptimizing) {
            try {
                w.__cooptOpticalSystemRowsOverride = null;
            } catch (_) {}
        }
        
        const {
            getOpticalSystemRows,
            getObjectRows,
            generateCrossBeam,
            generateInfiniteSystemCrossBeam,
            drawOpticalSystemSurfaces,
            drawCrossBeamRays
        } = getRequiredFunctions();
        
        const opticalSystemRows = getOpticalSystemRows();
        const objectRows = getObjectRows();
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            if (showAlerts) {
                alert('No optical system data available.');
            }
            restoreButtonState(buttonState);
            return;
        }
        
        const objectThickness = objectRows && objectRows.length > 0 && objectRows[0] ? objectRows[0].thickness : null;
        const objectThicknessStr = String(objectThickness).trim().toUpperCase();
        const isInfiniteSystem = objectThickness === Infinity || 
                                objectThicknessStr === 'INF' || 
                                objectThicknessStr === 'INFINITY' || 
                                (Number(objectThickness) > 1e6);
        const rayCount = (() => {
            const rayCountInput = document.getElementById('draw-ray-count-input') as HTMLInputElement | null;
            const v = parseInt(rayCountInput?.value || '51', 10);
            return Number.isFinite(v) && v > 0 ? v : 51;
        })();
        
        let result: any;
        if (isInfiniteSystem) {
            if (typeof generateInfiniteSystemCrossBeam === 'function') {
                result = generateInfiniteSystemCrossBeam(opticalSystemRows, { rayCount });
            }
        } else {
            if (typeof generateCrossBeam === 'function' && objectRows && objectRows.length > 0) {
                result = generateCrossBeam(opticalSystemRows, objectRows, { rayCount });
            }
        }
        
        const collectRaysFromResult = (r: any): any[] => {
            if (!r) return [];
            let rays: any[] = [];
            if (Array.isArray(r.results)) {
                r.results.forEach((result: any) => {
                    if (result?.rays && Array.isArray(result.rays)) {
                        rays = rays.concat(result.rays);
                    }
                });
                if (rays.length > 0) return rays;
            }
            if (Array.isArray(r.allTracedRays)) return r.allTracedRays;
            if (Array.isArray(r.tracedRays)) return r.tracedRays;
            if (Array.isArray(r)) return r;
            return [];
        };
        
        const rays = collectRaysFromResult(result);
        
        const sceneRef = targetScene || w.scene;
        const cameraRef = targetCamera || w.camera;
        const controlsRef = targetControls || w.controls;
        const rendererRef = targetRenderer || w.renderer;
        
        if (sceneRef && typeof clearAllOpticalElements === 'function') {
            clearAllOpticalElements(sceneRef);
        }
        
        if (sceneRef && typeof drawOpticalSystemSurfaces === 'function') {
            drawOpticalSystemSurfaces({
                scene: sceneRef,
                opticalSystemData: opticalSystemRows,
                crossSectionOnly: true,
                crossSectionDirection: viewAxis
            });
        }

        const fillViewAxis: 'XZ' | 'YZ' = (viewAxis === 'XZ') ? 'XZ' : 'YZ';

        try {
            __coopt_applyPopupCrossSectionLensFill({
                popupWindow: window,
                scene: sceneRef,
                viewAxis: fillViewAxis,
                opticalSystemRows,
                source: 'execute-cross-initial'
            });
        } catch (fillErr) {
            console.warn('[RenderWindow] Lens fill postprocess failed:', fillErr);
        }
        
        if (sceneRef && typeof harmonizeSceneGeometry === 'function') {
            harmonizeSceneGeometry(sceneRef);
        }
        
        const applyFallbackXZCamera = (): void => {
            if (!cameraRef || !sceneRef) return;
            
            const savedBounds = cameraRef.userData?.__drawCrossOrthoBounds;
            
            if (savedBounds && savedBounds.left !== undefined) {
                const aspect = rendererRef ? (rendererRef.domElement.width / rendererRef.domElement.height || 1) : 1;
                const { left, right, top, bottom } = savedBounds;
                const contentAspect = (right - left) / (top - bottom);
                
                if (contentAspect > aspect) {
                    const h = (right - left) / aspect;
                    cameraRef.top = h / 2;
                    cameraRef.bottom = -h / 2;
                    cameraRef.left = left;
                    cameraRef.right = right;
                } else {
                    const w = (top - bottom) * aspect;
                    cameraRef.left = -w / 2;
                    cameraRef.right = w / 2;
                    cameraRef.top = top;
                    cameraRef.bottom = bottom;
                }
            } else {
                const calculateOpticalSystemZRange = w.calculateOpticalSystemZRange;
                let minZ = -10, maxZ = 100, maxY = 10, centerZ = 50;
                
                if (typeof calculateOpticalSystemZRange === 'function') {
                    try {
                        const range = calculateOpticalSystemZRange(opticalSystemRows);
                        if (range) {
                            minZ = range.minZ ?? minZ;
                            maxZ = range.maxZ ?? maxZ;
                            maxY = range.maxY ?? maxY;
                            centerZ = range.centerZ ?? centerZ;
                        }
                    } catch (_) {}
                }
                
                const contentWidth = maxZ - minZ;
                const contentHeight = maxY * 2;
                const aspect = rendererRef ? (rendererRef.domElement.width / rendererRef.domElement.height || 1) : 1;
                const contentAspect = contentWidth / contentHeight;
                
                if (contentAspect > aspect) {
                    const h = contentWidth / aspect;
                    cameraRef.top = h / 2;
                    cameraRef.bottom = -h / 2;
                    cameraRef.left = -contentWidth / 2;
                    cameraRef.right = contentWidth / 2;
                } else {
                    const w = contentHeight * aspect;
                    cameraRef.left = -w / 2;
                    cameraRef.right = w / 2;
                    cameraRef.top = contentHeight / 2;
                    cameraRef.bottom = -contentHeight / 2;
                }
            }
            
            const cameraDistance = 300;
            cameraRef.position.set(0, cameraDistance, savedBounds?.centerZ ?? 50);
            cameraRef.lookAt(0, 0, savedBounds?.centerZ ?? 50);
            cameraRef.up.set(1, 0, 0);
            cameraRef.updateProjectionMatrix();
            
            if (controlsRef) {
                controlsRef.target.set(0, 0, savedBounds?.centerZ ?? 50);
                controlsRef.update();
            }
        };
        
        const applyFallbackYZCamera = (): void => {
            if (!cameraRef || !sceneRef) return;
            
            const savedBounds = cameraRef.userData?.__drawCrossOrthoBounds;
            
            if (savedBounds && savedBounds.left !== undefined) {
                const aspect = rendererRef ? (rendererRef.domElement.width / rendererRef.domElement.height || 1) : 1;
                const { left, right, top, bottom } = savedBounds;
                const contentAspect = (right - left) / (top - bottom);
                
                if (contentAspect > aspect) {
                    const h = (right - left) / aspect;
                    cameraRef.top = h / 2;
                    cameraRef.bottom = -h / 2;
                    cameraRef.left = left;
                    cameraRef.right = right;
                } else {
                    const w = (top - bottom) * aspect;
                    cameraRef.left = -w / 2;
                    cameraRef.right = w / 2;
                    cameraRef.top = top;
                    cameraRef.bottom = bottom;
                }
            } else {
                const calculateOpticalSystemZRange = w.calculateOpticalSystemZRange;
                let minZ = -10, maxZ = 100, maxY = 10, centerZ = 50;
                
                if (typeof calculateOpticalSystemZRange === 'function') {
                    try {
                        const range = calculateOpticalSystemZRange(opticalSystemRows);
                        if (range) {
                            minZ = range.minZ ?? minZ;
                            maxZ = range.maxZ ?? maxZ;
                            maxY = range.maxY ?? maxY;
                            centerZ = range.centerZ ?? centerZ;
                        }
                    } catch (_) {}
                }
                
                const contentWidth = maxZ - minZ;
                const contentHeight = maxY * 2;
                const aspect = rendererRef ? (rendererRef.domElement.width / rendererRef.domElement.height || 1) : 1;
                const contentAspect = contentWidth / contentHeight;
                
                if (contentAspect > aspect) {
                    const h = contentWidth / aspect;
                    cameraRef.top = h / 2;
                    cameraRef.bottom = -h / 2;
                    cameraRef.left = -contentWidth / 2;
                    cameraRef.right = contentWidth / 2;
                } else {
                    const w = contentHeight * aspect;
                    cameraRef.left = -w / 2;
                    cameraRef.right = w / 2;
                    cameraRef.top = contentHeight / 2;
                    cameraRef.bottom = -contentHeight / 2;
                }
            }
            
            const cameraDistance = 300;
            cameraRef.position.set(-cameraDistance, 0, savedBounds?.centerZ ?? 50);
            cameraRef.lookAt(0, 0, savedBounds?.centerZ ?? 50);
            cameraRef.up.set(0, 1, 0);
            cameraRef.updateProjectionMatrix();
            
            if (controlsRef) {
                controlsRef.target.set(0, 0, savedBounds?.centerZ ?? 50);
                controlsRef.update();
            }
        };
        
        const setCameraForXZCrossSection = w.setCameraForXZCrossSection;
        const setCameraForYZCrossSection = w.setCameraForYZCrossSection;
        
        if (viewAxis === 'XZ') {
            if (typeof setCameraForXZCrossSection === 'function') {
                setCameraForXZCrossSection(sceneRef, cameraRef, { includeRayStartMargin: true, preserveDrawCrossBounds: true });
            } else {
                applyFallbackXZCamera();
            }
        } else {
            if (typeof setCameraForYZCrossSection === 'function') {
                setCameraForYZCrossSection(sceneRef, cameraRef, { includeRayStartMargin: true, preserveDrawCrossBounds: true });
            } else {
                applyFallbackYZCamera();
            }
        }
        
        if (rays && rays.length > 0 && sceneRef && typeof drawCrossBeamRays === 'function') {
            drawCrossBeamRays(rays, sceneRef);
        }
        
        if (sceneRef && typeof harmonizeSceneGeometry === 'function') {
            harmonizeSceneGeometry(sceneRef);
        }

        try {
            __coopt_applyPopupCrossSectionLensFill({
                popupWindow: window,
                scene: sceneRef,
                viewAxis: fillViewAxis,
                opticalSystemRows,
                source: 'execute-cross-final'
            });
        } catch (fillErr) {
            console.warn('[RenderWindow] Lens fill postprocess (final pass) failed:', fillErr);
        }
        
        if (rendererRef && sceneRef && cameraRef) {
            rendererRef.render(sceneRef, cameraRef);
        }
        
        if (statusElement) {
            const debugText = __coopt_getFillDebugStatusSuffix(viewAxis as 'XZ' | 'YZ');
            statusElement.textContent = `${viewAxis} view complete${debugText}`;
        }
        
    } catch (error) {
        console.error('Error in executeCrossSectionView:', error);
        if (showAlerts) {
            alert(`Failed to generate ${viewAxis} view: ${error}`);
        }
    } finally {
        restoreButtonState(buttonState);
    }
}

// Export for global access
w.executeCrossSectionView = executeCrossSectionView;

// ============================================================================
// UI SETUP FUNCTIONS
// ============================================================================

export function setupRayPatternButtons(): void {
    const annularBtn = document.getElementById('annular-pattern-btn');
    const gridBtn = document.getElementById('grid-pattern-btn');
    
    const updateButtonStates = (activePattern: string): void => {
        if (annularBtn) {
            if (activePattern === 'annular') {
                annularBtn.classList.add('active');
            } else {
                annularBtn.classList.remove('active');
            }
        }
        if (gridBtn) {
            if (activePattern === 'grid') {
                gridBtn.classList.add('active');
            } else {
                gridBtn.classList.remove('active');
            }
        }
    };
    
    if (annularBtn) {
        annularBtn.addEventListener('click', () => {
            setRayEmissionPattern('annular');
            updateButtonStates('annular');
        });
    }
    
    if (gridBtn) {
        gridBtn.addEventListener('click', () => {
            setRayEmissionPattern('grid');
            updateButtonStates('grid');
        });
    }
}

export function setupRayColorButtons(): void {
    const objectBtn = document.getElementById('object-color-btn');
    const segmentBtn = document.getElementById('segment-color-btn');
    
    const updateColorButtonStates = (activeMode: string): void => {
        if (objectBtn) {
            if (activeMode === 'object') {
                objectBtn.classList.add('active');
            } else {
                objectBtn.classList.remove('active');
            }
        }
        if (segmentBtn) {
            if (activeMode === 'segment') {
                segmentBtn.classList.add('active');
            } else {
                segmentBtn.classList.remove('active');
            }
        }
    };
    
    if (objectBtn) {
        objectBtn.addEventListener('click', () => {
            setRayColorMode('object');
            updateColorButtonStates('object');
        });
    }
    
    if (segmentBtn) {
        segmentBtn.addEventListener('click', () => {
            setRayColorMode('segment');
            updateColorButtonStates('segment');
        });
    }
}

export function setupViewButtons(options: {
    scene: any;
    camera: any;
    controls: any;
    renderer: any;
    drawOptimizedRaysFromObjects?: any;
}): void {
    const { scene, camera, controls, renderer, drawOptimizedRaysFromObjects } = options;
    
    if (!scene || !camera || !controls || !renderer) {
        console.error('setupViewButtons: Missing required THREE.js components');
        return;
    }
    
    const {
        getOpticalSystemRows,
        getObjectRows,
        drawOpticalSystemSurfaces
    } = getRequiredFunctions();
    
    if (!getOpticalSystemRows || !getObjectRows) {
        console.error('setupViewButtons: Missing required functions');
        return;
    }
    
    const clearBtn = document.getElementById('clear-all-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearAllOpticalElements(scene);
            if (renderer && scene && camera) {
                renderer.render(scene, camera);
            }
        });
    }
}

export function setupSimpleViewButtons(): void {
    const xzBtn = document.getElementById('view-xz-btn');
    const yzBtn = document.getElementById('view-yz-btn');
    
    if (xzBtn) {
        xzBtn.addEventListener('click', () => {
            executeCrossSectionView({
                viewAxis: 'XZ',
                buttonElement: xzBtn,
                showAlerts: true
            });
        });
    }
    
    if (yzBtn) {
        yzBtn.addEventListener('click', () => {
            executeCrossSectionView({
                viewAxis: 'YZ',
                buttonElement: yzBtn,
                showAlerts: true
            });
        });
    }
}

export function setupOpticalSystemChangeListeners(scene: any): void {
    if (w.__opticalSystemChangeListenersBound) {
        return;
    }
    w.__opticalSystemChangeListenersBound = true;
    
    const opticalSystemTabulator = w.tableOpticalSystem;
    
    if (opticalSystemTabulator) {
        const handleChange = (): void => {
            // Auto-clear disabled - user must press Draw button manually
        };
        
        opticalSystemTabulator.on('cellEdited', handleChange);
        opticalSystemTabulator.on('rowAdded', handleChange);
        opticalSystemTabulator.on('rowDeleted', handleChange);
        opticalSystemTabulator.on('dataChanged', handleChange);
    }
    
    ensurePopupMessageHandler();
    
    const open3DWindowBtn = document.getElementById('open-3d-window-btn');
    const open3DWindowHandler = () => {
        const existingPopup = w.popup3DWindow;
            if (existingPopup && !existingPopup.closed) {
                try {
                    existingPopup.focus();
                    const hasContent = existingPopup.document && existingPopup.document.getElementById('threejs-container');
                    if (hasContent) {
                        return;
                    }
                } catch (_) {}
            }
            
            const popup = window.open('', '3D Optical System', 'width=800,height=600');
            if (!popup) {
                alert('Popup blocked. Please allow popups for this site.');
                return;
            }
            
            popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>Render Optical System</title>
    <style>
        html, body { height: 100%; width: 100%; overflow: hidden; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f0f0f0;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }
        .header #status {
            font-size: 12px;
            font-weight: 400;
            color: #666;
            margin-left: auto;
            white-space: nowrap;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f9f9f9;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls button.active { background: #d0d0d0; }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            width: 80px;
        }
        #main {
            flex: 1 1 auto;
            display: flex;
            flex-direction: row;
            min-height: 0;
            position: relative;
            width: 100%;
            max-width: 100vw;
            overflow: hidden;
        }
        #threejs-container {
            flex: 1 1 auto;
            min-height: 0;
            position: relative;
            background: white;
            width: 100%;
            max-width: 100%;
            overflow: hidden;
        }
        #surface-colors {
            position: absolute;
            top: 0;
            right: 0;
            bottom: 0;
            width: 240px;
            display: flex;
            flex-direction: column;
            background: #fafafa;
            border-left: 1px solid #ddd;
            overflow: hidden;
            transition: width 0.2s;
            z-index: 10;
        }
        #surface-colors.collapsed {
            width: 32px;
        }
        #surface-colors .header-row {
            padding: 8px 12px;
            background: #f0f0f0;
            border-bottom: 1px solid #ddd;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex: 0 0 auto;
        }
        #surface-colors .title {
            font-size: 12px;
            font-weight: 600;
            color: #333;
        }
        #surface-colors.collapsed .title {
            display: none;
        }
        #surface-colors-toggle {
            cursor: pointer;
            user-select: none;
            font-size: 14px;
            color: #666;
            padding: 0 4px;
        }
        #surface-colors-toggle:hover {
            color: #333;
        }
        .table-wrap {
            flex: 1 1 auto;
            overflow: auto;
            padding: 8px;
        }
        #surface-colors.collapsed .table-wrap {
            display: none;
        }
        #surface-colors table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        }
        #surface-colors th {
            text-align: left;
            padding: 6px 8px;
            background: #e8e8e8;
            border-bottom: 1px solid #ccc;
            position: sticky;
            top: 0;
            z-index: 1;
        }
        #surface-colors td {
            padding: 4px 8px;
            border-bottom: 1px solid #eee;
        }
        #surface-colors select {
            width: 100%;
            padding: 4px;
            font-size: 11px;
            border: 1px solid #bbb;
            border-radius: 3px;
        }
    </style>
</head>
<body>
    <div class="header">
        <span>Render Optical System</span>
        <span id="status"></span>
    </div>
    <div class="controls">
        <button id="draw-btn" type="button">Render</button>
        <button id="view-xz-btn" type="button">X-Z View</button>
        <button id="view-yz-btn" type="button">Y-Z View</button>
        <button id="clear-btn" type="button">Clear</button>
        <label for="draw-ray-count-input">Ray number:</label>
        <input type="number" id="draw-ray-count-input" value="5" min="1" max="10001" step="2" />
        <label>Ray colors by:</label>
        <button id="object-color-btn" type="button" class="active">Object</button>
        <button id="segment-color-btn" type="button">Segment</button>
    </div>
    <div id="main">
        <div id="threejs-container"></div>
        <div id="surface-colors" class="collapsed">
            <div class="header-row">
                <span class="title">Surface Colors</span>
                <span id="surface-colors-toggle">▶</span>
            </div>
            <div class="table-wrap">
                <table>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Color</th>
                        </tr>
                    </thead>
                    <tbody id="surface-colors-tbody"></tbody>
                </table>
            </div>
        </div>
    </div>

    <script type="module">
        import * as THREE from 'https://esm.sh/three@0.182.0';
        import { OrbitControls } from 'https://esm.sh/three@0.182.0/examples/jsm/controls/OrbitControls.js';
        
        console.log('THREE.js loaded in popup:', !!THREE);
        
        // Try to get THREE from parent first, fallback to imported version
        const parentTHREE = window.opener && window.opener.THREE;
        const useTHREE = parentTHREE || THREE;
        const useOrbitControls = (window.opener && window.opener.OrbitControls) || OrbitControls;
        
        console.log('Using THREE from:', parentTHREE ? 'parent window' : 'local import');
        
        function initializePopup(THREE, OrbitControls) {
            const container = document.getElementById('threejs-container');
            const status = document.getElementById('status');
            const MAX_SAFE_DIMENSION = 8192;

            const scene = new THREE.Scene();
            scene.userData.renderContext = {
                three: THREE,
                global: window.opener
            };

            const pickSafeViewportDimension = (candidates, fallback) => {
                const dpr = Number(window.devicePixelRatio || 1);
                const normalized = [];

                const addCandidate = (value) => {
                    const n = Number(value);
                    if (!Number.isFinite(n)) return;
                    if (n >= 200 && n <= MAX_SAFE_DIMENSION) normalized.push(n);
                    if (dpr > 1.25) {
                        const cssLike = n / dpr;
                        if (cssLike >= 200 && cssLike <= MAX_SAFE_DIMENSION) normalized.push(cssLike);
                    }
                };

                for (const value of candidates) addCandidate(value);
                if (normalized.length === 0) return fallback;

                normalized.sort((a, b) => a - b);
                return Math.round(normalized[0]);
            };

            const getSafeViewportSize = () => {
                const width = pickSafeViewportDimension([
                    window.visualViewport && window.visualViewport.width,
                    window.innerWidth,
                    document.documentElement && document.documentElement.clientWidth,
                    window.outerWidth,
                    window.screen && window.screen.width
                ], 1280);
                const height = pickSafeViewportDimension([
                    window.visualViewport && window.visualViewport.height,
                    window.innerHeight,
                    document.documentElement && document.documentElement.clientHeight,
                    window.outerHeight,
                    window.screen && window.screen.height
                ], 720);
                return { width, height };
            };

            let lastGoodContainerWidth = 960;
            let lastGoodContainerHeight = 640;

            const getClampedContainerSize = () => {
                const rect = container.getBoundingClientRect();
                const rawWidth = Number(rect.width || container.clientWidth || 0);
                const rawHeight = Number(rect.height || container.clientHeight || 0);
                const viewport = getSafeViewportSize();
                const baselineWidthCandidates = [
                    viewport.width,
                    window.visualViewport && window.visualViewport.width,
                    window.innerWidth,
                    document.documentElement && document.documentElement.clientWidth,
                    window.screen && window.screen.width
                ]
                    .map((v) => Number(v))
                    .filter((v) => Number.isFinite(v) && v >= 200 && v <= MAX_SAFE_DIMENSION)
                    .sort((a, b) => a - b);
                const baselineHeightCandidates = [
                    viewport.height,
                    window.visualViewport && window.visualViewport.height,
                    window.innerHeight,
                    document.documentElement && document.documentElement.clientHeight,
                    window.screen && window.screen.height
                ]
                    .map((v) => Number(v))
                    .filter((v) => Number.isFinite(v) && v >= 200 && v <= MAX_SAFE_DIMENSION)
                    .sort((a, b) => a - b);

                const viewportWidthBaseline = baselineWidthCandidates[0] || viewport.width;
                const viewportHeightBaseline = baselineHeightCandidates[0] || viewport.height;

                const widthFactor = 1.35;
                const heightFactor = 1.5;

                const maxWidth = Math.min(MAX_SAFE_DIMENSION, Math.max(320, Math.round(viewportWidthBaseline * widthFactor)));
                const maxHeight = Math.min(MAX_SAFE_DIMENSION, Math.max(320, Math.round(viewportHeightBaseline * heightFactor)));

                const preferredWidth = Math.min(maxWidth, Math.max(2, Math.round(viewportWidthBaseline)));
                const preferredHeight = Math.min(maxHeight, Math.max(2, Math.round(viewportHeightBaseline)));

                const pickValue = (raw, fallback, min, max) => {
                    if (!Number.isFinite(raw)) return fallback;
                    if (raw < min || raw > max) return fallback;
                    return Math.round(raw);
                };

                let width = pickValue(rawWidth, preferredWidth, 2, maxWidth);
                let height = pickValue(rawHeight, preferredHeight, 2, maxHeight);

                if (width < 2) width = Math.min(maxWidth, Math.max(2, viewport.width));
                if (height < 2) height = Math.min(maxHeight, Math.max(2, viewport.height));

                if (Number.isFinite(rawWidth) && Math.round(rawWidth) !== width) {
                    console.warn('[popup] Ignored abnormal container width:', rawWidth, '->', width, '(max=', maxWidth, ')');
                }
                if (Number.isFinite(rawHeight) && Math.round(rawHeight) !== height) {
                    console.warn('[popup] Ignored abnormal container height:', rawHeight, '->', height, '(max=', maxHeight, ')');
                }

                lastGoodContainerWidth = width;
                lastGoodContainerHeight = height;
                return { width, height };
            };
            
            const viewSize = 50;
            const initialSize = getClampedContainerSize();
            const aspect = initialSize.width / initialSize.height || 1;
            const camera = new THREE.OrthographicCamera(
                -viewSize * aspect / 2,
                viewSize * aspect / 2,
                viewSize / 2,
                -viewSize / 2,
                0.1,
                10000
            );
            
            const rendererOptions = { antialias: true, alpha: true, precision: 'highp', logarithmicDepthBuffer: true };
            const renderer = new THREE.WebGLRenderer(rendererOptions);
            renderer.setPixelRatio(window.devicePixelRatio || 1);
            renderer.setSize(initialSize.width, initialSize.height, false);
            renderer.setClearColor(0xffffff, 1);
            renderer.sortObjects = false;
            renderer.shadowMap.enabled = false;
            container.appendChild(renderer.domElement);
            
            const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
            scene.add(ambientLight);
            const directionalLight = new THREE.DirectionalLight(0xffffff, 0.4);
            directionalLight.position.set(10, 10, 10);
            scene.add(directionalLight);
            
            const controls = new OrbitControls(camera, renderer.domElement);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            controls.enableRotate = true;
            controls.enablePan = true;
            controls.enableZoom = true;

            let popupUserAdjustedView = false;
            let popupCurrentViewAxis = 'YZ';
            let popupRayColorMode = 'object';
            let popupSurfaceColorsCollapsed = true;

            function setPopupUserAdjustedView(v) {
                popupUserAdjustedView = v === true;
            }

            function getPopupUserAdjustedView() {
                return popupUserAdjustedView === true;
            }

            function setCurrentViewAxis(axis) {
                popupCurrentViewAxis = axis === 'XZ' ? 'XZ' : 'YZ';
            }

            function getCurrentViewAxis() {
                return popupCurrentViewAxis;
            }

            function setPopupRayColorModeValue(mode) {
                popupRayColorMode = mode === 'segment' ? 'segment' : 'object';
            }

            function getPopupRayColorMode() {
                return popupRayColorMode;
            }

            function setSurfaceColorsCollapsed(collapsed) {
                popupSurfaceColorsCollapsed = collapsed === true;
            }

            function getSurfaceColorsCollapsed() {
                return popupSurfaceColorsCollapsed === true;
            }

            function toggleSurfaceColorsCollapsed() {
                setSurfaceColorsCollapsed(!getSurfaceColorsCollapsed());
            }
            
            setPopupUserAdjustedView(false);
            controls.addEventListener('start', () => {
                setPopupUserAdjustedView(true);
            });
            
            camera.position.set(0, 50, 100);
            camera.lookAt(0, 0, 0);
            camera.up.set(0, 1, 0);
            controls.target.set(0, 0, 100);
            controls.update();

            const renderNow = () => {
                renderer.render(scene, camera);
            };
            
            function animate() {
                requestAnimationFrame(animate);
                controls.update();
                renderNow();
            }
            animate();
            
            let resizeScheduled = false;
            let lastResizeSentAt = 0;
            let lastResizeWidth = -1;
            let lastResizeHeight = -1;

            const shouldSendPopupResize = (now, width, height, thresholdMs, deltaPx) => {
                const hasLastSize = lastResizeWidth > 0 && lastResizeHeight > 0;
                const sizeChangedEnough = !hasLastSize ||
                    Math.abs(lastResizeWidth - width) >= deltaPx ||
                    Math.abs(lastResizeHeight - height) >= deltaPx;
                return !lastResizeSentAt ||
                    (now - lastResizeSentAt > thresholdMs) ||
                    sizeChangedEnough;
            };

            const markPopupResizeSent = (now, width, height) => {
                lastResizeSentAt = now;
                lastResizeWidth = width;
                lastResizeHeight = height;
            };

            const scheduleResize = () => {
                if (resizeScheduled) return;
                resizeScheduled = true;
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        resizeScheduled = false;
                        applyResize();
                    });
                });
            };
            
            const applyResize = () => {
                const size = getClampedContainerSize();
                const w = Math.max(1, size.width);
                const h = Math.max(1, size.height);
                if (w < 2 || h < 2) return;
                
                renderer.setPixelRatio(window.devicePixelRatio || 1);
                renderer.setSize(w, h, false);
                controls.update();
                
                const aspect = w / h;
                const currentHeight = camera.top - camera.bottom;
                const currentCenterX = (camera.left + camera.right) / 2;
                const currentCenterY = (camera.top + camera.bottom) / 2;
                const newWidth = currentHeight * aspect;
                camera.left = currentCenterX - newWidth / 2;
                camera.right = currentCenterX + newWidth / 2;
                camera.top = currentCenterY + currentHeight / 2;
                camera.bottom = currentCenterY - currentHeight / 2;
                camera.updateProjectionMatrix();
                
                if (!getPopupUserAdjustedView()) {
                    const now = Date.now();
                    const threshold = 200;
                    const deltaPx = 8;
                    const shouldSend = shouldSendPopupResize(now, w, h, threshold, deltaPx);
                    
                    if (shouldSend && window.opener) {
                        markPopupResizeSent(now, w, h);
                        try {
                            const axis = getCurrentViewAxis() || 'YZ';
                            window.opener.postMessage({ action: 'popup-resize', viewAxis: axis }, '*');
                        } catch (_) {}
                    }
                }
                renderNow();
            };
            
            let resizeObserver = null;
            if (typeof ResizeObserver !== 'undefined') {
                resizeObserver = new ResizeObserver(() => scheduleResize());
                resizeObserver.observe(container);
            } else {
                let lastW = -1;
                let lastH = -1;
                setInterval(() => {
                    const w = container.clientWidth;
                    const h = container.clientHeight;
                    if (w !== lastW || h !== lastH) {
                        lastW = w;
                        lastH = h;
                        scheduleResize();
                    }
                }, 300);
            }
            window.addEventListener('resize', scheduleResize);
            
            const normalizeSceneGeometry = (scene) => {
                const normalizeArray = (attr, isIndex) => {
                    if (!attr || !attr.array) return;
                    const arr = attr.array;
                    
                    if (Array.isArray(arr)) {
                        const TypedArray = isIndex
                            ? (arr.length < 65536 ? Uint16Array : Uint32Array)
                            : Float32Array;
                        attr.array = new TypedArray(arr);
                        attr.needsUpdate = true;
                        return;
                    }
                    
                    if (arr.constructor && arr.constructor.name && 
                        arr.constructor.name.includes('Array') &&
                        arr.buffer && arr.buffer.constructor &&
                        arr.buffer.constructor.name === 'ArrayBuffer') {
                        const TypedArray = isIndex
                            ? (arr.length < 65536 ? Uint16Array : Uint32Array)
                            : Float32Array;
                        attr.array = new TypedArray(arr);
                        attr.needsUpdate = true;
                    }
                };
                
                scene.traverse((obj) => {
                    const geom = obj.geometry;
                    if (!geom) return;
                    
                    if (geom.attributes) {
                        for (const name in geom.attributes) {
                            const attr = geom.attributes[name];
                            if (attr.isInterleavedBufferAttribute && attr.data && attr.data.array) {
                                normalizeArray(attr.data, false);
                            } else {
                                normalizeArray(attr, false);
                            }
                        }
                    }
                    
                    if (geom.morphAttributes) {
                        for (const name in geom.morphAttributes) {
                            const morphs = geom.morphAttributes[name];
                            if (Array.isArray(morphs)) {
                                morphs.forEach(attr => normalizeArray(attr, false));
                            }
                        }
                    }
                    
                    if (geom.index) {
                        normalizeArray(geom.index, true);
                    }
                });
            };
            
            const findBadGeometry = (scene) => {
                const tempScene = new THREE.Scene();
                const tempCamera = new THREE.PerspectiveCamera();
                const tempRenderer = new THREE.WebGLRenderer();
                
                const objects = [];
                scene.traverse(obj => {
                    if (obj.geometry) objects.push(obj);
                });
                
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    tempScene.add(obj.clone());
                    
                    try {
                        tempRenderer.render(tempScene, tempCamera);
                    } catch (err) {
                        console.error('Bad geometry found:', {
                            name: obj.name,
                            uuid: obj.uuid,
                            type: obj.type,
                            geometryType: obj.geometry?.type,
                            hasIndex: !!obj.geometry?.index,
                            attributes: Object.keys(obj.geometry?.attributes || {}).map(k => {
                                const attr = obj.geometry.attributes[k];
                                return {
                                    name: k,
                                    itemSize: attr?.itemSize,
                                    count: attr?.count,
                                    arrayType: attr?.array?.constructor?.name,
                                    isInterleaved: !!attr?.isInterleavedBufferAttribute
                                };
                            }),
                            index: obj.geometry?.index ? {
                                count: obj.geometry.index.count,
                                arrayType: obj.geometry.index.array?.constructor?.name
                            } : null,
                            userData: obj.userData
                        });
                        tempRenderer.dispose();
                        return obj;
                    }
                }
                
                tempRenderer.dispose();
                return null;
            };
            
            try {
                window.scene = scene;
                window.camera = camera;
                window.renderer = renderer;
                window.controls = controls;
            } catch (_) {}

            if (window.opener) {
                window.opener.popupScene = scene;
                window.opener.popupCamera = camera;
                window.opener.popupRenderer = renderer;
                window.opener.popupControls = controls;
                window.opener.popup3DWindow = window;
            }
            
            const SURFACE_COLOR_OVERRIDES_STORAGE_KEY = 'coopt.surfaceColorOverrides';
            
            const COLOR_PALETTE = [
                { name: 'Light Pink', hex: '#FFB6C1' },
                { name: 'Light Red', hex: '#FF6B6B' },
                { name: 'Light Orange', hex: '#FFA07A' },
                { name: 'Light Amber', hex: '#FFBF00' },
                { name: 'Light Yellow', hex: '#FFFF99' },
                { name: 'Light Lime', hex: '#CCFF66' },
                { name: 'Light Green', hex: '#90EE90' },
                { name: 'Light Mint', hex: '#98FF98' },
                { name: 'Light Cyan', hex: '#AFEEEE' },
                { name: 'Light Sky', hex: '#87CEEB' },
                { name: 'Light Blue', hex: '#ADD8E6' },
                { name: 'Light Indigo', hex: '#9FA8DA' },
                { name: 'Light Purple', hex: '#DDA0DD' },
                { name: 'Light Lavender', hex: '#E6E6FA' },
                { name: 'Light Peach', hex: '#FFDAB9' },
                { name: 'Light Gray', hex: '#D3D3D3' }
            ];
            
            function surfaceColorKey(surf) {
                if (surf._blockId && surf._surfaceRole) {
                    return 'p:' + surf._blockId + '|' + surf._surfaceRole;
                }
                if (surf.id !== undefined && surf.id !== null) {
                    return 'id:' + surf.id;
                }
                if (surf.index0 !== undefined && surf.index0 !== null) {
                    return 'i:' + surf.index0;
                }
                return '';
            }
            
            function loadColorOverrides() {
                try {
                    const raw = localStorage.getItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY);
                    return raw ? JSON.parse(raw) : {};
                } catch (_) {
                    return {};
                }
            }
            
            function saveColorOverrides(map) {
                try {
                    localStorage.setItem(SURFACE_COLOR_OVERRIDES_STORAGE_KEY, JSON.stringify(map));
                } catch (_) {}
            }
            
            function requestRedrawFromPopup() {
                if (!window.opener) return;
                const viewState = getPopupViewState();
                try {
                    window.opener.postMessage({ action: 'draw-cross', ...viewState }, '*');
                } catch (_) {}
            }
            
            function renderSurfaceColorsTable(surfaces) {
                const tbody = document.getElementById('surface-colors-tbody');
                if (!tbody) return;
                
                tbody.innerHTML = '';
                
                const overrides = loadColorOverrides();
                
                for (let i = 0; i < surfaces.length; i++) {
                    const surf = surfaces[i];
                    const key = surfaceColorKey(surf);
                    if (!key) continue;
                    
                    const tr = document.createElement('tr');
                    
                    const tdIndex = document.createElement('td');
                    tdIndex.textContent = String(i);
                    
                    const tdColor = document.createElement('td');
                    const sel = document.createElement('select');
                    
                    const defaultOpt = document.createElement('option');
                    defaultOpt.value = '';
                    defaultOpt.textContent = 'Default';
                    sel.appendChild(defaultOpt);
                    
                    for (const c of COLOR_PALETTE) {
                        const opt = document.createElement('option');
                        opt.value = c.hex;
                        opt.textContent = c.name;
                        sel.appendChild(opt);
                    }
                    
                    const current = overrides[key] || '';
                    sel.value = current;
                    applySelectSwatch(sel);
                    sel.addEventListener('change', () => {
                        const next = String(sel.value || '').trim();
                        const nextMap = loadColorOverrides();
                        if (!next) {
                            delete nextMap[key];
                        } else {
                            nextMap[key] = next;
                        }
                        saveColorOverrides(nextMap);
                        applySelectSwatch(sel);
                        requestRedrawFromPopup();
                    });
                    
                    tdColor.appendChild(sel);
                    
                    tr.appendChild(tdIndex);
                    tr.appendChild(tdColor);
                    tbody.appendChild(tr);
                }
            }
            
            function applySelectSwatch(sel) {
                const val = String(sel.value || '').trim();
                if (val && val.startsWith('#')) {
                    sel.style.backgroundColor = val;
                } else {
                    sel.style.backgroundColor = '';
                }
            }
            
            function applySurfaceColorsCollapsedState(collapsed) {
                const surfaceColorsPanel = document.getElementById('surface-colors');
                const surfaceColorsToggle = document.getElementById('surface-colors-toggle');
                if (!surfaceColorsPanel || !surfaceColorsToggle) return;
                const isCollapsed = collapsed === true;
                surfaceColorsPanel.classList.toggle('collapsed', isCollapsed);
                surfaceColorsToggle.textContent = isCollapsed ? '◀' : '▶';
            }

            setSurfaceColorsCollapsed(true);
            applySurfaceColorsCollapsedState(getSurfaceColorsCollapsed());
            
            const surfaceColorsToggle = document.getElementById('surface-colors-toggle');
            if (surfaceColorsToggle) {
                surfaceColorsToggle.addEventListener('click', () => {
                    toggleSurfaceColorsCollapsed();
                    applySurfaceColorsCollapsedState(getSurfaceColorsCollapsed());
                });
            }
            
            setPopupRayColorModeValue('object');
            
            function setPopupRayColorMode(mode) {
                setPopupRayColorModeValue(mode);
                const objectColorBtn = document.getElementById('object-color-btn');
                const segmentColorBtn = document.getElementById('segment-color-btn');
                if (objectColorBtn && segmentColorBtn) {
                    objectColorBtn.classList.toggle('active', getPopupRayColorMode() === 'object');
                    segmentColorBtn.classList.toggle('active', getPopupRayColorMode() === 'segment');
                }
            }
            
            const objectColorBtn = document.getElementById('object-color-btn');
            const segmentColorBtn = document.getElementById('segment-color-btn');
            if (objectColorBtn) {
                objectColorBtn.addEventListener('click', () => setPopupRayColorMode('object'));
            }
            if (segmentColorBtn) {
                segmentColorBtn.addEventListener('click', () => setPopupRayColorMode('segment'));
            }
            
            console.log('Buttons:', {
                drawBtn: document.getElementById('draw-btn'),
                xzBtn: document.getElementById('view-xz-btn'),
                yzBtn: document.getElementById('view-yz-btn'),
                clearBtn: document.getElementById('clear-btn'),
                status: document.getElementById('status')
            });
            
            window.addEventListener('message', (event) => {
                if (!window.opener || event.source !== window.opener) {
                    return;
                }
                const data = event.data || {};
                if (data && data.action === 'surface-list') {
                    try {
                        renderSurfaceColorsTable(data.surfaces);
                    } catch (e) {}
                    return;
                }
                if (data && data.action === 'set-user-adjusted-view') {
                    try {
                        setPopupUserAdjustedView(data.value === true);
                    } catch (_) {}
                    return;
                }
                if (data && data.action === 'request-redraw') {
                    try {
                        const axisRaw = (data.viewAxis || getCurrentViewAxis() || 'YZ').toString().toUpperCase();
                        setCurrentViewAxis(axisRaw);
                    } catch (_) {}
                    
                    try {
                        const viewState = getPopupViewState();
                        if (status) {
                            status.textContent = 'Redrawing...';
                        }
                        window.opener.postMessage({ action: 'draw-cross', ...viewState }, '*');
                    } catch (e) {}
                    return;
                }
                if (typeof data.status === 'string' && status) {
                    status.textContent = data.status;
                }
            });
            
            function getPopupViewState() {
                const rayCountInput = document.getElementById('draw-ray-count-input');
                const rayCount = (() => {
                    const v = parseInt(rayCountInput?.value || '51', 10);
                    return Number.isFinite(v) && v > 0 ? v : 51;
                })();
                return {
                    userAdjustedView: getPopupUserAdjustedView(),
                    viewAxis: getCurrentViewAxis(),
                    rayCount,
                    rayColorMode: getPopupRayColorMode(),
                    target: {
                        x: controls?.target?.x ?? 0,
                        y: controls?.target?.y ?? 0,
                        z: controls?.target?.z ?? 0
                    },
                    camera: {
                        x: camera?.position?.x ?? 0,
                        y: camera?.position?.y ?? 0,
                        z: camera?.position?.z ?? 0
                    },
                    zoom: camera?.zoom ?? 1
                };
            }

            const drawBtn = document.getElementById('draw-btn');
            if (drawBtn) {
                drawBtn.addEventListener('click', () => {
                    const viewState = getPopupViewState();
                    console.log('📤 Sending message to parent:', { action: 'draw-cross', ...viewState });
                    if (window.opener) {
                        window.opener.postMessage({ action: 'draw-cross', ...viewState }, '*');
                        status.textContent = 'Drawing...';
                    }
                });
            }
            
            const xzBtn = document.getElementById('view-xz-btn');
            if (xzBtn) {
                xzBtn.addEventListener('click', () => {
                    setCurrentViewAxis('XZ');
                    if (window.opener) {
                        const viewState = getPopupViewState();
                        window.opener.postMessage({ action: 'view-xz', ...viewState }, '*');
                        status.textContent = 'Switching to X-Z view...';
                    }
                });
            }
            
            const yzBtn = document.getElementById('view-yz-btn');
            if (yzBtn) {
                yzBtn.addEventListener('click', () => {
                    setCurrentViewAxis('YZ');
                    if (window.opener) {
                        const viewState = getPopupViewState();
                        window.opener.postMessage({ action: 'view-yz', ...viewState }, '*');
                        status.textContent = 'Switching to Y-Z view...';
                    }
                });
            }
            
            const clearBtn = document.getElementById('clear-btn');
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    const objectsToRemove = [];
                    scene.traverse((object) => {
                        if (object !== scene && !(object instanceof THREE.Light)) {
                            objectsToRemove.push(object);
                        }
                    });
                    objectsToRemove.forEach((obj) => {
                        scene.remove(obj);
                        if (obj.geometry) obj.geometry.dispose();
                        if (obj.material) {
                            if (Array.isArray(obj.material)) {
                                obj.material.forEach(mat => mat.dispose());
                            } else {
                                obj.material.dispose();
                            }
                        }
                    });
                    renderNow();
                    status.textContent = 'Cleared';
                });
            }
            
            if (window.opener) {
                window.opener.postMessage({ action: 'popup-ready' }, '*');
            }
            
            if (drawBtn && window.opener) {
                setTimeout(() => {
                    try {
                        drawBtn.click();
                    } catch (e) {}
                }, 0);
            }
        }
        
        function initPopup() {
            if (THREE) {
                setupScene();
            } else {
                setTimeout(initPopup, 100);
            }
        }
        
        // Initialize with the loaded THREE.js
        initializePopup(useTHREE, useOrbitControls);
    </script>
</body>
</html>
            `);
            popup.document.close();
            
            w.popup3DWindow = popup;
    };
    if (typeof window !== 'undefined') {
        try { (window as any).__open3DWindowLegacy = open3DWindowHandler; } catch (_) {}
    }
    if (open3DWindowBtn) {
        open3DWindowBtn.addEventListener('click', open3DWindowHandler);
    }
}

/**
 * Setup analysis window buttons (System Data, Spot Diagram, Aberration analysis, etc.)
 * Must be called after React components are mounted
 */
export function setupAnalysisWindows() {
        const hasAnyAnalysisButton = !!(
            document.getElementById('open-system-data-window-btn') ||
            document.getElementById('open-spot-diagram-window-btn') ||
            document.getElementById('open-opd-window-btn') ||
            document.getElementById('open-psf-window-btn') ||
            document.getElementById('open-mtf-window-btn') ||
            document.getElementById('open-through-focus-spot-window-btn') ||
            document.getElementById('open-through-focus-mtf-window-btn') ||
            document.getElementById('open-field-mtf-window-btn')
        );

        if (!hasAnyAnalysisButton) {
            return;
        }

        if (w.__analysisWindowsBound) {
            return;
        }

        const isAnalysisWindowContext = (() => {
            try {
                const url = new URL(window.location.href);
                return url.searchParams.get('coopt_analysis_window') === '1';
            } catch (_) {
                return false;
            }
        })();

        if (isTauriRuntime() && !isAnalysisWindowContext) {
            w.__analysisWindowsBound = true;
            return;
        }

        w.__analysisWindowsBound = true;

        const consumePreopenedAnalysisPopup = (title: string, features: string) => {
            try {
                const store = w.__preopenedAnalysisPopupMap;
                const pre = store && store[title];
                if (pre && !pre.closed) {
                    try { delete store[title]; } catch (_) {}
                    try { pre.focus(); } catch (_) {}
                    return pre;
                }
            } catch (_) {}
            return window.open('', title, features);
        };

        // System Data popup window button
        const openSystemDataWindowBtn = document.getElementById('open-system-data-window-btn');
        if (openSystemDataWindowBtn) {
            const isReactHandled = (openSystemDataWindowBtn as HTMLElement).getAttribute('data-react-handled') === '1';
            if (!isReactHandled) {
            openSystemDataWindowBtn.addEventListener('click', () => {
                        if (w.__systemDataPopup && !w.__systemDataPopup.closed) {
                                try { w.__systemDataPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('System Data', 'width=1200,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__systemDataPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>System Data</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: white;
            color: #333;
            font-weight: 600;
            flex: 0 0 auto;
            border-bottom: 1px solid #ddd;
        }
        .controls {
            padding: 10px 12px;
            background: white;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
        }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
        }
        .content {
            flex: 1 1 auto;
            padding: 10px 12px;
            min-height: 0;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        textarea {
            flex: 1 1 auto;
            width: 100%;
            resize: none;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            font-size: 12px;
            line-height: 1.4;
            border: 1px solid #bbb;
            border-radius: 4px;
            padding: 10px;
            box-sizing: border-box;
            min-height: 0;
            background: white;
        }
    </style>
</head>
<body>
    <div class="header">System Data</div>
    <div class="controls">
        <button id="popup-calculate-paraxial">Calculate Paraxial</button>
        <button id="popup-calculate-seidel">Aberration Coefficients</button>
        <button id="popup-calculate-seidel-afocal">Aberration Coefficients (Afocal)</button>
        <label for="popup-reference-focal-length">Reference Focal Length:</label>
        <input type="text" id="popup-reference-focal-length" placeholder="Auto" style="width: 80px;" />
        <button id="popup-coord-transform">Coord Transform</button>
    </div>
    <div class="content">
        <div id="popup-transform-error-bar" style="display:none; padding:8px 12px; margin-bottom:8px; background:#fff3cd; border:1px solid #ffc107; border-radius:3px; color:#856404;">
            <strong>Error:</strong> <span id="popup-transform-error-text"></span>
        </div>
        <div id="popup-transform-progress-wrapper" style="display:none; padding:8px 12px; border-bottom:1px solid #eee; background:#fff; margin-bottom:8px;">
            <div id="popup-transform-progress-text">Calculating...</div>
            <progress id="popup-transform-progressbar" max="100" value="0" style="width:100%; margin-top:4px;"></progress>
        </div>
        <textarea id="popup-system-data" placeholder="System information will appear here..."></textarea>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncFromOpener() {
            const ref = getOpenerEl('reference-focal-length');
            const src = getOpenerEl('system-data');
            const popupRef = document.getElementById('popup-reference-focal-length');
            const popupText = document.getElementById('popup-system-data');

            if (popupRef && ref && popupRef.value !== ref.value) {
                popupRef.value = ref.value;
            }
            if (popupText && src && popupText.value !== src.value) {
                popupText.value = src.value;
            }
        }

        function triggerOpenerClick(id) {
            const btn = getOpenerEl(id);
            if (btn) {
                btn.click();
                // allow async handlers to update textarea
                setTimeout(syncFromOpener, 50);
                setTimeout(syncFromOpener, 200);
                setTimeout(syncFromOpener, 500);
                setTimeout(syncFromOpener, 1000);
                setTimeout(syncFromOpener, 2000);
            }
        }

        document.getElementById('popup-calculate-paraxial').addEventListener('click', () => triggerOpenerClick('calculate-paraxial-btn'));
        document.getElementById('popup-calculate-seidel').addEventListener('click', () => triggerOpenerClick('calculate-seidel-btn'));
        document.getElementById('popup-calculate-seidel-afocal').addEventListener('click', () => triggerOpenerClick('calculate-seidel-afocal-btn'));
        document.getElementById('popup-coord-transform').addEventListener('click', () => triggerOpenerClick('coord-transform-btn'));

        document.getElementById('popup-reference-focal-length').addEventListener('input', (e) => {
            const value = e.target.value;
            const ref = getOpenerEl('reference-focal-length');
            if (ref) ref.value = value;
            try {
                import('../data/table-configuration.ts').then(({ saveReferenceFocalLengthProjection }) => {
                    try { saveReferenceFocalLengthProjection(value); } catch (_) {}
                });
            } catch (_) {}
        });

        // Coordinate transformation controls in popup
        const popupTransformSurfaceSelect = document.getElementById('popup-transform-surface-select');
        const popupShowLocalCoordsBtn = document.getElementById('popup-show-local-coords-btn');
        const popupCancelTransformBtn = document.getElementById('popup-cancel-transform-btn');
        const popupSaveLocalCoordsBtn = document.getElementById('popup-save-local-coords-btn');
        const popupErrorBar = document.getElementById('popup-transform-error-bar');
        const popupErrorText = document.getElementById('popup-transform-error-text');
        const popupProgressWrapper = document.getElementById('popup-transform-progress-wrapper');
        const popupProgressText = document.getElementById('popup-transform-progress-text');
        const popupProgressBar = document.getElementById('popup-transform-progressbar');

        function showPopupError(message) {
            if (popupErrorBar && popupErrorText) {
                popupErrorText.textContent = message;
                popupErrorBar.style.display = '';
            }
        }

        function hidePopupError() {
            if (popupErrorBar) popupErrorBar.style.display = 'none';
        }

        function setPopupProgress(percent, message) {
            if (popupProgressWrapper) popupProgressWrapper.style.display = 'block';
            if (popupProgressBar && Number.isFinite(percent)) {
                popupProgressBar.value = Math.max(0, Math.min(100, percent));
            }
            if (popupProgressText && message) popupProgressText.textContent = message;
        }

        function hidePopupProgress() {
            if (popupProgressWrapper) popupProgressWrapper.style.display = 'none';
        }

        // Update surface select from opener
        function updatePopupSurfaceSelect() {
            if (!popupTransformSurfaceSelect) return;
            try {
                const getOpticalSystemRows = window.opener && window.opener.getOpticalSystemRows;
                if (typeof getOpticalSystemRows !== 'function') return;
                
                const opticalSystemRows = getOpticalSystemRows();
                if (!opticalSystemRows || opticalSystemRows.length === 0) return;
                
                popupTransformSurfaceSelect.innerHTML = '<option value="">Select surface...</option>';
                
                opticalSystemRows.forEach((row, index) => {
                    const objectType = String(row?.['object type'] ?? row?.object ?? '').toLowerCase();
                    if (objectType === 'object') return;
                    
                    const surfType = String(row?.surfType ?? row?.type ?? '').toLowerCase();
                    if (surfType === 'ct' || surfType === 'coordtrans' || surfType === 'coordinatebreak' ||
                        surfType === 'coord trans' || surfType === 'coordinate break') {
                        return;
                    }
                    
                    const option = document.createElement('option');
                    option.value = index;
                    
                    let label = 'Surf ' + index;
                    if (row.comment) label += ': ' + row.comment;
                    else if (row.material && row.material !== 'AIR') label += ': ' + row.material;
                    
                    option.textContent = label;
                    popupTransformSurfaceSelect.appendChild(option);
                });
            } catch (error) {
                console.error('Error updating popup surface select:', error);
            }
        }

        // Show Local Coords button
        if (popupShowLocalCoordsBtn) {
            popupShowLocalCoordsBtn.addEventListener('click', async function() {
                hidePopupError();
                
                try {
                    const surfaceIndex = parseInt(popupTransformSurfaceSelect?.value);
                    if (!surfaceIndex && surfaceIndex !== 0) {
                        showPopupError('Please select a surface first.');
                        return;
                    }
                    
                    const calculateAllSurfacesLocalCoordinates = window.opener && window.opener.calculateAllSurfacesLocalCoordinates;
                    const getOpticalSystemRows = window.opener && window.opener.getOpticalSystemRows;
                    const tableOpticalSystem = window.opener && window.opener.tableOpticalSystem;
                    
                    if (typeof calculateAllSurfacesLocalCoordinates !== 'function') {
                        showPopupError('Coordinate transformation function not available.');
                        return;
                    }
                    
                    if (typeof getOpticalSystemRows !== 'function') {
                        showPopupError('Optical system data not available.');
                        return;
                    }
                    
                    const opticalSystemRows = getOpticalSystemRows();
                    if (!opticalSystemRows || opticalSystemRows.length === 0) {
                        showPopupError('No optical system data. Please load or create an optical system.');
                        return;
                    }
                    
                    popupShowLocalCoordsBtn.disabled = true;
                    if (popupCancelTransformBtn) popupCancelTransformBtn.style.display = '';
                    if (popupSaveLocalCoordsBtn) popupSaveLocalCoordsBtn.style.display = 'none';
                    
                    if (window.opener) window.opener._transformCalculationCancelled = false;
                    
                    const result = await calculateAllSurfacesLocalCoordinates(
                        opticalSystemRows,
                        surfaceIndex,
                        (percent, message) => setPopupProgress(percent, message)
                    );
                    
                    if (window.opener) {
                        window.opener._cachedLocalCoords = result;
                        window.opener._showLocalCoords = true;
                    }
                    
                    if (tableOpticalSystem) {
                        tableOpticalSystem.redraw();
                    }
                    
                    if (popupSaveLocalCoordsBtn) popupSaveLocalCoordsBtn.style.display = '';
                    
                    hidePopupProgress();
                    
                } catch (error) {
                    console.error('Coordinate transformation error:', error);
                    showPopupError(error.message || 'Failed to calculate local coordinates.');
                    hidePopupProgress();
                } finally {
                    popupShowLocalCoordsBtn.disabled = false;
                    if (popupCancelTransformBtn) popupCancelTransformBtn.style.display = 'none';
                }
            });
        }

        // Cancel button
        if (popupCancelTransformBtn) {
            popupCancelTransformBtn.addEventListener('click', function() {
                if (window.opener) window.opener._transformCalculationCancelled = true;
                if (popupCancelTransformBtn) popupCancelTransformBtn.style.display = 'none';
                hidePopupProgress();
                showPopupError('Calculation cancelled by user.');
            });
        }

        // Save as JSON button
        if (popupSaveLocalCoordsBtn) {
            popupSaveLocalCoordsBtn.addEventListener('click', function() {
                try {
                    const data = window.opener && window.opener._cachedLocalCoords;
                    if (!data) {
                        showPopupError('No coordinate data to save. Please calculate first.');
                        return;
                    }
                    
                    const json = JSON.stringify(data, null, 2);
                    const blob = new Blob([json], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                    const surfaceIndex = data.metadata?.targetSurfaceIndex ?? 'unknown';
                    const filename = 'local-coords-surf' + surfaceIndex + '-' + timestamp + '.json';
                    
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    
                    URL.revokeObjectURL(url);
                    
                } catch (error) {
                    console.error('Save error:', error);
                    showPopupError('Failed to save JSON file: ' + error.message);
                }
            });
        }

        // Update surface select on load and periodically
        updatePopupSurfaceSelect();
        setInterval(updatePopupSurfaceSelect, 1000);

        // Keep in sync with the main window.
        setInterval(syncFromOpener, 500);
        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
                }
        }

        // Spot Diagram popup window button
        const openSpotDiagramWindowBtn = document.getElementById('open-spot-diagram-window-btn');
        if (openSpotDiagramWindowBtn) {
                openSpotDiagramWindowBtn.addEventListener('click', () => {
                        if (w.__spotDiagramPopup && !w.__spotDiagramPopup.closed) {
                    try { w.__spotDiagramPopup.close(); } catch (_) {}
                    w.__spotDiagramPopup = null;
                        }

                        // Ensure parent window selects are populated before opening popup
                        try {
                            requestUpdateSurfaceNumberSelect(w);
                        } catch (e) {
                            console.warn('Failed to update spot diagram selects:', e);
                        }

                        const popup = consumePreopenedAnalysisPopup('Spot Diagram', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__spotDiagramPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Spot Diagram</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: white;
            color: #333;
            font-weight: 600;
            flex: 0 0 auto;
            border-bottom: 1px solid #ddd;
        }
        .controls {
            padding: 10px 12px;
            background: white;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls input, .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .pattern-btn.active { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            background: white;
        }
        #popup-spot-diagram-container {
            min-height: 100%;
        }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header"></div>
    <div class="controls">
        <label for="popup-surface-number-select">Surf:</label>
        <select id="popup-surface-number-select"></select>

        <label for="popup-ray-count-input">Ray number:</label>
        <input type="number" id="popup-ray-count-input" value="501" min="1" step="1" />

        <label for="popup-ring-count-select">Ring count:</label>
        <select id="popup-ring-count-select">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="6">6</option>
            <option value="7">7</option>
            <option value="8">8</option>
            <option value="9">9</option>
            <option value="10" selected>10</option>
            <option value="12">12</option>
            <option value="15">15</option>
            <option value="16">16</option>
            <option value="20">20</option>
            <option value="24">24</option>
            <option value="32">32</option>
        </select>

        <label for="popup-pattern-select">Ray pattern:</label>
        <select id="popup-pattern-select">
            <option value="annular" selected>Annular</option>
            <option value="grid">Rectangle</option>
        </select>

        <button id="popup-show-spot-diagram-btn" type="button">Show spot diagram</button>
    </div>
    <div id="popup-spot-debug" style="display:none;"></div>
    <div id="popup-spot-run-debug" style="display:none;"></div>
    <div id="popup-spot-stats" style="display:none;"></div>
    <div id="popup-spot-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-spot-progress-text" style="margin-bottom: 6px;">Calculating spot diagram...</div>
        <progress id="popup-spot-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-spot-diagram-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function setPopupDebug(text) {
            return;
        }

        function setPopupRunDebug(text) {
            return;
        }

        function setPopupStats(text) {
            try {
                const el = document.getElementById('popup-spot-stats');
                if (el) el.textContent = String(text || '');
            } catch (_) {}
        }

        function syncSurfaceOptionsFromOpener() {
            const openerSelect = getOpenerEl('surface-number-select');
            const popupSelect = document.getElementById('popup-surface-number-select');
            if (!popupSelect) return;

            const populateFromOpenerRows = () => {
                try {
                    const rows = (() => {
                        try {
                            if (!window.opener) return null;
                            if (typeof window.opener.getOpticalSystemRows === 'function') {
                                const r = window.opener.getOpticalSystemRows(window.opener.tableOpticalSystem);
                                if (Array.isArray(r) && r.length > 0) return r;
                                const r2 = window.opener.getOpticalSystemRows();
                                if (Array.isArray(r2) && r2.length > 0) return r2;
                            }
                        } catch (_) {}
                        try {
                            if (window.opener && window.opener.tableOpticalSystem && typeof window.opener.tableOpticalSystem.getData === 'function') {
                                const r = window.opener.tableOpticalSystem.getData();
                                if (Array.isArray(r) && r.length > 0) return r;
                            }
                        } catch (_) {}
                        return null;
                    })();
                    if (!Array.isArray(rows) || rows.length === 0) {
                        setPopupDebug('Surf sync: opener rows unavailable (0 rows)');
                        return false;
                    }

                    const sharedOptions = (() => {
                        try {
                            if (window.opener && typeof window.opener.generateSurfaceOptions === 'function') {
                                const opts = window.opener.generateSurfaceOptions(rows);
                                if (Array.isArray(opts) && opts.length > 0) return opts;
                            }
                        } catch (_) {}
                        return null;
                    })();

                    if (Array.isArray(sharedOptions) && sharedOptions.length > 0) {
                        popupSelect.innerHTML = '';
                        const placeholder = document.createElement('option');
                        placeholder.value = '';
                        placeholder.textContent = 'Select Surf';
                        popupSelect.appendChild(placeholder);

                        for (const o of sharedOptions) {
                            const opt = document.createElement('option');
                            opt.value = String(o?.value ?? o?.surfaceId ?? '');
                            opt.textContent = String(o?.label ?? ('Surf ' + String(o?.surfaceId ?? '')));
                            {
                                const labelLower = String(opt.textContent || '').toLowerCase();
                                const imageFlag = !!(o?.isImage === true || labelLower.includes('(image)') || labelLower.includes(' image'));
                                opt.dataset.isImage = imageFlag ? '1' : '0';
                            }
                            if (o && o.rowId !== undefined && o.rowId !== null && String(o.rowId) !== '') {
                                opt.dataset.rowId = String(o.rowId);
                            }
                            if (o && Number.isInteger(o.rowIndex)) {
                                opt.dataset.rowIndex = String(o.rowIndex);
                            }
                            popupSelect.appendChild(opt);
                        }

                        if (String(popupSelect.value || '').trim() === '') {
                            const opts = Array.from(popupSelect.options || []);
                            const image = opts.find((opt) => String(opt.textContent || '').includes('(Image)') && String(opt.value || '').trim() !== '');
                            if (image) popupSelect.value = String(image.value);
                            else {
                                const last = opts.filter((opt) => String(opt.value || '').trim() !== '').pop();
                                if (last) popupSelect.value = String(last.value);
                            }
                        }

                        setPopupDebug('Surf sync: populated from shared generateSurfaceOptions. rows=' + rows.length + ', options=' + sharedOptions.length + ', selected=' + String(popupSelect.value || '(none)'));
                        return true;
                    }

                    const normalizeType = (v) => String(v || '').trim().toLowerCase();
                    const compactType = (v) => normalizeType(v).replace(/[\s_-]+/g, '');
                    const isObjectType = (v) => {
                        const n = normalizeType(v);
                        const c = compactType(v);
                        if (!n && !c) return false;
                        if (n === 'object' || c === 'object' || c === 'objectsurface') return true;
                        return n.startsWith('object ') || n.startsWith('object-') || n.startsWith('object_');
                    };
                    const isCoordTransType = (v) => {
                        const n = normalizeType(v);
                        const c = compactType(v);
                        return n === 'ct' || n === 'coord trans' || n === 'coordinate break' || c === 'ct' || c === 'coordtrans' || c === 'coordinatebreak';
                    };
                    const isGapType = (v) => {
                        const n = normalizeType(v);
                        const c = compactType(v);
                        return n === 'gap' || n === 'air gap' || c === 'gap' || c === 'airgap';
                    };
                    const isSkippableRow = (row) => {
                        const objTypeRaw = row && (row['object type'] ?? row.objectType ?? row.object ?? '');
                        const surfTypeRaw = row && (row.surfType ?? row['surf type'] ?? row.type ?? '');
                        const surfaceType = objTypeRaw || surfTypeRaw || 'Standard';
                        const blockType = row && (row._blockType ?? row.blockType ?? '');
                        const blockRole = row && (row._surfaceRole ?? row.surfaceRole ?? '');
                        return (
                            isObjectType(objTypeRaw) || isObjectType(surfTypeRaw) || isObjectType(surfaceType) ||
                            isCoordTransType(objTypeRaw) || isCoordTransType(surfTypeRaw) || isCoordTransType(surfaceType) ||
                            isGapType(objTypeRaw) || isGapType(surfTypeRaw) || isGapType(surfaceType) ||
                            isGapType(blockType) || isGapType(blockRole)
                        );
                    };

                    let surfaceId = 0;
                    let added = 0;
                    popupSelect.innerHTML = '';

                    const placeholder = document.createElement('option');
                    placeholder.value = '';
                    placeholder.textContent = 'Select Surf';
                    popupSelect.appendChild(placeholder);

                    for (const [i, row] of rows.entries()) {
                        const objTypeRaw = row && (row['object type'] ?? row.objectType ?? row.object ?? '');
                        const surfTypeRaw = row && (row.surfType ?? row['surf type'] ?? row.type ?? '');
                        const surfaceType = objTypeRaw || surfTypeRaw || 'Standard';

                        if (isSkippableRow(row)) continue;
                        surfaceId++;

                        const n = normalizeType(surfaceType);
                        const c = compactType(surfaceType);
                        const isStop = (n === 'stop' || c === 'stop' || n.includes('stop'));
                        const isImage = (n === 'image' || c === 'image' || n.includes('image'));

                        let label = 'Surf ' + surfaceId;
                        if (isStop) label += ' (Stop)';
                        else if (isImage) label += ' (Image)';
                        else label += ' (' + surfaceType + ')';

                        const opt = document.createElement('option');
                        opt.value = String(surfaceId);
                        opt.textContent = label;
                        opt.dataset.rowIndex = String(i);
                        opt.dataset.isImage = isImage ? '1' : '0';
                        if (row && row.id !== undefined && row.id !== null && String(row.id) !== '') {
                            opt.dataset.rowId = String(row.id);
                        }
                        try {
                            const norm = (v) => String(v ?? '').trim().toLowerCase();
                            const n0 = (v) => {
                                const x = Number(v);
                                return Number.isFinite(x) ? String(x) : norm(v);
                            };
                            const rowSig = [
                                't:' + norm(surfaceType),
                                'r:' + n0(row?.radius ?? row?.R ?? ''),
                                'th:' + n0(row?.thickness ?? row?.T ?? ''),
                                'sd:' + n0(row?.semidia ?? row?.semiDia ?? ''),
                                'm:' + norm(row?.material ?? row?.glass ?? row?.['glass'] ?? row?.refractiveIndex ?? ''),
                                'c:' + norm(row?.comment ?? row?.name ?? '')
                            ].join('|');
                            if (rowSig) opt.dataset.rowSig = rowSig;
                        } catch (_) {}
                        popupSelect.appendChild(opt);
                        added++;
                    }
                    if (added > 0 && String(popupSelect.value || '').trim() === '') {
                        const opts = Array.from(popupSelect.options || []);
                        const image = opts.find((opt) => String(opt.textContent || '').includes('(Image)') && String(opt.value || '').trim() !== '');
                        if (image) popupSelect.value = String(image.value);
                        else {
                            const last = opts.filter((opt) => String(opt.value || '').trim() !== '').pop();
                            if (last) popupSelect.value = String(last.value);
                        }
                    }
                    setPopupDebug('Surf sync: populated from opener rows. rows=' + rows.length + ', options=' + added + ', selected=' + String(popupSelect.value || '(none)'));
                    return added > 0;
                } catch (_) {
                    setPopupDebug('Surf sync: failed to read opener rows');
                    return false;
                }
            };

            const normalizeLabel = (text) => {
                const t = String(text || '').trim();
                // Drop leading "Surf N:" / "Surface N:" / "面 N" etc.
                return t
                    .replace(/^Surf\s*\d+\s*[:\-]?\s*/i, '')
                    .replace(/^Surface\s*\d+\s*[:\-]?\s*/i, '')
                    .replace(/^面\s*\d+\s*[:\-]?\s*/i, '')
                    .trim();
            };

            const prevValue = popupSelect.value;
            const prevText = popupSelect.options && popupSelect.selectedIndex >= 0
                ? popupSelect.options[popupSelect.selectedIndex]?.textContent
                : '';
            const prevKey = normalizeLabel(prevText);
            const prevWasLast = popupSelect.options && popupSelect.options.length > 0
                ? popupSelect.selectedIndex === (popupSelect.options.length - 1)
                : false;

            popupSelect.innerHTML = '';
            if (!openerSelect || !openerSelect.options || openerSelect.options.length <= 1) {
                if (populateFromOpenerRows()) {
                    if (prevValue !== '') popupSelect.value = prevValue;
                    setPopupDebug('Surf sync: fallback row population used');
                    return;
                }
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'Select Surf';
                popupSelect.appendChild(opt);
                setPopupDebug('Surf sync: opener select unavailable and fallback failed');
                return;
            }

            for (const o of openerSelect.options) {
                const opt = document.createElement('option');
                opt.value = o.value;
                // Replace Japanese "面" prefix and "Surface" prefix with "Surf".
                const label = (o.textContent || '').replace(/^面\s*/,'Surf ').replace(/^Surface\s*/,'Surf ');
                opt.textContent = label;
                if (o.dataset && o.dataset.rowIndex) opt.dataset.rowIndex = String(o.dataset.rowIndex);
                if (o.dataset && o.dataset.rowId) opt.dataset.rowId = String(o.dataset.rowId);
                if (o.dataset && o.dataset.rowSig) opt.dataset.rowSig = String(o.dataset.rowSig);
                if (o.dataset && o.dataset.isImage) opt.dataset.isImage = String(o.dataset.isImage);
                else {
                    const labelLower = String(label || '').toLowerCase();
                    opt.dataset.isImage = (labelLower.includes('(image)') || labelLower.includes(' image')) ? '1' : '0';
                }
                popupSelect.appendChild(opt);
            }

            // Preserve selection robustly across insert/delete (e.g., Image surface shifts index).
            const hasValue = (v) => Array.from(popupSelect.options || []).some((opt) => String(opt.value) === String(v));
            if (prevValue !== '' && hasValue(prevValue)) {
                popupSelect.value = prevValue;
                return;
            }
            if (prevKey) {
                const opts = Array.from(popupSelect.options || []);
                const match = opts.find((opt) => normalizeLabel(opt.textContent) === prevKey);
                if (match) {
                    popupSelect.value = match.value;
                    return;
                }
            }
            if (prevWasLast && popupSelect.options && popupSelect.options.length > 0) {
                popupSelect.selectedIndex = popupSelect.options.length - 1;
                return;
            }
            // Fallback: mirror opener selection.
            popupSelect.value = openerSelect.value;
            if (String(popupSelect.value || '').trim() === '') {
                const opts = Array.from(popupSelect.options || []);
                const image = opts.find((opt) => String(opt.textContent || '').includes('(Image)') && String(opt.value || '').trim() !== '');
                if (image) popupSelect.value = String(image.value);
                else {
                    const last = opts.filter((opt) => String(opt.value || '').trim() !== '').pop();
                    if (last) popupSelect.value = String(last.value);
                }
            }
            setPopupDebug('Surf sync: mirrored opener select. openerOptions=' + openerSelect.options.length + ', popupOptions=' + Math.max(0, popupSelect.options.length - 1) + ', selected=' + String(popupSelect.value || '(none)'));
        }

        function resolvePopupSurfaceRowIndexForNative(popupSelect, selectedOption) {
            try {
                const ds = selectedOption && selectedOption.dataset ? selectedOption.dataset : null;
                const rowIndexRaw = ds ? ds.rowIndex : undefined;
                const rowIndex = Number(rowIndexRaw);
                if (Number.isInteger(rowIndex) && rowIndex >= 0) {
                    return rowIndex;
                }

                const ordinal = Number.parseInt(String(popupSelect && popupSelect.value !== undefined ? popupSelect.value : ''), 10);
                if (!Number.isInteger(ordinal) || ordinal <= 0) {
                    return undefined;
                }

                const rows = (() => {
                    try {
                        if (!window.opener) return null;
                        if (typeof window.opener.getOpticalSystemRows === 'function') {
                            const r = window.opener.getOpticalSystemRows(window.opener.tableOpticalSystem);
                            if (Array.isArray(r) && r.length > 0) return r;
                            const r2 = window.opener.getOpticalSystemRows();
                            if (Array.isArray(r2) && r2.length > 0) return r2;
                        }
                    } catch (_) {}
                    try {
                        if (window.opener && window.opener.tableOpticalSystem && typeof window.opener.tableOpticalSystem.getData === 'function') {
                            const r = window.opener.tableOpticalSystem.getData();
                            if (Array.isArray(r) && r.length > 0) return r;
                        }
                    } catch (_) {}
                    return null;
                })();

                if (!Array.isArray(rows) || rows.length === 0) {
                    return undefined;
                }

                const normalizeType = (v) => String(v || '').trim().toLowerCase();
                const compactType = (v) => normalizeType(v).replace(/[\s_-]+/g, '');
                const isObjectType = (v) => {
                    const n = normalizeType(v);
                    const c = compactType(v);
                    if (!n && !c) return false;
                    if (n === 'object' || c === 'object' || c === 'objectsurface') return true;
                    return n.startsWith('object ') || n.startsWith('object-') || n.startsWith('object_');
                };
                const isCoordTransType = (v) => {
                    const n = normalizeType(v);
                    const c = compactType(v);
                    return n === 'ct' || n === 'coord trans' || n === 'coordinate break' || c === 'ct' || c === 'coordtrans' || c === 'coordinatebreak';
                };
                const isGapType = (v) => {
                    const n = normalizeType(v);
                    const c = compactType(v);
                    return n === 'gap' || n === 'air gap' || c === 'gap' || c === 'airgap';
                };
                const isSkippableRow = (row) => {
                    const objTypeRaw = row && (row['object type'] ?? row.objectType ?? row.object ?? '');
                    const surfTypeRaw = row && (row.surfType ?? row['surf type'] ?? row.type ?? '');
                    const surfaceType = objTypeRaw || surfTypeRaw || 'Standard';
                    const blockType = row && (row._blockType ?? row.blockType ?? '');
                    const blockRole = row && (row._surfaceRole ?? row.surfaceRole ?? '');
                    return (
                        isObjectType(objTypeRaw) || isObjectType(surfTypeRaw) || isObjectType(surfaceType) ||
                        isCoordTransType(objTypeRaw) || isCoordTransType(surfTypeRaw) || isCoordTransType(surfaceType) ||
                        isGapType(objTypeRaw) || isGapType(surfTypeRaw) || isGapType(surfaceType) ||
                        isGapType(blockType) || isGapType(blockRole)
                    );
                };

                let count = 0;
                for (let i = 0; i < rows.length; i++) {
                    if (isSkippableRow(rows[i])) continue;
                    count += 1;
                    if (count === ordinal) return i;
                }

                return undefined;
            } catch (_) {
                return undefined;
            }
        }

        function syncInputsFromOpener() {
            const openerRay = getOpenerEl('ray-count-input');
            const openerRing = getOpenerEl('ring-count-select');
            const popupRay = document.getElementById('popup-ray-count-input');
            const popupRing = document.getElementById('popup-ring-count-select');

            if (popupRay && openerRay && popupRay.value !== openerRay.value) popupRay.value = openerRay.value;
            if (popupRing && openerRing && popupRing.value !== openerRing.value) popupRing.value = openerRing.value;

            // pattern
            const annular = getOpenerEl('annular-pattern-btn');
            const popupPattern = document.getElementById('popup-pattern-select');
            if (popupPattern) {
                const userLocked = popupPattern.dataset && popupPattern.dataset.userLocked === '1';
                if (!userLocked) {
                    const isAnnular = !!annular && annular.classList.contains('active');
                    popupPattern.value = isAnnular ? 'annular' : 'grid';
                }
            }
        }

        function setPopupPattern(pattern) {
            const isAnnular = String(pattern || 'annular') !== 'grid';

            const openerAnnular = getOpenerEl('annular-pattern-btn');
            const openerGrid = getOpenerEl('grid-pattern-btn');
            if (isAnnular && openerAnnular) openerAnnular.click();
            if (!isAnnular && openerGrid) openerGrid.click();

            try {
                import('./spot-diagram-settings-storage.ts').then(({ setSpotDiagramPattern }) => {
                    try {
                        setSpotDiagramPattern(isAnnular ? 'annular' : 'grid', { preferOpener: true });
                    } catch (_) {}
                });
            } catch (_) {}
        }

        document.getElementById('popup-pattern-select').addEventListener('change', (e) => {
            const v = e && e.target && e.target.value ? String(e.target.value) : 'annular';
            try {
                const popupPattern = document.getElementById('popup-pattern-select');
                if (popupPattern && popupPattern.dataset) popupPattern.dataset.userLocked = '1';
            } catch (_) {}
            setPopupPattern(v);
        });

        document.getElementById('popup-show-spot-diagram-btn').addEventListener('click', async () => {
            const popupContainer = document.getElementById('popup-spot-diagram-container');
            if (popupContainer) popupContainer.innerHTML = '';

            const opener = window.opener;
            if (!opener) {
                if (popupContainer) popupContainer.textContent = 'Main window is not available.';
                return;
            }

            try {
                if (typeof opener.loadActiveConfigurationToTables === 'function') {
                    await opener.loadActiveConfigurationToTables({
                        applyToUI: true,
                        suppressOpticalSystemDataChanged: true,
                    });
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
            } catch (_) {}

            // Ensure surface indices/options are up-to-date (CB insert/delete shifts indices).
            try { syncSurfaceOptionsFromOpener(); } catch (_) {}

            const progressWrapper = document.getElementById('popup-spot-progress-wrapper');
            const progressBarEl = document.getElementById('popup-spot-progressbar');
            const progressTextEl = document.getElementById('popup-spot-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl) {
                        const pct = Number.isFinite(value) ? (String(Math.round(Math.max(0, Math.min(100, Number(value))))) + '%') : '';
                        const msg = (typeof text === 'string' && text.trim().length > 0) ? text : 'Working...';
                        progressTextEl.textContent = pct ? (msg + ' (' + pct + ')') : msg;
                    }
                } catch (_) {}
            };

            const openerRay = getOpenerEl('ray-count-input');
            const openerRing = getOpenerEl('ring-count-select');
            const openerSurface = getOpenerEl('surface-number-select');
            const popupRay = document.getElementById('popup-ray-count-input');
            const popupRing = document.getElementById('popup-ring-count-select');
            const popupSurface = document.getElementById('popup-surface-number-select');
            const popupPattern = document.getElementById('popup-pattern-select');
            const popupSurfaceSelectedOption = (popupSurface && popupSurface.selectedOptions && popupSurface.selectedOptions.length > 0)
                ? popupSurface.selectedOptions[0]
                : null;
            const popupSurfaceIsImage = !!(popupSurfaceSelectedOption && (
                (popupSurfaceSelectedOption.dataset && String(popupSurfaceSelectedOption.dataset.isImage || '') === '1') ||
                String(popupSurfaceSelectedOption.textContent || '').toLowerCase().includes('(image)')
            ));
            const popupSurfaceRowIndex = resolvePopupSurfaceRowIndexForNative(popupSurface, popupSurfaceSelectedOption);
            const popupSurfaceRowId = (() => {
                const raw = popupSurfaceSelectedOption && popupSurfaceSelectedOption.dataset
                    ? popupSurfaceSelectedOption.dataset.rowId
                    : undefined;
                const s = String(raw || '').trim();
                return s !== '' ? s : undefined;
            })();
            const popupSurfaceRowSig = (() => {
                const raw = popupSurfaceSelectedOption && popupSurfaceSelectedOption.dataset
                    ? popupSurfaceSelectedOption.dataset.rowSig
                    : undefined;
                const s = String(raw || '').trim();
                return s !== '' ? s : undefined;
            })();

            if (!popupSurface || String(popupSurface.value || '').trim() === '') {
                if (popupContainer) {
                    popupContainer.textContent = 'Please select Surf before running Spot Diagram.';
                }
                setPopupRunDebug('Show failed: Surf not selected. popupOptions=' + ((popupSurface && popupSurface.options) ? Math.max(0, popupSurface.options.length - 1) : 0));
                setProgress(100, 'Failed: Surf not selected');
                return;
            }

            if (openerRay && popupRay) openerRay.value = popupRay.value;
            if (openerRing && popupRing) openerRing.value = popupRing.value;
            if (openerSurface && popupSurface) openerSurface.value = popupSurface.value;

            try {
                setProgress(0, 'Starting...');
                setPopupStats('Native stats: running...');

                const shouldUseDesktopRust = (() => {
                    try {
                        if (typeof window !== 'undefined' && typeof window['shouldUseDesktopRustAnalysis'] === 'function') {
                            return !!window['shouldUseDesktopRustAnalysis']();
                        }
                        if (opener && typeof opener.shouldUseDesktopRustAnalysis === 'function') {
                            return !!opener.shouldUseDesktopRustAnalysis();
                        }
                        return true;
                    } catch (_) {
                        return false;
                    }
                })();
                const canUseDesktopRust = shouldUseDesktopRust && !!(
                    typeof opener.runDesktopAnalysisComputeForPopup === 'function'
                );
                const canUseNativeRustSpot = canUseDesktopRust && !!(
                    typeof opener.runDesktopNativeSpotRaytraceForPopup === 'function'
                );
                const canUseRustSpotDiagram = canUseDesktopRust && !!(
                    typeof window !== 'undefined'
                    && window.__COOPT_ENABLE_RUST_SPOT_DIAGRAM !== false
                );

                if (canUseNativeRustSpot) {
                    try {
                        setProgress(25, 'Computing Spot Diagram (Native Rust)...');
                        const nativeStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
                        try {
                            const objCount = Array.isArray(opener.getObjectRows ? opener.getObjectRows(opener.tableObject) : null)
                                ? opener.getObjectRows(opener.tableObject).length
                                : (Array.isArray(opener.tableObject?.data) ? opener.tableObject.data.length : 0);
                            setPopupRunDebug('Native Spot input: objectRows=' + objCount);
                        } catch (_) {}
                        const objectRowsForNative = (() => {
                            try {
                                if (opener.tableObject && typeof opener.tableObject.getData === 'function') {
                                    const rows = opener.tableObject.getData();
                                    if (Array.isArray(rows)) return rows;
                                }
                            } catch (_) {}
                            try {
                                if (typeof opener.getObjectRows === 'function') {
                                    const rows = opener.getObjectRows(opener.tableObject);
                                    if (Array.isArray(rows)) return rows;
                                }
                            } catch (_) {}
                            try {
                                const raw = opener.localStorage && opener.localStorage.getItem('objectTableData');
                                if (raw) {
                                    const parsed = JSON.parse(raw);
                                    if (Array.isArray(parsed)) return parsed;
                                }
                            } catch (_) {}
                            return [];
                        })();
                        try {
                            const highFieldObjects = (Array.isArray(objectRowsForNative) ? objectRowsForNative : []).filter((row) => {
                                const ax = Number(row?.xAngle ?? row?.objectAngleX ?? row?.xHeightAngle ?? row?.x ?? row?.angleX);
                                const ay = Number(row?.yAngle ?? row?.objectAngleY ?? row?.yHeightAngle ?? row?.y ?? row?.angle ?? row?.angleY);
                                const maxField = Math.max(Math.abs(Number.isFinite(ax) ? ax : 0), Math.abs(Number.isFinite(ay) ? ay : 0));
                                return maxField >= 15;
                            });
                            setPopupRunDebug(
                                'Native Spot preflight: objects=' + String(objectRowsForNative.length) +
                                ', highFieldObjects=' + String(highFieldObjects.length)
                            );
                        } catch (_) {}

                        const result = await opener.runDesktopNativeSpotRaytraceForPopup({
                            surfaceIndex: (popupSurfaceRowIndex !== undefined)
                                ? popupSurfaceRowIndex
                                : (popupSurface && popupSurface.value !== '' ? parseInt(popupSurface.value, 10) : undefined),
                            rayCount: popupRay && popupRay.value !== '' ? parseInt(popupRay.value, 10) : undefined,
                            ringCount: popupRing && popupRing.value !== '' ? parseInt(popupRing.value, 10) : undefined,
                            pattern: popupPattern ? String(popupPattern.value || 'annular') : 'annular',
                            wavelengthMode: 'all',
                            objectRows: objectRowsForNative,
                        });
                        const series = Array.isArray(result?.series) ? result.series : [];
                        const totalPointCount = series.reduce((sum, s) => {
                            const pts = Array.isArray(s?.points) ? s.points.length : 0;
                            return sum + pts;
                        }, 0);
                        const firstSeries = series.length > 0 ? series[0] : null;
                        const firstPoint = (firstSeries && Array.isArray(firstSeries.points) && firstSeries.points.length > 0)
                            ? firstSeries.points[0]
                            : null;
                        try {
                            setPopupRunDebug(
                                'Native Spot run: selected=' + String(popupSurface && popupSurface.value || '(none)') +
                                ', rowIndex=' + String(popupSurfaceRowIndex !== undefined ? popupSurfaceRowIndex : '(unresolved)') +
                                ', hit=' + String(Number(result?.totalHitRays) || 0) +
                                ', series=' + String(series.length) +
                                ', points=' + String(totalPointCount) +
                                (firstPoint
                                    ? ', first=(' + Number(firstPoint?.xUm || 0).toFixed(2) + ',' + Number(firstPoint?.yUm || 0).toFixed(2) + ')'
                                    : ', first=(none)')
                            );
                        } catch (_) {}
                        if (!series.length) {
                            throw new Error('Native Rust Spot result is empty');
                        }
                        const airyRadiusUm = Number(result?.airyRadiusUm);
                        try {
                            const requestedRays = Number(result?.requestedRays);
                            const generatedRays = Number(result?.generatedRays);
                            const totalAttemptedRays = Number(result?.totalAttemptedRays);
                            const totalHitRays = Number(result?.totalHitRays);
                            const meanHitRatePercent = Number(result?.meanHitRatePercent);
                            const maxHitRays = Number(result?.maxHitRays);
                            const wavelengthCount = Number(result?.wavelengthCount);
                            const raySeriesGenerationMs = Number(result?.timingMs?.raySeriesGeneration);
                            const nativeInvokeMs = Number(result?.timingMs?.nativeInvoke);
                            const nativeTraceMs = Number(result?.timingMs?.nativeTrace);
                            const stats = Array.isArray(result?.seriesStats) ? result.seriesStats : [];
                            const statsText = stats.slice(0, 3).map((s) => {
                                const label = String(s?.label || '-');
                                const h = Number(s?.hitRays) || 0;
                                const a = Number(s?.attemptedRays) || 0;
                                const r = Number(s?.hitRatePercent) || 0;
                                return label + ': ' + h + '/' + a + ' (' + r.toFixed(1) + '%)';
                            }).join(', ');
                            const timingsText =
                                'timing(ms): gen=' + (Number.isFinite(raySeriesGenerationMs) ? raySeriesGenerationMs.toFixed(1) : '-') +
                                ', trace=' + (Number.isFinite(nativeTraceMs) ? nativeTraceMs.toFixed(1) : '-') +
                                ', native=' + (Number.isFinite(nativeInvokeMs) ? nativeInvokeMs.toFixed(1) : '-');
                            setPopupStats(
                                'Native stats: requested=' + (Number.isFinite(requestedRays) ? requestedRays : '-') +
                                ', generated=' + (Number.isFinite(generatedRays) ? generatedRays : '-') +
                                ', attempted=' + (Number.isFinite(totalAttemptedRays) ? totalAttemptedRays : '-') +
                                ', hits=' + (Number.isFinite(totalHitRays) ? totalHitRays : '-') +
                                ', meanHitRate=' + (Number.isFinite(meanHitRatePercent) ? meanHitRatePercent.toFixed(1) + '%' : '-') +
                                ', maxHit=' + (Number.isFinite(maxHitRays) ? maxHitRays : '-') +
                                ', wavelengths=' + (Number.isFinite(wavelengthCount) ? wavelengthCount : '-') +
                                (Number.isFinite(airyRadiusUm) && airyRadiusUm > 0 ? ', airyR=' + airyRadiusUm.toFixed(2) + 'µm' : '') +
                                (statsText ? ' | ' + statsText : '') +
                                ' | ' + timingsText
                            );
                        } catch (_) {}
                        if (!window.Plotly || typeof window.Plotly.newPlot !== 'function') {
                            throw new Error('Plotly is not available in Spot Diagram popup');
                        }

                        const traces = [];
                        const toWavelengthLabel = (rawLabel) => {
                            const text = String(rawLabel || '').trim();
                            const nm = text.match(/(\d+(?:\.\d+)?)\s*nm/i);
                            if (nm && nm[1]) return 'Wavelength ' + nm[1] + 'nm';
                            const lower = text.toLowerCase();
                            if (lower.includes('primary')) return 'Wavelength Primary';
                            return 'Wavelength ' + text;
                        };
                        const wavelengthLabelFromSeries = (seriesItem, rawLabel) => {
                            const wl = Number(seriesItem?.wavelengthUm);
                            if (Number.isFinite(wl) && wl > 0) {
                                return 'Wavelength ' + (wl * 1000).toFixed(1) + 'nm';
                            }
                            return toWavelengthLabel(rawLabel);
                        };
                        const parseSeriesLabel = (label, fallbackObjectLabel) => {
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

                        const calcPercentile = (arr, q) => {
                            if (!Array.isArray(arr) || arr.length === 0) return 0;
                            const sorted = arr
                                .filter((v) => Number.isFinite(v) && v >= 0)
                                .sort((a, b) => a - b);
                            if (sorted.length === 0) return 0;
                            const qq = Math.max(0, Math.min(1, Number(q) || 0));
                            const idx = Math.floor((sorted.length - 1) * qq);
                            return sorted[Math.max(0, Math.min(sorted.length - 1, idx))] || 0;
                        };

                        const cullExtremeSpotOutliers = (rawPoints, centerXUm, centerYUm) => {
                            const pts = (Array.isArray(rawPoints) ? rawPoints : [])
                                .map((p) => ({
                                    xUm: Number(p?.xUm),
                                    yUm: Number(p?.yUm),
                                }))
                                .filter((p) => Number.isFinite(p.xUm) && Number.isFinite(p.yUm));
                            if (pts.length < 40) {
                                return { points: pts, culled: 0 };
                            }

                            const cx = Number.isFinite(centerXUm) ? centerXUm : 0;
                            const cy = Number.isFinite(centerYUm) ? centerYUm : 0;
                            const radii = pts.map((p) => {
                                const dx = p.xUm - cx;
                                const dy = p.yUm - cy;
                                return Math.sqrt(dx * dx + dy * dy);
                            });

                            const p95 = calcPercentile(radii, 0.95);
                            const p99 = calcPercentile(radii, 0.99);
                            const maxR = radii.reduce((m, v) => Math.max(m, Number(v) || 0), 0);
                            const clipR = Math.max(5, p99 * 1.35, p95 * 2.2);
                            if (!Number.isFinite(clipR) || clipR <= 0 || maxR <= clipR) {
                                return { points: pts, culled: 0 };
                            }

                            const filtered = [];
                            for (let i = 0; i < pts.length; i++) {
                                const p = pts[i];
                                const dx = p.xUm - cx;
                                const dy = p.yUm - cy;
                                const r = Math.sqrt(dx * dx + dy * dy);
                                if (r <= clipR) {
                                    filtered.push(p);
                                }
                            }

                            const culled = pts.length - filtered.length;
                            const maxAllowCull = Math.max(3, Math.floor(pts.length * 0.02));
                            if (culled <= 0 || culled > maxAllowCull || filtered.length < 10) {
                                return { points: pts, culled: 0 };
                            }

                            return { points: filtered, culled };
                        };

                        const groupedByObject = new Map();
                        for (let i = 0; i < series.length; i++) {
                            const s = series[i] || {};
                            const parsed = parseSeriesLabel(s?.label, 'Object ' + (i + 1));
                            if (!groupedByObject.has(parsed.objectLabel)) {
                                groupedByObject.set(parsed.objectLabel, []);
                            }
                            groupedByObject.get(parsed.objectLabel).push(s);
                        }
                        const objectEntries = Array.from(groupedByObject.entries());

                        let culledPointsCount = 0;
                        const preparedObjects = objectEntries.map(([objectLabel, objectSeries], index) => {
                            const groups = [];
                            for (let sIdx = 0; sIdx < objectSeries.length; sIdx++) {
                                const s = objectSeries[sIdx] || {};
                                const parsed = parseSeriesLabel(s?.label, objectLabel);
                                const points = Array.isArray(s?.points) ? s.points : [];
                                const hasFieldAngle = !!s?.hasFieldAngle;
                                const chiefXUm = Number(s?.chiefPointUm?.xUm);
                                const chiefYUm = Number(s?.chiefPointUm?.yUm);
                                const useChiefCentering = hasFieldAngle && Number.isFinite(chiefXUm) && Number.isFinite(chiefYUm);
                                const centeredPoints = useChiefCentering
                                    ? points.map((p) => ({
                                        xUm: (Number(p?.xUm) || 0) - chiefXUm,
                                        yUm: (Number(p?.yUm) || 0) - chiefYUm,
                                    }))
                                    : points.map((p) => ({
                                        xUm: Number(p?.xUm) || 0,
                                        yUm: Number(p?.yUm) || 0,
                                    }));

                                const culled = cullExtremeSpotOutliers(
                                    centeredPoints,
                                    useChiefCentering ? 0 : undefined,
                                    useChiefCentering ? 0 : undefined,
                                );
                                culledPointsCount += Number(culled?.culled) || 0;

                                groups.push({
                                    label: wavelengthLabelFromSeries(s, parsed.wavelengthLabel),
                                    color: String(s?.color || '#2563eb'),
                                    points: culled.points,
                                });
                            }
                            return { objectLabel, objectIndex: index + 1, groups };
                        });

                        const absSamples = [];
                        for (const obj of preparedObjects) {
                            for (const g of obj.groups) {
                                const pts = Array.isArray(g?.points) ? g.points : [];
                                for (const p of pts) {
                                    const x = Math.abs(Number(p?.xUm) || 0);
                                    const y = Math.abs(Number(p?.yUm) || 0);
                                    absSamples.push(x, y);
                                }
                            }
                        }
                        const maxAbs = absSamples.reduce((m, v) => Math.max(m, Number(v) || 0), 0);
                        const p98Abs = calcPercentile(absSamples, 0.98);
                        let unifiedRangeAbs = Math.max(1, p98Abs * 1.25);
                        if (Number.isFinite(airyRadiusUm) && airyRadiusUm > 0) {
                            unifiedRangeAbs = Math.max(unifiedRangeAbs, airyRadiusUm * 1.5);
                        }
                        unifiedRangeAbs = Math.min(unifiedRangeAbs, Math.max(50, maxAbs * 1.05 || 50));

                        const layout = {
                            margin: { l: 40, r: 16, t: 92, b: 32 },
                            showlegend: true,
                            paper_bgcolor: '#ffffff',
                            plot_bgcolor: '#ffffff',
                            annotations: [],
                            shapes: [],
                            legend: {
                                orientation: 'h',
                                yanchor: 'bottom',
                                y: 1.12,
                                xanchor: 'left',
                                x: 0,
                                traceorder: 'normal',
                                font: { size: 11 },
                            },
                            legendgroupclick: 'togglegroup',
                        };

                        const count = Math.max(1, preparedObjects.length);
                        const cols = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(count))));
                        const rows = Math.max(1, Math.ceil(count / cols));
                        const hGap = 0.05;
                        const vGap = 0.12;
                        const cellW = (1 - (cols - 1) * hGap) / cols;
                        const cellH = (1 - (rows - 1) * vGap) / rows;
                        layout.height = Math.max(360, rows * 340);

                        const legendAdded = new Set();
                        const legendColorByLabel = new Map();

                        for (let i = 0; i < preparedObjects.length; i++) {
                            const obj = preparedObjects[i];
                            const objectLabel = obj.objectLabel;
                            const groups = obj.groups;

                            const axisSuffix = i === 0 ? '' : String(i + 1);
                            const xAxisName = 'x' + axisSuffix;
                            const yAxisName = 'y' + axisSuffix;
                            const xAxisLayoutKey = 'xaxis' + axisSuffix;
                            const yAxisLayoutKey = 'yaxis' + axisSuffix;

                            const col = i % cols;
                            const rowFromTop = Math.floor(i / cols);
                            const x0 = col * (cellW + hGap);
                            const x1 = x0 + cellW;
                            const y1 = 1 - rowFromTop * (cellH + vGap);
                            const y0 = y1 - cellH;

                            layout[xAxisLayoutKey] = {
                                domain: [x0, x1],
                                zeroline: true,
                                range: [-unifiedRangeAbs, unifiedRangeAbs],
                                title: rowFromTop === (rows - 1) ? 'X (µm)' : '',
                                anchor: yAxisName,
                            };
                            layout[yAxisLayoutKey] = {
                                domain: [y0, y1],
                                zeroline: true,
                                range: [-unifiedRangeAbs, unifiedRangeAbs],
                                title: col === 0 ? 'Y (µm)' : '',
                                anchor: xAxisName,
                                scaleanchor: xAxisName,
                                scaleratio: 1,
                            };

                            if (Number.isFinite(airyRadiusUm) && airyRadiusUm > 0) {
                                layout.shapes.push({
                                    type: 'circle',
                                    xref: xAxisName,
                                    yref: yAxisName,
                                    x0: -airyRadiusUm,
                                    y0: -airyRadiusUm,
                                    x1: airyRadiusUm,
                                    y1: airyRadiusUm,
                                    line: { color: '#111827', width: 1 },
                                    fillcolor: 'rgba(0,0,0,0)',
                                });
                            }

                            for (const g of groups) {
                                const wlLabel = String(g?.label || 'Wavelength');
                                const pts = Array.isArray(g?.points) ? g.points : [];
                                traces.push({
                                    x: pts.map((p) => Number(p?.xUm) || 0),
                                    y: pts.map((p) => Number(p?.yUm) || 0),
                                    xaxis: xAxisName,
                                    yaxis: yAxisName,
                                    type: 'scattergl',
                                    mode: 'markers',
                                    name: wlLabel,
                                    legendgroup: wlLabel,
                                    showlegend: false,
                                    marker: {
                                        size: 6,
                                        color: String(g?.color || '#2563eb'),
                                        opacity: 0.85,
                                        symbol: 'circle',
                                        line: {
                                            width: 0.8,
                                            color: '#333333',
                                        },
                                    },
                                    hovertemplate: 'x=%{x:.2f}µm<br>y=%{y:.2f}µm<extra></extra>',
                                });
                                if (!legendColorByLabel.has(wlLabel)) {
                                    legendColorByLabel.set(wlLabel, String(g?.color || '#2563eb'));
                                }
                            }
                        }

                        for (const [wlLabel, color] of legendColorByLabel.entries()) {
                            if (legendAdded.has(wlLabel)) continue;
                            legendAdded.add(wlLabel);
                            traces.push({
                                x: [null],
                                y: [null],
                                type: 'scatter',
                                mode: 'markers',
                                name: wlLabel,
                                legendgroup: wlLabel,
                                showlegend: true,
                                marker: {
                                    size: 8,
                                    color: color,
                                    symbol: 'circle',
                                },
                                hoverinfo: 'skip',
                            });
                        }

                        setProgress(85, 'Rendering Spot Diagram...');
                        const plotStart = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
                        await window.Plotly.newPlot(popupContainer, traces, layout, { responsive: true, displaylogo: false });
                        const plotEnd = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
                        try {
                            if (progressWrapper) progressWrapper.style.display = 'none';
                        } catch (_) {}
                        return;
                    } catch (nativeErr) {
                        setPopupRunDebug('Native spot failed; fallback to Rust-WASM: ' + String(nativeErr && nativeErr.message ? nativeErr.message : nativeErr));
                        setPopupStats('Native stats: unavailable (fallback to Rust-WASM)');
                    }
                }

                if (canUseRustSpotDiagram) {
                    setProgress(25, 'Computing Spot Diagram (Rust)...');
                    const result = await opener.runDesktopAnalysisComputeForPopup({
                        kind: 'spot-diagram',
                        surfaceIndex: popupSurface && popupSurface.value !== '' ? parseInt(popupSurface.value, 10) : undefined,
                        rayCount: popupRay && popupRay.value !== '' ? parseInt(popupRay.value, 10) : undefined,
                        ringCount: popupRing && popupRing.value !== '' ? parseInt(popupRing.value, 10) : undefined,
                        pattern: popupPattern ? String(popupPattern.value || 'annular') : 'annular',
                    });
                    const series = Array.isArray(result?.spotDiagramSeries) ? result.spotDiagramSeries : [];
                    if (!series.length) {
                        throw new Error('Rust Spot Diagram result is empty');
                    }
                    if (!window.Plotly || typeof window.Plotly.newPlot !== 'function') {
                        throw new Error('Plotly is not available in Spot Diagram popup');
                    }

                    const traces = [];
                    for (const s of series) {
                        const points = Array.isArray(s?.points) ? s.points : [];
                        traces.push({
                            x: points.map((p) => Number(p?.xUm) || 0),
                            y: points.map((p) => Number(p?.yUm) || 0),
                            type: 'scattergl',
                            mode: 'markers',
                            name: String(s?.label || 'Series'),
                            marker: {
                                size: 3,
                                color: String(s?.color || '#2563eb'),
                                opacity: 0.6,
                            },
                            hovertemplate: 'x=%{x:.2f}µm<br>y=%{y:.2f}µm<extra></extra>',
                        });
                    }

                    setProgress(85, 'Rendering Spot Diagram...');
                    await window.Plotly.newPlot(popupContainer, traces, {
                        margin: { l: 52, r: 20, t: 20, b: 45 },
                        xaxis: { title: 'X (µm)', zeroline: true },
                        yaxis: { title: 'Y (µm)', zeroline: true, scaleanchor: 'x', scaleratio: 1 },
                        showlegend: true,
                        paper_bgcolor: '#ffffff',
                        plot_bgcolor: '#ffffff',
                    }, { responsive: true, displaylogo: false });
                    try {
                        if (progressWrapper) progressWrapper.style.display = 'none';
                    } catch (_) {}
                    return;
                }

                if (typeof opener.showSpotDiagram !== 'function') {
                    throw new Error('showSpotDiagram is not available on opener');
                }

                setProgress(25, 'Computing Spot Diagram (Rust-WASM raytrace)...');
                await opener.showSpotDiagram({
                    containerElement: popupContainer,
                    surfaceIndex: popupSurface && popupSurface.value !== '' ? parseInt(popupSurface.value, 10) : undefined,
                    surfaceRowIndex: popupSurfaceRowIndex,
                    surfaceRowId: popupSurfaceRowId,
                    surfaceRowSig: popupSurfaceRowSig,
                    surfaceIsImage: popupSurfaceIsImage,
                    rayCount: popupRay && popupRay.value !== '' ? parseInt(popupRay.value, 10) : undefined,
                    ringCount: popupRing && popupRing.value !== '' ? parseInt(popupRing.value, 10) : undefined,
                    pattern: popupPattern ? String(popupPattern.value || 'annular') : 'annular',
                    wavelengthMode: 'all',
                    forceRustWasmTrace: true,
                    requireRustWasmTrace: true,
                    onProgress: (evt) => {
                        try {
                            const p = Number(evt && evt.percent);
                            const msg = (evt && evt.message) || (evt && evt.phase) || 'Working...';
                            if (Number.isFinite(p)) setProgress(p, msg);
                            else setProgress(undefined, msg);
                        } catch (_) {}
                    },
                });
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            } catch (e) {
                if (popupContainer) popupContainer.textContent = String(e && e.message ? e.message : e);
                setProgress(100, 'Failed');
            }
        });

        function syncAll() {
            syncSurfaceOptionsFromOpener();
            syncInputsFromOpener();
        }

        try {
            w.__cooptSpotPopupSyncAll = syncAll;
        } catch (_) {}
        window.addEventListener('message', (ev) => {
            try {
                const data = ev && ev.data;
                if (!data || data.action !== 'coopt-spot-sync') return;
                syncAll();
            } catch (_) {}
        });

        window.addEventListener('focus', syncAll);
        setInterval(syncAll, 1000);
        syncAll();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Spherical Aberration (Longitudinal Aberration) popup window button
        const openSphericalAberrationWindowBtn = document.getElementById('open-spherical-aberration-window-btn');
        if (openSphericalAberrationWindowBtn) {
                openSphericalAberrationWindowBtn.addEventListener('click', () => {
                        if (w.__sphericalAberrationPopup && !w.__sphericalAberrationPopup.closed) {
                                try { w.__sphericalAberrationPopup.focus(); } catch (_) {}
                    try {
                        if (typeof w.__sphericalAberrationPopup.renderSphericalAberration === 'function') {
                            w.__sphericalAberrationPopup.renderSphericalAberration();
                        }
                    } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Spherical Aberration', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__sphericalAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Spherical Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 90px;
        }
        .note {
            padding: 10px 12px;
            color: #666;
            font-size: 12px;
            border-bottom: 1px solid #eee;
            background: #fff;
        }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: auto;
            background: white;
        }
        #popup-longitudinal-aberration-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-longitudinal-ray-count-input">Ray number:</label>
        <input type="number" id="popup-longitudinal-ray-count-input" value="100" min="1" max="1001" step="1" />
        <span class="note-inline" style="font-size:12px;color:#666;">(Always normalized by stop diameter)</span>
        <label for="popup-longitudinal-reference-focus-mode" style="margin-left:6px;">Reference focus:</label>
        <select id="popup-longitudinal-reference-focus-mode" style="font-size:12px;">
            <option value="primary-paraxial">Primary paraxial</option>
            <option value="current-paraxial" selected>Current paraxial</option>
            <option value="chief-ray">Chief ray</option>
        </select>
        <button id="popup-show-spherical-aberration-btn" type="button">Show</button>
    </div>
    <div id="popup-spherical-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-spherical-progress-text" style="margin-bottom: 6px;">Calculating spherical aberration...</div>
        <progress id="popup-spherical-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-longitudinal-aberration-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerRay = getOpenerEl('longitudinal-ray-count-input');
            const popupRay = document.getElementById('popup-longitudinal-ray-count-input');
            if (openerRay && popupRay) {
                popupRay.value = openerRay.value;
            }
            const openerMode = getOpenerEl('longitudinal-reference-focus-mode');
            const popupMode = document.getElementById('popup-longitudinal-reference-focus-mode');
            if (openerMode && popupMode && openerMode.value) {
                popupMode.value = openerMode.value;
            }
        }

        window['renderSphericalAberration'] = async () => {
            const progressWrapper = document.getElementById('popup-spherical-progress-wrapper');
            const progressBarEl = document.getElementById('popup-spherical-progressbar');
            const progressTextEl = document.getElementById('popup-spherical-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl) {
                        const pct = Number.isFinite(value) ? (String(Math.round(Math.max(0, Math.min(100, Number(value))))) + '%') : '';
                        const msg = (typeof text === 'string' && text.trim().length > 0) ? text : 'Working...';
                        progressTextEl.textContent = pct ? (msg + ' (' + pct + ')') : msg;
                    }
                } catch (_) {}
            };

            const popupRay = document.getElementById('popup-longitudinal-ray-count-input');
            const rayCount = popupRay ? parseInt(popupRay.value, 10) : 51;
            const openerRay = getOpenerEl('longitudinal-ray-count-input');
            if (openerRay && Number.isFinite(rayCount)) {
                openerRay.value = String(rayCount);
            }
            const popupMode = document.getElementById('popup-longitudinal-reference-focus-mode');
            const referenceFocusMode = popupMode && popupMode.value ? String(popupMode.value) : 'current-paraxial';
            const openerMode = getOpenerEl('longitudinal-reference-focus-mode');
            if (openerMode && referenceFocusMode) {
                openerMode.value = referenceFocusMode;
            }

            const opener = window.opener;
            const shouldUseDesktopRust = (() => {
                try {
                    if (typeof window !== 'undefined' && typeof window['shouldUseDesktopRustAnalysis'] === 'function') {
                        return !!window['shouldUseDesktopRustAnalysis']();
                    }
                    if (opener && typeof opener.shouldUseDesktopRustAnalysis === 'function') {
                        return !!opener.shouldUseDesktopRustAnalysis();
                    }
                        return true;
                } catch (_) {
                    return false;
                }
            })();
            const canUseDesktopRust = shouldUseDesktopRust && !!(
                opener
                && typeof opener.runDesktopNativeSphericalAberrationForPopup === 'function'
            );
            try {
                console.log('📊 [SA TS-Rust] mode', {
                    canUseDesktopRust,
                    hasNativeRunner: !!(opener && typeof opener.runDesktopNativeSphericalAberrationForPopup === 'function'),
                    referenceFocusMode,
                    rayCount,
                });
            } catch (_) {}

            const onProgress = (evt) => {
                try {
                    const p = Number(evt?.percent);
                    const msg = evt?.message || evt?.phase || 'Working...';
                    if (Number.isFinite(p)) setProgress(p, msg);
                    else setProgress(undefined, msg);
                } catch (_) {}
            };

            const containerEl = document.getElementById('popup-longitudinal-aberration-container');
            if (containerEl) containerEl.innerHTML = '';

            try {
                setProgress(0, 'Starting...');
                if (!opener || typeof opener.showLongitudinalAberrationDiagram !== 'function') {
                    throw new Error('showLongitudinalAberrationDiagram is not available on opener');
                }

                if (canUseDesktopRust) {
                    setProgress(25, 'Computing spherical aberration (Rust)...');
                    const rustResult = await opener.runDesktopNativeSphericalAberrationForPopup({
                        rayCount: Number.isFinite(rayCount) ? rayCount : 51,
                        referenceFocusMode: referenceFocusMode,
                        wavelengthMode: 'all',
                    });
                    setProgress(80, 'Rendering...');
                    await opener.showLongitudinalAberrationDiagram({
                        containerElement: containerEl,
                        onProgress,
                        precomputedAberrationData: rustResult,
                    });
                } else {
                    // Web fallback: run the existing JS/WASM spherical aberration path.
                    setProgress(25, 'Computing spherical aberration (Web)...');
                    await opener.showLongitudinalAberrationDiagram({
                        containerElement: containerEl,
                        onProgress,
                        rayCount: Number.isFinite(rayCount) ? rayCount : 51,
                        referenceFocusMode,
                    });
                }

                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
                return;
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate spherical aberration diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-spherical-aberration-btn').addEventListener('click', () => {
            window.renderSphericalAberration();
        });

        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderSphericalAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Astigmatism popup window button
        const openAstigmatismWindowBtn = document.getElementById('open-astigmatism-window-btn');
        if (openAstigmatismWindowBtn) {
                openAstigmatismWindowBtn.addEventListener('click', () => {
                        if (w.__astigmatismPopup && !w.__astigmatismPopup.closed) {
                                try { w.__astigmatismPopup.focus(); } catch (_) {}
                                try {
                                        if (typeof w.__astigmatismPopup.renderAstigmatism === 'function') {
                                                w.__astigmatismPopup.renderAstigmatism();
                                        }
                                } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Astigmatism', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__astigmatismPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Astigmatism</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-astigmatic-field-curves-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-astigmatism-chief-ray" style="font-size:12px;color:#333;white-space:nowrap;">Chief ray:</label>
        <select id="popup-astigmatism-chief-ray" style="padding:5px 8px;font-size:12px;border:1px solid #bbb;border-radius:4px;background:white;">
            <option value="stop-center">Stop center</option>
            <option value="beam-midpoint">Beam midpoint</option>
            <option value="beam-centroid">Beam centroid</option>
        </select>
        <label for="popup-astigmatism-beam" style="font-size:12px;color:#333;white-space:nowrap;">Beam:</label>
        <select id="popup-astigmatism-beam" style="padding:5px 8px;font-size:12px;border:1px solid #bbb;border-radius:4px;background:white;">
            <option value="cross">Cross</option>
            <option value="grid">Grid</option>
            <option value="annular" selected>Annular</option>
        </select>
        <label for="popup-astigmatism-ray-count" style="font-size:12px;color:#333;white-space:nowrap;">Rays:</label>
        <input id="popup-astigmatism-ray-count" type="number" min="9" max="2001" step="1" value="30" style="width:72px;padding:5px 8px;font-size:12px;border:1px solid #bbb;border-radius:4px;background:white;" />
        <label id="popup-astigmatism-ring-label" for="popup-astigmatism-ring-count" style="font-size:12px;color:#333;white-space:nowrap;">Rings:</label>
        <input id="popup-astigmatism-ring-count" type="number" min="1" max="64" step="1" value="32" style="width:72px;padding:5px 8px;font-size:12px;border:1px solid #bbb;border-radius:4px;background:white;" />
        <button id="popup-show-astigmatism-btn" type="button">Show</button>
    </div>
    <div id="popup-astigmatism-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-astigmatism-progress-text" style="margin-bottom: 6px;">Calculating...</div>
        <progress id="popup-astigmatism-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-astigmatic-field-curves-container"></div>
    </div>

    <script>
        window['renderAstigmatism'] = async () => {
            const containerEl = document.getElementById('popup-astigmatic-field-curves-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-astigmatism-progress-wrapper');
            const progressBarEl = document.getElementById('popup-astigmatism-progressbar');
            const progressTextEl = document.getElementById('popup-astigmatism-progress-text');
            const chiefRaySelect = document.getElementById('popup-astigmatism-chief-ray');
            const beamSelect = document.getElementById('popup-astigmatism-beam');
            const rayCountInput = document.getElementById('popup-astigmatism-ray-count');
            const ringCountInput = document.getElementById('popup-astigmatism-ring-count');
            const ringCountLabel = document.getElementById('popup-astigmatism-ring-label');
            const chiefRayDefinition = (chiefRaySelect && chiefRaySelect.value) ? chiefRaySelect.value : 'stop-center';
            const beamPattern = (() => {
                const v = String((beamSelect && beamSelect.value) ? beamSelect.value : 'annular').trim().toLowerCase();
                return (v === 'cross' || v === 'grid' || v === 'annular') ? v : 'annular';
            })();
            const openerRay = (window.opener && window.opener.document)
                ? window.opener.document.getElementById('ray-count-input')
                : null;
            const openerRing = (window.opener && window.opener.document)
                ? window.opener.document.getElementById('ring-count-select')
                : null;
            const initialRayCount = (() => {
                const n = Number(openerRay && openerRay.value);
                return Number.isFinite(n) ? Math.max(9, Math.min(2001, Math.round(n))) : 30;
            })();
            const initialRingCount = (() => {
                const n = Number(openerRing && openerRing.value);
                return Number.isFinite(n) ? Math.max(1, Math.min(64, Math.round(n))) : 32;
            })();
            if (rayCountInput && !rayCountInput.value) rayCountInput.value = String(initialRayCount);
            if (ringCountInput && !ringCountInput.value) ringCountInput.value = String(initialRingCount);

            const updateRingVisibility = () => {
                const isAnnular = beamSelect && String(beamSelect.value || '').toLowerCase() === 'annular';
                if (ringCountLabel) ringCountLabel.style.display = isAnnular ? '' : 'none';
                if (ringCountInput) ringCountInput.style.display = isAnnular ? '' : 'none';
            };
            updateRingVisibility();
            if (beamSelect) beamSelect.addEventListener('change', updateRingVisibility);

            const rayCount = (() => {
                const fromInput = Number(rayCountInput && rayCountInput.value);
                if (Number.isFinite(fromInput)) return Math.max(9, Math.min(2001, Math.round(fromInput)));
                return initialRayCount;
            })();
            const ringCount = (() => {
                const fromInput = Number(ringCountInput && ringCountInput.value);
                if (Number.isFinite(fromInput)) return Math.max(1, Math.min(64, Math.round(fromInput)));
                return initialRingCount;
            })();

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            try {
                if (!window.opener || typeof window.opener.showAstigmatismDiagram !== 'function') {
                    throw new Error('showAstigmatismDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        try { console.log('[ASTIG_POPUP][progress]', evt); } catch (_) {}
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.showAstigmatismDiagram({
                    containerElement: containerEl,
                    rayCount,
                    ringCount,
                    pattern: beamPattern,
                    requireRustWasm: true,
                    forceRustWasmTrace: true,
                    requireRustWasmTrace: true,
                    onProgress,
                    chiefRayDefinition,
                    logChiefRayDefinition: true,
                    useActiveConfigSnapshot: false
                });
                try { console.log('[ASTIG_POPUP][done] showAstigmatismDiagram resolved'); } catch (_) {}
                setProgress(100, '');
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate astigmatism diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-astigmatism-btn').addEventListener('click', () => {
            window.renderAstigmatism();
        });

        const popupBeamSelect = document.getElementById('popup-astigmatism-beam');
        const popupRingLabel = document.getElementById('popup-astigmatism-ring-label');
        const popupRingInput = document.getElementById('popup-astigmatism-ring-count');
        const syncAstigRingVisibility = () => {
            const isAnnular = popupBeamSelect && String(popupBeamSelect.value || '').toLowerCase() === 'annular';
            if (popupRingLabel) popupRingLabel.style.display = isAnnular ? '' : 'none';
            if (popupRingInput) popupRingInput.style.display = isAnnular ? '' : 'none';
        };
        syncAstigRingVisibility();
        if (popupBeamSelect) popupBeamSelect.addEventListener('change', syncAstigRingVisibility);

        // Do not auto-render on open; user triggers calculation via "Show".
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Distortion popup window button
        const openDistortionWindowBtn = document.getElementById('open-distortion-window-btn');
        if (openDistortionWindowBtn) {
                openDistortionWindowBtn.addEventListener('click', () => {
                if (!isTauriRuntime()) {
                    if (w.__distortionPopup && !w.__distortionPopup.closed) {
                        try { w.__distortionPopup.focus(); } catch (_) {}
                        return;
                    }
                    try {
                        const url = new URL(window.location.href);
                        url.searchParams.set('coopt_analysis_window', '1');
                        url.searchParams.set('coopt_analysis', 'distortion');
                        const popup = window.open(url.toString(), 'Distortion', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__distortionPopup = popup;
                        return;
                    } catch (_) {}
                }
                        if (w.__distortionPopup && !w.__distortionPopup.closed) {
                                try { w.__distortionPopup.focus(); } catch (_) {}
                    try {
                        if (typeof w.__distortionPopup.renderDistortion === 'function') {
                            w.__distortionPopup.renderDistortion();
                        }
                    } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Distortion', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__distortionPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Distortion</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: block;
        }
        .plot-area { width: 100%; height: 100%; min-height: 0; }
        #popup-distortion-percent { height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <button id="popup-show-distortion-btn" type="button">Show distortion diagram</button>
    </div>
    <div id="popup-distortion-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-distortion-progress-text" style="margin-bottom: 6px;">Calculating distortion...</div>
        <progress id="popup-distortion-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-distortion-percent-area" class="plot-area"><div id="popup-distortion-percent"></div></div>
    </div>

    <script>
        function getWavelengthColorLocal(wavelength) {
            if (wavelength < 0.45) return '#8B00FF';
            if (wavelength < 0.495) return '#0000FF';
            if (wavelength < 0.57) return '#00FF00';
            if (wavelength < 0.59) return '#9ACD32';
            if (wavelength < 0.62) return '#FF8800';
            return '#FF0000';
        }

        function plotDistortionLocal(dataList, targetEl) {
            if (!window.Plotly || typeof window.Plotly.newPlot !== 'function') {
                throw new Error('Plotly is not available in distortion popup');
            }
            const list = Array.isArray(dataList) ? dataList.filter(Boolean) : [];
            if (!list.length) throw new Error('No distortion data to plot');

            const traces = list.map((data) => {
                const wavelength = Number(data?.meta?.wavelength || 0.5876);
                const wavelengthNm = (wavelength * 1000).toFixed(1);
                const color = getWavelengthColorLocal(wavelength);
                const isHeightMode = !!data?.meta?.heightMode;
                const label = isHeightMode ? 'h' : 'θ';
                return {
                    x: Array.isArray(data?.distortionPercent) ? data.distortionPercent : [],
                    y: Array.isArray(data?.fieldValues) ? data.fieldValues : [],
                    name: 'DIST ' + wavelengthNm + 'nm (' + label + ')',
                    mode: 'lines',
                    line: { color, width: 2 },
                    type: 'scatter',
                };
            }).filter((trace) => Array.isArray(trace.x) && trace.x.length > 0 && Array.isArray(trace.y) && trace.y.length > 0);

            if (!traces.length) throw new Error('No plottable distortion traces');

            const maxFieldValue = Math.max(...list.map((data) => Array.isArray(data?.fieldValues) ? Math.max(...data.fieldValues) : 0));
            const minFieldValue = Math.min(...list.map((data) => Array.isArray(data?.fieldValues) ? Math.min(...data.fieldValues) : 0));
            const heightMode = list.some((d) => !!d?.meta?.heightMode);

            return window.Plotly.newPlot(targetEl, traces, {
                title: heightMode ? 'Distortion vs Object Height' : 'Distortion vs Object Angle',
                xaxis: { title: 'Distortion (%)', range: [-5, 5], dtick: 1 },
                yaxis: { title: heightMode ? 'Object Height (mm)' : 'Object Angle θ (deg)' },
                showlegend: true,
                legend: { orientation: 'v', x: 1.02, y: 1 },
                autosize: true,
                shapes: [{ type: 'line', x0: 0, x1: 0, y0: minFieldValue, y1: maxFieldValue, line: { color: 'black', width: 1, dash: 'dot' } }],
                margin: { l: 60, r: 120, t: 50, b: 50 },
            }, { responsive: true, displayModeBar: true, displaylogo: false });
        }

        function resizePlots() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const a = document.getElementById('popup-distortion-percent');
                if (a) plotly.Plots.resize(a);
            } catch (_) {}
        }

        window['renderDistortion'] = async () => {
            const percentEl = document.getElementById('popup-distortion-percent');
            if (percentEl) percentEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-distortion-progress-wrapper');
            const progressBarEl = document.getElementById('popup-distortion-progressbar');
            const progressTextEl = document.getElementById('popup-distortion-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };
            let renderSucceeded = false;

            try {
                if (!window.opener || typeof window.opener.runPortableDistortionDataForPopup !== 'function') {
                    throw new Error('runPortableDistortionDataForPopup is not available on opener');
                }
                setProgress(0, 'Starting...');
                await new Promise((resolve) => setTimeout(resolve, 0));
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                const result = await window.opener.runPortableDistortionDataForPopup({ onProgress });
                const allData = Array.isArray(result?.allData) ? result.allData : [];
                await plotDistortionLocal(allData, percentEl);
                renderSucceeded = true;
                setTimeout(resizePlots, 0);
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (percentEl) {
                    percentEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate distortion diagram. Check console.</div>';
                }
            } finally {
                if (renderSucceeded && progressWrapper) {
                    setTimeout(() => {
                        try { progressWrapper.style.display = 'none'; } catch (_) {}
                    }, 250);
                }
            }
        };

        document.getElementById('popup-show-distortion-btn').addEventListener('click', () => window.renderDistortion());
        window.addEventListener('resize', resizePlots);

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderDistortion(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Distortion Grid popup window button
        const openDistortionGridWindowBtn = document.getElementById('open-distortion-grid-window-btn');
        if (openDistortionGridWindowBtn) {
                openDistortionGridWindowBtn.addEventListener('click', () => {
                if (!isTauriRuntime()) {
                    if (w.__distortionGridPopup && !w.__distortionGridPopup.closed) {
                        try { w.__distortionGridPopup.focus(); } catch (_) {}
                        return;
                    }
                    try {
                        const url = new URL(window.location.href);
                        url.searchParams.set('coopt_analysis_window', '1');
                        url.searchParams.set('coopt_analysis', 'distortion-grid');
                        const popup = window.open(url.toString(), 'Distortion Grid', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__distortionGridPopup = popup;
                        return;
                    } catch (_) {}
                }
                        if (w.__distortionGridPopup && !w.__distortionGridPopup.closed) {
                                try { w.__distortionGridPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Distortion Grid', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__distortionGridPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Distortion Grid</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-distortion-grid { width: 100%; height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-distortion-grid-size">Grid Size:</label>
        <select id="popup-distortion-grid-size">
            <option value="10">10×10</option>
            <option value="15">15×15</option>
            <option value="20" selected>20×20</option>
            <option value="25">25×25</option>
            <option value="30">30×30</option>
            <option value="35">35×35</option>
            <option value="40">40×40</option>
            <option value="45">45×45</option>
            <option value="50">50×50</option>
        </select>
        <button id="popup-show-distortion-grid-btn" type="button">Show distortion grid</button>
    </div>
    <div id="popup-distortion-grid-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-distortion-grid-progress-text" style="margin-bottom: 6px;">Calculating grid distortion...</div>
        <progress id="popup-distortion-grid-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-distortion-grid"></div>
    </div>

    <script>
        function getWavelengthColorLocal(wavelength) {
            if (wavelength < 0.45) return '#8B00FF';
            if (wavelength < 0.495) return '#0000FF';
            if (wavelength < 0.57) return '#00FF00';
            if (wavelength < 0.59) return '#9ACD32';
            if (wavelength < 0.62) return '#FF8800';
            return '#FF0000';
        }

        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerGrid = getOpenerEl('grid-size-select');
            const popupGrid = document.getElementById('popup-distortion-grid-size');
            if (openerGrid && popupGrid) {
                popupGrid.value = openerGrid.value;
            }
        }

        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const grid = document.getElementById('popup-distortion-grid');
                if (grid) plotly.Plots.resize(grid);
            } catch (_) {}
        }

        async function plotGridLocal(data, targetEl, onProgress) {
            if (!window.Plotly || typeof window.Plotly.newPlot !== 'function') {
                throw new Error('Plotly is not available in distortion grid popup');
            }
            if (!data || !data.idealGrid || !data.realGrid) {
                throw new Error('Invalid grid distortion data');
            }

            const progress = (typeof onProgress === 'function') ? onProgress : null;
            const reportProgress = (percent, message) => {
                try { progress && progress({ percent, message }); } catch (_) {}
            };

            const idealGrid = data.idealGrid;
            const realGrid = data.realGrid;
            const gridSize = Number(data.gridSize) || 20;
            const meta = data.meta || {};
            const traces = [];

            for (let i = 0; i < gridSize; i++) {
                const startIdx = i * gridSize;
                const endIdx = startIdx + gridSize - 1;
                traces.push({
                    x: idealGrid.x.slice(startIdx, endIdx + 1),
                    y: idealGrid.y.slice(startIdx, endIdx + 1),
                    mode: 'lines',
                    line: { color: '#888888', width: 1 },
                    showlegend: i === 0,
                    name: i === 0 ? 'Ideal Grid' : undefined,
                    hoverinfo: 'skip',
                    type: 'scatter',
                });
                if ((i + 1) % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
            }

            for (let j = 0; j < gridSize; j++) {
                const xLine = [];
                const yLine = [];
                for (let i = 0; i < gridSize; i++) {
                    const idx = i * gridSize + j;
                    xLine.push(idealGrid.x[idx]);
                    yLine.push(idealGrid.y[idx]);
                }
                traces.push({
                    x: xLine,
                    y: yLine,
                    mode: 'lines',
                    line: { color: '#888888', width: 1 },
                    showlegend: false,
                    hoverinfo: 'skip',
                    type: 'scatter',
                });
                if ((j + 1) % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
            }

            const realX = [];
            const realY = [];
            const totalPoints = Math.max(1, Array.isArray(realGrid.x) ? realGrid.x.length : 0);
            for (let i = 0; i < totalPoints; i++) {
                const x = realGrid.x[i];
                const y = realGrid.y[i];
                const idealX = idealGrid.x[i];
                const idealY = idealGrid.y[i];
                if (x !== null && y !== null && x !== undefined && y !== undefined && isFinite(x) && isFinite(y) && isFinite(idealX) && isFinite(idealY)) {
                    realX.push(x);
                    realY.push(y);
                }
                reportProgress(((i + 1) / totalPoints) * 100, 'Grid distortion: ' + (i + 1) + '/' + totalPoints);
                if ((i + 1) % 50 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
            }

            traces.push({
                x: realX,
                y: realY,
                mode: 'markers',
                marker: {
                    color: getWavelengthColorLocal(Number(meta.wavelength || 0.5876)),
                    size: 4,
                    symbol: 'circle',
                    opacity: 0.8,
                },
                name: 'Real Positions (λ=' + Number(meta.wavelength || 0.5876).toFixed(4) + ' μm)',
                hovertemplate: 'Real: (%{x:.3f}, %{y:.3f}) mm<extra></extra>',
                type: 'scatter',
            });

            const maxAbsIdealX = idealGrid.x.reduce((m, v) => (isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
            const maxAbsIdealY = idealGrid.y.reduce((m, v) => (isFinite(v) ? Math.max(m, Math.abs(v)) : m), 0);
            const equalRangeHalf = Math.max(maxAbsIdealX, maxAbsIdealY, 1e-9);

            return window.Plotly.newPlot(targetEl, traces, {
                title: 'Grid Distortion (' + gridSize + '×' + gridSize + ', λ=' + Number(meta.wavelength || 0.5876).toFixed(4) + ' μm)',
                xaxis: { title: 'Image Height X (mm)', scaleanchor: 'y', scaleratio: 1, zeroline: false, range: [-equalRangeHalf, equalRangeHalf] },
                yaxis: { title: 'Image Height Y (mm)', zeroline: false, range: [-equalRangeHalf, equalRangeHalf] },
                hovermode: 'closest',
                showlegend: true,
                legend: { x: 1.02, y: 1 },
                autosize: true,
                margin: { l: 60, r: 120, t: 50, b: 50 },
            }, { responsive: true, displayModeBar: true, displaylogo: false });
        }

        window['renderDistortionGrid'] = async () => {
            if (window.__distortionGridRenderInFlight) return;
            window.__distortionGridRenderInFlight = true;
            const gridEl = document.getElementById('popup-distortion-grid');
            const gridBtn = document.getElementById('popup-show-distortion-grid-btn');
            if (gridBtn) gridBtn.disabled = true;
            if (gridEl) gridEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-distortion-grid-progress-wrapper');
            const progressBarEl = document.getElementById('popup-distortion-grid-progressbar');
            const progressTextEl = document.getElementById('popup-distortion-grid-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const gridSizeEl = document.getElementById('popup-distortion-grid-size');
            const gridSize = gridSizeEl ? parseInt(gridSizeEl.value, 10) : 20;
            const openerGrid = getOpenerEl('grid-size-select');
            if (openerGrid && Number.isFinite(gridSize)) openerGrid.value = String(gridSize);
            let renderSucceeded = false;

            try {
                if (!window.opener || typeof window.opener.runPortableGridDistortionForPopup !== 'function') {
                    throw new Error('runPortableGridDistortionForPopup is not available on opener');
                }
                setProgress(0, 'Starting...');
                await new Promise((resolve) => setTimeout(resolve, 0));
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                const data = await window.opener.runPortableGridDistortionForPopup({ gridSize: Number.isFinite(gridSize) ? gridSize : 20, onProgress });
                await plotGridLocal(data, gridEl, onProgress);
                renderSucceeded = true;
                setTimeout(resizePlot, 0);
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (gridEl) {
                    gridEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate grid distortion. Check console.</div>';
                }
            } finally {
                window.__distortionGridRenderInFlight = false;
                if (gridBtn) gridBtn.disabled = false;
                if (renderSucceeded && progressWrapper) {
                    setTimeout(() => {
                        try { progressWrapper.style.display = 'none'; } catch (_) {}
                    }, 250);
                }
            }
        };

        document.getElementById('popup-show-distortion-grid-btn').addEventListener('click', () => window.renderDistortionGrid());
        window.addEventListener('resize', resizePlot);
        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Magnification Chromatic Aberration popup window button
        const openMagnificationChromaticAberrationWindowBtn = document.getElementById('open-magnification-chromatic-aberration-window-btn');
        if (openMagnificationChromaticAberrationWindowBtn) {
                openMagnificationChromaticAberrationWindowBtn.addEventListener('click', () => {
                        if (w.__magnificationChromaticAberrationPopup && !w.__magnificationChromaticAberrationPopup.closed) {
                                try { w.__magnificationChromaticAberrationPopup.focus(); } catch (_) {}
                                try {
                                        if (typeof w.__magnificationChromaticAberrationPopup.renderMagnificationChromaticAberration === 'function') {
                                                w.__magnificationChromaticAberrationPopup.renderMagnificationChromaticAberration();
                                        }
                                } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Lateral Chromatic Aberration', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__magnificationChromaticAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Lateral Chromatic Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            width: 90px;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-mca-container { flex: 1 1 auto; min-height: 0; }
        .note { padding: 6px 12px; font-size: 12px; color: #666; background: #fff; border-bottom: 1px solid #eee; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-mca-xmin">Lateral displacement:</label>
        <input type="number" id="popup-mca-xmin" value="-0.05" step="0.01" />
        <span style="font-size:12px;color:#333;">to</span>
        <input type="number" id="popup-mca-xmax" value="0.05" step="0.01" />
        <span style="font-size:12px;color:#666;">(mm)</span>
        <label for="popup-mca-points" style="margin-left:6px;">Points:</label>
        <input type="number" id="popup-mca-points" value="21" min="2" max="201" step="1" />
        <label for="popup-mca-chief-ray" style="margin-left:6px;">Chief ray:</label>
        <select id="popup-mca-chief-ray" style="padding:5px 8px;font-size:12px;border:1px solid #bbb;border-radius:4px;background:white;">
            <option value="stop-center">Stop center</option>
            <option value="beam-midpoint">Beam midpoint</option>
            <option value="beam-centroid">Beam centroid</option>
        </select>
        <button id="popup-show-mca-btn" type="button">Show lateral chromatic aberration</button>
    </div>
    <div id="popup-mca-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-mca-progress-text" style="margin-bottom: 6px;">Calculating lateral chromatic aberration...</div>
        <progress id="popup-mca-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-mca-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerMin = getOpenerEl('mca-xmin-input');
            const openerMax = getOpenerEl('mca-xmax-input');
            const openerPoints = getOpenerEl('mca-point-count-input');
            const popupMin = document.getElementById('popup-mca-xmin');
            const popupMax = document.getElementById('popup-mca-xmax');
            const popupPoints = document.getElementById('popup-mca-points');
            if (openerMin && popupMin && openerMin.value !== '') popupMin.value = openerMin.value;
            if (openerMax && popupMax && openerMax.value !== '') popupMax.value = openerMax.value;
            if (openerPoints && popupPoints && openerPoints.value !== '') popupPoints.value = openerPoints.value;
        }

        window['renderMagnificationChromaticAberration'] = async () => {
            const containerEl = document.getElementById('popup-mca-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-mca-progress-wrapper');
            const progressBarEl = document.getElementById('popup-mca-progressbar');
            const progressTextEl = document.getElementById('popup-mca-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            const xMinEl = document.getElementById('popup-mca-xmin');
            const xMaxEl = document.getElementById('popup-mca-xmax');
            const pointEl = document.getElementById('popup-mca-points');
            const chiefRayEl = document.getElementById('popup-mca-chief-ray');
            const xMin = xMinEl ? parseFloat(xMinEl.value) : -0.5;
            const xMax = xMaxEl ? parseFloat(xMaxEl.value) : 0.5;
            const pointCount = pointEl ? parseInt(pointEl.value, 10) : 11;
            const chiefRayDefinition = (chiefRayEl && chiefRayEl.value) ? chiefRayEl.value : 'stop-center';

            try {
                if (!window.opener || typeof window.opener.showMagnificationChromaticAberrationDiagram !== 'function') {
                    throw new Error('showMagnificationChromaticAberrationDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.showMagnificationChromaticAberrationDiagram({
                    containerElement: containerEl,
                    xMin,
                    xMax,
                    pointCount,
                    chiefRayDefinition,
                    onProgress
                });
                hideProgress();
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate magnification chromatic aberration. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-mca-btn').addEventListener('click', () => window.renderMagnificationChromaticAberration());
        window.addEventListener('focus', syncFromOpener);
        window.addEventListener('load', () => {
            syncFromOpener();
            try { window.renderMagnificationChromaticAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Integrated Aberration popup window button
        const openIntegratedAberrationWindowBtn = document.getElementById('open-integrated-aberration-window-btn');
        if (openIntegratedAberrationWindowBtn) {
                openIntegratedAberrationWindowBtn.addEventListener('click', () => {
                        if (w.__integratedAberrationPopup && !w.__integratedAberrationPopup.closed) {
                                try { w.__integratedAberrationPopup.focus(); } catch (_) {}
                                try {
                                        if (typeof w.__integratedAberrationPopup.renderIntegratedAberration === 'function') {
                                                w.__integratedAberrationPopup.renderIntegratedAberration();
                                        }
                                } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Integrated Aberration', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__integratedAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Integrated Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-integrated-aberration-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div id="popup-integrated-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <progress id="popup-integrated-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-integrated-aberration-container"></div>
    </div>

    <script>
        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const el = document.getElementById('popup-integrated-aberration-container');
                if (el) plotly.Plots.resize(el);
            } catch (_) {}
        }

        window['renderIntegratedAberration'] = async () => {
            const containerEl = document.getElementById('popup-integrated-aberration-container');
            if (containerEl) containerEl.innerHTML = '';
            resizePlot();

            const progressWrapper = document.getElementById('popup-integrated-progress-wrapper');
            const progressBarEl = document.getElementById('popup-integrated-progressbar');
            const progressTextEl = document.getElementById('popup-integrated-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressBarEl && Number.isFinite(value)) progressBarEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            try {
                if (!window.opener || typeof window.opener.showIntegratedAberrationDiagram !== 'function') {
                    throw new Error('showIntegratedAberrationDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                const onProgress = (evt) => {
                    try {
                        const p = Number(evt?.percent);
                        const msg = evt?.message || evt?.phase || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };
                await window.opener.showIntegratedAberrationDiagram({
                    containerElement: containerEl,
                    onProgress,
                    useActiveConfigSnapshot: true
                });
                hideProgress();
                resizePlot();
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate integrated aberration diagram. Check console.</div>';
                }
            }
        };

        window.addEventListener('resize', resizePlot);

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderIntegratedAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Optical Path Difference (OPD) popup window button
        const openOpdWindowBtn = document.getElementById('open-opd-window-btn');
        if (openOpdWindowBtn) {
                openOpdWindowBtn.addEventListener('click', () => {
                        if (w.__opdPopup && !w.__opdPopup.closed) {
                    // Always reopen fresh so stale about:blank popup code can't persist.
                    try { w.__opdPopup.close(); } catch (_) {}
                    w.__opdPopup = null;
                        }

                        const popup = consumePreopenedAnalysisPopup('Optical Path Difference', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__opdPopup = popup;

                        try { popup.document.open(); } catch (_) {}

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Optical Path Difference</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-wavefront-container { flex: 1 1 auto; min-height: 0; }
        #popup-wavefront-container-stats { flex: 0 0 auto; padding: 8px 12px; font-size: 12px; color: #333; border-top: 1px solid #eee; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-wavefront-object-select">Object:</label>
        <select id="popup-wavefront-object-select"></select>
        <label for="popup-wavefront-plot-type-select">Plot type:</label>
        <select id="popup-wavefront-plot-type-select">
            <option value="surface">3D Surface</option>
            <option value="heatmap">Heatmap</option>
            <option value="multifield">Multi-field Comparison</option>
        </select>
        <label for="popup-wavefront-grid-size-select">Grid size:</label>
        <select id="popup-wavefront-grid-size-select">
            <option value="32">32x32</option>
            <option value="64">64x64</option>
            <option value="128">128x128</option>
            <option value="256" selected>256x256</option>
            <option value="512">512x512</option>
            <option value="1024">1024x1024</option>
            <option value="2048">2048x2048</option>
            <option value="4096">4096x4096</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-zernike-fit-checkbox" type="checkbox" />
            Zernike (calc)
        </label>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-opd-remove-ptd-checkbox" type="checkbox" />
            Remove P/T/D
        </label>
        <button id="popup-show-wavefront-btn" type="button">Show wavefront diagram</button>
        <button id="popup-stop-opd-btn" type="button" disabled>Stop</button>
    </div>
    <div id="popup-opd-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-opd-progress-text" style="margin-bottom: 6px;">Calculating OPD...</div>
        <progress id="popup-opd-progressbar" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-wavefront-container"></div>
        <div id="popup-wavefront-container-stats"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncObjectOptionsFromOpener() {
            const openerSelect = getOpenerEl('wavefront-object-select');
            const popupSelect = document.getElementById('popup-wavefront-object-select');
            if (!popupSelect) return;

            const current = popupSelect.value;
            const nextOptions = [];

            // MTF-style: build from opener.getObjectRows() first.
            let opener = null;
            try { opener = window.opener || null; } catch (_) { opener = null; }
            let objects = [];
            if (opener && typeof opener.getObjectRows === 'function') {
                try { objects = opener.getObjectRows(opener.tableObject); } catch (_) { objects = []; }
            }
            if (Array.isArray(objects) && objects.length > 0) {
                const toFiniteNumber = (v) => {
                    const n = (typeof v === 'number') ? v : parseFloat(v);
                    return (Number.isFinite(n) ? n : NaN);
                };
                const pickNumber = (obj, keys, fallback) => {
                    for (let i = 0; i < keys.length; i++) {
                        const k = keys[i];
                        if (!k) continue;
                        const raw = obj ? obj[k] : undefined;
                        if (raw === undefined || raw === null || raw === '') continue;
                        const n = toFiniteNumber(raw);
                        if (Number.isFinite(n)) return n;
                    }
                    return fallback;
                };
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(obj.position ?? obj.object ?? obj.Object ?? obj.objectType ?? 'Point');
                    const x = (obj.x ?? obj.xHeightAngle ?? 0);
                    const y = (obj.y ?? obj.yHeightAngle ?? 0);
                    nextOptions.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }

            // Fallback: clone opener select.
            if (nextOptions.length === 0 && openerSelect && openerSelect.options) {
                Array.from(openerSelect.options).forEach(opt => {
                    nextOptions.push({ value: String(opt.value), label: String(opt.textContent ?? '') });
                });
            }
            // Last fallback: placeholder + schedule a retry (opener tables may not be ready yet).
            if (nextOptions.length === 0) {
                nextOptions.push({ value: '0', label: '1' });
                setTimeout(() => {
                    try { syncObjectOptionsFromOpener(); } catch (_) {}
                }, 250);
            }

            popupSelect.innerHTML = '';
            for (const opt of nextOptions) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                popupSelect.appendChild(o);
            }

            if (current && Array.from(popupSelect.options).some(o => o.value === current)) {
                popupSelect.value = current;
            } else if (openerSelect && openerSelect.value && Array.from(popupSelect.options).some(o => o.value === openerSelect.value)) {
                popupSelect.value = openerSelect.value;
            } else {
                popupSelect.value = popupSelect.options[0]?.value ?? '0';
            }

            try {
                if (typeof window.__opdStage === 'function') {
                    window.__opdStage('Object options synchronized', 'count=' + popupSelect.options.length + ', selected=' + String(popupSelect.value ?? 'n/a'));
                }
            } catch (_) {}
        }

        function syncInputsFromOpener() {
            const openerPlotType = getOpenerEl('wavefront-plot-type-select');
            const openerGrid = getOpenerEl('wavefront-grid-size-select');
            const openerRemovePtd = getOpenerEl('opd-remove-ptd-checkbox');
            const popupPlotType = document.getElementById('popup-wavefront-plot-type-select');
            const popupGrid = document.getElementById('popup-wavefront-grid-size-select');
            const popupRemovePtd = document.getElementById('popup-opd-remove-ptd-checkbox');
            if (openerPlotType && popupPlotType) popupPlotType.value = openerPlotType.value;
            if (openerGrid && popupGrid) popupGrid.value = openerGrid.value;
            if (popupRemovePtd) popupRemovePtd.checked = !!(openerRemovePtd && openerRemovePtd.checked);
        }

        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const el = document.getElementById('popup-wavefront-container');
                if (el) plotly.Plots.resize(el);
            } catch (_) {}
        }

        function createStageTraceHelpers() {
            const clear = (_label = 'Idle') => {};
            const push = (_stage, _detail = '', _level = 'info') => {};
            const pushWarn = (_stage, _detail = '') => {};

            return { clear, push, pushWarn };
        }

        const opdStageTrace = createStageTraceHelpers();
        window.__opdStage = opdStageTrace.push;

        window['renderOPD'] = async () => {
            const containerEl = document.getElementById('popup-wavefront-container');
            if (containerEl) containerEl.innerHTML = '';

            try {
                opdStageTrace.clear('Preparing...');
                opdStageTrace.push('Render requested');
            } catch (_) {}

            const progressWrapper = document.getElementById('popup-opd-progress-wrapper');
            const progressBarEl = document.getElementById('popup-opd-progressbar');
            const progressTextEl = document.getElementById('popup-opd-progress-text');
            const PROGRESS_UI_UPDATE_INTERVAL_MS = 120;
            let lastProgressPercent = null;
            let lastProgressText = null;
            let progressVisible = false;
            let lastProgressUiUpdateAt = 0;
            let pendingProgressEvent = null;
            let progressFlushTimer = null;
            let lastComputingMilestone = 0;

            const setProgress = (value, text, force = false) => {
                try {
                    if (progressWrapper && !progressVisible) {
                        progressWrapper.style.display = 'block';
                        progressVisible = true;
                    }

                    if (progressBarEl && Number.isFinite(value)) {
                        const nextValue = Math.max(0, Math.min(100, value));
                        if (force || !Number.isFinite(lastProgressPercent) || Math.abs(nextValue - lastProgressPercent) >= 0.001) {
                            progressBarEl.value = nextValue;
                            lastProgressPercent = nextValue;
                        }
                    }

                    if (progressTextEl && typeof text === 'string') {
                        if (force || text !== lastProgressText) {
                            progressTextEl.textContent = text;
                            lastProgressText = text;
                        }
                    }
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                    progressVisible = false;
                } catch (_) {}
            };

            const flushPendingProgress = (force = false) => {
                if (progressFlushTimer) {
                    clearTimeout(progressFlushTimer);
                    progressFlushTimer = null;
                }
                const evt = pendingProgressEvent;
                if (!evt) return;
                pendingProgressEvent = null;
                const p = Number(evt?.percent);
                const msg = evt?.message || evt?.phase || 'Working...';
                if (Number.isFinite(p)) setProgress(p, msg, force);
                else setProgress(undefined, msg, force);
                lastProgressUiUpdateAt = Date.now();
            };

            const popupObject = document.getElementById('popup-wavefront-object-select');
            const popupPlotType = document.getElementById('popup-wavefront-plot-type-select');
            const popupGrid = document.getElementById('popup-wavefront-grid-size-select');
            const popupZernikeFit = document.getElementById('popup-zernike-fit-checkbox');
            const popupRemovePtd = document.getElementById('popup-opd-remove-ptd-checkbox');

            try {
                if (!popupObject) {
                    opdStageTrace.push('Object selector missing', 'popup-wavefront-object-select not found; fallback index=0');
                } else {
                    opdStageTrace.push('Object selector ready', 'options=' + String(popupObject.options?.length ?? 0));
                }
            } catch (_) {}

            const objectIndex = (() => {
                if (!popupObject) return 0;
                const v = parseInt(String(popupObject.value), 10);
                if (Number.isFinite(v)) return v;
                const idx = Number(popupObject.selectedIndex);
                return Number.isFinite(idx) && idx >= 0 ? idx : 0;
            })();
            const plotType = popupPlotType ? popupPlotType.value : 'surface';
            const gridSize = popupGrid ? parseInt(popupGrid.value, 10) : 256;
            const opdDisplayMode = (popupRemovePtd && popupRemovePtd.checked)
                ? 'pistonTiltDefocusRemoved'
                : 'pistonTiltRemoved';

            try {
                opdStageTrace.push('Input resolved', 'object=' + String(objectIndex) + ', plot=' + String(plotType) + ', grid=' + String(gridSize) + ', mode=' + String(opdDisplayMode));
            } catch (_) {}

            try {
                const optionCount = Number(popupObject?.options?.length ?? 0);
                const selectedText = popupObject?.selectedOptions?.[0]?.textContent || popupObject?.options?.[popupObject?.selectedIndex || 0]?.textContent || '';
                const inRange = optionCount <= 0 ? true : (objectIndex >= 0 && objectIndex < optionCount);
                if (!inRange) {
                    opdStageTrace.push('Object index out of range', 'index=' + String(objectIndex) + ', options=' + String(optionCount));
                } else {
                    opdStageTrace.push('Object resolved', 'index=' + String(objectIndex) + (selectedText ? (', label=' + String(selectedText)) : ''));
                }
            } catch (_) {}

            const openerObject = getOpenerEl('wavefront-object-select');
            const openerPlotType = getOpenerEl('wavefront-plot-type-select');
            const openerGrid = getOpenerEl('wavefront-grid-size-select');
            const openerRemovePtd = getOpenerEl('opd-remove-ptd-checkbox');
            if (openerObject && Number.isFinite(objectIndex)) openerObject.value = String(objectIndex);
            if (openerPlotType) openerPlotType.value = plotType;
            if (openerGrid && Number.isFinite(gridSize)) openerGrid.value = String(gridSize);
            if (openerRemovePtd) openerRemovePtd.checked = (opdDisplayMode === 'pistonTiltDefocusRemoved');

            try {
                const openerSyncOk = !!openerObject;
                if (openerSyncOk) {
                    opdStageTrace.push('Opener sync', 'object=' + String(objectIndex));
                } else {
                    opdStageTrace.pushWarn('Opener sync', 'opener object selector not found');
                }
            } catch (_) {}

            try {
                const computeInPopup = false;
                
                // Create cancel token (reuse PSF helper if available, or inline)
                const createCancelToken = window.opener.createCancelToken || (() => {
                    let aborted = false;
                    let reason = null;
                    const listeners = [];
                    return {
                        get aborted() { return aborted; },
                        get reason() { return reason; },
                        abort(r = 'User requested stop') {
                            if (aborted) return;
                            aborted = true;
                            reason = r;
                            listeners.forEach(fn => { try { fn(r); } catch (_) {} });
                        },
                        onAbort(fn) { listeners.push(fn); }
                    };
                });
                
                const popupCancelToken = createCancelToken();
                window['__popupOpdCancelToken'] = popupCancelToken;
                
                const stopBtn = document.getElementById('popup-stop-opd-btn');
                
                
                if (stopBtn) {
                    stopBtn.disabled = false;
                    stopBtn.textContent = 'Stop';
                }

                setProgress(0, 'Starting...');

                const opener = window.opener;
                const shouldUseDesktopRust = (() => {
                    try {
                        if (typeof window !== 'undefined' && typeof window['shouldUseDesktopRustAnalysis'] === 'function') {
                            return !!window['shouldUseDesktopRustAnalysis']();
                        }
                        if (opener && typeof opener.shouldUseDesktopRustAnalysis === 'function') {
                            return !!opener.shouldUseDesktopRustAnalysis();
                        }
                        return true;
                    } catch (_) {
                        return false;
                    }
                })();

                const canUseDesktopRust = shouldUseDesktopRust && !!(
                    opener
                    && typeof opener.showWavefrontDiagram === 'function'
                );
                const canUseWavefront = !!(
                    opener
                    && typeof opener.showWavefrontDiagram === 'function'
                );

                try {
                    opdStageTrace.push('Runtime check', 'desktopRust=' + String(!!canUseDesktopRust));
                } catch (_) {}

                if (!canUseWavefront) {
                    try { opdStageTrace.push('Blocked', 'Wavefront renderer unavailable on opener'); } catch (_) {}
                    throw new Error('OPD renderer is unavailable on opener window.');
                }

                try {
                    if (popupObject && popupObject.options && popupObject.options.length > 0) {
                        const optionCount = popupObject.options.length;
                        if (objectIndex < 0 || objectIndex >= optionCount) {
                            opdStageTrace.push('Blocked', 'Object index is invalid for current options');
                        }
                    }
                } catch (_) {}

                // NOTE: Wavefront generator supports only options.onProgress (same as PSF)
                const onProgress = (evt) => {
                    try {
                        pendingProgressEvent = evt;
                        const pct = Number(evt?.percent);
                        if (Number.isFinite(pct)) {
                            const msg = String(evt?.message || evt?.phase || 'working');
                            const milestones = [25, 50, 75, 100];
                            for (const milestone of milestones) {
                                if (milestone > lastComputingMilestone && pct >= (milestone - 0.001)) {
                                    opdStageTrace.push('Computing', msg + ' (' + String(milestone) + '%)');
                                    lastComputingMilestone = milestone;
                                }
                            }
                        }
                        const now = Date.now();
                        const elapsed = now - lastProgressUiUpdateAt;
                        if (elapsed >= PROGRESS_UI_UPDATE_INTERVAL_MS) {
                            flushPendingProgress(false);
                            return;
                        }

                        if (!progressFlushTimer) {
                            const delay = Math.max(0, PROGRESS_UI_UPDATE_INTERVAL_MS - elapsed);
                            progressFlushTimer = setTimeout(() => {
                                progressFlushTimer = null;
                                flushPendingProgress(false);
                            }, delay);
                        }
                    } catch (_) {}
                };
                
                try {
                    if (!window.opener || typeof window.opener.showWavefrontDiagram !== 'function') {
                        try { opdStageTrace.push('Blocked', 'showWavefrontDiagram is unavailable'); } catch (_) {}
                        throw new Error('showWavefrontDiagram is not available on opener');
                    }
                    try { opdStageTrace.push('Wavefront call started', 'Delegating to opener.showWavefrontDiagram'); } catch (_) {}
                    const wavefrontResult = await window.opener.showWavefrontDiagram(plotType, 'opd', Number.isFinite(gridSize) ? gridSize : 256, Number.isFinite(objectIndex) ? objectIndex : 0, {
                        containerElement: containerEl,
                        cancelToken: popupCancelToken,
                        onProgress,
                        opdDisplayMode,
                        forceRustWasm: true,
                        throwOnError: true,
                        showAlert: false
                    });
                    if (wavefrontResult?.error) {
                        throw new Error(String(wavefrontResult?.error?.message || wavefrontResult?.error || 'Wavefront plot failed'));
                    }
                    if (lastComputingMilestone < 100) {
                        try {
                            const completionMilestones = [25, 50, 75, 100];
                            for (const milestone of completionMilestones) {
                                if (milestone > lastComputingMilestone) {
                                    const detail = (milestone === 100)
                                        ? 'Plot data prepared (100%)'
                                        : ('Progress checkpoint (' + String(milestone) + '%)');
                                    opdStageTrace.push('Computing', detail);
                                    lastComputingMilestone = milestone;
                                }
                            }
                        } catch (_) {}
                    }
                    try { opdStageTrace.push('Wavefront call completed', 'Plot render returned'); } catch (_) {}

                    // Optional: Zernike fit + push report to System Data
                    const shouldZernikeFit = !!(popupZernikeFit && popupZernikeFit.checked);
                    if (shouldZernikeFit) {
                        try {
                            if (String(plotType) === 'multifield') {
                                try { opdStageTrace.push('Zernike skipped', 'Not supported for multi-field'); } catch (_) {}
                                setProgress(100, 'Zernike fit is not available for Multi-field');
                            } else {
                                try { opdStageTrace.push('Zernike started'); } catch (_) {}
                                setProgress(98, 'Zernike fitting...');

                                const opener = window.opener;
                                const map = opener ? getLastWavefrontMap(opener) : null;
                                const meta = opener ? getLastWavefrontMeta(opener) : null;
                                if (!map || map?.error) {
                                    throw new Error('No valid wavefrontMap to fit');
                                }

                                const coordsAll = Array.isArray(map?.pupilCoordinates) ? map.pupilCoordinates : [];
                                const opdsAll = Array.isArray(map?.raw?.opds) ? map.raw.opds : (Array.isArray(map?.opds) ? map.opds : []);
                                const n = Math.min(coordsAll.length, opdsAll.length);
                                if (!n) {
                                    throw new Error('No OPD samples found');
                                }

                                // Filter out invalid samples for fitting
                                const coords = [];
                                const opds = [];
                                for (let i = 0; i < n; i++) {
                                    const c = coordsAll[i];
                                    const v = opdsAll[i];
                                    const x = Number(c?.x);
                                    const y = Number(c?.y);
                                    const opd = Number(v);
                                    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(opd)) continue;
                                    coords.push({ x, y });
                                    opds.push(opd);
                                }
                                if (coords.length < 5) {
                                    throw new Error('Not enough valid samples for Zernike fitting');
                                }

                                const wavelength = (() => {
                                    const fromMeta = Number(meta?.wavelength);
                                    if (Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
                                    try {
                                        const w = Number(opener?.getPrimaryWavelength?.());
                                        if (Number.isFinite(w) && w > 0) return w;
                                    } catch (_) {}
                                    throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
                                })();

                                const opticalSystemRows = (typeof opener?.getOpticalSystemRows === 'function')
                                    ? opener.getOpticalSystemRows()
                                    : null;
                                const host = opener || window;
                                const calculatorFactory =
                                    (host && typeof host.createOPDCalculator === 'function' && host.createOPDCalculator)
                                    || (typeof window.createOPDCalculator === 'function' && window.createOPDCalculator)
                                    || (typeof createOPDCalculator === 'function' ? createOPDCalculator : null);
                                const analyzerFactory =
                                    (host && typeof host.createWavefrontAnalyzer === 'function' && host.createWavefrontAnalyzer)
                                    || (typeof window.createWavefrontAnalyzer === 'function' && window.createWavefrontAnalyzer)
                                    || (typeof createWavefrontAnalyzer === 'function' ? createWavefrontAnalyzer : null);
                                const calculator = calculatorFactory ? calculatorFactory(opticalSystemRows, wavelength) : null;
                                const analyzer = (calculator && analyzerFactory) ? analyzerFactory(calculator) : null;

                                if (!analyzer || typeof analyzer.fitZernikePolynomials !== 'function' || typeof analyzer.formatZernikeReportText !== 'function') {
                                    throw new Error('Wavefront analyzer is not available for Zernike fitting');
                                }

                                const maxNoll = Math.max(1, Math.min(37, opds.length));
                                const fit = analyzer.fitZernikePolynomials({ pupilCoordinates: coords, opds }, maxNoll);

                                // Store coefficients for the main window Zernike Fit button
                                try {
                                    patchLastWavefrontMap((current) => {
                                        current.zernike = fit;
                                        current.statistics = current.statistics || (map.statistics || {});
                                        current.statistics.skipZernikeFit = false;
                                    }, { host: opener, fallbackMap: map });
                                } catch (_) {}

                                // Build a lightweight report map so formatting can rely on aligned sample arrays
                                const reportMap = {
                                    ...map,
                                    pupilCoordinates: coords,
                                    raw: { ...(map.raw || {}), opds },
                                    opds,
                                    zernike: fit
                                };

                                const reportText = analyzer.formatZernikeReportText(reportMap, { maxNoll });

                                const pushSystemData = (text) => {
                                    try {
                                        const ta = opener?.document?.getElementById?.('system-data');
                                        if (!ta || typeof ta.value !== 'string') return false;
                                        // Replace (clear then push) so each run shows only the latest report.
                                        ta.value = String(text || '');
                                        return true;
                                    } catch (_) {
                                        return false;
                                    }
                                };

                                const tryOpenSystemDataWindow = () => {
                                    try {
                                        const w = opener?.__systemDataPopup;
                                        if (w && !w.closed) {
                                            try { w.focus(); } catch (_) {}
                                            return true;
                                        }
                                    } catch (_) {}

                                    // Some browsers block popups triggered by synthetic clicks.
                                    // We still try the main-window button first, but fall back to
                                    // opening the System Data window directly from this user action.
                                    try {
                                        const btn = opener?.document?.getElementById?.('open-system-data-window-btn');
                                        if (btn) {
                                            btn.click();
                                            // If the click worked, the opener should set __systemDataPopup.
                                            try {
                                                const w = opener?.__systemDataPopup;
                                                if (w && !w.closed) {
                                                    try { w.focus(); } catch (_) {}
                                                    return true;
                                                }
                                            } catch (_) {}
                                        }
                                    } catch (_) {}

                                    // Fallback: open and render a minimal System Data popup directly.
                                    try {
                                        const popup = opener?.open?.('', 'System Data', 'width=1200,height=600');
                                        if (!popup) return false;
                                        try { opener.__systemDataPopup = popup; } catch (_) {}
                                        try { popup.document.open(); } catch (_) {}

                                        const html = [
                                            '<!DOCTYPE html>',
                                            '<html>',
                                            '<head>',
                                            '  <meta charset="UTF-8" />',
                                            '  <title>System Data</title>',
                                            '  <style>',
                                            '    html, body { height: 100%; }',
                                            '    body { margin: 0; font-family: Arial, sans-serif; display: flex; flex-direction: column; height: 100vh; background: #f4f4f4; }',
                                            '    .header { padding: 10px 12px; background: white; color: #333; font-weight: 600; border-bottom: 1px solid #ddd; }',
                                            '    .content { flex: 1 1 auto; padding: 10px 12px; min-height: 0; display: flex; }',
                                            '    textarea { flex: 1 1 auto; width: 100%; resize: none; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; line-height: 1.4; border: 1px solid #bbb; border-radius: 4px; padding: 10px; box-sizing: border-box; min-height: 0; background: white; }',
                                            '  </style>',
                                            '</head>',
                                            '<body onload="(function(){function getOpenerEl(id){try{return window.opener&&window.opener.document?window.opener.document.getElementById(id):null;}catch(e){return null;}}function sync(){var src=getOpenerEl(\\\'system-data\\\');var dst=document.getElementById(\\\'popup-system-data\\\');if(dst&&src&&dst.value!==src.value){dst.value=src.value;}}setInterval(sync,500);window.addEventListener(\\\'focus\\\',sync);sync();})();">',
                                            '  <div class="header">System Data</div>',
                                            '  <div class="content">',
                                            '    <textarea id="popup-system-data" placeholder="System information will appear here..."></textarea>',
                                            '  </div>',
                                            '</body>',
                                            '</html>'
                                        ].join('\\n');

                                        popup.document.write(html);
                                        try { popup.document.close(); } catch (_) {}
                                        try { popup.focus(); } catch (_) {}
                                        return true;
                                    } catch (_) {}

                                    return false;
                                };

                                const pushed = pushSystemData(reportText);
                                const opened = tryOpenSystemDataWindow();
                                if (pushed && opened) {
                                    try { opdStageTrace.push('Zernike completed', 'Report pushed to System Data'); } catch (_) {}
                                    setProgress(100, 'Zernike report pushed to System Data');
                                } else if (pushed) {
                                    try { opdStageTrace.push('Zernike completed', 'Report pushed, popup open skipped'); } catch (_) {}
                                    setProgress(100, 'Zernike report pushed. See System data.');
                                } else {
                                    try { opdStageTrace.push('Zernike partial', 'Could not push report to System Data'); } catch (_) {}
                                    setProgress(100, 'Zernike fit done (could not write System Data). See System data.');
                                }
                            }
                        } catch (e) {
                            try { opdStageTrace.push('Zernike failed', String(e?.message || e || 'unknown error')); } catch (_) {}
                            setProgress(100, 'Zernike fit failed. See console.');
                        }
                    }

                    flushPendingProgress(true);
                    resizePlot();
                    try { opdStageTrace.push('Render complete'); } catch (_) {}
                } catch (err) {
                    if (err?.message?.includes('Cancelled')) {
                        flushPendingProgress(true);
                        setProgress(100, 'Cancelled');
                        try { opdStageTrace.push('Cancelled', 'Stopped by user'); } catch (_) {}
                        console.log('🛑 OPD calculation cancelled by user');
                    } else {
                        try {
                            const em = String(err?.message || err || 'unknown error').toLowerCase();
                            if (em.includes('object')) {
                                opdStageTrace.push('Object-stage failure', String(err?.message || err || 'unknown error'));
                            }
                        } catch (_) {}
                        try { opdStageTrace.push('Wavefront call failed', String(err?.message || err || 'unknown error')); } catch (_) {}
                        throw err;
                    }
                } finally {
                    flushPendingProgress(true);
                    setTimeout(() => {
                        try { hideProgress(); } catch (_) {}
                    }, 250);
                    if (stopBtn) {
                        stopBtn.disabled = true;
                        stopBtn.textContent = 'Stop';
                    }
                    window['__popupOpdCancelToken'] = null;
                }
            } catch (err) {
                console.error(err);
                flushPendingProgress(true);
                setProgress(100, 'Failed');
                try { opdStageTrace.push('Failed', String(err?.message || err || 'unknown error')); } catch (_) {}
                setTimeout(() => {
                    try { hideProgress(); } catch (_) {}
                }, 600);
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate OPD diagram. Check console.</div>';
                }
            }
        };

        document.getElementById('popup-show-wavefront-btn').addEventListener('click', () => window.renderOPD());
        document.getElementById('popup-stop-opd-btn').addEventListener('click', () => {
            console.log('🛑 Popup OPD Stop button clicked');
            const token = window.__popupOpdCancelToken;
            if (token && typeof token.abort === 'function') {
                token.abort('Stopped by user');
                const stopBtn = document.getElementById('popup-stop-opd-btn');
                if (stopBtn) {
                    stopBtn.disabled = true;
                    stopBtn.textContent = 'Stopping...';
                }
            }
        });

        function syncAll() {
            syncObjectOptionsFromOpener();
            syncInputsFromOpener();
        }
        window.addEventListener('resize', resizePlot);
        window.addEventListener('focus', syncAll);
        syncAll();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Point Spread Function popup window button
        const openPsfWindowBtn = document.getElementById('open-psf-window-btn');
        if (openPsfWindowBtn) {
                openPsfWindowBtn.addEventListener('click', () => {
                        if (w.__psfPopup && !w.__psfPopup.closed) {
                                // Always reopen fresh so stale about:blank popup code can't persist.
                                try { w.__psfPopup.close(); } catch (_) {}
                                w.__psfPopup = null;
                        }

                        const popup = consumePreopenedAnalysisPopup('Point Spread Function', 'width=800,height=600');
                        if (!popup || !popup.document) {
                            try { popup?.close(); } catch (_) {}
                            alert('Popup could not be opened. Please allow popups for this site.');
                            return;
                        }
                        w.__psfPopup = popup;

                        const collectObjectRowsForPsfPopup = (): any[] => {
                            try {
                                if (w.tableObject && typeof w.tableObject.getData === 'function') {
                                    const rows = w.tableObject.getData();
                                    if (Array.isArray(rows) && rows.length > 0) return rows;
                                }
                            } catch (_) {}
                            try {
                                if (typeof w.getObjectRows === 'function') {
                                    const rows = w.getObjectRows(w.tableObject);
                                    if (Array.isArray(rows) && rows.length > 0) return rows;
                                }
                            } catch (_) {}
                            try {
                                const raw = localStorage.getItem('objectTableData');
                                const parsed = raw ? JSON.parse(raw) : null;
                                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
                            } catch (_) {}
                            try {
                                if (typeof w.loadSystemConfigurations === 'function') {
                                    const all = w.loadSystemConfigurations();
                                    const list = Array.isArray(all && all.configurations) ? all.configurations : [];
                                    const activeId = Number(all && all.activeConfigId);
                                    const active = Number.isFinite(activeId)
                                        ? (list.find((c: any) => Number(c && c.id) === activeId) || null)
                                        : (list[0] || null);
                                    const rows = active && Array.isArray(active.object) ? active.object : null;
                                    if (Array.isArray(rows) && rows.length > 0) return rows;
                                }
                            } catch (_) {}
                            return [];
                        };

                        const psfInitialObjectRows = collectObjectRowsForPsfPopup();
                        const psfInitialObjectRowsJson = JSON.stringify(psfInitialObjectRows).replace(/</g, '\\u003c');

                        try { popup.document.open(); } catch (_) {}

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Point Spread Function</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-psf-container { flex: 1 1 auto; min-height: 0; }
        #popup-psf-container-stats { flex: 0 0 auto; padding: 8px 12px; font-size: 12px; color: #333; border-top: 1px solid #eee; }
        .note { padding: 8px 12px; font-size: 12px; color: #666; border-bottom: 1px solid #eee; background: #fff; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="header"></div>
    <div class="controls">
        <label for="popup-psf-object-select">Object:</label>
        <select id="popup-psf-object-select"><option value="0">1</option></select>
        <label for="popup-psf-sampling-select" title="Zero-padding increases FFT size without increasing OPD ray grid.">Zero pad:</label>
        <select id="popup-psf-sampling-select" title="Auto: pad to at least 512. None: no padding (FFT size = OPD grid). Or choose an explicit FFT size.">
            <option value="auto" selected>Auto (≥512)</option>
            <option value="none">None</option>
            <option value="512">512</option>
            <option value="1024">1024</option>
            <option value="2048">2048</option>
            <option value="4096">4096</option>
        </select>
        <label for="popup-psf-zernike-sampling-select">OPD grid:</label>
        <select id="popup-psf-zernike-sampling-select" title="Ray-traced OPD grid size (number of rays traced across pupil)">
            <option value="32">32x32</option>
            <option value="64">64x64</option>
            <option value="128">128x128</option>
            <option value="256" selected>256x256</option>
            <option value="512">512x512</option>
            <option value="1024">1024x1024</option>
            <option value="2048">2048x2048</option>
            <option value="4096">4096x4096</option>
        </select>
        <label><input type="checkbox" id="popup-psf-log-scale-checkbox"> Log scale</label>
        <label><input type="checkbox" id="popup-psf-remove-ptd-checkbox"> Remove P/T/D</label>
        <button id="popup-show-psf-btn" type="button">Show PSF</button>
        <button id="popup-stop-psf-btn" type="button" disabled>Stop</button>
        <span id="popup-psf-pipeline-badge"></span>
    </div>
    <div id="popup-psf-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-psf-progress-text" style="margin-bottom: 6px;">Calculating PSF...</div>
        <progress id="popup-psf-progress" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-psf-container"></div>
        <div id="popup-psf-container-stats"></div>
        <div id="popup-psf-opd-parity-diff" style="display:none;height:220px;border-top:1px solid #eee;"></div>
    </div>
        <script>
        const __PSF_INITIAL_OBJECT_ROWS = ${psfInitialObjectRowsJson};
        // Debug: confirm the popup script version in console.
                // build tag intentionally not shown
        function isIOSLike() {
            try {
                const ua = String(navigator.userAgent || '');
                if (/iPad|iPhone|iPod/i.test(ua)) return true;
                // iPadOS 13+ may masquerade as Mac
                if (/Macintosh/i.test(ua) && Number(navigator.maxTouchPoints || 0) > 1) return true;
            } catch (_) {}
            return false;
        }

        function isPopupTauriRuntime() {
            try {
                if (window && window.__TAURI_INTERNALS__) return true;
            } catch (_) {}
            try {
                if (window && window.opener && window.opener.__TAURI_INTERNALS__) return true;
            } catch (_) {}
            return false;
        }

        function createCancelToken() {
            return {
                aborted: false,
                reason: null,
                _listeners: [],
                abort(reason = 'User requested stop') {
                    if (this.aborted) return;
                    this.aborted = true;
                    this.reason = reason;
                    const ls = Array.isArray(this._listeners) ? this._listeners.slice() : [];
                    for (const fn of ls) {
                        try { fn(reason); } catch (_) {}
                    }
                },
                onAbort(fn) {
                    if (typeof fn !== 'function') return;
                    if (this.aborted) {
                        try { fn(this.reason); } catch (_) {}
                        return;
                    }
                    this._listeners.push(fn);
                }
            };
        }

        let activeCancelToken = null;

        let __psfObjectSyncRetries = 0;
        const __psfScheduleObjectResync = () => {
            // On some loads, the opener's Tabulator may not be ready yet; retry briefly.
            if (__psfObjectSyncRetries >= 60) return;
            const delay = Math.min(2000, 150 + (__psfObjectSyncRetries * 150));
            __psfObjectSyncRetries++;
            setTimeout(() => {
                try { syncObjectOptionsFromOpener(); } catch (_) {}
            }, delay);
        };

        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncObjectOptionsFromOpener() {
            const openerPsfSelect = getOpenerEl('psf-object-select');
            const openerWavefrontSelect = getOpenerEl('wavefront-object-select');
            const openerSelect = openerWavefrontSelect || openerPsfSelect;
            const popupSelect = document.getElementById('popup-psf-object-select');
            if (!popupSelect) return;

            const toFiniteNumber = (v) => {
                const n = (typeof v === 'number') ? v : parseFloat(v);
                return Number.isFinite(n) ? n : NaN;
            };
            const pickNumber = (obj, keys, fallback) => {
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    if (!k) continue;
                    const raw = obj ? obj[k] : undefined;
                    if (raw === undefined || raw === null || raw === '') continue;
                    const n = toFiniteNumber(raw);
                    if (Number.isFinite(n)) return n;
                }
                return fallback;
            };

            const current = popupSelect.value;
            const nextOptions = [];

            // OPD/MTF-style: resolve object rows from multiple opener sources.
            let opener = null;
            try { opener = window.opener || null; } catch (_) { opener = null; }
            let objects = [];
            if (opener) {
                try {
                    if (opener.tableObject && typeof opener.tableObject.getData === 'function') {
                        const rows = opener.tableObject.getData();
                        if (Array.isArray(rows) && rows.length > 0) objects = rows;
                    }
                } catch (_) {}

                if (!Array.isArray(objects) || objects.length === 0) {
                    try {
                        if (typeof opener.getObjectRows === 'function') {
                            const rows = opener.getObjectRows(opener.tableObject);
                            if (Array.isArray(rows) && rows.length > 0) objects = rows;
                        }
                    } catch (_) {}
                }

                if (!Array.isArray(objects) || objects.length === 0) {
                    try {
                        if (opener.localStorage && typeof opener.localStorage.getItem === 'function') {
                            const raw = opener.localStorage.getItem('objectTableData');
                            const parsed = raw ? JSON.parse(raw) : null;
                            if (Array.isArray(parsed) && parsed.length > 0) objects = parsed;
                        }
                    } catch (_) {}
                }

                if (!Array.isArray(objects) || objects.length === 0) {
                    try {
                        if (typeof opener.getActiveConfiguration === 'function') {
                            const cfg = opener.getActiveConfiguration();
                            const rows = cfg && Array.isArray(cfg.object) ? cfg.object : null;
                            if (Array.isArray(rows) && rows.length > 0) objects = rows;
                        }
                    } catch (_) {}
                }

                if (!Array.isArray(objects) || objects.length === 0) {
                    try {
                        if (typeof opener.loadSystemConfigurations === 'function') {
                            const all = opener.loadSystemConfigurations();
                            const list = Array.isArray(all && all.configurations) ? all.configurations : [];
                            const activeId = Number(all && all.activeConfigId);
                            const active = Number.isFinite(activeId)
                                ? (list.find((c) => Number(c && c.id) === activeId) || null)
                                : (list[0] || null);
                            const rows = active && Array.isArray(active.object) ? active.object : null;
                            if (Array.isArray(rows) && rows.length > 0) objects = rows;
                        }
                    } catch (_) {}
                }
            }

            if ((!Array.isArray(objects) || objects.length === 0) && Array.isArray(__PSF_INITIAL_OBJECT_ROWS) && __PSF_INITIAL_OBJECT_ROWS.length > 0) {
                objects = __PSF_INITIAL_OBJECT_ROWS;
            }

            if (!Array.isArray(objects) || objects.length === 0) {
                try {
                    const raw = localStorage.getItem('objectTableData');
                    const parsed = raw ? JSON.parse(raw) : null;
                    if (Array.isArray(parsed) && parsed.length > 0) objects = parsed;
                } catch (_) {}
            }

            if (!Array.isArray(objects) || objects.length === 0) {
                try {
                    const rawCfg = localStorage.getItem('systemConfigurations');
                    const parsedCfg = rawCfg ? JSON.parse(rawCfg) : null;
                    const list = Array.isArray(parsedCfg && parsedCfg.configurations) ? parsedCfg.configurations : [];
                    const activeId = Number(parsedCfg && parsedCfg.activeConfigId);
                    const active = Number.isFinite(activeId)
                        ? (list.find((c) => Number(c && c.id) === activeId) || null)
                        : (list[0] || null);
                    const rows = active && Array.isArray(active.object) ? active.object : null;
                    if (Array.isArray(rows) && rows.length > 0) objects = rows;
                } catch (_) {}
            }

            if (Array.isArray(objects) && objects.length > 0) {
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(
                        (obj.position !== undefined && obj.position !== null) ? obj.position :
                        (obj.object !== undefined && obj.object !== null) ? obj.object :
                        (obj.Object !== undefined && obj.Object !== null) ? obj.Object :
                        (obj.objectType !== undefined && obj.objectType !== null) ? obj.objectType :
                        'Point'
                    );
                    const x = pickNumber(obj, ['x', 'X', 'xFieldAngle', 'xAngle', 'xHeightAngle', 'XHeightAngle', 'x_height_angle', 'x_field_angle', 'x_angle'], 0);
                    const y = pickNumber(obj, ['y', 'Y', 'yFieldAngle', 'yAngle', 'yHeightAngle', 'YHeightAngle', 'y_height_angle', 'y_field_angle', 'y_angle', 'fieldAngle', 'angle'], 0);
                    nextOptions.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }

            // Fallback: clone opener select options if present (but ignore single placeholder).
            if (nextOptions.length === 0 && openerSelect && openerSelect.options && openerSelect.options.length > 0) {
                const opts = Array.from(openerSelect.options);
                let looksLikePlaceholder = false;
                if (opts.length === 1) {
                    const t = String(opts[0].textContent || '').trim().toLowerCase();
                    looksLikePlaceholder = (t === '0' || t === 'object 1' || t === 'object1');
                }
                if (!looksLikePlaceholder) {
                    const normalizeLabel = (label) => {
                        const s = String(label || '').trim();
                        // Convert e.g. "Object1 : Angle (...)" / "Object 1: ..." / "object1" => "1: ..." / "1"
                        const m = s.match(/^object\s*(\d+)\s*[:：]?\s*(.*)$/i);
                        if (m) {
                            const n = m[1];
                            const rest = String(m[2] || '').trim();
                            return rest ? (n + ': ' + rest) : String(n);
                        }
                        return s;
                    };
                    opts.forEach(opt => {
                        const raw = String((opt.textContent !== undefined && opt.textContent !== null) ? opt.textContent : '');
                        nextOptions.push({ value: String(opt.value), label: normalizeLabel(raw) });
                    });
                }
            }

            if (nextOptions.length === 0) {
                nextOptions.push({ value: '0', label: '1' });
                __psfScheduleObjectResync();
            } else {
                __psfObjectSyncRetries = 0;
            }

            popupSelect.innerHTML = '';
            for (const opt of nextOptions) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                popupSelect.appendChild(o);
            }

            if (current && Array.from(popupSelect.options).some(o => o.value === current)) {
                popupSelect.value = current;
                return;
            }
            const preferred = (openerPsfSelect && openerPsfSelect.value)
                ? openerPsfSelect.value
                : (openerSelect && openerSelect.value ? openerSelect.value : '');
            if (preferred && Array.from(popupSelect.options).some(o => o.value === preferred)) {
                popupSelect.value = preferred;
            } else {
                const firstOpt = (popupSelect.options && popupSelect.options.length > 0) ? popupSelect.options[0] : null;
                popupSelect.value = (firstOpt && firstOpt.value !== undefined && firstOpt.value !== null) ? firstOpt.value : '0';
            }
        }

        function syncInputsFromOpener() {
            const openerZeroPad = getOpenerEl('psf-zeropad-select');
            const openerZernikeSampling = getOpenerEl('psf-zernike-sampling-select');
            const openerLog = getOpenerEl('psf-log-scale-checkbox');
            const openerRemovePtd = getOpenerEl('psf-remove-ptd-checkbox');
            const popupSampling = document.getElementById('popup-psf-sampling-select');
            const popupZernikeSampling = document.getElementById('popup-psf-zernike-sampling-select');
            const popupLog = document.getElementById('popup-psf-log-scale-checkbox');
            const popupRemovePtd = document.getElementById('popup-psf-remove-ptd-checkbox');
            if (openerZeroPad && popupSampling && openerZeroPad.value) {
                if (Array.from(popupSampling.options || []).some(o => String(o.value) === String(openerZeroPad.value))) {
                    popupSampling.value = openerZeroPad.value;
                }
            }
            if (popupZernikeSampling && openerZernikeSampling && openerZernikeSampling.value) popupZernikeSampling.value = openerZernikeSampling.value;
            try {
                if (popupLog && openerLog) popupLog.checked = !!openerLog.checked;
            } catch (_) {}
            try {
                if (popupRemovePtd) popupRemovePtd.checked = !!(openerRemovePtd && openerRemovePtd.checked);
            } catch (_) {}
        }

        function resizePlot() {
            try {
                const plotly = window.Plotly;
                if (!plotly || !plotly.Plots) return;
                const el = document.getElementById('popup-psf-container');
                if (el) plotly.Plots.resize(el);
                const diffEl = document.getElementById('popup-psf-opd-parity-diff');
                if (diffEl && diffEl.style.display !== 'none') {
                    plotly.Plots.resize(diffEl);
                }
            } catch (_) {}
        }

        function clearOpdParityHeatmap() {
            try {
                const diffEl = document.getElementById('popup-psf-opd-parity-diff');
                if (!diffEl) return;
                diffEl.style.display = 'none';
                diffEl.innerHTML = '';
            } catch (_) {}
        }

        async function renderOpdParityHeatmap(diffGridWaves, meta) {
            try {
                const diffEl = document.getElementById('popup-psf-opd-parity-diff');
                if (!diffEl) return;
                if (!Array.isArray(diffGridWaves) || diffGridWaves.length === 0 || !window.Plotly) {
                    clearOpdParityHeatmap();
                    return;
                }

                const maxAbs = Number(meta && meta.maxAbsWaves);
                const zAbs = (Number.isFinite(maxAbs) && maxAbs > 0) ? maxAbs : 1;
                const title = 'OPD parity map (Native - JS) [waves]';

                diffEl.style.display = 'block';
                await window.Plotly.newPlot(diffEl, [{
                    z: diffGridWaves,
                    type: 'heatmap',
                    colorscale: 'RdBu',
                    zmid: 0,
                    zmin: -zAbs,
                    zmax: zAbs,
                    colorbar: { title: 'waves' }
                }], {
                    title: { text: title, font: { size: 12 } },
                    margin: { l: 50, r: 20, t: 32, b: 40 },
                    xaxis: { title: 'Pupil ix' },
                    yaxis: { title: 'Pupil iy', autorange: 'reversed' }
                }, { responsive: true, displaylogo: false });
            } catch (_) {
                clearOpdParityHeatmap();
            }
        }

        window['renderPSF'] = async () => {
            const containerEl = document.getElementById('popup-psf-container');
            if (containerEl) containerEl.innerHTML = '';
            clearOpdParityHeatmap();

            const setPopupPsfBadge = (status) => {
                try {
                    const el = document.getElementById('popup-psf-pipeline-badge');
                    if (!el) return;
                    const text = String(status || '');
                    el.textContent = text;
                    if (text) {
                        el.setAttribute('title', text);
                    } else {
                        el.removeAttribute('title');
                    }
                } catch (_) {}
            };

            const progressWrapper = document.getElementById('popup-psf-progress-wrapper');
            const progressEl = document.getElementById('popup-psf-progress');
            const progressTextEl = document.getElementById('popup-psf-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressEl && Number.isFinite(value)) progressEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            const stopBtn = document.getElementById('popup-stop-psf-btn');
            if (stopBtn) {
                stopBtn.disabled = false;
            }

            activeCancelToken = createCancelToken();

            const popupObject = document.getElementById('popup-psf-object-select');
            const popupSampling = document.getElementById('popup-psf-sampling-select');
            const popupZernikeSampling = document.getElementById('popup-psf-zernike-sampling-select');
            const popupLog = document.getElementById('popup-psf-log-scale-checkbox');
            const popupRemovePtd = document.getElementById('popup-psf-remove-ptd-checkbox');

            let objectIndex = popupObject ? parseInt(popupObject.value, 10) : 0;
            if (!Number.isFinite(objectIndex) && popupObject && Number.isFinite(popupObject.selectedIndex)) {
                objectIndex = popupObject.selectedIndex;
            }
            const zernikeSampling = popupZernikeSampling ? parseInt(popupZernikeSampling.value, 10) : 128;
            const zeroPadRaw = popupSampling ? String(popupSampling.value || 'auto') : 'auto';
            const logScale = !!(popupLog && popupLog.checked);
            const opdDisplayMode = (popupRemovePtd && popupRemovePtd.checked)
                ? 'pistonTiltDefocusRemoved'
                : 'pistonTiltRemoved';
            const PSF_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__PSF_DEBUG);

            const openerObject = getOpenerEl('psf-object-select');
            const openerSampling = getOpenerEl('psf-sampling-select');
            const openerZeroPad = getOpenerEl('psf-zeropad-select');
            const openerZernikeSampling = getOpenerEl('psf-zernike-sampling-select');
            const openerLog = getOpenerEl('psf-log-scale-checkbox');
            const openerRemovePtd = getOpenerEl('psf-remove-ptd-checkbox');
            if (openerObject && Number.isFinite(objectIndex)) openerObject.value = String(objectIndex);
            if (openerSampling && Number.isFinite(zernikeSampling)) openerSampling.value = String(zernikeSampling);
            if (openerZeroPad && zeroPadRaw) {
                if (Array.from(openerZeroPad.options || []).some(o => String(o.value) === String(zeroPadRaw))) {
                    openerZeroPad.value = zeroPadRaw;
                }
            }
            try {
                if (openerRemovePtd) openerRemovePtd.checked = (opdDisplayMode === 'pistonTiltDefocusRemoved');
            } catch (_) {}
            if (openerZernikeSampling && Number.isFinite(zernikeSampling)) openerZernikeSampling.value = String(zernikeSampling);
            if (openerLog) openerLog.checked = logScale;

            try {
                setPopupPsfBadge('Running');
                setProgress(0, 'Starting...');
                // Allow the popup to paint the progress UI before heavy computation begins.
                await new Promise(r => setTimeout(r, 0));

                const onProgress = (evt) => {
                    try {
                        const p = Number(evt && evt.percent);
                        const msg = (evt && evt.message) || (evt && evt.phase) || 'Working...';
                        if (Number.isFinite(p)) setProgress(p, msg);
                        else setProgress(undefined, msg);
                    } catch (_) {}
                };

                // Always compute inside the popup to avoid background throttling of the opener
                // when the main window is hidden/minimized/unfocused.
                {
                    const moduleURL = (relPath) => {
                        const baseHref = (() => {
                            try {
                                return (window.opener && window.opener.location && window.opener.location.href)
                                    ? window.opener.location.href
                                    : window.location.href;
                            } catch (_) {
                                return window.location.href;
                            }
                        })();
                        const url = new URL(relPath, baseHref);
                        return url.href;
                    };

                    const throwIfCancelled = (token) => {
                        if (token && token.aborted) {
                            const err = new Error(String(token.reason || 'Cancelled'));
                            err.code = 'CANCELLED';
                            throw err;
                        }
                    };
                    const raceWithCancel = async (promise, token) => {
                        if (!token) return await promise;
                        throwIfCancelled(token);
                        const cancelPromise = new Promise((_, reject) => {
                            token.onAbort((reason) => {
                                const err = new Error(String(reason || 'Cancelled'));
                                err.code = 'CANCELLED';
                                reject(err);
                            });
                        });
                        return await Promise.race([promise, cancelPromise]);
                    };

                    // Modules are already imported at the top of this file

                    const cloneRows = (rows) => {
                        if (!Array.isArray(rows)) return rows;
                        try {
                            if (typeof structuredClone === 'function') return structuredClone(rows);
                        } catch (_) {}
                        try {
                            return JSON.parse(JSON.stringify(rows));
                        } catch (_) {
                            return rows;
                        }
                    };

                    const opticalSystemRows = (() => {
                        try {
                            if (window.opener && typeof window.opener.getOpticalSystemRows === 'function') {
                                // Prefer live Tabulator table data if available.
                                const r = window.opener.getOpticalSystemRows(window.opener.tableOpticalSystem);
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        // Fallback: try opener again without parameter
                        try {
                            if (window.opener && typeof window.opener.getOpticalSystemRows === 'function') {
                                const r = window.opener.getOpticalSystemRows();
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        return [];
                    })();

                    const objects = (() => {
                        if (Array.isArray(__PSF_INITIAL_OBJECT_ROWS) && __PSF_INITIAL_OBJECT_ROWS.length > 0) {
                            return cloneRows(__PSF_INITIAL_OBJECT_ROWS);
                        }
                        try {
                            if (window.opener && window.opener.tableObject && typeof window.opener.tableObject.getData === 'function') {
                                const r = window.opener.tableObject.getData();
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        try {
                            if (window.opener && typeof window.opener.getObjectRows === 'function') {
                                const r = window.opener.getObjectRows(window.opener.tableObject);
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        // Fallback: try opener again without parameter
                        try {
                            if (window.opener && typeof window.opener.getObjectRows === 'function') {
                                const r = window.opener.getObjectRows();
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        try {
                            const raw = localStorage.getItem('objectTableData');
                            const parsed = raw ? JSON.parse(raw) : null;
                            if (Array.isArray(parsed) && parsed.length > 0) return cloneRows(parsed);
                        } catch (_) {}
                        try {
                            const rawCfg = localStorage.getItem('systemConfigurations');
                            const parsedCfg = rawCfg ? JSON.parse(rawCfg) : null;
                            const list = Array.isArray(parsedCfg && parsedCfg.configurations) ? parsedCfg.configurations : [];
                            const activeId = Number(parsedCfg && parsedCfg.activeConfigId);
                            const active = Number.isFinite(activeId)
                                ? (list.find((c) => Number(c && c.id) === activeId) || null)
                                : (list[0] || null);
                            const rows = active && Array.isArray(active.object) ? active.object : null;
                            if (Array.isArray(rows) && rows.length > 0) return cloneRows(rows);
                        } catch (_) {}
                        return [];
                    })();

                    const sources = (() => {
                        try {
                            if (window.opener && typeof window.opener.getSourceRows === 'function') {
                                const r = window.opener.getSourceRows(window.opener.tableSource);
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        // Fallback: try opener again without tableSource parameter
                        try {
                            if (window.opener && typeof window.opener.getSourceRows === 'function') {
                                const r = window.opener.getSourceRows();
                                if (Array.isArray(r) && r.length > 0) return cloneRows(r);
                            }
                        } catch (_) {}
                        return [];
                    })();
                    if (!Array.isArray(opticalSystemRows) || opticalSystemRows.length === 0) throw new Error('No optical system data (popup).');
                    if (!Array.isArray(objects) || objects.length === 0) throw new Error('No object data (popup).');

                    const toFiniteNumber = (v) => {
                        const n = (typeof v === 'number') ? v : parseFloat(v);
                        return (Number.isFinite(n) ? n : NaN);
                    };
                    const pickNumber = (obj, keys, fallback) => {
                        for (let i = 0; i < keys.length; i++) {
                            const k = keys[i];
                            if (!k) continue;
                            const raw = obj ? obj[k] : undefined;
                            if (raw === undefined || raw === null || raw === '') continue;
                            const n = toFiniteNumber(raw);
                            if (Number.isFinite(n)) return n;
                        }
                        return fallback;
                    };

                    let idx = Number.isFinite(objectIndex) ? objectIndex : 0;
                    // If the select values are 1-based for any reason, normalize.
                    if ((idx >= objects.length) && idx > 0 && (idx - 1) < objects.length) idx = idx - 1;
                    if (idx < 0) idx = 0;
                    const selectedObject = objects[idx];
                    if (!selectedObject) throw new Error('Selected object not found (popup).');

                    const primaryWl = (() => {
                        try {
                            if (window.opener && typeof window.opener.getPrimaryWavelength === 'function') {
                                const v = Number(window.opener.getPrimaryWavelength());
                                if (Number.isFinite(v) && v > 0) return v;
                            }
                        } catch (_) {}
                        return NaN;
                    })();
                    const s0 = (sources && sources.length > 0) ? sources[0] : null;
                    const wl0 = (s0 && s0.wavelength !== undefined && s0.wavelength !== null) ? Number(s0.wavelength) : NaN;
                    const wavelength = Number.isFinite(primaryWl)
                        ? primaryWl
                        : (() => { throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.'); })();

                    // Match showPSFDiagram(): build a fieldSetting compatible with eva-wavefront.js.
                    const objectX = pickNumber(selectedObject, ['x', 'X', 'xFieldAngle', 'xAngle', 'xHeightAngle', 'XHeightAngle', 'x_height_angle', 'x_field_angle', 'x_angle'], 0);
                    const objectY = pickNumber(selectedObject, ['y', 'Y', 'yFieldAngle', 'yAngle', 'yHeightAngle', 'YHeightAngle', 'y_height_angle', 'y_field_angle', 'y_angle', 'fieldAngle', 'angle'], 0);
                    const objectTypeRaw = String(
                        (selectedObject && selectedObject.position !== undefined && selectedObject.position !== null) ? selectedObject.position :
                        (selectedObject && selectedObject.object !== undefined && selectedObject.object !== null) ? selectedObject.object :
                        (selectedObject && selectedObject.Object !== undefined && selectedObject.Object !== null) ? selectedObject.Object :
                        (selectedObject && selectedObject.objectType !== undefined && selectedObject.objectType !== null) ? selectedObject.objectType :
                        'Point'
                    );
                    const objectType = objectTypeRaw;
                    const objectTypeLower = String(objectTypeRaw).toLowerCase();
                    let fieldAngle = { x: 0, y: 0 };
                    let xHeight = 0;
                    let yHeight = 0;
                    if (/\\bangle\\b/.test(objectTypeLower)) {
                        fieldAngle = { x: Number(objectX) || 0, y: Number(objectY) || 0 };
                        xHeight = 0;
                        yHeight = 0;
                    } else {
                        fieldAngle = { x: 0, y: 0 };
                        xHeight = Number(objectX) || 0;
                        yHeight = Number(objectY) || 0;
                    }
                    const fieldSetting = {
                        objectIndex: idx,
                        type: objectType,
                        fieldAngle,
                        xHeight,
                        yHeight,
                        wavelength
                    };

                    const getActiveConfigLabel = () => {
                        try {
                            if (typeof localStorage === 'undefined') return '';
                            const sys = loadSystemConfigurations();
                            const activeId = sys?.activeConfigId;
                            const cfg = Array.isArray(sys?.configurations)
                                ? sys.configurations.find(c => String(c?.id) === String(activeId))
                                : null;
                            if (!cfg) return (activeId !== undefined && activeId !== null) ? ('id=' + activeId) : '';
                            return ('id=' + cfg.id + ' name=' + (cfg.name || '')).trim();
                        } catch (_) {
                            return '';
                        }
                    };

                    const calcFNV1a32 = (str) => {
                        let hash = 0x811c9dc5;
                        for (let i = 0; i < str.length; i++) {
                            hash ^= str.charCodeAt(i);
                            hash = Math.imul(hash, 0x01000193);
                        }
                        return (hash >>> 0).toString(16);
                    };

                    const summarizeOpticalSystemRows = (rows) => {
                        if (!Array.isArray(rows) || rows.length === 0) return { checksum: '0' };
                        const parts = [];
                        for (const r of rows) {
                            if (!r) continue;
                            const obj = r['object type'] ?? r.object ?? r.Object ?? '';
                            const radius = r.radius ?? r.Radius ?? '';
                            const thickness = r.thickness ?? r.Thickness ?? '';
                            const material = r.material ?? r.Material ?? '';
                            const semidia = r.semidia ?? r.semidiameter ?? r.SemiDia ?? '';
                            const id = r.id ?? '';
                            parts.push(String(id) + '|' + String(obj) + '|' + String(radius) + '|' + String(thickness) + '|' + String(material) + '|' + String(semidia));
                        }
                        return { checksum: calcFNV1a32(parts.join(';')) };
                    };

                    if (PSF_DEBUG) {
                        try {
                            const fa = (fieldSetting && fieldSetting.fieldAngle && typeof fieldSetting.fieldAngle === 'object')
                                ? fieldSetting.fieldAngle
                                : { x: 0, y: 0 };
                            const line = '🧭 [PSF popup] objectIndex=' + idx + ' type=' + objectType +
                                ' fieldAngle=(' + (Number(fa.x) || 0) + ',' + (Number(fa.y) || 0) + ')' +
                                ' height=(' + (Number(fieldSetting && fieldSetting.xHeight) || 0) + ',' + (Number(fieldSetting && fieldSetting.yHeight) || 0) + ')' +
                                ' wl=' + (Number(wavelength) || 0);
                            console.log(line);
                            try {
                                if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                    window.opener.console.log(line);
                                }
                            } catch (_) {}
                        } catch (_) {}
                    }

                    if (PSF_DEBUG) {
                        try {
                            const summary = summarizeOpticalSystemRows(opticalSystemRows);
                            const idLine = '🧾 [PSF popup] activeConfig=' + (getActiveConfigLabel() || '(none)') +
                                ' rows=' + (Array.isArray(opticalSystemRows) ? opticalSystemRows.length : 0) +
                                ' checksum=' + (summary && summary.checksum ? summary.checksum : '0');
                            console.log(idLine);
                            try {
                                if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                    window.opener.console.log(idLine);
                                }
                            } catch (_) {}
                        } catch (_) {}
                    }

                    // Also log PSF physical scale inputs (pupil diameter / focal length) once available.
                    // This is critical when the plot auto-normalizes intensity and hides differences.
                    const logScaleInputs = (pupilDiameterMm, focalLengthMm, stopIndex) => {
                        if (!PSF_DEBUG) return;
                        try {
                            const line = '📏 [PSF popup] pupilDiameterMm=' + (Number(pupilDiameterMm) || 0) +
                                ' focalLengthMm=' + (Number(focalLengthMm) || 0) +
                                ' stopIndex=' + (Number.isFinite(Number(stopIndex)) ? Number(stopIndex) : -1);
                            console.log(line);
                            try {
                                if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                    window.opener.console.log(line);
                                }
                            } catch (_) {}
                        } catch (_) {}
                    };

                    const wavefrontGridSize = Number.isFinite(zernikeSampling)
                        ? Math.max(16, Math.floor(Number(zernikeSampling)))
                        : 128;
                    onProgress({ percent: 0, phase: 'opd', message: 'OPD...' });

                    let wavefrontMap = null;
                    let nativeOpdResp = null;
                    let nativeOpdDiag = null;
                    const forceJsOpdMap = !!(typeof window !== 'undefined' && window.__PSF_POPUP_FORCE_JS_OPD_MAP === true);
                    const preferNativeOpdMap = (typeof window !== 'undefined' && window.__PSF_POPUP_USE_NATIVE_OPD_MAP === false)
                        ? false
                        : true;
                    const canUseNativeOpdMap = !forceJsOpdMap && preferNativeOpdMap
                        && !!(window.opener && typeof window.opener.runDesktopNativeOpdMapForPopup === 'function');

                    if (canUseNativeOpdMap) {
                        try {
                            nativeOpdResp = await raceWithCancel(window.opener.runDesktopNativeOpdMapForPopup({
                                objectIndex: idx,
                                gridSize: wavefrontGridSize,
                                wavelengthUm: wavelength,
                                opdDisplayMode,
                            }), activeCancelToken);
                            throwIfCancelled(activeCancelToken);
                            {
                                const usedIdx = Number(nativeOpdResp?.usedObjectIndex);
                                if (Number.isFinite(usedIdx) && Number.isFinite(idx) && usedIdx !== idx) {
                                    throw new Error('Native OPD object mismatch: requested=' + String(idx) + ', used=' + String(usedIdx));
                                }
                            }
                            try {
                                const opdLine = '🧪 [PSF popup] OPD backend=' + String(nativeOpdResp?.backend || 'unknown') +
                                    ' reqObjIdx=' + (nativeOpdResp?.requestedObjectIndex ?? 'n/a') +
                                    ' usedObjIdx=' + Number(nativeOpdResp?.usedObjectIndex ?? -1) +
                                    ' usedObj=' + String(nativeOpdResp?.usedObjectPosition || 'n/a') +
                                    ' field=(' + Number(nativeOpdResp?.usedObjectX ?? 0) + ',' + Number(nativeOpdResp?.usedObjectY ?? 0) + ')' +
                                    ' hitCount=' + Number(nativeOpdResp?.hitCount || 0) +
                                    ' sampleCount=' + Number(nativeOpdResp?.sampleCount || 0);
                                console.log(opdLine);
                                try {
                                    if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                        window.opener.console.log(opdLine);
                                    }
                                } catch (_) {}
                            } catch (_) {}

                            try {
                                const enableOpdParityDiag = !!(typeof window !== 'undefined' && window.__PSF_POPUP_ENABLE_OPD_PARITY_DIAG === true);
                                if (!enableOpdParityDiag) {
                                    // Skip heavy JS re-computation parity diagnostics unless explicitly enabled.
                                    throw new Error('__skip_opd_parity_diag__');
                                }

                                const host = window.opener || window;
                                const calculatorFactory =
                                    (host && typeof host.createOPDCalculator === 'function' && host.createOPDCalculator)
                                    || (typeof window.createOPDCalculator === 'function' && window.createOPDCalculator)
                                    || (typeof createOPDCalculator === 'function' ? createOPDCalculator : null);
                                const analyzerFactory =
                                    (host && typeof host.createWavefrontAnalyzer === 'function' && host.createWavefrontAnalyzer)
                                    || (typeof window.createWavefrontAnalyzer === 'function' && window.createWavefrontAnalyzer)
                                    || (typeof createWavefrontAnalyzer === 'function' ? createWavefrontAnalyzer : null);
                                const opdCalculator = calculatorFactory ? calculatorFactory(opticalSystemRows, wavelength) : null;
                                const analyzer = analyzerFactory ? analyzerFactory(opdCalculator) : null;
                                if (analyzer && Array.isArray(nativeOpdResp?.displayOpdGrid)) {
                                    try {
                                        const nativeTarget = Number(nativeOpdResp?.targetSurface);
                                        const nativeStop = Number(nativeOpdResp?.stopSurface);
                                        const isFiniteFieldObj = !!(fieldSetting && String(fieldSetting.type || '').toLowerCase().includes('angle'));

                                        if (Number.isFinite(nativeStop) && nativeStop >= 0 && opdCalculator) {
                                            opdCalculator.stopSurfaceIndex = Math.floor(nativeStop);
                                        }
                                        if (Number.isFinite(nativeTarget) && nativeTarget >= 0 && opdCalculator) {
                                            opdCalculator.evaluationSurfaceIndex = Math.floor(nativeTarget);
                                        }
                                        if (opdCalculator) {
                                            const evalIdx = Number(opdCalculator.evaluationSurfaceIndex);
                                            const stopIdx = Number(opdCalculator.stopSurfaceIndex);
                                            const maxIdx = Math.max(
                                                Number.isFinite(evalIdx) ? evalIdx : 0,
                                                Number.isFinite(stopIdx) ? stopIdx : 0
                                            );
                                            opdCalculator.traceMaxSurfaceIndex = maxIdx;

                                            if (isFiniteFieldObj && typeof opdCalculator._setInfinitePupilMode === 'function') {
                                                const nativeMode = String(nativeOpdResp?.pupilSamplingMode || '').toLowerCase();
                                                opdCalculator._setInfinitePupilMode(fieldSetting, nativeMode === 'stop' ? 'stop' : 'entrance');
                                            }

                                            // Rebuild chief/reference after overriding indices/mode.
                                            opdCalculator.referenceOpticalPath = null;
                                            opdCalculator.lastFieldKey = null;
                                            if (typeof opdCalculator.setReferenceRay === 'function') {
                                                opdCalculator.setReferenceRay(fieldSetting);
                                            }
                                        }
                                    } catch (_) {}

                                    const jsDiagMap = await raceWithCancel(analyzer.generateWavefrontMap(fieldSetting, wavefrontGridSize, 'circular', {
                                        recordRays: false,
                                        progressEvery: 0,
                                        renderFromZernike: false,
                                        skipZernikeFit: true,
                                        opdMode: 'simple',
                                        opdDisplayMode,
                                        diagnoseDiscontinuities: false,
                                        cancelToken: activeCancelToken,
                                    }), activeCancelToken);

                                    if (jsDiagMap && !jsDiagMap.error) {
                                        const sDiag = Math.max(2, Math.floor(Number(wavefrontGridSize)));
                                        const jsGrid = Array.from({ length: sDiag }, () => Array(sDiag).fill(NaN));
                                        const coords = Array.isArray(jsDiagMap?.pupilCoordinates) ? jsDiagMap.pupilCoordinates : [];
                                        const jsOpdMicrons = (jsDiagMap?.display && Array.isArray(jsDiagMap.display.opds))
                                            ? jsDiagMap.display.opds
                                            : (Array.isArray(jsDiagMap?.opds) ? jsDiagMap.opds : []);
                                        const jsRawOpdMicrons = (jsDiagMap?.raw && Array.isArray(jsDiagMap.raw.opds))
                                            ? jsDiagMap.raw.opds
                                            : (Array.isArray(jsDiagMap?.opds) ? jsDiagMap.opds : []);
                                        const nDiag = Math.min(coords.length, jsOpdMicrons.length);
                                        for (let k = 0; k < nDiag; k++) {
                                            const c = coords[k];
                                            const ix = Number.isInteger(c?.ix) ? c.ix : null;
                                            const iy = Number.isInteger(c?.iy) ? c.iy : null;
                                            if (ix === null || iy === null) continue;
                                            if (ix < 0 || ix >= sDiag || iy < 0 || iy >= sDiag) continue;
                                            const rawV = jsOpdMicrons[k];
                                            if (rawV === null || rawV === undefined || rawV === '') continue;
                                            const v = Number(rawV);
                                            if (!Number.isFinite(v)) continue;
                                            jsGrid[iy][ix] = v;
                                        }

                                        const jsRawGrid = Array.from({ length: sDiag }, () => Array(sDiag).fill(NaN));
                                        const nRawDiag = Math.min(coords.length, jsRawOpdMicrons.length);
                                        for (let k = 0; k < nRawDiag; k++) {
                                            const c = coords[k];
                                            const ix = Number.isInteger(c?.ix) ? c.ix : null;
                                            const iy = Number.isInteger(c?.iy) ? c.iy : null;
                                            if (ix === null || iy === null) continue;
                                            if (ix < 0 || ix >= sDiag || iy < 0 || iy >= sDiag) continue;
                                            const rawV = jsRawOpdMicrons[k];
                                            if (rawV === null || rawV === undefined || rawV === '') continue;
                                            const v = Number(rawV);
                                            if (!Number.isFinite(v)) continue;
                                            jsRawGrid[iy][ix] = v;
                                        }

                                        let count = 0;
                                        let sumAbs = 0;
                                        let sumSq = 0;
                                        let maxAbs = 0;
                                        let sumA = 0;
                                        let sumB = 0;
                                        let sumBB = 0;
                                        let sumBA = 0;
                                        let maxIx = -1;
                                        let maxIy = -1;
                                        const diffGridWaves = Array.from({ length: sDiag }, () => Array(sDiag).fill(NaN));
                                        const radial = {
                                            center: { count: 0, sumAbs: 0, sumSq: 0 },
                                            mid: { count: 0, sumAbs: 0, sumSq: 0 },
                                            edge: { count: 0, sumAbs: 0, sumSq: 0 },
                                        };
                                        const cx = (sDiag - 1) / 2;
                                        const cy = (sDiag - 1) / 2;
                                        const rMax = Math.max(1, Math.hypot(cx, cy));
                                        for (let iy = 0; iy < sDiag; iy++) {
                                            const nRow = nativeOpdResp.displayOpdGrid[iy] || [];
                                            for (let ix = 0; ix < sDiag; ix++) {
                                                const rawA = nRow[ix];
                                                const rawB = jsGrid[iy][ix];
                                                if (rawA === null || rawA === undefined || rawA === '' || rawB === null || rawB === undefined || rawB === '') continue;
                                                const a = Number(rawA);
                                                const b = Number(rawB);
                                                if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
                                                // Native OPD map is returned in waves, while JS map here is in microns.
                                                // Convert JS OPD to waves before parity comparison.
                                                const bWaves = b / wavelength;
                                                const dWaves = a - bWaves;
                                                diffGridWaves[iy][ix] = dWaves;
                                                const ad = Math.abs(dWaves);
                                                sumAbs += ad;
                                                sumSq += dWaves * dWaves;
                                                sumA += a;
                                                sumB += bWaves;
                                                sumBB += bWaves * bWaves;
                                                sumBA += bWaves * a;
                                                if (ad > maxAbs) {
                                                    maxAbs = ad;
                                                    maxIx = ix;
                                                    maxIy = iy;
                                                }
                                                const rn = Math.hypot(ix - cx, iy - cy) / rMax;
                                                const band = (rn < 0.35) ? radial.center : (rn < 0.7 ? radial.mid : radial.edge);
                                                band.count++;
                                                band.sumAbs += ad;
                                                band.sumSq += dWaves * dWaves;
                                                count++;
                                            }
                                        }

                                        if (count > 0) {
                                            let fitScale = NaN;
                                            let fitOffset = NaN;
                                            let fitResidualRms = NaN;
                                            if (count >= 2) {
                                                const denom = (count * sumBB) - (sumB * sumB);
                                                if (Number.isFinite(denom) && Math.abs(denom) > 1e-18) {
                                                    fitScale = ((count * sumBA) - (sumB * sumA)) / denom;
                                                    fitOffset = (sumA - fitScale * sumB) / count;

                                                    let fitSumSq = 0;
                                                    let fitCount = 0;
                                                    for (let iy = 0; iy < sDiag; iy++) {
                                                        const nRow2 = nativeOpdResp.displayOpdGrid[iy] || [];
                                                        const jRow2 = jsGrid[iy] || [];
                                                        for (let ix = 0; ix < sDiag; ix++) {
                                                            const rawA2 = nRow2[ix];
                                                            const rawB2 = jRow2[ix];
                                                            if (rawA2 === null || rawA2 === undefined || rawA2 === '' || rawB2 === null || rawB2 === undefined || rawB2 === '') continue;
                                                            const a2 = Number(rawA2);
                                                            const b2 = Number(rawB2);
                                                            if (!Number.isFinite(a2) || !Number.isFinite(b2)) continue;
                                                            const bw2 = b2 / wavelength;
                                                            const e2 = a2 - (fitScale * bw2 + fitOffset);
                                                            fitSumSq += e2 * e2;
                                                            fitCount++;
                                                        }
                                                    }
                                                    fitResidualRms = fitCount > 0 ? Math.sqrt(fitSumSq / fitCount) : NaN;
                                                }
                                            }

                                            let rawCount = 0;
                                            let rawSumAbs = 0;
                                            let rawSumSq = 0;
                                            let rawMaxAbs = 0;
                                            for (let iy = 0; iy < sDiag; iy++) {
                                                const nRowRaw = Array.isArray(nativeOpdResp.rawOpdGrid) ? (nativeOpdResp.rawOpdGrid[iy] || []) : [];
                                                const jRowRaw = jsRawGrid[iy] || [];
                                                for (let ix = 0; ix < sDiag; ix++) {
                                                    const rawARaw = nRowRaw[ix];
                                                    const rawBRaw = jRowRaw[ix];
                                                    if (rawARaw === null || rawARaw === undefined || rawARaw === '' || rawBRaw === null || rawBRaw === undefined || rawBRaw === '') continue;
                                                    const aRaw = Number(rawARaw);
                                                    const bRaw = Number(rawBRaw);
                                                    if (!Number.isFinite(aRaw) || !Number.isFinite(bRaw)) continue;
                                                    const dRawWaves = aRaw - (bRaw / wavelength);
                                                    const adRaw = Math.abs(dRawWaves);
                                                    rawSumAbs += adRaw;
                                                    rawSumSq += dRawWaves * dRawWaves;
                                                    if (adRaw > rawMaxAbs) rawMaxAbs = adRaw;
                                                    rawCount++;
                                                }
                                            }

                                            const rawDiag = (rawCount > 0)
                                                ? {
                                                    count: rawCount,
                                                    rmsWaves: Math.sqrt(rawSumSq / rawCount),
                                                    meanAbsWaves: rawSumAbs / rawCount,
                                                    maxAbsWaves: rawMaxAbs,
                                                }
                                                : null;

                                            const maxAllowedRmsWaves = (() => {
                                                const v = Number((typeof window !== 'undefined')
                                                    ? window.__PSF_POPUP_NATIVE_OPD_PARITY_MAX_RMS_WAVES
                                                    : NaN);
                                                return (Number.isFinite(v) && v > 0) ? v : 5e-2;
                                            })();
                                            nativeOpdDiag = {
                                                count,
                                                rmsWaves: Math.sqrt(sumSq / count),
                                                meanAbsWaves: sumAbs / count,
                                                maxAbsWaves: maxAbs,
                                                maxLoc: { ix: maxIx, iy: maxIy },
                                                radialBands: {
                                                    center: {
                                                        count: radial.center.count,
                                                        rmsWaves: radial.center.count > 0 ? Math.sqrt(radial.center.sumSq / radial.center.count) : NaN,
                                                        meanAbsWaves: radial.center.count > 0 ? (radial.center.sumAbs / radial.center.count) : NaN,
                                                    },
                                                    mid: {
                                                        count: radial.mid.count,
                                                        rmsWaves: radial.mid.count > 0 ? Math.sqrt(radial.mid.sumSq / radial.mid.count) : NaN,
                                                        meanAbsWaves: radial.mid.count > 0 ? (radial.mid.sumAbs / radial.mid.count) : NaN,
                                                    },
                                                    edge: {
                                                        count: radial.edge.count,
                                                        rmsWaves: radial.edge.count > 0 ? Math.sqrt(radial.edge.sumSq / radial.edge.count) : NaN,
                                                        meanAbsWaves: radial.edge.count > 0 ? (radial.edge.sumAbs / radial.edge.count) : NaN,
                                                    },
                                                },
                                                fit: {
                                                    scale: fitScale,
                                                    offsetWaves: fitOffset,
                                                    residualRmsWaves: fitResidualRms,
                                                },
                                                rawParity: rawDiag,
                                            };
                                            const diagLine = '📐 [PSF popup][OPD parity] Native-vs-JS count=' + count +
                                                ' rms=' + Number(nativeOpdDiag.rmsWaves).toExponential(3) + 'λ' +
                                                ' meanAbs=' + Number(nativeOpdDiag.meanAbsWaves).toExponential(3) + 'λ' +
                                                ' maxAbs=' + Number(nativeOpdDiag.maxAbsWaves).toExponential(3) + 'λ' +
                                                ' @(' + String(maxIx) + ',' + String(maxIy) + ')' +
                                                ' fitScale=' + (Number.isFinite(fitScale) ? Number(fitScale).toExponential(3) : 'NaN') +
                                                ' fitOffset=' + (Number.isFinite(fitOffset) ? Number(fitOffset).toExponential(3) : 'NaN') + 'λ' +
                                                ' fitResidual=' + (Number.isFinite(fitResidualRms) ? Number(fitResidualRms).toExponential(3) : 'NaN') + 'λ' +
                                                (rawDiag
                                                    ? (' | raw rms=' + Number(rawDiag.rmsWaves).toExponential(3) + 'λ meanAbs=' + Number(rawDiag.meanAbsWaves).toExponential(3) + 'λ maxAbs=' + Number(rawDiag.maxAbsWaves).toExponential(3) + 'λ')
                                                    : '');
                                            const hasReliableRawParity = !!(rawDiag && Number.isFinite(Number(rawDiag.rmsWaves)) && Number(rawDiag.count) >= 64);
                                            const hasReliableDisplayParity = Number.isFinite(Number(nativeOpdDiag.rmsWaves)) && Number(count) >= 64;
                                            const parityForFallback = hasReliableRawParity
                                                ? Number(rawDiag.rmsWaves)
                                                : (hasReliableDisplayParity ? Number(nativeOpdDiag.rmsWaves) : NaN);
                                            const shouldFallbackToJsOpd = Number.isFinite(parityForFallback)
                                                ? (parityForFallback > maxAllowedRmsWaves)
                                                : false;

                                            if (shouldFallbackToJsOpd) {
                                                console.warn('⚠️ ' + diagLine);
                                            } else {
                                                console.log(diagLine);
                                            }
                                            try {
                                                if (window.opener && window.opener.console) {
                                                    const logFn = shouldFallbackToJsOpd
                                                        ? window.opener.console.warn
                                                        : window.opener.console.log;
                                                    if (typeof logFn === 'function') {
                                                        logFn.call(window.opener.console, (shouldFallbackToJsOpd ? '⚠️ ' : '') + diagLine);
                                                    }
                                                }
                                            } catch (_) {}

                                            try {
                                                window['__lastOpdParityDiffWaves'] = diffGridWaves;
                                                window['__lastOpdParitySummary'] = nativeOpdDiag;
                                                window['__lastOpdParityRawSummary'] = rawDiag;
                                                if (window.opener) {
                                                    window.opener['__lastOpdParitySummary'] = nativeOpdDiag;
                                                    window.opener['__lastOpdParityRawSummary'] = rawDiag;
                                                }
                                            } catch (_) {}

                                            await renderOpdParityHeatmap(diffGridWaves, nativeOpdDiag);

                                            if (shouldFallbackToJsOpd) {
                                                try {
                                                    const fbMsg = '⚠️ [PSF popup] Native OPD parity exceeded threshold (rms=' +
                                                        Number(parityForFallback).toExponential(3) + 'λ > ' +
                                                        Number(maxAllowedRmsWaves).toExponential(3) + 'λ). Falling back to JS OPD.';
                                                    console.warn(fbMsg);
                                                    if (window.opener && window.opener.console && typeof window.opener.console.warn === 'function') {
                                                        window.opener.console.warn(fbMsg);
                                                    }
                                                } catch (_) {}
                                                nativeOpdResp = null;
                                            }
                                        }
                                    }
                                }
                            } catch (diagErr) {
                                try {
                                    if (String(diagErr?.message || '') !== '__skip_opd_parity_diag__') {
                                        // Non-fatal diagnostic path failure should not block native pipeline.
                                        console.warn('⚠️ [PSF popup] OPD parity diagnostic skipped due to error:', diagErr);
                                    }
                                } catch (_) {}
                            }

                            if (nativeOpdResp) {
                                const nativePupilMode = String(nativeOpdResp?.pupilSamplingMode || '').toLowerCase();
                                wavefrontMap = {
                                    pupilSamplingMode: nativePupilMode === 'stop' ? 'stop' : 'entrance',
                                    pupilPhysicalRadiusMm: NaN,
                                    entranceEffectiveRadiusMm: NaN,
                                    pupilRange: 1.0,
                                    pupilCoordinates: [],
                                    display: { opds: [] },
                                    opds: []
                                };
                            }
                        } catch (nativeErr) {
                            nativeOpdResp = null;
                            try {
                                const msg = '⚠️ [PSF popup] Native OPD failed, falling back to JS OPD: ' + String(nativeErr?.message || nativeErr || 'unknown');
                                console.warn(msg);
                                try {
                                    if (window.opener && window.opener.console && typeof window.opener.console.warn === 'function') {
                                        window.opener.console.warn(msg);
                                    }
                                } catch (_) {}
                            } catch (_) {}
                        }
                    }

                    if (!nativeOpdResp) {
                        const host = window.opener || window;
                        const calculatorFactory =
                            (host && typeof host.createOPDCalculator === 'function' && host.createOPDCalculator)
                            || (typeof window.createOPDCalculator === 'function' && window.createOPDCalculator)
                            || (typeof createOPDCalculator === 'function' ? createOPDCalculator : null);
                        const analyzerFactory =
                            (host && typeof host.createWavefrontAnalyzer === 'function' && host.createWavefrontAnalyzer)
                            || (typeof window.createWavefrontAnalyzer === 'function' && window.createWavefrontAnalyzer)
                            || (typeof createWavefrontAnalyzer === 'function' ? createWavefrontAnalyzer : null);
                        const opdCalculator = calculatorFactory ? calculatorFactory(opticalSystemRows, wavelength) : null;
                        if (!opdCalculator) {
                            throw new Error('createOPDCalculator is not available');
                        }
                        const analyzer = analyzerFactory ? analyzerFactory(opdCalculator) : null;
                        if (!analyzer) {
                            throw new Error('WavefrontAberrationAnalyzer is not available');
                        }

                        wavefrontMap = await raceWithCancel(analyzer.generateWavefrontMap(fieldSetting, wavefrontGridSize, 'circular', {
                            recordRays: false,
                            progressEvery: 0,
                            renderFromZernike: false,
                            skipZernikeFit: true,
                            opdMode: 'simple',
                            opdDisplayMode,
                            diagnoseDiscontinuities: PSF_DEBUG,
                            diagTopK: 8,
                            cancelToken: activeCancelToken,
                            onProgress: (evt) => {
                                const p = Number(evt && evt.percent);
                                const msg = (evt && evt.message) || (evt && evt.phase) || 'OPD...';
                                const phase = (evt && evt.phase) ? evt.phase : 'opd';
                                if (Number.isFinite(p)) onProgress({ percent: Math.max(0, Math.min(80, p * 0.8)), phase, message: msg });
                                else onProgress({ percent: null, phase, message: msg });
                            }
                        }), activeCancelToken);
                        throwIfCancelled(activeCancelToken);

                        if (wavefrontMap && wavefrontMap.error) {
                            const err = new Error((wavefrontMap.error && wavefrontMap.error.message) ? wavefrontMap.error.message : 'Wavefront generation failed (popup).');
                            err.code = 'WAVEFRONT_UNAVAILABLE';
                            err.wavefrontError = wavefrontMap.error;
                            throw err;
                        }
                    }

                    if (PSF_DEBUG) {
                    }
                    
                    // CRITICAL: Use actual entrance pupil radius for spatial frequency scaling
                    // In entrance pupil mode, pupilPhysicalRadiusMm (stop radius) != actual entrance pupil radius
                    const actualPupilRadiusMm = (wavefrontMap.pupilSamplingMode === 'entrance' && 
                                                  Number.isFinite(wavefrontMap.entranceEffectiveRadiusMm))
                        ? wavefrontMap.entranceEffectiveRadiusMm
                        : wavefrontMap.pupilPhysicalRadiusMm;
                    

                    // Convert to PSF calculator format (gridData)
                    // Build OPD grid from the wavefront map samples (piston+tilt removed display OPD).
                    const gridSize = wavefrontGridSize;
                    const s = Math.max(2, Math.floor(Number(gridSize)));
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

                    let rayData = [];
                    let coords = [];
                    let opdMicrons = [];
                    if (nativeOpdResp && Array.isArray(nativeOpdResp.displayOpdGrid)) {
                        for (let iy = 0; iy < s; iy++) {
                            const rowDisplay = nativeOpdResp.displayOpdGrid[iy] || [];
                            const rowRaw = Array.isArray(nativeOpdResp.rawOpdGrid) ? (nativeOpdResp.rawOpdGrid[iy] || []) : [];
                            for (let ix = 0; ix < s; ix++) {
                                const rawCell = rowRaw[ix];
                                if (rawCell === null || rawCell === undefined || rawCell === '') continue;
                                const vRawWaves = Number(rawCell);
                                // IMPORTANT: Use raw OPD occupancy as the pupil validity mask.
                                // Native display grid can be detrended/fitted and become dense, which
                                // incorrectly turns PSF pupil mask into full grid.
                                if (!Number.isFinite(vRawWaves)) continue;

                                const displayCell = rowDisplay[ix];
                                const vDisplayWaves = (displayCell === null || displayCell === undefined || displayCell === '')
                                    ? NaN
                                    : Number(displayCell);
                                const vWaves = Number.isFinite(vDisplayWaves) ? vDisplayWaves : vRawWaves;
                                // Native OPD map grid values are in waves; PSF calculator expects microns.
                                const vMicrons = vWaves * wavelength;
                                coords.push({ ix, iy, x: Number(xCoords[ix]), y: Number(yCoords[iy]) });
                                opdMicrons.push(vMicrons);
                            }
                        }
                    } else {
                        coords = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
                        opdMicrons = (wavefrontMap?.display && Array.isArray(wavefrontMap.display.opds))
                            ? wavefrontMap.display.opds
                            : (Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds : []);
                    }

                    const n = Math.min(coords.length, opdMicrons.length);
                    for (let k = 0; k < n; k++) {
                        const c = coords[k];
                        const ix = Number.isInteger(c?.ix) ? c.ix : null;
                        const iy = Number.isInteger(c?.iy) ? c.iy : null;
                        if (ix === null || iy === null) continue;
                        if (ix < 0 || ix >= s || iy < 0 || iy >= s) continue;
                        const vMicrons = Number(opdMicrons[k]);
                        if (!Number.isFinite(vMicrons)) continue;
                        maskGrid[iy][ix] = true;
                        opdGrid[iy][ix] = vMicrons;
                        ampGrid[iy][ix] = 1.0;
                    }

                    for (let k = 0; k < n; k++) {
                        const c = coords[k];
                        const x = Number(c?.x);
                        const y = Number(c?.y);
                        const vMicrons = Number(opdMicrons[k]);
                        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(vMicrons)) continue;
                        rayData.push({
                            pupilX: x,
                            pupilY: y,
                            opd: vMicrons,
                            isVignetted: false
                        });
                    }

                    let filledCount = 0;
                    for (let iy = 0; iy < s; iy++) {
                        for (let ix = 0; ix < s; ix++) {
                            if (maskGrid[iy][ix]) filledCount++;
                        }
                    }

                    const opdData = {
                        gridSize: s,
                        wavelength: wavelength,
                        rayData,
                        gridData: {
                            opd: opdGrid,
                            amplitude: ampGrid,
                            pupilMask: maskGrid,
                            xCoords,
                            yCoords
                        }
                    };

                    if (PSF_DEBUG) try {
                        let valid = 0;
                        let sum = 0;
                        let sum2 = 0;
                        let min = Infinity;
                        let max = -Infinity;
                        for (let iy = 0; iy < s; iy++) {
                            for (let ix = 0; ix < s; ix++) {
                                if (!maskGrid[iy][ix]) continue;
                                const v = Number(opdGrid[iy][ix]);
                                if (!Number.isFinite(v)) continue;
                                valid++;
                                sum += v;
                                sum2 += v * v;
                                if (v < min) min = v;
                                if (v > max) max = v;
                            }
                        }
                        const mean = valid ? (sum / valid) : NaN;
                        const rms = valid ? Math.sqrt(Math.max(0, sum2 / valid - mean * mean)) : NaN;
                        const ptp = (Number.isFinite(min) && Number.isFinite(max)) ? (max - min) : NaN;
                        const rmsW = (Number.isFinite(rms) && Number.isFinite(wavelength) && wavelength > 0) ? (rms / wavelength) : NaN;
                        const ptpW = (Number.isFinite(ptp) && Number.isFinite(wavelength) && wavelength > 0) ? (ptp / wavelength) : NaN;
                        const line = '📌 [PSF popup] OPD grid stats: valid=' + valid + '/' + (s * s) +
                            ' (' + (100 * valid / (s * s)).toFixed(1) + '%)' +
                            ' rms=' + (Number.isFinite(rms) ? rms.toExponential(3) : String(rms)) + 'µm' +
                            ' (' + (Number.isFinite(rmsW) ? rmsW.toExponential(3) : String(rmsW)) + 'λ)' +
                            ' ptp=' + (Number.isFinite(ptp) ? ptp.toExponential(3) : String(ptp)) + 'µm' +
                            ' (' + (Number.isFinite(ptpW) ? ptpW.toExponential(3) : String(ptpW)) + 'λ)';
                        console.log(line);
                        try {
                            if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                window.opener.console.log(line);
                            }
                        } catch (_) {}
                        if (wavefrontMap?.pupilMaskStats) {
                            console.log('📌 [PSF popup] pupilMaskStats:', wavefrontMap.pupilMaskStats);
                        }

                        try {
                            const mode = wavefrontMap && wavefrontMap.pupilSamplingMode;
                            const bestEffort = !!(wavefrontMap && wavefrontMap.bestEffortVignettedPupil);
                            if (mode) {
                                const msg = '📌 [PSF popup] pupilSamplingMode=' + String(mode) + (bestEffort ? ' (bestEffortVignettedPupil=true)' : '');
                                console.log(msg);
                                try {
                                    if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                        window.opener.console.log(msg);
                                    }
                                } catch (_) {}
                            }

                            const reasons = (wavefrontMap && wavefrontMap.invalidReasonCounts) ? wavefrontMap.invalidReasonCounts : null;
                            const top = reasons
                                ? Object.entries(reasons).sort((a, b) => ((b && b[1]) || 0) - ((a && a[1]) || 0)).slice(0, 8)
                                : [];
                            if (top.length) {
                                const msg = '📌 [PSF popup] invalid reasons top: ' + top.map((kv) => String(kv && kv[0]) + ':' + String(kv && kv[1])).join(', ');
                                console.log(msg);
                                try {
                                    if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                        window.opener.console.log(msg);
                                    }
                                } catch (_) {}
                            }
                        } catch (_) {}
                    } catch (_) {}

                    let pupilDiameterMm = actualPupilRadiusMm * 2;
                    let focalLengthMm = Number.NaN;
                    let stopIndexForLog = -1;

                    try {
                        const si = Number(findStopSurfaceIndex(opticalSystemRows));
                        if (Number.isFinite(si)) stopIndexForLog = si;
                    } catch (_) {}

                    try {
                        const diffParams = calculateImageSpaceDiffractionParams(opticalSystemRows, wavelength);
                        const fWork = Number(diffParams?.fNumberWorking);
                        const derivedFocal = Number(diffParams?.focalLengthMm);

                        if (Number.isFinite(fWork) && fWork > 0 && Number.isFinite(derivedFocal) && derivedFocal > 0) {
                            focalLengthMm = Math.abs(derivedFocal);
                            pupilDiameterMm = focalLengthMm / fWork;
                        }
                    } catch (_) {}

                    // Fallback to stop diameter only when paraxial/image-space data is unavailable.
                    if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) {
                        try {
                            const si = Number((window.opener && typeof window.opener.findStopSurfaceIndex === 'function')
                                ? window.opener.findStopSurfaceIndex(opticalSystemRows)
                                : findStopSurfaceIndex(opticalSystemRows));
                            const stopRow = (Number.isFinite(si) && si >= 0) ? opticalSystemRows?.[si] : null;
                            const sdRaw = stopRow?.semidia ?? stopRow?.Semidia ?? stopRow?.['Semi Diameter'] ?? stopRow?.aperture ?? stopRow?.Aperture ?? NaN;
                            const sd = Math.abs(parseFloat(sdRaw));
                            if (Number.isFinite(sd) && sd > 0) {
                                const isApertureField = !!(stopRow && (stopRow.aperture !== undefined || stopRow.Aperture !== undefined));
                                const stopRadiusMm = isApertureField ? (sd * 0.5) : sd;
                                if (Number.isFinite(stopRadiusMm) && stopRadiusMm > 0) {
                                    pupilDiameterMm = stopRadiusMm * 2;
                                }
                            }
                        } catch (_) {}
                    }

                    if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
                        // Last-resort safeguard to keep FFT scaling defined even when paraxial FL is unavailable.
                        focalLengthMm = 100.0;
                    }

                    logScaleInputs(pupilDiameterMm, focalLengthMm, stopIndexForLog);

                    const psfSamplingSize = Number.isFinite(zernikeSampling) ? zernikeSampling : 128;
                    const zeroPadTo = (zeroPadRaw === 'none')
                        ? psfSamplingSize
                        : (zeroPadRaw === 'auto')
                            ? 0
                            : (Number.isFinite(parseInt(zeroPadRaw)) ? parseInt(zeroPadRaw) : 0);
                    const canUseNativePsfMap = !!(window.opener && typeof window.opener.runDesktopNativePsfMapForPopup === 'function');
                    if (!canUseNativePsfMap) {
                        throw new Error('Native Rust PSF map path is required but unavailable.');
                    }

                    const minRecommendedFftSize = 512;
                    const requestedFftSize = (!zeroPadTo || zeroPadTo === 0)
                        ? Math.max(psfSamplingSize, minRecommendedFftSize)
                        : Math.max(psfSamplingSize, zeroPadTo);
                    const basePixelPitchUm = (Number(wavelength) * Math.abs(Number(focalLengthMm))) / Math.max(1e-12, Math.abs(Number(pupilDiameterMm)));
                    const pixelSizeUm = basePixelPitchUm * (psfSamplingSize / requestedFftSize);

                    onProgress({ percent: 80, phase: 'psf', message: 'PSF (native)...' });
                    const nativePsfResp = await raceWithCancel(window.opener.runDesktopNativePsfMapForPopup({
                        gridOpd: Array.from({ length: s }, (_, iy) => Array.from(opdGrid[iy] || [])),
                        gridAmplitude: Array.from({ length: s }, (_, iy) => Array.from(ampGrid[iy] || [])),
                        pupilMask: Array.from({ length: s }, (_, iy) => Array.from(maskGrid[iy] || [])),
                        wavelengthUm: wavelength,
                        pixelSizeUm,
                        removeTilt: false,
                        zeroPadTo: requestedFftSize,
                        recenterIfWrapped: false,
                    }), activeCancelToken);
                    const psfResult = {
                        psfData: nativePsfResp?.psfData,
                        metrics: nativePsfResp?.metrics,
                        samplingSize: psfSamplingSize,
                        wavelength,
                        gridData: opdData?.gridData,
                        options: { pupilDiameter: pupilDiameterMm, focalLength: focalLengthMm, pixelSize: pixelSizeUm },
                        metadata: {
                            method: 'native-rust-psf-map',
                            backend: nativePsfResp?.backend,
                            samplingSize: psfSamplingSize,
                            fftSize: nativePsfResp?.fftSize,
                            wavelength,
                            pixelSize: pixelSizeUm,
                        },
                        implementationUsed: 'NativeRust',
                    };
                    throwIfCancelled(activeCancelToken);

                    setPopupPsfBadge('');

                    try {
                        const impl = String(psfResult?.implementationUsed || 'unknown');
                        const method = String(psfResult?.metadata?.method || '');
                        const implLine = '🧪 [PSF popup] implementation=' + impl + (method ? (' method=' + method) : '');
                        const pixelSizeUm = Number(psfResult?.options?.pixelSize);
                        const scaleLine = '📏 [PSF popup] scale pupilDiameterMm=' + Number(pupilDiameterMm).toFixed(6)
                            + ' focalLengthMm=' + Number(focalLengthMm).toFixed(6)
                            + ' pixelSizeUm=' + (Number.isFinite(pixelSizeUm) ? pixelSizeUm.toFixed(6) : 'n/a');
                        console.log(implLine);
                        console.log(scaleLine);
                        try {
                            window['__lastPsfImplLine'] = implLine;
                            window['__lastPsfScaleLine'] = scaleLine;
                        } catch (_) {}
                        try {
                            if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                window.opener.console.log(implLine);
                                window.opener.console.log(scaleLine);
                            }
                        } catch (_) {}

                        const statsEl = document.getElementById('popup-psf-container-stats');
                        if (statsEl) {
                            statsEl.innerHTML = '';
                            statsEl.textContent = '';
                            statsEl.style.display = 'none';
                            if (nativeOpdDiag && Number.isFinite(nativeOpdDiag.rmsWaves)) {
                                const maxAllowedRmsWaves = (() => {
                                    const v = Number((typeof window !== 'undefined')
                                        ? window.__PSF_POPUP_NATIVE_OPD_PARITY_MAX_RMS_WAVES
                                        : NaN);
                                    return (Number.isFinite(v) && v > 0) ? v : 5e-2;
                                })();
                                const warn = Number(nativeOpdDiag.rmsWaves) > maxAllowedRmsWaves;
                                const prefix = warn ? '⚠️ ' : 'ℹ️ ';
                                const centerRms = Number(nativeOpdDiag?.radialBands?.center?.rmsWaves);
                                const midRms = Number(nativeOpdDiag?.radialBands?.mid?.rmsWaves);
                                const edgeRms = Number(nativeOpdDiag?.radialBands?.edge?.rmsWaves);
                                const maxIx = Number(nativeOpdDiag?.maxLoc?.ix);
                                const maxIy = Number(nativeOpdDiag?.maxLoc?.iy);
                                const fitScale = Number(nativeOpdDiag?.fit?.scale);
                                const fitOffset = Number(nativeOpdDiag?.fit?.offsetWaves);
                                const fitResidual = Number(nativeOpdDiag?.fit?.residualRmsWaves);
                                const rawRms = Number(nativeOpdDiag?.rawParity?.rmsWaves);
                                const rawMean = Number(nativeOpdDiag?.rawParity?.meanAbsWaves);
                                const rawMax = Number(nativeOpdDiag?.rawParity?.maxAbsWaves);
                                const bandMsg = ' bands(rms λ): C=' + (Number.isFinite(centerRms) ? centerRms.toExponential(2) : 'n/a')
                                    + ' M=' + (Number.isFinite(midRms) ? midRms.toExponential(2) : 'n/a')
                                    + ' E=' + (Number.isFinite(edgeRms) ? edgeRms.toExponential(2) : 'n/a');
                                const fitMsg = ' fit: s=' + (Number.isFinite(fitScale) ? fitScale.toExponential(2) : 'n/a')
                                    + ' b=' + (Number.isFinite(fitOffset) ? fitOffset.toExponential(2) : 'n/a') + 'λ'
                                    + ' rmsRes=' + (Number.isFinite(fitResidual) ? fitResidual.toExponential(2) : 'n/a') + 'λ';
                                const rawMsg = (Number.isFinite(rawRms) || Number.isFinite(rawMean) || Number.isFinite(rawMax))
                                    ? (' raw(rms/mean/max λ)=' +
                                        (Number.isFinite(rawRms) ? rawRms.toExponential(2) : 'n/a') + '/' +
                                        (Number.isFinite(rawMean) ? rawMean.toExponential(2) : 'n/a') + '/' +
                                        (Number.isFinite(rawMax) ? rawMax.toExponential(2) : 'n/a'))
                                    : '';
                                const msg = prefix + 'OPD parity (Native vs JS): ' +
                                    'rms=' + Number(nativeOpdDiag.rmsWaves).toExponential(3) + 'λ, ' +
                                    'meanAbs=' + Number(nativeOpdDiag.meanAbsWaves).toExponential(3) + 'λ, ' +
                                    'maxAbs=' + Number(nativeOpdDiag.maxAbsWaves).toExponential(3) + 'λ@(' + (Number.isFinite(maxIx) ? String(maxIx) : '?') + ',' + (Number.isFinite(maxIy) ? String(maxIy) : '?') + ')' +
                                    bandMsg + fitMsg + rawMsg;
                                void msg;
                                statsEl.style.color = warn ? '#b91c1c' : '#334155';
                            }
                        }
                    } catch (_) {}

                    try {
                        const enablePsfParityDiag = !!(typeof window !== 'undefined' && window.__PSF_POPUP_ENABLE_PSF_PARITY_DIAG === true);
                        if (!enablePsfParityDiag) {
                            throw new Error('__skip_psf_parity_diag__');
                        }

                        const isNative = String(psfResult?.implementationUsed || '').toLowerCase() === 'nativerust';
                        const parityEnabled = isPopupTauriRuntime() && isNative;
                        const parityRan = !!window['__psfNativeParityDone'];
                        if (parityEnabled && !parityRan) {
                            window['__psfNativeParityDone'] = true;
                            void (async () => {
                                try {
                                    const psfCalculator = (() => {
                                        const host = window.opener || window;
                                        const PsfCalculatorCtor =
                                            (host && host.PSFCalculator)
                                            || window.PSFCalculator;
                                        if (typeof PsfCalculatorCtor !== 'function') {
                                            throw new Error('PSFCalculator is not available');
                                        }
                                        return new PsfCalculatorCtor();
                                    })();
                                    const jsResult = await psfCalculator.calculatePSF(opdData, {
                                        samplingSize: psfSamplingSize,
                                        wavelength,
                                        zeroPadTo,
                                        pupilDiameter: pupilDiameterMm,
                                        focalLength: focalLengthMm,
                                        forceImplementation: 'javascript',
                                        removeTilt: false,
                                    });

                                    const nativeGrid = Array.isArray(psfResult?.psfData) ? psfResult.psfData : [];
                                    const jsGrid = Array.isArray(jsResult?.psfData) ? jsResult.psfData : [];
                                    const h = Math.min(nativeGrid.length, jsGrid.length);
                                    const w = h > 0 ? Math.min((nativeGrid[0] || []).length, (jsGrid[0] || []).length) : 0;

                                    let n = 0;
                                    let sumSq = 0;
                                    let maxAbs = 0;
                                    let sumAbs = 0;
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
                                            n++;
                                        }
                                    }

                                    const rmsAbs = n > 0 ? Math.sqrt(sumSq / n) : NaN;
                                    const meanAbs = n > 0 ? (sumAbs / n) : NaN;

                                    const nMetrics = psfResult?.metrics || {};
                                    const jMetrics = jsResult?.metrics || {};
                                    const fwhmNative = Number(nMetrics?.fwhm?.average);
                                    const fwhmJs = Number(jMetrics?.fwhm?.average);
                                    const strehlNative = Number(nMetrics?.strehlRatio);
                                    const strehlJs = Number(jMetrics?.strehlRatio);
                                    const centerNative = nMetrics?.centerPosition || {};
                                    const centerJs = jMetrics?.centerPosition || {};

                                    const parityLine =
                                        '📊 [PSF Parity] native-vs-js ' +
                                        'grid=' + h + 'x' + w + ' n=' + n + ' ' +
                                        'rmsAbs=' + (Number.isFinite(rmsAbs) ? rmsAbs.toExponential(4) : 'NaN') + ' ' +
                                        'meanAbs=' + (Number.isFinite(meanAbs) ? meanAbs.toExponential(4) : 'NaN') + ' ' +
                                        'maxAbs=' + (Number.isFinite(maxAbs) ? maxAbs.toExponential(4) : 'NaN') + ' ' +
                                        'strehlΔ=' + (strehlNative - strehlJs).toExponential(4) + ' ' +
                                        'fwhmAvgΔ=' + (fwhmNative - fwhmJs).toExponential(4) + 'µm ' +
                                        'centerΔ=(' + (Number(centerNative?.x) - Number(centerJs?.x)) + ',' + (Number(centerNative?.y) - Number(centerJs?.y)) + ')';

                                    const paritySummary = {
                                        grid: { h, w, n },
                                        abs: {
                                            rms: Number.isFinite(rmsAbs) ? rmsAbs : null,
                                            mean: Number.isFinite(meanAbs) ? meanAbs : null,
                                            max: Number.isFinite(maxAbs) ? maxAbs : null,
                                        },
                                        delta: {
                                            strehl: Number.isFinite(strehlNative) && Number.isFinite(strehlJs) ? (strehlNative - strehlJs) : null,
                                            fwhmAvgUm: Number.isFinite(fwhmNative) && Number.isFinite(fwhmJs) ? (fwhmNative - fwhmJs) : null,
                                            centerX: Number(centerNative?.x) - Number(centerJs?.x),
                                            centerY: Number(centerNative?.y) - Number(centerJs?.y),
                                        },
                                    };

                                    try {
                                        window['__lastPsfParityLine'] = parityLine;
                                        window['__lastPsfParity'] = paritySummary;
                                        if (window.opener) {
                                            window.opener['__lastPsfParityLine'] = parityLine;
                                            window.opener['__lastPsfParity'] = paritySummary;
                                        }
                                    } catch (_) {}

                                    console.log(parityLine);
                                    try {
                                        if (window.opener && window.opener.console && typeof window.opener.console.log === 'function') {
                                            window.opener.console.log(parityLine);
                                        }
                                    } catch (_) {}
                                } catch (parityErr) {
                                    console.warn('⚠️ [PSF Parity] native-vs-js compare failed:', parityErr);
                                }
                            })();
                        }
                    } catch (parityDiagErr) {
                        try {
                            if (String(parityDiagErr?.message || '') !== '__skip_psf_parity_diag__') {
                                console.warn('⚠️ [PSF popup] PSF parity diagnostic skipped due to error:', parityDiagErr);
                            }
                        } catch (_) {}
                    }

                    const plotter = (() => {
                        if (window.opener && window.opener.PSFPlotter) {
                            return new window.opener.PSFPlotter(containerEl);
                        }
                        throw new Error('PSFPlotter not available from opener window');
                    })();
                    await plotter.plot2DPSF(psfResult, { logScale, title: '', recenterToCentroid: false });
                }

                hideProgress();
                resizePlot();
                hideProgress();
            } catch (err) {
                setPopupPsfBadge('Error');
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    const msg = String((err && err.message) || err || 'Unknown error');
                    const stack = String((err && err.stack) || '');
                    const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => {
                        switch (ch) {
                            case '&': return '&amp;';
                            case '<': return '&lt;';
                            case '>': return '&gt;';
                            case '"': return '&quot;';
                            case "'": return '&#39;';
                            default: return ch;
                        }
                    });
                    const details = escapeHtml(msg + (stack ? '\\n\\n' + stack : ''));
                    containerEl.innerHTML =
                        '<div style="padding:20px;color:red;font-family:Arial;">' +
                            '<div style="font-weight:bold;margin-bottom:8px;">Failed to generate PSF</div>' +
                            '<pre style="white-space:pre-wrap;word-break:break-word;">' + details + '</pre>' +
                        '</div>';
                }
            } finally {
                try {
                    if (stopBtn) stopBtn.disabled = true;
                } catch (_) {}
            }
        };

        document.getElementById('popup-show-psf-btn').addEventListener('click', () => window.renderPSF());

        document.getElementById('popup-stop-psf-btn').addEventListener('click', () => {
            try {
                const el = document.getElementById('popup-psf-pipeline-badge');
                if (el) el.textContent = '';
            } catch (_) {}
            try {
                if (activeCancelToken && typeof activeCancelToken.abort === 'function') {
                    activeCancelToken.abort('Stopped by user');
                }
            } catch (_) {}
        });

        function syncAll() {
            syncObjectOptionsFromOpener();
            syncInputsFromOpener();
        }
        // Expose for opener-triggered refresh when reusing an existing popup window.
        window['syncAll'] = syncAll;
        window['syncObjectOptionsFromOpener'] = syncObjectOptionsFromOpener;
        window.addEventListener('resize', resizePlot);
        window.addEventListener('focus', syncAll);
        syncAll();

        // Do not auto-render on open; user triggers calculation via "Show PSF".
        window.addEventListener('load', () => {
            try {
                const popupSampling = document.getElementById('popup-psf-sampling-select');
                const popupZernikeSampling = document.getElementById('popup-psf-zernike-sampling-select');
                const popupLog = document.getElementById('popup-psf-log-scale-checkbox');
                if (popupSampling && !popupSampling.value) popupSampling.value = 'auto';
                if (popupZernikeSampling && !popupZernikeSampling.value) popupZernikeSampling.value = '256';
                if (popupLog && typeof popupLog.checked !== 'boolean') popupLog.checked = false;
            } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });

                w.runPsfParityCapture = async (options: any = {}) => {
                    const opts: any = options || {};
                    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 15000);
                    const pollMs = Math.max(50, Number(opts.pollMs) || 120);
                    const startedAt = Date.now();

                    try {
                        if (!w.__psfPopup || w.__psfPopup.closed) {
                            openPsfWindowBtn.click();
                        }
                    } catch (_) {}

                    while ((!w.__psfPopup || w.__psfPopup.closed) && (Date.now() - startedAt) < timeoutMs) {
                        await new Promise((r) => setTimeout(r, pollMs));
                    }

                    const popup = w.__psfPopup;
                    if (!popup || popup.closed) {
                        throw new Error('PSF popup could not be opened. Please open it manually and run again.');
                    }

                    while ((typeof popup.renderPSF !== 'function') && (Date.now() - startedAt) < timeoutMs) {
                        await new Promise((r) => setTimeout(r, pollMs));
                    }

                    if (typeof popup.renderPSF !== 'function') {
                        throw new Error('PSF popup is open but renderPSF is not ready yet. Try again in 1-2 seconds.');
                    }

                    popup.__PSF_DEBUG = true;
                    popup.__PSF_USE_DESKTOP_ANALYSIS_PREVIEW = false;
                    popup.__psfNativeParityDone = false;

                    await popup.renderPSF();

                    const result = {
                        implLine: popup.__lastPsfImplLine || null,
                        scaleLine: popup.__lastPsfScaleLine || null,
                        parityLine: popup.__lastPsfParityLine || w.__lastPsfParityLine || null,
                        parity: popup.__lastPsfParity || w.__lastPsfParity || null,
                    };

                    try {
                        console.log('🧪 [runPsfParityCapture] result:', result);
                    } catch (_) {}
                    return result;
                };

                const mainShowPsfBtn = document.getElementById('show-psf-btn');
                if (mainShowPsfBtn && !(mainShowPsfBtn as any).__cooptUnifiedPsfPipelineBound) {
                    (mainShowPsfBtn as any).__cooptUnifiedPsfPipelineBound = true;
                    mainShowPsfBtn.addEventListener('click', async () => {
                        const setUnifiedPsfBadge = (status: string) => {
                            try {
                                const el = document.getElementById('psf-pipeline-badge');
                                if (!el) return;
                                const text = String(status || '');
                                el.textContent = text;
                                if (text) {
                                    el.setAttribute('title', text + ' (Main Show PSF uses Popup renderPSF)');
                                } else {
                                    el.removeAttribute('title');
                                }
                            } catch (_) {}
                        };

                        const getDoneStatusWithImpl = (popupRef: any) => {
                            try {
                                const implLine = String(popupRef?.__lastPsfImplLine || '');
                                const m = implLine.match(/implementation=([^\s]+)/);
                                const impl = m && m[1] ? String(m[1]) : '';
                                return impl ? ('Done (' + impl + ')') : 'Done';
                            } catch (_) {
                                return 'Done';
                            }
                        };

                        const waitForPopupReady = async (popupRef: any, timeoutMs: number = 12000) => {
                            const startedAt = Date.now();
                            while ((Date.now() - startedAt) < timeoutMs) {
                                try {
                                    if (popupRef && !popupRef.closed && typeof popupRef.renderPSF === 'function') return true;
                                } catch (_) {}
                                await new Promise((r) => setTimeout(r, 80));
                            }
                            return false;
                        };

                        try {
                            setUnifiedPsfBadge('Running');
                            if (w.__psfPopup && !w.__psfPopup.closed) {
                                try {
                                    if (typeof w.__psfPopup.syncAll === 'function') {
                                        w.__psfPopup.syncAll();
                                    }
                                } catch (_) {}
                                try { w.__psfPopup.focus(); } catch (_) {}
                                if (typeof w.__psfPopup.renderPSF === 'function') {
                                    await w.__psfPopup.renderPSF();
                                    setUnifiedPsfBadge(getDoneStatusWithImpl(w.__psfPopup));
                                    return;
                                }
                            }

                            (openPsfWindowBtn as HTMLButtonElement).click();
                            const popup = w.__psfPopup;
                            const ready = await waitForPopupReady(popup, 15000);
                            if (!ready) {
                                throw new Error('PSF popup is not ready.');
                            }
                            try {
                                if (typeof popup.syncAll === 'function') {
                                    popup.syncAll();
                                }
                            } catch (_) {}
                            await popup.renderPSF();
                            setUnifiedPsfBadge(getDoneStatusWithImpl(popup));
                        } catch (err: any) {
                            setUnifiedPsfBadge('Error');
                            console.error('❌ [PSF Unified] Failed to render via popup pipeline:', err);
                            alert(`PSF calculation failed: ${String(err?.message || err || 'Unknown error')}`);
                        }
                    });
                }

                const mainStopPsfBtn = document.getElementById('stop-psf-btn');
                if (mainStopPsfBtn && !(mainStopPsfBtn as any).__cooptUnifiedPsfPipelineBound) {
                    (mainStopPsfBtn as any).__cooptUnifiedPsfPipelineBound = true;
                    mainStopPsfBtn.addEventListener('click', () => {
                        try {
                            const el = document.getElementById('psf-pipeline-badge');
                            if (el) el.textContent = '';
                        } catch (_) {}
                        try {
                            const popup = w.__psfPopup;
                            if (!popup || popup.closed) return;
                            const stopBtn = popup.document && popup.document.getElementById('popup-stop-psf-btn');
                            if (stopBtn && typeof (stopBtn as HTMLButtonElement).click === 'function') {
                                (stopBtn as HTMLButtonElement).click();
                                return;
                            }
                            if (typeof popup.activeCancelToken?.abort === 'function') {
                                popup.activeCancelToken.abort('Stopped by user');
                            }
                        } catch (_) {}
                    });
                }
        }

        // Modulation Transfer Function (MTF) popup window button
        const openMtfWindowBtn = document.getElementById('open-mtf-window-btn');
        if (openMtfWindowBtn) {
                openMtfWindowBtn.addEventListener('click', () => {
                        if (w.__mtfPopup && !w.__mtfPopup.closed) {
                                try { w.__mtfPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Modulation Transfer Function', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__mtfPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Modulation Transfer Function</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 120px;
        }
        .controls input[type="checkbox"] {
            width: auto;
            padding: 0;
            border: none;
            background: transparent;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .note { padding: 8px 12px; font-size: 12px; color: #666; border-bottom: 1px solid #eee; background: #fff; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-mtf-container { flex: 1 1 auto; min-height: 0; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-mtf-wavelength-select">Wavelength:</label>
        <select id="popup-mtf-wavelength-select"></select>
        <label for="popup-mtf-object-select">Object:</label>
        <select id="popup-mtf-object-select"></select>
        <label for="popup-mtf-max-freq-input">Max (lp/mm):</label>
        <input id="popup-mtf-max-freq-input" type="number" min="0" step="1" value="100" />
        <label for="popup-mtf-sampling-select">Sampling:</label>
        <select id="popup-mtf-sampling-select">
            <option value="32">32x32</option>
            <option value="64">64x64</option>
            <option value="128">128x128</option>
            <option value="256" selected>256x256</option>
            <option value="512">512x512</option>
            <option value="1024">1024x1024</option>
            <option value="2048">2048x2048</option>
            <option value="4096">4096x4096</option>
        </select>
        <label for="popup-mtf-zeropad-select" title="Zero-padding increases FFT size without increasing OPD ray grid.">Zero pad:</label>
        <select id="popup-mtf-zeropad-select">
            <option value="none">None</option>
            <option value="auto" selected>Auto</option>
            <option value="512">512</option>
            <option value="1024">1024</option>
            <option value="2048">2048</option>
            <option value="4096">4096</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-mtf-remove-ptd-checkbox" type="checkbox" />
            Remove P/T/D
        </label>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-mtf-show-diff-limit-checkbox" type="checkbox" checked />
            Diffraction Limit
        </label>
        <button id="popup-show-mtf-btn" type="button">Show MTF</button>
    </div>
    <div id="popup-mtf-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-mtf-progress-text" style="margin-bottom: 6px;">Calculating MTF...</div>
        <progress id="popup-mtf-progress" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-mtf-container"></div>
    </div>

    <script>
        function safeCall(fn, fallback) {
            try { return fn(); } catch (_) { return fallback; }
        }

        function getOpener() {
            try { return window.opener || window; } catch (_) { return window; }
        }

        function popupLog(...args) {
            try { console.log(...args); } catch (_) {}
            try {
                const op = window.opener;
                if (op && op.console && typeof op.console.log === 'function') {
                    op.console.log(...args);
                }
            } catch (_) {}
        }

        function popupError(...args) {
            try { console.error(...args); } catch (_) {}
            try {
                const op = window.opener;
                if (op && op.console && typeof op.console.error === 'function') {
                    op.console.error(...args);
                }
            } catch (_) {}
        }

        function getPrimaryWavelength() {
            const opener = getOpener();
            if (!opener) return null;
            if (typeof opener.getPrimaryWavelength !== 'function') return null;
            const v = Number(safeCall(() => opener.getPrimaryWavelength(), 0));
            return Number.isFinite(v) && v > 0 ? v : null;
        }

        function buildWavelengthOptions() {
            const opener = getOpener();
            if (!opener) return [];
            const getSourceRows = opener.getSourceRows;
            const sources = (typeof getSourceRows === 'function')
                ? safeCall(() => getSourceRows(opener.tableSource), [])
                : [];
            const primary = getPrimaryWavelength();
            const out = [{ value: 'all', label: 'All' }];
            if (Array.isArray(sources) && sources.length > 0) {
                for (let i = 0; i < sources.length; i++) {
                    const wl = Number(sources[i]?.wavelength);
                    if (!Number.isFinite(wl) || wl <= 0) continue;
                    const nm = wl * 1000;
                    const label = Number.isFinite(primary) && Math.abs(wl - primary) < 1e-9
                        ? (nm.toFixed(1) + ' nm (primary)')
                        : (nm.toFixed(1) + ' nm');
                    out.push({ value: String(wl), label });
                }
            }
            if (out.length === 1) {
                if (Number.isFinite(primary) && primary > 0) {
                    out.push({ value: String(primary), label: ((primary * 1000).toFixed(1) + ' nm') });
                }
            }
            return out;
        }

        function buildObjectOptions() {
            const opener = getOpener();
            if (!opener) return [];
            const getObjectRows = opener.getObjectRows;
            const objects = (typeof getObjectRows === 'function')
                ? safeCall(() => getObjectRows(opener.tableObject), [])
                : [];
            const out = [];
            if (Array.isArray(objects) && objects.length > 0) {
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(obj.position ?? obj.object ?? obj.Object ?? obj.objectType ?? 'Point');
                    const x = (obj.x ?? obj.xHeightAngle ?? 0);
                    const y = (obj.y ?? obj.yHeightAngle ?? 0);
                    out.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }
            if (out.length === 0) out.push({ value: '0', label: '0' });
            return out;
        }

        function populateSelect(selectEl, options) {
            if (!selectEl) return;
            const current = selectEl.value;
            selectEl.innerHTML = '';
            for (const opt of options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                selectEl.appendChild(o);
            }
            if (current && Array.from(selectEl.options).some(o => o.value === current)) {
                selectEl.value = current;
            }
        }

        function syncAllOptions() {
            const wlSel = document.getElementById('popup-mtf-wavelength-select');
            const prevWl = wlSel ? wlSel.value : '';
            populateSelect(wlSel, buildWavelengthOptions());
            // Default to Primary (not All) on first open.
            if (wlSel && (!prevWl || !Array.from(wlSel.options).some(o => o.value === prevWl))) {
                const primary = getPrimaryWavelength();
                if (Number.isFinite(primary) && Array.from(wlSel.options).some(o => o.value === String(primary))) {
                    wlSel.value = String(primary);
                } else {
                    // Fallback to first numeric wavelength if present
                    const firstNumeric = Array.from(wlSel.options).find(o => o.value !== 'all');
                    if (firstNumeric) wlSel.value = firstNumeric.value;
                }
            }
            populateSelect(document.getElementById('popup-mtf-object-select'), buildObjectOptions());
        }

        window['renderMTF'] = async () => {
            const containerEl = document.getElementById('popup-mtf-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-mtf-progress-wrapper');
            const progressEl = document.getElementById('popup-mtf-progress');
            const progressTextEl = document.getElementById('popup-mtf-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressEl && Number.isFinite(value)) progressEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            const wlSel = document.getElementById('popup-mtf-wavelength-select');
            const objSel = document.getElementById('popup-mtf-object-select');
            const maxEl = document.getElementById('popup-mtf-max-freq-input');
            const samplingEl = document.getElementById('popup-mtf-sampling-select');
            const zeroPadEl = document.getElementById('popup-mtf-zeropad-select');
            const removePtdEl = document.getElementById('popup-mtf-remove-ptd-checkbox');
            const showDiffLimitEl = document.getElementById('popup-mtf-show-diff-limit-checkbox');

            const wlValue = wlSel ? String(wlSel.value) : '';
            const primary = getPrimaryWavelength();
            const wavelength = (wlValue === 'all') ? 'all' : Number(wlValue);
            const objectIndex = objSel ? parseInt(objSel.value, 10) : 0;
            const maxFreq = maxEl ? Number(maxEl.value) : 100;
            const sampling = samplingEl ? Number(samplingEl.value) : 256;
            const zeroPadRaw = zeroPadEl ? String(zeroPadEl.value || 'auto') : 'auto';
            const opdDisplayMode = (removePtdEl && removePtdEl.checked)
                ? 'pistonTiltDefocusRemoved'
                : 'pistonTiltRemoved';
            const showDiffractionLimit = !!(showDiffLimitEl && showDiffLimitEl.checked);
            const zeroPadTo = (zeroPadRaw === 'none')
                ? (Number.isFinite(sampling) ? sampling : 256)
                : (zeroPadRaw === 'auto')
                    ? 0
                    : (Number.isFinite(parseInt(zeroPadRaw, 10)) ? parseInt(zeroPadRaw, 10) : 0);

            try {
                const opener = getOpener();
                if (!opener) {
                    throw new Error('Opener is not available');
                }
                if (wavelength !== 'all' && !Number.isFinite(wavelength) && !(Number.isFinite(primary) && primary > 0)) {
                    throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
                }

                const shouldUseDesktopRust = (() => {
                    try {
                        if (typeof window !== 'undefined' && typeof window['shouldUseDesktopRustAnalysis'] === 'function') {
                            return !!window['shouldUseDesktopRustAnalysis']();
                        }
                        if (opener && typeof opener.shouldUseDesktopRustAnalysis === 'function') {
                            return !!opener.shouldUseDesktopRustAnalysis();
                        }
                        return true;
                    } catch (_) {
                        return false;
                    }
                })();
                const canUseDesktopRust = shouldUseDesktopRust && !!(
                    typeof opener.runDesktopNativeOpdMapForPopup === 'function'
                    && typeof opener.runDesktopNativePsfMapForPopup === 'function'
                    && typeof opener.runDesktopNativeMtfMapForPopup === 'function'
                );

                if (canUseDesktopRust) {
                    setProgress(0, 'Starting...');
                    await new Promise(r => setTimeout(r, 0));
                    const wavefrontGridSize = Number.isFinite(sampling) ? Math.max(32, Math.floor(sampling)) : 256;

                    const sourceRows = (typeof opener.getSourceRows === 'function')
                        ? (safeCall(() => opener.getSourceRows(opener.tableSource), []) || [])
                        : [];
                    const wavelengthList = (() => {
                        const out = [];
                        if (wavelength === 'all') {
                            if (Array.isArray(sourceRows) && sourceRows.length > 0) {
                                for (let i = 0; i < sourceRows.length; i++) {
                                    const wl = Number(sourceRows[i]?.wavelength);
                                    if (!Number.isFinite(wl) || wl <= 0) continue;
                                    if (out.some(v => Math.abs(v - wl) < 1e-9)) continue;
                                    out.push(wl);
                                }
                            }
                            if (out.length === 0 && Number.isFinite(primary) && primary > 0) {
                                out.push(primary);
                            }
                        } else {
                            const wl = (Number.isFinite(Number(wavelength)) && Number(wavelength) > 0)
                                ? Number(wavelength)
                                : ((Number.isFinite(primary) && primary > 0) ? primary : 0.5876);
                            out.push(wl);
                        }
                        if (out.length === 0) out.push(0.5876);
                        return out;
                    })();

                    const getColorForWavelengthPopup = (wl) => {
                        try {
                            if (typeof opener.getColorForWavelength === 'function') {
                                const c = opener.getColorForWavelength(wl);
                                if (typeof c === 'string' && c) return c;
                            }
                        } catch (_) {}
                        const nm = Number(wl) * 1000;
                        if (!Number.isFinite(nm)) return '#2563eb';
                        if (nm < 470) return '#2563eb';
                        if (nm < 530) return '#16a34a';
                        if (nm < 600) return '#f59e0b';
                        return '#dc2626';
                    };

                    const traces = [];
                    let nyquistGlobal = 0;
                    const selectedObjectIndex = Number.isFinite(objectIndex) ? objectIndex : 0;

                    for (let wli = 0; wli < wavelengthList.length; wli++) {
                        const wl = wavelengthList[wli];
                        const titleNm = (wl * 1000).toFixed(1);
                        const baseProgress = (wli / Math.max(1, wavelengthList.length)) * 80;
                        setProgress(10 + baseProgress, 'λ=' + titleNm + 'nm: OPD (Rust native)...');

                        const nativeOpdResp = await opener.runDesktopNativeOpdMapForPopup({
                            objectIndex: selectedObjectIndex,
                            gridSize: wavefrontGridSize,
                            wavelengthUm: wl,
                            opdDisplayMode,
                        });

                        const s = wavefrontGridSize;
                        const opdGrid = Array.from({ length: s }, () => new Float32Array(s));
                        const ampGrid = Array.from({ length: s }, () => new Float32Array(s));
                        const maskGrid = Array.from({ length: s }, () => Array(s).fill(false));

                        const displayOpdGrid = Array.isArray(nativeOpdResp?.displayOpdGrid) ? nativeOpdResp.displayOpdGrid : [];
                        const rawOpdGrid = Array.isArray(nativeOpdResp?.rawOpdGrid) ? nativeOpdResp.rawOpdGrid : [];
                        for (let iy = 0; iy < s; iy++) {
                            const rowDisplay = displayOpdGrid[iy] || [];
                            const rowRaw = rawOpdGrid[iy] || [];
                            for (let ix = 0; ix < s; ix++) {
                                const rawCell = rowRaw[ix];
                                if (rawCell === null || rawCell === undefined || rawCell === '') continue;
                                const vRawWaves = Number(rawCell);
                                if (!Number.isFinite(vRawWaves)) continue;

                                const displayCell = rowDisplay[ix];
                                const vDisplayWaves = (displayCell === null || displayCell === undefined || displayCell === '')
                                    ? NaN
                                    : Number(displayCell);
                                const vWaves = Number.isFinite(vDisplayWaves) ? vDisplayWaves : vRawWaves;
                                const vMicrons = vWaves * wl;

                                maskGrid[iy][ix] = true;
                                opdGrid[iy][ix] = vMicrons;
                                ampGrid[iy][ix] = 1.0;
                            }
                        }

                        const opticalRows = (typeof opener.getOpticalSystemRows === 'function')
                            ? (opener.getOpticalSystemRows(opener.tableOpticalSystem) || [])
                            : [];
                        let pupilDiameterMm = 10.0;
                        let focalLengthMm = Number.NaN;
                        try {
                            const diffParams = (typeof opener.calculateImageSpaceDiffractionParams === 'function')
                                ? opener.calculateImageSpaceDiffractionParams(opticalRows, wl)
                                : null;
                            const fWork = Number(diffParams?.fNumberWorking);
                            const fl = Number(diffParams?.focalLengthMm);
                            if (Number.isFinite(fl) && fl > 0 && Number.isFinite(fWork) && fWork > 0) {
                                focalLengthMm = Math.abs(fl);
                                pupilDiameterMm = focalLengthMm / fWork;
                            }
                        } catch (_) {}

                        if (!(Number.isFinite(pupilDiameterMm) && pupilDiameterMm > 0)) {
                            try {
                                const si = Number((typeof opener.findStopSurfaceIndex === 'function')
                                    ? opener.findStopSurfaceIndex(opticalRows)
                                    : -1);
                                const stopRow = (Number.isFinite(si) && si >= 0) ? opticalRows?.[si] : null;
                                const sdRaw = stopRow?.semidia ?? stopRow?.Semidia ?? stopRow?.['Semi Diameter'] ?? stopRow?.aperture ?? stopRow?.Aperture ?? NaN;
                                const sd = Math.abs(parseFloat(sdRaw));
                                if (Number.isFinite(sd) && sd > 0) {
                                    const isApertureField = !!(stopRow && (stopRow.aperture !== undefined || stopRow.Aperture !== undefined));
                                    const stopRadiusMm = isApertureField ? (sd * 0.5) : sd;
                                    if (Number.isFinite(stopRadiusMm) && stopRadiusMm > 0) {
                                        pupilDiameterMm = stopRadiusMm * 2;
                                    }
                                }
                            } catch (_) {}
                        }

                        if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
                            try {
                                const fl = Number((typeof opener.calculateFocalLength === 'function')
                                    ? opener.calculateFocalLength(opticalRows, wl)
                                    : NaN);
                                if (Number.isFinite(fl) && Math.abs(fl) > 1e-9 && fl !== Infinity) {
                                    focalLengthMm = Math.abs(fl);
                                }
                            } catch (_) {}
                        }

                        if (!(Number.isFinite(focalLengthMm) && focalLengthMm > 0)) {
                            // Last-resort safeguard to keep FFT scaling defined even when paraxial FL is unavailable.
                            focalLengthMm = 100.0;
                        }

                        const minRecommendedFftSize = 512;
                        const requestedFftSize = (!zeroPadTo || zeroPadTo === 0)
                            ? Math.max(wavefrontGridSize, minRecommendedFftSize)
                            : Math.max(wavefrontGridSize, zeroPadTo);
                        const basePixelPitchUm = (wl * Math.abs(Number(focalLengthMm))) / Math.max(1e-12, Math.abs(Number(pupilDiameterMm)));
                        const pixelSizeUm = basePixelPitchUm * (wavefrontGridSize / requestedFftSize);

                        setProgress(20 + baseProgress, 'λ=' + titleNm + 'nm: PSF (Rust native)...');
                        const nativePsfResp = await opener.runDesktopNativePsfMapForPopup({
                            gridOpd: Array.from({ length: s }, (_, iy) => Array.from(opdGrid[iy] || [])),
                            gridAmplitude: Array.from({ length: s }, (_, iy) => Array.from(ampGrid[iy] || [])),
                            pupilMask: Array.from({ length: s }, (_, iy) => Array.from(maskGrid[iy] || [])),
                            wavelengthUm: wl,
                            pixelSizeUm,
                            removeTilt: false,
                            zeroPadTo: requestedFftSize,
                            recenterIfWrapped: false,
                        });

                        setProgress(30 + baseProgress, 'λ=' + titleNm + 'nm: MTF (Rust native)...');
                        const mtfResp = await opener.runDesktopNativeMtfMapForPopup({
                            psfData: nativePsfResp?.psfData,
                            pixelSizeUm,
                            maxFrequencyLpmm: Number.isFinite(maxFreq) ? maxFreq : undefined,
                            // Keep parity with TFMTF native path which uses 121 plot points.
                            points: 121,
                        });

                        const freq = Array.isArray(mtfResp?.frequencyAxis) ? mtfResp.frequencyAxis : [];
                        const tan = Array.isArray(mtfResp?.mtfTangential) ? mtfResp.mtfTangential : [];
                        const sag = Array.isArray(mtfResp?.mtfSagittal) ? mtfResp.mtfSagittal : [];
                        if (!freq.length || !tan.length || !sag.length) {
                            throw new Error('Native Rust MTF result does not contain valid curves');
                        }

                        const color = getColorForWavelengthPopup(wl);
                        traces.push({
                            x: freq,
                            y: tan,
                            type: 'scatter',
                            mode: 'lines',
                            name: 'Tangential (' + titleNm + 'nm)',
                            line: { color, width: 2, dash: 'solid' },
                        });
                        traces.push({
                            x: freq,
                            y: sag,
                            type: 'scatter',
                            mode: 'lines',
                            name: 'Sagittal (' + titleNm + 'nm)',
                            line: { color, width: 2, dash: 'dot' },
                        });

                        const nyquist = Number(mtfResp?.nyquistLpmm);
                        if (Number.isFinite(nyquist) && nyquist > 0) {
                            nyquistGlobal = Math.max(nyquistGlobal, nyquist);
                        }

                        if (showDiffractionLimit) {
                            try {
                                const fNumber = Math.abs(Number(focalLengthMm)) / Math.max(1e-12, Math.abs(Number(pupilDiameterMm)));
                                if (Number.isFinite(fNumber) && fNumber > 0) {
                                    const diffY = [];
                                    for (let i = 0; i < freq.length; i++) {
                                        const f = Number(freq[i]);
                                        const cutoff = 1000.0 / (Math.max(1e-12, wl) * fNumber);
                                        const nu = f / Math.max(1e-12, cutoff);
                                        let val = 0;
                                        if (nu <= 0) val = 1;
                                        else if (nu >= 1) val = 0;
                                        else {
                                            const c = Math.max(-1, Math.min(1, nu));
                                            val = (2 / Math.PI) * (Math.acos(c) - c * Math.sqrt(Math.max(0, 1 - c * c)));
                                        }
                                        diffY.push(Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0);
                                    }
                                    traces.push({
                                        x: freq,
                                        y: diffY,
                                        type: 'scatter',
                                        mode: 'lines',
                                        name: 'Diff. Limit (' + titleNm + 'nm)',
                                        line: { color, width: 1.5, dash: 'dash' },
                                    });
                                }
                            } catch (_) {}
                        }
                    }

                    if (!window.Plotly || typeof window.Plotly.newPlot !== 'function') {
                        throw new Error('Plotly is not available in MTF popup');
                    }
                    if (!traces.length) {
                        throw new Error('Native Rust MTF did not produce any traces');
                    }

                    setProgress(80, 'Rendering MTF...');
                    const xAxisRangeMax = Number.isFinite(maxFreq) && maxFreq > 0
                        ? maxFreq
                        : (nyquistGlobal > 0 ? nyquistGlobal : undefined);
                    await window.Plotly.newPlot(containerEl, traces, {
                        margin: { l: 50, r: 20, t: 28, b: 42 },
                        xaxis: {
                            title: 'Spatial frequency (lp/mm)',
                            ...(Number.isFinite(xAxisRangeMax) ? { range: [0, xAxisRangeMax] } : {}),
                        },
                        yaxis: { title: 'MTF', range: [0, 1.05] },
                        showlegend: true,
                    }, { responsive: true });

                    hideProgress();
                    return;
                }

                throw new Error('Rust MTF path is required but unavailable. Ensure desktop Rust analysis is enabled.');
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    const details = String((err && err.message) ? err.message : err || 'Unknown error');
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate MTF.<br/><span style="font-size:12px;color:#555;">' + details.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>';
                }
            }
        };

        document.getElementById('popup-show-mtf-btn').addEventListener('click', () => window.renderMTF());
        window.addEventListener('focus', syncAllOptions);
        window.addEventListener('load', () => syncAllOptions());
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Through-Focus Spot popup window button
        const openThroughFocusSpotWindowBtn = document.getElementById('open-through-focus-spot-window-btn');
        if (openThroughFocusSpotWindowBtn) {
                openThroughFocusSpotWindowBtn.addEventListener('click', () => {
                        if (w.__throughFocusSpotPopup && !w.__throughFocusSpotPopup.closed) {
                                try { w.__throughFocusSpotPopup.focus(); } catch (_) {}
                                return;
                        }

                        try {
                            requestUpdateSurfaceNumberSelect(w);
                        } catch (_) {}

                        const popup = consumePreopenedAnalysisPopup('Through-Focus Spot', 'width=980,height=700');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__throughFocusSpotPopup = popup;
                        try {
                            // Tauri popups may not expose window.opener; keep an explicit bridge.
                            popup.__analysisHostWindow = window;
                        } catch (_) {}

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Through-Focus Spot</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 110px;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-through-focus-spot-container {
            flex: 1 1 auto;
            min-height: 0;
        }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-through-focus-spot-wavelength-mode-select">Wavelength:</label>
        <select id="popup-through-focus-spot-wavelength-mode-select">
            <option value="all" selected>All</option>
            <option value="primary">Primary</option>
        </select>

        <label for="popup-through-focus-spot-min-defocus-input">Defocus min (mm):</label>
        <input id="popup-through-focus-spot-min-defocus-input" type="number" step="0.001" value="-0.5" />

        <label for="popup-through-focus-spot-max-defocus-input">Defocus max (mm):</label>
        <input id="popup-through-focus-spot-max-defocus-input" type="number" step="0.001" value="0.5" />

        <label for="popup-through-focus-spot-steps-input">Steps:</label>
        <input id="popup-through-focus-spot-steps-input" type="number" min="3" max="61" step="1" value="5" />

        <label for="popup-through-focus-spot-scale-input">Scale (µm):</label>
        <input id="popup-through-focus-spot-scale-input" type="number" min="1" step="1" value="100" />

        <label for="popup-through-focus-spot-ray-count-input">Ray number:</label>
        <input type="number" id="popup-through-focus-spot-ray-count-input" value="501" min="1" max="20001" step="1" />

        <label for="popup-through-focus-spot-ring-count-select">Ring count:</label>
        <select id="popup-through-focus-spot-ring-count-select">
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="6">6</option>
            <option value="7">7</option>
            <option value="8">8</option>
            <option value="9">9</option>
            <option value="10" selected>10</option>
            <option value="12">12</option>
            <option value="15">15</option>
            <option value="16">16</option>
            <option value="20">20</option>
            <option value="24">24</option>
            <option value="32">32</option>
        </select>

        <label for="popup-through-focus-spot-pattern-select">Ray pattern:</label>
        <select id="popup-through-focus-spot-pattern-select">
            <option value="annular" selected>Annular</option>
            <option value="grid">Rectangle</option>
        </select>

        <button id="popup-show-through-focus-spot-btn" type="button">Show Through-Focus Spot</button>
    </div>
    <div id="popup-through-focus-spot-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-through-focus-spot-progress-text" style="margin-bottom: 6px;">Calculating Through-Focus Spot...</div>
        <progress id="popup-through-focus-spot-progress" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-through-focus-spot-container"></div>
    </div>

    <script>
        function getHostWindow() {
            try {
                if (window.opener && !window.opener.closed) return window.opener;
            } catch (_) {}
            try {
                if (window.__analysisHostWindow) return window.__analysisHostWindow;
            } catch (_) {}
            return null;
        }

        function getOpenerEl(id) {
            try {
                const host = getHostWindow();
                return host && host.document ? host.document.getElementById(id) : null;
            } catch (_) {
                return null;
            }
        }

        function syncInputsFromOpener() {
            const openerRay = getOpenerEl('ray-count-input');
            const openerRing = getOpenerEl('ring-count-select');
            const popupRay = document.getElementById('popup-through-focus-spot-ray-count-input');
            const popupRing = document.getElementById('popup-through-focus-spot-ring-count-select');
            if (popupRay && openerRay && popupRay.value !== openerRay.value) popupRay.value = openerRay.value;
            if (popupRing && openerRing && popupRing.value !== openerRing.value) popupRing.value = openerRing.value;

            const annular = getOpenerEl('annular-pattern-btn');
            const popupPattern = document.getElementById('popup-through-focus-spot-pattern-select');
            if (popupPattern) {
                const isAnnular = !!annular && annular.classList.contains('active');
                popupPattern.value = isAnnular ? 'annular' : 'grid';
            }
        }

        function setPopupPattern(pattern) {
            const isAnnular = String(pattern || 'annular') !== 'grid';
            const openerAnnular = getOpenerEl('annular-pattern-btn');
            const openerGrid = getOpenerEl('grid-pattern-btn');
            if (isAnnular && openerAnnular) openerAnnular.click();
            if (!isAnnular && openerGrid) openerGrid.click();
        }

        function syncAll() {
            syncInputsFromOpener();
        }

        window.renderThroughFocusSpot = async () => {
            const containerEl = document.getElementById('popup-through-focus-spot-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-through-focus-spot-progress-wrapper');
            const progressEl = document.getElementById('popup-through-focus-spot-progress');
            const progressTextEl = document.getElementById('popup-through-focus-spot-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressEl && Number.isFinite(value)) progressEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const openerRay = getOpenerEl('ray-count-input');
            const openerRing = getOpenerEl('ring-count-select');

            const wlModeEl = document.getElementById('popup-through-focus-spot-wavelength-mode-select');
            const minDefocusEl = document.getElementById('popup-through-focus-spot-min-defocus-input');
            const maxDefocusEl = document.getElementById('popup-through-focus-spot-max-defocus-input');
            const stepsEl = document.getElementById('popup-through-focus-spot-steps-input');
            const scaleEl = document.getElementById('popup-through-focus-spot-scale-input');
            const rayEl = document.getElementById('popup-through-focus-spot-ray-count-input');
            const ringEl = document.getElementById('popup-through-focus-spot-ring-count-select');
            const patternEl = document.getElementById('popup-through-focus-spot-pattern-select');

            if (openerRay && rayEl) openerRay.value = rayEl.value;
            if (openerRing && ringEl) openerRing.value = ringEl.value;

            const opener = getHostWindow();
            if (!opener) {
                if (containerEl) containerEl.textContent = 'Main window is not available.';
                return;
            }

            try {
                setProgress(0, 'Starting...');

                const shouldUseDesktopRust = (() => {
                    try {
                        if (typeof window !== 'undefined' && typeof window['shouldUseDesktopRustAnalysis'] === 'function') {
                            return !!window['shouldUseDesktopRustAnalysis']();
                        }
                        if (opener && typeof opener.shouldUseDesktopRustAnalysis === 'function') {
                            return !!opener.shouldUseDesktopRustAnalysis();
                        }
                        return true;
                    } catch (_) {
                        return false;
                    }
                })();
                const canUseDesktopRust = shouldUseDesktopRust && !!(
                    typeof opener.runDesktopAnalysisComputeForPopup === 'function'
                );
                const canUseNativeRustSpot = canUseDesktopRust && !!(
                    typeof opener.runDesktopNativeSpotRaytraceForPopup === 'function'
                );

                const toFiniteNumber = (v, fallback) => {
                    const n = Number(v);
                    return Number.isFinite(n) ? n : fallback;
                };
                const toInt = (v, fallback) => {
                    const n = parseInt(String(v ?? ''), 10);
                    return Number.isInteger(n) ? n : fallback;
                };
                const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
                const selectedSurfaceIndex = undefined;
                const selectedRayCount = rayEl && rayEl.value !== '' ? parseInt(rayEl.value, 10) : undefined;
                const selectedRingCount = ringEl && ringEl.value !== '' ? parseInt(ringEl.value, 10) : undefined;
                const selectedPattern = patternEl ? String(patternEl.value || 'annular') : 'annular';
                const selectedWavelengthMode = wlModeEl ? String(wlModeEl.value || 'all') : 'all';
                const minDefocusMm = toFiniteNumber(minDefocusEl ? minDefocusEl.value : -0.5, -0.5);
                const maxDefocusMm = toFiniteNumber(maxDefocusEl ? maxDefocusEl.value : 0.5, 0.5);
                const steps = clamp(toInt(stepsEl ? stepsEl.value : 5, 5), 3, 61);
                const scaleUm = Math.max(1, toFiniteNumber(scaleEl ? scaleEl.value : 100, 100));
                const halfScaleUm = scaleUm * 0.5;

                // TFSD is intentionally fixed to Rust backend for parity.
                if (!canUseNativeRustSpot) {
                    throw new Error('Through-Focus Spot requires Rust backend (runDesktopNativeSpotRaytraceForPopup unavailable).');
                }

                if (canUseNativeRustSpot) {
                    const toWavelengthLabel = (rawLabel) => {
                        const text = String(rawLabel || '').trim();
                        const nm = text.match(/(\d+(?:\.\d+)?)\s*nm/i);
                        if (nm && nm[1]) return 'Wavelength ' + nm[1] + 'nm';
                        const lower = text.toLowerCase();
                        if (lower.includes('primary')) return 'Wavelength Primary';
                        return 'Wavelength ' + text;
                    };
                    const wavelengthLabelFromSeries = (seriesItem, rawLabel) => {
                        const wl = Number(seriesItem?.wavelengthUm);
                        if (Number.isFinite(wl) && wl > 0) {
                            return 'Wavelength ' + (wl * 1000).toFixed(1) + 'nm';
                        }
                        return toWavelengthLabel(rawLabel);
                    };
                    const parseSeriesLabel = (label, fallbackObjectLabel) => {
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

                    const objectRows = (() => {
                        try {
                            if (opener.tableObject && typeof opener.tableObject.getData === 'function') {
                                const rows = opener.tableObject.getData();
                                if (Array.isArray(rows)) return rows;
                            }
                        } catch (_) {}
                        try {
                            if (typeof opener.getObjectRows === 'function') {
                                const rows = opener.getObjectRows(opener.tableObject);
                                if (Array.isArray(rows)) return rows;
                            }
                        } catch (_) {}
                        try {
                            const raw = opener.localStorage && opener.localStorage.getItem('objectTableData');
                            if (raw) {
                                const parsed = JSON.parse(raw);
                                if (Array.isArray(parsed)) return parsed;
                            }
                        } catch (_) {}
                        return [];
                    })();

                    const getObjectLabel = (row, index) => {
                        const id = row && row.id !== undefined ? String(row.id).trim() : '';
                        if (id) return id;
                        const obj = row && row.object !== undefined ? String(row.object).trim() : '';
                        if (obj) return obj;
                        const pos = row && row.position !== undefined ? String(row.position).trim() : '';
                        if (pos) return 'Object ' + (index + 1) + ' (' + pos + ')';
                        return 'Object ' + (index + 1);
                    };

                    const objectLabels = [];
                    const focusGrid = [];
                    const tfTraceStatsRows = [];
                    const getObjectLabelByIndex = (index) => {
                        if (Array.isArray(objectRows) && objectRows[index]) {
                            return getObjectLabel(objectRows[index], index);
                        }
                        return 'Object ' + (index + 1);
                    };
                    const ensureObjectRow = (preferredIndex, label) => {
                        let idx = Number(preferredIndex);
                        if (!Number.isInteger(idx) || idx < 0) {
                            idx = objectLabels.length;
                        }
                        while (objectLabels.length <= idx) {
                            const next = objectLabels.length;
                            objectLabels.push(getObjectLabelByIndex(next));
                            focusGrid.push([]);
                        }
                        const labelText = String(label || '').trim();
                        if (labelText) {
                            objectLabels[idx] = labelText;
                        }
                        return idx;
                    };
                    const defocusValues = Array.from({ length: steps }, (_, i) => {
                        if (steps <= 1) return minDefocusMm;
                        const t = i / (steps - 1);
                        return minDefocusMm + t * (maxDefocusMm - minDefocusMm);
                    });

                    for (let i = 0; i < defocusValues.length; i++) {
                        const shift = defocusValues[i];
                        const baseProgress = Math.floor((i / Math.max(1, defocusValues.length)) * 85);
                        setProgress(baseProgress, 'Computing defocus ' + shift.toFixed(4) + ' mm (' + (i + 1) + '/' + defocusValues.length + ')...');

                        const result = await opener.runDesktopNativeSpotRaytraceForPopup({
                            surfaceIndex: selectedSurfaceIndex,
                            rayCount: selectedRayCount,
                            ringCount: selectedRingCount,
                            pattern: selectedPattern,
                            wavelengthMode: selectedWavelengthMode,
                            objectRows,
                            defocusMm: shift,
                        });
                        const stats = Array.isArray(result?.seriesStats) ? result.seriesStats : [];
                        for (const stat of stats) {
                            tfTraceStatsRows.push({
                                backend: String(result?.backend || 'native-rust-raytrace'),
                                defocusMm: Number(shift),
                                label: String(stat?.label || ''),
                                attemptedRays: Number(stat?.attemptedRays || 0),
                                hitRays: Number(stat?.hitRays || 0),
                                missRays: Number(stat?.missRays || 0),
                                apertureBlockRays: Number(stat?.apertureBlockRays || 0),
                                noIntersectionRays: Number(stat?.noIntersectionRays || 0),
                                tirRays: Number(stat?.tirRays || 0),
                                unknownFailRays: Number(stat?.unknownFailRays || 0),
                                statusCounts: (stat && typeof stat.statusCounts === 'object' && !Array.isArray(stat.statusCounts)) ? stat.statusCounts : {},
                                hitRatePercent: Number(stat?.hitRatePercent || 0),
                            });
                        }
                        const airyRadiusUm = Number(result?.airyRadiusUm);
                        const safeAiryRadiusUm = (Number.isFinite(airyRadiusUm) && airyRadiusUm > 0) ? airyRadiusUm : NaN;

                        const series = Array.isArray(result?.series) ? result.series : [];
                        const groupedByObject = new Map();
                        const wlCountRaw = Number(result?.wavelengthCount);
                        const inferredWavelengthCount = (() => {
                            if (Number.isInteger(wlCountRaw) && wlCountRaw > 0) return wlCountRaw;
                            const unique = new Set();
                            for (const s of series) {
                                const key = wavelengthLabelFromSeries(s, String(s?.label || ''));
                                unique.add(key);
                            }
                            return Math.max(1, unique.size);
                        })();

                        for (let sIdx = 0; sIdx < series.length; sIdx++) {
                            const s = series[sIdx] || {};
                            const objectIndexByOrder = Math.floor(sIdx / inferredWavelengthCount);
                            const fallbackObj = getObjectLabelByIndex(objectIndexByOrder);
                            const parsed = parseSeriesLabel(s.label, fallbackObj);
                            const rowIndex = ensureObjectRow(objectIndexByOrder, fallbackObj || parsed.objectLabel);
                            const pts = Array.isArray(s.points) ? s.points : [];
                            const hasFieldAngle = !!s.hasFieldAngle;
                            const chiefXUm = Number(s?.chiefPointUm?.xUm);
                            const chiefYUm = Number(s?.chiefPointUm?.yUm);
                            const useChiefCentering = hasFieldAngle && Number.isFinite(chiefXUm) && Number.isFinite(chiefYUm);
                            const centered = useChiefCentering
                                ? pts.map((p) => ({
                                    xUm: (Number(p?.xUm) || 0) - chiefXUm,
                                    yUm: (Number(p?.yUm) || 0) - chiefYUm,
                                }))
                                : pts.map((p) => ({
                                    xUm: Number(p?.xUm) || 0,
                                    yUm: Number(p?.yUm) || 0,
                                }));

                            if (!groupedByObject.has(rowIndex)) {
                                groupedByObject.set(rowIndex, []);
                            }
                            const wlLabel = wavelengthLabelFromSeries(s, parsed.wavelengthLabel);
                            groupedByObject.get(rowIndex).push({
                                key: wlLabel,
                                label: wlLabel,
                                color: String(s?.color || '#2563eb'),
                                points: centered,
                            });
                        }

                        for (let rowIndex = 0; rowIndex < focusGrid.length; rowIndex++) {
                            const groups = Array.isArray(groupedByObject.get(rowIndex)) ? groupedByObject.get(rowIndex) : [];
                            const merged = [];
                            for (const g of groups) {
                                const pts = Array.isArray(g?.points) ? g.points : [];
                                for (const p of pts) {
                                    merged.push({ xUm: Number(p?.xUm) || 0, yUm: Number(p?.yUm) || 0 });
                                }
                            }

                            let cx = 0;
                            let cy = 0;
                            if (merged.length > 0) {
                                cx = merged.reduce((sum, p) => sum + p.xUm, 0) / merged.length;
                                cy = merged.reduce((sum, p) => sum + p.yUm, 0) / merged.length;
                            }

                            focusGrid[rowIndex].push({
                                shiftMm: shift,
                                airyRadiusUm: safeAiryRadiusUm,
                                pointsByWavelength: groups.map((g) => ({
                                    key: g.key,
                                    label: g.label,
                                    color: g.color,
                                    points: (Array.isArray(g.points) ? g.points : []).map((p) => ({
                                        xUm: (Number(p?.xUm) || 0) - cx,
                                        yUm: (Number(p?.yUm) || 0) - cy,
                                    })),
                                })),
                            });
                        }
                    }

                    try {
                        window.__cooptTfSpotLastTraceStats = tfTraceStatsRows;
                    } catch (_) {}
                    try {
                        if (opener && typeof opener === 'object') {
                            opener.__cooptTfSpotLastTraceStats = tfTraceStatsRows;
                        }
                    } catch (_) {}
                    try {
                        globalThis.__cooptTfSpotLastTraceStats = tfTraceStatsRows;
                    } catch (_) {}
                    try {
                        if (console.table) {
                            console.table(tfTraceStatsRows);
                        } else {
                            console.log('[TFSD_TRACE_STATS]', tfTraceStatsRows);
                        }
                    } catch (_) {}

                    if (!window.Plotly || typeof window.Plotly.newPlot !== 'function') {
                        throw new Error('Plotly is not available in Through-Focus Spot popup');
                    }

                    const rows = Math.max(1, focusGrid.length);
                    const cols = Math.max(1, defocusValues.length);
                    const traces = [];
                    const layout = {
                        showlegend: true,
                        grid: { rows, columns: cols, pattern: 'independent' },
                        margin: { l: 60, r: 20, t: 56, b: 60 },
                        paper_bgcolor: '#ffffff',
                        plot_bgcolor: '#ffffff',
                        height: Math.max(420, rows * 145 + 90),
                        legend: {
                            orientation: 'h',
                            yanchor: 'bottom',
                            y: 1.06,
                            xanchor: 'center',
                            x: 0.5,
                        },
                        legendgroupclick: 'togglegroup',
                        shapes: [],
                    };

                    const legendEntries = new Map();
                    for (let r = 0; r < rows; r++) {
                        for (let c = 0; c < cols; c++) {
                            const idx = r * cols + c + 1;
                            const axisRefX = idx === 1 ? 'x' : 'x' + idx;
                            const axisRefY = idx === 1 ? 'y' : 'y' + idx;
                            const axisKeyX = idx === 1 ? 'xaxis' : 'xaxis' + idx;
                            const axisKeyY = idx === 1 ? 'yaxis' : 'yaxis' + idx;
                            const cell = (focusGrid[r] && focusGrid[r][c]) ? focusGrid[r][c] : { pointsByWavelength: [] };
                            const airyRadiusUm = Number(cell?.airyRadiusUm);
                            const groups = Array.isArray(cell?.pointsByWavelength) ? cell.pointsByWavelength : [];

                            for (const group of groups) {
                                const pts = Array.isArray(group?.points) ? group.points : [];
                                const groupKey = String(group?.key || group?.label || 'wavelength');
                                if (!legendEntries.has(groupKey)) {
                                    legendEntries.set(groupKey, {
                                        label: String(group?.label || groupKey),
                                        color: String(group?.color || '#2563eb'),
                                    });
                                }
                                traces.push({
                                    x: pts.map((p) => Number(p?.xUm) || 0),
                                    y: pts.map((p) => Number(p?.yUm) || 0),
                                    mode: 'markers',
                                    type: 'scattergl',
                                    name: String(group?.label || groupKey),
                                    legendgroup: groupKey,
                                    showlegend: false,
                                    marker: {
                                        size: 4,
                                        color: String(group?.color || '#2563eb'),
                                        opacity: 0.75,
                                    },
                                    xaxis: axisRefX,
                                    yaxis: axisRefY,
                                    hovertemplate: 'x=%{x:.2f} µm<br>y=%{y:.2f} µm<extra></extra>',
                                });
                            }

                            layout[axisKeyX] = {
                                range: [-halfScaleUm, halfScaleUm],
                                showgrid: true,
                                zeroline: true,
                                showticklabels: r === rows - 1,
                                title: r === rows - 1 ? defocusValues[c].toFixed(3) + ' mm' : '',
                            };
                            layout[axisKeyY] = {
                                range: [-halfScaleUm, halfScaleUm],
                                showgrid: true,
                                zeroline: true,
                                showticklabels: c === 0,
                                title: c === 0 ? (objectLabels[r] || ('Object ' + (r + 1))) : '',
                                scaleanchor: axisRefX,
                                scaleratio: 1,
                            };

                            if (Number.isFinite(airyRadiusUm) && airyRadiusUm > 0) {
                                layout.shapes.push({
                                    type: 'circle',
                                    xref: axisRefX,
                                    yref: axisRefY,
                                    x0: -airyRadiusUm,
                                    y0: -airyRadiusUm,
                                    x1: airyRadiusUm,
                                    y1: airyRadiusUm,
                                    line: { color: '#111827', width: 1 },
                                    fillcolor: 'rgba(0,0,0,0)',
                                });
                            }
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
                                symbol: 'circle',
                            },
                            hoverinfo: 'skip',
                        });
                    }

                    setProgress(92, 'Rendering Through-Focus Spot...');
                    await window.Plotly.newPlot(containerEl, traces, layout, { responsive: true, displaylogo: false });
                    try {
                        if (progressWrapper) progressWrapper.style.display = 'none';
                    } catch (_) {}
                    return;
                }

                throw new Error('Through-Focus Spot web fallback is disabled (Rust backend fixed).');
            } catch (e) {
                if (containerEl) containerEl.textContent = String(e && e.message ? e.message : e);
                setProgress(100, 'Failed');
            }
        };

        document.getElementById('popup-through-focus-spot-pattern-select').addEventListener('change', (e) => {
            const target = e && e.target ? e.target : null;
            const v = target && target.value ? String(target.value) : 'annular';
            setPopupPattern(v);
        });
        document.getElementById('popup-show-through-focus-spot-btn').addEventListener('click', () => window.renderThroughFocusSpot());
        window.addEventListener('focus', syncAll);
        window.addEventListener('load', () => syncAll());
        syncAll();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Through-Focus MTF popup window button
        const openThroughFocusMtfWindowBtn = document.getElementById('open-through-focus-mtf-window-btn');
        if (openThroughFocusMtfWindowBtn) {
                openThroughFocusMtfWindowBtn.addEventListener('click', () => {
                        if (w.__throughFocusMtfPopup && !w.__throughFocusMtfPopup.closed) {
                                try { w.__throughFocusMtfPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Through-Focus MTF', 'width=900,height=680');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__throughFocusMtfPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Analysis</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 110px;
        }
        .controls input[type="checkbox"] {
            width: auto;
            padding: 0;
            border: none;
            background: transparent;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .note { padding: 8px 12px; font-size: 12px; color: #666; border-bottom: 1px solid #eee; background: #fff; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-through-focus-mtf-container { flex: 1 1 auto; min-height: 0; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-through-focus-mtf-wavelength-select">Wavelength:</label>
        <select id="popup-through-focus-mtf-wavelength-select"></select>
        <label for="popup-through-focus-mtf-object-select">Object:</label>
        <select id="popup-through-focus-mtf-object-select"></select>
        <label for="popup-through-focus-mtf-target-freq-input">Freq (lp/mm):</label>
        <input id="popup-through-focus-mtf-target-freq-input" type="number" min="0" step="1" value="10" />
        <label for="popup-through-focus-mtf-min-defocus-input">Defocus min (mm):</label>
        <input id="popup-through-focus-mtf-min-defocus-input" type="number" step="0.001" value="-0.5" />
        <label for="popup-through-focus-mtf-max-defocus-input">Defocus max (mm):</label>
        <input id="popup-through-focus-mtf-max-defocus-input" type="number" step="0.001" value="0.5" />
        <label for="popup-through-focus-mtf-steps-input">Steps:</label>
        <input id="popup-through-focus-mtf-steps-input" type="number" min="3" max="201" step="1" value="21" />
        <label for="popup-through-focus-mtf-sampling-select">Sampling:</label>
        <select id="popup-through-focus-mtf-sampling-select">
            <option value="32">32x32</option>
            <option value="64">64x64</option>
            <option value="128">128x128</option>
            <option value="256" selected>256x256</option>
            <option value="512">512x512</option>
            <option value="1024">1024x1024</option>
            <option value="2048">2048x2048</option>
            <option value="4096">4096x4096</option>
        </select>
        <label for="popup-through-focus-mtf-zeropad-select" title="Zero-padding increases FFT size without increasing OPD ray grid.">Zero pad:</label>
        <select id="popup-through-focus-mtf-zeropad-select">
            <option value="none">None</option>
            <option value="auto" selected>Auto</option>
            <option value="512">512</option>
            <option value="1024">1024</option>
            <option value="2048">2048</option>
            <option value="4096">4096</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-through-focus-mtf-remove-ptd-checkbox" type="checkbox" />
            Remove P/T/D
        </label>
        <button id="popup-show-through-focus-mtf-btn" type="button">Show Plot</button>
    </div>
    <div id="popup-through-focus-mtf-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-through-focus-mtf-progress-text" style="margin-bottom: 6px;">Calculating...</div>
        <progress id="popup-through-focus-mtf-progress" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-through-focus-mtf-container"></div>
    </div>

    <script>
        function safeCall(fn, fallback) {
            try { return fn(); } catch (_) { return fallback; }
        }

        function getOpener() {
            try { return window.opener || window; } catch (_) { return window; }
        }

        function popupLog(...args) {
            try { console.log(...args); } catch (_) {}
            try {
                const op = window.opener;
                if (op && op.console && typeof op.console.log === 'function') {
                    op.console.log(...args);
                }
            } catch (_) {}
        }

        function popupError(...args) {
            try { console.error(...args); } catch (_) {}
            try {
                const op = window.opener;
                if (op && op.console && typeof op.console.error === 'function') {
                    op.console.error(...args);
                }
            } catch (_) {}
        }

        function getPrimaryWavelength() {
            const opener = getOpener();
            if (!opener) return null;
            if (typeof opener.getPrimaryWavelength !== 'function') return null;
            const v = Number(safeCall(() => opener.getPrimaryWavelength(), 0));
            return Number.isFinite(v) && v > 0 ? v : null;
        }

        function buildWavelengthOptions() {
            const opener = getOpener();
            if (!opener) return [];
            const getSourceRows = opener.getSourceRows;
            const sources = (typeof getSourceRows === 'function')
                ? safeCall(() => getSourceRows(opener.tableSource), [])
                : [];
            const primary = getPrimaryWavelength();
            const out = [{ value: 'all', label: 'All' }];
            if (Array.isArray(sources) && sources.length > 0) {
                for (let i = 0; i < sources.length; i++) {
                    const wl = Number(sources[i]?.wavelength);
                    if (!Number.isFinite(wl) || wl <= 0) continue;
                    const nm = wl * 1000;
                    const label = Number.isFinite(primary) && Math.abs(wl - primary) < 1e-9
                        ? (nm.toFixed(1) + ' nm (primary)')
                        : (nm.toFixed(1) + ' nm');
                    out.push({ value: String(wl), label });
                }
            }
            if (out.length === 1) {
                if (Number.isFinite(primary) && primary > 0) {
                    out.push({ value: String(primary), label: ((primary * 1000).toFixed(1) + ' nm') });
                }
            }
            return out;
        }

        function buildObjectOptions() {
            const opener = getOpener();
            if (!opener) return [];
            const getObjectRows = opener.getObjectRows;
            const objects = (typeof getObjectRows === 'function')
                ? safeCall(() => getObjectRows(opener.tableObject), [])
                : [];
            const out = [];
            if (Array.isArray(objects) && objects.length > 0) {
                for (let i = 0; i < objects.length; i++) {
                    const obj = objects[i];
                    if (!obj) continue;
                    const typeRaw = String(obj.position ?? obj.object ?? obj.Object ?? obj.objectType ?? 'Point');
                    const x = (obj.x ?? obj.xHeightAngle ?? 0);
                    const y = (obj.y ?? obj.yHeightAngle ?? 0);
                    out.push({ value: String(i), label: (String(i + 1) + ': ' + typeRaw + ' (' + x + ', ' + y + ')') });
                }
            }
            if (out.length === 0) out.push({ value: '0', label: '0' });
            return out;
        }

        function populateSelect(selectEl, options) {
            if (!selectEl) return;
            const current = selectEl.value;
            selectEl.innerHTML = '';
            for (const opt of options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                selectEl.appendChild(o);
            }
            if (current && Array.from(selectEl.options).some(o => o.value === current)) {
                selectEl.value = current;
            }
        }

        function syncAllOptions() {
            const wlSel = document.getElementById('popup-through-focus-mtf-wavelength-select');
            const prevWl = wlSel ? wlSel.value : '';
            populateSelect(wlSel, buildWavelengthOptions());
            if (wlSel && (!prevWl || !Array.from(wlSel.options).some(o => o.value === prevWl))) {
                const primary = getPrimaryWavelength();
                if (Number.isFinite(primary) && Array.from(wlSel.options).some(o => o.value === String(primary))) {
                    wlSel.value = String(primary);
                } else {
                    const firstNumeric = Array.from(wlSel.options).find(o => o.value !== 'all');
                    if (firstNumeric) wlSel.value = firstNumeric.value;
                }
            }
            populateSelect(document.getElementById('popup-through-focus-mtf-object-select'), buildObjectOptions());
        }

        window['renderThroughFocusMTF'] = async () => {
            const containerEl = document.getElementById('popup-through-focus-mtf-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-through-focus-mtf-progress-wrapper');
            const progressEl = document.getElementById('popup-through-focus-mtf-progress');
            const progressTextEl = document.getElementById('popup-through-focus-mtf-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressEl && Number.isFinite(value)) progressEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            const wlSel = document.getElementById('popup-through-focus-mtf-wavelength-select');
            const objSel = document.getElementById('popup-through-focus-mtf-object-select');
            const targetFreqEl = document.getElementById('popup-through-focus-mtf-target-freq-input');
            const minDefocusEl = document.getElementById('popup-through-focus-mtf-min-defocus-input');
            const maxDefocusEl = document.getElementById('popup-through-focus-mtf-max-defocus-input');
            const stepsEl = document.getElementById('popup-through-focus-mtf-steps-input');
            const samplingEl = document.getElementById('popup-through-focus-mtf-sampling-select');
            const zeroPadEl = document.getElementById('popup-through-focus-mtf-zeropad-select');
            const removePtdEl = document.getElementById('popup-through-focus-mtf-remove-ptd-checkbox');

            const wlValue = wlSel ? String(wlSel.value) : '';
            const primary = getPrimaryWavelength();
            const wavelength = (wlValue === 'all') ? 'all' : Number(wlValue);
            const objectIndex = objSel ? parseInt(objSel.value, 10) : 0;
            const targetFrequencyLpmm = targetFreqEl ? Number(targetFreqEl.value) : 10;
            const defocusMinMm = minDefocusEl ? Number(minDefocusEl.value) : -0.5;
            const defocusMaxMm = maxDefocusEl ? Number(maxDefocusEl.value) : 0.5;
            const steps = stepsEl ? Number(stepsEl.value) : 21;
            const sampling = samplingEl ? Number(samplingEl.value) : 256;
            const zeroPadRaw = zeroPadEl ? String(zeroPadEl.value || 'auto') : 'auto';
            const opdDisplayMode = (removePtdEl && removePtdEl.checked)
                ? 'pistonTiltDefocusRemoved'
                : 'pistonTiltRemoved';
            const zeroPadTo = (zeroPadRaw === 'none')
                ? (Number.isFinite(sampling) ? sampling : 256)
                : (zeroPadRaw === 'auto')
                    ? 0
                    : (Number.isFinite(parseInt(zeroPadRaw, 10)) ? parseInt(zeroPadRaw, 10) : 0);

            try {
                const opener = getOpener();
                if (!opener) {
                    throw new Error('Opener is not available');
                }
                setProgress(0, 'Starting...');
                await new Promise(r => setTimeout(r, 0));
                if (wavelength !== 'all' && !Number.isFinite(wavelength) && !(Number.isFinite(primary) && primary > 0)) {
                    throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
                }

                if (typeof opener.runDesktopNativeThroughFocusMtfForPopup !== 'function') {
                    throw new Error('runDesktopNativeThroughFocusMtfForPopup is not available on opener');
                }

                const sourceRows = (typeof opener.getSourceRows === 'function')
                    ? (safeCall(() => opener.getSourceRows(opener.tableSource), []) || [])
                    : [];
                const wavelengthList = (() => {
                    const out = [];
                    if (wavelength === 'all') {
                        if (Array.isArray(sourceRows) && sourceRows.length > 0) {
                            for (let i = 0; i < sourceRows.length; i++) {
                                const wl = Number(sourceRows[i]?.wavelength);
                                if (!Number.isFinite(wl) || wl <= 0) continue;
                                if (out.some(v => Math.abs(v - wl) < 1e-9)) continue;
                                out.push(wl);
                            }
                        }
                        if (out.length === 0 && Number.isFinite(primary) && primary > 0) {
                            out.push(primary);
                        }
                    } else {
                        const wl = (Number.isFinite(Number(wavelength)) && Number(wavelength) > 0)
                            ? Number(wavelength)
                            : ((Number.isFinite(primary) && primary > 0) ? primary : 0.5876);
                        out.push(wl);
                    }
                    if (out.length === 0) out.push(0.5876);
                    return out;
                })();

                let lastProgress = 20;
                setProgress(lastProgress, 'Computing Through-Focus MTF (Rust/WASM)...');
                const nativeResp = await opener.runDesktopNativeThroughFocusMtfForPopup({
                    objectIndex: Number.isFinite(objectIndex) ? objectIndex : 0,
                    wavelengths: wavelengthList,
                    targetFrequencyLpmm: Number.isFinite(targetFrequencyLpmm) ? targetFrequencyLpmm : 10,
                    defocusMinMm: Number.isFinite(defocusMinMm) ? defocusMinMm : -0.5,
                    defocusMaxMm: Number.isFinite(defocusMaxMm) ? defocusMaxMm : 0.5,
                    steps: Number.isFinite(steps) ? steps : 21,
                    samplingSize: Number.isFinite(sampling) ? sampling : 256,
                    zeroPadTo,
                    opdDisplayMode,
                    onProgress: (evt) => {
                        try {
                            const p = Number(evt?.percent);
                            const msg = String(evt?.message || 'Computing Through-Focus MTF...');
                            if (Number.isFinite(p)) {
                                lastProgress = Math.max(lastProgress, Math.max(0, Math.min(100, p)));
                                setProgress(lastProgress, msg);
                            } else {
                                setProgress(lastProgress, msg);
                            }
                        } catch (_) {}
                    },
                });

                if (!window.Plotly || typeof window.Plotly.newPlot !== 'function') {
                    throw new Error('Plotly is not available in Through-Focus MTF popup');
                }
                const xAxis = Array.isArray(nativeResp?.xAxis) ? nativeResp.xAxis : [];
                const series = Array.isArray(nativeResp?.series) ? nativeResp.series : [];
                if (!xAxis.length || !series.length) {
                    throw new Error('Native Through-Focus MTF did not produce valid data');
                }

                const getColorForWavelengthPopup = (wl) => {
                    try {
                        if (typeof opener.getColorForWavelength === 'function') {
                            const c = opener.getColorForWavelength(wl);
                            if (typeof c === 'string' && c) return c;
                        }
                    } catch (_) {}
                    const nm = Number(wl) * 1000;
                    if (!Number.isFinite(nm)) return '#2563eb';
                    if (nm < 470) return '#2563eb';
                    if (nm < 530) return '#16a34a';
                    if (nm < 600) return '#f59e0b';
                    return '#dc2626';
                };

                const traces = [];
                for (let i = 0; i < series.length; i++) {
                    const s = series[i] || {};
                    const wl = Number(s.wavelengthUm);
                    const nm = Number.isFinite(wl) ? (wl * 1000).toFixed(1) : 'N/A';
                    const color = getColorForWavelengthPopup(wl);
                    const tan = Array.isArray(s.mtfTangential) ? s.mtfTangential : [];
                    const sag = Array.isArray(s.mtfSagittal) ? s.mtfSagittal : [];
                    traces.push({
                        x: xAxis,
                        y: tan,
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Meridional (' + nm + 'nm)',
                        line: { color, width: 2, dash: 'solid' },
                    });
                    traces.push({
                        x: xAxis,
                        y: sag,
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Sagittal (' + nm + 'nm)',
                        line: { color, width: 2, dash: 'dot' },
                    });
                }

                setProgress(85, 'Rendering Through-Focus MTF...');
                await window.Plotly.newPlot(containerEl, traces, {
                    title: String(Number.isFinite(targetFrequencyLpmm) ? targetFrequencyLpmm.toFixed(1) : 10) + ' lp/mm',
                    xaxis: { title: 'Defocus shift (mm)' },
                    yaxis: { title: 'MTF', range: [0, 1.05] },
                    margin: { l: 60, r: 20, t: 50, b: 50 },
                    showlegend: true,
                }, { responsive: true, displaylogo: false });

                hideProgress();
                return;
            } catch (err) {
                console.error(err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    const details = String((err && err.message) ? err.message : err || 'Unknown error');
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate Through-Focus MTF.<br/><span style="font-size:12px;color:#555;">' + details.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>';
                }
            }
        };

        document.getElementById('popup-show-through-focus-mtf-btn').addEventListener('click', () => window.renderThroughFocusMTF());
        window.addEventListener('focus', syncAllOptions);
        window.addEventListener('load', () => syncAllOptions());
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Field MTF popup window button
        const openFieldMtfWindowBtn = document.getElementById('open-field-mtf-window-btn');
        if (openFieldMtfWindowBtn) {
                openFieldMtfWindowBtn.addEventListener('click', () => {
                        if (w.__fieldMtfPopup && !w.__fieldMtfPopup.closed) {
                                try { w.__fieldMtfPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Object MTF', 'width=900,height=650');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__fieldMtfPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Object MTF</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls select {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
        }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 110px;
        }
        .controls input[type="checkbox"] {
            width: auto;
            padding: 0;
            border: none;
            background: transparent;
        }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .note { padding: 8px 12px; font-size: 12px; color: #666; border-bottom: 1px solid #eee; background: #fff; }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
            display: flex;
            flex-direction: column;
        }
        #popup-field-mtf-container { flex: 1 1 auto; min-height: 0; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-field-mtf-wavelength-select">Wavelength:</label>
        <select id="popup-field-mtf-wavelength-select"></select>
        <label for="popup-field-mtf-meridional-freq-input">1st Freq (lp/mm):</label>
        <input id="popup-field-mtf-meridional-freq-input" type="number" min="0" step="1" value="10" />
        <label for="popup-field-mtf-sagittal-freq-input">2nd Freq (lp/mm):</label>
        <input id="popup-field-mtf-sagittal-freq-input" type="number" min="0" step="1" value="30" />
        <label for="popup-field-mtf-min-field-input">Object min:</label>
        <input id="popup-field-mtf-min-field-input" type="number" step="0.001" value="0" />
        <label for="popup-field-mtf-max-field-input">Object max:</label>
        <input id="popup-field-mtf-max-field-input" type="number" step="0.001" value="10" />
        <label for="popup-field-mtf-steps-input">Steps:</label>
        <input id="popup-field-mtf-steps-input" type="number" min="3" max="201" step="1" value="21" />
        <label for="popup-field-mtf-sampling-select">Sampling:</label>
        <select id="popup-field-mtf-sampling-select">
            <option value="32">32x32</option>
            <option value="64">64x64</option>
            <option value="128">128x128</option>
            <option value="256" selected>256x256</option>
            <option value="512">512x512</option>
            <option value="1024">1024x1024</option>
            <option value="2048">2048x2048</option>
            <option value="4096">4096x4096</option>
        </select>
        <label for="popup-field-mtf-zeropad-select" title="Zero-padding increases FFT size without increasing OPD ray grid.">Zero pad:</label>
        <select id="popup-field-mtf-zeropad-select">
            <option value="none">None</option>
            <option value="auto" selected>Auto</option>
            <option value="512">512</option>
            <option value="1024">1024</option>
            <option value="2048">2048</option>
            <option value="4096">4096</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;">
            <input id="popup-field-mtf-remove-ptd-checkbox" type="checkbox" />
            Remove P/T/D
        </label>
        <button id="popup-show-field-mtf-btn" type="button">Show Plot</button>
    </div>
    <div id="popup-field-mtf-progress-wrapper" style="display:none; padding: 8px 12px; font-size: 12px; color: #333; border-bottom: 1px solid #eee; background: #fff;">
        <div id="popup-field-mtf-progress-text" style="margin-bottom: 6px;">Calculating...</div>
        <progress id="popup-field-mtf-progress" style="display:block;width:calc(100% + 24px);margin-left:-12px;" max="100"></progress>
    </div>
    <div class="content">
        <div id="popup-field-mtf-container"></div>
    </div>

    <script>
        function safeCall(fn, fallback) {
            try { return fn(); } catch (_) { return fallback; }
        }

        function getOpener() {
            try { return window.opener || window; } catch (_) { return window; }
        }

        function popupLog(...args) {
            try { console.log(...args); } catch (_) {}
            try {
                const op = window.opener;
                if (op && op.console && typeof op.console.log === 'function') {
                    op.console.log(...args);
                }
            } catch (_) {}
        }

        function popupError(...args) {
            try { console.error(...args); } catch (_) {}
            try {
                const op = window.opener;
                if (op && op.console && typeof op.console.error === 'function') {
                    op.console.error(...args);
                }
            } catch (_) {}
        }

        function getPrimaryWavelength() {
            const opener = getOpener();
            if (!opener) return null;
            if (typeof opener.getPrimaryWavelength !== 'function') return null;
            const v = Number(safeCall(() => opener.getPrimaryWavelength(), 0));
            return Number.isFinite(v) && v > 0 ? v : null;
        }

        function buildWavelengthOptions() {
            const opener = getOpener();
            if (!opener) return [];
            const getSourceRows = opener.getSourceRows;
            const sources = (typeof getSourceRows === 'function')
                ? safeCall(() => getSourceRows(opener.tableSource), [])
                : [];
            const primary = getPrimaryWavelength();
            const out = [{ value: 'all', label: 'All' }];
            if (Array.isArray(sources) && sources.length > 0) {
                for (let i = 0; i < sources.length; i++) {
                    const wl = Number(sources[i]?.wavelength);
                    if (!Number.isFinite(wl) || wl <= 0) continue;
                    const nm = wl * 1000;
                    const label = Number.isFinite(primary) && Math.abs(wl - primary) < 1e-9
                        ? (nm.toFixed(1) + ' nm (primary)')
                        : (nm.toFixed(1) + ' nm');
                    out.push({ value: String(wl), label });
                }
            }
            if (out.length === 1) {
                if (Number.isFinite(primary) && primary > 0) {
                    out.push({ value: String(primary), label: ((primary * 1000).toFixed(1) + ' nm') });
                }
            }
            return out;
        }

        function getAxisInfo() {
            const opener = getOpener();
            if (!opener) return { mode: 'angle', label: 'Object Angle (deg)', unit: 'deg', max: 10 };

            // Priority 1: check optical system first surface thickness.
            // If INF (infinite conjugate), object coordinates MUST be angles.
            let detectedMode = null;
            try {
                const getOpticalSystemRows = opener.getOpticalSystemRows;
                if (typeof getOpticalSystemRows === 'function') {
                    const optRows = safeCall(() => getOpticalSystemRows(opener.tableOpticalSystem), []);
                    const firstSurf = Array.isArray(optRows) && optRows.length > 0 ? optRows[0] : null;
                    if (firstSurf) {
                        const thickness = firstSurf.thickness ?? firstSurf.Thickness;
                        const isInf = thickness === 'INF' || thickness === Infinity || String(thickness).trim().toUpperCase() === 'INF';
                        if (isInf) {
                            detectedMode = 'angle';
                        } else {
                            const numThick = parseFloat(String(thickness));
                            if (Number.isFinite(numThick) && numThick > 0) {
                                detectedMode = 'finite'; // finite conjugate, defer to position field
                            }
                        }
                    }
                }
            } catch (_) {}

            // Priority 2: object rows position field (used when finite conjugate or inconclusive)
            const getObjectRows = opener.getObjectRows;
            const objects = (typeof getObjectRows === 'function')
                ? safeCall(() => getObjectRows(opener.tableObject), [])
                : [];
            const first = Array.isArray(objects) && objects.length > 0 ? objects[0] : null;

            let isAngle;
            if (detectedMode === 'angle') {
                isAngle = true;
            } else {
                const posRaw = String(first?.position ?? first?.object ?? first?.objectType ?? 'Angle');
                isAngle = /\bangle\b/i.test(posRaw);
            }

            const unit = isAngle ? 'deg' : 'mm';
            const label = isAngle ? 'Object Angle (deg)' : 'Object Height (mm)';
            let maxVal = 10;
            if (Array.isArray(objects) && objects.length > 0) {
                const vals = objects.map(o => Number(o?.yHeightAngle)).filter(v => Number.isFinite(v));
                if (vals.length > 0) {
                    maxVal = Math.max(1e-6, Math.max.apply(null, vals.map(v => Math.abs(v))));
                }
            }
            return { mode: isAngle ? 'angle' : 'height', label, unit, max: maxVal };
        }

        function populateSelect(selectEl, options) {
            if (!selectEl) return;
            const current = selectEl.value;
            selectEl.innerHTML = '';
            for (const opt of options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                selectEl.appendChild(o);
            }
            if (current && Array.from(selectEl.options).some(o => o.value === current)) {
                selectEl.value = current;
            }
        }

        function syncAllOptions() {
            const wlSel = document.getElementById('popup-field-mtf-wavelength-select');
            const prevWl = wlSel ? wlSel.value : '';
            populateSelect(wlSel, buildWavelengthOptions());
            if (wlSel && (!prevWl || !Array.from(wlSel.options).some(o => o.value === prevWl))) {
                const primary = getPrimaryWavelength();
                if (Number.isFinite(primary) && Array.from(wlSel.options).some(o => o.value === String(primary))) {
                    wlSel.value = String(primary);
                } else {
                    const firstNumeric = Array.from(wlSel.options).find(o => o.value !== 'all');
                    if (firstNumeric) wlSel.value = firstNumeric.value;
                }
            }

            const axisInfo = getAxisInfo();
            const maxEl = document.getElementById('popup-field-mtf-max-field-input');
            if (maxEl && !maxEl.dataset.cooptInit) {
                maxEl.dataset.cooptInit = '1';
                maxEl.value = String(axisInfo.max || 10);
            }
        }

        window['renderFieldMTF'] = async () => {
            const containerEl = document.getElementById('popup-field-mtf-container');
            if (containerEl) containerEl.innerHTML = '';

            const progressWrapper = document.getElementById('popup-field-mtf-progress-wrapper');
            const progressEl = document.getElementById('popup-field-mtf-progress');
            const progressTextEl = document.getElementById('popup-field-mtf-progress-text');

            const setProgress = (value, text) => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'block';
                    if (progressEl && Number.isFinite(value)) progressEl.value = Math.max(0, Math.min(100, value));
                    if (progressTextEl && typeof text === 'string') progressTextEl.textContent = text;
                } catch (_) {}
            };

            const hideProgress = () => {
                try {
                    if (progressWrapper) progressWrapper.style.display = 'none';
                } catch (_) {}
            };

            const wlSel = document.getElementById('popup-field-mtf-wavelength-select');
            const minFieldEl = document.getElementById('popup-field-mtf-min-field-input');
            const maxFieldEl = document.getElementById('popup-field-mtf-max-field-input');
            const stepsEl = document.getElementById('popup-field-mtf-steps-input');
            const meridionalEl = document.getElementById('popup-field-mtf-meridional-freq-input');
            const sagittalEl = document.getElementById('popup-field-mtf-sagittal-freq-input');
            const samplingEl = document.getElementById('popup-field-mtf-sampling-select');
            const zeroPadEl = document.getElementById('popup-field-mtf-zeropad-select');
            const removePtdEl = document.getElementById('popup-field-mtf-remove-ptd-checkbox');

            const wlValue = wlSel ? String(wlSel.value) : '';
            const primary = getPrimaryWavelength();
            const wavelength = (wlValue === 'all') ? 'all' : Number(wlValue);
            const fieldMin = minFieldEl ? Number(minFieldEl.value) : 0;
            const fieldMax = maxFieldEl ? Number(maxFieldEl.value) : 10;
            const steps = stepsEl ? Number(stepsEl.value) : 21;
            const meridionalFreq = meridionalEl ? Number(meridionalEl.value) : 10;
            const sagittalFreq = sagittalEl ? Number(sagittalEl.value) : 30;
            const sampling = samplingEl ? Number(samplingEl.value) : 256;
            const zeroPadRaw = zeroPadEl ? String(zeroPadEl.value || 'auto') : 'auto';
            const opdDisplayMode = (removePtdEl && removePtdEl.checked)
                ? 'pistonTiltDefocusRemoved'
                : 'pistonTiltRemoved';
            const zeroPadTo = (zeroPadRaw === 'none')
                ? (Number.isFinite(sampling) ? sampling : 256)
                : (zeroPadRaw === 'auto')
                    ? 0
                    : (Number.isFinite(parseInt(zeroPadRaw, 10)) ? parseInt(zeroPadRaw, 10) : 0);

            const axisInfo = getAxisInfo();

            try {
                const opener = getOpener();
                if (!opener) {
                    throw new Error('Opener is not available');
                }
                setProgress(0, 'Starting...');
                await new Promise(r => setTimeout(r, 0));
                if (wavelength !== 'all' && !Number.isFinite(wavelength) && !(Number.isFinite(primary) && primary > 0)) {
                    throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
                }

                if (typeof opener.runPortableFieldMtfForPopup !== 'function') {
                    throw new Error('runPortableFieldMtfForPopup is not available on opener');
                }

                const sourceRows = (typeof opener.getSourceRows === 'function')
                    ? (safeCall(() => opener.getSourceRows(opener.tableSource), []) || [])
                    : [];
                const wavelengthList = (() => {
                    const out = [];
                    if (wavelength === 'all') {
                        if (Array.isArray(sourceRows) && sourceRows.length > 0) {
                            for (let i = 0; i < sourceRows.length; i++) {
                                const wl = Number(sourceRows[i]?.wavelength);
                                if (!Number.isFinite(wl) || wl <= 0) continue;
                                if (out.some(v => Math.abs(v - wl) < 1e-9)) continue;
                                out.push(wl);
                            }
                        }
                        if (out.length === 0 && Number.isFinite(primary) && primary > 0) {
                            out.push(primary);
                        }
                    } else {
                        const wl = (Number.isFinite(Number(wavelength)) && Number(wavelength) > 0)
                            ? Number(wavelength)
                            : ((Number.isFinite(primary) && primary > 0) ? primary : 0.5876);
                        out.push(wl);
                    }
                    if (out.length === 0) out.push(0.5876);
                    return out;
                })();

                setProgress(20, 'Computing Object MTF (Rust native)...');
                const nativeResp = await opener.runPortableFieldMtfForPopup({
                    objectIndex: 0,
                    wavelengths: wavelengthList,
                    firstFrequencyLpmm: Number.isFinite(meridionalFreq) ? meridionalFreq : 10,
                    secondFrequencyLpmm: Number.isFinite(sagittalFreq) ? sagittalFreq : 30,
                    fieldMin: Number.isFinite(fieldMin) ? fieldMin : 0,
                    fieldMax: Number.isFinite(fieldMax) ? fieldMax : 10,
                    steps: Number.isFinite(steps) ? steps : 21,
                    samplingSize: Number.isFinite(sampling) ? sampling : 256,
                    zeroPadTo,
                    opdDisplayMode,
                    fieldAxisMode: axisInfo.mode,
                    onProgress: (evt) => {
                        const p = Number(evt && evt.percent);
                        const msg = String((evt && evt.message) || 'Computing Object MTF...');
                        if (Number.isFinite(p)) {
                            setProgress(p, msg);
                        } else {
                            setProgress(20, msg);
                        }
                    },
                });

                if (!window.Plotly || typeof window.Plotly.newPlot !== 'function') {
                    throw new Error('Plotly is not available in Object MTF popup');
                }
                const xAxis = Array.isArray(nativeResp?.xAxis) ? nativeResp.xAxis : [];
                const series = Array.isArray(nativeResp?.series) ? nativeResp.series : [];
                if (!xAxis.length || !series.length) {
                    throw new Error('Native Object MTF did not produce valid data');
                }

                try {
                    const diag = Array.isArray(series?.[0]?.fieldDiagnostics) ? series[0].fieldDiagnostics : [];
                    if (diag.length) {
                        popupLog('📊 [Object MTF diag] field diagnostics count=', diag.length);
                        const jumps = [];
                        for (let i = 1; i < diag.length; i++) {
                            const a = diag[i - 1];
                            const b = diag[i];
                            const d1 = Math.abs(Number(b?.firstValueMeridional) - Number(a?.firstValueMeridional));
                            const d2 = Math.abs(Number(b?.secondValueMeridional) - Number(a?.secondValueMeridional));
                            if ((Number.isFinite(d1) && d1 > 0.12) || (Number.isFinite(d2) && d2 > 0.12)) {
                                jumps.push({
                                    fromField: Number(a?.fieldValue),
                                    toField: Number(b?.fieldValue),
                                    deltaFirstMeridional: d1,
                                    deltaSecondMeridional: d2,
                                    modeFrom: String(a?.effectivePupilSamplingMode || ''),
                                    modeTo: String(b?.effectivePupilSamplingMode || ''),
                                    firstBracketTo: [Number(b?.firstBracketLowLpmm), Number(b?.firstBracketHighLpmm)],
                                    secondBracketTo: [Number(b?.secondBracketLowLpmm), Number(b?.secondBracketHighLpmm)],
                                });
                            }
                        }
                        if (jumps.length) {
                            popupLog('⚠️ [Object MTF diag] potential discontinuities:', jumps.slice(0, 20));
                        }
                    }
                } catch (_) {}

                const getColorForWavelengthPopup = (wl) => {
                    try {
                        if (typeof opener.getColorForWavelength === 'function') {
                            const c = opener.getColorForWavelength(wl);
                            if (typeof c === 'string' && c) return c;
                        }
                    } catch (_) {}
                    const nm = Number(wl) * 1000;
                    if (!Number.isFinite(nm)) return '#2563eb';
                    if (nm < 470) return '#2563eb';
                    if (nm < 530) return '#16a34a';
                    if (nm < 600) return '#f59e0b';
                    return '#dc2626';
                };

                const firstFreqText = String(Number.isFinite(meridionalFreq) ? meridionalFreq.toFixed(1) : '10.0');
                const secondFreqText = String(Number.isFinite(sagittalFreq) ? sagittalFreq.toFixed(1) : '30.0');
                const traces = [];
                for (let i = 0; i < series.length; i++) {
                    const s = series[i] || {};
                    const wl = Number(s.wavelengthUm);
                    const nm = Number.isFinite(wl) ? (wl * 1000).toFixed(1) : 'N/A';
                    const color = getColorForWavelengthPopup(wl);

                    traces.push({
                        x: xAxis,
                        y: Array.isArray(s.meridionalFirst) ? s.meridionalFirst : [],
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Meridional ' + firstFreqText + ' lp/mm (' + nm + 'nm)',
                        line: { color, width: 2, dash: 'solid' },
                    });
                    traces.push({
                        x: xAxis,
                        y: Array.isArray(s.sagittalFirst) ? s.sagittalFirst : [],
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Sagittal ' + firstFreqText + ' lp/mm (' + nm + 'nm)',
                        line: { color, width: 2, dash: 'dot' },
                    });
                    traces.push({
                        x: xAxis,
                        y: Array.isArray(s.meridionalSecond) ? s.meridionalSecond : [],
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Meridional ' + secondFreqText + ' lp/mm (' + nm + 'nm)',
                        line: { color, width: 2, dash: 'dash' },
                    });
                    traces.push({
                        x: xAxis,
                        y: Array.isArray(s.sagittalSecond) ? s.sagittalSecond : [],
                        type: 'scatter',
                        mode: 'lines',
                        name: 'Sagittal ' + secondFreqText + ' lp/mm (' + nm + 'nm)',
                        line: { color, width: 2, dash: 'dashdot' },
                    });
                }

                setProgress(85, 'Rendering Object MTF...');
                await window.Plotly.newPlot(containerEl, traces, {
                    title: firstFreqText + ' / ' + secondFreqText + ' lp/mm',
                    xaxis: { title: axisInfo.label },
                    yaxis: { title: 'MTF', range: [0, 1.05] },
                    margin: { l: 60, r: 20, t: 50, b: 50 },
                    showlegend: true,
                }, { responsive: true, displaylogo: false });

                hideProgress();
                return;
            } catch (err) {
                popupError('[Object MTF Popup] renderFieldMTF failed', err);
                setProgress(100, 'Failed');
                if (containerEl) {
                    const details = String((err && err.message) ? err.message : err || 'Unknown error');
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate Object MTF.<br/><span style="font-size:12px;color:#555;">' + details.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span></div>';
                }
            }
        };

        document.getElementById('popup-show-field-mtf-btn').addEventListener('click', () => window.renderFieldMTF());
        window.addEventListener('focus', syncAllOptions);
        window.addEventListener('load', () => syncAllOptions());
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Transverse Aberration popup window button
        const openTransverseAberrationWindowBtn = document.getElementById('open-transverse-aberration-window-btn');
        if (openTransverseAberrationWindowBtn) {
                openTransverseAberrationWindowBtn.addEventListener('click', () => {
                        if (w.__transverseAberrationPopup && !w.__transverseAberrationPopup.closed) {
                                try { w.__transverseAberrationPopup.focus(); } catch (_) {}
                    try {
                        if (typeof w.__transverseAberrationPopup.renderTransverseAberration === 'function') {
                            w.__transverseAberrationPopup.renderTransverseAberration();
                        }
                    } catch (_) {}
                                return;
                        }

                        const popup = consumePreopenedAnalysisPopup('Transverse Aberration', 'width=800,height=600');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        w.__transverseAberrationPopup = popup;

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title>Transverse Aberration</title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .controls {
            padding: 10px 12px;
            background: #f8f8f8;
            border-bottom: 1px solid #ddd;
            display: flex;
            flex-wrap: wrap;
            gap: 8px 10px;
            align-items: center;
            flex: 0 0 auto;
        }
        .controls label { font-size: 12px; color: #333; white-space: nowrap; }
        .controls button {
            padding: 6px 10px;
            border: 1px solid #bbb;
            background: #f8f8f8;
            cursor: pointer;
            border-radius: 4px;
            font-size: 12px;
            color: #333;
        }
        .controls button:hover { background: #e9e9e9; }
        .controls input {
            padding: 5px 8px;
            font-size: 12px;
            border: 1px solid #bbb;
            border-radius: 4px;
            background: white;
            width: 90px;
        }
        .content {
            flex: 1 1 auto;
            min-height: 0;
            overflow: hidden;
            background: white;
        }
        #popup-transverse-aberration-container { height: 100%; min-height: 100%; }
    </style>
    <script src="https://cdn.plot.ly/plotly-2.32.0.min.js"></script>
</head>
<body>
    <div class="controls">
        <label for="popup-transverse-ray-count-input">Ray number:</label>
        <input type="number" id="popup-transverse-ray-count-input" value="101" min="9" max="10001" step="1" />
        <span class="note-inline" style="font-size:12px;color:#666;">(Always normalized by stop diameter)</span>
        <button id="popup-show-transverse-aberration-btn" type="button">Show transverse aberration diagram</button>
    </div>
    <div id="popup-transverse-progress-wrapper" style="display:none;padding:10px 12px;border-bottom:1px solid #eee;background:#fff;">
        <div id="popup-transverse-progress-text" style="margin-bottom: 6px; font-size:12px; color:#555;">Starting...</div>
        <progress id="popup-transverse-progressbar" value="0" max="100" style="display:block;width:calc(100% + 24px);margin-left:-12px;height:14px;"></progress>
    </div>
    <div class="content">
        <div id="popup-transverse-aberration-container"></div>
    </div>

    <script>
        function getOpenerEl(id) {
            try {
                return window.opener && window.opener.document ? window.opener.document.getElementById(id) : null;
            } catch (e) {
                return null;
            }
        }

        function syncFromOpener() {
            const openerRay = getOpenerEl('transverse-ray-count-input');
            const popupRay = document.getElementById('popup-transverse-ray-count-input');
            if (openerRay && popupRay) {
                popupRay.value = openerRay.value;
            }
        }

        window['renderTransverseAberration'] = async () => {
            const progressWrap = document.getElementById('popup-transverse-progress-wrapper');
            const progressBar = document.getElementById('popup-transverse-progressbar');
            const progressText = document.getElementById('popup-transverse-progress-text');
            const setProgress = (percent, message) => {
                try {
                    if (progressWrap) progressWrap.style.display = 'block';
                    if (progressBar && Number.isFinite(percent)) progressBar.value = Math.max(0, Math.min(100, percent));
                    if (progressText) progressText.textContent = message || '';
                } catch (_) {}
            };
            const hideProgress = () => {
                try {
                    if (progressWrap) progressWrap.style.display = 'none';
                } catch (_) {}
            };
            const onProgress = (evt) => {
                const p = Number(evt?.percent);
                const msg = (evt && (evt.message || evt.phase)) ? String(evt.message || evt.phase) : '';
                setProgress(Number.isFinite(p) ? p : 0, msg);
            };

            const popupRay = document.getElementById('popup-transverse-ray-count-input');
            const rayCount = popupRay ? parseInt(popupRay.value, 10) : 51;
            const openerRay = getOpenerEl('transverse-ray-count-input');
            if (openerRay && Number.isFinite(rayCount)) {
                openerRay.value = String(rayCount);
            }

            const containerEl = document.getElementById('popup-transverse-aberration-container');
            if (containerEl) containerEl.innerHTML = '';

            try {
                if (!window.opener || typeof window.opener.showTransverseAberrationDiagram !== 'function') {
                    throw new Error('showTransverseAberrationDiagram is not available on opener');
                }
                setProgress(0, 'Starting...');
                await window.opener.showTransverseAberrationDiagram({
                    rayCount: Number.isFinite(rayCount) ? rayCount : 51,
                    containerElement: containerEl,
                    onProgress
                });
                hideProgress();
            } catch (err) {
                console.error(err);
                if (containerEl) {
                    containerEl.innerHTML = '<div style="padding:20px;color:red;font-family:Arial;">Failed to generate transverse aberration diagram. Check console.</div>';
                }
                setProgress(100, 'Failed');
            }
        };

        document.getElementById('popup-show-transverse-aberration-btn').addEventListener('click', () => {
            window.renderTransverseAberration();
        });

        window.addEventListener('focus', syncFromOpener);
        syncFromOpener();

        // Auto-render immediately on open
        window.addEventListener('load', () => {
            try { window.renderTransverseAberration(); } catch (_) {}
        });
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                });
        }

        // Settings popup (environment settings)
        const openSettingsBtn = document.getElementById('open-settings-btn');
        const openSettingsPopup = () => {
                        __cooptInstallDesktopForceInfinitePupilModeBridge();

                        const isSettingsWindowContext = (() => {
                            try {
                                const url = new URL(window.location.href);
                                return url.searchParams.get('coopt_settings_window') === '1';
                            } catch (_) {
                                return false;
                            }
                        })();

                        if (isTauriRuntime() && !isSettingsWindowContext) {
                            (async () => {
                                try {
                                    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                                    const label = 'settings-window';
                                    const existing = await WebviewWindow.getByLabel(label);
                                    if (existing) {
                                        await existing.setFocus();
                                        return;
                                    }

                                    const url = new URL(window.location.href);
                                    url.searchParams.set('coopt_settings_window', '1');
                                    const forceMode = __cooptGetForceInfinitePupilMode();
                                    if (forceMode) {
                                        url.searchParams.set('coopt_force_mode', forceMode);
                                    } else {
                                        url.searchParams.delete('coopt_force_mode');
                                    }
                                    new WebviewWindow(label, {
                                        title: 'Settings',
                                        url: url.toString(),
                                        width: 520,
                                        height: 620,
                                        resizable: true,
                                        focus: true,
                                    });
                                } catch (err) {
                                    console.error('❌ [Settings][Desktop] WebviewWindow error:', err);
                                    alert('Failed to open Settings window.');
                                }
                            })();
                            return;
                        }

                        if (w.__settingsPopup && !w.__settingsPopup.closed) {
                                try { w.__settingsPopup.focus(); } catch (_) {}
                                return;
                        }

                        const popup = (isTauriRuntime() && isSettingsWindowContext)
                            ? window
                            : window.open('', 'Settings', 'width=520,height=340');
                        if (!popup) {
                            alert('ポップアップがブロックされました。ブラウザのポップアップブロッカーを無効にしてください。\n\nPopup was blocked. Please disable your browser\'s popup blocker.');
                            return;
                        }
                        if (!(isTauriRuntime() && isSettingsWindowContext)) {
                            w.__settingsPopup = popup;
                        }

                        popup.document.write(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <title></title>
    <style>
        html, body { height: 100%; }
        body {
            margin: 0;
            font-family: Arial, sans-serif;
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #f4f4f4;
        }
        .header {
            padding: 10px 12px;
            background: #f8f8f8;
            color: #333;
            border-bottom: 1px solid #ddd;
            font-size: 14px;
            font-weight: 600;
        }
        .content {
            padding: 12px;
            background: #fff;
            flex: 1 1 auto;
            overflow: auto;
        }
        .section-title { font-size: 13px; font-weight: 600; color: #333; margin: 0 0 8px 0; }
        .help { font-size: 12px; color: #666; margin: 0 0 10px 0; line-height: 1.35; }
        .radio-group { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 12px 0; }
        label { font-size: 13px; color: #333; }
        .footer {
            padding: 10px 12px;
            border-top: 1px solid #ddd;
            background: #f8f8f8;
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }
        code { font-family: Menlo, Consolas, monospace; font-size: 12px; }
    </style>
</head>
<body>
    <div class="header"></div>
    <div class="content">
        <div class="section-title">Glass Map: Default Manufacturers</div>
        <div class="help">
            Choose which manufacturers are enabled by default when opening Glass Map.
            <br />If nothing is selected, Glass Map will show all manufacturers.
        </div>

        <div class="checkbox-group" style="display:flex;flex-direction:column;gap:8px;margin:8px 0 14px 0;">
            <label><input type="checkbox" class="glassmap-mfr-cb" value="SCHOTT" /> SCHOTT</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="HOYA" /> HOYA</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="HIKARI" /> HIKARI</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="OHARA" /> OHARA</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="Sumita" /> Sumita</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="CDGM" /> CDGM</label>
            <label><input type="checkbox" class="glassmap-mfr-cb" value="Special" /> Special</label>
        </div>

        <div class="section-title">Dark Mode</div>
        <div class="help">
            Enable VS Code-style dark mode for the entire UI.
        </div>
        <label style="margin: 8px 0 14px 0; display: block;">
            <input type="checkbox" id="dark-mode-cb" /> Enable Dark Mode
        </label>

        <div class="section-title">Infinite Field: Pupil Sampling Mode</div>
        <div class="help">
            Fix the sampling mode used for infinite-field wavefront/PSF/MTF generation.
            <br />
            This sets <code>__COOPT_FORCE_INFINITE_PUPIL_MODE</code> to <code>stop</code> or <code>entrance</code>.
        </div>

        <div class="radio-group">
            <label><input type="radio" name="force-mode" value="" /> Auto (default)</label>
            <label><input type="radio" name="force-mode" value="stop" /> Force <code>stop</code></label>
            <label><input type="radio" name="force-mode" value="entrance" /> Force <code>entrance</code></label>
        </div>

        <div class="help" style="margin-top: 6px;">
            Note: Changes take effect on the next calculation.
        </div>
    </div>
    <div class="footer"></div>

    <script>
        const KEY = 'coopt.forceInfinitePupilMode';
        const isDesktopRuntime = !!(window && (window.__TAURI_INTERNALS__ || window.__TAURI__));
        const GLASS_MAP_MFR_KEY = 'coopt.glassMap.defaultManufacturers';
        const DARK_MODE_KEY = 'coopt.darkMode';
        const sanitize = (v) => {
            const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
            return (s === 'stop' || s === 'entrance') ? s : '';
        };

        const sanitizeMfrList = (list) => {
            if (!Array.isArray(list)) return [];
            const allow = new Set(['SCHOTT', 'HOYA', 'HIKARI', 'OHARA', 'SUMITA', 'CDGM', 'SPECIAL']);
            const out = [];
            for (const v of list) {
                const s = String(v ?? '').trim();
                if (!s) continue;
                const upper = s.toUpperCase();
                if (!allow.has(upper)) continue;
                // Preserve canonical casing used in the checkboxes.
                if (upper === 'SUMITA') out.push('Sumita');
                else if (upper === 'SPECIAL') out.push('Special');
                else out.push(upper);
            }
            // Deduplicate
            return Array.from(new Set(out));
        };

        function getOpener() {
            try { return window.opener || null; } catch (_) { return null; }
        }

        async function readDesktopModeDirect() {
            try {
                const invoke = window?.__TAURI_INTERNALS__?.invoke || window?.__TAURI__?.core?.invoke;
                if (typeof invoke !== 'function') return '';
                const raw = await invoke('read_desktop_setting', { key: KEY });
                return sanitize(raw);
            } catch (_) {
                return '';
            }
        }

        async function writeDesktopModeDirect(mode) {
            const m = sanitize(mode);
            try {
                const invoke = window?.__TAURI_INTERNALS__?.invoke || window?.__TAURI__?.core?.invoke;
                if (typeof invoke !== 'function') return;
                await invoke('write_desktop_setting', { key: KEY, value: m || null });
            } catch (_) {}
        }

        function getFromWindow(target) {
            if (!target) return '';
            try {
                if (typeof target.__cooptGetForceInfinitePupilMode === 'function') {
                    const m = sanitize(target.__cooptGetForceInfinitePupilMode());
                    if (m) return m;
                }
            } catch (_) {}
            try {
                return sanitize(target.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? target.COOPT_FORCE_INFINITE_PUPIL_MODE);
            } catch (_) {
                return '';
            }
        }

        function setToWindow(target, mode) {
            if (!target) return;
            try {
                if (typeof target.__cooptSetForceInfinitePupilMode === 'function') {
                    target.__cooptSetForceInfinitePupilMode(mode);
                    return;
                }
            } catch (_) {}
            try {
                if (mode) {
                    target.__COOPT_FORCE_INFINITE_PUPIL_MODE = mode;
                    target.COOPT_FORCE_INFINITE_PUPIL_MODE = mode;
                } else {
                    try { delete target.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { target.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
                    try { delete target.COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { target.COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
                }
            } catch (_) {}
        }

        function getCurrent() {
            const selfMode = getFromWindow(window);
            if (selfMode) return selfMode;

            const o = getOpener();
            const openerMode = getFromWindow(o);
            if (openerMode) return openerMode;

            try {
                const stored = sanitize(localStorage.getItem(KEY));
                if (stored) return stored;
            } catch (_) {}

            try {
                const fromUrl = sanitize(new URL(window.location.href).searchParams.get('coopt_force_mode'));
                if (fromUrl) return fromUrl;
            } catch (_) {}

            return '';
        }

        function applyMode(mode) {
            const m = sanitize(mode);
            setToWindow(window, m);

            const o = getOpener();
            setToWindow(o, m);

            try {
                if (m) localStorage.setItem(KEY, m);
                else localStorage.removeItem(KEY);
            } catch (_) {}

            try {
                if (typeof window.__cooptBroadcastForceInfinitePupilMode === 'function') {
                    window.__cooptBroadcastForceInfinitePupilMode(m);
                }
            } catch (_) {}

            writeDesktopModeDirect(m);
        }

        async function hydrateFromDesktopStore() {
            const direct = await readDesktopModeDirect();
            if (direct) {
                setToWindow(window, direct);
                try { localStorage.setItem(KEY, direct); } catch (_) {}
                syncUI();
                return;
            }
        }

        function syncUI() {
            const cur = getCurrent();
            const radios = document.querySelectorAll('input[name="force-mode"]');
            radios.forEach(r => {
                r.checked = (sanitize(r.value) === cur);
                if (cur === '' && sanitize(r.value) === '') r.checked = true;
            });

            // Glass Map manufacturers
            let stored = [];
            try {
                stored = sanitizeMfrList(JSON.parse(localStorage.getItem(GLASS_MAP_MFR_KEY) || '[]'));
            } catch (_) {
                stored = [];
            }
            const storedSet = new Set(stored.map(s => String(s).toUpperCase()));
            document.querySelectorAll('.glassmap-mfr-cb').forEach(cb => {
                const v = String(cb.value || '');
                cb.checked = storedSet.has(v.toUpperCase());
            });

            // Dark Mode
            const darkModeCb = document.getElementById('dark-mode-cb');
            if (darkModeCb) {
                let isDark = false;
                try {
                    isDark = localStorage.getItem(DARK_MODE_KEY) === 'true';
                } catch (_) {}
                darkModeCb.checked = isDark;
            }
        }

        function saveGlassMapMfrSelection() {
            const selected = [];
            document.querySelectorAll('.glassmap-mfr-cb').forEach(cb => {
                if (cb.checked) selected.push(cb.value);
            });
            const sanitized = sanitizeMfrList(selected);
            try {
                if (sanitized.length) localStorage.setItem(GLASS_MAP_MFR_KEY, JSON.stringify(sanitized));
                else localStorage.removeItem(GLASS_MAP_MFR_KEY);
            } catch (_) {}
        }

        function applyDarkMode(enabled) {
            const o = getOpener();
            try {
                if (o && typeof o.__cooptSetDarkMode === 'function') {
                    o.__cooptSetDarkMode(enabled);
                }
            } catch (_) {}
            
            try {
                localStorage.setItem(DARK_MODE_KEY, enabled ? 'true' : 'false');
            } catch (_) {}
        }

        document.querySelectorAll('input[name="force-mode"]').forEach(r => {
            r.addEventListener('change', () => {
                if (r.checked) applyMode(r.value);
            });
        });

        document.querySelectorAll('.glassmap-mfr-cb').forEach(cb => {
            cb.addEventListener('change', () => {
                saveGlassMapMfrSelection();
            });
        });

        const darkModeCb = document.getElementById('dark-mode-cb');
        if (darkModeCb) {
            darkModeCb.addEventListener('change', () => {
                applyDarkMode(darkModeCb.checked);
            });
        }

        window.addEventListener('focus', syncUI);
        syncUI();
        hydrateFromDesktopStore();
    </script>
</body>
</html>
                        `);

                        try { popup.document.close(); } catch (_) {}
                };

        if (openSettingsBtn && !isTauriRuntime()) {
                openSettingsBtn.addEventListener('click', openSettingsPopup);
        }

        // React toolbar can mount after this initializer, so delegate as a fallback.
        if (!isTauriRuntime() && !(w as any).__cooptSettingsButtonDelegatedBound) {
            document.addEventListener('click', (ev: Event) => {
                try {
                    const target = ev.target as HTMLElement | null;
                    if (!target || typeof target.closest !== 'function') return;
                    const btn = target.closest('#open-settings-btn');
                    if (!btn) return;
                    openSettingsPopup();
                } catch (_) {}
            });
            (w as any).__cooptSettingsButtonDelegatedBound = true;
        }

        // Dark Mode initialization
        (() => {
                const DARK_MODE_KEY = 'coopt.darkMode';
                
                function applyDarkModeClass(enabled) {
                        if (enabled) {
                                document.body.classList.add('dark-mode');
                        } else {
                                document.body.classList.remove('dark-mode');
                        }
                }
                
                function loadDarkMode() {
                        try {
                                const stored = localStorage.getItem(DARK_MODE_KEY);
                                return stored === 'true';
                        } catch (_) {
                                return false;
                        }
                }
                
                // Expose to Settings popup
                w.__cooptSetDarkMode = (enabled) => {
                        applyDarkModeClass(enabled);
                };
                
                // Apply on load
                applyDarkModeClass(loadDarkMode());
        })();
}

// ============================================================================
// COORDINATE TRANSFORMATION UI CONTROLS
// ============================================================================

/**
 * Setup coordinate transformation controls (surface select, show/cancel/save buttons)
 */
export function setupTransformationControls(): void {
    const transformSurfaceSelect = document.getElementById('transform-surface-select') as HTMLSelectElement | null;
    const showLocalCoordsBtn = document.getElementById('show-local-coords-btn') as HTMLButtonElement | null;
    const cancelTransformBtn = document.getElementById('cancel-transform-btn') as HTMLButtonElement | null;
    const saveLocalCoordsBtn = document.getElementById('save-local-coords-btn') as HTMLButtonElement | null;
    const errorBar = document.getElementById('transform-error-bar') as HTMLElement | null;
    const errorText = document.getElementById('transform-error-text') as HTMLElement | null;
    const progressWrapper = document.getElementById('transform-progress-wrapper') as HTMLElement | null;
    const progressText = document.getElementById('transform-progress-text') as HTMLElement | null;
    const progressBar = document.getElementById('transform-progressbar') as HTMLProgressElement | HTMLElement | null;
    
    // Helper functions
    const showError = (message: string): void => {
        if (errorBar && errorText) {
            errorText.textContent = message;
            errorBar.style.display = '';
        }
    };
    
    const hideError = (): void => {
        if (errorBar) errorBar.style.display = 'none';
    };
    
    const setProgress = (percent: number, message: string): void => {
        if (progressWrapper) progressWrapper.style.display = 'block';
        if (progressBar && Number.isFinite(percent)) {
            progressBar.value = Math.max(0, Math.min(100, percent));
        }
        if (progressText && message) progressText.textContent = message;
    };
    
    const hideProgress = (): void => {
        if (progressWrapper) progressWrapper.style.display = 'none';
    };

    const isCoordTransRowForPath = (row: any): boolean => {
        const surfType = String(row?.surfType ?? row?.['surf type'] ?? row?.type ?? '')
            .toLowerCase()
            .replace(/\s+/g, '');
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
        const surfType = String(row?.surfType ?? row?.['surf type'] ?? row?.type ?? '').toLowerCase();
        return surfType === 'gap';
    };

    const resolveSurfaceIndexFromOrdinal = (opticalSystemRows: any[], ordinal: number): number | null => {
        if (!Array.isArray(opticalSystemRows)) return null;
        if (!Number.isFinite(ordinal)) return null;
        const target = Math.floor(ordinal);
        if (target <= 0) return null;
        let count = 0;
        for (let i = 0; i < opticalSystemRows.length; i++) {
            const row = opticalSystemRows[i];
            if (isCoordTransRowForPath(row)) continue;
            if (isObjectRowForPath(row)) continue;
            if (isGapRowForPath(row)) continue;
            count++;
            if (count === target) return i;
        }
        return null;
    };
    
    // Show Local Coords button
    if (showLocalCoordsBtn) {
        showLocalCoordsBtn.addEventListener('click', async function() {
            hideError();
            
            try {
                const surfaceOrdinal = parseInt(transformSurfaceSelect?.value || '', 10);
                if (!Number.isFinite(surfaceOrdinal)) {
                    showError('Please select a surface first.');
                    return;
                }
                
                // Get optical system data
                const getOpticalSystemRows = w.getOpticalSystemRows;
                if (typeof getOpticalSystemRows !== 'function') {
                    showError('Optical system data not available.');
                    return;
                }
                
                const opticalSystemRows = getOpticalSystemRows();
                if (!opticalSystemRows || opticalSystemRows.length === 0) {
                    showError('No optical system data. Please load or create an optical system.');
                    return;
                }

                const surfaceIndex = resolveSurfaceIndexFromOrdinal(opticalSystemRows, surfaceOrdinal);
                if (surfaceIndex === null) {
                    showError('Selected surface could not be resolved.');
                    return;
                }
                
                // Disable button and show cancel button
                showLocalCoordsBtn.disabled = true;
                if (cancelTransformBtn) cancelTransformBtn.style.display = '';
                if (saveLocalCoordsBtn) saveLocalCoordsBtn.style.display = 'none';
                
                // Reset cancellation flag
                w._transformCalculationCancelled = false;
                
                // Calculate local coordinates
                const calculateAllSurfacesLocalCoordinates = w.calculateAllSurfacesLocalCoordinates;
                if (typeof calculateAllSurfacesLocalCoordinates !== 'function') {
                    showError('Coordinate transformation function not available.');
                    showLocalCoordsBtn.disabled = false;
                    if (cancelTransformBtn) cancelTransformBtn.style.display = 'none';
                    return;
                }
                
                const result = await calculateAllSurfacesLocalCoordinates(
                    opticalSystemRows,
                    surfaceIndex,
                    (percent: number, message: string) => setProgress(percent, message)
                );
                
                // Store results
                w._cachedLocalCoords = result;
                w._showLocalCoords = true;
                
                // Redraw table
                if (w.tableOpticalSystem) {
                    w.tableOpticalSystem.redraw();
                }
                
                // Show save button
                if (saveLocalCoordsBtn) saveLocalCoordsBtn.style.display = '';
                
                hideProgress();
                
            } catch (error: any) {
                console.error('Coordinate transformation error:', error);
                showError(error.message || 'Failed to calculate local coordinates.');
                hideProgress();
            } finally {
                showLocalCoordsBtn.disabled = false;
                if (cancelTransformBtn) cancelTransformBtn.style.display = 'none';
            }
        });
    }
    
    // Cancel button
    if (cancelTransformBtn) {
        cancelTransformBtn.addEventListener('click', function() {
            w._transformCalculationCancelled = true;
            if (cancelTransformBtn) cancelTransformBtn.style.display = 'none';
            hideProgress();
            showError('Calculation cancelled by user.');
        });
    }
    
    // Save as JSON button
    if (saveLocalCoordsBtn) {
        saveLocalCoordsBtn.addEventListener('click', function() {
            try {
                if (!w._cachedLocalCoords) {
                    showError('No coordinate data to save. Please calculate first.');
                    return;
                }
                
                const data = w._cachedLocalCoords;
                const json = JSON.stringify(data, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                const surfaceIndex = data.metadata?.targetSurfaceIndex ?? 'unknown';
                const filename = `local-coords-surf${surfaceIndex}-${timestamp}.json`;
                
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                
                URL.revokeObjectURL(url);
                
            } catch (error: any) {
                console.error('Save error:', error);
                showError('Failed to save JSON file: ' + error.message);
            }
        });
    }
    
    // Update surface select on optical system changes
    updateTransformSurfaceSelect();
    
    // Analysis dropdown selector
    const analysisSelect = document.getElementById('analysis-select') as HTMLSelectElement | null;
    if (analysisSelect) {
        analysisSelect.addEventListener('change', () => {
            const selectedValue = analysisSelect.value;
            if (!selectedValue) return;
            
            // Reset select to default after triggering
            analysisSelect.value = '';
            
            // Map analysis values to corresponding button IDs
            const analysisButtonMap: Record<string, string> = {
                'spot-diagram': 'open-spot-diagram-window-btn',
                'spherical-aberration': 'open-spherical-aberration-window-btn',
                'astigmatism': 'open-astigmatism-window-btn',
                'distortion': 'open-distortion-window-btn',
                'distortion-grid': 'open-distortion-grid-window-btn',
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
            
            const buttonId = analysisButtonMap[selectedValue];
            if (buttonId) {
                try {
                    if (typeof w.setupAnalysisWindows === 'function') {
                        w.setupAnalysisWindows();
                    }
                } catch (_) {}
                const button = document.getElementById(buttonId);
                if (button) {
                    button.click();
                }
            }
        });
    }
}

/**
 * Update transform surface select dropdown with current optical system surfaces
 */
export function updateTransformSurfaceSelect(): void {
    const transformSurfaceSelect = document.getElementById('transform-surface-select') as HTMLSelectElement | null;
    if (!transformSurfaceSelect) return;
    
    try {
        const getOpticalSystemRows = w.getOpticalSystemRows;
        if (typeof getOpticalSystemRows !== 'function') return;
        
        const opticalSystemRows = getOpticalSystemRows();
        if (!opticalSystemRows || opticalSystemRows.length === 0) return;
        
        // Clear existing options
        transformSurfaceSelect.innerHTML = '<option value="">Select surface...</option>';
        
        // Add surface options (skip Object and CoordTrans surfaces)
        let surfaceNumber = 0;
        opticalSystemRows.forEach((row: any, index: number) => {
            // Skip Object surfaces
            const objectType = String(row?.['object type'] ?? row?.object ?? '').toLowerCase();
            if (objectType === 'object') return;
            
            // Skip CoordTrans surfaces
            const surfType = String(row?.surfType ?? row?.type ?? '').toLowerCase();
            if (surfType === 'ct' || surfType === 'coordtrans' || surfType === 'coordinatebreak' ||
                surfType === 'coord trans' || surfType === 'coordinate break') {
                return;
            }

            surfaceNumber += 1;
            
            // Create option
            const option = document.createElement('option');
            option.value = String(surfaceNumber);
            
            // Create label
            let label = `Surf ${surfaceNumber}`;
            if (row.comment) label += `: ${row.comment}`;
            else if (row.material && row.material !== 'AIR') label += `: ${row.material}`;
            
            option.textContent = label;
            transformSurfaceSelect.appendChild(option);
        });
        
    } catch (error) {
        console.error('Error updating transform surface select:', error);
    }
}


/**
 * Update surface number select with current optical system surfaces
 */
export function updateSurfaceNumberSelect(): void {
    console.log('[DEBUG] updateSurfaceNumberSelect called');
    const surfaceSelect = document.getElementById('surface-number-select') as HTMLSelectElement | null;
    console.log('[DEBUG] surface-number-select element:', surfaceSelect);
    if (!surfaceSelect) {
        console.log('[DEBUG] surface-number-select element not found!');
        return;
    }
    
    try {
        const getOpticalSystemRows = w.getOpticalSystemRows;
        console.log('[DEBUG] getOpticalSystemRows function:', typeof getOpticalSystemRows);
        if (typeof getOpticalSystemRows !== 'function') {
            console.log('[DEBUG] getOpticalSystemRows is not a function');
            return;
        }
        
        const opticalSystemRows = getOpticalSystemRows();
        console.log('[DEBUG] opticalSystemRows:', opticalSystemRows?.length);
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            console.log('[DEBUG] No optical system rows found');
            return;
        }
        
        // Save current selection (value + rowId/rowSig)
        const prevValue = surfaceSelect.value;
        const prevOption = surfaceSelect.selectedOptions && surfaceSelect.selectedOptions.length > 0
            ? surfaceSelect.selectedOptions[0]
            : null;
        const prevRowId = prevOption?.dataset?.rowId ? String(prevOption.dataset.rowId) : '';
        const prevRowSig = prevOption?.dataset?.rowSig ? String(prevOption.dataset.rowSig) : '';
        
        // Clear existing options
        surfaceSelect.innerHTML = '<option value="">Select surface...</option>';
        
        // Add surface options (CB-invariant ids)
        const opts = generateSurfaceOptions(opticalSystemRows);
        opts.forEach((o: any) => {
            const option = document.createElement('option');
            option.value = String(o.surfaceId);
            option.textContent = String(o.label ?? o.value ?? `Surf ${o.surfaceId}`);
            if (o.rowId) option.dataset.rowId = String(o.rowId);
            if (o.rowSig) option.dataset.rowSig = String(o.rowSig);
            if (Number.isInteger(o.rowIndex)) option.dataset.rowIndex = String(o.rowIndex);
            surfaceSelect.appendChild(option);
        });
        
        // Restore selection if still valid
        if (prevValue && Array.from(surfaceSelect.options).some(opt => opt.value === prevValue)) {
            surfaceSelect.value = prevValue;
        } else if (prevRowId) {
            const match = Array.from(surfaceSelect.options).find(opt => opt.dataset?.rowId === prevRowId);
            if (match) surfaceSelect.value = match.value;
        } else if (prevRowSig) {
            const match = Array.from(surfaceSelect.options).find(opt => opt.dataset?.rowSig === prevRowSig);
            if (match) surfaceSelect.value = match.value;
        }
        if (!surfaceSelect.value && surfaceSelect.options.length > 1) {
            const img = Array.from(surfaceSelect.options).find(opt => String(opt.textContent || '').includes('(Image)'));
            if (img) surfaceSelect.value = img.value;
            else surfaceSelect.selectedIndex = surfaceSelect.options.length - 1;
        }
    } catch (error) {
        console.error('Error updating surface number select:', error);
    }
}

// NOTE: window.updateSurfaceNumberSelect is owned by main.ts (Facade).
