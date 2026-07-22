# Project context for Chief agents

`agora` is the **runtime commons** — sibling to `../koine` (koine specifies, agora implements).
Read `CLAUDE.md` and `README.md` first; the contracts live in `../koine/specs/` and
`../koine/decisions/ADR-0001-control-plane-topology.md`.

## Quality checks (loop step 5 — how to verify a story)

Run the gate for the area you touched; `make check` if you touched more than one.

- Everything: `make check` (also what CI and `.chief/verify.sh` run)
- `provider-router/`: `make check-provider-router` — ruff + ruff format --check + mypy + pytest
- `schemas/`: `make check-schemas`
- `clients/*`: `make check-clients`
- `registry/`: `make check-registry`
- `resolver/`: `make check-resolver`
- `console/`: `make check-console`

Each TypeScript gate is eslint + `tsc` typecheck + `vitest run`. Deps install themselves.
Only mark a story done when the relevant checks are green.

## Conventions

- Polyglot: Python (uv) for `provider-router/` only, TypeScript (npm workspaces at the repo
  root) for every other area. Nothing is shared as cross-language source — the router is a
  service over the wire.
- TS packages are **source-first**: `exports` points at `src/index.ts`, `tsc` emits nothing.
  Add a new package by listing it in the root `package.json` `workspaces` and giving it a
  `tsconfig.json` extending `../tsconfig.base.json`, plus `typecheck` + `test` scripts.
- Tests sit next to their subject (`src/foo.test.ts`); Python tests live in
  `provider-router/tests/`.
- Commits: `feat: [Story ID] - [Story Title]`, body ending with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Gotchas

- The koine spec versions are pinned in `schemas/src/index.ts` (`SPEC_VERSIONS`) AND in
  `provider-router/src/agora_provider_router/__init__.py` (`KCB_VERSION`). A test asserts they
  match — bump both together.
- Architectural invariants that gates enforce, don't weaken them to make a test pass:
  the registry returns **addresses and never proxies traffic** (ADR-0001 decision 3), and the
  console **observes real direct A2A/MCP connections** rather than acting as a hub (decision 7).
- The Python tools read config from `provider-router/pyproject.toml`, so the Makefile runs them
  with `cd provider-router` — `uv --project provider-router run mypy` alone leaves them
  unconfigured.
- Two tasklists are staged behind this one (`tasks/chief/20-*`, `30-*`). Only work the tasklist
  the runtime PRD names.
