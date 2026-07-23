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

# The five interchange artifact names — the shared list BOTH validators expose
# (schemas/src/validator.ts ARTIFACT_SCHEMAS ⇔ artifact_validator.py). legacy's
# conformance.yml looped these through each ecosystem's validator CLI; `check-conformance`
# below absorbs that loop as a `make check` step. Their golden fixtures live off the
# @agora/schemas library surface, beside the vitest/pytest conformance suites.
ARTIFACTS := grounding-pack canonical-world-export entity-grounding-snapshot analyzer-canonical-export dataset-jsonl-header
FIXTURES  := $(CURDIR)/schemas/src/conformance/fixtures

.PHONY: help install install-py install-ts check check-provider-router check-ts \
        check-schemas check-clients check-registry check-resolver check-console \
        check-conformance build fmt clean

help:  ## List the available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN{FS=":.*?## "}{printf "  %-24s %s\n", $$1, $$2}'

install: install-py install-ts  ## Install every area's dependencies

install-py:  ## Install the provider-router's Python deps
	$(UV) sync --extra dev

install-ts:  ## Install the TypeScript workspace deps
	npm install

check: check-provider-router check-ts check-conformance  ## Run every area's gate (what CI runs)

# --- provider-router (Python / uv) ---
check-provider-router: install-py  ## Gate: lint + typecheck + test the provider-router
	$(UV) run ruff check .
	$(UV) run ruff format --check .
	$(UV) run mypy
	$(UV) run pytest -q

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
check-registry:  ## Gate: the registry only
	@$(MAKE) --no-print-directory ts-area PKG=@agora/registry
check-resolver:  ## Gate: the resolver only
	@$(MAKE) --no-print-directory ts-area PKG=@agora/resolver
check-console:  ## Gate: the console only
	@$(MAKE) --no-print-directory ts-area PKG=@agora/console

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
