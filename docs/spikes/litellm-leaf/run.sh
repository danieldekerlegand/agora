#!/usr/bin/env bash
# Run the LiteLLM leaf-gateway spike (docs/spike-litellm-leaf.md).
#
# Throwaway by construction: LiteLLM is installed into a scratch venv under $TMPDIR and is
# NOT a dependency of provider-router/ — the spike's whole question is whether it should
# become one. Nothing here runs under `make check`.
#
#   ./docs/spikes/litellm-leaf/run.sh            # transcript to stdout
#   LITELLM_VERSION=1.95.0 ./run.sh              # pin the version under test
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="${SPIKE_VENV:-${TMPDIR:-/tmp}/agora-litellm-spike-venv}"
version="${LITELLM_VERSION:-1.95.0}"

if [ ! -x "$venv/bin/python" ]; then
  uv venv "$venv" >&2
fi
uv pip install --quiet --python "$venv/bin/python" "litellm==$version" >&2

# LiteLLM logs cost-map misses at WARNING on stderr for every unmapped model; the spike
# reports those itself (experiment 6), so keep the transcript to the experiments' own output.
exec "$venv/bin/python" "$here/spike_litellm.py" 2>/dev/null
