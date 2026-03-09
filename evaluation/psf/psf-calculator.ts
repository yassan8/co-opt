/**
 * Point Spread Function Calculator from Optical Path Difference
 * OPDからPSF計算システム（WebAssembly対応版）
 * 
 * 機能:
 * - OPDデータからフーリエ変換によるPSF計算
 * - 複数サンプリング数対応（32x, 64x, 128x, 256x, 512x, 1024x, 2048x）
 * - Strehl比、エンサークルドエネルギー、FWHM計算
 * - 2D/3Dヒートマップ対応
 * - WebAssembly高速化サポート
 * 
 * 作成日: 2025/08/07
 * WASM対応: 2025/08/08
 */

// @ts-nocheck

import { isTauriRuntime } from '../../src/desktop/runtime.ts';
import { runNativePsfMap } from '../../src/desktop/ipc/client.ts';

// WebAssembly版PSF計算器のインポート（動的）
let PSFCalculatorWasm = null;
let PSFCalculatorAuto = null;

// WASM版PSF計算器のインポート
let WasmCalculatorClass = null;
let __lastFftWasmFallbackWarnAt = 0;
const __fftWasmFallbackWarnIntervalMs = 5000;
let __fftWasmPrewarmDone = false;

function isForceWasmFftEnabled(options: any): boolean {
    try {
        if (options && options.forceWasmFFT === true) return true;
        return !!(globalThis as any).__COOPT_FORCE_WASM_FFT;
    } catch (_) {
        return false;
    }
}

async function prewarmFftWasmIfNeeded() {
    if (__fftWasmPrewarmDone) return;
    try {
        const { ensureFFTWasmReady } = await import('../../rust-wasm/ts/raytracing/fft-wasm-wrapper.ts');
        const init = await ensureFFTWasmReady();
        if (init?.success) {
            __fftWasmPrewarmDone = true;
        }
    } catch (_) {
        // ignore; runtime fallback remains available
    }
}

// WASM版PSF計算器の直接ロード
async function loadWasmCalculatorDirect() {
    if (!WasmCalculatorClass) {
        try {
            const wasmModule = await import('../../rust-wasm/ts/psf/psf-wasm-wrapper.ts');
            WasmCalculatorClass = wasmModule.PSFCalculatorWasm;
            // console.log('📦 [PSF] WASM calculator module loaded directly');
            return WasmCalculatorClass;
        } catch (error) {
            // console.warn('⚠️ [PSF] Failed to load WASM calculator:', error);
            return null;
        }
    }
    return WasmCalculatorClass;
}

/**
 * 簡易FFT実装（Cooley-Tukey アルゴリズム）
 */
export class SimpleFFT {
    static __yieldQueue: any[];
    static __yieldPort: any;

    static async _yieldToUI() {
        // NOTE:
        // - requestAnimationFrame can fully pause when a tab/window is not focused/visible.
        // - setTimeout(0) is heavily clamped in background tabs (can look like "stuck").
        // Using MessageChannel yields via a regular task without relying on frame timing.
        try {
            if (typeof MessageChannel !== 'undefined') {
                if (!this.__yieldQueue || !this.__yieldPort) {
                    this.__yieldQueue = [];
                    const channel = new MessageChannel();
                    channel.port1.onmessage = () => {
                        const resolve = this.__yieldQueue.shift();
                        if (resolve) resolve();
                    };
                    this.__yieldPort = channel.port2;
                }

                await new Promise(resolve => {
                    this.__yieldQueue.push(resolve);
                    this.__yieldPort.postMessage(0);
                });
                return;
            }
        } catch (_) {
            // ignore
        }

        await new Promise(resolve => setTimeout(resolve, 0));
    }

    static fft2D(real, imag, options: { onProgress?: (data: any) => void } = {}) {
        const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
        const emit = (percent, phase, message) => {
            if (!onProgress) return;
            try {
                const p = Number(percent);
                onProgress({
                    percent: Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null,
                    phase: phase || null,
                    message: message || null
                });
            } catch (_) {
                // ignore
            }
        };

        const N = real.length;
        const M = real[0].length;

        const totalSteps = Math.max(1, (N + M));
        const stepEvery = Math.max(1, Math.floor(totalSteps / 100));
        let done = 0;

        emit(0, 'fft', `FFT 0%`);
        
        // 行方向のFFT
        for (let i = 0; i < N; i++) {
            const result = this.fft1D(real[i], imag[i]);
            real[i] = result.real;
            imag[i] = result.imag;

            done++;
            if ((done % stepEvery) === 0 || i === N - 1) {
                const p = (done / totalSteps) * 100;
                emit(p, 'fft', `FFT ${Math.floor(p)}% (rows)`);
            }
        }
        
        // 列方向のFFT
        for (let j = 0; j < M; j++) {
            const realCol = [];
            const imagCol = [];
            for (let i = 0; i < N; i++) {
                realCol[i] = real[i][j];
                imagCol[i] = imag[i][j];
            }
            
            const result = this.fft1D(realCol, imagCol);
            for (let i = 0; i < N; i++) {
                real[i][j] = result.real[i];
                imag[i][j] = result.imag[i];
            }

            done++;
            if ((done % stepEvery) === 0 || j === M - 1) {
                const p = (done / totalSteps) * 100;
                emit(p, 'fft', `FFT ${Math.floor(p)}% (cols)`);
            }
        }

        emit(100, 'fft', 'FFT 100%');
        
        return { real, imag };
    }

    static async fft2DAsync(real, imag, options: { onProgress?: (data: any) => void; yieldEvery?: number } = {}) {
        const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
        const yieldEvery = (options && Number.isFinite(options.yieldEvery)) ? Math.max(1, Math.floor(options.yieldEvery)) : 4;
        const emit = (percent, phase, message) => {
            if (!onProgress) return;
            try {
                const p = Number(percent);
                onProgress({
                    percent: Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null,
                    phase: phase || null,
                    message: message || null
                });
            } catch (_) {
                // ignore
            }
        };

        const N = real.length;
        const M = real[0].length;
        const totalSteps = Math.max(1, (N + M));
        const stepEvery = Math.max(1, Math.floor(totalSteps / 100));
        let done = 0;

        emit(0, 'fft', `FFT 0%`);

        // 行方向のFFT
        for (let i = 0; i < N; i++) {
            const result = this.fft1D(real[i], imag[i]);
            real[i] = result.real;
            imag[i] = result.imag;

            done++;
            if ((done % stepEvery) === 0 || i === N - 1) {
                const p = (done / totalSteps) * 100;
                emit(p, 'fft', `FFT ${Math.floor(p)}% (rows)`);
            }

            if (yieldEvery > 0 && (i % yieldEvery) === 0) {
                await this._yieldToUI();
            }
        }

        // 列方向のFFT
        for (let j = 0; j < M; j++) {
            const realCol = [];
            const imagCol = [];
            for (let i = 0; i < N; i++) {
                realCol[i] = real[i][j];
                imagCol[i] = imag[i][j];
            }

            const result = this.fft1D(realCol, imagCol);
            for (let i = 0; i < N; i++) {
                real[i][j] = result.real[i];
                imag[i][j] = result.imag[i];
            }

            done++;
            if ((done % stepEvery) === 0 || j === M - 1) {
                const p = (done / totalSteps) * 100;
                emit(p, 'fft', `FFT ${Math.floor(p)}% (cols)`);
            }

            if (yieldEvery > 0 && (j % yieldEvery) === 0) {
                await this._yieldToUI();
            }
        }

        emit(100, 'fft', 'FFT 100%');
        return { real, imag };
    }
    
    static fft1D(real, imag) {
        const N = real.length;
        if (N <= 1) return { real: [...real], imag: [...imag] };
        
        // ビット逆順並べ替え
        const realOut = new Array(N);
        const imagOut = new Array(N);
        for (let i = 0; i < N; i++) {
            const j = this.reverseBits(i, Math.log2(N));
            realOut[j] = real[i];
            imagOut[j] = imag[i];
        }
        
        // バタフライ演算
        for (let s = 1; s <= Math.log2(N); s++) {
            const m = 1 << s;
            const wm = { real: Math.cos(-2 * Math.PI / m), imag: Math.sin(-2 * Math.PI / m) };
            
            for (let k = 0; k < N; k += m) {
                let w = { real: 1, imag: 0 };
                
                for (let j = 0; j < m / 2; j++) {
                    const t = {
                        real: w.real * realOut[k + j + m / 2] - w.imag * imagOut[k + j + m / 2],
                        imag: w.real * imagOut[k + j + m / 2] + w.imag * realOut[k + j + m / 2]
                    };
                    const u = { real: realOut[k + j], imag: imagOut[k + j] };
                    
                    realOut[k + j] = u.real + t.real;
                    imagOut[k + j] = u.imag + t.imag;
                    realOut[k + j + m / 2] = u.real - t.real;
                    imagOut[k + j + m / 2] = u.imag - t.imag;
                    
                    const wNext = {
                        real: w.real * wm.real - w.imag * wm.imag,
                        imag: w.real * wm.imag + w.imag * wm.real
                    };
                    w = wNext;
                }
            }
        }
        
        return { real: realOut, imag: imagOut };
    }
    
    static reverseBits(num, numBits) {
        let result = 0;
        for (let i = 0; i < numBits; i++) {
            result = (result << 1) | (num & 1);
            num >>= 1;
        }
        return result;
    }
}

/**
 * OPDからPSFを計算するメインクラス（WASM対応）
 */
export class PSFCalculator {
    lastCalculationData: any;
    supportedSamplings: number[];
    wasmCalculator: any;
    useWasm: boolean;
    performanceMode: string;
    spatialBinsOverride: number | null;
    _wasmInitPromise: Promise<void> | null;

