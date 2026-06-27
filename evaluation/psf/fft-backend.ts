export type FFTMatrix = number[][];

type FFTProgressEvent = {
    percent?: number | null;
    phase?: string | null;
    message?: string | null;
};

type FFTBackendRunOptions = {
    onProgress?: (data: FFTProgressEvent) => void;
    yieldEvery?: number;
    forceWasmFFT?: boolean;
    preferWebGPUFFT?: boolean;
};

export type FFTBackendKind = 'webgpu' | 'wasm' | 'javascript';

export type FFTBackendPlan = {
    requested: FFTBackendKind;
    executable: Exclude<FFTBackendKind, 'webgpu'>;
    reason?: string;
};

export type FFTBackendResult = {
    real: FFTMatrix;
    imag: FFTMatrix;
    backend: Exclude<FFTBackendKind, 'webgpu'>;
    requestedBackend: FFTBackendKind;
    fallbackReason?: string;
};

type WebGPUAvailability = {
    available: boolean;
    reason?: string;
};

let cachedWebGPUAvailability: Promise<WebGPUAvailability> | null = null;

function isForceWebGPUFFTEnabled(options: FFTBackendRunOptions): boolean {
    try {
        if (options && options.preferWebGPUFFT === true) return true;
        return !!(globalThis as any).__COOPT_PREFER_WEBGPU_FFT;
    } catch (_) {
        return false;
    }
}

export async function probeWebGPUFFTAvailability(): Promise<WebGPUAvailability> {
    if (!cachedWebGPUAvailability) {
        cachedWebGPUAvailability = (async () => {
            try {
                const gpu = (globalThis as any)?.navigator?.gpu;
                if (!gpu || typeof gpu.requestAdapter !== 'function') {
                    return { available: false, reason: 'navigator.gpu is unavailable' };
                }

                const adapter = await gpu.requestAdapter();
                if (!adapter) {
                    return { available: false, reason: 'GPU adapter request returned null' };
                }

                return {
                    available: false,
                    reason: 'WebGPU adapter is present, but FFT compute kernel is not implemented yet'
                };
            } catch (error) {
                return {
                    available: false,
                    reason: error instanceof Error ? error.message : String(error)
                };
            }
        })();
    }

    return cachedWebGPUAvailability;
}

export async function resolveFFTBackendPlan(options: FFTBackendRunOptions = {}): Promise<FFTBackendPlan> {
    if (isForceWebGPUFFTEnabled(options)) {
        const webgpu = await probeWebGPUFFTAvailability();
        return {
            requested: 'webgpu',
            executable: options.forceWasmFFT === true ? 'wasm' : 'javascript',
            reason: webgpu.reason || 'WebGPU FFT backend unavailable'
        };
    }

    if (options.forceWasmFFT === true) {
        return { requested: 'wasm', executable: 'wasm' };
    }

    return { requested: 'wasm', executable: 'wasm' };
}

export async function runFFT2DWithBackend(
    realIn: FFTMatrix,
    imagIn: FFTMatrix,
    options: FFTBackendRunOptions = {}
): Promise<FFTBackendResult> {
    const plan = await resolveFFTBackendPlan(options);

    if (plan.executable === 'wasm') {
        try {
            const { fft2D_WASM } = await import('../../rust-wasm/ts/raytracing/fft-wasm-wrapper.ts');
            const fftResult = await fft2D_WASM(realIn, imagIn, { fallbackToJS: false });
            return {
                real: fftResult.real,
                imag: fftResult.imag,
                backend: 'wasm',
                requestedBackend: plan.requested,
                fallbackReason: plan.requested === 'webgpu' ? plan.reason : undefined
            };
        } catch (error) {
            if (options.forceWasmFFT === true) {
                const msg = error instanceof Error ? error.message : String(error);
                throw new Error(`Forced WASM FFT mode enabled; fallback is disabled (${msg})`);
            }
        }
    }

    const { SimpleFFT } = await import('./psf-calculator.ts');
    const fftResult = await SimpleFFT.fft2DAsync(realIn, imagIn, {
        onProgress: options.onProgress,
        yieldEvery: options.yieldEvery
    });

    return {
        real: fftResult.real,
        imag: fftResult.imag,
        backend: 'javascript',
        requestedBackend: plan.requested,
        fallbackReason: plan.reason
    };
}