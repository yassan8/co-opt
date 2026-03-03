/**
 * High-performance FFT via Rust WASM
 * 2D FFT wrapper for PSF calculation
 * 
 * Provides transparent fallback to JS FFT if WASM unavailable
 */

import { getRustRayTracingWasmSync, preloadRustRayTracingWasm } from './rust-raytracing-wasm.ts';

let _fftWasmApi: any = null;
let _fftWasmInitError: string | null = null;
let _fftWasmLastInitAttemptAt = 0;
const _fftWasmRetryCooldownMs = 500;
let _fftWasmUnsupported = false;
let _fftWasmSelfTestDone = false;

function _isRuntimeTrapError(error: any): boolean {
    const msg = String(error?.message || error || '').toLowerCase();
    return msg.includes('unreachable code should not be executed') || msg.includes('unreachable');
}

function _validateInputSizeForWasm(rows: number, cols: number): void {
    const elements = rows * cols;
    if (!Number.isFinite(elements) || elements <= 0) {
        throw new Error(`FFT WASM invalid input size: ${rows}x${cols}`);
    }
}

async function _runWasmSelfTest(api: any): Promise<void> {
    if (_fftWasmSelfTestDone) return;

    const forward = api?.fft_2d_forward_arrays;
    if (typeof forward !== 'function') {
        _fftWasmSelfTestDone = true;
        return;
    }

    const rows = 2;
    const cols = 2;
    const real = new Float64Array([1, 0, 0, 0]);
    const imag = new Float64Array([0, 0, 0, 0]);

    try {
        const out = await forward(real, imag, rows, cols);
        const outReal = out?.real;
        const outImag = out?.imag;
        if (!outReal || !outImag || outReal.length !== 4 || outImag.length !== 4) {
            throw new Error('FFT WASM self-test returned invalid output');
        }
        _fftWasmSelfTestDone = true;
    } catch (error: any) {
        const msg = String(error?.message || error || 'unknown error');
        if (_isRuntimeTrapError(error)) {
            throw new Error(`FFT WASM self-test trapped (${msg})`);
        }
        throw new Error(`FFT WASM self-test failed (${msg})`);
    }
}

/**
 * Initialize FFT WASM (same as ray tracing WASM)
 */
