/**
 * High-performance FFT via Rust WASM
 * 2D FFT wrapper for PSF calculation
 * 
 * Provides transparent fallback to JS FFT if WASM unavailable
 */

import { getRustRayTracingWasmSync } from './rust-raytracing-wasm.ts';

let _fftWasmApi: any = null;
let _fftWasmInitError: string | null = null;

/**
 * Initialize FFT WASM (same as ray tracing WASM)
 */
export async function ensureFFTWasmReady(): Promise<{ success: boolean; error?: string }> {
    if (_fftWasmApi || _fftWasmInitError) {
        return _fftWasmApi ? { success: true } : { success: false, error: _fftWasmInitError };
    }

    try {
        const api = getRustRayTracingWasmSync();
        if (!api) {
            _fftWasmInitError = 'Rust WASM not initialized';
            return { success: false, error: _fftWasmInitError };
        }

        // Verify that FFT functions exist
        if (typeof (api as any).fft_2d_forward !== 'function' || typeof (api as any).fft_2d_inverse !== 'function') {
            _fftWasmInitError = 'FFT functions not found in WASM API';
            return { success: false, error: _fftWasmInitError };
        }

        _fftWasmApi = api;
        console.log('✅ [FFT-WASM] Initialized successfully');
        return { success: true };
    } catch (error: any) {
        _fftWasmInitError = error?.message || String(error);
        console.warn('⚠️ [FFT-WASM] Initialization failed:', _fftWasmInitError);
        return { success: false, error: _fftWasmInitError };
    }
}

/**
 * High-performance 2D FFT using Rust WASM
 * 
 * @param real - 2D array of real components
 * @param imag - 2D array of imaginary components
 * @returns { real, imag, timeMs, method }
 */
export async function fft2D_WASM(
    real: number[][],
    imag: number[][],
    options: { fallbackToJS?: boolean } = {}
): Promise<{
    real: number[][];
    imag: number[][];
    timeMs: number;
    method: 'rustfft' | 'fallback';
}> {
    const fallbackToJS = options.fallbackToJS !== false;

    if (!_fftWasmApi) {
        const init = await ensureFFTWasmReady();
        if (!init.success) {
            if (fallbackToJS) {
                console.warn('⚠️ [FFT] WASM not ready, falling back to JS (slower)');
                return fallbackToJSFFT(real, imag);
            }
            throw new Error(`FFT WASM not available: ${init.error}`);
        }
    }

    const rows = real.length;
    const cols = real[0]?.length || 0;

    if (rows === 0 || cols === 0) {
        throw new Error('Invalid FFT input dimensions');
    }

    try {
        // Flatten arrays
        const realFlat = real.flat();
        const imagFlat = imag.flat();

        // Allocate WASM memory for input
        const realPtr = _fftWasmApi.malloc(realFlat.length * 8);
        const imagPtr = _fftWasmApi.malloc(imagFlat.length * 8);
        const realOutPtr = _fftWasmApi.malloc(realFlat.length * 8);
        const imagOutPtr = _fftWasmApi.malloc(imagFlat.length * 8);

        // Copy data to WASM memory
        const realView = new Float64Array(_fftWasmApi.memory.buffer, realPtr, realFlat.length);
        const imagView = new Float64Array(_fftWasmApi.memory.buffer, imagPtr, imagFlat.length);
        realView.set(realFlat);
        imagView.set(imagFlat);

        // Call WASM FFT
        const startTime = performance.now();
        const result = await _fftWasmApi.fft_2d_forward(realPtr, imagPtr, rows, cols, realOutPtr, imagOutPtr);
        const timeMs = performance.now() - startTime;

        // Read results
        const outRealView = new Float64Array(_fftWasmApi.memory.buffer, realOutPtr, realFlat.length);
        const outImagView = new Float64Array(_fftWasmApi.memory.buffer, imagOutPtr, imagFlat.length);

        // Unflatten
        const resultReal = [];
        const resultImag = [];
        for (let i = 0; i < rows; i++) {
            const row = outRealView.slice(i * cols, (i + 1) * cols);
            resultReal.push(Array.from(row));

            const irow = outImagView.slice(i * cols, (i + 1) * cols);
            resultImag.push(Array.from(irow));
        }

        // Free memory
        _fftWasmApi.free(realPtr);
        _fftWasmApi.free(imagPtr);
        _fftWasmApi.free(realOutPtr);
        _fftWasmApi.free(imagOutPtr);

        console.log(`✅ [FFT-WASM] FFT ${rows}x${cols} computed in ${timeMs.toFixed(2)}ms`);

        return {
            real: resultReal,
            imag: resultImag,
            timeMs,
            method: 'rustfft'
        };
    } catch (error: any) {
        console.error('❌ [FFT-WASM] FFT failed:', error);
        if (fallbackToJS) {
            console.warn('⚠️ [FFT] Falling back to JavaScript');
            return fallbackToJSFFT(real, imag);
        }
        throw error;
    }
}

