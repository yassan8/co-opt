/**
 * このファイルは `eva-wavefront.js` に定義された光学計算（OPDやWλ）を利用して、
 * Plotly.js を使った 3D可視化（サーフェスプロットやヒートマップ）を行う責務を持つ。
 *
 * 計算ロジックと描画を分離することで次のメリットがある：
 * - 描画表現の変更（Plotly → Three.js等）が容易になる
 * - 波面収差計算アルゴリズムを何度でも再利用できる
 * - 可視化処理に集中して開発ができる
 *
 * このファイルでは HTML上で `Plotly.newPlot()` を使って OPDやW_lambda を視覚的に表示する。
 * データ生成には `eva-wavefront.js` をimportして使用する。
 */

// @ts-nocheck

/**
 * 波面収差プロット生成クラス
 * Plotly.jsを使用した3D可視化を担当
 */
import { loadSystemConfigurations } from '../../data/table-configuration.ts';
import { saveLastWavefrontSnapshot } from './wavefront-snapshot-storage.ts';
import { setLastWavefrontState, getLastWavefrontMeta } from './last-wavefront-runtime.ts';
import { createOPDCalculator, createWavefrontAnalyzer } from './wavefront.ts';

export class WavefrontPlotter {
    constructor(containerElementIdOrElement) {
        this.containerElementIdOrElement = containerElementIdOrElement;
        this.plotlyConfig = {
            displayModeBar: true,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d'],
            responsive: true
        };
    }

    _createWavefrontEngine(opticalSystemRows, wavelength = 0.5876) {
        const globalWindow = (typeof window !== 'undefined') ? window : null;
        const hostWindow = globalWindow?.opener || globalWindow;

        const calculatorFactory =
            (typeof hostWindow?.createOPDCalculator === 'function' && hostWindow.createOPDCalculator)
            || (typeof globalWindow?.createOPDCalculator === 'function' && globalWindow.createOPDCalculator)
            || createOPDCalculator;

        const analyzerFactory =
            (typeof hostWindow?.createWavefrontAnalyzer === 'function' && hostWindow.createWavefrontAnalyzer)
            || (typeof globalWindow?.createWavefrontAnalyzer === 'function' && globalWindow.createWavefrontAnalyzer)
            || createWavefrontAnalyzer;

        const calculator = calculatorFactory ? calculatorFactory(opticalSystemRows, wavelength) : null;
        if (!calculator) {
            throw new Error('波面収差計算機の初期化に失敗しました: OPDCalculator を作成できません');
        }

        const analyzer = analyzerFactory ? analyzerFactory(calculator) : null;
        if (!analyzer) {
            throw new Error('波面収差計算機の初期化に失敗しました: WavefrontAnalyzer を作成できません');
        }

        return { calculator, analyzer };
    }

    _resolveHostWindow() {
        const globalWindow = (typeof window !== 'undefined') ? window : null;
        return globalWindow?.opener || globalWindow;
    }

    _buildWavefrontMapFromOpdGrid(opdGrid, wavelength = 0.5876) {
        const n = Array.isArray(opdGrid) ? opdGrid.length : 0;
        const axis = n > 1
            ? Array.from({ length: n }, (_, i) => -1 + (2 * i) / (n - 1))
            : [0];

        const pupilCoordinates = [];
        const opdsMicrons = [];
        const opdsWaves = [];
        for (let iy = 0; iy < n; iy++) {
            const row = Array.isArray(opdGrid[iy]) ? opdGrid[iy] : [];
            for (let ix = 0; ix < row.length; ix++) {
                const raw = row[ix];
                if (raw === null || raw === undefined) continue;
                const v = Number(raw);
                if (!Number.isFinite(v)) continue;
                const x = axis[Math.min(ix, axis.length - 1)] ?? 0;
                const y = axis[Math.min(iy, axis.length - 1)] ?? 0;
                pupilCoordinates.push({ x, y, ix, iy });
                opdsWaves.push(v);
                opdsMicrons.push(v * wavelength);
            }
        }

        const stats = (values) => {
            if (!Array.isArray(values) || values.length === 0) {
                return { count: 0, sampleCount: 0, mean: NaN, rms: NaN, peakToPeak: NaN, min: NaN, max: NaN };
            }
            let sum = 0;
            let sumSq = 0;
            let min = Infinity;
            let max = -Infinity;
            let count = 0;
            for (const v of values) {
                if (!Number.isFinite(v)) continue;
                sum += v;
                sumSq += v * v;
                if (v < min) min = v;
                if (v > max) max = v;
                count += 1;
            }
            if (count === 0) {
                return { count: 0, sampleCount: 0, mean: NaN, rms: NaN, peakToPeak: NaN, min: NaN, max: NaN };
            }
            const mean = sum / count;
            return {
                count,
                sampleCount: count,
                mean,
                rms: Math.sqrt(Math.max(0, sumSq / count)),
                peakToPeak: max - min,
                min,
                max,
            };
        };

        const statsWaves = stats(opdsWaves);
        const statsMicrons = stats(opdsMicrons);

        return {
            pupilCoordinates,
            pupilRange: 1.0,
            opds: opdsMicrons,
            opdsInWavelengths: opdsWaves,
            wavefrontAberrations: opdsWaves,
            raw: {
                opds: opdsMicrons.slice(),
                opdsInWavelengths: opdsWaves.slice(),
                wavefrontAberrations: opdsWaves.slice(),
                opdGrid,
                opdMicrons: statsMicrons,
                opdWavelengths: statsWaves,
            },
            display: {
                opds: opdsMicrons.slice(),
                opdsInWavelengths: opdsWaves.slice(),
                wavefrontAberrations: opdsWaves.slice(),
                opdGrid,
            },
            statistics: {
                wavefront: statsWaves,
                opdMicrons: statsMicrons,
                opdWavelengths: statsWaves,
                raw: {
                    wavefront: statsWaves,
                    opdMicrons: statsMicrons,
                    opdWavelengths: statsWaves,
                },
                display: {
                    opdMicrons: statsMicrons,
                    opdWavelengths: statsWaves,
                },
            },
        };
    }

    _buildGridFromSamples(pupilCoordinates, sampleValues, gridSize) {
        const n = Math.max(1, Math.floor(Number(gridSize) || 1));
        const out = Array.from({ length: n }, () => Array.from({ length: n }, () => null));
        if (!Array.isArray(pupilCoordinates) || !Array.isArray(sampleValues)) return out;
        const m = Math.min(pupilCoordinates.length, sampleValues.length);
        for (let i = 0; i < m; i++) {
            const p = pupilCoordinates[i];
            const v = Number(sampleValues[i]);
            if (!p || !Number.isFinite(v)) continue;
            const ix = Number.isInteger(p?.ix) ? p.ix : Math.round(((Number(p?.x) + 1) * 0.5) * (n - 1));
            const iy = Number.isInteger(p?.iy) ? p.iy : Math.round(((Number(p?.y) + 1) * 0.5) * (n - 1));
            if (!Number.isFinite(ix) || !Number.isFinite(iy)) continue;
            if (iy < 0 || iy >= n || ix < 0 || ix >= n) continue;
            out[iy][ix] = v;
        }
        return out;
    }

    _applyNativeZernikePostProcess(wavefrontMap, analyzer, options = {}) {
        const wavelength = Number(options?.wavelength);
        const opdDisplayMode = String(options?.opdDisplayMode || 'pistonTiltRemoved');
        const skipZernikeFit = !!options?.skipZernikeFit;
        const maxNoll = Number.isFinite(Number(options?.zernikeMaxNoll))
            ? Math.max(1, Math.floor(Number(options.zernikeMaxNoll)))
            : 37;

        wavefrontMap.opdMode = 'simple';
        wavefrontMap.opdDisplayModeRequested = opdDisplayMode;
        wavefrontMap.skipZernikeFit = skipZernikeFit;

        if (skipZernikeFit) {
            wavefrontMap.zernike = null;
        } else {
            const sampleCount = Array.isArray(wavefrontMap?.raw?.opds) ? wavefrontMap.raw.opds.length : 0;
            const zernikeMaxNoll = Math.max(1, Math.min(maxNoll, sampleCount));
            wavefrontMap.zernike = analyzer.fitZernikePolynomials({
                pupilCoordinates: wavefrontMap.pupilCoordinates,
                opds: wavefrontMap.raw.opds,
            }, zernikeMaxNoll);
        }

        if (wavefrontMap?.zernike?.removedModelMicrons?.length === wavefrontMap?.opds?.length) {
            for (let k = 0; k < wavefrontMap.opds.length; k++) {
                const rawOpdUm = Number(wavefrontMap.raw.opds[k]);
                const modelUm = Number(wavefrontMap.zernike.removedModelMicrons[k]);
                const correctedUm = (Number.isFinite(rawOpdUm) && Number.isFinite(modelUm)) ? (rawOpdUm - modelUm) : NaN;
                wavefrontMap.opds[k] = correctedUm;
                wavefrontMap.opdsInWavelengths[k] = (Number.isFinite(correctedUm) && Number.isFinite(wavelength) && wavelength > 0)
                    ? (correctedUm / wavelength)
                    : NaN;
                wavefrontMap.wavefrontAberrations[k] = wavefrontMap.opdsInWavelengths[k];
            }
        }

        let display = null;
        let displayStats = null;
        if (opdDisplayMode === 'pistonTiltRemoved') {
            const fit = analyzer._removeBestFitPlane(wavefrontMap.pupilCoordinates, wavefrontMap.opds);
            if (fit && Array.isArray(fit.residualMicrons) && Array.isArray(fit.residualWaves)) {
                display = {
                    mode: 'pistonTiltRemoved',
                    planeCoefficientsMicrons: fit.coefficientsMicrons,
                    opds: fit.residualMicrons,
                    opdsInWavelengths: fit.residualWaves,
                    wavefrontAberrations: fit.residualWaves,
                };
                displayStats = {
                    mode: 'pistonTiltRemoved',
                    planeCoefficientsMicrons: fit.coefficientsMicrons,
                    opdMicrons: analyzer.calculateStatistics(fit.residualMicrons, { removePiston: false }),
                    opdWavelengths: analyzer.calculateStatistics(fit.residualWaves, { removePiston: false }),
                };
            } else {
                // Fallback: remove piston/tilt via low-order Zernike fit if plane fit is unavailable.
                const lowPt = analyzer._calculateLowOrderRemovedStats(
                    wavefrontMap.pupilCoordinates,
                    wavefrontMap.opds,
                    { removeIndices: [0, 1, 2], maxOrder: 2, pupilRange: wavefrontMap.pupilRange }
                );
                if (lowPt && Array.isArray(lowPt.residualMicrons) && Array.isArray(lowPt.residualWaves)) {
                    display = {
                        mode: 'pistonTiltRemoved',
                        opds: lowPt.residualMicrons,
                        opdsInWavelengths: lowPt.residualWaves,
                        wavefrontAberrations: lowPt.residualWaves,
                    };
                    displayStats = {
                        mode: 'pistonTiltRemoved',
                        opdMicrons: analyzer.calculateStatistics(lowPt.residualMicrons, { removePiston: false }),
                        opdWavelengths: analyzer.calculateStatistics(lowPt.residualWaves, { removePiston: false }),
                    };
                }
            }
        } else if (opdDisplayMode === 'pistonTiltDefocusRemoved') {
            const low = analyzer._calculateLowOrderRemovedStats(
                wavefrontMap.pupilCoordinates,
                wavefrontMap.opds,
                { removeIndices: [0, 1, 2, 4], maxOrder: 2, pupilRange: wavefrontMap.pupilRange }
            );
            if (low && Array.isArray(low.residualMicrons) && Array.isArray(low.residualWaves)) {
                display = {
                    mode: 'pistonTiltDefocusRemoved',
                    opds: low.residualMicrons,
                    opdsInWavelengths: low.residualWaves,
                    wavefrontAberrations: low.residualWaves,
                };
                displayStats = {
                    mode: 'pistonTiltDefocusRemoved',
                    opdMicrons: analyzer.calculateStatistics(low.residualMicrons, { removePiston: false }),
                    opdWavelengths: analyzer.calculateStatistics(low.residualWaves, { removePiston: false }),
                };
            }
        }

        if (!display || !displayStats) {
            display = {
                mode: 'default',
                opds: wavefrontMap.opds.slice(),
                opdsInWavelengths: wavefrontMap.opdsInWavelengths.slice(),
                wavefrontAberrations: wavefrontMap.wavefrontAberrations.slice(),
            };
            // If caller requested a removal mode but solver failed, at least center piston
            // so UI does not report a misleading huge mean.
            if (opdDisplayMode !== 'default') {
                const centeredMicrons = display.opds.slice();
                let sum = 0;
                let count = 0;
                for (const v of centeredMicrons) {
                    if (!Number.isFinite(v)) continue;
                    sum += v;
                    count += 1;
                }
                const mean = count > 0 ? (sum / count) : 0;
                for (let i = 0; i < centeredMicrons.length; i++) {
                    const v = centeredMicrons[i];
                    centeredMicrons[i] = Number.isFinite(v) ? (v - mean) : NaN;
                }
                display.opds = centeredMicrons;
                display.opdsInWavelengths = centeredMicrons.map((v) =>
                    (Number.isFinite(v) && Number.isFinite(wavelength) && wavelength > 0) ? (v / wavelength) : NaN
                );
                display.wavefrontAberrations = display.opdsInWavelengths.slice();
                display.mode = `${opdDisplayMode} (piston-only fallback)`;
            }
            displayStats = {
                mode: display.mode || 'default',
                opdMicrons: analyzer.calculateStatistics(display.opds, { removePiston: false }),
                opdWavelengths: analyzer.calculateStatistics(display.opdsInWavelengths, { removePiston: false }),
            };
        }

        const n = Array.isArray(wavefrontMap?.raw?.opdGrid) ? wavefrontMap.raw.opdGrid.length : 0;
        display.opdGrid = this._buildGridFromSamples(wavefrontMap.pupilCoordinates, display.opdsInWavelengths, n);
        wavefrontMap.display = display;

        const lowOrderRemoved = analyzer._calculateLowOrderRemovedStats(
            wavefrontMap.pupilCoordinates,
            wavefrontMap.raw.opds,
            { removeIndices: [0, 1, 2, 4], maxOrder: 2, pupilRange: wavefrontMap.pupilRange }
        );

        const usedOpdMode = wavefrontMap.opdMode || 'simple';
        const usedSkipZernikeFit = !!wavefrontMap.skipZernikeFit;
        const mode = wavefrontMap.pupilSamplingMode || null;

        wavefrontMap.statistics = {
            wavefront: analyzer.calculateStatistics(wavefrontMap.wavefrontAberrations, { removePiston: true }),
            opdMicrons: displayStats.opdMicrons,
            opdWavelengths: displayStats.opdWavelengths,
            raw: {
                wavefront: analyzer.calculateStatistics(wavefrontMap.raw.wavefrontAberrations, { removePiston: false }),
                opdMicrons: analyzer.calculateStatistics(wavefrontMap.raw.opds, { removePiston: false }),
                opdWavelengths: analyzer.calculateStatistics(wavefrontMap.raw.opdsInWavelengths, { removePiston: false }),
            },
            aberration: lowOrderRemoved,
            display: displayStats,
        };

        const statsTargets = [
            wavefrontMap.statistics?.wavefront,
            wavefrontMap.statistics?.opdMicrons,
            wavefrontMap.statistics?.opdWavelengths,
            wavefrontMap.statistics?.raw?.wavefront,
            wavefrontMap.statistics?.raw?.opdMicrons,
            wavefrontMap.statistics?.raw?.opdWavelengths,
            wavefrontMap.statistics?.display?.opdMicrons,
            wavefrontMap.statistics?.display?.opdWavelengths,
            wavefrontMap.statistics?.aberration?.opdMicrons,
            wavefrontMap.statistics?.aberration?.opdWavelengths,
        ];
        for (const st of statsTargets) {
            if (!st || typeof st !== 'object') continue;
            st.pupilSamplingMode = mode;
            st.opdMode = usedOpdMode;
            st.skipZernikeFit = usedSkipZernikeFit;
        }
        if (wavefrontMap.statistics?.display?.opdMicrons) {
            wavefrontMap.statistics.display.opdMicrons.opdDisplayMode = opdDisplayMode;
        }
        if (wavefrontMap.statistics?.display?.opdWavelengths) {
            wavefrontMap.statistics.display.opdWavelengths.opdDisplayMode = opdDisplayMode;
        }
        if (wavefrontMap.statistics?.aberration?.opdMicrons && wavefrontMap.statistics?.aberration?.removeIndices) {
            wavefrontMap.statistics.aberration.opdMicrons.removeIndices = wavefrontMap.statistics.aberration.removeIndices;
        }
        if (wavefrontMap.statistics?.aberration?.opdWavelengths && wavefrontMap.statistics?.aberration?.removeIndices) {
            wavefrontMap.statistics.aberration.opdWavelengths.removeIndices = wavefrontMap.statistics.aberration.removeIndices;
        }
    }

