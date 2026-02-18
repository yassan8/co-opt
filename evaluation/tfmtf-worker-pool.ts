/**
 * Through-Focus MTF (TFMTF) Worker Pool
 * 
 * Parallelizes TFMTF extraction across multiple Web Workers
 * Each worker receives pre-computed PSF and extracts MTF at target frequency
 * Typical speedup: 4-6x with 4-6 workers
 */

export interface TFMTFWorkerTaskData {
    taskId: string;
    defocusShiftMm: number;
    psfGrid: Float64Array;  // Pre-computed PSF grid (not OPD)
    psfRows: number;
    psfCols: number;
    wavelengthMicrons: number;
    targetFrequencyLpmm: number;
    pupilDiameterMm?: number;
}

export interface TFMTFWorkerResult {
    taskId: string;
    defocusShiftMm: number;
    mtfValue: number;
    mtfTangential?: number;
    mtfSagittal?: number;
    timeMs: number;
    error?: string;
}

/**
 * Worker pool for parallel MTF extraction from pre-computed PSF
 */
export class TFMTFWorkerPool {
    private workers: Worker[] = [];
    private workerBusy: Map<number, boolean> = new Map();  // Track busy state per worker
    private taskMap: Map<string, { resolve: (r: TFMTFWorkerResult) => void; reject: (e: Error) => void; workerId?: number }> = new Map();
    private taskQueue: Array<TFMTFWorkerTaskData> = [];
    private workerTaskMap: Map<number, string> = new Map();  // Track which worker has which task
    
    constructor(private workerCount: number = 4) {
        if (workerCount < 1) this.workerCount = 1;
        if (workerCount > 16) this.workerCount = 16;
    }

