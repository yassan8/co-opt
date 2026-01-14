/**
 * PSF Calculator WebAssembly Wrapper
 * WASM版PSF計算の高レベルインターフェース
 * 
 * 機能:
 * - JavaScript/WASMの透過的な切り替え
 * - メモリ管理の自動化
 * - パフォーマンス計測
 * - エラーハンドリング
 * 
 * 作成日: 2025/08/08
 */

/**
 * WASM版PSF計算クラス
 */

function getGlobalPsfWasmSingletonState() {
    const g = (typeof globalThis !== 'undefined') ? globalThis : (typeof window !== 'undefined' ? window : {});
    const key = '__JS_LENS_DRAW_PSF_WASM_SINGLETON__';
    if (!g[key]) {
        g[key] = {
            modulePromise: null,
            module: null,
            failed: false
        };
    }
    return g[key];
}

export class PSFCalculatorWasm {
    constructor() {
        this.wasmModule = null;
        this.isReady = false;
        this.fallbackToJS = true; // JS版にフォールバック
        this.initializationAttempted = false; // 初期化試行フラグ
        this.initializationFailed = false; // 初期化失敗フラグ
        this._initPromise = null;
        
        // WASM関数のラッパー
        this.calculatePSF = null;
        this.calculatePSFGrid = null;
        this.calculateStrehl = null;
        this.calculateEncircledEnergy = null;
        this.freePSFResult = null;
        
        // パフォーマンス統計
        this.performanceStats = {
            wasmCalls: 0,
            jsFallbacks: 0,
            totalWasmTime: 0,
            totalJSTime: 0
        };
        
        // 一度だけ初期化を試行
        if (!this.initializationAttempted) {
            this.initializationAttempted = true;
            this.initializeWasm();
        }
    }

    /**
     * WebAssemblyモジュールの初期化
     */
    async initializeWasm() {
        if (this._initPromise) {
            return this._initPromise;
        }

        this._initPromise = this._initializeWasmImpl();
        return this._initPromise;
    }

