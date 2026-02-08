// Import data utility functions
import { getOpticalSystemRows, getObjectRows, getSourceRows } from '../utils/data-utils.js';

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

async function showMTFDiagram({ wavelengthMicrons, objectIndex, maxFrequencyLpmm, samplingSize, samplingPoints, containerElement, onProgress, opdDisplayMode } = {}) {
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

    const containerEl = containerElement || document.getElementById('mtf-container');
    if (!containerEl) {
        throw new Error('MTF container element not found');
    }
    try { containerEl.innerHTML = ''; } catch (_) {}

    reportProgress(0, 'Starting...');

    // Prefer Plotly from the container's window (popup), fallback to opener.
    const plotly = containerEl?.ownerDocument?.defaultView?.Plotly || (typeof window !== 'undefined' ? window.Plotly : null);
    if (!plotly) {
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
    const opticalSystemRows = getOpticalSystemRows(window.tableOpticalSystem);
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

        // Use the same fixed OPD definition as OPD/PSF (referenceSphere, no Zernike fit, piston+tilt removed).
        const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, samplingSizeForPSF, 'circular', {
            recordRays: false,
            progressEvery: 512,
            zernikeMaxNoll: 37,
            renderFromZernike: false,
            skipZernikeFit: true,
            opdMode: 'referenceSphere',
            opdDisplayMode: effectiveOpdDisplayMode,
            onProgress: onWavefrontProgress
        });
        if (wavefrontMap?.error) {
            throw new Error(wavefrontMap.error?.message || 'Wavefront generation failed');
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
            forceImplementation: null,
            // OPD grid is already piston+tilt removed by opdDisplayMode.
            removeTilt: false
        });

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

        const real = Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => safeNumber(psf2D[y][x], 0)));
        const imag = Array.from({ length: N }, () => Array.from({ length: N }, () => 0));
        const otf = SimpleFFT.fft2D(real, imag);
        const dcRe = safeNumber(otf?.real?.[0]?.[0], 0);
        const dcIm = safeNumber(otf?.imag?.[0]?.[0], 0);
        const dcMag = Math.hypot(dcRe, dcIm);
        if (!Number.isFinite(dcMag) || dcMag <= 0) {
            throw new Error('Invalid OTF DC component');
        }

        const dfCyclesPerMicron = 1.0 / (N * pixelSizeMicrons);
        const dfLpmm = dfCyclesPerMicron * 1000.0;
        const nyquistLpmm = 0.5 / pixelSizeMicrons * 1000.0;
        const maxPlotLpmm = (maxLpmm > 0) ? Math.min(maxLpmm, nyquistLpmm) : nyquistLpmm;
        maxPlotLpmmGlobal = Math.max(maxPlotLpmmGlobal, maxPlotLpmm);

        const maxBin = Math.floor(N / 2);
        const kMax = Math.max(0, Math.min(maxBin, Math.floor(maxPlotLpmm / (dfLpmm || 1e-9))));

        const sample1DAxis = (axis) => {
            const freq = [];
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
                freq.push(f);
                mtfVals.push(Number.isFinite(mtf) ? mtf : null);
            }
            if (mtfVals.length > 0) mtfVals[0] = 1.0;
            return { freq, mtfVals };
        };

        const tan = sample1DAxis(tanAxis);
        const sag = sample1DAxis(sagAxis);

        const color = getColorForWavelength(wlLocal);
        traces.push({
            x: tan.freq,
            y: tan.mtfVals,
            type: 'scatter',
            mode: 'lines',
            name: `M (${titleNmLocal}nm)`,
            showlegend: true,
            line: { color, width: 2, dash: 'solid' }
        });
        traces.push({
            x: sag.freq,
            y: sag.mtfVals,
            type: 'scatter',
            mode: 'lines',
            name: `S (${titleNmLocal}nm)`,
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

    reportProgress(95, 'Rendering plot...');
    await plotly.newPlot(containerEl, traces, layout, { responsive: true, displaylogo: false });
    reportProgress(100, 'Done');
}

/**
 * PSF Object選択肢のセットアップ
 */

export { showMTFDiagram };
