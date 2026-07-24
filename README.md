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
  router. **The canonical implementation is `provider-router-erl/` (Erlang/OTP, agora:80);
  `provider-router/` (Python, agora:50) is superseded** — see "The provider-router
  supersession" below.
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
| `provider-router-erl/` | Erlang/OTP (rebar3) | **the** model-backend gateway — the sacred ladder as a supervision tree (agora:80, ADR-0004) |
| `provider-router/` | Python (uv) | the same gateway, superseded — the contract of record it was extracted from (agora:50) |
| `trainer/` | Python (uv) | the general KFT `finetune` capability — GPU fine-tuning jobs (separate from the provider-router, ADR-0001 §1) |
| `registry/` | TypeScript | the thin KCB discovery registry |
| `resolver/` | TypeScript | the KINP resolver reference implementation |
| `console/` | TypeScript + React | the conformance console (scenario runner + UI) |
| `schemas/` | TypeScript | shared koine manifest schemas / protocol types |
| `clients/*` | TypeScript | shared protocol client libraries (`@agora/kcb-client`, `@agora/relation-registry-client`) |

`trainer/` is the **general** `finetune` provider **only** (KFT §9, FT-K). Training is
multi-provider: Pinakes runs its own **specialized** `finetune` provider on the bus (not an adapter
inside agora), and the registry disambiguates between them (`registry/src/select.ts` — prefer the
more specialized, then lower cost, surface an unbroken tie). Three runtime follow-ups are handed to
their own repos and **not built here** — Pinakes's specialized provider (`pinakes:90-finetune-provider`),
Orchestrator's KCB client replacing `Runner::Stub` (`orchestrator:90-finetune-client`), and the
finetune-job validator CI (`agora:41-finetune-job-validator`); see `trainer/README.md` and the koine
program map (`../koine/tasks/chief/README.md`, Tranche D).

## The provider-router supersession (ADR-0004)

There are two provider-routers in this tree, and that is deliberate but temporary.
`provider-router-erl/` (Erlang/OTP) is **canonical**: the sacred ladder as a supervision tree,
with the KCB subscribe fan-out as BEAM processes and native-wire vendors dialed through the
Rust translator. `provider-router/` (Python) is **superseded**: it is the extraction that
defined the contract, and it stays in the tree as the executable specification the Erlang app
is judged against.

*Judged* is literal. `provider-router-erl/test/apr_conformance_SUITE.erl` replays a corpus
captured from the Python app itself
(`test/apr_conformance_SUITE_data/python-surface.json` — regenerate with the command in
`capture_python_surface.py`) and asserts every answer is **the same bytes**: all five
generation routes, `/health`, `/doctor`, `/v1/models`, `/v1/providers`, the AgentCard and the
308 off the legacy manifest path, in a bare and a keyed configuration. It satisfies the same
`console/src/fixtures/provider-router.session.json` capture the console replays, and pins its
`kcb_version` to `schemas/src/versions.ts` the way `test_skeleton.py` pins Python's.

The cutover:

1. **Now** — both build, both gated by `make check`; `make check-router-erl` is the router's
   gate. A deployment may run either; they answer identically.
2. **Next** — deployments move to the Erlang app (same image contract: an HTTP port, the same
   `AGORA_*` environment). Nothing that dials the router changes, because nothing about the
   wire changes.
3. **Then** — `provider-router/` is retired to its own repository or deleted, and the
   conformance corpus (already captured) becomes the frozen record of the contract. Until that
   step the Python suite stays green: a change to the contract lands in both, or it lands in
   neither.

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

