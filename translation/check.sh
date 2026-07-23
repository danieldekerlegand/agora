#!/usr/bin/env bash
# The translation-area gate (US-1). Runs the native Rust core's build + clippy +
# tests, then the wasm (US-4) and PyO3 (US-5) binding steps — which skip cleanly
# while those crates are absent, mirroring culture-scrape's absent-sibling
# pytest.skip. Once US-4/US-5 land their crate dirs, the steps run for real.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

echo "==> cargo build"
cargo build

echo "==> cargo clippy --all-targets -- -D warnings"
cargo clippy --all-targets -- -D warnings

echo "==> cargo test"
cargo test

# --- wasm bindings (US-4): translation/crates/wasm, tested via crates/wasm/test.sh ---
if [ -x "$HERE/crates/wasm/test.sh" ]; then
  echo "==> wasm binding tests"
  "$HERE/crates/wasm/test.sh"
else
  echo "==> wasm binding tests: SKIP (translation-wasm not built yet — US-4)"
fi

# --- PyO3 bindings (US-5): translation/crates/py, tested via crates/py/test.sh ---
if [ -x "$HERE/crates/py/test.sh" ]; then
  echo "==> PyO3 binding tests"
  "$HERE/crates/py/test.sh"
else
  echo "==> PyO3 binding tests: SKIP (translation-py not built yet — US-5)"
fi

echo "translation gate: OK"
