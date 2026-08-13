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
| `src/topology.ts` | the graph's nodes: a KCB discovery answer (`find`, cost-ranked) projected into drawable participants + the address each is dialable at |
| `src/backbone.ts` | the runtime picture — participants, connections, and the normalizer over whatever the caller handed in (defaults to empty) |
| `src/Stage.tsx` | what the stage shows for a backbone: the empty first-run state, else the observed cast |
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

## Gate

`make check-studio` — the root eslint config, `tsc -p tsconfig.json` (`--noEmit`), and
`vitest run`. Covered by `make check` through `check-ts`.

## What lands here next

The roadmap's Phase G, in order: the live topology graph, connection monitoring, the animated
on-the-wire message viewer, the analytics dashboards, the spec-definition viewer, and runnable
example setups. Each mounts into the stage this shell provides.