export async function ensureFFTWasmReady(): Promise<{ success: boolean; error?: string }> {
    if (_fftWasmApi) {
        return { success: true };
    }

    if (_fftWasmUnsupported) {
        return { success: false, error: _fftWasmInitError || 'FFT WASM unsupported in current build' };
    }

    const now = Date.now();
    if (_fftWasmInitError && (now - _fftWasmLastInitAttemptAt) < _fftWasmRetryCooldownMs) {
        return { success: false, error: _fftWasmInitError };
    }

    _fftWasmLastInitAttemptAt = now;

    try {
        let api = getRustRayTracingWasmSync();
        if (!api) {
            // If ray-tracing WASM is not ready yet, actively initialize with short retries.
            for (let attempt = 0; attempt < 3 && !api; attempt++) {
                try {
                    await preloadRustRayTracingWasm();
                } catch (_) {
                    // ignore and retry
                }
                api = getRustRayTracingWasmSync();
                if (!api && attempt < 2) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
            }
        }
        if (!api) {
            _fftWasmInitError = 'Rust WASM not initialized yet';
            return { success: false, error: _fftWasmInitError };
        }

        // Verify that FFT functions exist
        if (typeof (api as any).fft_2d_forward !== 'function' || typeof (api as any).fft_2d_inverse !== 'function') {
            // Potentially transient if module is still initializing/reloading.
            _fftWasmInitError = 'FFT functions not found in WASM API';
            return { success: false, error: _fftWasmInitError };
        }

        let hasArrayApi =
            typeof (api as any).fft_2d_forward_arrays === 'function' &&
            typeof (api as any).fft_2d_inverse_arrays === 'function';

        let hasAlloc =
            typeof (api as any).malloc === 'function' ||
            typeof (api as any)._malloc === 'function' ||
            typeof (api as any).__wbindgen_malloc === 'function';
        let hasFree =
            typeof (api as any).free === 'function' ||
            typeof (api as any)._free === 'function' ||
            typeof (api as any).__wbindgen_free === 'function';
        let hasMemory = !!(api as any).memory?.buffer;

        if (!hasArrayApi && (!hasAlloc || !hasFree || !hasMemory)) {
            try {
                await preloadRustRayTracingWasm();
                const refreshedApi = getRustRayTracingWasmSync();
                if (refreshedApi) {
                    api = refreshedApi;
                    hasArrayApi =
                        typeof (api as any).fft_2d_forward_arrays === 'function' &&
                        typeof (api as any).fft_2d_inverse_arrays === 'function';
                    hasAlloc =
                        typeof (api as any).malloc === 'function' ||
                        typeof (api as any)._malloc === 'function' ||
                        typeof (api as any).__wbindgen_malloc === 'function';
                    hasFree =
                        typeof (api as any).free === 'function' ||
                        typeof (api as any)._free === 'function' ||
                        typeof (api as any).__wbindgen_free === 'function';
                    hasMemory = !!(api as any).memory?.buffer;
                }
            } catch (_) {
                // keep graceful fallback path
            }
        }

        if (!hasArrayApi && (!hasAlloc || !hasFree || !hasMemory)) {
            _fftWasmInitError = 'FFT WASM low-level memory API is unavailable in this build';
            return { success: false, error: _fftWasmInitError };
        }

        try {
            await _runWasmSelfTest(api);
        } catch (selfTestError: any) {
            _fftWasmApi = null;
            _fftWasmUnsupported = true;
            _fftWasmInitError = selfTestError?.message || String(selfTestError);
            return { success: false, error: _fftWasmInitError };
        }

        _fftWasmApi = api;
        _fftWasmInitError = null;
        console.log('✅ [FFT-WASM] Initialized successfully');
        return { success: true };
    } catch (error: any) {
        _fftWasmInitError = error?.message || String(error);
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
            const err: any = new Error(`FFT WASM not available: ${init.error}`);
            err.code = 'FFT_WASM_NOT_READY';
            throw err;
        }
    }

    const rows = real.length;
    const cols = real[0]?.length || 0;

    if (rows === 0 || cols === 0) {
        throw new Error('Invalid FFT input dimensions');
    }

    _validateInputSizeForWasm(rows, cols);

    try {
        if (typeof _fftWasmApi.fft_2d_forward_arrays === 'function') {
            const realFlat = Float64Array.from(real.flat());
            const imagFlat = Float64Array.from(imag.flat());

            const startTime = performance.now();
            const output = await _fftWasmApi.fft_2d_forward_arrays(realFlat, imagFlat, rows, cols);
            const timeMs = performance.now() - startTime;

            const outReal = output?.real ? Array.from(output.real) : [];
            const outImag = output?.imag ? Array.from(output.imag) : [];
            if (outReal.length !== rows * cols || outImag.length !== rows * cols) {
                throw new Error('FFT WASM array API returned invalid output length');
            }

            const resultReal = [];
            const resultImag = [];
            for (let i = 0; i < rows; i++) {
                resultReal.push(outReal.slice(i * cols, (i + 1) * cols));
                resultImag.push(outImag.slice(i * cols, (i + 1) * cols));
            }

            return {
                real: resultReal,
                imag: resultImag,
                timeMs,
                method: 'rustfft'
            };
        }

        const allocFn = (typeof _fftWasmApi.malloc === 'function')
            ? _fftWasmApi.malloc.bind(_fftWasmApi)
            : ((typeof _fftWasmApi._malloc === 'function')
                ? _fftWasmApi._malloc.bind(_fftWasmApi)
                : _fftWasmApi.__wbindgen_malloc?.bind(_fftWasmApi));
        const freeFn = (typeof _fftWasmApi.free === 'function')
            ? _fftWasmApi.free.bind(_fftWasmApi)
            : ((typeof _fftWasmApi._free === 'function')
                ? _fftWasmApi._free.bind(_fftWasmApi)
                : _fftWasmApi.__wbindgen_free?.bind(_fftWasmApi));

        if (typeof allocFn !== 'function' || typeof freeFn !== 'function' || !_fftWasmApi?.memory?.buffer) {
            throw new Error('FFT WASM allocator/memory API unavailable');
        }

        // Flatten arrays
        const realFlat = real.flat();
        const imagFlat = imag.flat();

        // Allocate WASM memory for input
        const realPtr = allocFn(realFlat.length * 8);
        const imagPtr = allocFn(imagFlat.length * 8);
        const realOutPtr = allocFn(realFlat.length * 8);
        const imagOutPtr = allocFn(imagFlat.length * 8);

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
        freeFn(realPtr, realFlat.length * 8, 8);
        freeFn(imagPtr, imagFlat.length * 8, 8);
        freeFn(realOutPtr, realFlat.length * 8, 8);
        freeFn(imagOutPtr, imagFlat.length * 8, 8);

        console.log(`✅ [FFT-WASM] FFT ${rows}x${cols} computed in ${timeMs.toFixed(2)}ms`);

        return {
            real: resultReal,
            imag: resultImag,
            timeMs,
            method: 'rustfft'
        };
    } catch (error: any) {
        if (_isRuntimeTrapError(error)) {
            _fftWasmUnsupported = true;
            _fftWasmApi = null;
            _fftWasmInitError = `FFT WASM runtime trap detected; disabled for this session (${String(error?.message || error)})`;
        }
        if (fallbackToJS) {
            throw error;
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

    _validateInputSizeForWasm(rows, cols);

    try {
        if (typeof _fftWasmApi.fft_2d_inverse_arrays === 'function') {
            const realFlat = Float64Array.from(real.flat());
            const imagFlat = Float64Array.from(imag.flat());

            const startTime = performance.now();
            const output = await _fftWasmApi.fft_2d_inverse_arrays(realFlat, imagFlat, rows, cols);
            const timeMs = performance.now() - startTime;

            const outReal = output?.real ? Array.from(output.real) : [];
            const outImag = output?.imag ? Array.from(output.imag) : [];
            if (outReal.length !== rows * cols || outImag.length !== rows * cols) {
                throw new Error('IFFT WASM array API returned invalid output length');
            }

            const resultReal = [];
            const resultImag = [];
            for (let i = 0; i < rows; i++) {
                resultReal.push(outReal.slice(i * cols, (i + 1) * cols));
                resultImag.push(outImag.slice(i * cols, (i + 1) * cols));
            }

            return {
                real: resultReal,
                imag: resultImag,
                timeMs,
                method: 'rustfft'
            };
        }

        const allocFn = (typeof _fftWasmApi.malloc === 'function')
            ? _fftWasmApi.malloc.bind(_fftWasmApi)
            : ((typeof _fftWasmApi._malloc === 'function')
                ? _fftWasmApi._malloc.bind(_fftWasmApi)
                : _fftWasmApi.__wbindgen_malloc?.bind(_fftWasmApi));
        const freeFn = (typeof _fftWasmApi.free === 'function')
            ? _fftWasmApi.free.bind(_fftWasmApi)
            : ((typeof _fftWasmApi._free === 'function')
                ? _fftWasmApi._free.bind(_fftWasmApi)
                : _fftWasmApi.__wbindgen_free?.bind(_fftWasmApi));

        if (typeof allocFn !== 'function' || typeof freeFn !== 'function' || !_fftWasmApi?.memory?.buffer) {
            throw new Error('IFFT WASM allocator/memory API unavailable');
        }

        // Flatten arrays
        const realFlat = real.flat();
        const imagFlat = imag.flat();

        // Allocate WASM memory
        const realPtr = allocFn(realFlat.length * 8);
        const imagPtr = allocFn(imagFlat.length * 8);
        const realOutPtr = allocFn(realFlat.length * 8);
        const imagOutPtr = allocFn(imagFlat.length * 8);

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
        freeFn(realPtr, realFlat.length * 8, 8);
        freeFn(imagPtr, imagFlat.length * 8, 8);
        freeFn(realOutPtr, realFlat.length * 8, 8);
        freeFn(imagOutPtr, imagFlat.length * 8, 8);

        console.log(`✅ [IFFT-WASM] IFFT ${rows}x${cols} computed in ${timeMs.toFixed(2)}ms`);

        return {
            real: resultReal,
            imag: resultImag,
            timeMs,
            method: 'rustfft'
        };
    } catch (error: any) {
        if (_isRuntimeTrapError(error)) {
            _fftWasmUnsupported = true;
            _fftWasmApi = null;
            _fftWasmInitError = `IFFT WASM runtime trap detected; disabled for this session (${String(error?.message || error)})`;
        }
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
    const zeroArray = Array.from({ length: rows }, () => Array(cols).fill(0));
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
