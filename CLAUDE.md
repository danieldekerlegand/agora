# CLAUDE.md — agora (Chief harness)

`agora` is the **runtime commons** for the ecosystem — sibling to `../koine` (koine
specifies, agora implements). See `README.md` and
`../koine/decisions/ADR-0001-control-plane-topology.md`.

## Your task (per iteration)

1. Read the active tasklist in `tasks/chief/` (start with `10-agora-bootstrap.json`).
2. Read `progress.txt` (check the `## Codebase Patterns` section first).
3. Check out the tasklist's `branchName` from `main` (create it if missing). Keep `main` clean.
4. Pick the **highest-priority** user story where `passes: false`, honoring `dependsOn`.
5. Implement that **one** story to satisfy its acceptance criteria.
6. Run the quality gates for the area you touched (see below), zero errors.
7. Commit all changes: `feat: [Story ID] - [Story Title]`, ending the body with
   `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
8. Set `passes: true` for the completed story in the tasklist.
9. Append what you did + learnings to `progress.txt`.

Work ONE story per iteration; never commit broken code (a red gate compounds across
iterations).

## Quality gates (step 6)

Established by US-AG1. Run the gate for the area you touched; run `make check` if you touched
more than one. Zero errors, exit 0. `make help` lists everything.

| Area | Gate |
|---|---|
| everything | `make check` (what CI and `.chief/verify.sh` run) |
| `provider-router/` | `make check-provider-router` |
| `provider-router-erl/` | `make check-router-erl` (Erlang/OTP re-implementation, agora:80 / ADR-0004) |
| `schemas/` | `make check-schemas` |
| `clients/*` | `make check-clients` |
| `registry/` | `make check-registry` |
| `resolver/` | `make check-resolver` |
| `console/` | `make check-console` |

Dependencies install themselves (`make install`, or implicitly via any `check-*` target).

## Stack

Polyglot by decision, per ADR-0001 (language is internal — everything is shared over the wire,
never as cross-language source). See README "Stack" for the rationale.

- **`provider-router/`** — Python 3.11+, uv, FastAPI. Lint/format `ruff`, types `mypy --strict`,
  tests `pytest`. Package `agora_provider_router` under `src/`.
- **everything else** — TypeScript, Node 22, npm workspaces at the repo root. React 19 + Vite for
  the console. Lint `eslint` (one flat config at the root), types `tsc -p tsconfig.json`
  (`--noEmit`), tests `vitest`. Packages are **source-first**: `exports` points at
  `src/index.ts`, nothing is emitted, so there is no cross-package build ordering. Tests live
  next to their subject as `*.test.ts(x)`.

The koine spec versions are pinned once in `schemas/src/versions.ts` and asserted against the
Python constant by `provider-router/tests/`; if you bump one, bump both or that gate goes red.

## The contracts live in ../koine

Every story implements a koine spec (KINP/KGP/KCB/KMI/KCS) — read the referenced spec before
implementing. Do not re-specify contracts here; propose contract changes as edits to koine.

## Layout (established by US-AG1)

Each is a buildable unit with its own gate — see README "Layout" for what each one is.

```
provider-router/   Python — the model-backend ladder
registry/          TS — thin KCB discovery (route-by-lookup, NEVER proxy)
resolver/          TS — KINP resolve / reconcile
console/           TS + React — conformance scenario runner + UI (observer, not a hub)
schemas/           TS — @agora/schemas, shared manifest schemas / protocol types
clients/kcb-client/  TS — @agora/kcb-client, returns ADDRESSES, never relays payloads
clients/relation-registry-client/  TS — loads koine's relation registry; never mirrors it
```

The relation registry is koine's data and agora's tooling: `schemas/src/registry-schema.ts`
validates it, `clients/relation-registry-client/` fetches and indexes it. The only copy here is
the test snapshot under `schemas/src/fixtures/` (reachable as `@agora/schemas/fixtures`, never
from the library surface) — a second authored copy is how the registry forks.