    /**
     * Initialize worker pool with MTF extraction code
     */
    async initialize(): Promise<void> {
        // Inline worker code for MTF extraction from PSF
        const workerCode = `
// Simple 1D FFT for MTF extraction
function fft1D(real, imag) {
    const n = real.length;
    if (n <= 1) return { real: real.slice(), imag: imag.slice() };
    
    // Bit reversal
    let j = 0;
    for (let i = 0; i < n - 1; i++) {
        if (i < j) {
            [real[i], real[j]] = [real[j], real[i]];
            [imag[i], imag[j]] = [imag[j], imag[i]];
        }
        let m = n >> 1;
        while (m > 0 && j >= m) {
            j -= m;
            m >>= 1;
        }
        j += m;
    }
    
    // Cooley-Tukey FFT
    for (let len = 2; len <= n; len <<= 1) {
        const angle = -2 * Math.PI / len;
        for (let i = 0; i < n; i += len) {
            for (let k = 0; k < len / 2; k++) {
                const w = Math.cos(angle * k);
                const v = Math.sin(angle * k);
                const t0 = i + k;
                const t1 = i + k + len / 2;
                const c0 = real[t1] * w - imag[t1] * v;
                const c1 = real[t1] * v + imag[t1] * w;
                real[t1] = real[t0] - c0;
                imag[t1] = imag[t0] - c1;
                real[t0] += c0;
                imag[t0] += c1;
            }
        }
    }
    
    return { real, imag };
}

// Extract 1D MTF from 2D PSF
function extractMTFFrom2DPSF(psfGrid, rows, cols, targetFreqLpmm, wavelengthMicrons, pupilDiameterMm) {
    // Extract 1D slices (center rows/cols)
    const centerRow = Math.floor(rows / 2);
    const centerCol = Math.floor(cols / 2);
    
    // Tangential slice (along x-axis, center row)
    const tangentialReal = [];
    const tangentialImag = [];
    for (let col = 0; col < cols; col++) {
        tangentialReal.push(psfGrid[centerRow * cols + col]);
        tangentialImag.push(0);
    }
    
    // Sagittal slice (along y-axis, center col)
    const sagittalReal = [];
    const sagittalImag = [];
    for (let row = 0; row < rows; row++) {
        sagittalReal.push(psfGrid[row * cols + centerCol]);
        sagittalImag.push(0);
    }
    
    // Compute FFT for both
    const tangFFT = fft1D(tangentialReal, tangentialImag);
    const sagFFT = fft1D(sagittalReal, sagittalImag);
    
    // Compute magnitude (OTF) and normalize
    const tangMTF = tangFFT.real.map((r, i) => {
        const mag = Math.sqrt(r * r + tangFFT.imag[i] * tangFFT.imag[i]);
        return mag / (tangFFT.real[0] || 1);
    });
    
    const sagMTF = sagFFT.real.map((r, i) => {
        const mag = Math.sqrt(r * r + sagFFT.imag[i] * sagFFT.imag[i]);
        return mag / (sagFFT.real[0] || 1);
    });
    
    // Compute spatial frequency array (assuming sampling = pupilDiameterMm)
    const pixelSize = pupilDiameterMm / cols;
    const freqLpmm = [];
    for (let i = 0; i < cols; i++) {
        const freq = (i / (cols * pixelSize)) * 1000;  // Convert to lp/mm
        freqLpmm.push(freq);
    }
    
    // Find closest frequency to target
    let bestIdxTang = 0, bestIdxSag = 0;
    let minDiffTang = Infinity, minDiffSag = Infinity;
    
    for (let i = 0; i < freqLpmm.length; i++) {
        const diff = Math.abs(freqLpmm[i] - targetFreqLpmm);
        if (diff < minDiffTang) {
            minDiffTang = diff;
            bestIdxTang = i;
        }
        if (diff < minDiffSag) {
            minDiffSag = diff;
            bestIdxSag = i;
        }
    }
    
    return {
        mtfValue: (tangMTF[bestIdxTang] + sagMTF[bestIdxSag]) / 2,
        mtfTangential: tangMTF[bestIdxTang],
        mtfSagittal: sagMTF[bestIdxSag]
    };
}

self.onmessage = async (event) => {
    const {
        taskId,
        defocusShiftMm,
        psfGrid,
        psfRows,
        psfCols,
        wavelengthMicrons,
        targetFrequencyLpmm,
        pupilDiameterMm
    } = event.data;
    
    try {
        const startTime = performance.now();
        
        // Extract MTF from pre-computed PSF grid
        const result = extractMTFFrom2DPSF(
            psfGrid,
            psfRows,
            psfCols,
            targetFrequencyLpmm,
            wavelengthMicrons,
            pupilDiameterMm || 10
        );
        
        const timeMs = performance.now() - startTime;
        
        self.postMessage({
            taskId,
            defocusShiftMm,
            mtfValue: result.mtfValue,
            mtfTangential: result.mtfTangential,
            mtfSagittal: result.mtfSagittal,
            timeMs
        });
    } catch (error) {
        const timeMs = performance.now() - performance.now();
        self.postMessage({
            taskId,
            defocusShiftMm,
            mtfValue: 0,
            mtfTangential: 0,
            mtfSagittal: 0,
            timeMs,
            error: String(error instanceof Error ? error.message : error)
        });
    }
};
`;

        // Create worker blob
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const workerURL = URL.createObjectURL(blob);

        // Initialize workers
        for (let i = 0; i < this.workerCount; i++) {
            const worker = new Worker(workerURL);
            this.workers.push(worker);
            this.workerBusy.set(i, false);
            
            // Bind message handler with worker index
            worker.onmessage = (event) => this._handleWorkerResult(event.data, i);
            worker.onerror = (error) => {
                console.error(`⚠️ [TFMTF] Worker ${i} error:`, error);
                this.workerBusy.set(i, false);
                this._processQueue();
            };
        }

        console.log(`✅ [TFMTF] Worker pool initialized with ${this.workerCount} workers`);
    }

    /**
     * Queue a TFMTF extraction task
     */
    async queueTask(task: TFMTFWorkerTaskData): Promise<TFMTFWorkerResult> {
        return new Promise((resolve, reject) => {
            this.taskMap.set(task.taskId, { resolve, reject });
            this.taskQueue.push(task);
            this._processQueue();
        });
    }

    /**
     * Process tasks from queue using available workers
     */
    private _processQueue(): void {
        while (this.taskQueue.length > 0) {
            // Find available worker
            let workerIdx = -1;
            for (let i = 0; i < this.workerCount; i++) {
                if (!this.workerBusy.get(i)) {
                    workerIdx = i;
                    break;
                }
            }

            if (workerIdx === -1) break;  // No available workers

            const task = this.taskQueue.shift();
            if (!task) break;

            this.workerBusy.set(workerIdx, true);
            this.workerTaskMap.set(workerIdx, task.taskId);

            // Send task to worker (transfer PSF array for zero-copy)
            try {
                this.workers[workerIdx].postMessage(task, [task.psfGrid.buffer]);
            } catch (err) {
                // If transfer fails, send as copy
                this.workers[workerIdx].postMessage(task);
            }
        }
    }

