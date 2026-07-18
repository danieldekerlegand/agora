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
[`tasks/chief/agora-bootstrap.json`](tasks/chief/agora-bootstrap.json). Its first story
(US-AG1) establishes the stack, tooling, quality gates, and layout — this README and
`CLAUDE.md` will be filled in with concrete commands as that lands.
