// Import data utility functions
import { getOpticalSystemRows, getObjectRows, getSourceRows } from '../utils/data-utils.ts';
import { calculateImageSpaceDiffractionParams } from '../raytracing/core/ray-paraxial.ts';
import { ensureMtfWasmReady, setRayTracingWasmStrict, isRayTracingWasmStrict } from '../core/wasm-service.ts';
import { isTauriRuntime } from '../src/desktop/runtime.ts';
import { runNativeMtfMap } from '../src/desktop/ipc/client.ts';
import { TFMTFWorkerPool, getGlobalTFMTFWorkerPool } from './tfmtf-worker-pool.ts';
import { extractPSFGridFromCalculatorResult, validatePSFGrid, extractPSFMetadata } from './psf-serialization.ts';

// Singleton for PSF calculator to avoid repeated initialization
let _psfCalculatorSingletonPromise = null;
async function getPSFCalculatorSingleton() {
    if (!_psfCalculatorSingletonPromise) {
        _psfCalculatorSingletonPromise = (async () => {
            const { PSFCalculator } = await import('./psf/psf-calculator.js');
            return new PSFCalculator();
        })();
    }
    return _psfCalculatorSingletonPromise;
}

type MtfPlotOptions = {
    wavelengthMicrons?: number | string;
    objectIndex?: number;
    objectOverride?: { xHeightAngle?: number; yHeightAngle?: number; position?: string; x?: number; y?: number } | null;
    maxFrequencyLpmm?: number;
    samplingSize?: number;
    samplingPoints?: number;
    containerElement?: HTMLElement | null;
    onProgress?: (evt: { percent: number; message?: string }) => void;
    opdDisplayMode?: string;
    defocusShiftMm?: number;
    skipPlot?: boolean;
    showDiffractionLimit?: boolean;
    zeroPadTo?: number;
    legacyBaselineMode?: boolean;
    plotPointCount?: number;
};

type ThroughFocusMtfOptions = {
    wavelengthMicrons?: number | string;
    objectIndex?: number;
    targetFrequencyLpmm?: number;
    defocusMinMm?: number;
    defocusMaxMm?: number;
    steps?: number;
    samplingSize?: number;
    samplingPoints?: number;
    zeroPadTo?: number;
    containerElement?: HTMLElement | null;
    onProgress?: (evt: { percent: number; message?: string; trace?: any; subMessage?: string }) => void;
    opdDisplayMode?: string;
};

type FieldMtfOptions = {
    wavelengthMicrons?: number | string;
    firstFrequencyLpmm?: number;
    secondFrequencyLpmm?: number;
    fieldMin?: number;
    fieldMax?: number;
    steps?: number;
    samplingSize?: number;
    samplingPoints?: number;
    zeroPadTo?: number;
    containerElement?: HTMLElement | null;
    onProgress?: (evt: { percent: number; message?: string; trace?: any; subMessage?: string }) => void;
    opdDisplayMode?: string;
    fieldAxisMode?: 'auto' | 'angle' | 'height';
};

type MtfComparisonOptions = {
    wavelengthMicrons?: number | string;
    objectIndex?: number;
    maxFrequencyLpmm?: number;
    samplingSize?: number;
    samplingPoints?: number;
    containerElement?: HTMLElement | null;
    onProgress?: (evt: { percent: number; message?: string }) => void;
    opdDisplayMode?: string;
    defocusShiftMm?: number;
    zeroPadTo?: number;
    showDelta?: boolean;
    timeoutMs?: number;
};

function cloneOpticalSystemRowsWithDefocusShift(opticalSystemRows, defocusShiftMm, isFiniteObject = false) {
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
    const newThickness = safeBaseThickness + shift;
    
    ensureConsoleLog(`🔍 [TFMTF Defocus] Conjugate: ${isFiniteObject ? 'FINITE' : 'INFINITE'}, Shift: ${shift.toFixed(4)} mm, Target surface ${targetIdx}: ${safeBaseThickness.toFixed(4)} → ${newThickness.toFixed(4)} mm`);
    
    target.thickness = newThickness;
    cloned[targetIdx] = target;

    return cloned;
}

// Helper: Ensure console logs appear in both popup and parent window
function ensureConsoleLog(...args) {
    try {
        console.log(...args);
    } catch (_) {}
    try {
        if (typeof window !== 'undefined' && window.opener && window.opener.console) {
            window.opener.console.log(...args);
        }
    } catch (_) {}
}

function ensureConsoleError(...args) {
    try {
        console.error(...args);
    } catch (_) {}
    try {
        if (typeof window !== 'undefined' && window.opener && window.opener.console) {
            window.opener.console.error(...args);
        }
    } catch (_) {}
}

