# agora — design notes

Rationale and architecture behind the runtime commons. The [`README.md`](README.md) is the
guide; this document is the *why*. It records the decisions that shaped the code — the
provider-router architecture, the polyglot stack, and the design of the registry, resolver and
relation-registry surfaces — so the README can stay short.

## Decision records

agora continues [`koine`](https://github.com/danieldekerlegand/koine)'s ADR numbering, but only one ADR lives in koine:

- **ADR-0001 — control-plane topology** — [`koine/decisions/ADR-0001-control-plane-topology.md`](https://github.com/danieldekerlegand/koine/blob/main/decisions/ADR-0001-control-plane-topology.md).
  The decision that created this repo: a thin shared commons, direct-dial peers, a registry that
  returns *addresses* and never proxies traffic. Everything below is downstream of it.
- **The deployment-history ADRs (ADR-0002 / 0003 / 0004)** — bridge reconciliation, contract-layer
  consolidation, and the **Erlang provider-router** — were moved to the **private integration
  repo**, which continues koine's numbering. They are deliberately *not* in koine, so there is no
  public file to link. A citation of `ADR-000N` for N ≥ 2 refers to a document held there.

## The provider-router

The provider-router is a language-agnostic, OpenAI-compatible model gateway. It implements the
**sacred ladder** — paid → mlx-serve → local → placeholder, per modality — with cost estimation
and budget-ceiling enforcement, and it is the first concrete implementation of the KCB
`cost`/grant model. It is a *leaf capability*, not an inter-participant router: a service reached
over the wire (OpenAI-compatible HTTP + a KCB manifest), never an imported library.

### Erlang is the canonical implementation

The router's whole promise is **"always completes"**. That shape is a supervision tree with a
permanent terminal child (the placeholder tier), and the KCB subscribe fan-out to many
soft-realtime consumers is one cheap process each — Erlang/OTP's home ground. The canonical
implementation is therefore `provider-router-erl/` (Erlang/OTP, cowboy), which dials native-wire
vendors through the Rust translator.

Language is *internal* to the commons (ADR-0001): the router is consumed over the wire, so a
Python caller and a TypeScript caller both just call it, and the choice of a third toolchain
costs nothing to any caller.

### The Python router is the executable specification

`provider-router/` (Python, FastAPI) is the extraction that *defined* the router's external
contract. It stays in the tree as the specification the Erlang app is judged against, byte for
byte:

- `provider-router-erl/test/apr_conformance_SUITE.erl` replays a corpus captured from the Python
  app itself (`test/apr_conformance_SUITE_data/python-surface.json`, regenerated with
  `capture_python_surface.py`) and asserts every answer is **the same bytes** — all five
  generation routes, `/health`, `/doctor`, `/v1/models`, `/v1/providers`, the AgentCard, and the
  308 off the legacy manifest path, in both a bare and a keyed configuration.
- It satisfies the same `console/src/fixtures/provider-router.session.json` capture the console
  replays, and pins its `kcb_version` to `schemas/src/versions.ts` the way the Python
  `test_skeleton.py` does.

A change to the router's external contract lands in **both** implementations or in neither, and
both stay gated by `make check` (`make check-router-erl` and `make check-provider-router`). When
deployments have fully moved to the Erlang app — same image contract, same `AGORA_*` environment,
nothing on the wire changes — the Python area can be retired to its own repository, and the
already-captured conformance corpus becomes the frozen record of the contract.

## The polyglot stack

Two toolchains plus Erlang, one gate. The split is safe **because ADR-0001 makes language
internal** — nothing in the commons is shared as source across a language boundary; everything is
a service over the wire. The one thing that *must* agree, the koine spec versions, is pinned in
`schemas/src/versions.ts` and asserted against the Python constant (`test_skeleton.py`) and the
Erlang one (`apr_conformance_SUITE`), so drift fails a gate instead of failing in production.

- **`provider-router/` is Python** (3.11+, uv, FastAPI). It is a port of a pre-existing,
  in-production sacred-ladder implementation, and most of the model-backend ecosystem it dials
  (mlx-serve, Ollama clients) is Python too.
- **`provider-router-erl/` is Erlang/OTP** (26+, rebar3, cowboy) — the canonical router, for the
  supervision-tree reasons above.
- **`trainer/` is Python** (same toolchain) — the general KFT `finetune` capability, distinct from
  the provider-router (two providers, never merged; ADR-0001 §1). It imports nothing from the
  router.
- **Everything else is TypeScript** (Node 22, npm workspaces, React 19 + Vite for the console).
  The registry, resolver, client libs and console are web-stack surfaces callers consume from
  TS/React, so TS keeps them one language away from those callers and lets the console import the
  registry's types directly.

The TypeScript areas are a **source-first workspace**: each package's `exports` points at
`src/index.ts` and `tsc` emits nothing, so there is no cross-package build ordering. The console's
Vite bundle and the router's wheel are the only build artifacts (`make build`).

## Training is multi-provider

`trainer/` is the **general** `finetune` provider only (KFT §9, FT-K). Training is multi-provider:
a project with its own corpus runs its own **specialized** `finetune` provider on the bus (never
an adapter inside agora), and the registry disambiguates between them (`registry/src/select.ts` —
prefer the more specialized, then lower cost, surface an unbroken tie). The specialized providers
and the clients that call them are each project's own work, not built here; see
[`trainer/README.md`](trainer/README.md) §"Scope boundary".

## The relation registry

The shared relation vocabulary (`../koine/registry/relations.tsv` + `relations/<domain>.tsv`) and
its bridge-mapping layer (`../koine/registry/predicate-mapping.json`) are **data, and they live in
koine**. agora holds the tooling — the schema, validator and loader — and never a vendored copy; a
copy would be the second source of truth the registry exists to prevent. The `registryVersion`
this build speaks, and the paths it speaks it at, are pinned in `RELATION_REGISTRY`
(`schemas/src/relation-registry.ts`). The only copy in this repo is the test snapshot under
`schemas/src/fixtures/koine-registry/` — reachable as `@agora/schemas/fixtures`, never from the
library surface — with a test asserting its `registryVersion` matches, so it cannot go stale.

**The cast is the registry's data, not agora's.** A loaded document declares its own canonical
host (`canonicalProject`) and bridged projects (the keys of its `projects` block,
`bridgedProjectsOf`); the validator checks the declaration is well-formed and self-consistent,
never that it matches a set pinned in this build. A registry naming projects agora has never heard
of loads unchanged.

**Three orthogonal axes** classify a relation (`schemas/src/axes.ts`): its **dialect** tier
(KGP §5 — `grounding-only` ⊂ `horn-safe` ⊂ `full-prolog`), its **egress** class (§7.2 —
`exportable` or `local-only`), and, on provenance records, its **trust** tier (curated /
synthetic / personal). Egress is the axis with teeth, enforced in both directions:
`filterPackForEgress` drops `local-only` records at pack construction (the producer's obligation),
and `assertPackEgress` lets a consumer reject a pack that still carries some.

`parseRegistry` / `parseVocabulary` (`schemas/src/registry-schema.ts`) validate the two artifacts;
`assertRelationsResolve` cross-checks that a mapping crossing as a claim names a declared relation;
`assertSignatureStability` rejects an edit that moved a published
`relation · arity · arg_roles · symmetric`, because that silently re-hashes every claim id derived
from it (KGP §3). `@agora/relation-registry-client` fetches `predicate-mapping.json`, follows it to
the vocabulary files, validates and indexes them — and never writes or mirrors.

## The resolver

`resolver/` implements KINP §8's two verbs against a deployment's **resolution authority** — the
single canonical store for real-world entities (§11 decision 1). Which store that is, is
configuration: an address the registry handed back.

- `resolve` computes the merged view rather than storing it (§4.1), and **the walk never crosses a
  `based_on` edge** — that one rule is the identity firewall (§4.3). A fictional entity that is
  `same_as` a locally-extracted entity and `based_on` a real-world one resolves to the local entity
  and stops.
- `reconcile` takes the OpenRefine/Wikidata Reconciliation query verbatim (§4.5), then decides
  which relation to apply (different worlds that do not inherit identity ⇒ `based_on`) and whether
  to apply it (auto-apply above a per-world confidence threshold, queue anything below-threshold,
  ambiguous, or high-impact; §11 decision 2). Queued proposals land on `resolver.reviewQueue` and
  nothing there has been asserted.

Authority is a role, not a hard dependency: content-hash ids (claims, assets; §6) resolve without
dialing anyone, an unknown id resolves to itself, and a failed dial falls back to the local cache —
labelled `cache`, never as the authority itself.

## The conformance console

The console runs a **KCS scenario** (`../koine/specs/conformance-scenario.md`): a declarative
script that discovers participants by KINP identity, opens **direct** links to them, records every
exchange into an observation log, and evaluates the §5 cross-plane assertions against that log. A
green scenario proves the real protocol, because there is no console-flavoured envelope in between
(ADR-0001 decision 7). Every report is **content-addressed and archivable** (KCS §4.4) — the
address covers the scenario, participants, every verdict and the log, and excludes wall-clock time,
so a re-run over the same fabric dedups and an id that *moved* is itself the finding.

`npm run dev -w @agora/console` puts a UI on the same runtime, in three panels:

1. **Scenario library** — a run button per scenario, then its verdict and content address, the
   tier that served each call and what it cost, and every assertion's verdict with supporting log
   entries.
2. **Capability explorer** — browse what the registry advertises, compose a request from a
   schema-generated form, and send it. There is no second client behind it: a manual request
   compiles into a one-step scenario through the same `runConformance`.
3. **Fabric monitor** — a *passive* watch that subscribes (KCB §4) to provider streams and renders
   a live feed. Decision 7 bounds it: an observer may register as a consumer but may not read the
   wire between two other peers. So the **data plane is covered today** while the **control plane
   is visible only where a provider emits exchange telemetry** — the monitor says so per source.
   An emitted-telemetry contract (a KCB observability extension) is the koine follow-up;
   `console/src/kcs/spans.ts` is agora's provisional reader.

**The scenarios that ship are illustrative, not normative.** The runner knows nothing about any
particular cast — a scenario names its participants by KINP identity, and you write your own
against your own peers.

| Scenario | What it proves |
|---|---|
| `kcs:provider-router-roundtrip` | discover the provider-router through the registry, dial its own address, ask for a completion with a **zero**-unit budget ceiling, and assert the zero-spend tier served it for nothing (`tier_resolved`, `cost_within_ceiling`, `capability_path_exists`, `always_completes`) |
| `kcs:sample-pipeline` (neutral sample) | the identity firewall across a media→knowledge bridge over three generic peers — a `producer` publishes a world-scoped claim + a `based_on` link, a `processor` extracts knowledge from a recording, a `curator` reconciles both — asserting facts about the baseline entity stay out of the scoped world (`firewall_holds`, `claim_in_world`, `no_sameas_across_worlds`) |

A deployment's *real* conformance scenarios — its participants, worlds and fixtures — live in the
private integration repo under `scenarios/`, and run against this same runner unchanged.

### Runtime notes

Every §3 step kind executes (`fetch` = CAS GET by asset id, `subscribe` reads a delta stream,
`emit` writes a pack); `standin` participants (KCS delta N) let a scenario name a peer that has not
adopted the bus, indexing any carried `manifest` into a **scenario-local** index thrown away with
the run (writing it into the registry would hand out an address nobody serves). A live registration
always wins over a fixture, so adoption deletes fixtures rather than rewriting a scenario. Every §5
predicate in `console/src/kcs/assertions.ts` has an evaluator; a predicate a future KCS revision
adds reports as *pending*, which never counts as a pass. Assertions are evaluated over
**plane-typed observations, never generated text** (§7 Q2): a claim counts when a peer stated it as
a KGP assertion, not when a model described it.

One known gap is KCS's, not this console's: KMI delta I gives every NLE projection an
asset-id ↔ path media map, and §5 has no predicate to read one. A `media_map_complete(projection)`
predicate is the koine follow-up.
