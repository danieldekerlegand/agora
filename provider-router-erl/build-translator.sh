#!/bin/sh
# Build the agora:60 translation port program into priv/ (agora:80 US-5).
#
# Run as a rebar3 compile pre-hook. Deliberately BEST-EFFORT: it always exits 0. The router's
# binding to the Rust translator is fail-safe by design — with no executable in priv/ every
# native-wire vendor stays `pending-adapter` and the ladder falls through exactly as it does
# on the Python router. So a host without cargo, or a checkout extracted without its sibling
# `translation/` area, still passes the whole Erlang gate; it just cannot dial anthropic,
# gemini, replicate, elevenlabs, runway, luma or minimax.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
WORKSPACE="$HERE/../translation"
TARGET="$HERE/priv/agora-translation-port"

if [ ! -f "$WORKSPACE/Cargo.toml" ]; then
    echo "translator: the agora:60 translation workspace is absent — native-wire vendors stay pending-adapter"
    exit 0
fi

if ! command -v cargo >/dev/null 2>&1; then
    echo "translator: cargo not found — native-wire vendors stay pending-adapter (install Rust to dial them)"
    exit 0
fi

mkdir -p "$HERE/priv"

if cargo build --quiet --manifest-path "$WORKSPACE/Cargo.toml" \
        -p translation-wire --bin agora-translation-port; then
    cp "$WORKSPACE/target/debug/agora-translation-port" "$TARGET"
    echo "translator: $TARGET"
else
    # A broken build must not be a broken gate, and must not leave a stale binary behind
    # claiming a capability this tree no longer has.
    rm -f "$TARGET"
    echo "translator: build failed — native-wire vendors stay pending-adapter"
fi

exit 0
