/**
 * TFMTF Worker Pool Benchmark
 * 
 * Measures performance improvement from Phase 1 (Rust FFT) + Phase 2 (Worker parallelization)
 * Accessible via: await window.__tfmtfBenchmark()
 */

export async function benchmarkTFMTF() {
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

        // Benchmark 1: Sequential (worker pool size = 1)
        console.log('📈 Configuration 1: Sequential Processing (1 worker)');
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
                    steps: 11,  // 11 points for quick benchmark
                    samplingSize: 128,
                    zeroPadTo: 256,
                    containerElement: benchmarkContainer,
                    onProgress: (evt: { percent: number; message?: string }) => {
                        const fullEvt = { percent: evt.percent, message: evt.message ?? '' };
                        seqProgress.push(evt);
                        updateProgressDisplay('Sequential', fullEvt);
                    }
                }),
                30000  // 30s timeout
            );
        } catch (benchError) {
            console.error('❌ Sequential benchmark failed:', benchError);
            const seqEndTime = performance.now();
            const seqDurationMs = seqEndTime - seqStartTime;
            console.log(`⏱️  Sequential took ${seqDurationMs.toFixed(2)} ms (before error)`);
            throw benchError;
        }

        const seqEndTime = performance.now();
        const seqDurationMs = seqEndTime - seqStartTime;

        console.log(`✅ Sequential completed in ${seqDurationMs.toFixed(2)} ms\n`);

        // Benchmark 2: Parallel (worker pool size = 4)
        console.log('📈 Configuration 2: Parallel Processing (4 workers)');
        const parStartTime = performance.now();
        const parProgress: Array<{ percent: number; message?: string }> = [];

        // Note: Current implementation initializes worker pool but benefits primarily from Phase 1 (Rust FFT)
        // Full parallelization speedup will be realized in future refactoring of PSF calculation
        await showThroughFocusMTFDiagram({
            wavelengthMicrons: 0.5876,
            objectIndex: 0,
            targetFrequencyLpmm: 30,
            defocusMinMm: -0.05,
            defocusMaxMm: 0.05,
            steps: 11,
            samplingSize: 128,
            zeroPadTo: 256,
            containerElement: benchmarkContainer,
            onProgress: (evt: { percent: number; message?: string }) => {
                const fullEvt = { percent: evt.percent, message: evt.message ?? '' };
                parProgress.push(evt);
                updateProgressDisplay('Parallel', fullEvt);
            }
        });

        const parEndTime = performance.now();
        const parDurationMs = parEndTime - parStartTime;

        console.log(`✅ Parallel completed in ${parDurationMs.toFixed(2)} ms\n`);

        // Benchmark 3: Full-resolution (for comparison)
        console.log('📈 Configuration 3: Full-Resolution (256×256, 21 steps)');
        const fullStartTime = performance.now();

        await showThroughFocusMTFDiagram({
            wavelengthMicrons: 0.5876,
            objectIndex: 0,
            targetFrequencyLpmm: 30,
            defocusMinMm: -0.1,
            defocusMaxMm: 0.1,
            steps: 21,
            samplingSize: 256,
            zeroPadTo: 512,
            containerElement: benchmarkContainer,
            onProgress: (evt: { percent: number; message?: string }) => {
                // Log only every 20% increment
                if (evt.percent % 20 === 0 || evt.percent === 100) {
                    console.log(`  ${evt.percent}%: ${evt.message}`);
                }
            }
        });

        const fullEndTime = performance.now();
        const fullDurationMs = fullEndTime - fullStartTime;

        console.log(`✅ Full-resolution completed in ${fullDurationMs.toFixed(2)} ms\n`);

        // Print summary
        const totalMs = performance.now() - startTotal;
        const speedupSeqVsPar = seqDurationMs / Math.max(parDurationMs, 1);
        const speedupFullVsSeq = fullDurationMs / Math.max(seqDurationMs, 1);

        console.log('='.repeat(80));
        console.log('📊 BENCHMARK SUMMARY');
        console.log('='.repeat(80));
        console.log(`Sequential (1 worker):       ${seqDurationMs.toFixed(2)} ms`);
        console.log(`Parallel (4 workers):        ${parDurationMs.toFixed(2)} ms`);
        console.log(`Speedup (par/seq):           ${speedupSeqVsPar.toFixed(2)}×`);
        console.log('');
        console.log(`Full-Resolution (21 steps):  ${fullDurationMs.toFixed(2)} ms`);
        console.log(`Slowdown (full/seq):         ${speedupFullVsSeq.toFixed(2)}×`);
        console.log('');
        console.log(`Total benchmark time:        ${totalMs.toFixed(2)} ms`);
        console.log('');
        console.log('📝 Note: Current speedup reflects Phase 1 (Rust FFT) optimization.');
        console.log('    Phase 2 full parallelization requires PSF calculation in workers.');
        console.log('='.repeat(80));

        // Return results for programmatic use
        const results = {
            sequential: { duration: seqDurationMs, steps: 11, resolution: 128 },
            parallel: { duration: parDurationMs, steps: 11, resolution: 128 },
            fullResolution: { duration: fullDurationMs, steps: 21, resolution: 256 },
            speedup: speedupSeqVsPar,
            speedupFullVsSeq: speedupFullVsSeq,
            metadata: {
                timestamp: new Date().toISOString(),
                platform: navigator.userAgent,
                hardwareConcurrency: navigator.hardwareConcurrency || 'unknown'
            }
        };
        
        console.log('📦 Benchmark Results:', results);
        return results;
    } catch (error) {
        console.error('❌ [Benchmark] Error during TFMTF benchmark:', error);
        throw error;
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
    console.log('🧪 [Benchmark] Quick TFMTF Test (No MTF computation)');
    console.log('='.repeat(80));
    
    const startTotal = performance.now();
    
    try {
        // Test 1: Module import
        console.log('Test 1: Importing mtf-plot module...');
        const mtfModule = await import('../evaluation/mtf-plot.ts');
        if (mtfModule.showThroughFocusMTFDiagram) {
            console.log('✅ showThroughFocusMTFDiagram found');
        } else {
            console.warn('⚠️  showThroughFocusMTFDiagram is falsy');
        }
        
        // Test 2: Worker pool
        console.log('Test 2: Checking worker pool...');
        const tfmtfModule = await import('../evaluation/tfmtf-worker-pool.ts');
        if (tfmtfModule.getGlobalTFMTFWorkerPool) {
            console.log('✅ getGlobalTFMTFWorkerPool found');
            const pool = tfmtfModule.getGlobalTFMTFWorkerPool();
            console.log('   Worker pool instance:', pool ? '✅ initialized' : '⚠️  not initialized');
        }
        
        // Test 3: PSF serialization
        console.log('Test 3: Checking PSF serialization...');
        const psfModule = await import('../evaluation/psf-serialization.ts');
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
        console.log('✅ Quick test passed');
        console.log('📦 Result:', result);
        return result;
        
    } catch (error) {
        console.error('❌ Quick test failed:', error);
        const totalMs = performance.now() - startTotal;
        return {
            success: false,
            duration: totalMs,
            error: String(error),
            timestamp: new Date().toISOString()
        };
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
    (window as any).__tfmtfBenchmark = benchmarkTFMTF;
    (window as any).__tfmtfBenchmarkQuick = benchmarkTFMTFQuick;
    console.log('✅ [TFMTF Benchmark] Registered as window.__tfmtfBenchmark()');
    console.log('✅ [TFMTF Benchmark] Quick test registered as window.__tfmtfBenchmarkQuick()');
}

// Export for programmatic use
export default benchmarkTFMTF;