async function showMTFDiagram({ wavelengthMicrons, objectIndex, objectOverride, maxFrequencyLpmm, samplingSize, samplingPoints, containerElement, onProgress, opdDisplayMode, defocusShiftMm, skipPlot, showDiffractionLimit, zeroPadTo, legacyBaselineMode, plotPointCount }: MtfPlotOptions = {}) {
    const safeNumber = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };

    // Match Spherical Aberration diagram color mapping.
    const getColorForWavelength = (wavelength) => {
        if (wavelength < 0.45) {
            return '#8B00FF'; // violet (380-450nm)
        } else if (wavelength < 0.495) {
            return '#0000FF'; // blue (450-495nm)
        } else if (wavelength < 0.57) {
            return '#00FF00'; // green (495-570nm)
        } else if (wavelength < 0.59) {
            return '#9ACD32'; // yellow-green (570-590nm)
        } else if (wavelength < 0.62) {
            return '#FF8800'; // orange (590-620nm)
        } else {
            return '#FF0000'; // red (620-750nm)
        }
    };

    const reportProgress = (percent, message) => {
        try {
            if (typeof onProgress !== 'function') return;
            const evt = { percent, message };
            onProgress(evt);
        } catch (_) {}
    };

    const useWasmFastOnly = !!((typeof globalThis !== 'undefined') && (globalThis as any).__COOPT_MTF_WASM_FAST_ONLY);
    const enableMtfProfileLog = !((typeof globalThis !== 'undefined') && (globalThis as any).__COOPT_MTF_PROFILE === false);
    const useLegacyBaselineMode = (typeof legacyBaselineMode === 'boolean')
        ? legacyBaselineMode
        : !((typeof globalThis !== 'undefined') && (globalThis as any).__COOPT_MTF_LEGACY_BASELINE === false);
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const plotPointCountFromGlobal = (typeof globalThis !== 'undefined')
        ? Number((globalThis as any).__COOPT_MTF_PLOT_POINT_COUNT)
        : NaN;
    const plotPointCountCandidate = Math.floor(safeNumber(plotPointCount, plotPointCountFromGlobal));
    const resolvedPlotPointCount = clamp(
        Number.isFinite(plotPointCountCandidate) ? plotPointCountCandidate : 121,
        5,
        2001
    );

    const primaryWl = (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function')
        ? Number(window.getPrimaryWavelength())
        : NaN;
    const effectiveOpdDisplayMode = (typeof opdDisplayMode === 'string' && opdDisplayMode)
        ? opdDisplayMode
        : 'pistonTiltRemoved';

    const isAllWavelengths = (typeof wavelengthMicrons === 'string')
        ? (String(wavelengthMicrons).toLowerCase() === 'all')
        : false;

    if ((isAllWavelengths || !Number.isFinite(Number(wavelengthMicrons))) && !(Number.isFinite(primaryWl) && primaryWl > 0)) {
        throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
    }
    const wl = isAllWavelengths ? primaryWl : safeNumber(wavelengthMicrons, primaryWl);
    const objIndex = Number.isFinite(Number(objectIndex)) ? Math.max(0, Math.floor(Number(objectIndex))) : 0;
    const maxLpmm = Math.max(0, safeNumber(maxFrequencyLpmm, 100));

    const isPowerOfTwo = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
    const nextPowerOfTwo = (n) => {
        let p = 1;
        const target = Math.max(1, Math.floor(Number(n) || 1));
        while (p < target && p < 4096) p <<= 1;
        return p;
    };
    // samplingSize is the FFT grid size (NxN). Legacy samplingPoints is treated as alias when it looks like a valid grid size.
    const samplingCandidate = Math.floor(safeNumber(samplingSize, NaN));
    const legacyCandidate = Math.floor(safeNumber(samplingPoints, NaN));
    const gridCandidate = Number.isFinite(samplingCandidate) ? samplingCandidate : legacyCandidate;
    const gridSize = isPowerOfTwo(gridCandidate) ? clamp(gridCandidate, 32, 4096) : 256;
    const zeroPadCandidate = Math.floor(safeNumber(zeroPadTo, NaN));
    const hasExplicitZeroPad = Number.isFinite(zeroPadCandidate) && zeroPadCandidate >= gridSize && isPowerOfTwo(zeroPadCandidate);
    const explicitZeroPadTo = hasExplicitZeroPad
        ? clamp(zeroPadCandidate, 32, 4096)
        : 0;

    const showDiffractionLimitEnabled = (typeof showDiffractionLimit === 'boolean')
        ? showDiffractionLimit
        : true;

    const shouldRenderPlot = !skipPlot;
    const resolveContainerElement = () => {
        if (containerElement) return containerElement;
        const byId = (id: string) => {
            try { return document.getElementById(id); } catch (_) { return null; }
        };
        return (
            byId('mtf-container')
            || byId('popup-mtf-container')
            || byId('popup-through-focus-mtf-container')
            || null
        );
    };
    let containerEl: any = resolveContainerElement();
    if (shouldRenderPlot && !containerEl) {
        try {
            if (!document?.body) throw new Error('document.body is unavailable');
            const autoId = 'mtf-container-auto';
            const existing = document.getElementById(autoId);
            containerEl = existing || document.createElement('div');
            if (!existing) {
                containerEl.id = autoId;
                containerEl.style.position = 'fixed';
                containerEl.style.right = '16px';
                containerEl.style.bottom = '16px';
                containerEl.style.width = '760px';
                containerEl.style.height = '520px';
                containerEl.style.background = '#ffffff';
                containerEl.style.border = '1px solid #d0d0d0';
                containerEl.style.boxShadow = '0 4px 16px rgba(0,0,0,0.15)';
                containerEl.style.zIndex = '99999';
                containerEl.style.borderRadius = '6px';
                document.body.appendChild(containerEl);
            }
            ensureConsoleLog('⚠️ MTF container not found. Auto-created #mtf-container-auto for plotting.');
        } catch (_) {
            throw new Error('MTF container element not found');
        }
    }
    if (shouldRenderPlot) {
        try { containerEl.innerHTML = ''; } catch (_) {}
    }

    reportProgress(0, 'Starting...');

    reportProgress(2, 'Checking WASM readiness...');
    const g: any = (typeof globalThis !== 'undefined') ? globalThis : null;
    await ensureMtfWasmReady();
    const prevGlobalStrict = isRayTracingWasmStrict();
    const forceStrictByFlag = !!(g && g.__COOPT_MTF_WASM_STRICT === true);
    // Default: keep compatibility mode unless explicitly forced by runtime flag.
    setRayTracingWasmStrict(forceStrictByFlag);

    const withForcedInfinitePupilMode = async (mode, fn) => {
        if (!g) return await fn();
        const prev = g.__COOPT_FORCE_INFINITE_PUPIL_MODE;
        try {
            if (mode === undefined || mode === null || mode === '') {
                try { delete g.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { g.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
            } else {
                g.__COOPT_FORCE_INFINITE_PUPIL_MODE = mode;
            }
            return await fn();
        } finally {
            if (prev === undefined || prev === null) {
                try { delete g.__COOPT_FORCE_INFINITE_PUPIL_MODE; } catch (_) { g.__COOPT_FORCE_INFINITE_PUPIL_MODE = undefined; }
            } else {
                g.__COOPT_FORCE_INFINITE_PUPIL_MODE = prev;
            }
        }
    };

    const sanitizePupilMode = (value: any): 'stop' | 'entrance' | '' => {
        const s = (typeof value === 'string') ? value.trim().toLowerCase() : '';
        return (s === 'stop' || s === 'entrance') ? s : '';
    };

    const getForcedInfinitePupilMode = (): 'stop' | 'entrance' | '' => {
        try {
            const fromGlobal = sanitizePupilMode(g?.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? g?.COOPT_FORCE_INFINITE_PUPIL_MODE);
            if (fromGlobal) return fromGlobal;
        } catch (_) {}
        try {
            return sanitizePupilMode(localStorage.getItem('coopt.forceInfinitePupilMode'));
        } catch (_) {
            return '';
        }
    };

    const resolveRequestedPupilSamplingMode = (customFieldSetting: any): { mode: 'stop' | 'entrance' | undefined; forced: boolean } => {
        const forcedMode = getForcedInfinitePupilMode();
        if (forcedMode === 'stop' || forcedMode === 'entrance') {
            return { mode: forcedMode, forced: true };
        }

        const typeLower = String(customFieldSetting?.type || '').trim().toLowerCase();
        const fx = Number(customFieldSetting?.fieldAngle?.x ?? 0);
        const fy = Number(customFieldSetting?.fieldAngle?.y ?? 0);
        const isNonZeroAngleField = Math.abs(fx) > 1e-12 || Math.abs(fy) > 1e-12;
        // Auto: use entrance only for non-zero angle fields; otherwise defer to analyzer default.
        const autoMode = (typeLower === 'angle' && isNonZeroAngleField) ? 'entrance' : undefined;
        return { mode: autoMode, forced: false };
    };

    try {

    // Prefer Plotly from the container's window (popup), fallback to opener.
    const plotly = shouldRenderPlot
        ? (containerEl?.ownerDocument?.defaultView?.Plotly || (typeof window !== 'undefined' ? window.Plotly : null))
        : null;
    if (shouldRenderPlot && !plotly) {
        throw new Error('Plotly is not available');
    }

    reportProgress(5, 'Loading modules...');

    // Dynamic imports (reuse the same infra as PSF)
    const { createOPDCalculator } = await import('./wavefront/wavefront.js');
    const { WavefrontAberrationAnalyzer } = await import('./wavefront/wavefront.js');
    const { SimpleFFT } = await import('./psf/psf-calculator.js');
    const { derivePupilAndFocalLengthMmFromParaxial } = await import('./spot-diagram.js');

    reportProgress(10, 'Preparing optical system...');

    // Optical system and objects (use imported functions)
    const baseOpticalSystemRows = getOpticalSystemRows(window.tableOpticalSystem);
    const objects = getObjectRows(window.tableObject);
    const hasOverride = !!(objectOverride && typeof objectOverride === 'object');
    if (!hasOverride) {
        if (!objects || objects.length === 0) {
            throw new Error('オブジェクトデータがありません。まずオブジェクトを設定してください。');
        }
        if (objIndex >= objects.length) {
            throw new Error('指定されたオブジェクトが見つかりません。');
        }
    }

    const selectedObject = hasOverride ? objectOverride : objects[objIndex];
    const objectTypeRaw = String(selectedObject.position ?? selectedObject.object ?? selectedObject.Object ?? selectedObject.objectType ?? 'Point');
    const objectTypeLower = objectTypeRaw.toLowerCase();
    const isAngleType = /\bangle\b/.test(objectTypeLower);
    
    // 🔍 DEBUG: Log objectOverride being received to diagnose cache reuse
    ensureConsoleLog(`📥 [MTF] showMTFDiagram called with objectOverride:`, {
        hasOverride,
        objectOverride: objectOverride ? { x: objectOverride.x, y: objectOverride.y, xHeightAngle: objectOverride.xHeightAngle, yHeightAngle: objectOverride.yHeightAngle, position: objectOverride.position } : null,
        selectedObject: { position: selectedObject.position, x: selectedObject.x, y: selectedObject.y, xHeightAngle: selectedObject.xHeightAngle, yHeightAngle: selectedObject.yHeightAngle },
        defocusShiftMm,
        callStack: 'showMTFDiagram'
    });
    
    // Determine finite/infinite based on ObjectSurface (Priority 1)
    // If ObjectSurface is finite, always use finite solver regardless of field type
    // If infinite, always stay infinite even with Height fields (cannot use finite solver without finite object surface)
    let isFiniteObject = false;
    try {
        const firstSurf = baseOpticalSystemRows && baseOpticalSystemRows.length > 0 ? baseOpticalSystemRows[0] : null;
        if (firstSurf) {
            const thickness = firstSurf.thickness ?? firstSurf.Thickness;
            const isInf = thickness === 'INF' || thickness === Infinity;
            if (!isInf) {
                const numThickness = parseFloat(thickness);
                if (Number.isFinite(numThickness) && numThickness > 0) {
                    isFiniteObject = true;
                }
            }
        }
    } catch (_) {}
    
    // Column priority: Angle→xHeightAngle/yHeightAngle, Height/Rectangle→x/y or xHeight/yHeight
    const objectX = isAngleType
        ? (selectedObject.xHeightAngle ?? selectedObject.x ?? 0)
        : (selectedObject.x ?? selectedObject.xHeight ?? selectedObject.xHeightAngle ?? 0);
    const objectY = isAngleType
        ? (selectedObject.yHeightAngle ?? selectedObject.y ?? 0)
        : (selectedObject.y ?? selectedObject.yHeight ?? selectedObject.yHeightAngle ?? 0);
    
    ensureConsoleLog(`🔍 [TFMTF Setup] Object ${objIndex}: type="${objectTypeRaw}", isAngleType=${isAngleType}, isFiniteObject=${isFiniteObject}, objectX=${objectX.toFixed(4)}, objectY=${objectY.toFixed(4)}, defocusShift=${defocusShiftMm} mm`);

    const opticalSystemRows = cloneOpticalSystemRowsWithDefocusShift(baseOpticalSystemRows, defocusShiftMm, isFiniteObject);
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        throw new Error('光学システムデータがありません。まず光学システムを設定してください。');
    }

    let fieldAngle = { x: 0, y: 0 };
    let xHeight = 0;
    let yHeight = 0;
    if (/\bangle\b/.test(objectTypeLower)) {
        fieldAngle = { x: safeNumber(objectX, 0), y: safeNumber(objectY, 0) };
    } else {
        xHeight = safeNumber(objectX, 0);
        yHeight = safeNumber(objectY, 0);
    }

    ensureConsoleLog(`🔍 [TFMTF Field] fieldAngle={${fieldAngle.x}, ${fieldAngle.y}}, xHeight=${xHeight.toFixed(4)}, yHeight=${yHeight.toFixed(4)}`);

    // Meridional/Sagittal: without directional interpolation, choose the nearest principal axis
    // based on field direction (x-dominant => meridional=x, otherwise meridional=y).
    const fieldVecRaw = (/\bangle\b/.test(objectTypeLower))
        ? { x: safeNumber(fieldAngle?.x, 0), y: safeNumber(fieldAngle?.y, 0) }
        : { x: safeNumber(xHeight, 0), y: safeNumber(yHeight, 0) };

    let tdx = fieldVecRaw.x;
    let tdy = fieldVecRaw.y;
    if (!(Math.abs(tdx) > 0 || Math.abs(tdy) > 0)) {
        tdx = 1;
        tdy = 0;
    }
    const tanAxis = (Math.abs(tdx) >= Math.abs(tdy)) ? 'x' : 'y';
    const sagAxis = (tanAxis === 'x') ? 'y' : 'x';

    const psfCalculator = await getPSFCalculatorSingleton();

    const getAllWavelengths = () => {
        try {
            const sources = getSourceRows(window.tableSource);
            const wls = [];
            for (let i = 0; i < (Array.isArray(sources) ? sources.length : 0); i++) {
                const w = Number(sources[i]?.wavelength);
                if (!Number.isFinite(w) || w <= 0) continue;
                wls.push(w);
            }
            return wls;
        } catch (_) {
            return [];
        }
    };

    const wavelengthsToPlot = isAllWavelengths ? getAllWavelengths() : [wl];
    const uniqueWavelengths = Array.from(new Set(wavelengthsToPlot.map(w => Number(w)).filter(w => Number.isFinite(w) && w > 0)));
    if (uniqueWavelengths.length === 0) {
        if (Number.isFinite(primaryWl) && primaryWl > 0) uniqueWavelengths.push(primaryWl);
        else throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
    }

    const traces = [];
    let maxPlotLpmmGlobal = 0;
    const frequencyLimitNotes = new Set<string>();

    const interpolateCurveY = (xVals: number[], yVals: any[], x: number) => {
        if (!Array.isArray(xVals) || !Array.isArray(yVals) || xVals.length === 0 || yVals.length !== xVals.length) return null;
        if (!Number.isFinite(x)) return null;
        const last = xVals.length - 1;
        const x0 = Number(xVals[0]);
        const xLast = Number(xVals[last]);
        if (!Number.isFinite(x0) || !Number.isFinite(xLast)) return null;
        if (x <= x0) {
            const y = Number(yVals[0]);
            return Number.isFinite(y) ? y : null;
        }
        if (x >= xLast) {
            const y = Number(yVals[last]);
            return Number.isFinite(y) ? y : null;
        }
        for (let i = 1; i < xVals.length; i++) {
            const xa = Number(xVals[i - 1]);
            const xb = Number(xVals[i]);
            if (!Number.isFinite(xa) || !Number.isFinite(xb) || xb <= xa) continue;
            if (x <= xb) {
                const ya = Number(yVals[i - 1]);
                const yb = Number(yVals[i]);
                if (!Number.isFinite(ya) || !Number.isFinite(yb)) return null;
                const t = (x - xa) / (xb - xa);
                return ya + t * (yb - ya);
            }
        }
        return null;
    };

    const resampleCurveToRange = (curve, axisMaxLpmm: number, pointCount: number) => {
        if (!curve || !Array.isArray(curve.freq) || !Array.isArray(curve.mtfVals)) return curve;
        const srcX = curve.freq.map((v: any) => Number(v));
        const srcY = curve.mtfVals;
        if (srcX.length === 0 || srcY.length !== srcX.length) return curve;
        const targetMax = Number(axisMaxLpmm);
        if (!Number.isFinite(targetMax) || targetMax <= 0) return curve;

        const count = Math.max(2, Math.floor(Number(pointCount) || 2));
        const outX: number[] = [];
        const outY: any[] = [];
        const srcMax = Number(srcX[srcX.length - 1]);

        for (let i = 0; i < count; i++) {
            const t = (count <= 1) ? 0 : (i / (count - 1));
            const x = targetMax * t;
            outX.push(x);
            if (Number.isFinite(srcMax) && x > srcMax + 1e-12) {
                outY.push(0);
            } else {
                const y = interpolateCurveY(srcX, srcY, x);
                outY.push(Number.isFinite(Number(y)) ? Number(y) : null);
            }
        }

        if (outY.length > 0) outY[0] = 1.0;
        return { freq: outX, mtfVals: outY };
    };

    const computeCircularApertureDiffractionMtf = (freqLpmm, wavelengthMicron, fNumber) => {
        const f = Number(freqLpmm);
        const wlUm = Number(wavelengthMicron);
        const fno = Number(fNumber);
        if (!Number.isFinite(f) || f < 0) return null;
        if (!Number.isFinite(wlUm) || wlUm <= 0) return null;
        if (!Number.isFinite(fno) || fno <= 0) return null;

        const cutoffLpmm = 1000.0 / (wlUm * fno);
        if (!Number.isFinite(cutoffLpmm) || cutoffLpmm <= 0) return null;

        const nu = f / cutoffLpmm;
        if (!Number.isFinite(nu)) return null;
        if (nu >= 1) return 0;
        if (nu <= 0) return 1;

        const clamped = Math.max(-1, Math.min(1, nu));
        const val = (2 / Math.PI) * (Math.acos(clamped) - clamped * Math.sqrt(Math.max(0, 1 - clamped * clamped)));
        return Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : null;
    };

    const computeForWavelength = async (wlLocal, idx, total) => {
        const wlProgressBase = 10;
        const wlProgressSpan = 85;
        const localBase = wlProgressBase + (idx * wlProgressSpan / Math.max(1, total));
        const localSpan = wlProgressSpan / Math.max(1, total);

        const fieldSetting = {
            objectIndex: objIndex,
            type: objectTypeRaw,
            fieldAngle,
            xHeight,
            yHeight,
            wavelength: wlLocal
        };
        
        ensureConsoleLog(`🔍 [MTF Field] CACHE KEY INPUTS for wavelength ${(wlLocal*1000).toFixed(1)}nm:`);
        ensureConsoleLog(`   fieldAngle.x=${fieldSetting.fieldAngle.x.toFixed(4)}, fieldAngle.y=${fieldSetting.fieldAngle.y.toFixed(4)}`);
        ensureConsoleLog(`   xHeight=${fieldSetting.xHeight.toFixed(4)},  yHeight=${fieldSetting.yHeight.toFixed(4)}`);
        ensureConsoleLog(`   type="${fieldSetting.type}"`);


        const samplingSizeForPSF = gridSize;

        const opdCalculator = createOPDCalculator(opticalSystemRows, wlLocal);
        const analyzer = new WavefrontAberrationAnalyzer(opdCalculator);

        const titleNmLocal = (wlLocal * 1000).toFixed(1);
        reportProgress(localBase, `λ=${titleNmLocal} nm: Generating wavefront...`);

        const onWavefrontProgress = (evt) => {
            try {
                const p = Number(evt?.percent);
                const msg = evt?.message || evt?.phase || 'Generating wavefront...';
                if (Number.isFinite(p)) {
                    reportProgress(localBase + (p / 100) * (localSpan * 0.55), `λ=${titleNmLocal} nm: ${msg}`);
                } else {
                    reportProgress(undefined, `λ=${titleNmLocal} nm: ${msg}`);
                }
            } catch (_) {}
        };

        const generateWavefrontMapForMode = async (mode, customFieldSetting = fieldSetting) => {
            return await withForcedInfinitePupilMode(mode, async () => {
                ensureConsoleLog(`🔍 [Wavefront] Calling generateWavefrontMap with customFieldSetting:`, customFieldSetting);
                const result = await analyzer.generateWavefrontMap(customFieldSetting, samplingSizeForPSF, 'circular', {
                    recordRays: false,
                    progressEvery: 512,
                    profile: enableMtfProfileLog,
                    suppressReferenceRayError: true,
                    zernikeMaxNoll: 37,
                    renderFromZernike: false,
                    skipZernikeFit: true,
                    wasmFastOnly: useWasmFastOnly,
                    traceOptions: useWasmFastOnly ? { requireWasmRayTracing: true, allowNonStrict: false } : null,
                    opdMode: 'simple',
                    opdDisplayMode: effectiveOpdDisplayMode,
                    onProgress: onWavefrontProgress,
                    useCache: false  // ✅ Disable cache to force new OPD computation per field/defocus
                });
                // 🔍 Compute simple checksum of OPD grid to verify it's different for each field/defocus
                if (result?.opdGrid) {
                    const grid = result.opdGrid;
                    let sum = 0;
                    const stride = Math.max(1, Math.floor(grid.length / 100));  // Sample every Nth element
                    for (let i = 0; i < grid.length; i += stride) {
                        sum += Math.abs(grid[i] || 0);
                    }
                    const checksum = (sum % 10000).toFixed(0);
                    ensureConsoleLog(`✅ [Wavefront] generateWavefrontMap completed: gridSize=${result?.gridSize}, OPD_CHECKSUM=${checksum}, fieldSetting.xHeight=${customFieldSetting.xHeight}, fieldSetting.yHeight=${customFieldSetting.yHeight}`);
                } else {
                    ensureConsoleLog(`✅ [Wavefront] generateWavefrontMap completed: no OPD grid`);
                }
                return result;
            });
        };

        const shouldRetryWithStop = (message) => /entrance.*fail|entrance pupil|entrance unreachable/i.test(String(message || ''));

        const runWavefrontAttempt = async (mode, customFieldSetting = fieldSetting, strictMode = true) => {
            const prevStrict = isRayTracingWasmStrict();
            try {
                if (!strictMode) {
                    setRayTracingWasmStrict(false);
                }
                const map = await generateWavefrontMapForMode(mode, customFieldSetting);
                if (map?.error) {
                    return { map: null, error: String(map.error?.message || 'Wavefront generation failed') };
                }
                return { map, error: '' };
            } catch (error) {
                return { map: null, error: String(error?.message || error || 'Wavefront generation failed') };
            } finally {
                if (!strictMode) {
                    setRayTracingWasmStrict(prevStrict);
                }
            }
        };

        let wavefrontMap = null;
        const errors = [];

        // 1) Primary mode from Settings (Force stop/entrance or Auto)
        const requested = resolveRequestedPupilSamplingMode(fieldSetting);
        const primaryMode = requested.mode;
        const primaryLabel = primaryMode || 'auto';
        const primaryAttempt = await runWavefrontAttempt(primaryMode, fieldSetting, true);
        if (primaryAttempt.map) {
            wavefrontMap = primaryAttempt.map;
            console.log(`✅ [TFMTF Pupil] Primary mode succeeded: ${primaryLabel}${requested.forced ? ' (forced)' : ''}`);
        } else {
            errors.push(`${primaryLabel}=${primaryAttempt.error}`);
            console.warn(`⚠️ [TFMTF Pupil] Primary mode failed: ${primaryLabel} (${primaryAttempt.error})`);
        }

        // 2) Fallback mode only when not forced
        if (!wavefrontMap && !requested.forced) {
            const fallbackModes: Array<'entrance' | 'stop'> = [];
            if (primaryMode === 'entrance') fallbackModes.push('stop');
            else if (primaryMode === 'stop') fallbackModes.push('entrance');
            else fallbackModes.push('entrance', 'stop');

            for (const fallbackMode of fallbackModes) {
                if (!shouldRetryWithStop(primaryAttempt.error) && primaryMode === 'entrance' && fallbackMode === 'stop') {
                    continue;
                }
                reportProgress(localBase + localSpan * 0.10, `λ=${titleNmLocal} nm: Retrying with ${fallbackMode} mode...`);
                const fallbackAttempt = await runWavefrontAttempt(fallbackMode, fieldSetting, true);
                if (fallbackAttempt.map) {
                    wavefrontMap = fallbackAttempt.map;
                    break;
                }
                errors.push(`${fallbackMode}=${fallbackAttempt.error}`);
            }
        }

        // 3) Last resort for on-axis: treat as finite-height field (object at (0,0) height)
        if (!wavefrontMap) {
            const onAxis = Math.abs(Number(fieldAngle?.x || 0)) < 1e-12
                && Math.abs(Number(fieldAngle?.y || 0)) < 1e-12
                && Math.abs(Number(xHeight || 0)) < 1e-12
                && Math.abs(Number(yHeight || 0)) < 1e-12;
            if (onAxis) {
                reportProgress(localBase + localSpan * 0.14, `λ=${titleNmLocal} nm: Retrying with finite on-axis field...`);
                const finiteFieldSetting = {
                    ...fieldSetting,
                    type: 'Height',
                    fieldAngle: { x: 0, y: 0 },
                    xHeight: 0,
                    yHeight: 0,
                    forceFinite: true
                };

                const finiteRequested = resolveRequestedPupilSamplingMode(finiteFieldSetting);
                const finitePrimary = finiteRequested.mode;
                const finitePrimaryLabel = finitePrimary || 'auto';

                const finitePrimaryAttempt = await runWavefrontAttempt(finitePrimary, finiteFieldSetting, true);
                if (finitePrimaryAttempt.map) {
                    wavefrontMap = finitePrimaryAttempt.map;
                } else {
                    errors.push(`finite-${finitePrimaryLabel}=${finitePrimaryAttempt.error}`);
                    if (!finiteRequested.forced) {
                        const finiteFallbackModes: Array<'entrance' | 'stop'> = [];
                        if (finitePrimary === 'entrance') finiteFallbackModes.push('stop');
                        else if (finitePrimary === 'stop') finiteFallbackModes.push('entrance');
                        else finiteFallbackModes.push('entrance', 'stop');

                        for (const fallbackMode of finiteFallbackModes) {
                            const finiteFallbackAttempt = await runWavefrontAttempt(fallbackMode, finiteFieldSetting, true);
                            if (finiteFallbackAttempt.map) {
                                wavefrontMap = finiteFallbackAttempt.map;
                                break;
                            }
                            errors.push(`finite-${fallbackMode}=${finiteFallbackAttempt.error}`);
                        }
                    }
                }
            }
        }

        // 4) Compatibility rescue: keep WASM initialized, but relax strict no-fallback rule
        // only when strict sampling produced zero valid OPD points.
        if (!wavefrontMap) {
            const joinedErrors = errors.join('; ');
            const looksStrictSamplingCollapse = /No valid OPD samples|trace to eval failed/i.test(joinedErrors);
            if (looksStrictSamplingCollapse) {
                reportProgress(localBase + localSpan * 0.18, `λ=${titleNmLocal} nm: Retrying with compatibility ray tracing...`);
                const compatRequested = resolveRequestedPupilSamplingMode(fieldSetting);
                const compatPrimary = compatRequested.mode;
                const compatPrimaryLabel = compatPrimary || 'auto';

                const compatPrimaryAttempt = await runWavefrontAttempt(compatPrimary, fieldSetting, false);
                if (compatPrimaryAttempt.map) {
                    wavefrontMap = compatPrimaryAttempt.map;
                } else {
                    errors.push(`compat-${compatPrimaryLabel}=${compatPrimaryAttempt.error}`);
                    if (!compatRequested.forced) {
                        const compatFallbackModes: Array<'entrance' | 'stop'> = [];
                        if (compatPrimary === 'entrance') compatFallbackModes.push('stop');
                        else if (compatPrimary === 'stop') compatFallbackModes.push('entrance');
                        else compatFallbackModes.push('entrance', 'stop');

                        for (const fallbackMode of compatFallbackModes) {
                            const compatFallbackAttempt = await runWavefrontAttempt(fallbackMode, fieldSetting, false);
                            if (compatFallbackAttempt.map) {
                                wavefrontMap = compatFallbackAttempt.map;
                                break;
                            }
                            errors.push(`compat-${fallbackMode}=${compatFallbackAttempt.error}`);
                        }
                    }
                }
            }
        }

        if (!wavefrontMap) {
            throw new Error(errors.join('; ') || 'Wavefront generation failed');
        }

        reportProgress(localBase + localSpan * 0.60, `λ=${titleNmLocal} nm: Building OPD grid...`);

        // Re-grid sampled wavefront values into an NxN OPD grid for PSF/MTF.
        const s = Math.max(16, Math.floor(Number(samplingSizeForPSF)));
        const opdGrid = Array.from({ length: s }, () => new Float32Array(s));
        const ampGrid = Array.from({ length: s }, () => new Float32Array(s));
        
        console.log(`🔍 [TFMTF OPD] Building ${s}x${s} OPD grid from wavefront map...`);
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
        const useDisplayOpd = (effectiveOpdDisplayMode !== 'raw') && Array.isArray(wavefrontMap?.display?.opds);
        const opdMicrons = useDisplayOpd
            ? wavefrontMap.display.opds
            : (Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds : []);
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

        const rayData = [];
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

        const opdData = {
            gridSize: s,
            wavelength: wlLocal,
            rayData,
            gridData: {
                opd: opdGrid,
                amplitude: ampGrid,
                pupilMask: maskGrid,
                xCoords,
                yCoords
            }
        };

        // Base image-plane pitch from paraxial scale (used as fallback/debug only).
        // Final pitch for MTF axis must include pupil-grid -> FFT-size scaling (Npupil/Nfft),
        // which is handled inside PSFCalculator when pixelSize is not forced.
        const preferEntrancePupilForMTF = /\bangle\b/.test(objectTypeLower);
        const derivedMTFScale = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, wlLocal, preferEntrancePupilForMTF);
        const pupilDiameterMm = derivedMTFScale.pupilDiameterMm;
        const focalLengthMm = derivedMTFScale.focalLengthMm;

        const basePixelSizeMicronsForMTF = (pupilDiameterMm > 0)
            ? (wlLocal * focalLengthMm / pupilDiameterMm)
            : 1.0;
        const imageSpaceDiffraction = calculateImageSpaceDiffractionParams(opticalSystemRows, wlLocal);
        const fNumberForDiffraction = Number(imageSpaceDiffraction?.fNumberWorking);

        const desiredBinCount = Math.max(2, resolvedPlotPointCount);
        // Keep MTF numerics independent of Max(lp/mm): Max should crop display range only.
        // N/2 + 1 bins exist up to Nyquist, so require N >= 2*(desiredBinCount-1).
        const minRequiredNForBins = Math.max(gridSize, 2 * (desiredBinCount - 1));
        const adaptiveZeroPadToRaw = nextPowerOfTwo(minRequiredNForBins);
        const adaptiveZeroPadTo = (adaptiveZeroPadToRaw > gridSize)
            ? clamp(adaptiveZeroPadToRaw, 32, 4096)
            : 0;
        let effectiveZeroPadTo = hasExplicitZeroPad
            ? explicitZeroPadTo
            : adaptiveZeroPadTo;

        // Safety fallback: with 32x32 and explicit "none" (zeroPadTo==sampling),
        // MTF can become numerically unstable or too sparse for plotting in some systems.
        // Promote to 64x64 only for this narrow edge case.
        if (hasExplicitZeroPad && explicitZeroPadTo === gridSize && gridSize <= 32) {
            effectiveZeroPadTo = 64;
            console.warn('⚠️ MTF: sampling 32 with zero-pad none is unstable; promoted FFT size to 64 for robust plotting.');
        }

        reportProgress(localBase + localSpan * 0.75, `λ=${titleNmLocal} nm: Calculating PSF...`);
        const psfResult = await psfCalculator.calculatePSF(opdData, {
            samplingSize: s,
            zeroPadTo: effectiveZeroPadTo,
            pupilDiameter: pupilDiameterMm,
            focalLength: focalLengthMm,
            // Do not force pixelSize: PSFCalculator must apply Npupil/Nfft scaling
            // to keep lp/mm axis physically consistent across sampling/zero-padding.
            pixelSize: null,
            forceImplementation: useLegacyBaselineMode ? null : 'javascript',
            // OPD grid is already piston+tilt removed by opdDisplayMode.
            removeTilt: false
        });

        if (!useLegacyBaselineMode && String(psfResult?.implementationUsed || '').toLowerCase() !== 'javascript') {
            console.warn('⚠️ MTF PSF path expected JavaScript (for zero-padding), but got a different implementation.');
        }

        reportProgress(localBase + localSpan * 0.85, `λ=${titleNmLocal} nm: Computing OTF/MTF...`);

        const psf2D = psfResult?.psfData || psfResult?.psf || psfResult?.intensity || null;
        const pixelSizeMicrons = useLegacyBaselineMode
            ? safeNumber(psfResult?.options?.pixelSize, safeNumber(basePixelSizeMicronsForMTF, 1.0))
            : safeNumber(psfResult?.options?.pixelSize, safeNumber(basePixelSizeMicronsForMTF, 1.0));
        if (!psf2D || !Array.isArray(psf2D) || !Array.isArray(psf2D[0])) {
            throw new Error('PSF data missing for MTF');
        }
        const N = psf2D.length;
        if (N < 2 || psf2D[0].length !== N) {
            throw new Error('PSF grid must be NxN');
        }

        console.log(`🔍 [TFMTF PSF] PSF grid: ${N}x${N}, pixelSize=${pixelSizeMicrons.toFixed(6)}µm`);

        const dfCyclesPerMicron = 1.0 / (N * pixelSizeMicrons);
        const dfLpmm = dfCyclesPerMicron * 1000.0;
        const nyquistLpmm = 0.5 / pixelSizeMicrons * 1000.0;
        const requestedPlotLpmm = (maxLpmm > 0) ? maxLpmm : nyquistLpmm;
        maxPlotLpmmGlobal = Math.max(maxPlotLpmmGlobal, requestedPlotLpmm);

        const maxBin = Math.floor(N / 2);
        const kDataMax = Math.max(0, Math.min(maxBin, Math.floor(nyquistLpmm / (dfLpmm || 1e-9))));
        const freqData = Array.from({ length: kDataMax + 1 }, (_, k) => k * dfLpmm);

        if (maxLpmm > 0 && requestedPlotLpmm > nyquistLpmm + 1e-9) {
            const note = `Requested Max(lp/mm)=${requestedPlotLpmm.toFixed(2)} exceeds Nyquist=${nyquistLpmm.toFixed(2)} at λ=${titleNmLocal}nm. Data beyond Nyquist is zero-filled.`;
            frequencyLimitNotes.add(note);
            console.warn(`⚠️ [MTF] ${note}`);
        }

        const psfFlat = new Float64Array(N * N);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                psfFlat[y * N + x] = safeNumber(psf2D[y]?.[x], 0);
            }
        }

        const wasmMTFFn = useLegacyBaselineMode
            ? null
            : psfCalculator?.wasmCalculator?.calculateMTFAxesFromPSF;
        let tan: { freq: number[]; mtfVals: any[] } | null = null;
        let sag: { freq: number[]; mtfVals: any[] } | null = null;

        if (!useLegacyBaselineMode && isTauriRuntime()) {
            try {
                const nativePoints = Math.max(2, Math.min(1024, resolvedPlotPointCount));
                const nativeResp = await runNativeMtfMap({
                    psfData: psf2D,
                    pixelSizeUm: pixelSizeMicrons,
                    maxFrequencyLpmm: requestedPlotLpmm,
                    points: nativePoints,
                } as any);

                const freq = Array.isArray(nativeResp?.frequencyAxis) ? nativeResp.frequencyAxis : [];
                const nativeTan = Array.isArray(nativeResp?.mtfTangential) ? nativeResp.mtfTangential : [];
                const nativeSag = Array.isArray(nativeResp?.mtfSagittal) ? nativeResp.mtfSagittal : [];
                if (freq.length > 1 && nativeTan.length === freq.length && nativeSag.length === freq.length) {
                    // Rust path defines: x-axis=sagittal, y-axis=tangential.
                    // Align to local tangential/sagittal axis selection used by analysis MTF.
                    const tanVals = (tanAxis === 'x') ? nativeSag : nativeTan;
                    const sagVals = (sagAxis === 'x') ? nativeSag : nativeTan;

                    tan = {
                        freq: Array.from(freq, (v: any) => Number(v)),
                        mtfVals: Array.from(tanVals, (v: any) => Number.isFinite(Number(v)) ? Number(v) : null)
                    };
                    sag = {
                        freq: Array.from(freq, (v: any) => Number(v)),
                        mtfVals: Array.from(sagVals, (v: any) => Number.isFinite(Number(v)) ? Number(v) : null)
                    };
                    if (tan.mtfVals.length > 0) tan.mtfVals[0] = 1.0;
                    if (sag.mtfVals.length > 0) sag.mtfVals[0] = 1.0;
                }
            } catch (nativeMtfErr) {
                console.warn('⚠️ Native Rust MTF extraction failed; falling back to JS/WASM path.', nativeMtfErr);
                tan = null;
                sag = null;
            }
        }

        if ((!tan || !sag) && typeof wasmMTFFn === 'function') {
            try {
                const axes = wasmMTFFn.call(psfCalculator.wasmCalculator, psfFlat, N, kDataMax);
                if (axes?.xAxis && axes?.yAxis) {
                    const tanVals = (tanAxis === 'x') ? axes.xAxis : axes.yAxis;
                    const sagVals = (sagAxis === 'x') ? axes.xAxis : axes.yAxis;
                    tan = {
                        freq: freqData,
                        mtfVals: Array.from(tanVals, (v: number) => Number.isFinite(v) ? v : null)
                    };
                    sag = {
                        freq: freqData,
                        mtfVals: Array.from(sagVals, (v: number) => Number.isFinite(v) ? v : null)
                    };
                    if (tan.mtfVals.length > 0) tan.mtfVals[0] = 1.0;
                    if (sag.mtfVals.length > 0) sag.mtfVals[0] = 1.0;
                }
            } catch (_) {
                tan = null;
                sag = null;
            }
        }

        if (!tan || !sag) {
            const real = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => psfFlat[y * N + x]));
            const imag = Array.from({ length: N }, () => Array.from({ length: N }, () => 0));
            const otf = SimpleFFT.fft2D(real, imag);
            const dcRe = safeNumber(otf?.real?.[0]?.[0], 0);
            const dcIm = safeNumber(otf?.imag?.[0]?.[0], 0);
            const dcMag = Math.hypot(dcRe, dcIm);
            if (!Number.isFinite(dcMag) || dcMag <= 0) {
                throw new Error('Invalid OTF DC component');
            }

            const sample1DAxis = (axis) => {
            const freqAxis = [];
            const mtfVals = [];
            for (let k = 0; k <= kDataMax; k++) {
                const f = k * dfLpmm;
                let re = 0;
                let im = 0;
                if (axis === 'x') {
                    re = safeNumber(otf.real?.[0]?.[k], 0);
                    im = safeNumber(otf.imag?.[0]?.[k], 0);
                } else {
                    re = safeNumber(otf.real?.[k]?.[0], 0);
                    im = safeNumber(otf.imag?.[k]?.[0], 0);
                }
                const mtf = Math.hypot(re, im) / dcMag;
                freqAxis.push(f);
                mtfVals.push(Number.isFinite(mtf) ? mtf : null);
            }
            if (mtfVals.length > 0) mtfVals[0] = 1.0;
            return { freq: freqAxis, mtfVals };
        };
            tan = sample1DAxis(tanAxis);
            sag = sample1DAxis(sagAxis);
        }

        tan = resampleCurveToRange(tan, requestedPlotLpmm, resolvedPlotPointCount);
        sag = resampleCurveToRange(sag, requestedPlotLpmm, resolvedPlotPointCount);

        const color = getColorForWavelength(wlLocal);
        console.log(`🔍 [TFMTF MTF] λ=${titleNmLocal}nm: tan=${tan.freq.length}pts(${Math.min(...tan.mtfVals).toFixed(3)}-${Math.max(...tan.mtfVals).toFixed(3)}), sag=${sag.freq.length}pts(${Math.min(...sag.mtfVals).toFixed(3)}-${Math.max(...sag.mtfVals).toFixed(3)})`);
        
        traces.push({
            x: tan.freq,
            y: tan.mtfVals,
            type: 'scatter',
            mode: 'lines',
            name: `Tangential (${titleNmLocal}nm)`,
            showlegend: true,
            line: { color, width: 2, dash: 'solid' }
        });
        traces.push({
            x: sag.freq,
            y: sag.mtfVals,
            type: 'scatter',
            mode: 'lines',
            name: `Sagittal (${titleNmLocal}nm)`,
            showlegend: true,
            line: { color, width: 2, dash: 'dot' }
        });

        if (showDiffractionLimitEnabled) {
            let diffVals = null;

            try {
                const idealOpdGrid = Array.from({ length: s }, () => new Float32Array(s));
                const idealOpdData = {
                    gridSize: s,
                    wavelength: wlLocal,
                    gridData: {
                        opd: idealOpdGrid,
                        amplitude: ampGrid,
                        pupilMask: maskGrid,
                        xCoords,
                        yCoords
                    }
                };

                const idealPsfResult = await psfCalculator.calculatePSF(idealOpdData, {
                    samplingSize: s,
                    zeroPadTo: effectiveZeroPadTo,
                    pupilDiameter: pupilDiameterMm,
                    focalLength: focalLengthMm,
                    pixelSize: null,
                    forceImplementation: useLegacyBaselineMode ? null : 'javascript',
                    removeTilt: false
                });

                const idealPsf2D = idealPsfResult?.psfData || idealPsfResult?.psf || idealPsfResult?.intensity || null;
                if (idealPsf2D && Array.isArray(idealPsf2D) && Array.isArray(idealPsf2D[0])) {
                    const Nideal = idealPsf2D.length;
                    if (Nideal >= 2 && idealPsf2D[0].length === Nideal) {
                        const idealPixelSizeMicrons = safeNumber(
                            idealPsfResult?.options?.pixelSize,
                            safeNumber(pixelSizeMicrons, basePixelSizeMicronsForMTF)
                        );
                        const idealDfLpmm = (1.0 / (Nideal * idealPixelSizeMicrons)) * 1000.0;
                        const idealNyquistLpmm = (0.5 / idealPixelSizeMicrons) * 1000.0;
                        const idealMaxBin = Math.floor(Nideal / 2);
                        const idealKDataMax = Math.max(0, Math.min(idealMaxBin, Math.floor(idealNyquistLpmm / (idealDfLpmm || 1e-9))));
                        const idealFreqData = Array.from({ length: idealKDataMax + 1 }, (_, k) => k * idealDfLpmm);

                        const idealPsfFlat = new Float64Array(Nideal * Nideal);
                        for (let y = 0; y < Nideal; y++) {
                            for (let x = 0; x < Nideal; x++) {
                                idealPsfFlat[y * Nideal + x] = safeNumber(idealPsf2D[y]?.[x], 0);
                            }
                        }

                        let idealTan = null;
                        if (typeof wasmMTFFn === 'function') {
                            try {
                                const idealAxes = wasmMTFFn.call(psfCalculator.wasmCalculator, idealPsfFlat, Nideal, idealKDataMax);
                                if (idealAxes?.xAxis && idealAxes?.yAxis) {
                                    const idealTanVals = (tanAxis === 'x') ? idealAxes.xAxis : idealAxes.yAxis;
                                    idealTan = {
                                        freq: idealFreqData,
                                        mtfVals: Array.from(idealTanVals, (v: number) => Number.isFinite(v) ? v : null)
                                    };
                                    if (idealTan.mtfVals.length > 0) idealTan.mtfVals[0] = 1.0;
                                }
                            } catch (_) {
                                idealTan = null;
                            }
                        }

                        if (!idealTan) {
                            const realIdeal = Array.from({ length: Nideal }, (_, y) => Array.from({ length: Nideal }, (_, x) => idealPsfFlat[y * Nideal + x]));
                            const imagIdeal = Array.from({ length: Nideal }, () => Array.from({ length: Nideal }, () => 0));
                            const idealOtf = SimpleFFT.fft2D(realIdeal, imagIdeal);
                            const dcReIdeal = safeNumber(idealOtf?.real?.[0]?.[0], 0);
                            const dcImIdeal = safeNumber(idealOtf?.imag?.[0]?.[0], 0);
                            const dcMagIdeal = Math.hypot(dcReIdeal, dcImIdeal);

                            if (Number.isFinite(dcMagIdeal) && dcMagIdeal > 0) {
                                const idealMtfVals = [];
                                for (let k = 0; k <= idealKDataMax; k++) {
                                    let re = 0;
                                    let im = 0;
                                    if (tanAxis === 'x') {
                                        re = safeNumber(idealOtf.real?.[0]?.[k], 0);
                                        im = safeNumber(idealOtf.imag?.[0]?.[k], 0);
                                    } else {
                                        re = safeNumber(idealOtf.real?.[k]?.[0], 0);
                                        im = safeNumber(idealOtf.imag?.[k]?.[0], 0);
                                    }
                                    const mtf = Math.hypot(re, im) / dcMagIdeal;
                                    idealMtfVals.push(Number.isFinite(mtf) ? mtf : null);
                                }
                                if (idealMtfVals.length > 0) idealMtfVals[0] = 1.0;
                                idealTan = { freq: idealFreqData, mtfVals: idealMtfVals };
                            }
                        }

                        if (idealTan) {
                            const idealResampled = resampleCurveToRange(idealTan, requestedPlotLpmm, resolvedPlotPointCount);
                            if (idealResampled?.mtfVals && idealResampled.mtfVals.length === tan.freq.length) {
                                diffVals = idealResampled.mtfVals;
                            }
                        }
                    }
                }
            } catch (_) {
                diffVals = null;
            }

            if (!diffVals) {
                diffVals = tan.freq.map((f) => computeCircularApertureDiffractionMtf(f, wlLocal, fNumberForDiffraction));
            }

            traces.push({
                x: tan.freq,
                y: diffVals,
                type: 'scatter',
                mode: 'lines',
                name: `Diffraction Limit (${titleNmLocal}nm)`,
                showlegend: true,
                meta: { overlayType: 'diffractionLimit' },
                line: { color, width: 1.75, dash: 'dash' }
            });
        }
    };

    const totalWl = uniqueWavelengths.length;
    for (let i = 0; i < totalWl; i++) {
        await computeForWavelength(uniqueWavelengths[i], i, totalWl);
    }

    const titlePart = isAllWavelengths
        ? 'All wavelengths'
        : `${(wl * 1000).toFixed(1)} nm`;
    const xAxisMaxLpmm = (maxLpmm > 0) ? maxLpmm : (maxPlotLpmmGlobal || 0);

    const layout = {
        title: `Modulation Transfer Function (${titlePart}, Object ${objIndex})`,
        xaxis: { title: 'Spatial frequency (lp/mm)', range: [0, xAxisMaxLpmm] },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        margin: { l: 60, r: 20, t: 50, b: 50 }
    };

    if (frequencyLimitNotes.size > 0) {
        const warningText = Array.from(frequencyLimitNotes).join('<br>');
        (layout as any).annotations = [
            {
                xref: 'paper',
                yref: 'paper',
                x: 0,
                y: 1.08,
                xanchor: 'left',
                yanchor: 'bottom',
                align: 'left',
                showarrow: false,
                font: { size: 11, color: '#b45309' },
                text: `Calculation limit: ${warningText}`
            }
        ];
    }

    if (shouldRenderPlot) {
        reportProgress(95, 'Rendering plot...');
        await plotly.newPlot(containerEl, traces, layout, { responsive: true, displaylogo: false });
    }
    reportProgress(100, 'Done');
    console.log(`✅ [TFMTF COMPLETE] Returning ${traces.length} traces, maxPlotLpmm=${maxPlotLpmmGlobal.toFixed(1)}`);
    return { traces, layout, maxPlotLpmmGlobal};
    } finally {
        setRayTracingWasmStrict(prevGlobalStrict);
    }
}

