#!/usr/bin/env bash
# The PyO3 binding step of the translation gate (US-5). check.sh runs this because it
# exists-and-is-executable (the US-1 hook). It builds the translation_py extension with
# maturin into an ephemeral, self-contained venv, then runs the pytest suite that
# asserts the emitted TSV / datalog / neo4j-export bytes are byte-identical to the
# committed culture-scrape goldens — one core, two facades. uv drives the venv so the
# step needs no system Python packages; it pins CPython 3.12 for a stable build ABI.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- locate uv, erroring clearly if truly absent (mirrors the wasm step) ---
UV=""
if command -v uv >/dev/null 2>&1; then
  UV="$(command -v uv)"
elif [ -x "$HOME/.local/bin/uv" ]; then
  UV="$HOME/.local/bin/uv"
else
  echo "error: uv not found — install it to build/test the PyO3 bindings:" >&2
  echo "       curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
  exit 1
fi

VENV="$HERE/.venv"
echo "  -> uv venv (CPython 3.12)"
"$UV" venv --clear --python 3.12 "$VENV" >/dev/null
# Activate the venv for maturin (it installs the built extension into $VIRTUAL_ENV).
export VIRTUAL_ENV="$VENV"
export PATH="$VENV/bin:$PATH"

# opentimelineio + the two NLE adapter plugins are the media-timeline path's runtime
# dependency (KMI §4 adopts OTIO; since OTIO 0.15 the adapters are separate
# distributions). They are optional for a caller — nothing else in the extension needs
# them — but the gate installs them so the OTIO round trip runs for real rather than
# skipping.
echo "  -> uv pip install maturin pytest opentimelineio (+ NLE adapters)"
"$UV" pip install --quiet maturin pytest \
  opentimelineio otio-cmx3600-adapter otio-fcp-adapter

echo "  -> maturin develop -p translation-py"
maturin develop --manifest-path "$HERE/Cargo.toml"

echo "  -> pytest"
python -m pytest "$HERE/tests" -q