    async _initializeWasmImpl() {
        // 既に初期化済みまたは失敗済みの場合は何もしない
        if (this.isReady || this.initializationFailed) {
            return;
        }

        const singleton = getGlobalPsfWasmSingletonState();
        if (singleton.failed) {
            this.initializationFailed = true;
            return;
        }

        try {
            // WASMモジュールが利用可能かチェック
            // console.log('🔍 [WASM] Checking for PSFWasm global...');
            if (typeof PSFWasm === 'undefined') {
                // PSFWasm がまだ読み込まれていないだけの場合は「恒久的失敗」にしない。
                // 後でスクリプトがロードされたタイミングで initializeWasm() を再実行できるようにする。
                this.isReady = false;
                this.wasmModule = null;
                return;
            }

            // console.log('🔄 [WASM] Initializing PSF WebAssembly module...');
            // console.log('🔍 [WASM] PSFWasm type:', typeof PSFWasm);
            
            // WASMモジュールを初期化
            if (!singleton.modulePromise) {
                singleton.modulePromise = PSFWasm();
            }
            this.wasmModule = await singleton.modulePromise;
            singleton.module = this.wasmModule;
            // console.log('🔍 [WASM] Module created:', !!this.wasmModule);
            
            if (!this.wasmModule) {
                // console.warn('⚠️ [WASM] Failed to create WASM module');
                this.initializationFailed = true;
                singleton.failed = true;
                return;
            }

            // 基本的なEmscripten関数が利用可能かチェック
            if (!this.wasmModule._malloc || !this.wasmModule._free || !this.wasmModule.cwrap) {
                // console.warn('⚠️ [WASM] Basic Emscripten functions not available');
                this.initializationFailed = true;
                singleton.failed = true;
                return;
            }

            // メモリアクセス方法をチェック（HEAPF64 または setValue/getValue）
            const hasMemoryAccess = this.wasmModule.HEAPF64 || 
                                  (this.wasmModule.setValue && this.wasmModule.getValue);
            
            if (!hasMemoryAccess) {
                // console.warn('⚠️ [WASM] No memory access methods available');
                this.initializationFailed = true;
                singleton.failed = true;
                return;
            }

            // console.log('✅ [WASM] Memory access available:', {
            //     HEAPF64: !!this.wasmModule.HEAPF64,
            //     setValue: !!this.wasmModule.setValue,
            //     getValue: !!this.wasmModule.getValue
            // });
            // どのコピー手段を使うか（デバッグ用）
            this.memoryCopyMode = this.wasmModule.HEAPF64
                ? 'HEAPF64'
                : (this.wasmModule.HEAP8 ? 'HEAP8' : 'setValue');
            // console.log('🚚 [WASM] Memory copy mode:', this.memoryCopyMode);
            
            // 関数をラップ
            // console.log('🔍 [WASM] Wrapping functions...');
            try {
                this.calculatePSF = this.wasmModule.cwrap('calculate_psf_wasm', 'number', 
                    ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']);

                // Optional: grid入力版（古いwasmビルドでは存在しない）
                try {
                    this.calculatePSFGrid = this.wasmModule.cwrap('calculate_psf_grid_wasm', 'number',
                        ['number', 'number', 'number', 'number', 'number']);
                } catch {
                    this.calculatePSFGrid = null;
                }
                
                this.calculateStrehl = this.wasmModule.cwrap('calculate_strehl_wasm', 'number', 
                    ['number', 'number']);
                
                this.calculateEncircledEnergy = this.wasmModule.cwrap('calculate_encircled_energy_wasm', null, 
                    ['number', 'number', 'number', 'number', 'number']);
                
                this.freePSFResult = this.wasmModule.cwrap('free_psf_result', null, ['number']);

                // console.log('✅ [WASM] Functions wrapped successfully');
            } catch (wrapError) {
                // console.warn('⚠️ [WASM] Function wrapping failed:', wrapError);
                this.initializationFailed = true;
                singleton.failed = true;
                return;
            }

            // HEAPビューが未エクスポートの場合、自前で生成（Memoryを探索）
            try {
                this.ensureHeapViews();
            } catch (e) {
                // console.warn('⚠️ [WASM] Could not create HEAP views from memory:', e.message);
            }

            this.isReady = true;
            // console.log('✅ [WASM] PSF WebAssembly module ready');
            
        } catch (error) {
            console.error('❌ [WASM] Failed to initialize PSF WebAssembly module:', error);
            this.initializationFailed = true;
            singleton.failed = true;
            this.wasmModule = null;
            this.isReady = false;
        }
    }

    /**
     * WebAssembly.Memory から HEAP ビューを生成・更新
     */
    ensureHeapViews() {
        if (!this.wasmModule) return;

        // 既存ビューがあり、buffer が有効ならそのまま
        if (this.wasmModule.HEAPU8 && this.wasmModule.HEAPU8.buffer?.byteLength > 0 &&
            this.wasmModule.HEAPF64 && this.wasmModule.HEAPF64.buffer === this.wasmModule.HEAPU8.buffer) {
            return;
        }

        // Module のプロパティから WebAssembly.Memory を探索
        let wasmMemory = null;
        const mod = this.wasmModule;
        for (const key of Object.keys(mod)) {
            const v = mod[key];
            if (typeof WebAssembly !== 'undefined' && v instanceof WebAssembly.Memory) {
                wasmMemory = v;
                break;
            }
        }

        if (!wasmMemory) {
            throw new Error('WebAssembly.Memory not found on module exports');
        }

        const buffer = wasmMemory.buffer;
        // 新規ビューを割り当て
        mod.HEAP8 = new Int8Array(buffer);
        mod.HEAPU8 = new Uint8Array(buffer);
        mod.HEAP32 = new Int32Array(buffer);
        mod.HEAPF32 = new Float32Array(buffer);
        mod.HEAPF64 = new Float64Array(buffer);

        // デバッグ表示
        // console.log('🧩 [WASM] HEAP views created from memory export');
        this.memoryCopyMode = 'HEAPF64';
        // console.log('🚚 [WASM] Memory copy mode:', this.memoryCopyMode);
    }

    /**
     * データをWASMメモリにコピー（最適化版）
     * @param {Array|Float64Array} data コピーするデータ
     * @returns {number} WASMメモリポインタ
     */
    copyArrayToWasm(data) {
        if (!this.wasmModule || !this.isReady) {
            throw new Error('WASM module not ready');
        }
    // HEAP ビューがなければ作る
    try { this.ensureHeapViews(); } catch (_) {}
        
        const byteLength = data.length * 8; // Float64 = 8 bytes
        const ptr = this.wasmModule._malloc(byteLength);
        
        if (!ptr) {
            throw new Error(`Failed to allocate ${byteLength} bytes in WASM memory`);
        }
        
        try {
            // HEAPF64を直接使用（最も効率的）
            if (this.wasmModule.HEAPF64) {
                // Debug: fast path
                // console.debug('🧠 [WASM] copyArrayToWasm via HEAPF64');
                const heapIndex = ptr / 8; // Float64Array index
                const heap = this.wasmModule.HEAPF64;
                
                // TypedArrayからTypedArrayへの高速コピー
                if (data instanceof Float64Array) {
                    heap.set(data, heapIndex);
                } else {
                    // 通常配列の場合は個別設定
                    for (let i = 0; i < data.length; i++) {
                        heap[heapIndex + i] = data[i];
                    }
                }
                return ptr;
            }
            
            // HEAPF64が利用できない場合、バルクコピーを試行
            if (this.wasmModule.HEAPU8 && data instanceof Float64Array) {
                // console.debug('🧠 [WASM] copyArrayToWasm via HEAPU8 bulk');
                const byteOffset = ptr;
                const sourceBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                this.wasmModule.HEAPU8.set(sourceBytes, byteOffset);
                return ptr;
            }
            
            // フォールバック: setValue/getValueを使用
            // console.warn('⚠️ [WASM] Using slow setValue method for memory copy');
            for (let i = 0; i < data.length; i++) {
                this.wasmModule.setValue(ptr + i * 8, data[i], 'double');
            }
            
            return ptr;
            
        } catch (memoryError) {
            this.wasmModule._free(ptr);
            throw new Error(`WASM memory access not available - falling back to JavaScript`);
        }
    }

    /**
     * Int32Array をWASMメモリにコピー
     * @param {Int32Array} data コピーするデータ
     * @returns {number} WASMメモリポインタ
     */
    copyInt32ArrayToWasm(data) {
        if (!this.wasmModule || !this.isReady) {
            throw new Error('WASM module not ready');
        }

        // HEAP ビューがなければ作る
        try { this.ensureHeapViews(); } catch (_) {}

        const byteLength = data.length * 4; // Int32 = 4 bytes
        const ptr = this.wasmModule._malloc(byteLength);
        if (!ptr) {
            throw new Error(`Failed to allocate ${byteLength} bytes in WASM memory`);
        }

        try {
            if (this.wasmModule.HEAP32) {
                const heapIndex = ptr / 4;
                this.wasmModule.HEAP32.set(data, heapIndex);
                return ptr;
            }

            // フォールバック: setValue
            for (let i = 0; i < data.length; i++) {
                this.wasmModule.setValue(ptr + i * 4, data[i], 'i32');
            }
            return ptr;
        } catch (memoryError) {
            this.wasmModule._free(ptr);
            throw new Error('WASM memory access not available');
        }
    }

    /**
     * WASMメモリから配列データをコピー（最適化版）
     * @param {number} ptr WASMメモリポインタ
     * @param {number} length データ長
     * @returns {Float64Array} 結果配列
     */
    copyArrayFromWasm(ptr, length) {
        if (!this.wasmModule || !this.isReady) {
            throw new Error('WASM module not ready');
        }
    // HEAP ビューがなければ作る
    try { this.ensureHeapViews(); } catch (_) {}
        
        try {
            // HEAPF64を直接使用（最も効率的）
            if (this.wasmModule.HEAPF64) {
                // console.debug('🧠 [WASM] copyArrayFromWasm via HEAPF64 slice');
                const heapIndex = ptr / 8; // Float64Array index
                const heap = this.wasmModule.HEAPF64;
                
                // TypedArrayの高速スライス
                return heap.slice(heapIndex, heapIndex + length);
            }
            
            // HEAPF64が利用できない場合、バルクコピーを試行
            if (this.wasmModule.HEAPU8) {
                // console.debug('🧠 [WASM] copyArrayFromWasm via HEAPU8 slice');
                const byteOffset = ptr;
                const byteLength = length * 8;
                const sourceBytes = this.wasmModule.HEAPU8.slice(byteOffset, byteOffset + byteLength);
                return new Float64Array(sourceBytes.buffer);
            }
            
            // フォールバック: getValue を使用
            // console.warn('⚠️ [WASM] Using slow getValue method for memory copy');
            const result = new Float64Array(length);
            for (let i = 0; i < length; i++) {
                result[i] = this.wasmModule.getValue(ptr + i * 8, 'double');
            }
            
            return result;
            
        } catch (memoryError) {
            throw new Error('WASM memory access not available');
        }
    }

    _detrendAndFlattenGridData(gridData, removeTilt) {
        const size = gridData?.opd?.length;
        if (!Number.isFinite(size) || size <= 0) {
            throw new Error('Invalid gridData');
        }

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
                if (!gridData.pupilMask?.[i]?.[j]) continue;
                const x = (xCoords && xCoords.length === size) ? xCoords[j] : ((j - (size - 1) / 2) / ((size - 1) / 2));
                const z = gridData.opd?.[i]?.[j];
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

        // removeTilt=false のときは piston のみ除去（a=b=0）
        let a = 0;
        let b = 0;
        let c = meanZ;

        if (removeTilt && S >= 3) {
            // Gaussian elimination on 3x3 (match eva-psf.js)
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

            if (Math.abs(A11) < Math.abs(A21)) swapRows(1, 2);
            if (Math.abs(A11) > eps) {
                const f21 = A21 / A11;
                A20 -= f21 * A10; A21 -= f21 * A11; A22 -= f21 * A12; B2 -= f21 * B1;
            }

            if (Math.abs(A22) > eps) c = B2 / A22;
            if (Math.abs(A11) > eps) b = (B1 - A12 * c) / A11;
            if (Math.abs(A00) > eps) a = (B0 - A01 * b - A02 * c) / A00;
        }

        const opdFlat = new Float64Array(size * size);
        const ampFlat = new Float64Array(size * size);
        const maskFlat = new Int32Array(size * size);

        for (let i = 0; i < size; i++) {
            const yRow = (yCoords && yCoords.length === size) ? yCoords[i] : ((i - (size - 1) / 2) / ((size - 1) / 2));
            for (let j = 0; j < size; j++) {
                const idx = i * size + j;
                const inPupil = !!gridData.pupilMask?.[i]?.[j];
                const z = gridData.opd?.[i]?.[j];

                if (!inPupil || !Number.isFinite(z)) {
                    maskFlat[idx] = 0;
                    opdFlat[idx] = 0;
                    ampFlat[idx] = 0;
                    continue;
                }

                const xCol = (xCoords && xCoords.length === size) ? xCoords[j] : ((j - (size - 1) / 2) / ((size - 1) / 2));
                opdFlat[idx] = z - (a * xCol + b * yRow + c);
                const aij = gridData.amplitude?.[i]?.[j];
                ampFlat[idx] = Number.isFinite(aij) ? aij : 1;
                maskFlat[idx] = 1;
            }
        }

        return { opdFlat, ampFlat, maskFlat };
    }

    _computeStrehlFromGridData(gridData, wavelength) {
        // Strehlは wavefront RMS（piston+tilt除去）でMaréchal近似
        try {
            const { opdFlat, maskFlat } = this._detrendAndFlattenGridData(gridData, true);
            let acc = 0;
            let n = 0;
            for (let i = 0; i < opdFlat.length; i++) {
                if (!maskFlat[i]) continue;
                const z = opdFlat[i];
                if (!Number.isFinite(z)) continue;
                acc += z * z;
                n++;
            }
            if (n <= 0) return 0;
            const rms = Math.sqrt(acc / n);
            const k = 2 * Math.PI * (rms / wavelength);
            return Math.max(0, Math.min(1, Math.exp(-(k * k))));
        } catch {
            return 0;
        }
    }

    /**
     * メインPSF計算関数（WASM版）
     * @param {Object} opdData OPD計算結果
     * @param {Object} options 計算オプション
     * @returns {Object} PSF計算結果
     */
    async calculatePSFWasm(opdData, options = {}) {
        // 初期化チェック（失敗済みの場合は例外を投げる）
        if (this.initializationFailed) {
            throw new Error('WASM initialization failed - cannot use WASM calculator');
        }

        // 初期化がまだ完了していない場合のみ実行
        if (!this.initializationAttempted) {
            await this.initializeWasm();
            this.initializationAttempted = true;
        }

        if (!this.isReady || this.initializationFailed) {
            throw new Error('WASM module not ready');
        }

        const startTime = performance.now();
        
        try {
            const {
                samplingSize = 128,
                pupilDiameter = 10.0,
                focalLength = 100.0
            } = options;

            // 主波長の解決（μm）: 明示指定 > Sourceテーブル > 既定値
            const effectiveWavelength = (Number.isFinite(Number(options.wavelength)) && Number(options.wavelength) > 0)
                ? Number(options.wavelength)
                : (typeof window !== 'undefined' && typeof window.getPrimaryWavelength === 'function')
                    ? Number(window.getPrimaryWavelength()) || 0.5876
                    : 0.5876;

            // console.log(`🚀 [WASM] PSF計算開始 (${samplingSize}x${samplingSize})`);

            // 大きなサンプリングサイズの場合のメモリチェック
            if (samplingSize >= 2048) {
                // console.warn(`⚠️ [WASM] Large sampling size (${samplingSize}x${samplingSize}) - checking memory availability`);
                
                // 必要メモリ量の概算（バイト）
                const estimatedMemory = samplingSize * samplingSize * 8 * 4; // 4つの配列（real, imag, result, temp）
                const availableMemory = this.wasmModule.HEAP8 ? this.wasmModule.HEAP8.length : 0;
                
                if (estimatedMemory > availableMemory * 0.7) { // 70%以上使用する場合は警告
                    // console.warn(`⚠️ [WASM] High memory usage expected: ${(estimatedMemory/1024/1024).toFixed(1)}MB needed, ${(availableMemory/1024/1024).toFixed(1)}MB available`);
                }
            }

            // 詳細計測開始
            const breakdown = {};

            // gridData が与えられている場合は「補間なし」でWASM FFTを回す
            if (opdData && opdData.gridData) {
                if (!this.calculatePSFGrid) {
                    throw new Error('WASM build does not support gridData input');
                }

                const gridData = opdData.gridData;
                const size = gridData?.opd?.length;
                if (!Number.isFinite(size) || size !== samplingSize) {
                    throw new Error(`gridData size mismatch: grid=${size} samplingSize=${samplingSize}`);
                }

                const removeTilt = (options && options.removeTilt !== undefined) ? !!options.removeTilt : true;

                // 1. データ準備（detrend + flatten）
                const prepStartTime = performance.now();
                const { opdFlat, ampFlat, maskFlat } = this._detrendAndFlattenGridData(gridData, removeTilt);
                breakdown.dataPreparationTime = performance.now() - prepStartTime;

                // 2. メモリ転送
                const memoryStartTime = performance.now();
                const ptrGridOPD = this.copyArrayToWasm(opdFlat);
                const ptrAmp = this.copyArrayToWasm(ampFlat);
                const ptrMask = this.copyInt32ArrayToWasm(maskFlat);
                breakdown.memoryTransferTime = performance.now() - memoryStartTime;

                // 3. WASM計算
                const computationStartTime = performance.now();
                const resultPtr = this.calculatePSFGrid(
                    ptrGridOPD, ptrAmp, ptrMask,
                    samplingSize, effectiveWavelength
                );
                if (resultPtr === 0) {
                    throw new Error('WASM PSF calculation failed');
                }
                breakdown.computationTime = performance.now() - computationStartTime;

                // 4. データ変換
                const conversionStartTime = performance.now();
                const psfIntensity = this.copyArrayFromWasm(resultPtr, samplingSize * samplingSize);

                const strehlRatio = this._computeStrehlFromGridData(gridData, effectiveWavelength);

                // エンサークルドエネルギー計算
                const radii = new Float64Array([1, 2, 3, 4, 5, 10, 15, 20]);
                const energies = new Float64Array(radii.length);
                const ptrRadii = this.copyArrayToWasm(radii);
                const ptrEnergies = this.copyArrayToWasm(energies);
                this.calculateEncircledEnergy(resultPtr, samplingSize, ptrRadii, ptrEnergies, radii.length);
                const encircledEnergy = this.copyArrayFromWasm(ptrEnergies, radii.length);

                breakdown.dataConversionTime = performance.now() - conversionStartTime;

                // メモリ解放（以降はJS側データのみを扱う）
                this.wasmModule._free(ptrGridOPD);
                this.wasmModule._free(ptrAmp);
                this.wasmModule._free(ptrMask);
                this.wasmModule._free(ptrRadii);
                this.wasmModule._free(ptrEnergies);
                this.freePSFResult(resultPtr);

                const endTime = performance.now();
                const executionTime = endTime - startTime;

                // 統計更新
                this.performanceStats.wasmCalls++;
                this.performanceStats.totalWasmTime += executionTime;

                // 2D配列に変換
                const psf2D = Array(samplingSize).fill().map(() => Array(samplingSize).fill(0));
                for (let i = 0; i < samplingSize; i++) {
                    for (let j = 0; j < samplingSize; j++) {
                        psf2D[i][j] = psfIntensity[i * samplingSize + j];
                    }
                }

                const { fwhmX, fwhmY } = this.calculateFWHM(psf2D);

                return {
                    psf: psf2D,
                    strehlRatio,
                    fwhm: { x: fwhmX, y: fwhmY },
                    encircledEnergy: {
                        radii: Array.from(radii),
                        values: Array.from(encircledEnergy)
                    },
                    wavelength: effectiveWavelength,
                    calculationTime: executionTime,
                    metadata: {
                        dataPreparationTime: breakdown.dataPreparationTime,
                        memoryTransferTime: breakdown.memoryTransferTime,
                        computationTime: breakdown.computationTime,
                        dataConversionTime: breakdown.dataConversionTime,
                        samplingSize,
                        wavelength: effectiveWavelength,
                        rayCount: 0,
                        executionTime,
                        method: 'wasm-grid'
                    }
                };
            }

            // 有効な光線データを準備
            const validRays = opdData.rayData.filter(ray => !ray.isVignetted && !isNaN(ray.opd));
            
            if (validRays.length === 0) {
                throw new Error('No valid rays found');
            }

            // 1. データ準備（計測）
            const prepStartTime = performance.now();
            const pupilCoords = validRays.map(ray => ({ x: ray.pupilX, y: ray.pupilY }));
            const bounds = this.calculateBounds(pupilCoords);

            const rayX = new Float64Array(validRays.map(ray => ray.pupilX));
            const rayY = new Float64Array(validRays.map(ray => ray.pupilY));
            const rayOPD = new Float64Array(validRays.map(ray => ray.opd));
            breakdown.dataPreparationTime = performance.now() - prepStartTime;
            
            // console.log(`🕒 [WASM] Data preparation: ${breakdown.dataPreparationTime.toFixed(2)}ms`);

            // 2. メモリ転送（計測）
            const memoryStartTime = performance.now();
            const ptrX = this.copyArrayToWasm(rayX);
            const ptrY = this.copyArrayToWasm(rayY);
            const ptrOPD = this.copyArrayToWasm(rayOPD);
            breakdown.memoryTransferTime = performance.now() - memoryStartTime;
            
            // console.log(`🕒 [WASM] Memory transfer: ${breakdown.memoryTransferTime.toFixed(2)}ms`);

            // 3. WASM計算（計測）
            const computationStartTime = performance.now();
            const resultPtr = this.calculatePSF(
                ptrX, ptrY, ptrOPD, validRays.length,
                samplingSize, effectiveWavelength,
                bounds.minX, bounds.maxX, bounds.minY, bounds.maxY
            );

            if (resultPtr === 0) {
                throw new Error('WASM PSF calculation failed');
            }
            breakdown.computationTime = performance.now() - computationStartTime;
            
            // console.log(`🕒 [WASM] Computation: ${breakdown.computationTime.toFixed(2)}ms`);

            // 4. データ変換（計測）
            const conversionStartTime = performance.now();

            // 結果をコピー
            const psfIntensity = this.copyArrayFromWasm(resultPtr, samplingSize * samplingSize);

            // Strehl比計算
            // NOTE: PSF強度をピーク正規化するとStrehlが常に1になり得るため、
            // OPDのRMS（ピストン+チルト除去）からMaréchal近似で評価する。
            const strehlRatio = (() => {
                try {
                    const n = validRays.length;
                    if (!n) return 0;

                    // Fit plane opd ≈ a*x + b*y + c (least squares)
                    let s1 = n;
                    let sx = 0, sy = 0;
                    let sxx = 0, syy = 0, sxy = 0;
                    let sopd = 0, sxopd = 0, syopd = 0;

                    for (let i = 0; i < n; i++) {
                        const x = validRays[i].pupilX;
                        const y = validRays[i].pupilY;
                        const o = validRays[i].opd;
                        sx += x;
                        sy += y;
                        sxx += x * x;
                        syy += y * y;
                        sxy += x * y;
                        sopd += o;
                        sxopd += x * o;
                        syopd += y * o;
                    }

                    // Solve normal equations:
                    // [sxx sxy sx] [a] = [sxopd]
                    // [sxy syy sy] [b]   [syopd]
                    // [sx  sy  s1] [c]   [sopd ]
                    const det =
                        sxx * (syy * s1 - sy * sy) -
                        sxy * (sxy * s1 - sy * sx) +
                        sx  * (sxy * sy - syy * sx);

                    if (!isFinite(det) || Math.abs(det) < 1e-24) {
                        // Fallback: piston only
                        const mean = sopd / n;
                        let acc = 0;
                        for (let i = 0; i < n; i++) {
                            const d = validRays[i].opd - mean;
                            acc += d * d;
                        }
                        const rms = Math.sqrt(acc / n);
                        const k = 2 * Math.PI * (rms / effectiveWavelength);
                        return Math.max(0, Math.min(1, Math.exp(-(k * k))));
                    }

                    const detA =
                        sxopd * (syy * s1 - sy * sy) -
                        sxy   * (syopd * s1 - sy * sopd) +
                        sx    * (syopd * sy - syy * sopd);
                    const detB =
                        sxx   * (syopd * s1 - sy * sopd) -
                        sxopd * (sxy * s1 - sy * sx) +
                        sx    * (sxy * sopd - sxopd * sy);
                    const detC =
                        sxx * (syy * sopd - sy * syopd) -
                        sxy * (sxy * sopd - sy * sxopd) +
                        sx  * (sxy * syopd - syy * sxopd);

                    const a = detA / det;
                    const b = detB / det;
                    const c = detC / det;

                    let acc = 0;
                    for (let i = 0; i < n; i++) {
                        const x = validRays[i].pupilX;
                        const y = validRays[i].pupilY;
                        const o = validRays[i].opd;
                        const resid = o - (a * x + b * y + c);
                        acc += resid * resid;
                    }
                    const rms = Math.sqrt(acc / n);
                    const k = 2 * Math.PI * (rms / effectiveWavelength);
                    return Math.max(0, Math.min(1, Math.exp(-(k * k))));
                } catch (_) {
                    return 0;
                }
            })();

            // エンサークルドエネルギー計算
            const radii = new Float64Array([1, 2, 3, 4, 5, 10, 15, 20]);
            const energies = new Float64Array(radii.length);
            const ptrRadii = this.copyArrayToWasm(radii);
            const ptrEnergies = this.copyArrayToWasm(energies);
            
            this.calculateEncircledEnergy(resultPtr, samplingSize, ptrRadii, ptrEnergies, radii.length);
            const encircledEnergy = this.copyArrayFromWasm(ptrEnergies, radii.length);
            
            breakdown.dataConversionTime = performance.now() - conversionStartTime;
            
            // console.log(`🕒 [WASM] Data conversion: ${breakdown.dataConversionTime.toFixed(2)}ms`);

            // メモリ解放（以降はJS側データのみを扱う）
            this.wasmModule._free(ptrX);
            this.wasmModule._free(ptrY);
            this.wasmModule._free(ptrOPD);
            this.wasmModule._free(ptrRadii);
            this.wasmModule._free(ptrEnergies);
            this.freePSFResult(resultPtr);

            const endTime = performance.now();
            const executionTime = endTime - startTime;

            // 統計更新
            this.performanceStats.wasmCalls++;
            this.performanceStats.totalWasmTime += executionTime;

            // console.log(`✅ [WASM] PSF計算完了 (${executionTime.toFixed(2)}ms)`, {
            //     'Data Prep': `${breakdown.dataPreparationTime.toFixed(1)}ms`,
            //     'Memory Transfer': `${breakdown.memoryTransferTime.toFixed(1)}ms`,
            //     'Computation': `${breakdown.computationTime.toFixed(1)}ms`,
            //     'Data Conversion': `${breakdown.dataConversionTime.toFixed(1)}ms`
            // });
            
            // 総時間検証
            const totalBreakdownTime = breakdown.dataPreparationTime + breakdown.memoryTransferTime + 
                                     breakdown.computationTime + breakdown.dataConversionTime;
            // console.log(`🧮 [WASM] Time verification: Total=${executionTime.toFixed(2)}ms, Breakdown=${totalBreakdownTime.toFixed(2)}ms`);

            // フォールバック: 詳細内訳が取得できなかった場合は、計算時間=総実行時間とみなす
            if (!isFinite(totalBreakdownTime) || totalBreakdownTime < 0.1) {
                // console.warn('⚠️ [WASM] Breakdown timings are near zero; applying fallback distribution');
                breakdown.dataPreparationTime = 0;
                breakdown.memoryTransferTime = 0;
                breakdown.dataConversionTime = 0;
                breakdown.computationTime = executionTime; // すべて計算フェーズに割当
            }

            const PSF_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__PSF_DEBUG);

            // WASM結果がPSFではなく「瞳マスク(0/1)＋fftshift」っぽい場合の検出
            // 典型症状: 値がほぼ0かmaxの二値、中心がmin付近、四隅がmax付近（fftshiftでマスクの外側が中心へ来る）
            const validateWasmPsfLooksValid = () => {
                const total = samplingSize * samplingSize;
                if (!psfIntensity || psfIntensity.length !== total) return true; // 判定不能なら通す

                let minV = Infinity;
                let maxV = -Infinity;
                for (let i = 0; i < total; i++) {
                    const v = psfIntensity[i];
                    if (!Number.isFinite(v)) continue;
                    if (v < minV) minV = v;
                    if (v > maxV) maxV = v;
                }
                if (!Number.isFinite(minV) || !Number.isFinite(maxV) || maxV <= 0) return true;

                // ノイズ許容で0/1っぽさを判定
                let nearLow = 0;
                let nearHigh = 0;
                for (let i = 0; i < total; i++) {
                    const v = psfIntensity[i];
                    if (!Number.isFinite(v)) continue;
                    const n = v / maxV;
                    if (n <= 1e-6) nearLow++;
                    else if (n >= 0.99) nearHigh++;
                }

                const binaryRatio = (nearLow + nearHigh) / total;
                const c = Math.floor(samplingSize / 2);
                const centerV = psfIntensity[c * samplingSize + c];
                const cornersAvg = (
                    psfIntensity[0] +
                    psfIntensity[samplingSize - 1] +
                    psfIntensity[(samplingSize - 1) * samplingSize] +
                    psfIntensity[(samplingSize - 1) * samplingSize + (samplingSize - 1)]
                ) / 4;

                const centerNorm = Number.isFinite(centerV) ? (centerV / maxV) : NaN;
                const cornersNorm = Number.isFinite(cornersAvg) ? (cornersAvg / maxV) : NaN;

                const looksLikeShiftedMask =
                    binaryRatio > 0.95 &&
                    Number.isFinite(centerNorm) && centerNorm < 0.01 &&
                    Number.isFinite(cornersNorm) && cornersNorm > 0.8;

                if (looksLikeShiftedMask) {
                    console.warn('⚠️ [WASM] Invalid PSF output (mask-like). Falling back to JavaScript.');
                    if (PSF_DEBUG) {
                        console.log('[WASM] mask-like diagnostics:', {
                            samplingSize,
                            minV,
                            maxV,
                            binaryRatio,
                            centerNorm,
                            cornersNorm
                        });
                    }
                    return false;
                }

                return true;
            };

            if (!validateWasmPsfLooksValid()) {
                throw new Error('Invalid WASM PSF (binary mask-like output)');
            }

            // 2D配列に変換
            const psf2D = Array(samplingSize).fill().map(() => Array(samplingSize).fill(0));
            for (let i = 0; i < samplingSize; i++) {
                for (let j = 0; j < samplingSize; j++) {
                    psf2D[i][j] = psfIntensity[i * samplingSize + j];
                }
            }

            // FWHM計算（JavaScript側で実装）
            const { fwhmX, fwhmY } = this.calculateFWHM(psf2D);

            // ベンチマーク用のデバッグログ（必要時のみ）
            if (PSF_DEBUG) {
                console.log(`🔧 [WASM-WRAPPER] Created result metadata:`, {
                    'calculationTime': executionTime,
                    'breakdown': breakdown,
                    'metadata': {
                        dataPreparationTime: breakdown.dataPreparationTime,
                        memoryTransferTime: breakdown.memoryTransferTime,
                        computationTime: breakdown.computationTime,
                        dataConversionTime: breakdown.dataConversionTime
                    }
                });
            }

            return {
                psf: psf2D,
                strehlRatio: strehlRatio,
                fwhm: { x: fwhmX, y: fwhmY },
                encircledEnergy: {
                    radii: Array.from(radii),
                    values: Array.from(encircledEnergy)
                },
                wavelength: effectiveWavelength,
                calculationTime: executionTime, // 追加: ベンチマークで使用
                metadata: {
                    dataPreparationTime: breakdown.dataPreparationTime,
                    memoryTransferTime: breakdown.memoryTransferTime,
                    computationTime: breakdown.computationTime,
                    dataConversionTime: breakdown.dataConversionTime,
                    samplingSize,
                    wavelength: effectiveWavelength,
                    rayCount: validRays.length,
                    executionTime,
                    method: 'wasm'
                }
            };

        } catch (error) {
            // メモリ関連エラーの特別処理
            if (error.message && (error.message.includes('Out of bounds') || error.message.includes('memory'))) {
                console.error(`❌ [WASM] Memory error during PSF calculation (${samplingSize || 'unknown'}x${samplingSize || 'unknown'}):`, error.message);
                // console.warn(`💡 [WASM] Consider reducing sampling size or using JavaScript implementation for large sizes`);
            } else {
                console.error('❌ [WASM] PSF calculation failed:', error);
            }
            throw error;
        }
    }

