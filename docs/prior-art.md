# How agora relates to existing tools

agora is the **runtime** that implements the [koine](https://github.com/danieldekerlegand/koine)
specifications — *koine specifies, agora implements*. This document places each of agora's
components against the established tools and standards it reuses, so you can see exactly where
agora provides something new and where it is deliberately standing on existing work.

The guiding principle is the same as koine's: **reuse established interfaces; don't invent new
ones.** Everything here is reached over the wire (MCP/A2A + OpenAI-compatible HTTP); the
implementation language is an internal detail.

## provider-router — an OpenAI-compatible model gateway

**What it is:** a model gateway exposing the OpenAI-compatible API, with a fallback ladder
(paid → local → deterministic placeholder), cost estimation, and per-request budget ceilings.
The bottom placeholder rung always completes, so a fresh install answers immediately and spends
nothing.

**How it relates:** this is the same *category* as general LLM gateways such as
[LiteLLM](https://github.com/BerriAI/litellm) and OpenRouter — OpenAI-compatible fronts over many
providers with fallbacks and budgets. Within koine, the provider-router is the **"leaf" model
capability**: a single backend ladder exposed as a KCB capability (via an Agent Card), distinct
from the capability-bus registry (which routes *between* participants and never proxies). If you
already run an OpenAI-compatible gateway, you can expose it as a KCB capability the same way — the
router is a reference implementation, not a mandate.

**Measured against LiteLLM:** [`spike-litellm-leaf.md`](spike-litellm-leaf.md) takes that
comparison apart feature by feature, with runnable evidence. Short version: LiteLLM covers the
mlx-serve and local tiers, but has no always-completes terminal rung, no caller-supplied
per-request ceiling that skips a tier without dialing it, and no KCB manifest — those three are
agora's, and the spike shows why.

**Vendor dispatch is agora's own, and LiteLLM is not on the canonical path.** The canonical
router is Erlang (ADR-0004) and contains no LiteLLM: it reaches all seven vendors whose wire
format is not OpenAI-shaped — anthropic, gemini, replicate, elevenlabs, runway, luma, minimax —
through the Rust codec in [`translation/crates/wire`](../translation/crates/wire), driven by
`provider-router-erl/src/apr_translate.erl` as a **supervised external OS process (a port, not a
NIF)** so that a fault in wire-format code costs one pipe rather than the node. That codec
covers **8 `(vendor,modality)` pairs across all seven vendors**.

LiteLLM's own adapters *are* borrowed rather than reimplemented — but only in the **superseded
Python router**, off by default behind `AGORA_LITELLM=1`, where they make **2 of 7** vendors
dialable (anthropic and gemini, text). So the borrowed adapters are not this router's dispatch
path of record; the hand-written Rust codec is, and it is ahead of them 8 pairs to 2.

That ordering is deliberate, for two reasons that are independent of each other. LiteLLM cannot
reach the canonical path without a NIF (an embedded interpreter in the BEAM's address space, where
a fault becomes the node's) or a Python sidecar (safe for the node, but it either duplicates the
Rust codec at greater weight or moves the pre-dial refusal below the transport boundary, into
cost accounting that reads an unpriced model as *free*). And LiteLLM **1.82.7 and 1.82.8 were
backdoored on PyPI in March 2026** — which is why the optional Python-side extra is floored at
`>=1.95`, off unless `AGORA_LITELLM=1`, and why the floor is asserted by a test rather than left
to a comment. Both arguments, and the pin, are in
[`litellm-dispatch-adapter.md`](litellm-dispatch-adapter.md).

**The untried option for canonical-side breadth: `agentjido/req_llm`.** Neither reason above is an
argument against *breadth*, and the hand-written Rust codec is not the only way to get it. The
candidate nobody here has evaluated is
[`agentjido/req_llm`](https://github.com/agentjido/req_llm) — facts re-verified **2026-08-13**
against the GitHub API, hex.pm and the project README:

| | Observed 2026-08-13 |
|---|---|
| Stars / org | **558**, single-org (the 2026-08-11 sweep recorded 554) |
| License | **Apache-2.0** |
| Latest stable | **v1.20.0**, released 2026-08-10 on hex.pm (the sweep's `v1.0.0` is stale) |
| Coverage | **1,205 models across 21 implemented provider integrations** (1,218 / 22 counting a cataloged-but-unimplemented namespace) |
| Runtime | **Native BEAM** — an Elixir library over `Req`/`Finch`; no port program, no Python sidecar |
| Accounting | Normalized per-response token usage plus `input_cost`/`output_cost`/`total_cost` in USD |

**It is a candidate, not an adoption.** 21 maintained provider integrations against 7 codecs
written by hand is the asymmetry that decides a build-vs-adopt call, so it deserves a real
evaluation rather than a default. What that evaluation has to answer, before any of it counts:

1. **Does it sit *below* the injected transport boundary?** The ladder, budget and cost layer never
   learns a provider's name — that is what makes the transport a one-module swap
   (`apr_router.erl`'s `transport` option). If adopting `req_llm` means the dial decision moves
   down into it, **pre-dial refusal** — a ceiling that skips a tier *without* dialing it — is what
   gets spent to buy the breadth, and that is one of the two differentiators the router exists for.
2. **Does the always-completes ladder stay structural?** In-BEAM means a fault is the node's fault,
   which is precisely the property `apr_translate.erl` buys by paying for a port. The terminal
   zero-spend rung must remain one that cannot fail.
3. **The `unpriced` rule is not negotiable.** `req_llm`'s own README calls its pricing "an
   observability and estimation feature, not an invoice guarantee". That makes it usable as a
   *rate source* under `AGORA_PRICE_TABLE`; it may never become the ceiling check, because agora's
   rule is that an unpriced model never passes a ceiling (fail-closed, where reading an unmapped
   model as free is fail-open).
4. **It is Elixir, and this router is Erlang/rebar3.** Adopting it pulls Elixir and the
   `Req`/`Finch` tree into a `rebar3` build and gate — a build-system question, not just a library
   choice.
5. **The KCB manifest is agora's promise, not a vendor catalog passthrough.** 21 providers reachable
   is not 21 capabilities advertised; what the manifest claims must stay what this router will
   answer for.
6. **Maintainer pool.** 558★ single-org is thin for a layer-zero dependency on a request hot path —
   the same standard that disqualified an unpinned LiteLLM applies here, and points at pinning and
   vendoring discipline rather than at a veto.

One clarification that keeps this comparison honest: the Rust codec provides **wire coverage** — it
renders each vendor's native request. The **sender** is a separate concern, and the shipped default
is still inert (`apr_router.erl:216` returns `no live transport configured`; there is no HTTP client
in `provider-router-erl/src/`). `req_llm` is a candidate for *both* halves at once, which is why the
call belongs with `chief/73-canonical-router-live-transport` rather than being taken twice.

## discovery registry — capability discovery, addresses not proxies

**What it is:** the KCB registry. `find` a capability and it returns an **address**; it ranks
routes cheapest-first and can chain capabilities across planes into a path. It never relays
traffic — peers dial each other directly.

**How it relates:** conceptually similar to an agent registry/catalog over A2A Agent Cards (an
area A2A itself is actively standardizing). agora's registry adds two things on top of a flat
lookup: **cross-plane path-finding** (compose knowledge→media capabilities) and **cost-ranked**
routing with projected spend, so a caller can gate budget before invoking.

## resolver — identity resolve & reconcile

**What it is:** the KINP resolver's two verbs. `resolve` computes a merged view of an entity
(never crossing a `based_on` edge — the identity firewall); `reconcile` maps an ambiguous
name to a stable id.

**How it relates:** `reconcile` consumes the [W3C Entity Reconciliation API](https://openrefine.org/docs/technical-reference/reconciliation-api)
(as used by OpenRefine and Wikidata) directly — the same request/response shape reconciliation
services already speak. agora adds the firewall-aware merge and the auto-apply/review-queue policy.

## translation engine — knowledge & media payload translation

**What it is:** translates KGP/KMI payloads between koine's canonical graph shape and the dialects
on either side of a bridge. One core, several front-ends (WebAssembly, native Python binding, HTTP
service).

**How it relates:** a data-plane translator over koine's serializations (which themselves project
to Neo4j/Datalog/ProbLog/Prolog/TSV for knowledge and the NLE/EDL formats for media). It moves
payloads; it is not a transport or a hub.

## conformance console — scenario runner over real connections

**What it is:** a [KCS](https://github.com/danieldekerlegand/koine/blob/main/specs/conformance-scenario.md)
scenario runner + UI. It discovers participants, opens the **same direct MCP/A2A links production
uses**, records every exchange, and evaluates cross-plane assertions. It observes; it is not a hub.

**How it relates:** it tests the actual A2A/MCP protocols end-to-end rather than mocking them.
Reports are content-addressed and archivable.

## Summary

| Component | Reuses | agora's addition |
|---|---|---|
| provider-router | OpenAI API; general LLM-gateway pattern | always-completes zero-spend tier; pre-dial ceiling refusal; KCB exposure; its **own** native-vendor wire codec (Rust, 7 vendors — not LiteLLM's) |
| discovery registry | A2A Agent Card discovery | cross-plane path-finding; cost-ranked routing; addresses-not-proxies |
| resolver | W3C Entity Reconciliation API | identity-firewall-aware merge; review policy |
| translation engine | koine serialization projections | one core, multiple front-ends |
| conformance console | real MCP/A2A connections | cross-plane semantic assertions |