async function showThroughFocusMTFDiagram({
    wavelengthMicrons,
    objectIndex,
    targetFrequencyLpmm,
    defocusMinMm,
    defocusMaxMm,
    steps,
    samplingSize,
    samplingPoints,
    zeroPadTo,
    containerElement,
    onProgress,
    opdDisplayMode
}: ThroughFocusMtfOptions = {}) {
    const safeNumber = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    const containerEl = containerElement || document.getElementById('mtf-container');
    if (!containerEl) {
        throw new Error('MTF container element not found');
    }
    try { containerEl.innerHTML = ''; } catch (_) {}

    const plotly = containerEl?.ownerDocument?.defaultView?.Plotly || (typeof window !== 'undefined' ? window.Plotly : null);
    if (!plotly) {
        throw new Error('Plotly is not available');
    }

    const reportProgress = (percent, message, trace, subMessage) => {
        try {
            if (typeof onProgress !== 'function') return;
            onProgress({ percent, message, trace, subMessage });
        } catch (_) {}
    };

    const minMm = safeNumber(defocusMinMm, -0.1);
    const maxMm = safeNumber(defocusMaxMm, 0.1);
    const nSteps = clamp(Math.floor(safeNumber(steps, 21)), 3, 201);
    // Freq (lp/mm)の初期値を10に
    const targetFreq = Math.max(0, safeNumber(targetFrequencyLpmm, 10));
    const samplingCandidate = Math.floor(safeNumber(samplingSize, safeNumber(samplingPoints, 256)));
    const sampling = Number.isFinite(samplingCandidate) && samplingCandidate > 0 ? samplingCandidate : 256;

    const defocusValues = Array.from({ length: nSteps }, (_, i) => {
        if (nSteps <= 1) return minMm;
        const t = i / (nSteps - 1);
        return minMm + t * (maxMm - minMm);
    });

    const traceMap = new Map();
    
    reportProgress(5, 'Initializing worker pool...', undefined, undefined);
    
    // Initialize worker pool for parallel MTF extraction
    let workerPool: TFMTFWorkerPool | null = null;
    let useWorkerPool = true;
    
    try {
        workerPool = await getGlobalTFMTFWorkerPool(4);
    } catch (error) {
        console.warn('⚠️ [TFMTF] Failed to initialize worker pool, falling back to sequential processing:', error);
        useWorkerPool = false;
    }

    // Collect PSF data from all defocus values using parallel batch processing
    reportProgress(10, 'Computing PSF for all defocus points...', undefined, undefined);
    
    const psfResults: Array<{ shift: number; psfGrid: Float64Array; rows: number; cols: number; metadata: any; mfResult: any }> = [];
    const PARALLEL_DEFOCUS_BATCH_SIZE = 4;  // Parallel batch size for PSF computation
    
    // Divide defocus values into batches
    const batches: { shift: number; index: number }[][] = [];
    for (let i = 0; i < defocusValues.length; i += PARALLEL_DEFOCUS_BATCH_SIZE) {
        const batch: { shift: number; index: number }[] = [];
        for (let j = i; j < Math.min(i + PARALLEL_DEFOCUS_BATCH_SIZE, defocusValues.length); j++) {
            batch.push({ shift: defocusValues[j], index: j });
        }
        batches.push(batch);
    }

    ensureConsoleLog(`🚀 [TFMTF] Starting PSF batch processing: ${defocusValues.length} defocus values in ${batches.length} batches (batch size: ${PARALLEL_DEFOCUS_BATCH_SIZE})`);

    // Process batches sequentially, but compute items within each batch in parallel
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const batchNum = batchIdx + 1;
        const batchTotal = batches.length;
        
        reportProgress(12 + batchIdx * 2, `Computing PSF: Batch ${batchNum}/${batchTotal} (${batch.length} points)`, undefined, undefined);
        
        // Create parallel computation tasks for this batch
        const batchTasks = batch.map(({ shift, index }) => {
            return (async () => {
                let subMessage = '';
                const mtfSubProgress = (evt: { percent?: number; message?: string }) => {
                    if (evt?.message) {
                        const defocusInfo = `Defocus ${shift.toFixed(4)}mm(${index + 1}/${defocusValues.length}) `;
                        subMessage = defocusInfo + evt.message;
                        const pct = Math.floor(10 + (index / Math.max(1, defocusValues.length)) * 50);
                        reportProgress(pct, `Computing PSF: Defocus ${shift.toFixed(4)} mm (${index + 1}/${defocusValues.length})`, undefined, subMessage);
                    }
                };

                try {
                    ensureConsoleLog(`   → TFMTF Batch ${batchNum}/${batchTotal} defocus ${shift.toFixed(4)}mm: Calling showMTFDiagram`);
                    const result = await showMTFDiagram({
                        wavelengthMicrons,
                        objectIndex,
                        maxFrequencyLpmm: targetFreq,
                        samplingSize: sampling,
                        zeroPadTo,
                        opdDisplayMode,
                        defocusShiftMm: shift,
                        skipPlot: true,
                        onProgress: mtfSubProgress,
                        containerElement
                    });
                    ensureConsoleLog(`   ← TFMTF completed`);

                    return {
                        shift,
                        index,
                        psfGrid: new Float64Array(sampling * sampling),
                        rows: sampling,
                        cols: sampling,
                        metadata: { wavelengthMicrons, targetFreq },
                        mfResult: result,
                        success: true
                    };
                } catch (error) {
                    ensureConsoleError(`❌ [TFMTF] PSF calculation failed for defocus ${shift}:`, error);
                    return {
                        shift,
                        index,
                        psfGrid: new Float64Array(0),
                        rows: 0,
                        cols: 0,
                        metadata: {},
                        mfResult: null,
                        success: false,
                        error
                    };
                }
            })();
        });

        // Wait for all tasks in this batch to complete
        const batchResults = await Promise.allSettled(batchTasks);

        // Extract successful results and store with original indices
        const indexedResults: { index: number; data: any }[] = [];
        for (let i = 0; i < batchResults.length; i++) {
            const result = batchResults[i];
            if (result.status === 'fulfilled') {
                indexedResults.push({ index: result.value.index, data: result.value });
            }
        }

        // Sort by original index to maintain order
        indexedResults.sort((a, b) => a.index - b.index);

        // Add to psfResults
        for (const { data } of indexedResults) {
            if (data.success) {
                psfResults.push({
                    shift: data.shift,
                    psfGrid: data.psfGrid,
                    rows: data.rows,
                    cols: data.cols,
                    metadata: data.metadata,
                    mfResult: data.mfResult
                });
            } else {
                psfResults.push({
                    shift: data.shift,
                    psfGrid: new Float64Array(0),
                    rows: 0,
                    cols: 0,
                    metadata: data.metadata,
                    mfResult: null
                });
            }
        }

        ensureConsoleLog(`✅ [TFMTF] Batch ${batchNum}/${batchTotal} completed: ${indexedResults.length}/${batch.length} items successful`);
    }

    reportProgress(60, 'Extracting MTF values from PSF...', undefined, undefined);
    ensureConsoleLog(`✅ [TFMTF] All PSF calculations completed. Results collected: ${psfResults.length}/${defocusValues.length}`);

    // レイアウト定義（プロット初期化用）
    const titleWl = (typeof wavelengthMicrons === 'string' && String(wavelengthMicrons).toLowerCase() === 'all')
        ? 'All wavelengths'
        : `${(safeNumber(wavelengthMicrons, 0.5876) * 1000).toFixed(1)} nm`;
    const objIndex = Number.isFinite(Number(objectIndex)) ? Math.max(0, Math.floor(Number(objectIndex))) : 0;

    const layout = {
        title: `Through-Focus MTF (${targetFreq.toFixed(1)} lp/mm, ${titleWl}, Object ${objIndex})`,
        xaxis: { title: 'Defocus shift (mm)', range: [Math.min(minMm, maxMm), Math.max(minMm, maxMm)] },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        margin: { l: 60, r: 20, t: 50, b: 50 }
    };

    // 初回プロット作成（空の状態で準備）
    reportProgress(62, 'Initializing plot...', undefined, undefined);
    plotly.newPlot(containerEl, [], layout, { responsive: true, displaylogo: false });

    // Process MTF traces from all defocus values
    // Since PSF calculation is the bottleneck (now with Rust FFT), and workers can't easily
    // calculate PSF, we process the traces sequentially but benefit from Phase 1 Rust FFT speedup
    for (let i = 0; i < psfResults.length; i++) {
        const { shift, mfResult } = psfResults[i];
        let subMessage = '';
        // サンプリング進捗を受け取るonProgressラッパー
        const mtfSubProgress = (evt: { percent?: number; message?: string }) => {
            if (evt?.message) subMessage = evt.message;
        };
        // traces抽出
        const traces = Array.isArray(mfResult?.traces) ? mfResult.traces : [];
        for (const tr of traces) {
            if (tr?.meta?.overlayType === 'diffractionLimit') continue;
            const rawName = String(tr?.name ?? 'MTF');
            const name = rawName.replace(/^Tangential\b/, 'Meridional');
            const x = Array.isArray(tr?.x) ? tr.x : [];
            const y = Array.isArray(tr?.y) ? tr.y : [];
            if (x.length === 0 || y.length === 0) continue;

            let bestIdx = 0;
            let bestDf = Infinity;
            for (let k = 0; k < x.length; k++) {
                const f = Number(x[k]);
                if (!Number.isFinite(f)) continue;
                const df = Math.abs(f - targetFreq);
                if (df < bestDf) {
                    bestDf = df;
                    bestIdx = k;
                }
            }
            const v = Number(y[bestIdx]);
            const mtfVal = Number.isFinite(v) ? v : null;

            if (!traceMap.has(name)) {
                const trace: any = {
                    x: [],
                    y: [],
                    type: 'scatter',
                    mode: (typeof tr?.mode === 'string' && tr.mode) ? tr.mode : 'lines',
                    name,
                    showlegend: true
                };

                if (tr?.line && typeof tr.line === 'object') {
                    trace.line = { ...tr.line };
                } else {
                    trace.line = { width: 2 };
                }

                if (tr?.marker && typeof tr.marker === 'object') {
                    trace.marker = { ...tr.marker };
                }

                traceMap.set(name, trace);
            }
            const agg = traceMap.get(name);
            agg.x.push(shift);
            agg.y.push(mtfVal);
        }

        // 1プロット計算毎にグラフを更新
        const currentTraces = Array.from(traceMap.values());
        plotly.newPlot(containerEl, currentTraces, layout, { responsive: true, displaylogo: false });

        // 進捗ごとに現時点のtraceMapとサンプリング進捗テキストをonProgressで通知
        const pct = Math.floor(60 + ((i + 1) / psfResults.length) * 35);
        const tracesSnapshot = Array.from(traceMap.values()).map(t => ({ ...t, x: [...t.x], y: [...t.y] }));
        const wavelengthLabels = Array.from(new Set(
            traces
                .map((tr: any) => {
                    const rawName = String(tr?.name ?? '');
                    const nmMatch = rawName.match(/([0-9]+(?:\.[0-9]+)?)\s*nm/i);
                    if (!nmMatch) return null;
                    const nm = Number(nmMatch[1]);
                    return Number.isFinite(nm) ? `${nm.toFixed(1)}nm` : null;
                })
                .filter((v: string | null) => typeof v === 'string' && v.length > 0)
        ));
        if (wavelengthLabels.length > 0) {
            for (const wlLabel of wavelengthLabels) {
                reportProgress(
                    pct,
                    `Extracting MTF: λ=${wlLabel}, step ${i + 1}/${psfResults.length}`,
                    tracesSnapshot,
                    subMessage,
                );
            }
        } else {
            reportProgress(pct, `Extracting MTF: step ${i + 1}/${psfResults.length}`, tracesSnapshot, subMessage);
        }
    }

    const traces = Array.from(traceMap.values());
    reportProgress(98, 'Finalizing plot...', undefined, undefined);
    plotly.newPlot(containerEl, traces, layout, { responsive: true, displaylogo: false });
    reportProgress(100, 'Done', undefined, undefined);
    
    console.log(`✅ [TFMTF] Computed ${psfResults.length} through-focus points with ${nSteps} steps`);
    
    return { traces, layout };
}