    /**
     * 座標範囲計算
     * @param {Array} coords 座標配列
     * @returns {Object} 範囲情報
     */
    calculateBounds(coords) {
        if (coords.length === 0) {
            return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
        }

        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        for (const coord of coords) {
            minX = Math.min(minX, coord.x);
            maxX = Math.max(maxX, coord.x);
            minY = Math.min(minY, coord.y);
            maxY = Math.max(maxY, coord.y);
        }

        // 正方形にするため、範囲を調整
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const range = Math.max(maxX - minX, maxY - minY) / 2;

        return {
            minX: centerX - range,
            maxX: centerX + range,
            minY: centerY - range,
            maxY: centerY + range
        };
    }

    /**
     * FWHM計算（JavaScript実装）
     * @param {Array} psf 2D PSF配列
     * @returns {Object} FWHM値
     */
    calculateFWHM(psf) {
        const size = psf.length;
        const center = Math.floor(size / 2);

        // 最大値を取得
        let maxValue = 0;
        for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
                maxValue = Math.max(maxValue, psf[i][j]);
            }
        }

        const halfMax = maxValue / 2;

        // X方向のFWHM
        let fwhmX = 0;
        const centerRow = psf[center];
        let leftFound = false, rightFound = false;
        let leftX = 0, rightX = 0;

        for (let j = center; j >= 0; j--) {
            if (!leftFound && centerRow[j] <= halfMax) {
                leftX = center - j;
                leftFound = true;
                break;
            }
        }

        for (let j = center; j < size; j++) {
            if (!rightFound && centerRow[j] <= halfMax) {
                rightX = j - center;
                rightFound = true;
                break;
            }
        }

        if (leftFound && rightFound) {
            fwhmX = leftX + rightX;
        }

        // Y方向のFWHM
        let fwhmY = 0;
        leftFound = false;
        rightFound = false;
        let leftY = 0, rightY = 0;

        for (let i = center; i >= 0; i--) {
            if (!leftFound && psf[i][center] <= halfMax) {
                leftY = center - i;
                leftFound = true;
                break;
            }
        }

        for (let i = center; i < size; i++) {
            if (!rightFound && psf[i][center] <= halfMax) {
                rightY = i - center;
                rightFound = true;
                break;
            }
        }

        if (leftFound && rightFound) {
            fwhmY = leftY + rightY;
        }

        return { fwhmX, fwhmY };
    }

    /**
     * パフォーマンス統計を取得
     * @returns {Object} 統計情報
     */
    getPerformanceStats() {
        const avgWasmTime = this.performanceStats.wasmCalls > 0 ? 
            this.performanceStats.totalWasmTime / this.performanceStats.wasmCalls : 0;
        const avgJSTime = this.performanceStats.jsFallbacks > 0 ? 
            this.performanceStats.totalJSTime / this.performanceStats.jsFallbacks : 0;

        return {
            ...this.performanceStats,
            averageWasmTime: avgWasmTime,
            averageJSTime: avgJSTime,
            speedup: avgJSTime > 0 ? avgJSTime / avgWasmTime : 1
        };
    }

    /**
     * リソースクリーンアップ
     */
    cleanup() {
        // WASMモジュールのクリーンアップは通常不要
        // 必要に応じてカスタムクリーンアップを追加
    }
}