    constructor() {
        this.lastCalculationData = null;
                this.supportedSamplings = [32, 64, 128, 256, 512, 1024, 2048, 4096];
        this.wasmCalculator = null;
        this.useWasm = true; // WASM使用フラグ
        this.performanceMode = 'auto'; // 'auto', 'wasm', 'javascript'
    this.spatialBinsOverride = null; // 補間用の空間インデックス分割数（nullで自動）
        this._wasmInitPromise = null;
        
        // WASM計算器の初期化（非同期）
        this._wasmInitPromise = this.initializeWasmCalculator();
    }

    /**
     * 補間用の空間インデックス分割数を設定（nullで自動計算に戻す）
     * @param {number|null} bins
     */
    setSpatialBins(bins) {
        if (bins == null) {
            this.spatialBinsOverride = null;
            return;
        }
        const n = Math.max(4, Math.min(256, Math.floor(bins)));
        this.spatialBinsOverride = n;
    }

    /**
     * WASM計算器の初期化
     */
    async initializeWasmCalculator() {
        try {
            const WasmCalculatorClass = await loadWasmCalculatorDirect();
            if (WasmCalculatorClass) {
                this.wasmCalculator = new WasmCalculatorClass();
                // console.log('🚀 [PSF] WASM calculator initialized');
                
                // WASM初期化を待機
                if (this.wasmCalculator.initializeWasm) {
                    await this.wasmCalculator.initializeWasm();
                }
                
                // 初期化状態を確認
                if (this.wasmCalculator.isReady) {
                    // console.log('✅ [PSF] WASM calculator ready for use');
                } else if (this.wasmCalculator.initializationFailed) {
                    // console.warn('⚠️ [PSF] WASM initialization failed, JavaScript fallback will be used');
                    this.wasmCalculator = null;
                }
            }
        } catch (error) {
            // console.warn('⚠️ [PSF] WASM calculator initialization failed:', error);
            this.wasmCalculator = null;
        }
    }

    /**
     * Sourceから主波長を取得
     * @returns {number} 波長（μm）
     */
    getSourceWavelength() {
        try {
            if (typeof window !== 'undefined') {
                // 第一候補: Sourceテーブルの主波長
                if (typeof window.getPrimaryWavelength === 'function') {
                    const wl = Number(window.getPrimaryWavelength());
                    if (isFinite(wl) && wl > 0) {
                        // console.log(`🌈 [PSF] 主波長（Source）を使用: ${wl}μm`);
                        return wl;
                    }
                }

                // フォールバック: tableSource から直接取得
                if (window.tableSource && typeof window.tableSource.getData === 'function') {
                    const data = window.tableSource.getData();
                    const primary = Array.isArray(data) ? data.find(r => r.primary === 'Primary Wavelength') : null;
                    const wl = primary ? Number(primary.wavelength) : NaN;
                    if (isFinite(wl) && wl > 0) {
                        // console.log(`🌈 [PSF] 主波長（tableSource）を使用: ${wl}μm`);
                        return wl;
                    }
                }
            }

            // デフォルト値（d線近傍）
            // console.log('⚠️ [PSF] 主波長が未設定のため既定値を使用: 0.5876μm');
            return 0.5876;
        } catch (error) {
            // console.warn('⚠️ [PSF] 主波長取得エラー:', error);
            return 0.5876;
        }
    }

    /**
     * OPDデータからPSFを計算（WASM対応）
     * @param {Object} opdData - OPD計算結果
     * @param {Object} options - 計算オプション
     * @returns {Object} PSF計算結果
     */
    async calculatePSF(opdData, options = {}) {
        const {
            samplingSize = 128,
            wavelength = null,
            pupilDiameter = 10.0, // mm
            focalLength = 100.0,   // mm
            pixelSize = null,
            forceImplementation = null // 'wasm', 'javascript', または null（自動選択）
        } = options;

        const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
        const emitProgress = (percent, phase, message) => {
            if (!onProgress) return;
            try {
                const p = Number(percent);
                onProgress({
                    percent: Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null,
                    phase: phase || null,
                    message: message || null
                });
            } catch (_) {
                // ignore
            }
        };

        // console.log('🔬 [PSF] PSF計算開始');

        const effectiveWavelength = wavelength || this.getSourceWavelength();

        const forceNative = forceImplementation === 'native';
        const preferNative = isTauriRuntime() && forceImplementation !== 'javascript' && forceImplementation !== 'wasm';
        if (forceNative || preferNative) {
            try {
                console.log(`🚀 [PSF] NativeRust requested (force=${forceNative}, prefer=${preferNative})`);
                emitProgress(0, 'psf-native', `Native PSF start (${samplingSize}x${samplingSize})`);
                const nativeStartTime = performance.now();
                const nativeResult = await this.calculatePSFNative(opdData, {
                    ...options,
                    samplingSize,
                    wavelength: effectiveWavelength,
                    pupilDiameter,
                    focalLength,
                    pixelSize,
                });
                const nativeEndTime = performance.now();
                nativeResult.calculationTime = nativeEndTime - nativeStartTime;
                nativeResult.implementationUsed = 'NativeRust';
                console.log(`✅ [PSF] NativeRust completed (${nativeResult.calculationTime.toFixed(1)}ms)`);
                emitProgress(100, 'psf-native', 'Native PSF done');
                return nativeResult;
            } catch (error) {
                if (forceNative) {
                    console.error('❌ [PSF] NativeRust failed (force mode):', error);
                    throw error;
                }
                console.warn('⚠️ [PSF] Native PSF failed, falling back to JavaScript:', error);
            }
        }

        // 可能なら先にWASM初期化を待ってから実装方法を決定する。
        // ここで待たないと、初回計算が常にJSへ落ちてしまう。
        const wantsWasm = false;

        if (wantsWasm) {
            if (!this._wasmInitPromise) {
                this._wasmInitPromise = this.initializeWasmCalculator();
            }

            try {
                if (forceImplementation === 'wasm') {
                    // 強制WASMは待ち切る（失敗時は後段で例外/フォールバック）
                    await this._wasmInitPromise;
                } else {
                    // auto時はUIブロックを避けるため短時間だけ待つ（以降は次回でWASMに切替）
                    await Promise.race([
                        this._wasmInitPromise,
                        new Promise(resolve => setTimeout(resolve, 2000))
                    ]);
                }
            } catch {
                // 初期化失敗時は後段でJSへフォールバック
            }
        }

        // 実装方法を決定
        const hasPrecomputedGrid = !!(opdData && opdData.gridData);
        const wantsWasmNow = this.shouldUseWasm(samplingSize, forceImplementation);

        // forceImplementation==='wasm' などでWASMを望むのに計算器が未生成の場合は、ここで生成を試みる
        if (wantsWasmNow && !this.wasmCalculator && !this._wasmInitPromise) {
            this._wasmInitPromise = (async () => {
                try {
                    const WasmClass = await loadWasmCalculatorDirect();
                    if (WasmClass) {
                        this.wasmCalculator = new WasmClass();
                        // initializeWasm があるなら明示的に待つ
                        if (this.wasmCalculator.initializeWasm) {
                            await this.wasmCalculator.initializeWasm();
                        }
                    }
                } catch {
                    this.wasmCalculator = null;
                }
            })();

            try {
                await this._wasmInitPromise;
            } catch {
                // 後段でJSへフォールバック
            }
        }

        // WASMを望む方針なら、初期化完了まで待つ（未完了だと常にJSへ落ちる）
        if (wantsWasmNow && this._wasmInitPromise) {
            try {
                await this._wasmInitPromise;
            } catch {
                // 初期化失敗時は後段でJSへフォールバック
            }
        }

        // 初期化が走った後に、まだReadyでない場合は明示的に初期化を再試行（安全側）
        if (wantsWasmNow && this.wasmCalculator && !this.wasmCalculator.isReady && !this.wasmCalculator.initializationFailed) {
            try {
                if (this.wasmCalculator.initializeWasm) {
                    await this.wasmCalculator.initializeWasm();
                }
            } catch {
                // 後段でJSへフォールバック
            }
        }

        // 最終判定: gridData の場合は「grid入力WASM API」がある時のみWASMを使う
        const useWasm =
            wantsWasmNow &&
            this.wasmCalculator &&
            this.wasmCalculator.isReady &&
            (!hasPrecomputedGrid || !!this.wasmCalculator.calculatePSFGrid);
        
        // console.log('🎯 [PSF] Implementation selection:', {
        //     samplingSize: `${samplingSize}x${samplingSize}`,
        //     forceImplementation,
        //     wasmAvailable: !!this.wasmCalculator,
        //     wasmReady: this.wasmCalculator ? this.wasmCalculator.isReady : false,
        //     shouldUseWasm: useWasm,
        //     finalImplementation: useWasm && this.wasmCalculator && this.wasmCalculator.isReady ? 'WASM' : 'JavaScript'
        // });
        
        if (useWasm && this.wasmCalculator && this.wasmCalculator.isReady) {
            try {
                // console.log('🚀 [PSF] Using WebAssembly implementation');
                const wasmStartTime = performance.now();
                emitProgress(0, 'psf-wasm', `WASM PSF start (${samplingSize}x${samplingSize})`);
                emitProgress(5, 'psf-wasm', 'WASM preparing...');
                
                // WASM計算器のメソッドを直接呼び出し
                const wasmResult = await this.wasmCalculator.calculatePSFWasm(opdData, {
                    samplingSize,
                    wavelength: effectiveWavelength,
                    pupilDiameter,
                    focalLength,
                    ...options
                });
                emitProgress(95, 'psf-wasm', 'WASM computed, finalizing...');
                
                const wasmEndTime = performance.now();
                // console.log(`✅ [PSF] WASM calculation completed in ${(wasmEndTime - wasmStartTime).toFixed(1)}ms`);
                
                // WASM結果をPSFCalculator形式に変換
                const result = this.convertWasmResultToStandardFormat(wasmResult, samplingSize, effectiveWavelength);
                result.calculationTime = wasmEndTime - wasmStartTime;
                result.implementationUsed = 'WASM';
                emitProgress(100, 'psf-wasm', 'WASM PSF done');
                return result;
                
            } catch (error) {
                // console.warn('⚠️ [PSF] WASM calculation failed, falling back to JavaScript:', error);
                // JavaScript版にフォールバック
            }
        }

        // console.log('📱 [PSF] Using JavaScript implementation');
        const jsStartTime = performance.now();
        const result = await this.calculatePSFJavaScript(opdData, {
            ...options,
            forceWasmFFT: options?.forceWasmFFT !== false
        });
        const jsEndTime = performance.now();
        
        // console.log(`✅ [PSF] JavaScript calculation completed in ${(jsEndTime - jsStartTime).toFixed(1)}ms`);
        result.calculationTime = jsEndTime - jsStartTime;
        result.implementationUsed = 'JavaScript';
        return result;
    }