const { report, archive } = await runConformance(PROVIDER_ROUTER_ROUNDTRIP);
report.green;         // every step passed and every assertion held
archive.report_id;    // sha256-… — the same run observed again mints the same id
```

Every report is **content-addressed and archivable** (KCS §4.4): the address covers the
scenario, the participants, every step and assertion verdict and the observation log, and
excludes wall-clock time and durations — the same split KGP §3.1 makes for a claim. So a
re-run that saw the same fabric dedups, an id that *moved* is itself the finding, and
`verifyArchive` catches an archive whose verdict was edited after the fact.

`npm run dev -w @agora/console` is the same runtime with a UI on it: the **scenario library**
with a run button per scenario, then that run's verdict and content address, the tier that
served each call and what it cost, every assertion's verdict with the log entries supporting
it, and the observation timeline beneath.

Its second panel is the **capability explorer** — browse what the registry advertises (per
provider, plane-typed ports, address, projected cost), compose a request from a form the port
schema generated, and send it. There is no second client behind it: a manual request compiles
into a one-step scenario and goes through the same `runConformance`, so it is discovered,
dialed and logged exactly as an authored scenario is.

**The scenarios that ship:**

| Scenario | From | What it proves |
|---|---|---|
| `kcs:provider-router-roundtrip` | the commons itself | discover the provider-router through the registry, dial its own address, ask for a completion with a ceiling of **zero** budget units, and assert the zero-spend tier served it for nothing (`tier_resolved`, `cost_within_ceiling`, `capability_path_exists`, `always_completes`) |
| `kcs:worlds-to-fabric` | [`../koine/scenarios/e2e-worlds-to-fabric.md`](../koine/scenarios/e2e-worlds-to-fabric.md) | the identity firewall across the media→knowledge bridge: an Insimul fiction → Analyzer ingest → Pinakes reconcile → cross-project queries, asserting that facts-about-the-real-Napoleon return nothing from the fiction (`firewall_holds`), that every claim is world-scoped (`claim_in_world`), and that cross-world lineage stays `based_on` (`no_sameas_across_worlds`) |
| `kcs:media-transform` | [`../koine/scenarios/e2e-media-transform.md`](../koine/scenarios/e2e-media-transform.md) | the four-project transform chain: an Insimul playthrough → Analyzer cut + narration → a Composer score → EDL → a DaVinci projection, asserting that a route across planes is plannable before anything is dialed (`capability_path_exists`), that generated assets declare no world while ingested ones do (`source_world_is`), that the one paid hop stayed inside its grant (`cost_within_ceiling`), and that analysis of a *generated composite* is still attributed to its footage's world (`analysis_attributed_to_constituent`) |

None of Insimul, Analyzer, Composer or Pinakes has published a manifest yet, so both scenarios
run them as `standin` participants (KCS delta N) and their reports say `stubbed`. A stand-in
fixture may also carry the **`manifest`** its peer has not published: a provider off the bus
is missing from the *control* plane too, and `capability_path_exists` would otherwise have
nothing to plan over. The runner indexes those manifests into a **scenario-local** index
that is thrown away with the run — writing them into the registry peers query would hand out
an address nobody serves. A live registration still wins over a fixture, so adoption deletes
fixtures rather than rewriting a scenario.

The runtime under them: every §3 step kind executes (`fetch` is a CAS GET by asset id,
`subscribe` reads a delta stream, `emit` writes a pack), `standin` participants (delta N)
let a scenario name a peer that has not adopted the bus, and every §5 predicate in
`console/src/kcs/assertions.ts` has an evaluator. A predicate a future KCS revision adds
still reports as *pending*, which never counts as a pass — a scenario asserting something
this build cannot check goes red rather than green-by-omission.

**One gap is KCS's, not this console's.** KMI delta I gives every NLE projection an
asset-id ↔ path media map, and §5 has no predicate that can read one — so
`kcs:media-transform` carries the map into its observation log and nothing checks it. A
`media_map_complete(projection)` predicate is the koine follow-up.

Assertions are evaluated over **plane-typed observations, never generated text** (§7 Q2):
a claim counts when a peer stated it as a KGP assertion, not when a model described it.

**The third panel drives nothing.** The console's *fabric monitor* is a passive watch: it
subscribes (KCB §4) to the streams providers publish and renders a filterable live feed of what
crosses the commons, whether or not this console caused it. Decision 7 is what bounds it — a
passive observer may register as a consumer, but may not read the wire between two other peers,
which is the payload-aware proxy the topology exists to avoid. So the **data plane is covered
today** (every delta and media event a producer publishes reaches the feed) while the **control
plane is visible only where a provider *emits* exchange telemetry**; a provider that emits none
is absent at the invoke level, and the monitor says so per source. Closing that is a koine
follow-up — an emitted-telemetry contract (a KCB observability extension) fixing the span shape.
`console/src/kcs/spans.ts` is agora's provisional reader for it.

## Stack

**Polyglot, by decision — not by accident.** Two toolchains, one gate.

- **`provider-router` is Python** (3.11+, uv, FastAPI, pytest/ruff/mypy). It is a *port* of
  Analyzer's sacred ladder (`~/Development/analyzer`, `src/filmstudio/core/ladders.py`), and Analyzer —
  along with most of the model-backend ecosystem it talks to (mlx-serve, Ollama clients) — is
  Python. Porting it into TypeScript would mean re-deriving tier-resolution behaviour that
  already exists and is trusted, in a language with worse coverage of the backends it dials.
- **`provider-router-erl` is Erlang/OTP** (26+, rebar3, cowboy, dialyzer/eunit/ct) and is now
  the canonical router (ADR-0004). A ladder whose whole promise is "always completes" is a
  supervision tree with a permanent terminal child; a fan-out to many soft-realtime consumers
  is one cheap process each. That is the language's home ground, and it is reachable *because*
  language is internal — the third toolchain costs nothing to any caller.
- **Everything else is TypeScript** (Node 22, npm workspaces, React 19 + Vite for the console,
  vitest, ESLint, `tsc --noEmit`). The registry, resolver, client libs and console are web-stack
  surfaces the rest of the ecosystem consumes from TS/React, so TS keeps them one language away
  from their callers and lets the console import the registry's types directly.
- **The split is safe because ADR-0001 makes language internal.** The provider-router is a
  *service over the wire* (OpenAI-compatible HTTP + a KCB manifest), never an imported library —
  so Analyzer (Python) and Orchestrator (TS) both just call it. Nothing in the commons is shared as
  source across the language boundary — which is exactly why the router could be re-implemented
  in a third language without a single caller noticing. The one thing that *must* agree — the
  koine spec versions — is pinned in `schemas/src/versions.ts` and asserted against the Python
  constant (`test_skeleton.py`) and the Erlang one (`apr_conformance_SUITE`), so drift fails a
  gate instead of failing in production.

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
| `provider-router-erl/` | `make check-router-erl` — `rebar3 compile` + `dialyzer` + `eunit` + `ct`. **The router's gate** (agora:80 / ADR-0004), including the byte-for-byte conformance suite; skips cleanly when the Erlang toolchain is absent |
| `provider-router/` | `make check-provider-router` — `ruff check` + `ruff format --check` + `mypy` + `pytest` (the superseded Python router, kept green until the cutover completes) |
| `trainer/` | `make check-trainer` — `ruff check` + `ruff format --check` + `mypy` + `pytest` |
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

### The resolver

`resolver/` implements KINP §8's two verbs against Pinakes, the single canonical authority for
real-world entities (§11 decision 1):

```ts
const resolver = createPinakesResolver({ endpoint });   // the address the registry handed back
await resolver.resolve({ id: 'insimul:world:alderforest:ent:npc-renaud' });
await resolver.reconcile({ query: 'Renaud', of: 'analyzer:ent:e-8842', world: 'insimul:world:alderforest' });
```

`resolve` computes the merged view rather than storing it (§4.1), and **the walk never crosses
a `based_on` edge** — that one rule is the firewall (§4.3). The fictional general is `same_as`
the Analyzer local extracted from the footage and `based_on` the real Napoleon, so resolving him
returns the local and stops: Wikidata's Napoleon is two `same_as` hops away and both queries
stay clean, out of one graph.

`reconcile` takes the OpenRefine/Wikidata Reconciliation query verbatim (§4.5) so Pinakes's
Wikidata backbone answers it directly, then decides two things about the top candidate: which
relation (§4.5 — different worlds that do not inherit identity ⇒ `based_on`; a candidate
already reachable through `based_on` is never promoted by transitivity) and whether to apply it
(§11 decision 2 — auto-apply above a per-world confidence threshold, queue anything
below-threshold, ambiguous, or high-impact). Queued proposals land on `resolver.reviewQueue`
and nothing there has been asserted.

Authority is a role, not a hard dependency: ids that never round-trip (claims and assets are
content hashes, §6) are answered without dialing anybody, an id the authority has never heard
of resolves to itself, and a dial that fails falls back to the local cache — labelled `cache`,
never `pinakes`, because "Pinakes says so" and "Pinakes said so once" license different writes.

## Status

**Bootstrapping.** The repo is being stood up by the Chief harness from
[`tasks/chief/10-agora-bootstrap.json`](tasks/chief/10-agora-bootstrap.json). Landed: the
skeleton, stack, layout and gates (US-AG1); the sacred-ladder port (US-AG2); cost/budget
enforcement + the router's KCB manifest (US-AG3); the discovery registry, its capability-path
search and the resolver interface stub (US-AG4); the conformance console — the KCS scenario
model, runner and UI, running `kcs:provider-router-roundtrip` end to end (US-AG5).

From [`tasks/chief/30-agora-console-scenarios.json`](tasks/chief/30-agora-console-scenarios.json):
the KCS runner and its cross-plane assertion vocabulary (US-CS1); both koine pressure tests
encoded as runnable scenarios — `kcs:worlds-to-fabric` (US-CS2) and `kcs:media-transform`
(US-CS3); the full KINP resolver dialing the Pinakes authority (US-CS4); the content-addressed
conformance report and the scenario-library UI (US-CS5); the manual capability explorer
(US-CS6). Next: the passive live fabric monitor.
