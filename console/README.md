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
| `src/kcs/spans.ts` | reading emitted exchange telemetry — the control plane, provisionally |
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
| `src/monitor/monitor.ts` | the passive watch: subscribe to what providers publish, never dial |
| `src/monitor/feed.ts` | the observation log projected into filterable fabric events |
| `src/monitor/Monitor.tsx` | the live feed UI |
| `src/App.tsx` | the UI: all three panels, the report, the observation timeline |

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

One screen, three panels over one engine. The **scenario library** (`src/scenarios/library.ts`)
has a run button per scenario; the **capability explorer** composes a single request by hand;
the **fabric monitor** drives nothing at all and watches. Underneath the first two sits the same
**report** — verdict, content address, routing, participants, each assertion with the log entries
that support it, each step — and the same **observation timeline**, every entry stamped with its
time, participant, plane and the KINP ids it touched.

The library carries the scenario *documents*, not descriptions of them, so a scenario that
stopped parsing is a red gate rather than a menu item that fails when somebody clicks it. The
stand-in fixtures a library scenario names are the ones this package ships, so picking one in
the browser runs exactly what the gate runs — and a participant that has adopted the bus is
dialed for real either way, because the runner prefers a live registration over a fixture.

## What ships, and what is next

- **`kcs:provider-router-roundtrip`** — a completion served by the zero-spend tier under a
  ceiling of zero budget units, with the resolved tier and cost surfaced in the UI. Live.
- **`kcs:worlds-to-fabric`** *(sample)* — the executable form of
  `../../koine/scenarios/e2e-worlds-to-fabric.md` (KCS §6): a fiction → an ingest → a
  reconcile → cross-project queries, asserting the identity firewall. The cast is the
  ecosystem agora was extracted from, kept as fixture text so the scenario stays faithful to
  koine's worked example — the runner knows none of them. None has published a manifest, so
  all three run as stand-ins (delta N) and the report says `stubbed`; the runner prefers a
  live registration over a fixture, so adoption deletes fixtures rather than rewriting the
  scenario.
- **`kcs:media-transform`** *(sample, same caveat)* — the other pressure test,
  `../../koine/scenarios/e2e-media-transform.md`: a playthrough → a cut + narration → a
  composed score → a multitrack EDL → a DaVinci projection, over four participants. It asserts the
  control and media planes where `worlds-to-fabric` asserts identity — a cross-plane route
  planned before anything is dialed (delta F/J), a CAS `fetch` by id (delta G), per-asset
  `source_world` with `null` for everything generated (delta H), a spend ceiling on the one
  paid hop (delta K), a dangling reference tolerated (delta L) — and ends on the result the
  pressure test called the key one: analysis of a *generated composite* is attributed to its
  footage's world, traced through the lineage graph. Four stand-ins, all stubbed.

All three are in the library and runnable on demand from the UI.

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

## The live fabric monitor — passive mode

The other two panels *drive* the fabric. This one watches it: a live feed of events crossing the
commons **whether or not this console caused them**, filterable by world, plane, participant and
time, every row linked to the KINP ids it touched.

It works by being a **consumer**, not a tap. KCB §4's `subscribe` is a first-class verb — register
for a world or a capability, receive KGP deltas (KGP §6) and media events as they occur — so the
monitor registers like any other consumer and renders what arrives. It has exactly one verb
(`describeMonitor().verbs`, asserted against the class's own methods), and it is `subscribe`.

The reason it cannot simply be "show me everything" is ADR-0001 decision 7. A passive observer may
not read the wire between two other peers; that is precisely the payload-aware proxy this topology
exists to avoid. So coverage splits:

- **Data plane — complete today, no new contract needed.** Every delta or media event a producer
  publishes to its subscribers reaches the feed, no matter which platform triggered the work.
- **Control plane — only what a provider *emits*.** An `invoke` between two other peers is visible
  only if the serving provider publishes a record of it on its own stream (`kcs/spans.ts` reads
  those as `control`-plane rows). **A provider that emits no telemetry is simply absent at the
  invoke level** — the monitor says so per source rather than showing an empty view that reads
  like "no invocations happened".

That gap is a gap in the *contracts*, and closing it is a koine follow-up: an emitted-telemetry
contract (a KCB observability extension) fixing the span shape a provider publishes. The reader
here is deliberately narrow and provisional — a frame is telemetry only when it says it is, so a
KGP delta is never re-read as an invocation — and it is the one piece of this console that expects
to be rewritten against a spec rather than to define one.

Watch targets are configured, not discovered by accident: registrations that publish a `subscribe`
address, plus the fixtures in `src/fixtures/monitor/` for the peers that have not adopted the bus
(a registration always wins over a fixture of the same identity). Of the two sample monitor
fixtures one emits exchange telemetry and one does not — so the documented limitation is on screen,
not only in this file. A provider that publishes no subscribe address is listed as unwatchable
rather than dialed at a guessed URL.

Sweeping again appends to the same observation log, so the feed accumulates and `since` filters
against real elapsed observation rather than the last button press. No report is produced: nothing
was asked of the fabric, so there is nothing to conform to — only what was seen.

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
