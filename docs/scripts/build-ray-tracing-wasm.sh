#!/bin/bash
set -euo pipefail

# Ray Tracing WebAssembly Build Script
# ray-tracing-wasm.c -> ray-tracing-wasm-v3.js / ray-tracing-wasm-v3.wasm

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "🔨 [WASM] Ray Tracing WebAssembly Build"
echo "======================================"

if ! command -v emcc >/dev/null 2>&1; then
  echo "❌ [Error] emcc (Emscripten) not found in PATH."
  echo "    Install Emscripten SDK: https://emscripten.org/docs/getting_started/downloads.html"
  exit 1
fi

echo "✅ [WASM] emcc found: $(emcc --version | head -n1)"

SRC="wasm/raytracing/ray-tracing-wasm.c"
OUT_JS="wasm/raytracing/ray-tracing-wasm-v3.js"

if [ ! -f "$SRC" ]; then
  echo "❌ [Error] Missing source: $SRC"
  exit 1
fi

echo "🔄 [WASM] Compiling $SRC -> $OUT_JS"

mkdir -p "$(dirname "$OUT_JS")"

# Notes:
# - MODULARIZE + EXPORT_NAME=RayTracingWASM matches existing loader expectations
# - We explicitly export the new entrypoint _aspheric_sag_rt10 (ray-tracing.js coefficient convention)
# - ALLOW_MEMORY_GROWTH avoids OOM for larger workloads
emcc "$SRC" \
  -O3 \
  -o "$OUT_JS" \
  -s MODULARIZE=1 \
  -s EXPORT_NAME='RayTracingWASM' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_FUNCTIONS="['_aspheric_sag','_aspheric_sag10','_aspheric_sag_rt10','_intersect_aspheric_rt10','_batch_aspheric_sag','_batch_aspheric_sag10','_vector_dot','_vector_cross','_vector_normalize','_ray_sphere_intersect','_batch_vector_normalize','_malloc','_free']" \
  -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap']"

echo "✅ [WASM] Build complete"

if [ -f "wasm/raytracing/ray-tracing-wasm-v3.wasm" ]; then
  echo "✅ [WASM] Output: wasm/raytracing/ray-tracing-wasm-v3.js + wasm/raytracing/ray-tracing-wasm-v3.wasm"
  ls -la wasm/raytracing/ray-tracing-wasm-v3.js wasm/raytracing/ray-tracing-wasm-v3.wasm
else
  echo "⚠️  [Warn] ray-tracing-wasm-v3.wasm not found next to JS output."
  echo "    (If you built with SINGLE_FILE, it may be embedded in the JS.)"
  ls -la wasm/raytracing/ray-tracing-wasm-v3.js
fi

echo ""
echo "📋 After reloading the app, verify in DevTools console:"
echo "  window.getWASMSystem()?.wasmModule?._aspheric_sag_rt10"
echo ""
echo "If it prints a function, ray-tracing.js will automatically use it inside asphericSag()."
