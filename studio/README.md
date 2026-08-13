# `studio` — Agora Studio

The default **topology / observability UI** over a koine-conformant fabric: what is running,
what is connected to what, what crossed those connections, and which contracts each side
advertises. Sibling to `../console`, and the opposite job — the console *proves* conformance by
running authored scenarios, Studio *watches* a fabric that is already running.

Per ADR-0001 decision 7 it is an **observer, not a hub**. It draws what it watched; traffic
between participants never passes through it.

## It ships empty

Studio bundles no apps, no services, no connections and no roster. A fresh install has an empty
stage, and the cast arrives at runtime from the user's own configuration — capability, never
caller, the same rule the whole tree obeys (`../CLAUDE.md`). No participant is named in this
source.

## Layout

| Module | What it is |
|---|---|
| `src/App.tsx` | the shell: header, the stage a view mounts into, the contract footer |
| `src/index.ts` | the package surface (source-first — nothing is emitted) |
| `src/main.tsx` | the browser entry point (`npm run dev -w @agora/studio`) |

## Gate

`make check-studio` — the root eslint config, `tsc -p tsconfig.json` (`--noEmit`), and
`vitest run`. Covered by `make check` through `check-ts`.

## What lands here next

The roadmap's Phase G, in order: the live topology graph, connection monitoring, the animated
on-the-wire message viewer, the analytics dashboards, the spec-definition viewer, and runnable
example setups. Each mounts into the stage this shell provides.
