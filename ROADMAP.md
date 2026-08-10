# agora — Roadmap

> The **runtime commons** of the neuro-symbolic fabric: reference implementations of koine's
> interchange contracts — a model gateway, a discovery registry, an identity resolver, a
> knowledge-sync bridge, a translation engine, a conformance console, and a general trainer —
> that any koine-conformant system can run, self-host, or judge itself against. North star:
> *koine specifies, agora implements* — a thin shared commons where peers discover by capability
> and dial each other directly.

**Status:** Core surfaces implemented & gated; Erlang-router cutover and telemetry follow-ups in progress · **Last updated:** 2026-08-10

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

**Chief program:** 4/4 tasklists merged (`10`, `20`, `30`, `40`); **0 pending**.

---

## Milestones

Two axes run through agora: a **contract-coverage** axis (a running surface for each koine spec)
and a **build-vs-adopt / platform** axis (the Chief-driven work that stands those surfaces on
established tools and makes them adoptable). Status icons: ✅ complete · 🚧 in progress · ⬜ planned.

### Contract-coverage track — a runtime per koine spec

| koine spec | agora surface | Status |
|---|---|---|
| **KCB** capability-bus | `registry/` discovery (addresses, cost-ranked, cross-plane paths) + `@agora/sdk` projection | ✅ implemented & gated |
| **KINP** identity | `resolver/` — `resolve` (identity firewall) + `reconcile` (W3C API + review policy) | ✅ implemented & gated |
| **KGP** grounding-pack | `knowledge/` data-plane bridge (admit claims → deliver pack, egress-gated) | ✅ implemented & gated (`chief/40`) |
| **KMI** media-interchange | `translation/` engine over OpenTimelineIO, additive koine layer preserved | ✅ implemented & gated (`chief/30`) |
| **KCS** conformance | `console/` scenario runner + UI (data plane covered; control plane visible where telemetry is emitted) | ✅ implemented; telemetry extension pending |
| **KFT** fine-tune | `trainer/` — the **general** provider; specialized providers route elsewhere | ✅ general provider implemented & gated |
| model gateway (leaf capability) | `provider-router-erl/` canonical + `provider-router/` as spec-of-record | ✅ both implemented & gated; Python-retirement cutover pending |

### Build-vs-adopt & platform track — Chief tasklists

| Phase | What | Status |
|---|---|---|
| Leaf gateway on LiteLLM | Spike LiteLLM as the leaf backend; front it behind agora's OpenAI surface, keeping the zero-spend tier + KCB exposure; **NO-GO** on retiring the dual router (behaviours it can't cover stay hand-built) | ✅ `chief/10-litellm-leaf-gateway` (US-1/2/3) |
| Client SDK & adoption | Publish `@agora/sdk` with a stable enumerated API; ship the ~20-line participant starter; quickstart from install to first call | ✅ `chief/20-client-sdk-and-starter` (US-1/2/3) |
| Translation on OTIO | Adopt OpenTimelineIO as the media-timeline model (after koine made OTIO canonical); read/write via OTIO adapters; preserve the additive koine layer | ✅ `chief/30-translation-otio` (US-1/2), after `koine:10-kmi-adopt-otio` |
| Fabric data-plane bridges | Generic runtimes so *any* producer can participate: KGP knowledge sync, KFT dataset bridge (by-reference → trainer/lugh), KINP resolution + grounding-pack ingestion, and confirming the KCB-manifest + router client surfaces a producer needs | ✅ `chief/40-fabric-data-plane-bridges` (US-1/2/3/4), after `koine:40-fabric-producer-contracts` |
| Erlang-router cutover | Once deployments have fully moved to the Erlang app, retire the Python router to its own repo and freeze its conformance corpus as the contract record | 🚧 in progress — **NO-GO to retire today**; corpus stays live (`docs/router-hand-built-behaviours.md`) |
| KCS observability extension | An emitted-telemetry contract so the console's control-plane view is complete (a koine follow-up; `console/src/kcs/spans.ts` is the provisional reader) | ⬜ planned (koine follow-up) |
| KMI `media_map_complete` predicate | A KCS §5 predicate to read KMI delta-I's asset-id ↔ path media map | ⬜ planned (koine follow-up) |

> **Reality reconciliation.** The ecosystem overview still describes the "Rust data-translation
> engine + Erlang provider-router" as *in progress / planned*. That framing is **superseded**: both
> are in the tree and gated — the Rust translation engine landed OTIO (`chief/30`) and the Erlang
> router is the **canonical** implementation (ADR-0004). What actually remains is the *cutover tail*
> — retiring the Python router once deployments have moved — not building either surface.

---

## Remaining / Next

agora's core is implemented and gated; what remains is a cutover, two koine-side follow-ups, and
steady breadth work.

**One-off:**

1. **Complete the Erlang-router cutover** 🚧 — retire `provider-router/` (Python) to its own repo
   *only* once deployments have fully moved to the Erlang app; the captured conformance corpus then
   becomes the frozen contract record. Until then, both stay green and a change to the router's
   external contract lands in both or neither. (`DESIGN.md`, `docs/router-hand-built-behaviours.md`.)
2. **KCS control-plane telemetry** ⬜ — depends on a koine observability extension; the console
   already reads spans provisionally and labels visibility per source.
3. **KMI `media_map_complete` predicate** ⬜ — a koine KCS follow-up so a scenario can assert an
   NLE projection's media map is complete.

**Ongoing:**

4. **Vendor/adapter breadth** 🚧 — the LiteLLM dispatch adapter is opt-in behind a flag; widen the
   vendor coverage it borrows while keeping agora's differentiators (always-completes terminal
   tier, per-request budget ceiling that skips a tier without dialing, KCB manifest) hand-built.
5. **Contract-version tracking** 🚧 — as koine specs revise, bump `schemas/src/versions.ts` and
   keep every language gate (Python, Erlang, TS) asserting against it in lockstep.

---

## Chief Tasklist Status

- **4/4 tasklists merged**; **0 pending, 0 parked.** Records live in
  [`tasks/chief/completed/`](tasks/chief/completed/): `10-litellm-leaf-gateway`,
  `20-client-sdk-and-starter`, `30-translation-otio`, `40-fabric-data-plane-bridges` — each with a
  `mergedToMain` commit and all user stories `passes: true`.
- Two tasklists carried cross-repo `dependsOn` into koine (`koine:10-kmi-adopt-otio`,
  `koine:40-fabric-producer-contracts`); both dependencies were satisfied before the agora work
  merged.
- No open autonomous work remains in this repo. The remaining items above are cutover/follow-up
  work, not queued tasklists.

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
