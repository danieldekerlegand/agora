# agora — Roadmap

> The **runtime commons** of the neuro-symbolic fabric: reference implementations of koine's
> interchange contracts — a model gateway, a discovery registry, an identity resolver, a
> knowledge-sync bridge, a translation engine, a conformance console, and a general trainer —
> that any koine-conformant system can run, self-host, or judge itself against. North star:
> *koine specifies, agora implements* — a thin shared commons where peers discover by capability
> and dial each other directly.

**Status:** Core surfaces implemented & gated (Chief bands `10`–`40` merged, 4/4); Erlang-router cutover and telemetry follow-ups in progress, with a mined "second act" (Phases A–H below) proposed and a **verified-defect closure pass (Phase B2)** authored · **Last updated:** 2026-08-11

This is the single canonical roadmap for agora. It is the first consolidated roadmap for the
repo, synthesized from the README, `DESIGN.md`, `CLAUDE.md`, the `docs/` decision records, and the
four completed Chief tasklists. Component-level detail stays in each area's `README.md` and in the
reference docs linked below.

---

## Vision & Scope

agora is the **runtime half** of the koine/agora split: koine is specification-only (contracts +
ADRs, no code), and agora is where those contracts become running services. It exists so that *N*
AI systems avoid the *N²* problem — instead of hand-wiring a bridge between every pair, each
participant learns *one* set of conventions, advertises a capability manifest, and is discovered
and dialed directly.

The organizing principles (all downstream of koine **ADR-0001**):

- **Addresses, not proxies.** The registry is a phone book, not a switchboard; traffic never flows
  through agora.
- **Capability, never caller.** Nothing in the tree names a project as a literal — a participant is
  whatever publishes a KCB manifest; the cast is learned at runtime from data.
- **Always completes.** The provider-router's fallback ladder ends in a deterministic zero-spend
  tier, so a fresh install answers immediately and spends nothing.
- **Proof over promises.** The conformance console asserts guarantees against the *real*
  connections between services.

