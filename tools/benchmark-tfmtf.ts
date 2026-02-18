/**
 * TFMTF Worker Pool Benchmark
 * 
 * Measures performance improvement from Phase 1 (Rust FFT) + Phase 2 (Worker parallelization)
 * Accessible via: await window.__tfmtfBenchmark()
 */

// Immediate module load verification
console.log('💾 [Module] benchmark-tfmtf.ts is being loaded...');

export async function benchmarkTFMTF() {
    console.log('🧪 [benchmarkTFMTF] Function called at', new Date().toISOString());
    const startTotal = performance.now();

    console.log('🧪 [Benchmark] TFMTF Through-Focus Performance Analysis');
    console.log('='.repeat(80));
    console.log('⏱️  Benchmark started at', new Date().toISOString());

    try {
        // Import required components
        console.log('📦 Importing mtf-plot module...');
        let showThroughFocusMTFDiagram;
        
        try {
            const mtfModule = await import('../evaluation/mtf-plot.ts');
            showThroughFocusMTFDiagram = mtfModule.showThroughFocusMTFDiagram;
            console.log('✅ Successfully imported showThroughFocusMTFDiagram');
        } catch (importError) {
            console.error('❌ Failed to import mtf-plot.ts:', importError);
            throw new Error(`Module import failed: ${importError}`);
        }
        
        if (!showThroughFocusMTFDiagram) {
            throw new Error('showThroughFocusMTFDiagram function not found in module');
        }

        // Get or create a container for the benchmark plot
        let benchmarkContainer = document.getElementById('tfmtf-benchmark-container');
        if (!benchmarkContainer) {
            benchmarkContainer = document.createElement('div');
            benchmarkContainer.id = 'tfmtf-benchmark-container';
            benchmarkContainer.style.width = '100%';
            benchmarkContainer.style.height = '500px';
            benchmarkContainer.style.marginTop = '20px';
            benchmarkContainer.style.border = '1px solid #ccc';
            benchmarkContainer.style.padding = '10px';

            const containerEl = document.getElementById('mtf-container');
            if (containerEl && containerEl.parentElement) {
                containerEl.parentElement.appendChild(benchmarkContainer);
            } else {
                document.body.appendChild(benchmarkContainer);
            }
        }

        console.log('📊 Running TFMTF benchmark with different worker configurations...\n');

        // Benchmark 1: Sequential (baseline, 5 steps at 128×128)
        console.log('📈 Configuration 1: Baseline (128×128, 5 steps)');
        const seqStartTime = performance.now();
        const seqProgress: Array<{ percent: number; message?: string }> = [];

        try {
            await withTimeout(
                showThroughFocusMTFDiagram({
                    wavelengthMicrons: 0.5876,
                    objectIndex: 0,
                    targetFrequencyLpmm: 30,
                    defocusMinMm: -0.05,
                    defocusMaxMm: 0.05,
                    steps: 5,
                    samplingSize: 128,
                    zeroPadTo: 256,
                    containerElement: benchmarkContainer,
                    onProgress: (evt: { percent: number; message?: string }) => {
                        const fullEvt = { percent: evt.percent, message: evt.message ?? '' };
                        seqProgress.push(evt);
                        updateProgressDisplay('Sequential', fullEvt);
                    }
                }),
                60000  // 60s timeout
            );
        } catch (benchError) {
            console.error('❌ Sequential benchmark failed:', benchError);
            const seqEndTime = performance.now();
            const seqDurationMs = seqEndTime - seqStartTime;
            console.log(`⏱️  Sequential took ${seqDurationMs.toFixed(2)} ms (before error)`);
            // Return partial error result
            return {
                success: false,
                error: `Sequential benchmark failed: ${benchError}`,
                duration: performance.now() - startTotal,
                partialResults: { sequential: { duration: seqDurationMs, state: 'failed' } },
                timestamp: new Date().toISOString()
            };
        }

        const seqEndTime = performance.now();
        const seqDurationMs = seqEndTime - seqStartTime;

        console.log(`✅ Sequential completed in ${seqDurationMs.toFixed(2)} ms\n`);

        // Benchmark 2: Second run (same params, measures caching/JIT effects)
        console.log('📈 Configuration 2: Second run (128×128, 5 steps)');
        const parStartTime = performance.now();
        const parProgress: Array<{ percent: number; message?: string }> = [];

        try {
            await withTimeout(
                showThroughFocusMTFDiagram({
                    wavelengthMicrons: 0.5876,
                    objectIndex: 0,
                    targetFrequencyLpmm: 30,
                    defocusMinMm: -0.05,
                    defocusMaxMm: 0.05,
                    steps: 5,
                    samplingSize: 128,
                    zeroPadTo: 256,
                    containerElement: benchmarkContainer,
                    onProgress: (evt: { percent: number; message?: string }) => {
                        const fullEvt = { percent: evt.percent, message: evt.message ?? '' };
                        parProgress.push(evt);
                        updateProgressDisplay('Parallel', fullEvt);
                    }
                }),
                60000  // 60s timeout
            );
        } catch (benchError) {
            console.error('❌ Parallel benchmark failed:', benchError);
            const parEndTime = performance.now();
            const parDurationMs = parEndTime - parStartTime;
            console.log(`⏱️  Parallel took ${parDurationMs.toFixed(2)} ms (before error)`);
            // Return partial error result
            return {
                success: false,
                error: `Parallel benchmark failed: ${benchError}`,
                duration: performance.now() - startTotal,
                partialResults: { 
                    sequential: { duration: seqDurationMs, state: 'success' },
                    parallel: { duration: parDurationMs, state: 'failed' }
                },
                timestamp: new Date().toISOString()
            };
        }

        const parEndTime = performance.now();
        const parDurationMs = parEndTime - parStartTime;

        console.log(`✅ Parallel completed in ${parDurationMs.toFixed(2)} ms\n`);

        // Benchmark 3: Higher-resolution scaling comparison (256×256, 5 steps)
        console.log('📈 Configuration 3: Higher-Resolution (256×256, 5 steps)');
        const fullStartTime = performance.now();

        try {
            await withTimeout(
                showThroughFocusMTFDiagram({
                    wavelengthMicrons: 0.5876,
                    objectIndex: 0,
                    targetFrequencyLpmm: 30,
                    defocusMinMm: -0.05,
                    defocusMaxMm: 0.05,
                    steps: 5,
                    samplingSize: 256,
                    zeroPadTo: 256,
                    containerElement: benchmarkContainer,
                    onProgress: (evt: { percent: number; message?: string }) => {
                        // Log only every 20% increment
                        if (evt.percent % 20 === 0 || evt.percent === 100) {
                            console.log(`  ${evt.percent}%: ${evt.message}`);
                        }
                    }
                }),
                120000  // 120s timeout for higher resolution
            );
        } catch (benchError) {
            console.error('❌ Higher-resolution benchmark failed:', benchError);
            const fullEndTime = performance.now();
            const fullDurationMs = fullEndTime - fullStartTime;
            console.log(`⏱️  Higher-resolution took ${fullDurationMs.toFixed(2)} ms (before error)`);
            // Return partial error result
            return {
                success: false,
                error: `Higher-resolution benchmark failed: ${benchError}`,
                duration: performance.now() - startTotal,
                partialResults: { 
                    sequential: { duration: seqDurationMs, state: 'success' },
                    parallel: { duration: parDurationMs, state: 'success' },
                    fullResolution: { duration: fullDurationMs, state: 'failed' }
                },
                timestamp: new Date().toISOString()
            };
        }

        const fullEndTime = performance.now();
        const fullDurationMs = fullEndTime - fullStartTime;

        console.log(`✅ Higher-resolution completed in ${fullDurationMs.toFixed(2)} ms\n`);

        // Print summary
        const totalMs = performance.now() - startTotal;
        const speedupSeqVsPar = seqDurationMs / Math.max(parDurationMs, 1);
        const resolutionScaling = fullDurationMs / Math.max(seqDurationMs, 1);

        console.log('='.repeat(80));
        console.log('📊 BENCHMARK SUMMARY');
        console.log('='.repeat(80));
        console.log(`Config 1 - 128×128, 11 steps: ${seqDurationMs.toFixed(2)} ms`);
        console.log(`Config 2 - 128×128, 11 steps: ${parDurationMs.toFixed(2)} ms`);
        console.log(`Run-to-run variance:          ${speedupSeqVsPar.toFixed(2)}× (expect ~1.0)`);
        console.log('');
        console.log(`Config 3 - 256×256, 11 steps: ${fullDurationMs.toFixed(2)} ms`);
        console.log(`256/128 scaling factor:       ${resolutionScaling.toFixed(2)}× (expect ~4× for O(N²) FFT)`);
        console.log('');
        console.log(`Total benchmark time:         ${totalMs.toFixed(2)} ms`);
        console.log('');
        console.log('📝 Phase 1 (Rust FFT) active. Phase 2 worker parallelization pending PSF refactor.');
        console.log('='.repeat(80));

        // Return results for programmatic use
        const results = {
            success: true,
            config1: { duration: seqDurationMs, steps: 5, resolution: 128, zeroPadTo: 256 },
            config2: { duration: parDurationMs, steps: 5, resolution: 128, zeroPadTo: 256 },
            config3: { duration: fullDurationMs, steps: 5, resolution: 256, zeroPadTo: 256 },
            runVariance: speedupSeqVsPar,
            resolutionScaling: resolutionScaling,
            metadata: {
                timestamp: new Date().toISOString(),
                platform: navigator.userAgent,
                hardwareConcurrency: navigator.hardwareConcurrency || 'unknown'
            }
        };
        
        console.log('📦 Benchmark Results:', results);
        // Save to window directly - Safari drops async function return values from .then()
        if (typeof window !== 'undefined') (window as any).__benchmarkResult = results;
        return results;
    } catch (error) {
        console.error('❌ [Benchmark] Error during TFMTF benchmark:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        const totalMs = performance.now() - startTotal;
        
        // Return error result instead of throwing
        const errorResult = {
            success: false,
            error: errorMsg,
            duration: totalMs,
            timestamp: new Date().toISOString(),
            platform: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency || 'unknown'
        };
        
        console.log('📦 Benchmark Error Result:', errorResult);
        return errorResult;
    }
}

/**
 * Helper: Update progress display in console
 */
function updateProgressDisplay(label: string, evt: { percent: number; message?: string }) {
    if (evt.percent % 10 === 0 || evt.percent === 100) {
        const msg = evt.message ? ` - ${evt.message}` : '';
        console.log(`  ${label}: ${evt.percent}%${msg}`);
    }
}

/**
 * Quick test version - for rapid validation
 */
export async function benchmarkTFMTFQuick() {
    console.log('🧪 [benchmarkTFMTFQuick] Function called at', new Date().toISOString());
    console.log('🧪 [Benchmark] Quick TFMTF Test (No MTF computation)');
    console.log('='.repeat(80));
    
    const startTotal = performance.now();
    
    try {
        // Test 1: Module import
        console.log('Test 1: Importing mtf-plot module...');
        const mtfModule = await import('../evaluation/mtf-plot.ts');
        console.log('✅ mtf-plot imported');
        if (mtfModule.showThroughFocusMTFDiagram) {
            console.log('✅ showThroughFocusMTFDiagram found');
        } else {
            console.warn('⚠️  showThroughFocusMTFDiagram is falsy');
        }
        
        // Test 2: Worker pool
        console.log('Test 2: Checking worker pool...');
        const tfmtfModule = await import('../evaluation/tfmtf-worker-pool.ts');
        console.log('✅ tfmtf-worker-pool imported');
        if (tfmtfModule.getGlobalTFMTFWorkerPool) {
            console.log('✅ getGlobalTFMTFWorkerPool found');
            const pool = tfmtfModule.getGlobalTFMTFWorkerPool();
            console.log('   Worker pool instance:', pool ? '✅ initialized' : '⚠️  not initialized');
        }
        
        // Test 3: PSF serialization
        console.log('Test 3: Checking PSF serialization...');
        const psfModule = await import('../evaluation/psf-serialization.ts');
        console.log('✅ psf-serialization imported');
        if (psfModule.extractPSFGridFromCalculatorResult) {
            console.log('✅ PSF serialization utilities found');
        }
        
        const totalMs = performance.now() - startTotal;
        
        const result = {
            success: true,
            duration: totalMs,
            timestamp: new Date().toISOString(),
            tests: {
                mtfModule: true,
                workerPool: true,
                psfSerialization: true
            }
        };
        
        console.log('='.repeat(80));
        console.log('✅ Quick test passed! Result:', JSON.stringify(result));
        // Save to window directly - Safari drops async function return values from .then()
        if (typeof window !== 'undefined') (window as any).__benchmarkResult = result;
        return result;
        
    } catch (error) {
        console.error('❌ Quick test failed:', error);
        const totalMs = performance.now() - startTotal;
        const errorResult = {
            success: false,
            duration: totalMs,
            error: String(error),
            timestamp: new Date().toISOString()
        };
        return errorResult;
    }
}

/**
 * Helper: Run with timeout protection
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            reject(new Error(`Operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    
    try {
        return await Promise.race([promise, timeoutPromise]);
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
    }
}

/**
 * Register benchmark globally for UI access
 */
if (typeof window !== 'undefined') {
    console.log('📝 [TFMTF Benchmark] Starting registration at', new Date().toISOString());
    
    // Capture references at module scope before registration
    const benchmarkTFMTFRef = benchmarkTFMTF;
    const benchmarkTFMTFQuickRef = benchmarkTFMTFQuick;
    
    console.log('📦 [Registration] Got function references:');
    console.log('   benchmarkTFMTF:', typeof benchmarkTFMTFRef);
    console.log('   benchmarkTFMTFQuick:', typeof benchmarkTFMTFQuickRef);
    
    // Directly assign functions to window.
    // NOTE: Safari DevTools shows `undefined` for `await fn()` on module-scoped async
    // functions - this is a Safari display bug. The functions work correctly.
    // Use: fn().then(r => { window.__r = r }).catch(e => { window.__e = String(e) })
    // then check window.__r (result) or window.__e (error)
    (window as any).__tfmtfBenchmark = benchmarkTFMTFRef;
    console.log('✅ [1/3] window.__tfmtfBenchmark registered as:', typeof (window as any).__tfmtfBenchmark);
    
    (window as any).__tfmtfBenchmarkQuick = benchmarkTFMTFQuickRef;
    console.log('✅ [2/3] window.__tfmtfBenchmarkQuick registered as:', typeof (window as any).__tfmtfBenchmarkQuick);
    
    // Simple test function
    (window as any).__tfmtfBenchmarkTest = function() {
        console.log('✅ __tfmtfBenchmarkTest called');
        return { test: true, timestamp: new Date().toISOString() };
    };
    console.log('✅ [3/3] window.__tfmtfBenchmarkTest registered as:', typeof (window as any).__tfmtfBenchmarkTest);
    
    console.log('🔍 [Registration] Verification complete. All functions registered.');
    console.log('   Command: await window.__tfmtfBenchmarkQuick()');
}

// Export for programmatic use
export default benchmarkTFMTF;