async function showFieldMTFDiagram({
    wavelengthMicrons,
    firstFrequencyLpmm,
    secondFrequencyLpmm,
    fieldMin,
    fieldMax,
    steps,
    samplingSize,
    samplingPoints,
    zeroPadTo,
    containerElement,
    onProgress,
    opdDisplayMode,
    fieldAxisMode
}: FieldMtfOptions = {}) {
    const safeNumber = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    const resolveContainerElement = () => {
        if (containerElement) return containerElement;
        const byId = (id: string) => {
            try { return document.getElementById(id); } catch (_) { return null; }
        };
        return (
            byId('mtf-container')
            || byId('popup-field-mtf-container')
            || byId('popup-through-focus-mtf-container')
            || null
        );
    };

    let containerEl: any = resolveContainerElement();
    if (!containerEl) throw new Error('MTF container element not found');
    try { containerEl.innerHTML = ''; } catch (_) {}

    const plotly = containerEl?.ownerDocument?.defaultView?.Plotly || (typeof window !== 'undefined' ? window.Plotly : null);
    if (!plotly) throw new Error('Plotly is not available');

    const reportProgress = (percent, message, trace, subMessage) => {
        try {
            if (typeof onProgress !== 'function') return;
            onProgress({ percent, message, trace, subMessage });
        } catch (_) {}
    };

    const inferObjectFieldModeForMTF = (objects) => {
        // Priority 1: check optical system first surface thickness.
        // If the first surface is at INF (infinite conjugate), object coordinates MUST be angles.
        // This physical constraint overrides whatever the position column says.
        try {
            const optRows = getOpticalSystemRows(window.tableOpticalSystem);
            const firstSurf = Array.isArray(optRows) && optRows.length > 0 ? optRows[0] : null;
            if (firstSurf) {
                const thickness = firstSurf.thickness ?? firstSurf.Thickness;
                const isInf = thickness === 'INF' || thickness === Infinity || String(thickness).trim().toUpperCase() === 'INF';
                if (isInf) {
                    ensureConsoleLog(`[inferObjectFieldMode] first surface thickness=INF → angle mode`);
                    return 'angle';
                }
                const numThick = parseFloat(String(thickness));
                if (Number.isFinite(numThick) && numThick > 0) {
                    // Finite conjugate: defer to position field below
                    ensureConsoleLog(`[inferObjectFieldMode] first surface thickness=${numThick} (finite) → defer to position field`);
                }
            }
        } catch (_) {}

        // Priority 2: position field from object rows
        const rows = Array.isArray(objects) ? objects : [];
        const pickTag = (o) => {
            const raw = o?.position ?? o?.object ?? o?.objectType;
            return (raw ?? '').toString().toLowerCase();
        };
        const tags = rows.map(pickTag).filter(Boolean);

        // Explicit Rectangle/Height
        const hasRect = tags.some(t => t.includes('rect') || t.includes('rectangle'));
        const hasHeight = tags.some(t => t.includes('height'));
        if (hasRect || hasHeight) return 'height';

        // Explicit Angle
        const hasAngle = tags.some(t => /\bangle\b/.test(t));
        if (hasAngle) return 'angle';

        return 'angle'; // Default to angle when unclear
    };

    const axisMode = (() => {
        if (fieldAxisMode === 'angle' || fieldAxisMode === 'height') return fieldAxisMode;
        const objects = getObjectRows(window.tableObject);
        return inferObjectFieldModeForMTF(objects);
    })();

    const axisUnit = (axisMode === 'angle') ? 'deg' : 'mm';
    const axisLabel = (axisMode === 'angle') ? 'Object Angle (deg)' : 'Object Height (mm)';

    // 🔍 DEBUG: Log function entry
    ensureConsoleLog(`========== 🔍 showFieldMTFDiagram EXECUTION START ==========`);
    ensureConsoleLog(`📊 Input Parameters:`, { fieldMin, fieldMax, steps, axisMode, wavelengthMicrons, firstFrequencyLpmm, secondFrequencyLpmm });

    const minFieldRaw = safeNumber(fieldMin, 0);
    const maxFieldRaw = safeNumber(fieldMax, 10);
    const minField = Math.min(minFieldRaw, maxFieldRaw);
    const maxField = Math.max(minFieldRaw, maxFieldRaw);
    const nSteps = clamp(Math.floor(safeNumber(steps, 21)), 3, 201);

    const firstFreq = Math.max(0, safeNumber(firstFrequencyLpmm, 10));
    const secondFreq = Math.max(0, safeNumber(secondFrequencyLpmm, 30));

    const samplingCandidate = Math.floor(safeNumber(samplingSize, safeNumber(samplingPoints, 256)));
    const sampling = Number.isFinite(samplingCandidate) && samplingCandidate > 0 ? samplingCandidate : 256;

    const fieldValues = Array.from({ length: nSteps }, (_, i) => {
        if (nSteps <= 1) return minField;
        const t = i / (nSteps - 1);
        return minField + t * (maxField - minField);
    });

    ensureConsoleLog(`📈 Field sweep: axisMode=${axisMode}, min=${minField}, max=${maxField}, nSteps=${nSteps}`);

    const results: Array<{ fieldValue: number; mfResult: any }> = [];
    const traceMap = new Map();

    reportProgress(10, 'Computing MTF for all field points...', undefined, undefined);

    // Batch processing for Object MTF field sweep.
    // NOTE: keep this sequential (batch size = 1) to avoid cross-call interference,
    // because showMTFDiagram internally toggles global runtime flags during wavefront solve.
    const PARALLEL_FIELD_BATCH_SIZE = 1;
    
    // Divide field values into batches
    const batches: { fieldValue: number; index: number }[][] = [];
    for (let i = 0; i < fieldValues.length; i += PARALLEL_FIELD_BATCH_SIZE) {
        const batch: { fieldValue: number; index: number }[] = [];
        for (let j = i; j < Math.min(i + PARALLEL_FIELD_BATCH_SIZE, fieldValues.length); j++) {
            batch.push({ fieldValue: fieldValues[j], index: j });
        }
        batches.push(batch);
    }

    ensureConsoleLog(`🚀 [Object MTF] Starting field batch processing: ${fieldValues.length} field values in ${batches.length} batches (batch size: ${PARALLEL_FIELD_BATCH_SIZE})`);

    // Process batches sequentially, but compute items within each batch in parallel
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
        const batch = batches[batchIdx];
        const batchNum = batchIdx + 1;
        const batchTotal = batches.length;

        reportProgress(10 + batchIdx * 2, `Computing MTF: Batch ${batchNum}/${batchTotal} (${batch.length} points)`, undefined, undefined);

        // Create parallel computation tasks for this batch
        const batchTasks = batch.map(({ fieldValue, index }) => {
            return (async () => {
                let subMessage = '';
                const mtfSubProgress = (evt: { percent?: number; message?: string }) => {
                    if (evt?.message) {
                        const fieldInfo = `Field ${fieldValue.toFixed(4)}${axisUnit}(${index + 1}/${fieldValues.length}) `;
                        subMessage = fieldInfo + evt.message;
                        const pct = Math.floor(10 + (index / Math.max(1, fieldValues.length)) * 50);
                        reportProgress(pct, `Computing MTF: Field ${fieldValue.toFixed(4)} ${axisUnit} (${index + 1}/${fieldValues.length})`, undefined, subMessage);
                    }
                };

                const objectOverride = (axisMode === 'angle')
                    ? { x: 0, y: fieldValue, xHeightAngle: 0, yHeightAngle: fieldValue, position: 'Angle' }
                    : { x: 0, y: fieldValue, xHeight: 0, yHeight: fieldValue, position: 'Rectangle' };

                ensureConsoleLog(`\n🔄 [Object MTF] ===== ITERATION START =====`);
                ensureConsoleLog(`📍 Batch ${batchNum}/${batchTotal}, Step ${index + 1}/${fieldValues.length}`);
                ensureConsoleLog(`   axisMode=${axisMode}, fieldValue=${fieldValue.toFixed(4)}${axisUnit}`);
                ensureConsoleLog(`   objectOverride: x=${objectOverride.x}, y=${objectOverride.y}, xHeight=${objectOverride.xHeight}, yHeight=${objectOverride.yHeight}, position=${objectOverride.position}`);

                try {
                    ensureConsoleLog(`   → Calling showMTFDiagram with objectOverride, expecting NEW OPD calculation`);
                    const result = await showMTFDiagram({
                        wavelengthMicrons,
                        objectIndex: 0,
                        objectOverride,
                        maxFrequencyLpmm: Math.max(firstFreq, secondFreq) * 2,
                        samplingSize: sampling,
                        zeroPadTo,
                        opdDisplayMode,
                        skipPlot: true,
                        onProgress: mtfSubProgress,
                        containerElement
                    });
                    ensureConsoleLog(`   ← showMTFDiagram completed`);

                    return {
                        fieldValue,
                        index,
                        mfResult: result,
                        success: true
                    };
                } catch (error) {
                    ensureConsoleError(`❌ [Object MTF] MTF calculation FAILED for field ${fieldValue.toFixed(4)}${axisUnit}:`, error);
                    ensureConsoleError(`   Error details:`, { errorMessage: error?.message, errorStack: error?.stack });
                    return {
                        fieldValue,
                        index,
                        mfResult: null,
                        success: false,
                        error
                    };
                }
            })();
        });

        // Wait for all tasks in this batch to complete
        const batchResults = await Promise.allSettled(batchTasks);

        // Extract successful results and store with original indices
        const indexedResults: { index: number; data: any }[] = [];
        for (let i = 0; i < batchResults.length; i++) {
            const result = batchResults[i];
            if (result.status === 'fulfilled') {
                indexedResults.push({ index: result.value.index, data: result.value });
            }
        }

        // Sort by original index to maintain order
        indexedResults.sort((a, b) => a.index - b.index);

        // Add to results
        for (const { data } of indexedResults) {
            if (data.success) {
                if (!data.mfResult || !data.mfResult.traces || data.mfResult.traces.length === 0) {
                    ensureConsoleLog(`⚠️ [Object MTF] No traces returned for field ${data.fieldValue.toFixed(4)}${axisUnit}`);
                }
                results.push({ fieldValue: data.fieldValue, mfResult: data.mfResult });
                ensureConsoleLog(`✅ [Object MTF] Batch ${batchNum}/${batchTotal} Step ${data.index + 1}/${fieldValues.length} completed: field=${data.fieldValue.toFixed(4)}${axisUnit}, traces=${data.mfResult?.traces?.length || 0}`);
            } else {
                results.push({ fieldValue: data.fieldValue, mfResult: null });
                ensureConsoleError(`❌ [Object MTF] Batch ${batchNum}/${batchTotal} Step ${data.index + 1}/${fieldValues.length} failed for field ${data.fieldValue.toFixed(4)}${axisUnit}`);
            }
        }

        ensureConsoleLog(`✅ [Object MTF] Batch ${batchNum}/${batchTotal} completed: ${indexedResults.length}/${batch.length} items processed`);
    }

    const titleWl = (typeof wavelengthMicrons === 'string' && String(wavelengthMicrons).toLowerCase() === 'all')
        ? 'All wavelengths'
        : `${(safeNumber(wavelengthMicrons, 0.5876) * 1000).toFixed(1)} nm`;

    const layout = {
        title: `Object MTF (${firstFreq.toFixed(1)} / ${secondFreq.toFixed(1)} lp/mm, ${titleWl})`,
        xaxis: { title: axisLabel, range: [Math.min(minField, maxField), Math.max(minField, maxField)] },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        margin: { l: 60, r: 20, t: 50, b: 50 },
        showlegend: true,
        legend: { x: 1.02, y: 1, xanchor: 'left', yanchor: 'top' }
    };

    reportProgress(62, 'Initializing plot...', undefined, undefined);
    plotly.newPlot(containerEl, [], layout, { responsive: true, displaylogo: false });

    ensureConsoleLog(`✅ [Object MTF] All MTF calculations completed. Results collected: ${results.length}/${fieldValues.length}`);
    ensureConsoleLog(`🔍 [Object MTF] Aggregating ${results.length} field points into traces...`);

    for (let i = 0; i < results.length; i++) {
        const { fieldValue, mfResult } = results[i];
        const traces = Array.isArray(mfResult?.traces) ? mfResult.traces : [];
        
        if (traces.length === 0) {
            ensureConsoleLog(`⚠️ [Object MTF] No traces for field ${i}: fieldValue=${fieldValue.toFixed(4)}`);
            continue;
        }

        for (const tr of traces) {
            if (tr?.meta?.overlayType === 'diffractionLimit') continue;
            const rawName = String(tr?.name ?? 'MTF');
            const isTangential = /^Tangential\b/.test(rawName);
            const isSagittal = /^Sagittal\b/.test(rawName);
            if (!isTangential && !isSagittal) {
                ensureConsoleLog(`⚠️ [Object MTF] Skipped trace with unmatched name: "${rawName}" at field ${fieldValue.toFixed(4)}`);
                continue;
            }

            const x = Array.isArray(tr?.x) ? tr.x : [];
            const y = Array.isArray(tr?.y) ? tr.y : [];
            if (x.length === 0 || y.length === 0) {
                ensureConsoleLog(`⚠️ [Object MTF] Trace "${rawName}" has empty x/y at field ${fieldValue.toFixed(4)} (x.len=${x.length}, y.len=${y.length})`);
                continue;
            }

            const suffix = rawName.replace(/^(Tangential|Sagittal)\b/, '').trim();
            const axisName = isTangential ? 'Meridional' : 'Sagittal';

            // Calculate MTF at both firstFreq and secondFreq
            const frequencies = [
                { freq: firstFreq, label: '1st' },
                { freq: secondFreq, label: '2nd' }
            ];

            for (const { freq, label } of frequencies) {
                // Find closest frequency sample
                let bestIdx = 0;
                let bestDf = Infinity;
                for (let k = 0; k < x.length; k++) {
                    const f = Number(x[k]);
                    if (!Number.isFinite(f)) continue;
                    const df = Math.abs(f - freq);
                    if (df < bestDf) {
                        bestDf = df;
                        bestIdx = k;
                    }
                }
                const v = Number(y[bestIdx]);
                const mtfVal = Number.isFinite(v) ? v : null;

                const freqLabel = freq.toFixed(1);
                const name = suffix
                    ? `${axisName} ${freqLabel} lp/mm ${suffix}`
                    : `${axisName} ${freqLabel} lp/mm`;

                if (!traceMap.has(name)) {
                    const trace: any = {
                        x: [],
                        y: [],
                        type: 'scatter',
                        mode: (typeof tr?.mode === 'string' && tr.mode) ? tr.mode : 'lines',
                        name,
                        showlegend: true
                    };

                    if (tr?.line && typeof tr.line === 'object') {
                        trace.line = { ...tr.line };
                    } else {
                        trace.line = { width: 2 };
                    }

                    if (tr?.marker && typeof tr.marker === 'object') {
                        trace.marker = { ...tr.marker };
                    }

                    traceMap.set(name, trace);
                }

                const agg = traceMap.get(name);
                agg.x.push(fieldValue);
                agg.y.push(mtfVal);
            }
        }

        const currentTraces = Array.from(traceMap.values());
        plotly.newPlot(containerEl, currentTraces, layout, { responsive: true, displaylogo: false });

        const pct = Math.floor(60 + ((i + 1) / results.length) * 35);
        const tracesSnapshot = Array.from(traceMap.values()).map(t => ({ ...t, x: [...t.x], y: [...t.y] }));
        reportProgress(pct, `Extracting MTF: ${i + 1}/${results.length} (${traceMap.size} traces)`, tracesSnapshot, undefined);
    }

    const finalTraces = Array.from(traceMap.values());
    ensureConsoleLog(`========== ✅ [Object MTF] FINAL RESULTS ==========`);
    ensureConsoleLog(`✅ Final trace count: ${finalTraces.length}`);
    ensureConsoleLog(`✅ Field points per trace: ${finalTraces[0]?.x?.length || 0}`);
    ensureConsoleLog(`✅ Trace names:`, finalTraces.map(t => t.name));
    if (finalTraces.length > 0) {
        ensureConsoleLog(`✅ First trace X-axis range: [${finalTraces[0].x?.[0]}, ${finalTraces[0].x?.[finalTraces[0].x.length - 1]}]`);
        ensureConsoleLog(`✅ First trace Y-axis range: [${Math.min(...(finalTraces[0].y || []))}, ${Math.max(...(finalTraces[0].y || []))}]`);
    }
    ensureConsoleLog(`========== showFieldMTFDiagram COMPLETE ==========`);

    reportProgress(98, 'Finalizing plot...', undefined, undefined);
    plotly.newPlot(containerEl, finalTraces, layout, { responsive: true, displaylogo: false });
    reportProgress(100, 'Done', undefined, undefined);

    ensureConsoleLog(`✅ [Object MTF] Computed ${results.length} field points with ${nSteps} steps`);

    return { traces: finalTraces, layout };
}

