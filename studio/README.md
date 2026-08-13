# `studio` — Agora Studio

The default **topology / observability UI** over a koine-conformant fabric: what is running,
what is connected to what, what crossed those connections, and which contracts each side
advertises. Sibling to `../console`, and the opposite job — the console *proves* conformance by
running authored scenarios, Studio *watches* a fabric that is already running.

Per ADR-0001 decision 7 it is an **observer, not a hub**. It draws what it watched; traffic
between participants never passes through it.

## It ships empty

Studio bundles no apps, no services, no connections and no roster. A fresh install has an empty
stage — an explicit "0 participants · 0 connections", not a spinner — and the cast arrives at
runtime from the user's own configuration: capability, never caller, the same rule the whole tree
obeys (`../CLAUDE.md`). No participant is named in this source, and `backbone.test.ts` fails on
any authored file here that grows a KINP identity literal, an export carrying participant data, or
a verb that could move a payload between two participants.

## The cast comes from your config

Studio reads one self-describing document — the format tag names and versions itself, so an
unrecognized one is refused rather than guessed at — and draws exactly the fabric it describes:

```json
{
  "format": "agora.studio.config/v1",
  "participants": [
    { "identity": "<kinp identity>", "label": "<what to show>", "capabilities": ["<name>"] }
  ],
  "connections": [{ "from": "<identity>", "to": "<identity>", "transport": "a2a" }]
}
```

That file **lives with you**, in the project whose fabric it describes; nothing like it ships
here, and Studio never goes and fetches one. The host hands the contents in — the browser entry
reads a `<script type="application/json" id="studio-config">` block the serving page carries, and
library callers pass the text (or the parsed object) to `readStudioConfig` themselves. Whatever
could not be read comes back as `problems` and is shown on the stage; a config that describes
nobody, or no config at all, is the empty state above.

## Layout

