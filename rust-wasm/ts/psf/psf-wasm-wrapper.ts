import { ensureFFTWasmReady } from '../raytracing/fft-wasm-wrapper.ts';

export class PSFCalculatorWasm {
    isReady: boolean;
    initializationFailed: boolean;
    _initPromise: Promise<void> | null;
    performanceStats: {
        wasmCalls: number;
        jsFallbacks: number;
        totalWasmTime: number;
        totalJSTime: number;
    };

    constructor() {
        this.isReady = false;
        this.initializationFailed = false;
        this._initPromise = null;
        this.performanceStats = {
            wasmCalls: 0,
            jsFallbacks: 0,
            totalWasmTime: 0,
            totalJSTime: 0
        };
    }

    async initializeWasm() {
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
            const init = await ensureFFTWasmReady();
            this.isReady = !!init?.success;
            this.initializationFailed = !this.isReady;
        })();
        return this._initPromise;
    }

    async calculatePSFWasm(opdData: any, options: any = {}) {
        const start = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();

        const { PSFCalculator } = await import('../../../evaluation/psf/psf-calculator.ts');
        const calculator = new PSFCalculator();
        const result = await calculator.calculatePSFJavaScript(opdData, {
            ...options,
            forceWasmFFT: options?.forceWasmFFT !== false
        });

        const end = (typeof performance !== 'undefined' && typeof performance.now === 'function')
            ? performance.now()
            : Date.now();

        this.performanceStats.wasmCalls += 1;
        this.performanceStats.totalWasmTime += (end - start);

        return {
            ...result,
            metadata: {
                ...(result?.metadata || {}),
                method: 'rust-wasm-fft'
            }
        };
    }

    getPerformanceStats() {
        const avgWasmTime = this.performanceStats.wasmCalls > 0
            ? this.performanceStats.totalWasmTime / this.performanceStats.wasmCalls
            : 0;
        const avgJSTime = this.performanceStats.jsFallbacks > 0
            ? this.performanceStats.totalJSTime / this.performanceStats.jsFallbacks
            : 0;

        return {
            ...this.performanceStats,
            averageWasmTime: avgWasmTime,
            averageJSTime: avgJSTime,
            speedup: avgJSTime > 0 && avgWasmTime > 0 ? avgJSTime / avgWasmTime : 1
        };
    }
}

export class PSFCalculatorAuto {
    wasmCalculator: PSFCalculatorWasm;

    constructor() {
        this.wasmCalculator = new PSFCalculatorWasm();
    }

    async calculatePSF(opdData: any, options: any = {}) {
        await this.wasmCalculator.initializeWasm();
        return this.wasmCalculator.calculatePSFWasm(opdData, options);
    }

    getPerformanceStats() {
        return this.wasmCalculator.getPerformanceStats();
    }

    getWasmStatus() {
        return {
            available: true,
            ready: !!this.wasmCalculator.isReady,
            initialized: true,
            preferWasm: true,
            hasJSFallback: true
        };
    }

    setImplementation(_implementation: string) {
    }
}