    async _computeNativeOpdWavefrontMap(opticalSystemRows, fieldSetting, gridSize, options = {}) {
        const emitProgress = (percent, message) => {
            try {
                if (typeof options?.onProgress === 'function') {
                    options.onProgress({ percent, message, phase: 'opd-native' });
                }
            } catch (_) {}
        };

        emitProgress(5, 'Checking Rust/WASM OPD runtime...');

        emitProgress(10, 'Loading native OPD bridge...');
        const { runNativeOpdMap } = await import('../../src/desktop/ipc/client.ts');
        const host = this._resolveHostWindow();
        emitProgress(16, 'Collecting optical/source/object rows...');
        const sourceRows = (host && typeof host.getSourceRows === 'function') ? host.getSourceRows() : [];
        const objectRows = (host && typeof host.getObjectRows === 'function') ? host.getObjectRows() : [];
        const objectIndex = Number.isInteger(Number(fieldSetting?.objectIndex)) ? Number(fieldSetting.objectIndex) : 0;
        const resolveForcedInfinitePupilMode = () => {
            const sanitize = (v) => {
                const s = (typeof v === 'string') ? v.trim().toLowerCase() : '';
                return (s === 'stop' || s === 'entrance') ? s : '';
            };
            try {
                const fromGlobal = globalThis?.__COOPT_FORCE_INFINITE_PUPIL_MODE ?? globalThis?.COOPT_FORCE_INFINITE_PUPIL_MODE;
                const g = sanitize(fromGlobal);
                if (g) return g;
            } catch (_) {}
            try {
                const fromStorage = localStorage.getItem('coopt.forceInfinitePupilMode');
                return sanitize(fromStorage);
            } catch (_) {
                return '';
            }
        };
        const forcedInfinitePupilMode = resolveForcedInfinitePupilMode();
        const selectedObject = (Array.isArray(objectRows) && objectRows[objectIndex]) ? objectRows[objectIndex] : null;
        const objectPositionRaw = String(
            selectedObject?.position
            ?? selectedObject?.object
            ?? selectedObject?.objectType
            ?? selectedObject?.type
            ?? fieldSetting?.type
            ?? ''
        ).trim().toLowerCase();
        const requestEntrancePupilSampling = (
            objectPositionRaw.includes('angle')
            || objectPositionRaw === 'point'
            || String(fieldSetting?.type || '').trim().toLowerCase() === 'angle'
        );
        const fieldAngleX = Number(selectedObject?.xHeightAngle ?? selectedObject?.xFieldAngle ?? selectedObject?.xAngle ?? fieldSetting?.fieldAngle?.x ?? 0);
        const fieldAngleY = Number(selectedObject?.yHeightAngle ?? selectedObject?.yFieldAngle ?? selectedObject?.yAngle ?? selectedObject?.fieldAngle ?? fieldSetting?.fieldAngle?.y ?? 0);
        const isNonZeroAngleField = Math.abs(fieldAngleX) > 1e-12 || Math.abs(fieldAngleY) > 1e-12;
        const requestedPupilSamplingMode = (forcedInfinitePupilMode === 'stop' || forcedInfinitePupilMode === 'entrance')
            ? forcedInfinitePupilMode
            : (requestEntrancePupilSampling && isNonZeroAngleField ? 'entrance' : undefined);

        const normalizedGridSize = (() => {
            const n = Number(gridSize);
            if (!Number.isFinite(n)) return 129;
            return Math.max(17, Math.floor(n));
        })();

        const requestedGridSize = Number.isFinite(Number(gridSize)) ? Math.floor(Number(gridSize)) : 129;
        if (requestedGridSize < 17 && requestedGridSize !== normalizedGridSize) {
            emitProgress(
                20,
                `Grid request raised to minimum for native compute (${requestedGridSize} -> ${normalizedGridSize})`,
            );
        }

        emitProgress(25, `Tracing rays in native Rust (grid=${normalizedGridSize})...`);
        const jobId = `native-opd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let unlistenProgress = null;
        try {
            const { listen } = await import('@tauri-apps/api/event');
            unlistenProgress = await listen('analysis-progress', (event) => {
                try {
                    const data = event?.payload || {};
                    if (!data || String(data.jobId || '') !== jobId) return;
                    emitProgress(data.percent, data.phase || 'opd-native', data.message || 'Tracing rays in native Rust...');
                } catch (_) {}
            });
        } catch (_) {
            // Event bridge is optional; fallback still works with coarse local progress.
        }
        let response;
        try {
            const reqWavelengthUm = Number(fieldSetting?.wavelength);
            response = await runNativeOpdMap({
                jobId,
                opticalSystemRows: Array.isArray(opticalSystemRows) ? opticalSystemRows : [],
                sourceRows: Array.isArray(sourceRows) ? sourceRows : [],
                objectRows: Array.isArray(objectRows) ? objectRows : [],
                objectIndex,
                wavelengthUm: Number.isFinite(reqWavelengthUm) && reqWavelengthUm > 0 ? reqWavelengthUm : undefined,
                gridSize: normalizedGridSize,
                pupilSamplingMode: requestedPupilSamplingMode,
                opdDisplayMode: options?.opdDisplayMode || 'pistonTiltRemoved',
            });
        } finally {
            try {
                if (typeof unlistenProgress === 'function') {
                    unlistenProgress();
                }
            } catch (_) {}
        }
        try { console.log('🧭 [OPD Backend] native', response?.backend, { gridSize: response?.gridSize, hitCount: response?.hitCount }); } catch (_) {}
        const hitCount = Number(response?.hitCount) || 0;
        const sampleCount = Number(response?.sampleCount) || 0;
        const hitRate = sampleCount > 0 ? ((hitCount / sampleCount) * 100) : 0;
        const hitRateText = Number.isFinite(hitRate) ? hitRate.toFixed(1) : '0.0';
        emitProgress(75, `Converting OPD map (hits=${hitCount}/${sampleCount}, valid=${hitRateText}%)...`);

        const hasFiniteInGrid = (g) => {
            if (!Array.isArray(g) || g.length === 0) return false;
            for (const row of g) {
                if (!Array.isArray(row)) continue;
                for (const v of row) {
                    if (Number.isFinite(Number(v))) return true;
                }
            }
            return false;
        };

        const displayGrid = Array.isArray(response?.displayOpdGrid) ? response.displayOpdGrid : [];
        const rawGrid = Array.isArray(response?.rawOpdGrid) ? response.rawOpdGrid : [];
        const usingDisplayGrid = hasFiniteInGrid(displayGrid);
        const grid = usingDisplayGrid ? displayGrid : rawGrid;
        if (!usingDisplayGrid) {
            try {
                console.warn('⚠️ [OPD Native] display grid had no finite samples; falling back to raw grid', {
                    backend: response?.backend,
                    message: response?.message,
                    hitCount: response?.hitCount,
                    sampleCount: response?.sampleCount,
                });
            } catch (_) {}
        }
        if (!grid.length || !Array.isArray(grid[0]) || !hasFiniteInGrid(grid)) {
            throw new Error('Native OPD map is empty');
        }

        const wavelength = Number(fieldSetting?.wavelength) || 0.5876;
        const rawGridForMap = hasFiniteInGrid(rawGrid) ? rawGrid : grid;

        // Important parity rule:
        // - Native OPD already returns display-space and raw-space grids.
        // - Re-applying TS-side Zernike/plane removal changes numerics and drifts from native.
        // So we only remap native grids into the wavefront map schema here.
        const rawMap = this._buildWavefrontMapFromOpdGrid(rawGridForMap, wavelength);
        const displayMap = this._buildWavefrontMapFromOpdGrid(grid, wavelength);

        const map = {
            ...displayMap,
            raw: {
                ...(rawMap?.raw || {}),
                opdGrid: rawGridForMap,
            },
            display: {
                ...(displayMap?.display || {}),
                mode: options?.opdDisplayMode || 'pistonTiltRemoved',
                opdGrid: grid,
            },
            statistics: {
                ...(displayMap?.statistics || {}),
                raw: {
                    ...(rawMap?.statistics?.raw || {}),
                },
                display: {
                    ...(displayMap?.statistics?.display || {}),
                    opdDisplayMode: options?.opdDisplayMode || 'pistonTiltRemoved',
                },
            },
            zernike: null,
            opdMode: 'native-grid',
            opdDisplayModeRequested: options?.opdDisplayMode || 'pistonTiltRemoved',
            skipZernikeFit: true,
        };
        try {
            const mode = options?.opdDisplayMode || 'pistonTiltRemoved';
            const responseMode = String(response?.pupilSamplingMode || '').toLowerCase();
            const pupilSamplingMode = (responseMode === 'stop' || responseMode === 'entrance')
                ? responseMode
                : (String(response?.message || '').includes('stop -> entrance') ? 'entrance' : 'stop');
            const chiefReferenceMode = String(response?.chiefReferenceMode || '').trim();
            const backend = String(response?.backend || '').trim();
            map.pupilSamplingMode = pupilSamplingMode;
            const statsTargets = [
                map?.statistics?.wavefront,
                map?.statistics?.opdMicrons,
                map?.statistics?.opdWavelengths,
                map?.statistics?.raw?.wavefront,
                map?.statistics?.raw?.opdMicrons,
                map?.statistics?.raw?.opdWavelengths,
                map?.statistics?.display?.opdMicrons,
                map?.statistics?.display?.opdWavelengths,
            ];
            for (const st of statsTargets) {
                if (!st || typeof st !== 'object') continue;
                st.pupilSamplingMode = pupilSamplingMode;
                st.opdDisplayMode = mode;
                if (chiefReferenceMode) st.chiefReferenceMode = chiefReferenceMode;
                if (backend) st.backend = backend;
                // Add diagnostic metadata from WASM response
                if (Number.isFinite(Number(response?.wavelengthUm))) {
                    st.wavelengthUm = Number(response.wavelengthUm);
                    st.wavelengthNm = Number(response.wavelengthUm) * 1000;
                }
                if (Number.isFinite(Number(response?.gridSize))) {
                    st.gridSize = Number(response.gridSize);
                }
                if (Number.isInteger(Number(response?.targetSurface))) {
                    st.targetSurface = Number(response.targetSurface);
                }
                if (Number.isInteger(Number(response?.stopSurface))) {
                    st.stopSurface = Number(response.stopSurface);
                }
                if (Number.isFinite(Number(response?.usedObjectX))) {
                    st.usedObjectX = Number(response.usedObjectX);
                }
                if (Number.isFinite(Number(response?.usedObjectY))) {
                    st.usedObjectY = Number(response.usedObjectY);
                }
                if (response?.usedObjectPosition) {
                    st.usedObjectPosition = String(response.usedObjectPosition);
                }
                st.hitCount = Number(response?.hitCount ?? 0);
                st.sampleCount = Number(response?.sampleCount ?? 0);
            }
            map.nativeMeta = {
                backend: backend || 'run_native_opd_map',
                message: response?.message || null,
                gridSource: usingDisplayGrid ? 'displayOpdGrid' : 'rawOpdGrid',
                hitCount: Number(response?.hitCount ?? 0),
                sampleCount: Number(response?.sampleCount ?? 0),
                pupilSamplingMode,
                chiefReferenceMode: chiefReferenceMode || null,
                wavelengthUm: Number(response?.wavelengthUm ?? 0),
                gridSize: Number(response?.gridSize ?? 0),
                targetSurface: Number(response?.targetSurface ?? 0),
                stopSurface: Number(response?.stopSurface ?? 0),
            };
            try {
                console.log('🧭 [OPD Native] reference policy', {
                    backend: backend || '(unknown)',
                    chiefReferenceMode: chiefReferenceMode || '(unknown)',
                    message: response?.message || null,
                    hitCount: response?.hitCount,
                    sampleCount: response?.sampleCount,
                });
            } catch (_) {}
        } catch (_) {}
        emitProgress(90, `Preparing plot samples (${Number(map?.statistics?.opdWavelengths?.count) || 0})...`);
        return map;
    }

    /**
     * PSFと同じ強度系カラースケール（低→高: 青→緑→赤）
     * Plotlyのcolorscale配列を返す
     */
    static getBlueGreenRedColorscale() {
        return [
            [0.0, 'rgb(0, 0, 255)'],
            [0.5, 'rgb(0, 255, 0)'],
            [1.0, 'rgb(255, 0, 0)']
        ];
    }
    _extractHintText(message) {
        const m = String(message ?? '');
        const idx = m.indexOf('hint=');
        if (idx < 0) return '';
        return m.slice(idx + 'hint='.length).trim();
    }
    _renderCalculationUnavailable(container, {
        title,
        message,
        wavefrontMap,
        fieldSetting,
        extra
    } = {}) {
        try {
            if (!container) return;

            // Make sure the container is visible even if it previously hosted a Plotly plot
            // with size controlled by CSS/layout.
            try {
                container.style.display = 'block';
                container.style.visibility = 'visible';
                // Prevent "blank" appearance when the plot container collapses.
                if (!container.style.minHeight) container.style.minHeight = '120px';
            } catch (_) {}

            // If Plotly was previously rendered here, purge it so it doesn't interfere.
            try {
                const plotly = this.resolvePlotly(container);
                if (plotly && typeof plotly.purge === 'function') {
                    plotly.purge(container);
                }
            } catch (_) {}

            const rawMessage = String(message ?? wavefrontMap?.error?.message ?? '有効な光線データがありません。');
            const hint = this._extractHintText(rawMessage);
            const fieldLabel = (fieldSetting?.displayName || fieldSetting?.id)
                ? String(fieldSetting.displayName ?? fieldSetting.id)
                : 'Field Point';
            const extraText = extra ? String(extra) : '';

            // Make it visible in console logs that we intentionally show a failure panel.
            try {
                console.warn('⚠️ [WavefrontPlotter] calculation unavailable', {
                    title: title || '波面計算不能',
                    field: fieldLabel,
                    message: rawMessage,
                    hint: hint || null
                });
            } catch (_) {}

            container.innerHTML = `
                <div style="padding: 16px; text-align: left; color: #b71c1c; border: 1px solid #d32f2f; border-radius: 6px; background-color: #ffebee;">
                    <h3 style="margin: 0 0 8px 0;">${title || '波面計算不能'}</h3>
                    <div style="margin: 0 0 8px 0; color: #333;">${fieldLabel} では波面/OPD を計算できませんでした（ビネッティング/有効FOV外の可能性）。</div>
                    <pre style="margin: 0; white-space: pre-wrap; word-break: break-word; color: #b71c1c;">${rawMessage}</pre>
                    ${hint ? `<div style=\"margin-top: 10px; color: #333;\"><b>hint</b>: ${hint}</div>` : ''}
                    ${extraText ? `<div style=\"margin-top: 10px; color: #333;\">${extraText}</div>` : ''}
                </div>
            `;
            const stats = this.resolveStatsContainer(container);
            if (stats) stats.textContent = '';
            this._setSystemDataText(
                `Wavefront/OPD unavailable for ${fieldLabel}.\n\n${rawMessage}${hint ? `\n\nhint: ${hint}` : ''}`
            );
        } catch (_) {
            // ignore UI failures
        }
    }

    resolveContainer() {
        if (!this.containerElementIdOrElement) return null;
        if (typeof this.containerElementIdOrElement === 'string') {
            return document.getElementById(this.containerElementIdOrElement);
        }
        return this.containerElementIdOrElement;
    }

    resolvePlotly(container) {
        const doc = container?.ownerDocument;
        const win = doc?.defaultView;
        return win?.Plotly || (typeof Plotly !== 'undefined' ? Plotly : null);
    }

    resolveStatsContainer(container) {
        if (!container) return null;
        const containerId = container.id;
        if (!containerId) return null;
        return container.ownerDocument.getElementById(`${containerId}-stats`);
    }

    _setSystemDataText(text) {
        const trySet = (doc) => {
            const ids = ['system-data', 'systemData', 'popup-system-data'];
            for (const id of ids) {
                const ta = doc?.getElementById?.(id);
                if (ta && typeof ta.value === 'string') {
                    ta.value = text;
                    return true;
                }
            }
            return false;
        };
        try {
            if (trySet(document)) return;
        } catch (_) {}
        try {
            if (window.opener && window.opener.document) {
                if (trySet(window.opener.document)) return;
            }
        } catch (_) {}
    }

    _updateSystemDataWithZernike(analyzer, wavefrontMap, maxNoll = 37) {
        try {
            if (!analyzer || typeof analyzer.formatZernikeReportText !== 'function') return;
            const text = analyzer.formatZernikeReportText(wavefrontMap, { maxNoll });
            // Always write something so the user can see whether the report is missing.
            this._setSystemDataText(typeof text === 'string' ? text : String(text ?? ''));
        } catch (_) {}
    }

    /**
     * 光路差（OPD）の3Dサーフェスプロットを生成
     * @param {Array} opticalSystemRows - 光学系データ
     * @param {Object} fieldSetting - フィールド設定
     * @param {number} wavelength - 波長（μm）
     * @param {number} gridSize - グリッドサイズ（デフォルト: 16）
     * @returns {Promise} プロット生成のPromise
     */
    async plotOPDSurface(opticalSystemRows, fieldSetting, wavelength = 0.5876, gridSize = 16, options = {}) {
        try {
            console.log('🌊 OPD 3Dサーフェスプロット生成開始...');
            const emitProgress = (percent, message) => {
                try {
                    if (typeof options?.onProgress === 'function') {
                        options.onProgress({ percent, message, phase: 'opd-render' });
                    }
                } catch (_) {}
            };
            // Enable profiling automatically when progress UI is active.
            const displayMode = options?.opdDisplayMode || 'pistonTiltRemoved';
            const wavefrontMap = await this._computeNativeOpdWavefrontMap(opticalSystemRows, fieldSetting, gridSize, {
                opdDisplayMode: displayMode,
                onProgress: options?.onProgress || null,
            });

            if (wavefrontMap?.error) {
                this._renderCalculationUnavailable(this.resolveContainer(), {
                    title: 'OPD計算不能',
                    message: wavefrontMap.error?.message,
                    wavefrontMap,
                    fieldSetting
                });
                return wavefrontMap;
            }

            // If there are no valid samples, don't attempt to render a misleading all-zero surface.
            const sampleCount = Array.isArray(wavefrontMap?.raw?.opds) ? wavefrontMap.raw.opds.length : (Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds.length : 0);
            if (!sampleCount) {
                const extra = (() => {
                    try {
                        const counts = wavefrontMap?.invalidReasonCounts;
                        if (counts && typeof counts === 'object') {
                            return `invalid reasons: ${JSON.stringify(counts)}`;
                        }
                    } catch (_) {}
                    return '';
                })();
                console.error('❌ OPD波面データが0点です（全光線失敗）。', wavefrontMap?.invalidReasonCounts || wavefrontMap?.error || {});
                this._renderCalculationUnavailable(this.resolveContainer(), {
                    title: 'OPD計算不能',
                    message: '波面データが0点です（全光線失敗）。',
                    wavefrontMap,
                    fieldSetting,
                    extra
                });
                return wavefrontMap;
            }

            // Debug: report effective pupil coverage.
            try {
                const dbg = (typeof globalThis !== 'undefined') && (globalThis.__OPD_DEBUG === true);
                if (dbg) {
                    const pcs = Array.isArray(wavefrontMap?.pupilCoordinates) ? wavefrontMap.pupilCoordinates : [];
                    let maxRho = 0;
                    let minRho = Infinity;
                    let finite = 0;
                    for (const c of pcs) {
                        const x = Number(c?.x);
                        const y = Number(c?.y);
                        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                        const r = Math.hypot(x, y);
                        if (!Number.isFinite(r)) continue;
                        finite++;
                        if (r > maxRho) maxRho = r;
                        if (r < minRho) minRho = r;
                    }
                    console.log('🔍 [OPD] Pupil coverage', {
                        pupilSamplingMode: wavefrontMap?.pupilSamplingMode,
                        bestEffortVignettedPupil: !!wavefrontMap?.bestEffortVignettedPupil,
                        points: finite,
                        maxRho,
                        minRho: Number.isFinite(minRho) ? minRho : null
                    });
                }
            } catch (_) {}

            const opdGridDisplay = Array.isArray(wavefrontMap?.display?.opdGrid) ? wavefrontMap.display.opdGrid : [];
            const opdGridRaw = Array.isArray(wavefrontMap?.raw?.opdGrid) ? wavefrontMap.raw.opdGrid : [];
            const opdGridForRender = (Array.isArray(opdGridDisplay) && opdGridDisplay.length && Array.isArray(opdGridDisplay[0]))
                ? opdGridDisplay
                : opdGridRaw;
            if (!opdGridForRender.length || !Array.isArray(opdGridForRender[0])) {
                throw new Error('Native OPD grid is unavailable for plotting');
            }
            const n = opdGridForRender.length;
            const maxRenderGrid = 255;
            const renderGridSize = n > maxRenderGrid ? maxRenderGrid : n;
            if (n > renderGridSize) {
                try {
                    console.warn(`⚠️ [OPD] Surface render grid downsampled ${n} -> ${renderGridSize} (compute grid kept at ${n})`);
                } catch (_) {}
            }

            const axis = renderGridSize > 1
                ? Array.from({ length: renderGridSize }, (_, i) => -1 + (2 * i) / (renderGridSize - 1))
                : [0];

            const normalizeGridValue = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? NaN : Number(v));
            const zGrid = (() => {
                const source = opdGridForRender.map((row) =>
                    (Array.isArray(row) ? row : []).map((v) => normalizeGridValue(v))
                );

                if (renderGridSize >= n) {
                    return source;
                }

                const out = Array.from({ length: renderGridSize }, () => Array.from({ length: renderGridSize }, () => NaN));
                for (let yi = 0; yi < renderGridSize; yi++) {
                    const yStart = Math.floor((yi * n) / renderGridSize);
                    const yEnd = Math.max(yStart, Math.min(n - 1, Math.floor(((yi + 1) * n) / renderGridSize) - 1));
                    for (let xi = 0; xi < renderGridSize; xi++) {
                        const xStart = Math.floor((xi * n) / renderGridSize);
                        const xEnd = Math.max(xStart, Math.min(n - 1, Math.floor(((xi + 1) * n) / renderGridSize) - 1));
                        let sum = 0;
                        let count = 0;
                        for (let sy = yStart; sy <= yEnd; sy++) {
                            const row = source[sy] || [];
                            for (let sx = xStart; sx <= xEnd; sx++) {
                                const v = row[sx];
                                if (!Number.isFinite(v)) continue;
                                sum += v;
                                count += 1;
                            }
                        }
                        if (count > 0) {
                            out[yi][xi] = sum / count;
                        }
                    }
                }

                for (let pass = 0; pass < 2; pass++) {
                    const next = out.map((row) => row.slice());
                    for (let yi = 0; yi < renderGridSize; yi++) {
                        for (let xi = 0; xi < renderGridSize; xi++) {
                            if (Number.isFinite(out[yi][xi])) continue;
                            let sum = 0;
                            let count = 0;
                            for (let dy = -1; dy <= 1; dy++) {
                                for (let dx = -1; dx <= 1; dx++) {
                                    if (dx === 0 && dy === 0) continue;
                                    const ny = yi + dy;
                                    const nx = xi + dx;
                                    if (ny < 0 || ny >= renderGridSize || nx < 0 || nx >= renderGridSize) continue;
                                    const nv = out[ny][nx];
                                    if (!Number.isFinite(nv)) continue;
                                    sum += nv;
                                    count += 1;
                                }
                            }
                            if (count >= 5) {
                                next[yi][xi] = sum / count;
                            }
                        }
                    }
                    for (let yi = 0; yi < renderGridSize; yi++) out[yi] = next[yi];
                }

                return out;
            })();
            const surfaceData = {
                type: 'surface',
                x: axis,
                y: axis,
                z: zGrid,
                connectgaps: false,
                colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
                showscale: true,
                colorbar: { title: 'OPD [λ]' },
            };

            // プロット設定
            const layout = {
                title: {
                    text: `Optical Path Difference (OPD) Distribution - ${fieldSetting.displayName || 'Field Point'}`,
                    font: { size: 16 }
                },
                scene: {
                    xaxis: {
                        title: 'Pupil coordinate X',
                        range: [-1.1, 1.1],
                        dtick: 0.5
                    },
                    yaxis: {
                        title: 'Pupil coordinate Y',
                        range: [-1.1, 1.1],
                        dtick: 0.5
                    },
                    zaxis: { title: 'OPD [λ]' },
                    camera: {
                        eye: { x: 1.5, y: 1.5, z: 1.5 }
                    }
                },
                margin: { l: 0, r: 0, b: 0, t: 40 }
            };

            try {
                const container = this.resolveContainer();
                if (!container) {
                    throw new Error('プロットコンテナが見つかりません');
                }
                console.log('✅ プロットコンテナ確認:', container);

                const plotly = this.resolvePlotly(container);
                if (!plotly) {
                    throw new Error('Plotly.jsライブラリが読み込まれていません');
                }

                // データ検証
                this.validatePlotlyData(surfaceData);
                console.log('✅ データ検証完了');

                console.log('🎨 Plotly描画開始:', {
                    container: container.id || '(element)',
                    dataType: surfaceData.type,
                    dataSize: `${surfaceData.z.length}x${surfaceData.z[0]?.length}`
                });

                emitProgress(96, 'Rendering OPD surface...');
                layout.autosize = true;
                await plotly.newPlot(container, [surfaceData], layout, this.plotlyConfig);
                emitProgress(100, 'Completed');
                console.log('✅ OPD 3Dサーフェス描画完了');
            } catch (error) {
                console.error('❌ OPD 3Dサーフェス描画エラー:', error);
                console.log('📊 問題のデータ:', {
                    x: surfaceData.x ? surfaceData.x.length : 'undefined',
                    y: surfaceData.y ? surfaceData.y.length : 'undefined',
                    z: surfaceData.z ? `${surfaceData.z.length}x${surfaceData.z[0]?.length}` : 'undefined'
                });

                // フォールバック：簡易データで描画
                const fallbackData = this.createFallbackSurfaceData('opd');
                const container = this.resolveContainer();
                const plotly = this.resolvePlotly(container);
                if (container && plotly) {
                    layout.autosize = true;
                    await plotly.newPlot(container, [fallbackData], layout, this.plotlyConfig);
                }
                console.log('⚠️ フォールバックデータで描画しました');
            }

            // 統計情報を表示
            {
                // IMPORTANT: Stats must match what is plotted.
                // OPD is fixed to piston+tilt removed display (fallback to raw if missing).
                const stats = wavefrontMap?.statistics?.display?.opdWavelengths
                    ? wavefrontMap.statistics.display.opdWavelengths
                    : (wavefrontMap?.statistics?.raw?.opdWavelengths || wavefrontMap?.statistics?.opdWavelengths);
                this.displayStatistics(stats, 'OPD', 'λ');
            }

            console.log('✅ OPD 3Dサーフェスプロット生成完了');
            return wavefrontMap;

        } catch (error) {
            console.error('❌ OPD プロット生成エラー:', error);
            throw error;
        }
    }

    /**
     * 波面収差（Wλ）の3Dサーフェスプロットを生成
     * @param {Array} opticalSystemRows - 光学系データ
     * @param {Object} fieldSetting - フィールド設定
     * @param {number} wavelength - 波長（μm）
     * @param {number} gridSize - グリッドサイズ（デフォルト: 16）
     * @returns {Promise} プロット生成のPromise
     */
    async plotWavefrontAberrationSurface(opticalSystemRows, fieldSetting, wavelength = 0.5876, gridSize = 16) {
        try {
            console.log('🌊 波面収差（Wλ）3Dサーフェスプロット生成開始...');
            const profileEnabled = (typeof globalThis !== 'undefined' && globalThis.__WAVEFRONT_PROFILE === true);

            const { analyzer } = this._createWavefrontEngine(opticalSystemRows, wavelength);

            const diagnoseDiscontinuities = (typeof globalThis !== 'undefined' && globalThis.__WAVEFRONT_DIAG_DISCONTINUITIES === true);

            // 波面収差マップを生成
            if (profileEnabled) console.time('⏱️ plotWavefrontSurface.generateWavefrontMap');
            const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', {
                recordRays: false,
                progressEvery: 512,
                diagnoseDiscontinuities,
                diagTopK: 5,
                // Use simple OPD (no reference-sphere correction).
                opdMode: 'simple',
                zernikeMaxNoll: 37,
                renderFromZernike: true,
                profile: profileEnabled
            });
            if (profileEnabled) console.timeEnd('⏱️ plotWavefrontSurface.generateWavefrontMap');

            if (wavefrontMap?.error) {
                this._renderCalculationUnavailable(this.resolveContainer(), {
                    title: '波面計算不能',
                    message: wavefrontMap.error?.message,
                    wavefrontMap,
                    fieldSetting
                });
                return wavefrontMap;
            }

            const sampleCount = Array.isArray(wavefrontMap?.raw?.opds) ? wavefrontMap.raw.opds.length : (Array.isArray(wavefrontMap?.opds) ? wavefrontMap.opds.length : 0);
            if (!sampleCount) {
                const extra = (() => {
                    try {
                        const counts = wavefrontMap?.invalidReasonCounts;
                        if (counts && typeof counts === 'object') {
                            return `invalid reasons: ${JSON.stringify(counts)}`;
                        }
                    } catch (_) {}
                    return '';
                })();
                console.error('❌ 波面データが0点です（全光線失敗）。', wavefrontMap?.invalidReasonCounts || wavefrontMap?.error || {});
                this._renderCalculationUnavailable(this.resolveContainer(), {
                    title: '波面計算不能',
                    message: '波面データが0点です（全光線失敗）。',
                    wavefrontMap,
                    fieldSetting,
                    extra
                });
                return wavefrontMap;
            }

            // Keep System Data consistent with Heatmap mode
            // Do not write System Data by default for OPD.
            // (OPD popup has an explicit checkbox that pushes Zernike report.)
            if (options?.updateSystemData === true) {
                this._updateSystemDataWithZernike(analyzer, wavefrontMap, 37);
            }

            // Plotly用のデータに変換
            // 3D surfaceの円周ギザギザを抑えるため、Zernike関数面を高密度サンプリングして描画（計算グリッドは変更しない）
            let surfaceData;
            try {
                const baseG = Math.floor(Number(wavefrontMap?.gridSize)) || 16;
                const renderGridMax = (typeof globalThis !== 'undefined' && Number.isFinite(globalThis.__WAVEFRONT_RENDER_GRID_MAX))
                    ? Math.max(33, Math.floor(Number(globalThis.__WAVEFRONT_RENDER_GRID_MAX)))
                    : 257;
                const renderGridScale = (typeof globalThis !== 'undefined' && Number.isFinite(globalThis.__WAVEFRONT_RENDER_GRID_SCALE))
                    ? Math.max(1, Number(globalThis.__WAVEFRONT_RENDER_GRID_SCALE))
                    : 3;
                const renderG = Math.max(129, Math.min(renderGridMax, Math.floor(baseG * renderGridScale - 2)));

                let dense = null;
                if (wavefrontMap?.renderFromZernike && typeof analyzer.generateZernikeRenderGrid === 'function') {
                    if (profileEnabled) console.time('⏱️ plotWavefrontSurface.generateZernikeRenderGrid');
                    const useWavefrontMask = (wavefrontMap?.pupilSamplingMode && wavefrontMap.pupilSamplingMode !== 'finite');
                    dense = analyzer.generateZernikeRenderGrid(wavefrontMap, renderG, 'wavefront', { rhoMax: 0.99, useWavefrontMask });
                    if (profileEnabled) console.timeEnd('⏱️ plotWavefrontSurface.generateZernikeRenderGrid');
                }
                if (dense && dense.x && dense.y && dense.z) {
                    surfaceData = {
                        type: 'surface',
                        x: dense.x,
                        y: dense.y,
                        z: dense.z,
                        colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
                        showscale: true,
                        colorbar: { title: 'Wλ [波長]' },
                        flatshading: false,
                        lighting: {
                            ambient: 0.85,
                            diffuse: 0.85,
                            specular: 0.03,
                            roughness: 0.95,
                            fresnel: 0.05
                        }
                    };
                } else {
                    surfaceData = this.convertToPlotlySurfaceData(wavefrontMap, 'wavefront', { rawMode: false });
                }
            } catch (_) {
                surfaceData = this.convertToPlotlySurfaceData(wavefrontMap, 'wavefront', { rawMode: false });
            }

            // プロット設定
            const layout = {
                title: {
                    text: `Wavefront Aberration (Wλ) Distribution - ${fieldSetting.displayName || 'Field Point'}`,
                    font: { size: 16 }
                },
                scene: {
                    xaxis: {
                        title: 'Pupil coordinate X',
                        range: [-1.1, 1.1],
                        dtick: 0.5
                    },
                    yaxis: {
                        title: 'Pupil coordinate Y',
                        range: [-1.1, 1.1],
                        dtick: 0.5
                    },
                    zaxis: { title: 'Wavefront aberration [λ]' },
                    camera: {
                        eye: { x: 1.5, y: 1.5, z: 1.5 }
                    }
                },
                margin: { l: 0, r: 0, b: 0, t: 40 }
            };

            try {
                const container = this.resolveContainer();
                if (!container) {
                    throw new Error('プロットコンテナが見つかりません');
                }
                console.log('✅ プロットコンテナ確認:', container);

                const plotly = this.resolvePlotly(container);
                if (!plotly) {
                    throw new Error('Plotly.jsライブラリが読み込まれていません');
                }

                this.validatePlotlyData(surfaceData);
                console.log('✅ データ検証完了');

                console.log('🎨 Plotly描画開始:', {
                    container: container.id || '(element)',
                    dataType: surfaceData.type,
                    dataSize: `${surfaceData.z.length}x${surfaceData.z[0]?.length}`
                });

                layout.autosize = true;
                if (profileEnabled) console.time('⏱️ plotWavefrontSurface.Plotly.newPlot');
                await plotly.newPlot(container, [surfaceData], layout, this.plotlyConfig);
                if (profileEnabled) console.timeEnd('⏱️ plotWavefrontSurface.Plotly.newPlot');
                console.log('✅ 波面収差 3Dサーフェス描画完了');
            } catch (error) {
                console.error('❌ 波面収差 3Dサーフェス描画エラー:', error);
                console.log('📊 問題のデータ:', {
                    x: surfaceData.x ? surfaceData.x.length : 'undefined',
                    y: surfaceData.y ? surfaceData.y.length : 'undefined',
                    z: surfaceData.z ? `${surfaceData.z.length}x${surfaceData.z[0]?.length}` : 'undefined'
                });

                // フォールバック：簡易データで描画
                const fallbackData = this.createFallbackSurfaceData('wavefront');
                const container = this.resolveContainer();
                const plotly = this.resolvePlotly(container);
                if (container && plotly) {
                    layout.autosize = true;
                    await plotly.newPlot(container, [fallbackData], layout, this.plotlyConfig);
                }
                console.log('⚠️ フォールバックデータで描画しました');
            }
            
            // 統計情報を表示
            this.displayStatistics(wavefrontMap.statistics.wavefront, 'Optical Path Difference', 'λ');

            console.log('✅ 波面収差 3Dサーフェスプロット生成完了');
            return wavefrontMap;

        } catch (error) {
            console.error('❌ 波面収差プロット生成エラー:', error);
            throw error;
        }
    }

    /**
     * OPDのヒートマップを生成
     * @param {Array} opticalSystemRows - 光学系データ
     * @param {Object} fieldSetting - フィールド設定
     * @param {number} wavelength - 波長（μm）
     * @param {number} gridSize - グリッドサイズ（デフォルト: 31）
     * @returns {Promise} プロット生成のPromise
     */
    async plotOPDHeatmap(opticalSystemRows, fieldSetting, wavelength = 0.5876, gridSize = 31, options = {}) {
        try {
            console.log('🌊 OPD ヒートマップ生成開始...');
            const emitProgress = (percent, message) => {
                try {
                    if (typeof options?.onProgress === 'function') {
                        options.onProgress({ percent, message, phase: 'opd-render' });
                    }
                } catch (_) {}
            };
            const displayMode = options?.opdDisplayMode || 'pistonTiltRemoved';
            const wavefrontMap = await this._computeNativeOpdWavefrontMap(opticalSystemRows, fieldSetting, gridSize, {
                opdDisplayMode: displayMode,
                onProgress: options?.onProgress || null,
            });
            // NOTE: wavefrontMap is large (arrays). Dumping it to console can freeze the UI.
            if (typeof globalThis !== 'undefined' && globalThis.__WAVEFRONT_DEBUG_DUMP === true) {
                console.log('🟦 wavefrontMap:', wavefrontMap);
            }
            if (!wavefrontMap || !wavefrontMap.pupilCoordinates || wavefrontMap.pupilCoordinates.length === 0) {
                throw new Error('有効な光線データがありません。光学系設定を確認してください。');
            }
            const opdGridDisplay = Array.isArray(wavefrontMap?.display?.opdGrid) ? wavefrontMap.display.opdGrid : [];
            const opdGridRaw = Array.isArray(wavefrontMap?.raw?.opdGrid) ? wavefrontMap.raw.opdGrid : [];
            const opdGridForRender = (Array.isArray(opdGridDisplay) && opdGridDisplay.length && Array.isArray(opdGridDisplay[0]))
                ? opdGridDisplay
                : opdGridRaw;
            if (!opdGridForRender.length || !Array.isArray(opdGridForRender[0])) {
                throw new Error('Native OPD grid is unavailable for heatmap plotting');
            }
            const n = opdGridForRender.length;
            const axis = n > 1
                ? Array.from({ length: n }, (_, i) => -1 + (2 * i) / (n - 1))
                : [0];
            const zGrid = opdGridForRender.map((row) =>
                (Array.isArray(row) ? row : []).map((v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? NaN : Number(v)))
            );
            const heatmapData = {
                x: axis,
                y: axis,
                z: zGrid,
                type: 'heatmap',
                zsmooth: 'best',
                colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
                colorbar: { title: 'OPD [λ]' },
            };
            
            // 🆕 実際のデータ範囲に基づいて軸範囲を設定
            const xRange = heatmapData.x.length > 0 ? [Math.min(...heatmapData.x) - 0.1, Math.max(...heatmapData.x) + 0.1] : [-1.1, 1.1];
            const yRange = heatmapData.y.length > 0 ? [Math.min(...heatmapData.y) - 0.1, Math.max(...heatmapData.y) + 0.1] : [-1.1, 1.1];
            
            // プロット設定
            const layout = {
                title: {
                    text: `Optical Path Difference (OPD) Heatmap - ${fieldSetting.displayName || 'Field Point'}`,
                    font: { size: 16 }
                },
                xaxis: { 
                    title: 'Pupil coordinate X',
                    range: xRange,
                    dtick: 0.5,
                    constrain: 'domain'
                },
                yaxis: { 
                    title: 'Pupil coordinate Y', 
                    scaleanchor: 'x',
                    scaleratio: 1,
                    range: yRange,
                    dtick: 0.5,
                    constrain: 'domain'
                },
                width: 600,
                height: 600,
                margin: { l: 60, r: 60, b: 60, t: 60 }
            };
            const container = this.resolveContainer();
            const plotly = this.resolvePlotly(container);
            if (!container || !plotly) {
                throw new Error('Plotly.jsライブラリが読み込まれていません');
            }
            layout.autosize = true;
            delete layout.width;
            delete layout.height;
            emitProgress(96, 'Rendering OPD heatmap...');
            await plotly.newPlot(container, [heatmapData], layout, this.plotlyConfig);
            emitProgress(100, 'Completed');
            // 統計情報を表示
            {
                // IMPORTANT: Stats must match what is plotted.
                // - Zernike fit OFF(raw): plot shows raw OPD → show raw stats.
                // - Zernike fit ON: plot shows OPD after removedModel (default piston) → show primary stats.
                const stats = wavefrontMap?.statistics?.display?.opdWavelengths
                    ? wavefrontMap.statistics.display.opdWavelengths
                    : (wavefrontMap?.statistics?.raw?.opdWavelengths || wavefrontMap?.statistics?.opdWavelengths);
                this.displayStatistics(stats, 'OPD', 'λ');
            }
            console.log('✅ OPD ヒートマップ生成完了');
            return wavefrontMap;
        } catch (error) {
            console.error('❌ OPD ヒートマップ生成エラー:', error);
            throw error;
        }
    }

    /**
     * 波面収差（Wλ）のヒートマップを生成
     */
    async plotWavefrontHeatmap(opticalSystemRows, fieldSetting, wavelength = 0.5876, gridSize = 31) {
        try {
            console.log('🌊 波面収差（Wλ）ヒートマップ生成開始...');
            const { analyzer } = this._createWavefrontEngine(opticalSystemRows, wavelength);

            const diagnoseDiscontinuities = (typeof globalThis !== 'undefined' && globalThis.__WAVEFRONT_DIAG_DISCONTINUITIES === true);
            const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', {
                recordRays: false,
                progressEvery: 512,
                diagnoseDiscontinuities,
                diagTopK: 5,
                // Use simple OPD (no reference-sphere correction).
                opdMode: 'simple',
                zernikeMaxNoll: 37,
                renderFromZernike: true
            });
            this._updateSystemDataWithZernike(analyzer, wavefrontMap, 37);

            if (!wavefrontMap || !wavefrontMap.pupilCoordinates || wavefrontMap.pupilCoordinates.length === 0) {
                throw new Error('有効な光線データがありません。光学系設定を確認してください。');
            }

            const heatmapData = this.convertToPlotlyHeatmapData(wavefrontMap, 'wavefront', gridSize, { rawMode: false });
            const xRange = heatmapData.x.length > 0 ? [Math.min(...heatmapData.x) - 0.1, Math.max(...heatmapData.x) + 0.1] : [-1.1, 1.1];
            const yRange = heatmapData.y.length > 0 ? [Math.min(...heatmapData.y) - 0.1, Math.max(...heatmapData.y) + 0.1] : [-1.1, 1.1];

            const layout = {
                title: {
                    text: `Wavefront Aberration (Wλ) Heatmap - ${fieldSetting.displayName || 'Field Point'}`,
                    font: { size: 16 }
                },
                xaxis: {
                    title: 'Pupil coordinate X',
                    range: xRange,
                    dtick: 0.5,
                    constrain: 'domain'
                },
                yaxis: {
                    title: 'Pupil coordinate Y',
                    scaleanchor: 'x',
                    scaleratio: 1,
                    range: yRange,
                    dtick: 0.5,
                    constrain: 'domain'
                },
                width: 600,
                height: 600,
                margin: { l: 60, r: 60, b: 60, t: 60 }
            };

            const container = this.resolveContainer();
            const plotly = this.resolvePlotly(container);
            if (!container || !plotly) {
                throw new Error('Plotly.jsライブラリが読み込まれていません');
            }
            layout.autosize = true;
            delete layout.width;
            delete layout.height;
            await plotly.newPlot(container, [heatmapData], layout, this.plotlyConfig);

            this.displayStatistics(wavefrontMap.statistics.wavefront, 'Wavefront', 'λ');
            console.log('✅ 波面収差（Wλ）ヒートマップ生成完了');
            return wavefrontMap;
        } catch (error) {
            console.error('❌ 波面収差（Wλ）ヒートマップ生成エラー:', error);
            throw error;
        }
    }

    /**
     * 複数フィールドの波面収差比較プロット
     * @param {Array} opticalSystemRows - 光学系データ
     * @param {Array} fieldSettings - フィールド設定の配列
     * @param {number} wavelength - 波長（μm）
     * @param {number} gridSize - グリッドサイズ（デフォルト: 16）
     * @returns {Promise} プロット生成のPromise
     */
    async plotMultiFieldComparison(opticalSystemRows, fieldSettings, wavelength = 0.5876, gridSize = 16) {
        try {
            console.log('🌊 マルチフィールド波面収差比較プロット生成開始...');
            
            const traces = [];
            const { analyzer } = this._createWavefrontEngine(opticalSystemRows, wavelength);
            
            for (const fieldSetting of fieldSettings) {
                // 各フィールドでの波面収差マップを生成
                // 🆕 【重要修正】Zernike除去を適用してフィールド間比較を可能にする
                // - opdMode: 'simple' で参照球面補正を行わない
                // - renderFromZernike: true でpiston/tilt除去後の波面を表示
                // - zernikeMaxNoll: 37 で高次収差まで正確にフィッティング
                // - これにより各フィールドの"本質的な高次収差"が比較可能になる
                const wavefrontMap = await analyzer.generateWavefrontMap(fieldSetting, gridSize, 'circular', {
                    recordRays: false,
                    progressEvery: 512,
                    // Use simple OPD (no reference-sphere correction)
                    opdMode: 'simple',
                    // 🆕 Zernike除去を適用（piston/tiltを各フィールドで個別に除去）
                    zernikeMaxNoll: 37,
                    renderFromZernike: true
                });
                
                // サーフェストレースを作成
                const surfaceData = this.convertToPlotlySurfaceData(wavefrontMap, 'wavefront');
                surfaceData.name = fieldSetting.displayName || `Field ${fieldSetting.id}`;
                surfaceData.opacity = 0.8;
                
                traces.push(surfaceData);
            }
            
            // プロット設定
            const layout = {
                title: {
                    text: `Multi-field Wavefront Aberration Comparison`,
                    font: { size: 16 }
                },
                scene: {
                    xaxis: { title: 'Pupil coordinate X' },
                    yaxis: { title: 'Pupil coordinate Y' },
                    zaxis: { title: 'Wavefront aberration [λ]' },
                    camera: {
                        eye: { x: 1.5, y: 1.5, z: 1.5 }
                    }
                },
                margin: { l: 0, r: 0, b: 0, t: 40 }
            };

            const container = this.resolveContainer();
            const plotly = this.resolvePlotly(container);
            if (!container || !plotly) {
                throw new Error('Plotly.jsライブラリが読み込まれていません');
            }
            layout.autosize = true;
            await plotly.newPlot(container, traces, layout, this.plotlyConfig);
            
            console.log('✅ マルチフィールド比較プロット生成完了');
            
        } catch (error) {
            console.error('❌ マルチフィールド比較プロット生成エラー:', error);
            throw error;
        }
    }

    async plotOPDMultiFieldComparisonRust(opticalSystemRows, fieldSettings, wavelength = 0.5876, gridSize = 16) {
        try {
            console.log('🌊 マルチフィールド OPD 比較プロット生成開始... (Rust)');

            const traces = [];
            for (const fieldSetting of fieldSettings) {
                const wavefrontMap = await this._computeNativeOpdWavefrontMap(opticalSystemRows, fieldSetting, gridSize, {
                    opdDisplayMode: 'pistonTiltRemoved'
                });

                const mapForPlot = wavefrontMap?.display?.opdsInWavelengths
                    ? {
                        ...wavefrontMap,
                        opds: wavefrontMap.display.opds,
                        opdsInWavelengths: wavefrontMap.display.opdsInWavelengths,
                        wavefrontAberrations: wavefrontMap.display.wavefrontAberrations
                    }
                    : wavefrontMap;
                const surfaceData = this.convertToPlotlySurfaceData(mapForPlot, 'opd', { rawMode: true, fillHoles: true });
                surfaceData.name = fieldSetting?.displayName || `Field ${fieldSetting?.id ?? ''}`;
                surfaceData.opacity = 0.8;
                surfaceData.showscale = false;
                traces.push(surfaceData);
            }

            const layout = {
                title: {
                    text: 'Multi-field OPD Comparison',
                    font: { size: 16 }
                },
                scene: {
                    xaxis: { title: 'Pupil coordinate X' },
                    yaxis: { title: 'Pupil coordinate Y' },
                    zaxis: { title: 'OPD [λ]' },
                    camera: { eye: { x: 1.5, y: 1.5, z: 1.5 } }
                },
                margin: { l: 0, r: 0, b: 0, t: 40 }
            };

            const container = this.resolveContainer();
            const plotly = this.resolvePlotly(container);
            if (!container || !plotly) {
                throw new Error('Plotly.jsライブラリが読み込まれていません');
            }
            layout.autosize = true;
            await plotly.newPlot(container, traces, layout, this.plotlyConfig);

            console.log('✅ マルチフィールド OPD 比較プロット生成完了 (Rust)');
        } catch (error) {
            console.error('❌ マルチフィールド OPD 比較プロット生成エラー:', error);
            throw error;
        }
    }

    _median(values) {
        const v = Array.isArray(values) ? values.filter(n => Number.isFinite(n)).slice() : [];
        const n = v.length;
        if (!n) return NaN;
        v.sort((a, b) => a - b);
        const mid = Math.floor(n / 2);
        return (n % 2) ? v[mid] : (v[mid - 1] + v[mid]) / 2;
    }

    _filterOutliersMAD(values, {
        label = 'values',
        madK = null,
        absMax = null,
        minScale = null
    } = {}) {
        try {
            if (!Array.isArray(values) || values.length === 0) return values;
            const g = (typeof globalThis !== 'undefined') ? globalThis : null;
            if (g && g.__WAVEFRONT_DISABLE_OUTLIER_FILTER === true) return values;

            const finite = values.filter(v => Number.isFinite(v));
            if (finite.length < 16) return values;

            const median = this._median(finite);
            if (!Number.isFinite(median)) return values;

            const absDev = finite.map(v => Math.abs(v - median));
            const mad = this._median(absDev);
            const scale = Number.isFinite(mad) ? (1.4826 * mad) : NaN;

            const k = Number.isFinite(madK)
                ? Number(madK)
                : (g && Number.isFinite(g.__WAVEFRONT_OUTLIER_MAD_K) ? Number(g.__WAVEFRONT_OUTLIER_MAD_K) : 8);
            const hardAbs = Number.isFinite(absMax)
                ? Number(absMax)
                : (g && Number.isFinite(g.__WAVEFRONT_OUTLIER_ABS_MAX) ? Number(g.__WAVEFRONT_OUTLIER_ABS_MAX) : 60);
            const eps = Number.isFinite(minScale)
                ? Number(minScale)
                : (g && Number.isFinite(g.__WAVEFRONT_OUTLIER_MIN_SCALE) ? Number(g.__WAVEFRONT_OUTLIER_MIN_SCALE) : 1e-6);

            const sigma = Number.isFinite(scale) ? Math.max(eps, scale) : eps;
            const cutoff = Math.max(eps, sigma * Math.max(1, k));

            let outliers = 0;
            const out = values.slice();
            for (let i = 0; i < out.length; i++) {
                const v = out[i];
                if (!Number.isFinite(v)) continue;
                if (Math.abs(v - median) > cutoff || Math.abs(v) > hardAbs) {
                    out[i] = NaN;
                    outliers++;
                }
            }

            if (outliers > 0) {
                console.log(`🧹 [WavefrontPlot] outlier filter (${label}): removed=${outliers}/${values.length}, median=${median.toFixed(4)}, mad=${Number.isFinite(mad) ? mad.toFixed(4) : 'NaN'}, cutoff=${cutoff.toFixed(4)}`);
            }
            return out;
        } catch (_) {
            return values;
        }
    }

    /**
     * 波面収差マップをPlotly 3Dサーフェス用データに変換
     * @param {Object} wavefrontMap - 波面収差マップ
     * @param {string} dataType - データタイプ ('opd' または 'wavefront')
     * @returns {Object} Plotly 3Dサーフェスデータ
     */
    convertToPlotlySurfaceData(wavefrontMap, dataType = 'wavefront', options = {}) {
        const { pupilCoordinates, wavefrontAberrations, opdsInWavelengths } = wavefrontMap;
        const valuesRaw = dataType === 'opd' ? opdsInWavelengths : wavefrontAberrations;

        const rawMode = !!options?.rawMode;

        // Even in rawMode, callers may request small interior hole filling
        // (e.g. to avoid a single missing center sample creating a large Plotly hole).
        const fillHoles = (options?.fillHoles !== undefined) ? !!options.fillHoles : !rawMode;

        // Drop rare extreme spikes before gridding/interpolation (treat as missing).
        // NOTE: OPD (especially with defocus kept) can legitimately exceed tens/hundreds of waves.
        // The default hard-abs cutoff (60λ) would incorrectly blank large regions (visible as holes).
        const outlierOpts = (rawMode && dataType === 'opd')
            ? { label: `${dataType}:${rawMode ? 'raw' : 'interp'}:surface`, madK: 1e9, absMax: 1e9 }
            : { label: `${dataType}:${rawMode ? 'raw' : 'interp'}:surface` };
        const values = this._filterOutliersMAD(valuesRaw, outlierOpts);

        // まず「元のグリッド」に確実に戻す（X/Y入れ替え・補間アーティファクト回避）
        const regular = this._tryBuildRegularGrid(wavefrontMap, values, null, { fillHoles });
        if (regular) {
            return {
                type: 'surface',
                x: regular.x,
                y: regular.y,
                z: regular.z,
                connectgaps: false,
                colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
                showscale: true,
                colorbar: {
                    title: dataType === 'opd' ? 'OPD [λ]' : 'Wλ [波長]'
                }
            };
        }
        
        // 有効なデータのみを抽出（NaN値を除外）
        const validIndices = [];
        const validCoords = [];
        const validValues = [];
        
        for (let i = 0; i < values.length; i++) {
            if (isFinite(values[i]) && !isNaN(values[i])) {
                validIndices.push(i);
                validCoords.push(pupilCoordinates[i]);
                validValues.push(values[i]);
            }
        }
        
        console.log(`📊 有効データ: ${validValues.length}/${values.length} 点 (${((validValues.length/values.length)*100).toFixed(1)}%)`);
        
        // 有効データが少なすぎる場合の処理
        if (validValues.length < 4) {
            console.warn('⚠️ 有効データが少なすぎます。簡易データを生成します。');
            return this.createFallbackSurfaceData(dataType);
        }
        
        // グリッドサイズを推定（有効データのみから）
        const uniqueX = [...new Set(validCoords.map(coord => coord.x))].sort((a, b) => a - b);
        const uniqueY = [...new Set(validCoords.map(coord => coord.y))].sort((a, b) => a - b);
        
        console.log(`📊 グリッドサイズ: X=${uniqueX.length}, Y=${uniqueY.length}`);
        
        // rawMode では補間しない（生値確認が目的のため）
        if (rawMode) {
            // Use the observed unique grid and only exact matches; missing cells remain null.
            const zGrid = [];
            let validCells = 0;
            let nullCells = 0;

            for (let j = 0; j < uniqueY.length; j++) {
                const row = [];
                for (let i = 0; i < uniqueX.length; i++) {
                    const x = uniqueX[i];
                    const y = uniqueY[j];
                    const radius = Math.sqrt(x * x + y * y);
                    if (radius > 1.0 + 1e-9) {
                        row.push(null);
                        nullCells++;
                        continue;
                    }

                    const exactMatch = validCoords.find(c =>
                        Math.abs(c.x - x) < 1e-10 && Math.abs(c.y - y) < 1e-10
                    );
                    if (exactMatch) {
                        const index = validCoords.indexOf(exactMatch);
                        row.push(validValues[index]);
                        validCells++;
                    } else {
                        row.push(null);
                        nullCells++;
                    }
                }
                zGrid.push(row);
            }

            console.log(`📊 [RawMode] grid cells: valid=${validCells}, null=${nullCells}, total=${validCells + nullCells}`);

            const out = {
                type: 'surface',
                x: uniqueX,
                y: uniqueY,
                z: zGrid,
                connectgaps: false,
                colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
                showscale: true,
                colorbar: {
                    title: dataType === 'opd' ? 'OPD [λ]' : 'Wλ [波長]'
                }
            };
            return this._transposeZForPlotly(out);
        }

        // 🆕 密度が低い場合は補間用のより密なグリッドを生成
        let interpolatedX = uniqueX;
        let interpolatedY = uniqueY;
        
        if (uniqueX.length < 20 || uniqueY.length < 20) {
            console.log('🔧 低密度データを補間用グリッドに拡張中...');
            const minX = Math.min(...uniqueX);
            const maxX = Math.max(...uniqueX);
            const minY = Math.min(...uniqueY);
            const maxY = Math.max(...uniqueY);
            
            // より密なグリッドを生成（最低32x32）
            const gridSize = Math.max(32, Math.max(uniqueX.length, uniqueY.length) * 2);
            interpolatedX = [];
            interpolatedY = [];
            
            for (let i = 0; i < gridSize; i++) {
                interpolatedX.push(minX + (maxX - minX) * i / (gridSize - 1));
                interpolatedY.push(minY + (maxY - minY) * i / (gridSize - 1));
            }
            
            console.log(`📊 補間グリッドサイズ: X=${interpolatedX.length}, Y=${interpolatedY.length}`);
        }
        
        // Z値のグリッドを作成（補間あり）
        const zGrid = [];
        let validCells = 0;
        let nullCells = 0;
        
        for (let j = 0; j < interpolatedY.length; j++) {
            const row = [];
            for (let i = 0; i < interpolatedX.length; i++) {
                const x = interpolatedX[i];
                const y = interpolatedY[j];
                
                // 円形マスクの適用
                const radius = Math.sqrt(x * x + y * y);
                if (radius > 1.0 + 1e-9) { // 瞳境界外
                    row.push(null);
                    nullCells++;
                    continue;
                }
                
                // 既存データポイントの検索
                const exactMatch = validCoords.find(c => 
                    Math.abs(c.x - x) < 1e-10 && Math.abs(c.y - y) < 1e-10
                );
                
                if (exactMatch) {
                    const index = validCoords.indexOf(exactMatch);
                    row.push(validValues[index]);
                    validCells++;
                } else {
                    // 最近傍補間またはバイリニア補間を適用
                    const interpolatedValue = this.interpolateValue(x, y, validCoords, validValues);
                    if (interpolatedValue !== null) {
                        row.push(interpolatedValue);
                        validCells++;
                    } else {
                        row.push(null);
                        nullCells++;
                    }
                }
            }
            zGrid.push(row);
        }
        
        console.log(`📊 グリッドセル: 有効=${validCells}, null=${nullCells}, 合計=${validCells + nullCells}`);
        
        // データの統計情報を出力
        // NOTE: Avoid spread on large arrays (e.g. 1024x1024) to prevent call stack overflow.
        let zMin = Infinity;
        let zMax = -Infinity;
        let zFiniteCount = 0;
        for (let rowIndex = 0; rowIndex < zGrid.length; rowIndex++) {
            const row = zGrid[rowIndex];
            if (!Array.isArray(row)) continue;
            for (let colIndex = 0; colIndex < row.length; colIndex++) {
                const value = row[colIndex];
                if (value === null || !Number.isFinite(value)) continue;
                zFiniteCount++;
                if (value < zMin) zMin = value;
                if (value > zMax) zMax = value;
            }
        }
        if (zFiniteCount > 0) {
            console.log(`📊 Z値範囲: ${zMin.toFixed(3)} ~ ${zMax.toFixed(3)}`);
        }
        
        const out = {
            type: 'surface',
            x: interpolatedX,
            y: interpolatedY,
            z: zGrid,
            connectgaps: false,
            colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
            showscale: true,
            colorbar: {
                title: dataType === 'opd' ? 'OPD [λ]' : 'Wλ [波長]'
            }
        };
        return this._transposeZForPlotly(out);
    }

    /**
     * Plotlyデータの検証
     * @param {Object} data - 検証するPlotlyデータ
     */
    validatePlotlyData(data) {
        if (!data) {
            throw new Error('データがありません');
        }
        
        if (!data.x || !data.y || !data.z) {
            throw new Error('x, y, z データが不足しています');
        }
        
        if (!Array.isArray(data.x) || !Array.isArray(data.y) || !Array.isArray(data.z)) {
            throw new Error('x, y, z データが配列ではありません');
        }
        
        if (data.x.length === 0 || data.y.length === 0 || data.z.length === 0) {
            throw new Error('データが空です');
        }
        
        // Z配列の検証
        if (!Array.isArray(data.z[0])) {
            throw new Error('z データが2次元配列ではありません');
        }
        
        // データサイズの一貫性チェック
        if (data.z.length !== data.y.length) {
            throw new Error(`y座標数(${data.y.length})とz行数(${data.z.length})が一致しません`);
        }
        
        if (data.z[0].length !== data.x.length) {
            throw new Error(`x座標数(${data.x.length})とz列数(${data.z[0].length})が一致しません`);
        }
        
        // 有効値の確認
        // NOTE: Avoid data.z.flat() for very large grids to reduce memory/stack pressure.
        let validValueCount = 0;
        let totalCellCount = 0;
        for (let rowIndex = 0; rowIndex < data.z.length; rowIndex++) {
            const row = data.z[rowIndex];
            if (!Array.isArray(row)) continue;
            totalCellCount += row.length;
            for (let colIndex = 0; colIndex < row.length; colIndex++) {
                const value = row[colIndex];
                if (value !== null && Number.isFinite(value)) validValueCount++;
            }
        }

        if (validValueCount === 0) {
            throw new Error('有効なZ値がありません');
        }
        
        console.log(`✅ データ検証完了: ${validValueCount}/${totalCellCount} 有効値`);
    }

    _transposeZForPlotly(data) {
        try {
            if (!data || !Array.isArray(data.z) || data.z.length === 0 || !Array.isArray(data.z[0])) return data;
            const z = data.z;
            const rows = z.length;
            const cols = Math.max(0, ...z.map(r => (Array.isArray(r) ? r.length : 0)));
            if (rows === 0 || cols === 0) return data;

            const zT = Array.from({ length: cols }, (_, c) => Array.from({ length: rows }, (_, r) => {
                const row = z[r];
                return (Array.isArray(row) && c < row.length) ? row[c] : null;
            }));

            // If the grid isn't square, swap axes too so Plotly dimension checks still pass.
            if (Array.isArray(data.x) && Array.isArray(data.y) && data.x.length !== data.y.length) {
                const tmp = data.x;
                data.x = data.y;
                data.y = tmp;
            }

            data.z = zT;
            return data;
        } catch (_) {
            return data;
        }
    }

    /**
     * 有効データが少ない場合のフォールバック用サーフェスデータ
     * @param {string} dataType - データタイプ
     * @returns {Object} Plotly用データ
     */
    createFallbackSurfaceData(dataType) {
        // 最小限のサーフェスデータを生成
        const x = [-1, 0, 1];
        const y = [-1, 0, 1];
        const z = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0]
        ];
        
        return {
            type: 'surface',
            x: x,
            y: y,
            z: z,
            colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
            showscale: true,
            colorbar: {
                title: dataType === 'opd' ? 'OPD [λ]' : 'Wλ [波長]'
            }
        };
    }

    /**
     * 波面収差マップをPlotlyヒートマップ用データに変換
     * @param {Object} wavefrontMap - 波面収差マップ
     * @param {string} dataType - データタイプ ('opd' または 'wavefront')
     * @param {number} gridSize - グリッドサイズ
     * @returns {Object} Plotlyヒートマップデータ
     */
    convertToPlotlyHeatmapData(wavefrontMap, dataType = 'opd', gridSize = 31, options = {}) {
        const { pupilCoordinates, wavefrontAberrations, opdsInWavelengths, rayData } = wavefrontMap;
        const valuesRaw = dataType === 'opd' ? opdsInWavelengths : wavefrontAberrations;

        const rawMode = !!options?.rawMode;

        // Drop rare extreme spikes before gridding (treat as missing).
        // NOTE: OPD (especially with defocus kept) can legitimately exceed tens/hundreds of waves.
        // The default hard-abs cutoff (60λ) would incorrectly blank large regions (visible as holes).
        const outlierOpts = (rawMode && dataType === 'opd')
            ? { label: `${dataType}:${rawMode ? 'raw' : 'interp'}:heatmap`, madK: 1e9, absMax: 1e9 }
            : { label: `${dataType}:${rawMode ? 'raw' : 'interp'}:heatmap` };
        const values = this._filterOutliersMAD(valuesRaw, outlierOpts);

        // まず「元のグリッド」に確実に戻す（X/Y入れ替え・補間アーティファクト回避）
        const regular = this._tryBuildRegularGrid(wavefrontMap, values, gridSize, { fillHoles: !rawMode });
        if (regular) {
            let valid = 0;
            let total = 0;
            try {
                const z = regular.z;
                if (Array.isArray(z)) {
                    for (const row of z) {
                        if (!Array.isArray(row)) continue;
                        for (const v of row) {
                            total++;
                            if (v !== null && Number.isFinite(v)) valid++;
                        }
                    }
                }
            } catch (_) {}
            const frac = total > 0 ? (valid / total) : 0;
            const allowConnectGaps = (!rawMode) && (frac >= 0.85);
            const out = {
                type: 'heatmap',
                x: regular.x,
                y: regular.y,
                z: regular.z,
                zsmooth: rawMode ? false : (allowConnectGaps ? 'best' : false),
                connectgaps: rawMode ? false : allowConnectGaps,
                colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
                showscale: true,
                colorbar: {
                    title: dataType === 'opd' ? 'OPD [λ]' : 'Wλ [波長]'
                }
            };
            return this._transposeZForPlotly(out);
        }
        
        // 🆕 3Dマップと同じ処理：有効データのみをフィルタリング
        const validIndices = [];
        const validCoords = [];
        const validValues = [];
        
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            const coord = pupilCoordinates[i];
            
            // 🆕 3Dマップと同じ条件：有限値かつNaNでない
            if (isFinite(value) && !isNaN(value) && coord) {
                validIndices.push(i);
                validCoords.push(coord);
                validValues.push(value);
            }
        }
        
        console.log(`📊 ヒートマップ有効データ: ${validValues.length}/${values.length} 点 (${((validValues.length/values.length)*100).toFixed(1)}%)`);
        
        // 🆕 3Dサーフェスと同じ座標系を使用
        // グリッドサイズを推定（有効データのみから）
        const uniqueX = [...new Set(validCoords.map(coord => coord.x))].sort((a, b) => a - b);
        const uniqueY = [...new Set(validCoords.map(coord => coord.y))].sort((a, b) => a - b);
        
        console.log(`📊 ヒートマップグリッドサイズ: X=${uniqueX.length}, Y=${uniqueY.length}`);

        if (rawMode) {
            // Raw mode: no interpolation, no gap filling.
            const zGrid = [];
            for (let j = 0; j < uniqueY.length; j++) {
                const row = [];
                for (let i = 0; i < uniqueX.length; i++) {
                    const coord = validCoords.find(c =>
                        Math.abs(c.x - uniqueX[i]) < 1e-10 && Math.abs(c.y - uniqueY[j]) < 1e-10
                    );
                    if (coord) {
                        const idx = validCoords.indexOf(coord);
                        row.push(validValues[idx]);
                    } else {
                        row.push(null);
                    }
                }
                zGrid.push(row);
            }

            const out = {
                type: 'heatmap',
                x: uniqueX,
                y: uniqueY,
                z: zGrid,
                zsmooth: false,
                connectgaps: false,
                colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
                showscale: true,
                colorbar: {
                    title: dataType === 'opd' ? 'OPD [λ]' : 'Wλ [波長]'
                }
            };
            return this._transposeZForPlotly(out);
        }
        
        // Z値のグリッドを作成（3Dサーフェスと同じアルゴリズム）
        const zGrid = [];
        let validCells = 0;
        let nullCells = 0;
        
        for (let j = 0; j < uniqueY.length; j++) {
            const row = [];
            for (let i = 0; i < uniqueX.length; i++) {
                const coord = validCoords.find(c => 
                    Math.abs(c.x - uniqueX[i]) < 1e-10 && Math.abs(c.y - uniqueY[j]) < 1e-10
                );
                if (coord) {
                    const index = validCoords.indexOf(coord);
                    row.push(validValues[index]);
                    validCells++;
                } else {
                    row.push(null); // グリッド外は null
                    nullCells++;
                }
            }
            zGrid.push(row);
        }
        
        console.log(`📊 ヒートマップグリッドセル: 有効=${validCells}, null=${nullCells}, 合計=${validCells + nullCells}`);

        const frac = (validCells + nullCells) > 0 ? (validCells / (validCells + nullCells)) : 0;
        const allowConnectGaps = frac >= 0.85;
        
        const out = {
            type: 'heatmap',
            x: uniqueX,
            y: uniqueY,
            z: zGrid,
            zsmooth: allowConnectGaps ? 'best' : false,
            connectgaps: allowConnectGaps,
            colorscale: WavefrontPlotter.getBlueGreenRedColorscale(),
            showscale: true,
            colorbar: {
                title: dataType === 'opd' ? 'OPD [λ]' : 'Wλ [λ]'
            }
        };
        return this._transposeZForPlotly(out);
    }

    /**
     * 統計情報を表示
     * @param {Object} statistics - 統計データ
     * @param {string} title - タイトル
     * @param {string} unit - 単位
     */
    displayStatistics(statistics, title, unit) {
        const container = this.resolveContainer();
        const statsContainer = this.resolveStatsContainer(container);
        if (!statsContainer) return;

        const mode = statistics?.pupilSamplingMode;
        const opdMode = statistics?.opdMode;
        const skipZernikeFit = statistics?.skipZernikeFit;
        const modeNote = (mode === 'entrance')
            ? '<div class="stats-note"><strong>Pupil sampling:</strong> entrance (best effort / vignetting possible)</div>'
            : (mode === 'stop')
                ? '<div class="stats-note"><strong>Pupil sampling:</strong> stop (requires reaching stop surface)</div>'
                : '';

        const opdModeNote = opdMode
            ? `<div class="stats-note"><strong>OPD mode:</strong> ${String(opdMode)}</div>`
            : '';

        const opdDisplayMode = statistics?.opdDisplayMode;
        const opdDisplayModeNote = opdDisplayMode
            ? `<div class="stats-note"><strong>OPD display mode:</strong> ${String(opdDisplayMode)}</div>`
            : '';

        const backend = statistics?.backend;
        const backendNote = backend
            ? `<div class="stats-note"><strong>Backend:</strong> ${String(backend)}</div>`
            : '';

        const chiefReferenceMode = statistics?.chiefReferenceMode;
        const chiefReferenceModeNote = chiefReferenceMode
            ? `<div class="stats-note"><strong>Chief reference mode:</strong> ${String(chiefReferenceMode)}</div>`
            : '';

        const zernikeNote = (typeof skipZernikeFit === 'boolean')
            ? `<div class="stats-note"><strong>Zernike fit:</strong> ${skipZernikeFit ? 'OFF (raw)' : 'ON'}</div>`
            : '';

        const rawMeanNote = (!skipZernikeFit && Number.isFinite(statistics?.rawMean))
            ? `<div class="stats-note"><strong>Raw mean (piston):</strong> ${Number(statistics.rawMean).toFixed(4)} ${unit}</div>`
            : '';

        const removalNote = (Array.isArray(statistics?.removeIndices) && statistics.removeIndices.length)
            ? `<div class="stats-note"><strong>Stats removal (OSA):</strong> [${statistics.removeIndices.join(', ')}] (piston/tilt/defocus)</div>`
            : '';
        
        // Diagnostic metadata from WASM response
        const wavelengthNote = (Number.isFinite(statistics?.wavelengthUm))
            ? `<div class="stats-note"><strong>Wavelength:</strong> ${(statistics.wavelengthUm * 1000).toFixed(2)} nm (${statistics.wavelengthUm.toFixed(6)} μm)</div>`
            : '';
        
        const gridSizeNote = (Number.isFinite(statistics?.gridSize))
            ? `<div class="stats-note"><strong>Grid size:</strong> ${Math.floor(statistics.gridSize)} × ${Math.floor(statistics.gridSize)}</div>`
            : '';
        
        const surfacesNote = (() => {
            const stop = Number.isInteger(statistics?.stopSurface) ? Number(statistics.stopSurface) : null;
            const target = Number.isInteger(statistics?.targetSurface) ? Number(statistics.targetSurface) : null;
            if (stop !== null || target !== null) {
                const parts = [];
                if (stop !== null) parts.push(`stop=${stop}`);
                if (target !== null) parts.push(`target=${target}`);
                return `<div class="stats-note"><strong>Surfaces:</strong> ${parts.join(', ')}</div>`;
            }
            return '';
        })();
        
        const objectPositionNote = (() => {
            const pos = statistics?.usedObjectPosition;
            const x = Number.isFinite(statistics?.usedObjectX) ? Number(statistics.usedObjectX) : null;
            const y = Number.isFinite(statistics?.usedObjectY) ? Number(statistics.usedObjectY) : null;
            if (pos || x !== null || y !== null) {
                let desc = '';
                if (pos) desc += String(pos);
                if (x !== null) desc += ` x=${x.toFixed(2)}`;
                if (y !== null) desc += ` y=${y.toFixed(2)}`;
                return `<div class="stats-note"><strong>Object:</strong> ${desc.trim()}</div>`;
            }
            return '';
        })();
        
        const hitRateNote = (() => {
            const hits = Number(statistics?.hitCount);
            const samples = Number(statistics?.sampleCount);
            if (Number.isFinite(hits) && Number.isFinite(samples) && samples > 0) {
                const rate = (hits / samples * 100).toFixed(1);
                return `<div class="stats-note"><strong>Ray hits:</strong> ${hits}/${samples} (${rate}%)</div>`;
            }
            return '';
        })();
        
        const formatStat = (value: any, digits = 4): string => {
            const n = Number(value);
            return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
        };

        const meanValue = Number(statistics?.mean);

        // Check if mean value is unusually large (potential piston issue)
        // NOTE: When showing raw OPD, the mean value includes piston by design.
        const meanMagnitude = Math.abs(meanValue);
        const largePistonWarning = (unit === 'λ' && Number.isFinite(meanMagnitude) && meanMagnitude > 10)
            ? `<div class="stats-warning" style="color: #ff6b6b; margin-top: 8px;">
                ⚠️ <strong>Large piston (mean)</strong>: mean=${formatStat(meanValue, 2)} ${unit}<br>
                → Enable piston removal in the statistics to make the mean closer to 0.
               </div>`
            : '';
        
        const statsHtml = `
            <div class="wavefront-statistics">
                <h4>${title} Statistics</h4>
                ${modeNote}
                ${opdModeNote}
                ${opdDisplayModeNote}
                ${backendNote}
                ${chiefReferenceModeNote}
                ${zernikeNote}
                ${rawMeanNote}
                ${removalNote}
                ${wavelengthNote}
                ${gridSizeNote}
                ${surfacesNote}
                ${objectPositionNote}
                ${hitRateNote}
                <div class="stats-grid">
                    <div><strong>Data points:</strong> ${Number.isFinite(Number(statistics?.count)) ? Number(statistics.count) : 'n/a'}</div>
                    <div><strong>Mean:</strong> ${formatStat(statistics?.mean, 4)} ${unit}</div>
                    <div><strong>RMS:</strong> ${formatStat(statistics?.rms, 4)} ${unit}</div>
                    <div><strong>Peak-to-Peak:</strong> ${formatStat(statistics?.peakToPeak, 4)} ${unit}</div>
                    <div><strong>Min:</strong> ${formatStat(statistics?.min, 4)} ${unit}</div>
                    <div><strong>Max:</strong> ${formatStat(statistics?.max, 4)} ${unit}</div>
                </div>
                ${largePistonWarning}
            </div>
        `;
        
        statsContainer.innerHTML = statsHtml;
    }

    /**
     * 最近傍補間またはバイリニア補間でZ値を補間
     * @param {number} x - 補間対象のX座標
     * @param {number} y - 補間対象のY座標
     * @param {Array} coords - 既存の座標配列
     * @param {Array} values - 既存の値配列
     * @returns {number|null} 補間された値またはnull
     */
    interpolateValue(x, y, coords, values) {
        const g = (typeof globalThis !== 'undefined') ? globalThis : null;
        const maxDist = (g && Number.isFinite(g.__WAVEFRONT_INTERP_MAX_DIST)) ? Math.max(0.01, Number(g.__WAVEFRONT_INTERP_MAX_DIST)) : 0.12;
        const minNeighbors = (g && Number.isFinite(g.__WAVEFRONT_INTERP_MIN_NEIGHBORS)) ? Math.max(2, Math.floor(Number(g.__WAVEFRONT_INTERP_MIN_NEIGHBORS))) : 6;
        const maxNeighbors = (g && Number.isFinite(g.__WAVEFRONT_INTERP_MAX_NEIGHBORS)) ? Math.max(minNeighbors, Math.floor(Number(g.__WAVEFRONT_INTERP_MAX_NEIGHBORS))) : 12;

        // 最近傍の点を探す（有限値のみ）
        const distances = [];
        for (let index = 0; index < coords.length; index++) {
            const coord = coords[index];
            const value = values[index];
            if (!coord || !Number.isFinite(coord.x) || !Number.isFinite(coord.y)) continue;
            if (!Number.isFinite(value)) continue;
            const d = Math.hypot(coord.x - x, coord.y - y);
            distances.push({ index, value, distance: d });
        }
        if (distances.length === 0) return null;

        // 距離でソート
        distances.sort((a, b) => a.distance - b.distance);

        // 非常に近い点がある場合はその値を使用
        if (distances[0].distance < 0.01) return distances[0].value;

        // 近傍が十分に無い or 離れすぎは補間しない（ギャップ跨ぎ抑止）
        const nearby = [];
        for (const d of distances) {
            if (d.distance > maxDist) break;
            nearby.push(d);
            if (nearby.length >= maxNeighbors) break;
        }
        if (nearby.length < minNeighbors) return null;

        // 距離による重み付き平均補間（d^2で遠方の寄与を抑える）
        let weightedSum = 0;
        let totalWeight = 0;
        for (const p of nearby) {
            const w = 1 / (p.distance * p.distance + 1e-6);
            weightedSum += p.value * w;
            totalWeight += w;
        }
        return totalWeight > 0 ? (weightedSum / totalWeight) : null;
    }

    _tryBuildRegularGrid(wavefrontMap, values, gridSizeOverride = null, options = {}) {
        try {
            const pupilRange = Number(wavefrontMap?.pupilRange);
            const gridSize = Number.isFinite(gridSizeOverride)
                ? Math.floor(gridSizeOverride)
                : Math.floor(Number(wavefrontMap?.gridSize));

            if (!Number.isFinite(pupilRange) || pupilRange <= 0) return null;
            if (!Number.isFinite(gridSize) || gridSize < 2) return null;

            const xAxis = [];
            const yAxis = [];
            for (let i = 0; i < gridSize; i++) {
                xAxis.push((i / (gridSize - 1)) * 2 * pupilRange - pupilRange);
                yAxis.push((i / (gridSize - 1)) * 2 * pupilRange - pupilRange);
            }

            // accumulate then finalize: z[row=y][col=x]
            const zSum = Array.from({ length: gridSize }, () => Array.from({ length: gridSize }, () => 0));
            const zCount = Array.from({ length: gridSize }, () => Array.from({ length: gridSize }, () => 0));

            const coords = wavefrontMap?.pupilCoordinates || [];
            const n = Math.min(coords.length, values?.length || 0);
            if (n === 0) return null;

            const inv = (gridSize - 1) / (2 * pupilRange);
            for (let k = 0; k < n; k++) {
                const c = coords[k];
                const v = values[k];
                if (!c || !isFinite(c.x) || !isFinite(c.y)) continue;
                if (!isFinite(v) || isNaN(v)) continue;

                // Prefer exact original indices when present (avoids float rounding artifacts)
                let ix = Number.isInteger(c.ix) ? c.ix : Math.round((c.x + pupilRange) * inv);
                let iy = Number.isInteger(c.iy) ? c.iy : Math.round((c.y + pupilRange) * inv);
                if (ix < 0 || ix >= gridSize || iy < 0 || iy >= gridSize) continue;

                const r = Math.hypot(c.x, c.y);
                if (r > pupilRange + 1e-9) continue;

                zSum[iy][ix] += v;
                zCount[iy][ix] += 1;
            }

            const zGrid = Array.from({ length: gridSize }, () => Array.from({ length: gridSize }, () => null));
            for (let iy = 0; iy < gridSize; iy++) {
                for (let ix = 0; ix < gridSize; ix++) {
                    const c = zCount[iy][ix];
                    if (c > 0) zGrid[iy][ix] = zSum[iy][ix] / c;
                }
            }

            // Draw-only: fill small interior holes to avoid surface discontinuities.
            // Do NOT fill near the pupil boundary (to preserve masking) and do not bridge large gaps.
            // IMPORTANT: On heavily vignetted/sparse fields, hole-filling can create tall spikes by
            // bridging across physically invalid regions. In that case, leave holes as null.
            if (options?.fillHoles) {
                const coreRadius = pupilRange * 0.90;
                let coreNulls = 0;
                let coreCells = 0;
                let coreValid = 0;
                for (let iy = 0; iy < gridSize; iy++) {
                    const y = yAxis[iy];
                    for (let ix = 0; ix < gridSize; ix++) {
                        const x = xAxis[ix];
                        if (Math.hypot(x, y) > coreRadius + 1e-12) continue;
                        coreCells++;
                        if (zGrid[iy][ix] === null) {
                            coreNulls++;
                        } else {
                            coreValid++;
                        }
                    }
                }

                const coreValidFrac = coreCells > 0 ? (coreValid / coreCells) : 0;
                const allowFill = (coreNulls > 0) && (coreValidFrac >= 0.60);

                if (!allowFill && coreNulls > 0) {
                    console.log(`🩹 [WavefrontPlot] surface hole-fill skipped (sparse): coreValidFrac=${coreValidFrac.toFixed(3)}, coreValid=${coreValid}, coreNulls=${coreNulls}`);
                }

                if (allowFill) {
                    const fillFromNeighbors = (src) => {
                        const out = src.map(row => row.slice());
                        let filled = 0;
                        let remaining = 0;

                        const maxR = 2; // small holes only (avoid bridging gaps)
                        for (let iy = 0; iy < gridSize; iy++) {
                            const y = yAxis[iy];
                            for (let ix = 0; ix < gridSize; ix++) {
                                if (out[iy][ix] !== null) continue;
                                const x = xAxis[ix];
                                if (Math.hypot(x, y) > coreRadius + 1e-12) continue;

                                let acc = 0;
                                let wsum = 0;
                                let used = 0;

                                for (let r = 1; r <= maxR; r++) {
                                    for (let dy = -r; dy <= r; dy++) {
                                        for (let dx = -r; dx <= r; dx++) {
                                            if (dx === 0 && dy === 0) continue;
                                            const nx = ix + dx;
                                            const ny = iy + dy;
                                            if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;
                                            const v = src[ny][nx];
                                            if (v === null || !isFinite(v)) continue;
                                            const d = Math.hypot(dx, dy);
                                            const w = 1 / (d + 1e-6);
                                            acc += v * w;
                                            wsum += w;
                                            used++;
                                        }
                                    }
                                    // stop early if we already have enough neighbors
                                    if (used >= 6) break;
                                }

                                if (used >= 6 && wsum > 0) {
                                    out[iy][ix] = acc / wsum;
                                    filled++;
                                } else {
                                    remaining++;
                                }
                            }
                        }

                        return { out, filled, remaining };
                    };

                    const pass1 = fillFromNeighbors(zGrid);
                    const filledTotal = (pass1.filled || 0);
                    const remaining = pass1.remaining;
                    if (filledTotal > 0) {
                        console.log(`🩹 [WavefrontPlot] surface hole-fill: coreNulls=${coreNulls}, filled=${filledTotal}, remaining=${remaining}`);
                    }
                    // replace with filled grid
                    for (let iy = 0; iy < gridSize; iy++) {
                        for (let ix = 0; ix < gridSize; ix++) {
                            zGrid[iy][ix] = pass1.out[iy][ix];
                        }
                    }
                }
            }

            return { x: xAxis, y: yAxis, z: zGrid };
        } catch (_) {
            return null;
        }
    }
}

/**
 * 波面収差図表示の統合関数
 * 光学系データを自動取得して波面収差プロットを生成
 * @param {string} plotType - プロットタイプ ('surface', 'heatmap', 'multifield')
 * @param {string} dataType - データタイプ ('wavefront', 'opd')
 * @param {number} gridSize - グリッドサイズ
 * @param {number} selectedObjectIndex - 選択されたObjectのインデックス
 */
export async function showWavefrontDiagram(plotType = 'surface', dataType = 'wavefront', gridSize = 64, selectedObjectIndex = 0, options: any = {}) {
    try {
        // Extract cancelToken and progressCallback from options
        const cancelToken = options?.cancelToken || null;
        const onProgress = options?.onProgress || null;

        const getActiveConfigLabel = () => {
            try {
                if (typeof localStorage === 'undefined') return '';
                const sys = loadSystemConfigurations();
                const activeId = sys?.activeConfigId;
                const cfg = Array.isArray(sys?.configurations)
                    ? sys.configurations.find(c => String(c?.id) === String(activeId))
                    : null;
                if (!cfg) return activeId !== undefined && activeId !== null ? `id=${activeId}` : '';
                return `id=${cfg.id} name=${cfg.name || ''}`.trim();
            } catch (_) {
                return '';
            }
        };
        
        // 🔧 **修正**: windowオブジェクトから直接データを取得（wavefront-ray-handlers.jsと同様）
        const opticalSystemRows = window.getOpticalSystemRows ? window.getOpticalSystemRows() : null;
        const objectRows = window.getObjectRows ? window.getObjectRows() : [];

        // Diagnostic: confirm which config/data is actually used.
        try {
            // NOTE: Surface numbering is ambiguous in the UI (0-based vs 1-based).
            // Print both candidates so the user can map them to their "Surf5".
            const idx4 = opticalSystemRows?.[4];
            const idx5 = opticalSystemRows?.[5];
            const idx6 = opticalSystemRows?.[6];
            const activeCfg = getActiveConfigLabel();
        } catch (_) {}
        
        if (!opticalSystemRows || opticalSystemRows.length === 0) {
            console.error('❌ 光学系データがありません');
            throw new Error('光学系データがありません。JSONファイルをロードしてください。');
        }
        
        if (!objectRows || objectRows.length === 0) {
            console.warn('⚠️ Objectデータがありません、軸上設定を使用');
            // デフォルトのObjectデータを作成
            const defaultObject = {
                id: 1,
                xHeightAngle: 0,
                yHeightAngle: 0,
                position: 'Angle'
            };
            objectRows.push(defaultObject);
            selectedObjectIndex = 0;
        }
        
        // 選択されたObjectが有効かチェック
        if (selectedObjectIndex < 0 || selectedObjectIndex >= objectRows.length) {
            console.warn(`⚠️ 無効なObjectインデックス: ${selectedObjectIndex}, デフォルト(0)を使用`);
            selectedObjectIndex = 0;
        }
        
        const selectedObject = objectRows[selectedObjectIndex];
        
        // 主波長を取得（取得不能時は計算を中止）
        const wavelength = (() => {
            try {
                if (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function') {
                    const w = Number(window.getPrimaryWavelength());
                    if (Number.isFinite(w) && w > 0) return w;
                }
            } catch (_) {}
            throw new Error('Primary wavelength is unavailable. Please set Source Primary Wavelength.');
        })();
        
        const isInfiniteSystem = (() => {
            const objectSurface = opticalSystemRows?.[0];
            const t = objectSurface?.thickness;
            return t === 'INF' || t === 'Infinity' || t === Infinity;
        })();

        const toNumber = (v) => {
            const n = typeof v === 'number' ? v : parseFloat(v);
            return Number.isFinite(n) ? n : 0;
        };

        const toFieldSettingFromObject = (obj, index) => {
            const pos = String(obj?.position ?? obj?.Position ?? obj?.type ?? '').toLowerCase();
            const xVal = toNumber(obj?.xHeightAngle);
            const yVal = toNumber(obj?.yHeightAngle);

            // IMPORTANT: Do not populate both angle and height with the same value.
            // This caused ambiguous semantics (deg vs mm) and can mis-route solvers.
            // Keep semantics aligned with popup/native paths:
            // Point rows store field angles in xHeightAngle/yHeightAngle.
            const isAngleMode = pos === 'angle' || pos === 'field angle' || pos === 'angles' || pos === 'point';
            const isHeightMode = pos === 'rectangle' || pos === 'height';

            let fieldAngle = { x: 0, y: 0 };
            let xHeight = 0;
            let yHeight = 0;
            let type = obj?.position ?? obj?.type ?? '';

            if (isAngleMode) {
                fieldAngle = { x: xVal, y: yVal };
                xHeight = 0;
                yHeight = 0;
                type = 'Angle';
            } else if (isHeightMode) {
                fieldAngle = { x: 0, y: 0 };
                xHeight = xVal;
                yHeight = yVal;
                type = 'Rectangle';
            } else {
                // Fallback: infer from system type.
                // Infinite systems typically use angles; finite systems use heights.
                if (isInfiniteSystem) {
                    fieldAngle = { x: xVal, y: yVal };
                    xHeight = 0;
                    yHeight = 0;
                    type = 'Angle';
                } else {
                    fieldAngle = { x: 0, y: 0 };
                    xHeight = xVal;
                    yHeight = yVal;
                    type = 'Rectangle';
                }
            }

            const labelValue = type === 'Angle'
                ? `(${fieldAngle.x || 0}°, ${fieldAngle.y || 0}°)`
                : `(${xHeight || 0}mm, ${yHeight || 0}mm)`;

            return {
                id: obj?.id || index + 1,
                displayName: `Object ${index + 1} ${labelValue}`,
                type,
                fieldAngle,
                xHeight,
                yHeight,
                objectIndex: index,
                wavelength // 🔧 キャッシュキー生成に必要
            };
        };

        // フィールド設定を作成（選択されたObjectのみ）
        const fieldSetting = toFieldSettingFromObject(selectedObject, selectedObjectIndex);

        // マルチフィールド比較の場合は全Objectを使用
        const fieldSettings = objectRows.map((obj, index) => toFieldSettingFromObject(obj, index));
        
        // プロッターを作成
        const plotter = new WavefrontPlotter(options?.containerElement || 'wavefront-container');
        const opdDisplayMode = options?.opdDisplayMode || 'pistonTiltRemoved';
        
        // プロットタイプに応じて描画
        const storeLast = (wavefrontMap) => {
            try {
                const lastMeta = {
                    plotType,
                    dataType,
                    gridSize,
                    selectedObjectIndex,
                    wavelength,
                    fieldSetting
                };
                setLastWavefrontState(wavefrontMap, lastMeta, window);

                // Token-light snapshot for cross-window diagnostics (avoid storing full grids)
                try {
                    if (typeof localStorage !== 'undefined') {
                        const stats = wavefrontMap?.statistics || null;
                        const snap: any = {
                            at: new Date().toISOString(),
                            from: 'eva-wavefront-plot.js:storeLast',
                            wavefront: {
                                meta: getLastWavefrontMeta(window),
                                hasError: !!wavefrontMap?.error,
                                error: wavefrontMap?.error ? {
                                    message: String(wavefrontMap.error?.message || wavefrontMap.error || 'Wavefront error').slice(0, 600),
                                    code: wavefrontMap.error?.code || null
                                } : null,
                                statistics: stats ? {
                                    opdMicrons: stats.opdMicrons ? {
                                        rms: Number.isFinite(Number(stats.opdMicrons.rms)) ? Number(stats.opdMicrons.rms) : null,
                                        peakToPeak: Number.isFinite(Number(stats.opdMicrons.peakToPeak)) ? Number(stats.opdMicrons.peakToPeak) : null
                                    } : null,
                                    rawOpdMicrons: stats.raw?.opdMicrons ? {
                                        rms: Number.isFinite(Number(stats.raw.opdMicrons.rms)) ? Number(stats.raw.opdMicrons.rms) : null,
                                        peakToPeak: Number.isFinite(Number(stats.raw.opdMicrons.peakToPeak)) ? Number(stats.raw.opdMicrons.peakToPeak) : null
                                    } : null
                                } : null
                            }
                        };

                        try {
                            const analyzer = window.lastWavefrontAnalyzer || null;
                            const opdCalc = analyzer?.opdCalculator || null;
                            const lastRay = (typeof opdCalc?.getLastRayCalculation === 'function')
                                ? opdCalc.getLastRayCalculation()
                                : (opdCalc?.lastRayCalculation ?? null);
                            if (lastRay) {
                                snap.opdLastRay = {
                                    success: lastRay.success ?? null,
                                    error: lastRay.error ?? null,
                                    fieldKey: lastRay.fieldKey ?? null,
                                    pupilCoord: lastRay.pupilCoord ?? null,
                                    stopHit: lastRay.stopHit ?? null,
                                };
                            }
                        } catch (_) {}

                        saveLastWavefrontSnapshot(snap);
                    }
                } catch (_) {}

                try {
                    window.dispatchEvent(new CustomEvent('coopt:lastWavefrontMapUpdated', {
                        detail: getLastWavefrontMeta(window)
                    }));
                } catch (_) {}
            } catch (_) {}
        };

        let plotResult: any = null;

        switch (plotType) {
            case 'surface':
                if (dataType === 'opd') {
                    const wavefrontMap = await plotter.plotOPDSurface(opticalSystemRows, fieldSetting, wavelength, gridSize, {
                        cancelToken,
                        onProgress,
                        opdDisplayMode,
                        wasmFastOnly: options?.wasmFastOnly,
                        enableHeavyDiagnostics: options?.enableHeavyDiagnostics
                    });
                    storeLast(wavefrontMap);
                    plotResult = wavefrontMap;
                } else {
                    const wavefrontMap = await plotter.plotWavefrontAberrationSurface(opticalSystemRows, fieldSetting, wavelength, gridSize);
                    storeLast(wavefrontMap);
                    plotResult = wavefrontMap;
                }
                break;
                
            case 'heatmap':
                if (dataType === 'opd') {
                    const wavefrontMap = await plotter.plotOPDHeatmap(opticalSystemRows, fieldSetting, wavelength, gridSize, {
                        cancelToken,
                        onProgress,
                        opdDisplayMode,
                        wasmFastOnly: options?.wasmFastOnly,
                        enableHeavyDiagnostics: options?.enableHeavyDiagnostics
                    });
                    storeLast(wavefrontMap);
                    plotResult = wavefrontMap;
                } else {
                    const wavefrontMap = await plotter.plotWavefrontHeatmap(opticalSystemRows, fieldSetting, wavelength, gridSize);
                    storeLast(wavefrontMap);
                    plotResult = wavefrontMap;
                }
                break;
                
            case 'multifield':
                // マルチフィールド比較では全Objectを使用
                if (dataType === 'opd') {
                    await plotter.plotOPDMultiFieldComparisonRust(opticalSystemRows, fieldSettings, wavelength, gridSize);
                } else {
                    await plotter.plotMultiFieldComparison(opticalSystemRows, fieldSettings, wavelength, gridSize);
                }
                plotResult = { success: true };
                break;
                
            default:
                throw new Error(`未対応のプロットタイプ: ${plotType}`);
        }

        if (plotResult?.error) {
            throw new Error(String(plotResult?.error?.message || plotResult?.error || 'Wavefront plot failed'));
        }
        
        console.log('✅ 波面収差図表示完了');
        return plotResult || { success: true };
        
    } catch (error: any) {
        console.error('❌ 波面収差図表示エラー:', error);
        if (options?.showAlert !== false) {
            alert(`波面収差図エラー: ${error?.message || error}`);
        }
        if (options?.throwOnError === true) {
            throw error;
        }
        return { error: { message: String(error?.message || error || 'Wavefront plot failed') } };
    }
}

/**
 * 使用例（コメントアウト）:
 * 
 * // 基本的な使用方法
 * const plotter = new WavefrontPlotter('my-container');
 * 
 * // OPDサーフェスプロット
 * await plotter.plotOPDSurface(opticalSystemRows, fieldSetting, 0.5876);
 * 
 * // 波面収差ヒートマップ
 * await plotter.plotOPDHeatmap(opticalSystemRows, fieldSetting, 0.5876, 31);
 * 
 * // 統合関数での表示
 * await showWavefrontDiagram('surface', 'wavefront');
 * await showWavefrontDiagram('heatmap', 'opd');
 * await showWavefrontDiagram('multifield', 'wavefront');
 */