/**
 * PSF計算器の自動選択クラス
 * WASMが利用可能な場合はWASM、そうでなければJavaScript版を使用
 */
export class PSFCalculatorAuto {
    constructor() {
        this.wasmCalculator = null;
        this.jsCalculator = null;
        this.preferWasm = true;
        this.isInitialized = false;
        
        this.initializeCalculators();
    }

    async initializeCalculators() {
        try {
            // WASM版を試行
            this.wasmCalculator = new PSFCalculatorWasm();
            
            // 初期化フラグをチェックして無限ループを防止
            if (!this.wasmCalculator.initializationFailed) {
                await this.wasmCalculator.initializeWasm();
                
                if (this.wasmCalculator.isReady && !this.wasmCalculator.initializationFailed) {
                    // console.log('🚀 [PSF] Using WebAssembly implementation');
                    this.isInitialized = true;
                    return;
                }
            }
            
            // console.log('⚠️ [PSF] WASM initialization failed or not available');
        } catch (error) {
            console.warn('⚠️ [PSF] WASM initialization failed:', error);
        }

        // JavaScript版にフォールバック
        try {
            const { PSFCalculator } = await import('./eva-psf.js');
            this.jsCalculator = new PSFCalculator();
            this.isInitialized = true;
            // console.log('📱 [PSF] Using JavaScript implementation');
        } catch (jsError) {
            console.error('❌ [PSF] Failed to initialize JavaScript fallback:', jsError);
            throw new Error(`PSF calculator initialization failed: ${jsError.message}`);
        }
    }

