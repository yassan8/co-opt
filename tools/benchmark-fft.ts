/**
 * Benchmark: Rust FFT vs JavaScript FFT
 * Performance comparison for PSF calculation
 */

export async function benchmarkFFT() {
    // Import both FFT implementations
    const { fft2D_WASM, ensureFFTWasmReady } = await import('../../wasm/raytracing/fft-wasm-wrapper.ts');
    const { SimpleFFT } = await import('../evaluation/psf/psf-calculator.ts');

    // Test sizes
    const sizes = [64, 128, 256, 512];

    console.log('🧪 [Benchmark] FFT Performance Comparison (Rust WASM vs JavaScript)');
    console.log('='.repeat(80));

    for (const size of sizes) {
        // Create test data
        const real: number[][] = Array.from({ length: size }, () =>
            Array.from({ length: size }, () => Math.random() * 2 - 1)
        );
        const imag: number[][] = Array.from({ length: size }, () =>
            Array.from({ length: size }, () => Math.random() * 2 - 1)
        );

        console.log(`\n📊 Testing ${size}x${size} FFT:`);

        // Benchmark Rust WASM FFT
        let wasmTime = Infinity;
        try {
            const init = await ensureFFTWasmReady();
            if (init.success) {
                const start = performance.now();
                const result = await fft2D_WASM(real, imag, { fallbackToJS: false });
                wasmTime = performance.now() - start;
                console.log(`  ✅ Rust WASM:   ${wasmTime.toFixed(2)}ms (method: ${result.method})`);
            } else {
                console.log(`  ⚠️  Rust WASM:   Unavailable (${init.error})`);
            }
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.log(`  ❌ Rust WASM:   Error - ${errorMsg}`);
        }

        // Benchmark JavaScript FFT
        let jsTime = Infinity;
        try {
            const start = performance.now();
            const result = await SimpleFFT.fft2DAsync(real, imag, { yieldEvery: 0 });
            jsTime = performance.now() - start;
            console.log(`  📦 JavaScript:  ${jsTime.toFixed(2)}ms`);
        } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.log(`  ❌ JavaScript:  Error - ${errorMsg}`);
        }

        // Speedup calculation
        if (wasmTime < Infinity && jsTime < Infinity) {
            const speedup = (jsTime / wasmTime).toFixed(2);
            const faster = wasmTime < jsTime ? '⚡ WASM is faster' : '🐢 JS is faster';
            console.log(`  ${faster}: ${speedup}x speedup (${(jsTime - wasmTime).toFixed(2)}ms saved)`);
        }
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ Benchmark complete');
}

/**
 * Run benchmark when script loads
 */
if (typeof window !== 'undefined' && typeof globalThis !== 'undefined') {
    (window as any).__psfBenchmark = benchmarkFFT;
    console.log('💡 Run performance benchmark: await window.__psfBenchmark()');
}
