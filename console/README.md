# `console` — the conformance console

The executor for **KCS** (`../../koine/specs/conformance-scenario.md`): it runs declarative
scenarios against the real commons and reports what it observed.

Per ADR-0001 decision 7 it is an **observer on real connections, not a hub**. It discovers
participants through the registry, opens the same direct links production opens, injects
requests, and records both directions. Inter-service traffic never passes through it — and
neither does anything else, because the console only ever dials on its own behalf.

## Layout

| Module | What it is |
|---|---|
| `src/kcs/runner.ts` | KCS §4: discover → run (`after`, `timeout_ms`) → evaluate → report |
| `src/kcs/link.ts` | the only module that dials; the §3 verbs against one participant |
| `src/kcs/standin.ts` | a fixture in place of a peer that has not adopted the bus (delta N) |
| `src/kcs/wire.ts` | how a plane-typed `invoke` becomes a request on a peer's own protocol |
| `src/kcs/facts.ts` | reading KGP claims / KMI assets / KINP links off a response |
| `src/kcs/assertions.ts` | the §5 cross-plane vocabulary; unimplemented predicates are *pending*, never a pass |
| `src/kcs/log.ts` | the observation log — ids, summaries and plane-typed facts, never bytes |
| `src/kcs/bindings.ts` | `${step.path}` (delta M) |
| `src/kcs/outcome.ts` | step outcomes and the conformance report |
| `src/commons.ts` | bootstrap: crawl the providers into a registry, then run a scenario |
| `src/scenarios/` | the scenario documents themselves |
| `src/App.tsx` | the UI over one report |

All six §3 verbs execute: `invoke` and `resolve` on the control/identity planes, and
`fetch` / `subscribe` / `emit` on the data planes — a CAS GET by asset id, a delta stream
(NDJSON, SSE, or a `frames` array), and a pack written into the fabric. A provider that
publishes no address for a verb gets a red step, never an invented endpoint.

**Assertions read the observation log, never generated text** (§7 Q2). `facts.ts` only
records what a peer stated in a KGP/KMI/KINP shape, so a provider that describes the right
answer in prose fails every predicate — which is what makes a scenario repeatable instead
of a snapshot of one sampling.

The scenario *document* types live in `@agora/schemas` (`scenario.ts`), not here: KCS §1 is
explicit that the format is a cross-cutting contract and only the runtime and UI belong to
agora.

## Running it

```
npm run dev -w @agora/console     # against a live provider-router on 127.0.0.1:8000
make check-console                # lint + typecheck + tests
```

The gate opens no sockets. It replays `src/fixtures/provider-router.session.json` — a
**capture** of the real zero-spend router, which `provider-router/tests/test_conformance_fixture.py`
asserts is still current. The replay refuses any request the capture does not cover, so the
console has to build the request the router was actually asked; regenerate the capture with
the command in that test's failure message rather than editing it.

## What ships, and what is next

- **`kcs:provider-router-roundtrip`** — a completion served by the zero-spend tier under a
  ceiling of zero budget units, with the resolved tier and cost surfaced in the UI. Live.
- **`kcs:worlds-to-fabric`** — the executable form of
  `../../koine/scenarios/e2e-worlds-to-fabric.md` (KCS §6): an Insimul fiction → Analyzer
  ingest → Pinakes reconcile → cross-project queries, asserting the identity firewall.
  Insimul, Analyzer and Pinakes have published no manifest yet, so all three run as stand-ins
  (delta N) and the report says `stubbed`; the runner prefers a live registration over a
  fixture, so adoption deletes fixtures rather than rewriting the scenario.

Next, per KCS §6: `kcs:media-transform`. See the root README for what it still needs.

### On stand-in fixtures

`src/fixtures/<scenario>/<project>.json` are **fabric-shaped** — KGP delta packs, KMI
envelopes and KINP links exactly as the specs write them — and are read through the same
`facts.ts` extraction as live traffic. A fixture in console-flavoured JSON would make a
green run meaningless.

Each scenario's assertions are paired with the injury they are supposed to catch (see
`worlds-to-fabric.test.ts`): damage one fixture field — drop an asset's `source_world`,
reconcile into `same_as` instead of `based_on`, leak one fiction claim into a
consensus-reality answer — and the run must go red on exactly the assertion that names that
property. A conformance scenario that cannot fail is a demo.
