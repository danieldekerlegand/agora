#!/usr/bin/env bash
# Standalone verification (US-3): prove the package's own test suite is green in an
# *extracted* checkout that contains only provider-router/ — no sibling schemas/,
# console/ or registry/ areas.
#
# It builds the wheel, installs it into a fresh venv, then runs the package-local
# tests from a temporary tree whose parent has none of the sibling areas. The three
# cross-repo guards (test_skeleton, test_conformance_fixture, test_manifest) skip
# cleanly there instead of erroring, and everything else runs against the installed
# package. Inside the full monorepo those same guards RUN — this only proves the
# standalone path, it does not replace `make check-provider-router`.
#
#   provider-router/scripts/standalone-test.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" # provider-router/
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "==> building the wheel"
uv build --project "$here" --wheel --out-dir "$work/dist"

# A tree holding ONLY the package's tests. Two directories up from the tests is the
# temp dir, which has no schemas/ console/ registry/ — so parents[2]-relative lookups
# resolve to absent paths and the cross-repo guards skip.
echo "==> staging the tests with no sibling areas present"
mkdir -p "$work/standalone"
cp -R "$here/tests" "$work/standalone/tests"

echo "==> installing the built wheel into a clean venv"
uv venv "$work/venv"
uv pip install --python "$work/venv/bin/python" "$work"/dist/*.whl pytest

echo "==> running the package-local suite against the installed package"
cd "$work/standalone"
"$work/venv/bin/python" -m pytest -q tests