async function showMTFComparisonDiagram({
    wavelengthMicrons,
    objectIndex,
    maxFrequencyLpmm,
    samplingSize,
    samplingPoints,
    containerElement,
    onProgress,
    opdDisplayMode,
    defocusShiftMm,
    zeroPadTo,
    showDelta,
    timeoutMs
}: MtfComparisonOptions = {}) {
    const safeNumber = (v, fallback) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    };

    const resolveContainerElement = () => {
        if (containerElement) return containerElement;
        const byId = (id: string) => {
            try { return document.getElementById(id); } catch (_) { return null; }
        };
        return (
            byId('mtf-container')
            || byId('popup-mtf-container')
            || byId('popup-through-focus-mtf-container')
            || null
        );
    };

    let containerEl: any = resolveContainerElement();
    if (!containerEl) {
        try {
            if (!document?.body) throw new Error('document.body is unavailable');
            const autoId = 'mtf-comparison-container-auto';
            const existing = document.getElementById(autoId);
            containerEl = existing || document.createElement('div');
            if (!existing) {
                containerEl.id = autoId;
                containerEl.style.position = 'fixed';
                containerEl.style.right = '16px';
                containerEl.style.bottom = '16px';
                containerEl.style.width = '760px';
                containerEl.style.height = '520px';
                containerEl.style.background = '#ffffff';
                containerEl.style.border = '1px solid #d0d0d0';
                containerEl.style.boxShadow = '0 4px 16px rgba(0,0,0,0.15)';
                containerEl.style.zIndex = '99999';
                containerEl.style.borderRadius = '6px';
                document.body.appendChild(containerEl);
            }
            console.warn('⚠️ MTF container not found. Auto-created #mtf-comparison-container-auto for plotting.');
        } catch (error) {
            throw new Error('MTF container element not found');
        }
    }
    try { containerEl.innerHTML = ''; } catch (_) {}

    const plotly = containerEl?.ownerDocument?.defaultView?.Plotly || (typeof window !== 'undefined' ? window.Plotly : null);
    if (!plotly) {
        throw new Error('Plotly is not available');
    }

    const reportProgress = (percent, message) => {
        try {
            if (typeof onProgress !== 'function') return;
            onProgress({ percent, message });
        } catch (_) {}
    };

    const shouldShowDelta = (typeof showDelta === 'boolean') ? showDelta : true;
    const perRunTimeoutMs = Math.max(1000, safeNumber(timeoutMs, 120000));

    const setPhase = (phase: string, extra: any = null) => {
        try {
            if (typeof globalThis !== 'undefined') {
                (globalThis as any).__mtfComparisonState = {
                    phase,
                    at: Date.now(),
                    extra
                };
            }
        } catch (_) {}
    };

    const withTimeout = async (promise: Promise<any>, ms: number, label: string) => {
        let timeoutId: any = null;
        try {
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`${label} timed out after ${ms} ms`));
                }, ms);
            });
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            try { if (timeoutId) clearTimeout(timeoutId); } catch (_) {}
        }
    };

    setPhase('start');
    reportProgress(2, 'Running current MTF...');
    setPhase('current-mtf');
    const current = await withTimeout(showMTFDiagram({
        wavelengthMicrons,
        objectIndex,
        maxFrequencyLpmm,
        samplingSize,
        samplingPoints,
        containerElement: containerEl,
        onProgress: null,
        opdDisplayMode,
        defocusShiftMm,
        skipPlot: true,
        showDiffractionLimit: false,
        zeroPadTo,
        legacyBaselineMode: false
    }), perRunTimeoutMs, 'Current MTF run');

    reportProgress(45, 'Running Feb-7 baseline-compatible MTF...');
    setPhase('legacy-mtf');
    const legacy = await withTimeout(showMTFDiagram({
        wavelengthMicrons,
        objectIndex,
        maxFrequencyLpmm,
        samplingSize,
        samplingPoints,
        containerElement: containerEl,
        onProgress: null,
        opdDisplayMode,
        defocusShiftMm,
        skipPlot: true,
        showDiffractionLimit: false,
        zeroPadTo,
        legacyBaselineMode: true
    }), perRunTimeoutMs, 'Feb-7 compatible MTF run');

    const currentTraces = Array.isArray(current?.traces) ? current.traces : [];
    const legacyTraces = Array.isArray(legacy?.traces) ? legacy.traces : [];

    const stripSuffix = (name: string) => String(name || '').replace(/\s*\(.*\)\s*$/, '').trim();
    const isPrimaryMTFCurve = (name: string) => {
        const n = stripSuffix(name).toLowerCase();
        return n === 'tangential' || n === 'sagittal';
    };

    const primaryCurrent = currentTraces.filter((tr) => isPrimaryMTFCurve(String(tr?.name ?? '')));
    const primaryLegacy = legacyTraces.filter((tr) => isPrimaryMTFCurve(String(tr?.name ?? '')));

    const legacyByKey = new Map<string, any>();
    for (const tr of primaryLegacy) {
        legacyByKey.set(stripSuffix(String(tr?.name ?? '')).toLowerCase(), tr);
    }

    const interpolateY = (xs: number[], ys: any[], x: number) => {
        if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length === 0 || ys.length === 0) return null;
        if (xs.length !== ys.length) return null;
        if (!Number.isFinite(x)) return null;

        if (x <= Number(xs[0])) {
            const y0 = Number(ys[0]);
            return Number.isFinite(y0) ? y0 : null;
        }
        const last = xs.length - 1;
        if (x >= Number(xs[last])) {
            const yl = Number(ys[last]);
            return Number.isFinite(yl) ? yl : null;
        }

        for (let i = 1; i < xs.length; i++) {
            const x0 = Number(xs[i - 1]);
            const x1 = Number(xs[i]);
            if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 === x0) continue;
            if (x <= x1) {
                const y0 = Number(ys[i - 1]);
                const y1 = Number(ys[i]);
                if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
                const t = (x - x0) / (x1 - x0);
                return y0 + t * (y1 - y0);
            }
        }
        return null;
    };

    const comparisonTraces: any[] = [];
    let maxAbsDelta = 0;

    for (const tr of primaryCurrent) {
        const key = stripSuffix(String(tr?.name ?? '')).toLowerCase();
        const legacyTr = legacyByKey.get(key);
        if (!legacyTr) continue;

        const xCur = Array.isArray(tr?.x) ? tr.x : [];
        const yCur = Array.isArray(tr?.y) ? tr.y : [];
        const xOld = Array.isArray(legacyTr?.x) ? legacyTr.x : [];
        const yOld = Array.isArray(legacyTr?.y) ? legacyTr.y : [];

        const baseLabel = stripSuffix(String(tr?.name ?? 'MTF'));
        const color = tr?.line?.color;

        comparisonTraces.push({
            x: xCur,
            y: yCur,
            type: 'scatter',
            mode: 'lines',
            name: `${baseLabel} (Current)`,
            line: { ...(tr?.line || {}), width: 2.5 }
        });

        comparisonTraces.push({
            x: xOld,
            y: yOld,
            type: 'scatter',
            mode: 'lines',
            name: `${baseLabel} (Feb-7 Compat)`,
            line: {
                color: color || '#888',
                width: 1.75,
                dash: 'dash'
            }
        });

        if (shouldShowDelta) {
            const deltaX: number[] = [];
            const deltaY: any[] = [];
            for (let i = 0; i < xCur.length; i++) {
                const f = Number(xCur[i]);
                const yc = Number(yCur[i]);
                if (!Number.isFinite(f) || !Number.isFinite(yc)) continue;
                const yo = interpolateY(xOld, yOld, f);
                if (!Number.isFinite(Number(yo))) continue;
                const d = yc - Number(yo);
                deltaX.push(f);
                deltaY.push(d);
                maxAbsDelta = Math.max(maxAbsDelta, Math.abs(d));
            }

            comparisonTraces.push({
                x: deltaX,
                y: deltaY,
                type: 'scatter',
                mode: 'lines',
                name: `${baseLabel} Δ(Current-Compat)`,
                yaxis: 'y2',
                line: {
                    color: color || '#444',
                    width: 1.2,
                    dash: 'dot'
                }
            });
        }
    }

    const maxLpmmCurrent = safeNumber(current?.maxPlotLpmmGlobal, 0);
    const maxLpmmLegacy = safeNumber(legacy?.maxPlotLpmmGlobal, 0);
    const maxPlotLpmmGlobal = Math.max(maxLpmmCurrent, maxLpmmLegacy, 0);

    const primaryWl = (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function')
        ? Number(window.getPrimaryWavelength())
        : 0.5876;
    const isAll = (typeof wavelengthMicrons === 'string') && (String(wavelengthMicrons).toLowerCase() === 'all');
    const titleWl = isAll ? 'All wavelengths' : `${(safeNumber(wavelengthMicrons, primaryWl) * 1000).toFixed(1)} nm`;
    const objIndex = Number.isFinite(Number(objectIndex)) ? Math.max(0, Math.floor(Number(objectIndex))) : 0;

    const deltaRange = Math.max(0.02, Math.min(0.5, maxAbsDelta * 1.2 || 0.02));
    const layout: any = {
        title: `MTF Comparison (Current vs Feb-7 Compat, ${titleWl}, Object ${objIndex})`,
        xaxis: { title: 'Spatial frequency (lp/mm)', range: [0, maxPlotLpmmGlobal || 0] },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        margin: { l: 60, r: shouldShowDelta ? 60 : 20, t: 50, b: 50 },
        legend: { orientation: 'h' }
    };

    if (shouldShowDelta) {
        layout.yaxis2 = {
            title: 'ΔMTF',
            overlaying: 'y',
            side: 'right',
            range: [-deltaRange, deltaRange],
            zeroline: true
        };
    }

    reportProgress(92, 'Rendering comparison plot...');
    setPhase('rendering', { traceCount: comparisonTraces.length });
    await withTimeout(
        plotly.newPlot(containerEl, comparisonTraces, layout, { responsive: true, displaylogo: false }),
        Math.max(1000, Math.floor(perRunTimeoutMs / 2)),
        'MTF comparison plotting'
    );
    reportProgress(100, 'Done');

    const summary = {
        curveCount: comparisonTraces.length,
        maxPlotLpmmGlobal,
        maxAbsDelta,
        wavelengthMicrons,
        objectIndex: objIndex
    };
    try {
        if (typeof globalThis !== 'undefined') {
            (globalThis as any).__lastMTFComparisonResult = summary;
            (globalThis as any).__mtfComparisonState = {
                phase: 'done',
                at: Date.now(),
                extra: summary
            };
        }
        console.info('📊 [MTF Comparison] Summary:', summary);
    } catch (_) {}

    return {
        curveCount: comparisonTraces.length,
        traces: comparisonTraces,
        layout,
        maxPlotLpmmGlobal,
        maxAbsDelta,
        current,
        legacy
    };
}
/**
 * PSF Object選択肢のセットアップ
 */

export { showMTFDiagram, showThroughFocusMTFDiagram, showFieldMTFDiagram, showMTFComparisonDiagram };