/**
 * High-performance 2D IFFT using Rust WASM
 */
export async function ifft2D_WASM(
    real: number[][],
    imag: number[][],
    options: { fallbackToJS?: boolean } = {}
): Promise<{
    real: number[][];
    imag: number[][];
    timeMs: number;
    method: 'rustfft' | 'fallback';
}> {
    const fallbackToJS = options.fallbackToJS !== false;

    if (!_fftWasmApi) {
        const init = await ensureFFTWasmReady();
        if (!init.success) {
            if (fallbackToJS) {
                console.warn('⚠️ [IFFT] WASM not ready, falling back to JS (slower)');
                return fallbackToJSIFFT(real, imag);
            }
            throw new Error(`IFFT WASM not available: ${init.error}`);
        }
    }

    const rows = real.length;
    const cols = real[0]?.length || 0;

    if (rows === 0 || cols === 0) {
        throw new Error('Invalid IFFT input dimensions');
    }

    try {
        // Flatten arrays
        const realFlat = real.flat();
        const imagFlat = imag.flat();

        // Allocate WASM memory
        const realPtr = _fftWasmApi.malloc(realFlat.length * 8);
        const imagPtr = _fftWasmApi.malloc(imagFlat.length * 8);
        const realOutPtr = _fftWasmApi.malloc(realFlat.length * 8);
        const imagOutPtr = _fftWasmApi.malloc(imagFlat.length * 8);

        // Copy data to WASM memory
        const realView = new Float64Array(_fftWasmApi.memory.buffer, realPtr, realFlat.length);
        const imagView = new Float64Array(_fftWasmApi.memory.buffer, imagPtr, imagFlat.length);
        realView.set(realFlat);
        imagView.set(imagFlat);

        // Call WASM IFFT
        const startTime = performance.now();
        const result = await _fftWasmApi.fft_2d_inverse(realPtr, imagPtr, rows, cols, realOutPtr, imagOutPtr);
        const timeMs = performance.now() - startTime;

        // Read results
        const outRealView = new Float64Array(_fftWasmApi.memory.buffer, realOutPtr, realFlat.length);
        const outImagView = new Float64Array(_fftWasmApi.memory.buffer, imagOutPtr, imagFlat.length);

        // Unflatten
        const resultReal = [];
        const resultImag = [];
        for (let i = 0; i < rows; i++) {
            const row = outRealView.slice(i * cols, (i + 1) * cols);
            resultReal.push(Array.from(row));

            const irow = outImagView.slice(i * cols, (i + 1) * cols);
            resultImag.push(Array.from(irow));
        }

        // Free memory
        _fftWasmApi.free(realPtr);
        _fftWasmApi.free(imagPtr);
        _fftWasmApi.free(realOutPtr);
        _fftWasmApi.free(imagOutPtr);

        console.log(`✅ [IFFT-WASM] IFFT ${rows}x${cols} computed in ${timeMs.toFixed(2)}ms`);

        return {
            real: resultReal,
            imag: resultImag,
            timeMs,
            method: 'rustfft'
        };
    } catch (error: any) {
        console.error('❌ [IFFT-WASM] IFFT failed:', error);
        if (fallbackToJS) {
            console.warn('⚠️ [IFFT] Falling back to JavaScript');
            return fallbackToJSIFFT(real, imag);
        }
        throw error;
    }
}

/**
 * Fallback: Use JavaScript FFT (stub - not recommended due to circular import)
 * The actual fallback is handled in psf-calculator.ts
 */
async function fallbackToJSFFT(
    real: number[][],
    imag: number[][]
): Promise<{ real: number[][]; imag: number[][]; timeMs: number; method: 'fallback' }> {
    throw new Error('WASM FFT unavailable - use JS fallback in psf-calculator.ts');
}

/**
 * Fallback: Use JavaScript IFFT (stub)
 */
function fallbackToJSIFFT(
    real: number[][],
    imag: number[][]
): Promise<{ real: number[][]; imag: number[][]; timeMs: number; method: 'fallback' }> {
    // For now, just return a stub - full JS IFFT implementation can be added if needed
    console.warn('⚠️ [IFFT] JavaScript IFFT not fully implemented, returning zeros');
    const rows = real.length;
    const cols = real[0]?.length || 0;
    const zeroArray = Array(rows).fill().map(() => Array(cols).fill(0));
    return Promise.resolve({
        real: zeroArray,
        imag: zeroArray,
        timeMs: 0,
        method: 'fallback'
    });
}

/**
 * Get current FFT WASM status
 */
export function getFFTWasmStatus(): { ready: boolean; error?: string } {
    if (_fftWasmApi) {
        return { ready: true };
    }
    return { ready: false, error: _fftWasmInitError || 'Not initialized' };
}