    async calculatePSFNative(opdData, options = {}) {
        const {
            samplingSize = 128,
            wavelength = null,
            pupilDiameter = 10.0,
            focalLength = 100.0,
            pixelSize = null,
            removeTilt = true,
            recenterIfWrapped = undefined,
            zeroPadTo = 0
        } = options;
        const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;

        if (!opdData || (!opdData.rayData && !opdData.gridData)) {
            throw new Error('有効なOPDデータが必要です');
        }
        if (!this.supportedSamplings.includes(samplingSize)) {
            throw new Error(`サポートされていないサンプリングサイズ: ${samplingSize}`);
        }

        const effectiveWavelength = wavelength || this.getSourceWavelength();
        const gridData = this.convertOPDToGrid(opdData, samplingSize);

        const shouldRecenterIfWrapped = (recenterIfWrapped === undefined)
            ? !!removeTilt
            : !!recenterIfWrapped;

        const minRecommendedSize = 512;
        const autoZeroPad = (!zeroPadTo || zeroPadTo === 0);
        const targetSize = autoZeroPad
            ? Math.max(samplingSize, minRecommendedSize)
            : ((zeroPadTo > samplingSize && this.supportedSamplings.includes(zeroPadTo)) ? zeroPadTo : samplingSize);

        const usedPixelSize = pixelSize || this.calculatePixelSize(
            effectiveWavelength,
            focalLength,
            pupilDiameter,
            samplingSize,
            targetSize
        );

        const jobId = `native-psf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        let unlistenProgress = null;
        if (onProgress) {
            try {
                const { listen } = await import('@tauri-apps/api/event');
                unlistenProgress = await listen('analysis-progress', (event) => {
                    try {
                        const data = event?.payload || {};
                        if (!data || String(data.jobId || '') !== jobId) return;
                        const percent = Number(data.percent);
                        onProgress({
                            percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null,
                            phase: data.phase || 'psf-native',
                            message: data.message || null,
                        });
                    } catch (_) {}
                });
            } catch (_) {
                // Event bridge is optional; caller still receives coarse progress.
            }
        }

        let response;
        try {
            response = await runNativePsfMap({
                jobId,
                gridOpd: Array.from({ length: samplingSize }, (_, i) => Array.from(gridData.opd[i] || [])),
                gridAmplitude: Array.from({ length: samplingSize }, (_, i) => Array.from(gridData.amplitude[i] || [])),
                pupilMask: Array.from({ length: samplingSize }, (_, i) => Array.from(gridData.pupilMask[i] || [])),
                wavelengthUm: effectiveWavelength,
                pixelSizeUm: usedPixelSize,
                removeTilt,
                zeroPadTo: targetSize,
                recenterIfWrapped: shouldRecenterIfWrapped,
            });
        } finally {
            try {
                if (typeof unlistenProgress === 'function') {
                    unlistenProgress();
                }
            } catch (_) {}
        }

        return {
            psfData: response.psfData,
            metrics: response.metrics,
            samplingSize,
            wavelength: effectiveWavelength,
            gridData,
            options: { pupilDiameter, focalLength, pixelSize: usedPixelSize },
            timestamp: new Date().toISOString(),
            metadata: {
                method: 'native-rust',
                backend: response.backend,
                samplingSize,
                fftSize: response.fftSize,
                wavelength: effectiveWavelength,
                pixelSize: usedPixelSize
            }
        };
    }

    /**
     * WASM使用判定
     * @param {number} samplingSize サンプリングサイズ
     * @param {string} forceImplementation 強制実装指定
     * @returns {boolean} WASM使用するかどうか
     */
    shouldUseWasm(samplingSize, forceImplementation) {
        return false;
    }

    /**
     * WASM計算結果を標準PSFCalculator形式に変換
     * @param {Object} wasmResult WASM計算結果
     * @param {number} samplingSize サンプリングサイズ
     * @param {number} wavelength 波長
     * @returns {Object} 標準形式のPSF結果
     */
    convertWasmResultToStandardFormat(wasmResult, samplingSize, wavelength) {
        if (!wasmResult) {
            throw new Error('Invalid WASM result');
        }

        return {
            psf: wasmResult.psf || wasmResult.intensity,
            strehlRatio: wasmResult.strehlRatio,
            fwhm: wasmResult.fwhm || { x: 0, y: 0 },
            encircledEnergy: wasmResult.encircledEnergy || { radii: [], values: [] },
            wavelength,
            metadata: {
                ...wasmResult.metadata,
                samplingSize,
                wavelength,
                calculator: 'wasm-integrated',
                pixelSize: this.calculatePixelSize(
                    wavelength,
                    (wasmResult.metadata?.focalLength ?? 100.0),
                    (wasmResult.metadata?.pupilDiameter ?? 10.0),
                    samplingSize
                ),
                method: 'wasm'
            },
            options: {
                pupilDiameter: wasmResult.metadata?.pupilDiameter ?? 10.0,
                focalLength: wasmResult.metadata?.focalLength ?? 100.0,
                pixelSize: wasmResult.metadata?.pixelSize ?? this.calculatePixelSize(
                    wavelength,
                    (wasmResult.metadata?.focalLength ?? 100.0),
                    (wasmResult.metadata?.pupilDiameter ?? 10.0),
                    samplingSize
                )
            },
            // PSFCalculator互換フィールド
            rayCount: wasmResult.metadata?.rayCount || 0,
            executionTime: wasmResult.metadata?.executionTime || 0
        };
    }

    /**
     * JavaScript版PSF計算（詳細計測付き）
     * @param {Object} opdData - OPD計算結果
     * @param {Object} options - 計算オプション
     * @returns {Object} PSF計算結果
     */
    async calculatePSFJavaScript(opdData, options = {}) {
        const {
            samplingSize = 128,
            wavelength = null,
            pupilDiameter = 10.0, // mm
            focalLength = 100.0,   // mm
            pixelSize = null,
            // true: remove piston+tilt (best-fit plane) before FFT (default; legacy behavior)
            // false: remove piston only and keep tilt (PSF peak shift becomes visible)
            removeTilt = true,
            // true: if peak is near border, circular-shift PSF back to center.
            // NOTE: this effectively hides tilt-driven PSF shift, so when removeTilt=false
            // the default is to NOT recenter unless explicitly requested.
            recenterIfWrapped = undefined,
            // Zero-padding target size (e.g., 256, 512) to increase PSF resolution
            // Set to samplingSize or 0 to disable zero-padding
            zeroPadTo = 0
        } = options;

        const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
        const emitProgress = (percent, phase, message) => {
            if (!onProgress) return;
            try {
                const p = Number(percent);
                onProgress({
                    percent: Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : null,
                    phase: phase || null,
                    message: message || null
                });
            } catch (_) {
                // ignore
            }
        };

        // Default recentering policy:
        // - removeTilt=true  : keep legacy behavior (allow wrap recenter)
        // - removeTilt=false : preserve physical tilt shift and avoid wrap artifacts
        const shouldRecenterIfWrapped = (recenterIfWrapped === undefined)
            ? !!removeTilt
            : !!recenterIfWrapped;

        // console.log('🔬 [PSF] JavaScript PSF計算開始');
        // console.log(`📊 [PSF] サンプリングサイズ: ${samplingSize}x${samplingSize}`);

        // 詳細計測開始
        const totalStartTime = performance.now();
        const breakdown = {};

        // 入力データ検証
        // - rayData: サンプル点列（WASM互換）
        // - gridData: 既にFFT用格子で与えられる（Zernike面などを直接サンプリングした場合）
        if (!opdData || (!opdData.rayData && !opdData.gridData)) {
            throw new Error('有効なOPDデータが必要です');
        }

        // Proactively initialize FFT WASM so first FFT call is less likely to fall back.
        await prewarmFftWasmIfNeeded();

        emitProgress(0, 'psf', `PSF start (${samplingSize}x${samplingSize})`);

        // Debug: outlier-filter logging toggle confirmation (helps diagnose cache / flag issues)
        if (typeof globalThis !== 'undefined' && globalThis.__PSF_LOG_OUTLIER_FILTER === true) {
            const hasGrid = !!(opdData && opdData.gridData);
            const rayCount = Array.isArray(opdData?.rayData) ? opdData.rayData.length : 0;
            console.log(`🔍 [PSF] __PSF_LOG_OUTLIER_FILTER=true (input=${hasGrid ? 'gridData' : 'rayData'}, rayDataCount=${rayCount})`);
        }

        if (!this.supportedSamplings.includes(samplingSize)) {
            throw new Error(`サポートされていないサンプリングサイズ: ${samplingSize}`);
        }

        // 波長を取得
        const effectiveWavelength = wavelength || this.getSourceWavelength();
        // console.log(`🌈 [PSF] 使用波長: ${effectiveWavelength}μm`);

        // 1. OPDデータを格子データに変換（計測）
        emitProgress(5, 'psf-grid', 'Preparing FFT grid...');
        const gridStartTime = performance.now();
        const gridData = this.convertOPDToGrid(opdData, samplingSize);
        breakdown.interpolationTime = performance.now() - gridStartTime;
        emitProgress(20, 'psf-grid', 'FFT grid ready');
        
        // 2. 複素振幅を計算（計測）
        emitProgress(25, 'psf-amplitude', 'Computing complex amplitude...');
        const complexStartTime = performance.now();
        let complexAmplitude = this.calculateComplexAmplitude(gridData, effectiveWavelength, { removeTilt });
        breakdown.complexAmplitudeTime = performance.now() - complexStartTime;
        emitProgress(35, 'psf-amplitude', 'Complex amplitude ready');
        
        // 2.5. Zero-padding for higher PSF resolution (optional)
        // Auto zero-pad to minimum 512x512 for better resolution, unless disabled
        const minRecommendedSize = 512;
        // If zeroPadTo is 0 or undefined, enable auto zero-padding
        const autoZeroPad = (!zeroPadTo || zeroPadTo === 0);
        let targetSize = autoZeroPad
            ? Math.max(samplingSize, minRecommendedSize)
            : ((zeroPadTo > samplingSize && this.supportedSamplings.includes(zeroPadTo)) ? zeroPadTo : samplingSize);
        
        if (targetSize > samplingSize) {
            console.log(`🔍 [PSF] Zero-padding from ${samplingSize}×${samplingSize} to ${targetSize}×${targetSize} (${autoZeroPad ? 'auto' : 'manual'})`);
            emitProgress(40, 'psf-zeropad', `Zero-padding to ${targetSize}×${targetSize}...`);
            const padStartTime = performance.now();
            complexAmplitude = this.zeroPadComplexAmplitude(complexAmplitude, samplingSize, targetSize);
            breakdown.zeroPadTime = performance.now() - padStartTime;
            emitProgress(45, 'psf-zeropad', 'Zero-padding done');
            console.log(`✅ [PSF] Zero-padding completed, new size: ${complexAmplitude.real.length}×${complexAmplitude.real[0].length}`);
        } else {
            // No zero-padding applied
            targetSize = samplingSize;
            console.log(`ℹ️ [PSF] No zero-padding (samplingSize=${samplingSize}, targetSize=${targetSize})`);
        }

        // Strehl比: ピーク正規化前のピーク強度を、同一スケーリングの回折限界ピークと比較
        // （表示用PSFは従来どおりピーク=1に正規化する）
        let strehlRatioOverride = 0;
        try {
            const aberrated = await this.performFFTAsync(complexAmplitude, {
                normalizeToPeak: false,
                returnMaxIntensity: true,
                onProgress: (evt) => {
                    const p = Number(evt?.percent);
                    if (!Number.isFinite(p)) return;
                    emitProgress(35 + 10 * (p / 100), 'psf-fft-pre', evt?.message || 'FFT (pre)');
                }
            });
            const aberratedPeak = aberrated?.maxIntensity ?? 0;

            // Use targetSize (after zero-padding) for ideal PSF calculation
            const idealSize = targetSize > samplingSize ? targetSize : samplingSize;
            const idealReal = Array(idealSize).fill().map(() => Array(idealSize).fill(0));
            const idealImag = Array(idealSize).fill().map(() => Array(idealSize).fill(0));
            
            // Calculate offset if zero-padded
            const offset = targetSize > samplingSize ? Math.floor((targetSize - samplingSize) / 2) : 0;
            
            for (let i = 0; i < samplingSize; i++) {
                for (let j = 0; j < samplingSize; j++) {
                    if (gridData.pupilMask[i][j]) {
                        idealReal[i + offset][j + offset] = gridData.amplitude[i][j];
                        idealImag[i + offset][j + offset] = 0;
                    }
                }
            }
            const ideal = await this.performFFTAsync({ real: idealReal, imag: idealImag }, {
                normalizeToPeak: false,
                returnMaxIntensity: true,
                onProgress: (evt) => {
                    const p = Number(evt?.percent);
                    if (!Number.isFinite(p)) return;
                    emitProgress(45 + 10 * (p / 100), 'psf-fft-pre', evt?.message || 'FFT (ideal)');
                }
            });
            const idealPeak = ideal?.maxIntensity ?? 0;

            if (idealPeak > 0 && isFinite(aberratedPeak) && isFinite(idealPeak)) {
                const ratio = aberratedPeak / idealPeak;
                strehlRatioOverride = Math.max(0, Math.min(1, ratio));
            }
        } catch (_) {
            strehlRatioOverride = 0;
        }
        
        // 3. フーリエ変換でPSFを計算（計測）
        const fftStartTime = performance.now();
        emitProgress(60, 'psf-fft', 'FFT...');
        console.log(`🔬 [PSF] Performing FFT on ${complexAmplitude.real.length}×${complexAmplitude.real[0].length} grid`);
        let psfData = await this.performFFTAsync(complexAmplitude, {
            onProgress: (evt) => {
                const p = Number(evt?.percent);
                if (!Number.isFinite(p)) return;
                // Map FFT percent into PSF stage: 60..90
                emitProgress(60 + 30 * (p / 100), 'psf-fft', evt?.message || `FFT ${Math.floor(p)}%`);
            }
        });
        // ピークが端にラップして見えるケースを救済（残留チルト等）
        if (shouldRecenterIfWrapped) {
            psfData = this.recenterPSFIfWrapped(psfData);
        }
        breakdown.fftTime = performance.now() - fftStartTime;
        emitProgress(90, 'psf-fft', 'FFT done');
        
        // 4. PSF評価指標を計算（計測）
        emitProgress(92, 'psf-metrics', 'Computing metrics...');
        const metricsStartTime = performance.now();
        // Pixel size scaling:
        // - Base pitch is set by λ * f / D.
        // - If we zero-pad (FFT size > pupil grid size), the pitch shrinks by (pupilGridSize / fftSize).
        const usedPixelSize = pixelSize || this.calculatePixelSize(
            effectiveWavelength,
            focalLength,
            pupilDiameter,
            samplingSize,
            targetSize
        );
        console.log(`📏 [PSF] Pixel size: ${(usedPixelSize * 1000).toFixed(3)} nm (grid ${samplingSize}→FFT ${targetSize})`);
        const metrics = this.calculatePSFMetrics(psfData, {
            wavelength: effectiveWavelength,
            pupilDiameter,
            focalLength,
            pixelSize: usedPixelSize,
            strehlRatioOverride
        });
        breakdown.metricsTime = performance.now() - metricsStartTime;
        
        const totalTime = performance.now() - totalStartTime;

        const result = {
            psfData,
            metrics,
            samplingSize,
            wavelength: effectiveWavelength,
            gridData,
            options: { pupilDiameter, focalLength, pixelSize: usedPixelSize },
            timestamp: new Date().toISOString(),
            metadata: {
                ...breakdown,
                totalTime,
                method: 'javascript',
                samplingSize,
                fftSize: targetSize,  // Actual FFT size (after zero-padding)
                wavelength: effectiveWavelength,
                pixelSize: usedPixelSize
            }
        };

        this.lastCalculationData = result;

        emitProgress(100, 'psf', 'PSF done');
        
        // console.log(`✅ [PSF] JavaScript PSF計算完了 (${totalTime.toFixed(1)}ms)`, {
        //     'Interpolation': `${breakdown.interpolationTime.toFixed(1)}ms`,
        //     'Complex Amplitude': `${breakdown.complexAmplitudeTime.toFixed(1)}ms`,
        //     'FFT': `${breakdown.fftTime.toFixed(1)}ms`,
        //     'Metrics': `${breakdown.metricsTime.toFixed(1)}ms`
        // });
        
        return result;
    }

    /**
     * PSFのピーク位置を検出
     * @param {Array} psfData 2D配列
     * @returns {{i:number,j:number,max:number}|null}
     */
    findPeakLocation(psfData) {
        if (!Array.isArray(psfData) || psfData.length === 0 || !Array.isArray(psfData[0])) return null;
        const h = psfData.length;
        const w = psfData[0].length;
        let max = -Infinity;
        let maxI = 0;
        let maxJ = 0;
        for (let i = 0; i < h; i++) {
            const row = psfData[i];
            if (!Array.isArray(row) || row.length !== w) return null;
            for (let j = 0; j < w; j++) {
                const v = row[j];
                if (Number.isFinite(v) && v > max) {
                    max = v;
                    maxI = i;
                    maxJ = j;
                }
            }
        }
        return { i: maxI, j: maxJ, max };
    }

    /**
     * 2D配列を循環シフト
     * @param {Array} data 2D配列
     * @param {number} shiftI 行方向シフト（+で下へ）
     * @param {number} shiftJ 列方向シフト（+で右へ）
     */
    circularShift2D(data, shiftI, shiftJ) {
        const h = data.length;
        const w = data[0].length;
        const out = new Array(h);
        for (let i = 0; i < h; i++) {
            const srcI = (i - shiftI) % h;
            const si = srcI < 0 ? srcI + h : srcI;
            const srcRow = data[si];
            const dstRow = new Array(w);
            for (let j = 0; j < w; j++) {
                const srcJ = (j - shiftJ) % w;
                const sj = srcJ < 0 ? srcJ + w : srcJ;
                dstRow[j] = srcRow[sj];
            }
            out[i] = dstRow;
        }
        return out;
    }

    /**
     * ピークが配列端にラップしているときだけ、ピークが中心に来るよう循環シフトする。
     * @param {Array} psfData 2D PSF
     */
    recenterPSFIfWrapped(psfData) {
        const peak = this.findPeakLocation(psfData);
        if (!peak) return psfData;

        const size = psfData.length;
        const center = Math.floor(size / 2);
        const border = Math.max(2, Math.floor(size * 0.08));

        const nearBorder =
            peak.i < border || peak.i >= size - border ||
            peak.j < border || peak.j >= size - border;

        if (!nearBorder) return psfData;

        const shiftI = center - peak.i;
        const shiftJ = center - peak.j;
        return this.circularShift2D(psfData, shiftI, shiftJ);
    }

    /**
     * OPDデータを規則的な格子に変換
     * @param {Object} opdData - OPD計算結果
     * @param {number} samplingSize - サンプリングサイズ
     * @returns {Object} 格子データ
     */
    convertOPDToGrid(opdData, samplingSize) {
        // console.log('📐 [PSF] OPDデータを格子に変換中...');

        const logOutlierFilter = (typeof globalThis !== 'undefined' && globalThis.__PSF_LOG_OUTLIER_FILTER === true);

        // 既に格子が与えられている場合は、そのまま使用（補間しない）
        const provided = opdData?.gridData;
        if (provided && typeof provided === 'object') {
            const okArray2D = (a) => Array.isArray(a) && a.length === samplingSize;
            const okTypedRow = (row) => row && (row instanceof Float32Array || row instanceof Float64Array) && row.length === samplingSize;

            if (okArray2D(provided.opd) && okArray2D(provided.amplitude) && okArray2D(provided.pupilMask)) {
                const grid = {
                    opd: Array.from({ length: samplingSize }, (_, i) => okTypedRow(provided.opd[i]) ? provided.opd[i] : Float32Array.from(provided.opd[i] || Array(samplingSize).fill(0))),
                    amplitude: Array.from({ length: samplingSize }, (_, i) => okTypedRow(provided.amplitude[i]) ? provided.amplitude[i] : Float32Array.from(provided.amplitude[i] || Array(samplingSize).fill(0))),
                    pupilMask: Array.from({ length: samplingSize }, (_, i) => Array.from(provided.pupilMask[i] || Array(samplingSize).fill(false))),
                    xCoords: (provided.xCoords instanceof Float32Array || provided.xCoords instanceof Float64Array)
                        ? provided.xCoords
                        : new Float32Array(samplingSize),
                    yCoords: (provided.yCoords instanceof Float32Array || provided.yCoords instanceof Float64Array)
                        ? provided.yCoords
                        : new Float32Array(samplingSize)
                };

                // xCoords/yCoords が未指定の場合は [-1,1] を入れておく（計測/互換用）
                if (!(provided.xCoords instanceof Float32Array || provided.xCoords instanceof Float64Array)) {
                    for (let i = 0; i < samplingSize; i++) grid.xCoords[i] = (i / (samplingSize - 1 || 1)) * 2 - 1;
                }
                if (!(provided.yCoords instanceof Float32Array || provided.yCoords instanceof Float64Array)) {
                    for (let j = 0; j < samplingSize; j++) grid.yCoords[j] = (j / (samplingSize - 1 || 1)) * 2 - 1;
                }

                // If provided grid is too sparse, prefer rayData interpolation when available.
                // Sparse masks can collapse pupil to ~1 pixel and produce artificially flat PSF.
                let activeMaskCount = 0;
                let finiteOpdCount = 0;
                for (let iy = 0; iy < samplingSize; iy++) {
                    const maskRow = grid.pupilMask[iy];
                    const opdRow = grid.opd[iy];
                    for (let ix = 0; ix < samplingSize; ix++) {
                        if (!maskRow[ix]) continue;
                        activeMaskCount++;
                        if (Number.isFinite(opdRow[ix])) finiteOpdCount++;
                    }
                }

                const total = samplingSize * samplingSize;
                const sparseByRatio = activeMaskCount < Math.max(16, Math.floor(total * 0.01));
                const sparseByCount = activeMaskCount < 4;
                const hasRayData = Array.isArray(opdData?.rayData) && opdData.rayData.length >= 10;
                if ((sparseByRatio || sparseByCount || finiteOpdCount === 0) && hasRayData) {
                    console.warn(`⚠️ [PSF] gridData too sparse (mask=${activeMaskCount}/${total}, finiteOPD=${finiteOpdCount}); falling back to rayData interpolation`);
                } else {
                    // NOTE: gridData が与えられた場合は、そのまま使用する（追加の安定化/外れ値除去は行わない）
                    if (logOutlierFilter) {
                        console.log('ℹ️ [PSF] convertOPDToGrid: gridData provided; skipping rayData outlier filter');
                    }
                    return grid;
                }
            }
        }

        // 内部配列に TypedArray を使用して数値アクセスを高速化（外側は通常配列で互換性維持）
        const grid = {
            opd: Array.from({ length: samplingSize }, () => new Float32Array(samplingSize)),
            amplitude: Array.from({ length: samplingSize }, () => new Float32Array(samplingSize)),
            pupilMask: Array.from({ length: samplingSize }, () => Array(samplingSize).fill(false)),
            // 瞳面座標（補間と収差除去に使用）
            xCoords: new Float32Array(samplingSize),
            yCoords: new Float32Array(samplingSize)
        };

        // 有効な光線データを取得
        let validRays = (opdData?.rayData || []).filter(ray => !ray?.isVignetted && Number.isFinite(ray?.opd));
        // console.log(`📊 [PSF] 有効光線数: ${validRays.length}/${opdData.rayData.length}`);

        if (validRays.length === 0) {
            console.warn('⚠️ [PSF] 有効な光線がありません');
            return grid;
        }

        if (logOutlierFilter) {
            console.log(`🔍 [PSF] convertOPDToGrid: rayData valid=${validRays.length} (pre outlier filter)`);
        }

        // 外れ値OPDの除去（Zernike fit と同様に MAD ベースで頑健化）
        // 注意: ここで除去するのは "rayData→grid補間" 経路のみ。gridData提供時は補間しない。
        try {
            const enableOutlierRemoval = (typeof globalThis !== 'undefined' && globalThis.__PSF_REMOVE_OUTLIERS !== false);
            const outlierSigmaMultiplier = (typeof globalThis !== 'undefined' && typeof globalThis.__PSF_OUTLIER_SIGMA === 'number')
                ? globalThis.__PSF_OUTLIER_SIGMA
                : ((typeof globalThis !== 'undefined' && typeof globalThis.__ZERNIKE_OUTLIER_SIGMA === 'number') ? globalThis.__ZERNIKE_OUTLIER_SIGMA : 6.0);
            const outlierMinAbs = (typeof globalThis !== 'undefined' && typeof globalThis.__PSF_OUTLIER_MIN_ABS === 'number')
                ? Math.max(0, globalThis.__PSF_OUTLIER_MIN_ABS)
                : 0.0;
            const outlierMinPoints = (typeof globalThis !== 'undefined' && Number.isFinite(globalThis.__PSF_OUTLIER_MIN_POINTS))
                ? Math.max(10, Math.floor(globalThis.__PSF_OUTLIER_MIN_POINTS))
                : 20;

            const fmt = (v) => Number.isFinite(v) ? v.toExponential(3) : String(v);

            if (logOutlierFilter && !enableOutlierRemoval) {
                console.log('ℹ️ [PSF] rayData outlier filter: disabled (__PSF_REMOVE_OUTLIERS === false)');
            }

            const median = (arr) => {
                const vals = Array.isArray(arr) ? arr.filter(Number.isFinite).slice() : [];
                if (vals.length === 0) return NaN;
                vals.sort((a, b) => a - b);
                const mid = Math.floor(vals.length / 2);
                return (vals.length % 2 === 0) ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
            };

            if (enableOutlierRemoval && validRays.length >= outlierMinPoints) {
                const vals = validRays.map(r => r.opd).filter(Number.isFinite);
                const med = median(vals);
                const absDev = vals.map(v => Math.abs(v - med));
                const mad = median(absDev);
                const robustSigma = (Number.isFinite(mad) && mad > 0) ? (1.4826 * mad) : NaN;
                const threshold = (Number.isFinite(robustSigma) && robustSigma > 0)
                    ? Math.max(outlierMinAbs, outlierSigmaMultiplier * robustSigma)
                    : NaN;

                if (logOutlierFilter) {
                    console.log(`🔍 [PSF] rayData outlier filter (MAD): n=${vals.length}, med=${fmt(med)}, mad=${fmt(mad)}, robustSigma=${fmt(robustSigma)}, threshold=${fmt(threshold)} (sigmaMult=${outlierSigmaMultiplier}, minAbs=${outlierMinAbs}, minPts=${outlierMinPoints})`);
                }

                if (Number.isFinite(threshold) && threshold > 0) {
                    const before = validRays.length;
                    const filtered = validRays.filter(r => Number.isFinite(r?.opd) && Math.abs(r.opd - med) <= threshold);

                    if (logOutlierFilter) {
                        console.log(`ℹ️ [PSF] rayData outlier filter result: removed=${before - filtered.length}, kept=${filtered.length}`);
                    }

                    // フィルタで点数が落ちすぎる場合は無効化
                    if (filtered.length >= 10 && filtered.length < before) {
                        validRays = filtered;
                        console.log(`⚡ [PSF] rayData outliers removed: ${before - filtered.length} (MAD, threshold=${threshold.toExponential(3)} OPD units)`);
                    } else if (filtered.length < 10 && logOutlierFilter) {
                        console.log('⚠️ [PSF] rayData outlier filter: disabled (too few points after filter)');
                    }
                } else if (logOutlierFilter) {
                    console.log('⚠️ [PSF] rayData outlier filter: skipped (invalid threshold)');
                }
            } else if (logOutlierFilter && enableOutlierRemoval) {
                console.log(`ℹ️ [PSF] rayData outlier filter: skipped (n=${validRays.length} < minPts=${outlierMinPoints})`);
            }
        } catch (_) {
            // ignore
        }

        // 瞳座標の範囲を取得
        const pupilCoords = validRays.map(ray => ({ x: ray.pupilX, y: ray.pupilY }));
        const bounds = this.calculateBounds(pupilCoords);

        // 空間インデックスを構築（等間隔バケツ分割）
        const index = this.buildRaySpatialIndex(validRays, bounds, samplingSize);

        // グリッド座標を前計算（X/Y それぞれ一次元配列）
        const gridXs = new Float32Array(samplingSize);
        const gridYs = new Float32Array(samplingSize);
        const dx = (bounds.maxX - bounds.minX) / (samplingSize - 1 || 1);
        const dy = (bounds.maxY - bounds.minY) / (samplingSize - 1 || 1);
        for (let i = 0, x = bounds.minX; i < samplingSize; i++, x += dx) gridXs[i] = x;
        for (let j = 0, y = bounds.minY; j < samplingSize; j++, y += dy) gridYs[j] = y;

        grid.xCoords.set(gridXs);
        grid.yCoords.set(gridYs);

        const maxRadius = Math.max(
            Math.abs(bounds.minX),
            Math.abs(bounds.maxX),
            Math.abs(bounds.minY),
            Math.abs(bounds.maxY)
        );

        // 格子点への補間（空間インデックス利用）
        for (let i = 0; i < samplingSize; i++) {
            const gx = gridXs[i];
            for (let j = 0; j < samplingSize; j++) {
                const gy = gridYs[j];

                // 円形瞳の範囲内かチェック
                const r2 = gx * gx + gy * gy;
                if (r2 <= maxRadius * maxRadius) {
                    grid.pupilMask[i][j] = true;

                    // 空間インデックスから近傍最近傍（概ね最短）を取得
                    const interpolatedOPD = this.interpolateOPDUsingIndex(gx, gy, index);
                    grid.opd[i][j] = interpolatedOPD;
                    grid.amplitude[i][j] = 1.0; // 均一振幅
                }
            }
        }

        // console.log('✅ [PSF] 格子変換完了');
        return grid;
    }

    /**
     * 光線の空間インデックス（等間隔バケツ）を構築
     * @param {Array} rays - 有効光線データ（pupilX, pupilY, opd）
     * @param {Object} bounds - {minX, maxX, minY, maxY}
     * @param {number} samplingSize - グリッドサイズ（バケツ数の目安）
     * @returns {Object} インデックス情報
     */
    buildRaySpatialIndex(rays, bounds, samplingSize) {
        // バケツ数：明示指定があれば優先。
        // 自動では「グリッド解像度」だけでなく「光線密度」も考慮し、
        // 1セルあたりの光線が極端に少なくなる（タイル状の最近傍補間になりやすい）状況を避ける。
        const bySampling = Math.floor(samplingSize / 2);
        const byRays = Math.floor(Math.sqrt(Math.max(1, rays.length) / 4)); // 目標: 1セルあたり平均4本程度
        const autoBins = Math.min(64, Math.max(8, Math.min(bySampling, byRays)));
        const bins = this.spatialBinsOverride ?? autoBins;
        const buckets = Array.from({ length: bins * bins }, () => []);

        // 連続配列でプロパティアクセスを削減
        const n = rays.length;
        const rx = new Float32Array(n);
        const ry = new Float32Array(n);
        const ropd = new Float32Array(n);

        const rangeX = (bounds.maxX - bounds.minX) || 1e-9;
        const rangeY = (bounds.maxY - bounds.minY) || 1e-9;
        const invX = 1.0 / rangeX;
        const invY = 1.0 / rangeY;

        for (let k = 0; k < n; k++) {
            const r = rays[k];
            const x = r.pupilX;
            const y = r.pupilY;
            rx[k] = x;
            ry[k] = y;
            ropd[k] = r.opd;

            let ix = Math.floor((x - bounds.minX) * invX * bins);
            let iy = Math.floor((y - bounds.minY) * invY * bins);
            if (ix < 0) ix = 0; else if (ix >= bins) ix = bins - 1;
            if (iy < 0) iy = 0; else if (iy >= bins) iy = bins - 1;
            buckets[iy * bins + ix].push(k);
        }

        return { bins, buckets, rx, ry, ropd, bounds, invX, invY };
    }

    /**
     * 空間インデックスを使った最近傍に近い OPD 補間
     * 近傍リングを拡張し、最初に光線が見つかった近傍から最近距離を選ぶ（高精度より速度優先）
     * @param {number} x - グリッドX
     * @param {number} y - グリッドY
     * @param {Object} index - buildRaySpatialIndex の返り値
     * @returns {number} 推定OPD
     */
    interpolateOPDUsingIndex(x, y, index) {
        const { bins, buckets, rx, ry, ropd, bounds, invX, invY } = index;

        let ix = Math.floor((x - bounds.minX) * invX * bins);
        let iy = Math.floor((y - bounds.minY) * invY * bins);
        if (ix < 0) ix = 0; else if (ix >= bins) ix = bins - 1;
        if (iy < 0) iy = 0; else if (iy >= bins) iy = bins - 1;

        // 周辺セルから候補を集め、逆距離重み付け（IDW）で滑らかに補間する。
        // これにより「1セル=1光線」等で生じるブロック状（タイル状）アーティファクトを抑える。
        const targetCandidates = 16;
        const maxCandidates = 64;
        const candidates = [];

        const pushCell = (cx, cy) => {
            const cell = buckets[cy * bins + cx];
            for (let t = 0; t < cell.length; t++) {
                candidates.push(cell[t]);
                if (candidates.length >= maxCandidates) return;
            }
        };

        for (let r = 0; r < bins; r++) {
            const minX = Math.max(0, ix - r);
            const maxX = Math.min(bins - 1, ix + r);
            const minY = Math.max(0, iy - r);
            const maxY = Math.min(bins - 1, iy + r);

            if (r === 0) {
                pushCell(ix, iy);
            } else {
                for (let cx = minX; cx <= maxX; cx++) {
                    pushCell(cx, minY);
                    if (candidates.length >= maxCandidates) break;
                    if (maxY !== minY) pushCell(cx, maxY);
                    if (candidates.length >= maxCandidates) break;
                }
                if (candidates.length < maxCandidates) {
                    for (let cy = minY + 1; cy <= maxY - 1; cy++) {
                        pushCell(minX, cy);
                        if (candidates.length >= maxCandidates) break;
                        if (maxX !== minX) pushCell(maxX, cy);
                        if (candidates.length >= maxCandidates) break;
                    }
                }
            }

            if (candidates.length >= targetCandidates) break;
            if (candidates.length >= maxCandidates) break;
        }

        if (candidates.length === 0) return 0;

        let wSum = 0;
        let zSum = 0;
        const eps = 1e-12;

        for (let t = 0; t < candidates.length; t++) {
            const k = candidates[t];
            const dx = rx[k] - x;
            const dy = ry[k] - y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= eps) return ropd[k];
            const w = 1.0 / (d2 + eps);
            wSum += w;
            zSum += w * ropd[k];
        }

        return wSum > 0 ? (zSum / wSum) : 0;
    }

    /**
     * 座標の境界を計算
     * @param {Array} coords - 座標配列
     * @returns {Object} 境界情報
     */
    calculateBounds(coords) {
        const xs = coords.map(c => c.x);
        const ys = coords.map(c => c.y);
        
        return {
            minX: Math.min(...xs),
            maxX: Math.max(...xs),
            minY: Math.min(...ys),
            maxY: Math.max(...ys)
        };
    }

    /**
     * OPD値を補間
     * @param {number} x - X座標
     * @param {number} y - Y座標
     * @param {Array} rays - 光線データ
     * @returns {number} 補間されたOPD値
     */
    interpolateOPD(x, y, rays) {
        // 最近傍法（簡易実装）
        let minDistance = Infinity;
        let nearestOPD = 0;
        
        for (const ray of rays) {
            const distance = Math.sqrt((ray.pupilX - x) ** 2 + (ray.pupilY - y) ** 2);
            if (distance < minDistance) {
                minDistance = distance;
                nearestOPD = ray.opd;
            }
        }
        
        return nearestOPD;
    }

    /**
     * 複素振幅を計算
     * @param {Object} gridData - 格子データ
     * @param {number} wavelength - 波長
     * @returns {Object} 複素振幅
     */
    calculateComplexAmplitude(gridData, wavelength, options = {}) {
        // console.log('🌊 [PSF] 複素振幅計算中...');

        const removeTilt = options?.removeTilt !== undefined ? !!options.removeTilt : true;
        
        const size = gridData.opd.length;
        const real = Array(size).fill().map(() => Array(size).fill(0));
        const imag = Array(size).fill().map(() => Array(size).fill(0));
        
        // 位相面のデトレンド
        // - removeTilt=true : best-fit plane（piston+tilt）を除去（従来）
        // - removeTilt=false: piston のみ除去し、tilt は保持（PSFのピークシフトを観察したい用途）
        const xCoords = gridData.xCoords;
        const yCoords = gridData.yCoords;
        let S = 0;
        let Sx = 0;
        let Sy = 0;
        let Sxx = 0;

        let Syy = 0;
        let Sxy = 0;
        let Sz = 0;
        let Sxz = 0;
        let Syz = 0;

        for (let i = 0; i < size; i++) {
            const y = (yCoords && yCoords.length === size) ? yCoords[i] : ((i - (size - 1) / 2) / ((size - 1) / 2));
            for (let j = 0; j < size; j++) {
                if (!gridData.pupilMask[i][j]) continue;
                const x = (xCoords && xCoords.length === size) ? xCoords[j] : ((j - (size - 1) / 2) / ((size - 1) / 2));
                const z = gridData.opd[i][j];
                if (!Number.isFinite(z)) continue;
                S += 1;
                Sx += x;
                Sy += y;
                Sxx += x * x;
                Syy += y * y;
                Sxy += x * y;
                Sz += z;
                Sxz += x * z;
                Syz += y * z;
            }
        }

        const meanZ = S > 0 ? (Sz / S) : 0;

        // Solve normal equations for a,b,c in z ≈ a x + b y + c
        // removeTilt=false のときは piston のみ除去（a=b=0）
        let a = 0;
        let b = 0;
        let c = meanZ;

        if (removeTilt && S >= 3) {
            // Gaussian elimination on 3x3
            let A00 = Sxx, A01 = Sxy, A02 = Sx,  B0 = Sxz;
            let A10 = Sxy, A11 = Syy, A12 = Sy,  B1 = Syz;
            let A20 = Sx,  A21 = Sy,  A22 = S,   B2 = Sz;

            const eps = 1e-12;
            const swapRows = (r1, r2) => {
                if (r1 === r2) return;
                const tmpA0 = [A00, A01, A02, B0];
                const tmpA1 = [A10, A11, A12, B1];
                const tmpA2 = [A20, A21, A22, B2];
                const rows = [tmpA0, tmpA1, tmpA2];
                const t = rows[r1];
                rows[r1] = rows[r2];
                rows[r2] = t;
                [A00, A01, A02, B0] = rows[0];
                [A10, A11, A12, B1] = rows[1];
                [A20, A21, A22, B2] = rows[2];
            };

            // Pivot 0
            const p0 = Math.abs(A00);
            const p1 = Math.abs(A10);
            const p2 = Math.abs(A20);
            if (p1 > p0 && p1 >= p2) swapRows(0, 1);
            else if (p2 > p0 && p2 >= p1) swapRows(0, 2);
            if (Math.abs(A00) > eps) {
                const f10 = A10 / A00;
                A10 -= f10 * A00; A11 -= f10 * A01; A12 -= f10 * A02; B1 -= f10 * B0;
                const f20 = A20 / A00;
                A20 -= f20 * A00; A21 -= f20 * A01; A22 -= f20 * A02; B2 -= f20 * B0;
            }

            // Pivot 1
            if (Math.abs(A11) < Math.abs(A21)) swapRows(1, 2);
            if (Math.abs(A11) > eps) {
                const f21 = A21 / A11;
                A20 -= f21 * A10; A21 -= f21 * A11; A22 -= f21 * A12; B2 -= f21 * B1;
            }

            // Back substitution
            if (Math.abs(A22) > eps) {
                c = B2 / A22;
            }
            if (Math.abs(A11) > eps) {
                b = (B1 - A12 * c) / A11;
            }
            if (Math.abs(A00) > eps) {
                a = (B0 - A01 * b - A02 * c) / A00;
            }
        }
        
        for (let i = 0; i < size; i++) {
            const y = (yCoords && yCoords.length === size) ? yCoords[i] : ((i - (size - 1) / 2) / ((size - 1) / 2));
            for (let j = 0; j < size; j++) {
                if (gridData.pupilMask[i][j]) {
                    const x = (xCoords && xCoords.length === size) ? xCoords[j] : ((j - (size - 1) / 2) / ((size - 1) / 2));
                    const opdDetrended = gridData.opd[i][j] - (a * x + b * y + c);

                    // OPDは光路差（遅延）なので、位相は負の符号
                    const phase = -2 * Math.PI * opdDetrended / wavelength;
                    const amplitude = gridData.amplitude[i][j];
                    
                    real[i][j] = amplitude * Math.cos(phase);
                    imag[i][j] = amplitude * Math.sin(phase);
                }
            }
        }
        
        // console.log('✅ [PSF] 複素振幅計算完了');
        return { real, imag };
    }

    /**
     * フーリエ変換を実行してPSFを計算
     * @param {Object} complexAmplitude - 複素振幅
     * @returns {Array} PSF強度分布
     */
    performFFT(complexAmplitude, options = {}) {
        // console.log('🔄 [PSF] FFT実行中...');

        // NOTE: SimpleFFT.fft2D は入力配列を in-place で破壊的に更新する。
        // Strehl計算等で同じ complexAmplitude に対して複数回FFTを回すと
        // 2回目以降が「FFT(FFT(pupil))」になってPSFが破綻するため、ここで必ずコピーしてからFFTする。
        const realIn = Array.from({ length: complexAmplitude.real.length }, (_, i) => Array.from(complexAmplitude.real[i]));
        const imagIn = Array.from({ length: complexAmplitude.imag.length }, (_, i) => Array.from(complexAmplitude.imag[i]));

        const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;

        // FFTを実行
        const fftResult = SimpleFFT.fft2D(realIn, imagIn, { onProgress });
        
        // 強度を計算（|複素数|^2）
        const size = fftResult.real.length;
        const intensity = Array(size).fill().map(() => Array(size).fill(0));
        
        let maxIntensity = 0;
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                intensity[i][j] = fftResult.real[i][j] ** 2 + fftResult.imag[i][j] ** 2;
                if (intensity[i][j] > maxIntensity) {
                    maxIntensity = intensity[i][j];
                }
            }
        }
        
        const normalizeToPeak = options.normalizeToPeak !== false;

        // 正規化（ピーク値を1にする）- Zemaxの標準処理
        if (normalizeToPeak && maxIntensity > 0) {
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    intensity[i][j] /= maxIntensity;
                }
            }
        }
        // console.log(`📊 [PSF] 最大強度: ${maxIntensity.toExponential(3)}`);
        
        // 中心にシフト（FFTshift）
        const shifted = this.fftShift(intensity);
        
        // console.log('✅ [PSF] FFT完了');
        if (options.returnMaxIntensity) {
            return { psf: shifted, maxIntensity };
        }
        return shifted;
    }

    async performFFTAsync(complexAmplitude, options = {}) {
        const realIn = Array.from({ length: complexAmplitude.real.length }, (_, i) => Array.from(complexAmplitude.real[i]));
        const imagIn = Array.from({ length: complexAmplitude.imag.length }, (_, i) => Array.from(complexAmplitude.imag[i]));
        const forceWasmFFT = isForceWasmFftEnabled(options);

        const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;

        // Try WASM FFT first, fall back to JS if unavailable
        let fftResult;
        try {
            const { fft2D_WASM } = await import('../../rust-wasm/ts/raytracing/fft-wasm-wrapper.ts');
            // Keep JS fallback in this function to avoid duplicate warnings from wrapper.
            fftResult = await fft2D_WASM(realIn, imagIn, { fallbackToJS: false });
        } catch (error) {
            if (forceWasmFFT) {
                const msg = (error && (error as any).message) ? (error as any).message : String(error);
                throw new Error(`Forced WASM FFT mode enabled; fallback is disabled (${msg})`);
            }
            const now = Date.now();
            if ((now - __lastFftWasmFallbackWarnAt) > __fftWasmFallbackWarnIntervalMs) {
                const msg = (error && (error as any).message) ? (error as any).message : String(error);
                console.warn('⚠️ [PSF] WASM FFT unavailable, using JavaScript fallback:', msg);
                __lastFftWasmFallbackWarnAt = now;
            }
            const yieldEvery = (options && Number.isFinite(options.yieldEvery)) ? options.yieldEvery : undefined;
            fftResult = await SimpleFFT.fft2DAsync(realIn, imagIn, { onProgress, yieldEvery });
        }

        const size = fftResult.real.length;
        const intensity = Array(size).fill().map(() => Array(size).fill(0));

        let maxIntensity = 0;
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                intensity[i][j] = fftResult.real[i][j] ** 2 + fftResult.imag[i][j] ** 2;
                if (intensity[i][j] > maxIntensity) {
                    maxIntensity = intensity[i][j];
                }
            }
        }

        const normalizeToPeak = options.normalizeToPeak !== false;
        if (normalizeToPeak && maxIntensity > 0) {
            for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                    intensity[i][j] /= maxIntensity;
                }
            }
        }

        const shifted = this.fftShift(intensity);
        if (options.returnMaxIntensity) {
            return { psf: shifted, maxIntensity };
        }
        return shifted;
    }

    /**
     * Zero-pad complex amplitude to increase PSF resolution
     * @param {Object} complexAmplitude - {real: 2D array, imag: 2D array}
     * @param {number} srcSize - Original size
     * @param {number} dstSize - Target size (must be >= srcSize)
     * @returns {Object} Zero-padded complex amplitude
     */
    zeroPadComplexAmplitude(complexAmplitude, srcSize, dstSize) {
        if (dstSize < srcSize) {
            throw new Error(`Target size ${dstSize} must be >= source size ${srcSize}`);
        }
        if (dstSize === srcSize) {
            return complexAmplitude;
        }
        
        const offset = Math.floor((dstSize - srcSize) / 2);
        
        // Create zero-filled arrays
        const paddedReal = Array(dstSize).fill().map(() => Array(dstSize).fill(0));
        const paddedImag = Array(dstSize).fill().map(() => Array(dstSize).fill(0));
        
        // Copy original data to center
        for (let i = 0; i < srcSize; i++) {
            for (let j = 0; j < srcSize; j++) {
                paddedReal[i + offset][j + offset] = complexAmplitude.real[i][j];
                paddedImag[i + offset][j + offset] = complexAmplitude.imag[i][j];
            }
        }
        
        return { real: paddedReal, imag: paddedImag };
    }

    /**
     * FFTshift（中心に配置）
     * @param {Array} data - 2D配列
     * @returns {Array} シフトされた2D配列
     */
    fftShift(data) {
        const size = data.length;
        const shifted = Array(size).fill().map(() => Array(size).fill(0));
        const half = Math.floor(size / 2);
        
        console.log(`🔄 [FFTShift] size=${size}, half=${half}`);
        
        // 正しいFFTシフト実装
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                const srcI = (i < half) ? (i + half) : (i - half);
                const srcJ = (j < half) ? (j + half) : (j - half);
                shifted[i][j] = data[srcI][srcJ];
            }
        }
        
        return shifted;
    }

    /**
     * PSF評価指標を計算
     * @param {Array} psfData - PSF強度分布
     * @param {Object} params - パラメータ
     * @returns {Object} 評価指標
     */
    calculatePSFMetrics(psfData, params) {
        // console.log('📊 [PSF] 評価指標計算中...');
        
        const size = psfData.length;
        const peak = this.findPeakLocation(psfData);
        const center = peak ? peak.i : Math.floor(size / 2);
        const centerJ = peak ? peak.j : Math.floor(size / 2);
        
        // 総エネルギー
        const totalEnergy = this.calculateTotalEnergy(psfData);
        
        // ピーク強度
        const peakIntensity = this.findPeakIntensity(psfData);
        
        // Strehl比
        const strehlRatio = (params && typeof params.strehlRatioOverride === 'number')
            ? params.strehlRatioOverride
            : this.calculateStrehlRatio(psfData, params);
        
        // FWHM
        const fwhm = this.calculateFWHM(psfData, params.pixelSize, { centerI: center, centerJ });
        
        // エンサークルドエネルギー
        const encircledEnergy = this.calculateEncircledEnergy(psfData, params.pixelSize);
        
        // console.log('✅ [PSF] 評価指標計算完了');
        
        return {
            totalEnergy,
            peakIntensity,
            strehlRatio,
            fwhm,
            encircledEnergy,
            centerPosition: { x: centerJ, y: center }
        };
    }

    /**
     * 総エネルギーを計算
     * @param {Array} psfData - PSF強度分布
     * @returns {number} 総エネルギー
     */
    calculateTotalEnergy(psfData) {
        let total = 0;
        for (let i = 0; i < psfData.length; i++) {
            for (let j = 0; j < psfData[i].length; j++) {
                total += psfData[i][j];
            }
        }
        return total;
    }

    /**
     * ピーク強度を取得
     * @param {Array} psfData - PSF強度分布
     * @returns {number} ピーク強度
     */
    findPeakIntensity(psfData) {
        let peak = 0;
        for (let i = 0; i < psfData.length; i++) {
            for (let j = 0; j < psfData[i].length; j++) {
                peak = Math.max(peak, psfData[i][j]);
            }
        }
        return peak;
    }

    /**
     * Strehl比を計算
     * @param {Array} psfData - PSF強度分布
     * @param {Object} params - パラメータ
     * @returns {number} Strehl比
     */
    calculateStrehlRatio(psfData, params) {
        const peakIntensity = this.findPeakIntensity(psfData);
        
        // 理想的なPSF（エアリーディスク）のピーク強度を計算
        const diffraction_limited_peak = 1.0; // 正規化された理想値
        
        return peakIntensity / diffraction_limited_peak;
    }

    /**
     * FWHM（半値全幅）を計算
     * @param {Array} psfData - PSF強度分布
     * @param {number} pixelSize - ピクセルサイズ
     * @returns {Object} X, Y方向のFWHM
     */
    calculateFWHM(psfData, pixelSize, centerOverride = null) {
        const size = psfData.length;
        const centerI = centerOverride && Number.isFinite(centerOverride.centerI) ? centerOverride.centerI : Math.floor(size / 2);
        const centerJ = centerOverride && Number.isFinite(centerOverride.centerJ) ? centerOverride.centerJ : Math.floor(size / 2);
        const peakIntensity = this.findPeakIntensity(psfData);
        const halfMax = peakIntensity / 2;
        
        // X方向のFWHM
        const xProfile = psfData[centerI];
        const fwhmX = this.findFWHMFromProfile(xProfile, centerJ, halfMax) * pixelSize;
        
        // Y方向のFWHM
        const yProfile = psfData.map(row => row[centerJ]);
        const fwhmY = this.findFWHMFromProfile(yProfile, centerI, halfMax) * pixelSize;
        
        return {
            x: fwhmX,
            y: fwhmY,
            average: (fwhmX + fwhmY) / 2
        };
    }

    /**
     * プロファイルからFWHMを計算
     * @param {Array} profile - 強度プロファイル
     * @param {number} center - 中心位置
     * @param {number} halfMax - 半値
     * @returns {number} FWHM（ピクセル単位）
     */
    findFWHMFromProfile(profile, center, halfMax) {
        let leftEdge = center;
        let rightEdge = center;
        
        // 左端を探索
        for (let i = center; i >= 0; i--) {
            if (profile[i] < halfMax) {
                leftEdge = i;
                break;
            }
        }
        
        // 右端を探索
        for (let i = center; i < profile.length; i++) {
            if (profile[i] < halfMax) {
                rightEdge = i;
                break;
            }
        }
        
        return rightEdge - leftEdge;
    }

    /**
     * エンサークルドエネルギーを計算
     * @param {Array} psfData - PSF強度分布
     * @param {number} pixelSize - ピクセルサイズ
     * @returns {Array} 半径とエネルギーの配列
     */
    calculateEncircledEnergy(psfData, pixelSize) {
        const size = psfData.length;
        const center = Math.floor(size / 2);
        const maxRadius = Math.floor(size / 2);

        // 半径ごとのバケットに強度を集計（O(N^2)）
        const bins = new Float64Array(maxRadius + 1);
        let totalEnergy = 0;

        for (let i = 0; i < size; i++) {
            const di = i - center;
            for (let j = 0; j < size; j++) {
                const dj = j - center;
                const rIdx = Math.floor(Math.sqrt(di * di + dj * dj));
                if (rIdx <= maxRadius) {
                    const val = psfData[i][j];
                    bins[rIdx] += val;
                    totalEnergy += val;
                }
            }
        }

        // 累積和でエンサークルドエネルギーを作成
        const encircledEnergy = new Array(maxRadius);
        let cumulative = 0;
        for (let r = 1; r <= maxRadius; r++) {
            cumulative += bins[r];
            encircledEnergy[r - 1] = {
                radius: r * pixelSize,
                energy: totalEnergy > 0 ? (cumulative / totalEnergy * 100) : 0
            };
        }

        return encircledEnergy;
    }

    /**
     * ピクセルサイズを計算
     * @param {number} wavelength - 波長
     * @param {number} focalLength - 焦点距離
     * @param {number} samplingSize - サンプリングサイズ
     * @returns {number} ピクセルサイズ（μm）
     */
    calculatePixelSize(wavelength, focalLength, pupilDiameter, pupilGridSize, fftSize = null) {
        const wl = Number(wavelength);
        const fl = Number(focalLength);
        const pd = Number(pupilDiameter);

        // Physical scaling for FFT PSF grid (focal plane sampling pitch).
        // Δx (μm/px) ≈ λ(μm) * f(mm) / D(mm)
        // Keep this independent of samplingSize so increasing N increases the plotted range.
        const safePd = (Number.isFinite(pd) && pd > 0) ? pd : 10.0;
        const safeFl = (Number.isFinite(fl) && Math.abs(fl) > 0) ? Math.abs(fl) : 100.0;
        const safeWl = (Number.isFinite(wl) && wl > 0) ? wl : 0.5876;

        // Δx (μm/px) ≈ λ(μm) * f(mm) / D(mm)
        // If FFT is larger than the pupil grid (zero-padding), Δx shrinks by (Npupil / Nfft).
        const basePitch = (safeWl * safeFl) / safePd;

        const nPupil = Number(pupilGridSize);
        const nFft = (fftSize === null || fftSize === undefined) ? nPupil : Number(fftSize);
        if (Number.isFinite(nPupil) && Number.isFinite(nFft) && nPupil > 0 && nFft > 0) {
            return basePitch * (nPupil / nFft);
        }
        return basePitch;
    }

    /**
     * パフォーマンスモード設定
     * @param {string} mode 'auto', 'wasm', 'javascript'
     */
    setPerformanceMode(mode) {
        if (['auto', 'wasm', 'javascript'].includes(mode)) {
            this.performanceMode = mode;
            // console.log(`🔄 [PSF] Performance mode set to: ${mode}`);
        } else {
            console.warn(`⚠️ [PSF] Invalid performance mode: ${mode}`);
        }
    }

    /**
     * パフォーマンス統計取得
     * @returns {Object} 統計情報
     */
    getPerformanceStats() {
        if (this.wasmCalculator && typeof this.wasmCalculator.getPerformanceStats === 'function') {
            return this.wasmCalculator.getPerformanceStats();
        }
        return { message: 'Performance stats not available' };
    }

    /**
     * WASM利用状況チェック
     * @returns {Object} WASM状況
     */
    getWasmStatus() {
        return {
            available: !!this.wasmCalculator,
            ready: this.wasmCalculator ? this.wasmCalculator.isReady : false,
            currentMode: this.performanceMode,
            recommendedForSize: (size) => size >= 64
        };
    }

    /**
     * 最後の計算結果を取得
     * @returns {Object} 計算結果
     */
    getLastCalculation() {
        return this.lastCalculationData;
    }
}

// グローバル公開
if (typeof window !== 'undefined') {
    window['PSFCalculator'] = PSFCalculator;
    // console.log('✅ [PSF] PSF計算モジュール読み込み完了（WASM対応）');
}

export default PSFCalculator;
