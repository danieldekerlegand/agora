# agora

> The **runtime commons** for the five-project neuro-symbolic ecosystem — the marketplace
> where the platforms meet and transact.

`agora` is the sibling to [`koine`](../koine): **koine specifies the contracts, agora
implements them.** It holds the shared runtime code the ecosystem's platforms (Insimul,
Pinakes, Orchestrator, Analyzer, Composer) call into — none of which belongs inside any single
platform, and none of which belongs in the contracts-only koine repo.

See [`../koine/decisions/ADR-0001-control-plane-topology.md`](../koine/decisions/ADR-0001-control-plane-topology.md)
for the decision that created this repo.

## Components

- **provider-router** — a language-agnostic, OpenAI-compatible model gateway implementing
  Analyzer's "sacred ladder" (paid → mlx-serve → local → placeholder, per modality,
  always-completes) with cost estimation + budget-ceiling enforcement (the first concrete
  implementation of the KCB `cost`/grant model). A *leaf capability*, not an inter-platform
  router.
- **registry** — the thin KCB discovery registry: **route-by-lookup, never proxy** (returns
  addresses; peers dial each other directly over MCP/A2A). ADR-0001.
- **resolver** — the KINP resolver reference implementation (`resolve` / `reconcile`), backed
  by Pinakes as the authoritative store for real-world entities.
- **client libs / schemas** — shared protocol clients and manifest schemas.
- **conformance console** — a scenario runner + UI that drives any combination of platforms
  over their **real** direct connections and asserts cross-plane invariants (the executable
  form of `../koine/scenarios/*.md`, per the KCS format). An observer, not a hub.

## Layout

Each directory is a **buildable unit with its own gate**:

| Area | Language | What it is |
|---|---|---|
| `provider-router/` | Python (uv) | the model-backend gateway — the sacred ladder |
| `registry/` | TypeScript | the thin KCB discovery registry |
| `resolver/` | TypeScript | the KINP resolver reference implementation |
| `console/` | TypeScript + React | the conformance console (scenario runner + UI) |
| `schemas/` | TypeScript | shared koine manifest schemas / protocol types |
| `clients/*` | TypeScript | shared protocol client libraries (`@agora/kcb-client`) |

## Discovery in one minute

The registry is an index of KCB manifests that answers with **addresses**. Nothing flows
through it — the caller dials what it gets back (ADR-0001 decisions 3-4).

```ts
import { createRegistry, registerProviderRouter } from '@agora/registry';

const registry = createRegistry();
await registerProviderRouter(registry, 'http://127.0.0.1:8000'); // crawls /.well-known/kcb-manifest.json

registry.find({ capability: 'generate.text' }); // → [{ address, capabilities: [{ endpoint, estUnits, tier }] }]
registry.find({ produces: { mediaType: 'audio/wav' }, world: 'alderforest' });
registry.path({ from: { entityType: 'mood' }, to: { mediaType: 'audio/wav' } });
```

`find` ranks zero-cost routes first and *unpriced* ones last (unknown is not free, KCB §3
delta K); `path` chains capabilities across planes and providers and returns the plan plus its
projected cost, so a caller can gate spend before invoking anything.

## Stack

**Polyglot, by decision — not by accident.** Two toolchains, one gate.

- **`provider-router` is Python** (3.11+, uv, FastAPI, pytest/ruff/mypy). It is a *port* of
  Analyzer's sacred ladder (`~/Development/analyzer`, `src/filmstudio/core/ladders.py`), and Analyzer —
  along with most of the model-backend ecosystem it talks to (mlx-serve, Ollama clients) — is
  Python. Porting it into TypeScript would mean re-deriving tier-resolution behaviour that
  already exists and is trusted, in a language with worse coverage of the backends it dials.
- **Everything else is TypeScript** (Node 22, npm workspaces, React 19 + Vite for the console,
  vitest, ESLint, `tsc --noEmit`). The registry, resolver, client libs and console are web-stack
  surfaces the rest of the ecosystem consumes from TS/React, so TS keeps them one language away
  from their callers and lets the console import the registry's types directly.
- **The split is safe because ADR-0001 makes language internal.** The provider-router is a
  *service over the wire* (OpenAI-compatible HTTP + a KCB manifest), never an imported library —
  so Analyzer (Python) and Orchestrator (TS) both just call it. Nothing in the commons is shared as
  source across the language boundary. The one thing that *must* agree — the koine spec versions
  — is pinned in `schemas/src/versions.ts` and asserted against the Python constant by the router's
  own test suite, so drift fails a gate instead of failing in production.

The TypeScript areas are a **source-first workspace**: each package's `exports` points at
`src/index.ts` and `tsc` emits nothing, so there is no cross-package build ordering. The
console's Vite bundle and the router's wheel are the only build artifacts (`make build`).

## Quality gates

Run everything (this is what CI runs, and what `.chief/verify.sh` runs):

```sh
make install    # uv sync + npm install
make check      # every area's gate
```

Per area, when a change touches only one:

| Area | Gate |
|---|---|
| `provider-router/` | `make check-provider-router` — `ruff check` + `ruff format --check` + `mypy` + `pytest` |
| `schemas/` | `make check-schemas` |
| `clients/*` | `make check-clients` |
| `registry/` | `make check-registry` |
| `resolver/` | `make check-resolver` |
| `console/` | `make check-console` |

Each TypeScript gate is `eslint` + `tsc -p tsconfig.json` (typecheck) + `vitest run`. `make help`
lists every target; `make build` produces the console bundle and the router wheel; `make fmt`
auto-formats the Python area.

## The contracts

Everything here implements a koine spec. Read those first:

- Identity — `../koine/specs/identity.md` (KINP)
- Knowledge — `../koine/specs/grounding-pack.md` (KGP)
- Control plane — `../koine/specs/capability-bus.md` (KCB)
- Media — `../koine/specs/media-interchange.md` (KMI)
- Conformance scenarios — `../koine/specs/conformance-scenario.md` (KCS)
- Topology decision — `../koine/decisions/ADR-0001-control-plane-topology.md`

## Status

**Bootstrapping.** The repo is being stood up by the Chief harness from
[`tasks/chief/10-agora-bootstrap.json`](tasks/chief/10-agora-bootstrap.json). Landed: the
skeleton, stack, layout and gates (US-AG1); the sacred-ladder port (US-AG2); cost/budget
enforcement + the router's KCB manifest (US-AG3); the discovery registry, its capability-path
search and the resolver interface stub (US-AG4). Next: the console's first end-to-end scenario
(US-AG5).
