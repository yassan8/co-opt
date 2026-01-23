#!/bin/bash
# PSF WebAssembly Build Script
# EmscriptenでC言語をWebAssemblyにコンパイルして統合

echo "🔨 [WASM] PSF WebAssembly Build Script"
echo "======================================"

# Emscriptenの確認
if ! command -v emcc &> /dev/null; then
    echo "❌ [Error] Emscripten not found. Please install Emscripten SDK first."
    echo "Visit: https://emscripten.org/docs/getting_started/downloads.html"
    exit 1
fi

echo "✅ [WASM] Emscripten found: $(emcc --version | head -n1)"

# wasmディレクトリに移動
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR/wasm"

# makeを実行
echo "🔄 [WASM] Compiling C source to WebAssembly..."
make clean
make all

if [ $? -eq 0 ]; then
    echo "✅ [WASM] Compilation successful"
    
    # 生成ファイルの確認
    if [ -f "psf-wasm.js" ] && [ -f "psf-wasm.wasm" ]; then
        echo "✅ [WASM] Generated files:"
        ls -la psf-wasm.js psf-wasm.wasm
        
        # 親ディレクトリにコピー
        echo "🔄 [WASM] Installing to wasm/psf directory..."
        make install
        
        echo "✅ [WASM] WebAssembly PSF calculator ready!"
        echo ""
        echo "📋 Usage in JavaScript:"
        echo "  import { PSFCalculatorAuto } from './wasm/psf/psf-wasm-wrapper.js';"
        echo "  const calculator = new PSFCalculatorAuto();"
        echo "  const result = await calculator.calculatePSF(opdData, options);"
        echo ""
        echo "🚀 Expected performance improvements:"
        echo "  - 2D FFT: 5-10x faster"
        echo "  - Complex calculations: 3-5x faster"
        echo "  - Overall PSF calculation: 2-4x faster"
        
    else
        echo "❌ [Error] Generated files not found"
        exit 1
    fi
else
    echo "❌ [Error] Compilation failed"
    exit 1
fi

echo ""
echo "🔍 [Info] To test WebAssembly integration:"
echo "  1. Include wasm/psf/psf-wasm.js in your HTML"
echo "  2. Use PSFCalculatorAuto for automatic WASM/JS selection"
echo "  3. Monitor console for performance statistics"
