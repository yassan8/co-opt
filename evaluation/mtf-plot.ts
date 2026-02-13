// Import data utility functions
import { getOpticalSystemRows, getObjectRows, getSourceRows } from '../utils/data-utils.ts';
import { ensureMtfWasmReady, setRayTracingWasmStrict, isRayTracingWasmStrict } from '../core/wasm-service.ts';

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

function cloneOpticalSystemRowsWithDefocusShift(opticalSystemRows, defocusShiftMm) {
    const shift = Number(defocusShiftMm);
    if (!Array.isArray(opticalSystemRows)) return [];
    const cloned = opticalSystemRows.map((row) => (row && typeof row === 'object') ? { ...row } : row);
    if (!Number.isFinite(shift) || Math.abs(shift) < 1e-15) return cloned;

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

async function showMTFDiagram({ wavelengthMicrons, objectIndex, maxFrequencyLpmm, samplingSize, samplingPoints, containerElement, onProgress, opdDisplayMode, defocusShiftMm, skipPlot } = {}) {
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

    const primaryWl = (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function')
        ? safeNumber(window.getPrimaryWavelength(), 0.5876)
        : 0.5876;
    const effectiveOpdDisplayMode = (typeof opdDisplayMode === 'string' && opdDisplayMode)
        ? opdDisplayMode
        : 'pistonTiltRemoved';

    const isAllWavelengths = (typeof wavelengthMicrons === 'string')
        ? (String(wavelengthMicrons).toLowerCase() === 'all')
        : false;

    const wl = isAllWavelengths ? primaryWl : safeNumber(wavelengthMicrons, primaryWl);
    const objIndex = Number.isFinite(Number(objectIndex)) ? Math.max(0, Math.floor(Number(objectIndex))) : 0;
    const maxLpmm = Math.max(0, safeNumber(maxFrequencyLpmm, 100));

    const isPowerOfTwo = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    // samplingSize is the FFT grid size (NxN). Legacy samplingPoints is treated as alias when it looks like a valid grid size.
    const samplingCandidate = Math.floor(safeNumber(samplingSize, NaN));
    const legacyCandidate = Math.floor(safeNumber(samplingPoints, NaN));
    const gridCandidate = Number.isFinite(samplingCandidate) ? samplingCandidate : legacyCandidate;
    const gridSize = isPowerOfTwo(gridCandidate) ? clamp(gridCandidate, 32, 4096) : 256;

    const shouldRenderPlot = !skipPlot;
    const containerEl = containerElement || document.getElementById('mtf-container');
    if (shouldRenderPlot && !containerEl) {
        throw new Error('MTF container element not found');
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
    const opticalSystemRows = cloneOpticalSystemRowsWithDefocusShift(baseOpticalSystemRows, defocusShiftMm);
    if (!opticalSystemRows || opticalSystemRows.length === 0) {
        throw new Error('光学システムデータがありません。まず光学システムを設定してください。');
    }
    const objects = getObjectRows(window.tableObject);
    if (!objects || objects.length === 0) {
        throw new Error('オブジェクトデータがありません。まずオブジェクトを設定してください。');
    }
    if (objIndex >= objects.length) {
        throw new Error('指定されたオブジェクトが見つかりません。');
    }

    const selectedObject = objects[objIndex];
    const objectX = (selectedObject.x ?? selectedObject.xHeightAngle ?? 0);
    const objectY = (selectedObject.y ?? selectedObject.yHeightAngle ?? 0);
    const objectTypeRaw = String(selectedObject.position ?? selectedObject.object ?? selectedObject.Object ?? selectedObject.objectType ?? 'Point');
    const objectTypeLower = objectTypeRaw.toLowerCase();

    let fieldAngle = { x: 0, y: 0 };
    let xHeight = 0;
    let yHeight = 0;
    if (/\bangle\b/.test(objectTypeLower)) {
        fieldAngle = { x: safeNumber(objectX, 0), y: safeNumber(objectY, 0) };
    } else {
        xHeight = safeNumber(objectX, 0);
        yHeight = safeNumber(objectY, 0);
    }

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
    if (uniqueWavelengths.length === 0) uniqueWavelengths.push(primaryWl);

    const traces = [];
    let maxPlotLpmmGlobal = 0;

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
                return await analyzer.generateWavefrontMap(customFieldSetting, samplingSizeForPSF, 'circular', {
                    recordRays: false,
                    progressEvery: 512,
                    profile: enableMtfProfileLog,
                    suppressReferenceRayError: true,
                    zernikeMaxNoll: 37,
                    renderFromZernike: false,
                    skipZernikeFit: true,
                    wasmFastOnly: useWasmFastOnly,
                    traceOptions: useWasmFastOnly ? { requireWasmRayTracing: true, allowNonStrict: false } : null,
                    opdMode: 'referenceSphere',
                    opdDisplayMode: effectiveOpdDisplayMode,
                    onProgress: onWavefrontProgress
                });
            });
        };

        const shouldRetryWithEntrance = (message) => /stop unreachable|center\/chief ray|基準光線の生成に失敗/i.test(String(message || ''));

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

        // 1) Prefer stop mode (stable scaling)
        const stopAttempt = await runWavefrontAttempt('stop', fieldSetting, true);
        if (stopAttempt.map) {
            wavefrontMap = stopAttempt.map;
        } else {
            errors.push(`stop=${stopAttempt.error}`);
        }

        // 2) Retry entrance mode for stop/chief failure patterns
        if (!wavefrontMap && shouldRetryWithEntrance(stopAttempt.error)) {
            reportProgress(localBase + localSpan * 0.10, `λ=${titleNmLocal} nm: Retrying with entrance pupil mode...`);
            const entranceAttempt = await runWavefrontAttempt('entrance', fieldSetting, true);
            if (entranceAttempt.map) {
                wavefrontMap = entranceAttempt.map;
            } else {
                errors.push(`entrance=${entranceAttempt.error}`);
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

                const finiteStopAttempt = await runWavefrontAttempt('stop', finiteFieldSetting, true);
                if (finiteStopAttempt.map) {
                    wavefrontMap = finiteStopAttempt.map;
                } else {
                    errors.push(`finite-stop=${finiteStopAttempt.error}`);
                    const finiteEntranceAttempt = await runWavefrontAttempt('entrance', finiteFieldSetting, true);
                    if (finiteEntranceAttempt.map) {
                        wavefrontMap = finiteEntranceAttempt.map;
                    } else {
                        errors.push(`finite-entrance=${finiteEntranceAttempt.error}`);
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
                const compatStop = await runWavefrontAttempt('stop', fieldSetting, false);
                if (compatStop.map) {
                    wavefrontMap = compatStop.map;
                } else {
                    errors.push(`compat-stop=${compatStop.error}`);
                    const compatEntrance = await runWavefrontAttempt('entrance', fieldSetting, false);
                    if (compatEntrance.map) {
                        wavefrontMap = compatEntrance.map;
                    } else {
                        errors.push(`compat-entrance=${compatEntrance.error}`);
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

        const opdData = {
            gridSize: s,
            wavelength: wlLocal,
            gridData: {
                opd: opdGrid,
                amplitude: ampGrid,
                pupilMask: maskGrid,
                xCoords,
                yCoords
            }
        };

        // IMPORTANT: For MTF vs spatial frequency (lp/mm), keep pixelSize independent of FFT grid.
        const preferEntrancePupilForMTF = /\bangle\b/.test(objectTypeLower);
        const derivedMTFScale = derivePupilAndFocalLengthMmFromParaxial(opticalSystemRows, wlLocal, preferEntrancePupilForMTF);
        const pupilDiameterMm = derivedMTFScale.pupilDiameterMm;
        const focalLengthMm = derivedMTFScale.focalLengthMm;

        const pixelSizeMicronsForMTF = (pupilDiameterMm > 0)
            ? (wlLocal * focalLengthMm / pupilDiameterMm)
            : 1.0;

        reportProgress(localBase + localSpan * 0.75, `λ=${titleNmLocal} nm: Calculating PSF...`);
        const psfResult = await psfCalculator.calculatePSF(opdData, {
            samplingSize: s,
            pupilDiameter: pupilDiameterMm,
            focalLength: focalLengthMm,
            pixelSize: pixelSizeMicronsForMTF,
            forceImplementation: 'wasm',
            // OPD grid is already piston+tilt removed by opdDisplayMode.
            removeTilt: false
        });

        if (String(psfResult?.implementationUsed || '').toLowerCase() !== 'wasm') {
            if (forceStrictByFlag) {
                throw new Error('PSF WASM strict mode: JavaScript fallback is not allowed for MTF');
            }
            console.warn('⚠️ PSF calculation fell back to JavaScript; continuing MTF in compatibility mode.');
        }

        reportProgress(localBase + localSpan * 0.85, `λ=${titleNmLocal} nm: Computing OTF/MTF...`);

        const psf2D = psfResult?.psfData || psfResult?.psf || psfResult?.intensity || null;
        const pixelSizeMicrons = safeNumber(pixelSizeMicronsForMTF, safeNumber(psfResult?.options?.pixelSize, 1.0));
        if (!psf2D || !Array.isArray(psf2D) || !Array.isArray(psf2D[0])) {
            throw new Error('PSF data missing for MTF');
        }
        const N = psf2D.length;
        if (N < 2 || psf2D[0].length !== N) {
            throw new Error('PSF grid must be NxN');
        }

        const dfCyclesPerMicron = 1.0 / (N * pixelSizeMicrons);
        const dfLpmm = dfCyclesPerMicron * 1000.0;
        const nyquistLpmm = 0.5 / pixelSizeMicrons * 1000.0;
        const maxPlotLpmm = (maxLpmm > 0) ? Math.min(maxLpmm, nyquistLpmm) : nyquistLpmm;
        maxPlotLpmmGlobal = Math.max(maxPlotLpmmGlobal, maxPlotLpmm);

        const maxBin = Math.floor(N / 2);
        const kMax = Math.max(0, Math.min(maxBin, Math.floor(maxPlotLpmm / (dfLpmm || 1e-9))));

        const freq = Array.from({ length: kMax + 1 }, (_, k) => k * dfLpmm);

        const psfFlat = new Float64Array(N * N);
        for (let y = 0; y < N; y++) {
            for (let x = 0; x < N; x++) {
                psfFlat[y * N + x] = safeNumber(psf2D[y]?.[x], 0);
            }
        }

        const wasmMTFFn = psfCalculator?.wasmCalculator?.calculateMTFAxesFromPSF;
        let tan: { freq: number[]; mtfVals: any[] } | null = null;
        let sag: { freq: number[]; mtfVals: any[] } | null = null;

        if (typeof wasmMTFFn === 'function') {
            try {
                const axes = wasmMTFFn.call(psfCalculator.wasmCalculator, psfFlat, N, kMax);
                if (axes?.xAxis && axes?.yAxis) {
                    const tanVals = (tanAxis === 'x') ? axes.xAxis : axes.yAxis;
                    const sagVals = (sagAxis === 'x') ? axes.xAxis : axes.yAxis;
                    tan = {
                        freq,
                        mtfVals: Array.from(tanVals, (v: number) => Number.isFinite(v) ? v : null)
                    };
                    sag = {
                        freq,
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
            for (let k = 0; k <= kMax; k++) {
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

        const color = getColorForWavelength(wlLocal);
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
    };

    const totalWl = uniqueWavelengths.length;
    for (let i = 0; i < totalWl; i++) {
        await computeForWavelength(uniqueWavelengths[i], i, totalWl);
    }

    const titlePart = isAllWavelengths
        ? 'All wavelengths'
        : `${(wl * 1000).toFixed(1)} nm`;

    const layout = {
        title: `Modulation Transfer Function (${titlePart}, Object ${objIndex})`,
        xaxis: { title: 'Spatial frequency (lp/mm)', range: [0, maxPlotLpmmGlobal || 0] },
        yaxis: { title: 'MTF', range: [0, 1.05] },
        margin: { l: 60, r: 20, t: 50, b: 50 }
    };

    if (shouldRenderPlot) {
        reportProgress(95, 'Rendering plot...');
        await plotly.newPlot(containerEl, traces, layout, { responsive: true, displaylogo: false });
    }
    reportProgress(100, 'Done');
    return { traces, layout, maxPlotLpmmGlobal };
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
    containerElement,
    onProgress,
    opdDisplayMode
} = {}) {
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

    const reportProgress = (percent, message) => {
        try {
            if (typeof onProgress !== 'function') return;
            onProgress({ percent, message });
        } catch (_) {}
    };

    const minMm = safeNumber(defocusMinMm, -0.1);
    const maxMm = safeNumber(defocusMaxMm, 0.1);
    const nSteps = clamp(Math.floor(safeNumber(steps, 21)), 3, 201);
    const targetFreq = Math.max(0, safeNumber(targetFrequencyLpmm, 30));
    const samplingCandidate = Math.floor(safeNumber(samplingSize, safeNumber(samplingPoints, 256)));
    const sampling = Number.isFinite(samplingCandidate) && samplingCandidate > 0 ? samplingCandidate : 256;

    const defocusValues = Array.from({ length: nSteps }, (_, i) => {
        if (nSteps <= 1) return minMm;
        const t = i / (nSteps - 1);
        return minMm + t * (maxMm - minMm);
    });

    const traceMap = new Map();
    for (let i = 0; i < defocusValues.length; i++) {
        const shift = defocusValues[i];
        const pct = Math.floor((i / Math.max(1, defocusValues.length)) * 95);
        reportProgress(pct, `Defocus ${shift.toFixed(4)} mm (${i + 1}/${defocusValues.length})`);

        const result = await showMTFDiagram({
            wavelengthMicrons,
            objectIndex,
            maxFrequencyLpmm: targetFreq,
            samplingSize: sampling,
            opdDisplayMode,
            defocusShiftMm: shift,
            skipPlot: true,
            onProgress: null,
            containerElement
        });

        const traces = Array.isArray(result?.traces) ? result.traces : [];
        for (const tr of traces) {
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
                traceMap.set(name, {
                    x: [],
                    y: [],
                    type: 'scatter',
                    mode: 'lines',
                    name,
                    showlegend: true,
                    line: tr?.line || { width: 2 }
                });
            }
            const agg = traceMap.get(name);
            agg.x.push(shift);
            agg.y.push(mtfVal);
        }
    }

    const traces = Array.from(traceMap.values());
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

    reportProgress(98, 'Rendering plot...');
    await plotly.newPlot(containerEl, traces, layout, { responsive: true, displaylogo: false });
    reportProgress(100, 'Done');
    return { traces, layout };
}
/**
 * PSF Object選択肢のセットアップ
 */

export { showMTFDiagram, showThroughFocusMTFDiagram };
