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
mlx-serve and local tiers and owns the vendor adapters, but has no always-completes terminal
rung, no caller-supplied per-request ceiling that skips a tier without dialing it, and no
KCB manifest — those three are agora's, and the spike shows why. The adapters it *does* own are
borrowed rather than reimplemented, behind an opt-in flag:
[`litellm-dispatch-adapter.md`](litellm-dispatch-adapter.md).

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
| provider-router | OpenAI API; general LLM-gateway pattern | always-completes zero-spend tier; KCB exposure |
| discovery registry | A2A Agent Card discovery | cross-plane path-finding; cost-ranked routing; addresses-not-proxies |
| resolver | W3C Entity Reconciliation API | identity-firewall-aware merge; review policy |
| translation engine | koine serialization projections | one core, multiple front-ends |
| conformance console | real MCP/A2A connections | cross-plane semantic assertions |