**In scope:** reference runtimes for the koine contracts (KINP · KGP · KCB · KMI · KCS · KFT), the
shared schemas/SDK, and the build-vs-adopt integrations that keep those runtimes standing on
established tools (LiteLLM, OpenTimelineIO, the W3C Reconciliation API). **Out of scope:** the
contracts themselves (they live in koine — propose changes there, never fork a copy) and any
project-specific, specialized provider (those run in each project's own repo and join the bus).

## Current State

Every component named in the README ships as a buildable unit with its own quality gate, wired
into `make check` (what CI runs):

- **provider-router** — the OpenAI-compatible model gateway implementing the "sacred ladder"
  (paid → mlx-serve → local → deterministic placeholder), per modality, with cost estimation and
  budget-ceiling enforcement. **Two implementations, one contract:** `provider-router-erl/`
  (Erlang/OTP, cowboy) is the **canonical** deploy target (ADR-0004); `provider-router/` (Python,
  FastAPI) stays in the tree as the **executable specification** the Erlang app is judged against
  byte-for-byte (`apr_conformance_SUITE.erl`).
- **discovery registry** (`registry/`, TS) — KCB `find`-returns-an-**address**, cost-ranked,
  cross-plane path-finding; never relays traffic.
- **identity resolver** (`resolver/`, TS) — KINP `resolve` (firewall-aware merge, never crosses
  `based_on`) + `reconcile` (W3C Reconciliation API + auto-apply/review-queue policy).
- **knowledge sync** (`knowledge/`, TS) — the KGP data-plane bridge: admit any producer's claims,
  gate on relation vocabulary + license/egress/dialect, deliver a content-addressed grounding pack.
- **translation engine** (`translation/`, Rust) — one core, several front-ends (WASM, native Python
  binding, HTTP), with OpenTimelineIO as the canonical media-timeline model under the koine layer.
- **conformance console** (`console/`, TS + React) — a KCS scenario runner + 3-panel UI over the
  real MCP/A2A links; content-addressed, archivable reports.
- **trainer** (`trainer/`, Python) — the **general** KFT `finetune` capability (specialized
  finetuners run as their own services; the registry disambiguates).
- **client SDK + starter** (`clients/sdk/` + `examples/participant-starter/`, TS) — `@agora/sdk`,
  the one publishable surface, plus the ~20-line copy-and-run participant.
- **schemas** (`schemas/`, TS) — `@agora/schemas`, shared manifest schemas / protocol types; the
  koine spec versions are pinned once here and asserted across every language gate.

**Chief program:** 4/4 built-program tasklists merged (`10`, `20`, `30`, `40`); 19 proposed forward tasklists authored (`tasks/chief/*.json`, `passes:false`, unrun) — pending a run, not merged, of which 1 parked.

---

## Milestones

One list, everything: shipped, in-progress, and planned. Two axes run through agora — a
**contract-coverage** axis (a running surface for each koine spec) and a **build-vs-adopt /
platform** axis (the Chief-driven work that stands those surfaces on established tools) — so the
shipped work is shown as those two tracks; the mined-but-unbuilt "second act" follows as Phases
`A`–`H`, and the **Ongoing** and **Loose wishlist** blocks close it out. Status legend:
**✅ complete/merged · 🚧 partial / in-progress / cutover-blocked · ⬜ planned**. The Tasklist column
is the Chief tasklist that delivered a row (✅ merged), the pre-Chief bootstrap program that did
(US-AG1–4), or the *(proposed)* tasklist that would.

> The completed Chief bands are `10`–`40` (4/4 merged); the router/registry/resolver surfaces
> predate that program and were built by the **US-AG1–4 bootstrap** (see `progress.txt`), which
> has no completed `NN-*.json` record of its own. Proposed second-act tasklists are numbered
> `chief/41`, `chief/50`–`58` (Phases A–F), `chief/60`–`66` (Phase G — Agora Studio),
> `chief/67`–`68` (Phase H — trust & hardening), and `chief/69`–`72` (Phase B correction + Phase B2
> verified-defect closure), chosen to not collide with the merged bands or the cross-repo
> `agora:80`/`agora:90` references in `CLAUDE.md` / `trainer/README.md`.

### Chief build program (bands 10–40) — ✅ complete (4/4 merged)

| Status | Milestone | Tasklist |
|---|---|---|
| ✅ | Leaf gateway on LiteLLM — spike + dispatch adapter behind `AGORA_LITELLM=1`; **NO-GO** on retiring the dual router (US-1/2/3) | `10-litellm-leaf-gateway` |
| ✅ | Client SDK & adoption — `@agora/sdk` stable enumerated API + the ~20-line participant starter + quickstart (US-1/2/3) | `20-client-sdk-and-starter` |
| ✅ | Translation on OpenTimelineIO — OTIO adapters, additive koine layer preserved (US-1/2), after `koine:10-kmi-adopt-otio` | `30-translation-otio` |
| ✅ | Fabric data-plane bridges — KGP knowledge sync, KFT dataset bridge (by-reference → trainer/lugh), KINP resolution + grounding-pack ingest, KCB producer surfaces (US-1/2/3/4), after `koine:40-fabric-producer-contracts` | `40-fabric-data-plane-bridges` |

### Contract-coverage surfaces — a runtime per koine spec — ✅ (telemetry + finetune + cutover tails 🚧)

| Status | Milestone | Tasklist |
|---|---|---|
| ✅ | **KCB** capability-bus — `registry/` discovery (addresses, cost-ranked, cross-plane paths) + `@agora/sdk` projection | US-AG1–4 (bootstrap) |
| ✅ | **KINP** identity — `resolver/` `resolve` (identity firewall) + `reconcile` (W3C API + review policy) | US-AG1–4 (bootstrap) |
| ✅ | **KGP** grounding-pack — `knowledge/` data-plane bridge (admit claims → deliver pack, egress-gated) | `40-fabric-data-plane-bridges` |
| ✅ | **KMI** media-interchange — `translation/` engine over OpenTimelineIO, additive koine layer preserved | `30-translation-otio` |
| ✅ | Model gateway (leaf) — `provider-router-erl/` **canonical** (ADR-0004) + `provider-router/` as byte-for-byte spec-of-record | US-AG1–4 + ADR-0004 |
| 🚧 | **KCS** conformance — `console/` scenario runner + UI; data plane covered, control-plane telemetry reader (`spans.ts`) provisional and future-KCS predicates report `pending` | closed by Phase D |
| 🚧 | **KFT** fine-tune — `trainer/` **general** provider implemented & gated; the schema validator + the live §6/§5.3/§8 endpoints are still pending | closed by Phase A |

> **Reality reconciliation.** The ecosystem overview still describes the "Rust data-translation
> engine + Erlang provider-router" as *in progress / planned*. That framing is **superseded**: both
> are in the tree and gated — the Rust translation engine landed OTIO (`chief/30`) and the Erlang
> router is the **canonical** implementation (ADR-0004). What actually remains is the *cutover tail*
> (Phase E) — retiring the Python router once deployments have moved — not building either surface.

### Phase A — KFT finetune completion — ⬜ planned (scale: M)

Finish the fine-tuning capability: a standalone conformance validator for the job schema, and turn
the trainer's still-404 output endpoints into a live stream. The second row is cross-repo — it
cannot close until an orchestrator-side KCB *client* replaces the `Runner::Stub`.

| Status | Milestone | Tasklist |
|---|---|---|
| ⬜ | ajv/jsonschema validator + conformance CI for `finetune-job.schema.json` (KFT §3); semantic admission (modality×method, egress) stays in the providers — a named-but-unbuilt agora tasklist · S/M | `chief/41-finetune-job-validator` *(proposed)* |
| ⬜ | Un-404 the trainer's real §6 telemetry stream / §5.3 export / §8 registry, driven by the orchestrator-side KCB finetune **client** that replaces `Runner::Stub` (discover → invoke → subscribe → issue `invoke:finetune` grants) · M, cross-repo | `chief/50-finetune-live-endpoints` *(proposed)* |

*Depends on:* the KFT contract (`koine/specs/fine-tuning.md`; the previously-cited `koine:20-kft-finetune-profile` stem never existed — koine's `chief/20` is `20-kgp-standards-alignment`, and the KFT profile is the spec itself). The cross-repo runtime the trainer's stream dials is now **merged**: the orchestrator-side client is `cuneiform:90-finetune-client` (merged, `Runner::Kcb`), and the specialized provider is **lugh** (`lugh:30-kft-provider-manifest`, merged) — the previously-cited `pinakes:90-finetune-provider` was never authored (pinakes `90` became `90-extract-lugh`; cuneiform `102-retarget-finetune-provider-to-lugh` records the retarget). `chief/50`'s `dependsOn` encodes both. Source: `trainer/README.md` follow-up table.

### Phase B — Provider-router adapter breadth — ⬜ planned (scale: M)

Widen vendor coverage on the **canonical** path — the hand-written Rust `wire` codec the Erlang
router drives — and adopt a maintained price map as a *source of rates* underneath
`AGORA_PRICE_TABLE`. Vendor dispatch is **not** "the one thing the router punts on": it is agora's
own codec, and it is the broader of the two paths in this tree. All of this sits **below** the
transport boundary; every differentiator stays hand-built.

> ⚠️ **Correction (2026-08-11, restated 2026-08-13) — the canonical dispatch path is Rust, not
> LiteLLM.** The canonical Erlang router (ADR-0004) has **no LiteLLM code path**: nothing in
> `rebar.config`, no import, no dispatch. (`grep -ril litellm provider-router-erl/` does *not*
> return nothing, as this note previously claimed — it returns four files, six lines, every one a
> prose comment attributing something to the Python side or pointing at
> `docs/litellm-dispatch-adapter.md`.) It covers **all seven** native-wire vendors — anthropic,
> gemini, replicate, elevenlabs, runway, luma, minimax — through the **Rust port program**
> `translation/crates/wire` (built by `build-translator.sh`, driven by `apr_translate.erl` as a
> supervised OS process: a *port, not a NIF*, so no third-party wire code can take down the node).
> LiteLLM lives only in the **superseded Python router**, behind `AGORA_LITELLM=1`, where it makes
> **2 of 7** vendors dialable. So the canonical path is **ahead** of the borrowed one — 8
> `(vendor,modality)` pairs to 2 — and `chief/52`, not `chief/51`, is the vendor-breadth path of
> record. **The code is right**: LiteLLM cannot embed in the BEAM without a Python sidecar or a
> NIF, and either costs a differentiator — and **LiteLLM 1.82.7/1.82.8 were backdoored on PyPI in
> March 2026**, which is why the optional extra stays optional, pinned, and off. `chief/69` lands
> this correction across the docs.
>
> **Coverage is not dispatch.** The codec *renders* each vendor's native request; the *sender* is
> a separate concern and the shipped default is still inert (`apr_router.erl:216` →
> `no live transport configured`, and there is no HTTP client in `provider-router-erl/src/`).
> `chief/73` is that story, and widening what the router can render while nothing sends it is work
> with no observable effect — so `73` sequences ahead of `52`.

| Status | Milestone | Tasklist |
|---|---|---|
| ⬜ | **Correct the dispatch record** — the docs still read as if LiteLLM were the router's dispatch path; state that the canonical router has zero LiteLLM and renders via the Rust port program, record why the code is right (BEAM-embedding cost + the March 2026 PyPI backdoor), and record **`agentjido/req_llm`** as the untried option for canonical-side breadth · S | `chief/69-router-dispatch-record-correction` *(proposed)* |
| ⬜ | Erlang/Rust `wire` codec widens past its 8 `(vendor,modality)` pairs (`translation/crates/wire/src/lib.rs`) — **the vendor-breadth path of record**, on top of a transport `chief/73` must land first · M | `chief/52-wire-codec-vendor-breadth` *(proposed)* |
| ⬜ | **Evaluate `agentjido/req_llm` as the adopt half of the build-vs-adopt call** — 558★, Apache-2.0, **v1.20.0** (2026-08-10), **1,205 models / 21 provider integrations**, native BEAM, normalized tokens + USD cost (facts re-verified 2026-08-13). Judge it on the six criteria in [`docs/prior-art.md`](docs/prior-art.md#provider-router--an-openai-compatible-model-gateway): below the transport boundary, always-completes intact, `unpriced` never passes a ceiling, Elixir-in-a-rebar3-build, KCB manifest unchanged, maintainer pool. 21 maintained integrations against 7 hand-written codecs is the asymmetry that decides it · S | `chief/75-req-llm-breadth-evaluation` *(proposed, one call with `chief/73`)* |
| ⬜ | Python/LiteLLM adapter widens past the 2-of-7 native-wire vendors it dials today (anthropic/gemini text) — **superseded-router scope only**, and it is chasing parity the canonical path already has; do it only to keep the byte-for-byte corpus meaningful, or not at all · M | `chief/51-litellm-adapter-vendor-breadth` *(proposed, re-scoped)* |
| ⬜ | Adopt LiteLLM's maintained price map as an `AGORA_PRICE_TABLE` source, layered *under* the `unpriced`/`budget_units`/non-text `measure()` rules, never replacing them · S | `chief/53-litellm-price-map-source` *(proposed)* |

*Depends on:* `69` should land before `51`/`52`/`75` so breadth work is scoped against the corrected record, and `73` (a live transport) before `52` — rendering more vendors changes nothing observable until something dials. `75` and `73`/US-1 are **one decision, not two**: `req_llm` would be both the sender and the breadth, so whichever runs first records the call for both. Sources: `provider-router-erl/src/apr_translate.erl`, `provider-router-erl/src/apr_router.erl`, `translation/crates/wire/src/lib.rs`, `docs/litellm-dispatch-adapter.md`, `docs/prior-art.md`, `docs/spike-litellm-leaf.md` §5.

### Phase B2 — Verified-defect closure (prior-art sweep, 2026-08) — ⬜ planned (scale: S–M)

Three defects found by direct inspection of this tree, independent of any strategic call. Each is
small, concrete, and fixable now; two of them are the kind that go green while asserting the wrong
thing.

| Status | Milestone | Tasklist |
|---|---|---|
| ⬜ | **`schemas/src/versions.ts` lags koine on 4 of 6 specs** — kcb `0.2.0` vs **0.3.0**, kinp `0.2.0` vs **0.2.1**, kgp `0.4.0` vs **0.5.0**, kft `0.3.0` vs **0.4.0** — and **`kmi` is absent entirely** though `translation/` ships a KMI runtime. The three language constants are asserted only against **each other**, never against koine. Repin all six in lockstep, record the candidate-version policy, and add the **drift gate** that reads koine's spec headers · M · **subsumes `chief/58`** | `chief/70-spec-pin-repin-and-drift-gate` *(proposed)* |
| ⬜ | **Hard budget ceilings are no longer a differentiator** — LiteLLM now ships dollar-denominated pre-call budgets with `fail_closed_budget_enforcement`, so the N4 finding is superseded. Re-date it rather than delete it, and restate the four claims that **do** survive: the **`unpriced`-never-passes-a-ceiling rule** (LiteLLM's `cost_per_token` returns `(0,0)` for an unmapped model — *free* where it means *unknown*, i.e. fail-**open**), **`budget_units` denomination**, **non-text `measure()`**, and the **always-completes terminal rung** (no surveyed gateway has one) · S | `chief/71-budget-differentiator-honesty` *(proposed)* |
| ⬜ | **KCB extension URI migration** — `https://koine.dev` is **unregistered** (verified 2026-08-11) and is the manifest extension URI; koine moves it to `w3id.org/koine/…` with a dual-accept window. agora pins the old string in **six** places, including the **byte-for-byte conformance corpus** that must be regenerated, not hand-edited · M, cross-repo | `chief/72-kcb-extension-uri-migration` *(proposed, parked on `koine:75`)* |

*Depends on:* `72` is parked on `koine:75-w3id-namespace-migration` (migrating to a guessed URI would be a second defect). `70` subsumes and retires `chief/58`. `70` and `72` both move pinned constants across all three languages, so they share a conflict domain and must not co-schedule. Source: the 2026-08 prior-art sweep's *Verified defects* table.

### Phase C — KCB endpoint surface (MCP / A2A) — ⬜ planned (scale: M)

The router manifest advertises **no** `mcp`/`a2a` keys "until they exist" (an advertised address is
a promise a peer will dial directly, ADR-0001 §3). Stand up the MCP/A2A server endpoints **and**
advertise them **atomically** — `test_manifest.py` pins the endpoint key set precisely so a future
story must add the server and the advertisement together.

| Status | Milestone | Tasklist |
|---|---|---|
| ⬜ | Serve MCP/A2A endpoints on the provider-router and add them to the KCB manifest in the same change, re-pinning the manifest key set · M | `chief/54-mcp-a2a-endpoint-surface` *(proposed)* |

> ⚠️ **Name the target revisions before building this.** **MCP's 2026-07-28 revision is a breaking
> change** — stateless core (no `initialize`, no session id, per-request `_meta`) plus a mandatory
> **`server/discover`** — and MCP's own suite treats the two wires as non-interchangeable. Likewise
> **A2A v1.0** replaced the v0.x top-level `"url"` with **`supported_interfaces[]`**
> (`AgentInterface{url, protocol_binding}`). Both belong in `chief/54`'s acceptance criteria as an
> explicit target revision, not an implicit one; koine's contract-side pin table is
> `koine:76-upstream-standards-pins`.

*Depends on:* none in-repo. Source: `progress.txt` US-AG3.

### Phase D — Conformance / telemetry rewrite — ⬜ planned (scale: M)

`console/src/kcs/spans.ts` is the one piece of the console that expects to be *rewritten against a
spec* rather than to define one — today any future-KCS predicate reports `pending` and never passes.
Rewrite the observability reader against a ratified KCS emitted-telemetry contract, and add the
outstanding KMI media-map predicate.

| Status | Milestone | Tasklist |
|---|---|---|
| ⬜ | Rewrite `spans.ts` + the §5 assertion vocabulary against a ratified KCS emitted-telemetry (observability) extension, so the control-plane view is complete and predicates can pass · M | `chief/55-kcs-observability-rewrite` *(proposed)* |
| ⬜ | KCS §5 `media_map_complete` predicate to read KMI delta-I's asset-id ↔ path media map · S | `chief/56-kmi-media-map-complete-predicate` *(proposed)* |

*Depends on:* koine (a ratified KCS observability extension + the KMI delta-I media map). Sources: `DESIGN.md` console runtime-notes, `console/README.md`.

### Phase E — Erlang cutover / Python-router retirement — ⬜ planned (scale: L, external — may never trigger)

Retire `provider-router/` (Python) to its own repo and freeze its conformance corpus as the frozen
contract record — but **NO-GO today**. The four preconditions below are the definition-of-done; until
*all four* hold, the byte-for-byte equality `apr_conformance_SUITE` asserts is the cheaper guarantee
and both routers stay green.

| Status | Milestone | Tasklist |
|---|---|---|
| ⬜ | Retire the Python router once all four hold: (1) an upstream *terminal*-rung mechanism that cannot fail, not a chain that ends in one; (2) a per-request, caller-supplied pre-dial ceiling that falls through rather than aborts; (3) unknown ≠ free (an unmapped model is refusable, not priced at zero); (4) an Erlang-reachable dispatch (a wire sidecar) **or** an ADR-0004 reversal · L | `chief/57-python-router-retirement` *(proposed)* |

*Depends on:* four external preconditions (none in agora's gift). Source: `docs/router-hand-built-behaviours.md` §5.

### Phase F — Contract-version pin advances — ⬜ **folded into Phase B2** (scale: S)

This phase was scoped to one lagging pin (`SPEC_VERSIONS.kgp` at `0.4.0` vs koine's `0.5.0`). The
2026-08 sweep found **four** lagging pins plus a missing sixth spec, and — the real hole — that no
gate anywhere compares agora's pins to **koine**; the three language constants are asserted only
against each other, so they can agree perfectly on a version koine left behind.

| Status | Milestone | Tasklist |
|---|---|---|
| ⬜ | Repin all six specs in lockstep + record the candidate-version policy + add the koine-reading drift gate — the superset of this phase | `chief/70-spec-pin-repin-and-drift-gate` *(proposed, Phase B2)* |
| ⏸ | ~~Decide + apply the KGP pin advance (0.4.0 → 0.5.0)~~ — **subsumed by `chief/70`; parked**, retire when `70` merges | `chief/58-kgp-version-pin-advance` *(parked)* |

*Depends on:* koine KGP re-ratification for the KGP row specifically; the rest of the repin does not wait on it. Sources: `progress.txt` US-1, the 2026-08 prior-art sweep's *Verified defects* table.

### Phase G — Agora Studio (the default topology/observability UI) — ⬜ planned (scale: L)

Agora ships a default UI **backbone** that visualizes the networked AI apps/services in a user's
setup — both **internal** (an Insimul/Cuneiform/Lugh/Formant setup wired via rosetta) and
**external** (any outside MCP/A2A connection). The backbone ships with **NO preconfigured
participants**: the cast is learned at runtime (capability, never caller — the ADR-0001 rule the
whole tree obeys), discovered through the KCB `registry/` and resolved through `resolver/`, and it
renders koine contracts and AgentCards it is *told about*, never a hard-wired roster. It is a new
source-first TS + React surface alongside the conformance `console/` (observer, never a hub — traffic
never flows through it). Every row below reads from an existing agora surface — `registry/` find,
`resolver/` resolve, `console/src/kcs/spans.ts` telemetry, `schemas/` manifests — rather than
inventing a new control plane.

| Status | Milestone | Tasklist |
|---|---|---|
| ⬜ | UI shell / backbone — the app scaffold with **no preconfigured apps/services/connections**; participants come only from the user's own config (rosetta is the internal dogfood, per rosetta's roadmap); source-first TS + React alongside `console/` · M | `chief/60-studio-ui-backbone` *(proposed)* |
| ⬜ | Live topology graph — nodes = AI apps/services, edges = MCP/A2A connections (internal + external), discovered via the KCB `registry/` (addresses, cross-plane paths) and `resolver/` KINP identities · L | `chief/61-studio-topology-graph` *(proposed)* |
| ⬜ | Connection monitoring — per-connection health/status, uptime, and error surfaces over the real MCP/A2A links (never relayed) · M | `chief/62-studio-connection-monitoring` *(proposed)* |
| ⬜ | On-the-wire message viewer **with animation** — messages flowing between services animated along the graph edges in real time, with payload inspection, read from the `console/src/kcs/spans.ts` telemetry reader — **after `chief/55`** (Phase D), so the viewer is built on the ratified emitted-telemetry shape, not the provisional `ObservedSpan` shape Phase D replaces · L | `chief/63-studio-message-viewer-animated` *(proposed)* |
| ⬜ | Analytics & reporting dashboards — traffic, latency, cost (router cost-estimation), and capability-usage across the network — **after `chief/55`** (Phase D), same rationale as the message viewer · M | `chief/64-studio-analytics-dashboards` *(proposed)* |
| ⬜ | Spec-definition viewer — render the koine contracts each participant advertises (KINP/KGP/KCB/KMI/KCS/KFT) plus its AgentCard/manifest, validated by `@agora/schemas` · M | `chief/65-studio-spec-viewer` *(proposed)* |
| ⬜ | Runnable example setups — several example topologies with *thin* AI app/service examples (barely more than local-inference wrappers) so a user sees Studio populated without wiring their own; consumes the published `@agora/sdk`, never imported by it · M | `chief/66-studio-example-setups` *(proposed)* |

*Depends on:* rosetta (the internal/proprietary test setup that dogfoods this UI — see rosetta's roadmap) and koine specs (the KINP/KGP/KCB/KMI/KCS/KFT contracts the spec-definition viewer renders). The telemetry-reading rows (`63`, `64`) additionally depend on `chief/55-kcs-observability-rewrite` (Phase D) so Studio never ships on the provisional `spans.ts` shape. Reads existing surfaces: `registry/`, `resolver/`, `console/src/kcs/spans.ts`, `schemas/`.

### Phase H — Control-plane trust & local-tier hardening — ⬜ planned (scale: M)

Two runtime-commons gaps promoted from prose. The **grant issuer** is the missing service half of
koine KCB §5: agora holds the relying-party half everywhere (`apr_grant.erl`, the trainer's
`Grant`, the `grants_required` manifest shape) while issuance/rotation/ceiling policy — which KCB
places in "the control-plane host's infra" — has no reference runtime anywhere; downstream
enforcement (`pinakes:111-grant-enforcement-and-budget-ceilings`) explicitly waits on it. The
**local-backend hardening** row is the wishlist's Ollama-default item made executable — it touches
the always-completes ladder's correctness, so it re-proves the §2.3 guards on every path it touches.

| Status | Milestone | Tasklist |
|---|---|---|
| ⬜ | **KCB grant issuer** — issuance / rotation / ceiling-policy service per KCB §5, minting the exact `<verb>:<scope>` + `budget_units` shape the relying parties already parse; key rotation with overlap, expiry, published verification material, attenuation that only narrows; consumed cross-repo by `pinakes:111` · M | `chief/67-kcb-grant-issuer` *(proposed)* |
| ⬜ | **Local-backend (Ollama/mlx-serve) hardening** — no dispatch path inherits LiteLLM's `http://localhost:11434` default (a local rung exists only by explicit config), explicit auth/bind posture, and failure modes proven inside the always-completes ladder, in both routers in lockstep · M | `chief/68-local-backend-hardening` *(proposed)* |

*Depends on:* none in-repo (`67` is consumed by, not dependent on, pinakes; `68` re-proves existing guards). Sources: `koine/specs/capability-bus.md` §5, `docs/spike-litellm-leaf.md` N2/N3, `docs/router-hand-built-behaviours.md` §2.3.

### Ongoing — steady-state, not a phase — 🚧 continuous

| Status | Milestone | Tasklist |
|---|---|---|
| 🚧 | **Cutover readiness watch** — both routers stay byte-identical green (a change to the router's external contract lands in both or neither) and the conformance corpus stays *live*, until Phase E's four preconditions trigger | — |
| 🚧 | **Vendor/adapter breadth** — keep widening the canonical Rust `wire` codec, or adopt `req_llm` instead if the Phase B evaluation (`chief/75`) says the maintained 21-provider tree beats hand-writing the eighth codec; either way the differentiators stay hand-built (feeds Phase B) | — |
| 🚧 | **Re-verify the competitive claims** — every dated comparison in `docs/prior-art.md`, `docs/spike-litellm-leaf.md`, and `docs/router-hand-built-behaviours.md` is re-checked on a cadence and re-dated or retired; the LiteLLM budget claim already went stale once (Phase B2 `chief/71`) | — |
| 🚧 | **Contract-version tracking** — as koine specs revise, bump `schemas/src/versions.ts` and keep every language gate asserting against it in lockstep (feeds Phase F) | — |

### Loose wishlist — ⬜ not yet phased

Smaller open threads noted across the docs, each with a known site, none big enough to anchor a phase:

- **Ids in the §7.2 egress report** — `inspectPackEgress` reports a violating entity record *without* an id, because `EgressBearing` reads `record.id` while a KGP §2 entity record is keyed by `csid`; section + index still locate it, so it was left alone in `schemas/` (`progress.txt` US-1).
- ✅ **Harden the Ollama localhost default** — *promoted to a tasklist*: now Phase H's `chief/68-local-backend-hardening` (the default must be overridden, not inherited, plus auth/bind posture and ladder failure modes; `docs/spike-litellm-leaf.md` N2/N3).
- **Re-prove the guards on any new dispatch path** — `resolve_all` never raising and `unpriced` never passing a ceiling must be re-asserted whenever a Phase-B adapter adds a rung (`docs/router-hand-built-behaviours.md` §2.3).

---

## Chief Tasklist Status

- **4/4 built-program tasklists merged**; 23 proposed forward tasklists authored (`tasks/chief/*.json`, `passes:false`, unrun) — pending a run, not merged, of which 3 parked (`57-python-router-retirement`, `58-kgp-version-pin-advance` — subsumed by `70` — and `72-kcb-extension-uri-migration`, which waits on `koine:75`). Records live in
  [`tasks/chief/completed/`](tasks/chief/completed/): `10-litellm-leaf-gateway`,
  `20-client-sdk-and-starter`, `30-translation-otio`, `40-fabric-data-plane-bridges` — each with a
  `mergedToMain` commit and all user stories `passes: true`.
- Two tasklists carried cross-repo `dependsOn` into koine (`koine:10-kmi-adopt-otio`,
  `koine:40-fabric-producer-contracts`); both dependencies were satisfied before the agora work
  merged.
- **23 proposed tasklists** (`chief/41`, `chief/50`–`58`, `chief/60`–`66`, `chief/67`–`68`,
  `chief/69`–`72`) back the planned Phases A–H above — **now authored** (`tasks/chief/*.json`,
  `passes: false`, unrun); they are numbered to not collide with the merged bands or the cross-repo
  `agora:80`/`agora:90` references. `chief/50` additionally encodes its now-merged cross-repo closure deps
  (`cuneiform:90-finetune-client`, `lugh:30-kft-provider-manifest`), and `chief/63`/`64` depend on
  `chief/55` so Studio is never built on the provisional telemetry shape.
- **`chief/69`–`72` are the 2026-08 prior-art sweep's verified-defect closure**, not speculative
  breadth work: the LiteLLM-vs-Rust dispatch record correction (`69`), the six-spec repin + koine
  drift gate (`70`, subsuming `58`), the budget-differentiator restatement (`71`), and the
  cross-repo KCB extension-URI migration (`72`, parked on `koine:75`). Each was found by direct
  inspection of this tree — `grep -ril litellm provider-router-erl/` returning nothing, four stale
  pins in `schemas/src/versions.ts`, and an unresolvable `koine.dev` — and each has a checkable
  fix rather than a judgement call.
- No open *autonomous* work remains in this repo. The second-act phases are cutover/follow-up and
  breadth work; several rows are cross-repo (`koine`, the orchestrator, `pinakes`) or gated on
  external preconditions (Phase E), so they are proposals, not queued tasklists.

---

## Related Docs

There are **no superseded roadmap documents** — this is agora's first canonical roadmap, so
`docs/roadmap/` is intentionally empty. All of agora's forward-looking and reference material lives
in well-integrated docs kept in place:

**Architecture & decision records** (living reference):
- [`DESIGN.md`](DESIGN.md) — the architecture and the *why*: the always-completes supervision tree,
  the polyglot stack, and the registry/resolver/translation/console surfaces.
- [`docs/prior-art.md`](docs/prior-art.md) — how each component relates to existing tools (LiteLLM,
  agent registries, the W3C Reconciliation API): what agora reuses versus adds.
- [`docs/spike-litellm-leaf.md`](docs/spike-litellm-leaf.md) — the LiteLLM leaf-gateway spike
  (US-1 evidence) · [`docs/litellm-dispatch-adapter.md`](docs/litellm-dispatch-adapter.md) — what
  US-2 borrowed · [`docs/router-hand-built-behaviours.md`](docs/router-hand-built-behaviours.md) —
  the US-3 record of what stays hand-built (why the router is not retired).

**Guides:**
- [`docs/quickstart.md`](docs/quickstart.md) — install the SDK to first call, ~5 minutes.
- [`docs/walkthrough-wiring-a-project.md`](docs/walkthrough-wiring-a-project.md) — run → discover →
  prove, end to end.

**Contracts (in koine, the source of truth):**
[koine](https://github.com/danieldekerlegand/koine) specs — Identity (KINP), Grounding-Pack (KGP),
Capability-Bus (KCB), Media-Interchange (KMI), Conformance-Scenario (KCS) — and
[ADR-0001](https://github.com/danieldekerlegand/koine/blob/main/decisions/ADR-0001-control-plane-topology.md),
the control-plane-topology decision that created this repo. The deployment-history ADRs
(ADR-0002/0003/0004, incl. the Erlang router) live in the private integration repo.
