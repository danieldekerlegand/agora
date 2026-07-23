#!/usr/bin/env bash
# The wasm binding step of the translation gate (US-4). check.sh runs this because
# it exists-and-is-executable (the US-1 hook). It builds translation-wasm for
# wasm32-unknown-unknown, runs wasm-bindgen to emit the nodejs pkg (JS glue + .d.ts),
# then runs the Node harness that asserts the emitted TSV/Prolog/... bytes are
# byte-identical to the native crate's goldens — one core, two facades.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS="$(cd "$HERE/../.." && pwd)"          # the translation/ cargo workspace
cd "$WS"

# --- locate the toolchain, erroring clearly if truly absent ---
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true

WASM_BINDGEN=""
if command -v wasm-bindgen >/dev/null 2>&1; then
  WASM_BINDGEN="$(command -v wasm-bindgen)"
elif [ -x "$HOME/.cargo/bin/wasm-bindgen" ]; then
  WASM_BINDGEN="$HOME/.cargo/bin/wasm-bindgen"
else
  echo "error: wasm-bindgen CLI not found — install it with:" >&2
  echo "       cargo install wasm-bindgen-cli --version 0.2.126" >&2
  exit 1
fi

echo "  -> cargo build --target wasm32-unknown-unknown --release -p translation-wasm"
cargo build --target wasm32-unknown-unknown --release -p translation-wasm

echo "  -> wasm-bindgen --target nodejs"
"$WASM_BINDGEN" --target nodejs \
  --out-dir "$HERE/pkg" \
  "$WS/target/wasm32-unknown-unknown/release/translation_wasm.wasm"

echo "  -> node test.js"
node "$HERE/test.js"