    /**
     * PSF計算（自動選択）
     * @param {Object} opdData OPD計算結果
     * @param {Object} options 計算オプション
     * @returns {Object} PSF計算結果
     */
    async calculatePSF(opdData, options = {}) {
        const PSF_DEBUG = !!(typeof globalThis !== 'undefined' && globalThis.__PSF_DEBUG);
        if (PSF_DEBUG) {
            console.log(`🔍 [PSF-AUTO] calculatePSF called with options:`, {
                forceImplementation: options.forceImplementation,
                wasmCalculatorExists: !!this.wasmCalculator,
                wasmCalculatorReady: this.wasmCalculator?.isReady,
                wasmInitFailed: this.wasmCalculator?.initializationFailed,
                preferWasm: this.preferWasm
            });
        }

        // WASM強制実行の場合
        if (options.forceImplementation === 'wasm') {
            if (!this.wasmCalculator) {
                throw new Error('WASM calculator not available');
            }
            if (!this.wasmCalculator.isReady) {
                if (PSF_DEBUG) console.log(`🔄 [PSF-AUTO] WASM not ready, initializing...`);
                await this.wasmCalculator.initializeWasm();
            }
            if (PSF_DEBUG) console.log(`🚀 [PSF-AUTO] Force using WASM calculator`);
            return await this.wasmCalculator.calculatePSFWasm(opdData, options);
        }

        // WASM版を試行（失敗フラグが設定されていない場合のみ）
        if (this.wasmCalculator && this.wasmCalculator.isReady && 
            !this.wasmCalculator.initializationFailed && this.preferWasm && 
            !(options.forceImplementation === 'javascript')) {
            try {
                if (PSF_DEBUG) console.log(`🚀 [PSF-AUTO] Using WASM calculator`);
                return await this.wasmCalculator.calculatePSFWasm(opdData, options);
            } catch (error) {
                // console.warn('⚠️ [PSF] WASM calculation failed, falling back to JavaScript:', error);
                // JavaScript版にフォールバック（下に続く）
            }
        } else {
            if (PSF_DEBUG) console.log(`🔄 [PSF-AUTO] Using JavaScript calculator (WASM conditions not met)`);
        }

        // JavaScript版フォールバック
        if (!this.jsCalculator) {
            // JavaScript計算器が初期化されていない場合は緊急作成
            try {
                const { PSFCalculator } = await import('./eva-psf.js');
                this.jsCalculator = new PSFCalculator();
                // console.log('🔧 [PSF] Emergency JavaScript calculator created');
            } catch (importError) {
                throw new Error(`No PSF calculator available: ${importError.message}`);
            }
        }

        const startTime = performance.now();
        const result = await this.jsCalculator.calculatePSF(opdData, options);
        const endTime = performance.now();

        // 統計更新（JavaScript版）
        if (this.wasmCalculator) {
            this.wasmCalculator.performanceStats.jsFallbacks++;
            this.wasmCalculator.performanceStats.totalJSTime += (endTime - startTime);
        }

        result.metadata = result.metadata || {};
        result.metadata.method = 'javascript';
        result.metadata.executionTime = endTime - startTime;

        return result;
    }

