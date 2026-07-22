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
| `src/kcs/archive.ts` | the report's content address + the archive envelope (§4.4) |
| `src/commons.ts` | bootstrap: crawl the providers into a registry, then run a scenario |
| `src/scenarios/` | the scenario documents themselves |
| `src/scenarios/library.ts` | the library the UI lists and runs from |
| `src/manual/catalogue.ts` | what the registry advertises, arranged to browse; the port-driven form |
| `src/manual/request.ts` | a hand-composed request, compiled to a one-step scenario |
| `src/manual/Explorer.tsx` | the manual composer UI |
| `src/App.tsx` | the UI: both panels, the report, the observation timeline |

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

## The report is content-addressed

§4.4 asks for a report that is "itself content-addressable and archivable", so every run is
archived under `sha256-…` over its own evidence (`kcs/archive.ts`) — the same hash discipline
KGP §3.2 mandates for a claim, and the same *split*: the address covers what was run, what was
concluded and what was observed, and excludes wall-clock time and durations. Three consequences,
in order of how much they matter:

- **A re-run that observed the same fabric mints the same id**, so an archive dedups and an id
  that moved between two runs of one scenario is itself the finding.
- **An archive can be challenged.** `verifyArchive` re-derives the address from the archived
  report; a report whose verdict was edited afterwards no longer answers to its own name.
- **A run is citable** as one string that fixes the scenario, the participants, every assertion
  and the log slice under it.

That determinism is only as strong as the scenario's own (§7 Q2): the log's `detail` summaries
are inside the address, so a scenario that recorded generated text into one would mint a fresh
id every run. Assertions read plane-typed facts rather than model output for exactly this
reason — a report id that will not settle is a scenario asserting something non-deterministic.

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

## The UI

One screen, two panels over one engine. The **scenario library** (`src/scenarios/library.ts`)
has a run button per scenario; the **capability explorer** composes a single request by hand.
Underneath either sits the same **report** — verdict, content address, routing, participants,
each assertion with the log entries that support it, each step — and the same **observation
timeline**, every entry stamped with its time, participant, plane and the KINP ids it touched.

The library carries the scenario *documents*, not descriptions of them, so a scenario that
stopped parsing is a red gate rather than a menu item that fails when somebody clicks it. The
stand-in fixtures a library scenario names are the ones this package ships, so picking one in
the browser runs exactly what the gate runs — and a participant that has adopted the bus is
dialed for real either way, because the runner prefers a live registration over a fixture.

## What ships, and what is next

- **`kcs:provider-router-roundtrip`** — a completion served by the zero-spend tier under a
  ceiling of zero budget units, with the resolved tier and cost surfaced in the UI. Live.
- **`kcs:worlds-to-fabric`** — the executable form of
  `../../koine/scenarios/e2e-worlds-to-fabric.md` (KCS §6): an Insimul fiction → Analyzer
  ingest → Pinakes reconcile → cross-project queries, asserting the identity firewall.
  Insimul, Analyzer and Pinakes have published no manifest yet, so all three run as stand-ins
  (delta N) and the report says `stubbed`; the runner prefers a live registration over a
  fixture, so adoption deletes fixtures rather than rewriting the scenario.
- **`kcs:media-transform`** — the other pressure test,
  `../../koine/scenarios/e2e-media-transform.md`: a playthrough → a cut + narration → a
  Composer score → a multitrack EDL → a DaVinci projection, over four projects. It asserts the
  control and media planes where `worlds-to-fabric` asserts identity — a cross-plane route
  planned before anything is dialed (delta F/J), a CAS `fetch` by id (delta G), per-asset
  `source_world` with `null` for everything generated (delta H), a spend ceiling on the one
  paid hop (delta K), a dangling reference tolerated (delta L) — and ends on the result the
  pressure test called the key one: analysis of a *generated composite* is attributed to its
  footage's world, traced through the lineage graph. Four stand-ins, all stubbed.

All three are in the library and runnable on demand from the UI.

Next, per the tasklist: the passive live fabric monitor.

## Manual mode — the capability explorer

"Postman for the fabric": browse what the registry advertises — providers, their capabilities,
each capability's plane-typed ports, the address it is dialed at and what it is projected to
cost — pick one, fill in a form, and send. No scenario file.

The whole of its runtime is `manualScenario`, which compiles what was composed into a
**one-step `ScenarioDocument`** and hands it to the same `runConformance` the library uses. So
discovery is the registry's, the connection is `kcs/link.ts`'s direct one, and the exchange
lands in the same observation log under the same report — routing, resolved tier, cost, and the
grant outcome all render in the views a scenario's do. A manual mode with its own client would
be a second implementation of ADR-0001 decision 7, and the one no scenario keeps honest.

Four things fall out of that design, and each is a decision rather than an accident:

- **The form is generated from the port schema** (`fieldsFor`), one field per declared input
  port, labelled with the port's own type vocabulary. Whether a field takes JSON or a KINP id
  comes from the port's plane: entity and media ports reference, because KCS §3 says payloads
  "reference things by KINP id … never inline blobs".
- **Nothing is prefilled.** A skeleton payload is a guess at what the operator meant, and the
  console would then be observing traffic it half-authored.
- **The compiled scenario carries no assertions.** A manual call proves the call went through,
  not that the fabric holds any property — green here means "the peer answered". Asserting more
  than that is what the library is for.
- **Only `invoke` / `fetch` / `resolve` are offered.** `emit` and `subscribe` write to, or hold
  open, somebody else's plane; neither is a thing to do from a form with no scenario recording
  what it meant.

Stand-ins are browsable too, and stamped everywhere their name appears. A peer that has not
adopted the bus has no registration, so without that an operator could not see the shape of a
capability until its provider shipped it — and a registration always beats a fixture of the
same identity, the same preference the runner makes.

### On stand-in fixtures

`src/fixtures/<scenario>/<project>.json` are **fabric-shaped** — KGP delta packs, KMI
envelopes and KINP links exactly as the specs write them — and are read through the same
`facts.ts` extraction as live traffic. A fixture in console-flavoured JSON would make a
green run meaningless.

A fixture may also declare the **`manifest`** its peer has not published (KCB §2). Without
it a stand-in covers only the data planes, and the control plane — path planning, which is
Step 1 of `kcs:media-transform` — would be unassertable for every peer off the bus. The
runner indexes those manifests into an index built for the run and discarded with it, never
into the registry other peers query: it may describe a route, and nobody may dial it.

Each scenario's assertions are paired with the injury they are supposed to catch (see
`worlds-to-fabric.test.ts` and `media-transform.test.ts`): damage one fixture field — drop
an asset's `source_world`, type a transform's port back to media-only, report spend past a
ceiling, reconcile into `same_as` instead of `based_on`, leak one fiction claim into a
consensus-reality answer — and the run must go red on exactly the assertion that names that
property. A conformance scenario that cannot fail is a demo.
