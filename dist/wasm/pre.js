/**
 * WebAssembly PSF Calculator Pre-JS
 * Emscripten生成コード用の初期化スクリプト
 */

// WebAssembly モジュールの初期化完了を示すフラグ
var PSFWasmReady = false;

// モジュール初期化完了時のコールバック
Module['onRuntimeInitialized'] = function() {
    console.log('🚀 [WASM] PSF Calculator WebAssembly module initialized');
    PSFWasmReady = true;
    
    // グローバルイベントを発火（他のスクリプトが待機できるように）
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('PSFWasmReady'));
    }
};

// エラーハンドリング
Module['onAbort'] = function(what) {
    console.error('❌ [WASM] PSF Calculator WebAssembly module aborted:', what);
};

// メモリ不足時の処理
Module['onOutOfMemory'] = function() {
    console.error('❌ [WASM] PSF Calculator out of memory');
};

console.log('📦 [WASM] PSF Calculator WebAssembly module loading...');
