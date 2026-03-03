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

wasm-pack build \
  --target web \
  --release \
  --out-dir pkg \
  --out-name surface_origins

mkdir -p "$PUBLIC_PKG_DIR"
rm -rf "$PUBLIC_PKG_DIR"/*
cp -R "$PKG_DIR"/* "$PUBLIC_PKG_DIR"/

echo "✅ [Rust-WASM] synced to public/rust-wasm/pkg"
echo "📦 [Rust-WASM] generated files:"
ls -1 "$PKG_DIR"
