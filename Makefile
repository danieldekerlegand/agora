# agora — the runtime commons. `make check` runs every area's gate.
#
# Two toolchains (see README "Stack"): uv/Python for provider-router, npm workspaces /
# TypeScript for everything else. Each area's gate is a target here, so a story that touches
# one area runs one target; CI runs `check`.

PY_DIR := provider-router
# Run uv from inside the area: ruff, mypy and pytest all read their config from the
# nearest pyproject.toml, so `uv --project <dir>` alone would leave them unconfigured.
UV     := cd $(PY_DIR) && uv
# npm workspace selectors for the TS areas.
TS_AREAS := schemas clients/kcb-client clients/relation-registry-client registry resolver console

# The interchange artifact names — the shared list BOTH validators expose
# (schemas/src/validator.ts ARTIFACT_SCHEMAS ⇔ artifact_validator.py). legacy's
# conformance.yml looped the first five through each ecosystem's validator CLI;
# `check-conformance` below absorbs that loop as a `make check` step. finetune-job
# (KFT §3, agora:41) joins the same loop so a regression in either validator or its
# fixture turns `make check` red too. Their golden fixtures live off the
# @agora/schemas library surface, beside the vitest/pytest conformance suites.
ARTIFACTS := grounding-pack canonical-world-export entity-grounding-snapshot analyzer-canonical-export dataset-jsonl-header finetune-job
FIXTURES  := $(CURDIR)/schemas/src/conformance/fixtures

.PHONY: help install install-py install-ts check check-provider-router check-router-erl \
        check-ts check-schemas check-clients check-registry check-resolver check-console \
        check-conformance check-translation build fmt clean

# The Erlang provider-router (agora:80, ADR-0004) — supersedes provider-router/ (agora:50).
ROUTER_ERL_DIR := provider-router-erl

help:  ## List the available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*?## "}{printf "  %-24s %s\n", $$1, $$2}'

install: install-py install-ts  ## Install every area's dependencies

install-py:  ## Install the provider-router's Python deps
	$(UV) sync --extra dev

install-ts:  ## Install the TypeScript workspace deps
	npm install

check: check-provider-router check-router-erl check-ts check-conformance check-translation  ## Run every area's gate (what CI runs)

# --- provider-router (Python / uv) ---
check-provider-router: install-py  ## Gate: lint + typecheck + test the provider-router
	$(UV) run ruff check .
	$(UV) run ruff format --check .
	$(UV) run mypy
	$(UV) run pytest -q

# --- provider-router-erl (Erlang/OTP — rebar3) ---
# The Erlang re-implementation of the provider-router (agora:80, ADR-0004). Skipped (not
# failed) when the Erlang toolchain is absent, mirroring check-path-index / check-translation's
# native-optional convention: a rebar3-less host still passes `make check` and the Rust/TS
# gates cover their own areas. When rebar3 is present it runs the full gate — compile,
# dialyzer, eunit, ct — so the byte-for-byte contract is verified everywhere Erlang is built.
check-router-erl:  ## Gate: the Erlang provider-router (rebar3 compile + dialyzer + eunit + ct)
	@if command -v rebar3 >/dev/null 2>&1; then \
		echo "rebar3 compile + dialyzer + eunit + ct (provider-router-erl)"; \
		cd $(ROUTER_ERL_DIR) && rebar3 compile && rebar3 dialyzer && rebar3 eunit && rebar3 ct; \
	else \
		echo "rebar3 not found — skipping Erlang provider-router gate (agora:80; install Erlang/OTP + rebar3 to run it)"; \
	fi

# --- TypeScript areas (npm workspaces) ---
# The whole workspace at once: one install, one lint pass, then per-package typecheck+test.
check-ts: install-ts  ## Gate: lint + typecheck + test every TypeScript area
	npm run lint
	npm run typecheck
	npm run test

# --- conformance CLI smoke (both ecosystems) ---
# legacy/.github/workflows/conformance.yml L25-30 & L44-49 looped every artifact name
# through BOTH validator CLIs (Node ajv + Python jsonschema) so a regression in either
# validator or any golden fixture turned the gate red. Absorbed here as a `make check`
# step: the conformance can never ship drift agora does not catch in itself — legacy's
# self-gating "first gate" property, now enforced from inside the runtime commons.
# The vitest (schemas) and pytest (provider-router) conformance suites already run under
# check-ts / check-provider-router; this adds the runnable-CLI half in both ecosystems.
check-conformance: install-ts install-py  ## Gate: CLI-smoke every artifact through both validators
	@set -e; for name in $(ARTIFACTS); do \
	  echo "conformance smoke (ts):     $$name"; \
	  node schemas/src/validate.ts "$$name" "$(FIXTURES)/$$name.json"; \
	done
	@set -e; cd $(PY_DIR); for name in $(ARTIFACTS); do \
	  echo "conformance smoke (python): $$name"; \
	  uv run python -m agora_provider_router.artifact_validator "$$name" "$(FIXTURES)/$$name.json"; \
	done

# Per-area gates, for a story that touches exactly one package.
check-schemas:  ## Gate: the shared schemas package only
	@$(MAKE) --no-print-directory ts-area PKG=@agora/schemas
check-clients:  ## Gate: the client libraries only
	@$(MAKE) --no-print-directory ts-area PKG="@agora/kcb-client @agora/relation-registry-client"
check-registry: check-path-index  ## Gate: the registry only (TS gate + the Rust path-index crate)
	@$(MAKE) --no-print-directory ts-area PKG=@agora/registry

# The Rust path-index engine behind CapabilityRegistry.path(). Skipped (not failed) when the Rust
# toolchain is absent: the TS shim falls back to the pure-TypeScript path, so a Rust-less host still
# builds and passes the TS gate (source-first / native-optional, US-5).
.PHONY: check-path-index
check-path-index:  ## Gate: the Rust path-index crate (cargo test + clippy)
	@if command -v cargo >/dev/null 2>&1; then \
		echo "cargo test + clippy (registry/path-index)"; \
		cd registry/path-index && cargo test && cargo clippy --all-targets -- -D warnings; \
	else \
		echo "cargo not found — skipping path-index Rust gate (TS fallback covers it)"; \
	fi
check-resolver:  ## Gate: the resolver only
	@$(MAKE) --no-print-directory ts-area PKG=@agora/resolver
check-console:  ## Gate: the console only
	@$(MAKE) --no-print-directory ts-area PKG=@agora/console

# --- translation (Rust — cargo workspace) ---
# The native core (US-1), plus the wasm (US-4) and PyO3 (US-5) binding steps, which
# skip cleanly until their crates land. Needs the Rust toolchain (cargo); no install-*.
check-translation:  ## Gate: build + clippy + test the Rust translation engine
	translation/check.sh

.PHONY: ts-area
ts-area: install-ts
	npm run lint
	npm run typecheck $(addprefix -w ,$(PKG))
	npm run test $(addprefix -w ,$(PKG))

build: install  ## Produce the distributable artifacts (console bundle, router wheel)
	npm run build
	$(UV) build

fmt:  ## Auto-format the Python area (the TS areas are lint-only)
	$(UV) run ruff format .
	$(UV) run ruff check --fix .

clean:  ## Remove build output and installed deps
	rm -rf node_modules */node_modules clients/*/node_modules console/dist $(PY_DIR)/dist $(PY_DIR)/.venv
