/**
 * PSF Plot Visualization Module
 * PSFプロット可視化システム
 * 
 * 機能:
 * - PSFの2D/3Dヒートマップ表示
 * - ログスケール対応
 * - 評価指標の表示
 * - Plotly.jsによる高品質プロット
 * 
 * 作成日: 2025/08/07
 */

// @ts-nocheck

/**
 * PSFプロット表示クラス
 */
export class PSFPlotter {
    constructor(containerElementIdOrElement) {
        this.containerElementIdOrElement = containerElementIdOrElement;
        this.plotlyConfig = {
            displayModeBar: true,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d'],
            responsive: true
        };
        this.lastPlotData = null;
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

    resolveStatsContainer(container, containerTarget = null) {
        if (containerTarget) {
            if (typeof containerTarget === 'string') {
                return container?.ownerDocument?.getElementById(containerTarget) || document.getElementById(containerTarget);
            }
            return containerTarget;
        }

        const id = container?.id;
        if (!id) return null;
        return container.ownerDocument.getElementById(`${id}-stats`);
    }

    /**
     * アプリ既定のカラースケール（低→高: 青→緑→赤）
     * Plotlyのcolorscale配列を返す
     */
    static getBlueGreenRedColorscale() {
        return [
            [0.0, 'rgb(0, 0, 255)'],   // blue (low)
            [0.5, 'rgb(0, 255, 0)'],   // green (mid)
            [1.0, 'rgb(255, 0, 0)']    // red (high)
        ];
    }

    /**
     * colorscaleオプションを正規化
     * - 未指定: 既定（青→緑→赤）
     * - 'BlueGreenRed' / 'BGR': 既定配列に展開
     * - それ以外: そのまま（Plotlyプリセット名 or 配列）
     */
    normalizeColorscale(colorscale) {
        if (!colorscale) return PSFPlotter.getBlueGreenRedColorscale();
        if (colorscale === 'BlueGreenRed' || colorscale === 'BGR') {
            return PSFPlotter.getBlueGreenRedColorscale();
        }
        return colorscale;
    }

    /**
     * PSF画像を左回り90°回転する（z[row][col] の行列）
     * - 正方行列（NxN）を主対象。
     * - 非正方のときは寸法が入れ替わるため、呼び出し側で x/y も合わせる。
     */
    static rotateZ90CCW(z) {
        if (!Array.isArray(z) || z.length === 0 || !Array.isArray(z[0])) return z;
        const h = z.length;
        const w = z[0].length;
        const out = Array(w).fill().map(() => Array(h).fill(0));
        for (let i = 0; i < w; i++) {
            for (let j = 0; j < h; j++) {
                out[i][j] = z[j]?.[w - 1 - i] ?? 0;
            }
        }
        return out;
    }

    /**
     * 2D PSFヒートマップを表示
     * @param {Object} psfResult - PSF計算結果
     * @param {Object} options - プロットオプション
     */
    async plot2DPSF(psfResult, options = {}) {
        const {
            logScale = false,
            colorscale = PSFPlotter.getBlueGreenRedColorscale(),
            showMetrics = true,
            title = 'Point Spread Function',
            recenterToCentroid = true
        } = options;

        // console.log('📊 [PSFPlot] 2D PSFプロット生成中...');

        try {
            const psfData = psfResult?.psfData || psfResult?.psf || psfResult?.intensity;
            if (!psfData || !Array.isArray(psfData) || !Array.isArray(psfData[0])) {
                throw new Error('PSFデータが見つかりません（psfData/psf/intensity のいずれも未設定）');
            }
            const size = psfData.length;
            const rawPixelSize = Number(options.pixelSize);
            const fallbackPixelSize = Number(psfResult?.options?.pixelSize);
            const pixelSize = (Number.isFinite(rawPixelSize) && rawPixelSize > 0)
                ? rawPixelSize
                : ((Number.isFinite(fallbackPixelSize) && fallbackPixelSize > 0) ? fallbackPixelSize : 1.0);

            // データの前処理（転置前にリセンタリングしない）
            // 重心計算用に線形スケールデータを保持
            const linearData = this.preprocessPSFData(psfData, false); // 常に線形スケール
            const plotData = this.preprocessPSFData(psfData, logScale); // 表示用
            
            console.log(`📊 [PSF-Plot] Input data size: ${size}×${size}, logScale=${logScale}`);
            
            // まず線形データを転置して重心を計算
            const linearTransposed = Array(size).fill().map(() => Array(size).fill(0));
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    linearTransposed[j][i] = linearData[i][j];
                }
            }
            
            // 表示用データも転置
            const transposed = Array(size).fill().map(() => Array(size).fill(0));
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    transposed[j][i] = plotData[i][j];
                }
            }
            console.log(`📊 [PSF-Plot] Data transposed`);
            
            // 線形データで最大値を検出
            let maxVal = -Infinity;
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    if (linearTransposed[i][j] > maxVal) {
                        maxVal = linearTransposed[i][j];
                    }
                }
            }
            
            // 線形データで高強度領域（ピークの30%以上）の重心を計算
            const threshold = maxVal * 0.3;
            let sumI = 0, sumJ = 0, sumWeight = 0;
            let countAboveThreshold = 0;
            
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    const val = linearTransposed[i][j];
                    if (val >= threshold) {
                        sumI += i * val;
                        sumJ += j * val;
                        sumWeight += val;
                        countAboveThreshold++;
                    }
                }
            }
            
            const centroidI = sumWeight > 0 ? sumI / sumWeight : Math.floor(size / 2);
            const centroidJ = sumWeight > 0 ? sumJ / sumWeight : Math.floor(size / 2);
            
            console.log(`📊 [PSF-Plot] Linear max: ${maxVal.toExponential(3)}, threshold (30%): ${threshold.toExponential(3)}`);
            console.log(`📊 [PSF-Plot] Pixels above threshold: ${countAboveThreshold}`);
            console.log(`📊 [PSF-Plot] Centroid (from linear data): [${centroidI.toFixed(2)}][${centroidJ.toFixed(2)}]`);
            
            // 表示用データをシフトして重心を中心に配置
            const center = Math.floor(size / 2);
            const shiftI = Math.round(center - centroidI);
            const shiftJ = Math.round(center - centroidJ);
            
            console.log(`📊 [PSF-Plot] Center=${center}, shift needed: (${shiftI}, ${shiftJ})`);
            
            let finalData = transposed;
            if (recenterToCentroid && (shiftI !== 0 || shiftJ !== 0)) {
                console.log(`📊 [PSF-Plot] Applying centroid-based shift to transposed data (zero-fill, non-cyclic)...`);
                let fillValue = 0;
                if (logScale) {
                    let minVal = Infinity;
                    for (let i = 0; i < size; i++) {
                        for (let j = 0; j < size; j++) {
                            const v = Number(transposed[i][j]);
                            if (Number.isFinite(v) && v < minVal) minVal = v;
                        }
                    }
                    fillValue = Number.isFinite(minVal) ? minVal : -12;
                }

                finalData = Array(size).fill().map(() => Array(size).fill(fillValue));
                for (let i = 0; i < size; i++) {
                    for (let j = 0; j < size; j++) {
                        const srcI = i - shiftI;
                        const srcJ = j - shiftJ;
                        if (srcI < 0 || srcI >= size || srcJ < 0 || srcJ >= size) continue;
                        finalData[i][j] = transposed[srcI][srcJ];
                    }
                }
                const checkVal = finalData[center][center];
                console.log(`✅ [PSF-Plot] Shift complete, finalData[${center}][${center}]=${checkVal.toExponential(3)}`);
            } else if (recenterToCentroid) {
                console.log(`📊 [PSF-Plot] No shift needed, centroid already at center`);
            } else {
                console.log(`📊 [PSF-Plot] Centroid recenter disabled; preserving native PSF position`);
            }
            
            // 軸の座標を生成
            const extent = (size / 2) * pixelSize;
            const x = [];
            const y = [];
            
            for (let i = 0; i < size; i++) {
                x.push((i - center) * pixelSize);
                y.push((i - center) * pixelSize);
            }
            
            console.log(`📊 [PSF-Plot] Axes generated: x[${center}]=${x[center]?.toFixed(2)}μm, y[${center}]=${y[center]?.toFixed(2)}μm`);
            console.log(`📊 [PSF-Plot] PSF centroid will be at plot coordinates: (0.00, 0.00)μm`);

            // PSF画像全体を左回り90°回転（表示の向き調整）
            const rotatedZ = PSFPlotter.rotateZ90CCW(finalData);
            const xForPlot = (rotatedZ.length === y.length && (rotatedZ[0]?.length ?? 0) === x.length) ? x : y;
            const yForPlot = (rotatedZ.length === y.length && (rotatedZ[0]?.length ?? 0) === x.length) ? y : [...x].reverse();

            // Plotlyのヒートマップデータ
            // z[row][col] where row=Y-axis, col=X-axis
            const trace = {
                z: rotatedZ,
                x: xForPlot,
                y: yForPlot,
                type: 'heatmap',
                colorscale: this.normalizeColorscale(colorscale),
                showscale: true,
                colorbar: {
                    title: logScale ? 'Log Intensity' : 'Intensity',
                    titleside: 'right'
                }
            };

            const layout = {
                title: {
                    text: title,
                    font: { size: 16 }
                },
                xaxis: {
                    title: 'Position (μm)',
                    scaleanchor: 'y',
                    scaleratio: 1,
                    zeroline: false,
                    showgrid: false,
                    showspikes: false
                },
                yaxis: {
                    title: 'Position (μm)',
                    zeroline: false,
                    showgrid: false,
                    showspikes: false
                },
                width: 600,
                height: 500,
                margin: { l: 60, r: 60, t: 80, b: 60 }
            };

            const container = this.resolveContainer();
            if (container) {
                // NOTE: Plotlyは display:none / 0x0 の要素に対して autosize + scaleanchor を使うと
                // 「Something went wrong with axis scaling」を投げることがある。
                // コンテナが実寸を持つときだけ autosize を有効化する。
                const rect = (typeof container.getBoundingClientRect === 'function') ? container.getBoundingClientRect() : null;
                const hasSize = !!rect && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 10 && rect.height > 10;
                if (hasSize) {
                    layout.autosize = true;
                    delete layout.width;
                    delete layout.height;
                }
            }

            // メトリクス情報を追加
            if (showMetrics && psfResult.metrics) {
                layout.annotations = this.createMetricsAnnotations(psfResult.metrics);
            }

            const plotContainer = container || this.containerElementIdOrElement;
            const plotly = this.resolvePlotly(container);
            if (!plotly) {
                throw new Error('Plotly.jsライブラリが読み込まれていません');
            }

            try {
                await plotly.newPlot(plotContainer, [trace], layout, this.plotlyConfig);
            } catch (e) {
                const msg = String(e?.message || e);
                // Plotly 2.x の既知の落ち方: scaleanchor が絡む axis scaling エラー。
                // 2D表示を完全に落とさないため、scaleanchor を外して再試行する。
                if (msg.includes('axis scaling')) {
                    const fallbackLayout = {
                        ...layout,
                        autosize: false,
                        width: layout.width || 600,
                        height: layout.height || 500,
                        xaxis: { ...(layout.xaxis || {}) },
                        yaxis: { ...(layout.yaxis || {}) }
                    };
                    delete fallbackLayout.xaxis.scaleanchor;
                    delete fallbackLayout.xaxis.scaleratio;
                    await plotly.newPlot(plotContainer, [trace], fallbackLayout, this.plotlyConfig);
                } else {
                    throw e;
                }
            }
            
            this.lastPlotData = { psfResult, options, type: '2D' };
            // console.log('✅ [PSFPlot] 2D PSFプロット生成完了');

        } catch (error) {
            console.error('❌ [PSFPlot] 2D PSFプロット生成エラー:', error);
            throw error;
        }
    }

    /**
     * 3D PSFサーフェスを表示
     * @param {Object} psfResult - PSF計算結果
     * @param {Object} options - プロットオプション
     */
    async plot3DPSF(psfResult, options = {}) {
        const {
            logScale = false,
            colorscale = PSFPlotter.getBlueGreenRedColorscale(),
            showMetrics = true,
            title = 'Point Spread Function 3D'
        } = options;

        // console.log('🎯 [PSFPlot] 3D PSFプロット生成中...');

        try {
            const psfData = psfResult?.psfData || psfResult?.psf || psfResult?.intensity;
            if (!psfData || !Array.isArray(psfData) || !Array.isArray(psfData[0])) {
                throw new Error('PSFデータが見つかりません（psfData/psf/intensity のいずれも未設定）');
            }
            const size = psfData.length;
            const rawPixelSize = Number(options.pixelSize);
            const fallbackPixelSize = Number(psfResult?.options?.pixelSize);
            const pixelSize = (Number.isFinite(rawPixelSize) && rawPixelSize > 0)
                ? rawPixelSize
                : ((Number.isFinite(fallbackPixelSize) && fallbackPixelSize > 0) ? fallbackPixelSize : 1.0);

            // データの前処理
            const plotData = this.preprocessPSFData(psfData, logScale);
            
            // 軸の座標を生成
            const center = Math.floor(size / 2);
            const x = [];
            const y = [];
            
            for (let i = 0; i < size; i++) {
                x.push((i - center) * pixelSize);
                y.push((i - center) * pixelSize);
            }

            // PSF画像全体を左回り90°回転（表示の向き調整）
            const rotatedZ = PSFPlotter.rotateZ90CCW(plotData);
            const xForPlot = (rotatedZ.length === y.length && (rotatedZ[0]?.length ?? 0) === x.length) ? x : y;
            const yForPlot = (rotatedZ.length === y.length && (rotatedZ[0]?.length ?? 0) === x.length) ? y : [...x].reverse();

            // Plotlyの3Dサーフェスデータ
            const trace = {
                z: rotatedZ,
                x: xForPlot,
                y: yForPlot,
                type: 'surface',
                colorscale: this.normalizeColorscale(colorscale),
                showscale: true,
                colorbar: {
                    title: logScale ? 'Log Intensity' : 'Intensity',
                    titleside: 'right'
                }
            };

            const layout = {
                title: {
                    text: title,
                    font: { size: 16 }
                },
                scene: {
                    xaxis: { title: 'X Position (μm)' },
                    yaxis: { title: 'Y Position (μm)' },
                    zaxis: { title: logScale ? 'Log Intensity' : 'Intensity' },
                    camera: {
                        eye: { x: 1.5, y: 1.5, z: 1.5 }
                    }
                },
                width: 700,
                height: 600,
                margin: { l: 60, r: 60, t: 80, b: 60 }
            };

            const container = this.resolveContainer();
            if (container) {
                layout.autosize = true;
                delete layout.width;
                delete layout.height;
            }

            const plotContainer = container || this.containerElementIdOrElement;
            const plotly = this.resolvePlotly(container);
            if (!plotly) {
                throw new Error('Plotly.jsライブラリが読み込まれていません');
            }
            await plotly.newPlot(plotContainer, [trace], layout, this.plotlyConfig);
            
            this.lastPlotData = { psfResult, options, type: '3D' };
            // console.log('✅ [PSFPlot] 3D PSFプロット生成完了');

        } catch (error) {
            console.error('❌ [PSFPlot] 3D PSFプロット生成エラー:', error);
            throw error;
        }
    }

    /**
     * エンサークルドエネルギープロットを表示
     * @param {Object} psfResult - PSF計算結果
     * @param {Object} options - プロットオプション
     */
    async plotEncircledEnergy(psfResult, options = {}) {
        const {
            title = 'Encircled Energy',
            showGrid = true
        } = options;

        // console.log('🎯 [PSFPlot] エンサークルドエネルギープロット生成中...');

        try {
            const encircledEnergy = psfResult.metrics.encircledEnergy;
            
            const x = encircledEnergy.map(point => point.radius);
            const y = encircledEnergy.map(point => point.energy);

            const trace = {
                x: x,
                y: y,
                type: 'scatter',
                mode: 'lines+markers',
                name: 'Encircled Energy',
                line: { color: 'blue', width: 2 },
                marker: { size: 4 }
            };

            const layout = {
                title: {
                    text: title,
                    font: { size: 16 }
                },
                xaxis: {
                    title: 'Radius (μm)',
                    showgrid: showGrid
                },
                yaxis: {
                    title: 'Encircled Energy (%)',
                    showgrid: showGrid,
                    range: [0, 100]
                },
                width: 600,
                height: 400,
                margin: { l: 60, r: 60, t: 80, b: 60 }
            };

            const container = this.resolveContainer();
            if (container) {
                layout.autosize = true;
                delete layout.width;
                delete layout.height;
            }

            const plotContainer = container || this.containerElementIdOrElement;
            const plotly = this.resolvePlotly(container);
            if (!plotly) {
                throw new Error('Plotly.jsライブラリが読み込まれていません');
            }
            await plotly.newPlot(plotContainer, [trace], layout, this.plotlyConfig);
            
            // console.log('✅ [PSFPlot] エンサークルドエネルギープロット生成完了');
        } catch (error) {
            console.error('❌ [PSFPlot] エンサークルドエネルギープロット生成エラー:', error);
            throw error;
        }
    }

    /**
     * PSFデータの前処理
     * @param {Array} psfData - 生PSFデータ
     * @param {boolean} logScale - ログスケールフラグ
     * @returns {Array} 前処理済みデータ
     */
    preprocessPSFData(psfData, logScale) {
        const size = psfData.length;
        const processedData = Array(size).fill().map(() => Array(size).fill(0));

        // 最大値で正規化
        let maxValue = 0;
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                const v = psfData[i][j];
                if (Number.isFinite(v) && v > maxValue) maxValue = v;
            }
        }

        // 全ゼロ/非有限データのときに NaN 連鎖しないようガード
        if (!Number.isFinite(maxValue) || maxValue <= 0) {
            maxValue = 1;
        }

        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                let raw = psfData[i][j];
                if (!Number.isFinite(raw) || raw < 0) raw = 0;
                let value = raw / maxValue;
                
                if (logScale) {
                    // ログスケール（範囲：10^-6 から 10^0）
                    value = Math.max(value, 1e-6);
                    value = Math.log10(value);
                }
                
                processedData[i][j] = value;
            }
        }

        return processedData;
    }

    /**
     * メトリクス情報のアノテーションを作成
     * @param {Object} metrics - PSF評価指標
     * @returns {Array} アノテーション配列
     */
    createMetricsAnnotations(metrics) {
        if (!metrics || typeof metrics !== 'object') {
            return [];
        }

        const annotations = [];

        const fmtFixed = (v, digits) => (Number.isFinite(Number(v)) ? Number(v).toFixed(digits) : 'n/a');
        const fmtExp = (v, digits) => (Number.isFinite(Number(v)) ? Number(v).toExponential(digits) : 'n/a');

        // Strehl比
        annotations.push({
            x: 0.02,
            y: 0.98,
            xref: 'paper',
            yref: 'paper',
            text: `Strehl Ratio: ${fmtFixed(metrics.strehlRatio, 3)}`,
            showarrow: false,
            font: { size: 12, color: 'white' },
            bgcolor: 'rgba(0,0,0,0.7)',
            bordercolor: 'white',
            borderwidth: 1
        });

        // FWHM
        annotations.push({
            x: 0.02,
            y: 0.92,
            xref: 'paper',
            yref: 'paper',
            text: `FWHM: ${fmtFixed(metrics?.fwhm?.average, 2)} μm`,
            showarrow: false,
            font: { size: 12, color: 'white' },
            bgcolor: 'rgba(0,0,0,0.7)',
            bordercolor: 'white',
            borderwidth: 1
        });

        // ピーク強度
        annotations.push({
            x: 0.02,
            y: 0.86,
            xref: 'paper',
            yref: 'paper',
            text: `Peak: ${fmtExp(metrics.peakIntensity, 2)}`,
            showarrow: false,
            font: { size: 12, color: 'white' },
            bgcolor: 'rgba(0,0,0,0.7)',
            bordercolor: 'white',
            borderwidth: 1
        });

        return annotations;
    }

    /**
     * 統計情報を表示
     * @param {Object} psfResult - PSF計算結果
     * @param {string} containerId - 表示先コンテナID
     */
    displayStatistics(psfResult, containerId = null) {
        const plotContainer = this.resolveContainer();
        const container = this.resolveStatsContainer(plotContainer, containerId);
        
        if (!container) {
            // console.warn('⚠️ [PSFPlot] 統計表示用コンテナが見つかりません');
            return;
        }

        const psf2D = (psfResult && (psfResult.psfData || psfResult.psf || psfResult.intensity)) ? (psfResult.psfData || psfResult.psf || psfResult.intensity) : null;

        const derivePeakAndTotal = (data2D) => {
            if (!Array.isArray(data2D) || !Array.isArray(data2D[0])) {
                return { peak: null, total: null };
            }
            let peak = -Infinity;
            let total = 0;
            let sawFinite = false;
            for (let i = 0; i < data2D.length; i++) {
                const row = data2D[i];
                if (!Array.isArray(row)) continue;
                for (let j = 0; j < row.length; j++) {
                    const v = row[j];
                    if (!Number.isFinite(v)) continue;
                    sawFinite = true;
                    if (v > peak) peak = v;
                    total += v;
                }
            }
            if (!sawFinite) return { peak: null, total: null };
            return { peak, total };
        };

        const derivedPT = derivePeakAndTotal(psf2D);

        const metrics = (psfResult && psfResult.metrics) ? psfResult.metrics : {
            strehlRatio:
                psfResult?.strehlRatio ??
                psfResult?.characteristics?.strehlRatio ??
                psfResult?.metadata?.strehlRatio ??
                null,
            fwhm: {
                x: psfResult?.fwhm?.x ?? psfResult?.characteristics?.fwhmX ?? psfResult?.metrics?.fwhm?.x ?? null,
                y: psfResult?.fwhm?.y ?? psfResult?.characteristics?.fwhmY ?? psfResult?.metrics?.fwhm?.y ?? null,
                average: null
            },
            peakIntensity: psfResult?.peakIntensity ?? psfResult?.characteristics?.peakIntensity ?? derivedPT.peak,
            totalEnergy: psfResult?.totalEnergy ?? psfResult?.characteristics?.totalEnergy ?? derivedPT.total,
            encircledEnergy:
                psfResult?.encircledEnergy ??
                psfResult?.characteristics?.encircledEnergy ??
                psfResult?.metrics?.encircledEnergy ??
                null
        };

        if (metrics && metrics.fwhm) {
            const x = metrics.fwhm.x;
            const y = metrics.fwhm.y;
            metrics.fwhm.average = (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) ? (Number(x) + Number(y)) / 2 : null;
        }

        const PSF_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__PSF_DEBUG);
        const d = (PSF_DEBUG && psfResult && psfResult.diagnostics) ? psfResult.diagnostics : null;
        const fmtNum = (v, digits = 6) => (v === null || v === undefined || !isFinite(Number(v))) ? 'n/a' : Number(v).toFixed(digits);
        const fmtExp = (v, digits = 3) => (v === null || v === undefined || !isFinite(Number(v))) ? 'n/a' : Number(v).toExponential(digits);

        const samplingSize = Number(psfResult?.samplingSize ?? psfResult?.gridSize);
        const wavelength = Number(psfResult?.wavelength);

        const statsHTML = `
            <div class="psf-statistics">
                <h4>PSF Statistics</h4>
                <table class="stats-table">
                    <tr><td>Sampling Size:</td><td>${Number.isFinite(samplingSize) ? `${samplingSize}×${samplingSize}` : 'n/a'}</td></tr>
                    <tr><td>Wavelength:</td><td>${Number.isFinite(wavelength) ? `${wavelength.toFixed(3)} μm` : 'n/a'}</td></tr>
                    <tr><td>Strehl Ratio:</td><td>${fmtNum(metrics?.strehlRatio, 4)}</td></tr>
                    <tr><td>FWHM (X):</td><td>${fmtNum(metrics?.fwhm?.x, 3)} μm</td></tr>
                    <tr><td>FWHM (Y):</td><td>${fmtNum(metrics?.fwhm?.y, 3)} μm</td></tr>
                    <tr><td>FWHM (Avg):</td><td>${fmtNum(metrics?.fwhm?.average, 3)} μm</td></tr>
                    <tr><td>Peak Intensity:</td><td>${fmtExp(metrics?.peakIntensity, 3)}</td></tr>
                    <tr><td>Total Energy:</td><td>${fmtExp(metrics?.totalEnergy, 3)}</td></tr>
                    ${d ? `<tr><td colspan="2" style="padding-top:8px;"><b>Debug</b></td></tr>` : ''}
                    ${d ? `<tr><td>Optical Surfaces:</td><td>${d.opticalSystemRows}</td></tr>` : ''}
                    ${d ? `<tr><td>System source:</td><td>${d.opticalSystemSource || 'n/a'}</td></tr>` : ''}
                    ${d ? `<tr><td>System checksum:</td><td>${d.opticalSystemChecksum || 'n/a'}</td></tr>` : ''}
                    ${d ? `<tr><td>Object:</td><td>#${d.objectIndex} (${d.objectType})</td></tr>` : ''}
                    ${d ? `<tr><td>Field (x,y):</td><td>(${Number(d.objectX).toFixed(4)}, ${Number(d.objectY).toFixed(4)})</td></tr>` : ''}
                    ${d ? `<tr><td>OPD used:</td><td>${d.raysUsed} (skipped ${d.raysSkipped})</td></tr>` : ''}
                    ${d ? `<tr><td>OPD min/max:</td><td>${fmtNum(d.opdMinMicrons, 6)} / ${fmtNum(d.opdMaxMicrons, 6)} μm</td></tr>` : ''}
                    ${d ? `<tr><td>PSF method:</td><td>${d.psfMethod || 'n/a'}</td></tr>` : ''}
                    ${d ? `<tr><td>PSF checksum:</td><td>${d.psfChecksum || 'n/a'}</td></tr>` : ''}
                    ${d ? `<tr><td>PSF peak(x,y):</td><td>${Array.isArray(d.psfPeakXY) ? d.psfPeakXY.join(',') : 'n/a'}</td></tr>` : ''}
                    ${d ? `<tr><td>PSF centroid(x,y):</td><td>${Array.isArray(d.psfCentroidXY) ? d.psfCentroidXY.map(v => (v === null || v === undefined) ? 'n/a' : Number(v).toFixed(2)).join(',') : 'n/a'}</td></tr>` : ''}
                </table>
            </div>
        `;

        container.innerHTML = statsHTML;
        // console.log('📊 [PSFPlot] 統計情報表示完了');
    }

    /**
     * プロットをクリア
     */
    clearPlot() {
        const container = this.resolveContainer();
        const plotly = this.resolvePlotly(container);
        const target = container || this.containerElementIdOrElement;
        if (target && plotly) {
            plotly.purge(target);
            this.lastPlotData = null;
            // console.log('🧹 [PSFPlot] プロットクリア完了');
        }
    }

    /**
     * 最後のプロットデータを取得
     * @returns {Object} プロットデータ
     */
    getLastPlotData() {
        return this.lastPlotData;
    }

    /**
     * カラースケールオプションを取得
     * @returns {Array} カラースケール配列
     */
    static getColorScaleOptions() {
        return [
            'BlueGreenRed',
            'RdBu',
            'Hot',
            'Viridis',
            'Plasma',
            'Inferno',
            'Magma',
            'Cividis',
            'Rainbow',
            'Jet',
            'Blues',
            'Reds'
        ];
    }
}

/**
 * PSF表示の統合管理クラス
 */
export class PSFDisplayManager {
    constructor() {
        this.plotters = new Map();
        this.currentPSFResult = null;
    }

    /**
     * プロッターを登録
     * @param {string} name - プロッター名
     * @param {string} containerId - コンテナID
     */
    registerPlotter(name, containerId) {
        this.plotters.set(name, new PSFPlotter(containerId));
        // console.log(`📊 [PSFDisplay] プロッター登録: ${name} -> ${containerId}`);
    }

    /**
     * PSF計算結果を設定
     * @param {Object} psfResult - PSF計算結果
     */
    setPSFResult(psfResult) {
        this.currentPSFResult = psfResult;
        // console.log('💾 [PSFDisplay] PSF結果設定完了');
    }

    /**
     * 2D PSFを表示
     * @param {string} plotterName - プロッター名
     * @param {Object} options - オプション
     */
    async show2DPSF(plotterName, options = {}) {
        const plotter = this.plotters.get(plotterName);
        if (!plotter || !this.currentPSFResult) {
            throw new Error('プロッターまたはPSFデータが見つかりません');
        }

        await plotter.plot2DPSF(this.currentPSFResult, options);
    }

    /**
     * 3D PSFを表示
     * @param {string} plotterName - プロッター名
     * @param {Object} options - オプション
     */
    async show3DPSF(plotterName, options = {}) {
        const plotter = this.plotters.get(plotterName);
        if (!plotter || !this.currentPSFResult) {
            throw new Error('プロッターまたはPSFデータが見つかりません');
        }

        await plotter.plot3DPSF(this.currentPSFResult, options);
    }

    /**
     * エンサークルドエネルギーを表示
     * @param {string} plotterName - プロッター名
     * @param {Object} options - オプション
     */
    async showEncircledEnergy(plotterName, options = {}) {
        const plotter = this.plotters.get(plotterName);
        if (!plotter || !this.currentPSFResult) {
            throw new Error('プロッターまたはPSFデータが見つかりません');
        }

        await plotter.plotEncircledEnergy(this.currentPSFResult, options);
    }

    /**
     * 統計情報を表示
     * @param {string} containerId - 表示先コンテナID
     */
    showStatistics(containerId) {
        if (!this.currentPSFResult) {
            // console.warn('⚠️ [PSFDisplay] PSFデータがありません');
            return;
        }

        const plotter = this.plotters.values().next().value;
        if (plotter) {
            plotter.displayStatistics(this.currentPSFResult, containerId);
        }
    }

    /**
     * すべてのプロットをクリア
     */
    clearAllPlots() {
        for (const plotter of this.plotters.values()) {
            plotter.clearPlot();
        }
        // console.log('🧹 [PSFDisplay] 全プロットクリア完了');
    }
}

/**
 * PSF計算結果を表示する統合関数
 * @param {Object} psfResult - PSF計算結果
 * @param {string} containerId - 表示先コンテナID
 * @param {Object} options - 表示オプション
 */
export async function displayPSFResult(psfResult, containerId = 'psf-container', options = {}) {
    function findPeakLocation2D(psf2D) {
        if (!Array.isArray(psf2D) || psf2D.length === 0 || !Array.isArray(psf2D[0])) {
            return null;
        }

        const height = psf2D.length;
        const width = psf2D[0].length;

        let maxValue = -Infinity;
        let maxI = 0;
        let maxJ = 0;

        for (let i = 0; i < height; i++) {
            const row = psf2D[i];
            if (!Array.isArray(row) || row.length !== width) {
                return null;
            }
            for (let j = 0; j < width; j++) {
                const value = row[j];
                if (Number.isFinite(value) && value > maxValue) {
                    maxValue = value;
                    maxI = i;
                    maxJ = j;
                }
            }
        }

        return { maxValue, i: maxI, j: maxJ, width, height };
    }

    function fftShift2D(psf2D) {
        const peakInfo = findPeakLocation2D(psf2D);
        if (!peakInfo) {
            return null;
        }
        const { width, height } = peakInfo;

        const shiftY = Math.floor(height / 2);
        const shiftX = Math.floor(width / 2);
        const shifted = new Array(height);

        for (let i = 0; i < height; i++) {
            const srcI = (i + shiftY) % height;
            const srcRow = psf2D[srcI];
            const dstRow = new Array(width);
            for (let j = 0; j < width; j++) {
                const srcJ = (j + shiftX) % width;
                dstRow[j] = srcRow[srcJ];
            }
            shifted[i] = dstRow;
        }

        return shifted;
    }

    // チェックボックスの状態を取得（IDを統一）
    const logScaleCheckbox = document.getElementById('psf-log-scale-checkbox') || 
                            document.getElementById('psf-log-scale-cb');
    
    const {
        plotType = '2D',
        logScale = logScaleCheckbox?.checked || false,
    colorscale = PSFPlotter.getBlueGreenRedColorscale(),
        showMetrics = true
    } = options;

    // console.log('🔬 [PSFPlot] PSF結果表示開始:', psfResult);

    try {
        // コンテナの準備
        const container = document.getElementById(containerId);
        if (!container) {
            throw new Error(`コンテナ ${containerId} が見つかりません`);
        }

        // PSFのピーク位置を確認し、未シフト(fftshift未実行)っぽい場合は補正する
        // 典型的に未シフトだとピークがコーナー(0,0)付近に張り付く。
        if (psfResult && (psfResult.psf || psfResult.psfData)) {
            const psf2D = psfResult.psf || psfResult.psfData;
            const peak = findPeakLocation2D(psf2D);
            if (peak) {
                const centerI = Math.floor(peak.height / 2);
                const centerJ = Math.floor(peak.width / 2);
                const cornerThreshold = Math.max(2, Math.floor(Math.min(peak.width, peak.height) * 0.08));

                const isNearCorner =
                    (peak.i < cornerThreshold && peak.j < cornerThreshold) ||
                    (peak.i < cornerThreshold && peak.j >= peak.width - cornerThreshold) ||
                    (peak.i >= peak.height - cornerThreshold && peak.j < cornerThreshold) ||
                    (peak.i >= peak.height - cornerThreshold && peak.j >= peak.width - cornerThreshold);

                const centerValue =
                    Array.isArray(psf2D[centerI]) && Number.isFinite(psf2D[centerI][centerJ])
                        ? psf2D[centerI][centerJ]
                        : null;

                if (isNearCorner) {
                    const shifted = fftShift2D(psf2D);
                    if (shifted) {
                        psfResult.psf = shifted;
                        psfResult.metadata = psfResult.metadata || {};
                        psfResult.metadata.shiftCorrectedForPlot = true;
                    }
                }

                // 診断ログ（必要時のみ）
                const PSF_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__PSF_DEBUG);
                if (PSF_DEBUG) {
                    console.log('🔎 [PSFPlot] Peak diagnostics:', {
                        peakI: peak.i,
                        peakJ: peak.j,
                        peakValue: peak.maxValue,
                        centerI,
                        centerJ,
                        centerValue,
                        cornerThreshold,
                        shiftCorrectedForPlot: !!psfResult?.metadata?.shiftCorrectedForPlot,
                    });
                }
            }
        }

        // PSFデータの構造を変換
        const formattedResult = {
            psfData: psfResult.psf || psfResult.psfData,
            wavelength: psfResult.wavelength || 0.5876,
            samplingSize: psfResult.gridSize || 128,
            calculationTime: psfResult.calculationTime,
            metrics: psfResult.characteristics ? {
                strehlRatio: psfResult.characteristics.strehlRatio || 0,
                fwhm: {
                    x: psfResult.characteristics.fwhmX || 0,
                    y: psfResult.characteristics.fwhmY || 0,
                    average: ((psfResult.characteristics.fwhmX || 0) + (psfResult.characteristics.fwhmY || 0)) / 2
                },
                peakIntensity: psfResult.characteristics.peakIntensity || 0,
                totalEnergy: psfResult.characteristics.totalEnergy || 0,
                encircledEnergy: psfResult.characteristics.encircledEnergy || []
            } : null
        };

        // プロット用のコンテナを準備
        container.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 20px;">
                <div id="${containerId}-plot" style="width: 100%; height: 500px; border: 1px solid #ddd; border-radius: 5px;"></div>
                <div id="${containerId}-stats" style="padding: 10px; background-color: #f5f5f5; border-radius: 5px;"></div>
            </div>
        `;

        // Plotly.jsが利用可能かチェック
        if (typeof Plotly === 'undefined') {
            // console.warn('⚠️ [PSFPlot] Plotly.jsが読み込まれていません - シンプル表示');
            return;
        }

        // PSFプロッターでプロット
        const plotter = new PSFPlotter(`${containerId}-plot`);
        
        if (plotType === '3D') {
            await plotter.plot3DPSF(formattedResult, { 
                logScale, 
                colorscale, 
                showMetrics,
                title: `PSF 3D (${formattedResult.wavelength.toFixed(3)}μm)`
            });
        } else {
            await plotter.plot2DPSF(formattedResult, { 
                logScale, 
                colorscale, 
                showMetrics,
                title: `PSF (${formattedResult.wavelength.toFixed(3)}μm)`
            });
        }

        // 統計情報を表示
        if (formattedResult.metrics && showMetrics) {
            plotter.displayStatistics(formattedResult, `${containerId}-stats`);
        }

        // console.log('✅ [PSFPlot] PSF結果表示完了');

    } catch (error) {
        console.error('❌ [PSFPlot] PSF結果表示エラー:', error);
        
        // エラー時はシンプルな表示
        const container = document.getElementById(containerId);
        if (container) {
            container.innerHTML = `
                <div style="padding: 20px; text-align: center; color: #d32f2f; border: 1px solid #f44336; border-radius: 5px; background-color: #ffebee;">
                    <h3>PSF表示エラー</h3>
                    <p>PSFプロットの生成に失敗しました</p>
                    <p>エラー: ${error.message}</p>
                    <details style="margin-top: 10px; text-align: left;">
                        <summary>計算結果データ</summary>
                        <pre style="background: #f5f5f5; padding: 10px; border-radius: 3px; overflow: auto;">
${JSON.stringify(psfResult, null, 2)}
                        </pre>
                    </details>
                </div>
            `;
        }
    }
}

