#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RUST_WASM_DIR="$ROOT_DIR/rust-wasm"
PKG_DIR="$RUST_WASM_DIR/pkg"
PUBLIC_PKG_DIR="$ROOT_DIR/public/rust-wasm/pkg"

echo "🔨 [Rust-WASM] rebuilding wasm package"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "❌ [Rust-WASM] wasm-pack not found"
  echo "Install: cargo install wasm-pack"
  exit 1
fi

echo "✅ [Rust-WASM] wasm-pack: $(wasm-pack --version)"

cd "$RUST_WASM_DIR"

if [[ "${COOPT_WASM_THREADS:-0}" == "1" ]]; then
  echo "🧵 [Rust-WASM] building SharedArrayBuffer/threaded package"
  export RUSTUP_TOOLCHAIN="nightly-2024-08-02"
  export RUSTFLAGS="-C target-feature=+simd128,+atomics,+bulk-memory -C link-arg=--import-memory -C link-arg=--shared-memory -C link-arg=--max-memory=2147483648 -C link-arg=--export=__heap_base -C link-arg=--export=__data_end"
  cargo build \
    --target wasm32-unknown-unknown \
    --release \
    --features wasm-threads \
    -Z build-std=panic_abort,std
  rm -rf pkg
  mkdir -p pkg
  wasm-bindgen \
    --target web \
    --out-dir pkg \
    --out-name surface_origins \
    "target/wasm32-unknown-unknown/release/surface_origins.wasm"
  if [[ -f "$PUBLIC_PKG_DIR/package.json" ]]; then
    cp "$PUBLIC_PKG_DIR/package.json" pkg/package.json
  fi
else
  # Keep SIMD enabled in the production Web package. The packed/SoA-friendly
  # ray loops and FFT kernels can then be vectorized by LLVM without changing
  # ray sampling or numerical precision.
  export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+simd128"
  wasm-pack build \
    --target web \
    --release \
    --out-dir pkg \
    --out-name surface_origins
fi

mkdir -p "$PUBLIC_PKG_DIR"
rm -rf "$PUBLIC_PKG_DIR"/*
cp -R "$PKG_DIR"/* "$PUBLIC_PKG_DIR"/

echo "✅ [Rust-WASM] synced to public/rust-wasm/pkg"
echo "📦 [Rust-WASM] generated files:"
ls -1 "$PKG_DIR"
