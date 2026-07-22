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
| `clients/*` | TypeScript | shared protocol client libraries (`@agora/kcb-client`, `@agora/relation-registry-client`) |

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

## Conformance in one minute

The console runs a **KCS scenario** (`../koine/specs/conformance-scenario.md`) — a declarative
script that discovers participants by KINP identity, opens **direct** links to them, records
every exchange into an observation log, and evaluates the §5 cross-plane assertions against
that log. A green scenario proves the real protocol, because there is no console-flavoured
envelope in between (ADR-0001 decision 7).

```ts
// console/src/
import { runConformance } from './commons.ts';
import { PROVIDER_ROUTER_ROUNDTRIP } from './scenarios/provider-router-roundtrip.ts';

const { report } = await runConformance(PROVIDER_ROUTER_ROUNDTRIP);
report.green; // every step passed and every assertion held
```

`npm run dev -w @agora/console` renders the same run: the tier that served each call, what it
cost, every assertion's verdict, and the log beneath it.

**The scenarios that ship:**

| Scenario | From | What it proves |
|---|---|---|
| `kcs:provider-router-roundtrip` | the commons itself | discover the provider-router through the registry, dial its own address, ask for a completion with a ceiling of **zero** budget units, and assert the zero-spend tier served it for nothing (`tier_resolved`, `cost_within_ceiling`, `capability_path_exists`, `always_completes`) |
| `kcs:worlds-to-fabric` | [`../koine/scenarios/e2e-worlds-to-fabric.md`](../koine/scenarios/e2e-worlds-to-fabric.md) | the identity firewall across the media→knowledge bridge: an Insimul fiction → Analyzer ingest → Pinakes reconcile → cross-project queries, asserting that facts-about-the-real-Napoleon return nothing from the fiction (`firewall_holds`), that every claim is world-scoped (`claim_in_world`), and that cross-world lineage stays `based_on` (`no_sameas_across_worlds`) |

Insimul, Analyzer and Pinakes have published no manifest yet, so `kcs:worlds-to-fabric` runs
them as `standin` participants (KCS delta N) and its report says `stubbed`. The runner
prefers a live registration over a fixture, so adoption deletes fixtures rather than
rewriting the scenario.

**The next scenario to add** is the other hand-written pressure test, which KCS §6 names
alongside it:

| Scenario | From | What it needs next |
|---|---|---|
| `kcs:media-transform` | [`../koine/scenarios/e2e-media-transform.md`](../koine/scenarios/e2e-media-transform.md) | encoding the four-project transform chain, and a cross-plane `capability_path_exists` over more than one indexed provider |

The runtime they need is in place: every §3 step kind executes (`fetch` is a CAS GET by
asset id, `subscribe` reads a delta stream, `emit` writes a pack), `standin` participants
(delta N) let a scenario name a peer that has not adopted the bus, and every §5 predicate
in `console/src/kcs/assertions.ts` has an evaluator. A predicate a future KCS revision adds
still reports as *pending*, which never counts as a pass — a scenario asserting something
this build cannot check goes red rather than green-by-omission.

Assertions are evaluated over **plane-typed observations, never generated text** (§7 Q2):
a claim counts when a peer stated it as a KGP assertion, not when a model described it.

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

### The relation registry

The shared relation vocabulary (`../koine/registry/relations.tsv` + `relations/<domain>.tsv`)
and its bridge-mapping layer (`../koine/registry/predicate-mapping.json`) are **data, and they
live in koine**. agora holds the tooling — the schema, validator and loader — and never a
vendored copy; a copy would be the second source of truth the registry exists to prevent. The
`registryVersion` this build speaks, and the paths it speaks it at, are pinned in
`RELATION_REGISTRY` (`schemas/src/relation-registry.ts`), the same way the spec versions are.
The one copy in this repo is `schemas/src/fixtures/koine-registry/` — a snapshot the validator's
tests run against, because a validator tested only on hand-written samples proves only that it
accepts hand-written samples. It is reachable as `@agora/schemas/fixtures`, never from the
library surface, and a test asserts its `registryVersion` is the one this build claims to speak,
so it cannot quietly go stale.

The bridge layer covers both bridged projects — **analyzer** (as lifted) and **insimul** (added at
registryVersion 0.4.0), each mapping its own predicates onto the canonical vocabulary that
**pinakes** hosts. pinakes is therefore the canonical *side*, not a bridged project, which is
why `RELATION_REGISTRY.bridgedProjects` excludes it.

A registry entry classifies a relation on **three orthogonal axes**, modelled in
`schemas/src/axes.ts`: its **dialect** tier (KGP §5 — what logic a consumer may evaluate:
`grounding-only` ⊂ `horn-safe` ⊂ `full-prolog`), its **egress** class (§7.2 — whether it may
leave its tier at all: `exportable` or `local-only`) and, on provenance records rather than the
registry, its **trust** tier (curated / synthetic / personal — descriptive, never enforcing).
`local-only` is an egress class, *not* a fourth dialect tier; registryVersion 0.3.0 split the
one key that used to bundle them.

Egress is the axis with teeth, and agora enforces it in both directions (§7.2):
`filterPackForEgress` drops `local-only` records at pack construction — the **producer's**
obligation, never delegated — and `assertPackEgress` lets a **consumer** reject a pack that
still carries some, reporting every violation instead of silently dropping the records.

#### Reading it

`parseRegistry` / `parseVocabulary` (`schemas/src/registry-schema.ts`) validate the two
artifacts, and `assertRelationsResolve` cross-checks them: a mapping that crosses as a claim
must *name* a relation the TSVs declare, and one that does not must name none — that rule is
what keeps the two files one vocabulary. `assertSignatureStability` diffs two registry versions
and rejects an edit that moved a published `relation · arity · arg_roles · symmetric`, because
that silently re-hashes every claim id derived from it (KGP §3); a change means a new name.

`@agora/relation-registry-client` is what a consumer actually calls:

```ts
const registry = await loadRelationRegistry('https://koine.example');
registry.signature('soc:parent_of');      // 'soc:parent_of · 2 · parent|child · false'
const analyzer = registry.egressFor('analyzer'); // predicate → KGP §7.2 class
filterPackForEgress(pack, analyzer);          // …which is what the producer filter takes
```

It fetches `predicate-mapping.json`, follows it to the vocabulary files it names, validates
both, and indexes them. It never writes and never mirrors — a cached copy belongs to the
caller, and a caller that edits one has forked the registry.

## Status

**Bootstrapping.** The repo is being stood up by the Chief harness from
[`tasks/chief/10-agora-bootstrap.json`](tasks/chief/10-agora-bootstrap.json). Landed: the
skeleton, stack, layout and gates (US-AG1); the sacred-ladder port (US-AG2); cost/budget
enforcement + the router's KCB manifest (US-AG3); the discovery registry, its capability-path
search and the resolver interface stub (US-AG4); the conformance console — the KCS scenario
model, runner and UI, running `kcs:provider-router-roundtrip` end to end (US-AG5). Next: encode
the two pressure tests as scenarios, which is what pulls in the `fetch`/`emit`/`subscribe` steps
and the identity/knowledge/media assertions.
