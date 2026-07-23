# agora-path-index

The Rust engine behind `@agora/registry`'s `CapabilityRegistry.path()` — indexed capability-path
search for KCB §3 "Composition". A faithful port of `registry/src/path.ts` + `ports.ts` + `cost.ts`:
given the registry's registrations and a `PathQuery`, [`search`](src/lib.rs) returns the best
`CapabilityPath` from a start port to a goal port, or `None`.

It is loaded **in-process** by the TypeScript registry through an N-API addon
(`registry/src/path-index.ts`), never as a service — nothing crosses a network hop, and the engine
returns a *plan* of addresses + capability names, never a payload or a transport (ADR-0001
decision 3, route-by-lookup / no-proxy).

## Why Rust, why here

The engine lands only because `70-registry-resolver-services` makes the registry a real, high-QPS
service — the load realism that justifies replacing the O(n)-per-pop TypeScript frontier. This is a
gated optimization, not a premature one. (The crossover benchmark that quantifies the win lands in
US-5.)

## Layout & the story arc

- **US-1 (this)** — naive port (linear `take_best`, full edge rescan per pop), the binding
  boundary, and the golden parity harness pinning today's behaviour.
- **US-2** — plane-typed edge index so expansion is a bucket lookup, not a linear scan.
- **US-3** — a `BinaryHeap` frontier and incrementally-carried cost, replacing `take_best`.

Behaviour is pinned byte-for-byte across every refactor by `registry/src/fixtures/golden-paths.json`
(captured from the retired TS path; regenerate with `node registry/src/fixtures/generate-golden.ts`).

## Build & test

```sh
cargo test                                   # the gate: unit tests + (US-2) golden parity
cargo clippy --all-targets -- -D warnings    # the gate: lint clean
npm run build:native -w @agora/registry      # emit agora_path_index.node for the TS shim
```

The `binding` feature (off by default) compiles the napi-rs addon; the default build is pure Rust
so the gate needs no Node link dependency. `cargo test` + `cargo clippy` run inside
`make check-registry`.