| Module | What it is |
|---|---|
| `src/App.tsx` | the shell: header, the stage a view mounts into, the contract footer |
| `src/config.ts` | ingestion: a user's config in, a backbone (plus what could not be read) out |
| `src/topology.ts` | the graph: a KCB discovery answer (`find`, cost-ranked) and the registry's planned routes projected into drawable nodes + typed edges, with node identity settled by the KINP resolver |
| `src/backbone.ts` | the runtime picture — participants, connections, and the normalizer over whatever the caller handed in (defaults to empty) |
| `src/Stage.tsx` | what the stage shows: the empty first-run state, else the graph (discovery's answer when there is one, else the configured cast projected into the same shape) with the connection health panel beneath it |
| `src/TopologyGraph.tsx` | the graph itself, drawn: nodes with what discovery knows about them, edges with their transport, scope, capability and plane |
| `src/connection.ts` | per-connection health: where a *peer* dials each link, the probe seam, and the status one observation implies (`up` / `degraded` / `down` / `unknown`) |
| `src/history.ts` | the connection log — the pure fold that turns a sequence of passes into uptime and a bounded list of recent failures |
| `src/useConnections.ts` | `useConnections` — one monitoring pass per graph, folded into that log; the health half of the churn seam |
| `src/Connections.tsx` | the health panel: one row per connection, with its status, its uptime and what the far end said when it broke |
| `src/useTopology.ts` | `useTopology` — one pass over the lookup surfaces per snapshot, re-run when the host's query moves or it calls `refresh()`; this is the churn seam |
| `src/index.ts` | the package surface (source-first — nothing is emitted) |
| `src/main.tsx` | the browser entry point (`npm run dev -w @agora/studio`) — reads the page's embedded config, if it has one |

## The graph is discovered, not configured

The config above is what a user *asserts*; the topology graph is what is actually **there**. Its
nodes come from the KCB discovery registry — `find` answers with addresses, ranked cheapest-first
(KCB §3) — and `nodesOf` / `discoverNodes` project that answer into nodes, one per discovered
address, in the order discovery ranked them. Studio never fetches a registry: the host hands the
find surface in (an in-process `CapabilityRegistry`, or a client onto a remote one), the same way
it hands in config text. A registry that knows nobody yields no nodes, and a participant that has
left the index is simply absent from the next answer — there is no remembered cast to go stale.

## The edges are connections, and every distinction is somebody else's answer

An edge is one MCP/A2A connection between two participants, and it is typed by which side of
the discovery index it ends on: **internal** when the registry answered with both ends,
**external** when one end is not in the index — an outside peer somebody here talks to. That is
read off discovery on every pass, not assigned: a peer that joins the index turns its edges
internal on the next answer with nothing here edited, and one that leaves goes the other way.
Edges also come from the registry's **capability-path search** (`path`, KCB §3 composition) —
one edge per handoff, carrying the plane the two ends agreed on and marking the hop where the
route crosses planes. Studio draws that plan; it dials none of it.

Node identity is the **KINP resolver's** ruling, not Studio's: each discovered identity goes to
`resolve`, and a `same_as` closure collapses two addresses of one entity into one node — both
addresses kept, reachable if either is, and every edge re-pointed at whoever the node turned out
to be. Lineage (`based_on`) is never joined; merging a thing with what it was modeled on is the
contamination identity.md §4.3 exists to prevent. With no resolver, or with one that cannot
answer, nothing merges and nothing is lost — degraded, never broken.

`discoverTopology` is the whole graph in one call (find → resolve → plan → draw). Nothing is
remembered between calls, which is what makes churn cheap: run it again and the answer is
whatever is true now.

## Health is observed on the real link, and uptime is counted

Which connections exist is discovery's answer; whether they *work* is only knowable by dialing.
So `monitorConnections` observes each edge the way a peer on it would — a direct dial of the far
end's own published address, replaying that transport's **opening leg** by reference to the
console's wires (A2A: a GET of the peer's Agent Card, `console/src/kcs/a2a-wire.ts`; MCP: a
JSON-RPC `initialize` at the SDK's pinned protocol version, `mcp-wire.ts`). Nothing is relayed:
a probe's request goes to one address and its answer comes back to the prober, which is a second
direct connection *beside* the one being reported on, never a tap on it (ADR-0001 decisions 3 and
7). The `fetch` is an argument, like every other seam here — Studio opens no transport of its own.

The line is drawn at **answered versus not**: a link that carried a round trip works however
unhappy the answer, so a refusal or a 5xx (or a JSON-RPC `error` at HTTP 200, which is how MCP
refuses) is `degraded` and only silence is `down`. A connection nobody probed is `unknown` — a
reading, never a default. A monitor that reported silence as health would be worse than no
monitor at all.

`trackConnections` folds the passes into the two things a moment cannot carry: **uptime**, timed
from the first reading that saw the current status and reset the instant it changes, and the
**most recent failures**, in the far end's own words, newest first, with a repeat collapsing into
one row and a count. `<Connections connections={…} />` draws that as text — status, uptime (or
how long it has been failing), latency, and the errors — with no retry button and no verb of any
kind, because Studio watches these links and is not on them. A link that leaves the graph takes
its history with it; there is no stale row to reap.

```tsx
// The host owns the dial, and the probe only ever dials the far end's published address.
<App discovery={{ discovery: registry }} monitor={{ probe: httpProbe(fetch) }} />
```

Without a `monitor`, every connection on the panel reports as unwatched rather than green.

## Drawing it, and keeping it true

`<TopologyGraph topology={…} />` renders a topology and nothing else — a value in, elements out,
with no lookup of its own. Everything on it is text: an advertised capability name is a label and
an address is where a *peer* would dial, so there is no button, no link and no handler anywhere on
the picture (ADR-0001 decisions 3 and 7). Each node says whether it was `discovered` or merely
`observed`, marks a provider that is indexed but published no endpoint `unreachable`, and lists
the identities the resolver folded into it, so a merge reads as a merge rather than a
disappearance. Each edge carries its transport, its internal/external scope, and — when it came
out of the path search — the capability the far end serves, the plane they hand off on, and
whether that hop crosses planes.

`useTopology(query)` is what keeps it live. It holds no cast between passes: it runs
`discoverTopology`, renders the answer, and runs another when the host hands in a new query
object (its own next snapshot) or calls `refresh()` (the same index, moved underneath it). A
participant that left the index is absent from the next answer and therefore off the next render
— removal is not a code path anybody has to remember to run. A pass that *fails* is the one thing
that does not empty the graph: the last good picture stays up with the problem reported beside it,
because a registry Studio could not read is not a fabric that emptied.

```tsx
// The host owns both lookups; Studio opens no transport of its own.
<App backbone={configured} discovery={{ discovery: registry, resolver, routes }} />
```

Handing `<App>` no `discovery` leaves it exactly as it was — the configured cast, or the empty
stage. That is what the standalone bundle does: it has no registry to ask.

## Gate

`make check-studio` — the root eslint config, `tsc -p tsconfig.json` (`--noEmit`), and
`vitest run`. Covered by `make check` through `check-ts`.

## What lands here next

The roadmap's Phase G, in order: the animated
on-the-wire message viewer, the analytics dashboards, the spec-definition viewer, and runnable
example setups. Each mounts into the stage this shell provides.