    /**
     * パフォーマンス統計取得
     * @returns {Object} 統計情報
     */
    getPerformanceStats() {
        if (this.wasmCalculator) {
            return this.wasmCalculator.getPerformanceStats();
        }
        return { message: 'WASM not available' };
    }

    /**
     * WebAssemblyの状態取得
     * @returns {Object} WASM状態情報
     */
    getWasmStatus() {
        return {
            available: !!(this.wasmCalculator && this.wasmCalculator.wasmModule),
            ready: !!(this.wasmCalculator && this.wasmCalculator.isReady),
            initialized: this.isInitialized,
            preferWasm: this.preferWasm,
            hasJSFallback: !!this.jsCalculator
        };
    }

    /**
     * 実装の強制切り替え
     * @param {string} implementation 'wasm' または 'javascript'
     */
    setImplementation(implementation) {
        if (implementation === 'wasm' && this.wasmCalculator && this.wasmCalculator.isReady) {
            this.preferWasm = true;
            // console.log('🔄 [PSF] Switched to WASM implementation');
        } else if (implementation === 'javascript' && this.jsCalculator) {
            this.preferWasm = false;
            // console.log('🔄 [PSF] Switched to JavaScript implementation');
        } else {
            // console.warn(`⚠️ [PSF] Implementation '${implementation}' not available`);
        }
    }
}
