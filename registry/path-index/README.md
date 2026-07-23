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
gated optimization, not a premature one: on the handful of providers the registry held before that
story it would have been noise. The crossover benchmark below quantifies exactly where the rewrite
starts paying for itself.

## Layout & the story arc

- **US-1** — naive port (linear `take_best`, full edge rescan per pop), the binding boundary, and
  the golden parity harness pinning today's behaviour.
- **US-2** — plane-typed edge index so expansion is a bucket lookup, not a linear scan.
- **US-3** — a `BinaryHeap` frontier and incrementally-carried cost, replacing `take_best`.
- **US-4** — `CapabilityRegistry.path()` routed through the binding; the retired TS
  `findCapabilityPath` kept only as the source-first fallback.
- **US-5** — the crossover benchmark (below) + the native-optional fallback, proven on the golden
  fixtures.

Behaviour is pinned byte-for-byte across every refactor by `registry/src/fixtures/golden-paths.json`
(captured from the retired TS path; regenerate with `node registry/src/fixtures/generate-golden.ts`).

## The crossover benchmark (US-5)

`benches/crossover.rs` (run with `cargo bench`) measures where the US-2 edge index + US-3 heap
frontier overtake the retired **O(n)-per-pop** frontier — `takeBest`'s full-frontier scan plus the
per-pop `edgesOf` rescan of the old `path.ts`. That baseline is reproduced in Rust as
[`search_linear`](src/lib.rs), which a unit test pins to return byte-identical paths to the live
`search`, so the benchmark times two *equivalent* searches and isolates only the data-structure win
(no cross-language noise, no criterion dev-dependency — a plain `std::time` harness).

**Method.** A branching "signal" DAG (a seed, then 12 providers per layer across four knowledge
layers → `goal`) forces best-first to pop the whole depth-≤3 frontier — ≈ 1 + 12 + 12² ≈ 157
partial paths — before the first goal path, the many-pops regime where per-pop cost dominates. That
signal is then buried in a growing pile of *noise* providers on unique, unreachable `noise-in-k`
knowledge shapes: edges that inflate the total the linear frontier rescans on every pop, but which
the index files into their own `(shape, dialect)` buckets and never visits. Both engines return the
identical path at every size (asserted in the harness).

**Finding.** The indexed engine's latency is essentially flat in graph size while the linear
frontier's grows linearly with the edge count — because the linear baseline pays `pops × edges` and
the index pays `pops × (compatible bucket)`:

| providers | linear ns/op | indexed ns/op | speedup |
|----------:|-------------:|--------------:|--------:|
|        37 |      ~2.9M   |      ~2.2M     |  ~1.3× |
|       137 |      ~4.2M   |      ~2.2M     |  ~1.9× |
|       537 |      ~9.3M   |      ~2.4M     |  ~3.9× |
|     1 537 |     ~22.1M   |      ~2.5M     |  ~8.8× |
|     5 037 |     ~64.5M   |      ~4.2M     | ~15.4× |

Numbers are from one run on the build machine (debug-symbol release profile; absolute ns vary by
host — the *scaling* is the point). **Crossover: the index already wins at the smallest measured
graph (~37 providers) and the gap widens ~linearly** — at ~5,000 providers the indexed engine is
~15× faster and pulling away, since the linear curve keeps climbing while the indexed curve stays
near-flat. Below a few dozen providers the two are within noise: the rewrite is worth nothing at
toy scale and everything at service scale, which is exactly why it is gated behind
`70-registry-resolver-services` (a real, high-QPS registry) rather than landed as premature
optimization.

## Build & test

```sh
cargo test                                   # the gate: unit tests + (US-2) golden parity
cargo clippy --all-targets -- -D warnings    # the gate: lint clean
cargo bench                                  # the US-5 crossover benchmark (not in the gate)
npm run build:native -w @agora/registry      # emit agora_path_index.node for the TS shim
```

The `binding` feature (off by default) compiles the napi-rs addon; the default build is pure Rust
so the gate needs no Node link dependency. `cargo test` + `cargo clippy` run inside
`make check-registry`.