/**
 * 簡易PSF表示関数（Plotly.jsなしでも動作）
 * @param {Object} psfResult - PSF計算結果
 * @param {string} containerId - 表示先コンテナID
 */
export function displaySimplePSFResult(psfResult, containerId = 'psf-container') {
    // console.log('📊 [PSFPlot] 簡易PSF結果表示:', psfResult);

    const container = document.getElementById(containerId);
    if (!container) {
        console.error('❌ [PSFPlot] コンテナが見つかりません:', containerId);
        return;
    }

    const psfData = psfResult.psf || psfResult.psfData;
    const characteristics = psfResult.characteristics || {};

    container.innerHTML = `
        <div style="padding: 20px; text-align: center; color: #2e7d32; border: 1px solid #4caf50; border-radius: 5px; background-color: #e8f5e8;">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; text-align: left;">
                <div>
                    <strong>基本情報</strong><br>
                    波長: ${(psfResult.wavelength || 0.5876).toFixed(4)}μm<br>
                    グリッドサイズ: ${psfResult.gridSize || 128}×${psfResult.gridSize || 128}<br>
                    計算時間: ${psfResult.calculationTime || 'N/A'}ms
                </div>
                <div>
                    <strong>PSFデータ</strong><br>
                    配列サイズ: ${psfData ? psfData.length : 'N/A'}×${psfData && psfData[0] ? psfData[0].length : 'N/A'}<br>
                    データ型: ${psfData ? 'Array' : 'N/A'}<br>
                    最大値: ${psfData ? Math.max(...psfData.flat()).toExponential(3) : 'N/A'}
                </div>
            </div>
            ${characteristics.strehlRatio !== undefined ? `
                <div style="margin: 20px 0; padding: 15px; background-color: #f1f8e9; border-radius: 5px;">
                    <strong>光学特性</strong><br>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin-top: 10px;">
                        <div>Strehl比: ${characteristics.strehlRatio.toFixed(4)}</div>
                        <div>FWHM X: ${(characteristics.fwhmX || 0).toFixed(2)}μm</div>
                        <div>FWHM Y: ${(characteristics.fwhmY || 0).toFixed(2)}μm</div>
                    </div>
                </div>
            ` : ''}
            <p style="margin-top: 15px; font-size: 12px; color: #666;">
                📊 高品質なプロット表示にはPlotly.jsが必要です
            </p>
        </div>
    `;

    // console.log('✅ [PSFPlot] 簡易PSF結果表示完了');
}

// グローバル公開
if (typeof window !== 'undefined') {
    window['PSFPlotter'] = PSFPlotter;
    window['PSFDisplayManager'] = PSFDisplayManager;
    window['displayPSFResult'] = displayPSFResult;
    window['displaySimplePSFResult'] = displaySimplePSFResult;
    // console.log('✅ [PSFPlot] PSFプロットモジュール読み込み完了');
}