    /**
     * Handle worker result
     */
    private _handleWorkerResult(result: TFMTFWorkerResult, workerIdx: number): void {
        const handler = this.taskMap.get(result.taskId);
        
        if (handler) {
            if (result.error) {
                console.warn(`⚠️ [TFMTF] Task ${result.taskId} error:`, result.error);
                handler.reject(new Error(result.error));
            } else {
                handler.resolve(result);
            }
            this.taskMap.delete(result.taskId);
        }

        // Free this worker and process next task
        this.workerBusy.set(workerIdx, false);
        this.workerTaskMap.delete(workerIdx);
        this._processQueue();
    }

    /**
     * Calculate TFMTF data in parallel
     */
    async calculateTFMTF(
        psfGrid: Float64Array,
        psfRows: number,
        psfCols: number,
        options: {
            defocusRange?: [number, number];
            defocusSteps?: number;
            targetFrequencyLpmm?: number;
            wavelengthMicrons?: number;
            pupilDiameterMm?: number;
            onProgress?: (evt: { percent: number; message?: string }) => void;
        } = {}
    ): Promise<Array<{ defocusMm: number; mtfValue: number; mtfTangential?: number; mtfSagittal?: number }>> {
        const {
            defocusRange = [-0.1, 0.1],
            defocusSteps = 21,
            targetFrequencyLpmm = 30,
            wavelengthMicrons = 0.555,
            pupilDiameterMm = 10,
            onProgress
        } = options;

        const [minDefocus, maxDefocus] = defocusRange;
        const defocusValues = Array.from(
            { length: defocusSteps },
            (_, i) => minDefocus + (maxDefocus - minDefocus) * (defocusSteps > 1 ? i / (defocusSteps - 1) : 0)
        );

        const resultMap: Map<string, TFMTFWorkerResult> = new Map();
        const taskPromises: Array<{ taskId: string; promise: Promise<TFMTFWorkerResult>; index: number }> = [];

        console.log(`🔄 [TFMTF] Queueing ${defocusSteps} MTF extractions across ${this.workerCount} workers`);

        // Queue all tasks
        for (let i = 0; i < defocusValues.length; i++) {
            const defocus = defocusValues[i];
            const taskId = `tfmtf_${i}`;

            const promise = this.queueTask({
                taskId,
                defocusShiftMm: defocus,
                psfGrid: psfGrid.slice(),  // Copy for safety
                psfRows,
                psfCols,
                wavelengthMicrons,
                targetFrequencyLpmm,
                pupilDiameterMm
            });

            taskPromises.push({ taskId, promise, index: i });
        }

        // Wait for all with progress tracking
        for (const { taskId, promise, index } of taskPromises) {
            try {
                const result = await promise;
                resultMap.set(taskId, result);

                const percent = Math.ceil(((index + 1) / taskPromises.length) * 100);
                if (onProgress) {
                    onProgress({
                        percent,
                        message: `TFMTF ${percent}% (${index + 1}/${taskPromises.length})`
                    });
                }
            } catch (error) {
                console.error(`❌ [TFMTF] Task ${taskId} failed:`, error);
                resultMap.set(taskId, {
                    taskId,
                    defocusShiftMm: defocusValues[index],
                    mtfValue: 0,
                    mtfTangential: 0,
                    mtfSagittal: 0,
                    timeMs: 0,
                    error: String(error instanceof Error ? error.message : error)
                });
            }
        }

        // Assemble results in order
        const results = defocusValues.map((defocus, i) => {
            const taskId = `tfmtf_${i}`;
            const result = resultMap.get(taskId);
            return {
                defocusMm: defocus,
                mtfValue: result?.mtfValue ?? 0,
                mtfTangential: result?.mtfTangential ?? 0,
                mtfSagittal: result?.mtfSagittal ?? 0
            };
        });

        console.log(`✅ [TFMTF] Calculation complete (${results.length} points)`);

        return results;
    }

    /**
     * Cleanup worker pool
     */
    terminate(): void {
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
        this.workerBusy.clear();
        this.taskMap.clear();
        this.workerTaskMap.clear();
        this.taskQueue = [];
        console.log('✅ [TFMTF] Worker pool terminated');
    }
}

/**
 * Global singleton worker pool
 */
let globalWorkerPool: TFMTFWorkerPool | null = null;

export async function getGlobalTFMTFWorkerPool(workerCount: number = 4): Promise<TFMTFWorkerPool> {
    if (!globalWorkerPool) {
        globalWorkerPool = new TFMTFWorkerPool(workerCount);
        await globalWorkerPool.initialize();
    }
    return globalWorkerPool;
}
